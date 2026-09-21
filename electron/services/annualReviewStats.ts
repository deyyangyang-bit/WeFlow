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
 *
 * S2 共享面（annualReviewSegments.ts 复用，禁止第二套口径）：时间/区间/求和工具、排除规则、
 * WarningCollector、A2/A3/A4/A6 的口径子计算（annualReviewNewAccountsInRange /
 * computeAnnualReviewCustomerActiveDetail / annualReviewSignedContractsInRange /
 * annualReviewCreditedAllocationsInRange）。B/C 组不在此文件堆叠，见 annualReviewSegments.ts。
 */
import type { Database as SqlJsDatabase } from 'sql.js'

// ─── 常量 ────────────────────────────────────────────────────────────────────

/** 报告 schema 版本（§7.2 缓存键 reportSchemaVersion 用；指标口径变化时递增） */
/** V2：monthly 由 unavailable 占位升级为结构化三序列区块，coverage 键集变化（1.x 缓存不可命中） */
export const ANNUAL_REVIEW_REPORT_SCHEMA_VERSION = 2

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
export function assertValidPeriod(period: AnnualReviewPeriod): void {
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
  /** 客户名称（crmDb account.name，C 组明细展示用；不参与任何口径计算） */
  name: string | null
  /** 毫秒；null = 缺失/非法（排除并告警） */
  createdAt: number | null
  /** 毫秒；null = 非导入建档 */
  importedAt: number | null
  sessionId: string | null
  /** WCDB/回填口径为秒；比较前必须 ×1000 */
  lastContactAtSec: number | null
  /** 当前归属销售（E4 合同贡献分组用；会被离职移交改写 → 历史归属不可重现） */
  ownerSales?: string | null
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
  /** 认领销售（E5 回款贡献主口径分组用；认领动作事实） */
  salesName?: string | null
}

export interface AnnualReviewShippedEventFact {
  id: number
  contractId: number | null
  toStatus: string | null
  createdAt: number | null
}

/** assignment 行（E3 有效跟进用；claimed_at 为认领动作一次性写入，历史可靠） */
export interface AnnualReviewAssignmentFact {
  id: number
  leadId: number | null
  salesName: string | null
  mode: string | null
  /** 认领时间毫秒；null = 未认领（E3 不计） */
  claimedAt: number | null
}

/** lead 行（E3 有效跟进用） */
export interface AnnualReviewLeadFact {
  id: number
  accountId: number | null
  /** 首次触达时间毫秒；null = 未触达 */
  firstContactedAt: number | null
}

/**
 * audit_event 行（E1 分配事实源；append-only，不用 assignment.updated_at）。
 * loader 预过滤 action ∈ (lead_assign / lead_transfer / sync_apply)，detail JSON 防御性解析。
 */
export interface AnnualReviewAuditEventFact {
  id: number
  action: string
  /** 毫秒；null = 缺失/非法（排除并告警） */
  createdAt: number | null
  /** detail 解析出的稳定字段；解析失败 → detailInvalid=true */
  detailType: string | null
  salesName: string | null
  toSales: string | null
  fromSales: string | null
  mode: string | null
  assignmentId: number | null
}

export interface AnnualReviewFacts {
  /** account 现存行（已物理删除的不可见——历史年度 A1 由 tombstone_gap 表达） */
  accounts: AnnualReviewAccountFact[]
  contracts: AnnualReviewContractFact[]
  /** loader 已按 creditedTotal 同款 WHERE 预过滤；计算层仍自行复核状态口径 */
  allocations: AnnualReviewAllocationFact[]
  /** contract_status_history 事件（loader 预过滤 to_status='shipped'；计算层仍自行过滤） */
  shippedEvents: AnnualReviewShippedEventFact[]
  /** assignment 行（E3 用；可选 = 旧载荷无此事实，E3 unavailable） */
  assignments?: AnnualReviewAssignmentFact[]
  /** lead 行（E3 用；可选同上） */
  leads?: AnnualReviewLeadFact[]
  /** audit_event 事件（E1 用；loader 预过滤三类 action；可选同上） */
  auditEvents?: AnnualReviewAuditEventFact[]
}

/** A3 主口径注入：wcdbService.getAnnualReportStats 规范化结果 */
export interface AnnualReviewMessageStats {
  /** false = WCDB 未连接 / 查询失败（主口径不可用，触发 last_contact_at 回退） */
  ok: boolean
  /** sessionId → 收发统计（区间 [beginSec, endSec) 内） */
  sessions: Record<string, { sent: number; received: number }>
  /** 本地日期（YYYY-MM-DD）→ 消息总量（D5 月度趋势聚合用；可选） */
  daily?: Record<string, number>
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

/** 有限数 → 原值；null/NaN/±Infinity → null（非法数值绝不进入统计）。S2 segments 复用 */
export function asFinite(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** 左闭右开区间判定：t >= start（start 为 null 表示无下界）&& t < endExclusive。S2 segments 复用 */
export function inRange(t: number, start: number | null, endExclusive: number): boolean {
  return (start === null || t >= start) && t < endExclusive
}

/** 确定性求和：排序副本后累加，结果与输入行序无关，中间步骤不舍入。S2 segments 复用 */
export function deterministicSum(values: number[]): number {
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

/** 按指标聚合 warnings：同 code 去重（首个生效），输出顺序 = 添加顺序，确定性。
 *  S2 segments 复用：新 code 用 addCustom 携带稳定文案；shared code 直接 add。 */
export class WarningCollector {
  private readonly byCode = new Map<string, MetricWarning>()

  add(code: WarnCode, count?: number): void {
    if (this.byCode.has(code)) return
    this.byCode.set(code, count === undefined ? { code, message: WARN[code] } : { code, message: WARN[code], count })
  }

  /** 自定义 code + 稳定文案（segments 新增 code 用；同 code 去重，首个生效） */
  addCustom(code: string, message: string, count?: number): void {
    if (this.byCode.has(code)) return
    this.byCode.set(code, count === undefined ? { code, message } : { code, message, count })
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

export function normSession(v: unknown): string {
  const s = String(v ?? '').trim()
  return s
}

/** 结构性排除：群聊 / 公众号 / 系统账号。S2 segments 复用 */
export function isStructurallyExcluded(sid: string): boolean {
  return sid.endsWith('@chatroom') || sid.startsWith('gh_') || WCDB_SYSTEM_ACCOUNTS.has(sid)
}

export function buildExclusionSet(exclusions: AnnualReviewExclusions | undefined): Set<string> {
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

// ─── 唯一总体/事实选择器（A3/D 组/dataRange 共用；禁止第二套规范化规则） ──────

/**
 * 有效 CRM 会话总体（唯一选择器）：仅来源 account.session_id——去空、normSession
 * 规范化、去重，排除群聊/公众号/系统账号（结构性）与手动/内部名单。A3 boundSessions、
 * D1/D2/D3 消息总体、D7 与 dataRange 必须共用本函数。
 */
export function selectCrmBoundSessions(
  accounts: ReadonlyArray<AnnualReviewAccountFact> | undefined,
  exclusions?: AnnualReviewExclusions
): string[] {
  const exclusionSet = buildExclusionSet(exclusions)
  const seen = new Set<string>()
  const out: string[] = []
  for (const acc of accounts ?? []) {
    const sid = normSession(acc.sessionId)
    if (!sid || isStructurallyExcluded(sid) || exclusionSet.has(sid) || seen.has(sid)) continue
    seen.add(sid)
    out.push(sid)
  }
  return out
}

/**
 * 每会话最近联系（唯一选择器）：总体内会话取 account.last_contact_at（秒×1000）的
 * 最大有效值；缺失会话不出现。A3 回退、D7、dataRange 共用。
 */
export function selectPerSessionLastContactMs(
  accounts: ReadonlyArray<AnnualReviewAccountFact> | undefined,
  exclusions?: AnnualReviewExclusions
): Map<string, number> {
  const exclusionSet = buildExclusionSet(exclusions)
  const bySession = new Map<string, number>()
  for (const acc of accounts ?? []) {
    const sid = normSession(acc.sessionId)
    if (!sid || isStructurallyExcluded(sid) || exclusionSet.has(sid)) continue
    const sec = asFinite(acc.lastContactAtSec)
    if (sec === null || sec <= 0) continue
    const ms = sec * 1000
    const prev = bySession.get(sid)
    if (prev === undefined || ms > prev) bySession.set(sid, ms)
  }
  return bySession
}

export interface AnnualReviewShippedSelection {
  /** 每合同首次 shipped 事件（合法 contractId + 合法时间；按 (time, eventId) 决胜） */
  firstShipped: Map<number, { time: number; eventId: number }>
  contractById: Map<number, AnnualReviewContractFact>
  /** 无关联合同的 shipped 事件数 */
  unlinked: number
  /** 时间缺失的 shipped 事件数 */
  timeMissing: number
}

/**
 * shipped 事实选择器（唯一实现）：A7 首次发货判定与 dataRange 采用事实共用——
 * 每合同只取全历史第一条 to_status='shipped' 事件（同合同重复事件只有首次可被采用）。
 */
export function selectShippedFacts(facts: AnnualReviewFacts): AnnualReviewShippedSelection {
  const contractById = new Map<number, AnnualReviewContractFact>()
  for (const c of facts.contracts ?? []) {
    const id = asFinite(c.id)
    if (id !== null && id > 0) contractById.set(id, c)
  }
  const firstShipped = new Map<number, { time: number; eventId: number }>()
  let unlinked = 0
  let timeMissing = 0
  for (const ev of facts.shippedEvents ?? []) {
    if (ev.toStatus !== 'shipped') continue
    const cid = asFinite(ev.contractId)
    if (cid === null || cid <= 0) {
      unlinked++
      continue
    }
    const t = asFinite(ev.createdAt)
    if (t === null) {
      timeMissing++
      continue
    }
    const eventId = asFinite(ev.id) ?? 0
    const prev = firstShipped.get(cid)
    if (!prev || t < prev.time || (t === prev.time && eventId < prev.eventId)) {
      firstShipped.set(cid, { time: t, eventId })
    }
  }
  return { firstShipped, contractById, unlinked, timeMissing }
}

/** 事实毫秒时间的合法下界（2000-01-01 本地；排除秒值/纪元脏值，与可用年份 MIN_FACT_YEAR 同源） */
export const ANNUAL_REVIEW_MIN_FACT_MS = new Date(2000, 0, 1).getTime()

/**
 * A 组摘要实际采用的事实时间（dataRange 唯一来源，与各指标同一选择函数）：
 *   - A1 存量：全部现存 account 行的有效 createdAt（< asOf，无下界、无排除）
 *   - A4/A5/A8：sign_date 签约集合（annualReviewSignedContractsInRange 同一集合）
 *   - A6：核销计入时间（annualReviewCreditedAllocationsInRange 同一集合，含 legacy 回退后时间）
 *   - A7：首次 shipped 且合同存在且首条落区间（selectShippedFacts 同一选择）
 *   - A3 回退（仅消息主口径不可用且非历史年度）：总体内每会话最大 last_contact
 *     落在区间者（selectPerSessionLastContactMs + inRange，与 A3 判定完全一致）
 * importedAt 仅参与 A2 导入布尔判定，不产生时间事实。WCDB 消息聚合（A3 主口径）
 * 无事实时间可用——其覆盖边界由文档声明，不进入 dataRange。
 */
export function selectSummaryAdoptedFactTimes(
  period: AnnualReviewPeriod,
  facts: AnnualReviewFacts,
  opts: AnnualReviewComputeOptions = {}
): number[] {
  assertValidPeriod(period)
  const times: number[] = []
  // 区间内事实（A4/A6/A7/A3 回退）：左闭右开
  const pushInRange = (raw: unknown): void => {
    const t = asFinite(raw)
    if (t === null || t <= 0 || t >= period.asOf || t < ANNUAL_REVIEW_MIN_FACT_MS) return
    if (period.periodStart !== null && t < period.periodStart) return
    times.push(t)
  }
  // A1 存量事实：无下界（早于 periodStart 的建档仍参与 A1），仅 < asOf
  const pushStock = (raw: unknown): void => {
    const t = asFinite(raw)
    if (t === null || t <= 0 || t >= period.asOf || t < ANNUAL_REVIEW_MIN_FACT_MS) return
    times.push(t)
  }
  for (const acc of facts.accounts ?? []) pushStock(acc.createdAt)
  for (const c of annualReviewSignedContractsInRange(period, facts.contracts ?? []).signedInRange) pushInRange(c.signDate)
  for (const row of annualReviewCreditedAllocationsInRange(period, facts.allocations ?? []).rows) pushInRange(row.time)
  const shipped = selectShippedFacts(facts)
  for (const [cid, first] of shipped.firstShipped) {
    if (!inRange(first.time, period.periodStart, period.asOf)) continue
    if (!shipped.contractById.has(cid)) continue
    pushInRange(first.time)
  }
  const messageStatsAvailable = (opts.messageStats ?? null)?.ok === true
  if (!messageStatsAvailable && period.scopeKind !== 'historical_year') {
    for (const ms of selectPerSessionLastContactMs(facts.accounts, opts.exclusions).values()) {
      if (inRange(ms, period.periodStart, period.asOf)) pushInRange(ms)
    }
  }
  return times
}

// ─── 口径子计算（S2 segments 复用同一实现，禁止第二套口径） ───────────────────

export interface SignedContractsInRange {
  /** sign_date 有效且 ∈ [periodStart, asOf) 的合同（A4/A5/A8 与 C1/C3/C4 的同一集合；signDate 已收窄为有效值） */
  signedInRange: Array<AnnualReviewContractFact & { signDate: number }>
  /** signed/shipped 但 sign_date 缺失/非法的数量（partial 依据，禁止回退 created_at） */
  signMissing: number
}

/** A4 签约集合：只认 sign_date 左闭右开；缺失一律不计入（§3.2） */
export function annualReviewSignedContractsInRange(
  period: AnnualReviewPeriod,
  contracts: AnnualReviewContractFact[]
): SignedContractsInRange {
  assertValidPeriod(period)
  const signedInRange: Array<AnnualReviewContractFact & { signDate: number }> = []
  let signMissing = 0
  for (const c of contracts) {
    const sd = asFinite(c.signDate)
    if (sd !== null) {
      if (inRange(sd, period.periodStart, period.asOf)) signedInRange.push({ ...c, signDate: sd })
    } else if (c.status === 'signed' || c.status === 'shipped') {
      signMissing++
    }
  }
  return { signedInRange, signMissing }
}

export interface NewAccountsInRange {
  /** created_at 有效且 ∈ [periodStart, asOf) 的 account（A2 计数与 C2 明细的同一集合） */
  accounts: Array<AnnualReviewAccountFact & { createdAt: number }>
  missingCreatedAt: number
}

/** A2 新增客户集合：created_at 左闭右开；缺 created_at 排除（由调用方告警） */
export function annualReviewNewAccountsInRange(
  period: AnnualReviewPeriod,
  accounts: AnnualReviewAccountFact[]
): NewAccountsInRange {
  assertValidPeriod(period)
  const inRangeAccounts: Array<AnnualReviewAccountFact & { createdAt: number }> = []
  let missingCreatedAt = 0
  for (const acc of accounts) {
    const created = asFinite(acc.createdAt)
    if (created === null) {
      missingCreatedAt++
      continue
    }
    if (inRange(created, period.periodStart, period.asOf)) inRangeAccounts.push({ ...acc, createdAt: created })
  }
  return { accounts: inRangeAccounts, missingCreatedAt }
}

export interface CreditedAllocationRow {
  allocation: AnnualReviewAllocationFact
  /** 有效核销金额（元） */
  amount: number
  /** 计入时间：allocated=reconciled_at；legacy_confirmed 回退 confirmed_at */
  time: number
  viaLegacyFallback: boolean
}

export interface CreditedAllocationsInRange {
  rows: CreditedAllocationRow[]
  legacyFallback: number
  allocatedNoTime: number
  legacyNoTime: number
  creditedInvalid: number
}

/**
 * A6 核销集合（= creditedTotal 同款状态口径 + 时间维度）：
 *   allocated → 仅 reconciled_at（缺失排除计数，不伪造）；legacy_confirmed → reconciled_at
 *   优先、缺失回退 confirmed_at（partial）；confirmed+pending 认领 / conflict / 撤销一概不计。
 */
export function annualReviewCreditedAllocationsInRange(
  period: AnnualReviewPeriod,
  allocations: AnnualReviewAllocationFact[]
): CreditedAllocationsInRange {
  assertValidPeriod(period)
  const rows: CreditedAllocationRow[] = []
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
    if (!inRange(t, period.periodStart, period.asOf)) continue
    if (viaFallback) legacyFallback++
    const amt = asFinite(al.creditedAmount)
    if (amt === null) {
      creditedInvalid++
      continue
    }
    rows.push({ allocation: al, amount: amt, time: t, viaLegacyFallback: viaFallback })
  }
  return { rows, legacyFallback, allocatedNoTime, legacyNoTime, creditedInvalid }
}

export interface CustomerActiveDetail {
  metric: MetricValue<number>
  /** 活跃会话（sessionId 升序）；unavailable 时为 null。C5 明细与 A3 共用同一计算结果 */
  activeSessions: string[] | null
}

/**
 * A3 年度活跃客户完整计算（值 + 状态 + warnings + 活跃会话明细）。
 * 主口径 = CRM 绑定会话（account.session_id，去重）∩ 注入消息统计 sent+received>0；
 * 回退（仅 current_year/all_time）= session 最大有效 last_contact_at（秒×1000）∈ [start, asOf)；
 * historical_year 一律 unavailable（当前投影 ≠ 历史时点）。
 */
export function computeAnnualReviewCustomerActiveDetail(
  period: AnnualReviewPeriod,
  facts: AnnualReviewFacts,
  opts: AnnualReviewComputeOptions = {}
): CustomerActiveDetail {
  assertValidPeriod(period)
  const start = period.periodStart
  const end = period.asOf
  // 有效 CRM 会话总体 = selectCrmBoundSessions 唯一实现（与 D1/D2/D3/D7/dataRange 同源）
  const boundSessions = new Set(selectCrmBoundSessions(facts.accounts, opts.exclusions))
  const a3 = new WarningCollector()
  let activeValue: number | null = null
  let activeSessions: string[] | null = null
  let activeState: MetricState
  const messageStats = opts.messageStats ?? null
  if (messageStats && messageStats.ok) {
    let active = 0
    let sanitized = 0
    const sessions = messageStats.sessions ?? {}
    const activeSet = new Set<string>()
    for (const sid of boundSessions) {
      const stat = sessions[sid]
      if (!stat) continue
      const sent = sanitizeCount(stat.sent)
      const received = sanitizeCount(stat.received)
      if (sent === null || received === null) sanitized++
      if ((sent ?? 0) + (received ?? 0) > 0) {
        active++
        activeSet.add(sid)
      }
    }
    if (sanitized > 0) a3.add('message_stats_invalid', sanitized)
    activeValue = active
    activeSessions = [...activeSet].sort(cmpString)
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
    // 选择逻辑 = selectPerSessionLastContactMs 唯一实现（D7/dataRange 共用）。
    const lastContactBySession = selectPerSessionLastContactMs(facts.accounts, opts.exclusions)
    if (boundSessions.size === 0) {
      // 没有任何符合条件的绑定会话：0 是真实零，但未经消息主口径验证 → 保守 partial
      a3.add('last_contact_fallback')
      activeValue = 0
      activeSessions = []
      activeState = 'partial'
    } else if (lastContactBySession.size === 0) {
      // 有绑定会话但全部无有效 last_contact_at：不得把查询失败显示成 0
      a3.add('customer_active_unavailable')
      activeValue = null
      activeState = 'unavailable'
    } else {
      const activeSet = new Set<string>()
      for (const [sid, ms] of lastContactBySession) {
        if (inRange(ms, start, end)) activeSet.add(sid)
      }
      a3.add('last_contact_fallback')
      activeValue = activeSet.size
      activeSessions = [...activeSet].sort(cmpString)
      activeState = 'partial'
    }
  }
  return { metric: { value: activeValue, state: activeState, warnings: a3.list() }, activeSessions }
}

/** 确定性字符串比较（code-unit 序，跨平台稳定；禁用 localeCompare） */
export function cmpString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
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
  //     集合来自 annualReviewNewAccountsInRange（C2 明细共用同一口径，禁止第二套）。
  const a1 = new WarningCollector()
  const a2 = new WarningCollector()
  let totalBeforeAsOf = 0
  let missingCreatedAt = 0
  for (const acc of accounts) {
    const created = asFinite(acc.createdAt)
    if (created === null) {
      missingCreatedAt++
      continue
    }
    if (created < end) totalBeforeAsOf++
  }
  const newAcc = annualReviewNewAccountsInRange(period, accounts)
  const newInRange = newAcc.accounts.length
  let newImported = 0
  for (const acc of newAcc.accounts) {
    if (asFinite(acc.importedAt) !== null) newImported++
  }
  if (missingCreatedAt > 0) {
    a1.add('account_created_at_missing', missingCreatedAt)
    a2.add('account_created_at_missing', newAcc.missingCreatedAt)
  }
  // 历史年度存量受物理删除影响：一律 partial + tombstone_gap（规格 §5.1 A1）
  if (period.scopeKind === 'historical_year') a1.add('tombstone_gap')
  // 导入建档占比 >50% 才降级；恰好 50% 不降级（整数乘法避免浮点比较）
  if (newInRange > 0 && newImported * 2 > newInRange) a2.add('bulk_import_dominant', newImported)
  const customerTotal = metric(totalBeforeAsOf, a1)
  const customerNew = metric(newInRange, a2)

  // ── A3 customer_active ───────────────────────────────────────────────────
  // 完整计算在 computeAnnualReviewCustomerActiveDetail（C5 明细共用同一结果，禁止第二套）。
  const customerActive = computeAnnualReviewCustomerActiveDetail(period, facts, opts).metric

  // ── A4 contract_count / A5 contract_amount / A8 dealing_customers ────────
  // 签约集合 = annualReviewSignedContractsInRange（C1/C3/C4 共用同一集合，禁止第二套）：
  // 只认 sign_date ∈ [start, asOf)（all_time 即 sign_date < asOf）；
  // sign_date 缺失一律不计（禁止回退 created_at）；signed/shipped 遗留缺失 → partial + 数量。
  const a4 = new WarningCollector()
  const signed = annualReviewSignedContractsInRange(period, contracts)
  const signedInRange = signed.signedInRange
  if (signed.signMissing > 0) a4.add('sign_date_missing', signed.signMissing)
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
  // 口径 = annualReviewCreditedAllocationsInRange（C1 高价值客户共用同一集合，禁止第二套）：
  // creditedTotal 同款状态口径（status='confirmed' AND reconciliation_status IN
  // ('allocated','legacy_confirmed')，规格 §2.3/§5.1）加时间维度：
  //   allocated → 仅 reconciled_at（缺失 → 排除 + 数据异常告警，绝不拿 confirmed_at 伪装）；
  //   legacy_confirmed → reconciled_at 优先，缺失回退 confirmed_at → partial；
  // confirmed+pending（认领）/ conflict / 撤销回 pending 一概不计。
  const a6 = new WarningCollector()
  const credited = annualReviewCreditedAllocationsInRange(period, allocations)
  const creditedAmounts = credited.rows.map((r) => r.amount)
  if (credited.legacyFallback > 0) a6.add('legacy_time_fallback', credited.legacyFallback)
  if (credited.allocatedNoTime > 0) a6.add('allocated_reconciled_at_missing', credited.allocatedNoTime)
  if (credited.legacyNoTime > 0) a6.add('legacy_time_missing', credited.legacyNoTime)
  if (credited.creditedInvalid > 0) a6.add('credited_amount_invalid', credited.creditedInvalid)
  const creditedAmount = metric(deterministicSum(creditedAmounts), a6)

  // ── A7 shippedCount / shippedAmount ──────────────────────────────────────
  // 事实源 contract_status_history：每合同只取全历史第一条 to_status='shipped' 事件，
  // 再判该首条是否落在区间（范围外首条 + 范围内重复事件仍不计）；count/amount 同一集合。
  // 选择逻辑 = selectShippedFacts 唯一实现（dataRange 采用事实共用）。
  const a7 = new WarningCollector()
  const shippedSel = selectShippedFacts(facts)
  const contractById = shippedSel.contractById
  const firstShipped = shippedSel.firstShipped
  let shippedUnlinked = shippedSel.unlinked
  let shippedTimeMissing = shippedSel.timeMissing
  let shippedCount = 0
  const shippedAmounts: number[] = []
  let shippedAmountInvalid = 0
  for (const [cid, first] of firstShipped) {
    if (!inRange(first.time, start, end)) continue
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
    'SELECT id, name, created_at, imported_at, session_id, last_contact_at, owner_sales FROM account'
  ).map<AnnualReviewAccountFact>((r) => ({
    id: numOrNull(r.id) ?? 0,
    name: strOrNull(r.name),
    createdAt: numOrNull(r.created_at),
    importedAt: numOrNull(r.imported_at),
    sessionId: strOrNull(r.session_id),
    lastContactAtSec: numOrNull(r.last_contact_at),
    ownerSales: strOrNull(r.owner_sales)
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
    'SELECT id, contract_id, account_id, credited_amount, status, reconciliation_status, reconciled_at, confirmed_at, sales_name '
    + "FROM allocation WHERE status = 'confirmed' AND reconciliation_status IN ('allocated', 'legacy_confirmed')"
  ).map<AnnualReviewAllocationFact>((r) => ({
    id: numOrNull(r.id) ?? 0,
    contractId: numOrNull(r.contract_id),
    accountId: numOrNull(r.account_id),
    creditedAmount: numOrNull(r.credited_amount),
    status: strOrNull(r.status) ?? '',
    reconciliationStatus: strOrNull(r.reconciliation_status),
    reconciledAt: numOrNull(r.reconciled_at),
    confirmedAt: numOrNull(r.confirmed_at),
    salesName: strOrNull(r.sales_name)
  }))

  const shippedEvents = runner.all<SqlRow>(
    "SELECT id, contract_id, to_status, created_at FROM contract_status_history WHERE to_status = 'shipped'"
  ).map<AnnualReviewShippedEventFact>((r) => ({
    id: numOrNull(r.id) ?? 0,
    contractId: numOrNull(r.contract_id),
    toStatus: strOrNull(r.to_status),
    createdAt: numOrNull(r.created_at)
  }))

  // E3 事实：assignment 认领行（claimed_at 为认领动作一次性写入）+ lead 首触时间
  const assignments = runner.all<SqlRow>(
    'SELECT id, lead_id, sales_name, mode, claimed_at FROM assignment WHERE claimed_at IS NOT NULL'
  ).map<AnnualReviewAssignmentFact>((r) => ({
    id: numOrNull(r.id) ?? 0,
    leadId: numOrNull(r.lead_id),
    salesName: strOrNull(r.sales_name),
    mode: strOrNull(r.mode),
    claimedAt: numOrNull(r.claimed_at)
  }))
  const leads = runner.all<SqlRow>(
    'SELECT id, account_id, first_contacted_at FROM lead'
  ).map<AnnualReviewLeadFact>((r) => ({
    id: numOrNull(r.id) ?? 0,
    accountId: numOrNull(r.account_id),
    firstContactedAt: numOrNull(r.first_contacted_at)
  }))

  // E1 事实：append-only 审计事件（预过滤三类 action；detail JSON 防御性解析，不参与任何 SQL 拼接）
  const auditEvents = runner.all<SqlRow>(
    "SELECT id, action, detail, created_at FROM audit_event WHERE action IN ('lead_assign', 'lead_transfer', 'sync_apply')"
  ).map<AnnualReviewAuditEventFact>((r) => {
    let d: { type?: unknown; salesName?: unknown; toSales?: unknown; fromSales?: unknown; mode?: unknown; assignmentId?: unknown } = {}
    let detailInvalid = false
    const rawDetail = r.detail
    if (rawDetail !== null && rawDetail !== undefined && rawDetail !== '') {
      try {
        const parsed = JSON.parse(String(rawDetail)) as Record<string, unknown>
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          d = parsed as typeof d
        } else {
          detailInvalid = true
        }
      } catch {
        detailInvalid = true
      }
    }
    const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
    return {
      id: numOrNull(r.id) ?? 0,
      action: strOrNull(r.action) ?? '',
      createdAt: numOrNull(r.created_at),
      detailType: detailInvalid ? null : strOrNull(d.type),
      salesName: strOrNull(d.salesName),
      toSales: strOrNull(d.toSales),
      fromSales: strOrNull(d.fromSales),
      mode: strOrNull(d.mode),
      assignmentId: num(d.assignmentId)
    }
  })

  return { accounts, contracts, allocations, shippedEvents, assignments, leads, auditEvents }
}
