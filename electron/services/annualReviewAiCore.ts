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

/** 白名单成员判定：非字符串 / 未收录 → undefined（调用方据此省略或丢弃） */
function whitelisted(value: unknown, allowed: readonly string[]): string | undefined {
  return typeof value === 'string' && allowed.includes(value) ? value : undefined
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
   * null = 分布未产出（unavailable）或全部桶名未通过白名单（无法确认，不冒充空分布）；
   * 绝不用空数组冒充「全为零」。
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
  /** 未通过 source 白名单时整个字段省略（报告只保证它是非空字符串） */
  source?: string
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

/** 覆盖结构 → AI 输入条目：source/reasonCodes 走白名单，未确认的值省略而非转发 */
function toCoverageEntry(key: string, coverage: AnnualReviewCoverage, allowedCodes: ReadonlySet<string>): AnnualReviewAiCoverageEntry {
  const entry: AnnualReviewAiCoverageEntry = { key, status: coverage.status }
  const source = whitelisted(coverage.source, ANNUAL_REVIEW_AI_ALLOWED_SOURCES)
  if (source !== undefined) entry.source = source
  if (typeof coverage.rows === 'number') entry.rows = coverage.rows
  if (typeof coverage.exactCoverage === 'boolean') entry.exactCoverage = coverage.exactCoverage
  if (coverage.coverageRatio !== undefined) entry.coverageRatio = coverage.coverageRatio
  const codes = Array.isArray(coverage.reasonCodes)
    ? [...new Set(coverage.reasonCodes.filter((code) => allowedCodes.has(code)))]
    : []
  if (codes.length > 0) entry.reasonCodes = codes
  return entry
}

/** 分布桶：桶名必须命中 FUNNEL_ORDER；全部未命中 → null（无法确认，不冒充空分布） */
function toBuckets(list: ReadonlyArray<{ bucket: string; count: number }> | null): Array<{ bucket: string; count: number }> | null {
  if (list === null) return null
  const buckets = list
    .filter((d) => ANNUAL_REVIEW_AI_ALLOWED_BUCKETS.includes(d.bucket))
    .map((d) => ({ bucket: d.bucket, count: d.count }))
  return buckets.length > 0 ? buckets : null
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
 *   - 自由文本字段（warnings.message、未确认的 source/reasonCodes/code/bucket/kind）
 *     一律不发（见 ANNUAL_REVIEW_AI_ALLOWED_* 白名单）——报告 validator 只保证这些
 *     字段「是非空字符串」，不能据此相信其内容；
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
      kind: whitelisted(report.funnel.customerStage.kind, ANNUAL_REVIEW_AI_ALLOWED_KINDS) ?? null,
      state: report.funnel.customerStage.coverage.status,
      buckets: toBuckets(report.funnel.customerStage.distribution)
    },
    {
      key: 'funnel.opportunityStage',
      kind: whitelisted(report.funnel.opportunityStage.kind, ANNUAL_REVIEW_AI_ALLOWED_KINDS) ?? null,
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
      kind: whitelisted(report.funnel.lostBreakdown.kind, ANNUAL_REVIEW_AI_ALLOWED_KINDS) ?? null,
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

  const allowedCodes = new Set(ANNUAL_REVIEW_AI_ALLOWED_CODES)
  const allowedKeys = new Set(annualReviewAiMetricKeys(report))
  const coverage: AnnualReviewAiCoverageEntry[] = [...allowedKeys]
    .sort()
    .map((key) => toCoverageEntry(key, report.coverage[key], allowedCodes))

  // 警告：未知 code（可能携带任意文本）连行一起丢；metricKey 同样只认报告 coverage 键集合；
  // 不转发 message（自由文本，见 AnnualReviewAiWarning 注释）
  const warnings: AnnualReviewAiWarning[] = []
  for (const w of report.warnings) {
    if (!allowedCodes.has(w.code)) continue
    const metricKeys = [...new Set(w.metricKeys.filter((key) => allowedKeys.has(key)))]
    if (metricKeys.length === 0) continue
    const row: AnnualReviewAiWarning = { code: w.code, metricKeys }
    if (w.counts !== undefined) {
      const counts: Record<string, number> = {}
      for (const key of metricKeys) {
        const count = w.counts[key]
        if (typeof count === 'number') counts[key] = count
      }
      if (Object.keys(counts).length > 0) row.counts = counts
    }
    warnings.push(row)
  }

  return { meta, metrics, distributions, series, coverage, warnings }
}

// ─── Prompt ──────────────────────────────────────────────────────────────────

/**
 * 固定 system prompt。四条必须在提示词里说清，因为它们是本模块的验收口径：
 * 数字只能来自输入、**文本里一个数字都不许写**（见 ANNUAL_REVIEW_AI_NUMERIC_CLAIM）、
 * unavailable 不是 0、每条判断必须引用真实 metricKeys。
 */
export const ANNUAL_REVIEW_AI_SYSTEM_PROMPT = [
  '你是 B2B 销售年度经营复盘分析助手（工业品 / 叉车仓储设备行业）。你的输入是一份已经算好的年度经营数据，你只负责解释与建议。',
  '',
  '铁律（违反即视为无效输出）：',
  '1. 只能用输入数据说话：不得引入行业常识、经验值、外部事实或任何输入中不存在的信息。',
  '2. 不得自行计算、推算、换算或改写金额、比例、排名、增长率、同比环比；也不要复述输入中的具体数值。',
  `3. **正文里不得出现任何数字**：阿拉伯数字、全角数字、中文数字（〇零一二三四五六七八九十百千万亿两 等）都不允许。不要写百分比、金额、数量、排名（如「排名第几」）、年份、季度序号、月份序号。需要表达多少时只用定性词：多数 / 大部分 / 部分 / 少数 / 若干 / 明显 / 略低 / 偏高。确定性数字由页面按 metricKeys 从原报告直接展示，你只做定性解释。唯一允许出现数字的位置是 JSON 字段 priority 的取值（如 1 表示最高优先级）。`,
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
 * 数字字面量检测（V1 最保守规则）。
 *
 * 只校验 metricKeys 并不能阻止模型在正文里编造数字——「回款比签约高 83%」「损失 100 万元」
 * 「排名第一」都可以挂着合法 metricKey 出现，而报告里根本没有这些数。V1 的做法是彻底
 * 不在 AI 文本里接受数字：确定性数字由页面依据 metricKeys 从原报告渲染，AI 只输出定性解释。
 *
 * 覆盖：任意 Unicode 十进制数字（含全角），以及中文数字字符（小写、大写、两/萬/億 等变体）。
 * 这是「宁可更严」的取舍：正文里「统一」「一致」「十分」这类词也会被拒绝，
 * 提示词已明确要求改用定性词表达程度。
 */
const NUMERIC_CLAIM = /[\p{Nd}]|[〇零一二三四五六七八九十百千万亿兆两廿卅壹贰叁肆伍陆柒捌玖拾佰仟萬億兩]/u

/** 数字禁令的单一实现（readQualitativeText 使用；行为经 parseAnnualReviewAiOutput 断言） */
function hasNumericClaim(text: string): boolean {
  return NUMERIC_CLAIM.test(text)
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
 * 读取一个 AI 文本字段：trim 后必须非空、不超长，且不得含数字表达。
 * V1 不接受数字——见 NUMERIC_CLAIM 注释。
 */
function readQualitativeText(v: unknown, at: string, max: number): QualitativeText {
  const text = readText(v, max)
  if (text === null) return { ok: false, code: 'invalid_shape', message: `${at} 为空或超长` }
  if (hasNumericClaim(text)) return { ok: false, code: 'numeric_claim', message: `${at} 含数字表达（V1 禁止 AI 文本出现数字）` }
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
