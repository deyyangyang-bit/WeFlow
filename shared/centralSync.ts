/**
 * Phase 3a 中央同步传输契约。
 *
 * 这里只定义传输信封，不复制 P0/P1/P2 的业务状态机。payload 中的对象与字段语义继续以
 * DATA-CONSTITUTION 为准；聊天原文禁止进入任何 CentralSyncEvent。
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

/** 聊天原文与底层会话标识不得出机；字段命中即拒绝整事件，不做静默裁剪。 */
export function findForbiddenCentralField(value: unknown, path = ''): string | null {
  if (!value || typeof value !== 'object') return null
  const forbidden = /^(chat(_?raw|_?content|_?text)?|message(_?content|_?text|_?body)?|conversation|session_id|wcdb_path)$/i
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = path ? `${path}.${key}` : key
    if (forbidden.test(key)) return childPath
    if (child && typeof child === 'object') {
      const found = findForbiddenCentralField(child, childPath)
      if (found) return found
    }
  }
  return null
}
