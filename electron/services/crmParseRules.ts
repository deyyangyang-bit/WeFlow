/**
 * crmParseRules.ts
 * 群消息解析纯规则库（无 electron 依赖，可独立单测）。
 * 样本依据：库叉线上销售订单对接群 / 艾驱安能物流跟踪群 7+2 张真实截图。
 */

export interface BankPayment { bank: string; accountTail: string; timeText: string; amount: number; payer: string; memo: string }
export interface AllocationRow { customerHint: string; salesHint: string; amountHint: number }
export interface LogisticsRow { trackingNo: string; brand: string; receiver: string; city: string }
export interface InvoicePdfInfo { invoiceNo: string; buyerPrefix: string; tail: string }

// ─── 银行文本（当前仅江苏银行一家，模版可配置扩展）─────────────────────────
const BANK_RE = /【(?<bank>[^】]+)】您(?<company>\S+?)尾号(?<acct>\d{4,6})账户于(?<time>\d{1,2}月\d{1,2}日[\d:]{8})转入人民币(?<amount>[\d,]+\.\d{2})元，+对方户名为(?<payer>[^，,]+)，摘要：(?<memo>[^。]+)。/

export function parseBankText(content: string): BankPayment | null {
  if (!content) return null
  const m = content.match(BANK_RE)
  if (!m?.groups) return null
  return {
    bank: m.groups.bank,
    accountTail: m.groups.acct,
    timeText: m.groups.time,
    amount: parseFloat(m.groups.amount.replace(/,/g, '')),
    payer: m.groups.payer.trim(),
    memo: m.groups.memo.trim()
  }
}

export function detectPayChannel(payer: string): 'wecom_tenpay' | 'bank_direct' {
  return payer && payer.includes('财付通') ? 'wecom_tenpay' : 'bank_direct'
}

// ─── 微信时间「7月30日10:16:32」→ 毫秒（缺年份按当前年推断）─────────────────
export function wechatTimeToMs(timeText: string, now = new Date()): number {
  const m = timeText.match(/(\d{1,2})月(\d{1,2})日(\d{1,2}):(\d{1,2}):(\d{1,2})/)
  if (!m) return Date.now()
  let year = now.getFullYear()
  const month = parseInt(m[1], 10)
  if (month > now.getMonth() + 1) year -= 1
  return new Date(year, month - 1, parseInt(m[2], 10), parseInt(m[3], 10), parseInt(m[4], 10), parseInt(m[5], 10)).getTime()
}

// ─── 归属简语（多行，一行一条归属：客户提示 金额 销售）──────────────────────
const ALLOC_LINE_RE = /^(?<customer>\S+?)\s+(?<amount>\d+(?:\.\d{1,2})?)\s+(?<sales>\S+)$/

export function parseAllocationShorthand(content: string): AllocationRow[] | null {
  if (!content) return null
  const lines = content.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  if (!lines.length) return null
  const rows: AllocationRow[] = []
  for (const line of lines) {
    const m = line.match(ALLOC_LINE_RE)
    if (!m?.groups) return null
    rows.push({ customerHint: m.groups.customer, salesHint: m.groups.sales, amountHint: parseFloat(m.groups.amount) })
  }
  return rows.length ? rows : null
}

// ─── 认领关键词 ──────────────────────────────────────────────────────────────
const CLAIM_WORDS = ['收到', '👌', 'OK', 'ok', '好的', '确认', '知道了']
export function isClaimKeyword(content: string): boolean {
  const t = (content || '').trim()
  return CLAIM_WORDS.includes(t)
}


// ─── 私聊收货地址（收货人/电话/地址/城市，启发式+AI兜底在外层）──────────────
export interface ShippingInfo { receiver: string; phone: string; address: string; city: string }

const SHIP_PHONE_RE = /1[3-9]\d{9}/
const SHIP_ADDR_KW_RE = /(省|自治区|市|区|县|开发区|街道|镇|路|号|弄|栋|园区|产业园|大厦|工业园)/
const SHIP_NAME_LABEL_RE = /(?:收货人|收件人|联系人)[\s:：]*([\u4e00-\u9fa5A-Za-z]{1,4})/

export function parseShippingInfo(content: string): ShippingInfo | null {
  if (!content) return null
  const text = String(content).replace(/\[[^\]]{1,8}\]/g, ' ')
  const phoneM = text.match(SHIP_PHONE_RE)
  if (!phoneM || !SHIP_ADDR_KW_RE.test(text)) return null
  const phone = phoneM[0]
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)

  let receiver = ''
  const labelM = text.match(SHIP_NAME_LABEL_RE)
  if (labelM) receiver = labelM[1]
  if (!receiver) {
    const near = [
      new RegExp(`([\u4e00-\u9fa5]{1,4})(?:（[^）)]*[)）])?[,，、\\s]*(?:收[,，、\\s]*)?${phone}`),
      new RegExp(`${phone}[-)）\\s]*([\u4e00-\u9fa5]{1,4})`)
    ]
    for (const line of lines) {
      for (const re of near) {
        const m = line.match(re)
        if (m?.[1] && !/^(收|是|这|打|拨|请|谢谢|麻烦)/.test(m[1])) { receiver = m[1].replace(/收$/, ''); break }
      }
      if (receiver) break
    }
  }
  if (!receiver) {
    for (const line of lines) {
      const bare = line.replace(SHIP_PHONE_RE, '').replace(/[,，、\s()（）-]/g, '')
      if (/^[\u4e00-\u9fa5]{2,4}$/.test(bare)) { receiver = bare; break }
    }
  }

  let address = ''
  for (const line of [...lines].sort((a, b) => b.length - a.length)) {
    const hits = (line.match(/(省|自治区|市|区|县|街道|镇|路|号|弄|栋|园区|产业园|大厦|工业园|开发区)/g) || []).length
    if (hits >= 2) {
      address = line
        .replace(/(收货地址|仓库地址|收货信息|公司地址|地址|收货人|收件人|联系人|联系电话|电话)[\s:：]*/g, ' ')
        .replace(SHIP_PHONE_RE, ' ')
        .replace(new RegExp(receiver ? receiver.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : 'xxxxxx', 'g'), ' ')
        .replace(/[,，、;；\s]+/g, ' ')
        .replace(/(是这个|谢谢|麻烦|收到|拨打请输入分机号\S*)$/g, '').replace(/\\s*收$/, '')
        .trim()
      break
    }
  }
  if (!address) return null
  const noProv = address.replace(/^[^市]*?(省|自治区)/, '')
  const cityM = noProv.match(/([\u4e00-\u9fa5]{2,8}?市)/)
  return { receiver, phone, address, city: cityM ? cityM[1] : '' }
}

// ─── 物流批量（一行：单号 品牌 收件人 城市）─────────────────────────────────
const LOGI_LINE_RE = /^(?<no>\d{10,15})\s+(?<brand>\S+)\s+(?<name>\S+)\s+(?<city>\S+)$/

export function parseLogisticsBatch(content: string): LogisticsRow[] | null {
  if (!content) return null
  const lines = content.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  if (!lines.length) return null
  const rows: LogisticsRow[] = []
  for (const line of lines) {
    const m = line.match(LOGI_LINE_RE)
    if (!m?.groups) return null
    rows.push({ trackingNo: m.groups.no, brand: m.groups.brand, receiver: m.groups.name, city: m.groups.city })
  }
  return rows.length ? rows : null
}

// ─── 电子发票 PDF 文件名：dzfp_<20位发票号>_<买方前缀>…<尾4>.pdf ─────────────
const INVOICE_RE = /^dzfp_(?<no>\d{20,22})_(?<buyer>.+?)(?:\.\.\.|…)(?<tail>\d{4})\.pdf$/

export function parseInvoicePdfName(fileName: string): InvoicePdfInfo | null {
  if (!fileName) return null
  const m = fileName.match(INVOICE_RE)
  if (!m?.groups) return null
  return { invoiceNo: m.groups.no, buyerPrefix: m.groups.buyer, tail: m.groups.tail }
}

// ─── 财付通费率校验：毛额×(1-feeRate) ≈ 净到账 ───────────────────────────────
export function feeCheck(sumGross: number, net: number, feeRate = 0.002, tol = 0.01): boolean {
  return Math.abs(sumGross * (1 - feeRate) - net) <= tol
}

// ─── 公司名 vs 个人别名判别 ──────────────────────────────────────────────────
const COMPANY_HINT_RE = /(公司|有限|厂|集团|合作社|经营部|商贸行)/
export function isCompanyHint(hint: string): boolean {
  return COMPANY_HINT_RE.test(hint || '')
}
export function splitAliasHints(hint: string): string[] {
  return (hint || '').split('/').map((s) => s.trim()).filter(Boolean)
}
