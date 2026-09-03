/**
 * action-funnel-closed-gate-test.ts —— P0-4.2.3 收口护栏（静态全仓 + 真实库运行态）
 *
 * 验收（P0-4.2 拍板三刀之三：P0-4.2.1 correlation 补齐 → P0-4.2.2 getActionFunnel 只读组装 → P0-4.2.3 护栏 + 真实库验收）：
 *   A 静态全仓（防 Action Funnel 口径漂移 / 第二套统计 / 写者越界）：
 *     1  actionFunnel.ts 导入白名单（salesDbService / normalizeStage / CustomerEventType 类型）——
 *        零 salesActionEngine 判断引擎 / customer_judgment / LLM（纯只读组装边界）
 *     2  getActionFunnel 体内零写方法（customerUpsert / intentCreate / judgmentCreate / customerEventAdd /
 *        todoCreate / todoUpdate / updateStageChangeTime / kbCreate / reportCreate / flushNow 零出现）
 *     3  执行/响应事件白名单不膨胀（executed 恰 script_copied+chat_opened+follow_up_done；
 *        responded 恰 customer_replied+quote_asked——新事件类型必须显式加入才计入漏斗）
 *     4  ACTION_FUNNEL_SOURCES 六段不变量（exposed 恒 unmeasured——G1 未做前禁止伪造分母）
 *     5  divRate 分母守卫（denominator > 0 才除，不返回 0%）
 *     6  tasksCreatedSince 唯一消费者 = actionFunnel（防第二套任务窗口统计）
 *     7  无第二套 action log（action_log/user_action/sales_action_event/conversion_event 零新表 CREATE）
 *     8  task_id 非空写点仅 E3.3 三类型（crmParseService 客户事件写点零 task_id——不伪造行动关联）
 *   B 真实库运行态（sql.js 字节进内存只读，绝不初始化/写盘）：
 *     11 customer_event 0 基线（E3 后 app 未重启，部署时序；executed/responded 无样本的根因）
 *     12 created 全量口径闭合（非 superseded + superseded = 总量；与 getActionFunnel 跳过逻辑一致）
 *     13 won = 26（customer_profile.stage 中文口径 normalizeStage，与实现同口径）
 *     14 窗口结构不变量：7d <= 30d <= 全量 created（days 只过滤 created，不截断生命周期）
 *     15 executed/responded = 0（customer_event 空表 → 无样本 → rates 全 null 语义在真实数据成立）
 *     16 progressed 前置 = last_stage_change_at 非空 0（legalStageWriters 未激活，部署时序）
 *     17 六段事实来源字段全部存在（PRAGMA：customer_event.task_id / profile.stage+last_stage_change_at /
 *        task.created_at+status+session_id+id）
 *
 * 运行：npx tsx scripts/action-funnel-closed-gate-test.ts
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { findExistingBusinessDb } from '../electron/services/businessDbPath'
import os from 'os'
import initSqlJs from 'sql.js'
import { ACTION_FUNNEL_SOURCES } from '../electron/services/actionFunnel'
import { normalizeStage } from '../shared/salesStage'

let pass = 0, fail = 0
function ok(name: string, cond: boolean): void {
  if (cond) { pass++ } else { fail++; console.error('FAIL:', name) }
}

const ROOT = join(__dirname, '..')
const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

/** 读取 ROOT 下所有 ts/tsx 源文件内容（排除 node_modules 与测试脚本自身的临时产物） */
function allSource(): string[] {
  const { execSync } = require('child_process')
  const out = execSync(`find ${ROOT}/electron ${ROOT}/src ${ROOT}/shared -name '*.ts' -o -name '*.tsx'`, { encoding: 'utf8' })
  return out.split('\n').filter(Boolean).filter((f: string) => !f.includes('electron.d.ts'))
}

const DAY_MS = 24 * 3600 * 1000

async function main(): Promise<void> {
  // ── A. 静态全仓 ────────────────────────────────────────────────────────────
  const funnelSrc = readFileSync(join(ROOT, 'electron/services/actionFunnel.ts'), 'utf8')
  const funnelCode = strip(funnelSrc)

  // A1: 导入白名单（纯只读组装边界）
  ok('A1 actionFunnel.ts 导入白名单（salesDbService/normalizeStage/CustomerEventType；零 judgment/LLM/写引擎）',
    !/salesActionEngine|generateActionAnalysis|customer_judgment|intent_tag_log|judgmentCurrent|LLM/.test(funnelCode) &&
    /from '\.\/salesDbService'/.test(funnelCode) && /normalizeStage/.test(funnelCode) &&
    /import type \{ CustomerEventType \}/.test(funnelCode))

  // A2: 全文件零写方法（P0-4.3 起 getActionFunnel/collectTaskRows/getActionFunnelBreakdown 共享判定行，
  // 数据访问只在 collectTaskRows 内经 salesDbService 读方法白名单——整文件检查更严格）
  const writeMethods = ['customerUpsert', 'intentCreate', 'judgmentCreate', 'customerEventAdd',
    'todoCreate', 'todoUpdate', 'updateStageChangeTime', 'kbCreate', 'reportCreate', 'flushNow']
  ok('A2 全文件零写方法 + 读访问仅白名单三原语（tasksCreatedSince/customerEventsByType/customerGetBySession）',
    writeMethods.every((m) => !new RegExp(`\\b${m}\\(`).test(funnelCode)) &&
    /tasksCreatedSince/.test(funnelCode) && /customerEventsByType/.test(funnelCode) && /customerGetBySession/.test(funnelCode))

  // A3: 执行/响应事件白名单不膨胀（source 级正则，防新类型静默混入漏斗）
  ok('A3 执行事件白名单恰三类型（script_copied/chat_opened/follow_up_done）',
    /const EXECUTED_EVENT_TYPES: CustomerEventType\[\] = \['script_copied', 'chat_opened', 'follow_up_done'\]/.test(funnelCode))
  ok('A3b 响应事件白名单恰两类型（customer_replied/quote_asked）',
    /const RESPONDED_EVENT_TYPES: CustomerEventType\[\] = \['customer_replied', 'quote_asked'\]/.test(funnelCode))

  // A4: sources 六段不变量（exposed 恒 unmeasured——G1 未做前禁止伪造分母）
  ok('A4 ACTION_FUNNEL_SOURCES 六段不变量（created=follow_up_task / exposed=unmeasured / executed+responded=customer_event / progressed+won=customer_profile.stage）',
    ACTION_FUNNEL_SOURCES.created === 'follow_up_task' && ACTION_FUNNEL_SOURCES.exposed === 'unmeasured' &&
    ACTION_FUNNEL_SOURCES.executed === 'customer_event' && ACTION_FUNNEL_SOURCES.responded === 'customer_event' &&
    ACTION_FUNNEL_SOURCES.progressed === 'customer_profile.stage' && ACTION_FUNNEL_SOURCES.won === 'customer_profile.stage')

  // A5: divRate 分母守卫（rate=null 不变量）
  ok('A5 divRate 分母守卫（分母 > 0 才除，不返回 0%）', /denominator > 0 \?/.test(funnelCode))

  // A6: tasksCreatedSince 唯一消费者 = actionFunnel（防第二套任务窗口统计）
  const consumers = allSource().filter((f) => {
    const code = readFileSync(f, 'utf8')
    return /tasksCreatedSince\(/.test(code)
  }).filter((f) => !f.includes('salesDbService'))
  ok(`A6 tasksCreatedSince 唯一消费者 = actionFunnel（当前 ${consumers.length} 个）`,
    consumers.length === 1 && consumers[0].includes('actionFunnel'))

  // A7: 无第二套 action log（P0-4 硬边界：action_log/user_action/sales_action_event/conversion_event 零新表）
  const newLogTables = allSource().filter((f) => {
    const code = readFileSync(f, 'utf8')
    return /CREATE TABLE (IF NOT EXISTS )?(action_log|user_action|sales_action_event|conversion_event)/.test(code)
  })
  ok(`A7 无第二套 action log（action_log/user_action/sales_action_event/conversion_event 零新表 CREATE，当前 ${newLogTables.length} 处）`,
    newLogTables.length === 0)

  // A8: task_id 非空写点仅 E3.3（crmParseService 客户事件写点零 task_id——客户事件无任务轴，不伪造行动关联）
  const parseSrc = readFileSync(join(ROOT, 'electron/services/crmParseService.ts'), 'utf8')
  const parseCode = strip(parseSrc)
  const engineCode = strip(readFileSync(join(ROOT, 'electron/services/salesActionEngine.ts'), 'utf8'))
  ok('A8a crmParseService 客户事件写点零 task_id（quote_asked/customer_replied 无任务轴）',
    !/task_id|taskId/.test(parseCode.slice(parseCode.indexOf('recordCustomerEventSafe'))))
  ok('A8b recordUserActionEvent 白名单 = 三执行类型（task_id 唯一非空写通道）',
    /\['script_copied', 'chat_opened', 'follow_up_done'\]/.test(engineCode))

  // ── B. 真实库运行态（sql.js 字节进内存只读）──────────────────────────────
  const SQL = await initSqlJs()
  // §2.40 分库：按账号命名的业务库优先（多个账号取最近使用），回退 legacy 名
  const USER_DATA = join(os.homedir(), 'Library/Application Support/weflow')
  const DB_PATH = findExistingBusinessDb(USER_DATA, 'sales')
  if (!DB_PATH) { console.error(`未找到销售业务库（weflow-sales-*.db / weflow-sales.db）：${USER_DATA}`); process.exit(1) }
  const db = new SQL.Database(readFileSync(DB_PATH))

  // B11: customer_event 表激活校验（2026-08-24 观察期开始后 0 基线断言已过时——id=4 真实事件已积累；
  // 语义迁移：schema 激活仍校验，0 基线/行数增长移交数据侧 T0/T+n 快照跟踪）
  const evTables = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='customer_event'")
  const evCount = evTables.length === 0 ? 0 : db.exec("SELECT COUNT(*) FROM customer_event")[0].values[0][0] as number
  ok('B11 customer_event 表已激活（E3 部署完成，观察期真实事件开始积累）', evTables.length > 0)
  console.log('  B11 快照：customer_event 行数 =', evCount)

  // B12: created 全量口径闭合（getActionFunnel 跳过 superseded → created = 非 superseded 计数）
  const total = db.exec('SELECT COUNT(*) FROM follow_up_task')[0].values[0][0] as number
  const created = db.exec("SELECT COUNT(*) FROM follow_up_task WHERE status != 'superseded'")[0].values[0][0] as number
  const superseded = db.exec("SELECT COUNT(*) FROM follow_up_task WHERE status = 'superseded'")[0].values[0][0] as number
  ok(`B12 created 口径闭合（非 superseded ${created} + superseded ${superseded} = 总量 ${total}）`,
    created + superseded === total && created > 0 && superseded > 0)
  console.log('  B12 快照：created=', created, 'superseded=', superseded, 'total=', total)

  // B13: won = 26（customer_profile.stage 中文口径 normalizeStage，与实现同口径）
  const stages = (db.exec('SELECT stage FROM customer_profile')[0].values as Array<[string | null]>)
    .map((r) => r[0] ?? '')
  const won = stages.filter((s) => normalizeStage(s) === 'won').length
  const unknown = stages.filter((s) => normalizeStage(s) === 'unknown').length
  ok(`B13 won=${won}（normalizeStage 同口径；profile ${stages.length} 行，unknown ${unknown}）`, won === 26 && stages.length === 200)

  // B14: 窗口结构不变量（7d <= 30d <= 全量；days 只过滤 created）
  const now = Date.now()
  const w7 = db.exec("SELECT COUNT(*) FROM follow_up_task WHERE created_at >= ? AND status != 'superseded'", [now - 7 * DAY_MS])[0].values[0][0] as number
  const w30 = db.exec("SELECT COUNT(*) FROM follow_up_task WHERE created_at >= ? AND status != 'superseded'", [now - 30 * DAY_MS])[0].values[0][0] as number
  ok(`B14 窗口结构不变量（7d=${w7} <= 30d=${w30} <= 全量 ${created}；窗口只过滤 created 不截断生命周期）`,
    w7 > 0 && w7 <= w30 && w30 <= created)

  // B15: executed/responded 消费链路可用（表激活 + 行数可读；rates 全 null 语义由 actionFunnel 单测覆盖，
  // 真实库样本量随 T0/T+n 快照跟踪——观察期不再断言 0）
  ok('B15 executed/responded 链路可消费（customer_event 表激活 + 行数可读）', evTables.length > 0 && evCount >= 0)

  // B16: progressed 前置 = last_stage_change_at 非空 0（legalStageWriters 未激活，部署时序）
  const stageChanged = db.exec('SELECT COUNT(*) FROM customer_profile WHERE last_stage_change_at IS NOT NULL')[0].values[0][0] as number
  ok(`B16 last_stage_change_at 非空 ${stageChanged}（legalStageWriters 激活前无 progressed 样本，部署时序）`, stageChanged === 0)

  // B17: 六段事实来源字段全部存在（sources 与真实 schema 一一对应；
  // customer_event 表未激活时 PRAGMA 无行——evCols 容错为空，schema 校验以 DDL 源为准）
  const taskCols = (db.exec('PRAGMA table_info(follow_up_task)')[0].values as Array<[number, string]>).map((r) => r[1])
  const evRows = db.exec('PRAGMA table_info(customer_event)')
  const evCols = evRows.length ? (evRows[0].values as Array<[number, string]>).map((r) => r[1]) : []
  const profCols = (db.exec('PRAGMA table_info(customer_profile)')[0].values as Array<[number, string]>).map((r) => r[1])
  // customer_event 表未激活时，task_id 列存在性改验 SCHEMA_SQL（P0-4.2.1 已通过 E3 收口 B13 的 DDL 无损建表验证）
  const dbSrc = readFileSync(join(ROOT, 'electron/services/salesDbService.ts'), 'utf8')
  const ddlHasTaskId = /CREATE TABLE IF NOT EXISTS customer_event[\s\S]*?task_id INTEGER/.test(strip(dbSrc))
  ok('B17 六段事实来源字段齐全（task.created_at/status/session_id/id + profile.stage/last_stage_change_at + event 轴由 DDL 保证 task_id）',
    ['id', 'session_id', 'status', 'created_at'].every((c) => taskCols.includes(c)) &&
    (evCols.length === 0 || ['session_id', 'task_id', 'event_type'].every((c) => evCols.includes(c))) &&
    ['stage', 'last_stage_change_at'].every((c) => profCols.includes(c)) && ddlHasTaskId)

  console.log(`action-funnel-closed-gate: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main()
