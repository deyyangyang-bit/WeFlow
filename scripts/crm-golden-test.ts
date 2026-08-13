/**
 * crm-golden-test.ts —— 真实群消息样本驱动的解析规则单测
 * 运行：npx tsx scripts/crm-golden-test.ts
 */
import {
  parseBankText, detectPayChannel, parseAllocationShorthand, isClaimKeyword,
  parseLogisticsBatch, parseInvoicePdfName, feeCheck, wechatTimeToMs,
  isCompanyHint, splitAliasHints, isDealSignal
} from '../electron/services/crmParseRules'

let pass = 0, fail = 0
function ok(name: string, cond: boolean): void {
  if (cond) { pass++ } else { fail++; console.error('FAIL:', name) }
}

// 1 银行文本（真实样本）
const bank = parseBankText('【江苏银行】您无锡库叉搬运设备有限公司尾号01036账户于7月30日10:16:32转入人民币7,600.00元，对方户名为上海普绿包装制品有限公司，摘要：转账。')
ok('bank.amount', bank?.amount === 7600)
ok('bank.payer', bank?.payer === '上海普绿包装制品有限公司')
ok('bank.tail', bank?.accountTail === '01036')
ok('bank.channel', detectPayChannel(bank?.payer || '') === 'bank_direct')

// 2 财付通通道 + 双逗号容忍
const tenpay = parseBankText('【江苏银行】您无锡库叉搬运设备有限公司尾号01036账户于7月30日11:06:26转入人民币2,400.00元，，对方户名为江西珍众模具制造有限公司，摘要：转账。')
ok('tenpay.parse', tenpay?.amount === 2400)
const tenpay2 = parseBankText('【江苏银行】您无锡库叉搬运设备有限公司尾号01036账户于7月31日02:37:19转入人民币1,996.00元，对方户名为财付通支付科技有限公司，摘要：网上银行转账。')
ok('tenpay.channel', detectPayChannel(tenpay2?.payer || '') === 'wecom_tenpay')

// 3 归属简语：多行拆分
const alloc = parseAllocationShorthand('吴忠伟/亮哥 2630 许丽娟\n无锡中和德机械有限公司 600 李林辉')
ok('alloc.rows', alloc?.length === 2)
ok('alloc.amounts', alloc?.[0].amountHint === 2630 && alloc?.[1].amountHint === 600)
ok('alloc.sales', alloc?.[0].salesHint === '许丽娟' && alloc?.[1].salesHint === '李林辉')

// 4 费率校验：2000→1996.00 / 3230→3223.54 通过；20330→2025.94 不通过
ok('fee.2000', feeCheck(2000, 1996.00))
ok('fee.3230', feeCheck(3230, 3223.54))
ok('fee.20330', !feeCheck(20330, 2025.94))

// 5 认领关键词
ok('claim.收到', isClaimKeyword('收到'))
ok('claim.ok', isClaimKeyword('👌'))
ok('claim.not', !isClaimKeyword('吴忠伟总/王先生 2000 许丽娟'))

// 6 物流批量
const logi = parseLogisticsBatch('800211632728 艾驱电动 陈先生 嘉兴\n800211630064 艾驱电动 朱其峰 杭州')
ok('logi.rows', logi?.length === 2)
ok('logi.fields', logi?.[0].trackingNo === '800211632728' && logi?.[0].receiver === '陈先生' && logi?.[0].city === '嘉兴')

// 7 发票 PDF 文件名
const inv = parseInvoicePdfName('dzfp_263220000006267212401_深圳晶恒李…2959.pdf')
ok('inv.no', inv?.invoiceNo === '263220000006267212401')
ok('inv.buyer', inv?.buyerPrefix === '深圳晶恒李')
ok('inv.tail', inv?.tail === '2959')
ok('inv.bad', parseInvoicePdfName('合同扫描件.pdf') === null)

// 8 时间/别名
const ms = wechatTimeToMs('7月30日10:16:32', new Date(2026, 7, 3))
ok('time.year', new Date(ms).getFullYear() === 2026 && new Date(ms).getMonth() === 6)
ok('alias.company', isCompanyHint('无锡中和德机械有限公司'))
ok('alias.person', !isCompanyHint('亮哥'))
ok('alias.split', splitAliasHints('吴忠伟/亮哥').length === 2)

// 9 私聊成交信号
ok('deal.定了', isDealSignal('那就定了，我转给你', 0))
ok('deal.下单', isDealSignal('好的，下单了', 0))
ok('deal.款已付', isDealSignal('款已付，查收', 0))
ok('deal.意向不误判', !isDealSignal('我想了解一下这个型号', 0))
ok('deal.考虑不误判', !isDealSignal('我考虑考虑，下周再说', 0))
ok('deal.销售消息不算', !isDealSignal('那就定了，转给你', 1))

console.log(`\nGOLDEN RESULT: pass=${pass} fail=${fail}`)
if (fail > 0) process.exit(1)
