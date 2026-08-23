/**
 * salesActionAnalysisJudgment.ts —— P0-2C.3：action analysis 三调用点统一落 judgment
 *
 * 边界（盘点刀3 契约，用户拍板）：generateActionAnalysis 的
 * 预热（salesActionEngine）/ suggest（main.ts）/ 客户 360（crmIpcHandlers）
 * 三个调用点，把 opportunity / risk / next_action 统一持久化到 customer_judgment，
 * 替代「预热写 analysis JSON + on-demand 丢弃」。
 *
 * 三层真源分离（P0-2C 全局契约）：
 *   - 正则 opportunity/risk（crmParseService）= 客户事实信号
 *   - AI judgment opportunity/risk/next_action = AI 对事实的解释（本模块）
 *   - follow_up_task = 实际行动对象
 *   互不冒充：本模块只写 customer_judgment，不碰 follow_up_task.analysis
 *   （旧链路 todoUpdate(analysis) 保留，新链路与旧链路并存一段）。
 *
 * 证据诚实（P0-2B 原则）：证据 = actionItem 关联任务的 source_message_id
 * （P0-1 证据锚点，可回查触发原话）→ 兜底最近消息 key（extractEvidence 链路）。
 * 拿不到可靠 messageKey → 不落 key，证据状态派生 'unavailable'，绝不伪造。
 *
 * 去重：append-only 持久化去重。suggest = 用户主动点生成建议（source=manual，
 * 跳过去重窗口，保留覆盖权利）；预热/360 = 自动触发（source=ai，沿用 24h 窗口）。
 * 窗口沿用现有业务语义（与见解/摘要去重同窗口），不重新设计。
 */
import { salesDbService } from './salesDbService'
import { chatService } from './chatService'
import { extractEvidence, toMessageSnippets } from './salesStageClassifier'
import { salesLog } from './salesLogger'
import type { ActionAnalysisResult } from './salesActionEngine'

/** 去重窗口：沿用现有业务语义（与 generateInsightForSession 的见解去重窗口一致） */
export const ACTION_JUDGMENT_DEDUP_MS = 24 * 3600 * 1000

/** 三调用点通道（决定 source 与去重语义） */
export type ActionJudgmentChannel = 'preheat' | 'suggest' | 'customer_360'

export interface ActionJudgmentEvidence {
  /** P0-2B 证据锚点：来源消息 messageKey（可回查原话） */
  messageKey?: string
  /** 判断依据关键句（客户原话/转述，非 AI 结论），≤200 字 */
  evidenceText?: string
}

/** 证据解析器（测试可注入，默认走 task.source_message_id → chatService 兜底） */
export type EvidenceResolver = (item: ActionJudgmentItem) => Promise<ActionJudgmentEvidence>

export interface ActionJudgmentItem {
  id?: number
  sessionId?: string
  triggerType?: string
}

export interface ActionAnalysisJudgmentInput {
  item: ActionJudgmentItem
  /** generateActionAnalysis 输出（五字段分析；仅读 opportunity/riskSignal/nextMove） */
  analysis: Partial<ActionAnalysisResult>
  channel: ActionJudgmentChannel
  /** 生成该判断的模型名（PRD§23 可追溯；由调用点从共享 AI 配置读取） */
  model?: string
  /** 测试注入：证据解析（默认 resolveActionAnalysisEvidence） */
  resolveEvidence?: EvidenceResolver
}

export interface ActionAnalysisJudgmentsResult {
  /** 实际落库条数（0-3） */
  persisted: number
  /** 本次应持久化条数（非空判断字段数） */
  total: number
  /** 未落库原因（全部跳过时） */
  reason?: 'invalid_input' | 'dedup'
}

/**
 * 统一落库：把 action analysis 的 opportunity/riskSignal/nextMove 三字段
 * 分别持久化为 customer_judgment 的 opportunity/risk/next_action。
 * - 无 sessionId 或无任何非空判断字段 → 不落库（invalid_input，不抛错）
 * - 空字段不落库（AI 未给出该判断则不制造记录）
 * - 非 suggest 通道且窗口内已有同类型判断 → 跳过（append-only 持久化去重）
 * - 单条落库失败不影响其他（永不抛错）
 */
export async function persistActionAnalysisJudgments(
  input: ActionAnalysisJudgmentInput
): Promise<ActionAnalysisJudgmentsResult> {
  const sessionId = String(input.item?.sessionId || '').trim()
  const raw: Array<{ type: 'opportunity' | 'risk' | 'next_action'; value: string }> = [
    { type: 'opportunity', value: String(input.analysis?.opportunity || '').trim() },
    { type: 'risk', value: String(input.analysis?.riskSignal || '').trim() },
    { type: 'next_action', value: String(input.analysis?.nextMove || '').trim() }
  ]
  const candidates = raw.filter((c) => c.value.length > 0)

  if (!sessionId || candidates.length === 0) {
    return { persisted: 0, total: candidates.length, reason: 'invalid_input' }
  }

  const isManual = input.channel === 'suggest'
  const resolveEvidence: EvidenceResolver = input.resolveEvidence ?? resolveActionAnalysisEvidence
  let evidence: ActionJudgmentEvidence = {}
  try {
    evidence = await resolveEvidence(input.item)
  } catch {
    // 证据解析失败 → 无证据落库（unavailable），不伪造
  }

  const basis = JSON.stringify({
    taskId: input.item.id ?? null,
    triggerType: input.item.triggerType ?? null,
    channel: input.channel
  })
  const generatedAt = Date.now()

  let persisted = 0
  for (const cand of candidates) {
    try {
      if (!isManual && salesDbService.hasRecentJudgment(sessionId, cand.type, ACTION_JUDGMENT_DEDUP_MS)) {
        continue // 窗口内已有同类型判断 → 跳过（append-only 去重）
      }
      salesDbService.judgmentCreate({
        session_id: sessionId,
        judgment_type: cand.type,
        value: cand.value,
        source: isManual ? 'manual' : 'ai',
        model: input.model ? String(input.model).trim() : null,
        generated_at: generatedAt,
        message_key: evidence.messageKey ? String(evidence.messageKey).trim() || null : null,
        evidence_text: evidence.evidenceText ? String(evidence.evidenceText).trim() || null : null,
        basis,
        createdAt: generatedAt
      })
      persisted++
    } catch (e) {
      salesLog('WARN', `[ActionJudgment] ${cand.type} 落库失败（不影响其他）: ${(e as Error).message}`)
    }
  }
  return { persisted, total: candidates.length, reason: persisted === 0 ? 'dedup' : undefined }
}

/**
 * 证据解析：actionItem 关联任务的 source_message_id（P0-1 证据锚点，
 * 触发原话可经 P0-2B 回查）→ 兜底最近消息 key（客户最近一条实质消息原话）。
 * 无可靠 key → 返回空对象（调用方落 message_key=null，状态 unavailable）。
 */
export async function resolveActionAnalysisEvidence(item: ActionJudgmentItem): Promise<ActionJudgmentEvidence> {
  // 1. 关联任务 source_message_id（优先级：触发原话锚点）
  if (item.id && item.id > 0) {
    try {
      const task = salesDbService.getTask(item.id)
      const key = task?.source_message_id ? String(task.source_message_id).trim() : ''
      if (key) return { messageKey: key }
    } catch {
      // 单任务读取失败 → 走兜底
    }
  }
  // 2. 兜底：最近消息 key（与 summary 同链路：客户最近一条实质消息）
  const sessionId = String(item.sessionId || '').trim()
  if (!sessionId) return {}
  try {
    const msgsResult = await chatService.getLatestMessages(sessionId, 20)
    if (msgsResult.success && msgsResult.messages && msgsResult.messages.length > 0) {
      return extractEvidence(toMessageSnippets(msgsResult.messages))
    }
  } catch {
    // 读取失败 → 无证据（unavailable）
  }
  return {}
}
