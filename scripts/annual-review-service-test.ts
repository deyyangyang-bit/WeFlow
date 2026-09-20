/**
 * annual-review-service-test.ts —— 年度经营复盘 S3 护栏（编排/Worker 边界/IPC 契约/缓存）
 *
 * 覆盖（S3 任务 §九 20 项）：
 *   1  完整 current_year 报告组装          2  historical_year asOf/边界
 *   3  all_time                            4  S1/S2 装配且 warnings/coverage 不丢失
 *   5  D/E 未实现不显示为真实 0            6  非法/未来年份与 IPC 载荷校验
 *   7  getAvailableYears（空库/多年/脏时间/排序）
 *   8  缓存命中/TTL 过期/generate 强制重算/失效  9  两个 accountScopeId 绝不串缓存
 *   10 同键并发只启动一个任务              11 不同 scope 独立运行
 *   12 旧任务迟到消息不覆盖新任务          13 Worker throw/exit/非法结果/加载失败 → failed
 *   14 progress 单调                       15 IPC/preload/electron.d.ts 命名一致（源码扫描）
 *   16 事件监听清理函数有效                17 报告可 structuredClone/JSON 序列化
 *   18 输出无数据库路径/SQL/Token/原文     19 Worker 打包接线守卫（vite entry + 产物名 + Worker 零 DB 导入）
 *   20 S1/S2/旧年度报告回归由各自测试脚本承担（本套不重复）
 *
 * 时间相关全部使用注入时钟（无真实 sleep）；数据库/Worker 经窄接口注入假实现，
 * 不访问真实用户数据库。运行：npx tsx scripts/annual-review-service-test.ts
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
  validateAnnualReviewYearInput,
  validateAnnualReviewTaskId,
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
const profF = (id: number, sessionId: string | null, stage: string | null, lastContactAtSec: number | null = null) =>
  ({ id, sessionId, stage, lastContactAtSec })
const ievF = (id: number, sessionId: string | null, stage: string | null, createdAt: number | null) =>
  ({ id, sessionId, stage, createdAt })
const oppF = (id: number, stage: string | null, status: string | null, createdAt: number | null) =>
  ({ id, accountId: 1, stage, status, createdAt })
const oevF = (id: number, opportunityId: number, eventType: string | null, stage: string | null, detail: string | null, createdAt: number | null) =>
  ({ id, opportunityId, eventType, stage, detail, createdAt })

/** 标准多源夹具：S1 金额 + S2 阶段 + 非法事件（验证装配与告警透传） */
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
    profiles: [profF(1, 'wx_a', 'quoted'), profF(2, 'wx_b', '决策')],
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
    loadFacts: async (): Promise<AnnualReviewFacts> => {
      loadCount++
      if (opts?.loadFactsFail) throw new Error('db closed')
      return rich.facts
    },
    loadSalesSegments: async () => {
      loadCount++
      if (opts?.loadFactsFail) throw new Error('db closed')
      return rich.sales
    },
    loadCrmSegments: async () => {
      loadCount++
      if (opts?.loadFactsFail) throw new Error('db closed')
      return rich.crm
    },
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

  // ══ 1 完整 current_year 报告组装 ══════════════════════════════════════════
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
    ok('1e customers.active=A3 主口径（wx_a 活跃）', report.customers.active.value?.length === 1 &&
      report.customers.active.value?.[0].sessionId === 'wx_a')
    ok('1f customers.priority current_year 可用（C8）', report.customers.priority.coverage.status === 'partial')
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
  }

  // ══ 5 D/E 未实现 → 显式 unavailable，非 0/空数组 ══════════════════════════
  {
    const report = composeAnnualReviewReport({
      period: resolveAnnualReviewPeriod(2026, GEN), facts, sales, crm, opts: { messageStats: { ok: false, sessions: {} } }
    })
    for (const block of ['monthly', 'communication', 'salesAssignment'] as const) {
      const b = report[block]
      ok(`5 ${block} unavailable + metric_not_implemented`, b.status === 'unavailable' && b.reasonCodes.length === 1 && b.reasonCodes[0] === 'metric_not_implemented')
    }
  }

  // ══ 17/18 序列化与敏感信息 ════════════════════════════════════════════════
  {
    const report = composeAnnualReviewReport({
      period: resolveAnnualReviewPeriod(2025, GEN), facts, sales, crm, opts: { messageStats: messageStatsOk({ wx_a: { sent: 1, received: 0 } }) }
    })
    const cloned = structuredClone(report)
    ok('17 structuredClone 深拷贝一致', JSON.stringify(cloned) === JSON.stringify(report))
    ok('17b JSON 往返一致', JSON.stringify(JSON.parse(JSON.stringify(report))) === JSON.stringify(report))
    const text = JSON.stringify(report)
    ok('18 无 SQL/路径/密钥/Token/wxid/堆栈', !text.includes('SELECT') && !text.includes('.db') &&
      !text.includes('decryptKey') && !text.includes('token') && !text.includes('wx_account') &&
      !text.includes('/Users/') && !text.includes('at Object') && !text.includes('stack'))
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

  // ══ 7 getAvailableYears（纯函数） ═════════════════════════════════════════
  {
    const empty = computeAnnualReviewAvailableYears({ facts: emptyFacts(), sales: emptySales(), crm: emptyCrm(), generatedAt: GEN })
    ok('7 空库：years=[]、supportsAllTime=false、defaultYear=当年', empty.years.length === 0 && empty.supportsAllTime === false && empty.defaultYear === 2026)
    const full = computeAnnualReviewAvailableYears({ facts, sales, crm, generatedAt: GEN })
    eq('7b 多年份升序 + 0（历史以来）', full.years.map((y) => y.year), [2024, 2025, 0])
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

  // ══ 9 两个 accountScopeId 绝不串缓存 ══════════════════════════════════════
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

    const junkRunner: AnnualReviewWorkerRunner = { run: () => Promise.resolve(42 as never) }
    const svcJunk = createService({ runner: junkRunner, now })
    const rj = await svcJunk.service.generate(2026)
    ok('13c 非法结果 → failed（invalid_worker_result）', rj.success === false &&
      svcJunk.service.getTaskState(2026)?.error?.code === 'invalid_worker_result')

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

    // 取消：cancel(taskId) → runner.terminate → 任务收敛 failed
    const fakeX = createFakeRunner()
    const svcX = createService({ runner: fakeX.runner, now })
    const gx = svcX.service.generate(2026)
    await tick()
    const taskIdX = fakeX.calls[0].payload.taskId
    const cancelled = svcX.service.cancel(taskIdX)
    const rx = await gx
    ok('13f cancel → 任务 failed/cancelled', cancelled.success === true && rx.success === false &&
      svcX.service.getTaskState(2026)?.error?.code === 'cancelled')
    ok('13g cancel 幂等（终态任务/未知 taskId）', svcX.service.cancel(taskIdX).success === true &&
      svcX.service.cancel('unknown-task').success === false)
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
    eq('8k 年份结果（含 2024/2025/0，升序）', y1.years.map((y) => y.year), [2024, 2025, 0])
    svcH.service.invalidateAll()
    await svcH.service.getAvailableYears()
    ok('8l 失效后重新加载年份', svcH.getLoadCount() > loadAfterFirst)
  }

  // ══ 15/19 源码一致性守卫（IPC/preload/d.ts/vite/Worker 边界） ════════════
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
    ok('15c 进度广播通道（main 广播 + preload 订阅 + 清理函数）', mainSrc.includes("'annualReview:progress'") &&
      preloadSrc.includes("on('annualReview:progress'") && preloadSrc.includes("removeAllListeners('annualReview:progress')"))
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
    ok('19 Worker 构建接线（vite entry + 产物名）', viteSrc.includes("entry: 'electron/annualReviewWorker.ts'") &&
      viteSrc.includes("entryFileNames: 'annualReviewWorker.js'"))
    ok('19b Worker 路径解析约定（__dirname 同级产物）', serviceSrc.includes("'annualReviewWorker.js'"))
    ok('19c Worker 源文件存在', existsSync(join(ROOT, 'electron', 'annualReviewWorker.ts')))
    ok('19d Worker 零数据库/零秘密依赖', !/wcdbService|salesDbService|crmDbService|decryptKey|businessDbPath/.test(workerSrc))
    ok('19e Worker 只引用纯统计（annualReviewReport）', workerSrc.includes('annualReviewReport'))
  }

  // ══ 20 reportSchemaVersion 与 S1 单一来源 ═════════════════════════════════
  ok('20 reportSchemaVersion 单一来源（S1 常量）', buildRealReport().reportSchemaVersion === 1)

  // ══ 21 真实 Worker 文件端到端（worker_threads + tsx loader；零数据库、纯统计） ═══
  {
    const { Worker } = await import('worker_threads')
    const realReportKeys = ['reportSchemaVersion', 'year', 'scopeKind', 'periodStart', 'periodEndExclusive', 'asOf',
      'generatedAt', 'timezoneNote', 'summary', 'funnel', 'customers', 'monthly', 'communication', 'salesAssignment']
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
    ok('21 真实 Worker 返回完整报告（16 个顶层键）', workerResult.data !== undefined &&
      Object.keys(workerResult.data as unknown as object).length === realReportKeys.length &&
      realReportKeys.every((k) => k in (workerResult.data as object)))
    ok('21b 真实 Worker 统计值正确（A1=2；2025 年签约/核销不在 2026 区间 → 真实零）',
      workerResult.data?.summary.customerTotal.value === 2 &&
      workerResult.data?.summary.contractCount.value === 0 && workerResult.data?.summary.creditedAmount.value === 0)

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
    ok('21c 真实 Worker 非法载荷 → invalid_payload', badResult.error?.code === 'invalid_worker_result' || badResult.error?.code === 'invalid_payload')

    // 真实 createThreadRunner：产物缺失 → worker_error（验证打包路径约定失败可收敛）
    const missingRunner = createThreadRunner('annualReviewWorker.nonexistent.js')
    const missingFailed = await new Promise<unknown>((resolve) => {
      missingRunner.run(payload, () => {}).catch(resolve)
    })
    ok('21d 真实 runner 产物缺失收敛为 worker_error', (missingFailed as { code?: string })?.code === 'worker_error')
  }
}

main().then(() => {
  console.log(`结果：${pass} 通过 / ${fail} 失败`)
  process.exit(fail > 0 ? 1 : 0)
}).catch((e) => {
  console.error('FATAL:', e)
  process.exit(1)
})
