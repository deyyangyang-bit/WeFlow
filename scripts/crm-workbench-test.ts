/**
 * crm-workbench-test.ts —— CRM 工作台业务闭环单测
 * 覆盖：归属绑定合同后 creditedTotal 上涨、签约状态机、activeContractForAccount、发票挂合同
 * 运行：npx tsx scripts/crm-workbench-test.ts
 */
import { mkdtempSync, rmSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { crmDbService } from '../electron/services/crmDbService'
import { isPriceOverride } from '../shared/priceOverride'

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

  // ── 5 报价版本链（宪法 §1.6 修订 2026-09-09：append-only，每次报价 INSERT 新版本行）──
  const quoCountBefore = Number(crmDbService.all('SELECT COUNT(*) AS c FROM quotation')[0]?.c)
  const bad = crmDbService.createQuotation({ contract_id: contractId, items: [{ product_id: 999, qty: 1 }] })
  ok('5a 不存在型号被拒', !bad.ok)
  ok('5a2 拒绝后零残留（事务回滚不产生版本行）', Number(crmDbService.all('SELECT COUNT(*) AS c FROM quotation')[0]?.c) === quoCountBefore)
  ok('5a3 报价禁止散写（create 守卫指向版本链单点）', (() => {
    try { crmDbService.create('quotation', { contract_id: contractId, total: 1 }); return false } catch { return true }
  })())
  const productId = crmDbService.create('product', {
    model: 'CDD12', name: '电动堆高车', unit_price: 3800, specs: '{}', variants: '[]', created_at: Date.now()
  })
  const quo1 = crmDbService.createQuotation({ contract_id: contractId, items: [{ product_id: productId, qty: 2 }] })
  ok('5b 报价单创建成功', quo1.ok && typeof quo1.id === 'number')
  const q = crmDbService.getById('quotation', quo1.id as number)
  ok('5c 报价合计=2×3800', Number(q?.total) === 7600)
  ok('5d 首版本 version=1 + effective_from 已写 + 未关闭', Number(q?.version) === 1 && Number(q?.effective_from) > 0 && Number(q?.effective_to) === 0)
  ok('5e 合同指针 quote_version_id → v1', Number(crmDbService.getById('contract', contractId)?.quote_version_id) === Number(quo1.id))

  // 连续创建多个报价：版本按合同递增、旧版本生效期关闭、指针随动
  const quo2 = crmDbService.createQuotation({ contract_id: contractId, items: [{ product_id: productId, qty: 3 }] })
  ok('5f v2 版本递增=2', quo2.ok && Number(crmDbService.getById('quotation', quo2.id as number)?.version) === 2)
  const q1After = crmDbService.getById('quotation', quo1.id as number)
  ok('5g v2 生效即关闭 v1（effective_to 落在生效窗口后）',
    Number(q1After?.effective_to) > 0 && Number(q1After?.effective_to) >= Number(q1After?.effective_from))
  ok('5h 合同指针随动 → v2', Number(crmDbService.getById('contract', contractId)?.quote_version_id) === Number(quo2.id))
  const quo3 = crmDbService.createQuotation({ contract_id: contractId, items: [{ product_id: productId, qty: 1, unit_price: 3000 }] })
  ok('5i v3 递增=3 + 自定义单价合计 3000',
    quo3.ok && Number(crmDbService.getById('quotation', quo3.id as number)?.version) === 3 &&
    Number(crmDbService.getById('quotation', quo3.id as number)?.total) === 3000)

  // 当前有效报价 / 报价历史读口
  const qCur = crmDbService.currentQuotationForContract(contractId)
  ok('5j 当前有效报价 = v3', !!qCur && Number(qCur.id) === Number(quo3.id))
  const qHist = crmDbService.quotationHistoryForContract(contractId)
  ok('5k 报价历史返回全部版本（新→旧）', qHist.length === 3 && Number(qHist[0].id) === Number(quo3.id) && Number(qHist[2].id) === Number(quo1.id))

  // 历史版本只读：被替代版本拒绝任何改写且数据未动
  let histReject = false
  try { crmDbService.update('quotation', Number(quo1.id), { total: 1 }) } catch { histReject = true }
  ok('5l 历史版本更新被拒', histReject)
  ok('5m 历史版本数据未被改动', Number(crmDbService.getById('quotation', quo1.id as number)?.total) === 7600)
  let curReject = false
  try { crmDbService.update('quotation', Number(quo3.id), { total: 1 }) } catch { curReject = true }
  ok('5n 现行版本价格字段不可直改（须走新版本）', curReject)
  crmDbService.update('quotation', Number(quo3.id), { attachment_path: '/tmp/q3.docx', artifact_hash: 'deadbeef' })
  ok('5o 现行版本允许文件/存证哈希回写', String(crmDbService.getById('quotation', quo3.id as number)?.artifact_hash) === 'deadbeef')

  // 版本创建 / 切换 / 合同指针 / 审计同一事务：三次创建恰三条 quote_version_create 审计
  ok('5p 版本链审计留痕（quote_version_create ×3）',
    Number(crmDbService.all(
      "SELECT COUNT(*) AS c FROM audit_event WHERE action = 'quote_version_create' AND entity_type = 'quotation' AND entity_id IN (?,?,?)",
      [quo1.id, quo2.id, quo3.id])[0]?.c) === 3)

  // 存量脏链可能同时有多个 effective_to=0；新建版本必须一次关闭全部旧现行行。
  const dirtyContractId = crmDbService.create('contract', {
    account_id: accountId, name: '多现行报价修复合同', amount: 100, status: 'pending_sign', created_at: Date.now(), updated_at: Date.now()
  })
  const dirtyIds: number[] = []
  crmDbService.runTx((tx) => {
    dirtyIds.push(tx.run('INSERT INTO quotation (contract_id,items,total,version,effective_from,effective_to,created_at) VALUES (?,?,?,?,?,?,?)', [dirtyContractId, '[]', 1, 1, 1, 0, 1]))
    dirtyIds.push(tx.run('INSERT INTO quotation (contract_id,items,total,version,effective_from,effective_to,created_at) VALUES (?,?,?,?,?,?,?)', [dirtyContractId, '[]', 2, 2, 2, 0, 2]))
  })
  const repaired = crmDbService.createQuotation({ contract_id: dirtyContractId, items: [{ product_id: productId, qty: 1 }] })
  const remainingCurrent = crmDbService.all('SELECT id FROM quotation WHERE contract_id = ? AND COALESCE(effective_to,0) = 0', [dirtyContractId])
  ok('5q 新版本一次关闭脏链中全部旧现行版本', repaired.ok && remainingCurrent.length === 1 && Number(remainingCurrent[0].id) === Number(repaired.id) && dirtyIds.every((id) => Number(crmDbService.getById('quotation', id)?.effective_to) > 0))

  // ── 6 事件/行为日志（status_history + activity_log 埋点）───────────────────
  const hist = crmDbService.contractStatusHistory(gapContractId)
  const histActs = hist.map((h) => String(h.to_status))
  ok('6a 签约/发货状态历史落库', histActs.includes('signed') && histActs.includes('shipped'))
  const confirmAct = crmDbService.activityBy('allocation', allocIds[0])
  ok('6b 归属确认写入 activity', confirmAct.some((a) => a.action === 'confirmed'))
  const quoAct = crmDbService.activityBy('quotation', quo1.id as number)
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
  // 报价行走版本链单点（宪法 §1.6：散写已被 create 守卫禁止）
  const delProductId = crmDbService.create('product', { model: 'DEL-1', name: '删除测试车', unit_price: 3000, specs: '{}', variants: '[]', created_at: Date.now() })
  ok('9a0 版本链创建报价成功', crmDbService.createQuotation({ contract_id: delContract, items: [{ product_id: delProductId, qty: 1 }] }).ok)
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
  // ── 11 合同详情子列表归属收敛（§2.74 遗留补齐，2026-09-06）：三子表 filterByOwner ──
  {
    const src2 = readFileSync(join(__dirname, '..', 'src/pages/CrmWorkbenchPage.tsx'), 'utf8')
    ok('11a 详情抽屉子列表三路接 filterByOwner（quotation/invoice/logistics）',
      /setQuotations\(filterByOwner\(await window\.electronAPI\.crm\.list\('quotation'/.test(src2) &&
      /setInvoices\(filterByOwner\(await window\.electronAPI\.crm\.list\('invoice'/.test(src2) &&
      /setLogistics\(filterByOwner\(await window\.electronAPI\.crm\.list\('logistics'/.test(src2))
    ok('11b 子列表过滤在 select() 读路（主行已挡、子表同口径收敛）',
      /const select = async \(c: any\) => \{[\s\S]{0,400}filterByOwner/.test(src2))
    ok('11c 回款归属列表不在此刀范围（任务书点名 quotation/invoice/logistics）',
      /setAllocations\(allocs\)/.test(src2) && !/setAllocations\(filterByOwner/.test(src2))
  }

  // ── 12 展示层简化（设计稿 docs/UI设计稿-四页简化.html 屏 3）：静态断言 ──
  {
    const src = readFileSync(join(__dirname, '..', 'src/pages/CrmWorkbenchPage.tsx'), 'utf8')
    ok('12a 顶部统计卡收成一行小字（crm-kpi-line：本月到账/待签/预警；预警非零 is-hot 红色）',
      /className="crm-kpi-line"/.test(src) && /stats\.monthPaid/.test(src) &&
      /pendingSignCount/.test(src) && /warningCount/.test(src) &&
      /warningCount > 0 \? 'is-hot' : ''/.test(src))
    ok('12b 待签/预警计数走销售视角名单（myWorkbench = filterByOwner 后），本月到账沿用 statsOverview 口径',
      /myWorkbench\.filter\(\(c: any\) => c\.status === 'pending_sign'\)/.test(src) &&
      /myWorkbench\.filter\(\(c: any\) => c\.warning\)/.test(src) &&
      /filterByOwner\(workbench, identity\)/.test(src))
    ok('12c 数据看板折叠区默认收起（dashboardOpen useState(false)：2 图 + AI 准确率 + 原 4 统计卡原样折叠保留，零删除）',
      /const \[dashboardOpen, setDashboardOpen\] = useState\(false\)/.test(src) &&
      /数据看板（到款趋势 \/ 客户阶段分布 \/ AI 准确率）/.test(src) &&
      /crm-stats-row/.test(src) && /crm-overview-charts/.test(src) &&
      /paidTrendOption && <ReactECharts/.test(src) && /stageDistOption && <ReactECharts/.test(src) &&
      src.indexOf('crm-kpi-line') < src.indexOf('crm-fold') && src.indexOf('crm-fold') < src.indexOf('dashboardOpen && ('))
    ok('12d 合同列表 + 子资源四块不动（SearchTable/全款进度列/报价单/发票/回款归属/物流）',
      /<SearchTable/.test(src) && /全款进度/.test(src) && /报价单/.test(src) &&
      /发票/.test(src) && /回款归属/.test(src) && /物流/.test(src))
  }

  // ── 13 合同录入加速（PRD v1.4）：改价留痕 / 创建标识幂等 / 客户档案边界 ──────
  {
    const auditDetailOf = (quotationId: number): any => {
      const row = crmDbService.all(
        "SELECT detail FROM audit_event WHERE action = 'quote_version_create' AND entity_id = ?", [quotationId])[0]
      return JSON.parse(String(row?.detail || '{}'))
    }
    // 13a isPriceOverride 边界：只有「提供了有限非负单价且与目录价不同」才算改价
    ok('13a isPriceOverride 边界（空/同价/0 元/非有限/目录价为 0）',
      !isPriceOverride(3800, '') && !isPriceOverride(3800, undefined) && !isPriceOverride(3800, 3800) &&
      !isPriceOverride(3800, '3800.00') && isPriceOverride(3800, 0) && isPriceOverride(0, 5) &&
      !isPriceOverride(0, 0) && !isPriceOverride(3800, -1) && !isPriceOverride(3800, 'abc'))

    const entryContractId = crmDbService.create('contract', {
      account_id: accountId, name: '改价留痕测试合同', amount: 0, status: 'pending_sign',
      created_at: Date.now(), updated_at: Date.now()
    })
    // 13b 未传 unit_price：审计 detail 不出现 price_overrides（保持存量口径）
    const qDefault = crmDbService.createQuotation({ contract_id: entryContractId, items: [{ product_id: productId, qty: 1 }] })
    ok('13b 未改价时审计 detail 不出现 price_overrides',
      qDefault.ok && auditDetailOf(Number(qDefault.id)).price_overrides === undefined)
    // 13c 显式同价：与目录价一致，同样不算改价
    const qSame = crmDbService.createQuotation({ contract_id: entryContractId, items: [{ product_id: productId, qty: 1, unit_price: 3800 }] })
    ok('13c 显式同价不产生 price_overrides', qSame.ok && auditDetailOf(Number(qSame.id)).price_overrides === undefined)
    // 13d 显式改价：审计包含准确的产品、目录价与报价价
    const qChanged = crmDbService.createQuotation({ contract_id: entryContractId, items: [{ product_id: productId, qty: 1, unit_price: 3000 }] })
    const changedDetail = auditDetailOf(Number(qChanged.id))
    ok('13d 改价审计含准确的产品/目录价/报价价',
      qChanged.ok && Array.isArray(changedDetail.price_overrides) && changedDetail.price_overrides.length === 1 &&
      changedDetail.price_overrides[0].product_id === productId && changedDetail.price_overrides[0].model === 'CDD12' &&
      changedDetail.price_overrides[0].catalog_unit_price === 3800 && changedDetail.price_overrides[0].quoted_unit_price === 3000)
    // 13e 同一份行项：页面「已改价」条数（共享函数算出）必须等于审计 price_overrides 条数
    const productId2 = crmDbService.create('product', {
      model: 'CDD12-B', name: '电动堆高车B', unit_price: 1000, specs: '{}', variants: '[]', created_at: Date.now()
    })
    const mixedRows = [{ productId: productId, price: 3800, unitPrice: '3000' }, { productId: productId2, price: 1000, unitPrice: '1000' }]
    const qMixed = crmDbService.createQuotation({
      contract_id: entryContractId,
      items: mixedRows.map((r) => ({ product_id: r.productId, qty: 1, unit_price: Number(r.unitPrice) }))
    })
    const pageOverrideCount = mixedRows.filter((r) => isPriceOverride(r.price, r.unitPrice)).length
    ok('13e 页面改价条数与审计 price_overrides 条数同源一致',
      /import \{ isPriceOverride, quoteRowError \} from '\.\.\/\.\.\/shared\/priceOverride'/.test(pageSrc) &&
      /isPriceOverride\(r\.price, r\.unitPrice\)/.test(pageSrc) &&
      pageOverrideCount === 1 && Array.isArray(auditDetailOf(Number(qMixed.id)).price_overrides) &&
      auditDetailOf(Number(qMixed.id)).price_overrides.length === pageOverrideCount)

    // 13f/13g 创建标识幂等：同标识重试复用同一报价版本，不新建第二份
    const reqId = 'test-entry-request-0001'
    const entryAccount = crmDbService.ensureAccount('幂等建档测试客户')
    const entry = crmDbService.beginContractEntry({
      requestId: reqId, accountId: entryAccount, name: '幂等建档测试客户', amount: 3800,
      header: { buyer_addr: '浙江省杭州市西湖区 1 号', buyer_bank: '中国银行杭州分行', buyer_account: '1234 5678', tax_no: '9133 0106 MA2X XXXX', buyer_phone: '0571-8888 0000' }
    })
    ok('13f 按标识可查回合同（跨刷新恢复依据）',
      !!crmDbService.contractByCreationRequest(reqId) && Number(crmDbService.contractByCreationRequest(reqId)?.id) === Number(entry.id))
    ok('13f2 未命中标识返回 null / 非法标识抛错',
      crmDbService.contractByCreationRequest('test-entry-request-9999') === null &&
      (() => { try { crmDbService.contractByCreationRequest('short'); return false } catch { return true } })())
    const quoRetry1 = crmDbService.createQuotation({ contract_id: Number(entry.id), items: [{ product_id: productId, qty: 1 }], creation_request_id: reqId })
    const quoRetry2 = crmDbService.createQuotation({ contract_id: Number(entry.id), items: [{ product_id: productId, qty: 1 }], creation_request_id: reqId })
    ok('13g 同标识重试跳过报价创建（不产生第二版本）',
      quoRetry1.ok && quoRetry2.ok && Number(quoRetry1.id) === Number(quoRetry2.id) &&
      Number(crmDbService.all('SELECT COUNT(*) AS c FROM quotation WHERE contract_id = ?', [Number(entry.id)])[0]?.c) === 1)
    const dupEntry = crmDbService.beginContractEntry({ requestId: reqId, accountId: entryAccount, name: '幂等建档测试客户', amount: 9999, header: {} })
    ok('13g2 同标识重放不重复建客户/合同', Number(dupEntry.id) === Number(entry.id) &&
      Number(crmDbService.all('SELECT COUNT(*) AS c FROM contract WHERE name = ?', ['幂等建档测试客户-合同'])[0]?.c) === 1)

    // 13h~13j 客户档案边界（§7.1.2 / §10.2）
    const blankAccount = crmDbService.ensureAccount('空档案客户')
    const filled = crmDbService.beginContractEntry({
      requestId: 'test-entry-request-0002', accountId: blankAccount, name: '空档案客户', amount: 100,
      header: { buyer_addr: '江苏省苏州市工业园区 2 号', buyer_bank: '工商银行', buyer_account: '222', tax_no: '333', buyer_phone: '444' }
    })
    const blankFields = JSON.parse(String(crmDbService.getById('account', blankAccount)?.custom_fields || '{}'))
    ok('13h 档案抬头全空时直接写入档案，无需差异确认',
      filled && blankFields.buyer_addr === '江苏省苏州市工业园区 2 号' && blankFields.buyer_bank === '工商银行' &&
      blankFields.buyer_account === '222' && blankFields.tax_no === '333' && blankFields.buyer_phone === '444')

    const keptAccount = crmDbService.ensureAccount('已有档案客户')
    crmDbService.update('account', keptAccount, { custom_fields: JSON.stringify({ buyer_addr: '档案旧地址', tax_no: '档案旧税号', buyer_bank: '档案旧开户行' }) })
    crmDbService.beginContractEntry({
      requestId: 'test-entry-request-0003', accountId: keptAccount, name: '已有档案客户', amount: 200,
      header: { buyer_addr: '本次新地址', buyer_bank: '本次新开户行', tax_no: '本次新税号', buyer_phone: '本次新电话' },
      updateHeaderKeys: ['buyer_addr']
    })
    const keptFields = JSON.parse(String(crmDbService.getById('account', keptAccount)?.custom_fields || '{}'))
    ok('13i 只写入勾选字段，未勾选项保持档案原值',
      keptFields.buyer_addr === '本次新地址' && keptFields.tax_no === '档案旧税号' && keptFields.buyer_bank === '档案旧开户行' &&
      keptFields.buyer_phone === undefined)
    const snapFields = JSON.parse(String(crmDbService.getById('contract', Number(
      crmDbService.contractByCreationRequest('test-entry-request-0003')?.id))?.custom_fields || '{}'))
    ok('13i2 未勾选项仍写入本合同快照（客户档案与合同字段解耦）',
      snapFields.buyer_addr === '本次新地址' && snapFields.buyer_bank === '本次新开户行' && snapFields.buyer_phone === '本次新电话')

    crmDbService.beginContractEntry({
      requestId: 'test-entry-request-0004', accountId: keptAccount, name: '已有档案客户', amount: 300,
      header: { buyer_addr: '不更新地址' }, updateHeaderKeys: []
    })
    const untouched = JSON.parse(String(crmDbService.getById('account', keptAccount)?.custom_fields || '{}'))
    ok('13j 全部取消勾选等同于不更新，客户档案保持原值', untouched.buyer_addr === '本次新地址' && untouched.tax_no === '档案旧税号')

    // 13k 草稿恢复分流（§10.4）：指向已完成合同 → 重新生成标识；指向未完成 → 恢复且不重复创建
    ok('13k 残留草稿按合同完成度分流（前端静态断言）',
      /const complete = contract && \(draft\.items\.length === 0 \|\| Number\(contract\.quote_version_id\) > 0\)/.test(pageSrc) &&
      /if \(!complete\) \{/.test(pageSrc) &&
      /requestRef\.current = draft\.creation_request_id; setNewQuoItems\(draft\.items\)/.test(pageSrc))

    // 13l 前端预校验失败不调用后端创建接口（§10.4）
    ok('13l 报价行校验失败即中止提交（不调用创建接口）',
      /const error = newQuoItems\.map\(rowError\)\.find\(Boolean\)/.test(pageSrc) &&
      pageSrc.indexOf('newQuoItems.map(rowError).find(Boolean)') < pageSrc.indexOf('contractBeginEntry'))
  }

  console.log(`\nWORKBENCH RESULT: pass=${pass} fail=${fail}`)
  if (fail > 0) process.exit(1)
}

void main()
