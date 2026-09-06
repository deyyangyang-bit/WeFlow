/**
 * shared/proposalEvent.ts —— 提案埋点事件的唯一语义源（前后端共用，纯模块零依赖）
 *
 * 刀 2 采用率埋点契约（设计-Hermes-MVP 刀 2，宪法 §3 proposal_event 登记行）：
 *   proposal_event = 「AI 提案 → 人处理」全程埋点，append-only，一行 = 一次阶段迁移。
 *
 * 硬门禁（防万能日志表）：
 *   - event_type 只允许三类（DB CHECK + 本模块 isProposalEventType 双重拦截）
 *   - stage 只允许六态（同上双拦截）；expired 为枚举占位，本批无写点
 *   - append-only：无 UPDATE/DELETE 方法（宪法 §2.2 例外同款），裁决态
 *     （accepted/rejected/modified）只能由人工动作触发写入，AI 永不直写
 *
 * 实体指向（entity_type/entity_id）：
 *   account_info   —— 信息待确认提案，entity_id = `<accountId>:<field>`
 *   knowledge      —— 知识条目/知识提案，entity_id = knowledge_base.id
 *   follow_up_task —— 行动卡，entity_id = follow_up_task.id
 *
 * 消费口径（只读聚合，复盘页）：采纳率 = (accepted + modified) / 已处理总数，
 *   已处理 = accepted + rejected + modified；分母 0 → 「—」不伪造。
 */

/** 事件类型：AI 提案（信息待确认）/ 知识治理 / 行动卡 */
export const PROPOSAL_EVENT_TYPES = ['proposal', 'knowledge', 'action'] as const
export type ProposalEventType = (typeof PROPOSAL_EVENT_TYPES)[number]

/** 阶段：生成 → 曝光 → 人工处置（accepted/modified/rejected）；expired 占位 */
export const PROPOSAL_EVENT_STAGES = [
  'generated',
  'viewed',
  'accepted',
  'modified',
  'rejected',
  'expired'
] as const
export type ProposalEventStage = (typeof PROPOSAL_EVENT_STAGES)[number]

/** 类型守卫：DB CHECK 之外的第一道 TS 层拦截 */
export function isProposalEventType(t: string): t is ProposalEventType {
  return (PROPOSAL_EVENT_TYPES as readonly string[]).includes(t)
}

/** 阶段守卫：同上双拦截 */
export function isProposalEventStage(s: string): s is ProposalEventStage {
  return (PROPOSAL_EVENT_STAGES as readonly string[]).includes(s)
}

/** 提案埋点事件记录（一行 = 一次阶段迁移；append-only 不可覆盖） */
export interface ProposalEventRecord {
  id?: number
  event_type: ProposalEventType
  stage: ProposalEventStage
  /** 提案对象类型：account_info / knowledge / follow_up_task（登记行口径） */
  entity_type: string
  /** 提案对象 id（account_info 为 `<accountId>:<field>` 复合键，故统一 TEXT） */
  entity_id: string
  /** 署名：人工动作=身份档案 actor（§1.12 口径）；系统生成点=system:<来源> */
  actor?: string
  created_at?: number
}
