/**
 * wecom-push-test.ts —— 企业微信群机器人推送单测
 * 覆盖：
 *  a. 载荷格式：POST JSON { msgtype:'text', text:{ content } }，content 原样透传
 *  b. errcode=0 判成功；errcode!==0 判失败（回显 errcode/errmsg）
 *  c. 非 JSON 响应 → 「响应解析失败」
 *  d. 超时处理：服务端不响应 → 按 timeoutMs 判「请求超时」
 *  e. 未配置（空/空白 webhook）时静默跳过：不发网络请求、不报错
 *  f. 非法输入：无法解析的 URL / 非 http(s) 协议 → 显式报错
 * HTTP 全部走本地 mock server（127.0.0.1 随机端口），不真发外网。
 * 运行：npx tsx scripts/wecom-push-test.ts
 */
import http from 'http'
import type { AddressInfo } from 'net'

// 隔离落盘路径（insightService 间接依赖 config，必须在 import 前设置，与 insight-dedup-test 同口径）
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
const isoDir = mkdtempSync(join(tmpdir(), 'wecom-push-'))
process.env.WEFLOW_USER_DATA_PATH = isoDir
process.env.WEFLOW_CONFIG_CWD = isoDir

let pass = 0, fail = 0
function ok(name: string, cond: boolean): void {
  if (cond) { pass++ } else { fail++; console.error('FAIL:', name) }
}

import { sendWecomBot } from '../electron/services/insightService'

interface MockHandle {
  url: string
  received: { body: string; count: number }
  close: () => Promise<void>
}

/** 本地 mock 企微 webhook：127.0.0.1 随机端口，记录收到的请求 */
function startMock(handler: (req: http.IncomingMessage, res: http.ServerResponse, received: MockHandle['received']) => void): Promise<MockHandle> {
  const received = { body: '', count: 0 }
  const server = http.createServer((req, res) => {
    received.count++
    handler(req, res, received)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo
      resolve({
        url: `http://127.0.0.1:${addr.port}/cgi-bin/webhook/send?key=test-key`,
        received,
        close: () => new Promise((r) => server.close(() => r()))
      })
    })
  })
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (c) => { data += c })
    req.on('end', () => resolve(data))
  })
}

async function main(): Promise<void> {
  // a+b. 成功路径 + 载荷格式
  {
    const mock = await startMock(async (req, res, received) => {
      received.body = await readBody(req)
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ errcode: 0, errmsg: 'ok' }))
    })
    try {
      let threw = ''
      try { await sendWecomBot(mock.url, '【WeFlow】标题\n\n正文') } catch (e) { threw = (e as Error).message }
      ok('errcode=0 判成功（不抛错）', threw === '')
      const parsed = JSON.parse(mock.received.body)
      ok('载荷 msgtype=text', parsed.msgtype === 'text')
      ok('载荷 text.content 原样透传', parsed.text?.content === '【WeFlow】标题\n\n正文')
      ok('请求落到 mock 的 webhook 路径', mock.received.count === 1)
    } finally { await mock.close() }
  }

  // b. errcode !== 0 判失败
  {
    const mock = await startMock((_req, res) => {
      res.end(JSON.stringify({ errcode: 93000, errmsg: 'invalid webhook url' }))
    })
    try {
      let msg = ''
      try { await sendWecomBot(mock.url, 'x') } catch (e) { msg = (e as Error).message }
      ok('errcode!=0 判失败', msg.includes('93000'))
      ok('失败信息回显 errmsg', msg.includes('invalid webhook url'))
    } finally { await mock.close() }
  }

  // c. 非 JSON 响应
  {
    const mock = await startMock((_req, res) => {
      res.end('<html>502 Bad Gateway</html>')
    })
    try {
      let msg = ''
      try { await sendWecomBot(mock.url, 'x') } catch (e) { msg = (e as Error).message }
      ok('非 JSON 响应报「响应解析失败」', msg.startsWith('响应解析失败'))
    } finally { await mock.close() }
  }

  // d. 超时处理（服务端不响应；用短超时保证测试快速）
  {
    const mock = await startMock(() => { /* 永不 end */ })
    try {
      let msg = ''
      const t0 = Date.now()
      try { await sendWecomBot(mock.url, 'x', 300) } catch (e) { msg = (e as Error).message }
      ok('无响应按超时判失败', msg === '企业微信机器人请求超时')
      ok('超时按 timeoutMs 生效（<5s）', Date.now() - t0 < 5000)
    } finally { await mock.close() }
  }

  // e. 未配置时跳过不报错、不发请求
  {
    const mock = await startMock((_req, res) => { res.end(JSON.stringify({ errcode: 0 })) })
    try {
      let threw = false
      try { await sendWecomBot('', 'x') } catch { threw = true }
      try { await sendWecomBot('   ', 'x') } catch { threw = true }
      ok('空/空白 webhook 静默跳过（不抛错）', !threw)
      ok('未配置时不发起网络请求', mock.received.count === 0)
    } finally { await mock.close() }
  }

  // f. 非法输入显式报错
  {
    let msg = ''
    try { await sendWecomBot('not-a-url', 'x') } catch (e) { msg = (e as Error).message }
    ok('无法解析的 URL 显式报错', msg === 'Webhook URL 无效')

    let protoMsg = ''
    try { await sendWecomBot('ftp://example.com/cgi-bin/webhook/send?key=x', 'x') } catch (e) { protoMsg = (e as Error).message }
    ok('非 http(s) 协议显式报错', protoMsg.startsWith('不支持的 Webhook 协议'))
  }

  console.log(`\n结果：${pass} 通过，${fail} 失败`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => {
  console.error('测试执行异常:', e)
  process.exit(1)
})
