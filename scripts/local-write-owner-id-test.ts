/**
 * local-write-owner-id-test.ts —— 「本机写路径补归属员工 ID」隔离夹具（2026-09-17）
 *
 * 修的是什么：`assignment.owner_employee_id` 是归属权威列（宪法 §1.3 补列登记），
 * 但 2026-09-17 前**只有中央下行落地行**会写它（lanSyncService assign/transfer 落地），
 * 本机自己产生的行（crmAssignmentService.assignLeads / transferAssignment）不写。
 * 后果：一条本机移交出来的行永远只带姓名，`ownerFilter.isOwnedLead` 只能走姓名回退分支 ——
 * 那条回退是宪法 §1.3 的历史兼容，本地生产端不补列它就永远退不掉；同名不同人时该行还会串线。
 *
 * 本夹具证明（对照 3c-i 验收）：
 *   A. 解析器的三条口径：绑定本人（署名/别名）→ 权威 ID；显式别名表命中 → 别名里的编号；
 *      无任何依据 → **空串**（降级不猜）；坏 JSON 别名表 → 空串；非目标名字 → 空串；
 *   B. assignLeads 产出的行带 owner_employee_id，且**可被 isOwnedLead 按 ID 判定**；
 *   C. transferAssignment 产出的新行带**新归属人**的 ID（不是旧行的、不是旧归属人的）；
 *   D. 同名不同人：目标名下无依据时留空（不写错 ID），行仍走姓名回退、行为与修复前一致；
 *   E. 回归：未绑定单机 + 本机署名分配 → owner_employee_id 为空（老行为不变，不因修复新增写入）；
 *   F. 写入纪律未破：assign/transfer 单事务内的 ownership_history + audit_event + outbox 照写，
 *      审计 detail 带上 ownerEmployeeId（null = 未解析）。
 *
 * 边界（不得据此宣称真机验证）：未走真实中央目录（同步是异步的，本机同步写路径拿不到目录，
 * 这正是「解析不到就留空」的原因）；未验证真实 Windows 真机与真实网络链路。
 * 运行：npx tsx scripts/local-write-owner-id-test.ts
 */
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const isoDir = mkdtempSync(join(tmpdir(), 'local-owner-id-'))
process.env.WEFLOW_WORKER = '1'
process.env.WEFLOW_USER_DATA_PATH = isoDir
process.env.WEFLOW_CONFIG_CWD = isoDir

let pass = 0
let fail = 0
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; console.log(`  ✅ ${name}`) } else { fail++; console.log(`  ❌ ${name} ${detail}`) }
}

import { isOwnedLead } from '../shared/ownerFilter'
import { LEAD_SLA_UNASSIGNED_SENTINEL } from '../shared/leadSla'

let crmDbService: (typeof import('../electron/services/crmDbService'))['crmDbService']
let ConfigService: (typeof import('../electron/services/config'))['ConfigService']
let identityService: typeof import('../electron/services/identityService')
let assignmentService: typeof import('../electron/services/crmAssignmentService')

/** 建一条本地线索，返回其本地 id */
function mkLead(contact: string): number {
  const now = Date.now()
  return crmDbService.runTx((tx) => tx.run(
    'INSERT INTO lead (contact_normalized, contact_type, name, source, status, first_contact_deadline, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
    [contact, 'phone', `线索${contact}`, 'test', 'new', LEAD_SLA_UNASSIGNED_SENTINEL, now, now]
  ))
}

/** 某 lead 的当前有效分配行 */
function currentRow(leadId: number): Record<string, unknown> | undefined {
  return crmDbService.all(
    "SELECT * FROM assignment WHERE lead_id = ? AND deleted = 0 AND status IN ('assigned','claimed') ORDER BY id DESC LIMIT 1",
    [leadId]
  )[0]
}

async function main(): Promise<void> {
  ConfigService = (await import('../electron/services/config')).ConfigService
  crmDbService = (await import('../electron/services/crmDbService')).crmDbService
  identityService = await import('../electron/services/identityService')
  assignmentService = await import('../electron/services/crmAssignmentService')
  await crmDbService.initialize(isoDir)

  const cfg = ConfigService.getInstance()
  identityService.setIdentity('杨青', '销售')

  console.log('═══ A. 未绑定单机：署名分配不写 ID（老行为不变）═══')
  ok('A1 前置：未绑定 → getBoundEmployeeId 为空', identityService.getBoundEmployeeId() === '')
  const leadA = mkLead('13900000001')
  const ra = assignmentService.assignLeads([leadA], '杨青', '测试分配员', 'manual')
  ok('A2 署名分配成功', ra.ok === true, JSON.stringify(ra))
  const rowA = currentRow(leadA)
  ok('A3 未绑定：owner_employee_id 为空（不因修复凭空新增写入）',
    String(rowA?.owner_employee_id || '') === '', JSON.stringify(rowA?.owner_employee_id))

  console.log('═══ B. 绑定本人：assign / transfer 写权威 employeeId ═══')
  cfg.set('centralSyncEnabled', true)
  cfg.set('centralSyncBaseUrl', 'https://central.test')
  cfg.set('centralSyncDeviceToken', 'local-owner-id-test-token-0123456789')
  cfg.set('centralSyncWorkspaceId', 'ws-1')
  cfg.set('centralSyncEmployeeId', 'emp-A-uuid')
  cfg.set('centralSyncDeviceId', 'dev-A')
  cfg.set('centralSyncRole', 'sales')
  cfg.set('centralSyncDisplayName', '杨青') // 与署名相同 → 别名不重复返回
  ok('B1 绑定后 getBoundEmployeeId = emp-A-uuid', identityService.getBoundEmployeeId() === 'emp-A-uuid')

  const leadB = mkLead('13900000002')
  const rb = assignmentService.assignLeads([leadB], '杨青', '测试分配员', 'weight')
  ok('B2 绑定本人：比例权重分配成功', rb.ok === true, JSON.stringify(rb))
  const rowB = currentRow(leadB)
  ok('B3 本机 assign 行带权威 owner_employee_id',
    String(rowB?.owner_employee_id || '') === 'emp-A-uuid', String(rowB?.owner_employee_id))
  ok('B4 该行可被 isOwnedLead 按 ID 判定为本人（不再依赖姓名）',
    isOwnedLead({ name: '杨青', role: '销售', employeeId: 'emp-A-uuid' },
      { salesName: String(rowB?.sales_name), ownerEmployeeId: String(rowB?.owner_employee_id) }) === true)
  ok('B5 同名不同人：他人绑定 id 判定该行为**非本人**（ID 权威，姓名不参与）',
    isOwnedLead({ name: '杨青', role: '销售', employeeId: 'emp-OTHER-uuid' },
      { salesName: String(rowB?.sales_name), ownerEmployeeId: String(rowB?.owner_employee_id) }) === false)
  ok('B6 绑定本人但署名已改：ID 仍判定为本人（姓名变了不影响归属）',
    isOwnedLead({ name: '杨青（改名前）', role: '销售', employeeId: 'emp-A-uuid' },
      { salesName: String(rowB?.sales_name), ownerEmployeeId: String(rowB?.owner_employee_id) }) === true)

  console.log('═══ C. 别名绑定（署名 ≠ 中央显示名）═══')
  cfg.set('centralSyncDisplayName', 'Yang Qing') // 别名：中央目录显示名
  ok('C1 显示名 ≠ 署名 → 别名含 Yang Qing',
    identityService.getOwnershipAliases().includes('Yang Qing'), JSON.stringify(identityService.getOwnershipAliases()))
  const leadC = mkLead('13900000003')
  const rc = assignmentService.assignLeads([leadC], 'Yang Qing', '测试分配员', undefined)
  ok('C2 按别名分配成功（mode 省略 → manual）', rc.ok === true && String(currentRow(leadC)?.mode) === 'manual', JSON.stringify(rc))
  ok('C3 别名 == 本机绑定身份 → 写权威 employeeId（不是按名字猜的）',
    String(currentRow(leadC)?.owner_employee_id || '') === 'emp-A-uuid', String(currentRow(leadC)?.owner_employee_id))

  console.log('═══ D. 显式别名表（centralSyncEmployeeAlias）═══')
  cfg.set('centralSyncEmployeeAlias', JSON.stringify({ 李林辉: 'EMP-0007' }))
  const leadD = mkLead('13900000004')
  const rd = assignmentService.assignLeads([leadD], '李林辉', '测试分配员', 'round_robin')
  ok('D1 显式别名表命中 → 写表里的编号', String(currentRow(leadD)?.owner_employee_id || '') === 'EMP-0007'
    && rd.ok === true, String(currentRow(leadD)?.owner_employee_id))
  ok('D2 别名表里不存在的名字 → 留空（不猜、不模糊匹配）',
    (() => {
      const lead = mkLead('13900000005')
      assignmentService.assignLeads([lead], '许丽娟', '测试分配员', 'manual')
      return String(currentRow(lead)?.owner_employee_id || '') === ''
    })())
  ok('D3 坏 JSON 别名表 → 视为未配置，留空（与 centralSyncService 同口径）',
    (() => {
      cfg.set('centralSyncEmployeeAlias', '{不是 JSON')
      const lead = mkLead('13900000006')
      assignmentService.assignLeads([lead], '李林辉', '测试分配员', 'manual')
      return String(currentRow(lead)?.owner_employee_id || '') === ''
    })())
  ok('D4 别名表值为空串 → 留空（不写空值以外的垃圾）',
    (() => {
      cfg.set('centralSyncEmployeeAlias', JSON.stringify({ 王五: '   ' }))
      const lead = mkLead('13900000007')
      assignmentService.assignLeads([lead], '王五', '测试分配员', 'manual')
      return String(currentRow(lead)?.owner_employee_id || '') === ''
    })())

  console.log('═══ E. 移交：新行写新归属人的 ID，不继承旧行 ═══')
  cfg.set('centralSyncEmployeeAlias', JSON.stringify({ 李林辉: 'EMP-0007' }))
  cfg.set('crmSalesList', ['杨青', '李林辉', '许丽娟'])
  const leadE = mkLead('13900000008')
  assignmentService.assignLeads([leadE], '杨青', '测试分配员', 'manual')
  const oldRow = currentRow(leadE)
  ok('E1 移交前旧行归属 = 杨青 / emp-A-uuid',
    String(oldRow?.sales_name) === '杨青' && String(oldRow?.owner_employee_id) === 'emp-A-uuid',
    `${String(oldRow?.sales_name)} / ${String(oldRow?.owner_employee_id)}`)
  const rt = assignmentService.transferAssignment(Number(oldRow?.id), '李林辉', '离职移交', '测试主管')
  ok('E2 移交成功', rt.ok === true, JSON.stringify(rt))
  const newRow = currentRow(leadE)
  ok('E3 新行归属 = 李林辉', String(newRow?.sales_name) === '李林辉')
  ok('E4 新行 owner_employee_id = 新归属人的 EMP-0007（不继承旧行的 emp-A-uuid）',
    String(newRow?.owner_employee_id || '') === 'EMP-0007', String(newRow?.owner_employee_id))
  ok('E5 新行可被「李林辉 + EMP-0007」按 ID 判定为本人',
    isOwnedLead({ name: '李林辉', role: '销售', employeeId: 'EMP-0007' },
      { salesName: String(newRow?.sales_name), ownerEmployeeId: String(newRow?.owner_employee_id) }) === true)
  ok('E6 本机绑定人（emp-A-uuid）按 ID 判定新行**非本人**（移交后旧人不再持有）',
    isOwnedLead({ name: '杨青', role: '销售', employeeId: 'emp-A-uuid' },
      { salesName: String(newRow?.sales_name), ownerEmployeeId: String(newRow?.owner_employee_id) }) === false)
  ok('E7 旧行已作废（transferred）', String(crmDbService.all('SELECT status FROM assignment WHERE id = ?', [Number(oldRow?.id)])[0]?.status) === 'transferred')

  console.log('═══ F. 移交到无法解析的人：留空而非写错 ID ═══')
  cfg.set('centralSyncEmployeeAlias', '')
  const leadF = mkLead('13900000009')
  assignmentService.assignLeads([leadF], '杨青', '测试分配员', 'manual')
  const rowF0 = currentRow(leadF)
  const rf = assignmentService.transferAssignment(Number(rowF0?.id), '许丽娟', '转给未登记同事', '测试主管')
  ok('F1 移交到无 ID 依据的人仍成功（业务不因补列而受阻）', rf.ok === true, JSON.stringify(rf))
  const rowF = currentRow(leadF)
  ok('F2 新行 owner_employee_id 留空（宁可降级到姓名回退，也不写一个错的 ID）',
    String(rowF?.owner_employee_id || '') === '', String(rowF?.owner_employee_id))
  ok('F3 留空行的判定退化为姓名集合（与修复前完全一致，无行为回归）',
    isOwnedLead({ name: '许丽娟', role: '销售', employeeId: 'whatever-uuid' },
      { salesName: String(rowF?.sales_name), ownerEmployeeId: '' }) === true)

  console.log('═══ G. 写入纪律未破 + 审计带解析结果 ═══')
  const histCount = Number(crmDbService.all(
    'SELECT COUNT(*) AS c FROM ownership_history WHERE entity_type = ? AND entity_id = ?', ['lead', leadE])[0]?.c || 0)
  ok('G1 移交写了两条归属流水（分配 + 移交，append-only）', histCount === 2, String(histCount))
  const aud = crmDbService.all(
    "SELECT detail FROM audit_event WHERE action = 'lead_transfer' AND entity_id = ? ORDER BY id DESC LIMIT 1", [leadE])[0]
  const audDetail = JSON.parse(String(aud?.detail || '{}')) as Record<string, unknown>
  ok('G2 lead_transfer 审计 detail 带 ownerEmployeeId = EMP-0007（成功解析时如实记录）',
    audDetail.ownerEmployeeId === 'EMP-0007', JSON.stringify(audDetail))
  const audF = crmDbService.all(
    "SELECT detail FROM audit_event WHERE action = 'lead_transfer' AND entity_id = ? ORDER BY id DESC LIMIT 1", [leadF])[0]
  const audFDetail = JSON.parse(String(audF?.detail || '{}')) as Record<string, unknown>
  ok('G2b 解析不到时审计 detail 记 null（不是省略字段、不是空串——事后可区分「没解析」与「解析成空」）',
    'ownerEmployeeId' in audFDetail && audFDetail.ownerEmployeeId === null, JSON.stringify(audFDetail))
  const audAssign = crmDbService.all(
    "SELECT detail FROM audit_event WHERE action = 'lead_assign' AND entity_id = ? ORDER BY id ASC LIMIT 1", [leadB])[0]
  const audAssignDetail = JSON.parse(String(audAssign?.detail || '{}')) as Record<string, unknown>
  ok('G3 lead_assign 审计 detail 带 ownerEmployeeId = emp-A-uuid（成功解析时如实记录）',
    audAssignDetail.ownerEmployeeId === 'emp-A-uuid', JSON.stringify(audAssignDetail))
  ok('G4 outbox 登记照旧（移交产生一条 transfer 指令）',
    Number(crmDbService.all("SELECT COUNT(*) AS c FROM outbox_event WHERE idempotency_key LIKE 'transfer:%'")[0]?.c || 0) >= 1)
  ok('G5 parseAssignmentMode 前置拦截未被破坏（非法 mode 仍 E101 且不落行）',
    (() => {
      const lead = mkLead('13900000010')
      const bad = assignmentService.assignLeads([lead], '杨青', '测试分配员', 'teleport')
      return bad.ok === false && bad.code === 'E101' && !currentRow(lead)
    })())

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  if (fail > 0) process.exit(1)
}

void main()
