/**
 * central-identity-visibility-test.ts —— 「中央分配已落地，但销售视图看不到」根因修复的隔离夹具
 * （2026-09-17；根因：下行 assign 落地的 assignment.sales_name = 中央目录显示名，
 *   销售视图按本地署名过滤 → 本地署名 ≠ 中央显示名时看不见自己的分配）。
 *
 * 覆盖（对照任务验收清单）：
 *   A. 未绑定单机基线：无别名、SMB/终端投递键既有行为不变；
 *   B. 绑定后：归属别名 = 中央 displayName（署名不变）；中央启用关 SMB 的既有规则不变；
 *   C. 下行 assign 落地逐值精确：sales_name / mode（manual 缺省 + 显式枚举）/ sla1_deadline
 *      毫秒逐值相等；重放幂等；
 *   D. 视图链：署名 ≠ 中央名也能看到自己的分配（列表/chips/认领按钮 + claimLead 后端）；
 *      他人分配不可见；filterByOwner（account.owner_sales 列）同口径；本地销售不因修复获得主管权限；
 *   E. 目标防护：fake 中央实现真实 pull 路由（targetEmployeeId）——发给他人的下行不会到达本机；
 *   F. 资源卡回收分段按别名识别；权限声明契约（销售不发 / 主管发具体引用 / 换绑重新声明 / 解绑清标记）；
 *   G. 解绑回退：别名清空 → 中央名行对销售视角隐藏（不是变成展示全部）、署名行照常可见、SMB 恢复。
 *
 * 边界（不得据此宣称真机验证）：中央为按路径路由的内存假服务；真实 PostgreSQL / Windows
 * 真机 / 真实网络链路未在本文件验证。
 * 运行：npx tsx scripts/central-identity-visibility-test.ts
 */
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const isoDir = mkdtempSync(join(tmpdir(), 'central-identity-'))
process.env.WEFLOW_WORKER = '1'
process.env.WEFLOW_USER_DATA_PATH = isoDir
process.env.WEFLOW_CONFIG_CWD = isoDir

let pass = 0
let fail = 0
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; console.log(`  ✅ ${name}`) } else { fail++; console.log(`  ❌ ${name} ${detail}`) }
}

import { LEAD_SLA_UNASSIGNED_SENTINEL } from '../shared/leadSla'
import type { CentralSyncEvent } from '../shared/centralSync'
import { isRefOwnedByDevice } from '../shared/centralSync'
import { validateCentralEntityId } from '../shared/centralDownCommand'
import {
  buildOwnerMap, canClaimLead, filterLeadsForView, visibleOwnerChips,
  buildMyCards, filterByOwner, isSalesView, identityLikeFromIpc, leadPageView, canManageAssignment
} from '../src/utils/leadAssignmentView'

let crmDbService: (typeof import('../electron/services/crmDbService'))['crmDbService']
let salesDbService: (typeof import('../electron/services/salesDbService'))['salesDbService']
let ConfigService: (typeof import('../electron/services/config'))['ConfigService']
let identityService: typeof import('../electron/services/identityService')
let service: typeof import('../electron/services/centralSyncService')
let lanSyncService: typeof import('../electron/services/lanSyncService')
let assignmentService: typeof import('../electron/services/crmAssignmentService')

const TOKEN = 'visibility-test-device-token-0123456789abcdef'

interface Captured { url: string; body: unknown }
let captured: Captured[] = []
let pullQueue: Array<CentralSyncEvent & { centralSeq: number }> = []
/** 本机当前绑定的员工 id（fake 中央按它实现真实 pull 路由：只投 target=本员工的事件） */
let boundEmployeeId = ''

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** 假中央：pull 按真实路由规则投递，push/ack/commands 一律受理（中央侧契约另有独立测试覆盖） */
const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = String(input)
  const body = init?.body ? JSON.parse(String(init.body)) : undefined
  captured.push({ url, body })
  if (url.includes('/api/v1/sync/pull')) {
    const deliverable = pullQueue.filter((e) => !e.targetEmployeeId || e.targetEmployeeId === boundEmployeeId)
    return jsonResponse(200, { ok: true, data: { events: deliverable, nextCursor: deliverable.length ? deliverable[deliverable.length - 1]!.centralSeq : 0, hasMore: false } })
  }
  if (url.endsWith('/api/v1/sync/push')) {
    const events = (body as { events: CentralSyncEvent[] }).events
    return jsonResponse(200, { ok: true, data: { accepted: events.map((e, i) => ({ eventId: e.eventId, centralSeq: i + 1, duplicate: false })), rejected: [] } })
  }
  if (url.endsWith('/api/v1/sync/ack')) {
    return jsonResponse(200, { ok: true, data: { acknowledged: (body as { acknowledgements: unknown[] }).acknowledgements.length } })
  }
  if (url.endsWith('/api/v1/sync/commands')) {
    return jsonResponse(201, { ok: true, data: { centralSeq: 1, duplicate: false } })
  }
  if (url.endsWith('/api/v1/directory/employees')) {
    return jsonResponse(200, { ok: true, data: { employees: [] } })
  }
  if (url.endsWith('/api/v1/devices/revoke-self')) {
    return jsonResponse(200, { ok: true, data: { revoked: true } })
  }
  return jsonResponse(404, { ok: false, code: 'E404', message: 'not found' })
}) as unknown as typeof fetch

function pushedEvents(): CentralSyncEvent[] {
  const out: CentralSyncEvent[] = []
  for (const call of captured) {
    if (!call.url.endsWith('/api/v1/sync/push')) continue
    out.push(...(call.body as { events: CentralSyncEvent[] }).events)
  }
  return out
}
function resetCapture(): void { captured = [] }

function bind(deviceId: string, employeeId: string, role: string): void {
  const cfg = ConfigService.getInstance()
  cfg.set('centralSyncEnabled', true)
  cfg.set('centralSyncBaseUrl', 'https://central.test')
  cfg.set('centralSyncDeviceToken', TOKEN)
  cfg.set('centralSyncWorkspaceId', 'ws-1')
  cfg.set('centralSyncEmployeeId', employeeId)
  cfg.set('centralSyncDeviceId', deviceId)
  cfg.set('centralSyncRole', role)
  cfg.set('centralSyncDisplayName', role === 'sales' ? '测试销售甲' : '测试主管乙')
  boundEmployeeId = employeeId
}

function clearBinding(): void {
  const cfg = ConfigService.getInstance()
  cfg.set('centralSyncEnabled', false)
  cfg.set('centralSyncDeviceToken', '')
  cfg.set('centralSyncWorkspaceId', '')
  cfg.set('centralSyncEmployeeId', '')
  cfg.set('centralSyncDeviceId', '')
  cfg.set('centralSyncRole', '')
  cfg.set('centralSyncDisplayName', '')
  boundEmployeeId = ''
}

function downEvent(eventId: string, type: string, payload: Record<string, unknown>, centralSeq: number, srcDevice = 'dev-A', targetEmp?: string): CentralSyncEvent & { centralSeq: number } {
  return {
    protocolVersion: 1, eventId, eventSeq: centralSeq, idempotencyKey: `central/${eventId}`, direction: 'down',
    entityType: 'assignment', entityId: `${srcDevice}/${eventId}`, eventType: type, aggregateVersion: 1,
    payload, occurredAt: Date.now(), centralSeq,
    targetEmployeeId: targetEmp || boundEmployeeId
  } as CentralSyncEvent & { centralSeq: number }
}

/** 下行 assign 载荷（中央 6 字段建档契约）；mode 缺省 = 省略（manual 语义） */
function assignPayload(hubLeadId: number, salesName: string, sla1Deadline: number, mode?: string): Record<string, unknown> {
  const p: Record<string, unknown> = {
    type: 'assign', leadId: hubLeadId, assignmentId: hubLeadId,
    lead: { leadId: hubLeadId, contactType: 'phone', contactNormalized: `1390000${String(hubLeadId).slice(-5)}`, name: `线索${hubLeadId}`, source: 'test', note: '' },
    salesName, sla1Deadline, deliveryRole: 'apply'
  }
  if (mode !== undefined) p.mode = mode
  return p
}

/** 本地行按「中央 hub leadId」定位：下行建档后本地自增 id ≠ hub id，身份锚点是联系方式 */
function localLeadByContact(cn: string): number {
  return Number(crmDbService.all('SELECT id FROM lead WHERE contact_normalized = ?', [cn])[0]?.id || 0)
}
const localLeadId = (hubLeadId: number): number => localLeadByContact(`1390000${String(hubLeadId).slice(-5)}`)
/** 某 lead 的当前分配行（本地 id） */
const landed = (lid: number): Record<string, unknown> | undefined =>
  crmDbService.all('SELECT * FROM assignment WHERE lead_id = ? AND deleted = 0 ORDER BY id DESC LIMIT 1', [lid])[0]

async function main(): Promise<void> {
  ConfigService = (await import('../electron/services/config')).ConfigService
  crmDbService = (await import('../electron/services/crmDbService')).crmDbService
  salesDbService = (await import('../electron/services/salesDbService')).salesDbService
  identityService = await import('../electron/services/identityService')
  service = await import('../electron/services/centralSyncService')
  lanSyncService = await import('../electron/services/lanSyncService')
  assignmentService = await import('../electron/services/crmAssignmentService')
  await crmDbService.initialize(isoDir)
  await salesDbService.initialize(isoDir)
  globalThis.fetch = fakeFetch

  const cfg = ConfigService.getInstance()
  identityService.setIdentity('杨青', '销售')
  cfg.set('lanSyncSharedDir', join(isoDir, 'lan-root'))
  cfg.set('lanSyncRole', 'terminal')

  console.log('═══ A. 未绑定单机基线 ═══')
  ok('A1 未绑定：归属别名恒为空', identityService.getOwnershipAliases().length === 0, JSON.stringify(identityService.getOwnershipAliases()))
  ok('A2 未绑定：getOwnerIdentity 不带别名', (identityService.getOwnerIdentity()?.nameAliases || []).length === 0)
  ok('A3 identityLikeFromIpc 归一（空别名 → []）',
    identityLikeFromIpc({ name: '杨青', role: '销售', nameAliases: [] }).nameAliases.length === 0)
  ok('A4 identityLikeFromIpc 防御异常回包（aliases 缺省 []）',
    identityLikeFromIpc(null).name === '' && identityLikeFromIpc({ name: 'a', role: '销售' }).nameAliases.length === 0)
  ok('A5 未绑定：SMB 配置可用（既有单机/SMB 方式不受影响）',
    lanSyncService.getLanSyncConfig().enabled === true && lanSyncService.getLanSyncConfig().role === 'terminal')
  ok('A6 终端投递键仍按本地署名（SMB 既有路由不变）', lanSyncService.getTerminalId() === '杨青')

  console.log('═══ B. 绑定中央销售身份 ═══')
  bind('dev-A', 'emp-A-uuid', 'sales')
  ok('B1 绑定后归属别名 = 中央 displayName', JSON.stringify(identityService.getOwnershipAliases()) === JSON.stringify(['测试销售甲']))
  ok('B2 别名随绑定生效、署名本身不动（不是改姓名/不建第二套身份）',
    identityService.getIdentity()?.name === '杨青' && JSON.stringify(identityService.getOwnerIdentity()?.nameAliases) === JSON.stringify(['测试销售甲']))
  ok('B3 中央启用时 SMB 停用（既有规则不变）', lanSyncService.getLanSyncConfig().enabled === false)
  const viewIdentity = identityLikeFromIpc({
    name: identityService.getOwnerIdentity()?.name, role: identityService.getOwnerIdentity()?.role,
    nameAliases: identityService.getOwnershipAliases(), employeeId: identityService.getBoundEmployeeId()
  })
  ok('B4 前端过滤档身份 = 署名 + 别名 + 绑定员工 id（identityLikeFromIpc 同源）且仍为销售视角',
    viewIdentity.name === '杨青' && JSON.stringify(viewIdentity.nameAliases) === JSON.stringify(['测试销售甲']) &&
    viewIdentity.employeeId === 'emp-A-uuid' && isSalesView(viewIdentity))

  console.log('═══ C. 下行 assign 落地逐值精确（mode / SLA 毫秒）═══')
  const SLA1 = 1760000000123
  const SLA2 = 1760000000456
  const SLA3 = 1760000000789
  pullQueue = [
    downEvent('ev-vis-1', 'assign', assignPayload(8001, '测试销售甲', SLA1, 'manual'), 1),
    downEvent('ev-vis-2', 'assign', assignPayload(8002, '测试销售甲', SLA2), 2),      // mode 省略 = manual
    downEvent('ev-vis-3', 'assign', assignPayload(8003, '测试销售甲', SLA3, 'round_robin'), 3)
  ]
  resetCapture()
  const firstRun = await service.runCentralSyncOnce()
  ok('C0 单轮同步无错误（applied=3）', firstRun.error === undefined && firstRun.applied === 3, JSON.stringify(firstRun))
  ok('C1 assign#1 逐值落地：sales_name=中央显示名 / mode=manual / sla1 毫秒精确 / owner_employee_id=绑定员工',
    landed(localLeadId(8001))?.sales_name === '测试销售甲' && String(landed(localLeadId(8001))?.mode) === 'manual' &&
    Number(landed(localLeadId(8001))?.sla1_deadline) === SLA1 &&
    String(landed(localLeadId(8001))?.owner_employee_id) === 'emp-A-uuid', JSON.stringify(landed(localLeadId(8001))))
  ok('C2 assign#2 mode 省略落 manual（与本机生产者缺省同一枚举）、SLA 毫秒精确',
    String(landed(localLeadId(8002))?.mode) === 'manual' && Number(landed(localLeadId(8002))?.sla1_deadline) === SLA2)
  ok('C3 assign#3 显式 mode 原样落地（round_robin）、SLA 毫秒精确',
    String(landed(localLeadId(8003))?.mode) === 'round_robin' && Number(landed(localLeadId(8003))?.sla1_deadline) === SLA3)
  const countCentralAssign = (): number =>
    Number(crmDbService.all('SELECT COUNT(*) AS c FROM assignment WHERE deleted = 0 AND lead_id IN (?,?,?)',
      [localLeadId(8001), localLeadId(8002), localLeadId(8003)])[0]?.c || 0)
  ok('C4 三条 assign 全部 ack=applied', crmDbService.getScanState('centralSync:pullCursor') === 3)
  ok('C5 落地三行（每 lead 一行，无重复）', countCentralAssign() === 3, String(countCentralAssign()))
  crmDbService.setScanState('centralSync:pullCursor', 0)
  resetCapture()
  await service.runCentralSyncOnce()
  ok('C6 重放同一批不产生重复分配行（幂等标记，仍 3 行）', countCentralAssign() === 3, String(countCentralAssign()))

  console.log('═══ D. 销售视图：署名 ≠ 中央名 也能看到自己的分配 ═══')
  // 本地两行：一条给署名本人（杨青）、一条给他人（李四）；lead 用本地建档，id 与中央无关
  const now = Date.now()
  crmDbService.runTx((tx) => {
    // first_contact_deadline 为 NOT NULL（2100 哨兵 = 待分配）
    tx.run("INSERT INTO lead (contact_type, contact_normalized, name, source, status, first_contact_deadline, created_at, updated_at) VALUES ('phone','13900000004','本地线索四','test','NEW',?,?,?)", [LEAD_SLA_UNASSIGNED_SENTINEL, now, now])
    tx.run("INSERT INTO lead (contact_type, contact_normalized, name, source, status, first_contact_deadline, created_at, updated_at) VALUES ('phone','13900000005','本地线索五','test','NEW',?,?,?)", [LEAD_SLA_UNASSIGNED_SENTINEL, now, now])
  })
  const mineLocalId = localLeadByContact('13900000004')
  const otherLocalId = localLeadByContact('13900000005')
  const res = assignmentService.assignLeads([mineLocalId], '杨青', '测试操作', 'manual') // 本机署名路径（历史行为不变）
  assignmentService.assignLeads([otherLocalId], '李四', '测试操作', 'manual')           // 他人
  ok('D1 本机 assignLeads 仍写署名（改动不触碰本地分配路径）',
    res.ok === true && res.data?.assignments.length === 1 && landed(mineLocalId)?.sales_name === '杨青' && landed(otherLocalId)?.sales_name === '李四',
    JSON.stringify({ mine: landed(mineLocalId)?.sales_name, other: landed(otherLocalId)?.sales_name }))
  const asgRows = crmDbService.all('SELECT * FROM assignment WHERE deleted = 0 ORDER BY id DESC')
  const ownerByLead = buildOwnerMap(asgRows as never)
  const latestAsg: Record<number, Record<string, unknown>> = {}
  for (const r of asgRows) { const lid = Number(r.lead_id); if (!latestAsg[lid] || Number(r.id) > Number(latestAsg[lid]!.id)) latestAsg[lid] = r }
  const leads = crmDbService.all('SELECT id, status FROM lead ORDER BY id') as unknown as Array<{ id: number; status: string }>
  const visible = filterLeadsForView(leads, ownerByLead, viewIdentity)
  ok('D2 销售视角可见自己的中央分配（中央名落地）+ 本地分配（署名）',
    visible.some((l) => l.id === localLeadId(8001)) && visible.some((l) => l.id === localLeadId(8002)) && visible.some((l) => l.id === mineLocalId))
  ok('D3 他人的分配不可见（李四）', !visible.some((l) => l.id === otherLocalId))
  ok('D4 「我的」chips 计数 = 署名 + 别名归属之和（4）',
    visibleOwnerChips(viewIdentity, { unassigned: 0, names: [{ value: '测试销售甲', count: 3 }, { value: '杨青', count: 1 }, { value: '李四', count: 1 }] })[0]?.count === 4)
  ok('D5 无别名时「我的」只算署名（未绑定行为不变）',
    visibleOwnerChips({ name: '杨青', role: '销售' }, { unassigned: 0, names: [{ value: '测试销售甲', count: 3 }, { value: '杨青', count: 1 }] })[0]?.count === 1)
  ok('D6 认领按钮：中央名归属的 assigned 行对署名销售可见', canClaimLead(viewIdentity, ownerByLead[localLeadId(8002)]))
  const claim = assignmentService.claimLead(localLeadId(8002), '')
  ok('D7 claimLead 后端认领成功（归属别名算本人）', claim.ok === true && claim.code === undefined, JSON.stringify(claim))
  ok('D8 认领后仍可见（claimed 属当前有效归属）', filterLeadsForView(leads, ownerByLead, viewIdentity).some((l) => l.id === localLeadId(8002)))
  ok('D9 本地销售不因修复获得主管权限（视角仍是 sales，调派/回收按钮不可见）',
    leadPageView(viewIdentity) === 'sales' && canManageAssignment(viewIdentity, ownerByLead[localLeadId(8001)]) === false)
  const othersClaim = assignmentService.claimLead(otherLocalId, '')
  ok('D10 他人分配不可认领（E201 非本人）', othersClaim.ok === false && othersClaim.code === 'E201', JSON.stringify(othersClaim))
  // 别名是**设备绑定级**（本设备 = 该中央员工的设备）：换署名不改变本设备可见面（展示层便利过滤，
  // 非安全边界，宪法 §1.12；物理滥用靠机器部署形态 + 应用锁）。断言语义并确认别名不会扩大到任意他人行。
  const aliasIsDeviceScoped = (() => {
    identityService.setIdentity('王五', '销售')
    const v = identityLikeFromIpc({
      name: '王五', role: '销售', nameAliases: identityService.getOwnershipAliases(),
      employeeId: identityService.getBoundEmployeeId() // identity:get 恒返回设备绑定的员工 id
    })
    const vOwner = buildOwnerMap(crmDbService.all('SELECT * FROM assignment WHERE deleted = 0 ORDER BY id DESC') as never)
    const seesCentralRows = filterLeadsForView(leads, vOwner, v).some((l) => l.id === localLeadId(8001))
    const notOthers = !filterLeadsForView(leads, vOwner, v).some((l) => l.id === otherLocalId)
    identityService.setIdentity('杨青', '销售')
    return seesCentralRows && notOthers
  })()
  ok('D11 绑定随设备（换署名仍指同一设备绑定的员工 id），且不扩大到他人行', aliasIsDeviceScoped === true)
  const accRows = [
    { id: 1, owner_sales: '测试销售甲' }, { id: 2, owner_sales: '杨青' }, { id: 3, owner_sales: '李四' }
  ]
  const accVisible = filterByOwner(accRows, viewIdentity)
  ok('D12 filterByOwner（account/owner_sales 列）同口径：本人别名可见、他人不可见、署名可见',
    accVisible.some((r) => r.id === 1) && accVisible.some((r) => r.id === 2) && !accVisible.some((r) => r.id === 3))

  console.log('═══ D2. 同名员工与 employeeId 权威核对（显示名不参与判定）═══')
  // 场景：中央目录存在同名员工（displayName 同为「测试销售甲」、employeeId 不同）。
  // 行带 owner_employee_id → 以本机绑定 employeeId 为权威；显示名完全一致也不算本人。
  const nowH = Date.now()
  crmDbService.runTx((tx) => {
    tx.run("INSERT INTO lead (contact_type, contact_normalized, name, source, status, first_contact_deadline, created_at, updated_at) VALUES ('phone','13900000101','同名员工线索一','test','NEW',?,?,?)", [LEAD_SLA_UNASSIGNED_SENTINEL, nowH, nowH])
    tx.run("INSERT INTO lead (contact_type, contact_normalized, name, source, status, first_contact_deadline, created_at, updated_at) VALUES ('phone','13900000102','旧显示名线索','test','NEW',?,?,?)", [LEAD_SLA_UNASSIGNED_SENTINEL, nowH, nowH])
    // 别人的同名行：sales_name 与我的中央显示名一致，但归属是另一名同名员工
    tx.run("INSERT INTO assignment (lead_id, sales_name, owner_employee_id, mode, sla1_deadline, status, source, updated_by, updated_at, version, deleted) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      [localLeadByContact('13900000101'), '测试销售甲', 'emp-other-same-name', 'manual', nowH + 86400000, 'assigned', 'sync:down', 'system:sync', nowH, 1, 0])
    // 我自己的行：employeeId = 绑定员工，即使显示名是本机从未见过的旧名也算本人
    tx.run("INSERT INTO assignment (lead_id, sales_name, owner_employee_id, mode, sla1_deadline, status, source, updated_by, updated_at, version, deleted) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      [localLeadByContact('13900000102'), '旧显示名', 'emp-A-uuid', 'manual', nowH + 86400000, 'assigned', 'sync:down', 'system:sync', nowH, 1, 0])
  })
  const sameNameLead = localLeadByContact('13900000101')
  const oldNameLead = localLeadByContact('13900000102')
  const ownerH = buildOwnerMap(crmDbService.all('SELECT * FROM assignment WHERE deleted = 0 ORDER BY id DESC') as never)
  const leadsH = crmDbService.all('SELECT id, status FROM lead ORDER BY id') as unknown as Array<{ id: number; status: string }>
  const hVisible = filterLeadsForView(leadsH, ownerH, viewIdentity)
  ok('H1 同名不同员工（owner_employee_id=他人）不可见——即使显示名与我的别名完全一致',
    !hVisible.some((l) => l.id === sameNameLead), JSON.stringify({ sameNameLead }))
  ok('H2 绑定员工 id 命中的行可见——即使显示名不在署名/别名集合内（employeeId 权威）',
    hVisible.some((l) => l.id === oldNameLead))
  ok('H3 「我的」chips 计数按 isOwnedLead 统计（employeeId 行计入，他人同名行不计）',
    visibleOwnerChips(viewIdentity, { unassigned: 0, names: [] }, ownerH)[0]?.count === hVisible.length,
    JSON.stringify({ chip: visibleOwnerChips(viewIdentity, { unassigned: 0, names: [] }, ownerH)[0]?.count, visible: hVisible.length }))
  const sameNameClaim = assignmentService.claimLead(sameNameLead, '')
  ok('H4 同名员工的分配不可认领（后端 employeeId 核对，E201）',
    sameNameClaim.ok === false && sameNameClaim.code === 'E201', JSON.stringify(sameNameClaim))
  const oldNameClaim = assignmentService.claimLead(oldNameLead, '')
  ok('H5 employeeId 命中的行可认领（不受显示名影响）', oldNameClaim.ok === true, JSON.stringify(oldNameClaim))
  ok('H6 未绑定视角（employeeId 空）：employeeId 行隐藏而非展示全部',
    !filterLeadsForView(leadsH, ownerH, identityLikeFromIpc({ name: '杨青', role: '销售', nameAliases: ['测试销售甲'] })).some((l) => l.id === oldNameLead))
  ok('H7 行未带 owner_employee_id（历史/本地/SMB）仍走姓名集合回退（既有口径不变）',
    (() => {
      const v = identityLikeFromIpc({ name: '杨青', role: '销售', nameAliases: ['测试销售甲'], employeeId: 'emp-A-uuid' })
      return filterLeadsForView(leads, ownerByLead, v).some((l) => l.id === mineLocalId)
    })())

  console.log('═══ E. 目标防护（fake 中央真实路由）═══')
  const beforeCount = Number(crmDbService.all('SELECT COUNT(*) AS c FROM assignment WHERE deleted = 0')[0]?.c || 0)
  pullQueue = [downEvent('ev-vis-x', 'assign', assignPayload(8099, '测试销售甲', SLA1, 'manual'), 4)]
  Object.assign(pullQueue[0] as unknown as Record<string, unknown>, { targetEmployeeId: 'emp-B-uuid' }) // 发给别人的
  resetCapture()
  await service.runCentralSyncOnce()
  const afterCount = Number(crmDbService.all('SELECT COUNT(*) AS c FROM assignment WHERE deleted = 0')[0]?.c || 0)
  ok('E1 目标为他人的下行指令不会到达本机（pull 路由按 targetEmployeeId），业务行零新增', beforeCount === afterCount, `${beforeCount} → ${afterCount}`)

  console.log('═══ E2. 撞号负例：映射命名空间 + 联系方式锚点优先 ═══')
  // 部署诱饵：本地 lead id = D（李四的真实线索，带有效归属）。两个来源设备各有一个「hub leadId = D」
  // 的不同物理线索（行号空间互不相通）。旧行为（裸 hubLeadId 当本地 id）会把回收/建档落到诱饵上。
  const nowE = Date.now()
  crmDbService.runTx((tx) => {
    tx.run("INSERT INTO lead (contact_type, contact_normalized, name, source, status, first_contact_deadline, created_at, updated_at) VALUES ('phone','13900000201','撞号诱饵（李四）','test','NEW',?,?,?)", [LEAD_SLA_UNASSIGNED_SENTINEL, nowE, nowE])
  })
  const decoyId = localLeadByContact('13900000201')
  assignmentService.assignLeads([decoyId], '李四', '测试操作', 'manual')
  const hubCollideId = decoyId // 恰好与本地诱饵同号
  // ① dev-A 的 assign（hubLeadId=撞号值、全新联系方式）：联系方式未命中 = 本机没有该线索 → 建档，
  //    **绝不**回落裸 id 附着到诱饵（旧行为会错把诱饵改成中央归属）
  pullQueue = [downEvent('ev-col-a', 'assign', assignPayload(hubCollideId, '测试销售甲', 1760000010001, 'manual'), 6, 'dev-A')]
  resetCapture()
  const colRun1 = await service.runCentralSyncOnce()
  const devAHub6 = localLeadByContact('13900000' + String(hubCollideId).slice(-2) + 'X')
  void devAHub6
  // 新建档的本地行 id ≠ 撞号值（联系方式未命中即建档），诱饵未被附着
  const newLeadA = localLeadByContact(`1390000${String(hubCollideId).slice(-5)}`) // 联系方式由 assignPayload 以 hubLeadId 生成 → 与诱饵同号但本地新行
  ok('E2.1 assign 落到新建档行而非本地同号诱饵（联系方式锚点优先，建档路径）',
    colRun1.applied === 1 && newLeadA !== decoyId && Number(landed(newLeadA)?.sales_name !== undefined ? 1 : 0) === 1,
    JSON.stringify({ decoyId, newLeadA, applied: colRun1.applied }))
  ok('E2.2 落地行写入来源设备命名空间映射（centralSync:hubLead:dev-A:<hub>）',
    Number(crmDbService.getScanState(`centralSync:hubLead:dev-A:${hubCollideId}`) || 0) === newLeadA,
    `map=${crmDbService.getScanState(`centralSync:hubLead:dev-A:${hubCollideId}`)} expected=${newLeadA}`)
  // ② dev-Z 的 assign（同样 hubLeadId=撞号值、**不同联系方式** = 不同物理线索）：
  //    各来源设备的行号空间互不相通，同名号只是巧合 → 各自建档、各自映射，互不覆盖
  const zPayload = assignPayload(hubCollideId, '测试销售甲', 1760000010002, 'manual')
  ;(zPayload.lead as Record<string, unknown>).contactNormalized = '13900009102'
  pullQueue = [downEvent('ev-col-z', 'assign', zPayload, 7, 'dev-Z')]
  resetCapture()
  const colRun2 = await service.runCentralSyncOnce()
  const newLeadZ = localLeadByContact('13900009102')
  ok('E2.3 第二来源设备同名号建档独立（两个映射互不覆盖）',
    colRun2.applied === 1 && newLeadZ !== newLeadA && newLeadZ !== decoyId,
    JSON.stringify({ newLeadA, newLeadZ, decoyId }))
  ok('E2.4 dev-Z 的映射写到自己的命名空间',
    Number(crmDbService.getScanState(`centralSync:hubLead:dev-Z:${hubCollideId}`) || 0) === newLeadZ)
  // ③ dev-A 的 recycle（无 lead 载荷、hubLeadId=撞号值）：必须按 dev-A 映射回收 E2.1 的行，
  //    绝不命中诱饵（同号）也不回收 dev-Z 的线索
  pullQueue = [downEvent('ev-col-r', 'recycle', { type: 'recycle', leadId: hubCollideId, assignmentId: Number(landed(newLeadA)?.id), salesName: '测试销售甲', reason: '撞号回收', deliveryRole: 'apply' }, 8, 'dev-A')]
  resetCapture()
  const colRun3 = await service.runCentralSyncOnce()
  ok('E2.5 撞号回收按来源设备映射解析（回收 dev-A 的行，不碰诱饵与 dev-Z 的行）',
    colRun3.applied === 1 && String(landed(newLeadA)?.status) === 'recycled' &&
    String(landed(newLeadZ)?.status) === 'assigned' && String(landed(decoyId)?.status) === 'assigned',
    JSON.stringify({ a: landed(newLeadA)?.status, z: landed(newLeadZ)?.status, decoy: landed(decoyId)?.status }))

  // E2.6/E2.7（第三轮复核负例）：中央通道在**映射缺失**或**映射失效**时必须返回未解析
  // （recycle 走 leadUnknown 空操作审计），绝不回落裸 id 命中同号诱饵。
  const nowE2 = Date.now()
  crmDbService.runTx((tx) => {
    tx.run("INSERT INTO lead (contact_type, contact_normalized, name, source, status, first_contact_deadline, created_at, updated_at) VALUES ('phone','13900000301','裸 id 诱饵（李四）','test','NEW',?,?,?)", [LEAD_SLA_UNASSIGNED_SENTINEL, nowE2, nowE2])
  })
  const rawDecoyId = localLeadByContact('13900000301')
  assignmentService.assignLeads([rawDecoyId], '李四', '测试操作', 'manual')
  // E2.6 无映射：来源 dev-A 从未为本 hubLeadId 落过 assign → 无映射；裸 id 恰好命中诱饵
  pullQueue = [downEvent('ev-nomap', 'recycle', { type: 'recycle', leadId: rawDecoyId, assignmentId: 999999, salesName: '李四', reason: '无映射回收', deliveryRole: 'apply' }, 9, 'dev-A')]
  resetCapture()
  const noMapRun = await service.runCentralSyncOnce()
  const noMapAudit = crmDbService.all("SELECT detail FROM audit_event WHERE action='sync_apply' AND detail LIKE '%recycle_noop%' ORDER BY id DESC LIMIT 1")[0]
  ok('E2.6 无映射＋同号诱饵：中央通道返回未解析（leadUnknown 空操作），诱饵未被回收',
    noMapRun.applied === 1 && String(landed(rawDecoyId)?.status) === 'assigned' && !!noMapAudit,
    JSON.stringify({ decoy: landed(rawDecoyId)?.status, audit: noMapAudit?.detail }))
  // E2.7 失效映射：映射指向的行已不存在（置一个不存在的本地 id），裸 id 仍恰好命中诱饵
  crmDbService.runTx((tx) => {
    tx.run('INSERT INTO scan_state (key, last_scan) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET last_scan = excluded.last_scan',
      [`centralSync:hubLead:dev-A:${rawDecoyId}`, 987654321])
  })
  pullQueue = [downEvent('ev-deadmap', 'recycle', { type: 'recycle', leadId: rawDecoyId, assignmentId: 999999, salesName: '李四', reason: '失效映射回收', deliveryRole: 'apply' }, 10, 'dev-A')]
  resetCapture()
  const deadMapRun = await service.runCentralSyncOnce()
  const deadMapNoopCount = crmDbService.all("SELECT COUNT(*) AS c FROM audit_event WHERE action='sync_apply' AND detail LIKE '%recycle_noop%'")[0]?.c
  ok('E2.7 失效映射＋同号诱饵：映射指向已不存在的行 → 仍不回落裸 id，诱饵未被回收',
    deadMapRun.applied === 1 && String(landed(rawDecoyId)?.status) === 'assigned' &&
    Number(deadMapNoopCount || 0) >= 2,
    JSON.stringify({ decoy: landed(rawDecoyId)?.status, noop: deadMapNoopCount }))

  console.log('═══ F. 资源卡与回收分段（中央名归属）═══')
  const recycleTargetAssignmentId = Number(landed(localLeadId(8003))?.id)
  pullQueue = [downEvent('ev-vis-4', 'recycle', { type: 'recycle', leadId: 8003, assignmentId: recycleTargetAssignmentId, salesName: '测试销售甲', reason: '测试回收', deliveryRole: 'apply' }, 5)]
  resetCapture()
  const recycleRun = await service.runCentralSyncOnce()
  ok('F0 下行 recycle applied', recycleRun.error === undefined && recycleRun.applied === 1, JSON.stringify(recycleRun))
  const asgRows2 = crmDbService.all('SELECT * FROM assignment WHERE deleted = 0 ORDER BY id DESC')
  const ownerByLead2 = buildOwnerMap(asgRows2 as never)
  const latest2: Record<number, Record<string, unknown>> = {}
  for (const r of asgRows2) { const lid = Number(r.lead_id); if (!latest2[lid] || Number(r.id) > Number(latest2[lid]!.id)) latest2[lid] = r }
  const cards = buildMyCards(leads, latest2, ownerByLead2, viewIdentity, Date.now())
  ok('F1 回收分段按归属别名识别（原归属=中央名仍算我的回收）',
    cards.recycled.some((c) => c.lead.id === localLeadId(8003)), JSON.stringify({ recycled: cards.recycled.map((c) => c.lead.id) }))
  ok('F2 待跟进/跟进中不含他人线索', !cards.active.some((c) => c.lead.id === otherLocalId) && !cards.wait.some((c) => c.lead.id === otherLocalId))

  console.log('═══ F2. 权限声明契约（销售不发 / 主管发具体引用）═══')
  ok('F2.1 销售设备从不投 permission 投影（SALES_UPLINK_ENTITY_TYPES 拒收，标记已置终态）',
    pushedEvents().filter((e) => e.entityType === 'permission').length === 0 &&
    Number(crmDbService.getScanState('centralSync:permissionSent') || 0) > 0)
  await service.disconnectCentralBinding()
  ok('F2.2 解绑清空绑定与别名（换绑可重新声明）',
    identityService.getOwnershipAliases().length === 0 && Number(crmDbService.getScanState('centralSync:permissionSent') || 0) === 0)
  bind('dev-B', 'emp-B-uuid2', 'supervisor')
  crmDbService.setScanState('centralSync:pullCursor', 0)
  pullQueue = []
  resetCapture()
  await service.runCentralSyncOnce()
  const permEvents = pushedEvents().filter((e) => e.entityType === 'permission')
  ok('F2.3 主管设备上行 permission_declared 恰一条', permEvents.length === 1, JSON.stringify(permEvents.map((e) => e.entityId)))
  const perm = permEvents[0]
  ok('F2.4 entityId 为本设备命名空间下的具体引用（<dev>/permission:<id>），过共享校验器',
    !!perm && perm.entityId === 'dev-B/permission:dev-B' && isRefOwnedByDevice('dev-B', perm.entityId) && validateCentralEntityId('permission', perm.entityId) === null)
  ok('F2.5 声明标注来源 local_declaration（服务端不得当授权依据）', !!perm && perm.payload.authoritySource === 'local_declaration')
  resetCapture()
  await service.runCentralSyncOnce()
  ok('F2.6 声明只上行一次（标记幂等）', pushedEvents().filter((e) => e.entityType === 'permission').length === 0)
  await service.disconnectCentralBinding()
  bind('dev-C', 'emp-A-uuid', 'sales') // 换回销售绑定（同员工）
  crmDbService.setScanState('centralSync:pullCursor', 0)
  resetCapture()
  await service.runCentralSyncOnce()
  ok('F2.7 换绑为销售角色后不声明（契约 §二.5）且终态不再重试',
    pushedEvents().filter((e) => e.entityType === 'permission').length === 0 && Number(crmDbService.getScanState('centralSync:permissionSent') || 0) > 0)
  clearBinding()

  console.log('═══ G. 解绑回退 ═══')
  identityService.setIdentity('杨青', '销售')
  bind('dev-A', 'emp-A-uuid', 'sales')
  crmDbService.setScanState('centralSync:pullCursor', 0)
  pullQueue = []
  resetCapture()
  const dres = await service.disconnectCentralBinding()
  ok('G1 解绑：服务端吊销 + 本机凭证清除', dres.revoked === true && dres.localCleared === true, JSON.stringify(dres))
  ok('G2 解绑后归属别名清空', identityService.getOwnershipAliases().length === 0)
  const afterUnbindVisible = filterLeadsForView(
    leads,
    buildOwnerMap(crmDbService.all('SELECT * FROM assignment WHERE deleted = 0 ORDER BY id DESC') as never),
    identityLikeFromIpc({ name: '杨青', role: '销售', nameAliases: identityService.getOwnershipAliases() })
  )
  ok('G3 解绑后中央名分配对销售视角隐藏（身份回退为本地署名口径）',
    !afterUnbindVisible.some((l) => l.id === localLeadId(8001)) && !afterUnbindVisible.some((l) => l.id === localLeadId(8002)))
  ok('G4 解绑后本地署名分配照常可见（不把无别名伪装成无数据，也不展示全部）',
    afterUnbindVisible.some((l) => l.id === mineLocalId) && !afterUnbindVisible.some((l) => l.id === otherLocalId))
  ok('G5 解绑后仍是销售视角（不是管理视角展示全部）', isSalesView(identityLikeFromIpc({ name: '杨青', role: '销售' })))
  ok('G6 解绑后 SMB 恢复可用（既有使用方式回退）', lanSyncService.getLanSyncConfig().enabled === true)
  ok('G7 解绑审计留痕', crmDbService.all("SELECT * FROM audit_event WHERE action='central_unbind'").length >= 1)

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  if (fail > 0) process.exit(1)
}

void main()
