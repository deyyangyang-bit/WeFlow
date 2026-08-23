/**
 * crm-logistics-test.ts —— 物流跟单模块单测
 * 覆盖：单号幂等（同批列表重扫不重复建单）、认领带销售落库、
 *       超期判定（24h 阈值边界：已认领未签收命中 / 未超期不命中 / 已签收不命中 / 未认领不命中）、
 *       签收闭环（R8 卡完成 → 卡 done + logistics signed + signed_at 写入）、logisticsList 分类。
 * 运行：npx tsx scripts/crm-logistics-test.ts
 */
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { crmDbService } from '../electron/services/crmDbService'
import { salesDbService } from '../electron/services/salesDbService'
import { completeUnifiedSignal } from '../electron/services/salesActionEngine'

let pass = 0, fail = 0
function ok(name: string, cond: boolean): void {
  if (cond) { pass++ } else { fail++; console.error('FAIL:', name) }
}

/** 与 crmParseService 物流批量分支一致的幂等落库：已存在只刷新 latest_update_at */
function upsertLogistics(row: { tracking_no: string; brand?: string; receiver?: string; city?: string; latest_update_at: number }): number {
  const existing = crmDbService.logisticsByTrackingNo(row.tracking_no)
  if (existing) {
    crmDbService.update('logistics', Number(existing.id), { latest_update_at: row.latest_update_at })
    return Number(existing.id)
  }
  return crmDbService.create('logistics', {
    tracking_no: row.tracking_no, brand: row.brand ?? '', receiver: row.receiver ?? '', city: row.city ?? '',
    courier: '安能物流', status: 'shipped', link_status: 'unlinked',
    latest_update_at: row.latest_update_at, created_at: Date.now()
  })
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'crm-logistics-'))
  await crmDbService.initialize(dir)
  await salesDbService.initialize(dir)

  // ── 1 单号幂等：物流群每晚同批列表重扫/补扫不重复建单 ───────────────────────
  const t1 = Date.now() - 24 * 3600 * 1000
  const t2 = Date.now() - 23 * 3600 * 1000
  const id1 = upsertLogistics({ tracking_no: '800215394785', brand: '艾驱电动', receiver: '刘敏', city: '成都', latest_update_at: t1 })
  const id2 = upsertLogistics({ tracking_no: '800215394785', brand: '艾驱电动', receiver: '刘敏', city: '成都', latest_update_at: t2 })
  ok('1a 同单号幂等不重复建单', id1 === id2)
  ok('1b 已存在只刷新 latest_update_at', Number(crmDbService.getById('logistics', id1)?.latest_update_at) === t2)
  const id3 = upsertLogistics({ tracking_no: '999001122', brand: '其他品牌', receiver: '王五', city: '杭州', latest_update_at: t2 })
  ok('1c 不同单号不误伤', id3 !== id1)
  ok('1d 查重函数无单号返回 null', crmDbService.logisticsByTrackingNo('不存在单号') === null)

  // ── 2 认领带销售：linkLogistics 透传 owner_sales ───────────────────────────
  const accountId = crmDbService.ensureAccount('成都某搬运设备公司')
  crmDbService.update('account', accountId, { session_id: 'wx_ck_chengdu', owner_sales: '许丽娟' })
  const contractId = crmDbService.create('contract', {
    account_id: accountId, name: '成都某搬运设备公司-合同', amount: 12000, status: 'pending_sign',
    created_at: Date.now(), updated_at: Date.now()
  })
  const r = crmDbService.linkLogistics(id1, { contractId, ownerSales: '张三' })
  ok('2a 认领成功', r.ok)
  const l1 = crmDbService.getById('logistics', id1)
  ok('2b owner_sales 落库', String(l1?.owner_sales) === '张三')
  ok('2c link_status=linked', l1?.link_status === 'linked')
  const r2 = crmDbService.linkLogistics(id3, { contractId })
  ok('2d 不传 owner_sales 认领成功', r2.ok)
  ok('2e 不传 owner_sales 保持空', String(crmDbService.getById('logistics', id3)?.owner_sales) === '')

  // ── 3 超期判定：pendingLogisticsOverdue(24) ────────────────────────────────
  const now = Date.now()
  const logiA = crmDbService.create('logistics', { tracking_no: 'A001', brand: '艾驱电动', receiver: '刘敏', city: '成都', courier: '安能物流', status: 'shipped', link_status: 'linked', contract_id: contractId, latest_update_at: now - 30 * 3600 * 1000, created_at: now })
  const logiB = crmDbService.create('logistics', { tracking_no: 'B001', brand: '艾驱电动', receiver: '刘敏', city: '成都', courier: '安能物流', status: 'shipped', link_status: 'linked', contract_id: contractId, latest_update_at: now - 20 * 3600 * 1000, created_at: now })
  const logiC = crmDbService.create('logistics', { tracking_no: 'C001', brand: '艾驱电动', receiver: '刘敏', city: '成都', courier: '安能物流', status: 'signed', link_status: 'linked', contract_id: contractId, signed_at: now - 10 * 3600 * 1000, latest_update_at: now - 30 * 3600 * 1000, created_at: now })
  const logiD = crmDbService.create('logistics', { tracking_no: 'D001', brand: '艾驱电动', receiver: '刘敏', city: '成都', courier: '安能物流', status: 'shipped', link_status: 'unlinked', latest_update_at: now - 30 * 3600 * 1000, created_at: now })
  const overdue = crmDbService.pendingLogisticsOverdue(24)
  const nos = new Set(overdue.map((l) => String(l.tracking_no)))
  ok('3a 30h 已认领未签收命中', nos.has('A001'))
  ok('3b 20h 未超期不命中', !nos.has('B001'))
  ok('3c 已签收不命中', !nos.has('C001'))
  ok('3d 未认领不命中（只跟已认领的）', !nos.has('D001'))
  const hit = overdue.find((l) => String(l.tracking_no) === 'A001')
  // owner_sales = 物流单认领销售（A001 未填 → 空）；account_owner_sales = 客户归属销售
  ok('3e 带出客户名/归属销售/归属 session', Boolean(hit?.customer_name) && String(hit?.account_owner_sales) === '许丽娟' && String(hit?.session_id) === 'wx_ck_chengdu' && String(hit?.owner_sales) === '')

  // ── 4 签收闭环：R8 卡（logi:<id> 虚拟 session）完成 → 卡 done + 物流 signed ──
  const task = salesDbService.todoCreate({
    session_id: `logi:${logiA}`, display_name: '刘敏', trigger_type: 'rule_r8_logistics_overdue',
    title: '物流跟进：艾驱电动（刘敏），单号 A001，发货超 30 小时未确认签收',
    status: 'pending', priority_score: 87, created_by: 'test'
  })
  ok('4a R8 卡已建', Boolean(task.id))
  completeUnifiedSignal(`logi:${logiA}`, 'done')
  const doneTask = salesDbService.todoList({ session_id: `logi:${logiA}`, limit: 5 }).find((t) => t.id === task.id)
  ok('4b 卡 done', doneTask?.status === 'done')
  const lA = crmDbService.getById('logistics', Number(logiA))
  ok('4c 物流单 status=signed', lA?.status === 'signed')
  ok('4d signed_at 已写入', Number(lA?.signed_at) > 0)
  // 再次完成（重复调用）幂等：markLogisticsSigned 已 signed 返回 ok 不报错
  completeUnifiedSignal(`logi:${logiA}`, 'done')
  ok('4e 重复完成幂等不报错', true)
  // skipped 分支：不标记签收
  const logiE = crmDbService.create('logistics', { tracking_no: 'E001', brand: '艾驱电动', receiver: '刘敏', city: '成都', courier: '安能物流', status: 'shipped', link_status: 'linked', contract_id: contractId, latest_update_at: now - 40 * 3600 * 1000, created_at: now })
  const task2 = salesDbService.todoCreate({
    session_id: `logi:${logiE}`, display_name: '刘敏', trigger_type: 'rule_r8_logistics_overdue',
    title: '物流跟进：艾驱电动（刘敏），单号 E001', status: 'pending', priority_score: 87, created_by: 'test'
  })
  completeUnifiedSignal(`logi:${logiE}`, 'skipped')
  ok('4f skipped 不标记签收', crmDbService.getById('logistics', Number(logiE))?.status === 'shipped')

  // ── 5 logisticsList 分类视图 ────────────────────────────────────────────────
  const unlinkedList = crmDbService.logisticsList({ filter: 'unlinked' })
  ok('5a unlinked 全为待认领', unlinkedList.length > 0 && unlinkedList.every((l) => l.link_status === 'unlinked'))
  const pendingList = crmDbService.logisticsList({ filter: 'pending' })
  ok('5b pending 已认领未签收', pendingList.length > 0 && pendingList.every((l) => l.link_status === 'linked' && l.status === 'shipped'))
  const signedList = crmDbService.logisticsList({ filter: 'signed' })
  ok('5c signed 全为已签收', signedList.length > 0 && signedList.every((l) => l.status === 'signed'))
  const all = crmDbService.logisticsList()
  ok('5d 全量倒序（首条最新）', all.length >= 6 && Number(all[0].created_at) >= Number(all[all.length - 1].created_at))
  ok('5e pending 不包含已签收 A 单', !pendingList.some((l) => String(l.tracking_no) === 'A001'))

  // ── 6 账户级认领：无合同客户也能认领物流（account_id 落库，合同可选）────────
  const accNoC = crmDbService.ensureAccount('宁波某无合同客户')
  crmDbService.update('account', accNoC, { session_id: 'wx_ck_ningbo', owner_sales: '李四' })
  const idAcc = upsertLogistics({ tracking_no: 'ACCTEST01', brand: '艾驱电动', receiver: '赵六', city: '宁波', latest_update_at: Date.now() - 30 * 3600 * 1000 })
  const rNoC = crmDbService.linkLogistics(idAcc, { accountId: accNoC, ownerSales: '王五' })
  ok('6a 认领到客户（无合同）成功', rNoC.ok)
  const lNoC = crmDbService.getById('logistics', idAcc)
  ok('6b account_id 落库 + contract_id 空 + linked', Number(lNoC?.account_id) === accNoC && lNoC?.contract_id === null && lNoC?.link_status === 'linked')
  ok('6c owner_sales 落库', String(lNoC?.owner_sales) === '王五')
  // 传 contractId → 自动带出 account_id
  const rDerive = crmDbService.linkLogistics(id1, { contractId })
  ok('6d 传合同自动带出客户', Number(crmDbService.getById('logistics', id1)?.account_id) === accountId)
  // 无认领目标 → ok:false
  const rNone = crmDbService.linkLogistics(idAcc, {})
  ok('6e 缺认领目标返回失败', rNone.ok === false && Boolean(rNone.reason))
  // 账户级已认领物流进入超期（带出客户名/归属销售/归属 session）
  const logiF = crmDbService.create('logistics', { tracking_no: 'F001', brand: '艾驱电动', receiver: '赵六', city: '宁波', courier: '安能物流', status: 'shipped', link_status: 'linked', account_id: accNoC, latest_update_at: Date.now() - 30 * 3600 * 1000, created_at: Date.now() })
  const fHit = crmDbService.pendingLogisticsOverdue(24).find((l) => String(l.tracking_no) === 'F001')
  ok('6f 账户级物流进超期', Boolean(fHit))
  ok('6g 带出客户名/归属销售/归属 session', String(fHit?.customer_name) === '宁波某无合同客户' && String(fHit?.account_owner_sales) === '李四' && String(fHit?.session_id) === 'wx_ck_ningbo')
  // 时间线：无合同认领的物流出现在客户 360
  ok('6h 时间线含账户级物流', crmDbService.accountTimeline(accNoC).some((t) => t.text.includes('宁波某无合同客户')))
  // candidates：viaShip 收件人命中无合同客户 → 返回账户级候选
  crmDbService.saveShippingInfo({ account_id: accNoC, receiver: '赵六', phone: '', address: '宁波', city: '宁波', source_msg_id: 'ship_nb', created_at: Date.now() })
  const candAcc = crmDbService.logisticsCandidates('赵六', '宁波')
  ok('6i 无合同客户返回账户级候选', candAcc.length === 1 && String(candAcc[0].cand_kind) === 'account' && Number(candAcc[0].account_id) === accNoC)
  // 扫描自动认领：无合同客户按收件人认领到客户（auto_linked_by 落库，可撤销）
  const idAcc2 = upsertLogistics({ tracking_no: 'ACCTEST02', brand: '艾驱电动', receiver: '赵六', city: '宁波', latest_update_at: Date.now() - 10 * 3600 * 1000 })
  ok('6j 自动认领无合同客户成功', crmDbService.autoLinkLogisticsByReceiver(idAcc2, '赵六'))
  const lAcc2 = crmDbService.getById('logistics', idAcc2)
  ok('6k 自动认领 account_id + auto_linked_by 落库', Number(lAcc2?.account_id) === accNoC && lAcc2?.contract_id === null && String(lAcc2?.auto_linked_by) === 'auto')
  // 撤销自动链接：同时清 account_id
  const u = crmDbService.undoLogistics(idAcc2)
  const lAcc2u = crmDbService.getById('logistics', idAcc2)
  ok('6l 撤销清 account_id + contract_id', u.ok && lAcc2u?.account_id === null && lAcc2u?.contract_id === null && lAcc2u?.link_status === 'unlinked')

  console.log(`LOGISTICS RESULT: pass=${pass} fail=${fail}`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
