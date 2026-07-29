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

import { ConfigService } from './config'
import { salesDbService, type CustomerProfile, type FollowUpTask } from './salesDbService'
import { salesLog } from './salesLogger'
import { wcdbService } from './wcdbService'
import { enqueueSalesTask } from './salesQueue'
import { classifyStage, toMessageSnippets, persistClassification, type CustomerStage } from './salesStageClassifier'
import { simpleCompletion, isAiConfigured } from './ai/aiApiClient'
import { salesKnowledgeService } from './salesKnowledgeService'

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
  archiveCandidates: ActionItem[]
  stats: {
    todayPending: number
    overdue: number
    newThisWeek: number
    pipelineTotal: number
    r6Count: number
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
      if (lastContact === 0) return false  // 未记录互动时间，跳过
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
      if (lastContact === 0) return false
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
      if (lastContact === 0) return false
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
      if (lastContact === 0) return false
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
      if (lastContact === 0) return false
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
        (t.created_at ?? 0) >= Date.now() - 30 * 24 * 60 * 60 * 1000
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
        salesLog('INFO', '[ActionEngine] 触发每日全量扫描')
        enqueueSalesTask(() => runFullScan()).catch(e => {
          salesLog('ERROR', `[ActionEngine] 全量扫描失败: ${e}`)
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
 *
 * v3 优化：
 * - 客户级去重：同客户命中多条规则时只保留优先级分数最高的一条
 * - R6 独立：不占用主队列 15 条名额，单独落库
 */
export async function runFullScan(): Promise<{ generated: number; r6Generated: number }> {
  const nowSec = Math.floor(Date.now() / 1000)
  const nowMs = Date.now()
  const customers = salesDbService.customerAll()

  salesLog('INFO', `[ActionEngine] 全量扫描开始，客户数: ${customers.length}`)

  // Phase 1: 收集候选（内存去重：同客户只保留最高分）
  interface Candidate {
    sessionId: string
    displayName: string
    ruleId: string
    title: string
    score: number
    priority: string
  }
  const customerBest = new Map<string, Candidate>()   // R1-R5 候选
  const r6Candidates: Candidate[] = []                 // R6 独立候选

  for (const customer of customers) {
    const lastContact = customer.last_contact_at ?? 0
    const silentDays = (nowSec - lastContact) / DAY_SEC

    for (const rule of RULES) {
      try {
        if (!rule.match(customer, nowSec)) continue
        // 24h 内同客户同规则不重复
        if (salesDbService.hasRecentTask(customer.session_id, rule.id, nowMs - DEDUP_WINDOW_MS)) continue

        const score = PRIORITY_WEIGHT[rule.priority] + Math.min(silentDays, 30)
        const cand: Candidate = {
          sessionId: customer.session_id,
          displayName: customer.display_name ?? '未知',
          ruleId: rule.id,
          title: rule.title(customer, silentDays),
          score,
          priority: rule.priority
        }

        if (rule.id === 'rule_r6_consider_drop') {
          // R6 独立收集，不参与主队列客户级去重
          r6Candidates.push(cand)
        } else {
          // R1-R5：同客户只保留最高分
          const existing = customerBest.get(customer.session_id)
          if (!existing || score > existing.score) {
            customerBest.set(customer.session_id, cand)
          }
        }
      } catch (e) {
        salesLog('WARN', `[ActionEngine] 规则 ${rule.id} 对客户 ${customer.session_id} 执行失败: ${e}`)
      }
    }
  }

  // Phase 2: 排序 + 截断（≤DAILY_LIMIT，仅 R1-R5）
  const sorted = [...customerBest.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, DAILY_LIMIT)

  // Phase 3: 落库（R1-R5 主队列）
  let generated = 0
  for (const cand of sorted) {
    salesDbService.todoCreate({
      session_id: cand.sessionId,
      display_name: cand.displayName || null,
      trigger_type: cand.ruleId,
      title: cand.title,
      status: 'pending',
      priority_score: cand.score,
      created_by: 'action_engine'
    })
    generated++
  }

  // Phase 4: 落库（R6 独立，不限名额）
  let r6Generated = 0
  for (const cand of r6Candidates) {
    salesDbService.todoCreate({
      session_id: cand.sessionId,
      display_name: cand.displayName || null,
      trigger_type: cand.ruleId,
      title: cand.title,
      status: 'pending',
      priority_score: cand.score,
      created_by: 'action_engine'
    })
    r6Generated++
  }

  lastFullScanAt = nowMs
  salesLog('INFO', `[ActionEngine] 全量扫描完成，候选 ${customerBest.size} 客户，生成 ${generated} 条任务，R6 ${r6Generated} 条`)
  return { generated, r6Generated }
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

      const classification = await classifyStage(configRef!, snippets, sessionId)
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
          salesLog('INFO', `[ActionEngine] 增量触发 R3: ${displayName}`)
        }
      }
    } catch (e) {
      salesLog('WARN', `[ActionEngine] onNewMessage 处理失败 ${sessionId}: ${e}`)
    }
  })
}

// ─── 懒扫描 ────────────────────────────────────────────────────────────────────

/** 懒扫描目标规则：R1/R2/R4/R5 (R3 有新消息增量，R6 走独立清理) */
const LAZY_SCAN_RULE_IDS = ['rule_r1_quoted_followup', 'rule_r2_negotiating_stall', 'rule_r4_contacted_silent', 'rule_r5_dormant_wake']

/**
 * 首页打开时轻量增量检查：弥补 08:00 全量扫描后到下次打开首页之间的发现延迟。
 * 只检查 R1/R2/R4/R5 中"已越过阈值但今日尚未生成任务"的客户，不做 AI 阶段分类。
 */
async function lazyScan(): Promise<number> {
  const nowSec = Math.floor(Date.now() / 1000)
  const nowMs = Date.now()
  const todayStartMs = new Date()
  todayStartMs.setHours(0, 0, 0, 0)

  // 仅取 R1/R2/R4/R5 关心的阶段
  const targetStages = new Set(['quoted', 'negotiating', 'contacted', 'dormant'])
  const customers = salesDbService.customerAll().filter(c => targetStages.has(c.stage ?? ''))

  if (customers.length === 0) return 0

  const lazyRules = RULES.filter(r => LAZY_SCAN_RULE_IDS.includes(r.id))
  let generated = 0

  for (const customer of customers) {
    // 已有今日 pending 任务则跳过（不限规则类型，同客户同天有任一 pending 即跳过）
    const existingToday = salesDbService.todoList({ status: 'pending', session_id: customer.session_id, limit: 3 })
    const hasTaskToday = existingToday.some(t => (t.created_at ?? 0) >= todayStartMs)
    if (hasTaskToday) continue

    const lastContact = customer.last_contact_at ?? 0
    const silentDays = (nowSec - lastContact) / DAY_SEC

    for (const rule of lazyRules) {
      try {
        if (!rule.match(customer, nowSec)) continue
        if (salesDbService.hasRecentTask(customer.session_id, rule.id, nowMs - DEDUP_WINDOW_MS)) continue

        const score = PRIORITY_WEIGHT[rule.priority] + Math.min(silentDays, 30)
        salesDbService.todoCreate({
          session_id: customer.session_id,
          display_name: customer.display_name ?? null,
          trigger_type: rule.id,
          title: rule.title(customer, silentDays),
          status: 'pending',
          priority_score: score,
          created_by: 'action_engine'
        })
        generated++
        break // 一个客户在懒扫描中只生成一条任务
      } catch (e) {
        salesLog('WARN', `[ActionEngine] 懒扫描 ${rule.id} 对客户 ${customer.session_id} 失败: ${e}`)
      }
    }
  }

  if (generated > 0) {
    salesLog('INFO', `[ActionEngine] 懒扫描完成，补充生成 ${generated} 条任务`)
  }
  return generated
}

// ─── 今日行动查询 ─────────────────────────────────────────────────────────────

/**
 * 获取今日行动清单（供前端 IPC 调用）。
 * 如果今天还没生成过任务，先触发全量扫描 + 懒扫描补充。
 */
export async function getTodayActions(): Promise<TodayActionResult> {
  // 容错：数据库尚未初始化时返回空结果（启动时序竞争）
  if (!salesDbService.isInitialized()) {
    return { items: [], archiveCandidates: [], stats: { todayPending: 0, overdue: 0, newThisWeek: 0, pipelineTotal: 0, r6Count: 0 }, generatedAt: Date.now() }
  }

  const nowMs = Date.now()
  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)
  const todayStartMs = todayStart.getTime()

  // 如果今天还没扫描过，先跑一次全量 + 懒扫描补充
  if (lastFullScanAt < todayStartMs) {
    await enqueueSalesTask(() => runFullScan())
  }
  // 懒扫描：无论是否刚跑完全量，都补扫一次（填补 08:00 后的增量窗口）
  await enqueueSalesTask(() => lazyScan())

  // 查询所有 pending 任务
  const pendingTasks = salesDbService.todoList({ status: 'pending', limit: 100 })

  // 分离 R6 与主队列（R6 不参与 DAILY_LIMIT 主队列竞争）
  const mainPending = pendingTasks.filter(t => t.trigger_type !== 'rule_r6_consider_drop')
  const r6Pending = pendingTasks.filter(t => t.trigger_type === 'rule_r6_consider_drop')

  // 主队列：排序 + 截断 + 映射
  const actionItems: ActionItem[] = mainPending
    .sort((a, b) => (b.priority_score ?? 0) - (a.priority_score ?? 0))
    .slice(0, DAILY_LIMIT)
    .map(task => mapTaskToActionItem(task, nowMs))

  // R6 清理候选：独立列表，不限名额
  const archiveCandidates: ActionItem[] = r6Pending
    .sort((a, b) => (b.priority_score ?? 0) - (a.priority_score ?? 0))
    .map(task => mapTaskToActionItem(task, nowMs))

  // 统计数字
  const allCustomers = salesDbService.customerAll()
  const weekStartMs = getWeekStartMs()
  const stats = {
    todayPending: actionItems.length,
    overdue: pendingTasks.filter(t => t.due_at && t.due_at < nowMs).length,
    newThisWeek: allCustomers.filter(c => (c.created_at ?? 0) >= weekStartMs).length,
    pipelineTotal: allCustomers.filter(c => !['won', 'lost'].includes(c.stage ?? '')).length,
    r6Count: r6Pending.length
  }

  return { items: actionItems, archiveCandidates, stats, generatedAt: nowMs }
}

/**
 * 结构化深度分析结果（对齐 wechat-crm deep_analysis.py 框架）。
 */
export interface ActionAnalysisResult {
  whyNow: string
  opportunity: string
  riskSignal: string
  script: string
  nextMove: string
  /** 非空时表示降级：聊天记录不足等 */
  degradationNote?: string
  error?: string
  notConfigured?: boolean
}

/** WCDB 消息缓存：60 秒内同 session 复用 */
const msgCache = new Map<string, { msgs: string; ts: number }>()
const MSG_CACHE_TTL_MS = 60_000
const MIN_MSGS_FOR_ANALYSIS = 5
const MAX_MSGS_FOR_ANALYSIS = 50
const MSG_WINDOW_DAYS = 30

/**
 * 获取客户近期聊天记录（带 60s 内存缓存）。
 */
async function fetchRecentMessages(sessionId: string): Promise<string> {
  const cached = msgCache.get(sessionId)
  if (cached && (Date.now() - cached.ts) < MSG_CACHE_TTL_MS) {
    return cached.msgs
  }

  try {
    const result = await wcdbService.getMessages(sessionId, MAX_MSGS_FOR_ANALYSIS, 0)
    if (!result?.success || !result.messages?.length) {
      const empty = ''
      msgCache.set(sessionId, { msgs: empty, ts: Date.now() })
      return empty
    }

    // 取最近 50 条，按时间升序拼接
    const nowSec = Math.floor(Date.now() / 1000)
    const cutoffSec = nowSec - MSG_WINDOW_DAYS * DAY_SEC
    const recent = result.messages
      .filter((m: any) => {
        const ts = m.createTime || m.create_time || m.msg_time || 0
        return ts >= cutoffSec
      })
      .slice(-MAX_MSGS_FOR_ANALYSIS)
      .map((m: any) => {
        const ts = m.createTime || m.create_time || m.msg_time || 0
        const timeStr = ts ? new Date(ts * 1000).toISOString().slice(0, 16) : '?'
        const content = (m.content || m.msg || '').slice(0, 200)
        return `[${timeStr}] ${content}`
      })
      .join('\n')

    msgCache.set(sessionId, { msgs: recent, ts: Date.now() })
    return recent
  } catch (e) {
    salesLog('WARN', `[ActionEngine] WCDB 消息获取失败 ${sessionId}: ${e}`)
    return ''
  }
}

/**
 * 生成结构化深度分析（替代原 generateSuggestion）。
 *
 * 对齐 wechat-crm deep_analysis.py 框架，输出 5 字段：
 * whyNow / opportunity / riskSignal / script / nextMove。
 * 聊天记录不足（<5条）时诚实降级，不硬编。
 */
export async function generateActionAnalysis(actionItem: ActionItem): Promise<ActionAnalysisResult> {
  if (!configRef || !isAiConfigured(configRef)) {
    return { whyNow: '', opportunity: '', riskSignal: '', script: '', nextMove: '', notConfigured: true, error: 'AI 模型未配置' }
  }

  try {
    // 并行获取：WCDB 聊天记录 + 知识库检索
    const [chatHistory, knowledgeContext] = await Promise.all([
      fetchRecentMessages(actionItem.sessionId),
      Promise.resolve(salesKnowledgeService.buildKnowledgeContext(
        `${actionItem.title} ${actionItem.displayName} ${actionItem.stage}`,
        1500,
        2
      ))
    ])

    const msgCount = chatHistory ? chatHistory.split('\n').filter(l => l.trim()).length : 0
    const isLowData = msgCount < MIN_MSGS_FOR_ANALYSIS

    const knowledgeSection = knowledgeContext
      ? `\n\n【相关产品信息】\n${knowledgeContext}`
      : ''

    const chatSection = chatHistory
      ? `\n\n【近期聊天记录（近${MSG_WINDOW_DAYS}天，${msgCount}条）】\n${chatHistory}`
      : '\n\n【近期聊天记录】无（WCDB 未连接或无记录）'

    const degradationNote = isLowData
      ? '\n\n⚠️ 聊天记录较少（<5条），opportunity 和 riskSignal 字段如无法从对话中推断，请输出"聊天记录不足，暂无法判断"。script 和 nextMove 仍可基于客户阶段和知识库正常生成。'
      : ''

    const systemPrompt = `你是经验丰富的工业品 B2B 销售助理（叉车/仓储设备领域）。分析微信聊天记录，给出结构化销售建议。严格依据对话内容，不臆测。必须返回 JSON。`

    const userPrompt = `客户：${actionItem.displayName}
当前阶段：${actionItem.stage}
已沉默：${actionItem.silentDays} 天
触发任务：${actionItem.title}
触发原因：${actionItem.reason}${knowledgeSection}${chatSection}${degradationNote}

请返回 JSON（不要包含其他文字）：
{
  "whyNow": "为什么现在是行动窗口（1-2句，紧迫性）",
  "opportunity": "这个机会有多大（1-2句，成交可能性与价值判断）",
  "riskSignal": "风险信号（1-2句，最大的1-2个风险点；聊天不足则写'聊天记录不足，暂无法判断'）",
  "script": "适合微信发送的跟进话术，口语化自然，不超过100字",
  "nextMove": "下一步最优动作（一句话）"
}`

    const text = await simpleCompletion(configRef, systemPrompt, userPrompt, {
      temperature: 0.3,
      maxTokens: 800,
      responseFormatJson: true,
      disableThinking: true,
      timeoutMs: 20_000
    })

    // 解析 JSON 输出
    let parsed: any
    try {
      parsed = JSON.parse(text || '{}')
    } catch {
      // 容错：尝试从文本中提取 JSON
      const jsonMatch = (text || '').match(/\{[\s\S]*\}/)
      parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {}
    }

    return {
      whyNow: parsed.whyNow || buildReason(actionItem.triggerType, actionItem.silentDays),
      opportunity: parsed.opportunity || (isLowData ? '聊天记录不足，暂无法判断' : ''),
      riskSignal: parsed.riskSignal || (isLowData ? '聊天记录不足，暂无法判断' : ''),
      script: parsed.script || '',
      nextMove: parsed.nextMove || '',
      degradationNote: isLowData ? '聊天记录较少，分析可能不完整' : undefined
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    salesLog('ERROR', `[ActionEngine] generateActionAnalysis 失败: ${msg}`)
    return {
      whyNow: buildReason(actionItem.triggerType, actionItem.silentDays),
      opportunity: '', riskSignal: '', script: '', nextMove: '',
      error: msg.slice(0, 80)
    }
  }
}

/** @deprecated 保留旧函数作为兼容，内部转发到 generateActionAnalysis */
export async function generateSuggestion(actionItem: ActionItem): Promise<{ suggestion: string; error?: string; notConfigured?: boolean }> {
  const result = await generateActionAnalysis(actionItem)
  return {
    suggestion: result.script || result.nextMove || result.whyNow || '',
    error: result.error,
    notConfigured: result.notConfigured
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

function mapTaskToActionItem(task: FollowUpTask, nowMs: number): ActionItem {
  const nowSec = Math.floor(nowMs / 1000)
  const profile = task.session_id ? salesDbService.customerGetBySession(task.session_id) : undefined
  const lastContact = profile?.last_contact_at ?? 0
  const effectiveContact = lastContact > 0 ? lastContact : (profile?.created_at ? Math.floor((profile.created_at) / 1000) : nowSec)
  const silentDays = Math.max(0, Math.floor((nowSec - effectiveContact) / DAY_SEC))

  return {
    id: task.id ?? 0,
    sessionId: task.session_id ?? '',
    displayName: task.display_name ?? '未知客户',
    stage: profile?.stage ?? 'unknown',
    triggerType: task.trigger_type,
    title: task.title,
    reason: buildReason(task.trigger_type, silentDays),
    suggestion: '',
    priority: scoreToPriority(task.priority_score ?? 0),
    priorityScore: task.priority_score ?? 0,
    silentDays,
    createdAt: task.created_at ?? 0,
    status: task.status ?? 'pending'
  }
}

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
