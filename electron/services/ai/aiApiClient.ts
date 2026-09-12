import { startUsage, recordBlockedCall, readAiUsage, type UsageContext } from './aiUsageLedger'
import { AiBudgetBlockedError, currentDailyCallLimit, dailyUsage, evaluateBudget } from './aiBudget'
/**
 * aiApiClient.ts
 *
 * 共享 AI API 调用层：从 insightService / insightProfileService 中抽取的公共逻辑。
 * 使用 Node 原生 https/http 模块调用 OpenAI 兼容 API（支持 DeepSeek），无需第三方 SDK。
 *
 * 所有需要 AI 能力的业务服务（报表摘要、意向分级、回复建议等）统一通过本模块调用。
 */

import https from 'https'
import http from 'http'
import { URL } from 'url'
import { ConfigService } from '../config'

// ─── 常量 ────────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 45_000
const DEFAULT_MAX_TOKENS = 1024
const MAX_TOKENS_MIN = 1
const MAX_TOKENS_MAX = 2_000_000
const DEFAULT_TEMPERATURE = 0.7

// ─── 类型 ────────────────────────────────────────────────────────────────────

export interface AiModelConfig {
  apiBaseUrl: string
  apiKey: string
  model: string
  maxTokens: number
  /** 每日调用上限（PRD §5.5）；<=0 或未传表示不限。由 getAiModelConfig 从配置读取。 */
  dailyCallLimit?: number
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface CallOptions {
  usageContext?: UsageContext
  /** 覆盖默认温度 */
  temperature?: number
  /** 覆盖默认超时（毫秒） */
  timeoutMs?: number
  /** 覆盖默认 maxTokens */
  maxTokens?: number
  /** 禁用思考模式（部分模型支持） */
  disableThinking?: boolean
  /** 使用 max_completion_tokens 而非 max_tokens */
  useMaxCompletionTokens?: boolean
  /** 要求返回 JSON 格式 */
  responseFormatJson?: boolean
  /** vision：附带 base64 图片（OpenAI 兼容 image_url parts） */
  imagesBase64?: Array<{ data: string; mime: string }>
  /** 中止信号 */
  signal?: AbortSignal
}

export class AiApiError extends Error {
  statusCode?: number
  responseBody?: string

  constructor(message: string, statusCode?: number, responseBody?: string) {
    super(message)
    this.name = 'AiApiError'
    this.statusCode = statusCode
    this.responseBody = responseBody
  }
}

// ─── 工具函数 ─────────────────────────────────────────────────────────────────

function buildApiUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '')
  const suffix = path.startsWith('/') ? path : `/${path}`
  return `${base}${suffix}`
}

function normalizeMaxTokens(value: unknown): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return DEFAULT_MAX_TOKENS
  return Math.min(MAX_TOKENS_MAX, Math.max(MAX_TOKENS_MIN, Math.floor(numeric)))
}

/**
 * 生成“关闭思考”扩展参数。该字段不是 OpenAI 标准字段，各兼容服务商支持度不同：
 * DeepSeek 接受 enable_thinking=false；GLM（含官方 bigmodel.cn 端点）会以
 * 400/1210 拒绝该字段，因此对 GLM 省略扩展参数，保持模型默认行为。
 */
export function buildDisableThinkingPayload(config: Pick<AiModelConfig, 'apiBaseUrl' | 'model'>): Record<string, unknown> {
  let isBigModelHost = false
  try {
    const hostname = new URL(config.apiBaseUrl).hostname.toLowerCase()
    isBigModelHost = hostname === 'bigmodel.cn' || hostname.endsWith('.bigmodel.cn')
  } catch { /* URL 合法性由请求入口统一报告 */ }
  const isGlmModel = /^glm(?:[-_.]|$)/i.test(String(config.model || '').trim())
  return isBigModelHost || isGlmModel ? {} : { enable_thinking: false }
}

// ─── 额度闸门（PRD §5.5） ──────────────────────────────────────────────────────

/**
 * 请求发出前的额度判定。达到上限时写一条 status='blocked' 账本行并抛 AiBudgetBlockedError——
 * 阻断发生在 HTTP 之前，绝不静默超支。
 * 账本读取失败时不阻断（宁放行不漏拦）：额度是成本护栏，不是正确性前提。
 */
export function assertWithinBudget(config: Pick<AiModelConfig, 'model' | 'dailyCallLimit'>, context: UsageContext = {}): void {
  // 显式传入优先（便于测试），否则取全局 provider——保证手工拼的 config 也受闸门约束
  const limit = Math.floor(Number(config.dailyCallLimit) || 0) || currentDailyCallLimit()
  if (limit <= 0) return
  let used = 0
  try {
    const daily = dailyUsage(readAiUsage())
    // 阻断行不计入已用次数，否则阻断本身会把计数推高，越拦越死
    used = daily.calls - daily.blockedCalls
  } catch { return }
  const verdict = evaluateBudget(used, limit)
  if (verdict.level !== 'blocked') return
  recordBlockedCall(config.model, context, verdict.message)
  throw new AiBudgetBlockedError(verdict)
}

// ─── 核心调用 ─────────────────────────────────────────────────────────────────

/**
 * 调用 OpenAI 兼容的 /chat/completions 接口（非流式），返回模型回复文本。
 * 所有 AI 调用都必须经过本函数：账本记账与日上限拦截只在这一层生效。
 */
export function callChatCompletion(
  config: AiModelConfig,
  messages: ChatMessage[],
  options: CallOptions = {}
): Promise<string> {
  assertWithinBudget(config, options.usageContext)
  const recordUsage = startUsage(config.model, options.usageContext)
  return new Promise<string>((resolve, reject) => {
    const { apiBaseUrl, apiKey, model } = config
    const endpoint = buildApiUrl(apiBaseUrl, '/chat/completions')

    let urlObj: URL
    try {
      urlObj = new URL(endpoint)
    } catch {
      reject(new AiApiError(`无效的 API URL: ${endpoint}`))
      return
    }

    const maxTokens = normalizeMaxTokens(options.maxTokens ?? config.maxTokens)
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

    const payload: Record<string, unknown> = {
      model,
      messages,
      temperature: options.temperature ?? DEFAULT_TEMPERATURE,
      stream: false
    }

    if (options.useMaxCompletionTokens) {
      payload.max_completion_tokens = maxTokens
    } else {
      payload.max_tokens = maxTokens
    }

    if (options.disableThinking) {
      Object.assign(payload, buildDisableThinkingPayload(config))
    }

    if (options.responseFormatJson) {
      payload.response_format = { type: 'json_object' }
    }

    if (options.imagesBase64?.length) {
      const msgs = (payload.messages as ChatMessage[]).map((m) => ({ ...m }))
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === 'user' && typeof msgs[i].content === 'string') {
          const text = msgs[i].content as string
          ;(msgs[i] as unknown as Record<string, unknown>).content = [
            { type: 'text', text },
            ...options.imagesBase64.map((img) => ({ type: 'image_url', image_url: { url: `data:${img.mime};base64,${img.data}` } }))
          ]
          break
        }
      }
      payload.messages = msgs
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
            reject(new AiApiError(
              `API 请求失败 (${res.statusCode}): ${data.slice(0, 200)}`,
              res.statusCode,
              data
            ))
            return
          }
          const parsed = JSON.parse(data)
          recordUsage(parsed?.usage, String(parsed?.choices?.[0]?.finish_reason || 'unknown'), 'response')
          if (parsed?.choices?.[0]?.finish_reason === 'length') {
            reject(new AiApiError('模型输出被截断，请增加输出上限后重试')); return
          }
          const content = parsed?.choices?.[0]?.message?.content
          if (typeof content === 'string' && content.trim()) {
            resolve(content.trim())
          } else {
            const finishReason = parsed?.choices?.[0]?.finish_reason
            const reasoningContent = parsed?.choices?.[0]?.message?.reasoning_content
            if (typeof reasoningContent === 'string' && reasoningContent.trim()) {
              reject(new AiApiError(
                `API 仅返回推理内容未返回正文${finishReason ? `（finish_reason=${finishReason}）` : ''}，请增大最大输出 Token 或关闭思考模式`
              ))
              return
            }
            reject(new AiApiError(
              `API 返回格式异常${finishReason ? `（finish_reason=${finishReason}）` : ''}: ${data.slice(0, 200)}`
            ))
          }
        } catch {
          reject(new AiApiError(`JSON 解析失败: ${data.slice(0, 200)}`))
        }
      })
    })

    req.setTimeout(timeoutMs, () => {
      req.destroy()
      reject(new AiApiError('API 请求超时'))
    })

    req.on('error', (e) => {
      if (options.signal?.aborted) {
        reject(new AiApiError('请求已取消'))
      } else {
        reject(e)
      }
    })

    // 支持 AbortSignal
    if (options.signal) {
      options.signal.addEventListener('abort', () => {
        req.destroy()
      }, { once: true })
    }

    if (options.signal?.aborted) { req.destroy(); reject(new AiApiError("请求已取消")); return }
    req.write(body)
    req.end()
  }).catch(error => { recordUsage(null, 'unknown', options.signal?.aborted ? 'cancelled' : 'failed'); throw error })
}

// ─── 配置读取 ─────────────────────────────────────────────────────────────────

/**
 * 从 ConfigService 读取用户配置的 AI 模型信息。
 * 复用现有设置页的 aiModelApiBaseUrl / aiModelApiKey / aiModelApiModel 配置项。
 */
export function getAiModelConfig(config: ConfigService): AiModelConfig {
  const apiBaseUrl = String(
    config.get('aiModelApiBaseUrl')
    || config.get('aiInsightApiBaseUrl')
    || ''
  ).trim()

  const apiKey = String(
    config.get('aiModelApiKey')
    || config.get('aiInsightApiKey')
    || ''
  ).trim()

  const model = String(
    config.get('aiModelApiModel')
    || config.get('aiInsightApiModel')
    || 'deepseek-chat'
  ).trim() || 'deepseek-chat'

  const maxTokens = normalizeMaxTokens(config.get('aiModelApiMaxTokens'))

  // 日上限：关闭开关视为不限（0），开关本身是「保留为常规配置项」的落点（PRD §5.5）
  const limitEnabled = config.get('aiDailyCallLimitEnabled') !== false
  const rawLimit = Number(config.get('aiDailyCallLimit'))
  const dailyCallLimit = limitEnabled && Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : 0

  return { apiBaseUrl, apiKey, model, maxTokens, dailyCallLimit }
}

/** 当日额度快照（设置页显示与 80% 预警用） */
export function getAiBudgetSnapshot(config: ConfigService): ReturnType<typeof dailyUsage> & {
  limit: number
  level: string
  message: string
} {
  const { dailyCallLimit } = getAiModelConfig(config)
  let daily = dailyUsage([])
  try { daily = dailyUsage(readAiUsage()) } catch { /* 账本不可读：按 0 用量显示，不假装有数据 */ }
  const verdict = evaluateBudget(daily.calls - daily.blockedCalls, dailyCallLimit ?? 0)
  return { ...daily, limit: verdict.limit, level: verdict.level, message: verdict.message }
}

/**
 * 检查 AI 配置是否可用（有 URL 和 Key）。
 */
export function isAiConfigured(config: ConfigService): boolean {
  const { apiBaseUrl, apiKey } = getAiModelConfig(config)
  return !!(apiBaseUrl && apiKey)
}

// ─── 便捷封装 ─────────────────────────────────────────────────────────────────

/**
 * 简单文本补全：传入 system prompt + user message，返回 AI 回复。
 * 适用于报表摘要、意向分析等单次调用场景。
 */
export async function simpleCompletion(
  config: ConfigService,
  systemPrompt: string,
  userMessage: string,
  options: CallOptions = {}
): Promise<string> {
  const modelConfig = getAiModelConfig(config)
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage }
  ]
  return callChatCompletion(modelConfig, messages, options)
}
