/**
 * shared/customerJudgment.ts —— AI 判断记录的唯一语义源（前后端共用，纯模块零依赖）
 *
 * P0-2C 契约（只服务四类 AI 判断，stage/activityState/stateMeta 归 P0-2A Canonical State）：
 *   summary / opportunity / risk / next_action
 *
 * 硬门禁：
 *   - 严禁出现 'stage' 类型 —— DB 层有 CHECK 约束 + 本模块 isCustomerJudgmentType 双重拦截，
 *     防止 customer_profile.stage / intent_tag_log.stage / customer_judgment.stage 三处双真源。
 *   - 证据诚实：message_key 为 P0-2B 证据锚点（可回查原话）。无可靠 key 必须留空，
 *     证据状态由 judgmentEvidenceStatus 只读派生（'unavailable'），绝不伪造"看起来像证据"的 key。
 *
 * 与 P0-2B 的关系：judgment 记录里的 message_key 直接喂给 getEvidenceByKey() 回查原话，
 * 不另造 evidence 机制。
 */

/** 全部 AI 判断类型（写入契约；排序 = 文档顺序，非业务权重） */
export const CUSTOMER_JUDGMENT_TYPES = ['summary', 'opportunity', 'risk', 'next_action'] as const
export type CustomerJudgmentType = (typeof CUSTOMER_JUDGMENT_TYPES)[number]

/** 类型守卫：拒绝 'stage' 及一切未知类型（DB CHECK 之外的第一道 TS 层拦截） */
export function isCustomerJudgmentType(t: string): t is CustomerJudgmentType {
  return (CUSTOMER_JUDGMENT_TYPES as readonly string[]).includes(t)
}

/** 判断记录（一行 = 一次 append-only AI 判断；projection 取最新一条） */
export interface CustomerJudgmentRecord {
  id?: number
  session_id: string
  judgment_type: CustomerJudgmentType
  /** 判断值：summary=文本；opportunity/risk/next_action=AI 对事实的解释（与正则信号真源分离） */
  value: string
  confidence?: number | null
  /** 判断来源：'ai' | 'auto_message_trigger' | 'manual' | 'deal_rule' 等（与 intent_tag_log.source 同义） */
  source: string
  /** 生成该判断的 AI 模型名（PRD§23 可追溯） */
  model?: string | null
  /** 判断依据句（AI 给出的理由，非原话） */
  reason?: string | null
  /** 证据锚点：来源消息 messageKey（canonical/server:/裸ID 兼容），P0-2B 可回查原话 */
  message_key?: string | null
  /** 证据：判断依据关键句（客户原话/转述，非 AI 结论） */
  evidence_text?: string | null
  /** 输入快照/消息时间范围（JSON，可选）：记录"这次判断基于哪个时间范围的哪批消息" */
  basis?: string | null
  /** 判断名义生成时间（LLM 产出时刻；created_at 为落库时刻） */
  generated_at?: number | null
  created_at?: number
}

/** 证据状态（只读派生，写入时绝不伪造） */
export type JudgmentEvidenceStatus = 'ok' | 'unavailable'

/**
 * 证据是否可 P0-2B 回查：message_key 非空 → ok；空/缺失 → unavailable。
 * 派生而非存储，杜绝"填了 status 却没填 key"的不一致。
 */
export function judgmentEvidenceStatus(r: { message_key?: string | null }): JudgmentEvidenceStatus {
  return String(r.message_key ?? '').trim() ? 'ok' : 'unavailable'
}
