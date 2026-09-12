/**
 * salesReportService.ts
 *
 * 销售周报/月报服务。
 * 通过 wcdbService 读取微信聊天数据，统计周期内指标，调用 AI 生成摘要。
 */

import { wcdbService } from './wcdbService'
import { salesDbService, type CustomerProfile } from './salesDbService'
import { crmDbService } from './crmDbService'
import { normalizeStage } from './salesActionEngine'
import { CANONICAL_TO_CN } from '../../shared/salesStage'
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
    id?: number
    period_type: string
    period_start: number
    period_end: number
    stats: string
    ai_summary?: string | null
    created_at?: number
  }
  error?: string
}

/** 周复盘统计结构（computeWeeklyReviewStats 纯函数产物，随 stats 落库） */
export interface WeeklyReviewStats {
  pipelineTotal: number
  stageCounts: Record<string, number>
  activeCount: number
  hotCount: number
  coldCount: number
  dropCount: number
  /** 明细（各取前 5，活跃前 10），前端展示 + prompt 用 */
  activeCustomers: string[]
  hotCustomers: string[]
  coldCustomers: string[]
  dropCandidates: string[]
  /** 阶段英文 key → 中文 label（前端渲染 + prompt 用） */
  stageLabel: Record<string, string>
}

// ─── 阶段语义 ─────────────────────────────────────────────────────────────────

/** 英文阶段 → 中文展示名（共享层 canonical 唯一源，保留 Record<string,string> 类型兼容索引） */
export const STAGE_EN_TO_CN: Record<string, string> = { ...CANONICAL_TO_CN }

/** 阶段序：用于「热了」= 本周阶段相对上周前进 判定 */
const STAGE_ORDER: Record<string, number> = {
  unknown: 0, new: 0, dormant: 0, contacted: 1, quoted: 2, negotiating: 3, won: 4, lost: 5
}

function stageToCn(en: string): string {
  return STAGE_EN_TO_CN[en] || en
}

/** 读取用户手动排除的会话名单（同事/朋友等非销售关系），去空格规范化 */
function getExcludedSessions(config: ConfigService | null): string[] {
  if (!config) return []
  const raw = config.get('reportExcludedSessions')
  return Array.isArray(raw) ? raw.map((s) => String(s).trim()).filter(Boolean) : []
}

/**
 * 纯函数：从「周期内消息会话」中筛出客户会话（命中 CRM account 或 AI 画像 customer_profile）。
 * 过滤掉家人/同事/快递员等非客户的高消息量会话，避免 Top 互动排行失真。
 * excludedSessions：用户手动排除名单（同事/朋友），命中一律剔除。
 */
export function filterCustomerSessions(
  contactMessages: Map<string, number>,
  accountMap: Record<string, { id: number; name: string }>,
  profileMap: Map<string, CustomerProfile>,
  excludedSessions: string[] = []
): { activeContacts: number; topSessions: string[] } {
  const excluded = new Set(excludedSessions.map((s) => String(s).trim()).filter(Boolean))
  const customerSessions = [...contactMessages.entries()].filter(
    ([sid]) => !excluded.has(sid) && (accountMap[sid] || profileMap.has(sid))
  )
  return {
    activeContacts: customerSessions.length,
    topSessions: customerSessions
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([sid]) => sid)
  }
}

/**
 * 纯函数：计算周复盘统计（热/冷/放弃/阶段分布），不触网、不落库。
 * 「热了」= 本周最新意向阶段相对上周基线前进（上周无记录 → 新进入管道也算热）。
 */
export function computeWeeklyReviewStats(
  customers: CustomerProfile[],
  opts: {
    nowSec: number
    weekStartSec: number
    getIntentLatest: (sessionId: string) => { stage?: string } | undefined
    getIntentBefore: (sessionId: string, ts: number) => { stage?: string } | undefined
    excludedSessions?: string[]
  }
): WeeklyReviewStats {
  const { nowSec, weekStartSec, getIntentLatest, getIntentBefore } = opts
  const excluded = new Set((opts.excludedSessions || []).map((s) => String(s).trim()).filter(Boolean))
  const stageCounts: Record<string, number> = {}
  const activeCustomers: string[] = []
  const hotCustomers: string[] = []
  const coldCustomers: string[] = []
  const dropCandidates: string[] = []

  for (const c of customers) {
    // 用户手动排除的联系人（同事/朋友）：不进任何统计
    if (c.session_id && excluded.has(c.session_id)) continue
    const enStage = normalizeStage(c.stage)
    stageCounts[enStage] = (stageCounts[enStage] || 0) + 1

    const lastContact = c.last_contact_at ?? 0
    const silentDays = (nowSec - lastContact) / 86400
    const label = c.display_name || c.session_id

    // 本周有互动
    if (lastContact >= weekStartSec) activeCustomers.push(label)

    // 变冷：接触/比价/决策阶段，沉默超 30 天（修复原中英混存漏判）
    if (['contacted', 'negotiating', 'quoted'].includes(enStage) && silentDays > 30) {
      coldCustomers.push(`${label}(${stageToCn(enStage)},${Math.floor(silentDays)}天)`)
    }

    // 建议放弃：沉默超 60 天且未成交/未流失
    if (silentDays > 60 && !['won', 'lost'].includes(enStage)) {
      dropCandidates.push(label)
    }

    // 热了：本周最新阶段相对上周基线前进（已成交/已流失不算热点）
    const cur = getIntentLatest(c.session_id)
    const curStage = cur?.stage ? normalizeStage(cur.stage) : ''
    if (curStage && !['lost', 'won'].includes(curStage)) {
      const prev = getIntentBefore(c.session_id, weekStartSec)
      const prevStage = prev?.stage ? normalizeStage(prev.stage) : ''
      // 本周前进：无上周基线（新进入管道）或 本周序 > 上周序
      if (!prevStage || (STAGE_ORDER[curStage] ?? 0) > (STAGE_ORDER[prevStage] ?? 0)) {
        hotCustomers.push(`${label}→${stageToCn(curStage)}`)
      }
    }
  }

  const pipelineTotal = customers.filter(
    (c) => !excluded.has(c.session_id || '') && !['won', 'lost'].includes(normalizeStage(c.stage))
  ).length

  return {
    pipelineTotal,
    stageCounts,
    activeCount: activeCustomers.length,
    hotCount: hotCustomers.length,
    coldCount: coldCustomers.length,
    dropCount: dropCandidates.length,
    activeCustomers: activeCustomers.slice(0, 10),
    hotCustomers: hotCustomers.slice(0, 5),
    coldCustomers: coldCustomers.slice(0, 5),
    dropCandidates: dropCandidates.slice(0, 5),
    stageLabel: STAGE_EN_TO_CN
  }
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

      // 4. 过滤非客户会话（命中 CRM account 或 AI 画像 customer_profile）+ 用户手动排除名单，再取 Top 10
      const accountMap = crmDbService.accountsBySessions([...contactMessages.keys()])
      const profileMap = new Map<string, CustomerProfile>()
      for (const p of salesDbService.customerAll()) {
        if (p.session_id) profileMap.set(p.session_id, p)
      }
      const { activeContacts, topSessions } = filterCustomerSessions(contactMessages, accountMap, profileMap, getExcludedSessions(this.config))

      // 5. 获取 Top N 联系人的显示名和头像（无客户会话则跳过查询）
      const topSessionIds = topSessions
      let nameMap: Record<string, string> = {}
      let avatarMap: Record<string, string> = {}
      if (topSessionIds.length > 0) {
        const [namesResult, avatarsResult] = await Promise.all([
          wcdbService.getDisplayNames(topSessionIds),
          wcdbService.getAvatarUrls(topSessionIds)
        ])
        nameMap = namesResult.success ? (namesResult.map ?? {}) : {}
        avatarMap = avatarsResult.success ? (avatarsResult.map ?? {}) : {}
      }

      const topContacts = topSessionIds.map(id => {
        const account = accountMap[id]
        const profile = profileMap.get(id)
        return {
          sessionId: id,
          displayName: profile?.display_name || account?.name || nameMap[id] || id,
          avatarUrl: avatarMap[id],
          messageCount: contactMessages.get(id) ?? 0
        }
      })

      // 5. 组装统计数据
      const dailyMessageCounts = [...dailyCounts.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([date, count]) => ({ date, count }))

      const stats: ReportStats = {
        totalMessages,
        activeContacts,
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
            `${periodLabel}统计：消息总量 ${totalMessages} 条，活跃客户 ${contactMessages.size} 人。互动最多的客户：${topNames || '无'}。每日消息趋势：${dailyMessageCounts.map(d => `${d.date}:${d.count}`).join(', ') || '无数据'}。`,
            { usageContext: { purpose: 'report' } }
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
   * 生成周复盘（PRD v2 P1）：不只是统计，重点是"谁热了/谁冷了/谁该放弃/下周重点"。
   * 统计由 computeWeeklyReviewStats 纯函数产出（热=本周 vs 上周基线对比，冷/放弃按沉默天数），
   * AI 仅负责把统计转成经营建议文案。
   */
  async generateWeeklyReview(): Promise<GenerateReportResult> {
    try {
      if (!this.config || !isAiConfigured(this.config)) {
        return { success: false, error: 'AI 未配置' }
      }

      const range = getWeekRange()
      const nowSec = Math.floor(Date.now() / 1000)
      const weekStartSec = Math.floor(range.start / 1000)

      const customers = salesDbService.customerAll()
      if (customers.length === 0) {
        return { success: false, error: '暂无客户数据，请先连接微信数据库' }
      }

      // 统计（纯函数，可单测）：热/冷/放弃/阶段分布 + 明细（用户手动排除名单一并剔除）
      const stats = computeWeeklyReviewStats(customers, {
        nowSec,
        weekStartSec,
        getIntentLatest: (sid) => salesDbService.intentGetLatest(sid),
        getIntentBefore: (sid, ts) => salesDbService.intentBefore(sid, ts),
        excludedSessions: getExcludedSessions(this.config)
      })

      // 构建 AI prompt
      const prompt = `你是叉车/仓储设备销售顾问。以下是本周管道数据：

管道中客户总数：${stats.pipelineTotal}
阶段分布：${JSON.stringify(stats.stageCounts)}
本周活跃客户(${stats.activeCount}人)：${stats.activeCustomers.join('、') || '无'}
阶段前进(热了)：${stats.hotCustomers.join('、') || '无'}
变冷(>30天无互动)：${stats.coldCustomers.join('、') || '无'}
建议放弃(>60天)：${stats.dropCandidates.join('、') || '无'}

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
        { temperature: 0.7, maxTokens: 600, disableThinking: true, timeoutMs: 30_000, usageContext: { purpose: 'report' } }
      )

      // 持久化为 report_snapshot（period_type = 'weekly_review'）
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

export const salesReportService = new SalesReportService()
