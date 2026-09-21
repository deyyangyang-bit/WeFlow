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
  ANNUAL_REVIEW_MIN_FACT_MS,
  assertValidPeriod,
  computeAnnualReviewSummary,
  annualReviewCreditedAllocationsInRange,
  annualReviewSignedContractsInRange,
  asFinite,
  normSession,
  parseStrictLocalDateKey,
  resolveAnnualReviewPeriod,
  selectSummaryAdoptedFactTimes,
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
  selectRepresentativeProfiles,
  type AnnualReviewCoverage,
  type AnnualReviewCrmSegmentsFacts,
  type AnnualReviewSalesSegmentsFacts
} from './annualReviewSegments'
import { computeAnnualReviewCommunication } from './annualReviewCommunication'
import { computeAnnualReviewSalesAssignment } from './annualReviewAssignment'
import { computeAnnualReviewMonthly, type AnnualReviewMonthlyBlock } from './annualReviewMonthly'
import { isRawWechatAccountId } from '../../shared/wechatId'

// ─── 报告结构 ────────────────────────────────────────────────────────────────

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

// ─── D/E 组区块类型（S5：组装层把统计层的 sessionId 行映射为公开身份） ────────

interface BlockMetric<T> { value: T | null; state: MetricState; warnings: MetricWarning[] }
interface BlockMetricRows<T> { value: T[] | null; state: MetricState; warnings: MetricWarning[] }

/** D 组沟通质量区块（规格 §5.4；D7 行已映射业务身份，无 sessionId） */
export interface AnnualReviewCommunicationBlock {
  volume: BlockMetric<number>
  contacted: BlockMetric<number>
  /** 0–1；unavailable（无消息）时为 null */
  outboundRate: BlockMetric<number>
  monthlyTrend: { months: Array<{ month: string; count: number }> | null; state: MetricState; warnings: MetricWarning[] }
  longSilent: BlockMetricRows<{ accountId: number | null; customerId: string | null; name: string | null; lastContactAtMs: number }>
}

/** E 组销售与分配区块（规格 §5.5；无 E2/E6/E7，初始分配与移交分项不相加） */
export interface AnnualReviewSalesAssignmentBlock {
  assignedFacts: {
    initialAssignments: { total: number; groups: Array<{ salesName: string | null; mode: string | null; count: number }> }
    transfersIn: { total: number; groups: Array<{ salesName: string | null; count: number }> }
    transfersOut: { total: number; groups: Array<{ salesName: string | null; count: number }> }
  }
  /** sync 缺口 → partial + exactCoverage=false + coverageRatio=null */
  coverage: AnnualReviewCoverage
  warnings: MetricWarning[]
  effectiveFollowup: BlockMetric<number>
  contractContribution: { value: Array<{ ownerSales: string | null; contractCount: number; totalAmount: number }> | null; state: MetricState; warnings: MetricWarning[] }
  creditedContribution: { value: Array<{ salesName: string | null; totalAmount: number }> | null; state: MetricState; warnings: MetricWarning[] }
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
  /** 本次报告实际输入并参与计算的有效事实时间范围（参与窗口并集）；非名义 period 边界 */
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
  /** 月度趋势（S5：签约金额/核销回款/客户消息量三序列，量纲独立） */
  monthly: AnnualReviewMonthlyBlock
  /** D 组沟通质量（S5：D1/D2/D3/D5/D7） */
  communication: AnnualReviewCommunicationBlock
  /** E 组销售与分配（S5：E1/E3/E4/E5；E2/E6/E7 移出 V1） */
  salesAssignment: AnnualReviewSalesAssignmentBlock
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
const MONTHLY_METRIC_KEYS = ['contractSign', 'credited', 'messageVolume'] as const
const FUNNEL_METRIC_KEYS = ['customerStage', 'opportunityStage', 'stageFlow', 'stuck', 'lostBreakdown'] as const
const CUSTOMERS_METRIC_KEYS = ['highValue', 'newCustomers', 'dealing', 'repeat', 'active', 'silent', 'risk', 'priority'] as const
const COMMUNICATION_METRIC_KEYS = ['volume', 'contacted', 'outboundRate', 'monthlyTrend', 'longSilent'] as const
/** E 组指标式子项（assignedFacts 用区块 coverage，单独处理） */
const SALES_ASSIGNMENT_METRIC_KEYS = ['effectiveFollowup', 'contractContribution', 'creditedContribution'] as const

/** 指标 → Coverage（A/D/E 组组装层单一映射：status=metric.state、reasonCodes=warnings codes） */
function toMetricCoverage(source: string, metric: { state: MetricState; warnings: MetricWarning[] }): AnnualReviewCoverage {
  return { source, status: metric.state, reasonCodes: warningsToReasonCodes(metric.warnings) }
}

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

// ─── dataRange（本次报告实际输入并参与计算的有效事实时间范围） ────────────────

/**
 * dataRange = 各指标**实际采用**事实时间的并集（唯一来源，禁止组装层重新近似过滤）：
 *   - A 组：selectSummaryAdoptedFactTimes（stats 导出）——A1 存量 createdAt 无下界、
 *     A4/A6/A7/A3 回退与其判定完全同源（同一选择函数）；
 *   - B/C 组：各纯统计结果的 adoptedFactTimes 字段（排除名单、总体、代表画像、事件
 *     合法性、首次事件规则均已在统计层裁决；unavailable 指标结果未产出 → 不采用）；
 *   - WCDB 消息聚合（A3 主口径/D1/D5）为 aggregate-only，无真实事件时间可采——
 *     其覆盖边界由 coverage 与文档声明，不进入 dataRange（不伪造）；
 *   - account.importedAt 仅参与 A2 导入布尔判定，不进入范围。
 * 统一准入：有限毫秒、[2000-01-01, asOf)；min/max 确定聚合、与输入顺序无关；
 * 无采用事实 → {from:null,to:null}。
 */
function computeDataRange(period: AnnualReviewPeriod, adopted: number[][]): AnnualReviewDataRange {
  const times: number[] = []
  for (const group of adopted) {
    for (const t of group) {
      if (asFinite(t) === null || t <= 0 || t >= period.asOf || t < ANNUAL_REVIEW_MIN_FACT_MS) continue
      times.push(t)
    }
  }
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

/** sessionId → 稳定业务身份：account 绑定优先（facts.accounts），其次代表画像的 customer_id */
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
  // 同会话多画像：customerId 必须取自与 stage/lastContact 同一代表记录（唯一规则，
  // 与 S2 统计共用 selectRepresentativeProfiles；调换输入顺序不改变报告）
  for (const [sid, rep] of selectRepresentativeProfiles(sales.profiles ?? [])) {
    const cid = rep.customerId ?? null
    if (!cid) continue
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

  // D/E 组：S5 确定性统计；D7 行映射业务身份（sessionId 留在统计层）
  const communicationStats = computeAnnualReviewCommunication(period, inputs, opts)
  const communication: AnnualReviewCommunicationBlock = {
    volume: communicationStats.volume,
    contacted: communicationStats.contacted,
    outboundRate: communicationStats.outboundRate,
    monthlyTrend: communicationStats.monthlyTrend,
    longSilent: {
      value: communicationStats.longSilent.sessionIds === null
        ? null
        : communicationStats.longSilent.sessionIds.map((row) => {
            const identity = identityOf(identityIndex, row.sessionId)
            return { accountId: identity.accountId, customerId: identity.customerId, name: identity.name, lastContactAtMs: row.lastContactAtMs }
          }),
      state: communicationStats.longSilent.state,
      warnings: communicationStats.longSilent.warnings
    }
  }
  const salesAssignment = computeAnnualReviewSalesAssignment(period, inputs)
  // 月度趋势：消息序列复用 D5 单一结果（不复制聚合）；金额序列与 A4/A6 同源
  const monthly = computeAnnualReviewMonthly(period, inputs, communication.monthlyTrend)

  // completeness：统计层结果聚合（UI 不计算）；月度趋势未实现恒 unavailable
  const summaryStates = SUMMARY_METRIC_KEYS.map((key) => summary[key].state)
  const funnelStates = FUNNEL_METRIC_KEYS.map((key) => funnel[key].coverage.status)
  const customersStates = CUSTOMERS_METRIC_KEYS.map((key) => customers[key].coverage.status)
  const communicationStates = COMMUNICATION_METRIC_KEYS.map((key) => communication[key].state)
  const salesAssignmentStates = [salesAssignment.coverage.status, ...SALES_ASSIGNMENT_METRIC_KEYS.map((key) => salesAssignment[key].state)]
  const completeness: AnnualReviewCompleteness = {
    overall: 'unavailable',
    blocks: {
      summary: aggregateMetricStates(summaryStates),
      funnel: aggregateMetricStates(funnelStates),
      customers: aggregateMetricStates(customersStates),
      monthly: aggregateMetricStates(MONTHLY_METRIC_KEYS.map((key) => monthly[key].state)),
      communication: aggregateMetricStates(communicationStates),
      salesAssignment: aggregateMetricStates(salesAssignmentStates)
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
  coverage['monthly.contractSign'] = toMetricCoverage('crmdb.contract', monthly.contractSign)
  coverage['monthly.credited'] = toMetricCoverage('crmdb.allocation', monthly.credited)
  coverage['monthly.messageVolume'] = toMetricCoverage('wcdb.messages', monthly.messageVolume)
  coverage['communication.volume'] = toMetricCoverage('wcdb.messages', communication.volume)
  coverage['communication.contacted'] = toMetricCoverage(messageStatsAvailable ? 'wcdb.messages' : 'crmdb.account', communication.contacted)
  coverage['communication.outboundRate'] = toMetricCoverage('wcdb.messages', communication.outboundRate)
  coverage['communication.monthlyTrend'] = toMetricCoverage('wcdb.messages', communication.monthlyTrend)
  coverage['communication.longSilent'] = toMetricCoverage('crmdb.account', communication.longSilent)
  coverage['salesAssignment.assignedFacts'] = { ...salesAssignment.coverage }
  coverage['salesAssignment.effectiveFollowup'] = toMetricCoverage('crmdb.assignment', salesAssignment.effectiveFollowup)
  coverage['salesAssignment.contractContribution'] = toMetricCoverage('crmdb.contract', salesAssignment.contractContribution)
  coverage['salesAssignment.creditedContribution'] = toMetricCoverage('crmdb.allocation', salesAssignment.creditedContribution)

  // warnings：全指标聚合（固定遍历顺序 + 全排序输出 → 与输入行序无关）
  const warningEntries: Array<{ metricKey: string; warnings: MetricWarning[] }> = []
  for (const key of SUMMARY_METRIC_KEYS) warningEntries.push({ metricKey: `summary.${key}`, warnings: summary[key].warnings })
  for (const key of FUNNEL_METRIC_KEYS) warningEntries.push({ metricKey: `funnel.${key}`, warnings: funnel[key].warnings })
  for (const key of CUSTOMERS_METRIC_KEYS) warningEntries.push({ metricKey: `customers.${key}`, warnings: customers[key].warnings })
  for (const key of COMMUNICATION_METRIC_KEYS) warningEntries.push({ metricKey: `communication.${key}`, warnings: communication[key].warnings })
  warningEntries.push({ metricKey: 'salesAssignment.assignedFacts', warnings: salesAssignment.warnings })
  for (const key of SALES_ASSIGNMENT_METRIC_KEYS) warningEntries.push({ metricKey: `salesAssignment.${key}`, warnings: salesAssignment[key].warnings })

  // dataRange：各指标实际采用事实时间的并集（唯一来源 = 摘要选择器 + 各统计结果 adoptedFactTimes）
  // C1–C5 为 account/消息维度（时间事实已并入摘要选择器），画像时间来自 C6/C7/C8
  const dataRange = computeDataRange(period, [
    selectSummaryAdoptedFactTimes(period, inputs.facts, opts),
    funnel.customerStage.adoptedFactTimes,
    funnel.opportunityStage.adoptedFactTimes,
    funnel.stageFlow.adoptedFactTimes,
    funnel.stuck.adoptedFactTimes,
    funnel.lostBreakdown.adoptedFactTimes,
    statsCustomers.silent.adoptedFactTimes,
    statsCustomers.risk.adoptedFactTimes,
    statsCustomers.priority.adoptedFactTimes
  ])

  return {
    reportSchemaVersion: ANNUAL_REVIEW_REPORT_SCHEMA_VERSION,
    year: period.year,
    scopeKind: period.scopeKind,
    periodStart: period.periodStart,
    periodEndExclusive: period.periodEndExclusive,
    asOf: period.asOf,
    generatedAt: period.generatedAt,
    timezoneNote: 'local',
    dataRange,
    completeness,
    coverage,
    warnings: aggregateWarnings(warningEntries),
    summary,
    funnel,
    customers,
    monthly,
    communication,
    salesAssignment,
    sourceSummary: buildSourceSummary(facts, sales, crm, opts)
  }
}

// ─── 销售身份掩蔽（公开报告进入缓存/IPC 前的数据边界） ──────────────────────

const SALES_IDENTITY_FALLBACK_PREFIX = '销售 '

/**
 * 收集公开报告中全部销售身份原文（去重、按字典序稳定输出，与行序无关）：
 * E1 初始分配/移交转入/移交转出分组名、E4 合同贡献归属销售、E5 核销贡献认领销售。
 * 来源 = 审计 detail 中的销售署名、allocation 表的认领销售列、account 表的归属销售列
 * 等操作行为写入的自由文本，可能是原始 wxid/群号——统一在此边界内掩蔽，
 * 页面/导出/AI 不再各自替换。
 */
export function collectAnnualReviewSalesIdentityValues(report: AnnualReviewReport): string[] {
  const sa = report.salesAssignment
  const af = sa?.assignedFacts
  const initial = (af?.initialAssignments?.groups ?? []).map(({ salesName }) => salesName)
  const transferIn = (af?.transfersIn?.groups ?? []).map(({ salesName }) => salesName)
  const transferOut = (af?.transfersOut?.groups ?? []).map(({ salesName }) => salesName)
  const owners = (sa?.contractContribution?.value ?? []).map(({ ownerSales }) => ownerSales)
  const claims = (sa?.creditedContribution?.value ?? []).map(({ salesName }) => salesName)
  return [...initial, ...transferIn, ...transferOut, ...owners, ...claims]
    .filter((v): v is string => typeof v === 'string' && v !== '')
    .filter((v, i, all) => all.indexOf(v) === i)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

/**
 * 销售身份公开展示标签指派（纯函数，同输入同输出）：
 *   - 非原始微信 ID（真实姓名）→ 原样保留（身份映射）；
 *   - 原始微信 ID 且解析到显示名（且显示名自身不是原始 ID）→ 用显示名；
 *   - 无法解析 → 稳定回退标签「销售 N」：按原文排序指派（确定性），并跳过本报告内
 *     已被其他销售占用的标签（真实销售恰名「销售 1」时从「销售 2」起）——不同销售
 *     绝不因掩蔽被错误合并（两个 ID 解析到同一显示名 = 同一人的多形态来源，属映射语义）。
 * 解析失败/未提供解析器时全部 ID 走回退标签：**解析不可用绝不放弃掩蔽**。
 */
export function buildAnnualReviewSalesIdentityLabels(
  values: readonly string[],
  resolved: ReadonlyMap<string, string | null>
): Map<string, string> {
  const labels = new Map<string, string>()
  const used = new Set<string>()
  const fallbackRaw: string[] = []
  for (const raw of values) {
    if (!isRawWechatAccountId(raw)) {
      labels.set(raw, raw)
      used.add(raw)
      continue
    }
    const display = resolved.get(raw) ?? null
    if (typeof display === 'string' && display !== '' && !isRawWechatAccountId(display)) {
      labels.set(raw, display)
      used.add(display)
      continue
    }
    fallbackRaw.push(raw)
  }
  let n = 1
  for (const raw of [...fallbackRaw].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    let candidate = [SALES_IDENTITY_FALLBACK_PREFIX, String(n)].join('')
    while (used.has(candidate)) {
      n += 1
      candidate = [SALES_IDENTITY_FALLBACK_PREFIX, String(n)].join('')
    }
    labels.set(raw, candidate)
    used.add(candidate)
    n += 1
  }
  return labels
}

/**
 * 应用销售身份标签（纯函数；返回新报告对象，不修改输入）：按 labels 重写 E 组全部
 * 销售身份字段，其余区块共享原引用（不触碰计数口径/state/warnings/coverage）。
 */
export function applyAnnualReviewSalesIdentityLabels(
  report: AnnualReviewReport,
  labels: ReadonlyMap<string, string>
): AnnualReviewReport {
  const relabel = (v: string | null): string | null => (v === null ? null : labels.get(v) ?? v)
  const sa = report.salesAssignment
  const af = sa.assignedFacts
  const cc = sa.contractContribution
  const kc = sa.creditedContribution
  return {
    ...report,
    salesAssignment: {
      ...sa,
      assignedFacts: {
        ...af,
        initialAssignments: {
          ...af.initialAssignments,
          groups: af.initialAssignments.groups.map(
            ({ salesName, mode, count }) => ({ salesName: relabel(salesName), mode, count })
          )
        },
        transfersIn: {
          ...af.transfersIn,
          groups: af.transfersIn.groups.map(
            ({ salesName, count }) => ({ salesName: relabel(salesName), count })
          )
        },
        transfersOut: {
          ...af.transfersOut,
          groups: af.transfersOut.groups.map(
            ({ salesName, count }) => ({ salesName: relabel(salesName), count })
          )
        }
      },
      contractContribution: {
        ...cc,
        value: cc.value === null ? null : cc.value.map(
          ({ ownerSales, contractCount, totalAmount }) => ({ ownerSales: relabel(ownerSales), contractCount, totalAmount })
        )
      },
      creditedContribution: {
        ...kc,
        value: kc.value === null ? null : kc.value.map(
          ({ salesName, totalAmount }) => ({ salesName: relabel(salesName), totalAmount })
        )
      }
    }
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

/** 事实年份下界：早于此视为秒/毫秒混用或荒谬时间，不生成候选年份（1970 纪元值等） */
const MIN_FACT_YEAR = 2000

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

/** V1 顶层 coverage 的固定、唯一 metricKey 全集（缺一拒绝、多一拒绝） */
const EXPECTED_COVERAGE_KEYS: readonly string[] = [
  ...SUMMARY_METRIC_KEYS.map((key) => `summary.${key}`),
  ...FUNNEL_METRIC_KEYS.map((key) => `funnel.${key}`),
  ...CUSTOMERS_METRIC_KEYS.map((key) => `customers.${key}`),
  ...MONTHLY_METRIC_KEYS.map((key) => `monthly.${key}`),
  ...COMMUNICATION_METRIC_KEYS.map((key) => `communication.${key}`),
  ...SALES_ASSIGNMENT_METRIC_KEYS.map((key) => `salesAssignment.${key}`),
  'salesAssignment.assignedFacts'
]

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

/**
 * 月份键（'YYYY-MM'）严格校验：拼接为 'YYYY-MM-01' 后走 parseStrictLocalDateKey
 * （同一实现），因此 `2026-00` / `2026-13` / `2026-9` / `2026-99` 全部拒绝。
 */
function isMonthKey(v: unknown): boolean {
  return typeof v === 'string' && parseStrictLocalDateKey(`${v}-01`) !== null
}

/** 轴内月份严格升序（重复或倒序拒绝） */
function isStrictlyAscendingMonths(months: ReadonlyArray<{ month: string }>): boolean {
  for (let i = 1; i < months.length; i++) {
    if (months[i].month <= months[i - 1].month) return false
  }
  return true
}

/** warning 列表签名（code|message|count，排序后拼接）：用于「必须同源」字段的强一致性比对 */
function warningsSignature(list: MetricWarning[]): string {
  return list
    .map((w) => `${w.code}|${w.message}|${typeof w.count === 'number' && Number.isFinite(w.count) ? w.count : ''}`)
    .sort()
    .join(';')
}

function isCoverageShape(v: unknown): boolean {
  if (!isPlainObject(v)) return false
  if (typeof v.source !== 'string' || v.source === '') return false
  if (!isMetricState(v.status)) return false
  // 覆盖边界是事实时间戳（毫秒）：与客户行时间戳同一规则（有限整数 > 0）
  if (v.coverageFrom !== undefined && !timestampField(v.coverageFrom)) return false
  if (v.coverageTo !== undefined && !timestampField(v.coverageTo)) return false
  if (v.rows !== undefined && (!isFiniteNumber(v.rows) || v.rows < 0 || !Number.isInteger(v.rows))) return false
  if (v.reasonCodes !== undefined && (!Array.isArray(v.reasonCodes) || v.reasonCodes.some((r) => typeof r !== 'string'))) return false
  if (v.exactCoverage !== undefined && typeof v.exactCoverage !== 'boolean') return false
  if (v.coverageRatio !== undefined && v.coverageRatio !== null) {
    if (!isFiniteNumber(v.coverageRatio) || (v.coverageRatio as number) < 0 || (v.coverageRatio as number) > 1) return false
  }
  // exactCoverage=false（如 E1 sync 缺口）→ 分母不可知，coverageRatio 必须 null
  if (v.exactCoverage === false && v.coverageRatio !== null) return false
  return true
}

// ─── 公开客户行白名单（字段精确形状；未知字段/内部字段一律拒绝） ──────────────

const numField = (v: unknown): boolean => isFiniteNumber(v)
const strOrNullField = (v: unknown): boolean => v === null || typeof v === 'string'
const boolField = (v: unknown): boolean => typeof v === 'boolean'
/** 非负整数（计数类字段：消息量/客户数/合同数；小数、负数、NaN/±Infinity 一律拒绝） */
const countField = (v: unknown): boolean => isFiniteNumber(v) && Number.isInteger(v) && v >= 0
/**
 * 有效毫秒时间戳（时间戳字段专用，比 numField 更严）：有限、整数、> 0。
 * 0/负数/小数/NaN/±Infinity 一律拒绝——时间戳为 0 是纪元脏值、小数说明不是毫秒整数。
 */
const timestampField = (v: unknown): v is number => isFiniteNumber(v) && Number.isInteger(v) && v > 0
/**
 * 客户业务身份 accountId：只接受**正整数**（crmDb account.id 语义）；
 * 0 / 负数 / 小数 / NaN / ±Infinity 一律拒绝（0 不是合法主键，负 id 会污染跳转与展示）。
 */
const accountIdField = (v: unknown): boolean => isFiniteNumber(v) && Number.isInteger(v) && v > 0
const accountIdOrNullField = (v: unknown): boolean => v === null || accountIdField(v)

/**
 * 公开客户行 shape 白名单：键集合精确 + 每字段类型确定。
 * 时间戳字段（createdAt / firstSignDate / lastContactAtMs）统一走 timestampField——
 * 行形状必须与统计层实际产出的字段一一对应（C4 复购行 = DealingCustomerRow，
 * 含 firstSignDate，白名单缺它会让所有复购客户报告被判非法）。
 */
const CUSTOMER_ROW_SHAPES: Record<string, Record<string, (v: unknown) => boolean>> = {
  highValue: { accountId: accountIdField, name: strOrNullField, creditedAmount: numField, contractAmount: numField },
  newCustomers: { accountId: accountIdField, name: strOrNullField, createdAt: timestampField, imported: boolField },
  dealing: { accountId: accountIdField, name: strOrNullField, contractCount: countField, contractAmount: numField, firstSignDate: timestampField },
  repeat: { accountId: accountIdField, name: strOrNullField, contractCount: countField, contractAmount: numField, firstSignDate: timestampField },
  active: { accountId: accountIdOrNullField, name: strOrNullField },
  silent: { accountId: accountIdOrNullField, customerId: strOrNullField, name: strOrNullField, lastContactAtMs: timestampField },
  risk: { accountId: accountIdOrNullField, customerId: strOrNullField, name: strOrNullField, stage: (v) => typeof v === 'string', lastContactAtMs: timestampField },
  priority: { accountId: accountIdOrNullField, customerId: strOrNullField, name: strOrNullField, lastContactAtMs: timestampField }
}

function isRowShape(row: Record<string, unknown>, shape: Record<string, (v: unknown) => boolean>): boolean {
  for (const key of Object.keys(row)) {
    if (!(key in shape)) return false // 未知字段（含 sessionId 等内部字段）拒绝
  }
  for (const [key, check] of Object.entries(shape)) {
    if (!check(row[key])) return false
  }
  return true
}

/** 公开报告禁用内部字段（小写比较；与深度序列化检查合并为单次遍历） */
const FORBIDDEN_REPORT_KEYS = new Set([
  'sessionid', 'session_id', 'wxid', 'dbpath', 'databasepath', 'sql', 'token', 'secret', 'decryptkey', 'password'
])

/**
 * 递归深度检查：拒绝 NaN/±Infinity、function/symbol/bigint 值、循环引用。
 * undefined 属性值按 JSON 语义视为缺省（JSON.stringify 静默丢弃、structuredClone 保留，
 * 统计层 coverage 以 `x ?? undefined` 形式产出可选键，不构成序列化失败）。
 * seen 为 DFS 路径栈（回溯删除）：兄弟子树间的共享引用（如 A3/D2 共用同一计算结果）
 * 不是循环；只有真正出现在自身祖先链上的引用才判循环。
 */
function deepSerializableCheck(v: unknown, seen: Set<object>, path: Set<object>): string | null {
  if (v === null || v === undefined) return null
  const t = typeof v
  if (t === 'number') return Number.isFinite(v) ? null : '非有限数值（NaN/Infinity）'
  if (t === 'string' || t === 'boolean') return null
  if (t === 'function' || t === 'symbol' || t === 'bigint') return '不可序列化的值类型'
  if (typeof v === 'object') {
    for (const key of Object.keys(v as Record<string, unknown>)) {
      if (FORBIDDEN_REPORT_KEYS.has(key.toLowerCase())) return `报告携带内部字段：${key}`
    }
  }
  if (t !== 'object') return '非法值类型'
  const obj = v as object
  if (path.has(obj)) return '循环引用'
  if (seen.has(obj)) return null // 共享引用：该子图已完整扫描过，跳过（避免指数重走）
  seen.add(obj)
  path.add(obj)
  for (const item of Object.values(obj)) {
    const reason = deepSerializableCheck(item, seen, path)
    if (reason) {
      path.delete(obj)
      return reason
    }
  }
  path.delete(obj)
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
    // 年份区间边界 = 本地自然年边界毫秒（时间戳同一规则：有限整数 > 0）
    if (!timestampField(periodStart) || !timestampField(periodEndExclusive) || periodEndExclusive <= periodStart) {
      return invalid('年度 period 边界非法')
    }
  }
  if (!timestampField(asOf) || !timestampField(generatedAt)) return invalid('asOf/generatedAt 非法')
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
    if (rows !== null) {
      const shape = CUSTOMER_ROW_SHAPES[key]
      for (const row of rows) {
        if (!isPlainObject(row) || !isRowShape(row, shape)) {
          return invalid(`customers.${key} 行形状非法（未知/内部字段或类型不符）`)
        }
      }
    }
  }

  // 月度趋势（S5）：三序列形状（金额/消息计数；unavailable ↔ null 双向一致）
  //   - 月份键严格校验（年-月两段解析，月份 1–12；`2026-99`/`2026-00` 一律拒绝）；
  //   - 轴内月份必须严格升序（升序是文档契约，也是双字段一致性比对的前提）；
  //   - messageVolume 计数 = 非负整数（月度消息量不得为负数/小数）；
  //   - 金额 = 有限数（A5 已批准口径允许负数金额原样求和，此处不额外加非负约束）。
  const monthlyBlock = report.monthly
  if (!isPlainObject(monthlyBlock)) return invalid('monthly 缺失')
  for (const key of MONTHLY_METRIC_KEYS) {
    const series = monthlyBlock[key]
    if (!isPlainObject(series) || !isMetricState(series.state) || !isWarningsArray(series.warnings)) {
      return invalid(`monthly.${key} 形状非法`)
    }
    if (series.months !== null) {
      const valueKey = key === 'messageVolume' ? 'count' : 'amount'
      const valueOk = key === 'messageVolume' ? countField : numField
      const pointOk = (m: unknown): boolean =>
        isPlainObject(m) && isMonthKey(m.month) && valueOk((m as Record<string, unknown>)[valueKey])
      if (!Array.isArray(series.months) || !series.months.every(pointOk)) {
        return invalid(`monthly.${key}.months 形状非法`)
      }
      if (!isStrictlyAscendingMonths(series.months as Array<{ month: string }>)) {
        return invalid(`monthly.${key}.months 未按月份严格升序`)
      }
    }
    if ((series.state === 'unavailable') !== (series.months === null)) {
      return invalid(`monthly.${key} 的 unavailable 与 months 不一致`)
    }
  }

  // D 组沟通质量（S5）：volume/contacted/outboundRate 数值指标 + monthlyTrend 序列 + longSilent 名单
  const communication = report.communication
  if (!isPlainObject(communication)) return invalid('communication 缺失')
  for (const key of ['volume', 'contacted', 'outboundRate'] as const) {
    const metric = communication[key]
    if (!isPlainObject(metric) || !isMetricState(metric.state) || !isWarningsArray(metric.warnings)) return invalid(`communication.${key} 形状非法`)
    if (!isFiniteNumber(metric.value) && metric.value !== null) return invalid(`communication.${key}.value 非法`)
    if ((metric.state === 'unavailable') !== (metric.value === null)) return invalid(`communication.${key} 的 unavailable 与 value 不一致`)
    // 计数指标（消息量/触达客户数）= 非负整数；比例指标 ∈ [0,1]；不得出现负总量或 >1 的比例
    if (key === 'outboundRate') {
      if (metric.value !== null && ((metric.value as number) < 0 || (metric.value as number) > 1)) {
        return invalid('communication.outboundRate.value 越界（必须为 [0,1] 内有限数）')
      }
    } else if (metric.value !== null && !countField(metric.value)) {
      return invalid(`communication.${key}.value 必须为非负整数`)
    }
  }
  const trend = communication.monthlyTrend
  if (!isPlainObject(trend) || !isMetricState(trend.state) || !isWarningsArray(trend.warnings)) return invalid('communication.monthlyTrend 形状非法')
  if (trend.months !== null) {
    if (!Array.isArray(trend.months) || trend.months.some((m) => !isPlainObject(m) || !isMonthKey(m.month) || !countField(m.count))) {
      return invalid('communication.monthlyTrend.months 形状非法（月份键或非负整数计数不合法）')
    }
    if (!isStrictlyAscendingMonths(trend.months as Array<{ month: string }>)) {
      return invalid('communication.monthlyTrend.months 未按月份严格升序')
    }
  }
  if ((trend.state === 'unavailable') !== (trend.months === null)) return invalid('communication.monthlyTrend 的 unavailable 与 months 不一致')
  const longSilent = communication.longSilent
  if (!isPlainObject(longSilent) || !isMetricState(longSilent.state) || !isWarningsArray(longSilent.warnings)) return invalid('communication.longSilent 形状非法')
  if (longSilent.value !== null) {
    if (!Array.isArray(longSilent.value) || longSilent.value.some((row) => !isPlainObject(row) || !isRowShape(row, CUSTOMER_ROW_SHAPES.silent))) {
      return invalid('communication.longSilent 行形状非法（未知/内部字段或类型不符）')
    }
  }
  if ((longSilent.state === 'unavailable') !== (longSilent.value === null)) return invalid('communication.longSilent 的 unavailable 与 value 不一致')

  // ── 同源字段强一致性（禁止平行口径出现分歧） ──────────────────────────────
  // 1) monthly.messageVolume 与 communication.monthlyTrend 声明来自同一数据源
  //    （D5 单一结果）—— 月份数量/顺序/月份键/计数/state/warnings 必须逐项一致；
  // 2) monthly.contractSign 与 summary.contractAmount（A5）、monthly.credited 与
  //    summary.creditedAmount（A6）必须同源同一聚合（state + warning 签名一致），
  //    否则「摘要 partial、月度 complete」这类平行口径分歧会被放行。
  const messageSeries = monthlyBlock.messageVolume as {
    months: Array<{ month: string; count: number }> | null
    state: MetricState
    warnings: MetricWarning[]
  }
  const trendSeries = trend as {
    months: Array<{ month: string; count: number }> | null
    state: MetricState
    warnings: MetricWarning[]
  }
  if ((messageSeries.months === null) !== (trendSeries.months === null)) {
    return invalid('monthly.messageVolume 与 communication.monthlyTrend 可用性不一致')
  }
  if (messageSeries.state !== trendSeries.state) {
    return invalid('monthly.messageVolume 与 communication.monthlyTrend 的 state 不一致')
  }
  if (warningsSignature(messageSeries.warnings) !== warningsSignature(trendSeries.warnings)) {
    return invalid('monthly.messageVolume 与 communication.monthlyTrend 的 warnings 不一致')
  }
  const seriesMonths = messageSeries.months ?? []
  const trendMonths = trendSeries.months ?? []
  if (seriesMonths.length !== trendMonths.length) {
    return invalid('monthly.messageVolume 与 communication.monthlyTrend 的月份数量不一致')
  }
  for (let i = 0; i < seriesMonths.length; i++) {
    if (seriesMonths[i].month !== trendMonths[i].month || seriesMonths[i].count !== trendMonths[i].count) {
      return invalid(`monthly.messageVolume 与 communication.monthlyTrend 第 ${i + 1} 个月不一致（月份或计数）`)
    }
  }
  const summaryMetrics = summary as unknown as Record<string, { state: MetricState; warnings: MetricWarning[] }>
  const amountStatePairs: Array<[string, string, { state: MetricState; warnings: MetricWarning[] }, { state: MetricState; warnings: MetricWarning[] }]> = [
    ['summary.contractAmount(A5)', 'monthly.contractSign', summaryMetrics.contractAmount, monthlyBlock.contractSign as { state: MetricState; warnings: MetricWarning[] }],
    ['summary.creditedAmount(A6)', 'monthly.credited', summaryMetrics.creditedAmount, monthlyBlock.credited as { state: MetricState; warnings: MetricWarning[] }]
  ]
  for (const [summaryKey, monthlyKey, summaryMetric, monthlySeries] of amountStatePairs) {
    if (summaryMetric.state !== monthlySeries.state) {
      return invalid(`${monthlyKey} 与 ${summaryKey} 的 state 不一致（摘要与月度必须同一口径）`)
    }
    if (warningsSignature(summaryMetric.warnings) !== warningsSignature(monthlySeries.warnings)) {
      return invalid(`${monthlyKey} 与 ${summaryKey} 的 warnings 不一致（摘要与月度必须同一口径）`)
    }
  }

  // E 组销售与分配（S5）：分项事实 + coverage + 有效跟进 + 两项贡献（无 E2/E6/E7）
  const salesAssignment = report.salesAssignment
  if (!isPlainObject(salesAssignment)) return invalid('salesAssignment 缺失')
  const af = salesAssignment.assignedFacts
  if (!isPlainObject(af) || !isPlainObject(af.initialAssignments) || !isPlainObject(af.transfersIn) || !isPlainObject(af.transfersOut)) {
    return invalid('salesAssignment.assignedFacts 形状非法')
  }
  const groupsOk = (g: unknown, withMode: boolean): boolean => {
    if (!isPlainObject(g) || !isFiniteNumber(g.total) || (g.total as number) < 0 || !Number.isInteger(g.total) || !Array.isArray(g.groups)) return false
    let sum = 0
    for (const row of g.groups as unknown[]) {
      if (!isPlainObject(row) || !isFiniteNumber(row.count) || (row.count as number) < 0 || !Number.isInteger(row.count)) return false
      if (row.salesName !== null && typeof row.salesName !== 'string') return false
      if (withMode) {
        if (row.mode !== null && typeof row.mode !== 'string') return false
        if (!('mode' in row)) return false
      } else {
        // 移入/移出分组：不得偷偷携带 mode 等未知字段
        for (const key of Object.keys(row)) {
          if (key !== 'salesName' && key !== 'count') return false
        }
      }
      sum += row.count as number
    }
    // total 必须等于各 group.count 之和
    if (sum !== g.total) return false
    return true
  }
  if (!groupsOk(af.initialAssignments, true) || !groupsOk(af.transfersIn, false) || !groupsOk(af.transfersOut, false)) {
    return invalid('salesAssignment.assignedFacts 分组形状非法（total ≠ Σcount 或携带未知字段）')
  }
  if (!isCoverageShape(salesAssignment.coverage)) return invalid('salesAssignment.coverage 非法')
  if (!isWarningsArray(salesAssignment.warnings)) return invalid('salesAssignment.warnings 非法')
  const followup = salesAssignment.effectiveFollowup
  if (!isPlainObject(followup) || !isMetricState(followup.state) || !isWarningsArray(followup.warnings)) return invalid('salesAssignment.effectiveFollowup 形状非法')
  if (!isFiniteNumber(followup.value) && followup.value !== null) return invalid('salesAssignment.effectiveFollowup.value 非法')
  if ((followup.state === 'unavailable') !== (followup.value === null)) return invalid('salesAssignment.effectiveFollowup 的 unavailable 与 value 不一致')
  const contribution = salesAssignment.contractContribution
  if (!isPlainObject(contribution) || !isMetricState(contribution.state) || !isWarningsArray(contribution.warnings)) return invalid('salesAssignment.contractContribution 形状非法')
  if (contribution.value !== null) {
    if (!Array.isArray(contribution.value) || contribution.value.some((row) => !isPlainObject(row) || !isFiniteNumber(row.totalAmount) || !isFiniteNumber(row.contractCount) || (row.contractCount as number) < 0)) {
      return invalid('salesAssignment.contractContribution.value 形状非法')
    }
  }
  if ((contribution.state === 'unavailable') !== (contribution.value === null)) return invalid('salesAssignment.contractContribution 的 unavailable 与 value 不一致')
  const credited = salesAssignment.creditedContribution
  if (!isPlainObject(credited) || !isMetricState(credited.state) || !isWarningsArray(credited.warnings)) return invalid('salesAssignment.creditedContribution 形状非法')
  if (credited.value !== null) {
    if (!Array.isArray(credited.value) || credited.value.some((row) => !isPlainObject(row) || !isFiniteNumber(row.totalAmount))) {
      return invalid('salesAssignment.creditedContribution.value 形状非法')
    }
  }
  if ((credited.state === 'unavailable') !== (credited.value === null)) return invalid('salesAssignment.creditedContribution 的 unavailable 与 value 不一致')

  // 销售身份数据边界（公开报告绝不携带原始 wxid/群号）：掩蔽（applyAnnualReview-
  // SalesIdentityLabels）在缓存写入前执行，正常流程不会残留；若 E 组身份行的任何字符串
  // 值仍命中原始微信 ID 形态（掩蔽被绕过、解析注入失控），整份报告拒绝进入缓存/IPC。
  // 与掩蔽共用 isRawWechatAccountId 同一谓词（校验不宽于掩蔽，掩蔽不漏于校验）。
  const rawIdentity = (v: unknown): boolean => typeof v === 'string' && isRawWechatAccountId(v)
  const scanIdentityRows = (rows: unknown): boolean =>
    Array.isArray(rows) && rows.some((row) => isPlainObject(row) && Object.values(row).some(rawIdentity))
  const afRec = af as Record<string, unknown>
  const groupsOf = (key: string): unknown => {
    const block = afRec[key]
    return isPlainObject(block) ? (block as Record<string, unknown>).groups : undefined
  }
  const contributionValueOf = (block: unknown): unknown =>
    isPlainObject(block) ? (block as Record<string, unknown>).value : undefined
  if (
    scanIdentityRows(groupsOf('initialAssignments')) ||
    scanIdentityRows(groupsOf('transfersIn')) ||
    scanIdentityRows(groupsOf('transfersOut')) ||
    scanIdentityRows(contributionValueOf(salesAssignment.contractContribution)) ||
    scanIdentityRows(contributionValueOf(salesAssignment.creditedContribution))
  ) {
    return invalid('salesAssignment 销售身份字段残留原始微信 ID（必须先掩蔽再入缓存）')
  }

  const dataRange = report.dataRange
  if (!isPlainObject(dataRange)) return invalid('dataRange 缺失')
  const bothNull = dataRange.from === null && dataRange.to === null
  // 采用事实时间戳：有限整数 > 0（与客户行时间戳同一 timestampField 规则）
  const bothFinite = timestampField(dataRange.from) && timestampField(dataRange.to) && dataRange.from <= dataRange.to
  if (!bothNull && !bothFinite) return invalid('dataRange 非法（空数据必须 {from:null,to:null}）')
  if (bothFinite) {
    if ((dataRange.to as number) > (asOf as number)) return invalid('dataRange.to 不得晚于 asOf')
    if ((dataRange.from as number) < ANNUAL_REVIEW_MIN_FACT_MS) return invalid('dataRange 含非法毫秒时间（早于 2000）')
  }

  const completeness = report.completeness
  if (!isPlainObject(completeness) || !isMetricState(completeness.overall) || !isPlainObject(completeness.blocks)) {
    return invalid('completeness 缺失或形状非法')
  }
  for (const blockId of BLOCK_IDS) {
    if (!isMetricState((completeness.blocks as Record<string, unknown>)[blockId])) return invalid(`completeness.blocks.${blockId} 非法`)
  }
  // 不相信 Worker 自报：completeness 必须与各指标/区块状态严格一致（complete 不得含
  // unavailable/partial/snapshot_only；未实现的 monthly 恒 unavailable——由推导核对统一保证）
  const derivedBlocks = {
    summary: aggregateMetricStates(SUMMARY_METRIC_KEYS.map((key) => (summary[key] as { state: MetricState }).state)),
    funnel: aggregateMetricStates(FUNNEL_METRIC_KEYS.map((key) => (funnel[key] as { coverage: { status: MetricState } }).coverage.status)),
    customers: aggregateMetricStates(CUSTOMERS_METRIC_KEYS.map((key) => (customers[key] as { coverage: { status: MetricState } }).coverage.status)),
    monthly: aggregateMetricStates(MONTHLY_METRIC_KEYS.map((key) => (monthlyBlock[key] as { state: MetricState }).state)),
    communication: aggregateMetricStates(COMMUNICATION_METRIC_KEYS.map((key) => (communication[key] as { state: MetricState }).state)),
    salesAssignment: aggregateMetricStates([
      (salesAssignment.coverage as { status: MetricState }).status,
      ...SALES_ASSIGNMENT_METRIC_KEYS.map((key) => (salesAssignment[key] as { state: MetricState }).state)
    ])
  }
  if (completeness.overall !== aggregateMetricStates(Object.values(derivedBlocks))) {
    return invalid('completeness.overall 与指标/区块状态推导不一致')
  }
  for (const blockId of BLOCK_IDS) {
    if ((completeness.blocks as Record<string, unknown>)[blockId] !== derivedBlocks[blockId]) {
      return invalid(`completeness.blocks.${blockId} 与指标/区块状态推导不一致`)
    }
  }

  const coverage = report.coverage
  if (!isPlainObject(coverage)) return invalid('coverage 缺失')
  // 固定唯一 metricKey 全集：缺一/多一/未知键一律拒绝（键集合确定 → 报告消费方可穷举渲染）
  const coverageKeys = Object.keys(coverage).sort()
  const expectedKeys = [...EXPECTED_COVERAGE_KEYS].sort()
  if (coverageKeys.length !== expectedKeys.length || coverageKeys.some((key, i) => key !== expectedKeys[i])) {
    return invalid('coverage metricKey 集合不完整或含未知键')
  }
  for (const [key, cov] of Object.entries(coverage)) {
    if (!isCoverageShape(cov)) return invalid(`coverage.${key} 非法`)
  }
  // coverage.status 必须与对应指标/区块真实状态完全一致（建立固定 metricKey → 状态映射；
  // 不允许 unavailable 指标伪装 complete coverage 等）
  const expectedCoverageStatus: Record<string, string> = {}
  for (const key of SUMMARY_METRIC_KEYS) expectedCoverageStatus[`summary.${key}`] = (summary[key] as { state: MetricState }).state
  for (const key of FUNNEL_METRIC_KEYS) expectedCoverageStatus[`funnel.${key}`] = (funnel[key] as { coverage: { status: MetricState } }).coverage.status
  for (const key of CUSTOMERS_METRIC_KEYS) expectedCoverageStatus[`customers.${key}`] = (customers[key] as { coverage: { status: MetricState } }).coverage.status
  for (const key of MONTHLY_METRIC_KEYS) expectedCoverageStatus[`monthly.${key}`] = (monthlyBlock[key] as { state: MetricState }).state
  for (const key of COMMUNICATION_METRIC_KEYS) expectedCoverageStatus[`communication.${key}`] = (communication[key] as { state: MetricState }).state
  expectedCoverageStatus['salesAssignment.assignedFacts'] = (salesAssignment.coverage as { status: MetricState }).status
  for (const key of SALES_ASSIGNMENT_METRIC_KEYS) expectedCoverageStatus[`salesAssignment.${key}`] = (salesAssignment[key] as { state: MetricState }).state
  for (const [key, cov] of Object.entries(coverage)) {
    const expected = expectedCoverageStatus[key]
    if (expected !== undefined && (cov as AnnualReviewCoverage).status !== expected) {
      return invalid(`coverage.${key}.status 与指标/区块实际状态不一致`)
    }
  }

  const warnings = report.warnings
  if (!Array.isArray(warnings)) return invalid('warnings 缺失')
  const expectedKeySet = new Set<string>(EXPECTED_COVERAGE_KEYS)
  for (const w of warnings) {
    if (!isPlainObject(w) || typeof w.code !== 'string' || w.code === '' || typeof w.message !== 'string') return invalid('warnings 行形状非法')
    if (!Array.isArray(w.metricKeys) || w.metricKeys.some((k) => typeof k !== 'string')) return invalid('warnings.metricKeys 非法')
    // metricKeys 只能引用固定 metricKey 集合，且去重（未知键/重复键拒绝）
    const seenKeys = new Set<string>()
    for (const k of w.metricKeys as string[]) {
      if (!expectedKeySet.has(k)) return invalid(`warnings.metricKeys 引用未知 metricKey：${k}`)
      if (seenKeys.has(k)) return invalid(`warnings.metricKeys 重复引用：${k}`)
      seenKeys.add(k)
    }
    if (w.counts !== undefined) {
      if (!isPlainObject(w.counts)) return invalid('warnings.counts 非法')
      for (const [ck, count] of Object.entries(w.counts)) {
        if (!isFiniteNumber(count)) return invalid('warnings.counts 含非法数值')
        if (!seenKeys.has(ck)) return invalid('warnings.counts 键未在 metricKeys 中声明')
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
  const serializableReason = deepSerializableCheck(report, seen, new Set<object>())
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
export function validateAnnualReviewTaskId(taskId: unknown): taskId is string {
  return typeof taskId === 'string' && taskId.length > 0 && taskId.length <= 128 && !/\u0000/.test(taskId)
}
