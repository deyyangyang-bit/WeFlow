/**
 * annualReviewView.ts —— 年度经营复盘 · 页面状态机与视图模型（S4，纯模块）
 *
 * 分层纪律（规格 §7.1「UI 零业务计算」）：
 *   - 本模块不做任何口径计算：数值/state/warnings/coverage 全部原样来自
 *     AnnualReviewReport（主进程统计层产出）；本模块只做状态转换、渲染门禁与文案映射。
 *   - 状态机为纯函数（输入 → 输出，不修改输入），供 tsx 单测驱动；React 页面
 *     （AnnualReviewPage.tsx）只把 controller 状态接到视图，不含第二套状态逻辑。
 *   - 旧任务隔离：进度事件按 taskId 过滤（迟到的旧任务事件不覆盖新任务状态）；
 *     generate/getReport 的迟到 Promise 结果按代际序号（seq）丢弃。
 *   - 订阅生命周期：controller 创建时订阅一次进度，dispose() 精确卸载（幂等），
 *     页面卸载/重新生成不产生监听器泄漏。
 */
import type { AnnualReviewReport } from '../types/electron'

export type { AnnualReviewReport }

// ─── 页面阶段（任务要求的状态闭环） ──────────────────────────────────────────

/** 页面主阶段：done = 报告渲染（success/partial/unavailable 是渲染档位，非独立屏幕） */
export type AnnualReviewPhase =
  | 'idle'          // 未生成 / 缓存 miss，可发起生成
  | 'loading'       // 年份列表加载 / 缓存查询中
  | 'generating'    // 生成中（可取消）
  | 'done'          // 报告渲染（含 overall complete/partial/unavailable 徽标档位）
  | 'cancelled'     // 生成被取消（可重新生成）
  | 'failed'        // 生成/加载失败（错误 + 重试）

/** overall 完整性徽标档位（done 屏内） */
export type OverallBadge = 'complete' | 'partial' | 'unavailable'

export interface AnnualReviewProgressEvent {
  taskId: string
  year: number
  phase: 'loading' | 'computing' | 'completed' | 'failed'
  progress: number
  statusText?: string
  done: boolean
  error?: { code: string; message: string }
}

export interface AnnualReviewYearsResult {
  success: boolean
  data?: {
    years: Array<{ year: number; coverage: { rows: number } }>
    currentYear: number
    supportsAllTime: boolean
    defaultYear: number
    generatedAt: number
  }
  error?: { code: string; message: string }
}

export interface AnnualReviewReportResult {
  success: boolean
  cache: 'hit' | 'miss' | 'stale'
  report?: AnnualReviewReport
  error?: { code: string; message: string }
}

export interface AnnualReviewGenerateResult {
  success: boolean
  taskId?: string
  reused?: boolean
  error?: { code: string; message: string }
}

// ─── 页面状态（纯数据，reducer 输入输出） ────────────────────────────────────

export interface AnnualReviewPageState {
  phase: AnnualReviewPhase
  years: {
    loading: boolean
    years: Array<{ year: number; rows: number }>
    /** 主进程裁决的默认年份（UI 不自行推断） */
    defaultYear: number | null
    error?: string
  }
  selectedYear: number | null
  generation: {
    taskId: string | null
    progress: number
    statusText?: string
    /** 可取消 = generating 中 */
    cancellable: boolean
  }
  report: AnnualReviewReport | null
  /** done 屏的 overall 徽标档位（complete/partial/unavailable） */
  overallBadge: OverallBadge
  error?: { code: string; message: string }
}

export function initialAnnualReviewState(): AnnualReviewPageState {
  return {
    phase: 'loading',
    years: { loading: true, years: [], defaultYear: null },
    selectedYear: null,
    generation: { taskId: null, progress: 0, cancellable: false },
    report: null,
    overallBadge: 'unavailable'
  }
}

// ─── 渲染门禁：报告缺少必需字段时拒绝渲染成功态 ──────────────────────────────

/** V1 报告渲染必需的顶层字段（渲染层最小门禁；完整契约校验在主进程 validator） */
const REQUIRED_REPORT_KEYS = [
  'reportSchemaVersion', 'year', 'scopeKind', 'periodStart', 'periodEndExclusive',
  'asOf', 'generatedAt', 'timezoneNote', 'dataRange', 'completeness', 'coverage',
  'warnings', 'summary', 'funnel', 'customers', 'monthly', 'communication',
  'salesAssignment', 'sourceSummary'
] as const

export function assertRenderableReport(report: unknown): report is AnnualReviewReport {
  if (!report || typeof report !== 'object' || Array.isArray(report)) return false
  for (const key of REQUIRED_REPORT_KEYS) {
    if (!(key in (report as Record<string, unknown>))) return false
  }
  const r = report as Record<string, unknown>
  if (typeof r.year !== 'number' || typeof r.generatedAt !== 'number') return false
  if (!r.summary || typeof r.summary !== 'object') return false
  if (!r.completeness || typeof r.completeness !== 'object') return false
  return true
}

// ─── 纯 reducer ──────────────────────────────────────────────────────────────

/**
 * 进度事件过滤与合并（非终态）：非 generating 阶段或 taskId 不匹配（旧任务迟到事件）
 * 一律忽略。generate 已改为非阻塞启动——taskId 在启动响应时即绑定，主进程对同
 * {scope, year} 任务合并（reused），页面与主进程以同一 taskId 跟踪；年份作为次级
 * 防线同时校验。
 */
export function reduceProgressEvent(state: AnnualReviewPageState, event: AnnualReviewProgressEvent): AnnualReviewPageState {
  if (state.phase !== 'generating') return state
  if (state.generation.taskId === null || event.taskId !== state.generation.taskId) return state
  if (state.selectedYear !== null && event.year !== state.selectedYear) return state
  const progress = Math.min(100, Math.max(state.generation.progress, Number.isFinite(event.progress) ? event.progress : 0))
  return {
    ...state,
    generation: {
      ...state.generation,
      progress,
      statusText: typeof event.statusText === 'string' ? event.statusText : state.generation.statusText
    }
  }
}

export type GenerateStartOutcome =
  | { kind: 'started'; taskId: string; reused: boolean }
  | { kind: 'failed'; error: { code: string; message: string } }

/** generate 启动响应（非阻塞）：绑定 taskId 进入 generating；启动失败 → failed */
export function reduceGenerateStart(state: AnnualReviewPageState, outcome: GenerateStartOutcome): AnnualReviewPageState {
  if (outcome.kind === 'started') {
    return { ...state, generation: { taskId: outcome.taskId, progress: 0, statusText: state.generation.statusText, cancellable: true } }
  }
  return { ...state, phase: 'failed', error: outcome.error, generation: { taskId: null, progress: 0, cancellable: false } }
}

/**
 * 终态进度事件（done=true）→ 状态（纯函数）：
 *   completed → awaitingReport（controller 随后 getReport）；
 *   failed + error.code=cancelled → cancelled；其余 → failed。
 */
export function reduceTerminalEvent(state: AnnualReviewPageState, event: AnnualReviewProgressEvent): AnnualReviewPageState {
  if (event.phase === 'completed') {
    return { ...state, generation: { ...state.generation, progress: 100, statusText: '生成完成' } }
  }
  if (event.phase === 'failed' && event.error?.code === 'cancelled') {
    return { ...state, phase: 'cancelled', generation: { taskId: null, progress: 0, cancellable: false } }
  }
  return {
    ...state,
    phase: 'failed',
    error: event.error ?? { code: 'internal', message: '年度复盘生成失败' },
    generation: { taskId: null, progress: 0, cancellable: false }
  }
}

/** getReport 结果 → 状态：hit+门禁通过 → done；miss/stale → idle；非法报告 → failed（拒绝渲染成功态） */
export function reduceReportResult(state: AnnualReviewPageState, result: AnnualReviewReportResult, year: number | null): AnnualReviewPageState {
  if (year === null || result.success !== true) {
    const error = result.success === false && result.error ? result.error : { code: 'internal', message: '年度复盘报告查询失败' }
    return { ...state, phase: 'failed', error, generation: { taskId: null, progress: 0, cancellable: false } }
  }
  if (result.cache === 'hit' && result.report) {
    if (!assertRenderableReport(result.report)) {
      return { ...state, phase: 'failed', error: { code: 'invalid_report', message: '年度复盘报告数据不完整，已拒绝渲染' }, generation: { taskId: null, progress: 0, cancellable: false } }
    }
    const overall = result.report.completeness.overall
    return {
      ...state,
      phase: 'done',
      report: result.report,
      overallBadge: overall === 'complete' ? 'complete' : overall === 'partial' ? 'partial' : 'unavailable',
      error: undefined,
      generation: { taskId: null, progress: 0, cancellable: false }
    }
  }
  // miss/stale → 未生成（可发起生成）；stale 信息在页面上以「缓存已过期」副文案呈现
  return { ...state, phase: 'idle', report: null, generation: { taskId: null, progress: 0, cancellable: false } }
}

// ─── 文案映射（稳定中文说明；不暴露内部路径/SQL/Token/wxid/sessionId） ────────

/** 四态中文文案 */
export const METRIC_STATE_LABELS: Record<string, string> = {
  complete: '完整',
  partial: '部分完整',
  snapshot_only: '当前快照',
  unavailable: '暂无可靠数据'
}

/** 漏斗形态文案：当前快照与历史年末重建必须明确不同 */
export function funnelKindLabel(kind: string | undefined, coverageRatio: number | null | undefined): string {
  if (kind === 'historical_reconstruction') {
    return typeof coverageRatio === 'number' && Number.isFinite(coverageRatio)
      ? `历史年末重建（覆盖率 ${Math.round(coverageRatio * 100)}%）`
      : '历史年末重建'
  }
  return '当前快照（截至生成时间）'
}

/** 年份显示名（0 = 历史以来） */
export function yearLabel(year: number): string {
  return year === 0 ? '历史以来' : `${year} 年`
}

/** scopeKind → 区间说明文案（数据以报告字段为准，UI 不推导边界） */
export function scopeRangeLabel(report: AnnualReviewReport): string {
  const fmt = (ts: number): string => {
    const d = new Date(ts)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }
  if (report.scopeKind === 'all_time') return '全部本地数据（截至生成时间）'
  if (report.periodStart !== null && report.periodEndExclusive !== null) {
    return `统计区间 ${fmt(report.periodStart)} 至 ${fmt(report.periodEndExclusive)}`
  }
  return '统计区间以主进程返回为准'
}

export function dataRangeLabel(report: AnnualReviewReport): string {
  if (report.dataRange.from === null || report.dataRange.to === null) return '无有效数据范围'
  const fmt = (ts: number): string => {
    const d = new Date(ts)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }
  return `数据范围 ${fmt(report.dataRange.from)} 至 ${fmt(report.dataRange.to)}`
}

/** 金额（元）确定性格式 */
export function formatAmount(value: number): string {
  return `¥${value.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`
}

/**
 * 客户详情跳转（复用既有 /customers?id= 工作台路由，不发明新路由）；
 * 仅 accountId 可用时返回链接，否则 null（行保持不可点击）。
 */
export function customerDetailHref(row: { accountId?: number | null }): string | null {
  return typeof row.accountId === 'number' && Number.isFinite(row.accountId) ? `/customers?id=${row.accountId}` : null
}

/**
 * 客户名单行身份显示：只引用业务身份（name / account.id / customer_id），
 * 绝不回落到 sessionId/会话原文（规格 §7.2「客户身份只引用 account.id/customer_id」）。
 */
export function identityLabelSafe(row: { name?: string | null; accountId?: number | null; customerId?: string | null }): string {
  if (row.name) return row.name
  if (typeof row.accountId === 'number' && Number.isFinite(row.accountId)) return `客户 #${row.accountId}`
  if (row.customerId) return `客户资料 #${row.customerId}`
  return '未识别身份'
}

// ─── 视图模型（渲染前的确定性整理；用于测试与页面共用） ──────────────────────

export interface MetricCell {
  key: string
  label: string
  /** unavailable 时为 null（禁止显示 0） */
  displayValue: string | null
  state: string
  stateLabel: string
  warnings: Array<{ code: string; message: string; count?: number }>
}

/** A 组摘要 → 指标单元（unavailable 一律无数值显示，绝不显示 0） */
export function buildSummaryCells(report: AnnualReviewReport): MetricCell[] {
  const defs: Array<[string, string, (s: AnnualReviewReport['summary']) => { value: number | null; state: string; warnings: AnnualReviewReport['summary']['customerTotal']['warnings'] }]> = [
    ['customerTotal', '客户总数', (s) => s.customerTotal],
    ['customerNew', '年度新增客户', (s) => s.customerNew],
    ['customerActive', '年度活跃客户', (s) => s.customerActive],
    ['contractCount', '年度签约合同', (s) => s.contractCount],
    ['contractAmount', '年度签约金额', (s) => s.contractAmount],
    ['creditedAmount', '已核销回款', (s) => s.creditedAmount],
    ['shippedCount', '已发货合同数', (s) => s.shippedCount],
    ['shippedAmount', '已发货金额', (s) => s.shippedAmount],
    ['dealingCustomers', '成交客户数', (s) => s.dealingCustomers],
    ['avgDealSize', '客单价', (s) => s.avgDealSize]
  ]
  return defs.map(([key, label, get]) => {
    const metric = get(report.summary)
    const unavailable = metric.state === 'unavailable' || metric.value === null
    return {
      key,
      label,
      displayValue: unavailable ? null : key === 'contractAmount' || key === 'creditedAmount' || key === 'shippedAmount' || key === 'avgDealSize'
        ? formatAmount(metric.value as number)
        : String(metric.value),
      state: metric.state,
      stateLabel: METRIC_STATE_LABELS[metric.state] ?? metric.state,
      warnings: metric.warnings.map((w) => ({ code: w.code, message: w.message, count: w.count }))
    }
  })
}

// ─── Controller（框架无关；React 页面经 useSyncExternalStore 接入） ──────────

export interface AnnualReviewApi {
  getAvailableYears(): Promise<AnnualReviewYearsResult>
  getReport(year: number): Promise<AnnualReviewReportResult>
  generate(year: number): Promise<AnnualReviewGenerateResult>
  cancel(taskId: string): Promise<{ success: boolean; error?: { code: string; message: string } }>
  /** 订阅进度广播；返回精确清理函数（只移除本次订阅） */
  subscribeProgress(cb: (event: AnnualReviewProgressEvent) => void): () => void
}

export type AnnualReviewPageListener = (state: AnnualReviewPageState) => void

export interface AnnualReviewController {
  getState(): AnnualReviewPageState
  subscribe(listener: AnnualReviewPageListener): () => void
  loadYears(): Promise<void>
  selectYear(year: number): void
  loadReport(year: number): Promise<void>
  startGenerate(): void
  cancelGeneration(): void
  dispose(): void
}

/**
 * 页面控制器：状态机接线 + 旧任务隔离 + 订阅生命周期。
 *   - seq 代际：selectYear/startGenerate 各自递增；迟到的 getReport/generate 结果
 *     （旧代际）不得覆盖当前状态（连续生成时旧任务结果隔离）。
 *   - 进度订阅在创建时建立一次，按 taskId 过滤迟到事件；dispose 幂等精确卸载。
 */
export function createAnnualReviewController(api: AnnualReviewApi): AnnualReviewController {
  let state = initialAnnualReviewState()
  const listeners = new Set<AnnualReviewPageListener>()
  let yearsSeq = 0
  let reportSeq = 0
  let generateSeq = 0
  let disposed = false
  let unsubscribeProgress: (() => void) | null = null

  const emit = (): void => {
    for (const listener of listeners) {
      try { listener(state) } catch { /* 监听器异常不阻断状态机 */ }
    }
  }
  const setState = (next: AnnualReviewPageState): void => {
    state = next
    emit()
  }

  const onProgress = (event: AnnualReviewProgressEvent): void => {
    if (state.phase !== 'generating') return
    if (state.generation.taskId === null || event.taskId !== state.generation.taskId) return // 迟到/其他任务事件
    if (event.done) {
      // 终态：completed → 拉取缓存渲染；failed(+cancelled) → cancelled；其余 → failed。
      // 终态事件以「当前代际仍在等待」为准（generation.taskId 存在即未收敛）。
      const next = reduceTerminalEvent(state, event)
      setState(next)
      if (event.phase === 'completed' && state.selectedYear !== null) {
        const year = state.selectedYear
        void controller.loadReport(year)
      }
      return
    }
    const next = reduceProgressEvent(state, event)
    if (next !== state) setState(next)
  }

  const controller: AnnualReviewController = {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    async loadYears() {
      const seq = ++yearsSeq
      setState({ ...state, years: { ...state.years, loading: true, error: undefined } })
      let result: AnnualReviewYearsResult
      try {
        result = await api.getAvailableYears()
      } catch {
        result = { success: false, error: { code: 'internal', message: '可用年份查询失败' } }
      }
      if (disposed || seq !== yearsSeq) return // 迟到的年份结果：丢弃
      if (!result.success || !result.data) {
        setState({ ...state, phase: 'idle', years: { loading: false, years: [], defaultYear: null, error: result.error?.message ?? '可用年份查询失败' } })
        return
      }
      const years = result.data.years.map((y) => ({ year: y.year, rows: y.coverage?.rows ?? 0 }))
      // 默认年份来自主进程裁决（UI 不自行推断）；首载即拉取该年缓存
      const firstLoad = state.selectedYear === null
      const nextSelected = state.selectedYear ?? result.data.defaultYear ?? null
      setState({
        ...state,
        phase: nextSelected === null ? 'idle' : 'loading',
        years: { loading: false, years, defaultYear: result.data.defaultYear },
        selectedYear: nextSelected
      })
      if (firstLoad && nextSelected !== null) void controller.loadReport(nextSelected)
    },
    selectYear(year) {
      // 切换年份：先取消当前运行任务（含「首条 progress 前」——taskId 已由启动响应绑定），
      // 再作废旧代际挂起结果并拉取新年份缓存
      ++generateSeq
      const runningTaskId = state.phase === 'generating' ? state.generation.taskId : null
      setState({ ...state, selectedYear: year, report: null, phase: 'loading', error: undefined, generation: { taskId: null, progress: 0, cancellable: false } })
      if (runningTaskId !== null) {
        void api.cancel(runningTaskId).catch(() => { /* 取消失败：任务由主进程状态机收敛 */ })
      }
      void controller.loadReport(year)
    },
    async loadReport(year) {
      const seq = ++reportSeq
      let result: AnnualReviewReportResult
      try {
        result = await api.getReport(year)
      } catch {
        result = { success: false, cache: 'miss', error: { code: 'internal', message: '年度复盘报告查询失败' } }
      }
      if (disposed || seq !== reportSeq) return // 迟到的缓存结果：丢弃
      setState(reduceReportResult(state, result, year))
    },
    async startGenerate() {
      const year = state.selectedYear
      if (year === null) return
      // 同年重新生成：旧任务先取消（cancel 与 generate IPC 按序到达主进程）；
      // cancel 失败时主进程按同键合并，旧任务继续但页面状态仍随事件推进
      const prevTaskId = state.phase === 'generating' ? state.generation.taskId : null
      const seq = ++generateSeq
      setState({
        ...state,
        phase: 'generating',
        generation: { taskId: null, progress: 0, statusText: '准备生成', cancellable: true },
        report: null,
        error: undefined
      })
      if (prevTaskId !== null) {
        void api.cancel(prevTaskId).catch(() => { /* 取消失败不阻塞新启动 */ })
      }
      let outcome: GenerateStartOutcome
      try {
        const result = await api.generate(year)
        if (result.success && result.taskId) {
          outcome = { kind: 'started', taskId: result.taskId, reused: result.reused === true }
        } else {
          outcome = { kind: 'failed', error: result.error ?? { code: 'internal', message: '年度复盘生成失败' } }
        }
      } catch {
        outcome = { kind: 'failed', error: { code: 'internal', message: '年度复盘生成失败' } }
      }
      if (disposed) {
        // 页面已卸载而启动响应才到达：取消刚启动的任务（不留下无人管理的后台任务）
        if (outcome.kind === 'started') void api.cancel(outcome.taskId).catch(() => {})
        return
      }
      if (seq !== generateSeq || state.selectedYear !== year) {
        // 用户已切年/重新生成：本次启动作废并取消
        if (outcome.kind === 'started') void api.cancel(outcome.taskId).catch(() => {})
        return
      }
      setState(reduceGenerateStart(state, outcome))
    },
    async cancelGeneration() {
      const taskId = state.generation.taskId
      if (state.phase !== 'generating' || taskId === null) return
      try {
        await api.cancel(taskId)
      } catch { /* 取消失败：任务仍由主进程状态机收敛 */ }
    },
    dispose() {
      if (disposed) return // 幂等
      disposed = true
      // 页面卸载：清理仍在运行的生成任务（幂等取消；任务已终态则为 no-op）。
      // taskId 在启动响应到达后即绑定——「响应未返回前卸载」由 startGenerate 的
      // 迟到分支兜底取消。
      const taskId = state.generation.taskId
      if (state.phase === 'generating' && taskId !== null) {
        void api.cancel(taskId).catch(() => { /* 卸载路径：尽力而为 */ })
      }
      if (unsubscribeProgress) {
        unsubscribeProgress()
        unsubscribeProgress = null
      }
      listeners.clear()
    }
  }

  // 单一订阅：整页共享，dispose 精确卸载（不重复订阅、不泄漏）
  unsubscribeProgress = api.subscribeProgress(onProgress)

  return controller
}

/** 真实 IPC API 适配（页面用） */
export function createIpcAnnualReviewApi(): AnnualReviewApi {
  const electron = window.electronAPI
  return {
    getAvailableYears: () => electron.annualReview.getAvailableYears(),
    getReport: (year) => electron.annualReview.getReport(year),
    generate: (year) => electron.annualReview.generate(year),
    cancel: (taskId) => electron.annualReview.cancel(taskId),
    subscribeProgress: (cb) => electron.annualReview.onProgress(cb)
  }
}
