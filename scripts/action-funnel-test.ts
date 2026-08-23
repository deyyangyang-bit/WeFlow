/**
 * action-funnel-test.ts —— P0-4.2.2 验收：getActionFunnel 只读组装层（Task-level Action Funnel）
 *
 * 验收（用户 2026-08-24 P0-4.2 拍板）：
 *   - 只读组装：不调 LLM、不从 customer_judgment 推导；只消费 follow_up_task / customer_event / customer_profile
 *   - 每段唯一事实来源可解释（sources 逐段声明；G1 曝光段 = unmeasured/N-A）
 *   - 任何分母为 0 → rate = null（不是 0%）
 *   - Task-level 去重：executed/responded 是 task 布尔（0/1），不是事件条数
 *   - superseded 不重复计（盘点口径）；事件须在 task 产生后（时序守卫）
 *   - days 窗口只过滤 created
 *   A 静态护栏：
 *     1  getActionFunnel 导出；文件零 customer_judgment / intent_tag_log / LLM 引用（纯只读）
 *     2  sources 六段声明逐段正确（created=follow_up_task / exposed=unmeasured / executed+responded=customer_event / progressed+won=customer_profile.stage）
 *     3  rate=null 逻辑存在（分母 > 0 才除）
 *     4  salesDbService.tasksCreatedSince 原语存在
 *   B 行为（temp DB，真实生产函数；salesDbService 单例不可重开 → 同一 DB 顺序累加）：
 *     5  空库 → 全 0 + 全部 rates null + exposed null + sources 正确
 *     15 组合场景（干净基线绝对断言）：六段数字 + 段间转化率 + sources 随视图 + 窗口默认全量
 *     6  executed task-level 去重：同 task 2 执行事件 → Δexecuted=1（非事件计数）
 *     7  无 task_id 的执行事件不归入任何 task（不伪造关联）
 *     8  superseded 不重复计：新 superseded → Δcreated=0 + Δsuperseded=1
 *     9  时序守卫：task 产生前的执行/响应事件不算（Δ=0）
 *     10 responded 去重：同 session 2 响应事件 → Δresponded=1
 *     11 progressed：stage 变更在 task 后计 / task 后无变更不计（Δprogressed=1）
 *     12 won：profile.stage=成交 normalizeStage → Δwon=1
 *     13 响应率公式（responded/executed，分母 > 0 → 非 null）
 *     14 days 窗口只过滤 created（now 前移 → created=0）；默认 now 全在窗口内
 *
 * 运行：npx tsx scripts/action-funnel-test.ts
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { salesDbService } from '../electron/services/salesDbService'
import { getActionFunnel, ACTION_FUNNEL_SOURCES } from '../electron/services/actionFunnel'
// last_stage_change_at 唯一合法写路径 = legalStageWriters（generic upsert 已移除 stage 资格，P0-2A.5）
import { applyManualStageCorrection } from '../electron/services/legalStageWriters'

let pass = 0, fail = 0
function ok(name: string, cond: boolean): void {
  if (cond) { pass++ } else { fail++; console.error('FAIL:', name) }
}
const near = (a: number | null, b: number): boolean => a !== null && Math.abs(a - b) < 1e-9

const ROOT = join(__dirname, '..')
const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

async function main(): Promise<void> {
  // ── A. 静态护栏 ────────────────────────────────────────────────────────────
  const funnelSrc = readFileSync(join(ROOT, 'electron/services/actionFunnel.ts'), 'utf8')
  const funnelCode = strip(funnelSrc)

  ok('A1 getActionFunnel 导出；纯只读（零 customer_judgment / intent_tag_log / LLM 引用）',
    /export function getActionFunnel/.test(funnelCode) &&
    !/customer_judgment|intent_tag_log|generateActionAnalysis|LLM|judgmentCurrent/.test(funnelCode))
  ok('A2 sources 六段逐段声明正确（created=follow_up_task / exposed=unmeasured / executed+responded=customer_event / progressed+won=customer_profile.stage）',
    ACTION_FUNNEL_SOURCES.created === 'follow_up_task' && ACTION_FUNNEL_SOURCES.exposed === 'unmeasured' &&
    ACTION_FUNNEL_SOURCES.executed === 'customer_event' && ACTION_FUNNEL_SOURCES.responded === 'customer_event' &&
    ACTION_FUNNEL_SOURCES.progressed === 'customer_profile.stage' && ACTION_FUNNEL_SOURCES.won === 'customer_profile.stage')
  ok('A3 rate=null 逻辑存在（分母 > 0 才除，不返回 0%）', /denominator > 0 \?/.test(funnelCode))
  const dbSrc = readFileSync(join(ROOT, 'electron/services/salesDbService.ts'), 'utf8')
  ok('A4 salesDbService.tasksCreatedSince 原语存在', /tasksCreatedSince\(ms: number \| null\)/.test(dbSrc))

  // ── B. 行为（temp DB）─────────────────────────────────────────────────────
  const dir = mkdtempSync(join(tmpdir(), 'afn-'))
  await salesDbService.initialize(dir)
  const NOW = Date.now()
  let f = getActionFunnel()

  // B5: 空库 → 全 0 + rates null（分母 0 → null 的基态）
  ok('B5 空库 → created=0、全段 0、rates 全 null、exposed null',
    f.stages.created === 0 && f.stages.executed === 0 && f.stages.responded === 0 &&
    f.stages.progressed === 0 && f.stages.won === 0 && f.stages.exposed === null &&
    f.rates.execution === null && f.rates.response === null && f.rates.progression === null &&
    f.rates.conversion === null && f.rates.exposure === null && f.supersededCount === 0)

  // B15: 组合场景——六段数字 + 转化率（干净基线绝对断言；随后各步差值累加）
  const T = NOW
  // A：全链路（执行→响应→推进→成交）
  const a = salesDbService.todoCreate({ session_id: 'wx_a', trigger_type: 'manual', title: 'A', status: 'pending', due_at: T + 86400_000 })
  salesDbService.customerEventAdd({ session_id: 'wx_a', task_id: a.id, event_type: 'chat_opened', source: 'manual', createdAt: T + 100 })
  salesDbService.customerEventAdd({ session_id: 'wx_a', event_type: 'customer_replied', source: 'system', createdAt: T + 200 })
  applyManualStageCorrection('wx_a', '成交')
  // B：执行无响应
  const b = salesDbService.todoCreate({ session_id: 'wx_b', trigger_type: 'manual', title: 'B', status: 'pending', due_at: T + 86400_000 })
  salesDbService.customerEventAdd({ session_id: 'wx_b', task_id: b.id, event_type: 'script_copied', source: 'manual', createdAt: T + 100 })
  // C：无执行
  salesDbService.todoCreate({ session_id: 'wx_c', trigger_type: 'manual', title: 'C', status: 'pending', due_at: T + 86400_000 })
  // D：superseded 排除
  const d = salesDbService.todoCreate({ session_id: 'wx_d', trigger_type: 'rule_r1_quoted_followup', title: 'D', status: 'pending', due_at: T + 86400_000 })
  salesDbService.todoUpdate(d.id!, { status: 'superseded' })

  const g = getActionFunnel()
  ok('B15a 六段数字（created=3 / executed=2 / responded=1 / progressed=1 / won=1；superseded=1）',
    g.stages.created === 3 && g.stages.executed === 2 && g.stages.responded === 1 &&
    g.stages.progressed === 1 && g.stages.won === 1 && g.supersededCount === 1)
  ok('B15b 段间转化率（execution=2/3 / response=1/2 / progression=1/1 / conversion=1/1）',
    near(g.rates.execution, 2 / 3) && near(g.rates.response, 0.5) &&
    near(g.rates.progression, 1) && near(g.rates.conversion, 1))
  ok('B15c sources 随视图返回（六段声明可解释）', g.sources.executed === 'customer_event' && g.sources.progressed === 'customer_profile.stage')
  ok('B15d 窗口默认全量（days=null → startMs=null）', g.window.days === null && g.window.startMs === null)

  // ── B6+B7: executed task-level 去重 / 无 task_id 不归入（差值断言）─────────────
  const t1 = salesDbService.todoCreate({ session_id: 'wx_f1', trigger_type: 'manual', title: '跟进A', status: 'pending', due_at: NOW + 86400_000 })
  const t2 = salesDbService.todoCreate({ session_id: 'wx_f2', trigger_type: 'manual', title: '跟进B', status: 'pending', due_at: NOW + 86400_000 })
  // t1：同 task 2 个执行事件（去重）→ Δexecuted=1；t2：只有无 task_id 的执行事件 → 0
  salesDbService.customerEventAdd({ session_id: 'wx_f1', task_id: t1.id, event_type: 'script_copied', source: 'manual', createdAt: NOW + 1000 })
  salesDbService.customerEventAdd({ session_id: 'wx_f1', task_id: t1.id, event_type: 'chat_opened', source: 'manual', createdAt: NOW + 2000 })
  salesDbService.customerEventAdd({ session_id: 'wx_f2', event_type: 'script_copied', source: 'manual', createdAt: NOW + 3000 }) // 无 task_id
  f = getActionFunnel()
  ok('B6 executed task-level 去重（t1 同 task 2 事件 → Δexecuted=1，非事件计数）',
    f.stages.created - g.stages.created === 2 && f.stages.executed - g.stages.executed === 1)
  ok('B7 无 task_id 执行事件不归入任何 task（不伪造关联）',
    f.stages.created === 5 && f.stages.executed === 3)

  // B8: superseded 不重复计
  const t3 = salesDbService.todoCreate({ session_id: 'wx_f3', trigger_type: 'rule_r1_quoted_followup', title: '旧任务', status: 'pending', due_at: NOW + 86400_000 })
  salesDbService.todoUpdate(t3.id!, { status: 'superseded' })
  const f8 = getActionFunnel()
  ok('B8 superseded 不重复计（新 superseded → Δcreated=0 + Δsuperseded=1）',
    f8.stages.created === f.stages.created && f8.supersededCount - f.supersededCount === 1)

  // B9: 时序守卫——task 产生前的执行/响应事件不算
  const t4 = salesDbService.todoCreate({ session_id: 'wx_f4', trigger_type: 'manual', title: '时序客户', status: 'pending', due_at: NOW + 86400_000 })
  salesDbService.customerEventAdd({ session_id: 'wx_f4', task_id: t4.id, event_type: 'chat_opened', source: 'manual', createdAt: NOW - 5000 }) // task 前
  salesDbService.customerEventAdd({ session_id: 'wx_f4', event_type: 'customer_replied', source: 'system', createdAt: NOW - 5000 })        // task 前
  const f9 = getActionFunnel()
  ok('B9 时序守卫（task 产生前的执行/响应事件不算 → Δexecuted=0 + Δresponded=0）',
    f9.stages.executed === f8.stages.executed && f9.stages.responded === f8.stages.responded &&
    f9.stages.created - f8.stages.created === 1)

  // B10: responded 去重——同 session 2 响应事件 → Δresponded=1
  salesDbService.customerEventAdd({ session_id: 'wx_f1', event_type: 'customer_replied', source: 'system', createdAt: NOW + 4000 })
  salesDbService.customerEventAdd({ session_id: 'wx_f1', event_type: 'quote_asked', source: 'system', createdAt: NOW + 5000 })
  const f10 = getActionFunnel()
  ok('B10 responded 去重（同 session 2 响应事件 → Δresponded=1，非事件计数）',
    f10.stages.responded - f9.stages.responded === 1)

  // B11: progressed——stage 变更在 task 后计 1；task 后无变更不计
  // wx_f5：先有 stage 变更（早于 task）→ 不计；wx_f6：先建 task 再 stage 变更 → 计 1
  applyManualStageCorrection('wx_f5', '比价')
  await new Promise(r => setTimeout(r, 5)) // 防毫秒级竞态：变更时间必须严格早于 wx_f5 的 task
  salesDbService.todoCreate({ session_id: 'wx_f5', trigger_type: 'manual', title: '无推进', status: 'pending', due_at: NOW + 86400_000 })
  salesDbService.todoCreate({ session_id: 'wx_f6', trigger_type: 'manual', title: '有推进', status: 'pending', due_at: NOW + 86400_000 })
  applyManualStageCorrection('wx_f6', '比价')
  const f11 = getActionFunnel()
  ok('B11 progressed（wx_f5 早变更不计 / wx_f6 晚变更计 → Δprogressed=1）',
    f11.stages.progressed - f10.stages.progressed === 1)

  // B12: won——profile.stage=won（中文口径 normalizeStage）
  salesDbService.todoCreate({ session_id: 'wx_f7', trigger_type: 'manual', title: '成交客户', status: 'pending', due_at: NOW + 86400_000 })
  applyManualStageCorrection('wx_f7', '成交')
  const f12 = getActionFunnel()
  ok('B12 won（wx_f7 成交 → Δwon=1 + Δprogressed=1）',
    f12.stages.won - f11.stages.won === 1 && f12.stages.progressed - f11.stages.progressed === 1)

  // B13: 响应率公式（responded/executed；分母 > 0 → 非 null）
  ok('B13 响应率公式（response = responded/executed，分母 > 0 非 null）',
    f12.rates.response !== null && near(f12.rates.response, f12.stages.responded / f12.stages.executed))

  // B14: days 窗口只过滤 created（now 前移 30 天 → 全部 task 落窗口外）
  const futureNow = NOW + 30 * 86400_000
  f = getActionFunnel(7, futureNow)
  ok('B14 days 窗口只过滤 created（now 前移 → created=0，事件判定不截断）',
    f.stages.created === 0 && f.window.days === 7 && f.window.startMs === futureNow - 7 * 86400_000)
  f = getActionFunnel(7)
  ok('B14b 默认 now → 全部 task 在窗口内', f.stages.created > 0)

  console.log(`action-funnel-test: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main()
