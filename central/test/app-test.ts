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
async function onboard(workspaceId: string, employeeCode: string, role: string): Promise<{ token: string; principal: { employeeId: string; deviceId: string } }> {
  const invite = await app.inject({ method: 'POST', url: '/api/v1/bindings/invitations', headers: adminAuth,
    payload: { workspaceId, employeeCode, displayName: `${role}-${employeeCode}`, role } })
  assert.equal(invite.statusCode, 201, `invite ${employeeCode}`)
  const claim = await app.inject({ method: 'POST', url: '/api/v1/bindings/claim',
    payload: { inviteCode: invite.json().data.inviteCode, deviceName: `${employeeCode}-机器` } })
  assert.equal(claim.statusCode, 201, `claim ${employeeCode}`)
  return { token: claim.json().data.deviceToken, principal: claim.json().data.principal }
}

function upEvent(overrides: Partial<CentralSyncEvent> & Pick<CentralSyncEvent, 'eventId' | 'idempotencyKey'>): CentralSyncEvent {
  return {
    protocolVersion: 1, eventSeq: 1, direction: 'up', entityType: 'customer', entityId: 'cust-1',
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

const salesAuth = { authorization: `Bearer ${sales.token}` }
check('B4 设备凭证可访问业务端点', (await app.inject({ method: 'GET', url: '/api/v1/sync/pull', headers: salesAuth })).statusCode === 200)

console.log('═══ C. 五角色权限矩阵 ═══')
const supervisor = await onboard(wsA, 'M001', 'supervisor')
const allocator = await onboard(wsA, 'D001', 'allocator')
const admin = await onboard(wsA, 'A001', 'admin')
const service = await onboard(wsA, 'SVC01', 'service')
const authOf = (t: string) => ({ authorization: `Bearer ${t}` })
const downCommand = upEvent({ eventId: 'down-cmd', idempotencyKey: 'down-cmd', direction: 'down', targetEmployeeId: sales.principal.employeeId })

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
check('D3 显式投影落库（customer.display_name）', store.projectionRow('customer', 'cust-1')?.payload.displayName === '已脱敏客户')
check('D4 缺 Idempotency-Key → 400', (await app.inject({ method: 'POST', url: '/api/v1/sync/push', headers: salesAuth,
  payload: { events: [upEvent({ eventId: 'e2', idempotencyKey: 'k2' })] } })).statusCode === 400)

const mixed = await app.inject({ method: 'POST', url: '/api/v1/sync/push', headers: { ...salesAuth, 'idempotency-key': 'batch-mixed' },
  payload: { events: [
    upEvent({ eventId: 'good-1', idempotencyKey: 'good-1', entityId: 'cust-good', aggregateVersion: 1 }),
    upEvent({ eventId: 'bad-1', idempotencyKey: 'bad-1', entityId: 'cust-bad', payload: { note: '缺 displayName 必填字段' } }),
    upEvent({ eventId: 'good-2', idempotencyKey: 'good-2', entityId: 'cust-good2', aggregateVersion: 1 })
  ] } })
const mixedData = mixed.json().data
check('D5 批内单条失败不影响同批其它有效事件（2 收 1 拒）',
  mixedData.accepted.length === 2 && mixedData.rejected.length === 1 &&
  mixedData.accepted.map((a: { eventId: string }) => a.eventId).sort().join(',') === 'good-1,good-2')
check('D6 被拒事件给出明确原因（缺必填字段）', String(mixedData.rejected[0].message).includes('missing_required'))
check('D7 被拒事件不落投影', store.projectionRow('customer', 'cust-bad') === undefined && store.projectionRow('customer', 'cust-good2') !== undefined)

const nested = await app.inject({ method: 'POST', url: '/api/v1/sync/push', headers: { ...salesAuth, 'idempotency-key': 'batch-leak' },
  payload: { events: [upEvent({ eventId: 'leak-1', idempotencyKey: 'leak-1', entityId: 'cust-leak',
    payload: { displayName: 'X', nested: { deep: { chatContent: '禁止上行' } } } })] } })
check('D8 递归命中禁字段 → 该事件被拒', nested.json().data.rejected[0]?.code === 'forbidden_field')
check('D9 违规留痕生成中央审计', store.auditActions().some((a) => a.action === 'sync_forbidden_field' && a.entityId === 'leak-1'))
check('D10 禁字段事件不落投影', store.projectionRow('customer', 'cust-leak') === undefined)
const sessionLeak = await app.inject({ method: 'POST', url: '/api/v1/sync/push', headers: { ...salesAuth, 'idempotency-key': 'batch-leak2' },
  payload: { events: [upEvent({ eventId: 'leak-2', idempotencyKey: 'leak-2', entityId: 'cust-leak2',
    payload: { displayName: 'X', wcdb_path: '/Users/x/db' } })] } })
check('D11 wcdb_path / session_id 同属禁字段', sessionLeak.json().data.rejected[0]?.code === 'forbidden_field')

console.log('═══ E. 版本闸门 ═══')
await app.inject({ method: 'POST', url: '/api/v1/sync/push', headers: { ...salesAuth, 'idempotency-key': 'ver-1' },
  payload: { events: [upEvent({ eventId: 'v1', idempotencyKey: 'ver:v1', entityId: 'cust-ver', aggregateVersion: 2, payload: { displayName: '新' } })] } })
await app.inject({ method: 'POST', url: '/api/v1/sync/push', headers: { ...salesAuth, 'idempotency-key': 'ver-2' },
  payload: { events: [upEvent({ eventId: 'v2', idempotencyKey: 'ver:v2', entityId: 'cust-ver', aggregateVersion: 1, payload: { displayName: '旧' } })] } })
check('E1 低版本事件不覆盖高版本投影', store.projectionRow('customer', 'cust-ver')?.payload.displayName === '新')

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
  payload: { events: [upEvent({ eventId: 'b-e1', idempotencyKey: 'b-e1', entityId: 'cust-b', payload: { displayName: 'B 客户' } })] } })
check('G4 同 idempotencyKey 空间按工作区隔离（A 已用不代表 B 冲突）', bPush.json().data.accepted.length === 1)
const aSame = await app.inject({ method: 'POST', url: '/api/v1/sync/push', headers: { ...salesAuth, 'idempotency-key': 'a-1' },
  payload: { events: [upEvent({ eventId: 'a-e1', idempotencyKey: 'b-e1', entityId: 'cust-a-same', payload: { displayName: 'A 客户' } })] } })
check('G5 跨工作区同 key 不互相判重', aSame.json().data.accepted[0]?.duplicate === false)
const wsMismatchInvite = await app.inject({ method: 'POST', url: '/api/v1/bindings/invitations', headers: authOf(admin.token),
  payload: { workspaceId: wsB, employeeCode: 'HACK', displayName: 'HACK', role: 'admin' } })
check('G6 管理员不能为其它工作区签发邀请码 → 403', wsMismatchInvite.statusCode === 403)

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

await app.close()
console.log(`\ncentral app test: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
