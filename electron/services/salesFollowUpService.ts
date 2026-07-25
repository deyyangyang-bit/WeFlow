/**
 * salesFollowUpService.ts
 *
 * AI 跟进待办服务（按产品方案 V1 重做）
 *
 * 核心流程：
 * 1. 承诺提取（两段式）：规则粗筛 → LLM 结构化抽取 → 置信度过滤
 * 2. 自动核验：按 due_time 驱动，把已有待办+后续聊天喂 AI，三档判断
 * 3. 反馈修正：人工纠正落库
 */

import { wcdbService } from './wcdbService'
import { salesDbService, type FollowUpTask } from './salesDbService'
import { simpleCompletion, isAiConfigured } from './ai/aiApiClient'
import { ConfigService } from './config'

// ─── 类型 ────────────────────────────────────────────────────────────────────

export interface ExtractedPromise {
  session_id: string
  display_name: string
  source_message_id?: string
  promise_summary: string
  action_type: string       // reply_customer | urge_customer | internal_action | node_reminder
  due_days: number | null   // 相对天数
  confidence: number        // 0-1
}

export interface VerificationResult {
  todo_id: number
  judgment: 'followed' | 'suspected' | 'not_followed'
  reason: string
}

export interface ScanResult {
  success: boolean
  newTasks?: number
  verifiedTasks?: VerificationResult[]
  error?: string
}

// ─── 常量 ────────────────────────────────────────────────────────────────────

const SCAN_SESSION_LIMIT = 15
const SCAN_MESSAGE_LIMIT = 30
const MAX_CONTEXT_CHARS = 1500
const CONFIDENCE_THRESHOLD = 0.6   // 低于此值进入"待确认"
const VERIFY_WINDOW_DAYS = 3       // 到期后 N 天内核验

// ─── 第一阶段：规则粗筛 ─────────────────────────────────────────────────────

// 时间词
const TIME_PATTERNS = /下周|这周|本周|月底|周[一二三四五六日天]|明天|后天|大后天|\d+号|\d+月|今天|晚上|上午|下午|尽快|这两天|过几天|回头|稍后|待会|一会儿|\d+点/

// 承诺动词（我方的承诺）
const PROMISE_VERBS = /发给你|发您|给你发|给您发|我发|我整理|我确认|我查|我问|我安排|我联系|我回复|我报价|我寄|我送|我准备|我处理|我跟进|我催|我核实|我对接|我协调|我落实|我反馈|我沟通|我了解|我看看|我研究|我考虑|我申请|我帮你|我帮您|给你|给您|回头[我咱]|等[我咱]|我这边/

// 客户请求（需要我方响应的）
const REQUEST_PATTERNS = /能不能|可以|麻烦|帮我|帮忙|请问|想了解|想知道|需要|报价|方案|参数|规格|价格|多少钱|怎么卖|有货|现货|交期|样品|资料|图册|选型/

function roughFilter(messages: any[], peerName: string): Array<{ text: string; isSend: number; msgId?: string }> {
  const candidates: Array<{ text: string; isSend: number; msgId?: string }> = []

  for (const msg of messages) {
    const content = extractContent(msg)
    if (!content || content.length < 4) continue

    const isSend = getIsSend(msg)
    const msgId = String(msg.serverId || msg.server_id || msg.localId || msg.local_id || '')

    // 我方消息：包含时间词+承诺动词
    if (isSend === 1) {
      if (TIME_PATTERNS.test(content) && PROMISE_VERBS.test(content)) {
        candidates.push({ text: content, isSend, msgId })
      }
    }
    // 客户消息：包含请求模式（需要我方响应）
    else {
      if (REQUEST_PATTERNS.test(content) && TIME_PATTERNS.test(content)) {
        candidates.push({ text: content, isSend, msgId })
      }
    }
  }

  return candidates
}

// ─── 第二阶段：LLM 结构化抽取 ───────────────────────────────────────────────

const EXTRACT_PROMPT = `你是一个 B2B 工业设备销售跟进助手。从聊天片段中抽取销售人员做出的跟进承诺或需要响应的客户需求。

输出 JSON 数组，每条格式：
{"promise_summary": "承诺/需求摘要(20字内)", "action_type": "类型", "due_days": 天数或null, "confidence": 0.0-1.0}

action_type 取值：
- reply_customer: 该我回复客户（承诺发资料/报价/回复等）
- urge_customer: 该客户回复我（我催客户确认/付款/回复等）
- internal_action: 内部动作（准备报价单、申请折扣、安排样机等）
- node_reminder: 节点提醒（合同到期、账期、交付日等）

规则：
1. 只抽取明确的承诺或需要响应的请求，不要抽取纯寒暄
2. confidence < 0.6 的不要输出
3. due_days: 从聊天中推断截止天数（"下周"=7, "明天"=1, "月底"=距月底天数），推断不出则 null
4. 最多输出 5 条
5. 如果没有明确承诺，返回空数组 []`

// ─── 第三阶段：自动核验 ─────────────────────────────────────────────────────

const VERIFY_PROMPT = `你是一个 B2B 销售跟进核验助手。判断以下待办承诺是否已在后续聊天中兑现。

输出 JSON 数组，每条格式：
{"todo_id": 待办ID, "judgment": "followed|suspected|not_followed", "reason": "判断依据(20字内)"}

判断标准：
- followed: 后续聊天中有明确证据表明承诺已兑现（如发了报价、客户确认收到等）
- suspected: 有相关消息但不能确定是否完全兑现（保守处理，需人工确认）
- not_followed: 后续聊天中完全没有相关动作

关键原则：宁可判 suspected 也不要误判 followed。一旦误判"已完成"，工具可信度崩塌。`

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

  /**
   * 主入口：AI 扫描（提取 + 核验）
   */
  async scan(config: ConfigService, period: string = 'week'): Promise<ScanResult> {
    if (this.scanning) return { success: false, error: '正在扫描中，请稍候' }
    this.scanning = true

    try {
      if (!isAiConfigured(config)) return { success: false, error: 'AI 未配置' }
      const connected = await wcdbService.isConnected()
      if (!connected) return { success: false, error: '微信数据库未连接' }

      // Phase A: 核验到期待办
      const verified = await this.verifyDueTasks(config)

      // Phase B: 提取新承诺
      const newCount = await this.extractNewPromises(config, period)

      return { success: true, newTasks: newCount, verifiedTasks: verified }
    } catch (e) {
      return { success: false, error: String(e) }
    } finally {
      this.scanning = false
    }
  }

  /**
   * Phase A: 核验到期待办（按 due_time 驱动）
   */
  private async verifyDueTasks(config: ConfigService): Promise<VerificationResult[]> {
    // 查找所有 pending 且已到期的待办
    const pendingTasks = salesDbService.todoList({ status: 'pending' })
    const now = Date.now()
    const dueTasks = pendingTasks.filter(t =>
      t.due_at && t.due_at <= now + VERIFY_WINDOW_DAYS * 24 * 60 * 60 * 1000
    )

    if (dueTasks.length === 0) return []

    const results: VerificationResult[] = []

    // 按 session_id 分组
    const bySession = new Map<string, FollowUpTask[]>()
    for (const task of dueTasks) {
      if (!task.session_id) continue
      const list = bySession.get(task.session_id) || []
      list.push(task)
      bySession.set(task.session_id, list)
    }

    for (const [sessionId, tasks] of bySession) {
      try {
        // 取该客户最近的消息
        const msgResult = await wcdbService.getMessages(sessionId, SCAN_MESSAGE_LIMIT, 0)
        if (!msgResult.success || !msgResult.messages?.length) continue

        const displayName = tasks[0].display_name || sessionId
        const chatText = formatMessages(msgResult.messages, displayName)
        if (!chatText) continue

        // 构造待办上下文
        const todoContext = tasks.map(t =>
          `- [ID:${t.id}] ${t.promise_summary || t.title}（截止：${t.due_at ? new Date(t.due_at).toLocaleDateString('zh-CN') : '未定'}）`
        ).join('\n')

        const aiResponse = await simpleCompletion(
          config,
          VERIFY_PROMPT,
          `该客户的待办承诺：\n${todoContext}\n\n后续聊天记录：\n${chatText}\n\n请判断每条待办是否已兑现。`,
          { responseFormatJson: true, temperature: 0.2, maxTokens: 400 }
        )

        const parsed = this.parseVerifyResponse(aiResponse)
        if (parsed) {
          for (const item of parsed) {
            results.push(item)
            // 更新待办状态
            if (item.judgment === 'followed') {
              salesDbService.todoUpdate(item.todo_id, { status: 'followed_ai', completed_at: now })
            } else if (item.judgment === 'suspected') {
              salesDbService.todoUpdate(item.todo_id, { status: 'suspected' })
            } else {
              salesDbService.todoUpdate(item.todo_id, { status: 'overdue' })
            }
            // 写入 feedback_log
            const task = tasks.find(t => t.id === item.todo_id)
            if (task) {
              const log = JSON.parse(task.feedback_log || '[]')
              log.push({ time: now, ai_judgment: item.judgment, reason: item.reason })
              salesDbService.todoUpdate(item.todo_id, { feedback_log: JSON.stringify(log) })
            }
          }
        }
      } catch { continue }
    }

    return results
  }

  /**
   * Phase B: 提取新承诺（两段式）
   */
  private async extractNewPromises(config: ConfigService, period: string): Promise<number> {
    const sessionsResult = await wcdbService.getSessions()
    if (!sessionsResult.success || !sessionsResult.sessions) return 0

    // 过滤 + 排序
    const SYSTEM = new Set(['filehelper', 'newsapp', 'tnewsapp', 'fmessage', 'weixin', 'medianote', 'mphelper', 'weixinguanhaozhuli', 'notifymessage'])
    const candidates = sessionsResult.sessions
      .filter((s: any) => s.username && !s.username.endsWith('@chatroom') && !s.username.startsWith('gh_') && !SYSTEM.has(s.username))
      .sort((a: any, b: any) => {
        const ta = a.sortTimestamp || a.sort_timestamp || a.lastTimestamp || a.last_timestamp || 0
        const tb = b.sortTimestamp || b.sort_timestamp || b.lastTimestamp || b.last_timestamp || 0
        return tb - ta
      })
      .slice(0, SCAN_SESSION_LIMIT)

    // 获取显示名
    const sessionIds = candidates.map((s: any) => s.username)
    let nameMap: Record<string, string> = {}
    try {
      const r = await wcdbService.getDisplayNames(sessionIds)
      if (r.success && r.map) nameMap = r.map
    } catch { /* ignore */ }

    let newCount = 0

    for (const session of candidates) {
      const sessionId = session.username
      const displayName = nameMap[sessionId] || session.displayName || sessionId

      try {
        const msgResult = await wcdbService.getMessages(sessionId, SCAN_MESSAGE_LIMIT, 0)
        if (!msgResult.success || !msgResult.messages?.length) continue

        // 第一阶段：规则粗筛
        const candidates2 = roughFilter(msgResult.messages, displayName)
        if (candidates2.length === 0) continue

        // 第二阶段：LLM 结构化抽取
        const candidateText = candidates2
          .map(c => `${c.isSend === 1 ? '我' : displayName}：${c.text.slice(0, 150)}`)
          .join('\n')

        const aiResponse = await simpleCompletion(
          config,
          EXTRACT_PROMPT,
          `以下是与"${displayName}"聊天中的候选承诺/请求片段：\n\n${candidateText}\n\n请抽取结构化的跟进待办。`,
          { responseFormatJson: true, temperature: 0.2, maxTokens: 500 }
        )

        const extracted = this.parseExtractResponse(aiResponse)
        if (!extracted || extracted.length === 0) continue

        // 去重 + 写入
        for (const item of extracted) {
          // 去重：检查是否已有同 session + 相似 title 的 pending 待办
          const existing = salesDbService.todoList({ status: 'pending', session_id: sessionId })
          const isDup = existing.some(t =>
            (t.promise_summary || t.title).includes(item.promise_summary.slice(0, 8)) ||
            item.promise_summary.includes((t.promise_summary || t.title).slice(0, 8))
          )
          if (isDup) continue

          const dueAt = item.due_days ? Date.now() + item.due_days * 24 * 60 * 60 * 1000 : null
          const status = item.confidence >= CONFIDENCE_THRESHOLD ? 'pending' : 'suspected'

          salesDbService.todoCreate({
            session_id: sessionId,
            display_name: displayName,
            source_message_id: candidates2[0]?.msgId || null,
            promise_summary: item.promise_summary,
            action_type: item.action_type,
            trigger_type: 'ai_detected',
            title: `[${displayName}] ${item.promise_summary}`,
            due_at: dueAt,
            status,
            created_by: 'ai',
            confidence: item.confidence,
            priority_score: this.calcPriority(item.confidence, item.due_days)
          })
          newCount++
        }
      } catch { continue }
    }

    return newCount
  }

  // ─── 辅助方法 ──────────────────────────────────────────────────────────────

  private calcPriority(confidence: number, dueDays: number | null): number {
    // 简化版：置信度 × 紧迫度
    const urgency = dueDays !== null ? Math.max(0, 1 - dueDays / 14) : 0.3
    return Math.round(confidence * urgency * 100) / 100
  }

  private parseExtractResponse(text: string): ExtractedPromise[] | null {
    try {
      let jsonStr = text.trim()
      const m = jsonStr.match(/\[[\s\S]*\]/)
      if (m) jsonStr = m[0]
      const arr = JSON.parse(jsonStr)
      if (!Array.isArray(arr)) return null
      return arr
        .filter((x: any) => x && typeof x.promise_summary === 'string' && x.promise_summary.trim())
        .slice(0, 5)
        .map((x: any) => ({
          session_id: '',
          display_name: '',
          promise_summary: String(x.promise_summary).trim().slice(0, 50),
          action_type: ['reply_customer', 'urge_customer', 'internal_action', 'node_reminder'].includes(x.action_type) ? x.action_type : 'reply_customer',
          due_days: Number.isFinite(x.due_days) && x.due_days > 0 && x.due_days <= 60 ? Math.floor(x.due_days) : null,
          confidence: Number.isFinite(x.confidence) ? Math.min(1, Math.max(0, x.confidence)) : 0.5
        }))
    } catch { return null }
  }

  private parseVerifyResponse(text: string): VerificationResult[] | null {
    try {
      let jsonStr = text.trim()
      const m = jsonStr.match(/\[[\s\S]*\]/)
      if (m) jsonStr = m[0]
      const arr = JSON.parse(jsonStr)
      if (!Array.isArray(arr)) return null
      return arr
        .filter((x: any) => x && Number.isFinite(x.todo_id))
        .map((x: any) => ({
          todo_id: Math.floor(x.todo_id),
          judgment: ['followed', 'suspected', 'not_followed'].includes(x.judgment) ? x.judgment : 'suspected',
          reason: String(x.reason || '').slice(0, 50)
        }))
    } catch { return null }
  }
}

export const salesFollowUpService = new SalesFollowUpService()
