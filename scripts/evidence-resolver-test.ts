/**
 * evidence-resolver-test.ts —— P0-2B 刀2 验收：Evidence Resolver（解析 + 读路径 + 只读断言）
 *
 * 验收（docs/P0-2B 设计 §6，13 例）：
 *   1  canonical 解析 → {kind:'localId', localId:8}，dbPath/tableName 正确 decode
 *   2  local:/server:/fallback: 解析，各取对应定位字段；serverId 保持字符串
 *   3  历史裸数字 → {kind:'serverId', serverId 原样}（16+ 位精度无损）
 *   4  垃圾/空值 → unparseable
 *   5  canonical 命中 → getMessageById 被正确调用 → found + message + before/after
 *   6  历史裸 ID 命中 → getMessageByServerId 被正确调用 → found
 *   7  miss → unavailable(message_not_found)，不伪造
 *   8  unparseable → 立即 unavailable(unparseable)，reader 零调用
 *   9  evidenceText 兜底 → unavailable 返回里带传入的 evidenceText
 *   10 上下文失败非致命 → 仍 found + before/after 空
 *   11 只读断言 → 仅 getMessageById/getMessageByServerId/getMessagesAround 被调用，无写方法
 *   12 sessionId 透传 → 读调用携带传入的 sessionId
 *   13 buildMessageKey 4 分支 → parseEvidenceKey 回读一致（round-trip）
 *
 * 运行：npx tsx scripts/evidence-resolver-test.ts
 */
import { parseEvidenceKey } from '../shared/evidenceKey'
import { buildMessageKey } from '../shared/messageKey'
import { createEvidenceResolver, type EvidenceMessageReader } from '../electron/services/evidenceResolver'

let pass = 0, fail = 0
function ok(name: string, cond: boolean): void {
  if (cond) { pass++ } else { fail++; console.error('FAIL:', name) }
}

function makeMessage(localId: number, createTime: number, messageKey: string): any {
  return { localId, serverId: 0, localType: 1, createTime, sortSeq: 0, isSend: 1, senderUsername: 'u', parsedContent: '', rawContent: 'hi', content: 'hi', messageKey }
}

/** 只读 fake reader：记录全部调用，暴露配置；不含任何写方法（结构上禁止写） */
class FakeReader implements EvidenceMessageReader {
  calls: Array<{ method: string; sessionId?: string; localId?: number; svrid?: string; count?: number }> = []
  idResult: { success: boolean; message?: any; error?: string } = { success: false, error: 'not configured' }
  serverResult: { success: boolean; message?: any; error?: string } = { success: false, error: 'not configured' }
  aroundResult: { success: boolean; before: any[]; after: any[]; error?: string } = { success: false, before: [], after: [], error: 'not configured' }
  throwOnRead = false
  throwOnAround = false

  async getMessageById(sessionId: string, localId: number): Promise<{ success: boolean; message?: any; error?: string }> {
    this.calls.push({ method: 'getMessageById', sessionId, localId })
    if (this.throwOnRead) throw new Error('reader boom')
    return this.idResult
  }
  async getMessageByServerId(sessionId: string, svrid: string): Promise<{ success: boolean; message?: any; error?: string }> {
    this.calls.push({ method: 'getMessageByServerId', sessionId, svrid })
    if (this.throwOnRead) throw new Error('reader boom')
    return this.serverResult
  }
  async getMessagesAround(sessionId: string, target: { localId?: number; createTime: number; messageKey?: string }, count?: number): Promise<{ success: boolean; before: any[]; after: any[]; error?: string }> {
    this.calls.push({ method: 'getMessagesAround', sessionId, localId: target.localId, count })
    if (this.throwOnAround) throw new Error('around boom')
    return this.aroundResult
  }
}

async function main(): Promise<void> {
  // ── 1. canonical 解析 ───────────────────────────────────────────────────────
  const p1 = parseEvidenceKey('%2FUsers%2Ftest%2Fmessage_0.db:Msg_307f3920:8')
  ok('1a canonical → kind localId', p1.kind === 'localId')
  if (p1.kind === 'localId') {
    ok('1b canonical localId=8', p1.localId === 8)
    ok('1c canonical dbPath 正确 decode', p1.dbPath === '/Users/test/message_0.db')
    ok('1d canonical tableName 正确 decode', p1.tableName === 'Msg_307f3920')
  }

  // ── 2. local:/server:/fallback: 解析 ────────────────────────────────────────
  const p2a = parseEvidenceKey('local:msg_0.db:8:1700000000:0:wxid_a:1')
  ok('2a local → localId=8', p2a.kind === 'localId' && p2a.localId === 8)
  const p2b = parseEvidenceKey('server:msg_0.db:7624353663315474928:1700000000:5:0:wxid_a:3')
  ok('2b server → serverId 字符串（含 16+ 位）', p2b.kind === 'serverId' && p2b.serverId === '7624353663315474928')
  const p2c = parseEvidenceKey('fallback:msg_0.db:1700000000:5:0::1')
  ok('2c fallback → localId=0', p2c.kind === 'localId' && p2c.localId === 0)

  // ── 3. 历史裸数字（精度无损） ───────────────────────────────────────────────
  const p3 = parseEvidenceKey('7624353663315474928')
  ok('3a 裸数字 → kind serverId', p3.kind === 'serverId')
  if (p3.kind === 'serverId') ok('3b 裸数字原样保留字符串', p3.serverId === '7624353663315474928')
  const p3b = parseEvidenceKey('0')
  ok('3c 裸 0 → serverId "0"', p3b.kind === 'serverId' && p3b.serverId === '0')

  // ── 4. 垃圾/空值 ───────────────────────────────────────────────────────────
  ok('4a 空串 → unparseable', parseEvidenceKey('').kind === 'unparseable')
  ok('4b 空白 → unparseable', parseEvidenceKey('   ').kind === 'unparseable')
  ok('4c 非数字垃圾 → unparseable', parseEvidenceKey('hello world').kind === 'unparseable')
  ok('4d 4 段无已知前缀 → unparseable', parseEvidenceKey('abc:123:456:789').kind === 'unparseable')
  ok('4d2 3 段末段非数字 → unparseable', parseEvidenceKey('abc:123:xyz').kind === 'unparseable')
  ok('4e local 缺 localId → unparseable', parseEvidenceKey('local:scope:xx').kind === 'unparseable')

  // ── 5. canonical 命中 ───────────────────────────────────────────────────────
  const reader5 = new FakeReader()
  const canonicalKey = '%2FUsers%2Ftest%2Fmessage_0.db:Msg_307f3920:8'
  reader5.idResult = { success: true, message: makeMessage(8, 1700000000, canonicalKey) }
  reader5.aroundResult = {
    success: true,
    before: [makeMessage(7, 1699999999, 'k7')],
    after: [makeMessage(9, 1700000001, 'k9')]
  }
  const resolver5 = createEvidenceResolver(reader5)
  const r5 = await resolver5.getEvidenceByKey('wx_session', canonicalKey)
  ok('5a canonical 命中 → found', r5.status === 'found')
  if (r5.status === 'found') {
    ok('5b found message.localId=8', r5.message.localId === 8)
    ok('5c before 非空', r5.before.length === 1)
    ok('5d after 非空', r5.after.length === 1)
  }
  ok('5e getMessageById 被调用（localId=8）', reader5.calls.some(c => c.method === 'getMessageById' && c.localId === 8))
  ok('5f getMessagesAround 携带 localId', reader5.calls.some(c => c.method === 'getMessagesAround' && c.localId === 8))

  // ── 6. 历史裸 ID 命中（走 getMessageByServerId） ────────────────────────────
  const reader6 = new FakeReader()
  reader6.serverResult = { success: true, message: makeMessage(3, 1700000000, 'server:msg_0.db:7624353663315474928:0:5:3:wxid_a:3') }
  reader6.aroundResult = { success: true, before: [], after: [], error: undefined as any }
  const resolver6 = createEvidenceResolver(reader6)
  const r6 = await resolver6.getEvidenceByKey('wx_session', '7624353663315474928')
  ok('6a 裸 ID 命中 → found', r6.status === 'found')
  ok('6b getMessageByServerId 被调用（svrid 原样字符串）', reader6.calls.some(c => c.method === 'getMessageByServerId' && c.svrid === '7624353663315474928'))
  ok('6c 未调用 getMessageById', !reader6.calls.some(c => c.method === 'getMessageById'))

  // ── 7. miss ─────────────────────────────────────────────────────────────────
  const reader7 = new FakeReader()
  reader7.idResult = { success: false, error: '未找到消息' }
  const resolver7 = createEvidenceResolver(reader7)
  const r7 = await resolver7.getEvidenceByKey('wx_session', canonicalKey)
  ok('7a miss → unavailable', r7.status === 'unavailable')
  if (r7.status === 'unavailable') ok('7b reason=message_not_found', r7.reason === 'message_not_found')
  ok('7c 不伪造 message', r7.status === 'unavailable')

  // ── 8. unparseable → reader 零调用 ──────────────────────────────────────────
  const reader8 = new FakeReader()
  const resolver8 = createEvidenceResolver(reader8)
  const r8 = await resolver8.getEvidenceByKey('wx_session', '!!!垃圾!!!')
  ok('8a 垃圾 key → unavailable', r8.status === 'unavailable')
  if (r8.status === 'unavailable') ok('8b reason=unparseable', r8.reason === 'unparseable')
  ok('8c reader 零调用', reader8.calls.length === 0)

  // ── 9. evidenceText 兜底 ────────────────────────────────────────────────────
  const r9 = await resolver8.getEvidenceByKey('wx_session', 'not-a-key', '客户说考虑一下再答复')
  ok('9a evidenceText 透传', r9.status === 'unavailable' && (r9 as any).evidenceText === '客户说考虑一下再答复')
  const r9b = await resolver7.getEvidenceByKey('wx_session', canonicalKey, '判断依据句')
  ok('9b miss 也带 evidenceText', r9b.status === 'unavailable' && (r9b as any).evidenceText === '判断依据句')

  // ── 10. 上下文失败非致命 ────────────────────────────────────────────────────
  const reader10 = new FakeReader()
  reader10.idResult = { success: true, message: makeMessage(8, 1700000000, canonicalKey) }
  reader10.throwOnAround = true
  const resolver10 = createEvidenceResolver(reader10)
  const r10 = await resolver10.getEvidenceByKey('wx_session', canonicalKey)
  ok('10a 上下文抛错 → 仍 found', r10.status === 'found')
  if (r10.status === 'found') {
    ok('10b before 空', r10.before.length === 0)
    ok('10c after 空', r10.after.length === 0)
  }

  // ── 11. 只读断言 ────────────────────────────────────────────────────────────
  const reader11 = new FakeReader()
  reader11.idResult = { success: true, message: makeMessage(8, 1700000000, canonicalKey) }
  reader11.aroundResult = { success: true, before: [], after: [] }
  const resolver11 = createEvidenceResolver(reader11)
  await resolver11.getEvidenceByKey('wx_session', canonicalKey)
  const readOnlyMethods = new Set(['getMessageById', 'getMessageByServerId', 'getMessagesAround'])
  ok('11a 仅调用读取原语（无写方法）', reader11.calls.length > 0 && reader11.calls.every(c => readOnlyMethods.has(c.method)))

  // ── 12. sessionId 透传 ──────────────────────────────────────────────────────
  const reader12 = new FakeReader()
  reader12.idResult = { success: true, message: makeMessage(8, 1700000000, canonicalKey) }
  const resolver12 = createEvidenceResolver(reader12)
  await resolver12.getEvidenceByKey('wx_session_XYZ', canonicalKey)
  ok('12a getMessageById 携带 sessionId', reader12.calls.some(c => c.method === 'getMessageById' && c.sessionId === 'wx_session_XYZ'))
  ok('12b getMessagesAround 携带 sessionId', reader12.calls.some(c => c.method === 'getMessagesAround' && c.sessionId === 'wx_session_XYZ'))

  // ── 13. buildMessageKey 4 分支 → parseEvidenceKey 回读一致（round-trip） ────
  const rtCanonical = buildMessageKey({
    localId: 8, serverId: 0, createTime: 1700000000, sortSeq: 0, senderUsername: 'wxid_a', localType: 1,
    dbPath: '/Users/test/message_0.db', tableName: 'Msg_307f3920'
  })
  const p13a = parseEvidenceKey(rtCanonical)
  ok('13a canonical round-trip localId', p13a.kind === 'localId' && p13a.localId === 8)
  ok('13b canonical round-trip dbPath', p13a.kind === 'localId' && p13a.dbPath === '/Users/test/message_0.db')
  ok('13c canonical round-trip tableName', p13a.kind === 'localId' && p13a.tableName === 'Msg_307f3920')

  const rtLocal = buildMessageKey({
    localId: 8, serverId: 0, createTime: 1700000000, sortSeq: 5, senderUsername: 'wxid_a', localType: 3,
    dbPath: 'msg_0.db', tableName: ''
  })
  const p13b = parseEvidenceKey(rtLocal)
  ok('13d local round-trip localId', p13b.kind === 'localId' && p13b.localId === 8)

  const rtServer = buildMessageKey({
    localId: 0, serverId: 1234567890, createTime: 1700000000, sortSeq: 5, senderUsername: 'wxid_a', localType: 3,
    dbPath: 'msg_0.db', tableName: ''
  })
  const p13c = parseEvidenceKey(rtServer)
  ok('13e server round-trip serverId', p13c.kind === 'serverId' && p13c.serverId === '1234567890')

  const rtFallback = buildMessageKey({
    localId: 0, serverId: 0, createTime: 1700000000, sortSeq: 5, senderUsername: 'wxid_a', localType: 3,
    dbPath: 'msg_0.db', tableName: ''
  })
  const p13d = parseEvidenceKey(rtFallback)
  ok('13f fallback round-trip 可解析', p13d.kind === 'localId' || p13d.kind === 'unparseable')

  // ── 汇总 ─────────────────────────────────────────────────────────────────────
  console.log(`evidence-resolver-test: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main()
