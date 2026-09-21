/**
 * annual-review-ai-ipc-test.ts —— 年度经营复盘 S7.2 护栏（AI 分析接线：service → coordinator → preload → 页面）
 *
 * 覆盖（对应用户验收条目 1–14）：
 *   1  正常成功链路：taskId → 报告定位 → 唯一模型出口 → 结构化成功响应（含 model/promptVersion）
 *   2  taskId 不存在 / 已淘汰 / 非 completed / 失效 / 跨账号 全部拒绝（稳定 code，不泄漏存在性）
 *   3  渲染层无法提交伪造报告绕过主进程（请求只认 taskId 字符串；报告由主进程定位）
 *   4  九个 AI 失败码 + IPC 层失败码原样、安全地传到页面映射层（页面映射表穷举校验）
 *   5  异常中的 Token / URL / 路径 / 响应正文 / 堆栈不泄漏（主进程固定文案 + 页面安全闸门）
 *   6  重复点击只产生一次有效调用（运行中拒绝 + 成功结果缓存）
 *   7  切换年份 / 重新生成后旧结果不能覆盖新状态；报告身份变化即清空 AI 区块
 *   8  取消与组件卸载后不更新状态（且取消只在中止成功时进入「已取消」）
 *   9  AI 失败不影响确定性报告、任务状态与导出内容
 *  10  成功结果严格渲染：文本按纯文本透传，无 dangerouslySetInnerHTML / 无 HTML 注入
 *  11  metricKeys 只能引用当前报告 coverage 中存在的键（未知键不展示、不显示为 0）
 *  12  缓存边界：账号隔离、报告身份隔离、promptVersion 隔离、失效/过期后不可命中
 *  13  preload / handler / electron.d.ts 的通道与签名一致（源码守卫，作为补充）
 *  14  S7.1 词表完整性（九个失败码逐字保留）＋ 真实服务层集成（解析/取消/未配置/额度阻断）
 *
 * 测试纪律：模型出口经 deps.completion（真实服务层链路）或 deps.generate（隔离编排层）注入
 * 假实现——本脚本**不会**触碰 aiApiClient，不发出真实请求，不读写真实数据库/账本/配置；
 * 报告夹具由已验收的纯统计 compose 生成。
 * 运行：npx tsx scripts/annual-review-ai-ipc-test.ts
 */
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import {
  resolveAnnualReviewPeriod,
  type AnnualReviewFacts,
  type AnnualReviewMessageStats
} from '../electron/services/annualReviewStats'
import type { AnnualReviewSalesSegmentsFacts, AnnualReviewCrmSegmentsFacts } from '../electron/services/annualReviewSegments'
import { composeAnnualReviewReport, type AnnualReviewReport } from '../electron/services/annualReviewReport'
import {
  AnnualReviewService,
  ANNUAL_REVIEW_CACHE_TTL_MS,
  type AnnualReviewAccountContext,
  type AnnualReviewWorkerPayload,
  type AnnualReviewWorkerRunner
} from '../electron/services/annualReviewService'
import {
  AnnualReviewAiCoordinator,
  ANNUAL_REVIEW_AI_IPC_FAILURE_MESSAGES,
  annualReviewAiCacheKey,
  bindAnnualReviewAiSenderAbort,
  type AnnualReviewAiSenderLike
} from '../electron/services/annualReviewAiCoordinator'
import { ANNUAL_REVIEW_AI_FAILURE_MESSAGES } from '../electron/services/annualReviewAiService'
import { ANNUAL_REVIEW_AI_PROMPT_VERSION, parseAnnualReviewAiOutput } from '../electron/services/annualReviewAiCore'
import { AiBudgetBlockedError } from '../electron/services/ai/aiBudget'
import { generateAnnualReviewAiAnalysis, type AnnualReviewAiCompletion } from '../electron/services/annualReviewAiService'
import { buildAnnualReviewMarkdown, buildAnnualReviewCsv } from '../electron/services/annualReviewExportContent'
import {
  ANNUAL_REVIEW_AI_ANALYSIS_FAILURE_CODES,
  ANNUAL_REVIEW_AI_CORE_FAILURE_CODES,
  ANNUAL_REVIEW_AI_IPC_FAILURE_CODES,
  type AnnualReviewAiAnalysis
} from '../shared/annualReviewAi'
import {
  AI_FAILURE_CODES,
  aiFailureView,
  buildAiMetricCells,
  createAnnualReviewController,
  initialAnnualReviewAiState,
  initialAnnualReviewState,
  reduceAiCancelled,
  reduceAiResult,
  reduceAiStart,
  reduceReportResult,
  sanitizeAiFailureMessage,
  type AnnualReviewApi,
  type AnnualReviewPageState,
  type AnnualReviewProgressEvent,
  type AnnualReviewReportResult,
  type AnnualReviewTaskStatusResult
} from '../src/utils/annualReviewView'

let pass = 0, fail = 0
function ok(name: string, cond: boolean): void {
  if (cond) { pass++ } else { fail++; console.error('FAIL:', name) }
}
function eq(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a === b) pass++
  else { fail++; console.error(`FAIL: ${name}\n  actual:   ${a}\n  expected: ${b}`) }
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const T = (y: number, m: number, d: number, hh = 0, mm = 0, ss = 0): number =>
  new Date(y, m - 1, d, hh, mm, ss).getTime()
const GEN = T(2026, 6, 15, 12, 0, 0)
const tick = (): Promise<void> => new Promise((r) => setImmediate(r))
const wait = async (n = 6): Promise<void> => { for (let i = 0; i < n; i++) await tick() }
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

// ── 夹具：与 service 测试同构的最小事实 + 由纯统计 compose 出真实报告 ────────
const facts: AnnualReviewFacts = {
  accounts: [
    { id: 1, name: '客户1', createdAt: T(2025, 2, 1), importedAt: null, sessionId: 'wxid_ai_secret', lastContactAtSec: Math.floor(T(2026, 2, 1) / 1000) },
    { id: 2, name: '客户2', createdAt: T(2025, 3, 1), importedAt: null, sessionId: 'wxid_ai_other', lastContactAtSec: null }
  ],
  contracts: [
    { id: 1, accountId: 1, amount: 1200, status: 'signed', signDate: T(2025, 3, 1) },
    { id: 2, accountId: 2, amount: 800, status: 'signed', signDate: T(2025, 7, 1) }
  ],
  allocations: [{ id: 1, accountId: 1, creditedAmount: 800.5, reconciledAt: T(2025, 4, 1), status: 'confirmed', reconciliationStatus: 'allocated', confirmedAt: null, contractId: 1 }],
  shippedEvents: []
}
const sales: AnnualReviewSalesSegmentsFacts = {
  profiles: [{ id: 1, sessionId: 'wxid_ai_secret', stage: 'quoted', lastContactAtSec: Math.floor(T(2026, 2, 1) / 1000), customerId: '501' }],
  intentEvents: [{ id: 1, sessionId: 'wxid_ai_secret', stage: 'quoted', source: null, createdAt: T(2025, 2, 1) }]
}
const crm: AnnualReviewCrmSegmentsFacts = {
  opportunities: [{ id: 1, accountId: 1, stage: 'quoted', status: 'open', createdAt: T(2025, 2, 2) }],
  opportunityEvents: []
}
const messageStats: AnnualReviewMessageStats = { ok: true, sessions: { wxid_ai_secret: { sent: 3, received: 1 } } }

const reportCache = new Map<number, AnnualReviewReport>()
function buildReport(year = 2025): AnnualReviewReport {
  const cached = reportCache.get(year)
  if (cached) return cached
  const report = composeAnnualReviewReport({ period: resolveAnnualReviewPeriod(year, GEN), facts, sales, crm, opts: { messageStats } })
  reportCache.set(year, report)
  return report
}

// ── 假 runner / 假 service ──────────────────────────────────────────────────
interface FakeCall {
  payload: AnnualReviewWorkerPayload
  resolve: (r: AnnualReviewReport) => void
  reject: (e: unknown) => void
}
function createFakeRunner() {
  const calls: FakeCall[] = []
  const runner: AnnualReviewWorkerRunner = {
    run(payload) {
      return new Promise<AnnualReviewReport>((resolve, reject) => { calls.push({ payload, resolve, reject }) })
    },
    cancel(taskId) {
      const call = calls.find((c) => c.payload.taskId === taskId)
      if (call) call.reject(Object.assign(new Error('已取消'), { code: 'cancelled' }))
    }
  }
  return { runner, calls }
}

interface Harness {
  service: AnnualReviewService
  ctxBox: { current: AnnualReviewAccountContext }
  runnerCalls: FakeCall[]
}

function createService(opts?: { ctx?: Partial<AnnualReviewAccountContext>; now?: () => number }): Harness {
  const ctxBox: { current: AnnualReviewAccountContext } = {
    current: {
      wxid: opts?.ctx?.wxid ?? 'wx_account_a',
      salesDbName: opts?.ctx?.salesDbName ?? 'weflow-sales-wx_account_a.db',
      crmDbName: opts?.ctx?.crmDbName ?? 'weflow-crm-wx_account_a.db',
      exclusions: opts?.ctx?.exclusions ?? { manualSessions: [], internalSessions: [] }
    }
  }
  let seq = 0
  const fake = createFakeRunner()
  const service = new AnnualReviewService({
    loadFacts: async () => facts,
    loadSalesSegments: async () => sales,
    loadCrmSegments: async () => crm,
    loadMessageStats: async () => messageStats,
    getAccountContext: () => ctxBox.current,
    runner: fake.runner,
    now: opts?.now,
    newTaskId: () => `ai-task-${++seq}`
  })
  return { service, ctxBox, runnerCalls: fake.calls }
}

/** 让一个生成任务收敛为 completed（返回 taskId） */
async function completeGenerate(h: Harness, year = 2025): Promise<string> {
  const started = h.service.start(year)
  await tick()
  const call = h.runnerCalls.find((c) => c.payload.taskId === started.taskId)
  if (!call) throw new Error('runner 未收到任务')
  call.resolve(buildReport(year))
  await wait(3)
  return started.taskId
}

// ── 假模型出口（用于隔离编排层的用例） ──────────────────────────────────────
const ANALYSIS: AnnualReviewAiAnalysis = {
  executiveSummary: '经营结果整体可控，客户结构有待优化。',
  diagnoses: [
    { title: '签约集中在少数客户', observation: '观察到签约集中在部分客户', hypothesis: '可能与大客户占比偏高有关', metricKeys: ['summary.contractAmount', 'summary.dealingCustomers'], confidence: 'medium' }
  ],
  actions: [
    { priority: 1, action: '提高存量客户复购', rationale: '复购是稳定的回款来源', metricKeys: ['summary.creditedAmount'], horizon: 'next_quarter' }
  ],
  risks: [{ risk: '部分指标数据不完整，结论把握有限', metricKeys: ['communication.volume'] }]
}

function makeGenerate() {
  const calls: Array<{ report: AnnualReviewReport; signal?: AbortSignal }> = []
  let behavior: 'ok' | 'fail' | 'throw' | 'hang' = 'ok'
  let failCode = 'call_failed'
  let failMessage: string = ANNUAL_REVIEW_AI_FAILURE_MESSAGES.call_failed
  let gate: { promise: Promise<unknown>; resolve: (v: unknown) => void } | null = null
  const generate = async (report: AnnualReviewReport, options: { signal?: AbortSignal }): Promise<unknown> => {
    calls.push({ report, signal: options.signal })
    if (behavior === 'throw') throw new Error('boom')
    if (behavior === 'hang') {
      gate = deferred<unknown>()
      return gate.promise
    }
    if (behavior === 'fail') return { ok: false, code: failCode, message: failMessage }
    return { ok: true, analysis: ANALYSIS, model: 'fake-model', promptVersion: ANNUAL_REVIEW_AI_PROMPT_VERSION, generatedAt: GEN }
  }
  return {
    calls,
    generate: generate as never,
    setBehavior: (b: 'ok' | 'fail' | 'throw' | 'hang') => { behavior = b },
    setFailure: (code: string, message: string) => { failCode = code; failMessage = message },
    resolveHang: (value: unknown) => { gate?.resolve(value) }
  }
}

const fakeConfig = { get: () => undefined } as never

/** 从报告 coverage 里取一个真实可引用的 metricKey（AI 输出契约要求键必须在 coverage 中） */
const KEY_AMOUNT = 'summary.contractAmount'
const KEY_CREDITED = 'summary.creditedAmount'
const KEY_VOLUME = 'communication.volume'

/** 合法模型输出（文本字段不含数字；metricKeys 均存在于报告 coverage） */
function validModelJson(): string {
  return JSON.stringify({
    executiveSummary: '整体经营平稳，客户结构有待优化。',
    diagnoses: [{
      title: '签约集中在少数客户',
      observation: '观察到签约集中在部分客户',
      hypothesis: '可能与大客户占比偏高有关',
      metricKeys: [KEY_AMOUNT],
      confidence: 'medium'
    }],
    actions: [{
      priority: 1,
      action: '提高存量客户复购与回款确认',
      rationale: '回款是更稳定的经营来源',
      metricKeys: [KEY_CREDITED],
      horizon: 'next_quarter'
    }],
    risks: [{ risk: '部分指标存在数据缺口，结论把握有限', metricKeys: [KEY_VOLUME] }]
  })
}

async function main(): Promise<void> {
  // ══ 1. 正常成功链路（service 定位 → 唯一模型出口 → 结构化成功响应） ══
  {
    const h = createService({ now: () => GEN })
    const taskId = await completeGenerate(h)
    const lookup = h.service.getTaskReport(taskId)
    ok('1a getTaskReport 命中已完成任务的报告', lookup.ok === true && lookup.report.year === 2025)
    ok('1b 报告来自缓存且身份一致（getReport 也给出同一 taskId）',
      h.service.getReport(2025).cache === 'hit' && h.service.getReport(2025).taskId === taskId)

    const fake = makeGenerate()
    const coordinator = new AnnualReviewAiCoordinator({
      getTaskReport: (id) => h.service.getTaskReport(id),
      getConfig: () => fakeConfig,
      generate: fake.generate as never,
      now: () => GEN
    })
    const res = await coordinator.run(taskId)
    ok('1c 成功响应 success:true', res.success === true)
    if (res.success) {
      eq('1d 分析内容原样返回', res.analysis, ANALYSIS)
      ok('1e 携带 model / promptVersion / generatedAt',
        res.model === 'fake-model' && res.promptVersion === ANNUAL_REVIEW_AI_PROMPT_VERSION && res.generatedAt === GEN)
      ok('1f 首次调用 cached=false', res.cached === false)
      eq('1g 响应只有约定字段（不外泄 scopeId/路径/任务内部信息）',
        Object.keys(res).sort().join(','), 'analysis,cached,generatedAt,model,promptVersion,success')
    }
    ok('1h 模型出口只收到一份报告', fake.calls.length === 1)
    ok('1i 出口收到的是主进程定位的报告（含真实指标）',
      fake.calls[0].report.summary.contractAmount.value === 2000)
    ok('1j 出口收到 AbortSignal（支持取消）', fake.calls[0].signal instanceof AbortSignal)
    ok('1k 成功响应不含报告正文/会话标识', !JSON.stringify(res).includes('wxid_ai_secret'))

    const again = await coordinator.run(taskId)
    ok('1l 同任务重复请求命中缓存（cached=true）', again.success === true && again.cached === true)
    ok('1m 命中缓存不产生第二次模型调用', fake.calls.length === 1)

    // 另一份报告（不同 taskId）不得复用前一份的缓存
    const task2 = await completeGenerate(h, 2024)
    const other = await coordinator.run(task2)
    ok('1n 不同报告身份不复用缓存', other.success === true && other.cached === false && fake.calls.length === 2)
    ok('1o 第二次出口拿到的是 2024 的报告', fake.calls[1].report.year === 2024)
  }

  // ══ 2. taskId 不存在 / 已淘汰 / 非 completed / 失效 / 跨账号 → 稳定错误码 ══
  {
    const h = createService({ now: () => GEN })
    const taskId = await completeGenerate(h)
    const coordinator = new AnnualReviewAiCoordinator({
      getTaskReport: (id) => h.service.getTaskReport(id),
      getConfig: () => fakeConfig,
      generate: makeGenerate().generate as never,
      now: () => GEN
    })

    const missing = await coordinator.run('no-such-task')
    ok('2a 不存在的 taskId → task_not_found', missing.success === false && missing.error.code === 'task_not_found')

    const bad = await coordinator.run({ taskId } as never)
    ok('2b 非字符串载荷 → invalid_task_id', bad.success === false && bad.error.code === 'invalid_task_id')
    const empty = await coordinator.run('')
    ok('2c 空 taskId → invalid_task_id', empty.success === false && empty.error.code === 'invalid_task_id')

    const running = h.service.start(2025)
    await tick()
    const runningLookup = h.service.getTaskReport(running.taskId)
    ok('2d 运行中任务 → task_not_completed', runningLookup.ok === false && runningLookup.code === 'task_not_completed')
    const runningRes = await coordinator.run(running.taskId)
    ok('2e 运行中任务不发起模型调用', runningRes.success === false && runningRes.error.code === 'task_not_completed')
    h.service.cancel(running.taskId)
    await wait()

    const cancelled = h.service.start(2025)
    await tick()
    h.service.cancel(cancelled.taskId)
    await wait()
    const cancelledLookup = h.service.getTaskReport(cancelled.taskId)
    ok('2f 已取消（failed/cancelled）任务 → task_not_completed',
      cancelledLookup.ok === false && cancelledLookup.code === 'task_not_completed')

    // 报告过期（TTL）：任务仍 completed，但报告缓存已过期 → report_not_available
    let clock = GEN
    const h2 = createService({ now: () => clock })
    const staleTaskId = await completeGenerate(h2)
    const staleCoord = new AnnualReviewAiCoordinator({
      getTaskReport: (id) => h2.service.getTaskReport(id),
      getConfig: () => fakeConfig,
      generate: makeGenerate().generate as never,
      now: () => clock
    })
    clock = GEN + ANNUAL_REVIEW_CACHE_TTL_MS + 1
    const staleLookup = h2.service.getTaskReport(staleTaskId)
    ok('2g 报告过期 → report_not_available', staleLookup.ok === false && staleLookup.code === 'report_not_available')
    const staleRes = await staleCoord.run(staleTaskId)
    ok('2h 过期报告不发起模型调用', staleRes.success === false && staleRes.error.code === 'report_not_available')

    // 同 year 重新生成：旧任务记录被新任务取代，旧 taskId 不再能取报告
    const h3 = createService({ now: () => GEN })
    const first = await completeGenerate(h3)
    const second = await completeGenerate(h3)
    ok('2i 同 year 新任务产生新 taskId', first !== second)
    const oldLookup = h3.service.getTaskReport(first)
    ok('2j 旧 taskId 不再取到报告（稳定错误码）',
      oldLookup.ok === false && (oldLookup.code === 'task_not_found' || oldLookup.code === 'report_not_available'))
    ok('2k 新 taskId 正常命中', h3.service.getTaskReport(second).ok === true)

    // 报告身份与任务绑定：缓存条目记录产出它的 taskId（报告被别的任务覆盖时可识别）
    ok('2l 缓存条目携带产出它的 taskId（报告身份可校验）',
      h3.service.getReport(2025).taskId === second)

    // 有界清理淘汰旧 taskId → task_not_found
    const h4 = createService({ now: () => GEN })
    const evicted = await completeGenerate(h4)
    for (let i = 0; i < 66; i++) {
      const started = h4.service.start(2001 + i)
      await tick()
      const call = h4.runnerCalls.find((c) => c.payload.taskId === started.taskId)
      call?.resolve(buildReport(2001 + i))
      await wait(2)
    }
    ok('2m 被有界清理淘汰的旧 taskId → task_not_found', (() => {
      const r = h4.service.getTaskReport(evicted)
      return r.ok === false && r.code === 'task_not_found'
    })())

    // 跨账号：按不存在返回（不泄漏存在性）
    const h5 = createService({ now: () => GEN })
    const taskA = await completeGenerate(h5)
    h5.ctxBox.current = { ...h5.ctxBox.current, wxid: 'wx_account_b', salesDbName: 'sales-b.db', crmDbName: 'crm-b.db' }
    const cross = h5.service.getTaskReport(taskA)
    ok('2n 跨账号 taskId → task_not_found（fail closed，不区分「存在但不可访问」）',
      cross.ok === false && cross.code === 'task_not_found')
    const crossCoordinator = new AnnualReviewAiCoordinator({
      getTaskReport: (id) => h5.service.getTaskReport(id),
      getConfig: () => fakeConfig,
      generate: makeGenerate().generate as never,
      now: () => GEN
    })
    const crossRes = await crossCoordinator.run(taskA)
    ok('2o 跨账号请求不发起模型调用', crossRes.success === false && crossRes.error.code === 'task_not_found')
  }

  // ══ 3. 渲染层无法提交伪造报告绕过主进程 ══
  {
    const h = createService({ now: () => GEN })
    const taskId = await completeGenerate(h)
    const fake = makeGenerate()
    const coordinator = new AnnualReviewAiCoordinator({
      getTaskReport: (id) => h.service.getTaskReport(id),
      getConfig: () => fakeConfig,
      generate: fake.generate as never,
      now: () => GEN
    })
    const forgedReport = { ...buildReport(2025), year: 1999, summary: { contractAmount: { value: 999999999 } } }
    const res = await coordinator.run({ taskId, report: forgedReport, analysis: ANALYSIS } as never)
    ok('3a 携带伪造报告的载荷被拒绝（只认 taskId 字符串）',
      res.success === false && res.error.code === 'invalid_task_id')
    ok('3b 伪造载荷未触发任何模型调用', fake.calls.length === 0)
    const extra = await coordinator.run(taskId, { signal: undefined, report: forgedReport } as never)
    ok('3c 额外字段被忽略：仍用主进程定位的报告',
      extra.success === true && fake.calls[0].report.summary.contractAmount.value === 2000)
    ok('3d 伪造年份未进入模型出口', JSON.stringify(fake.calls.map((c) => c.report.year)) === '[2025]')
  }

  // ══ 4. 失败码原样透传 + 页面映射层穷举 ══
  {
    const h = createService({ now: () => GEN })
    const fake = makeGenerate()
    fake.setBehavior('fail')
    const coordinator = new AnnualReviewAiCoordinator({
      getTaskReport: (id) => h.service.getTaskReport(id),
      getConfig: () => fakeConfig,
      generate: fake.generate as never,
      now: () => GEN
    })

    const coreCodes = [...ANNUAL_REVIEW_AI_CORE_FAILURE_CODES]
    for (const code of coreCodes) {
      const message = `固定文案-${code}`
      fake.setFailure(code, message)
      const freshTask = await completeGenerate(h) // 每次新报告 → 新缓存键，不会命中旧结果
      const res = await coordinator.run(freshTask)
      ok(`4a S7.1 失败码原样透传（${code}）`, res.success === false && res.error.code === code && res.error.message === message)
    }

    ok('4b IPC 层失败码词表与协调器文案表一一对应',
      [...ANNUAL_REVIEW_AI_IPC_FAILURE_CODES].every((code) => typeof ANNUAL_REVIEW_AI_IPC_FAILURE_MESSAGES[code] === 'string'))
    const taskNotFound = await coordinator.run('missing-task')
    ok('4c 定位类失败码文案来自固定常量（非异常投影）',
      taskNotFound.success === false && taskNotFound.error.message === ANNUAL_REVIEW_AI_IPC_FAILURE_MESSAGES.task_not_found)

    const missingViews = ANNUAL_REVIEW_AI_ANALYSIS_FAILURE_CODES.filter((code) => {
      const view = aiFailureView(code)
      return !view.title || !view.fallbackDetail || typeof view.action !== 'string'
    })
    eq('4d 页面失败码映射穷举覆盖（无缺失文案）', missingViews, [])
    const actions = ANNUAL_REVIEW_AI_ANALYSIS_FAILURE_CODES.map((code) => aiFailureView(code).action)
    ok('4e 失败码动作只有四类稳定值', actions.every((a) => ['retry', 'settings', 'regenerate', 'none'].includes(a)))
    ok('4f not_configured 引导去设置', aiFailureView('not_configured').action === 'settings')
    ok('4g budget_blocked 提示额度上限',
      aiFailureView('budget_blocked').action === 'settings' && aiFailureView('budget_blocked').title.includes('上限'))
    ok('4h numeric_claim / invalid_shape 可重试',
      aiFailureView('numeric_claim').action === 'retry' && aiFailureView('invalid_shape').action === 'retry')
    ok('4i unsupported_report_contract 说明报告仍可查看导出',
      aiFailureView('unsupported_report_contract').fallbackDetail.includes('查看') &&
      aiFailureView('unsupported_report_contract').action === 'none')
    ok('4j 页面词表与共享词表同源', AI_FAILURE_CODES.length === ANNUAL_REVIEW_AI_ANALYSIS_FAILURE_CODES.length)
    ok('4k 未知失败码不产生空文案', (() => {
      const view = aiFailureView('some_future_code')
      return view.title !== '' && view.fallbackDetail !== ''
    })())
    ok('4l 报告定位类失败码在页面有专门文案（不落进 internal）',
      ['task_not_found', 'task_not_completed', 'report_not_available'].every((code) => aiFailureView(code).action === 'regenerate'))
  }

  // ══ 5. 异常脱敏：Token / URL / 路径 / 响应正文 / 堆栈不外泄 ══
  {
    const h = createService({ now: () => GEN })
    const taskId = await completeGenerate(h)
    const probes = {
      token: 'sk-SECRET-abcdefghijklmnop',
      url: 'https://api.example.com/v1/chat/completions',
      path: '/Users/realuser/Library/Application Support/WeFlow/weflow-crm.db',
      body: '{"error":{"message":"insufficient_quota","type":"insufficient_quota_error"}}',
      stack: 'Error: boom\n    at callChatCompletion (/app/electron/services/ai/aiApiClient.ts:123:45)'
    }
    const coordinator = new AnnualReviewAiCoordinator({
      getTaskReport: (id) => h.service.getTaskReport(id),
      getConfig: () => fakeConfig,
      generate: (async () => {
        throw new Error([probes.token, probes.url, probes.path, probes.body, probes.stack].join(' | '))
      }) as never,
      now: () => GEN
    })
    const res = await coordinator.run(taskId)
    const raw = JSON.stringify(res)
    ok('5a 出口异常 → internal + 固定文案',
      res.success === false && res.error.code === 'internal' && res.error.message === ANNUAL_REVIEW_AI_IPC_FAILURE_MESSAGES.internal)
    ok('5b 响应不含 Token/URL/路径/响应正文/堆栈',
      !Object.values(probes).some((probe) => raw.includes(probe)))
    ok('5c 失败响应只有 success/error 两个键', Object.keys(res).sort().join(',') === 'error,success')

    for (const [name, probe] of Object.entries(probes)) {
      const safe = sanitizeAiFailureMessage(`AI 调用失败：${probe}`, 'call_failed')
      ok(`5d 页面闸门拦截 ${name}`, !safe.includes(probe) && safe === aiFailureView('call_failed').fallbackDetail)
    }
    ok('5e 正常文案原样保留（不误杀）',
      sanitizeAiFailureMessage('AI 调用超时，本次分析未生成', 'call_failed') === 'AI 调用超时，本次分析未生成')
    ok('5f 超长文案回落固定文案', sanitizeAiFailureMessage('x'.repeat(500), 'call_failed') === aiFailureView('call_failed').fallbackDetail)
    ok('5g 非字符串文案回落固定文案', sanitizeAiFailureMessage(undefined, 'call_failed') === aiFailureView('call_failed').fallbackDetail)

    // 窗口销毁 → 中止
    let destroyedListener: (() => void) | null = null
    let removed = 0
    let onceCalls = 0
    const sender: AnnualReviewAiSenderLike = {
      isDestroyed: () => false,
      once: (_e, listener) => { onceCalls++; destroyedListener = listener },
      removeListener: () => { removed++ }
    }
    const guard = bindAnnualReviewAiSenderAbort(sender)
    ok('5h 窗口存活时信号未中止', guard.signal.aborted === false)
    destroyedListener?.()
    ok('5i 窗口销毁 → 信号中止', guard.signal.aborted === true)
    guard.dispose()
    ok('5j dispose 摘除监听（无泄漏）', removed === 1 && onceCalls === 1)
    const deadSender: AnnualReviewAiSenderLike = { isDestroyed: () => true, once: () => { onceCalls++ }, removeListener: () => {} }
    const deadGuard = bindAnnualReviewAiSenderAbort(deadSender)
    ok('5k 已销毁窗口立刻中止且不注册监听', deadGuard.signal.aborted === true && onceCalls === 1)

    // 窗口销毁中止在途调用（真实服务层链路：abort → call_failed，不写缓存）
    const h2 = createService({ now: () => GEN })
    const task2 = await completeGenerate(h2)
    const hangingCompletion: AnnualReviewAiCompletion = (_req, signal) => new Promise<string>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new Error('请求已取消')), { once: true })
    })
    const coordinator2 = new AnnualReviewAiCoordinator({
      getTaskReport: (id) => h2.service.getTaskReport(id),
      getConfig: () => fakeConfig,
      configured: true,
      completion: hangingCompletion,
      generate: generateAnnualReviewAiAnalysis,
      now: () => GEN
    })
    const guard2 = bindAnnualReviewAiSenderAbort(sender)
    const pending = coordinator2.run(task2, { signal: guard2.signal })
    await wait()
    destroyedListener?.()
    await wait()
    ok('5l 窗口销毁后出口信号已中止（真实服务层收到 abort）', guard2.signal.aborted === true)
    const aborted = await pending
    ok('5m 中止的调用收敛为 call_failed + 取消文案（失败不写缓存）',
      aborted.success === false && aborted.error.code === 'call_failed' &&
      aborted.error.message === ANNUAL_REVIEW_AI_FAILURE_MESSAGES.cancelled && coordinator2.cacheSize() === 0)
  }

  // ══ 6. 重复点击只产生一次有效调用 + 并发拒绝 ══
  {
    const h = createService({ now: () => GEN })
    const taskId = await completeGenerate(h)
    const fake = makeGenerate()
    fake.setBehavior('hang')
    const coordinator = new AnnualReviewAiCoordinator({
      getTaskReport: (id) => h.service.getTaskReport(id),
      getConfig: () => fakeConfig,
      generate: fake.generate as never,
      now: () => GEN
    })
    const first = coordinator.run(taskId)
    await tick()
    const second = await coordinator.run(taskId)
    ok('6a 同报告并发请求 → analysis_in_progress',
      second.success === false && second.error.code === 'analysis_in_progress')
    ok('6b 并发期间只有一次模型调用', fake.calls.length === 1)
    ok('6c 在途计数为 1', coordinator.inFlightCount() === 1)
    fake.resolveHang({ ok: true, analysis: ANALYSIS, model: 'm', promptVersion: ANNUAL_REVIEW_AI_PROMPT_VERSION, generatedAt: GEN })
    const done = await first
    ok('6d 首个请求正常收敛', done.success === true)
    ok('6e 收敛后在途计数归零', coordinator.inFlightCount() === 0)
    const cached = await coordinator.run(taskId)
    ok('6f 再次点击命中缓存（仍只有一次模型调用）',
      cached.success === true && cached.cached === true && fake.calls.length === 1)
  }

  // ══ 7 & 8. 页面 controller：切年/重生成/取消/卸载 不与旧结果竞争 ══
  {
    const report = buildReport(2025)
    const report2024 = buildReport(2024)
    const createFakeApi = () => {
      const aiCalls: string[] = []
      const aiGates: Array<ReturnType<typeof deferred<Awaited<ReturnType<AnnualReviewApi['aiAnalysis']>>>>> = []
      const cancelCalls: string[] = []
      let aiCancelResult: { success: boolean } = { success: true }
      let reportResult: AnnualReviewReportResult = { success: true, cache: 'hit', report, taskId: 'task-1' }
      let progressCb: ((e: AnnualReviewProgressEvent) => void) | null = null
      const api: AnnualReviewApi = {
        getAvailableYears: async () => ({
          success: true,
          data: {
            years: [{ year: 2025, coverage: { rows: 2 } }, { year: 2024, coverage: { rows: 2 } }],
            currentYear: 2026, supportsAllTime: false, defaultYear: 2025, generatedAt: GEN
          }
        }),
        getReport: async () => reportResult,
        generate: async () => ({ success: true, taskId: 'gen-1' }),
        cancel: async () => ({ success: true }),
        getTaskStatus: async (): Promise<AnnualReviewTaskStatusResult> => ({ success: true, found: false }),
        aiAnalysis: async (taskId: string) => {
          aiCalls.push(taskId)
          const gate = deferred<Awaited<ReturnType<AnnualReviewApi['aiAnalysis']>>>()
          aiGates.push(gate)
          return gate.promise
        },
        aiCancel: async (taskId: string) => { cancelCalls.push(taskId); return aiCancelResult },
        subscribeProgress: (cb) => { progressCb = cb; return () => { progressCb = null } }
      }
      return {
        api, aiCalls, aiGates, cancelCalls,
        setReport: (r: AnnualReviewReportResult) => { reportResult = r },
        setAiCancel: (r: { success: boolean }) => { aiCancelResult = r },
        emit: (e: AnnualReviewProgressEvent) => progressCb?.(e)
      }
    }
    const okAi = (overrides: Partial<{ cached: boolean }> = {}) => ({
      success: true as const, analysis: ANALYSIS, model: 'm',
      promptVersion: ANNUAL_REVIEW_AI_PROMPT_VERSION, generatedAt: GEN, cached: overrides.cached ?? false
    })

    // 7a–7f 成功链路
    {
      const fake = createFakeApi()
      const controller = createAnnualReviewController(fake.api)
      await controller.loadYears()
      await wait()
      ok('7a 报告身份来自 getReport（task-1）', controller.getState().reportTaskId === 'task-1')
      controller.runAiAnalysis()
      await tick()
      controller.runAiAnalysis() // 运行中重复点击
      await tick()
      ok('7b 运行中重复点击只产生一次调用', fake.aiCalls.length === 1)
      ok('7c 运行中界面为 running（按钮可禁用）', controller.getState().ai.phase === 'running' && controller.getState().ai.taskId === 'task-1')
      fake.aiGates[0].resolve(okAi())
      await wait()
      const st = controller.getState()
      ok('7d 成功结果写入 AI 区块（phase=done）',
        st.ai.phase === 'done' && st.ai.analysis?.executiveSummary === ANALYSIS.executiveSummary)
      ok('7e 展示模型与 promptVersion', st.ai.model === 'm' && st.ai.promptVersion === ANNUAL_REVIEW_AI_PROMPT_VERSION)
      ok('7f 确定性报告保持渲染', st.phase === 'done' && st.report === report)
      controller.dispose()
    }

    // 7g–7i 切换年份
    {
      const fake = createFakeApi()
      const controller = createAnnualReviewController(fake.api)
      await controller.loadYears()
      await wait()
      controller.runAiAnalysis()
      await tick()
      fake.setReport({ success: true, cache: 'hit', report: report2024, taskId: 'task-2' })
      controller.selectYear(2024)
      await wait()
      ok('7g 切年后 AI 区块回到初始',
        controller.getState().ai.phase === 'idle' && controller.getState().ai.analysis === null)
      ok('7h 切年取消了在途 AI 请求', fake.cancelCalls.includes('task-1'))
      fake.aiGates[0].resolve(okAi())
      await wait()
      ok('7i 旧年份的迟到结果被丢弃（不覆盖新年份状态）',
        controller.getState().ai.phase === 'idle' && controller.getState().ai.analysis === null &&
        controller.getState().reportTaskId === 'task-2')
      controller.dispose()
    }

    // 7j–7l 重新生成报告
    {
      const fake = createFakeApi()
      const controller = createAnnualReviewController(fake.api)
      await controller.loadYears()
      await wait()
      controller.runAiAnalysis()
      await tick()
      controller.startGenerate()
      await wait()
      ok('7j 重新生成时 AI 区块清空',
        controller.getState().ai.phase === 'idle' && controller.getState().reportTaskId === null)
      ok('7k 重新生成取消了在途 AI 请求', fake.cancelCalls.includes('task-1'))
      fake.aiGates[0].resolve(okAi())
      await wait()
      ok('7l 生成中的迟到 AI 结果不落地', controller.getState().ai.phase === 'idle')
      controller.dispose()
    }

    // 7m–7n 报告身份变化（新的 getReport 结果）
    {
      const fake = createFakeApi()
      const controller = createAnnualReviewController(fake.api)
      await controller.loadYears()
      await wait()
      controller.runAiAnalysis()
      await tick()
      fake.aiGates[0].resolve(okAi())
      await wait()
      ok('7m 分析完成后 AI 区块为 done', controller.getState().ai.phase === 'done')
      fake.setReport({ success: true, cache: 'hit', report, taskId: 'task-NEW' })
      await controller.loadReport(2025)
      await wait()
      ok('7n 报告身份变化 → AI 结果清空（不挂到新报告上）',
        controller.getState().reportTaskId === 'task-NEW' && controller.getState().ai.phase === 'idle' &&
        controller.getState().ai.analysis === null)
      controller.dispose()
    }

    // 8a–8b 取消（主进程确认）
    {
      const fake = createFakeApi()
      const controller = createAnnualReviewController(fake.api)
      await controller.loadYears()
      await wait()
      controller.runAiAnalysis()
      await tick()
      await controller.cancelAiAnalysis()
      await wait()
      ok('8a 取消成功 → phase=cancelled', controller.getState().ai.phase === 'cancelled')
      fake.aiGates[0].resolve(okAi())
      await wait()
      ok('8b 取消后的迟到结果不覆盖「已取消」', controller.getState().ai.phase === 'cancelled')
      controller.dispose()
    }

    // 8c–8d 取消未被确认（没有在途调用）
    {
      const fake = createFakeApi()
      const controller = createAnnualReviewController(fake.api)
      await controller.loadYears()
      await wait()
      controller.runAiAnalysis()
      await tick()
      fake.setAiCancel({ success: false })
      await controller.cancelAiAnalysis()
      await wait()
      ok('8c 未确认取消 → 保持运行中（不显示假取消）', controller.getState().ai.phase === 'running')
      fake.aiGates[0].resolve(okAi())
      await wait()
      ok('8d 未确认取消后响应正常落地（done）', controller.getState().ai.phase === 'done')
      controller.dispose()
    }

    // 8e–8f 卸载
    {
      const fake = createFakeApi()
      const controller = createAnnualReviewController(fake.api)
      await controller.loadYears()
      await wait()
      controller.runAiAnalysis()
      await tick()
      const seen: string[] = []
      controller.subscribe((s) => seen.push(s.ai.phase))
      const before = controller.getState()
      controller.dispose()
      ok('8e 卸载取消了在途 AI 请求', fake.cancelCalls.includes('task-1'))
      fake.aiGates[0].resolve(okAi())
      await wait()
      ok('8f 卸载后迟到结果不更新状态', controller.getState() === before && seen.length === 0)
    }

    // 8g–8i AI 失败不影响报告
    {
      const fake = createFakeApi()
      const controller = createAnnualReviewController(fake.api)
      await controller.loadYears()
      await wait()
      controller.runAiAnalysis()
      await tick()
      fake.aiGates[0].resolve({ success: false, error: { code: 'budget_blocked', message: ANNUAL_REVIEW_AI_FAILURE_MESSAGES.budget_blocked } })
      await wait()
      const st = controller.getState()
      ok('8g AI 失败只落在 AI 区块', st.ai.phase === 'failed' && st.ai.error?.code === 'budget_blocked')
      ok('8h 报告仍为 done 且内容不变', st.phase === 'done' && st.report === report && st.reportTaskId === 'task-1')
      controller.runAiAnalysis()
      ok('8i 失败后仍可重新发起（可重试路径）', controller.getState().ai.phase === 'running')
      controller.dispose()
    }
  }

  // ══ 9. AI 失败不影响确定性报告、任务状态与导出内容 ══
  {
    const h = createService({ now: () => GEN })
    const taskId = await completeGenerate(h)
    const before = h.service.getReport(2025)
    const mdBefore = buildAnnualReviewMarkdown(before.report as AnnualReviewReport)
    const csvBefore = buildAnnualReviewCsv(before.report as AnnualReviewReport)
    const statusBefore = h.service.getTaskStatus(taskId)
    const snapshot = JSON.stringify(before.report)

    const fake = makeGenerate()
    fake.setBehavior('fail')
    fake.setFailure('numeric_claim', 'executiveSummary 含数字声明（命中规则：decimal_digit）')
    const coordinator = new AnnualReviewAiCoordinator({
      getTaskReport: (id) => h.service.getTaskReport(id),
      getConfig: () => fakeConfig,
      generate: fake.generate as never,
      now: () => GEN
    })
    const failed = await coordinator.run(taskId)
    ok('9a AI 失败返回结构化失败码', failed.success === false && failed.error.code === 'numeric_claim')

    const after = h.service.getReport(2025)
    ok('9b 报告缓存仍为命中', after.cache === 'hit')
    eq('9c 报告内容逐字节不变', JSON.stringify(after.report), snapshot)
    eq('9d 任务状态仍为 completed', h.service.getTaskStatus(taskId), statusBefore)
    eq('9e 导出 Markdown 不变', buildAnnualReviewMarkdown(after.report as AnnualReviewReport), mdBefore)
    eq('9f 导出 CSV 不变', buildAnnualReviewCsv(after.report as AnnualReviewReport), csvBefore)

    const freshFake = makeGenerate()
    const okCoordinator = new AnnualReviewAiCoordinator({
      getTaskReport: (id) => h.service.getTaskReport(id),
      getConfig: () => fakeConfig,
      generate: freshFake.generate as never,
      now: () => GEN
    })
    const okRes = await okCoordinator.run(taskId)
    ok('9g AI 成功同样不改报告/不改任务状态',
      okRes.success === true &&
      JSON.stringify(h.service.getReport(2025).report) === snapshot &&
      JSON.stringify(h.service.getTaskStatus(taskId)) === JSON.stringify(statusBefore))
    ok('9h AI 未触发任何重新生成（service 未新增任务）',
      h.runnerCalls.filter((c) => c.payload.taskId === taskId).length === 1)
  }

  // ══ 10 & 11. 渲染层：严格渲染、无 HTML 注入、metricKeys 只引用报告 coverage ══
  {
    const report = buildReport(2025)
    const base = reduceReportResult({ ...initialAnnualReviewState(), selectedYear: 2025 }, { success: true, cache: 'hit', report, taskId: 'task-1' }, 2025)
    const running = reduceAiStart(base, GEN) // 先发起（绑定报告身份 + 起始时刻），再落结果
    const injected = '<img src=x onerror="alert(1)"><script>alert(2)</script>'
    const analysis: AnnualReviewAiAnalysis = {
      executiveSummary: injected,
      diagnoses: [{ title: injected, observation: injected, hypothesis: injected, metricKeys: [KEY_AMOUNT], confidence: 'high' }],
      actions: [{ priority: 1, action: injected, rationale: injected, metricKeys: [KEY_CREDITED], horizon: 'next_year' }],
      risks: [{ risk: injected, metricKeys: [KEY_VOLUME] }]
    }
    const state = reduceAiResult(running, { success: true, analysis, model: 'm', promptVersion: 'v', generatedAt: GEN, cached: false })
    ok('10a 文本按纯文本原样透传（渲染层不做 HTML 解析）',
      state.ai.analysis?.executiveSummary === injected &&
      state.ai.analysis?.diagnoses[0].title === injected &&
      state.ai.analysis?.actions[0].action === injected &&
      state.ai.analysis?.risks[0].risk === injected)
    const pageSrc = readFileSync(join(ROOT, 'src', 'pages', 'AnnualReviewPage.tsx'), 'utf8')
    const viewSrc = readFileSync(join(ROOT, 'src', 'utils', 'annualReviewView.ts'), 'utf8')
    ok('10b 页面不使用 dangerouslySetInnerHTML / innerHTML',
      !/dangerouslySetInnerHTML\s*[:=]/.test(pageSrc) && !/\.innerHTML\s*=/.test(pageSrc))
    ok('10c 视图模块不注入 HTML',
      !/dangerouslySetInnerHTML\s*[:=]/.test(viewSrc) && !/\.innerHTML\s*=/.test(viewSrc))
    ok('10d 页面不解析 AI 文本里的数字（无数值提取）',
      !/parseFloat\(|parseInt\(|Number\(/.test(pageSrc.replace(/Number\(e\.target\.value\)/g, '')))
    ok('10e priority 用稳定标签展示（不裸渲染数字）', pageSrc.includes('aiPriorityLabel('))
    ok('10f AI 区块与报告区块解耦（失败不隐藏报告）',
      pageSrc.includes('{phase === \'done\' && state.report && (') && pageSrc.includes('<AiAnalysisSection'))

    const cells = buildAiMetricCells(report, [KEY_AMOUNT, 'not.in.coverage', KEY_CREDITED])
    eq('11a 未知 metricKey 被丢弃', cells.map((c) => c.key), [KEY_AMOUNT, KEY_CREDITED])
    const amountText = `¥${(report.summary.contractAmount.value as number).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`
    const creditedText = `¥${(report.summary.creditedAmount.value as number).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`
    eq('11b 标量键取报告里的确定性数值', cells[0].displayValue, amountText)
    eq('11c 数值与报告一致（不含任何 AI 文本数字）', cells[1].displayValue, creditedText)
    ok('11d 重复键去重', buildAiMetricCells(report, [KEY_AMOUNT, KEY_AMOUNT]).length === 1)
    ok('11e 非标量键不伪造数值（给状态与所在区块）', (() => {
      const [cell] = buildAiMetricCells(report, ['customers.highValue'])
      return cell.displayValue === null && cell.state.length > 0 && typeof cell.valueHint === 'string'
    })())
    ok('11f unavailable 不显示为 0', (() => {
      const patched = JSON.parse(JSON.stringify(report)) as AnnualReviewReport
      patched.summary.contractAmount = { value: null, state: 'unavailable', warnings: [] }
      const [cell] = buildAiMetricCells(patched, [KEY_AMOUNT])
      return cell.displayValue === null && cell.state === 'unavailable'
    })())
    ok('11g 键集合以报告 coverage 为准（报告缺键即不展示）', (() => {
      const patched = JSON.parse(JSON.stringify(report)) as AnnualReviewReport
      delete (patched.coverage as Record<string, unknown>)[KEY_AMOUNT]
      return buildAiMetricCells(patched, [KEY_AMOUNT]).length === 0
    })())
    ok('11h 无报告身份时不进入运行中', reduceAiStart(initialAnnualReviewState(), GEN).ai.phase === 'idle')
    ok('11l 发起时记录起始时刻（用于运行中用时展示）', reduceAiStart(base, GEN).ai.startedAt === GEN)
    ok('11i 取消状态保留任务身份（便于重试）',
      reduceAiCancelled(state).ai.taskId === 'task-1' && reduceAiCancelled(state).ai.phase === 'cancelled')
    ok('11j 初始 AI 状态为空',
      initialAnnualReviewAiState().phase === 'idle' && initialAnnualReviewAiState().analysis === null)
    ok('11k 每个诊断/行动/风险都必须带 metricKeys（契约由主进程强制，页面按契约渲染）',
      ['metricKeys' in analysis.diagnoses[0], 'metricKeys' in analysis.actions[0], 'metricKeys' in analysis.risks[0]].every(Boolean))
  }

  // ══ 12. 缓存边界：账号 / 报告身份 / promptVersion 隔离 + 失效/过期 ══
  {
    const keyA = annualReviewAiCacheKey('scope-a', 'task-1', 'annual_review_ai_v1')
    ok('12a 不同账号作用域 → 不同缓存键', keyA !== annualReviewAiCacheKey('scope-b', 'task-1', 'annual_review_ai_v1'))
    ok('12b 不同报告身份 → 不同缓存键', keyA !== annualReviewAiCacheKey('scope-a', 'task-2', 'annual_review_ai_v1'))
    ok('12c 不同 promptVersion → 不同缓存键', keyA !== annualReviewAiCacheKey('scope-a', 'task-1', 'annual_review_ai_v2'))
    ok('12d 相同三元组 → 相同缓存键', keyA === annualReviewAiCacheKey('scope-a', 'task-1', 'annual_review_ai_v1'))

    const h = createService({ now: () => GEN })
    const taskId = await completeGenerate(h)
    const fake = makeGenerate()
    const coordinator = new AnnualReviewAiCoordinator({
      getTaskReport: (id) => h.service.getTaskReport(id),
      getConfig: () => fakeConfig,
      generate: fake.generate as never,
      now: () => GEN
    })
    const okRun = await coordinator.run(taskId)
    ok('12e 首次调用成功并写缓存', okRun.success === true && coordinator.cacheSize() === 1)
    coordinator.invalidateAll()
    ok('12f invalidateAll 清空结果缓存', coordinator.cacheSize() === 0)
    const againRes = await coordinator.run(taskId)
    ok('12g 失效后重新调用模型（不复用旧结果）',
      againRes.success === true && againRes.cached === false && fake.calls.length === 2)

    const fake2 = makeGenerate()
    fake2.setBehavior('hang')
    const coordinator2 = new AnnualReviewAiCoordinator({
      getTaskReport: (id) => h.service.getTaskReport(id),
      getConfig: () => fakeConfig,
      generate: fake2.generate as never,
      now: () => GEN
    })
    const pending = coordinator2.run(taskId)
    await tick()
    coordinator2.invalidateAll()
    await tick()
    ok('12h 失效中止在途调用', fake2.calls[0].signal?.aborted === true)
    fake2.resolveHang({ ok: true, analysis: ANALYSIS, model: 'm', promptVersion: ANNUAL_REVIEW_AI_PROMPT_VERSION, generatedAt: GEN })
    const invalidated = await pending
    ok('12i 失效期间在途结果 → invalidated（既不返回成功也不缓存）',
      invalidated.success === false && invalidated.error.code === 'invalidated' && coordinator2.cacheSize() === 0)

    let clock = GEN
    const fake3 = makeGenerate()
    const coordinator3 = new AnnualReviewAiCoordinator({
      getTaskReport: (id) => h.service.getTaskReport(id),
      getConfig: () => fakeConfig,
      generate: fake3.generate as never,
      now: () => clock,
      ttlMs: 1000
    })
    await coordinator3.run(taskId)
    clock = GEN + 1001
    const expired = await coordinator3.run(taskId)
    ok('12j 缓存过期后重新调用模型',
      expired.success === true && expired.cached === false && fake3.calls.length === 2)

    // 跨账号在缓存层面的隔离：同一 taskId 在不同作用域下不共享结果
    const other = new AnnualReviewAiCoordinator({
      getTaskReport: () => ({ ok: true, report: buildReport(2025), year: 2025, internalScopeId: JSON.stringify(['wx-b', 'sales-b', 'crm-b']) }),
      getConfig: () => fakeConfig,
      generate: fake.generate as never,
      now: () => GEN
    })
    const otherRes = await other.run(taskId)
    ok('12k 不同账号作用域下同一 taskId 不命中他账号缓存',
      otherRes.success === true && otherRes.cached === false && fake.calls.length === 3)
  }

  // ══ 13. 通道与签名一致（源码守卫，作为行为测试的补充） ══
  {
    const mainSrc = readFileSync(join(ROOT, 'electron', 'main.ts'), 'utf8')
    const preloadSrc = readFileSync(join(ROOT, 'electron', 'preload.ts'), 'utf8')
    const dtsSrc = readFileSync(join(ROOT, 'src', 'types', 'electron.d.ts'), 'utf8')
    for (const channel of ['annualReview:aiAnalysis', 'annualReview:aiAnalysisCancel']) {
      ok(`13a main.ts 注册 ${channel}`, mainSrc.includes(`'${channel}'`))
      ok(`13b preload 对接 ${channel}`, preloadSrc.includes(`'${channel}'`))
    }
    ok('13c preload 只传 { taskId }（不上传报告）',
      preloadSrc.includes("invoke('annualReview:aiAnalysis', { taskId })") &&
      preloadSrc.includes("invoke('annualReview:aiAnalysisCancel', { taskId })"))
    ok('13d main.ts 校验 taskId 并只把它交给协调器', (() => {
      const start = mainSrc.indexOf("ipcMain.handle('annualReview:aiAnalysis'")
      const end = mainSrc.indexOf("ipcMain.handle('annualReview:aiAnalysisCancel'", start)
      const seg = mainSrc.slice(start, end)
      return seg.includes('validateAnnualReviewTaskId(taskId)') && seg.includes('annualReviewAiCoordinator.run(taskId') &&
        !seg.includes('report')
    })())
    ok('13e main.ts 绑定窗口销毁中止', mainSrc.includes('bindAnnualReviewAiSenderAbort(event.sender)'))
    ok('13f electron.d.ts 声明 aiAnalysis/aiCancel',
      dtsSrc.includes('aiAnalysis: (taskId: string)') && dtsSrc.includes('aiCancel: (taskId: string)'))
    ok('13g d.ts 使用 shared 契约（非镜像副本）',
      dtsSrc.includes("from '../../shared/annualReviewAi'") && dtsSrc.includes('AnnualReviewAiAnalysisResponse'))
    ok('13h 主进程不复制第二套模型出口（只用已验收服务层）', (() => {
      const coordSrc = readFileSync(join(ROOT, 'electron', 'services', 'annualReviewAiCoordinator.ts'), 'utf8')
      return coordSrc.includes('generateAnnualReviewAiAnalysis') &&
        !/from '\.\/ai\/aiApiClient'/.test(coordSrc) && !/from '\.\/ai\/aiBudget'/.test(coordSrc) &&
        !coordSrc.includes('callChatCompletion') && !coordSrc.includes('ANNUAL_REVIEW_AI_SYSTEM_PROMPT')
    })())
    ok('13i AI 接线不新增数据库表/不做持久化', (() => {
      const coordSrc = readFileSync(join(ROOT, 'electron', 'services', 'annualReviewAiCoordinator.ts'), 'utf8')
      return !/CREATE TABLE|INSERT INTO|writeFileSync|\.exec\(/.test(coordSrc)
    })())
  }

  // ══ 14. 词表完整性 + 真实服务层集成（唯一出口，不复制 prompt/校验/客户端） ══
  {
    const expected = [
      'invalid_report', 'unsupported_report_contract', 'not_configured', 'budget_blocked',
      'call_failed', 'empty_output', 'invalid_json', 'invalid_shape', 'numeric_claim'
    ]
    eq('14a 九个 AI 失败码逐字保留', [...ANNUAL_REVIEW_AI_CORE_FAILURE_CODES].sort(), [...expected].sort())
    ok('14b 页面词表覆盖全部核心码', expected.every((code) => AI_FAILURE_CODES.includes(code)))
    // 五个调用/报告类失败码有服务层固定文案；四个解析类失败码的文案由 core 解析器逐次给出
    const serviceLevelCodes = ['invalid_report', 'unsupported_report_contract', 'not_configured', 'budget_blocked', 'call_failed']
    ok('14c1 S7.1 固定文案表覆盖调用/报告类失败码',
      serviceLevelCodes.every((code) => typeof (ANNUAL_REVIEW_AI_FAILURE_MESSAGES as Record<string, string>)[code] === 'string'))
    ok('14c2 四个解析类失败码由 core 逐次给出', (() => {
      const parseCases = [
        parseAnnualReviewAiOutput('', []),
        parseAnnualReviewAiOutput('不是 JSON', []),
        parseAnnualReviewAiOutput('[]', []),
        parseAnnualReviewAiOutput(JSON.stringify({ executiveSummary: '增长了八成', diagnoses: [], actions: [], risks: [] }), [])
      ]
      const codes = parseCases.map((r) => (r.ok ? '' : r.code)).sort()
      const messagesOk = parseCases.every((r) => !r.ok && r.message.length > 0)
      return JSON.stringify(codes) === JSON.stringify(['empty_output', 'invalid_json', 'invalid_shape', 'numeric_claim']) && messagesOk
    })())
    ok('14d promptVersion 与账本口径稳定', ANNUAL_REVIEW_AI_PROMPT_VERSION === 'annual_review_ai_v1')

    // 真实服务层链路：coordinator → generateAnnualReviewAiAnalysis（注入 completion，不发真实请求）
    const h = createService({ now: () => GEN })
    const taskId = await completeGenerate(h)
    const makeReal = (completion: AnnualReviewAiCompletion, extra: { configured?: boolean } = {}) => new AnnualReviewAiCoordinator({
      getTaskReport: (id) => h.service.getTaskReport(id),
      getConfig: () => fakeConfig,
      configured: extra.configured ?? true,
      completion,
      generate: generateAnnualReviewAiAnalysis,
      now: () => GEN
    })

    const okCompletion: AnnualReviewAiCompletion = async () => validModelJson()
    const success = await makeReal(okCompletion).run(taskId)
    ok('14e 真实解析链路成功（严格 JSON 通过）',
      success.success === true && success.analysis.diagnoses.length === 1 &&
      success.analysis.actions[0].horizon === 'next_quarter')
    ok('14f 真实链路模型名与 promptVersion 可追溯',
      success.success === true && success.model === 'injected-completion' && success.promptVersion === ANNUAL_REVIEW_AI_PROMPT_VERSION)

    const numeric = await makeReal(async () => JSON.stringify({ ...JSON.parse(validModelJson()), executiveSummary: '回款增长了八成，客户结构稳定。' })).run(taskId)
    ok('14g 数字声明 → numeric_claim（真实规则表）', numeric.success === false && numeric.error.code === 'numeric_claim')

    const empty = await makeReal(async () => '').run(taskId)
    ok('14h 空输出 → empty_output', empty.success === false && empty.error.code === 'empty_output')

    const notJson = await makeReal(async () => '这不是 JSON').run(taskId)
    ok('14i 非 JSON → invalid_json（固定文案）', notJson.success === false && notJson.error.code === 'invalid_json')

    const unknownKey = await makeReal(async () => JSON.stringify({
      ...JSON.parse(validModelJson()),
      diagnoses: [{ title: '标题', observation: '观察', hypothesis: '假设', metricKeys: ['summary.unknownKey'], confidence: 'low' }]
    })).run(taskId)
    ok('14j 未知 metricKey → invalid_shape（不部分采信）', unknownKey.success === false && unknownKey.error.code === 'invalid_shape')

    const notConfigured = await makeReal(okCompletion, { configured: false }).run(taskId)
    ok('14k 未配置 → not_configured（固定文案）',
      notConfigured.success === false && notConfigured.error.code === 'not_configured' &&
      notConfigured.error.message === ANNUAL_REVIEW_AI_FAILURE_MESSAGES.not_configured)

    const budget = await makeReal(async () => { throw new AiBudgetBlockedError('日调用上限已用尽') }).run(taskId)
    ok('14l 额度阻断 → budget_blocked（与模型故障区分）',
      budget.success === false && budget.error.code === 'budget_blocked' &&
      budget.error.message === ANNUAL_REVIEW_AI_FAILURE_MESSAGES.budget_blocked)

    const leaky = await makeReal(async () => {
      throw new Error('API 返回格式异常: https://api.example.com Bearer sk-live-abcdefghijklmnop /Users/x/weflow.db')
    }).run(taskId)
    ok('14m 底层异常脱敏（call_failed 固定文案，无 URL/Token/路径）',
      leaky.success === false && leaky.error.code === 'call_failed' &&
      leaky.error.message === ANNUAL_REVIEW_AI_FAILURE_MESSAGES.call_failed &&
      !JSON.stringify(leaky).includes('api.example.com') && !JSON.stringify(leaky).includes('sk-live'))
  }
}

main().then(() => {
  console.log(`结果：${pass} 通过 / ${fail} 失败`)
  process.exit(fail > 0 ? 1 : 0)
}).catch((e) => {
  console.error('FATAL:', e)
  process.exit(1)
})
