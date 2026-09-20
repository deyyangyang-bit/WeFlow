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
  funnelKindLabel,
  identityLabelSafe,
  initialAnnualReviewState,
  reduceProgressEvent,
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
  gates: Array<Deferred<{ success: boolean; taskId?: string; error?: { code: string; message: string } }>>
  reportResults: Array<{ success: boolean; cache: 'hit' | 'miss' | 'stale'; report?: AnnualReviewReport; error?: { code: string; message: string } }>
  emit: (event: AnnualReviewProgressEvent) => void
}
function createFakeApi(opts?: { reportResults?: FakeApi['reportResults']; yearsResult?: Parameters<AnnualReviewApi['getAvailableYears']> extends never ? never : Awaited<ReturnType<AnnualReviewApi['getAvailableYears']>> }): FakeApi {
  const calls = { generate: 0, cancel: 0, subscribe: 0, unsubscribe: 0, getReport: 0 }
  const gates: FakeApi['gates'] = []
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
      const gate = deferred<{ success: boolean; taskId?: string; error?: { code: string; message: string } }>()
      gates.push(gate)
      return gate.promise
    },
    cancel: async () => {
      calls.cancel++
      return { success: true }
    },
    subscribeProgress: (cb) => {
      calls.subscribe++
      progressCb = cb
      return () => {
        calls.unsubscribe++
        progressCb = null
      }
    }
  }
  return { api, calls, gates, reportResults, emit: (e) => progressCb?.(e) }
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

  // ══ 2 任务进度和取消 ═══════════════════════════════════════════════════════
  {
    const fake = createFakeApi()
    const ctrl = createAnnualReviewController(fake.api)
    await ctrl.loadYears()
    await tick()
    ctrl.startGenerate()
    await tick()
    ok('2 进入 generating（可取消，taskId 待事件绑定）', ctrl.getState().phase === 'generating' && ctrl.getState().generation.cancellable === true)
    // 进度事件按生成年份（2021=主进程默认年份）绑定；其他年份事件被忽略
    fake.emit({ taskId: 't0', year: 2025, phase: 'computing', progress: 66, done: false })
    ok('2b 其他年份的旧任务事件被忽略', ctrl.getState().generation.taskId === null && ctrl.getState().generation.progress === 0)
    fake.emit({ taskId: 't1', year: 2021, phase: 'computing', progress: 40, done: false })
    fake.emit({ taskId: 't1', year: 2021, phase: 'computing', progress: 70, done: false, statusText: '计算年度统计' })
    fake.emit({ taskId: 't1', year: 2021, phase: 'computing', progress: 55, done: false }) // 乱序 → 不回退
    const s = ctrl.getState()
    ok('2c 进度单调推进并绑定 taskId', s.generation.progress === 70 && s.generation.taskId === 't1' && s.generation.statusText === '计算年度统计')
    await ctrl.cancelGeneration()
    ok('2d 取消调用 IPC cancel', fake.calls.cancel === 1)
    fake.gates[0].resolve({ success: false, error: { code: 'cancelled', message: '年度复盘生成已取消' } })
    await tick()
    ok('2d 取消收敛 cancelled（未写入缓存）', ctrl.getState().phase === 'cancelled' && ctrl.getState().report === null)
    ctrl.dispose()
  }

  // ══ 3 生成成功 → 缓存查询 → 渲染 ═══════════════════════════════════════════
  {
    const fake = createFakeApi({ reportResults: [{ success: true, cache: 'miss' }, { success: true, cache: 'hit', report: realReport }] })
    const ctrl = createAnnualReviewController(fake.api)
    await ctrl.loadYears()
    await tick()
    ctrl.startGenerate()
    await tick()
    fake.emit({ taskId: 't2', year: 2021, phase: 'computing', progress: 90, done: false })
    fake.gates[0].resolve({ success: true, taskId: 't2' })
    await tick(); await tick()
    const s = ctrl.getState()
    ok('3 生成成功后渲染 done', s.phase === 'done' && s.report?.year === 2025)
    ok('3b overall 徽标（V1 D/E 未实现 → unavailable 档位）', s.overallBadge === 'unavailable')
    ok('3c 渲染后生成状态清理（taskId 置空、不可取消）', s.generation.taskId === null && s.generation.cancellable === false)
    ctrl.dispose()
  }

  // ══ 4 连续生成时旧任务结果隔离 ═════════════════════════════════════════════
  {
    const fake = createFakeApi()
    const ctrl = createAnnualReviewController(fake.api)
    await ctrl.loadYears()
    await tick()
    ctrl.startGenerate() // 第 1 次生成（gate0）
    await tick()
    ctrl.startGenerate() // 第 2 次生成（gate1）：旧 generate 结果必须作废
    await tick()
    fake.gates[0].resolve({ success: false, error: { code: 'cancelled', message: '旧结果' } })
    await tick()
    ok('4 旧 generate 结果不覆盖新任务（仍 generating）', ctrl.getState().phase === 'generating')
    fake.gates[1].resolve({ success: false, error: { code: 'cancelled', message: '新结果' } })
    await tick()
    ok('4b 新结果正常收敛 cancelled', ctrl.getState().phase === 'cancelled')

    // 跨年份：切走后旧年份迟到事件/结果不得覆盖新年份状态
    const fake2 = createFakeApi()
    const ctrl2 = createAnnualReviewController(fake2.api)
    await ctrl2.loadYears()
    await tick()
    ctrl2.startGenerate() // 2021（gate0）
    await tick()
    ctrl2.selectYear(2025) // 切到 2025：挂起的 2021 生成整体作废
    await tick()
    ok('4c 切年份后选定新年份（旧 generate 已作废，缓存 miss → idle）', ctrl2.getState().selectedYear === 2025 &&
      (ctrl2.getState().phase === 'loading' || ctrl2.getState().phase === 'idle') && ctrl2.getState().report === null)
    fake2.gates[0].resolve({ success: true, taskId: 'old-task' })
    await tick(); await tick()
    ok('4d 旧年份迟到 generate 结果被丢弃（未触发渲染/失败）', ctrl2.getState().phase === 'loading' || ctrl2.getState().phase === 'idle')
    // 旧年份进度事件（taskId/年份都不匹配新状态）被忽略
    fake2.emit({ taskId: 'old-task', year: 2021, phase: 'computing', progress: 66, done: false })
    ok('4e 旧年份进度事件被忽略', ctrl2.getState().phase !== 'generating')
    ctrl2.dispose()
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
    // 卸载时清理运行中任务：generating + 已绑定 taskId → dispose 触发 cancel
    const fake2 = createFakeApi()
    const ctrl2 = createAnnualReviewController(fake2.api)
    await ctrl2.loadYears()
    await tick()
    ctrl2.startGenerate()
    await tick()
    fake2.emit({ taskId: 'tg', year: 2021, phase: 'computing', progress: 30, done: false })
    ctrl2.dispose()
    ok('5e 页面卸载时清理运行中任务（cancel 被调用）', fake2.calls.cancel === 1)
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
    fake.gates[0].resolve({ success: true, taskId: 't3' })
    await tick(); await tick()
    const s = ctrl.getState()
    ok('8 缺必需字段 → failed（拒绝渲染成功态，不崩溃）', s.phase === 'failed' && s.error?.code === 'invalid_report' && s.report === null)
    ctrl.dispose()
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

  // ══ 10 纯 reducer 基础行为 ═════════════════════════════════════════════════
  {
    const s0 = initialAnnualReviewState()
    const idle = { ...s0, phase: 'done' as const }
    ok('10 非 generating 阶段进度事件被忽略', reduceProgressEvent(idle, { taskId: 't', year: 2025, phase: 'computing', progress: 50, done: false }) === idle)
    const gen = { ...s0, phase: 'generating' as const, selectedYear: 2025, generation: { taskId: null, progress: 0, cancellable: true } }
    const stepped = reduceProgressEvent(gen, { taskId: 'ta', year: 2025, phase: 'loading', progress: 20, done: false })
    ok('10b 无 taskId 时首个同年事件完成绑定', stepped.generation.taskId === 'ta' && stepped.generation.progress === 20)
    const otherYear = reduceProgressEvent(stepped, { taskId: 'tb', year: 2024, phase: 'computing', progress: 90, done: false })
    ok('10c 其他年份事件被忽略（旧任务隔离）', otherYear.generation.progress === 20 && otherYear.generation.taskId === 'ta')
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
}

main().then(() => {
  console.log(`结果：${pass} 通过 / ${fail} 失败`)
  process.exit(fail > 0 ? 1 : 0)
}).catch((e) => {
  console.error('FATAL:', e)
  process.exit(1)
})
