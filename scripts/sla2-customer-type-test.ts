/**
 * sla2-customer-type-test.ts —— PRD §1.4 两段接力 SLA 第二段 + §1.5 客户类型 副本隔离验证
 *
 * 覆盖：
 *   A. SLA2 写入口径 markSla2ScanResult：标记列 JSON 落库 + 审计 sla2_scan_result + actor 署名
 *   B. 参数/状态守卫：E101 非法 verdict/confidence/scanRef/leadId；E301 无有效分配；E201 第二段未开始（未停 SLA1 表）
 *   C. 幂等：同 (verdict, scanRef, source) 重放 alreadyMarked 零写入；新 scanRef 允许覆盖 + 审计记 prevVerdict
 *   D. 规则骨架 runSla2RuleScan：停表后客户有回复→contacted(confidence=1.0)；仅己方消息/回复早于停表→不写；
 *      无绑定会话→跳过；claimed 行同扫；重扫零重复；SLA1 回收器不碰第二段域（已停表过期行不回收）
 *   E. 云推理脱敏 maskPrivateText（宪法 §2.6）：手机号/微信号/身份证号 → ***
 *   F. 客户类型 setCustomerType（PRD §1.5）：dealer/end_user 落库 + 审计（新旧值）；非法 E101；不存在 E301；
 *      同值 unchanged 零写入；'' 清除
 *   G. Schema 防线：customer.type / assignment.sla2_scan_ref 列存在（fresh 库 PRAGMA 核验）
 *
 * 隔离：WEFLOW_WORKER='1' + WEFLOW_USER_DATA_PATH / WEFLOW_CONFIG_CWD 指向 /tmp 临时目录，
 *       crmDb 用全新空库（fresh），绝不碰 live 库与真实配置。
 * 运行：npx tsx scripts/sla2-customer-type-test.ts
 */
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// 隔离 config 落盘路径（必须在 import 前设置）
const isoDir = mkdtempSync(join(tmpdir(), 'sla2-customer-type-test-'))
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
import { bindLeadWxid } from '../electron/services/crmFriendDetectService'
import { markSla2ScanResult, runSla2RuleScan, parseSla2ScanRef, maskPrivateText, type Sla2MessageLite } from '../electron/services/crmSla2Service'
import { setCustomerType, getCustomerById } from '../electron/services/crmCustomerService'
import { LEAD_SLA_UNASSIGNED_SENTINEL } from '../shared/leadSla'

const S_A = '测试销售甲'

function seedLead(tag: string, opts: { phone?: string; wechat?: string; status?: string } = {}): number {
  const now = Date.now()
  const phone = opts.phone ?? `139${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`
  return crmDbService.runTx((tx) => tx.run(
    'INSERT INTO lead (contact_type, contact_normalized, contact_raw, wechat, source, name, status, first_contact_deadline, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    ['phone', phone, phone, opts.wechat || '', '测试', tag, opts.status || 'NEW', LEAD_SLA_UNASSIGNED_SENTINEL, now, now]
  ))
}
function seedCustomer(name: string): number {
  const now = Date.now()
  return crmDbService.runTx((tx) => tx.run(
    'INSERT INTO customer (name, type, brand, vehicle_age, modified, source, updated_by, updated_at, version, deleted) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [name, '', '', null, 0, '测试', 'test', now, 1, 0]
  ))
}
function activeAssignment(leadId: number): Record<string, unknown> {
  return crmDbService.all("SELECT * FROM assignment WHERE lead_id = ? AND deleted = 0 AND status IN ('assigned','claimed') ORDER BY id DESC LIMIT 1", [leadId])[0] || {}
}
function sla2Audits(leadId: number): Array<Record<string, unknown>> {
  return crmDbService.all("SELECT * FROM audit_event WHERE action = 'sla2_scan_result' AND entity_type = 'lead' AND entity_id = ? ORDER BY id", [leadId])
}
function typeAudits(customerId: number): Array<Record<string, unknown>> {
  return crmDbService.all("SELECT * FROM audit_event WHERE action = 'customer_type_set' AND entity_type = 'customer' AND entity_id = ? ORDER BY id", [customerId])
}

async function main(): Promise<void> {
  const cfg = ConfigService.getInstance()
  cfg.set('crmSalesList', [S_A])
  cfg.set('crmLeadSlaHours', 24)
  const dbDir = mkdtempSync(join(tmpdir(), 'sla2-customer-type-test-db-'))
  await crmDbService.initialize(dbDir)
  setIdentity(S_A, '销售')

  console.log('═══ G. Schema 防线（先跑，防列缺失后续断言全空）═══')
  const custCols = crmDbService.all('PRAGMA table_info(customer)').map((c) => String(c.name))
  const asgCols = crmDbService.all('PRAGMA table_info(assignment)').map((c) => String(c.name))
  ok('G1 customer.type 列存在（PRD §1.5）', custCols.includes('type'))
  ok('G2 assignment.sla2_scan_ref 列存在（PRD §1.4 第二段标记列）', asgCols.includes('sla2_scan_ref'))

  console.log('\n═══ A. SLA2 写入口径 ═══')
  const la = seedLead('A-线索')
  assignLeads([la], S_A, '')
  bindLeadWxid(la, 'wxid_sla2_a', { displayName: '老王' }) // 停 SLA1 表 + lead.wechat 回填
  const ra = markSla2ScanResult(la, { verdict: 'contacted', confidence: 1.0, scanRef: 'mk-a-001', source: 'llm', note: 'LLM 判定已有效触达' })
  ok('A1 写入成功', ra.ok === true && ra.data?.alreadyMarked === false && Number(ra.data?.assignmentId) > 0, JSON.stringify(ra))
  const refA = parseSla2ScanRef(activeAssignment(la).sla2_scan_ref)
  ok('A2 标记列 JSON 落库（verdict/confidence/scanRef/source/at）',
    refA?.verdict === 'contacted' && refA?.confidence === 1 && refA?.scanRef === 'mk-a-001' && refA?.source === 'llm' && Number(refA?.at) > 0, JSON.stringify(refA))
  const aa = sla2Audits(la)
  ok('A3 审计 sla2_scan_result 留痕', aa.length === 1)
  ok('A4 LLM/人工路 actor = 身份档案署名「姓名（角色）」', String(aa[0]?.actor || '') === `${S_A}（销售）`, String(aa[0]?.actor))

  console.log('\n═══ B. 参数/状态守卫 ═══')
  ok('B1 E101 非法 verdict', markSla2ScanResult(la, { verdict: 'bad' as never, confidence: 0.5, scanRef: 'x' }).code === 'E101')
  ok('B2 E101 confidence 出界', markSla2ScanResult(la, { verdict: 'contacted', confidence: 1.5, scanRef: 'x' }).code === 'E101')
  ok('B3 E101 scanRef 空', markSla2ScanResult(la, { verdict: 'contacted', confidence: 1, scanRef: '  ' }).code === 'E101')
  ok('B4 E101 leadId 非法', markSla2ScanResult(-1, { verdict: 'contacted', confidence: 1, scanRef: 'x' }).code === 'E101')
  ok('B5 E301 无有效分配', markSla2ScanResult(999999, { verdict: 'contacted', confidence: 1, scanRef: 'x' }).code === 'E301')
  const lb = seedLead('B-未停表线索')
  assignLeads([lb], S_A, '')
  const rb5 = markSla2ScanResult(lb, { verdict: 'contacted', confidence: 1, scanRef: 'x' })
  ok('B6 E201 第二段未开始（未停 SLA1 表）', rb5.ok === false && rb5.code === 'E201', JSON.stringify(rb5))
  ok('B7 守卫失败零写入（无审计）', sla2Audits(lb).length === 0 && sla2Audits(999999).length === 0)

  console.log('\n═══ C. 幂等与覆盖 ═══')
  const verC = Number(activeAssignment(la).version || 0)
  const rc1 = markSla2ScanResult(la, { verdict: 'contacted', confidence: 1.0, scanRef: 'mk-a-001', source: 'llm' })
  ok('C1 同结论重放 alreadyMarked 零写入', rc1.ok === true && rc1.data?.alreadyMarked === true && Number(activeAssignment(la).version || 0) === verC)
  ok('C2 重放不重复审计', sla2Audits(la).length === 1)
  const rc3 = markSla2ScanResult(la, { verdict: 'need_intervention', confidence: 0.4, scanRef: 'mk-a-002', source: 'llm', note: '7 天无互动' })
  ok('C3 新结论允许覆盖（最新扫描胜出）', rc3.ok === true && rc3.data?.alreadyMarked === false)
  const refC = parseSla2ScanRef(activeAssignment(la).sla2_scan_ref)
  const ac3 = sla2Audits(la)
  ok('C4 覆盖后标记列更新 + 审计记 prevVerdict',
    refC?.verdict === 'need_intervention' && ac3.length === 2 && String(ac3[1]?.detail).includes('"prevVerdict":"contacted"'), JSON.stringify(ac3[1]?.detail))
  ok('C5 低置信转人工占位：verdict=uncertain 可写',
    markSla2ScanResult(la, { verdict: 'uncertain', confidence: 0.3, scanRef: 'mk-a-003', source: 'llm' }).ok === true)

  console.log('\n═══ D. 规则骨架扫描 ═══')
  const now = Date.now()
  // d1: 停表后客户有回复 → contacted
  const ld1 = seedLead('D1-有回复')
  // d2: 停表后只有己方消息 → 不写
  const ld2 = seedLead('D2-只己方')
  // d3: 回复早于停表时刻 → 不写
  const ld3 = seedLead('D3-回复太早', { wechat: 'wxid_sla2_d3' })
  // d4: 已停表但无绑定会话（手工 UPDATE 停表，wechat 空）→ 跳过
  const ld4 = seedLead('D4-无会话')
  // d5: claimed 行同扫
  const ld5 = seedLead('D5-claimed')
  for (const lid of [ld1, ld2, ld3, ld4, ld5]) assignLeads([lid], S_A, '')
  bindLeadWxid(ld1, 'wxid_sla2_d1')
  bindLeadWxid(ld2, 'wxid_sla2_d2')
  // d3 不停表，手工补 sla1_met_at = now（模拟停表）但消息在停表前
  crmDbService.runTx((tx) => { tx.run('UPDATE assignment SET sla1_met_at = ? WHERE lead_id = ?', [now, ld3]) })
  crmDbService.runTx((tx) => { tx.run('UPDATE assignment SET sla1_met_at = ? WHERE lead_id = ?', [now, ld4]) }) // d4 停表但 lead.wechat 空
  bindLeadWxid(ld5, 'wxid_sla2_d5')
  claimLead(ld5, '') // → claimed

  const stop1 = Number(activeAssignment(ld1).sla1_met_at || 0)
  const stop2 = Number(activeAssignment(ld2).sla1_met_at || 0)
  const stop5 = Number(activeAssignment(ld5).sla1_met_at || 0)
  const msgMap: Record<string, Sla2MessageLite[]> = {
    wxid_sla2_d1: [
      { isSend: 1, createTimeMs: stop1 + 1000, messageKey: 'mk-d1-own' },
      { isSend: 0, createTimeMs: stop1 + 2000, messageKey: 'mk-d1-reply' }
    ],
    wxid_sla2_d2: [{ isSend: 1, createTimeMs: stop2 + 5000, messageKey: 'mk-d2-own' }],
    wxid_sla2_d3: [{ isSend: 0, createTimeMs: now - 3600_000, messageKey: 'mk-d3-early' }],
    wxid_sla2_d5: [{ isSend: 0, createTimeMs: stop5 + 3000, messageKey: 'mk-d5-reply' }]
  }
  const fetcher = async (sessionId: string): Promise<Sla2MessageLite[]> => msgMap[sessionId] || []
  const scan1 = await runSla2RuleScan(fetcher)
  // 扫描范围：已停表且 sla2_scan_ref 为空的行 = la（已被 C5 写过标记，不在范围）外的 ld1/ld2/ld3/ld4/ld5 = 5 行
  ok('D1 扫描覆盖全部「已停表+未标记」行', scan1.scanned === 5, JSON.stringify(scan1))
  ok('D2 客户停表后回复 → contacted 标记 2 条（ld1/ld5）', scan1.marked === 2, JSON.stringify(scan1))
  ok('D3 规则命中写 confidence=1.0 + source=rule + scanRef=messageKey',
    parseSla2ScanRef(activeAssignment(ld1).sla2_scan_ref)?.scanRef === 'mk-d1-reply'
    && parseSla2ScanRef(activeAssignment(ld1).sla2_scan_ref)?.source === 'rule'
    && parseSla2ScanRef(activeAssignment(ld1).sla2_scan_ref)?.confidence === 1)
  const ad1 = sla2Audits(ld1)
  ok('D4 规则路审计 actor=system:sla2-scan', ad1.length === 1 && String(ad1[0]?.actor) === 'system:sla2-scan', String(ad1[0]?.actor))
  ok('D5 仅己方消息不下结论（零写入）', String(activeAssignment(ld2).sla2_scan_ref || '') === '' && sla2Audits(ld2).length === 0)
  ok('D6 回复早于停表时刻不算（零写入）', String(activeAssignment(ld3).sla2_scan_ref || '') === '')
  ok('D7 无绑定会话跳过（skipped 计数）', scan1.skipped === 1 && String(activeAssignment(ld4).sla2_scan_ref || '') === '', JSON.stringify(scan1))
  ok('D8 claimed 行同样可标记', parseSla2ScanRef(activeAssignment(ld5).sla2_scan_ref)?.scanRef === 'mk-d5-reply')
  const auditTotal = Number(crmDbService.all("SELECT COUNT(*) AS c FROM audit_event WHERE action = 'sla2_scan_result'")[0]?.c || 0)
  const scan2 = await runSla2RuleScan(fetcher)
  ok('D9 重扫零重复（已标记行出扫描域，余下行仍安全）',
    scan2.scanned === 3 && scan2.marked === 0 && Number(crmDbService.all("SELECT COUNT(*) AS c FROM audit_event WHERE action = 'sla2_scan_result'")[0]?.c || 0) === auditTotal,
    JSON.stringify(scan2))

  // 回收器尊重第二段域：已停表（含已标记）的过期行不被 SLA1 回收器回收
  const past = now - 3600_000
  crmDbService.runTx((tx) => { tx.run('UPDATE assignment SET sla1_deadline = ? WHERE lead_id IN (?,?)', [past, ld1, lb]) })
  runSla1Recycle()
  ok('D10 已停表+已标记的过期行不被 SLA1 回收', activeAssignment(ld1).status === 'assigned', `status=${String(activeAssignment(ld1).status)}`)
  ok('D11 未停表过期行照收（回收器口径未变）', Object.keys(activeAssignment(lb)).length === 0)

  console.log('\n═══ E. 云推理脱敏（宪法 §2.6）═══')
  const masked = maskPrivateText('客户手机 13812345678，微信 wxid_abc123，身份证 11010119900307777X，型号 EPT20')
  ok('E1 手机号打码', !masked.includes('13812345678') && masked.includes('***'), masked)
  ok('E2 wxid 打码', !masked.includes('wxid_abc123'), masked)
  ok('E3 身份证号打码', !masked.includes('11010119900307777X'), masked)
  ok('E4 非私密内容原样保留', masked.includes('型号 EPT20'), masked)
  ok('E5 空/异常输入不崩', maskPrivateText('') === '' && maskPrivateText(null as never) === '')

  console.log('\n═══ F. 客户类型（PRD §1.5）═══')
  const c1 = seedCustomer('客户甲')
  const rf1 = setCustomerType(c1, 'dealer')
  ok('F1 设置 dealer 成功', rf1.ok === true && rf1.data?.unchanged === false && String(getCustomerById(c1)?.type) === 'dealer', JSON.stringify(rf1))
  const af1 = typeAudits(c1)
  ok('F2 审计 customer_type_set 留痕（含新旧值 + actor 署名）',
    af1.length === 1 && String(af1[0]?.detail).includes('"oldType":""') && String(af1[0]?.detail).includes('"newType":"dealer"')
    && String(af1[0]?.actor) === `${S_A}（销售）`, JSON.stringify(af1[0]))
  const ver1 = Number(getCustomerById(c1)?.version || 0)
  const rf2 = setCustomerType(c1, 'dealer')
  ok('F3 同值重放 unchanged 零写入零新审计', rf2.ok === true && rf2.data?.unchanged === true && Number(getCustomerById(c1)?.version) === ver1 && typeAudits(c1).length === 1)
  ok('F4 改为 end_user', setCustomerType(c1, 'end_user').ok === true && String(getCustomerById(c1)?.type) === 'end_user')
  ok('F5 E101 非法类型', setCustomerType(c1, 'vip').code === 'E101')
  ok('F6 E301 客户不存在', setCustomerType(999999, 'dealer').code === 'E301')
  ok('F7 清除回未设置（\'\'）', setCustomerType(c1, '').ok === true && String(getCustomerById(c1)?.type) === '')

  console.log(`\n═══ 结果：${pass} 通过 / ${fail} 失败 ═══`)
  process.exit(fail ? 1 : 0)
}

void main()
