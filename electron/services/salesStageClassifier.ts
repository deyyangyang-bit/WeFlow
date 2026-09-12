/**
 * salesStageClassifier.ts
 *
 * 轻量 AI 阶段分类器：从聊天消息自动判定客户所处销售阶段。
 * 设计原则：
 * - 单次调用 ≤500 token prompt + ≤100 token 响应（控制成本）
 * - 固定 system prompt（命中 API 缓存）
 * - 输出严格 JSON，容错解析
 * - 通过 salesQueue 串行执行，不并发调 WCDB/AI
 */

import { ConfigService } from './config'
import { simpleCompletion, isAiConfigured } from './ai/aiApiClient'
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

// ─── 常量 ────────────────────────────────────────────────────────────────────

const VALID_STAGES: CustomerStage[] = ['new', 'contacted', 'quoted', 'negotiating', 'won', 'lost', 'dormant']

const SYSTEM_PROMPT = `你是一个叉车/仓储设备销售场景的客户阶段分类器。
根据聊天消息判断客户当前所处的销售阶段。

阶段定义：
- new: 刚开始接触，尚未实质沟通产品
- contacted: 有实质问答（问过产品/价格/参数/型号）
- quoted: 销售方已发出报价或方案
- negotiating: 正在讨论付款方式/交期/定制/比价/优惠
- won: 已确认下单/付款/发货/成交
- lost: 明确拒绝/不需要/选了别家
- dormant: 长期无互动（由系统判定，AI一般不输出此值）

规则：
1. 只根据消息内容判断，不要猜测
2. 如果消息太少无法判断，输出 contacted
3. confidence 为 0-1 之间的数字，表示判断确信度
4. reason 用一句话说明判断依据（≤20字）

严格输出 JSON，不要输出其他内容：
{"stage":"...","confidence":0.8,"reason":"..."}`

// ─── 核心分类 ─────────────────────────────────────────────────────────────────

/**
 * 对单个会话进行阶段分类。
 * @param config ConfigService 实例
 * @param messages 最近的消息片段（建议 ≤10 条）
 * @returns 分类结果，失败返回 null
 */
export async function classifyStage(
  config: ConfigService,
  messages: MessageSnippet[],
  sessionId: string = ''
): Promise<StageClassification | null> {
  if (!isAiConfigured(config)) return null
  if (!messages || messages.length === 0) return null

  // 构建 user prompt：最近消息摘要
  const lines = messages.slice(-10).map(m => {
    const speaker = m.role === 'me' ? '【我】' : '【客】'
    const text = m.text.length > 80 ? m.text.slice(0, 80) + '…' : m.text
    return `${speaker}${text}`
  })
  const userPrompt = `以下是最近的聊天记录：\n${lines.join('\n')}\n\n请判断客户阶段。`

  try {
    const raw = await simpleCompletion(config, SYSTEM_PROMPT, userPrompt, {
      usageContext: { purpose: 'stage' },
      temperature: 0.1,
      maxTokens: 300,
      disableThinking: true,
      responseFormatJson: true,
      timeoutMs: 15_000
    })

    const result = parseClassification(raw)
    if (!result) return null
    // P0-1 证据：客户最近一条实质消息（原话，非 AI 结论），随分类一起透传
    return { ...result, ...extractEvidence(messages) }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    salesLog('ERROR', `[StageClassifier] 分类失败 ${sessionId || '?'}: ${msg}`)
    return null
  }
}

/**
 * 解析 AI 返回的 JSON，容错处理。
 */
function parseClassification(raw: string): StageClassification | null {
  try {
    const jsonMatch = raw.match(/\{[\s\S]*?\}/)
    if (!jsonMatch) return null

    const parsed = JSON.parse(jsonMatch[0])
    const stage = String(parsed.stage || '').toLowerCase() as CustomerStage
    if (!VALID_STAGES.includes(stage)) return null

    const confidence = typeof parsed.confidence === 'number'
      ? Math.max(0, Math.min(1, parsed.confidence))
      : 0.5

    const reason = String(parsed.reason || '').slice(0, 50)

    return { stage, confidence, reason }
  } catch {
    return null
  }
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
