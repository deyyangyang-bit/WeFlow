/**
 * moneyCn.ts —— 人民币金额转中文大写（零 electron 依赖，纯函数，可单测）
 * 供 合同/开票申请单 生成时使用。
 * 例：3500 → 叁仟伍佰元整；12345.67 → 壹万贰仟叁佰肆拾伍元陆角柒分。
 */

const CN_NUM = ['零', '壹', '贰', '叁', '肆', '伍', '陆', '柒', '捌', '玖']
const CN_POS = ['', '拾', '佰', '仟']
const CN_SEC = ['', '万', '亿', '万亿']

/** 4 位数字段转中文（含段内零），全零返回 ''。s 长度 1-4。 */
function fourDigitCn(s: string): string {
  let out = ''
  let zero = false
  const n = s.length
  for (let i = 0; i < n; i++) {
    const d = Number(s[i])
    const pos = n - 1 - i
    if (d === 0) {
      zero = true
    } else {
      if (zero && out) out += '零'
      zero = false
      out += CN_NUM[d] + CN_POS[pos]
    }
  }
  return out
}

/** 正整数转中文（>0），零返回 ''。 */
function integerToCn(integer: number): string {
  if (integer === 0) return ''
  const s = String(integer)
  // 从低位每 4 位一组（低位在前）
  const groups: string[] = []
  for (let i = s.length; i > 0; i -= 4) {
    groups.push(s.slice(Math.max(0, i - 4), i))
  }
  let result = ''
  for (let gi = groups.length - 1; gi >= 0; gi--) {
    const part = fourDigitCn(groups[gi])
    if (part === '') continue
    // 组间补零：该组不足 4 位有效（高位有 0）
    if (result !== '' && Number(groups[gi]) < Math.pow(10, groups[gi].length - 1)) {
      result += '零'
    }
    result += part + CN_SEC[gi]
  }
  return result
}

/**
 * 金额转中文大写。非法输入返回 ''。
 * 整数部分缺角分补「整」；只有零钱时为「零元…」。
 */
export function amountToChinese(amount: number): string {
  if (typeof amount !== 'number' || !isFinite(amount)) return ''
  const negative = amount < 0
  const totalCents = Math.round(Math.abs(amount) * 100)
  const yuan = Math.floor(totalCents / 100)
  const jiao = Math.floor((totalCents % 100) / 10)
  const fen = totalCents % 10

  const intPart = integerToCn(yuan)
  let s = intPart === '' ? '零元' : intPart + '元'
  if (jiao === 0 && fen === 0) {
    s += '整'
  } else if (jiao === 0) {
    s += '零' + CN_NUM[fen] + '分'
  } else if (fen === 0) {
    s += CN_NUM[jiao] + '角'
  } else {
    s += CN_NUM[jiao] + '角' + CN_NUM[fen] + '分'
  }
  return (negative ? '负' : '') + s
}
