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
 *     activate() 可重复激活（React StrictMode setup→cleanup→setup 复用同一实例时
 *     恢复订阅与结果接收）；页面卸载/重新生成不产生监听器泄漏。
 */
import type { AnnualReviewReport } from '../types/electron'
import type {
  AnnualReviewAiAnalysis,
  AnnualReviewAiAnalysisFailureCode,
  AnnualReviewAiAnalysisResponse,
  AnnualReviewAiCancelResponse
} from '../../shared/annualReviewAi'
import {
  ANNUAL_REVIEW_AI_ANALYSIS_FAILURE_CODES
} from '../../shared/annualReviewAi'

export type { AnnualReviewReport }
export type { AnnualReviewAiAnalysis, AnnualReviewAiAnalysisFailureCode, AnnualReviewAiAnalysisResponse }

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
  /** 命中时给出产生该报告的生成任务（AI 分析请求只用该 taskId，不上传报告内容） */
  taskId?: string
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
  /**
   * 当前渲染的报告由哪个生成任务产出（来自 getReport 响应的 taskId）。
   * AI 分析请求只提交该 taskId；报告身份变化（切年/重新生成/新缓存）时 AI 区块状态一并清空。
   */
  reportTaskId: string | null
  /** done 屏的 overall 徽标档位（complete/partial/unavailable） */
  overallBadge: OverallBadge
  /** AI 分析区块（独立状态机；与确定性报告渲染完全解耦） */
  ai: AnnualReviewAiState
  error?: { code: string; message: string }
}

// ─── AI 分析区块状态（S7.2） ─────────────────────────────────────────────────

/**
 * AI 区块阶段。'cancelled' 是**用户主动取消**的界面状态（不是失败码）：
 * 主进程对取消的返回是 `call_failed` + 取消文案（规格 §8.3 固定其一），
 * 页面以「取消意图」区分显示，绝不把取消渲染成模型故障。
 */
export type AnnualReviewAiPhase = 'idle' | 'running' | 'done' | 'failed' | 'cancelled'

export interface AnnualReviewAiState {
  phase: AnnualReviewAiPhase
  /** 本次分析绑定的报告任务身份（旧分析结果不得覆盖新报告） */
  taskId: string | null
  analysis: AnnualReviewAiAnalysis | null
  /** 可追溯元信息（PRD §23）：模型 / promptVersion / 生成时刻 */
  model: string | null
  promptVersion: string | null
  generatedAt: number | null
  /** true = 命中主进程内存缓存（未产生新的模型调用） */
  cached: boolean
  /** running 起始时刻（用时展示；null = 未在跑） */
  startedAt: number | null
  error: { code: string; message: string } | null
}

export function initialAnnualReviewAiState(): AnnualReviewAiState {
  return {
    phase: 'idle',
    taskId: null,
    analysis: null,
    model: null,
    promptVersion: null,
    generatedAt: null,
    cached: false,
    startedAt: null,
    error: null
  }
}

export function initialAnnualReviewState(): AnnualReviewPageState {
  return {
    phase: 'loading',
    years: { loading: true, years: [], defaultYear: null },
    selectedYear: null,
    generation: { taskId: null, progress: 0, cancellable: false },
    report: null,
    reportTaskId: null,
    overallBadge: 'unavailable',
    ai: initialAnnualReviewAiState()
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

/**
 * getReport 结果 → 状态：hit + 门禁 + **年份一致性** 全部通过 → done；miss/stale → idle；
 * 非法/年份不符的报告 → failed（拒绝渲染成功态，且不保留上一份报告与徽标）。
 *
 * 年份一致性（fail-closed 数据契约，不依赖调用方「理论上不会返回错年份」）：
 * cache hit 时必须 `result.report.year === year` 且 `state.selectedYear === year`，
 * 否则收敛 failed/report_year_mismatch——错缓存、迟到响应或异常 IPC 数据不得展示在
 * 错误年份下。year=0（历史以来）是合法年份值，同样参与比对（0 === 0 通过）。
 * 本校验与 controller 的 reportSeq 代际隔离互补：seq 负责「迟到结果不覆盖新状态」，
 * 年份校验负责「数据本身与请求年份不符」。
 *
 * **AI 区块绑定报告身份**：命中报告时记录 `reportTaskId`（产生该报告的生成任务），并在
 * 报告身份发生变化（新任务产出 / 报告被清空）时把 AI 区块状态一并回到初始——
 * AI 分析结果永远只跟它当时分析的那份报告绑定，绝不挂到另一份报告上。
 * 在途 AI 请求的取消不在此处（切年/重新生成由 controller 显式取消，见 resetAi）。
 */
export function reduceReportResult(state: AnnualReviewPageState, result: AnnualReviewReportResult, year: number | null): AnnualReviewPageState {
  const failed = (error: { code: string; message: string }): AnnualReviewPageState => ({
    ...state,
    phase: 'failed',
    error,
    report: null,
    reportTaskId: null,
    overallBadge: 'unavailable',
    ai: initialAnnualReviewAiState(),
    generation: { taskId: null, progress: 0, cancellable: false }
  })
  if (year === null || result.success !== true) {
    return failed(result.success === false && result.error ? result.error : { code: 'internal', message: '年度复盘报告查询失败' })
  }
  if (result.cache === 'hit' && result.report) {
    if (!assertRenderableReport(result.report)) {
      return failed({ code: 'invalid_report', message: '年度复盘报告数据不完整，已拒绝渲染' })
    }
    if (result.report.year !== year || state.selectedYear !== year) {
      return failed({ code: 'report_year_mismatch', message: '报告年份与请求年份不一致，已拒绝渲染' })
    }
    const overall = result.report.completeness.overall
    const reportTaskId = typeof result.taskId === 'string' && result.taskId !== '' ? result.taskId : null
    return {
      ...state,
      phase: 'done',
      report: result.report,
      reportTaskId,
      overallBadge: overall === 'complete' ? 'complete' : overall === 'partial' ? 'partial' : 'unavailable',
      error: undefined,
      // 报告身份变化 → AI 区块清空（旧结果不得显示在新报告下）
      ai: reportTaskId === state.reportTaskId ? state.ai : initialAnnualReviewAiState(),
      generation: { taskId: null, progress: 0, cancellable: false }
    }
  }
  // miss/stale → 未生成（可发起生成）；stale 信息在页面上以「缓存已过期」副文案呈现
  return {
    ...state,
    phase: 'idle',
    report: null,
    reportTaskId: null,
    ai: initialAnnualReviewAiState(),
    generation: { taskId: null, progress: 0, cancellable: false }
  }
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
 * 仅 accountId 为**正整数**时返回链接（crmDb account.id 主键语义；0/负数/小数/非有限数
 * 均视为无有效身份），否则 null（行保持不可点击）。
 */
export function customerDetailHref(row: { accountId?: number | null }): string | null {
  return typeof row.accountId === 'number' && Number.isInteger(row.accountId) && row.accountId > 0
    ? `/customers?id=${row.accountId}`
    : null
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

// ─── AI 区块：状态转换、文案映射与确定性指标回查（S7.2） ─────────────────────

/** AI 区块纯 reducer：进入运行中（发起分析 / 重试）。startedAt 由调用方注入（纯函数不读时钟） */
export function reduceAiStart(state: AnnualReviewPageState, startedAt: number): AnnualReviewPageState {
  const taskId = state.reportTaskId
  if (taskId === null) return state
  return {
    ...state,
    ai: {
      ...initialAnnualReviewAiState(),
      phase: 'running',
      taskId,
      startedAt
    }
  }
}

/**
 * AI 响应 → 状态。成功：analysis + 可追溯元信息；失败：失败码与文案（原样保留主进程给出的
 * 固定文案，页面只补稳定的标题与可用动作）。
 */
export function reduceAiResult(state: AnnualReviewPageState, result: AnnualReviewAiAnalysisResponse): AnnualReviewPageState {
  if (result.success) {
    return {
      ...state,
      ai: {
        phase: 'done',
        taskId: state.ai.taskId,
        analysis: result.analysis,
        model: typeof result.model === 'string' ? result.model : null,
        promptVersion: typeof result.promptVersion === 'string' ? result.promptVersion : null,
        generatedAt: typeof result.generatedAt === 'number' ? result.generatedAt : null,
        cached: result.cached === true,
        startedAt: null,
        error: null
      }
    }
  }
  const code = typeof result.error?.code === 'string' ? result.error.code : 'internal'
  return {
    ...state,
    ai: {
      ...initialAnnualReviewAiState(),
      taskId: state.ai.taskId,
      phase: 'failed',
      error: { code, message: sanitizeAiFailureMessage(result.error?.message, code) }
    }
  }
}

/** 用户主动取消（仅当主进程确认真的中止了在途调用时进入） */
export function reduceAiCancelled(state: AnnualReviewPageState): AnnualReviewPageState {
  return {
    ...state,
    ai: { ...initialAnnualReviewAiState(), taskId: state.ai.taskId, phase: 'cancelled' }
  }
}

/** 稳定标签：优先级 / 把握度 / 时间跨度（不在页面上裸渲染枚举值或数字优先级） */
export const AI_PRIORITY_LABELS: Record<number, string> = { 1: '高优先级', 2: '中优先级', 3: '低优先级' }
export const AI_CONFIDENCE_LABELS: Record<string, string> = { high: '把握较大', medium: '把握中等', low: '把握有限' }
export const AI_HORIZON_LABELS: Record<string, string> = { next_quarter: '下个季度', next_half: '未来半年', next_year: '下一年度' }

export function aiPriorityLabel(priority: number): string {
  return AI_PRIORITY_LABELS[priority] ?? '优先级未知'
}
export function aiConfidenceLabel(confidence: string): string {
  return AI_CONFIDENCE_LABELS[confidence] ?? '把握未知'
}
export function aiHorizonLabel(horizon: string): string {
  return AI_HORIZON_LABELS[horizon] ?? '未标注时间跨度'
}

export interface AnnualReviewAiFailureView {
  /** 稳定标题（按失败码固定，不拼接主进程文案） */
  title: string
  /** 可用动作：retry=可重试；settings=去设置 AI；regenerate=需重新生成报告；none=无动作 */
  action: 'retry' | 'settings' | 'regenerate' | 'none'
  actionLabel?: string
  /** 无主进程文案时的兜底说明 */
  fallbackDetail: string
}

/**
 * 失败码 → 页面文案与动作。键集 = shared/annualReviewAi.ts 的失败码全集（类型穷举：
 * 主进程新增失败码而页面未覆盖时**编译失败**，不会出现「没有解释的错误卡片」）。
 * 说明一律为「可重试 / 去设置 / 需重新生成」三类可执行信息，不解释内部实现。
 */
export const ANNUAL_REVIEW_AI_FAILURE_VIEWS: Record<AnnualReviewAiAnalysisFailureCode, AnnualReviewAiFailureView> = {
  not_configured: {
    title: 'AI 未配置',
    action: 'settings',
    actionLabel: '前往设置 AI',
    fallbackDetail: '尚未配置 AI 服务（API 地址或密钥），配置后即可生成 AI 诊断。'
  },
  budget_blocked: {
    title: '今日 AI 调用已达上限',
    action: 'settings',
    actionLabel: '前往设置',
    fallbackDetail: '今日 AI 调用已达上限，本次分析未生成；可在设置中提高每日调用上限后重试。'
  },
  call_failed: {
    title: 'AI 调用失败',
    action: 'retry',
    actionLabel: '重试',
    fallbackDetail: 'AI 调用未成功（超时 / 取消 / 网络或模型故障），本次分析未生成，可重试。'
  },
  empty_output: {
    title: '模型输出为空',
    action: 'retry',
    actionLabel: '重试',
    fallbackDetail: '模型没有返回内容，本次分析未生成。'
  },
  invalid_json: {
    title: '模型输出未通过校验',
    action: 'retry',
    actionLabel: '重试',
    fallbackDetail: '模型返回的不是合法 JSON，本次分析未生成。'
  },
  invalid_shape: {
    title: '模型输出未通过校验',
    action: 'retry',
    actionLabel: '重试',
    fallbackDetail: '模型返回的结构不符合分析契约，本次分析未生成。'
  },
  numeric_claim: {
    title: '模型输出未通过校验',
    action: 'retry',
    actionLabel: '重试',
    fallbackDetail: '模型在正文里给出了具体数值（AI 只做定性解释，数字一律以报告为准），本次分析未生成。'
  },
  invalid_report: {
    title: '报告未通过结构校验',
    action: 'regenerate',
    actionLabel: '重新生成报告',
    fallbackDetail: '当前报告未通过结构校验，暂时无法生成 AI 分析；报告仍可查看与导出。'
  },
  unsupported_report_contract: {
    title: '当前报告暂不支持 AI 分析',
    action: 'none',
    fallbackDetail: '报告包含 AI 分析不支持的契约取值，本次分析未生成；报告仍可正常查看与导出。'
  },
  invalid_task_id: {
    title: '报告标识无效',
    action: 'regenerate',
    actionLabel: '重新生成报告',
    fallbackDetail: '报告标识无效，请重新生成报告后再试。'
  },
  invalid_request: {
    title: '请求参数无效',
    action: 'retry',
    actionLabel: '重试',
    fallbackDetail: 'AI 分析请求参数无效，本次未发起调用，可重试。'
  },
  task_not_found: {
    title: '未找到报告对应的生成任务',
    action: 'regenerate',
    actionLabel: '重新生成报告',
    fallbackDetail: '该报告对应的生成任务已不存在（可能已被新任务取代），请重新生成报告后再试。'
  },
  task_not_completed: {
    title: '报告尚未生成完成',
    action: 'regenerate',
    actionLabel: '重新生成报告',
    fallbackDetail: '该生成任务尚未成功完成，请重新生成报告后再生成 AI 分析。'
  },
  report_not_available: {
    title: '报告已过期',
    action: 'regenerate',
    actionLabel: '重新生成报告',
    fallbackDetail: '报告已过期或已被新的生成结果取代，请重新生成报告后再试。'
  },
  analysis_in_progress: {
    title: '已有 AI 分析正在进行',
    action: 'none',
    fallbackDetail: '该报告已有一份 AI 分析正在进行，请稍候查看结果。'
  },
  invalidated: {
    title: '数据已变更，结果已作废',
    action: 'retry',
    actionLabel: '重试',
    fallbackDetail: '账号或业务库在分析期间发生变化，本次结果已作废，可重试。'
  },
  internal: {
    title: 'AI 分析失败',
    action: 'retry',
    actionLabel: '重试',
    fallbackDetail: 'AI 分析未成功，可重试；确定性报告不受影响。'
  }
}

/** 失败码全集（渲染层守卫用；与主进程词表同源） */
export const AI_FAILURE_CODES: readonly string[] = ANNUAL_REVIEW_AI_ANALYSIS_FAILURE_CODES

/**
 * 失败文案安全闸门：主进程的失败文案是编译期常量（已由主进程测试断言不含敏感内容），
 * 但渲染层是最后一道出口——任何看起来像 URL / Token / 文件路径 / 异常堆栈的文案
 * 都不显示，退回该失败码的固定文案。宁可少显示一行诊断信息，也不把秘密渲染到界面上。
 */
const AI_FAILURE_MESSAGE_UNSAFE_PATTERNS: readonly RegExp[] = [
  /https?:\/\//i,
  /\bbearer\b/i,
  /\bsk-[A-Za-z0-9_-]{8,}/,
  /[A-Za-z]:\\/,
  /(?:^|[\s"'(])\/(?:Users|home|var|tmp|opt|Applications)\//,
  /\.(?:db|sqlite|sqlite3|log)\b/i,
  /\b(?:ENOENT|EACCES|ECONNREFUSED|ETIMEDOUT|SQLITE_\w+)\b/,
  /\bat\s+\S+\s+\([^)]*:\d+:\d+\)/,
  // 序列化载荷（供应商响应正文）：形如 "error": / "message": 的 JSON 片段一律不显示
  /"[A-Za-z_][A-Za-z0-9_]*"\s*:/
]

export function sanitizeAiFailureMessage(message: unknown, code: string): string {
  const fallback = aiFailureView(code).fallbackDetail
  if (typeof message !== 'string') return fallback
  const text = message.trim()
  if (text === '') return fallback
  if (text.length > 240) return fallback
  if (AI_FAILURE_MESSAGE_UNSAFE_PATTERNS.some((p) => p.test(text))) return fallback
  return text
}

/** 失败码 → 文案视图（未知码回落 to `internal`，永远有可显示的说明） */
export function aiFailureView(code: string): AnnualReviewAiFailureView {
  const view = (ANNUAL_REVIEW_AI_FAILURE_VIEWS as Record<string, AnnualReviewAiFailureView | undefined>)[code]
  return view ?? ANNUAL_REVIEW_AI_FAILURE_VIEWS.internal
}

// ─── metricKeys → 原报告确定性指标回查（不计算、不推断） ─────────────────────

export interface AnnualReviewAiMetricCell {
  /** 报告 coverage 键（与 AI 引用的一致） */
  key: string
  label: string
  /** 确定性数值（只从报告读取）；null = 该键在报告里不是标量（或 unavailable） */
  displayValue: string | null
  state: string
  stateLabel: string
  /** 非标量键提示「数值见报告哪一区块」；标量键为 null */
  valueHint: string | null
}

/** 全部 35 个 metricKey 的中文标签（标签恒定，不随数据变化） */
const AI_METRIC_LABELS: Record<string, string> = {
  'summary.customerTotal': '客户总数',
  'summary.customerNew': '年度新增客户',
  'summary.customerActive': '年度活跃客户',
  'summary.contractCount': '年度签约合同',
  'summary.contractAmount': '年度签约金额',
  'summary.creditedAmount': '已核销回款',
  'summary.shippedCount': '已发货合同数',
  'summary.shippedAmount': '已发货金额',
  'summary.dealingCustomers': '成交客户数',
  'summary.avgDealSize': '客单价',
  'funnel.customerStage': '客户阶段分布',
  'funnel.opportunityStage': '商机阶段分布',
  'funnel.stageFlow': '年内阶段流转',
  'funnel.stuck': '停滞客户',
  'funnel.lostBreakdown': '流失归因',
  'monthly.contractSign': '月度签约金额',
  'monthly.credited': '月度核销回款',
  'monthly.messageVolume': '月度客户消息量',
  'customers.highValue': '高价值客户',
  'customers.newCustomers': '新增客户名单',
  'customers.dealing': '成交客户名单',
  'customers.repeat': '复购客户名单',
  'customers.active': '活跃客户名单',
  'customers.silent': '沉默客户名单',
  'customers.risk': '流失风险客户',
  'customers.priority': '当前重点推进客户',
  'communication.volume': '年度客户消息量',
  'communication.contacted': '有沟通客户数',
  'communication.outboundRate': '主动联系率',
  'communication.monthlyTrend': '月度沟通趋势',
  'communication.longSilent': '长期未联系客户',
  'salesAssignment.assignedFacts': '分配事实（初始分配/移交）',
  'salesAssignment.effectiveFollowup': '有效跟进客户',
  'salesAssignment.contractContribution': '合同贡献（按销售）',
  'salesAssignment.creditedContribution': '核销回款贡献（按销售）'
}

/** 非标量键的确定性数值所在区块（提示语；不做任何计算） */
const AI_METRIC_HINTS: Record<string, string> = {
  'funnel.customerStage': '分布见「漏斗与阶段」',
  'funnel.opportunityStage': '分布见「漏斗与阶段」',
  'funnel.stageFlow': '分布见「漏斗与阶段」',
  'funnel.lostBreakdown': '归因见「漏斗与阶段」',
  'monthly.contractSign': '序列见「月度趋势」',
  'monthly.credited': '序列见「月度趋势」',
  'monthly.messageVolume': '序列见「月度趋势」',
  'communication.monthlyTrend': '序列见「沟通质量」',
  'communication.longSilent': '名单见「沟通质量」',
  'customers.highValue': '名单见「客户经营」',
  'customers.newCustomers': '名单见「客户经营」',
  'customers.dealing': '名单见「客户经营」',
  'customers.repeat': '名单见「客户经营」',
  'customers.active': '名单见「客户经营」',
  'customers.silent': '名单见「客户经营」',
  'customers.risk': '名单见「客户经营」',
  'customers.priority': '名单见「客户经营」',
  'salesAssignment.assignedFacts': '分项见「销售与分配」',
  'salesAssignment.contractContribution': '明细见「销售与分配」',
  'salesAssignment.creditedContribution': '明细见「销售与分配」'
}

/**
 * AI 引用的 metricKeys → 报告里的确定性指标展示单元。
 *
 * 纪律（规格 §8.2.1 / S7.2）：
 *   - 数值**只从报告读取**，绝不从 AI 文本提取、不做任何二次计算（金额格式化是展示层格式）；
 *   - 键集合以**当前报告 coverage** 为准（与主进程解析期同一白名单）：报告里没有的键
 *     一律不展示（防御未知/伪造键，不显示来路不明的指标）；
 *   - unavailable 不显示为 0（显示「暂无可靠数据」）；
 *   - 非标量键（分布/序列/名单）只给状态与所在区块提示，不在 AI 区块重复整块明细；
 *   - 去掉重复键、保留 AI 给出的顺序，最多 `limit` 条。
 */
export function buildAiMetricCells(report: AnnualReviewReport, metricKeys: string[], limit = 6): AnnualReviewAiMetricCell[] {
  const coverage = report.coverage ?? {}
  const seen = new Set<string>()
  const cells: AnnualReviewAiMetricCell[] = []
  for (const raw of metricKeys) {
    if (typeof raw !== 'string') continue
    const key = raw.trim()
    if (key === '' || seen.has(key)) continue
    if (!Object.prototype.hasOwnProperty.call(coverage, key)) continue // 只认当前报告的 coverage 键集合
    seen.add(key)
    const metric = aiMetricValue(report, key)
    const state = metric?.state ?? 'unavailable'
    cells.push({
      key,
      label: AI_METRIC_LABELS[key] ?? key,
      displayValue: metric && metric.displayValue !== null && state !== 'unavailable' ? metric.displayValue : null,
      state,
      stateLabel: METRIC_STATE_LABELS[state] ?? state,
      valueHint: metric && metric.displayValue !== null ? null : (AI_METRIC_HINTS[key] ?? null)
    })
    if (cells.length >= limit) break
  }
  return cells
}

/** 报告的确定性取值读取（只读；unavailable → value null，绝不显示 0） */
function aiMetricValue(report: AnnualReviewReport, key: string): { displayValue: string | null; state: string } | null {
  const amount = (v: number): string => formatAmount(v)
  if (key.startsWith('summary.')) {
    const metricKey = key.slice('summary.'.length) as keyof AnnualReviewReport['summary']
    const metric = report.summary?.[metricKey]
    if (!metric) return null
    const isAmount = metricKey === 'contractAmount' || metricKey === 'creditedAmount' || metricKey === 'shippedAmount' || metricKey === 'avgDealSize'
    return { displayValue: metric.value === null ? null : isAmount ? amount(metric.value) : String(metric.value), state: metric.state }
  }
  switch (key) {
    case 'funnel.stuck':
      return { displayValue: report.funnel.stuck.value === null ? null : String(report.funnel.stuck.value), state: report.funnel.stuck.coverage.status }
    case 'funnel.customerStage': return { displayValue: null, state: report.funnel.customerStage.coverage.status }
    case 'funnel.opportunityStage': return { displayValue: null, state: report.funnel.opportunityStage.coverage.status }
    case 'funnel.stageFlow': return { displayValue: null, state: report.funnel.stageFlow.coverage.status }
    case 'funnel.lostBreakdown': return { displayValue: null, state: report.funnel.lostBreakdown.coverage.status }
    case 'monthly.contractSign': return { displayValue: null, state: report.monthly.contractSign.state }
    case 'monthly.credited': return { displayValue: null, state: report.monthly.credited.state }
    case 'monthly.messageVolume': return { displayValue: null, state: report.monthly.messageVolume.state }
    case 'communication.volume': return { displayValue: report.communication.volume.value === null ? null : String(report.communication.volume.value), state: report.communication.volume.state }
    case 'communication.contacted': return { displayValue: report.communication.contacted.value === null ? null : String(report.communication.contacted.value), state: report.communication.contacted.state }
    case 'communication.outboundRate':
      return { displayValue: report.communication.outboundRate.value === null ? null : `${Math.round(report.communication.outboundRate.value * 100)}%`, state: report.communication.outboundRate.state }
    case 'communication.monthlyTrend': return { displayValue: null, state: report.communication.monthlyTrend.state }
    case 'communication.longSilent': return { displayValue: null, state: report.communication.longSilent.state }
    case 'salesAssignment.assignedFacts': return { displayValue: null, state: report.salesAssignment.coverage.status }
    case 'salesAssignment.effectiveFollowup':
      return { displayValue: report.salesAssignment.effectiveFollowup.value === null ? null : String(report.salesAssignment.effectiveFollowup.value), state: report.salesAssignment.effectiveFollowup.state }
    case 'salesAssignment.contractContribution': return { displayValue: null, state: report.salesAssignment.contractContribution.state }
    case 'salesAssignment.creditedContribution': return { displayValue: null, state: report.salesAssignment.creditedContribution.state }
    default: {
      if (key.startsWith('customers.')) {
        const metricKey = key.slice('customers.'.length) as keyof AnnualReviewReport['customers']
        const block = report.customers?.[metricKey]
        return block ? { displayValue: null, state: block.coverage.status } : null
      }
      return null
    }
  }
}

// ─── Controller（框架无关；React 页面经 useSyncExternalStore 接入） ──────────

/**
 * generate 响应到达前可暂存的 **taskId 数量**上限。暂存结构按 taskId 合并
 * （每 taskId ≤ 1 条普通进度 + ≤ 1 条终态），因此事件总量 ≤ 2×本上限，恒有界。
 * 正常窗口只有「IPC 发起 → 响应返回」一小段，实际 taskId 数通常为 1。
 */
const MAX_PENDING_TASKS = 64

/** 单个 taskId 的暂存条目：普通进度只留最新一条（进度不回退），终态最多一条且优先 */
interface PendingTaskEntry {
  progress: AnnualReviewProgressEvent | null
  terminal: AnnualReviewProgressEvent | null
  /** 到达顺序（淘汰最旧条目用） */
  order: number
}

export interface AnnualReviewTaskStatusResult {
  success: boolean
  found?: boolean
  task?: {
    taskId: string
    year: number
    phase: 'loading' | 'computing' | 'completed' | 'failed'
    progress: number
    statusText?: string
    done: boolean
    error?: { code: string; message: string }
  }
  error?: { code: string; message: string }
}

export interface AnnualReviewApi {
  getAvailableYears(): Promise<AnnualReviewYearsResult>
  getReport(year: number): Promise<AnnualReviewReportResult>
  generate(year: number): Promise<AnnualReviewGenerateResult>
  cancel(taskId: string): Promise<{ success: boolean; error?: { code: string; message: string } }>
  /**
   * 只读任务状态查询（权威来源）：渲染层仅在「响应前终态事件被暂存容量淘汰」时按
   * taskId 对账。**报告缓存（getReport）不是任务状态**，不得用于判断任务是否完成。
   */
  getTaskStatus(taskId: string): Promise<AnnualReviewTaskStatusResult>
  /**
   * AI 分析：只提交 taskId（报告由主进程在当前账号作用域内定位，不上传报告内容）。
   * `force=true` 仅用于「重新生成 AI 诊断」——跳过结果缓存并真实调用模型。
   */
  aiAnalysis(taskId: string, options?: { force?: boolean }): Promise<AnnualReviewAiAnalysisResponse>
  /** 取消在途 AI 分析；success=false + analysis_not_found 表示没有在途调用 */
  aiCancel(taskId: string): Promise<AnnualReviewAiCancelResponse>
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
  /** 发起 AI 分析（针对当前渲染报告的报告身份；运行中重复点击不产生第二次调用） */
  runAiAnalysis(options?: { force?: boolean }): void
  /** 取消在途 AI 分析（仅主进程确认中止时进入「已取消」） */
  cancelAiAnalysis(): void
  /**
   * 重新激活（React StrictMode setup→cleanup→setup 用）：dispose 后的同一实例再次
   * 接入时恢复结果接收与进度订阅。幂等：已激活（含首次挂载）时无副作用。
   */
  activate(): void
  /** 永久停用（真实页面卸载）：取消运行中生成/AI、退订进度、丢弃全部迟到结果 */
  dispose(): void
}

/**
 * 页面控制器：状态机接线 + 旧任务隔离 + 订阅生命周期。
 *   - seq 代际：selectYear/startGenerate 各自递增；迟到的 getReport/generate 结果
 *     （旧代际）不得覆盖当前状态（连续生成时旧任务结果隔离）。
 *   - 进度订阅在创建时建立一次，按 taskId 过滤迟到事件；dispose 幂等精确卸载。
 *   - generate 响应前竞态（协议层）：主进程 start() 在 IPC 返回 taskId 之前就启动了任务，
 *     极快的任务可能在 generate 响应到达前发出 completed/failed(含 cancelled)——此时页面
 *     尚无 taskId 可比对。事件按 taskId 合并暂存（有界：每 taskId ≤1 条最新普通进度 +
 *     ≤1 条终态，终态优先），绑定 taskId 后回放该 taskId 的条目（先进度、后终态）：
 *     终态事件不会仅因容量被丢弃，暂存也不依赖任何定时器/延时。若确实发生了终态淘汰
 *     （需 >MAX_PENDING_TASKS 个不同 taskId 同时产生终态），则按当前 taskId 查询**权威
 *     任务状态**对账（getTaskStatus）——报告缓存不是任务状态，绝不用于推断任务是否完成。
 */
export function createAnnualReviewController(api: AnnualReviewApi): AnnualReviewController {
  let state = initialAnnualReviewState()
  const listeners = new Set<AnnualReviewPageListener>()
  let yearsSeq = 0
  let reportSeq = 0
  let generateSeq = 0
  /** AI 分析代际：切年/重新生成/取消/卸载后，旧请求的迟到结果一律丢弃 */
  let aiSeq = 0
  let disposed = false
  let unsubscribeProgress: (() => void) | null = null
  /** generate 响应到达前按 taskId 合并的暂存事件（taskId 未知，无法提前过滤） */
  const pendingByTask = new Map<string, PendingTaskEntry>()
  let pendingOrder = 0
  /** 是否发生过「终态因容量被淘汰」（仅在全部条目都带终态时才可能） */
  let pendingTerminalDropped = false

  const emit = (): void => {
    for (const listener of listeners) {
      try { listener(state) } catch { /* 监听器异常不阻断状态机 */ }
    }
  }
  const setState = (next: AnnualReviewPageState): void => {
    state = next
    emit()
  }

  const clearPending = (): void => {
    pendingByTask.clear()
    pendingTerminalDropped = false
  }

  /**
   * 作废当前 AI 代际并取消在途分析（切年 / 重新生成 / 卸载共用）。
   * 返回新的 AI 初始状态：AI 结果只属于它分析的那份报告，报告一换立即清空；
   * 在途请求由主进程中止（取消失败不阻塞主流程，主进程状态机自行收敛）。
   */
  const resetAi = (): AnnualReviewAiState => {
    ++aiSeq
    const taskId = state.ai.phase === 'running' ? state.ai.taskId : null
    if (taskId !== null) {
      void api.aiCancel(taskId).catch(() => { /* 取消失败：主进程按 taskId 收敛，页面状态已清空 */ })
    }
    return initialAnnualReviewAiState()
  }

  /**
   * 暂存一条响应前事件（按 taskId 合并，恒有界）：
   *   - 同 taskId 已有终态 → 丢弃普通进度（终态优先，普通进度不再有意义）；
   *   - 同 taskId 普通进度与实时路径同语义合并：进度取最大值（不回退）、文案取最新非空值；
   *   - 新 taskId 且已达上限 → 优先淘汰**最旧的无终态条目**；只有全部条目都带终态时
   *     才淘汰最旧的终态条目，并置 pendingTerminalDropped 以触发绑定后的权威对账。
   * 因此当前任务的终态不会「仅因为缓存满」被静默丢弃。
   */
  const bufferPendingEvent = (event: AnnualReviewProgressEvent): void => {
    const existing = pendingByTask.get(event.taskId)
    if (existing) {
      if (event.done) {
        existing.terminal = event
        return
      }
      if (existing.terminal !== null) return // 终态已到：普通进度不再有意义
      const prev = existing.progress
      existing.progress = {
        ...event,
        progress: prev === null ? event.progress : Math.max(prev.progress, event.progress),
        statusText: typeof event.statusText === 'string' ? event.statusText : prev?.statusText
      }
      return
    }
    if (pendingByTask.size >= MAX_PENDING_TASKS) {
      let victimKey: string | null = null
      let victimOrder = Number.POSITIVE_INFINITY
      for (const [key, entry] of pendingByTask) {
        if (entry.terminal !== null) continue // 优先保留带终态的条目
        if (entry.order < victimOrder) { victimKey = key; victimOrder = entry.order }
      }
      if (victimKey === null) {
        // 全部条目都带终态：只能淘汰最旧的终态条目（需要 >MAX_PENDING_TASKS 个 taskId 同时终态）
        for (const [key, entry] of pendingByTask) {
          if (entry.order < victimOrder) { victimKey = key; victimOrder = entry.order }
        }
        if (victimKey !== null) pendingTerminalDropped = true
      }
      if (victimKey !== null) pendingByTask.delete(victimKey)
    }
    pendingByTask.set(event.taskId, {
      progress: event.done ? null : event,
      terminal: event.done ? event : null,
      order: ++pendingOrder
    })
  }

  const applyTerminalEvent = (event: AnnualReviewProgressEvent): void => {
    setState(reduceTerminalEvent(state, event))
    if (event.phase === 'completed' && state.selectedYear !== null) {
      const year = state.selectedYear
      void controller.loadReport(year)
    }
  }

  const onProgress = (event: AnnualReviewProgressEvent): void => {
    if (state.phase !== 'generating') return
    if (state.generation.taskId === null) {
      // generate 响应未到达：无法判定归属，按 taskId 合并暂存（有界）。回放时只接受绑定的
      // taskId，其他 taskId 的事件不会污染当前任务。
      bufferPendingEvent(event)
      return
    }
    if (event.taskId !== state.generation.taskId) return // 迟到/其他任务事件
    if (event.done) {
      applyTerminalEvent(event)
      return
    }
    const next = reduceProgressEvent(state, event)
    if (next !== state) setState(next)
  }

  /**
   * 回放响应前暂存的事件（只回放绑定后的当前 taskId）：先普通进度（不回退），再终态
   * （终态优先，必然收敛到 completed/failed/cancelled）。回放后清空暂存区。
   * droppedTerminal 表示「暂存期间曾有终态因容量被淘汰」——它只表示**需要按当前 taskId
   * 查询权威任务状态**，绝不表示当前任务已经完成（被淘汰的可能是无关 taskId 的终态）。
   */
  const replayPendingEvents = (taskId: string): { replayedTerminal: boolean; droppedTerminal: boolean } => {
    const entry = pendingByTask.get(taskId) ?? null
    const droppedTerminal = pendingTerminalDropped
    clearPending()
    if (entry === null) return { replayedTerminal: false, droppedTerminal }
    if (entry.progress !== null) {
      const next = reduceProgressEvent(state, entry.progress)
      if (next !== state) setState(next)
    }
    if (entry.terminal !== null) {
      applyTerminalEvent(entry.terminal)
      return { replayedTerminal: true, droppedTerminal }
    }
    return { replayedTerminal: false, droppedTerminal }
  }

  /** 终态收敛为失败（对账路径用）：错误 code 稳定、文案安全（不含路径/账号/SQL/堆栈） */
  const failFromReconcile = (code: string, message: string): void => {
    setState({
      ...state,
      phase: 'failed',
      error: { code, message },
      generation: { taskId: null, progress: 0, cancellable: false }
    })
  }

  /**
   * 对账（仅在「响应前终态被容量淘汰」时触发）：按当前 taskId 查询**权威任务状态**，
   * 绝不用报告缓存推断任务是否完成（缓存里有旧报告 ≠ 当前任务已完成；缓存 miss ≠ 当前任务失败）。
   * 三重校验：generation seq + selectedYear + 绑定的 taskId，迟到的对账结果一律丢弃。
   *   - loading/computing → 保持 generating（进度取 UI 与快照的最大值、文案取快照最新值），继续等事件；
   *   - completed → 先收敛终态，再走 loadReport（仍受年份一致性门禁约束）；
   *   - failed + cancelled → cancelled；其他 failed → failed（结构化安全错误）；
   *   - found:false → task_status_unknown（可恢复错误，report 保持 null，不展示旧缓存）；
   *   - 查询失败 → task_status_unavailable（不使用旧缓存猜测任务状态）。
   */
  const reconcileTaskStatus = async (taskId: string, year: number, seq: number): Promise<void> => {
    let result: AnnualReviewTaskStatusResult
    try {
      result = await api.getTaskStatus(taskId)
    } catch {
      result = { success: false, error: { code: 'task_status_unavailable', message: '任务状态查询失败' } }
    }
    // 迟到结果丢弃：切年/重新生成/卸载/绑定 taskId 变化
    if (disposed || seq !== generateSeq || state.selectedYear !== year) return
    if (state.generation.taskId !== taskId || state.phase !== 'generating') return
    if (!result.success) {
      // 查询失败（IPC 异常/结构化失败信封）→ 稳定可恢复错误码；不用旧缓存猜测任务状态
      failFromReconcile('task_status_unavailable', '任务状态查询失败，请稍后重试')
      return
    }
    if (!result.found || !result.task) {
      failFromReconcile('task_status_unknown', '任务状态不可查（可能已被新任务取代），请重新生成')
      return
    }
    const task = result.task
    if (task.taskId !== taskId || task.year !== year) {
      // 权威快照与本次请求不一致：拒绝（不猜测、不展示旧缓存）
      failFromReconcile('task_status_mismatch', '任务状态与请求不一致，已拒绝渲染')
      return
    }
    if (!task.done) {
      // 任务仍在运行：保持 generating，进度不回退，文案取快照的最新合法值
      const progress = Math.min(100, Math.max(state.generation.progress, Number.isFinite(task.progress) ? task.progress : 0))
      setState({
        ...state,
        generation: {
          ...state.generation,
          progress,
          statusText: typeof task.statusText === 'string' ? task.statusText : state.generation.statusText,
          cancellable: true
        }
      })
      return
    }
    // 权威终态：与实时终态事件走同一收敛路径（completed 会再走 getReport + 年份门禁）
    applyTerminalEvent({
      taskId,
      year,
      phase: task.phase,
      progress: task.progress,
      statusText: task.statusText,
      done: true,
      error: task.error
    })
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
      // 再作废旧代际挂起结果并拉取新年份缓存；AI 区块同时清空并取消在途分析
      // （旧年份的分析结果绝不显示在新年份下）
      ++generateSeq
      const runningTaskId = state.phase === 'generating' ? state.generation.taskId : null
      setState({
        ...state,
        selectedYear: year,
        report: null,
        reportTaskId: null,
        phase: 'loading',
        error: undefined,
        ai: resetAi(),
        generation: { taskId: null, progress: 0, cancellable: false }
      })
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
      clearPending() // 新代际：上一代际的暂存事件作废（不跨代际泄漏）
      setState({
        ...state,
        phase: 'generating',
        generation: { taskId: null, progress: 0, statusText: '准备生成', cancellable: true },
        report: null,
        reportTaskId: null,
        // 重新生成 = 报告身份必然变化：AI 结果与在途分析一并清空（旧结果绝不挂到新报告上）
        ai: resetAi(),
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
        clearPending()
        if (outcome.kind === 'started') void api.cancel(outcome.taskId).catch(() => {})
        return
      }
      if (seq !== generateSeq || state.selectedYear !== year) {
        // 用户已切年/重新生成：本次启动作废并取消
        clearPending()
        if (outcome.kind === 'started') void api.cancel(outcome.taskId).catch(() => {})
        return
      }
      setState(reduceGenerateStart(state, outcome))
      if (outcome.kind === 'started') {
        // 回放响应前暂存的该 taskId 条目（先进度后终态）：快速任务的 completed/failed/
        // cancelled 在这一步收敛，不会因「事件先于响应」而永久停在 generating
        const replay = replayPendingEvents(outcome.taskId)
        if (!replay.replayedTerminal && replay.droppedTerminal) {
          // 暂存期间确有终态被容量淘汰（需 >MAX_PENDING_TASKS 个 taskId 同时终态）：
          // 被淘汰的可能是**无关 taskId** 的终态，因此绝不能据此推断当前任务已完成——
          // 必须按当前 taskId 查询权威任务状态对账（getReport 只是报告缓存，不是任务状态）。
          void reconcileTaskStatus(outcome.taskId, year, seq)
        }
      } else {
        clearPending() // 启动失败：暂存事件与任务状态一起清理（不污染后续生成）
      }
    },
    async cancelGeneration() {
      const taskId = state.generation.taskId
      if (state.phase !== 'generating' || taskId === null) return
      try {
        await api.cancel(taskId)
      } catch { /* 取消失败：任务仍由主进程状态机收敛 */ }
    },
    /**
     * 发起 AI 分析。只提交 `reportTaskId`（报告由主进程定位），并做三重防护：
     *   ① 运行中重复点击直接返回（不产生第二次模型调用；页面同时禁用按钮）；
     *   ② 代际 aiSeq：切年/重新生成/取消/卸载后，旧请求的迟到结果一律丢弃；
     *   ③ 报告身份复核：响应到达时 `reportTaskId` 必须仍是发起时的那一个。
     * 失败只落在 `state.ai` 上：确定性报告、导出、重新生成都不受影响。
     * `options.force`（仅成功态「重新生成 AI 诊断」）跳过主进程结果缓存并真实调用模型；
     * 首次生成、失败重试、页面重新打开一律不带 force（允许命中缓存）。
     */
    async runAiAnalysis(options?: { force?: boolean }) {
      const taskId = state.reportTaskId
      if (taskId === null) return
      if (state.ai.phase === 'running') return
      const force = options?.force === true
      const seq = ++aiSeq
      setState(reduceAiStart(state, Date.now()))
      let result: AnnualReviewAiAnalysisResponse
      try {
        result = await api.aiAnalysis(taskId, { force })
      } catch {
        result = { success: false, error: { code: 'internal', message: 'AI 分析失败，请稍后重试' } }
      }
      if (disposed || seq !== aiSeq) return // 卸载 / 已切年 / 已重新生成 / 已取消：丢弃迟到结果
      if (state.reportTaskId !== taskId) return // 报告身份已变：结果不得覆盖新报告状态
      setState(reduceAiResult(state, result))
    },
    /**
     * 取消在途 AI 分析。只有主进程确认「确实中止了一次在途调用」（success=true）才切到
     * 「已取消」：`analysis_not_found` 表示没有在途调用（可能结果已返回），此时保持运行中，
     * 让真正的响应自然落地——绝不把一次成功的分析显示成「已取消」。
     */
    async cancelAiAnalysis() {
      const taskId = state.ai.taskId
      if (state.ai.phase !== 'running' || taskId === null) return
      let confirmed = false
      try {
        confirmed = (await api.aiCancel(taskId)).success === true
      } catch { /* 取消失败：不改变界面状态，等待响应或超时收敛 */ }
      if (disposed) return
      if (state.ai.phase !== 'running' || state.ai.taskId !== taskId) return
      if (!confirmed) return
      ++aiSeq // 此后该请求的迟到响应作废（不覆盖「已取消」）
      setState(reduceAiCancelled(state))
    },
    dispose() {
      if (disposed) return // 幂等
      disposed = true
      clearPending() // 停用后不再回放任何暂存事件
      // 页面卸载：清理仍在运行的生成任务（幂等取消；任务已终态则为 no-op）。
      // taskId 在启动响应到达后即绑定——「响应未返回前卸载」由 startGenerate 的
      // 迟到分支兜底取消。
      const taskId = state.generation.taskId
      if (state.phase === 'generating' && taskId !== null) {
        void api.cancel(taskId).catch(() => { /* 卸载路径：尽力而为 */ })
      }
      // 卸载同样中止在途 AI 分析（组件已卸载，绝不再设置状态、也不再占用模型额度）
      const aiTaskId = state.ai.phase === 'running' ? state.ai.taskId : null
      if (aiTaskId !== null) {
        void api.aiCancel(aiTaskId).catch(() => { /* 卸载路径：尽力而为 */ })
      }
      ++aiSeq // 卸载后到达的 AI 响应一律丢弃
      if (unsubscribeProgress) {
        unsubscribeProgress()
        unsubscribeProgress = null
      }
      listeners.clear()
    },
    /**
     * 重新激活（可重复激活生命周期的一半；dispose 是另一半）。React 18 开发版
     * StrictMode 对每个挂载执行 setup→cleanup→setup（同一组件实例、同一 controller），
     * cleanup 的 dispose 永久停用实例后，第二次 setup 必须恢复：
     *   - 重订进度订阅（dispose 已精确退订）；
     *   - 清除停用标记，使 loadYears/loadReport/generate/AI 的结果重新被接受
     *     （迟到结果仍由各自 seq 代际丢弃，不依赖 disposed 单向闸门）。
     * 不重置业务状态、不重放事件：setup 序列随后调用 loadYears 重新拉取权威数据；
     * 首次挂载（未 dispose 过）为 no-op。真实卸载仍走 dispose 全量清理，语义不变。
     */
    activate() {
      if (!disposed) return // 幂等：已激活（含首次挂载）无副作用
      disposed = false
      // 不变量：unsubscribeProgress === null 当且仅当处于停用态
      if (unsubscribeProgress === null) {
        unsubscribeProgress = api.subscribeProgress(onProgress)
      }
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
    getTaskStatus: (taskId) => electron.annualReview.getTaskStatus(taskId),
    aiAnalysis: (taskId, options) => electron.annualReview.aiAnalysis(taskId, options?.force === true),
    aiCancel: (taskId) => electron.annualReview.aiCancel(taskId),
    subscribeProgress: (cb) => electron.annualReview.onProgress(cb)
  }
}
