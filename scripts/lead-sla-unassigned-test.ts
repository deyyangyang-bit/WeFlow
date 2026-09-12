/**
 * lead-sla-unassigned-test.ts —— 未分配线索 SLA 哨兵约定验证（shared/leadSla.ts，宪法 §1.3 两段计时）
 *
 * 修复背景：旧 importLeads 在导入时直接写 now + slaHours 并立即扫描，未分配线索被提前起计时。
 * 修复后契约：
 *   1. 新导入且尚未分配的线索 first_contact_deadline = LEAD_SLA_UNASSIGNED_SENTINEL（2100，待分配不起计时）；
 *   2. 未分配线索不产生 SLA 超时任务（导入后超过 24h 再扫描也无任务）；
 *   3. 分配（assign）后才写真实 SLA1 deadline（= now + crmLeadSlaHours）；
 *   4. 各终态正确：claim 不重置计时；加好友（绑定）停表；recycle 重置回哨兵；transfer 重新起计时；
 *   5. 已满足 SLA 或已回收的线索不会被重启错误计时。
 *
 * 隔离：WEFLOW_WORKER='1' + /tmp 空库。运行：npx tsx scripts/lead-sla-unassigned-test.ts
 */
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const isoDir = mkdtempSync(join(tmpdir(), 'lead-sla-unassigned-'))
process.env.WEFLOW_WORKER = '1'
process.env.WEFLOW_USER_DATA_PATH = isoDir
process.env.WEFLOW_CONFIG_CWD = isoDir

let pass = 0, fail = 0
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; console.log(`  ✅ ${name}`) } else { fail++; console.log(`  ❌ ${name} ${detail}`) }
}

import { ConfigService } from '../electron/services/config'
import { crmDbService, type CrmRow } from '../electron/services/crmDbService'
import { salesDbService } from '../electron/services/salesDbService'
import { setIdentity } from '../electron/services/identityService'
import { importLeads, scanLeadSla } from '../electron/services/crmLeadService'
import { assignLeads, claimLead, recycleAssignment, transferAssignment } from '../electron/services/crmAssignmentService'
import { bindLeadWxid } from '../electron/services/crmFriendDetectService'
import { LEAD_SLA_UNASSIGNED_SENTINEL } from '../shared/leadSla'

const HOURS = 24
function pendingSlaTasks(leadId: number): number {
  return salesDbService.todoList({ status: 'pending', limit: 100000 }).filter((t) => t.trigger_type === 'sla_lead' && Number(t.source_id) === leadId).length
}

async function main(): Promise<void> {
  const cfg = ConfigService.getInstance()
  cfg.set('crmSalesList', ['销售甲', '销售乙'])
  cfg.set('crmLeadSlaHours', HOURS)
  const dbDir = mkdtempSync(join(tmpdir(), 'lead-sla-unassigned-db-'))
  await crmDbService.initialize(dbDir)
  await salesDbService.initialize(dbDir)
  setIdentity('测试主管', '主管')

  console.log('═══ A. 导入即哨兵：未分配不起计时、扫描零副作用 ═══')
  const imp = importLeads('抖音', 'sla.xlsx', [
    { text: '张三 13800138000' },
    { text: '李四 13900139000' }
  ])
  const l1 = Number(crmDbService.all("SELECT id FROM lead WHERE contact_normalized = '13800138000'")[0]?.id)
  const l2 = Number(crmDbService.all("SELECT id FROM lead WHERE contact_normalized = '13900139000'")[0]?.id)
  ok('A1 导入成功 2 条', imp.valid === 2, JSON.stringify(imp))
  ok('A2 新导入未分配线索 deadline = 2100 哨兵', (() => {
    const rows = crmDbService.all('SELECT first_contact_deadline FROM lead') as CrmRow[]
    return rows.length === 2 && rows.every((r) => Number(r.first_contact_deadline) === LEAD_SLA_UNASSIGNED_SENTINEL)
  })(), JSON.stringify(crmDbService.all('SELECT first_contact_deadline FROM lead')))
  ok('A3 分配前执行扫描零副作用（0 任务、0 超时）', scanLeadSla() === 0 && pendingSlaTasks(l1) === 0)

  console.log('\n═══ B. 导入后超过 24h 未分配：仍不产生 SLA 任务 ═══')
  // 把线索 created_at 回拨 3 天（模拟「导入后超过24小时但未分配」），deadline 保持哨兵
  crmDbService.runTx((tx) => { tx.run('UPDATE lead SET created_at = ? WHERE id IN (?,?)', [Date.now() - 3 * 86400_000, l1, l2]) })
  ok('B1 回拨 3 天后扫描仍 0 任务（哨兵永不过期）', scanLeadSla() === 0 && pendingSlaTasks(l1) === 0 && pendingSlaTasks(l2) === 0)
  ok('B2 overview.overdue 不计哨兵线索', Number(crmDbService.all("SELECT COUNT(*) AS c FROM lead WHERE status = 'NEW' AND first_contact_deadline < ?", [Date.now()])[0].c) === 0)

  console.log('\n═══ C. 分配后才起计时 ═══')
  const ra = assignLeads([l1], '销售甲', '测试主管')
  ok('C1 分配成功', ra.ok && ra.data?.assignments.length === 1, JSON.stringify(ra))
  const sla1 = Number(crmDbService.all('SELECT sla1_deadline FROM assignment WHERE lead_id = ?', [l1])[0]?.sla1_deadline)
  const leadDeadline = Number(crmDbService.all('SELECT first_contact_deadline FROM lead WHERE id = ?', [l1])[0]?.first_contact_deadline)
  ok('C2 assignment.sla1_deadline = now + 24h（±1 分钟容差）', Math.abs(sla1 - (Date.now() + HOURS * 3600_000)) < 60_000, String(sla1))
  ok('C3 lead.first_contact_deadline 与 sla1 对齐（哨兵被覆盖）', leadDeadline === sla1 && sla1 < LEAD_SLA_UNASSIGNED_SENTINEL)

  console.log('\n═══ D. 各终态：claim / 加好友停表 / recycle 回哨兵 / transfer 重起计时 ═══')
  setIdentity('销售甲', '销售') // 认领以销售身份操作（服务端按身份档案判本人）
  const rc = claimLead(l1, '')
  ok('D1 认领成功', rc.ok === true, JSON.stringify(rc))
  const deadlineAfterClaim = Number(crmDbService.all('SELECT first_contact_deadline FROM lead WHERE id = ?', [l1])[0]?.first_contact_deadline)
  ok('D2 认领不重置计时（沿用分配时起点）', deadlineAfterClaim === sla1)
  // 加好友（自动检测同路径 bindLeadWxid）→ 停表
  const rb = bindLeadWxid(l1, 'wxid_customer_01', { source: 'auto', displayName: '客户一' })
  ok('D3 加好友绑定成功 + 停 SLA1 表', rb.ok === true && rb.data?.slaStopped === true, JSON.stringify(rb))
  ok('D4 停表行不在回收器扫描范围', Number(crmDbService.all("SELECT COUNT(*) AS c FROM assignment WHERE lead_id = ? AND sla1_met_at IS NOT NULL", [l1])[0].c) === 1)
  // 超时未停表的 l2：先分配再人为把 deadline 拨到过去 → 扫描出任务
  const ra2 = assignLeads([l2], '销售乙', '测试主管')
  ok('D5 l2 分配成功', ra2.ok === true)
  crmDbService.runTx((tx) => { tx.run('UPDATE lead SET first_contact_deadline = ? WHERE id = ?', [Date.now() - 3600_000, l2]) })
  ok('D6 超时线索扫描产生 SLA 任务', scanLeadSla() >= 1 && pendingSlaTasks(l2) === 1)
  // 回收 l2：deadline 回哨兵 + 不再产生新任务
  const aid2 = Number(crmDbService.all("SELECT id FROM assignment WHERE lead_id = ? AND status = 'claimed'", [l2])[0]?.id || crmDbService.all("SELECT id FROM assignment WHERE lead_id = ? AND status = 'assigned'", [l2])[0]?.id)
  const rr = recycleAssignment(aid2, '测试回收', '测试主管')
  ok('D7 回收成功', rr.ok === true, JSON.stringify(rr))
  ok('D8 回收后 deadline 重置回 2100 哨兵（回资源池不起计时）',
    Number(crmDbService.all('SELECT first_contact_deadline FROM lead WHERE id = ?', [l2])[0]?.first_contact_deadline) === LEAD_SLA_UNASSIGNED_SENTINEL)
  salesDbService.todoUpdate(Number(salesDbService.todoList({ status: 'pending', limit: 100000 }).filter((t) => t.trigger_type === 'sla_lead' && Number(t.source_id) === l2)[0]?.id), { status: 'done' })
  ok('D9 回收后再次扫描不产生新任务（已回收不能重启错误计时）', scanLeadSla() === 0 && pendingSlaTasks(l2) === 0)
  // transfer：重新起计时
  const aid1 = Number(crmDbService.all("SELECT id FROM assignment WHERE lead_id = ? AND status = 'claimed'", [l1])[0]?.id || crmDbService.all("SELECT id FROM assignment WHERE lead_id = ? AND status = 'assigned'", [l1])[0]?.id)
  const rt = transferAssignment(aid1, '销售乙', '测试转派', '测试主管')
  ok('D10 转派成功', rt.ok === true, JSON.stringify(rt))
  const sla1New = Number(crmDbService.all("SELECT sla1_deadline FROM assignment WHERE lead_id = ? AND status = 'assigned' ORDER BY id DESC LIMIT 1", [l1])[0]?.sla1_deadline)
  ok('D11 转派按宪法重算 SLA1（新行 deadline = now + 24h，旧表停表状态不继承）',
    sla1New > sla1 && Math.abs(sla1New - (Date.now() + HOURS * 3600_000)) < 60_000, `old=${sla1} new=${sla1New}`)
  ok('D12 lead.deadline 跟随新分配行', Number(crmDbService.all('SELECT first_contact_deadline FROM lead WHERE id = ?', [l1])[0]?.first_contact_deadline) === sla1New)
  ok('D13 未分配池（l2 回收后）扫描依旧零副作用', scanLeadSla() === 0)

  console.log(`\n═══ 结果：${pass} 通过 / ${fail} 失败 ═══`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error('测试崩溃:', e); process.exit(1) })
