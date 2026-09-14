/**
 * Phase 3a 中央同步传输契约。
 *
 * 这里只定义传输信封与**跨机引用规则**，不复制 P0/P1/P2 的业务状态机。payload 中的对象与字段
 * 语义继续以 DATA-CONSTITUTION 为准；聊天原文与原始身份值禁止进入任何上行 CentralSyncEvent。
 *
 * 两条跨机纪律（2026-09-14 收口）：
 *  1. **引用必须带设备命名空间**：本地自增 id 在不同机器上必然重号，`customer:1` 这样的裸引用
 *     在两台设备上指向不同客户。entityId 与 payload 内所有指向本机投影的引用一律走
 *     `scopedRef(deviceId, localRef)`（`<deviceId>/<localRef>`），中央才能跨表稳定关联。
 *  2. **禁字段检查分方向**：上行（设备→中央）连原始手机号/wxid/contactNormalized 都不许出机；
 *     下行（中央→设备）是同一工作区内的指令投递，只拦聊天正文与会话标识。
 */
export const CENTRAL_SYNC_PROTOCOL_VERSION = 1 as const

export const CENTRAL_ENTITY_TYPES = [
  'customer', 'customer_identity', 'assignment', 'ownership', 'opportunity', 'quote',
  'audit_event', 'customer_judgment', 'knowledge_proposal', 'permission'
] as const

export type CentralEntityType = typeof CENTRAL_ENTITY_TYPES[number]
export type CentralSyncDirection = 'up' | 'down'

export interface CentralSyncEvent {
  protocolVersion: typeof CENTRAL_SYNC_PROTOCOL_VERSION
  eventId: string
  eventSeq: number
  idempotencyKey: string
  direction: CentralSyncDirection
  entityType: CentralEntityType
  entityId: string
  eventType: string
  aggregateVersion: number
  payload: Record<string, unknown>
  evidenceKey?: string
  targetEmployeeId?: string
  targetDeviceId?: string
  occurredAt: number
}

export interface CentralPushRequest {
  events: CentralSyncEvent[]
}

export interface CentralPushResult {
  accepted: Array<{ eventId: string; centralSeq: number; duplicate: boolean }>
  rejected: Array<{ eventId: string; code: string; message: string }>
}

export interface CentralPullResult {
  events: Array<CentralSyncEvent & { centralSeq: number }>
  nextCursor: number
  hasMore: boolean
}

export interface CentralAckRequest {
  acknowledgements: Array<{
    centralSeq: number
    eventId: string
    outcome: 'applied' | 'conflict' | 'invalid' | 'retry'
    localVersion?: number
    detail?: string
  }>
}

export function isCentralEntityType(value: unknown): value is CentralEntityType {
  return typeof value === 'string' && (CENTRAL_ENTITY_TYPES as readonly string[]).includes(value)
}

/** 传输层最低限度校验；端点 JSON Schema 是第一道门，本函数供客户端与测试复用。 */
export function validateCentralSyncEvent(value: CentralSyncEvent): string | null {
  if (value.protocolVersion !== CENTRAL_SYNC_PROTOCOL_VERSION) return 'protocol_mismatch'
  if (!value.eventId || !value.idempotencyKey || !value.entityId || !value.eventType) return 'missing_identity'
  if (!Number.isSafeInteger(value.eventSeq) || value.eventSeq < 1) return 'invalid_event_seq'
  if (!Number.isSafeInteger(value.aggregateVersion) || value.aggregateVersion < 0) return 'invalid_aggregate_version'
  if (!Number.isFinite(value.occurredAt) || value.occurredAt <= 0) return 'invalid_occurred_at'
  if (value.direction !== 'up' && value.direction !== 'down') return 'invalid_direction'
  if (!isCentralEntityType(value.entityType)) return 'invalid_entity_type'
  if (!value.payload || Array.isArray(value.payload) || typeof value.payload !== 'object') return 'invalid_payload'
  return null
}

// ─── 跨机引用命名空间 ─────────────────────────────────────────────────────────

/** 引用分隔符：entityId 形如 `<deviceId>/<localRef>`（如 `3f2a…/customer:12`） */
export const SCOPED_REF_DELIMITER = '/'

/** 设备命名空间下的引用（**唯一**构造入口；禁止各处手拼字符串）。 */
export function scopedRef(deviceId: string, localRef: string): string {
  return `${deviceId}${SCOPED_REF_DELIMITER}${localRef}`
}

/** 解析设备命名空间引用；非法形态返回 null。 */
export function parseScopedRef(ref: unknown): { deviceId: string; localRef: string } | null {
  if (typeof ref !== 'string') return null
  const at = ref.indexOf(SCOPED_REF_DELIMITER)
  if (at <= 0 || at === ref.length - 1) return null
  return { deviceId: ref.slice(0, at), localRef: ref.slice(at + 1) }
}

/** 该引用是否属于指定设备命名空间（中央强制校验上行 entityId 用）。 */
export function isRefOwnedByDevice(deviceId: string, ref: unknown): boolean {
  const parsed = parseScopedRef(ref)
  return parsed !== null && parsed.deviceId === deviceId
}

/** 引用是否为「本机某类投影」形态：`<deviceId>/<kind>:<本地行号>`（只取 kind，不解析行号语义）。 */
export function refKindOf(ref: unknown): string | null {
  const parsed = parseScopedRef(ref)
  if (!parsed) return null
  const colon = parsed.localRef.indexOf(':')
  return colon > 0 ? parsed.localRef.slice(0, colon) : null
}

/** 引用是否指向某个具体的本机行（`<deviceId>/<kind>:<id>`）。 */
export function isConcreteRef(ref: unknown): boolean {
  const parsed = parseScopedRef(ref)
  if (!parsed) return false
  const colon = parsed.localRef.indexOf(':')
  return colon > 0 && parsed.localRef.length > colon + 1
}

// ─── 禁上传字段（分方向） ─────────────────────────────────────────────────────

/** 字段名归一化：小写 + 去掉分隔符，`contact_raw` / `contactRaw` / `contact-raw` 同等对待。 */
function normalizeFieldName(name: string): string {
  return name.toLowerCase().replace(/[_\-. ]/g, '')
}

/**
 * 聊天正文与会话标识：**两个方向都不许出现**。
 * 命中即拒绝整事件，不做静默裁剪——静默裁剪会让发送方误以为已成功同步。
 */
const FORBIDDEN_CHAT_FIELDS = new Set([
  'chat', 'chatraw', 'chatcontent', 'chattext', 'chathistory', 'chatlog', 'chatdata', 'rawchat',
  'message', 'messages', 'messageraw', 'messagecontent', 'messagetext', 'messagebody', 'messagelog',
  'messagehistory', 'rawmessage',
  'conversation', 'conversations', 'conversationid', 'conversationcontent',
  'session', 'sessions', 'sessionid',
  'wcdb', 'wcdbpath', 'wcdbfile',
  // 判断行的 evidence_text 是客户原话（PRD 2.3 证据仅本地留存）：只允许传 evidenceKey 锚点
  'evidencetext'
])

/**
 * 聊天字段词干。上面是**精确名**表，只能拦住已知写法；`rawChatText` / `chatSummary` /
 * `messageDigest` 这类同义新写法会漏网。所以再加一层词干规则：归一化字段名以这些词干开头即判命中。
 *
 * 为什么安全：全部已登记的投影/指令字段名（59 个）都不以这些词干开头（见 projection-test H 段）。
 * 唯一的例外是知识提案与判断行的 `messageKey` —— 它是 PRD 认可的稳定锚点，不是聊天正文，
 * 因此显式进白名单（§一.8：不得误伤 evidenceKey / messageKey 锚点）。
 */
const CHAT_FIELD_STEM_ALLOW = new Set(['messagekey'])

const FORBIDDEN_CHAT_STEMS = ['rawchat', 'chat', 'message', 'conversation', 'session'] as const

/** 归一化字段名是否命中聊天词干（精确名表之外的兜底）。 */
function hitsForbiddenChatStem(normalized: string): boolean {
  if (CHAT_FIELD_STEM_ALLOW.has(normalized)) return false
  // 长度相等 = 与该词干同名，交给上面的精确表判定，避免规则重叠后难以定位命中来源
  return FORBIDDEN_CHAT_STEMS.some((stem) => normalized.length > stem.length && normalized.startsWith(stem))
}

/**
 * 原始身份值：**只在上行（设备→中央）禁止**。
 * 上行只允许不可逆哈希（identityHash）与展示掩码（identityMasked）。
 * 下行是同一工作区内的指令投递，线索资料必须随指令到达目标设备，故不在此列。
 */
const FORBIDDEN_UPLINK_IDENTITY_FIELDS = new Set([
  'wxid', 'wxidalias', 'wechat', 'wechatid', 'weixin', 'weixinid',
  'contact', 'contactraw', 'contactnormalized', 'contactvalue', 'contactno', 'contactphone', 'contactid',
  'phone', 'phonenumber', 'phoneno', 'mobile', 'mobileno', 'mobilephone', 'telephone', 'tel',
  'identityvalue', 'identityraw', 'rawidentity', 'rawcontact',
  'leadcontact', 'leadphone', 'leadwxid'
])

/**
 * 字段名本身是否属于「原始身份值」类（上行禁传）。
 * 导出是为了让**本机脱敏**复用同一张表：审计 detail 的擦除按字段名判定，
 * 不允许出现第二套清单——两套清单必然漂移，漂移的那一侧就是泄漏点（§一.6 / §六.1）。
 */
export function isForbiddenIdentityFieldName(key: string): boolean {
  return FORBIDDEN_UPLINK_IDENTITY_FIELDS.has(normalizeFieldName(key))
}

/** 字段名本身是否属于聊天正文/会话类（**两个方向**都禁）。messageKey 锚点已在词干白名单内。 */
export function isForbiddenChatFieldName(key: string): boolean {
  const normalized = normalizeFieldName(key)
  return FORBIDDEN_CHAT_FIELDS.has(normalized) || hitsForbiddenChatStem(normalized)
}

function scanForbidden(value: unknown, table: Set<string>, path: string, useChatStems = false): string | null {
  if (!value || typeof value !== 'object') return null
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = path ? `${path}.${key}` : key
    const normalized = normalizeFieldName(key)
    if (table.has(normalized) || (useChatStems && hitsForbiddenChatStem(normalized))) return childPath
    if (child && typeof child === 'object') {
      const found = scanForbidden(child, table, childPath, useChatStems)
      if (found) return found
    }
  }
  return null
}

/**
 * 上行禁字段检查（设备→中央）：聊天正文、会话标识、**原始身份值**均不得出机。
 * 返回命中的字段路径（不是值——路径不含客户数据，可直接进日志/审计/错误响应）。
 */
export function findForbiddenCentralField(value: unknown, path = ''): string | null {
  return scanForbidden(value, FORBIDDEN_CHAT_FIELDS, path, true) ?? scanForbidden(value, FORBIDDEN_UPLINK_IDENTITY_FIELDS, path)
}

/**
 * 下行禁字段检查（中央→设备）：只拦聊天正文与会话标识。
 * 下行指令必须能把线索业务资料投递到目标设备，故身份值不拦；但聊天原文任何方向都不出机。
 */
export function findForbiddenDownlinkField(value: unknown, path = ''): string | null {
  return scanForbidden(value, FORBIDDEN_CHAT_FIELDS, path, true)
}
