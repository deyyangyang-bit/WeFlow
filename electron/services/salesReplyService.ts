/**
 * salesReplyService.ts
 *
 * 智能回复建议服务。
 * 检索知识库匹配条目 + 当前对话上下文 → AI 生成 2-3 条可选回复草稿。
 */

import { wcdbService } from './wcdbService'
import { salesKnowledgeService } from './salesKnowledgeService'
import { simpleCompletion, isAiConfigured } from './ai/aiApiClient'
import { ConfigService } from './config'

// ─── 类型 ────────────────────────────────────────────────────────────────────

export interface ReplySuggestResult {
  success: boolean
  suggestions?: string[]
  error?: string
}

const MAX_CONTEXT_MESSAGES = 20
const MAX_CONTEXT_CHARS = 1500

// ─── Prompt ──────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `你是一个 B2B 工业设备（叉车/仓储设备）销售沟通助手。

根据提供的对话上下文和参考知识，生成 2-3 条专业的回复建议供销售人员选择。

要求：
1. 只返回 JSON 数组，不要其他文字
2. 格式：["回复建议1", "回复建议2", "回复建议3"]
3. 每条建议 30-80 字，语气专业友好
4. 建议之间风格有差异：一条正式、一条亲和、一条简洁
5. 如果有参考知识，自然融入回复中（不要说"根据知识库"）
6. 回复要推进销售进程（引导下一步动作：约看样机、发报价、确认需求等）
7. 用中文回复`

// ─── 工具函数 ─────────────────────────────────────────────────────────────────

function formatMessages(messages: any[], peerName: string): string {
  const lines: string[] = []
  let totalLen = 0

  for (const msg of messages) {
    const content = String(msg.parsedContent || msg.rawContent || '').trim()
    if (!content) continue
    if (/^(<\?xml|<msg\b|<appmsg\b|<img\b|<emoji\b|<voip\b|<sysmsg\b)/i.test(content)) continue

    const sender = msg.isSend === 1 ? '我' : peerName
    const line = `${sender}：${content.slice(0, 150)}`

    if (totalLen + line.length > MAX_CONTEXT_CHARS) break
    lines.push(line)
    totalLen += line.length + 1
  }

  return lines.reverse().join('\n')
}

function parseSuggestions(text: string): string[] | null {
  try {
    let jsonStr = text.trim()
    const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (jsonMatch) jsonStr = jsonMatch[1].trim()
    const arrMatch = jsonStr.match(/\[[\s\S]*\]/)
    if (arrMatch) jsonStr = arrMatch[0]

    const parsed = JSON.parse(jsonStr)
    if (!Array.isArray(parsed)) return null
    const suggestions = parsed
      .filter((s: unknown) => typeof s === 'string' && s.trim().length > 5)
      .map((s: string) => s.trim())
      .slice(0, 3)

    return suggestions.length > 0 ? suggestions : null
  } catch {
    return null
  }
}

// ─── 服务 ────────────────────────────────────────────────────────────────────

class SalesReplyService {

  async suggestReplies(
    sessionId: string,
    config: ConfigService,
    contextMessages?: Array<{ role: string; content: string }>
  ): Promise<ReplySuggestResult> {
    try {
      // 1. 检查 AI 配置
      if (!isAiConfigured(config)) {
        return { success: false, error: 'AI 未配置，请先在设置页面配置 API 地址和密钥' }
      }

      if (!sessionId?.trim()) {
        return { success: false, error: 'sessionId 不能为空' }
      }

      // 2. 获取对话上下文
      let chatText = ''
      let peerName = '客户'

      if (contextMessages && contextMessages.length > 0) {
        // 使用前端传入的上下文
        chatText = contextMessages
          .slice(-MAX_CONTEXT_MESSAGES)
          .map(m => `${m.role === 'user' ? '客户' : '我'}：${m.content.slice(0, 150)}`)
          .join('\n')
      } else {
        // 从 WCDB 拉取
        const connected = await wcdbService.isConnected()
        if (!connected) {
          return { success: false, error: '微信数据库未连接' }
        }

        const msgResult = await wcdbService.getMessages(sessionId, MAX_CONTEXT_MESSAGES, 0)
        if (!msgResult.success || !msgResult.messages || msgResult.messages.length === 0) {
          return { success: false, error: '没有可用的聊天记录' }
        }

        try {
          const namesResult = await wcdbService.getDisplayNames([sessionId])
          if (namesResult.success && namesResult.map?.[sessionId]) {
            peerName = namesResult.map[sessionId]
          }
        } catch { /* ignore */ }

        chatText = formatMessages(msgResult.messages, peerName)
      }

      if (!chatText.trim()) {
        return { success: false, error: '没有有效的对话内容' }
      }

      // 3. 检索知识库
      const lastUserMsg = chatText.split('\n').filter(l => l.startsWith(peerName) || l.startsWith('客户')).pop() || ''
      const knowledgeContext = salesKnowledgeService.retrieveForPrompt(lastUserMsg.replace(/^(客户|[^：]+)：/, ''), 3)

      // 4. 组装 prompt
      let userMessage = `对话上下文（与"${peerName}"的最近聊天）：\n${chatText}`
      if (knowledgeContext) {
        userMessage += `\n\n参考知识：\n${knowledgeContext}`
      }
      userMessage += `\n\n请生成 2-3 条回复建议。`

      // 5. 调用 AI
      const aiResponse = await simpleCompletion(
        config,
        SYSTEM_PROMPT,
        userMessage,
        { responseFormatJson: true, temperature: 0.7, maxTokens: 500 }
      )

      // 6. 解析结果
      const suggestions = parseSuggestions(aiResponse)
      if (!suggestions) {
        return { success: false, error: `AI 响应解析失败: ${aiResponse.slice(0, 100)}` }
      }

      return { success: true, suggestions }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }
}

export const salesReplyService = new SalesReplyService()
