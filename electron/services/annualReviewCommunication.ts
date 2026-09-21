/**
 * annualReviewCommunication.ts —— 年度经营复盘 · D 组沟通质量（S5，确定性统计）
 *
 * 规格 docs/设计-年度经营复盘-规格.md §5.4 / §10（V1 必做）：
 *   - D1 customer_message_volume：年度客户消息量 = 注入消息统计会话 sent+received 求和。
 *     统计总体由 loader 限定为 CRM 绑定会话（account.session_id 去重，应用结构性/
 *     手动/内部排除），本模块不扩大总体。
 *   - D2 contacted_customers：D1 中 sent+received>0 的会话数 —— 与 A3 完全同一计算结果
 *     （computeAnnualReviewCustomerActiveDetail 单一实现，禁止第二套）。
 *   - D3 outbound_rate：Σsent / (Σsent+Σreceived)，会话求和后计算；收发标识非法的会话
 *     剔除并告警，剔除比例 >20% → partial；分母 0（无消息）→ unavailable（A9 同款，
 *     不显示 0% 冒充）。
 *   - D5 monthly_communication_trend：native daily（本地日期 → 量）按本地月聚合；
 *     历史年度完整 12 个月、当前年度截至生成月、all_time 取有数据月份；单序列
 *     （发送/接收分序列待形状确认，§10 未确认项）；月轴内缺月为真实零 0。
 *   - D7 long_silent_customers（仅 current_year/all_time）：绑定会话最近联系
 *     （account.last_contact_at 秒×1000，每会话取最大有效值，与 A3 回退同一规则）
 *     < asOf-180 天且代表画像阶段非 won/lost；恒 partial（回退口径）；历史年度
 *     unavailable（当前投影 ≠ 历史时点，§3.2）。
 *
 * 纪律：纯函数、注入事实、不修改输入、同输入同输出且与输入行序无关；零 Electron
 * 依赖；输出可 structuredClone；不包含 sessionId/wxid/路径/SQL/正文。
 */
import {
  computeAnnualReviewCustomerActiveDetail,
  buildExclusionSet,
  selectCrmBoundSessions,
  selectPerSessionLastContactMs,
  asFinite,
  type AnnualReviewComputeOptions,
  type AnnualReviewPeriod,
  type MetricState,
  type MetricWarning,
  type AnnualReviewMessageStats
} from './annualReviewStats'
import { selectRepresentativeProfiles, type AnnualReviewSegmentInputs } from './annualReviewSegments'
import { normalizeStage } from '../../shared/salesStage'

// ─── 稳定文案 ────────────────────────────────────────────────────────────────

const COMM_WARN = {
  message_stats_invalid: '部分会话消息收发统计非法，已剔除（不计入总量）',
  message_stats_unavailable: '消息库不可用，无法统计沟通指标',
  daily_stats_missing: '按日消息统计缺失，月度趋势不可得',
  daily_scope_unverified: '按日消息统计的会话范围无法在 native 层核实，月度趋势按部分完整呈现',
  last_contact_fallback: '活跃/沉默按最近联系时间近似统计（回填口径）',
  history_contact_unavailable: '历史年度联系时间无法重建，当前投影不能代替'
} as const

function sortedWarnings(list: MetricWarning[]): MetricWarning[] {
  return [...list].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
}

/** 确定性数值求和（整数/金额统一走加法，不做中间舍入） */
function sumOf(values: number[]): number {
  let s = 0
  for (const v of values) s += v
  return s
}

// ─── D1/D2/D3/D5 ─────────────────────────────────────────────────────────────

export interface AnnualReviewCommunicationMetric<T> {
  /** unavailable 时为 null；0 是真实零 */
  value: T | null
  state: MetricState
  warnings: MetricWarning[]
}

export interface AnnualReviewMonthlyPoint {
  /** 本地月 'YYYY-MM'，升序 */
  month: string
  count: number
}

export interface AnnualReviewCommunicationBlock {
  /** D1 年度客户消息量 */
  volume: AnnualReviewCommunicationMetric<number>
  /** D2 有沟通客户数（=A3 同一结果） */
  contacted: AnnualReviewCommunicationMetric<number>
  /** D3 主动联系率（0–1，元以内不舍入） */
  outboundRate: AnnualReviewCommunicationMetric<number>
  /** D5 月度沟通趋势（单序列） */
  monthlyTrend: { months: AnnualReviewMonthlyPoint[] | null; state: MetricState; warnings: MetricWarning[] }
  /** D7 长期未联系客户（sessionId 行由组装层映射业务身份） */
  longSilent: { sessionIds: Array<{ sessionId: string; lastContactAtMs: number }> | null; state: MetricState; warnings: MetricWarning[] }
}

/**
 * D1/D3 会话求和（与有效 CRM 会话总体求交集，fail closed）：
 *   - 只统计总体内会话（selectCrmBoundSessions 唯一选择器）；native 返回的总体外
 *     会话（未绑定/被排除/群聊公众号系统号）一律忽略，不得进入总量、分子分母与
 *     非法会话比例；
 *   - 总体内但 stats 无条目 = 该区间无消息（合法 0，不是查询失败）；
 *   - 非法比例分母 = 总体内在 stats 中有条目的会话数（有数据才谈得上非法）。
 */
function sumSessions(
  messageStats: AnnualReviewMessageStats,
  population: string[]
): { total: number; sent: number; received: number; invalid: number; present: number } {
  let sent = 0
  let received = 0
  let invalid = 0
  let present = 0
  for (const sid of population) {
    const stat = messageStats.sessions?.[sid]
    if (!stat) continue // 区间无消息：合法真实零
    present++
    const s = asFinite(stat.sent)
    const r = asFinite(stat.received)
    if (s === null || r === null) {
      invalid++
      continue
    }
    sent += s
    received += r
  }
  return { total: sent + received, sent, received, invalid, present }
}

/** D5 本地月聚合：历史 12 个月、当前年截至生成月、all_time 有数据月份 */
function aggregateMonthlyMonths(daily: Record<string, number>, period: AnnualReviewPeriod): AnnualReviewMonthlyPoint[] {
  const byMonth = new Map<string, number>()
  for (const [day, count] of Object.entries(daily)) {
    const n = asFinite(count)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || n === null || n < 0) continue
    const monthKey = day.slice(0, 7)
    byMonth.set(monthKey, (byMonth.get(monthKey) ?? 0) + n)
  }
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
    months.push(...[...byMonth.keys()].sort())
  }
  return months.map((month) => ({ month, count: byMonth.get(month) ?? 0 }))
}

/**
 * D 组沟通质量。messageStats.ok=false → D1/D2/D3/D5 unavailable（不伪造 0）；
 * 历史年度 D7 unavailable。
 */
export function computeAnnualReviewCommunication(
  period: AnnualReviewPeriod,
  inputs: AnnualReviewSegmentInputs,
  opts: AnnualReviewComputeOptions = {}
): AnnualReviewCommunicationBlock {
  const messageStats = opts.messageStats ?? null
  const statsOk = messageStats !== null && messageStats.ok === true
  // 有效 CRM 会话总体（唯一选择器；D1/D2/D3 同一总体）
  const population = selectCrmBoundSessions(inputs.facts.accounts, opts.exclusions)

  // ── D1 / D3：会话求和（仅总体内会话；native 多返回的一律忽略） ──
  let volume: AnnualReviewCommunicationMetric<number>
  let outboundRate: AnnualReviewCommunicationMetric<number>
  if (!statsOk) {
    volume = { value: null, state: 'unavailable', warnings: [{ code: 'message_stats_unavailable', message: COMM_WARN.message_stats_unavailable }] }
    outboundRate = { value: null, state: 'unavailable', warnings: [{ code: 'message_stats_unavailable', message: COMM_WARN.message_stats_unavailable }] }
  } else {
    const sums = sumSessions(messageStats, population)
    const w: MetricWarning[] = []
    let state: MetricState = 'complete'
    if (sums.invalid > 0) {
      w.push({ code: 'message_stats_invalid', message: COMM_WARN.message_stats_invalid, count: sums.invalid })
      // 非法会话占「总体内已有条目会话」比例 >20% → partial（规格 §5.4 D3）
      if (sums.present > 0 && sums.invalid * 5 > sums.present) state = 'partial'
    }
    volume = { value: sumOf([sums.total]), state, warnings: sortedWarnings(w) }
    // D3：分母 0（无有效消息）→ unavailable（不显示 0% 冒充，A9 同款）；非法会话剔除后计算
    if (sums.sent + sums.received === 0) {
      outboundRate = { value: null, state: 'unavailable', warnings: sortedWarnings(w) }
    } else {
      outboundRate = { value: sums.sent / (sums.sent + sums.received), state, warnings: sortedWarnings(w) }
    }
  }

  // ── D2：与 A3 完全同一计算结果 ──
  const activeDetail = computeAnnualReviewCustomerActiveDetail(period, inputs.facts, opts)
  const contacted: AnnualReviewCommunicationMetric<number> = {
    value: activeDetail.metric.value,
    state: activeDetail.metric.state,
    warnings: sortedWarnings(activeDetail.metric.warnings)
  }

  // ── D5：本地月聚合 ──
  let monthlyTrend: AnnualReviewCommunicationBlock['monthlyTrend']
  if (!statsOk) {
    monthlyTrend = { months: null, state: 'unavailable', warnings: [{ code: 'message_stats_unavailable', message: COMM_WARN.message_stats_unavailable }] }
  } else if (!messageStats.daily || Object.keys(messageStats.daily).length === 0) {
    monthlyTrend = { months: null, state: 'unavailable', warnings: [{ code: 'daily_stats_missing', message: COMM_WARN.daily_stats_missing }] }
  } else {
    // native daily 的会话范围无法在实现层证明严格等于传入 sessionIds（native 层不可审计）
    // → 恒 partial（数据存在但覆盖受限），不宣称精确（fail closed）
    monthlyTrend = {
      months: aggregateMonthlyMonths(messageStats.daily, period),
      state: 'partial',
      warnings: [{ code: 'daily_scope_unverified', message: COMM_WARN.daily_scope_unverified }]
    }
  }

  // ── D7：长期未联系（仅 current_year/all_time；回退口径恒 partial） ──
  // 总体与每会话最近联系 = selectCrmBoundSessions / selectPerSessionLastContactMs 唯一选择器
  let longSilent: AnnualReviewCommunicationBlock['longSilent']
  if (period.scopeKind === 'historical_year') {
    longSilent = {
      sessionIds: null,
      state: 'unavailable',
      warnings: [{ code: 'history_contact_unavailable', message: COMM_WARN.history_contact_unavailable }]
    }
  } else {
    const lastContactBySession = selectPerSessionLastContactMs(inputs.facts.accounts, opts.exclusions)
    const boundCount = selectCrmBoundSessions(inputs.facts.accounts, opts.exclusions).length
    // 代表画像阶段过滤（唯一规则：selectRepresentativeProfiles）；无画像 = 阶段未知 ≠ won/lost → 计入
    const reps = selectRepresentativeProfiles(inputs.sales?.profiles ?? [], buildExclusionSet(opts.exclusions))
    const threshold = period.asOf - 180 * 86_400_000
    const rows: Array<{ sessionId: string; lastContactAtMs: number }> = []
    for (const [sid, ms] of lastContactBySession) {
      if (ms >= threshold) continue
      const rep = reps.get(sid)
      const canonical = rep?.stage ? normalizeStage(rep.stage) : null
      if (canonical === 'won' || canonical === 'lost') continue
      rows.push({ sessionId: sid, lastContactAtMs: ms })
    }
    rows.sort((a, b) => a.lastContactAtMs - b.lastContactAtMs || (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0))
    longSilent = {
      sessionIds: rows,
      state: boundCount === 0 ? 'complete' : 'partial',
      warnings: boundCount === 0 ? [] : [{ code: 'last_contact_fallback', message: COMM_WARN.last_contact_fallback }]
    }
  }

  return { volume, contacted, outboundRate, monthlyTrend, longSilent }
}
