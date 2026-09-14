/**
 * message-push-session-type-test.ts —— 消息推送「会话类型分类」回归（2026-09-14 真 bug 修复）
 *
 * 背景：`getSessionType` 原按 `session.type === 'official' / 'friend'` 判断会话类型，但
 * `ChatSession.type` 是 chatService.getSessions 对 WCDB Session 表原始列做 `parseInt` 得到的
 * **数值**（chatService.ts:27 `type: number`；:974 / :1176 `parseInt(row.type || '0', 10)`）。
 * `String(parseInt(x))` 只可能是数字串或 'NaN'，永不等于 'official'/'friend'，两个分支恒不成立：
 *   ① 单聊被报成 'other'（SSE 推送 payload.sessionType 错）；
 *   ② `shouldScanMessageBackedSession` 的「单聊不进消息表兜底扫描」静默失效。
 * 修法：改为只看 sessionId 形态，与 httpService.getApiSessionType 同口径（其 'channel' 归 'other'）。
 *
 * 隔离：WEFLOW_WORKER='1' + /tmp 配置目录（同 claimed-24h-classification-test 模式）。
 * 运行：npx tsx scripts/message-push-session-type-test.ts
 */
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const isoDir = mkdtempSync(join(tmpdir(), 'msg-push-type-'))
process.env.WEFLOW_WORKER = '1'
process.env.WEFLOW_USER_DATA_PATH = isoDir
process.env.WEFLOW_CONFIG_CWD = isoDir

import { messagePushService } from '../electron/services/messagePushService'
import type { ChatSession } from '../electron/services/chatService'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++ } else { fail++; console.error(`  ❌ ${name} ${detail}`) }
}

/** 私有方法在运行期是普通属性，按名取用（只测分类口径，不触达推送链路） */
type PrivateApi = {
  getSessionType(sessionId: string): 'private' | 'group' | 'official' | 'other'
  shouldScanMessageBackedSession(
    previous: { lastTimestamp: number; unreadCount: number } | undefined,
    session: ChatSession
  ): boolean
}
const api = messagePushService as unknown as PrivateApi

/** 造一个最小会话（type 是数值列，这里给真实 parseInt 的产物） */
function session(partial: Partial<ChatSession>): ChatSession {
  return {
    username: '', type: 0, unreadCount: 0, summary: '',
    sortTimestamp: 0, lastTimestamp: 0, lastMsgType: 0, ...partial
  }
}

function main(): void {
  const src = readFileSync(join(__dirname, '..', 'electron/services/messagePushService.ts'), 'utf8')

  console.log('\n═══ A. getSessionType：按 sessionId 形态分类 ═══')
  ok('A1 群聊 xxx@chatroom → group', api.getSessionType('12345678@chatroom') === 'group')
  ok('A2 公众号 gh_xxx → official', api.getSessionType('gh_abc123def') === 'official')
  ok('A3 单聊 wxid_xxx → private（修复前恒为 other）', api.getSessionType('wxid_wen24wq8ojio22_92a6') === 'private')
  ok('A4 自定义微信号单聊 → private（修复前恒为 other）', api.getSessionType('zhangsan') === 'private')
  ok('A5 企业 openim → other', api.getSessionType('xx@openim') === 'other')
  ok('A6 weixin* 服务通道 → other', api.getSessionType('weixingongzhonghao') === 'other')
  ok('A7 裸 weixin → private（与 getApiSessionType 同口径；上游 shouldKeepSession 已将其挡在会话列表外）',
    api.getSessionType('weixin') === 'private')
  ok('A8 空/空白 sessionId → other', api.getSessionType('') === 'other' && api.getSessionType('   ') === 'other')
  ok('A9 大小写不敏感（GH_/CHATROOM）',
    api.getSessionType('GH_ABC123') === 'official' && api.getSessionType('123@CHATROOM') === 'group')

  console.log('\n═══ B. 死路成因与防回退锁（静态）═══')
  ok('B1 反证：String(数值 type) 与 official/friend 比较对任何数值恒为 false',
    [0, 1, 2, 5, 1000].every((t) => String(t) !== 'official' && String(t) !== 'friend'))
  ok('B2 源码不再出现 session.type 与字符串比较（防回退）', !/session\.type\s*===\s*'/.test(src))
  ok('B3 getSessionType 只按 sessionId 分类（单参签名）',
    /private getSessionType\(sessionId: string\): MessagePushPayload\['sessionType'\]/.test(src))
  ok('B4 无双参旧调用残留', !/getSessionType\([^)]*,\s*session\)/.test(src))

  console.log('\n═══ C. shouldScanMessageBackedSession：单聊跳过分支修复后生效 ═══')
  const prev = { lastTimestamp: 100, unreadCount: 0 }
  ok('C1 单聊（普通摘要）不进消息表兜底扫描',
    api.shouldScanMessageBackedSession(undefined, session({ username: 'wxid_a', lastTimestamp: 200 })) === false)
  ok('C2 单聊有基线也不进兜底扫描',
    api.shouldScanMessageBackedSession(prev, session({ username: 'wxid_a', lastTimestamp: 200 })) === false)
  ok('C3 单聊 + 撤回摘要 → 放行（撤回推送依赖它）',
    api.shouldScanMessageBackedSession(undefined, session({ username: 'wxid_a', lastTimestamp: 200, summary: '对方撤回了一条消息' })) === true)
  ok('C4 单聊 + lastMsgType=10002（撤回）→ 放行',
    api.shouldScanMessageBackedSession(undefined, session({ username: 'wxid_a', lastTimestamp: 200, lastMsgType: 10002 })) === true)
  ok('C5 自定义微信号单聊同样跳过',
    api.shouldScanMessageBackedSession(undefined, session({ username: 'zhangsan', lastTimestamp: 200 })) === false)
  ok('C6 群会话有 lastTimestamp → 放行',
    api.shouldScanMessageBackedSession(undefined, session({ username: '123@chatroom', lastTimestamp: 200 })) === true)
  ok('C7 折叠占位会话一律排除',
    api.shouldScanMessageBackedSession(undefined, session({ username: 'placeholder_foldgroup', lastTimestamp: 200 })) === false)
  ok('C8 空 sessionId 排除', api.shouldScanMessageBackedSession(undefined, session({ username: '' })) === false)

  console.log('\n═══ D. 口径对齐 httpService.getApiSessionType（静态）═══')
  const httpSrc = readFileSync(join(__dirname, '..', 'electron/services/httpService.ts'), 'utf8')
  const apiTypeSrc = httpSrc.slice(httpSrc.indexOf('private getApiSessionType'), httpSrc.indexOf('private getApiSessionType') + 700)
  ok('D1 两处分类用同一组形态判据（@chatroom / gh_ / @openim / weixin*）',
    apiTypeSrc.includes("endsWith('@chatroom')") && apiTypeSrc.includes("startsWith('gh_')") &&
    apiTypeSrc.includes("includes('@openim')") && apiTypeSrc.includes("startsWith('weixin')"))

  console.log(`\nmessage-push-session-type-test: ${pass}/${pass + fail} 通过`)
  process.exit(fail > 0 ? 1 : 0)
}

main()
