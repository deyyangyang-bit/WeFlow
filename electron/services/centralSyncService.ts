/**
 * Phase 3a HTTP 同步 adapter。
 *
 * 复用 Phase 1 outbox、下行业务状态机与幂等标记；本文件只负责 HTTP 传输与游标推进。
 * 中央不可达时所有本机业务照常运行，pending/outbox 与 pull cursor 保留，下轮继续重放。
 *
 * 传输层纪律（PRD §7.1，替换 adapter 不换语义）：
 *  - 上行只从**既有业务表与 append-only 流水**投影（见 centralProjection.ts），禁止扫聊天表；
 *  - outbox 行与投影行**只有推送被接受后**才推进游标 / 置 sent；失败保留重放；
 *  - 下行只走既有 assign/transfer/recycle 状态机；本阶段新增的 supervisor_correction /
 *    permission_change 按 PRD 语义落「待确认 + 审计」，绝不静默覆盖本地事实；
 *  - 无法在本机执行的指令终态回 invalid（重试有上限），不允许无限 retry 卡死队列。
 */
import { createHash } from 'crypto'
import { hostname } from 'os'
import type { CentralAckRequest, CentralSyncEvent } from '../../shared/centralSync'
import { findForbiddenCentralField } from '../../shared/centralSync'
import { ConfigService } from './config'
import { crmDbService, type CrmRow } from './crmDbService'
import { getTerminalId, applyDownEventDirect, maskAuditText, type DeliveryRole, type SyncEventFile } from './lanSyncService'
import { CentralSyncClient, type CentralPrincipal } from './centralSyncClient'
import { LOCAL_PROJECTIONS, projectionByKey, type ProjectionDraft } from './centralProjection'

const K_PULL_CURSOR = 'centralSync:pullCursor'
const K_LAST_UP = 'centralSync:lastUpAt'
const K_LAST_DOWN = 'centralSync:lastDownAt'
const K_PERMISSION_SENT = 'centralSync:permissionSent'
const K_AUDIT_CURSOR = 'centralSync:auditCursor'
/** 审计投影的游标键沿用 Phase 1 既有 key，避免升级后重放整表 */
const AUDIT_CURSOR_ALIAS: Record<string, string> = { audit: K_AUDIT_CURSOR }

const PUSH_BATCH = 50
const PULL_BATCH = 100
/** 下行事件最大重试次数：超过即回 invalid 终态，防止一条本机无法执行的事件卡死整条队列 */
const MAX_DOWN_ATTEMPTS = 5
/** 调度器心跳（分钟）：实际执行间隔由 centralSyncPollIntervalMin 决定，间隔变更下一拍即生效 */
const HEARTBEAT_MS = 60_000
/** 启动后首跑宽限：避开应用启动高峰，不与应用初始化抢资源 */
const STARTUP_GRACE_MS = 45_000

let heartbeat: NodeJS.Timeout | null = null
let firstTimer: NodeJS.Timeout | null = null
let running = false
let lastRunStartedAt = 0

export interface CentralSyncConfig {
  enabled: boolean
  baseUrl: string
  token: string
  workspaceId: string
  employeeId: string
  deviceId: string
  role: string
  displayName: string
  pollIntervalMin: number
}

export interface CentralSyncStatus {
  enabled: boolean
  configured: boolean
  baseUrl: string
  workspaceId: string
  employeeId: string
  deviceId: string
  /** 服务端声明的角色（仅展示；不作权限依据） */
  role: string
  displayName: string
  backlogPending: number
  pullCursor: number
  lastUpAt: number
  lastDownAt: number
  lastError: string
  lastErrorAt: number
  running: boolean
  schedulerRunning: boolean
  polling: boolean
  pollIntervalMin: number
}

export interface CentralSyncRunResult {
  enabled: boolean
  pushed: number
  rejected: number
  applied: number
  error?: string
}

export function getCentralSyncConfig(): CentralSyncConfig {
  const cfg = ConfigService.getInstance()
  const interval = Number(cfg.get('centralSyncPollIntervalMin') || 1)
  return {
    enabled: Boolean(cfg.get('centralSyncEnabled')),
    baseUrl: String(cfg.get('centralSyncBaseUrl') || '').trim().replace(/\/$/, ''),
    token: String(cfg.get('centralSyncDeviceToken') || '').trim(),
    workspaceId: String(cfg.get('centralSyncWorkspaceId') || '').trim(),
    employeeId: String(cfg.get('centralSyncEmployeeId') || '').trim(),
    deviceId: String(cfg.get('centralSyncDeviceId') || '').trim(),
    role: String(cfg.get('centralSyncRole') || '').trim(),
    displayName: String(cfg.get('centralSyncDisplayName') || '').trim(),
    pollIntervalMin: Number.isFinite(interval) ? Math.max(1, Math.min(60, Math.floor(interval))) : 1
  }
}

function isConfigured(cfg: CentralSyncConfig): boolean {
  return cfg.enabled && Boolean(cfg.baseUrl && cfg.token && cfg.workspaceId && cfg.employeeId && cfg.deviceId)
}

function clientOf(cfg: CentralSyncConfig): CentralSyncClient {
  return new CentralSyncClient({ baseUrl: cfg.baseUrl, token: cfg.token })
}

function stableEventId(deviceId: string, idempotencyKey: string): string {
  return `${deviceId}:${createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 32)}`
}

function cursorKeyOf(projectionKey: string): string {
  return AUDIT_CURSOR_ALIAS[projectionKey] || `centralSync:cursor:${projectionKey}`
}

/** 同步失败留痕：脱敏后写配置（设置页展示），不写日志正文、不写令牌 */
function recordError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const message = maskAuditText(raw).slice(0, 300)
  const cfg = ConfigService.getInstance()
  cfg.set('centralSyncLastError', message)
  cfg.set('centralSyncLastErrorAt', Date.now())
  return message
}

function clearError(): void {
  const cfg = ConfigService.getInstance()
  if (String(cfg.get('centralSyncLastError') || '')) cfg.set('centralSyncLastError', '')
}

// ─── 上行 ──────────────────────────────────────────────────────────────────────

function eventEntity(type: string, payload: Record<string, unknown>): { entityType: 'customer_identity' | 'assignment'; entityId: string } {
  if (type === 'bind_wx') return { entityType: 'customer_identity', entityId: String(payload.identityId || payload.leadId || 'unknown') }
  return { entityType: 'assignment', entityId: String(payload.assignmentId || payload.leadId || 'unknown') }
}

/** Phase 1 outbox 行 → 上行事件（复用既有 event_seq / idempotency_key，不另造 seq 语义） */
function outboxEvent(row: CrmRow, cfg: CentralSyncConfig): CentralSyncEvent | null {
  let payload: Record<string, unknown>
  try { payload = JSON.parse(String(row.payload || '{}')) } catch { return null }
  const type = String(payload.type || '')
  if (!['claim', 'bind_wx', 'first_touch'].includes(type)) return null
  const rawKey = String(row.idempotency_key || '')
  if (!rawKey) return null
  const idempotencyKey = `${cfg.deviceId}/${rawKey}`
  const entity = eventEntity(type, payload)
  return {
    protocolVersion: 1, eventId: stableEventId(cfg.deviceId, idempotencyKey), eventSeq: Number(row.event_seq),
    idempotencyKey, direction: 'up', ...entity, eventType: type,
    aggregateVersion: Math.max(0, Number(payload.version || 0)), payload, occurredAt: Number(row.created_at || Date.now())
  }
}

/** 投影草稿 → 传输信封：entityId 带设备前缀，幂等键 = 设备/投影/本地行号 */
function envelopeOf(draft: ProjectionDraft, cfg: CentralSyncConfig): CentralSyncEvent {
  const idempotencyKey = `${cfg.deviceId}/${draft.entityType}/${draft.localRef}`
  return {
    protocolVersion: 1, eventId: stableEventId(cfg.deviceId, idempotencyKey), eventSeq: Math.max(1, draft.eventSeq),
    idempotencyKey, direction: 'up', entityType: draft.entityType, entityId: `${cfg.deviceId}/${draft.localRef}`,
    eventType: draft.eventType, aggregateVersion: Math.max(0, draft.aggregateVersion), payload: draft.payload,
    occurredAt: draft.occurredAt > 0 ? draft.occurredAt : Date.now()
  }
}

/** 上行前自检：命中禁字段直接丢弃该条并在本机留痕（中央还会再拦一道，双保险） */
function selfGuard(drafts: ProjectionDraft[]): { events: CentralSyncEvent[]; dropped: number } {
  const events: CentralSyncEvent[] = []
  let dropped = 0
  for (const draft of drafts) {
    if (findForbiddenCentralField(draft.payload)) {
      dropped++
      crmDbService.runTx((tx) => {
        tx.run('INSERT INTO audit_event (actor, action, entity_type, entity_id, detail, created_at) VALUES (?,?,?,?,?,?)',
          ['system:sync', 'sync_forbidden_field_blocked', draft.entityType, draft.localRef,
            JSON.stringify({ entityType: draft.entityType, reason: '上行含禁上传字段，已拦截未发送' }), Date.now()])
      })
      continue
    }
    events.push(envelopeOf(draft, getCentralSyncConfig()))
  }
  return { events, dropped }
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/** 推送一批（≤PUSH_BATCH）并返回逐事件结果；网络失败整批抛出，游标不动 */
async function pushBatch(
  client: CentralSyncClient, events: CentralSyncEvent[], batchKey: string
): Promise<{ acceptedIds: Set<string>; rejected: Array<{ eventId: string; code: string }> }> {
  const result = await client.push(events, batchKey)
  return {
    acceptedIds: new Set(result.accepted.map((item) => item.eventId)),
    rejected: result.rejected.map((item) => ({ eventId: item.eventId, code: String(item.code || 'rejected') }))
  }
}

/** 推送 Phase 1 outbox 待发事件（只有被接受才置 sent；被拒的如实计数并留本机审计） */
async function pushOutbox(client: CentralSyncClient, cfg: CentralSyncConfig): Promise<{ pushed: number; rejected: number }> {
  const rows = crmDbService.all("SELECT * FROM outbox_event WHERE status='pending' ORDER BY event_seq LIMIT ?", [PUSH_BATCH])
  const pairs: Array<{ row: CrmRow; event: CentralSyncEvent }> = []
  let rejected = 0
  for (const row of rows) {
    const event = outboxEvent(row, cfg)
    if (!event) continue
    if (findForbiddenCentralField(event.payload)) {
      // 命中禁字段：本机直接不发，置 failed + 审计，避免每轮空转重试
      rejected++
      crmDbService.runTx((tx) => {
        tx.run("UPDATE outbox_event SET status='failed',updated_at=? WHERE id=? AND status='pending'", [Date.now(), Number(row.id)])
        tx.run('INSERT INTO audit_event (actor, action, entity_type, entity_id, detail, created_at) VALUES (?,?,?,?,?,?)',
          ['system:sync', 'sync_forbidden_field_blocked', 'outbox_event', String(Number(row.id)),
            JSON.stringify({ reason: '上行含禁上传字段，已拦截未发送' }), Date.now()])
      })
      continue
    }
    pairs.push({ row, event })
  }
  if (!pairs.length) return { pushed: 0, rejected }
  const outcome = await pushBatch(client, pairs.map((p) => p.event), `outbox:${cfg.deviceId}:${Number(pairs[0]!.row.id)}-${Number(pairs[pairs.length - 1]!.row.id)}`)
  let pushed = 0
  crmDbService.runTx((tx) => {
    for (const pair of pairs) {
      if (!outcome.acceptedIds.has(pair.event.eventId)) continue
      tx.run("UPDATE outbox_event SET status='sent',updated_at=? WHERE id=? AND status='pending'", [Date.now(), Number(pair.row.id)])
      pushed++
    }
    // 被中央拒绝：终态，重推不会改变结论 → 置 failed 并留审计，不留在 pending 里静默空转
    for (const item of outcome.rejected) {
      const pair = pairs.find((p) => p.event.eventId === item.eventId)
      if (!pair) continue
      rejected++
      tx.run("UPDATE outbox_event SET status='failed',updated_at=? WHERE id=? AND status='pending'", [Date.now(), Number(pair.row.id)])
      tx.run('INSERT INTO audit_event (actor, action, entity_type, entity_id, detail, created_at) VALUES (?,?,?,?,?,?)',
        ['system:sync', 'sync_push_rejected', 'outbox_event', String(Number(pair.row.id)),
          JSON.stringify({ code: item.code }), Date.now()])
    }
  })
  return { pushed, rejected }
}

/** 推送一个投影的增量批次：整批要么全被中央受理（含逐条拒绝），要么网络失败游标不动 */
async function pushProjection(client: CentralSyncClient, cfg: CentralSyncConfig, projectionKey: string): Promise<{ pushed: number; rejected: number }> {
  const projection = projectionByKey(projectionKey)
  if (!projection) return { pushed: 0, rejected: 0 }
  const key = cursorKeyOf(projection.key)
  const cursor = crmDbService.getScanState(key)
  const drafts = projection.read(cursor, PUSH_BATCH)
  if (!drafts.length) return { pushed: 0, rejected: 0 }
  const { events, dropped } = selfGuard(drafts)
  let rejected = dropped
  let accepted = 0
  let lastSeq = cursor
  for (const batch of chunk(events, PUSH_BATCH)) {
    const outcome = await pushBatch(client, batch, `projection:${cfg.deviceId}:${projection.key}:${batch[0]!.eventSeq}`)
    accepted += outcome.acceptedIds.size
    rejected += outcome.rejected.length
    if (outcome.rejected.length) {
      crmDbService.runTx((tx) => {
        for (const item of outcome.rejected.slice(0, 20)) {
          tx.run('INSERT INTO audit_event (actor, action, entity_type, entity_id, detail, created_at) VALUES (?,?,?,?,?,?)',
            ['system:sync', 'sync_push_rejected', projection.entityType, item.eventId,
              JSON.stringify({ entityType: projection.entityType, code: item.code }), Date.now()])
        }
      })
    }
    // 游标推进到本批最后一行：被中央拒绝的事件是**终态**，重推不会改变结论，推进不会丢数据
    lastSeq = Math.max(lastSeq, Number(batch[batch.length - 1]!.eventSeq))
  }
  if (lastSeq > cursor) crmDbService.setScanState(key, lastSeq)
  // 本批读满即认为还有余量，交由下一拍继续（避免单拍长时间占用）
  return { pushed: accepted, rejected }
}

/** 一次性声明本机身份档案声明的角色（**展示与审计用，绝不作为权限依据**） */
async function pushPermissionDeclaration(client: CentralSyncClient, cfg: CentralSyncConfig): Promise<number> {
  if (crmDbService.getScanState(K_PERMISSION_SENT) > 0) return 0
  const conf = ConfigService.getInstance()
  const employeeRef = String(conf.get('identityName') || '').trim() || cfg.employeeId
  const declaredRole = cfg.role || String(conf.get('identityRole') || '').trim() || 'sales'
  const idempotencyKey = `${cfg.deviceId}/permission/${declaredRole}`
  const event: CentralSyncEvent = {
    protocolVersion: 1, eventId: stableEventId(cfg.deviceId, idempotencyKey), eventSeq: 1, idempotencyKey,
    direction: 'up', entityType: 'permission', entityId: `${cfg.deviceId}/permission`,
    eventType: 'permission_declared', aggregateVersion: 1,
    payload: { employeeRef, declaredRole, authoritySource: 'local_declaration' },
    occurredAt: Date.now()
  }
  const { acceptedIds } = await pushBatch(client, [event], `permission:${cfg.deviceId}`)
  if (!acceptedIds.has(event.eventId)) return 0
  crmDbService.setScanState(K_PERMISSION_SENT, Date.now())
  return 1
}

async function pushUp(client: CentralSyncClient, cfg: CentralSyncConfig): Promise<{ pushed: number; rejected: number }> {
  let pushed = 0
  let rejected = 0
  const outbox = await pushOutbox(client, cfg)
  pushed += outbox.pushed
  rejected += outbox.rejected
  pushed += await pushPermissionDeclaration(client, cfg)
  for (const projection of LOCAL_PROJECTIONS) {
    const result = await pushProjection(client, cfg, projection.key)
    pushed += result.pushed
    rejected += result.rejected
  }
  if (pushed) crmDbService.setScanState(K_LAST_UP, Date.now())
  return { pushed, rejected }
}

// ─── 下行 ──────────────────────────────────────────────────────────────────────

/** 既有状态机覆盖的类型：只换传输 adapter，禁止复制业务语义 */
const STATEMACHINE_DOWN_TYPES = ['assign', 'transfer', 'recycle']
/** 本适配器新增的中央下行类型（PRD §7 Phase 3a 下行清单） */
const CENTRAL_DOWN_TYPES = ['supervisor_correction', 'permission_change']

function toLocalEvent(event: CentralSyncEvent & { centralSeq: number }): SyncEventFile | null {
  const known = STATEMACHINE_DOWN_TYPES.includes(event.eventType) || CENTRAL_DOWN_TYPES.includes(event.eventType)
  if (!known) return null
  const role = String(event.payload.deliveryRole || 'apply') as DeliveryRole
  if (!['apply', 'remove'].includes(role)) return null
  return {
    eventSeq: event.eventSeq, idempotencyKey: event.idempotencyKey, type: event.eventType,
    deliveryRole: role, to: getTerminalId(), payload: event.payload, emittedAt: event.occurredAt
  }
}

/**
 * 中央专有下行类型的本机落地（与既有状态机同事务纪律、同幂等口径）。
 *
 * PRD §7 Phase 3a 两条硬约束：
 *  - **主管修正不静默覆盖**：落 notify_inbox 待本地确认 + 审计，本地事实一行不改；
 *  - **权限只作声明**：落审计 + 展示配置，绝不进入本机访问控制判断。
 * 返回值与既有状态机同口径：'applied' | 'invalid'。
 */
function applyCentralOnlyDown(ev: SyncEventFile): 'applied' | 'invalid' {
  const now = Date.now()
  const key = `central:${ev.idempotencyKey}`
  if (ev.type === 'supervisor_correction') {
    return crmDbService.runTx((tx) => {
      if (tx.all('SELECT id FROM notify_inbox WHERE idempotency_key = ?', [key]).length) return 'applied'
      const detail = ev.payload.detail && typeof ev.payload.detail === 'object' ? ev.payload.detail as Record<string, unknown> : {}
      tx.run(
        'INSERT INTO notify_inbox (notify_type, idempotency_key, title, body, lead_id, detail, status, source, updated_by, updated_at, version, deleted, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
        ['supervisor_correction', key, String(ev.payload.title || '主管修正待确认'),
          maskAuditText(String(ev.payload.summary || '')), Number(ev.payload.leadId || 0) || null,
          JSON.stringify(detail), 'unread', 'central', 'system:sync', now, 1, 0, now]
      )
      tx.run('INSERT INTO audit_event (actor, action, entity_type, entity_id, detail, created_at) VALUES (?,?,?,?,?,?)',
        ['system:sync', 'central_supervisor_correction_pending', 'lead', Number(ev.payload.leadId || 0) || null,
          JSON.stringify({ idempotencyKey: ev.idempotencyKey, note: '主管修正已入待确认收件箱，本地事实未被改写' }), now])
      return 'applied'
    })
  }
  if (ev.type === 'permission_change') {
    return crmDbService.runTx((tx) => {
      const marked = tx.all('SELECT key FROM scan_state WHERE key = ?', [`centralSync:permChange:${ev.idempotencyKey}`]).length > 0
      if (marked) return 'applied'
      tx.run('INSERT INTO scan_state (key, last_scan) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET last_scan = excluded.last_scan',
        [`centralSync:permChange:${ev.idempotencyKey}`, now])
      tx.run('INSERT INTO audit_event (actor, action, entity_type, entity_id, detail, created_at) VALUES (?,?,?,?,?,?)',
        ['system:sync', 'central_permission_change_recorded', 'employee', String(ev.payload.employeeRef || ''),
          JSON.stringify({ declaredRole: String(ev.payload.declaredRole || ''), note: '服务端权限声明仅作展示与审计，不构成本机访问控制依据' }), now])
      return 'applied'
    })
  }
  return 'invalid'
}

/** 落地一条下行事件（既有状态机优先，其次中央专有类型） */
function applyDownEvent(event: CentralSyncEvent & { centralSeq: number }, local: SyncEventFile): 'applied' | 'conflict' | 'invalid' | 'nolead' {
  if (CENTRAL_DOWN_TYPES.includes(event.eventType)) return applyCentralOnlyDown(local)
  return applyDownEventDirect(local)
}

function attemptsOf(eventId: string): number {
  return Number(crmDbService.getScanState(`centralSync:downAttempt:${eventId}`) || 0)
}

function bumpAttempts(eventId: string): number {
  const next = attemptsOf(eventId) + 1
  crmDbService.setScanState(`centralSync:downAttempt:${eventId}`, next)
  return next
}

async function pullAndApply(client: CentralSyncClient): Promise<number> {
  const cursor = crmDbService.getScanState(K_PULL_CURSOR)
  const result = await client.pull(cursor, PULL_BATCH)
  const acknowledgements: CentralAckRequest['acknowledgements'] = []
  let nextCursor = cursor
  let applied = 0
  for (const event of result.events) {
    const local = toLocalEvent(event)
    if (!local) {
      // 本机不认识的事件类型：**不是**可重试状态。重试不会改变结果，直接回终态 invalid。
      acknowledgements.push({ centralSeq: event.centralSeq, eventId: event.eventId, outcome: 'invalid',
        detail: `本机不支持的事件类型或不适用投递角色：${event.eventType}` })
      nextCursor = event.centralSeq
      continue
    }
    const outcome = applyDownEvent(event, local)
    if (outcome === 'nolead') {
      const attempts = bumpAttempts(event.eventId)
      if (attempts >= MAX_DOWN_ATTEMPTS) {
        acknowledgements.push({ centralSeq: event.centralSeq, eventId: event.eventId, outcome: 'invalid',
          detail: `依赖对象缺失，已重试 ${attempts} 次仍无法应用，转终态避免无休止重试` })
        nextCursor = event.centralSeq
        continue
      }
      acknowledgements.push({ centralSeq: event.centralSeq, eventId: event.eventId, outcome: 'retry',
        detail: `本机缺少依赖对象，第 ${attempts}/${MAX_DOWN_ATTEMPTS} 次重试` })
      // 队列内事件按 event_seq 有序（assign 先于 recycle），停在首个未应用事件上保证顺序
      break
    }
    acknowledgements.push({ centralSeq: event.centralSeq, eventId: event.eventId, outcome: outcome,
      detail: outcome === 'conflict' ? '本地已有有效归属，与中枢指令冲突，保留本地并留人工' : undefined })
    nextCursor = event.centralSeq
    if (outcome === 'applied') applied++
  }
  if (acknowledgements.length) await client.ack(acknowledgements)
  if (nextCursor > cursor) crmDbService.setScanState(K_PULL_CURSOR, nextCursor)
  if (applied) crmDbService.setScanState(K_LAST_DOWN, Date.now())
  return applied
}

// ─── 绑定 / 解绑 ───────────────────────────────────────────────────────────────

export async function claimCentralBinding(baseUrl: string, inviteCode: string, deviceName = hostname()): Promise<CentralPrincipal> {
  const client = new CentralSyncClient({ baseUrl })
  const result = await client.claim(inviteCode, deviceName)
  const cfg = ConfigService.getInstance()
  cfg.set('centralSyncBaseUrl', baseUrl.trim().replace(/\/$/, ''))
  cfg.set('centralSyncDeviceToken', result.deviceToken)
  cfg.set('centralSyncWorkspaceId', result.principal.workspaceId)
  cfg.set('centralSyncEmployeeId', result.principal.employeeId)
  cfg.set('centralSyncDeviceId', result.principal.deviceId)
  cfg.set('centralSyncRole', result.principal.role)
  cfg.set('centralSyncDisplayName', result.principal.displayName)
  cfg.set('centralSyncLastError', '')
  cfg.set('centralSyncLastErrorAt', 0)
  cfg.set('centralSyncEnabled', true)
  // 绑定必须**总是**让调度器跑起来：只在启动时判断一次会让后续绑定永远不同步
  restartCentralSyncScheduler()
  return result.principal
}

export interface CentralDisconnectResult {
  /** 服务端是否确认吊销 */
  revoked: boolean
  /** 本机凭证是否已清除 */
  localCleared: boolean
  error?: string
}

/**
 * 解除绑定：**先请求服务端吊销，成功后才清本机凭证**。
 * 网络失败时默认不清本地凭证（否则会留下「本机以为解绑、服务端令牌仍有效」的假解绑），
 * 并把明确状态回给调用方；调用方可显式选择强制本地清除（此时如实标注服务端未吊销）。
 */
export async function disconnectCentralBinding(options: { force?: boolean } = {}): Promise<CentralDisconnectResult> {
  const cfg = getCentralSyncConfig()
  let revoked = false
  let error: string | undefined
  if (isConfigured(cfg)) {
    try {
      revoked = await clientOf(cfg).revokeSelf()
      if (!revoked) error = '服务端未确认吊销（可能已被管理员吊销或凭证已失效）'
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
  }
  if (!revoked && !options.force && isConfigured(cfg)) {
    recordError(new Error(`自助解绑未完成：${error || '未知原因'}`))
    return { revoked: false, localCleared: false, error }
  }
  const conf = ConfigService.getInstance()
  conf.set('centralSyncEnabled', false)
  conf.set('centralSyncDeviceToken', '')
  conf.set('centralSyncWorkspaceId', '')
  conf.set('centralSyncEmployeeId', '')
  conf.set('centralSyncDeviceId', '')
  conf.set('centralSyncRole', '')
  conf.set('centralSyncDisplayName', '')
  conf.set('centralSyncLastError', '')
  conf.set('centralSyncLastErrorAt', 0)
  crmDbService.setScanState(K_PERMISSION_SENT, 0)
  crmDbService.runTx((tx) => {
    tx.run('INSERT INTO audit_event (actor, action, entity_type, entity_id, detail, created_at) VALUES (?,?,?,?,?,?)',
      [String(ConfigService.getInstance().get('identityName') || 'unknown'), 'central_unbind', 'device', cfg.deviceId || null,
        JSON.stringify({ serverRevoked: revoked }), Date.now()])
  })
  // 解绑后调度器安全空转（配置不完整即不发起任何请求），定时器不重复创建
  restartCentralSyncScheduler()
  return { revoked, localCleared: true, error }
}

// ─── 单次同步 / 调度器 / 状态 ─────────────────────────────────────────────────

export async function runCentralSyncOnce(): Promise<CentralSyncRunResult> {
  const cfg = getCentralSyncConfig()
  if (!isConfigured(cfg)) return { enabled: false, pushed: 0, rejected: 0, applied: 0 }
  if (running) return { enabled: true, pushed: 0, rejected: 0, applied: 0, error: '同步正在运行' }
  running = true
  try {
    const client = clientOf(cfg)
    const up = await pushUp(client, cfg)
    const applied = await pullAndApply(client)
    clearError()
    return { enabled: true, pushed: up.pushed, rejected: up.rejected, applied }
  } catch (error) {
    return { enabled: true, pushed: 0, rejected: 0, applied: 0, error: recordError(error) }
  } finally { running = false }
}

export function centralSyncStatus(): CentralSyncStatus {
  const cfg = getCentralSyncConfig()
  const conf = ConfigService.getInstance()
  return {
    enabled: cfg.enabled, configured: isConfigured(cfg), baseUrl: cfg.baseUrl,
    workspaceId: cfg.workspaceId, employeeId: cfg.employeeId, deviceId: cfg.deviceId,
    role: cfg.role, displayName: cfg.displayName || String(conf.get('identityName') || ''),
    backlogPending: Number(crmDbService.all("SELECT COUNT(*) AS c FROM outbox_event WHERE status='pending'")[0]?.c || 0),
    pullCursor: crmDbService.getScanState(K_PULL_CURSOR), lastUpAt: crmDbService.getScanState(K_LAST_UP),
    lastDownAt: crmDbService.getScanState(K_LAST_DOWN),
    lastError: String(conf.get('centralSyncLastError') || ''), lastErrorAt: Number(conf.get('centralSyncLastErrorAt') || 0),
    running, schedulerRunning: heartbeat !== null, polling: isConfigured(cfg), pollIntervalMin: cfg.pollIntervalMin
  }
}

/** 心跳每一拍重新读配置：轮询间隔、开关、绑定状态变更都会在下一拍自然生效 */
function schedulerTick(): void {
  const cfg = getCentralSyncConfig()
  if (!isConfigured(cfg)) return // 未绑定/已解绑：安全空转，不发起任何请求
  const now = Date.now()
  if (now - lastRunStartedAt < cfg.pollIntervalMin * 60_000) return
  lastRunStartedAt = now
  void runCentralSyncOnce()
}

/** 启动调度器（幂等）：绑定与否都常驻，绑定后无需重启进程即可开始同步 */
export function startCentralSyncScheduler(): void {
  if (!heartbeat) {
    heartbeat = setInterval(schedulerTick, HEARTBEAT_MS)
    heartbeat.unref?.()
  }
  if (!firstTimer) {
    firstTimer = setTimeout(() => { firstTimer = null; schedulerTick() }, STARTUP_GRACE_MS)
    firstTimer.unref?.()
  }
}

export function stopCentralSyncScheduler(): void {
  if (firstTimer) clearTimeout(firstTimer)
  if (heartbeat) clearInterval(heartbeat)
  firstTimer = null
  heartbeat = null
}

/** 绑定/解绑/间隔变更后调用：保证**只有一个**定时器，并立刻按新配置跑一拍 */
export function restartCentralSyncScheduler(): void {
  stopCentralSyncScheduler()
  lastRunStartedAt = 0
  startCentralSyncScheduler()
  void runCentralSyncOnce()
}
