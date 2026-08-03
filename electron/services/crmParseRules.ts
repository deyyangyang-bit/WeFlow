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
