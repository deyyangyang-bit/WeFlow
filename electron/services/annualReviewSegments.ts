/**
 * annualReviewSegments.ts —— 年度经营复盘 · B 组漏斗与 C 组客户分类（S2，确定性统计）
 *
 * 分层（docs/设计-年度经营复盘-规格.md §7.1，与 annualReviewStats.ts 同款纪律）：
 *   - 数据访问层 loadAnnualReviewSalesSegments / loadAnnualReviewCrmSegments：窄表加载，
 *     SQL 全静态常量、零拼接、零时间过滤（时间过滤全部留在纯统计层）；
 *     salesDb（customer_profile / intent_tag_log）与 crmDb（opportunity / opportunity_event）
 *     分别加载，绝不跨库 JOIN。
 *   - 纯统计层：B1/B2/B3/B6/B7/C1–C8 全部为纯函数；零 Electron 依赖、零全局单例，
 *     经注入事实（AnnualReviewSegmentInputs）工作；不修改输入；同输入同输出、与输入行序无关。
 *
 * 关键口径（规格 §3/§4/§5.2/§5.3 + S2 任务裁决 + 2026-09-20 审查修正）：
 *   - 阶段语义唯一源 = shared/salesStage（normalizeStage / stageToFunnel / FUNNEL_ORDER /
 *     isRecognizedStage）；本模块零阶段映射副本。所有分布固定输出 FUNNEL_ORDER 六桶，
 *     无数据桶为 0。
 *   - B 组会话总体（B1/B3/B7）= 去重后的有效 CRM 绑定会话，唯一来源为
 *     AnnualReviewFacts.accounts[].sessionId（应用与 A3 相同的结构性/手动/内部排除）；
 *     customer_profile 只能为总体内会话补充 stage/last_contact_at 投影，不得扩大总体
 *     （profile-only 会话不入分布、不入覆盖分母，其 intent 事件不入分子）。
 *     A3/C5 活跃客户沿用 A3 原口径（account.session_id），由
 *     computeAnnualReviewCustomerActiveDetail 单一实现保证 C5 ≡ A3；C6/C7/C8 维持
 *     既有画像名单口径不变。
 *   - 事件重放：主排序 created_at 升序、同时间 id 升序；重放只取 created_at < asOf 的事件
 *     （右边界开区间，asOf 时刻事件不计）；时间非法与阶段值不可识别（isRecognizedStage=false）
 *     的事件排除并分别计数告警，绝不把空值/垃圾阶段当成有效事实抬高覆盖率；
 *     合法 canonical `unknown` 与中文「未知」是有效阶段事实（入覆盖分子，归「未知」桶）。
 *   - 覆盖率（B1/B2/B3/B7）：分子分母同一总体；阈值 80% 用整数运算 covered*5 >= total*4
 *     （恰好 80% 允许）；分母 0 → empty-zero 语义（空结果 + coverageRatio=null），
 *     绝不产生 NaN/Infinity，不伪造百分比。
 *   - B2 可重建覆盖分子 = 至少有一条「能确定历史状态」事件的商机：created/stage_change
 *     （stage 可识别）或 won/lost（不依赖 stage）；signal/deal_pending 等既不更新状态、
 *     也不构成状态覆盖。
 *   - 历史年度（historical_year）：当前投影（customer_profile.stage / opportunity.stage/status /
 *     last_contact_at）一律不可用作时点事实；只有事件流重放合法；重建结果恒 partial（不宣称 complete），
 *     覆盖不足 80% → unavailable + history_not_reconstructable，不返回看似真实的分布。
 *   - last_contact_at 为秒（WCDB 回填），比较前 ×1000；同 session 多画像去重取最大有效值。
 *
 * 本模块不实现 IPC / Worker / UI / 缓存 / 导出 / AI（S3+ 范围）。
 */
import {
  asFinite,
  assertValidPeriod,
  buildExclusionSet,
  cmpString,
  computeAnnualReviewCustomerActiveDetail,
  annualReviewCreditedAllocationsInRange,
  annualReviewNewAccountsInRange,
  annualReviewSignedContractsInRange,
  deterministicSum,
  inRange,
  isStructurallyExcluded,
  normSession,
  WarningCollector,
  type AnnualReviewAccountFact,
  type AnnualReviewComputeOptions,
  type AnnualReviewFacts,
  type AnnualReviewPeriod,
  type MetricState,
  type MetricWarning,
  type SqlQueryRunner
} from './annualReviewStats'
import {
  FUNNEL_ORDER,
  funnelBucket,
  isRecognizedStage,
  normalizeStage,
  stageToFunnel,
  type FunnelStage,
  type StageCanonical
} from '../../shared/salesStage'

// ─── Coverage 结构（规格 §4/§7.2） ───────────────────────────────────────────

/**
 * 每指标覆盖结构；UI 只渲染不推断。
 * coverageRatio 仅当分子、分母属于同一可数总体时返回数值（B1/B2/B3 事件流覆盖）；
 * 分母 0 → null（empty-zero），绝不 NaN/Infinity；当前快照类指标省略（undefined）。
 */
export interface AnnualReviewCoverage {
  source: string
  status: MetricState
  coverageFrom?: number
  coverageTo?: number
  rows?: number
  reasonCodes?: string[]
  exactCoverage?: boolean
  coverageRatio?: number | null
}

// ─── 稳定 reason code 文案（segments 新增；shared code 复用 annualReviewStats） ──

const SEG_WARN = {
  current_snapshot_projection: '当前投影快照（截至生成时间），非历史时点数据',
  history_reconstruction_not_complete: '历史年度为事件流重建结果，即使覆盖达标也不是完整时点投影',
  history_coverage_below_full: '部分对象在截止时点前缺少事件记录，已归入「未知」档',
  history_coverage_below_threshold: '事件覆盖率不足 80%，历史时点无法可靠重建',
  history_not_reconstructable: '历史时点无法从事件流可靠重建，当前投影不能代替',
  history_population_empty: '有效统计总体为空（真实零）',
  stage_flow_low_coverage: '阶段流转只覆盖有事件记录的会话，是覆盖受限的流量参考，不是转化率',
  opportunity_tombstone_gap: '已物理删除的商机及其事件不可恢复，重建结果可能偏低',
  opportunity_created_at_missing: '部分商机缺少有效创建时间，未计入历史总体',
  opportunity_event_time_invalid: '部分商机事件缺少有效时间，已排除',
  opportunity_event_stage_invalid: '部分商机事件阶段值不可识别，未计入状态覆盖',
  opportunity_event_unlinked: '部分商机事件无法关联到商机，已排除',
  intent_event_time_invalid: '部分阶段事件缺少有效时间，已排除',
  intent_event_stage_invalid: '部分阶段事件阶段值不可识别，未计入覆盖',
  last_contact_missing: '部分目标阶段会话缺少最近联系时间，已排除（不伪造停滞/风险状态）',
  credited_account_missing: '存在未关联客户的核销记录，未计入高价值客户',
  unsupported_scope: '当前统计范围（scopeKind）不支持该指标'
} as const

type SegWarnCode = keyof typeof SEG_WARN

/** 覆盖率阈值：≥80% 才允许历史重建；整数运算避免浮点比较（恰好 80% 允许） */
function coverageAtLeastThreshold(covered: number, total: number): boolean {
  return covered * 5 >= total * 4
}

// ─── 事实与输入类型 ──────────────────────────────────────────────────────────

/** salesDb customer_profile 行（last_contact_at 为秒，比较前 ×1000） */
export interface AnnualReviewProfileFact {
  id: number
  sessionId: string | null
  /** 原始 stage（中英混存），使用时一律经 normalizeStage 归一化 */
  stage: string | null
  lastContactAtSec: number | null
}

/** salesDb intent_tag_log append-only 阶段事件（created_at 毫秒；四写者事件全算） */
export interface AnnualReviewIntentEventFact {
  id: number
  sessionId: string | null
  stage: string | null
  createdAt: number | null
}

export interface AnnualReviewSalesSegmentsFacts {
  profiles: AnnualReviewProfileFact[]
  intentEvents: AnnualReviewIntentEventFact[]
}

/** crmDb opportunity 当前投影行（historical 重建禁读 stage/status） */
export interface AnnualReviewOpportunityFact {
  id: number
  accountId: number | null
  stage: string | null
  status: string | null
  createdAt: number | null
}

/** crmDb opportunity_event append-only 商机事件（created_at 毫秒） */
export interface AnnualReviewOpportunityEventFact {
  id: number
  opportunityId: number | null
  /** created / signal / stage_change / won / lost / deal_pending / … */
  eventType: string | null
  stage: string | null
  /** lost 事件 detail = 流失原因（必填写入，读取仍防御空白） */
  detail: string | null
  createdAt: number | null
}

export interface AnnualReviewCrmSegmentsFacts {
  opportunities: AnnualReviewOpportunityFact[]
  opportunityEvents: AnnualReviewOpportunityEventFact[]
}

/** S2 统计输入：S1 事实（accounts/contracts/allocations）+ salesDb/crmDb 段事实 */
export interface AnnualReviewSegmentInputs {
  facts: AnnualReviewFacts
  sales: AnnualReviewSalesSegmentsFacts
  crm: AnnualReviewCrmSegmentsFacts
}

// ─── 漏斗分布（固定六桶、固定顺序） ──────────────────────────────────────────

export interface FunnelBucketCount {
  bucket: FunnelStage
  count: number
}

/** 恒 6 项、FUNNEL_ORDER 顺序（了解/比价/决策/成交/流失/未知），与输入行序无关 */
export type FunnelDistribution = FunnelBucketCount[]

function bucketIndex(bucket: FunnelStage): number {
  const i = FUNNEL_ORDER.indexOf(bucket)
  return i < 0 ? FUNNEL_ORDER.length - 1 : i
}

function emptyDistribution(): FunnelDistribution {
  return FUNNEL_ORDER.map((bucket) => ({ bucket, count: 0 }))
}

/** counts 与 FUNNEL_ORDER 对齐；聚合进定长数组，与遍历顺序无关 */
function distributionFromCounts(counts: number[]): FunnelDistribution {
  return FUNNEL_ORDER.map((bucket, i) => ({ bucket, count: counts[i] ?? 0 }))
}

// ─── warnings / coverage 工具 ────────────────────────────────────────────────

function addSeg(warnings: WarningCollector, code: SegWarnCode, count?: number): void {
  warnings.addCustom(code, SEG_WARN[code], count)
}

/** 输出前按 code 排序（code-unit）：同 code 去重已由收集器保证，排序消除行序对插入顺序的影响 */
function sortedWarnings(warnings: WarningCollector): MetricWarning[] {
  return warnings.list().sort((a, b) => cmpString(a.code, b.code))
}

function reasonCodesOf(warnings: MetricWarning[]): string[] {
  return warnings.map((w) => w.code)
}

// ─── 会话总体与画像代表 ──────────────────────────────────────────────────────

/**
 * B 组会话总体（B1/B3/B7）：去重后的有效 CRM 绑定会话，唯一来源 = AnnualReviewFacts.accounts[]
 * 的 session_id（2026-09-20 审查修正：customer_profile.session_id 不得并入总体——profile-only
 * 会话不是 CRM 客户，并入会扩大覆盖分母、把真实 100% 覆盖错误降成不足 80%）。保留：非空、
 * 非群聊、非公众号、非系统账号、不在手动/内部名单；按规范化 session_id 去重并升序输出。
 * customer_profile 只能为总体内会话补充投影（representativeProfilesBySession），不得扩大总体。
 */
function segmentSessionPopulation(
  accounts: AnnualReviewAccountFact[],
  exclusionSet: Set<string>
): string[] {
  const set = new Set<string>()
  for (const acc of accounts) {
    const sid = normSession(acc.sessionId)
    if (!sid || isStructurallyExcluded(sid) || exclusionSet.has(sid)) continue
    set.add(sid)
  }
  return [...set].sort(cmpString)
}

interface ProfileRep {
  profileId: number
  /** 原始 stage（未归一化；使用处一律 normalizeStage/stageToFunnel） */
  stageRaw: string | null
  /** 同 session 最大有效 last_contact_at（秒×1000）；无有效值 → null */
  lastContactAtMs: number | null
}

/**
 * 同 session 多画像去重：代表画像 = 最大有效 last_contact_at（无有效值视为 -∞），并列取最大 profile id。
 * 每个会话确定性地得到唯一代表，输出与输入行序无关。
 */
function representativeProfilesBySession(
  profiles: AnnualReviewProfileFact[],
  exclusionSet: Set<string>
): Map<string, ProfileRep> {
  const reps = new Map<string, ProfileRep>()
  for (const p of profiles) {
    const sid = normSession(p.sessionId)
    if (!sid || isStructurallyExcluded(sid) || exclusionSet.has(sid)) continue
    const sec = asFinite(p.lastContactAtSec)
    const lcMs = sec !== null && sec > 0 ? sec * 1000 : null
    const pid = asFinite(p.id) ?? 0
    const prev = reps.get(sid)
    if (!prev) {
      reps.set(sid, { profileId: pid, stageRaw: p.stage, lastContactAtMs: lcMs })
      continue
    }
    const prevKey = prev.lastContactAtMs ?? Number.NEGATIVE_INFINITY
    const key = lcMs ?? Number.NEGATIVE_INFINITY
    if (key > prevKey || (key === prevKey && pid > prev.profileId)) {
      reps.set(sid, { profileId: pid, stageRaw: p.stage, lastContactAtMs: lcMs })
    }
  }
  return reps
}

// ─── 事件分组（重放基础；非法时间排除并计数，不崩溃） ────────────────────────

interface SortedStageEvent {
  t: number
  id: number
  stageRaw: string | null
}

interface GroupedIntentEvents {
  /** 仅含总体内会话、时间合法、在时间窗口内且 stage 可识别的事件；每会话按 (t, id) 升序 */
  bySession: Map<string, SortedStageEvent[]>
  invalidTime: number
  /** stage 不可识别（isRecognizedStage=false）的事件数：不入重放、不入覆盖分子 */
  invalidStage: number
  /** 参与分组的事件中最早时间（无 → null）；coverageFrom 用 */
  earliest: number | null
}

/**
 * intent_tag_log 分组：总体外会话（非 CRM 绑定/被排除，含 profile-only）静默跳过；
 * 时间非法 → 计数排除；不在时间窗口 → 静默跳过；stage 不可识别 → 计数排除（不入 bySession、
 * 不入覆盖分子，较晚的垃圾事件因此不能覆盖较早的合法阶段）；canonical `unknown` 与中文
 * 「未知」是可识别阶段事实（入分子、归未知桶）。同会话按 (created_at, id) 升序稳定排序。
 */
function groupIntentEventsBySession(
  events: AnnualReviewIntentEventFact[],
  population: Set<string>,
  timeOk: (t: number) => boolean
): GroupedIntentEvents {
  const bySession = new Map<string, SortedStageEvent[]>()
  let invalidTime = 0
  let invalidStage = 0
  let earliest: number | null = null
  for (const ev of events) {
    const sid = normSession(ev.sessionId)
    if (!sid || !population.has(sid)) continue
    const t = asFinite(ev.createdAt)
    if (t === null) {
      invalidTime++
      continue
    }
    if (!timeOk(t)) continue
    if (!isRecognizedStage(ev.stage)) {
      invalidStage++
      continue
    }
    const id = asFinite(ev.id) ?? 0
    const list = bySession.get(sid)
    const item: SortedStageEvent = { t, id, stageRaw: ev.stage }
    if (list) list.push(item)
    else bySession.set(sid, [item])
    if (earliest === null || t < earliest) earliest = t
  }
  for (const list of bySession.values()) {
    list.sort((a, b) => a.t - b.t || a.id - b.id)
  }
  return { bySession, invalidTime, invalidStage, earliest }
}

// ─── B1 客户阶段分布 ─────────────────────────────────────────────────────────

export interface CustomerStageDistributionResult {
  kind: 'current_snapshot' | 'historical_reconstruction'
  /** unavailable（覆盖率不足）时为 null；其余恒 6 桶 */
  distribution: FunnelDistribution | null
  coverage: AnnualReviewCoverage
  warnings: MetricWarning[]
}

/**
 * B1 stage_snapshot_customer。
 * current_year/all_time：customer_profile 当前 stage 快照（kind=current_snapshot，snapshot_only）；
 *   没有画像的有效绑定会话归「未知」，不静默丢弃。
 * historical_year：对每个有效绑定会话重放 intent_tag_log 中 created_at < asOf 的最后阶段
 *   （四写者事件全算，禁读当前 stage）；覆盖率 = 有截止 asOf 有效阶段事件的绑定会话 / 有效绑定会话总数。
 */
export function computeAnnualReviewCustomerStageDistribution(
  period: AnnualReviewPeriod,
  inputs: AnnualReviewSegmentInputs,
  opts: AnnualReviewComputeOptions = {}
): CustomerStageDistributionResult {
  assertValidPeriod(period)
  const exclusionSet = buildExclusionSet(opts.exclusions)
  const warnings = new WarningCollector()
  const populationArr = segmentSessionPopulation(inputs.facts.accounts, exclusionSet)
  const population = new Set(populationArr)

  if (period.scopeKind === 'historical_year') {
    const asOf = period.asOf
    const { bySession, invalidTime, invalidStage, earliest } = groupIntentEventsBySession(
      inputs.sales.intentEvents,
      population,
      (t) => t < asOf
    )
    if (invalidTime > 0) addSeg(warnings, 'intent_event_time_invalid', invalidTime)
    if (invalidStage > 0) addSeg(warnings, 'intent_event_stage_invalid', invalidStage)
    const total = populationArr.length
    if (total === 0) {
      // 查询成功且总体为空 → empty-zero：空结果 + coverageRatio=null，不伪造百分比
      addSeg(warnings, 'history_population_empty')
      const w = sortedWarnings(warnings)
      return {
        kind: 'historical_reconstruction',
        distribution: emptyDistribution(),
        coverage: {
          source: 'salesdb.intent_tag_log', status: 'partial', rows: 0,
          reasonCodes: reasonCodesOf(w), exactCoverage: false, coverageRatio: null
        },
        warnings: w
      }
    }
    const counts = new Array<number>(FUNNEL_ORDER.length).fill(0)
    let covered = 0
    for (const sid of populationArr) {
      const evs = bySession.get(sid)
      if (!evs || evs.length === 0) {
        counts[bucketIndex('未知')]++ // 未覆盖会话归「未知」，不静默丢弃
        continue
      }
      covered++
      counts[bucketIndex(stageToFunnel(evs[evs.length - 1].stageRaw))]++
    }
    if (coverageAtLeastThreshold(covered, total)) {
      addSeg(warnings, 'history_reconstruction_not_complete')
      if (covered < total) addSeg(warnings, 'history_coverage_below_full')
      const w = sortedWarnings(warnings)
      return {
        kind: 'historical_reconstruction',
        distribution: distributionFromCounts(counts),
        coverage: {
          source: 'salesdb.intent_tag_log', status: 'partial',
          coverageFrom: earliest ?? undefined, coverageTo: asOf, rows: total,
          reasonCodes: reasonCodesOf(w), exactCoverage: true, coverageRatio: covered / total
        },
        warnings: w
      }
    }
    addSeg(warnings, 'history_not_reconstructable')
    addSeg(warnings, 'history_coverage_below_threshold')
    const w = sortedWarnings(warnings)
    return {
      kind: 'historical_reconstruction',
      distribution: null,
      coverage: {
        source: 'salesdb.intent_tag_log', status: 'unavailable',
        coverageTo: asOf, rows: total,
        reasonCodes: reasonCodesOf(w), exactCoverage: true, coverageRatio: covered / total
      },
      warnings: w
    }
  }

  // current_year / all_time：当前快照（截至生成时间），不是历史年末状态
  const reps = representativeProfilesBySession(inputs.sales.profiles, exclusionSet)
  const counts = new Array<number>(FUNNEL_ORDER.length).fill(0)
  for (const sid of populationArr) {
    const rep = reps.get(sid)
    counts[bucketIndex(rep ? stageToFunnel(rep.stageRaw) : '未知')]++
  }
  addSeg(warnings, 'current_snapshot_projection')
  const w = sortedWarnings(warnings)
  return {
    kind: 'current_snapshot',
    distribution: distributionFromCounts(counts),
    coverage: {
      source: 'salesdb.customer_profile', status: 'snapshot_only',
      rows: populationArr.length, reasonCodes: reasonCodesOf(w)
    },
    warnings: w
  }
}

// ─── B2 商机阶段分布 ─────────────────────────────────────────────────────────

export interface OpportunityStageDistributionResult {
  kind: 'current_snapshot' | 'historical_reconstruction'
  distribution: FunnelDistribution | null
  coverage: AnnualReviewCoverage
  warnings: MetricWarning[]
}

interface SortedOppEvent {
  t: number
  id: number
  eventType: string | null
  stageRaw: string | null
  /** 该事件能否确定历史状态：created/stage_change（stage 可识别）或 won/lost（不依赖 stage） */
  stateBearing: boolean
}

interface GroupedOppEvents {
  byOpp: Map<number, SortedOppEvent[]>
  invalidTime: number
  /** created/stage_change 的 stage 不可识别：不更新状态、不入可重建覆盖 */
  invalidStage: number
  unlinked: number
  earliest: number | null
}

/**
 * 商机事件分组与「可重建」标记：
 *   - won / lost：终态事实，stateBearing=true（不依赖 event.stage）；
 *   - created / stage_change：仅当 stage 可识别（isRecognizedStage）才 stateBearing=true，
 *     不可识别 → 计 opportunity_event_stage_invalid，不更新状态、不入覆盖分子；
 *   - signal / deal_pending / 其他：不改变也不能确定阶段或 status → stateBearing=false
 *     （保留在事实中用于重放完整性，但绝不抬高 coverageRatio）。
 * 总体外商机（asOf 后创建/已删除）静默跳过；时间非法计数排除；每商机按 (t, id) 升序。
 */
function groupOpportunityEvents(
  events: AnnualReviewOpportunityEventFact[],
  oppIds: Set<number>,
  timeOk: (t: number) => boolean
): GroupedOppEvents {
  const byOpp = new Map<number, SortedOppEvent[]>()
  let invalidTime = 0
  let invalidStage = 0
  let unlinked = 0
  let earliest: number | null = null
  for (const ev of events) {
    const oid = asFinite(ev.opportunityId)
    if (oid === null || oid <= 0) {
      unlinked++
      continue
    }
    if (!oppIds.has(oid)) continue // 总体外商机（如 asOf 后创建/已删除）静默跳过，不计告警
    const t = asFinite(ev.createdAt)
    if (t === null) {
      invalidTime++
      continue
    }
    if (!timeOk(t)) continue
    let stateBearing: boolean
    if (ev.eventType === 'won' || ev.eventType === 'lost') {
      stateBearing = true
    } else if (ev.eventType === 'created' || ev.eventType === 'stage_change') {
      if (!isRecognizedStage(ev.stage)) {
        invalidStage++
        continue
      }
      stateBearing = true
    } else {
      stateBearing = false
    }
    const id = asFinite(ev.id) ?? 0
    const list = byOpp.get(oid)
    const item: SortedOppEvent = { t, id, eventType: ev.eventType, stageRaw: ev.stage, stateBearing }
    if (list) list.push(item)
    else byOpp.set(oid, [item])
    if (earliest === null || t < earliest) earliest = t
  }
  for (const list of byOpp.values()) {
    list.sort((a, b) => a.t - b.t || a.id - b.id)
  }
  return { byOpp, invalidTime, invalidStage, unlinked, earliest }
}

/**
 * 商机事件重放（截至 asOf 的状态机）：stage_change / created 仅在 stage 可识别时更新阶段
 * （事件 stage 经 shared/salesStage 归一化；不可识别事件不更新状态）；won / lost 进入终态
 * （首个终态生效——真实写路径禁止终态后再变更，防御性锁定；不依赖 event.stage）；
 * signal / deal_pending 等其他类型不更新状态。
 */
function replayOpportunityState(evs: SortedOppEvent[] | undefined): { status: 'active' | 'won' | 'lost'; stage: StageCanonical | null } {
  if (!evs || evs.length === 0) return { status: 'active', stage: null }
  let terminal: 'won' | 'lost' | null = null
  let stage: StageCanonical | null = null
  for (const ev of evs) {
    if (terminal) break
    if (ev.eventType === 'won') {
      terminal = 'won'
      continue
    }
    if (ev.eventType === 'lost') {
      terminal = 'lost'
      continue
    }
    if ((ev.eventType === 'stage_change' || ev.eventType === 'created') && ev.stateBearing) {
      stage = normalizeStage(ev.stageRaw)
    }
  }
  return { status: terminal ?? 'active', stage }
}

/**
 * B2 stage_snapshot_opportunity。
 * current_year/all_time：opportunity 当前投影快照（active 按stage 归档；won/lost 按 status 进成交/流失）。
 * historical_year：基于 opportunity_event 在 asOf 前的事件重放，禁读当前 stage/status 冒充历史年末；
 *   分母 = asOf 前已创建且当前仍可见的 opportunity 总体；覆盖率 = 有事件覆盖的商机 / 分母。
 *   已物理删除商机及其事件不可恢复 → 恒带 opportunity_tombstone_gap，不宣称完整。
 */
export function computeAnnualReviewOpportunityStageDistribution(
  period: AnnualReviewPeriod,
  inputs: AnnualReviewSegmentInputs,
  opts: AnnualReviewComputeOptions = {}
): OpportunityStageDistributionResult {
  assertValidPeriod(period)
  const warnings = new WarningCollector()
  const opportunities = inputs.crm.opportunities ?? []

  if (period.scopeKind === 'historical_year') {
    const asOf = period.asOf
    const denominator: AnnualReviewOpportunityFact[] = []
    let createdAtMissing = 0
    for (const o of opportunities) {
      const created = asFinite(o.createdAt)
      if (created === null) {
        createdAtMissing++
        continue
      }
      if (created < asOf) denominator.push(o)
    }
    if (createdAtMissing > 0) addSeg(warnings, 'opportunity_created_at_missing', createdAtMissing)
    const oppIds = new Set<number>()
    for (const o of denominator) oppIds.add(o.id)
    const { byOpp, invalidTime, invalidStage, unlinked, earliest } = groupOpportunityEvents(
      inputs.crm.opportunityEvents, oppIds, (t) => t < asOf
    )
    if (invalidTime > 0) addSeg(warnings, 'opportunity_event_time_invalid', invalidTime)
    if (invalidStage > 0) addSeg(warnings, 'opportunity_event_stage_invalid', invalidStage)
    if (unlinked > 0) addSeg(warnings, 'opportunity_event_unlinked', unlinked)
    const total = denominator.length
    if (total === 0) {
      addSeg(warnings, 'history_population_empty')
      const w = sortedWarnings(warnings)
      return {
        kind: 'historical_reconstruction',
        distribution: emptyDistribution(),
        coverage: {
          source: 'crmdb.opportunity_event', status: 'partial', rows: 0,
          reasonCodes: reasonCodesOf(w), exactCoverage: false, coverageRatio: null
        },
        warnings: w
      }
    }
    const counts = new Array<number>(FUNNEL_ORDER.length).fill(0)
    // 覆盖分子 = 至少有一条「能确定历史状态」事件（created/stage_change 可识别 stage、won/lost）
    // 的商机；仅有 signal/deal_pending 不构成状态覆盖（2026-09-20 审查修正）。
    let covered = 0
    for (const o of denominator) {
      const evs = byOpp.get(o.id)
      if (!evs || evs.length === 0 || !evs.some((e) => e.stateBearing)) {
        counts[bucketIndex('未知')]++ // 无状态覆盖 → 未知（覆盖率已表达），不静默丢弃
        continue
      }
      covered++
      const state = replayOpportunityState(evs)
      if (state.status === 'won') counts[bucketIndex('成交')]++
      else if (state.status === 'lost') counts[bucketIndex('流失')]++
      else counts[bucketIndex(state.stage ? funnelBucket(state.stage) : '未知')]++
    }
    if (coverageAtLeastThreshold(covered, total)) {
      addSeg(warnings, 'history_reconstruction_not_complete')
      addSeg(warnings, 'opportunity_tombstone_gap')
      if (covered < total) addSeg(warnings, 'history_coverage_below_full')
      const w = sortedWarnings(warnings)
      return {
        kind: 'historical_reconstruction',
        distribution: distributionFromCounts(counts),
        coverage: {
          source: 'crmdb.opportunity_event', status: 'partial',
          coverageFrom: earliest ?? undefined, coverageTo: asOf, rows: total,
          reasonCodes: reasonCodesOf(w), exactCoverage: true, coverageRatio: covered / total
        },
        warnings: w
      }
    }
    addSeg(warnings, 'history_not_reconstructable')
    addSeg(warnings, 'history_coverage_below_threshold')
    const w = sortedWarnings(warnings)
    return {
      kind: 'historical_reconstruction',
      distribution: null,
      coverage: {
        source: 'crmdb.opportunity_event', status: 'unavailable',
        coverageTo: asOf, rows: total,
        reasonCodes: reasonCodesOf(w), exactCoverage: true, coverageRatio: covered / total
      },
      warnings: w
    }
  }

  // current_year / all_time：当前投影快照
  const counts = new Array<number>(FUNNEL_ORDER.length).fill(0)
  for (const o of opportunities) {
    if (o.status === 'won') counts[bucketIndex('成交')]++
    else if (o.status === 'lost') counts[bucketIndex('流失')]++
    else counts[bucketIndex(stageToFunnel(o.stage))]++
  }
  addSeg(warnings, 'current_snapshot_projection')
  const w = sortedWarnings(warnings)
  return {
    kind: 'current_snapshot',
    distribution: distributionFromCounts(counts),
    coverage: {
      source: 'crmdb.opportunity', status: 'snapshot_only',
      rows: opportunities.length, reasonCodes: reasonCodesOf(w)
    },
    warnings: w
  }
}

// ─── B3 年内阶段流转 ─────────────────────────────────────────────────────────

export interface StageFlowResult {
  /** unavailable 不存在（当前与历史同一逻辑）；恒 6 桶 */
  distribution: FunnelDistribution
  coverage: AnnualReviewCoverage
  warnings: MetricWarning[]
}

/**
 * B3 stage_flow：intent_tag_log 事件在 [periodStart, asOf)（all_time 为 <asOf）内按会话重放；
 * 同一会话多次进入同一漏斗桶只计一次；恒 partial（覆盖受限），不输出转化率、不推导相邻阶段百分比。
 * coverageRatio = 区间内至少一条有效事件的绑定会话数 / 有效绑定会话总数。
 */
export function computeAnnualReviewStageFlow(
  period: AnnualReviewPeriod,
  inputs: AnnualReviewSegmentInputs,
  opts: AnnualReviewComputeOptions = {}
): StageFlowResult {
  assertValidPeriod(period)
  const exclusionSet = buildExclusionSet(opts.exclusions)
  const warnings = new WarningCollector()
  const populationArr = segmentSessionPopulation(inputs.facts.accounts, exclusionSet)
  const population = new Set(populationArr)
  const asOf = period.asOf
  const { bySession, invalidTime, invalidStage, earliest } = groupIntentEventsBySession(
    inputs.sales.intentEvents, population, (t) => inRange(t, period.periodStart, asOf)
  )
  if (invalidTime > 0) addSeg(warnings, 'intent_event_time_invalid', invalidTime)
  if (invalidStage > 0) addSeg(warnings, 'intent_event_stage_invalid', invalidStage)

  const counts = new Array<number>(FUNNEL_ORDER.length).fill(0)
  for (const evs of bySession.values()) {
    const seen = new Set<number>()
    for (const ev of evs) seen.add(bucketIndex(stageToFunnel(ev.stageRaw)))
    for (const idx of seen) counts[idx]++
  }
  const total = populationArr.length
  const covered = bySession.size
  addSeg(warnings, 'stage_flow_low_coverage')
  if (total === 0) addSeg(warnings, 'history_population_empty')
  const w = sortedWarnings(warnings)
  return {
    distribution: distributionFromCounts(counts),
    coverage: {
      source: 'salesdb.intent_tag_log', status: 'partial',
      coverageFrom: earliest ?? undefined, coverageTo: asOf, rows: total,
      reasonCodes: reasonCodesOf(w),
      exactCoverage: total > 0 ? true : false,
      coverageRatio: total > 0 ? covered / total : null
    },
    warnings: w
  }
}

// ─── 画像驱动的会话名单（B6/C6/C7/C8 共用） ──────────────────────────────────

interface RepSession {
  sessionId: string
  bucket: FunnelStage
  lastContactAtMs: number | null
}

/** 有效画像会话（结构性/名单排除后），每会话取代表画像的漏斗档位与最大有效 last_contact_at */
function repSessions(reps: Map<string, ProfileRep>): RepSession[] {
  const out: RepSession[] = []
  for (const [sessionId, rep] of reps) {
    out.push({ sessionId, bucket: stageToFunnel(rep.stageRaw), lastContactAtMs: rep.lastContactAtMs })
  }
  return out
}

const DAY_MS = 86_400_000

// ─── B6 停滞客户 ─────────────────────────────────────────────────────────────

export interface StuckCustomersResult {
  /** 停滞会话数；historical_year → null */
  value: number | null
  coverage: AnnualReviewCoverage
  warnings: MetricWarning[]
}

/**
 * B6 stuck_customers（仅 current_year/all_time）：当前档位 ∈ 了解/比价/决策 且
 * asOf - lastContactAt > 30 天（恰好 30 天不算）；缺失 last_contact_at 不伪造为停滞（排除 + 告警）。
 * last_contact_at 为当前回填字段 → 恒 partial；historical_year 一律 unavailable（禁读当前投影）。
 */
export function computeAnnualReviewStuckCustomers(
  period: AnnualReviewPeriod,
  inputs: AnnualReviewSegmentInputs,
  opts: AnnualReviewComputeOptions = {}
): StuckCustomersResult {
  assertValidPeriod(period)
  const warnings = new WarningCollector()
  if (period.scopeKind === 'historical_year') {
    addSeg(warnings, 'history_not_reconstructable')
    const w = sortedWarnings(warnings)
    return {
      value: null,
      coverage: { source: 'salesdb.customer_profile', status: 'unavailable', reasonCodes: reasonCodesOf(w) },
      warnings: w
    }
  }
  const exclusionSet = buildExclusionSet(opts.exclusions)
  const reps = repSessions(representativeProfilesBySession(inputs.sales.profiles, exclusionSet))
  let stalled = 0
  let missingLc = 0
  let examined = 0
  for (const s of reps) {
    if (s.bucket !== '了解' && s.bucket !== '比价' && s.bucket !== '决策') continue
    examined++
    if (s.lastContactAtMs === null) {
      missingLc++
      continue
    }
    if (period.asOf - s.lastContactAtMs > 30 * DAY_MS) stalled++
  }
  warnings.add('last_contact_fallback')
  if (missingLc > 0) addSeg(warnings, 'last_contact_missing', missingLc)
  const w = sortedWarnings(warnings)
  return {
    value: stalled,
    coverage: {
      source: 'salesdb.customer_profile', status: 'partial', rows: examined,
      reasonCodes: reasonCodesOf(w)
    },
    warnings: w
  }
}

// ─── B7 流失归因 ─────────────────────────────────────────────────────────────

export interface LostBreakdownResult {
  kind: 'current_snapshot' | 'historical_reconstruction'
  /** 流失客户按「进入流失前最后一个非流失阶段」的六桶分布；unavailable → null */
  customerPreviousStage: FunnelDistribution | null
  /** 商机流失原因计数（count 降序、原因文字升序）；unavailable → null */
  opportunityReasons: Array<{ reason: string; count: number }> | null
  coverage: AnnualReviewCoverage
  warnings: MetricWarning[]
}

/**
 * 流失前阶段：该会话 created_at < asOf 的事件序列中，最后一个流失事件的之前最后一个非流失阶段；
 * 无流失事件或无前序非流失阶段 → 「未知」。事件序列已按 (t, id) 升序。
 */
function lostPreviousStageBucket(evs: SortedStageEvent[] | undefined): FunnelStage {
  if (!evs || evs.length === 0) return '未知'
  let lastLost = -1
  for (let i = evs.length - 1; i >= 0; i--) {
    if (normalizeStage(evs[i].stageRaw) === 'lost') {
      lastLost = i
      break
    }
  }
  if (lastLost < 0) return '未知'
  for (let i = lastLost - 1; i >= 0; i--) {
    const canonical = normalizeStage(evs[i].stageRaw)
    if (canonical !== 'lost') return funnelBucket(canonical)
  }
  return '未知'
}

/** 商机流失原因：event_type=lost 且 created_at < asOf 的事件 detail；空白 → 「未填写原因」 */
function opportunityLostReasons(
  events: AnnualReviewOpportunityEventFact[],
  asOf: number,
  warnings: WarningCollector
): Array<{ reason: string; count: number }> {
  const NO_REASON = '未填写原因'
  const counts = new Map<string, number>()
  let invalidTime = 0
  for (const ev of events) {
    if (ev.eventType !== 'lost') continue
    const t = asFinite(ev.createdAt)
    if (t === null) {
      invalidTime++
      continue
    }
    if (t >= asOf) continue
    const detail = typeof ev.detail === 'string' ? ev.detail.trim() : ''
    const reason = detail !== '' ? detail : NO_REASON
    counts.set(reason, (counts.get(reason) ?? 0) + 1)
  }
  if (invalidTime > 0) addSeg(warnings, 'opportunity_event_time_invalid', invalidTime)
  const out = [...counts.entries()].map(([reason, count]) => ({ reason, count }))
  // count 降序、原因文字升序（code-unit；count+唯一 reason 构成全序，排序稳定确定）
  out.sort((a, b) => b.count - a.count || cmpString(a.reason, b.reason))
  return out
}

/**
 * B7 lost_breakdown。输出区分 customerPreviousStage 与 opportunityReasons。
 * current_year/all_time：当前归一化 stage = lost（canonical）的画像会话 + asOf 前商机 lost 事件
 *   （kind=current_snapshot）。
 * historical_year：intent_tag_log 重放至 asOf、最终阶段 = lost 才处理；商机侧用 asOf 前 lost 事件；
 *   会话事件覆盖率门槛同 B1，不足 80% → 整项 unavailable。
 */
export function computeAnnualReviewLostBreakdown(
  period: AnnualReviewPeriod,
  inputs: AnnualReviewSegmentInputs,
  opts: AnnualReviewComputeOptions = {}
): LostBreakdownResult {
  assertValidPeriod(period)
  const exclusionSet = buildExclusionSet(opts.exclusions)
  const warnings = new WarningCollector()
  const asOf = period.asOf
  const populationArr = segmentSessionPopulation(inputs.facts.accounts, exclusionSet)
  const population = new Set(populationArr)
  const opportunityReasons = opportunityLostReasons(inputs.crm.opportunityEvents ?? [], asOf, warnings)

  if (period.scopeKind === 'historical_year') {
    const { bySession, invalidTime, invalidStage, earliest } = groupIntentEventsBySession(
      inputs.sales.intentEvents, population, (t) => t < asOf
    )
    if (invalidTime > 0) addSeg(warnings, 'intent_event_time_invalid', invalidTime)
    if (invalidStage > 0) addSeg(warnings, 'intent_event_stage_invalid', invalidStage)
    const total = populationArr.length
    const counts = new Array<number>(FUNNEL_ORDER.length).fill(0)
    let lostSessions = 0
    for (const sid of populationArr) {
      const evs = bySession.get(sid)
      if (!evs || evs.length === 0) continue
      if (normalizeStage(evs[evs.length - 1].stageRaw) !== 'lost') continue
      lostSessions++
      counts[bucketIndex(lostPreviousStageBucket(evs))]++
    }
    if (total > 0 && !coverageAtLeastThreshold(bySession.size, total)) {
      addSeg(warnings, 'history_not_reconstructable')
      addSeg(warnings, 'history_coverage_below_threshold')
      const w = sortedWarnings(warnings)
      return {
        kind: 'historical_reconstruction',
        customerPreviousStage: null,
        opportunityReasons: null,
        coverage: {
          source: 'salesdb.intent_tag_log', status: 'unavailable',
          coverageFrom: earliest ?? undefined, coverageTo: asOf, rows: total,
          reasonCodes: reasonCodesOf(w), exactCoverage: true, coverageRatio: bySession.size / total
        },
        warnings: w
      }
    }
    addSeg(warnings, 'history_reconstruction_not_complete')
    addSeg(warnings, 'opportunity_tombstone_gap')
    if (total > 0 && bySession.size < total) addSeg(warnings, 'history_coverage_below_full')
    const w = sortedWarnings(warnings)
    return {
      kind: 'historical_reconstruction',
      customerPreviousStage: distributionFromCounts(counts),
      opportunityReasons,
      coverage: {
        source: 'salesdb.intent_tag_log', status: 'partial',
        coverageFrom: earliest ?? undefined, coverageTo: asOf, rows: lostSessions,
        reasonCodes: reasonCodesOf(w),
        exactCoverage: total > 0 ? true : false,
        coverageRatio: total > 0 ? bySession.size / total : null
      },
      warnings: w
    }
  }

  // current_year / all_time：当前快照。流失名单与 B1/B3/B7 historical 同一 CRM accounts-only
  // 总体（population）：customer_profile 只能为总体内会话补充当前 stage，profile-only 会话
  // 即使画像为 lost 且有 quoted→lost 事件也完全排除（不入分布、流失计数、coverage.rows）。
  const reps = representativeProfilesBySession(inputs.sales.profiles, exclusionSet)
  const { bySession, invalidTime, invalidStage } = groupIntentEventsBySession(inputs.sales.intentEvents, population, (t) => t < asOf)
  if (invalidTime > 0) addSeg(warnings, 'intent_event_time_invalid', invalidTime)
  if (invalidStage > 0) addSeg(warnings, 'intent_event_stage_invalid', invalidStage)
  const counts = new Array<number>(FUNNEL_ORDER.length).fill(0)
  let lostSessions = 0
  for (const [sid, rep] of reps) {
    if (!population.has(sid)) continue // CRM accounts-only 总体约束（防 profile-only 绕过）
    if (normalizeStage(rep.stageRaw) !== 'lost') continue
    lostSessions++
    counts[bucketIndex(lostPreviousStageBucket(bySession.get(sid)))]++
  }
  addSeg(warnings, 'current_snapshot_projection')
  const w = sortedWarnings(warnings)
  return {
    kind: 'current_snapshot',
    customerPreviousStage: distributionFromCounts(counts),
    opportunityReasons,
    coverage: {
      source: 'salesdb.customer_profile', status: 'snapshot_only',
      rows: lostSessions, reasonCodes: reasonCodesOf(w)
    },
    warnings: w
  }
}

// ─── C1 高价值客户 ───────────────────────────────────────────────────────────

export interface HighValueCustomerRow {
  accountId: number
  name: string | null
  /** 年度核销回款（A6 完全相同口径，按 allocation.account_id 聚合，元） */
  creditedAmount: number
  /** 该客户年度签约合同金额（A4/A5 同一 sign_date 集合，元；并列排序用） */
  contractAmount: number
}

export interface HighValueCustomersResult {
  /** Top 10：creditedAmount 降序 → 年度签约合同金额降序 → accountId 升序 */
  value: HighValueCustomerRow[]
  coverage: AnnualReviewCoverage
  warnings: MetricWarning[]
}

/**
 * C1 high_value_customers：年度核销回款（annualReviewCreditedAllocationsInRange = A6 同一口径，
 * legacy 回退继承 partial）按 account_id 聚合；account_id 缺失排除并告警；Top 10。当前与历史年度均可算。
 */
export function computeAnnualReviewHighValueCustomers(
  period: AnnualReviewPeriod,
  inputs: AnnualReviewSegmentInputs,
  opts: AnnualReviewComputeOptions = {}
): HighValueCustomersResult {
  assertValidPeriod(period)
  const warnings = new WarningCollector()
  const credited = annualReviewCreditedAllocationsInRange(period, inputs.facts.allocations ?? [])
  if (credited.legacyFallback > 0) warnings.add('legacy_time_fallback', credited.legacyFallback)
  if (credited.allocatedNoTime > 0) warnings.add('allocated_reconciled_at_missing', credited.allocatedNoTime)
  if (credited.legacyNoTime > 0) warnings.add('legacy_time_missing', credited.legacyNoTime)
  if (credited.creditedInvalid > 0) warnings.add('credited_amount_invalid', credited.creditedInvalid)

  const creditedByAccount = new Map<number, number[]>()
  let accountMissing = 0
  for (const row of credited.rows) {
    const aid = asFinite(row.allocation.accountId)
    if (aid === null || aid <= 0) {
      accountMissing++
      continue
    }
    const list = creditedByAccount.get(aid)
    if (list) list.push(row.amount)
    else creditedByAccount.set(aid, [row.amount])
  }
  if (accountMissing > 0) addSeg(warnings, 'credited_account_missing', accountMissing)

  // 并列排序金额：同一年度签约合同金额（A4/A5 同一 sign_date 集合）
  const signed = annualReviewSignedContractsInRange(period, inputs.facts.contracts ?? [])
  const contractAmountsByAccount = new Map<number, number[]>()
  let contractAmountInvalid = 0
  for (const c of signed.signedInRange) {
    const aid = asFinite(c.accountId)
    if (aid === null || aid <= 0) continue // 无主合同由 C3 报告；C1 并列金额不含
    const amt = asFinite(c.amount)
    if (amt === null) {
      contractAmountInvalid++
      continue
    }
    const list = contractAmountsByAccount.get(aid)
    if (list) list.push(amt)
    else contractAmountsByAccount.set(aid, [amt])
  }
  if (contractAmountInvalid > 0) warnings.add('contract_amount_invalid', contractAmountInvalid)

  const nameById = new Map<number, string | null>()
  for (const acc of inputs.facts.accounts ?? []) nameById.set(acc.id, acc.name)

  const rows: HighValueCustomerRow[] = []
  for (const [accountId, amounts] of creditedByAccount) {
    rows.push({
      accountId,
      name: nameById.get(accountId) ?? null,
      creditedAmount: deterministicSum(amounts),
      contractAmount: deterministicSum(contractAmountsByAccount.get(accountId) ?? [])
    })
  }
  rows.sort((a, b) =>
    b.creditedAmount - a.creditedAmount ||
    b.contractAmount - a.contractAmount ||
    a.accountId - b.accountId
  )
  const w = sortedWarnings(warnings)
  return {
    value: rows.slice(0, 10),
    coverage: {
      source: 'crmdb.allocation', status: w.length > 0 ? 'partial' : 'complete',
      rows: credited.rows.length, reasonCodes: reasonCodesOf(w)
    },
    warnings: w
  }
}

// ─── C2 新增客户明细 ─────────────────────────────────────────────────────────

export interface NewCustomerRow {
  accountId: number
  name: string | null
  createdAt: number
  /** imported_at 有效即视为导入建档（与 A2 bulk_import_dominant 同一判定字段） */
  imported: boolean
}

export interface NewCustomerDetailsResult {
  /** createdAt 降序 → accountId 升序；数量与 A2 customerNew.value 恒一致 */
  value: NewCustomerRow[]
  coverage: AnnualReviewCoverage
  warnings: MetricWarning[]
}

/** C2：A2 完全相同 created_at 区间与集合（annualReviewNewAccountsInRange 单一实现） */
export function computeAnnualReviewNewCustomerDetails(
  period: AnnualReviewPeriod,
  inputs: AnnualReviewSegmentInputs,
  opts: AnnualReviewComputeOptions = {}
): NewCustomerDetailsResult {
  assertValidPeriod(period)
  const warnings = new WarningCollector()
  const newAcc = annualReviewNewAccountsInRange(period, inputs.facts.accounts ?? [])
  if (newAcc.missingCreatedAt > 0) warnings.add('account_created_at_missing', newAcc.missingCreatedAt)
  let imported = 0
  const rows: NewCustomerRow[] = newAcc.accounts.map((a) => {
    const isImported = asFinite(a.importedAt) !== null
    if (isImported) imported++
    return { accountId: a.id, name: a.name, createdAt: a.createdAt, imported: isImported }
  })
  if (rows.length > 0 && imported * 2 > rows.length) warnings.add('bulk_import_dominant', imported)
  rows.sort((a, b) => b.createdAt - a.createdAt || a.accountId - b.accountId)
  const w = sortedWarnings(warnings)
  return {
    value: rows,
    coverage: {
      source: 'crmdb.account', status: w.length > 0 ? 'partial' : 'complete',
      rows: rows.length, reasonCodes: reasonCodesOf(w)
    },
    warnings: w
  }
}

// ─── C3 成交客户 / C4 复购客户 ───────────────────────────────────────────────

export interface DealingCustomerRow {
  accountId: number
  name: string | null
  /** 年度签约合同数（sign_date ∈ 区间；sign_date 为空不回退 created_at） */
  contractCount: number
  /** 年度签约合同金额（元；非法金额排除并告警） */
  contractAmount: number
  /** 最早 sign_date（毫秒） */
  firstSignDate: number
}

interface DealingGroups {
  rows: DealingCustomerRow[]
  signMissing: number
  accountMissing: number
  amountInvalid: number
}

function dealingCustomerGroups(period: AnnualReviewPeriod, inputs: AnnualReviewSegmentInputs): DealingGroups {
  const signed = annualReviewSignedContractsInRange(period, inputs.facts.contracts ?? [])
  const groups = new Map<number, { count: number; amounts: number[]; firstSign: number }>()
  let accountMissing = 0
  let amountInvalid = 0
  for (const c of signed.signedInRange) {
    const aid = asFinite(c.accountId)
    if (aid === null || aid <= 0) {
      accountMissing++
      continue
    }
    const g = groups.get(aid)
    const sd = c.signDate
    if (g) {
      g.count++
      if (sd < g.firstSign) g.firstSign = sd
      const amt = asFinite(c.amount)
      if (amt === null) amountInvalid++
      else g.amounts.push(amt)
    } else {
      const amounts: number[] = []
      const amt = asFinite(c.amount)
      if (amt === null) amountInvalid++
      else amounts.push(amt)
      groups.set(aid, { count: 1, amounts, firstSign: sd })
    }
  }
  const nameById = new Map<number, string | null>()
  for (const acc of inputs.facts.accounts ?? []) nameById.set(acc.id, acc.name)
  const rows: DealingCustomerRow[] = []
  for (const [accountId, g] of groups) {
    rows.push({
      accountId,
      name: nameById.get(accountId) ?? null,
      contractCount: g.count,
      contractAmount: deterministicSum(g.amounts),
      firstSignDate: g.firstSign
    })
  }
  rows.sort((a, b) => b.contractAmount - a.contractAmount || a.accountId - b.accountId)
  return { rows, signMissing: signed.signMissing, accountMissing, amountInvalid }
}

function dealingWarnings(warnings: WarningCollector, groups: DealingGroups): void {
  if (groups.signMissing > 0) warnings.add('sign_date_missing', groups.signMissing)
  if (groups.accountMissing > 0) warnings.add('contract_account_missing', groups.accountMissing)
  if (groups.amountInvalid > 0) warnings.add('contract_amount_invalid', groups.amountInvalid)
}

export interface DealingCustomersResult {
  /** 合同金额降序 → accountId 升序 */
  value: DealingCustomerRow[]
  coverage: AnnualReviewCoverage
  warnings: MetricWarning[]
}

/** C3：A4/A5/A8 同一 sign_date 集合按客户聚合（合同数、金额、最早 signDate） */
export function computeAnnualReviewDealingCustomers(
  period: AnnualReviewPeriod,
  inputs: AnnualReviewSegmentInputs,
  opts: AnnualReviewComputeOptions = {}
): DealingCustomersResult {
  assertValidPeriod(period)
  const warnings = new WarningCollector()
  const groups = dealingCustomerGroups(period, inputs)
  dealingWarnings(warnings, groups)
  const w = sortedWarnings(warnings)
  return {
    value: groups.rows,
    coverage: {
      source: 'crmdb.contract', status: w.length > 0 ? 'partial' : 'complete',
      rows: groups.rows.length, reasonCodes: reasonCodesOf(w)
    },
    warnings: w
  }
}

export interface RepeatCustomersResult {
  /** 年度合同数 ≥2（年度口径，非历史累计）：合同数降序 → 金额降序 → accountId 升序 */
  value: DealingCustomerRow[]
  coverage: AnnualReviewCoverage
  warnings: MetricWarning[]
}

/** C4：从 C3 同一集合筛选年度合同数 ≥2（dealingCustomerGroups 单一实现） */
export function computeAnnualReviewRepeatCustomers(
  period: AnnualReviewPeriod,
  inputs: AnnualReviewSegmentInputs,
  opts: AnnualReviewComputeOptions = {}
): RepeatCustomersResult {
  assertValidPeriod(period)
  const warnings = new WarningCollector()
  const groups = dealingCustomerGroups(period, inputs)
  dealingWarnings(warnings, groups)
  const rows = groups.rows
    .filter((r) => r.contractCount >= 2)
    .sort((a, b) => b.contractCount - a.contractCount || b.contractAmount - a.contractAmount || a.accountId - b.accountId)
  const w = sortedWarnings(warnings)
  return {
    value: rows,
    coverage: {
      source: 'crmdb.contract', status: w.length > 0 ? 'partial' : 'complete',
      rows: rows.length, reasonCodes: reasonCodesOf(w)
    },
    warnings: w
  }
}

// ─── C5 活跃客户明细 ─────────────────────────────────────────────────────────

export interface ActiveCustomerDetailsResult {
  /** 与 A3 customerActive 同一计算结果；unavailable → null */
  value: Array<{ sessionId: string }> | null
  coverage: AnnualReviewCoverage
  warnings: MetricWarning[]
}

/** C5 = A3 明细（computeAnnualReviewCustomerActiveDetail 单一实现，数量与状态恒一致） */
export function computeAnnualReviewActiveCustomerDetails(
  period: AnnualReviewPeriod,
  inputs: AnnualReviewSegmentInputs,
  opts: AnnualReviewComputeOptions = {}
): ActiveCustomerDetailsResult {
  assertValidPeriod(period)
  const detail = computeAnnualReviewCustomerActiveDetail(period, inputs.facts, opts)
  const metric = detail.metric
  const messageStats = opts.messageStats ?? null
  const source = messageStats !== null && messageStats.ok ? 'wcdb.messages' : 'crmdb.account'
  return {
    value: detail.activeSessions === null ? null : detail.activeSessions.map((sessionId) => ({ sessionId })),
    coverage: {
      source, status: metric.state, rows: detail.activeSessions?.length ?? 0,
      reasonCodes: reasonCodesOf(sortedWarningsFromList(metric.warnings))
    },
    warnings: metric.warnings
  }
}

function sortedWarningsFromList(list: MetricWarning[]): MetricWarning[] {
  return [...list].sort((a, b) => cmpString(a.code, b.code))
}

// ─── C6 沉默客户 / C7 流失风险客户 / C8 当前重点推进客户 ─────────────────────

export interface SilentCustomerRow {
  sessionId: string
  /** 最近联系时间（毫秒，秒×1000） */
  lastContactAtMs: number
}

export interface SilentCustomersResult {
  value: SilentCustomerRow[] | null
  coverage: AnnualReviewCoverage
  warnings: MetricWarning[]
}

/**
 * C6 silent_customers（仅 current_year/all_time）：曾有有效 last_contact_at 且
 * asOf - lastContactAt > 90 天（恰好 90 天不算）。当前回填口径恒 partial；historical_year unavailable。
 */
export function computeAnnualReviewSilentCustomers(
  period: AnnualReviewPeriod,
  inputs: AnnualReviewSegmentInputs,
  opts: AnnualReviewComputeOptions = {}
): SilentCustomersResult {
  assertValidPeriod(period)
  const warnings = new WarningCollector()
  if (period.scopeKind === 'historical_year') {
    addSeg(warnings, 'history_not_reconstructable')
    const w = sortedWarnings(warnings)
    return {
      value: null,
      coverage: { source: 'salesdb.customer_profile', status: 'unavailable', reasonCodes: reasonCodesOf(w) },
      warnings: w
    }
  }
  const exclusionSet = buildExclusionSet(opts.exclusions)
  const reps = repSessions(representativeProfilesBySession(inputs.sales.profiles, exclusionSet))
  const rows: SilentCustomerRow[] = []
  for (const s of reps) {
    if (s.lastContactAtMs === null) continue
    if (period.asOf - s.lastContactAtMs > 90 * DAY_MS) rows.push({ sessionId: s.sessionId, lastContactAtMs: s.lastContactAtMs })
  }
  rows.sort((a, b) => a.lastContactAtMs - b.lastContactAtMs || cmpString(a.sessionId, b.sessionId))
  warnings.add('last_contact_fallback')
  const w = sortedWarnings(warnings)
  return {
    value: rows,
    coverage: {
      source: 'salesdb.customer_profile', status: 'partial', rows: rows.length,
      reasonCodes: reasonCodesOf(w)
    },
    warnings: w
  }
}

export interface RiskCustomerRow {
  sessionId: string
  /** canonical 阶段（了解/比价/决策对应的 canonical） */
  stage: StageCanonical
  lastContactAtMs: number
}

export interface RiskCustomersResult {
  value: RiskCustomerRow[] | null
  coverage: AnnualReviewCoverage
  warnings: MetricWarning[]
}

/**
 * C7 risk_customers（仅 current_year/all_time）：当前档位 ∈ 了解/比价/决策（won/lost/dormant/unknown
 * 一律不纳入）且 asOf - lastContactAt > 60 天（恰好 60 天不算）；缺失 last_contact_at 排除并告警。
 */
export function computeAnnualReviewRiskCustomers(
  period: AnnualReviewPeriod,
  inputs: AnnualReviewSegmentInputs,
  opts: AnnualReviewComputeOptions = {}
): RiskCustomersResult {
  assertValidPeriod(period)
  const warnings = new WarningCollector()
  if (period.scopeKind === 'historical_year') {
    addSeg(warnings, 'history_not_reconstructable')
    const w = sortedWarnings(warnings)
    return {
      value: null,
      coverage: { source: 'salesdb.customer_profile', status: 'unavailable', reasonCodes: reasonCodesOf(w) },
      warnings: w
    }
  }
  const exclusionSet = buildExclusionSet(opts.exclusions)
  const reps = representativeProfilesBySession(inputs.sales.profiles, exclusionSet)
  const rows: RiskCustomerRow[] = []
  let missingLc = 0
  for (const [sessionId, rep] of reps) {
    const bucket = stageToFunnel(rep.stageRaw)
    if (bucket !== '了解' && bucket !== '比价' && bucket !== '决策') continue
    if (rep.lastContactAtMs === null) {
      missingLc++
      continue
    }
    if (period.asOf - rep.lastContactAtMs > 60 * DAY_MS) {
      rows.push({ sessionId, stage: normalizeStage(rep.stageRaw), lastContactAtMs: rep.lastContactAtMs })
    }
  }
  rows.sort((a, b) => a.lastContactAtMs - b.lastContactAtMs || cmpString(a.sessionId, b.sessionId))
  warnings.add('last_contact_fallback')
  if (missingLc > 0) addSeg(warnings, 'last_contact_missing', missingLc)
  const w = sortedWarnings(warnings)
  return {
    value: rows,
    coverage: {
      source: 'salesdb.customer_profile', status: 'partial', rows: rows.length,
      reasonCodes: reasonCodesOf(w)
    },
    warnings: w
  }
}

export interface PriorityCustomerRow {
  sessionId: string
  lastContactAtMs: number
}

export interface PriorityCustomersResult {
  value: PriorityCustomerRow[] | null
  coverage: AnnualReviewCoverage
  warnings: MetricWarning[]
}

/**
 * C8 当前重点推进客户（名称语义 = 当前，非「年末」）：仅 scopeKind=current_year；
 * 当前档位 = 决策 且最近 30 天内有沟通（lastContactAt ∈ [asOf-30天, asOf)，恰好 30 天计入）。
 * historical_year 与 all_time 一律 unavailable/unsupported_scope，不提供该指标。
 */
export function computeAnnualReviewCurrentPriorityCustomers(
  period: AnnualReviewPeriod,
  inputs: AnnualReviewSegmentInputs,
  opts: AnnualReviewComputeOptions = {}
): PriorityCustomersResult {
  assertValidPeriod(period)
  const warnings = new WarningCollector()
  if (period.scopeKind !== 'current_year') {
    addSeg(warnings, 'unsupported_scope')
    const w = sortedWarnings(warnings)
    return {
      value: null,
      coverage: { source: 'salesdb.customer_profile', status: 'unavailable', reasonCodes: reasonCodesOf(w) },
      warnings: w
    }
  }
  const exclusionSet = buildExclusionSet(opts.exclusions)
  const reps = repSessions(representativeProfilesBySession(inputs.sales.profiles, exclusionSet))
  const rows: PriorityCustomerRow[] = []
  for (const s of reps) {
    if (s.bucket !== '决策') continue
    if (s.lastContactAtMs === null) continue
    if (s.lastContactAtMs >= period.asOf - 30 * DAY_MS && s.lastContactAtMs < period.asOf) {
      rows.push({ sessionId: s.sessionId, lastContactAtMs: s.lastContactAtMs })
    }
  }
  rows.sort((a, b) => b.lastContactAtMs - a.lastContactAtMs || cmpString(a.sessionId, b.sessionId))
  warnings.add('last_contact_fallback')
  const w = sortedWarnings(warnings)
  return {
    value: rows,
    coverage: {
      source: 'salesdb.customer_profile', status: 'partial', rows: rows.length,
      reasonCodes: reasonCodesOf(w)
    },
    warnings: w
  }
}

// ─── 数据访问层（窄接口；salesDb / crmDb 分别加载，绝不跨库 JOIN） ────────────

type SqlRow = Record<string, unknown>

function strOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s === '' ? null : s
}

function numOrNull(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/** salesDb 窄加载：customer_profile + intent_tag_log。SQL 静态常量、零拼接、零时间过滤 */
export function loadAnnualReviewSalesSegments(runner: SqlQueryRunner): AnnualReviewSalesSegmentsFacts {
  const profiles = runner.all<SqlRow>(
    'SELECT id, session_id, stage, last_contact_at FROM customer_profile'
  ).map<AnnualReviewProfileFact>((r) => ({
    id: numOrNull(r.id) ?? 0,
    sessionId: strOrNull(r.session_id),
    stage: strOrNull(r.stage),
    lastContactAtSec: numOrNull(r.last_contact_at)
  }))
  const intentEvents = runner.all<SqlRow>(
    'SELECT id, session_id, stage, created_at FROM intent_tag_log'
  ).map<AnnualReviewIntentEventFact>((r) => ({
    id: numOrNull(r.id) ?? 0,
    sessionId: strOrNull(r.session_id),
    stage: strOrNull(r.stage),
    createdAt: numOrNull(r.created_at)
  }))
  return { profiles, intentEvents }
}

/** crmDb 窄加载：opportunity + opportunity_event。SQL 静态常量、零拼接、零时间过滤 */
export function loadAnnualReviewCrmSegments(runner: SqlQueryRunner): AnnualReviewCrmSegmentsFacts {
  const opportunities = runner.all<SqlRow>(
    'SELECT id, account_id, stage, status, created_at FROM opportunity'
  ).map<AnnualReviewOpportunityFact>((r) => ({
    id: numOrNull(r.id) ?? 0,
    accountId: numOrNull(r.account_id),
    stage: strOrNull(r.stage),
    status: strOrNull(r.status),
    createdAt: numOrNull(r.created_at)
  }))
  const opportunityEvents = runner.all<SqlRow>(
    'SELECT id, opportunity_id, event_type, stage, detail, created_at FROM opportunity_event'
  ).map<AnnualReviewOpportunityEventFact>((r) => ({
    id: numOrNull(r.id) ?? 0,
    opportunityId: numOrNull(r.opportunity_id),
    eventType: strOrNull(r.event_type),
    stage: strOrNull(r.stage),
    detail: typeof r.detail === 'string' ? r.detail : strOrNull(r.detail),
    createdAt: numOrNull(r.created_at)
  }))
  return { opportunities, opportunityEvents }
}
