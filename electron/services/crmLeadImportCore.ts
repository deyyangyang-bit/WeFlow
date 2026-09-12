/**
 * crmLeadImportCore.ts —— 线索导入纯核心（零 electron，可单测）
 * 手机号/微信号识别、规范化、联系方式分类（phone/wechat/both）、同批去重。
 * 跨批去重依赖数据库唯一索引（(contact_type, contact_normalized)），此处不预查。
 */

export interface RawLeadRow {
  /** 整行拼接文本（文本粘贴=整行；Excel=各列拼接，提取联系方式用） */
  text?: string
  /** Excel 显式手机号列（优先于 text 提取） */
  phone?: string
  /** Excel 显式微信号列（优先于 text 提取） */
  wechat?: string
  name?: string
  tag?: string
  note?: string
  source?: string
}

export interface ParsedLead {
  contactType: 'phone' | 'wechat' | 'both'
  contactNormalized: string
  contactRaw: string
  /** 微信号（both 时并存；wechat 为主时为空，主联系方式即微信号） */
  wechat: string
  name: string
  tag: string
  note: string
}

/** 大陆手机号：1 开头 + 第二位 3-9 + 9 位数字 */
const CN_MOBILE_RE = /1[3-9]\d{9}/
/** 带标注的微信号：微信/VX/vx/wx/威信/微信号 等后跟的号 */
const WECHAT_LABELED_RE = /(?:微信|VX|vx|wx|WX|威信|微信号|v信|V信)[:：]?\s*([A-Za-z][A-Za-z0-9_-]{5,19})/
/** 裸微信号：字母开头、6~20 位（无标注时兜底识别） */
const WECHAT_NAKED_RE = /\b([A-Za-z][A-Za-z0-9_-]{5,19})\b/

function isValidCnMobile(n: string): boolean {
  return /^1[3-9]\d{9}$/.test(n)
}

/** 手机号规范化：去空格/横杠/括号/86 前缀后的纯数字（业务=大陆手机号） */
export function normalizeCnMobile(raw: string): string {
  const digits = String(raw || '').replace(/[^\d]/g, '')
  return digits.replace(/^86(?=1[3-9]\d{9}$)/, '')
}

/** 微信号规范化：去前导 @、去空格转小写（加好友大小写不敏感） */
export function normalizeWechat(raw: string): string {
  return String(raw || '').trim().replace(/^@/, '').replace(/\s/g, '').toLowerCase()
}

/** 从文本提取大陆手机号（返回 11 位纯数字，无则空串）。兼容 +86/空格/横杠/括号。 */
export function extractCnMobile(text: string): string {
  const compact = String(text || '').replace(/[\s\-—–（）()]/g, '')
  const m = compact.match(CN_MOBILE_RE)
  return m ? m[0] : ''
}

/** 从文本提取微信号（带标注优先，无标注时按裸规则兜底；无则空串） */
export function extractWechat(text: string): string {
  const t = String(text || '')
  const labeled = t.match(WECHAT_LABELED_RE)
  if (labeled) return labeled[1]
  const naked = t.match(WECHAT_NAKED_RE)
  return naked ? naked[1] : ''
}

/** 主联系方式：手机号优先。同行既有手机号又有微信号 → both（手机号为主，微信号入 wechat）。 */
export function classifyLead(row: RawLeadRow): ParsedLead | null {
  const text = String(row.text || '')
  let phone = String(row.phone || '').trim()
  let wechat = String(row.wechat || '').trim()
  if (!phone) phone = extractCnMobile(text)
  if (!wechat) wechat = extractWechat(text)
  const phoneN = phone ? normalizeCnMobile(phone) : ''
  const wechatN = wechat ? normalizeWechat(wechat) : ''
  const name = String(row.name || '').trim()
  const tag = String(row.tag || '').trim()
  const note = String(row.note || '').trim()
  if (isValidCnMobile(phoneN) && wechatN) {
    return { contactType: 'both', contactNormalized: phoneN, contactRaw: phone, wechat: wechatN, name, tag, note }
  }
  if (isValidCnMobile(phoneN)) {
    return { contactType: 'phone', contactNormalized: phoneN, contactRaw: phone, wechat: '', name, tag, note }
  }
  if (wechatN) {
    return { contactType: 'wechat', contactNormalized: wechatN, contactRaw: wechat, wechat: '', name, tag, note }
  }
  return null
}

export interface DedupeResult {
  valid: ParsedLead[]
  duplicateCount: number
  invalidCount: number
  /** 无效行的原始行号（0 基） */
  invalidIndexes: number[]
  /** 同批重复行明细（2026-09-08 查重完善：跨 contactType，记录行号与命中原因） */
  duplicates: Array<{ index: number; reason: string }>
}

/** 提取一行的双标识键（跨 contactType 查重用）：手机号键（phone/both 有值）+ 微信号键（wechat/both 有值） */
export function identityKeysOf(p: Pick<ParsedLead, 'contactType' | 'contactNormalized' | 'wechat'>): { phone: string; wechat: string } {
  const phone = p.contactType === 'phone' || p.contactType === 'both' ? String(p.contactNormalized || '') : ''
  const wechat = p.contactType === 'wechat' ? String(p.contactNormalized || '') : String(p.wechat || '')
  return { phone, wechat }
}

/**
 * 同批去重（2026-09-08 完善为跨 contactType）：
 *   - 手机号按归一化手机号查重（phone/both 都参与手机号键）；
 *   - 微信号按归一化微信号查重（wechat/both 都参与微信号键）；
 *   - 旧口径 `contactType:contactNormalized` 会放过「同号不同类型」的重复（如 phone:138… 与
 *     both:138…），本实现按双标识集合拦截；无效行单独计数。
 */
export function dedupeRows(parsed: Array<ParsedLead | null>): DedupeResult {
  const seenPhones = new Set<string>()
  const seenWechats = new Set<string>()
  const valid: ParsedLead[] = []
  const invalidIndexes: number[] = []
  const duplicates: Array<{ index: number; reason: string }> = []
  parsed.forEach((p, i) => {
    if (!p) { invalidIndexes.push(i); return }
    const keys = identityKeysOf(p)
    if (keys.phone && seenPhones.has(keys.phone)) {
      duplicates.push({ index: i, reason: '同批手机号重复' })
      return
    }
    if (keys.wechat && seenWechats.has(keys.wechat)) {
      duplicates.push({ index: i, reason: '同批微信号重复' })
      return
    }
    if (keys.phone) seenPhones.add(keys.phone)
    if (keys.wechat) seenWechats.add(keys.wechat)
    valid.push(p)
  })
  return { valid, duplicateCount: duplicates.length, invalidCount: invalidIndexes.length, invalidIndexes, duplicates }
}

/** 脱敏展示：手机号 138****8000；微信号 保留首尾（供今日行动卡/列表用） */
export function maskContact(parsed: Pick<ParsedLead, 'contactType' | 'contactNormalized'>): string {
  const v = parsed.contactNormalized
  if (parsed.contactType === 'phone') {
    return v.length === 11 ? `${v.slice(0, 3)}****${v.slice(-4)}` : v
  }
  return v.length >= 4 ? `${v.slice(0, 2)}***${v.slice(-1)}` : v
}
