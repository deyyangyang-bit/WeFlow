/**
 * salesFollowUpService.ts
 *
 * AI 自动识别跟进待办。
 * 扫描最近活跃联系人的聊天记录，识别需要跟进的场景并生成待办。
 */

import { wcdbService } from './wcdbService'
import { salesDbService } from './salesDbService'
import { simpleCompletion, isAiConfigured } from './ai/aiApiClient'
import { ConfigService } from './config'

// ─── 类型 ────────────────────────────────────────────────────────────────────

export interface DetectedTask {
  session_id: string
  display_name: string
  title: string
  due_at?: number
  trigger_type: string
}

export interface FollowUpScanResult {
  success: boolean
  tasks?: DetectedTask[]
  error?: string
}

const SCAN_SESSION_LIMIT = 10      // 每次最多扫描 10 个联系人
const SCAN_MESSAGE_LIMIT = 20      // 每个联系人取最近 20 条消息
const MAX_CONTEXT_CHARS = 1200

// ─── Prompt ──────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `你是一个 B2B 工业设备（叉车/仓储设备）销售跟进助手。

分析聊天记录，识别需要跟进的场景。只关注以下类型：
1. promise_contact: 约定了具体时间联系（如"下周给你报价""周三来看样机"）
2. unanswered_quote: 客户问了价格/方案但我方未回复
3. ai_detected: 其他需要跟进的信号（如客户表达兴趣但有顾虑、需要确认需求、等待反馈等）

要求：
1. 只返回 JSON 数组，不要其他文字
2. 格式：[{"title": "待办描述(15字内)", "trigger_type": "类型", "due_days": 天数或null}]
3. due_days: 建议几天内跟进（1-14），不确定则 null
4. 只输出确实需要跟进的条目，不要凑数
5. 如果没有需要跟进的内容，返回空数组 []
6. 最多返回 3 条`

// ─── 工具函数 ─────────────────────────────────────────────────────────────────

function extractContent(msg: any): string {
  const raw = String(msg.parsedContent || msg.rawContent || msg.message_content || msg.content || '').trim()
  if (!raw) return ''
  if (/^(<\?xml|<msg\b|<appmsg\b|<img\b|<emoji\b|<voip\b|<sysmsg\b)/i.test(raw)) return ''
  const textMatch = raw.match(/<content[^>]*>([^<]+)<\/content>/i)
  if (textMatch) return textMatch[1].trim()
  if (raw.startsWith('<')) return ''
  return raw
}

function getIsSend(msg: any): number {
  if (msg.isSend !== undefined && msg.isSend !== null) return Number(msg.isSend)
  if (msg.computed_is_send !== undefined) return Number(msg.computed_is_send)
  if (msg.is_send !== undefined) return Number(msg.is_send)
  return 0
}

function formatMessages(messages: any[], peerName: string): string {
  const lines: string[] = []
  let totalLen = 0
  for (const msg of messages) {
    const content = extractContent(msg)
    if (!content) continue
    const sender = getIsSend(msg) === 1 ? '我' : peerName
    const line = `${sender}：${content.slice(0, 150)}`
    if (totalLen + line.length > MAX_CONTEXT_CHARS) break
    lines.push(line)
    totalLen += line.length + 1
  }
  return lines.reverse().join('\n')
}

// ─── 服务 ────────────────────────────────────────────────────────────────────

class SalesFollowUpService {
  private scanning = false

  async scanForFollowUps(config: ConfigService): Promise<FollowUpScanResult> {
    if (this.scanning) {
      return { success: false, error: '正在扫描中，请稍候' }
    }
    this.scanning = true

    try {
      if (!isAiConfigured(config)) {
        return { success: false, error: 'AI 未配置' }
      }

      const connected = await wcdbService.isConnected()
      if (!connected) {
        return { success: false, error: '微信数据库未连接' }
      }

      // 1. 获取最近活跃的会话
      const sessionsResult = await wcdbService.getSessions()
      if (!sessionsResult.success || !sessionsResult.sessions) {
        return { success: false, error: '无法获取会话列表' }
      }

      // 过滤：只保留单聊、非系统账号、按时间排序取最近的
      const SYSTEM = new Set(['filehelper', 'newsapp', 'tnewsapp', 'fmessage', 'weixin', 'medianote', 'mphelper', 'weixinguanhaozhuli', 'notifymessage'])
      const candidates = sessionsResult.sessions
        .filter((s: any) => s.username
          && !s.username.endsWith('@chatroom')
          && !s.username.startsWith('gh_')
          && !SYSTEM.has(s.username))
        .sort((a: any, b: any) => (b.sortTimestamp || b.lastTimestamp || 0) - (a.sortTimestamp || a.lastTimestamp || 0))
        .slice(0, SCAN_SESSION_LIMIT)

      if (candidates.length === 0) {
        return { success: false, error: '没有可扫描的会话' }
      }

      // 2. 获取显示名
      const sessionIds = candidates.map((s: any) => s.username)
      let nameMap: Record<string, string> = {}
      try {
        const namesResult = await wcdbService.getDisplayNames(sessionIds)
        if (namesResult.success && namesResult.map) nameMap = namesResult.map
      } catch { /* ignore */ }

      // 3. 逐个扫描
      const allTasks: DetectedTask[] = []

      for (const session of candidates) {
        const sessionId = session.username
        const displayName = nameMap[sessionId] || session.displayName || sessionId

        try {
          const msgResult = await wcdbService.getMessages(sessionId, SCAN_MESSAGE_LIMIT, 0)
          if (!msgResult.success || !msgResult.messages || msgResult.messages.length === 0) continue

          const chatText = formatMessages(msgResult.messages, displayName)
          if (chatText.length < 20) continue  // 太短跳过

          // 调用 AI 分析
          const aiResponse = await simpleCompletion(
            config,
            SYSTEM_PROMPT,
            `以下是与"${displayName}"的最近聊天记录：\n\n${chatText}\n\n请识别需要跟进的事项。`,
            { responseFormatJson: true, temperature: 0.3, maxTokens: 300 }
          )

          // 解析结果
          const parsed = this.parseAiResponse(aiResponse)
          if (parsed && parsed.length > 0) {
            for (const item of parsed) {
              const dueAt = item.due_days
                ? Date.now() + item.due_days * 24 * 60 * 60 * 1000
                : undefined

              allTasks.push({
                session_id: sessionId,
                display_name: displayName,
                title: item.title,
                due_at: dueAt,
                trigger_type: item.trigger_type || 'ai_detected'
              })

              // 写入数据库
              salesDbService.todoCreate({
                session_id: sessionId,
                trigger_type: item.trigger_type || 'ai_detected',
                title: `[${displayName}] ${item.title}`,
                due_at: dueAt
              })
            }
          }
        } catch {
          // 单个会话失败不影响其他
          continue
        }
      }

      return { success: true, tasks: allTasks }
    } catch (e) {
      return { success: false, error: String(e) }
    } finally {
      this.scanning = false
    }
  }

  private parseAiResponse(text: string): Array<{ title: string; trigger_type: string; due_days: number | null }> | null {
    try {
      let jsonStr = text.trim()
      const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/)
      if (jsonMatch) jsonStr = jsonMatch[1].trim()
      const arrMatch = jsonStr.match(/\[[\s\S]*\]/)
      if (arrMatch) jsonStr = arrMatch[0]

      const parsed = JSON.parse(jsonStr)
      if (!Array.isArray(parsed)) return null

      return parsed
        .filter((item: any) => item && typeof item.title === 'string' && item.title.trim())
        .slice(0, 3)
        .map((item: any) => ({
          title: String(item.title).trim().slice(0, 50),
          trigger_type: ['promise_contact', 'unanswered_quote', 'ai_detected'].includes(item.trigger_type)
            ? item.trigger_type
            : 'ai_detected',
          due_days: Number.isFinite(item.due_days) && item.due_days > 0 && item.due_days <= 30
            ? Math.floor(item.due_days)
            : null
        }))
    } catch {
      return null
    }
  }
}

export const salesFollowUpService = new SalesFollowUpService()
