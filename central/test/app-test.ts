/**
 * 中央 HTTP 契约测试。跑在 **MemoryCentralStore** 上（Fastify 路由、权限、校验、幂等都是真实实现）。
 *
 * 覆盖：health/ready、bootstrap、邀请码一次性、令牌只存哈希、令牌轮换、自助解绑、
 *       管理员吊销（含畸形标识不落库）、五角色权限矩阵、工作区隔离、推送幂等、批内单事件失败隔离、
 *       拉取目标过滤、ack applied/conflict/invalid/retry、retry 可重拉、非 retry 不再重拉、
 *       递归禁字段拒绝 + 策略违规审计、上行命名空间与载荷引用闸门（§三）、
 *       下行指令校验与 lead 字段白名单（§二）、中央操作审计（§四）、
 *       Postgres 审计路径的源码级契约断言（§四/§五）。
 *
 * 边界：**没有真实 PostgreSQL**。因此
 *   - 内存实现通过，不等于 PostgresCentralStore 的 SQL 行为通过；
 *   - PG 侧只由 P7/P8 的源码级断言锁住「同事务 / 只在首次写入 / SQL 参数化 / 不记载荷」四条纪律，
 *     DDL 约束、并发与事务隔离、`$n::uuid` 的运行时行为**均未验证**。
 *
 * 用法：cd central && npm test
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
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

// entityId 必须指向**具体的本机一行**：有类别还不够，冒号后要有非空白行号。
// 判定与上行引用闸门同源（shared/centralSync.isConcreteRef），不新造第三个解析器。
const kEmptyId = await postCommand({ entityId: scoped('assignment:') }, 'empty-id')
check('K7 entityId 只有类别没有行号（`assignment:`）→ 400 entity_id_not_concrete',
  kEmptyId.statusCode === 400 && String(kEmptyId.json().message).includes('entity_id_not_concrete'),
  String(kEmptyId.payload))
const kBlankId = await postCommand({ entityId: `${sales.principal.deviceId}/assignment:   ` }, 'blank-id')
check('K7b entityId 冒号后全空白 → 400 entity_id_not_concrete（空白行号等价的空引用，不得蒙混）',
  kBlankId.statusCode === 400 && String(kBlankId.json().message).includes('entity_id_not_concrete'),
  String(kBlankId.payload))
const kBareAssignment = await postCommand({ entityId: 'assignment:1' }, 'bare-assignment')
check('K8 entityId 缺设备命名空间（裸 `assignment:1`）→ 400 entity_id_not_scoped',
  kBareAssignment.statusCode === 400 && String(kBareAssignment.json().message).includes('entity_id_not_scoped'),
  String(kBareAssignment.payload))
const kNonStringId = await postCommand({ entityId: 12345 as unknown as string }, 'non-string-id')
check('K9 entityId 不是字符串 → 400（不是 PostgreSQL 500，也不按值猜引用）',
  kNonStringId.statusCode === 400 && String(kNonStringId.json().message).includes('entity_id_not_scoped'),
  String(kNonStringId.payload))
// 合法形态仍然放行：K2 / C2 已覆盖 scoped('assignment:1')，这里补一条显式的正例锚点
const kConcreteOk = await postCommand({ entityId: scoped('assignment:1') }, 'concrete-ok')
check('K10 完整具体引用（设备命名空间 + 类别 + 行号）→ 201（收紧不误伤既有合法引用）',
  kConcreteOk.statusCode === 201, String(kConcreteOk.payload))

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
check('K23 版本前置时间戳非正数 → 400（稳定拒收码 invalid_timestamp:recycledAt）',
  slaZeroTimestamp.statusCode === 400 && String(slaZeroTimestamp.json().message).includes('invalid_timestamp:recycledAt'),
  String(slaZeroTimestamp.payload))

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

console.log('═══ M. 下行 lead 白名单：中央 HTTP 只接受 6 个字段（§二）═══')
/** 全新设备对，避免与 H 段的令牌轮换/吊销互相影响 */
const guardSup = await onboard(wsA, 'G001', 'supervisor', '护栏主管')
const guardSales = await onboard(wsA, 'G002', 'sales', '护栏销售')
const guardDeviceId = guardSales.principal.deviceId
const lead6 = { leadId: 41, name: '护栏线索', contactType: 'phone', contactNormalized: '13800001111', source: '巡检', note: '备注' }
/** 只让 lead 子对象逐项变体的 assign 指令；顶层字段与注册表对齐，隔离出「lead 白名单」这一条规则 */
const postAssignWithLead = (suffix: string, lead: unknown) => app.inject({
  method: 'POST', url: '/api/v1/sync/commands', headers: authOf(guardSup.token),
  payload: {
    ...downCommand, eventId: `m-${suffix}`, idempotencyKey: `m-${suffix}`, eventType: 'assign',
    entityId: scoped('assignment:1', guardDeviceId), targetEmployeeId: guardSales.principal.employeeId,
    payload: { type: 'assign', deliveryRole: 'apply', leadId: 41, assignmentId: 1, salesName: '护栏销售', lead }
  }
})
const mOk = await postAssignWithLead('ok', lead6)
check('M1 6 字段 lead（含 contactNormalized）被受理 → 201：下行如实携带 contactNormalized，不假装比实际更严',
  mOk.statusCode === 201 && mOk.json().data.duplicate === false, String(mOk.payload))
const mBefore = { down: store.downEventCount(), audits: store.auditActions().length, projections: store.projectionRows().length }
const mRaw = await postAssignWithLead('raw', { ...lead6, contactRaw: '13800001111' })
check('M2 lead 携带 contactRaw → 400 unknown_lead_field:contactRaw（原始联系号不得走中央下行）',
  mRaw.statusCode === 400 && String(mRaw.json().message).includes('unknown_lead_field:contactRaw'), String(mRaw.payload))
const mWechat = await postAssignWithLead('wechat', { ...lead6, wechat: 'wxid_guard' })
check('M3 lead 携带 wechat → 400 unknown_lead_field:wechat',
  mWechat.statusCode === 400 && String(mWechat.json().message).includes('unknown_lead_field:wechat'), String(mWechat.payload))
const mUnknownLead = await postAssignWithLead('unknown-lead', { ...lead6, extraNote: '未登记' })
check('M4 lead 未登记字段 → 400 unknown_lead_field:extraNote',
  mUnknownLead.statusCode === 400 && String(mUnknownLead.json().message).includes('unknown_lead_field:extraNote'))
const mBadLeadId = await postAssignWithLead('bad-lead-id', { ...lead6, leadId: '41' })
check('M5 lead.leadId 非正整数 → 400 invalid_lead_field:leadId',
  mBadLeadId.statusCode === 400 && String(mBadLeadId.json().message).includes('invalid_lead_field:leadId'))
const mBadContactType = await postAssignWithLead('bad-contact-type', { ...lead6, contactType: 'telegram' })
check('M6 lead.contactType 不在本机枚举（phone/wechat/both）→ 400 invalid_lead_field:contactType',
  mBadContactType.statusCode === 400 && String(mBadContactType.json().message).includes('invalid_lead_field:contactType'))
const mLongName = await postAssignWithLead('long-name', { ...lead6, name: '长'.repeat(121) })
check('M7 lead.name 超长 → 400 too_long_lead_field:name',
  mLongName.statusCode === 400 && String(mLongName.json().message).includes('too_long_lead_field:name'))
const mLeadNotObject = await postAssignWithLead('lead-not-object', '不是对象')
check('M8 lead 非对象 → 400 invalid_lead',
  mLeadNotObject.statusCode === 400 && String(mLeadNotObject.json().message).includes('invalid_lead'))

// ── 建档契约（2026-09-15）：中央 assign/transfer 的 lead 必须能安全建档 ──
// 只带 leadId 会让接收端 createLeadFromInfoTx 以空 contact_normalized 建档，
// 破坏身份定位并可能撞 UNIQUE(contact_type, contact_normalized)——建档字段在服务端就拒收。
const mLeadOnlyId = await postAssignWithLead('lead-only-id', { leadId: 41 })
check('M11 lead 只有 leadId → 400（缺建档身份字段，绝不允许空身份建档）',
  mLeadOnlyId.statusCode === 400 && String(mLeadOnlyId.json().message).includes('missing_lead_field:'), String(mLeadOnlyId.payload))
const mNoContactType = await postAssignWithLead('no-contact-type', { ...lead6, contactType: undefined })
check('M12 lead 缺 contactType → 400 missing_lead_field:contactType',
  mNoContactType.statusCode === 400 && String(mNoContactType.json().message).includes('missing_lead_field:contactType'))
const mNoContactNorm = await postAssignWithLead('no-contact-norm', { ...lead6, contactNormalized: undefined })
check('M13 lead 缺 contactNormalized → 400 missing_lead_field:contactNormalized',
  mNoContactNorm.statusCode === 400 && String(mNoContactNorm.json().message).includes('missing_lead_field:contactNormalized'))
const mEmptyContactNorm = await postAssignWithLead('empty-contact-norm', { ...lead6, contactNormalized: '  ' })
check('M14 lead.contactNormalized 空白串 → 400（空身份不能建档）',
  mEmptyContactNorm.statusCode === 400 && String(mEmptyContactNorm.json().message).includes('missing_lead_field:contactNormalized'))
const mNoNote = await postAssignWithLead('no-note', { ...lead6, note: undefined })
check('M15 固定 6 字段缺一即拒：lead 缺 note → 400（允许空串但必须存在）',
  mNoNote.statusCode === 400 && String(mNoNote.json().message).includes('missing_lead_field:note'))
const mMismatch = await postAssignWithLead('id-mismatch', { ...lead6, leadId: 42 })
check('M16 顶层 leadId 与 lead.leadId 不一致 → 400 lead_id_mismatch（禁止按其中一个猜）',
  mMismatch.statusCode === 400 && String(mMismatch.json().message).includes('lead_id_mismatch'))
// 被拒指令不消耗幂等键：先用缺建档字段的 lead 拒收一次（同 key 修正后的受理正例在 M10 无痕断言之后，见 M22）
const mReuseKey = 'm-recover-after-invalid'
const mReuseBad = await app.inject({ method: 'POST', url: '/api/v1/sync/commands', headers: authOf(guardSup.token),
  payload: { ...downCommand, eventId: 'm-reuse-bad', idempotencyKey: mReuseKey, eventType: 'assign',
    entityId: scoped('assignment:1', guardDeviceId), targetEmployeeId: guardSales.principal.employeeId,
    payload: { type: 'assign', deliveryRole: 'apply', leadId: 41, assignmentId: 1, salesName: '护栏销售', lead: { leadId: 41 } } } })
check('M17 建档字段缺失的 assign → 400（不消耗幂等键，修正后同 key 受理见 M22）', mReuseBad.statusCode === 400)

// transfer 的 SLA 纪律：sla1Deadline/mode 是移交事实产生时确定的值，必填且必须是有限正整数
const postTransfer = (suffix: string, payload: Record<string, unknown>) => app.inject({
  method: 'POST', url: '/api/v1/sync/commands', headers: authOf(guardSup.token),
  payload: { ...downCommand, eventId: `m-t-${suffix}`, idempotencyKey: `m-t-${suffix}`, eventType: 'transfer',
    entityId: scoped('assignment:2', guardDeviceId), targetEmployeeId: guardSales.principal.employeeId, payload }
})
const transferBase = { type: 'transfer', deliveryRole: 'apply', leadId: 41, assignmentId: 2, oldAssignmentId: 1,
  fromSales: '护栏主管', toSales: '护栏销售', mode: 'manual', sla1Deadline: Date.now() + 86_400_000, lead: lead6 }
const mTransferNoSla = await postTransfer('no-sla', { ...transferBase, sla1Deadline: undefined })
check('M19 transfer 缺 sla1Deadline → 400 missing_field（不在接收端重算 SLA）',
  mTransferNoSla.statusCode === 400 && String(mTransferNoSla.json().message).includes('missing_field:sla1Deadline'))
const mTransferStrSla = await postTransfer('str-sla', { ...transferBase, sla1Deadline: '1758000000000' })
check('M20 transfer 的 sla1Deadline 是字符串数字 → 400（必须 number 类型正整数）',
  mTransferStrSla.statusCode === 400 && String(mTransferStrSla.json().message).includes('invalid_timestamp:sla1Deadline'),
  String(mTransferStrSla.payload))
const mTransferNoMode = await postTransfer('no-mode', { ...transferBase, mode: undefined })
check('M21 transfer 缺 mode → 400 missing_field:mode',
  mTransferNoMode.statusCode === 400 && String(mTransferNoMode.json().message).includes('missing_field:mode'))

// recycle 的白名单里没有 lead，携带即按「未登记字段」整事件拒收（错误码带字段名、不带值）。
// 无论走哪条分支，结论一致：recycle 不携带 lead —— 「recycle 必带 6 字段」的旧口径不成立。
const mRecycleLead = await postCommand({ eventId: 'm-recycle-lead', idempotencyKey: 'm-recycle-lead',
  payload: { type: 'recycle', deliveryRole: 'apply', leadId: 1, assignmentId: 1, salesName: '张三', lead: lead6 } }, 'recycle-lead')
check('M9 指令类型不允许 lead（recycle）→ 400 且拒收原因指向 lead 字段（「recycle 必带 6 字段」的旧口径不成立）',
  mRecycleLead.statusCode === 400 &&
  ['unknown_field:lead', 'unexpected_lead'].some((code) => String(mRecycleLead.json().message).includes(code)),
  String(mRecycleLead.payload))
check('M10 以上被拒的下行载荷不留 sync_event / 投影 / 审计（中央拒收即在库内无痕）',
  store.downEventCount() === mBefore.down && store.projectionRows().length === mBefore.projections &&
  store.auditActions().length === mBefore.audits,
  JSON.stringify([mBefore, store.downEventCount(), store.projectionRows().length, store.auditActions().length]))

// 无痕断言之后的正例：被拒收不消耗幂等键，修正后同 key 受理；合法 transfer（含 SLA/mode）受理
const mReuseGood = await app.inject({ method: 'POST', url: '/api/v1/sync/commands', headers: authOf(guardSup.token),
  payload: { ...downCommand, eventId: 'm-reuse-good', idempotencyKey: mReuseKey, eventType: 'assign',
    entityId: scoped('assignment:1', guardDeviceId), targetEmployeeId: guardSales.principal.employeeId,
    payload: { type: 'assign', deliveryRole: 'apply', leadId: 41, assignmentId: 1, salesName: '护栏销售', lead: lead6 } } })
check('M22 建档拒收不消耗幂等键（同 key 修正后 → 201 受理）',
  mReuseGood.statusCode === 201 && mReuseGood.json().data.duplicate === false, String(mReuseGood.payload))
const mTransferOk = await postTransfer('ok', transferBase)
check('M23 合法 transfer（sla1Deadline 有限正整数 + mode + 6 字段 lead）→ 201',
  mTransferOk.statusCode === 201, String(mTransferOk.payload))

// mode 的出现即必须是**枚举内的字符串字面量**：绝不 String(value) 再比对——`{}`/`[]`/`1`/`true`
// 都会被 String() 变成一个「看起来合法」的字符串，把非法载荷放进接收端业务状态机。
// 枚举唯一源 = shared/centralDownCommand.ASSIGNMENT_MODES。
const mModeLegal = await Promise.all(['manual', 'weight', 'round_robin', 'load']
  .map((m) => postTransfer(`mode-legal-${m}`, { ...transferBase, mode: m })))
check('M24 mode 四个合法取值（manual / weight / round_robin / load）全部受理 → 201',
  mModeLegal.every((r) => r.statusCode === 201), JSON.stringify(mModeLegal.map((r) => [r.statusCode, r.payload])))
// 快照取在「合法取值已被受理」之后：只度量非法载荷这一批是否零写入、零幂等标记
const mEnumBefore = { down: store.downEventCount(), projections: store.projectionRows().length, audits: store.auditActions().length }
const MODE_ILLEGAL: Array<[string, unknown, string]> = [
  ['object', {}, 'invalid_enum:mode'],
  ['array', [], 'invalid_enum:mode'],
  ['number', 1, 'invalid_enum:mode'],
  ['boolean', true, 'invalid_enum:mode'],
  // 空串在 transfer 上先被「必填字段不得为空」拦下（assign 上 mode 可选，空串由枚举拦下，见 M27）
  ['empty', '', 'missing_field:mode'],
  ['unknown', 'teleport', 'invalid_enum:mode'],
  // 数字转字符串后才合法：`String(1)` 不合法，但 `'1'` 是合法字符串形态的未知值 → 仍拒
  ['numeric-string', '1', 'invalid_enum:mode']
]
const mModeIllegal = await Promise.all(MODE_ILLEGAL.map(([name, value]) => postTransfer(`mode-bad-${name}`, { ...transferBase, mode: value })))
check('M25 mode 非法形态（对象/数组/数字/布尔/空串/未知串/数字串）全部 400，且错误码只带字段名不带值',
  mModeIllegal.every((r, i) => r.statusCode === 400 &&
    String(r.json().message).includes(MODE_ILLEGAL[i]![2]) &&
    !String(r.json().message).includes('teleport') && !String(r.json().message).includes('mode=')),
  JSON.stringify(mModeIllegal.map((r) => [r.statusCode, r.payload])))
check('M26 mode 被拒的事件零业务写入、零幂等标记（无效载荷进不了任何状态机）',
  store.downEventCount() === mEnumBefore.down && store.projectionRows().length === mEnumBefore.projections &&
  store.auditActions().length === mEnumBefore.audits,
  JSON.stringify([mEnumBefore, store.downEventCount(), store.projectionRows().length, store.auditActions().length]))
// assign 的 mode 是可选字段：缺省合法；出现则同样必须合法（空串 ≠ 未设置）
const postAssignMode = (suffix: string, mode: unknown) => app.inject({
  method: 'POST', url: '/api/v1/sync/commands', headers: authOf(guardSup.token),
  payload: { ...downCommand, eventId: `m-am-${suffix}`, idempotencyKey: `m-am-${suffix}`, eventType: 'assign',
    entityId: scoped('assignment:1', guardDeviceId), targetEmployeeId: guardSales.principal.employeeId,
    payload: { type: 'assign', deliveryRole: 'apply', leadId: 41, assignmentId: 1, salesName: '护栏销售', lead: lead6, mode } }
})
const mAssignNoMode = await postAssignMode('absent', undefined)
check('M27a assign 省略 mode 合法（可选字段：缺省即未设置，不等于发了空串）', mAssignNoMode.statusCode === 201,
  String(mAssignNoMode.payload))
const mAssignEmptyMode = await postAssignMode('empty', '')
check('M27b assign 发空串 mode → 400 invalid_enum:mode（发送方应省略，而不是让接收端各自兜底）',
  mAssignEmptyMode.statusCode === 400 && String(mAssignEmptyMode.json().message).includes('invalid_enum:mode'),
  String(mAssignEmptyMode.payload))
const mAssignObjectMode = await postAssignMode('object', {})
check('M27c assign 的 mode 给对象 → 400 invalid_enum:mode（不被 String({}) 蒙混过关）',
  mAssignObjectMode.statusCode === 400 && String(mAssignObjectMode.json().message).includes('invalid_enum:mode'),
  String(mAssignObjectMode.payload))


console.log('═══ N. 上行载荷引用闸门：类别 / 命名空间 / 形态（§三）═══')
const guardPush = (idem: string, events: CentralSyncEvent[]) => pushAs(authOf(guardSales.token), idem, events)
/** 引用闸门用例统一用 customer 事件：customerRef 是注册表里的登记字段，闸门先于投影校验生效 */
const refEvent = (suffix: string, ref: unknown) => upEvent({
  eventId: `n-${suffix}`, idempotencyKey: `n-${suffix}`, entityType: 'customer',
  entityId: scoped(`customer:n-${suffix}`, guardDeviceId), payload: { displayName: '引用闸门客户', customerRef: ref }
})
const refCode = (res: { json: () => { data: { rejected: Array<{ code: string }> } } }): string =>
  String(res.json().data.rejected[0]?.code || '')
const nOk = await guardPush('n-ok', [refEvent('ok', scoped('customer:1', guardDeviceId))])
check('N1 合规的 `*Ref` 引用（本机命名空间 + 类别相符 + 完整行号）→ 受理', nOk.json().data.accepted.length === 1)
const nBare = await guardPush('n-bare', [refEvent('bare', 'customer:1')])
check('N2 裸引用（缺设备命名空间）→ 拒收 ref_not_scoped:customerRef', refCode(nBare) === 'ref_not_scoped:customerRef')
const nForeign = await guardPush('n-foreign', [refEvent('foreign', scoped('customer:1', bSales.principal.deviceId))])
check('N3 引用借用他机命名空间 → 拒收 ref_not_owned:customerRef（同工作区内也不行）',
  refCode(nForeign) === 'ref_not_owned:customerRef', refCode(nForeign))
const nKind = await guardPush('n-kind', [refEvent('kind', scoped('lead:1', guardDeviceId))])
check('N4 引用类别与字段语义不符（customerRef 指向 lead）→ 拒收 ref_kind_mismatch:customerRef',
  refCode(nKind) === 'ref_kind_mismatch:customerRef')
const nType = await guardPush('n-type', [refEvent('type', 123)])
check('N5 引用不是字符串 → 拒收 ref_invalid_type:customerRef', refCode(nType) === 'ref_invalid_type:customerRef')
const nConcrete = await guardPush('n-concrete', [refEvent('concrete', `${guardDeviceId}/customer:`)])
check('N6 引用缺具体行号 → 拒收 ref_not_concrete:customerRef', refCode(nConcrete) === 'ref_not_concrete:customerRef')
/** 权限行里的 employeeRef 是身份声明（显示名/工号），不是本机行号——不得为了形态统一而篡改其语义 */
const permEvent = (suffix: string, ref: unknown) => upEvent({
  eventId: `n-${suffix}`, idempotencyKey: `n-${suffix}`, entityType: 'permission',
  entityId: scoped('permission:1', guardSup.principal.deviceId),
  payload: { employeeRef: ref, declaredRole: 'sales', authoritySource: 'local_declaration' }
})
const nDecl = await pushAs(authOf(guardSup.token), 'n-decl', [permEvent('decl', 'S001')])
check('N7 身份声明型 employeeRef（裸工号）放行', nDecl.json().data.accepted.length === 1)
const nDeclForeign = await pushAs(authOf(guardSup.token), 'n-decl-foreign',
  [permEvent('decl-foreign', scoped('employee:1', bSales.principal.deviceId))])
check('N8 employeeRef 写成他机命名空间引用 → 拒收 ref_not_owned:employeeRef',
  refCode(nDeclForeign) === 'ref_not_owned:employeeRef', refCode(nDeclForeign))
const nMixed = await guardPush('n-mixed', [refEvent('mixed-bad', 'customer:1'), refEvent('mixed-good', scoped('customer:2', guardDeviceId))])
check('N9 同批一坏一好：坏的分条拒收并带稳定码，好的照常受理（不整批连坐）',
  nMixed.json().data.rejected.length === 1 && nMixed.json().data.accepted.length === 1 &&
  refCode(nMixed) === 'ref_not_scoped:customerRef')
check('N10 被拒事件不留投影（好的那条照常落库）',
  store.projectionRow('customer', scoped('customer:n-mixed-bad', guardDeviceId)) === undefined &&
  store.projectionRow('customer', scoped('customer:n-mixed-good', guardDeviceId)) !== undefined)
const nReuse = await guardPush('n-bare', [refEvent('bare', scoped('customer:1', guardDeviceId))])
check('N11 被拒事件不消耗幂等键（修正后同 key 仍可受理）', nReuse.json().data.accepted[0]?.duplicate === false)

console.log('═══ O. 中央操作审计：签发与指令留痕、重放不追加、拒收不留痕（§四）═══')
const oInviteBefore = store.auditActions().filter((a) => a.action === 'invite_create').length
const oInvite = await app.inject({ method: 'POST', url: '/api/v1/bindings/invitations', headers: authOf(admin.token),
  payload: { workspaceId: wsA, employeeCode: 'AUD01', displayName: '审计用例', role: 'sales' } })
const oInviteCode = String(oInvite.json().data.inviteCode || '')
const oNewInvites = store.auditActions().filter((a) => a.action === 'invite_create').slice(oInviteBefore)
check('O1 邀请码签发恰好留一条 invite_create 审计，且只记 employeeId / role（不记邀请码明文与哈希）',
  oNewInvites.length === 1 && oNewInvites[0]!.entityType === 'binding_invite' &&
  oNewInvites[0]!.entityId === String(oInvite.json().data.inviteId) &&
  typeof oNewInvites[0]!.detail.employeeId === 'string' && oNewInvites[0]!.detail.role === 'sales' &&
  !JSON.stringify(oNewInvites).includes(oInviteCode) && !JSON.stringify(oNewInvites).includes(secretHash(oInviteCode)),
  JSON.stringify(oNewInvites))

const oBeforeCommandAudits = store.auditActions().filter((a) => a.action === 'down_command').length
const oCmd = await postAssignWithLead('audit-first', lead6)
const oAuditsAfterFirst = store.auditActions().filter((a) => a.action === 'down_command')
check('O2 下行指令首次受理留一条 down_command 审计（只记定位元数据，不记载荷）',
  oCmd.statusCode === 201 && oAuditsAfterFirst.length === oBeforeCommandAudits + 1 &&
  oAuditsAfterFirst[oAuditsAfterFirst.length - 1]!.detail.eventType === 'assign' &&
  !JSON.stringify(oAuditsAfterFirst[oAuditsAfterFirst.length - 1]).includes('13800001111'),
  JSON.stringify(oAuditsAfterFirst.slice(-1)))
const oReplay = await postAssignWithLead('audit-first', lead6)
check('O3 同幂等键重放判 duplicate，且不追加审计（审计不随重放增长）',
  oReplay.json().data.duplicate === true &&
  store.auditActions().filter((a) => a.action === 'down_command').length === oAuditsAfterFirst.length)
const oRejectBefore = store.auditActions().length
await postAssignWithLead('audit-rejected', { ...lead6, contactRaw: '13800001111' })
check('O4 被拒指令不产生任何审计（拒收即无痕）', store.auditActions().length === oRejectBefore)
const oAuditDump = JSON.stringify(store.auditActions())
check('O5 审计流里不出现邀请码明文 / 设备令牌 / 线索联系方式',
  !oAuditDump.includes(oInviteCode) && !oAuditDump.includes(guardSales.token) && !oAuditDump.includes('13800001111') &&
  !oAuditDump.includes(secretHash(oInviteCode)), oAuditDump.slice(0, 300))

console.log('═══ P. 吊销入参护栏与 Postgres 审计路径契约（§五 / §四）═══')
const pAuditsBefore = store.auditActions().length
const pMalformed = await app.inject({ method: 'POST', url: '/api/v1/devices/not-a-uuid/revoke',
  headers: authOf(admin.token), payload: {} })
check('P1 畸形设备标识 → 400 E101（不是 PostgreSQL 22P02 冒出来的 500）',
  pMalformed.statusCode === 400 && pMalformed.json().code === 'E101', String(pMalformed.payload))
check('P2 非法标识绝不碰数据库：不产生任何吊销审计', store.auditActions().length === pAuditsBefore)
const pUnknown = await app.inject({ method: 'POST', url: `/api/v1/devices/${randomUUID()}/revoke`,
  headers: authOf(admin.token), payload: {} })
check('P3 合法 UUID 但不存在 → 200 revoked=false（可重入、不报错）',
  pUnknown.statusCode === 200 && pUnknown.json().data.revoked === false)
const pNoWorkspace = await app.inject({ method: 'POST', url: `/api/v1/devices/${guardSales.principal.deviceId}/revoke`,
  headers: adminAuth, payload: {} })
check('P4 bootstrap-admin 无工作区上下文吊销 → 400 E101（不得静默跨工作区吊销）',
  pNoWorkspace.statusCode === 400 && pNoWorkspace.json().code === 'E101', String(pNoWorkspace.payload))
const pBadWorkspace = await app.inject({ method: 'POST', url: `/api/v1/devices/${guardSales.principal.deviceId}/revoke`,
  headers: adminAuth, payload: { workspaceId: 'not-a-uuid' } })
check('P5 bootstrap-admin 传畸形 workspaceId → 400 E101（同样不落库）',
  pBadWorkspace.statusCode === 400 && pBadWorkspace.json().code === 'E101')
const pSacrifice = await onboard(wsA, 'G003', 'sales', '待吊销销售')
const pExplicit = await app.inject({ method: 'POST', url: `/api/v1/devices/${pSacrifice.principal.deviceId}/revoke`,
  headers: adminAuth, payload: { workspaceId: wsA } })
check('P6 bootstrap-admin 指定合法工作区 + 合法设备 → 吊销成功并留审计',
  pExplicit.statusCode === 200 && pExplicit.json().data.revoked === true &&
  store.auditActions().some((a) => a.action === 'device_revoke' && a.entityId === pSacrifice.principal.deviceId))

/**
 * PostgresCentralStore 的审计路径**无法**在没有真实 PostgreSQL 的测试里执行。
 * 这里做源码级契约断言，只锁住「同事务 / 只在首次写入 / 参数化 / 不记载荷」四条纪律；
 * 不用「MemoryStore 通过 ⇒ Postgres 也通过」做等价推理（§六：内存实现不得替代真实库的验证）。
 */
const pgStoreSrc = readFileSync(new URL('../src/postgresStore.ts', import.meta.url), 'utf8')
const sliceBetween = (start: string, end: string): string => {
  const from = pgStoreSrc.indexOf(start)
  const to = pgStoreSrc.indexOf(end, from)
  return from < 0 || to < 0 ? '' : pgStoreSrc.slice(from, to)
}
/** 模板字符串里的 SQL 语句（用于断言「SQL 全参数化」；非 SQL 的模板串如 `device:${id}` 不在此列） */
const sqlLiterals = (span: string): string[] =>
  (span.match(/`[^`]*`/g) ?? []).filter((literal) => /\b(INSERT|UPDATE|SELECT|DELETE)\b/.test(literal))
const sqlParameterized = (span: string): boolean =>
  sqlLiterals(span).length > 0 && sqlLiterals(span).every((sql) => !sql.includes('${'))
const pgInvite = sliceBetween('async createInvite', 'async claimInvite')
check('P7 Postgres createInvite：邀请码写入与 invite_create 审计在同一次 BEGIN/COMMIT 内，且 SQL 全参数化',
  pgInvite.includes('BEGIN') && pgInvite.indexOf('binding_invite') < pgInvite.indexOf("'invite_create'") &&
  pgInvite.indexOf("'invite_create'") < pgInvite.indexOf('COMMIT') && pgInvite.includes('ROLLBACK') &&
  pgInvite.includes('to_timestamp($4 / 1000.0)') && sqlParameterized(pgInvite),
  pgInvite.length ? sqlLiterals(pgInvite).join(' | ') : '未定位到 createInvite')
const pgDown = sliceBetween('async appendDownEvent', 'CONFLICT_CODES')
check('P8 Postgres appendDownEvent：审计只在首次写入追加（duplicate 不追加）、同事务、参数化且不记载荷',
  pgDown.includes('if (!result.duplicate)') && pgDown.includes('BEGIN') &&
  pgDown.indexOf('if (!result.duplicate)') < pgDown.indexOf("'down_command'") &&
  pgDown.indexOf("'down_command'") < pgDown.indexOf('COMMIT') && !pgDown.includes('event.payload') &&
  sqlParameterized(pgDown), pgDown.length ? sqlLiterals(pgDown).join(' | ') : '未定位到 appendDownEvent')

await app.close()
console.log(`\ncentral app test: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
