/**
 * assignment-full-test.ts —— 线索分配 Phase 1 完整版（claim/recycle/transfer + SLA 起计时 + 回收器）验证
 *
 * 覆盖（API-CONTRACT §1.14 契约 265-268 行）：
 *   A. assign 起计时：sla1_deadline = now + crmLeadSlaHours；lead.first_contact_deadline 从 2100 哨兵改为同一期限
 *   B. claim 状态机：合法 assigned→claimed / 重复 claim E201 / 非本人 E201 / 无分配行 E301 /
 *      身份档案挂钩（actor 空时按身份姓名判本人，审计署名「姓名（角色）」）/ claim 不写 ownership_history
 *   C. recycle：三表同事务 + lead 哨兵重置 + 重复回收 E202 + 无行 E301 + 回池后可再 assign
 *   D. transfer：旧行 transferred + 新行 assigned（重起 SLA1）+ E203 目标销售不存在 + E201 同人/旧行
 *      + ownership 流水 reason=移交 + 移交后可被新销售 claim
 *   E. SLA1 三次提醒回收器（设计稿屏 4/屏 6）：首超时只提醒不回收 / 间隔不足 20h 不重复提醒 /
 *      满第 3 次才回收（SLA三次超时回收）+ outbox 抄送主管 / claimed 纳入扫描 / 停表跳过 / 重跑幂等
 *   F. 存量补写：sla1_deadline NULL 行补 = 分配时间(updated_at) + 24h / 幂等 / 汇总审计 / 非 NULL 不动
 *
 * 隔离：WEFLOW_WORKER='1' + WEFLOW_USER_DATA_PATH / WEFLOW_CONFIG_CWD 指向 /tmp（config.ts:358-364
 *       仅 worker 模式才把 store cwd 指向 WEFLOW_CONFIG_CWD，否则落 ~/Library/Preferences 互相污染）；
 *       crmDb 用 fresh 空库，绝不碰 live 库与真实配置。
 * 运行：npx tsx scripts/assignment-full-test.ts
 */
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// 隔离 config 落盘路径（必须在 import 前设置）
const isoDir = mkdtempSync(join(tmpdir(), 'assignment-full-test-'))
process.env.WEFLOW_WORKER = '1'
process.env.WEFLOW_USER_DATA_PATH = isoDir
process.env.WEFLOW_CONFIG_CWD = isoDir

let pass = 0, fail = 0
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; console.log(`  ✅ ${name}`) } else { fail++; console.log(`  ❌ ${name} ${detail}`) }
}

import { ConfigService } from '../electron/services/config'
import { crmDbService } from '../electron/services/crmDbService'
import { salesDbService } from '../electron/services/salesDbService'
import { setIdentity } from '../electron/services/identityService'
import {
  assignLeads, claimLead, recycleAssignment, transferAssignment, currentAssignment,
  runSla1Recycle, backfillAssignmentSla1, correctSla1Misrecycle, assignBatchLeads, buildDistribution
} from '../electron/services/crmAssignmentService'
import { importLeads } from '../electron/services/crmLeadService'
import { distributePreview } from '../src/utils/leadAssignmentView'
import { LEAD_SLA_UNASSIGNED_SENTINEL } from '../shared/leadSla'

const S_A = '测试销售甲'
const S_B = '测试销售乙'
const S_C = '测试销售丙'
const SLA_MS = 24 * 3600_000

/** 建 1 条 NEW 线索（first_contact_deadline = 2100 哨兵 = 待分配不起计时），返回 id */
function seedLead(tag: string): number {
  const now = Date.now()
  return crmDbService.runTx((tx) => tx.run(
    'INSERT INTO lead (contact_type, contact_normalized, contact_raw, wechat, source, name, status, first_contact_deadline, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    ['phone', `138${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`, tag, '', '测试', tag, 'NEW', LEAD_SLA_UNASSIGNED_SENTINEL, now, now]
  ))
}

function leadDeadline(leadId: number): number {
  return Number(crmDbService.all('SELECT first_contact_deadline AS d FROM lead WHERE id = ?', [leadId])[0]?.d || 0)
}
function assignRow(id: number): Record<string, unknown> {
  return crmDbService.all('SELECT * FROM assignment WHERE id = ?', [id])[0] || {}
}
function histRows(leadId: number): Array<Record<string, unknown>> {
  return crmDbService.all("SELECT * FROM ownership_history WHERE entity_type = 'lead' AND entity_id = ? ORDER BY id", [leadId])
}
function auditRows(leadId: number, action: string): Array<Record<string, unknown>> {
  return crmDbService.all('SELECT * FROM audit_event WHERE action = ? AND entity_type = ? AND entity_id = ? ORDER BY id', [action, 'lead', leadId])
}

async function main(): Promise<void> {
  const cfg = ConfigService.getInstance()
  cfg.set('crmSalesList', [S_A, S_B, S_C])
  cfg.set('crmLeadSlaHours', 24)
  const dbDir = mkdtempSync(join(tmpdir(), 'assignment-full-test-db-'))
  await crmDbService.initialize(dbDir)
  // importLeads → scanLeadSla → selfHealSlaTasks 会读 salesDb（SLA 行动卡），测试内一并初始化隔离库
  await salesDbService.initialize(dbDir)

  console.log('═══ A. assign 起计时（sla1_deadline + lead 哨兵覆盖）═══')
  const la = seedLead('A-线索')
  ok('A1 分配前 lead 为哨兵（待分配不起计时）', leadDeadline(la) === LEAD_SLA_UNASSIGNED_SENTINEL)
  const before = Date.now()
  const ra = assignLeads([la], S_A, '分配员')
  const aid = ra.data?.assignments[0]?.assignmentId ?? 0
  const aRow = assignRow(aid)
  const sla1 = Number(aRow.sla1_deadline || 0)
  ok('A2 assign 成功', ra.ok === true && aid > 0, JSON.stringify(ra))
  ok('A3 sla1_deadline ≈ now + 24h', sla1 >= before + SLA_MS && sla1 <= Date.now() + SLA_MS, `sla1=${sla1}`)
  ok('A4 lead.first_contact_deadline = sla1_deadline（哨兵被覆盖）', leadDeadline(la) === sla1, `实 ${leadDeadline(la)}`)

  console.log('\n═══ B. claim 状态机 ═══')
  const histBefore = histRows(la).length
  const rc1 = claimLead(la, S_A)
  ok('B1 本人 claim 成功', rc1.ok === true && rc1.data?.assignmentId === aid, JSON.stringify(rc1))
  ok('B2 状态 assigned→claimed', assignRow(aid).status === 'claimed')
  ok('B3 version 推进 + updated_by 署名', Number(assignRow(aid).version) === 2 && assignRow(aid).updated_by === S_A)
  const bAudits = auditRows(la, 'lead_claim')
  ok('B4 审计落行 action=lead_claim actor=销售', bAudits.length === 1 && bAudits[0].actor === S_A)
  ok('B5 claim 不写 ownership_history（归属没变）', histRows(la).length === histBefore)
  const rc2 = claimLead(la, S_A)
  ok('B6 重复 claim 被状态机拒（E201）', rc2.ok === false && rc2.code === 'E201', JSON.stringify(rc2))
  const lb = seedLead('B-线索')
  assignLeads([lb], S_A, '分配员')
  const rc3 = claimLead(lb, S_B)
  ok('B7 非本人 claim 拒（E201）', rc3.ok === false && rc3.code === 'E201', JSON.stringify(rc3))
  const rc4 = claimLead(seedLead('B-未分配'), S_A)
  ok('B8 无分配行 claim 拒（E301）', rc4.ok === false && rc4.code === 'E301', JSON.stringify(rc4))
  // 身份档案挂钩：actor 空时按身份姓名判本人，署名「姓名（角色）」
  setIdentity(S_B, '销售')
  const rc5 = claimLead(lb, '')
  ok('B9 actor 空 → 身份档案判本人，claim 仍拒（归属甲≠乙）', rc5.ok === false && rc5.code === 'E201')
  const lc = seedLead('B-乙的线索')
  assignLeads([lc], S_B, '分配员')
  const rc6 = claimLead(lc, '')
  ok('B10 身份档案本人 claim 成功', rc6.ok === true, JSON.stringify(rc6))
  ok('B11 审计署名 = 身份档案「姓名（角色）」', String(auditRows(lc, 'lead_claim')[0]?.actor) === `${S_B}（销售）`)
  setIdentity('', '') // 复位，避免影响后续兜底断言

  console.log('\n═══ C. recycle（哨兵重置 + 回池再分配）═══')
  const ld = seedLead('C-线索')
  const rd0 = assignLeads([ld], S_A, '分配员')
  const did = rd0.data?.assignments[0]?.assignmentId ?? 0
  const rr1 = recycleAssignment(did, '人工回收', '主管张某')
  ok('C1 回收成功', rr1.ok === true && rr1.data?.assignmentId === did, JSON.stringify(rr1))
  ok('C2 状态 → recycled', assignRow(did).status === 'recycled')
  const cHist = histRows(ld)
  ok('C3 ownership 流水 reason=人工回收 old=甲 new=空', cHist.length === 2 && cHist[1].reason === '人工回收' && cHist[1].old_owner === S_A && cHist[1].new_owner === '')
  const cAudits = auditRows(ld, 'lead_recycle')
  ok('C4 审计 lead_recycle actor=主管', cAudits.length === 1 && cAudits[0].actor === '主管张某')
  ok('C5 lead 哨兵重置（回资源池不起计时）', leadDeadline(ld) === LEAD_SLA_UNASSIGNED_SENTINEL, `实 ${leadDeadline(ld)}`)
  const rr2 = recycleAssignment(did, '重复回收', '主管张某')
  ok('C6 重复回收拒（E202）', rr2.ok === false && rr2.code === 'E202', JSON.stringify(rr2))
  ok('C7 E202 不产生副作用', histRows(ld).length === 2 && auditRows(ld, 'lead_recycle').length === 1)
  const rr3 = recycleAssignment(999999999, 'x', '主管张某')
  ok('C8 无行回收拒（E301）', rr3.ok === false && rr3.code === 'E301')
  const rr4 = assignLeads([ld], S_B, '分配员')
  ok('C9 回池后可再 assign', rr4.ok === true && rr4.data?.assignments.length === 1, JSON.stringify(rr4))
  ok('C10 再分配重新起计时', leadDeadline(ld) > Date.now() + SLA_MS - 60_000)
  ok('C11 当前归属 = 新销售', currentAssignment(ld)?.sales_name === S_B)

  console.log('\n═══ D. transfer（旧行 transferred + 新行 assigned）═══')
  const le = seedLead('D-线索')
  const rt0 = assignLeads([le], S_A, '分配员')
  const eid = rt0.data?.assignments[0]?.assignmentId ?? 0
  const rt1 = transferAssignment(eid, S_C, '调岗移交', '主管张某')
  const newId = rt1.data?.assignmentId ?? 0
  ok('D1 移交成功返回新行 id', rt1.ok === true && newId > eid, JSON.stringify(rt1))
  ok('D2 旧行 → transferred', assignRow(eid).status === 'transferred')
  const nRow = assignRow(newId)
  ok('D3 新行 assigned + 乙→丙 + source=transfer', nRow.status === 'assigned' && nRow.sales_name === S_C && nRow.source === 'transfer')
  ok('D4 新行重新起 SLA1', Number(nRow.sla1_deadline) > Date.now() + SLA_MS - 60_000)
  const dHist = histRows(le)
  ok('D5 ownership 流水 reason=调岗移交 甲→丙', dHist.length === 2 && dHist[1].reason === '调岗移交' && dHist[1].old_owner === S_A && dHist[1].new_owner === S_C)
  const dAudits = auditRows(le, 'lead_transfer')
  ok('D6 审计 lead_transfer detail 含双销售', dAudits.length === 1 && String(dAudits[0].detail).includes(S_A) && String(dAudits[0].detail).includes(S_C))
  ok('D7 lead 期限跟随新 sla1', leadDeadline(le) === Number(nRow.sla1_deadline))
  ok('D8 当前归属 = 丙', currentAssignment(le)?.sales_name === S_C)
  const rt2 = transferAssignment(newId, '不存在的人', 'x', '主管张某')
  ok('D9 目标销售不存在拒（E203）', rt2.ok === false && rt2.code === 'E203', JSON.stringify(rt2))
  const rt3 = transferAssignment(newId, S_C, 'x', '主管张某')
  ok('D10 移交同一人拒（E201）', rt3.ok === false && rt3.code === 'E201')
  const rt4 = transferAssignment(eid, S_B, 'x', '主管张某')
  ok('D11 旧行（transferred）不可再移交（E201）', rt4.ok === false && rt4.code === 'E201')
  const rt5 = transferAssignment(999999999, S_B, 'x', '主管张某')
  ok('D12 无行移交拒（E301）', rt5.ok === false && rt5.code === 'E301')
  const rt6 = transferAssignment(newId, '', 'x', '主管张某')
  ok('D13 缺 toSales 拒（E101）', rt6.ok === false && rt6.code === 'E101')
  ok('D14 失败移交零副作用', histRows(le).length === 2 && auditRows(le, 'lead_transfer').length === 1)
  const rc7 = claimLead(le, S_C)
  ok('D15 移交后新销售可 claim（最新行语义）', rc7.ok === true, JSON.stringify(rc7))

  console.log('\n═══ E. SLA1 三次提醒回收器（设计稿屏 4/屏 6，宪法 §1.3 修订）═══')
  const e1 = seedLead('E-过期') // 走满三次提醒→回收全流程
  const e2 = seedLead('E-未过期') // 不动
  const e3 = seedLead('E-已认领') // claimed 纳入扫描（提醒不回收）
  const e4 = seedLead('E-已停表') // sla1_met_at 非空 → 跳过
  const e1id = assignLeads([e1], S_A, '分配员').data?.assignments[0]?.assignmentId ?? 0
  const e2id = assignLeads([e2], S_A, '分配员').data?.assignments[0]?.assignmentId ?? 0
  const e3id = assignLeads([e3], S_A, '分配员').data?.assignments[0]?.assignmentId ?? 0
  const e4id = assignLeads([e4], S_A, '分配员').data?.assignments[0]?.assignmentId ?? 0
  claimLead(e3, S_A)
  // 手工把 e1/e3/e4 的 sla1 拨到过去（模拟超时）；e4 额外停表
  crmDbService.run('UPDATE assignment SET sla1_deadline = ? WHERE id IN (?,?,?)', [Date.now() - 1000, e1id, e3id, e4id])
  crmDbService.run('UPDATE assignment SET sla1_met_at = ? WHERE id = ?', [Date.now() - 500, e4id])

  // 第 1 轮：只提醒不回收
  const rec1 = runSla1Recycle()
  ok('E1 本轮 0 回收 2 提醒（e1 assigned + e3 claimed，e4 停表跳过）',
    rec1.recycled === 0 && rec1.reminded === 2, `实 recycle=${rec1.recycled} remind=${rec1.reminded}`)
  ok('E2 过期行状态不动（只提醒不回收）', assignRow(e1id).status === 'assigned' && assignRow(e3id).status === 'claimed')
  ok('E3 未过期行不动', assignRow(e2id).status === 'assigned' && Number(assignRow(e2id).sla1_remind_count || 0) === 0)
  ok('E4 提醒计数 =1（首提不受 20h 间隔限制）',
    Number(assignRow(e1id).sla1_remind_count || 0) === 1 && Number(assignRow(e3id).sla1_remind_count || 0) === 1)
  ok('E5 claimed 行纳入扫描且沿用分配计时（sla1_deadline 未被认领重置）',
    Number(assignRow(e3id).sla1_remind_count || 0) === 1 && Number(assignRow(e3id).sla1_deadline) < Date.now())
  const eRemindAudits = auditRows(e1, 'sla1_remind')
  ok('E6 提醒审计 action=sla1_remind detail 含第几次',
    eRemindAudits.length === 1 && JSON.parse(String(eRemindAudits[0].detail)).remindNo === 1 && eRemindAudits[0].actor === 'system:sla')
  ok('E7 提醒零归属变更（ownership_history 不写、lead 哨兵不动）',
    histRows(e1).length === 1 && leadDeadline(e1) !== LEAD_SLA_UNASSIGNED_SENTINEL)

  // 第 2 轮：间隔不足 → 不重复提醒（§2.54 教训：防 30 分钟轮巡一轮刷满）
  const rec2 = runSla1Recycle()
  ok('E8 间隔不足 20h → 不重复提醒', rec2.reminded === 0 && rec2.recycled === 0 && Number(assignRow(e1id).sla1_remind_count || 0) === 1)

  // 第 3 轮：回拨 updated_at 模拟 21h 后复查 → 第 2 次提醒
  crmDbService.run('UPDATE assignment SET updated_at = ? WHERE id = ?', [Date.now() - 21 * 3600_000, e1id])
  const rec3 = runSla1Recycle()
  ok('E9 满 20h → 第 2 次提醒（仍不回收）',
    rec3.reminded === 1 && rec3.recycled === 0 && Number(assignRow(e1id).sla1_remind_count || 0) === 2 && assignRow(e1id).status === 'assigned')

  // 第 4 轮：再回拨 → 第 3 次超时 → 才回收 + 抄送主管
  crmDbService.run('UPDATE assignment SET updated_at = ? WHERE id = ?', [Date.now() - 21 * 3600_000, e1id])
  const rec4 = runSla1Recycle()
  ok('E10 满第 3 次超时 → 回收', rec4.recycled === 1 && assignRow(e1id).status === 'recycled')
  const eHist = histRows(e1)
  ok('E11 回收流水 reason=SLA三次超时回收 actor=system:sla',
    eHist[eHist.length - 1]?.reason === 'SLA三次超时回收' && eHist[eHist.length - 1]?.actor === 'system:sla')
  const eAudits = auditRows(e1, 'lead_recycle')
  ok('E12 回收审计 actor=system:sla reason=SLA三次超时回收',
    eAudits.length === 1 && eAudits[0].actor === 'system:sla' && JSON.parse(String(eAudits[0].detail)).reason === 'SLA三次超时回收')
  ok('E13 回收后 lead 回哨兵', leadDeadline(e1) === LEAD_SLA_UNASSIGNED_SENTINEL)
  ok('E14 全程恰 2 条提醒审计（第 3 次直接回收不重复提醒）', auditRows(e1, 'sla1_remind').length === 2)
  const outboxRow = crmDbService.all("SELECT * FROM outbox_event WHERE idempotency_key = ?", [`sla1Escalate:${e1id}`])[0]
  ok('E15 outbox 抄送主管占位 type=sla1_escalate_supervisor（§1.11 只记录不发送）',
    !!outboxRow && JSON.parse(String(outboxRow.payload)).type === 'sla1_escalate_supervisor' && String(outboxRow.status) === 'pending')

  // 第 5 轮：重跑幂等（回收行 status=recycled 出扫描范围；e3 已提醒 1 次但间隔不足）
  const rec5 = runSla1Recycle()
  ok('E16 重跑幂等（0 回收 0 提醒）', rec5.recycled === 0 && rec5.reminded === 0, `实 recycle=${rec5.recycled} remind=${rec5.reminded}`)
  const reRe = assignLeads([e1], S_B, '分配员')
  ok('E17 回收回池后可再分配（新行 remind_count 从 0 起）',
    reRe.ok === true && reRe.data?.assignments.length === 1 && Number(assignRow(Number(reRe.data?.assignments[0]?.assignmentId)).sla1_remind_count || 0) === 0)

  console.log('\n═══ F. 存量 sla1_deadline NULL 补写（幂等迁移块）═══')
  const f1 = seedLead('F-存量')
  // 模拟上线前的存量行：status=assigned 且 sla1_deadline NULL（绕开 assignLeads 直插）；
  // updated_at 故意拨到 3 天前——验证补写以「执行时刻」为基点（§2.54 事故教训：用分配时刻会立即过期）
  const stale = Date.now() - 3 * 86400_000
  const fid = crmDbService.runTx((tx) => tx.run(
    'INSERT INTO assignment (lead_id, sales_name, mode, sla1_deadline, sla2_scan_ref, status, source, updated_by, updated_at, version, deleted) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    [f1, S_A, 'manual', null, '', 'assigned', 'manual', '分配员', stale, 1, 0]
  ))
  const f2 = seedLead('F-新行') // 已有 sla1 的行不动
  const f2id = assignLeads([f2], S_A, '分配员').data?.assignments[0]?.assignmentId ?? 0
  const f2sla = Number(assignRow(f2id).sla1_deadline)
  const beforeFill = Date.now()
  const filled1 = backfillAssignmentSla1()
  ok('F1 补写 1 条 NULL 行', filled1 === 1, `实 ${filled1}`)
  const fSla = Number(assignRow(fid).sla1_deadline)
  ok('F2 补写值 = 执行时刻 + 24h（在未来窗口内，非分配时刻）', fSla >= beforeFill + SLA_MS && fSla <= Date.now() + SLA_MS, `实 ${fSla}`)
  ok('F2b 补写值 ≠ 分配时刻+24h（§2.54 回归防线）', fSla !== stale + SLA_MS)
  ok('F3 已有 sla1 的行不动', Number(assignRow(f2id).sla1_deadline) === f2sla)
  const bfAudit = crmDbService.all("SELECT * FROM audit_event WHERE action = 'assignment_sla1_backfill' ORDER BY id DESC LIMIT 1")
  ok('F4 汇总审计落行 actor=system:migration', bfAudit.length === 1 && bfAudit[0].actor === 'system:migration' && String(bfAudit[0].detail).includes('"count":1'))
  const filled2 = backfillAssignmentSla1()
  ok('F5 重跑幂等（0 条，审计不重复）', filled2 === 0
    && crmDbService.all("SELECT COUNT(*) AS c FROM audit_event WHERE action = 'assignment_sla1_backfill'")[0].c === 1)

  console.log('\n═══ G. SLA1 误扫纠正（§2.54 事故恢复，fresh 库构造误扫现场）═══')
  // 构造：3 条分配 → 拨 sla1 到过去 → runSla1Recycle 模拟误扫 → correctSla1Misrecycle 恢复
  const g1 = seedLead('G-误扫1') // 应被纠正
  const g2 = seedLead('G-误扫2') // 应被纠正
  const g3 = seedLead('G-误扫3') // 误扫后又被人工再分配 → 纠正跳过（数据级判重）
  const g4 = seedLead('G-正常') // 未被误扫，不动
  const g1id = assignLeads([g1], S_A, '分配员').data?.assignments[0]?.assignmentId ?? 0
  const g2id = assignLeads([g2], S_B, '分配员').data?.assignments[0]?.assignmentId ?? 0
  const g3id = assignLeads([g3], S_A, '分配员').data?.assignments[0]?.assignmentId ?? 0
  const g4id = assignLeads([g4], S_C, '分配员').data?.assignments[0]?.assignmentId ?? 0
  crmDbService.run('UPDATE assignment SET sla1_deadline = ? WHERE id IN (?,?,?)', [Date.now() - 1000, g1id, g2id, g3id])
  // ⚠️ 三次提醒制后 runSla1Recycle 首扫只提醒不回收——误扫现场改为直插 §2.54 事故后的存量形态
  //（status='recycled' + updated_by='system:sla'），不再经回收器构造
  crmDbService.run("UPDATE assignment SET status = 'recycled', updated_by = 'system:sla' WHERE id IN (?,?,?)", [g1id, g2id, g3id])
  // 误扫现场的流水/审计照 §2.54 真实形态补齐（append-only 对账行）
  for (const [lid, aid, owner] of [[g1, g1id, S_A], [g2, g2id, S_B], [g3, g3id, S_A]] as Array<[number, number, string]>) {
    const t = Date.now()
    crmDbService.run('INSERT INTO ownership_history (entity_type, entity_id, old_owner, new_owner, reason, actor, created_at) VALUES (?,?,?,?,?,?,?)', ['lead', lid, owner, '', 'SLA超时回收', 'system:sla', t])
    crmDbService.run('INSERT INTO audit_event (actor, action, entity_type, entity_id, detail, created_at) VALUES (?,?,?,?,?,?)', ['system:sla', 'lead_recycle', 'lead', lid, JSON.stringify({ assignmentId: aid, salesName: owner, reason: 'SLA超时回收' }), t])
  }
  const gRecycled = Number(crmDbService.all("SELECT COUNT(*) AS c FROM assignment WHERE id IN (?,?,?) AND status = 'recycled' AND updated_by = 'system:sla'", [g1id, g2id, g3id])[0].c)
  ok('G0 构造误扫现场：3 条被回收', gRecycled === 3, `实 ${gRecycled}`)
  // 误扫后 g3 被人工再分配给丙（模拟纠正前已有新有效分配的情形）
  assignLeads([g3], S_C, '分配员')
  const histCountBefore = Number(crmDbService.all('SELECT COUNT(*) AS c FROM ownership_history')[0].c)
  const auditCountBefore = Number(crmDbService.all('SELECT COUNT(*) AS c FROM audit_event')[0].c)
  // 注：E 组误扫回收过 e1（actor=system:sla）且 E9 已人工再分配 → 也命中判重，total/alreadyAssigned 各 +1
  const corr1 = correctSla1Misrecycle()
  ok('G1 纠正：total=4 / corrected=2 / alreadyAssigned=2', corr1.total === 4 && corr1.corrected === 2 && corr1.alreadyAssigned === 2, JSON.stringify(corr1))
  ok('G2 误扫旧行保持 recycled（历史不改写）', assignRow(g1id).status === 'recycled' && assignRow(g2id).status === 'recycled')
  const c1 = currentAssignment(g1), c2 = currentAssignment(g2)
  ok('G3 补偿新行成当前归属（甲/乙）', c1?.sales_name === S_A && c2?.sales_name === S_B && c1?.source === 'system:correction')
  ok('G4 新 sla1 在未来 24h 窗口', Number(c1?.sla1_deadline) > Date.now() + SLA_MS - 60_000 && Number(c2?.sla1_deadline) > Date.now() + SLA_MS - 60_000)
  ok('G5 lead 期限同步恢复（非哨兵）', leadDeadline(g1) === Number(c1?.sla1_deadline) && leadDeadline(g2) === Number(c2?.sla1_deadline))
  ok('G6 g3 已有有效分配被跳过（不重复补偿）', Number(crmDbService.all("SELECT COUNT(*) AS c FROM assignment WHERE lead_id = ? AND source = 'system:correction'", [g3])[0].c) === 0)
  ok('G7 未误扫的 g4 不动', assignRow(g4id).status === 'assigned' && Number(assignRow(g4id).sla1_deadline) < Date.now() + SLA_MS)
  const g1hist = histRows(g1)
  ok('G8 补偿流水：分配→SLA超时回收→分配（system:correction）', g1hist.length === 3
    && g1hist[2].reason === '分配' && g1hist[2].actor === 'system:correction' && g1hist[2].new_owner === S_A)
  const g1audit = crmDbService.all("SELECT * FROM audit_event WHERE action = 'lead_assign' AND entity_id = ? ORDER BY id DESC LIMIT 1", [g1])[0]
  ok('G9 补偿审计 detail 含纠正说明 + 指向被误回收行', String(g1audit?.detail).includes('SLA1误扫回收纠正') && String(g1audit?.detail).includes(String(g1id)))
  ok('G10 汇总审计 sla1_misrecycle_correction 落行', crmDbService.all("SELECT COUNT(*) AS c FROM audit_event WHERE action = 'sla1_misrecycle_correction' AND actor = 'system:correction'")[0].c === 1)
  ok('G11 append-only：历史流水/审计只增不改', Number(crmDbService.all('SELECT COUNT(*) AS c FROM ownership_history')[0].c) === histCountBefore + 2
    && Number(crmDbService.all('SELECT COUNT(*) AS c FROM audit_event')[0].c) === auditCountBefore + 3) // 2 补偿 + 1 汇总
  const corr2 = correctSla1Misrecycle()
  ok('G12 重跑标记跳过（零副作用）', corr2.skippedByMarker === true
    && Number(crmDbService.all('SELECT COUNT(*) AS c FROM ownership_history')[0].c) === histCountBefore + 2)
  // 标记丢失兜底：数据级判重（g1/g2 已有有效分配 → 全跳过，零新增）
  crmDbService.run('DELETE FROM scan_state WHERE key = ?', ['migration:sla1-misrecycle-correction'])
  const corr3 = correctSla1Misrecycle()
  ok('G13 标记丢失重入：数据级幂等零补偿', corr3.corrected === 0 && corr3.alreadyAssigned === 4, JSON.stringify(corr3))
  ok('G14 标记已重建', crmDbService.getScanState('migration:sla1-misrecycle-correction') > 0)


  console.log('\n═══ H. 批量分配 assignBatch（设计稿屏 3）+ 导入审计 ═══')
  const hSales = [S_A, S_B, S_C]
  const hLeadIds: number[] = []
  for (let i = 0; i < 12; i++) hLeadIds.push(seedLead(`H-批量${i}`))
  const hb1 = assignBatchLeads({ count: 10, mode: 'weight', weights: { [S_A]: 50, [S_B]: 30, [S_C]: 20 }, actor: '主管张某' })
  ok('H1 批量分配 ok 且分配 10 条', hb1.ok === true && hb1.data?.assigned === 10, JSON.stringify(hb1))
  ok('H2 权重 50/30/20 → 甲5/乙3/丙2',
    hb1.data?.perSales[S_A] === 5 && hb1.data?.perSales[S_B] === 3 && hb1.data?.perSales[S_C] === 2, JSON.stringify(hb1.data?.perSales))
  ok('H3 批次号 = #A+审计行号', /^#A\d+$/.test(hb1.data?.batchNo || '') === true, hb1.data?.batchNo)
  const batchAuditId = Number((hb1.data?.batchNo || '#A0').slice(2))
  const batchAudit = crmDbService.all('SELECT * FROM audit_event WHERE id = ?', [batchAuditId])[0]
  ok('H4 批次审计 action=lead_assign_batch（含模式/份额/操作人）',
    !!batchAudit && String(batchAudit.action) === 'lead_assign_batch' && JSON.parse(String(batchAudit.detail)).mode === 'weight' && String(batchAudit.actor) === '主管张某')
  // mode 落 assignment.mode：本批新分配行（updated_by=actor）mode 全为 weight
  //（池含前序分段遗留的 NEW 无归属线索，分配目标不能假设是本节 seed 的 12 条）
  const hWeightRows = crmDbService.all("SELECT COUNT(*) AS c FROM assignment WHERE updated_by = '主管张某' AND mode = 'weight' AND deleted = 0")[0]
  ok('H5 mode 落 assignment.mode=weight（本批 10 行）', Number(hWeightRows.c) === 10, `实 ${hWeightRows.c}`)
  // 池大小动态计算（NEW 且无当前有效分配行；回收行也回池，属正确产品语义）
  const poolCount = (): number => Number(crmDbService.all(
    `SELECT COUNT(*) AS c FROM lead l WHERE l.status = 'NEW' AND NOT EXISTS (
       SELECT 1 FROM assignment a WHERE a.lead_id = l.id AND a.deleted = 0 AND a.status IN ('assigned','claimed'))`
  )[0].c)
  const p1 = poolCount()
  const hb2 = assignBatchLeads({ count: 5, mode: 'round_robin', actor: '主管张某' })
  ok('H6 取 5 条池实有 p1 条 → 实分 min(5,p1)（clamp）', hb2.ok === true && hb2.data?.assigned === Math.min(5, p1), `p1=${p1} ${JSON.stringify(hb2.data)}`)
  // 轮询均分：各人差额 ≤1 且总量吻合
  const per2 = hb2.data?.perSales || {}
  const nums = hSales.map((s) => per2[s] || 0)
  ok('H7 轮询均分（max-min ≤1 且总量吻合）', Math.max(...nums) - Math.min(...nums) <= 1 && nums.reduce((a, b) => a + b, 0) === hb2.data?.assigned, JSON.stringify(per2))
  // 负载均衡：执行结果 = 共享份额规划器口径（规划器吃全库真实在手）。
  // hb2 可能已把池取空（clamp 语义），先补种保证池 ≥2
  while (poolCount() < 2) { hLeadIds.push(seedLead('H-补种')) }
  const realLoads: Record<string, number> = {}
  for (const s of hSales) realLoads[s] = 0
  for (const r of crmDbService.all(`SELECT sales_name, COUNT(*) AS c FROM assignment WHERE deleted = 0 AND status IN ('assigned','claimed') GROUP BY sales_name`)) {
    if (realLoads[String(r.sales_name)] !== undefined) realLoads[String(r.sales_name)] = Number(r.c)
  }
  const hb3 = assignBatchLeads({ count: 2, mode: 'load', actor: '主管张某' })
  const expect3 = buildDistribution('load', 2, hSales, {}, realLoads)
  ok('H8 负载均衡执行 = 共享规划器口径', hb3.ok === true && hb3.data?.assigned === 2
    && hSales.every((s) => (hb3.data?.perSales[s] || 0) === (expect3[s] || 0)), JSON.stringify({ per: hb3.data?.perSales, expect: expect3 }))
  // 空池断言：先把剩余池全部分掉（数量=池大小）→ 再分 → E301
  const p2 = poolCount()
  if (p2 > 0) assignBatchLeads({ count: p2, mode: 'weight', actor: '主管张某' })
  const hb4 = assignBatchLeads({ count: 5, mode: 'weight', actor: 'x' })
  ok('H9 待分配池为空 → E301', hb4.ok === false && hb4.code === 'E301', JSON.stringify(hb4))
  const scenarios: Array<['weight' | 'round_robin' | 'load', number, Record<string, number>]> = [
    ['weight', 12, { [S_A]: 40, [S_B]: 35, [S_C]: 25 }],
    ['weight', 10, {}],
    ['round_robin', 7, {}],
    ['load', 9, {}]
  ]
  let consistent = true
  for (const [m, n, w] of scenarios) {
    const be = buildDistribution(m, n, hSales, w, { [S_A]: 3, [S_B]: 1, [S_C]: 0 })
    const fe = distributePreview(m, n, hSales, w, { [S_A]: 3, [S_B]: 1, [S_C]: 0 })
    if (JSON.stringify(be) !== JSON.stringify(fe)) consistent = false
  }
  ok('H10 前端 distributePreview 与后端 buildDistribution 逐模式一致（防口径漂移）', consistent)

  const auditBefore = Number(crmDbService.all('SELECT COUNT(*) AS c FROM audit_event WHERE action = ?', ['lead_import'])[0].c)
  importLeads('批量导入测试', 'batch-test.xlsx', [
    { phone: '13700001111', note: 'H 导入审计' },
    { phone: '13700002222' }
  ])
  const impAudit = crmDbService.all('SELECT * FROM audit_event WHERE action = ? ORDER BY id DESC LIMIT 1', ['lead_import'])[0]
  ok('H11 importLeads 落 lead_import 审计行', Number(crmDbService.all('SELECT COUNT(*) AS c FROM audit_event WHERE action = ?', ['lead_import'])[0].c) === auditBefore + 1)
  ok('H12 审计 detail 含批次统计', !!impAudit && JSON.parse(String(impAudit.detail)).valid === 2 && JSON.parse(String(impAudit.detail)).batchId > 0)

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  process.exit(fail ? 1 : 0)
}

void main()
