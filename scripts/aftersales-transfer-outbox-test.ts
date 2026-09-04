/**
 * aftersales-transfer-outbox-test.ts —— 售后规则（PRD §1.6/§1.7/§1.7a/§1.7b）+ 离职移交（§1.9）+ outbox（§1.10）验证
 *
 * 覆盖：
 *   A. outbox 登记（§1.10 只记录不发送）：assign/claim/transfer/recycle/bind_wx 五写点同事务落行、
 *      event_seq 单调递增、idempotency_key 幂等重放零重复、status='pending'
 *   B. 离职移交（§1.9）：lead 批量 transfer 循环（reason='离职'）+ owner 三列同步改写 +
 *      ownership_history/audit_event 同事务 + 汇总审计 + E101/E203 + 重跑幂等
 *   C. R9 经销商拿货：签收第 10 天预警卡 / 15 天 deadline 升级 / 非经销商不出卡 / 未签收不出卡 / pending 去重
 *   D. R10 成交回访：15/30/90 天里程碑（每单每次只出最近一档）/ 一次性（done 后不重发）/
 *      复购老客加 60 天档 / R5 互斥守卫（won 不走 R5）
 *   E. R11 阶段停滞：比价>14 天 / 决策>21 天出卡 / 阈值内不出 / 无阶段变更时刻不猜 / pending 去重
 *   F. 设备级周期提醒（§1.7a）：轮子 180 / 液压 365 / 电池 1095 天 / 一次性 / 无交付日期靠物流签收推断
 *   G. R12 经销商回购：60 天未拿货出卡 / 期内不出 / 从未拿货不出 / 非经销商不出 / pending 去重
 *   H. 综合：runAftersalesScan 计数 + created_by='aftersales' + dealAftersalesStage 生命周期纯函数
 *
 * 隔离：WEFLOW_WORKER='1' + /tmp 落盘；crmDb/salesDb 均 fresh 空库，绝不碰 live 库。
 * 运行：npx tsx scripts/aftersales-transfer-outbox-test.ts
 */
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const isoDir = mkdtempSync(join(tmpdir(), 'aftersales-test-'))
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
import { assignLeads, claimLead, recycleAssignment, transferAssignment } from '../electron/services/crmAssignmentService'
import { bindLeadWxid } from '../electron/services/crmFriendDetectService'
import { departureHandoff } from '../electron/services/crmOwnershipService'
import { recordOutboxTx, listPendingOutbox } from '../electron/services/crmOutboxService'
import {
  dealAftersalesStage, runR9DealerRestockScan, runR10RevisitScan, runR11StallScan,
  runDeviceReminderScan, runR12DealerReorderScan, runAftersalesScan
} from '../electron/services/crmAftersalesService'
import { getActionRule } from '../electron/services/salesActionEngine'
import { LEAD_SLA_UNASSIGNED_SENTINEL } from '../shared/leadSla'

const S_A = '测试销售甲'
const S_B = '测试销售乙'
const S_C = '测试销售丙'
const DAY = 86400_000
const NOW = Date.now()

// ─── 种子函数 ────────────────────────────────────────────────────────────────
function seedLead(tag: string): number {
  return crmDbService.runTx((tx) => tx.run(
    'INSERT INTO lead (contact_type, contact_normalized, contact_raw, wechat, source, name, status, first_contact_deadline, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    ['phone', `139${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`, tag, '', '测试', tag, 'NEW', LEAD_SLA_UNASSIGNED_SENTINEL, NOW, NOW]
  ))
}
function seedCustomer(name: string, type: string): number {
  return crmDbService.runTx((tx) => tx.run(
    'INSERT INTO customer (name, type, source, updated_by, updated_at, version, deleted) VALUES (?,?,?,?,?,?,0)',
    [name, type, 'test', 'test', NOW, 1]
  ))
}
function seedAccount(name: string, owner: string, customerId = 0, sessionId = ''): number {
  return crmDbService.runTx((tx) => tx.run(
    "INSERT INTO account (name, owner_sales, session_id, customer_id, custom_fields, created_at, updated_at) VALUES (?,?,?,?,'{}',?,?)",
    [name, owner, sessionId || null, customerId || null, NOW, NOW]
  ))
}
function seedWonOpp(accountId: number, wonDaysAgo: number, opts: { deliveryDaysAgo?: number; model?: string } = {}): number {
  const wonAt = NOW - wonDaysAgo * DAY
  return crmDbService.runTx((tx) => {
    const id = tx.run(
      "INSERT INTO opportunity (account_id, name, stage, status, main_model, product, delivery_date, owner_sales, custom_fields, created_at, updated_at) VALUES (?,?,'won','won',?,?,?,'','{}',?,?)",
      [accountId, `商机${accountId}-${wonDaysAgo}d`, opts.model || '', opts.model || '', opts.deliveryDaysAgo ? NOW - opts.deliveryDaysAgo * DAY : 0, wonAt, wonAt]
    )
    tx.run("INSERT INTO opportunity_event (opportunity_id, event_type, stage, detail, created_at) VALUES (?,'won','won','测试成交',?)", [id, wonAt])
    return id
  })
}
function seedLogistics(accountId: number, opts: { signedDaysAgo?: number; shippedDaysAgo?: number; owner?: string } = {}): number {
  return crmDbService.runTx((tx) => tx.run(
    "INSERT INTO logistics (tracking_no, brand, receiver, status, latest_update_at, link_status, account_id, owner_sales, signed_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    [`SF${Math.floor(Math.random() * 1e9)}`, '测试叉车', '测试收货人',
      opts.signedDaysAgo !== undefined ? 'signed' : 'shipped',
      NOW - (opts.signedDaysAgo ?? opts.shippedDaysAgo ?? 0) * DAY, 'linked', accountId,
      opts.owner || '', opts.signedDaysAgo !== undefined ? NOW - opts.signedDaysAgo * DAY : 0,
      NOW - (opts.shippedDaysAgo ?? opts.signedDaysAgo ?? 0) * DAY]
  ))
}
function outboxRows(): CrmRow[] {
  return crmDbService.all('SELECT * FROM outbox_event ORDER BY event_seq')
}
function tasksByTrigger(trigger: string): Array<Record<string, unknown>> {
  return salesDbService.todoList({ limit: 100000 }).filter((t) => t.trigger_type === trigger) as unknown as Array<Record<string, unknown>>
}

async function main(): Promise<void> {
  const cfg = ConfigService.getInstance()
  cfg.set('crmSalesList', [S_A, S_B, S_C])
  cfg.set('crmLeadSlaHours', 24)
  const dbDir = mkdtempSync(join(tmpdir(), 'aftersales-test-db-'))
  await crmDbService.initialize(dbDir)
  await salesDbService.initialize(dbDir)

  console.log('═══ A. outbox 登记（PRD §1.10 只记录不发送）═══')
  const la = seedLead('A-线索')
  const ra = assignLeads([la], S_A, '分配员')
  const aid = ra.data!.assignments[0].assignmentId
  const a1 = outboxRows()
  ok('A1 assign 落 outbox（type=assign, status=pending, seq=1）',
    a1.length === 1 && JSON.parse(String(a1[0].payload)).type === 'assign' && a1[0].status === 'pending' && Number(a1[0].event_seq) === 1,
    JSON.stringify(a1))
  ok('A2 idempotency_key = assign:<assignmentId>', a1[0].idempotency_key === `assign:${aid}`)
  ok('A3 payload 含 leadId/salesName', (() => { const p = JSON.parse(String(a1[0].payload)); return p.leadId === la && p.salesName === S_A })())
  claimLead(la, S_A)
  const lb = seedLead('A-线索2')
  assignLeads([lb], S_A, '分配员')
  const rt = transferAssignment(Number(crmDbService.all("SELECT id FROM assignment WHERE lead_id = ? AND status = 'assigned'", [lb])[0].id), S_B, '人工调派', '分配员')
  const newAid = rt.data!.assignmentId
  recycleAssignment(newAid, '人工回收', '分配员')
  bindLeadWxid(la, 'wxid_test_aftersale', { actor: S_A })
  const a4 = outboxRows()
  const types = a4.map((r) => JSON.parse(String(r.payload)).type)
  ok('A4 五写点全落 outbox（assign×2/claim/transfer/recycle/bind_wx）',
    types.join(',') === 'assign,claim,assign,transfer,recycle,bind_wx', types.join(','))
  ok('A5 event_seq 单调递增连续 1..6', a4.every((r, i) => Number(r.event_seq) === i + 1), a4.map((r) => r.event_seq).join(','))
  ok('A6 transfer 事件 key 用新行 id', a4.some((r) => r.idempotency_key === `transfer:${newAid}`))
  // 幂等：重复绑定 alreadyBound → outbox 不增
  const beforeRebind = outboxRows().length
  const rb = bindLeadWxid(la, 'wxid_test_aftersale', { actor: S_A })
  ok('A7 重复绑定 alreadyBound 且 outbox 零新增', rb.ok && rb.data?.alreadyBound === true && outboxRows().length === beforeRebind)
  // recordOutboxTx 同 key 重放返回 false
  const replay = crmDbService.runTx((tx) => recordOutboxTx(tx, 'assign', `assign:${aid}`, { leadId: la }))
  ok('A8 idempotency_key 重放返回 false 零写入', replay === false && outboxRows().length === beforeRebind)
  ok('A9 listPendingOutbox 只读返回 pending 行', listPendingOutbox().length === beforeRebind)

  console.log('\n═══ B. 离职移交（PRD §1.9）═══')
  ok('B1 E101 空参数/同人', departureHandoff('', S_B).code === 'E101' && departureHandoff(S_A, S_A).code === 'E101')
  ok('B2 E203 接手人不在销售名单', departureHandoff(S_A, '不存在的人').code === 'E203')
  // 丙名下（与 A 组隔离）：2 条线索（一 assigned 一 claimed）+ 1 客户 + 1 商机 + 1 物流；乙已有 1 客户不受影响
  const lc1 = seedLead('B-丙线索1')
  const lc2 = seedLead('B-丙线索2')
  assignLeads([lc1, lc2], S_C, '分配员')
  claimLead(lc2, S_C)
  const accA = seedAccount('B-丙的客户', S_C)
  const accB = seedAccount('B-乙的客户', S_B)
  crmDbService.runTx((tx) => {
    tx.run("INSERT INTO opportunity (account_id, name, status, owner_sales, custom_fields, created_at, updated_at) VALUES (?,'丙的商机','active',?,'{}',?,?)", [accA, S_C, NOW, NOW])
    tx.run("INSERT INTO logistics (tracking_no, status, owner_sales, created_at) VALUES ('SF-DEP-1','shipped',?,?)", [S_C, NOW])
  })
  const dep = departureHandoff(S_C, S_B, '主管丁')
  ok('B3 移交成功：lead×2 + account×1 + opp×1 + logistics×1',
    dep.ok === true && dep.data!.leadsTransferred === 2 && dep.data!.leadFailed.length === 0 &&
    dep.data!.accounts === 1 && dep.data!.opportunities === 1 && dep.data!.logistics === 1, JSON.stringify(dep))
  const depLeadHist = crmDbService.all("SELECT * FROM ownership_history WHERE entity_type = 'lead' AND entity_id = ? AND reason = '离职'", [lc1])
  ok('B4 lead 流水 reason=离职 + 新行 assigned 归乙',
    depLeadHist.length === 1 && depLeadHist[0].old_owner === S_C && depLeadHist[0].new_owner === S_B &&
    crmDbService.all("SELECT id FROM assignment WHERE lead_id = ? AND status = 'assigned' AND sales_name = ?", [lc1, S_B]).length === 1)
  ok('B5 owner 三列改写为乙',
    String(crmDbService.all('SELECT owner_sales AS o FROM account WHERE id = ?', [accA])[0].o) === S_B &&
    String(crmDbService.all('SELECT owner_sales AS o FROM opportunity WHERE account_id = ?', [accA])[0].o) === S_B &&
    String(crmDbService.all("SELECT owner_sales AS o FROM logistics WHERE tracking_no = 'SF-DEP-1'")[0].o) === S_B)
  ok('B6 乙原有客户不受影响', String(crmDbService.all('SELECT owner_sales AS o FROM account WHERE id = ?', [accB])[0].o) === S_B)
  const depOwn = crmDbService.all("SELECT * FROM ownership_history WHERE reason = '离职' AND entity_type IN ('account','opportunity','logistics')")
  ok('B7 三实体 ownership_history 逐行落（reason=离职, actor=主管丁）',
    depOwn.length === 3 && depOwn.every((r) => r.actor === '主管丁' && r.old_owner === S_C && r.new_owner === S_B))
  const depAudit = crmDbService.all("SELECT * FROM audit_event WHERE action = 'departure_handoff_summary'")
  ok('B8 汇总审计落行（detail 含计数）', depAudit.length === 1 && String(depAudit[0].detail).includes('"leadsTransferred":2'), JSON.stringify(depAudit[0]?.detail))
  const dep2 = departureHandoff(S_C, S_B, '主管丁')
  ok('B9 重跑幂等：丙名下已无可移交，全 0', dep2.ok && dep2.data!.leadsTransferred === 0 && dep2.data!.accounts === 0 && dep2.data!.opportunities === 0 && dep2.data!.logistics === 0)
  ok('B10 移交后乙可 claim（状态机健康）', claimLead(lc1, S_B).ok === true)

  console.log('\n═══ C. R9 经销商拿货预警（签收 10 天预警 / 15 天 deadline）═══')
  const dealer = seedCustomer('C-经销商', 'dealer')
  const endUser = seedCustomer('C-终端', 'end_user')
  const accDealer = seedAccount('C-经销商户', S_B, dealer, 'wxid_dealer_c')
  const accEnd = seedAccount('C-终端户', S_B, endUser, 'wxid_end_c')
  const logi11 = seedLogistics(accDealer, { signedDaysAgo: 11 })
  const logiUnsigned = seedLogistics(accDealer, { shippedDaysAgo: 20 })
  const logiEnd = seedLogistics(accEnd, { signedDaysAgo: 12 })
  let r9 = runR9DealerRestockScan(NOW)
  ok('C1 经销商签收 11 天 → 预警卡', r9.warned === 1 && tasksByTrigger('rule_r9_dealer_restock').length === 1, JSON.stringify(r9))
  const r9Card = tasksByTrigger('rule_r9_dealer_restock')[0]
  ok('C2 卡挂 source_id=物流单 + due_at=签收+15天', Number(r9Card.source_id) === logi11 && Number(r9Card.due_at) === NOW - 11 * DAY + 15 * DAY)
  ok('C3 未签收/非经销商不出卡', !tasksByTrigger('rule_r9_dealer_restock').some((t) => Number(t.source_id) === logiUnsigned || Number(t.source_id) === logiEnd))
  r9 = runR9DealerRestockScan(NOW)
  ok('C4 重扫 pending 去重不重复建卡', r9.warned === 0 && tasksByTrigger('rule_r9_dealer_restock').length === 1)
  r9 = runR9DealerRestockScan(NOW + 5 * DAY) // 签收第 16 天视角
  const r9CardAfter = tasksByTrigger('rule_r9_dealer_restock')[0]
  ok('C5 超 15 天 deadline → 升级标题+提 urgent 分（不新建卡）',
    r9.escalated === 1 && String(r9CardAfter.title).includes('超期') && Number(r9CardAfter.priority_score) >= 100 && tasksByTrigger('rule_r9_dealer_restock').length === 1)

  console.log('\n═══ D. R10 成交回访（15/30/90 天 + 老客 60 天档）═══')
  const cust1 = seedCustomer('D-客户1', 'end_user')
  const acc1 = seedAccount('D-客户1户', S_B, cust1, 'wxid_d1')
  const opp16 = seedWonOpp(acc1, 16, { model: '电动托盘车' })
  let r10 = runR10RevisitScan(NOW)
  ok('D1 成交 16 天 → 只出 15 天档一张', r10.created === 1 && tasksByTrigger('rule_r10_revisit_15').length === 1 && tasksByTrigger('rule_r10_revisit_30').length === 0, JSON.stringify(r10))
  const d1Card = tasksByTrigger('rule_r10_revisit_15')[0]
  ok('D2 卡挂真实 session + 生命周期标签（未交付=成交）', d1Card.session_id === 'wxid_d1' && String(d1Card.title).includes('电动托盘车，成交'))
  r10 = runR10RevisitScan(NOW)
  ok('D3 重扫零重复（pending 仍在）', r10.created === 0)
  salesDbService.todoUpdate(Number(d1Card.id), { status: 'done' })
  r10 = runR10RevisitScan(NOW)
  ok('D4 done 后同档不重发（一次性）', r10.created === 0)
  const opp31 = seedWonOpp(acc1, 31)
  r10 = runR10RevisitScan(NOW)
  ok('D5 31 天首扫只出最近一档（30 天），不补 15 天骚扰卡',
    tasksByTrigger('rule_r10_revisit_30').some((t) => Number(t.source_id) === opp31) &&
    !tasksByTrigger('rule_r10_revisit_15').some((t) => Number(t.source_id) === opp31))
  const opp61 = seedWonOpp(acc1, 61)
  runR10RevisitScan(NOW)
  ok('D7 老客加频：61 天出 60 天档（老客专属）', tasksByTrigger('rule_r10_revisit_60').some((t) => Number(t.source_id) === opp61))
  const cust2 = seedCustomer('D-客户2', 'end_user')
  const acc2 = seedAccount('D-客户2户', S_B, cust2, 'wxid_d2')
  const opp61b = seedWonOpp(acc2, 61)
  runR10RevisitScan(NOW)
  ok('D8 非复购客户 61 天不出 60 天档', !tasksByTrigger('rule_r10_revisit_60').some((t) => Number(t.source_id) === opp61b))
  const r5 = getActionRule('rule_r5_dormant_wake')!
  ok('D9 R5 互斥：已成交（won）客户不沉默唤醒', r5.match({ stage: 'won', last_contact_at: Math.floor((NOW - 40 * DAY) / 1000) } as never, Math.floor(NOW / 1000)) === false)

  console.log('\n═══ E. R11 阶段停滞（比价>14 天 / 决策>21 天）═══')
  salesDbService.customerUpsert({ session_id: 'wxid_e1', display_name: 'E-比价客', stage: 'quoted' })
  salesDbService.updateStageChangeTime('wxid_e1', NOW - 15 * DAY)
  salesDbService.customerUpsert({ session_id: 'wxid_e2', display_name: 'E-比价未到期', stage: 'quoted' })
  salesDbService.updateStageChangeTime('wxid_e2', NOW - 13 * DAY)
  salesDbService.customerUpsert({ session_id: 'wxid_e3', display_name: 'E-决策客', stage: 'negotiating' })
  salesDbService.updateStageChangeTime('wxid_e3', NOW - 22 * DAY)
  salesDbService.customerUpsert({ session_id: 'wxid_e4', display_name: 'E-决策未到期', stage: 'negotiating' })
  salesDbService.updateStageChangeTime('wxid_e4', NOW - 20 * DAY)
  salesDbService.customerUpsert({ session_id: 'wxid_e5', display_name: 'E-无变更时刻', stage: 'quoted' })
  let r11 = runR11StallScan(NOW)
  const stallCards = [...tasksByTrigger('rule_r11_quoted_stall'), ...tasksByTrigger('rule_r11_negotiating_stall')]
  ok('E1 比价 15 天 + 决策 22 天各出一卡', r11.created === 2 && stallCards.length === 2, `created=${r11.created}`)
  ok('E2 阈值内（13/20 天）与无变更时刻的不出卡',
    !stallCards.some((t) => ['E-比价未到期', 'E-决策未到期', 'E-无变更时刻'].includes(String(t.display_name))))
  ok('E3 卡标题含停滞天数与阈值', String(stallCards[0].title).includes('停滞 15 天') || String(stallCards[1].title).includes('停滞 15 天'), String(stallCards[0].title))
  r11 = runR11StallScan(NOW)
  ok('E4 重扫 pending 去重（统一去重压制）', r11.created === 0 && stallCards.length === 2)

  console.log('\n═══ F. 设备级周期提醒（§1.7a，按交付日期起算）═══')
  const cust3 = seedCustomer('F-客户3', 'end_user')
  const acc3 = seedAccount('F-客户3户', S_B, cust3, 'wxid_f1')
  const oppDev1 = seedWonOpp(acc3, 200, { deliveryDaysAgo: 181, model: '搬运车A' })
  const oppDev2 = seedWonOpp(acc3, 400, { deliveryDaysAgo: 366, model: '搬运车B' })
  const oppDev3 = seedWonOpp(acc3, 1200, { deliveryDaysAgo: 1096, model: '搬运车C' })
  const oppNoDate = seedWonOpp(acc3, 300) // 无 delivery_date
  let dev = runDeviceReminderScan(NOW)
  ok('F1 181 天 → 轮子卡', tasksByTrigger('rule_dev_wheel').some((t) => Number(t.source_id) === oppDev1))
  ok('F2 366 天 → 轮子+液压卡', tasksByTrigger('rule_dev_wheel').some((t) => Number(t.source_id) === oppDev2) && tasksByTrigger('rule_dev_hydraulic').some((t) => Number(t.source_id) === oppDev2))
  ok('F3 1096 天 → 三类全出（轮子/液压/电池）',
    ['rule_dev_wheel', 'rule_dev_hydraulic', 'rule_dev_battery'].every((tr) => tasksByTrigger(tr).some((t) => Number(t.source_id) === oppDev3)))
  ok('F4 无交付日期且未签收 → 不出卡', !['rule_dev_wheel', 'rule_dev_hydraulic', 'rule_dev_battery'].some((tr) => tasksByTrigger(tr).some((t) => Number(t.source_id) === oppNoDate)))
  dev = runDeviceReminderScan(NOW)
  ok('F5 重扫一次性零重复', dev.created === 0)
  // 无 delivery_date 但有签收物流 → 交付时间由签收推断
  const acc4 = seedAccount('F-客户4户', S_B, 0, 'wxid_f2')
  const oppInfer = seedWonOpp(acc4, 300)
  seedLogistics(acc4, { signedDaysAgo: 200 })
  runDeviceReminderScan(NOW)
  ok('F6 无 delivery_date 靠物流签收推断交付（缺口注记 1 行为）', tasksByTrigger('rule_dev_wheel').some((t) => Number(t.source_id) === oppInfer))

  console.log('\n═══ G. R12 经销商拿货周期预警（60 天未拿货）═══')
  const dealerG1 = seedCustomer('G-经销商1', 'dealer')
  const accG1 = seedAccount('G-经销商1户', S_B, dealerG1, 'wxid_g1')
  seedWonOpp(accG1, 61) // 最近拿货 61 天前
  const dealerG2 = seedCustomer('G-经销商2', 'dealer')
  const accG2 = seedAccount('G-经销商2户', S_B, dealerG2, 'wxid_g2')
  seedLogistics(accG2, { shippedDaysAgo: 10 }) // 10 天前发过货
  const dealerG3 = seedCustomer('G-经销商3', 'dealer')
  seedAccount('G-经销商3户', S_B, dealerG3, 'wxid_g3') // 从未拿货
  let r12 = runR12DealerReorderScan(NOW)
  const r12Cards = tasksByTrigger('rule_r12_dealer_reorder')
  ok('G1 61 天未拿货 → 出卡', r12.created === 1 && r12Cards.some((t) => Number(t.source_id) === dealerG1), `created=${r12.created}`)
  ok('G2 期内（10 天）/从未拿货/非经销商不出卡', r12Cards.length === 1)
  r12 = runR12DealerReorderScan(NOW)
  ok('G3 重扫 pending 去重', r12.created === 0 && r12Cards.length === 1)
  // C 组经销商最近签收 11 天 → 也不出卡（counts 已在 G1/G2 覆盖，这里核验不串）
  ok('G4 C 组经销商（11 天前签收）不出 R12 卡', !r12Cards.some((t) => Number(t.source_id) === dealer))

  console.log('\n═══ H. 综合（统一入口 + 生命周期纯函数）═══')
  const summary = runAftersalesScan(NOW)
  ok('H1 runAftersalesScan 返回五路计数结构',
    typeof summary.r9 === 'number' && typeof summary.r10 === 'number' && typeof summary.r11 === 'number' && typeof summary.device === 'number' && typeof summary.r12 === 'number')
  const allCards = salesDbService.todoList({ limit: 100000 }).filter((t) =>
    ['rule_r9_dealer_restock', 'rule_r10_revisit_15', 'rule_r11_quoted_stall', 'rule_dev_wheel', 'rule_r12_dealer_reorder'].includes(t.trigger_type))
  ok('H2 售后卡 created_by=aftersales（不受 action_engine 每日重扫清理）', allCards.length > 0 && allCards.every((t) => t.created_by === 'aftersales'))
  ok('H3 生命周期：未成交 → 空', dealAftersalesStage({ wonAt: 0, deliveredAt: 0, repeat: false }) === '')
  ok('H4 生命周期：成交未交付 → 成交', dealAftersalesStage({ wonAt: NOW - DAY, deliveredAt: 0, repeat: false }) === '成交')
  ok('H5 生命周期：交付 5 天 → 已交付', dealAftersalesStage({ wonAt: NOW - 20 * DAY, deliveredAt: NOW - 5 * DAY, repeat: false }) === '已交付')
  ok('H6 生命周期：交付 20 天 → 待回访', dealAftersalesStage({ wonAt: NOW - 40 * DAY, deliveredAt: NOW - 20 * DAY, repeat: false }) === '待回访')
  ok('H7 生命周期：复购客户 → 复购老客（叠加客户级维护）', dealAftersalesStage({ wonAt: NOW - DAY, deliveredAt: 0, repeat: true }) === '复购老客')

  console.log(`\n═══ 结果：${pass} 通过 / ${fail} 失败 ═══`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error('测试崩溃:', e); process.exit(1) })
