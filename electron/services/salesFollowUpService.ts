/**
 * salesFollowUpService.ts
 *
 * AI 跟进待办服务（按产品方案 V1 重做）
 *
 * 核心流程：
 * 1. 承诺提取（两段式）：规则粗筛 → LLM 结构化抽取 → 置信度过滤
 * 2. 核验：按 due_time 驱动，把已有待办+后续聊天喂 AI，三档判断
 * 3. 反馈修正：人工纠正落库
 *
 * 定位修正（2026-09-12，实施契约 `docs/规划/AI简报与按需识别-PRD-v1.0.md`）：
 * 抽取逻辑（去重、置信度、due_days、优先级）**原样保留，只换扳机**——
 * 不再有任何定时器或启动预热调用本服务；两个触发者都是人/后台简报：
 *   · 「AI 识别这个客户」按钮 → `identifyCustomer`（单客户，游标 scope='manual'）
 *   · 早间简报 / 「重新生成简报」→ `scanSessionsForDigest`（批量，游标 scope='digest'）
 * 游标持久化在 salesDb.`ai_scan_cursor`（宪法 §3 登记行），按账号分库天然隔离。
 */

import { wcdbService } from './wcdbService'
import { salesDbService, type FollowUpTask } from './salesDbService'
import { simpleCompletion, isAiConfigured } from './ai/aiApiClient'
import { isBudgetBlockedError } from './ai/aiBudget'
import { buildMessageKey } from '../../shared/messageKey'
import { ConfigService } from './config'
import { extractContent, getIsSend, formatMessages } from './salesMessageText'
import { getIdentity } from './identityService'

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

/** 单客户识别结果（PRD §6.2 状态机数据面） */
export interface IdentifyResult {
  success: boolean
  /** true = 调用前判定「无新消息」，未发起模型调用（账本不会有记录） */
  noNewContent?: boolean
  /** 本次新建的待办数 */
  newTasks?: number
  /** 最近一条消息时间（毫秒，供界面展示「刚刚更新」的依据） */
  latestAt?: number
  error?: string
}

/** 批量扫描一轮的产出（供简报 coverage 装配） */
export interface DigestScanOutcome {
  /** AI 未配置时为 false —— 简报必须据此显示「分析失败」，不得显示「无风险」 */
  aiConfigured: boolean
  /** 本轮实际调用模型的会话数 */
  processed: number
  /** 本轮新建待办数 */
  newTasks: number
  /** 因输入上界/游标判定「无新内容」而跳过的会话数（零调用） */
  skipped: number
  /** 单个会话失败数（不中断整轮） */
  failed: number
  /** 发现但超出本轮 20 个上限的候选会话数（= 未处理数量） */
  pending: number
  /** 本账号的私聊会话总数（判断「有无聊天依据」用；为 0 表示无聊天数据） */
  activeSessions: number
  /** 额度阻断时的原因（非空表示本轮被额度拦下，未完成） */
  blockedReason?: string
  /** 本轮覆盖的数据起点（秒）；无覆盖时 0 */
  fromSec: number
  /** 本轮覆盖的数据终点（秒）；无覆盖时 0 */
  toSec: number
  /** 失败原因摘要（首个失败；无失败为空） */
  error?: string
}

// ─── 常量 ────────────────────────────────────────────────────────────────────

const SCAN_SESSION_LIMIT = 50
const SCAN_MESSAGE_LIMIT = 30
const MAX_CONTEXT_CHARS = 1500
const CONFIDENCE_THRESHOLD = 0.6   // 低于此值进入"待确认"
const VERIFY_WINDOW_DAYS = 3       // 到期后 N 天内核验

/** 单轮简报最多处理的会话数（PRD §5.1「每轮最多处理 20 个会话」） */
export const DIGEST_SESSION_LIMIT = 20
/** 首启/单客户识别的最大回看天数（PRD §5.1「首启最多回看 7 天」、§5.2 输入上界 N） */
export const IDENTIFY_LOOKBACK_DAYS = 7
/** 单客户单次识别最多读取的消息条数（PRD §5.2 输入上界 M） */
export const IDENTIFY_MESSAGE_LIMIT = SCAN_MESSAGE_LIMIT

/** 游标消费方标识（ai_scan_cursor.scope） */
export const CURSOR_SCOPE_DIGEST = 'digest'
export const CURSOR_SCOPE_MANUAL = 'manual'

/** WCDB 时间戳是秒，JS Date 是毫秒——统一归一到秒（铁律） */
function toSec(value: unknown): number {
  const n = Number(value || 0)
  if (!Number.isFinite(n) || n <= 0) return 0
  return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n)
}

const DAY_SEC = 24 * 60 * 60

// ─── 第一阶段：规则粗筛 ─────────────────────────────────────────────────────

// 时间词
const TIME_PATTERNS = /下周|这周|本周|月底|周[一二三四五六日天]|明天|后天|大后天|\d+号|\d+月|今天|晚上|上午|下午|尽快|这两天|过几天|回头|稍后|待会|一会儿|\d+点/

// 承诺动词（我方的承诺）
const PROMISE_VERBS = /发给你|发您|给你发|给您发|我发|我整理|我确认|我查|我问|我安排|我联系|我回复|我报价|我寄|我送|我准备|我处理|我跟进|我催|我核实|我对接|我协调|我落实|我反馈|我沟通|我了解|我看看|我研究|我考虑|我申请|我帮你|我帮您|给你|给您|回头[我咱]|等[我咱]|我这边/

// 客户请求（需要我方响应的）
const REQUEST_PATTERNS = /能不能|可以|麻烦|帮我|帮忙|请问|想了解|想知道|需要|报价|方案|参数|规格|价格|多少钱|怎么卖|有货|现货|交期|样品|资料|图册|选型/

function roughFilter(messages: any[], peerName: string): Array<{ text: string; isSend: number; messageKey: string }> {
  const candidates: Array<{ text: string; isSend: number; messageKey: string }> = []

  for (const msg of messages) {
    const content = extractContent(msg)
    if (!content || content.length < 4) continue

    const isSend = getIsSend(msg)
    // P0-2B：从原生行构造 canonical messageKey（与 chatService 共用同一共享纯函数）。
    // localId>0 且带 _db_path/table_name → canonical；否则按共享逻辑回退 local:/server:/fallback。
    const messageKey = buildMessageKey({
      localId: Number(msg.local_id ?? msg.localId ?? 0),
      serverId: Number(msg.server_id ?? msg.serverId ?? 0),
      createTime: Number(msg.create_time ?? msg.createTime ?? 0),
      sortSeq: Number(msg.sort_seq ?? msg.sortSeq ?? 0),
      senderUsername: msg.sender_username ?? msg.senderUsername ?? null,
      localType: Number(msg.local_type ?? msg.localType ?? 0),
      dbPath: msg._db_path ?? msg.db_path,
      tableName: msg.table_name
    })

    // 我方消息：包含时间词+承诺动词
    if (isSend === 1) {
      if (TIME_PATTERNS.test(content) && PROMISE_VERBS.test(content)) {
        candidates.push({ text: content, isSend, messageKey })
      }
    }
    // 客户消息：包含请求模式（需要我方响应）
    else {
      if (REQUEST_PATTERNS.test(content) && TIME_PATTERNS.test(content)) {
        candidates.push({ text: content, isSend, messageKey })
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

// ─── 第三阶段：核验 ─────────────────────────────────────────────────────────

const VERIFY_PROMPT = `你是一个 B2B 销售跟进核验助手。判断以下待办承诺是否已在后续聊天中兑现。

输出 JSON 数组，每条格式：
{"todo_id": 待办ID, "judgment": "followed|suspected|not_followed", "reason": "判断依据(20字内)"}

判断标准：
- followed: 后续聊天中有明确证据表明承诺已兑现（如发了报价、客户确认收到等）
- suspected: 有相关消息但不能确定是否完全兑现（保守处理，需人工确认）
- not_followed: 后续聊天中完全没有相关动作

关键原则：宁可判 suspected 也不要误判 followed。一旦误判"已完成"，工具可信度崩塌。`

// ─── 服务 ────────────────────────────────────────────────────────────────────

class SalesFollowUpService {
  /**
   * 单客户按需识别（PRD §5.2「AI 识别这个客户」）。
   *
   * 调用前判定：游标（scope='manual'）比对该会话最新消息时间，无新消息则**不发起模型调用**，
   * 直接返回 noNewContent=true（§4.7：调用后才发现无新内容是错的——用户等了、花了钱，
   * 且重复按=重复付费）。
   *
   * 输入上界：最近 `IDENTIFY_LOOKBACK_DAYS` 天 / 最多 `IDENTIFY_MESSAGE_LIMIT` 条消息。
   * 「1 次调用」的成本声明只在该上界内成立。
   *
   * ⛔ 本方法内部不 enqueue（死锁红线）：调用方（IPC 最外层入口）负责排队。
   */
  async identifyCustomer(config: ConfigService, params: { sessionId: string; displayName?: string }): Promise<IdentifyResult> {
    const sessionId = String(params?.sessionId || '').trim()
    if (!sessionId) return { success: false, error: '会话无效，无法识别' }
    if (!isAiConfigured(config)) return { success: false, error: 'AI 未配置，请先在设置中填写 AI 模型' }

    const connected = await wcdbService.isConnected()
    if (!connected) return { success: false, error: '微信数据库未连接，无法读取聊天记录' }

    const displayName = String(params?.displayName || '').trim() || sessionId
    const cursorSec = salesDbService.cursorGet(CURSOR_SCOPE_MANUAL, sessionId)
    const nowSec = Math.floor(Date.now() / 1000)
    // 首轮无游标：只回看 IDENTIFY_LOOKBACK_DAYS 天，不拿过去时刻当基点（§2.54 时间纪律）
    const sinceSec = cursorSec > 0 ? cursorSec : nowSec - IDENTIFY_LOOKBACK_DAYS * DAY_SEC

    try {
      const msgResult = await wcdbService.getMessages(sessionId, IDENTIFY_MESSAGE_LIMIT, 0)
      if (!msgResult.success) return { success: false, error: msgResult.error || '读取聊天记录失败' }
      const all = Array.isArray(msgResult.messages) ? msgResult.messages : []
      if (all.length === 0) return { success: true, noNewContent: true, newTasks: 0 }

      const latestSec = all.reduce((max, m) => Math.max(max, toSec(m.create_time ?? m.createTime)), 0)
      if (latestSec > 0 && latestSec <= sinceSec) {
        return { success: true, noNewContent: true, newTasks: 0, latestAt: latestSec * 1000 }
      }

      const createdBy = this.currentSalesName()
      const outcome = await this.extractForSession(config, sessionId, displayName, {
        sinceSec,
        messageLimit: IDENTIFY_MESSAGE_LIMIT,
        messages: all,
        createdBy,
        purpose: 'manual_identify',
        trigger: 'manual_button'
      })
      // 无新内容只推进游标、不产出待办时，仍按「无新内容」提示（不装作跑过）
      if (!outcome.called) {
        return { success: true, noNewContent: true, newTasks: 0, latestAt: outcome.latestSec * 1000 }
      }
      return { success: true, newTasks: outcome.created, latestAt: outcome.latestSec * 1000 }
    } catch (e) {
      return { success: false, error: this.describeError(e) }
    }
  }

  /**
   * 早间简报 / 「重新生成简报」的批量扫描（PRD §5.1 / §4.3）。
   *
   * 一轮最多 `maxSessions` 个会话（默认 20），按最近活跃排序，只扫游标之后有新消息的会话；
   * 发现但超出上限的候选数作为「未处理数量」返回，供六态强制展示（不得显示「全部完成」）。
   * 记录类核对（`verifyDueTasks`）在同一轮内顺带完成，不额外产生会话级调用。
   *
   * ⛔ 本方法内部不 enqueue（死锁红线）：调用方负责排队。
   */
  async scanSessionsForDigest(
    config: ConfigService,
    options: { maxSessions?: number; lookbackDays?: number } = {}
  ): Promise<DigestScanOutcome> {
    const empty: DigestScanOutcome = {
      aiConfigured: false, processed: 0, newTasks: 0, skipped: 0, failed: 0, pending: 0, activeSessions: 0, fromSec: 0, toSec: 0
    }
    const connected = await wcdbService.isConnected()
    if (!connected) return { ...empty, aiConfigured: true, error: '微信数据库未连接' }

    const maxSessions = Math.max(1, Number(options.maxSessions) || DIGEST_SESSION_LIMIT)
    const lookbackDays = Math.max(1, Number(options.lookbackDays) || IDENTIFY_LOOKBACK_DAYS)
    const sessionsResult = await wcdbService.getSessions()
    if (!sessionsResult.success || !Array.isArray(sessionsResult.sessions)) {
      return { ...empty, aiConfigured: true, error: sessionsResult.error || '读取会话列表失败' }
    }

    const candidates = this.privateSessions(sessionsResult.sessions)
    // 有聊天但无 AI：仍要报出会话数——否则简报会把「没看」说成「没问题」
    if (!isAiConfigured(config)) return { ...empty, aiConfigured: false, activeSessions: candidates.length }
    const nameMap = await this.displayNameMap(candidates.map((s) => s.username))
    const cursorMap = salesDbService.cursorMap(CURSOR_SCOPE_DIGEST)
    const nowSec = Math.floor(Date.now() / 1000)
    const floorSec = nowSec - lookbackDays * DAY_SEC

    // 只保留「游标之后有新消息」的会话；首轮（无游标）按 7 天回看截断
    const fresh = candidates.filter((s) => {
      const cursor = cursorMap.get(s.username) || 0
      const since = cursor > 0 ? cursor : floorSec
      return s.lastSec <= 0 || s.lastSec > since
    })

    const batch = fresh.slice(0, maxSessions)
    const outcome: DigestScanOutcome = {
      aiConfigured: true,
      processed: 0,
      newTasks: 0,
      skipped: 0,
      failed: 0,
      pending: Math.max(0, fresh.length - batch.length),
      activeSessions: candidates.length,
      fromSec: 0,
      toSec: 0
    }

    for (const session of batch) {
      const sessionId = session.username
      const displayName = nameMap[sessionId] || session.displayName || sessionId
      const cursor = cursorMap.get(sessionId) || 0
      const sinceSec = cursor > 0 ? cursor : floorSec
      try {
        const msgResult = await wcdbService.getMessages(sessionId, SCAN_MESSAGE_LIMIT, 0)
        if (!msgResult.success || !Array.isArray(msgResult.messages) || msgResult.messages.length === 0) {
          outcome.skipped++
          continue
        }
        const result = await this.extractForSession(config, sessionId, displayName, {
          sinceSec,
          messageLimit: SCAN_MESSAGE_LIMIT,
          messages: msgResult.messages,
          createdBy: 'ai',
          purpose: 'digest_scan',
          trigger: 'morning_digest'
        })
        if (result.called) outcome.processed++
        else outcome.skipped++
        outcome.newTasks += result.created
        if (result.latestSec > 0) {
          outcome.fromSec = outcome.fromSec === 0 ? sinceSec : Math.min(outcome.fromSec, sinceSec)
          outcome.toSec = Math.max(outcome.toSec, result.latestSec)
        }
      } catch (e) {
        outcome.failed++
        if (!outcome.error) outcome.error = this.describeError(e)
        // 额度阻断：后面的会话必然同样被拦，立即停轮，避免把 20 个会话各刷一条阻断记录
        if (isBudgetBlockedError(e)) {
          outcome.blockedReason = this.describeError(e)
          break
        }
      }
    }

    // 记录类核对（到期待办）——与提取同轮完成；失败不影响轮次结论
    try {
      await this.verifyDueTasks(config)
    } catch { /* 核验失败不阻断简报 */ }

    return outcome
  }

  /**
   * 核验到期待办（Phase A）。保留供简报批量调用；不再是定时器驱动。
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
        const chatText = formatMessages(msgResult.messages, displayName, {
          maxLineChars: 150,
          maxTotalChars: MAX_CONTEXT_CHARS
        })
        if (!chatText) continue

        // 构造待办上下文
        const todoContext = tasks.map(t =>
          `- [ID:${t.id}] ${t.promise_summary || t.title}（截止：${t.due_at ? new Date(t.due_at).toLocaleDateString('zh-CN') : '未定'}）`
        ).join('\n')

        const aiResponse = await simpleCompletion(
          config,
          VERIFY_PROMPT,
          `该客户的待办承诺：\n${todoContext}\n\n后续聊天记录：\n${chatText}\n\n请判断每条待办是否已兑现。`,
          { responseFormatJson: true, temperature: 0.2, maxTokens: 400, usageContext: { purpose: 'followup_verify', trigger: 'digest' } }
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
   * 对单个会话执行「规则粗筛 → LLM 抽取 → 去重落库」。
   *
   * 抽取规则本体（粗筛正则、prompt、置信度阈值、due_days 归一、优先级计算）与改造前逐字一致，
   * 变化只在：① 输入按 sinceSec/消息条数收窄；② 产出触发者与账本 purpose 由调用方指定；
   * ③ 处理完推进持久游标。
   */
  private async extractForSession(
    config: ConfigService,
    sessionId: string,
    displayName: string,
    opts: {
      sinceSec: number
      messageLimit: number
      messages: any[]
      createdBy: string
      purpose: string
      trigger: string
      scope?: string
    }
  ): Promise<{ created: number; latestSec: number; called: boolean }> {
    const scope = opts.scope || (opts.purpose === 'manual_identify' ? CURSOR_SCOPE_MANUAL : CURSOR_SCOPE_DIGEST)
    const scoped = opts.messages.slice(0, opts.messageLimit)
    const latestSec = scoped.reduce((max, m) => Math.max(max, toSec(m.create_time ?? m.createTime)), 0)

    // 输入上界：只喂游标之后（首轮为回看窗口之内）的消息
    const inWindow = opts.sinceSec > 0
      ? scoped.filter((m) => toSec(m.create_time ?? m.createTime) > opts.sinceSec)
      : scoped

    if (inWindow.length === 0) {
      // 无新消息：不调用模型，只推进游标（下次不再重复看同一批）
      salesDbService.cursorSet(scope, sessionId, latestSec)
      return { created: 0, latestSec, called: false }
    }

    // 第一阶段：规则粗筛
    const candidates = roughFilter(inWindow, displayName)
    if (candidates.length === 0) {
      salesDbService.cursorSet(scope, sessionId, latestSec)
      return { created: 0, latestSec, called: false }
    }

    // 第二阶段：LLM 结构化抽取
    const candidateText = candidates
      .map(c => `${c.isSend === 1 ? '我' : displayName}：${c.text.slice(0, 150)}`)
      .join('\n')

    const aiResponse = await simpleCompletion(
      config,
      EXTRACT_PROMPT,
      `以下是与"${displayName}"聊天中的候选承诺/请求片段：\n\n${candidateText}\n\n请抽取结构化的跟进待办。`,
      { responseFormatJson: true, temperature: 0.2, maxTokens: 500, usageContext: { purpose: opts.purpose, trigger: opts.trigger } }
    )

    const extracted = this.parseExtractResponse(aiResponse)
    let created = 0
    if (extracted && extracted.length > 0) {
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
          source_message_id: candidates[0]?.messageKey || null,
          promise_summary: item.promise_summary,
          action_type: item.action_type,
          trigger_type: 'ai_detected',
          title: `[${displayName}] ${item.promise_summary}`,
          due_at: dueAt,
          status,
          created_by: opts.createdBy,
          confidence: item.confidence,
          priority_score: this.calcPriority(item.confidence, item.due_days)
        })
        created++
      }
    }

    // 处理成功才推进游标；抛错时不推进（下次重扫，宁重不漏）
    salesDbService.cursorSet(scope, sessionId, latestSec)
    return { created, latestSec, called: true }
  }

  // ─── 辅助方法 ──────────────────────────────────────────────────────────────

  /** 当前销售本人姓名（PRD §3：created_by 记操作的销售本人，不记 'ai'） */
  private currentSalesName(): string {
    try {
      return String(getIdentity()?.name || '').trim() || 'current_sales'
    } catch {
      return 'current_sales'
    }
  }

  /** 私聊候选会话（过滤系统号/群/公众号），按最近活跃降序；lastSec 为秒级归一值 */
  private privateSessions(sessions: any[]): Array<{ username: string; displayName: string; lastSec: number }> {
    const SYSTEM = new Set(['filehelper', 'newsapp', 'tnewsapp', 'fmessage', 'weixin', 'medianote', 'mphelper', 'weixinguanhaozhuli', 'notifymessage'])
    return sessions
      .filter((s: any) => s.username && !s.username.endsWith('@chatroom') && !s.username.startsWith('gh_') && !SYSTEM.has(s.username))
      .map((s: any) => ({
        username: String(s.username),
        displayName: String(s.displayName || ''),
        lastSec: toSec(s.sortTimestamp || s.sort_timestamp || s.lastTimestamp || s.last_timestamp)
      }))
      .sort((a, b) => b.lastSec - a.lastSec)
  }

  /** 批量取显示名（失败不阻断，回退 sessionId） */
  private async displayNameMap(sessionIds: string[]): Promise<Record<string, string>> {
    try {
      const r = await wcdbService.getDisplayNames(sessionIds)
      if (r.success && r.map) return r.map
    } catch { /* ignore */ }
    return {}
  }

  /** 把异常转成给用户看的明确原因（失败态不许静默） */
  private describeError(e: unknown): string {
    const msg = e instanceof Error ? e.message : String(e)
    return msg || '识别失败'
  }

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

/**
 * 全局单飞状态（PRD §4.7）：**作用域是全局**——任一识别进行中，所有入口按钮全部禁用。
 * 不存在「A 客户识别中，B 客户还能点」的口径。
 */
export interface IdentifyActivityState {
  busy: boolean
  kind: 'identify' | 'digest' | null
  /** 进行中的目标名（客户名 / 「早间简报」），供按钮文案展示 */
  label: string
  startedAt: number
}

type ActivityListener = (state: IdentifyActivityState) => void

const IDLE_ACTIVITY: IdentifyActivityState = { busy: false, kind: null, label: '', startedAt: 0 }

function createCoordinator() {
  let state: IdentifyActivityState = { ...IDLE_ACTIVITY }
  const listeners = new Set<ActivityListener>()

  return {
    /** 读取当前单飞状态（IPC 轮询/首屏对齐用） */
    get(): IdentifyActivityState { return { ...state } },
    /** 订阅状态变化；返回退订函数 */
    subscribe(cb: ActivityListener): () => void {
      listeners.add(cb)
      return () => { listeners.delete(cb) }
    },
    /**
     * 占用单飞位；已被占用时返回 null（调用方据此拒绝并给出「正在识别」提示，绝不静默）。
     * 内部排队调用方负责保证不会自我占用（死锁红线：同一入口不嵌套占用）。
     */
    acquire(kind: 'identify' | 'digest', label: string): (() => void) | null {
      if (state.busy) return null
      state = { busy: true, kind, label, startedAt: Date.now() }
      for (const cb of listeners) { try { cb({ ...state }) } catch { /* 监听方异常不影响主流程 */ } }
      return () => {
        state = { ...IDLE_ACTIVITY }
        for (const cb of listeners) { try { cb({ ...state }) } catch { /* ignore */ } }
      }
    }
  }
}

export const identifyCoordinator = createCoordinator()

/** 暴露给测试的纯函数（不改变运行时行为） */
export const __testing = { roughFilter, toSec, SCAN_MESSAGE_LIMIT, CONFIDENCE_THRESHOLD, MAX_CONTEXT_CHARS }
