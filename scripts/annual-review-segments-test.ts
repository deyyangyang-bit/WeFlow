/**
 * annual-review-segments-test.ts —— 年度经营复盘 B 组漏斗与 C 组客户分类护栏（S2）
 *
 * 覆盖（docs/设计-年度经营复盘-规格.md §4/§5.2/§5.3 + S2 任务验收 22 项）：
 *   1  shared/salesStage 中英文混存归一化        2  固定六桶及固定顺序
 *   3  current_year/all_time 当前快照            4  historical_year 不读取当前 stage
 *   5  历史重放（asOf 右开/同时间按 id/恰好 80%/低于 80% unavailable/分母 0 无 NaN）
 *   6  B3 同 session 重复进入同阶段只计一次      7  B3 不输出转化率
 *   8  B6 30 天边界 + 历史 unavailable           9  B7 流失前阶段/未知前序/商机原因空值
 *   10 C1 核销口径/legacy 回退/Top10/并列排序    11 C2 与 A2 数量一致
 *   12 C3/C4 sign_date 口径/缺失降级/年度复购    13 C5 与 A3 数量和状态完全一致
 *   14 C6 90 天边界                              15 C7 60 天边界和阶段排除
 *   16 C8 30 天边界、仅 current_year             17 同 session 多画像去重取最大 last_contact_at
 *   18 群聊/公众号/系统账号/manual/internal 排除 19 输入深冻结不被修改
 *   20 同输入及打乱行序输出一致                  21 loader 真实 sql.js 行为与字段规范化
 *   22 非法时间/金额/JSON detail 不崩溃并稳定降级
 *
 * 关键历史重放与覆盖率阈值用独立 oracle（逐会话过滤+排序取尾，与生产实现的
 * 全局分组重放为不同算法），并断言两者分布逐桶相等。
 * 运行：npx tsx scripts/annual-review-segments-test.ts
 */
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import initSqlJs from 'sql.js'
import {
  computeAnnualReviewSummary,
  loadAnnualReviewFacts,
  resolveAnnualReviewPeriod,
  sqlJsQueryRunner,
  type AnnualReviewFacts,
  type AnnualReviewMessageStats,
  type AnnualReviewPeriod
} from '../electron/services/annualReviewStats'
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
  loadAnnualReviewCrmSegments,
  loadAnnualReviewSalesSegments,
  type AnnualReviewSegmentInputs,
  type FunnelDistribution
} from '../electron/services/annualReviewSegments'
import { FUNNEL_ORDER, stageToFunnel, type FunnelStage } from '../shared/salesStage'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

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

function freezeDeep<T>(v: T): T {
  if (v && typeof v === 'object') {
    for (const k of Object.keys(v as object)) freezeDeep((v as Record<string, unknown>)[k])
    Object.freeze(v)
  }
  return v
}

function codesOf(warnings: Array<{ code: string }>): string[] {
  return warnings.map((w) => w.code)
}
function hasCode(warnings: Array<{ code: string }>, code: string): boolean {
  return warnings.some((w) => w.code === code)
}
function warnCount(warnings: Array<{ code: string; count?: number }>, code: string): number | undefined {
  return warnings.find((w) => w.code === code)?.count
}

// ── 基准时刻 ─────────────────────────────────────────────────────────────────
const T = (y: number, m: number, d: number, hh = 0, mm = 0, ss = 0, ms = 0): number =>
  new Date(y, m - 1, d, hh, mm, ss, ms).getTime()
const DAY = 86_400_000
const GEN = T(2026, 6, 15, 12, 0, 0)
const J2025 = T(2025, 1, 1)
const J2026 = T(2026, 1, 1)
const P2026 = resolveAnnualReviewPeriod(2026, GEN) // current_year，asOf=GEN
const P2025 = resolveAnnualReviewPeriod(2025, GEN) // historical_year，asOf=J2026
const PALL = resolveAnnualReviewPeriod(0, GEN)     // all_time，asOf=GEN

// ── 夹具构造 ─────────────────────────────────────────────────────────────────
const emptyInputs = (): AnnualReviewSegmentInputs => ({
  facts: { accounts: [], contracts: [], allocations: [], shippedEvents: [] },
  sales: { profiles: [], intentEvents: [] },
  crm: { opportunities: [], opportunityEvents: [] }
})

function withInputs(patch: Partial<AnnualReviewSegmentInputs>): AnnualReviewSegmentInputs {
  const base = emptyInputs()
  return {
    facts: { ...base.facts, ...(patch.facts ?? {}) },
    sales: { ...base.sales, ...(patch.sales ?? {}) },
    crm: { ...base.crm, ...(patch.crm ?? {}) }
  }
}

const prof = (id: number, sessionId: string | null, stage: string | null, lastContactAtSec: number | null = null) =>
  ({ id, sessionId, stage, lastContactAtSec })
const iev = (id: number, sessionId: string | null, stage: string | null, createdAt: number | null) =>
  ({ id, sessionId, stage, createdAt })
const oppF = (id: number, accountId: number | null, stage: string | null, status: string | null, createdAt: number | null) =>
  ({ id, accountId, stage, status, createdAt })
const oev = (id: number, opportunityId: number | null, eventType: string | null, stage: string | null, detail: string | null, createdAt: number | null) =>
  ({ id, opportunityId, eventType, stage, detail, createdAt })
const accF = (id: number, sessionId: string | null, extra: Partial<AnnualReviewFacts['accounts'][number]> = {}) =>
  ({ id, name: null, createdAt: T(2024, 1, 1), importedAt: null, sessionId, lastContactAtSec: null, ...extra })
const conF = (id: number, accountId: number | null, signDate: number | null, amount: number | null, status = 'signed', createdAt = T(2024, 1, 1)) =>
  ({ id, accountId, amount, status, signDate, createdAt })
const allocF = (
  id: number, accountId: number | null, creditedAmount: number | null,
  reconciledAt: number | null, status = 'confirmed', reconciliationStatus = 'allocated',
  confirmedAt: number | null = null, contractId: number | null = 1
) => ({ id, accountId, creditedAmount, reconciledAt, status, reconciliationStatus, confirmedAt, contractId })

function distCount(d: FunnelDistribution | null, bucket: FunnelStage): number {
  return d?.find((x) => x.bucket === bucket)?.count ?? -1
}

/** 断言分布：恒 6 桶、FUNNEL_ORDER 顺序、列出桶计数吻合且总数一致（未列桶必为 0） */
function distIs(name: string, d: FunnelDistribution | null, expected: Array<[FunnelStage, number]>): void {
  const shapeOk = d !== null && d.length === FUNNEL_ORDER.length &&
    FUNNEL_ORDER.every((b, i) => d[i] !== undefined && d[i].bucket === b)
  const countsOk = d !== null &&
    expected.every(([b, c]) => distCount(d, b) === c) &&
    d.reduce((s, x) => s + x.count, 0) === expected.reduce((s, x) => s + x[1], 0)
  ok(name, shapeOk && countsOk)
}

// ── 独立 oracle（与生产实现不同算法：逐会话过滤 + 排序取尾） ─────────────────
type RawIntentEvent = { id: number; sessionId: string | null; stage: string | null; createdAt: number | null }

function oracleLastStageRaw(events: RawIntentEvent[], sid: string, asOf: number): string | null {
  const evs: RawIntentEvent[] = []
  for (const e of events) {
    if ((e.sessionId ?? '') !== sid) continue
    if (e.createdAt === null || !Number.isFinite(e.createdAt) || e.createdAt >= asOf) continue
    evs.push(e)
  }
  if (evs.length === 0) return null
  evs.sort((a, b) => (a.createdAt as number) - (b.createdAt as number) || a.id - b.id)
  return evs[evs.length - 1].stage
}

function oracleDistribution(sids: string[], events: RawIntentEvent[], asOf: number): FunnelDistribution {
  const counts = new Map<FunnelStage, number>(FUNNEL_ORDER.map((b) => [b, 0]))
  for (const sid of sids) {
    const raw = oracleLastStageRaw(events, sid, asOf)
    const b: FunnelStage = raw === null ? '未知' : stageToFunnel(raw)
    counts.set(b, (counts.get(b) ?? 0) + 1)
  }
  return FUNNEL_ORDER.map((b) => ({ bucket: b, count: counts.get(b) ?? 0 }))
}

function oracleCovered(sids: string[], events: RawIntentEvent[], asOf: number): number {
  let covered = 0
  for (const sid of sids) if (oracleLastStageRaw(events, sid, asOf) !== null) covered++
  return covered
}

function main(): void {
  const allComputations = (inputs: AnnualReviewSegmentInputs, opts?: Parameters<typeof computeAnnualReviewCustomerStageDistribution>[2]) => ({
    b1: computeAnnualReviewCustomerStageDistribution(P2025, inputs, opts),
    b2: computeAnnualReviewOpportunityStageDistribution(P2025, inputs, opts),
    b3: computeAnnualReviewStageFlow(P2025, inputs, opts),
    b6: computeAnnualReviewStuckCustomers(P2025, inputs, opts),
    b7: computeAnnualReviewLostBreakdown(P2025, inputs, opts),
    c1: computeAnnualReviewHighValueCustomers(P2025, inputs, opts),
    c2: computeAnnualReviewNewCustomerDetails(P2025, inputs, opts),
    c3: computeAnnualReviewDealingCustomers(P2025, inputs, opts),
    c4: computeAnnualReviewRepeatCustomers(P2025, inputs, opts),
    c5: computeAnnualReviewActiveCustomerDetails(P2025, inputs, opts),
    c6: computeAnnualReviewSilentCustomers(P2025, inputs, opts),
    c7: computeAnnualReviewRiskCustomers(P2025, inputs, opts),
    c8: computeAnnualReviewCurrentPriorityCustomers(P2025, inputs, opts)
  })

  // ══ 1 中英文混存归一化（经 B1 当前快照全链路） ═══════════════════════════
  {
    const sessionIds = [
      's_cn_quote', 's_en_quote', 's_cn_contact', 's_en_contact', 's_cn_nego', 's_en_nego',
      's_en_won', 's_cn_won', 's_cn_lost', 's_en_dormant', 's_garbage', 's_empty'
    ]
    const inputs = withInputs({
      facts: { accounts: sessionIds.map((s, i) => accF(i + 1, s)) },
      sales: {
        profiles: [
          prof(1, 's_cn_quote', '比价'), prof(2, 's_en_quote', 'quoted'),
          prof(3, 's_cn_contact', '已沟通'), prof(4, 's_en_contact', 'contacted'),
          prof(5, 's_cn_nego', '谈判中'), prof(6, 's_en_nego', 'negotiating'),
          prof(7, 's_en_won', 'won'), prof(8, 's_cn_won', '成交'),
          prof(9, 's_cn_lost', '流失'), prof(10, 's_en_dormant', 'dormant'),
          prof(11, 's_garbage', '随便什么'), prof(12, 's_empty', '')
        ],
        intentEvents: []
      }
    })
    const r = computeAnnualReviewCustomerStageDistribution(P2026, inputs)
    distIs('1 中英混存归一化（B1 当前快照）', r.distribution, [
      ['了解', 2], ['比价', 2], ['决策', 2], ['成交', 2], ['流失', 2], ['未知', 2]
    ])
  }

  // ══ 2 固定六桶及固定顺序 ═════════════════════════════════════════════════
  {
    const empty = emptyInputs()
    const b1 = computeAnnualReviewCustomerStageDistribution(P2026, empty)
    const b2 = computeAnnualReviewOpportunityStageDistribution(P2026, empty)
    const b3 = computeAnnualReviewStageFlow(P2026, empty)
    const expected = FUNNEL_ORDER.map((b) => ({ bucket: b, count: 0 }))
    eq('2 空输入 B1 固定六桶零值', b1.distribution, expected)
    eq('2b 空输入 B2 固定六桶零值', b2.distribution, expected)
    eq('2c 空输入 B3 固定六桶零值', b3.distribution, expected)
    eq('2d 桶顺序 = FUNNEL_ORDER', (b1.distribution as FunnelDistribution).map((x) => x.bucket), [...FUNNEL_ORDER])
  }

  // ══ 3 current_year / all_time 当前快照 ═══════════════════════════════════
  {
    const inputs = withInputs({
      facts: { accounts: [accF(1, 'wx_a')] },
      sales: { profiles: [prof(1, 'wx_a', 'quoted')], intentEvents: [] }
    })
    for (const [label, p] of [['current_year', P2026], ['all_time', PALL]] as Array<[string, AnnualReviewPeriod]>) {
      const b1 = computeAnnualReviewCustomerStageDistribution(p, inputs)
      ok(`3 ${label} B1 kind=current_snapshot`, b1.kind === 'current_snapshot')
      ok(`3b ${label} B1 coverage=snapshot_only`, b1.coverage.status === 'snapshot_only')
      ok(`3c ${label} B1 reasonCodes=current_snapshot_projection`, hasCode(b1.warnings, 'current_snapshot_projection'))
      ok(`3d ${label} B1 rows=总体1`, b1.coverage.rows === 1)
      const b2 = computeAnnualReviewOpportunityStageDistribution(p, withInputs({
        crm: { opportunities: [oppF(1, 1, '了解', 'active', T(2024, 1, 1))], opportunityEvents: [] }
      }))
      ok(`3e ${label} B2 snapshot_only + current_snapshot`, b2.kind === 'current_snapshot' && b2.coverage.status === 'snapshot_only')
    }
  }

  // ══ 4 historical_year 不读取当前 stage ═══════════════════════════════════
  {
    const inputs = withInputs({
      facts: { accounts: [accF(1, 'wx_a')] },
      sales: {
        profiles: [prof(1, 'wx_a', 'won')], // 当前投影 = 成交
        intentEvents: [
          iev(1, 'wx_a', 'quoted', T(2025, 3, 1)),
          iev(2, 'wx_a', 'negotiating', T(2025, 5, 1))
        ]
      }
    })
    const hist = computeAnnualReviewCustomerStageDistribution(P2025, inputs)
    distIs('4 历史年度按事件重放（决策），不读当前 stage(won)', hist.distribution, [['决策', 1]])
    ok('4b 历史重建 kind + partial（不宣称 complete）', hist.kind === 'historical_reconstruction' && hist.coverage.status === 'partial')
    ok('4c 历史重建 reasonCodes 含 history_reconstruction_not_complete', hasCode(hist.warnings, 'history_reconstruction_not_complete'))
    const cur = computeAnnualReviewCustomerStageDistribution(P2026, inputs)
    distIs('4d 当前快照读当前投影（成交）', cur.distribution, [['成交', 1]])

    // B2：当前 stage/status 不进入历史重放；created 事件提供初始阶段
    const oppInputs = withInputs({
      crm: {
        opportunities: [oppF(1, 1, '决策', 'active', T(2024, 6, 1))],
        opportunityEvents: [oev(1, 1, 'created', '了解', 'AI 识别采购信号', T(2025, 2, 1))]
      }
    })
    const histOpp = computeAnnualReviewOpportunityStageDistribution(P2025, oppInputs)
    distIs('4e B2 历史按事件重放（了解），不读当前 stage(决策)', histOpp.distribution, [['了解', 1]])
    const curOpp = computeAnnualReviewOpportunityStageDistribution(P2026, oppInputs)
    distIs('4f B2 当前快照读当前投影（决策）', curOpp.distribution, [['决策', 1]])
  }

  // ══ 5 历史事件重放细节 + 覆盖率阈值（oracle 对拍） ═══════════════════════
  {
    // 5a asOf 时刻事件不计（右开）；此前最后事件生效
    const boundary = withInputs({
      facts: { accounts: [accF(1, 'wx_a')] },
      sales: {
        profiles: [prof(1, 'wx_a', null)],
        intentEvents: [
          iev(1, 'wx_a', 'quoted', T(2025, 3, 1)),
          iev(2, 'wx_a', 'won', J2026) // 恰好 asOf → 不计入 2025
        ]
      }
    })
    const rb = computeAnnualReviewCustomerStageDistribution(P2025, boundary)
    distIs('5a asOf 时刻事件不计入历史年度', rb.distribution, [['比价', 1]])
    const rbAll = computeAnnualReviewCustomerStageDistribution(PALL, boundary)
    distIs('5b all_time B1 同为当前快照（当前 stage null → 未知），不做事件重放', rbAll.distribution, [['未知', 1]])
    ok('5b2 all_time B1 kind=snapshot_only', rbAll.kind === 'current_snapshot' && rbAll.coverage.status === 'snapshot_only')

    // 5c 同时间按 id 升序（id 大者生效）
    const tieAB = withInputs({
      facts: { accounts: [accF(1, 'wx_a')] },
      sales: {
        profiles: [prof(1, 'wx_a', null)],
        intentEvents: [
          iev(1, 'wx_a', 'quoted', T(2025, 4, 1)),
          iev(2, 'wx_a', 'negotiating', T(2025, 4, 1))
        ]
      }
    })
    distIs('5c 同时间 id 升序：id=2 生效（决策）',
      computeAnnualReviewCustomerStageDistribution(P2025, tieAB).distribution, [['决策', 1]])
    const tieBA = withInputs({
      facts: { accounts: [accF(1, 'wx_a')] },
      sales: {
        profiles: [prof(1, 'wx_a', null)],
        intentEvents: [
          iev(2, 'wx_a', 'quoted', T(2025, 4, 1)),
          iev(1, 'wx_a', 'negotiating', T(2025, 4, 1))
        ]
      }
    })
    distIs('5d 同时间 id 升序：交换 id 后 id=2 生效（比价）',
      computeAnnualReviewCustomerStageDistribution(P2025, tieBA).distribution, [['比价', 1]])

    // 5e 恰好 80%（4/5）允许重建；未覆盖会话归未知；与 oracle 逐桶对拍
    const sids5 = ['s1', 's2', 's3', 's4', 's5']
    const events5: RawIntentEvent[] = [
      iev(1, 's1', 'quoted', T(2025, 2, 1)),
      iev(2, 's2', 'negotiating', T(2025, 3, 1)),
      iev(3, 's3', 'won', T(2025, 4, 1)),
      iev(4, 's4', 'lost', T(2025, 5, 1))
      // s5 无事件 → 未覆盖
    ]
    const inputs5 = withInputs({
      facts: { accounts: sids5.map((s, i) => accF(i + 1, s)) },
      sales: { profiles: [], intentEvents: events5 }
    })
    const r80 = computeAnnualReviewCustomerStageDistribution(P2025, inputs5)
    ok('5e 恰好 80% 允许重建（partial）', r80.coverage.status === 'partial' && r80.distribution !== null)
    ok('5f coverageRatio=4/5 且 exactCoverage', r80.coverage.coverageRatio === 4 / 5 && r80.coverage.exactCoverage === true)
    eq('5g 重建分布 = oracle', r80.distribution, oracleDistribution(sids5, events5, J2026))
    ok('5h oracle 覆盖数 = 4', oracleCovered(sids5, events5, J2026) === 4)

    // 5i 100% 覆盖也只 partial（不宣称 complete）
    const events5full: RawIntentEvent[] = [...events5, iev(5, 's5', 'contacted', T(2025, 6, 1))]
    const r100 = computeAnnualReviewCustomerStageDistribution(P2025, withInputs({
      facts: { accounts: sids5.map((s, i) => accF(i + 1, s)) },
      sales: { profiles: [], intentEvents: events5full }
    }))
    ok('5i 100% 覆盖仍 partial + history_reconstruction_not_complete',
      r100.coverage.status === 'partial' && hasCode(r100.warnings, 'history_reconstruction_not_complete') &&
      r100.coverage.coverageRatio === 1)
    eq('5j 100% 分布 = oracle', r100.distribution, oracleDistribution(sids5, events5full, J2026))

    // 5k 低于 80%（3/5=0.6、3/4=0.75）→ unavailable + history_not_reconstructable
    const events3of5: RawIntentEvent[] = events5.slice(0, 3)
    const r60 = computeAnnualReviewCustomerStageDistribution(P2025, withInputs({
      facts: { accounts: sids5.map((s, i) => accF(i + 1, s)) },
      sales: { profiles: [], intentEvents: events3of5 }
    }))
    ok('5k 60% → unavailable + distribution=null', r60.coverage.status === 'unavailable' && r60.distribution === null)
    ok('5l reasonCodes 含 history_not_reconstructable + history_coverage_below_threshold',
      hasCode(r60.warnings, 'history_not_reconstructable') && hasCode(r60.warnings, 'history_coverage_below_threshold'))
    ok('5m coverageRatio=0.6', r60.coverage.coverageRatio === 3 / 5)
    const sids4 = ['s1', 's2', 's3', 's4']
    const r75 = computeAnnualReviewCustomerStageDistribution(P2025, withInputs({
      facts: { accounts: sids4.map((s, i) => accF(i + 1, s)) },
      sales: { profiles: [], intentEvents: events5.slice(0, 3) }
    }))
    ok('5n 75%（低于阈值）→ unavailable', r75.coverage.status === 'unavailable' && r75.distribution === null)

    // 5o 分母 0：empty-zero 空结果，coverageRatio=null，无 NaN/Infinity
    const rEmpty = computeAnnualReviewCustomerStageDistribution(P2025, emptyInputs())
    distIs('5o 分母 0 → 空六桶', rEmpty.distribution, [])
    ok('5p 分母 0 coverageRatio=null 且非 NaN', rEmpty.coverage.coverageRatio === null &&
      rEmpty.coverage.exactCoverage === false && !Number.isNaN(rEmpty.coverage.coverageRatio ?? 0))
    ok('5q 分母 0 reasonCodes 含 history_population_empty', hasCode(rEmpty.warnings, 'history_population_empty'))
    const oppEmpty = computeAnnualReviewOpportunityStageDistribution(P2025, emptyInputs())
    distIs('5r B2 分母 0 → 空六桶', oppEmpty.distribution, [])
    ok('5s B2 分母 0 coverageRatio=null', oppEmpty.coverage.coverageRatio === null)

    // 5t B2 重放：stage_change 链 + won 终态 + 终态后事件忽略 + asOf 右开
    const oppReplay = withInputs({
      crm: {
        opportunities: [
          oppF(1, 1, null, 'active', T(2024, 6, 1)),
          oppF(2, 2, null, 'active', T(2024, 6, 1)),
          oppF(3, 3, null, 'active', T(2024, 6, 1)),
          oppF(4, 4, null, 'active', J2026) // asOf 当刻创建 → 不入分母
        ],
        opportunityEvents: [
          oev(1, 1, 'created', '了解', '', T(2025, 1, 15)),
          oev(2, 1, 'stage_change', '比价', 'ai：了解 → 比价', T(2025, 3, 1)),
          oev(3, 1, 'stage_change', '决策', 'ai：比价 → 决策', T(2025, 5, 1)),
          oev(4, 2, 'stage_change', '比价', '', T(2025, 2, 1)),
          oev(5, 2, 'won', '比价', '人工登记成交', T(2025, 6, 1)),
          oev(6, 2, 'stage_change', '决策', '越权变更', T(2025, 7, 1)), // 终态后忽略
          oev(7, 3, 'created', '了解', '', T(2025, 8, 1)),
          oev(8, 3, 'lost', '了解', '客户明确不买了', T(2025, 9, 1)),
          oev(9, 4, 'created', '了解', '', T(2025, 12, 31)) // 属于 asOf 后创建的商机 → 总体外
        ]
      }
    })
    const rOpp = computeAnnualReviewOpportunityStageDistribution(P2025, oppReplay)
    distIs('5t B2 重放：stage_change 链/won 终态/lost/asOf 后创建不入总体',
      rOpp.distribution, [['决策', 1], ['成交', 1], ['流失', 1]])
    ok('5u B2 分母 3（asOf 当刻创建的不算）且 ratio=1', rOpp.coverage.rows === 3 && rOpp.coverage.coverageRatio === 1)
    ok('5v B2 历史恒带 opportunity_tombstone_gap', hasCode(rOpp.warnings, 'opportunity_tombstone_gap'))
  }

  // ══ 6/7 B3 阶段流转 ══════════════════════════════════════════════════════
  {
    const inputs = withInputs({
      facts: { accounts: [accF(1, 's1'), accF(2, 's2'), accF(3, 's3')] },
      sales: {
        profiles: [],
        intentEvents: [
          iev(1, 's1', 'contacted', T(2025, 1, 2)),
          iev(2, 's1', 'quoted', T(2025, 2, 1)),
          iev(3, 's1', 'contacted', T(2025, 3, 1)), // 重复进入了解 → 只计一次
          iev(4, 's1', 'contacted', T(2024, 6, 1)), // 区间外 → 不计
          iev(5, 's2', 'negotiating', T(2025, 2, 2)),
          iev(6, 's2', 'negotiating', T(2025, 4, 2)), // 同桶重复 → 仍 1
          iev(7, 's3', 'won', J2026)                  // asOf 时刻 → 不计 → s3 未覆盖
        ]
      }
    })
    const r = computeAnnualReviewStageFlow(P2025, inputs)
    distIs('6 B3 同 session 重复进入同阶段只计一次', r.distribution, [
      ['了解', 1], ['比价', 1], ['决策', 1]
    ])
    ok('6b B3 覆盖率 = 2/3（s3 无区间内事件）', r.coverage.coverageRatio === 2 / 3 && r.coverage.rows === 3)
    ok('6c B3 恒 partial + stage_flow_low_coverage', r.coverage.status === 'partial' && hasCode(r.warnings, 'stage_flow_low_coverage'))
    ok('7 B3 不输出转化率（无 conversion 字段，仅分布+coverage+warnings）',
      !('conversionRates' in r) && !('conversion' in r) && !('rates' in r) &&
      Object.keys(r).sort().join(',') === 'coverage,distribution,warnings')
    // 历史年度与当前年度同一逻辑（仅区间不同）
    const rCur = computeAnnualReviewStageFlow(P2026, withInputs({
      facts: { accounts: [accF(1, 's1')] },
      sales: { profiles: [], intentEvents: [iev(1, 's1', 'quoted', T(2026, 2, 1)), iev(2, 's1', 'quoted', T(2026, 3, 1))] }
    }))
    distIs('7b B3 当前年度同口径', rCur.distribution, [['比价', 1]])
  }

  // ══ 8 B6 停滞客户 ════════════════════════════════════════════════════════
  {
    const sec = (ms: number): number => Math.floor(ms / 1000)
    const inputs = withInputs({
      sales: {
        profiles: [
          prof(1, 's_exact', 'negotiating', sec(GEN - 30 * DAY)),      // 恰好 30 天 → 不算
          prof(2, 's_over', 'quoted', sec(GEN - 30 * DAY) - 1),        // 30 天+1 秒 → 算
          prof(3, 's_over2', 'contacted', sec(GEN - 31 * DAY)),        // 算
          prof(4, 's_won', 'won', sec(GEN - 40 * DAY)),                // 阶段不符 → 不算
          prof(5, 's_nolc', 'quoted', null)                            // 缺 last_contact_at → 排除+告警
        ],
        intentEvents: []
      }
    })
    const r = computeAnnualReviewStuckCustomers(P2026, inputs)
    ok('8 B6 30 天边界（恰好不算，超过算）', r.value === 2)
    ok('8b B6 恒 partial + last_contact_fallback', r.coverage.status === 'partial' && hasCode(r.warnings, 'last_contact_fallback'))
    ok('8c 缺 last_contact_at 排除并告警（不伪造停滞）', warnCount(r.warnings, 'last_contact_missing') === 1)
    const rh = computeAnnualReviewStuckCustomers(P2025, inputs)
    ok('8d 历史年度 unavailable/null', rh.value === null && rh.coverage.status === 'unavailable' && hasCode(rh.warnings, 'history_not_reconstructable'))
    const ra = computeAnnualReviewStuckCustomers(PALL, inputs)
    ok('8e all_time 可算（同当前口径）', ra.value === 2 && ra.coverage.status === 'partial')
  }

  // ══ 9 B7 流失归因 ════════════════════════════════════════════════════════
  {
    const inputs = withInputs({
      facts: { accounts: [accF(1, 's_lost1'), accF(2, 's_lost2'), accF(3, 's_won')] },
      sales: {
        profiles: [
          prof(1, 's_lost1', 'lost'),
          prof(2, 's_lost2', '流失'),   // 中文 canonical 归一化
          prof(3, 's_won', 'won')       // 非 lost → 不处理
        ],
        intentEvents: [
          iev(1, 's_lost1', 'contacted', T(2025, 2, 1)),
          iev(2, 's_lost1', 'quoted', T(2025, 3, 1)),
          iev(3, 's_lost1', 'lost', T(2025, 4, 1)),   // 前序 = 比价
          iev(4, 's_lost2', 'lost', T(2025, 5, 1)),   // 无前序 → 未知
          iev(5, 's_won', 'won', T(2025, 6, 1))
        ]
      },
      crm: {
        opportunityEvents: [
          oev(1, 1, 'lost', '决策', '价格太贵', T(2025, 3, 1)),
          oev(2, 2, 'lost', '比价', '   ', T(2025, 4, 1)),          // 空白 → 未填写原因
          oev(3, 3, 'lost', '决策', '价格太贵', T(2025, 5, 1)),
          oev(4, 4, 'lost', '决策', '预算不足', T(2024, 12, 31)),   // asOf 前全部计入
          oev(5, 5, 'lost', '决策', '未来事件', J2026)               // asOf 时刻 → 不计
        ]
      }
    })
    const r = computeAnnualReviewLostBreakdown(P2026, inputs)
    distIs('9 B7 客户流失前阶段（比价/未知），won 不处理', r.customerPreviousStage, [['比价', 1], ['未知', 1]])
    eq('9b B7 商机原因：count 降序、原因升序（code-unit）、空白归未填写',
      r.opportunityReasons, [{ reason: '价格太贵', count: 2 }, { reason: '未填写原因', count: 1 }, { reason: '未来事件', count: 1 }, { reason: '预算不足', count: 1 }])
    ok('9c 当前年度 kind=current_snapshot + snapshot_only', r.kind === 'current_snapshot' && r.coverage.status === 'snapshot_only')

    // 历史年度：重放最终 lost 才处理 + 覆盖率门槛
    const rHist = computeAnnualReviewLostBreakdown(P2025, inputs)
    distIs('9d 历史重放流失归因', rHist.customerPreviousStage, [['比价', 1], ['未知', 1]])
    ok('9e 历史 kind=historical_reconstruction + partial', rHist.kind === 'historical_reconstruction' && rHist.coverage.status === 'partial')
    eq('9f 历史商机原因同口径（asOf=J2026 前全部）', rHist.opportunityReasons,
      [{ reason: '价格太贵', count: 2 }, { reason: '未填写原因', count: 1 }, { reason: '预算不足', count: 1 }])

    // 覆盖率不足 → 整项 unavailable（两个分布都不输出）
    const thinInputs = withInputs({
      facts: { accounts: [accF(1, 's_lost1'), accF(2, 's_lost2'), accF(3, 's_extra'), accF(4, 's_extra2'), accF(5, 's_extra3')] },
      sales: {
        profiles: [],
        intentEvents: [
          iev(1, 's_lost1', 'quoted', T(2025, 3, 1)),
          iev(2, 's_lost1', 'lost', T(2025, 4, 1)),
          iev(3, 's_lost2', 'lost', T(2025, 5, 1))
        ]
      }
    })
    const rThin = computeAnnualReviewLostBreakdown(P2025, thinInputs)
    ok('9g 会话覆盖 2/5 → B7 整项 unavailable', rThin.coverage.status === 'unavailable' &&
      rThin.customerPreviousStage === null && rThin.opportunityReasons === null)
    ok('9h 不可重建 reasonCodes', hasCode(rThin.warnings, 'history_not_reconstructable'))
  }

  // ══ 10 C1 高价值客户 ═════════════════════════════════════════════════════
  {
    const names = (id: number): string => `客户${id}`
    const accounts = Array.from({ length: 14 }, (_, i) => accF(i + 1, `s${i + 1}`, { name: names(i + 1) }))
    const contracts = [
      conF(1, 1, T(2025, 2, 1), 120), conF(2, 1, T(2025, 3, 1), 80),   // a1 年度合同 200
      conF(3, 2, T(2025, 2, 1), 300),                                   // a2 300
      conF(4, 3, T(2025, 2, 1), 100)                                    // a3 100
    ]
    const allocations = [
      allocF(1, 1, 100, T(2025, 3, 1)), allocF(2, 1, 50, T(2025, 4, 1)),   // a1 = 150
      allocF(3, 2, 150, T(2025, 3, 2)),                                      // a2 = 150
      allocF(4, 3, 150, T(2025, 3, 3)),                                      // a3 = 150
      allocF(5, 4, 200, T(2025, 3, 4)),                                      // a4 = 200（第一）
      allocF(6, 5, 80, T(2025, 3, 5)),                                       // a5 = 80
      allocF(7, 6, 60, null, 'confirmed', 'legacy_confirmed', T(2025, 3, 6)),// a6 = 60（legacy 回退）
      allocF(8, 7, 500, T(2025, 3, 7), 'confirmed', 'pending'),              // 认领不计
      ...Array.from({ length: 8 }, (_, i) => allocF(20 + i, 7 + i, 10, T(2025, 5, 1 + i))) // a7..a14 各 10
    ]
    const inputs = withInputs({ facts: { accounts, contracts, allocations } })
    const r = computeAnnualReviewHighValueCustomers(P2025, inputs)
    ok('10 C1 Top 10（14 个核销客户只出 10）', r.value.length === 10)
    eq('10b C1 前六排序：金额降序 → 年度合同金额降序 → accountId 升序',
      r.value.slice(0, 6).map((x) => [x.accountId, x.creditedAmount, x.contractAmount]), [
        [4, 200, 0], [2, 150, 300], [1, 150, 200], [3, 150, 100], [5, 80, 0], [6, 60, 0]
      ])
    eq('10c C1 并列尾部按 accountId 升序切到 10', r.value.slice(6).map((x) => x.accountId), [7, 8, 9, 10])
    ok('10d C1 legacy 回退 → partial + legacy_time_fallback',
      r.coverage.status === 'partial' && hasCode(r.warnings, 'legacy_time_fallback'))
    ok('10e C1 名称来自 account.name', r.value[0].name === '客户4' && r.value[1].name === '客户2')
    ok('10f C1 认领（confirmed+pending）不计入', !r.value.some((x) => x.accountId === 0) && r.value.every((x) => x.creditedAmount < 500))
    // A6 口径一致性：同 facts 的 A6 = C1 全量 credited 之和（无缺失 account 行）
    const a6 = computeAnnualReviewSummary(P2025, inputs.facts)
    const c1Total = [...r.value.map((x) => x.creditedAmount), 0].reduce((s, v) => s + v, 0)
      + Array.from({ length: 4 }, (_, i) => 10).reduce((s, v) => s + v, 0) // 被截断的 a11..a14
    ok('10g C1 聚合与 A6 同口径（Top10 之和 + 截断部分 = A6）', c1Total === (a6.creditedAmount.value ?? -1))
  }

  // ══ 11 C2 与 A2 数量一致 ═════════════════════════════════════════════════
  {
    const accounts = [
      accF(1, null, { createdAt: T(2025, 1, 2), importedAt: T(2025, 1, 3), name: '甲' }),
      accF(2, null, { createdAt: T(2025, 1, 2), importedAt: null, name: '乙' }),
      accF(3, null, { createdAt: J2026, name: '丙' }),            // 右边界 → 不计
      accF(4, null, { createdAt: T(2024, 6, 1), name: '丁' }),    // 往年 → 不计
      accF(5, null, { createdAt: null, name: '戊' })              // 缺 created_at → 排除+告警
    ]
    const facts: AnnualReviewFacts = { accounts, contracts: [], allocations: [], shippedEvents: [] }
    const summary = computeAnnualReviewSummary(P2025, facts)
    const r = computeAnnualReviewNewCustomerDetails(P2025, withInputs({ facts }))
    ok('11 C2 数量 = A2 customerNew.value', r.value.length === (summary.customerNew.value ?? -1) && r.value.length === 2)
    eq('11b C2 排序：同 createdAt 并列 accountId 升序；imported 标记',
      r.value, [
        { accountId: 1, name: '甲', createdAt: T(2025, 1, 2), imported: true },
        { accountId: 2, name: '乙', createdAt: T(2025, 1, 2), imported: false }
      ])
    ok('11c C2 缺 created_at 告警与 A2 一致', warnCount(r.warnings, 'account_created_at_missing') === 1)
    // 同 createdAt 并列 accountId 升序已覆盖；跨 ts 降序：
    const rMulti = computeAnnualReviewNewCustomerDetails(P2025, withInputs({
      facts: {
        accounts: [
          accF(1, null, { createdAt: T(2025, 5, 1), name: 'a' }),
          accF(2, null, { createdAt: T(2025, 2, 1), name: 'b' })
        ], contracts: [], allocations: [], shippedEvents: []
      }
    }))
    eq('11d C2 createdAt 降序', rMulti.value.map((x) => x.accountId), [1, 2])
  }

  // ══ 12 C3/C4 成交与复购 ══════════════════════════════════════════════════
  {
    const contracts = [
      conF(1, 1, T(2025, 2, 1), 300),          // a1 年度第 1 单
      conF(2, 1, T(2025, 6, 1), 100),          // a1 年度第 2 单 → 复购
      conF(3, 2, T(2025, 3, 1), 500),          // a2 年度 1 单
      conF(4, 2, T(2024, 3, 1), 900),          // a2 历史累计第 2 单 → 不算复购
      conF(5, 3, null, 700, 'signed', T(2025, 4, 1)),  // created_at 在范围内但无 sign_date → 不计
      conF(6, null, T(2025, 5, 1), 50),        // 无主合同 → 排除+告警
      conF(7, 1, T(2025, 7, 1), null)          // a1 第 3 单、金额非法 → 计数不含金额
    ]
    const accounts = [accF(1, 's1', { name: '甲' }), accF(2, 's2', { name: '乙' })]
    const inputs = withInputs({ facts: { accounts, contracts } })
    const r3 = computeAnnualReviewDealingCustomers(P2025, inputs)
    eq('12 C3 按年度 sign_date 集合聚合（金额降序→accountId）',
      r3.value.map((x) => [x.accountId, x.contractCount, x.contractAmount, x.firstSignDate]), [
        [2, 1, 500, T(2025, 3, 1)],
        [1, 3, 400, T(2025, 2, 1)]
      ])
    ok('12b C3 缺失降级：sign_date_missing + contract_account_missing + 金额非法',
      hasCode(r3.warnings, 'sign_date_missing') && hasCode(r3.warnings, 'contract_account_missing') &&
      hasCode(r3.warnings, 'contract_amount_invalid') && r3.coverage.status === 'partial')
    const r4 = computeAnnualReviewRepeatCustomers(P2025, inputs)
    eq('12c C4 年度复购（≥2 单/年，非历史累计）', r4.value.map((x) => [x.accountId, x.contractCount]), [[1, 3]])
    ok('12d C4 继承 C3 同一 warnings', codesOf(r4.warnings).join(',') === codesOf(r3.warnings).join(','))
    // 复购排序：合同数降序 → 金额降序 → accountId 升序
    const r4multi = computeAnnualReviewRepeatCustomers(P2025, withInputs({
      facts: {
        accounts: [accF(1), accF(2), accF(3)],
        contracts: [
          conF(1, 1, T(2025, 2, 1), 100), conF(2, 1, T(2025, 3, 1), 100),
          conF(3, 2, T(2025, 2, 1), 50), conF(4, 2, T(2025, 3, 1), 600),
          conF(5, 3, T(2025, 2, 1), 900)
        ], allocations: [], shippedEvents: []
      }
    }))
    eq('12e C4 排序：2 单组金额降序（a2 650 > a1 200），1 单的 a3 不入选',
      r4multi.value.map((x) => x.accountId), [2, 1])
  }

  // ══ 13 C5 与 A3 完全一致 ═════════════════════════════════════════════════
  {
    const facts: AnnualReviewFacts = {
      accounts: [
        accF(1, 'wx_a', { lastContactAtSec: Math.floor(T(2026, 3, 1) / 1000) }),
        accF(2, 'wx_b', { lastContactAtSec: Math.floor(T(2026, 5, 1) / 1000) }),
        accF(3, 'wx_c', { lastContactAtSec: Math.floor(T(2024, 6, 1) / 1000) })
      ],
      contracts: [], allocations: [], shippedEvents: []
    }
    const inputs = withInputs({ facts })
    // 主口径
    const msOk: AnnualReviewMessageStats = { ok: true, sessions: { wx_a: { sent: 1, received: 0 }, wx_c: { sent: 0, received: 9 } } }
    const a3ok = computeAnnualReviewSummary(P2025, facts, { messageStats: msOk }).customerActive
    const c5ok = computeAnnualReviewActiveCustomerDetails(P2025, inputs, { messageStats: msOk })
    ok('13 C5=A3 主口径（值/状态/会话列表）',
      c5ok.value !== null && c5ok.value.map((x) => x.sessionId).join(',') === 'wx_a,wx_c' &&
      c5ok.coverage.status === a3ok.state && c5ok.value.length === (a3ok.value ?? -1))
    // 回退口径（当前年度）
    const a3fb = computeAnnualReviewSummary(P2026, facts, { messageStats: { ok: false, sessions: {} } }).customerActive
    const c5fb = computeAnnualReviewActiveCustomerDetails(P2026, inputs, { messageStats: { ok: false, sessions: {} } })
    ok('13b C5=A3 回退（值/状态/partial）',
      c5fb.value !== null && c5fb.value.length === (a3fb.value ?? -1) &&
      c5fb.coverage.status === a3fb.state && c5fb.coverage.status === 'partial' && c5fb.value.length === 2)
    // 历史年度 WCDB 失败 → 双双 unavailable
    const a3h = computeAnnualReviewSummary(P2025, facts, { messageStats: { ok: false, sessions: {} } }).customerActive
    const c5h = computeAnnualReviewActiveCustomerDetails(P2025, inputs, { messageStats: { ok: false, sessions: {} } })
    ok('13c C5=A3 历史失败 unavailable（value=null，不回退当前 last_contact_at）',
      c5h.value === null && a3h.value === null && c5h.coverage.status === 'unavailable' && a3h.state === 'unavailable')
  }

  // ══ 14 C6 沉默客户 90 天边界 ══════════════════════════════════════════════
  {
    const sec = (ms: number): number => Math.floor(ms / 1000)
    const inputs = withInputs({
      sales: {
        profiles: [
          prof(1, 's_exact', 'contacted', sec(GEN - 90 * DAY)),       // 恰好 90 天 → 不算
          prof(2, 's_over', 'quoted', sec(GEN - 90 * DAY) - 1),       // 算
          prof(3, 's_no_lc', 'contacted', null)                       // 无 last_contact_at → 不算
        ],
        intentEvents: []
      }
    })
    const r = computeAnnualReviewSilentCustomers(P2026, inputs)
    eq('14 C6 90 天边界', r.value?.map((x) => x.sessionId), ['s_over'])
    ok('14b C6 恒 partial（当前回填口径）', r.coverage.status === 'partial' && hasCode(r.warnings, 'last_contact_fallback'))
    ok('14c C6 历史年度 unavailable', computeAnnualReviewSilentCustomers(P2025, inputs).value === null &&
      computeAnnualReviewSilentCustomers(P2025, inputs).coverage.status === 'unavailable')
  }

  // ══ 15 C7 流失风险 60 天边界和阶段排除 ═══════════════════════════════════
  {
    const sec = (ms: number): number => Math.floor(ms / 1000)
    const old = sec(GEN - 61 * DAY)
    const inputs = withInputs({
      sales: {
        profiles: [
          prof(1, 's_risk', 'negotiating', sec(GEN - 60 * DAY) - 1),  // >60 天 → 风险
          prof(2, 's_exact', 'quoted', sec(GEN - 60 * DAY)),          // 恰好 60 天 → 不算
          prof(3, 's_won', 'won', old),                               // 排除
          prof(4, 's_lost', 'lost', old),                             // 排除
          prof(5, 's_dormant', 'dormant', old),                       // 排除（流失档）
          prof(6, 's_unknown', null, old),                            // 排除（未知档）
          prof(7, 's_nolc', 'contacted', null)                        // 缺 last_contact_at → 排除+告警
        ],
        intentEvents: []
      }
    })
    const r = computeAnnualReviewRiskCustomers(P2026, inputs)
    eq('15 C7 60 天边界 + won/lost/dormant/unknown 排除', r.value?.map((x) => [x.sessionId, x.stage]), [['s_risk', 'negotiating']])
    ok('15b C7 缺 last_contact_at 告警', warnCount(r.warnings, 'last_contact_missing') === 1)
    ok('15c C7 历史年度 unavailable', computeAnnualReviewRiskCustomers(P2025, inputs).value === null)
  }

  // ══ 16 C8 当前重点推进客户 ═══════════════════════════════════════════════
  {
    const sec = (ms: number): number => Math.floor(ms / 1000)
    const inputs = withInputs({
      sales: {
        profiles: [
          prof(1, 's_in', '决策', sec(GEN - 30 * DAY)),        // 恰好 30 天 → 计入
          prof(2, 's_out', 'negotiating', sec(GEN - 30 * DAY) - 1), // 30 天+1 秒 → 排除
          prof(3, 's_now', '决策', sec(GEN)),                   // asOf 整点 → 不在 [asOf-30d, asOf)
          prof(4, 's_quoted', 'quoted', sec(GEN - 5 * DAY)),    // 阶段不符
          prof(5, 's_nolc', '决策', null)
        ],
        intentEvents: []
      }
    })
    const r = computeAnnualReviewCurrentPriorityCustomers(P2026, inputs)
    eq('16 C8 30 天闭边界（恰好计入）+ 阶段限定决策', r.value?.map((x) => x.sessionId), ['s_in'])
    ok('16b C8 current_year 恒 partial', r.coverage.status === 'partial' && hasCode(r.warnings, 'last_contact_fallback'))
    const rh = computeAnnualReviewCurrentPriorityCustomers(P2025, inputs)
    const ra = computeAnnualReviewCurrentPriorityCustomers(PALL, inputs)
    ok('16c C8 历史年度/all_time → unavailable + unsupported_scope',
      rh.value === null && ra.value === null &&
      hasCode(rh.warnings, 'unsupported_scope') && hasCode(ra.warnings, 'unsupported_scope') &&
      rh.coverage.status === 'unavailable' && ra.coverage.status === 'unavailable')
  }

  // ══ 17 同 session 多画像去重取最大 last_contact_at ═══════════════════════
  {
    const sec = (ms: number): number => Math.floor(ms / 1000)
    // 代表 = 最大 last_contact（新画像）：10 天前 · 比价 → 非停滞
    const inputsA = withInputs({
      sales: {
        profiles: [
          prof(1, 'sx', 'negotiating', sec(GEN - 40 * DAY)),
          prof(2, 'sx', 'quoted', sec(GEN - 10 * DAY))
        ],
        intentEvents: []
      }
    })
    ok('17 多画像取最大 last_contact_at（B6 非停滞）', computeAnnualReviewStuckCustomers(P2026, inputsA).value === 0)
    // 代表翻转：最新画像为决策 10 天 → C8 计入
    const inputsB = withInputs({
      sales: {
        profiles: [
          prof(1, 'sx', 'quoted', sec(GEN - 40 * DAY)),
          prof(2, 'sx', '决策', sec(GEN - 10 * DAY))
        ],
        intentEvents: []
      }
    })
    eq('17b 代表画像决定 C8（决策+10 天计入）',
      computeAnnualReviewCurrentPriorityCustomers(P2026, inputsB).value?.map((x) => x.sessionId), ['sx'])
    // last_contact 相同 → 取最大 profile id 的画像
    const sameLc = sec(GEN - 45 * DAY)
    const inputsC = withInputs({
      sales: {
        profiles: [
          prof(5, 'sx', 'won', sameLc),
          prof(9, 'sx', 'negotiating', sameLc) // id 更大 → 代表
        ],
        intentEvents: []
      }
    })
    ok('17c 同 last_contact 取最大 profile id（B6 停滞判定按决策+45 天）',
      computeAnnualReviewStuckCustomers(P2026, inputsC).value === 1)
  }

  // ══ 18 结构性/名单排除 ═══════════════════════════════════════════════════
  {
    const inputs = withInputs({
      facts: { accounts: [accF(1, 'wx_ok'), accF(2, 'wx_room@chatroom')] },
      sales: {
        profiles: [
          prof(1, 'wx_ok', 'quoted'),
          prof(2, 'wx_room@chatroom', 'negotiating'),
          prof(3, 'gh_official', 'won'),
          prof(4, 'filehelper', 'won'),
          prof(5, 'wx_manual', 'won'),
          prof(6, 'wx_internal', 'won')
        ],
        intentEvents: [
          iev(1, 'wx_ok', 'quoted', T(2025, 2, 1)),
          iev(2, 'wx_room@chatroom', 'negotiating', T(2025, 2, 1)),
          iev(3, 'wx_manual', 'won', T(2025, 2, 1))
        ]
      }
    })
    const opts = { exclusions: { manualSessions: [' wx_manual '], internalSessions: ['wx_internal'] } }
    const b1 = computeAnnualReviewCustomerStageDistribution(P2026, inputs, opts)
    distIs('18 B1 总体排除群聊/公众号/系统/手动/内部', b1.distribution, [['比价', 1]])
    ok('18b B1 rows=1（仅有效绑定会话）', b1.coverage.rows === 1)
    const b3 = computeAnnualReviewStageFlow(P2025, inputs, opts)
    distIs('18c B3 排除后会话事件才计', b3.distribution, [['比价', 1]])
    // profile-only 会话不入总体（总体唯一来源 = CRM account）；account 会话无画像归「未知」
    const noProfile = computeAnnualReviewCustomerStageDistribution(P2026, withInputs({
      facts: { accounts: [accF(1, 'wx_noprofile')] },
      sales: { profiles: [prof(1, 'wx_ok', 'quoted')], intentEvents: [] }
    }))
    distIs('18d 没有画像的 account 会话归「未知」；profile-only 不入总体不显示', noProfile.distribution, [['未知', 1]])
    ok('18e rows=1（仅 CRM account 会话）', noProfile.coverage.rows === 1)
  }

  // ══ 19 深冻结不修改输入 ══════════════════════════════════════════════════
  {
    const sec = (ms: number): number => Math.floor(ms / 1000)
    const inputs = freezeDeep(withInputs({
      facts: {
        accounts: [accF(1, 'wx_a', { name: '甲' }), accF(2, 'wx_b', { lastContactAtSec: sec(GEN - 40 * DAY) })],
        contracts: [conF(1, 1, T(2025, 2, 1), 500)],
        allocations: [allocF(1, 1, 300, T(2025, 3, 1)), allocF(2, 2, 700, null, 'confirmed', 'legacy_confirmed', T(2025, 4, 1))]
      },
      sales: {
        profiles: [prof(1, 'wx_a', 'quoted'), prof(2, 'wx_b', '决策', sec(GEN - 45 * DAY)), prof(3, 'wx_c', 'lost')],
        intentEvents: [iev(1, 'wx_a', 'contacted', T(2025, 1, 5)), iev(2, 'wx_a', 'quoted', T(2025, 2, 5)), iev(3, 'wx_c', 'lost', T(2025, 3, 5))]
      },
      crm: {
        opportunities: [oppF(1, 1, '决策', 'active', T(2024, 6, 1))],
        opportunityEvents: [oev(1, 1, 'created', '了解', '', T(2025, 1, 1)), oev(2, 1, 'lost', '决策', '太贵', T(2025, 5, 1))]
      }
    })) as AnnualReviewSegmentInputs
    const snapshot = JSON.stringify(inputs)
    let results: ReturnType<typeof allComputations>
    try {
      results = allComputations(inputs)
      ok('19 深冻结输入不抛错（无原地修改）', true)
    } catch (e) {
      results = allComputations(emptyInputs())
      ok('19 深冻结输入不抛错（无原地修改）', false)
      console.error(e)
    }
    ok('19b 输入快照不变', JSON.stringify(inputs) === snapshot)
    eq('19c 冻结输入结果确定性（重复计算一致）',
      JSON.stringify(allComputations(inputs)), JSON.stringify(results))
  }

  // ══ 20 行序无关 ══════════════════════════════════════════════════════════
  {
    const sec = (ms: number): number => Math.floor(ms / 1000)
    const inputs = withInputs({
      facts: {
        accounts: [accF(1, 'wx_a', { name: '甲', createdAt: T(2025, 1, 2) }), accF(2, 'wx_b', { createdAt: T(2025, 2, 2) }), accF(3, null, { createdAt: null })],
        contracts: [conF(1, 1, T(2025, 2, 1), 500), conF(2, 2, T(2025, 3, 1), 300), conF(3, null, T(2025, 4, 1), 50), conF(4, 2, T(2025, 5, 1), 100)],
        allocations: [allocF(1, 1, 300, T(2025, 3, 1)), allocF(2, null, 20, T(2025, 3, 2)), allocF(3, 2, 700, null, 'confirmed', 'legacy_confirmed', T(2025, 4, 1))]
      },
      sales: {
        profiles: [prof(1, 'wx_a', 'quoted', sec(GEN - 100 * DAY)), prof(2, 'wx_b', '决策', null), prof(3, 'wx_room@chatroom', 'won', sec(GEN - 200 * DAY))],
        intentEvents: [
          iev(1, 'wx_a', 'contacted', T(2025, 1, 5)), iev(2, 'wx_a', 'quoted', T(2025, 2, 5)),
          iev(3, 'wx_b', 'negotiating', T(2025, 3, 5)), iev(4, 'wx_b', 'quoted', T(2025, 3, 5)), // 同时间不同 id
          iev(5, 'wx_c', 'won', T(2025, 4, 5))
        ]
      },
      crm: {
        opportunities: [oppF(1, 1, '决策', 'active', T(2024, 6, 1)), oppF(2, 2, '了解', 'won', T(2024, 7, 1))],
        opportunityEvents: [
          oev(1, 1, 'created', '了解', '', T(2025, 1, 1)), oev(2, 1, 'stage_change', '比价', '', T(2025, 2, 1)),
          oev(3, 2, 'created', '了解', '', T(2025, 1, 2)), oev(4, 2, 'won', '了解', '成交', T(2025, 5, 1))
        ]
      }
    })
    const opts = { exclusions: { manualSessions: ['wx_x'] } }
    const a = allComputations(inputs, opts)
    const reversed = withInputs({
      facts: {
        accounts: [...inputs.facts.accounts].reverse(),
        contracts: [...inputs.facts.contracts].reverse(),
        allocations: [...inputs.facts.allocations].reverse(),
        shippedEvents: []
      },
      sales: { profiles: [...inputs.sales.profiles].reverse(), intentEvents: [...inputs.sales.intentEvents].reverse() },
      crm: { opportunities: [...inputs.crm.opportunities].reverse(), opportunityEvents: [...inputs.crm.opportunityEvents].reverse() }
    })
    const b = allComputations(reversed, opts)
    eq('20 打乱行序后全部指标输出一致（历史年度）', JSON.stringify(b), JSON.stringify(a))
    // 当前年度：B6/C6/C7/C8 的数值路径也必须行序无关
    const cur = {
      b1: computeAnnualReviewCustomerStageDistribution(P2026, inputs, opts),
      b3: computeAnnualReviewStageFlow(P2026, inputs, opts),
      b6: computeAnnualReviewStuckCustomers(P2026, inputs, opts),
      c1: computeAnnualReviewHighValueCustomers(P2026, inputs, opts),
      c2: computeAnnualReviewNewCustomerDetails(P2026, inputs, opts),
      c3: computeAnnualReviewDealingCustomers(P2026, inputs, opts),
      c4: computeAnnualReviewRepeatCustomers(P2026, inputs, opts),
      c6: computeAnnualReviewSilentCustomers(P2026, inputs, opts),
      c7: computeAnnualReviewRiskCustomers(P2026, inputs, opts),
      c8: computeAnnualReviewCurrentPriorityCustomers(P2026, inputs, opts)
    }
    const curRev = {
      b1: computeAnnualReviewCustomerStageDistribution(P2026, reversed, opts),
      b3: computeAnnualReviewStageFlow(P2026, reversed, opts),
      b6: computeAnnualReviewStuckCustomers(P2026, reversed, opts),
      c1: computeAnnualReviewHighValueCustomers(P2026, reversed, opts),
      c2: computeAnnualReviewNewCustomerDetails(P2026, reversed, opts),
      c3: computeAnnualReviewDealingCustomers(P2026, reversed, opts),
      c4: computeAnnualReviewRepeatCustomers(P2026, reversed, opts),
      c6: computeAnnualReviewSilentCustomers(P2026, reversed, opts),
      c7: computeAnnualReviewRiskCustomers(P2026, reversed, opts),
      c8: computeAnnualReviewCurrentPriorityCustomers(P2026, reversed, opts)
    }
    eq('20b 打乱行序后当前年度指标输出一致', JSON.stringify(curRev), JSON.stringify(cur))
  }

  // ══ 22 非法数据不崩溃并稳定降级（同步部分；loader 见 21） ═══════════════
  {
    const inputs = withInputs({
      facts: {
        accounts: [accF(1, 'wx_a'), accF(2, 'wx_b')],
        contracts: [conF(1, 1, T(2025, 2, 1), Number.NaN), conF(2, 1, T(2025, 3, 1), Number.POSITIVE_INFINITY)],
        allocations: [allocF(1, 1, Number.NaN, T(2025, 3, 1)), allocF(2, 1, 99, Number.NaN)]
      },
      sales: {
        profiles: [prof(1, 'wx_a', 'whatever'), prof(2, 'wx_b', null)],
        intentEvents: [
          iev(1, 'wx_a', 'quoted', Number.NaN),           // 非法时间 → 排除
          iev(2, 'wx_a', 'quoted', Number.POSITIVE_INFINITY),
          iev(3, 'wx_a', null, T(2025, 2, 1)),            // null stage 不可识别 → 排除
          iev(4, 'wx_a', 'unknown', T(2025, 2, 3)),       // canonical unknown → 有效事实，归未知桶
          iev(5, null, 'won', T(2025, 2, 2)),             // 空会话 → 排除
          iev(6, 'wx_b', '比价', T(2025, 3, 1)),           // 有效
          iev(7, 'wx_b', '垃圾stage', T(2025, 3, 2))      // 垃圾 stage → 排除，不覆盖比价
        ]
      },
      crm: {
        opportunities: [oppF(1, 1, null, 'active', null), oppF(2, 1, null, 'active', T(2024, 6, 1))],
        opportunityEvents: [
          oev(1, 1, 'created', '了解', '', T(2025, 1, 1)),  // 商机 1 缺 createdAt → 总体外
          oev(2, 2, 'stage_change', '比价', '', null),       // 非法时间 → 排除
          oev(3, 2, 'lost', '', '{bad json [,', T(2025, 4, 1)) // detail 任意字符串 → 原因原文
        ]
      }
    })
    const r1 = computeAnnualReviewCustomerStageDistribution(P2025, inputs)
    distIs('22 有效事件重放（unknown→未知桶；比价不被后续垃圾覆盖）', r1.distribution, [['未知', 1], ['比价', 1]])
    ok('22b 非法时间告警=2、非法阶段告警=2', warnCount(r1.warnings, 'intent_event_time_invalid') === 2 &&
      warnCount(r1.warnings, 'intent_event_stage_invalid') === 2)
    ok('22b2 覆盖率 2/2（合法 unknown 与比价都是有效事实）', r1.coverage.coverageRatio === 1 && r1.coverage.status === 'partial')
    const r2 = computeAnnualReviewOpportunityStageDistribution(P2025, inputs)
    ok('22c B2 缺 createdAt 商机不入总体 + 告警', r2.coverage.rows === 1 && warnCount(r2.warnings, 'opportunity_created_at_missing') === 1)
    distIs('22d B2 商机2 有合法 lost 事件 → 流失桶', r2.distribution, [['流失', 1]])
    const r7 = computeAnnualReviewLostBreakdown(P2026, inputs)
    eq('22e B7 detail 任意字符串原样作为原因', r7.opportunityReasons, [{ reason: '{bad json [,', count: 1 }])
    const rc1 = computeAnnualReviewHighValueCustomers(P2025, inputs)
    ok('22f C1 非法核销金额排除 + 告警（不崩溃）', rc1.value.every((x) => Number.isFinite(x.creditedAmount)) && hasCode(rc1.warnings, 'credited_amount_invalid'))
    const rc3 = computeAnnualReviewDealingCustomers(P2025, inputs)
    ok('22g C3 非法合同金额排除 + 告警', rc3.value.every((x) => Number.isFinite(x.contractAmount)) && hasCode(rc3.warnings, 'contract_amount_invalid'))
  }

  // ══ 23 审查反例（2026-09-20 覆盖率修正）：A CRM 总体 / B 阶段有效性 / C B2 可重建覆盖 ══
  // A1：4 个 CRM 会话全部有有效事件 + 2 个 profile-only 会话（无事件）
  // 旧实现：总体 6、覆盖 4 → 4/6 → 错误 unavailable；新实现：总体 4、覆盖 4 → 1 → 允许重建
  {
    const crm = ['c1', 'c2', 'c3', 'c4']
    const events: RawIntentEvent[] = [
      iev(1, 'c1', 'quoted', T(2025, 2, 1)),
      iev(2, 'c2', 'negotiating', T(2025, 3, 1)),
      iev(3, 'c3', 'won', T(2025, 4, 1)),
      iev(4, 'c4', 'lost', T(2025, 5, 1))
      // profile-only 的 p5/p6 无事件
    ]
    const inputs = withInputs({
      facts: { accounts: crm.map((s, i) => accF(i + 1, s)) },
      sales: {
        profiles: [
          prof(1, 'c1', null), prof(2, 'c2', null), prof(3, 'c3', null), prof(4, 'c4', null),
          prof(5, 'p5', 'won'), prof(6, 'p6', 'won') // profile-only：无 CRM account 绑定
        ],
        intentEvents: events
      }
    })
    const r = computeAnnualReviewCustomerStageDistribution(P2025, inputs)
    ok('23A1 profile-only 不入总体：coverageRatio=4/4=1（旧实现为 4/6 → unavailable）',
      r.coverage.coverageRatio === 1 && r.coverage.rows === 4 && r.coverage.status === 'partial' && r.distribution !== null)
    eq('23A1b 重建分布 = oracle（总体仅 4 个 CRM 会话）', r.distribution, oracleDistribution(crm, events, J2026))

    // A2：B1 当前快照不得显示 profile-only 会话（c1..c4 画像无 stage → 未知；p5/p6 被排除。
    // 旧实现：rows=6 且含 p5/p6 的成交×2；新实现：rows=4、全部未知）
    const cur = computeAnnualReviewCustomerStageDistribution(P2026, inputs)
    distIs('23A2 当前快照不含 profile-only（仅 4 个 CRM 会话，画像无 stage → 未知）', cur.distribution, [['未知', 4]])
    ok('23A2b rows=4（旧实现 rows=6 且含成交×2）', cur.coverage.rows === 4)

    // A3：B3 分母不含 profile-only（p5/p6 有事件，旧实现分母 4、分子 3）
    const b3 = computeAnnualReviewStageFlow(P2025, withInputs({
      facts: { accounts: [accF(1, 'c1'), accF(2, 'c2')] },
      sales: {
        profiles: [prof(1, 'c1', null), prof(2, 'c2', null), prof(3, 'p5', 'won'), prof(4, 'p6', 'won')],
        intentEvents: [
          iev(1, 'c1', 'quoted', T(2025, 2, 1)),
          iev(2, 'p5', 'won', T(2025, 3, 1)),
          iev(3, 'p6', 'won', T(2025, 4, 1))
        ]
      }
    }))
    ok('23A3 B3 分母=2（profile-only 不入）、分子=1 → 0.5（旧实现 3/4）',
      b3.coverage.rows === 2 && b3.coverage.coverageRatio === 1 / 2)
    distIs('23A3b B3 分布不含 p5/p6', b3.distribution, [['比价', 1]])

    // A4：B7 历史覆盖分母不含 profile-only（旧实现 4/6 → unavailable）
    const b7 = computeAnnualReviewLostBreakdown(P2025, inputs)
    ok('23A4 B7 分母=4、覆盖 4/4=1 → 允许重建（旧实现 4/6 → unavailable）',
      b7.coverage.status === 'partial' && b7.coverage.coverageRatio === 1)
    distIs('23A4b B7 客户流失归因（仅 c4 流失且无前序 → 未知）', b7.customerPreviousStage, [['未知', 1]])
  }

  // B：intent_tag_log 阶段有效性
  {
    // B6：5 个 CRM 会话，4 条 null/空白/垃圾 stage 事件 → 1/5，unavailable（旧实现 5/5 重建）
    const garbage = withInputs({
      facts: { accounts: [1, 2, 3, 4, 5].map((i) => accF(i, `g${i}`)) },
      sales: {
        profiles: [],
        intentEvents: [
          iev(1, 'g1', null, T(2025, 2, 1)),
          iev(2, 'g2', '', T(2025, 2, 2)),
          iev(3, 'g3', '   ', T(2025, 2, 3)),
          iev(4, 'g4', '随便什么', T(2025, 2, 4)),
          iev(5, 'g5', 'quoted', T(2025, 2, 5))
        ]
      }
    })
    const r6 = computeAnnualReviewCustomerStageDistribution(P2025, garbage)
    ok('23B6 空/垃圾阶段事件不抬高覆盖：1/5 → unavailable（旧实现 5/5 → 重建）',
      r6.coverage.status === 'unavailable' && r6.coverage.coverageRatio === 1 / 5 && r6.distribution === null)
    ok('23B6b warning=intent_event_stage_invalid（计数 4）', warnCount(r6.warnings, 'intent_event_stage_invalid') === 4)

    // B7：canonical unknown 与中文「未知」是合法覆盖 → 未知桶（invalid 计数必须为 0）
    const unknowns = withInputs({
      facts: { accounts: [accF(1, 'u1'), accF(2, 'u2')] },
      sales: {
        profiles: [],
        intentEvents: [iev(1, 'u1', 'unknown', T(2025, 2, 1)), iev(2, 'u2', '未知', T(2025, 2, 2))]
      }
    })
    const r7 = computeAnnualReviewCustomerStageDistribution(P2025, unknowns)
    distIs('23B7 合法 unknown/未知入未知桶且覆盖 2/2', r7.distribution, [['未知', 2]])
    ok('23B7b 无 stage_invalid 误报（回归护栏：合法 unknown/未知不得被排除）',
      (warnCount(r7.warnings, 'intent_event_stage_invalid') ?? 0) === 0)

    // B8：先合法 quoted 后垃圾 stage → 最终仍比价（垃圾不能覆盖合法状态）
    const late = withInputs({
      facts: { accounts: [accF(1, 's1')] },
      sales: {
        profiles: [],
        intentEvents: [iev(1, 's1', 'quoted', T(2025, 2, 1)), iev(2, 's1', '垃圾stage', T(2025, 4, 1))]
      }
    })
    const r8 = computeAnnualReviewCustomerStageDistribution(P2025, late)
    distIs('23B8 较晚垃圾事件不覆盖较早合法阶段（比价）', r8.distribution, [['比价', 1]])
    ok('23B8b 覆盖 1/1 且垃圾计入告警', r8.coverage.coverageRatio === 1 && warnCount(r8.warnings, 'intent_event_stage_invalid') === 1)

    // B9：B3 非法 stage 不进任何桶、不增加 covered
    const b3 = computeAnnualReviewStageFlow(P2025, withInputs({
      facts: { accounts: [accF(1, 's1'), accF(2, 's2')] },
      sales: {
        profiles: [],
        intentEvents: [iev(1, 's1', '垃圾stage', T(2025, 2, 1)), iev(2, 's2', 'quoted', T(2025, 3, 1))]
      }
    }))
    distIs('23B9 B3 垃圾事件不入桶（未知桶也为 0）', b3.distribution, [['比价', 1]])
    ok('23B9b covered=1/2', b3.coverage.coverageRatio === 1 / 2 && warnCount(b3.warnings, 'intent_event_stage_invalid') === 1)

    // B10：B7 非法 stage 不得形成 lost 或前序事实（lost 后的垃圾事件不改变最终 lost 判定）
    const b7 = computeAnnualReviewLostBreakdown(P2025, withInputs({
      facts: { accounts: [accF(1, 's1'), accF(2, 's2')] },
      sales: {
        profiles: [],
        intentEvents: [
          iev(1, 's1', 'lost', T(2025, 2, 1)),
          iev(2, 's1', '垃圾stage', T(2025, 4, 1)),  // 旧实现：最终=unknown → 不算流失
          iev(3, 's2', 'quoted', T(2025, 2, 2)),
          iev(4, 's2', '垃圾stage', T(2025, 4, 2))   // 最终仍 quoted → 非流失
        ]
      }
    }))
    distIs('23B10 lost 后垃圾事件不掩盖流失事实（s1 流失、前序未知）', b7.customerPreviousStage, [['未知', 1]])
  }

  // C：opportunity_event 可重建覆盖
  {
    // C11/C12：只有 signal / deal_pending → 不入覆盖分子
    const signalOnly = computeAnnualReviewOpportunityStageDistribution(P2025, withInputs({
      crm: {
        opportunities: [oppF(1, 1, null, 'active', T(2024, 6, 1))],
        opportunityEvents: [oev(1, 1, 'signal', '了解', '详情', T(2025, 2, 1))]
      }
    }))
    ok('23C11 只有 signal：0/1 → unavailable（旧实现 1/1 → 重建）',
      signalOnly.coverage.status === 'unavailable' && signalOnly.distribution === null && signalOnly.coverage.coverageRatio === 0)
    const pendingOnly = computeAnnualReviewOpportunityStageDistribution(P2025, withInputs({
      crm: {
        opportunities: [oppF(1, 1, null, 'active', T(2024, 6, 1))],
        opportunityEvents: [oev(1, 1, 'deal_pending', '了解', '请登记成交表单', T(2025, 2, 1))]
      }
    }))
    ok('23C12 只有 deal_pending：0/1 → unavailable', pendingOnly.coverage.status === 'unavailable' && pendingOnly.coverage.coverageRatio === 0)

    // C13：created/stage_change + 合法 stage → 入覆盖并正确重放
    const validChain = computeAnnualReviewOpportunityStageDistribution(P2025, withInputs({
      crm: {
        opportunities: [oppF(1, 1, null, 'active', T(2024, 6, 1))],
        opportunityEvents: [
          oev(1, 1, 'created', '了解', '', T(2025, 1, 1)),
          oev(2, 1, 'signal', '了解', '详情', T(2025, 2, 1)),
          oev(3, 1, 'stage_change', '比价', 'ai：了解 → 比价', T(2025, 3, 1))
        ]
      }
    }))
    distIs('23C13 created+stage_change 合法重放（比价）', validChain.distribution, [['比价', 1]])
    ok('23C13b 覆盖 1/1 且无 stage_invalid 误报（回归护栏）',
      validChain.coverage.coverageRatio === 1 && (warnCount(validChain.warnings, 'opportunity_event_stage_invalid') ?? 0) === 0)

    // C14：created/stage_change + 空白/垃圾 stage → 不入覆盖 + 告警
    const invalidChain = computeAnnualReviewOpportunityStageDistribution(P2025, withInputs({
      crm: {
        opportunities: [oppF(1, 1, null, 'active', T(2024, 6, 1))],
        opportunityEvents: [
          oev(1, 1, 'created', '垃圾stage', '', T(2025, 1, 1)),
          oev(2, 1, 'stage_change', '   ', '', T(2025, 3, 1))
        ]
      }
    }))
    ok('23C14 created/stage_change 阶段不可识别：0/1 → unavailable（旧实现 1/1）',
      invalidChain.coverage.status === 'unavailable' && invalidChain.distribution === null &&
      warnCount(invalidChain.warnings, 'opportunity_event_stage_invalid') === 2)

    // C15：won/lost 不依赖 stage，空 stage 也构成可重建终态
    const terminals = computeAnnualReviewOpportunityStageDistribution(P2025, withInputs({
      crm: {
        opportunities: [oppF(1, 1, null, 'active', T(2024, 6, 1)), oppF(2, 2, null, 'active', T(2024, 6, 1))],
        opportunityEvents: [
          oev(1, 1, 'won', '', '人工登记成交', T(2025, 2, 1)),
          oev(2, 2, 'lost', null, '不买了', T(2025, 3, 1))
        ]
      }
    }))
    distIs('23C15 won/lost 空 stage 仍可重建（成交/流失）', terminals.distribution, [['成交', 1], ['流失', 1]])
    ok('23C15b 覆盖 2/2', terminals.coverage.coverageRatio === 1 && terminals.coverage.status === 'partial')

    // C16：5 个商机 4 个可重建 + 1 个仅 signal → 恰好 80% 允许重建（旧实现 ratio=5/5=1）
    const opps5 = [1, 2, 3, 4, 5].map((i) => oppF(i, i, null, 'active', T(2024, 6, i)))
    const exact80 = computeAnnualReviewOpportunityStageDistribution(P2025, withInputs({
      crm: {
        opportunities: opps5,
        opportunityEvents: [
          oev(1, 1, 'created', 'quoted', '', T(2025, 1, 1)),
          oev(2, 2, 'created', 'quoted', '', T(2025, 1, 2)),
          oev(3, 3, 'created', 'negotiating', '', T(2025, 1, 3)),
          oev(4, 4, 'created', 'contacted', '', T(2025, 1, 4)),
          oev(5, 5, 'signal', '了解', '仅信号', T(2025, 1, 5))
        ]
      }
    }))
    ok('23C16 恰好 80%（4/5 商机真正可重建）→ 允许重建（旧实现 ratio=1）',
      exact80.coverage.status === 'partial' && exact80.coverage.coverageRatio === 4 / 5 && exact80.distribution !== null)
    distIs('23C16b 分布（比价2/决策1/了解1 + 仅 signal 商机归未知）', exact80.distribution, [
      ['了解', 1], ['比价', 2], ['决策', 1], ['未知', 1]
    ])

    // C17：5 个商机 3 个可重建 + signal/deal_pending 各一 → 3/5 → unavailable（旧实现 5/5 重建）
    const below = computeAnnualReviewOpportunityStageDistribution(P2025, withInputs({
      crm: {
        opportunities: opps5,
        opportunityEvents: [
          oev(1, 1, 'created', 'quoted', '', T(2025, 1, 1)),
          oev(2, 2, 'stage_change', 'negotiating', '', T(2025, 1, 2)),
          oev(3, 3, 'won', '了解', '成交', T(2025, 1, 3)),
          oev(4, 4, 'signal', '了解', '仅信号', T(2025, 1, 4)),
          oev(5, 5, 'deal_pending', '了解', '待登记', T(2025, 1, 5))
        ]
      }
    }))
    ok('23C17 coverageRatio=3/5 → unavailable/null（旧实现 5/5 → 错误重建）',
      below.coverage.status === 'unavailable' && below.distribution === null && below.coverage.coverageRatio === 3 / 5)
  }

  // ══ 24 审查反例（B7 当前快照）：profile-only 会话完全排除出流失归因 ════════
  {
    // 正向 + 反例混合：crm_lost（CRM 总体内、画像 lost）正常计入；
    // profile_only（无 CRM account 绑定、画像 lost 且带 quoted→lost 事件）必须完全排除
    const mixed = withInputs({
      facts: { accounts: [accF(1, 'crm_session'), accF(2, 'crm_lost')] },
      sales: {
        profiles: [
          prof(1, 'crm_session', 'quoted'),   // a. CRM 会话、画像非 lost
          prof(2, 'crm_lost', 'lost'),
          prof(3, 'profile_only', 'lost')     // b. profile-only、画像 lost
        ],
        intentEvents: [
          iev(1, 'crm_lost', 'quoted', T(2026, 2, 1)),
          iev(2, 'crm_lost', 'lost', T(2026, 3, 1)),
          iev(3, 'profile_only', 'quoted', T(2026, 2, 2)),  // c. 事件也不能使其进入结果
          iev(4, 'profile_only', 'lost', T(2026, 3, 2))
        ]
      }
    })
    const rMixed = computeAnnualReviewLostBreakdown(P2026, mixed)
    distIs('24 B7 当前快照仅计 CRM 总体内 lost（crm_lost 前序比价；profile_only 排除）',
      rMixed.customerPreviousStage, [['比价', 1]])
    ok('24b coverage.rows=1（旧实现 rows=2）', rMixed.coverage.rows === 1)

    // 最小反例：CRM accounts 仅 crm_session（画像非 lost）；profile_only lost + quoted→lost 事件
    const minimalInputs = withInputs({
      facts: { accounts: [accF(1, 'crm_session')] },
      sales: {
        profiles: [prof(1, 'crm_session', 'quoted'), prof(2, 'profile_only', 'lost')],
        intentEvents: [
          iev(3, 'profile_only', 'quoted', T(2026, 2, 2)),
          iev(4, 'profile_only', 'lost', T(2026, 3, 2))
        ]
      }
    })
    const rMin = computeAnnualReviewLostBreakdown(P2026, minimalInputs)
    distIs('24c 最小反例：profile-only lost 完全排除 → 六桶总和为 0（旧实现「比价1/未知1」）',
      rMin.customerPreviousStage, [])
    ok('24d coverage.rows=0（旧实现 rows=1）', rMin.coverage.rows === 0)
    eq('24e profile-only 不得影响 warnings', codesOf(rMin.warnings), ['current_snapshot_projection'])

    // all_time 与 current_year 同一总体约束
    const rAll = computeAnnualReviewLostBreakdown(PALL, minimalInputs)
    distIs('24f all_time 同一约束：六桶总和为 0', rAll.customerPreviousStage, [])
    ok('24g all_time coverage.rows=0', rAll.coverage.rows === 0)
  }

  // ══ 最小反例显式验证（任务八：明确打印三个关键反例的实际结果） ═══════════
  {
    const crm = ['c1', 'c2', 'c3', 'c4']
    const inputs = withInputs({
      facts: { accounts: crm.map((s, i) => accF(i + 1, s)) },
      sales: {
        profiles: [prof(5, 'p5', 'won'), prof(6, 'p6', 'won')],
        intentEvents: [
          iev(1, 'c1', 'quoted', T(2025, 2, 1)), iev(2, 'c2', 'negotiating', T(2025, 3, 1)),
          iev(3, 'c3', 'won', T(2025, 4, 1)), iev(4, 'c4', 'lost', T(2025, 5, 1))
        ]
      }
    })
    const r1 = computeAnnualReviewCustomerStageDistribution(P2025, inputs)
    console.log(`反例1 CRM 4/4 + profile-only 2 → coverageRatio=${r1.coverage.coverageRatio}（必须=1） status=${r1.coverage.status} rows=${r1.coverage.rows}`)

    const garbage = withInputs({
      facts: { accounts: [1, 2, 3, 4, 5].map((i) => accF(i, `g${i}`)) },
      sales: {
        profiles: [],
        intentEvents: [
          iev(1, 'g1', null, T(2025, 2, 1)), iev(2, 'g2', '', T(2025, 2, 2)),
          iev(3, 'g3', '   ', T(2025, 2, 3)), iev(4, 'g4', '随便什么', T(2025, 2, 4)),
          iev(5, 'g5', 'quoted', T(2025, 2, 5))
        ]
      }
    })
    const r2 = computeAnnualReviewCustomerStageDistribution(P2025, garbage)
    console.log(`反例2 4 条空/垃圾阶段事件 → coverageRatio=${r2.coverage.coverageRatio}（必须=1/5，不得虚抬到 4/5=0.8） status=${r2.coverage.status} stageInvalid=${r2.warnings.find((w) => w.code === 'intent_event_stage_invalid')?.count}`)

    const opps5 = [1, 2, 3, 4, 5].map((i) => oppF(i, i, null, 'active', T(2024, 6, i)))
    const r3 = computeAnnualReviewOpportunityStageDistribution(P2025, withInputs({
      crm: {
        opportunities: opps5,
        opportunityEvents: [
          oev(1, 1, 'created', 'quoted', '', T(2025, 1, 1)),
          oev(2, 2, 'stage_change', 'negotiating', '', T(2025, 1, 2)),
          oev(3, 3, 'won', '了解', '成交', T(2025, 1, 3)),
          oev(4, 4, 'signal', '了解', '仅信号', T(2025, 1, 4)),
          oev(5, 5, 'deal_pending', '了解', '待登记', T(2025, 1, 5))
        ]
      }
    }))
    console.log(`反例3 仅 signal/deal_pending 商机 → coverageRatio=${r3.coverage.coverageRatio}（必须=3/5，signal/deal_pending 不入分子） status=${r3.coverage.status}`)
  }

  // ══ 21 loader 真实 sql.js 行为与端到端 ═══════════════════════════════════
  void (async () => {
    const wasmPath = join(ROOT, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm')
    const SQL = await initSqlJs({ locateFile: () => wasmPath })
    const db = new SQL.Database()
    db.run(`
      CREATE TABLE customer_profile (
        id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, display_name TEXT,
        customer_id TEXT, external_source TEXT, stage TEXT DEFAULT 'unknown', tags TEXT DEFAULT '[]',
        notes TEXT, last_contact_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE intent_tag_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, stage TEXT NOT NULL,
        confidence REAL, source TEXT NOT NULL, reason TEXT, message_key TEXT, evidence_text TEXT,
        created_at INTEGER NOT NULL);
      CREATE TABLE opportunity (
        id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER, name TEXT, amount REAL DEFAULT 0,
        stage TEXT DEFAULT 'initial', owner_sales TEXT, status TEXT DEFAULT 'active',
        created_at INTEGER, updated_at INTEGER);
      CREATE TABLE opportunity_event (
        id INTEGER PRIMARY KEY AUTOINCREMENT, opportunity_id INTEGER NOT NULL, event_type TEXT NOT NULL,
        stage TEXT DEFAULT '', detail TEXT DEFAULT '', created_at INTEGER NOT NULL);
      CREATE TABLE account (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, created_at INTEGER,
        session_id TEXT, sales_stage TEXT, last_contact_at INTEGER, imported_at INTEGER, owner_sales TEXT);
      CREATE TABLE contract (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER, name TEXT,
        amount REAL, status TEXT DEFAULT 'pending_sign', sign_date INTEGER, created_at INTEGER, updated_at INTEGER);
      CREATE TABLE allocation (id INTEGER PRIMARY KEY AUTOINCREMENT, payment_record_id INTEGER,
        credited_amount REAL, account_id INTEGER, contract_id INTEGER, status TEXT DEFAULT 'pending',
        created_at INTEGER, confirmed_at INTEGER, reconciliation_status TEXT DEFAULT 'pending', reconciled_at INTEGER, sales_name TEXT);
      CREATE TABLE contract_status_history (id INTEGER PRIMARY KEY AUTOINCREMENT, contract_id INTEGER,
        from_status TEXT, to_status TEXT, created_at INTEGER);
      CREATE TABLE assignment (id INTEGER PRIMARY KEY AUTOINCREMENT, lead_id INTEGER, sales_name TEXT, mode TEXT,
        claimed_at INTEGER, status TEXT);
      CREATE TABLE lead (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER, first_contacted_at INTEGER);
      CREATE TABLE audit_event (id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT, action TEXT, entity_type TEXT,
        entity_id INTEGER, detail TEXT, created_at INTEGER);
    `)
    const ins = (sql: string, params: ReadonlyArray<unknown>): void => db.run(sql, params as never)
    // salesDb
    ins('INSERT INTO customer_profile (id, session_id, stage, last_contact_at, created_at, updated_at) VALUES (?,?,?,?,?,?)', [1, 'wx_a', 'quoted', null, T(2025, 1, 1), T(2025, 1, 1)])
    ins('INSERT INTO customer_profile (id, session_id, stage, last_contact_at, created_at, updated_at) VALUES (?,?,?,?,?,?)', [2, 'wx_b', '决策', Math.floor(T(2025, 3, 1) / 1000), T(2025, 1, 1), T(2025, 1, 1)])
    ins('INSERT INTO customer_profile (id, session_id, stage, last_contact_at, created_at, updated_at) VALUES (?,?,?,?,?,?)', [3, 'wx_c', 'contacted', null, T(2025, 1, 1), T(2025, 1, 1)])
    ins('INSERT INTO customer_profile (id, session_id, stage, last_contact_at, created_at, updated_at) VALUES (?,?,?,?,?,?)', [4, '', 'won', null, T(2025, 1, 1), T(2025, 1, 1)])
    ins('INSERT INTO intent_tag_log (id, session_id, stage, source, created_at) VALUES (?,?,?,?,?)', [1, 'wx_a', 'contacted', 'classifier', T(2025, 2, 1)])
    ins('INSERT INTO intent_tag_log (id, session_id, stage, source, created_at) VALUES (?,?,?,?,?)', [2, 'wx_a', 'quoted', 'manual', T(2025, 4, 1)])
    ins('INSERT INTO intent_tag_log (id, session_id, stage, source, created_at) VALUES (?,?,?,?,?)', [3, 'wx_b', 'negotiating', 'ai', T(2025, 5, 1)])
    // crmDb
    ins('INSERT INTO opportunity (id, account_id, stage, status, created_at) VALUES (?,?,?,?,?)', [1, 1, '了解', 'active', T(2025, 1, 10)])
    ins('INSERT INTO opportunity (id, account_id, stage, status, created_at) VALUES (?,?,?,?,?)', [2, null, '比价', 'won', T(2024, 6, 1)])
    ins('INSERT INTO opportunity_event (id, opportunity_id, event_type, stage, detail, created_at) VALUES (?,?,?,?,?,?)', [1, 1, 'created', '了解', 'AI 识别采购信号', T(2025, 1, 10)])
    ins('INSERT INTO opportunity_event (id, opportunity_id, event_type, stage, detail, created_at) VALUES (?,?,?,?,?,?)', [2, 1, 'signal', '了解', '详情', T(2025, 2, 1)])
    ins('INSERT INTO opportunity_event (id, opportunity_id, event_type, stage, detail, created_at) VALUES (?,?,?,?,?,?)', [3, 2, 'won', '迁移', '人工登记成交（¥100 · M ×1）', T(2024, 7, 1)])
    // crmDb account/contract/allocation（S1 loader 复用 + name 列）；wx_b/wx_c 也是 CRM account
    ins('INSERT INTO account (id, name, created_at, session_id, last_contact_at, imported_at) VALUES (?,?,?,?,?,?)', [1, '甲', T(2024, 5, 1), 'wx_a', null, null])
    ins('INSERT INTO account (id, name, created_at, session_id, last_contact_at, imported_at) VALUES (?,?,?,?,?,?)', [2, '乙', T(2024, 5, 2), 'wx_b', null, null])
    ins('INSERT INTO account (id, name, created_at, session_id, last_contact_at, imported_at) VALUES (?,?,?,?,?,?)', [3, '丙', T(2024, 5, 3), 'wx_c', null, null])
    ins('INSERT INTO contract (id, account_id, name, amount, status, sign_date) VALUES (?,?,?,?,?,?)', [1, 1, 'c1', 1200, 'signed', T(2025, 3, 1)])
    ins('INSERT INTO allocation (id, contract_id, account_id, credited_amount, status, reconciliation_status, reconciled_at, confirmed_at) VALUES (?,?,?,?,?,?,?,?)',
      [1, 1, 1, 800.5, 'confirmed', 'allocated', T(2025, 4, 1), null])

    const sales = loadAnnualReviewSalesSegments(sqlJsQueryRunner(db))
    const crm = loadAnnualReviewCrmSegments(sqlJsQueryRunner(db))
    ok('21 sales loader 行数与规范化', sales.profiles.length === 4 && sales.profiles[3].sessionId === null &&
      sales.profiles[1].lastContactAtSec === Math.floor(T(2025, 3, 1) / 1000) && sales.intentEvents.length === 3)
    ok('21b crm loader 行数与规范化（detail 原文保留）', crm.opportunities.length === 2 && crm.opportunityEvents.length === 3 &&
      crm.opportunityEvents[2].detail === '人工登记成交（¥100 · M ×1）' && crm.opportunities[1].status === 'won')
    ok('21c 静态 SQL + 参数绑定 runner 可用', sqlJsQueryRunner(db).all('SELECT id FROM customer_profile WHERE session_id = ?', ['wx_a']).length === 1)

    // 端到端：loader → 纯统计（2025 历史年度）。CRM 总体 {wx_a, wx_b, wx_c}（accounts），
    // wx_a/wx_b 有事件、wx_c 无 → 2/3 < 80%
    const facts = loadAnnualReviewFacts(sqlJsQueryRunner(db))
    const inputs: AnnualReviewSegmentInputs = { facts, sales, crm }
    const b1 = computeAnnualReviewCustomerStageDistribution(P2025, inputs)
    ok('21d 端到端 B1 覆盖 2/3 → unavailable（不输出看似真实的分布）',
      b1.coverage.status === 'unavailable' && b1.distribution === null && b1.coverage.coverageRatio === 2 / 3)
    ok('21e 不可重建 reasonCodes', hasCode(b1.warnings, 'history_not_reconstructable'))
    // 补足 wx_b / wx_c 事件后覆盖率 100% → 重建（wx_a=比价，wx_b=成交，wx_c=了解）
    ins('INSERT INTO intent_tag_log (id, session_id, stage, source, created_at) VALUES (?,?,?,?,?)', [4, 'wx_b', 'won', 'deal_rule', T(2025, 6, 1)])
    ins('INSERT INTO intent_tag_log (id, session_id, stage, source, created_at) VALUES (?,?,?,?,?)', [5, 'wx_c', 'contacted', 'classifier', T(2025, 2, 2)])
    const sales2 = loadAnnualReviewSalesSegments(sqlJsQueryRunner(db))
    const b1b = computeAnnualReviewCustomerStageDistribution(P2025, { facts, sales: sales2, crm })
    distIs('21f 覆盖补足后重建（比价/成交/了解）', b1b.distribution, [['比价', 1], ['成交', 1], ['了解', 1]])
    ok('21g 覆盖率 1.0 且恒 partial', b1b.coverage.coverageRatio === 1 && b1b.coverage.status === 'partial')
    const b2 = computeAnnualReviewOpportunityStageDistribution(P2025, { facts, sales: sales2, crm })
    distIs('21h 端到端 B2 历史重建（了解/won→成交）', b2.distribution, [['了解', 1], ['成交', 1]])
    const c1 = computeAnnualReviewHighValueCustomers(P2025, { facts, sales: sales2, crm })
    eq('21i 端到端 C1（A6 口径 + name）', c1.value, [{ accountId: 1, name: '甲', creditedAmount: 800.5, contractAmount: 1200 }])
    const b6 = computeAnnualReviewStuckCustomers(P2026, { facts, sales: sales2, crm })
    ok('21j 端到端 B6（wx_b 决策+last_contact 2025-03-01 停滞；wx_a/wx_c 缺 last_contact 不伪造）',
      b6.value === 1 && warnCount(b6.warnings, 'last_contact_missing') === 2)

    console.log(`结果：${pass} 通过 / ${fail} 失败`)
    process.exit(fail > 0 ? 1 : 0)
  })()
}

main()
