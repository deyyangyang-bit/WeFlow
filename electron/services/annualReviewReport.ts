/**
 * annualReviewReport.ts —— 年度经营复盘 · 报告组装与可用年份（S3，纯模块）
 *
 * 职责（规格 docs/设计-年度经营复盘-规格.md §7.2 / §10 / S3 任务）：
 *   - composeAnnualReviewReport：把 S1（A1–A9）与 S2（B1/B2/B3/B6/B7/C1–C8）已验收的
 *     纯统计结果装配为最终 AnnualReviewReport。**本模块不做任何第二次口径计算**：
 *     每个区块的 value/state/warnings/coverage/reasonCodes 原样来自统计层；
 *     unavailable 不得转成 0，D/E 组与月度趋势未实现 → 显式 unavailable 区块
 *     （reasonCode=metric_not_implemented），不伪造空数组/零值。
 *   - computeAnnualReviewAvailableYears：由真实事实时间戳推导可用年份 + 每年份覆盖摘要，
 *     主进程计算，renderer 不推断。
 *   - validateAnnualReviewYearInput：IPC 入口的运行时年份校验（不依赖 TypeScript 类型）。
 *
 * 边界：零 Electron 依赖、零数据库访问、不修改输入、同输入同输出；输出全部为
 * 可 structuredClone / JSON 序列化的普通对象；不含数据库路径、SQL、wxid 原文、
 * Token/密钥、原始聊天内容、调试堆栈。
 */
import {
  ANNUAL_REVIEW_REPORT_SCHEMA_VERSION,
  assertValidPeriod,
  computeAnnualReviewSummary,
  annualReviewCreditedAllocationsInRange,
  annualReviewSignedContractsInRange,
  asFinite,
  resolveAnnualReviewPeriod,
  type AnnualReviewComputeOptions,
  type AnnualReviewFacts,
  type AnnualReviewPeriod,
  type AnnualReviewSummary
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

/** 客户经营区块（S2 已验收统计的原样装配） */
export interface AnnualReviewCustomersBlock {
  highValue: ReturnType<typeof computeAnnualReviewHighValueCustomers>
  newCustomers: ReturnType<typeof computeAnnualReviewNewCustomerDetails>
  dealing: ReturnType<typeof computeAnnualReviewDealingCustomers>
  repeat: ReturnType<typeof computeAnnualReviewRepeatCustomers>
  active: ReturnType<typeof computeAnnualReviewActiveCustomerDetails>
  silent: ReturnType<typeof computeAnnualReviewSilentCustomers>
  risk: ReturnType<typeof computeAnnualReviewRiskCustomers>
  priority: ReturnType<typeof computeAnnualReviewCurrentPriorityCustomers>
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
}

export interface ComposeAnnualReviewReportInput {
  period: AnnualReviewPeriod
  facts: AnnualReviewFacts
  sales: AnnualReviewSalesSegmentsFacts
  crm: AnnualReviewCrmSegmentsFacts
  opts?: AnnualReviewComputeOptions
}

/**
 * 组装最终报告。统计口径全部来自 S1/S2 已验收纯函数；本函数只做装配。
 * 同一输入（含 period.generatedAt）必得同一输出；不修改输入。
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
  const customers: AnnualReviewCustomersBlock = {
    highValue: computeAnnualReviewHighValueCustomers(period, inputs, opts),
    newCustomers: computeAnnualReviewNewCustomerDetails(period, inputs, opts),
    dealing: computeAnnualReviewDealingCustomers(period, inputs, opts),
    repeat: computeAnnualReviewRepeatCustomers(period, inputs, opts),
    active: computeAnnualReviewActiveCustomerDetails(period, inputs, opts),
    silent: computeAnnualReviewSilentCustomers(period, inputs, opts),
    risk: computeAnnualReviewRiskCustomers(period, inputs, opts),
    priority: computeAnnualReviewCurrentPriorityCustomers(period, inputs, opts)
  }

  return {
    reportSchemaVersion: ANNUAL_REVIEW_REPORT_SCHEMA_VERSION,
    year: period.year,
    scopeKind: period.scopeKind,
    periodStart: period.periodStart,
    periodEndExclusive: period.periodEndExclusive,
    asOf: period.asOf,
    generatedAt: period.generatedAt,
    timezoneNote: 'local',
    summary,
    funnel,
    customers,
    monthly: { ...NOT_IMPLEMENTED_BLOCK, reasonCodes: ['metric_not_implemented'] },
    communication: { ...NOT_IMPLEMENTED_BLOCK, reasonCodes: ['metric_not_implemented'] },
    salesAssignment: { ...NOT_IMPLEMENTED_BLOCK, reasonCodes: ['metric_not_implemented'] }
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
  /** 年份；0 = 历史以来（当存在任何本地数据时提供） */
  year: number
  coverage: AnnualReviewYearCoverage
}

export interface AnnualReviewAvailableYearsResult {
  /** 升序确定排序；含 0=历史以来（存在数据时） */
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
 *   years 升序；存在任何数据时追加 0=历史以来。空库 → years=[]、supportsAllTime=false。
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
