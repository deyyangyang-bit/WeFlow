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
 *     业务数据持续增长，B 段零固定业务数量断言——只验证结构闭合与双引擎复算一致，空样本为合法空态：
 *     11 customer_event 表激活校验（schema 在位；样本量随业务增长，只快照不设数）
 *     12 created 口径闭合：created + superseded = total（7d/30d/全量三窗口逐一；与 collectTaskRows
 *        只跳 status==='superseded' 同口径，SQL 侧用 NULL 安全的 IS NOT 对齐）
 *     13 normalizeStage 阶段统计与 DB 查询闭合：Σ分档 = profile 总行数，且逐行归一 = GROUP BY 加权归一
 *        （双聚合路径逐段一致；won 等各阶段数量随业务增长只快照不设数）
 *     14 窗口结构不变量：7d <= 30d <= 全量 created（days 只过滤 created_at，不截断生命周期）
 *     15 漏斗四段双引擎重算闭合（JS 镜像 collectTaskRows 语义 = SQL 复算，逐窗口一致）：
 *        executed = customer_event task_id 轴 + 时序守卫；responded = session 轴 + 时序守卫；
 *        progressed = last_stage_change_at >= task.created_at；won = normalizeStage(stage)==='won'；
 *        事件读取面镜像 customerEventsByType 默认 limit=100（每类型 created_at DESC, id DESC 前 100）
 *     16 全段窗口单调（created/executed/responded/progressed/won 均 7d <= 30d <= 全量）
 *        + 有样本时校验：时间顺序（事件 ts / 推进滞后 >= 0）、客户去重（DISTINCT task/session；
 *        won/progressed 段被 profile 事实数约束）；无样本时验证合法空态（双引擎同时为 0）
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
import { normalizeStage, STAGE_CANONICAL } from '../shared/salesStage'

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

  /** 聚合单值查询（COUNT 等；空结果/NULL → 0） */
  const qn = (sql: string, params: unknown[] = []): number => {
    const r = db.exec(sql, params)
    const v = r.length ? (r[0].values[0]?.[0] as unknown) : undefined
    return typeof v === 'number' ? v : 0
  }
  /** 行集查询 */
  const qAll = (sql: string, params: unknown[] = []): unknown[][] =>
    (db.exec(sql, params)[0]?.values ?? []) as unknown[][]

  const NOW = Date.now()
  const WINDOWS: Array<{ label: string; startMs: number | null }> = [
    { label: '7d', startMs: NOW - 7 * DAY_MS },
    { label: '30d', startMs: NOW - 30 * DAY_MS },
    { label: 'all', startMs: null }
  ]
  const windowCond = (startMs: number | null, col: string): string => (startMs != null ? ` AND ${col} >= ?` : '')
  const windowParams = (startMs: number | null): unknown[] => (startMs != null ? [startMs] : [])

  // B11: customer_event 表激活校验（schema 在位即算激活；样本量随业务增长移交数据侧快照跟踪，不设数）
  const evTables = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='customer_event'")
  const evCount = evTables.length === 0 ? 0 : qn('SELECT COUNT(*) FROM customer_event')
  ok('B11 customer_event 表已激活（E3 部署完成，观察期真实事件开始积累）', evTables.length > 0)
  console.log('  B11 快照：customer_event 行数 =', evCount)

  // B12: created 口径闭合（collectTaskRows 只跳 status==='superseded'，NULL status 及其它状态均计入 created
  // → SQL 侧用 NULL 安全的 IS NOT 对齐；三窗口逐一闭合，0 任务为合法空态）
  const createdByWindow = new Map<string, number>()
  for (const w of WINDOWS) {
    const totalW = qn(`SELECT COUNT(*) FROM follow_up_task WHERE 1=1${windowCond(w.startMs, 'created_at')}`, windowParams(w.startMs))
    const createdW = qn(`SELECT COUNT(*) FROM follow_up_task WHERE status IS NOT 'superseded'${windowCond(w.startMs, 'created_at')}`, windowParams(w.startMs))
    const supersededW = qn(`SELECT COUNT(*) FROM follow_up_task WHERE status = 'superseded'${windowCond(w.startMs, 'created_at')}`, windowParams(w.startMs))
    ok(`B12[${w.label}] created 口径闭合（created ${createdW} + superseded ${supersededW} = total ${totalW}）`,
      createdW + supersededW === totalW)
    createdByWindow.set(w.label, createdW)
    console.log(`  B12[${w.label}] 快照：created=${createdW} superseded=${supersededW} total=${totalW}`)
  }

  // B13: normalizeStage 阶段统计与 DB 查询闭合（Σ分档 = profile 总行数；逐行归一 = GROUP BY 加权归一，
  // 双聚合路径逐段一致；won 等各阶段数量随业务增长只快照不设数）
  const profileTotal = qn('SELECT COUNT(*) FROM customer_profile')
  const stageRows = qAll('SELECT stage FROM customer_profile') as Array<[string | null]>
  const perStageByRow = new Map<string, number>(STAGE_CANONICAL.map((s) => [s as string, 0]))
  for (const [raw] of stageRows) {
    const c = normalizeStage(raw)
    perStageByRow.set(c, (perStageByRow.get(c) ?? 0) + 1)
  }
  const groupedStages = qAll('SELECT stage, COUNT(*) FROM customer_profile GROUP BY stage') as Array<[string | null, number]>
  const perStageByGroup = new Map<string, number>(STAGE_CANONICAL.map((s) => [s as string, 0]))
  let groupedSum = 0
  for (const [raw, cnt] of groupedStages) {
    groupedSum += Number(cnt)
    const c = normalizeStage(raw)
    perStageByGroup.set(c, (perStageByGroup.get(c) ?? 0) + Number(cnt))
  }
  const rowSum = [...perStageByRow.values()].reduce((a, b) => a + b, 0)
  const stageDist = STAGE_CANONICAL.filter((s) => (perStageByRow.get(s) ?? 0) > 0)
    .map((s) => `${s}=${perStageByRow.get(s)}`).join(' / ')
  ok(`B13 normalizeStage 阶段统计与 DB 闭合（profile ${profileTotal} = Σ逐行分档 ${rowSum} = Σ GROUP BY ${groupedSum}；分布 ${stageDist}）`,
    profileTotal === rowSum && rowSum === groupedSum &&
    STAGE_CANONICAL.every((s) => perStageByRow.get(s) === perStageByGroup.get(s)))
  console.log('  B13 快照：stage 分布 =', stageDist)
  const wonProfileCount = perStageByRow.get('won') ?? 0

  // B14: 窗口结构不变量（7d <= 30d <= 全量 created；days 只过滤 created_at；空窗口为合法空态）
  const c7 = createdByWindow.get('7d') ?? 0
  const c30 = createdByWindow.get('30d') ?? 0
  const call = createdByWindow.get('all') ?? 0
  ok(`B14 窗口结构不变量（created：7d=${c7} <= 30d=${c30} <= 全量=${call}；窗口只过滤 created_at 不截断生命周期）`,
    c7 <= c30 && c30 <= call)

  // B15: 漏斗四段双引擎重算闭合（JS 镜像 collectTaskRows 语义 ↔ SQL 复算；0 样本为合法空态）
  // 前置：事件读取面镜像 customerEventsByType 默认 limit=100——读取面漂移会使镜像失真，静态钉住签名
  const dbSvcCode = strip(readFileSync(join(ROOT, 'electron/services/salesDbService.ts'), 'utf8'))
  ok('B15 前置：customerEventsByType 默认读取面 limit=100（测试镜像与生产读取面钉在同一口径）',
    /customerEventsByType\(eventType: CustomerEventType, sinceMs\?: number, limit: number = 100\)/.test(dbSvcCode))

  // 事件白名单与 actionFunnel.ts 同口径（生产侧不膨胀由 A3 静态护栏保证）
  const EXECUTED_TYPES = ['script_copied', 'chat_opened', 'follow_up_done']
  const RESPONDED_TYPES = ['customer_replied', 'quote_asked']

  interface TaskRow { id: number | null; session_id: string | null; status: string | null; created_at: number | null }
  interface EventRow { id: number | null; event_type: string | null; session_id: string | null; task_id: number | null; created_at: number | null }
  interface ProfileRow { id: number | null; session_id: string | null; stage: string | null; last_stage_change_at: number | null }

  const taskRows = (qAll('SELECT id, session_id, status, created_at FROM follow_up_task') as Array<[number | null, string | null, string | null, number | null]>)
    .map(([id, session_id, status, created_at]): TaskRow => ({ id, session_id, status, created_at }))
  const eventRows = (qAll('SELECT id, event_type, session_id, task_id, created_at FROM customer_event') as Array<[number | null, string | null, string | null, number | null, number | null]>)
    .map(([id, event_type, session_id, task_id, created_at]): EventRow => ({ id, event_type, session_id, task_id, created_at }))
  const profileRows = (qAll('SELECT id, session_id, stage, last_stage_change_at FROM customer_profile ORDER BY id') as Array<[number | null, string | null, string | null, number | null]>)
    .map(([id, session_id, stage, last_stage_change_at]): ProfileRow => ({ id, session_id, stage, last_stage_change_at }))

  // customerGetBySession 语义：session 首行（扫描序 = id 升序；session_id 无 UNIQUE，首行即事实）
  const profileBySession = new Map<string, { stage: string | null; lastStageChangeAt: number | null }>()
  for (const p of profileRows) {
    const sid = p.session_id ?? ''
    if (!profileBySession.has(sid)) profileBySession.set(sid, { stage: p.stage, lastStageChangeAt: p.last_stage_change_at })
  }

  // customerEventsByType 语义镜像：每类型按 created_at DESC, id DESC 取前 100（E3 读取面 limit）
  const EVENT_READ_LIMIT = 100
  const eventsByTypeTop = (types: string[]): Array<{ eventId: number | null; type: string; sessionId: string; taskId: number | null; ts: number }> =>
    types.flatMap((type) =>
      eventRows.filter((e) => e.event_type === type)
        .sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0) || (b.id ?? 0) - (a.id ?? 0))
        .slice(0, EVENT_READ_LIMIT)
        .map((e) => ({ eventId: e.id, type, sessionId: e.session_id ?? '', taskId: e.task_id, ts: e.created_at ?? 0 })))

  // 执行事件索引：task_id → 事件明细（task_id 为空不归入任何 task——与 collectTaskRows 同守卫）
  const executedByTask = new Map<number, Array<{ type: string; ts: number }>>()
  for (const ev of eventsByTypeTop(EXECUTED_TYPES)) {
    if (ev.taskId == null) continue
    const list = executedByTask.get(ev.taskId)
    if (list) list.push({ type: ev.type, ts: ev.ts })
    else executedByTask.set(ev.taskId, [{ type: ev.type, ts: ev.ts }])
  }
  // 响应事件索引：session_id → 事件明细（客户事件无 task_id，session 轴关联——与 collectTaskRows 同守卫）
  const respondedBySession = new Map<string, Array<{ type: string; ts: number }>>()
  for (const ev of eventsByTypeTop(RESPONDED_TYPES)) {
    const list = respondedBySession.get(ev.sessionId)
    if (list) list.push({ type: ev.type, ts: ev.ts })
    else respondedBySession.set(ev.sessionId, [{ type: ev.type, ts: ev.ts }])
  }

  /** JS 镜像重算（与 collectTaskRows 逐行同语义，附样本明细供时序/去重校验） */
  interface FunnelCount {
    created: number; superseded: number; executed: number; responded: number; progressed: number; won: number
    executedPairs: Array<{ taskId: number; taskCreatedAt: number; ts: number }>
    respondedSessions: string[]
    progressedSessions: string[]; progressedLags: number[]
    wonSessions: string[]
  }
  function recomputeFunnel(startMs: number | null): FunnelCount {
    const f: FunnelCount = {
      created: 0, superseded: 0, executed: 0, responded: 0, progressed: 0, won: 0,
      executedPairs: [], respondedSessions: [], progressedSessions: [], progressedLags: [], wonSessions: []
    }
    for (const t of taskRows) {
      if (startMs != null && (t.created_at ?? 0) < startMs) continue
      if ((t.status ?? '') === 'superseded') { f.superseded++; continue }
      f.created++
      const taskCreatedAt = t.created_at ?? 0
      const sessionId = t.session_id ?? ''
      const taskId = t.id
      // executed：task 至少一个执行事件（task_id 精确关联；事件须在 task 产生后）
      if (taskId != null) {
        for (const e of executedByTask.get(taskId) ?? []) {
          if (e.ts < taskCreatedAt) continue
          f.executed++
          f.executedPairs.push({ taskId, taskCreatedAt, ts: e.ts })
          break
        }
      }
      // responded：session 级关联（事件须在 task 产生后）
      if (sessionId) {
        for (const e of respondedBySession.get(sessionId) ?? []) {
          if (e.ts < taskCreatedAt) continue
          f.responded++
          f.respondedSessions.push(sessionId)
          break
        }
      }
      // progressed/won：customer_profile canonical 事实（真实 last_stage_change_at + normalizeStage(stage)）
      const profile = sessionId ? profileBySession.get(sessionId) : undefined
      if (profile) {
        if (profile.lastStageChangeAt != null && profile.lastStageChangeAt >= taskCreatedAt) {
          f.progressed++
          f.progressedSessions.push(sessionId)
          f.progressedLags.push(profile.lastStageChangeAt - taskCreatedAt)
        }
        if (normalizeStage(profile.stage ?? '') === 'won') { f.won++; f.wonSessions.push(sessionId) }
      }
    }
    return f
  }

  // SQL 复算路径（同一事实、同一语义，独立于 JS 镜像的第二计算引擎）
  // 事件宇宙与 JS 镜像共用（customerEventsByType top-100 事件 id），join/聚合在 SQL 内完成
  const executedEventIds = eventsByTypeTop(EXECUTED_TYPES).map((e) => e.eventId).filter((v): v is number => v != null)
  const respondedEventIds = eventsByTypeTop(RESPONDED_TYPES).map((e) => e.eventId).filter((v): v is number => v != null)
  const inList = (vals: readonly unknown[]): string => vals.map(() => '?').join(',')

  const executedSqlFor = (startMs: number | null): number => {
    if (executedEventIds.length === 0) return 0
    return qn(
      `SELECT COUNT(DISTINCT t.id) FROM follow_up_task t
       WHERE t.status IS NOT 'superseded'${windowCond(startMs, 't.created_at')}
       AND EXISTS (SELECT 1 FROM customer_event e
         WHERE e.task_id = t.id AND e.created_at >= t.created_at
         AND e.id IN (${inList(executedEventIds)}))`,
      [...windowParams(startMs), ...executedEventIds])
  }
  const respondedSqlFor = (startMs: number | null): number => {
    if (respondedEventIds.length === 0) return 0
    return qn(
      `SELECT COUNT(DISTINCT t.id) FROM follow_up_task t
       WHERE t.status IS NOT 'superseded'${windowCond(startMs, 't.created_at')}
       AND t.session_id IS NOT NULL AND t.session_id != ''
       AND EXISTS (SELECT 1 FROM customer_event e
         WHERE e.session_id = t.session_id AND e.created_at >= t.created_at
         AND e.id IN (${inList(respondedEventIds)}))`,
      [...windowParams(startMs), ...respondedEventIds])
  }
  // customerGetBySession 语义 = session 首行（id 升序），SQL 侧用标量子查询对齐
  const firstProfileJoin = `JOIN customer_profile p ON p.id =
       (SELECT p2.id FROM customer_profile p2 WHERE p2.session_id = t.session_id ORDER BY p2.id LIMIT 1)`
  const progressedSqlFor = (startMs: number | null): number => qn(
    `SELECT COUNT(DISTINCT t.id) FROM follow_up_task t
     ${firstProfileJoin}
     WHERE t.status IS NOT 'superseded'${windowCond(startMs, 't.created_at')}
     AND t.session_id IS NOT NULL AND t.session_id != ''
     AND p.last_stage_change_at IS NOT NULL AND p.last_stage_change_at >= t.created_at`,
    windowParams(startMs))
  // won 段 SQL 复算：原始 stage 取值集由 DB GROUP BY 经 normalizeStage 运行时推导（非写死枚举）
  const wonRawValues = groupedStages.filter(([raw]) => normalizeStage(raw) === 'won').map(([raw]) => String(raw ?? ''))
  const wonSqlFor = (startMs: number | null): number => {
    if (wonRawValues.length === 0) return 0
    return qn(
      `SELECT COUNT(DISTINCT t.id) FROM follow_up_task t
       ${firstProfileJoin}
       WHERE t.status IS NOT 'superseded'${windowCond(startMs, 't.created_at')}
       AND t.session_id IS NOT NULL AND t.session_id != ''
       AND p.stage IN (${inList(wonRawValues)})`,
      [...windowParams(startMs), ...wonRawValues])
  }

  const funnels = new Map<string, FunnelCount>()
  const sqlByWindow = new Map<string, { executed: number; responded: number; progressed: number; won: number }>()
  for (const w of WINDOWS) {
    const js = recomputeFunnel(w.startMs)
    funnels.set(w.label, js)
    const sqlExecuted = executedSqlFor(w.startMs)
    const sqlResponded = respondedSqlFor(w.startMs)
    const sqlProgressed = progressedSqlFor(w.startMs)
    const sqlWon = wonSqlFor(w.startMs)
    sqlByWindow.set(w.label, { executed: sqlExecuted, responded: sqlResponded, progressed: sqlProgressed, won: sqlWon })
    ok(`B15[${w.label}] executed 双引擎闭合（JS 重算 ${js.executed} = SQL 复算 ${sqlExecuted}；executed + 未执行 ${js.created - js.executed} = created ${js.created}；0 样本为合法空态）`,
      js.executed === sqlExecuted && js.executed <= js.created)
    ok(`B15[${w.label}] responded 双引擎闭合（JS 重算 ${js.responded} = SQL 复算 ${sqlResponded}；responded + 未响应 ${js.created - js.responded} = created ${js.created}）`,
      js.responded === sqlResponded && js.responded <= js.created)
    ok(`B15[${w.label}] progressed 按真实 last_stage_change_at 双引擎闭合（JS 重算 ${js.progressed} = SQL 复算 ${sqlProgressed}；progressed + 未推进 ${js.created - js.progressed} = created ${js.created}）`,
      js.progressed === sqlProgressed && js.progressed <= js.created)
    ok(`B15[${w.label}] won 按阶段事实双引擎闭合（JS 重算 ${js.won} = SQL 复算 ${sqlWon}；won + 未成交 ${js.created - js.won} = created ${js.created}）`,
      js.won === sqlWon && js.won <= js.created)
    ok(`B15[${w.label}] created 重算与 B12 直查一致（JS ${js.created} = SQL ${createdByWindow.get(w.label)}；superseded JS ${js.superseded}）`,
      js.created === createdByWindow.get(w.label))
  }

  // B16: 全段窗口单调（days 只过滤 created_at，task 级布尔与窗口无关 → 每段 7d <= 30d <= 全量）
  const SEGS = ['created', 'executed', 'responded', 'progressed', 'won'] as const
  ok('B16 全段窗口结构不变量（created/executed/responded/progressed/won 均 7d <= 30d <= 全量）',
    SEGS.every((s) => {
      const v7 = funnels.get('7d')![s]
      const v30 = funnels.get('30d')![s]
      const va = funnels.get('all')![s]
      return v7 <= v30 && v30 <= va
    }))

  // B16b-e: 有样本时校验时间顺序与客户去重；无样本时验证合法空态（双引擎同时为 0，不强造样本）
  const F = funnels.get('all')!
  const sqlAll = sqlByWindow.get('all')!
  const stageChangedProfiles = profileRows.filter((p) => p.last_stage_change_at != null).length
  console.log(`  B16 快照：last_stage_change_at 非空 profile = ${stageChangedProfiles}（progressed 事实样本）；won profile = ${wonProfileCount}`)

  if (F.progressedLags.length > 0) {
    ok(`B16b progressed 样本校验（时间顺序：每样本 last_stage_change_at - task.created_at >= 0，最小滞后 ${Math.min(...F.progressedLags)}ms；客户去重：DISTINCT session ${new Set(F.progressedSessions).size} <= progressed ${F.progressed} 且 <= 非空事实 profile ${stageChangedProfiles}）`,
      F.progressedLags.every((lag) => lag >= 0) &&
      new Set(F.progressedSessions).size <= F.progressed &&
      new Set(F.progressedSessions).size <= stageChangedProfiles)
  } else {
    ok(`B16b progressed 无样本 → 合法空态（JS 重算 0 = SQL 复算 ${sqlAll.progressed}；last_stage_change_at 非空 profile ${stageChangedProfiles} 条仅快照不设数）`,
      F.progressed === 0 && sqlAll.progressed === 0)
  }

  if (F.executedPairs.length > 0) {
    ok(`B16c executed 样本校验（事件时间顺序：全部计入事件 ts >= task.created_at；task 级去重：executed ${F.executed} = DISTINCT task ${new Set(F.executedPairs.map((p) => p.taskId)).size}，非事件条数）`,
      F.executedPairs.every((p) => p.ts >= p.taskCreatedAt) &&
      F.executed === new Set(F.executedPairs.map((p) => p.taskId)).size)
  } else {
    ok('B16c executed 无样本 → 合法空态（JS 重算 0 = SQL 复算 0，双引擎闭合）',
      F.executed === 0 && sqlAll.executed === 0)
  }

  if (F.respondedSessions.length > 0) {
    ok(`B16d responded 样本校验（session 去重：responded task 的 DISTINCT session ${new Set(F.respondedSessions).size} <= responded ${F.responded} 且 <= 有响应事件 session ${respondedBySession.size}）`,
      new Set(F.respondedSessions).size <= F.responded &&
      new Set(F.respondedSessions).size <= respondedBySession.size)
  } else {
    ok('B16d responded 无样本 → 合法空态（JS 重算 0 = SQL 复算 0，双引擎闭合）',
      F.responded === 0 && sqlAll.responded === 0)
  }

  if (F.wonSessions.length > 0) {
    ok(`B16e won 样本校验（客户去重：won task 的 DISTINCT session ${new Set(F.wonSessions).size} <= won ${F.won} 且 <= won profile ${wonProfileCount}——漏斗段被 profile 事实约束）`,
      new Set(F.wonSessions).size <= F.won &&
      new Set(F.wonSessions).size <= wonProfileCount)
  } else {
    ok('B16e won 无样本 → 合法空态（JS 重算 0 = SQL 复算 0，双引擎闭合）',
      F.won === 0 && sqlAll.won === 0)
  }

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
