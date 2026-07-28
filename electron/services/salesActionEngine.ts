/**
 * salesActionEngine.ts
 *
 * 今日行动引擎：基于触发规则自动生成每日跟进任务。
 * 
 * 设计原则：
 * - 规则 v1 硬编码（不做配置 UI），验证有效后再开放
 * - 每日上限 15 条（避免信息过载）
 * - 同客户同规则 24h 内不重复生成
 * - 全量扫描每天 08:00 跑一次 + 新消息触发增量检查
 * - 所有 WCDB/AI 重操作走 salesQueue 串行
 */

import { ConfigService } from '../config'
import { salesDbService, type CustomerProfile, type FollowUpTask } from './salesDbService'
import { salesLogger } from './salesLogger'
import { wcdbService } from './wcdbService'
import { enqueueSalesTask } from './salesQueue'
import { classifyStage, toMessageSnippets, persistClassification, type CustomerStage } from './salesStageClassifier'
import { simpleCompletion, isAiConfigured } from './ai/aiApiClient'

// ─── 类型 ────────────────────────────────────────────────────────────────────

export interface ActionItem {
  id: number
  sessionId: string
  displayName: string
  stage: CustomerStage | string
  triggerType: string
  title: string
  reason: string
  suggestion: string
  priority: 'urgent' | 'high' | 'medium' | 'low' | 'info'
  priorityScore: number
  silentDays: number
  createdAt: number
  status: string
}

export interface TodayActionResult {
  items: ActionItem[]
  stats: {
    todayPending: number
    overdue: number
    newThisWeek: number
    pipelineTotal: number
  }
  generatedAt: number
}

// ─── 常量 ────────────────────────────────────────────────────────────────────

const DAILY_LIMIT = 15
const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000 // 24h
const DAY_SEC = 86400

const PRIORITY_WEIGHT: Record<string, number> = {
  urgent: 100,
  high: 80,
  medium: 60,
  low: 40,
  info: 20
}

// ─── 规则定义 ─────────────────────────────────────────────────────────────────

interface Rule {
  id: string
  priority: 'urgent' | 'high' | 'medium' | 'low' | 'info'
  /** 返回 true 表示该客户触发此规则 */
  match: (profile: CustomerProfile, nowSec: number) => boolean
  /** 生成任务标题 */
  title: (profile: CustomerProfile, silentDays: number) => string
}

const RULES: Rule[] = [
  {
    id: 'rule_r3_new_no_reply',
    priority: 'urgent',
    match: (p, now) => {
      if (p.stage !== 'new') return false
      const lastContact = p.last_contact_at ?? 0
      const silentDays = (now - lastContact) / DAY_SEC
      return silentDays >= 1
    },
    title: (p, days) => `新客响应：${p.display_name || '未知'}，${Math.floor(days)}天前加了微信还没实质沟通`
  },
  {
    id: 'rule_r1_quoted_followup',
    priority: 'high',
    match: (p, now) => {
      if (p.stage !== 'quoted') return false
      const lastContact = p.last_contact_at ?? 0
      const silentDays = (now - lastContact) / DAY_SEC
      return silentDays >= 3
    },
    title: (p, days) => `报价跟进：${p.display_name || '未知'}，已报价${Math.floor(days)}天没回复`
  },
  {
    id: 'rule_r2_negotiating_stall',
    priority: 'high',
    match: (p, now) => {
      if (p.stage !== 'negotiating') return false
      const lastContact = p.last_contact_at ?? 0
      const silentDays = (now - lastContact) / DAY_SEC
      return silentDays >= 2
    },
    title: (p, days) => `谈判跟进：${p.display_name || '未知'}，谈判中${Math.floor(days)}天没动静`
  },
  {
    id: 'rule_r4_contacted_silent',
    priority: 'medium',
    match: (p, now) => {
      if (p.stage !== 'contacted') return false
      const lastContact = p.last_contact_at ?? 0
      const silentDays = (now - lastContact) / DAY_SEC
      return silentDays >= 7
    },
    title: (p, days) => `激活沉默：${p.display_name || '未知'}，聊过产品但${Math.floor(days)}天没联系了`
  },
  {
    id: 'rule_r5_dormant_wake',
    priority: 'low',
    match: (p, now) => {
      if (p.stage !== 'dormant') return false
      const lastContact = p.last_contact_at ?? 0
      const silentDays = (now - lastContact) / DAY_SEC
      return silentDays >= 30 && silentDays <= 90
    },
    title: (p, days) => `唤醒：${p.display_name || '未知'}，沉默${Math.floor(days)}天，之前有过沟通`
  },
  {
    id: 'rule_r6_consider_drop',
    priority: 'info',
    match: (p, now) => {
      // 30 天内第 3 次触发 R4/R5 → 建议放弃
      if (!['contacted', 'dormant'].includes(p.stage ?? '')) return false
      const lastContact = p.last_contact_at ?? 0
      const silentDays = (now - lastContact) / DAY_SEC
      if (silentDays < 30) return false
      // 检查历史任务次数
      const recentTasks = salesDbService.todoList({ session_id: p.session_id, limit: 10 })
      const r4r5Count = recentTasks.filter(t =>
        (t.trigger_type === 'rule_r4_contacted_silent' || t.trigger_type === 'rule_r5_dormant_wake') &&
        t.created_at >= Date.now() - 30 * 24 * 60 * 60 * 1000
      ).length
      return r4r5Count >= 2
    },
    title: (p, days) => `考虑放弃：${p.display_name || '未知'}，多次跟进无响应（${Math.floor(days)}天）`
  }
]

// ─── 引擎核心 ─────────────────────────────────────────────────────────────────

let configRef: ConfigService | null = null
let lastFullScanAt = 0
let scanTimer: NodeJS.Timeout | null = null

export function setActionEngineConfig(config: ConfigService): void {
  configRef = config
}

/**
 * 启动定时全量扫描（每天 08:00）
 */
export function startActionEngineScheduler(): void {
  if (scanTimer) return
  // 每 30 分钟检查一次是否到了扫描时间
  scanTimer = setInterval(() => {
    const now = new Date()
    const hours = now.getHours()
    const minutes = now.getMinutes()
    // 08:00-08:30 窗口内且今天还没扫过
    if (hours === 8 && minutes < 30) {
      const todayStart = new Date(now)
      todayStart.setHours(0, 0, 0, 0)
      if (lastFullScanAt < todayStart.getTime()) {
        salesLogger.info('[ActionEngine] 触发每日全量扫描')
        enqueueSalesTask(() => runFullScan()).catch(e => {
          salesLogger.error(`[ActionEngine] 全量扫描失败: ${e}`)
        })
      }
    }
  }, 30 * 60 * 1000)
}

export function stopActionEngineScheduler(): void {
  if (scanTimer) { clearInterval(scanTimer); scanTimer = null }
}

/**
 * 全量扫描：遍历所有客户，应用规则生成今日任务。
 * 在 salesQueue 内执行（调用方负责 enqueue）。
 */
export async function runFullScan(): Promise<{ generated: number }> {
  const nowSec = Math.floor(Date.now() / 1000)
  const nowMs = Date.now()
  const customers = salesDbService.customerAll()
  let generated = 0

  salesLogger.info(`[ActionEngine] 全量扫描开始，客户数: ${customers.length}`)

  for (const customer of customers) {
    if (generated >= DAILY_LIMIT) break

    const lastContact = customer.last_contact_at ?? 0
    const silentDays = (nowSec - lastContact) / DAY_SEC

    for (const rule of RULES) {
      if (generated >= DAILY_LIMIT) break

      try {
        if (!rule.match(customer, nowSec)) continue

        // 去重：24h 内同客户同规则不重复
        if (salesDbService.hasRecentTask(customer.session_id, rule.id, nowMs - DEDUP_WINDOW_MS)) continue

        // 生成任务
        const title = rule.title(customer, silentDays)
        salesDbService.todoCreate({
          session_id: customer.session_id,
          display_name: customer.display_name ?? null,
          trigger_type: rule.id,
          title,
          status: 'pending',
          priority_score: PRIORITY_WEIGHT[rule.priority] + Math.min(silentDays, 30),
          created_by: 'action_engine'
        })
        generated++
      } catch (e) {
        salesLogger.warn(`[ActionEngine] 规则 ${rule.id} 对客户 ${customer.session_id} 执行失败: ${e}`)
      }
    }
  }

  lastFullScanAt = nowMs
  salesLogger.info(`[ActionEngine] 全量扫描完成，生成 ${generated} 条任务`)
  return { generated }
}

/**
 * 增量检查：新消息到达后对单个客户重新评估。
 * 由 DB monitor 回调触发。
 */
export async function onNewMessage(sessionId: string, displayName: string): Promise<void> {
  if (!configRef) return

  return enqueueSalesTask(async () => {
    try {
      // 1. 拉取最近消息
      const msgResult = await wcdbService.getMessages(sessionId, 10, 0)
      if (!msgResult?.success || !msgResult.messages?.length) return

      // 2. AI 阶段分类
      const snippets = toMessageSnippets(msgResult.messages)
      if (snippets.length === 0) return

      const classification = await classifyStage(configRef!, snippets)
      if (!classification) return

      // 3. 持久化（阶段变化时写入）
      persistClassification(sessionId, displayName, classification)

      // 4. 增量规则检查（只检查紧急规则 R3）
      const nowSec = Math.floor(Date.now() / 1000)
      const nowMs = Date.now()
      const profile = salesDbService.customerGetBySession(sessionId)
      if (!profile) return

      const r3 = RULES.find(r => r.id === 'rule_r3_new_no_reply')!
      if (r3.match(profile, nowSec)) {
        if (!salesDbService.hasRecentTask(sessionId, r3.id, nowMs - DEDUP_WINDOW_MS)) {
          const silentDays = (nowSec - (profile.last_contact_at ?? 0)) / DAY_SEC
          salesDbService.todoCreate({
            session_id: sessionId,
            display_name: displayName || null,
            trigger_type: r3.id,
            title: r3.title(profile, silentDays),
            status: 'pending',
            priority_score: PRIORITY_WEIGHT[r3.priority] + 10,
            created_by: 'action_engine'
          })
          salesLogger.info(`[ActionEngine] 增量触发 R3: ${displayName}`)
        }
      }
    } catch (e) {
      salesLogger.warn(`[ActionEngine] onNewMessage 处理失败 ${sessionId}: ${e}`)
    }
  })
}

// ─── 今日行动查询 ─────────────────────────────────────────────────────────────

/**
 * 获取今日行动清单（供前端 IPC 调用）。
 * 如果今天还没生成过任务，先触发一次全量扫描。
 */
export async function getTodayActions(): Promise<TodayActionResult> {
  const nowMs = Date.now()
  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)
  const todayStartMs = todayStart.getTime()

  // 如果今天还没扫描过，先跑一次
  if (lastFullScanAt < todayStartMs) {
    await enqueueSalesTask(() => runFullScan())
  }

  // 查询所有 pending 任务（按 priority_score 降序）
  const pendingTasks = salesDbService.todoList({ status: 'pending', limit: 50 })

  // 过滤出今天生成的 + 之前遗留的 pending
  const actionItems: ActionItem[] = pendingTasks
    .sort((a, b) => (b.priority_score ?? 0) - (a.priority_score ?? 0))
    .slice(0, DAILY_LIMIT)
    .map(task => {
      const nowSec = Math.floor(nowMs / 1000)
      const profile = task.session_id ? salesDbService.customerGetBySession(task.session_id) : undefined
      const lastContact = profile?.last_contact_at ?? 0
      const silentDays = Math.max(0, Math.floor((nowSec - lastContact) / DAY_SEC))

      return {
        id: task.id,
        sessionId: task.session_id ?? '',
        displayName: task.display_name ?? '未知客户',
        stage: profile?.stage ?? 'unknown',
        triggerType: task.trigger_type,
        title: task.title,
        reason: buildReason(task.trigger_type, silentDays),
        suggestion: '',  // AI 建议后续异步填充
        priority: scoreToPriority(task.priority_score ?? 0),
        priorityScore: task.priority_score ?? 0,
        silentDays,
        createdAt: task.created_at,
        status: task.status
      }
    })

  // 统计数字
  const allCustomers = salesDbService.customerAll()
  const weekStartMs = getWeekStartMs()
  const stats = {
    todayPending: actionItems.length,
    overdue: pendingTasks.filter(t => t.due_at && t.due_at < nowMs).length,
    newThisWeek: allCustomers.filter(c => c.created_at >= weekStartMs).length,
    pipelineTotal: allCustomers.filter(c => !['won', 'lost'].includes(c.stage ?? '')).length
  }

  return { items: actionItems, stats, generatedAt: nowMs }
}

/**
 * 为行动项生成 AI 建议话术（异步，可选）。
 */
export async function generateSuggestion(actionItem: ActionItem): Promise<string> {
  if (!configRef || !isAiConfigured(configRef)) return ''

  try {
    // 从知识库检索相关产品/话术上下文
    const knowledgeContext = salesKnowledgeService.buildKnowledgeContext(
      `${actionItem.title} ${actionItem.displayName} ${actionItem.stage}`,
      1500,
      2
    )

    const knowledgeSection = knowledgeContext
      ? `\n\n相关产品信息（可引用）：\n${knowledgeContext}`
      : ''

    const prompt = `你是叉车/仓储设备销售顾问。客户"${actionItem.displayName}"当前阶段：${actionItem.stage}，已沉默${actionItem.silentDays}天。
任务：${actionItem.title}${knowledgeSection}

请用1-2句话给出一条跟进建议话术（直接可以发给客户的），口语化，不要太正式。如果有相关产品参数可以自然带入。`

    return await simpleCompletion(configRef, '你是一个销售话术助手，输出简短实用的跟进话术。', prompt, {
      temperature: 0.7,
      maxTokens: 200,
      disableThinking: true,
      timeoutMs: 15_000
    })
  } catch {
    return ''
  }
}

/**
 * 完成/跳过行动项。
 */
export function completeAction(taskId: number, action: 'done' | 'skipped'): void {
  const now = Date.now()
  if (action === 'done') {
    salesDbService.todoUpdate(taskId, { status: 'done', completed_at: now })
  } else {
    salesDbService.todoUpdate(taskId, { status: 'skipped' })
  }
}

// ─── 辅助函数 ─────────────────────────────────────────────────────────────────

function buildReason(triggerType: string, silentDays: number): string {
  const reasons: Record<string, string> = {
    'rule_r3_new_no_reply': `新客户${silentDays}天未实质沟通`,
    'rule_r1_quoted_followup': `报价后${silentDays}天无回复`,
    'rule_r2_negotiating_stall': `谈判中${silentDays}天无进展`,
    'rule_r4_contacted_silent': `沟通后${silentDays}天未联系`,
    'rule_r5_dormant_wake': `沉默${silentDays}天，曾有沟通`,
    'rule_r6_consider_drop': `多次跟进无响应（${silentDays}天）`
  }
  return reasons[triggerType] || `${silentDays}天未互动`
}

function scoreToPriority(score: number): 'urgent' | 'high' | 'medium' | 'low' | 'info' {
  if (score >= 100) return 'urgent'
  if (score >= 80) return 'high'
  if (score >= 60) return 'medium'
  if (score >= 40) return 'low'
  return 'info'
}

function getWeekStartMs(): number {
  const d = new Date()
  const day = d.getDay() || 7
  d.setDate(d.getDate() - day + 1)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}
