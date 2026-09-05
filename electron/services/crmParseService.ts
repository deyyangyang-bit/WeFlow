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
  isCompanyHint, splitAliasHints, parseShippingInfo, isDealSignal, parseQuoteSignal, parseBuySignal, parseRiskSignal, type AllocationRow, type ShippingInfo
} from './crmParseRules'
import { applyDealStageWon } from './legalStageWriters'
import { salesDbService } from './salesDbService'
import type { CustomerEventRecord } from '../../shared/customerEvent'
import { isAiConfigured, getAiModelConfig, simpleCompletion, callChatCompletion } from './ai/aiApiClient'
import type { ConfigService } from './config'
import { getAlertService } from './alertService'

let configRef: ConfigService | null = null
let timer: NodeJS.Timeout | null = null
let scanning = false
// 扫描完成钩子（fire-and-forget）：crmIpcHandlers 注入 → 立刻触发确认中心自动确认
let postScanHook: (() => void) | null = null

/**
 * E3.2：通用事实事件写入（写失败不阻断原业务链）。
 * 双写纪律：quote_signal 是报价业务真源（R7 继续消费，不迁移），customer_event 是平行通用事实；
 * 事件写入失败只 WARN 不抛，绝不回卷原有业务链；幂等拒绝（同 message_key 返回 null）是正常语义，不告警。
 * message_key 复用上游已构造的 canonical key（P0-2B buildMessageKey），本处不现场拼 key。
 */
export function recordCustomerEventSafe(input: Omit<CustomerEventRecord, 'id' | 'created_at'>): void {
  try {
    salesDbService.customerEventAdd(input)
  } catch (e) {
    salesLog('WARN', `[CrmParse] customer_event 写入失败 ${input.event_type}: ${e}`)
  }
}

export function setCrmParseConfig(config: ConfigService): void { configRef = config }

/** 注册扫描完成钩子（调用方负责内部 enqueueSalesTask，避免阻塞扫描） */
export function setPostScanHook(hook: (() => void) | null): void { postScanHook = hook }

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
    salesLog('INFO', `[CrmParse] scan start groups=${groups.length}`)
    const sessResult = await chatService.getSessions()
    const sessions: CrmRow[] = sessResult?.sessions ?? []
    const byId = new Map<string, CrmRow>()
    for (const s of sessions) byId.set(String(s.username || s.id || ''), s)
    for (const group of groups) {
      const gid = String(group.group_id)
      if (!byId.has(gid)) { salesLog('INFO', `[CrmParse] skip ${gid} not-in-sessions`); continue }
      const lastScan = Number(group.last_scan || 0)
      // 按 lastScan 翻页扫增量：getMessages 内部 normalizeMessageOrder 会把消息
      // 升序重排（旧在前），故不能「遇 ms<=lastScan 即 break」（倒序假设已失效，会漏掉
      // 排在后方的增量）——改为传 startTime=lastScan 让游标只读增量 + 遇旧 continue 跳过。
      // 传 startTime 是毫秒，getMessages 内部会转成秒级 beginTimestamp 交给原生游标过滤。
      const BATCH = 100
      const MAX_PAGES = 20
      let offset = 0
      let maxMs = lastScan
      let reachedEnd = false
      let batchMsgs = 0
      for (let page = 0; page < MAX_PAGES && !reachedEnd; page++) {
        const msgResult = await chatService.getMessages(gid, offset, BATCH, lastScan)
        salesLog('INFO', `[CrmParse] group=${String(group.group_name)} page=${page + 1} msgs=${String(msgResult?.messages?.length ?? 0)} hasMore=${String(msgResult?.hasMore)}`)
        if (!msgResult?.success || !msgResult.messages?.length) break
        for (const msg of msgResult.messages) {
          const ms = Number(msg.createTime ?? 0) * 1000 // WCDB 秒 → 毫秒
          if (ms <= lastScan) continue // 升序：头部是已扫过的旧消息，跳过继续处理更晚的
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
        batchMsgs += msgResult.messages.length
        if (reachedEnd || !msgResult.hasMore) break
        offset = Number(msgResult.nextOffset ?? offset + msgResult.messages.length)
      }
      if (batchMsgs >= BATCH * MAX_PAGES && !reachedEnd) {
        salesLog('WARN', `[CrmParse] group=${String(group.group_name)} 翻页达到上限 ${MAX_PAGES} 页，仍有未扫增量`)
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
      const lastActRaw = Number(sess.sortTimestamp || sess.lastTimestamp || 0)
      const lastAct = lastActRaw > 1e12 ? lastActRaw : lastActRaw * 1000 // WCDB 秒级兼容
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
      // 同样翻页扫增量：getMessages 升序返回（normalizeMessageOrder 重排），
      // 传 startTime=lastScan 让游标只读增量 + 遇旧 continue 跳过（不能 break）
      const BATCH = 50
      const MAX_PAGES = 10
      let offset = 0
      let maxMs = lastScan
      let reachedEnd = false
      for (let page = 0; page < MAX_PAGES && !reachedEnd; page++) {
        const mr = await chatService.getMessages(uid, offset, BATCH, lastScan)
        if (!mr?.success || !mr.messages?.length) break
        for (const msg of mr.messages) {
          const ms = Number(msg.createTime ?? 0) * 1000
          if (ms <= lastScan) continue // 升序：跳过已扫过的旧消息
          const key = String(msg.messageKey || `${uid}:${String(msg.createTime)}`)
          if (crmDbService.isMsgProcessed(key)) { if (ms > maxMs) maxMs = ms; continue }
          const content = String(msg.content ?? msg.parsedContent ?? '')
          const isSend = Number(msg.isSend ?? msg.computed_is_send ?? msg.is_send ?? 0)
          // 私域成交检测：客户消息含明确成交信号 → 阶段=won + 自动建 CRM 合同
          if (isDealSignal(content, isSend)) {
            try {
              let dealAccountId = accountId
              if (!dealAccountId) {
                const imp = crmDbService.importCustomerFromProfile({ name, sessionId: uid, stage: 'won', reason: '私聊成交信号' })
                if (imp.id) dealAccountId = imp.id
              }
              if (dealAccountId) {
                // P0-2A.6：deal rule 写者补元数据 —— stage=won + intent_tag_log(source=deal_rule) + last_stage_change_at
                try { applyDealStageWon(uid, name) } catch { /* salesDb 未初始化忽略 */ }
                const dr = crmDbService.createDealContract(dealAccountId, content.slice(0, 60))
                salesLog('INFO', `[CrmParse] 私聊成交信号「${name}」→ ${dr.created ? '新建合同' : '已有合同'}`)
              }
            } catch (e) {
              salesLog('WARN', `[CrmParse] 成交检测处理失败 ${name}: ${e}`)
            }
          }
          // 报价信号：我方消息含金额+报价意向/设备词 → quote_signal（供 R7 报价跟进）；语音用转写文本
          let textForSignal = content
          if (/^<msg>\s*<voicemsg/i.test(content)) {
            try {
              const t = chatService.getCachedVoiceTranscript(uid, String((msg as any).localId ?? ''), Number(msg.createTime ?? 0))
              if (t) textForSignal = t
            } catch { /* 转写不可用则跳过 */ }
          }
          const quoteSig = parseQuoteSignal(textForSignal, isSend)
          if (quoteSig) {
            if (crmDbService.recordQuoteSignal({ msgKey: key, sessionId: uid, accountId, displayName: name, amount: quoteSig.amount, model: quoteSig.model, quotedAt: ms })) {
              salesLog('INFO', `[CrmParse] 报价信号「${name}」¥${quoteSig.amount}${quoteSig.model ? `（${quoteSig.model}）` : ''}`)
              // E3.2：报价事实 → 通用事实事件（quote_signal 仍为 R7 业务真源，双写平行不迁移）
              // 无名 session（accountId=0：displayName/alias/contact 均未匹配到 CRM 联系人）不写 customer_event——观察期防污染（A1 已清 3 条）；quote_signal 业务真源不受影响
              if (accountId) {
                recordCustomerEventSafe({
                  session_id: uid,
                  event_type: 'quote_asked',
                  message_key: key, // 复用上游 canonical messageKey（幂等依赖 E3.1 unique index）
                  evidence_text: textForSignal.slice(0, 200) || null, // 消息原话，非 AI 结论
                  source: 'system',
                  metadata: JSON.stringify({ amount: quoteSig.amount ?? null, model: quoteSig.model ?? null })
                })
              }
            }
          } else if (isSend === 0) {
            const closed = crmDbService.markQuoteReplied(uid, ms)
            // E3.2：客户回复（确实关闭了未回复报价）→ 通用事实事件；quote_signal.customer_replied_at 兼容字段继续更新
            // 无名 session（accountId=0）不写 customer_event——观察期防污染（与 quote_asked 同门控）
            if (closed > 0 && accountId) {
              recordCustomerEventSafe({
                session_id: uid,
                event_type: 'customer_replied',
                message_key: key, // 客户消息自身的 canonical key（幂等防重复扫描重写）
                evidence_text: content.slice(0, 200) || null, // 客户原话，非 AI 结论
                source: 'system'
              })
            }
          }
          // 商机采购信号（P0）：客户消息表达采购意向 → 自动创建/累积商机（未建档自动建档）
          const buySig = parseBuySignal(textForSignal, isSend)
          if (buySig) {
            let oppAccountId = accountId
            if (!oppAccountId && uid && !uid.includes('@chatroom')) {
              try {
                const imp = crmDbService.importCustomerFromProfile({ name, sessionId: uid, stage: '了解', reason: '采购信号自动建档' })
                if (imp.id) oppAccountId = imp.id
              } catch { /* crmDb 未初始化忽略 */ }
            }
            if (oppAccountId) {
              try {
                const or = crmDbService.opportunityUpsertBySignal(oppAccountId, name, {
                  product: buySig.product, quantity: buySig.quantity, amount: buySig.amount,
                  stage: '了解', detail: buySig.detail
                })
                if (or.created) salesLog('INFO', `[CrmParse] 采购信号「${name}」→ 新商机 ${buySig.product}${buySig.quantity ? `×${buySig.quantity}` : ''}（${buySig.detail}）`)
              } catch (e) { salesLog('WARN', `[CrmParse] 商机识别失败 ${name}: ${e}`) }
            }
          }
          // 风险信号（P0）：竞品/价格/服务 → crm_risk（同类型幂等累积）
          const riskSig = parseRiskSignal(textForSignal, isSend)
          if (riskSig) {
            const riskAccountId = accountId
            if (riskAccountId) {
              try {
                const activeOpp = crmDbService.activeOpportunitiesByAccount(riskAccountId)[0]
                const rr = crmDbService.upsertRisk(riskAccountId, {
                  riskType: riskSig.riskType, severity: riskSig.severity,
                  detail: riskSig.detail, opportunityId: activeOpp ? Number(activeOpp.id) : undefined,
                  // 阶段三告警锚点：source_msg 列激活（设计-AI见解重定位 §4.2），key 复用上游 canonical messageKey
                  sourceMsg: key
                })
                if (rr.created) salesLog('INFO', `[CrmParse] 风险信号「${name}」(${riskSig.riskType})`)
                // 告警 A「竞品提及」：经 alertService 四道闸（证据强制/72h 幂等/推送门/落库）。
                // 推送门默认 false（评测 ≥85% 才开），门关时零副作用；fire-and-forget 不阻断扫描链
                if (riskSig.riskType === 'competitor') {
                  void getAlertService()?.createAlert({
                    type: 'competitor', sessionId: uid, displayName: name,
                    messageKey: key, evidenceText: textForSignal.slice(0, 200)
                  }).catch((e) => salesLog('WARN', `[CrmParse] 告警创建失败 ${name}: ${e}`))
                }
              } catch (e) { salesLog('WARN', `[CrmParse] 风险识别失败 ${name}: ${e}`) }
            }
          }

          try {
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
        if (reachedEnd || !mr.hasMore) break
        offset = Number(mr.nextOffset ?? offset + mr.messages.length)
      }
      if (maxMs > lastScan) crmDbService.setScanState('priv:' + uid, maxMs)
    }
  } catch (e) {
    salesLog('WARN', `[CrmParse] scanAll error: ${e}`)
  } finally {
    scanning = false
    // 扫完立刻触发确认中心自动确认（fire-and-forget；调用方负责 enqueueSalesTask）
    try { postScanHook?.() } catch (e) { salesLog('WARN', `[CrmParse] postScanHook error: ${e}`) }
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
      // 发票挂到该客户最近一条可挂款合同，未命中留空待确认中心人工关联
      const contract = account ? crmDbService.activeContractForAccount(Number(account.id)) : null
      const invId = crmDbService.create('invoice', {
        invoice_no: info.invoiceNo, buyer: account ? account.name : info.buyerPrefix,
        account_id: account ? account.id : null, contract_id: contract ? Number(contract.id) : null,
        amount: 0,
        status: archived ? 'issued' : 'pre_issue', attachment_path: archived, created_at: Date.now()
      })
      if (invId) crmDbService.logActivity('invoice', invId, 'archived',
        `群归档发票 ${info.invoiceNo}${account ? `，客户 ${account.name}` : ''}${archived ? '' : '（文件未定位，待归档）'}`)
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
      msg_id: String(msg.messageKey || ''), raw_content: content,
      // 前置小修：银行直连到款但客户未命中 → 进到款待审队列（needs_review=1），
      // 避免"客户没登记 → 无归属可建 → 钱静默消失"。财付通走认领，保持原状。
      needs_review: channel === 'bank_direct' && !account ? 1 : 0
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
        const ts = Number(msg.createTime || 0) * 1000
        // 单号幂等：物流群每晚同批列表重扫/补扫时已存在只刷新更新时间，不重复建单
        const existing = crmDbService.logisticsByTrackingNo(r.trackingNo)
        if (existing) {
          crmDbService.update('logistics', Number(existing.id), { latest_update_at: ts })
          continue
        }
        const lid = crmDbService.create('logistics', {
          tracking_no: r.trackingNo, brand: r.brand, receiver: r.receiver, city: r.city,
          courier: String(group.default_courier || '安能物流'), status: 'shipped',
          latest_update_at: ts,
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
      // 归属挂到该客户最近一条可挂款合同（pending_sign/signed），无则留空待人工
      if (patch.account_id) {
        const contract = crmDbService.activeContractForAccount(Number(patch.account_id))
        if (contract) patch.contract_id = Number(contract.id)
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
