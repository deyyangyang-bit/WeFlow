/**
 * central-sync-client-test.ts —— Phase 3a 中央 HTTP 客户端（electron/services/centralSyncClient.ts）验证。
 *
 * 覆盖：
 *   A. 传输约束：HTTPS 强制、仅 localhost 开发态允许 HTTP、地址归一
 *   B. 认证：Bearer 凭证、无凭证时拒绝发起请求、health 不需要凭证
 *   C. 失败语义：超时（E408）、非 2xx、ok=false、响应非法 JSON
 *   D. 令牌不外泄：错误信息、请求头之外的载荷都不含明文令牌
 *   E. 端点契约：claim / rotate / push / pull / ack / revokeSelf 的方法、路径、请求体
 *
 * 全部走注入的假 fetch，**不发真实网络请求**（测试规范）。
 * 运行：npx tsx scripts/central-sync-client-test.ts
 */
import { CentralSyncClient, CentralSyncHttpError } from '../electron/services/centralSyncClient'

let pass = 0
let fail = 0
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; console.log(`  ✅ ${name}`) } else { fail++; console.log(`  ❌ ${name} ${detail}`) }
}

interface Call { url: string; method: string; headers: Record<string, string>; body: unknown }

/** 记录调用并返回预设响应的假 fetch */
function fakeFetch(responder: (call: Call) => { status: number; body: unknown; raw?: string }): { impl: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((value, key) => { headers[key.toLowerCase()] = value })
    const call: Call = {
      url: String(input), method: String(init?.method || 'GET'), headers,
      body: init?.body ? JSON.parse(String(init.body)) : undefined
    }
    calls.push(call)
    const result = responder(call)
    const text = result.raw !== undefined ? result.raw : JSON.stringify(result.body)
    return new Response(text, { status: result.status, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return { impl, calls }
}

function throws(fn: () => Promise<unknown>): Promise<unknown> {
  return fn().then(() => null, (error: unknown) => error)
}

const TOKEN = 'device-token-abcdefghijklmnopqrstuvwxyz-0123456789'
const BASE = 'https://weflow.internal'

async function main(): Promise<void> {
  console.log('═══ A. 传输约束 ═══')
  const httpsErr = await throws(async () => new CentralSyncClient({ baseUrl: 'http://weflow.internal', token: TOKEN }))
  ok('A1 生产地址用 HTTP → 构造即拒绝', httpsErr instanceof Error && /HTTPS/.test(httpsErr.message), String(httpsErr))
  ok('A2 http://127.0.0.1 开发态放行',
    new CentralSyncClient({ baseUrl: 'http://127.0.0.1:8787', token: TOKEN }).constructor === CentralSyncClient)
  ok('A3 http://localhost 开发态放行',
    new CentralSyncClient({ baseUrl: 'http://localhost:8787', token: TOKEN }).constructor === CentralSyncClient)
  const localErr = await throws(async () => new CentralSyncClient({ baseUrl: 'http://192.168.1.10:8787', token: TOKEN }))
  ok('A4 内网明文 HTTP 一律拒绝（只允许本机回环例外）', localErr instanceof Error && /HTTPS/.test(localErr.message))

  const { impl, calls } = fakeFetch(() => ({ status: 200, body: { ok: true, data: { service: 'weflow-central', protocolVersion: 1 } } }))
  const client = new CentralSyncClient({ baseUrl: `${BASE}/`, token: TOKEN, fetchImpl: impl })
  await client.health()
  ok('A5 基地址尾部斜杠归一（不产生 //health）', calls[0]!.url === `${BASE}/health`, calls[0]!.url)

  console.log('═══ B. 认证 ═══')
  ok('B1 health 为公开端点，不带 authorization', !calls[0]!.headers.authorization)
  await client.pull(0)
  ok('B2 业务端点带 Bearer 令牌', calls[1]!.headers.authorization === `Bearer ${TOKEN}`)
  const noToken = new CentralSyncClient({ baseUrl: BASE, fetchImpl: impl })
  const noTokenErr = await throws(async () => noToken.pull(0))
  ok('B3 未绑定设备拒绝发起业务请求（本地即拦，不发空凭证请求）',
    noTokenErr instanceof Error && /凭证未配置/.test(noTokenErr.message), String(noTokenErr))
  ok('B4 未绑定设备确实没有发出请求', calls.length === 2)

  console.log('═══ C. 失败语义 ═══')
  const { impl: e500, calls: c500 } = fakeFetch(() => ({ status: 500, body: { ok: false, code: 'E500', message: '内部错误' } }))
  const c500client = new CentralSyncClient({ baseUrl: BASE, token: TOKEN, fetchImpl: e500 })
  const err500 = await throws(async () => c500client.pull(0)) as CentralSyncHttpError
  ok('C1 非 2xx → CentralSyncHttpError(500, E500)',
    err500 instanceof CentralSyncHttpError && err500.status === 500 && err500.code === 'E500', String(err500))
  ok('C2 非 2xx 请求只发一次（不自动重试，重试由调度器控制）', c500.length === 1)

  const { impl: e403 } = fakeFetch(() => ({ status: 403, body: { ok: false, code: 'E403', message: '无权执行该操作' } }))
  const err403 = await throws(async () => new CentralSyncClient({ baseUrl: BASE, token: TOKEN, fetchImpl: e403 }).push([], 'k')) as CentralSyncHttpError
  ok('C3 403 语义可区分（权限不足 vs 网络故障）', err403.code === 'E403' && err403.status === 403)

  const { impl: badJson } = fakeFetch(() => ({ status: 200, body: null, raw: '<html>gateway</html>' }))
  const badErr = await throws(async () => new CentralSyncClient({ baseUrl: BASE, token: TOKEN, fetchImpl: badJson }).pull(0))
  ok('C4 响应非 JSON（反代 HTML 错误页）→ 明确失败而不是静默空结果',
    badErr instanceof CentralSyncHttpError, String(badErr))

  const { impl: okFalse } = fakeFetch(() => ({ status: 200, body: { ok: false, code: 'E409', message: '邀请码已使用' } }))
  const okFalseErr = await throws(async () => new CentralSyncClient({ baseUrl: BASE, fetchImpl: okFalse }).claim('x', 'y')) as CentralSyncHttpError
  ok('C5 HTTP 200 但 ok=false 仍判失败（不把业务失败当成功）', okFalseErr.code === 'E409')

  const slow = (async (_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      const error = new Error('aborted')
      error.name = 'AbortError'
      reject(error)
    })
  })) as unknown as typeof fetch
  const timeoutErr = await throws(async () => new CentralSyncClient({ baseUrl: BASE, token: TOKEN, timeoutMs: 1000, fetchImpl: slow }).pull(0)) as CentralSyncHttpError
  ok('C6 超时 → E408 且状态可区分（不当作业务失败）', timeoutErr.code === 'E408' && timeoutErr.status === 408, String(timeoutErr))

  console.log('═══ D. 令牌不外泄 ═══')
  const leaked = [String(err500), String(err403), String(badErr), String(timeoutErr), String(noTokenErr)].join('|')
  ok('D1 错误信息中不含设备令牌明文', !leaked.includes(TOKEN))
  const { impl: echo, calls: echoCalls } = fakeFetch((call) => ({ status: 200, body: { ok: true, data: { ok: true, seen: call } } }))
  await new CentralSyncClient({ baseUrl: BASE, token: TOKEN, fetchImpl: echo }).pull(0)
  const sent = JSON.stringify(echoCalls[0]!.body ?? null)
  ok('D2 GET 拉取不把令牌塞进 URL 或查询串（只在请求头）', !echoCalls[0]!.url.includes(TOKEN) && !sent.includes(TOKEN))

  console.log('═══ E. 端点契约 ═══')
  const { impl: rec, calls: recCalls } = fakeFetch((call) => {
    if (call.url.endsWith('/api/v1/bindings/claim')) return { status: 201, body: { ok: true, data: { deviceToken: 't-new', principal: { workspaceId: 'w', employeeId: 'e', deviceId: 'd', displayName: '张三', role: 'sales' } } } }
    if (call.url.endsWith('/api/v1/devices/rotate')) return { status: 200, body: { ok: true, data: { deviceToken: 't-rotated' } } }
    if (call.url.endsWith('/api/v1/devices/revoke-self')) return { status: 200, body: { ok: true, data: { revoked: true } } }
    if (call.url.includes('/api/v1/sync/push')) return { status: 200, body: { ok: true, data: { accepted: [{ eventId: 'e1', centralSeq: 1, duplicate: false }], rejected: [] } } }
    if (call.url.includes('/api/v1/sync/pull')) return { status: 200, body: { ok: true, data: { events: [], nextCursor: 3, hasMore: false } } }
    if (call.url.endsWith('/api/v1/sync/ack')) return { status: 200, body: { ok: true, data: { acknowledged: 1 } } }
    return { status: 404, body: { ok: false, code: 'E404', message: 'not found' } }
  })
  const rc = new CentralSyncClient({ baseUrl: BASE, fetchImpl: rec })
  const claimed = await rc.claim('invite-1', '销售甲机')
  ok('E1 claim：匿名 POST /bindings/claim，回写设备令牌与 principal',
    recCalls[0]!.url === `${BASE}/api/v1/bindings/claim` && recCalls[0]!.method === 'POST' &&
    !recCalls[0]!.headers.authorization && claimed.principal.role === 'sales')
  const rotated = await rc.rotateToken()
  ok('E2 rotate：POST /devices/rotate 且用旧令牌认证',
    recCalls[1]!.url === `${BASE}/api/v1/devices/rotate` && recCalls[1]!.headers.authorization === 'Bearer t-new' && rotated === 't-rotated')
  const p = await rc.pull(7, 100)
  ok('E3 pull：GET 带 cursor/limit，游标原样解析',
    recCalls[2]!.url === `${BASE}/api/v1/sync/pull?cursor=7&limit=100` && p.nextCursor === 3)
  ok('E4 rotate 后自动使用新令牌',
    recCalls[2]!.headers.authorization === 'Bearer t-rotated')
  await rc.ack([{ centralSeq: 1, eventId: 'e1', outcome: 'applied' }])
  ok('E5 ack：POST /sync/ack，请求体带 outcomes',
    recCalls[3]!.url === `${BASE}/api/v1/sync/ack` &&
    JSON.stringify(recCalls[3]!.body) === JSON.stringify({ acknowledgements: [{ centralSeq: 1, eventId: 'e1', outcome: 'applied' }] }))
  await rc.push([{ protocolVersion: 1, eventId: 'e1', eventSeq: 1, idempotencyKey: 'k1', direction: 'up', entityType: 'customer', entityId: 'c1', eventType: 'customer_projected', aggregateVersion: 1, payload: { displayName: 'X' }, occurredAt: 1 }], 'batch-1')
  ok('E6 push：POST /sync/push 带 Idempotency-Key 头',
    recCalls[4]!.url === `${BASE}/api/v1/sync/push` && recCalls[4]!.headers['idempotency-key'] === 'batch-1')
  const revoked = await rc.revokeSelf()
  ok('E7 revokeSelf：POST /devices/revoke-self，返回吊销确认',
    recCalls[5]!.url === `${BASE}/api/v1/devices/revoke-self` && recCalls[5]!.method === 'POST' && revoked === true)

  console.log(`\ncentral sync client test: ${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

void main()
