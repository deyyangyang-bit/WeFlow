/**
 * annualReviewMonthly.ts —— 年度经营复盘 · 月度趋势（S5/阶段2，确定性统计）
 *
 * 规格 §6.1/§10 V1 必做：三条独立月度序列，量纲独立、绝不合并坐标轴：
 *   1. contractSign 签约金额：与 A4/A5 **完全同一实现**（aggregateSignedAmounts：
 *      同一 sign_date 集合 + 同一金额合法性规则 + 同一 state/warnings），禁止回退 created_at；
 *      非法金额（缺失/NaN/±Infinity）排除并告警，绝不 `amount ?? 0` 当作 0 元有效事实；
 *      按本地自然月聚合金额（deterministicSum，无中间舍入）。
 *   2. credited 已核销回款：与 A6 **完全同一实现**（aggregateCreditedAmounts：allocated=
 *      reconciled_at、legacy_confirmed 回退 confirmed_at、认领 pending 不计、缺时间/非法金额
 *      与 A6 同款排除与告警）；按最终采用的计入时间聚合。
 *   3. messageVolume 客户消息量：**复用 D5 单一统计结果**（communication.monthlyTrend，
 *      同一有效会话总体与同一聚合，不维护第二套）；stats 不可用/缺 daily → null。
 *
 * state/warnings 不是本模块自造：直接取共享聚合结果，摘要 A5/A6 为 partial 时对应月度序列
 * 必然 partial 且携带相同 warning code（消除摘要与月度之间的平行口径）。
 *
 * 月份轴（区间左闭右开；轴内缺失为真实零 0）：
 *   - historical_year：完整 12 个月；
 *   - current_year：1 月至 generatedAt 所在月；
 *   - all_time：只输出真实有数据月份（三序列数据月并集，升序）。
 * 纪律：纯函数、注入事实、不修改输入、与输入顺序无关；零 Electron 依赖。
 */
import {
  aggregateCreditedAmounts,
  aggregateSignedAmounts,
  deterministicSum,
  type AnnualReviewComputeOptions,
  type AnnualReviewPeriod,
  type MetricState,
  type MetricWarning
} from './annualReviewStats'
import type { AnnualReviewSegmentInputs } from './annualReviewSegments'
import type { AnnualReviewMonthlyPoint } from './annualReviewCommunication'

export interface AnnualReviewMonthlyAmountSeries {
  /** 轴内月份升序；unavailable 时为 null（不伪装成空数组） */
  months: Array<{ month: string; amount: number }> | null
  /** 与摘要 A5/A6 同一状态（共享聚合结果原样传播，不在此重算） */
  state: MetricState
  /** 与摘要 A5/A6 同一 warning code（共享聚合结果原样传播） */
  warnings: MetricWarning[]
}

export interface AnnualReviewMonthlyBlock {
  /** 签约金额（元，本地自然月） */
  contractSign: AnnualReviewMonthlyAmountSeries
  /** 已核销回款（元，按计入时间） */
  credited: AnnualReviewMonthlyAmountSeries
  /** 客户消息量（条；复用 D5 结果） */
  messageVolume: { months: AnnualReviewMonthlyPoint[] | null; state: MetricState; warnings: MetricWarning[] }
}

/** 本地自然月键 'YYYY-MM' */
function monthKeyOf(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** 月份轴：historical 12 个月 / current 截至生成月 / all_time 数据月并集 */
function buildMonthAxis(period: AnnualReviewPeriod, dataMonths: Set<string>): string[] {
  const months: string[] = []
  if (period.scopeKind === 'historical_year' && period.periodStart !== null && period.periodEndExclusive !== null) {
    const start = new Date(period.periodStart)
    const end = new Date(period.periodEndExclusive)
    for (let y = start.getFullYear(), m = start.getMonth();; m++) {
      if (m > 11) { m = 0; y++ }
      if (y > end.getFullYear() || (y === end.getFullYear() && m >= end.getMonth())) break
      months.push(`${y}-${String(m + 1).padStart(2, '0')}`)
    }
  } else if (period.scopeKind === 'current_year') {
    const gen = new Date(period.generatedAt)
    for (let m = 0; m <= gen.getMonth(); m++) {
      months.push(`${gen.getFullYear()}-${String(m + 1).padStart(2, '0')}`)
    }
  } else {
    months.push(...[...dataMonths].sort())
  }
  return months
}

/** 金额序列：按月聚合（轴内缺月真实零 0；deterministicSum 确定求和） */
function aggregateAmountMonths(
  entries: Array<{ month: string; amount: number }>,
  axis: string[]
): Array<{ month: string; amount: number }> {
  const byMonth = new Map<string, number[]>()
  for (const e of entries) {
    const list = byMonth.get(e.month) ?? []
    list.push(e.amount)
    byMonth.set(e.month, list)
  }
  return axis.map((month) => ({ month, amount: deterministicSum(byMonth.get(month) ?? []) }))
}

/**
 * 月度趋势（三序列）。messageTrend = communication.monthlyTrend（D5 单一事实源，
 * 本函数不重复聚合消息）；其 months 为 null 时 messageVolume 原样携带 null。
 * all_time 轴 = 签约/核销/消息数据月并集（消息序列不可用时仅取金额序列数据月）。
 * 金额序列事实/金额合法性/state/warnings 全部来自 A5/A6 共享聚合结果（同一实现，不平行计算）。
 */
export function computeAnnualReviewMonthly(
  period: AnnualReviewPeriod,
  inputs: AnnualReviewSegmentInputs,
  messageTrend: { months: AnnualReviewMonthlyPoint[] | null; state: MetricState; warnings: MetricWarning[] }
): AnnualReviewMonthlyBlock {
  // 签约金额：A4/A5 同一集合 + 同一金额合法性（非法金额排除而非按 0 计入）
  const signed = aggregateSignedAmounts(period, inputs.facts.contracts ?? [])
  const signEntries = signed.rows.map((c) => ({ month: monthKeyOf(c.signDate), amount: c.amount }))
  // 核销回款：A6 同一集合、同一计入时间与同一金额合法性
  const credited = aggregateCreditedAmounts(period, inputs.facts.allocations ?? [])
  const creditedEntries = credited.rows.map((row) => ({ month: monthKeyOf(row.time), amount: row.amount }))

  const dataMonths = new Set<string>()
  for (const e of signEntries) dataMonths.add(e.month)
  for (const e of creditedEntries) dataMonths.add(e.month)
  if (messageTrend.months !== null) {
    for (const p of messageTrend.months) {
      if (p.count > 0) dataMonths.add(p.month)
    }
  }
  const axis = buildMonthAxis(period, dataMonths)

  return {
    contractSign: { months: aggregateAmountMonths(signEntries, axis), state: signed.state, warnings: signed.warnings },
    credited: { months: aggregateAmountMonths(creditedEntries, axis), state: credited.state, warnings: credited.warnings },
    messageVolume: { months: messageTrend.months, state: messageTrend.state, warnings: messageTrend.warnings }
  }
}
