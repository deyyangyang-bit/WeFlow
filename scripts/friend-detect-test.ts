/**
 * friend-detect-test.ts —— 加好友判定双路（PRD 1.4a，宪法 §1.2/§2.4）副本隔离验证
 *
 * 覆盖：
 *   A. 手动绑定四件套：customer_identity(source=manual, confidence=1.0) + audit identity_bind
 *      （actor=身份档案署名）+ assignment 停 SLA1 表（sla1_met_at）+ lead→WX_ADDED（wechat 回填 + activity）
 *   B. 幂等重复绑：alreadyBound=true，identity/audit/assignment version 零重复写
 *   C. 参数与冲突：E101 空 wxid / E301 线索不存在 / E204 wxid 已挂他 customer（不自动改挂、零写入）
 *   D. customer_id 挂接（§2.4 能挂则挂）：account 锚点命中即挂；既有 NULL identity 后补关联
 *   E. 自动检测（保守版）：alias/username 精确等值命中（source=auto, actor=system:friend-detect）/
 *      11 位手机号对 alias 精确命中 / 未命中不动 / 昵称永不作匹配依据（remark 同名不误伤）/
 *      claimed 行同样扫停 / DEAD 线索状态不被复活 / 重扫零重复写
 *   F. 回收器尊重停表：已停表过期行不回收，未停表过期行照收
 *
 * 隔离：WEFLOW_WORKER='1' + WEFLOW_USER_DATA_PATH / WEFLOW_CONFIG_CWD 指向 /tmp 临时目录，
 *       crmDb 用全新空库（fresh），绝不碰 live 库与真实配置（config.ts:358-364 手法）。
 * 运行：npx tsx scripts/friend-detect-test.ts
 */
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// 隔离 config 落盘路径（必须在 import 前设置）
const isoDir = mkdtempSync(join(tmpdir(), 'friend-detect-test-'))
process.env.WEFLOW_WORKER = '1'
process.env.WEFLOW_USER_DATA_PATH = isoDir
process.env.WEFLOW_CONFIG_CWD = isoDir

let pass = 0, fail = 0
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; console.log(`  ✅ ${name}`) } else { fail++; console.log(`  ❌ ${name} ${detail}`) }
}

import { ConfigService } from '../electron/services/config'
import { crmDbService } from '../electron/services/crmDbService'
import { setIdentity } from '../electron/services/identityService'
import { assignLeads, claimLead, runSla1Recycle } from '../electron/services/crmAssignmentService'
import { bindLeadWxid, runFriendDetectScan, type ContactLite } from '../electron/services/crmFriendDetectService'
import { LEAD_SLA_UNASSIGNED_SENTINEL } from '../shared/leadSla'

const S_A = '测试销售甲'

/** 建 1 条线索，返回 id（默认 NEW + 2100 哨兵 = 待分配不起计时） */
function seedLead(tag: string, opts: { phone?: string; wechat?: string; contactType?: string; status?: string } = {}): number {
  const now = Date.now()
  const phone = opts.phone ?? `139${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`
  return crmDbService.runTx((tx) => tx.run(
    'INSERT INTO lead (contact_type, contact_normalized, contact_raw, wechat, source, name, status, first_contact_deadline, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [opts.contactType || 'phone', phone, phone, opts.wechat || '', '测试', tag, opts.status || 'NEW', LEAD_SLA_UNASSIGNED_SENTINEL, now, now]
  ))
}
/** 建 customer，返回 id */
function seedCustomer(name: string): number {
  const now = Date.now()
  return crmDbService.runTx((tx) => tx.run(
    'INSERT INTO customer (name, type, brand, vehicle_age, modified, source, updated_by, updated_at, version, deleted) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [name, '', '', null, 0, '测试', 'test', now, 1, 0]
  ))
}
/** 建 account（带锚点 + 可挂 customer），返回 id */
function seedAccount(name: string, opts: { phone?: string; sessionId?: string; customerId?: number }): number {
  const now = Date.now()
  return crmDbService.runTx((tx) => tx.run(
    'INSERT INTO account (name, phone, session_id, customer_id, created_at, updated_at) VALUES (?,?,?,?,?,?)',
    [name, opts.phone || '', opts.sessionId || null, opts.customerId ?? null, now, now]
  ))
}
function leadRow(id: number): Record<string, unknown> {
  return crmDbService.all('SELECT * FROM lead WHERE id = ?', [id])[0] || {}
}
function activeAssignment(leadId: number): Record<string, unknown> {
  return crmDbService.all("SELECT * FROM assignment WHERE lead_id = ? AND deleted = 0 AND status IN ('assigned','claimed') ORDER BY id DESC LIMIT 1", [leadId])[0] || {}
}
function identityRow(value: string): Record<string, unknown> {
  return crmDbService.all("SELECT * FROM customer_identity WHERE identity_type = 'wxid' AND identity_value = ?", [value])[0] || {}
}
function identityCount(value: string): number {
  return Number(crmDbService.all("SELECT COUNT(*) AS c FROM customer_identity WHERE identity_type = 'wxid' AND identity_value = ?", [value])[0]?.c || 0)
}
function bindAudits(leadId: number): Array<Record<string, unknown>> {
  return crmDbService.all("SELECT * FROM audit_event WHERE action = 'identity_bind' AND entity_type = 'lead' AND entity_id = ? ORDER BY id", [leadId])
}

async function main(): Promise<void> {
  const cfg = ConfigService.getInstance()
  cfg.set('crmSalesList', [S_A])
  cfg.set('crmLeadSlaHours', 24)
  const dbDir = mkdtempSync(join(tmpdir(), 'friend-detect-test-db-'))
  await crmDbService.initialize(dbDir)
  setIdentity(S_A, '销售')

  console.log('═══ A. 手动绑定四件套 ═══')
  const la = seedLead('A-线索')
  assignLeads([la], S_A, '')
  const rb = bindLeadWxid(la, ' wxid_friend_a ', { displayName: '老王' })
  ok('A1 绑定成功', rb.ok === true && rb.data?.alreadyBound === false && rb.data?.slaStopped === true, JSON.stringify(rb))
  const ia = identityRow('wxid_friend_a')
  ok('A2 wxid 归一化入库（去首尾空白）+ source=manual + confidence=1.0 + customer_id NULL',
    Number(ia.id) > 0 && ia.source === 'manual' && Number(ia.confidence) === 1 && (ia.customer_id == null || Number(ia.customer_id) === 0))
  const aa = bindAudits(la)
  ok('A3 审计 identity_bind 留痕', aa.length === 1)
  ok('A4 审计 actor = 身份档案署名「姓名（角色）」', String(aa[0]?.actor || '') === `${S_A}（销售）`, String(aa[0]?.actor))
  ok('A5 assignment 停表（sla1_met_at 非空）', Number(activeAssignment(la).sla1_met_at || 0) > 0)
  const laRow = leadRow(la)
  ok('A6 lead 状态 NEW→WX_ADDED + wechat 回填', laRow.status === 'WX_ADDED' && String(laRow.wechat) === 'wxid_friend_a')
  ok('A7 lead_activity 留 WX_ADDED 流水',
    crmDbService.all("SELECT * FROM lead_activity WHERE lead_id = ? AND action = 'WX_ADDED'", [la]).length === 1)

  console.log('\n═══ B. 幂等重复绑 ═══')
  const verBefore = Number(activeAssignment(la).version || 0)
  const rb2 = bindLeadWxid(la, 'wxid_friend_a', {})
  ok('B1 重复绑定 ok 且 alreadyBound=true（幂等提示）', rb2.ok === true && rb2.data?.alreadyBound === true && rb2.data?.slaStopped === false, JSON.stringify(rb2))
  ok('B2 identity 不重复插（唯一约束归并）', identityCount('wxid_friend_a') === 1)
  ok('B3 审计不重复写', bindAudits(la).length === 1)
  ok('B4 assignment version 不涨（零写入）', Number(activeAssignment(la).version || 0) === verBefore)

  console.log('\n═══ C. 参数与冲突 ═══')
  ok('C1 E101 空 wxid', bindLeadWxid(la, '   ').code === 'E101')
  ok('C2 E301 线索不存在', bindLeadWxid(999999, 'wxid_x').code === 'E301')
  // E204：wxid 已挂 customer C1，而线索手机号锚点解析到 customer C2 → 冲突不自动改挂
  const c1 = seedCustomer('客户甲')
  const c2 = seedCustomer('客户乙')
  crmDbService.runTx((tx) => {
    tx.run('INSERT INTO customer_identity (identity_type, identity_value, customer_id, source, confidence, updated_by, updated_at, version, deleted) VALUES (?,?,?,?,?,?,?,?,?)',
      ['wxid', 'wxid_conflict_1', c1, 'auto', 1.0, 'system:migration', Date.now(), 1, 0])
  })
  const lc = seedLead('C-冲突线索', { phone: '13811112222' })
  seedAccount('客户乙公司', { phone: '13811112222', customerId: c2 })
  assignLeads([lc], S_A, '')
  const rc = bindLeadWxid(lc, 'wxid_conflict_1')
  ok('C3 E204 wxid 已挂他 customer', rc.ok === false && rc.code === 'E204', JSON.stringify(rc))
  ok('C4 冲突零写入：identity 仍挂原 customer', Number(identityRow('wxid_conflict_1').customer_id) === c1)
  ok('C5 冲突零写入：不停表 + 无审计 + 状态不动',
    Number(activeAssignment(lc).sla1_met_at || 0) === 0 && bindAudits(lc).length === 0 && leadRow(lc).status === 'NEW')

  console.log('\n═══ D. customer_id 挂接（§2.4 能挂则挂）/ 后补关联 ═══')
  const cd1 = seedCustomer('客户丁')
  seedAccount('客户丁公司', { sessionId: 'wxid_d1', customerId: cd1 })
  const ld1 = seedLead('D1-线索', { wechat: 'wxid_d1' })
  assignLeads([ld1], S_A, '')
  const rd1 = bindLeadWxid(ld1, 'wxid_d1')
  ok('D1 锚点命中即挂 customer', rd1.ok === true && rd1.data?.customerId === cd1, JSON.stringify(rd1))
  ok('D2 identity 行 customer_id 已挂', Number(identityRow('wxid_d1').customer_id) === cd1)
  // 后补关联：既有 NULL identity（迁移③资源池合法态）绑定后补挂接
  const cd2 = seedCustomer('客户戊')
  seedAccount('客户戊公司', { sessionId: 'wxid_d2', customerId: cd2 })
  crmDbService.runTx((tx) => {
    tx.run('INSERT INTO customer_identity (identity_type, identity_value, customer_id, source, confidence, updated_by, updated_at, version, deleted) VALUES (?,?,?,?,?,?,?,?,?)',
      ['wxid', 'wxid_d2', null, 'auto', 1.0, 'system:migration', Date.now(), 1, 0])
  })
  const ld2 = seedLead('D2-线索', { wechat: 'wxid_d2' })
  assignLeads([ld2], S_A, '')
  const rd2 = bindLeadWxid(ld2, 'wxid_d2')
  ok('D3 NULL identity 后补挂接成功', rd2.ok === true && rd2.data?.customerId === cd2 && rd2.data?.alreadyBound === false, JSON.stringify(rd2))
  ok('D4 后补关联不新建行（唯一约束）', identityCount('wxid_d2') === 1 && Number(identityRow('wxid_d2').customer_id) === cd2)

  console.log('\n═══ E. 自动检测（保守版：精确等值，宁缺毋滥）═══')
  const contacts: ContactLite[] = [
    { username: 'wxid_e1', alias: 'ealias001', remark: '老王', nickname: '隔壁老王' },
    { username: 'wxid_e2', alias: '13800000099', remark: '李总', nickname: '李总' },
    { username: 'wxid_e3', remark: '张三', nickname: '张三' },
    { username: 'wxid_e6', alias: 'wxid_e6_alias', remark: '死者苏生?', nickname: 'x' },
    { username: 'group123@chatroom', alias: 'ealias001' }, // 群聊不参与匹配
    { username: 'gh_abcd', alias: 'ghalias' }              // 公众号不参与匹配
  ]
  const le1 = seedLead('E1-alias命中', { wechat: 'ealias001' })
  const le2 = seedLead('E2-手机号命中', { phone: '13800000099' })
  const le3 = seedLead('E3-未命中', { wechat: 'no_such_wxid_001' })
  const le4 = seedLead('E4-昵称同名不误伤', { phone: '13877776666', wechat: '' }) // 联系人 remark=张三，线索名也叫张三
  crmDbService.runTx((tx) => { tx.run("UPDATE lead SET name = '张三' WHERE id = ?", [le4]) })
  const le5 = seedLead('E5-claimed也扫', { wechat: 'wxid_e1' })
  const le6 = seedLead('E6-DEAD不复活', { wechat: 'wxid_e6_alias', status: 'DEAD' })
  for (const lid of [le1, le2, le3, le4, le5, le6]) assignLeads([lid], S_A, '')
  claimLead(le5, '') // le5 → claimed（身份档案姓名 = sales_name，判本人合法）

  const scan1 = runFriendDetectScan([{ account: 'wxid_test_main', contacts }])
  // 命中 4：le1(alias)、le2(手机号=alias 精确)、le5(username)、le6(DEAD 也停表)；le3 未命中、le4 昵称不匹配；
  // 扫描范围还含 C 组冲突线索 lc（assigned 未停表）= 7 行
  ok('E1 扫描覆盖全部未停表行', scan1.scanned === 7, JSON.stringify(scan1))
  ok('E2 精确命中 4 条（le1/le2/le5/le6）', scan1.matched === 4 && scan1.bound === 4, JSON.stringify(scan1))
  ok('E3 alias 命中归一到 username 入库（内部 id 改名不失效）', identityCount('wxid_e1') === 1 && identityCount('ealias001') === 0)
  const ae1 = bindAudits(le1)
  ok('E4 自动路审计 source=auto + actor=system:friend-detect',
    ae1.length === 1 && String(ae1[0]?.actor) === 'system:friend-detect' && String(ae1[0]?.detail).includes('"source":"auto"'))
  ok('E5 手机号精确命中（alias=11 位号码等值）', identityCount('wxid_e2') === 1 && leadRow(le2).status === 'WX_ADDED')
  ok('E6 未命中行不动（无 identity/不停表/状态 NEW）',
    identityCount('no_such_wxid_001') === 0 && Number(activeAssignment(le3).sla1_met_at || 0) === 0 && leadRow(le3).status === 'NEW')
  ok('E7 昵称永不作匹配依据：remark=张三 不命中同名线索',
    Number(activeAssignment(le4).sla1_met_at || 0) === 0 && leadRow(le4).status === 'NEW')
  ok('E8 claimed 行同样停表 + 推状态', Number(activeAssignment(le5).sla1_met_at || 0) > 0 && leadRow(le5).status === 'WX_ADDED')
  ok('E9 DEAD 线索：停表+登记 identity 但状态不复活', Number(activeAssignment(le6).sla1_met_at || 0) > 0 && leadRow(le6).status === 'DEAD')
  const auditTotal1 = Number(crmDbService.all("SELECT COUNT(*) AS c FROM audit_event WHERE action = 'identity_bind'")[0]?.c || 0)
  const scan2 = runFriendDetectScan([{ account: 'wxid_test_main', contacts }])
  ok('E10 重扫零重复写（已停表行不再扫，未命中行仍安全）',
    scan2.scanned === 3 && scan2.matched === 0 && Number(crmDbService.all("SELECT COUNT(*) AS c FROM audit_event WHERE action = 'identity_bind'")[0]?.c || 0) === auditTotal1,
    JSON.stringify(scan2))
  ok('E11 群聊/公众号被排除', identityCount('group123@chatroom') === 0 && identityCount('gh_abcd') === 0)

  console.log('\n═══ F. 回收器尊重停表 ═══')
  const past = Date.now() - 3600_000
  const lf1 = seedLead('F1-已停表过期')
  const lf2 = seedLead('F2-未停表过期')
  assignLeads([lf1, lf2], S_A, '')
  bindLeadWxid(lf1, 'wxid_f1') // 停表
  crmDbService.runTx((tx) => { tx.run('UPDATE assignment SET sla1_deadline = ? WHERE lead_id IN (?,?)', [past, lf1, lf2]) }) // 强制过期
  const rec = runSla1Recycle()
  ok('F1 已停表过期行不回收', activeAssignment(lf1).status === 'assigned', `status=${String(activeAssignment(lf1).status)}`)
  // 三次提醒制（设计稿屏 4/屏 6）：未停表过期行首扫只提醒不回收；停表行连提醒都不进
  ok('F2 未停表过期行只提醒不回收（三次提醒制）',
    rec.recycled === 0 && rec.reminded === 1 && activeAssignment(lf2).status === 'assigned'
      && Number(activeAssignment(lf2).sla1_remind_count || 0) === 1, JSON.stringify(rec))

  console.log(`\n═══ 结果：${pass} 通过 / ${fail} 失败 ═══`)
  process.exit(fail ? 1 : 0)
}

void main()
