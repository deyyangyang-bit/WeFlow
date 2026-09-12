/**
 * salesIntentService.ts
 *
 * 客户意向分级服务。
 * 分析聊天记录，通过 AI 判断客户意向阶段（了解/比价/决策/成交/流失）+ 置信度。
 */

import { wcdbService } from './wcdbService'
import { chatService } from './chatService'
import { enqueueSalesTask } from './salesQueue'
import { salesDbService, type IntentTagLog } from './salesDbService'
import { simpleCompletion, isAiConfigured } from './ai/aiApiClient'
import { ConfigService } from './config'
import { toMessageSnippets, extractEvidence } from './salesStageClassifier'
import { formatMessages } from './salesMessageText'

// ─── 类型 ────────────────────────────────────────────────────────────────────

export interface IntentAnalyzeResult {
  success: boolean
  tag?: IntentTagLog
  error?: string
}

const VALID_STAGES = ['了解', '比价', '决策', '成交', '流失'] as const
const MAX_MESSAGES = 50
const MAX_CONTEXT_CHARS = 2000

// ─── Prompt ──────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `你是一个 B2B 工业设备（叉车/仓储设备）销售领域的客户意向分析专家。

根据提供的聊天记录，判断客户当前所处的采购意向阶段。

阶段定义：
- 了解：客户在初步了解产品、询问基本参数、品牌信息，尚未表达明确采购需求
- 比价：客户已在对比不同品牌/型号/供应商，询问价格、优惠、配置差异
- 决策：客户已接近做出购买决定，讨论交付时间、付款方式、合同条款、售后保障
- 成交：客户已明确表达购买意愿或已完成交易
- 流失：客户明确表示不需要、已选择其他供应商、长期无回应或态度消极

要求：
1. 只返回 JSON，不要其他文字
2. 格式：{"stage": "阶段名", "confidence": 0.0到1.0的数字, "reason": "一句话判断依据"}
3. confidence 表示你对判断的确信程度
4. reason 用中文，20字以内概括关键证据
5. 如果聊天记录不足以判断，stage 设为"了解"，confidence 设为 0.3 以下`

// ─── 工具函数 ─────────────────────────────────────────────────────────────────

function parseAiResponse(text: string): { stage: string; confidence: number; reason: string } | null {
  try {
    // 尝试直接解析
    let jsonStr = text.trim()
    // 处理可能的 markdown 代码块包裹
    const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (jsonMatch) jsonStr = jsonMatch[1].trim()
    // 尝试提取 JSON 对象
    const objMatch = jsonStr.match(/\{[\s\S]*\}/)
    if (objMatch) jsonStr = objMatch[0]

    const parsed = JSON.parse(jsonStr)
    const stage = String(parsed.stage || '').trim()
    const confidence = Number(parsed.confidence)
    const reason = String(parsed.reason || '').trim()

    if (!VALID_STAGES.includes(stage as any)) return null
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null

    return { stage, confidence: Math.round(confidence * 100) / 100, reason: reason.slice(0, 100) }
  } catch {
    return null
  }
}

// ─── 服务 ────────────────────────────────────────────────────────────────────

class SalesIntentService {
  private analyzing = false

  /**
   * AI 分析客户意向
   */
  async analyzeIntent(sessionId: string, config: ConfigService): Promise<IntentAnalyzeResult> {
    return enqueueSalesTask(async () => {
    try {
      // 1. 检查 AI 配置
      if (!isAiConfigured(config)) {
        return { success: false, error: 'AI 未配置，请先在设置页面配置 API 地址和密钥' }
      }

      if (!sessionId?.trim()) {
        return { success: false, error: 'sessionId 不能为空' }
      }


      // 2. 检查 WCDB 连接
      const connected = await wcdbService.isConnected()
      if (!connected) {
        return { success: false, error: '微信数据库未连接' }
      }

      // 3. 拉取最近消息（chatService 构造 messageKey，P0-1 证据可回查原话）
      const msgResult = await chatService.getMessages(sessionId, 0, MAX_MESSAGES, 0, 0, false)
      if (!msgResult.success || !msgResult.messages || msgResult.messages.length === 0) {
        return { success: false, error: '没有可用的聊天记录' }
      }
      const messages = msgResult.messages

      // 4. 获取联系人显示名
      let peerName = '客户'
      try {
        const namesResult = await wcdbService.getDisplayNames([sessionId])
        if (namesResult.success && namesResult.map?.[sessionId]) {
          peerName = namesResult.map[sessionId]
        }
      } catch { /* ignore */ }

      // 5. 格式化对话文本
      const chatText = formatMessages(messages, peerName, {
        maxLineChars: 200,
        maxTotalChars: MAX_CONTEXT_CHARS
      })
      if (!chatText.trim()) {
        return { success: false, error: '聊天记录中没有有效的文本消息' }
      }

      // 6. 调用 AI
      const userMessage = `以下是与"${peerName}"的最近聊天记录（共${messages.length}条）：\n\n${chatText}\n\n请分析该客户的采购意向阶段。`

      const aiResponse = await simpleCompletion(
        config,
        SYSTEM_PROMPT,
        userMessage,
        { responseFormatJson: true, temperature: 0.3, maxTokens: 200, usageContext: { purpose: 'intent' } }
      )

      // 7. 解析 AI 响应
      const parsed = parseAiResponse(aiResponse)
      if (!parsed) {
        return { success: false, error: `AI 响应解析失败: ${aiResponse.slice(0, 100)}` }
      }

      // 7.5 P0-1 证据：客户最近一条实质消息（原话，非 AI 结论）
      const evidence = extractEvidence(toMessageSnippets(messages))

      // 8. 存储意向标签（message_key 可回查原话，evidence_text 为判断依据句）
      const tag = salesDbService.intentCreate({
        session_id: sessionId,
        stage: parsed.stage,
        confidence: parsed.confidence,
        source: 'ai',
        reason: parsed.reason,
        message_key: evidence.messageKey,
        evidence_text: evidence.evidenceText
      })

      // 9. 同步更新客户画像的 stage
      salesDbService.customerUpsert({ session_id: sessionId, stage: parsed.stage })

      return { success: true, tag }
    } catch (e) {
      return { success: false, error: String(e) }
    }
    })
  }
}

export const salesIntentService = new SalesIntentService()
