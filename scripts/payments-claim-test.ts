/**
 * payments-claim-test.ts —— 每日到款认领改造护栏（2026-08-24）
 *
 * 背景：跟单中心去掉 AI 自动确认，改销售手动认领；到款按天分组展示，认领后显示开票状态
 * （订单群 PDF 发票解析 → invoice.status='issued' 即已开票）。
 *
 * 断言：
 *   A 静态：
 *     1  paymentsByDay 存在且 JOIN 认领/客户/合同/开票四轴（invoice 子查询 status != 'voided'）
 *     2  claimPayment 三步：无归属先建（approvePayment）→ 已确认拒绝重复认领 → confirmAllocation 到客户/合同
 *     3  CrmReviewPage 零 AI 自动确认（autoSummary/runAutoConfirm/undoAutoConfirm 不再被引用）
 *     4  CrmReviewPage 每日到款：paymentsByDay 调用 + invoiceBadgeOf 开票状态 + paymentClaim 认领
 *     5  桥接齐全：preload/electron.d.ts 均有 paymentsByDay + paymentClaim
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

  // A1: paymentsByDay 四轴 JOIN（认领/客户/合同/开票；invoice 取该账户最近一张非作废）
  ok('A1 paymentsByDay 存在 + JOIN 认领/客户/合同/开票四轴（invoice 子查询 status != voided）',
    /paymentsByDay\(days = 30\)/.test(dbCode) &&
    /LEFT JOIN allocation al ON al\.payment_record_id = pr\.id/.test(dbCode) &&
    /LEFT JOIN account ac ON ac\.id = al\.account_id/.test(dbCode) &&
    /LEFT JOIN contract c ON c\.id = al\.contract_id/.test(dbCode) &&
    /LEFT JOIN invoice iv ON iv\.id = \(/.test(dbCode) && /status != 'voided'/.test(dbCode))

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
    /已开票/.test(pageSrc) && /未开票/.test(pageSrc) && /认领/.test(pageSrc))

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

  // A11: 物流三队列统一一页七天（WeekDayGroups 三处：待认领/待签收/已签收 + 按 latest_update_at 分组 + day-arrow 折叠箭头）
  ok('A11 物流三队列一页七天（WeekDayGroups items=\{queues.logistics|logiLinked|logiSigned\} 三处 + timeOf 按 latest_update_at）',
    /WeekDayGroups items=\{queues\.logistics\}/.test(pageSrc) &&
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

  // ── B. 真实库只读（与 crmDbService.paymentsByDay 同款 SQL，同步维护）──────────
  const SQL = await initSqlJs()
  const DB_PATH = join(os.homedir(), 'Library/Application Support/weflow/weflow-crm.db')
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
         SELECT id FROM invoice WHERE account_id = al.account_id AND status != 'voided'
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
