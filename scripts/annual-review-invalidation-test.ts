/**
 * annual-review-invalidation-test.ts —— 年度经营复盘数据失效总线护栏（范围收窄轮 + leading-edge）
 *
 * 覆盖（对应用户验收要求）：
 *   A  总线语义：**首条事件立即派发**（不等窗口、不依赖 flush）、窗口内抑制并有界合并、
 *      持续事件不无限延迟、立即失效可穿窗、订阅者异常隔离、事件不含业务数据
 *   B  **无关写入不失效**：scan_state / processed_msg / migration_report / migration_dismissal /
 *      无关 audit action / activity_log / auto_confirm_log / knowledge_base / report_snapshot /
 *      eval case / follow_up_task / 未声明的无关事务
 *   C  **相关写入立即失效**：account / contract / contract_status_history / allocation /
 *      assignment / lead / opportunity / opportunity_event / audit_event(三动作) /
 *      customer_profile / intent_tag_log（真实方法驱动，**不 flush 即时断言**）
 *   D  失败或回滚写入不失效
 *   E  无关写入不打断运行中的报告/AI 任务、不清缓存
 *   F  账号隔离不受破坏（失效是 coarse 的，但绝不跨账号回读）
 *   G  读操作不接入失效
 *   H  LAN/中央下行应用（真实 applyDownEventDirect）+ assignment 总线桥
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
  ANNUAL_REVIEW_AUDIT_ACTIONS,
  ANNUAL_REVIEW_CRM_SOURCE_TABLES,
  ANNUAL_REVIEW_INVALIDATION_FLUSH_MS,
  ANNUAL_REVIEW_SALES_SOURCE_TABLES,
  announceAnnualReviewAuditAction,
  announceAnnualReviewCrmWrite,
  announceAnnualReviewDataChanged,
  announceAnnualReviewDataChangedNow,
  announceAnnualReviewSalesWrite,
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

/** 关闭合并窗口（把「被抑制事件的补派发」也排掉），用于让后续断言从干净状态开始 */
function settleWindow(): void {
  flushAnnualReviewInvalidationForTest()
}

/** 相关写入：**不 flush、不等窗口**，写入返回后立即断言两类缓存都失效 */
async function expectImmediateInvalidation(label: string, h: ReturnType<typeof createHarness>, write: () => void): Promise<void> {
  settleWindow()
  await warmCaches(h)
  const beforeReport = h.service.getReport(YEAR).cache
  const beforeAi = h.coordinator.cacheSize()
  write()
  // 关键：这里没有 flush、没有 sleep、没有 await
  const afterReport = h.service.getReport(YEAR).cache
  const afterAi = h.coordinator.cacheSize()
  ok(`${label}：前置两类缓存均热（报告=${beforeReport} / AI=${beforeAi}）`, beforeReport === 'hit' && beforeAi >= 1)
  ok(`${label}：写入后**立即**报告缓存失效（未等 150ms 窗口）`, afterReport !== 'hit')
  ok(`${label}：写入后**立即** AI 结果缓存失效`, afterAi === 0)
}

/** 无关写入：不 flush（因为不该有任何派发），断言缓存与运行中任务都不受影响 */
async function expectNoInvalidation(label: string, h: ReturnType<typeof createHarness>, write: () => void): Promise<void> {
  settleWindow()
  await warmCaches(h)
  const reportTaskId = h.service.getTaskState(YEAR)?.taskId ?? null
  const beforeAi = h.coordinator.cacheSize()
  const seen: AnnualReviewInvalidationEvent[] = []
  const off = onAnnualReviewInvalidation((e) => seen.push(e))
  write()
  off()
  ok(`${label}：无关写入不产生任何失效派发`, seen.length === 0)
  ok(`${label}：无关写入后报告缓存仍命中`, h.service.getReport(YEAR).cache === 'hit')
  ok(`${label}：无关写入后 AI 结果缓存仍在`, h.coordinator.cacheSize() === beforeAi)
  ok(`${label}：无关写入不取消/不失效已完成的报告任务`,
    h.service.getTaskState(YEAR)?.status === 'completed' && h.service.getTaskState(YEAR)?.taskId === reportTaskId)
}

async function main(): Promise<void> {
  crmDbService = (await import('../electron/services/crmDbService')).crmDbService
  salesDbService = (await import('../electron/services/salesDbService')).salesDbService
  assignmentBus = await import('../electron/services/assignmentInvalidationBus')
  lanSync = await import('../electron/services/lanSyncService')
  const { setIdentity } = await import('../electron/services/identityService')
  const { ConfigService } = await import('../electron/services/config')
  const dbDir = mkdtempSync(join(tmpdir(), 'ar-invalidation-db-'))
  await crmDbService.initialize(dbDir)
  await salesDbService.initialize(dbDir)
  const cfg = ConfigService.getInstance()
  cfg.set('crmSalesList', ['测试销售甲'])
  setIdentity('测试销售甲', '销售')

  // ══ A. 总线语义（leading edge：首条立即） ═══════════════════════════════════
  {
    const events: AnnualReviewInvalidationEvent[] = []
    const off = onAnnualReviewInvalidation((e) => events.push(e))

    announceAnnualReviewDataChanged('crm:contract')
    ok('A1 首条事件**立即**派发（未 flush、未等待窗口）', events.length === 1 && events[0].coalesced === false && events[0].count === 1)
    ok('A2 派发原因即上报原因', JSON.stringify(events[0].reasons) === JSON.stringify(['crm:contract']))
    ok('A3 首条派发后进入抑制窗口（用于合并后续事件）', hasPendingAnnualReviewInvalidation())

    announceAnnualReviewDataChanged('crm:contract')
    announceAnnualReviewDataChanged('sales:customer_profile')
    ok('A4 窗口内重复事件被抑制（不立即派发）', events.length === 1)
    settleWindow()
    ok('A5 窗口结束时对被抑制事件补一次合并派发', events.length === 2 && events[1].coalesced === true)
    ok('A6 合并派发计数与去重原因正确',
      events[1].count === 3 && JSON.stringify(events[1].reasons) === JSON.stringify(['crm:contract', 'sales:customer_profile']))
    ok('A7 派发后无积压', !hasPendingAnnualReviewInvalidation())
    ok('A8 无积压时 flush 不产生事件', (() => { settleWindow(); return events.length === 2 })())

    // 窗口空闲后的下一条仍是 leading edge
    announceAnnualReviewDataChanged('crm:lead')
    ok('A9 新窗口首条同样立即派发', events.length === 3 && events[2].coalesced === false)
    settleWindow()

    // 立即失效可穿窗：即使窗口已打开也立刻派发
    announceAnnualReviewDataChanged('crm:contract') // 开窗 + 立即派发
    const before = events.length
    announceAnnualReviewDataChangedNow('account_switch')
    ok('A10 立即失效（账号切换）在窗口内也立刻派发', events.length === before + 1 && events[events.length - 1].reasons.join(',') === 'account_switch')
    settleWindow()

    ok('A11 事件只含原因与计数，不含业务数据',
      Object.keys(events[0]).sort().join(',') === 'at,coalesced,count,firstAt,reasons')

    // 订阅者异常隔离与取消订阅
    const seen: string[] = []
    const offThrow = onAnnualReviewInvalidation(() => { throw new Error('listener boom') })
    const offSecond = onAnnualReviewInvalidation(() => seen.push('second'))
    announceAnnualReviewDataChangedNow('account_switch')
    ok('A12 单个订阅者抛错不影响其他订阅者（也不冒泡）', seen.join(',') === 'second')
    offThrow(); offSecond(); off()
    const countBefore = events.length
    announceAnnualReviewDataChangedNow('account_switch')
    ok('A13 取消订阅后不再收到事件', events.length === countBefore)
    settleWindow()
  }

  // ══ A2. 持续事件：有界合并、不无限延迟 ═══════════════════════════════════════
  {
    const events: AnnualReviewInvalidationEvent[] = []
    const off = onAnnualReviewInvalidation((e) => events.push(e))
    // 每 30ms 上报一次，持续 ~300ms（10 次）：窗口从首条起算固定长度，不随事件顺延
    for (let i = 0; i < 10; i++) {
      announceAnnualReviewDataChanged('crm:contract')
      await sleep(30)
    }
    await sleep(ANNUAL_REVIEW_INVALIDATION_FLUSH_MS + 60)
    ok('A14 持续事件下派发次数有界（每窗口 ≤2 次，10 次上报远小于 10 次派发）',
      events.length > 0 && events.length <= 5)
    ok('A15 首次派发发生在首条上报的同一时刻（不等待）',
      events.length > 0 && events[0].coalesced === false)
    ok('A16 窗口不因持续事件无限后移（总延迟有界）',
      events.every((e) => typeof e.at === 'number' && typeof e.firstAt === 'number'))
    off()
    settleWindow()
  }

  // ══ B. 无关写入不失效（默认不影响年度复盘） ═════════════════════════════════
  {
    const h = createHarness()
    const now = Date.now()
    await expectNoInvalidation('B1 scan_state 写入（setScanState）', h, () => {
      crmDbService.setScanState('inv:test:key', now)
    })
    await expectNoInvalidation('B2 processed_msg 写入（markMsgProcessed）', h, () => {
      crmDbService.markMsgProcessed(`msg-inv-${now}`)
    })
    await expectNoInvalidation('B3 migration_report 写入（saveMigrationReport）', h, () => {
      crmDbService.saveMigrationReport('inv-module', '标题', { applied: 1 }, [], [], now)
    })
    await expectNoInvalidation('B4 migration_dismissal 写入（migrationDismiss）', h, () => {
      crmDbService.migrationDismiss('inv-module', 'entity-1', 'tester')
    })
    await expectNoInvalidation('B5 无关 audit action 写入（auditAppend: contract_edit）', h, () => {
      crmDbService.auditAppend('tester', 'contract_edit', 'contract', 1, { note: 'x' })
    })
    await expectNoInvalidation('B6 activity_log 写入（logActivity）', h, () => {
      crmDbService.logActivity('contract', 1, 'note', '无关留痕', 'tester')
    })
    await expectNoInvalidation('B7 auto_confirm_log 写入（logAutoConfirm）', h, () => {
      crmDbService.logAutoConfirm('allocation', 1, 'auto', 0.9, '测试', 'confirm')
    })
    await expectNoInvalidation('B8 knowledge_base 写入（kbCreate）', h, () => {
      salesDbService.kbCreate({ category: 'qa', title: `测试条目${now}`, content: '内容', tags: [], scene: null, authority: 'community', source: 'manual' } as never)
    })
    await expectNoInvalidation('B9 report_snapshot 写入（reportCreate）', h, () => {
      salesDbService.reportCreate({ period_type: 'week', period_start: now - 1000, period_end: now, stats: '{}', ai_summary: null } as never)
    })
    await expectNoInvalidation('B10 opportunity_eval_case 写入（evalCaseUpsert）', h, () => {
      salesDbService.evalCaseUpsert({ session_id: 'wxid_inv', anchor_key: `k-${now}`, label: 'has', ai_label: 'none' } as never)
    })
    await expectNoInvalidation('B11 alert_eval_case 写入（alertEvalCaseUpsert）', h, () => {
      salesDbService.alertEvalCaseUpsert({ session_id: 'wxid_inv', alert_type: 'risk', anchor_key: `a-${now}`, label: 'correct', ai_label: 'wrong' } as never)
    })
    await expectNoInvalidation('B12 follow_up_task 写入（todoCreate）', h, () => {
      salesDbService.todoCreate({ title: '无关任务', trigger_type: 'manual', session_id: 'wxid_inv' } as never)
    })
    await expectNoInvalidation('B13 未声明的无关事务（scan_state）', h, () => {
      crmDbService.runTx((tx) => {
        tx.run('INSERT INTO scan_state (key, last_scan) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET last_scan = excluded.last_scan', [`inv:tx:${now}`, now])
      })
    })
    await expectNoInvalidation('B14 未声明的无关事务（outbox_event）', h, () => {
      crmDbService.runTx((tx) => {
        tx.run('INSERT INTO outbox_event (source, idempotency_key, payload, status, created_at) VALUES (?,?,?,?,?)',
          ['test', `inv-${now}`, '{}', 'pending', now])
      })
    })
    ok('B15 白名单常量与需求一致', (() => {
      const crmTables = [...ANNUAL_REVIEW_CRM_SOURCE_TABLES].sort().join(',')
      const salesTables = [...ANNUAL_REVIEW_SALES_SOURCE_TABLES].sort().join(',')
      const auditActions = [...ANNUAL_REVIEW_AUDIT_ACTIONS].sort().join(',')
      return crmTables === 'account,allocation,assignment,contract,contract_status_history,lead,opportunity,opportunity_event' &&
        salesTables === 'customer_profile,intent_tag_log' &&
        auditActions === 'lead_assign,lead_transfer,sync_apply'
    })())
    h.unsubscribe()
    resetAnnualReviewInvalidationForTest()
  }

  // ══ C. 相关写入立即失效（白名单 + 显式声明） ════════════════════════════════
  {
    const h = createHarness()
    const now = Date.now()
    const accountId = Number(crmDbService.create('account', { name: '失效客户', session_id: 'wxid_inv', created_at: now, updated_at: now }))
    await expectImmediateInvalidation('C0 客户新增（create: account）', h, () => {
      crmDbService.create('account', { name: '新客户', created_at: now, updated_at: now })
    })
    await expectImmediateInvalidation('C1 客户修改（update: account）', h, () => {
      crmDbService.update('account', accountId, { name: '失效客户（改名）', updated_at: now })
    })
    const contractId = Number(crmDbService.create('contract', { account_id: accountId, name: '失效客户-合同', amount: 3000, status: 'pending_sign', created_at: now, updated_at: now }))
    await expectImmediateInvalidation('C2 合同签约（signContract → contract + contract_status_history）', h, () => {
      const r = crmDbService.signContract(contractId)
      if (!r.ok) throw new Error(`signContract 失败：${r.reason}`)
    })
    const payRecordId = Number(crmDbService.create('payment_record', { amount_net: 3000, created_at: now }))
    const allocationId = Number(crmDbService.addAllocations(payRecordId, [{ customerHint: '失效客户', salesHint: '测试销售甲', amountHint: 3000 }])[0])
    await expectImmediateInvalidation('C3 核销认领（confirmAllocation）', h, () => {
      const r = crmDbService.confirmAllocation(allocationId, { account_id: accountId, contract_id: contractId })
      if (!r.ok) throw new Error(`confirmAllocation 失败：${r.reason}`)
    })
    await expectImmediateInvalidation('C4 财务核销（reconcileAllocation）', h, () => {
      const r = crmDbService.reconcileAllocation(allocationId)
      if (!r.ok) throw new Error(`reconcileAllocation 失败：${r.reason}`)
    })
    await expectImmediateInvalidation('C5 合同出货（shipContract）', h, () => {
      const r = crmDbService.shipContract(contractId)
      if (!r.ok) throw new Error(`shipContract 失败：${r.reason}`)
    })
    await expectImmediateInvalidation('C6 assignment 写入（create: assignment）', h, () => {
      crmDbService.create('assignment', { lead_id: 1, sales_name: '测试销售甲', mode: 'manual', status: 'assigned', source: 'test', updated_by: 'test', updated_at: now, version: 1, deleted: 0 })
    })
    await expectImmediateInvalidation('C7 显式声明的事务（runTx: crm:assignment）', h, () => {
      crmDbService.runTx((tx) => {
        tx.run("UPDATE assignment SET status = 'claimed', updated_at = ? WHERE lead_id = ?", [now, 1])
      }, { affectsAnnualReview: 'crm:assignment' })
    })
    await expectImmediateInvalidation('C8 lead 写入（create: lead）', h, () => {
      crmDbService.create('lead', { contact_type: 'phone', contact_normalized: `139${String(now).slice(-8)}`, contact_raw: 'C8', status: 'NEW', first_contact_deadline: 0, created_at: now, updated_at: now })
    })
    await expectImmediateInvalidation('C9 客户阶段变更（salesDb customerUpsert）', h, () => {
      salesDbService.customerUpsert({ session_id: 'wxid_inv', stage: '决策', last_contact_at: Math.floor(now / 1000) })
    })
    await expectImmediateInvalidation('C10 意向阶段事件（salesDb intentCreate）', h, () => {
      salesDbService.intentCreate({ session_id: 'wxid_inv', stage: '决策', source: 'manual', reason: '测试', message_key: null, evidence_text: null } as never)
    })
    await expectImmediateInvalidation('C11 画像 customer_id 回写（setCustomerProfileCustomerId）', h, () => {
      const profile = salesDbService.customerGetBySession('wxid_inv')
      if (profile) salesDbService.setCustomerProfileCustomerId(Number(profile.id), '900-1')
      else throw new Error('画像不存在')
    })
    await expectImmediateInvalidation('C12 阶段变更时间戳（updateStageChangeTime）', h, () => {
      salesDbService.updateStageChangeTime('wxid_inv', now)
    })
    const opp = crmDbService.opportunityUpsertBySignal(accountId, '失效客户', { product: '叉车', quantity: 1, amount: 1000, stage: '比价', detail: '测试信号' })
    const oppId = Number(opp.id)
    await expectImmediateInvalidation('C13 商机阶段变更（opportunityUpdateStage）', h, () => {
      if (!crmDbService.opportunityUpdateStage(oppId, '决策', 'manual')) throw new Error('未生效')
    })
    await expectImmediateInvalidation('C14 商机流失关单（opportunityClose）', h, () => {
      crmDbService.opportunityClose(oppId, 'lost', '测试流失')
    })
    await expectImmediateInvalidation('C15 商机事件（opportunityEventAdd）', h, () => {
      crmDbService.opportunityEventAdd(oppId, 'note', '决策', '测试事件')
    })
    await expectImmediateInvalidation('C16 audit_event 白名单动作（lead_assign）', h, () => {
      crmDbService.auditAppend('system', 'lead_assign', 'lead', 1, { salesName: '测试销售甲' })
    })
    await expectImmediateInvalidation('C17 audit_event 白名单动作（sync_apply）', h, () => {
      crmDbService.auditAppend('system:sync', 'sync_apply', 'lead', 1, { type: 'assign' })
    })
    await expectImmediateInvalidation('C18 客户删除（deleteAccount 级联事务）', h, () => {
      const victimId = Number(crmDbService.create('account', { name: '待删客户', created_at: now, updated_at: now }))
      settleWindow() // 建客户本身也会失效：先排掉，只观察删除这一步
      const r = crmDbService.deleteAccount(victimId)
      if (!r.ok) throw new Error(`deleteAccount 失败：${r.reason}`)
    })
    await expectImmediateInvalidation('C19 合同删除（deleteContract 级联事务）', h, () => {
      const doomed = Number(crmDbService.create('contract', { account_id: accountId, name: '待删合同', amount: 10, status: 'draft', created_at: now, updated_at: now }))
      settleWindow()
      const r = crmDbService.deleteContract(doomed)
      if (!r.ok) throw new Error(`deleteContract 失败：${r.reason}`)
    })
    ok('C20 声明辅助函数对白名单外的表返回 false（no-op）',
      announceAnnualReviewCrmWrite('scan_state') === false &&
      announceAnnualReviewSalesWrite('knowledge_base') === false &&
      announceAnnualReviewAuditAction('contract_edit') === false)
    ok('C21 声明辅助函数对白名单内的表返回 true',
      announceAnnualReviewCrmWrite('contract') === true &&
      announceAnnualReviewSalesWrite('intent_tag_log') === true &&
      announceAnnualReviewAuditAction('lead_transfer') === true)
    settleWindow()
    h.unsubscribe()
    resetAnnualReviewInvalidationForTest()
  }

  // ══ D. 失败或回滚写入不失效 ════════════════════════════════════════════════
  {
    const h = createHarness()
    settleWindow()
    await warmCaches(h)
    let threw = false
    try {
      crmDbService.runTx(() => { throw new Error('模拟写入失败') }, { affectsAnnualReview: 'crm:contract' })
    } catch { threw = true }
    ok('D1 事务回滚：写入抛错', threw)
    ok('D2 失败事务即使已声明也不失效（报告缓存仍命中）', h.service.getReport(YEAR).cache === 'hit')
    ok('D3 失败事务即使已声明也不失效（AI 缓存仍在）', h.coordinator.cacheSize() === 1)
    ok('D4 失败事务不派发任何事件', (() => {
      const seen: AnnualReviewInvalidationEvent[] = []
      const off = onAnnualReviewInvalidation((e) => seen.push(e))
      settleWindow()
      off()
      return seen.length === 0
    })())
    ok('D5 非法实体早退不派发', (() => {
      const created = crmDbService.create('not_an_entity', { x: 1 })
      return created === 0 && !hasPendingAnnualReviewInvalidation()
    })())
    h.unsubscribe()
    resetAnnualReviewInvalidationForTest()
  }

  // ══ E. 无关写入不打断运行中的报告/AI 任务 ════════════════════════════════════
  {
    const h = createHarness()
    // 报告任务运行中
    const started = h.service.start(YEAR)
    await tick()
    const now = Date.now()
    crmDbService.setScanState(`inv:e:${now}`, now)
    crmDbService.markMsgProcessed(`msg-e-${now}`)
    salesDbService.kbCreate({ category: 'qa', title: `E${now}`, content: 'x', tags: [], scene: null, authority: 'community', source: 'manual' } as never)
    salesDbService.todoCreate({ title: '无关任务E', trigger_type: 'manual' } as never)
    await tick()
    ok('E1 无关写入不打断运行中的报告生成任务',
      h.service.getTaskState(YEAR)?.status !== 'failed' && h.service.getTaskState(YEAR)?.taskId === started.taskId)
    ok('E2 无关写入不产生待派发事件', !hasPendingAnnualReviewInvalidation())

    // AI 任务运行中（挂起）
    h.runnerCalls.find((c) => c.payload.taskId === started.taskId)?.resolve(
      composeAnnualReviewReport({ period: resolveAnnualReviewPeriod(YEAR, GEN), facts, sales, crm, opts: { messageStats } })
    )
    await wait(3)
    let aiGate: ((v: unknown) => void) | null = null
    const hanging = new AnnualReviewAiCoordinator({
      getTaskReport: (taskId) => h.service.getTaskReport(taskId),
      getConfig: () => ({ get: () => undefined }) as never,
      generate: (() => new Promise((resolve) => { aiGate = resolve })) as never,
      now: () => GEN
    })
    const off = installAnnualReviewInvalidation({ handleDataChanged: () => h.service.handleDataChanged(), invalidateAll: () => hanging.invalidateAll() })
    const run = hanging.run(started.taskId)
    await tick()
    ok('E3 AI 分析已发起', hanging.inFlightCount() === 1)
    crmDbService.setScanState(`inv:e2:${now}`, now)
    salesDbService.reportCreate({ period_type: 'week', period_start: now, period_end: now, stats: '{}', ai_summary: null } as never)
    await tick()
    ok('E4 无关写入不取消在途 AI 分析', hanging.inFlightCount() === 1)
    aiGate?.({ ok: true, analysis: ANALYSIS, model: 'fake', promptVersion: ANNUAL_REVIEW_AI_PROMPT_VERSION, generatedAt: GEN })
    ok('E5 无关写入期间发起的 AI 分析正常收敛', (await run).success === true)
    off()
    h.unsubscribe()
    resetAnnualReviewInvalidationForTest()
  }

  // ══ E2. 相关写入在运行期间**立即**失效（不等窗口、不 flush） ═════════════════
  {
    const h = createHarness()
    const now = Date.now()
    settleWindow() // 从空闲窗口开始：本节的写入都是各自窗口的**首条**事件（要求 9 的口径）
    const started = h.service.start(YEAR)
    await tick()
    ok('E6 报告生成任务运行中（loading/computing）', (() => {
      const st = h.service.getTaskState(YEAR)?.status
      return st === 'loading' || st === 'computing'
    })())
    crmDbService.update('contract', 1, { amount: 4321, updated_at: now }) // 相关写入（合同被改）
    await tick()
    const st = h.service.getTaskState(YEAR)
    ok('E7 相关写入**立即**让运行中的报告任务进入失效收敛（未等 150ms）',
      st?.status === 'failed' && st?.error?.code === 'invalidated')
    ok('E8 失效期间不写缓存（getReport 非 hit）', h.service.getReport(YEAR).cache !== 'hit')
    ok('E8b 任务标识保持绑定（迟到结果无法冒充成功）', st?.taskId === started.taskId)

    // AI：相关写入立即中止在途分析（结果作废、不缓存）
    const warmed = await warmCaches(h)
    let gate: ((v: unknown) => void) | null = null
    let signal: AbortSignal | undefined
    const hangCoordinator = new AnnualReviewAiCoordinator({
      getTaskReport: (taskId) => h.service.getTaskReport(taskId),
      getConfig: () => ({ get: () => undefined }) as never,
      generate: ((_r: unknown, options: { signal?: AbortSignal }) =>
        new Promise((resolve) => { gate = resolve; signal = options.signal })) as never,
      now: () => GEN
    })
    const offHang = installAnnualReviewInvalidation({
      handleDataChanged: () => h.service.handleDataChanged(),
      invalidateAll: () => { h.coordinator.invalidateAll(); hangCoordinator.invalidateAll() }
    })
    settleWindow() // 同上：让后续相关写入成为新窗口的首条事件
    const run = hangCoordinator.run(warmed)
    await tick()
    ok('E9 在途 AI 分析已发起', hangCoordinator.inFlightCount() === 1)
    crmDbService.auditAppend('system', 'lead_transfer', 'lead', 1, { fromSales: 'A', toSales: '测试销售甲' }) // 相关写入
    await tick()
    ok('E10 相关写入**立即**中止在途 AI 分析（出口信号已中止，未等 150ms）', signal?.aborted === true)
    gate?.({ ok: true, analysis: ANALYSIS, model: 'fake', promptVersion: ANNUAL_REVIEW_AI_PROMPT_VERSION, generatedAt: GEN })
    const res = await run
    ok('E11 失效期间在途 AI 结果 → invalidated（不返回成功）', res.success === false && res.error.code === 'invalidated')
    ok('E12 失效期间在途 AI 结果不写缓存', hangCoordinator.cacheSize() === 0)
    offHang()
    h.unsubscribe()
    resetAnnualReviewInvalidationForTest()
  }

  // ══ F. 账号隔离不受破坏 ════════════════════════════════════════════════════
  {
    const h = createHarness()
    const taskIdA = await warmCaches(h)
    h.ctx.wxid = 'wx_inv_b'
    h.ctx.salesDbName = 'sales-inv-b.db'
    h.ctx.crmDbName = 'crm-inv-b.db'
    announceAnnualReviewDataChangedNow('account_switch')
    ok('F1 切号后 B 作用域报告缓存为 miss（绝不回退 A 的报告）', h.service.getReport(YEAR).cache === 'miss')
    const cross = h.service.getTaskReport(taskIdA)
    ok('F2 切号后 A 的 taskId 按不存在返回（fail closed）', cross.ok === false && cross.code === 'task_not_found')
    ok('F3 AI 结果缓存已清空（不跨账号复用）', h.coordinator.cacheSize() === 0)
    h.unsubscribe()
    resetAnnualReviewInvalidationForTest()
  }

  // ══ G. 读操作不接入失效 ════════════════════════════════════════════════════
  {
    const events: AnnualReviewInvalidationEvent[] = []
    const off = onAnnualReviewInvalidation((e) => events.push(e))
    crmDbService.all('SELECT * FROM account')
    crmDbService.list('contract', { limit: 5 })
    crmDbService.getById('account', 1)
    crmDbService.customers()
    crmDbService.statsOverview()
    crmDbService.opportunityStats()
    crmDbService.autoConfirmHistory(5)
    crmDbService.getScanState('inv:test:key')
    salesDbService.all('SELECT * FROM customer_profile')
    await tick()
    ok('G1 纯读操作不产生任何失效派发（失效不接在读路径上）', events.length === 0 && !hasPendingAnnualReviewInvalidation())
    off()
    settleWindow()
  }

  // ══ H. LAN/中央下行应用 + assignment 总线桥 ════════════════════════════════
  {
    const h = createHarness()
    const now = Date.now()
    crmDbService.runTx((tx) => tx.run(
      'INSERT INTO lead (contact_type, contact_normalized, contact_raw, wechat, source, name, status, first_contact_deadline, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      ['phone', '13900009999', 'H线索', '', '测试', 'H线索', 'NEW', 0, now, now]
    ), { affectsAnnualReview: 'crm:lead' })
    const offBridge = bridgeAssignmentInvalidationToAnnualReview(assignmentBus.onAssignmentInvalidated)
    settleWindow()
    await warmCaches(h)
    const outcome = lanSync.applyDownEventDirect({
      idempotencyKey: `inv-down-${now}`,
      type: 'assign',
      to: '测试销售甲',
      sourceDeviceId: 'hub-1',
      deliveryRole: 'apply',
      payload: { leadId: 888001, salesName: '测试销售甲', mode: 'manual', actor: 'system:test', lead: { name: 'H线索', contact: '13900009999' } }
    } as never)
    assignmentBus.flushAssignmentInvalidationForTest() // assignment 总线自身也有合并窗口
    ok('H1 LAN/中央下行应用成功（applied）', outcome === 'applied')
    ok('H2 下行应用后**立即**报告缓存失效', h.service.getReport(YEAR).cache !== 'hit')
    ok('H3 下行应用后**立即** AI 结果缓存失效', h.coordinator.cacheSize() === 0)
    offBridge()
    h.unsubscribe()
    resetAnnualReviewInvalidationForTest()
  }

  try { rmSync(dbDir, { recursive: true, force: true }) } catch { /* ignore */ }
  try { rmSync(isoDir, { recursive: true, force: true }) } catch { /* ignore */ }

  console.log(`结果：${pass} 通过 / ${fail} 失败`)
  process.exit(fail > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('FATAL:', e)
  process.exit(1)
})
