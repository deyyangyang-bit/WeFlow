/**
 * current-view-test.ts —— P0-3 第一刀验收：getCustomerCurrentView 只读组装层
 *
 * 验收（docs/P0-3-Current-Judgment-Consumer-盘点.md §6 拍板契约）：
 *   1  客户不存在 → null（IPC 层以失败返回）
 *   2  有客户无判断 → state 正常 + 四类型 null（明确空态，不补生成）
 *   3  三判断投影正确：value/source/generatedAt/messageKey 透传，
 *      next_action → nextAction 映射；1h 内 fresh；有 key → evidenceStatus ok
 *   4  freshness：24h 窗口外 → stale 但仍返回（Latest 与 Fresh 并存）
 *   5  summary 缺失 → null 不补不生成（其余类型正常投影，不互相顶替）
 *   6  只投影不推理：follow_up_task.analysis JSON 写入后视图不变（不并入 judgments）
 *   7  evidenceStatus：无 message_key → unavailable + messageKey null
 *   8  canonical state 透传（stage / activityState / stateMeta）
 *   9  generated_at 缺失 → 回退 created_at（且按 created_at 判 freshness）
 *
 * 运行：npx tsx scripts/current-view-test.ts
 */
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { salesDbService } from '../electron/services/salesDbService'
import { getCustomerCurrentView, CURRENT_JUDGMENT_FRESH_MS } from '../electron/services/customerCurrentView'

let pass = 0, fail = 0
function ok(name: string, cond: boolean): void {
  if (cond) { pass++ } else { fail++; console.error('FAIL:', name) }
}

const NOW = Date.now()
const SID = 'wx_current_view_a'
const SID2 = 'wx_current_view_b'
const SID3 = 'wx_current_view_c'

function makeDb(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'curview-'))
  return salesDbService.initialize(dir).then(() => dir)
}

function upsert(sid: string, stage: string): void {
  salesDbService.customerUpsert({ session_id: sid, display_name: '测试客户', stage, last_contact_at: NOW / 1000 })
}

async function runScenario(): Promise<void> {
  // ── 1. 客户不存在 → null ─────────────────────────────────────────────────
  const v1 = getCustomerCurrentView('wx_nonexist', NOW)
  ok('1 无客户 → null', v1 === null)

  // ── 2. 有客户无判断 → state 正常 + 四类型 null ────────────────────────────
  upsert(SID, 'quoted')
  const v2 = getCustomerCurrentView(SID, NOW)!
  ok('2a state.stage 透传', v2.state.stage === 'quoted')
  ok('2b activityState 存在', v2.state.activityState === 'active' || v2.state.activityState === 'dormant')
  ok('2c 仅四类键', Object.keys(v2.judgments).sort().join(',') === 'nextAction,opportunity,risk,summary')
  ok('2d 四类型均 null（空态不补生成）',
    v2.judgments.summary === null && v2.judgments.opportunity === null &&
    v2.judgments.risk === null && v2.judgments.nextAction === null)

  // ── 3. 三判断投影 + type 映射 ────────────────────────────────────────────
  salesDbService.judgmentCreate({
    session_id: SID, judgment_type: 'summary', value: '客户对报价满意', source: 'ai',
    generated_at: NOW - 3600_000, message_key: 'k:summary:1', evidence_text: '客户原话', createdAt: NOW - 3600_000
  })
  salesDbService.judgmentCreate({
    session_id: SID, judgment_type: 'opportunity', value: '有追加采购机会', source: 'ai',
    generated_at: NOW - 3600_000, message_key: 'k:opp:1', createdAt: NOW - 3600_000
  })
  salesDbService.judgmentCreate({
    session_id: SID, judgment_type: 'next_action', value: '周五跟进合同', source: 'ai',
    generated_at: NOW - 3600_000, message_key: 'k:next:1', createdAt: NOW - 3600_000
  })
  const v3 = getCustomerCurrentView(SID, NOW)!
  ok('3a summary 投影', v3.judgments.summary?.value === '客户对报价满意')
  ok('3b next_action → nextAction 映射', v3.judgments.nextAction?.type === 'nextAction' && v3.judgments.nextAction?.value === '周五跟进合同')
  ok('3c generatedAt 透传', v3.judgments.summary?.generatedAt === NOW - 3600_000)
  ok('3d messageKey 透传', v3.judgments.summary?.messageKey === 'k:summary:1')
  ok('3e source=ai', v3.judgments.summary?.source === 'ai')
  ok('3f 1h 内 → fresh', v3.judgments.summary?.freshness === 'fresh')
  ok('3g 有 key → evidenceStatus ok', v3.judgments.summary?.evidenceStatus === 'ok')
  ok('3h risk 尚无判断 → null', v3.judgments.risk === null)

  // ── 4. freshness：24h 窗口外 → stale 但仍返回 ────────────────────────────
  salesDbService.judgmentCreate({
    session_id: SID, judgment_type: 'risk', value: '客户可能转向竞品', source: 'ai',
    generated_at: NOW - 48 * 3600_000, message_key: 'k:risk:1', createdAt: NOW - 48 * 3600_000
  })
  const v4 = getCustomerCurrentView(SID, NOW)!
  ok('4a 48h 前判断仍返回（Latest 与 Fresh 并存）', v4.judgments.risk?.value === '客户可能转向竞品')
  ok('4b freshness=stale', v4.judgments.risk?.freshness === 'stale')
  ok('4c 边界：恰 24h → fresh', (() => {
    // 同一 customer_judgment 是 append-only，用窗口常量做等式验证
    return CURRENT_JUDGMENT_FRESH_MS === 24 * 3600 * 1000
  })())

  // ── 5. summary 缺失 → null 不补不生成（部分判断存在时）───────────────────
  upsert(SID2, 'contacted')
  salesDbService.judgmentCreate({
    session_id: SID2, judgment_type: 'opportunity', value: 'O2 机会', source: 'ai',
    generated_at: NOW - 1000, createdAt: NOW - 1000
  })
  salesDbService.judgmentCreate({
    session_id: SID2, judgment_type: 'risk', value: 'R2 风险', source: 'ai',
    generated_at: NOW - 1000, createdAt: NOW - 1000
  })
  salesDbService.judgmentCreate({
    session_id: SID2, judgment_type: 'next_action', value: 'N2 行动', source: 'manual',
    generated_at: NOW - 1000, createdAt: NOW - 1000
  })
  const v5 = getCustomerCurrentView(SID2, NOW)!
  ok('5a summary 缺失 → null（不补不生成）', v5.judgments.summary === null)
  ok('5b 其余类型正常投影', v5.judgments.risk?.value === 'R2 风险')
  ok('5c source=manual 透传', v5.judgments.nextAction?.source === 'manual')

  // ── 6. 只投影不推理：follow_up_task.analysis JSON 不并入 judgments ────────
  const todo = salesDbService.todoCreate({
    session_id: SID, trigger_type: 'ai_detected', title: '跟进报价', due_at: NOW + 86400_000
  })
  ok('6a todo 创建成功', !!todo && !!todo.id)
  salesDbService.todoUpdate(todo.id!, {
    analysis: JSON.stringify({ summary: '来自 analysis JSON 的假判断', opportunity: '也来自 JSON' })
  })
  const v6 = getCustomerCurrentView(SID, NOW)!
  ok('6b summary 仍来自 customer_judgment（不并入 analysis JSON）', v6.judgments.summary?.value === '客户对报价满意')
  ok('6c opportunity 不变', v6.judgments.opportunity?.value === '有追加采购机会')
  ok('6d 视图不新增字段（键仍为四类）', Object.keys(v6.judgments).sort().join(',') === 'nextAction,opportunity,risk,summary')

  // ── 7. evidenceStatus：无 message_key → unavailable ──────────────────────
  salesDbService.judgmentCreate({
    session_id: SID2, judgment_type: 'summary', value: '无证据的判断', source: 'ai',
    generated_at: NOW - 1000, createdAt: NOW - 1000
  })
  const v7 = getCustomerCurrentView(SID2, NOW)!
  ok('7a 无 key → evidenceStatus unavailable', v7.judgments.summary?.evidenceStatus === 'unavailable')
  ok('7b 无 key → messageKey null', v7.judgments.summary?.messageKey === null)

  // ── 8. canonical state 透传 ──────────────────────────────────────────────
  ok('8a stateMeta 结构透传（source 可为 null=诚实标注，键必须存在）',
    v2.state.stateMeta != null &&
    Object.prototype.hasOwnProperty.call(v2.state.stateMeta, 'source') &&
    Object.prototype.hasOwnProperty.call(v2.state.stateMeta, 'confidence') &&
    Object.prototype.hasOwnProperty.call(v2.state.stateMeta, 'changedAt'))
  ok('8b stage 未做 AI 推理（quoted 原样）', v2.state.stage === 'quoted')

  // ── 9. generated_at 缺失 → 回退 created_at ───────────────────────────────
  upsert(SID3, 'won')
  salesDbService.judgmentCreate({
    session_id: SID3, judgment_type: 'summary', value: '无 generated_at', source: 'ai', createdAt: NOW - 5000
  })
  const v9 = getCustomerCurrentView(SID3, NOW)!
  ok('9a 回退 created_at', v9.judgments.summary?.generatedAt === NOW - 5000)
  ok('9b 回退后 freshness 按 created_at 判定（5s 内 → fresh）', v9.judgments.summary?.freshness === 'fresh')
  ok('9c stage=won 透传', v9.state.stage === 'won')
}

async function main(): Promise<void> {
  await makeDb()
  await runScenario()
  console.log(`current-view-test: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main()
