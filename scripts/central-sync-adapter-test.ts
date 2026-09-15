/**
 * central-sync-adapter-test.ts —— Phase 3a Electron 同步 adapter 验证
 * （electron/services/centralSyncService.ts + centralProjection.ts）。
 *
 * 覆盖（对照下方实际 section 标题）：
 *   A. 上行投影：只从既有业务表产生事件；禁字段双保险；身份只上哈希+掩码；审计裁剪
 *   B. 推送语义与游标：被接受才置 sent / 失败保留 pending；游标只在受理后推进；幂等键稳定
 *   C. 下行：assign 复用既有状态机；重复投递幂等
 *   D. 下行：中央专有类型（主管修正入待确认收件箱、不覆盖本地；权限变更只作声明）
 *   E. 下行：终态与不回归（未知类型 / 契约非法直接 invalid，无重试循环、无本机业务痕迹）
 *   H. 上行指令链：员工目录解析
 *   I. 版本化增量
 *   J. 跨表引用统一
 *   K. 过滤行不阻塞游标
 *   F. 解绑：服务端吊销优先；网络失败不清本地；强制清除如实标注未吊销
 *   G. 调度器与互斥：幂等启动/停止、解绑后安全空转、间隔变更即时生效；令牌落 safeStorage
 *
 * 边界（不得据此宣称已在真实环境验证）：
 *   - 中央侧是**假服务**：按路径路由的内存实现，不启动真实中央节点、不连 PostgreSQL、不发真实网络请求；
 *   - 因此本文件只验证**本机 adapter 侧**的行为。真实 PostgreSQL 落库、真实部署、真机（含 Windows）
 *     与真实网络链路**均未验证**，由 central/test 的内存契约测试与 scripts/central-sync-e2e-test.ts 补位。
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
import { findForbiddenCentralField, isConcreteRef, validateCentralEntityId } from '../shared/centralSync'
import { validateCentralEntityId } from '../shared/centralDownCommand'

let crmDbService: (typeof import('../electron/services/crmDbService'))['crmDbService']
let salesDbService: (typeof import('../electron/services/salesDbService'))['salesDbService']
let ConfigService: (typeof import('../electron/services/config'))['ConfigService']
let service: typeof import('../electron/services/centralSyncService')
let projectionMod: typeof import('../electron/services/centralProjection')

const PHONE = '13800001111'
const SESSION = 'session-should-never-be-uploaded'
const TOKEN = 'adapter-device-token-0123456789abcdefghijklmnop'

interface Captured { url: string; method: string; body: unknown }
let captured: Captured[] = []
let pushMode: 'ok' | 'reject_all' | 'network_fail' = 'ok'
let pullQueue: Array<CentralSyncEvent & { centralSeq: number }> = []
let ackBodies: Array<{ acknowledgements: Array<{ eventId: string; outcome: string; detail?: string }> }> = []
/** 中央员工目录（解析 salesName→employeeId 的唯一权威依据）：同名项 nameUnique=false，绝不按显示名猜人 */
let directoryEmployees: Array<{ employeeId: string; employeeCode: string; displayName: string; role: string; nameUnique: boolean }> = []

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
  if (url.endsWith('/api/v1/sync/commands')) {
    if (pushMode === 'network_fail') throw new Error('network unreachable')
    // 中央侧实体校验/归属检查在真实节点里由 /sync/commands 完成；这里只回投递回执
    return jsonResponse(201, { ok: true, data: { centralSeq: 1, duplicate: false } })
  }
  if (url.endsWith('/api/v1/directory/employees')) {
    return jsonResponse(200, { ok: true, data: { employees: directoryEmployees } })
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
    payload, occurredAt: Date.now(), centralSeq,
    // 中央投递的指令必须带投递目标（§七.2/§七.4）：无目标的下行指令服务端与终端都拒收
    targetEmployeeId: 'emp-1'
  } as CentralSyncEvent & { centralSeq: number }
}

async function main(): Promise<void> {
  ConfigService = (await import('../electron/services/config')).ConfigService
  crmDbService = (await import('../electron/services/crmDbService')).crmDbService
  salesDbService = (await import('../electron/services/salesDbService')).salesDbService
  service = await import('../electron/services/centralSyncService')
  projectionMod = await import('../electron/services/centralProjection')
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
    // 线索是 assignment/商机挂到 canonical 客户的**唯一**通道（宪法 §2.4）：缺 lead 行时
    // 中央侧 customerRef 无法精确关联 central_customer，assignment 会被明确跳过而不是硬凑引用
    tx.run('INSERT INTO lead (id, contact_type, contact_normalized, account_id, name, source, first_contact_deadline, assigned_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [501, 'phone', PHONE, 1, '上行客户甲', 'test', Date.now() + 86_400_000, Date.now(), Date.now(), Date.now()])
    tx.run('INSERT INTO lead (id, contact_type, contact_normalized, account_id, name, source, first_contact_deadline, assigned_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [999, 'phone', '13900000009', 1, 'outbox 客户', 'test', Date.now() + 86_400_000, Date.now(), Date.now(), Date.now()])
    tx.run('INSERT INTO assignment (lead_id, sales_name, mode, sla1_deadline, status, source, updated_by, updated_at, version, deleted) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [501, '测试销售甲', 'manual', Date.now() + 86_400_000, 'assigned', 'test', '测试销售甲', Date.now(), 1, 0])
    tx.run('INSERT INTO account (name, owner_sales, customer_id, created_at, updated_at) VALUES (?,?,?,?,?)',
      ['账户甲', '测试销售甲', 1, Date.now(), Date.now()])
    tx.run('INSERT INTO opportunity (account_id, name, amount, stage, owner_sales, quantity, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
      [1, '商机甲', 12_000, 'quoting', '测试销售甲', 2, 'active', Date.now(), Date.now()])
    // 未归并 account（customer_id 为空）：合法中间态，中央侧必须显式跳过并记原因，不得硬造 customerRef
    tx.run('INSERT INTO account (name, owner_sales, created_at, updated_at) VALUES (?,?,?,?)', ['未归并账户乙', '测试销售甲', Date.now(), Date.now()])
    tx.run('INSERT INTO opportunity (account_id, name, amount, stage, owner_sales, quantity, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
      [2, '未归并商机乙', 500, 'initial', '测试销售甲', 1, 'active', Date.now(), Date.now()])
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
    byType('customer_identity')[0]!.payload.identityMasked === '138****1111' &&
    // 掩码退化的兜底：形态不被 maskContact 识别时必须是全掩码，绝不能原样上行
    projectionMod.maskIdentity('phone', '12345') === '*****' &&
    projectionMod.maskIdentity('wxid', 'ab') === '**')
  ok('A5 手机号原文不出现在任何上行请求体', !capturedText().includes(PHONE))
  ok('A6 session_id 既不作字段名也不作取值上行',
    !capturedText().includes('session_id') && !capturedText().includes(SESSION))
  ok('A7 判断上行了证据锚点但不带证据原文',
    byType('customer_judgment').length === 1 &&
    byType('customer_judgment')[0]!.payload.evidenceKey === 'mk-evidence-1' &&
    !capturedText().includes('客户原话不应上行'))
  ok('A8 知识提案走既有知识表投影', byType('knowledge_proposal').length === 1 &&
    byType('knowledge_proposal')[0]!.payload.title === '电池保养话术提案')
  const customerEventV1 = byType('customer')[0]!
  // 首版 assignment 事件留作 §四.5「新版本 entityId 稳定、aggregateVersion 严格递增」的对照基线
  const assignmentEventV1 = byType('assignment')[0]!
  ok('A15 outbox 事件清单全量登记：每个类型都有明确方向与落点，不存在未登记类型（§三.1/§三.11）',
    ['assign', 'transfer', 'recycle', 'claim', 'bind_wx', 'first_touch', 'sla1_escalate_supervisor']
      .every((t) => service.OUTBOX_ROUTED_TYPES.includes(t)) && service.OUTBOX_ROUTED_TYPES.length === 7)
  ok('A9 分配 / 归属 / 商机 / 审计 / outbox 均被上行',
    byType('assignment').length >= 1 && byType('ownership').length === 1 &&
    byType('opportunity').length === 1 && byType('audit_event').length === 1 && byType('permission').length === 1)
  ok('A9b 未归并 account 的归属/商机显式跳过并记原因，不硬造 customerRef',
    !events.some((e) => e.payload.customerRef !== undefined && !String(e.payload.customerRef).startsWith('dev-1/customer:')) &&
    crmDbService.all("SELECT key FROM scan_state WHERE key LIKE 'centralSync:skip:ownership:%'").length === 1 &&
    crmDbService.all("SELECT key FROM scan_state WHERE key LIKE 'centralSync:skip:opportunity:%'").length === 1)
  ok('A9c 跳过台账只允许业务性原因（未归并等），不得出现契约错误（kind 不匹配 / 禁字段）',
    crmDbService.all("SELECT key FROM scan_state WHERE key LIKE 'centralSync:skip:%'")
      .every((r) => !/entity_id_kind_mismatch|forbidden_field|entity_id_not_scoped/.test(String(r.key))))
  ok('A10 既有 outbox 行不直投原始 payload：本地事实重建为 assignment 投影，幂等键带实体版本（§一.1/§四.4）',
    events.some((e) => e.entityType === 'assignment' && e.idempotencyKey.startsWith('dev-1/assignment/assignment:1#')) &&
    !capturedText().includes('"claim:501"') &&
    crmDbService.all("SELECT * FROM outbox_event WHERE idempotency_key='claim:501'")[0]?.status === 'sent')
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
    // claim 的本地事实是「该线索已认领」：outbox 行只用于定位本地行，投递内容由投影重建
    tx.run('INSERT INTO assignment (lead_id, sales_name, mode, sla1_deadline, status, claimed_at, source, updated_by, updated_at, version, deleted) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [999, '测试销售甲', 'manual', Date.now() + 86_400_000, 'claimed', Date.now(), 'test', '测试销售甲', Date.now(), 1, 0])
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
  // outbox 行 event_seq=9 是本行投递的唯一标记（投影扫描产出的事件用本地行 id 作 eventSeq）
  const claimEvent = () => pushedEvents().find((e) => e.entityType === 'assignment' && e.eventSeq === 9)
  const firstKey = claimEvent()!.eventId
  crmDbService.runTx((tx) => { tx.run("UPDATE outbox_event SET status='pending' WHERE idempotency_key='claim:999'") })
  resetCapture()
  await service.runCentralSyncOnce()
  const secondKey = claimEvent()!.eventId
  ok('B9 同幂等键重放产生同一 eventId（中央据此判重，不产生第二条业务记录）', firstKey === secondKey)

  pushMode = 'reject_all'
  crmDbService.runTx((tx) => { tx.run("UPDATE outbox_event SET status='pending' WHERE idempotency_key='claim:999'") })
  resetCapture()
  const rejectedRun = await service.runCentralSyncOnce()
  ok('B10 被中央永久拒绝的事件置 failed 且留本机审计，不静默吞掉',
    rejectedRun.rejected >= 1 &&
    String(crmDbService.all("SELECT * FROM outbox_event WHERE idempotency_key='claim:999'")[0]?.status) === 'failed' &&
    crmDbService.all(
      "SELECT * FROM audit_event WHERE action IN ('sync_push_rejected','sync_outbox_failed')").length >= 1)
  pushMode = 'ok'

  console.log('═══ C. 下行：既有状态机 ═══')
  clearBinding(); configureBinding()
  crmDbService.setScanState('centralSync:pullCursor', 0)
  pullQueue = [downEvent('ev-assign-1', 'assign', {
    leadId: 9001, assignmentId: 9001,
    // 中央 HTTP 下行建档契约（2026-09-15 起强制）：lead 必须是完整 6 字段
    // （leadId 正整数 / contactType 枚举 / contactNormalized 非空 / name、source、note 以字符串存在）
    lead: { leadId: 9001, contactType: 'phone', contactNormalized: '13900000001', name: '下行客户甲', source: 'test', note: '' },
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
    { ...downEvent('ev-perm-1', 'permission_change', { employeeRef: 'emp-1', declaredRole: 'supervisor', deliveryRole: 'apply' }, 2),
      entityType: 'permission' as const }
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

  console.log('═══ E. 下行：终态与不回归 ═══')
  crmDbService.setScanState('centralSync:pullCursor', 0)
  // 契约非法的指令（transfer 缺 assignmentId、lead 不是对象）：共享校验器直接判非法 → 终态 invalid。
  // 这条路径过去会落到「本机缺线索」的有界重试；现在由 §七 的严格契约提前拦住，不产生无意义重试。
  const malformed = downEvent('ev-malformed-1', 'transfer',
    { leadId: 999999, toSales: '测试销售乙', deliveryRole: 'apply', lead: null }, 1)
  pullQueue = [malformed, downEvent('ev-unknown-1', 'unknown_future_type', { deliveryRole: 'apply' }, 2)]
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
  const badAcks = allAcks.filter((a) => a.eventId === 'ev-malformed-1')
  ok('E2 契约非法的指令直接终态 invalid，不进入重试循环',
    badAcks.length > 0 && badAcks.every((a) => a.outcome === 'invalid'), badAcks.map((a) => a.outcome).join(','))
  ok('E3 非法指令不写任何本机业务痕迹（线索 / 分配 / 通知 / 幂等标记）（§七.8）',
    crmDbService.all('SELECT id FROM lead WHERE id = 999999').length === 0 &&
    crmDbService.all('SELECT id FROM assignment WHERE lead_id = 999999').length === 0 &&
    crmDbService.all("SELECT id FROM audit_event WHERE entity_id = '999999'").length === 0 &&
    crmDbService.all("SELECT key FROM scan_state WHERE key LIKE 'centralSync:downAttempt:ev-malformed-1'").length === 0)

  // E4-E7 建档契约（2026-09-15）：缺建档字段的中央指令在本机应用侧同样直接终态 invalid，
  // 绝不以空身份建档（空 contact_normalized 会撞 UNIQUE(contact_type, contact_normalized)）
  crmDbService.setScanState('centralSync:pullCursor', 0)
  const leadBase = { leadId: 9101, contactType: 'phone', contactNormalized: '13900000101', name: '建档契约线索', source: 'test', note: '' }
  pullQueue = [
    downEvent('ev-lead-only', 'assign', {
      leadId: 9102, assignmentId: 9102, salesName: '测试销售甲', sla1Deadline: Date.now() + 86_400_000,
      mode: 'manual', deliveryRole: 'apply', lead: { leadId: 9102 } // 只有 leadId：无法定位/建档
    }, 1),
    downEvent('ev-lead-no-contact', 'assign', {
      leadId: 9103, assignmentId: 9103, salesName: '测试销售甲', sla1Deadline: Date.now() + 86_400_000,
      mode: 'manual', deliveryRole: 'apply', lead: { ...leadBase, leadId: 9103, contactNormalized: '' }
    }, 2),
    downEvent('ev-lead-id-mismatch', 'assign', {
      leadId: 9104, assignmentId: 9104, salesName: '测试销售甲', sla1Deadline: Date.now() + 86_400_000,
      mode: 'manual', deliveryRole: 'apply', lead: { ...leadBase, leadId: 9999 } // 顶层≠子对象：禁止按其中一个猜
    }, 3),
    downEvent('ev-transfer-no-sla', 'transfer', {
      leadId: 9105, assignmentId: 9105, oldAssignmentId: 9100, fromSales: '测试销售乙', toSales: '测试销售甲',
      deliveryRole: 'apply', lead: { ...leadBase, leadId: 9105, contactNormalized: '13900000105' } // 缺 sla1Deadline/mode
    }, 4),
    // mode 出现即必须是枚举内的字符串字面量：发送前自检与中央 HTTP / SMB 入口共用同一份注册表。
    // 这里逐个形态验证「本机应用侧也不放行」——String({}) / String(1) / String(true) 都不许蒙混过关。
    ...[
      ['ev-mode-object', {}], ['ev-mode-array', []], ['ev-mode-number', 1],
      ['ev-mode-boolean', true], ['ev-mode-unknown', 'teleport'], ['ev-mode-numeric-string', '1']
    ].map(([eventId, mode], i) => downEvent(String(eventId), 'transfer', {
      leadId: 9106 + i, assignmentId: 9106 + i, oldAssignmentId: 9100, fromSales: '测试销售乙', toSales: '测试销售甲',
      mode, sla1Deadline: Date.now() + 86_400_000, deliveryRole: 'apply',
      lead: { ...leadBase, leadId: 9106 + i, contactNormalized: `1390000020${i}` }
    }, 5 + i))
  ]
  resetCapture()
  await service.runCentralSyncOnce()
  const contractAcks = ackBodies.flatMap((b) => b.acknowledgements)
  ok('E4 只有 leadId / 空 contactNormalized / leadId 不一致的 assign 全部终态 invalid（不以空身份建档）',
    ['ev-lead-only', 'ev-lead-no-contact', 'ev-lead-id-mismatch']
      .every((id) => contractAcks.some((a) => a.eventId === id && a.outcome === 'invalid')),
    JSON.stringify(contractAcks))
  ok('E5 缺 sla1Deadline/mode 的 transfer 终态 invalid（SLA 不在接收端重算）',
    contractAcks.some((a) => a.eventId === 'ev-transfer-no-sla' && a.outcome === 'invalid'))
  ok('E6 被拒指令本机零业务写（不建 lead/assignment、不留 sync_apply 审计）',
    crmDbService.all("SELECT id FROM lead WHERE contact_normalized IN ('13900000101','13900000105')").length === 0 &&
    crmDbService.all('SELECT id FROM assignment WHERE lead_id IN (9102, 9103, 9104, 9105)').length === 0)
  ok('E7 被拒指令不消耗幂等标记（修正后重发同 key 仍可应用）',
    crmDbService.all("SELECT key FROM scan_state WHERE key LIKE 'syncApplied:central/ev-lead-%'").length === 0)
  // mode 非法的指令同样终态 invalid：不被 String(value) 变成一个「看起来合法」的枚举值
  const badgeModeIds = ['ev-mode-object', 'ev-mode-array', 'ev-mode-number', 'ev-mode-boolean', 'ev-mode-unknown', 'ev-mode-numeric-string']
  ok('E8 mode 非法形态（对象/数组/数字/布尔/未知串/数字串）在本机应用侧全部终态 invalid',
    badgeModeIds.every((id) => contractAcks.some((a) => a.eventId === id && a.outcome === 'invalid')),
    JSON.stringify(contractAcks.filter((a) => badgeModeIds.includes(String(a.eventId)))))
  ok('E9 mode 被拒的指令零业务写、零幂等标记（无效载荷进不了任何状态机）',
    crmDbService.all("SELECT id FROM lead WHERE contact_type = 'phone' AND contact_normalized LIKE '1390000020%'").length === 0 &&
    badgeModeIds.every((id) => crmDbService.all("SELECT key FROM scan_state WHERE key LIKE ?", [`syncApplied:central/${id}%`]).length === 0))

  console.log('═══ H. 上行指令链：员工目录解析（§三.5）═══')
  configureBinding()
  directoryEmployees = [
    { employeeId: 'emp-1', employeeCode: 'S001', displayName: '测试销售甲', role: 'sales', nameUnique: true },
    { employeeId: 'emp-2', employeeCode: 'S002', displayName: '重名销售', role: 'sales', nameUnique: false },
    { employeeId: 'emp-3', employeeCode: 'S003', displayName: '重名销售', role: 'sales', nameUnique: false },
    // 唯一主管：SLA1 三次超时的升级通知的落点（目录里角色权威，不按显示名猜人）
    { employeeId: 'emp-9', employeeCode: 'M001', displayName: '测试主管甲', role: 'supervisor', nameUnique: true }
  ]
  crmDbService.runTx((tx) => {
    for (const [seq, key, salesName] of [[11, 'assign:501', '测试销售甲'], [12, 'assign:777', '查无此人'], [13, 'assign:778', '重名销售']] as const) {
      tx.run('INSERT INTO outbox_event (event_seq, idempotency_key, payload, status, source, created_at) VALUES (?,?,?,?,?,?)',
        [seq, key, JSON.stringify({ type: 'assign', leadId: 501, assignmentId: 1, salesName, version: 1 }), 'pending', 'test', Date.now()])
    }
  })
  resetCapture()
  await service.runCentralSyncOnce()
  const commandBodies = captured.filter((c) => c.url.endsWith('/api/v1/sync/commands')).map((c) => c.body as CentralSyncEvent)
  ok('H1 唯一员工：assign 走中央指令链下发（不再伪装成上行投影）并结算 sent',
    commandBodies.length === 1 && String(commandBodies[0]!.targetEmployeeId) === 'emp-1' &&
    String(crmDbService.all("SELECT * FROM outbox_event WHERE idempotency_key='assign:501'")[0]?.status) === 'sent')
  ok('H2 指令按稳定 employeeId 投递，不按显示名猜人',
    commandBodies.every((e) => Boolean(e.targetEmployeeId)) &&
    !capturedText().includes('targetEmployeeId\":\"测试销售甲'))
  ok('H3 查无此人 / 同名的 outbox 行保持 pending，绝不猜一个人出来（§三.5）',
    commandBodies.length === 1 &&
    String(crmDbService.all("SELECT * FROM outbox_event WHERE idempotency_key='assign:777'")[0]?.status) === 'pending' &&
    String(crmDbService.all("SELECT * FROM outbox_event WHERE idempotency_key='assign:778'")[0]?.status) === 'pending')
  for (let i = 0; i < 5; i++) { resetCapture(); await service.runCentralSyncOnce() }
  ok('H4 有界重试到上限后转 failed + 审计，不无休止重试也不假装成功',
    String(crmDbService.all("SELECT * FROM outbox_event WHERE idempotency_key='assign:777'")[0]?.status) === 'failed' &&
    String(crmDbService.all("SELECT * FROM outbox_event WHERE idempotency_key='assign:778'")[0]?.status) === 'failed' &&
    crmDbService.all("SELECT * FROM audit_event WHERE action='sync_employee_unresolved'").length >= 1)

  // H5/H6 SLA1 升级通知必须有明确投递目标与落点（§三.6）：无主管时宁可 pending，也不静默丢弃
  crmDbService.runTx((tx) => {
    tx.run('INSERT INTO outbox_event (event_seq, idempotency_key, payload, status, source, created_at) VALUES (?,?,?,?,?,?)',
      [21, 'sla1Escalate:1', JSON.stringify({
        type: 'sla1_escalate_supervisor', leadId: 501, assignmentId: 1, salesName: '测试销售甲',
        remindCount: 3, reason: 'SLA三次超时回收', recycledAt: Date.now()
      }), 'pending', 'test', Date.now()])
  })
  resetCapture()
  await service.runCentralSyncOnce()
  const escalateBodies = captured.filter((c) => c.url.endsWith('/api/v1/sync/commands'))
    .map((c) => c.body as CentralSyncEvent).filter((e) => e.eventType === 'sla1_escalate_supervisor')
  ok('H5 SLA1 升级通知投给目录中唯一的主管（按角色解析，targetEmployeeId 是 stable id）并结算 sent',
    escalateBodies.length === 1 && String(escalateBodies[0]!.targetEmployeeId) === 'emp-9' &&
    String((escalateBodies[0]!.payload as Record<string, unknown>).deliveryRole) === 'notify' &&
    String(crmDbService.all("SELECT * FROM outbox_event WHERE idempotency_key='sla1Escalate:1'")[0]?.status) === 'sent')
  ok('H5b 通知正文只带掩码联系方式，不带联系原文',
    !capturedText().includes(PHONE) &&
    String((escalateBodies[0]!.payload as Record<string, unknown>).contactMasked || '').includes('****'))
  ConfigService.getInstance().set('centralSyncSupervisorCode', 'M999')
  crmDbService.runTx((tx) => {
    tx.run('INSERT INTO outbox_event (event_seq, idempotency_key, payload, status, source, created_at) VALUES (?,?,?,?,?,?)',
      [22, 'sla1Escalate:2', JSON.stringify({
        type: 'sla1_escalate_supervisor', leadId: 501, assignmentId: 1, salesName: '测试销售甲',
        remindCount: 3, reason: 'SLA三次超时回收', recycledAt: Date.now()
      }), 'pending', 'test', Date.now()])
  })
  resetCapture()
  await service.runCentralSyncOnce()
  const escalate2Row = crmDbService.all("SELECT id FROM outbox_event WHERE idempotency_key='sla1Escalate:2'")[0]
  ok('H6 配置的主管编号查无此人时保持 pending 并记一次投递尝试，绝不改投他人、也不假装成功',
    String(crmDbService.all("SELECT * FROM outbox_event WHERE idempotency_key='sla1Escalate:2'")[0]?.status) === 'pending' &&
    crmDbService.getScanState(`centralSync:outboxAttempt:${Number(escalate2Row?.id || 0)}`) > 0 &&
    !capturedText().includes('sla1Escalate:2'))
  ConfigService.getInstance().set('centralSyncSupervisorCode', '')

  console.log('═══ I. 版本化增量（§四）═══')
  /**
   * 本机修订号 = `updated_at * 1000 + min(version, 999)`，所以「改了一行」必须让 updated_at 真的变大；
   * 这里用一个略超当前时刻的递增刻度（而非真实时钟），既保证严格递增、也保证同毫秒两行仍同刻度。
   * 刻度超前于当前毫秒 => 该毫秒被水位保护规则钉住（`(ts, 0)`），下一拍会重扫这一毫秒（§四.3 防漏）。
   */
  const AHEAD_MS = 1_500
  let aheadStep = 0
  const aheadTs = (): number => Date.now() + AHEAD_MS + ++aheadStep
  const seenKeys = new Set<string>()
  const rememberKeys = (): void => { for (const e of pushedEvents()) seenKeys.add(e.idempotencyKey) }
  rememberKeys()

  // I1/I2 客户改名：可变表必须用 (updated_at, id) 复合水位——只按 id 游标会永远只上首版
  crmDbService.runTx((tx) => {
    tx.run('UPDATE customer SET name = ?, updated_at = ?, version = version + 1 WHERE id = 1', ['上行客户甲-改名', aheadTs()])
  })
  resetCapture()
  await service.runCentralSyncOnce()
  const renamed = pushedEvents().filter((e) => e.entityType === 'customer')
  ok('I1 客户改名后重新上行（可变表用 updated_at+id 复合水位，不是只按 id）',
    renamed.length === 1 && renamed[0]!.payload.displayName === '上行客户甲-改名')
  ok('I2 新版本：entityId 稳定、幂等键随版本变化、aggregateVersion 严格递增',
    renamed[0]!.entityId === customerEventV1.entityId &&
    renamed[0]!.idempotencyKey !== customerEventV1.idempotencyKey &&
    renamed[0]!.aggregateVersion > customerEventV1.aggregateVersion)

  rememberKeys()
  // I3 同毫秒两行：updated_at 完全相同，靠 id 次级序兜住，两行都必须上行
  crmDbService.runTx((tx) => { tx.run('UPDATE account SET customer_id = 1 WHERE id = 2') })
  const sameMs = aheadTs()
  crmDbService.runTx((tx) => {
    tx.run('UPDATE account SET owner_sales = ?, updated_at = ? WHERE id = 1', ['销售甲-改名', sameMs])
    tx.run('UPDATE account SET owner_sales = ?, updated_at = ? WHERE id = 2', ['销售乙-改名', sameMs])
  })
  resetCapture()
  await service.runCentralSyncOnce()
  ok('I3 同毫秒写入的两行都不漏（updated_at 相同、id 次级序兜住）',
    pushedEvents().filter((e) => e.entityType === 'ownership').length === 2)
  rememberKeys()

  // I4/I5 状态与金额变化都产生新版本
  const assignV1 = assignmentEventV1
  crmDbService.runTx((tx) => {
    tx.run("UPDATE assignment SET status = 'claimed', claimed_at = ?, updated_at = ?, version = version + 1 WHERE id = 1",
      [Date.now(), aheadTs()])
  })
  resetCapture()
  await service.runCentralSyncOnce()
  const assignV2 = pushedEvents().filter((e) => e.entityType === 'assignment')
  ok('I4 assignment 状态流转（assigned→claimed）产生新版本事件',
    assignV2.length >= 1 && assignV2.some((e) =>
      String(e.payload.status) === 'claimed' &&
      e.entityId === assignV1.entityId &&
      e.idempotencyKey !== assignV1.idempotencyKey &&
      e.aggregateVersion > assignV1.aggregateVersion))

  const oppTs = aheadTs()
  crmDbService.runTx((tx) => {
    tx.run("UPDATE opportunity SET stage = 'negotiating', amount = 20000, updated_at = ? WHERE id = 1", [oppTs])
  })
  resetCapture()
  await service.runCentralSyncOnce()
  const opps = pushedEvents().filter((e) => e.entityType === 'opportunity')
  ok('I5 商机阶段与金额变化产生新版本（不是只有首版能同步）',
    opps.length === 1 && String(opps[0]!.payload.stage) === 'negotiating' && Number(opps[0]!.payload.amountCny) === 20000)
  rememberKeys()

  // I6 无变化重跑：超前刻度那一毫秒会被水位保护规则重扫一次（§四.3），但**版本不变**——
  // 幂等键逐字相同，中央按幂等键判 duplicate，不会产生第二条业务事件（§四.4）
  resetCapture()
  await service.runCentralSyncOnce()
  const rerunKeys = pushedEvents().map((e) => e.idempotencyKey)
  ok('I6 无变化重跑不产生新版本：重扫事件的幂等键与版本完全不变，没有新信息出机',
    rerunKeys.every((k) => seenKeys.has(k)) &&
    crmDbService.getScanState('centralSync:cursor:opportunity') === 0)

  // I6b 该毫秒过去之后，水位必须推进，重投必须停止（钉住是「延迟一拍」而不是「永远重投」）
  await new Promise((resolve) => setTimeout(resolve, AHEAD_MS + 100))
  resetCapture()
  await service.runCentralSyncOnce()
  const oppCursorTs = crmDbService.getScanState('centralSync:cursor:opportunity:ts')
  // 收敛那一拍会把被钉住的毫秒完整重扫一次（这就是防漏的代价），但投出的仍是同一版本
  ok('I6b 被钉住的毫秒过去后水位推进到精确 (ts, id)，该毫秒最多只被重扫一次',
    oppCursorTs === oppTs && crmDbService.getScanState('centralSync:cursor:opportunity') === 1 &&
    pushedEvents().every((e) => seenKeys.has(e.idempotencyKey)))
  resetCapture()
  await service.runCentralSyncOnce()
  ok('I6c 水位推进后继续重跑仍零上行（真·无变化不重复投递）', pushedEvents().length === 0)

  // I7/I8 网络失败水位不前进；恢复后照常重放
  const tsBefore = crmDbService.getScanState('centralSync:cursor:customer:ts')
  crmDbService.runTx((tx) => {
    tx.run('UPDATE customer SET name = ?, updated_at = ? WHERE id = 1', ['上行客户甲-二次改名', aheadTs()])
  })
  pushMode = 'network_fail'
  const offlineRun = await service.runCentralSyncOnce()
  ok('I7 网络失败时水位不前进（不静默丢事件）',
    Boolean(offlineRun.error) && crmDbService.getScanState('centralSync:cursor:customer:ts') === tsBefore)
  pushMode = 'ok'
  resetCapture()
  await service.runCentralSyncOnce()
  const recovered = pushedEvents().filter((e) => e.entityType === 'customer')
  ok('I8 网络恢复后照常重放，事件不丢', recovered.length === 1 &&
    recovered[0]!.payload.displayName === '上行客户甲-二次改名' &&
    crmDbService.getScanState('centralSync:cursor:customer:ts') > tsBefore)

  console.log('═══ J. 跨表引用统一（§六）═══')
  crmDbService.runTx((tx) => { tx.run("DELETE FROM scan_state WHERE key LIKE 'centralSync:cursor:%'") })
  resetCapture()
  await service.runCentralSyncOnce()
  const full = pushedEvents()
  const customerRefs = new Set(full.filter((e) => e.entityType === 'customer').map((e) => e.entityId))
  const refOf = (type: string) => full.filter((e) => e.entityType === type)
    .map((e) => e.payload.customerRef).filter((v) => typeof v === 'string' && v !== '')
  ok('J1 customer_identity.customerRef 精确等于该客户的 entityId（可回连 central_customer）',
    customerRefs.size >= 1 && refOf('customer_identity').every((r) => customerRefs.has(r as string)))
  ok('J2 customer_judgment.customerRef 同样精确回连客户实体',
    refOf('customer_judgment').length >= 1 && refOf('customer_judgment').every((r) => customerRefs.has(r as string)))
  ok('J3 ownership / opportunity 的 customerRef 指向真实客户实体，不拿 account:<id> 冒充客户',
    [...refOf('ownership'), ...refOf('opportunity')].length >= 1 &&
    [...refOf('ownership'), ...refOf('opportunity')].every((r) => customerRefs.has(r as string)))
  ok('J4 任何载荷都不把 account: / 裸 lead: / contract: 当作客户引用',
    !/"(customerRef|ownerRef)"\s*:\s*"(account|lead|contract):/.test(capturedText()))
  ok('J5 两台设备本地 id 都是 1 时不会互相串客户（引用一律带设备命名空间前缀）',
    projectionMod.localRefOf('dev-a', 'customer:1') !== projectionMod.localRefOf('dev-b', 'customer:1') &&
    full.filter((e) => e.entityType === 'customer').every((e) => e.entityId.startsWith('dev-1/customer:')))
  ok('J6 每个上行 (entityType, entityId) 都通过中央引用形态校验（本地自检与服务端同一份规则）',
    full.every((e) => validateCentralEntityId(e.entityType, e.entityId) === null))
  // §四 实体引用「具体性」：有类别 ≠ 指向某一行。判定与上行 *Ref 闸门同源（isConcreteRef），
  // 不新造第三个解析器——同一份事实在两处各写一遍必然漂移。
  ok('J7 isConcreteRef 正例：设备命名空间 + 类别 + 非空白行号',
    isConcreteRef('dev-1/customer:1') && isConcreteRef('dev-1/assignment:42') &&
    isConcreteRef(`dev-1/customer:${'x'.repeat(64)}`) && isConcreteRef('dev-1/customer: 行号有空格也非空 '))
  ok('J8 isConcreteRef 反例：空行号 / 全空白行号 / 缺冒号 / 缺命名空间 / 缺类别 / 非字符串一律不具体',
    !isConcreteRef('dev-1/customer:') && !isConcreteRef('dev-1/customer:   ') && !isConcreteRef('dev-1/customer') &&
    !isConcreteRef('customer:1') && !isConcreteRef('dev-1/:1') && !isConcreteRef(':1') &&
    !isConcreteRef(123) && !isConcreteRef(null) && !isConcreteRef(undefined) && !isConcreteRef({}) && !isConcreteRef([]))
  ok('J9 validateCentralEntityId 正例：完整具体引用放行（既有合法 scoped ref 不受影响）',
    validateCentralEntityId('customer', 'dev-1/customer:1') === null &&
    validateCentralEntityId('assignment', 'dev-1/assignment:7') === null &&
    full.filter((e) => e.entityType === 'customer').every((e) => validateCentralEntityId(e.entityType, e.entityId) === null))
  ok('J10 validateCentralEntityId 反例：只有类别没有行号 → entity_id_not_concrete',
    validateCentralEntityId('customer', 'dev-1/customer:') === 'entity_id_not_concrete' &&
    validateCentralEntityId('customer', 'dev-1/customer:   ') === 'entity_id_not_concrete' &&
    validateCentralEntityId('assignment', 'dev-1/assignment:') === 'entity_id_not_concrete')
  ok('J11 validateCentralEntityId 反例：缺命名空间 / 类别不符 / 非字符串 → 各自稳定码',
    validateCentralEntityId('customer', 'customer:1') === 'entity_id_not_scoped' &&
    validateCentralEntityId('customer', 'dev-1/lead:1') === 'entity_id_kind_mismatch:lead≠customer' &&
    validateCentralEntityId('customer', 123 as unknown as string) === 'entity_id_not_scoped' &&
    validateCentralEntityId('teleport' as never, 'dev-1/customer:1') === 'invalid_entity_type')

  console.log('═══ K. 过滤行不阻塞游标（§五）═══')
  // 台账键 = centralSync:skip:<投影名>:<本地引用>，而本地引用本身已带 customer: 前缀
  const skipCount = (localRef: string): number =>
    crmDbService.all('SELECT key FROM scan_state WHERE key = ?', [`centralSync:skip:customer:${localRef}`]).length
  const skippedAudits = (): number =>
    crmDbService.all("SELECT id FROM audit_event WHERE action='sync_projection_skipped'").length
  const insertNamelessCustomer = (ts: number): number => {
    crmDbService.runTx((tx) => {
      tx.run('INSERT INTO customer (name, source, updated_at, version, deleted) VALUES (?,?,?,?,?)', ['', 'manual', ts, 1, 0])
    })
    return Number(crmDbService.all('SELECT MAX(id) AS id FROM customer')[0]?.id || 0)
  }

  // K1 一页里前面的行被跳过，后面的合法行必须照常上行（跳过不能拖住游标）
  const headSkipTs = aheadTs()
  const headSkipId = insertNamelessCustomer(headSkipTs)
  insertNamelessCustomer(headSkipTs + 1)
  const legitTs = aheadTs()
  crmDbService.runTx((tx) => {
    tx.run('INSERT INTO customer (name, source, updated_at, version, deleted) VALUES (?,?,?,?,?)', ['跳过行之后的合法客户', 'manual', legitTs, 1, 0])
  })
  resetCapture()
  await service.runCentralSyncOnce()
  const k1Events = pushedEvents().filter((e) => e.entityType === 'customer')
  ok('K1 被跳过的行不阻塞同页后续合法行（跳过照常推进水位）',
    k1Events.some((e) => e.payload.displayName === '跳过行之后的合法客户') &&
    k1Events.every((e) => String(e.payload.displayName).trim().length > 0) &&
    skipCount(`customer:${headSkipId}`) === 1)
  ok('K1b 跳过原因被记进待重试台账并留一次审计（不是静默丢弃）',
    skipCount(`customer:${headSkipId}`) === 1 &&
    crmDbService.all("SELECT id FROM audit_event WHERE action='sync_projection_skipped' AND entity_id = ?",
      [`customer:${headSkipId}`]).length === 1)

  // K2 页尾被跳过：本页最后几行不可投影，水位仍推进到页尾，且不重复留痕（§五.4）
  const tailSkipTs = aheadTs()
  insertNamelessCustomer(tailSkipTs)
  const tailLastId = insertNamelessCustomer(tailSkipTs + 1)
  resetCapture()
  await service.runCentralSyncOnce()
  const auditsAfterTail = skippedAudits()
  ok('K2 整页尾部被跳过时水位仍推进到页尾（游标不卡在跳过行上）',
    crmDbService.getScanState('centralSync:cursor:customer:ts') >= tailSkipTs &&
    skipCount(`customer:${tailLastId}`) === 1)
  rememberKeys()
  resetCapture()
  await service.runCentralSyncOnce()
  ok('K2b 重复重扫同一批跳过行不会每分钟重写审计（同一行只留一次痕）',
    skippedAudits() === auditsAfterTail)

  // K3 补齐后重新进入同步：既有台账必须能把该行捞回来，且同一版本只投一次（§五.3）
  const refillTs = aheadTs()
  crmDbService.runTx((tx) => {
    tx.run('UPDATE customer SET name = ?, updated_at = ?, version = version + 1 WHERE id = ?',
      ['补齐名称的客户', refillTs, headSkipId])
  })
  resetCapture()
  await service.runCentralSyncOnce()
  const refilled = pushedEvents().filter((e) => e.entityId === `dev-1/customer:${headSkipId}`)
  ok('K3 补齐后的行重新进入同步，且同一版本只投递一次（扫描与台账不重复投递）',
    refilled.length === 1 && refilled[0]!.payload.displayName === '补齐名称的客户' &&
    skipCount(`customer:${headSkipId}`) === 0)

  // K4 补齐后仍未变化的行保持安静：不产生新版本、不重复留痕
  const auditsAfterRefill = skippedAudits()
  const refillKeys = new Set(pushedEvents().map((e) => e.idempotencyKey))
  resetCapture()
  await service.runCentralSyncOnce()
  ok('K4 稳态重跑不产生新版本（重扫幂等键逐字相同），也不重复写跳过审计',
    pushedEvents().every((e) => refillKeys.has(e.idempotencyKey)) && skippedAudits() === auditsAfterRefill)
  await new Promise((resolve) => setTimeout(resolve, AHEAD_MS + 100))
  await service.runCentralSyncOnce()
  resetCapture()
  await service.runCentralSyncOnce()
  ok('K4b 补齐态收敛后零上行、零新增跳过留痕',
    pushedEvents().length === 0 && skippedAudits() === auditsAfterRefill)

  // K5 永久契约拒收是终态：水位推进 + 留审计；网络失败是临时的：水位一律不动（§五.5）
  const permTs = aheadTs()
  crmDbService.runTx((tx) => {
    tx.run('UPDATE customer SET name = ?, updated_at = ? WHERE id = 1', ['被中央契约拒收的改名', permTs])
  })
  pushMode = 'reject_all'
  resetCapture()
  const rejectedOnce = await service.runCentralSyncOnce()
  ok('K5 契约性拒收是终态：不无限重试、水位照常推进并留审计',
    rejectedOnce.rejected >= 1 &&
    crmDbService.getScanState('centralSync:cursor:customer:ts') >= permTs &&
    crmDbService.all("SELECT id FROM audit_event WHERE action='sync_push_rejected'").length >= 1)
  pushMode = 'ok'
  const frozenTs = crmDbService.getScanState('centralSync:cursor:customer:ts')
  crmDbService.runTx((tx) => {
    tx.run('UPDATE customer SET name = ?, updated_at = ? WHERE id = 1', ['网络失败期间的改名', aheadTs()])
  })
  pushMode = 'network_fail'
  await service.runCentralSyncOnce()
  ok('K5b 网络失败是临时失败：水位一动不动，恢复后重放',
    crmDbService.getScanState('centralSync:cursor:customer:ts') === frozenTs)
  pushMode = 'ok'
  resetCapture()
  await service.runCentralSyncOnce()
  ok('K5c 恢复后该改名照常送达（水位没跳过它）',
    pushedEvents().some((e) => e.payload.displayName === '网络失败期间的改名'))

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
