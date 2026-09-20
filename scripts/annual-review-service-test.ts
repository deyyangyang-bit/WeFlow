/**
 * annual-review-service-test.ts —— 年度经营复盘 S3 护栏（编排/Worker 边界/IPC 契约/缓存）
 *
 * 覆盖：
 *   1  完整 current_year 报告组装 + 顶层契约（dataRange/completeness/coverage/warnings/sourceSummary）
 *   2  historical_year asOf/边界            3  all_time
 *   4  S1/S2 装配且 warnings/coverage 不丢失  5  D/E 未实现不显示为真实 0
 *   6  非法/未来年份与 IPC 载荷校验          7  getAvailableYears（自然年升序、0 固定末尾/空库/脏时间）
 *   8  缓存命中/TTL/generate 强制重算/失效    9  账号作用域隔离 + FNV 碰撞反例完全隔离
 *   10 同键并发只启动一个任务                11 不同 scope 独立运行
 *   12 旧任务迟到消息不覆盖新任务            13 Worker throw/exit/非法结果/加载失败 → failed
 *   C  取消状态机：loading/computing 取消、Worker 卡死收敛、不缓存、幂等、task_not_found
 *   I  失效竞态：loading/computing 中 invalidate、getAvailableYears 中途 invalidate、账号 A→B 切换
 *   V  validateAnnualReviewReport：{}/错年份/错版本/缺区块/NaN/不可克隆/unavailable 伪装 0
 *   K  契约补全：completeness 聚合、coverage metricKey、warnings 聚合确定性、dataRange、sourceSummary
 *   P  公开报告隐私：无 sessionId/session_id/wxid 原文/路径/SQL/Token/正文（递归扫描）
 *   S  preload 多订阅者独立清理（可注入 IPC renderer 行为测试）
 *   14 progress 单调                          16 事件监听清理函数有效
 *   15 IPC/preload/electron.d.ts 命名与结构化错误一致（源码扫描）
 *   19 Worker 打包接线守卫                    20 reportSchemaVersion 单一来源
 *   21 真实 Worker 文件端到端 + 结果过运行时校验
 *
 * 竞态测试全部使用 deferred promise/可注入依赖（无真实 sleep）；数据库/Worker 经窄接口
 * 注入假实现，不访问真实用户数据库。运行：npx tsx scripts/annual-review-service-test.ts
 */
import { readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import {
  resolveAnnualReviewPeriod,
  type AnnualReviewFacts,
  type AnnualReviewMessageStats
} from '../electron/services/annualReviewStats'
import type { AnnualReviewSalesSegmentsFacts, AnnualReviewCrmSegmentsFacts } from '../electron/services/annualReviewSegments'
import {
  composeAnnualReviewReport,
  computeAnnualReviewAvailableYears,
  validateAnnualReviewReport,
  validateAnnualReviewYearInput,
  validateAnnualReviewTaskId,
  aggregateMetricStates,
  type AnnualReviewReport
} from '../electron/services/annualReviewReport'
import {
  AnnualReviewService,
  buildAccountScopeId,
  createThreadRunner,
  type AnnualReviewWorkerPayload,
  type AnnualReviewWorkerRunner,
  type AnnualReviewProgressEvent,
  type AnnualReviewAccountContext
} from '../electron/services/annualReviewService'
import { subscribeIpcEvent, type IpcEventRegistrar } from '../electron/services/ipcEventSubscription'

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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const T = (y: number, m: number, d: number, hh = 0, mm = 0, ss = 0, ms = 0): number =>
  new Date(y, m - 1, d, hh, mm, ss, ms).getTime()
const GEN = T(2026, 6, 15, 12, 0, 0)
/** 让出微任务/定时器队列：generate 内部异步链跑到位后再操纵假 runner */
const tick = (): Promise<void> => new Promise((r) => setImmediate(r))

/** deferred promise：竞态测试用（不真实 sleep） */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

// ── 夹具 ─────────────────────────────────────────────────────────────────────
const emptyFacts = (): AnnualReviewFacts => ({ accounts: [], contracts: [], allocations: [], shippedEvents: [] })
const emptySales = (): AnnualReviewSalesSegmentsFacts => ({ profiles: [], intentEvents: [] })
const emptyCrm = (): AnnualReviewCrmSegmentsFacts => ({ opportunities: [], opportunityEvents: [] })

const accF = (id: number, sessionId: string | null, extra: Partial<AnnualReviewFacts['accounts'][number]> = {}) =>
  ({ id, name: `客户${id}`, createdAt: T(2024, 1, 1), importedAt: null, sessionId, lastContactAtSec: null, ...extra })
const conF = (id: number, accountId: number | null, signDate: number | null, amount: number | null, status = 'signed') =>
  ({ id, accountId, amount, status, signDate, createdAt: T(2024, 1, 1) })
const allocF = (id: number, accountId: number | null, creditedAmount: number | null, reconciledAt: number | null, reconciliationStatus = 'allocated', confirmedAt: number | null = null) =>
  ({ id, accountId, creditedAmount, reconciledAt, status: 'confirmed', reconciliationStatus, confirmedAt, contractId: 1 })
const profF = (id: number, sessionId: string | null, stage: string | null, lastContactAtSec: number | null = null, customerId: string | null = null) =>
  ({ id, sessionId, stage, lastContactAtSec, customerId })
const ievF = (id: number, sessionId: string | null, stage: string | null, createdAt: number | null) =>
  ({ id, sessionId, stage, createdAt })
const oppF = (id: number, stage: string | null, status: string | null, createdAt: number | null) =>
  ({ id, accountId: 1, stage, status, createdAt })
const oevF = (id: number, opportunityId: number, eventType: string | null, stage: string | null, detail: string | null, createdAt: number | null) =>
  ({ id, opportunityId, eventType, stage, detail, createdAt })

/** 标准多源夹具：S1 金额 + S2 阶段 + 非法事件 + C6/C8 画像行 + profile-only 客户（身份映射用） */
function richFacts(): { facts: AnnualReviewFacts; sales: AnnualReviewSalesSegmentsFacts; crm: AnnualReviewCrmSegmentsFacts } {
  const facts: AnnualReviewFacts = {
    accounts: [
      accF(1, 'wx_a', { createdAt: T(2025, 2, 1), lastContactAtSec: Math.floor(T(2026, 2, 1) / 1000) }),
      accF(2, 'wx_b', { createdAt: T(2024, 3, 1) })
    ],
    contracts: [conF(1, 1, T(2025, 3, 1), 1200), conF(2, 2, T(2024, 6, 1), 500)],
    allocations: [allocF(1, 1, 800.5, T(2025, 4, 1))],
    shippedEvents: []
  }
  const sales: AnnualReviewSalesSegmentsFacts = {
    profiles: [
      profF(1, 'wx_a', 'quoted', Math.floor(T(2026, 1, 5) / 1000), '501'),
      profF(2, 'wx_b', '决策', Math.floor(T(2026, 6, 10) / 1000)),
      profF(3, 'wx_profile_only', 'contacted', Math.floor(T(2026, 2, 1) / 1000), '777')
    ],
    intentEvents: [
      ievF(1, 'wx_a', 'contacted', T(2025, 2, 1)),
      ievF(2, 'wx_a', 'quoted', T(2025, 3, 1)),
      ievF(3, 'wx_a', '垃圾stage', T(2025, 3, 15)), // 非法阶段 → 告警透传（不覆盖合法阶段）
      ievF(4, 'wx_b', 'negotiating', T(2025, 4, 1))
    ]
  }
  const crm: AnnualReviewCrmSegmentsFacts = {
    opportunities: [oppF(1, '了解', 'active', T(2024, 6, 1)), oppF(2, '了解', 'won', T(2024, 7, 1))],
    opportunityEvents: [
      oevF(1, 1, 'created', '了解', '', T(2025, 1, 2)),
      oevF(2, 2, 'won', '了解', '人工登记成交', T(2025, 5, 1))
    ]
  }
  return { facts, sales, crm }
}

const messageStatsOk = (sessions: Record<string, { sent: number; received: number }> = {}): AnnualReviewMessageStats =>
  ({ ok: true, sessions })

/** 真实组装一份小报告（假 runner 用它 resolve，缓存里存的是真报告结构） */
const buildRealReport = (): AnnualReviewReport => {
  const { facts, sales, crm } = richFacts()
  return composeAnnualReviewReport({
    period: resolveAnnualReviewPeriod(2026, GEN), facts, sales, crm,
    opts: { messageStats: messageStatsOk({ wx_a: { sent: 1, received: 0 } }) }
  })
}

/** 另一份内容不同的合法报告（customerTotal=1；用于作用域隔离断言） */
const buildRealReportB = (): AnnualReviewReport => {
  const { facts, sales, crm } = richFacts()
  return composeAnnualReviewReport({
    period: resolveAnnualReviewPeriod(2026, GEN),
    facts: { ...facts, accounts: facts.accounts.slice(0, 1) },
    sales, crm,
    opts: { messageStats: messageStatsOk({}) }
  })
}

// ── 假 runner（手工驱动 resolve/reject/onProgress） ──────────────────────────
interface FakeCall {
  payload: AnnualReviewWorkerPayload
  onProgress: (p: { progress: number; statusText?: string }) => void
  resolve: (r: AnnualReviewReport) => void
  reject: (e: unknown) => void
}

function createFakeRunner() {
  const calls: FakeCall[] = []
  const runner: AnnualReviewWorkerRunner = {
    run(payload, onProgress) {
      return new Promise<AnnualReviewReport>((resolve, reject) => {
        calls.push({ payload, onProgress, resolve, reject })
      })
    },
    cancel(taskId) {
      const call = calls.find((c) => c.payload.taskId === taskId)
      if (call) call.reject(Object.assign(new Error('已取消'), { code: 'cancelled' }))
    }
  }
  return { runner, calls }
}

interface Harness {
  service: AnnualReviewService
  ctxBox: { current: AnnualReviewAccountContext }
  getLoadCount: () => number
}

function createService(opts?: {
  ctx?: Partial<AnnualReviewAccountContext>
  runner?: AnnualReviewWorkerRunner
  loadFactsFail?: boolean
  messageStatsFail?: boolean
  now?: () => number
  /** 竞态测试注入：覆盖事实加载（deferred/永不收敛等） */
  overrides?: Partial<{
    loadFacts: () => Promise<AnnualReviewFacts>
    loadSalesSegments: () => Promise<AnnualReviewSalesSegmentsFacts>
    loadCrmSegments: () => Promise<AnnualReviewCrmSegmentsFacts>
  }>
}): Harness {
  const ctxBox: { current: AnnualReviewAccountContext } = {
    current: {
      wxid: opts?.ctx?.wxid ?? 'wx_account_a',
      salesDbName: opts?.ctx?.salesDbName ?? 'weflow-sales-wx_account_a.db',
      crmDbName: opts?.ctx?.crmDbName ?? 'weflow-crm-wx_account_a.db',
      exclusions: opts?.ctx?.exclusions ?? { manualSessions: ['wx_manual'], internalSessions: ['wx_internal'] }
    }
  }
  let loadCount = 0
  const rich = richFacts()
  const deps = {
    loadFacts: opts?.overrides?.loadFacts ?? (async (): Promise<AnnualReviewFacts> => {
      loadCount++
      if (opts?.loadFactsFail) throw new Error('db closed')
      return rich.facts
    }),
    loadSalesSegments: opts?.overrides?.loadSalesSegments ?? (async () => {
      loadCount++
      if (opts?.loadFactsFail) throw new Error('db closed')
      return rich.sales
    }),
    loadCrmSegments: opts?.overrides?.loadCrmSegments ?? (async () => {
      loadCount++
      if (opts?.loadFactsFail) throw new Error('db closed')
      return rich.crm
    }),
    loadMessageStats: async (): Promise<AnnualReviewMessageStats> => {
      if (opts?.messageStatsFail) throw new Error('wcdb down')
      return messageStatsOk({ wx_a: { sent: 1, received: 0 } })
    },
    getAccountContext: (): AnnualReviewAccountContext => ctxBox.current,
    runner: opts?.runner,
    now: opts?.now
  }
  return { service: new AnnualReviewService(deps), ctxBox, getLoadCount: () => loadCount }
}

async function main(): Promise<void> {
  const { facts, sales, crm } = richFacts()

  // ══ 1 完整 current_year 报告组装 + 顶层契约 ═══════════════════════════════
  {
    const period = resolveAnnualReviewPeriod(2026, GEN)
    const report = composeAnnualReviewReport({
      period, facts, sales, crm,
      opts: { messageStats: messageStatsOk({ wx_a: { sent: 2, received: 1 } }) }
    })
    ok('1 reportSchemaVersion/year/scopeKind/时区', report.reportSchemaVersion === 1 &&
      report.year === 2026 && report.scopeKind === 'current_year' && report.timezoneNote === 'local')
    ok('1b 时间契约（periodStart/asOf/generatedAt）', report.periodStart === T(2026, 1, 1) && report.asOf === GEN && report.generatedAt === GEN)
    ok('1c summary A1（存量=2）/A4（2026 无签约 → 真实零）', report.summary.customerTotal.value === 2 && report.summary.contractCount.value === 0)
    ok('1d funnel.customerStage 当前快照（比价1）', report.funnel.customerStage.kind === 'current_snapshot' &&
      report.funnel.customerStage.distribution?.find((b) => b.bucket === '比价')?.count === 1)
    ok('1e customers.active=A3 主口径（映射为 accountId=1，无 sessionId）', report.customers.active.value?.length === 1 &&
      report.customers.active.value?.[0].accountId === 1 && report.customers.active.value?.[0].name === '客户1' &&
      !('sessionId' in (report.customers.active.value?.[0] as object)))
    ok('1f customers.priority current_year 可用（C8，映射 accountId=2）', report.customers.priority.coverage.status === 'partial' &&
      report.customers.priority.value?.length === 1 && report.customers.priority.value?.[0].accountId === 2)
    ok('1g 顶层契约 19 键（含 dataRange/completeness/coverage/warnings/sourceSummary）',
      Object.keys(report).length === 19 &&
      ['dataRange', 'completeness', 'coverage', 'warnings', 'sourceSummary'].every((k) => k in report))
    ok('1h 报告过运行时结构校验', validateAnnualReviewReport(report, 2026).ok === true)
  }

  // ══ 2 historical_year asOf/边界 ═══════════════════════════════════════════
  {
    const period = resolveAnnualReviewPeriod(2025, GEN)
    const report = composeAnnualReviewReport({ period, facts, sales, crm, opts: { messageStats: messageStatsOk({ wx_a: { sent: 1, received: 0 } }) } })
    ok('2 历史年度 asOf=periodEndExclusive', report.scopeKind === 'historical_year' && report.asOf === T(2026, 1, 1) && report.asOf === report.periodEndExclusive)
    ok('2b 历史年度 A4=1 / A6=800.5', report.summary.contractCount.value === 1 && report.summary.creditedAmount.value === 800.5)
    ok('2c B1 历史重建（2/2 会话有事件）', report.funnel.customerStage.kind === 'historical_reconstruction' &&
      report.funnel.customerStage.coverage.status === 'partial' && report.funnel.customerStage.coverage.coverageRatio === 1)
    ok('2d C8 历史年度 unavailable/unsupported_scope', report.customers.priority.value === null &&
      report.customers.priority.coverage.status === 'unavailable')
    ok('2e B6 历史年度 unavailable', report.funnel.stuck.value === null && report.funnel.stuck.coverage.status === 'unavailable')
    ok('2f 历史年度报告过运行时校验', validateAnnualReviewReport(report, 2025).ok === true)
  }

  // ══ 3 all_time ════════════════════════════════════════════════════════════
  {
    const period = resolveAnnualReviewPeriod(0, GEN)
    const report = composeAnnualReviewReport({ period, facts, sales, crm, opts: { messageStats: messageStatsOk({ wx_a: { sent: 1, received: 0 } }) } })
    ok('3 all_time 边界（periodStart/End null、asOf=generatedAt）',
      report.scopeKind === 'all_time' && report.periodStart === null && report.periodEndExclusive === null && report.asOf === GEN)
    ok('3b all_time A4=全部签约（2）', report.summary.contractCount.value === 2)
    ok('3c all_time C8 unsupported_scope', report.customers.priority.coverage.status === 'unavailable' &&
      report.customers.priority.coverage.reasonCodes?.includes('unsupported_scope'))
    ok('3d all_time 报告过运行时校验', validateAnnualReviewReport(report, 0).ok === true)
  }

  // ══ 4 S1/S2 装配 + warnings/coverage 不丢失 ═══════════════════════════════
  {
    const factsWithLegacy: AnnualReviewFacts = {
      ...facts,
      allocations: [...facts.allocations, allocF(9, 2, 300, null, 'legacy_confirmed', T(2025, 5, 1))]
    }
    const report = composeAnnualReviewReport({
      period: resolveAnnualReviewPeriod(2025, GEN), facts: factsWithLegacy, sales, crm,
      opts: { messageStats: messageStatsOk({ wx_a: { sent: 1, received: 0 } }) }
    })
    ok('4 A6 legacy 回退告警原样透传', report.summary.creditedAmount.warnings.some((w) => w.code === 'legacy_time_fallback'))
    ok('4b C1 继承同一 legacy 告警（不丢失）', report.customers.highValue.warnings.some((w) => w.code === 'legacy_time_fallback'))
    ok('4c intent 垃圾阶段告警透传到 B3', report.funnel.stageFlow.warnings.some((w) => w.code === 'intent_event_stage_invalid'))
    ok('4d B1 coverage.reasonCodes 来自统计层（重建说明）', report.funnel.customerStage.coverage.reasonCodes?.includes('history_reconstruction_not_complete'))
    ok('4e A 组 coverage 单一映射（status=metric.state、reasonCodes=warnings codes）',
      report.coverage['summary.creditedAmount'].status === report.summary.creditedAmount.state &&
      report.coverage['summary.creditedAmount'].reasonCodes?.includes('legacy_time_fallback') === true &&
      report.coverage['summary.creditedAmount'].source === 'crmdb.allocation')
    ok('4f warnings 聚合含 legacy_time_fallback（counts 按指标拆分）', (() => {
      const row = report.warnings.find((w) => w.code === 'legacy_time_fallback')
      return row !== undefined && row.metricKeys.includes('summary.creditedAmount') && row.metricKeys.includes('customers.highValue') &&
        row.counts?.['summary.creditedAmount'] === 1 && row.counts?.['customers.highValue'] === 1
    })())
  }

  // ══ 5 D/E 未实现 → 显式 unavailable，非 0/空数组 ══════════════════════════
  {
    const report = composeAnnualReviewReport({
      period: resolveAnnualReviewPeriod(2026, GEN), facts, sales, crm, opts: { messageStats: { ok: false, sessions: {} } }
    })
    for (const block of ['monthly', 'communication', 'salesAssignment'] as const) {
      const b = report[block]
      ok(`5 ${block} unavailable + metric_not_implemented`, b.status === 'unavailable' && b.reasonCodes.length === 1 && b.reasonCodes[0] === 'metric_not_implemented')
      ok(`5b coverage.${block} 同步 unavailable`, report.coverage[block].status === 'unavailable')
    }
    ok('5c completeness.blocks 未实现区块恒 unavailable（不得伪装 complete）',
      report.completeness.blocks.monthly === 'unavailable' && report.completeness.blocks.communication === 'unavailable' &&
      report.completeness.blocks.salesAssignment === 'unavailable' && report.completeness.overall === 'unavailable')
  }

  // ══ 17/18 序列化与敏感信息（递归扫描） ════════════════════════════════════
  {
    const report = composeAnnualReviewReport({
      period: resolveAnnualReviewPeriod(2025, GEN), facts, sales, crm, opts: { messageStats: messageStatsOk({ wx_a: { sent: 1, received: 0 } }) }
    })
    const cloned = structuredClone(report)
    ok('17 structuredClone 深拷贝一致', JSON.stringify(cloned) === JSON.stringify(report))
    ok('17b JSON 往返一致', JSON.stringify(JSON.parse(JSON.stringify(report))) === JSON.stringify(report))

    // 递归检查：键与字符串值双层扫描
    const keys = new Set<string>()
    const strings = new Set<string>()
    const walk = (v: unknown): void => {
      if (v === null || typeof v !== 'object') {
        if (typeof v === 'string') strings.add(v)
        return
      }
      if (Array.isArray(v)) { v.forEach(walk); return }
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        keys.add(k)
        walk(val)
      }
    }
    walk(report)
    const badKeys = [...keys].filter((k) => k === 'sessionId' || k === 'session_id')
    ok('18 递归键扫描：无 sessionId/session_id 键', badKeys.length === 0)
    const forbidden = ['wx_a', 'wx_b', 'wx_profile_only', 'wx_account', '.db', 'SELECT', 'token', 'decryptKey', '/Users/', 'at Object', '客户1原话正文canary']
    const badStrings = [...strings].filter((s) => forbidden.some((f) => s.includes(f)))
    ok('18b 递归值扫描：无客户/当前账号 wxid 原文、路径、SQL、Token、堆栈、正文', badStrings.length === 0)
  }

  // ══ 6 年份/载荷运行时校验 ═════════════════════════════════════════════════
  {
    ok('6 合法：当年/历史年/0', validateAnnualReviewYearInput(2026, GEN).ok === true &&
      validateAnnualReviewYearInput(2020, GEN).ok === true && validateAnnualReviewYearInput(0, GEN).ok === true)
    ok('6b 未来年份拒绝', validateAnnualReviewYearInput(2027, GEN).ok === false &&
      validateAnnualReviewYearInput(2027, GEN).code === 'future_year')
    const bads: Array<[string, unknown]> = [
      ['字符串', '2026'], ['小数', 2026.5], ['NaN', Number.NaN], ['Infinity', Number.POSITIVE_INFINITY],
      ['负数', -1], ['null', null], ['undefined', undefined], ['对象', { year: 2026 }], ['超大', 10000]
    ]
    for (const [label, bad] of bads) {
      const r = validateAnnualReviewYearInput(bad, GEN)
      ok(`6c 非法年份拒绝：${label}`, r.ok === false && r.code === 'invalid_year')
    }
    ok('6d taskId 校验', validateAnnualReviewTaskId('ar-1') === true && validateAnnualReviewTaskId('') === false &&
      validateAnnualReviewTaskId('x'.repeat(200)) === false && validateAnnualReviewTaskId(42 as never) === false)
  }

  // ══ 7 getAvailableYears（纯函数；自然年升序、0 固定末尾） ═════════════════
  {
    const empty = computeAnnualReviewAvailableYears({ facts: emptyFacts(), sales: emptySales(), crm: emptyCrm(), generatedAt: GEN })
    ok('7 空库：years=[]、supportsAllTime=false、defaultYear=当年', empty.years.length === 0 && empty.supportsAllTime === false && empty.defaultYear === 2026)
    const full = computeAnnualReviewAvailableYears({ facts, sales, crm, generatedAt: GEN })
    eq('7b 多年份：自然年升序、0（历史以来）固定末尾', full.years.map((y) => y.year), [2024, 2025, 0])
    ok('7c currentYear/supportsAllTime', full.currentYear === 2026 && full.supportsAllTime === true)
    const y2025 = full.years.find((y) => y.year === 2025)
    ok('7d 年份覆盖摘要 rows/from/to（2025：建档+签约+核销+4 事件 = 7）', y2025 !== undefined && y2025.coverage.rows === 7 &&
      y2025.coverage.coverageFrom === T(2025, 2, 1) && y2025.coverage.coverageTo === T(2025, 4, 1) &&
      y2025.coverage.status === 'complete')
    // 脏时间：秒值、未来值、NaN/null 不生成候选
    const dirty = computeAnnualReviewAvailableYears({
      facts: {
        accounts: [
          accF(1, null, { createdAt: 1_700_000_000 }),            // 秒值 → 荒谬年份 → 排除
          accF(2, null, { createdAt: T(2025, 6, 1) }),            // 合法
          accF(3, null, { createdAt: T(2026, 7, 1) }),            // 晚于 generatedAt → 排除
          accF(4, null, { createdAt: Number.NaN }),               // 非法
          accF(5, null, { createdAt: null })                      // 缺失
        ],
        contracts: [], allocations: [], shippedEvents: []
      },
      sales: { profiles: [], intentEvents: [{ id: 1, sessionId: null, stage: 'won', createdAt: 2_500_000_000 }] }, // 秒值 → 排除
      crm: emptyCrm(),
      generatedAt: GEN
    })
    eq('7e 秒/毫秒混存与非法时间不生成荒谬年份', dirty.years.map((y) => y.year), [2025, 0])
  }

  // ══ 8 缓存：miss → generate → hit → TTL → stale → 强制重算 ═══════════════
  let clock = GEN
  const now = (): number => clock
  const realReport = buildRealReport()
  {
    const fake = createFakeRunner()
    const { service } = createService({ runner: fake.runner, now })
    ok('8 初次 miss', service.getReport(2026).cache === 'miss')
    const gen1 = service.generate(2026)
    await tick()
    const call1 = fake.calls[0]
    ok('8b Worker 载荷：taskId/版本/不含账号原文', call1.payload.taskId.length > 0 &&
      call1.payload.reportSchemaVersion === 1 && !JSON.stringify(call1.payload).includes('wx_account'))
    call1.onProgress({ progress: 60, statusText: '计算中' })
    call1.resolve(realReport)
    const r1 = await gen1
    ok('8c generate 成功 + taskId', r1.success === true && typeof r1.taskId === 'string')
    ok('8d hit 且为同一报告', service.getReport(2026).cache === 'hit' &&
      JSON.stringify(service.getReport(2026).report) === JSON.stringify(realReport))
    clock += 5 * 60_000
    ok('8e 5 分钟后仍 hit', service.getReport(2026).cache === 'hit')
    clock += 6 * 60_000
    const stale = service.getReport(2026)
    ok('8f 11 分钟后 stale（明确区分，不回退他账号）', stale.cache === 'stale' && stale.report === undefined)
    const g2 = service.generate(2026)
    await tick()
    fake.calls[1].resolve(realReport)
    await g2
    ok('8g generate 强制重算（第 2 次 Worker）且覆盖后 hit', fake.calls.length === 2 && service.getReport(2026).cache === 'hit')
  }

  // ══ 9 账号作用域隔离 + FNV 碰撞反例完全隔离 ═══════════════════════════════
  {
    const fakeB = createFakeRunner()
    const svcB = createService({
      runner: fakeB.runner, now,
      ctx: { wxid: 'wx_account_b', salesDbName: 'weflow-sales-wx_account_b.db', crmDbName: 'weflow-crm-wx_account_b.db' }
    })
    const gb = svcB.service.generate(2026)
    await tick()
    fakeB.calls[0].resolve(buildRealReport())
    await gb
    ok('9 账号 B 生成后 hit', svcB.service.getReport(2026).cache === 'hit')
    svcB.ctxBox.current = { wxid: 'wx_account_a', salesDbName: 'weflow-sales-wx_account_a.db', crmDbName: 'weflow-crm-wx_account_a.db', exclusions: {} }
    ok('9b 切到账号 A 作用域：B 的报告不可见（miss，绝不回退）', svcB.service.getReport(2026).cache === 'miss')
    ok('9c scopeId 派生区分账号/库身份', buildAccountScopeId({ wxid: 'a', salesDbName: 's1', crmDbName: 'c1' }) !==
      buildAccountScopeId({ wxid: 'b', salesDbName: 's2', crmDbName: 'c2' }) &&
      buildAccountScopeId({ wxid: 'a', salesDbName: 's1', crmDbName: 'c1' }) !==
      buildAccountScopeId({ wxid: 'a', salesDbName: 's1x', crmDbName: 'c1' }))

    // 反例（fb7f87b 上失败）：真实业务库命名格式的两个 wxid 曾同得 as-1a2962a7
    const idA = buildAccountScopeId({
      wxid: 'wxid_14zh58a1akgt75',
      salesDbName: 'weflow-sales-wxid_14zh58a1akgt75.db',
      crmDbName: 'weflow-crm-wxid_14zh58a1akgt75.db'
    })
    const idB = buildAccountScopeId({
      wxid: 'wxid_1lbiz4e2fzwwl',
      salesDbName: 'weflow-sales-wxid_1lbiz4e2fzwwl.db',
      crmDbName: 'weflow-crm-wxid_1lbiz4e2fzwwl.db'
    })
    ok('9d 碰撞反例：两个真实命名 wxid 的内部作用域不同（无哈希折叠碰撞面）', idA !== idB)
    // 复合键无长度歧义（JSON 编码自描述）
    ok('9d2 复合键无分段歧义（["a","bc"] ≠ ["ab","c"]）', buildAccountScopeId({ wxid: 'a', salesDbName: 'bc', crmDbName: '' }) !==
      buildAccountScopeId({ wxid: 'ab', salesDbName: 'c', crmDbName: '' }))

    // 行为级：碰撞账号在同一服务内各自生成、各自命中（旧实现会合并等待同一任务）
    const fakeC = createFakeRunner()
    const ctxA = { wxid: 'wxid_14zh58a1akgt75', salesDbName: 'weflow-sales-wxid_14zh58a1akgt75.db', crmDbName: 'weflow-crm-wxid_14zh58a1akgt75.db', exclusions: {} }
    const ctxB2 = { wxid: 'wxid_1lbiz4e2fzwwl', salesDbName: 'weflow-sales-wxid_1lbiz4e2fzwwl.db', crmDbName: 'weflow-crm-wxid_1lbiz4e2fzwwl.db', exclusions: {} }
    const svcC = createService({ runner: fakeC.runner, now, ctx: ctxA })
    const gA = svcC.service.generate(2026)
    await tick()
    fakeC.calls[0].resolve(buildRealReport())
    const rA = await gA
    svcC.ctxBox.current = ctxB2
    const gB = svcC.service.generate(2026)
    await tick()
    ok('9e 碰撞账号 B 启动第二个 Worker（不合并 A 的任务）', fakeC.calls.length === 2)
    fakeC.calls[1].resolve(buildRealReportB())
    const rB = await gB
    ok('9f B 未合并等待（reused 非 true）且成功', rB.success === true && rB.reused !== true)
    ok('9g B 命中 B 的报告（customerTotal=1）', svcC.service.getReport(2026).cache === 'hit' &&
      svcC.service.getReport(2026).report?.summary.customerTotal.value === 1)
    svcC.ctxBox.current = ctxA
    ok('9h 切回 A 命中 A 的报告（customerTotal=2，绝不串缓存）', svcC.service.getReport(2026).cache === 'hit' &&
      svcC.service.getReport(2026).report?.summary.customerTotal.value === 2)
  }

  // ══ 10 同键并发只启动一个任务 ═════════════════════════════════════════════
  {
    const fakeC = createFakeRunner()
    const svcC = createService({ runner: fakeC.runner, now })
    const g1 = svcC.service.generate(2026)
    await tick()
    const g2 = svcC.service.generate(2026)
    fakeC.calls[0].resolve(buildRealReport())
    const [r1, r2] = await Promise.all([g1, g2])
    ok('10 同键两次 generate 只启动一个 Worker', fakeC.calls.length === 1)
    ok('10b 第二次合并等待（reused=true、同 taskId）', r2.reused === true && r1.taskId === r2.taskId && r1.success && r2.success)
  }

  // ══ 11 不同 scope 独立运行 ════════════════════════════════════════════════
  {
    const fakeD = createFakeRunner()
    const svcD = createService({ runner: fakeD.runner, now })
    const g1 = svcD.service.generate(2026)
    await tick()
    const g2 = svcD.service.generate(2025)
    await tick()
    fakeD.calls[0].resolve(buildRealReport())
    fakeD.calls[1].resolve(buildRealReport())
    await Promise.all([g1, g2])
    ok('11 不同年份各启动一个 Worker（互不合并）', fakeD.calls.length === 2)
  }

  // ══ 12 旧任务迟到消息不覆盖新任务 ═════════════════════════════════════════
  {
    const fakeE = createFakeRunner()
    const svcE = createService({ runner: fakeE.runner, now })
    const events: AnnualReviewProgressEvent[] = []
    svcE.service.onProgress((e) => events.push(e))
    const gA = svcE.service.generate(2026)
    await tick()
    const callA = fakeE.calls[0]
    callA.onProgress({ progress: 50 })
    callA.reject(Object.assign(new Error('已取消'), { code: 'cancelled' }))
    const rA = await gA
    ok('12 A 取消后 failed + cancelled', rA.success === false && svcE.service.getTaskState(2026)?.error?.code === 'cancelled')
    const gB = svcE.service.generate(2026)
    await tick()
    const callB = fakeE.calls[1]
    callB.onProgress({ progress: 45 })
    callA.onProgress({ progress: 99 }) // 迟到消息：A 的 taskId，必须被丢弃
    callB.resolve(buildRealReport())
    const rB = await gB
    const stateB = svcE.service.getTaskState(2026)
    ok('12b 迟到消息未污染新任务（B completed、无 99 进度事件）', rB.success === true &&
      stateB?.status === 'completed' && events.every((e) => e.taskId !== callA.payload.taskId || e.progress <= 50))
    // 单调：同 taskId 内 progress 不回退
    ok('12c 同任务 progress 单调', events.every((e, i, arr) => i === 0 || e.taskId !== arr[i - 1].taskId || e.progress >= arr[i - 1].progress))
  }

  // ══ 13 Worker throw/exit/非法结果/加载失败 → failed ═══════════════════════
  {
    const throwRunner: AnnualReviewWorkerRunner = { run: () => { throw new Error('spawn failed') } }
    const svcThrow = createService({ runner: throwRunner, now })
    const rt = await svcThrow.service.generate(2026)
    ok('13 同步 throw → failed', rt.success === false && svcThrow.service.getTaskState(2026)?.status === 'failed')

    const exitRunner: AnnualReviewWorkerRunner = { run: () => Promise.reject(Object.assign(new Error('exit 1'), { code: 'worker_exit' })) }
    const svcExit = createService({ runner: exitRunner, now })
    const re = await svcExit.service.generate(2026)
    ok('13b exit 无结果 → failed', re.success === false && svcExit.service.getTaskState(2026)?.status === 'failed')

    // 非法 Worker 结果反例集：{} / 42 / NaN / 错年份 / 错 schemaVersion —— 全部 invalid_worker_result 且不写缓存
    const junkRunner: AnnualReviewWorkerRunner = { run: () => Promise.resolve(42 as never) }
    const svcJunk = createService({ runner: junkRunner, now })
    const rj = await svcJunk.service.generate(2026)
    ok('13c 非法结果 → failed（invalid_worker_result）', rj.success === false &&
      svcJunk.service.getTaskState(2026)?.error?.code === 'invalid_worker_result')

    const emptyRunner: AnnualReviewWorkerRunner = { run: () => Promise.resolve({} as never) }
    const svcEmpty = createService({ runner: emptyRunner, now })
    const rEmpty = await svcEmpty.service.generate(2026)
    ok('13c2 {} 不被缓存且任务 failed', rEmpty.success === false &&
      svcEmpty.service.getTaskState(2026)?.error?.code === 'invalid_worker_result' && svcEmpty.service.getReport(2026).cache === 'miss')

    const nanReport = { ...realReport, summary: { ...realReport.summary, customerTotal: { ...realReport.summary.customerTotal, value: Number.NaN } } }
    const nanRunner: AnnualReviewWorkerRunner = { run: () => Promise.resolve(nanReport as never) }
    const svcNan = createService({ runner: nanRunner, now })
    const rNan = await svcNan.service.generate(2026)
    ok('13c3 NaN 报告拒绝且不缓存', rNan.success === false && svcNan.service.getReport(2026).cache === 'miss')

    const wrongYearReport = { ...composeAnnualReviewReport({ period: resolveAnnualReviewPeriod(2025, GEN), facts, sales, crm }) }
    const wrongYearRunner: AnnualReviewWorkerRunner = { run: () => Promise.resolve(wrongYearReport as never) }
    const svcWrongYear = createService({ runner: wrongYearRunner, now })
    const rWrongYear = await svcWrongYear.service.generate(2026)
    ok('13c4 错误年份报告拒绝', rWrongYear.success === false &&
      svcWrongYear.service.getTaskState(2026)?.error?.code === 'invalid_worker_result')

    const wrongVersionReport = { ...realReport, reportSchemaVersion: 99 }
    const wrongVersionRunner: AnnualReviewWorkerRunner = { run: () => Promise.resolve(wrongVersionReport as never) }
    const svcWrongVersion = createService({ runner: wrongVersionRunner, now })
    const rWrongVersion = await svcWrongVersion.service.generate(2026)
    ok('13c5 错误 schemaVersion 拒绝', rWrongVersion.success === false &&
      svcWrongVersion.service.getTaskState(2026)?.error?.code === 'invalid_worker_result')

    const svcLoad = createService({ runner: createFakeRunner().runner, now, loadFactsFail: true })
    const rl = await svcLoad.service.generate(2026)
    ok('13d 事实加载失败 → fact_load_failed', rl.success === false &&
      svcLoad.service.getTaskState(2026)?.error?.code === 'fact_load_failed')

    // WCDB 失败不阻断生成（A3 回退/降级由统计层裁决）
    const fakeM = createFakeRunner()
    const svcM = createService({ runner: fakeM.runner, now, messageStatsFail: true })
    const rm = svcM.service.generate(2026)
    await tick()
    fakeM.calls[0].resolve(buildRealReport())
    const rM = await rm
    ok('13e 消息统计失败仍生成（A3 裁决在统计层）', rM.success === true)
  }

  // ══ C 取消状态机（loading/computing 都有效） ══════════════════════════════
  {
    // C1 loading 阶段取消：Worker 未启动、收敛 cancelled、不缓存、迟到加载结果被丢弃
    const gate = deferred<AnnualReviewFacts>()
    const fake1 = createFakeRunner()
    const svc1 = createService({ runner: fake1.runner, now, overrides: { loadFacts: () => gate.promise } })
    const events1: AnnualReviewProgressEvent[] = []
    svc1.service.onProgress((e) => events1.push(e))
    const g1 = svc1.service.generate(2026)
    await tick()
    ok('C1 loading 阶段 Worker 未启动', fake1.calls.length === 0)
    const taskId1 = svc1.service.getTaskState(2026)?.taskId ?? ''
    const c1 = svc1.service.cancel(taskId1)
    const r1 = await g1
    ok('C1b cancel 成功且 generate 返回 success:false/cancelled', c1.success === true && r1.success === false &&
      r1.error?.code === 'cancelled' && r1.taskId === taskId1)
    ok('C1c 任务收敛 failed/done=true', svc1.service.getTaskState(2026)?.status === 'failed' &&
      svc1.service.getTaskState(2026)?.error?.code === 'cancelled')
    ok('C1d 终态进度事件恰好一个（无冲突终态）', events1.filter((e) => e.done && e.taskId === taskId1).length === 1 &&
      events1.every((e) => e.taskId !== taskId1 || e.phase !== 'completed'))
    gate.resolve(richFacts().facts)
    await tick(); await tick()
    ok('C1e 迟到的加载结果被丢弃：Worker 仍未启动、不写缓存', fake1.calls.length === 0 && svc1.service.getReport(2026).cache === 'miss')

    // C2 computing 阶段取消：runner.cancel 被调用、收敛 cancelled、迟到 Worker 结果被丢弃、幂等
    const fake2 = createFakeRunner()
    const svc2 = createService({ runner: fake2.runner, now })
    const g2 = svc2.service.generate(2026)
    await tick()
    const call2 = fake2.calls[0]
    ok('C2 computing 阶段进入', svc2.service.getTaskState(2026)?.status === 'computing')
    const c2a = svc2.service.cancel(call2.payload.taskId)
    const c2b = svc2.service.cancel(call2.payload.taskId) // 多次 cancel 不抛错
    const r2 = await g2
    ok('C2b cancel 幂等成功 + generate success:false', c2a.success === true && c2b.success === true &&
      r2.success === false && r2.error?.code === 'cancelled')
    call2.resolve(buildRealReport()) // 迟到的 Worker 结果
    await tick(); await tick()
    ok('C2c 迟到 Worker 结果被丢弃：不写缓存', svc2.service.getReport(2026).cache === 'miss' &&
      svc2.service.getTaskState(2026)?.status === 'failed')
    ok('C2d 终态任务重复 cancel 仍幂等成功', svc2.service.cancel(call2.payload.taskId).success === true)
    const notFound = svc2.service.cancel('no-such-task')
    ok('C2e 未知 taskId → task_not_found', notFound.success === false && notFound.error?.code === 'task_not_found')

    // C3 Worker 卡死（永不收敛）：cancel 仍让 generate 立即收敛（不必等待不可中断的计算）
    const stuckCalls: string[] = []
    const stuckRunner: AnnualReviewWorkerRunner = {
      run: () => new Promise<AnnualReviewReport>(() => { /* 永不收敛 */ }),
      cancel: (taskId) => { stuckCalls.push(taskId) }
    }
    const svc3 = createService({ runner: stuckRunner, now })
    const g3 = svc3.service.generate(2026)
    await tick()
    svc3.service.cancel(svc3.service.getTaskState(2026)?.taskId ?? '')
    let timer: ReturnType<typeof setTimeout> | undefined
    const r3 = await Promise.race([
      g3,
      new Promise<'__timeout__'>((r) => { timer = setTimeout(() => r('__timeout__'), 2000) })
    ])
    if (timer) clearTimeout(timer)
    ok('C3 Worker 卡死时 cancel 立即收敛（runner.cancel 已触达）', r3 !== '__timeout__' &&
      (r3 as { success?: boolean }).success === false && (r3 as { error?: { code?: string } }).error?.code === 'cancelled' &&
      stuckCalls.length === 1)

    // C4 loading 阶段 DB 查询卡死：取消同样立即收敛，且 Worker 永不启动
    const fake4 = createFakeRunner()
    const svc4 = createService({
      runner: fake4.runner, now,
      overrides: { loadFacts: () => new Promise<AnnualReviewFacts>(() => { /* DB 查询永不返回 */ }) }
    })
    const g4 = svc4.service.generate(2026)
    await tick()
    svc4.service.cancel(svc4.service.getTaskState(2026)?.taskId ?? '')
    const r4 = await g4
    ok('C4 loading 卡死查询下取消立即收敛且 Worker 不启动', r4.success === false && r4.error?.code === 'cancelled' &&
      fake4.calls.length === 0 && svc4.service.getReport(2026).cache === 'miss')
  }

  // ══ I 失效与运行中任务的竞态（epoch） ═════════════════════════════════════
  {
    // I1 loading 中 invalidateAll：Worker 不启动、收敛 invalidated、迟到结果丢弃
    const gate = deferred<AnnualReviewFacts>()
    const fake1 = createFakeRunner()
    const svc1 = createService({ runner: fake1.runner, now, overrides: { loadFacts: () => gate.promise } })
    const g1 = svc1.service.generate(2026)
    await tick()
    svc1.service.invalidateAll()
    const r1 = await g1
    ok('I1 loading 中 invalidate → failed/invalidated', r1.success === false && r1.error?.code === 'invalidated' &&
      fake1.calls.length === 0)
    gate.resolve(richFacts().facts)
    await tick(); await tick()
    ok('I1b 迟到加载结果被丢弃、不写缓存', svc1.service.getReport(2026).cache === 'miss')

    // I2 computing 中 invalidateAll：迟到的 Worker 成功结果也必须被丢弃
    const fake2 = createFakeRunner()
    const svc2 = createService({ runner: fake2.runner, now })
    const g2 = svc2.service.generate(2026)
    await tick()
    svc2.service.invalidateAll()
    const r2 = await g2
    ok('I2 computing 中 invalidate → failed/invalidated', r2.success === false && r2.error?.code === 'invalidated')
    fake2.calls[0].resolve(buildRealReport())
    await tick(); await tick()
    ok('I2b 旧任务完成后不写回缓存（getReport miss）', svc2.service.getReport(2026).cache === 'miss')

    // I2c handleDataChanged 同样收敛运行中任务
    const fake3 = createFakeRunner()
    const svc3 = createService({ runner: fake3.runner, now })
    const g3 = svc3.service.generate(2026)
    await tick()
    svc3.service.handleDataChanged()
    const r3 = await g3
    ok('I2c handleDataChanged 中 computing 任务收敛 invalidated', r3.success === false && r3.error?.code === 'invalidated')
    fake3.calls[0].resolve(buildRealReport())
    await tick(); await tick()
    ok('I2d 数据写入失效后旧结果不写缓存', svc3.service.getReport(2026).cache === 'miss')

    // I3 getAvailableYears 加载中 invalidate：旧结果不缓存不返回，新请求重新加载
    const gate4 = deferred<AnnualReviewFacts>()
    const svc4 = createService({ runner: createFakeRunner().runner, now, overrides: { loadFacts: () => gate4.promise } })
    const yearsPromise = svc4.service.getAvailableYears()
    await tick()
    svc4.service.invalidateAll()
    gate4.resolve(richFacts().facts)
    const yearsOutcome = await yearsPromise.then(() => 'resolved' as const, (e) => (e as { code?: string }).code ?? 'rejected')
    ok('I3 getAvailableYears 加载中 invalidate → invalidated（不返回旧结果）', yearsOutcome === 'invalidated')
    const loadsAfterFailed = svc4.getLoadCount()
    await svc4.service.getAvailableYears()
    ok('I3b 失效后新请求重新加载事实（旧结果未写缓存）', svc4.getLoadCount() > loadsAfterFailed)

    // I4 账号 A→B 切换（不调用 invalidateAll）：旧任务不写任何账号缓存，新请求正常
    const gate5 = deferred<AnnualReviewFacts>()
    const fake5 = createFakeRunner()
    const svc5 = createService({ runner: fake5.runner, now, overrides: { loadFacts: () => gate5.promise } })
    const ctxA: AnnualReviewAccountContext = { wxid: 'wx_account_a', salesDbName: 'weflow-sales-wx_account_a.db', crmDbName: 'weflow-crm-wx_account_a.db', exclusions: {} }
    const ctxB: AnnualReviewAccountContext = { wxid: 'wx_account_b', salesDbName: 'weflow-sales-wx_account_b.db', crmDbName: 'weflow-crm-wx_account_b.db', exclusions: {} }
    const g5 = svc5.service.generate(2026)
    await tick()
    svc5.ctxBox.current = ctxB // A → B（无失效调用：服务级上下文复核兜底）
    gate5.resolve(richFacts().facts)
    const r5 = await g5
    ok('I4 A→B 旧任务收敛 failed/invalidated', r5.success === false && r5.error?.code === 'invalidated' && fake5.calls.length === 0)
    svc5.ctxBox.current = ctxA
    ok('I4b A 无报告命中', svc5.service.getReport(2026).cache === 'miss')
    svc5.ctxBox.current = ctxB
    ok('I4c B 也无报告命中（不得写入任何账号缓存）', svc5.service.getReport(2026).cache === 'miss')
    const g5b = svc5.service.generate(2026) // B 的新请求
    await tick()
    fake5.calls[0].resolve(buildRealReport())
    const r5b = await g5b
    ok('I4d 失效后新请求正常重新生成', r5b.success === true && svc5.service.getReport(2026).cache === 'hit')
  }

  // ══ 14 progress 单调 + 终态 ═══════════════════════════════════════════════
  {
    const fakeF = createFakeRunner()
    const svcF = createService({ runner: fakeF.runner, now })
    const events: AnnualReviewProgressEvent[] = []
    svcF.service.onProgress((e) => events.push(e))
    const g = svcF.service.generate(2026)
    await tick()
    fakeF.calls[0].onProgress({ progress: 90 })
    fakeF.calls[0].onProgress({ progress: 60 })      // 乱序 → 不回退
    fakeF.calls[0].onProgress({ progress: Number.NaN }) // 非法 → 忽略
    fakeF.calls[0].resolve(buildRealReport())
    await g
    ok('14 progress 单调且 NaN 忽略', events.every((e, i, arr) => i === 0 || e.progress >= arr[i - 1].progress) &&
      events.every((e) => Number.isFinite(e.progress)))
    ok('14b 终态 completed=100 且 done', events[events.length - 1].progress === 100 && events[events.length - 1].done === true)
  }

  // ══ 16 事件监听清理函数有效 ═══════════════════════════════════════════════
  {
    const fakeG = createFakeRunner()
    const svcG = createService({ runner: fakeG.runner, now })
    let received = 0
    const cleanup = svcG.service.onProgress(() => { received++ })
    const g = svcG.service.generate(2026)
    await tick()
    fakeG.calls[0].onProgress({ progress: 50 })
    cleanup()
    const receivedAtCleanup = received
    fakeG.calls[0].onProgress({ progress: 60 })
    fakeG.calls[0].resolve(buildRealReport())
    await g
    ok('16 清理后不再接收事件（清理前已收 loading+50，清理后 60 不再送达）', receivedAtCleanup >= 2 && received === receivedAtCleanup)
  }

  // ══ 8+ 失效：handleDataChanged / getAvailableYears 缓存与隔离 ═════════════
  {
    const fakeH = createFakeRunner()
    const svcH = createService({ runner: fakeH.runner, now })
    const gh = svcH.service.generate(2026)
    await tick()
    fakeH.calls[0].resolve(buildRealReport())
    await gh
    ok('8h 失效前 hit', svcH.service.getReport(2026).cache === 'hit')
    svcH.service.handleDataChanged()
    ok('8i 数据写入失效后 miss', svcH.service.getReport(2026).cache === 'miss')

    // getAvailableYears：scope 缓存 + 失效重算
    const y1 = await svcH.service.getAvailableYears()
    const loadAfterFirst = svcH.getLoadCount()
    await svcH.service.getAvailableYears()
    ok('8j 年份缓存命中（不再加载事实）', svcH.getLoadCount() === loadAfterFirst)
    eq('8k 年份结果（自然年升序、0 末尾）', y1.years.map((y) => y.year), [2024, 2025, 0])
    svcH.service.invalidateAll()
    await svcH.service.getAvailableYears()
    ok('8l 失效后重新加载年份', svcH.getLoadCount() > loadAfterFirst)
  }

  // ══ K 契约补全：completeness / coverage / warnings / dataRange / sourceSummary ══
  {
    const emptyReport = composeAnnualReviewReport({ period: resolveAnnualReviewPeriod(2026, GEN), facts: emptyFacts(), sales: emptySales(), crm: emptyCrm() })
    const richReport = composeAnnualReviewReport({ period: resolveAnnualReviewPeriod(2025, GEN), facts, sales, crm, opts: { messageStats: messageStatsOk({ wx_a: { sent: 1, received: 0 } }) } })
    const legacyReport = composeAnnualReviewReport({
      period: resolveAnnualReviewPeriod(2025, GEN),
      facts: { ...facts, allocations: [...facts.allocations, allocF(9, 2, 300, null, 'legacy_confirmed', T(2025, 5, 1))] },
      sales, crm, opts: { messageStats: messageStatsOk({ wx_a: { sent: 1, received: 0 } }) }
    })

    // completeness 聚合纯函数：确定性优先级，与顺序无关
    ok('K1 aggregateMetricStates 优先级（unavailable > partial > snapshot_only > complete）',
      aggregateMetricStates(['complete', 'unavailable']) === 'unavailable' &&
      aggregateMetricStates(['complete', 'partial', 'snapshot_only']) === 'partial' &&
      aggregateMetricStates(['complete', 'snapshot_only']) === 'snapshot_only' &&
      aggregateMetricStates(['complete', 'complete']) === 'complete' &&
      aggregateMetricStates(['snapshot_only', 'partial']) === 'partial')
    ok('K1b 与输入顺序无关', aggregateMetricStates(['unavailable', 'complete']) === aggregateMetricStates(['complete', 'unavailable']) &&
      aggregateMetricStates(['snapshot_only', 'complete', 'partial']) === aggregateMetricStates(['partial', 'snapshot_only', 'complete']))
    ok('K1c 报告 completeness.blocks 与逐块聚合一致', (() => {
      const b = richReport.completeness.blocks
      const summaryStates = Object.values(richReport.summary).map((m) => m.state)
      return b.summary === aggregateMetricStates(summaryStates) &&
        b.funnel === aggregateMetricStates(Object.values(richReport.funnel).map((x) => x.coverage.status)) &&
        b.customers === aggregateMetricStates(Object.values(richReport.customers).map((x) => x.coverage.status)) &&
        richReport.completeness.overall === aggregateMetricStates(Object.values(b))
    })())

    // coverage：metricKey 完整且稳定（26 键全集）
    const expectedCoverageKeys = [
      'summary.customerTotal', 'summary.customerNew', 'summary.customerActive', 'summary.contractCount', 'summary.contractAmount',
      'summary.creditedAmount', 'summary.shippedCount', 'summary.shippedAmount', 'summary.dealingCustomers', 'summary.avgDealSize',
      'funnel.customerStage', 'funnel.opportunityStage', 'funnel.stageFlow', 'funnel.stuck', 'funnel.lostBreakdown',
      'customers.highValue', 'customers.newCustomers', 'customers.dealing', 'customers.repeat', 'customers.active', 'customers.silent', 'customers.risk', 'customers.priority',
      'monthly', 'communication', 'salesAssignment'
    ]
    eq('K2 coverage metricKey 完整且稳定（26 键）', Object.keys(richReport.coverage).sort(), [...expectedCoverageKeys].sort())
    ok('K2b B/C 组原样复用统计层 coverage', JSON.stringify(richReport.coverage['funnel.customerStage']) === JSON.stringify(richReport.funnel.customerStage.coverage) &&
      JSON.stringify(richReport.coverage['customers.highValue']) === JSON.stringify(richReport.customers.highValue.coverage))
    ok('K2c A 组 status=metric.state、A3 主口径 source=wcdb.messages', richReport.coverage['summary.customerTotal'].status === richReport.summary.customerTotal.state &&
      richReport.coverage['summary.customerActive'].source === 'wcdb.messages')

    // warnings 聚合确定性：与输入行序无关
    const reversed = composeAnnualReviewReport({
      period: resolveAnnualReviewPeriod(2025, GEN),
      facts: { accounts: [...facts.accounts].reverse(), contracts: [...facts.contracts].reverse(), allocations: [...facts.allocations].reverse(), shippedEvents: [] },
      sales: { profiles: [...sales.profiles].reverse(), intentEvents: [...sales.intentEvents].reverse() },
      crm: { opportunities: [...crm.opportunities].reverse(), opportunityEvents: [...crm.opportunityEvents].reverse() },
      opts: { messageStats: messageStatsOk({ wx_a: { sent: 1, received: 0 } }) }
    })
    eq('K3 warnings 聚合与输入顺序无关', reversed.warnings, richReport.warnings)
    eq('K3b dataRange/coverage/completeness 与输入顺序无关', [reversed.dataRange, reversed.coverage, reversed.completeness], [richReport.dataRange, richReport.coverage, richReport.completeness])
    ok('K3c warnings 行结构：metricKeys 排序、counts 键排序（不相加）', richReport.warnings.every((w) =>
      JSON.stringify(w.metricKeys) === JSON.stringify([...w.metricKeys].sort()) &&
      (w.counts === undefined || JSON.stringify(Object.keys(w.counts)) === JSON.stringify(Object.keys(w.counts).sort()))))

    // dataRange：实际输入事实边界；空数据双 null；脏值不进入
    ok('K4 空数据 dataRange = {from:null,to:null}', emptyReport.dataRange.from === null && emptyReport.dataRange.to === null)
    // 2025 报告参与窗口并集：存量建档 2024-3-1（A1 无下界）→ 商机事件 2025-5-1（B7 重放）
    ok('K4b 2025 实际范围（存量建档 2024-3-1 → 商机事件 2025-5-1）', richReport.dataRange.from === T(2024, 3, 1) && richReport.dataRange.to === T(2025, 5, 1))
    const dirtyRange = composeAnnualReviewReport({
      period: resolveAnnualReviewPeriod(0, GEN),
      facts: {
        accounts: [
          accF(1, null, { createdAt: 1_700_000_000 }),   // 秒值毫秒位（1970）→ 排除
          accF(2, null, { createdAt: T(2024, 6, 1) }),   // 合法
          accF(3, null, { createdAt: T(2026, 7, 1) })    // 晚于 asOf → 排除
        ],
        contracts: [], allocations: [], shippedEvents: []
      },
      sales: emptySales(), crm: emptyCrm()
    })
    ok('K4c all_time 秒值/未来值不进入 dataRange', dirtyRange.dataRange.from === T(2024, 6, 1) && dirtyRange.dataRange.to === T(2024, 6, 1))
    ok('K4d 空数据报告过运行时校验（nullable dataRange）', validateAnnualReviewReport(emptyReport, 2026).ok === true)

    // sourceSummary：真实输入行数、确定、无敏感内容
    const ss = richReport.sourceSummary
    ok('K5 sourceSummary 4 行（crmdb/salesdb/crmdb/wcdb）', ss.length === 4 &&
      ss[0].source === 'crmdb' && ss[1].source === 'salesdb' && ss[2].source === 'crmdb' && ss[3].source === 'wcdb')
    ok('K5b rows = 真实输入行数', ss[0].rows === facts.accounts.length + facts.contracts.length + facts.allocations.length &&
      ss[1].rows === sales.profiles.length + sales.intentEvents.length && ss[2].rows === crm.opportunities.length + crm.opportunityEvents.length)
    ok('K5c wcdb 行 = 消息统计会话数', ss[3].rows === 1)
    const emptySs = emptyReport.sourceSummary
    ok('K5d 空库 rows=0、消息统计不可用 note 稳定', emptySs[0].rows === 0 && emptySs[3].rows === 0 && emptySs[3].note?.includes('不可用') === true)
  }

  // ══ V validateAnnualReviewReport 运行时守卫单元 ═══════════════════════════
  {
    const good = buildRealReport()
    ok('V 合法报告通过', validateAnnualReviewReport(good, 2026).ok === true)
    ok('Vb {} 拒绝', validateAnnualReviewReport({}, 2026).ok === false)
    ok('Vc 数组拒绝', validateAnnualReviewReport([], 2026).ok === false)
    ok('Vd 错误年份拒绝', validateAnnualReviewReport(good, 2025).ok === false)
    ok('Ve 错误 schemaVersion 拒绝', validateAnnualReviewReport({ ...good, reportSchemaVersion: 2 }, 2026).ok === false)
    ok('Vf 缺核心区块拒绝', validateAnnualReviewReport({ ...good, funnel: undefined }, 2026).ok === false &&
      validateAnnualReviewReport({ ...good, summary: undefined }, 2026).ok === false &&
      validateAnnualReviewReport({ ...good, completeness: undefined }, 2026).ok === false)
    const withNaN = { ...good, summary: { ...good.summary, contractAmount: { ...good.summary.contractAmount, value: Number.NaN } } }
    ok('Vg NaN 拒绝', validateAnnualReviewReport(withNaN, 2026).ok === false)
    const withInfinity = { ...good, generatedAt: Number.POSITIVE_INFINITY }
    ok('Vg2 Infinity 拒绝', validateAnnualReviewReport(withInfinity, 2026).ok === false)
    const withFunc = { ...good, generatedAt: (() => 1) as unknown as number }
    ok('Vh 不可克隆值（function）拒绝', validateAnnualReviewReport(withFunc, 2026).ok === false)
    const withCycle = { ...good } as { self?: unknown }
    withCycle.self = withCycle
    ok('Vi 循环引用（不可 JSON 序列化）拒绝', validateAnnualReviewReport(withCycle, 2026).ok === false)
    const zeroAsUnavailable = {
      ...good,
      summary: { ...good.summary, customerTotal: { ...good.summary.customerTotal, state: 'unavailable', value: 0 } }
    }
    ok('Vj unavailable 区块不得伪装成数字 0', validateAnnualReviewReport(zeroAsUnavailable, 2026).ok === false)
    const valueAsUnavailable = {
      ...good,
      summary: { ...good.summary, contractCount: { ...good.summary.contractCount, state: 'complete', value: null } }
    }
    ok('Vj2 unavailable↔null 双向一致', validateAnnualReviewReport(valueAsUnavailable, 2026).ok === false)
    const badAsOf = { ...good, asOf: good.asOf + 1 }
    ok('Vk 时间契约破坏拒绝（current_year asOf≠generatedAt）', validateAnnualReviewReport(badAsOf, 2026).ok === false)
    const badScope = { ...good, scopeKind: 'all_time' }
    ok('Vl scopeKind 与年份不一致拒绝', validateAnnualReviewReport(badScope, 2026).ok === false)
    const sessionIdLeak = { ...good, customers: { ...good.customers, silent: { ...good.customers.silent, value: [{ sessionId: 'wx_a', lastContactAtMs: 1, accountId: null, customerId: null, name: null }] } } }
    ok('Vm 泄漏 sessionId 的报告拒绝', validateAnnualReviewReport(sessionIdLeak, 2026).ok === false)
  }

  // ══ A 阶段增补：dataRange 参与窗口 / 代表画像身份 / 名单失效 / 统一终止 / validator 完整契约 ══
  {
    // ── A1 dataRange 覆盖实际参与计算的事实 ──
    const shippedOnly = composeAnnualReviewReport({
      period: resolveAnnualReviewPeriod(2026, GEN),
      facts: { accounts: [], contracts: [conF(7, null, null, 400)], allocations: [], shippedEvents: [{ id: 1, contractId: 7, toStatus: 'shipped', createdAt: T(2026, 3, 5) }] },
      sales: emptySales(), crm: emptyCrm()
    })
    ok('A1 仅 shipped 事件参与：shippedCount=1 且 dataRange 覆盖事件时间', shippedOnly.summary.shippedCount.value === 1 &&
      shippedOnly.dataRange.from === T(2026, 3, 5) && shippedOnly.dataRange.to === T(2026, 3, 5))

    const oppEventsOnly = composeAnnualReviewReport({
      period: resolveAnnualReviewPeriod(2026, GEN), facts: emptyFacts(), sales: emptySales(),
      crm: { opportunities: [], opportunityEvents: [{ id: 1, opportunityId: 5, eventType: 'lost', stage: null, detail: '价格', createdAt: T(2026, 2, 9) }] }
    })
    ok('A1b 仅商机 lost 事件参与：dataRange 覆盖事件时间', oppEventsOnly.dataRange.from === T(2026, 2, 9) && oppEventsOnly.dataRange.to === T(2026, 2, 9))

    const profileOnly = composeAnnualReviewReport({
      period: resolveAnnualReviewPeriod(2026, GEN), facts: emptyFacts(),
      sales: { profiles: [profF(1, 'wx_p', 'quoted', Math.floor(T(2026, 1, 20) / 1000))], intentEvents: [] }, crm: emptyCrm()
    })
    ok('A1c 画像 lastContact 参与（current_year B6/C6-C8）：dataRange 覆盖', profileOnly.dataRange.from === T(2026, 1, 20) && profileOnly.dataRange.to === T(2026, 1, 20))
    const profileHist = composeAnnualReviewReport({
      period: resolveAnnualReviewPeriod(2025, GEN), facts: emptyFacts(),
      sales: { profiles: [profF(1, 'wx_p', 'quoted', Math.floor(T(2025, 6, 1) / 1000))], intentEvents: [] }, crm: emptyCrm()
    })
    ok('A1d 历史年度画像 lastContact 不参与 → dataRange 双 null', profileHist.dataRange.from === null && profileHist.dataRange.to === null)

    const a3Facts = { accounts: [accF(1, 'wx_a', { createdAt: T(2026, 1, 2), lastContactAtSec: Math.floor(T(2026, 3, 3) / 1000) })], contracts: [], allocations: [], shippedEvents: [] }
    const a3Fallback = composeAnnualReviewReport({
      period: resolveAnnualReviewPeriod(2026, GEN), facts: a3Facts, sales: emptySales(), crm: emptyCrm(),
      opts: { messageStats: { ok: false, sessions: {} } }
    })
    ok('A1e 消息主口径不可用：A3 回退 lastContact 进入范围', a3Fallback.dataRange.from === T(2026, 1, 2) && a3Fallback.dataRange.to === T(2026, 3, 3))
    const a3Main = composeAnnualReviewReport({
      period: resolveAnnualReviewPeriod(2026, GEN), facts: a3Facts, sales: emptySales(), crm: emptyCrm(),
      opts: { messageStats: messageStatsOk({}) }
    })
    ok('A1f 主口径可用：回退 lastContact 不进入范围', a3Main.dataRange.from === T(2026, 1, 2) && a3Main.dataRange.to === T(2026, 1, 2))

    const legacyStock = composeAnnualReviewReport({
      period: resolveAnnualReviewPeriod(2025, GEN),
      facts: { accounts: [accF(1, null, { createdAt: T(2023, 5, 1) })], contracts: [], allocations: [], shippedEvents: [] },
      sales: emptySales(), crm: emptyCrm()
    })
    ok('A1g periodStart 前存量客户参与 A1 → dataRange 含 2023 建档时间', legacyStock.summary.customerTotal.value === 1 &&
      legacyStock.dataRange.from === T(2023, 5, 1) && legacyStock.dataRange.to === T(2023, 5, 1))

    // ── A2 同 session 多画像：代表画像规则唯一，身份与投影同源 ──
    const twoProfiles = (order: 'p1p2' | 'p2p1'): AnnualReviewSalesSegmentsFacts => {
      const p1 = profF(1, 'wx_s', 'contacted', Math.floor(T(2026, 1, 10) / 1000), '111')
      const p2 = profF(2, 'wx_s', '决策', Math.floor(T(2026, 6, 1) / 1000), '222')
      return { profiles: order === 'p1p2' ? [p1, p2] : [p2, p1], intentEvents: [] }
    }
    const noFacts = { accounts: [], contracts: [], allocations: [], shippedEvents: [] }
    const repA = composeAnnualReviewReport({ period: resolveAnnualReviewPeriod(2026, GEN), facts: noFacts, sales: twoProfiles('p1p2'), crm: emptyCrm() })
    const repB = composeAnnualReviewReport({ period: resolveAnnualReviewPeriod(2026, GEN), facts: noFacts, sales: twoProfiles('p2p1'), crm: emptyCrm() })
    ok('A2 调换多画像输入顺序：完整公开客户结果深相等', JSON.stringify(repA.customers) === JSON.stringify(repB.customers))
    const repRow = repA.customers.priority.value?.[0]
    ok('A2b 身份/lastContact 来自代表画像（晚 lastContact 的 222，非首条 111）',
      repRow !== undefined && repRow.customerId === '222' && repRow.lastContactAtMs === T(2026, 6, 1))

    // ── A3 名单变更失效（服务行为 + main 接线守卫） ──
    const fakeL = createFakeRunner()
    const svcL = createService({ runner: fakeL.runner, now })
    const gL = svcL.service.generate(2026)
    await tick()
    fakeL.calls[0].resolve(buildRealReport())
    await gL
    ok('A3-1 名单变更前 hit', svcL.service.getReport(2026).cache === 'hit')
    svcL.service.handleDataChanged()
    ok('A3-2 名单变更（handleDataChanged）后立即 miss', svcL.service.getReport(2026).cache === 'miss')
    const gL2 = svcL.service.generate(2026)
    await tick()
    svcL.service.handleDataChanged()
    const rL2 = await gL2
    fakeL.calls[1].resolve(buildRealReport())
    await tick(); await tick()
    ok('A3-3 名单变更取消运行任务且旧结果不写缓存', rL2.success === false && rL2.error?.code === 'invalidated' &&
      svcL.service.getReport(2026).cache === 'miss')
    const mainSrcA = readFileSync(join(ROOT, 'electron', 'main.ts'), 'utf8')
    const cfgStart = mainSrcA.indexOf("ipcMain.handle('config:set'")
    const cfgSeg = mainSrcA.slice(cfgStart, mainSrcA.indexOf('ipcMain.handle', cfgStart + 5))
    ok('A3-4 config:set 两名单键写成功后失效（接线守卫；行为级=上方两条）',
      cfgSeg.includes("key === 'reportExcludedSessions' || key === 'crmInternalList'") &&
      cfgSeg.includes('annualReviewService.handleDataChanged()'))

    // ── A4 invalidate/handleDataChanged/cancel 统一真实终止（幂等恰一次） ──
    let cancelCountA = 0
    const fakeA = createFakeRunner()
    const svcA = createService({
      runner: { run: fakeA.runner.run, cancel: () => { cancelCountA++ } }, now
    })
    const gA = svcA.service.generate(2026)
    await tick()
    svcA.service.invalidateAll()
    svcA.service.handleDataChanged() // 再失效：不得重复终止
    svcA.service.cancel(svcA.service.getTaskState(2026)?.taskId ?? '') // 单任务取消：也不得重复
    const rA = await gA
    ok('A4 三条路径共用终止语义：runner.cancel 恰一次', cancelCountA === 1)
    ok('A4b 任务收敛 failed/invalidated 且不缓存', rA.success === false && rA.error?.code === 'invalidated' &&
      svcA.service.getReport(2026).cache === 'miss')
    fakeA.calls[0].resolve(buildRealReport())
    await tick(); await tick()
    ok('A4c 迟到 Worker 结果不写缓存', svcA.service.getReport(2026).cache === 'miss')

    const throwingRunner: AnnualReviewWorkerRunner = {
      run: () => new Promise<AnnualReviewReport>(() => { /* 永不收敛 */ }),
      cancel: () => { throw new Error('terminate exploded') }
    }
    const svcT = createService({ runner: throwingRunner, now })
    const gT = svcT.service.generate(2026)
    await tick()
    svcT.service.invalidateAll()
    const rT = await gT
    ok('A4d runner.cancel 抛错 → 任务仍收敛、服务不崩溃', rT.success === false && rT.error?.code === 'invalidated')

    let cancelCountB = 0
    const fakeB = createFakeRunner()
    const svcB2 = createService({ runner: { run: fakeB.runner.run, cancel: () => { cancelCountB++ } }, now })
    const gB2 = svcB2.service.generate(2026)
    await tick()
    svcB2.service.cancel(svcB2.service.getTaskState(2026)?.taskId ?? '')
    svcB2.service.cancel(svcB2.service.getTaskState(2026)?.taskId ?? '')
    await gB2
    ok('A4e 单任务重复 cancel：真实终止恰一次', cancelCountB === 1)

    // ── A5 validator 完整契约（键全集 / completeness 推导 / 泄漏） ──
    const goodReport = buildRealReport()
    const missingKey = JSON.parse(JSON.stringify(goodReport)) as { coverage: Record<string, unknown> }
    delete missingKey.coverage['summary.customerTotal']
    ok('A5 缺少必需 coverage key 拒绝', validateAnnualReviewReport(missingKey, 2026).ok === false)
    const unknownKey = JSON.parse(JSON.stringify(goodReport)) as { coverage: Record<string, unknown> }
    unknownKey.coverage['summary.unknown'] = { source: 'x', status: 'complete' }
    ok('A5b 未知 coverage key 拒绝', validateAnnualReviewReport(unknownKey, 2026).ok === false)
    const forgedOverall = JSON.parse(JSON.stringify(goodReport)) as { completeness: { overall: string } }
    forgedOverall.completeness.overall = 'complete'
    ok('A5c completeness.overall 伪造 complete 拒绝', validateAnnualReviewReport(forgedOverall, 2026).ok === false)
    const forgedBlock = JSON.parse(JSON.stringify(goodReport)) as { completeness: { blocks: Record<string, string> } }
    forgedBlock.completeness.blocks.monthly = 'complete'
    ok('A5d 未实现区块 completeness 伪造 complete 拒绝', validateAnnualReviewReport(forgedBlock, 2026).ok === false)
    const tamperedMetric = JSON.parse(JSON.stringify(goodReport)) as {
      summary: { avgDealSize: { state: string; value: number | null } }
    }
    // 2026 夹具 blocks.summary 本就因 A9 分母 0 而 unavailable；把 A9 伪造成 complete
    // 会改变推导结果，completeness 仍是旧值 → 必须拒绝
    tamperedMetric.summary.avgDealSize.state = 'complete'
    tamperedMetric.summary.avgDealSize.value = 5
    ok('A5e 指标状态与 completeness 矛盾拒绝', validateAnnualReviewReport(tamperedMetric, 2026).ok === false)
    const withSessionIdRow = JSON.parse(JSON.stringify(goodReport)) as { customers: { silent: { value: unknown } } }
    withSessionIdRow.customers.silent.value = [{ sessionId: 'wx_s', lastContactAtMs: 1, accountId: null, customerId: null, name: null }]
    ok('A5f 公开客户行残留 sessionId 拒绝', validateAnnualReviewReport(withSessionIdRow, 2026).ok === false)
    const forgedReport = JSON.parse(JSON.stringify(goodReport)) as Record<string, unknown>
    ;(forgedReport.completeness as { overall: string }).overall = 'complete'
    const svcForged = createService({ runner: { run: () => Promise.resolve(forgedReport as never) }, now })
    const rForged = await svcForged.service.generate(2026)
    ok('A5g 伪造 completeness 的 Worker 结果不缓存、任务 failed', rForged.success === false &&
      svcForged.service.getReport(2026).cache === 'miss' && svcForged.service.getTaskState(2026)?.error?.code === 'invalid_worker_result')
  }

  // ══ 15/19 源码一致性守卫（IPC/preload/d.ts/vite/Worker 边界 + 结构化错误） ══
  {
    const mainSrc = readFileSync(join(ROOT, 'electron', 'main.ts'), 'utf8')
    const preloadSrc = readFileSync(join(ROOT, 'electron', 'preload.ts'), 'utf8')
    const dtsSrc = readFileSync(join(ROOT, 'src', 'types', 'electron.d.ts'), 'utf8')
    const viteSrc = readFileSync(join(ROOT, 'vite.config.ts'), 'utf8')
    const workerSrc = readFileSync(join(ROOT, 'electron', 'annualReviewWorker.ts'), 'utf8')
    const serviceSrc = readFileSync(join(ROOT, 'electron', 'services', 'annualReviewService.ts'), 'utf8')

    for (const channel of ['annualReview:getAvailableYears', 'annualReview:generate', 'annualReview:getReport', 'annualReview:cancel']) {
      ok(`15 main.ts 注册 ${channel}`, mainSrc.includes(`'${channel}'`))
      ok(`15b preload 对接 ${channel}`, preloadSrc.includes(`'${channel}'`))
    }
    ok('15c preload 进度订阅：wrapper+removeListener（无 removeAllListeners 固化）',
      preloadSrc.includes("subscribeIpcEvent(ipcRenderer, 'annualReview:progress'") &&
      !preloadSrc.includes("removeAllListeners('annualReview:progress')"))
    ok('15d preload 暴露最小 API（5 方法均在 annualReview 命名空间）', (() => {
      const nsStart = preloadSrc.indexOf('annualReview: {')
      const nsEnd = preloadSrc.indexOf('\n  },', nsStart)
      if (nsStart < 0 || nsEnd < 0) return false
      const ns = preloadSrc.slice(nsStart, nsEnd)
      return ['getAvailableYears', 'generate', 'getReport', 'cancel', 'onProgress'].every((m) => ns.includes(`${m}: (`))
    })())
    ok('15e electron.d.ts annualReview 签名与报告类型', dtsSrc.includes('annualReview: {') &&
      dtsSrc.includes('interface AnnualReviewReport') && dtsSrc.includes('generate: (year: number)') &&
      dtsSrc.includes("cache: 'hit' | 'miss' | 'stale'"))
    ok('15e2 d.ts 结构化错误信封（annualReview 区段 error?: { code, message }）', (() => {
      const nsStart = dtsSrc.indexOf('annualReview: {')
      const nsEnd = dtsSrc.indexOf('dualReport: {', nsStart)
      if (nsStart < 0 || nsEnd < 0) return false
      const ns = dtsSrc.slice(nsStart, nsEnd)
      return (ns.match(/error\?: \{ code: string; message: string \}/g) ?? []).length >= 4
    })())
    ok('15f cancel 请求对象 {taskId}（preload + main 双侧）', preloadSrc.includes("invoke('annualReview:cancel', { taskId })") &&
      mainSrc.includes('(payload as { taskId?: unknown }).taskId'))
    const arIpcStart = mainSrc.indexOf("'annualReview:getAvailableYears'")
    const arIpcEnd = mainSrc.indexOf("'annualReport:getAvailableYears'")
    const arIpc = mainSrc.slice(arIpcStart, arIpcEnd)
    ok('15g IPC 失败返回结构化错误（4 处 error: { code … }，不丢 code）',
      (arIpc.match(/error: \{ code/g) ?? []).length >= 4 &&
      !arIpc.includes('error: validation.message') && !arIpc.includes('error: result.error?.message'))
    ok('15g2 非法年份错误携带稳定 code', arIpc.includes('code: validation.code'))
    ok('15h 账号上下文使用实际业务库身份（currentDbPath，路径只进内部键）',
      mainSrc.includes("salesDbService.currentDbPath() ?? businessDbName(wxid, 'sales')") &&
      mainSrc.includes("crmDbService.currentDbPath() ?? businessDbName(wxid, 'crm')"))
    ok('15i 服务层无哈希折叠、无日志输出（内部键不外泄）', !serviceSrc.includes('fnv1a') && !/console\./.test(serviceSrc))
    ok('15j 服务层使用运行时报告校验', serviceSrc.includes('validateAnnualReviewReport'))
    ok('19 Worker 构建接线（vite entry + 产物名）', viteSrc.includes("entry: 'electron/annualReviewWorker.ts'") &&
      viteSrc.includes("entryFileNames: 'annualReviewWorker.js'"))
    ok('19b Worker 路径解析约定（__dirname 同级产物）', serviceSrc.includes("'annualReviewWorker.js'"))
    ok('19c Worker 源文件存在', existsSync(join(ROOT, 'electron', 'annualReviewWorker.ts')))
    ok('19d Worker 零数据库/零秘密依赖', !/wcdbService|salesDbService|crmDbService|decryptKey|businessDbPath/.test(workerSrc))
    ok('19e Worker 只引用纯统计（annualReviewReport）', workerSrc.includes('annualReviewReport'))
  }

  // ══ S preload 多订阅者独立清理（可注入 IPC renderer 行为测试） ═════════════
  {
    class FakeIpcRenderer implements IpcEventRegistrar {
      private readonly registered: Array<{ channel: string; listener: (...args: unknown[]) => void }> = []
      on(channel: string, listener: (...args: unknown[]) => void): unknown {
        this.registered.push({ channel, listener })
        return undefined
      }
      removeListener(channel: string, listener: (...args: unknown[]) => void): unknown {
        const idx = this.registered.findIndex((r) => r.channel === channel && r.listener === listener)
        if (idx >= 0) this.registered.splice(idx, 1)
        return undefined
      }
      emit(channel: string, payload: unknown): void {
        for (const r of [...this.registered]) {
          if (r.channel === channel) r.listener('event', payload)
        }
      }
      get count(): number { return this.registered.length }
    }
    const ipc = new FakeIpcRenderer()
    const received: string[] = []
    const cleanupA = subscribeIpcEvent(ipc, 'annualReview:progress', (p) => received.push(`A:${(p as { taskId?: string }).taskId}`))
    const cleanupB = subscribeIpcEvent(ipc, 'annualReview:progress', (p) => received.push(`B:${(p as { taskId?: string }).taskId}`))
    ok('S 两个订阅者各自注册 wrapper', ipc.count === 2)
    ipc.emit('annualReview:progress', { taskId: 't1' })
    eq('Sb A/B 同时收到事件', received, ['A:t1', 'B:t1'])
    cleanupA()
    cleanupA() // 幂等：重复清理不抛错、不移除他人
    ok('Sc 清理 A 后 B 的 wrapper 仍在', ipc.count === 1)
    ipc.emit('annualReview:progress', { taskId: 't2' })
    eq('Sd 清理 A 后 B 继续收到事件', received, ['A:t1', 'B:t1', 'B:t2'])
    cleanupB()
    ipc.emit('annualReview:progress', { taskId: 't3' })
    ok('Se 清理 B 后无残留监听', ipc.count === 0 && received.length === 3)
  }

  // ══ 20 reportSchemaVersion 与 S1 单一来源 ═════════════════════════════════
  ok('20 reportSchemaVersion 单一来源（S1 常量）', buildRealReport().reportSchemaVersion === 1)

  // ══ 21 真实 Worker 文件端到端（worker_threads + tsx loader；零数据库、纯统计） ═══
  {
    const { Worker } = await import('worker_threads')
    const realReportKeys = ['reportSchemaVersion', 'year', 'scopeKind', 'periodStart', 'periodEndExclusive', 'asOf',
      'generatedAt', 'timezoneNote', 'dataRange', 'completeness', 'coverage', 'warnings',
      'summary', 'funnel', 'customers', 'monthly', 'communication', 'salesAssignment', 'sourceSummary']
    const payload: AnnualReviewWorkerPayload = {
      taskId: 'real-worker-1',
      reportSchemaVersion: 1,
      period: resolveAnnualReviewPeriod(2026, GEN),
      facts: {
        accounts: [accF(1, 'wx_a', { createdAt: T(2025, 2, 1) }), accF(2, 'wx_b', { createdAt: T(2024, 3, 1) })],
        contracts: [conF(1, 1, T(2025, 3, 1), 1200)],
        allocations: [allocF(1, 1, 800.5, T(2025, 4, 1))],
        shippedEvents: []
      },
      sales: {
        profiles: [profF(1, 'wx_a', 'quoted'), profF(2, 'wx_b', '决策')],
        intentEvents: [ievF(1, 'wx_a', 'quoted', T(2025, 3, 1)), ievF(2, 'wx_b', 'negotiating', T(2025, 4, 1))]
      },
      crm: emptyCrm(),
      messageStats: messageStatsOk({ wx_a: { sent: 2, received: 1 } })
    }
    const workerResult = await new Promise<{ type: string; data?: AnnualReviewReport }>((resolve, reject) => {
      const w = new Worker(join(ROOT, 'electron', 'annualReviewWorker.ts'), {
        workerData: payload,
        execArgv: ['--import', 'tsx']
      })
      const messages: Array<{ type: string; data?: unknown }> = []
      w.on('message', (m) => {
        messages.push(m)
        if ((m as { type?: string }).type === 'annualReview:result') resolve(m as { type: string; data?: AnnualReviewReport })
      })
      w.on('error', reject)
      w.on('exit', (code) => {
        if (messages.every((m) => m.type !== 'annualReview:result')) reject(new Error(`worker exit ${code} without result`))
      })
      setTimeout(() => reject(new Error('real worker timeout')), 20000)
    })
    ok('21 真实 Worker 返回完整报告（19 个顶层键）', workerResult.data !== undefined &&
      Object.keys(workerResult.data as unknown as object).length === realReportKeys.length &&
      realReportKeys.every((k) => k in (workerResult.data as object)))
    ok('21b 真实 Worker 统计值正确（A1=2；2025 年签约/核销不在 2026 区间 → 真实零）',
      workerResult.data?.summary.customerTotal.value === 2 &&
      workerResult.data?.summary.contractCount.value === 0 && workerResult.data?.summary.creditedAmount.value === 0)
    ok('21c 真实 Worker 结果过运行时结构校验', workerResult.data !== undefined && validateAnnualReviewReport(workerResult.data, 2026).ok === true)
    ok('21c2 真实 Worker 报告无 sessionId/wxid 原文', !JSON.stringify(workerResult.data).includes('wx_a') &&
      !JSON.stringify(workerResult.data).includes('sessionId'))

    // 非法载荷 → 结构化错误（code=invalid_payload），不崩溃
    const badResult = await new Promise<{ type: string; error?: { code: string; message: string } }>((resolve, reject) => {
      const w = new Worker(join(ROOT, 'electron', 'annualReviewWorker.ts'), {
        workerData: { broken: true },
        execArgv: ['--import', 'tsx']
      })
      w.on('message', (m) => {
        if ((m as { type?: string }).type === 'annualReview:error') resolve(m as { type: string; error?: { code: string; message: string } })
      })
      w.on('error', reject)
      w.on('exit', (code) => reject(new Error(`worker exit ${code} without error`)))
      setTimeout(() => reject(new Error('real worker timeout')), 20000)
    })
    ok('21d 真实 Worker 非法载荷 → invalid_payload', badResult.error?.code === 'invalid_worker_result' || badResult.error?.code === 'invalid_payload')

    // 真实 createThreadRunner：产物缺失 → worker_error（验证打包路径约定失败可收敛）
    const missingRunner = createThreadRunner('annualReviewWorker.nonexistent.js')
    const missingFailed = await new Promise<unknown>((resolve) => {
      missingRunner.run(payload, () => {}).catch(resolve)
    })
    ok('21e 真实 runner 产物缺失收敛为 worker_error', (missingFailed as { code?: string })?.code === 'worker_error')
  }
}

main().then(() => {
  console.log(`结果：${pass} 通过 / ${fail} 失败`)
  process.exit(fail > 0 ? 1 : 0)
}).catch((e) => {
  console.error('FATAL:', e)
  process.exit(1)
})
