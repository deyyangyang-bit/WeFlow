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

// ─── 报价信号（销售侧消息：意向词/设备词 + 金额；客户询价不算）─────────────
const QUOTE_INTENT_RE = /(报价|报个价|价格如下|给你算|优惠价|含运费|含税|不含税|首付|定金|全款|落地价|出厂价|包送)/
const ASK_QUOTE_RE = /(你报个价|给我报个价|能报价吗|报个价看看|发个报价|想要报价|求报价|多少钱)/
const EQUIP_HINT_RE = /(吨|叉车|搬运|堆高|托盘|电动|内燃|CPD|CPC|台|辆)/
const QUOTE_AMOUNT_RE = /(¥|￥|人民币)?\s*(\d[\d,]*(?:\.\d+)?)\s*(万\s*元|万元|万|元|块钱|块)?/g
/** 手机号（如「15200000006 示例采购」首触消息）不当金额——Windows 打包版真实案例 ¥15,200,000,006 */
const PHONE_NUM_RE = /1[3-9]\d{9}/
/** 金额合理性上限（1 亿）：叉车业务不可能，兜底订单号/长数字串 */
const AMOUNT_MAX = 1e8

export interface QuoteSignalInfo { amount: number; model: string | null }

/**
 * 报价信号检测（纯函数）。仅认销售侧消息（isSend=1）；必须有金额；
 * 还需 报价意向词 或 设备词 之一（避免"转你200元"类误报）；客户询价话术排除。
 * 语音消息调用方先换转写文本再传入。
 */
export function parseQuoteSignal(content: string, isSend: number): QuoteSignalInfo | null {
  if (isSend !== 1) return null
  const text = String(content || '').trim()
  if (!text || text.length < 4) return null
  if (ASK_QUOTE_RE.test(text) && !QUOTE_INTENT_RE.test(text)) return null
  // 遍历所有数字候选：跳过型号里的数字（如 CPD20 的 20），取第一个带单位/货币符号/≥1000 的
  let amount = 0
  let matched = false
  for (const m of text.matchAll(QUOTE_AMOUNT_RE)) {
    const hasCurrency = Boolean(m[1])
    const unit = m[3] || ''
    let v = parseFloat(m[2].replace(/,/g, ''))
    if (!Number.isFinite(v) || v <= 0) continue
    if (PHONE_NUM_RE.test(m[2])) continue // 手机号不是金额
    if (unit.includes('万')) v *= 10000
    if (v >= AMOUNT_MAX) continue
    if (!unit && !hasCurrency && v < 1000) continue // 数量/天数类小额数字不认
    amount = v
    matched = true
    break
  }
  if (!matched) return null
  const hasIntent = QUOTE_INTENT_RE.test(text)
  const hasEquip = EQUIP_HINT_RE.test(text)
  if (!hasIntent && !hasEquip) return null
  const modelM = text.match(/(\d+(?:\.\d+)?\s*吨|CPD\d{1,4}|CPC\d{1,4}|电动叉车|内燃叉车)/)
  return { amount, model: modelM ? modelM[1].replace(/\s+/g, '') : null }
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

// ─── 物流批量（一行：单号 品牌 收件人 城市，尾部可跟催单/备注等闲聊文本）────────
// 尾部容忍：物流群发货列表有时同条消息带跟进话（如「@妙妙 查一下这个快递，客户在催」），
// 只取前 4 段（单号 品牌 收件人 城市），尾部文本不参与匹配也不影响整批识别。
const LOGI_LINE_RE = /^(?<no>\d{10,15})\s+(?<brand>\S+)\s+(?<name>\S+)\s+(?<city>\S+)(?:\s+\S.*)?$/

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

// ─── 发票文件名金额提取（保守）：仅识别带金额标记（金额/¥/￥/价款/价税合计）的数值，
//     数字后不得再接数字（避免 1234.56 只截到 1234）。无标记（如 dzfp_…2959.pdf 的尾号 2959）不识别。
const INVOICE_AMOUNT_RE = /(?:金额|¥|￥|价款|含税|价税合计)[:：]?\s*([\d,]+(?:\.\d{1,2})?)(?![\d])/
/** 从发票文件名提取金额；无法保守确认返回 null（留人工填金额） */
export function extractInvoiceAmountFromName(fileName: string): number | null {
  if (!fileName) return null
  const m = fileName.match(INVOICE_AMOUNT_RE)
  if (!m) return null
  const v = Number(String(m[1]).replace(/,/g, ''))
  return Number.isFinite(v) && v > 0 ? v : null
}

// ─── 财付通费率校验：毛额×(1-feeRate) ≈ 净到账 ───────────────────────────────
export function feeCheck(sumGross: number, net: number, feeRate = 0.002, tol = 0.01): boolean {
  return Math.abs(sumGross * (1 - feeRate) - net) <= tol
}

// ─── 私聊成交信号（私域成交检测，保守词表宁缺勿滥）───────────────────────────
// 明确成交词（客户确认下单/付款）
const DEAL_WORDS = [
  '下单', '拍下', '订了', '定了', '就这么定', '成交', '来一台', '来两台', '来三台',
  '打款给你', '转给你', '给你打款', '付款了', '转账了', '款已付', '已付款', '就这台', '就要这台'
]
// 意向词（≠成交，命中则排除）
const DEAL_EXCLUDE = ['想要', '要不要', '想买', '考虑', '了解一下', '打算', '再看看', '考虑下', '不要', '不用', '先不', '别急']

// ─── 商机采购信号（P0）：客户消息里表达明确采购意向 → 识别产品/数量/金额 ──────
const BUY_INTENT_RE = /(采购|要买|准备买|要购置|需要|询价|想了解|了解下|看看价|咨询|什么价格|多少钱|报个价|要几台|要多少台|多少个|什么价|怎么卖|来一台|来几台|先来|能便宜|优惠|便宜点|再低|可以便宜)/
const BUY_QUANTITY_RE = /(\d+(?:\.\d+)?)\s*(台|辆|个|套|部)/
// 吨位（独立匹配，中间可隔 "台/的" 等噪声，如 "10台2吨的电动叉车"）
const BUY_TON_RE = /(\d+(?:\.\d+)?)\s*吨/
// 设备大类（长词优先）
const BUY_DEVICE_RE = /(电动叉车|内燃叉车|电动搬运车|手动搬运车|半电动搬运车|堆高车|托盘车|牵引车|升降机|升高机|堆高机|叉车|搬运车)/
const BUY_NOISE = ['你在吗', '发个图', '发图', '看看图', '店铺', '门店', '怎么联系', '联系方式', '工资', '招聘', '哪个店']

export interface BuySignalInfo { product: string; quantity: number; amount: number; detail: string }

// ─── 风险信号（P0）：客户消息里的竞品/价格/服务风险 → 结构化风险预警（PRD §18）──
export interface RiskSignalInfo { riskType: 'competitor' | 'price' | 'service'; severity: 'high' | 'medium' | 'low'; detail: string }
// 竞品：别家报价更低 / 比你们便宜
const RISK_COMPETITOR_RE = /(另外|别的|其他|另一|还有)(?:一)?家?.{0,8}(?:便宜|低|报价|价格)|比(?:你|你们)?.{0,5}(?:便宜|低)/
// 价格：压价 / 太贵 / 要底价
const RISK_PRICE_RE = /(还能不能.{0,4}便宜|再便宜|优惠.{0,4}(?:定|买|就)|便宜.{0,3}(?:定|买|就)|太贵|价格(?:高|贵)|最低价|底价|给个实价)/
// 服务：关注售后/保修
const RISK_SERVICE_RE = /(售后|保修|质保|维修).{0,10}(怎么|在哪|多久|几年|怎么办|找谁)/

export function parseRiskSignal(content: string, isSend: number): RiskSignalInfo | null {
  if (isSend !== 0) return null // 只看客户消息
  const text = String(content || '').replace(/\[[^\]]{1,8}\]/g, ' ').trim()
  if (!text || text.length < 4) return null
  if (RISK_COMPETITOR_RE.test(text)) return { riskType: 'competitor', severity: 'high', detail: text.slice(0, 100) }
  if (RISK_PRICE_RE.test(text)) return { riskType: 'price', severity: 'medium', detail: text.slice(0, 100) }
  if (RISK_SERVICE_RE.test(text)) return { riskType: 'service', severity: 'low', detail: text.slice(0, 100) }
  return null
}

// ─── 流失信号（设计-AI见解重定位 §4.2 告警 B）：客户明示流失 → 候选（暂不接告警链，
// 先在 alert_eval_case 评测集跑到 ≥85% 准确率才允许接 alertService，§4.1 第 4 条）──
export interface LossSignalInfo { type: 'loss'; detail: string }
// 明示流失：明确拒绝 / 已在他处成交。窄口径起步（宁缺勿滥，评测定标后再放宽）：
// 「不买了/不用了/不需要了/不要了」= 明示拒绝；「找别家/别家买/在别家」+ 成交动词 = 已投竞品；
// 「已经订了/已经买了」= 已成交。
const LOSS_REJECT_RE = /不(?:买了|用了|需要了|要了)|用不上了?|不要了/
const LOSS_ELSEWHERE_RE = /找别家|别家买|别(?:的|家).{0,4}(?:买了|订了|定了|成交)|在别(?:的|家).{0,4}(?:买了|订了|定了)|(?:已经|都)订了|(?:已经|都)买了|买(?:了|过)别(?:家|的)(?:了)?/
export function parseLossSignal(content: string, isSend: number): LossSignalInfo | null {
  if (isSend !== 0) return null // 只看客户消息（parseRiskSignal 同型风格）
  const text = String(content || '').replace(/\[[^\]]{1,8}\]/g, ' ').trim()
  if (!text || text.length < 4) return null
  if (LOSS_REJECT_RE.test(text) || LOSS_ELSEWHERE_RE.test(text)) return { type: 'loss', detail: text.slice(0, 100) }
  return null
}

export function parseBuySignal(content: string, isSend: number): BuySignalInfo | null {
  if (isSend !== 0) return null // 只看客户消息
  const text = String(content || '').replace(/\[[^\]]{1,8}\]/g, ' ').trim()
  if (!text || text.length < 4) return null
  if (!BUY_INTENT_RE.test(text)) return null
  if (BUY_NOISE.some((w) => text.includes(w))) return null
  // 数量（第一个命中）
  let quantity = 0
  const qm = text.match(BUY_QUANTITY_RE)
  if (qm) quantity = Math.round(Number(qm[1]))
  // 金额（客户主动给价，如 "6500我可以考虑"；复用报价金额正则）
  let amount = 0
  for (const m of text.matchAll(QUOTE_AMOUNT_RE)) {
    const unit = m[3] || ''
    let v = parseFloat(m[2].replace(/,/g, ''))
    if (!Number.isFinite(v) || v <= 0) continue
    if (PHONE_NUM_RE.test(m[2])) continue // 手机号不是金额
    if (unit.includes('万')) v *= 10000
    if (v >= AMOUNT_MAX) continue
    if (!unit && v < 1000) continue
    amount = v
    break
  }
  // 产品规范化：吨位 + 设备大类（如 "2吨电动叉车"）；无设备时产品留空
  let product = ''
  const tonM = text.match(BUY_TON_RE)
  const devM = text.match(BUY_DEVICE_RE)
  if (devM) product = `${tonM ? `${tonM[1]}吨` : ''}${devM[1]}`
  // 门槛：设备词 或 数量 或 客户主动给价（如 "6500我可以考虑"）
  if (!devM && !quantity && !amount) return null
  return { product, quantity, amount, detail: text.slice(0, 80) }
}
/**
 * 识别客户私聊中的成交信号。只看客户消息（isSend=0），命中明确成交词且无意向词时返回 true。
 * 保守设计：只认最明确的"定了/下单/付款"表达，避免把"考虑买"误判为成交。
 */
export function isDealSignal(content: string, isSend: number): boolean {
  if (isSend !== 0) return false
  const text = String(content || '').replace(/\[[^\]]{1,8}\]/g, ' ')
  if (DEAL_EXCLUDE.some((w) => text.includes(w))) return false
  return DEAL_WORDS.some((w) => text.includes(w))
}

// ─── 公司名 vs 个人别名判别 ──────────────────────────────────────────────────
const COMPANY_HINT_RE = /(公司|有限|厂|集团|合作社|经营部|商贸行)/
export function isCompanyHint(hint: string): boolean {
  return COMPANY_HINT_RE.test(hint || '')
}
export function splitAliasHints(hint: string): string[] {
  return (hint || '').split('/').map((s) => s.trim()).filter(Boolean)
}
