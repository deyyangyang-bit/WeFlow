/**
 * customer-event-producer-test.ts —— P0-3 E3.2 验收：最小生产者接入（quote_asked / customer_replied）
 *
 * 验收（Scope Lock 2026-08-23 + E3.2 窄切锁定）：
 *   双写不改变原链路：quote_signal 原样写（R7 继续消费）+ customer_event 平行写；事件写失败不阻断原链。
 *   A 静态护栏：
 *     1  recordQuoteSignal 成功块后接 quote_asked 事件（双写平行）
 *     2  markQuoteReplied 后接 customer_replied 事件（closed > 0 才写——客户确实回复了报价）
 *     3  message_key 复用上游 canonical key 变量（不现场拼 key）
 *     4  evidence_text 来自消息原话（textForSignal/content slice），非 AI 结论
 *     5  写失败不阻断：recordCustomerEventSafe 有 try/catch + WARN，绝不抛到调用方
 *     6  R7 不改（customerEventAdd 仅 1 处且在 E3.3 recordUserActionEvent 内；R7 业务路径零直接事件引用）
 *     7  recordQuoteSignal 内部无事件写（crmDbService 不被事件污染）
 *     8  intent_tag_log 无新写点（crmParseService 不直接 intentCreate）
 *   B 行为（temp 双库，真实生产函数）：
 *     9  报价消息 → quote_signal + quote_asked 双写一致（同 key）
 *     10 同 key 重复 → 双写各自幂等（quote_signal 返回 false + 事件不重复）
 *     11 客户回复 → quote_signal.customer_replied_at 更新 + customer_replied 事件
 *     12 无未回复报价的客户消息 → 不写 customer_replied（closed=0）
 *     13 事件写失败不阻断原链（helper 吞错 + quote_signal 原逻辑仍成功）
 *     14 metadata 携带报价详情（amount/model）
 *
 * 运行：npx tsx scripts/customer-event-producer-test.ts
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { crmDbService } from '../electron/services/crmDbService'
import { salesDbService } from '../electron/services/salesDbService'
import { recordCustomerEventSafe } from '../electron/services/crmParseService'

let pass = 0, fail = 0
function ok(name: string, cond: boolean): void {
  if (cond) { pass++ } else { fail++; console.error('FAIL:', name) }
}

const ROOT = join(__dirname, '..')
const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

async function main(): Promise<void> {
  // ── A. 静态护栏 ────────────────────────────────────────────────────────────
  const parseSrc = readFileSync(join(ROOT, 'electron/services/crmParseService.ts'), 'utf8')
  const parseCode = strip(parseSrc)
  const engineSrc = readFileSync(join(ROOT, 'electron/services/salesActionEngine.ts'), 'utf8')
  const crmDbSrc = readFileSync(join(ROOT, 'electron/services/crmDbService.ts'), 'utf8')

  ok('A1 quote_asked 写入点存在（recordQuoteSignal 成功块后双写）', /recordCustomerEventSafe\(\{[^}]*event_type: 'quote_asked'/.test(parseCode))
  ok('A2 customer_replied 写入点存在（markQuoteReplied 后 closed > 0 才写）',
    /const closed = crmDbService\.markQuoteReplied/.test(parseCode) && /event_type: 'customer_replied'/.test(parseCode) && /if \(closed > 0\)/.test(parseCode))
  ok('A3 message_key 复用上游 canonical key 变量（不现场拼 key）',
    /message_key: key,/.test(parseCode) && !/message_key: \`\$\{uid/.test(parseCode))
  ok('A4 evidence_text 来自消息原话（textForSignal/content slice，非 AI 结论）',
    /evidence_text: textForSignal\.slice\(0, 200\)/.test(parseCode) && /evidence_text: content\.slice\(0, 200\)/.test(parseCode))
  ok('A5 写失败不阻断（recordCustomerEventSafe 有 try/catch + WARN，绝不抛）',
    /function recordCustomerEventSafe/.test(parseSrc) && /try \{/.test(parseSrc) && /salesLog\('WARN', `\[CrmParse\] customer_event 写入失败/.test(parseCode))
  // A6: E3.3 起 salesActionEngine 新增行动事件生产者 recordUserActionEvent（唯一 customerEventAdd 写入点），
  // R7 业务路径（其定义之前的 completeAction/completeUnifiedSignal 等）零直接事件引用——R7 逻辑未被事件生产污染
  const engineAddCount = (strip(engineSrc).match(/salesDbService\.customerEventAdd/g) || []).length
  const engineBeforeRecorder = strip(engineSrc).slice(0, strip(engineSrc).indexOf('export function recordUserActionEvent'))
  ok('A6 R7 不改（customerEventAdd 仅 1 处且在 recordUserActionEvent 内；R7 路径零直接引用）',
    engineAddCount === 1 && !/customerEventAdd|customerEventsBy|customer_event/.test(engineBeforeRecorder))
  ok('A7 recordQuoteSignal 内部无事件写（crmDbService 不被事件污染）', !/customerEvent|customer_event/.test(strip(crmDbSrc)))
  ok('A8 intent_tag_log 无新写点（crmParseService 不直接 intentCreate）', !/intentCreate/.test(parseCode))

  // ── B. 行为（temp 双库）───────────────────────────────────────────────────
  const dir = mkdtempSync(join(tmpdir(), 'cep-'))
  await Promise.all([salesDbService.initialize(dir), crmDbService.initialize(dir)])
  const NOW = Date.now()
  const KEY_QUOTE = 'canonical:db:message:quote1'
  const KEY_REPLY = 'canonical:db:message:reply1'

  // B9: 报价双写一致（quote_signal 新记录 + quote_asked 事件同 key）
  const wroteQuote = crmDbService.recordQuoteSignal({
    msgKey: KEY_QUOTE, sessionId: 'wx_cep_1', accountId: 0, displayName: '双写客户',
    amount: 88000, model: 'X8', quotedAt: NOW
  })
  recordCustomerEventSafe({
    session_id: 'wx_cep_1', event_type: 'quote_asked', message_key: KEY_QUOTE,
    evidence_text: '客户想了解 X8 价格', source: 'system',
    metadata: JSON.stringify({ amount: 88000, model: 'X8' })
  })
  const quoteRows = crmDbService.all('SELECT * FROM quote_signal WHERE msg_key = ?', [KEY_QUOTE])
  const qEvents = salesDbService.customerEventsByType('quote_asked')
  ok('B9 报价消息双写一致（quote_signal 一条 + quote_asked 事件一条同 key）',
    wroteQuote === true && quoteRows.length === 1 && qEvents.length === 1 && qEvents[0].message_key === KEY_QUOTE)

  // B10: 同 key 重复 → 双写各自幂等
  const wroteQuote2 = crmDbService.recordQuoteSignal({
    msgKey: KEY_QUOTE, sessionId: 'wx_cep_1', accountId: 0, displayName: '双写客户',
    amount: 88000, model: 'X8', quotedAt: NOW
  })
  recordCustomerEventSafe({
    session_id: 'wx_cep_1', event_type: 'quote_asked', message_key: KEY_QUOTE,
    evidence_text: '重复扫描', source: 'system'
  })
  ok('B10 同 key 重复 → 双写各自幂等（quote_signal 返回 false + 事件仍一条）',
    wroteQuote2 === false && salesDbService.customerEventsByType('quote_asked').length === 1)

  // B11: 客户回复 → quote_signal.customer_replied_at 更新 + customer_replied 事件
  const closed = crmDbService.markQuoteReplied('wx_cep_1', NOW + 3600_000)
  recordCustomerEventSafe({
    session_id: 'wx_cep_1', event_type: 'customer_replied', message_key: KEY_REPLY,
    evidence_text: '可以，报个价', source: 'system'
  })
  const replyRow = crmDbService.all('SELECT * FROM quote_signal WHERE msg_key = ?', [KEY_QUOTE])[0]
  const rEvents = salesDbService.customerEventsByType('customer_replied')
  ok('B11 客户回复 → quote_signal.customer_replied_at 更新 + customer_replied 事件',
    closed === 1 && Number(replyRow.customer_replied_at) > 0 && rEvents.length === 1 && rEvents[0].message_key === KEY_REPLY)

  // B12: 无未回复报价的客户消息 → closed=0 → 生产调用点被 if (closed > 0) 门控，不写 customer_replied
  // （事件写入只在 closed > 0 时发生——B11 已写一条，closed=0 后事件数保持不变）
  const closed2 = crmDbService.markQuoteReplied('wx_cep_1', NOW + 7200_000)
  ok('B12 无未回复报价的客户消息 → 不写 customer_replied（closed=0 门控，事件保持一条）',
    closed2 === 0 && salesDbService.customerEventsByType('customer_replied').length === 1)

  // B13: 事件写失败不阻断原链（helper 吞错 + 原逻辑仍成功）
  let helperThrew = false
  try {
    recordCustomerEventSafe({ session_id: 'wx_cep_1', event_type: 'stage_changed' as any, source: 'system' })
  } catch { helperThrew = true }
  const afterFail = crmDbService.recordQuoteSignal({
    msgKey: 'canonical:db:message:quote2', sessionId: 'wx_cep_1', accountId: 0, displayName: '双写客户',
    amount: 5000, model: null, quotedAt: NOW + 86400_000
  })
  ok('B13 事件写失败不阻断原链（helper 吞错不抛 + quote_signal 原逻辑仍成功）',
    helperThrew === false && afterFail === true)

  // B14: metadata 携带报价详情
  const qEvent = salesDbService.customerEventsByType('quote_asked')[0]
  ok('B14 metadata 携带报价详情（amount/model）',
    !!qEvent?.metadata && String(qEvent.metadata).includes('"amount":88000') && String(qEvent.metadata).includes('"model":"X8"'))

  console.log(`customer-event-producer-test: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main()
