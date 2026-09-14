/**
 * 中央事实副本的显式投影注册表（Phase 3a）。
 *
 * 设计约束（见 docs/DATA-CONSTITUTION.md §1/§2.1 与 PRD §7.1）：
 *  - 每一类上行实体对应**一张明确的表 + 一列明确的列**，禁止用通用 JSONB 数据桶冒充业务模型；
 *  - 所有列名与语义必须能在数据宪法里找到对应对象，不得另造第二套业务语义；
 *  - 聊天正文、消息正文、session_id、WCDB 路径、原始聊天数据永不出现在任何列里；
 *  - SQL 全部参数化：本模块只产出 `$n` 占位符，值一律走参数数组。
 */
import { CENTRAL_ENTITY_TYPES, findForbiddenCentralField, type CentralEntityType, type CentralSyncEvent } from '../../shared/centralSync.js'

export type ColumnType = 'text' | 'bigint' | 'integer' | 'numeric' | 'boolean' | 'timestamptz'

export interface ProjectionColumn {
  /** 中央表列名 */
  column: string
  type: ColumnType
  /** 取值来源：payload 顶层字段名；`''` 表示由信封（workspace/device/version）注入 */
  from: string
  /** 允许为空（缺省即 NOT NULL，缺字段按 null 写入并交由表约束拒绝） */
  nullable?: boolean
}

export interface Projection {
  entityType: CentralEntityType
  /** 中央表名 */
  table: string
  /** 除 (workspace_id, entity_id) 主键外的业务唯一键（仅用于文档与迁移一致性断言） */
  businessKey: string[]
  /** payload 必填字段：缺失即拒收该事件（同批其它事件不受影响） */
  required: string[]
  columns: ProjectionColumn[]
}

const ENVELOPE = (column: string, from: string): ProjectionColumn => ({ column, from, type: 'text' })

/**
 * 注册表。每个 CentralEntityType 必须恰好一项；缺项由 projections-test 直接判红。
 * `from:''` 的列由 store 从信封（aggregate_version / source_device_id）注入。
 */
export const PROJECTIONS: Record<CentralEntityType, Projection> = {
  customer: {
    entityType: 'customer', table: 'central_customer',
    businessKey: ['workspace_id', 'entity_id'],
    required: ['displayName'],
    columns: [
      ENVELOPE('customer_ref', 'customerRef'),
      { column: 'display_name', from: 'displayName', type: 'text' },
      { column: 'stage', from: 'stage', type: 'text', nullable: true },
      { column: 'customer_type', from: 'customerType', type: 'text', nullable: true },
      { column: 'owner_sales', from: 'ownerSales', type: 'text', nullable: true },
      { column: 'source', from: 'source', type: 'text', nullable: true },
      { column: 'updated_by', from: 'updatedBy', type: 'text', nullable: true },
      { column: 'deleted', from: 'deleted', type: 'boolean' }
    ]
  },
  customer_identity: {
    entityType: 'customer_identity', table: 'central_customer_identity',
    businessKey: ['workspace_id', 'identity_type', 'identity_hash'],
    required: ['customerRef', 'identityType', 'identityHash'],
    columns: [
      ENVELOPE('customer_ref', 'customerRef'),
      { column: 'identity_type', from: 'identityType', type: 'text' },
      // 身份值只存不可逆哈希 + 展示用掩码；手机号/微信号原文不出本机（PRD §10 R4 脱敏清单）
      { column: 'identity_hash', from: 'identityHash', type: 'text' },
      { column: 'identity_masked', from: 'identityMasked', type: 'text', nullable: true },
      { column: 'confidence', from: 'confidence', type: 'numeric', nullable: true },
      { column: 'source', from: 'source', type: 'text', nullable: true },
      { column: 'deleted', from: 'deleted', type: 'boolean' }
    ]
  },
  assignment: {
    entityType: 'assignment', table: 'central_assignment',
    businessKey: ['workspace_id', 'entity_id'],
    required: ['customerRef', 'salesName', 'status'],
    columns: [
      ENVELOPE('customer_ref', 'customerRef'),
      ENVELOPE('lead_ref', 'leadRef'),
      { column: 'sales_name', from: 'salesName', type: 'text' },
      { column: 'status', from: 'status', type: 'text' },
      { column: 'mode', from: 'mode', type: 'text', nullable: true },
      { column: 'sla1_deadline', from: 'sla1Deadline', type: 'bigint', nullable: true },
      { column: 'sla2_deadline', from: 'sla2Deadline', type: 'bigint', nullable: true },
      { column: 'assigned_at', from: 'assignedAt', type: 'bigint', nullable: true },
      { column: 'updated_by', from: 'updatedBy', type: 'text', nullable: true },
      { column: 'deleted', from: 'deleted', type: 'boolean' }
    ]
  },
  ownership: {
    entityType: 'ownership', table: 'central_ownership',
    businessKey: ['workspace_id', 'entity_id'],
    required: ['customerRef', 'ownerSales'],
    columns: [
      ENVELOPE('customer_ref', 'customerRef'),
      { column: 'owner_sales', from: 'ownerSales', type: 'text' },
      { column: 'reason', from: 'reason', type: 'text', nullable: true },
      { column: 'effective_from', from: 'effectiveFrom', type: 'bigint', nullable: true },
      { column: 'updated_by', from: 'updatedBy', type: 'text', nullable: true },
      { column: 'deleted', from: 'deleted', type: 'boolean' }
    ]
  },
  opportunity: {
    entityType: 'opportunity', table: 'central_opportunity',
    businessKey: ['workspace_id', 'entity_id'],
    required: ['customerRef', 'stage'],
    columns: [
      ENVELOPE('customer_ref', 'customerRef'),
      { column: 'name', from: 'name', type: 'text', nullable: true },
      { column: 'stage', from: 'stage', type: 'text' },
      { column: 'status', from: 'status', type: 'text', nullable: true },
      { column: 'opp_type', from: 'oppType', type: 'text', nullable: true },
      { column: 'amount_cny', from: 'amountCny', type: 'numeric', nullable: true },
      { column: 'original_currency', from: 'originalCurrency', type: 'text', nullable: true },
      { column: 'original_amount', from: 'originalAmount', type: 'numeric', nullable: true },
      { column: 'order_qty', from: 'orderQty', type: 'integer', nullable: true },
      { column: 'shipped_qty', from: 'shippedQty', type: 'integer', nullable: true },
      { column: 'expected_ship_start', from: 'expectedShipStart', type: 'bigint', nullable: true },
      { column: 'expected_ship_end', from: 'expectedShipEnd', type: 'bigint', nullable: true },
      { column: 'delivery_date', from: 'deliveryDate', type: 'bigint', nullable: true },
      { column: 'updated_by', from: 'updatedBy', type: 'text', nullable: true },
      { column: 'deleted', from: 'deleted', type: 'boolean' }
    ]
  },
  quote: {
    entityType: 'quote', table: 'central_quote',
    businessKey: ['workspace_id', 'opportunity_ref', 'version_no'],
    required: ['opportunityRef', 'versionNo'],
    columns: [
      ENVELOPE('customer_ref', 'customerRef'),
      ENVELOPE('opportunity_ref', 'opportunityRef'),
      { column: 'version_no', from: 'versionNo', type: 'integer' },
      { column: 'amount_cny', from: 'amountCny', type: 'numeric', nullable: true },
      { column: 'currency', from: 'currency', type: 'text', nullable: true },
      { column: 'effective_from', from: 'effectiveFrom', type: 'bigint', nullable: true },
      { column: 'effective_to', from: 'effectiveTo', type: 'bigint', nullable: true },
      { column: 'doc_hash', from: 'docHash', type: 'text', nullable: true },
      { column: 'updated_by', from: 'updatedBy', type: 'text', nullable: true },
      { column: 'deleted', from: 'deleted', type: 'boolean' }
    ]
  },
  // 本机 audit_event 的**只读上行投影**；中央自身操作审计另存 central_audit_event，两者不互相写入。
  audit_event: {
    entityType: 'audit_event', table: 'central_audit_projection',
    businessKey: ['workspace_id', 'source_device_id', 'source_audit_id'],
    required: ['actor', 'action'],
    columns: [
      { column: 'source_audit_id', from: 'sourceAuditId', type: 'text' },
      { column: 'actor', from: 'actor', type: 'text' },
      { column: 'action', from: 'action', type: 'text' },
      { column: 'subject_type', from: 'subjectType', type: 'text', nullable: true },
      { column: 'subject_id', from: 'subjectId', type: 'text', nullable: true },
      { column: 'detail_masked', from: 'detailMasked', type: 'text', nullable: true },
      { column: 'occurred_at', from: 'occurredAt', type: 'bigint', nullable: true }
    ]
  },
  customer_judgment: {
    entityType: 'customer_judgment', table: 'central_customer_judgment',
    businessKey: ['workspace_id', 'entity_id'],
    required: ['customerRef', 'judgmentType', 'value'],
    columns: [
      ENVELOPE('customer_ref', 'customerRef'),
      { column: 'judgment_type', from: 'judgmentType', type: 'text' },
      { column: 'value', from: 'value', type: 'text' },
      { column: 'confidence', from: 'confidence', type: 'numeric', nullable: true },
      { column: 'source', from: 'source', type: 'text', nullable: true },
      { column: 'model', from: 'model', type: 'text', nullable: true },
      { column: 'generated_at', from: 'generatedAt', type: 'bigint', nullable: true },
      // 证据锚点复用本机 messageKey（禁止另造 evidence ID 体系）；evidence_text 属客户原话，不上行
      { column: 'evidence_key', from: 'evidenceKey', type: 'text', nullable: true },
      { column: 'evidence_status', from: 'evidenceStatus', type: 'text', nullable: true },
      { column: 'deleted', from: 'deleted', type: 'boolean' }
    ]
  },
  knowledge_proposal: {
    entityType: 'knowledge_proposal', table: 'central_knowledge_proposal',
    businessKey: ['workspace_id', 'entity_id'],
    required: ['logicalId', 'title', 'status'],
    columns: [
      { column: 'logical_id', from: 'logicalId', type: 'text' },
      { column: 'title', from: 'title', type: 'text' },
      { column: 'content', from: 'content', type: 'text', nullable: true },
      { column: 'category', from: 'category', type: 'text', nullable: true },
      { column: 'product_line', from: 'productLine', type: 'text', nullable: true },
      { column: 'scene', from: 'scene', type: 'text', nullable: true },
      { column: 'authority', from: 'authority', type: 'text', nullable: true },
      { column: 'version_no', from: 'versionNo', type: 'integer', nullable: true },
      { column: 'status', from: 'status', type: 'text' },
      { column: 'source', from: 'source', type: 'text', nullable: true },
      { column: 'evidence_key', from: 'evidenceKey', type: 'text', nullable: true },
      { column: 'ttl_date', from: 'ttlDate', type: 'text', nullable: true },
      { column: 'reviewed_by', from: 'reviewedBy', type: 'text', nullable: true },
      { column: 'reviewed_at', from: 'reviewedAt', type: 'bigint', nullable: true },
      { column: 'deleted', from: 'deleted', type: 'boolean' }
    ]
  },
  permission: {
    entityType: 'permission', table: 'central_permission',
    businessKey: ['workspace_id', 'entity_id'],
    required: ['employeeRef', 'declaredRole'],
    columns: [
      ENVELOPE('employee_ref', 'employeeRef'),
      // declared_role 来自本地身份档案（需求 1.2a）：**仅作署名与展示**，永不作为服务端权限依据。
      // 真正的权限由 central employee.role + device 绑定决定（PRD §3.1 / §7.1 身份行）。
      { column: 'declared_role', from: 'declaredRole', type: 'text' },
      { column: 'authority_source', from: 'authoritySource', type: 'text' },
      { column: 'display_name', from: 'displayName', type: 'text', nullable: true },
      { column: 'revoked_at', from: 'revokedAt', type: 'bigint', nullable: true },
      { column: 'deleted', from: 'deleted', type: 'boolean' }
    ]
  }
}

/** 缺注册项直接抛错：宁可拒收事件，也不允许落进没有约束的地方。 */
export function projectionOf(entityType: string): Projection {
  const projection = (PROJECTIONS as Record<string, Projection | undefined>)[entityType]
  if (!projection) throw new Error(`unregistered_entity_type:${entityType}`)
  return projection
}

export function missingRequiredFields(projection: Projection, payload: Record<string, unknown>): string[] {
  return projection.required.filter((field) => payload[field] === undefined || payload[field] === null || payload[field] === '')
}

function toSqlValue(type: ColumnType, raw: unknown): unknown {
  // 布尔列（deleted 等）缺省一律落 false：缺字段绝不能变成 NULL 去撞 NOT NULL 约束，
  // 故必须在下面的 null 早退之前处理。
  if (type === 'boolean') return raw === undefined || raw === null ? false : Boolean(raw)
  if (raw === undefined || raw === null) return null
  switch (type) {
    case 'bigint':
    case 'integer': {
      const n = Number(raw)
      return Number.isFinite(n) ? Math.trunc(n) : null
    }
    case 'numeric': {
      const n = Number(raw)
      return Number.isFinite(n) ? n : null
    }
    case 'timestamptz': return raw
    default: return String(raw)
  }
}

export interface UpsertStatement { sql: string; values: unknown[] }

/**
 * 生成显式投影的 upsert 语句（全参数化）。
 * 冲突时只在 `aggregate_version` 严格更新（或首次写入）时覆盖，等价于中央侧的版本闸门。
 */
export function buildProjectionUpsert(
  projection: Projection, workspaceId: string, deviceId: string, event: CentralSyncEvent
): UpsertStatement {
  const payload = event.payload
  const columns = ['workspace_id', 'entity_id', 'aggregate_version', 'source_device_id', 'updated_at', 'created_at']
  const values: unknown[] = [workspaceId, event.entityId, event.aggregateVersion, deviceId]
  const placeholders = ['$1', '$2', '$3', '$4', 'now()', 'now()']
  const assignments: string[] = []

  for (const column of projection.columns) {
    const value = column.from === '' ? null : toSqlValue(column.type, payload[column.from])
    values.push(value)
    placeholders.push(`$${values.length}`)
    columns.push(column.column)
    assignments.push(`${column.column} = EXCLUDED.${column.column}`)
  }
  assignments.push('aggregate_version = EXCLUDED.aggregate_version')
  assignments.push('source_device_id = EXCLUDED.source_device_id')
  assignments.push('updated_at = now()')

  const sql = `INSERT INTO ${projection.table} (${columns.join(',')}) VALUES (${placeholders.join(',')})\n` +
    `ON CONFLICT (workspace_id, entity_id) DO UPDATE SET ${assignments.join(', ')}\n` +
    `WHERE ${projection.table}.aggregate_version < EXCLUDED.aggregate_version`
  return { sql, values }
}

/** 注册表里的所有列名必须与迁移 DDL 一致（供 projections-test 静态比对）。 */
export function projectionColumnNames(): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const [entityType, projection] of Object.entries(PROJECTIONS)) {
    out[entityType] = ['workspace_id', 'entity_id', 'aggregate_version', 'source_device_id', 'updated_at', 'created_at']
      .concat(projection.columns.map((column) => column.column))
  }
  return out
}

/**
 * payload 中**未登记**的字段（严格白名单）。
 *
 * 为什么必须存在：注册表只声明「中央要哪些列」，不声明「允许发送方多带什么」。少了这道闸门，
 * 发送方一个 `{...outboxPayload}` 就能把原始手机号 / wxid / 聊天原文塞进 sync_event.payload
 * 并长期留存在中央库里——即使实体列里没有对应列，事件载荷本身已经出机并落库。
 * 发现未登记字段一律**拒收整条事件**，不做静默裁剪：静默裁剪会让发送方以为已经同步成功。
 */
export function unknownPayloadFields(projection: Projection, payload: Record<string, unknown>): string[] {
  const allowed = new Set(projection.columns.map((column) => column.from).filter((from) => from !== ''))
  allowed.add('type')
  return Object.keys(payload).filter((key) => !allowed.has(key))
}

/** 上行事件是否载荷合法；返回拒绝原因（null = 通过）。错误码只带字段路径，绝不带字段值。 */
export function validateProjectionPayload(projection: Projection, payload: Record<string, unknown>): string | null {
  const forbidden = findForbiddenCentralField(payload)
  if (forbidden) return `forbidden_field:${forbidden}`
  const unknown = unknownPayloadFields(projection, payload)
  if (unknown.length) return `unknown_field:${unknown.join(',')}`
  const missing = missingRequiredFields(projection, payload)
  if (missing.length) return `missing_required:${missing.join(',')}`
  return null
}

/** 投影表的中央表名（用于按主键回查归属设备，不做任何字符串拼接之外的用途） */
export function projectionTableName(entityType: string): string {
  return projectionOf(entityType).table
}

/**
 * 投影归属闸门（§二.3）：既有投影只能由**原 source_device_id** 更新。
 * 同设备的新版本照常走 aggregate_version 闸门；跨设备改写一律返回冲突码——
 * 绝不能出现「B 机用更大的 aggregateVersion 覆盖 A 机投影」这种同工作区内的越权。
 * 错误码不带任何 id：拒收回执本身不该泄露别人的设备标识。
 */
export function crossDeviceConflict(existingSourceDeviceId: string | null | undefined, incomingDeviceId: string): string | null {
  if (!existingSourceDeviceId) return null
  if (String(existingSourceDeviceId) === String(incomingDeviceId)) return null
  return 'cross_device_conflict'
}

/**
 * 唯一身份锚点（§二.4）：同一工作区内 identity_type + identity_hash 只能指向一个客户。
 * 冲突时返回稳定码，由 store 记冲突记录并拒收——**不覆盖、不静默、不自动归并**。
 */
export function identityAnchorOf(payload: Record<string, unknown>): { identityType: string; identityHash: string } | null {
  const identityType = String(payload.identityType ?? '').trim()
  const identityHash = String(payload.identityHash ?? '').trim()
  if (!identityType || !identityHash) return null
  return { identityType, identityHash }
}

/** 注册表与协议实体清单必须一一对应（供测试与启动自检使用）。 */
export function projectionRegistryGaps(): string[] {
  const registered = Object.keys(PROJECTIONS)
  const missing = CENTRAL_ENTITY_TYPES.filter((type) => !registered.includes(type))
  const extra = registered.filter((type) => !(CENTRAL_ENTITY_TYPES as readonly string[]).includes(type))
  return [...missing.map((type) => `missing:${type}`), ...extra.map((type) => `extra:${type}`)]
}
