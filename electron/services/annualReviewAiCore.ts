/**
 * annualReviewAiCore.ts —— 年度经营复盘 · AI 诊断与行动计划（S7.1，纯模块）
 *
 * 职责（规格 §8）：
 *   - buildAnnualReviewAiInput：把 AnnualReviewReport **投影**为最小 AI 输入。白名单式
 *     投影（不是「拿报告减掉敏感字段」）：只有 meta/metrics/distributions/series/
 *     coverage/warnings 六类，且每类字段逐个显式取自报告。客户明细列表（C1–C8 行）、
 *     D7 名单、E 组 per-sales 明细、sourceSummary 一律**不进入**输入——第一版不发送
 *     客户姓名、客户明细、会话标识、数据库路径、Token、SQL 或聊天正文。
 *   - buildAnnualReviewAiPrompt：由输入确定性地构造 system + user prompt；同一输入必得
 *     同一字符串（无时钟、无随机、无环境读取），键序与数组序全部由本模块固定。
 *   - parseAnnualReviewAiOutput：严格校验模型输出。剥围栏 → JSON.parse → 逐字段白名单
 *     校验：未知顶层字段、数组超长、空文本、超长文本、非法枚举、未知 metricKey、
 *     重复 metricKey 全部拒绝。**不做任何补全/截断/默认值**——宁可整体失败，也不产出
 *     半真半假的诊断（诚实优先于产量）。
 *
 * 铁律（规格 §8）：
 *   - AI 不重新计算金额、比例、排名、增长率；输入里的数字是它唯一可引用的数字来源；
 *   - AI 不得发明事实：每条 diagnoses/actions/risks 必须至少引用一个真实 metricKeys，
 *     且该键必须存在于报告的 coverage 键集合中（parse 期强制，不靠 prompt 自觉）；
 *   - unavailable 不等于 0：输入里 value=null + state='unavailable' 原样呈现，提示词
 *     明确禁止把不可得指标当作 0；
 *   - AI 失败不改变确定性报告：本模块不改动、不缓存、不持久化任何报告内容（只读投影）。
 *
 * 边界：零 Electron 依赖、零 IO、零数据库、零时钟；不修改入参（输出全部为新对象，
 * 数组字段逐一复制，不与报告共享引用）；输出可 structuredClone / JSON 序列化。
 */
import { stripJsonFence } from './ai/promptUtils'
import type { AnnualReviewCoverage } from './annualReviewSegments'
import type { AnnualReviewReport } from './annualReviewReport'
import type { MetricState } from './annualReviewStats'

// ─── 稳定契约常量 ────────────────────────────────────────────────────────────

/** 用量账本的 purpose 稳定值：改动等于账本口径变更，需同步规格文档 */
export const ANNUAL_REVIEW_AI_PURPOSE = 'annual_review_ai'
/** prompt 版本：随输出契约或提示词变更递增（账本按行记录，便于回流比对） */
export const ANNUAL_REVIEW_AI_PROMPT_VERSION = 'annual_review_ai_v1'
/** 低温度：本项目是「解释既有确定性结论」，不需要创作空间 */
export const ANNUAL_REVIEW_AI_TEMPERATURE = 0.2
/** 输出上限：四条区块 + 至多 6 诊断/8 行动/5 风险，实测远低于此值 */
export const ANNUAL_REVIEW_AI_MAX_TOKENS = 2400
/** 超时：年度复盘输入比日常单客户分析大，给足 60s，仍受日上限闸门约束 */
export const ANNUAL_REVIEW_AI_TIMEOUT_MS = 60_000

/** 输出枚举（稳定值；非法值一律拒绝，不做大小写/同义词归一） */
export const ANNUAL_REVIEW_AI_CONFIDENCE = ['high', 'medium', 'low'] as const
export const ANNUAL_REVIEW_AI_PRIORITIES = [1, 2, 3] as const
/** 行动计划时间跨度；'next_year' 表示贯穿下一年度 */
export const ANNUAL_REVIEW_AI_HORIZONS = ['next_quarter', 'next_half', 'next_year'] as const

export type AnnualReviewAiConfidence = (typeof ANNUAL_REVIEW_AI_CONFIDENCE)[number]
export type AnnualReviewAiPriority = (typeof ANNUAL_REVIEW_AI_PRIORITIES)[number]
export type AnnualReviewAiHorizon = (typeof ANNUAL_REVIEW_AI_HORIZONS)[number]

/** 文本与条目上限（超长/超量 = 非法输出，不截断后放行） */
export const ANNUAL_REVIEW_AI_LIMITS = {
  executiveSummary: 800,
  diagnosisTitle: 60,
  diagnosisObservation: 240,
  diagnosisHypothesis: 240,
  actionAction: 240,
  actionRationale: 240,
  riskRisk: 240,
  diagnoses: 6,
  actions: 8,
  risks: 5,
  metricKeysPerItem: 6
} as const

// ─── AI 输出结构（规格 §8 契约） ─────────────────────────────────────────────

export interface AnnualReviewAiDiagnosis {
  title: string
  observation: string
  hypothesis: string
  metricKeys: string[]
  confidence: AnnualReviewAiConfidence
}

export interface AnnualReviewAiAction {
  /** 1 = 最高优先级 */
  priority: AnnualReviewAiPriority
  action: string
  rationale: string
  metricKeys: string[]
  horizon: AnnualReviewAiHorizon
}

export interface AnnualReviewAiRisk {
  risk: string
  metricKeys: string[]
}

export interface AnnualReviewAiAnalysis {
  executiveSummary: string
  diagnoses: AnnualReviewAiDiagnosis[]
  actions: AnnualReviewAiAction[]
  risks: AnnualReviewAiRisk[]
}

// ─── AI 输入结构（最小投影；每字段都能在报告里找到对应） ─────────────────────

export interface AnnualReviewAiMeta {
  year: number
  scopeKind: AnnualReviewReport['scopeKind']
  /** 本地自然日 'YYYY-MM-DD'（as-of 口径的日期视图，不改变报告的时间语义） */
  asOfDate: string
  generatedAtDate: string
  /** 本次报告实际采用事实的日期范围；空数据 → 双 null */
  dataRange: { from: string | null; to: string | null }
  timezoneNote: 'local'
  completeness: { overall: MetricState; blocks: Record<string, MetricState> }
}

export interface AnnualReviewAiMetric {
  key: string
  value: number | null
  state: MetricState
}

export interface AnnualReviewAiDistribution {
  key: string
  /** 取数形态（current_snapshot / historical_reconstruction）；stageFlow 无 kind → null */
  kind: string | null
  state: MetricState
  /** null = 分布未产出（unavailable），绝不用空数组冒充「全为零」 */
  buckets: Array<{ bucket: string; count: number }> | null
}

export interface AnnualReviewAiSeries {
  key: string
  state: MetricState
  points: Array<{ month: string; value: number }> | null
}

export interface AnnualReviewAiCoverageEntry {
  key: string
  status: MetricState
  source: string
  rows?: number
  exactCoverage?: boolean
  /** null = 分母不可知（exactCoverage=false），语义与缺省不同，必须保留 */
  coverageRatio?: number | null
  reasonCodes?: string[]
}

export interface AnnualReviewAiWarning {
  code: string
  message: string
  metricKeys: string[]
  counts?: Record<string, number>
}

export interface AnnualReviewAiInput {
  meta: AnnualReviewAiMeta
  /** A/D/E 组标量聚合指标（值 + 四态；unavailable 时 value=null） */
  metrics: AnnualReviewAiMetric[]
  /** 阶段分布（funnel 四指标；桶名来自 FUNNEL_ORDER 封闭枚举） */
  distributions: AnnualReviewAiDistribution[]
  /** 月度趋势（三条独立序列，量纲独立，不合并） */
  series: AnnualReviewAiSeries[]
  /** 全指标覆盖结构（含 rows/exactCoverage/coverageRatio/reasonCodes） */
  coverage: AnnualReviewAiCoverageEntry[]
  /** 全指标警告聚合（AI 必须据此降低置信度，不得忽略） */
  warnings: AnnualReviewAiWarning[]
}

// ─── 标量指标清单（固定顺序；键即报告 coverage 键，可被 AI 引用） ─────────────

type ScalarSelector = (report: AnnualReviewReport) => { value: number | null; state: MetricState }

/**
 * 输入里出现的标量指标；键必须是报告 coverage 的子集（否则 AI 会引用到未声明的键）。
 * funnel.stuck/salesAssignment.effectiveFollowup 的状态在 coverage.status，其余在 .state。
 */
const SCALAR_METRICS: ReadonlyArray<{ key: string; pick: ScalarSelector }> = [
  ...(['customerTotal', 'customerNew', 'customerActive', 'contractCount', 'contractAmount',
    'creditedAmount', 'shippedCount', 'shippedAmount', 'dealingCustomers', 'avgDealSize'] as const
  ).map((metric) => ({
    key: `summary.${metric}`,
    pick: (report: AnnualReviewReport) => ({ value: report.summary[metric].value, state: report.summary[metric].state })
  })),
  { key: 'funnel.stuck', pick: (r) => ({ value: r.funnel.stuck.value, state: r.funnel.stuck.coverage.status }) },
  { key: 'communication.volume', pick: (r) => ({ value: r.communication.volume.value, state: r.communication.volume.state }) },
  { key: 'communication.contacted', pick: (r) => ({ value: r.communication.contacted.value, state: r.communication.contacted.state }) },
  { key: 'communication.outboundRate', pick: (r) => ({ value: r.communication.outboundRate.value, state: r.communication.outboundRate.state }) },
  { key: 'salesAssignment.effectiveFollowup', pick: (r) => ({ value: r.salesAssignment.effectiveFollowup.value, state: r.salesAssignment.effectiveFollowup.state }) }
]

// ─── 工具 ────────────────────────────────────────────────────────────────────

/** 本地自然日 'YYYY-MM-DD'（与报告 timezoneNote='local' 同一时区语义） */
function localDateKey(ms: number): string {
  const d = new Date(ms)
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${month}-${day}`
}

/** 覆盖结构 → AI 输入条目（只保留有语义的字段；coverageRatio=null 必须保留） */
function toCoverageEntry(key: string, coverage: AnnualReviewCoverage): AnnualReviewAiCoverageEntry {
  const entry: AnnualReviewAiCoverageEntry = { key, status: coverage.status, source: coverage.source }
  if (typeof coverage.rows === 'number') entry.rows = coverage.rows
  if (typeof coverage.exactCoverage === 'boolean') entry.exactCoverage = coverage.exactCoverage
  if (coverage.coverageRatio !== undefined) entry.coverageRatio = coverage.coverageRatio
  if (Array.isArray(coverage.reasonCodes)) entry.reasonCodes = [...coverage.reasonCodes]
  return entry
}

// ─── 输入构造（纯投影，不修改报告） ───────────────────────────────────────────

/**
 * 报告 coverage 的稳定键集合（升序）：AI 可引用的 metricKeys 全集。
 * parse 期以此为准拒绝未知键——「AI 只引用真实指标」由数据决定，不由提示词自觉。
 */
export function annualReviewAiMetricKeys(report: AnnualReviewReport): string[] {
  return Object.keys(report.coverage ?? {}).sort()
}

/**
 * 把报告投影为最小 AI 输入。白名单式逐字段取数：
 *   - 只取 meta / 标量指标 / 阶段分布 / 月度序列 / coverage / warnings；
 *   - 客户明细行、客户姓名、会话标识、E 组 per-sales 明细、sourceSummary 全部不取；
 *   - 所有数组/对象都是新分配（不与报告共享引用），报告只读。
 */
export function buildAnnualReviewAiInput(report: AnnualReviewReport): AnnualReviewAiInput {
  const meta: AnnualReviewAiMeta = {
    year: report.year,
    scopeKind: report.scopeKind,
    asOfDate: localDateKey(report.asOf),
    generatedAtDate: localDateKey(report.generatedAt),
    dataRange: {
      from: report.dataRange.from === null ? null : localDateKey(report.dataRange.from),
      to: report.dataRange.to === null ? null : localDateKey(report.dataRange.to)
    },
    timezoneNote: report.timezoneNote,
    completeness: {
      overall: report.completeness.overall,
      blocks: { ...report.completeness.blocks }
    }
  }

  const metrics: AnnualReviewAiMetric[] = SCALAR_METRICS.map(({ key, pick }) => {
    const { value, state } = pick(report)
    return { key, value, state }
  })

  const distributions: AnnualReviewAiDistribution[] = [
    {
      key: 'funnel.customerStage',
      kind: report.funnel.customerStage.kind,
      state: report.funnel.customerStage.coverage.status,
      buckets: report.funnel.customerStage.distribution === null ? null : report.funnel.customerStage.distribution.map((d) => ({ bucket: d.bucket, count: d.count }))
    },
    {
      key: 'funnel.opportunityStage',
      kind: report.funnel.opportunityStage.kind,
      state: report.funnel.opportunityStage.coverage.status,
      buckets: report.funnel.opportunityStage.distribution === null ? null : report.funnel.opportunityStage.distribution.map((d) => ({ bucket: d.bucket, count: d.count }))
    },
    {
      key: 'funnel.stageFlow',
      kind: null,
      state: report.funnel.stageFlow.coverage.status,
      buckets: report.funnel.stageFlow.distribution.map((d) => ({ bucket: d.bucket, count: d.count }))
    },
    {
      key: 'funnel.lostBreakdown',
      kind: report.funnel.lostBreakdown.kind,
      state: report.funnel.lostBreakdown.coverage.status,
      buckets: report.funnel.lostBreakdown.customerPreviousStage === null ? null : report.funnel.lostBreakdown.customerPreviousStage.map((d) => ({ bucket: d.bucket, count: d.count }))
    }
  ]

  // 月度趋势：messageVolume 与 communication.monthlyTrend 是同一份 D5 结果（报告契约强制同源），
  // 只发一条，避免同一序列在 prompt 里出现两次而给出「两套数据」的错觉
  const series: AnnualReviewAiSeries[] = [
    {
      key: 'monthly.contractSign',
      state: report.monthly.contractSign.state,
      points: report.monthly.contractSign.months === null ? null : report.monthly.contractSign.months.map((m) => ({ month: m.month, value: m.amount }))
    },
    {
      key: 'monthly.credited',
      state: report.monthly.credited.state,
      points: report.monthly.credited.months === null ? null : report.monthly.credited.months.map((m) => ({ month: m.month, value: m.amount }))
    },
    {
      key: 'monthly.messageVolume',
      state: report.monthly.messageVolume.state,
      points: report.monthly.messageVolume.months === null ? null : report.monthly.messageVolume.months.map((m) => ({ month: m.month, value: m.count }))
    }
  ]

  const coverage: AnnualReviewAiCoverageEntry[] = annualReviewAiMetricKeys(report)
    .map((key) => toCoverageEntry(key, report.coverage[key]))

  const warnings: AnnualReviewAiWarning[] = report.warnings.map((w) => {
    const row: AnnualReviewAiWarning = { code: w.code, message: w.message, metricKeys: [...w.metricKeys] }
    if (w.counts !== undefined) row.counts = { ...w.counts }
    return row
  })

  return { meta, metrics, distributions, series, coverage, warnings }
}

// ─── Prompt ──────────────────────────────────────────────────────────────────

/**
 * 固定 system prompt。三点必须在提示词里说清，因为它们是本模块的验收口径：
 * 数字只能来自输入、unavailable 不是 0、每条判断必须引用真实 metricKeys。
 */
export const ANNUAL_REVIEW_AI_SYSTEM_PROMPT = [
  '你是 B2B 销售年度经营复盘分析助手（工业品 / 叉车仓储设备行业）。你的输入是一份已经算好的年度经营数据，你只负责解释与建议。',
  '',
  '铁律（违反即视为无效输出）：',
  '1. 只能用输入数据说话：不得引入行业常识、经验值、外部事实或任何输入中不存在的数字。',
  '2. 不得自行计算、推算、换算或改写金额、比例、排名、增长率、同比环比；需要数字时原样引用输入中的值。',
  '3. 每条 diagnoses / actions / risks 的 metricKeys 必须至少一个，且只能取输入 coverage 中出现的键；不得发明键名。',
  '4. state 为 unavailable 的指标表示数据不可得，不是 0，也不是「很低」；不得据此下结论，若影响判断须在 risks 或 observation 中明确指出数据缺口。',
  '5. state 为 partial / snapshot_only 的指标含义受限，结论须相应降低 confidence。',
  '6. 不要给出客户名单、联系人、客户姓名、会话标识或任何个体识别信息；只做经营层面的判断。',
  '7. 只输出一个 JSON 对象：不要代码围栏、不要解释文字、不要多余字段。',
  '',
  '输出 JSON 结构（字段不可增删）：',
  '{',
  '  "executiveSummary": "年度经营总评，2-4 句",',
  '  "diagnoses": [{ "title": "结论标题", "observation": "数据观察到的事实", "hypothesis": "原因假设（明确是假设）", "metricKeys": ["summary.contractAmount"], "confidence": "high|medium|low" }],',
  '  "actions": [{ "priority": 1, "action": "下一年度要做什么", "rationale": "为什么（可引用数据）", "metricKeys": ["summary.creditedAmount"], "horizon": "next_quarter|next_half|next_year" }],',
  '  "risks": [{ "risk": "风险或数据缺口", "metricKeys": ["communication.volume"] }]',
  '}',
  '',
  `枚举取值：confidence ∈ high|medium|low；priority ∈ 1|2|3（1 最高）；horizon ∈ next_quarter|next_half|next_year。`,
  `长度上限：executiveSummary ≤ ${ANNUAL_REVIEW_AI_LIMITS.executiveSummary} 字；title ≤ ${ANNUAL_REVIEW_AI_LIMITS.diagnosisTitle} 字；其余文本字段 ≤ ${ANNUAL_REVIEW_AI_LIMITS.diagnosisObservation} 字；条目上限 diagnoses ≤ ${ANNUAL_REVIEW_AI_LIMITS.diagnoses}、actions ≤ ${ANNUAL_REVIEW_AI_LIMITS.actions}、risks ≤ ${ANNUAL_REVIEW_AI_LIMITS.risks}。`,
  '没有把握的内容宁可不写：diagnoses / actions / risks 允许为空数组。'
].join('\n')

export interface AnnualReviewAiPrompt {
  systemPrompt: string
  userPrompt: string
}

/**
 * 构造 prompt。同一输入必得同一结果：无时钟、无随机、无环境读取，
 * 对象键序由 buildAnnualReviewAiInput 固定，数组序由报告契约固定（coverage 升序、
 * 月份升序、漏斗桶序固定）。
 */
export function buildAnnualReviewAiPrompt(input: AnnualReviewAiInput): AnnualReviewAiPrompt {
  return {
    systemPrompt: ANNUAL_REVIEW_AI_SYSTEM_PROMPT,
    userPrompt: `【年度经营复盘聚合数据】\n${JSON.stringify(input)}\n\n请只依据以上数据，按 system 要求输出诊断 JSON。`
  }
}

// ─── 输出解析与严格校验 ──────────────────────────────────────────────────────

export type AnnualReviewAiParseFailureCode = 'empty_output' | 'invalid_json' | 'invalid_shape'

export type AnnualReviewAiParseResult =
  | { ok: true; analysis: AnnualReviewAiAnalysis }
  | { ok: false; code: AnnualReviewAiParseFailureCode; message: string }

const DIAGNOSIS_KEYS = ['title', 'observation', 'hypothesis', 'metricKeys', 'confidence'] as const
const ACTION_KEYS = ['priority', 'action', 'rationale', 'metricKeys', 'horizon'] as const
const RISK_KEYS = ['risk', 'metricKeys'] as const
const TOP_KEYS = ['executiveSummary', 'diagnoses', 'actions', 'risks'] as const

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * 文本字段校验：必须是字符串，trim 后非空且不超长。
 * 返回 trim 后的值（写入结果时统一 trim，保证同输入同输出）；非法返回 null。
 */
function readText(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null
  const text = v.trim()
  if (text === '' || text.length > max) return null
  return text
}

/** 键集合必须与白名单**精确相等**（额外字段、缺字段都拒绝） */
function exactKeys(obj: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(obj)
  if (keys.length !== allowed.length) return false
  return keys.every((k) => (allowed as readonly string[]).includes(k))
}

/**
 * metricKeys 校验：非空数组、长度受限、逐项非空字符串、必须存在于 allowed 集合、不得重复。
 * 返回错误原因（null = 合法）。
 */
function metricKeysError(v: unknown, allowed: ReadonlySet<string>): string | null {
  if (!Array.isArray(v)) return 'metricKeys 不是数组'
  if (v.length === 0) return 'metricKeys 为空'
  if (v.length > ANNUAL_REVIEW_AI_LIMITS.metricKeysPerItem) return `metricKeys 超过 ${ANNUAL_REVIEW_AI_LIMITS.metricKeysPerItem} 项`
  const seen = new Set<string>()
  for (const item of v) {
    if (typeof item !== 'string' || item.trim() === '') return 'metricKeys 含非字符串或空值'
    const key = item.trim()
    if (!allowed.has(key)) return `metricKeys 引用未知指标：${key.slice(0, 64)}`
    if (seen.has(key)) return `metricKeys 重复引用：${key.slice(0, 64)}`
    seen.add(key)
  }
  return null
}

function readMetricKeys(v: unknown): string[] {
  return (v as string[]).map((k) => k.trim())
}

/**
 * 解析并严格校验模型输出。任何一处不合法 → 整体失败（不部分采信、不补默认值）。
 * message 只描述「第几条、哪个字段、怎么不合格」，不回显模型原文（避免把未校验文本
 * 传播到日志/UI）。
 */
export function parseAnnualReviewAiOutput(raw: unknown, allowedMetricKeys: readonly string[]): AnnualReviewAiParseResult {
  if (typeof raw !== 'string' || raw.trim() === '') return { ok: false, code: 'empty_output', message: '模型返回空输出' }
  const fenced = stripJsonFence(raw).trim()
  if (fenced === '') return { ok: false, code: 'empty_output', message: '模型返回空输出' }

  let parsed: unknown
  try {
    parsed = JSON.parse(fenced)
  } catch {
    return { ok: false, code: 'invalid_json', message: '模型输出不是合法 JSON' }
  }
  if (!isPlainObject(parsed)) return { ok: false, code: 'invalid_shape', message: '模型输出不是 JSON 对象' }
  if (!exactKeys(parsed, TOP_KEYS)) return { ok: false, code: 'invalid_shape', message: '顶层字段集合与契约不一致（缺失或存在额外字段）' }

  const executiveSummary = readText(parsed.executiveSummary, ANNUAL_REVIEW_AI_LIMITS.executiveSummary)
  if (executiveSummary === null) return { ok: false, code: 'invalid_shape', message: 'executiveSummary 为空或超长' }

  const allowed = new Set(allowedMetricKeys)
  const diagnosesRaw = parsed.diagnoses
  const actionsRaw = parsed.actions
  const risksRaw = parsed.risks
  if (!Array.isArray(diagnosesRaw) || diagnosesRaw.length > ANNUAL_REVIEW_AI_LIMITS.diagnoses) {
    return { ok: false, code: 'invalid_shape', message: `diagnoses 不是数组或超过 ${ANNUAL_REVIEW_AI_LIMITS.diagnoses} 条` }
  }
  if (!Array.isArray(actionsRaw) || actionsRaw.length > ANNUAL_REVIEW_AI_LIMITS.actions) {
    return { ok: false, code: 'invalid_shape', message: `actions 不是数组或超过 ${ANNUAL_REVIEW_AI_LIMITS.actions} 条` }
  }
  if (!Array.isArray(risksRaw) || risksRaw.length > ANNUAL_REVIEW_AI_LIMITS.risks) {
    return { ok: false, code: 'invalid_shape', message: `risks 不是数组或超过 ${ANNUAL_REVIEW_AI_LIMITS.risks} 条` }
  }

  const diagnoses: AnnualReviewAiDiagnosis[] = []
  for (let i = 0; i < diagnosesRaw.length; i++) {
    const item = diagnosesRaw[i]
    const at = `diagnoses[${i}]`
    if (!isPlainObject(item) || !exactKeys(item, DIAGNOSIS_KEYS)) {
      return { ok: false, code: 'invalid_shape', message: `${at} 字段集合与契约不一致` }
    }
    const title = readText(item.title, ANNUAL_REVIEW_AI_LIMITS.diagnosisTitle)
    if (title === null) return { ok: false, code: 'invalid_shape', message: `${at}.title 为空或超长` }
    const observation = readText(item.observation, ANNUAL_REVIEW_AI_LIMITS.diagnosisObservation)
    if (observation === null) return { ok: false, code: 'invalid_shape', message: `${at}.observation 为空或超长` }
    const hypothesis = readText(item.hypothesis, ANNUAL_REVIEW_AI_LIMITS.diagnosisHypothesis)
    if (hypothesis === null) return { ok: false, code: 'invalid_shape', message: `${at}.hypothesis 为空或超长` }
    const keysError = metricKeysError(item.metricKeys, allowed)
    if (keysError) return { ok: false, code: 'invalid_shape', message: `${at}.${keysError}` }
    if (!(ANNUAL_REVIEW_AI_CONFIDENCE as readonly unknown[]).includes(item.confidence)) {
      return { ok: false, code: 'invalid_shape', message: `${at}.confidence 非法枚举` }
    }
    diagnoses.push({
      title,
      observation,
      hypothesis,
      metricKeys: readMetricKeys(item.metricKeys),
      confidence: item.confidence as AnnualReviewAiConfidence
    })
  }

  const actions: AnnualReviewAiAction[] = []
  for (let i = 0; i < actionsRaw.length; i++) {
    const item = actionsRaw[i]
    const at = `actions[${i}]`
    if (!isPlainObject(item) || !exactKeys(item, ACTION_KEYS)) {
      return { ok: false, code: 'invalid_shape', message: `${at} 字段集合与契约不一致` }
    }
    if (!(ANNUAL_REVIEW_AI_PRIORITIES as readonly unknown[]).includes(item.priority)) {
      return { ok: false, code: 'invalid_shape', message: `${at}.priority 非法枚举` }
    }
    const action = readText(item.action, ANNUAL_REVIEW_AI_LIMITS.actionAction)
    if (action === null) return { ok: false, code: 'invalid_shape', message: `${at}.action 为空或超长` }
    const rationale = readText(item.rationale, ANNUAL_REVIEW_AI_LIMITS.actionRationale)
    if (rationale === null) return { ok: false, code: 'invalid_shape', message: `${at}.rationale 为空或超长` }
    const keysError = metricKeysError(item.metricKeys, allowed)
    if (keysError) return { ok: false, code: 'invalid_shape', message: `${at}.${keysError}` }
    if (!(ANNUAL_REVIEW_AI_HORIZONS as readonly unknown[]).includes(item.horizon)) {
      return { ok: false, code: 'invalid_shape', message: `${at}.horizon 非法枚举` }
    }
    actions.push({
      priority: item.priority as AnnualReviewAiPriority,
      action,
      rationale,
      metricKeys: readMetricKeys(item.metricKeys),
      horizon: item.horizon as AnnualReviewAiHorizon
    })
  }

  const risks: AnnualReviewAiRisk[] = []
  for (let i = 0; i < risksRaw.length; i++) {
    const item = risksRaw[i]
    const at = `risks[${i}]`
    if (!isPlainObject(item) || !exactKeys(item, RISK_KEYS)) {
      return { ok: false, code: 'invalid_shape', message: `${at} 字段集合与契约不一致` }
    }
    const risk = readText(item.risk, ANNUAL_REVIEW_AI_LIMITS.riskRisk)
    if (risk === null) return { ok: false, code: 'invalid_shape', message: `${at}.risk 为空或超长` }
    const keysError = metricKeysError(item.metricKeys, allowed)
    if (keysError) return { ok: false, code: 'invalid_shape', message: `${at}.${keysError}` }
    risks.push({ risk, metricKeys: readMetricKeys(item.metricKeys) })
  }

  return { ok: true, analysis: { executiveSummary, diagnoses, actions, risks } }
}
