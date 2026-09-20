/**
 * annualReviewStats.ts —— 年度经营复盘 · A1–A9 年度经营摘要（S1，确定性统计）
 *
 * 分层（docs/设计-年度经营复盘-规格.md §7.1）：
 *   - 数据访问层 loadAnnualReviewFacts：只做参数化查询（本模块 SQL 全部为静态常量，零拼接），
 *     返回规范化事实行；不做口径判断、不做时间过滤。
 *   - 纯统计层 computeAnnualReviewSummary：时间范围、口径过滤、去重、聚合、完整性状态与
 *     warnings 全部在此层；不依赖 Electron / 全局单例 / ConfigService，可单测、确定性。
 *   - WCDB 消息统计（A3 主口径）经 AnnualReviewMessageStats 注入：调用方按
 *     annualReviewWcdbSeconds(period) 把毫秒区间换算成秒后调用 wcdbService.getAnnualReportStats，
 *     把 sessions 规范化结果传入；S1 不重写消息扫描算法。
 *
 * 时间契约（规格 §3.0/§3.1）：一切指标左闭右开 `t >= start && t < endExclusive`；
 * 当前年度 asOf = generatedAt；历史年度 asOf = periodEndExclusive；历史以来（year=0）无下界。
 * 非法年份 / 未来年份 / 非法 generatedAt 明确抛 AnnualReviewPeriodError，不静默修正。
 *
 * 金额与数值（规格 §3.3）：元，原始求和，统计层不四舍五入；null/NaN/±Infinity 视为非法，
 * 按明确规则排除并计数告警，不进入最终结果。求和前先排序副本，保证与输入行序无关的确定性。
 *
 * 输出 MetricValue 结构（value/state/warnings 成对）即未来 AnnualReviewReport.summary 的来源；
 * 本模块不实现 IPC / Worker / UI / 缓存 / 导出 / AI（S1 范围）。
 */
import type { Database as SqlJsDatabase } from 'sql.js'

// ─── 常量 ────────────────────────────────────────────────────────────────────

/** 报告 schema 版本（§7.2 缓存键 reportSchemaVersion 用；指标口径变化时递增） */
export const ANNUAL_REVIEW_REPORT_SCHEMA_VERSION = 1

/**
 * WCDB 系统账号集合（与 salesReportService.generate 内 SYSTEM_ACCOUNTS 同一语义）。
 * 独立副本：纯统计模块不得反向 import Electron 服务链（wcdbService/config 等）。
 */
const WCDB_SYSTEM_ACCOUNTS = new Set([
  'filehelper', 'newsapp', 'tnewsapp', 'fmessage', 'medianote',
  'floatbottle', 'shakeapp', 'lbsapp', 'voicevoipapp', 'feedsapp',
  'voip', 'blogapp', 'qmessage', 'qqsync', 'mphelper', 'weixinguanhaozhuli',
  'weixin', 'weixin_team'
])

// ─── 时间契约 ────────────────────────────────────────────────────────────────

export type AnnualReviewScopeKind = 'current_year' | 'historical_year' | 'all_time'

export interface AnnualReviewPeriod {
  /** 年份；0 = 历史以来 */
  year: number
  scopeKind: AnnualReviewScopeKind
  /** 当年 1 月 1 日 00:00.000 本地时区（毫秒）；all_time 为 null */
  periodStart: number | null
  /** 下一年 1 月 1 日 00:00.000 本地时区（名义自然年边界，毫秒）；all_time 为 null */
  periodEndExclusive: number | null
  /** current_year/all_time = generatedAt；historical_year = periodEndExclusive */
  asOf: number
  /** 报告实际生成时间，不兼作历史数据时点 */
  generatedAt: number
}

export type AnnualReviewPeriodErrorCode = 'invalid_year' | 'future_year' | 'invalid_generated_at'

export class AnnualReviewPeriodError extends Error {
  readonly code: AnnualReviewPeriodErrorCode

  constructor(code: AnnualReviewPeriodErrorCode, message: string) {
    super(message)
    this.name = 'AnnualReviewPeriodError'
    this.code = code
  }
}

const MAX_YEAR = 9999

/** 校验并抛错（resolve 与 compute 共用；非法输入明确拒绝，不静默修正） */
function assertPeriodInputs(year: number, generatedAt: number): void {
  if (typeof generatedAt !== 'number' || !Number.isFinite(generatedAt) || generatedAt <= 0) {
    throw new AnnualReviewPeriodError('invalid_generated_at', `非法的 generatedAt：${String(generatedAt)}`)
  }
  if (typeof year !== 'number' || !Number.isInteger(year) || year < 0 || year > MAX_YEAR) {
    throw new AnnualReviewPeriodError('invalid_year', `非法的年份：${String(year)}`)
  }
}

/** 校验完整 period 形状（防手工构造出 NaN 边界的 period 静默产生全零结果） */
function assertValidPeriod(period: AnnualReviewPeriod): void {
  assertPeriodInputs(period.year, period.generatedAt)
  if (!Number.isFinite(period.asOf) || period.asOf <= 0) {
    throw new AnnualReviewPeriodError('invalid_generated_at', `非法的 asOf：${String(period.asOf)}`)
  }
  if (period.periodStart !== null && !Number.isFinite(period.periodStart)) {
    throw new AnnualReviewPeriodError('invalid_year', `非法的 periodStart：${String(period.periodStart)}`)
  }
}

/**
 * 生成时间契约（纯函数）：
 *   - year = 本地当前年 → current_year，查询区间 [periodStart, asOf=generatedAt)
 *   - year < 本地当前年 → historical_year，asOf = periodEndExclusive，查询区间 [periodStart, asOf)
 *   - year = 0 → all_time，periodStart/periodEndExclusive 为 null，查询区间 [最早可用时间, asOf)
 *   - year > 本地当前年（按 generatedAt 本地年份）→ 拒绝（未来年份）
 */
export function resolveAnnualReviewPeriod(year: number, generatedAt: number): AnnualReviewPeriod {
  assertPeriodInputs(year, generatedAt)
  const currentYear = new Date(generatedAt).getFullYear()
  if (year > currentYear) {
    throw new AnnualReviewPeriodError('future_year', `未来年份无数据可统计：${year}（当前 ${currentYear}）`)
  }
  if (year === 0) {
    return { year: 0, scopeKind: 'all_time', periodStart: null, periodEndExclusive: null, asOf: generatedAt, generatedAt }
  }
  const periodStart = new Date(year, 0, 1, 0, 0, 0, 0).getTime()
  const periodEndExclusive = new Date(year + 1, 0, 1, 0, 0, 0, 0).getTime()
  if (!Number.isFinite(periodStart) || !Number.isFinite(periodEndExclusive)) {
    throw new AnnualReviewPeriodError('invalid_year', `无法构造年份区间：${year}`)
  }
  if (year === currentYear) {
    return { year, scopeKind: 'current_year', periodStart, periodEndExclusive, asOf: generatedAt, generatedAt }
  }
  return { year, scopeKind: 'historical_year', periodStart, periodEndExclusive, asOf: periodEndExclusive, generatedAt }
}

/**
 * WCDB 查询秒区间（wcdbService.getAnnualReportStats 入参）：毫秒 → 秒，两侧统一取 ceil。
 * 秒级时间戳 S 代表时段 [S.000, S+1.000)：右开上界若 floor（asOf 落在秒中间时）会把包含
 * asOf 的那一整秒排除在统计外——该秒的时刻全部早于秒末，漏掉即漏算事实；ceil 保证
 * [startMs, endMs) 在秒域的语义为 [ceil(startMs/1000), ceil(endMs/1000))。本项目年度
 * periodStart 恒为整秒，ceil 后 beginSec 不变，仅防御手工非整秒 period。
 * all_time 无下界 → beginSec = 0（纪元，即「最早可用时间」的实用下界）。
 * 已核实 wcdbCore.normalizeTimestamp：仅 >1e12 视为毫秒，秒级整数原样透传，无二次换算。
 */
export function annualReviewWcdbSeconds(period: AnnualReviewPeriod): { beginSec: number; endSec: number } {
  assertValidPeriod(period)
  return {
    beginSec: period.periodStart === null ? 0 : Math.ceil(period.periodStart / 1000),
    endSec: Math.ceil(period.asOf / 1000)
  }
}

// ─── 指标值结构 ──────────────────────────────────────────────────────────────

export type MetricState = 'complete' | 'partial' | 'snapshot_only' | 'unavailable'

export interface MetricWarning {
  /** 稳定 code（sign_date_missing / legacy_time_fallback / tombstone_gap / …） */
  code: string
  /** 稳定文案（不含动态数字；数量放 count） */
  message: string
  count?: number
}

export interface MetricValue<T> {
  /** unavailable 时为 null；complete/partial 时为真实值（0 是真实零，不是 unavailable） */
  value: T | null
  state: MetricState
  warnings: MetricWarning[]
}

/** A1–A9 年度经营摘要（未来 AnnualReviewReport.summary 的来源） */
export interface AnnualReviewSummary {
  /** A1 客户总数（asOf 时点存量） */
  customerTotal: MetricValue<number>
  /** A2 年度新增客户 */
  customerNew: MetricValue<number>
  /** A3 年度活跃客户 */
  customerActive: MetricValue<number>
  /** A4 年度签约合同数 */
  contractCount: MetricValue<number>
  /** A5 年度签约合同金额（元） */
  contractAmount: MetricValue<number>
  /** A6 年度已核销回款金额（元） */
  creditedAmount: MetricValue<number>
  /** A7 年度已发货合同数 */
  shippedCount: MetricValue<number>
  /** A7 年度已发货合同金额（元） */
  shippedAmount: MetricValue<number>
  /** A8 成交客户数 */
  dealingCustomers: MetricValue<number>
  /** A9 客单价 = A5 / A8（元，不舍入） */
  avgDealSize: MetricValue<number>
}

// ─── 事实与输入类型（数据访问层规范化产物） ─────────────────────────────────

export interface AnnualReviewAccountFact {
  id: number
  /** 毫秒；null = 缺失/非法（排除并告警） */
  createdAt: number | null
  /** 毫秒；null = 非导入建档 */
  importedAt: number | null
  sessionId: string | null
  /** WCDB/回填口径为秒；比较前必须 ×1000 */
  lastContactAtSec: number | null
}

export interface AnnualReviewContractFact {
  id: number
  accountId: number | null
  /** 元；null = 缺失/非法 */
  amount: number | null
  status: string
  /** 签约时间毫秒；签约数/金额只认 sign_date，禁止回退 created_at（§3.2） */
  signDate: number | null
}

export interface AnnualReviewAllocationFact {
  id: number
  contractId: number | null
  accountId: number | null
  /** 元；null = 缺失/非法 */
  creditedAmount: number | null
  status: string
  reconciliationStatus: string | null
  reconciledAt: number | null
  confirmedAt: number | null
}

export interface AnnualReviewShippedEventFact {
  id: number
  contractId: number | null
  toStatus: string | null
  createdAt: number | null
}

export interface AnnualReviewFacts {
  /** account 现存行（已物理删除的不可见——历史年度 A1 由 tombstone_gap 表达） */
  accounts: AnnualReviewAccountFact[]
  contracts: AnnualReviewContractFact[]
  /** loader 已按 creditedTotal 同款 WHERE 预过滤；计算层仍自行复核状态口径 */
  allocations: AnnualReviewAllocationFact[]
  /** contract_status_history 事件（loader 预过滤 to_status='shipped'；计算层仍自行过滤） */
  shippedEvents: AnnualReviewShippedEventFact[]
}

/** A3 主口径注入：wcdbService.getAnnualReportStats 规范化结果 */
export interface AnnualReviewMessageStats {
  /** false = WCDB 未连接 / 查询失败（主口径不可用，触发 last_contact_at 回退） */
  ok: boolean
  /** sessionId → 收发统计（区间 [beginSec, endSec) 内） */
  sessions: Record<string, { sent: number; received: number }>
}

export interface AnnualReviewExclusions {
  /** 手动排除名单（config reportExcludedSessions） */
  manualSessions?: string[]
  /** 内部人员会话（crmInternalList 成员） */
  internalSessions?: string[]
}

export interface AnnualReviewComputeOptions {
  /** 缺省 / null = 主口径不可用 */
  messageStats?: AnnualReviewMessageStats | null
  exclusions?: AnnualReviewExclusions
}

// ─── 内部工具 ────────────────────────────────────────────────────────────────

/** 有限数 → 原值；null/NaN/±Infinity → null（非法数值绝不进入统计） */
function asFinite(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** 左闭右开区间判定：t >= start（start 为 null 表示无下界）&& t < endExclusive */
function inRange(t: number, start: number | null, endExclusive: number): boolean {
  return (start === null || t >= start) && t < endExclusive
}

/** 确定性求和：排序副本后累加，结果与输入行序无关，中间步骤不舍入 */
function deterministicSum(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  let sum = 0
  for (const v of sorted) sum += v
  return sum
}

/** 稳定告警文案（不含动态数字，数量放 count 字段） */
const WARN = {
  account_created_at_missing: '部分客户档案缺少有效创建时间，已排除',
  tombstone_gap: '历史存量可能不含已删除客户',
  bulk_import_dominant: '新增客户中导入建档占比超过一半',
  last_contact_fallback: '微信消息库不可用，活跃客户按最近联系时间近似统计',
  customer_active_unavailable: '消息库不可用且缺少最近联系时间，无法统计活跃客户',
  historical_contact_unavailable: '历史年度消息统计不可用，当前最近联系时间不能代替历史事实',
  message_stats_invalid: '消息统计包含非法数值，已按 0 处理',
  sign_date_missing: '存在已签约/已发货但缺少签约时间的合同，未计入签约指标',
  contract_amount_invalid: '存在金额缺失或非法的合同，金额统计已排除',
  contract_account_missing: '存在未关联客户的签约合同，未计入成交客户数',
  legacy_time_fallback: '历史核销缺少核销时间，以确认时间近似',
  allocated_reconciled_at_missing: '存在已核销但缺少核销时间的记录，已排除（不使用认领时间替代）',
  legacy_time_missing: '存在历史核销记录同时缺少核销与确认时间，已排除',
  credited_amount_invalid: '存在金额缺失或非法的核销记录，金额统计已排除',
  shipped_contract_unlinked: '存在无法关联到合同的发货记录，未计入发货指标',
  shipped_time_missing: '存在缺少时间的发货记录，未计入发货指标'
} as const

type WarnCode = keyof typeof WARN

/** 按指标聚合 warnings：同 code 去重（首个生效），输出顺序 = 添加顺序，确定性 */
class WarningCollector {
  private readonly byCode = new Map<WarnCode, MetricWarning>()

  add(code: WarnCode, count?: number): void {
    if (this.byCode.has(code)) return
    this.byCode.set(code, count === undefined ? { code, message: WARN[code] } : { code, message: WARN[code], count })
  }

  /** 合并另一个收集器的全部 code（同 code 保留自身） */
  merge(other: WarningCollector): void {
    for (const [code, w] of other.byCode) {
      if (!this.byCode.has(code)) this.byCode.set(code, { ...w })
    }
  }

  list(): MetricWarning[] {
    return [...this.byCode.values()]
  }

  nonEmpty(): boolean {
    return this.byCode.size > 0
  }
}

function metric(value: number | null, warnings: WarningCollector, forceState?: MetricState): MetricValue<number> {
  const warningsList = warnings.list()
  const state: MetricState = forceState ?? (warnings.nonEmpty() ? 'partial' : 'complete')
  return { value, state, warnings: warningsList }
}

function normSession(v: unknown): string {
  const s = String(v ?? '').trim()
  return s
}

/** 结构性排除：群聊 / 公众号 / 系统账号 */
function isStructurallyExcluded(sid: string): boolean {
  return sid.endsWith('@chatroom') || sid.startsWith('gh_') || WCDB_SYSTEM_ACCOUNTS.has(sid)
}

function buildExclusionSet(exclusions: AnnualReviewExclusions | undefined): Set<string> {
  const set = new Set<string>()
  const addAll = (list: string[] | undefined): void => {
    for (const raw of list ?? []) {
      const s = normSession(raw)
      if (s) set.add(s)
    }
  }
  addAll(exclusions?.manualSessions)
  addAll(exclusions?.internalSessions)
  return set
}

// ─── A1–A9 纯统计层 ──────────────────────────────────────────────────────────

/**
 * 计算 A1–A9 年度经营摘要。
 *
 * 输入不可变性：不修改 period / facts / opts 的任何字段。
 * 确定性：相同输入必得相同输出（求和与行序无关）。
 * 状态与 warnings 完全由统计层给出，UI 将来只渲染不推断。
 */
export function computeAnnualReviewSummary(
  period: AnnualReviewPeriod,
  facts: AnnualReviewFacts,
  opts: AnnualReviewComputeOptions = {}
): AnnualReviewSummary {
  assertValidPeriod(period)
  const start = period.periodStart
  const end = period.asOf
  const accounts = facts.accounts ?? []
  const contracts = facts.contracts ?? []
  const allocations = facts.allocations ?? []
  const shippedEvents = facts.shippedEvents ?? []

  // ── A1 customer_total / A2 customer_new ──────────────────────────────────
  // A1：asOf 时点存量 = created_at < asOf（无下界；SQL NULL 语义同款：缺 created_at 不计入）。
  // A2：新增 = created_at ∈ [start, asOf)；all_time 即 created_at < asOf。
  const a1 = new WarningCollector()
  const a2 = new WarningCollector()
  let totalBeforeAsOf = 0
  let newInRange = 0
  let newImported = 0
  let missingCreatedAt = 0
  for (const acc of accounts) {
    const created = asFinite(acc.createdAt)
    if (created === null) {
      missingCreatedAt++
      continue
    }
    if (created < end) totalBeforeAsOf++
    if (inRange(created, start, end)) {
      newInRange++
      if (asFinite(acc.importedAt) !== null) newImported++
    }
  }
  if (missingCreatedAt > 0) {
    a1.add('account_created_at_missing', missingCreatedAt)
    a2.add('account_created_at_missing', missingCreatedAt)
  }
  // 历史年度存量受物理删除影响：一律 partial + tombstone_gap（规格 §5.1 A1）
  if (period.scopeKind === 'historical_year') a1.add('tombstone_gap')
  // 导入建档占比 >50% 才降级；恰好 50% 不降级（整数乘法避免浮点比较）
  if (newInRange > 0 && newImported * 2 > newInRange) a2.add('bulk_import_dominant', newImported)
  const customerTotal = metric(totalBeforeAsOf, a1)
  const customerNew = metric(newInRange, a2)

  // ── A3 customer_active ───────────────────────────────────────────────────
  // 主口径：CRM 绑定会话（account.session_id，去重）∩ 注入消息统计，sent+received>0 活跃。
  // 回退（仅 current_year/all_time）：绑定会话去重后按 session 最大有效 last_contact_at
  //（秒 → ×1000 毫秒）∈ [start, asOf) 判定；historical_year 一律 unavailable（§3.0）。
  const exclusions = buildExclusionSet(opts.exclusions)
  const boundSessions = new Set<string>()
  for (const acc of accounts) {
    const sid = normSession(acc.sessionId)
    if (!sid || isExcluded(exclusions, sid)) continue
    boundSessions.add(sid)
  }
  const a3 = new WarningCollector()
  let activeValue: number | null = null
  let activeState: MetricState
  const messageStats = opts.messageStats ?? null
  if (messageStats && messageStats.ok) {
    let active = 0
    let sanitized = 0
    const sessions = messageStats.sessions ?? {}
    for (const sid of boundSessions) {
      const stat = sessions[sid]
      if (!stat) continue
      const sent = sanitizeCount(stat.sent)
      const received = sanitizeCount(stat.received)
      if (sent === null || received === null) sanitized++
      if ((sent ?? 0) + (received ?? 0) > 0) active++
    }
    if (sanitized > 0) a3.add('message_stats_invalid', sanitized)
    activeValue = active
    activeState = a3.nonEmpty() ? 'partial' : 'complete'
  } else if (period.scopeKind === 'historical_year') {
    // 历史年度禁止回退 last_contact_at（§3.0：last_contact_at 是当前投影，当前投影 ≠ 历史时点）。
    // 宁可 unavailable，不得用今天的最近联系时间冒充历史事实，也不得错误降级为 0 或 partial 近似。
    a3.add('historical_contact_unavailable')
    activeValue = null
    activeState = 'unavailable'
  } else {
    // 回退（仅 current_year / all_time）：与主口径同一统计对象——绑定会话去重。
    // 会话最近联系 = 该 session 下各 account.last_contact_at（秒×1000）的最大有效值；
    // 最大值在区间外时，不得因同会话其他 account 较早的区间内值而误计该会话。
    const lastContactBySession = new Map<string, number>()
    for (const acc of accounts) {
      const sid = normSession(acc.sessionId)
      if (!sid || isExcluded(exclusions, sid)) continue
      const sec = asFinite(acc.lastContactAtSec)
      if (sec === null || sec <= 0) continue
      const ms = sec * 1000
      const prev = lastContactBySession.get(sid)
      if (prev === undefined || ms > prev) lastContactBySession.set(sid, ms)
    }
    if (boundSessions.size === 0) {
      // 没有任何符合条件的绑定会话：0 是真实零，但未经消息主口径验证 → 保守 partial
      a3.add('last_contact_fallback')
      activeValue = 0
      activeState = 'partial'
    } else if (lastContactBySession.size === 0) {
      // 有绑定会话但全部无有效 last_contact_at：不得把查询失败显示成 0
      a3.add('customer_active_unavailable')
      activeValue = null
      activeState = 'unavailable'
    } else {
      let active = 0
      for (const ms of lastContactBySession.values()) {
        if (inRange(ms, start, end)) active++
      }
      a3.add('last_contact_fallback')
      activeValue = active
      activeState = 'partial'
    }
  }
  const customerActive: MetricValue<number> = {
    value: activeValue,
    state: activeState,
    warnings: a3.list()
  }

  // ── A4 contract_count / A5 contract_amount / A8 dealing_customers ────────
  // 签约集合只认 sign_date ∈ [start, asOf)（all_time 即 sign_date < asOf）；
  // sign_date 缺失一律不计（禁止回退 created_at）；signed/shipped 遗留缺失 → partial + 数量。
  const a4 = new WarningCollector()
  const signedInRange: AnnualReviewContractFact[] = []
  let signMissing = 0
  for (const c of contracts) {
    const sd = asFinite(c.signDate)
    if (sd !== null) {
      if (inRange(sd, start, end)) signedInRange.push(c)
    } else if (c.status === 'signed' || c.status === 'shipped') {
      signMissing++
    }
  }
  if (signMissing > 0) a4.add('sign_date_missing', signMissing)
  const contractCount = metric(signedInRange.length, a4)

  // A5：与 A4 完全同一集合 SUM(amount)；非法金额排除并告警，不影响计数集合
  const a5 = new WarningCollector()
  a5.merge(a4)
  const contractAmounts: number[] = []
  let contractAmountInvalid = 0
  for (const c of signedInRange) {
    const amt = asFinite(c.amount)
    if (amt === null) contractAmountInvalid++
    else contractAmounts.push(amt)
  }
  if (contractAmountInvalid > 0) a5.add('contract_amount_invalid', contractAmountInvalid)
  const contractAmount = metric(deterministicSum(contractAmounts), a5)

  // A8：A4 集合 distinct account_id；account_id 缺失不计入客户数并告警
  const a8 = new WarningCollector()
  a8.merge(a4)
  const dealingAccountIds = new Set<number>()
  let contractAccountMissing = 0
  for (const c of signedInRange) {
    const aid = asFinite(c.accountId)
    if (aid === null || aid <= 0) contractAccountMissing++
    else dealingAccountIds.add(aid)
  }
  if (contractAccountMissing > 0) a8.add('contract_account_missing', contractAccountMissing)
  const dealingCustomers = metric(dealingAccountIds.size, a8)

  // ── A9 avg_deal_size = A5 / A8 ───────────────────────────────────────────
  // 分母 0 → unavailable（value=null，不显示 ¥0）；继承 A5/A8 的 partial 与 warnings。
  const a9 = new WarningCollector()
  a9.merge(a5)
  a9.merge(a8)
  let avgValue: number | null = null
  let avgState: MetricState = 'unavailable'
  const amountTotal = contractAmount.value ?? 0
  if (dealingCustomers.value !== null && dealingCustomers.value > 0) {
    avgValue = amountTotal / dealingCustomers.value
    avgState = a9.nonEmpty() ? 'partial' : 'complete'
  }
  const avgDealSize: MetricValue<number> = { value: avgValue, state: avgState, warnings: a9.list() }

  // ── A6 credited_amount ───────────────────────────────────────────────────
  // 口径 = creditedTotal 同款（status='confirmed' AND reconciliation_status IN
  // ('allocated','legacy_confirmed')，规格 §2.3/§5.1）加时间维度：
  //   allocated → 仅 reconciled_at（缺失 → 排除 + 数据异常告警，绝不拿 confirmed_at 伪装）；
  //   legacy_confirmed → reconciled_at 优先，缺失回退 confirmed_at → partial；
  // confirmed+pending（认领）/ conflict / 撤销回 pending 一概不计。
  const a6 = new WarningCollector()
  const creditedAmounts: number[] = []
  let legacyFallback = 0
  let allocatedNoTime = 0
  let legacyNoTime = 0
  let creditedInvalid = 0
  for (const al of allocations) {
    if (al.status !== 'confirmed') continue
    if (al.reconciliationStatus !== 'allocated' && al.reconciliationStatus !== 'legacy_confirmed') continue
    const reconciled = asFinite(al.reconciledAt)
    let t: number | null = null
    let viaFallback = false
    if (al.reconciliationStatus === 'allocated') {
      if (reconciled === null) {
        allocatedNoTime++
        continue
      }
      t = reconciled
    } else if (reconciled !== null) {
      t = reconciled
    } else {
      const confirmed = asFinite(al.confirmedAt)
      if (confirmed === null) {
        legacyNoTime++
        continue
      }
      t = confirmed
      viaFallback = true
    }
    if (!inRange(t, start, end)) continue
    if (viaFallback) legacyFallback++
    const amt = asFinite(al.creditedAmount)
    if (amt === null) {
      creditedInvalid++
      continue
    }
    creditedAmounts.push(amt)
  }
  if (legacyFallback > 0) a6.add('legacy_time_fallback', legacyFallback)
  if (allocatedNoTime > 0) a6.add('allocated_reconciled_at_missing', allocatedNoTime)
  if (legacyNoTime > 0) a6.add('legacy_time_missing', legacyNoTime)
  if (creditedInvalid > 0) a6.add('credited_amount_invalid', creditedInvalid)
  const creditedAmount = metric(deterministicSum(creditedAmounts), a6)

  // ── A7 shippedCount / shippedAmount ──────────────────────────────────────
  // 事实源 contract_status_history：每合同只取全历史第一条 to_status='shipped' 事件，
  // 再判该首条是否落在区间（范围外首条 + 范围内重复事件仍不计）；count/amount 同一集合。
  const a7 = new WarningCollector()
  const contractById = new Map<number, AnnualReviewContractFact>()
  for (const c of contracts) {
    const id = asFinite(c.id)
    if (id !== null && id > 0) contractById.set(id, c)
  }
  const firstShipped = new Map<number, { t: number; eventId: number }>()
  let shippedUnlinked = 0
  let shippedTimeMissing = 0
  for (const ev of shippedEvents) {
    if (ev.toStatus !== 'shipped') continue
    const cid = asFinite(ev.contractId)
    if (cid === null || cid <= 0) {
      shippedUnlinked++
      continue
    }
    const t = asFinite(ev.createdAt)
    if (t === null) {
      shippedTimeMissing++
      continue
    }
    const eventId = asFinite(ev.id) ?? 0
    const prev = firstShipped.get(cid)
    if (!prev || t < prev.t || (t === prev.t && eventId < prev.eventId)) {
      firstShipped.set(cid, { t, eventId })
    }
  }
  let shippedCount = 0
  const shippedAmounts: number[] = []
  let shippedAmountInvalid = 0
  for (const [cid, first] of firstShipped) {
    if (!inRange(first.t, start, end)) continue
    const contract = contractById.get(cid)
    if (!contract) {
      shippedUnlinked++
      continue
    }
    shippedCount++
    const amt = asFinite(contract.amount)
    if (amt === null) shippedAmountInvalid++
    else shippedAmounts.push(amt)
  }
  if (shippedUnlinked > 0) a7.add('shipped_contract_unlinked', shippedUnlinked)
  if (shippedTimeMissing > 0) a7.add('shipped_time_missing', shippedTimeMissing)
  if (shippedAmountInvalid > 0) a7.add('contract_amount_invalid', shippedAmountInvalid)
  const shippedCountMetric = metric(shippedCount, a7)
  const shippedAmount = metric(deterministicSum(shippedAmounts), a7)

  return {
    customerTotal,
    customerNew,
    customerActive,
    contractCount,
    contractAmount,
    creditedAmount,
    shippedCount: shippedCountMetric,
    shippedAmount,
    dealingCustomers,
    avgDealSize
  }
}

/** 排除判定：结构性（群聊/公众号/系统账号）∪ 名单（手动/内部） */
function isExcluded(exclusions: Set<string>, sid: string): boolean {
  return isStructurallyExcluded(sid) || exclusions.has(sid)
}

/** 消息收发计数清洗：非法（负数/非有限）→ null（按 0 计并告警） */
function sanitizeCount(v: unknown): number | null {
  const n = asFinite(v)
  if (n === null || n < 0) return null
  return n
}

// ─── 数据访问层（crmDb 窄接口，SQL 全静态、零拼接） ─────────────────────────

/** 窄查询接口：crmDbService.all 等同签名；S3 编排层注入，统计层不接触全局单例 */
export interface SqlQueryRunner {
  all<T = Record<string, unknown>>(sql: string, params?: ReadonlyArray<unknown>): T[]
}

/** sql.js Database → SqlQueryRunner 适配（crmDb 底层即 sql.js；Database 类型为 any 兜底） */
export function sqlJsQueryRunner(db: SqlJsDatabase): SqlQueryRunner {
  return {
    all<T = Record<string, unknown>>(sql: string, params?: ReadonlyArray<unknown>): T[] {
      const stmt = db.prepare(sql)
      try {
        stmt.bind(params ?? [])
        const rows: T[] = []
        while (stmt.step()) rows.push(stmt.getAsObject() as T)
        return rows
      } finally {
        stmt.free()
      }
    }
  }
}

type SqlRow = Record<string, unknown>

function numOrNull(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function strOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s === '' ? null : s
}

/**
 * 加载 A 组指标所需的规范化事实（account / contract / allocation / contract_status_history）。
 * SQL 全部为静态常量 + 参数绑定占位（当前无外部入参，零拼接面）。
 * 预过滤只做「口径身份」级（allocation 核销状态 / shipped 事件），时间过滤全部留给纯统计层。
 */
export function loadAnnualReviewFacts(runner: SqlQueryRunner): AnnualReviewFacts {
  const accounts = runner.all<SqlRow>(
    'SELECT id, created_at, imported_at, session_id, last_contact_at FROM account'
  ).map<AnnualReviewAccountFact>((r) => ({
    id: numOrNull(r.id) ?? 0,
    createdAt: numOrNull(r.created_at),
    importedAt: numOrNull(r.imported_at),
    sessionId: strOrNull(r.session_id),
    lastContactAtSec: numOrNull(r.last_contact_at)
  }))

  const contracts = runner.all<SqlRow>(
    'SELECT id, account_id, amount, status, sign_date FROM contract'
  ).map<AnnualReviewContractFact>((r) => ({
    id: numOrNull(r.id) ?? 0,
    accountId: numOrNull(r.account_id),
    amount: numOrNull(r.amount),
    status: strOrNull(r.status) ?? '',
    signDate: numOrNull(r.sign_date)
  }))

  // WHERE 子句与 crmDbService.creditedTotal 同款（§2.3 回款计入口径）
  const allocations = runner.all<SqlRow>(
    'SELECT id, contract_id, account_id, credited_amount, status, reconciliation_status, reconciled_at, confirmed_at '
    + "FROM allocation WHERE status = 'confirmed' AND reconciliation_status IN ('allocated', 'legacy_confirmed')"
  ).map<AnnualReviewAllocationFact>((r) => ({
    id: numOrNull(r.id) ?? 0,
    contractId: numOrNull(r.contract_id),
    accountId: numOrNull(r.account_id),
    creditedAmount: numOrNull(r.credited_amount),
    status: strOrNull(r.status) ?? '',
    reconciliationStatus: strOrNull(r.reconciliation_status),
    reconciledAt: numOrNull(r.reconciled_at),
    confirmedAt: numOrNull(r.confirmed_at)
  }))

  const shippedEvents = runner.all<SqlRow>(
    "SELECT id, contract_id, to_status, created_at FROM contract_status_history WHERE to_status = 'shipped'"
  ).map<AnnualReviewShippedEventFact>((r) => ({
    id: numOrNull(r.id) ?? 0,
    contractId: numOrNull(r.contract_id),
    toStatus: strOrNull(r.to_status),
    createdAt: numOrNull(r.created_at)
  }))

  return { accounts, contracts, allocations, shippedEvents }
}
