/**
 * annualReviewReport.ts —— 年度经营复盘 · 报告组装与可用年份（S3，纯模块）
 *
 * 职责（规格 docs/设计-年度经营复盘-规格.md §7.2 / §10 / S3 任务）：
 *   - composeAnnualReviewReport：把 S1（A1–A9）与 S2（B1/B2/B3/B6/B7/C1–C8）已验收的
 *     纯统计结果装配为最终 AnnualReviewReport。**本模块不做任何第二次口径计算**：
 *     每个区块的 value/state/warnings/coverage/reasonCodes 原样来自统计层；
 *     unavailable 不得转成 0，D/E 组与月度趋势未实现 → 显式 unavailable 区块
 *     （reasonCode=metric_not_implemented），不伪造空数组/零值。
 *   - 已批准契约补全（规格 §7.2）：dataRange（本次实际输入事实的最早/最晚有效时间，
 *     空数据 {from:null,to:null}）、completeness（四态聚合纯函数，优先级确定性）、
 *     coverage（稳定 metricKey → 覆盖结构映射；B/C 复用统计层，A 组单一映射）、
 *     warnings（全指标聚合，同 code 合并 + 稳定 metricKeys/counts）、sourceSummary
 *     （真实输入事实数组的稳定行数摘要，无路径/SQL/身份原文）。
 *   - 客户公开身份映射（规格 §7.2「客户身份只引用 account.id/customer_id」）：
 *     C5–C8 统计层内部使用 sessionId，组装层把每行映射为 accountId（优先，经
 *     facts.accounts 绑定）或 customer_profile.customer_id；无法映射时保留行
 *     （计数口径不变）但身份字段为 null——绝不把 sessionId/wxid 暴露进公开报告。
 *   - computeAnnualReviewAvailableYears：由真实事实时间戳推导可用年份 + 每年份覆盖摘要，
 *     主进程计算，renderer 不推断。自然年升序、0=历史以来固定末尾。
 *   - validateAnnualReviewReport：Worker 结果的运行时结构校验（集中式 runtime guard）。
 *   - validateAnnualReviewYearInput：IPC 入口的运行时年份校验（不依赖 TypeScript 类型）。
 *
 * 边界：零 Electron 依赖、零数据库访问、不修改输入、同输入同输出（输出与输入行序
 * 无关）；输出全部为可 structuredClone / JSON 序列化的普通对象；不含数据库路径、SQL、
 * wxid 原文、sessionId/session_id、Token/密钥、原始聊天内容、调试堆栈。
 */
import {
  ANNUAL_REVIEW_REPORT_SCHEMA_VERSION,
  assertValidPeriod,
  computeAnnualReviewSummary,
  annualReviewCreditedAllocationsInRange,
  annualReviewSignedContractsInRange,
  asFinite,
  normSession,
  resolveAnnualReviewPeriod,
  type AnnualReviewComputeOptions,
  type AnnualReviewFacts,
  type AnnualReviewPeriod,
  type AnnualReviewSummary,
  type MetricState,
  type MetricWarning
} from './annualReviewStats'
import {
  computeAnnualReviewActiveCustomerDetails,
  computeAnnualReviewCustomerStageDistribution,
  computeAnnualReviewCurrentPriorityCustomers,
  computeAnnualReviewDealingCustomers,
  computeAnnualReviewHighValueCustomers,
  computeAnnualReviewLostBreakdown,
  computeAnnualReviewNewCustomerDetails,
  computeAnnualReviewOpportunityStageDistribution,
  computeAnnualReviewRepeatCustomers,
  computeAnnualReviewRiskCustomers,
  computeAnnualReviewSilentCustomers,
  computeAnnualReviewStageFlow,
  computeAnnualReviewStuckCustomers,
  type AnnualReviewCoverage,
  type AnnualReviewCrmSegmentsFacts,
  type AnnualReviewSalesSegmentsFacts
} from './annualReviewSegments'

// ─── 报告结构 ────────────────────────────────────────────────────────────────

/** 尚未实现区块的显式占位：UI 按 unavailable 渲染（折叠/「暂无可靠数据」），绝不显示为 0 */
export interface AnnualReviewUnavailableBlock {
  status: 'unavailable'
  /** 稳定 code：metric_not_implemented = 该指标组在当前版本尚未实现（非数据缺失） */
  reasonCodes: string[]
}

const NOT_IMPLEMENTED_BLOCK: AnnualReviewUnavailableBlock = Object.freeze({
  status: 'unavailable',
  reasonCodes: Object.freeze(['metric_not_implemented'])
}) as AnnualReviewUnavailableBlock

/** 漏斗与阶段区块（S2 已验收统计的原样装配） */
export interface AnnualReviewFunnelBlock {
  customerStage: ReturnType<typeof computeAnnualReviewCustomerStageDistribution>
  opportunityStage: ReturnType<typeof computeAnnualReviewOpportunityStageDistribution>
  stageFlow: ReturnType<typeof computeAnnualReviewStageFlow>
  stuck: ReturnType<typeof computeAnnualReviewStuckCustomers>
  lostBreakdown: ReturnType<typeof computeAnnualReviewLostBreakdown>
}

// ─── 客户公开身份（C5–C8：sessionId 只存在于统计层，公开报告只引用业务身份） ──

/** C5 活跃客户行（来源即 account.session_id，恒可映射到 account.id） */
export interface AnnualReviewActiveCustomerRow {
  accountId: number | null
  name: string | null
}

/** 客户公开身份（规格 §7.2：只引用 account.id / customer_id，绝不暴露 sessionId/wxid） */
export interface AnnualReviewCustomerIdentity {
  /** crmDb account.id（绑定客户优先）；null = 未绑定 account */
  accountId: number | null
  /** customer_profile.customer_id（迁移模块⑤对齐 crmDb customer.id）；null = 未对齐 */
  customerId: string | null
  /** CRM 客户名（来自 account.name，展示用） */
  name: string | null
}

export interface AnnualReviewSilentCustomerRow extends AnnualReviewCustomerIdentity {
  lastContactAtMs: number
}

export interface AnnualReviewRiskCustomerRow extends AnnualReviewCustomerIdentity {
  stage: string
  lastContactAtMs: number
}

export type AnnualReviewPriorityCustomerRow = AnnualReviewSilentCustomerRow

/** 客户经营区块（S2 已验收统计的原样装配；C5–C8 行经身份映射，计数口径不变） */
export interface AnnualReviewCustomersBlock {
  highValue: ReturnType<typeof computeAnnualReviewHighValueCustomers>
  newCustomers: ReturnType<typeof computeAnnualReviewNewCustomerDetails>
  dealing: ReturnType<typeof computeAnnualReviewDealingCustomers>
  repeat: ReturnType<typeof computeAnnualReviewRepeatCustomers>
  active: { value: AnnualReviewActiveCustomerRow[] | null; coverage: AnnualReviewCoverage; warnings: MetricWarning[] }
  silent: { value: AnnualReviewSilentCustomerRow[] | null; coverage: AnnualReviewCoverage; warnings: MetricWarning[] }
  risk: { value: AnnualReviewRiskCustomerRow[] | null; coverage: AnnualReviewCoverage; warnings: MetricWarning[] }
  priority: { value: AnnualReviewPriorityCustomerRow[] | null; coverage: AnnualReviewCoverage; warnings: MetricWarning[] }
}

// ─── 已批准契约补全：dataRange / completeness / coverage / warnings / sourceSummary ──

/** 本次报告涉及数据源的实际最早/最晚有效事实时间；空数据没有真实范围 → 双 null */
export interface AnnualReviewDataRange {
  from: number | null
  to: number | null
}

/** 完整性区块 id（稳定枚举） */
export type AnnualReviewBlockId = 'summary' | 'funnel' | 'customers' | 'monthly' | 'communication' | 'salesAssignment'

export interface AnnualReviewCompleteness {
  overall: MetricState
  blocks: Record<AnnualReviewBlockId, MetricState>
}

/**
 * 全指标 warnings 聚合行：相同 code 合并；metricKeys 稳定排序；
 * counts 按指标拆分（键=metricKey，稳定排序）——同 code 不同指标的数量**不相加**。
 */
export interface AnnualReviewAggregatedWarning {
  code: string
  message: string
  metricKeys: string[]
  counts?: Record<string, number>
}

/** 数据源摘要行：真实输入事实数组的稳定行数；不含路径/SQL/身份原文/聊天正文 */
export interface AnnualReviewSourceSummaryRow {
  source: string
  tables: string[]
  rows: number
  note?: string
}

export interface AnnualReviewReport {
  reportSchemaVersion: number
  /** 年份；0 = 历史以来 */
  year: number
  scopeKind: AnnualReviewPeriod['scopeKind']
  periodStart: number | null
  periodEndExclusive: number | null
  /** current_year/all_time = generatedAt；historical_year = periodEndExclusive（时间契约 §3.0） */
  asOf: number
  /** 永远只表示报告实际生成时间，不兼作历史数据时点 */
  generatedAt: number
  timezoneNote: 'local'
  /** 本报告涉及数据源的实际最早/最晚有效事实时间；非名义 period 边界 */
  dataRange: AnnualReviewDataRange
  /** 四态完整性（统计层结果聚合；UI 不计算） */
  completeness: AnnualReviewCompleteness
  /** 稳定 metricKey → 覆盖结构（B/C 复用统计层；A 组组装层单一映射） */
  coverage: Record<string, AnnualReviewCoverage>
  /** 全指标 warnings 聚合（同 code 合并；metricKeys/counts 稳定排序） */
  warnings: AnnualReviewAggregatedWarning[]
  /** A1–A9（S1 原样） */
  summary: AnnualReviewSummary
  funnel: AnnualReviewFunnelBlock
  customers: AnnualReviewCustomersBlock
  /** 月度趋势（合同金额/核销回款/消息量按月序列）——当前版本未实现，显式 unavailable */
  monthly: AnnualReviewUnavailableBlock
  /** D 组沟通质量——当前版本未实现，显式 unavailable */
  communication: AnnualReviewUnavailableBlock
  /** E 组销售与分配——当前版本未实现，显式 unavailable */
  salesAssignment: AnnualReviewUnavailableBlock
  /** 真实输入事实与消息统计来源摘要（行数确定、无敏感内容） */
  sourceSummary: AnnualReviewSourceSummaryRow[]
}

export interface ComposeAnnualReviewReportInput {
  period: AnnualReviewPeriod
  facts: AnnualReviewFacts
  sales: AnnualReviewSalesSegmentsFacts
  crm: AnnualReviewCrmSegmentsFacts
  opts?: AnnualReviewComputeOptions
}

// ─── completeness 聚合（纯函数，确定性优先级） ───────────────────────────────

/**
 * 四态聚合，确定性优先级（与输入顺序无关）：
 *   unavailable > partial > snapshot_only > complete。
 * 依据（规格 §4）：unavailable = 不可靠（最差，禁止 0 冒充）；partial = 数据存在但受限；
 * snapshot_only = 合法快照形态（非降级）；complete = 无保留。
 * 未实现的区块（D/E/monthly）恒 unavailable——不得把已实现组的数字伪装为 complete。
 */
export function aggregateMetricStates(states: readonly MetricState[]): MetricState {
  if (states.length === 0) return 'unavailable'
  let sawPartial = false
  let sawSnapshotOnly = false
  for (const s of states) {
    if (s === 'unavailable') return 'unavailable'
    if (s === 'partial') sawPartial = true
    else if (s === 'snapshot_only') sawSnapshotOnly = true
  }
  if (sawPartial) return 'partial'
  if (sawSnapshotOnly) return 'snapshot_only'
  return 'complete'
}

// ─── coverage：稳定 metricKey → 覆盖结构 ─────────────────────────────────────

/** A 组指标 → 统计来源（单一映射表；A3 主口径可用时为 wcdb.messages，否则回退 crmdb.account） */
const A_GROUP_COVERAGE_SOURCE: Record<keyof AnnualReviewSummary, string> = {
  customerTotal: 'crmdb.account',
  customerNew: 'crmdb.account',
  customerActive: 'wcdb.messages',
  contractCount: 'crmdb.contract',
  contractAmount: 'crmdb.contract',
  creditedAmount: 'crmdb.allocation',
  shippedCount: 'crmdb.contract_status_history',
  shippedAmount: 'crmdb.contract_status_history',
  dealingCustomers: 'crmdb.contract',
  avgDealSize: 'derived:contract_amount/dealing_customers'
}

const SUMMARY_METRIC_KEYS = [
  'customerTotal', 'customerNew', 'customerActive', 'contractCount', 'contractAmount',
  'creditedAmount', 'shippedCount', 'shippedAmount', 'dealingCustomers', 'avgDealSize'
] as const

/** 顶层 coverage 的稳定 metricKey 全集（B/C 组 = 区块字段名，A 组 = summary.<metric>） */
const FUNNEL_METRIC_KEYS = ['customerStage', 'opportunityStage', 'stageFlow', 'stuck', 'lostBreakdown'] as const
const CUSTOMERS_METRIC_KEYS = ['highValue', 'newCustomers', 'dealing', 'repeat', 'active', 'silent', 'risk', 'priority'] as const
const NOT_IMPLEMENTED_METRIC_KEYS = ['monthly', 'communication', 'salesAssignment'] as const

function cloneCoverage(c: AnnualReviewCoverage): AnnualReviewCoverage {
  const out: AnnualReviewCoverage = { ...c }
  if (c.reasonCodes) out.reasonCodes = [...c.reasonCodes]
  return out
}

function warningsToReasonCodes(warnings: MetricWarning[]): string[] {
  return [...new Set(warnings.map((w) => w.code))].sort()
}

// ─── warnings 聚合（输出与输入顺序无关） ─────────────────────────────────────

function aggregateWarnings(entries: ReadonlyArray<{ metricKey: string; warnings: MetricWarning[] }>): AnnualReviewAggregatedWarning[] {
  const byCode = new Map<string, { messages: Set<string>; metrics: Set<string>; counts: Map<string, number> }>()
  for (const { metricKey, warnings } of entries) {
    for (const w of warnings) {
      let entry = byCode.get(w.code)
      if (!entry) {
        entry = { messages: new Set(), metrics: new Set(), counts: new Map() }
        byCode.set(w.code, entry)
      }
      if (typeof w.message === 'string' && w.message) entry.messages.add(w.message)
      entry.metrics.add(metricKey)
      if (typeof w.count === 'number' && Number.isFinite(w.count)) entry.counts.set(metricKey, w.count)
    }
  }
  const out: AnnualReviewAggregatedWarning[] = []
  for (const code of [...byCode.keys()].sort()) {
    const entry = byCode.get(code)
    if (!entry) continue
    const metricKeys = [...entry.metrics].sort()
    const row: AnnualReviewAggregatedWarning = {
      code,
      message: [...entry.messages].sort()[0] ?? '',
      metricKeys
    }
    if (entry.counts.size > 0) {
      const counts: Record<string, number> = {}
      for (const metricKey of metricKeys) {
        const c = entry.counts.get(metricKey)
        if (c !== undefined) counts[metricKey] = c
      }
      row.counts = counts
    }
    out.push(row)
  }
  return out
}

// ─── dataRange（实际输入事实时间，非名义边界） ───────────────────────────────

/** 事实年份下界：早于此视为秒/毫秒混用或荒谬时间，不进入范围（与可用年份同规则） */
const MIN_FACT_YEAR = 2000

/** 有效事实时间：有限、区间内（右开 asOf）、毫秒级合理值；秒值/NaN/未来值一律排除 */
function validFactTimeInRange(raw: unknown, period: AnnualReviewPeriod): number | null {
  const t = asFinite(raw)
  if (t === null || t <= 0 || t >= period.asOf) return null
  if (period.periodStart !== null && t < period.periodStart) return null
  if (new Date(t).getFullYear() < MIN_FACT_YEAR) return null
  return t
}

function computeDataRange(period: AnnualReviewPeriod, facts: AnnualReviewFacts, sales: AnnualReviewSalesSegmentsFacts, crm: AnnualReviewCrmSegmentsFacts): AnnualReviewDataRange {
  const times: number[] = []
  const push = (raw: unknown): void => {
    const t = validFactTimeInRange(raw, period)
    if (t !== null) times.push(t)
  }
  for (const acc of facts.accounts ?? []) push(acc.createdAt)
  for (const c of annualReviewSignedContractsInRange(period, facts.contracts ?? []).signedInRange) push(c.signDate)
  for (const row of annualReviewCreditedAllocationsInRange(period, facts.allocations ?? []).rows) push(row.time)
  for (const ev of sales.intentEvents ?? []) push(ev.createdAt)
  for (const o of crm.opportunities ?? []) push(o.createdAt)
  if (times.length === 0) return { from: null, to: null }
  return { from: Math.min(...times), to: Math.max(...times) }
}

// ─── sourceSummary（真实输入事实数组 + 消息统计来源；确定、无敏感内容） ──────

const SOURCE_SUMMARY_INPUT_NOTE = '加载层输入事实行数（全量行，年度过滤由统计层执行）'

function buildSourceSummary(
  facts: AnnualReviewFacts,
  sales: AnnualReviewSalesSegmentsFacts,
  crm: AnnualReviewCrmSegmentsFacts,
  opts: AnnualReviewComputeOptions
): AnnualReviewSourceSummaryRow[] {
  const messageStats = opts.messageStats ?? null
  const messageRows = messageStats !== null && messageStats.ok === true
    ? Object.keys(messageStats.sessions ?? {}).length
    : 0
  return [
    {
      source: 'crmdb',
      tables: ['account', 'contract', 'allocation', 'contract_status_history'],
      rows: (facts.accounts?.length ?? 0) + (facts.contracts?.length ?? 0) + (facts.allocations?.length ?? 0) + (facts.shippedEvents?.length ?? 0),
      note: SOURCE_SUMMARY_INPUT_NOTE
    },
    {
      source: 'salesdb',
      tables: ['customer_profile', 'intent_tag_log'],
      rows: (sales.profiles?.length ?? 0) + (sales.intentEvents?.length ?? 0),
      note: SOURCE_SUMMARY_INPUT_NOTE
    },
    {
      source: 'crmdb',
      tables: ['opportunity', 'opportunity_event'],
      rows: (crm.opportunities?.length ?? 0) + (crm.opportunityEvents?.length ?? 0),
      note: SOURCE_SUMMARY_INPUT_NOTE
    },
    messageStats !== null && messageStats.ok === true
      ? { source: 'wcdb', tables: ['message'], rows: messageRows, note: '消息统计按会话聚合的会话数（A3 主口径）' }
      : { source: 'wcdb', tables: ['message'], rows: 0, note: '消息统计不可用（A3 活跃口径回退 account.last_contact_at）' }
  ]
}

// ─── 客户公开身份映射（sessionId 留在统计层，公开报告只引用业务身份） ────────

interface CustomerIdentityIndexValue {
  accountId: number | null
  customerId: string | null
  name: string | null
}

/** sessionId → 稳定业务身份：account 绑定优先（facts.accounts），其次 profile.customer_id */
function buildCustomerIdentityIndex(
  facts: AnnualReviewFacts,
  sales: AnnualReviewSalesSegmentsFacts
): Map<string, CustomerIdentityIndexValue> {
  const index = new Map<string, CustomerIdentityIndexValue>()
  for (const acc of facts.accounts ?? []) {
    const sid = normSession(acc.sessionId)
    if (!sid) continue
    const existing = index.get(sid)
    if (existing) {
      if (existing.accountId === null) {
        existing.accountId = acc.id
        existing.name = acc.name
      }
    } else {
      index.set(sid, { accountId: acc.id, customerId: null, name: acc.name })
    }
  }
  for (const profile of sales.profiles ?? []) {
    const sid = normSession(profile.sessionId)
    const cid = profile.customerId ?? null
    if (!sid || !cid) continue
    const existing = index.get(sid)
    if (existing) {
      if (existing.customerId === null) existing.customerId = cid
    } else {
      index.set(sid, { accountId: null, customerId: cid, name: null })
    }
  }
  return index
}

function identityOf(index: Map<string, CustomerIdentityIndexValue>, sessionId: string): CustomerIdentityIndexValue {
  const mapped = index.get(normSession(sessionId))
  return mapped ?? { accountId: null, customerId: null, name: null }
}

/**
 * 组装最终报告。统计口径全部来自 S1/S2 已验收纯函数；本函数只做装配与契约补全。
 * 同一输入（含 period.generatedAt）必得同一输出，且与输入行序无关；不修改输入。
 */
export function composeAnnualReviewReport(input: ComposeAnnualReviewReportInput): AnnualReviewReport {
  const period = input.period
  assertValidPeriod(period)
  const facts = input.facts
  const sales = input.sales
  const crm = input.crm
  const opts = input.opts ?? {}
  const inputs = { facts, sales, crm }

  const summary = computeAnnualReviewSummary(period, facts, opts)
  const funnel: AnnualReviewFunnelBlock = {
    customerStage: computeAnnualReviewCustomerStageDistribution(period, inputs, opts),
    opportunityStage: computeAnnualReviewOpportunityStageDistribution(period, inputs, opts),
    stageFlow: computeAnnualReviewStageFlow(period, inputs, opts),
    stuck: computeAnnualReviewStuckCustomers(period, inputs, opts),
    lostBreakdown: computeAnnualReviewLostBreakdown(period, inputs, opts)
  }
  const statsCustomers = {
    highValue: computeAnnualReviewHighValueCustomers(period, inputs, opts),
    newCustomers: computeAnnualReviewNewCustomerDetails(period, inputs, opts),
    dealing: computeAnnualReviewDealingCustomers(period, inputs, opts),
    repeat: computeAnnualReviewRepeatCustomers(period, inputs, opts),
    active: computeAnnualReviewActiveCustomerDetails(period, inputs, opts),
    silent: computeAnnualReviewSilentCustomers(period, inputs, opts),
    risk: computeAnnualReviewRiskCustomers(period, inputs, opts),
    priority: computeAnnualReviewCurrentPriorityCustomers(period, inputs, opts)
  }

  // 客户公开身份映射：计数口径不变，行内 sessionId 一律替换为 accountId/customerId
  const identityIndex = buildCustomerIdentityIndex(facts, sales)
  const customers: AnnualReviewCustomersBlock = {
    highValue: statsCustomers.highValue,
    newCustomers: statsCustomers.newCustomers,
    dealing: statsCustomers.dealing,
    repeat: statsCustomers.repeat,
    active: {
      value: statsCustomers.active.value === null
        ? null
        : statsCustomers.active.value.map((row) => {
            const identity = identityOf(identityIndex, row.sessionId)
            return { accountId: identity.accountId, name: identity.name }
          }),
      coverage: statsCustomers.active.coverage,
      warnings: statsCustomers.active.warnings
    },
    silent: {
      value: statsCustomers.silent.value === null
        ? null
        : statsCustomers.silent.value.map((row) => {
            const identity = identityOf(identityIndex, row.sessionId)
            return { accountId: identity.accountId, customerId: identity.customerId, name: identity.name, lastContactAtMs: row.lastContactAtMs }
          }),
      coverage: statsCustomers.silent.coverage,
      warnings: statsCustomers.silent.warnings
    },
    risk: {
      value: statsCustomers.risk.value === null
        ? null
        : statsCustomers.risk.value.map((row) => {
            const identity = identityOf(identityIndex, row.sessionId)
            return { accountId: identity.accountId, customerId: identity.customerId, name: identity.name, stage: row.stage, lastContactAtMs: row.lastContactAtMs }
          }),
      coverage: statsCustomers.risk.coverage,
      warnings: statsCustomers.risk.warnings
    },
    priority: {
      value: statsCustomers.priority.value === null
        ? null
        : statsCustomers.priority.value.map((row) => {
            const identity = identityOf(identityIndex, row.sessionId)
            return { accountId: identity.accountId, customerId: identity.customerId, name: identity.name, lastContactAtMs: row.lastContactAtMs }
          }),
      coverage: statsCustomers.priority.coverage,
      warnings: statsCustomers.priority.warnings
    }
  }

  // completeness：统计层结果聚合（UI 不计算）；未实现区块恒 unavailable
  const summaryStates = SUMMARY_METRIC_KEYS.map((key) => summary[key].state)
  const funnelStates = FUNNEL_METRIC_KEYS.map((key) => funnel[key].coverage.status)
  const customersStates = CUSTOMERS_METRIC_KEYS.map((key) => customers[key].coverage.status)
  const completeness: AnnualReviewCompleteness = {
    overall: 'unavailable',
    blocks: {
      summary: aggregateMetricStates(summaryStates),
      funnel: aggregateMetricStates(funnelStates),
      customers: aggregateMetricStates(customersStates),
      monthly: 'unavailable',
      communication: 'unavailable',
      salesAssignment: 'unavailable'
    }
  }
  completeness.overall = aggregateMetricStates(Object.values(completeness.blocks))

  // coverage：稳定 metricKey 全集；A 组单一映射（status=metric.state、reasonCodes=warnings codes）；B/C 原样复用
  const messageStatsAvailable = (opts.messageStats ?? null)?.ok === true
  const coverage: Record<string, AnnualReviewCoverage> = {}
  for (const key of SUMMARY_METRIC_KEYS) {
    const metric = summary[key]
    coverage[`summary.${key}`] = {
      source: key === 'customerActive' && !messageStatsAvailable ? 'crmdb.account' : A_GROUP_COVERAGE_SOURCE[key],
      status: metric.state,
      reasonCodes: warningsToReasonCodes(metric.warnings)
    }
  }
  for (const key of FUNNEL_METRIC_KEYS) coverage[`funnel.${key}`] = cloneCoverage(funnel[key].coverage)
  for (const key of CUSTOMERS_METRIC_KEYS) coverage[`customers.${key}`] = cloneCoverage(customers[key].coverage)
  for (const key of NOT_IMPLEMENTED_METRIC_KEYS) {
    coverage[key] = { source: 'not_implemented', status: 'unavailable', reasonCodes: ['metric_not_implemented'] }
  }

  // warnings：全指标聚合（固定遍历顺序 + 全排序输出 → 与输入行序无关）
  const warningEntries: Array<{ metricKey: string; warnings: MetricWarning[] }> = []
  for (const key of SUMMARY_METRIC_KEYS) warningEntries.push({ metricKey: `summary.${key}`, warnings: summary[key].warnings })
  for (const key of FUNNEL_METRIC_KEYS) warningEntries.push({ metricKey: `funnel.${key}`, warnings: funnel[key].warnings })
  for (const key of CUSTOMERS_METRIC_KEYS) warningEntries.push({ metricKey: `customers.${key}`, warnings: customers[key].warnings })

  return {
    reportSchemaVersion: ANNUAL_REVIEW_REPORT_SCHEMA_VERSION,
    year: period.year,
    scopeKind: period.scopeKind,
    periodStart: period.periodStart,
    periodEndExclusive: period.periodEndExclusive,
    asOf: period.asOf,
    generatedAt: period.generatedAt,
    timezoneNote: 'local',
    dataRange: computeDataRange(period, facts, sales, crm),
    completeness,
    coverage,
    warnings: aggregateWarnings(warningEntries),
    summary,
    funnel,
    customers,
    monthly: { ...NOT_IMPLEMENTED_BLOCK, reasonCodes: ['metric_not_implemented'] },
    communication: { ...NOT_IMPLEMENTED_BLOCK, reasonCodes: ['metric_not_implemented'] },
    salesAssignment: { ...NOT_IMPLEMENTED_BLOCK, reasonCodes: ['metric_not_implemented'] },
    sourceSummary: buildSourceSummary(facts, sales, crm, opts)
  }
}

// ─── 可用年份（主进程计算，renderer 不推断） ─────────────────────────────────

/** 年份覆盖摘要（规格 §7.2）：仅陈述「该年度存在 N 条事实」，不代表各指标完整性 */
export interface AnnualReviewYearCoverage {
  source: string
  status: 'complete'
  coverageFrom?: number
  coverageTo?: number
  rows: number
  reasonCodes: string[]
}

export interface AnnualReviewYearEntry {
  /** 年份；0 = 历史以来（当存在任何本地数据时提供，固定排在自然年之后） */
  year: number
  coverage: AnnualReviewYearCoverage
}

export interface AnnualReviewAvailableYearsResult {
  /** 自然年份升序；特殊项 0=历史以来（存在数据时）固定末尾 */
  years: AnnualReviewYearEntry[]
  /** 本地当前年（主进程给出） */
  currentYear: number
  supportsAllTime: boolean
  /** 主进程裁决：默认当前年 */
  defaultYear: number
}

export interface ComputeAvailableYearsInput {
  facts: AnnualReviewFacts
  sales: AnnualReviewSalesSegmentsFacts
  crm: AnnualReviewCrmSegmentsFacts
  /** 报告生成时刻（ms），用于推导本地当前年与右边界 */
  generatedAt: number
}

/**
 * 由真实事实时间戳推导可用年份（全量扫描本地库）：
 *   候选时间 = account.created_at / contract.sign_date（A4 口径 signed/shipped 缺失不计的
 *   集合之外的全部有效 sign_date）/ 核销计入时间（A6 口径）/ intent_tag_log.created_at /
 *   opportunity.created_at，全部右开于 generatedAt。
 *   年份换算用本地时区；2000 年前（秒值、纪元值）或晚于当前年的值一律排除——
 *   秒/毫秒混存与脏数据不会生成荒谬年份。
 *   排序规则：自然年份升序；特殊项 year=0（历史以来）固定放在最后。
 *   空库 → years=[]、supportsAllTime=false。
 */
export function computeAnnualReviewAvailableYears(input: ComputeAvailableYearsInput): AnnualReviewAvailableYearsResult {
  const generatedAt = asFinite(input.generatedAt)
  if (generatedAt === null || generatedAt <= 0) {
    throw new Error('annualReviewAvailableYears: 非法的 generatedAt')
  }
  const currentYear = new Date(generatedAt).getFullYear()
  const facts = input.facts
  const sales = input.sales
  const crm = input.crm

  // 复用 S1 已验收口径子计算取核销/签约时间集合（all_time period：无下界、右开 generatedAt）
  const allTime = resolveAnnualReviewPeriod(0, generatedAt)
  const credited = annualReviewCreditedAllocationsInRange(allTime, facts.allocations ?? [])
  const signed = annualReviewSignedContractsInRange(allTime, facts.contracts ?? [])

  const times: number[] = []
  const collect = (raw: unknown): void => {
    const t = asFinite(raw)
    if (t === null || t <= 0 || t >= generatedAt) return
    times.push(t)
  }
  for (const acc of facts.accounts ?? []) collect(acc.createdAt)
  for (const c of signed.signedInRange) collect(c.signDate)
  for (const row of credited.rows) collect(row.time)
  for (const ev of sales.intentEvents ?? []) collect(ev.createdAt)
  for (const o of crm.opportunities ?? []) collect(o.createdAt)

  // 按年份聚合；桶数固定有限（2000..currentYear），与输入行序无关
  const buckets = new Map<number, { rows: number; from: number; to: number }>()
  for (const t of times) {
    const y = new Date(t).getFullYear()
    if (!Number.isInteger(y) || y < MIN_FACT_YEAR || y > currentYear) continue
    const b = buckets.get(y)
    if (b) {
      b.rows++
      if (t < b.from) b.from = t
      if (t > b.to) b.to = t
    } else {
      buckets.set(y, { rows: 1, from: t, to: t })
    }
  }

  const years: AnnualReviewYearEntry[] = [...buckets.keys()].sort((a, b) => a - b).map((year) => {
    const b = buckets.get(year) as { rows: number; from: number; to: number }
    return {
      year,
      coverage: {
        source: 'local_facts',
        status: 'complete' as const,
        coverageFrom: b.from,
        coverageTo: b.to,
        rows: b.rows,
        reasonCodes: []
      }
    }
  })
  if (years.length > 0) {
    years.push({
      year: 0,
      coverage: {
        source: 'local_facts',
        status: 'complete',
        coverageFrom: times.length > 0 ? Math.min(...times) : undefined,
        coverageTo: times.length > 0 ? Math.max(...times) : undefined,
        rows: times.length,
        reasonCodes: []
      }
    })
  }

  return {
    years,
    currentYear,
    supportsAllTime: years.length > 0,
    defaultYear: currentYear
  }
}

// ─── Worker 结果运行时结构校验（集中式 runtime guard） ───────────────────────

export type AnnualReviewReportValidation = { ok: true } | { ok: false; reason: string }

const METRIC_STATES: readonly MetricState[] = ['complete', 'partial', 'snapshot_only', 'unavailable']
const BLOCK_IDS: readonly AnnualReviewBlockId[] = ['summary', 'funnel', 'customers', 'monthly', 'communication', 'salesAssignment']

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function isMetricState(v: unknown): v is MetricState {
  return typeof v === 'string' && (METRIC_STATES as readonly string[]).includes(v)
}

function isWarningShape(v: unknown): boolean {
  if (!isPlainObject(v)) return false
  if (typeof v.code !== 'string' || v.code === '') return false
  if (typeof v.message !== 'string') return false
  if (v.count !== undefined && !isFiniteNumber(v.count)) return false
  return true
}

function isWarningsArray(v: unknown): v is MetricWarning[] {
  return Array.isArray(v) && v.every(isWarningShape)
}

function isCoverageShape(v: unknown): boolean {
  if (!isPlainObject(v)) return false
  if (typeof v.source !== 'string' || v.source === '') return false
  if (!isMetricState(v.status)) return false
  if (v.coverageFrom !== undefined && !isFiniteNumber(v.coverageFrom)) return false
  if (v.coverageTo !== undefined && !isFiniteNumber(v.coverageTo)) return false
  if (v.rows !== undefined && (!isFiniteNumber(v.rows) || v.rows < 0 || !Number.isInteger(v.rows))) return false
  if (v.reasonCodes !== undefined && (!Array.isArray(v.reasonCodes) || v.reasonCodes.some((r) => typeof r !== 'string'))) return false
  if (v.exactCoverage !== undefined && typeof v.exactCoverage !== 'boolean') return false
  if (v.coverageRatio !== undefined && v.coverageRatio !== null && !isFiniteNumber(v.coverageRatio)) return false
  return true
}

/**
 * 递归深度检查：拒绝 NaN/±Infinity、function/symbol/bigint 值、循环引用。
 * undefined 属性值按 JSON 语义视为缺省（JSON.stringify 静默丢弃、structuredClone 保留，
 * 统计层 coverage 以 `x ?? undefined` 形式产出可选键，不构成序列化失败）。
 */
function deepSerializableCheck(v: unknown, seen: Set<object>): string | null {
  if (v === null || v === undefined) return null
  const t = typeof v
  if (t === 'number') return Number.isFinite(v) ? null : '非有限数值（NaN/Infinity）'
  if (t === 'string' || t === 'boolean') return null
  if (t === 'function' || t === 'symbol' || t === 'bigint') return '不可序列化的值类型'
  if (t !== 'object') return '非法值类型'
  const obj = v as object
  if (seen.has(obj)) return '循环引用'
  seen.add(obj)
  for (const item of Object.values(obj)) {
    const reason = deepSerializableCheck(item, seen)
    if (reason) return reason
  }
  return null
}

/**
 * Worker 结果运行时校验（service 在缓存写入前调用；非法结果不进缓存）：
 *   - 普通对象、非数组；reportSchemaVersion 精确匹配；year 与请求一致；
 *   - scopeKind 与年份一致；period 边界/asOf/generatedAt 合法且满足时间契约；
 *   - summary/funnel/customers/monthly/communication/salesAssignment/completeness/
 *     coverage/warnings/dataRange/sourceSummary 存在且基本形状正确；
 *   - unavailable ↔ value null 双向一致（unavailable 不能伪装成数字 0）；
 *   - 全树无 NaN/±Infinity/function/symbol/bigint/循环引用；
 *   - 可 structuredClone 且可 JSON 序列化。
 */
export function validateAnnualReviewReport(report: unknown, expectedYear: number): AnnualReviewReportValidation {
  const invalid = (reason: string): AnnualReviewReportValidation => ({ ok: false, reason })
  if (!isPlainObject(report)) return invalid('报告不是普通对象')
  if (report.reportSchemaVersion !== ANNUAL_REVIEW_REPORT_SCHEMA_VERSION) return invalid('reportSchemaVersion 不匹配')
  if (!isFiniteNumber(report.year) || !Number.isInteger(report.year) || report.year < 0 || report.year !== expectedYear) {
    return invalid('year 与请求不一致')
  }
  const year = report.year
  if (year === 0 ? report.scopeKind !== 'all_time' : (report.scopeKind !== 'current_year' && report.scopeKind !== 'historical_year')) {
    return invalid('scopeKind 与年份不一致')
  }
  const scopeKind = report.scopeKind as AnnualReviewPeriod['scopeKind']
  const { periodStart, periodEndExclusive, asOf, generatedAt } = report
  if (year === 0) {
    if (periodStart !== null || periodEndExclusive !== null) return invalid('all_time 的 period 边界必须为 null')
  } else {
    if (!isFiniteNumber(periodStart) || !isFiniteNumber(periodEndExclusive) || periodEndExclusive <= periodStart) {
      return invalid('年度 period 边界非法')
    }
  }
  if (!isFiniteNumber(asOf) || asOf <= 0 || !isFiniteNumber(generatedAt) || generatedAt <= 0) return invalid('asOf/generatedAt 非法')
  if (asOf > generatedAt) return invalid('asOf 晚于 generatedAt')
  if (scopeKind === 'historical_year' && asOf !== periodEndExclusive) return invalid('历史年度 asOf 必须 = periodEndExclusive')
  if (scopeKind !== 'historical_year' && asOf !== generatedAt) return invalid('当前年度/全期 asOf 必须 = generatedAt')
  if (report.timezoneNote !== 'local') return invalid('timezoneNote 必须 = local')

  const summary = report.summary
  if (!isPlainObject(summary)) return invalid('summary 缺失')
  for (const key of SUMMARY_METRIC_KEYS) {
    const metric = summary[key]
    if (!isPlainObject(metric)) return invalid(`summary.${key} 形状非法`)
    if (!isMetricState(metric.state)) return invalid(`summary.${key}.state 非法`)
    if (!isWarningsArray(metric.warnings)) return invalid(`summary.${key}.warnings 非法`)
    const valueIsNull = metric.value === null
    if (!valueIsNull && !isFiniteNumber(metric.value)) return invalid(`summary.${key}.value 非法`)
    if ((metric.state === 'unavailable') !== valueIsNull) return invalid(`summary.${key} 的 unavailable 与 value 不一致`)
  }

  const funnel = report.funnel
  if (!isPlainObject(funnel)) return invalid('funnel 缺失')
  for (const key of FUNNEL_METRIC_KEYS) {
    const block = funnel[key]
    if (!isPlainObject(block)) return invalid(`funnel.${key} 缺失`)
    if (!isCoverageShape(block.coverage)) return invalid(`funnel.${key}.coverage 非法`)
    if (!isWarningsArray(block.warnings)) return invalid(`funnel.${key}.warnings 非法`)
    const coverageStatus = (block.coverage as AnnualReviewCoverage).status
    // 各子块形状（S2 已验收结构）：customerStage/opportunityStage = kind+distribution；
    // stageFlow = 恒 6 桶数组（无 unavailable 形态）；stuck = value；lostBreakdown = kind+两列表
    if (key === 'stuck') {
      if (block.value !== null && !isFiniteNumber(block.value)) return invalid('funnel.stuck.value 非法')
      if (coverageStatus === 'unavailable' && block.value !== null) return invalid('funnel.stuck unavailable 不得携带数值')
      continue
    }
    if (key === 'stageFlow') {
      if (!Array.isArray(block.distribution)) return invalid('funnel.stageFlow.distribution 必须为数组')
      if (coverageStatus === 'unavailable') return invalid('funnel.stageFlow 不存在 unavailable 形态')
      continue
    }
    if (typeof block.kind !== 'string') return invalid(`funnel.${key}.kind 缺失`)
    if (key === 'lostBreakdown') {
      const listsOk = (block.customerPreviousStage === null || Array.isArray(block.customerPreviousStage)) &&
        (block.opportunityReasons === null || Array.isArray(block.opportunityReasons))
      if (!listsOk) return invalid('funnel.lostBreakdown 列表形状非法')
      if (coverageStatus === 'unavailable' && (block.customerPreviousStage !== null || block.opportunityReasons !== null)) {
        return invalid('funnel.lostBreakdown unavailable 不得携带列表')
      }
      continue
    }
    // customerStage / opportunityStage
    const distributionOk = block.distribution === null || (Array.isArray(block.distribution) && block.distribution.every((d) => isPlainObject(d) && typeof d.bucket === 'string' && isFiniteNumber(d.count)))
    if (!distributionOk) return invalid(`funnel.${key}.distribution 非法`)
    if (coverageStatus === 'unavailable' && block.distribution !== null) {
      return invalid(`funnel.${key} unavailable 区块不得携带分布`)
    }
  }

  const customers = report.customers
  if (!isPlainObject(customers)) return invalid('customers 缺失')
  for (const key of CUSTOMERS_METRIC_KEYS) {
    const block = customers[key]
    if (!isPlainObject(block)) return invalid(`customers.${key} 缺失`)
    if (!isCoverageShape(block.coverage)) return invalid(`customers.${key}.coverage 非法`)
    if (!isWarningsArray(block.warnings)) return invalid(`customers.${key}.warnings 非法`)
    if (block.value !== null && !Array.isArray(block.value)) return invalid(`customers.${key}.value 非法`)
    if ((block.coverage as AnnualReviewCoverage).status === 'unavailable' && block.value !== null) {
      return invalid(`customers.${key} unavailable 区块不得携带列表`)
    }
    const rows = block.value
    if (rows !== null && ['active', 'silent', 'risk', 'priority'].includes(key)) {
      for (const row of rows) {
        if (!isPlainObject(row)) return invalid(`customers.${key} 行形状非法`)
        if ('sessionId' in row || 'session_id' in row) return invalid(`customers.${key} 行不得携带 sessionId`)
        if (row.accountId !== null && row.accountId !== undefined && !isFiniteNumber(row.accountId)) return invalid(`customers.${key}.accountId 非法`)
        if (row.customerId !== null && row.customerId !== undefined && typeof row.customerId !== 'string') return invalid(`customers.${key}.customerId 非法`)
        if (key !== 'active' && !isFiniteNumber(row.lastContactAtMs)) return invalid(`customers.${key}.lastContactAtMs 非法`)
        if (key === 'risk' && typeof row.stage !== 'string') return invalid('customers.risk.stage 非法')
      }
    }
  }

  for (const key of NOT_IMPLEMENTED_METRIC_KEYS) {
    const block = report[key]
    if (!isPlainObject(block) || block.status !== 'unavailable' || !Array.isArray(block.reasonCodes)) {
      return invalid(`${key} 必须为显式 unavailable 区块`)
    }
  }

  const dataRange = report.dataRange
  if (!isPlainObject(dataRange)) return invalid('dataRange 缺失')
  const bothNull = dataRange.from === null && dataRange.to === null
  const bothFinite = isFiniteNumber(dataRange.from) && isFiniteNumber(dataRange.to) && (dataRange.from as number) <= (dataRange.to as number)
  if (!bothNull && !bothFinite) return invalid('dataRange 非法（空数据必须 {from:null,to:null}）')

  const completeness = report.completeness
  if (!isPlainObject(completeness) || !isMetricState(completeness.overall) || !isPlainObject(completeness.blocks)) {
    return invalid('completeness 缺失或形状非法')
  }
  for (const blockId of BLOCK_IDS) {
    if (!isMetricState((completeness.blocks as Record<string, unknown>)[blockId])) return invalid(`completeness.blocks.${blockId} 非法`)
  }

  const coverage = report.coverage
  if (!isPlainObject(coverage) || Object.keys(coverage).length === 0) return invalid('coverage 缺失或为空')
  for (const [key, cov] of Object.entries(coverage)) {
    if (!isCoverageShape(cov)) return invalid(`coverage.${key} 非法`)
  }

  const warnings = report.warnings
  if (!Array.isArray(warnings)) return invalid('warnings 缺失')
  for (const w of warnings) {
    if (!isPlainObject(w) || typeof w.code !== 'string' || w.code === '' || typeof w.message !== 'string') return invalid('warnings 行形状非法')
    if (!Array.isArray(w.metricKeys) || w.metricKeys.some((k) => typeof k !== 'string')) return invalid('warnings.metricKeys 非法')
    if (w.counts !== undefined) {
      if (!isPlainObject(w.counts)) return invalid('warnings.counts 非法')
      for (const count of Object.values(w.counts)) {
        if (!isFiniteNumber(count)) return invalid('warnings.counts 含非法数值')
      }
    }
  }

  const sourceSummary = report.sourceSummary
  if (!Array.isArray(sourceSummary)) return invalid('sourceSummary 缺失')
  for (const row of sourceSummary) {
    if (!isPlainObject(row) || typeof row.source !== 'string' || !Array.isArray(row.tables) || row.tables.some((t) => typeof t !== 'string')) {
      return invalid('sourceSummary 行形状非法')
    }
    if (!isFiniteNumber(row.rows) || row.rows < 0 || !Number.isInteger(row.rows)) return invalid('sourceSummary.rows 非法')
    if (row.note !== undefined && typeof row.note !== 'string') return invalid('sourceSummary.note 非法')
  }

  const seen = new Set<object>()
  const serializableReason = deepSerializableCheck(report, seen)
  if (serializableReason) return invalid(serializableReason)
  try {
    structuredClone(report)
  } catch {
    return invalid('报告不可 structuredClone')
  }
  try {
    JSON.stringify(report)
  } catch {
    return invalid('报告不可 JSON 序列化')
  }
  return { ok: true }
}

// ─── IPC 运行时校验（不依赖 TypeScript） ─────────────────────────────────────

export type AnnualReviewYearValidation =
  | { ok: true; year: number }
  | { ok: false; code: 'invalid_year' | 'future_year'; message: string }

/**
 * 年份运行时校验（IPC handler 用）：仅接受合法整数年份或 0=历史以来；
 * 拒绝未来年份、小数、字符串、NaN/Infinity 等（以 generatedAt 的本地年份为「当前年」）。
 */
export function validateAnnualReviewYearInput(year: unknown, generatedAt: number): AnnualReviewYearValidation {
  const gen = asFinite(generatedAt)
  if (gen === null || gen <= 0) {
    return { ok: false, code: 'invalid_year', message: '非法的生成时间' }
  }
  const currentYear = new Date(gen).getFullYear()
  if (typeof year !== 'number' || !Number.isInteger(year) || year < 0 || year > 9999) {
    return { ok: false, code: 'invalid_year', message: `非法的年份：${String(year)}` }
  }
  if (year !== 0 && year > currentYear) {
    return { ok: false, code: 'future_year', message: `未来年份无数据可统计：${year}（当前 ${currentYear}）` }
  }
  return { ok: true, year }
}

/** taskId 运行时校验：非空可打印字符串，限长 128（防注入超长值） */
export function validateAnnualReviewTaskId(taskId: unknown): boolean {
  return typeof taskId === 'string' && taskId.length > 0 && taskId.length <= 128 && !/\u0000/.test(taskId)
}
