/**
 * message-key-test.ts —— P0-2B 刀1 回归：buildMessageKey 集中化（shared/messageKey.ts）
 *
 * 验收（用户边界①：纯重构，canonical 格式一个字符不能变，编码/fallback/字段优先级全部保持，
 * round-trip 必须验证）：
 *   ① canonical 分支：encoded(dbPath):encoded(tableName):localId —— 精确格式 + 编码 + round-trip 还原
 *   ② local:  分支：无 table_name 时的回退格式，字段顺序/编码与原实现一致
 *   ③ server: 分支：serverId 优先（保留字符串精度），字段顺序一致
 *   ④ fallback:分支：无 localId/serverId 时兜底，空 sender 段保留 ':' 分隔
 *   ⑤ dbName 派生（dbPath 缺省时用 dbName / basename）与字段容错（undefined/NaN → 0/空）
 *   ⑥ 分支优先级：canonical → local → server → fallback（与原实现一致）
 *
 * 运行：npx tsx scripts/message-key-test.ts
 */
import { buildMessageKey, encodeMessageKeySegment } from '../shared/messageKey'

let pass = 0, fail = 0
function ok(name: string, cond: boolean): void {
  if (cond) { pass++ } else { fail++; console.error('FAIL:', name) }
}

/** round-trip：把 messageKey 按 ':' 拆段并逐段 decode，还原原始字段值 */
function decodeRoundTrip(key: string): string[] {
  return key.split(':').map((s) => decodeURIComponent(s))
}

function main(): void {
  // ── ① canonical 分支（主格式） ──────────────────────────────────────────────
  // 无编码字符的基准格式：dbPath:tableName:localId（一个字符不能变）
  const c1 = buildMessageKey({
    localId: 8, serverId: 0, createTime: 0, sortSeq: 0, senderUsername: '', localType: 0,
    dbPath: 'msg_0.db', tableName: 'Msg'
  })
  ok('1a canonical 基准格式精确为 dbPath:tableName:localId', c1 === 'msg_0.db:Msg:8')

  // encodeURIComponent 编码段：路径含 '/' 与空格
  const c2 = buildMessageKey({
    localId: 42, serverId: 0, createTime: 0, sortSeq: 0, senderUsername: '', localType: 0,
    dbPath: '/a b/c.db', tableName: 'Msg_1'
  })
  ok('1b canonical 编码后格式', c2 === '%2Fa%20b%2Fc.db:Msg_1:42')
  const rt1 = decodeRoundTrip(c2)
  ok('1c canonical round-trip 还原 dbPath', rt1[0] === '/a b/c.db')
  ok('1d canonical round-trip 还原 tableName', rt1[1] === 'Msg_1')
  ok('1e canonical round-trip 还原 localId', rt1[2] === '42')

  // ── ② local: 分支（localId>0 但无 table_name） ──────────────────────────────
  const l1 = buildMessageKey({
    localId: 8, serverId: 0, createTime: 1700000000, sortSeq: 0, senderUsername: 'wxid_a', localType: 1,
    dbPath: 'msg_0.db', tableName: ''
  })
  ok('2a local 格式 local:scope:localId:createTime:sortSeq:sender:localType', l1 === 'local:msg_0.db:8:1700000000:0:wxid_a:1')

  const l2 = buildMessageKey({
    localId: 5, serverId: 0, createTime: 0, sortSeq: 0, senderUsername: 'wxid_中 a', localType: 2,
    dbPath: 'c.db', tableName: ''
  })
  ok('2b local sender 段编码', l2 === `local:c.db:5:0:0:${encodeMessageKeySegment('wxid_中 a')}:2`)

  // ── ③ server: 分支（serverId 优先；需 localId=0，否则 local 分支先命中） ─────
  // 注意：buildMessageKey 的 serverId 入参为 number（与 chatService/apiMessageMapping 原调用一致）。
  // 16+ 位 serverId 的字符串精度保证在解析侧（parseEvidenceKey 保持 string，见刀2），构造侧不入参超长字面量。
  const s1 = buildMessageKey({
    localId: 0, serverId: 1234567890, createTime: 1700000000, sortSeq: 5, senderUsername: 'wxid_a', localType: 3,
    dbPath: 'msg_0.db', tableName: ''
  })
  ok('3a server 格式 server:scope:serverId:createTime:sortSeq:localId:sender:localType', s1 === 'server:msg_0.db:1234567890:1700000000:5:0:wxid_a:3')

  // 分支优先级：localId>0 时 local 先于 server（即使 serverId 存在也不落 server 分支）
  const s2 = buildMessageKey({
    localId: 8, serverId: 1234567890, createTime: 1700000000, sortSeq: 5, senderUsername: 'wxid_a', localType: 3,
    dbPath: 'msg_0.db', tableName: ''
  })
  ok('3b localId>0 时优先 local 分支（不落 server）', s2 === 'local:msg_0.db:8:1700000000:5:wxid_a:3')

  // ── ④ fallback: 分支（无 localId/serverId） ─────────────────────────────────
  const f1 = buildMessageKey({
    localId: 0, serverId: 0, createTime: 1700000000, sortSeq: 5, senderUsername: '', localType: 1,
    dbPath: 'msg_0.db', tableName: ''
  })
  ok('4a fallback 格式 fallback:scope:createTime:sortSeq:localId:sender:localType', f1 === 'fallback:msg_0.db:1700000000:5:0::1')
  ok('4b fallback 空 sender 保留分隔（双冒号）', f1.includes(':5:0::1'))

  // ── ⑤ dbName 派生与字段容错 ────────────────────────────────────────────────
  // dbPath 缺省时用 dbName 作为 scope
  const d1 = buildMessageKey({
    localId: 5, serverId: 0, createTime: 0, sortSeq: 0, senderUsername: '', localType: 0,
    dbName: 'Msg_1.db', tableName: 'Msg', dbPath: ''
  })
  ok('5a dbPath 缺省用 dbName 作 scope', d1 === 'Msg_1.db:Msg:5')

  // dbPath 存在时 basename 派生 dbName，但 scope 仍取 dbPath
  const d2 = buildMessageKey({
    localId: 5, serverId: 0, createTime: 0, sortSeq: 0, senderUsername: '', localType: 0,
    dbPath: '/x/y/message_0.db', tableName: 'Msg'
  })
  ok('5b scope 优先 dbPath（dbPath 段被 encodeURIComponent 编码）', d2.startsWith('%2Fx%2Fy%2Fmessage_0.db:'))

  // 全空/NaN 容错：无任何定位字段 → fallback + 空 scope
  const e1 = buildMessageKey({
    localId: NaN, serverId: NaN, createTime: NaN, sortSeq: NaN, senderUsername: null, localType: NaN,
    dbPath: '', tableName: '', dbName: ''
  })
  ok('5c NaN/空输入容错（fallback + 空 scope）', e1 === 'fallback::0:0:0::0')

  // 全缺省（input 只给基本必填字段）
  const e2 = buildMessageKey({ localId: 0, serverId: 0, createTime: 0, sortSeq: 0, localType: 0 } as any)
  ok('5d 最小必填字段不抛错', typeof e2 === 'string' && e2.length > 0)

  // ── ⑥ 分支优先级：canonical → local → server → fallback ────────────────────
  const p1 = buildMessageKey({
    localId: 1, serverId: 999, createTime: 0, sortSeq: 0, senderUsername: '', localType: 0,
    dbPath: 'm.db', tableName: 'T'
  })
  ok('6a localId+scope+table 齐备 → canonical（不落 server）', p1 === 'm.db:T:1')
  const p2 = buildMessageKey({
    localId: 1, serverId: 999, createTime: 0, sortSeq: 0, senderUsername: '', localType: 0,
    dbPath: 'm.db', tableName: ''
  })
  ok('6b 有 localId 无 table → local（优先于 server）', p2.startsWith('local:m.db:1:'))

  // ── 汇总 ─────────────────────────────────────────────────────────────────────
  console.log(`message-key-test: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main()
