/**
 * 中央下行指令的类型级契约（Phase 3a 收口）。
 *
 * 为什么需要它：SMB 文件路径有 `validateDownEventFile` 本体校验（to / eventSeq / type-role /
 * 文件名逐项绑定），而 HTTP 下行此前只有通用信封校验，直接调 applyDownEventDirect —— 同一条
 * 业务规则在两处各写一遍必然漂移。本模块是**唯一**的下行业务校验器，SMB 与 HTTP 两条入口共用：
 *   - lanSyncService.validateDownEventFile → 先过 SMB 专属绑定检查，再过本模块业务检查；
 *   - centralSyncService.toLocalEvent   → 只过本模块（HTTP 无文件/投递键概念）；
 *   - central/src/app.ts `/sync/commands` → 中央侧在建指令时就按同一份 spec 拒收。
 *
 * 纪律：payload 是**严格白名单**——未登记字段一律拒收整事件，不做静默裁剪（静默裁剪会让
 * 发送方误以为已成功投递）。聊天正文与会话标识任何方向都不许出现。
 */
import {
  CENTRAL_ENTITY_TYPES, findForbiddenDownlinkField, isCentralEntityType, refKindOf,
  type CentralEntityType, type CentralSyncEvent
} from './centralSync'

export const DOWN_DELIVERY_ROLES = ['apply', 'remove', 'notify'] as const
export type DownDeliveryRole = typeof DOWN_DELIVERY_ROLES[number]

const SALES_NAME_MAX = 60
const REASON_MAX = 200
const TITLE_MAX = 80
const SUMMARY_MAX = 500
const ROLE_MAX = 40

/** 下行线索资料子对象（同一工作区内的指令投递；聊天原文不在此列也永不允许出现） */
const LEAD_FIELDS = ['leadId', 'name', 'contactType', 'contactNormalized', 'contactRaw', 'wechat', 'source', 'note'] as const

export interface DownCommandSpec {
  entityType: CentralEntityType
  roles: readonly DownDeliveryRole[]
  /** 顶层必填字段（缺失/空串即拒收） */
  required: readonly string[]
  /** 顶层允许字段（严格白名单；未登记字段拒收整事件） */
  allowed: readonly string[]
  /** lead 子对象允许字段；缺省 = 该类型不得携带 lead */
  leadFields?: readonly string[]
  enums?: Record<string, readonly string[]>
  maxLength?: Record<string, number>
  /** 必填的数值时间戳字段（版本前置条件用） */
  requiredTimestamps?: readonly string[]
}

/**
 * 下行指令注册表。eventType 与 entityType 必须一一匹配（eventType/entityType 不一致在服务端拒收）。
 * 投递角色与 Phase 1 SMB 口径一致：assign/recycle → apply；transfer → apply|remove；
 * 主管通知 → notify；本阶段新增的两类中央专有指令 → apply。
 */
export const DOWN_COMMAND_SPECS: Record<string, DownCommandSpec> = {
  assign: {
    entityType: 'assignment',
    roles: ['apply'],
    required: ['leadId', 'assignmentId', 'salesName', 'lead'],
    allowed: ['type', 'deliveryRole', 'leadId', 'assignmentId', 'salesName', 'mode', 'sla1Deadline', 'actor', 'slaHours', 'lead'],
    leadFields: LEAD_FIELDS,
    maxLength: { salesName: SALES_NAME_MAX }
  },
  transfer: {
    entityType: 'assignment',
    roles: ['apply', 'remove'],
    required: ['leadId', 'assignmentId', 'toSales', 'lead'],
    allowed: ['type', 'deliveryRole', 'leadId', 'assignmentId', 'fromSales', 'toSales', 'reason', 'oldAssignmentId', 'actor', 'slaHours', 'lead'],
    leadFields: LEAD_FIELDS,
    maxLength: { toSales: SALES_NAME_MAX, fromSales: SALES_NAME_MAX, reason: REASON_MAX }
  },
  recycle: {
    entityType: 'assignment',
    roles: ['apply'],
    required: ['leadId', 'assignmentId', 'salesName'],
    allowed: ['type', 'deliveryRole', 'leadId', 'assignmentId', 'salesName', 'reason', 'actor'],
    maxLength: { salesName: SALES_NAME_MAX, reason: REASON_MAX }
  },
  sla1_escalate_supervisor: {
    entityType: 'assignment',
    roles: ['notify'],
    required: ['leadId', 'assignmentId', 'salesName', 'remindCount', 'recycledAt'],
    // contactMasked：跨机投递时通知正文里的联系方式只出**掩码**（原文不出机，PRD §10 R4）
    allowed: ['type', 'deliveryRole', 'leadId', 'assignmentId', 'salesName', 'remindCount', 'reason', 'recycledAt', 'contactMasked'],
    maxLength: { salesName: SALES_NAME_MAX, reason: REASON_MAX, contactMasked: 40 },
    requiredTimestamps: ['recycledAt']
  },
  supervisor_correction: {
    entityType: 'assignment',
    roles: ['apply'],
    required: ['leadId', 'title', 'summary'],
    allowed: ['type', 'deliveryRole', 'leadId', 'assignmentId', 'title', 'summary', 'detail', 'actor'],
    maxLength: { title: TITLE_MAX, summary: SUMMARY_MAX }
  },
  permission_change: {
    entityType: 'permission',
    roles: ['apply'],
    required: ['employeeRef', 'declaredRole'],
    allowed: ['type', 'deliveryRole', 'employeeRef', 'declaredRole', 'authoritySource', 'displayName'],
    maxLength: { employeeRef: 120, declaredRole: ROLE_MAX, displayName: SALES_NAME_MAX }
  }
}

export const DOWN_COMMAND_TYPES = Object.keys(DOWN_COMMAND_SPECS)

export function downCommandSpec(eventType: string): DownCommandSpec | null {
  return Object.prototype.hasOwnProperty.call(DOWN_COMMAND_SPECS, eventType) ? DOWN_COMMAND_SPECS[eventType]! : null
}

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '')
}

/** 下行指令的业务校验输入（信封字段 + payload 一起判，避免调用方各取所需） */
export interface DownCommandSubject {
  eventType: string
  entityType: string
  payload: Record<string, unknown>
  targetEmployeeId?: string
  targetDeviceId?: string
}

/**
 * 校验一条下行指令；返回稳定错误码（null = 通过）。
 * 错误码与 message 都只带**字段名**，绝不带字段值——被拦下的值可能就是客户数据。
 */
export function validateDownCommand(subject: DownCommandSubject): string | null {
  const spec = downCommandSpec(subject.eventType)
  if (!spec) return 'unknown_down_event_type'
  if (!isCentralEntityType(subject.entityType) || subject.entityType !== spec.entityType) {
    return `entity_type_mismatch:${subject.eventType}≠${String(subject.entityType)}`
  }
  if (!subject.targetDeviceId && !subject.targetEmployeeId) return 'missing_target'
  const payload = subject.payload
  const role = String(payload.deliveryRole ?? '')
  if (!(DOWN_DELIVERY_ROLES as readonly string[]).includes(role)) return `invalid_delivery_role:${role || '(缺失)'}`
  if (!spec.roles.includes(role as DownDeliveryRole)) return `delivery_role_not_allowed:${subject.eventType}/${role}`

  const forbidden = findForbiddenDownlinkField(payload)
  if (forbidden) return `forbidden_field:${forbidden}`

  const allowed = new Set(spec.allowed)
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) return `unknown_field:${key}`
  }
  for (const field of spec.required) {
    if (isBlank(payload[field])) return `missing_field:${field}`
  }
  for (const field of spec.requiredTimestamps ?? []) {
    const n = Number(payload[field] ?? 0)
    if (!Number.isFinite(n) || n <= 0) return `invalid_timestamp:${field}`
  }
  for (const [field, values] of Object.entries(spec.enums ?? {})) {
    if (isBlank(payload[field])) continue
    if (!values.includes(String(payload[field]))) return `invalid_enum:${field}`
  }
  for (const [field, max] of Object.entries(spec.maxLength ?? {})) {
    const value = payload[field]
    if (value === undefined || value === null) continue
    if (typeof value !== 'string') return `invalid_type:${field}`
    if (value.length > max) return `too_long:${field}`
  }
  // lead 子对象：结构、白名单与 leadId 必填
  const lead = payload.lead
  if (lead !== undefined && lead !== null) {
    if (!spec.leadFields) return 'unexpected_lead'
    if (typeof lead !== 'object' || Array.isArray(lead)) return 'invalid_lead'
    const leadAllowed = new Set(spec.leadFields)
    for (const key of Object.keys(lead as Record<string, unknown>)) {
      if (!leadAllowed.has(key)) return `unknown_lead_field:${key}`
    }
    if (isBlank((lead as Record<string, unknown>).leadId)) return 'missing_field:lead.leadId'
  }
  return null
}

/**
 * 下行指令引用的目标投影形态检查：
 *  - `customerRef`/`opportunityRef`/`leadRef` 等引用必须是设备命名空间形态（含 `/`），
 *    裸 `customer:1` 说明发送方漏了 scopedRef，中央无法跨表关联；
 *  - `entityId` 的 localRef 类别必须与 entityType 相符（`assignment` → `assignment:<id>`）。
 * 只在这些字段出现时检查，不做全量遍历。
 */
const ENTITY_ID_KIND: Record<string, string> = {
  customer: 'customer',
  customer_identity: 'identity',
  assignment: 'assignment',
  // ownership 的本机投影真源是 account.owner_sales，但 localRef 前缀是 `ownership:`（见 centralProjection）——
  // 这里必须与投影实际产出的前缀一致，否则该投影每一行都会被本地自检拦下（entity_id_kind_mismatch）
  ownership: 'ownership',
  opportunity: 'opportunity',
  quote: 'quotation',
  audit_event: 'audit',
  customer_judgment: 'judgment',
  knowledge_proposal: 'kb',
  permission: 'permission'
}

export function validateCentralEntityId(entityType: string, entityId: string): string | null {
  if (!isCentralEntityType(entityType)) return 'invalid_entity_type'
  const kind = refKindOf(entityId)
  if (!kind) return 'entity_id_not_scoped'
  const expected = ENTITY_ID_KIND[entityType]
  if (expected && kind !== expected) return `entity_id_kind_mismatch:${kind}≠${expected}`
  return null
}

/** 事件是否声明了非上行的方向（下行指令必须 direction=down）。 */
export function isDownDirection(event: Pick<CentralSyncEvent, 'direction'>): boolean {
  return event.direction === 'down'
}
