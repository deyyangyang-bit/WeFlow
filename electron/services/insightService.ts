import { callChatCompletion, type ChatMessage, type AiModelConfig } from './ai/aiApiClient'
import {
  buildApiUrl,
  clampText,
  stripJsonFence,
  shouldFallbackJsonMode,
  normalizeSessionIdList,
  appendPromptCurrentTime
} from './ai/promptUtils'
/**
 * insightService.ts
 *
 * AI 见解服务（按需触发）：
 * 1. 无后台自动链路：不监听 DB 变更、无定时扫描（PRD《AI简报与按需识别》§5.4 删除，
 *    原 2s 防抖与 120min 冷却两道刹车随链路一并消失）
 * 2. 入口全部由用户显式触发：见解生成、批量画像、足迹复盘、单客户按需识别
 * 3. 触发后拉取真实聊天上下文（若用户授权），组装 prompt 调模型（经 ai/aiApiClient 收口记账）
 * 4. 输出 ≤80 字见解，通过 showNotification 弹出右下角通知
 *
 * 设计原则：
 * - 不引入任何额外 npm 依赖，模型调用统一走 ai/aiApiClient（账本 + 日上限闸门）
 * - 所有失败静默处理，不影响主流程
 * - 触发频率、冷却与名单过滤均在本地完成，不把调度统计塞进模型 prompt
 */

import https from 'https'
import { ConfigService } from './config'
import { isSessionIdLike } from '../../shared/wechatId'
import { chatService, ChatSession, Message } from './chatService'
import { snsService } from './snsService'
import { weiboService } from './social/weiboService'
import { showNotification } from '../windows/notificationWindow'
import { salesLog } from './salesLogger'
import { insightProfileService } from './insightProfileService'
import { salesDbService, type CustomerProfile } from './salesDbService'
import { applyParsedStageSignal } from './salesInsightWrite'
import { extractEvidence, toMessageSnippets } from './salesStageClassifier'
import { persistSummaryJudgment } from './salesSummaryJudgment'
import { crmDbService } from './crmDbService'
import { enrichCustomer } from './crmEnrichService'
import { enqueueSalesTask } from './salesQueue'
import { massSendDetector, scanMessagesForTrigger, classifyInsightMessage } from './insightNoiseFilter'
import { isInsightBlacklisted } from '../../shared/insightBlacklist'
import {
  insightRecordService,
  type InsightRecordLog,
  type InsightRecordTriggerReason,
  type MessageInsightAnalysis
} from './insightRecordService'

// ─── 常量 ────────────────────────────────────────────────────────────────────
// （原 DB_CHANGE_DEBOUNCE_MS / SILENCE_SCAN_INITIAL_DELAY_MS 随自动链路一并删除，PRD §5.4/R）

/** 触发扫描窗口：拉最新 N 条判断「新消息里是否有客户发言」（设计-AI见解重定位 §2.2） */
const TRIGGER_SCAN_WINDOW = 10
// 自动触发见解的重复分析去重窗口（内存冷却重启即丢，故用记录级去重兜底）
// 24h：同一客户 24 小时内不重复 AI 分析（2026-08-20 需求）
const INSIGHT_RECORD_DEDUP_MS = 24 * 3600 * 1000

/** 单次 API 请求超时（毫秒） */
const API_TIMEOUT_MS = 45_000
const API_MAX_TOKENS_DEFAULT = 1024
const API_MAX_TOKENS_MIN = 1
const API_MAX_TOKENS_MAX = 2_000_000
const API_TEMPERATURE = 0.7
const INSIGHT_NOTIFICATION_AVATAR_URL = './assets/insight/AI_Insight.png'
const MIMO_FOOTPRINT_MIN_TOKENS = 4096
const FOOTPRINT_API_TEMPERATURE = 0.2

const DEFAULT_FOOTPRINT_SYSTEM_PROMPT = `你是“我的微信足迹”模块的总结器，只能根据用户提供的统计数据生成最终复盘文案。
硬性输出规则：
1. 只输出最终总结正文，不输出思考过程、步骤、标题、列表、JSON、Markdown、代码块、引号或字段名。
2. 输出 2 句中文，总长度 60-160 字，最多 180 字。
3. 第 1 句概括联络活跃度、回复情况或 @我情况；第 2 句给出一个当天/当前范围内可执行的沟通建议。
4. 必须引用至少 2 个输入数字，例如人数、回复率、@我次数或群聊数。
5. 数据为 0 时如实说明，不臆测具体聊天内容、关系、情绪、诊断或原因。
6. 禁止出现“首先”“其次”“根据”“综上”“作为AI”“我认为”“以下是”等过程性表达。
输出格式：直接输出两句自然中文。`

/** 高意向预警冷却（毫秒），同一客户在此窗口内不重复弹预警 */
const ALERT_COOLDOWN_MS = 6 * 3600 * 1000
/**
 * 显式单客户触发方式（2026-09-13 屏蔽名单重定义）。
 * 这两个 trigger 经 generateInsightForSession 进入闸门，且都是用户主动发起的一次性动作，
 * **不**受 AI 见解屏蔽名单约束；其余 trigger（activity / silence / alert:* 等自动与批量类）
 * 命中名单即跳过。
 *
 * `message_analysis`（信箱「深度解析」）今日不走本方法、直接写记录，本就不受限；
 * 列在此处是防御——将来若把它接进 generateInsightForSession，仍应保持「手动放行」语义。
 */
const EXPLICIT_MANUAL_TRIGGER_REASONS = new Set<string>(['manual', 'test', 'message_analysis'])
const INSIGHT_CONFIG_KEYS = new Set([
  'aiInsightEnabled',
  'aiModelApiBaseUrl',
  'aiModelApiKey',
  'aiModelApiModel',
  'aiModelApiMaxTokens',
  'aiInsightFilterMode',
  'aiInsightFilterList',
  'aiInsightNonCustomerBlacklist',
  'aiInsightAllowMomentsContext',
  'aiInsightMomentsContextCount',
  'aiInsightMomentsBindings',
  'aiInsightAllowSocialContext',
  'aiInsightSocialContextCount',
  'aiInsightWeiboCookie',
  'aiInsightWeiboBindings',
  'dbPath',
  'decryptKey',
  'myWxid'
])

// ─── 类型 ────────────────────────────────────────────────────────────────────

interface TodayTriggerRecord {
  /** 该会话今日触发的时间戳列表（毫秒） */
  timestamps: number[]
}

interface SessionInsightTriggerResult {
  success: boolean
  message: string
  recordId?: string
  insight?: string
  skipped?: boolean
  notificationEnabled?: boolean
}

type InsightFilterMode = 'whitelist' | 'blacklist'

interface CallApiOptions {
  temperature?: number
  disableThinking?: boolean
  useMaxCompletionTokens?: boolean
  responseFormatJson?: boolean
}

// ─── 日志 ─────────────────────────────────────────────────────────────────────

type InsightLogLevel = 'INFO' | 'WARN' | 'ERROR'

function insightDebugLine(_level: InsightLogLevel, _message: string): void {
  // Desktop debug log export has been replaced by per-insight request logs.
}

function insightDebugSection(_level: InsightLogLevel, _title: string, _payload: unknown): void {
  // Desktop debug log export has been replaced by per-insight request logs.
}

/**
 * 输出到 console，并落盘到 weflow-sales.log（便于打包版排查销售 AI/扫描/预警问题）。
 */
function insightLog(level: InsightLogLevel, message: string): void {
  if (level === 'ERROR' || level === 'WARN') {
    console.warn(`[InsightService] ${message}`)
  } else {
    console.log(`[InsightService] ${message}`)
  }
  insightDebugLine(level, message)
  salesLog(level, `[InsightService] ${message}`)
}

// ─── 工具函数 ─────────────────────────────────────────────────────────────────

function getStartOfDay(date: Date = new Date()): number {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function normalizeApiMaxTokens(value: unknown): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return API_MAX_TOKENS_DEFAULT
  return Math.min(API_MAX_TOKENS_MAX, Math.max(API_MAX_TOKENS_MIN, Math.floor(numeric)))
}

// 共享实现见 ai/promptUtils；本文件保留同名导出，scripts/insight-dedup-test.ts 仍从此处导入
export { normalizeSessionIdList }

function isMimoModel(apiBaseUrl: string, model: string): boolean {
  const target = `${apiBaseUrl} ${model}`.toLowerCase()
  return target.includes('mimo') || target.includes('xiaomi')
}

function buildFootprintSystemPrompt(customPrompt: string): string {
  const custom = String(customPrompt || '').trim()
  if (!custom || custom === DEFAULT_FOOTPRINT_SYSTEM_PROMPT) {
    return DEFAULT_FOOTPRINT_SYSTEM_PROMPT
  }
  return `${DEFAULT_FOOTPRINT_SYSTEM_PROMPT}

用户自定义补充要求如下，只能在不违反上述硬性输出规则时执行：
${custom}`
}

function normalizeFootprintInsight(text: string): string {
  let normalized = String(text || '').trim()
  if (!normalized) return ''

  if (normalized.startsWith('{') && normalized.endsWith('}')) {
    try {
      const parsed = JSON.parse(normalized)
      const value = parsed?.summary || parsed?.insight || parsed?.content || parsed?.text
      if (typeof value === 'string' && value.trim()) {
        normalized = value.trim()
      }
    } catch { }
  }

  normalized = normalized
    .replace(/^```(?:text|markdown|md|json)?/i, '')
    .replace(/```$/i, '')
    .replace(/^(足迹复盘|AI足迹总结|AI 足迹总结|总结|建议)[:：]\s*/i, '')
    .replace(/^\s*[-*•]\s*/gm, '')
    .replace(/\s*\n+\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()

  if (normalized.length > 180) {
    const sliced = normalized.slice(0, 180)
    const lastStop = Math.max(sliced.lastIndexOf('。'), sliced.lastIndexOf('！'), sliced.lastIndexOf('？'))
    normalized = lastStop >= 60 ? sliced.slice(0, lastStop + 1) : `${sliced.replace(/[，,；;、\s]+$/g, '')}。`
  }

  return normalized
}

function parseMessageInsightAnalysis(rawOutput: string): MessageInsightAnalysis {
  let parsed: unknown
  try {
    parsed = JSON.parse(stripJsonFence(rawOutput))
  } catch {
    throw new Error('模型输出格式异常：不是合法 JSON')
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('模型输出格式异常：JSON 根节点不是对象')
  }
  const source = parsed as Record<string, unknown>
  const explicitText = clampText(source.explicit_text ?? source.explicitText, 120)
  const emotion = clampText(source.emotion, 16)
  const intent = clampText(source.intent, 20)
  const topic = clampText(source.topic, 20)
  if (!explicitText || !emotion || !intent || !topic) {
    throw new Error('模型输出格式异常：缺少必要字段')
  }
  return { explicitText, emotion, intent, topic }
}

/**
 * 调用 OpenAI 兼容 API（非流式），返回模型第一条消息内容。
 * 统一走 ai/aiApiClient，账本记账与日上限闸门在该层生效。
 */
function callApi(
  apiBaseUrl: string,
  apiKey: string,
  model: string,
  messages: Array<{ role: string; content: string }>,
  timeoutMs: number = API_TIMEOUT_MS,
  maxTokens: number = API_MAX_TOKENS_DEFAULT,
  options: CallApiOptions = {}
): Promise<string> {
  // 日上限由 aiBudget 的全局 provider 兜底（见 configureAiBudget），
  // 因此这里手工拼的 AiModelConfig 不会绕开闸门（PRD §5.5）
  return callChatCompletion({ apiBaseUrl, apiKey, model, maxTokens }, messages as ChatMessage[], {
    ...options, timeoutMs, maxTokens, usageContext: { purpose: 'insight', promptVersion: 'legacy-v1' }
  })
}


class InsightService {
  private readonly config: ConfigService

  /**
   * 当日触发记录：sessionId -> TodayTriggerRecord
   * 每天 00:00 之后自动重置（通过检查日期实现）
   */
  private todayTriggers: Map<string, TodayTriggerRecord> = new Map()
  private todayDate = getStartOfDay()

  /**
   * 本地会话快照缓存，供人工触发的画像/见解路径读取会话列表。
   * 首次调用时填充；TTL 内复用，避免重复 connect() + getSessions()。
   */
  private sessionCache: ChatSession[] | null = null
  /** sessionCache 最后刷新时间戳（ms），超过 15 分钟强制重新拉取 */
  private sessionCacheAt = 0
  /** 缓存 TTL 设为 15 分钟，大幅减少 connect() + getSessions() 调用频率 */
  private static readonly SESSION_CACHE_TTL_MS = 15 * 60 * 1000
  /** 数据库是否已连接（避免重复调用 chatService.connect()） */
  private dbConnected = false

  private started = false

  constructor() {
    this.config = ConfigService.getInstance()
  }

  // ── 公开 API ────────────────────────────────────────────────────────────────

  /**
   * 生命周期入口。**不注册任何定时器**：本服务的 AI 调用一律由人触发
   * （客户 360 的「AI 识别这个客户」、今日行动页的简报/重生成、设置页的测试与批量画像）。
   *
   * 定位修正（2026-09-12，PRD §5.4/R）：原先的「DB 变更 2s 防抖 → 分析最近活跃会话 →
   * 自动写 archive 评论 + 自动通知」链路，以及「沉默联系人定时扫描（含 120min 每会话冷却）」
   * 已整体删除。因此：
   *  · 2s 防抖刹车与 120min 冷却刹车随链路一并消失，不再需要单独简化；
   *  · 原 `handleDbMonitorChange` 里 `if (this.processing) return` 的静默丢弃缺陷随方法删除而消失
   *    （改为「没有自动入口」而不是「自动入口静默丢弃」）；
   *  · 内存 `lastSeenTimestamp` 由持久化的 `salesDb.ai_scan_cursor` 取代（PRD §5.1 W1b）。
   */
  start(): void {
    if (this.started) return
    this.started = true
    insightLog('INFO', 'AI 见解服务已启动（仅按需触发，无后台自动链路）')
  }

  stop(): void {
    this.started = false
    this.clearRuntimeCache()
    insightProfileService.cancelActiveTask('AI 见解服务已停止，画像任务已取消')
  }

  async handleConfigChanged(key: string): Promise<void> {
    const normalizedKey = String(key || '').trim()
    if (!INSIGHT_CONFIG_KEYS.has(normalizedKey)) return

    // 数据库相关配置变更后，丢弃缓存并强制下次重连
    if (normalizedKey === 'aiInsightAllowSocialContext' || normalizedKey === 'aiInsightSocialContextCount' || normalizedKey === 'aiInsightWeiboCookie' || normalizedKey === 'aiInsightWeiboBindings') {
      weiboService.clearCache()
    }

    if (normalizedKey === 'dbPath' || normalizedKey === 'decryptKey' || normalizedKey === 'myWxid') {
      insightProfileService.cancelActiveTask('数据库或账号配置已变化，画像任务已取消')
      this.clearRuntimeCache()
    }
  }

  handleConfigCleared(): void {
    this.clearRuntimeCache()
    insightProfileService.cancelActiveTask('配置已清除，画像任务已取消')
  }

  private clearRuntimeCache(): void {
    this.dbConnected = false
    this.sessionCache = null
    this.sessionCacheAt = 0
    this.todayTriggers.clear()
    this.todayDate = getStartOfDay()
    weiboService.clearCache()
  }

  /**
   * 测试 API 连接，返回 { success, message }。
   * 供设置页"测试连接"按钮调用。
   */
  async testConnection(): Promise<{ success: boolean; message: string }> {
    const { apiBaseUrl, apiKey, model, maxTokens } = this.getSharedAiModelConfig()

    if (!apiBaseUrl || !apiKey) {
      return { success: false, message: '请先填写 API 地址和 API Key' }
    }

    try {
      const endpoint = buildApiUrl(apiBaseUrl, '/chat/completions')
      const requestMessages = [{ role: 'user', content: '请回复"连接成功"四个字。' }]
      insightDebugSection(
        'INFO',
        'AI 测试连接请求',
        [
          `Endpoint: ${endpoint}`,
          `Model: ${model}`,
          `Max Tokens: ${maxTokens}`,
          '',
          '用户提示词：',
          requestMessages[0].content
        ].join('\n')
      )

      const result = await callApi(
        apiBaseUrl,
        apiKey,
        model,
        requestMessages,
        15_000,
        maxTokens
      )
      insightDebugSection('INFO', 'AI 测试连接输出原文', result)
      return { success: true, message: `连接成功，模型回复：${result.slice(0, 50)}` }
    } catch (e) {
      insightDebugSection(
        'ERROR',
        'AI 测试连接失败',
        `错误信息：${(e as Error).message}\n\n堆栈：\n${(e as Error).stack || '[无堆栈]'}`
      )
      return { success: false, message: `连接失败：${(e as Error).message}` }
    }
  }

  /**
   * 手动对最近一个允许的私聊会话触发一次见解（设置页调试按钮）。
   * 属用户显式触发，非自动链路；冷却机制已随白天自动链路删除（PRD §5.4）。
   * 返回触发结果描述，供设置页展示。
   */
  async triggerTest(): Promise<{ success: boolean; message: string }> {
    insightLog('INFO', '手动触发测试见解...')
    const { apiBaseUrl, apiKey } = this.getSharedAiModelConfig()
    if (!apiBaseUrl || !apiKey) {
      return { success: false, message: '请先填写 API 地址和 Key' }
    }
    try {
      const connectResult = await chatService.connect()
      if (!connectResult.success) {
        return { success: false, message: '数据库连接失败，请先在"数据库连接"页完成配置' }
      }
      const sessionsResult = await chatService.getSessions()
      if (!sessionsResult.success || !sessionsResult.sessions || sessionsResult.sessions.length === 0) {
        return { success: false, message: '未找到任何会话，请确认数据库已正确连接' }
      }
      // 找第一个允许的私聊
      const session = (sessionsResult.sessions as ChatSession[]).find((s) => {
        const id = s.username?.trim() || ''
        return id && !id.endsWith('@chatroom') && !id.toLowerCase().includes('placeholder') && this.isSessionAllowed(id)
      })
      if (!session) {
        return { success: false, message: '未找到任何可触发的私聊会话（请检查黑白名单模式与选择列表）' }
      }
      const sessionId = session.username?.trim() || ''
      const displayName = session.displayName || sessionId
      insightLog('INFO', `测试目标会话：${displayName} (${sessionId})`)
      const result = await this.generateInsightForSession({
        sessionId,
        displayName,
        triggerReason: 'test'
      })
      if (!result.success) {
        return { success: false, message: result.message }
      }
      const notificationEnabled = this.config.get('aiInsightNotificationEnabled') !== false
      return {
        success: true,
        message: notificationEnabled
          ? `已向「${displayName}」发送测试见解，请查看通知弹窗`
          : `已生成「${displayName}」的测试见解，AI 见解消息通知当前已关闭`
      }
    } catch (e) {
      return { success: false, message: `测试失败：${(e as Error).message}` }
    }
  }

  /**
   * 手动对指定会话立即触发一次 AI 见解。
   * 只新增触发入口；实际上下文、朋友圈/微博拼接、prompt 和入库仍走 generateInsightForSession。
   */
  async triggerSessionInsight(params: {
    sessionId: string
    displayName?: string
    avatarUrl?: string
  }): Promise<SessionInsightTriggerResult> {
    const sessionId = String(params?.sessionId || '').trim()
    if (!sessionId) {
      return { success: false, message: '当前会话无效，无法触发 AI 见解' }
    }
    if (!this.isEnabled()) {
      return { success: false, message: '请先在设置中开启「AI 见解」' }
    }

    const { apiBaseUrl, apiKey } = this.getSharedAiModelConfig()
    if (!apiBaseUrl || !apiKey) {
      return { success: false, message: '请先填写通用 AI 模型配置（API 地址和 Key）' }
    }

    try {
      const connectResult = await chatService.connect()
      if (!connectResult.success) {
        return { success: false, message: '数据库连接失败，请先在"数据库连接"页完成配置' }
      }
      this.dbConnected = true

      const rawDisplayName = typeof params?.displayName === 'string' ? params.displayName : ''
      const displayName = rawDisplayName.length > 0 ? (rawDisplayName.trim() || rawDisplayName) : sessionId
      insightLog('INFO', `手动触发当前会话见解：${displayName} (${sessionId})`)
      return await this.generateInsightForSession({
        sessionId,
        displayName,
        triggerReason: 'manual'
      })
    } catch (error) {
      return { success: false, message: `触发失败：${(error as Error).message}` }
    }
  }

  async generateFootprintInsight(params: {
    rangeLabel: string
    summary: {
      private_inbound_people?: number
      private_replied_people?: number
      private_outbound_people?: number
      private_reply_rate?: number
      mention_count?: number
      mention_group_count?: number
    }
    privateSegments?: Array<{ displayName?: string; session_id?: string; incoming_count?: number; outgoing_count?: number; message_count?: number; replied?: boolean }>
    mentionGroups?: Array<{ displayName?: string; session_id?: string; count?: number }>
  }): Promise<{ success: boolean; message: string; insight?: string }> {
    const enabled = this.config.get('aiFootprintEnabled') === true
    if (!enabled) {
      return { success: false, message: '请先在设置中开启「AI 足迹总结」' }
    }

    const { apiBaseUrl, apiKey, model, maxTokens } = this.getSharedAiModelConfig()
    if (!apiBaseUrl || !apiKey) {
      return { success: false, message: '请先填写通用 AI 模型配置（API 地址和 Key）' }
    }

    const summary = params?.summary || {}
    const rangeLabel = String(params?.rangeLabel || '').trim() || '当前范围'
    const privateSegments = Array.isArray(params?.privateSegments) ? params.privateSegments.slice(0, 6) : []
    const mentionGroups = Array.isArray(params?.mentionGroups) ? params.mentionGroups.slice(0, 6) : []
    const mimoMode = isMimoModel(apiBaseUrl, model)

    const topPrivateText = privateSegments.length > 0
      ? privateSegments
        .map((item, idx) => {
          const rawName = typeof item.displayName === 'string' && item.displayName.length > 0
            ? item.displayName
            : String(item.session_id || `联系人${idx + 1}`)
          const name = rawName.trim() || rawName
          const inbound = Number(item.incoming_count) || 0
          const outbound = Number(item.outgoing_count) || 0
          const total = Math.max(Number(item.message_count) || 0, inbound + outbound)
          return `${idx + 1}. ${name}（收${inbound}/发${outbound}/总${total}${item.replied ? '/已回复' : ''}）`
        })
        .join('\n')
      : '无'

    const topMentionText = mentionGroups.length > 0
      ? mentionGroups
        .map((item, idx) => {
          const rawName = typeof item.displayName === 'string' && item.displayName.length > 0
            ? item.displayName
            : String(item.session_id || `群聊${idx + 1}`)
          const name = rawName.trim() || rawName
          const count = Number(item.count) || 0
          return `${idx + 1}. ${name}（@我 ${count} 次）`
        })
        .join('\n')
      : '无'

    const customPrompt = String(this.config.get('aiFootprintSystemPrompt') || '').trim()
    const systemPrompt = buildFootprintSystemPrompt(customPrompt)

    const inboundPeople = Number(summary.private_inbound_people) || 0
    const repliedPeople = Number(summary.private_replied_people) || 0
    const outboundPeople = Number(summary.private_outbound_people) || 0
    const replyRate = (((Number(summary.private_reply_rate) || 0) * 100)).toFixed(1)
    const mentionCount = Number(summary.mention_count) || 0
    const mentionGroupCount = Number(summary.mention_group_count) || 0

    const userPromptBase = `任务：基于下面的“我的微信足迹”统计生成最终总结正文。

输出要求再强调一次：
- 只输出 2 句中文自然语言，不要输出分析过程。
- 不要输出 JSON / Markdown / 列表 / 标题 / 代码块。
- 第 1 句做总体观察，第 2 句给一个可执行建议。
- 必须引用至少 2 个统计数字。

统计范围：${rangeLabel}
有聊天的人数：${inboundPeople}
我有回复的人数：${outboundPeople}
实际回复了其中：${repliedPeople}
回复率：${replyRate}%
@我次数：${mentionCount}
涉及群聊：${mentionGroupCount}

私聊重点：
${topPrivateText}

群聊@我重点：
${topMentionText}

现在直接输出最终总结正文：`
    const userPrompt = appendPromptCurrentTime(userPromptBase)

    try {
      const result = await callApi(
        apiBaseUrl,
        apiKey,
        model,
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        25_000,
        mimoMode ? Math.max(maxTokens, MIMO_FOOTPRINT_MIN_TOKENS) : maxTokens,
        {
          temperature: FOOTPRINT_API_TEMPERATURE,
          disableThinking: mimoMode,
          useMaxCompletionTokens: mimoMode
        }
      )
      const insight = normalizeFootprintInsight(result)
      if (!insight) return { success: false, message: '模型返回为空' }
      return { success: true, message: '生成成功', insight }
    } catch (error) {
      return { success: false, message: `生成失败：${(error as Error).message}` }
    }
  }

  async generateMessageInsight(params: {
    sessionId: string
    displayName?: string
    avatarUrl?: string
    targetLocalId?: number
    targetCreateTime?: number
    targetMessageKey?: string
    targetText: string
    targetSenderName?: string
    contextCount?: number
    forceRefresh?: boolean
  }): Promise<{ success: boolean; message: string; cached?: boolean; recordId?: string; data?: MessageInsightAnalysis }> {
    const enabled = this.config.get('aiMessageInsightEnabled') === true
    if (!enabled) {
      return { success: false, message: '请先在设置中开启「消息解析」' }
    }

    const sessionId = String(params?.sessionId || '').trim()
    const targetText = clampText(params?.targetText || '', 500)
    const targetCreateTime = Math.floor(Number(params?.targetCreateTime || 0))
    const targetLocalId = Math.floor(Number(params?.targetLocalId || 0))
    const targetMessageKey = String(params?.targetMessageKey || '').trim()
    if (!sessionId || !targetText || targetCreateTime <= 0) {
      return { success: false, message: '目标消息无效，无法解析' }
    }

    if (params?.forceRefresh !== true) {
      const cached = insightRecordService.findLatestMessageAnalysis({
        sessionId,
        targetLocalId,
        targetCreateTime,
        targetMessageKey
      })
      if (cached?.messageInsight?.analysis) {
        return {
          success: true,
          message: '已读取缓存解析',
          cached: true,
          recordId: cached.id,
          data: cached.messageInsight.analysis
        }
      }
    }

    const { apiBaseUrl, apiKey, model, maxTokens } = this.getSharedAiModelConfig()
    if (!apiBaseUrl || !apiKey) {
      return { success: false, message: '请先填写通用 AI 模型配置（API 地址和 Key）' }
    }

    const configuredContextCount = Number(this.config.get('aiMessageInsightContextCount') || 50)
    const contextCount = Math.max(1, Math.min(200, Math.floor(Number(params?.contextCount || configuredContextCount) || 50)))
    const displayName = await this.resolveInsightSessionDisplayName(sessionId, String(params?.displayName || sessionId))
    const targetSenderName = clampText(params?.targetSenderName || displayName, 40) || displayName
    const targetTextPreview = clampText(targetText, 120)
    let avatarUrl = String(params?.avatarUrl || '').trim() || undefined
    if (!avatarUrl) {
      try {
        const contact = await chatService.getContactAvatar(sessionId)
        avatarUrl = String(contact?.avatarUrl || '').trim() || undefined
      } catch {
        avatarUrl = undefined
      }
    }

    let beforeMessages: Message[] = []
    let afterMessages: Message[] = []
    let contextReadError = ''
    try {
      const aroundResult = await chatService.getMessagesAround(
        sessionId,
        { localId: targetLocalId, createTime: targetCreateTime, messageKey: targetMessageKey },
        contextCount
      )
      if (aroundResult.success) {
        beforeMessages = aroundResult.before || []
        afterMessages = aroundResult.after || []
      } else {
        contextReadError = aroundResult.error || '读取上下文失败'
      }
    } catch (error) {
      contextReadError = (error as Error).message || String(error)
    }

    const formatLine = (message: Message) => {
      const senderName = message.isSend === 1 ? '我' : (message.senderDisplayName || targetSenderName || displayName)
      return `${this.formatInsightMessageTimestamp(message.createTime)} ${senderName}：${this.formatInsightMessageContent(message)}`
    }
    const beforeText = beforeMessages.length > 0 ? beforeMessages.map(formatLine).join('\n') : '无'
    const afterText = afterMessages.length > 0 ? afterMessages.map(formatLine).join('\n') : '无'

    const DEFAULT_MESSAGE_INSIGHT_PROMPT = `你是一个克制、准确的聊天语义分析助手。你的任务是把用户选中的一句聊天消息做深度解析，帮助用户理解对方未明说的含义。

严格要求：
1. 必须且只能输出合法的纯 JSON。
2. 禁止输出解释说明、前言后语，禁止使用 Markdown 或代码块。
3. 不要编造上下文没有支持的信息；不确定时用谨慎表述。
4. explicit_text 用自然中文说明这句话可能想表达的真实含义，80字以内。
5. emotion、intent、topic 必须是短标签。

JSON 输出格式：
{
  "explicit_text": "暗示转明示，80字以内",
  "emotion": "2-6字情绪标签",
  "intent": "2-8字意图标签",
  "topic": "2-8字话题标签"
}`
    const customPrompt = String(this.config.get('aiMessageInsightSystemPrompt') || '').trim()
    const systemPrompt = customPrompt || DEFAULT_MESSAGE_INSIGHT_PROMPT
    const userPromptBase = `会话：${displayName}
目标发送者：${targetSenderName}
目标消息时间：${this.formatInsightMessageTimestamp(targetCreateTime)}

目标消息：
${targetText}

目标消息之前的上下文（${beforeMessages.length} 条）：
${beforeText}

目标消息之后的上下文（${afterMessages.length} 条）：
${afterText}

请分析目标消息，只输出指定 JSON。`
    const userPrompt = appendPromptCurrentTime(userPromptBase)
    const endpoint = buildApiUrl(apiBaseUrl, '/chat/completions')
    const requestMessages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ]

    let rawOutput = ''
    let responseFormatJson = true
    let responseFormatFallback = false
    let responseFormatFallbackReason = ''
    const startedAt = Date.now()
    try {
      try {
        rawOutput = await callApi(apiBaseUrl, apiKey, model, requestMessages, API_TIMEOUT_MS, maxTokens, { responseFormatJson: true })
      } catch (error) {
        if (!shouldFallbackJsonMode(error)) throw error
        responseFormatJson = false
        responseFormatFallback = true
        responseFormatFallbackReason = (error as Error).message || 'response_format 不受支持'
        rawOutput = await callApi(apiBaseUrl, apiKey, model, requestMessages, API_TIMEOUT_MS, maxTokens)
      }
      const analysis = parseMessageInsightAnalysis(rawOutput)
      const finalInsight = analysis.explicitText
      const log: InsightRecordLog = {
        endpoint,
        model,
        maxTokens,
        temperature: API_TEMPERATURE,
        triggerReason: 'message_analysis',
        allowContext: true,
        contextCount,
        systemPrompt,
        userPrompt,
        rawOutput,
        finalInsight,
        durationMs: Date.now() - startedAt,
        createdAt: Date.now(),
        responseFormatJson,
        responseFormatFallback,
        responseFormatFallbackReason,
        targetMessage: {
          localId: targetLocalId,
          createTime: targetCreateTime,
          messageKey: targetMessageKey,
          senderName: targetSenderName,
          textPreview: targetTextPreview
        },
        contextStats: {
          requested: contextCount,
          beforeTarget: beforeMessages.length,
          afterTarget: afterMessages.length,
          readError: contextReadError || undefined
        },
        parsedAnalysis: analysis
      }
      const record = insightRecordService.addRecord({
        sessionId,
        displayName,
        avatarUrl,
        sourceType: 'message_analysis',
        triggerReason: 'message_analysis',
        insight: finalInsight,
        messageInsight: {
          targetLocalId,
          targetCreateTime,
          targetMessageKey,
          targetSenderName,
          targetTextPreview,
          analysis
        },
        log
      })
      return { success: true, message: '解析完成', cached: false, recordId: record.id, data: analysis }
    } catch (error) {
      return { success: false, message: `解析失败：${(error as Error).message}` }
    }
  }

  // ── 私有方法 ────────────────────────────────────────────────────────────────

  private isEnabled(): boolean {
    return this.config.get('aiInsightEnabled') === true
  }

  private getSharedAiModelConfig(): AiModelConfig {
    const apiBaseUrl = String(
      this.config.get('aiModelApiBaseUrl')
      || this.config.get('aiInsightApiBaseUrl')
      || ''
    ).trim()
    const apiKey = String(
      this.config.get('aiModelApiKey')
      || this.config.get('aiInsightApiKey')
      || ''
    ).trim()
    const model = String(
      this.config.get('aiModelApiModel')
      || this.config.get('aiInsightApiModel')
      || 'gpt-4o-mini'
    ).trim() || 'gpt-4o-mini'
    const maxTokens = normalizeApiMaxTokens(this.config.get('aiModelApiMaxTokens'))

    return { apiBaseUrl, apiKey, model, maxTokens }
  }

  private looksLikeWxid(text: string): boolean {
    const normalized = String(text || '').trim()
    if (!normalized) return false
    return /^wxid_[a-z0-9]+$/i.test(normalized)
      || /^[a-z0-9_]+@chatroom$/i.test(normalized)
  }

  private looksLikeXmlPayload(text: string): boolean {
    const normalized = String(text || '').trim()
    if (!normalized) return false
    return /^(<\?xml|<msg\b|<appmsg\b|<img\b|<emoji\b|<voip\b|<sysmsg\b|&lt;\?xml|&lt;msg\b|&lt;appmsg\b)/i.test(normalized)
  }

  private normalizeInsightText(text: string): string {
    return String(text || '')
      .replace(/\r\n/g, '\n')
      .replace(/\u0000/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  }

  private formatInsightMessageTimestamp(createTime: number): string {
    const ms = createTime > 1_000_000_000_000 ? createTime : createTime * 1000
    const date = new Date(ms)
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    const hours = String(date.getHours()).padStart(2, '0')
    const minutes = String(date.getMinutes()).padStart(2, '0')
    const seconds = String(date.getSeconds()).padStart(2, '0')
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`
  }

  private async resolveInsightSessionDisplayName(sessionId: string, fallbackDisplayName: string): Promise<string> {
    const rawFallback = typeof fallbackDisplayName === 'string' ? fallbackDisplayName : ''
    const fallback = rawFallback.trim() || rawFallback
    // 常见路径：fallback 是真实名字（非微信号格式）→ 直接采用，不查库
    if (fallback && !isSessionIdLike(fallback)) {
      return fallback
    }

    // fallback 是微信号（wxid_/自定义微信号/群号）→ 微信真实备注（contact.remark 优先）是名字真相源
    try {
      const contact = await chatService.getContactAvatar(sessionId)
      const rawContactDisplayName = typeof contact?.displayName === 'string' ? contact.displayName : ''
      const contactDisplayName = rawContactDisplayName.trim() || rawContactDisplayName
      if (contactDisplayName && !isSessionIdLike(contactDisplayName)) {
        return contactDisplayName
      }
    } catch {
      // ignore display name lookup failures
    }

    try {
      const sessions = await this.getSessionsCached()
      const matched = sessions.find((session) => String(session.username || '').trim() === sessionId)
      const rawCachedDisplayName = typeof matched?.displayName === 'string' ? matched.displayName : ''
      const cachedDisplayName = rawCachedDisplayName.trim() || rawCachedDisplayName
      if (cachedDisplayName && !isSessionIdLike(cachedDisplayName)) {
        return cachedDisplayName
      }
    } catch {
      // ignore display name lookup failures
    }

    return fallback || sessionId
  }

  private formatInsightMessageContent(message: Message): string {
    const parsedContent = this.normalizeInsightText(String(message.parsedContent || ''))
    const quotedPreview = this.normalizeInsightText(String(message.quotedContent || ''))
    const quotedSender = this.normalizeInsightText(String(message.quotedSender || ''))

    if (quotedPreview) {
      const cleanQuotedSender = quotedSender && !this.looksLikeWxid(quotedSender) ? quotedSender : ''
      const quoteLabel = cleanQuotedSender ? `${cleanQuotedSender}：${quotedPreview}` : quotedPreview
      const replyText = parsedContent && parsedContent !== '[引用消息]' ? parsedContent : ''
      return replyText ? `${replyText}[引用 ${quoteLabel}]` : `[引用 ${quoteLabel}]`
    }

    if (parsedContent) {
      return parsedContent
    }

    const rawContent = this.normalizeInsightText(String(message.rawContent || ''))
    if (rawContent && !this.looksLikeXmlPayload(rawContent)) {
      return rawContent
    }

    return '[其他消息]'
  }

  private buildInsightContextSection(messages: Message[], peerDisplayName: string): { text: string; hasNoise: boolean } {
    if (!messages.length) return { text: '', hasNoise: false }

    let hasNoise = false
    const lines = messages.map((message) => {
      let senderName = message.isSend === 1 ? '我' : peerDisplayName
      let content = this.formatInsightMessageContent(message)
      const cls = classifyInsightMessage(message)
      if (cls === 'system') {
        // 系统消息（你已添加了…/拍一拍等）归因「系统」，不冒充对方发言（设计-AI见解重定位 §2.3）
        senderName = '系统'
        content = `[系统消息] ${content}`
        hasNoise = true
      } else if (cls === 'own' && massSendDetector.isMassSendTemplate(content)) {
        content = `【疑似群发·批量触达】${content}`
        hasNoise = true
      }
      return `${this.formatInsightMessageTimestamp(message.createTime)} '${senderName}'\n${content}`
    })

    return {
      text: `近期聊天记录（最近 ${lines.length} 条）：\n\n${lines.join('\n\n')}`,
      hasNoise
    }
  }

  /**
   * 判断某个会话是否允许触发见解。
   * white/black 模式二选一：
   * - whitelist：仅名单内允许
   * - blacklist：名单内屏蔽，其他允许
   */
  private getInsightFilterConfig(): { mode: InsightFilterMode; list: string[] } {
    const modeRaw = String(this.config.get('aiInsightFilterMode') || '').trim().toLowerCase()
    const mode: InsightFilterMode = modeRaw === 'blacklist' ? 'blacklist' : 'whitelist'
    const list = normalizeSessionIdList(this.config.get('aiInsightFilterList'))
    return { mode, list }
  }

  /**
   * 是否命中「AI 见解屏蔽名单」。
   *
   * 2026-09-13 重定义：名单由用户手动管理（设置页 / 客户工作台），不再有 AI 自动写入链路。
   * 语义边界（P0-5 拍板）：不触发 AI 见解 ≠ 非客户，该名单是见解链专用。
   * 兼容读旧 `string[]` 存储，归一逻辑见 shared/insightBlacklist.ts。
   */
  private isNonCustomerBlacklisted(sessionId: string): boolean {
    return isInsightBlacklisted(this.config.get('aiInsightNonCustomerBlacklist'), sessionId)
  }

  /**
   * 会话是否通过用户手动配置的 whitelist/blacklist 过滤。
   *
   * ⛔ 此处**不再**判定 AI 见解屏蔽名单：屏蔽名单的判定依据是「触发方式」，
   * 统一在 generateInsightForSession 内按 triggerReason 裁决（显式单客户触发放行）。
   * 勿把 isNonCustomerBlacklisted 加回本方法，否则手动触发会被重新挡死。
   */
  private isSessionAllowed(sessionId: string): boolean {
    const normalizedSessionId = String(sessionId || '').trim()
    if (!normalizedSessionId) return false
    const { mode, list } = this.getInsightFilterConfig()
    if (mode === 'whitelist') return list.includes(normalizedSessionId)
    return !list.includes(normalizedSessionId)
  }

  /**
   * 获取会话列表，优先使用缓存（15 分钟 TTL）。
   * 缓存命中时完全跳过数据库访问，避免频繁 connect() + getSessions() 消耗 CPU。
   * forceRefresh=true 时强制重新拉取（仅用于沉默扫描等低频场景）。
   */
  private async getSessionsCached(forceRefresh = false): Promise<ChatSession[]> {
    const now = Date.now()
    // 缓存命中：直接返回，零数据库操作
    if (
      !forceRefresh &&
      this.sessionCache !== null &&
      now - this.sessionCacheAt < InsightService.SESSION_CACHE_TTL_MS
    ) {
      return this.sessionCache
    }
    // 缓存未命中或强制刷新：连接数据库并拉取
    try {
      // 只在首次或强制刷新时调用 connect()，避免重复建立连接
      if (!this.dbConnected || forceRefresh) {
        const connectResult = await chatService.connect()
        if (!connectResult.success) {
          insightLog('WARN', '数据库连接失败，使用旧缓存')
          return this.sessionCache ?? []
        }
        this.dbConnected = true
      }
      const result = await chatService.getSessions()
      if (result.success && result.sessions) {
        this.sessionCache = result.sessions as ChatSession[]
        this.sessionCacheAt = now
      }
    } catch (e) {
      insightLog('WARN', `获取会话缓存失败: ${(e as Error).message}`)
      // 连接可能已断开，下次强制重连
      this.dbConnected = false
    }
    return this.sessionCache ?? []
  }

  private resetIfNewDay(): void {
    const todayStart = getStartOfDay()
    if (todayStart > this.todayDate) {
      this.todayDate = todayStart
      this.todayTriggers.clear()
    }
  }

  /**
   * 记录成功推送的见解，用于设置页展示今日触发统计。
   */
  private recordTrigger(sessionId: string): void {
    this.resetIfNewDay()
    const existing = this.todayTriggers.get(sessionId) ?? { timestamps: [] }
    existing.timestamps.push(Date.now())
    this.todayTriggers.set(sessionId, existing)
  }

  private formatWeiboTimestamp(raw: string): string {
    const parsed = Date.parse(String(raw || ''))
    if (!Number.isFinite(parsed)) {
      return String(raw || '').trim()
    }
    return new Date(parsed).toLocaleString('zh-CN')
  }

  private formatMomentsTimestamp(raw: unknown): string {
    const numeric = Number(raw)
    if (!Number.isFinite(numeric) || numeric <= 0) {
      return ''
    }
    const ms = numeric > 1_000_000_000_000 ? numeric : numeric * 1000
    return new Date(ms).toLocaleString('zh-CN')
  }

  private extractMomentReadableText(post: { contentDesc?: unknown; linkTitle?: unknown }): string {
    const contentDesc = this.normalizeInsightText(String(post.contentDesc || '')).replace(/\s+/g, ' ').trim()
    if (contentDesc) return contentDesc

    const linkTitle = this.normalizeInsightText(String(post.linkTitle || '')).replace(/\s+/g, ' ').trim()
    if (linkTitle) return `[链接] ${linkTitle}`

    return ''
  }

  private async getMomentsContextSection(sessionId: string): Promise<string> {
    const allowMomentsContext = this.config.get('aiInsightAllowMomentsContext') === true
    if (!allowMomentsContext) return ''

    const bindings =
      (this.config.get('aiInsightMomentsBindings') as Record<string, { enabled?: boolean }> | undefined) || {}
    const isEnabledForSession = bindings[sessionId]?.enabled === true
    if (!isEnabledForSession) return ''

    const countRaw = Number(this.config.get('aiInsightMomentsContextCount') || 5)
    const momentsCount = Math.max(1, Math.min(20, Math.floor(countRaw) || 5))

    try {
      const result = await snsService.getTimeline(momentsCount, 0, [sessionId])
      const posts = result.success && Array.isArray(result.timeline) ? result.timeline : []
      if (posts.length === 0) return ''

      const lines = posts
        .map((post) => {
          const text = this.extractMomentReadableText(post as { contentDesc?: unknown; linkTitle?: unknown })
          if (!text) return ''
          const shortText = text.length > 180 ? `${text.slice(0, 180)}...` : text
          const time = this.formatMomentsTimestamp((post as { createTime?: unknown }).createTime)
          return time ? `[朋友圈 ${time}] ${shortText}` : `[朋友圈] ${shortText}`
        })
        .filter(Boolean) as string[]

      if (lines.length === 0) return ''
      insightLog('INFO', `已加载 ${lines.length} 条朋友圈内容 (sessionId=${sessionId})`)
      return `近期朋友圈内容（最近 ${lines.length} 条）：\n${lines.join('\n')}`
    } catch (error) {
      insightLog('WARN', `拉取朋友圈内容失败 (sessionId=${sessionId}): ${(error as Error).message}`)
      return ''
    }
  }

  private async getSocialContextSection(sessionId: string): Promise<string> {
    const allowSocialContext = this.config.get('aiInsightAllowSocialContext') === true
    if (!allowSocialContext) return ''

    const rawCookie = String(this.config.get('aiInsightWeiboCookie') || '').trim()

    const bindings =
      (this.config.get('aiInsightWeiboBindings') as Record<string, { uid?: string; screenName?: string }> | undefined) || {}
    const binding = bindings[sessionId]
    const uid = String(binding?.uid || '').trim()
    if (!uid) return ''

    const socialCountRaw = Number(this.config.get('aiInsightSocialContextCount') || 3)
    const socialCount = Math.max(1, Math.min(5, Math.floor(socialCountRaw) || 3))

    try {
      const posts = await weiboService.fetchRecentPosts(uid, rawCookie, socialCount)
      if (posts.length === 0) return ''

      const lines = posts.map((post) => {
        const time = this.formatWeiboTimestamp(post.createdAt)
        const text = post.text.length > 180 ? `${post.text.slice(0, 180)}...` : post.text
        return `[微博 ${time}] ${text}`
      })
      insightLog('INFO', `已加载 ${lines.length} 条微博公开内容 (uid=${uid})`)
      return `近期公开社交平台内容（来源：微博，最近 ${lines.length} 条）：\n${lines.join('\n')}`
    } catch (error) {
      insightLog('WARN', `拉取微博公开内容失败 (uid=${uid}): ${(error as Error).message}`)
      return ''
    }
  }



  // ── 核心见解生成 ────────────────────────────────────────────────────────────

  /** AI 见解判定出意向阶段 → 自动导入 CRM（幂等）。了解/比价/决策/成交=有意向，流失/未知不导入。返回是否导入 */
  private importIntentCustomerToCrm(sessionId: string, displayName: string, salesStage: string): boolean {
    if (!sessionId || sessionId.endsWith('@chatroom')) return false
    const STAGE_TO_CRM: Record<string, string> = {
      了解: 'contacted', 比价: 'negotiating', 决策: 'negotiating', 成交: 'won'
    }
    const crmStage = STAGE_TO_CRM[salesStage]
    if (!crmStage) return false
    try {
      const res = crmDbService.importCustomerFromProfile({
        name: displayName,
        sessionId,
        stage: crmStage,
        reason: `AI 见解阶段：${salesStage}`
      })
      salesLog('INFO', `[CrmImport] AI 见解判定「${displayName}」有意向（${salesStage}）→ CRM ${crmStage}（${res.created ? '新建' : '已存在'}）`)
      // 商机阶段联动（P0）：客户阶段推进 → 活跃商机同步（了解→比价→决策 顺推；成交→待登记提醒；流失→自动丢单）
      if (res.id) {
        try {
          const synced = crmDbService.syncOpportunityStageByAccount(Number(res.id), salesStage)
          if (synced > 0) salesLog('INFO', `[CrmImport] 商机阶段联动「${displayName}」(${salesStage}) 更新 ${synced} 个商机`)
        } catch { /* crmDb 未初始化忽略 */ }
      }
      return true
    } catch (e) {
      salesLog('WARN', `[CrmImport] 见解导入失败 ${displayName}: ${e}`)
      return false
    }
  }

  private async generateInsightForSession(params: {
    sessionId: string
    displayName: string
    triggerReason: InsightRecordTriggerReason
    silentDays?: number
    salesStage?: string
  }): Promise<SessionInsightTriggerResult> {
    const scope = salesDbService.captureScope()
    const { sessionId, displayName, triggerReason, silentDays, salesStage } = params
    if (!sessionId) return { success: false, message: '会话无效，无法生成见解' }
    if (!this.isEnabled()) return { success: false, message: '请先在设置中开启「AI 见解」' }
    let crmImported = false // 本次是否自动导入 CRM（用于提示）

    // ── AI 见解屏蔽名单闸门（2026-09-13 重定义）────────────────────────────────
    // 判定依据是「触发方式」而非调用点：自动/批量类命中名单直接跳过；
    // 用户显式单客户触发（manual / test / message_analysis）一律放行——用户主动点的
    // 操作不该被历史误判静默挡掉，但放行时带一句轻提示，不静默（六态纪律）。
    const blacklisted = this.isNonCustomerBlacklisted(sessionId)
    const explicitlyTriggered = EXPLICIT_MANUAL_TRIGGER_REASONS.has(triggerReason)
    if (blacklisted && !explicitlyTriggered) {
      insightLog('INFO', `跳过 ${displayName}：命中 AI 见解屏蔽名单（触发方式 ${triggerReason}）`)
      return {
        success: true,
        message: `「${displayName}」在 AI 见解屏蔽名单中，已跳过；如需对 TA 生成见解，请在客户工作台解除屏蔽`,
        skipped: true
      }
    }
    const blacklistBypassNote = blacklisted
      ? '（注意：TA 在 AI 见解屏蔽名单中，本次为你手动触发，已放行）'
      : ''
    // 防重复分析：自动触发（活跃/沉默/批量）12h 内已有该客户见解记录则跳过。
    // 根因：冷却标记在内存、应用重启即清零，导致同一客户被反复分析几十次。
    // 手动触发保留覆盖权利（用户主动点，允许重析）。
    if (triggerReason !== 'manual' && insightRecordService.hasRecentRecord(sessionId, INSIGHT_RECORD_DEDUP_MS)) {
      insightLog('INFO', `跳过 ${displayName}：24h 内已生成过见解（触发 ${triggerReason}）`)
      return { success: true, message: `最近已生成过见解，跳过${blacklistBypassNote}`, skipped: true }
    }

    const { apiBaseUrl, apiKey, model, maxTokens } = this.getSharedAiModelConfig()
    const allowContext = this.config.get('aiInsightAllowContext') as boolean
    const contextCount = (this.config.get('aiInsightContextCount') as number) || 40
    const resolvedDisplayName = await this.resolveInsightSessionDisplayName(sessionId, displayName)
    let resolvedAvatarUrl: string | undefined
    try {
      const contact = await chatService.getContactAvatar(sessionId)
      resolvedAvatarUrl = String(contact?.avatarUrl || '').trim() || undefined
    } catch {
      resolvedAvatarUrl = undefined
    }

    insightLog('INFO', `generateInsightForSession: sessionId=${sessionId}, reason=${triggerReason}, contextCount=${contextCount}, api=${apiBaseUrl ? '已配置' : '未配置'}`)

    if (!apiBaseUrl || !apiKey) {
      insightLog('WARN', 'API 地址或 Key 未配置，跳过见解生成')
      return { success: false, message: '请先填写通用 AI 模型配置（API 地址和 Key）' }
    }

    // ── 构建 prompt ────────────────────────────────────────────────────────────

    let contextSection = ''
    let contextHasNoise = false
    // P0-2C.2：summary 判断的证据（客户最近一条实质消息原话，P0-1 护栏；无可靠 key → unavailable 不伪造）
    let summaryEvidence: { messageKey?: string; evidenceText?: string } = {}
    if (allowContext) {
      try {
        const msgsResult = await chatService.getLatestMessages(sessionId, contextCount)
        if (msgsResult.success && msgsResult.messages && msgsResult.messages.length > 0) {
          const messages: Message[] = msgsResult.messages
          // 上下文里的 own 文本顺带喂群发检测器（被动采集点，零额外查询）
          for (const hit of scanMessagesForTrigger(messages, 0).ownTexts) {
            massSendDetector.recordOwnText(sessionId, hit.content, hit.createTime)
          }
          const context = this.buildInsightContextSection(messages, resolvedDisplayName)
          contextSection = context.text
          contextHasNoise = context.hasNoise
          summaryEvidence = extractEvidence(toMessageSnippets(messages))
          insightLog('INFO', `已加载 ${messages.length} 条上下文消息`)
        }
      } catch (e) {
        insightLog('WARN', `拉取上下文失败: ${(e as Error).message}`)
      }
    }

    const momentsContextSection = await this.getMomentsContextSection(sessionId)
    const socialContextSection = await this.getSocialContextSection(sessionId)
    const profileContextSection = insightProfileService.getProfileContextSection(sessionId)

    // ── 默认 system prompt（稳定内容，有利于 provider 端 prompt cache 命中）────
    const DEFAULT_SYSTEM_PROMPT = `你是用户的私人关系观察助手，名叫"见解"。你的任务是主动提供有价值的观察和建议。

要求：
1. 必须给出见解。基于聊天记录分析对方情绪、话题趋势、关系动态，或给出回复建议、聊天话题推荐。
2. 控制在 80 字以内，直接、具体、一针见血。不要废话。
3. 输出纯文本，不使用 Markdown。
4. 只有在完全没有任何可说的内容时（比如对话只有一条"嗯"），才回复"SKIP"。绝大多数情况下你应该输出见解。`

    // 统一 system prompt（保持不变以命中 API 缓存）
    // 销售/通用场景的差异化指令全部放在 user prompt 中
    const customPrompt = (this.config.get('aiInsightSystemPrompt') as string) || ''
    const systemPrompt = customPrompt.trim() || DEFAULT_SYSTEM_PROMPT

    // 销售上下文（放在 user prompt 中，不影响 system prompt 缓存命中）
    let salesInstruction = ''
    if (salesStage) {
      if (triggerReason === 'silence' && silentDays) {
        salesInstruction = `【销售场景】客户「${resolvedDisplayName}」当前阶段：${salesStage}，已 ${silentDays} 天未联系。请从销售角度分析：判断沉默原因（1句）+ 给出自然的重新接触话术（1句）。输出≤80字纯文本。`
      } else {
        salesInstruction = `【销售场景】客户「${resolvedDisplayName}」当前阶段：${salesStage}。请关注购买意向、价格敏感、竞品对比等信号，发现信号在末尾标注【信号：xxx】，并给出跟进建议。输出≤80字纯文本。`
      }
    }
    // 噪音护栏：仅当上下文含系统/群发标注时追加（无噪音时 prompt 保持原样，利于缓存命中）
    const noiseGuardrail = contextHasNoise
      ? '[系统消息]为微信或自动化工具产生，不代表对方发言；【疑似群发】为你方批量触达模板。禁止将两者解读为对方的行为、意向或回复。'
      : ''
    const userPromptBase = [
      noiseGuardrail,
      triggerReason === 'silence' && silentDays && !salesStage
        ? `已 ${silentDays} 天未联系「${resolvedDisplayName}」。`
        : '',
      salesInstruction,
      contextSection,
      profileContextSection,
      momentsContextSection,
      socialContextSection,
      salesStage ? '' : '请给出你的见解（≤80字）：',
      '另外，根据聊天内容判断该客户当前采购阶段，在最后一行单独输出：【阶段：了解/比价/决策/成交/流失/未知】（只选一个，不确定就输出"未知"）'
    ].filter(Boolean).join('\n\n')
    const userPrompt = appendPromptCurrentTime(userPromptBase)

    const endpoint = buildApiUrl(apiBaseUrl, '/chat/completions')
    const requestMessages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ]

    insightLog('INFO', `准备调用 API: ${endpoint}，模型: ${model}`)
    insightDebugSection(
      'INFO',
      `AI 请求 ${resolvedDisplayName} (${sessionId})`,
      [
        `接口地址：${endpoint}`,
        `模型：${model}`,
        `Max Tokens：${maxTokens}`,
        `触发类型：${triggerReason}`,
        `上下文开关：${allowContext ? '开启' : '关闭'}`,
        `上下文条数：${contextCount}`,
        '',
        '系统提示词：',
        systemPrompt,
        '',
        '用户提示词：',
        userPrompt
      ].join('\n')
    )

    try {
      if (scope !== salesDbService.captureScope()) return { success: false, message: "账号已切换" }
      const apiStartedAt = Date.now()
      const result = await callApi(
        apiBaseUrl,
        apiKey,
        model,
        requestMessages,
        API_TIMEOUT_MS,
        maxTokens
      )
      if (scope !== salesDbService.captureScope()) return { success: false, message: "账号已切换，结果已放弃" }
      const apiDurationMs = Date.now() - apiStartedAt

      insightLog('INFO', `API 返回原文: ${result.slice(0, 150)}`)
      insightDebugSection('INFO', `AI 输出原文 ${resolvedDisplayName} (${sessionId})`, result)

      // 模型主动选择跳过
      if (result.trim().toUpperCase() === 'SKIP' || result.trim().startsWith('SKIP')) {
        insightLog('INFO', `模型选择跳过 ${resolvedDisplayName}`)
        return { success: true, message: `模型判断「${resolvedDisplayName}」暂无可生成的见解`, skipped: true }
      }
      if (!this.isEnabled()) return { success: false, message: 'AI 见解已关闭，生成结果未保存' }

      // 解析阶段标签并自动更新客户画像
      let parsedStage: string | undefined
      let insight = result.trim()
      const stageMatch = insight.match(/【阶段[：:]\s*(了解|比价|决策|成交|流失|未知)\s*】/)
      if (stageMatch) {
        parsedStage = stageMatch[1]
        insight = insight.replace(/\s*【阶段[：:]\s*(了解|比价|决策|成交|流失|未知)\s*】\s*/, '').trim()
        // 「阶段=未知 → 自动加入非客户黑名单」的链路已于 2026-09-13 随屏蔽名单重定义删除：
        // 未知表示证据不足，本就不该据此判定，更不该自动写名单（现名单纯手动管理）。
        // P0-2A.4：不再直接修改 customer_profile.stage。AI 阶段判断降级为 signal：
        // 只建档/改名（display_name）+ intent_tag_log 判断记录；stage 由合法写者维护。
        if (parsedStage !== '未知') {
          applyParsedStageSignal(sessionId, resolvedDisplayName, parsedStage)
          insightLog('INFO', `记录 AI 阶段判断 signal（不覆盖 stage）：${resolvedDisplayName} → ${parsedStage}`)
        }
        // 高意向活跃预警：本次解析出比价/决策阶段时弹窗（受冷却控制）
        if ((parsedStage === '比价' || parsedStage === '决策') && this.shouldAlert(sessionId, parsedStage)) {
          insightLog('INFO', `高意向活跃预警：${resolvedDisplayName} → ${parsedStage}`)
          void showNotification({
            sessionId,
            channel: 'sales-alert',
            title: '🔥 高意向客户提醒',
            content: `${resolvedDisplayName}（${parsedStage}）刚表达决策意向，建议尽快跟进`,
            avatarUrl: resolvedAvatarUrl
          })
        }
      }
      const finalSalesStage = parsedStage && parsedStage !== '未知' ? parsedStage : salesStage
      const notifTitle = `见解 · ${resolvedDisplayName}`
      const recordLog: InsightRecordLog = {
        endpoint,
        model,
        maxTokens,
        temperature: API_TEMPERATURE,
        triggerReason,
        allowContext,
        contextCount,
        systemPrompt,
        userPrompt,
        rawOutput: result,
        finalInsight: insight,
        durationMs: apiDurationMs,
        createdAt: Date.now()
      }
      const record = insightRecordService.addRecord({
        sessionId,
        displayName: resolvedDisplayName,
        avatarUrl: resolvedAvatarUrl,
        // 自动见解（activity/silence/test/manual 等）落 archive：进档案标注，不进信箱/卡流
        // （设计-AI见解重定位 §3.2）；'insight' 预留给阶段三告警（triggerReason='alert:*'）
        sourceType: 'archive',
        triggerReason,
        insight,
        log: recordLog,
        salesStage: finalSalesStage
      })

      // P0-2C.2：summary 判断落 customer_judgment（append-only；证据=客户最近一条实质消息，
      // 无可靠 messageKey → evidence unavailable 不伪造）。落库失败不阻断见解主流程。
      try {
        persistSummaryJudgment({
          sessionId,
          insight,
          model: recordLog.model,
          generatedAt: recordLog.createdAt,
          triggerReason,
          evidence: summaryEvidence
        })
      } catch (e) {
        insightLog('WARN', `summary 判断落库失败（不阻断见解主流程）: ${(e as Error).message}`)
      }

      // AI 见解判定出意向阶段 → 自动导入 CRM（幂等；了解/比价/决策/成交=有意向）
      if (finalSalesStage) crmImported = this.importIntentCustomerToCrm(sessionId, resolvedDisplayName, finalSalesStage)
      // 导入成功 → AI 自动填充客户信息（enqueue 串行；enrichCustomer 内部不 enqueue）
      if (crmImported) void enqueueSalesTask(() => enrichCustomer(sessionId, resolvedDisplayName).then(() => undefined))

      const insightNotificationEnabled = this.config.get('aiInsightNotificationEnabled') !== false
      if (insightNotificationEnabled) {
        insightLog('INFO', `推送通知 → ${resolvedDisplayName}: ${insight}`)

        // 渠道一：应用内通知窗口。AI 见解使用独立通知开关，不受新消息通知开关和会话过滤影响。
        await showNotification({
          title: notifTitle,
          content: insight,
          avatarUrl: INSIGHT_NOTIFICATION_AVATAR_URL,
          sessionId,
          insightRecordId: record.id,
          channel: 'ai-insight'
        })
      } else {
        insightLog('INFO', `AI 见解消息通知已关闭，跳过应用通知 → ${resolvedDisplayName}: ${insight}`)
      }

      // 渠道二：Telegram Bot 推送（可选）
      const telegramEnabled = this.config.get('aiInsightTelegramEnabled') as boolean
      if (telegramEnabled) {
        const telegramToken = (this.config.get('aiInsightTelegramToken') as string) || ''
        const telegramChatIds = (this.config.get('aiInsightTelegramChatIds') as string) || ''
        if (telegramToken && telegramChatIds) {
          const chatIds = telegramChatIds.split(',').map((s) => s.trim()).filter(Boolean)
          const telegramText = `【WeFlow】 ${notifTitle}\n\n${insight}`
          for (const chatId of chatIds) {
            this.sendTelegram(telegramToken, chatId, telegramText).catch((e) => {
              insightLog('WARN', `Telegram 推送失败 (chatId=${chatId}): ${(e as Error).message}`)
            })
          }
        } else {
          insightLog('WARN', 'Telegram 已启用但 Token 或 Chat ID 未填写，跳过')
        }
      }

      insightLog('INFO', `已完成 ${resolvedDisplayName} 的见解处理`)
      this.recordTrigger(sessionId)
      const crmNote = crmImported ? '，已自动导入 CRM 客户' : ''
      return {
        success: true,
        message: (insightNotificationEnabled
          ? `已生成「${resolvedDisplayName}」的 AI 见解，请查看通知弹窗`
          : `已生成「${resolvedDisplayName}」的 AI 见解，AI 见解消息通知当前已关闭`) + crmNote + blacklistBypassNote,
        recordId: record.id,
        insight,
        notificationEnabled: insightNotificationEnabled
      }
    } catch (e) {
      insightDebugSection(
        'ERROR',
        `AI 请求失败 ${resolvedDisplayName} (${sessionId})`,
        `错误信息：${(e as Error).message}\n\n堆栈：\n${(e as Error).stack || '[无堆栈]'}`
      )
      insightLog('ERROR', `API 调用失败 (${resolvedDisplayName}): ${(e as Error).message}`)
      return { success: false, message: `生成失败：${(e as Error).message}` }
    }
  }

  /**
   * 通过 Telegram Bot API 发送消息。
   * 使用 Node 原生 https 模块，无需第三方依赖。
   */
  private sendTelegram(token: string, chatId: string, text: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
      const options = {
        hostname: 'api.telegram.org',
        port: 443,
        path: `/bot${token}/sendMessage`,
        method: 'POST' as const,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body).toString()
        }
      }
      const req = https.request(options, (res) => {
        let data = ''
        res.on('data', (chunk) => { data += chunk })
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data)
            if (parsed.ok) {
              resolve()
            } else {
              reject(new Error(parsed.description || '未知错误'))
            }
          } catch {
            reject(new Error(`响应解析失败: ${data.slice(0, 100)}`))
          }
        })
      })
      req.setTimeout(15_000, () => { req.destroy(); reject(new Error('Telegram 请求超时')) })
      req.on('error', reject)
      req.write(body)
      req.end()
    })
  }

  // ── 批量画像 ─────────────────────────────────────────────────────────────────

  /** 高意向预警冷却记录：sessionId -> 上次预警时间 */
  private alertCooldown = new Map<string, number>()

  private batchRunning = false
  private batchProgress = { total: 0, done: 0, running: false }

  getBatchProgress() { return { ...this.batchProgress } }

  /** 高意向预警冷却判断：命中冷却返回 false，否则记录时间返回 true */
  private shouldAlert(sessionId: string, _stage: string): boolean {
    const now = Date.now()
    const last = this.alertCooldown.get(sessionId) || 0
    if (now - last < ALERT_COOLDOWN_MS) return false
    this.alertCooldown.set(sessionId, now)
    return true
  }

  /**
   * 批量画像：遍历活跃客户，逐个调用 generateInsightForSession 提取阶段
   * @param limit 每次处理数量（默认 50）
   * @param monthsBack 回溯几个月内的活跃客户（默认 6）
   */
  async batchProfile(limit: number = 50, monthsBack: number = 6): Promise<{ success: boolean; processed?: number; error?: string }> {
    return enqueueSalesTask(() => this.batchProfileCore(limit, monthsBack))
  }

  /** 批量画像内核（不 enqueue：外层 batchProfile 已排队，内部再 enqueue 会死锁） */
  private async batchProfileCore(limit: number = 50, monthsBack: number = 6): Promise<{ success: boolean; processed?: number; error?: string }> {
    if (!this.isEnabled()) return { success: false, error: '请先开启 AI 见解' }

    this.batchRunning = true
    this.batchProgress = { total: 0, done: 0, running: true }

    try {
      const sessions = await this.getSessionsCached(true)
      const cutoffMs = Date.now() - monthsBack * 30 * 24 * 60 * 60 * 1000

      // 过滤：单聊、非系统、最近 N 月有消息、尚未分析过的
      const candidates = sessions.filter((s: any) => {
        const sid = s.username?.trim() || ''
        if (!sid || sid.endsWith('@chatroom') || sid.startsWith('gh_')) return false
        const lastTs = (s.lastTimestamp || 0) * 1000
        if (lastTs < cutoffMs) return false  // 超过 N 月没消息的跳过
        // 检查是否已有画像（stage 非 unknown）
        try {
          const profile = salesDbService.customerGetBySession(sid)
          if (profile && profile.stage && profile.stage !== 'unknown') return false
        } catch { /* ignore */ }
        return true
      })

      this.batchProgress.total = Math.min(candidates.length, limit)
      let processed = 0

      for (const session of candidates.slice(0, limit)) {
        if (!this.isEnabled()) break
        const sessionId = session.username?.trim() || ''
        const displayName = session.displayName?.trim() || sessionId

        try {
          await this.generateInsightForSession({
            sessionId,
            displayName,
            triggerReason: 'activity',
            salesStage: undefined  // 让 AI 自动判断
          })
          processed++
          this.batchProgress.done = processed
        } catch { /* 单个失败不影响整体 */ }
      }

      this.batchProgress.running = false
      return { success: true, processed }
    } catch (e) {
      this.batchProgress.running = false
      return { success: false, error: String(e) }
    } finally {
      this.batchRunning = false
    }
  }
}

export const insightService = new InsightService()
