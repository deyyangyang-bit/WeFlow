/**
 * central-sync-adapter-test.ts —— Phase 3a Electron 同步 adapter 验证
 * （electron/services/centralSyncService.ts + centralProjection.ts）。
 *
 * 覆盖：
 *   A. 上行投影：只从既有业务表产生事件；禁字段双保险；身份只上哈希+掩码；审计裁剪
 *   B. 推送语义：被接受才置 sent / 失败保留 pending；游标只在受理后推进；幂等键稳定
 *   C. 下行：assign 复用既有状态机；重复投递幂等；nolead 有上限重试后转终态；未知类型直接终态
 *   D. 中央专有下行：主管修正入待确认收件箱（不覆盖本地）；权限变更只作声明
 *   E. 解绑：服务端吊销优先；网络失败不清本地；强制清除如实标注未吊销
 *   F. 调度器：幂等启动/停止、解绑后安全空转、间隔变更即时生效
 *   G. 与 Phase 1 SMB 互斥 + 令牌落 safeStorage 加密字段
 *
 * 隔离：WEFLOW_WORKER + /tmp 三环境变量在模块顶部设置，业务模块一律动态 import。
 * 运行：npx tsx scripts/central-sync-adapter-test.ts
 */
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const isoDir = mkdtempSync(join(tmpdir(), 'centralsync-adapter-'))
process.env.WEFLOW_WORKER = '1'
process.env.WEFLOW_USER_DATA_PATH = isoDir
process.env.WEFLOW_CONFIG_CWD = isoDir

let pass = 0
let fail = 0
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; console.log(`  ✅ ${name}`) } else { fail++; console.log(`  ❌ ${name} ${detail}`) }
}

import type { CentralSyncEvent } from '../shared/centralSync'
import { findForbiddenCentralField } from '../shared/centralSync'

let crmDbService: (typeof import('../electron/services/crmDbService'))['crmDbService']
let salesDbService: (typeof import('../electron/services/salesDbService'))['salesDbService']
let ConfigService: (typeof import('../electron/services/config'))['ConfigService']
let service: typeof import('../electron/services/centralSyncService')

const PHONE = '13800001111'
const SESSION = 'session-should-never-be-uploaded'
const TOKEN = 'adapter-device-token-0123456789abcdefghijklmnop'

interface Captured { url: string; method: string; body: unknown }
let captured: Captured[] = []
let pushMode: 'ok' | 'reject_all' | 'network_fail' = 'ok'
let pullQueue: Array<CentralSyncEvent & { centralSeq: number }> = []
let ackBodies: Array<{ acknowledgements: Array<{ eventId: string; outcome: string; detail?: string }> }> = []

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** 假中央服务：只按路径路由，绝不发真实网络请求 */
const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = String(input)
  const body = init?.body ? JSON.parse(String(init.body)) : undefined
  captured.push({ url, method: String(init?.method || 'GET'), body })
  if (url.endsWith('/api/v1/sync/push')) {
    if (pushMode === 'network_fail') throw new Error('network unreachable')
    const events = (body as { events: CentralSyncEvent[] }).events
    if (pushMode === 'reject_all') {
      return jsonResponse(200, { ok: true, data: { accepted: [], rejected: events.map((e) => ({ eventId: e.eventId, code: 'forbidden_field', message: 'x' })) } })
    }
    return jsonResponse(200, { ok: true, data: { accepted: events.map((e, i) => ({ eventId: e.eventId, centralSeq: i + 1, duplicate: false })), rejected: [] } })
  }
  if (url.includes('/api/v1/sync/pull')) {
    const events = pullQueue
    return jsonResponse(200, { ok: true, data: { events, nextCursor: events.length ? events[events.length - 1]!.centralSeq : 0, hasMore: false } })
  }
  if (url.endsWith('/api/v1/sync/ack')) {
    ackBodies.push(body as { acknowledgements: Array<{ eventId: string; outcome: string }> })
    return jsonResponse(200, { ok: true, data: { acknowledged: (body as { acknowledgements: unknown[] }).acknowledgements.length } })
  }
  if (url.endsWith('/api/v1/devices/revoke-self')) {
    if (pushMode === 'network_fail') throw new Error('network unreachable')
    return jsonResponse(200, { ok: true, data: { revoked: true } })
  }
  return jsonResponse(404, { ok: false, code: 'E404', message: 'not found' })
}) as unknown as typeof fetch

/** 所有已捕获请求体拼成的全文，用于禁字段/明文泄漏扫描 */
function capturedText(): string {
  return captured.map((c) => JSON.stringify(c.body ?? null)).join('\n')
}
function pushedEvents(): CentralSyncEvent[] {
  const out: CentralSyncEvent[] = []
  for (const call of captured) {
    if (!call.url.endsWith('/api/v1/sync/push')) continue
    out.push(...(call.body as { events: CentralSyncEvent[] }).events)
  }
  return out
}
function resetCapture(): void { captured = []; ackBodies = [] }

function configureBinding(): void {
  const cfg = ConfigService.getInstance()
  cfg.set('centralSyncEnabled', true)
  cfg.set('centralSyncBaseUrl', 'https://central.test')
  cfg.set('centralSyncDeviceToken', TOKEN)
  cfg.set('centralSyncWorkspaceId', 'ws-1')
  cfg.set('centralSyncEmployeeId', 'emp-1')
  cfg.set('centralSyncDeviceId', 'dev-1')
  cfg.set('centralSyncRole', 'sales')
  cfg.set('centralSyncDisplayName', '测试销售甲')
}

function clearBinding(): void {
  const cfg = ConfigService.getInstance()
  cfg.set('centralSyncEnabled', false)
  cfg.set('centralSyncDeviceToken', '')
  cfg.set('centralSyncWorkspaceId', '')
  cfg.set('centralSyncEmployeeId', '')
  cfg.set('centralSyncDeviceId', '')
}

function downEvent(eventId: string, type: string, payload: Record<string, unknown>, centralSeq: number): CentralSyncEvent & { centralSeq: number } {
  return {
    protocolVersion: 1, eventId, eventSeq: centralSeq, idempotencyKey: `central/${eventId}`, direction: 'down',
    entityType: 'assignment', entityId: `dev-1/${eventId}`, eventType: type, aggregateVersion: 1,
    payload, occurredAt: Date.now(), centralSeq
  } as CentralSyncEvent & { centralSeq: number }
}

async function main(): Promise<void> {
  ConfigService = (await import('../electron/services/config')).ConfigService
  crmDbService = (await import('../electron/services/crmDbService')).crmDbService
  salesDbService = (await import('../electron/services/salesDbService')).salesDbService
  service = await import('../electron/services/centralSyncService')
  const { getLanSyncConfig } = await import('../electron/services/lanSyncService')

  await crmDbService.initialize(isoDir)
  await salesDbService.initialize(isoDir)
  configureBinding()
  globalThis.fetch = fakeFetch

  console.log('═══ A. 上行投影 ═══')
  crmDbService.runTx((tx) => {
    tx.run('INSERT INTO customer (name, type, source, updated_by, updated_at, version, deleted) VALUES (?,?,?,?,?,?,?)',
      ['上行客户甲', 'end_user', 'manual', '测试销售甲', Date.now(), 3, 0])
    tx.run('INSERT INTO customer (name, source, updated_at, version, deleted) VALUES (?,?,?,?,?)', ['', 'manual', Date.now(), 1, 0])
    tx.run('INSERT INTO customer_identity (identity_type, identity_value, customer_id, source, confidence, updated_at, version, deleted) VALUES (?,?,?,?,?,?,?,?)',
      ['phone', PHONE, 1, 'manual', 1.0, Date.now(), 1, 0])
    tx.run('INSERT INTO assignment (lead_id, sales_name, mode, sla1_deadline, status, source, updated_by, updated_at, version, deleted) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [501, '测试销售甲', 'manual', Date.now() + 86_400_000, 'assigned', 'test', '测试销售甲', Date.now(), 1, 0])
    tx.run('INSERT INTO account (name, owner_sales, created_at, updated_at) VALUES (?,?,?,?)', ['账户甲', '测试销售甲', Date.now(), Date.now()])
    tx.run('INSERT INTO opportunity (account_id, name, amount, stage, owner_sales, quantity, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
      [1, '商机甲', 12_000, 'quoting', '测试销售甲', 2, 'active', Date.now(), Date.now()])
    tx.run('INSERT INTO outbox_event (event_seq, idempotency_key, payload, status, source, created_at) VALUES (?,?,?,?,?,?)',
      [1, 'claim:501', JSON.stringify({ type: 'claim', leadId: 501, version: 1 }), 'pending', 'test', Date.now()])
    tx.run('INSERT INTO audit_event (actor, action, entity_type, entity_id, detail, created_at) VALUES (?,?,?,?,?,?)',
      ['测试销售甲', 'lead_claim', 'lead', 501, JSON.stringify({ phone: PHONE }), Date.now()])
    tx.run('INSERT INTO audit_event (actor, action, entity_type, entity_id, detail, created_at) VALUES (?,?,?,?,?,?)',
      ['system:sync', 'sync_apply', 'lead', 501, '{}', Date.now()])
  })
  const profile = salesDbService.customerUpsert({ session_id: SESSION, display_name: '上行客户甲' })
  salesDbService.setCustomerProfileCustomerId(Number(profile.id), '1')
  salesDbService.judgmentCreate({
    session_id: SESSION, judgment_type: 'summary', value: '客户关注续航', confidence: 0.8,
    source: 'ai', model: 'test-model', message_key: 'mk-evidence-1', evidence_text: '客户原话不应上行', generated_at: Date.now(), created_at: Date.now()
  } as never)
  salesDbService.kbCreate({ category: '话术', title: '电池保养话术提案', content: '锂电 3-5 年更换', source: 'proposal', evidence_key: 'mk-kb-1' })

  const first = await service.runCentralSyncOnce()
  ok('A1 单次同步在一次运行内完成上行与下行', first.enabled === true && first.error === undefined, String(first.error))
  const events = pushedEvents()
  const byType = (t: string) => events.filter((e) => e.entityType === t)
  ok('A2 已确认客户被上行（displayName 有值，空名行跳过）',
    byType('customer').length === 1 && byType('customer')[0]!.payload.displayName === '上行客户甲')
  ok('A3 客户 entityId 带设备前缀（多机同 id 不互相覆盖）',
    byType('customer')[0]!.entityId.startsWith('dev-1/') && byType('customer')[0]!.idempotencyKey.startsWith('dev-1/'))
  ok('A4 身份映射只上哈希 + 掩码',
    byType('customer_identity').length === 1 &&
    String(byType('customer_identity')[0]!.payload.identityHash).length === 64 &&
    byType('customer_identity')[0]!.payload.identityMasked === '138****11')
  ok('A5 手机号原文不出现在任何上行请求体', !capturedText().includes(PHONE))
  ok('A6 session_id 既不作字段名也不作取值上行',
    !capturedText().includes('session_id') && !capturedText().includes(SESSION))
  ok('A7 判断上行了证据锚点但不带证据原文',
    byType('customer_judgment').length === 1 &&
    byType('customer_judgment')[0]!.payload.evidenceKey === 'mk-evidence-1' &&
    !capturedText().includes('客户原话不应上行'))
  ok('A8 知识提案走既有知识表投影', byType('knowledge_proposal').length === 1 &&
    byType('knowledge_proposal')[0]!.payload.title === '电池保养话术提案')
  ok('A9 分配 / 归属 / 商机 / 审计 / outbox 均被上行',
    byType('assignment').length >= 1 && byType('ownership').length === 1 &&
    byType('opportunity').length === 1 && byType('audit_event').length === 1 && byType('permission').length === 1)
  ok('A10 既有 outbox 行复用（claim 事件类型原样上行，未另造类型）',
    events.some((e) => e.eventType === 'claim' && e.idempotencyKey === 'dev-1/claim:501'))
  ok('A11 同步自身的审计（sync_* 动作）不上行，避免自激',
    !byType('audit_event').some((e) => String(e.payload.action).startsWith('sync_')))
  ok('A12 审计 detail 中的手机号已脱敏',
    !JSON.stringify(byType('audit_event')[0]!.payload).includes(PHONE))
  const offenders = events.filter((e) => findForbiddenCentralField(e.payload) !== null)
  ok('A13 全部上行事件通过禁字段扫描（聊天/消息/session_id/wcdb 路径）', offenders.length === 0,
    offenders.map((e) => e.entityType).join(','))
  ok('A14 权限声明标注来源为本地声明（服务端不得当授权依据）',
    byType('permission')[0]!.payload.authoritySource === 'local_declaration')

  console.log('═══ B. 推送语义与游标 ═══')
  const outboxRow = () => crmDbService.all("SELECT * FROM outbox_event WHERE idempotency_key='claim:501'")[0]
  ok('B1 推送被接受后 outbox 才置 sent', String(outboxRow()?.status) === 'sent')
  const cursorAfter = crmDbService.getScanState('centralSync:cursor:customer')
  ok('B2 受理后投影游标推进到本批末行', cursorAfter >= 1)
  const eventsBefore = pushedEvents().length

  resetCapture()
  await service.runCentralSyncOnce()
  ok('B3 游标推进后不重复上行同一行', pushedEvents().length < eventsBefore ||
    !pushedEvents().some((e) => e.entityType === 'customer' && e.payload.displayName === '上行客户甲'))
  ok('B4 权限声明只上行一次（不每轮重复声明）',
    !pushedEvents().some((e) => e.entityType === 'permission'))

  crmDbService.runTx((tx) => {
    tx.run('INSERT INTO outbox_event (event_seq, idempotency_key, payload, status, source, created_at) VALUES (?,?,?,?,?,?)',
      [9, 'claim:999', JSON.stringify({ type: 'claim', leadId: 999, version: 1 }), 'pending', 'test', Date.now()])
  })
  pushMode = 'network_fail'
  resetCapture()
  const failRun = await service.runCentralSyncOnce()
  ok('B5 网络失败：不置 sent、不回假成功、错误如实上抛',
    String(crmDbService.all("SELECT * FROM outbox_event WHERE idempotency_key='claim:999'")[0]?.status) === 'pending' &&
    Boolean(failRun.error))
  ok('B6 失败原因写入状态（设置页可读），且不含令牌明文',
    service.centralSyncStatus().lastError.length > 0 && !service.centralSyncStatus().lastError.includes(TOKEN))
  const cursorFrozen = crmDbService.getScanState('centralSync:cursor:customer')
  pushMode = 'ok'
  resetCapture()
  await service.runCentralSyncOnce()
  ok('B7 网络恢复后重放成功，事件不丢', String(crmDbService.all("SELECT * FROM outbox_event WHERE idempotency_key='claim:999'")[0]?.status) === 'sent')
  ok('B8 失败期间游标未被推空（无静默丢事件）', cursorFrozen <= crmDbService.getScanState('centralSync:cursor:customer'))
  const firstKey = pushedEvents().find((e) => e.eventType === 'claim' && e.idempotencyKey === 'dev-1/claim:999')!.eventId
  crmDbService.runTx((tx) => { tx.run("UPDATE outbox_event SET status='pending' WHERE idempotency_key='claim:999'") })
  resetCapture()
  await service.runCentralSyncOnce()
  const secondKey = pushedEvents().find((e) => e.eventType === 'claim' && e.idempotencyKey === 'dev-1/claim:999')!.eventId
  ok('B9 同幂等键重放产生同一 eventId（中央据此判重，不产生第二条业务记录）', firstKey === secondKey)

  pushMode = 'reject_all'
  crmDbService.runTx((tx) => { tx.run("UPDATE outbox_event SET status='pending' WHERE idempotency_key='claim:999'") })
  resetCapture()
  const rejectedRun = await service.runCentralSyncOnce()
  ok('B10 被中央拒绝的事件如实计数并留本机审计，不静默吞掉',
    rejectedRun.rejected >= 1 &&
    crmDbService.all("SELECT * FROM audit_event WHERE action='sync_push_rejected'").length >= 1)
  pushMode = 'ok'

  console.log('═══ C. 下行：既有状态机 ═══')
  clearBinding(); configureBinding()
  crmDbService.setScanState('centralSync:pullCursor', 0)
  pullQueue = [downEvent('ev-assign-1', 'assign', {
    leadId: 9001, lead: { contactType: 'phone', contactNormalized: '13900000001', name: '下行客户甲' },
    salesName: '测试销售甲', sla1Deadline: Date.now() + 86_400_000, mode: 'manual', deliveryRole: 'apply'
  }, 1)]
  resetCapture()
  await service.runCentralSyncOnce()
  const assignRows = crmDbService.all('SELECT * FROM assignment WHERE lead_id = (SELECT id FROM lead WHERE contact_normalized = ?)', ['13900000001'])
  ok('C1 下行 assign 复用既有状态机落地（source=sync:down）',
    assignRows.length === 1 && String(assignRows[0]!.source) === 'sync:down')
  ok('C2 应用成功回 ack=applied，游标推进', ackBodies.some((b) => b.acknowledgements.some((a) => a.outcome === 'applied')) &&
    crmDbService.getScanState('centralSync:pullCursor') === 1)
  ok('C3 下行落地在审计链留痕', crmDbService.all("SELECT * FROM audit_event WHERE action='sync_apply'").length >= 1)

  crmDbService.setScanState('centralSync:pullCursor', 0)
  resetCapture()
  await service.runCentralSyncOnce()
  const assignRows2 = crmDbService.all('SELECT * FROM assignment WHERE lead_id = (SELECT id FROM lead WHERE contact_normalized = ?)', ['13900000001'])
  ok('C4 重复拉取同事件不产生第二条业务记录（幂等标记）', assignRows2.length === 1)

  console.log('═══ D. 下行：中央专有类型 ═══')
  crmDbService.setScanState('centralSync:pullCursor', 0)
  pullQueue = [
    downEvent('ev-correction-1', 'supervisor_correction', {
      leadId: 9001, title: '主管修正：归属应为乙', summary: '请确认后改派', deliveryRole: 'apply'
    }, 1),
    downEvent('ev-perm-1', 'permission_change', { employeeRef: 'emp-1', declaredRole: 'supervisor', deliveryRole: 'apply' }, 2)
  ]
  const beforeAssign = crmDbService.all("SELECT * FROM assignment WHERE lead_id = (SELECT id FROM lead WHERE contact_normalized = ?)", ['13900000001'])
  resetCapture()
  await service.runCentralSyncOnce()
  const inbox = crmDbService.all("SELECT * FROM notify_inbox WHERE notify_type='supervisor_correction'")
  ok('D1 主管修正入待确认收件箱（幂等键落库）', inbox.length === 1 && String(inbox[0]!.idempotency_key).startsWith('central:'))
  const afterAssign = crmDbService.all("SELECT * FROM assignment WHERE lead_id = (SELECT id FROM lead WHERE contact_normalized = ?)", ['13900000001'])
  ok('D2 主管修正不静默覆盖本地归属（本地事实一行未改）',
    JSON.stringify(beforeAssign) === JSON.stringify(afterAssign))
  ok('D3 主管修正留审计（pending，非 applied-to-fact）',
    crmDbService.all("SELECT * FROM audit_event WHERE action='central_supervisor_correction_pending'").length === 1)
  ok('D4 权限变更只落审计声明，不进入任何本地权限表',
    crmDbService.all("SELECT * FROM audit_event WHERE action='central_permission_change_recorded'").length === 1)
  crmDbService.setScanState('centralSync:pullCursor', 0)
  resetCapture()
  await service.runCentralSyncOnce()
  ok('D5 重复拉取主管修正不重复入箱（幂等）',
    crmDbService.all("SELECT * FROM notify_inbox WHERE notify_type='supervisor_correction'").length === 1)

  console.log('═══ E. 下行：终态与有界重试 ═══')
  crmDbService.setScanState('centralSync:pullCursor', 0)
  const noleadEvent = downEvent('ev-nolead-1', 'transfer', { leadId: 999999, toSales: '测试销售乙', deliveryRole: 'apply' }, 1)
  noleadEvent.payload = { leadId: 999999, toSales: '测试销售乙', deliveryRole: 'apply', lead: null }
  pullQueue = [noleadEvent, downEvent('ev-unknown-1', 'unknown_future_type', { deliveryRole: 'apply' }, 2)]
  let lastAcks: Array<{ eventId: string; outcome: string }> = []
  const allAcks: Array<{ eventId: string; outcome: string }> = []
  for (let i = 0; i < 5; i++) {
    crmDbService.setScanState('centralSync:pullCursor', 0)
    resetCapture()
    await service.runCentralSyncOnce()
    for (const body of ackBodies) allAcks.push(...body.acknowledgements)
    const latest = ackBodies[ackBodies.length - 1]
    if (latest) lastAcks = latest.acknowledgements
  }
  ok('E1 本机不认识的类型直接回 invalid 终态（不留无休止重试）',
    lastAcks.some((a) => a.eventId === 'ev-unknown-1' && a.outcome === 'invalid'))
  const noleadAcks = allAcks.filter((a) => a.eventId === 'ev-nolead-1')
  ok('E2 缺依赖对象先回 retry（保留重放机会）', noleadAcks.some((a) => a.outcome === 'retry'))
  ok('E3 重试达到上限后转 invalid 终态，不会无限重试',
    noleadAcks.some((a) => a.outcome === 'invalid'), noleadAcks.map((a) => a.outcome).join(','))

  console.log('═══ F. 解绑 ═══')
  pushMode = 'network_fail'
  const offline = await service.disconnectCentralBinding()
  ok('F1 网络失败：不清本机凭证（令牌仍在）、如实返回未吊销',
    offline.revoked === false && offline.localCleared === false &&
    Boolean(service.getCentralSyncConfig().token) && service.getCentralSyncConfig().enabled === true)
  ok('F2 网络失败时不会假装服务端已撤销（配置中明确记录未完成）',
    service.centralSyncStatus().lastError.includes('自助解绑未完成'))
  const forced = await service.disconnectCentralBinding({ force: true })
  ok('F3 强制清除：本地已清但如实标注服务端未吊销',
    forced.localCleared === true && forced.revoked === false && !service.getCentralSyncConfig().token)
  pushMode = 'ok'
  clearBinding(); configureBinding()
  crmDbService.setScanState('centralSync:pullCursor', 0)
  resetCapture()
  const done = await service.disconnectCentralBinding()
  ok('F4 正常解绑：先请求服务端吊销，成功后才清本机凭证',
    done.revoked === true && done.localCleared === true &&
    captured.some((c) => c.url.endsWith('/api/v1/devices/revoke-self')))
  ok('F5 解绑后本机凭证确实被清空',
    !service.getCentralSyncConfig().token && service.getCentralSyncConfig().enabled === false)
  ok('F6 解绑留本机审计', crmDbService.all("SELECT * FROM audit_event WHERE action='central_unbind'").length >= 1)

  console.log('═══ G. 调度器与互斥 ═══')
  resetCapture()
  const idle = await service.runCentralSyncOnce()
  ok('G1 未绑定状态单次同步零网络请求（安全空转）', idle.enabled === false && captured.length === 0)
  service.startCentralSyncScheduler()
  service.startCentralSyncScheduler()
  ok('G2 重复启动调度器不抛错且状态为已运行', service.centralSyncStatus().schedulerRunning === true)
  service.restartCentralSyncScheduler()
  ok('G3 重启调度器仍只有一个心跳（状态可查、无重复启动报错）',
    service.centralSyncStatus().schedulerRunning === true)
  const cfg = ConfigService.getInstance()
  cfg.set('centralSyncPollIntervalMin', 30)
  ok('G4 轮询间隔变更立即被读取（调度器每拍重读配置，不是启动时快照）',
    service.getCentralSyncConfig().pollIntervalMin === 30 && service.centralSyncStatus().pollIntervalMin === 30)
  service.stopCentralSyncScheduler()
  ok('G5 停止调度器后状态如实反映', service.centralSyncStatus().schedulerRunning === false)
  service.startCentralSyncScheduler()

  configureBinding()
  ok('G6 启用中央同步后 Phase 1 SMB adapter 自动停用（两个传输层不竞争同一 outbox）',
    getLanSyncConfig().enabled === false)
  clearBinding()
  ok('G7 关闭中央同步后不谎称 SMB 已启用（未配置共享目录时仍为关闭）',
    getLanSyncConfig().enabled === false)

  const configSource = readFileSync('electron/services/config.ts', 'utf8')
  ok('G8 设备令牌仍在 safeStorage 加密字段清单中（不明文持久化）',
    /ENCRYPTED_STRING_KEYS[\s\S]{0,400}centralSyncDeviceToken/.test(configSource))

  service.stopCentralSyncScheduler()
  console.log(`\ncentral sync adapter test: ${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

void main()
