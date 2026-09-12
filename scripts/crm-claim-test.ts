/**
 * crm-claim-test.ts —— 货款认领 + 私聊收货地址规则单测（真实样本）
 * 运行：npx tsx scripts/crm-claim-test.ts
 */
import {
  parseBankText, detectPayChannel, isClaimKeyword, parseAllocationShorthand,
  feeCheck, parseShippingInfo
} from '../electron/services/crmParseRules'

let pass = 0, fail = 0
const ok = (name: string, cond: boolean): void => { if (cond) pass++; else { fail++; console.error('FAIL:', name) } }

// 银行到款（真实样本）
const bank = parseBankText('【江苏银行】您无锡库叉搬运设备有限公司尾号01036账户于7月30日10:16:32转入人民币7,600.00元，对方户名为上海普绿包装制品有限公司，摘要：转账。')
ok('bank', !!bank && bank.amount === 7600 && bank.payer === '上海普绿包装制品有限公司')
ok('channel bank', bank ? detectPayChannel(bank.payer) === 'bank_direct' : false)
ok('channel wecom', detectPayChannel('财付通-张三') === 'wecom_tenpay')

// 认领关键词
ok('claim 收到', isClaimKeyword('收到'))
ok('claim 👌', isClaimKeyword('👌'))
ok('claim 非', !isClaimKeyword('收到了谢谢'))

// 归属简语
const alloc = parseAllocationShorthand('上海普绿 7600 小李')
ok('alloc', !!alloc && alloc[0].customerHint === '上海普绿' && alloc[0].amountHint === 7600 && alloc[0].salesHint === '小李')
ok('feeCheck pass', feeCheck(7600, 7584.8))
ok('feeCheck fail', !feeCheck(7600, 7000))

// 私聊收货地址（真实样本 6 种形态）
const shipCases: Array<[string, { receiver?: string; phone?: string; city?: string }]> = [
  ['无锡惠山经济开发区示例路12号示例园12号402   \n杨青\n15300000008', { receiver: '杨青', phone: '15300000008' }],
  ['上海市松江区示例路870弄98号 毛示例 13500000009  是这个', { receiver: '毛示例', city: '上海市' }],
  ['高强示例，13800000010   常州市新北区示例路20号常州示例链轮有限公司', { receiver: '高强示例', city: '常州市' }],
  ['收货地址：无锡惠山经济开发区示例路12号示例园12号402-2 18500000011 卢', { receiver: '卢', phone: '18500000011' }],
  ['收件人\t:示例名13030\t\n联系电话\t:19800000012\n仓库地址:深圳市宝安区示例街道示例路59号1栋1楼示例仓13030号\t', { receiver: '示例名', city: '深圳市' }],
  ['地址浙江省宁波市北仑区示例街道示例路28号，联系人沈15900000013', { receiver: '沈', city: '宁波市' }],
  ['杭州市临安区示例街道示例路267号   宋示例   13800000014', { receiver: '宋示例', city: '杭州市' }]
]
for (const [text, exp] of shipCases) {
  const r = parseShippingInfo(text)
  ok('ship:' + text.slice(0, 10), !!r && !!r.address &&
    (exp.receiver ? r.receiver === exp.receiver : true) &&
    (exp.phone ? r.phone === exp.phone : true) &&
    (exp.city ? r.city === exp.city : true))
}
ok('ship 非地址拒绝', parseShippingInfo('明天有空吗？13800001111') === null)

console.log(`CLAIM RESULT: pass=${pass} fail=${fail}`)
if (fail > 0) process.exit(1)
