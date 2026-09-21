/**
 * annual-review-invalidation-test.ts —— 年度经营复盘数据失效总线护栏（S7.2 修复轮）
 *
 * 覆盖（对应用户验收要求）：
 *   A  总线语义：合并窗口有界、立即失效不等待窗口、订阅者异常隔离、取消订阅、只带原因不携带数据
 *   B  真实写入 → 确定性报告缓存与 AI 结果缓存**同时**失效：
 *      客户新增/修改/导入 · 合同新增/签约/出货 · 核销与撤销 · 阶段变更（salesDb）·
 *      客户删除 · 商机阶段/流失 · Assignment 行 · LAN/中央下行应用（applyDownEventDirect）·
 *      Assignment 失效总线桥 · WCDB 连接成功（总线路径）
 *   C  失败写入不失效（事务回滚 / 非法实体早退）
 *   D  连续写入被有界合并为一次派发
 *   E  账号隔离不受破坏（失效是 coarse 的，但绝不跨账号回读；任务归属仍 fail closed）
 *   F  失效期间运行的 AI 结果不返回、不缓存
 *   G  读操作不接入失效（纯读不产生任何待派发上报）
 *
 * 测试纪律：数据库用真实 crmDbService/salesDbService + 临时目录（sql.js），报告与 AI 结果用
 * 已验收服务层 + 注入的假 Worker runner/假模型出口（**不发真实请求、不碰真实用户数据**）。
 * 环境隔离与 lan-sync-test 同构：三行 env 在动态 import 业务模块前生效，绝不读写持久配置。
 * 运行：npx tsx scripts/annual-review-invalidation-test.ts
 */
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const isoDir = mkdtempSync(join(tmpdir(), 'ar-invalidation-'))
process.env.WEFLOW_WORKER = '1'
process.env.WEFLOW_USER_DATA_PATH = isoDir
process.env.WEFLOW_CONFIG_CWD = isoDir

import {
  ANNUAL_REVIEW_INVALIDATION_FLUSH_MS,
  announceAnnualReviewDataChanged,
  announceAnnualReviewDataChangedNow,
  bridgeAssignmentInvalidationToAnnualReview,
  flushAnnualReviewInvalidationForTest,
  hasPendingAnnualReviewInvalidation,
  installAnnualReviewInvalidation,
  onAnnualReviewInvalidation,
  resetAnnualReviewInvalidationForTest,
  type AnnualReviewInvalidationEvent
} from '../electron/services/annualReviewInvalidation'
import {
  resolveAnnualReviewPeriod,
  type AnnualReviewFacts,
  type AnnualReviewMessageStats
} from '../electron/services/annualReviewStats'
import type { AnnualReviewSalesSegmentsFacts, AnnualReviewCrmSegmentsFacts } from '../electron/services/annualReviewSegments'
import { composeAnnualReviewReport, type AnnualReviewReport } from '../electron/services/annualReviewReport'
import {
  AnnualReviewService,
  type AnnualReviewAccountContext,
  type AnnualReviewWorkerPayload,
  type AnnualReviewWorkerRunner
} from '../electron/services/annualReviewService'
import { AnnualReviewAiCoordinator } from '../electron/services/annualReviewAiCoordinator'
import { ANNUAL_REVIEW_AI_PROMPT_VERSION } from '../electron/services/annualReviewAiCore'

type CrmRow = Record<string, unknown>
let crmDbService: (typeof import('../electron/services/crmDbService'))['crmDbService']
let salesDbService: (typeof import('../electron/services/salesDbService'))['salesDbService']
let lanSync: (typeof import('../electron/services/lanSyncService'))
let assignmentBus: (typeof import('../electron/services/assignmentInvalidationBus'))

let pass = 0, fail = 0
function ok(name: string, cond: boolean): void {
  if (cond) { pass++ } else { fail++; console.error('FAIL:', name) }
}
const tick = (): Promise<void> => new Promise((r) => setImmediate(r))
const wait = async (n = 6): Promise<void> => { for (let i = 0; i < n; i++) await tick() }
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const T = (y: number, m: number, d: number): number => new Date(y, m - 1, d, 12, 0, 0).getTime()
const GEN = T(2026, 6, 15)
const YEAR = 2025

// ── 报告夹具（与 service/ai 测试同构的最小事实） ─────────────────────────────
const facts: AnnualReviewFacts = {
  accounts: [{ id: 1, name: '客户1', createdAt: T(2025, 2, 1), importedAt: null, sessionId: 'wxid_inv', lastContactAtSec: null }],
  contracts: [{ id: 1, accountId: 1, amount: 1200, status: 'signed', signDate: T(2025, 3, 1) }],
  allocations: [],
  shippedEvents: []
}
const sales: AnnualReviewSalesSegmentsFacts = { profiles: [], intentEvents: [] }
const crm: AnnualReviewCrmSegmentsFacts = { opportunities: [], opportunityEvents: [] }
const messageStats: AnnualReviewMessageStats = { ok: true, sessions: {} }
const ANALYSIS = { executiveSummary: '整体经营平稳。', diagnoses: [], actions: [], risks: [] }

function createHarness() {
  const ctx: AnnualReviewAccountContext = {
    wxid: 'wx_inv_a', salesDbName: 'sales-inv-a.db', crmDbName: 'crm-inv-a.db', exclusions: { manualSessions: [], internalSessions: [] }
  }
  const runnerCalls: Array<{ payload: AnnualReviewWorkerPayload; resolve: (r: AnnualReviewReport) => void }> = []
  const runner: AnnualReviewWorkerRunner = {
    run(payload) {
      return new Promise<AnnualReviewReport>((resolve) => { runnerCalls.push({ payload, resolve }) })
    }
  }
  let seq = 0
  const service = new AnnualReviewService({
    loadFacts: async () => facts,
    loadSalesSegments: async () => sales,
    loadCrmSegments: async () => crm,
    loadMessageStats: async () => messageStats,
    getAccountContext: () => ctx,
    runner,
    now: () => GEN,
    newTaskId: () => `inv-${++seq}`
  })
  const aiCalls: string[] = []
  const coordinator = new AnnualReviewAiCoordinator({
    getTaskReport: (taskId) => service.getTaskReport(taskId),
    getConfig: () => ({ get: () => undefined }) as never,
    generate: (async (report: AnnualReviewReport) => {
      aiCalls.push(String(report.year))
      return { ok: true, analysis: ANALYSIS, model: 'fake', promptVersion: ANNUAL_REVIEW_AI_PROMPT_VERSION, generatedAt: GEN }
    }) as never,
    now: () => GEN
  })
  /** 生产接线（main.ts 调用的同一个函数） */
  const unsubscribe = installAnnualReviewInvalidation({
    handleDataChanged: () => service.handleDataChanged(),
    invalidateAll: () => coordinator.invalidateAll()
  })
  return { service, coordinator, ctx, runnerCalls, aiCalls, unsubscribe }
}

/** 生成一份报告并让 AI 结果进入缓存（两类缓存都热） */
async function warmCaches(h: ReturnType<typeof createHarness>): Promise<string> {
  const started = h.service.start(YEAR)
  await tick()
  const call = h.runnerCalls.find((c) => c.payload.taskId === started.taskId)
  if (!call) throw new Error('runner 未收到任务')
  call.resolve(composeAnnualReviewReport({ period: resolveAnnualReviewPeriod(YEAR, GEN), facts, sales, crm, opts: { messageStats } }))
  await wait(3)
  const res = await h.coordinator.run(started.taskId)
  if (!res.success) throw new Error(`AI 预热失败：${res.error.code}`)
  if (h.service.getReport(YEAR).cache !== 'hit' || h.coordinator.cacheSize() === 0) throw new Error('预热未生效')
  return started.taskId
}

/** 断言一次真实写入让两类缓存同时失效 */
async function expectInvalidated(label: string, h: ReturnType<typeof createHarness>, write: () => void): Promise<void> {
  flushAnnualReviewInvalidationForTest() // 清掉历史积压
  await warmCaches(h)
  const beforeReport = h.service.getReport(YEAR).cache
  const beforeAi = h.coordinator.cacheSize()
  write()
  flushAnnualReviewInvalidationForTest()
  const afterReport = h.service.getReport(YEAR).cache
  const afterAi = h.coordinator.cacheSize()
  ok(`${label}：前置两类缓存均热（报告=${beforeReport} / AI=${beforeAi}）`, beforeReport === 'hit' && beforeAi === 1)
  ok(`${label}：写入后确定性报告缓存失效`, afterReport !== 'hit')
  ok(`${label}：写入后 AI 结果缓存失效`, afterAi === 0)
}

async function main(): Promise<void> {
  crmDbService = (await import('../electron/services/crmDbService')).crmDbService
  salesDbService = (await import('../electron/services/salesDbService')).salesDbService
  assignmentBus = await import('../electron/services/assignmentInvalidationBus')
  lanSync = await import('../electron/services/lanSyncService')
  const { setIdentity } = await import('../electron/services/identityService')
  const { ConfigService } = await import('../electron/services/config')
  const dbDir = mkdtempSync(join(tmpdir(), 'ar-invalidation-db-'))
  const sharedDir = mkdtempSync(join(tmpdir(), 'ar-invalidation-shared-'))
  await crmDbService.initialize(dbDir)
  await salesDbService.initialize(dbDir)
  const cfg = ConfigService.getInstance()
  cfg.set('crmSalesList', ['测试销售甲'])
  setIdentity('测试销售甲', '销售')

  // ══ A. 总线语义 ═══════════════════════════════════════════════════════════
  {
    const events: AnnualReviewInvalidationEvent[] = []
    const off = onAnnualReviewInvalidation((e) => events.push(e))
    announceAnnualReviewDataChanged('crm_write')
    announceAnnualReviewDataChanged('crm_write')
    announceAnnualReviewDataChanged('sales_write')
    ok('A1 上报后有待派发事件（未立即派发）', hasPendingAnnualReviewInvalidation() && events.length === 0)
    flushAnnualReviewInvalidationForTest()
    ok('A2 合并为一次派发', events.length === 1)
    ok('A3 合并计数与去重原因正确',
      events[0]?.count === 3 && JSON.stringify(events[0]?.reasons) === JSON.stringify(['crm_write', 'sales_write']))
    ok('A4 事件不含任何业务数据内容', events[0] !== undefined && Object.keys(events[0]).sort().join(',') === 'at,count,firstAt,reasons')
    ok('A5 派发后无积压', !hasPendingAnnualReviewInvalidation())
    flushAnnualReviewInvalidationForTest()
    ok('A6 无积压时 flush 不产生事件', events.length === 1)

    // 立即失效不等待窗口
    announceAnnualReviewDataChangedNow('account_switch')
    ok('A7 立即失效同步派发', events.length === 2 && events[1].reasons.join(',') === 'account_switch')
    // 立即失效前先派发积压（顺序不倒挂）
    announceAnnualReviewDataChanged('crm_write')
    announceAnnualReviewDataChangedNow('config_exclusions')
    ok('A8 立即失效先派发积压再派发自身（顺序不倒挂）',
      events.length === 4 && events[2].reasons.join(',') === 'crm_write' && events[3].reasons.join(',') === 'config_exclusions')

    // 订阅者异常隔离
    const seen: string[] = []
    const offThrow = onAnnualReviewInvalidation(() => { throw new Error('listener boom') })
    const offSecond = onAnnualReviewInvalidation(() => seen.push('second'))
    announceAnnualReviewDataChangedNow('manual')
    ok('A9 单个订阅者抛错不影响其他订阅者（也不冒泡到调用方）', seen.join(',') === 'second')
    offThrow()
    offSecond()
    off()
    announceAnnualReviewDataChangedNow('manual')
    ok('A10 取消订阅后不再收到事件', events.length === 5 && seen.length === 1)

    // 窗口有界：不显式 flush 也会在固定窗口内派发
    const auto: AnnualReviewInvalidationEvent[] = []
    const offAuto = onAnnualReviewInvalidation((e) => auto.push(e))
    announceAnnualReviewDataChanged('crm_write')
    await sleep(ANNUAL_REVIEW_INVALIDATION_FLUSH_MS + 120)
    ok('A11 固定窗口到期自动派发（延迟有界）', auto.length === 1 && auto[0].count === 1)
    offAuto()
    resetAnnualReviewInvalidationForTest()
  }

  // ══ B. 真实写入 → 两类缓存同时失效 ═══════════════════════════════════════
  {
    const h = createHarness()
    const now = Date.now()
    const accountId = Number(crmDbService.create('account', { name: '失效客户', session_id: 'wxid_inv', created_at: now, updated_at: now }))
    const contractId = Number(crmDbService.create('contract', { account_id: accountId, name: '失效客户-合同', amount: 3000, status: 'pending_sign', created_at: now, updated_at: now }))

    // B1 客户新增
    await expectInvalidated('B1 客户新增', h, () => {
      crmDbService.create('account', { name: '新客户B1', created_at: now, updated_at: now })
    })
    // B2 客户修改
    await expectInvalidated('B2 客户修改', h, () => {
      crmDbService.update('account', accountId, { name: '失效客户（改名）', updated_at: now })
    })
    // B3 客户导入（画像导入建档）
    await expectInvalidated('B3 客户导入（importCustomerFromProfile）', h, () => {
      crmDbService.importCustomerFromProfile({ name: '导入客户B3', sessionId: 'wxid_inv_b3', stage: 'quoted' })
    })
    // B4 合同签约（含合同状态历史）
    await expectInvalidated('B4 合同签约', h, () => {
      const r = crmDbService.signContract(contractId)
      if (!r.ok) throw new Error(`signContract 失败：${r.reason}`)
    })
    // B5 核销（认领 + 财务核销，影响 creditedTotal；先核销以满足出货的全款前置）
    const payRecordId = Number(crmDbService.create('payment_record', { amount_net: 3000, created_at: now }))
    const allocationIds = crmDbService.addAllocations(payRecordId, [{ customerHint: '失效客户', salesHint: '测试销售甲', amountHint: 3000 }])
    const allocationId = Number(allocationIds[0])
    await expectInvalidated('B5 核销认领（confirmAllocation）', h, () => {
      const r = crmDbService.confirmAllocation(allocationId, { account_id: accountId, contract_id: contractId })
      if (!r.ok) throw new Error(`confirmAllocation 失败：${r.reason}`)
    })
    await expectInvalidated('B6 财务核销（reconcileAllocation）', h, () => {
      const r = crmDbService.reconcileAllocation(allocationId)
      if (!r.ok) throw new Error(`reconcileAllocation 失败：${r.reason}`)
    })
    // B7 合同出货（状态变化 + 出货历史；需要全款到账）
    await expectInvalidated('B7 合同出货', h, () => {
      const r = crmDbService.shipContract(contractId)
      if (!r.ok) throw new Error(`shipContract 失败：${r.reason}`)
    })
    await expectInvalidated('B8 撤销核销（allocation 回写）', h, () => {
      crmDbService.update('allocation', allocationId, { reconciliation_status: 'pending', reconciled_at: null })
    })
    // B9 客户阶段变更（salesDb 写漏斗）
    await expectInvalidated('B9 客户阶段变更（customerUpsert）', h, () => {
      salesDbService.customerUpsert({ session_id: 'wxid_inv', stage: '决策', last_contact_at: Math.floor(now / 1000) })
    })
    await expectInvalidated('B10 意向阶段事件（intentCreate）', h, () => {
      salesDbService.intentCreate({ session_id: 'wxid_inv', stage: '决策', source: 'manual', reason: '测试', message_key: null, evidence_text: null } as never)
    })
    // B11 商机阶段 / 流失
    const opp = crmDbService.opportunityUpsertBySignal(accountId, '失效客户', { product: '叉车', quantity: 1, amount: 1000, stage: '比价', detail: '测试信号' })
    const oppId = Number(opp.id)
    await expectInvalidated('B11 商机阶段变更', h, () => {
      const changed = crmDbService.opportunityUpdateStage(oppId, '决策', 'manual')
      if (!changed) throw new Error('opportunityUpdateStage 未生效')
    })
    await expectInvalidated('B12 商机流失关单', h, () => {
      crmDbService.opportunityClose(oppId, 'lost', '测试流失')
    })
    // B13 Assignment 行写入
    await expectInvalidated('B13 Assignment 写入', h, () => {
      crmDbService.runTx((tx) => {
        tx.run(
          'INSERT INTO assignment (lead_id, sales_name, mode, status, source, updated_by, updated_at, version, deleted) VALUES (?,?,?,?,?,?,?,?,?)',
          [1, '测试销售甲', 'manual', 'assigned', 'test', 'test', now, 1, 0]
        )
      })
    })
    // B14 Assignment 失效总线 → 年度复盘失效（LAN/中央下行归属变化走的桥）
    {
      flushAnnualReviewInvalidationForTest()
      await warmCaches(h)
      const offBridge = bridgeAssignmentInvalidationToAnnualReview(assignmentBus.onAssignmentInvalidated)
      assignmentBus.emitAssignmentInvalidated('assign', [1])
      assignmentBus.flushAssignmentInvalidationForTest() // assignment 总线自身也有合并窗口
      flushAnnualReviewInvalidationForTest()
      ok('B14 Assignment 总线桥：报告缓存失效', h.service.getReport(YEAR).cache !== 'hit')
      ok('B15 Assignment 总线桥：AI 结果缓存失效', h.coordinator.cacheSize() === 0)
      offBridge()
    }
    // B16 WCDB 连接成功（总线路径；真实连接需原生 worker，此处只验证上报语义）
    await expectInvalidated('B16 WCDB 连接成功上报', h, () => {
      announceAnnualReviewDataChanged('wcdb_connected')
    })
    // B17 LAN/中央下行应用业务事件（真实 applyDownEventDirect）
    {
      flushAnnualReviewInvalidationForTest()
      crmDbService.runTx((tx) => tx.run(
        'INSERT INTO lead (contact_type, contact_normalized, contact_raw, wechat, source, name, status, first_contact_deadline, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
        ['phone', '13900001234', 'B17线索', '', '测试', 'B17线索', 'NEW', 0, now, now]
      ))
      await warmCaches(h)
      const outcome = lanSync.applyDownEventDirect({
        idempotencyKey: 'inv-down-1',
        type: 'assign',
        to: '测试销售甲',
        sourceDeviceId: 'hub-1',
        deliveryRole: 'apply',
        payload: { leadId: 999001, salesName: '测试销售甲', mode: 'manual', actor: 'system:test', lead: { name: 'B17线索', contact: '13900001234' } }
      } as never)
      flushAnnualReviewInvalidationForTest()
      ok('B17 LAN/中央下行应用成功（applied）', outcome === 'applied')
      ok('B18 下行应用后报告缓存失效', h.service.getReport(YEAR).cache !== 'hit')
      ok('B19 下行应用后 AI 结果缓存失效', h.coordinator.cacheSize() === 0)
    }
    // B20 客户删除（deleteAccount 级联事务）
    const victimId = Number(crmDbService.create('account', { name: '待删客户', created_at: now, updated_at: now }))
    await expectInvalidated('B20 客户删除', h, () => {
      const r = crmDbService.deleteAccount(victimId)
      if (!r.ok) throw new Error(`deleteAccount 失败：${r.reason}`)
    })
    h.unsubscribe()
    resetAnnualReviewInvalidationForTest()
  }

  // ══ C. 失败写入不失效 ════════════════════════════════════════════════════
  {
    const h = createHarness()
    flushAnnualReviewInvalidationForTest()
    await warmCaches(h)
    const reportBefore = h.service.getReport(YEAR).cache
    let threw = false
    try {
      crmDbService.runTx(() => { throw new Error('模拟写入失败') })
    } catch { threw = true }
    flushAnnualReviewInvalidationForTest()
    ok('C1 事务回滚写入抛错', threw)
    ok('C2 失败写入不上报（报告缓存仍命中）', h.service.getReport(YEAR).cache === reportBefore && reportBefore === 'hit')
    ok('C3 失败写入不上报（AI 缓存仍在）', h.coordinator.cacheSize() === 1)
    ok('C4 非法实体早退不上报（无待派发事件）', (() => {
      const before = hasPendingAnnualReviewInvalidation()
      const created = crmDbService.create('not_an_entity', { x: 1 })
      return created === 0 && !before && !hasPendingAnnualReviewInvalidation()
    })())
    h.unsubscribe()
    resetAnnualReviewInvalidationForTest()
  }

  // ══ D. 连续写入被有界合并 ════════════════════════════════════════════════
  {
    const events: AnnualReviewInvalidationEvent[] = []
    const off = onAnnualReviewInvalidation((e) => events.push(e))
    const now = Date.now()
    for (let i = 0; i < 25; i++) {
      crmDbService.create('account', { name: `批量客户${i}`, created_at: now, updated_at: now })
    }
    ok('D1 25 次连续写入只产生一次派发', (() => {
      flushAnnualReviewInvalidationForTest()
      return events.length === 1
    })())
    ok('D2 派发计数覆盖全部写入（≥25）', events[0].count >= 25)
    off()
    resetAnnualReviewInvalidationForTest()
  }

  // ══ E. 账号隔离不受破坏 ══════════════════════════════════════════════════
  {
    const h = createHarness()
    const taskIdA = await warmCaches(h)
    // 切换到账号 B 作用域
    h.ctx.wxid = 'wx_inv_b'
    h.ctx.salesDbName = 'sales-inv-b.db'
    h.ctx.crmDbName = 'crm-inv-b.db'
    announceAnnualReviewDataChangedNow('crm_write')
    ok('E1 切号后 B 作用域报告缓存为 miss（绝不回退 A 的报告）', h.service.getReport(YEAR).cache === 'miss')
    const cross = h.service.getTaskReport(taskIdA)
    ok('E2 切号后 A 的 taskId 按不存在返回（fail closed）', cross.ok === false && cross.code === 'task_not_found')
    ok('E3 AI 结果缓存已清空（不跨账号复用）', h.coordinator.cacheSize() === 0)
    h.unsubscribe()
    resetAnnualReviewInvalidationForTest()
  }

  // ══ F. 失效期间运行的 AI 结果不返回、不缓存 ═══════════════════════════════
  {
    const h = createHarness()
    const pending = { resolve: null as null | ((v: unknown) => void) }
    const calls: string[] = []
    const coordinator = new AnnualReviewAiCoordinator({
      getTaskReport: (taskId) => h.service.getTaskReport(taskId),
      getConfig: () => ({ get: () => undefined }) as never,
      generate: (async () => {
        calls.push('call')
        return new Promise((resolve) => { pending.resolve = resolve })
      }) as never,
      now: () => GEN
    })
    const off = installAnnualReviewInvalidation({ handleDataChanged: () => h.service.handleDataChanged(), invalidateAll: () => coordinator.invalidateAll() })
    // 生成任务 + 报告缓存（AI 直接跑在未缓存的空态上）
    const started = h.service.start(YEAR)
    await tick()
    h.runnerCalls.find((c) => c.payload.taskId === started.taskId)?.resolve(
      composeAnnualReviewReport({ period: resolveAnnualReviewPeriod(YEAR, GEN), facts, sales, crm, opts: { messageStats } })
    )
    await wait(3)
    const run = coordinator.run(started.taskId)
    await tick()
    ok('F1 在途调用已发起', calls.length === 1)
    announceAnnualReviewDataChanged('crm_write')
    flushAnnualReviewInvalidationForTest()
    ok('F2 失效中止在途调用（信号已中止）', coordinator.inFlightCount() === 1)
    pending.resolve?.({ ok: true, analysis: ANALYSIS, model: 'fake', promptVersion: ANNUAL_REVIEW_AI_PROMPT_VERSION, generatedAt: GEN })
    const res = await run
    ok('F3 失效期间在途结果 → invalidated（不返回成功）', res.success === false && res.error.code === 'invalidated')
    ok('F4 失效期间在途结果不写缓存', coordinator.cacheSize() === 0)
    ok('F5 在途登记正常清理', coordinator.inFlightCount() === 0)
    off()
    h.unsubscribe()
    resetAnnualReviewInvalidationForTest()
  }

  // ══ G. 读操作不接入失效 ══════════════════════════════════════════════════
  {
    flushAnnualReviewInvalidationForTest()
    crmDbService.all('SELECT * FROM account')
    crmDbService.list('contract', { limit: 5 })
    crmDbService.getById('account', 1)
    crmDbService.customers()
    crmDbService.statsOverview()
    crmDbService.opportunityStats()
    crmDbService.autoConfirmHistory(5)
    salesDbService.all('SELECT * FROM customer_profile')
    await tick()
    ok('G1 纯读操作不产生任何待派发上报（失效不接在读路径上）', !hasPendingAnnualReviewInvalidation())
    ok('G2 读操作后 flush 不派发任何事件', (() => {
      const seen: number[] = []
      const off = onAnnualReviewInvalidation(() => seen.push(1))
      flushAnnualReviewInvalidationForTest()
      off()
      return seen.length === 0
    })())
    resetAnnualReviewInvalidationForTest()
  }

  try { rmSync(dbDir, { recursive: true, force: true }) } catch { /* ignore */ }
  try { rmSync(sharedDir, { recursive: true, force: true }) } catch { /* ignore */ }
  try { rmSync(isoDir, { recursive: true, force: true }) } catch { /* ignore */ }

  console.log(`结果：${pass} 通过 / ${fail} 失败`)
  process.exit(fail > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('FATAL:', e)
  process.exit(1)
})
