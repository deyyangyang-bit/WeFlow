/**
 * annual-review-view-test.ts —— 年度经营复盘 S4 护栏（页面状态机纯函数 + controller）
 *
 * 仓库无 React 测试基础设施（不新增依赖）：页面状态转换全部抽在
 * src/utils/annualReviewView.ts（纯模块），本脚本用假 API 驱动 controller 全状态机；
 * 另以源码守卫覆盖路由/Sidebar 接线。
 *
 * 覆盖：年份列表与默认年份（不本地推断）／进度与取消／连续生成旧任务隔离／
 *       监听器精确卸载与无泄漏／unavailable 不显示 0／partial、snapshot_only 文案／
 *       报告缺必需字段拒绝渲染成功态／视图无 sessionId/路径/秘密／路由与 Sidebar 接线
 * 运行：npx tsx scripts/annual-review-view-test.ts
 */
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import {
  createAnnualReviewController,
  buildSummaryCells,
  customerDetailHref,
  funnelKindLabel,
  identityLabelSafe,
  initialAnnualReviewState,
  reduceProgressEvent,
  reduceTerminalEvent,
  METRIC_STATE_LABELS,
  type AnnualReviewApi,
  type AnnualReviewProgressEvent,
  type AnnualReviewReport
} from '../src/utils/annualReviewView'
import { composeAnnualReviewReport } from '../electron/services/annualReviewReport'
import { resolveAnnualReviewPeriod, type AnnualReviewFacts, type AnnualReviewMessageStats } from '../electron/services/annualReviewStats'
import type { AnnualReviewSalesSegmentsFacts, AnnualReviewCrmSegmentsFacts } from '../electron/services/annualReviewSegments'

let pass = 0, fail = 0
function ok(name: string, cond: boolean): void {
  if (cond) { pass++ } else { fail++; console.error('FAIL:', name) }
}
const tick = (): Promise<void> => new Promise((r) => setImmediate(r))
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const T = (y: number, m: number, d: number, hh = 0, mm = 0, ss = 0, ms = 0): number =>
  new Date(y, m - 1, d, hh, mm, ss, ms).getTime()
const GEN = T(2026, 6, 15, 12, 0, 0)

// ── 夹具：与 service 测试同构的最小事实 ──
const facts: AnnualReviewFacts = {
  accounts: [
    { id: 1, name: '客户1', createdAt: T(2025, 2, 1), importedAt: null, sessionId: 'wxid_secret999', lastContactAtSec: null },
    { id: 2, name: '客户2', createdAt: T(2024, 3, 1), importedAt: null, sessionId: 'wxid_other888', lastContactAtSec: null }
  ],
  contracts: [{ id: 1, accountId: 1, amount: 1200, status: 'signed', signDate: T(2025, 3, 1), createdAt: T(2024, 1, 1) }],
  allocations: [{ id: 1, accountId: 1, creditedAmount: 800.5, reconciledAt: T(2025, 4, 1), status: 'confirmed', reconciliationStatus: 'allocated', confirmedAt: null, contractId: 1 }],
  shippedEvents: []
}
const sales: AnnualReviewSalesSegmentsFacts = { profiles: [{ id: 1, sessionId: 'wxid_secret999', stage: 'quoted', lastContactAtSec: null, customerId: '501' }], intentEvents: [] }
const crm: AnnualReviewCrmSegmentsFacts = { opportunities: [], opportunityEvents: [] }
const messageStats: AnnualReviewMessageStats = { ok: true, sessions: { wxid_secret999: { sent: 2, received: 1 } } }
const realReport: AnnualReviewReport = composeAnnualReviewReport({ period: resolveAnnualReviewPeriod(2025, GEN), facts, sales, crm, opts: { messageStats } })

// ── 假 API ──
interface FakeApi {
  api: AnnualReviewApi
  calls: { generate: number; cancel: number; subscribe: number; unsubscribe: number; getReport: number }
  gates: Array<Deferred<{ success: boolean; taskId?: string; reused?: boolean; error?: { code: string; message: string } }>>
  reportResults: Array<{ success: boolean; cache: 'hit' | 'miss' | 'stale'; report?: AnnualReviewReport; error?: { code: string; message: string } }>
  setCancelShouldFail(v: boolean): void
  emit: (event: AnnualReviewProgressEvent) => void
}
function createFakeApi(opts?: { reportResults?: FakeApi['reportResults']; yearsResult?: Awaited<ReturnType<AnnualReviewApi['getAvailableYears']>>; manualStart?: boolean }): FakeApi {
  const calls = { generate: 0, cancel: 0, subscribe: 0, unsubscribe: 0, getReport: 0 }
  const gates: FakeApi['gates'] = []
  let gateSeq = 0
  let cancelShouldFail = false
  let issuedTaskId: string | null = null
  const reportResults = opts?.reportResults ?? [{ success: true, cache: 'miss' as const }]
  let progressCb: ((e: AnnualReviewProgressEvent) => void) | null = null
  const api: AnnualReviewApi = {
    getAvailableYears: async () => opts?.yearsResult ?? {
      success: true,
      data: { years: [{ year: 2025, coverage: { source: 'x', status: 'complete', rows: 3 } }, { year: 0, coverage: { source: 'x', status: 'complete', rows: 7 } }], currentYear: 2026, supportsAllTime: true, defaultYear: 2021, generatedAt: 0 }
    },
    getReport: async () => {
      calls.getReport++
      const next = reportResults.shift()
      return next ?? { success: true, cache: 'miss' }
    },
    generate: async () => {
      calls.generate++
      const gate = deferred<{ success: boolean; taskId?: string; reused?: boolean; error?: { code: string; message: string } }>()
      gates.push(gate)
      return gate.promise
    },
    cancel: async () => {
      calls.cancel++
      if (cancelShouldFail) throw new Error('cancel failed')
      return { success: true }
    },
    setCancelShouldFail: (v: boolean) => { cancelShouldFail = v },
    subscribeProgress: (cb) => {
      calls.subscribe++
      progressCb = cb
      return () => {
        calls.unsubscribe++
        progressCb = null
      }
    }
  }
  const fake: FakeApi = {
    api, calls, gates, reportResults,
    setCancelShouldFail: (v: boolean) => { cancelShouldFail = v },
    emit: (e) => progressCb?.(e)
  }
  // 默认启动响应：resolve 为 { success:true, taskId: 'g<N>' }；
  // manualStart=true 时不自动 resolve（由用例显式控制「响应前/后」的事件时序）
  void (function patchGates() {
    const origPush = gates.push.bind(gates)
    gates.push = (gate) => {
      gateSeq++
      // cancelShouldFail=true 模拟主进程同键合并：复用首个 taskId（reused=true）
      const taskId = cancelShouldFail && issuedTaskId !== null ? issuedTaskId : `g${gateSeq}`
      if (issuedTaskId === null) issuedTaskId = taskId
      if (opts?.manualStart !== true) {
        void Promise.resolve().then(() => {
          if (!gate.__settled) gate.resolve({ success: true, taskId, reused: taskId === issuedTaskId && gateSeq > 1 })
        })
      }
      return origPush(gate)
    }
    Object.defineProperty(gates, 'push', { value: gates.push, writable: true, configurable: true })
  })()
  return fake
}

async function main(): Promise<void> {
  // ══ 1 年份列表与默认年份（来自主进程，UI 不本地推断） ═══════════════════════
  {
    const fake = createFakeApi()
    const ctrl = createAnnualReviewController(fake.api)
    ok('1 初始 loading', ctrl.getState().phase === 'loading' && ctrl.getState().years.loading === true)
    await ctrl.loadYears()
    const s = ctrl.getState()
    ok('1b 年份列表（自然年升序、0 末尾）', s.years.years.map((y) => y.year).join(',') === '2025,0')
    ok('1c 默认年份取主进程 defaultYear=2021（非本地当前年）', s.selectedYear === 2021 && s.years.defaultYear === 2021)
    ok('1d 首载自动查询该年缓存（2025 无缓存 → idle 可生成）', fake.calls.getReport === 1 && ctrl.getState().phase === 'idle')
    ctrl.dispose()
  }

  // ══ 2 任务进度、取消与终态事件（非阻塞启动 + 事件驱动完成） ═══════════════
  {
    const fake = createFakeApi()
    const ctrl = createAnnualReviewController(fake.api)
    await ctrl.loadYears()
    await tick()
    ctrl.startGenerate()
    await tick()
    ok('2 启动即绑定 taskId（非阻塞，可取消）', ctrl.getState().phase === 'generating' &&
      ctrl.getState().generation.taskId === 'g1' && ctrl.getState().generation.cancellable === true)
    fake.emit({ taskId: 'g1', year: 2021, phase: 'computing', progress: 40, done: false })
    fake.emit({ taskId: 'g1', year: 2021, phase: 'computing', progress: 70, done: false, statusText: '计算年度统计' })
    fake.emit({ taskId: 'g1', year: 2021, phase: 'computing', progress: 55, done: false }) // 乱序 → 不回退
    const s = ctrl.getState()
    ok('2b 进度单调推进（按 taskId 严格过滤）', s.generation.progress === 70 && s.generation.statusText === '计算年度统计')
    await ctrl.cancelGeneration()
    ok('2c cancel 携带正确 taskId', fake.calls.cancel === 1)
    fake.emit({ taskId: 'g1', year: 2021, phase: 'failed', progress: 70, done: true, error: { code: 'cancelled', message: '年度复盘生成已取消' } })
    ok('2d 终态事件收敛 cancelled（未写缓存）', ctrl.getState().phase === 'cancelled' && ctrl.getState().report === null)
    ctrl.dispose()
  }

  // ══ 3 生成成功（completed 终态事件 → getReport → 渲染） ═══════════════════
  {
    const fake = createFakeApi({ reportResults: [{ success: true, cache: 'miss' }, { success: true, cache: 'hit', report: realReport }] })
    const ctrl = createAnnualReviewController(fake.api)
    await ctrl.loadYears()
    await tick()
    ctrl.startGenerate()
    await tick()
    fake.emit({ taskId: 'g1', year: 2021, phase: 'computing', progress: 90, done: false })
    fake.emit({ taskId: 'g1', year: 2021, phase: 'completed', progress: 100, done: true })
    await tick(); await tick()
    const s = ctrl.getState()
    ok('3 completed 事件驱动渲染 done', s.phase === 'done' && s.report?.year === 2025)
    ok('3b overall 徽标档位', s.overallBadge === 'unavailable')
    ok('3c 渲染后生成状态清理（taskId 置空、不可取消）', s.generation.taskId === null && s.generation.cancellable === false)
    ctrl.dispose()
  }

  // ══ 4 任务生命周期隔离（切年/重生成/迟到事件） ════════════════════════════
  {
    // 4a progress 前切年：启动响应迟到 → 仍取消刚启动的任务
    const fake = createFakeApi()
    const ctrl = createAnnualReviewController(fake.api)
    await ctrl.loadYears()
    await tick()
    ctrl.startGenerate() // gate 未 resolve：响应未返回
    await tick()
    ctrl.selectYear(2025) // 首条 progress 前切年
    await tick()
    fake.gates[0].resolve({ success: true, taskId: 'late-task' }) // 迟到的启动响应
    await tick(); await tick()
    ok('4a progress 前切年 → 迟到启动响应触发取消', fake.calls.cancel === 1)

    // 4b progress 后切年：按当前 taskId 取消
    const fake2 = createFakeApi()
    const ctrl2 = createAnnualReviewController(fake2.api)
    await ctrl2.loadYears()
    await tick()
    ctrl2.startGenerate()
    await tick()
    fake2.emit({ taskId: 'g1', year: 2021, phase: 'computing', progress: 30, done: false })
    ctrl2.selectYear(2025)
    await tick()
    ok('4b 切年按当前 taskId 取消', fake2.calls.cancel === 1)
    fake2.emit({ taskId: 'g1', year: 2021, phase: 'computing', progress: 90, done: false }) // 旧任务事件 → 忽略
    ok('4b2 切年后旧任务事件被忽略', ctrl2.getState().phase !== 'generating')
    ctrl2.dispose()

    // 4c 同年重新生成：旧任务先取消、旧事件不得污染新任务
    const fake3 = createFakeApi()
    const ctrl3 = createAnnualReviewController(fake3.api)
    await ctrl3.loadYears()
    await tick()
    ctrl3.startGenerate()
    await tick() // g1 绑定
    ctrl3.startGenerate() // 重新生成：先取消 g1，再启动新任务
    await tick()
    ok('4c 同年重生成先取消旧任务（cancel≥1）', fake3.calls.cancel >= 1)
    const newTaskId = ctrl3.getState().generation.taskId
    ok('4c2 新代际已绑定新 taskId', typeof newTaskId === 'string' && newTaskId !== 'g1')
    fake3.emit({ taskId: 'g1', year: 2021, phase: 'failed', progress: 60, done: true, error: { code: 'cancelled', message: '旧任务' } }) // 旧任务终态 → 忽略
    ok('4c3 旧任务终态事件不覆盖新任务（仍 generating）', ctrl3.getState().phase === 'generating')
    fake3.emit({ taskId: newTaskId as string, year: 2021, phase: 'computing', progress: 50, done: false })
    ok('4c4 新任务事件正常推进', ctrl3.getState().generation.progress === 50)

    // 4d 两个年份交错事件（taskId 隔离）
    fake3.emit({ taskId: 'other-year', year: 2025, phase: 'computing', progress: 99, done: false })
    ok('4d 其他年份/任务事件被忽略', ctrl3.getState().generation.progress === 50)
    ctrl3.dispose()

    // 4e cancel 失败：不假装终止，但同键合并后旧任务仍被跟踪、迟到结果不得覆盖
    const fake4 = createFakeApi()
    fake4.setCancelShouldFail(true)
    const ctrl4 = createAnnualReviewController(fake4.api)
    await ctrl4.loadYears()
    await tick()
    ctrl4.startGenerate()
    await tick() // g1
    ctrl4.startGenerate() // cancel 失败 → 主进程合并（reused=g1），页面绑定 g1 继续
    await tick()
    ok('4e cancel 失败不假装终止（仍 generating 且跟踪合并任务）', ctrl4.getState().phase === 'generating' &&
      ctrl4.getState().generation.taskId === 'g1')
    fake4.emit({ taskId: 'g1', year: 2021, phase: 'failed', progress: 40, done: true, error: { code: 'worker_error', message: '失败' } })
    ok('4e2 合并任务终态事件正常收敛（不悬挂）', ctrl4.getState().phase === 'failed')
    ctrl4.dispose()
  }

  // ══ 5 监听器精确卸载 + 页面卸载无泄漏 ══════════════════════════════════════
  {
    const fake = createFakeApi()
    const ctrl = createAnnualReviewController(fake.api)
    ok('5 创建时订阅一次', fake.calls.subscribe === 1)
    let notified = 0
    const unsub = ctrl.subscribe(() => notified++)
    ctrl.dispose()
    ok('5b dispose 精确卸载进度订阅（恰一次）', fake.calls.unsubscribe === 1)
    ctrl.dispose() // 幂等
    ok('5c dispose 幂等（不重复卸载）', fake.calls.unsubscribe === 1)
    fake.emit({ taskId: 't9', year: 2025, phase: 'computing', progress: 50, done: false })
    ok('5d dispose 后事件不再进入状态机', notified === 0 && ctrl.getState().generation.progress === 0)
    unsub()
    // 卸载时 taskId 已绑定 → dispose 取消运行中任务
    const fake2 = createFakeApi()
    const ctrl2 = createAnnualReviewController(fake2.api)
    await ctrl2.loadYears()
    await tick()
    ctrl2.startGenerate()
    await tick()
    ctrl2.dispose()
    ok('5e 页面卸载时清理运行中任务（cancel 被调用）', fake2.calls.cancel === 1)
  }

  // ══ 8 报告缺少必需字段时拒绝渲染成功态 ═════════════════════════════════════
  {
    const fake = createFakeApi({
      reportResults: [
        { success: true, cache: 'miss' },
        { success: true, cache: 'hit', report: { year: 2025, generatedAt: GEN } as unknown as AnnualReviewReport }
      ]
    })
    const ctrl = createAnnualReviewController(fake.api)
    await ctrl.loadYears()
    await tick()
    ctrl.startGenerate()
    await tick()
    fake.emit({ taskId: 'g1', year: 2021, phase: 'completed', progress: 100, done: true })
    await tick(); await tick()
    const s = ctrl.getState()
    ok('8 缺必需字段 → failed（拒绝渲染成功态，不崩溃）', s.phase === 'failed' && s.error?.code === 'invalid_report' && s.report === null)
    ctrl.dispose()
  }

  // ══ 10 纯 reducer 基础行为 ═════════════════════════════════════════════════
  {
    const s0 = initialAnnualReviewState()
    const idle = { ...s0, phase: 'done' as const }
    ok('10 非 generating 阶段进度事件被忽略', reduceProgressEvent(idle, { taskId: 't', year: 2025, phase: 'computing', progress: 50, done: false }) === idle)
    const gen = { ...s0, phase: 'generating' as const, selectedYear: 2025, generation: { taskId: 'ta', progress: 0, cancellable: true } }
    const stepped = reduceProgressEvent(gen, { taskId: 'ta', year: 2025, phase: 'loading', progress: 20, done: false })
    ok('10b 当前任务事件正常推进', stepped.generation.progress === 20)
    const otherTask = reduceProgressEvent(stepped, { taskId: 'tb', year: 2025, phase: 'computing', progress: 90, done: false })
    ok('10c 其他 taskId 事件被忽略（旧任务隔离）', otherTask.generation.progress === 20)
    const terminal = reduceTerminalEvent(stepped, { taskId: 'ta', year: 2025, phase: 'failed', progress: 20, done: true, error: { code: 'cancelled', message: '已取消' } })
    ok('10d 终态 reducer：cancelled 收敛', terminal.phase === 'cancelled')
    const terminalFail = reduceTerminalEvent(stepped, { taskId: 'ta', year: 2025, phase: 'failed', progress: 20, done: true, error: { code: 'worker_error', message: '失败' } })
    ok('10e 终态 reducer：failed 收敛', terminalFail.phase === 'failed' && terminalFail.error?.code === 'worker_error')
  }

  // ══ 6 unavailable 不显示 0 ═════════════════════════════════════════════════
  {
    // 2026 当年报告：A8=0 → A9 客单价 unavailable；A6 核销=真实零（显示 ¥0）
    const report2026 = composeAnnualReviewReport({ period: resolveAnnualReviewPeriod(2026, GEN), facts, sales, crm, opts: { messageStats } })
    const cells2026 = buildSummaryCells(report2026)
    const avg = cells2026.find((c) => c.key === 'avgDealSize')
    ok('6 unavailable 指标无数值（displayValue=null，禁止显示 0）', avg !== undefined &&
      avg.displayValue === null && avg.stateLabel === '暂无可靠数据' && report2026.summary.avgDealSize.value === null)
    const total = cells2026.find((c) => c.key === 'customerTotal')
    ok('6b 完整指标正常显示数值', total !== undefined && total.displayValue === '2' && total.state === 'complete')
    const amount = cells2026.find((c) => c.key === 'creditedAmount')
    ok('6c 金额格式化（真实零显示 ¥0，非 unavailable）', amount !== undefined && amount.displayValue === '¥0' &&
      report2026.summary.creditedAmount.value === 0 && report2026.summary.creditedAmount.state === 'complete')
  }

  // ══ 7 partial / snapshot_only / 重建 文案 ══════════════════════════════════
  {
    ok('7 四态文案稳定', METRIC_STATE_LABELS.complete === '完整' && METRIC_STATE_LABELS.partial === '部分完整' &&
      METRIC_STATE_LABELS.snapshot_only === '当前快照' && METRIC_STATE_LABELS.unavailable === '暂无可靠数据')
    const snapshot = funnelKindLabel('current_snapshot', null)
    const rebuilt = funnelKindLabel('historical_reconstruction', 0.834)
    const rebuiltNoRatio = funnelKindLabel('historical_reconstruction', null)
    ok('7b 当前快照与历史年末重建文案明确不同', snapshot === '当前快照（截至生成时间）' &&
      rebuilt === '历史年末重建（覆盖率 83%）' && rebuiltNoRatio === '历史年末重建' && snapshot !== rebuilt)
    // 2025 历史年度：A1 存量受物理删除影响 → partial + tombstone_gap 降级说明
    const partialCell = buildSummaryCells(realReport).find((c) => c.key === 'customerTotal')
    ok('7c partial 指标携带降级说明 warnings', partialCell !== undefined && partialCell.state === 'partial' && partialCell.warnings.length > 0)
  }

  // ══ 9 视图模型不含 sessionId/路径/秘密 ═════════════════════════════════════
  {
    const cells = buildSummaryCells(realReport)
    const text = JSON.stringify(cells)
    ok('9 摘要视图无 sessionId/wxid/路径/Token', !text.includes('sessionId') && !text.includes('wxid') &&
      !text.includes('.db') && !text.includes('token') && !text.includes('SELECT'))
    ok('9b 身份显示不回落到会话原文', identityLabelSafe({ name: null, accountId: 7, customerId: '501' }) === '客户 #7' &&
      identityLabelSafe({ name: null, accountId: null, customerId: '501' }) === '客户资料 #501' &&
      identityLabelSafe({ name: null, accountId: null, customerId: null }) === '未识别身份' &&
      identityLabelSafe({ name: '客户1', accountId: 1, customerId: '501' }) === '客户1')
    const reportText = JSON.stringify(realReport)
    ok('9c 报告本体无 wxid 原文（进入视图前的源头保证）', !reportText.includes('wxid_secret999'))
  }

  // ══ 12 阶段2：月度趋势区块 / E8 三句 / 客户详情跳转 ════════════════════════
  {
    const pageSrc = readFileSync(join(ROOT, 'src', 'pages', 'AnnualReviewPage.tsx'), 'utf8')
    ok('12 独立月度趋势区块（三序列面板，无“暂不支持”占位）', pageSrc.includes('签约金额（元/月）') &&
      pageSrc.includes('已核销回款（元/月）') && pageSrc.includes('客户消息量（条/月）') &&
      !pageSrc.includes('当前版本暂不支持'))
    ok('12b unavailable 面板不显示 0（走 UnavailableCard 原因卡）', (() => {
      const panel = pageSrc.slice(pageSrc.indexOf('function MonthlySeriesPanel'), pageSrc.indexOf('export default function AnnualReviewPage'))
      return panel.includes('UnavailableCard') && !panel.includes('format(0)')
    })())
    ok('12c E8 三句固定说明存在（非公平性结论）', pageSrc.includes('全部失败批次不留批次审计（assigned=0 不落行）') &&
      pageSrc.includes('部分失败批次的 skipped 只存在于幸存批次的 audit detail') &&
      pageSrc.includes('round_robin 游标写盘失败属于辅助降级，可能造成不超过一批的份额漂移并长期自愈；weight/load 不读写游标') &&
      pageSrc.includes('非公平性结论'))
    ok('12d 有 accountId → 复用 /customers?id= 既有详情入口；无 accountId → 不可点击',
      customerDetailHref({ accountId: 7 }) === '/customers?id=7' && customerDetailHref({ accountId: null }) === null &&
      customerDetailHref({ accountId: undefined }) === null && customerDetailHref({}) === null)
    ok('12d2 accountId 必须是正整数（0/负数/小数/NaN/±Infinity 一律不可点击）',
      customerDetailHref({ accountId: 0 }) === null && customerDetailHref({ accountId: -3 }) === null &&
      customerDetailHref({ accountId: 7.5 }) === null && customerDetailHref({ accountId: Number.NaN }) === null &&
      customerDetailHref({ accountId: Number.POSITIVE_INFINITY }) === null &&
      customerDetailHref({ accountId: Number.NEGATIVE_INFINITY }) === null &&
      customerDetailHref({ accountId: 1 }) === '/customers?id=1')
    ok('12e 页面接线 customerDetailHref（行级跳转守卫）', pageSrc.includes('customerDetailHref(r)') &&
      pageSrc.includes('useNavigate'))
  }

  // ══ 11 路由和 Sidebar 接线（源码守卫） ═════════════════════════════════════
  {
    const appSrc = readFileSync(join(ROOT, 'src', 'App.tsx'), 'utf8')
    const navSrc = readFileSync(join(ROOT, 'src', 'utils', 'appNav.ts'), 'utf8')
    const pageSrc = readFileSync(join(ROOT, 'src', 'pages', 'AnnualReviewPage.tsx'), 'utf8')
    ok('11 路由注册 /annual-review', appSrc.includes('path="/annual-review"') && appSrc.includes('AnnualReviewPage'))
    ok('11b Sidebar 报表组新增「年度经营复盘」（名称区分旧年度报告）', navSrc.includes("label: '年度经营复盘'") &&
      navSrc.includes("path: '/annual-review'") && !navSrc.includes("label: '年度报告'"))
    ok('11c 页面不引用统计/服务实现（只消费 IPC 视图 API）', !pageSrc.includes('annualReviewStats') &&
      !pageSrc.includes('annualReviewService') && pageSrc.includes('annualReviewView'))
    ok('11d 页面组件存在且默认导出', pageSrc.includes('export default function AnnualReviewPage'))
  }
  // ══ 13 非阻塞启动竞态：generate 响应前到达的终态事件不丢失 ══════════════════
  // 主进程 start() 在 IPC 返回 taskId 之前就已启动任务（快速任务可能先发出 completed/
  // failed/cancelled）。手动控制启动响应时序，逐条复现「事件先行」。
  {
    const startManual = async (reportResults: FakeApi['reportResults']): Promise<{ fake: FakeApi; ctrl: ReturnType<typeof createAnnualReviewController> }> => {
      const fake = createFakeApi({ reportResults, manualStart: true })
      const ctrl = createAnnualReviewController(fake.api)
      await ctrl.loadYears()
      await tick()
      ok('13 setup pending idle', ctrl.getState().phase === 'idle')
      ctrl.startGenerate()
      await tick()
      return { fake, ctrl }
    }

    // 13a completed 在 generate 响应前到达 → 不丢失，最终渲染报告（不停在 generating）
    {
      const { fake, ctrl } = await startManual([{ success: true, cache: 'miss' }, { success: true, cache: 'hit', report: realReport }])
      ok('13a0 响应未到：taskId 仍为空但已进入 generating（可暂存）',
        ctrl.getState().phase === 'generating' && ctrl.getState().generation.taskId === null)
      fake.emit({ taskId: 'g1', year: 2021, phase: 'computing', progress: 60, done: false })
      fake.emit({ taskId: 'g1', year: 2021, phase: 'completed', progress: 100, done: true }) // 响应前终态
      fake.gates[0].resolve({ success: true, taskId: 'g1' })
      await tick(); await tick(); await tick()
      const s = ctrl.getState()
      ok('13a 响应前 completed 不丢失 → done + 报告可用', s.phase === 'done' && s.report?.year === 2025 &&
        s.generation.taskId === null)
      ctrl.dispose()
    }

    // 13b failed 在 generate 响应前到达 → 收敛 failed（不永久 generating）
    {
      const { fake, ctrl } = await startManual([{ success: true, cache: 'miss' }])
      fake.emit({ taskId: 'g1', year: 2021, phase: 'failed', progress: 30, done: true, error: { code: 'worker_error', message: '端到端失败' } })
      fake.gates[0].resolve({ success: true, taskId: 'g1' })
      await tick(); await tick()
      const s = ctrl.getState()
      ok('13b 响应前 failed 不丢失 → failed + 结构化错误', s.phase === 'failed' &&
        s.error?.code === 'worker_error' && s.generation.taskId === null)
      ctrl.dispose()
    }

    // 13c cancelled 在 generate 响应前到达 → 收敛 cancelled（不永久 generating）
    {
      const { fake, ctrl } = await startManual([{ success: true, cache: 'miss' }])
      fake.emit({ taskId: 'g1', year: 2021, phase: 'failed', progress: 10, done: true, error: { code: 'cancelled', message: '年度复盘生成已取消' } })
      fake.gates[0].resolve({ success: true, taskId: 'g1' })
      await tick(); await tick()
      ok('13c 响应前 cancelled 不丢失 → cancelled', ctrl.getState().phase === 'cancelled' &&
        ctrl.getState().generation.taskId === null)
      ctrl.dispose()
    }

    // 13d 非当前 taskId 的暂存事件在回放时被丢弃（不污染当前任务）
    {
      const { fake, ctrl } = await startManual([{ success: true, cache: 'miss' }])
      fake.emit({ taskId: 'old-task', year: 2021, phase: 'computing', progress: 99, done: false })
      fake.emit({ taskId: 'old-task', year: 2021, phase: 'failed', progress: 99, done: true, error: { code: 'worker_error', message: '旧任务' } })
      fake.emit({ taskId: 'g1', year: 2021, phase: 'computing', progress: 25, done: false })
      fake.gates[0].resolve({ success: true, taskId: 'g1' })
      await tick(); await tick()
      const s = ctrl.getState()
      ok('13d 仅回放匹配 taskId 的事件（旧任务事件不污染）', s.phase === 'generating' &&
        s.generation.taskId === 'g1' && s.generation.progress === 25)
      ctrl.dispose()
    }

    // 13e 启动响应失败：暂存事件与任务状态一起清理（不残留、不影响后续生成）
    {
      const { fake, ctrl } = await startManual([{ success: true, cache: 'miss' }])
      fake.emit({ taskId: 'g1', year: 2021, phase: 'completed', progress: 100, done: true })
      fake.gates[0].resolve({ success: false, error: { code: 'invalid_year', message: '非法年份' } })
      await tick(); await tick()
      ok('13e 启动失败 → failed 且暂存事件被清理', ctrl.getState().phase === 'failed' &&
        ctrl.getState().error?.code === 'invalid_year' && ctrl.getState().report === null)
      // 后续正常启动：上一次的暂存事件不得驱动新任务状态
      ctrl.startGenerate()
      await tick()
      ok('13e2 后续生成不受上一代际暂存事件影响（仍 generating，进度 0）',
        ctrl.getState().phase === 'generating' && ctrl.getState().generation.progress === 0)
      fake.emit({ taskId: 'g1', year: 2021, phase: 'computing', progress: 40, done: false }) // 旧代际 taskId
      ok('13e3 旧代际 taskId 事件仍被忽略', ctrl.getState().generation.progress === 0)
      fake.gates[1].resolve({ success: true, taskId: 'g2' })
      await tick()
      fake.emit({ taskId: 'g2', year: 2021, phase: 'computing', progress: 40, done: false })
      ok('13e4 新任务事件正常推进（竞态修复不破坏正常路径）', ctrl.getState().generation.progress === 40)
      ctrl.dispose()
    }

    // 13f 正常路径不回归：响应后 progress → completed → done；响应前 loading 进度也被回放
    {
      const { fake, ctrl } = await startManual([{ success: true, cache: 'miss' }, { success: true, cache: 'hit', report: realReport }])
      fake.emit({ taskId: 'g1', year: 2021, phase: 'loading', progress: 5, done: false, statusText: '加载本地业务数据' })
      fake.gates[0].resolve({ success: true, taskId: 'g1' })
      await tick()
      ok('13f 响应前的非终态进度回放（statusText/进度）', ctrl.getState().generation.progress === 5 &&
        ctrl.getState().generation.statusText === '加载本地业务数据')
      fake.emit({ taskId: 'g1', year: 2021, phase: 'computing', progress: 70, done: false })
      fake.emit({ taskId: 'g1', year: 2021, phase: 'completed', progress: 100, done: true })
      await tick(); await tick()
      ok('13f2 响应后 progress → completed 正常收敛 done', ctrl.getState().phase === 'done' &&
        ctrl.getState().report !== null && ctrl.getState().generation.taskId === null)
      ctrl.dispose()
    }

    // 13g 快速 completed 但缓存 miss：不得停在 generating（要么 done，要么回到可重新获取的 idle）
    {
      const { fake, ctrl } = await startManual([{ success: true, cache: 'miss' }, { success: true, cache: 'miss' }])
      fake.emit({ taskId: 'g1', year: 2021, phase: 'completed', progress: 100, done: true })
      fake.gates[0].resolve({ success: true, taskId: 'g1' })
      await tick(); await tick(); await tick()
      const s = ctrl.getState()
      ok('13g 快速 completed + 缓存 miss → idle（可重新生成，不停在 generating）',
        s.phase === 'idle' && s.phase !== 'generating' && s.generation.taskId === null)
      ctrl.dispose()
    }
  }

}

main().then(() => {
  console.log(`结果：${pass} 通过 / ${fail} 失败`)
  process.exit(fail > 0 ? 1 : 0)
}).catch((e) => {
  console.error('FATAL:', e)
  process.exit(1)
})
