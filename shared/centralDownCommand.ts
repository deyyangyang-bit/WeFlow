/**
 * 中央下行指令的类型级契约（Phase 3a 收口）。
 *
 * 为什么需要它：SMB 文件路径有 `validateDownEventFile` 本体校验（to / eventSeq / type-role /
 * 文件名逐项绑定），而 HTTP 下行此前只有通用信封校验，直接调 applyDownEventDirect —— 同一条
 * 业务规则在两处各写一遍必然漂移。本模块是**唯一**的下行业务校验器，两条入口共用同一份 spec：
 *   - centralSyncService.toLocalEvent   → 中央 HTTP 下行的本机应用侧（transport = 'central-http'）；
 *   - centralSyncService.pushOutboxCommand → 中央 HTTP 上行发送前自检（transport = 'central-http'）；
 *   - central/src/app.ts `/sync/commands`  → 中央侧在建指令时就按同一份 spec 拒收；
 *   - lanSyncService.validateDownEventFile → SMB 文件通道（transport = 'smb'）在本体校验通过后、
 *     进入任何业务事务之前调用 validateDownCommand：payload 白名单/必填/类型/lead 建档契约
 *     全部走本模块，SMB 专属检查（投递键、文件名绑定、主管通知分流）留在 validateDownEventFile。
 *
 * 纪律：payload 是**严格白名单**——未登记字段一律拒收整事件，不做静默裁剪（静默裁剪会让
 * 发送方误以为已成功投递）。聊天正文与会话标识任何方向都不许出现。
 *
 * 线索资料子对象的字段白名单按**传输上下文**分档（Phase 3a 阻断项 §2）：
 *   - `smb`：Phase 1 内网文件通道的历史口径，含 contactRaw / wechat 原文。该通道是同一局域网内
 *     已互信设备之间的文件投递，语义不在中央收口范围内，**不得改动**；
 *   - `central-http`：中央 HTTP 下行。中央只接受 6 个字段，contactRaw / wechat 一律 400 且不落库。
 * 两档共用同一份指令状态机（roles / required / allowed / enums / maxLength），仅在 lead 子对象
 * 字段集上分叉——避免出现两套会各自漂移的业务规则。
 */
import {
  CENTRAL_ENTITY_TYPES, findForbiddenDownlinkField, isCentralEntityType, isConcreteRef, refKindOf,
  type CentralEntityType, type CentralSyncEvent
} from './centralSync'

export const DOWN_DELIVERY_ROLES = ['apply', 'remove', 'notify'] as const
export type DownDeliveryRole = typeof DOWN_DELIVERY_ROLES[number]

const SALES_NAME_MAX = 60
const REASON_MAX = 200
const TITLE_MAX = 80
const SUMMARY_MAX = 500
const ROLE_MAX = 40

const LEAD_NAME_MAX = 120
const LEAD_SOURCE_MAX = 60
const LEAD_NOTE_MAX = 1000
const LEAD_CONTACT_NORMALIZED_MAX = 120
const LEAD_CONTACT_RAW_MAX = 120
const LEAD_WECHAT_MAX = 120

/**
 * 分配模式（`assignment.mode`）的**唯一枚举源**：UI、审计与两条同步通道共用这一份，
 * 禁止各处再写一遍字面量数组后各自漂移。取值口径 = 本机真实写入语义：
 *   - `manual`     单条指派（assignLeads 缺省值）；
 *   - `weight`     批量分配按比例权重（分配页缺省）；
 *   - `round_robin` 轮询分发；
 *   - `load`       按当前负载均衡。
 * 该字段在 assign 上是**可选**（出现即必须合法），在 transfer 上是**必填**（见 DOWN_COMMAND_SPECS）。
 */
export const ASSIGNMENT_MODES = ['manual', 'weight', 'round_robin', 'load'] as const
export type AssignmentMode = typeof ASSIGNMENT_MODES[number]

/** 线索联系方式类别（本机 lead.contact_type 的真实枚举，不允许下游自造值） */
export const LEAD_CONTACT_TYPES = ['phone', 'wechat', 'both'] as const

/** 传输上下文：同一份指令状态机，两档 lead 字段白名单 */
export const DOWN_TRANSPORTS = ['smb', 'central-http'] as const
export type DownTransport = typeof DOWN_TRANSPORTS[number]

/** SMB 内网文件通道的历史口径（含 contactRaw / wechat 原文）——Phase 1 语义，不得收窄 */
export const SMB_LEAD_FIELDS = [
  'leadId', 'name', 'contactType', 'contactNormalized', 'contactRaw', 'wechat', 'source', 'note'
] as const

/** 中央 HTTP 下行口径：只允许 6 个字段，排除 contactRaw / wechat 原文 */
export const CENTRAL_LEAD_FIELDS = [
  'leadId', 'name', 'contactType', 'contactNormalized', 'source', 'note'
] as const

const LEAD_FIELDS_BY_TRANSPORT: Record<DownTransport, readonly string[]> = {
  smb: SMB_LEAD_FIELDS,
  'central-http': CENTRAL_LEAD_FIELDS
}

/** 取某传输上下文允许的 lead 子对象字段集 */
export function leadFieldsFor(transport: DownTransport): readonly string[] {
  return LEAD_FIELDS_BY_TRANSPORT[transport]
}

interface LeadFieldRule {
  /** positive_int = 正整数；string = 字符串 */
  kind: 'positive_int' | 'string'
  max?: number
  enum?: readonly string[]
}

/**
 * lead 子对象逐字段的类型/长度/枚举约束。
 * smb 档允许出现的 contactRaw / wechat 也在此登记，中央档由白名单先行拦下。
 */
const LEAD_FIELD_RULES: Record<string, LeadFieldRule> = {
  leadId: { kind: 'positive_int' },
  name: { kind: 'string', max: LEAD_NAME_MAX },
  contactType: { kind: 'string', enum: LEAD_CONTACT_TYPES },
  contactNormalized: { kind: 'string', max: LEAD_CONTACT_NORMALIZED_MAX },
  contactRaw: { kind: 'string', max: LEAD_CONTACT_RAW_MAX },
  wechat: { kind: 'string', max: LEAD_WECHAT_MAX },
  source: { kind: 'string', max: LEAD_SOURCE_MAX },
  note: { kind: 'string', max: LEAD_NOTE_MAX }
}

/**
 * 顶层字段的**共享运行时规则**（HTTP 与 SMB 共用同一份，见 DOWN_COMMAND_SPECS.fields）。
 * 形态取值口径 = 各字段在本机真实业务写入时的形态，不新造语义：
 *   - `positive_int`：原始 number 类型的安全正整数（行号 / 计数）。绝不 `Number()` 后再判：
 *     字符串数字、小数、NaN、Infinity、0、负数、对象、数组、布尔一律拒收；
 *   - `non_negative_int`：原始 number 类型的安全非负整数（计数类）；
 *   - `timestamp`：原始 number 类型的安全正整数毫秒时间戳，所有非法形态统一返回
 *     `invalid_timestamp:<field>`；
 *   - `string`：字符串字面量（可叠加 maxLength / enum）；
 *   - `object`：非 null、非数组的普通 JSON 对象。
 */
export type DownFieldKind = 'positive_int' | 'non_negative_int' | 'timestamp' | 'string' | 'object'

export interface DownFieldRule {
  kind: DownFieldKind
  /** 数值字段的取值范围（含端点；缺省 = 该 kind 的自然边界） */
  min?: number
  max?: number
  /** 仅有实际历史兼容依据时才允许：显式 null 按省略处理。 */
  nullMeansAbsent?: boolean
}

/**
 * `remindCount` 的真实值域：上游生产者（`crmAssignmentService` 三次提醒制）**恒发 3**，
 * 消费端（`crmNotifyService` / 接收端通知正文）按 `N/3` 渲染，`sla1_remind_count` 的列语义本身就是
 * 「已提醒次数」，永远到不了 3（满 3 即回收）。因此合法区间 = `[0, 3]`：
 * 越界值会让主管收到的「N/3 次超时未完成首触」变成假话，必须在建指令时拒收而不是静默夹取。
 * 0 允许：语义是「未提醒过」，与列默认值一致（历史与迁移行可能为 0）。
 */
export const REMIND_COUNT_MIN = 0
export const REMIND_COUNT_MAX = 3

/**
 * `slaHours` 的真实值域：`crmLeadSlaHours` 配置的可接受区间（`crmAssignmentService.sla1Hours` /
 * `lanSyncService.slaHoursNow` 同口径：1-72，越界回落 24）。SMB 历史信封额外携带它，
 * 出现即必须是这一区间内的原始 number 整数——否则会把「发送端写死的 SLA 小时数」变成
 * 对象 / 字符串 / NaN 之类的伪造值，下游 `Number()` 后静默变成另一段时间。
 */
export const SLA_HOURS_MIN = 1
export const SLA_HOURS_MAX = 72

/** 数值规则 → 稳定错误码；只带字段名，绝不带字段值（被拦下的值可能就是客户数据） */
function checkNumberField(field: string, value: unknown, rule: DownFieldRule): string | null {
  const invalidCode = rule.kind === 'timestamp' ? `invalid_timestamp:${field}` : null
  if (typeof value !== 'number' || !Number.isFinite(value)) return invalidCode ?? `invalid_type:${field}`
  // Number.isSafeInteger 同时排除 NaN / Infinity / 小数及超出 JS 安全整数范围的数字。
  if (!Number.isSafeInteger(value)) return invalidCode ?? `invalid_integer:${field}`
  // kind 自带自然下界：positive_int ≥ 1、non_negative_int ≥ 0。显式 min/max 只用于**收窄**，
  // 绝不能因为没登记 min 就让 0 / 负数溜过去（曾经的缺陷：`assignmentId: 0` 与
  // `oldAssignmentId: 0` 无下界可用，仍被判为合法）。
  const naturalFloor = rule.kind === 'positive_int' || rule.kind === 'timestamp'
    ? 1
    : rule.kind === 'non_negative_int' ? 0 : undefined
  // 显式 min 只能收窄字段范围，不能把 kind 自带的自然下界放宽。
  const floor = naturalFloor === undefined ? rule.min : Math.max(naturalFloor, rule.min ?? naturalFloor)
  if (floor !== undefined && value < floor) return invalidCode ?? `invalid_integer:${field}`
  if (rule.max !== undefined && value > rule.max) return invalidCode ?? `invalid_integer:${field}`
  return null
}

/** 顶层字段规则校验：`declared` 必填/可选由调用方判定，这里只负责「出现时的形态」 */
function checkDeclaredField(field: string, value: unknown, rule: DownFieldRule, maxLength?: number): string | null {
  if (rule.kind === 'string') {
    if (typeof value !== 'string') return `invalid_type:${field}`
    if (value.length === 0) return `invalid_type:${field}`
    if (maxLength !== undefined && value.length > maxLength) return `too_long:${field}`
    return null
  }
  if (rule.kind === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return `invalid_type:${field}`
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return `invalid_type:${field}`
    return null
  }
  return checkNumberField(field, value, rule)
}

export interface DownCommandSpec {
  entityType: CentralEntityType
  roles: readonly DownDeliveryRole[]
  /** 顶层必填字段（缺失/空串即拒收） */
  required: readonly string[]
  /** 顶层允许字段（严格白名单；未登记字段拒收整事件） */
  allowed: readonly string[]
  /** 是否允许携带 lead 子对象；false = 携带即拒收 */
  allowsLead?: boolean
  /** SMB 历史信封额外允许的顶层字段（中央 HTTP 不放开） */
  smbAllowedExtra?: readonly string[]
  /** SMB 历史信封允许携带 lead 子对象（中央 HTTP 仍按 allowsLead 拒收） */
  smbAllowsLead?: boolean
  enums?: Record<string, readonly string[]>
  maxLength?: Record<string, number>
  /**
   * 顶层字段的共享运行时规则（2026-09-15 严格化）：必填与非必填字段都登记在这里，
   * 缺失判定看字段是否出现在 `required`，**出现时**的形态一律按本表判。
   * 「字段在 `required` 但没登记规则」= 注册表自相矛盾，`validateDownCommand` 直接拒收
   * （见 `unregistered_field_rule:`），不给「只判非空就放行」留后门。
   */
  fields?: Record<string, DownFieldRule>
  /**
   * 必填的数值时间戳字段（版本前置条件用）。与 `fields` 中 `timestamp` 规则**同源**：
   * 字段同时在 `fields` 登记为 `timestamp`，本列表只声明「必填」，不再另起一轮校验。
   * 这样 `recycledAt` / `sla1Deadline` 的既有稳定错误码统一为 `invalid_timestamp:<field>`。
   */
  requiredTimestamps?: readonly string[]
}

/**
 * 下行指令注册表。eventType 与 entityType 必须一一匹配（eventType/entityType 不一致在服务端拒收）。
 * 投递角色与 Phase 1 SMB 口径一致：assign/recycle → apply；transfer → apply|remove；
 * 主管通知 → notify；本阶段新增的两类中央专有指令 → apply。
 * 各类型的 lead 子对象允许字段由 transport 决定，见 leadFieldsFor()。
 *
 * transfer 的 SLA 纪律（2026-09-15 移交 SLA 修复）：sla1Deadline 与 mode 是**移交事实产生时**
 * 就确定的值，必须随指令传递（required/requiredTimestamps），接收端落地**精确等于指令值**，
 * 绝不在接收端按「当前配置小时数」重算（设备时钟/配置不同会漂移）。SMB 与中央 HTTP 同一口径。
 */
export const DOWN_COMMAND_SPECS: Record<string, DownCommandSpec> = {
  assign: {
    entityType: 'assignment',
    roles: ['apply'],
    required: ['type', 'leadId', 'assignmentId', 'salesName', 'lead'],
    allowed: ['type', 'deliveryRole', 'leadId', 'assignmentId', 'salesName', 'mode', 'sla1Deadline', 'actor', 'slaHours', 'lead'],
    allowsLead: true,
    // mode 在 assign 上是**可选**（发送方可省略），但**出现即必须是 ASSIGNMENT_MODES 内的字符串**
    enums: { mode: ASSIGNMENT_MODES },
    maxLength: { salesName: SALES_NAME_MAX },
    fields: {
      type: { kind: 'string' },
      leadId: { kind: 'positive_int' },
      assignmentId: { kind: 'positive_int' },
      salesName: { kind: 'string' },
      // assign 的 sla1Deadline 可选（缺失由接收端既有兜底处理），出现即必须是绝对时间戳
      sla1Deadline: { kind: 'timestamp' },
      slaHours: { kind: 'positive_int', min: SLA_HOURS_MIN, max: SLA_HOURS_MAX },
      actor: { kind: 'string' }
    }
  },
  transfer: {
    entityType: 'assignment',
    roles: ['apply', 'remove'],
    required: ['type', 'leadId', 'assignmentId', 'toSales', 'lead', 'mode'],
    allowed: ['type', 'deliveryRole', 'leadId', 'assignmentId', 'fromSales', 'toSales', 'reason', 'oldAssignmentId', 'actor', 'slaHours', 'mode', 'sla1Deadline', 'lead'],
    allowsLead: true,
    // transfer 的 mode 必填（见 required）且受同一份枚举约束——禁止「非空字符串即通过」
    enums: { mode: ASSIGNMENT_MODES },
    maxLength: { toSales: SALES_NAME_MAX, fromSales: SALES_NAME_MAX, reason: REASON_MAX },
    fields: {
      type: { kind: 'string' },
      leadId: { kind: 'positive_int' },
      assignmentId: { kind: 'positive_int' },
      // oldAssignmentId 可选（Phase 1 信封恒带）。历史文档明确允许 null/省略表示未提供，
      // 因此例外必须登记在字段规则里，不能由所有可选字段共用一个 null 旁路。
      oldAssignmentId: { kind: 'positive_int', nullMeansAbsent: true },
      toSales: { kind: 'string' },
      fromSales: { kind: 'string' },
      reason: { kind: 'string' },
      sla1Deadline: { kind: 'timestamp' },
      slaHours: { kind: 'positive_int', min: SLA_HOURS_MIN, max: SLA_HOURS_MAX },
      actor: { kind: 'string' }
    },
    requiredTimestamps: ['sla1Deadline']
  },
  recycle: {
    entityType: 'assignment',
    roles: ['apply'],
    required: ['type', 'leadId', 'assignmentId', 'salesName'],
    allowed: ['type', 'deliveryRole', 'leadId', 'assignmentId', 'salesName', 'reason', 'actor'],
    // SMB 历史信封在 recycle 上也携带 lead 资料与 slaHours（emitDownEvents 统一附加，Phase 1 口径）；
    // 中央 HTTP 不放开：commandPayloadOf('recycle') 不产 lead，服务端携带即 400。
    smbAllowedExtra: ['lead', 'slaHours'],
    smbAllowsLead: true,
    maxLength: { salesName: SALES_NAME_MAX, reason: REASON_MAX },
    fields: {
      type: { kind: 'string' },
      leadId: { kind: 'positive_int' },
      assignmentId: { kind: 'positive_int' },
      salesName: { kind: 'string' },
      reason: { kind: 'string' },
      // 只在 smb 档开口（central 档由白名单先拦 unknown_field:slaHours）
      slaHours: { kind: 'positive_int', min: SLA_HOURS_MIN, max: SLA_HOURS_MAX },
      actor: { kind: 'string' }
    }
  },
  sla1_escalate_supervisor: {
    entityType: 'assignment',
    roles: ['notify'],
    required: ['type', 'leadId', 'assignmentId', 'salesName', 'remindCount'],
    // contactMasked：跨机投递时通知正文里的联系方式只出**掩码**（原文不出机，PRD §10 R4）
    allowed: ['type', 'deliveryRole', 'leadId', 'assignmentId', 'salesName', 'remindCount', 'reason', 'recycledAt', 'contactMasked'],
    // SMB 中枢通知历史文件会附带最小 lead 身份资料，供本机没有同一 lead 行时生成脱敏摘要；
    // 中央 HTTP 仍不放开 lead，改由 commandPayloadOf 传 contactMasked。
    smbAllowedExtra: ['lead'],
    smbAllowsLead: true,
    maxLength: { salesName: SALES_NAME_MAX, reason: REASON_MAX, contactMasked: 40 },
    fields: {
      type: { kind: 'string' },
      leadId: { kind: 'positive_int' },
      assignmentId: { kind: 'positive_int' },
      salesName: { kind: 'string' },
      remindCount: { kind: 'non_negative_int', min: REMIND_COUNT_MIN, max: REMIND_COUNT_MAX },
      reason: { kind: 'string' },
      recycledAt: { kind: 'timestamp' },
      contactMasked: { kind: 'string' }
    },
    requiredTimestamps: ['recycledAt']
  },
  supervisor_correction: {
    entityType: 'assignment',
    roles: ['apply'],
    required: ['type', 'leadId', 'title', 'summary'],
    allowed: ['type', 'deliveryRole', 'leadId', 'assignmentId', 'title', 'summary', 'detail', 'actor'],
    maxLength: { title: TITLE_MAX, summary: SUMMARY_MAX },
    fields: {
      type: { kind: 'string' },
      leadId: { kind: 'positive_int' },
      assignmentId: { kind: 'positive_int' },
      title: { kind: 'string' },
      summary: { kind: 'string' },
      // 可选；出现时必须是非 null、非数组的普通 JSON 对象。
      detail: { kind: 'object' },
      actor: { kind: 'string' }
    }
  },
  permission_change: {
    entityType: 'permission',
    roles: ['apply'],
    required: ['type', 'employeeRef', 'declaredRole'],
    allowed: ['type', 'deliveryRole', 'employeeRef', 'declaredRole', 'authoritySource', 'displayName'],
    maxLength: { employeeRef: 120, declaredRole: ROLE_MAX, displayName: SALES_NAME_MAX },
    fields: {
      type: { kind: 'string' },
      employeeRef: { kind: 'string' },
      declaredRole: { kind: 'string' },
      authoritySource: { kind: 'string' },
      displayName: { kind: 'string' }
    }
  }
}

export const DOWN_COMMAND_TYPES = Object.keys(DOWN_COMMAND_SPECS)

/**
 * 校验注册表中每个 allowed 顶层字段的责任归属。
 *
 * allowed 只是白名单，不应成为「登记了但没有任何校验器」的后门。除 fields / enums 外，
 * `deliveryRole` 由共享角色校验器负责，`lead` 由 validateLeadObject 负责；其它字段必须且只能
 * 命中一个责任归属。函数导出给纯测试使用，同时在 validateDownCommand 中作为运行时护栏调用。
 */
export function downCommandSpecResponsibilityErrors(
  specs: Record<string, DownCommandSpec> = DOWN_COMMAND_SPECS
): string[] {
  const errors: string[] = []
  for (const [eventType, spec] of Object.entries(specs)) {
    const entries: Array<{ field: string; source: 'allowed' | 'smb' }> = [
      ...spec.allowed.map((field) => ({ field, source: 'allowed' as const })),
      ...(spec.smbAllowedExtra ?? []).map((field) => ({ field, source: 'smb' as const }))
    ]
    for (const { field, source } of entries) {
      const owners: string[] = []
      if (field === 'deliveryRole') owners.push('deliveryRole')
      if (field === 'lead' && (spec.allowsLead === true || spec.smbAllowsLead === true)) owners.push('lead')
      if (spec.fields?.[field]) owners.push('fields')
      if (spec.enums?.[field]) owners.push('enums')
      if (owners.length !== 1) {
        errors.push(`${eventType}:${source}:${field}:${owners.length === 0 ? 'missing' : 'multiple'}`)
      }
    }
  }
  return errors
}

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
  /**
   * SMB 文件信封上的 deliveryRole。中央 HTTP 没有独立的信封角色，继续从 payload 读取；
   * SMB 若同时带 payload.deliveryRole，则两者必须是同一个原始字符串值。
   */
  deliveryRole?: unknown
  targetEmployeeId?: string
  targetDeviceId?: string
  /**
   * SMB 文件通道没有中央 UUID 目标字段：用**已通过「等于本机投递键」校验**的投递键
   * 作为「目标是本机」的传输上下文。只在 transport='smb' 时有效，绝不伪造业务 UUID。
   */
  localDeliveryKey?: string
}

/**
 * lead 子对象的建档必填字段（按 transport 分档，2026-09-15 建档契约修复）：
 *   - 两条通道共同的最小身份：leadId（正整数）+ contactType（枚举）+ contactNormalized（非空）——
 *     缺任何一项，接收端要么无法定位身份，要么会以空 contact_normalized 建档并撞
 *     UNIQUE(contact_type, contact_normalized)，一律拒收；
 *   - central-http：文档口径是「固定 6 字段」，因此 6 项必须**全部存在**；
 *     name/source/note 允许空串，但必须以正确的字符串类型存在；
 *   - smb：历史 8 字段口径，name/source/note/contactRaw/wechat 存在即校验、不强制存在
 *     （既有生产文件由 leadProfileOf 生成恒带 8 字段；强制存在反而可能误杀历史文件）。
 */
const LEAD_REQUIRED_FIELDS: Record<DownTransport, readonly string[]> = {
  smb: ['leadId', 'contactType', 'contactNormalized'],
  'central-http': CENTRAL_LEAD_FIELDS
}

/**
 * lead 子对象的字段白名单 + 逐字段类型/长度/枚举校验 + 建档必填。返回稳定错误码（null = 通过）。
 * 错误码只带字段名，不带字段值。
 */
function validateLeadObject(lead: unknown, allowsLead: boolean, transport: DownTransport): string | null {
  if (lead === undefined) return null
  if (lead === null) return 'invalid_lead'
  if (!allowsLead) return 'unexpected_lead'
  if (typeof lead !== 'object' || Array.isArray(lead)) return 'invalid_lead'
  const record = lead as Record<string, unknown>
  const allowed = new Set(leadFieldsFor(transport))
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) return `unknown_lead_field:${key}`
  }
  for (const [key, value] of Object.entries(record)) {
    const rule = LEAD_FIELD_RULES[key]
    if (!rule || value === undefined || value === null) continue
    if (rule.kind === 'positive_int') {
      // Number.isSafeInteger 已排除 NaN / 小数 / 字符串数字及超出安全范围的 id。
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) return `invalid_lead_field:${key}`
      continue
    }
    if (typeof value !== 'string') return `invalid_lead_field:${key}`
    if (rule.max !== undefined && value.length > rule.max) return `too_long_lead_field:${key}`
    if (rule.enum && !rule.enum.includes(value)) return `invalid_lead_field:${key}`
  }
  for (const field of LEAD_REQUIRED_FIELDS[transport]) {
    if (record[field] === undefined || record[field] === null) return `missing_lead_field:${field}`
  }
  // contactNormalized 是身份定位与建档的唯一锚点：空串 = 空身份，两条通道都拒收
  if (isBlank(record.contactNormalized)) return 'missing_lead_field:contactNormalized'
  return null
}

/**
 * 校验一条下行指令；返回稳定错误码（null = 通过）。
 * 错误码与 message 都只带**字段名**，绝不带字段值——被拦下的值可能就是客户数据。
 * transport 缺省为最严格的 `central-http`，调用方必须显式传 `smb` 才能拿到宽松档。
 */
export function validateDownCommand(subject: DownCommandSubject, transport: DownTransport = 'central-http'): string | null {
  const spec = downCommandSpec(subject.eventType)
  if (!spec) return 'unknown_down_event_type'
  const registryError = downCommandSpecResponsibilityErrors().find((error) => error.startsWith(`${subject.eventType}:`))
  if (registryError) return `unregistered_allowed_field_rule:${registryError}`
  if (!isCentralEntityType(subject.entityType) || subject.entityType !== spec.entityType) {
    return `entity_type_mismatch:${subject.eventType}≠${String(subject.entityType)}`
  }
  // 「目标存在性」按 transport 判定：中央 HTTP 必须带 UUID 目标；SMB 用已验证的本机投递键
  const hasTarget = Boolean(subject.targetDeviceId || subject.targetEmployeeId) ||
    (transport === 'smb' && Boolean(subject.localDeliveryKey))
  if (!hasTarget) return 'missing_target'
  const payload = subject.payload
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return 'invalid_payload'
  const payloadHasRole = Object.prototype.hasOwnProperty.call(payload, 'deliveryRole')
  const payloadRole = payload.deliveryRole
  const role = subject.deliveryRole !== undefined ? subject.deliveryRole : payloadRole
  // 角色判定必须基于原始值。错误码只描述字段/结论，不回显载荷值。
  if (isBlank(role)) return 'missing_field:deliveryRole'
  if (typeof role !== 'string') return 'invalid_type:deliveryRole'
  if (!(DOWN_DELIVERY_ROLES as readonly string[]).includes(role)) return 'invalid_delivery_role:deliveryRole'
  if (!spec.roles.includes(role as DownDeliveryRole)) return 'delivery_role_not_allowed:deliveryRole'
  // SMB 的外层角色是路由来源；若 payload 也带角色，不能让两层各自声明不同角色。
  // undefined 视作省略（现有 SMB 生产文件只在信封带角色），null/空串仍按原始非法值拒收。
  if (subject.deliveryRole !== undefined && payloadHasRole && payloadRole !== undefined) {
    if (isBlank(payloadRole)) return 'missing_field:deliveryRole'
    if (typeof payloadRole !== 'string') return 'invalid_type:deliveryRole'
    if (payloadRole !== role) return 'delivery_role_mismatch'
  }

  const forbidden = findForbiddenDownlinkField(payload)
  if (forbidden) return `forbidden_field:${forbidden}`

  const allowed = new Set(spec.allowed)
  if (transport === 'smb') for (const extra of spec.smbAllowedExtra ?? []) allowed.add(extra)
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) return `unknown_field:${key}`
  }
  // 顶层字段：缺失判定看 spec.required + requiredTimestamps，**出现时**的形态一律按
  // spec.fields 的共享规则判。requiredTimestamps 只声明「哪些 timestamp 必填」，不再另起
  // 一轮数值校验，避免同一字段因校验顺序漂移出两套错误码。
  // 两种字段不登记 fields，因为它们已有**更专门**的校验器，重复登记只会制造两份会各自漂移的规则：
  //   - `lead`：子对象，由 validateLeadObject 按 transport 分档单管（白名单/逐字段/建档必填）；
  //   - 出现在 spec.enums 里的字段（如 transfer 的 `mode`）：由枚举分支按「字符串字面量」判。
  // 其余顶层标量字段若在 required 却既无 fields 也无上述专门校验 = 注册表自相矛盾，直接拒收，
  // 不给「只判非空就放行」留后门（曾经的缺陷：`assignmentId: 0` / `leadId: "41"` /
  // `remindCount: {}` 全被判为合法）。
  const fieldRules = spec.fields ?? {}
  const enumFields = new Set(Object.keys(spec.enums ?? {}))
  const requiredFields = new Set([...spec.required, ...(spec.requiredTimestamps ?? [])])
  for (const field of requiredFields) {
    const rule = fieldRules[field]
    const present = Object.prototype.hasOwnProperty.call(payload, field)
    const value = payload[field]
    // JSON 中 undefined 会消失；纯函数层显式 undefined 也视作未提供。空串沿用既有必填缺失口径。
    if (!present || value === undefined || (typeof value === 'string' && value.trim() === '')) {
      return `missing_field:${field}`
    }
    if (!rule) {
      if (field === 'lead') {
        if (value === null) return 'invalid_lead'
        continue
      }
      if (enumFields.has(field)) {
        if (value === null) return `invalid_enum:${field}`
        continue
      }
      return `unregistered_field_rule:${field}`
    }
    const error = checkDeclaredField(field, value, rule, spec.maxLength?.[field])
    if (error) return error
  }
  const payloadType = payload.type
  // type 已先由 fields 规则做「原始字符串 + 非空」校验，这里只做信封一致性判定。
  if (payloadType !== subject.eventType) return 'payload_type_mismatch'
  // 非必填但已登记规则的字段：键不存在或值为 undefined 才是省略；显式 null 默认非法。
  // 只有字段规则明确登记 nullMeansAbsent 时，才保留历史兼容的 null=未提供语义。
  for (const [field, rule] of Object.entries(fieldRules)) {
    if (requiredFields.has(field)) continue
    const present = Object.prototype.hasOwnProperty.call(payload, field)
    const value = payload[field]
    if (!present || value === undefined) continue
    if (value === null && rule.nullMeansAbsent === true) continue
    const error = checkDeclaredField(field, value, rule, spec.maxLength?.[field])
    if (error) return error
  }
  for (const [field, values] of Object.entries(spec.enums ?? {})) {
    const value = payload[field]
    // ① 未设置与「设置了非法值」是两回事：缺省由 spec.required 判（transfer.mode 在 required 里，
    //    缺了必拒；assign.mode 可选，缺了合法），这里只负责「出现时的形态」。
    if (!Object.prototype.hasOwnProperty.call(payload, field) || value === undefined) continue
    // ② 出现即必须是**字符串字面量**：绝不 `String(value)` 再比对——`{}`/`[]`/`1`/`true`/`false`
    //    都会被 String() 变成一个「看起来合法」的字符串，从而把非法载荷放进业务状态机。
    //    空串同样拒收：发送方应省略可选字段，而不是发空串让接收端各自兜底。
    if (typeof value !== 'string' || !values.includes(value)) return `invalid_enum:${field}`
  }
  for (const [field, max] of Object.entries(spec.maxLength ?? {})) {
    const value = payload[field]
    if (value === undefined || value === null) continue
    if (typeof value !== 'string') return `invalid_type:${field}`
    if (value.length > max) return `too_long:${field}`
  }
  const allowsLead = spec.allowsLead === true || (transport === 'smb' && spec.smbAllowsLead === true)
  const leadError = validateLeadObject(payload.lead, allowsLead, transport)
  if (leadError) return leadError
  // 顶层 leadId 与 lead.leadId 必须一致：不一致说明指令本身自相矛盾，禁止按其中一个猜
  const leadObj = payload.lead
  if (leadObj && typeof leadObj === 'object' && !Array.isArray(leadObj)) {
    const subId = (leadObj as Record<string, unknown>).leadId
    // **原始类型直接比较**，绝不 `Number()` 后再比：`Number("41") === Number(41)` 会让
    // 「字符串数字的顶层 leadId + 数字的子对象 leadId」被当成一致（同一 id 的两种类型表述，
    // 下游各自解读必然漂移）。两侧都已在各自规则下通过严格正整数校验，此处只做相等判定。
    if (!isBlank(payload.leadId) && subId !== undefined && subId !== null &&
      payload.leadId !== subId) return 'lead_id_mismatch'
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
/**
 * entityId 的引用类别映射。校验分三步（2026-09-15 收紧）：
 *   ① 必须含设备命名空间且 localRef 有 `kind:` —— 裸 `customer:1` 拒（entity_id_not_scoped）；
 *   ② 冒号后必须有**非空白**的本地行号 —— `device/customer:` 与 `device/customer:   ` 拒
 *      （entity_id_not_concrete）；只到类别级别的引用无法跨表关联到任何一行；
 *   ③ localRef 的 kind 必须与 entityType 相符。
 * 具体引用判定复用 shared/centralSync.isConcreteRef()，不在这里另写解析器。
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
  // 「有类别」不等于「指向具体一行」：`device/customer:` 过得了前三步却没有任何行号。
  // 判定与 refKindOf 同源（都来自 shared/centralSync），不新造第三个解析器。
  if (!isConcreteRef(entityId)) return 'entity_id_not_concrete'
  const expected = ENTITY_ID_KIND[entityType]
  if (expected && kind !== expected) return `entity_id_kind_mismatch:${kind}≠${expected}`
  return null
}

/** 事件是否声明了非上行的方向（下行指令必须 direction=down）。 */
export function isDownDirection(event: Pick<CentralSyncEvent, 'direction'>): boolean {
  return event.direction === 'down'
}
