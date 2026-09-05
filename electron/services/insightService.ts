/**
 * insightService.ts
 *
 * AI 见解后台服务：
 * 1. 监听 DB 变更事件（debounce 500ms 防抖，避免开机/重连时爆发大量事件阻塞主线程）
 * 2. 沉默联系人扫描（独立 setInterval，每 4 小时一次）
 * 3. 触发后拉取真实聊天上下文（若用户授权），组装 prompt 调用单一 AI 模型
 * 4. 输出 ≤80 字见解，通过现有 showNotification 弹出右下角通知
 *
 * 设计原则：
 * - 不引入任何额外 npm 依赖，使用 Node 原生 https 模块调用 OpenAI 兼容 API
 * - 所有失败静默处理，不影响主流程
 * - 触发频率、冷却与名单过滤均在本地完成，不把调度统计塞进模型 prompt
 */

import https from 'https'
import http from 'http'
import { URL } from 'url'
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
import { onNewMessage as actionStageClassifier } from './salesActionEngine'
import { massSendDetector, scanMessagesForTrigger, classifyInsightMessage } from './insightNoiseFilter'
import {
  insightRecordService,
  type InsightRecordLog,
  type InsightRecordTriggerReason,
  type MessageInsightAnalysis
} from './insightRecordService'

// ─── 常量 ────────────────────────────────────────────────────────────────────

/**
 * DB 变更防抖延迟（毫秒）。
 * 设为 2s：微信写库通常是批量操作，500ms 过短会在开机/重连时产生大量连续触发。
 */
const DB_CHANGE_DEBOUNCE_MS = 2000

/** 首次沉默扫描延迟（毫秒），避免启动期间抢占资源 */
const SILENCE_SCAN_INITIAL_DELAY_MS = 3 * 60 * 1000
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

/** 沉默天数阈值默认值 */
const DEFAULT_SILENCE_DAYS = 3
/** 高意向预警冷却（毫秒），同一客户在此窗口内不重复弹预警 */
const ALERT_COOLDOWN_MS = 6 * 3600 * 1000
const INSIGHT_CONFIG_KEYS = new Set([
  'aiInsightEnabled',
  'aiInsightScanIntervalHours',
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

interface SharedAiModelConfig {
  apiBaseUrl: string
  apiKey: string
  model: string
  maxTokens: number
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

class ApiRequestError extends Error {
  statusCode?: number
  responseBody?: string

  constructor(message: string, statusCode?: number, responseBody?: string) {
    super(message)
    this.name = 'ApiRequestError'
    this.statusCode = statusCode
    this.responseBody = responseBody
  }
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

/**
 * 绝对拼接 baseUrl 与路径，避免 Node.js URL 相对路径陷阱。
 *
 * 例如：
 *   baseUrl = "https://api.ohmygpt.com/v1"
 *   path    = "/chat/completions"
 * 结果为  "https://api.ohmygpt.com/v1/chat/completions"
 *
 * 如果 baseUrl 末尾没有斜杠，直接用字符串拼接（而非 new URL(path, base)），
 * 因为 new URL("chat/completions", "https://api.example.com/v1") 会错误地
 * 丢弃 v1，变成 https://api.example.com/chat/completions。
 */
function buildApiUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '') // 去掉末尾斜杠
  const suffix = path.startsWith('/') ? path : `/${path}`
  return `${base}${suffix}`
}

function getStartOfDay(date: Date = new Date()): number {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

function formatPromptCurrentTime(date: Date = new Date()): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `当前系统时间：${year}年${month}月${day}日 ${hours}:${minutes}`
}

function appendPromptCurrentTime(prompt: string): string {
  const base = String(prompt || '').trimEnd()
  if (!base) return formatPromptCurrentTime()
  return `${base}\n\n${formatPromptCurrentTime()}`
}

function normalizeApiMaxTokens(value: unknown): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return API_MAX_TOKENS_DEFAULT
  return Math.min(API_MAX_TOKENS_MAX, Math.max(API_MAX_TOKENS_MIN, Math.floor(numeric)))
}

export function normalizeSessionIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return Array.from(new Set(value.map((item) => String(item || '').trim()).filter(Boolean)))
}

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

function clampText(value: unknown, maxLength: number): string {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  if (text.length <= maxLength) return text
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`
}

function stripJsonFence(value: string): string {
  const text = String(value || '').trim()
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  if (fenced) return fenced[1].trim()
  const firstBrace = text.indexOf('{')
  const lastBrace = text.lastIndexOf('}')
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return text.slice(firstBrace, lastBrace + 1).trim()
  }
  return text
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

function shouldFallbackJsonMode(error: unknown): boolean {
  const statusCode = Number((error as ApiRequestError)?.statusCode || 0)
  if (statusCode === 400 || statusCode === 404 || statusCode === 422) return true
  const text = `${(error as Error)?.message || ''}\n${(error as ApiRequestError)?.responseBody || ''}`.toLowerCase()
  return text.includes('response_format') || text.includes('json_object') || text.includes('json mode')
}

/**
 * 调用 OpenAI 兼容 API（非流式），返回模型第一条消息内容。
 * 使用 Node 原生 https/http 模块，无需任何第三方 SDK。
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
  return new Promise((resolve, reject) => {
    const endpoint = buildApiUrl(apiBaseUrl, '/chat/completions')
    let urlObj: URL
    try {
      urlObj = new URL(endpoint)
    } catch (e) {
      reject(new Error(`无效的 API URL: ${endpoint}`))
      return
    }

    const normalizedMaxTokens = normalizeApiMaxTokens(maxTokens)
    const payload: Record<string, unknown> = {
      model,
      messages,
      temperature: options.temperature ?? API_TEMPERATURE,
      stream: false
    }
    if (options.useMaxCompletionTokens) {
      payload.max_completion_tokens = normalizedMaxTokens
    } else {
      payload.max_tokens = normalizedMaxTokens
    }
    if (options.disableThinking) {
      payload.thinking = { type: 'disabled' }
      payload.enable_thinking = false
    }
    if (options?.responseFormatJson) {
      payload.response_format = { type: 'json_object' }
    }
    const body = JSON.stringify(payload)

    const requestOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: 'POST' as const,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body).toString(),
        Authorization: `Bearer ${apiKey}`
      }
    }

    const isHttps = urlObj.protocol === 'https:'
    const requestFn = isHttps ? https.request : http.request
    const req = requestFn(requestOptions, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        try {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new ApiRequestError(`API 请求失败 (${res.statusCode}): ${data.slice(0, 200)}`, res.statusCode, data))
            return
          }
          const parsed = JSON.parse(data)
          const content = parsed?.choices?.[0]?.message?.content
          if (typeof content === 'string' && content.trim()) {
            resolve(content.trim())
          } else {
            const finishReason = parsed?.choices?.[0]?.finish_reason
            const reasoningContent = parsed?.choices?.[0]?.message?.reasoning_content
            if (typeof reasoningContent === 'string' && reasoningContent.trim()) {
              reject(new Error(`API 仅返回推理内容未返回正文${finishReason ? `（finish_reason=${finishReason}）` : ''}，请增大最大输出 Token 或关闭思考模式`))
              return
            }
            reject(new Error(`API 返回格式异常${finishReason ? `（finish_reason=${finishReason}）` : ''}: ${data.slice(0, 200)}`))
          }
        } catch (e) {
          reject(new Error(`JSON 解析失败: ${data.slice(0, 200)}`))
        }
      })
    })

    req.setTimeout(timeoutMs, () => {
      req.destroy()
      reject(new Error('API 请求超时'))
    })

    req.on('error', (e) => reject(e))
    req.write(body)
    req.end()
  })
}

// ─── InsightService 主类 ──────────────────────────────────────────────────────

class InsightService {
  private readonly config: ConfigService

  /** DB 变更防抖定时器 */
  private dbDebounceTimer: NodeJS.Timeout | null = null

  /** 沉默扫描定时器 */
  private silenceScanTimer: NodeJS.Timeout | null = null
  private silenceInitialDelayTimer: NodeJS.Timeout | null = null

  /** 是否正在处理中（防重入） */
  private processing = false

  /**
   * 当日触发记录：sessionId -> TodayTriggerRecord
   * 每天 00:00 之后自动重置（通过检查日期实现）
   */
  private todayTriggers: Map<string, TodayTriggerRecord> = new Map()
  private todayDate = getStartOfDay()

  /**
   * 活跃分析冷却记录：sessionId -> 上次分析时间戳（毫秒）
   * 同一会话 2 小时内不重复触发活跃分析，防止 DB 频繁变更时爆量调用 API。
   */
  private lastActivityAnalysis: Map<string, number> = new Map()

  /**
   * 沉默扫描冷却记录：sessionId -> 上次沉默扫描时间戳（毫秒）
   * 24h 滚动窗口内同一 session 不重复生成沉默洞察。
   */
  private lastSilenceScan: Map<string, number> = new Map()

  /** 沉默扫描独立锁，与活跃分析共享的 this.processing 分离 */
  private silenceScanning = false

  /**
   * 跟踪每个会话上次见到的最新消息时间戳，用于判断是否有真正的新消息。
   * sessionId -> lastMessageTimestamp（秒，与微信 DB 保持一致）
   */
  private lastSeenTimestamp: Map<string, number> = new Map()

  /**
   * 本地会话快照缓存，避免 analyzeRecentActivity 在每次 DB 变更时都做全量读取。
   * 首次调用时填充，此后只在沉默扫描里刷新（沉默扫描间隔更长，更合适做全量刷新）。
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

  start(): void {
    if (this.started) return
    this.started = true
    void this.refreshConfiguration('startup')
  }

  stop(): void {
    const hadActiveFlow =
      this.dbDebounceTimer !== null ||
      this.silenceScanTimer !== null ||
      this.silenceInitialDelayTimer !== null ||
      this.processing
    this.started = false
    this.clearTimers()
    this.clearRuntimeCache()
    this.processing = false
    insightProfileService.cancelActiveTask('AI 见解服务已停止，画像任务已取消')
    if (hadActiveFlow) {
      insightLog('INFO', '已停止')
    }
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

    await this.refreshConfiguration(`config:${normalizedKey}`)
  }

  handleConfigCleared(): void {
    this.clearTimers()
    this.clearRuntimeCache()
    insightProfileService.cancelActiveTask('配置已清除，画像任务已取消')
    this.processing = false
  }

  private async refreshConfiguration(reason: string): Promise<void> {
    if (!this.started) return
    if (!this.isEnabled()) {
      this.clearTimers()
      this.clearRuntimeCache()
      this.processing = false
      return
    }
    // 仅初次启动、间隔值变化、或 enable 状态切换时才重调度
    // 避免 prompt/notification 等无关配置变更重置扫描计时器
    const prevInterval = this._lastScanIntervalHours
    const newInterval = (this.config.get('aiInsightScanIntervalHours') as number) || 4
    if (reason === 'startup' || newInterval !== prevInterval) {
      this._lastScanIntervalHours = newInterval
      if (this.silenceScanning) {
        insightLog('INFO', '[Insight] 跳过重调度：扫描进行中，新间隔将在下次扫描结束后生效')
        return
      }
      this.scheduleSilenceScan()
    }
  }
  private _lastScanIntervalHours: number | undefined

  private clearRuntimeCache(): void {
    this.dbConnected = false
    this.sessionCache = null
    this.sessionCacheAt = 0
    this.lastActivityAnalysis.clear()
    this.lastSilenceScan.clear()
    this.lastSeenTimestamp.clear()
    this.todayTriggers.clear()
    this.todayDate = getStartOfDay()
    weiboService.clearCache()
  }

  private clearTimers(): void {
    if (this.dbDebounceTimer !== null) {
      clearTimeout(this.dbDebounceTimer)
      this.dbDebounceTimer = null
    }
    if (this.silenceScanTimer !== null) {
      clearTimeout(this.silenceScanTimer)
      this.silenceScanTimer = null
    }
    if (this.silenceInitialDelayTimer !== null) {
      clearTimeout(this.silenceInitialDelayTimer)
      this.silenceInitialDelayTimer = null
    }
  }

  /**
   * 由 main.ts 在 addDbMonitorListener 回调中调用。
   * 加入 2s 防抖，防止开机/重连时大量事件并发阻塞主线程。
   * 如果当前正在处理中，直接忽略此次事件（不创建新的 timer），避免 timer 堆积。
   */
  handleDbMonitorChange(_type: string, _json: string): void {
    if (!this.started) return
    if (!this.isEnabled()) return
    // 正在处理时忽略新事件，避免 timer 堆积
    if (this.processing) return

    if (this.dbDebounceTimer !== null) {
      clearTimeout(this.dbDebounceTimer)
    }
    this.dbDebounceTimer = setTimeout(() => {
      this.dbDebounceTimer = null
      void enqueueSalesTask(() => this.analyzeRecentActivity())
    }, DB_CHANGE_DEBOUNCE_MS)
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
   * 强制立即对最近一个私聊会话触发一次见解（忽略冷却，用于测试）。
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

  /** 获取今日触发统计（供设置页展示） */
  getTodayStats(): { sessionId: string; count: number; times: string[] }[] {
    this.resetIfNewDay()
    const result: { sessionId: string; count: number; times: string[] }[] = []
    for (const [sessionId, record] of this.todayTriggers.entries()) {
      result.push({
        sessionId,
        count: record.timestamps.length,
        times: record.timestamps.map(formatTimestamp)
      })
    }
    return result
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

  private getSharedAiModelConfig(): SharedAiModelConfig {
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
   * AI 判定非客户黑名单：sessionId 命中一律不允许触发见解。
   * 独立于 whitelist/blacklist 名单（那是用户手动配置），这里是 AI 自动判定的硬屏蔽。
   */
  private isNonCustomerBlacklisted(sessionId: string): boolean {
    const normalized = String(sessionId || '').trim()
    if (!normalized) return false
    const list = normalizeSessionIdList(this.config.get('aiInsightNonCustomerBlacklist'))
    return list.includes(normalized)
  }

  private isSessionAllowed(sessionId: string): boolean {
    const normalizedSessionId = String(sessionId || '').trim()
    if (!normalizedSessionId) return false
    // AI 判定非客户 → 硬屏蔽，不触发任何见解
    if (this.isNonCustomerBlacklisted(normalizedSessionId)) return false
    const { mode, list } = this.getInsightFilterConfig()
    if (mode === 'whitelist') return list.includes(normalizedSessionId)
    return !list.includes(normalizedSessionId)
  }

  /** AI 判定该会话为非客户（阶段=未知）→ 加入非客户黑名单并持久化 */
  private blacklistNonCustomer(sessionId: string): void {
    const normalized = String(sessionId || '').trim()
    if (!normalized) return
    const list = normalizeSessionIdList(this.config.get('aiInsightNonCustomerBlacklist'))
    if (list.includes(normalized)) return
    list.push(normalized)
    this.config.set('aiInsightNonCustomerBlacklist', list)
    insightLog('INFO', `AI 判定「${normalized}」为非客户，已加入黑名单，后续不再触发 AI 见解`)
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

  // ── 沉默联系人扫描 ──────────────────────────────────────────────────────────

  private scheduleSilenceScan(): void {
    this.clearTimers()
    if (!this.started || !this.isEnabled()) return

    // 等待扫描完成后再安排下一次，避免并发堆积
    const scheduleNext = () => {
      if (!this.started || !this.isEnabled()) return
      const intervalHours = (this.config.get('aiInsightScanIntervalHours') as number) || 4
      const intervalMs = Math.max(0.1, intervalHours) * 60 * 60 * 1000
      insightLog('INFO', `下次沉默扫描将在 ${intervalHours} 小时后执行`)
      this.silenceScanTimer = setTimeout(async () => {
        this.silenceScanTimer = null
        await enqueueSalesTask(() => this.runSilenceScan())
        scheduleNext()
      }, intervalMs)
    }

    this.silenceInitialDelayTimer = setTimeout(async () => {
      this.silenceInitialDelayTimer = null
      await enqueueSalesTask(() => this.runSilenceScan())
      scheduleNext()
    }, SILENCE_SCAN_INITIAL_DELAY_MS)
  }

  private async runSilenceScan(): Promise<void> {
    if (!this.isEnabled()) {
      return
    }
    if (this.processing || this.silenceScanning) {
      insightLog('INFO', '沉默扫描：正在处理中，跳过本次')
      return
    }

    this.processing = true
    this.silenceScanning = true
    insightLog('INFO', '开始沉默联系人扫描...')
    try {
      const silenceDays = (this.config.get('aiInsightSilenceDays') as number) || DEFAULT_SILENCE_DAYS
      const silenceMaxDays = (this.config.get('aiInsightSilenceMaxDays') as number) || 30
      const scanLimit = (this.config.get('aiInsightScanLimit') as number) || 50
      const cooldownMinutes = (this.config.get('aiInsightCooldownMinutes') as number) ?? 120
      const thresholdMs = silenceDays * 24 * 60 * 60 * 1000
      const maxThresholdMs = silenceMaxDays * 24 * 60 * 60 * 1000
      const now = Date.now()

      insightLog('INFO', `沉默阈值：${silenceDays}-${silenceMaxDays} 天，每次上限 ${scanLimit} 条`)

      // 沉默扫描间隔较长，强制刷新缓存以获取最新数据
      const sessions = await this.getSessionsCached(true)
      if (sessions.length === 0) {
        insightLog('WARN', '获取会话列表失败，跳过沉默扫描')
        return
      }

      insightLog('INFO', `共 ${sessions.length} 个会话，开始过滤...`)

      // 第一阶段：收集所有符合条件的沉默联系人
      interface SilentCandidate {
        sessionId: string
        displayName: string
        silentDays: number
        salesStage?: string
        stageWeight: number
      }
      const candidates: SilentCandidate[] = []

      for (const session of sessions) {
        const sessionId = session.username?.trim() || ''
        if (!sessionId || sessionId.endsWith('@chatroom')) continue
        if (sessionId.toLowerCase().includes('placeholder')) continue
        if (!this.isSessionAllowed(sessionId)) continue

        const lastTimestamp = (session.lastTimestamp || 0) * 1000
        if (!lastTimestamp || lastTimestamp <= 0) continue

        const silentMs = now - lastTimestamp

        // 查询客户画像阶段
        let salesStage: string | undefined
        let effectiveThresholdMs = thresholdMs
        let stageWeight = 3  // 默认最低优先级
        let profile: CustomerProfile | undefined
        try {
          profile = salesDbService.customerGetBySession(sessionId)
          if (profile?.stage) {
            salesStage = profile.stage
            // 流失客户直接跳过
            if (profile.stage === '流失') continue
            // 动态阈值
            if (profile.stage === '决策') { effectiveThresholdMs = 1 * 24 * 60 * 60 * 1000; stageWeight = 0 }
            else if (profile.stage === '比价') { effectiveThresholdMs = 2 * 24 * 60 * 60 * 1000; stageWeight = 1 }
            else if (profile.stage === '了解') { stageWeight = 2 }
          }
        } catch { /* salesDb 未初始化时忽略 */ }
        // 无名 session（salesDb 无客户档案）跳过沉默扫描——见解链只服务已识别客户（观察期防污染）
        if (!profile) continue

        // 下限：未达到沉默阈值
        if (silentMs < effectiveThresholdMs) continue
        // 上限：超过最大沉默天数，不再提醒
        if (silentMs > maxThresholdMs) continue

        const silentDaysCalc = Math.floor(silentMs / (24 * 60 * 60 * 1000))
        const displayName = typeof session.displayName === 'string' && session.displayName.length > 0
          ? (session.displayName.trim() || session.displayName)
          : sessionId

        candidates.push({ sessionId, displayName, silentDays: silentDaysCalc, salesStage, stageWeight })
      }

      // 第二阶段：按优先级排序（阶段权重升序 → 沉默天数升序）
      candidates.sort((a, b) => {
        if (a.stageWeight !== b.stageWeight) return a.stageWeight - b.stageWeight
        return a.silentDays - b.silentDays
      })

      insightLog('INFO', `符合条件 ${candidates.length} 个，取前 ${scanLimit} 个生成见解`)

      // 第三阶段：按上限生成见解
      const activityCooldownMs = (cooldownMinutes ?? 120) * 60 * 1000
      const SILENCE_COOLDOWN_MS = 24 * 3600 * 1000
      let generatedCount = 0
      for (const candidate of candidates.slice(0, scanLimit)) {
        if (!this.isEnabled()) return
        const sid = candidate.sessionId

        // Fix 1a: 活跃分析冷却检查 — 冷却期内有活跃分析则跳过
        const lastActivity = this.lastActivityAnalysis.get(sid)
        if (lastActivity && (now - lastActivity) < activityCooldownMs) continue

        // Fix 1b: 沉默扫描自身冷却 — 24h 内已扫过则跳过
        const lastSilence = this.lastSilenceScan.get(sid)
        if (lastSilence && (now - lastSilence) < SILENCE_COOLDOWN_MS) continue

        const stageLabel = candidate.salesStage ? `（${candidate.salesStage}阶段）` : ''
        insightLog('INFO', `生成沉默见解：${candidate.displayName}${stageLabel}，已沉默 ${candidate.silentDays} 天`)

        // 先标记，防止生成耗时期间被重复选中
        this.lastSilenceScan.set(sid, now)
        try {
          await this.generateInsightForSession({
            sessionId: sid,
            displayName: candidate.displayName,
            triggerReason: 'silence',
            silentDays: candidate.silentDays,
            salesStage: candidate.salesStage
          })
          generatedCount++
        } catch (err) {
          // 生成失败，撤销标记，允许下一轮重试
          this.lastSilenceScan.delete(sid)
          insightLog('WARN', `沉默洞察生成失败，已回滚冷却标记: ${candidate.displayName} — ${(err as Error)?.message || err}`)
        }
        // 高意向沉默预警：比价/决策阶段客户沉默时弹窗（受冷却控制）
        if (candidate.salesStage === '比价' || candidate.salesStage === '决策') {
          if (this.shouldAlert(candidate.sessionId, candidate.salesStage)) {
            insightLog('INFO', `高意向沉默预警：${candidate.displayName}（${candidate.salesStage}）沉默 ${candidate.silentDays} 天`)
            void showNotification({
              sessionId: candidate.sessionId,
              channel: 'sales-alert',
              title: '🔥 高意向客户沉默',
              content: `${candidate.displayName}（${candidate.salesStage}）已沉默 ${candidate.silentDays} 天，建议尽快跟进`,
              avatarUrl: undefined
            })
          }
        }
      }
      insightLog('INFO', `沉默扫描完成，共生成 ${generatedCount} 条见解（候选 ${candidates.length} 个）`)

      // 自动回填：每次扫描额外处理 10 个从未分析过的老客户（调内核，不重入队列）
      if (!this.batchRunning) {
        try {
          const backfillResult = await this.batchProfileCore(10, 12)
          if (backfillResult.success && backfillResult.processed) {
            insightLog('INFO', `自动回填：本次处理 ${backfillResult.processed} 个老客户画像`)
          }
        } catch { /* 回填失败不影响主流程 */ }
      }

      // 催办自动识别：我方发完消息客户没回 → 生成催办待办（零 AI 调用，不重入队列）
      try {
        const urgeCreated = await this.scanUrgeFollowUps()
        if (urgeCreated > 0) insightLog('INFO', `催办扫描：本次生成 ${urgeCreated} 条催办待办`)
      } catch { /* 催办失败不影响主流程 */ }
    } catch (e) {
      insightLog('ERROR', `沉默扫描出错: ${(e as Error).message}`)
    } finally {
      this.processing = false
      this.silenceScanning = false
      // Fix 3: 清理超过 7 天未更新的冷却 key
      const MAX_AGE_MS = 7 * 24 * 3600 * 1000
      const cleanNow = Date.now()
      for (const [k, v] of this.lastSilenceScan) {
        if (cleanNow - v > MAX_AGE_MS) this.lastSilenceScan.delete(k)
      }
      for (const [k, v] of this.lastActivityAnalysis) {
        if (cleanNow - v > MAX_AGE_MS) this.lastActivityAnalysis.delete(k)
      }
    }
  }

  // ── 活跃会话分析 ────────────────────────────────────────────────────────────

  /**
   * 在 DB 变更防抖后执行，分析最近活跃的会话。
   *
   * 触发条件（必须同时满足）：
   * 1. 会话有真正的新消息（lastTimestamp 比上次见到的更新）
   * 2. 该会话距上次活跃分析已超过冷却期
   *
   * whitelist 模式：直接使用名单里的 sessionId，完全跳过 getSessions()。
   * blacklist 模式：从缓存拉取会话后过滤名单。
   */
  private async analyzeRecentActivity(): Promise<void> {
    if (!this.isEnabled()) return
    if (this.processing) return

    this.processing = true
    try {
      const now = Date.now()
      const cooldownMinutes = (this.config.get('aiInsightCooldownMinutes') as number) ?? 120
      const cooldownMs = cooldownMinutes * 60 * 1000
      const { mode: filterMode, list: filterList } = this.getInsightFilterConfig()

      // whitelist 模式且有勾选项时，直接用名单 sessionId，无需查数据库全量会话列表。
      // 通过拉取该会话最新 1 条消息时间戳判断是否真正有新消息，开销极低。
      if (filterMode === 'whitelist' && filterList.length > 0) {
        // 确保数据库已连接（首次时连接，之后复用）
        if (!this.dbConnected) {
          const connectResult = await chatService.connect()
          if (!connectResult.success) return
          this.dbConnected = true
        }

        for (const sessionId of filterList) {
          if (!sessionId || sessionId.toLowerCase().includes('placeholder')) continue

          // 冷却期检查（先过滤，减少不必要的 DB 查询）
          if (cooldownMs > 0) {
            const lastAnalysis = this.lastActivityAnalysis.get(sessionId) ?? 0
            if (cooldownMs - (now - lastAnalysis) > 0) continue
          }

          // 拉最新 10 条做触发扫描：只看最新 1 条会把自己群发/系统消息误判为客户活跃
          // （群发风暴根除，设计-AI见解重定位 §2.2）
          try {
            const msgsResult = await chatService.getLatestMessages(sessionId, TRIGGER_SCAN_WINDOW)
            if (!msgsResult.success || !msgsResult.messages || msgsResult.messages.length === 0) continue

            const lastSeen = this.lastSeenTimestamp.get(sessionId) ?? 0
            const scan = scanMessagesForTrigger(msgsResult.messages, lastSeen)
            for (const hit of scan.ownTexts) {
              massSendDetector.recordOwnText(sessionId, hit.content, hit.createTime)
            }
            this.lastSeenTimestamp.set(sessionId, scan.latestTs)
            if (!scan.shouldTrigger) continue // 只有群发/系统消息更新，非客户行为，不触发
          } catch {
            continue
          }

          insightLog('INFO', `白名单会话 ${sessionId} 有新消息，准备生成见解...`)
          this.lastActivityAnalysis.set(sessionId, now)

          // displayName 使用白名单 sessionId，generateInsightForSession 内部会从上下文里获取真实名称
          await this.generateInsightForSession({
            sessionId,
            displayName: sessionId,
            triggerReason: 'activity'
          })
          break // 每次最多处理 1 个会话
        }
        return
      }

      if (filterMode === 'whitelist' && filterList.length === 0) {
        insightLog('INFO', '白名单模式且名单为空，跳过活跃分析')
        return
      }

      // blacklist 模式：拉取会话缓存后按过滤规则筛选
      const sessions = await this.getSessionsCached()
      if (sessions.length === 0) return

      const candidateSessions = sessions.filter((s) => {
        const id = s.username?.trim() || ''
        if (!id || id.toLowerCase().includes('placeholder')) return false
        return this.isSessionAllowed(id)
      })

      for (const session of candidateSessions.slice(0, 10)) {
        const sessionId = session.username?.trim() || ''
        if (!sessionId) continue
        // 无名 session（salesDb 无客户档案）跳过见解链——只服务已识别客户（观察期防污染）
        let hasProfile = false
        try { hasProfile = !!salesDbService.customerGetBySession(sessionId) } catch { /* salesDb 未初始化视为无名 */ }
        if (!hasProfile) continue

        const currentTimestamp = session.lastTimestamp || 0
        const lastSeen = this.lastSeenTimestamp.get(sessionId) ?? 0
        if (currentTimestamp <= lastSeen) continue

        if (cooldownMs > 0) {
          const lastAnalysis = this.lastActivityAnalysis.get(sessionId) ?? 0
          if (cooldownMs - (now - lastAnalysis) > 0) continue
        }

        // 拉最新 10 条确认新消息里确有客户发言（原先只看 session 时间戳，群发/系统消息
        // 也会推进时间戳导致误触发，设计-AI见解重定位 §2.2）。冷却期内不消费时间戳：
        // 冷却结束后仍能补扫到冷却期间到达的客户消息（避免客户回复被群发盖掉后丢失）。
        let customerTriggered = true
        try {
          const msgsResult = await chatService.getLatestMessages(sessionId, TRIGGER_SCAN_WINDOW)
          if (msgsResult.success && msgsResult.messages && msgsResult.messages.length > 0) {
            const scan = scanMessagesForTrigger(msgsResult.messages, lastSeen)
            for (const hit of scan.ownTexts) {
              massSendDetector.recordOwnText(sessionId, hit.content, hit.createTime)
            }
            this.lastSeenTimestamp.set(sessionId, Math.max(scan.latestTs, currentTimestamp))
            customerTriggered = scan.shouldTrigger
          }
        } catch {
          customerTriggered = true // 拉取失败保守放行，维持原行为
        }
        if (!customerTriggered) continue // 只有群发/系统消息更新，非客户行为，不触发

        const displayName = typeof session.displayName === 'string' && session.displayName.length > 0
          ? (session.displayName.trim() || session.displayName)
          : sessionId
        insightLog('INFO', `${displayName} 有新消息，准备生成见解...`)
        this.lastActivityAnalysis.set(sessionId, now)

        // 接线 AI 阶段分类器（客户新消息到达 → 分类 → 更新 customer_profile.stage）
        // 闸门之后才执行：群发/系统消息不进分类器，不浪费 API 也不误写 stage
        void actionStageClassifier(sessionId, displayName)

        await this.generateInsightForSession({
          sessionId,
          displayName,
          triggerReason: 'activity'
        })
        break
      }
    } catch (e) {
      insightLog('ERROR', `活跃分析出错: ${(e as Error).message}`)
    } finally {
      this.processing = false
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
      // 商机阶段联动（P0）：客户阶段推进 → 活跃商机同步（了解→比价→决策 顺推；成交→won；流失→lost）
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
    const { sessionId, displayName, triggerReason, silentDays, salesStage } = params
    if (!sessionId) return { success: false, message: '会话无效，无法生成见解' }
    if (!this.isEnabled()) return { success: false, message: '请先在设置中开启「AI 见解」' }
    let crmImported = false // 本次是否自动导入 CRM（用于提示）
    // 防重复分析：自动触发（活跃/沉默/批量）12h 内已有该客户见解记录则跳过。
    // 根因：冷却标记在内存、应用重启即清零，导致同一客户被反复分析几十次。
    // 手动触发保留覆盖权利（用户主动点，允许重析）。
    if (triggerReason !== 'manual' && insightRecordService.hasRecentRecord(sessionId, INSIGHT_RECORD_DEDUP_MS)) {
      insightLog('INFO', `跳过 ${displayName}：24h 内已生成过见解（触发 ${triggerReason}）`)
      return { success: true, message: '最近已生成过见解，跳过', skipped: true }
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
      const apiStartedAt = Date.now()
      const result = await callApi(
        apiBaseUrl,
        apiKey,
        model,
        requestMessages,
        API_TIMEOUT_MS,
        maxTokens
      )
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
        // AI 判定非客户（阶段=未知）→ 加入黑名单，后续不再触发 AI 见解
        if (parsedStage === '未知') {
          this.blacklistNonCustomer(sessionId)
        }
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
          : `已生成「${resolvedDisplayName}」的 AI 见解，AI 见解消息通知当前已关闭`) + crmNote,
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
   * 催办自动识别：检测"我方发完消息、客户超过 N 天没回"的会话，生成 urge_customer 待办。
   * 零 AI 调用、零外部依赖；粗筛沉默区间 + 去重 + 取最新消息判 isSend。
   * 仅在 runSilenceScan 的队列任务内被调用，不 enqueue，避免死锁。
   */
  private async scanUrgeFollowUps(): Promise<number> {
    const URGE_MIN_MS = 2 * 86400000
    const URGE_MAX_MS = 30 * 86400000
    const URGE_LIMIT = 40
    const now = Date.now()
    let created = 0
    try {
      const sessions = await this.getSessionsCached(false)
      const SYSTEM = new Set(['filehelper', 'newsapp', 'tnewsapp', 'fmessage', 'weixin', 'medianote', 'mphelper', 'weixinguanhaozhuli', 'notifymessage'])
      const candidates = sessions.filter((s: any) => {
        const sid = String(s.username || '').trim()
        if (!sid || sid.endsWith('@chatroom') || sid.startsWith('gh_') || SYSTEM.has(sid)) return false
        const silent = now - (s.lastTimestamp || 0) * 1000
        return silent >= URGE_MIN_MS && silent <= URGE_MAX_MS
      }).slice(0, URGE_LIMIT * 3)

      for (const s of candidates) {
        if (created >= URGE_LIMIT) break
        const sid = String(s.username).trim()
        // 去重：已有 pending/suspected 的催办待办则跳过
        try {
          const existing = salesDbService.todoList({ session_id: sid })
          if (existing.some((t: any) => t.trigger_type === 'urge_customer' && (t.status === 'pending' || t.status === 'suspected'))) continue
        } catch { continue }
        // 取最新一条消息，判断是否我方发出
        let lastIsSend = -1
        try {
          const r = await chatService.getLatestMessages(sid, 1)
          if (!r.success || !r.messages || r.messages.length === 0) continue
          const last = r.messages.reduce((a: any, b: any) => ((Number(b.createTime) || 0) > (Number(a.createTime) || 0) ? b : a), r.messages[0])
          lastIsSend = Number(last.isSend)
        } catch { continue }
        if (lastIsSend !== 1) continue  // 最后一条非我方发出 → 非催办场景
        const name = (typeof s.displayName === 'string' && s.displayName.trim()) ? s.displayName.trim() : sid
        try {
          salesDbService.todoCreate({
            session_id: sid,
            display_name: name,
            trigger_type: 'urge_customer',
            action_type: 'urge_customer',
            title: `[${name}] 你发的消息还没收到回复，可考虑跟进一下`,
            status: 'pending',
            created_by: 'ai',
            confidence: 0.6,
            priority_score: 0.5,
            due_at: null,
            // P0-1 证据：最近一条我方未获回复消息的 messageKey（回查原话）
            source_message_id: String(last.messageKey || '') || null
          })
          created++
          insightLog('INFO', `催办待办生成：${name}`)
        } catch { /* ignore */ }
      }
    } catch (e) {
      insightLog('ERROR', `催办扫描出错: ${(e as Error).message}`)
    }
    return created
  }

  /**
   * 批量画像：遍历活跃客户，逐个调用 generateInsightForSession 提取阶段
   * @param limit 每次处理数量（默认 50）
   * @param monthsBack 回溯几个月内的活跃客户（默认 6）
   */
  async batchProfile(limit: number = 50, monthsBack: number = 6): Promise<{ success: boolean; processed?: number; error?: string }> {
    return enqueueSalesTask(() => this.batchProfileCore(limit, monthsBack))
  }

  /** 批量画像内核（不 enqueue，供 runSilenceScan 内部回填直接调用，避免队列内重入死锁） */
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
