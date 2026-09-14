/**
 * 中央 HTTP 契约测试（内存 store 实现，与 PostgresCentralStore 同款语义）。
 *
 * 覆盖：health/ready、bootstrap、邀请码一次性、令牌只存哈希、令牌轮换、自助解绑、
 *       管理员吊销、五角色权限矩阵、工作区隔离、推送幂等、批内单事件失败隔离、
 *       拉取目标过滤、ack applied/conflict/invalid/retry、retry 可重拉、非 retry 不再重拉、
 *       递归禁字段拒绝 + 策略违规审计、审计生成。
 *
 * 用法：cd central && npm test
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { buildCentralApp } from '../src/app.js'
import { MemoryCentralStore } from '../src/memoryStore.js'
import { secretHash } from '../src/crypto.js'
import type { CentralSyncEvent } from '../../shared/centralSync.js'
import type { DevicePrincipal } from '../src/store.js'

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; console.log(`  ✅ ${name}`) } else { fail++; console.log(`  ❌ ${name} ${detail}`) }
}

const adminToken = 'admin-token-that-is-longer-than-thirty-two-characters'
const config = { host: '127.0.0.1', port: 8787, databaseUrl: 'memory://', adminToken, tlsTerminated: true, logLevel: 'silent' }
const store = new MemoryCentralStore()
const app = buildCentralApp({ store, config })

const wsA = randomUUID()
const wsB = randomUUID()
const adminAuth = { authorization: `Bearer ${adminToken}` }

/** 走完整的「管理员发邀请码 → 设备认领」流程，返回设备凭证与 principal。 */
interface Onboarded {
  token: string
  principal: { employeeId: string; deviceId: string; workspaceId: string; displayName: string; role: string }
}

async function onboard(workspaceId: string, employeeCode: string, role: string,
  displayName = `${role}-${employeeCode}`): Promise<Onboarded> {
  const invite = await app.inject({ method: 'POST', url: '/api/v1/bindings/invitations', headers: adminAuth,
    payload: { workspaceId, employeeCode, displayName, role } })
  assert.equal(invite.statusCode, 201, `invite ${employeeCode}`)
  const claim = await app.inject({ method: 'POST', url: '/api/v1/bindings/claim',
    payload: { inviteCode: invite.json().data.inviteCode, deviceName: `${employeeCode}-机器` } })
  assert.equal(claim.statusCode, 201, `claim ${employeeCode}`)
  return { token: claim.json().data.deviceToken, principal: claim.json().data.principal }
}

/** 把 onboard 拿到的 principal 当作 DevicePrincipal 传给 store（直连 store 的越权用例要用） */
function asPrincipal(row: Onboarded): DevicePrincipal {
  return { workspaceId: row.principal.workspaceId, employeeId: row.principal.employeeId,
    deviceId: row.principal.deviceId, displayName: row.principal.displayName,
    role: row.principal.role as DevicePrincipal['role'] }
}

function upEvent(overrides: Partial<CentralSyncEvent> & Pick<CentralSyncEvent, 'eventId' | 'idempotencyKey'>): CentralSyncEvent {
  return {
    protocolVersion: 1, eventSeq: 1, direction: 'up', entityType: 'customer', entityId: scoped('customer:1'),
    eventType: 'customer_confirmed', aggregateVersion: 1, payload: { displayName: '已脱敏客户' },
    occurredAt: Date.now(), ...overrides
  } as CentralSyncEvent
}

console.log('═══ A. health / ready / bootstrap ═══')
const health = await app.inject({ method: 'GET', url: '/health' })
check('A1 health 返回 200 且带协议版本', health.statusCode === 200 && health.json().data.protocolVersion === 1)
const ready = await app.inject({ method: 'GET', url: '/ready' })
check('A2 ready 返回 200（数据库就绪）', ready.statusCode === 200 && ready.json().data.database === 'ready')
check('A3 无凭证访问业务端点 → 401', (await app.inject({ method: 'GET', url: '/api/v1/sync/pull' })).statusCode === 401)
check('A4 bootstrap-admin 令牌可创建邀请码', (await app.inject({ method: 'POST', url: '/api/v1/bindings/invitations', headers: adminAuth,
  payload: { workspaceId: wsA, employeeCode: 'X', displayName: 'X', role: 'sales' } })).statusCode === 201)

console.log('═══ B. 绑定：一次性 / 令牌哈希 ═══')
const sales = await onboard(wsA, 'S001', 'sales')
const reused = await app.inject({ method: 'POST', url: '/api/v1/bindings/claim', payload: { inviteCode: 'A'.repeat(40), deviceName: '重放机' } })
check('B1 已用/无效邀请码不能再次认领 → 409', reused.statusCode === 409)
check('B2 令牌以 sha256 哈希留存，明文不落库',
  store.deviceTokenHash(sales.principal.deviceId) === secretHash(sales.token) && store.deviceTokenHash(sales.principal.deviceId) !== sales.token)
check('B3 明文令牌不出现在任何 store 行里', !store.dumpForLeakCheck().includes(sales.token))

/**
 * §二.2：上行 entityId 必须是「设备命名空间/localRef」形态。
 * 裸 localRef 会被服务端拒收，因此夹具一律用真设备 id 构造，不再用 `cust-1` 这类假引用。
 */
const scoped = (localRef: string, deviceId: string = sales.principal.deviceId) => `${deviceId}/${localRef}`

const salesAuth = { authorization: `Bearer ${sales.token}` }
check('B4 设备凭证可访问业务端点', (await app.inject({ method: 'GET', url: '/api/v1/sync/pull', headers: salesAuth })).statusCode === 200)

console.log('═══ C. 五角色权限矩阵 ═══')
const supervisor = await onboard(wsA, 'M001', 'supervisor')
const allocator = await onboard(wsA, 'D001', 'allocator')
const admin = await onboard(wsA, 'A001', 'admin')
const service = await onboard(wsA, 'SVC01', 'service')
const authOf = (t: string) => ({ authorization: `Bearer ${t}` })
/**
 * 合法下行指令夹具：回收 sales 设备上的 assignment:1。
 * 旧夹具用 customer 实体 + 投影形态载荷，属于「把指令当投影推」的错误形态，已按 §七.2 契约修正。
 */
const downCommand = upEvent({
  eventId: 'down-cmd', idempotencyKey: 'down-cmd', direction: 'down',
  entityType: 'assignment', entityId: scoped('assignment:1'), eventType: 'recycle', aggregateVersion: 1,
  payload: { type: 'recycle', deliveryRole: 'apply', leadId: 1, assignmentId: 1, salesName: '张三', reason: '主管回收' },
  targetEmployeeId: sales.principal.employeeId
})

check('C1 销售无权下发指令 → 403', (await app.inject({ method: 'POST', url: '/api/v1/sync/commands', headers: salesAuth, payload: downCommand })).statusCode === 403)
check('C2 主管可下发指令 → 201', (await app.inject({ method: 'POST', url: '/api/v1/sync/commands', headers: authOf(supervisor.token), payload: { ...downCommand, eventId: 'd1', idempotencyKey: 'd1' } })).statusCode === 201)
check('C3 分配员可下发指令 → 201', (await app.inject({ method: 'POST', url: '/api/v1/sync/commands', headers: authOf(allocator.token), payload: { ...downCommand, eventId: 'd2', idempotencyKey: 'd2' } })).statusCode === 201)
check('C4 管理员可下发指令 → 201', (await app.inject({ method: 'POST', url: '/api/v1/sync/commands', headers: authOf(admin.token), payload: { ...downCommand, eventId: 'd3', idempotencyKey: 'd3' } })).statusCode === 201)
check('C5 销售无权创建邀请码 → 403', (await app.inject({ method: 'POST', url: '/api/v1/bindings/invitations', headers: salesAuth,
  payload: { workspaceId: wsA, employeeCode: 'Y', displayName: 'Y', role: 'sales' } })).statusCode === 403)
check('C6 主管无权创建邀请码 → 403（账号/密钥归管理员）', (await app.inject({ method: 'POST', url: '/api/v1/bindings/invitations', headers: authOf(supervisor.token),
  payload: { workspaceId: wsA, employeeCode: 'Y', displayName: 'Y', role: 'sales' } })).statusCode === 403)
check('C7 管理员可创建邀请码 → 201', (await app.inject({ method: 'POST', url: '/api/v1/bindings/invitations', headers: authOf(admin.token),
  payload: { workspaceId: wsA, employeeCode: 'Y', displayName: 'Y', role: 'sales' } })).statusCode === 201)
check('C8 销售无权吊销他人设备 → 403', (await app.inject({ method: 'POST', url: `/api/v1/devices/${supervisor.principal.deviceId}/revoke`, headers: salesAuth, payload: {} })).statusCode === 403)
check('C9 service 账号只读：可 pull', (await app.inject({ method: 'GET', url: '/api/v1/sync/pull', headers: authOf(service.token) })).statusCode === 200)
check('C10 service 账号不可 push → 403（AI 服务账号不推业务事件）',
  (await app.inject({ method: 'POST', url: '/api/v1/sync/push', headers: { ...authOf(service.token), 'idempotency-key': 'svc' },
    payload: { events: [upEvent({ eventId: 'svc-1', idempotencyKey: 'svc-1' })] } })).statusCode === 403)
check('C11 service 账号不可下发指令 → 403', (await app.inject({ method: 'POST', url: '/api/v1/sync/commands', headers: authOf(service.token), payload: { ...downCommand, eventId: 'd4', idempotencyKey: 'd4' } })).statusCode === 403)
check('C12 service 账号不可创建邀请码 → 403', (await app.inject({ method: 'POST', url: '/api/v1/bindings/invitations', headers: authOf(service.token),
  payload: { workspaceId: wsA, employeeCode: 'Z', displayName: 'Z', role: 'sales' } })).statusCode === 403)

console.log('═══ D. 推送：幂等 / 批内隔离 / 禁字段 ═══')
const first = await app.inject({ method: 'POST', url: '/api/v1/sync/push', headers: { ...salesAuth, 'idempotency-key': 'batch-1' },
  payload: { events: [upEvent({ eventId: 'e1', idempotencyKey: 'customer:1:v1' })] } })
check('D1 首次推送被接受且非重复', first.statusCode === 200 && first.json().data.accepted[0].duplicate === false)
const replay = await app.inject({ method: 'POST', url: '/api/v1/sync/push', headers: { ...salesAuth, 'idempotency-key': 'batch-1-retry' },
  payload: { events: [upEvent({ eventId: 'e1', idempotencyKey: 'customer:1:v1' })] } })
check('D2 同 idempotencyKey 重放 → duplicate=true 且不新建业务记录', replay.json().data.accepted[0].duplicate === true)
check('D3 显式投影落库（customer.display_name）', store.projectionRow('customer', scoped('customer:1'))?.payload.displayName === '已脱敏客户')
check('D4 缺 Idempotency-Key → 400', (await app.inject({ method: 'POST', url: '/api/v1/sync/push', headers: salesAuth,
  payload: { events: [upEvent({ eventId: 'e2', idempotencyKey: 'k2' })] } })).statusCode === 400)

const mixed = await app.inject({ method: 'POST', url: '/api/v1/sync/push', headers: { ...salesAuth, 'idempotency-key': 'batch-mixed' },
  payload: { events: [
    upEvent({ eventId: 'good-1', idempotencyKey: 'good-1', entityId: scoped('customer:good'), aggregateVersion: 1 }),
    upEvent({ eventId: 'bad-1', idempotencyKey: 'bad-1', entityId: scoped('customer:bad'), payload: {} }),
    upEvent({ eventId: 'good-2', idempotencyKey: 'good-2', entityId: scoped('customer:good2'), aggregateVersion: 1 })
  ] } })
const mixedData = mixed.json().data
check('D5 批内单条失败不影响同批其它有效事件（2 收 1 拒）',
  mixedData.accepted.length === 2 && mixedData.rejected.length === 1 &&
  mixedData.accepted.map((a: { eventId: string }) => a.eventId).sort().join(',') === 'good-1,good-2')
check('D6 被拒事件给出明确原因（缺必填字段）', String(mixedData.rejected[0].message).includes('missing_required'))
const unknownField = await app.inject({ method: 'POST', url: '/api/v1/sync/push', headers: { ...salesAuth, 'idempotency-key': 'batch-unknown' },
  payload: { events: [upEvent({ eventId: 'unk-1', idempotencyKey: 'unk-1', entityId: scoped('customer:unk'),
    payload: { displayName: 'X', extraNote: '未登记字段' } })] } })
check('D12 未登记字段 → 拒收 unknown_field（严格白名单，服务端不留未知字段）',
  String(unknownField.json().data.rejected[0]?.message).startsWith('unknown_field'))
check('D7 被拒事件不落投影', store.projectionRow('customer', scoped('customer:bad')) === undefined && store.projectionRow('customer', scoped('customer:good2')) !== undefined)

const nested = await app.inject({ method: 'POST', url: '/api/v1/sync/push', headers: { ...salesAuth, 'idempotency-key': 'batch-leak' },
  payload: { events: [upEvent({ eventId: 'leak-1', idempotencyKey: 'leak-1', entityId: scoped('customer:leak'),
    payload: { displayName: 'X', nested: { deep: { chatContent: '禁止上行' } } } })] } })
check('D8 递归命中禁字段 → 该事件被拒', nested.json().data.rejected[0]?.code === 'forbidden_field')
check('D9 违规留痕生成中央审计', store.auditActions().some((a) => a.action === 'sync_forbidden_field' && a.entityId === 'leak-1'))
check('D10 禁字段事件不落投影', store.projectionRow('customer', scoped('customer:leak')) === undefined)
const sessionLeak = await app.inject({ method: 'POST', url: '/api/v1/sync/push', headers: { ...salesAuth, 'idempotency-key': 'batch-leak2' },
  payload: { events: [upEvent({ eventId: 'leak-2', idempotencyKey: 'leak-2', entityId: scoped('customer:leak2'),
    payload: { displayName: 'X', wcdb_path: '/Users/x/db' } })] } })
check('D11 wcdb_path / session_id 同属禁字段', sessionLeak.json().data.rejected[0]?.code === 'forbidden_field')

console.log('═══ E. 版本闸门 ═══')
await app.inject({ method: 'POST', url: '/api/v1/sync/push', headers: { ...salesAuth, 'idempotency-key': 'ver-1' },
  payload: { events: [upEvent({ eventId: 'v1', idempotencyKey: 'ver:v1', entityId: scoped('customer:ver'), aggregateVersion: 2, payload: { displayName: '新' } })] } })
await app.inject({ method: 'POST', url: '/api/v1/sync/push', headers: { ...salesAuth, 'idempotency-key': 'ver-2' },
  payload: { events: [upEvent({ eventId: 'v2', idempotencyKey: 'ver:v2', entityId: scoped('customer:ver'), aggregateVersion: 1, payload: { displayName: '旧' } })] } })
check('E1 低版本事件不覆盖高版本投影', store.projectionRow('customer', scoped('customer:ver'))?.payload.displayName === '新')

console.log('═══ F. 拉取目标过滤 / ack 语义 ═══')
const pullA = await app.inject({ method: 'GET', url: '/api/v1/sync/pull?cursor=0', headers: salesAuth })
const downEvents = pullA.json().data.events
check('F1 只拉到本设备的 down 事件（上行事件不回流）', downEvents.length > 0 && downEvents.every((e: CentralSyncEvent) => e.direction === 'down'))
const firstDown = downEvents[0]
check('F2 销售读不到未指向自己的指令', downEvents.every((e: CentralSyncEvent) => !e.targetEmployeeId || e.targetEmployeeId === sales.principal.employeeId))

const retryAck = await app.inject({ method: 'POST', url: '/api/v1/sync/ack', headers: salesAuth,
  payload: { acknowledgements: [{ centralSeq: firstDown.centralSeq, eventId: firstDown.eventId, outcome: 'retry', detail: '本机缺少依赖对象' }] } })
check('F3 retry 回执被记录', retryAck.json().data.acknowledged === 1)
check('F4 retry 事件仍可被重拉（不会被吞掉）',
  (await app.inject({ method: 'GET', url: `/api/v1/sync/pull?cursor=${firstDown.centralSeq - 1}`, headers: salesAuth }))
    .json().data.events.some((e: { centralSeq: number }) => e.centralSeq === firstDown.centralSeq))
check('F5 retry 累计重试次数 +1', store.attemptsFor(sales.principal.deviceId, firstDown.centralSeq) === 1)

const appliedAck = await app.inject({ method: 'POST', url: '/api/v1/sync/ack', headers: salesAuth,
  payload: { acknowledgements: [{ centralSeq: firstDown.centralSeq, eventId: firstDown.eventId, outcome: 'applied', localVersion: 1 }] } })
check('F6 applied 回执被记录', appliedAck.json().data.acknowledged === 1)
check('F7 终态事件不再被重拉',
  !(await app.inject({ method: 'GET', url: `/api/v1/sync/pull?cursor=${firstDown.centralSeq - 1}`, headers: salesAuth }))
    .json().data.events.some((e: { centralSeq: number }) => e.centralSeq === firstDown.centralSeq))

const secondDown = downEvents[1]
await app.inject({ method: 'POST', url: '/api/v1/sync/ack', headers: salesAuth,
  payload: { acknowledgements: [{ centralSeq: secondDown.centralSeq, eventId: secondDown.eventId, outcome: 'invalid', detail: '本机不支持该指令' }] } })
check('F8 invalid 终态同样不再被重拉（避免无限重试）',
  !(await app.inject({ method: 'GET', url: '/api/v1/sync/pull?cursor=0&limit=200', headers: salesAuth }))
    .json().data.events.some((e: { centralSeq: number }) => e.centralSeq === secondDown.centralSeq))
const ackMismatch = await app.inject({ method: 'POST', url: '/api/v1/sync/ack', headers: salesAuth,
  payload: { acknowledgements: [{ centralSeq: 999999, eventId: 'nope', outcome: 'applied' }] } })
check('F9 不存在的 centralSeq 不产生回执（ack 幂等且不改他人状态）', ackMismatch.json().data.acknowledged === 0)

console.log('═══ G. 工作区隔离 ═══')
const bAdmin = await onboard(wsB, 'AB01', 'admin')
const bSales = await onboard(wsB, 'SB01', 'sales')
const crossCommand = await app.inject({ method: 'POST', url: '/api/v1/sync/commands', headers: authOf(admin.token),
  payload: { ...downCommand, eventId: 'cross-1', idempotencyKey: 'cross-1', targetEmployeeId: bSales.principal.employeeId } })
check('G1 不能向其它工作区的员工下发指令 → 403', crossCommand.statusCode === 403)
const crossRevoke = await app.inject({ method: 'POST', url: `/api/v1/devices/${bSales.principal.deviceId}/revoke`, headers: authOf(admin.token), payload: {} })
check('G2 不能吊销其它工作区的设备', crossRevoke.statusCode === 200 && crossRevoke.json().data.revoked === false)
const bPull = await app.inject({ method: 'GET', url: '/api/v1/sync/pull?cursor=0&limit=200', headers: authOf(bSales.token) })
check('G3 工作区 B 的设备拉不到工作区 A 的任何事件', bPull.json().data.events.length === 0)
const bPush = await app.inject({ method: 'POST', url: '/api/v1/sync/push', headers: { ...authOf(bSales.token), 'idempotency-key': 'b-1' },
  payload: { events: [upEvent({ eventId: 'b-e1', idempotencyKey: 'b-e1', entityId: scoped('customer:b', bSales.principal.deviceId), payload: { displayName: 'B 客户' } })] } })
check('G4 同 idempotencyKey 空间按工作区隔离（A 已用不代表 B 冲突）', bPush.json().data.accepted.length === 1)
const aSame = await app.inject({ method: 'POST', url: '/api/v1/sync/push', headers: { ...salesAuth, 'idempotency-key': 'a-1' },
  payload: { events: [upEvent({ eventId: 'a-e1', idempotencyKey: 'b-e1', entityId: scoped('customer:a-same'), payload: { displayName: 'A 客户' } })] } })
check('G5 跨工作区同 key 不互相判重', aSame.json().data.accepted[0]?.duplicate === false)
const wsMismatchInvite = await app.inject({ method: 'POST', url: '/api/v1/bindings/invitations', headers: authOf(admin.token),
  payload: { workspaceId: wsB, employeeCode: 'HACK', displayName: 'HACK', role: 'admin' } })
check('G6 管理员不能为其它工作区签发邀请码 → 403', wsMismatchInvite.statusCode === 403)

console.log('═══ I. 上行命名空间 / 角色边界 / 越权闸门（§二.2 §二.3 §二.5 §二.7）═══')
const pushAs = (auth: Record<string, string>, idem: string, events: CentralSyncEvent[]) =>
  app.inject({ method: 'POST', url: '/api/v1/sync/push', headers: { ...auth, 'idempotency-key': idem }, payload: { events } })

const foreignRef = scoped('customer:foreign', bSales.principal.deviceId)
const foreignPush = await pushAs(salesAuth, 'own-1', [upEvent({ eventId: 'own-1', idempotencyKey: 'own-1', entityId: foreignRef })])
check('I1 上行 entityId 借用他机前缀 → 拒收 entity_id_not_owned', foreignPush.json().data.rejected[0]?.code === 'entity_id_not_owned')
check('I2 越权事件不留任何投影', store.projectionRow('customer', foreignRef) === undefined)

const barePush = await pushAs(salesAuth, 'own-2', [upEvent({ eventId: 'own-2', idempotencyKey: 'own-2', entityId: 'customer:bare' })])
check('I3 裸 localRef（无设备命名空间）→ 拒收', barePush.json().data.rejected[0]?.code === 'entity_id_not_owned')

const ownershipPush = await pushAs(salesAuth, 'own-3', [upEvent({ eventId: 'own-3', idempotencyKey: 'own-3',
  entityType: 'ownership', entityId: scoped('account:1'), payload: { customerRef: scoped('customer:1'), ownerSales: '张三' } })])
check('I4 sales 上传 ownership 投影 → 拒收 role_not_allowed_entity:ownership',
  ownershipPush.json().data.rejected[0]?.code === 'role_not_allowed_entity:ownership')
const permissionPush = await pushAs(salesAuth, 'own-4', [upEvent({ eventId: 'own-4', idempotencyKey: 'own-4',
  entityType: 'permission', entityId: scoped('permission:1'), payload: { employeeRef: 'S001', declaredRole: 'sales' } })])
check('I5 sales 上传 permission 投影 → 拒收（权限声明不由销售设备产生）',
  permissionPush.json().data.rejected[0]?.code === 'role_not_allowed_entity:permission')

const assignRef = scoped('assignment:9')
const assignPayload = { customerRef: scoped('customer:1'), leadRef: scoped('lead:9'), salesName: '张三', status: 'assigned' }
const assignV1 = await pushAs(salesAuth, 'own-5', [upEvent({ eventId: 'own-5', idempotencyKey: 'assign:9:v1',
  entityType: 'assignment', entityId: assignRef, aggregateVersion: 1, payload: assignPayload })])
check('I6 sales 上传本职投影（assignment）→ 接受', assignV1.json().data.accepted.length === 1)
const assignV2 = await pushAs(salesAuth, 'own-6', [upEvent({ eventId: 'own-6', idempotencyKey: 'assign:9:v2',
  entityType: 'assignment', entityId: assignRef, aggregateVersion: 2, payload: { ...assignPayload, status: 'claimed' } })])
check('I7 同设备更高版本正常更新投影', assignV2.json().data.accepted.length === 1 &&
  store.projectionRow('assignment', assignRef)?.payload.status === 'claimed')

// §二.3：既有投影只能被原设备更新。HTTP 层的 I1 已挡住伪造前缀，这里直连 store 验证兜底闸门本身。
const crossWrite = await store.pushEvents(asPrincipal(supervisor), [upEvent({ eventId: 'x-1', idempotencyKey: 'assign:9:v3',
  entityType: 'assignment', entityId: assignRef, aggregateVersion: 9, payload: { ...assignPayload, status: 'recycled' } })])
check('I8 他机设备改写既有投影 → 拒收 cross_device_conflict', crossWrite.rejected[0]?.code === 'cross_device_conflict')
check('I9 更高 aggregateVersion 也不能跨设备覆盖',
  store.projectionRow('assignment', assignRef)?.payload.status === 'claimed' &&
  store.projectionRow('assignment', assignRef)?.sourceDeviceId === sales.principal.deviceId)
check('I10 跨设备冲突留痕（只记码与引用，不记客户数据）',
  store.conflictRecords().some((r) => r.code === 'cross_device_conflict' && r.entityId === assignRef))

// §二.4：同一身份锚点只能指向一个客户；冲突留记录 + 拒收，绝不静默归并或另立第二真源。
const identityPayload = { identityType: 'phone', identityHash: 'h'.repeat(64), identityMasked: '138****0000',
  customerRef: scoped('customer:1'), source: 'lead_import' }
const idA = scoped('identity:1')
await pushAs(salesAuth, 'own-7', [upEvent({ eventId: 'own-7', idempotencyKey: 'identity:1:v1',
  entityType: 'customer_identity', entityId: idA, payload: identityPayload })])
const idB = scoped('identity:2')
const idClash = await pushAs(salesAuth, 'own-8', [upEvent({ eventId: 'own-8', idempotencyKey: 'identity:2:v1',
  entityType: 'customer_identity', entityId: idB, payload: { ...identityPayload, customerRef: scoped('customer:2') } })])
check('I11 同身份锚点指向第二个客户 → 拒收 identity_anchor_conflict', idClash.json().data.rejected[0]?.code === 'identity_anchor_conflict')
check('I12 身份冲突不静默改写既有投影（未新建第二条真源）',
  store.projectionRow('customer_identity', idB) === undefined &&
  store.projectionRow('customer_identity', idA)?.payload.customerRef === scoped('customer:1'))
check('I13 身份冲突留痕待人工仲裁', store.conflictRecords().some((r) => r.code === 'identity_anchor_conflict'))

// §二.7：bootstrap-admin 是运维身份，不带工作区上下文，不得调用常规同步接口
check('I14 bootstrap-admin 调 push → 400（不以空 workspaceId 绕过隔离）',
  (await pushAs(adminAuth, 'boot-1', [upEvent({ eventId: 'boot-1', idempotencyKey: 'boot-1' })])).statusCode === 400)
check('I15 bootstrap-admin 调 pull → 400',
  (await app.inject({ method: 'GET', url: '/api/v1/sync/pull', headers: adminAuth })).statusCode === 400)
check('I16 bootstrap-admin 调 ack → 400',
  (await app.inject({ method: 'POST', url: '/api/v1/sync/ack', headers: adminAuth,
    payload: { acknowledgements: [{ centralSeq: 1, eventId: 'x', outcome: 'applied' }] } })).statusCode === 400)

console.log('═══ J. 员工目录 / 身份解析契约（§三.5）═══')
const dirAdmin = await app.inject({ method: 'GET', url: '/api/v1/directory/employees', headers: authOf(admin.token) })
const dirRows = dirAdmin.json().data.employees as Array<{ employeeCode: string; displayName: string; nameUnique: boolean }>
check('J1 管理员可读员工目录', dirAdmin.statusCode === 200 && dirRows.length > 0)
check('J2 目录给出稳定 employeeCode 与唯一性标记',
  dirRows.some((e) => e.employeeCode === 'S001' && e.nameUnique === true) &&
  dirRows.every((e) => typeof e.employeeCode === 'string' && e.employeeCode.length > 0 && typeof e.nameUnique === 'boolean'))
check('J3 sales 可读目录（SLA1 升级通知由销售设备产生，必须能解析主管）',
  (await app.inject({ method: 'GET', url: '/api/v1/directory/employees', headers: salesAuth })).statusCode === 200)
check('J3b service（AI 只读账号）无 directory.read → 403',
  (await app.inject({ method: 'GET', url: '/api/v1/directory/employees', headers: authOf(service.token) })).statusCode === 403)
// 重名：同名两条都标 nameUnique=false，解析方必须显式报错而不是任选一个
await onboard(wsA, 'DUP1', 'sales', '重名销售')
await onboard(wsA, 'DUP2', 'sales', '重名销售')
const dirAgain = (await app.inject({ method: 'GET', url: '/api/v1/directory/employees', headers: authOf(admin.token) }))
  .json().data.employees as Array<{ employeeCode: string; nameUnique: boolean }>
check('J4 同工作区同名员工 → nameUnique=false（禁止按显示名猜人）',
  dirAgain.filter((e) => e.employeeCode.startsWith('DUP')).every((e) => e.nameUnique === false))

console.log('═══ K. 下行指令校验（§七）═══')
const cmdAuth = authOf(supervisor.token)
const postCommand = (overrides: Partial<CentralSyncEvent>, suffix: string) => app.inject({
  method: 'POST', url: '/api/v1/sync/commands', headers: cmdAuth,
  payload: { ...downCommand, eventId: `k-${suffix}`, idempotencyKey: `k-${suffix}`, ...overrides }
})
const pay = (extra: Record<string, unknown>) => ({ ...downCommand.payload, ...extra })

const kUnknown = await postCommand({ eventType: 'teleport' }, 'unknown-type')
check('K1 未登记的下行事件类型 → 400（错误码只带类型名，不带值）',
  kUnknown.statusCode === 400 && String(kUnknown.json().message).includes('unknown_down_event_type'))
const kMismatch = await postCommand({ eventType: 'recycle', entityType: 'customer', entityId: scoped('customer:1') }, 'type-mismatch')
check('K2 eventType 与 entityType 不一致 → 400（服务端拒收，不按 payload 猜意图）',
  kMismatch.statusCode === 400 && String(kMismatch.json().message).includes('entity_type_mismatch'))
const kKindMismatch = await postCommand({ entityId: scoped('customer:1') }, 'kind-mismatch')
check('K3 entityId 类别与 entityType 不符 → 400',
  kKindMismatch.statusCode === 400 && String(kKindMismatch.json().message).includes('entity_id_kind_mismatch'))
const kUpDirection = await postCommand({ direction: 'up' }, 'up-direction')
check('K4 非 direction=down 的指令 → 400', kUpDirection.statusCode === 400)

const kBadEmployee = await postCommand({ targetEmployeeId: 'not-a-uuid' }, 'bad-employee')
check('K5 非法 targetEmployeeId → 400（不是 PostgreSQL 500）', kBadEmployee.statusCode === 400)
const kBadDevice = await postCommand({ targetDeviceId: 'not-a-uuid' }, 'bad-device')
check('K6 非法 targetDeviceId → 400（不是 PostgreSQL 500）', kBadDevice.statusCode === 400)

const kCrossPair = await postCommand({ targetDeviceId: supervisor.principal.deviceId,
  targetEmployeeId: sales.principal.employeeId }, 'cross-pair')
check('K7 目标设备与目标员工不属同一员工 → 400',
  kCrossPair.statusCode === 400 && String(kCrossPair.json().message).includes('不属于同一员工'))
const kSamePair = await postCommand({ targetDeviceId: sales.principal.deviceId,
  targetEmployeeId: sales.principal.employeeId }, 'same-pair')
check('K8 目标设备与目标员工同属一人 → 201', kSamePair.statusCode === 201)

const kBadRole = await postCommand({ payload: pay({ deliveryRole: 'notify' }) }, 'bad-role')
check('K9 投递角色不被该指令类型允许 → 400',
  kBadRole.statusCode === 400 && String(kBadRole.json().message).includes('delivery_role_not_allowed'))
const kNoRole = await postCommand({ payload: pay({ deliveryRole: '' }) }, 'no-role')
check('K10 deliveryRole 缺失 → 400', kNoRole.statusCode === 400)
const kEmptyName = await postCommand({ payload: pay({ salesName: '   ' }) }, 'empty-name')
check('K11 salesName 为空串 → 400（空目标不得当作有效投递）',
  kEmptyName.statusCode === 400 && String(kEmptyName.json().message).includes('missing_field:salesName'))
const kUnknownField = await postCommand({ payload: pay({ extraNote: '未登记' }) }, 'unknown-field')
check('K12 未登记字段 → 400（严格白名单）',
  kUnknownField.statusCode === 400 && String(kUnknownField.json().message).includes('unknown_field:extraNote'))
const kChatLeak = await postCommand({ payload: pay({ chatContent: '不许出机的聊天正文' }) }, 'chat-leak')
check('K13 指令载荷夹带聊天正文 → 400（下行也只允许掩码联系方式）',
  kChatLeak.statusCode === 400 && kChatLeak.json().code === 'E102')
const kTooLong = await postCommand({ payload: pay({ reason: '原'.repeat(300) }) }, 'too-long')
check('K14 超长字段 → 400', kTooLong.statusCode === 400)

// §七.8：非法指令不得在中央留下 lead / assignment / notify / audit / 幂等 痕迹
const downBefore = store.downEventCount()
const projectionBefore = store.projectionRows().length
const auditBefore = store.auditActions().length
const reuseKey = 'k-recover-after-invalid'
await app.inject({ method: 'POST', url: '/api/v1/sync/commands', headers: cmdAuth,
  payload: { ...downCommand, eventId: 'k-invalid-reuse', idempotencyKey: reuseKey, payload: pay({ salesName: '' }) } })
check('K15 非法指令不落库、不建投影、不留审计',
  store.downEventCount() === downBefore && store.projectionRows().length === projectionBefore &&
  store.auditActions().length === auditBefore)
const reuseOk = await app.inject({ method: 'POST', url: '/api/v1/sync/commands', headers: cmdAuth,
  payload: { ...downCommand, eventId: 'k-valid-reuse', idempotencyKey: reuseKey } })
check('K16 非法指令不消耗幂等键（同 key 的合法指令仍可受理）',
  reuseOk.statusCode === 201 && reuseOk.json().data.duplicate === false)

const dup = await app.inject({ method: 'POST', url: '/api/v1/sync/commands', headers: cmdAuth,
  payload: { ...downCommand, eventId: 'd1', idempotencyKey: 'd1' } })
check('K17 同 eventId+幂等键重复下发 → duplicate=true（指令可重放不可重复执行）',
  dup.statusCode === 201 && dup.json().data.duplicate === true)
const keyClash = await app.inject({ method: 'POST', url: '/api/v1/sync/commands', headers: cmdAuth,
  payload: { ...downCommand, eventId: 'k-different-id', idempotencyKey: 'd1' } })
check('K18 同幂等键换 eventId → 409（拒绝语义漂移）', keyClash.statusCode === 409)

const correction = await postCommand({ eventType: 'supervisor_correction', entityId: scoped('assignment:1'),
  payload: { type: 'supervisor_correction', deliveryRole: 'apply', leadId: 1, assignmentId: 1, title: '主管纠正', summary: '口径修正' } }, 'correction')
check('K19 supervisor_correction 在册且可下发 → 201', correction.statusCode === 201)
const permissionChange = await postCommand({ eventType: 'permission_change', entityType: 'permission',
  entityId: scoped('permission:1'),
  payload: { type: 'permission_change', deliveryRole: 'apply', employeeRef: 'S001', declaredRole: 'sales' } }, 'permission')
check('K20 permission_change 在册且可下发 → 201', permissionChange.statusCode === 201)
const slaNotify = await postCommand({ eventType: 'sla1_escalate_supervisor',
  payload: { type: 'sla1_escalate_supervisor', deliveryRole: 'notify', leadId: 1, assignmentId: 1, salesName: '张三', remindCount: 3, recycledAt: Date.now() } }, 'sla1')
check('K21 sla1_escalate_supervisor 在册且可下发 → 201', slaNotify.statusCode === 201)
const slaNoTimestamp = await postCommand({ eventType: 'sla1_escalate_supervisor',
  payload: { type: 'sla1_escalate_supervisor', deliveryRole: 'notify', leadId: 1, assignmentId: 1, salesName: '张三', remindCount: 3 } }, 'sla1-no-ts')
check('K22 缺版本前置时间戳字段 → 400（缺字段先于取值判定）', slaNoTimestamp.statusCode === 400 &&
  String(slaNoTimestamp.json().message).includes('missing_field:recycledAt'))
const slaZeroTimestamp = await postCommand({ eventType: 'sla1_escalate_supervisor',
  payload: { type: 'sla1_escalate_supervisor', deliveryRole: 'notify', leadId: 1, assignmentId: 1, salesName: '张三', remindCount: 3, recycledAt: 0 } }, 'sla1-zero-ts')
check('K23 版本前置时间戳非正数 → 400 invalid_timestamp', slaZeroTimestamp.statusCode === 400 &&
  String(slaZeroTimestamp.json().message).includes('invalid_timestamp:recycledAt'))

console.log('═══ H. 令牌轮换 / 自助解绑 / 管理员吊销 ═══')
const rotated = await app.inject({ method: 'POST', url: '/api/v1/devices/rotate', headers: salesAuth })
check('H1 旧令牌轮换后立即失效', rotated.statusCode === 200 &&
  (await app.inject({ method: 'GET', url: '/api/v1/sync/pull', headers: salesAuth })).statusCode === 401)
const newSalesToken = rotated.json().data.deviceToken as string
const newSalesAuth = { authorization: `Bearer ${newSalesToken}` }
check('H2 新令牌可用', (await app.inject({ method: 'GET', url: '/api/v1/sync/pull', headers: newSalesAuth })).statusCode === 200)
check('H3 轮换后仍只存哈希', store.deviceTokenHash(sales.principal.deviceId) === secretHash(newSalesToken))

const selfRevoke = await app.inject({ method: 'POST', url: '/api/v1/devices/revoke-self', headers: newSalesAuth })
check('H4 自助解绑返回 revoked=true', selfRevoke.statusCode === 200 && selfRevoke.json().data.revoked === true)
check('H5 自助解绑后本机令牌立即失效', (await app.inject({ method: 'GET', url: '/api/v1/sync/pull', headers: newSalesAuth })).statusCode === 401)
check('H6 自助解绑生成审计', store.auditActions().some((a) => a.action === 'device_revoke_self' && a.entityId === sales.principal.deviceId))

const adminRevoke = await app.inject({ method: 'POST', url: `/api/v1/devices/${allocator.principal.deviceId}/revoke`, headers: authOf(admin.token), payload: {} })
check('H7 管理员可吊销本工作区设备', adminRevoke.json().data.revoked === true &&
  (await app.inject({ method: 'GET', url: '/api/v1/sync/pull', headers: authOf(allocator.token) })).statusCode === 401)
check('H8 管理员吊销生成审计', store.auditActions().some((a) => a.action === 'device_revoke' && a.entityId === allocator.principal.deviceId))

console.log('═══ L. 调用方畸形请求不冒充服务端故障（§七.5 同类）═══')
// 带 body 却不带 content-type：Fastify 抛 FST_ERR_CTP_INVALID_MEDIA_TYPE(415)。
// 若被统一吞成 500，会把调用方错误记成「中央服务内部错误」，污染服务端告警。
const noContentType = await app.inject({ method: 'POST', url: '/api/v1/bindings/claim',
  payload: JSON.stringify({ inviteCode: 'A'.repeat(40), deviceName: '无类型机' }) })
check('L1 缺 content-type 的请求体 → 415，不是 500', noContentType.statusCode === 415 &&
  noContentType.json().code === 'E400', `${noContentType.statusCode} ${noContentType.payload}`)
const shortInvite = await app.inject({ method: 'POST', url: '/api/v1/bindings/claim', payload: { inviteCode: 'short', deviceName: 'x' } })
check('L2 邀请码长度不合规 → 400 E101（schema 校验，非 500）',
  shortInvite.statusCode === 400 && shortInvite.json().code === 'E101')

await app.close()
console.log(`\ncentral app test: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
