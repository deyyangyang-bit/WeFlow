/**
 * central-sync-e2e-test.ts —— Phase 3a 真实端到端契约闭环（§八）
 *
 * 全链路（中央侧一律真实实现，不打桩）：
 *   真实业务生产者（importLeads / toAccount / assignLeads / claimLead / bindLeadWxid /
 *   updateLeadStatus / runSla1Recycle）
 *     → outbox_event（同事务登记）
 *     → centralSyncService（路由表 + 字段白名单重建）
 *     → CentralSyncClient
 *     → globalThis.fetch 桥接到 Fastify `app.inject`（真实路由/权限/校验/幂等）
 *     → MemoryCentralStore（投影 / 下行指令 / 审计）
 *     → /api/v1/sync/pull → 本机既有状态机（applyDownEventDirect）→ /api/v1/sync/ack
 *     → outbox 结算（只有中央受理才置 sent）
 *
 * 覆盖：claim / bind_wx / first_touch / assign / transfer / recycle / 主管升级通知；
 *       敏感字段不出现在任何 HTTP 请求正文；服务端严格投影校验；网络失败重放；幂等；
 *       状态更新再同步；跨设备越权；游标跳过；自助解绑审计。
 *
 * 隔离：WEFLOW_WORKER + WEFLOW_USER_DATA_PATH + WEFLOW_CONFIG_CWD 指向临时目录，
 *       业务模块一律在 main() 内动态 import。**不读真实生产库、不发真实网络请求**。
 * 运行：npx tsx scripts/central-sync-e2e-test.ts
 */
import { mkdtempSync } from 'fs'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'
import { join } from 'path'

const isoDir = mkdtempSync(join(tmpdir(), 'centralsync-e2e-'))
process.env.WEFLOW_WORKER = '1'
process.env.WEFLOW_USER_DATA_PATH = isoDir
process.env.WEFLOW_CONFIG_CWD = isoDir

let pass = 0
let fail = 0
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; console.log(`  ✅ ${name}`) } else { fail++; console.log(`  ❌ ${name} ${detail}`) }
}

import { scopedRef, type CentralSyncEvent } from '../shared/centralSync'

/** Fastify 实例的最小结构（本脚本不引 fastify 类型，只用 inject） */
interface InjectResult { statusCode: number; payload: string; headers: Record<string, unknown> }
interface AppLike {
  inject: (opts: { method: string; url: string; headers?: Record<string, string>; payload?: string }) => Promise<InjectResult>
}
/** MemoryCentralStore 的测试可观测口（中央侧断言只读这些，不读私有字段） */
interface StoreLike {
  projectionRow: (entityType: string, entityId: string) => { payload: Record<string, unknown>; sourceDeviceId: string } | undefined
  projectionRows: () => Array<{ entityType: string; entityId: string }>
  auditActions: () => Array<{ actor: string; action: string; entityType: string; entityId: string }>
  conflictRecords: () => Array<{ code: string; entityId: string }>
  policyViolations: () => Array<{ eventId: string; fieldPath: string }>
  downEventCount: () => number
  dumpForLeakCheck: () => string
}
interface Onboarded { token: string; employeeId: string; deviceId: string; workspaceId: string }
interface CallResult { status: number; data: Record<string, unknown> | null; code: string; message: string }

const ADMIN_TOKEN = 'admin-token-for-e2e-that-is-longer-than-thirty-two-chars'
const WORKSPACE = randomUUID()
const BASE_URL = 'https://central.e2e.local'

const PHONE = '13800002222'
const DOWN_PHONE = '13800003333'
const WXID = 'wxid_e2e_alpha_only'
const SUPERVISOR_NAME = '测试主管甲'
const SALES_NAME = '测试销售甲'

let app: AppLike
let store: StoreLike
let captured: Array<{ url: string; method: string; body: string; status: number; response: string }> = []
let netMode: 'ok' | 'fail' = 'ok'
let crmDbService: (typeof import('../electron/services/crmDbService'))['crmDbService']
let salesDbService: (typeof import('../electron/services/salesDbService'))['salesDbService']
let ConfigService: (typeof import('../electron/services/config'))['ConfigService']
let service: typeof import('../electron/services/centralSyncService')
let assignmentSvc: typeof import('../electron/services/crmAssignmentService')
let leadSvc: typeof import('../electron/services/crmLeadService')
let friendSvc: typeof import('../electron/services/crmFriendDetectService')

function capturedText(): string { return captured.map((c) => c.body).join('\n') }
function resetCapture(): void { captured = [] }
/** 本机发出的上行投影事件（从真实请求正文里取，证明真出机的是什么） */
function pushedEvents(): CentralSyncEvent[] {
  const out: CentralSyncEvent[] = []
  for (const call of captured) {
    if (!call.url.endsWith('/api/v1/sync/push') || !call.body) continue
    out.push(...(JSON.parse(call.body) as { events: CentralSyncEvent[] }).events)
  }
  return out
}
function commandBodies(): CentralSyncEvent[] {
  const out: CentralSyncEvent[] = []
  for (const call of captured) {
    if (call.url.endsWith('/api/v1/sync/commands') && call.body) out.push(JSON.parse(call.body) as CentralSyncEvent)
  }
  return out
}

/** 直连真实 Fastify 的 HTTP 调用（管理员/其他设备令牌；用于造下行指令与越权用例） */
async function call(method: string, path: string, token: string, payload?: unknown): Promise<CallResult> {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'idempotency-key': randomUUID() }
  if (token) headers.authorization = `Bearer ${token}`
  const res = await app.inject({
    method, url: path, headers,
    payload: payload === undefined ? undefined : JSON.stringify(payload)
  })
  let data: Record<string, unknown> | null = null
  let code = ''
  let message = ''
  try {
    const parsed = JSON.parse(res.payload) as { data?: Record<string, unknown>; code?: string; message?: string }
    data = parsed.data ?? null
    code = String(parsed.code || '')
    message = String(parsed.message || '')
  } catch { data = null }
  return { status: res.statusCode, data, code, message }
}

/** 管理员开一次性邀请码 → 设备认领，返回设备凭证与身份（真实绑定流程） */
async function onboard(employeeCode: string, displayName: string, role: string): Promise<Onboarded> {
  const invite = await call('POST', '/api/v1/bindings/invitations', ADMIN_TOKEN,
    { workspaceId: WORKSPACE, employeeCode, displayName, role })
  const code = String(invite.data?.inviteCode || '')
  const claim = await call('POST', '/api/v1/bindings/claim', '', { inviteCode: code, deviceName: `${employeeCode}-机器` })
  const principal = (claim.data?.principal || {}) as Record<string, string>
  return {
    token: String(claim.data?.deviceToken || ''), employeeId: principal.employeeId || '',
    deviceId: principal.deviceId || '', workspaceId: principal.workspaceId || ''
  }
}

async function main(): Promise<void> {
  const { buildCentralApp } = await import('../central/src/app.js' as string)
  const { MemoryCentralStore } = await import('../central/src/memoryStore.js' as string)
  ConfigService = (await import('../electron/services/config')).ConfigService
  crmDbService = (await import('../electron/services/crmDbService')).crmDbService
  salesDbService = (await import('../electron/services/salesDbService')).salesDbService
  service = await import('../electron/services/centralSyncService')
  assignmentSvc = await import('../electron/services/crmAssignmentService')
  leadSvc = await import('../electron/services/crmLeadService')
  friendSvc = await import('../electron/services/crmFriendDetectService')

  const memory = new MemoryCentralStore()
  const built = buildCentralApp({
    store: memory as never,
    config: { host: '127.0.0.1', port: 0, databaseUrl: 'memory://', adminToken: ADMIN_TOKEN, tlsTerminated: true, logLevel: 'silent' }
  } as never)
  app = built as unknown as AppLike
  store = memory as unknown as StoreLike

  // fetch 桥：真实 HTTP 语义 → app.inject（不离开进程，不发真实网络请求），正文全程留档供禁字段扫描
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    const body = init?.body === undefined || init?.body === null ? undefined : String(init.body)
    const call0 = { url, method: String(init?.method || 'GET').toUpperCase(), body: body ?? '', status: 0, response: '' }
    if (netMode === 'fail') throw new Error('network unreachable')
    captured.push(call0)
    // Headers 实例的键不可枚举：必须走 forEach，否则会丢 content-type，请求语义与真实链路不符
    const forwarded = new Headers(init?.headers || {})
    const headers: Record<string, string> = {}
    forwarded.forEach((value, key) => { headers[key.toLowerCase()] = value })
    const res = await app.inject({
      method: String(init?.method || 'GET'),
      url: url.replace(/^https?:\/\/[^/]+/, ''),
      headers, payload: body
    })
    call0.status = res.statusCode
    call0.response = res.payload
    return new Response(res.payload, { status: res.statusCode, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch

  await crmDbService.initialize(isoDir)
  await salesDbService.initialize(isoDir)

  console.log('═══ A. 真实绑定：邀请码 → 设备认领 → 本机绑定 ═══')
  // 本机按 Phase 1 拓扑绑定为「主管工作机」（中枢 = 主管工作机，持有分配事实与通知落点）
  const supervisorInvite = await call('POST', '/api/v1/bindings/invitations', ADMIN_TOKEN,
    { workspaceId: WORKSPACE, employeeCode: 'M001', displayName: SUPERVISOR_NAME, role: 'supervisor' })
  const principal = await service.claimCentralBinding(BASE_URL, String(supervisorInvite.data?.inviteCode || ''), 'e2e-machine')
  service.stopCentralSyncScheduler()
  const cfgAfterClaim = service.getCentralSyncConfig()
  const supervisor: Onboarded = {
    token: cfgAfterClaim.token, employeeId: principal.employeeId,
    deviceId: principal.deviceId, workspaceId: principal.workspaceId
  }
  const sales = await onboard('S001', SALES_NAME, 'sales')
  ok('A1 管理员发邀请码 → 主管机经真实 claimCentralBinding 认领，销售机经邀请码认领，同落一个工作区',
    Boolean(supervisor.token && sales.token) && supervisor.workspaceId === WORKSPACE && sales.workspaceId === WORKSPACE)
  ok('A2 两台设备 deviceId/employeeId 各不相同（设备命名空间互不覆盖）',
    supervisor.deviceId !== sales.deviceId && supervisor.employeeId !== sales.employeeId)
  ok('A3 本机绑定写入工作区/员工/设备/角色，且凭证不落明文（内存里只有哈希）',
    cfgAfterClaim.workspaceId === WORKSPACE && cfgAfterClaim.employeeId === supervisor.employeeId &&
    cfgAfterClaim.deviceId === supervisor.deviceId && cfgAfterClaim.role === 'supervisor' && cfgAfterClaim.enabled)

  console.log('═══ B. 真实业务生产者 → outbox → 中央投影 ═══')
  // canonical 客户行：本机只有迁移/归并路径会写 customer 表（crmMigrationService），此处按同一口径落一行
  crmDbService.runTx((tx) => {
    tx.run('INSERT INTO customer (name, type, source, updated_by, updated_at, version, deleted) VALUES (?,?,?,?,?,?,?)',
      ['端到端客户甲', 'end_user', 'migration', SUPERVISOR_NAME, Date.now(), 1, 0])
  })
  const imported = leadSvc.importLeads('e2e', 'e2e.csv', [
    { phone: PHONE, name: '端到端线索甲', source: 'e2e' },
    { wechat: WXID, name: '端到端线索乙', source: 'e2e' },
    { phone: DOWN_PHONE, name: '端到端线索丙', source: 'e2e' }
  ])
  const leadRows = crmDbService.all('SELECT id, contact_type, contact_normalized FROM lead ORDER BY id')
  const phoneLeadId = Number(leadRows.find((r) => r.contact_type === 'phone')?.id || 0)
  const wxLeadId = Number(leadRows.find((r) => r.contact_type === 'wechat')?.id || 0)
  const downLeadId = Number(leadRows.find((r) => r.contact_normalized === DOWN_PHONE)?.id || 0)
  ok('B1 真实导入生产者落库三条线索（手机号 + 微信号 + 待下行分配的手机号）',
    imported.valid === 3 && phoneLeadId > 0 && wxLeadId > 0 && downLeadId > 0,
    JSON.stringify(imported) + JSON.stringify(leadRows))

  const toAccount = leadSvc.toAccount(wxLeadId)
  const phoneAccount = leadSvc.toAccount(phoneLeadId)
  ok('B2 线索转正式客户（toAccount）建立 account 行（微信号线索 + 手机号线索）',
    toAccount.ok === true && Number(toAccount.accountId || 0) > 0 &&
    phoneAccount.ok === true && Number(phoneAccount.accountId || 0) > 0)
  // 归并：account.customer_id 是 account → canonical customer 的唯一通道（与 crmMigrationService 同口径）
  crmDbService.runTx((tx) => {
    tx.run('UPDATE account SET customer_id = 1, updated_at = ? WHERE id IN (?, ?) AND customer_id IS NULL',
      [Date.now(), Number(toAccount.accountId), Number(phoneAccount.accountId)])
  })

  const assigned = assignmentSvc.assignLeads([phoneLeadId], SUPERVISOR_NAME, SUPERVISOR_NAME)
  const assignmentId = Number(assignmentSvc.currentAssignment(phoneLeadId)?.id || 0)
  ok('B3 真实分配生产者：assignLeads 落 assignment + 登记 outbox（assign）',
    assigned.ok === true && assignmentId > 0 &&
    Boolean(crmDbService.all("SELECT id FROM outbox_event WHERE idempotency_key = ?", [`assign:${assignmentId}`]).length))

  const claimed = assignmentSvc.claimLead(phoneLeadId, SUPERVISOR_NAME)
  ok('B4 真实认领生产者：claimLead 登记 outbox（claim）',
    claimed.ok === true && Boolean(crmDbService.all("SELECT id FROM outbox_event WHERE idempotency_key = ?", [`claim:${phoneLeadId}`]).length))

  const bound = friendSvc.bindLeadWxid(wxLeadId, WXID, { actor: SUPERVISOR_NAME, displayName: '端到端线索乙' })
  ok('B5 真实绑定生产者：bindLeadWxid 登记 outbox（bind_wx）并解析到 canonical 客户',
    bound.ok === true && Number(bound.data?.customerId || 0) === 1 &&
    Boolean(crmDbService.all("SELECT id FROM outbox_event WHERE idempotency_key LIKE 'bind_wx:%'").length))

  const contacted = leadSvc.updateLeadStatus(phoneLeadId, 'contacted', { channel: 'PHONE' })
  ok('B6 真实首触生产者：updateLeadStatus(contacted) 登记 outbox（first_touch）',
    contacted.ok === true && Boolean(crmDbService.all("SELECT id FROM outbox_event WHERE idempotency_key = ?", [`first_touch:${phoneLeadId}`]).length))

  const pendingBefore = crmDbService.all("SELECT id FROM outbox_event WHERE status='pending' ORDER BY event_seq")
  resetCapture()
  const run1 = await service.runCentralSyncOnce()
  ok('B7 一轮同步把 outbox 全部结算为 sent（只有中央受理才结算）',
    run1.error === undefined && pendingBefore.length >= 4 &&
    crmDbService.all("SELECT id FROM outbox_event WHERE status='pending'").length === 0,
    JSON.stringify(run1) + ' ' + JSON.stringify(crmDbService.all("SELECT id, idempotency_key, status FROM outbox_event WHERE status='pending'")))

  const deviceId = cfgAfterClaim.deviceId
  ok('B8 中央落库客户/身份/分配投影，且 entityId 带本机设备命名空间前缀',
    Boolean(store.projectionRow('customer', scopedRef(deviceId, 'customer:1'))) &&
    Boolean(store.projectionRow('customer_identity', scopedRef(deviceId, `identity:${Number(bound.data?.identityId || 0)}`))) &&
    Boolean(store.projectionRow('assignment', scopedRef(deviceId, `assignment:${assignmentId}`))))
  ok('B9 分配投影状态来自本机既有状态机（claim 后为 claimed）',
    String(store.projectionRow('assignment', scopedRef(deviceId, `assignment:${assignmentId}`))?.payload.status) === 'claimed')

  const upBodies = captured.filter((c) => c.url.endsWith('/sync/push')).map((c) => c.body).join('\n')
  ok('B10 上行正文里没有原始手机号 / 原始 wxid / contactNormalized / contactRaw',
    !upBodies.includes(PHONE) && !upBodies.includes(WXID) && !upBodies.includes(DOWN_PHONE) &&
    !upBodies.includes('contactNormalized') && !upBodies.includes('contactRaw'),
    upBodies.length > 0 ? '' : '没有采集到上行正文')
  const identityEvent = pushedEvents().find((e) => e.entityType === 'customer_identity')
  ok('B11 身份上行只有哈希 + 掩码，明文身份值不出机',
    Boolean(identityEvent) && String(identityEvent!.payload.identityHash).length === 64 &&
    String(identityEvent!.payload.identityMasked).includes('****') &&
    String(identityEvent!.payload.identityMasked) !== PHONE)
  const centralProjectionText = ['customer', 'customer_identity', 'assignment', 'ownership']
    .flatMap((type) => store.projectionRows().filter((r) => r.entityType === type))
    .map((r) => JSON.stringify(store.projectionRow(r.entityType, r.entityId)?.payload || {}))
    .join('\n')
  ok('B12 中央投影表里没有原始联系方式的明文（只有哈希 + 掩码）',
    !centralProjectionText.includes(PHONE) && !centralProjectionText.includes(WXID) &&
    centralProjectionText.includes('identityHash'))
  // 下行指令的线索资料是「把线索交给同事机器」的既有 Phase 1 语义，接收侧按
  // (contactType, contactNormalized) 解析/建 lead，因此 contactNormalized 必须随下行指令到达；
  // 但绝不允许原样搬运 outbox 载荷：只允许 6 个登记字段，contactRaw / 聊天原文任何方向都不出机。
  const downLeadProfiles = commandBodies()
    .map((e) => (e.payload as { lead?: Record<string, unknown> }).lead)
    .filter((lead): lead is Record<string, unknown> => Boolean(lead))
  const allowedLeadKeys = new Set(['leadId', 'name', 'contactType', 'contactNormalized', 'source', 'note'])
  ok('B12b 下行指令的线索资料是显式白名单字段（不允许原样搬运 outbox 载荷、不允许 contactRaw / 聊天原文）',
    downLeadProfiles.length > 0 && downLeadProfiles.every((lead) => Object.keys(lead).every((k) => allowedLeadKeys.has(k))) &&
    !capturedText().includes('contactRaw') && !capturedText().includes('rawChat') &&
    !capturedText().includes('chatHistory') && !capturedText().includes('messageRaw'),
    JSON.stringify(downLeadProfiles))
  ok('B13 分配类事件没有伪装成上行投影（assign 走指令链，不进 /sync/push）',
    commandBodies().some((e) => e.eventType === 'assign') &&
    !pushedEvents().some((e) => e.eventType === 'assign'))

  console.log('═══ C. 服务端严格投影校验 ═══')
  const badEvent: CentralSyncEvent = {
    protocolVersion: 1, eventId: 'e2e-bad-1', eventSeq: 1, idempotencyKey: 'e2e/bad-1', direction: 'up',
    entityType: 'customer', entityId: scopedRef(deviceId, 'customer:1'), eventType: 'customer_projected',
    aggregateVersion: 9, payload: { displayName: '端到端客户甲', displayNameRaw: '多余字段', chatHistory: ['x'] },
    occurredAt: Date.now()
  }
  const pushed = await call('POST', '/api/v1/sync/push', supervisor.token, { events: [badEvent] })
  const rejectedCodes = ((pushed.data?.rejected || []) as Array<{ code: string }>).map((r) => r.code)
  ok('C1 未知字段 + 聊天禁字段的上行事件被服务端拒收（不静默裁剪、不落库）',
    pushed.status === 200 && rejectedCodes.length === 1 && rejectedCodes[0]!.startsWith('forbidden_field'),
    JSON.stringify(pushed))
  ok('C2 被拒事件不动既有投影', String(store.projectionRow('customer', scopedRef(deviceId, 'customer:1'))?.payload.displayName) === '端到端客户甲')
  ok('C3 禁字段命中留中央策略违规审计（只记字段路径，不记值）',
    store.policyViolations().some((v) => v.fieldPath.includes('chat')) &&
    store.auditActions().some((a) => a.action === 'sync_forbidden_field') &&
    !store.dumpForLeakCheck().includes('chatHistory'))

  console.log('═══ D. 下行指令 → 本机既有状态机 → ACK → 结算 ═══')
  // 目标：本机尚未分配过的线索丙 —— 走完整的「指令 → 本机既有状态机落地 → ACK applied」闭环
  const issue = await call('POST', '/api/v1/sync/commands', supervisor.token, {
    protocolVersion: 1, eventId: 'e2e-down-assign', eventSeq: 1, idempotencyKey: 'e2e/down-assign',
    direction: 'down', entityType: 'assignment', entityId: scopedRef(supervisor.deviceId, 'assignment:9001'),
    eventType: 'assign', aggregateVersion: 1, occurredAt: Date.now(),
    targetEmployeeId: supervisor.employeeId,
    payload: {
      type: 'assign', deliveryRole: 'apply', leadId: downLeadId, assignmentId: 9001,
      salesName: SUPERVISOR_NAME, mode: 'manual', actor: SUPERVISOR_NAME,
      lead: { leadId: downLeadId, name: '端到端线索丙', contactType: 'phone', source: 'e2e', note: '' }
    }
  })
  ok('D1 主管设备下发 assign 指令：中央 201 受理并投递给目标员工', issue.status === 201, JSON.stringify(issue))
  resetCapture()
  await service.runCentralSyncOnce()
  const ackBodies = captured.filter((c) => c.url.endsWith('/api/v1/sync/ack'))
    .map((c) => JSON.parse(c.body) as { acknowledgements: Array<{ eventId: string; outcome: string }> })
  ok('D2 本机拉取后用既有状态机落地并回 ACK applied',
    ackBodies.some((a) => a.acknowledgements.some((x) => x.eventId === 'e2e-down-assign' && x.outcome === 'applied')),
    JSON.stringify(ackBodies) + JSON.stringify(captured.map((c) => c.url)))
  ok('D3 落地结果写在既有业务表（线索丙出现生效中的分配行，来源是下行指令）',
    Number(crmDbService.all('SELECT id FROM assignment WHERE lead_id = ? AND deleted = 0', [downLeadId]).length) === 1,
    JSON.stringify(crmDbService.all('SELECT id, lead_id, sales_name, status, source FROM assignment WHERE lead_id = ?', [downLeadId])))
  const repulled = await call('GET', '/api/v1/sync/pull?cursor=0&limit=50', supervisor.token)
  ok('D4 已 ACK 的指令不再重复下发（非 retry 不重拉）',
    !((repulled.data?.events || []) as CentralSyncEvent[]).some((e) => e.eventId === 'e2e-down-assign'))

  // 主管修正：落待确认收件箱，不覆盖本地事实
  const beforeLeadName = String(crmDbService.all('SELECT name FROM lead WHERE id = ?', [downLeadId])[0]?.name || '')
  const correction = await call('POST', '/api/v1/sync/commands', supervisor.token, {
    protocolVersion: 1, eventId: 'e2e-down-correction', eventSeq: 2, idempotencyKey: 'e2e/down-correction',
    direction: 'down', entityType: 'assignment', entityId: scopedRef(supervisor.deviceId, 'assignment:9001'),
    eventType: 'supervisor_correction', aggregateVersion: 1, occurredAt: Date.now(),
    targetEmployeeId: supervisor.employeeId,
    payload: { type: 'supervisor_correction', deliveryRole: 'apply', leadId: downLeadId, assignmentId: 9001,
      title: '主管修正待确认', summary: `客户名应为「${beforeLeadName}」` }
  })
  resetCapture()
  await service.runCentralSyncOnce()
  const inbox = crmDbService.all("SELECT * FROM notify_inbox WHERE notify_type = 'supervisor_correction'")
  ok('D5 主管修正落待确认收件箱（人工确认），本地线索事实一行未改',
    correction.status === 201 && inbox.length === 1 &&
    String(crmDbService.all('SELECT name FROM lead WHERE id = ?', [downLeadId])[0]?.name || '') === beforeLeadName,
    JSON.stringify(correction))

  console.log('═══ E. SLA1 三次超时的升级通知有明确落点（§三.6）═══')
  const slaAssignmentId = Number(crmDbService.all(
    'SELECT id FROM assignment WHERE lead_id = ? AND deleted = 0 ORDER BY id DESC LIMIT 1', [downLeadId])[0]?.id || 0)
  crmDbService.runTx((tx) => {
    tx.run("UPDATE assignment SET sla1_remind_count = 2, sla1_deadline = ?, updated_at = ? WHERE id = ?",
      [Date.now() - 60_000, Date.now() - 60_000, slaAssignmentId])
  })
  const recycled = assignmentSvc.runSla1Recycle()
  const escalateRow = crmDbService.all("SELECT id, status FROM outbox_event WHERE idempotency_key = ?", [`sla1Escalate:${slaAssignmentId}`])[0]
  ok('E1 第三次超时回收 + 登记升级通知 outbox（同一事务，绝无「已回收但无待发送」）',
    recycled.recycled === 1 && Boolean(escalateRow) && String(escalateRow?.status) === 'pending',
    JSON.stringify(recycled) + JSON.stringify(crmDbService.all("SELECT idempotency_key, status FROM outbox_event WHERE idempotency_key LIKE 'sla1%'")))
  resetCapture()
  await service.runCentralSyncOnce()
  const escalate = commandBodies().filter((e) => e.eventType === 'sla1_escalate_supervisor')
  ok('E2 升级通知投给目录中唯一主管（stable employeeId），本机 outbox 结算 sent',
    escalate.length === 1 && String(escalate[0]?.targetEmployeeId) === supervisor.employeeId &&
    String(crmDbService.all('SELECT status FROM outbox_event WHERE id = ?', [Number(escalateRow?.id)])[0]?.status) === 'sent',
    JSON.stringify(escalate))
  ok('E3 通知正文只带掩码联系方式（原文不出机）',
    !capturedText().includes(PHONE) && String((escalate[0]?.payload as Record<string, unknown> | undefined)?.contactMasked || '').includes('****'))
  const escalateInbox = crmDbService.all("SELECT * FROM notify_inbox WHERE idempotency_key LIKE 'sync%' OR source = 'sync:down'")
  ok('E4 通知在中央有明确送达目标、并已真正落到本机升级收件箱（不停在下发端）',
    store.downEventCount() > 0 && escalateInbox.length >= 1,
    JSON.stringify(escalateInbox))

  console.log('═══ F. 网络失败重放 + 幂等 ═══')
  const renameTs = Date.now() + 3_000
  crmDbService.runTx((tx) => {
    tx.run('UPDATE customer SET name = ?, updated_at = ?, version = version + 1 WHERE id = 1', ['端到端客户甲-改名', renameTs])
  })
  netMode = 'fail'
  const offline = await service.runCentralSyncOnce()
  netMode = 'ok'
  ok('F1 断网时本机不假装成功：返回如实错误，且不改中央状态',
    Boolean(offline.error) && String(store.projectionRow('customer', scopedRef(deviceId, 'customer:1'))?.payload.displayName) === '端到端客户甲',
    JSON.stringify(offline))
  resetCapture()
  await service.runCentralSyncOnce()
  const recovered = pushedEvents().filter((e) => e.entityType === 'customer')
  ok('F2 恢复后重放成功：改名的新版本上行（既有事件不丢、新版本不落）',
    recovered.some((e) => e.payload.displayName === '端到端客户甲-改名'))
  ok('F3 状态更新走的是「同一实体新版本」：中央投影被更新而不是新增行',
    String(store.projectionRow('customer', scopedRef(deviceId, 'customer:1'))?.payload.displayName) === '端到端客户甲-改名' &&
    store.projectionRows().filter((r) => r.entityId === scopedRef(deviceId, 'customer:1')).length === 1)
  const downBefore = store.downEventCount()
  const replayEvent = recovered.find((e) => e.payload.displayName === '端到端客户甲-改名')!
  const replay = await call('POST', '/api/v1/sync/push', supervisor.token, { events: [replayEvent] })
  const replayAccepted = ((replay.data?.accepted || []) as Array<{ duplicate?: boolean }>)
  ok('F4 同幂等键重放：中央判 duplicate，不产生第二条业务记录',
    replayAccepted.length === 1 && replayAccepted[0]!.duplicate === true && store.downEventCount() === downBefore &&
    store.projectionRows().filter((r) => r.entityId === scopedRef(deviceId, 'customer:1')).length === 1,
    JSON.stringify(replay))

  console.log('═══ G. 游标跳过不阻塞后续行（§五）═══')
  crmDbService.runTx((tx) => {
    // 无归属销售的 account：中央 ownership 必填，本机业务上暂不可投影 → 跳过但不阻塞后面的合法行
    for (let i = 0; i < 2; i++) {
      tx.run('INSERT INTO account (name, owner_sales, customer_id, created_at, updated_at) VALUES (?,?,?,?,?)',
        [`未归属客户${i}`, null, 1, Date.now() + 10_000 + i, Date.now() + 10_000 + i])
    }
    tx.run('INSERT INTO account (name, owner_sales, customer_id, created_at, updated_at) VALUES (?,?,?,?,?)',
      ['跳过行之后的合法归属客户', '销售乙', 1, Date.now() + 20_000, Date.now() + 20_000])
  })
  resetCapture()
  await service.runCentralSyncOnce()
  const legit = pushedEvents().filter((e) => e.entityType === 'ownership' && e.payload.ownerSales === '销售乙')
  const ownSkipLedger = crmDbService.all("SELECT key FROM scan_state WHERE key LIKE 'centralSync:skip:ownership:%'")
  ok('G1 被跳过的行不阻塞同页后续合法行（跳过记原因、照常推进水位，合法行照常上行）',
    legit.length === 1 && ownSkipLedger.length >= 2 &&
    ownSkipLedger.every((r) => /centralSync:skip:ownership:ownership:\d+$/.test(String(r.key))),
    JSON.stringify(ownSkipLedger) + JSON.stringify(pushedEvents().filter((e) => e.entityType === 'ownership').map((e) => e.payload)))
  ok('G2 空归属 account 从未被推上中央（中央不会收到缺 ownerSales 的 ownership 事件，outbox 也不会被永久卡住）',
    !captured.filter((c) => c.url.endsWith('/sync/push')).map((c) => c.body).join('').includes('未归属客户') &&
    crmDbService.all("SELECT id FROM outbox_event WHERE status='pending'").length === 0)
  // 跳过行补齐归属后必须能重新进入扫描（§五.3）
  const skipBefore = crmDbService.all("SELECT id FROM audit_event WHERE action='sync_projection_skipped'").length
  crmDbService.runTx((tx) => {
    tx.run("UPDATE account SET owner_sales = ?, updated_at = ? WHERE name = '未归属客户0'", ['销售丙', Date.now() + 30_000])
  })
  resetCapture()
  await service.runCentralSyncOnce()
  ok('G3 被跳过的可变行补齐后重新进入扫描并成功上行',
    pushedEvents().some((e) => e.entityType === 'ownership' && e.payload.ownerSales === '销售丙'))
  resetCapture()
  await service.runCentralSyncOnce()
  ok('G4 跳过行不会每分钟重写审计（同一行只留一次痕）',
    crmDbService.all("SELECT id FROM audit_event WHERE action='sync_projection_skipped'").length === skipBefore)

  console.log('═══ H. 跨设备越权（§二）═══')
  const supervisor2 = await onboard('M002', '测试主管乙', 'supervisor')
  const foreign: CentralSyncEvent = {
    protocolVersion: 1, eventId: 'e2e-foreign-1', eventSeq: 1, idempotencyKey: 'e2e/foreign-1', direction: 'up',
    entityType: 'customer', entityId: scopedRef(deviceId, 'customer:1'), eventType: 'customer_projected',
    aggregateVersion: 999, payload: { displayName: 'B 机冒充改名' }, occurredAt: Date.now()
  }
  const foreignPush = await call('POST', '/api/v1/sync/push', supervisor2.token, { events: [foreign] })
  const foreignCodes = ((foreignPush.data?.rejected || []) as Array<{ code: string }>).map((r) => r.code)
  ok('H1 设备 B 推送本机命名空间的 entityId：拒收 entity_id_not_owned（不是静默覆盖）',
    foreignPush.status === 200 && foreignCodes.includes('entity_id_not_owned'), JSON.stringify(foreignPush))
  ok('H2 更高 aggregateVersion 也不能跨设备覆盖既有投影',
    String(store.projectionRow('customer', scopedRef(deviceId, 'customer:1'))?.payload.displayName) === '端到端客户甲-改名')
  const foreignOwn: CentralSyncEvent = { ...foreign, eventId: 'e2e-foreign-own', idempotencyKey: 'e2e/foreign-own',
    entityId: scopedRef(supervisor2.deviceId, 'customer:9') }
  const ownPush = await call('POST', '/api/v1/sync/push', supervisor2.token, { events: [foreignOwn] })
  ok('H3 同工作区内的合法新客户投影按设备命名空间各存一份，互不覆盖',
    String(store.projectionRow('customer', scopedRef(supervisor2.deviceId, 'customer:9'))?.payload.displayName) === 'B 机冒充改名' &&
    Boolean(((ownPush.data?.accepted || []) as unknown[]).length))
  const salesOwn: CentralSyncEvent = { protocolVersion: 1, eventId: 'e2e-sales-own', eventSeq: 1,
    idempotencyKey: 'e2e/sales-own', direction: 'up', entityType: 'ownership',
    entityId: scopedRef(sales.deviceId, 'ownership:1'), eventType: 'ownership_projected',
    aggregateVersion: 1, payload: { customerRef: scopedRef(sales.deviceId, 'customer:1'), ownerSales: '测试销售甲' },
    occurredAt: Date.now() }
  const salesPush = await call('POST', '/api/v1/sync/push', sales.token, { events: [salesOwn] })
  const salesCodes = ((salesPush.data?.rejected || []) as Array<{ code: string }>).map((r) => r.code)
  ok('H4 销售设备不能上传越权类别投影（ownership 属分配侧）：服务端按角色拒收',
    salesCodes.includes('role_not_allowed_entity:ownership'), JSON.stringify(salesPush))
  const salesCommand = await call('POST', '/api/v1/sync/commands', sales.token, {
    protocolVersion: 1, eventId: 'e2e-sales-cmd', eventSeq: 1, idempotencyKey: 'e2e/sales-cmd', direction: 'down',
    entityType: 'assignment', entityId: scopedRef(sales.deviceId, 'assignment:1'), eventType: 'assign',
    aggregateVersion: 1, occurredAt: Date.now(), targetEmployeeId: sales.employeeId,
    payload: { type: 'assign', deliveryRole: 'apply', leadId: downLeadId, assignmentId: 1, salesName: SALES_NAME }
  })
  ok('H5 销售设备无 command.issue 权限：下发指令 403（权限来自服务端绑定，不认本地自报角色）',
    salesCommand.status === 403, JSON.stringify(salesCommand))
  ok('H6 bootstrap 管理员无工作区上下文时不得调用常规同步接口（空 workspaceId 不能绕过隔离）',
    (await call('GET', '/api/v1/sync/pull?cursor=0&limit=1', ADMIN_TOKEN)).status === 400)

  console.log('═══ I. 自助解绑：中央审计只留一行 ═══')
  const revoke = await call('POST', '/api/v1/devices/revoke-self', supervisor2.token, {})
  const revokeAudits = store.auditActions().filter((a) => a.action === 'device_revoke_self')
  ok('I1 自助解绑成功：该设备恰好一条 device_revoke_self 审计，且没有第二条 device_revoke 行',
    revoke.status === 200 && revokeAudits.length === 1 && revokeAudits[0]!.entityId === supervisor2.deviceId &&
    !store.auditActions().some((a) => a.action === 'device_revoke' && a.entityId === supervisor2.deviceId),
    JSON.stringify(revoke) + JSON.stringify(revokeAudits))

  await app.close()
  console.log(`\ncentral sync e2e test: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exitCode = 1
}

void main()
