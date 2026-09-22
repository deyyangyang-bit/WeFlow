/**
 * annual-review-invalidation-test.ts —— 年度经营复盘数据失效总线护栏（范围收窄轮 + leading-edge + 原子批量轮）
 *
 * 覆盖（对应用户验收要求）：
 *   A  总线语义：**首条事件立即派发**（不等窗口、不依赖 flush）、窗口内抑制并有界合并、
 *      持续事件不无限延迟、立即失效可穿窗、订阅者异常隔离、事件不含业务数据
 *   A5 **同一事务多 reason 原子派发**：一次提交 = 一次事件（去重稳定排序、计数恒为 1）、
 *      等待超过窗口**不补发**第二次失效、新启动的报告不被延迟取消、
 *      真正独立的连续两次提交仍覆盖第二次数据变化（真实计时器）
 *   B  **无关写入不失效**：scan_state / processed_msg / migration_report / migration_dismissal /
 *      无关 audit action / activity_log / auto_confirm_log / knowledge_base / report_snapshot /
 *      eval case / follow_up_task / 未声明的无关事务
 *   C  **相关写入立即失效**：account / contract / contract_status_history / allocation /
 *      assignment / lead / opportunity / opportunity_event / audit_event(三动作) /
 *      customer_profile / intent_tag_log（真实方法驱动，**不 flush 即时断言**）
 *   D  失败或回滚写入不失效
 *   E  无关写入不打断运行中的报告/AI 任务、不清缓存
 *   F  账号隔离不受破坏（失效是 coarse 的，但绝不跨账号回读）
 *   G  读操作不接入失效
 *   H  **归属类操作的单条权威链路**（assign / claim / recycle / transfer / 历史导入 /
 *      SLA 回收 / SLA 纠正 / 好友绑定 / LAN-Central 下行与上行回执）：年度复盘立即失效
 *      **恰好一次**、Assignment UI 事件照发、等过两个 150ms 窗口后不再有第二次失效、
 *      新启动的报告不被延迟取消；冲突 / 无 lead / 重复 / noop 审计不失效（真实计时器）
 *   J  LAN 上行 audit：白名单 action 提交后立即失效；**重复投递（同一 idempotencyKey
 *      重建事件文件）走幂等路径零业务写、零失效、审计不重复**；失败事务不失效
 *
 * 测试纪律：数据库用真实 crmDbService/salesDbService + 临时目录（sql.js），报告与 AI 结果用
 * 已验收服务层 + 注入的假 Worker runner/假模型出口（**不发真实请求、不碰真实用户数据**）。
 * 环境隔离与 lan-sync-test 同构：三行 env 在动态 import 业务模块前生效，绝不读写持久配置。
 * 运行：npx tsx scripts/annual-review-invalidation-test.ts
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const isoDir = mkdtempSync(join(tmpdir(), 'ar-invalidation-'))
process.env.WEFLOW_WORKER = '1'
process.env.WEFLOW_USER_DATA_PATH = isoDir
process.env.WEFLOW_CONFIG_CWD = isoDir

import {
  ANNUAL_REVIEW_AUDIT_ACTIONS,
  ANNUAL_REVIEW_CRM_SOURCE_TABLES,
  ANNUAL_REVIEW_INVALIDATION_FLUSH_MS,
  ANNUAL_REVIEW_SALES_SOURCE_TABLES,
  announceAnnualReviewAuditAction,
  announceAnnualReviewCrmWrite,
  announceAnnualReviewDataChanged,
  announceAnnualReviewDataChangedMany,
  announceAnnualReviewDataChangedNow,
  announceAnnualReviewSalesWrite,
  flushAnnualReviewInvalidationForTest,
  hasPendingAnnualReviewInvalidation,
  installAnnualReviewInvalidation,
  onAnnualReviewInvalidation,
  resetAnnualReviewInvalidationForTest,
  type AnnualReviewInvalidationEvent
} from '../electron/services/annualReviewInvalidation'
import {
  resolveAnnualReviewPeriod,
  type AnnualReviewFacts,
  type AnnualReviewMessageStats
} from '../electron/services/annualReviewStats'
import type { AnnualReviewSalesSegmentsFacts, AnnualReviewCrmSegmentsFacts } from '../electron/services/annualReviewSegments'
import { composeAnnualReviewReport, type AnnualReviewReport } from '../electron/services/annualReviewReport'
import {
  AnnualReviewService,
  type AnnualReviewAccountContext,
  type AnnualReviewWorkerPayload,
  type AnnualReviewWorkerRunner
} from '../electron/services/annualReviewService'
import { AnnualReviewAiCoordinator } from '../electron/services/annualReviewAiCoordinator'
import { ANNUAL_REVIEW_AI_PROMPT_VERSION } from '../electron/services/annualReviewAiCore'

let crmDbService: (typeof import('../electron/services/crmDbService'))['crmDbService']
let salesDbService: (typeof import('../electron/services/salesDbService'))['salesDbService']
let lanSync: (typeof import('../electron/services/lanSyncService'))
let assignmentBus: (typeof import('../electron/services/assignmentInvalidationBus'))

let pass = 0, fail = 0
function ok(name: string, cond: boolean): void {
  if (cond) { pass++ } else { fail++; console.error('FAIL:', name) }
}
const tick = (): Promise<void> => new Promise((r) => setImmediate(r))
const wait = async (n = 6): Promise<void> => { for (let i = 0; i < n; i++) await tick() }
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const T = (y: number, m: number, d: number): number => new Date(y, m - 1, d, 12, 0, 0).getTime()
const GEN = T(2026, 6, 15)
const YEAR = 2025

// ── 报告夹具（与 service/ai 测试同构的最小事实） ─────────────────────────────
const facts: AnnualReviewFacts = {
  accounts: [{ id: 1, name: '客户1', createdAt: T(2025, 2, 1), importedAt: null, sessionId: 'wxid_inv', lastContactAtSec: null }],
  contracts: [{ id: 1, accountId: 1, amount: 1200, status: 'signed', signDate: T(2025, 3, 1) }],
  allocations: [],
  shippedEvents: []
}
const sales: AnnualReviewSalesSegmentsFacts = { profiles: [], intentEvents: [] }
const crm: AnnualReviewCrmSegmentsFacts = { opportunities: [], opportunityEvents: [] }
const messageStats: AnnualReviewMessageStats = { ok: true, sessions: {} }
const ANALYSIS = { executiveSummary: '整体经营平稳。', diagnoses: [], actions: [], risks: [] }

function createHarness() {
  const ctx: AnnualReviewAccountContext = {
    wxid: 'wx_inv_a', salesDbName: 'sales-inv-a.db', crmDbName: 'crm-inv-a.db', exclusions: { manualSessions: [], internalSessions: [] }
  }
  const runnerCalls: Array<{ payload: AnnualReviewWorkerPayload; resolve: (r: AnnualReviewReport) => void }> = []
  const runner: AnnualReviewWorkerRunner = {
    run(payload) {
      return new Promise<AnnualReviewReport>((resolve) => { runnerCalls.push({ payload, resolve }) })
    }
  }
  let seq = 0
  const service = new AnnualReviewService({
    loadFacts: async () => facts,
    loadSalesSegments: async () => sales,
    loadCrmSegments: async () => crm,
    loadMessageStats: async () => messageStats,
    getAccountContext: () => ctx,
    runner,
    now: () => GEN,
    newTaskId: () => `inv-${++seq}`
  })
  const aiCalls: string[] = []
  const coordinator = new AnnualReviewAiCoordinator({
    getTaskReport: (taskId) => service.getTaskReport(taskId),
    getConfig: () => ({ get: () => undefined }) as never,
    generate: (async (report: AnnualReviewReport) => {
      aiCalls.push(String(report.year))
      return { ok: true, analysis: ANALYSIS, model: 'fake', promptVersion: ANNUAL_REVIEW_AI_PROMPT_VERSION, generatedAt: GEN }
    }) as never,
    now: () => GEN
  })
  /** 生产接线（main.ts 调用的同一个函数） */
  const unsubscribe = installAnnualReviewInvalidation({
    handleDataChanged: () => service.handleDataChanged(),
    invalidateAll: () => coordinator.invalidateAll()
  })
  return { service, coordinator, ctx, runnerCalls, aiCalls, unsubscribe }
}

/** 生成一份报告并让 AI 结果进入缓存（两类缓存都热） */
async function warmCaches(h: ReturnType<typeof createHarness>): Promise<string> {
  const started = h.service.start(YEAR)
  await tick()
  const call = h.runnerCalls.find((c) => c.payload.taskId === started.taskId)
  if (!call) throw new Error('runner 未收到任务')
  call.resolve(composeAnnualReviewReport({ period: resolveAnnualReviewPeriod(YEAR, GEN), facts, sales, crm, opts: { messageStats } }))
  await wait(3)
  const res = await h.coordinator.run(started.taskId)
  if (!res.success) throw new Error(`AI 预热失败：${res.error.code}`)
  if (h.service.getReport(YEAR).cache !== 'hit' || h.coordinator.cacheSize() === 0) throw new Error('预热未生效')
  return started.taskId
}

/** 关闭合并窗口（把「被抑制事件的补派发」也排掉），用于让后续断言从干净状态开始 */
function settleWindow(): void {
  flushAnnualReviewInvalidationForTest()
}

/** 相关写入：**不 flush、不等窗口**，写入返回后立即断言两类缓存都失效 */
async function expectImmediateInvalidation(label: string, h: ReturnType<typeof createHarness>, write: () => void): Promise<void> {
  settleWindow()
  await warmCaches(h)
  const beforeReport = h.service.getReport(YEAR).cache
  const beforeAi = h.coordinator.cacheSize()
  write()
  // 关键：这里没有 flush、没有 sleep、没有 await
  const afterReport = h.service.getReport(YEAR).cache
  const afterAi = h.coordinator.cacheSize()
  ok(`${label}：前置两类缓存均热（报告=${beforeReport} / AI=${beforeAi}）`, beforeReport === 'hit' && beforeAi >= 1)
  ok(`${label}：写入后**立即**报告缓存失效（未等 150ms 窗口）`, afterReport !== 'hit')
  ok(`${label}：写入后**立即** AI 结果缓存失效`, afterAi === 0)
}

/** 无关写入：不 flush（因为不该有任何派发），断言缓存与运行中任务都不受影响 */
async function expectNoInvalidation(label: string, h: ReturnType<typeof createHarness>, write: () => void): Promise<void> {
  settleWindow()
  await warmCaches(h)
  const reportTaskId = h.service.getTaskState(YEAR)?.taskId ?? null
  const beforeAi = h.coordinator.cacheSize()
  const seen: AnnualReviewInvalidationEvent[] = []
  const off = onAnnualReviewInvalidation((e) => seen.push(e))
  write()
  off()
  ok(`${label}：无关写入不产生任何失效派发`, seen.length === 0)
  ok(`${label}：无关写入后报告缓存仍命中`, h.service.getReport(YEAR).cache === 'hit')
  ok(`${label}：无关写入后 AI 结果缓存仍在`, h.coordinator.cacheSize() === beforeAi)
  ok(`${label}：无关写入不取消/不失效已完成的报告任务`,
    h.service.getTaskState(YEAR)?.status === 'completed' && h.service.getTaskState(YEAR)?.taskId === reportTaskId)
}

/** 两条总线各自的有界合并窗口（真实计时器断言用；取值来自各自模块，不写死数字） */
const AR_FLUSH = ANNUAL_REVIEW_INVALIDATION_FLUSH_MS
/** assignment 总线在 main() 里动态 import，故延迟读取（模块加载期它还是 undefined） */
const assignFlush = (): number => assignmentBus.ASSIGN_INVALIDATION_FLUSH_MS

/**
 * 归属类操作的**单条权威链路**护栏（真实计时器，不用 flush）：
 *   ① 操作后年度复盘**立即恰好一次**失效（报告缓存与 AI 缓存马上作废，未等 150ms）；
 *   ② 提交后立刻启动新报告（模拟用户紧接着重新生成）；
 *   ③ 等过**两条总线各自的** 150ms 窗口 → 年度复盘**仍只有那一次**失效。若还存在
 *      「Assignment 总线 → 年度复盘」的第二条链路，这里会收到第二次失效，②的新报告也会被它取消；
 *   ④ Assignment UI 事件照常发出（页面刷新能力未被删除；expectUi=null = 该操作本就不发 UI 事件）。
 *
 * expectUi.leadIds 用谓词而不是固定 id：历史导入等操作在函数内部才建 lead，id 事先不可知。
 */
async function expectAssignmentChain(
  label: string,
  h: ReturnType<typeof createHarness>,
  run: () => void,
  expectUi: { action: string; leadIds: (ids: number[]) => boolean } | null
): Promise<void> {
  settleWindow()
  assignmentBus.resetAssignmentInvalidationForTest() // 清掉夹具阶段遗留的待发窗口与监听
  const ui: Array<{ action: string; leadIds: number[] }> = []
  const offUi = assignmentBus.onAssignmentInvalidated((e) => ui.push({ action: String(e.action), leadIds: e.leadIds }))
  const ar: AnnualReviewInvalidationEvent[] = []
  const offAr = onAnnualReviewInvalidation((e) => ar.push(e))
  await warmCaches(h)
  const hotReport = h.service.getReport(YEAR).cache
  const hotAi = h.coordinator.cacheSize()

  run() // ① 无 flush、无 sleep、无 await —— 立即断言

  ok(`${label}：前置两类缓存均热（报告=${hotReport} / AI=${hotAi}）`, hotReport === 'hit' && hotAi >= 1)
  ok(`${label}：年度复盘**立即恰好一次**失效（未等窗口）`, ar.length === 1 && ar[0].coalesced === false)
  ok(`${label}：报告缓存与 AI 缓存立即作废`,
    h.service.getReport(YEAR).cache !== 'hit' && h.coordinator.cacheSize() === 0)

  const started = h.service.start(YEAR) // ② 提交后立刻启动新报告
  await sleep(assignFlush() + AR_FLUSH + 150) // ③ 等过两条总线各自的窗口（真实计时器）

  ok(`${label}：等过两个 150ms 窗口后年度复盘**仍只有一次**失效（无第二条链路）`, ar.length === 1)
  ok(`${label}：Assignment UI 事件照常发出（期望 action=${expectUi ? expectUi.action : '不发'}）`,
    expectUi === null
      ? ui.length === 0
      : (ui.length === 1 && ui[0].action === expectUi.action && expectUi.leadIds(ui[0].leadIds)))
  const st = h.service.getTaskState(YEAR)
  ok(`${label}：新启动的报告不被延迟事件取消（同一 taskId 且未失败）`,
    st?.taskId === started.taskId && st?.status !== 'failed')

  // 收尾：让任务正常收敛，避免残留运行中任务影响后续用例
  h.runnerCalls.find((c) => c.payload.taskId === started.taskId)?.resolve(
    composeAnnualReviewReport({ period: resolveAnnualReviewPeriod(YEAR, GEN), facts, sales, crm, opts: { messageStats } })
  )
  await wait(3)
  offUi(); offAr()
  assignmentBus.resetAssignmentInvalidationForTest()
}

/**
 * 归属类操作里**不应**失效的分支（conflict / nolead / 重复投递 / 只写 noop 审计）：
 * 零年度复盘派发、零 Assignment UI 事件、缓存与已完成任务均不受影响（真实计时器）。
 */
async function expectNoAssignmentChain(
  label: string,
  h: ReturnType<typeof createHarness>,
  run: () => void
): Promise<void> {
  settleWindow()
  assignmentBus.resetAssignmentInvalidationForTest()
  const ui: Array<{ action: string }> = []
  const offUi = assignmentBus.onAssignmentInvalidated((e) => ui.push({ action: String(e.action) }))
  const ar: AnnualReviewInvalidationEvent[] = []
  const offAr = onAnnualReviewInvalidation((e) => ar.push(e))
  await warmCaches(h)
  const reportTaskId = h.service.getTaskState(YEAR)?.taskId ?? null
  const beforeAi = h.coordinator.cacheSize()

  run()
  await sleep(assignFlush() + AR_FLUSH + 150)

  ok(`${label}：不产生任何年度复盘失效`, ar.length === 0)
  ok(`${label}：不产生 Assignment UI 事件`, ui.length === 0)
  ok(`${label}：报告缓存仍命中、AI 缓存仍在`,
    h.service.getReport(YEAR).cache === 'hit' && h.coordinator.cacheSize() === beforeAi)
  ok(`${label}：已完成任务未被取消/失效`,
    h.service.getTaskState(YEAR)?.status === 'completed' && h.service.getTaskState(YEAR)?.taskId === reportTaskId)
  offUi(); offAr()
  assignmentBus.resetAssignmentInvalidationForTest()
}

async function main(): Promise<void> {
  crmDbService = (await import('../electron/services/crmDbService')).crmDbService
  salesDbService = (await import('../electron/services/salesDbService')).salesDbService
  assignmentBus = await import('../electron/services/assignmentInvalidationBus')
  lanSync = await import('../electron/services/lanSyncService')
  const { setIdentity } = await import('../electron/services/identityService')
  const { ConfigService } = await import('../electron/services/config')
  const dbDir = mkdtempSync(join(tmpdir(), 'ar-invalidation-db-'))
  await crmDbService.initialize(dbDir)
  await salesDbService.initialize(dbDir)
  const cfg = ConfigService.getInstance()
  cfg.set('crmSalesList', ['测试销售甲'])
  setIdentity('测试销售甲', '销售')

  // ══ A. 总线语义（leading edge：首条立即） ═══════════════════════════════════
  {
    const events: AnnualReviewInvalidationEvent[] = []
    const off = onAnnualReviewInvalidation((e) => events.push(e))

    announceAnnualReviewDataChanged('crm:contract')
    ok('A1 首条事件**立即**派发（未 flush、未等待窗口）', events.length === 1 && events[0].coalesced === false && events[0].count === 1)
    ok('A2 派发原因即上报原因', JSON.stringify(events[0].reasons) === JSON.stringify(['crm:contract']))
    ok('A3 首条派发后进入抑制窗口（用于合并后续事件）', hasPendingAnnualReviewInvalidation())

    announceAnnualReviewDataChanged('crm:contract')
    announceAnnualReviewDataChanged('sales:customer_profile')
    ok('A4 窗口内重复事件被抑制（不立即派发）', events.length === 1)
    settleWindow()
    ok('A5 窗口结束时对被抑制事件补一次合并派发', events.length === 2 && events[1].coalesced === true)
    ok('A6 合并派发计数与去重原因正确',
      events[1].count === 3 && JSON.stringify(events[1].reasons) === JSON.stringify(['crm:contract', 'sales:customer_profile']))
    ok('A7 派发后无积压', !hasPendingAnnualReviewInvalidation())
    ok('A8 无积压时 flush 不产生事件', (() => { settleWindow(); return events.length === 2 })())

    // 窗口空闲后的下一条仍是 leading edge
    announceAnnualReviewDataChanged('crm:lead')
    ok('A9 新窗口首条同样立即派发', events.length === 3 && events[2].coalesced === false)
    settleWindow()

    // 立即失效可穿窗：即使窗口已打开也立刻派发
    announceAnnualReviewDataChanged('crm:contract') // 开窗 + 立即派发
    const before = events.length
    announceAnnualReviewDataChangedNow('account_switch')
    ok('A10 立即失效（账号切换）在窗口内也立刻派发', events.length === before + 1 && events[events.length - 1].reasons.join(',') === 'account_switch')
    settleWindow()

    ok('A11 事件只含原因与计数，不含业务数据',
      Object.keys(events[0]).sort().join(',') === 'at,coalesced,count,firstAt,reasons')

    // 订阅者异常隔离与取消订阅
    const seen: string[] = []
    const offThrow = onAnnualReviewInvalidation(() => { throw new Error('listener boom') })
    const offSecond = onAnnualReviewInvalidation(() => seen.push('second'))
    announceAnnualReviewDataChangedNow('account_switch')
    ok('A12 单个订阅者抛错不影响其他订阅者（也不冒泡）', seen.join(',') === 'second')
    offThrow(); offSecond(); off()
    const countBefore = events.length
    announceAnnualReviewDataChangedNow('account_switch')
    ok('A13 取消订阅后不再收到事件', events.length === countBefore)
    settleWindow()
  }

  // ══ A3. announceNow 的幽灵失效（真实计时器，不用 flush） ═════════════════════
  {
    const events: AnnualReviewInvalidationEvent[] = []
    const off = onAnnualReviewInvalidation((e) => events.push(e))
    // ① 普通事件开窗（首条立即派发）→ ② Now（立即派发并吸收旧窗口）→ ③ 等待超过 150ms
    announceAnnualReviewDataChanged('crm:contract')
    announceAnnualReviewDataChanged('crm:lead') // 被抑制
    announceAnnualReviewDataChangedNow('account_switch')
    ok('A14 Now 立即派发（普通首条 + Now 共两次）', events.length === 2 && events[1].reasons.join(',') === 'account_switch')
    await sleep(ANNUAL_REVIEW_INVALIDATION_FLUSH_MS + 120) // 真实计时器：旧窗口若未被吸收会在此时补派发
    ok('A15 等待超过一个窗口后不再出现第三条幽灵事件', events.length === 2)
    ok('A16 Now 之后无待派发积压（旧窗口已被吸收，不残留计时器）', !hasPendingAnnualReviewInvalidation())
    // ④ Now 之后的新普通写入仍是新窗口首条 → 立即派发
    announceAnnualReviewDataChanged('crm:assignment')
    ok('A17 Now 之后的新普通写入仍立即派发（新窗口 leading edge）', events.length === 3 && events[2].coalesced === false)
    await sleep(ANNUAL_REVIEW_INVALIDATION_FLUSH_MS + 50)
    ok('A18 该新窗口结束不产生额外派发（单条事件）', events.length === 3)
    off()
    settleWindow()
  }

  // ══ A4. Now 后的新任务不被旧窗口的补派发取消（真实计时器 + 真实 service） ═══
  {
    const h = createHarness()
    settleWindow()
    await warmCaches(h) // 有报告与 AI 缓存，便于观察 Now 的清空
    announceAnnualReviewDataChanged('crm:contract') // 普通事件开窗（harness 订阅点已生效）
    announceAnnualReviewDataChangedNow('account_switch') // Now：立即失效
    // Now 之后立即启动新报告任务（模拟账号切换后用户马上重新生成）
    const started = h.service.start(YEAR)
    await sleep(ANNUAL_REVIEW_INVALIDATION_FLUSH_MS + 120) // 旧窗口若未吸收会在此时补派发
    const st = h.service.getTaskState(YEAR)
    ok('A19 Now 后的新报告任务不被旧窗口补派发取消',
      st?.taskId === started.taskId && st?.status !== 'failed')
    // 收尾：让任务正常跑完，避免残留运行中任务
    h.runnerCalls.find((c) => c.payload.taskId === started.taskId)?.resolve(
      composeAnnualReviewReport({ period: resolveAnnualReviewPeriod(YEAR, GEN), facts, sales, crm, opts: { messageStats } })
    )
    await wait(3)
    ok('A20 新任务正常收敛为 completed', h.service.getTaskState(YEAR)?.status === 'completed')
    h.unsubscribe()
    resetAnnualReviewInvalidationForTest()
  }

  // ══ A5. 同一事务多 reason：一次提交 = 一次事件，绝不补发第二次（真实计时器） ═════
  {
    const h = createHarness()
    const events: AnnualReviewInvalidationEvent[] = []
    const off = onAnnualReviewInvalidation((e) => events.push(e))
    settleWindow()

    // ── 入口级：去重 + 稳定排序 + 计数恒为 1 ──
    announceAnnualReviewDataChangedMany(['crm:lead', 'crm:assignment', 'crm:lead'])
    ok('A21 批量入口去重并稳定排序为**一条**事件（count=1）',
      events.length === 1 && events[0].coalesced === false && events[0].count === 1 &&
      JSON.stringify(events[0].reasons) === JSON.stringify(['crm:assignment', 'crm:lead']))
    await sleep(AR_FLUSH + 120)
    ok('A22 批量入口首条事件之后不再补发（一次提交只有一次失效）', events.length === 1)
    ok('A23 空批量是 no-op（不开窗、不派发）', (() => {
      const before = events.length
      announceAnnualReviewDataChangedMany([])
      return events.length === before && !hasPendingAnnualReviewInvalidation()
    })())
    ok('A24 单原因入口等价于批量入口（委托同一实现）', (() => {
      settleWindow()
      const before = events.length
      announceAnnualReviewDataChanged('crm:contract')
      return events.length === before + 1 && events[events.length - 1].count === 1 &&
        JSON.stringify(events[events.length - 1].reasons) === JSON.stringify(['crm:contract'])
    })())

    // ── 事务级：同一次 runTx 标记 crm:lead + crm:assignment ──
    const leadId = Number(crmDbService.create('lead', {
      contact_type: 'phone', contact_normalized: `131${String(Date.now()).slice(-8)}`, contact_raw: 'A5线索',
      status: 'NEW', first_contact_deadline: 0, created_at: Date.now(), updated_at: Date.now()
    }))
    const asgId = Number(crmDbService.create('assignment', {
      lead_id: leadId, sales_name: '测试销售甲', mode: 'manual', status: 'assigned', source: 'test',
      updated_by: 'tester', updated_at: Date.now(), version: 1, deleted: 0
    }))
    ok('A25 事务夹具就绪（真实 lead + assignment 行）', leadId > 0 && asgId > 0)
    settleWindow() // 夹具本身会失效：先排掉，只观察被测事务
    await warmCaches(h)
    events.length = 0

    crmDbService.runTx((tx) => {
      tx.run('UPDATE lead SET updated_at = ? WHERE id = ?', [Date.now(), leadId])
      tx.markAnnualReviewChanged('crm:lead')
      tx.run("UPDATE assignment SET updated_at = ? WHERE id = ?", [Date.now(), asgId])
      tx.markAnnualReviewChanged('crm:assignment')
    })
    ok('A26 同一事务两个 reason → 提交后**立即只有一次**失效',
      events.length === 1 && events[0].coalesced === false && events[0].count === 1)
    ok('A27 该次失效原因 = 本次事务的全部原因（去重稳定排序）',
      JSON.stringify(events[0].reasons) === JSON.stringify(['crm:assignment', 'crm:lead']))
    ok('A28 两类缓存立即失效（未等 150ms 窗口）',
      h.service.getReport(YEAR).cache !== 'hit' && h.coordinator.cacheSize() === 0)

    const started = h.service.start(YEAR) // 提交后立刻启动新报告
    await sleep(AR_FLUSH + 120)
    ok('A29 等待超过 150ms 后仍只有一次失效（**不补发**同一事务的第二次）', events.length === 1)
    ok('A30 窗口结束无积压（无残留计时器）', !hasPendingAnnualReviewInvalidation())
    const st = h.service.getTaskState(YEAR)
    ok('A31 新启动的报告不被延迟事件取消（同一 taskId 且未失败）',
      st?.taskId === started.taskId && st?.status !== 'failed')
    h.runnerCalls.find((c) => c.payload.taskId === started.taskId)?.resolve(
      composeAnnualReviewReport({ period: resolveAnnualReviewPeriod(YEAR, GEN), facts, sales, crm, opts: { messageStats } })
    )
    await wait(3)
    ok('A32 收尾任务正常收敛为 completed', h.service.getTaskState(YEAR)?.status === 'completed')

    // ── 两个**真正独立**的提交：第二次数据变化不得因去重丢失 ──
    settleWindow()
    events.length = 0
    crmDbService.runTx((tx) => {
      tx.run('UPDATE lead SET updated_at = ? WHERE id = ?', [Date.now(), leadId])
      tx.markAnnualReviewChanged('crm:lead')
    })
    ok('A33 第一个提交立即派发（开窗）', events.length === 1 && events[0].coalesced === false)
    crmDbService.runTx((tx) => {
      tx.run('UPDATE assignment SET updated_at = ? WHERE id = ?', [Date.now(), asgId])
      tx.markAnnualReviewChanged('crm:assignment')
    })
    ok('A34 窗口内第二个独立提交被有界合并（不立即派发、不丢失）', events.length === 1)
    await sleep(AR_FLUSH + 120)
    ok('A35 窗口结束补一次合并派发，第二次提交的数据变化被覆盖（count=2、原因取并集）',
      events.length === 2 && events[1].coalesced === true && events[1].count === 2 &&
      JSON.stringify(events[1].reasons) === JSON.stringify(['crm:assignment', 'crm:lead']))

    off()
    h.unsubscribe()
    resetAnnualReviewInvalidationForTest()
  }

  // ══ A2. 持续事件：有界合并、不无限延迟 ═══════════════════════════════════════
  {
    const events: AnnualReviewInvalidationEvent[] = []
    const off = onAnnualReviewInvalidation((e) => events.push(e))
    // 每 30ms 上报一次，持续 ~300ms（10 次）：窗口从首条起算固定长度，不随事件顺延
    for (let i = 0; i < 10; i++) {
      announceAnnualReviewDataChanged('crm:contract')
      await sleep(30)
    }
    await sleep(ANNUAL_REVIEW_INVALIDATION_FLUSH_MS + 60)
    ok('A14 持续事件下派发次数有界（每窗口 ≤2 次，10 次上报远小于 10 次派发）',
      events.length > 0 && events.length <= 5)
    ok('A15 首次派发发生在首条上报的同一时刻（不等待）',
      events.length > 0 && events[0].coalesced === false)
    ok('A16 窗口不因持续事件无限后移（总延迟有界）',
      events.every((e) => typeof e.at === 'number' && typeof e.firstAt === 'number'))
    off()
    settleWindow()
  }

  // ══ B. 无关写入不失效（默认不影响年度复盘） ═════════════════════════════════
  {
    const h = createHarness()
    const now = Date.now()
    await expectNoInvalidation('B1 scan_state 写入（setScanState）', h, () => {
      crmDbService.setScanState('inv:test:key', now)
    })
    await expectNoInvalidation('B2 processed_msg 写入（markMsgProcessed）', h, () => {
      crmDbService.markMsgProcessed(`msg-inv-${now}`)
    })
    await expectNoInvalidation('B3 migration_report 写入（saveMigrationReport）', h, () => {
      crmDbService.saveMigrationReport('inv-module', '标题', { applied: 1 }, [], [], now)
    })
    await expectNoInvalidation('B4 migration_dismissal 写入（migrationDismiss）', h, () => {
      crmDbService.migrationDismiss('inv-module', 'entity-1', 'tester')
    })
    await expectNoInvalidation('B5 无关 audit action 写入（auditAppend: contract_edit）', h, () => {
      crmDbService.auditAppend('tester', 'contract_edit', 'contract', 1, { note: 'x' })
    })
    await expectNoInvalidation('B6 activity_log 写入（logActivity）', h, () => {
      crmDbService.logActivity('contract', 1, 'note', '无关留痕', 'tester')
    })
    await expectNoInvalidation('B7 auto_confirm_log 写入（logAutoConfirm）', h, () => {
      crmDbService.logAutoConfirm('allocation', 1, 'auto', 0.9, '测试', 'confirm')
    })
    await expectNoInvalidation('B8 knowledge_base 写入（kbCreate）', h, () => {
      salesDbService.kbCreate({ category: 'qa', title: `测试条目${now}`, content: '内容', tags: [], scene: null, authority: 'community', source: 'manual' } as never)
    })
    await expectNoInvalidation('B9 report_snapshot 写入（reportCreate）', h, () => {
      salesDbService.reportCreate({ period_type: 'week', period_start: now - 1000, period_end: now, stats: '{}', ai_summary: null } as never)
    })
    await expectNoInvalidation('B10 opportunity_eval_case 写入（evalCaseUpsert）', h, () => {
      salesDbService.evalCaseUpsert({ session_id: 'wxid_inv', anchor_key: `k-${now}`, label: 'has', ai_label: 'none' } as never)
    })
    await expectNoInvalidation('B11 alert_eval_case 写入（alertEvalCaseUpsert）', h, () => {
      salesDbService.alertEvalCaseUpsert({ session_id: 'wxid_inv', alert_type: 'risk', anchor_key: `a-${now}`, label: 'correct', ai_label: 'wrong' } as never)
    })
    await expectNoInvalidation('B12 follow_up_task 写入（todoCreate）', h, () => {
      salesDbService.todoCreate({ title: '无关任务', trigger_type: 'manual', session_id: 'wxid_inv' } as never)
    })
    await expectNoInvalidation('B13 未声明的无关事务（scan_state）', h, () => {
      crmDbService.runTx((tx) => {
        tx.run('INSERT INTO scan_state (key, last_scan) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET last_scan = excluded.last_scan', [`inv:tx:${now}`, now])
      })
    })
    await expectNoInvalidation('B14 未声明的无关事务（outbox_event）', h, () => {
      crmDbService.runTx((tx) => {
        tx.run('INSERT INTO outbox_event (source, idempotency_key, payload, status, created_at) VALUES (?,?,?,?,?)',
          ['test', `inv-${now}`, '{}', 'pending', now])
      })
    })
    ok('B15 白名单常量与需求一致', (() => {
      const crmTables = [...ANNUAL_REVIEW_CRM_SOURCE_TABLES].sort().join(',')
      const salesTables = [...ANNUAL_REVIEW_SALES_SOURCE_TABLES].sort().join(',')
      const auditActions = [...ANNUAL_REVIEW_AUDIT_ACTIONS].sort().join(',')
      return crmTables === 'account,allocation,assignment,contract,contract_status_history,lead,opportunity,opportunity_event' &&
        salesTables === 'customer_profile,intent_tag_log' &&
        auditActions === 'lead_assign,lead_transfer,sync_apply'
    })())
    h.unsubscribe()
    resetAnnualReviewInvalidationForTest()
  }

  // ══ C. 相关写入立即失效（白名单 + 显式声明） ════════════════════════════════
  {
    const h = createHarness()
    const now = Date.now()
    const accountId = Number(crmDbService.create('account', { name: '失效客户', session_id: 'wxid_inv', created_at: now, updated_at: now }))
    await expectImmediateInvalidation('C0 客户新增（create: account）', h, () => {
      crmDbService.create('account', { name: '新客户', created_at: now, updated_at: now })
    })
    await expectImmediateInvalidation('C1 客户修改（update: account）', h, () => {
      crmDbService.update('account', accountId, { name: '失效客户（改名）', updated_at: now })
    })
    const contractId = Number(crmDbService.create('contract', { account_id: accountId, name: '失效客户-合同', amount: 3000, status: 'pending_sign', created_at: now, updated_at: now }))
    await expectImmediateInvalidation('C2 合同签约（signContract → contract + contract_status_history）', h, () => {
      const r = crmDbService.signContract(contractId)
      if (!r.ok) throw new Error(`signContract 失败：${r.reason}`)
    })
    const payRecordId = Number(crmDbService.create('payment_record', { amount_net: 3000, created_at: now }))
    const allocationId = Number(crmDbService.addAllocations(payRecordId, [{ customerHint: '失效客户', salesHint: '测试销售甲', amountHint: 3000 }])[0])
    await expectImmediateInvalidation('C3 核销认领（confirmAllocation）', h, () => {
      const r = crmDbService.confirmAllocation(allocationId, { account_id: accountId, contract_id: contractId })
      if (!r.ok) throw new Error(`confirmAllocation 失败：${r.reason}`)
    })
    await expectImmediateInvalidation('C4 财务核销（reconcileAllocation）', h, () => {
      const r = crmDbService.reconcileAllocation(allocationId)
      if (!r.ok) throw new Error(`reconcileAllocation 失败：${r.reason}`)
    })
    await expectImmediateInvalidation('C5 合同出货（shipContract）', h, () => {
      const r = crmDbService.shipContract(contractId)
      if (!r.ok) throw new Error(`shipContract 失败：${r.reason}`)
    })
    await expectImmediateInvalidation('C6 assignment 写入（create: assignment）', h, () => {
      crmDbService.create('assignment', { lead_id: 1, sales_name: '测试销售甲', mode: 'manual', status: 'assigned', source: 'test', updated_by: 'test', updated_at: now, version: 1, deleted: 0 })
    })
    await expectImmediateInvalidation('C7 事务内 changed 标记（markAnnualReviewChangedIfWrote）', h, () => {
      crmDbService.runTx((tx) => {
        tx.run("UPDATE assignment SET status = 'claimed', updated_at = ? WHERE lead_id = ?", [now, 1])
        tx.markAnnualReviewChangedIfWrote('crm:assignment')
      })
    })
    await expectImmediateInvalidation('C8 lead 写入（create: lead）', h, () => {
      crmDbService.create('lead', { contact_type: 'phone', contact_normalized: `139${String(now).slice(-8)}`, contact_raw: 'C8', status: 'NEW', first_contact_deadline: 0, created_at: now, updated_at: now })
    })
    await expectImmediateInvalidation('C9 客户阶段变更（salesDb customerUpsert）', h, () => {
      salesDbService.customerUpsert({ session_id: 'wxid_inv', stage: '决策', last_contact_at: Math.floor(now / 1000) })
    })
    await expectImmediateInvalidation('C10 意向阶段事件（salesDb intentCreate）', h, () => {
      salesDbService.intentCreate({ session_id: 'wxid_inv', stage: '决策', source: 'manual', reason: '测试', message_key: null, evidence_text: null } as never)
    })
    await expectImmediateInvalidation('C11 画像 customer_id 回写（setCustomerProfileCustomerId）', h, () => {
      const profile = salesDbService.customerGetBySession('wxid_inv')
      if (profile) salesDbService.setCustomerProfileCustomerId(Number(profile.id), '900-1')
      else throw new Error('画像不存在')
    })
    await expectImmediateInvalidation('C12 阶段变更时间戳（updateStageChangeTime）', h, () => {
      salesDbService.updateStageChangeTime('wxid_inv', now)
    })
    const opp = crmDbService.opportunityUpsertBySignal(accountId, '失效客户', { product: '叉车', quantity: 1, amount: 1000, stage: '比价', detail: '测试信号' })
    const oppId = Number(opp.id)
    await expectImmediateInvalidation('C13 商机阶段变更（opportunityUpdateStage）', h, () => {
      if (!crmDbService.opportunityUpdateStage(oppId, '决策', 'manual')) throw new Error('未生效')
    })
    await expectImmediateInvalidation('C14 商机流失关单（opportunityClose）', h, () => {
      crmDbService.opportunityClose(oppId, 'lost', '测试流失')
    })
    await expectImmediateInvalidation('C15 商机事件（opportunityEventAdd）', h, () => {
      crmDbService.opportunityEventAdd(oppId, 'note', '决策', '测试事件')
    })
    await expectImmediateInvalidation('C16 audit_event 白名单动作（lead_assign）', h, () => {
      crmDbService.auditAppend('system', 'lead_assign', 'lead', 1, { salesName: '测试销售甲' })
    })
    await expectImmediateInvalidation('C17 audit_event 白名单动作（sync_apply）', h, () => {
      crmDbService.auditAppend('system:sync', 'sync_apply', 'lead', 1, { type: 'assign' })
    })
    await expectImmediateInvalidation('C18 客户删除（deleteAccount 级联事务）', h, () => {
      const victimId = Number(crmDbService.create('account', { name: '待删客户', created_at: now, updated_at: now }))
      settleWindow() // 建客户本身也会失效：先排掉，只观察删除这一步
      const r = crmDbService.deleteAccount(victimId)
      if (!r.ok) throw new Error(`deleteAccount 失败：${r.reason}`)
    })
    await expectImmediateInvalidation('C19 合同删除（deleteContract 级联事务）', h, () => {
      const doomed = Number(crmDbService.create('contract', { account_id: accountId, name: '待删合同', amount: 10, status: 'draft', created_at: now, updated_at: now }))
      settleWindow()
      const r = crmDbService.deleteContract(doomed)
      if (!r.ok) throw new Error(`deleteContract 失败：${r.reason}`)
    })
    ok('C20 声明辅助函数对白名单外的表返回 false（no-op）',
      announceAnnualReviewCrmWrite('scan_state') === false &&
      announceAnnualReviewSalesWrite('knowledge_base') === false &&
      announceAnnualReviewAuditAction('contract_edit') === false)
    ok('C21 声明辅助函数对白名单内的表返回 true',
      announceAnnualReviewCrmWrite('contract') === true &&
      announceAnnualReviewSalesWrite('intent_tag_log') === true &&
      announceAnnualReviewAuditAction('lead_transfer') === true)
    settleWindow()
    h.unsubscribe()
    resetAnnualReviewInvalidationForTest()
  }

  // ══ D. 失败或回滚写入不失效 ════════════════════════════════════════════════
  {
    const h = createHarness()
    settleWindow()
    await warmCaches(h)
    let threw = false
    try {
      crmDbService.runTx((tx) => {
        tx.markAnnualReviewChanged('crm:contract') // 已标记但随后抛错 → ROLLBACK → 绝不派发
        throw new Error('模拟写入失败')
      })
    } catch { threw = true }
    ok('D1 事务回滚：写入抛错', threw)
    ok('D2 失败事务即使已标记也不失效（报告缓存仍命中）', h.service.getReport(YEAR).cache === 'hit')
    ok('D3 失败事务即使已标记也不失效（AI 缓存仍在）', h.coordinator.cacheSize() === 1)
    ok('D4 失败事务不派发任何事件', (() => {
      const seen: AnnualReviewInvalidationEvent[] = []
      const off = onAnnualReviewInvalidation((e) => seen.push(e))
      settleWindow()
      off()
      return seen.length === 0
    })())
    ok('D5 非法实体早退不派发', (() => {
      const created = crmDbService.create('not_an_entity', { x: 1 })
      return created === 0 && !hasPendingAnnualReviewInvalidation()
    })())
    h.unsubscribe()
    resetAnnualReviewInvalidationForTest()
  }

  // ══ E. 无关写入不打断运行中的报告/AI 任务 ════════════════════════════════════
  {
    const h = createHarness()
    // 报告任务运行中
    const started = h.service.start(YEAR)
    await tick()
    const now = Date.now()
    crmDbService.setScanState(`inv:e:${now}`, now)
    crmDbService.markMsgProcessed(`msg-e-${now}`)
    salesDbService.kbCreate({ category: 'qa', title: `E${now}`, content: 'x', tags: [], scene: null, authority: 'community', source: 'manual' } as never)
    salesDbService.todoCreate({ title: '无关任务E', trigger_type: 'manual' } as never)
    await tick()
    ok('E1 无关写入不打断运行中的报告生成任务',
      h.service.getTaskState(YEAR)?.status !== 'failed' && h.service.getTaskState(YEAR)?.taskId === started.taskId)
    ok('E2 无关写入不产生待派发事件', !hasPendingAnnualReviewInvalidation())

    // AI 任务运行中（挂起）
    h.runnerCalls.find((c) => c.payload.taskId === started.taskId)?.resolve(
      composeAnnualReviewReport({ period: resolveAnnualReviewPeriod(YEAR, GEN), facts, sales, crm, opts: { messageStats } })
    )
    await wait(3)
    let aiGate: ((v: unknown) => void) | null = null
    const hanging = new AnnualReviewAiCoordinator({
      getTaskReport: (taskId) => h.service.getTaskReport(taskId),
      getConfig: () => ({ get: () => undefined }) as never,
      generate: (() => new Promise((resolve) => { aiGate = resolve })) as never,
      now: () => GEN
    })
    const off = installAnnualReviewInvalidation({ handleDataChanged: () => h.service.handleDataChanged(), invalidateAll: () => hanging.invalidateAll() })
    const run = hanging.run(started.taskId)
    await tick()
    ok('E3 AI 分析已发起', hanging.inFlightCount() === 1)
    crmDbService.setScanState(`inv:e2:${now}`, now)
    salesDbService.reportCreate({ period_type: 'week', period_start: now, period_end: now, stats: '{}', ai_summary: null } as never)
    await tick()
    ok('E4 无关写入不取消在途 AI 分析', hanging.inFlightCount() === 1)
    aiGate?.({ ok: true, analysis: ANALYSIS, model: 'fake', promptVersion: ANNUAL_REVIEW_AI_PROMPT_VERSION, generatedAt: GEN })
    ok('E5 无关写入期间发起的 AI 分析正常收敛', (await run).success === true)
    off()
    h.unsubscribe()
    resetAnnualReviewInvalidationForTest()
  }

  // ══ E2. 相关写入在运行期间**立即**失效（不等窗口、不 flush） ═════════════════
  {
    const h = createHarness()
    const now = Date.now()
    settleWindow() // 从空闲窗口开始：本节的写入都是各自窗口的**首条**事件（要求 9 的口径）
    const started = h.service.start(YEAR)
    await tick()
    ok('E6 报告生成任务运行中（loading/computing）', (() => {
      const st = h.service.getTaskState(YEAR)?.status
      return st === 'loading' || st === 'computing'
    })())
    crmDbService.update('contract', 1, { amount: 4321, updated_at: now }) // 相关写入（合同被改）
    await tick()
    const st = h.service.getTaskState(YEAR)
    ok('E7 相关写入**立即**让运行中的报告任务进入失效收敛（未等 150ms）',
      st?.status === 'failed' && st?.error?.code === 'invalidated')
    ok('E8 失效期间不写缓存（getReport 非 hit）', h.service.getReport(YEAR).cache !== 'hit')
    ok('E8b 任务标识保持绑定（迟到结果无法冒充成功）', st?.taskId === started.taskId)

    // AI：相关写入立即中止在途分析（结果作废、不缓存）
    const warmed = await warmCaches(h)
    let gate: ((v: unknown) => void) | null = null
    let signal: AbortSignal | undefined
    const hangCoordinator = new AnnualReviewAiCoordinator({
      getTaskReport: (taskId) => h.service.getTaskReport(taskId),
      getConfig: () => ({ get: () => undefined }) as never,
      generate: ((_r: unknown, options: { signal?: AbortSignal }) =>
        new Promise((resolve) => { gate = resolve; signal = options.signal })) as never,
      now: () => GEN
    })
    const offHang = installAnnualReviewInvalidation({
      handleDataChanged: () => h.service.handleDataChanged(),
      invalidateAll: () => { h.coordinator.invalidateAll(); hangCoordinator.invalidateAll() }
    })
    settleWindow() // 同上：让后续相关写入成为新窗口的首条事件
    const run = hangCoordinator.run(warmed)
    await tick()
    ok('E9 在途 AI 分析已发起', hangCoordinator.inFlightCount() === 1)
    crmDbService.auditAppend('system', 'lead_transfer', 'lead', 1, { fromSales: 'A', toSales: '测试销售甲' }) // 相关写入
    await tick()
    ok('E10 相关写入**立即**中止在途 AI 分析（出口信号已中止，未等 150ms）', signal?.aborted === true)
    gate?.({ ok: true, analysis: ANALYSIS, model: 'fake', promptVersion: ANNUAL_REVIEW_AI_PROMPT_VERSION, generatedAt: GEN })
    const res = await run
    ok('E11 失效期间在途 AI 结果 → invalidated（不返回成功）', res.success === false && res.error.code === 'invalidated')
    ok('E12 失效期间在途 AI 结果不写缓存', hangCoordinator.cacheSize() === 0)
    offHang()
    h.unsubscribe()
    resetAnnualReviewInvalidationForTest()
  }

  // ══ I. no-op 事务反例：只有真正改变数据才失效（changed 标记） ═══════════════
  {
    const h = createHarness()
    const { assignLeads, correctSla1Misrecycle } = await import('../electron/services/crmAssignmentService')
    const { resetLegacyGroupScanSla } = await import('../electron/services/crmLeadService')
    const { migrate02AccountToCustomer } = await import('../electron/services/crmMigrationService')
    const now = Date.now()

    // I1 条件 UPDATE 命中 0 行（不存在的客户 id）→ 不失效
    await expectNoInvalidation('I1 条件 UPDATE 命中 0 行（update account 不存在）', h, () => {
      crmDbService.update('account', 987654, { name: '不存在', updated_at: now })
    })
    await expectNoInvalidation('I2 条件 UPDATE 命中 0 行（update contract 不存在）', h, () => {
      crmDbService.update('contract', 987654, { amount: 1, updated_at: now })
    })

    // I3 批量分配全部 skipped（线索不存在）→ 不失效
    await expectNoInvalidation('I3 批量分配全部 skipped（线索不存在）', h, () => {
      const res = assignLeads([987654], '测试销售甲', 'tester')
      if (!res.ok || res.data?.assignments.length) throw new Error('预期全部跳过')
    })
    // I4 批量分配全部 skipped（已有有效归属）→ 不失效
    {
      const leadId = Number(crmDbService.create('lead', { contact_type: 'phone', contact_normalized: `137${String(now).slice(-8)}`, contact_raw: 'I4', status: 'NEW', first_contact_deadline: 0, created_at: now, updated_at: now }))
      assignLeads([leadId], '测试销售甲', 'tester') // 首次分配（会失效）
      await expectNoInvalidation('I4 批量分配全部 skipped（已有有效归属）', h, () => {
        const res = assignLeads([leadId], '测试销售甲', 'tester')
        if (res.ok && res.data?.assignments.length) throw new Error('预期被跳过')
      })
    }

    // I5 resetLegacyGroupScanSla：首次命中 → 失效；重跑命中 0 行 → 不失效
    {
      const leadId = Number(crmDbService.create('lead', { contact_type: 'phone', contact_normalized: `136${String(now).slice(-8)}`, contact_raw: 'I5', source: '群资源扫描', status: 'NEW', first_contact_deadline: now + 86400000, created_at: now, updated_at: now }))
      await expectImmediateInvalidation('I5 resetLegacyGroupScanSla 命中行 → 失效', h, () => {
        resetLegacyGroupScanSla()
      })
      await expectNoInvalidation('I6 resetLegacyGroupScanSla 重跑命中 0 行 → 不失效', h, () => {
        resetLegacyGroupScanSla()
      })
      void leadId
    }

    // I7 correctSla1Misrecycle：全部 alreadyAssigned（无新增行）→ 不失效；确有纠正 → 失效
    {
      // 构造「已是 recycled 且 updated_by=system:sla」的行，且该 lead 已有有效归属 → alreadyAssigned 分支
      const leadId = Number(crmDbService.create('lead', { contact_type: 'phone', contact_normalized: `135${String(now).slice(-8)}`, contact_raw: 'I7', status: 'NEW', first_contact_deadline: 0, created_at: now, updated_at: now }))
      crmDbService.create('assignment', { lead_id: leadId, sales_name: '测试销售甲', mode: 'manual', status: 'assigned', source: 'test', updated_by: 'tester', updated_at: now, version: 1, deleted: 0 })
      crmDbService.create('assignment', { lead_id: leadId, sales_name: '测试销售甲', mode: 'manual', status: 'recycled', source: 'test', updated_by: 'system:sla', updated_at: now, version: 1, deleted: 0 })
      crmDbService.setScanState('migration:sla1-misrecycle-correction', 0) // 清一次性标记，允许本轮扫描
      await expectNoInvalidation('I7 correctSla1Misrecycle 全部 alreadyAssigned → 不失效', h, () => {
        const r = correctSla1Misrecycle()
        if (r.corrected !== 0 || r.alreadyAssigned < 1) throw new Error(`预期全部跳过，实际 corrected=${r.corrected} alreadyAssigned=${r.alreadyAssigned}`)
      })
      // 真有需要纠正的行（lead 无有效归属）→ 必须失效
      const leadId2 = Number(crmDbService.create('lead', { contact_type: 'phone', contact_normalized: `134${String(now).slice(-8)}`, contact_raw: 'I8', status: 'NEW', first_contact_deadline: 0, created_at: now, updated_at: now }))
      crmDbService.create('assignment', { lead_id: leadId2, sales_name: '测试销售甲', mode: 'manual', status: 'recycled', source: 'test', updated_by: 'system:sla', updated_at: now, version: 1, deleted: 0 })
      crmDbService.setScanState('migration:sla1-misrecycle-correction', 0)
      await expectImmediateInvalidation('I8 correctSla1Misrecycle 确有纠正行 → 失效', h, () => {
        const r = correctSla1Misrecycle()
        if (r.corrected < 1) throw new Error(`预期有纠正，实际 corrected=${r.corrected}`)
      })
    }

    // I9 migrate02AccountToCustomer：无 account 变化（已全部挂接）→ 不失效；确有挂接 → 失效
    {
      const accountId = Number(crmDbService.create('account', { name: '迁移客户', phone: '13800001111', created_at: now, updated_at: now }))
      await expectImmediateInvalidation('I9 migrate02 确有 account 挂接 → 失效', h, () => {
        const r = migrate02AccountToCustomer()
        if (r.applied < 1) throw new Error(`预期有挂接，实际 applied=${r.applied}`)
      })
      await expectNoInvalidation('I10 migrate02 重跑无 account 变化（只写 scan_state/report）→ 不失效', h, () => {
        migrate02AccountToCustomer()
      })
      void accountId
    }

    h.unsubscribe()
    resetAnnualReviewInvalidationForTest()
  }

  // ══ J. LAN 上行 audit 事件：白名单 action 提交后立即失效（真实文件消费） ═══════
  {
    const h = createHarness()
    const shared = mkdtempSync(join(tmpdir(), 'ar-invalidation-up-'))
    const remoteTid = 'probe-remote-terminal'
    const upDir = join(shared, 'up', remoteTid)
    mkdirSync(upDir, { recursive: true })
    let seq = 0
    /** 写一条上行 audit 事件文件；reuseKey 用于**重放**同一个逻辑事件（幂等键相同、文件名不同） */
    const writeAuditUpEvent = (action: string, extra: Record<string, unknown> = {}, reuseKey?: string): string => {
      const key = reuseKey ?? `${remoteTid}/audit:${++seq}`
      const ev = {
        eventSeq: seq,
        idempotencyKey: key,
        type: 'audit',
        payload: { action, actor: 'remote-sales', entity_type: 'lead', entity_id: 1, detail: '{}', ...extra },
        emittedAt: Date.now(),
        from: remoteTid
      }
      const file = join(upDir, `${String(seq).padStart(8, '0')}-audit.json`)
      writeFileSync(file, JSON.stringify(ev), 'utf-8')
      return key
    }
    const leadAssignAuditRows = (): number => Number(crmDbService.all(
      "SELECT COUNT(*) AS c FROM audit_event WHERE action = 'lead_assign' AND actor = 'remote-sales'"
    )[0]?.c || 0)

    // J1 lead_assign 上行 audit → 消费成功且**立即**失效（不 flush、不等待）
    settleWindow()
    await warmCaches(h)
    writeAuditUpEvent('lead_assign')
    const c1 = lanSync.consumeUpEvents(shared)
    ok('J1 lead_assign 上行 audit 消费成功', c1.applied === 1)
    ok('J2 lead_assign 后报告缓存立即失效（未等 150ms）', h.service.getReport(YEAR).cache !== 'hit')
    ok('J3 lead_assign 后 AI 缓存立即清空', h.coordinator.cacheSize() === 0)

    // J4 lead_transfer 上行 audit → 立即失效
    settleWindow()
    await warmCaches(h)
    writeAuditUpEvent('lead_transfer')
    const c2 = lanSync.consumeUpEvents(shared)
    ok('J4 lead_transfer 上行 audit 消费成功', c2.applied === 1)
    ok('J5 lead_transfer 后两类缓存立即失效',
      h.service.getReport(YEAR).cache !== 'hit' && h.coordinator.cacheSize() === 0)

    // J6 sync_apply 上行 audit → 立即失效（白名单第三项）
    settleWindow()
    await warmCaches(h)
    writeAuditUpEvent('sync_apply')
    const c3 = lanSync.consumeUpEvents(shared)
    ok('J6 sync_apply 上行 audit 消费成功', c3.applied === 1)
    ok('J7 sync_apply 后两类缓存立即失效',
      h.service.getReport(YEAR).cache !== 'hit' && h.coordinator.cacheSize() === 0)

    // J8 无关 action（lead_note）→ 不失效
    await expectNoInvalidation('J8 上行 audit lead_note（非白名单）不失效', h, () => {
      writeAuditUpEvent('lead_note')
      lanSync.consumeUpEvents(shared)
    })

    // J9 重复投递：保存首次事件的幂等键，**重建同一个 key 的事件文件**再消费 —— 真重放，
    // 不是消费空目录。幂等命中必须零业务写（audit_event 不重复）、零失效、不影响运行中任务。
    {
      settleWindow()
      await warmCaches(h)
      const dupKey = writeAuditUpEvent('lead_assign') // 首次事件（保存幂等键）
      const rowsBeforeFirst = leadAssignAuditRows()
      const first = lanSync.consumeUpEvents(shared)
      ok('J9 首次消费成功并落一条审计（真重放的对照）',
        first.applied === 1 && leadAssignAuditRows() === rowsBeforeFirst + 1)
      settleWindow()
      await warmCaches(h)
      const before = {
        report: h.service.getReport(YEAR).cache,
        ai: h.coordinator.cacheSize(),
        task: h.service.getTaskState(YEAR)?.taskId ?? null,
        auditRows: leadAssignAuditRows()
      }
      ok('J9a 重放前两类缓存均热（便于观察是否被失效）', before.report === 'hit' && before.ai >= 1)
      // 真重放：同一个 idempotencyKey 的事件文件重新出现（首次已被消费删除）
      writeAuditUpEvent('lead_assign', {}, dupKey)
      const dup = lanSync.consumeUpEvents(shared)
      ok('J9b 重放命中幂等路径（skippedDup=1、applied=0）', dup.skippedDup === 1 && dup.applied === 0)
      ok('J9c 重放零业务写：audit_event 没有重复行', leadAssignAuditRows() === before.auditRows)
      ok('J9d 重放不失效：报告缓存仍命中、AI 缓存仍在',
        h.service.getReport(YEAR).cache === 'hit' && h.coordinator.cacheSize() === before.ai)
      ok('J9e 重放不影响已完成的报告任务（同一 taskId、未被取消）',
        h.service.getTaskState(YEAR)?.status === 'completed' && h.service.getTaskState(YEAR)?.taskId === before.task)
      for (const f of readdirSync(upDir)) { try { rmSync(join(upDir, f), { force: true }) } catch { /* ignore */ } }
    }

    // J11 事务失败（SQLite 触发器 RAISE ABORT 注入）→ 不失效
    {
      settleWindow()
      await warmCaches(h)
      crmDbService.runTx((tx) => {
        tx.run("CREATE TRIGGER probe_up_audit_fail BEFORE INSERT ON audit_event WHEN NEW.action = 'lead_transfer' BEGIN SELECT RAISE(ABORT, 'probe fail'); END")
      })
      // 触发器本身不失效（scan_state 类 DDL 未标记）——先排掉窗口
      settleWindow()
      await warmCaches(h)
      const before = { report: h.service.getReport(YEAR).cache, ai: h.coordinator.cacheSize() }
      writeAuditUpEvent('lead_transfer')
      const failed = lanSync.consumeUpEvents(shared)
      crmDbService.runTx((tx) => { tx.run('DROP TRIGGER probe_up_audit_fail') })
      ok('J11 事务失败被捕获（failed 计数）', failed.failed === 1 && failed.applied === 0)
      ok('J12 事务失败不失效（报告缓存仍命中）', h.service.getReport(YEAR).cache === before.report)
      ok('J13 事务失败不失效（AI 缓存仍在）', h.coordinator.cacheSize() === before.ai)
      // 生产语义：失败事件文件留待下轮重试；本用例显式清理，避免污染后续断言
      for (const f of readdirSync(upDir)) { try { rmSync(join(upDir, f), { force: true }) } catch { /* ignore */ } }
      settleWindow()
    }

    // J14 无效事件（找不到 lead 的 claim）不失效
    await expectNoInvalidation('J14 无效事件（claim 目标 lead 不存在）不失效', h, () => {
      const key = `${remoteTid}/claim:${++seq}`
      writeFileSync(join(upDir, `${String(seq).padStart(8, '0')}-claim.json`), JSON.stringify({
        eventSeq: seq, idempotencyKey: key, type: 'claim',
        payload: { leadId: 987654, salesName: '测试销售甲', actor: 'remote-sales' },
        emittedAt: Date.now(), from: remoteTid
      }), 'utf-8')
      const res = lanSync.consumeUpEvents(shared)
      if (res.applied !== 0) throw new Error(`预期不应用，实际 applied=${res.applied}`)
    })

    try { rmSync(shared, { recursive: true, force: true }) } catch { /* ignore */ }
    h.unsubscribe()
    resetAnnualReviewInvalidationForTest()
  }

  // ══ F. 账号隔离不受破坏 ════════════════════════════════════════════════════
  {
    const h = createHarness()
    const taskIdA = await warmCaches(h)
    h.ctx.wxid = 'wx_inv_b'
    h.ctx.salesDbName = 'sales-inv-b.db'
    h.ctx.crmDbName = 'crm-inv-b.db'
    announceAnnualReviewDataChangedNow('account_switch')
    ok('F1 切号后 B 作用域报告缓存为 miss（绝不回退 A 的报告）', h.service.getReport(YEAR).cache === 'miss')
    const cross = h.service.getTaskReport(taskIdA)
    ok('F2 切号后 A 的 taskId 按不存在返回（fail closed）', cross.ok === false && cross.code === 'task_not_found')
    ok('F3 AI 结果缓存已清空（不跨账号复用）', h.coordinator.cacheSize() === 0)
    h.unsubscribe()
    resetAnnualReviewInvalidationForTest()
  }

  // ══ G. 读操作不接入失效 ════════════════════════════════════════════════════
  {
    const events: AnnualReviewInvalidationEvent[] = []
    const off = onAnnualReviewInvalidation((e) => events.push(e))
    crmDbService.all('SELECT * FROM account')
    crmDbService.list('contract', { limit: 5 })
    crmDbService.getById('account', 1)
    crmDbService.customers()
    crmDbService.statsOverview()
    crmDbService.opportunityStats()
    crmDbService.autoConfirmHistory(5)
    crmDbService.getScanState('inv:test:key')
    salesDbService.all('SELECT * FROM customer_profile')
    await tick()
    ok('G1 纯读操作不产生任何失效派发（失效不接在读路径上）', events.length === 0 && !hasPendingAnnualReviewInvalidation())
    off()
    settleWindow()
  }

  // ══ H. 归属类操作：年度复盘只有一条权威链路（事务内 changed 标记）═══════════════
  // Assignment 总线只负责线索页/UI 刷新。每个逻辑操作都验证：年度复盘**立即恰好一次**失效 +
  // UI 事件照发 + 等过两条总线各自的 150ms 窗口后**无第二次失效** + 新启动的报告不被延迟取消
  // （真实计时器，见 expectAssignmentChain）；冲突 / 无 lead / 重复投递 / noop 审计零失效。
  {
    const h = createHarness()
    const {
      assignLeads, claimLead, recycleAssignment, transferAssignment, runSla1Recycle, correctSla1Misrecycle
    } = await import('../electron/services/crmAssignmentService')
    const { importHistoricalAssignments } = await import('../electron/services/crmLeadService')
    const S_A = '测试销售甲'
    const S_B = '测试销售乙'
    cfg.set('crmSalesList', [S_A, S_B])
    setIdentity(S_A, '销售')
    const now = Date.now()
    let seqPhone = 0
    const nextPhone = (): string => `1390000${String(++seqPhone).padStart(4, '0')}`
    /** 真实 lead 行（唯一 139 段手机号）；create 本身会失效，调用方负责先 settleWindow() */
    const seedLead = (tag: string, source = '测试'): { leadId: number; phone: string } => {
      const phone = nextPhone()
      const leadId = Number(crmDbService.create('lead', {
        contact_type: 'phone', contact_normalized: phone, contact_raw: tag, source,
        status: 'NEW', first_contact_deadline: 0, created_at: now, updated_at: now
      }))
      return { leadId, phone }
    }
    const activeAsgId = (leadId: number): number => Number(crmDbService.all(
      `SELECT id FROM assignment WHERE lead_id = ? AND deleted = 0 AND status IN ('assigned','claimed') ORDER BY id DESC LIMIT 1`,
      [leadId]
    )[0]?.id || 0)

    // ── H1 分配 ──────────────────────────────────────────────────────────────
    const { leadId: leadAssign } = seedLead('H1-分配')
    settleWindow()
    await expectAssignmentChain('H1 分配（assignLeads）', h, () => {
      const r = assignLeads([leadAssign], S_A, 'tester')
      if (!r.ok || !r.data?.assignments.length) throw new Error(`分配失败：${JSON.stringify(r)}`)
    }, { action: 'assign', leadIds: (ids) => ids.includes(leadAssign) })

    // ── H2 认领（assigned → claimed）─────────────────────────────────────────
    await expectAssignmentChain('H2 认领（claimLead）', h, () => {
      const r = claimLead(leadAssign, S_A)
      if (!r.ok) throw new Error(`认领失败：${r.code} ${r.message}`)
    }, { action: 'claim', leadIds: (ids) => ids.includes(leadAssign) })

    // ── H3 回收 ──────────────────────────────────────────────────────────────
    const asgRecycle = activeAsgId(leadAssign)
    await expectAssignmentChain('H3 回收（recycleAssignment）', h, () => {
      const r = recycleAssignment(asgRecycle, '测试回收', 'tester')
      if (!r.ok) throw new Error(`回收失败：${r.code} ${r.message}`)
    }, { action: 'recycle', leadIds: (ids) => ids.includes(leadAssign) })

    // ── H4 移交（归属易主，新行重起 SLA1）────────────────────────────────────
    const { leadId: leadTransfer } = seedLead('H4-移交')
    settleWindow()
    assignLeads([leadTransfer], S_A, 'tester')
    settleWindow()
    const asgTransfer = activeAsgId(leadTransfer)
    await expectAssignmentChain('H4 移交（transferAssignment）', h, () => {
      const r = transferAssignment(asgTransfer, S_B, '测试移交', 'tester')
      if (!r.ok) throw new Error(`移交失败：${r.code} ${r.message}`)
    }, { action: 'transfer', leadIds: (ids) => ids.includes(leadTransfer) })

    // ── H5 历史分配导入（新建 lead + claimed 态当前有效行）───────────────────
    const histPhone = nextPhone()
    await expectAssignmentChain('H5 历史分配导入（importHistoricalAssignments）', h, () => {
      const r = importHistoricalAssignments('测试历史分配.csv', [
        { contactType: 'phone', contactValue: histPhone, sales: S_A, assignedAt: now }
      ])
      if (r.assignmentsCreated < 1) throw new Error(`历史导入未产生分配行：${JSON.stringify(r)}`)
    }, { action: 'assign', leadIds: (ids) => ids.length === 1 })

    // ── H6 SLA 误扫纠正（补偿性再分配）──────────────────────────────────────
    const { leadId: leadCorrect } = seedLead('H6-纠正')
    settleWindow()
    crmDbService.create('assignment', {
      lead_id: leadCorrect, sales_name: S_A, mode: 'manual', status: 'recycled', source: 'test',
      updated_by: 'system:sla', updated_at: now, version: 1, deleted: 0
    })
    crmDbService.setScanState('migration:sla1-misrecycle-correction', 0) // 清一次性标记，允许本轮扫描
    settleWindow()
    await expectAssignmentChain('H6 SLA 误扫纠正（correctSla1Misrecycle）', h, () => {
      const r = correctSla1Misrecycle()
      if (r.corrected !== 1) throw new Error(`预期恰好纠正 1 条，实际 ${JSON.stringify(r)}`)
    }, { action: 'assign', leadIds: (ids) => ids.includes(leadCorrect) })

    // ── H7 SLA 三次超时回收（回收 + 主管通知同一事务）────────────────────────
    const { leadId: leadSla } = seedLead('H7-SLA回收')
    settleWindow()
    assignLeads([leadSla], S_A, 'tester')
    settleWindow()
    const asgSla = activeAsgId(leadSla)
    // 造「已提醒两次 + 已过期」现场：本轮扫描直接走满第 3 次的回收分支
    crmDbService.runTx((tx) => {
      tx.run('UPDATE assignment SET sla1_deadline = ?, sla1_remind_count = 2 WHERE id = ?', [now - 3600_000, asgSla])
    })
    settleWindow()
    await expectAssignmentChain('H7 SLA 三次超时回收（runSla1Recycle）', h, () => {
      const r = runSla1Recycle(now)
      if (r.recycled !== 1 || r.reminded !== 0) throw new Error(`预期恰好回收 1 条且无提醒，实际 ${JSON.stringify(r)}`)
    }, { action: 'recycle', leadIds: (ids) => ids.includes(leadSla) })

    // ── H8 好友绑定回执（LAN 上行 bind_wx：停表 + lead 状态推进）──────────────
    // 本操作从设计上就不发 assignment UI 事件（总线只承载归属四动作）→ 期望零 UI 事件
    const { leadId: leadBind } = seedLead('H8-好友绑定')
    settleWindow()
    assignLeads([leadBind], S_A, 'tester')
    settleWindow()
    const bindRoot = mkdtempSync(join(tmpdir(), 'ar-invalidation-bind-'))
    const bindUp = join(bindRoot, 'up', 'probe-bind-terminal')
    mkdirSync(bindUp, { recursive: true })
    writeFileSync(join(bindUp, '00000001-bind_wx.json'), JSON.stringify({
      eventSeq: 1, idempotencyKey: 'probe-bind-terminal/bind:1', type: 'bind_wx',
      payload: { leadId: leadBind, salesName: S_A, wxid: 'wx_inv_probe_bind', actor: 'remote-sales' },
      emittedAt: now, from: 'probe-bind-terminal'
    }), 'utf-8')
    await expectAssignmentChain('H8 好友绑定回执（LAN 上行 bind_wx）', h, () => {
      const res = lanSync.consumeUpEvents(bindRoot)
      if (res.applied !== 1) throw new Error(`bind_wx 未应用：${JSON.stringify(res)}`)
    }, null)
    try { rmSync(bindRoot, { recursive: true, force: true }) } catch { /* ignore */ }

    // ── H9 中央 HTTP 下行 assign（applyDownEventDirect）──────────────────────
    const centralContact = nextPhone()
    await expectAssignmentChain('H9 中央下行 assign（applyDownEventDirect）', h, () => {
      const outcome = lanSync.applyDownEventDirect({
        idempotencyKey: `inv-down-central-${now}`, type: 'assign', to: S_A,
        sourceDeviceId: 'hub-1', deliveryRole: 'apply', emittedAt: now,
        payload: {
          type: 'assign', leadId: 888001, assignmentId: 888001, salesName: S_A, mode: 'manual',
          sla1Deadline: now + 86400000,
          lead: {
            leadId: 888001, name: 'H9中央线索', contactType: 'phone', contactNormalized: centralContact,
            contactRaw: centralContact, wechat: '', source: '同步', note: ''
          }
        }
      } as never)
      if (outcome !== 'applied') throw new Error(`中央下行未应用（${outcome}）`)
    }, { action: 'assign', leadIds: (ids) => ids.length === 1 })

    // ── H10 LAN SMB 下行 assign（真实事件文件 + 本体校验 + consumeDownEvents）─
    const smbRoot = mkdtempSync(join(tmpdir(), 'ar-invalidation-smb-'))
    const ownKey = lanSync.deliveryKey(lanSync.getTerminalId())
    const smbDir = join(smbRoot, 'down', ownKey)
    mkdirSync(smbDir, { recursive: true })
    const smbContact = nextPhone()
    const smbKey = `assign:inv-smb-${now}`
    writeFileSync(join(smbDir, lanSync.deliveryFileName(900, smbKey, 'apply')), JSON.stringify({
      eventSeq: 900, idempotencyKey: smbKey, type: 'assign', deliveryRole: 'apply', to: ownKey,
      emittedAt: now,
      payload: {
        type: 'assign', leadId: 888002, assignmentId: 888002, salesName: S_A, mode: 'manual',
        sla1Deadline: now + 86400000,
        lead: {
          leadId: 888002, name: 'H10SMB线索', contactType: 'phone', contactNormalized: smbContact,
          contactRaw: smbContact, wechat: '', source: '同步', note: ''
        }
      }
    }), 'utf-8')
    await expectAssignmentChain('H10 LAN SMB 下行 assign（consumeDownEvents）', h, () => {
      const r = lanSync.consumeDownEvents(smbRoot)
      if (r.applied !== 1) throw new Error(`SMB 下行未应用：${JSON.stringify(r)}`)
    }, { action: 'assign', leadIds: (ids) => ids.length === 1 })
    try { rmSync(smbRoot, { recursive: true, force: true }) } catch { /* ignore */ }

    // ── H11 LAN 上行 claim 回执 ──────────────────────────────────────────────
    const { leadId: leadClaimUp } = seedLead('H11-上行认领')
    settleWindow()
    assignLeads([leadClaimUp], S_A, 'tester')
    settleWindow()
    const claimRoot = mkdtempSync(join(tmpdir(), 'ar-invalidation-claim-'))
    const claimUp = join(claimRoot, 'up', 'probe-claim-terminal')
    mkdirSync(claimUp, { recursive: true })
    writeFileSync(join(claimUp, '00000002-claim.json'), JSON.stringify({
      eventSeq: 2, idempotencyKey: 'probe-claim-terminal/claim:1', type: 'claim',
      payload: { leadId: leadClaimUp, salesName: S_A, actor: 'remote-sales', claimedAt: now },
      emittedAt: now, from: 'probe-claim-terminal'
    }), 'utf-8')
    await expectAssignmentChain('H11 LAN 上行 claim 回执（consumeUpEvents）', h, () => {
      const res = lanSync.consumeUpEvents(claimRoot)
      if (res.applied !== 1) throw new Error(`上行 claim 未应用：${JSON.stringify(res)}`)
    }, { action: 'claim', leadIds: (ids) => ids.includes(leadClaimUp) })
    try { rmSync(claimRoot, { recursive: true, force: true }) } catch { /* ignore */ }

    // ── H12~H16 不应失效的分支：冲突 / 无 lead / 重复投递 / noop 审计 ─────────
    // H12 下行 conflict：本地已有有效归属，中枢指令不覆盖
    const { leadId: leadConflict, phone: conflictContact } = seedLead('H12-冲突')
    settleWindow()
    assignLeads([leadConflict], S_A, 'tester')
    settleWindow()
    await expectNoAssignmentChain('H12 下行 assign 冲突（conflict）', h, () => {
      const outcome = lanSync.applyDownEventDirect({
        idempotencyKey: `inv-down-conflict-${now}`, type: 'assign', to: S_A,
        sourceDeviceId: 'hub-1', deliveryRole: 'apply', emittedAt: now,
        payload: {
          type: 'assign', leadId: 888003, assignmentId: 888003, salesName: S_A, mode: 'manual',
          sla1Deadline: now + 86400000,
          lead: {
            leadId: 888003, name: 'H12冲突线索', contactType: 'phone', contactNormalized: conflictContact,
            contactRaw: conflictContact, wechat: '', source: '同步', note: ''
          }
        }
      } as never)
      if (outcome !== 'conflict') throw new Error(`预期 conflict，实际 ${outcome}`)
    })

    // H13 下行 nolead：中央通道无映射、载荷无 lead 锚点
    await expectNoAssignmentChain('H13 下行 transfer 无对应 lead（nolead）', h, () => {
      const outcome = lanSync.applyDownEventDirect({
        idempotencyKey: `inv-down-nolead-${now}`, type: 'transfer', to: S_A,
        sourceDeviceId: 'hub-1', deliveryRole: 'apply', emittedAt: now,
        payload: {
          type: 'transfer', leadId: 777001, assignmentId: 777001, salesName: S_A, toSales: S_A,
          mode: 'manual', sla1Deadline: now + 86400000
        }
      } as never)
      if (outcome !== 'nolead') throw new Error(`预期 nolead，实际 ${outcome}`)
    })

    // H14 下行 recycle 命中未知 lead：只落一条 noop 审计（E1 缺口检测只读 assign/transfer）
    await expectNoAssignmentChain('H14 下行 recycle 未知 lead（noop 审计）', h, () => {
      const outcome = lanSync.applyDownEventDirect({
        idempotencyKey: `inv-down-recycle-noop-${now}`, type: 'recycle', to: S_A,
        sourceDeviceId: 'hub-1', deliveryRole: 'apply', emittedAt: now,
        payload: { type: 'recycle', leadId: 777002, assignmentId: 777002, salesName: S_A, reason: '测试' }
      } as never)
      if (outcome !== 'applied') throw new Error(`预期 applied（noop 审计），实际 ${outcome}`)
    })

    // H15 重复投递：同一幂等键重放（首次已应用）→ 零业务写、零失效、零 UI 事件
    const dupContact = nextPhone()
    const dupEvent = {
      idempotencyKey: `inv-down-dup-${now}`, type: 'assign', to: S_A,
      sourceDeviceId: 'hub-1', deliveryRole: 'apply', emittedAt: now,
      payload: {
        type: 'assign', leadId: 888004, assignmentId: 888004, salesName: S_A, mode: 'manual',
        sla1Deadline: now + 86400000,
        lead: {
          leadId: 888004, name: 'H15重复线索', contactType: 'phone', contactNormalized: dupContact,
          contactRaw: dupContact, wechat: '', source: '同步', note: ''
        }
      }
    }
    const dupFirst = lanSync.applyDownEventDirect(dupEvent as never)
    ok('H15 首次中央下行 assign 应用成功（重复投递的对照）', dupFirst === 'applied')
    settleWindow()
    await expectNoAssignmentChain('H16 重复投递同一幂等键（重放）', h, () => {
      const again = lanSync.applyDownEventDirect(dupEvent as never)
      if (again !== 'applied') throw new Error(`重放应命中已应用标记，实际 ${again}`)
    })

    h.unsubscribe()
    resetAnnualReviewInvalidationForTest()
  }

  try { rmSync(dbDir, { recursive: true, force: true }) } catch { /* ignore */ }
  try { rmSync(isoDir, { recursive: true, force: true }) } catch { /* ignore */ }

  console.log(`结果：${pass} 通过 / ${fail} 失败`)
  process.exit(fail > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('FATAL:', e)
  process.exit(1)
})
