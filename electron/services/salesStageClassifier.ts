/**
 * salesStageClassifier.ts
 *
 * 阶段相关的事实落库与消息证据提取。
 *
 * **本文件当前不含任何 AI 调用。** 原 `classifyStage`（新消息 → AI 判定客户阶段 → 自动落库）
 * 属无人触发的自动链路，已按 PRD《AI简报与按需识别》§5.4（R）删除——删除后该函数再无调用方，
 * 留着等于「线拆了弹还在」，故连函数与 prompt/解析一并移除（2026-09-12 复核修复）。
 * 保留的是**纯本地**能力：`persistClassification`（阶段写库，无 AI）、
 * `extractEvidence` / `toMessageSnippets`（P0-1 证据锚点，供见解与意向链路复用）。
 *
 * 重新引入 AI 阶段分类前，请先对照 PRD §5.4：不得存在「无人触发也调模型」的入口。
 */

import { salesDbService } from './salesDbService'
import { salesLog } from './salesLogger'

// ─── 类型 ────────────────────────────────────────────────────────────────────

export type CustomerStage = 'new' | 'contacted' | 'quoted' | 'negotiating' | 'won' | 'lost' | 'dormant'

export interface StageClassification {
  stage: CustomerStage
  confidence: number
  reason: string
  /** P0-1 证据：来源消息 messageKey（可回查原话） */
  messageKey?: string
  /** P0-1 证据：判断依据关键句（客户原话/转述，非 AI 结论），≤200 字 */
  evidenceText?: string
}

export interface MessageSnippet {
  role: 'me' | 'other'
  text: string
  time: number
  /** P0-1 证据：来源消息 messageKey（chatService 构造，可回查原话） */
  messageKey?: string
}

// ─── 持久化 ───────────────────────────────────────────────────────────────────

/**
 * 将分类结果写入 customer_profile + intent_tag_log。
 * 只在阶段真正变化时写入（避免无意义更新）。
 * 返回 true 表示阶段发生了变化。
 */
export function persistClassification(
  sessionId: string,
  displayName: string,
  result: StageClassification
): boolean {
  const nowMs = Date.now()

  // 查询当前阶段
  const existing = salesDbService.customerGetBySession(sessionId)
  const prevStage = existing?.stage || 'unknown'

  // 阶段未变化则跳过（dormant 由规则引擎管理，AI 不覆盖）
  if (prevStage === result.stage) return false
  if (result.stage === 'dormant') return false

  // 使用 customerUpsert 更新/创建
  // 注意：不写 last_contact_at —— 分类动作≠联系动作，
  // 分类时刷时间戳会把沉默天数归零、让跟进规则永不触发（曾引发 hack 修补）
  salesDbService.customerUpsert({
    session_id: sessionId,
    display_name: displayName || undefined,
    stage: result.stage
  })

  // 更新 last_stage_change_at（migration 列，通过 updateStageChangeTime）
  salesDbService.updateStageChangeTime(sessionId, nowMs)

  // 记录意向日志（P0-1 证据：message_key 可回查原话，evidence_text 为判断依据句）
  salesDbService.intentCreate({
    session_id: sessionId,
    stage: result.stage,
    confidence: result.confidence,
    source: 'auto_message_trigger',
    reason: result.reason,
    message_key: result.messageKey,
    evidence_text: result.evidenceText
  })

  salesLog('INFO', `[StageClassifier] ${displayName || sessionId}: ${prevStage} → ${result.stage} (${result.reason})`)
  return true
}

// ─── 消息提取辅助 ─────────────────────────────────────────────────────────────

/**
 * 提取判断依据：客户最近一条实质消息（role='other'），原话截断 ≤200 字。
 * 统一约束（P0-1 护栏）：只存「导致这个判断的关键依据」客户原话/转述，
 * 不存 AI reason/结论，不存聊天摘要。
 */
export function extractEvidence(messages: MessageSnippet[]): { messageKey?: string; evidenceText?: string } {
  const others = messages
    .filter(m => m.role === 'other' && m.text.trim())
    .sort((a, b) => (b.time || 0) - (a.time || 0))
  if (others.length === 0) return {}
  const latest = others[0]
  return {
    messageKey: latest.messageKey,
    evidenceText: latest.text.slice(0, 200)
  }
}

/**
 * 从消息格式转换为分类器需要的 MessageSnippet。
 * 兼容两种来源：
 * - chatService.Message（parsedContent/isSend/senderUsername/messageKey，P0-1 主用）
 * - WCDB worker 直出消息（content/createTime/sender/isSender）
 */
export function toMessageSnippets(wcdbMessages: any[], myWxid?: string): MessageSnippet[] {
  if (!Array.isArray(wcdbMessages)) return []

  return wcdbMessages.map(msg => {
    const time = msg.createTime ?? msg.create_time ?? msg.msg_time ?? 0
    const content = msg.parsedContent ?? msg.content ?? msg.strContent ?? msg.str_content ?? ''
    const sender = msg.sender ?? msg.senderUsername ?? msg.strTalker ?? msg.talker ?? ''

    // 判断是否为我方发送：优先 isSend（chatService 口径），兼容 isSender
    const isMe = msg.isSend != null
      ? (msg.isSend === 1)
      : myWxid
        ? (sender === myWxid || msg.isSender === 1 || msg.is_sender === 1)
        : (msg.isSender === 1 || msg.is_sender === 1)

    // 只取文本消息（排除图片/语音/系统消息等）
    const localType = msg.localType ?? msg.local_type ?? msg.type ?? 0
    if (localType !== 1 && localType !== 0 && String(content).startsWith('<')) return null

    const text = String(content).replace(/<[^>]+>/g, '').trim()
    if (!text) return null

    return {
      role: isMe ? 'me' as const : 'other' as const,
      text,
      time: typeof time === 'number' ? time : 0,
      messageKey: msg.messageKey || undefined
    }
  }).filter(Boolean) as MessageSnippet[]
}
