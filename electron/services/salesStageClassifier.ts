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

import { ConfigService } from '../config'
import { simpleCompletion, isAiConfigured } from './ai/aiApiClient'
import { salesDbService } from './salesDbService'
import { salesLog } from './salesLogger'

// ─── 类型 ────────────────────────────────────────────────────────────────────

export type CustomerStage = 'new' | 'contacted' | 'quoted' | 'negotiating' | 'won' | 'lost' | 'dormant'

export interface StageClassification {
  stage: CustomerStage
  confidence: number
  reason: string
}

export interface MessageSnippet {
  role: 'me' | 'other'
  text: string
  time: number
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
      temperature: 0.1,
      maxTokens: 300,
      disableThinking: true,
      responseFormatJson: true,
      timeoutMs: 15_000
    })

    return parseClassification(raw)
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
  const nowSec = Math.floor(nowMs / 1000)

  // 查询当前阶段
  const existing = salesDbService.customerGetBySession(sessionId)
  const prevStage = existing?.stage || 'unknown'

  // 阶段未变化则跳过（dormant 由规则引擎管理，AI 不覆盖）
  if (prevStage === result.stage) return false
  if (result.stage === 'dormant') return false

  // 使用 customerUpsert 更新/创建
  salesDbService.customerUpsert({
    session_id: sessionId,
    display_name: displayName || undefined,
    stage: result.stage,
    last_contact_at: nowSec
  })

  // 更新 last_stage_change_at（migration 列，通过 updateStageChangeTime）
  salesDbService.updateStageChangeTime(sessionId, nowMs)

  // 记录意向日志
  salesDbService.intentCreate({
    session_id: sessionId,
    stage: result.stage,
    confidence: result.confidence,
    source: 'auto_message_trigger',
    reason: result.reason
  })

  salesLog('INFO', `[StageClassifier] ${displayName || sessionId}: ${prevStage} → ${result.stage} (${result.reason})`)
  return true
}

// ─── 消息提取辅助 ─────────────────────────────────────────────────────────────

/**
 * 从 WCDB 消息格式转换为分类器需要的 MessageSnippet。
 * 兼容 WeFlow 消息字段名不统一的问题（createTime/create_time/msg_time）。
 */
export function toMessageSnippets(wcdbMessages: any[], myWxid?: string): MessageSnippet[] {
  if (!Array.isArray(wcdbMessages)) return []

  return wcdbMessages.map(msg => {
    const time = msg.createTime ?? msg.create_time ?? msg.msg_time ?? 0
    const content = msg.content ?? msg.strContent ?? msg.str_content ?? ''
    const sender = msg.sender ?? msg.strTalker ?? msg.talker ?? ''

    // 判断是否为我方发送
    const isMe = myWxid
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
      time: typeof time === 'number' ? time : 0
    }
  }).filter(Boolean) as MessageSnippet[]
}
