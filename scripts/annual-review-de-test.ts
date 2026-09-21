/**
 * annual-review-de-test.ts —— 年度经营复盘 S5 护栏（D 组沟通 / E 组销售与分配）
 *
 * 覆盖（规格 §5.4/§5.5 V1 必做项）：
 *   D1/D2/D3 正常路径与非法会话剔除（>20% → partial、分母 0 → unavailable）
 *   D2 与 A3 同一结果（禁止第二套）
 *   D5 本地月聚合（历史 12 月 / 当前年截至生成月 / all_time 有数据月；缺月真实零）
 *   D7 180 天边界、won/lost 排除、排除名单、历史年度 unavailable
 *   E1 分项分组（初始分配/移入/移出不相加）、sync 缺口（仅 assign/transfer；noop/回收不触发）、
 *      空数据 empty-zero、[periodStart, asOf) 左闭右开边界、输入顺序不变性
 *   E3 claimed_at 边界、lead 缺失告警、幂等去重
 *   E4 恒 partial + owner 分组求和；E5 认领销售分组 + legacy partial
 *   组装层：coverage 33 键、completeness 推导、validator 通过、公开报告无 sessionId
 * 运行：npx tsx scripts/annual-review-de-test.ts
 */
import {
  composeAnnualReviewReport,
  validateAnnualReviewReport,
  type AnnualReviewReport
} from '../electron/services/annualReviewReport'
import { computeAnnualReviewCommunication } from '../electron/services/annualReviewCommunication'
import { computeAnnualReviewSalesAssignment } from '../electron/services/annualReviewAssignment'
import { resolveAnnualReviewPeriod, type AnnualReviewFacts } from '../electron/services/annualReviewStats'
import type { AnnualReviewSalesSegmentsFacts, AnnualReviewCrmSegmentsFacts } from '../electron/services/annualReviewSegments'

let pass = 0, fail = 0
function ok(name: string, cond: boolean): void {
  if (cond) { pass++ } else { fail++; console.error('FAIL:', name) }
}
function eq(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a === b) pass++
  else { fail++; console.error(`FAIL: ${name}\n  actual:   ${a}\n  expected: ${b}`) }
}

const T = (y: number, m: number, d: number, hh = 0, mm = 0, ss = 0, ms = 0): number =>
  new Date(y, m - 1, d, hh, mm, ss, ms).getTime()
const GEN = T(2026, 6, 15, 12, 0, 0)

const accF = (id: number, sessionId: string | null, extra: Partial<AnnualReviewFacts['accounts'][number]> = {}) =>
  ({ id, name: `客户${id}`, createdAt: T(2024, 1, 1), importedAt: null, sessionId, lastContactAtSec: null, ...extra })
const conF = (id: number, accountId: number | null, signDate: number | null, amount: number | null, ownerSales?: string | null) =>
  ({ id, accountId, amount, status: 'signed', signDate, createdAt: T(2024, 1, 1), ownerSales: ownerSales ?? null })
const allocF = (id: number, accountId: number | null, creditedAmount: number | null, reconciledAt: number | null, salesName?: string | null, reconciliationStatus = 'allocated', confirmedAt: number | null = null) =>
  ({ id, accountId, creditedAmount, reconciledAt, status: 'confirmed', reconciliationStatus, confirmedAt, contractId: 1, salesName: salesName ?? null })

const auditF = (id: number, action: string, createdAt: number | null, fields: Partial<{ detailType: string | null; salesName: string | null; toSales: string | null; fromSales: string | null; mode: string | null; assignmentId: number | null }> = {}) =>
  ({ id, action, createdAt, detailType: null, salesName: null, toSales: null, fromSales: null, mode: null, assignmentId: null, ...fields })

const profF = (id: number, sessionId: string | null, stage: string | null, lastContactAtSec: number | null = null) =>
  ({ id, sessionId, stage, lastContactAtSec })

const emptySales = (): AnnualReviewSalesSegmentsFacts => ({ profiles: [], intentEvents: [] })
const emptyCrm = (): AnnualReviewCrmSegmentsFacts => ({ opportunities: [], opportunityEvents: [] })

const accountsBound = (): AnnualReviewFacts['accounts'] => [
  accF(1, 'wx_a', { createdAt: T(2025, 2, 1) }),
  accF(2, 'wx_b', { createdAt: T(2025, 3, 1) }),
  accF(3, 'wx_c', { createdAt: T(2025, 4, 1) }),
  accF(4, 'wx_d', { createdAt: T(2025, 5, 1) }),
  accF(5, 'wx_e', { createdAt: T(2025, 6, 1) }),
  accF(6, 'wx_f', { createdAt: T(2025, 7, 1) })
]

async function main(): Promise<void> {
  // ══ D1/D2/D3 正常路径 + 非法剔除 ═══════════════════════════════════════════
  {
    const facts: AnnualReviewFacts = { accounts: accountsBound(), contracts: [], allocations: [], shippedEvents: [] }
    const inputs = { facts, sales: emptySales(), crm: emptyCrm() }
    const period = resolveAnnualReviewPeriod(2026, GEN)
    const stats = { ok: true, sessions: { wx_a: { sent: 30, received: 10 }, wx_b: { sent: 0, received: 40 }, wx_c: { sent: 0, received: 0 } }, daily: { '2026-02-10': 7 } }
    const block = computeAnnualReviewCommunication(period, inputs, { messageStats: stats })
    ok('D1 消息总量 = Σ(sent+received)', block.volume.value === 80 && block.volume.state === 'complete')
    ok('D3 主动联系率 = Σsent/(Σsent+Σreceived)', Math.abs((block.outboundRate.value as number) - 30 / 80) < 1e-12 && block.outboundRate.state === 'complete')
    ok('D5 月度聚合（当前年截至生成月，1–6 月）', (block.monthlyTrend.months ?? []).map((m) => m.month).join(',') === '2026-01,2026-02,2026-03,2026-04,2026-05,2026-06')
    // D2 与 A3 同一结果（A3 主口径：wx_a 30>0、wx_b 40>0、wx_c 0 → 2 人）
    ok('D2 = A3 同一计算结果（2 人）', block.contacted.value === 2)

    // 非法会话剔除（2/4 = 50% > 20% → partial；总量只计有效会话）
    const invalidStats = { ok: true, sessions: { wx_a: { sent: 10, received: 5 }, wx_b: { sent: Number.NaN, received: 1 }, wx_c: { sent: 2, received: undefined as unknown as number }, wx_d: { sent: 1, received: 1 } } }
    const block2 = computeAnnualReviewCommunication(period, inputs, { messageStats: invalidStats })
    ok('D1b 非法会话剔除并计数告警（2 条）', block2.volume.value === 17 && block2.volume.state === 'partial' &&
      block2.volume.warnings.some((w) => w.code === 'message_stats_invalid' && w.count === 2))
    ok('D3b 非法比例 >20% → partial 且分子分母只含有效会话', Math.abs((block2.outboundRate.value as number) - 11 / 17) < 1e-12 && block2.outboundRate.state === 'partial')

    // 分母 0（有会话无消息）→ unavailable，不显示 0%
    const zeroStats = { ok: true, sessions: { wx_a: { sent: 0, received: 0 } } }
    const block3 = computeAnnualReviewCommunication(period, inputs, { messageStats: zeroStats })
    ok('D3c 无消息 → unavailable（不显示 0%）', block3.outboundRate.value === null && block3.outboundRate.state === 'unavailable')
    ok('D1c 有会话无消息 = 真实零 0', block3.volume.value === 0 && block3.volume.state === 'complete')

    // 消息库不可用 → D1/D3 unavailable；D7 仍按画像/账户口径
    const downStats = { ok: false, sessions: {} }
    const block4 = computeAnnualReviewCommunication(period, inputs, { messageStats: downStats })
    ok('D1d 消息库不可用 → unavailable', block4.volume.value === null && block4.volume.state === 'unavailable' &&
      block4.outboundRate.value === null && block4.monthlyTrend.state === 'unavailable')
  }

  // ══ D5 历史年度 12 月 / all_time 有数据月 ══════════════════════════════════
  {
    const facts: AnnualReviewFacts = { accounts: accountsBound(), contracts: [], allocations: [], shippedEvents: [] }
    const daily: Record<string, number> = { '2025-01-05': 3, '2025-03-20': 4, '2025-12-31': 5, '垃圾': 99 }
    const histPeriod = resolveAnnualReviewPeriod(2025, GEN)
    const block = computeAnnualReviewCommunication(histPeriod, { facts, sales: emptySales(), crm: emptyCrm() }, { messageStats: { ok: true, sessions: { wx_a: { sent: 12, received: 0 } }, daily } })
    eq('D5b 历史年度完整 12 个月轴（缺月真实零）', (block.monthlyTrend.months ?? []).map((m) => `${m.month}:${m.count}`), [
      '2025-01:3', '2025-02:0', '2025-03:4', '2025-04:0', '2025-05:0', '2025-06:0',
      '2025-07:0', '2025-08:0', '2025-09:0', '2025-10:0', '2025-11:0', '2025-12:5'
    ])
    const allTimePeriod = resolveAnnualReviewPeriod(0, GEN)
    const block2 = computeAnnualReviewCommunication(allTimePeriod, { facts, sales: emptySales(), crm: emptyCrm() }, { messageStats: { ok: true, sessions: { wx_a: { sent: 12, received: 0 } }, daily } })
    eq('D5c all_time 取有数据月份（升序）', (block2.monthlyTrend.months ?? []).map((m) => m.month), ['2025-01', '2025-03', '2025-12'])
    // daily 缺失 → unavailable（不伪造）
    const block3 = computeAnnualReviewCommunication(histPeriod, { facts, sales: emptySales(), crm: emptyCrm() }, { messageStats: { ok: true, sessions: {} } })
    ok('D5d daily 缺失 → unavailable', block3.monthlyTrend.state === 'unavailable' && block3.monthlyTrend.months === null)
  }

  // ══ D6 非法计数（P1 回归）与严格日期键（P2 回归） ══════════════════════════
  {
    const facts: AnnualReviewFacts = { accounts: accountsBound(), contracts: [], allocations: [], shippedEvents: [] }
    const inputs = { facts, sales: emptySales(), crm: emptyCrm() }
    const period = resolveAnnualReviewPeriod(2026, GEN)
    const comm = (sessions: Record<string, { sent: number; received: number }>, daily?: Record<string, number>) =>
      computeAnnualReviewCommunication(period, inputs, { messageStats: { ok: true, sessions, daily } })
    const warn = (m: { warnings: Array<{ code: string; message: string; count?: number }> }, code: string) =>
      m.warnings.find((w) => w.code === code)

    // 反例（原缺陷）：{ sent: -5, received: 1 } 曾得到负总量与 outboundRate=1.25 且 state=complete
    const negSent = comm({ wx_a: { sent: -5, received: 1 } })
    ok('D6 负 sent：不得产生负总量 / 不得 >1 比例 / 不得 complete', (negSent.volume.value as number) >= 0 &&
      negSent.volume.value === 0 && negSent.outboundRate.value === null && negSent.outboundRate.state === 'unavailable' &&
      negSent.volume.state === 'partial' && warn(negSent.volume, 'message_stats_invalid')?.count === 1)
    const negRecv = comm({ wx_a: { sent: 5, received: -1 } })
    ok('D6b 负 received：同样剔除并告警（不夹成 0 计入）', negRecv.volume.value === 0 &&
      negRecv.volume.state === 'partial' && warn(negRecv.volume, 'message_stats_invalid')?.count === 1)
    const negBoth = comm({ wx_a: { sent: -3, received: -4 } })
    ok('D6c 两者均负：剔除并告警', negBoth.volume.value === 0 && negBoth.volume.state === 'partial' &&
      warn(negBoth.volume, 'message_stats_invalid')?.count === 1)
    const frac = comm({ wx_a: { sent: 1.5, received: 2 } })
    ok('D6d 小数计数：非法（非负整数才合法）', frac.volume.value === 0 && frac.volume.state === 'partial' &&
      warn(frac.volume, 'message_stats_invalid')?.count === 1)
    const nonFinite = comm({ wx_a: { sent: Number.POSITIVE_INFINITY, received: 2 }, wx_b: { sent: 1, received: Number.NEGATIVE_INFINITY } })
    ok('D6e ±Infinity 计数：非法剔除并计数', nonFinite.volume.value === 0 &&
      warn(nonFinite.volume, 'message_stats_invalid')?.count === 2)
    // 合法值：0 与非负整数照常计入（真实零 / 正常比例）
    const zeros = comm({ wx_a: { sent: 0, received: 0 }, wx_b: { sent: 0, received: 0 } })
    ok('D6f 合法 0 → 真实零 complete（不误判为非法）', zeros.volume.value === 0 && zeros.volume.state === 'complete' &&
      zeros.volume.warnings.length === 0 && zeros.outboundRate.value === null)
    const mixed = comm({ wx_a: { sent: 2, received: 3 }, wx_b: { sent: -5, received: 1 } })
    ok('D6g 混合：非法会话剔除后比例仍 ∈ [0,1] 且总量为非负整数', mixed.volume.value === 5 &&
      mixed.outboundRate.value === 2 / 5 && (mixed.outboundRate.value as number) <= 1 &&
      mixed.outboundRate.state === 'partial' && mixed.volume.state === 'partial')
    ok('D6h 计数型输出恒为非负整数（volume/contacted/月度计数）',
      Number.isInteger(mixed.volume.value) && Number.isInteger(mixed.contacted.value as number) &&
      (mixed.monthlyTrend.months ?? []).every((m) => Number.isInteger(m.count) && m.count >= 0))

    // ── daily 非法日期键：不进入月份轴、不产生伪月份、稳定告警 ──
    const badDatesDaily: Record<string, number> = {
      '2025-01-05': 3,
      '2026-00-01': 9,
      '2026-13-01': 9,
      '2026-02-30': 9,
      '2026-99-99': 5,
      '2025-02-29': 7
    }
    const allTimePeriod = resolveAnnualReviewPeriod(0, GEN)
    const badDates = computeAnnualReviewCommunication(allTimePeriod, inputs, {
      messageStats: { ok: true, sessions: { wx_a: { sent: 1, received: 0 } }, daily: badDatesDaily }
    })
    const badMonths = (badDates.monthlyTrend.months ?? []).map((m) => m.month)
    ok('D6i 非法日期不进入 all_time 月份轴（无 2026-99 之类伪月份）', badMonths.join(',') === '2025-01' &&
      !badMonths.some((m) => m === '2026-99' || m === '2026-13' || m === '2026-00' || m === '2026-02' || m === '2025-02'))
    ok('D6j 非法日期产生稳定告警 + partial（不静默丢弃）', badDates.monthlyTrend.state === 'partial' &&
      badDates.monthlyTrend.warnings.some((w) => w.code === 'daily_date_invalid' && w.count === 5))
    // 历史年度轴同样不得被非法键污染（2025-02-29 不得落进 2025-02）
    const histBad = computeAnnualReviewCommunication(resolveAnnualReviewPeriod(2025, GEN), inputs, {
      messageStats: { ok: true, sessions: { wx_a: { sent: 1, received: 0 } }, daily: badDatesDaily }
    })
    const histFeb = (histBad.monthlyTrend.months ?? []).find((m) => m.month === '2025-02')
    ok('D6k 非闰年 2025-02-29 不落进 2025-02（保持真实零）', histFeb?.count === 0)

    // ── daily 非法计数：排除并告警 ──
    const badCounts = computeAnnualReviewCommunication(resolveAnnualReviewPeriod(2025, GEN), inputs, {
      messageStats: { ok: true, sessions: { wx_a: { sent: 1, received: 0 } }, daily: { '2025-01-05': -3, '2025-01-06': 1.5, '2025-03-01': 4 } }
    })
    const jan = (badCounts.monthlyTrend.months ?? []).find((m) => m.month === '2025-01')
    const mar = (badCounts.monthlyTrend.months ?? []).find((m) => m.month === '2025-03')
    ok('D6l daily 负数/小数计数排除并告警', jan?.count === 0 && mar?.count === 4 &&
      badCounts.monthlyTrend.warnings.some((w) => w.code === 'message_stats_invalid' && w.count === 2))
  }

  // ══ D7 长期未联系（180 天边界 / won/lost 排除 / 排除名单 / 历史年度） ══════
  {
    const facts: AnnualReviewFacts = {
      accounts: [
        accF(1, 'wx_a', { lastContactAtSec: Math.floor(T(2026, 1, 1) / 1000) }),   // 165 天前（<180）→ 不计
        accF(2, 'wx_b', { lastContactAtSec: Math.floor(T(2025, 11, 20) / 1000) }), // 207 天前 → 计入
        accF(3, 'wx_c', { lastContactAtSec: null })                                // 无联系时间 → 不计
      ],
      contracts: [], allocations: [], shippedEvents: []
    }
    const sales: AnnualReviewSalesSegmentsFacts = {
      profiles: [
        profF(1, 'wx_b', 'quoted'),   // 比价 → 非 won/lost → 计入
        profF(2, 'wx_d', 'won')       // 不会出现（wx_d 无 account）
      ], intentEvents: []
    }
    const period = resolveAnnualReviewPeriod(2026, GEN)
    const block = computeAnnualReviewCommunication(period, { facts, sales, crm: emptyCrm() }, {})
    ok('D7 165 天不计、207 天计入、恒 partial', block.longSilent.sessionIds?.length === 1 &&
      block.longSilent.sessionIds?.[0].sessionId === 'wx_b' && block.longSilent.state === 'partial')

    // 恰好 180 天（asOf-180d）不计（>180 才算）
    const exactFacts: AnnualReviewFacts = { accounts: [accF(9, 'wx_x', { lastContactAtSec: Math.floor((GEN - 180 * 86_400_000) / 1000) })], contracts: [], allocations: [], shippedEvents: [] }
    const blockExact = computeAnnualReviewCommunication(period, { facts: exactFacts, sales: emptySales(), crm: emptyCrm() }, {})
    ok('D7b 恰好 180 天不计', blockExact.longSilent.sessionIds?.length === 0)

    // won/lost 阶段排除
    const wonFacts: AnnualReviewFacts = { accounts: [accF(2, 'wx_b', { lastContactAtSec: Math.floor(T(2025, 1, 1) / 1000) }), accF(4, 'wx_d', { lastContactAtSec: Math.floor(T(2025, 1, 1) / 1000) })], contracts: [], allocations: [], shippedEvents: [] }
    const wonSales: AnnualReviewSalesSegmentsFacts = { profiles: [profF(1, 'wx_b', 'won'), profF(2, 'wx_d', 'lost')], intentEvents: [] }
    const blockWon = computeAnnualReviewCommunication(period, { facts: wonFacts, sales: wonSales, crm: emptyCrm() }, {})
    ok('D7c won/lost 阶段排除', blockWon.longSilent.sessionIds?.length === 0)

    // 历史年度 unavailable
    const histBlock = computeAnnualReviewCommunication(resolveAnnualReviewPeriod(2025, GEN), { facts, sales, crm: emptyCrm() }, {})
    ok('D7d 历史年度 unavailable（当前投影≠历史时点）', histBlock.longSilent.sessionIds === null && histBlock.longSilent.state === 'unavailable')
  }

  // ══ E1 分项事实 + sync 缺口 + 边界 ═════════════════════════════════════════
  {
    const S = T(2026, 1, 1)
    const E = T(2027, 1, 1)
    const period: Parameters<typeof computeAnnualReviewSalesAssignment>[0] = {
      year: 2026, scopeKind: 'current_year', periodStart: S, periodEndExclusive: E, asOf: GEN, generatedAt: GEN
    }
    const facts: AnnualReviewFacts = {
      accounts: [], contracts: [], allocations: [], shippedEvents: [],
      auditEvents: [
        auditF(1, 'lead_assign', S, { salesName: '张三', mode: 'manual', assignmentId: 9 }),        // 左闭：计入
        auditF(2, 'lead_assign', S + 1, { salesName: '张三', mode: 'manual', assignmentId: 10 }),
        auditF(3, 'lead_assign', T(2026, 5, 1), { salesName: '李四', mode: 'round_robin', assignmentId: 11 }),
        auditF(4, 'lead_assign', E, { salesName: '王五', mode: 'manual', assignmentId: 12 }),        // = asOf → 排除（右开）
        auditF(5, 'lead_assign', null, { salesName: '赵六', mode: null, assignmentId: 13 }),         // 无时间 → 告警
        auditF(6, 'lead_transfer', T(2026, 3, 1), { toSales: '李四', fromSales: '张三', assignmentId: 9 }),
        auditF(7, 'lead_transfer', T(2026, 4, 1), { toSales: '李四', fromSales: '王五', assignmentId: 10 }),
        auditF(8, 'sync_apply', T(2026, 2, 1), { detailType: 'assign', salesName: '张三' }),         // 缺口命中
        auditF(9, 'sync_apply', T(2026, 2, 2), { detailType: 'transfer', toSales: '李四' }),         // 缺口命中
        auditF(10, 'sync_apply', T(2026, 2, 3), { detailType: 'recycle' }),                          // 不触发
        auditF(11, 'sync_apply', T(2026, 2, 4), { detailType: 'transfer_remove_noop' })              // 不触发
      ]
    }
    const block = computeAnnualReviewSalesAssignment(period, { facts, sales: emptySales(), crm: emptyCrm() })
    ok('E1 初始分配计数（左闭右开 + 无时间排除）', block.assignedFacts.initialAssignments.total === 3)
    ok('E1b 按 salesName+mode 分组且排序确定', eq.length >= 0 && JSON.stringify(block.assignedFacts.initialAssignments.groups) === JSON.stringify([
      { salesName: '张三', mode: 'manual', count: 2 }, { salesName: '李四', mode: 'round_robin', count: 1 }
    ]))
    ok('E1c 移入/移出分项（不相加命名）', block.assignedFacts.transfersIn.total === 2 &&
      JSON.stringify(block.assignedFacts.transfersIn.groups) === JSON.stringify([{ salesName: '李四', count: 2 }]) &&
      JSON.stringify(block.assignedFacts.transfersOut.groups) === JSON.stringify([{ salesName: '张三', count: 1 }, { salesName: '王五', count: 1 }]))
    ok('E1d sync 缺口 → partial + exactCoverage=false + coverageRatio=null', block.coverage.status === 'partial' &&
      block.coverage.exactCoverage === false && block.coverage.coverageRatio === null &&
      block.warnings.some((w) => w.code === 'sync_import_not_audited'))
    ok('E1e 无时间/无效 detail 告警计数', block.warnings.some((w) => w.code === 'audit_time_missing' && w.count === 1))

    // 顺序不变性
    const shuffled = computeAnnualReviewSalesAssignment(period, {
      facts: { ...facts, auditEvents: [...(facts.auditEvents ?? [])].reverse() },
      sales: emptySales(), crm: emptyCrm()
    })
    ok('E1f 输入顺序无关', JSON.stringify(shuffled.assignedFacts) === JSON.stringify(block.assignedFacts) &&
      JSON.stringify(shuffled.coverage) === JSON.stringify(block.coverage))

    // 空数据（无本机事实且无 sync_apply）→ 真实零 complete
    const emptyFacts: AnnualReviewFacts = { accounts: [], contracts: [], allocations: [], shippedEvents: [], auditEvents: [] }
    const emptyBlock = computeAnnualReviewSalesAssignment(period, { facts: emptyFacts, sales: emptySales(), crm: emptyCrm() })
    ok('E1g 空数据 = 真实零（complete、rows=0）', emptyBlock.coverage.status === 'complete' && emptyBlock.coverage.rows === 0 &&
      emptyBlock.assignedFacts.initialAssignments.total === 0)

    // 只有 sync_apply 无本机事实 → partial 缺口（不得显示真实零……计数为 0 但状态为 partial 缺口）
    const gapOnly: AnnualReviewFacts = {
      accounts: [], contracts: [], allocations: [], shippedEvents: [],
      auditEvents: [auditF(1, 'sync_apply', T(2026, 2, 1), { detailType: 'assign' })]
    }
    const gapBlock = computeAnnualReviewSalesAssignment(period, { facts: gapOnly, sales: emptySales(), crm: emptyCrm() })
    ok('E1h 缺口状态 partial', gapBlock.coverage.status === 'partial' && gapBlock.coverage.exactCoverage === false)

    // 事实缺失（旧载荷）→ unavailable
    const legacyBlock = computeAnnualReviewSalesAssignment(period, { facts: { accounts: [], contracts: [], allocations: [], shippedEvents: [] }, sales: emptySales(), crm: emptyCrm() })
    ok('E1i 事实缺失 → unavailable', legacyBlock.coverage.status === 'unavailable')
  }

  // ══ E3/E4/E5 ═══════════════════════════════════════════════════════════════
  {
    const S = T(2026, 1, 1)
    const period: Parameters<typeof computeAnnualReviewSalesAssignment>[0] = {
      year: 2026, scopeKind: 'current_year', periodStart: S, periodEndExclusive: T(2027, 1, 1), asOf: GEN, generatedAt: GEN
    }
    const facts: AnnualReviewFacts = {
      accounts: [accF(1, 'wx_a', { ownerSales: '张三' }), accF(2, 'wx_b', { ownerSales: '李四' })],
      contracts: [
        conF(1, 1, T(2026, 2, 1), 1000),
        conF(2, 1, T(2026, 3, 1), 500),
        conF(3, 2, T(2026, 4, 1), 300),
        conF(4, null, T(2026, 4, 2), 999)      // 无 account → 排除 + 告警
      ],
      allocations: [
        allocF(1, 1, 800.5, T(2026, 3, 1), '李四'),
        allocF(2, 2, 200, T(2026, 5, 1), '李四'),
        allocF(3, 1, 50, T(2026, 5, 2), null)
      ],
      shippedEvents: [],
      assignments: [
        { id: 1, leadId: 1, salesName: '张三', mode: 'manual', claimedAt: S },                        // 左闭：计入
        { id: 2, leadId: 2, salesName: '张三', mode: 'manual', claimedAt: GEN },                      // = asOf → 排除
        { id: 3, leadId: 3, salesName: '张三', mode: 'manual', claimedAt: T(2026, 3, 1) },            // lead 缺失 → 告警
        { id: 4, leadId: 4, salesName: '张三', mode: 'manual', claimedAt: T(2026, 3, 2) },            // lead 未首触 → 不计
        { id: 1, leadId: 1, salesName: '张三', mode: 'manual', claimedAt: S }                         // 同 id 重复行 → 幂等
      ],
      leads: [
        { id: 1, accountId: 1, firstContactedAt: T(2026, 1, 5) },
        { id: 4, accountId: 2, firstContactedAt: null }
      ],
      auditEvents: []
    }
    const block = computeAnnualReviewSalesAssignment(period, { facts, sales: emptySales(), crm: emptyCrm() })
    ok('E3 认领且已首触 = 1（边界 + 幂等 + lead 缺失告警）', block.effectiveFollowup.value === 1 &&
      block.effectiveFollowup.state === 'partial' && block.effectiveFollowup.warnings.some((w) => w.code === 'effective_followup_lead_missing' && w.count === 1))
    ok('E4 合同贡献恒 partial（owner_current_value）+ 分组求和', block.contractContribution.state === 'partial' &&
      block.contractContribution.warnings.some((w) => w.code === 'owner_current_value'))
    const zhang = block.contractContribution.value?.find((r) => r.ownerSales === '张三')
    const li = block.contractContribution.value?.find((r) => r.ownerSales === '李四')
    ok('E4b 张三 1500/2 份、李四 300/1 份（金额降序）', zhang?.totalAmount === 1500 && zhang?.contractCount === 2 &&
      li?.totalAmount === 300 && (block.contractContribution.value?.[0].ownerSales) === '张三')
    ok('E4c 未关联客户合同告警', block.contractContribution.warnings.some((w) => w.code === 'contribution_account_missing' && w.count === 1))
    const creditedLi = block.creditedContribution.value?.find((r) => r.salesName === '李四')
    const creditedNone = block.creditedContribution.value?.find((r) => r.salesName === null)
    ok('E5 认领销售分组求和（含未认领组）', creditedLi?.totalAmount === 1000.5 && creditedNone?.totalAmount === 50)
    ok('E5b legacy 才 partial；本夹具无 legacy → complete', block.creditedContribution.state === 'complete')

    // legacy 回退 → partial
    const legacyFacts: AnnualReviewFacts = {
      accounts: [], contracts: [], allocations: [allocF(9, 2, 300, null, '李四', 'legacy_confirmed', T(2026, 5, 1))], shippedEvents: [],
      assignments: [], leads: [], auditEvents: []
    }
    const legacyBlock = computeAnnualReviewSalesAssignment(period, { facts: legacyFacts, sales: emptySales(), crm: emptyCrm() })
    ok('E5c legacy 回退 → partial + 告警', legacyBlock.creditedContribution.state === 'partial' &&
      legacyBlock.creditedContribution.warnings.some((w) => w.code === 'legacy_time_fallback'))
  }

  // ══ D1/D3 有效 CRM 会话总体（反例回归） ═══════════════════════════════════
  {
    const facts: AnnualReviewFacts = {
      accounts: [
        accF(1, 'wx_a', { createdAt: T(2025, 2, 1) }),
        accF(2, 'wx_b', { createdAt: T(2025, 3, 1) }),
        accF(3, 'wx_room@chatroom', { createdAt: T(2025, 4, 1) }),  // 群聊 → 结构性排除
        accF(4, 'gh_service', { createdAt: T(2025, 5, 1) }),        // 公众号 → 结构性排除
        accF(5, 'wx_manual', { createdAt: T(2025, 6, 1) }),         // 手动排除
        accF(6, 'wx_internal', { createdAt: T(2025, 7, 1) })        // 内部名单
      ],
      contracts: [], allocations: [], shippedEvents: []
    }
    const inputs = { facts, sales: emptySales(), crm: emptyCrm() }
    const period = resolveAnnualReviewPeriod(2026, GEN)
    const exclusions = { manualSessions: ['wx_manual'], internalSessions: ['wx_internal'] }
    const stats = {
      ok: true,
      sessions: {
        wx_a: { sent: 1, received: 1 },
        wx_b: { sent: 0, received: 0 },
        unbound: { sent: 100, received: 100 },          // 总体外（native 多返回）→ 忽略
        'wx_room@chatroom': { sent: 50, received: 50 }, // 群聊 → 忽略
        gh_service: { sent: 60, received: 60 },          // 公众号 → 忽略
        wx_manual: { sent: 70, received: 70 },           // 手动排除 → 忽略
        wx_internal: { sent: 80, received: 80 }          // 内部名单 → 忽略
      }
    }
    const block = computeAnnualReviewCommunication(period, inputs, { messageStats: stats, exclusions })
    ok('P1 未绑定/排除/结构性会话不得改变 D1（=2）', block.volume.value === 2 && block.volume.state === 'complete')
    ok('P1b D3 只用总体内分子分母（=0.5）', Math.abs((block.outboundRate.value as number) - 0.5) < 1e-12)
    ok('P1c 缺失绑定会话条目 = 区间无消息（合法零，不是失败）', block.volume.value === 2)

    // 总体顺序无关：调换 messageStats key 顺序 → 深相等
    const reversed = { ...stats, sessions: Object.fromEntries(Object.entries(stats.sessions).reverse()) }
    const blockRev = computeAnnualReviewCommunication(period, inputs, { messageStats: reversed, exclusions })
    ok('P1d messageStats key 顺序无关（D1/D3 深相等）', JSON.stringify(blockRev.volume) === JSON.stringify(block.volume) &&
      JSON.stringify(blockRev.outboundRate) === JSON.stringify(block.outboundRate))

    // D1/D2/D3 同一总体：D2=有沟通客户数（wx_a 1 人）；D1=2；D3=1/2
    ok('P1e D1/D2/D3 同一有效总体（D2=1）', block.contacted.value === 1)

    // 全部总体外 → 真实零（不是 unavailable）
    const onlyOutside = { ok: true, sessions: { unbound: { sent: 100, received: 100 } } }
    const blockOut = computeAnnualReviewCommunication(period, inputs, { messageStats: onlyOutside, exclusions })
    ok('P1f 总体外消息全部忽略 → D1 真实零 0', blockOut.volume.value === 0 && blockOut.volume.state === 'complete')
  }

  // ══ 组装层：D/E 进入完整报告 + validator + 隐私 ════════════════════════════
  {
    const facts: AnnualReviewFacts = {
      accounts: [
        accF(1, 'wx_a', { createdAt: T(2025, 2, 1), lastContactAtSec: Math.floor(T(2025, 10, 1) / 1000) }),
        accF(2, 'wx_b', { createdAt: T(2025, 3, 1) }),
        accF(3, 'wx_c', { createdAt: T(2025, 4, 1) }),
        accF(4, 'wx_d', { createdAt: T(2025, 5, 1) }),
        accF(5, 'wx_e', { createdAt: T(2025, 6, 1) }),
        accF(6, 'wx_f', { createdAt: T(2025, 7, 1) })
      ],
      contracts: [conF(1, 1, T(2026, 2, 1), 1000, '张三'), conF(2, 2, T(2026, 3, 1), 500, '李四')],
      allocations: [allocF(1, 1, 800.5, T(2026, 3, 1), '李四')],
      shippedEvents: [],
      assignments: [{ id: 1, leadId: 1, salesName: '张三', mode: 'manual', claimedAt: T(2026, 2, 2) }],
      leads: [{ id: 1, accountId: 1, firstContactedAt: T(2026, 2, 3) }],
      auditEvents: [
        auditF(1, 'lead_assign', T(2026, 1, 20), { salesName: '张三', mode: 'manual', assignmentId: 9 }),
        auditF(2, 'sync_apply', T(2026, 1, 25), { detailType: 'assign', salesName: '张三' })
      ]
    }
    const sales: AnnualReviewSalesSegmentsFacts = { profiles: [profF(1, 'wx_a', 'quoted', Math.floor(T(2025, 10, 1) / 1000))], intentEvents: [] }
    const report: AnnualReviewReport = composeAnnualReviewReport({
      period: resolveAnnualReviewPeriod(2026, GEN), facts, sales, crm: emptyCrm(),
      opts: { messageStats: { ok: true, sessions: { wx_a: { sent: 5, received: 2 } }, daily: { '2026-02-01': 7 } } }
    })
    ok('C1 D 组进入报告（D1=7、D3=5/7、月度趋势）', report.communication.volume.value === 7 &&
      Math.abs((report.communication.outboundRate.value as number) - 5 / 7) < 1e-12 &&
      report.communication.monthlyTrend.months?.some((m) => m.month === '2026-02' && m.count === 7) === true)
    ok('C2 D7 进入报告（无 sessionId 键）', report.communication.longSilent.value !== null &&
      !('sessionId' in (report.communication.longSilent.value?.[0] as object)))
    ok('C3 E 组进入报告（初始分配 1、缺口 partial、E3=1、贡献）', report.salesAssignment.assignedFacts.initialAssignments.total === 1 &&
      report.salesAssignment.coverage.status === 'partial' && report.salesAssignment.effectiveFollowup.value === 1 &&
      report.salesAssignment.creditedContribution.value?.[0].totalAmount === 800.5)
    ok('C4 报告过运行时校验', validateAnnualReviewReport(report, 2026).ok === true)
    ok('C5 coverage 35 键', Object.keys(report.coverage).length === 35)
    ok('C6 completeness 推导（communication/salesAssignment real blocks）', report.completeness.blocks.communication === 'partial' &&
      report.completeness.blocks.salesAssignment === 'partial')
    // 隐私：报告无 wxid/sessionId/路径/SQL
    const text = JSON.stringify(report)
    ok('C7 报告无 wxid/sessionId/路径/SQL', !text.includes('wx_a') && !text.includes('wx_b') && !text.includes('sessionId') &&
      !text.includes('.db') && !text.includes('SELECT'))

    // validator：D/E 形状非法被拒
    const leak = JSON.parse(JSON.stringify(report)) as { communication: { longSilent: { value: unknown } } }
    leak.communication.longSilent.value = [{ sessionId: 'wx_a', lastContactAtMs: 1, accountId: null, customerId: null, name: null }]
    ok('C8 D7 行泄漏 sessionId 被拒', validateAnnualReviewReport(leak, 2026).ok === false)
    const brokenKeys = JSON.parse(JSON.stringify(report)) as { coverage: Record<string, unknown> }
    delete brokenKeys.coverage['communication.volume']
    ok('C9 缺 D/E coverage key 被拒', validateAnnualReviewReport(brokenKeys, 2026).ok === false)
    const forged = JSON.parse(JSON.stringify(report)) as { completeness: { blocks: Record<string, string> } }
    forged.completeness.blocks.salesAssignment = 'complete'
    ok('C10 伪造 E 区块 completeness 被拒', validateAnnualReviewReport(forged, 2026).ok === false)

    // 顺序不变性（compose 级）
    const reversed = composeAnnualReviewReport({
      period: resolveAnnualReviewPeriod(2026, GEN),
      facts: {
        accounts: [...facts.accounts].reverse(), contracts: [...facts.contracts].reverse(), allocations: [...facts.allocations].reverse(), shippedEvents: [],
        assignments: [...facts.assignments].reverse(), leads: [...facts.leads].reverse(), auditEvents: [...facts.auditEvents].reverse()
      },
      sales: { profiles: [...sales.profiles].reverse(), intentEvents: [] }, crm: emptyCrm(),
      opts: { messageStats: { ok: true, sessions: { wx_a: { sent: 5, received: 2 } }, daily: { '2026-02-01': 7 } } }
    })
    ok('C11 逆序输入 → D/E 与聚合输出深相等', JSON.stringify(reversed.salesAssignment) === JSON.stringify(report.salesAssignment) &&
      JSON.stringify(reversed.communication) === JSON.stringify(report.communication) &&
      JSON.stringify(reversed.warnings) === JSON.stringify(report.warnings) &&
      JSON.stringify(reversed.completeness) === JSON.stringify(report.completeness))
  }
}

main().then(() => {
  console.log(`结果：${pass} 通过 / ${fail} 失败`)
  process.exit(fail > 0 ? 1 : 0)
}).catch((e) => {
  console.error('FATAL:', e)
  process.exit(1)
})
