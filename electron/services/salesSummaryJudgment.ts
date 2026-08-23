/**
 * salesSummaryJudgment.ts —— P0-2C.2：summary 判断的持久化写路径（独立可测模块）
 *
 * 边界（用户拍板，P0-2C.2）：只服务 generateInsightForSession 一处调用点。
 * 把「现场生成结果」的 summary 判断追加写入 customer_judgment（append-only），
 * 不改变生成时机 / prompt / 现场生成路径（新旧路径并存）。
 *
 * 与 insight_record 的关系（P0-2C 契约）：
 *   insight_record    = AI 见解的生成过程与展示载体（原有系统，不动）
 *   customer_judgment = 结构化的 AI 判断历史（P0-2C 新容器）
 *   两表不合并、不互相取代。
 *
 * 证据诚实（P0-2B 原则）：message_key/evidence_text 来自客户最近一条实质消息原话
 * （extractEvidence 产出，非 AI 结论）。拿不到可靠 messageKey → 不落 message_key，
 * 证据状态由 judgmentEvidenceStatus 只读派生为 'unavailable'，绝不伪造。
 *
 * 去重：append-only 持久化去重（hasRecentJudgment）。手动触发保留覆盖权利（跳过去重）；
 * 窗口沿用现有业务语义（与见解去重窗口一致）。
 */
import { salesDbService } from './salesDbService'

/**
 * summary 判断去重窗口：与 generateInsightForSession 的见解去重窗口
 * （insightService 内 INSIGHT_RECORD_DEDUP_MS = 24h）保持一致，不在此重新设计业务语义。
 */
export const SUMMARY_JUDGMENT_DEDUP_MS = 24 * 3600 * 1000

export interface SummaryJudgmentEvidence {
  /** P0-2B 证据锚点：来源消息 messageKey（可回查原话） */
  messageKey?: string
  /** 判断依据关键句（客户原话/转述，非 AI 结论），≤200 字 */
  evidenceText?: string
}

export interface SummaryJudgmentInput {
  sessionId: string
  /** summary 判断值：AI 生成的最终见解（去除【阶段】标签后的正文） */
  insight: string
  /** 生成该判断的模型名（PRD§23 可追溯） */
  model?: string
  /** 判断名义生成时间（默认落库时刻；由 insight 主流程传入 recordLog.createdAt） */
  generatedAt?: number
  /** 判断依据：客户最近一条实质消息（P0-1 护栏：原话/转述，非 AI 结论） */
  evidence?: SummaryJudgmentEvidence
  /** 触发原因：manual → source='manual' 且跳过去重（覆盖权利）；其余 → source='ai' 且走去重 */
  triggerReason: string
}

export type SummaryJudgmentSkipReason = 'invalid_input' | 'dedup' | 'persist_error'

export interface SummaryJudgmentResult {
  persisted: boolean
  /** 未落库原因（用于日志/测试断言） */
  reason?: SummaryJudgmentSkipReason
  error?: string
  /** 落库后的记录 id（persisted=true 时） */
  recordId?: number
}

/**
 * 持久化 summary 判断（append-only）。
 * - 参数不完整（缺 sessionId/insight）→ 不落库（invalid_input）
 * - 非手动触发且去重窗口内已有 summary 判断 → 跳过（dedup，持久化去重）
 * - 手动触发 → 始终追加（覆盖权利，历史保留）
 * 永不抛错：落库失败返回 persist_error，由调用方决定是否阻断主流程（默认不阻断）。
 */
export function persistSummaryJudgment(input: SummaryJudgmentInput): SummaryJudgmentResult {
  const sessionId = String(input.sessionId || '').trim()
  const insight = String(input.insight || '').trim()
  if (!sessionId || !insight) {
    return { persisted: false, reason: 'invalid_input' }
  }

  const created = Date.now()
  const isManual = input.triggerReason === 'manual'
  try {
    // 非手动触发且去重窗口内已有 summary 判断 → 跳过（append-only 持久化去重）
    if (!isManual && salesDbService.hasRecentJudgment(sessionId, 'summary', SUMMARY_JUDGMENT_DEDUP_MS)) {
      return { persisted: false, reason: 'dedup' }
    }
    const rec = salesDbService.judgmentCreate({
      session_id: sessionId,
      judgment_type: 'summary',
      value: insight,
      source: isManual ? 'manual' : 'ai',
      model: input.model ? String(input.model).trim() : null,
      generated_at: input.generatedAt ?? created,
      message_key: input.evidence?.messageKey ? String(input.evidence.messageKey).trim() || null : null,
      evidence_text: input.evidence?.evidenceText ? String(input.evidence.evidenceText).trim() || null : null,
      createdAt: created
    })
    return { persisted: true, recordId: rec.id }
  } catch (e) {
    return { persisted: false, reason: 'persist_error', error: (e as Error).message }
  }
}
