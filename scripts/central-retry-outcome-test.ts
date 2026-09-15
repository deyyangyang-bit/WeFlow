/**
 * central-retry-outcome-test.ts —— 失败行重投的**结果口径**验证（2026-09-15 第二轮）
 *
 * 被验证的真实缺陷：重投入口此前一律返回 `success: true`，设置页只看整轮的 `pushed` / `rejected`
 * 计数，于是**网络故障**时会出现「绿色提示『已重投』，而那一行其实还躺在 pending 里」——
 * 「重新排队成功」被当成了「同步成功」。
 *
 * 正确的判定依据只能是**该 rowId 自己的最终状态**（整轮计数是**所有行**的合计，别的行成功
 * 也会把它顶上去，反过来网络故障时所有行都没发出去也证明不了这一行没成功）。本脚本注册
 * **真实的 IPC 处理器**（`registerCentralSyncIpcHandlers`，它只依赖 `type IpcMain` 与无 electron
 * 依赖的 salesQueue，可在测试里用假 ipcMain 驱动），逐个覆盖四种结果：
 *   A. `sent`         该行被中央受理并结算 sent → 设置页显示绿色「已完成同步」；
 *   B. `pending`      failed → pending 已完成，但本轮网络失败没送出去 → 提示「等待网络/下一轮同步」；
 *   C. `failed`       重投后再次被契约拒绝（4xx）→ 提示「重投后仍被拒绝，请查看审计」；
 *   D. `unconfigured` 中央同步未配置（本机根本没发起请求）→ **绝不能显示成功**。
 * 另覆盖稳定拒收路径（非法 rowId / 非 failed 行）、syncError 脱敏（手机号打码 + 令牌隐藏）
 * 与设置页分支的静态契约。
 *
 * 边界：中央侧是**假 fetch**（按路径路由的内存实现），不发真实网络请求、不连 PostgreSQL、
 *       不启动真实中央节点。真实部署 / 真机 / 真实网络链路**均未验证**。
 * 隔离：WEFLOW_WORKER + /tmp 三环境变量在模块顶部设置，业务模块一律动态 import。
 * 运行：npx tsx scripts/central-retry-outcome-test.ts
 */
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const isoDir = mkdtempSync(join(tmpdir(), 'centralsync-retry-'))
process.env.WEFLOW_WORKER = '1'
process.env.WEFLOW_USER_DATA_PATH = isoDir
process.env.WEFLOW_CONFIG_CWD = isoDir

let pass = 0, fail = 0
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; console.log(`  ✅ ${name}`) } else { fail++; console.log(`  ❌ ${name} ${detail}`) }
}

import type { CentralSyncEvent } from '../shared/centralSync'

/** IPC 回包的可读形状（与 src/types/electron.d.ts 的 retryFailed 声明一致） */
interface RetryReply {
  success: boolean
  rowId?: number
  code?: string
  retryCode?: string
  deliveryStatus?: string
  retryOutcome?: string
  syncConfigured?: boolean
  syncError?: string
  result?: { enabled: boolean; pushed: number; rejected: number; applied: number }
  error?: string
}

type Handler = (event: unknown, payload?: unknown) => Promise<unknown>

let crmDbService: (typeof import('../electron/services/crmDbService'))['crmDbService']
let ConfigService: (typeof import('../electron/services/config'))['ConfigService']
let service: typeof import('../electron/services/centralSyncService')

const TOKEN = 'retry-outcome-device-token-0123456789abcdef'
const PHONE = '13800002222'
const handlers = new Map<string, Handler>()
let pushMode: 'ok' | 'reject_all' | 'network_fail' = 'ok'
/** 网络故障时的错误文本：故意塞进手机号与设备令牌，验证回传前确实脱敏 */
let networkErrorText = 'network unreachable'

let captured: Array<{ url: string; body: unknown }> = []

/** 假中央服务：只按路径路由，绝不发真实网络请求 */
const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = String(input)
  const body = init?.body ? JSON.parse(String(init.body)) : undefined
  captured.push({ url, body })
  const json = (status: number, payload: unknown): Response =>
    new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
  if (url.endsWith('/api/v1/sync/push')) {
    if (pushMode === 'network_fail') throw new Error(networkErrorText)
    const events = (body as { events: CentralSyncEvent[] }).events
    if (pushMode === 'reject_all') {
      return json(200, { ok: true, data: { accepted: [], rejected: events.map((e) => ({ eventId: e.eventId, code: 'forbidden_field', message: 'x' })) } })
    }
    return json(200, { ok: true, data: { accepted: events.map((e, i) => ({ eventId: e.eventId, centralSeq: i + 1, duplicate: false })), rejected: [] } })
  }
  if (url.includes('/api/v1/sync/pull')) return json(200, { ok: true, data: { events: [], nextCursor: 0, hasMore: false } })
  if (url.endsWith('/api/v1/sync/ack')) return json(200, { ok: true, data: { acknowledged: 0 } })
  if (url.endsWith('/api/v1/directory/employees')) return json(200, { ok: true, data: { employees: [] } })
  return json(404, { ok: false, code: 'E404', message: 'not found' })
}) as unknown as typeof fetch

function configureBinding(): void {
  const cfg = ConfigService.getInstance()
  cfg.set('centralSyncEnabled', true)
  cfg.set('centralSyncBaseUrl', 'https://central.test')
  cfg.set('centralSyncDeviceToken', TOKEN)
  cfg.set('centralSyncWorkspaceId', 'ws-1')
  cfg.set('centralSyncEmployeeId', 'emp-1')
  cfg.set('centralSyncDeviceId', 'dev-1')
  cfg.set('centralSyncRole', 'sales')
  cfg.set('centralSyncDisplayName', '测试销售甲')
}

function clearBinding(): void {
  const cfg = ConfigService.getInstance()
  cfg.set('centralSyncEnabled', false)
  cfg.set('centralSyncDeviceToken', '')
  cfg.set('centralSyncWorkspaceId', '')
  cfg.set('centralSyncEmployeeId', '')
  cfg.set('centralSyncDeviceId', '')
}

/**
 * 布置一条**终态 failed** 的合法 outbox 行（重投入口的唯一受理形态）。
 * 只 INSERT，绝不直接改既有行的状态（宪法 §1.11：状态只能由状态机迁移）。
 */
function seedFailedClaim(seq: number, key: string): number {
  const now = Date.now()
  return crmDbService.runTx((tx) => {
    tx.run('INSERT INTO outbox_event (event_seq, idempotency_key, payload, status, source, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
      [seq, key, JSON.stringify({ type: 'claim', leadId: 999, version: 1 }), 'failed', 'test', now, now])
    return Number(tx.all('SELECT id FROM outbox_event WHERE idempotency_key = ?', [key])[0]?.id || 0)
  })
}

function statusOf(rowId: number): string {
  return String(crmDbService.all('SELECT status FROM outbox_event WHERE id = ?', [rowId])[0]?.status || '')
}

/** 直接驱动**真实注册的** IPC 处理器（假 ipcMain 只做 channel → handler 登记） */
async function callRetry(rowId: number): Promise<RetryReply> {
  const handler = handlers.get('centralsync:retryFailed')
  if (!handler) throw new Error('centralsync:retryFailed 未注册')
  return await handler(null, { rowId }) as RetryReply
}

async function main(): Promise<void> {
  ConfigService = (await import('../electron/services/config')).ConfigService
  crmDbService = (await import('../electron/services/crmDbService')).crmDbService
  const { salesDbService } = await import('../electron/services/salesDbService')
  service = await import('../electron/services/centralSyncService')
  const { registerCentralSyncIpcHandlers } = await import('../electron/services/centralSyncIpcHandlers')

  await crmDbService.initialize(isoDir)
  await salesDbService.initialize(isoDir)
  configureBinding()
  globalThis.fetch = fakeFetch
  registerCentralSyncIpcHandlers({ handle: (channel: string, fn: Handler) => { handlers.set(channel, fn) } } as never)

  // 本地事实：claim 的投递内容由 assignment 投影从本地行重建（outbox payload 只用于定位本地行）
  crmDbService.runTx((tx) => {
    tx.run('INSERT INTO customer (name, type, source, updated_by, updated_at, version, deleted) VALUES (?,?,?,?,?,?,?)',
      ['重投客户甲', 'end_user', 'manual', '测试销售甲', Date.now(), 1, 0])
    tx.run('INSERT INTO customer_identity (identity_type, identity_value, customer_id, source, confidence, updated_at, version, deleted) VALUES (?,?,?,?,?,?,?,?)',
      ['phone', PHONE, 1, 'manual', 1.0, Date.now(), 1, 0])
    tx.run('INSERT INTO lead (id, contact_type, contact_normalized, account_id, name, source, first_contact_deadline, assigned_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [999, 'phone', '13900000009', 1, '重投线索', 'test', Date.now() + 86_400_000, Date.now(), Date.now(), Date.now()])
    tx.run('INSERT INTO account (name, owner_sales, customer_id, created_at, updated_at) VALUES (?,?,?,?,?)',
      ['重投账户甲', '测试销售甲', 1, Date.now(), Date.now()])
    tx.run('INSERT INTO assignment (lead_id, sales_name, mode, sla1_deadline, status, source, updated_by, updated_at, version, deleted) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [999, '测试销售甲', 'manual', Date.now() + 86_400_000, 'assigned', 'test', '测试销售甲', Date.now(), 1, 0])
  })

  console.log('═══ A. sent：重投后该行真的被中央受理 ═══')
  pushMode = 'ok'
  const sentRowId = seedFailedClaim(101, 'claim:999:retry-sent')
  captured = []
  const sentRes = await callRetry(sentRowId)
  ok('A1 重投成功：retryOutcome=sent、deliveryStatus=sent，且本轮确实发起了同步',
    sentRes.success === true && sentRes.retryOutcome === 'sent' &&
    sentRes.deliveryStatus === 'sent' && sentRes.syncConfigured === true, JSON.stringify(sentRes))
  ok('A2 该行的状态是**回读**出来的：库里确实已由状态机结算为 sent',
    statusOf(sentRowId) === 'sent' && sentRes.retryCode === 'ok')
  ok('A3 该行真的进入了中央请求（不是「本机置 sent、中央没收到」）',
    captured.some((c) => c.url.endsWith('/api/v1/sync/push')), JSON.stringify(captured.map((c) => c.url)))

  console.log('\n═══ B. pending：重新排队成功 ≠ 同步成功（网络故障）═══')
  pushMode = 'network_fail'
  networkErrorText = `network unreachable ${PHONE} token=${TOKEN}`
  const pendingRowId = seedFailedClaim(102, 'claim:999:retry-pending')
  const pendingRes = await callRetry(pendingRowId)
  ok('B1 网络失败：翻转被接受（success=true）但 retryOutcome=pending —— 绝不显示为成功',
    pendingRes.success === true && pendingRes.retryOutcome === 'pending' &&
    pendingRes.deliveryStatus === 'pending' && pendingRes.syncConfigured === true, JSON.stringify(pendingRes))
  ok('B2 该行仍停在 pending（已重新排队，等网络恢复/下一轮），没有被误判为 sent 或 failed',
    statusOf(pendingRowId) === 'pending')
  ok('B3 syncError 非空且已脱敏：手机号打码、设备令牌被隐藏（回传文本里不含原始值）',
    typeof pendingRes.syncError === 'string' && pendingRes.syncError.length > 0 &&
    pendingRes.syncError.includes('138****2222') && !pendingRes.syncError.includes(TOKEN) &&
    pendingRes.syncError.includes('[已隐藏令牌]'), String(pendingRes.syncError))
  pushMode = 'ok'

  console.log('\n═══ C. failed：重投后再次被契约拒绝 ═══')
  pushMode = 'reject_all'
  const failedRowId = seedFailedClaim(103, 'claim:999:retry-failed')
  const failedBefore = Number(crmDbService.all(
    "SELECT COUNT(*) AS c FROM audit_event WHERE action IN ('sync_push_rejected','sync_outbox_failed')")[0].c)
  const failedRes = await callRetry(failedRowId)
  const failedAfter = Number(crmDbService.all(
    "SELECT COUNT(*) AS c FROM audit_event WHERE action IN ('sync_push_rejected','sync_outbox_failed')")[0].c)
  ok('C1 再次被拒：retryOutcome=failed、deliveryStatus=failed（不静默吞掉、也不谎报成功）',
    failedRes.success === true && failedRes.retryOutcome === 'failed' &&
    failedRes.deliveryStatus === 'failed', JSON.stringify(failedRes))
  ok('C2 该行回到终态 failed 并新增本机审计（可人工介入）',
    statusOf(failedRowId) === 'failed' && failedAfter > failedBefore)
  pushMode = 'ok'

  console.log('\n═══ D. unconfigured：中央同步未配置（本机根本没发请求）═══')
  clearBinding()
  const unconfRowId = seedFailedClaim(104, 'claim:999:retry-unconfigured')
  captured = []
  const unconfRes = await callRetry(unconfRowId)
  ok('D1 未配置：retryOutcome=unconfigured、syncConfigured=false —— **绝不是成功**',
    unconfRes.success === true && unconfRes.retryOutcome === 'unconfigured' &&
    unconfRes.syncConfigured === false, JSON.stringify(unconfRes))
  ok('D2 该行只是重新排队（pending），且本轮零网络请求',
    statusOf(unconfRowId) === 'pending' && captured.length === 0, JSON.stringify(captured))
  ok('D3 判定口径是纯函数：unconfigured 优先于行状态，unknown 一律按「未确认」处理',
    service.retryOutcomeOf('pending', false) === 'unconfigured' &&
    service.retryOutcomeOf('sent', false) === 'unconfigured' &&
    service.retryOutcomeOf('unknown', true) === 'unknown' &&
    service.retryOutcomeOf('pending', true) === 'pending' &&
    service.retryOutcomeOf('sent', true) === 'sent' &&
    service.retryOutcomeOf('failed', true) === 'failed')
  ok('D4 行状态读取本身也是只读纯函数（非法 rowId / 不存在的行一律 unknown，不抛错）',
    service.outboxDeliveryStatusOf(0) === 'unknown' && service.outboxDeliveryStatusOf(99999999) === 'unknown' &&
    service.outboxDeliveryStatusOf(unconfRowId) === 'pending')
  configureBinding()

  console.log('\n═══ E. 稳定拒收路径（不改变任何行状态）═══')
  const badIdRes = await callRetry(0)
  ok('E1 非法 rowId：success=false + invalid_row_id，且不带任何结果码（没有行被改状态）',
    badIdRes.success === false && badIdRes.code === 'invalid_row_id' && badIdRes.retryOutcome === undefined,
    JSON.stringify(badIdRes))
  const notFailedRes = await callRetry(sentRowId)
  ok('E2 对已成功的行重投：not_failed 稳定拒收（sent 行不可被复活）',
    notFailedRes.success === false && notFailedRes.code === 'not_failed' && statusOf(sentRowId) === 'sent')
  const missingRes = await callRetry(99999999)
  ok('E3 不存在的行：not_found（不静默当成成功）',
    missingRes.success === false && missingRes.code === 'not_found')

  console.log('\n═══ F. 静态契约：判定依据是该行最终状态，不是整轮计数 ═══')
  const root = join(__dirname, '..')
  const ipcSrc = readFileSync(join(root, 'electron/services/centralSyncIpcHandlers.ts'), 'utf8')
  ok('F1 IPC 在同步之后**回读该 rowId** 的最终状态（不是拿整轮 pushed/rejected 反推）',
    /outboxDeliveryStatusOf\(\s*rowId\s*\)/.test(ipcSrc) &&
    /retryOutcomeOf\(\s*deliveryStatus\s*,\s*syncConfigured\s*\)/.test(ipcSrc))
  ok('F2 IPC 回传的 syncError 经 safeSyncError 脱敏（与审计留痕同一套脱敏口径）',
    /syncError:\s*safeSyncError\(/.test(ipcSrc))
  const pageRaw = readFileSync(join(root, 'src/pages/SettingsPage.tsx'), 'utf8')
  const handlerBody = pageRaw.slice(pageRaw.indexOf('const handleCentralRetryFailed'), pageRaw.indexOf('const handleCentralClaim'))
  ok('F3 设置页按 retryOutcome 四分支，绝不把「已重新排队」显示成成功',
    /retryOutcome === 'sent'/.test(handlerBody) && /retryOutcome === 'unconfigured'/.test(handlerBody) &&
    /retryOutcome === 'failed'/.test(handlerBody) && handlerBody.includes('等待网络/下一轮同步'))
  ok('F4 设置页不再用整轮计数判定该行的结果（result?.pushed / result?.rejected / result?.error 在该分支零出现）',
    !/result\?\.(pushed|rejected|error)/.test(handlerBody) && /res\.syncError/.test(handlerBody))
  ok('F5 重投后仍刷新失败清单与同步状态（finally 里的既有刷新未被破坏）',
    /finally\s*\{[\s\S]{0,200}?refreshCentralSyncStatus\(\)/.test(handlerBody))

  console.log(`\n═══ 结果：${pass} 通过 / ${fail} 失败 ═══`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error('测试崩溃:', e); process.exit(1) })
