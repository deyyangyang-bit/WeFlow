/**
 * crm-workbench-test.ts —— CRM 工作台业务闭环单测
 * 覆盖：归属绑定合同后 creditedTotal 上涨、签约状态机、activeContractForAccount、发票挂合同
 * 运行：npx tsx scripts/crm-workbench-test.ts
 */
import { mkdtempSync, rmSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { crmDbService } from '../electron/services/crmDbService'

let pass = 0, fail = 0
function ok(name: string, cond: boolean): void {
  if (cond) { pass++ } else { fail++; console.error('FAIL:', name) }
}

async function main(): Promise<void> {
  // ── 0 合同列表套用 SearchTable 骨架（静态断言：引入 + 筛选栏 + 分页）──────
  const pageSrc = readFileSync(join(__dirname, '..', 'src/pages/CrmWorkbenchPage.tsx'), 'utf8')
  const compSrc = readFileSync(join(__dirname, '..', 'src/components/crm/SearchTable.tsx'), 'utf8')
  ok('0a 合同工作台引入并使用 SearchTable（含筛选栏/分页/行点击）',
    /from '\.\.\/components\/crm\/SearchTable'/.test(pageSrc) &&
    /<SearchTable/.test(pageSrc) && /filterBar=\{/.test(pageSrc) &&
    /onPageChange=\{setTablePage\}/.test(pageSrc) && /onRowClick=\{\(c\) => void select\(c\)\}/.test(pageSrc))
  ok('0b SearchTable 骨架要素齐全（筛选栏/工具栏/表格/分页条 + 前端分页切片）',
    /function SearchTable</.test(compSrc) && /filterBar\?/.test(compSrc) &&
    /toolbar\?/.test(compSrc) && /search-table__pager/.test(compSrc) &&
    /data\.slice\(\(cur - 1\) \* pageSize, cur \* pageSize\)/.test(compSrc) &&
    /emptyText = '暂无数据'/.test(compSrc))

  const dir = mkdtempSync(join(tmpdir(), 'crm-workbench-'))
  await crmDbService.initialize(dir)

  // ── 1 归属绑定合同后 creditedTotal 上涨 ────────────────────────────────────
  const accountId = crmDbService.ensureAccount('上海普绿包装制品有限公司')
  const contractId = crmDbService.create('contract', {
    account_id: accountId, name: '上海普绿-合同', amount: 7600, status: 'pending_sign',
    created_at: Date.now(), updated_at: Date.now()
  })
  const payId = crmDbService.createPaymentRecord({ payer: '上海普绿包装制品有限公司', amount_net: 7600, pay_channel: 'bank_direct', created_at: Date.now() })
  const allocIds = crmDbService.addAllocations(payId, [{ customerHint: '上海普绿包装制品有限公司', salesHint: '许丽娟', amountHint: 7600 }])
  ok('1a 归属初始为 pending', crmDbService.pendingAllocations().length === 1)

  // 未绑定合同 → creditedTotal 为 0（断点 1 复现）
  ok('1b 未绑定合同 creditedTotal=0', crmDbService.creditedTotal(contractId) === 0)

  // 确认并绑定合同 → creditedTotal 上涨
  const confirmRes = crmDbService.confirmAllocation(allocIds[0], { contract_id: contractId })
  ok('1c 确认绑定成功', confirmRes.ok)
  ok('1d 绑定后 creditedTotal=7600', crmDbService.creditedTotal(contractId) === 7600)
  ok('1e 已确认归属不再出现在待确认队列', crmDbService.pendingAllocations().length === 0)

  // ── 2 签约状态机 ───────────────────────────────────────────────────────────
  ok('2a pending_sign 可签约', crmDbService.signContract(contractId).ok)
  ok('2b 重复签约被拒', crmDbService.signContract(contractId).ok === false)
  const c = crmDbService.getById('contract', contractId)
  ok('2c 签约后 status=signed', c?.status === 'signed')
  ok('2d 签约后 sign_date 已写', Number(c?.sign_date) > 0)

  // ── 3 activeContractForAccount ─────────────────────────────────────────────
  const active = crmDbService.activeContractForAccount(accountId)
  ok('3a 命中最近可挂款合同', active && Number(active.id) === contractId)
  const ghost = crmDbService.activeContractForAccount(999999)
  ok('3b 无合同返回 null', ghost === null)

  // ── 4 发货卡点（全款到账才发货）────────────────────────────────────────────
  // 新合同金额 10000，先绑 7600 → 缺口 2400 拒发；补 2400 → 放行
  const gapContractId = crmDbService.create('contract', {
    account_id: accountId, name: '上海普绿-大额合同', amount: 10000, status: 'pending_sign',
    created_at: Date.now(), updated_at: Date.now()
  })
  crmDbService.signContract(gapContractId)
  const pay2 = crmDbService.createPaymentRecord({ payer: '上海普绿包装制品有限公司', amount_net: 7600, pay_channel: 'bank_direct', created_at: Date.now() })
  const alloc2 = crmDbService.addAllocations(pay2, [{ customerHint: '上海普绿包装制品有限公司', salesHint: '许丽娟', amountHint: 7600 }])
  crmDbService.confirmAllocation(alloc2[0], { contract_id: gapContractId })
  const shipReject = crmDbService.shipContract(gapContractId)
  ok('4a 全款未到齐拒发货并返回缺口', !shipReject.ok && shipReject.gap === 2400)
  const pay3 = crmDbService.createPaymentRecord({ payer: '上海普绿包装制品有限公司', amount_net: 2400, pay_channel: 'bank_direct', created_at: Date.now() })
  const alloc3 = crmDbService.addAllocations(pay3, [{ customerHint: '上海普绿包装制品有限公司', salesHint: '许丽娟', amountHint: 2400 }])
  crmDbService.confirmAllocation(alloc3[0], { contract_id: gapContractId })
  ok('4b 全款到齐后发货放行', crmDbService.shipContract(gapContractId).ok)
  ok('4c 发货后不可回退', crmDbService.shipContract(gapContractId).ok === false)
  ok('4d 发货后不可签约', crmDbService.signContract(gapContractId).ok === false)

  // ── 5 报价单：行项必须来自 product ─────────────────────────────────────────
  const bad = crmDbService.createQuotation({ contract_id: contractId, items: [{ product_id: 999, qty: 1 }] })
  ok('5a 不存在型号被拒', !bad.ok)
  const productId = crmDbService.create('product', {
    model: 'CDD12', name: '电动堆高车', unit_price: 3800, specs: '{}', variants: '[]', created_at: Date.now()
  })
  const quo = crmDbService.createQuotation({ contract_id: contractId, items: [{ product_id: productId, qty: 2 }] })
  ok('5b 报价单创建成功', quo.ok && typeof quo.id === 'number')
  const q = crmDbService.getById('quotation', quo.id)
  ok('5c 报价合计=2×3800', Number(q?.total) === 7600)

  // ── 6 事件/行为日志（status_history + activity_log 埋点）───────────────────
  const hist = crmDbService.contractStatusHistory(gapContractId)
  const histActs = hist.map((h) => String(h.to_status))
  ok('6a 签约/发货状态历史落库', histActs.includes('signed') && histActs.includes('shipped'))
  const confirmAct = crmDbService.activityBy('allocation', allocIds[0])
  ok('6b 归属确认写入 activity', confirmAct.some((a) => a.action === 'confirmed'))
  const quoAct = crmDbService.activityBy('quotation', quo.id as number)
  ok('6c 报价单创建写入 activity', quoAct.some((a) => a.action === 'created'))

  // ── 7 AI 意向客户导入（幂等 + 联动列 + 聚合）────────────────────────────────
  const imp1 = crmDbService.importCustomerFromProfile({ name: '苏州鼎盛机械有限公司', sessionId: 'wxid_suzhou', stage: 'negotiating', reason: '询价2吨叉车' })
  ok('7a 首次导入新建客户', imp1.created && imp1.id > 0)
  const imp1b = crmDbService.importCustomerFromProfile({ name: '苏州鼎盛机械有限公司', sessionId: 'wxid_suzhou', stage: 'quoted' })
  ok('7b 重复导入幂等（不新建）', !imp1b.created && imp1b.id === imp1.id)
  const acc = crmDbService.getById('account', imp1.id)
  ok('7c 联动列已写（session_id/stage）', acc?.session_id === 'wxid_suzhou' && acc?.sales_stage === 'quoted')
  // 同名不同 session → 匹配已有客户（同人）
  const imp2 = crmDbService.importCustomerFromProfile({ name: '苏州鼎盛机械有限公司', sessionId: 'wxid_suzhou2', stage: 'contacted' })
  ok('7d 同名字匹配已存在客户', !imp2.created && imp2.id === imp1.id)
  // 聚合：给该客户建合同并确认归属后，customers() 反映合同数/回款
  const accContract = crmDbService.create('contract', {
    account_id: imp1.id, name: '苏州鼎盛-合同', amount: 5000, status: 'pending_sign',
    created_at: Date.now(), updated_at: Date.now()
  })
  const pay4 = crmDbService.createPaymentRecord({ payer: '苏州鼎盛机械有限公司', amount_net: 5000, pay_channel: 'bank_direct', created_at: Date.now() })
  const alloc4 = crmDbService.addAllocations(pay4, [{ customerHint: '苏州鼎盛机械有限公司', salesHint: '许丽娟', amountHint: 5000 }])
  crmDbService.confirmAllocation(alloc4[0], { contract_id: accContract })
  const custRow = crmDbService.customers().find((x) => x.id === imp1.id)
  ok('7e 聚合合同数=1', Number(custRow?.contract_count) === 1)
  ok('7f 聚合累计回款=5000', Number(custRow?.credited_total) === 5000)
  const impAct = crmDbService.activityBy('account', imp1.id)
  ok('7g 导入写入 activity', impAct.some((a) => a.action === 'imported'))

  // ── 8 私聊成交检测：成交词识别 + 自动建合同（幂等）──────────────────────────
  const dealAcc = crmDbService.importCustomerFromProfile({ name: '东莞恒宇机械有限公司', sessionId: 'wxid_deal_acc', stage: 'negotiating' })
  const deal1 = crmDbService.createDealContract(dealAcc.id, '客户说：定了，转给你')
  ok('8a 成交自动建合同', deal1.created && typeof deal1.contractId === 'number')
  const deal2 = crmDbService.createDealContract(dealAcc.id, '再次成交信号')
  ok('8b 已有合同不重复建', !deal2.created && deal2.contractId === deal1.contractId)
  const dealContract = crmDbService.getById('contract', deal1.contractId as number)
  ok('8c 合同为待签约状态', dealContract?.status === 'pending_sign')
  const dealAct = crmDbService.activityBy('contract', deal1.contractId as number)
  ok('8d 成交合同 activity 记录', dealAct.some((a) => a.action === 'created' && String(a.detail).includes('私聊成交')))

  // ── 9 级联删除：合同+子资源 / 客户+全部合同 ────────────────────────────────
  const delAcc = crmDbService.importCustomerFromProfile({ name: '宁波删除测试科技有限公司', sessionId: 'wxid_del_test', stage: 'contacted' })
  crmDbService.aliasLearn('删测机械', delAcc.id)
  const delContract = crmDbService.create('contract', {
    account_id: delAcc.id, name: '删测-合同', amount: 3000, status: 'pending_sign',
    created_at: Date.now(), updated_at: Date.now()
  })
  crmDbService.create('quotation', { contract_id: delContract, total: 3000, created_at: Date.now() })
  crmDbService.create('invoice', { contract_id: delContract, invoice_no: '删测发票', amount: 3000, created_at: Date.now() })
  crmDbService.create('logistics', { contract_id: delContract, tracking_no: 'SF000', created_at: Date.now() })
  const delPay = crmDbService.createPaymentRecord({ payer: '宁波删除测试科技有限公司', amount_net: 3000, pay_channel: 'bank_direct', created_at: Date.now() })
  const delAlloc = crmDbService.addAllocations(delPay, [{ customerHint: '宁波删除测试科技有限公司', salesHint: '测试', amountHint: 3000 }])
  crmDbService.confirmAllocation(delAlloc[0], { contract_id: delContract })
  const delSubs = () => crmDbService.all('SELECT (SELECT COUNT(*) FROM quotation WHERE contract_id=?) + (SELECT COUNT(*) FROM invoice WHERE contract_id=?) + (SELECT COUNT(*) FROM logistics WHERE contract_id=?) + (SELECT COUNT(*) FROM allocation WHERE contract_id=?) AS n', [delContract, delContract, delContract, delContract])
  ok('9a 删除前合同存在', !!crmDbService.getById('contract', delContract))
  ok('9b 删除前子资源>0', Number(delSubs()[0]?.n) > 0)
  const delRes = crmDbService.deleteContract(delContract)
  ok('9c 删除合同成功', delRes.ok)
  ok('9d 合同已删除', !crmDbService.getById('contract', delContract))
  ok('9e 子资源级联删除', Number(delSubs()[0]?.n) === 0)
  ok('9f 删除合同不动客户', !!crmDbService.getById('account', delAcc.id))
  const delAccRes = crmDbService.deleteAccount(delAcc.id)
  ok('9g 删除客户成功', delAccRes.ok)
  ok('9h 客户已删除', !crmDbService.getById('account', delAcc.id))
  ok('9i 别名随客户清理', crmDbService.all('SELECT 1 AS x FROM alias_map WHERE account_id = ?', [delAcc.id]).length === 0)

  // ── 10 确认中心修复：到款审核自动归属 / 确认自动挂合同 / 建客户去重 ──────────
  const payA = crmDbService.createPaymentRecord({ payer: '自动归属测试公司', amount_net: 2000, pay_channel: 'bank_direct', needs_review: 1, created_at: Date.now() })
  const apRes = crmDbService.approvePayment(payA)
  ok('10a 到款审核通过并建归属', apRes.ok && apRes.allocationCreated === true)
  const apAlloc = crmDbService.all('SELECT * FROM allocation WHERE payment_record_id = ? AND status = ?', [payA, 'pending'])
  ok('10b 自动建待确认归属', apAlloc.length === 1 && String(apAlloc[0].customer_hint) === '自动归属测试公司')
  ok('10c 已有归属不重复建', crmDbService.approvePayment(payA).allocationCreated === false)

  const accX = crmDbService.ensureAccount('自动挂合同测试客户')
  const cx = crmDbService.create('contract', { account_id: accX, name: '自动挂合同-合同', amount: 1000, status: 'pending_sign', created_at: Date.now(), updated_at: Date.now() })
  const payB = crmDbService.createPaymentRecord({ payer: '自动挂合同测试客户', amount_net: 1000, pay_channel: 'bank_direct', created_at: Date.now() })
  const ab = crmDbService.addAllocations(payB, [{ customerHint: '自动挂合同测试客户', salesHint: '', amountHint: 1000 }])
  const crRes = crmDbService.confirmAllocation(ab[0], { account_id: accX })
  ok('10d 确认时自动挂客户合同', crRes.ok && crRes.linked === true)
  ok('10e 归属已关联合同', Number(crmDbService.getById('allocation', ab[0])?.contract_id) === cx)

  const e1 = crmDbService.ensureAccount('去重测试客户')
  const e2 = crmDbService.ensureAccount('去重测试客户')
  ok('10f 同名客户不重复建', e1 === e2 && e1 > 0)
  ok('10g 客户仅一条', Number(crmDbService.all('SELECT COUNT(*) AS c FROM account WHERE name = ?', ['去重测试客户'])[0]?.c) === 1)

  // 清掉 debounce persist 定时器后再删目录，避免残留写入噪音
  crmDbService.persistNow()
  rmSync(dir, { recursive: true, force: true })
  console.log(`\nWORKBENCH RESULT: pass=${pass} fail=${fail}`)
  if (fail > 0) process.exit(1)
}

void main()
