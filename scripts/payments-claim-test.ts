/**
 * payments-claim-test.ts —— 每日到款认领改造护栏（2026-08-24）
 *
 * 背景：跟单中心去掉 AI 自动确认，改销售手动认领；到款按天分组展示，认领后显示开票状态
 * （订单群 PDF 发票解析 → invoice.status='issued' 即已开票）。
 *
 * 断言：
 *   A 静态：
 *     1  paymentsByDay 存在且 JOIN 认领/客户/合同/开票四轴（发票按明确合同关联，禁止拿客户其他订单发票冒充）
 *     2  claimPayment 三步：无归属先建（approvePayment）→ 已确认拒绝重复认领 → confirmAllocation 到客户/合同
 *     3  CrmReviewPage 零 AI 自动确认（autoSummary/runAutoConfirm/undoAutoConfirm 不再被引用）
 *     4  CrmReviewPage 每日到款：paymentsByDay 调用 + invoiceBadgeOf 开票状态 + paymentClaim 认领
 *     5  桥接齐全：preload/electron.d.ts 均有 paymentsByDay + paymentClaim
 *     16-18 销售归属收口 + 布局收编（§2.80，2026-09-19）：identity 视图档过滤（本人认领与公共池分离，isOwnedName
 *           唯一姓名口径）/ rail 三档发票一等 / 页器入节标题行 / 已确认默认折叠 / 安静徽标
 *     19-21 销售认领与财务核销分离 / 订单级开票需求 / 引用消息稳定 server id 关联
 *   B 真实库只读（sql.js 字节进内存，同款 SQL 与 crmDbService.paymentsByDay 同步维护）：
 *     11 近 30 天到款可查，字段带认领/开票轴（account_name/invoice_no/invoice_status）
 *     12 已认领（alloc_status='confirmed'）行有客户名，开票状态可读
 *     13 无 allocation 的行 alloc_status 为 null（未认领 → 前端显示认领控件）
 *
 * 运行：npx tsx scripts/payments-claim-test.ts
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import os from 'os'
import initSqlJs from 'sql.js'
import { findExistingBusinessDb } from '../electron/services/businessDbPath'

let pass = 0, fail = 0
function ok(name: string, cond: boolean): void {
  if (cond) { pass++ } else { fail++; console.error('FAIL:', name) }
}

const ROOT = join(__dirname, '..')
const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

async function main(): Promise<void> {
  // ── A. 静态 ────────────────────────────────────────────────────────────────
  const dbSrc = readFileSync(join(ROOT, 'electron/services/crmDbService.ts'), 'utf8')
  const dbCode = strip(dbSrc)
  const pageSrc = readFileSync(join(ROOT, 'src/pages/CrmReviewPage.tsx'), 'utf8')

  // A1: paymentsByDay 四轴 JOIN（认领/客户/合同/开票；invoice 只取明确关联合同的最近一张非作废）
  ok('A1 paymentsByDay 存在 + JOIN 认领/客户/合同/开票四轴（invoice 按合同关联）',
    /paymentsByDay\(days = 30\)/.test(dbCode) &&
    /LEFT JOIN allocation al ON al\.payment_record_id = pr\.id/.test(dbCode) &&
    /LEFT JOIN account ac ON ac\.id = al\.account_id/.test(dbCode) &&
    /LEFT JOIN contract c ON c\.id = al\.contract_id/.test(dbCode) &&
    /LEFT JOIN invoice iv ON iv\.id = \(/.test(dbCode) && /al\.contract_id IS NOT NULL AND contract_id = al\.contract_id/.test(dbCode) && /status != 'voided'/.test(dbCode))

  // A2: claimPayment 四步（无归属先建 / 已认领拒绝 / 旧自动确认遗留补挂 / confirmAllocation 到客户合同）
  ok('A2 claimPayment 闭环（approvePayment 兜底 + 已认领拒绝 + 旧数据补挂 + confirmAllocation）',
    /claimPayment\(/.test(dbCode) && /this\.approvePayment\(id\)/.test(dbCode) &&
    /alloc\.status === 'confirmed' && \(alloc\.account_id \|\| alloc\.contract_id\)/.test(dbCode) &&
    /return \{ ok: false, reason: '该笔到款已认领' \}/.test(dbCode) &&
    /return this\.confirmAllocation\(Number\(alloc\.id\), patch\)/.test(dbCode))

  // A3: 跟单中心零 AI 自动确认（不设计 AI 判断——前端不再引用自动确认）
  ok('A3 CrmReviewPage 零 AI 自动确认（autoSummary/runAutoConfirm/undoAutoConfirm 不出现）',
    !/autoSummary|runAutoConfirm|undoAutoConfirm/.test(pageSrc))

  // A4: 每日到款 UI（paymentsByDay + 开票状态 + 手动认领）
  ok('A4 每日到款三要素（paymentsByDay 调用 + invoiceBadgeOf 开票状态 + paymentClaim 认领）',
    /paymentsByDay\(30\)/.test(pageSrc) && /invoiceBadgeOf/.test(pageSrc) && /paymentClaim\(/.test(pageSrc) &&
    /已开票/.test(pageSrc) && /本单不开发票/.test(pageSrc) && /待确认是否开票/.test(pageSrc) && /认领/.test(pageSrc))

  // A5: 桥接齐全（preload + electron.d.ts）
  const preload = readFileSync(join(ROOT, 'electron/preload.ts'), 'utf8')
  const types = readFileSync(join(ROOT, 'src/types/electron.d.ts'), 'utf8')
  ok('A5 桥接齐全（preload/electron.d.ts 均有 paymentsByDay + paymentClaim）',
    /paymentsByDay/.test(preload) && /paymentClaim/.test(preload) &&
    /paymentsByDay/.test(types) && /paymentClaim/.test(types))

  // A6: 一页七天 + 每天折叠行（第 0 页 = 今天往前 6 天，页内每天一个折叠 header 默认折叠，点击展开当天明细；
  // 跨窗口翻页上限 = 最老一条所在页；只看未认领筛选强制全展开）
  ok('A6 一页七天折叠（WeekDayGroups 组件 + weekDaysOf 7 天窗口 + 每天默认折叠 expandedDays/toggle + header 未认领数 + 翻页 + onlyUnclaimed 筛选）',
    /function WeekDayGroups/.test(pageSrc) && /weekDaysOf/.test(pageSrc) &&
    /\[\.\.\.Array\(7\)\]/.test(pageSrc) && /dayLabelOf/.test(pageSrc) && /（今天）/.test(pageSrc) &&
    /expandedDays/.test(pageSrc) && /setExpandedDays\(\(s\) => \{ const n = new Set\(s\)/.test(pageSrc) &&
    /day-unclaimed/.test(pageSrc) && /forceOpen/.test(pageSrc) &&
    /onlyUnclaimed/.test(pageSrc) && /claimablePayments/.test(pageSrc) &&
    /isClaimable/.test(pageSrc) && /上一页/.test(pageSrc) && /下一页/.test(pageSrc))

  // A7: 认领销售默认本人可改他人（不填=mySalesName 兜底）+ 客户名输入（联想已有客户 / 无匹配直接建档兜底）
  const handlersSrc = strip(readFileSync(join(ROOT, 'electron/services/crmIpcHandlers.ts'), 'utf8'))
  const pickerSrc = strip(readFileSync(join(ROOT, 'src/components/sales/CustomerPicker.tsx'), 'utf8'))
  ok('A7 认领销售默认本人可改他人（claimSales/logiSales 输入框存在 + 不填走 mySalesName 兜底）+ 客户名输入（customerIdOf 精确匹配 + accountEnsure 建档兜底 + CustomerPicker 联想，旧四控件消失）',
    /claimSales\[p\.id\]\?\.trim\(\) \|\| mySalesName/.test(pageSrc) &&
    /logiSales\[l\.id\]\?\.trim\(\) \|\| mySalesName/.test(pageSrc) &&
    !/claimAccount|claimNewName|logiAccount|logiNewName/.test(pageSrc) &&
    /currentSalesName\(\)/.test(pageSrc) &&
    /customerIdOf/.test(pageSrc) && /accountEnsure\(name\)/.test(pageSrc) &&
    /CustomerPicker/.test(pageSrc) &&
    /toLowerCase\(\)\.includes/.test(pickerSrc) && /无匹配客户/.test(pickerSrc))

  // A9: 到账统计口径——monthPaid/paidWeekly 只计人工认领（account_id IS NOT NULL）且按**到款日** pay_time 归类
  // （JOIN payment_record；历史补扫集中认领的款按真实到账日进月/周，不冒充当月）
  ok('A9 到账统计口径（statsOverview monthPaid/paidWeekly JOIN payment_record 按 pay_time 归类 + account_id IS NOT NULL）',
    /FROM allocation al JOIN payment_record pr ON pr\.id = al\.payment_record_id/.test(dbCode) &&
    /al\.account_id IS NOT NULL AND pr\.pay_time >= \?/.test(dbCode) &&
    /pr\.pay_time >= \? AND pr\.pay_time < \?/.test(dbCode))

  // A8: currentSalesName 桥接齐全（handler + preload + electron.d.ts）
  ok('A8 currentSalesName 桥接齐全（crm:currentSalesName handler + preload/electron.d.ts）',
    /crm:currentSalesName/.test(handlersSrc) && /wcdbService\.getDisplayNames\(\[myWxid\]\)/.test(handlersSrc) &&
    /currentSalesName/.test(preload) && /currentSalesName/.test(types))

  // A10: 已确认到款集中罗列（confirmed 且挂上客户/合同 → claimedPayments 列表，展示客户/销售/开票状态）
  ok('A10 已确认到款罗列（claimedPayments 过滤 confirmed+有归属 + 已确认到款标题 + 客户/销售/开票状态展示）',
    /claimedPayments = payments\.filter\(\(p\) => p\.alloc_status === 'confirmed' && \(p\.account_id \|\| p\.contract_id\)\)/.test(pageSrc) &&
    /已确认到款/.test(pageSrc) && /claimedPayments\.map/.test(pageSrc) &&
    /invoiceBadgeOf\(p\)/.test(pageSrc))

  // A11: 物流三队列统一一页七天（WeekDayGroups 三处：待认领/待签收/已签收 + 按 latest_update_at 分组 + day-arrow 折叠箭头；
  // §2.80 起待认领为视图档过滤后的 logiUnlinked）
  ok('A11 物流三队列一页七天（WeekDayGroups items={logiUnlinked|logiLinked|logiSigned} 三处 + timeOf 按 latest_update_at）',
    /WeekDayGroups items=\{logiUnlinked\}/.test(pageSrc) &&
    /WeekDayGroups items=\{logiLinked\}/.test(pageSrc) &&
    /WeekDayGroups items=\{logiSigned\}/.test(pageSrc) &&
    /timeOf=\{\(l\) => Number\(l\.latest_update_at\)\}/.test(pageSrc) &&
    /day-arrow/.test(pageSrc))

  // A12: 销售团队下拉（header 扫描按钮旁）：历史人名词条过滤裸 wxid + 新增/移除持久化 + 认领默认联动
  ok('A12 销售团队（crm:sales:team 过滤裸 wxid + salesTeamAdded/Removed 管理 + 前端下拉点成员设认领默认）',
    /crm:sales:team'/.test(handlersSrc) && /isSessionIdLike\(n\)/.test(handlersSrc) &&
    /salesTeamAdded/.test(handlersSrc) && /salesTeamRemoved/.test(handlersSrc) &&
    /crm:sales:team:add'/.test(handlersSrc) && /crm:sales:team:remove'/.test(handlersSrc) &&
    /销售团队（\{salesTeam\.length\}）/.test(pageSrc) && /sales-team-drop/.test(pageSrc) &&
    /setMySalesName\(m\.name\)/.test(pageSrc) && /removeSalesMember\(m\.name\)/.test(pageSrc) &&
    /salesTeamAdd\(n\)/.test(pageSrc) &&
    /salesTeam: \(\) => Promise/.test(types))

  // A13: 拆单认领金额口径——paymentsByDay 返回 credited_amount，前端显示优先 credited_amount
  // （银行聚合流水拆单：amount_net 是聚合总额，同一笔被 N 客户认领时显示聚合额会虚高；credited_amount 才是每笔实际付款额）
  ok('A13 拆单金额口径（paymentsByDay 带 credited_amount + 前端 shownAmountOf 优先 credited_amount，与统计卡 SUM(credited_amount) 同口径）',
    /al\.credited_amount/.test(dbCode) &&
    /shownAmountOf/.test(pageSrc) && /Number\(p\.credited_amount \?\? p\.amount_net\)/.test(pageSrc) &&
    /list\.reduce\(\(s, p\) => s \+ shownAmountOf\(p\), 0\)/.test(pageSrc) &&
    /credited_amount \?\? p\.amount_net/.test(pageSrc))

  // A14: 「今天要办」verdict 行（设计稿屏 4）：三计数全部来自现有数据（claimable+pay_time 今天 / logiLinked / invoices），
  // 零新接口；§2.80 起三计数均为视图档过滤后口径（{invoices.length} = 过滤后发票队列，不再是全库 queues.invoices）
  ok('A14 今天要办 verdict（今日到款待认领 / 物流待签收 / 发票待开，与按天分组同口径 dayStartOf，且全部过滤后）',
    /今天要办/.test(pageSrc) &&
    /dayStartOf\(Number\(p\.pay_time\)\) === dayStartOf\(Date\.now\(\)\)/.test(pageSrc) &&
    /\{logiLinked\.length\}/.test(pageSrc) && /\{invoices\.length\}/.test(pageSrc) &&
    !/queues\.invoices\.length/.test(pageSrc) && !/items=\{queues\.logistics\}/.test(pageSrc))

  // A15: 「管理」折叠区（扫描群聊设置 + 销售团队收编，默认收起，功能原样；认领三区/7 天页不动）
  ok('A15 管理折叠区（review-fold 默认收起 manageOpen useState(false)；群聊开关/筛选与销售团队管理功能原样保留）',
    /const \[manageOpen, setManageOpen\] = useState\(false\)/.test(pageSrc) &&
    /管理（扫描群聊设置 \/ 销售团队）/.test(pageSrc) &&
    /groupsSave/.test(pageSrc) && /groupsUpdate/.test(pageSrc) && /openPick/.test(pageSrc) &&
    /salesTeamAdd\(n\)/.test(pageSrc) && /removeSalesMember/.test(pageSrc) &&
    /sales-team-drop--inline/.test(pageSrc))

  // A16: 「我的」与公共待认领池分离：本人已认领走共享 owner 过滤；未归属到款/物流由页面显式公共池承载；
  // 发票按客户 owner 或申请人归属，不再把无归属发票混进所有销售的「我的」。
  const ownerFilterSrc = strip(readFileSync(join(ROOT, 'shared/ownerFilter.ts'), 'utf8'))
  ok('A16 销售归属收口（我的业务与公共待认领池分离）',
    /identity\.get\(\)/.test(pageSrc) && /identityLikeFromIpc/.test(pageSrc) &&
    /filterPaymentsForView/.test(pageSrc) && /filterByOwner\(/.test(pageSrc) && /isOwnedName/.test(pageSrc) &&
    /const payments = salesScope \? filterPaymentsForView\(paymentsAll, identity\) : paymentsAll/.test(pageSrc) &&
    /queues\.logistics\.filter\(\(l: any\) => !String\(l\.owner_sales/.test(pageSrc) &&
    /queues\.invoices\.filter\(\(inv: any\) => isOwnedName\(identity, invoiceOwnerSalesOf\(inv\)\)\)/.test(pageSrc) &&
    /公共待认领/.test(pageSrc) &&
    !/=== mySalesName|=== identity\.name|sales_name ===/.test(pageSrc))
  ok('A16b ownerFilter 语义源（filterPaymentsForView 的我的口径严格只认本人）',
    /export function filterPaymentsForView/.test(ownerFilterSrc) &&
    /export function filterByOwnerOf/.test(ownerFilterSrc) &&
    /return rows\.filter\(\(p\) => isOwnedName\(identity, String\(p\.sales_name/.test(ownerFilterSrc) &&
    /!owner \|\| isOwnedName\(identity, owner\)/.test(ownerFilterSrc))

  // A17: 视图档 chipbar（§2.80 A3）：销售默认「只看我的」可切「全员」（quiet chips，isSalesView 才渲染，管理视角隐藏）；
  // 认领默认名与身份档案对齐（A1 勿双口径打架），currentSalesName 仅作未建档兜底
  ok('A17 视图档 chipbar（只看我的/全员，isSalesView 才渲染；switchScope 切档回默认）+ 认领默认名对齐档案',
    /只看我的/.test(pageSrc) && />全员<\/button>/.test(pageSrc) &&
    /isSalesView\(identity\) && \(/.test(pageSrc) &&
    /const switchScope = \(all: boolean\)/.test(pageSrc) &&
    /if \(identity\.name\.trim\(\)\) setMySalesName\(identity\.name\.trim\(\)\)/.test(pageSrc) &&
    /currentSalesName\(\)/.test(pageSrc))

  // A18: 布局收编（§2.80）：rail 三档（发票为一等队列档）+ 款项页器上提节标题行（受控分页）+ 已确认到款默认折叠 +
  // 未开票/未关联合同安静 tag + 销售视角默认只看未认领
  ok('A18 布局收编（rail 发票档 + DayPager 节标题行受控分页 + claimedOpen 默认 false + review-tag 安静徽标 + 销售默认只看未认领）',
    /'invoices'>\('payments'\)/.test(pageSrc) &&
    /发票待开<span className="rail__n">\{invoices\.length\}<\/span>/.test(pageSrc) &&
    /onPageChange=\{setPayPage\}/.test(pageSrc) && /review-sec__pager/.test(pageSrc) &&
    /const \[claimedOpen, setClaimedOpen\] = useState\(false\)/.test(pageSrc) &&
    /review-tag/.test(pageSrc) && /未关联合同/.test(pageSrc) &&
    /if \(isSalesView\(identity\)\) setOnlyUnclaimed\(true\)/.test(pageSrc))

  // A19-A21: 真实群流程收口——销售认领不直接计回款，财务显式核销；订单级开票需求可人工覆盖；
  // 引用认领优先按 refermsg.svrid 命中原始银行消息，文本仅作旧库兼容回退。
  const parseServiceSrc = strip(readFileSync(join(ROOT, 'electron/services/crmParseService.ts'), 'utf8'))
  ok('A19 销售认领与财务核销分离（新认领 pending；统计只计 allocated/legacy_confirmed；显式核销桥接齐全）',
    /reconciliation_status: 'pending'/.test(dbCode) &&
    /reconcileAllocation\(/.test(dbCode) &&
    /reconciliation_status IN \('allocated','legacy_confirmed'\)/.test(dbCode) &&
    /allocationReconcile/.test(preload) && /allocationReconcile/.test(types) &&
    /crm:allocation:reconcile/.test(handlersSrc) && /财务确认核销/.test(pageSrc))
  ok('A20 订单级开票需求（四态持久化 + 手工选择桥接齐全 + 不开发票 UI）',
    /setAllocationInvoiceRequirement\(/.test(dbCode) &&
    /unknown.*required.*not_required.*info_pending/.test(dbCode) &&
    /allocationInvoiceRequirement/.test(preload) && /allocationInvoiceRequirement/.test(types) &&
    /crm:allocation:invoiceRequirement/.test(handlersSrc) && /本单不开发票/.test(pageSrc))
  ok('A21 引用消息按稳定 server id 关联（source_server_id + refermsg.svrid，文本仅兼容回退）',
    /source_server_id/.test(dbCode) &&
    /<refermsg>.*?<svrid>/.test(parseServiceSrc) &&
    /WHERE source_server_id = \?/.test(parseServiceSrc) &&
    /SELECT \* FROM payment_record ORDER BY id DESC LIMIT 500/.test(parseServiceSrc))

  // ── B. 真实库只读（与 crmDbService.paymentsByDay 同款 SQL，同步维护）──────────
  const SQL = await initSqlJs()
  // §2.40 分库：按账号命名的业务库优先（多个账号取最近使用），回退 legacy 名
  const USER_DATA = join(os.homedir(), 'Library/Application Support/weflow')
  const DB_PATH = findExistingBusinessDb(USER_DATA, 'crm')
  if (!DB_PATH) { console.error(`未找到 CRM 业务库（weflow-crm-*.db / weflow-crm.db）：${USER_DATA}`); process.exit(1) }
  const db = new SQL.Database(readFileSync(DB_PATH))

  const rows = db.exec(`SELECT pr.id, pr.payer, pr.amount_net, pr.pay_time, pr.needs_review,
              al.status AS alloc_status, al.account_id, al.contract_id, al.credited_amount,
              ac.name AS account_name, c.name AS contract_name,
              iv.id AS invoice_id, iv.invoice_no, iv.status AS invoice_status
       FROM payment_record pr
       LEFT JOIN allocation al ON al.payment_record_id = pr.id
       LEFT JOIN account ac ON ac.id = al.account_id
       LEFT JOIN contract c ON c.id = al.contract_id
       LEFT JOIN invoice iv ON iv.id = (
         SELECT id FROM invoice WHERE al.contract_id IS NOT NULL AND contract_id = al.contract_id AND status != 'voided'
         ORDER BY id DESC LIMIT 1)
       WHERE pr.pay_time >= ? ORDER BY pr.pay_time DESC`, [Date.now() - 30 * 24 * 3600 * 1000])
  const list = rows.length ? rows[0].values : []

  ok(`B11 近 30 天到款可查（${list.length} 行，字段含认领/开票轴）`,
    list.length > 0 && rows[0].columns.includes('account_name') &&
    rows[0].columns.includes('invoice_no') && rows[0].columns.includes('invoice_status'))

  const col = (name: string) => rows[0].columns.indexOf(name)
  const claimed = list.filter((r: any[]) => r[col('alloc_status')] === 'confirmed' && (r[col('account_id')] || r[col('contract_id')]))
  ok(`B12 已认领行可显示客户名 + 开票状态（confirmed ${claimed.length} 行）`,
    claimed.every((r: any[]) => !!r[col('account_name')]) &&
    claimed.every((r: any[]) => r[col('invoice_status')] === null ||
      ['issued', 'pre_issue'].includes(String(r[col('invoice_status')]))))
  // 旧自动确认遗留行（confirmed 无客户合同）→ 前端显示补认领控件
  const legacy = list.filter((r: any[]) => r[col('alloc_status')] === 'confirmed' && !r[col('account_id')] && !r[col('contract_id')])
  ok(`B12b 旧自动确认遗留行可补认领（confirmed 无客户合同 ${legacy.length} 行）`,
    legacy.every((r: any[]) => r[col('account_name')] === null))

  const unclaimed = list.filter((r: any[]) => r[rows[0].columns.indexOf('alloc_status')] === null)
  ok(`B13 未认领行 alloc_status 为 null（前端显示认领控件，${unclaimed.length} 行）`,
    unclaimed.every((r: any[]) => r[rows[0].columns.indexOf('alloc_status')] === null))

  // B14: 到款日口径真实库重算——本月（pay_time >= 8/1）人工认领合计 vs 认领时间口径（应显著小于后者，
  // 证明历史补扫集中认领不再冒充当月）
  const monthStart = new Date(2026, 7, 1).getTime()
  const byPayTime = db.exec(
    `SELECT COALESCE(SUM(al.credited_amount),0) FROM allocation al JOIN payment_record pr ON pr.id = al.payment_record_id
     WHERE al.status='confirmed' AND al.account_id IS NOT NULL AND pr.pay_time >= ?`, [monthStart])
  const byPayTimeAmt = Number(byPayTime.length ? byPayTime[0].values[0][0] : 0)
  const byConfirm = db.exec(
    `SELECT COALESCE(SUM(al.credited_amount),0) FROM allocation al
     WHERE al.status='confirmed' AND al.account_id IS NOT NULL AND al.confirmed_at >= ?`, [monthStart])
  const byConfirmAmt = Number(byConfirm.length ? byConfirm[0].values[0][0] : 0)
  ok(`B14 到款日口径生效（本月到账 ¥${byPayTimeAmt.toLocaleString()} ≤ 认领时间口径 ¥${byConfirmAmt.toLocaleString()}——历史补扫不冒充当月）`,
    byPayTimeAmt > 0 && byPayTimeAmt <= byConfirmAmt)

  console.log('  B 快照：近 30 天', list.length, '笔，其中已认领', claimed.length, '笔，未认领', unclaimed.length, '笔')
  console.log(`payments-claim-test: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

void main()
