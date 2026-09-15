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
 * 覆盖（每条都由真实生产者进入，不停留在「路由表里含某字符串」）：
 *   - 投影链：claim / bind_wx / first_touch → outbox → /sync/push → 中央投影表；
 *   - 指令链：assign / recycle / sla1_escalate_supervisor → outbox → /sync/commands →
 *     中央 down_event → /sync/pull → 本机既有状态机 → /sync/ack；
 *   - **移交链（J 段）**：真实 transferAssignment() → 一条 outbox → 两条下行指令
 *     （新归属 apply / 原归属 remove）→ 双目标都被中央受理才结算 sent → 重放去重 →
 *     第二目标先瞬时失败、恢复后补投 → 两个接收端各自经既有状态机落地并回 ACK。
 *   另有：敏感字段不出现在任何 HTTP 请求正文；服务端严格投影校验；网络失败重放；幂等；
 *   状态更新再同步；跨设备越权；游标跳过；自助解绑审计。
 *
 * 边界：中央侧是**真实 Fastify 路由 + MemoryCentralStore**（内存实现），不连真实 PostgreSQL，
 *       也不启动真实节点进程；真实库里已有数据、真实部署、真机（Windows）、SSE 与真实 AI 调用**均未验证**。
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
  auditActions: () => Array<{ actor: string; action: string; entityType: string; entityId: string; detail: Record<string, unknown> }>
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
/** 移交用例的接收方销售（必须在任何目录拉取之前认领：目录有 5 分钟 TTL 缓存） */
const SALES2_NAME = '测试销售乙'
const TRANSFER_PHONE = '13800004444'
/** 部分成功用例的线索：它的 remove 目标是**从未送达过**的新事件，才能验证「补投失败目标」 */
const TRANSFER2_PHONE = '13800005555'
/** 4xx 部分成功用例的线索（第一目标受理、第二目标永久拒收） */
const TRANSFER3_PHONE = '13800006666'

let app: AppLike
let store: StoreLike
let captured: Array<{ url: string; method: string; body: string; status: number; response: string }> = []
let netMode: 'ok' | 'fail' = 'ok'
/**
 * 定向瞬时失败：只让「投给指定员工的那一条指令」失败**一次**。
 * 用于验证双目标投递的部分成功语义（目标一已送达、目标二瞬时失败），
 * 而不是把整批一起打死——那验证不出「已成功目标靠幂等去重、失败目标继续补投」。
 */
let failCommandOnceFor: string | null = null
/**
 * 定向永久拒收：只让「投给指定员工的那一条指令」得到一次真实 4xx 响应（不抛网络错误）。
 * 用于验证「第一目标已受理、第二目标 4xx」的边界：outbox 不得标 sent，必须 failed + 脱敏审计。
 */
let rejectCommandOnceFor: { match: string; status: number } | null = null
let crmDbService: (typeof import('../electron/services/crmDbService'))['crmDbService']
let salesDbService: (typeof import('../electron/services/salesDbService'))['salesDbService']
let ConfigService: (typeof import('../electron/services/config'))['ConfigService']
let service: typeof import('../electron/services/centralSyncService')
let lanSync: typeof import('../electron/services/lanSyncService')
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
/** 本机为某条中央下行事件回写的 ACK 结果（证明该指令真的被既有状态机消费过，而不是只到了中央） */
function ackOf(eventId: string): string {
  for (const call of captured) {
    if (!call.url.endsWith('/api/v1/sync/ack') || !call.body) continue
    const body = JSON.parse(call.body) as { acknowledgements: Array<{ eventId: string; outcome: string }> }
    const hit = body.acknowledgements.find((x) => x.eventId === eventId)
    if (hit) return hit.outcome
  }
  return ''
}

/** 中央留下的下行指令审计（down_command）：只记定位元数据，不记载荷 */
function downAudits(): ReturnType<StoreLike['auditActions']> {
  return store.auditActions().filter((a) => a.action === 'down_command')
}
/** 移交类下行指令审计（用于按类型隔离基线，不受同批刷出的其它指令影响） */
function transferAudits(): ReturnType<StoreLike['auditActions']> {
  return downAudits().filter((a) => a.detail.eventType === 'transfer')
}
/** 本轮发出的下行指令里，被中央判为 duplicate（幂等去重，未新增业务记录）的条数 */
function duplicateCommandResponses(): number {
  return captured.filter((c) => c.url.endsWith('/api/v1/sync/commands') && c.response.includes('"duplicate":true')).length
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
  lanSync = await import('../electron/services/lanSyncService')
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
    if (failCommandOnceFor && url.endsWith('/api/v1/sync/commands') && (body || '').includes(failCommandOnceFor)) {
      failCommandOnceFor = null
      throw new Error('network unreachable')
    }
    if (rejectCommandOnceFor && url.endsWith('/api/v1/sync/commands') && (body || '').includes(rejectCommandOnceFor.match)) {
      // 模拟中央对该目标的永久拒收（契约/权限 4xx）：不经过 app.inject，不代表真实路由行为
      const { status } = rejectCommandOnceFor
      rejectCommandOnceFor = null
      captured.push(call0)
      call0.status = status
      call0.response = JSON.stringify({ ok: false, code: 'E103', message: '模拟永久拒收（契约错误）' })
      return new Response(call0.response, { status, headers: { 'content-type': 'application/json' } })
    }
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
  // 移交用例的接收方：必须在**任何**目录拉取之前就存在（fetchDirectory 有 5 分钟 TTL 缓存，
  // 后认领的员工不在本轮目录快照里，按显示名解析会失败）
  const sales2 = await onboard('S002', SALES2_NAME, 'sales')
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
      // 建档契约（2026-09-15 起强制）：固定 6 字段必须全部存在，contactNormalized 非空
      lead: { leadId: downLeadId, name: '端到端线索丙', contactType: 'phone', contactNormalized: DOWN_PHONE, source: 'e2e', note: '' }
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

  // 同一次 runSla1Recycle（第 3 次超时）在同事务里还登记了 recycle 指令 outbox：
  // 回收事实必须让归属设备知道，不能只发主管通知。这里把整条 recycle 链断言完整，
  // 而不是只看「outbox 路由表里有 recycle 这个字符串」。
  const recycleRow = crmDbService.all("SELECT id, status FROM outbox_event WHERE idempotency_key = ?", [`recycle:${slaAssignmentId}`])[0]
  const recycleCmd = commandBodies().find((e) => e.eventType === 'recycle')
  const recyclePayload = (recycleCmd?.payload || {}) as Record<string, unknown>
  ok('E5 真实回收生产者同事务登记 recycle outbox，并被中央受理结算 sent',
    Boolean(recycleRow) && String(crmDbService.all('SELECT status FROM outbox_event WHERE id = ?', [Number(recycleRow?.id)])[0]?.status) === 'sent',
    JSON.stringify(recycleRow))
  ok('E6 recycle 指令载荷/投递目标正确，且按注册表**不携带 lead 子对象**（recycle 必带 6 字段的说法不成立）',
    Boolean(recycleCmd) && recyclePayload.type === 'recycle' && Number(recyclePayload.assignmentId) === slaAssignmentId &&
    String(recyclePayload.salesName) === SUPERVISOR_NAME && String(recycleCmd?.targetEmployeeId) === supervisor.employeeId &&
    recyclePayload.lead === undefined, JSON.stringify(recycleCmd))
  ok('E7 recycle 指令经既有状态机落地（本机已是回收态 → 状态机按幂等空操作返回 applied）并回 ACK',
    ackOf(String(recycleCmd?.eventId || '')) === 'applied' &&
    String(crmDbService.all('SELECT status FROM assignment WHERE id = ?', [slaAssignmentId])[0]?.status) === 'recycled',
    ackOf(String(recycleCmd?.eventId || '')))

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

  console.log('═══ J. 真实移交：一条 outbox → 双目标下行指令 → 双目标确认 → 既有状态机落地 ═══')
  const supervisorCursor = crmDbService.getScanState('centralSync:pullCursor')
  const supervisorBinding = service.getCentralSyncConfig()
  /**
   * 把本机绑定切到另一台设备的**真实身份**（令牌/设备/员工都来自真实邀请码认领流程），
   * 用于消费发给它的下行指令。这只换「我是谁」，不换任何业务路径：仍然是
   * runCentralSyncOnce → CentralSyncClient → 真实路由 → /sync/pull → 既有状态机 → /sync/ack。
   */
  const bindAs = (target: Onboarded, role: string): void => {
    const conf = ConfigService.getInstance()
    conf.set('centralSyncEnabled', true)
    conf.set('centralSyncBaseUrl', BASE_URL)
    conf.set('centralSyncDeviceToken', target.token)
    conf.set('centralSyncWorkspaceId', target.workspaceId)
    conf.set('centralSyncEmployeeId', target.employeeId)
    conf.set('centralSyncDeviceId', target.deviceId)
    conf.set('centralSyncRole', role)
    conf.set('centralSyncDisplayName', role === 'supervisor' ? SUPERVISOR_NAME : SALES2_NAME)
    conf.set('centralSyncLastError', '')
    // 换设备必须回到 0 号游标，否则「发给我这台设备的新指令」会被上一台设备的游标跳过
    crmDbService.setScanState('centralSync:pullCursor', 0)
    resetCapture()
  }

  // 清场：先投完 J 段之前遗留的待发送行，让下面的计数基线只反映「移交本身」
  await service.runCentralSyncOnce()
  resetCapture()

  ConfigService.getInstance().set('crmSalesList', [SALES_NAME, SALES2_NAME])
  const jImported = leadSvc.importLeads('e2e-transfer', 'e2e-transfer.csv',
    [{ phone: TRANSFER_PHONE, name: '端到端移交线索', source: 'e2e' }])
  const transferLeadId = Number(crmDbService.all('SELECT id FROM lead WHERE contact_normalized = ?', [TRANSFER_PHONE])[0]?.id || 0)
  const jAssigned = assignmentSvc.assignLeads([transferLeadId], SALES_NAME, SUPERVISOR_NAME)
  const oldAssignmentId = Number(assignmentSvc.currentAssignment(transferLeadId)?.id || 0)
  const moved = assignmentSvc.transferAssignment(oldAssignmentId, SALES2_NAME, 'e2e 移交', SUPERVISOR_NAME)
  const newAssignmentId = Number((moved.data as { assignmentId?: number } | undefined)?.assignmentId || 0)
  const transferRow = crmDbService.all('SELECT id, status FROM outbox_event WHERE idempotency_key = ?', [`transfer:${newAssignmentId}`])[0]
  // 移交事实产生时确定的 SLA 截止时间与分配模式（接收端必须精确落地这两个值，绝不重算）
  const newAssignmentRow = crmDbService.all('SELECT sla1_deadline, mode FROM assignment WHERE id = ?', [newAssignmentId])[0]
  const jSla1 = Number(newAssignmentRow?.sla1_deadline || 0)
  const jMode = String(newAssignmentRow?.mode || '')
  ok('J1 真实移交生产者 transferAssignment：旧行 transferred + 新行 assigned，同事务登记 transfer outbox',
    jImported.valid === 1 && jAssigned.ok === true && oldAssignmentId > 0 && moved.ok === true && newAssignmentId > 0 &&
    String(transferRow?.status) === 'pending' &&
    String(crmDbService.all('SELECT status FROM assignment WHERE id = ?', [oldAssignmentId])[0]?.status) === 'transferred' &&
    String(crmDbService.all('SELECT sales_name FROM assignment WHERE id = ?', [newAssignmentId])[0]?.sales_name) === SALES2_NAME,
    JSON.stringify([jImported, jAssigned, moved]))
  ok('J1b 移交 outbox 携带本轮真实 sla1Deadline 与 mode（修复前丢失 → 接收端落 NULL/回退哨兵）',
    (() => {
      const p = JSON.parse(String(crmDbService.all('SELECT payload FROM outbox_event WHERE id = ?', [Number(transferRow?.id || 0)])[0]?.payload || '{}')) as Record<string, unknown>
      return Number(p.sla1Deadline) === jSla1 && jSla1 > 0 && String(p.mode) === jMode && jMode === 'manual'
    })(), JSON.stringify({ jSla1, jMode }))

  const downEventsBefore = store.downEventCount()
  const transferAuditsBefore = transferAudits().length
  const transferRun = await service.runCentralSyncOnce()
  const transferCmds = commandBodies().filter((e) => e.eventType === 'transfer')
  const applyCmd = transferCmds.find((e) => ((e.payload || {}) as Record<string, unknown>).deliveryRole === 'apply')
  const removeCmd = transferCmds.find((e) => ((e.payload || {}) as Record<string, unknown>).deliveryRole === 'remove')
  ok('J2 一条移交 outbox → 两条下行指令：新归属 apply、原归属 remove，各自带明确投递目标',
    transferCmds.length === 2 && String(applyCmd?.targetEmployeeId) === sales2.employeeId &&
    String(removeCmd?.targetEmployeeId) === sales.employeeId,
    JSON.stringify(transferCmds.map((e) => ({ role: ((e.payload || {}) as Record<string, unknown>).deliveryRole, to: e.targetEmployeeId }))))
  /** 两条指令都必须与 DOWN_COMMAND_SPECS.transfer 一致，且线索资料来自复用的 commandLeadOf（6 字段） */
  const transferPayloadOk = (cmd?: CentralSyncEvent): boolean => {
    const p = (cmd?.payload || {}) as Record<string, unknown>
    const lead = (p.lead || {}) as Record<string, unknown>
    return p.type === 'transfer' && Number(p.leadId) === transferLeadId && Number(p.assignmentId) === newAssignmentId &&
      Number(p.oldAssignmentId) === oldAssignmentId && String(p.fromSales) === SALES_NAME && String(p.toSales) === SALES2_NAME &&
      String(p.reason) === 'e2e 移交' && Object.keys(lead).length === 6 &&
      Object.keys(lead).every((k) => allowedLeadKeys.has(k)) && Number(lead.leadId) === transferLeadId
  }
  ok('J3 两条指令载荷都符合 transfer 契约（含 6 字段线索资料，复用 commandLeadOf 未另建一份构造逻辑）',
    transferPayloadOk(applyCmd) && transferPayloadOk(removeCmd),
    JSON.stringify(transferCmds.map((e) => e.payload)))
  ok('J3b 两条指令都携带发起端确定的 sla1Deadline（有限正整数）与 mode，且与本地新行逐值相等',
    transferCmds.length === 2 && transferCmds.every((e) => {
      const p = (e.payload || {}) as Record<string, unknown>
      return Number.isInteger(p.sla1Deadline) && Number(p.sla1Deadline) > 0 &&
        Number(p.sla1Deadline) === jSla1 && String(p.mode) === jMode
    }), JSON.stringify({ jSla1, jMode, cmds: transferCmds.map((e) => ({ sla: (e.payload as Record<string, unknown>).sla1Deadline, mode: (e.payload as Record<string, unknown>).mode })) }))
  ok('J4 两条指令都不携带 contactRaw / wechat（中央下行 lead 只允许 6 个字段）',
    transferCmds.length === 2 && !capturedText().includes('"contactRaw"') && !capturedText().includes('"wechat"') &&
    !capturedText().includes('chatHistory') && !capturedText().includes('messageRaw'))
  ok('J5 两个目标的幂等键互不相同且各自绑定投递角色（不会互相顶掉、可分别判重）',
    Boolean(applyCmd && removeCmd) && applyCmd!.idempotencyKey !== removeCmd!.idempotencyKey &&
    applyCmd!.idempotencyKey.includes('#apply#') && removeCmd!.idempotencyKey.includes('#remove#') &&
    applyCmd!.eventId !== removeCmd!.eventId,
    JSON.stringify([applyCmd?.idempotencyKey, removeCmd?.idempotencyKey]))
  ok('J6 outbox 只在两个目标都被中央受理后才结算 sent',
    transferRun.error === undefined && transferRun.rejected === 0 &&
    String(crmDbService.all('SELECT status FROM outbox_event WHERE id = ?', [Number(transferRow?.id)])[0]?.status) === 'sent',
    JSON.stringify(transferRun))
  const newTransferAudits = transferAudits().slice(transferAuditsBefore)
  const downAfterTransfer = store.downEventCount()
  ok('J7 中央为两条移交指令各留一条 down_command 审计（只记定位元数据，不记载荷）',
    newTransferAudits.length === 2 && downAfterTransfer > downEventsBefore &&
    newTransferAudits.every((a) => a.entityType === 'assignment' && [applyCmd!.eventId, removeCmd!.eventId].includes(String(a.detail.eventId))) &&
    newTransferAudits.map((a) => String(a.detail.targetEmployeeId)).sort().join() === [sales.employeeId, sales2.employeeId].sort().join() &&
    !JSON.stringify(newTransferAudits).includes(TRANSFER_PHONE) && !JSON.stringify(newTransferAudits).includes('端到端移交线索'),
    JSON.stringify(newTransferAudits))

  // 重放抑制：**不再**由测试手改 outbox 状态来「复活」已结算的行——生产上没有这种入口
  // （正式重投入口 retryFailedOutbox 只受理 failed 行，sent 行不可复活）。这里断言的是那层保障本身：
  // 已结算的行不会被再次投递，既不重复送达、也不对中央发起多余的判重请求。
  // 「同 eventId + 同幂等键 → 中央判 duplicate」由 J9→J11 的真实瞬断重试覆盖（apply 目标被真实重投），
  // 发起端身份稳定性 stableEventId(deviceId, key) 由 J11 逐字比对覆盖。
  resetCapture()
  const replayRun = await service.runCentralSyncOnce()
  const replayCmds = commandBodies().filter((e) => e.eventType === 'transfer')
  // 注意：不能用 `run.pushed === 0` 判——pushUp 还包含权限声明与本地投影，它们与本行无关。
  // 要断的是**这一行**的投递身份没有再次出机：两条指令的 eventId 不得出现在本轮任何请求里。
  const replayTraffic = capturedText()
  ok('J8 已结算（sent）的移交行不会被再次投递：不新增指令、不新增判重请求、不重复建审计',
    replayRun.error === undefined && replayCmds.length === 0 &&
    !replayTraffic.includes(String(applyCmd?.eventId || 'x')) && !replayTraffic.includes(String(removeCmd?.eventId || 'y')) &&
    duplicateCommandResponses() === 0 &&
    String(crmDbService.all('SELECT status FROM outbox_event WHERE id = ?', [Number(transferRow?.id)])[0]?.status) === 'sent' &&
    store.downEventCount() === downAfterTransfer && transferAudits().length === transferAuditsBefore + 2,
    JSON.stringify({
      run: replayRun, n: replayCmds.length, duplicates: duplicateCommandResponses(),
      down: [downAfterTransfer, store.downEventCount()], audits: [transferAuditsBefore, transferAudits().length]
    }))

  // 部分成功语义必须用**从未送达过**的目标来验：上一条移交的两个目标此时都已在中央判重，
  // 拿它模拟「第二目标失败」验证不出「失败目标恢复后补投」，所以再走一次真实移交（第二条线索）。
  const imported2 = leadSvc.importLeads('e2e-transfer-2', 'e2e-transfer-2.csv',
    [{ phone: TRANSFER2_PHONE, name: '端到端移交线索二', source: 'e2e' }])
  const lead2Id = Number(crmDbService.all('SELECT id FROM lead WHERE contact_normalized = ?', [TRANSFER2_PHONE])[0]?.id || 0)
  assignmentSvc.assignLeads([lead2Id], SALES_NAME, SUPERVISOR_NAME)
  // 先把「这次分配」投完（否则它会在失败模拟那一轮抢在移交指令之前被打死）
  await service.runCentralSyncOnce()
  resetCapture()
  const old2AssignmentId = Number(assignmentSvc.currentAssignment(lead2Id)?.id || 0)
  const moved2 = assignmentSvc.transferAssignment(old2AssignmentId, SALES2_NAME, 'e2e 移交二', SUPERVISOR_NAME)
  const new2AssignmentId = Number((moved2.data as { assignmentId?: number } | undefined)?.assignmentId || 0)
  const transfer2Row = crmDbService.all('SELECT id, status FROM outbox_event WHERE idempotency_key = ?', [`transfer:${new2AssignmentId}`])[0]
  const downEventsBeforePartial = store.downEventCount()
  const transferAuditsBeforePartial = transferAudits().length
  failCommandOnceFor = sales.employeeId
  resetCapture()
  const partialRun = await service.runCentralSyncOnce()
  const partialStatus = String(crmDbService.all('SELECT status FROM outbox_event WHERE id = ?', [Number(transfer2Row?.id)])[0]?.status)
  const partialCmds = commandBodies().filter((e) => e.eventType === 'transfer')
  const partialNewAudits = transferAudits().slice(transferAuditsBeforePartial)
  ok('J9 第二目标瞬时失败：整行保持 pending、如实上抛错误，绝不假装部分成功已结算',
    imported2.valid === 1 && Boolean(transfer2Row) && Boolean(partialRun.error) && partialStatus === 'pending',
    JSON.stringify(partialRun) + partialStatus)
  ok('J10 失败那一轮：已送达目标确已到中央（新事件 +1，不是半条），未送达目标一条都没到',
    store.downEventCount() === downEventsBeforePartial + 1 && partialCmds.length === 1 &&
    partialNewAudits.length === 1 && String(partialNewAudits[0]?.detail.eventId) === String(partialCmds[0]?.eventId),
    JSON.stringify({
      down: [downEventsBeforePartial, store.downEventCount()],
      cmds: partialCmds.map((e) => e.idempotencyKey), audits: partialNewAudits.map((a) => a.detail)
    }))
  failCommandOnceFor = null
  resetCapture()
  const recoveredRun = await service.runCentralSyncOnce()
  const recoveredCmds = commandBodies().filter((e) => e.eventType === 'transfer')
  const recoveredRemove = recoveredCmds.find((e) => ((e.payload || {}) as Record<string, unknown>).deliveryRole === 'remove')
  const recoveredApply = recoveredCmds.find((e) => ((e.payload || {}) as Record<string, unknown>).deliveryRole === 'apply')
  ok('J11 恢复后顺序重试即收敛：已成功目标按幂等去重、失败目标补投到中央，两个目标都受理才置 sent',
    recoveredRun.error === undefined && recoveredCmds.length === 2 && duplicateCommandResponses() === 1 &&
    // 身份稳定性：重投的 apply 与首轮送达的 apply eventId 逐字相同（stableEventId(deviceId, 幂等键)），
    // 中央正是靠这个身份判 duplicate——若 eventId 每次重算，判重就失效、会重复建指令。
    String(recoveredApply?.eventId) === String(partialCmds[0]?.eventId) &&
    String(recoveredRemove?.idempotencyKey || '').includes('#remove#') &&
    !String(recoveredRemove?.eventId || '').startsWith(String(partialCmds[0]?.eventId || 'x')) &&
    store.downEventCount() === downEventsBeforePartial + 2 && transferAudits().length === transferAuditsBeforePartial + 2 &&
    String(crmDbService.all('SELECT status FROM outbox_event WHERE id = ?', [Number(transfer2Row?.id)])[0]?.status) === 'sent',
    JSON.stringify({
      run: recoveredRun, cmdIds: recoveredCmds.map((e) => e.eventId),
      firstApplyId: partialCmds[0]?.eventId, duplicates: duplicateCommandResponses(),
      down: [downEventsBeforePartial, store.downEventCount()], audits: [transferAuditsBeforePartial, transferAudits().length]
    }))

  // ── 双目标 4xx 部分成功边界：第一目标已受理、第二目标永久拒收 ──
  // 不得把 outbox 标 sent；必须 failed + 留够人工修复的脱敏审计（谁已送达/谁被拒）；
  // 绝不静默形成两个销售设备各持有效归属而无人知晓。
  const imported3 = leadSvc.importLeads('e2e-transfer-3', 'e2e-transfer-3.csv',
    [{ phone: TRANSFER3_PHONE, name: '端到端移交线索三', source: 'e2e' }])
  const lead3Id = Number(crmDbService.all('SELECT id FROM lead WHERE contact_normalized = ?', [TRANSFER3_PHONE])[0]?.id || 0)
  assignmentSvc.assignLeads([lead3Id], SALES_NAME, SUPERVISOR_NAME)
  await service.runCentralSyncOnce() // 先把第三条线索的 assign 投完，避免干扰 4xx 轮的计数
  resetCapture()
  const old3AssignmentId = Number(assignmentSvc.currentAssignment(lead3Id)?.id || 0)
  const moved3 = assignmentSvc.transferAssignment(old3AssignmentId, SALES2_NAME, 'e2e 移交三', SUPERVISOR_NAME)
  const new3AssignmentId = Number((moved3.data as { assignmentId?: number } | undefined)?.assignmentId || 0)
  const transfer3Row = crmDbService.all('SELECT id, status FROM outbox_event WHERE idempotency_key = ?', [`transfer:${new3AssignmentId}`])[0]
  const downBefore4xx = store.downEventCount()
  const failAuditsBefore4xx = crmDbService.all("SELECT id FROM audit_event WHERE action = 'sync_outbox_failed'").length
  rejectCommandOnceFor = { match: sales.employeeId, status: 400 } // remove 目标（原归属）永久拒收一次
  const partial4xxRun = await service.runCentralSyncOnce()
  const transfer3Status = String(crmDbService.all('SELECT status FROM outbox_event WHERE id = ?', [Number(transfer3Row?.id)])[0]?.status)
  const failAudit4xx = crmDbService.all("SELECT * FROM audit_event WHERE action = 'sync_outbox_failed' ORDER BY id DESC LIMIT 1")[0]
  const failDetail4xx = JSON.parse(String(failAudit4xx?.detail || '{}')) as Record<string, unknown>
  ok('J11b 第一目标受理 + 第二目标永久 4xx：outbox 标 failed（绝不标 sent），apply 目标确已送达',
    imported3.valid === 1 && moved3.ok === true && partial4xxRun.error === undefined &&
    transfer3Status === 'failed' && store.downEventCount() === downBefore4xx + 1,
    JSON.stringify({ run: partial4xxRun, status: transfer3Status, down: [downBefore4xx, store.downEventCount()] }))
  ok('J11c 4xx 终态留足人工修复审计：failedRole + failedTarget（稳定员工标识）+ delivered，且不含客户联系方式',
    crmDbService.all("SELECT id FROM audit_event WHERE action = 'sync_outbox_failed'").length === failAuditsBefore4xx + 1 &&
    String(failDetail4xx.reason) === 'http_400:E103' && String(failDetail4xx.failedRole) === 'remove' &&
    String(failDetail4xx.failedTarget) === sales.employeeId && Number(failDetail4xx.delivered) === 1 &&
    !JSON.stringify(failDetail4xx).includes(TRANSFER3_PHONE),
    JSON.stringify(failDetail4xx))
  // 人工修复后重投：走**正式生产入口** retryFailedOutbox（settings 页「重试失败同步项」背后的同一条
  // service 方法），不再由测试直接 UPDATE outbox_event 改状态——测试不得持有生产没有的写库能力。
  // 该入口只受理 failed 行、只做 failed → pending 的原子翻转，且不动 payload / event_seq / 幂等键。
  const beforeRetry = crmDbService.all('SELECT event_seq, idempotency_key, payload FROM outbox_event WHERE id = ?', [Number(transfer3Row?.id)])[0]
  const retry4xx = service.retryFailedOutbox(Number(transfer3Row?.id || 0))
  ok('J11d0 正式重投入口受理该 failed 行：原子翻转 failed → pending，返回稳定码 ok',
    retry4xx.ok === true && retry4xx.code === 'ok' && retry4xx.rowId === Number(transfer3Row?.id) &&
    String(crmDbService.all('SELECT status FROM outbox_event WHERE id = ?', [Number(transfer3Row?.id)])[0]?.status) === 'pending',
    JSON.stringify(retry4xx))
  resetCapture()
  const recover4xxRun = await service.runCentralSyncOnce()
  ok('J11d 修复后顺序重投收敛：apply 判 duplicate、remove 补投到中央，双目标受理后才置 sent',
    recover4xxRun.error === undefined && duplicateCommandResponses() === 1 &&
    store.downEventCount() === downBefore4xx + 2 &&
    String(crmDbService.all('SELECT status FROM outbox_event WHERE id = ?', [Number(transfer3Row?.id)])[0]?.status) === 'sent',
    JSON.stringify({ run: recover4xxRun, down: [downBefore4xx, store.downEventCount()], duplicates: duplicateCommandResponses() }))

  // ── 正式重投入口的边界契约：只翻转 failed 行，只动 status/updated_at ──────────
  const afterRetry = crmDbService.all('SELECT status, event_seq, idempotency_key, payload FROM outbox_event WHERE id = ?', [Number(transfer3Row?.id)])[0]
  const retryAgain = service.retryFailedOutbox(Number(transfer3Row?.id || 0))
  const afterAgain = crmDbService.all('SELECT status, event_seq, idempotency_key, payload FROM outbox_event WHERE id = ?', [Number(transfer3Row?.id)])[0]
  ok('J11e 重投只翻转状态：event_seq / 幂等键 / payload 逐字不变（身份字段不可被重投改写）',
    String(afterRetry?.event_seq) === String(beforeRetry?.event_seq) &&
    String(afterRetry?.idempotency_key) === String(beforeRetry?.idempotency_key) &&
    String(afterRetry?.payload) === String(beforeRetry?.payload) &&
    String(afterRetry?.idempotency_key) === `transfer:${new3AssignmentId}`,
    JSON.stringify({ before: beforeRetry, after: { seq: afterRetry?.event_seq, key: afterRetry?.idempotency_key } }))
  ok('J11f 重复点击幂等：行已收敛（sent）时再次重投被稳定拒收，状态与身份字段一律不变',
    retryAgain.ok === false && retryAgain.code === 'not_failed' &&
    String(afterAgain?.status) === 'sent' &&
    String(afterAgain?.event_seq) === String(afterRetry?.event_seq) &&
    String(afterAgain?.idempotency_key) === String(afterRetry?.idempotency_key) &&
    String(afterAgain?.payload) === String(afterRetry?.payload),
    JSON.stringify({ retryAgain, status: afterAgain?.status }))
  ok('J11g 非法 rowId 被稳定拒收：0 / 负数 / 小数都返回 invalid_row_id，不做任何状态变更',
    [0, -1, 1.5].every((bad) => {
      const r = service.retryFailedOutbox(bad)
      return r.ok === false && r.code === 'invalid_row_id'
    }))
  ok('J11h 不存在的 rowId 返回 not_found（不静默当成成功）',
    (() => { const r = service.retryFailedOutbox(99999999); return r.ok === false && r.code === 'not_found' })())
  // 未注册类型的 failed 行：入口必须拒绝（正式入口只服务已登记的下行类型，不是万能 SQL 执行器）。
  // 这里直接造一条 fixture 行——是**测试布置**，不是给测试开一条生产没有的恢复能力。
  const unknownRow = crmDbService.runTx((tx) => {
    tx.run("INSERT INTO outbox_event (event_seq, idempotency_key, payload, status, source, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
      [999999, 'e2e-unknown-type-fixture', JSON.stringify({ type: 'e2e_unknown_type' }), 'failed', 'e2e', Date.now(), Date.now()])
    return Number(tx.all("SELECT id FROM outbox_event WHERE idempotency_key = 'e2e-unknown-type-fixture'")[0]?.id || 0)
  })
  const unknownRetry = service.retryFailedOutbox(unknownRow)
  const auditRetryBefore = crmDbService.all("SELECT id FROM audit_event WHERE action = 'sync_outbox_retry'").length
  ok('J11i 未注册类型的 failed 行被稳定拒收（unsupported_type），且行仍停在 failed、不产生重投审计',
    unknownRetry.ok === false && unknownRetry.code === 'unsupported_type' &&
    String(crmDbService.all('SELECT status FROM outbox_event WHERE id = ?', [unknownRow])[0]?.status) === 'failed' &&
    crmDbService.all("SELECT id FROM audit_event WHERE action = 'sync_outbox_retry'").length === auditRetryBefore)
  ok('J11j 成功重投已追审计（actor/action/entity 固定，detail 只带类型，不含客户联系方式与线索内容）',
    crmDbService.all("SELECT * FROM audit_event WHERE action = 'sync_outbox_retry' AND entity_id = ?", [String(Number(transfer3Row?.id))]).length === 1 &&
    !JSON.stringify(crmDbService.all("SELECT detail FROM audit_event WHERE action = 'sync_outbox_retry'")).includes(TRANSFER3_PHONE) &&
    !JSON.stringify(crmDbService.all("SELECT detail FROM audit_event WHERE action = 'sync_outbox_retry'")).includes('端到端移交线索三'))

  // ── 下游：两条指令必须经**既有 Phase 1 状态机**落到接收端的本机事实 ──
  // 本机是移交发起端（中枢工作机），库里的移交结果已经落地，不能拿它冒充接收端。
  // 因此显式把本机事实摆成「接收端库该有的样子」，再用真实的中央指令 + 真实状态机入口消费。
  // ① 原归属设备（remove）：库里保留该线索与甲名下的有效分配行
  crmDbService.runTx((tx) => {
    tx.run("UPDATE assignment SET status = 'transferred' WHERE id = ?", [newAssignmentId])
    tx.run("UPDATE assignment SET status = 'assigned' WHERE id = ?", [oldAssignmentId])
  })
  const oldRowBeforeRemove = crmDbService.all('SELECT sla1_deadline FROM assignment WHERE id = ?', [oldAssignmentId])[0]
  const leadDeadlineBeforeRemove = Number(crmDbService.all('SELECT first_contact_deadline FROM lead WHERE id = ?', [transferLeadId])[0]?.first_contact_deadline || 0)
  bindAs(sales, 'sales')
  const removeRun = await service.runCentralSyncOnce()
  ok('J12 原归属设备拉到 remove 指令：既有状态机移除甲的有效分配行（不新建行），并回 ACK applied',
    removeRun.error === undefined && ackOf(String(removeCmd?.eventId || '')) === 'applied' &&
    String(crmDbService.all('SELECT status FROM assignment WHERE id = ?', [oldAssignmentId])[0]?.status) === 'transferred' &&
    Number(crmDbService.all('SELECT COUNT(*) AS n FROM assignment WHERE lead_id = ?', [transferLeadId])[0]?.n || 0) === 2,
    ackOf(String(removeCmd?.eventId || '')))
  ok('J12b remove 分支不动 SLA：旧行 sla1_deadline 与 lead 首触期限原样保留（移除权属 ≠ 重起计时）',
    String(crmDbService.all('SELECT sla1_deadline FROM assignment WHERE id = ?', [oldAssignmentId])[0]?.sla1_deadline) === String(oldRowBeforeRemove?.sla1_deadline) &&
    Number(crmDbService.all('SELECT first_contact_deadline FROM lead WHERE id = ?', [transferLeadId])[0]?.first_contact_deadline || 0) === leadDeadlineBeforeRemove)

  // ② 新归属设备（apply）：乙的库里没有这条线索 → 指令携带的 6 字段线索资料就地建档
  crmDbService.runTx((tx) => {
    tx.run('DELETE FROM assignment WHERE lead_id = ?', [transferLeadId])
    tx.run('DELETE FROM lead WHERE id = ?', [transferLeadId])
  })
  bindAs(sales2, 'sales')
  const applyRun = await service.runCentralSyncOnce()
  const createdLead = crmDbService.all('SELECT id, name, contact_type, contact_normalized, first_contact_deadline FROM lead WHERE contact_normalized = ?', [TRANSFER_PHONE])[0]
  const createdAssignment = crmDbService.all("SELECT * FROM assignment WHERE lead_id = ? AND source = 'sync:down'", [Number(createdLead?.id || 0)])[0]
  ok('J13 新归属设备本机没有该线索：apply 指令经既有状态机就地建档（资料只来自指令白名单字段）并回 ACK applied',
    applyRun.error === undefined && ackOf(String(applyCmd?.eventId || '')) === 'applied' &&
    String(createdLead?.name) === '端到端移交线索' && String(createdLead?.contact_type) === 'phone',
    JSON.stringify(createdLead) + ackOf(String(applyCmd?.eventId || '')))
  ok('J14 apply 落地为乙名下新的有效分配行（source=sync:down，走既有状态机而非复制一份业务语义）',
    String(createdAssignment?.sales_name) === SALES2_NAME && String(createdAssignment?.status) === 'assigned',
    JSON.stringify(createdAssignment))
  ok('J14b 移交 SLA 精确落地：assignment.sla1_deadline 与 lead.first_contact_deadline 都逐值等于发起端指令值，mode 与发起端一致',
    Number(createdAssignment?.sla1_deadline) === jSla1 &&
    Number(createdLead?.first_contact_deadline) === jSla1 &&
    String(createdAssignment?.mode) === jMode,
    JSON.stringify({ asg: createdAssignment?.sla1_deadline, lead: createdLead?.first_contact_deadline, mode: createdAssignment?.mode, expect: jSla1 }))

  // 重放不漂移：同一移交指令（同幂等键）再应用一次，命中幂等标记零业务写，SLA 不重启不漂移
  const asgCountBeforeReplay = Number(crmDbService.all('SELECT COUNT(*) AS c FROM assignment WHERE lead_id = ?', [Number(createdLead?.id || 0)])[0]?.c || 0)
  const replayOutcome = lanSync.applyDownEventDirect({
    eventSeq: Number(applyCmd?.eventSeq || 1), idempotencyKey: String(applyCmd?.idempotencyKey || ''),
    type: 'transfer', deliveryRole: 'apply',
    payload: (applyCmd?.payload || {}) as Record<string, unknown>, emittedAt: Date.now()
  })
  ok('J15 同一移交指令重放：幂等命中零业务写，assignment.sla1_deadline 与 lead 首触期限纹丝不动',
    replayOutcome === 'applied' &&
    Number(crmDbService.all('SELECT sla1_deadline FROM assignment WHERE id = ?', [Number(createdAssignment?.id || 0)])[0]?.sla1_deadline) === jSla1 &&
    Number(crmDbService.all('SELECT first_contact_deadline FROM lead WHERE id = ?', [Number(createdLead?.id || 0)])[0]?.first_contact_deadline) === jSla1 &&
    Number(crmDbService.all('SELECT COUNT(*) AS c FROM assignment WHERE lead_id = ?', [Number(createdLead?.id || 0)])[0]?.c || 0) === asgCountBeforeReplay,
    String(replayOutcome))

  // 恢复本机绑定（本机 = 主管工作机），避免改变后续任何前置状态
  bindAs(supervisor, 'supervisor')

  console.log('═══ K. 升级兼容：升级前写出的 pending transfer（缺 mode/sla1Deadline）经中央 HTTP 通道自愈 ═══')
  // 被验证的真实缺陷：7278d61 之前 transferAssignment 只把 mode/sla1_deadline 写进新的 assignment 行，
  // 没写进 outbox payload；共享契约随后把两者列为 transfer 必填 → 升级后这些历史 pending 行
  // 在发送前自检即判非法、永远发不出去。修复口径见 electron/services/crmDownPayloadCompat.ts：
  // 从本机 assignment 行取**当时写入的绝对值**，绝不按当前时间/当前 crmLeadSlaHours 重算。
  const K_PHONE = '13800007777'
  const kImported = leadSvc.importLeads('e2e-legacy-transfer', 'e2e-legacy-transfer.csv',
    [{ phone: K_PHONE, name: '升级兼容线索', source: 'e2e' }])
  const kLeadId = Number(crmDbService.all('SELECT id FROM lead WHERE contact_normalized = ?', [K_PHONE])[0]?.id || 0)
  assignmentSvc.assignLeads([kLeadId], SALES_NAME, SUPERVISOR_NAME)
  await service.runCentralSyncOnce() // 先把这条 assign 投完，隔离本轮计数
  resetCapture()
  const kOldAssignmentId = Number(assignmentSvc.currentAssignment(kLeadId)?.id || 0)
  const kMoved = assignmentSvc.transferAssignment(kOldAssignmentId, SALES2_NAME, 'e2e 升级兼容移交', SUPERVISOR_NAME)
  const kNewAssignmentId = Number((kMoved.data as { assignmentId?: number } | undefined)?.assignmentId || 0)
  const kAssignmentRow = crmDbService.all('SELECT mode, sla1_deadline FROM assignment WHERE id = ?', [kNewAssignmentId])[0]
  const kMode = String(kAssignmentRow?.mode || '')
  const kSla = Number(kAssignmentRow?.sla1_deadline || 0)
  const kKey = `transfer:${kNewAssignmentId}`
  const kStateMachineRow = crmDbService.all('SELECT event_seq FROM outbox_event WHERE idempotency_key = ?', [kKey])[0]
  // 把状态机写出的「新写法」行改写成**升级前那一刻库里的真实行形态**：payload 里没有 mode/sla1Deadline。
  // 这是测试布置（重建历史行），不是给测试开一条生产没有的写库能力。
  const kSeq = Number(kStateMachineRow?.event_seq || 0)
  crmDbService.runTx((tx) => {
    tx.run('DELETE FROM outbox_event WHERE idempotency_key = ?', [kKey])
    tx.run('INSERT INTO outbox_event (event_seq, idempotency_key, payload, status, source, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
      [kSeq, kKey, JSON.stringify({
        type: 'transfer', leadId: kLeadId, assignmentId: kNewAssignmentId, oldAssignmentId: kOldAssignmentId,
        fromSales: SALES_NAME, toSales: SALES2_NAME, reason: 'e2e 升级兼容移交', actor: `system:${SUPERVISOR_NAME}`
      }), 'pending', 'e2e', Date.now(), Date.now()])
  })
  const kLegacyFrozen = String(crmDbService.all('SELECT payload FROM outbox_event WHERE idempotency_key = ?', [kKey])[0]?.payload)
  const kDownBefore = store.downEventCount()
  resetCapture()
  const kRun = await service.runCentralSyncOnce()
  const kCmds = commandBodies().filter((e) => e.eventType === 'transfer')
  ok('K1 前置：真实的 assignment 行确实带 mode 与 sla1_deadline（富化的唯一数据来源）',
    kImported.valid === 1 && kMoved.ok === true && kMode.length > 0 && kSla > 0,
    JSON.stringify({ imported: kImported.valid, moved: kMoved.ok, kMode, kSla }))
  ok('K2 升级前的 pending 行本轮成功投出两条指令（不再在发送前自检被判非法）',
    kRun.error === undefined && kRun.rejected === 0 && kCmds.length === 2 && store.downEventCount() === kDownBefore + 2,
    JSON.stringify({ run: kRun, n: kCmds.length, down: [kDownBefore, store.downEventCount()] }))
  ok('K3 两条指令都带上了富化后的 mode 与 sla1Deadline，且逐值等于本机 assignment 行（不重算、不漂移）',
    kCmds.every((e) => {
      const pl = (e.payload || {}) as Record<string, unknown>
      return String(pl.mode) === kMode && Number(pl.sla1Deadline) === kSla
    }), JSON.stringify(kCmds.map((e) => ({ role: (e.payload as Record<string, unknown>).deliveryRole, mode: (e.payload as Record<string, unknown>).mode, sla: (e.payload as Record<string, unknown>).sla1Deadline }))))
  ok('K4 富化不写回 outbox：库里那行 payload 保持升级前原样（惰性兼容，不做破坏性整表 UPDATE）',
    String(crmDbService.all('SELECT payload FROM outbox_event WHERE idempotency_key = ?', [kKey])[0]?.payload) === kLegacyFrozen)
  ok('K5 幂等键与 event_seq 未被改写（补的是同一条事实，不是新造一条）',
    String(crmDbService.all('SELECT idempotency_key FROM outbox_event WHERE idempotency_key = ?', [kKey])[0]?.idempotency_key) === kKey &&
    Number(crmDbService.all('SELECT event_seq FROM outbox_event WHERE idempotency_key = ?', [kKey])[0]?.event_seq) === kSeq)
  ok('K6 双目标都被中央受理后整行结算 sent',
    String(crmDbService.all('SELECT status FROM outbox_event WHERE idempotency_key = ?', [kKey])[0]?.status) === 'sent')

  // 不可恢复：不猜值、不发送，整行终态 failed + 脱敏审计（只有行号 / 类型 / 稳定错误码）
  const kBadKey = 'transfer:e2e-legacy-unrecoverable'
  const kFailedAuditsBefore = crmDbService.all("SELECT id FROM audit_event WHERE action = 'sync_outbox_failed'").length
  const kBadRowId = crmDbService.runTx((tx) => {
    tx.run('INSERT INTO outbox_event (event_seq, idempotency_key, payload, status, source, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
      [kSeq + 1, kBadKey, JSON.stringify({
        type: 'transfer', leadId: kLeadId, assignmentId: 987654321, oldAssignmentId: kOldAssignmentId,
        fromSales: SALES_NAME, toSales: SALES2_NAME, reason: 'e2e 升级兼容移交', actor: `system:${SUPERVISOR_NAME}`,
        lead: { leadId: kLeadId, name: '升级兼容线索', contactType: 'phone', contactNormalized: K_PHONE, source: 'e2e', note: '' }
      }), 'pending', 'e2e', Date.now(), Date.now()])
    return Number(tx.all('SELECT id FROM outbox_event WHERE idempotency_key = ?', [kBadKey])[0]?.id || 0)
  })
  const kDownBeforeBad = store.downEventCount()
  resetCapture()
  const kBadRun = await service.runCentralSyncOnce()
  const kBadAudit = crmDbService.all("SELECT * FROM audit_event WHERE action = 'sync_outbox_failed' ORDER BY id DESC LIMIT 1")[0]
  const kBadDetail = JSON.parse(String(kBadAudit?.detail || '{}')) as Record<string, unknown>
  ok('K7 恢复不了的升级前 pending 行：不猜值、不发送，整行终态 failed，中央一条都没收到',
    kBadRun.error === undefined && kBadRun.rejected === 1 &&
    String(crmDbService.all('SELECT status FROM outbox_event WHERE id = ?', [kBadRowId])[0]?.status) === 'failed' &&
    store.downEventCount() === kDownBeforeBad && commandBodies().filter((e) => e.eventType === 'transfer').length === 0,
    JSON.stringify({ run: kBadRun, status: crmDbService.all('SELECT status FROM outbox_event WHERE id = ?', [kBadRowId])[0]?.status }))
  ok('K8 脱敏审计：只有行号 + 类型 + 稳定错误码，不含联系方式 / 线索资料 / 聊天内容',
    ackOf(String(kBadRowId)) === '' &&
    crmDbService.all("SELECT id FROM audit_event WHERE action = 'sync_outbox_failed'").length === kFailedAuditsBefore + 1 &&
    String(kBadDetail.reason) === 'legacy_transfer_assignment_missing' && String(kBadDetail.commandType) === 'transfer' &&
    Object.keys(kBadDetail).sort().join() === 'commandType,reason' &&
    !JSON.stringify(kBadAudit).includes(K_PHONE) && !JSON.stringify(kBadAudit).includes('升级兼容线索'),
    JSON.stringify(kBadDetail))

  // K9/K10：身份一致性（2026-09-15 第二轮）。历史行可以补齐**自己这次移交**缺失的字段，
  // 但绝不能拿别的线索 / 别的销售的 assignment 行当自己的事实去补齐——那会把 B 线索的 mode/SLA
  // 贴到 A 线索的指令上。行存在却与载荷矛盾 → 不猜、不发，整行终态 failed + 脱敏审计。
  const K_PHONE2 = '13800007778'
  const kImported2 = leadSvc.importLeads('e2e-legacy-mismatch', 'e2e-legacy-mismatch.csv',
    [{ phone: K_PHONE2, name: '另线索', source: 'e2e' }])
  const kLeadId2 = Number(crmDbService.all('SELECT id FROM lead WHERE contact_normalized = ?', [K_PHONE2])[0]?.id || 0)
  const insertKFixture = (seq: number, key: string, payload: Record<string, unknown>): number => crmDbService.runTx((tx) => {
    tx.run('INSERT INTO outbox_event (event_seq, idempotency_key, payload, status, source, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
      [seq, key, JSON.stringify(payload), 'pending', 'e2e', Date.now(), Date.now()])
    return Number(tx.all('SELECT id FROM outbox_event WHERE idempotency_key = ?', [key])[0]?.id || 0)
  })
  const kMismatchBase = {
    type: 'transfer', oldAssignmentId: kOldAssignmentId, fromSales: SALES_NAME, reason: 'e2e 身份不符',
    actor: `system:${SUPERVISOR_NAME}`,
    lead: { leadId: kLeadId, name: '升级兼容线索', contactType: 'phone', contactNormalized: K_PHONE, source: 'e2e', note: '' }
  }
  const kCrossRowId = insertKFixture(kSeq + 2, 'transfer:e2e-cross-lead',
    { ...kMismatchBase, leadId: kLeadId2, assignmentId: kNewAssignmentId, toSales: SALES2_NAME })
  const kTargetRowId = insertKFixture(kSeq + 3, 'transfer:e2e-target-mismatch',
    { ...kMismatchBase, leadId: kLeadId, assignmentId: kNewAssignmentId, toSales: SALES_NAME })
  const kDownBeforeMismatch = store.downEventCount()
  resetCapture()
  const kMismatchRun = await service.runCentralSyncOnce()
  const kMismatchStatus = (rowId: number) => String(crmDbService.all('SELECT status FROM outbox_event WHERE id = ?', [rowId])[0]?.status)
  ok('K9 前置：第二条线索真实存在且 id 不同（否则跨线索断言是空断言）',
    kImported2.valid === 1 && kLeadId2 > 0 && kLeadId2 !== kLeadId, JSON.stringify({ kLeadId, kLeadId2 }))
  ok('K10 载荷与 assignment 行矛盾（跨线索 / 跨目标销售）：不猜值、不发送，两行都终态 failed，中央一条都没收到',
    kMismatchRun.error === undefined && kMismatchRun.rejected === 2 &&
    kMismatchStatus(kCrossRowId) === 'failed' && kMismatchStatus(kTargetRowId) === 'failed' &&
    store.downEventCount() === kDownBeforeMismatch &&
    commandBodies().filter((e) => e.eventType === 'transfer').length === 0,
    JSON.stringify({ run: kMismatchRun, s1: kMismatchStatus(kCrossRowId), s2: kMismatchStatus(kTargetRowId) }))
  const kMismatchAudits = crmDbService.all(
    "SELECT * FROM audit_event WHERE action = 'sync_outbox_failed' ORDER BY id DESC LIMIT 2").reverse()
  const kReasons = kMismatchAudits.map((a) => String((JSON.parse(String(a.detail || '{}')) as Record<string, unknown>).reason))
  ok('K11 两条审计各自带**专属的**一致性错误码（跨线索 / 跨目标销售不共用同一个笼统码）',
    kReasons.join() === 'legacy_transfer_lead_mismatch,legacy_transfer_target_mismatch' && ackOf(String(kCrossRowId)) === '',
    JSON.stringify(kReasons))
  ok('K12 审计仍只带行号 + 类型 + 稳定错误码：不含联系方式 / 线索资料 / 销售姓名',
    kMismatchAudits.every((a) => Object.keys(JSON.parse(String(a.detail || '{}')) as Record<string, unknown>).sort().join() === 'commandType,reason') &&
    !JSON.stringify(kMismatchAudits).includes(K_PHONE) && !JSON.stringify(kMismatchAudits).includes(K_PHONE2) &&
    !JSON.stringify(kMismatchAudits).includes('升级兼容线索') && !JSON.stringify(kMismatchAudits).includes(SALES2_NAME),
    JSON.stringify(kMismatchAudits))

  // 恢复本机绑定（本机 = 主管工作机），避免改变后续任何前置状态
  bindAs(supervisor, 'supervisor')
  crmDbService.setScanState('centralSync:pullCursor', supervisorCursor)
  ConfigService.getInstance().set('centralSyncDisplayName', supervisorBinding.displayName)

  await app.close()
  console.log(`\ncentral sync e2e test: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exitCode = 1
}

void main()
