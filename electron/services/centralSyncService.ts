/**
 * Phase 3a HTTP 同步 adapter。
 *
 * 复用 Phase 1 outbox、下行业务状态机与幂等标记；本文件只负责 HTTP 传输与游标推进。
 * 中央不可达时所有本机业务照常运行，pending/outbox 与 pull cursor 保留，下轮继续重放。
 *
 * 传输层纪律（PRD §7.1，替换 adapter 不换语义）：
 *  - 上行只从**既有业务表与 append-only 流水**投影（见 centralProjection.ts），禁止扫聊天表；
 *  - **上行载荷是显式最小白名单**：outbox 行的真实 payload 只用来定位「哪一行本地事实」，
 *    真正上线的内容由 centralProjection 的投影构造器从 canonical 表重建——原始手机号 / wxid /
 *    contactNormalized / contactRaw 永不出机（原先直接转发 outbox payload 是 P0 缺陷）；
 *  - 可变表用 `(updated_at, id)` 复合水位；幂等键带实体版本，实体 id 稳定 —— 改名、状态流转、
 *    金额阶段变化都能重新上行，且不会每次整表重传；
 *  - 业务上暂不可投影的行（无名称客户 / 未归并身份 / 未归并 account）**不阻塞**后续合法行：
 *    跳过照常推进水位，同时记入待重试台账，补齐后重新进入同步；
 *  - 下行只走既有 assign/transfer/recycle 状态机；中央专有的 supervisor_correction /
 *    permission_change / sla1 通知按 PRD 语义落「待确认 + 审计 + 收件箱」，绝不静默覆盖本地事实；
 *  - 所有下行指令过 shared/centralDownCommand 的**同一份**业务校验（与 SMB 入口共用，不复制规则）；
 *  - 无法在本机执行的指令终态回 invalid（重试有上限），不允许无限 retry 卡死队列。
 */
import { createHash } from 'crypto'
import { hostname } from 'os'
import type { CentralAckRequest, CentralSyncEvent } from '../../shared/centralSync'
import { findForbiddenCentralField, scopedRef } from '../../shared/centralSync'
import { validateCentralEntityId, validateDownCommand } from '../../shared/centralDownCommand'
import { maskContact as maskLeadContact } from './crmLeadImportCore'
import { ConfigService } from './config'
import { crmDbService, type CrmRow } from './crmDbService'
import { healLegacyDownPayload } from './crmDownPayloadCompat'
import { getTerminalId, applyDownEventDirect, maskAuditText, type DeliveryRole, type SyncEventFile } from './lanSyncService'
import { recordSupervisorNotificationTx } from './crmNotifyService'
import { CentralSyncClient, CentralSyncHttpError, type CentralPrincipal } from './centralSyncClient'
import { LOCAL_PROJECTIONS, projectionByKey, type ProjectionDraft, type ProjectionWatermark } from './centralProjection'

const K_PULL_CURSOR = 'centralSync:pullCursor'
const K_LAST_UP = 'centralSync:lastUpAt'
const K_LAST_DOWN = 'centralSync:lastDownAt'
const K_PERMISSION_SENT = 'centralSync:permissionSent'
const K_AUDIT_CURSOR = 'centralSync:auditCursor'
/** 审计投影的游标键沿用 Phase 1 既有 key，避免升级后重放整表 */
const AUDIT_CURSOR_ALIAS: Record<string, string> = { audit: K_AUDIT_CURSOR }
/** 跳过台账前缀：`centralSync:skip:<投影>:<本地引用>`，值 = 最近一次复核时间 */
const SKIP_LEDGER_PREFIX = 'centralSync:skip:'

const PUSH_BATCH = 50
const PULL_BATCH = 100
/** 单轮复核的跳过行上限：跳过台账必须逐轮回扫，否则「补齐后重新进入同步」永远不成立 */
const SKIP_RECHECK_BATCH = 20
/** 下行事件最大重试次数：超过即回 invalid 终态，防止一条本机无法执行的事件卡死整条队列 */
const MAX_DOWN_ATTEMPTS = 5
/** 上行 outbox 行最大尝试次数：无法解析目标 / 本地事实缺失时有限重试，超限转 failed + 审计 */
const MAX_OUTBOX_ATTEMPTS = 5
/** 员工目录缓存时长：解析失败不缓存，避免一次网络抖动让后续每轮都漏投 */
const DIRECTORY_TTL_MS = 5 * 60_000
/** 调度器心跳（分钟）：实际执行间隔由 centralSyncPollIntervalMin 决定，间隔变更下一拍即生效 */
const HEARTBEAT_MS = 60_000
/** 启动后首跑宽限：避开应用启动高峰，不与应用初始化抢资源 */
const STARTUP_GRACE_MS = 45_000

let heartbeat: NodeJS.Timeout | null = null
let firstTimer: NodeJS.Timeout | null = null
let running = false
let lastRunStartedAt = 0
let directoryCache: { at: number; employees: DirectoryEmployee[] } | null = null

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
  /** 终态失败、可经「重试失败同步项」正式重投的行数 */
  backlogFailed: number
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

/** 复合水位的毫秒分量键（id 分量沿用 cursorKeyOf，保持既有键名可读） */
function watermarkKeyOf(projectionKey: string): string {
  return `${cursorKeyOf(projectionKey)}:ts`
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

/** 本机审计留痕（只写字段路径与稳定错误码，绝不写被拦下的字段值） */
function audit(action: string, entityType: string, entityId: string | null, detail: Record<string, unknown>): void {
  crmDbService.runTx((tx) => {
    tx.run('INSERT INTO audit_event (actor, action, entity_type, entity_id, detail, created_at) VALUES (?,?,?,?,?,?)',
      ['system:sync', action, entityType, entityId, JSON.stringify(detail), Date.now()])
  })
}

// ─── 员工目录解析契约（§三.5）────────────────────────────────────────────────
/**
 * 中央侧唯一的员工解析依据：`employee.role` + 设备绑定（服务端权威）。
 * 本机 `salesName` 只是显示名，**绝不按名字猜人**：
 *   ① 本机显式别名（设置页 centralSyncEmployeeAlias，`{"张三":"EMP-0007"}`）优先，绑定 stable employeeCode；
 *   ② 否则要求目录里存在**唯一**同名员工；
 *   ③ 0 命中 = employee_unresolved，>1 命中 = employee_ambiguous —— 两种都显式报错并保持 pending。
 */
export interface DirectoryEmployee {
  employeeId: string
  employeeCode: string
  displayName: string
  role: string
  nameUnique: boolean
}

async function fetchDirectory(client: CentralSyncClient): Promise<DirectoryEmployee[]> {
  if (directoryCache && Date.now() - directoryCache.at < DIRECTORY_TTL_MS) return directoryCache.employees
  const employees = await client.directory()
  directoryCache = { at: Date.now(), employees }
  return employees
}

/** 本机显式别名表（设置页配置）：显示名 → 稳定员工编号；坏 JSON 视为未配置，不猜 */
function localEmployeeAlias(): Record<string, string> {
  const raw = String(ConfigService.getInstance().get('centralSyncEmployeeAlias') || '').trim()
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const out: Record<string, string> = {}
    for (const [name, code] of Object.entries(parsed)) {
      const key = String(name).trim()
      const value = String(code ?? '').trim()
      if (key && value) out[key] = value
    }
    return out
  } catch { return {} }
}

export function resolveDirectoryEmployee(
  employees: DirectoryEmployee[], salesName: string, alias = localEmployeeAlias()
): { employee: DirectoryEmployee } | { error: string } {
  const name = String(salesName || '').trim()
  if (!name) return { error: 'employee_unresolved:归属人为空' }
  const code = alias[name]
  if (code) {
    const byCode = employees.find((item) => item.employeeCode === code)
    if (byCode) return { employee: byCode }
    return { error: `employee_unresolved:别名 ${name}→${code} 在中央目录中不存在` }
  }
  const hits = employees.filter((item) => item.displayName.trim() === name)
  if (hits.length === 1) return { employee: hits[0]! }
  if (hits.length > 1) return { error: `employee_ambiguous:${name} 在中央目录中有 ${hits.length} 个同名员工，请在设置页配置员工编号别名` }
  return { error: `employee_unresolved:中央目录中找不到 ${name}，请在设置页配置员工编号别名` }
}

// ─── 上行 outbox 路由表（§三.1 全量盘点）────────────────────────────────────
/**
 * 每个 outbox 事件类型的**方向 / 落点**都在此显式登记，未登记类型一律隔离（不静默跳过）。
 *  - projection：该事件是**本地事实的即时触发**——真实 payload 只用于定位本地行，
 *    上线内容由 centralProjection 的同一构造器重建（与增量扫描共用一份字段白名单，
 *    因此这里产出的 idempotencyKey 与扫描完全一致，中央按 key 去重不会重复入库）；
 *  - command：本地分配动作必须走中央指令链，**不得**伪装成 direction=up 的上行投影
 *    （/sync/push 只收上行投影，指令走 /sync/commands，服务端按 command.issue 授权）。
 */
type OutboxRoute =
  | { kind: 'projection'; projectionKey: string; refOf: (payload: Record<string, unknown>) => string | null }
  | { kind: 'command'; commandType: string }

function assignmentRefOf(payload: Record<string, unknown>): string | null {
  const explicit = Number(payload.assignmentId || 0)
  if (Number.isInteger(explicit) && explicit > 0) return `assignment:${explicit}`
  const leadId = Number(payload.leadId || 0)
  if (!Number.isInteger(leadId) || leadId <= 0) return null
  // 首触不携带 assignmentId：用该线索**当前轮次**的分配行（转派会新建行，最新行 = 本轮）
  const row = crmDbService.all(
    "SELECT id FROM assignment WHERE lead_id = ? AND deleted = 0 AND status IN ('assigned','claimed') ORDER BY id DESC LIMIT 1",
    [leadId])[0]
  return row ? `assignment:${Number(row.id)}` : null
}

const OUTBOX_ROUTES: Record<string, OutboxRoute> = {
  claim: { kind: 'projection', projectionKey: 'assignment', refOf: assignmentRefOf },
  first_touch: { kind: 'projection', projectionKey: 'assignment', refOf: assignmentRefOf },
  bind_wx: {
    kind: 'projection', projectionKey: 'customer_identity',
    refOf: (payload) => (Number(payload.identityId || 0) > 0 ? `identity:${Number(payload.identityId)}` : null)
  },
  assign: { kind: 'command', commandType: 'assign' },
  transfer: { kind: 'command', commandType: 'transfer' },
  recycle: { kind: 'command', commandType: 'recycle' },
  sla1_escalate_supervisor: { kind: 'command', commandType: 'sla1_escalate_supervisor' }
}

/** outbox 事件类型清单（导出供契约测试断言「所有类型都有方向」） */
export const OUTBOX_ROUTED_TYPES = Object.keys(OUTBOX_ROUTES)

// ─── 上行：投影 ────────────────────────────────────────────────────────────────

/** 投影草稿 → 传输信封：entityId 与 payload 引用同一命名空间，幂等键带版本 */
function envelopeOf(draft: ProjectionDraft, cfg: CentralSyncConfig, eventSeq?: number): CentralSyncEvent {
  const entityId = scopedRef(cfg.deviceId, draft.localRef)
  // 幂等键必须含**实体版本**：同一实体的新版本是不同的业务事件，而 entityId 必须保持稳定
  const idempotencyKey = `${cfg.deviceId}/${draft.entityType}/${draft.localRef}#v${draft.aggregateVersion}`
  return {
    protocolVersion: 1, eventId: stableEventId(cfg.deviceId, idempotencyKey),
    eventSeq: Math.max(1, eventSeq === undefined ? draft.eventSeq : eventSeq),
    idempotencyKey, direction: 'up', entityType: draft.entityType, entityId,
    eventType: draft.eventType, aggregateVersion: Math.max(0, draft.aggregateVersion), payload: draft.payload,
    occurredAt: draft.occurredAt > 0 ? draft.occurredAt : Date.now()
  }
}

/**
 * 上行前自检：命中禁字段 / 引用命名空间不合法 → 该条不发，**同一行同一原因只记一次审计**
 * （否则每轮都写同一条审计，会把审计表刷爆）。
 */
function selfGuard(draft: ProjectionDraft, cfg: CentralSyncConfig): string | null {
  const forbidden = findForbiddenCentralField(draft.payload)
  if (forbidden) return `forbidden_field:${forbidden}`
  const badId = validateCentralEntityId(draft.entityType, scopedRef(cfg.deviceId, draft.localRef))
  return badId
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

/** 中央拒收码是否属于「契约错误」：这类错误重推不会改变结论，可推进水位并留一次审计 */
function isPermanentReject(code: string): boolean {
  return code === 'event_rejected' || code.startsWith('forbidden_field') || code.startsWith('unknown_field') ||
    code.startsWith('missing_required') || code.startsWith('invalid_entity') || code.startsWith('entity_')
}

// ─── 上行：outbox ─────────────────────────────────────────────────────────────

/**
 * 解析一条 outbox 行的路由；返回 null 表示类型未登记（违契约，隔离而不是静默跳过）。
 * ⚠️ 这里**不做** LIMIT 之后再按类型过滤：队首若有未登记类型，必须先让它出队（隔离），
 * 否则后面的合法事件会被永远饿死（§三.8）。
 */
function routeOutboxRow(row: CrmRow): { type: string; route: OutboxRoute; payload: Record<string, unknown> } | null {
  let payload: Record<string, unknown>
  try { payload = JSON.parse(String(row.payload || '{}')) } catch { return null }
  const type = payload.type
  if (typeof type !== 'string' || !type) return null
  const route = OUTBOX_ROUTES[type]
  return route ? { type, route, payload } : null
}

function outboxAttempts(rowId: number): number {
  return Number(crmDbService.getScanState(`centralSync:outboxAttempt:${rowId}`) || 0)
}

/** 上行 outbox 行结算：只有中央确认受理才置 sent；契约错误终态 failed + 审计 */
function settleOutboxRow(rowId: number, status: 'sent' | 'failed', detail: Record<string, unknown>): void {
  crmDbService.runTx((tx) => {
    tx.run("UPDATE outbox_event SET status = ?, updated_at = ? WHERE id = ? AND status = 'pending'", [status, Date.now(), rowId])
    tx.run('INSERT INTO audit_event (actor, action, entity_type, entity_id, detail, created_at) VALUES (?,?,?,?,?,?)',
      ['system:sync', status === 'sent' ? 'sync_outbox_settled' : 'sync_outbox_failed', 'outbox_event', String(rowId),
        JSON.stringify(detail), Date.now()])
  })
}

/** 未到终态的失败：留在 pending 等下一轮（瞬时网络错误与「依赖尚未就绪」都属于这一类） */
function deferOutboxRow(rowId: number, reason: string, attempts: number): void {
  crmDbService.setScanState(`centralSync:outboxAttempt:${rowId}`, attempts)
  if (attempts < MAX_OUTBOX_ATTEMPTS) return
  settleOutboxRow(rowId, 'failed', { reason, attempts })
}

/** 推送一条 outbox 行（投影触发路径）：真实 payload 只用于定位本地行，载荷由投影构造器重建 */
async function pushOutboxProjection(
  client: CentralSyncClient, cfg: CentralSyncConfig, row: CrmRow,
  route: Extract<OutboxRoute, { kind: 'projection' }>, payload: Record<string, unknown>
): Promise<{ pushed: number; rejected: number }> {
  const rowId = Number(row.id)
  const localRef = route.refOf(payload)
  if (!localRef) return { pushed: 0, rejected: 0 } // 缺锚点：交给调用方按尝试次数收敛
  const projection = projectionByKey(route.projectionKey)
  const draft = projection?.recheck(localRef, cfg.deviceId)
  if (!draft) {
    settleOutboxRow(rowId, 'failed', { reason: 'source_fact_missing', projection: route.projectionKey, localRef })
    return { pushed: 0, rejected: 1 }
  }
  if (!('payload' in draft)) {
    // 本地事实还在（例如身份尚未归并）：有限重试后转终态，绝不假装同步成功
    deferOutboxRow(rowId, String(draft.reason), outboxAttempts(rowId) + 1)
    return { pushed: 0, rejected: 0 }
  }
  const bad = selfGuard(draft, cfg)
  if (bad) {
    settleOutboxRow(rowId, 'failed', { reason: bad, localRef })
    return { pushed: 0, rejected: 1 }
  }
  const event = envelopeOf(draft, cfg, Number(row.event_seq))
  const outcome = await pushBatch(client, [event], `outbox:${cfg.deviceId}:${rowId}`)
  if (outcome.acceptedIds.has(event.eventId)) {
    settleOutboxRow(rowId, 'sent', { projection: route.projectionKey, localRef, aggregateVersion: draft.aggregateVersion })
    return { pushed: 1, rejected: 0 }
  }
  const code = outcome.rejected[0]?.code || 'rejected'
  // 更晚的版本已上线 → 该事实已由更新的版本承载，本行无需重推（如实记录，不谎报成功）
  if (isPermanentReject(code)) {
    settleOutboxRow(rowId, 'failed', { reason: code, localRef })
    return { pushed: 0, rejected: 1 }
  }
  deferOutboxRow(rowId, code, outboxAttempts(rowId) + 1)
  return { pushed: 0, rejected: 0 }
}

// ─── 上行：指令链（§三.3-6）─────────────────────────────────────────────────

/**
 * 中央下行指令的 lead 子对象白名单：**只带目标设备建档必需字段**。
 * 相比 SMB 同机投递，去掉 contactRaw（与 contactNormalized 重复的原文副本）与 wechat
 * （wxid 原文；contactType=wxid 时 contactNormalized 本身就是该值）——过中央服务器时多一个原文
 * 就多一份出机面，这里显式最小化。
 */
export const CENTRAL_COMMAND_LEAD_FIELDS = ['leadId', 'name', 'contactType', 'contactNormalized', 'source', 'note'] as const

function commandLeadOf(leadId: unknown): Record<string, unknown> | null {
  if (typeof leadId !== 'number' || !Number.isSafeInteger(leadId) || leadId <= 0) return null
  const id = leadId
  const lead = crmDbService.all('SELECT * FROM lead WHERE id = ?', [id])[0]
  if (!lead) return null
  return {
    leadId: id, name: String(lead.name || ''), contactType: String(lead.contact_type || 'phone'),
    contactNormalized: String(lead.contact_normalized || ''), source: String(lead.source || ''),
    note: String(lead.note || '')
  }
}

/** 指令 payload：严格按注册表白名单逐字段挑，绝不 spread outbox payload */
function commandPayloadOf(commandType: string, payload: Record<string, unknown>, leadId: unknown): Record<string, unknown> {
  const common = { type: commandType, leadId }
  if (commandType === 'assign') {
    const out: Record<string, unknown> = {
      ...common, deliveryRole: 'apply', assignmentId: payload.assignmentId,
      // 仅缺失/undefined 使用系统默认；显式 null 必须原样进入共享校验，不能被静默当成省略。
      salesName: payload.salesName, actor: payload.actor === undefined ? 'system:sync' : payload.actor,
      lead: commandLeadOf(leadId)
    }
    // 可选字段只在原始载荷实际出现时透传；不把对象/数组/数字洗成字符串或时间戳。
    if (Object.prototype.hasOwnProperty.call(payload, 'mode')) out.mode = payload.mode
    if (Object.prototype.hasOwnProperty.call(payload, 'sla1Deadline')) out.sla1Deadline = payload.sla1Deadline
    return out
  }
  if (commandType === 'recycle') {
    return {
      ...common, deliveryRole: 'apply', assignmentId: payload.assignmentId,
      salesName: payload.salesName, reason: payload.reason,
      actor: payload.actor === undefined ? 'system:sync' : payload.actor
    }
  }
  // 移交：单条 outbox 行 → 两条下行指令（接收方 apply / 原归属 remove）。
  // lead 与 assign 走同一个 commandLeadOf()，不另建一份线索构造逻辑。
  // sla1Deadline/mode 直接透传出事时确定的绝对值（注册表 transfer 已将其列为必填，
  // 接收端落地精确等于本值，不按接收端配置/时钟重算）。
  if (commandType === 'transfer') {
    return {
      ...common, deliveryRole: 'apply', assignmentId: payload.assignmentId,
      oldAssignmentId: payload.oldAssignmentId,
      fromSales: payload.fromSales, toSales: payload.toSales,
      reason: payload.reason, mode: payload.mode,
      sla1Deadline: payload.sla1Deadline,
      actor: payload.actor === undefined ? 'system:sync' : payload.actor,
      lead: commandLeadOf(leadId)
    }
  }
  if (commandType === 'sla1_escalate_supervisor') {
    const lead = crmDbService.all('SELECT contact_type, contact_normalized FROM lead WHERE id = ?', [leadId])[0]
    // 通知正文里的联系方式只出**掩码**（与 SMB 落地口径一致：掩码是 PRD §10 R4 允许上线的形态）
    const contactMasked = lead
      ? maskLeadContact({ contactType: String(lead.contact_type || 'phone') as 'phone' | 'wechat' | 'both', contactNormalized: String(lead.contact_normalized || '') })
      : ''
    return {
      ...common, deliveryRole: 'notify', assignmentId: payload.assignmentId,
      salesName: payload.salesName, remindCount: payload.remindCount,
      reason: payload.reason, recycledAt: payload.recycledAt, contactMasked
    }
  }
  return {}
}

/**
 * 指令投递目标（§三.5/§三.6）：
 *  - sales：按归属人**显示名**解析成 stable employeeId（同名/查无此人显式报错，绝不猜人）；
 *  - supervisor：SLA1 三次超时的升级通知专用——按角色/员工编号解析，通知落在主管工作机。
 */
type CommandTarget =
  | { kind: 'sales'; salesName: string; role: DeliveryRole }
  | { kind: 'supervisor'; role: DeliveryRole }

/** 一条指令要投给谁：assign/recycle → 归属人；transfer → 接收方(apply) + 原归属(remove) */
function commandTargetsOf(commandType: string, payload: Record<string, unknown>): CommandTarget[] {
  if (commandType === 'assign' || commandType === 'recycle') {
    const salesName = typeof payload.salesName === 'string' ? payload.salesName.trim() : ''
    return salesName ? [{ kind: 'sales', salesName, role: 'apply' }] : []
  }
  if (commandType === 'transfer') {
    const to = typeof payload.toSales === 'string' ? payload.toSales.trim() : ''
    const from = typeof payload.fromSales === 'string' ? payload.fromSales.trim() : ''
    const out: CommandTarget[] = []
    if (to) out.push({ kind: 'sales', salesName: to, role: 'apply' })
    if (from) out.push({ kind: 'sales', salesName: from, role: 'remove' })
    return out
  }
  // 升级通知必须有明确落点（Phase 1 口径：主管工作机消费通知 → notify_inbox），不得无目标空转
  if (commandType === 'sla1_escalate_supervisor') return [{ kind: 'supervisor', role: 'notify' }]
  return []
}

/**
 * SLA1 升级通知的主管目标（§三.6「明确的中央投递目标与通知落点」）。**绝不按显示名猜人**：
 *   ① 设置页显式配置的主管员工编号（stable employeeCode）优先；
 *   ② 未配置时取目录中角色为 supervisor 的员工：唯一 → 投给他；
 *   ③ 查无主管 / 多名主管且未配置编号 → 显式报错并保持 pending（超限转 failed + 审计）。
 */
function resolveSupervisorTargets(employees: DirectoryEmployee[]): DirectoryEmployee[] | { error: string } {
  const code = String(ConfigService.getInstance().get('centralSyncSupervisorCode') || '').trim()
  if (code) {
    const hits = employees.filter((item) => item.employeeCode === code)
    if (hits.length === 1) return hits
    if (hits.length > 1) return { error: `supervisor_ambiguous:员工编号 ${code} 在中央目录中有 ${hits.length} 条` }
    return { error: `supervisor_unresolved:中央目录中找不到主管员工编号 ${code}` }
  }
  const supervisors = employees.filter((item) => item.role === 'supervisor')
  if (supervisors.length === 1) return supervisors
  if (supervisors.length > 1) return { error: `supervisor_ambiguous:工作区内有 ${supervisors.length} 名主管，请在设置页配置主管员工编号` }
  return { error: 'supervisor_unresolved:工作区内没有主管员工，升级通知无处投递' }
}

/** 目标解析失败：显式报错并保持 pending，只有到重试上限才转 failed + 审计（绝不假装成功） */
function deferUnresolvedTarget(rowId: number, commandType: string, reason: string): { pushed: number; rejected: number } {
  deferOutboxRow(rowId, reason, outboxAttempts(rowId) + 1)
  if (outboxAttempts(rowId) >= MAX_OUTBOX_ATTEMPTS) {
    audit('sync_employee_unresolved', 'outbox_event', String(rowId), { commandType, reason })
  }
  return { pushed: 0, rejected: 0 }
}

function commandEnvelope(
  cfg: CentralSyncConfig, commandType: string, payload: Record<string, unknown>, target: DirectoryEmployee, row: CrmRow
): CentralSyncEvent {
  const rawKey = String(row.idempotency_key || '')
  const idempotencyKey = `${cfg.deviceId}/${rawKey}#${payload.deliveryRole}#${target.employeeId}`
  const leadId = Number(payload.leadId || 0)
  return {
    protocolVersion: 1, eventId: stableEventId(cfg.deviceId, idempotencyKey),
    eventSeq: Number(row.event_seq), idempotencyKey, direction: 'down',
    entityType: 'assignment', entityId: scopedRef(cfg.deviceId, `assignment:${Number(payload.assignmentId || 0) || leadId}`),
    eventType: commandType, aggregateVersion: 1, payload,
    targetEmployeeId: target.employeeId, occurredAt: Number(row.created_at || Date.now())
  }
}

/** 推送一条 outbox 行（指令链路径）：本地分配动作经中央转为对该员工的显式下行指令 */
async function pushOutboxCommand(
  client: CentralSyncClient, cfg: CentralSyncConfig, row: CrmRow,
  commandType: string, payload: Record<string, unknown>
): Promise<{ pushed: number; rejected: number }> {
  const rowId = Number(row.id)
  // 升级兼容（惰性）：升级前产生的 pending transfer 载荷缺 mode/sla1Deadline，而注册表已把它们列为
  // 必填。这里从本机 assignment 行恢复**当时已写入的绝对值**，绝不按当前时间/当前 SLA 配置重算。
  // 恢复不了就**不猜值、不发送**：整行终态 failed + 脱敏审计（只带行号与稳定错误码），等人工处理。
  const healed = healLegacyDownPayload(commandType, payload)
  if (!healed.ok) {
    settleOutboxRow(rowId, 'failed', { reason: healed.code, commandType })
    return { pushed: 0, rejected: 1 }
  }
  const body0 = healed.payload
  const leadId = body0.leadId
  const targets = commandTargetsOf(commandType, body0)
  if (!targets.length) {
    settleOutboxRow(rowId, 'failed', { reason: 'missing_target_sales', commandType })
    return { pushed: 0, rejected: 1 }
  }
  const employees = await fetchDirectory(client)
  // 派发人（主管/分配员）只对 supervisor_correction / permission_change 有意义，不在本轮 outbox 清单里
  const recipients: Array<{ target: DirectoryEmployee; role: DeliveryRole }> = []
  for (const item of targets) {
    if (item.kind === 'supervisor') {
      const resolved = resolveSupervisorTargets(employees)
      if ('error' in resolved) return deferUnresolvedTarget(rowId, commandType, resolved.error)
      for (const employee of resolved) recipients.push({ target: employee, role: item.role })
      continue
    }
    const resolved = resolveDirectoryEmployee(employees, item.salesName)
    // 同名或解析不到 **绝不猜人**：显式报错并保持 pending，超限后转 failed + 审计
    if ('error' in resolved) return deferUnresolvedTarget(rowId, commandType, resolved.error)
    recipients.push({ target: resolved.employee, role: item.role })
  }
  // 逐目标投递：一条 outbox 行可能对应多个接收方（transfer 的 apply + remove）。
  // 只有**全部**目标都被中央确认受理才置 sent；任一目标失败都不许假装整行成功。
  let pushed = 0
  for (const item of recipients) {
    const body = commandPayloadOf(commandType, body0, leadId)
    body.deliveryRole = item.role
    const event = commandEnvelope(cfg, commandType, body, item.target, row)
    const invalid = validateDownCommand({
      eventType: event.eventType, entityType: event.entityType, payload: body,
      targetEmployeeId: event.targetEmployeeId, targetDeviceId: event.targetDeviceId
    }, 'central-http')
    if (invalid) {
      settleOutboxRow(rowId, 'failed', { reason: invalid, commandType, failedRole: item.role, failedTarget: item.target.employeeId, delivered: pushed })
      return { pushed, rejected: 1 }
    }
    try {
      await client.issueCommand(event)
    } catch (error) {
      // 中央明确拒收（4xx）：契约/权限问题，重试无用 —— 整行终态 failed，如实记录已送达几个目标
      // （failedRole + failedTarget + delivered：人工修复需要知道「谁已受理、谁被拒」，防止
      //  两个销售设备各持有效归属而无人知晓；审计只带稳定员工标识，不带客户数据）
      if (error instanceof CentralSyncHttpError && error.status >= 400 && error.status < 500) {
        settleOutboxRow(rowId, 'failed', {
          reason: `http_${error.status}:${error.code}`, commandType, failedRole: item.role,
          failedTarget: item.target.employeeId, delivered: pushed
        })
        return { pushed, rejected: 1 }
      }
      // 瞬时失败（网络 / 5xx）：**保持 pending** 交给下一轮。已送达目标由中央按幂等键去重
      // （同 eventId + 同 key → duplicate），未送达目标在下一轮继续投递，
      // 因此顺序重试本身就能收敛「部分成功」，无需另建发送状态表。
      throw error
    }
    pushed++
  }
  settleOutboxRow(rowId, 'sent', { commandType, recipients: recipients.length })
  return { pushed, rejected: 0 }
}

/** 单轮上行 outbox：按 event_seq 顺序处理，逐行独立结算（一行失败不影响其它行） */
async function pushOutbox(client: CentralSyncClient, cfg: CentralSyncConfig): Promise<{ pushed: number; rejected: number }> {
  // ⚠️ 不带类型过滤地取队首（§三.8）：先 LIMIT 再按类型过滤会让未支持类型饿死后面的合法事件
  const rows = crmDbService.all("SELECT * FROM outbox_event WHERE status='pending' ORDER BY event_seq LIMIT ?", [PUSH_BATCH])
  let pushed = 0
  let rejected = 0
  for (const row of rows) {
    const routed = routeOutboxRow(row)
    if (!routed) {
      // 类型未登记（协议外/损坏）：隔离为终态 + 审计，绝不静默跳过、也绝不卡住队列头
      settleOutboxRow(Number(row.id), 'failed', { reason: 'unregistered_outbox_type' })
      rejected++
      continue
    }
    const { route, payload } = routed
    try {
      const outcome = route.kind === 'projection'
        ? await pushOutboxProjection(client, cfg, row, route, payload)
        : await pushOutboxCommand(client, cfg, row, route.commandType, payload)
      pushed += outcome.pushed
      rejected += outcome.rejected
    } catch (error) {
      // 网络 / 5xx：整批不动，保留 pending 下轮重放（不能把瞬时故障记成契约错误）
      if (error instanceof CentralSyncHttpError && error.status >= 400 && error.status < 500) {
        settleOutboxRow(Number(row.id), 'failed', { reason: `http_${error.status}:${error.code}` })
        rejected++
        continue
      }
      throw error
    }
  }
  return { pushed, rejected }
}

// ─── 上行：投影增量（§四 / §五）──────────────────────────────────────────────

function readWatermark(projectionKey: string): ProjectionWatermark {
  return {
    ts: crmDbService.getScanState(watermarkKeyOf(projectionKey)),
    id: crmDbService.getScanState(cursorKeyOf(projectionKey))
  }
}

function writeWatermark(projectionKey: string, watermark: ProjectionWatermark): void {
  crmDbService.setScanState(watermarkKeyOf(projectionKey), watermark.ts)
  crmDbService.setScanState(cursorKeyOf(projectionKey), watermark.id)
}

function skipLedgerKey(projectionKey: string, localRef: string): string {
  return `${SKIP_LEDGER_PREFIX}${projectionKey}:${localRef}`
}

function deleteScanState(key: string): void {
  crmDbService.runTx((tx) => { tx.run('DELETE FROM scan_state WHERE key = ?', [key]) })
}

/** 记录跳过行：**首次**记一次审计，之后只更新复核时间（§五.4：不得每分钟重写同一条审计） */
function noteSkipped(projectionKey: string, localRef: string, reason: string): void {
  const key = skipLedgerKey(projectionKey, localRef)
  const known = crmDbService.getScanState(key) > 0
  crmDbService.setScanState(key, Date.now())
  if (known) return
  audit('sync_projection_skipped', projectionKey, localRef, { reason })
}

/**
 * 回扫跳过台账：补齐后的行必须能重新进入同步（§五.3）。
 * `alreadyEmitted` = 本拍扫描已产出的幂等键：同一行补齐后既会被台账复核到、也会被增量水位扫到，
 * 不排重就会把**同一版本投递两次**（中央按幂等键去重不会写重复业务行，但白跑一次网络
 * 且看起来像两条业务事件）。命中即清台账，不重复投递。
 */
async function recheckSkipped(
  client: CentralSyncClient, cfg: CentralSyncConfig, projectionKey: string, alreadyEmitted: Set<string> = new Set()
): Promise<number> {
  const rows = crmDbService.all(
    "SELECT key FROM scan_state WHERE key LIKE ? ORDER BY last_scan LIMIT ?",
    [`${SKIP_LEDGER_PREFIX}${projectionKey}:%`, SKIP_RECHECK_BATCH])
  if (!rows.length) return 0
  const projection = projectionByKey(projectionKey)
  if (!projection) return 0
  let pushed = 0
  for (const row of rows) {
    const ledgerKey = String(row.key)
    const localRef = ledgerKey.slice(`${SKIP_LEDGER_PREFIX}${projectionKey}:`.length)
    const draft = projection.recheck(localRef, cfg.deviceId)
    if (!draft) { deleteScanState(ledgerKey); continue } // 本地行已不存在：台账清掉
    if (!('payload' in draft)) { crmDbService.setScanState(ledgerKey, Date.now()); continue }
    const bad = selfGuard(draft, cfg)
    if (bad) { crmDbService.setScanState(ledgerKey, Date.now()); continue }
    const event = envelopeOf(draft, cfg)
    if (alreadyEmitted.has(event.idempotencyKey)) { deleteScanState(ledgerKey); continue }
    const outcome = await pushBatch(client, [event], `skipped:${cfg.deviceId}:${projectionKey}:${localRef}`)
    if (!outcome.acceptedIds.has(event.eventId) && !isPermanentReject(outcome.rejected[0]?.code || '')) continue
    deleteScanState(ledgerKey)
    pushed++
  }
  return pushed
}

/**
 * 推送一个投影的增量批次。
 * 水位推进规则（§四.3 同毫秒竞态）：本页没读满且最后一行的时间戳落在本轮开始毫秒内时，
 * 水位只推进到 `(该毫秒, 0)`，下一轮重扫这一毫秒——否则同毫秒写入但 id 更小的行会被永久漏掉。
 * 被中央**契约性拒收**的事件是终态，水位照常推进并留一次审计；网络失败整批抛出，水位不动。
 */
async function pushProjection(client: CentralSyncClient, cfg: CentralSyncConfig, projectionKey: string): Promise<{ pushed: number; rejected: number }> {
  const projection = projectionByKey(projectionKey)
  if (!projection) return { pushed: 0, rejected: 0 }
  const roundStartMs = Date.now()
  const cursor = readWatermark(projectionKey)
  const page = projection.read(cursor, PUSH_BATCH, cfg.deviceId)
  for (const skip of page.skipped) noteSkipped(projectionKey, skip.localRef, skip.reason)
  // 先算出本拍扫描要投递的事件，再回扫台账：两边取并集去重，同一版本只投一次
  const events: CentralSyncEvent[] = []
  let rejected = 0
  for (const draft of page.drafts) {
    const bad = selfGuard(draft, cfg)
    if (bad) {
      noteSkipped(projectionKey, draft.localRef, bad)
      rejected++
      continue
    }
    events.push(envelopeOf(draft, cfg))
  }
  let pushed = await recheckSkipped(client, cfg, projectionKey, new Set(events.map((e) => e.idempotencyKey)))
  if (events.length) {
    for (const batch of chunk(events, PUSH_BATCH)) {
      const outcome = await pushBatch(client, batch, `projection:${cfg.deviceId}:${projection.key}:${batch[0]!.eventSeq}`)
      pushed += outcome.acceptedIds.size
      rejected += outcome.rejected.length
      const permanent = outcome.rejected.filter((item) => isPermanentReject(item.code))
      if (permanent.length) {
        crmDbService.runTx((tx) => {
          for (const item of permanent.slice(0, 20)) {
            tx.run('INSERT INTO audit_event (actor, action, entity_type, entity_id, detail, created_at) VALUES (?,?,?,?,?,?)',
              ['system:sync', 'sync_push_rejected', projection.entityType, item.eventId,
                JSON.stringify({ code: item.code }), Date.now()])
          }
        })
      }
    }
  }
  if (page.scanned > 0) {
    const next = page.full || page.watermark.ts < roundStartMs
      ? page.watermark
      : { ts: page.watermark.ts, id: 0 }
    if (next.ts > cursor.ts || (next.ts === cursor.ts && next.id > cursor.id)) writeWatermark(projectionKey, next)
  }
  return { pushed, rejected }
}

/** 一次性声明本机身份档案声明的角色（**展示与审计用，绝不作为权限依据**） */
async function pushPermissionDeclaration(client: CentralSyncClient, cfg: CentralSyncConfig): Promise<number> {
  if (crmDbService.getScanState(K_PERMISSION_SENT) > 0) return 0
  const conf = ConfigService.getInstance()
  const employeeRef = String(conf.get('identityName') || '').trim() || cfg.employeeId
  const declaredRole = cfg.role || String(conf.get('identityRole') || '').trim() || 'sales'
  const idempotencyKey = `${cfg.deviceId}/permission/${declaredRole}#v1`
  const event: CentralSyncEvent = {
    protocolVersion: 1, eventId: stableEventId(cfg.deviceId, idempotencyKey), eventSeq: 1, idempotencyKey,
    direction: 'up', entityType: 'permission', entityId: scopedRef(cfg.deviceId, 'permission'),
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
/** 本适配器新增/接管的下行类型（PRD §7 Phase 3a 下行清单） */
const CENTRAL_DOWN_TYPES = ['supervisor_correction', 'permission_change', 'sla1_escalate_supervisor']

/**
 * 中央下行事件 → 本机事件文件（HTTP 无文件/投递键概念，`to` 只是本机身份）。
 * **业务校验与 SMB 入口共用同一份** shared/centralDownCommand（§七.6），
 * 因此 applyDownEventDirect 不可能绕过 payload/角色/类型校验。
 */
function toLocalEvent(event: CentralSyncEvent & { centralSeq: number }): SyncEventFile | null {
  const known = STATEMACHINE_DOWN_TYPES.includes(event.eventType) || CENTRAL_DOWN_TYPES.includes(event.eventType)
  if (!known) return null
  const payload = (event.payload || {}) as Record<string, unknown>
  const invalid = validateDownCommand({
    eventType: event.eventType, entityType: event.entityType, payload,
    targetEmployeeId: event.targetEmployeeId, targetDeviceId: event.targetDeviceId
  }, 'central-http')
  if (invalid) return null
  return {
    eventSeq: event.eventSeq, idempotencyKey: event.idempotencyKey, type: event.eventType,
    deliveryRole: payload.deliveryRole as DeliveryRole,
    to: getTerminalId(), payload, emittedAt: event.occurredAt
  }
}

/**
 * 中央专有下行类型的本机落地（与既有状态机同事务纪律、同幂等口径）。
 *
 * PRD §7 Phase 3a 三条硬约束：
 *  - **主管修正不静默覆盖**：落 notify_inbox 待本地确认 + 审计，本地事实一行不改；
 *  - **权限只作声明**：落审计 + 展示配置，绝不进入本机访问控制判断；
 *  - **SLA1 升级通知有明确落地点**：落 notify_inbox（source='sync:down'）+ 审计。
 * 返回值与既有状态机同口径：'applied' | 'invalid'。
 */
function applyCentralOnlyDown(ev: SyncEventFile): 'applied' | 'invalid' {
  const now = Date.now()
  const key = `central:${ev.idempotencyKey}`
  if (ev.type === 'supervisor_correction') {
    return crmDbService.runTx((tx) => {
      if (tx.all('SELECT id FROM notify_inbox WHERE idempotency_key = ?', [key]).length) return 'applied'
      // toLocalEvent 已先通过共享 object 规则；这里只把「未携带 detail」映射为既有缺省值，
      // 不再把任何非法形态静默改成 {}，避免发送端以为内容已投递而接收端丢失。
      const detail = ev.payload.detail === undefined ? {} : ev.payload.detail as Record<string, unknown>
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
  if (ev.type === 'sla1_escalate_supervisor') {
    return crmDbService.runTx((tx) => {
      // 联系方式只以掩码形态到达（联系原文不跨机）；本机无对应 lead 时用掩码兜底显示
      recordSupervisorNotificationTx(tx, {
        idempotencyKey: ev.idempotencyKey,
        leadId: Number(ev.payload.leadId || 0),
        salesName: String(ev.payload.salesName || ''),
        remindCount: Number(ev.payload.remindCount || 3),
        reason: String(ev.payload.reason || 'SLA三次超时回收'),
        recycledAt: Number(ev.payload.recycledAt || ev.emittedAt),
        contactMasked: String(ev.payload.contactMasked || '')
      }, 'sync:down')
      // 幂等：已有同 key 行也算落地成功（重复投递不重复通知）
      return tx.all('SELECT id FROM notify_inbox WHERE idempotency_key = ?', [ev.idempotencyKey]).length > 0 ? 'applied' : 'invalid'
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
      // 不合法 / 本机不认识的事件类型：**不是**可重试状态。重试不会改变结果，直接回终态 invalid。
      acknowledgements.push({ centralSeq: event.centralSeq, eventId: event.eventId, outcome: 'invalid',
        detail: `指令未通过下行业务校验或本机不支持：${event.eventType}` })
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
  directoryCache = null
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
  directoryCache = null
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

// ─── 失败项查询与正式重投（§2：生产入口，替代手工改库）────────────────────────

/**
 * 失败项只读视图。字段**严格裁剪**：只给行号、类型、序号、失败分类与稳定错误码，
 * **绝不返回 payload 原文**（上行载荷含线索资料，UI 只需要「哪一行为什么失败」）。
 */
export interface FailedOutboxItem {
  rowId: number
  /** 登记的 outbox 事件类型；未登记类型不进本清单（它们不可重投） */
  type: string
  eventSeq: number
  /** 最近一次失败审计的动作名（本机稳定标识，不是自由文本） */
  failureAction: string
  /** 稳定错误码：仅当审计 reason 是机器码形态时透出，否则留空（自由文本一律不外传） */
  failureCode: string
  updatedAt: number
}

/** 失败审计动作白名单（覆盖中央 HTTP 与 SMB 两条通道的终态结算） */
const FAILURE_ACTIONS = [
  'sync_outbox_failed', 'sync_down_fail', 'sync_down_payload_unrecoverable',
  'sync_down_unroutable', 'sync_down_delivery_key_conflict', 'sync_employee_unresolved'
] as const

/** 机器码形态白名单：审计里的 reason 只有长得像稳定码才透出，中文说明等自由文本一律丢弃 */
const SAFE_FAILURE_CODE = /^[A-Za-z0-9_:.\-]{1,80}$/

function failureCodeOf(detailRaw: string): string {
  try {
    const parsed: unknown = JSON.parse(detailRaw)
    const reason = (parsed as { reason?: unknown } | null)?.reason
    return typeof reason === 'string' && SAFE_FAILURE_CODE.test(reason) ? reason : ''
  } catch { return '' }
}

/** 终态失败行（只读）：按 event_seq 顺序最多 limit 条，字段裁剪见 FailedOutboxItem */
export function listFailedOutbox(limit = 50): FailedOutboxItem[] {
  const cap = Math.max(1, Math.min(200, Math.floor(limit) || 50))
  const placeholders = FAILURE_ACTIONS.map(() => '?').join(',')
  const out: FailedOutboxItem[] = []
  const rows = crmDbService.all(
    "SELECT id, event_seq, payload, updated_at FROM outbox_event WHERE status='failed' ORDER BY event_seq LIMIT ?", [cap])
  for (const row of rows) {
    const routed = routeOutboxRow(row)
    if (!routed) continue // 未登记类型不可重投，不列进可操作清单
    const auditRow = crmDbService.all(
      `SELECT action, detail FROM audit_event WHERE entity_type IN ('outbox_event','outbox') AND entity_id = ?` +
      ` AND action IN (${placeholders}) ORDER BY id DESC LIMIT 1`,
      [String(row.id), ...FAILURE_ACTIONS])[0]
    out.push({
      rowId: Number(row.id), type: routed.type, eventSeq: Number(row.event_seq || 0),
      failureAction: String(auditRow?.action || ''),
      failureCode: failureCodeOf(String(auditRow?.detail || '')),
      updatedAt: Number(row.updated_at || 0)
    })
  }
  return out
}

export interface OutboxRetryResult {
  ok: boolean
  rowId: number
  /** 稳定结果码：`ok` / `invalid_row_id` / `not_found` / `not_failed` / `unsupported_type` */
  code: string
}

/**
 * 「失败重投」正式入口（替代 e2e / 运维直接 `UPDATE outbox_event SET status='pending'`）。
 * 约束（PRD §7.1 与审计要求）：
 *   - 只接受**正整数 rowId**：不做任意 SQL、不接受任意状态变更，没有批量改库入口；
 *   - 只对 `status='failed'` 且**类型已登记**的行生效；其余返回稳定码且**零写入**；
 *   - 一个事务内原子翻转 failed → pending；`payload` / `event_seq` / `idempotency_key`
 *     **一字不改**——改幂等键会让中央把同一次业务动作算成两笔，改 event_seq 会打乱队列顺序；
 *   - 同一事务内清零尝试计数：否则重投后第一次 defer 就因超限再次判失败，重投等于没投；
 *   - 重复点击幂等：第二次命中 `not_failed`，无写入、无审计；
 *   - 追加式审计只记行号与类型，不含客户联系方式 / 聊天正文 / 整条线索数据 / token。
 *
 * 双目标部分成功（transfer 的 apply 已受理、remove 被 4xx 拒）重投后：中央按 per-target
 * 幂等键把已受理的 apply 判 duplicate（不写重复业务行），remove 重新投递；两个目标都被受理
 * 才由既有 `pushOutboxCommand` 把整行置 sent —— 不需要另建「部分成功」状态表。
 */
export function retryFailedOutbox(rowId: number): OutboxRetryResult {
  if (!Number.isInteger(rowId) || rowId <= 0) return { ok: false, rowId: 0, code: 'invalid_row_id' }
  const outcome = crmDbService.runTx((tx) => {
    const row = tx.all('SELECT id, status, payload FROM outbox_event WHERE id = ?', [rowId])[0]
    if (!row) return { code: 'not_found', type: '' }
    if (String(row.status || '') !== 'failed') return { code: 'not_failed', type: '' }
    const routed = routeOutboxRow(row)
    if (!routed) return { code: 'unsupported_type', type: '' }
    const now = Date.now()
    tx.run("UPDATE outbox_event SET status = 'pending', updated_at = ? WHERE id = ? AND status = 'failed'", [now, rowId])
    tx.run('INSERT INTO scan_state (key, last_scan) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET last_scan = excluded.last_scan',
      [`centralSync:outboxAttempt:${rowId}`, 0])
    tx.run('INSERT INTO audit_event (actor, action, entity_type, entity_id, detail, created_at) VALUES (?,?,?,?,?,?)',
      [String(ConfigService.getInstance().get('identityName') || 'unknown'), 'sync_outbox_retry', 'outbox_event',
        String(rowId), JSON.stringify({ type: routed.type }), now])
    return { code: 'ok', type: routed.type }
  })
  return { ok: outcome.code === 'ok', rowId, code: outcome.code }
}

/** 某 outbox 行当前的投递状态（只读；行不存在或状态值异常 → unknown） */
export type OutboxDeliveryStatus = 'pending' | 'failed' | 'sent' | 'unknown'

export function outboxDeliveryStatusOf(rowId: number): OutboxDeliveryStatus {
  if (!Number.isInteger(rowId) || rowId <= 0) return 'unknown'
  const status = String(crmDbService.all('SELECT status FROM outbox_event WHERE id = ?', [rowId])[0]?.status || '')
  return status === 'pending' || status === 'failed' || status === 'sent' ? status : 'unknown'
}

/**
 * 重投的**结论码**（UI 据此显示，不再拿整轮 pushed/rejected 反推指定行）：
 *   - `sent`         该行已经中央受理并结算 sent；
 *   - `pending`      failed → pending 已完成，但本轮没把它送出去（网络/服务错误，留给下一轮）；
 *   - `failed`       重投后再次被契约拒绝（4xx），需要人工处理；
 *   - `unconfigured` 已重新排队，但中央同步未配置（本机根本没发起请求）；
 *   - `unknown`      行状态不可读（异常路径，一律按「未确认」处理）。
 * 「重新排队」只是本机状态翻转，**不等于同步成功**——这正是本函数存在的理由。
 */
export type OutboxRetryOutcome = 'sent' | 'pending' | 'failed' | 'unconfigured' | 'unknown'

export function retryOutcomeOf(deliveryStatus: OutboxDeliveryStatus, syncConfigured: boolean): OutboxRetryOutcome {
  if (!syncConfigured) return 'unconfigured'
  return deliveryStatus === 'sent' || deliveryStatus === 'failed' || deliveryStatus === 'pending'
    ? deliveryStatus
    : 'unknown'
}

/**
 * 对外回传的同步错误：复用既有脱敏（`maskAuditText`：手机号/wxid/证件号打码 + 私有文本擦洗）
 * 并裁剪长度。绝不外传 token、载荷原文或联系方式。
 *
 * 令牌另做一道兜底：它是 bearer 凭据，本机不主动往错误里写，但 HTTP 客户端 / 代理库 / 服务端
 * 回显都可能把它拼进错误串——只要出现就整段替换，避免「设置页把设备令牌显示出来」。
 */
export function safeSyncError(error: unknown): string {
  if (error === undefined || error === null || error === '') return ''
  const raw = error instanceof Error ? error.message : String(error)
  const masked = maskAuditText(raw).slice(0, 300)
  const token = getCentralSyncConfig().token
  return token.length >= 8 && masked.includes(token) ? masked.split(token).join('[已隐藏令牌]') : masked
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
    backlogFailed: Number(crmDbService.all("SELECT COUNT(*) AS c FROM outbox_event WHERE status='failed'")[0]?.c || 0),
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
