/**
 * crm-delivery-test.ts —— 交付售后专用服务单测（2026-09-10，宪法 §1.1/§1.5/§3 登记）
 *
 * 覆盖 electron/services/crmDeliveryService.ts 六个区域：
 *   ① 交付登记 registerDelivery（shipped_qty 非负整数 / 超发必带原因 / delivery_date 合法日期 /
 *      仅成交单可登记 / audit_event 记新旧值+操作者+来源）
 *   ② 数量差异任务 syncDiffTask（order_qty>shipped_qty 出卡 / 幂等唯一 pending / 差异量变化原地更新 /
 *      补齐自动关闭+关闭原因 / 差异再现重新出卡不覆盖历史 done 记录）
 *   ③ 设备档案 saveEquipment（7 字段 + 质保字段 + audit_event / 非法日期拒绝 / 未变更零写入）
 *   ④ 改装质保提醒 runWarrantyReminderScan（临期/到期出卡 / 幂等 / 无真实日期不猜）
 *   ⑤ 以旧换新 proposeTradeIn/decideTradeIn（真实证据硬门 / 只出提案不改客户事实 / 裁决写 proposal_event+审计）
 *   ⑥ 复购等级 recomputeRepeatLevel（共享原语 computeRepeatLevel / 等级变化写审计 / 幂等）
 * 回归段（2026-09-10 三处修复）：
 *   ⑧ 以旧换新裁决终态保持（相同依据刷新不重出 DECIDED / 依据变化才重新提案）
 *   ⑨ 部分发货差异卡原地更新（同卡 id 不变 / 无变化零写入）
 *   ⑩ 质保提醒人工完成后重扫不重出（同周期终态判重）
 *   ⑪ 质保日期变更/清空/跨档全生命周期（stale 卡自动关闭 + 审计 + 历史保留）
 * 二轮审查 P2 回归（2026-09-10）：
 *   ⑫ 展示层静态断言（整数完整转换 / 归属过滤口径 / 复购等级全量统计 / 身份竞态 / 客户归属聚合）
 *   ⑬ 质保恢复（清空自动关闭 ≠ 人工完成，恢复有效资料允许重新提醒；人工完成仍终态）
 * 运行：npx tsx scripts/crm-delivery-test.ts
 */
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { crmDbService } from '../electron/services/crmDbService'
import { salesDbService } from '../electron/services/salesDbService'
import {
  registerDelivery, syncDiffTask, saveEquipment, runWarrantyReminderScan, syncWarrantyReminders,
  proposeTradeIn, decideTradeIn, tradeInBasisOf, recomputeRepeatLevel, listDeliveryTasks,
  suggestDeliveryDate, runDeliveryScan, runTradeInProposalScan,
  DIFF_TRIGGER, WARRANTY_NEAR_TRIGGER, WARRANTY_EXPIRED_TRIGGER, TRADE_IN_TRIGGER
} from '../electron/services/crmDeliveryService'
import { computeRepeatLevel, REPEAT_LEVEL_FIRST, REPEAT_LEVEL_REPEAT, REPEAT_LEVEL_HIGH } from '../shared/crmRepeat'

const DAY = 86400_000

let pass = 0, fail = 0
function ok(name: string, cond: boolean): void {
  if (cond) { pass++ } else { fail++; console.error('FAIL:', name) }
}

/** 建一个成交单（registerOpportunityDeal，触发 onOpportunityDealRegistered 钩子出差异卡） */
function wonDeal(accountName: string, orderQty = 1): { accId: number; oppId: number } {
  const accId = crmDbService.ensureAccount(accountName)
  const model = `M-${accountName}`
  crmDbService.create('product', { model, name: '测试车', unit_price: 5000, specs: '{}', variants: '[]', created_at: Date.now() })
  const opp = crmDbService.opportunityUpsertBySignal(accId, accountName, {
    product: '2吨电动叉车', quantity: orderQty, amount: 0, stage: '决策', detail: '要货'
  })
  crmDbService.registerOpportunityDeal(opp.id, {
    amount_cny: orderQty * 5000, main_model: model, order_qty: orderQty, type: '整车'
  })
  return { accId, oppId: opp.id }
}

/** 建一个客户并挂接到 account.customer_id（逻辑外键，跨实体） */
function linkCustomer(name: string): { accId: number; cid: number } {
  const accId = crmDbService.ensureAccount(name)
  const cid = crmDbService.create('customer', { name, type: 'dealer', updated_at: Date.now() })
  crmDbService.update('account', accId, { customer_id: cid })
  return { accId, cid }
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'crm-delivery-'))
  await crmDbService.initialize(dir)
  await salesDbService.initialize(dir)

  // ── ① 交付登记 registerDelivery（专用后端，取代通用 crm.update）────────────────
  {
    const a = wonDeal('交付登记校验客户', 3)
    // 钩子已按 order_qty=3 / shipped_qty=0 出差异卡
    ok('1a 成交登记钩子已出差异卡', !!salesDbService.pendingTaskBySource(DIFF_TRIGGER, a.oppId))

    // 硬校验逐项拒绝（零残留：shipped/delivery/over_ship 不变）
    ok('1b 实发量非负整数（-1 拒绝）', !registerDelivery(a.oppId, { shipped_qty: -1 }).ok)
    ok('1c 实发量非负整数（1.5 拒绝）', !registerDelivery(a.oppId, { shipped_qty: 1.5 }).ok)
    ok('1d 超发必须带原因（5>3 无原因拒绝）', !registerDelivery(a.oppId, { shipped_qty: 5 }).ok)
    ok('1e 交付日期必须是合法日期（-1 拒绝）', !registerDelivery(a.oppId, { delivery_date: -1 }).ok)
    ok('1f 非成交单不可登记（active 拒绝）', (() => {
      const acc = crmDbService.ensureAccount('未成交客户')
      const opp = crmDbService.opportunityUpsertBySignal(acc, '未成交客户', { product: '堆高车', quantity: 1, amount: 0, stage: '了解', detail: 'x' })
      return !registerDelivery(opp.id, { shipped_qty: 1 }).ok
    })())
    ok('1g 校验拒绝零残留（shipped 仍 0）', Number(crmDbService.opportunityById(a.oppId)?.shipped_qty || 0) === 0)

    // 正常登记（未超发）+ 审计
    const d0 = Date.now() + 15 * DAY
    const r1 = registerDelivery(a.oppId, { shipped_qty: 2, delivery_date: d0, actor: '测试销售' })
    ok('1h 正常登记成功', r1.ok && r1.data?.shipped_qty === 2 && r1.data?.delivery_date === d0)
    ok('1i 登记审计留痕（old/new/operator/source）', (() => {
      const rows = crmDbService.all("SELECT * FROM audit_event WHERE action = 'delivery_register' AND entity_type = 'opportunity' AND entity_id = ?", [a.oppId])
      if (!rows.length) return false
      const d = JSON.parse(String(rows[0].detail || '{}'))
      return Number(d.old?.shipped_qty) === 0 && Number(d.new?.shipped_qty) === 2 &&
        String(d.operator) === '测试销售' && String(d.source) === 'delivery_aftersales'
    })())

    // 超发带原因 + 差异任务自动关闭
    const r2 = registerDelivery(a.oppId, { shipped_qty: 4, over_ship_reason: '客户追加 1 台', actor: '测试销售' })
    ok('1j 超发带原因成功 + 差异任务自动关闭', r2.ok && r2.data?.shipped_qty === 4 && r2.data?.diffTaskClosed === 1)
    ok('1k 超发原因落库', String(crmDbService.opportunityById(a.oppId)?.over_ship_reason) === '客户追加 1 台')
    ok('1l 补齐后 pending 差异卡清除', !salesDbService.pendingTaskBySource(DIFF_TRIGGER, a.oppId))
  }

  // ── ② 数量差异任务 syncDiffTask（真实 follow_up_task，非前端列表）────────────
  {
    const b = wonDeal('差异任务客户', 5)
    const created = salesDbService.pendingTaskBySource(DIFF_TRIGGER, b.oppId)
    ok('2a 差异任务已出卡', !!created)
    const taskId = Number(created!.id)
    ok('2b 幂等：重复同步零新卡', syncDiffTask(b.oppId).created === 0 && syncDiffTask(b.oppId).closed === 0)
    ok('2c 同商机只留一张 pending', salesDbService.todoList({ status: 'pending' })
      .filter((t) => t.trigger_type === DIFF_TRIGGER && Number(t.source_id) === b.oppId).length === 1)

    // 补齐 → 自动关闭 + 关闭原因
    const closeRes = registerDelivery(b.oppId, { shipped_qty: 5, actor: '测试销售' })
    ok('2d 补齐自动关闭 pending 差异卡', closeRes.ok && closeRes.data?.diffTaskClosed === 1)
    const doneTask = salesDbService.getTask(taskId)
    ok('2e 关闭原因写入 analysis', !!doneTask && String(doneTask.status) === 'done' && String(doneTask.analysis || '').includes('closedReason'))

    // 差异再现 → 重新出卡，不覆盖历史 done
    const reopen = registerDelivery(b.oppId, { shipped_qty: 3, actor: '测试销售' })
    ok('2f 差异再现重新出卡', reopen.ok && reopen.data?.diffTaskCreated === 1)
    const newPending = salesDbService.pendingTaskBySource(DIFF_TRIGGER, b.oppId)
    ok('2g 新 pending 是新卡（id 不同）', !!newPending && Number(newPending.id) !== taskId)
    const allDiff = salesDbService.todoList({}).filter((t) => t.trigger_type === DIFF_TRIGGER && Number(t.source_id) === b.oppId)
    ok('2h 历史 done + 新 pending 共存（不覆盖历史）', allDiff.length === 2)
    ok('2i 历史 done 记录未被改写', (() => {
      const old = allDiff.find((t) => Number(t.id) === taskId)
      return !!old && String(old.status) === 'done' && String(old.analysis || '').includes('closedReason')
    })())
  }

  // ── ③ 设备档案 saveEquipment（7 字段 + 质保字段 + 审计）────────────────────
  {
    const { cid } = linkCustomer('设备档案客户')
    const d0 = Date.now() - 100 * DAY
    const d1 = Date.now() - 10 * DAY
    const r = saveEquipment(cid, {
      brand: '合力', model: 'CPD15', vehicle_age: 2, purchase_date: d0,
      modified: 1, modified_date: d1, battery_type: '锂电', last_maintenance_date: Date.now()
    }, '测试销售')
    ok('3a 7 字段全部写入', r.ok && r.data?.changedFields.length === 8)
    const cu = crmDbService.getById('customer', cid)
    ok('3b 设备档案落库（brand/model/vehicle_age/battery_type）',
      String(cu?.brand) === '合力' && String(cu?.model) === 'CPD15' && Number(cu?.vehicle_age) === 2 && String(cu?.battery_type) === '锂电')
    ok('3c 日期/改装/改装日期落库',
      Number(cu?.purchase_date) === d0 && Number(cu?.modified) === 1 && Number(cu?.modified_date) === d1)
    ok('3d 设备档案审计留痕（action=customer_equipment_set）',
      Number(crmDbService.all("SELECT COUNT(*) AS c FROM audit_event WHERE action = 'customer_equipment_set' AND entity_type = 'customer' AND entity_id = ?", [cid])[0]?.c) === 1)

    // 校验拒绝
    ok('3e 车龄非负整数（-1 拒绝）', !saveEquipment(cid, { vehicle_age: -1 }).ok)
    ok('3f 日期字段非法（-1 拒绝）', !saveEquipment(cid, { purchase_date: -1 }).ok)
    // 未变更零写入
    ok('3g 未变更零写入（changedFields 空）', saveEquipment(cid, { brand: '合力' }).data?.changedFields.length === 0)
  }

  // ── ④ 改装质保提醒（显式 warranty_start_date + warranty_days，无真实日期不猜）──
  {
    const now = Date.now()
    const { cid: cExp } = linkCustomer('质保到期客户')
    saveEquipment(cExp, { warranty_start_date: now - 400 * DAY, warranty_days: 365 }, '测试销售')
    ok('4a 质保已到期出卡（warranty_mod_expired）', !!salesDbService.pendingTaskBySource(WARRANTY_EXPIRED_TRIGGER, cExp))

    const { cid: cNear } = linkCustomer('质保临期客户')
    saveEquipment(cNear, { warranty_start_date: now - 350 * DAY, warranty_days: 365 }, '测试销售')
    ok('4b 质保临期出卡（warranty_mod_near）', !!salesDbService.pendingTaskBySource(WARRANTY_NEAR_TRIGGER, cNear))

    // 幂等：同周期只一张 pending
    const scan1 = runWarrantyReminderScan(now)
    ok('4c 质保提醒幂等（重扫零新卡）', scan1.near === 0 && scan1.expired === 0)
    ok('4d 单客户重同步零新卡', syncWarrantyReminders(cExp, now).expired === 0)

    // 无真实日期 → 不猜周期
    const { cid: cNone } = linkCustomer('无质保日期客户')
    saveEquipment(cNone, { brand: '某牌' }, '测试销售')
    ok('4e 无真实质保日期不猜（零卡）', syncWarrantyReminders(cNone, now).near === 0 && syncWarrantyReminders(cNone, now).expired === 0 &&
      !salesDbService.pendingTaskBySource(WARRANTY_NEAR_TRIGGER, cNone) && !salesDbService.pendingTaskBySource(WARRANTY_EXPIRED_TRIGGER, cNone))
  }

  // ── ⑤ 以旧换新（真实设备日期/车龄证据；只出提案，不改客户事实）──────────────
  {
    const now = Date.now()
    const { cid } = linkCustomer('以旧换新客户')
    saveEquipment(cid, { purchase_date: now - 4 * 365 * DAY }, '测试销售')
    const cu = crmDbService.getById('customer', cid)
    const basis = tradeInBasisOf(cu!, now)
    ok('5a 真实购置日期推导依据（锚点含事实值）', !!basis && basis.kind === 'purchase_date' && basis.evidenceKey === `device:purchase_date:${cid}:${now - 4 * 365 * DAY}`)

    // 缺证据硬门
    ok('5b 缺证据拒绝（evidenceKey 空）', !proposeTradeIn(cid, { kind: 'chat_evidence', evidenceKey: '', reason: '旧了' }).ok)
    ok('5c 缺原因拒绝（reason 空）', !proposeTradeIn(cid, { kind: 'vehicle_age', evidenceKey: 'device:vehicle_age:1', reason: '' }).ok)

    const p = proposeTradeIn(cid, basis!, '测试销售')
    ok('5d 提案出卡（trade_in_proposal）', p.ok && Number(p.taskId) > 0)
    ok('5e 提案埋点（proposal/generated）', salesDbService.proposalEventCount({ event_type: 'proposal', stage: 'generated' }) >= 1)
    // 幂等：同客户只留一张
    ok('5f 同客户幂等（DUP）', proposeTradeIn(cid, basis!, '测试销售').code === 'DUP')
    // 只出提案，不改客户事实
    ok('5g 出提案不改客户事实', Number(crmDbService.getById('customer', cid)?.purchase_date) === now - 4 * 365 * DAY)

    // 裁决 accept → proposal_event + 审计 + 关卡；客户事实仍不变
    ok('5h 裁决 accept 成功', decideTradeIn(cid, 'accept', '测试销售').ok)
    ok('5i accept 埋点（proposal/accepted）', salesDbService.proposalEventCount({ event_type: 'proposal', stage: 'accepted' }) >= 1)
    ok('5j accept 审计留痕', Number(crmDbService.all("SELECT COUNT(*) AS c FROM audit_event WHERE action = 'trade_in_proposal_accept' AND entity_type = 'customer' AND entity_id = ?", [cid])[0]?.c) === 1)
    ok('5k accept 后关闭 pending 提案卡', !salesDbService.pendingTaskBySource(TRADE_IN_TRIGGER, cid))
    ok('5l accept 后客户事实仍不变', Number(crmDbService.getById('customer', cid)?.purchase_date) === now - 4 * 365 * DAY)

    // 裁决 reject（无 pending 卡可关，仍写埋点 + 审计）
    ok('5m 裁决 reject 成功', decideTradeIn(cid, 'reject', '测试销售').ok)
    ok('5n reject 埋点（proposal/rejected）', salesDbService.proposalEventCount({ event_type: 'proposal', stage: 'rejected' }) >= 1)

    // 车龄依据分支
    const { cid: cAge } = linkCustomer('车龄换新客户')
    saveEquipment(cAge, { vehicle_age: 4 }, '测试销售')
    ok('5o 真实车龄推导依据', tradeInBasisOf(crmDbService.getById('customer', cAge)!, now)?.kind === 'vehicle_age')
  }

  // ── ⑥ 复购等级 recomputeRepeatLevel（单一原语 computeRepeatLevel）────────────
  {
    ok('6a 复购等级原语（1/2/3 分档）',
      computeRepeatLevel(0) === REPEAT_LEVEL_FIRST && computeRepeatLevel(1) === REPEAT_LEVEL_FIRST &&
      computeRepeatLevel(2) === REPEAT_LEVEL_REPEAT && computeRepeatLevel(3) === REPEAT_LEVEL_HIGH)

    const { accId, cid } = linkCustomer('复购等级客户')
    // 三笔 won（不同产品 = 三个商机），钩子每笔成交自动重算复购等级
    for (const model of ['RA', 'RB', 'RC']) {
      crmDbService.create('product', { model, name: '复购车', unit_price: 5000, specs: '{}', variants: '[]', created_at: Date.now() })
      const opp = crmDbService.opportunityUpsertBySignal(accId, '复购等级客户', { product: `型号${model}`, quantity: 1, amount: 0, stage: '决策', detail: 'x' })
      crmDbService.registerOpportunityDeal(opp.id, { amount_cny: 5000, main_model: model, order_qty: 1, type: '整车' })
    }
    const cu = crmDbService.getById('customer', cid)
    ok('6b 三笔成交复购等级=高频复购·升A', String(cu?.repeat_level) === REPEAT_LEVEL_HIGH)
    ok('6c 等级变化写审计（customer_repeat_level_change）',
      Number(crmDbService.all("SELECT COUNT(*) AS c FROM audit_event WHERE action = 'customer_repeat_level_change' AND entity_type = 'customer' AND entity_id = ?", [cid])[0]?.c) >= 1)
    ok('6d 重算幂等（等级未变零写入）', recomputeRepeatLevel(cid, '测试销售').changed === false)

    // 单一归并键：不同 account 挂同一 customer 也合并
    const acc2 = crmDbService.ensureAccount('复购二店')
    crmDbService.update('account', acc2, { customer_id: cid })
    crmDbService.create('product', { model: 'RD', name: '复购车2', unit_price: 5000, specs: '{}', variants: '[]', created_at: Date.now() })
    const opp2 = crmDbService.opportunityUpsertBySignal(acc2, '复购二店', { product: '型号RD', quantity: 1, amount: 0, stage: '决策', detail: 'x' })
    crmDbService.registerOpportunityDeal(opp2.id, { amount_cny: 5000, main_model: 'RD', order_qty: 1, type: '整车' })
    ok('6e 跨 account 同 customer 归并（仍 4 笔，等级不变）', String(crmDbService.getById('customer', cid)?.repeat_level) === REPEAT_LEVEL_HIGH)
  }

  // ── ⑦ 读口 / 扫描 / 建议（页面事实源 + 幂等扫描）────────────────────────────
  {
    const tasks = listDeliveryTasks()
    ok('7a 任务读口分类返回（四类数组）', Array.isArray(tasks.diff) && Array.isArray(tasks.warrantyNear) && Array.isArray(tasks.warrantyExpired) && Array.isArray(tasks.tradeIn))
    const scan = runDeliveryScan()
    ok('7b 统一扫描返回数值统计（幂等零新卡）',
      scan.diffCreated === 0 && typeof scan.warrantyNear === 'number' && typeof scan.warrantyExpired === 'number' && typeof scan.tradeIn === 'number')

    // 签收日期建议只读：无物流 → null，且不改 opportunity.delivery_date
    const d = wonDeal('建议只读客户', 2)
    ok('7c 签收建议只读（无物流返回 null 且不写库）',
      suggestDeliveryDate(d.oppId) === null && Number(crmDbService.opportunityById(d.oppId)?.delivery_date || 0) === 0)
  }

  // ── ⑧ 以旧换新「裁决 → 刷新」终态保持（相同依据不重出，依据变化才重新提案）───────
  {
    const now = Date.now()
    const { cid } = linkCustomer('裁决刷新客户')
    saveEquipment(cid, { purchase_date: now - 4 * 365 * DAY }, '测试销售')
    const basis = tradeInBasisOf(crmDbService.getById('customer', cid)!, now)!
    const p1 = proposeTradeIn(cid, basis, '测试销售')
    ok('8a 首次出卡成功', p1.ok && Number(p1.taskId) > 0)
    const taskId1 = Number(p1.taskId)
    ok('8b 人工 reject 裁决成功', decideTradeIn(cid, 'reject', '测试销售').ok)
    ok('8c 裁决后无 pending 提案卡', !salesDbService.pendingTaskBySource(TRADE_IN_TRIGGER, cid))
    // 先扫一轮消化其他客户（如⑤车龄客户）的历史首次出卡，隔离 generated 计数干扰
    runTradeInProposalScan(now)
    const genBefore = salesDbService.proposalEventCount({ event_type: 'proposal', stage: 'generated' })
    const rescanT = runTradeInProposalScan(now)
    const rescanD = runDeliveryScan(now)
    ok('8d 裁决后重扫不出新卡（两种扫描路径 tradeIn=0）', rescanT === 0 && rescanD.tradeIn === 0 && !salesDbService.pendingTaskBySource(TRADE_IN_TRIGGER, cid))
    ok('8e 直调返回 DECIDED（终态保留，不写埋点不建卡）', (() => {
      const r = proposeTradeIn(cid, basis, '测试销售')
      return r.ok && r.code === 'DECIDED' && Number(r.taskId) === 0
    })())
    ok('8f 重扫+直调 generated 埋点零增长', salesDbService.proposalEventCount({ event_type: 'proposal', stage: 'generated' }) === genBefore)
    ok('8g done 历史保留（裁决信息在 analysis）', (() => {
      const latestDone = salesDbService.latestTaskBySource(TRADE_IN_TRIGGER, cid)
      if (!latestDone || Number(latestDone.id) !== taskId1 || String(latestDone.status) !== 'done') return false
      const a = JSON.parse(String(latestDone.analysis || '{}'))
      return a.decision === 'reject' && a.evidenceKey === basis.evidenceKey
    })())
    // 依据真实变化（另一个仍满 3 年的购置日期）→ 允许重新提案
    saveEquipment(cid, { purchase_date: now - 5 * 365 * DAY }, '测试销售')
    const basis2 = tradeInBasisOf(crmDbService.getById('customer', cid)!, now)!
    ok('8h 依据变化生成新 evidenceKey', basis2.evidenceKey !== basis.evidenceKey)
    ok('8i 依据变化重扫出新 pending 卡', runTradeInProposalScan(now) === 1 && !!salesDbService.pendingTaskBySource(TRADE_IN_TRIGGER, cid))
    ok('8j 新卡带新依据（evidenceKey 更新）', String(salesDbService.pendingTaskBySource(TRADE_IN_TRIGGER, cid)!.analysis || '').includes(basis2.evidenceKey))
  }

  // ── ⑨ 部分发货 → 差异卡原地更新（不新开卡；无变化零写入）─────────────────────
  {
    const c = wonDeal('部分发货客户', 5) // 成交钩子出「差 5 台」卡
    const card0 = salesDbService.pendingTaskBySource(DIFF_TRIGGER, c.oppId)!
    ok('9a 钩子已出差异卡（差 5 台）', !!card0 && String(card0.title).includes('差 5 台'))
    const r = registerDelivery(c.oppId, { shipped_qty: 3, actor: '测试销售' })
    ok('9b 部分发货走更新分支（diffTaskUpdated=1，不新开卡）', r.ok && r.data?.diffTaskUpdated === 1 && r.data?.diffTaskCreated === 0)
    const card1 = salesDbService.pendingTaskBySource(DIFF_TRIGGER, c.oppId)!
    ok('9c 同一张卡原地更新（id 不变）', Number(card1.id) === Number(card0.id))
    ok('9d 标题刷新为「差 2 台」', String(card1.title).includes('差 2 台'))
    ok('9e analysis 同步最新量 + 更新留痕', (() => {
      const a = JSON.parse(String(card1.analysis || '{}'))
      return Number(a.shippedQty) === 3 && Number(a.gap) === 2 && Number(a.orderQty) === 5 &&
        typeof a.updatedAt === 'number' && a.updatedBy === '测试销售'
    })())
    ok('9f 优先级随差异收敛（70+min(2,30)=72）', Number(card1.priority_score) === 72)
    const re = syncDiffTask(c.oppId)
    ok('9g 无变化重扫零写入（created/closed/updated 全 0）', re.created === 0 && re.closed === 0 && re.updated === 0)
  }

  // ── ⑩ 质保提醒人工完成 → 重扫不重出（同周期终态判重）─────────────────────────
  {
    const now = Date.now()
    const { cid } = linkCustomer('提醒完成客户')
    saveEquipment(cid, { warranty_start_date: now - 350 * DAY, warranty_days: 365 }, '测试销售')
    const nearCard = salesDbService.pendingTaskBySource(WARRANTY_NEAR_TRIGGER, cid)
    ok('10a 临期卡出卡即写周期（analysis.kind/expiry）', (() => {
      if (!nearCard) return false
      const a = JSON.parse(String(nearCard.analysis || '{}'))
      return a.kind === 'near' && Number(a.expiry) === now - 350 * DAY + 365 * DAY
    })())
    salesDbService.todoUpdate(Number(nearCard!.id), { status: 'done' }) // 模拟人工完成
    const rescan = runWarrantyReminderScan(now)
    ok('10b 完成后重扫不重复出卡（near 不增）', rescan.near === 0 && !salesDbService.pendingTaskBySource(WARRANTY_NEAR_TRIGGER, cid))
    const latest = salesDbService.latestTaskBySource(WARRANTY_NEAR_TRIGGER, cid)
    ok('10c 同周期 done 卡仍是最新卡（终态判重依据）', !!latest && Number(latest.id) === Number(nearCard!.id) && String(latest.status) === 'done')
  }

  // ── ⑪ 质保日期变更/清空/跨档的全生命周期（stale 卡自动关闭 + 审计 + 历史保留）──
  {
    const now = Date.now()
    // a) 延长质保：新周期未入临期窗 → 旧卡失效关闭，零新卡
    const { cid } = linkCustomer('质保变更客户')
    saveEquipment(cid, { warranty_start_date: now - 350 * DAY, warranty_days: 365 }, '测试销售') // expiry=now+15d → near
    const n1 = salesDbService.pendingTaskBySource(WARRANTY_NEAR_TRIGGER, cid)!
    ok('11a 先出临期卡（周期 expiry=now+15d）', !!n1)
    saveEquipment(cid, { warranty_start_date: now, warranty_days: 365 }, '测试销售') // expiry=now+365d → 未入窗
    const n1After = salesDbService.getTask(Number(n1.id))!
    ok('11b 周期变更旧卡自动关闭（done + closedReason）', String(n1After.status) === 'done' && String(n1After.analysis || '').includes('closedReason'))
    ok('11c 旧卡原周期字段不被改写（expiry 保持原值）', Number(JSON.parse(String(n1After.analysis || '{}')).expiry) === now - 350 * DAY + 365 * DAY)
    ok('11d 新周期未入窗零新卡', !salesDbService.pendingTaskBySource(WARRANTY_NEAR_TRIGGER, cid) && !salesDbService.pendingTaskBySource(WARRANTY_EXPIRED_TRIGGER, cid))

    // b) 清空质保期限：pending 全关，reason 含「清空」
    saveEquipment(cid, { warranty_start_date: now - 350 * DAY, warranty_days: 380 }, '测试销售') // 新周期（expiry 不同）重新出卡
    const n2 = salesDbService.pendingTaskBySource(WARRANTY_NEAR_TRIGGER, cid)!
    ok('11e 新周期重新出卡（新卡 id 不同）', !!n2 && Number(n2.id) !== Number(n1.id))
    saveEquipment(cid, { warranty_days: 0 }, '测试销售') // 清空期限
    const n2After = salesDbService.getTask(Number(n2.id))!
    ok('11f 清空后 pending 全关且 reason 含「清空」', String(n2After.status) === 'done' && String(n2After.analysis || '').includes('清空'))
    ok('11g 清空后无任何 pending 质保卡', !salesDbService.pendingTaskBySource(WARRANTY_NEAR_TRIGGER, cid) && !salesDbService.pendingTaskBySource(WARRANTY_EXPIRED_TRIGGER, cid))

    // c) 跨档：质保进入已到期 → near 关卡「接替」+ expired 新卡
    const { cid: cid2 } = linkCustomer('质保跨档客户')
    saveEquipment(cid2, { warranty_start_date: now - 350 * DAY, warranty_days: 365 }, '测试销售') // near
    const n3 = salesDbService.pendingTaskBySource(WARRANTY_NEAR_TRIGGER, cid2)!
    saveEquipment(cid2, { warranty_start_date: now - 400 * DAY }, '测试销售') // expiry=now-35d → 已到期
    const n3After = salesDbService.getTask(Number(n3.id))!
    ok('11h 跨档 near 卡关闭且 reason 含「接替」', String(n3After.status) === 'done' && String(n3After.analysis || '').includes('接替'))
    const expC = salesDbService.pendingTaskBySource(WARRANTY_EXPIRED_TRIGGER, cid2)
    ok('11i 跨档出 expired 新卡（analysis 记新周期）', (() => {
      if (!expC) return false
      const a = JSON.parse(String(expC.analysis || '{}'))
      return a.kind === 'expired' && Number(a.expiry) === now - 400 * DAY + 365 * DAY
    })())

    // d) 自动关闭审计落行；e) 历史 done 行保留
    ok('11j 自动关闭审计 warranty_reminder_autoclose 落行',
      Number(crmDbService.all("SELECT COUNT(*) AS c FROM audit_event WHERE action = 'warranty_reminder_autoclose' AND entity_type = 'customer' AND entity_id IN (?, ?)", [cid, cid2])[0]?.c) >= 3)
    ok('11k 历史 done 行保留不删（该客户 2 张 near 卡）',
      salesDbService.todoList({}).filter((t) => t.trigger_type === WARRANTY_NEAR_TRIGGER && Number(t.source_id) === cid).length === 2)
  }

  // ── ⑬ 质保恢复回归（二轮审查 P2）：清空自动关闭 ≠ 人工完成，恢复有效资料后允许重新提醒 ──
  {
    const now = Date.now()
    const { cid } = linkCustomer('质保恢复客户')
    saveEquipment(cid, { warranty_start_date: now - 350 * DAY, warranty_days: 365 }, '测试销售') // near
    const w1 = salesDbService.pendingTaskBySource(WARRANTY_NEAR_TRIGGER, cid)!
    ok('13a 临期卡已出（基线）', !!w1)
    saveEquipment(cid, { warranty_days: 0 }, '测试销售') // 清空期限 → 自动失效关闭
    ok('13b 清空后旧卡自动关闭（done + closedReason）',
      String(salesDbService.getTask(Number(w1.id))!.status) === 'done' &&
      String(salesDbService.getTask(Number(w1.id))!.analysis || '').includes('清空'))
    // 恢复原期限（同周期 expiry）：旧卡是自动关闭而非人工完成 → 允许重新提醒
    saveEquipment(cid, { warranty_start_date: now - 350 * DAY, warranty_days: 365 }, '测试销售')
    const w2 = salesDbService.pendingTaskBySource(WARRANTY_NEAR_TRIGGER, cid)
    ok('13c 恢复原质保资料后重新出卡（新卡 id 不同）', !!w2 && Number(w2.id) !== Number(w1.id))
    ok('13d 历史自动关闭卡保留不删', String(salesDbService.getTask(Number(w1.id))!.status) === 'done')
    // 对照：人工完成仍保持终态（重扫不重出）
    salesDbService.todoUpdate(Number(w2!.id), { status: 'done' })
    const scan = runWarrantyReminderScan(now)
    ok('13e 人工完成后同周期重扫仍不重出（终态判重不被 13c 削弱）',
      !salesDbService.pendingTaskBySource(WARRANTY_NEAR_TRIGGER, cid) &&
      !salesDbService.todoList({}).some((t) => t.trigger_type === WARRANTY_NEAR_TRIGGER && Number(t.source_id) === cid && Number(t.id) > Number(w2!.id)) &&
      scan.near === 0)
  }

  // ── ⑫ 展示层静态断言（DeliveryAftersales.tsx：整数完整转换 + 归属过滤口径，2026-09-10 审查修复）──
  {
    const pageSrc = readFileSync(join(__dirname, '..', 'src/components/crm/DeliveryAftersales.tsx'), 'utf8')
    ok('12a 整数输入不静默截断（全文件无 parseInt，统一 parseNonNegInt 完整转换 + 非负整数校验）',
      !/parseInt/.test(pageSrc) && /function parseNonNegInt/.test(pageSrc) && /Number\.isInteger/.test(pageSrc))
    ok('12b 实发量/车龄/质保期限非法输入走现有 notice 提示（不自动取整、不加确认步骤）',
      /实发量必须是非负整数/.test(pageSrc) && /必须是非负整数/.test(pageSrc) && /parseNonNegInt\(raw\)/.test(pageSrc))
    ok('12c 超发判断与保存同一口径（parseNonNegInt，非法输入不算超发）',
      /const shippedVal = parseNonNegInt\(edit\.shipped\)/.test(pageSrc))
    ok('12d 售后视图复用 filterByOwner 口径（成交单 + 任务统一过滤，主管视角不变）',
      /filterByOwner/.test(pageSrc) && /filterByOwner\(oppRows, idt\)/.test(pageSrc) &&
      /filterByOwner\(list\.map/.test(pageSrc))
    ok('12e 销售视角提示与父页面一致（仅显示我名下及未归属的数据）',
      /仅显示我名下及未归属的数据/.test(pageSrc) && /isSalesView\(identity\)/.test(pageSrc))
    // 2026-09-10 二轮审查 P2 回归
    ok('12f 复购等级按完整成交集合计算（归属过滤只控可见性，不改事实）',
      /const \[allDeals, setAllDeals\]/.test(pageSrc) && /countWonByCustomerKey\(allDeals/.test(pageSrc))
    ok('12g 身份先加载再首次拉数 + 过期请求序号丢弃（旧响应不覆盖新结果）',
      /useState<IdentityLike \| null>\(null\)/.test(pageSrc) && /if \(identity\) void fetchAll\(identity\)/.test(pageSrc) &&
      /requestSeq !== fetchSeq\.current/.test(pageSrc))
    const viewSrc = readFileSync(join(__dirname, '..', 'src/utils/deliveryAftersalesView.ts'), 'utf8')
    ok('12h 客户任务归属聚合全部挂接 account（任一未归属/本人即见，与返回顺序无关）',
      /Map<number, Set<string>>/.test(viewSrc) && /owners\.add/.test(viewSrc) &&
      /some\(\(owner\) => !owner \|\| owner === me\)/.test(viewSrc))
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
