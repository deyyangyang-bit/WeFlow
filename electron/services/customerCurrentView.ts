/**
 * customerCurrentView.ts —— P0-3 第一刀：客户当前视图只读组装层
 *
 * 拍板契约（用户钉死）：
 *   - 只做投影，不做判断：不合并 judgment + follow_up_task.analysis、
 *     不拿 insight_record 补数据、无 summary 不现场调 LLM、
 *     opportunity/risk 不自己再推理。
 *   - Latest 与 Fresh 并存：freshness='stale' 不等于不存在，
 *     历史判断照常返回（UI 可弱化，不清空）。
 *   - evidence 轻量：视图只带 evidenceStatus + messageKey，
 *     点击回查走 P0-2B getEvidenceByKey()（本层不返回原话/上下文）。
 *   - freshness 阈值沿用 24h 去重窗口（与见解/摘要/行动判断一致）。
 *
 * 纯只读：不写库、不调 LLM、不读 insight_record / analysis JSON。
 */
import { salesDbService } from './salesDbService'
import { judgmentEvidenceStatus, type CustomerJudgmentRecord, type CustomerJudgmentType } from '../../shared/customerJudgment'
import type { CanonicalState } from '../../shared/canonicalState'

/** 判断新鲜度阈值：沿用 24h 业务窗口（与各去重窗口一致），> 24h 为 stale */
export const CURRENT_JUDGMENT_FRESH_MS = 24 * 3600 * 1000

/** 判断类型 → 视图字段名（投影名，非存储名） */
export type CurrentJudgmentType = 'summary' | 'opportunity' | 'risk' | 'nextAction'

/** 单条判断的当前视图（Latest 投影 + 派生语义；不携带证据正文） */
export interface JudgmentView {
  type: CurrentJudgmentType
  /** 判断值（最新一条，不合并不加工） */
  value: string
  /** 生成时间（generated_at 优先，回退 created_at） */
  generatedAt: number
  /** 来源：ai=自动解释 / manual=用户主动认可 */
  source: 'ai' | 'manual'
  /** 新鲜度：24h 窗口内 fresh / 窗口外 stale（stale ≠ 不存在） */
  freshness: 'fresh' | 'stale'
  /** 证据状态：ok（message_key 可回查）/ unavailable（诚实标注） */
  evidenceStatus: 'ok' | 'unavailable'
  /** P0-2B 回查锚点（点击才拉原话，视图不携带正文） */
  messageKey: string | null
}

/** 客户当前视图：State（canonical）+ Judgment 四类投影 */
export interface CustomerCurrentView {
  state: CanonicalState
  judgments: {
    summary: JudgmentView | null
    opportunity: JudgmentView | null
    risk: JudgmentView | null
    nextAction: JudgmentView | null
  }
}

/** 存储类型 → 视图字段名 */
const TYPE_TO_VIEW: Record<CustomerJudgmentType, CurrentJudgmentType> = {
  summary: 'summary',
  opportunity: 'opportunity',
  risk: 'risk',
  next_action: 'nextAction'
}

/** 最新一条判断 → JudgmentView 投影（无记录 → null） */
function toJudgmentView(record: CustomerJudgmentRecord | undefined, now: number): JudgmentView | null {
  if (!record) return null
  const generatedAt = Number(record.generated_at ?? record.created_at ?? 0)
  const freshness: 'fresh' | 'stale' =
    generatedAt > 0 && now - generatedAt <= CURRENT_JUDGMENT_FRESH_MS ? 'fresh' : 'stale'
  return {
    type: TYPE_TO_VIEW[record.judgment_type],
    value: String(record.value ?? ''),
    generatedAt,
    source: record.source === 'manual' ? 'manual' : 'ai',
    freshness,
    evidenceStatus: judgmentEvidenceStatus(record),
    messageKey: String(record.message_key ?? '').trim() || null
  }
}

/**
 * 组装客户当前视图（唯一消费入口；纯只读同步投影）。
 * - 客户不存在 → null（IPC 层以失败返回）
 * - 客户存在但无判断 → judgments 各类型 null（明确空态，不补生成）
 * @param now 注入当前时间（毫秒）便于测试；生产不传
 */
export function getCustomerCurrentView(sessionId: string, now: number = Date.now()): CustomerCurrentView | null {
  const sid = String(sessionId || '').trim()
  const state = salesDbService.getCanonicalState(sid, Math.floor(now / 1000))
  if (!state) return null
  return {
    state,
    judgments: {
      summary: toJudgmentView(salesDbService.judgmentCurrent(sid, 'summary'), now),
      opportunity: toJudgmentView(salesDbService.judgmentCurrent(sid, 'opportunity'), now),
      risk: toJudgmentView(salesDbService.judgmentCurrent(sid, 'risk'), now),
      nextAction: toJudgmentView(salesDbService.judgmentCurrent(sid, 'next_action'), now)
    }
  }
}
