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

      // 2. 批量获取每日消息统计
      const dateCountsResult = await wcdbService.getSessionMessageDateCountsBatch(sessionIds)
      if (!dateCountsResult.success || !dateCountsResult.data) {
        return { success: false, error: '无法获取消息统计' }
      }

      // 3. 按周期过滤并汇总
      const startStr = tsToDateStr(range.start)
      const endStr = tsToDateStr(range.end)

      let totalMessages = 0
      const contactMessages: Map<string, number> = new Map()
      const dailyCounts: Map<string, number> = new Map()

      for (const [sessionId, dateMap] of Object.entries(dateCountsResult.data)) {
        let sessionTotal = 0
        for (const [dateStr, count] of Object.entries(dateMap as Record<string, number>)) {
          if (dateStr >= startStr && dateStr <= endStr) {
            sessionTotal += count
            totalMessages += count
            dailyCounts.set(dateStr, (dailyCounts.get(dateStr) ?? 0) + count)
          }
        }
        if (sessionTotal > 0) {
          contactMessages.set(sessionId, sessionTotal)
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
}

export const salesReportService = new SalesReportService()
