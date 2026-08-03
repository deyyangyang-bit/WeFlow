/**
 * crmParseService.ts
 * 群消息解析管道：定时增量扫描配置群 → 规则先行（crmParseRules）→ AI 兜底 → 落库。
 * 铁律：扫描走 salesQueue 串行（最外层 enqueue）；WCDB 秒级时间戳→毫秒；不猜测落库。
 */
import { app } from 'electron'
import { readFileSync } from 'fs'
import { chatService } from './chatService'
import { wcdbService } from './wcdbService'
import { crmDbService, type CrmRow } from './crmDbService'
import { crmFileService } from './crmFileService'
import { enqueueSalesTask } from './salesQueue'
import { salesLog } from './salesLogger'
import {
  parseBankText, detectPayChannel, wechatTimeToMs, parseAllocationShorthand,
  isClaimKeyword, parseLogisticsBatch, parseInvoicePdfName, feeCheck,
  isCompanyHint, splitAliasHints, parseShippingInfo, type AllocationRow, type ShippingInfo
} from './crmParseRules'
import { isAiConfigured, getAiModelConfig, simpleCompletion, callChatCompletion } from './ai/aiApiClient'
import type { ConfigService } from './config'

let configRef: ConfigService | null = null
let timer: NodeJS.Timeout | null = null
let scanning = false

export function setCrmParseConfig(config: ConfigService): void { configRef = config }

export function startCrmParseScheduler(): void {
  if (timer) return
  timer = setInterval(() => { void scanAll() }, 60_000)
  setTimeout(() => { void scanAll() }, 5_000)
  salesLog('INFO', '[CrmParse] scheduler started (60s)')
}

export function scanNow(): Promise<{ scanned: number }> {
  return enqueueSalesTask(async () => {
    const n = await scanAll()
    return { scanned: n }
  })
}

async function scanAll(): Promise<number> {
  if (scanning) return 0
  scanning = true
  let scanned = 0
  try {
    const groups = crmDbService.groups().filter((g) => Number(g.enabled) === 1)
    if (!groups.length) return 0
    salesLog('INFO', `[CrmParse] scan start groups=${groups.length}`)
    const sessResult = await chatService.getSessions()
    const sessions: CrmRow[] = sessResult?.sessions ?? []
    const byId = new Map<string, CrmRow>()
    for (const s of sessions) byId.set(String(s.username || s.id || ''), s)
    for (const group of groups) {
      const gid = String(group.group_id)
      if (!byId.has(gid)) { salesLog('INFO', `[CrmParse] skip ${gid} not-in-sessions`); continue }
      const lastScan = Number(group.last_scan || 0)
      const msgResult = await chatService.getMessages(gid, 0, 100)
      salesLog('INFO', `[CrmParse] group=${String(group.group_name)} success=${String(msgResult?.success)} msgs=${String(msgResult?.messages?.length ?? 0)}`)
      if (!msgResult?.success || !msgResult.messages?.length) continue
      const messages: CrmRow[] = msgResult.messages
      let maxMs = lastScan
      for (const msg of messages) {
        const ms = Number(msg.createTime ?? 0) * 1000 // WCDB 秒 → 毫秒
        if (ms <= lastScan) continue
        const key = String(msg.messageKey || `${gid}:${msg.createTime}:${msg.localId}`)
        if (crmDbService.isMsgProcessed(key)) { if (ms > maxMs) maxMs = ms; continue }
        try {
          await handle(group, msg)
          scanned++
        } catch (e) {
          salesLog('WARN', `[CrmParse] handle error ${key}: ${e}`)
        }
        crmDbService.markMsgProcessed(key)
        if (ms > maxMs) maxMs = ms
      }
      if (maxMs > lastScan) crmDbService.updateGroup(Number(group.id), { last_scan: maxMs })
    }
    // ── 私聊收货地址扫描：客户付款后发地址/联系人 → 落 shipping_info 并回填未链接物流 ──
    const nowMs = Date.now()
    let privBudget = 150
    for (const sess of sessions) {
      if (privBudget <= 0) break
      const uid = String(sess.username || '')
      if (!uid || uid.includes('@chatroom') || uid.startsWith('gh_') || uid === 'filehelper') continue
      const lastAct = Number(sess.sortTimestamp || sess.lastTimestamp || 0)
      if (lastAct && lastAct < nowMs - 7 * 86400_000) continue
      const name = String(sess.displayName || '')
      let accountId = 0
      const acc = crmDbService.matchAccountByName(name)
      if (acc) accountId = Number(acc.id)
      if (!accountId) {
        const al = crmDbService.aliasLookup(name)
        if (al) accountId = Number(al.account_id)
      }
      if (!accountId) {
        const ct = crmDbService.all('SELECT account_id FROM contact WHERE name = ? LIMIT 1', [name])
        if (ct.length) accountId = Number(ct[0].account_id)
      }
      const lastScan = crmDbService.getScanState('priv:' + uid)
      if (lastScan && lastAct && lastScan >= lastAct) continue // 无新消息，跳过拉取
      privBudget--
      const mr = await chatService.getMessages(uid, 0, 50)
      if (!mr?.success || !mr.messages?.length) continue
      let maxMs = lastScan
      for (const msg of mr.messages) {
        const ms = Number(msg.createTime ?? 0) * 1000
        if (ms <= lastScan) continue
        const key = String(msg.messageKey || `${uid}:${String(msg.createTime)}`)
        if (crmDbService.isMsgProcessed(key)) { if (ms > maxMs) maxMs = ms; continue }
        try {
          const content = String(msg.content ?? msg.parsedContent ?? '')
          let info: ShippingInfo | null = parseShippingInfo(content)
          if (!info && /1[3-9]\d{9}/.test(content) && /(地址|收货|收件)/.test(content) && configRef && isAiConfigured(configRef)) {
            info = await aiParseShipping(content)
          }
          if (info && info.address) {
            let accId = accountId
            // 主数据无此客户：私聊发完整收货地址即视为客户本人 → 建账户+别名学习（跳过自家同事/文件传输助手）
            if (!accId && info.receiver && info.phone && name && !/库叉|文件传输助手/.test(name)) {
              accId = crmDbService.ensureAccount(name)
              crmDbService.aliasLearn(name, accId)
              salesLog('INFO', `[CrmParse] 新建客户账户（私聊地址）: ${name} -> ${accId}`)
            }
            if (!accId) { crmDbService.markMsgProcessed(key); if (ms > maxMs) maxMs = ms; continue }
            crmDbService.saveShippingInfo({
              account_id: accId, receiver: info.receiver, phone: info.phone,
              address: info.address, city: info.city, source_msg_id: key, created_at: Date.now()
            })
            if (info.receiver) {
              const unlinked = crmDbService.all("SELECT * FROM logistics WHERE link_status = 'unlinked' AND receiver = ?", [info.receiver])
              for (const l of unlinked) crmDbService.autoLinkLogisticsByReceiver(Number(l.id), info.receiver)
            }
          }
        } catch (e) {
          salesLog('WARN', `[CrmParse] priv handle error ${key}: ${e}`)
        }
        crmDbService.markMsgProcessed(key)
        if (ms > maxMs) maxMs = ms
      }
      if (maxMs > lastScan) crmDbService.setScanState('priv:' + uid, maxMs)
    }
  } catch (e) {
    salesLog('WARN', `[CrmParse] scanAll error: ${e}`)
  } finally {
    scanning = false
  }
  salesLog('INFO', `[CrmParse] scan done scanned=${scanned}`)
  return scanned
}

// ─── 单消息分发 ──────────────────────────────────────────────────────────────
async function handle(group: CrmRow, msg: CrmRow): Promise<void> {
  const content = String(msg.content ?? msg.parsedContent ?? '')
  const sender = String(msg.senderUsername ? (msg.senderName || msg.senderUsername) : (msg.senderName || ''))
  const senderName = String(msg.senderName || sender || '')
  const groupType = String(group.group_type)

  // 1) 发票 PDF 文件消息
  if (msg.appMsgKind === 'file') {
    const fileNameMatch = content.match(/\[文件\]\s*(.+\.pdf)/i) || content.match(/(.+\.pdf)/i)
    const fileName = fileNameMatch ? fileNameMatch[1].trim() : ''
    const info = parseInvoicePdfName(fileName)
    if (info) {
      const account = crmDbService.findAccountByPrefix(info.buyerPrefix)
      const archived = crmFileService.archive(fileName, userDataPath(), String(msg.fileMd5 || ''))
      crmDbService.create('invoice', {
        invoice_no: info.invoiceNo, buyer: account ? account.name : info.buyerPrefix,
        account_id: account ? account.id : null, amount: 0,
        status: archived ? 'issued' : 'pre_issue', attachment_path: archived, created_at: Date.now()
      })
      return
    }
  }

  // 2) 银行文本到款
  const bank = parseBankText(content)
  if (bank) {
    const channel = detectPayChannel(bank.payer)
    const account = channel === 'bank_direct' ? crmDbService.matchAccountByName(bank.payer) : null
    const payId = crmDbService.createPaymentRecord({
      bank: bank.bank, account_tail: bank.accountTail, payer: bank.payer,
      amount_net: bank.amount, pay_time: wechatTimeToMs(bank.timeText), memo: bank.memo,
      pay_channel: channel, source: 'bank_text', group_id: String(group.group_id),
      msg_id: String(msg.messageKey || ''), raw_content: content
    })
    if (account) {
      crmDbService.addAllocations(payId, [{ customerHint: bank.payer, salesHint: '', amountHint: bank.amount }])
    }
    return
  }

  // 3) 引用类消息：认领 / 归属简语 / AI 兜底
  const quotedContent = msg.quotedContent != null ? String(msg.quotedContent) : null
  if (quotedContent) {
    const payment = findPaymentByRaw(quotedContent)
    if (isClaimKeyword(content)) {
      if (payment) applyClaim(payment, senderName)
      return
    }
    let rows = parseAllocationShorthand(content)
    let aiParsed = false
    if (!rows && payment && configRef && isAiConfigured(configRef)) {
      rows = await aiParseShorthand(content, quotedContent)
      aiParsed = true
    }
    if (rows && payment) {
      applyAllocations(payment, rows, aiParsed)
      return
    }
  }

  // 4) 物流批量
  if (groupType === 'logistics') {
    const logiRows = parseLogisticsBatch(content)
    if (logiRows) {
      for (const r of logiRows) {
        const lid = crmDbService.create('logistics', {
          tracking_no: r.trackingNo, brand: r.brand, receiver: r.receiver, city: r.city,
          courier: String(group.default_courier || '安能物流'), status: 'shipped',
          latest_update_at: Number(msg.createTime || 0) * 1000,
          source_msg_id: String(msg.messageKey || ''), created_at: Date.now()
        })
        // 收货人命中私聊地址 → 自动链接客户合同
        if (lid && !crmDbService.autoLinkLogisticsByReceiver(Number(lid), r.receiver)) {
          // 未命中则保持 unlinked，待确认中心手动/自动匹配
        }
      }
      return
    }
  }

  // 5) 截图到款（vision 开关，默认关→手工登记降级）
  if (msg.localType === 3 && groupType === 'order' && configRef && isVisionEnabled()) {
    await handleScreenshot(group, msg)
  }
}

function userDataPath(): string {
  return app.getPath('userData')
}

function isVisionEnabled(): boolean {
  return configRef ? Boolean((configRef as any).get('crmVisionEnabled')) : false
}

function findPaymentByRaw(quotedContent: string): CrmRow | null {
  const rows = crmDbService.all('SELECT * FROM payment_record WHERE raw_content = ? ORDER BY id DESC LIMIT 1', [quotedContent.trim()])
  return rows.length ? rows[0] : null
}

function applyClaim(payment: CrmRow, senderName: string): void {
  const allocs = crmDbService.all('SELECT * FROM allocation WHERE payment_record_id = ? AND status = ?', [payment.id, 'pending'])
  if (allocs.length) {
    for (const a of allocs) {
      const patch: CrmRow = { status: 'confirmed', confirmed_at: Date.now() }
      if (!a.sales_hint) patch.sales_name = senderName
      if (!a.account_id) resolveAccountForAllocation(a, patch)
      crmDbService.update('allocation', Number(a.id), patch)
    }
    return
  }
  if (payment.pay_channel === 'bank_direct') {
    const account = crmDbService.matchAccountByName(String(payment.payer || ''))
    crmDbService.create('allocation', {
      payment_record_id: payment.id, customer_hint: payment.payer, sales_hint: senderName,
      amount_hint: payment.amount_net, credited_amount: payment.amount_net,
      account_id: account ? account.id : null, sales_name: senderName,
      status: 'confirmed', created_at: Date.now(), confirmed_at: Date.now()
    })
    return
  }
  // 企业微信扫码（财付通）：认领记销售，客户待地址/手动确认
  crmDbService.create('allocation', {
    payment_record_id: payment.id, customer_hint: '企业微信扫码', sales_hint: senderName,
    amount_hint: payment.amount_net, credited_amount: payment.amount_net,
    account_id: null, sales_name: senderName, status: 'pending', created_at: Date.now()
  })
}

function resolveAccountForAllocation(a: CrmRow, patch: CrmRow): void {
  const hints = splitAliasHints(String(a.customer_hint || ''))
  for (const h of hints) {
    if (isCompanyHint(h)) {
      const acc = crmDbService.matchAccountByName(h)
      if (acc) { patch.account_id = acc.id; return }
    } else {
      const alias = crmDbService.aliasLookup(h)
      if (alias) { patch.account_id = alias.account_id; return }
      const acc = crmDbService.accountByReceiver(h)
      if (acc) { patch.account_id = Number(acc.id); return }
    }
  }
}

function applyAllocations(payment: CrmRow, rows: AllocationRow[], aiParsed: boolean): void {
  const sum = rows.reduce((s, r) => s + r.amountHint, 0)
  const pass = feeCheck(sum, Number(payment.amount_net || 0))
  const ids = crmDbService.addAllocations(Number(payment.id), rows)
  if (pass && !aiParsed) {
    ids.forEach((id, i) => {
      const patch: CrmRow = { status: 'confirmed', confirmed_at: Date.now(), sales_name: rows[i].salesHint }
      const hint = rows[i].customerHint
      if (isCompanyHint(hint)) {
        const acc = crmDbService.ensureAccount(hint)
        patch.account_id = acc
      } else {
        const alias = crmDbService.aliasLookup(hint)
        if (alias) patch.account_id = alias.account_id
      }
      crmDbService.update('allocation', id, patch)
    })
  } else {
    crmDbService.update('payment_record', Number(payment.id), { needs_review: 1 })
  }
}

async function aiParseShorthand(content: string, quotedContent: string): Promise<AllocationRow[] | null> {
  if (!configRef) return null
  try {
    const out = await simpleCompletion(configRef,
      '你是归属解析器。把「归属简语」拆成JSON数组，元素 {customer,sales,amount}。只输出JSON。',
      `归属简语：${content}\n被引用到款：${quotedContent}`,
      { responseFormatJson: true, maxTokens: 512 })
    const m = out.match(/\[[\s\S]*\]/)
    if (!m) return null
    const arr = JSON.parse(m[0]) as Array<{ customer?: string; sales?: string; amount?: number | string }>
    const rows = arr
      .filter((x) => x && x.customer && x.amount != null)
      .map((x) => ({ customerHint: String(x.customer), salesHint: String(x.sales || ''), amountHint: parseFloat(String(x.amount)) }))
    return rows.length ? rows : null
  } catch {
    return null
  }
}

async function aiParseShipping(content: string): Promise<ShippingInfo | null> {
  if (!configRef) return null
  try {
    const out = await simpleCompletion(configRef,
      '你是地址解析器。从聊天文本提取收货信息，输出JSON {receiver,phone,address,city}，缺失字段用空字符串。只输出JSON。',
      content, { responseFormatJson: true, maxTokens: 300 })
    const m = out.match(/\{[\s\S]*\}/)
    if (!m) return null
    const o = JSON.parse(m[0]) as Record<string, unknown>
    if (!o.address) return null
    return { receiver: String(o.receiver || ''), phone: String(o.phone || ''), address: String(o.address || ''), city: String(o.city || '') }
  } catch {
    return null
  }
}

async function handleScreenshot(group: CrmRow, msg: CrmRow): Promise<void> {
  // vision OCR：读图片本地路径（媒体导出能力）→ base64 → AI 提取 {amount,payer,time}
  // v1 简化：若拿不到本地图片路径则跳过（降级手工登记）
  const localPath = String(msg.mediaLocalPath || msg.imagePath || '')
  if (!localPath || !configRef) return
  try {
    const data = readFileSync(localPath).toString('base64')
    const out = await callChatCompletion(getAiModelConfig(configRef), [
      { role: 'system', content: '你是银行到账截图OCR。只输出JSON {amount,payer,time}，time格式 M月D日HH:MM:SS。' },
      { role: 'user', content: '识别这张到账截图。' }
    ], { responseFormatJson: true, imagesBase64: [{ data, mime: 'image/png' }], maxTokens: 300 })
    const m = out.match(/\{[\s\S]*\}/)
    if (!m) return
    const j = JSON.parse(m[0]) as { amount?: number | string; payer?: string; time?: string }
    if (j.amount == null || !j.payer) return
    crmDbService.createPaymentRecord({
      payer: String(j.payer), amount_net: parseFloat(String(j.amount)),
      pay_time: j.time ? wechatTimeToMs(String(j.time)) : Date.now(),
      pay_channel: detectPayChannel(String(j.payer)), source: 'screenshot',
      needs_review: 1, group_id: String(group.group_id), msg_id: String(msg.messageKey || ''), raw_content: ''
    })
  } catch (e) {
    salesLog('WARN', `[CrmParse] screenshot OCR failed: ${e}`)
  }
}
