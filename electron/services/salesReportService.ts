/**
 * salesReportService.ts
 *
 * 销售周报/月报服务。
 * 通过 wcdbService 读取微信聊天数据，统计周期内指标，调用 AI 生成摘要。
 */

import { wcdbService } from './wcdbService'
import { salesDbService } from './salesDbService'
import { simpleCompletion, isAiConfigured } from './ai/aiApiClient'
import { ConfigService } from './config'

// ─── 类型 ────────────────────────────────────────────────────────────────────

export interface ReportStats {
  totalMessages: number
  activeContacts: number
  topContacts: Array<{
    sessionId: string
    displayName: string
    avatarUrl?: string
    messageCount: number
  }>
  dailyMessageCounts: Array<{ date: string; count: number }>
  myMessageCount: number
  peerMessageCount: number
}

export interface GenerateReportResult {
  success: boolean
  report?: {
    id: number
    period_type: string
    period_start: number
    period_end: number
    stats: string
    ai_summary?: string | null
    created_at: number
  }
  error?: string
}

// ─── 工具函数 ─────────────────────────────────────────────────────────────────

function getWeekRange(date: Date = new Date()): { start: number; end: number } {
  const d = new Date(date)
  const day = d.getDay() || 7 // 周日=7
  d.setDate(d.getDate() - day + 1) // 周一
  d.setHours(0, 0, 0, 0)
  const start = d.getTime()
  d.setDate(d.getDate() + 7)
  const end = d.getTime() - 1
  return { start, end }
}

function getMonthRange(date: Date = new Date()): { start: number; end: number } {
  const d = new Date(date)
  d.setDate(1)
  d.setHours(0, 0, 0, 0)
  const start = d.getTime()
  d.setMonth(d.getMonth() + 1)
  const end = d.getTime() - 1
  return { start, end }
}

function getDateRange(periodType: string, periodStart?: number): { start: number; end: number } {
  if (periodStart) {
    const d = new Date(periodStart)
    if (periodType === 'week') return getWeekRange(d)
    return getMonthRange(d)
  }
  return periodType === 'week' ? getWeekRange() : getMonthRange()
}

function tsToDateStr(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// ─── 服务类 ──────────────────────────────────────────────────────────────────

class SalesReportService {
  private config: ConfigService | null = null

  setConfig(config: ConfigService): void {
    this.config = config
  }

  /**
   * 生成报表：统计 + AI 摘要 + 持久化
   */
  async generate(payload: {
    period_type: string
    period_start?: number
    period_end?: number
  }): Promise<GenerateReportResult> {
    try {
      const { period_type } = payload
      const range = getDateRange(period_type, payload.period_start)

      // 检查 WCDB 连接
      const connected = await wcdbService.isConnected()
      if (!connected) {
        return { success: false, error: '微信数据库未连接，请先在设置页面配置解密密钥' }
      }

      // 1. 获取会话列表
      const sessionsResult = await wcdbService.getSessions()
      if (!sessionsResult.success || !sessionsResult.sessions) {
        return { success: false, error: '无法获取会话列表' }
      }

      // 过滤掉群聊、公众号和系统会话，只保留真实单聊
      const SYSTEM_ACCOUNTS = new Set([
        'filehelper', 'newsapp', 'tnewsapp', 'fmessage', 'medianote',
        'floatbottle', 'shakeapp', 'lbsapp', 'voicevoipapp', 'feedsapp',
        'voip', 'blogapp', 'qmessage', 'qqsync', 'mphelper', 'weixinguanhaozhuli',
        'weixin', 'weixin_team', 'weixinguanhaozhuli'
      ])
      const privateSessions = sessionsResult.sessions.filter(
        (s: any) => s.username
          && !s.username.endsWith('@chatroom')
          && !s.username.startsWith('gh_')
          && !SYSTEM_ACCOUNTS.has(s.username)
      )

      const sessionIds = privateSessions.map((s: any) => s.username)

      if (sessionIds.length === 0) {
        return { success: false, error: '没有可用的单聊会话' }
      }

      // 2. 使用 getAnnualReportStats 获取周期内统计（与年度报告同一原生 API）
      const startSec = Math.floor(range.start / 1000)
      const endSec = Math.floor(range.end / 1000)
      const statsResult = await wcdbService.getAnnualReportStats(sessionIds, startSec, endSec)
      if (!statsResult.success || !statsResult.data) {
        return { success: false, error: '无法获取消息统计: ' + (statsResult.error || '未知错误') }
      }

      // 3. 从统计结果中提取数据
      const d = statsResult.data
      const totalMessages = d.total || 0
      const contactMessages: Map<string, number> = new Map()
      const dailyCounts: Map<string, number> = new Map()

      // 提取每个会话的消息数
      if (d.sessions) {
        for (const [sid, stat] of Object.entries(d.sessions)) {
          const s = stat as any
          const msgCount = (s.sent || 0) + (s.received || 0)
          if (msgCount > 0) {
            contactMessages.set(sid, msgCount)
          }
        }
      }

      // 提取每日消息分布
      if (d.daily) {
        for (const [dayKey, count] of Object.entries(d.daily)) {
          if (Number(count) > 0) {
            dailyCounts.set(String(dayKey), Number(count))
          }
        }
      }

      // 4. 获取 Top N 联系人的显示名和头像
      const topSessionIds = [...contactMessages.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([id]) => id)

      const [namesResult, avatarsResult] = await Promise.all([
        wcdbService.getDisplayNames(topSessionIds),
        wcdbService.getAvatarUrls(topSessionIds)
      ])

      const nameMap = namesResult.success ? (namesResult.map ?? {}) : {}
      const avatarMap = avatarsResult.success ? (avatarsResult.map ?? {}) : {}

      const topContacts = topSessionIds.map(id => ({
        sessionId: id,
        displayName: nameMap[id] || id,
        avatarUrl: avatarMap[id],
        messageCount: contactMessages.get(id) ?? 0
      }))

      // 5. 组装统计数据
      const dailyMessageCounts = [...dailyCounts.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([date, count]) => ({ date, count }))

      const stats: ReportStats = {
        totalMessages,
        activeContacts: contactMessages.size,
        topContacts,
        dailyMessageCounts,
        myMessageCount: 0, // 简化版暂不区分收发
        peerMessageCount: 0
      }

      // 6. AI 摘要
      let aiSummary: string | null = null
      if (this.config && isAiConfigured(this.config)) {
        try {
          const periodLabel = period_type === 'week' ? '本周' : '本月'
          const topNames = topContacts.slice(0, 5).map(c => c.displayName).join('、')

          aiSummary = await simpleCompletion(
            this.config,
            `你是一个 B2B 销售经营分析助手。根据提供的统计数据，用 2-3 句中文总结${periodLabel}的销售沟通情况，给出 1 条可执行建议。只输出正文，不要标题或列表。`,
            `${periodLabel}统计：消息总量 ${totalMessages} 条，活跃客户 ${contactMessages.size} 人。互动最多的客户：${topNames || '无'}。每日消息趋势：${dailyMessageCounts.map(d => `${d.date}:${d.count}`).join(', ') || '无数据'}。`
          )
        } catch (e) {
          console.warn('[SalesReport] AI 摘要生成失败:', e)
        }
      }

      // 7. 持久化
      const report = salesDbService.reportCreate({
        period_type,
        period_start: range.start,
        period_end: range.end,
        stats: JSON.stringify(stats),
        ai_summary: aiSummary
      })

      return { success: true, report }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  /**
   * 生成周复盘（PRD v2 P1）：不只是统计，重点是"谁热了/谁冷了/谁该放弃/下周重点"
   */
  async generateWeeklyReview(): Promise<GenerateReportResult> {
    try {
      if (!this.config || !isAiConfigured(this.config)) {
        return { success: false, error: 'AI 未配置' }
      }

      const range = getWeekRange()
      const nowSec = Math.floor(Date.now() / 1000)
      const weekStartSec = Math.floor(range.start / 1000)

      // 获取所有客户及其阶段
      const customers = salesDbService.customerAll()
      if (customers.length === 0) {
        return { success: false, error: '暂无客户数据，请先连接微信数据库' }
      }

      // 分类统计
      const stageCounts: Record<string, number> = {}
      const hotCustomers: string[] = []  // 阶段前进
      const coldCustomers: string[] = [] // 阶段后退/进入 dormant
      const dropCandidates: string[] = [] // 建议放弃
      const activeThisWeek: string[] = []

      for (const c of customers) {
        const stage = c.stage || 'unknown'
        stageCounts[stage] = (stageCounts[stage] || 0) + 1

        const lastContact = c.last_contact_at ?? 0
        const silentDays = (nowSec - lastContact) / 86400

        // 本周有互动的
        if (lastContact >= weekStartSec) {
          activeThisWeek.push(c.display_name || c.session_id)
        }

        // 沉默超 30 天的 contacted/negotiating → 变冷了
        if (['contacted', 'negotiating', 'quoted'].includes(stage) && silentDays > 30) {
          coldCustomers.push(`${c.display_name || c.session_id}(${stage},${Math.floor(silentDays)}天)`)
        }

        // 沉默超 60 天 → 建议放弃
        if (silentDays > 60 && !['won', 'lost'].includes(stage)) {
          dropCandidates.push(c.display_name || c.session_id)
        }

        // 本周阶段变化（通过 intent_tag_log 判断）
        const latestIntent = salesDbService.intentGetLatest(c.session_id)
        if (latestIntent && latestIntent.created_at >= range.start) {
          if (['quoted', 'negotiating', 'won'].includes(latestIntent.stage)) {
            hotCustomers.push(`${c.display_name || c.session_id}→${latestIntent.stage}`)
          }
        }
      }

      // 构建 AI prompt
      const pipelineTotal = customers.filter(c => !['won', 'lost'].includes(c.stage || '')).length
      const prompt = `你是叉车/仓储设备销售顾问。以下是本周管道数据：

管道中客户总数：${pipelineTotal}
阶段分布：${JSON.stringify(stageCounts)}
本周活跃客户(${activeThisWeek.length}人)：${activeThisWeek.slice(0, 10).join('、') || '无'}
阶段前进(热了)：${hotCustomers.slice(0, 5).join('、') || '无'}
变冷(>30天无互动)：${coldCustomers.slice(0, 5).join('、') || '无'}
建议放弃(>60天)：${dropCandidates.slice(0, 5).join('、') || '无'}

请生成本周复盘，格式：
1. 一句话总结本周状态
2. 谁热了（建议下一步动作）
3. 谁冷了（是否值得救）
4. 建议放弃的（果断释放精力）
5. 下周重点（最多3件事）

用简洁口语化中文，每条1-2句。不要 markdown 标题符号。`

      const aiReview = await simpleCompletion(
        this.config,
        '你是一个 B2B 销售教练，帮销售员做周复盘。输出简洁可执行的建议，不要废话。',
        prompt,
        { temperature: 0.7, maxTokens: 600, disableThinking: true, timeoutMs: 30_000 }
      )

      // 持久化为 report_snapshot（period_type = 'weekly_review'）
      const stats = {
        pipelineTotal,
        stageCounts,
        activeCount: activeThisWeek.length,
        hotCount: hotCustomers.length,
        coldCount: coldCustomers.length,
        dropCount: dropCandidates.length
      }

      const report = salesDbService.reportCreate({
        period_type: 'weekly_review',
        period_start: range.start,
        period_end: range.end,
        stats: JSON.stringify(stats),
        ai_summary: aiReview
      })

      return { success: true, report }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }
}

// ─── 周复盘定时器 ─────────────────────────────────────────────────────────────

let reviewTimer: NodeJS.Timeout | null = null
let lastReviewWeekStart = 0

/**
 * 启动周复盘定时器：每周日 20:00 自动生成
 */
export function startWeeklyReviewScheduler(config: ConfigService): void {
  if (reviewTimer) return
  salesReportService.setConfig(config)

  // 每 30 分钟检查一次
  reviewTimer = setInterval(async () => {
    const now = new Date()
    // 周日 = 0, 20:00-20:30 窗口
    if (now.getDay() === 0 && now.getHours() === 20 && now.getMinutes() < 30) {
      const weekRange = getWeekRange()
      if (lastReviewWeekStart < weekRange.start) {
        console.log('[SalesReport] 触发周复盘生成')
        const result = await salesReportService.generateWeeklyReview()
        if (result.success) {
          lastReviewWeekStart = weekRange.start
          console.log('[SalesReport] 周复盘生成成功')
        } else {
          console.warn('[SalesReport] 周复盘生成失败:', result.error)
        }
      }
    }
  }, 30 * 60 * 1000)
}

export function stopWeeklyReviewScheduler(): void {
  if (reviewTimer) { clearInterval(reviewTimer); reviewTimer = null }
}

export const salesReportService = new SalesReportService()
