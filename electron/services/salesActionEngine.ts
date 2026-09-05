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
import { classifyStage, toMessageSnippets, persistClassification, extractEvidence, type CustomerStage } from './salesStageClassifier'
import { chatService } from './chatService'
import { simpleCompletion, isAiConfigured } from './ai/aiApiClient'
import { salesKnowledgeService } from './salesKnowledgeService'
import { crmDbService } from './crmDbService'
import { scanLeadSla } from './crmLeadService'
import { runAftersalesScan } from './crmAftersalesService'
import { normalizeStage } from '../../shared/salesStage'
import { persistActionAnalysisJudgments } from './salesActionAnalysisJudgment'
import { computeActivityState } from '../../shared/canonicalState'
import { getCustomerCurrentView, type CustomerCurrentView } from './customerCurrentView'
export { normalizeStage }

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
  /** 预热生成的五字段分析（JSON 字符串，AIActionCard 直接渲染） */
  analysis?: string
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
    highPriorityCount: number
    riskCustomerCount: number
    activeDeals: number
  }
  generatedAt: number
}

// ─── 统一信号流类型 ────────────────────────────────────────────────────────────

export type SignalSource =
  | { type: 'task'; ruleCode: string; label: string; reason: string; rawTaskId: number }

export interface UnifiedSignal {
  sessionId: string
  displayName: string
  stage: string
  silentDays: number
  sources: SignalSource[]
  priorityScore: number
  urgencyTier: 'urgent' | 'high' | 'normal'
  status: string
  /** 预热生成的五字段分析（JSON 字符串）——任务自身的历史快照，不再作为当前判断消费 */
  analysis?: string
  /** P0-3.4：当前 AI 判断投影（系统已形成的当前视图；无客户/虚拟卡为 null） */
  judgments?: CustomerCurrentView['judgments'] | null
}

export interface UnifiedStats {
  totalSignals: number
  taskOnly: number
  insightOnly: number
  merged: number
  urgentCount: number
  highPriorityCount: number
  riskCustomerCount: number
  activeDeals: number
  todayPending: number
}

export interface UnifiedResult {
  signals: UnifiedSignal[]
  stats: UnifiedStats
  generatedAt: number
}


// ─── 常量 ────────────────────────────────────────────────────────────────────

const DAILY_LIMIT = 15
const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000 // 24h
const DAY_SEC = 86400

/** 最后联系时间（秒）：last_contact_at 优先，缺失回退 created_at，皆无为 0。
 *  唯一口径源：六条规则 match、全量扫描、懒扫描、R3 增量共用，
 *  杜绝「match 用回退值、title 用裸值」的口径漂移（线上 20689 天 bug）。 */
export function lastContactSec(p: CustomerProfile): number {
  return p.last_contact_at || (p.created_at ? Math.floor(p.created_at / 1000) : 0)
}

const PRIORITY_WEIGHT: Record<string, number> = {
  urgent: 100,
  high: 80,
  medium: 60,
  low: 40,
  info: 20
}

// 阶段加分：高意向推进中 > 已沟通 > 新客 > 沉默。
// 范围 0-12：可压过沉默天数(0-30)的一半，但不推翻规则优先级(级差20)。
const STAGE_BONUS: Record<string, number> = {
  negotiating: 12,
  quoted: 8,
  contacted: 5,
  new: 2,
  unknown: 2,
  dormant: 0
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
    id: 'rule_r0_unknown_followup',
    priority: 'medium',
    match: (p, now) => {
      // 兜底：标准化后仍为 unknown/new 的客户沉默 ≥ 2 天即触发
      const stage = normalizeStage(p.stage)
      if (!['unknown', 'new'].includes(stage)) return false
      const lastContact = lastContactSec(p)
      if (lastContact === 0) return false
      const silentDays = (now - lastContact) / DAY_SEC
      return silentDays >= 2
    },
    title: (p, days) => `待确认意向：${p.display_name || '未知'}，${Math.floor(days)}天未互动`
  },
  {
    id: 'rule_r3_new_no_reply',
    priority: 'urgent',
    match: (p, now) => {
      if (normalizeStage(p.stage) !== 'new') return false
      const lastContact = lastContactSec(p)
      if (lastContact === 0) return false
      const silentDays = (now - lastContact) / DAY_SEC
      return silentDays >= 1
    },
    title: (p, days) => `新客响应：${p.display_name || '未知'}，${Math.floor(days)}天前加了微信还没实质沟通`
  },
  {
    id: 'rule_r1_quoted_followup',
    priority: 'high',
    match: (p, now) => {
      if (normalizeStage(p.stage) !== 'quoted') return false
      const lastContact = lastContactSec(p)
      if (lastContact === 0) return false
      const silentDays = (now - lastContact) / DAY_SEC
      return silentDays >= 2
    },
    title: (p, days) => `报价跟进：${p.display_name || '未知'}，已报价${Math.floor(days)}天没回复`
  },
  {
    id: 'rule_r2_negotiating_stall',
    priority: 'high',
    match: (p, now) => {
      if (normalizeStage(p.stage) !== 'negotiating') return false
      const lastContact = lastContactSec(p)
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
      if (normalizeStage(p.stage) !== 'contacted') return false
      const lastContact = lastContactSec(p)
      if (lastContact === 0) return false
      const silentDays = (now - lastContact) / DAY_SEC
      return silentDays >= 5
    },
    title: (p, days) => `激活沉默：${p.display_name || '未知'}，聊过产品但${Math.floor(days)}天没联系了`
  },
  {
    id: 'rule_r5_dormant_wake',
    priority: 'low',
    match: (p, now) => {
      // dormant 是 activityState（P0-2A 拆出），规则显式读状态而非 stage
      // 已成交/流失不唤醒（原 stage==='dormant' 天然排除，拆出后显式守卫，与 runFullScan won/lost 跳过一致）
      const stage = normalizeStage(p.stage)
      if (['won', 'lost'].includes(stage)) return false
      if (computeActivityState(p.stage, p.last_contact_at, now) !== 'dormant') return false
      const lastContact = lastContactSec(p)
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
      // 30 天内第 3 次触发 R4/R5 → 建议放弃（contacted 走 stage，dormant 走 activityState）
      // 已成交/流失不触发（原 ['contacted','dormant'] 天然排除，拆出后显式守卫）
      const stage = normalizeStage(p.stage)
      if (['won', 'lost'].includes(stage)) return false
      if (stage !== 'contacted' && computeActivityState(p.stage, p.last_contact_at, now) !== 'dormant') return false
      const lastContact = lastContactSec(p)
      if (lastContact === 0) return false
      const silentDays = (now - lastContact) / DAY_SEC
      if (silentDays < 30) return false
      // 检查历史任务次数：只看「未完成的」R4/R5 任务
      // （done/skipped/followed_ai = 跟了没效果的不该算；superseded = 被重扫顶掉，非用户行为）
      const recentTasks = salesDbService.todoList({ session_id: p.session_id, limit: 10 })
      const DONE_STATUS = new Set(['done', 'skipped', 'followed_ai', 'superseded'])
      const r4r5Count = recentTasks.filter(t =>
        (t.trigger_type === 'rule_r4_contacted_silent' || t.trigger_type === 'rule_r5_dormant_wake') &&
        !DONE_STATUS.has(t.status ?? '') &&
        (t.created_at ?? 0) >= Date.now() - 30 * 24 * 60 * 60 * 1000
      ).length
      return r4r5Count >= 2
    },
    title: (p, days) => `考虑放弃：${p.display_name || '未知'}，多次跟进无响应（${Math.floor(days)}天）`
  }
]

/** 测试/诊断用：按 id 取规则（如 scripts/action-rules-test.ts） */
export function getActionRule(id: string): Rule | undefined {
  return RULES.find((r) => r.id === id)
}

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

  // 清理所有 action_engine 生成的 pending 任务（幂等重扫，含历史遗留）
  // 已到期的 → overdue 保留（跨天积累：欠着的跟进不能每天消失）
  // 未到期/无 due 的 → superseded（今天重新计算）
  const staleTasks = salesDbService.todoList({ status: 'pending', limit: 500 })
    .filter(t => t.created_by === 'action_engine')
  let overdueCount = 0
  for (const t of staleTasks) {
    if (!t.id) continue
    const due = Number(t.due_at || 0)
    if (due > 0 && due <= nowMs) {
      salesDbService.todoUpdate(t.id, { status: 'overdue' })
      overdueCount++
    } else {
      salesDbService.todoUpdate(t.id, { status: 'superseded' })
    }
  }
  if (staleTasks.length > 0) {
    salesLog('INFO', `[ActionEngine] 清理 ${staleTasks.length} 条旧 pending 任务（overdue ${overdueCount}，superseded ${staleTasks.length - overdueCount}）`)
  }

  // 一次性修复：清理被 InsightService 错误设置的 last_contact_at
  // 如果 last_contact_at 在最近4小时内，但 created_at 是1天前的 → 被错误设置，重置为 null
  const fourHoursAgoSec = nowSec - 14400
  let fixedCount = 0
  for (const c of customers) {
    if (c.last_contact_at && c.last_contact_at > fourHoursAgoSec) {
      const createdSec = c.created_at ? Math.floor(c.created_at / 1000) : 0
      if (createdSec > 0 && (nowSec - createdSec) > 86400) {
        c.last_contact_at = null
        salesDbService.customerUpsert({ session_id: c.session_id, last_contact_at: null as any })
        fixedCount++
      }
    }
  }
  if (fixedCount > 0) {
    salesLog('INFO', `[ActionEngine] 修复 ${fixedCount} 个被错误设置的 last_contact_at`)
  }

  salesLog('INFO', `[ActionEngine] 全量扫描开始，客户数: ${customers.length}`)
  // 调试：stage 分布（标准化后）
  const stageDist: Record<string, number> = {}
  for (const c of customers) { const s = normalizeStage(c.stage); stageDist[s] = (stageDist[s] || 0) + 1 }
  salesLog('INFO', `[ActionEngine] stage分布(标准化): ${JSON.stringify(stageDist)}`)
  // 调试：前3个客户的 last_contact_at
  for (const c of customers.slice(0, 3)) {
    const lc = c.last_contact_at || 0
    const ca = c.created_at ? Math.floor(c.created_at / 1000) : 0
    const eff = lc || ca
    const sd = eff > 0 ? Math.floor((nowSec - eff) / DAY_SEC) : -1
    salesLog('INFO', `[ActionEngine] debug ${c.display_name}: stage=${c.stage} lc=${lc} ca=${ca} silent=${sd}d`)
  }

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
    // 标准化阶段名（中文→英文），让规则能匹配
    customer.stage = normalizeStage(customer.stage)
    // 成交/流失客户直接跳过
    if (['won', 'lost'].includes(customer.stage)) continue
    const lastContact = lastContactSec(customer)
    const silentDays = lastContact > 0 ? (nowSec - lastContact) / DAY_SEC : 0
    // 沉默不足1天的跳过
    if (silentDays < 1) continue

    for (const rule of RULES) {
      try {
        if (!rule.match(customer, nowSec)) continue
        // 24h 内同客户同规则不重复
        if (salesDbService.hasRecentTask(customer.session_id, rule.id, nowMs - DEDUP_WINDOW_MS)) continue

        const score = PRIORITY_WEIGHT[rule.priority] + Math.min(silentDays, 30) + (STAGE_BONUS[customer.stage] ?? 0)
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

  // R7 报价跟进（事实驱动）：quote_signal 在 [24h, 7d] 窗口且客户未回复。
  // 不依赖 AI 阶段猜测——"我方发出过带金额的报价 + 客户没回"两个事实直接生成高优先级行动
  try {
    const quoteSignals = crmDbService.pendingQuoteFollowups(24, 7)
    for (const s of quoteSignals) {
      const ruleId = 'rule_r7_quote_followup'
      if (salesDbService.hasRecentTask(String(s.session_id), ruleId, nowMs - DEDUP_WINDOW_MS)) continue
      const hours = Math.max(1, Math.floor((nowMs - Number(s.quoted_at)) / 3600000))
      const ageLabel = hours >= 48 ? `${Math.floor(hours / 24)}天` : `${hours}小时`
      const cand: Candidate = {
        sessionId: String(s.session_id),
        displayName: String(s.display_name || '未知'),
        ruleId,
        title: `报价跟进：${s.display_name || '未知'}，${ageLabel}前报出 ¥${Number(s.amount || 0).toLocaleString()}${s.model ? `（${s.model}）` : ''}，客户还没回复`,
        score: PRIORITY_WEIGHT.high + 20 + Math.min(Math.floor(hours / 24), 7),
        priority: 'high'
      }
      const existing = customerBest.get(cand.sessionId)
      if (!existing || cand.score > existing.score) customerBest.set(cand.sessionId, cand)
    }
    if (quoteSignals.length) salesLog('INFO', `[ActionEngine] R7 报价跟进候选 ${quoteSignals.length} 条`)
  } catch (e) {
    salesLog('WARN', `[ActionEngine] R7 报价跟进收集失败: ${e}`)
  }

  // R8 物流跟进（事实驱动）：已发货超 crmLogisticsOverdueHours 小时未确认签收。
  // 照抄 R7 模式：不依赖 AI 阶段猜测——"物流发出 + 超过阈值未确认签收"两个事实直接生成提醒。
  // 统一用虚拟 sessionId logi:<logistics_id>（不区分是否已认领），保证不受沉默天数/阶段过滤。
  try {
    const overdueHours = Number(configRef?.get('crmLogisticsOverdueHours')) || 24
    const logiSignals = crmDbService.pendingLogisticsOverdue(overdueHours)
    for (const s of logiSignals) {
      const ruleId = 'rule_r8_logistics_overdue'
      const logiId = Number(s.id)
      const sid = `logi:${logiId}`
      if (salesDbService.hasRecentTask(sid, ruleId, nowMs - DEDUP_WINDOW_MS)) continue
      const elapsedHours = Math.max(1, Math.floor((nowMs - Number(s.latest_update_at || nowMs)) / 3600000))
      const name = String(s.customer_name || s.receiver || '未知')
      const owner = String(s.owner_sales || s.account_owner_sales || '')
      const cand: Candidate = {
        sessionId: sid,
        displayName: name,
        ruleId,
        title: `物流跟进：${String(s.brand || '')}（${name}），单号 ${String(s.tracking_no || '')}，发货超 ${elapsedHours} 小时未确认签收${owner ? `（负责：${owner}）` : ''}`,
        score: PRIORITY_WEIGHT.high + Math.min(Math.floor(elapsedHours / 24), 7),
        priority: 'high'
      }
      const existing = customerBest.get(cand.sessionId)
      if (!existing || cand.score > existing.score) customerBest.set(cand.sessionId, cand)
    }
    if (logiSignals.length) salesLog('INFO', `[ActionEngine] R8 物流超期候选 ${logiSignals.length} 条`)
  } catch (e) {
    salesLog('WARN', `[ActionEngine] R8 物流跟进收集失败: ${e}`)
  }

  // Phase 2: 排序 + 截断（≤DAILY_LIMIT，仅 R1-R5）
  const sorted = [...customerBest.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, DAILY_LIMIT)

  // Phase 3: 落库（R1-R5 主队列）
  let generated = 0
  const preheat: Array<{ id: number; cand: Candidate }> = []
  for (const cand of sorted) {
    const task = salesDbService.todoCreate({
      session_id: cand.sessionId,
      display_name: cand.displayName || null,
      trigger_type: cand.ruleId,
      title: cand.title,
      status: 'pending',
      priority_score: cand.score,
      created_by: 'action_engine'
    })
    // 收集 high/urgent 任务用于预热 AI 分析（前 8 条，避免批量扫描过慢）
    if ((cand.priority === 'high' || cand.priority === 'urgent') && preheat.length < 8 && task.id) {
      preheat.push({ id: task.id, cand })
    }
    generated++
  }
  // 异步预热深度分析（走串行队列，不阻塞扫描返回）
  if (preheat.length > 0 && configRef && isAiConfigured(configRef)) {
    void enqueueSalesTask(async () => {
      for (const { id, cand } of preheat) {
        try {
          const item: ActionItem = {
            id,
            sessionId: cand.sessionId,
            displayName: cand.displayName ?? '未知',
            stage: 'unknown',
            triggerType: cand.ruleId,
            title: cand.title,
            reason: cand.title,
            suggestion: '',
            priority: cand.priority,
            priorityScore: cand.score,
            silentDays: 0,
            createdAt: Date.now(),
            status: 'pending'
          }
          const analysis = await generateActionAnalysis(item)
          if (analysis && !analysis.notConfigured && !analysis.error) {
            salesDbService.todoUpdate(id, { analysis: JSON.stringify(analysis) })
            // P0-2C.3：预热路径三判断（机会/风险/下一步）统一落 customer_judgment，
            // 与 follow_up_task.analysis 旧链路并存；失败不阻断预热循环。
            await persistActionAnalysisJudgments({
              item,
              analysis,
              channel: 'preheat',
              model: configRef ? String(configRef.get('aiModelApiModel') || '').trim() || undefined : undefined
            })
          }
        } catch { /* 预热失败不影响扫描 */ }
      }
    })
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
  // SLA 接通：每日全量扫描顺带扫描超时线索 → 生成首触 SLA 卡（幂等；独立于 action_engine 重扫，created_by='sla' 不受清理）
  try { scanLeadSla() } catch (e) { salesLog('WARN', `[ActionEngine] SLA 扫描失败: ${e}`) }
  // 售后规则（PRD §1.6/§1.7/§1.7a/§1.7b）：R9 经销商拿货 / R10 成交回访 / R11 阶段停滞 / 设备周期提醒 / R12 经销商回购
  // （created_by='aftersales' 独立于 action_engine 重扫清理，规则内自带去重）
  try {
    const asr = runAftersalesScan(nowMs)
    if (asr.r9 + asr.r10 + asr.r11 + asr.device + asr.r12 > 0) salesLog('INFO', `[ActionEngine] 售后规则出卡 ${JSON.stringify(asr)}`)
  } catch (e) { salesLog('WARN', `[ActionEngine] 售后规则扫描失败: ${e}`) }
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
      // 1. 拉取最近消息（chatService 构造 messageKey，P0-1 证据可回查原话）
      const msgResult = await chatService.getLatestMessages(sessionId, 10)
      if (!msgResult?.success || !msgResult.messages?.length) return

      // 2. AI 阶段分类
      const snippets = toMessageSnippets(msgResult.messages)
      if (snippets.length === 0) return
      // P0-1 证据：客户最近一条消息 key（R3 卡 source_message_id 回查原话用）
      const evidence = extractEvidence(snippets)

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
          const lcR3 = lastContactSec(profile)
          const silentDays = lcR3 > 0 ? (nowSec - lcR3) / DAY_SEC : 0
          salesDbService.todoCreate({
            session_id: sessionId,
            display_name: displayName || null,
            trigger_type: r3.id,
            title: r3.title(profile, silentDays),
            status: 'pending',
            priority_score: PRIORITY_WEIGHT[r3.priority] + 10,
            created_by: 'action_engine',
            source_message_id: evidence.messageKey
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
export async function lazyScan(): Promise<number> {
  const nowSec = Math.floor(Date.now() / 1000)
  const nowMs = Date.now()
  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)

  // 仅取 R1/R2/R4/R5 关心的阶段（阶段口径归一：中英混存统一 canonical；dormant 已拆为 activityState，按时间态覆盖）
  const targetStages = new Set(['quoted', 'negotiating', 'contacted'])
  const customers = salesDbService.customerAll().filter(c =>
    targetStages.has(normalizeStage(c.stage)) || computeActivityState(c.stage, c.last_contact_at, nowSec) === 'dormant')

  if (customers.length === 0) return 0

  const lazyRules = RULES.filter(r => LAZY_SCAN_RULE_IDS.includes(r.id))
  let generated = 0

  for (const customer of customers) {
    // 阶段口径统一 canonical（STAGE_BONUS / 规则比较一致）
    customer.stage = normalizeStage(customer.stage)
    // 已有今日 pending 任务则跳过（不限规则类型，同客户同天有任一 pending 即跳过）
    const existingToday = salesDbService.todoList({ status: 'pending', session_id: customer.session_id, limit: 3 })
    const hasTaskToday = existingToday.some(t => (t.created_at ?? 0) >= todayStart.getTime())
    if (hasTaskToday) continue

    const lastContact = lastContactSec(customer)
    const silentDays = lastContact > 0 ? (nowSec - lastContact) / DAY_SEC : 0

    for (const rule of lazyRules) {
      try {
        if (!rule.match(customer, nowSec)) continue
        if (salesDbService.hasRecentTask(customer.session_id, rule.id, nowMs - DEDUP_WINDOW_MS)) continue

        const score = PRIORITY_WEIGHT[rule.priority] + Math.min(silentDays, 30) + (STAGE_BONUS[customer.stage] ?? 0)
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
/**
 * 统一信号流：follow_up_task 卡片流（设计-AI见解重定位 §3.2 起 insight 不再进卡流，
 * 自动见解落 archive 作档案标注）
 */
export async function getUnifiedSignals(): Promise<UnifiedResult> {
  if (!salesDbService.isInitialized()) {
    return { signals: [], stats: { totalSignals: 0, taskOnly: 0, insightOnly: 0, merged: 0, urgentCount: 0, highPriorityCount: 0, riskCustomerCount: 0, activeDeals: 0, todayPending: 0 }, generatedAt: Date.now() }
  }

  const nowMs = Date.now()
  const nowSec = Math.floor(nowMs / 1000)
  const todayStart = new Date(); todayStart.setHours(0,0,0,0)
  const todayStartMs = todayStart.getTime()

  // 1. 沿用现有扫描逻辑
  if (lastFullScanAt < todayStartMs) {
    await enqueueSalesTask(() => runFullScan())
  }
  await enqueueSalesTask(() => lazyScan())
  // SLA 接通：每次卡流扫描都补一次 SLA 扫描（应用连续运行期间，新到期线索即时出首触卡）
  await enqueueSalesTask(() => { try { scanLeadSla() } catch (e) { salesLog('WARN', `[ActionEngine] SLA 扫描失败: ${e}`) } })

  // 2. 查 pending tasks
  const pendingTasks = salesDbService.todoList({ status: 'pending' })
  const mainPending = pendingTasks.filter(t => t.trigger_type !== 'rule_r6_consider_drop')

  // 4. 按 sessionId 分组合并
  const signalMap = new Map<string, UnifiedSignal>()

  // 4a. 从 tasks 构建
  for (const task of mainPending) {
    // 手动待办：独立分支（事实驱动，绕过沉默天数过滤；无客户用虚拟 sessionId todo:<id>）
    if (task.trigger_type === 'manual') {
      const sid = task.session_id ? String(task.session_id) : `todo:${task.id || 0}`
      const profile = task.session_id ? salesDbService.customerGetBySession(task.session_id) : undefined
      const source: SignalSource = {
        type: 'task',
        ruleCode: 'MAN',
        label: '手动待办',
        reason: String(task.title || ''),
        rawTaskId: task.id ?? 0
      }
      signalMap.set(sid, {
        sessionId: sid,
        displayName: task.display_name || profile?.display_name || task.title || '个人待办',
        stage: profile ? normalizeStage(profile.stage) : 'manual',
        silentDays: 0,
        sources: [source],
        priorityScore: Math.min(140, Number(task.priority_score || 40)),
        urgencyTier: 'normal',
        status: 'pending',
        analysis: task.analysis ?? ''
      })
      continue
    }
    // SLA 首触卡不进主卡流：无客户上下文，属散任务，只在今日行动右侧 TodoSidebar 展示
    // （职责分工 §2.19：主卡流 = 客户动作，散任务 = 侧栏清单）
    if (task.trigger_type === 'sla_lead') continue
    // 物流超期卡：虚拟 sessionId logi:<logistics_id>（事实驱动，不参与沉默天数过滤）
    if (task.trigger_type === 'rule_r8_logistics_overdue') {
      const sid = String(task.session_id || '')
      if (!sid.startsWith('logi:')) continue
      const source: SignalSource = {
        type: 'task',
        ruleCode: 'R8',
        label: '物流跟进',
        reason: String(task.title || '发货超期未确认签收'),
        rawTaskId: task.id ?? 0
      }
      signalMap.set(sid, {
        sessionId: sid,
        displayName: String(task.display_name || '未知客户'),
        stage: 'followup',
        silentDays: 0,
        sources: [source],
        priorityScore: Math.min(140, Number(task.priority_score || 80)),
        urgencyTier: 'normal',
        status: 'pending',
        analysis: task.analysis ?? ''
      })
      continue
    }
    const sid = task.session_id || ''
    if (!sid) continue
    const profile = salesDbService.customerGetBySession(sid)
    const stage = normalizeStage(profile?.stage)
    if (['won', 'lost'].includes(stage)) continue
    const lastContact = profile?.last_contact_at || (profile?.created_at ? Math.floor(profile.created_at / 1000) : 0)
    const silentDays = lastContact > 0 ? Math.max(0, Math.floor((nowSec - lastContact) / DAY_SEC)) : 0
    if (silentDays <= 0) continue

    const rule = RULES.find(r => r.id === task.trigger_type)
    const rulePriority = rule ? rule.priority : 'info'
    const baseScore = PRIORITY_WEIGHT[rulePriority] ?? 20

    const source: SignalSource = {
      type: 'task',
      ruleCode: rule ? (() => { const m = rule.id.match(/r(\d+)/); return m ? 'R' + m[1] : 'R0' })() : 'R0',
      label: (() => {
        const labels: Record<string, string> = {
          'rule_r0_unknown_followup': '待确认',
          'rule_r1_quoted_followup': '报价跟进',
          'rule_r7_quote_followup': '报价跟进',
          'rule_r2_negotiating_stall': '谈判跟进',
          'rule_r3_new_no_reply': '新客响应',
          'rule_r4_contacted_silent': '激活沉默',
          'rule_r5_dormant_wake': '沉默唤醒',
          'rule_r6_consider_drop': '考虑放弃',
          'rule_r8_logistics_overdue': '物流跟进',
          'rule_r9_dealer_restock': '经销商拿货',
          'rule_r10_revisit_15': '成交回访', 'rule_r10_revisit_30': '成交回访',
          'rule_r10_revisit_60': '成交回访', 'rule_r10_revisit_90': '成交回访',
          'rule_r11_quoted_stall': '阶段停滞', 'rule_r11_negotiating_stall': '阶段停滞',
          'rule_dev_wheel': '设备保养', 'rule_dev_hydraulic': '设备保养', 'rule_dev_battery': '设备保养',
          'rule_r12_dealer_reorder': '经销商回购',
        }
        return labels[task.trigger_type || ''] || '待确认'
      })(),
      reason: buildReason(task.trigger_type || '', silentDays),
      rawTaskId: task.id ?? 0
    }

    const existing = signalMap.get(sid)
    if (existing) {
      existing.sources.push(source)
      existing.priorityScore = Math.min(140, Math.max(existing.priorityScore, baseScore))
    } else {
      signalMap.set(sid, {
        sessionId: sid,
        displayName: task.display_name || profile?.display_name || '未知',
        stage,
        silentDays,
        sources: [source],
        priorityScore: baseScore,
        urgencyTier: 'normal',
        status: 'pending',
        analysis: task.analysis ?? ''
      })
    }
  }

  // 5. 计算 urgencyTier
  for (const sig of signalMap.values()) {
    if (sig.priorityScore >= 100) sig.urgencyTier = 'urgent'
    else if (sig.priorityScore >= 60) sig.urgencyTier = 'high'
    else sig.urgencyTier = 'normal'
  }

  // 5.5 P0-3.4：判断展示消费系统已形成的当前视图（不把 analysis JSON 历史快照当当前判断）。
  // 主进程同步投影一次组装：真实会话 → judgments；虚拟卡（todo:/logi:/lead:）/无客户 → 查无客户 → null
  for (const sig of signalMap.values()) {
    try {
      const view = getCustomerCurrentView(sig.sessionId)
      sig.judgments = view?.judgments ?? null
    } catch {
      sig.judgments = null
    }
  }

  // 6. 排序：按 priorityScore 降序（lead: 卡已不在卡流，无需置顶兜底）
  const signals = [...signalMap.values()]
    .sort((a, b) => b.priorityScore - a.priorityScore)

  // 7. Stats
  const allCustomers = salesDbService.customerAll()
  const weekStartMs = getWeekStartMs()
  const activeStageCustomers = allCustomers.filter(c => ['quoted', 'negotiating', 'contacted'].includes(normalizeStage(c.stage)))

  const stats: UnifiedStats = {
    totalSignals: signals.length,
    taskOnly: signals.filter(s => s.sources.every(src => src.type === 'task')).length,
    // 设计-AI见解重定位 §3.2：insight 不再进卡流，两字段恒 0（保留字段防前端引用断裂）
    insightOnly: 0,
    merged: 0,
    urgentCount: signals.filter(s => s.urgencyTier === 'urgent').length,
    highPriorityCount: signals.filter(s => s.urgencyTier === 'urgent' || s.urgencyTier === 'high').length,
    riskCustomerCount: activeStageCustomers.filter(c => {
      const lc = c.last_contact_at || 0
      return lc > 0 && (nowSec - lc) / DAY_SEC >= 5
    }).length,
    activeDeals: allCustomers.filter(c => ['quoted', 'negotiating'].includes(normalizeStage(c.stage))).length,
    todayPending: signals.length
  }

  salesLog('INFO', `[UnifiedSignals] ${signals.length} signals (${stats.taskOnly} task-only, ${stats.urgentCount} urgent)`)
  return { signals, stats, generatedAt: nowMs }
}

/**
 * 完成/跳过统一信号：标记 task done/skipped
 * （设计-AI见解重定位 §3.2 起 insight 不再进卡流，insight read 标记随合流分支一并移除）
 */
export function completeUnifiedSignal(sessionId: string, action: 'done' | 'skipped'): void {
  // 手动待办：虚拟 sessionId todo:<taskId>（无客户），完成/跳过即关闭该任务
  if (String(sessionId || '').startsWith('todo:')) {
    const taskId = Number(String(sessionId).slice(5))
    const task = taskId > 0 ? salesDbService.getTask(taskId) : undefined
    if (task?.id) completeAction(task.id, action)
    return
  }
  // SLA 首触卡不在主卡流（散任务走侧栏，完成闭环走 crm:lead:slaComplete IPC），此处无需 lead: 分支
  // 物流超期卡：虚拟 sessionId logi:<logistics_id>，完成 = 确认签收（卡 done + logistics signed + activity 三一致）
  if (String(sessionId || '').startsWith('logi:')) {
    const logisticsId = Number(String(sessionId).slice(5))
    const tasks = salesDbService.todoList({ status: 'pending', session_id: sessionId, limit: 20 })
    for (const t of tasks) if (t.id) completeAction(t.id, action)
    if (action === 'done' && logisticsId > 0) {
      try { crmDbService.markLogisticsSigned(logisticsId, { actor: '今日行动' }) } catch (e) {
        salesLog('WARN', `[UnifiedSignals] markLogisticsSigned ${logisticsId} failed: ${e}`)
      }
    }
    return
  }
  // 标记该 sessionId 的所有 pending tasks
  const tasks = salesDbService.todoList({ status: 'pending', session_id: sessionId, limit: 20 })
  for (const t of tasks) {
    if (t.id) completeAction(t.id, action)
  }
}

export async function getTodayActions(): Promise<TodayActionResult> {
  // 容错：数据库尚未初始化时返回空结果（启动时序竞争）
  if (!salesDbService.isInitialized()) {
    return { items: [], archiveCandidates: [], stats: { todayPending: 0, overdue: 0, newThisWeek: 0, pipelineTotal: 0, r6Count: 0, highPriorityCount: 0, riskCustomerCount: 0, activeDeals: 0 }, generatedAt: Date.now() }
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
  // SLA 接通：每次卡流扫描都补一次 SLA 扫描（应用连续运行期间，新到期线索即时出首触卡）
  await enqueueSalesTask(() => { try { scanLeadSla() } catch (e) { salesLog('WARN', `[ActionEngine] SLA 扫描失败: ${e}`) } })

  // 查询所有 pending 任务
  const pendingTasks = salesDbService.todoList({ status: 'pending', limit: 100 })

  // 分离 R6 与主队列（R6 不参与 DAILY_LIMIT 主队列竞争）
  const mainPending = pendingTasks.filter(t => t.trigger_type !== 'rule_r6_consider_drop')
  const r6Pending = pendingTasks.filter(t => t.trigger_type === 'rule_r6_consider_drop')

  // 主队列：排序 + 截断 + 映射 + 过滤无效项
  const actionItems: ActionItem[] = mainPending
    .sort((a, b) => (b.priority_score ?? 0) - (a.priority_score ?? 0))
    .slice(0, DAILY_LIMIT)
    .map(task => mapTaskToActionItem(task, nowMs))
    .filter(item => {
      // 物流超期卡是事实驱动，不受阶段/沉默天数过滤（可能刚联系过客户但物流仍超期）
      if (item.triggerType === 'rule_r8_logistics_overdue') return true
      // 成交/流失客户不需要跟进
      if (['won', 'lost'].includes(item.stage)) return false
      // 0天沉默的不需要行动
      if (item.silentDays <= 0) return false
      return true
    })

  // R6 清理候选：独立列表，不限名额
  const archiveCandidates: ActionItem[] = r6Pending
    .sort((a, b) => (b.priority_score ?? 0) - (a.priority_score ?? 0))
    .map(task => mapTaskToActionItem(task, nowMs))

  // 统计数字
  const allCustomers = salesDbService.customerAll()
  const weekStartMs = getWeekStartMs()
  const nowSec = Math.floor(nowMs / 1000)
  const activeStageCustomers = allCustomers.filter(c => ['quoted', 'negotiating', 'contacted'].includes(normalizeStage(c.stage)))
  const stats = {
    todayPending: actionItems.length,
    overdue: pendingTasks.filter(t => t.due_at && t.due_at < nowMs).length,
    newThisWeek: allCustomers.filter(c => (c.created_at ?? 0) >= weekStartMs).length,
    pipelineTotal: allCustomers.filter(c => !['won', 'lost'].includes(normalizeStage(c.stage))).length,
    r6Count: r6Pending.length,
    highPriorityCount: actionItems.filter(i => i.priority === 'urgent' || i.priority === 'high').length,
    riskCustomerCount: activeStageCustomers.filter(c => {
      const lc = c.last_contact_at ?? 0
      return lc > 0 && (nowSec - lc) / DAY_SEC >= 5
    }).length,
    activeDeals: allCustomers.filter(c => ['quoted', 'negotiating'].includes(normalizeStage(c.stage))).length
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
 * P0-3 E3.3：follow_up_done 行动事件在**状态转换成功之后**写入（系统确认"从未完成 → 完成"），
 * 重复完成（已 done/skipped）不产生新事件——与 last_stage_change_at 同一幂等思想。
 * P0-4.2.1：事件携带 before.id 作 task_id（correlation：哪条建议 → 哪次完成）。
 */
export function completeAction(taskId: number, action: 'done' | 'skipped'): void {
  const now = Date.now()
  if (action === 'done') {
    const before = salesDbService.getTask(taskId)
    salesDbService.todoUpdate(taskId, { status: 'done', completed_at: now })
    if (before?.id && before.status !== 'done' && before.status !== 'skipped' && before.session_id) {
      recordUserActionEvent(before.session_id, 'follow_up_done', null, before.id)
    }
  } else {
    salesDbService.todoUpdate(taskId, { status: 'skipped' })
  }
}

/**
 * P0-3 E3.3：销售行动事件统一写入入口（主进程）。
 * 白名单校验（防万能日志表：仅行动三事件；follow_up_done 由 completeAction 状态转换触发，不经由此通道）；
 * 写失败只 WARN 不抛——行动成功与事件写入解耦，绝不影响原业务。
 * message_key 有消息上下文才传（canonical P0-2B），无可靠 key 必须留空（证据诚实，不伪造）。
 * P0-4.2.1：taskId 为 correlation key（关联 follow_up_task.id），无任务上下文不传 → NULL，
 * 禁止伪造——task_id 不是事件合法性的前置条件。
 */
export function recordUserActionEvent(
  sessionId: string,
  eventType: 'script_copied' | 'chat_opened' | 'follow_up_done',
  messageKey?: string | null,
  taskId?: number | null
): void {
  try {
    if (!sessionId) return
    if (!['script_copied', 'chat_opened', 'follow_up_done'].includes(eventType)) {
      salesLog('WARN', `[ActionEvent] 非法行动事件类型: ${eventType}（P0-3 E3 仅允许行动三事件）`)
      return
    }
    salesDbService.customerEventAdd({
      session_id: sessionId,
      event_type: eventType,
      message_key: messageKey || null,
      task_id: taskId ?? null,
      source: 'manual'
    })
  } catch (e) {
    salesLog('WARN', `[ActionEvent] ${eventType} 写入失败: ${e}`)
  }
}

// ─── 辅助函数 ─────────────────────────────────────────────────────────────────

function mapTaskToActionItem(task: FollowUpTask, nowMs: number): ActionItem {
  const nowSec = Math.floor(nowMs / 1000)
  const profile = task.session_id ? salesDbService.customerGetBySession(task.session_id) : undefined
  const lastContact = profile?.last_contact_at || (profile?.created_at ? Math.floor((profile.created_at) / 1000) : 0)
  const silentDays = lastContact > 0 ? Math.max(0, Math.floor((nowSec - lastContact) / DAY_SEC)) : 0

  return {
    id: task.id ?? 0,
    sessionId: task.session_id ?? '',
    displayName: task.display_name ?? '未知客户',
    stage: normalizeStage(profile?.stage),
    triggerType: task.trigger_type,
    title: task.title,
    reason: buildReason(task.trigger_type, silentDays),
    suggestion: '',
    priority: (() => {
      const rule = RULES.find(r => r.id === task.trigger_type)
      return rule ? rule.priority : scoreToPriority(task.priority_score ?? 0)
    })(),
    priorityScore: task.priority_score ?? 0,
    silentDays,
    createdAt: task.created_at ?? 0,
    status: task.status ?? 'pending',
    analysis: task.analysis ?? ''
  }
}

function buildReason(triggerType: string, silentDays: number): string {
  const reasons: Record<string, string> = {
    'rule_r3_new_no_reply': `新客户${silentDays}天未实质沟通`,
    'rule_r1_quoted_followup': `报价后${silentDays}天无回复`,
    'rule_r2_negotiating_stall': `谈判中${silentDays}天无进展`,
    'rule_r4_contacted_silent': `沟通后${silentDays}天未联系`,
    'rule_r5_dormant_wake': `沉默${silentDays}天，曾有沟通`,
    'rule_r0_unknown_followup': `未分类客户${silentDays}天未互动，需确认意向`,
    'rule_r6_consider_drop': `多次跟进无响应（${silentDays}天）`,
    'rule_r8_logistics_overdue': `发货超期未确认签收`,
    'rule_r9_dealer_restock': `经销商签收待回访`,
    'rule_r10_revisit_15': '成交满 15 天回访', 'rule_r10_revisit_30': '成交满 30 天回访',
    'rule_r10_revisit_60': '成交满 60 天回访（老客加频）', 'rule_r10_revisit_90': '成交满 90 天回访',
    'rule_r11_quoted_stall': '比价阶段停滞超 14 天', 'rule_r11_negotiating_stall': '决策阶段停滞超 21 天',
    'rule_dev_wheel': '轮子磨损检查周期到', 'rule_dev_hydraulic': '液压系统检查周期到', 'rule_dev_battery': '电池健康评估周期到',
    'rule_r12_dealer_reorder': '经销商超 60 天未拿货'
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
