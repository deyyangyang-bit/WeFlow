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
 *     重复 metricKey、**文本中的数字声明** 全部拒绝。**不做任何补全/截断/默认值**——
 *     宁可整体失败，也不产出半真半假的诊断（诚实优先于产量）。
 *   - validateAnnualReviewAiInputContract：AI 侧独立的输入契约校验（fail closed）。
 *     报告 validator 只保证 source/code/bucket/kind 是「非空字符串」，不保证取值在 AI
 *     白名单内；未知契约值一律整份拒绝，不静默删除后继续（见 §8.1.1）。
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
import { FUNNEL_ORDER } from '../../shared/salesStage'
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

// ─── 字符串白名单（AI 输入不含任何自由文本） ─────────────────────────────────
//
// 报告 validator 对下列字段只校验「非空字符串」，不校验取值：coverage.source、
// coverage.reasonCodes[]、warnings[].code、漏斗分布 bucket / kind。这些字段一旦来自
// 被污染的报告，就能把客户姓名、sessionId、数据库路径、SQL、Token、聊天正文或提示注入
// 文本直接送进 prompt。因此 AI 投影层对它们一律走固定枚举白名单：**未确认的值拒绝或省略**，
// 绝不原样转发。
//
// 其余字符串字段（summary/metric 的 state、coverage.status、monthly 月份键、metricKey）
// 在报告 contract 里已是封闭枚举或严格格式，并已由 validateAnnualReviewReport 强制校验，
// 不作为自由文本处理。

/**
 * `coverage.source` 白名单 = 年度复盘报告 pipeline 实际产出的 source 全集
 * （annualReviewStats / Segments / Communication / Assignment / Report 的 coverage 构造点）。
 * 未知 source → 整个字段省略（不用占位符冒充）；新增数据源时同步本表。
 */
export const ANNUAL_REVIEW_AI_ALLOWED_SOURCES: readonly string[] = [
  'crmdb.account',
  'crmdb.allocation',
  'crmdb.assignment',
  'crmdb.audit_event',
  'crmdb.contract',
  'crmdb.contract_status_history',
  'crmdb.opportunity',
  'crmdb.opportunity_event',
  'salesdb.customer_profile',
  'salesdb.intent_tag_log',
  'wcdb.messages',
  'derived:contract_amount/dealing_customers',
  // 可用年份摘要的 source（同一报告族的固定值，当前不出现在顶层 coverage）
  'local_facts'
]

/**
 * 稳定 code 白名单（`coverage.reasonCodes` 与 `warnings[].code` 共用）
 * = 统计层全部 warning / reason code 字面量。未知 code → 该条整体丢弃。
 */
export const ANNUAL_REVIEW_AI_ALLOWED_CODES: readonly string[] = [
  'account_created_at_missing',
  'allocated_reconciled_at_missing',
  'audit_detail_invalid',
  'audit_time_missing',
  'bulk_import_dominant',
  'contract_account_missing',
  'contract_amount_invalid',
  'contribution_account_missing',
  'credited_account_missing',
  'credited_amount_invalid',
  'current_snapshot_projection',
  'customer_active_unavailable',
  'daily_date_invalid',
  'daily_scope_unverified',
  'daily_stats_missing',
  'effective_followup_lead_missing',
  'facts_missing',
  'historical_contact_unavailable',
  'history_contact_unavailable',
  'history_coverage_below_full',
  'history_coverage_below_threshold',
  'history_not_reconstructable',
  'history_population_empty',
  'history_reconstruction_not_complete',
  'intent_event_stage_invalid',
  'intent_event_time_invalid',
  'last_contact_fallback',
  'last_contact_missing',
  'legacy_time_fallback',
  'legacy_time_missing',
  'message_stats_invalid',
  'message_stats_unavailable',
  'opportunity_created_at_missing',
  'opportunity_event_stage_invalid',
  'opportunity_event_time_invalid',
  'opportunity_event_unlinked',
  'opportunity_tombstone_gap',
  'owner_current_value',
  'shipped_contract_unlinked',
  'shipped_time_missing',
  'sign_date_missing',
  'stage_flow_low_coverage',
  'sync_import_not_audited',
  'tombstone_gap',
  'unsupported_scope'
]

/** 漏斗桶名 = shared/salesStage FUNNEL_ORDER（阶段口径唯一源，不复制副本） */
export const ANNUAL_REVIEW_AI_ALLOWED_BUCKETS: readonly string[] = [...FUNNEL_ORDER]

/** 阶段分布取数形态（报告契约的两个字面量联合） */
export const ANNUAL_REVIEW_AI_ALLOWED_KINDS: ReadonlyArray<AnnualReviewReport['funnel']['customerStage']['kind']> = [
  'current_snapshot',
  'historical_reconstruction'
]

// ─── AI 输入契约校验（fail closed：未知枚举一律拒绝，不静默删除） ─────────────

/** AI 投影会消费、但报告 validator 只校验「是非空字符串」的字段 */
export type AnnualReviewAiContractField =
  | 'coverage.source'
  | 'coverage.reasonCodes'
  | 'warnings.code'
  | 'distribution.bucket'
  | 'distribution.kind'

/**
 * 契约违规：只描述**字段与位置**，不携带违规值本身——
 * 未知取值可能携带客户姓名/路径/注入文本，绝不能随失败信息扩散。
 * metricKey 取自报告的 coverage / funnel 键集合（合法报告里是固定键集合），不是未知枚举值。
 */
export interface AnnualReviewAiContractViolation {
  field: AnnualReviewAiContractField
  /** 出错位置；warnings 层没有 metricKey，此处为 undefined */
  metricKey?: string
}

export type AnnualReviewAiContractCheck = { ok: true } | { ok: false; violation: AnnualReviewAiContractViolation }

const ALLOWED_SOURCE_SET = new Set(ANNUAL_REVIEW_AI_ALLOWED_SOURCES)
const ALLOWED_CODE_SET = new Set(ANNUAL_REVIEW_AI_ALLOWED_CODES)
const ALLOWED_BUCKET_SET = new Set(ANNUAL_REVIEW_AI_ALLOWED_BUCKETS)
const ALLOWED_KIND_SET = new Set<string>(ANNUAL_REVIEW_AI_ALLOWED_KINDS)

/** 参与投影的四个阶段分布（key = 报告 coverage 键；与 buildAnnualReviewAiInput 一一对应） */
const AI_DISTRIBUTIONS: ReadonlyArray<{
  key: string
  pick: (report: AnnualReviewReport) => { kind: string | null; buckets: ReadonlyArray<{ bucket: string }> | null }
}> = [
  { key: 'funnel.customerStage', pick: (r) => ({ kind: r.funnel.customerStage.kind, buckets: r.funnel.customerStage.distribution }) },
  { key: 'funnel.opportunityStage', pick: (r) => ({ kind: r.funnel.opportunityStage.kind, buckets: r.funnel.opportunityStage.distribution }) },
  { key: 'funnel.stageFlow', pick: (r) => ({ kind: null, buckets: r.funnel.stageFlow.distribution }) },
  { key: 'funnel.lostBreakdown', pick: (r) => ({ kind: r.funnel.lostBreakdown.kind, buckets: r.funnel.lostBreakdown.customerPreviousStage }) }
]

/**
 * AI 输入契约校验（纯函数，不抛异常，不改报告）。**必须在模型调用之前执行**。
 *
 * 覆盖全部「报告 validator 只保证是非空字符串」且会被投影消费的枚举：
 * coverage.source、coverage.reasonCodes[]、warnings[].code、分布 bucket、分布 kind。
 * 任一取值不在白名单 → 返回结构化违规（字段 + 位置），由调用方转成固定失败码。
 *
 * 为什么不静默删除：把含未知契约值的报告「美化」后继续交给模型，会把数据质量缺口
 * 藏在看起来正常的诊断背后——宁可整份不做 AI 分析，也不产出建立在未知语义上的结论。
 */
export function validateAnnualReviewAiInputContract(report: AnnualReviewReport): AnnualReviewAiContractCheck {
  const fail = (field: AnnualReviewAiContractField, metricKey?: string): AnnualReviewAiContractCheck =>
    ({ ok: false, violation: metricKey === undefined ? { field } : { field, metricKey } })

  for (const key of Object.keys(report.coverage ?? {})) {
    const coverage = report.coverage[key]
    if (!ALLOWED_SOURCE_SET.has(coverage.source)) return fail('coverage.source', key)
    for (const code of coverage.reasonCodes ?? []) {
      if (!ALLOWED_CODE_SET.has(code)) return fail('coverage.reasonCodes', key)
    }
  }
  for (const warning of report.warnings ?? []) {
    if (!ALLOWED_CODE_SET.has(warning.code)) return fail('warnings.code')
  }
  for (const distribution of AI_DISTRIBUTIONS) {
    const { kind, buckets } = distribution.pick(report)
    if (kind !== null && !ALLOWED_KIND_SET.has(kind)) return fail('distribution.kind', distribution.key)
    for (const bucket of buckets ?? []) {
      if (!ALLOWED_BUCKET_SET.has(bucket.bucket)) return fail('distribution.bucket', distribution.key)
    }
  }
  return { ok: true }
}

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
  /**
   * null = **原报告本身没有产出分布**（unavailable），绝不用空数组冒充「全为零」。
   * 桶名不合法不会降级为 null —— 那是 AI 输入契约违规，整份报告会被
   * validateAnnualReviewAiInputContract 拒绝（见该函数与规格 §8.1.1）。
   */
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
  /** 数据来源；合法性由 AI 输入契约校验保证（见 validateAnnualReviewAiInputContract） */
  source: string
  rows?: number
  exactCoverage?: boolean
  /** null = 分母不可知（exactCoverage=false），语义与缺省不同，必须保留 */
  coverageRatio?: number | null
  /** 仅保留白名单内的稳定 code；无有效项时省略 */
  reasonCodes?: string[]
}

/**
 * 警告行：只有稳定 code 与结构化计数。
 * **不再携带 `message`**——文案是自由文本，正是客户姓名/路径/注入文本的潜在载体，
 * AI 只需知道「哪个指标有哪类缺口」，不需要文案；含义由 code 决定（规格 §8.1）。
 */
export interface AnnualReviewAiWarning {
  code: string
  metricKeys: string[]
  counts?: Record<string, number>
}

/** AI 输入的顶层六键契约（任何字段都必须能在报告里找到对应；无自由文本） */
export interface AnnualReviewAiInput {
  meta: AnnualReviewAiMeta
  /** A/D/E 组标量聚合指标（值 + 四态；unavailable 时 value=null） */
  metrics: AnnualReviewAiMetric[]
  /** 阶段分布（funnel 四指标；桶名经 FUNNEL_ORDER 白名单） */
  distributions: AnnualReviewAiDistribution[]
  /** 月度趋势（三条独立序列，量纲独立，不合并） */
  series: AnnualReviewAiSeries[]
  /** 全指标覆盖结构（source/reasonCodes 经白名单） */
  coverage: AnnualReviewAiCoverageEntry[]
  /** 全指标警告聚合（只有稳定 code，无文案） */
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

/** 覆盖结构 → AI 输入条目。契约已保证 source/reasonCodes 合法，此处不再过滤/降级 */
function toCoverageEntry(key: string, coverage: AnnualReviewCoverage): AnnualReviewAiCoverageEntry {
  const entry: AnnualReviewAiCoverageEntry = { key, status: coverage.status, source: coverage.source }
  if (typeof coverage.rows === 'number') entry.rows = coverage.rows
  if (typeof coverage.exactCoverage === 'boolean') entry.exactCoverage = coverage.exactCoverage
  if (coverage.coverageRatio !== undefined) entry.coverageRatio = coverage.coverageRatio
  if (Array.isArray(coverage.reasonCodes) && coverage.reasonCodes.length > 0) entry.reasonCodes = [...coverage.reasonCodes]
  return entry
}

/** 分布桶原样搬运（桶名合法性由契约校验负责，此处不删不改） */
function toBuckets(list: ReadonlyArray<{ bucket: string; count: number }> | null): Array<{ bucket: string; count: number }> | null {
  return list === null ? null : list.map((d) => ({ bucket: d.bucket, count: d.count }))
}

export type AnnualReviewAiInputResult =
  | { ok: true; input: AnnualReviewAiInput }
  | { ok: false; violation: AnnualReviewAiContractViolation }

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
 *   - 自由文本字段 `warnings.message` 从不进入输入；
 *   - coverage.source / coverage.reasonCodes / warnings.code / 分布 bucket / 分布 kind
 *     必须命中 AI 白名单（见 ANNUAL_REVIEW_AI_ALLOWED_*），否则**本函数直接返回失败**
 *     （failure = validateAnnualReviewAiInputContract 的违规字段与位置），
 *     由调用方转成 unsupported_report_contract；
 *   - **本函数不静默过滤、不美化报告**：不删行、不剔值、不降级、不置空，只按契约搬运。
 *     上一版会对未知取值静默省略/丢弃后继续调用模型，那会把数据质量缺口藏起来；
 *   - 所有数组/对象都是新分配（不与报告共享引用），报告只读。
 */
export function buildAnnualReviewAiInput(report: AnnualReviewReport): AnnualReviewAiInputResult {
  const contract = validateAnnualReviewAiInputContract(report)
  if (!contract.ok) return { ok: false, violation: contract.violation }

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
      buckets: toBuckets(report.funnel.customerStage.distribution)
    },
    {
      key: 'funnel.opportunityStage',
      kind: report.funnel.opportunityStage.kind,
      state: report.funnel.opportunityStage.coverage.status,
      buckets: toBuckets(report.funnel.opportunityStage.distribution)
    },
    {
      key: 'funnel.stageFlow',
      kind: null,
      state: report.funnel.stageFlow.coverage.status,
      buckets: toBuckets(report.funnel.stageFlow.distribution)
    },
    {
      key: 'funnel.lostBreakdown',
      kind: report.funnel.lostBreakdown.kind,
      state: report.funnel.lostBreakdown.coverage.status,
      buckets: toBuckets(report.funnel.lostBreakdown.customerPreviousStage)
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

  // 警告：契约已保证 code 合法，此处只做结构化搬运；不转发 message（自由文本，见类型注释）
  const warnings: AnnualReviewAiWarning[] = report.warnings.map((w) => {
    const row: AnnualReviewAiWarning = { code: w.code, metricKeys: [...w.metricKeys] }
    if (w.counts !== undefined) row.counts = { ...w.counts }
    return row
  })

  return { ok: true, input: { meta, metrics, distributions, series, coverage, warnings } }
}

// ─── Prompt ──────────────────────────────────────────────────────────────────

/**
 * 固定 system prompt。四条必须在提示词里说清，因为它们是本模块的验收口径：
 * 文本里不得出现具体数字（规则见 ANNUAL_REVIEW_AI_NUMERIC_RULES）、
 * unavailable 不是 0、每条判断必须引用真实 metricKeys。
 */
export const ANNUAL_REVIEW_AI_SYSTEM_PROMPT = [
  '你是 B2B 销售年度经营复盘分析助手（工业品 / 叉车仓储设备行业）。你的输入是一份已经算好的年度经营数据，你只负责解释与建议。',
  '',
  '铁律（违反即视为无效输出）：',
  '1. 只能用输入数据说话：不得引入行业常识、经验值、外部事实或任何输入中不存在的信息。',
  '2. 不得自行计算、推算、换算或改写金额、比例、排名、增长率、同比环比；也不要复述输入中的具体数值。',
  `3. **正文里不得出现具体数值**。一律禁止：阿拉伯数字与全角数字（含百分比、金额、年份）；中文序数（第几）与排名（前几）；中文分数（百分之几 / 千分之几 / 万分之几）；中文比例或倍数（成 / 折 / 倍）；中文数量、金额、时间与等级（几万元、几个客户、几个月、几千万、几级客户、二零二六年这类连续数字字符）。需要表达多少时用定性词：多数 / 大部分 / 部分 / 少数 / 若干 / 明显 / 略低 / 偏高。普通词汇里的数字字符不受限制（统一口径、保持一致、两类风险、十分谨慎、万一发生、一方面、两端协同、一一核实、一成不变均可；「千万」作副词时也可用，如千万不要 / 千万不能，但不得用来表示金额或量级）。确定性数字由页面按 metricKeys 从原报告直接展示，你只做定性解释。唯一允许出现数字的位置是 JSON 字段 priority 的取值（如 1 表示最高优先级）。`,
  '4. 每条 diagnoses / actions / risks 的 metricKeys 必须至少一个，且只能取输入 coverage 中出现的键；不得发明键名。',
  '5. state 为 unavailable 的指标表示数据不可得，不是 0，也不是「很低」；不得据此下结论，若影响判断须在 risks 或 observation 中明确指出数据缺口。',
  '6. state 为 partial / snapshot_only 的指标含义受限，结论须相应降低 confidence。warnings 只给稳定 code（不含文案），code 表示相应指标存在数据缺口，遇到缺口须降低 confidence 并在 risks 中说明。',
  '7. 不要给出客户名单、联系人、客户姓名、会话标识或任何个体识别信息；只做经营层面的判断。',
  '8. 只输出一个 JSON 对象：不要代码围栏、不要解释文字、不要多余字段。',
  '',
  '输出 JSON 结构（字段不可增删）：',
  '{',
  '  "executiveSummary": "年度经营总评，几句定性判断",',
  '  "diagnoses": [{ "title": "结论标题", "observation": "数据观察到的事实（定性）", "hypothesis": "原因假设（明确是假设）", "metricKeys": ["summary.contractAmount"], "confidence": "high|medium|low" }],',
  '  "actions": [{ "priority": 1, "action": "下一年度要做什么", "rationale": "为什么（定性）", "metricKeys": ["summary.creditedAmount"], "horizon": "next_quarter|next_half|next_year" }],',
  '  "risks": [{ "risk": "风险或数据缺口", "metricKeys": ["communication.volume"] }]',
  '}',
  '',
  `枚举取值：confidence ∈ high|medium|low；priority ∈ 1|2|3（1 最高，这是唯一允许出现数字的字段）；horizon ∈ next_quarter|next_half|next_year。`,
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

export type AnnualReviewAiParseFailureCode = 'empty_output' | 'invalid_json' | 'invalid_shape' | 'numeric_claim'

export type AnnualReviewAiParseResult =
  | { ok: true; analysis: AnnualReviewAiAnalysis }
  | { ok: false; code: AnnualReviewAiParseFailureCode; message: string }

/**
 * 数字声明识别（V1：禁止 AI 在正文里给出具体数字）。
 *
 * 只校验 metricKeys 并不能阻止模型编造数字——「回款比签约高 83%」「损失 100 万元」
 * 「排名第一」都可以挂着合法 metricKey 出现，而报告里根本没有这些数。因此文本字段
 * 一律做机械识别，命中即整体失败；确定性数字由页面依据 metricKeys 从原报告渲染。
 *
 * ## 规则边界（明确数值表达 vs 普通词汇）
 *
 * 判据不是「出现数字字符」——中文里 `统一`/`一致`/`两类`/`十分`/`一方面` 的数字字符
 * 不表示数量。识别按下列**可解释规则**逐条匹配（见 ANNUAL_REVIEW_AI_NUMERIC_RULES），
 * 命中任一即视为声明了数值：
 *
 *   1. decimal_digit     任意 Unicode 十进制数字（`83%`、全角 `８３％`）
 *   2. cn_ordinal        `第` + 数字字符（`第一名`、`第二阶段`、`第三季度`）
 *   3. cn_ranking        `前` + 数字字符（`前五`、`前十`、`排名前三`、`位列前五`）
 *   4. cn_fraction       `百分之`/`千分之`/`万分之` + 数字（`百分之五`、`千分之五`、`万分之三`）
 *   5. cn_ratio          数字字符 + `成`/`折`/`倍`（`八成`、`三倍`、`三成以上`）
 *   6. cn_quantity       数字字符 + 量词（`三万元`、`十二个客户`、`三个月`、`一千万`、`三级客户`）
 *   7. cn_numeral_run    连续 ≥2 个数字字符（`二零二六`、`十二个`）
 *
 * 单个数字字符后既不接量词、也不构成连续串时**不算**数值声明，因此上面那批普通词汇全部放行。
 *
 * ## 豁免：只对「非数值语境」放行，不做全局字符串遮盖
 *
 * 上一版把所有 `千万` 无条件从文本里抹掉再扫描，导致「合同金额千万」「回款千万」这类
 * 真实金额绕过了检测。现在改为**带上下文的豁免**（ANNUAL_REVIEW_AI_NUMERIC_EXEMPTIONS），
 * 每条豁免都有 id / 类型 / 理由，并且只在**匹配到的位置上**放行（等长占位替换），
 * 不是「先把某串字全局替换掉」：
 *
 *   - `qianwan_adverb`（类型 adverb，上下文锚定）：只有 `千万` **后接副词后缀**
 *     （要 / 不能 / 别 / 避免 / 务必 / 不可 / 注意 / 记得 / 不要 / 谨记 / 谨防 / 防止 / 保持 / 把握）
 *     才豁免。裸 `千万`（金额千万、达到千万、千万级规模）照旧被 cn_quantity / cn_numeral_run 拒绝。
 *   - 其余四条（类型 non_quantity_form）按**整串**豁免，但每条的语义使其不可能表示数量，
 *     理由写在表内：`万一`（中文数量写作「一万」）、`一一`（逐个）、`万万`（副词/古旧量词）、
 *     `一成不变`（成语；单独出现的 `一成`＝10% 仍被 cn_ratio 拒绝）。
 *     测试断言每条豁免都确实「救回」了某条规则会命中的串（不留死条目），并且遮盖不会
 *     把真实数量藏起来（掩码后剩余上下文仍会命中 cn_quantity / cn_numeral_run）。
 *
 * ## 已知歧义（机械匹配，不是自然语言语义理解）
 *
 * - `分` / `角` 只在后接 `钱` 时算量词（`一分钱` 拒绝；`十分谨慎` 放行）；
 * - 量词表**不含** `类`（会误杀「两类风险」）。数字 + `级`/`档` 判为数值（`三级客户`），
 *   代价是「两级分化」这类含数字语素的成语也会被拒绝——保守方向选择「宁可拒绝」；
 * - `一处`/`一方面`/`一类` 这类「数字字符 + 非量词」的模糊表述按普通词汇放行；
 * - `前年`/`前期` 等不以数字字符结尾的「前 X」不受 cn_ranking 影响（`前三年` 会被拒绝）；
 * - 无法穷尽自然语言：新增误杀/漏检都应改规则表 / 豁免表与对应测试，并同步规格 §8.2.1。
 */
const CN_NUMERALS = '〇零一二三四五六七八九十百千万亿兆两廿卅壹贰叁肆伍陆柒捌玖拾佰仟萬億兩'
/** 量词/单位（金额、数量、时间、等级）：紧跟数字字符即视为具体数值 */
const CN_UNITS = '个人家位名次条份件台套张笔项元亿级档月年天日周季岁'

export interface AnnualReviewAiNumericRule {
  /** 稳定 id：进失败文案，便于定位是哪条规则命中 */
  id: string
  /** 规则说明（可解释性集中在规则表里，不散落在注释中） */
  description: string
  pattern: RegExp
}

/**
 * 规则表（每条都是「明确数值表达」的形状，不依赖词义推断）。
 * 注意 `分`/`角` 用后接 `钱` 的前瞻：它们是量词，但裸用会误杀「十分」「一角（角落）」。
 */
export const ANNUAL_REVIEW_AI_NUMERIC_RULES: readonly AnnualReviewAiNumericRule[] = [
  { id: 'decimal_digit', description: '任意 Unicode 十进制数字（含全角）', pattern: /\p{Nd}/u },
  { id: 'cn_ordinal', description: '中文序数：第 + 数字字符', pattern: new RegExp(`第[${CN_NUMERALS}]`, 'u') },
  { id: 'cn_ranking', description: '中文排名：前 + 数字字符（前五 / 前十 / 前三名）', pattern: new RegExp(`前[${CN_NUMERALS}]`, 'u') },
  { id: 'cn_fraction', description: '中文分数：百分之/千分之/万分之 + 数字', pattern: new RegExp(`(?:百分之|千分之|万分之)[${CN_NUMERALS}\\p{Nd}]`, 'u') },
  { id: 'cn_ratio', description: '中文比例/倍数：数字字符 + 成/折/倍', pattern: new RegExp(`[${CN_NUMERALS}][成折倍]`, 'u') },
  { id: 'cn_quantity', description: '中文数量/金额/时间/等级：数字字符 + 量词（分/角需后接「钱」）', pattern: new RegExp(`[${CN_NUMERALS}](?:[${CN_UNITS}]|[分角](?=钱))`, 'u') },
  { id: 'cn_numeral_run', description: '连续两个及以上数字字符', pattern: new RegExp(`[${CN_NUMERALS}]{2,}`, 'u') }
]

export type AnnualReviewAiNumericExemptionKind = 'adverb' | 'non_quantity_form'

export interface AnnualReviewAiNumericExemption {
  /** 稳定 id：测试据此断言每条豁免都在起作用 */
  id: string
  /**
   * adverb = 该串在此语境下是副词（必须带上下文后缀才豁免）；
   * non_quantity_form = 该串在中文里不构成数量表达（按整串豁免，理由见 description）。
   */
  kind: AnnualReviewAiNumericExemptionKind
  /** 豁免理由（写清「为什么它不可能是数量」） */
  description: string
  /** 全局正则（gu），只替换匹配到的片段 */
  pattern: RegExp
}

/**
 * 豁免表。除 `qianwan_adverb` 外均为「不可能是数量」的整串豁免；
 * `千万` 只能靠上下文豁免——裸 `千万` 是真实金额（一千万），不得放行。
 */
export const ANNUAL_REVIEW_AI_NUMERIC_EXEMPTIONS: readonly AnnualReviewAiNumericExemption[] = [
  {
    id: 'qianwan_adverb',
    kind: 'adverb',
    description: '「千万」后接副词后缀时是「务必」义（千万不要/千万不能/千万别/千万避免/千万务必/千万不可/千万注意…），此时不表示一千万',
    pattern: /千万(?:要|不能|别|避免|务必|不可|注意|记得|不要|谨记|谨防|防止|保持|把握)/gu
  },
  {
    id: 'wanyi_conjunction',
    kind: 'non_quantity_form',
    description: '「万一」是连词（万一发生…）；中文数量写作「一万」，「万一」不是数量形式',
    pattern: /万一/gu
  },
  {
    id: 'yiyi_sequential',
    kind: 'non_quantity_form',
    description: '「一一」表示逐个（一一核实）；中文数量写作「一万一千」这类，「一一」不是数量形式',
    pattern: /一一/gu
  },
  {
    id: 'wanwan_archaic',
    kind: 'non_quantity_form',
    description: '「万万」是副词或古旧量词（万万不可）；现代中文数量写作「亿」',
    pattern: /万万/gu
  },
  {
    id: 'yicheng_idiom',
    kind: 'non_quantity_form',
    description: '「一成不变」是成语；单独出现的「一成」（10%）仍由 cn_ratio 拒绝',
    pattern: /一成不变/gu
  }
]

export type AnnualReviewAiNumericVerdict = { claimed: false } | { claimed: true; ruleIds: string[] }

/**
 * 在**匹配到的位置**上屏蔽豁免片段（等长占位，保持偏移）。
 * 与上一版「全局替换某串字」的区别：`千万` 只在其后接副词后缀时被屏蔽，
 * 裸 `千万` 原样留给规则表判定。
 */
function maskNumericExemptions(text: string): string {
  let out = text
  for (const exemption of ANNUAL_REVIEW_AI_NUMERIC_EXEMPTIONS) {
    out = out.replace(exemption.pattern, (matched) => '\u25c7'.repeat(matched.length))
  }
  return out
}

/**
 * 数字声明识别（纯函数，单一实现；readQualitativeText 使用）。
 * 返回命中的规则 id 列表：调用方据此给出可解释的失败文案，测试据此锁定规则边界。
 */
export function detectNumericClaim(text: string): AnnualReviewAiNumericVerdict {
  const scanned = maskNumericExemptions(text)
  const ruleIds = ANNUAL_REVIEW_AI_NUMERIC_RULES.filter((rule) => rule.pattern.test(scanned)).map((rule) => rule.id)
  return ruleIds.length === 0 ? { claimed: false } : { claimed: true, ruleIds }
}

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
 * 返回错误原因（null = 合法）。回显的键名按单行、限长处理（模型输出，不整段转发）。
 */
function metricKeysError(v: unknown, allowed: ReadonlySet<string>): string | null {
  if (!Array.isArray(v)) return 'metricKeys 不是数组'
  if (v.length === 0) return 'metricKeys 为空'
  if (v.length > ANNUAL_REVIEW_AI_LIMITS.metricKeysPerItem) return `metricKeys 超过 ${ANNUAL_REVIEW_AI_LIMITS.metricKeysPerItem} 项`
  const seen = new Set<string>()
  for (const item of v) {
    if (typeof item !== 'string' || item.trim() === '') return 'metricKeys 含非字符串或空值'
    const key = item.trim()
    if (!allowed.has(key)) return `metricKeys 引用未知指标：${compactEcho(key)}`
    if (seen.has(key)) return `metricKeys 重复引用：${compactEcho(key)}`
    seen.add(key)
  }
  return null
}

/** 单行限长回显（错误文案里只出现我们自己与模型产出的短片段，不整段转发） */
function compactEcho(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 64)
}

/** 定性文本字段校验结果：数字表达单独给码，便于调用方区分「格式错」与「编造数字」 */
type QualitativeText = { ok: true; text: string } | { ok: false; code: AnnualReviewAiParseFailureCode; message: string }

/**
 * 读取一个 AI 文本字段：trim 后必须非空、不超长，且不得含数字声明。
 * V1 不接受具体数字——判定规则见 ANNUAL_REVIEW_AI_NUMERIC_RULES。
 */
function readQualitativeText(v: unknown, at: string, max: number): QualitativeText {
  const text = readText(v, max)
  if (text === null) return { ok: false, code: 'invalid_shape', message: `${at} 为空或超长` }
  const verdict = detectNumericClaim(text)
  if (verdict.claimed) {
    return { ok: false, code: 'numeric_claim', message: `${at} 含数字声明（命中规则：${verdict.ruleIds.join('/')}）` }
  }
  return { ok: true, text }
}

function readMetricKeys(v: unknown): string[] {
  return (v as string[]).map((k) => k.trim())
}

/**
 * 解析并严格校验模型输出。任何一处不合法 → 整体失败（不部分采信、不补默认值）。
 * 文本字段额外执行数字禁令（违规返回 code=`numeric_claim`）。
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

  const summaryText = readQualitativeText(parsed.executiveSummary, 'executiveSummary', ANNUAL_REVIEW_AI_LIMITS.executiveSummary)
  if (!summaryText.ok) return summaryText
  const executiveSummary = summaryText.text

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
    const title = readQualitativeText(item.title, `${at}.title`, ANNUAL_REVIEW_AI_LIMITS.diagnosisTitle)
    if (!title.ok) return title
    const observation = readQualitativeText(item.observation, `${at}.observation`, ANNUAL_REVIEW_AI_LIMITS.diagnosisObservation)
    if (!observation.ok) return observation
    const hypothesis = readQualitativeText(item.hypothesis, `${at}.hypothesis`, ANNUAL_REVIEW_AI_LIMITS.diagnosisHypothesis)
    if (!hypothesis.ok) return hypothesis
    const keysError = metricKeysError(item.metricKeys, allowed)
    if (keysError) return { ok: false, code: 'invalid_shape', message: `${at}.${keysError}` }
    if (!(ANNUAL_REVIEW_AI_CONFIDENCE as readonly unknown[]).includes(item.confidence)) {
      return { ok: false, code: 'invalid_shape', message: `${at}.confidence 非法枚举` }
    }
    diagnoses.push({
      title: title.text,
      observation: observation.text,
      hypothesis: hypothesis.text,
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
    const action = readQualitativeText(item.action, `${at}.action`, ANNUAL_REVIEW_AI_LIMITS.actionAction)
    if (!action.ok) return action
    const rationale = readQualitativeText(item.rationale, `${at}.rationale`, ANNUAL_REVIEW_AI_LIMITS.actionRationale)
    if (!rationale.ok) return rationale
    const keysError = metricKeysError(item.metricKeys, allowed)
    if (keysError) return { ok: false, code: 'invalid_shape', message: `${at}.${keysError}` }
    if (!(ANNUAL_REVIEW_AI_HORIZONS as readonly unknown[]).includes(item.horizon)) {
      return { ok: false, code: 'invalid_shape', message: `${at}.horizon 非法枚举` }
    }
    actions.push({
      priority: item.priority as AnnualReviewAiPriority,
      action: action.text,
      rationale: rationale.text,
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
    const risk = readQualitativeText(item.risk, `${at}.risk`, ANNUAL_REVIEW_AI_LIMITS.riskRisk)
    if (!risk.ok) return risk
    const keysError = metricKeysError(item.metricKeys, allowed)
    if (keysError) return { ok: false, code: 'invalid_shape', message: `${at}.${keysError}` }
    risks.push({ risk: risk.text, metricKeys: readMetricKeys(item.metricKeys) })
  }

  return { ok: true, analysis: { executiveSummary, diagnoses, actions, risks } }
}
