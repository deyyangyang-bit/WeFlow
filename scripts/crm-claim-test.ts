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
  ['无锡惠山经济开发区清研路12号华清创新园12号402   \n杨青\n15374230349', { receiver: '杨青', phone: '15374230349' }],
  ['上海市松江区九新公路870弄98号 毛惠君 13564267835  是这个', { receiver: '毛惠君', city: '上海市' }],
  ['高克强，13861285886   常州市新北区创业东路20号常州世界伟业链轮有限公司', { receiver: '高克强', city: '常州市' }],
  ['收货地址：无锡惠山经济开发区清研路12号华清创新园12号402-2 18556209694 卢', { receiver: '卢', phone: '18556209694' }],
  ['收件人\t:如梦13030\t\n联系电话\t:19817677815\n仓库地址:深圳市宝安区福街道蚝业路59号1栋1楼务沣国际海运仓13030号\t', { receiver: '如梦', city: '深圳市' }],
  ['地址浙江省宁波市北仑区霞浦街道百川港通本部云台山路28号，联系人沈15988776680', { receiver: '沈', city: '宁波市' }],
  ['杭州市临安区玲珑街道庆仙路267号   宋群雄   13805706452', { receiver: '宋群雄', city: '杭州市' }]
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
