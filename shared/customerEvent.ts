/**
 * shared/customerEvent.ts —— 客户事件的唯一语义源（前后端共用，纯模块零依赖）
 *
 * P0-3 E3 契约（E3.1 Infrastructure，Scope Lock 2026-08-23）：
 *   customer_event = 客观发生的事实（客户行为 + 用户行动），session 轴，append-only。
 *
 * 硬门禁（四者不互相冒充，防 customer_event 变成万能日志表）：
 *   - customer_event   = 客观发生的事实（本模块）
 *   - intent_tag_log   = AI / classifier / manual 对意向的判定（不迁、不合并）
 *   - customer_judgment= AI 对客户当前状态的结构化判断（P0-2C，不含 stage）
 *   - customer_profile = 当前 canonical State（P0-2A）
 *   event_type 只允许五类（DB CHECK + 本模块 isCustomerEventType 双重拦截）；
 *   新增事件类型必须走迁移，是有意的摩擦。stage / judgment 类语义严禁入表。
 *
 * 证据链：message_key 为 P0-2B 证据锚点（getEvidenceByKey 回查原话），
 *   与 customer_judgment 同一锚点机制，不发明第二套证据。无可靠 key 必须留空。
 *
 * 幂等：有 message_key 的事件天然幂等（DB partial unique index，同 key 拒绝）；
 *   无 key 的手动事件（如手动标记跟进完成）允许重复。
 *
 * P0-4.2.1 correlation 三元组（哪条建议 → 哪次执行 → 哪次响应）：
 *   session_id —— 客户轴（必填）
 *   task_id    —— 行动轴（行动事件关联 follow_up_task.id；无任务上下文允许 NULL，禁止伪造）
 *   message_key —— 证据轴（E3.2 客户行为事件；无可靠 key 必须留空）
 *   task_id 是 correlation key，不是事件合法性的前置条件——不是每个事件都有行动上下文。
 */

/** 首期事件类型（写入契约；排序 = 文档顺序，非业务权重） */
export const CUSTOMER_EVENT_TYPES = [
  'customer_replied',
  'quote_asked',
  'script_copied',
  'chat_opened',
  'follow_up_done'
] as const
export type CustomerEventType = (typeof CUSTOMER_EVENT_TYPES)[number]

/** 事件分类：客户行为 vs 用户行动（只读派生，不加列；P0-4 六段漏斗区分两侧） */
export type CustomerEventCategory = 'customer' | 'action'

const EVENT_CATEGORY: Record<CustomerEventType, CustomerEventCategory> = {
  customer_replied: 'customer', // 客户回复
  quote_asked: 'customer',      // 客户问报价
  script_copied: 'action',      // 用户复制行动脚本
  chat_opened: 'action',        // 用户打开聊天
  follow_up_done: 'action'      // 跟进完成（任务闭环）
}

/** 事件分类（只读派生，同 judgmentEvidenceStatus 模式——状态由数据推导，不落库） */
export function customerEventCategory(t: CustomerEventType): CustomerEventCategory {
  return EVENT_CATEGORY[t]
}

/** 类型守卫：拒绝 stage / judgment 类及一切未知类型（DB CHECK 之外的第一道 TS 层拦截） */
export function isCustomerEventType(t: string): t is CustomerEventType {
  return (CUSTOMER_EVENT_TYPES as readonly string[]).includes(t)
}

/** 客户事件记录（一行 = 一次 append-only 客观事实；不可覆盖） */
export interface CustomerEventRecord {
  id?: number
  /** 微信会话（session 轴，与 customer_profile.session_id 对齐） */
  session_id: string
  /** 行动轴（P0-4.2.1）：关联 follow_up_task.id（哪条 AI 建议 → 哪次执行）；无任务上下文必须留空，禁止伪造 */
  task_id?: number | null
  event_type: CustomerEventType
  /** 证据锚点：来源消息 messageKey（P0-2B 可回查原话）；无可靠 key 必须留空 */
  message_key?: string | null
  /** 证据：事件依据句（客户原话/转述，非 AI 结论） */
  evidence_text?: string | null
  /** 写入来源：'system' / 'manual' / 'rule' / 'ai'（与 intent_tag_log.source 同义） */
  source: string
  /** 扩展 JSON（如报价金额、脚本 id），可空 */
  metadata?: string | null
  created_at?: number
}
