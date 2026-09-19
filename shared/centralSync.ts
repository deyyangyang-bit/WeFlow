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
  'audit_event', 'customer_judgment', 'knowledge_proposal', 'permission',
  'duplicate_group'
] as const

export type CentralEntityType = typeof CENTRAL_ENTITY_TYPES[number]
export type CentralSyncDirection = 'up' | 'down'

/**
 * 中央下行投影白名单（撞客一期 2026-09-19，宪法 §3.1 duplicate_group 登记行）：
 * 允许中央自产并随 /sync/pull 广播下发的投影实体类型。与下行指令（DOWN_COMMAND_SPECS）
 * 互斥——投影是**事实通告**，不承载动作语义，客户端只落本地表供界面提示，
 * 不走 applyDownEventDirect / 下行业务校验器。
 */
export const DOWN_PROJECTION_ENTITY_TYPES = ['duplicate_group'] as const

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

/**
 * 引用是否指向某个具体的本机行（`<deviceId>/<kind>:<id>`，且 id 有**非空白**内容）。
 * 冒号后必须真有内容：`<deviceId>/customer:` 与 `<deviceId>/customer:   ` 都是等价的空引用——
 * 后者能骗过「长度 > colon+1」，却同样无法跨表关联，也与「本机某一行」无关。
 */
export function isConcreteRef(ref: unknown): boolean {
  const parsed = parseScopedRef(ref)
  if (!parsed) return false
  const colon = parsed.localRef.indexOf(':')
  if (colon <= 0) return false
  return parsed.localRef.slice(colon + 1).trim().length > 0
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

// ─── 载荷引用字段类型闸门（§三）───────────────────────────────────────────────

/**
 * 上行 payload 中**登记过**的 `*Ref` 字段语义：
 *  - `kind`：引用的实体类别，必须与字段语义一致（`customerRef` 只能是客户引用，
 *    否则 `{entityType:'customer'}` + `playload.leadRef` 就能把线索引用写进客户表）；
 *  - `scoped`：该字段是否必须是设备命名空间引用（`<deviceId>/<kind>:<id>`）。
 *
 * `employeeRef` 是**身份声明**而非投影引用 —— 权限行里存的是本机显示名 / 员工编号
 * （见 centralSyncService.pushPermissionDeclaration），不是某台设备上的行号。
 * 为了「形态统一」而强行要求它是 scoped ref，等于篡改权限行语义，
 * 因此这里只要求：非空字符串；**若**写成 `<a>/<b>` 形态则必须是本机合法引用。
 */
export const CENTRAL_REF_FIELD_KINDS: Record<string, { kind: string; scoped: boolean }> = {
  customerRef: { kind: 'customer', scoped: true },
  leadRef: { kind: 'lead', scoped: true },
  opportunityRef: { kind: 'opportunity', scoped: true },
  employeeRef: { kind: 'employee', scoped: false }
}

/**
 * 载荷引用字段校验（§三.2 / §三.3）。返回稳定错误码（null = 通过），错误码只带字段名、不带值。
 *
 * 三条规则：
 *  ① scoped 引用必须是完整形态：`<deviceId>/<kind>:<id>`（裸 `customer:1` 说明发送方漏了
 *     scopedRef，中央无法跨表关联；`<deviceId>/customer:` 缺行号同样是坏引用）；
 *  ② 引用类别必须与字段语义一致；
 *  ③ **本地上行投影不得借用他机命名空间**：同工作区内也不行，否则 A 机可以借 B 机的引用
 *     把事实写到别人的投影上（与 `crossDeviceConflict` 是同一类越权的两道门）。
 */
export function validateCentralRefFields(payload: unknown, deviceId: string): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  for (const [field, value] of Object.entries(payload as Record<string, unknown>)) {
    if (!Object.prototype.hasOwnProperty.call(CENTRAL_REF_FIELD_KINDS, field)) continue
    const rule = CENTRAL_REF_FIELD_KINDS[field]!
    if (value === undefined || value === null || value === '') continue
    if (typeof value !== 'string') return `ref_invalid_type:${field}`
    if (!rule.scoped) {
      // 声明型引用：显示名 / 员工编号照常放行，仅当它长得像 scoped ref 时才按 scoped 规则校验
      if (!value.includes(SCOPED_REF_DELIMITER)) continue
      if (!parseScopedRef(value)) return `ref_not_scoped:${field}`
      if (!isRefOwnedByDevice(deviceId, value)) return `ref_not_owned:${field}`
      continue
    }
    const parsed = parseScopedRef(value)
    if (!parsed) return `ref_not_scoped:${field}`
    if (!isConcreteRef(value)) return `ref_not_concrete:${field}`
    if (refKindOf(value) !== rule.kind) return `ref_kind_mismatch:${field}`
    if (parsed.deviceId !== deviceId) return `ref_not_owned:${field}`
  }
  return null
}
