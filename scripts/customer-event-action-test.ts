/**
 * customer-event-action-test.ts —— P0-3 E3.3 验收：销售行动事件（script_copied / chat_opened / follow_up_done）
 *
 * 验收（Scope Lock 2026-08-23 + E3.3 锁定）：
 *   "E3.2 是客户发生了什么；E3.3 是销售做了什么"——行动事件挂在现有 UI/action handler 成功点，
 *   行动成功与事件写入解耦（写失败 WARN+continue）；follow_up_done 只在真实状态转换
 *   （pending→done）后产生，重复完成不产生新事件（与 last_stage_change_at 同一幂等思想）。
 *   A 静态护栏：
 *     1  recordUserActionEvent 导出 + 白名单（仅行动三事件，防万能日志表）
 *     2  completeAction 内 before 状态检查 + follow_up_done 写入（状态转换成功后）
 *     3  main.ts 有 sales:action:recordEvent IPC 通道（薄调 → recordUserActionEvent）
 *     4  preload 暴露 actionRecordEvent
 *     5  AIActionCard：打开聊天成功 → chat_opened；复制成功 → script_copied（行动成功点后上报）
 *     6  follow_up_done 不经 IPC 通道（前端无 follow_up_done 提交，防双写/不可控）
 *     7  不新增第二套 action log（salesActionEngine 无新表 INSERT）
 *     8  行动事件 source='manual'（与 E3.2 的 system 区分）
 *   B 行为（temp DB，真实生产函数）：
 *     9  pending → completeAction(done) → 恰好一条 follow_up_done（source=manual，session 正确）
 *     10 重复完成（done 后再点 done）→ 不新增 follow_up_done（幂等）
 *     11 skipped → 不写 follow_up_done
 *     12 script_copied 上报 → 写入成功；无可靠 messageKey 不伪造（null）
 *     13 白名单外类型 → 拒绝写入（不抛错，仅 WARN）
 *     14 空 sessionId → 直接返回不写入（容错）
 *   P0-4.2.1 correlation（task_id）：
 *     A2' follow_up_done 携带 before.id（completeAction → recordUserActionEvent 四参）
 *     A3' IPC 通道透传 taskId（typeof number 才传，其余 → null）
 *     A4' preload actionRecordEvent 签名含 taskId
 *     A5' AIActionCard 从 sources[].rawTaskId 提取 taskId（无 task 卡 undefined → NULL）
 *     B9' follow_up_done 事件 task_id = task.id
 *     B15 无 taskId 的上报 → task_id NULL（不伪造）
 *
 * 运行：npx tsx scripts/customer-event-action-test.ts
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { salesDbService } from '../electron/services/salesDbService'
import { completeAction, recordUserActionEvent } from '../electron/services/salesActionEngine'

let pass = 0, fail = 0
function ok(name: string, cond: boolean): void {
  if (cond) { pass++ } else { fail++; console.error('FAIL:', name) }
}

const ROOT = join(__dirname, '..')
const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

async function main(): Promise<void> {
  // ── A. 静态护栏 ────────────────────────────────────────────────────────────
  const engineSrc = readFileSync(join(ROOT, 'electron/services/salesActionEngine.ts'), 'utf8')
  const engineCode = strip(engineSrc)
  const mainSrc = readFileSync(join(ROOT, 'electron/main.ts'), 'utf8')
  const mainCode = strip(mainSrc)
  const preloadSrc = readFileSync(join(ROOT, 'electron/preload.ts'), 'utf8')
  const cardSrc = readFileSync(join(ROOT, 'src/components/sales/AIActionCard.tsx'), 'utf8')
  const cardCode = strip(cardSrc)

  ok('A1 recordUserActionEvent 导出 + 白名单（仅行动三事件，防万能日志表）',
    /export function recordUserActionEvent/.test(engineCode) &&
    /eventType: 'script_copied' \| 'chat_opened' \| 'follow_up_done'/.test(engineCode) &&
    /\['script_copied', 'chat_opened', 'follow_up_done'\]\.includes\(eventType\)/.test(engineCode))
  ok('A2 completeAction 内 before 状态检查 + follow_up_done 写入（状态转换成功后）',
    /const before = salesDbService\.getTask\(taskId\)/.test(engineCode) &&
    /before\.status !== 'done' && before\.status !== 'skipped'/.test(engineCode))
  // A2': P0-4.2.1 follow_up_done 携带 before.id（correlation：哪条建议 → 哪次完成）
  ok("A2' follow_up_done 携带 before.id（recordUserActionEvent 四参）",
    /recordUserActionEvent\(before\.session_id, 'follow_up_done', null, before\.id\)/.test(engineCode))
  ok('A3 main.ts 有 sales:action:recordEvent IPC 通道（薄调 → recordUserActionEvent）',
    /ipcMain\.handle\('sales:action:recordEvent'/.test(mainCode) &&
    /recordUserActionEvent\(String\(p\.sessionId \|\| ''\), p\.eventType as any, p\.messageKey \|\| null, typeof p\.taskId === 'number' \? p\.taskId : null\)/.test(mainCode))
  ok("A3' IPC 通道透传 taskId（typeof number 才传，其余 → null）",
    /taskId\?: number \| null \}/.test(mainCode))
  ok("A4 preload 暴露 actionRecordEvent（签名含 taskId）",
    /actionRecordEvent: \(p: \{ sessionId: string; eventType: string; messageKey\?: string \| null; taskId\?: number \| null \}\)/.test(preloadSrc))
  ok("A5 AIActionCard：打开聊天成功 → chat_opened；复制成功 → script_copied",
    /navigate\(`\/chat\?sessionId=/.test(cardCode) && /eventType: 'chat_opened'/.test(cardCode) &&
    /eventType: 'script_copied'/.test(cardCode) && /setCopied\(true\)/.test(cardCode))
  ok("A5' AIActionCard 从 sources[].rawTaskId 提取 taskId 并随事件上报（无 task 卡 undefined → NULL）",
    /const taskId = item\.sources\.find\(s => s\.type === 'task'\)\?\.rawTaskId \?\? undefined/.test(cardCode) &&
    /\{ sessionId: item\.sessionId, eventType: 'chat_opened', taskId \}/.test(cardCode) &&
    /\{ sessionId: item\.sessionId, eventType: 'script_copied', taskId \}/.test(cardCode))
  ok('A6 follow_up_done 不经 IPC 通道（前端无 follow_up_done 提交，防双写）', !/follow_up_done/.test(cardCode))
  ok('A7 不新增第二套 action log（salesActionEngine 无新表 INSERT）',
    !/INSERT INTO (activity_log|lead_activity|action_log|user_action)/.test(engineCode))
  ok('A8 行动事件 source=manual（与 E3.2 的 system 区分）', /source: 'manual'/.test(engineCode))

  // ── B. 行为（temp DB）─────────────────────────────────────────────────────
  const dir = mkdtempSync(join(tmpdir(), 'cea-'))
  await salesDbService.initialize(dir)
  const NOW = Date.now()

  // B9: pending → done → 恰好一条 follow_up_done
  const task = salesDbService.todoCreate({
    session_id: 'wx_cea_1', trigger_type: 'manual', title: '跟进报价', status: 'pending',
    due_at: NOW + 86400_000
  })
  ok('B9 前置：任务创建为 pending', !!task?.id && task.status === 'pending')
  completeAction(task.id!, 'done')
  let doneEvents = salesDbService.customerEventsByType('follow_up_done')
  ok('B9 pending→done 产生恰好一条 follow_up_done（source=manual，session 正确）',
    doneEvents.length === 1 && doneEvents[0].source === 'manual' &&
    doneEvents[0].session_id === 'wx_cea_1' && doneEvents[0].message_key === null)
  // B9': P0-4.2.1 follow_up_done 事件 task_id = task.id（completeAction 直写 before.id）
  ok("B9' follow_up_done 事件 task_id = task.id（correlation 直写）",
    doneEvents[0].task_id === task.id)

  // B10: 重复完成 → 不新增
  completeAction(task.id!, 'done')
  doneEvents = salesDbService.customerEventsByType('follow_up_done')
  ok('B10 重复完成（done 后再点 done）→ 不新增 follow_up_done（幂等）', doneEvents.length === 1)

  // B11: skipped → 不写 follow_up_done
  const task2 = salesDbService.todoCreate({
    session_id: 'wx_cea_2', trigger_type: 'manual', title: '跟进演示', status: 'pending',
    due_at: NOW + 86400_000
  })
  completeAction(task2.id!, 'skipped')
  ok('B11 skipped → 不写 follow_up_done（事件总数仍 1）',
    salesDbService.customerEventsByType('follow_up_done').length === 1)

  // B12: script_copied 上报 → 写入成功；无可靠 messageKey 不伪造（null）
  // P0-4.2.1: 带 taskId 上报 → task_id 落库（前端 rawTaskId 通道等价验证）
  recordUserActionEvent('wx_cea_3', 'script_copied', null, 42)
  let copiedEvents = salesDbService.customerEventsByType('script_copied')
  ok('B12 script_copied 写入成功（source=manual，无 messageKey 不伪造→null）',
    copiedEvents.length === 1 && copiedEvents[0].source === 'manual' &&
    copiedEvents[0].session_id === 'wx_cea_3' && copiedEvents[0].message_key === null &&
    copiedEvents[0].task_id === 42)

  // B15: 无 taskId 上报（如 insight 卡）→ task_id NULL，不伪造
  recordUserActionEvent('wx_cea_5', 'chat_opened', null)
  const openEvents = salesDbService.customerEventsByType('chat_opened')
  ok('B15 无 taskId 上报 → task_id NULL（insight 卡等无任务上下文，不伪造）',
    openEvents.length === 1 && openEvents[0].task_id === null)

  // B13: 白名单外类型 → 拒绝写入（不抛错，仅 WARN）
  let threw = false
  try {
    recordUserActionEvent('wx_cea_4', 'action_copied' as any, null)
  } catch { threw = true }
  ok('B13 白名单外类型拒绝写入（不抛错，事件不产生）',
    threw === false && salesDbService.customerEventsByType('action_copied' as any).length === 0)

  // B14: 空 sessionId → 直接返回不写入（容错；相对计数——B15 已写入一条 chat_opened）
  const openBefore = salesDbService.customerEventsByType('chat_opened').length
  recordUserActionEvent('', 'chat_opened', null)
  ok('B14 空 sessionId 直接返回不写入（容错）',
    salesDbService.customerEventsByType('chat_opened').length === openBefore)

  console.log(`customer-event-action-test: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main()
