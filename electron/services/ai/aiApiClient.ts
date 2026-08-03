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
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface CallOptions {
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

// ─── 核心调用 ─────────────────────────────────────────────────────────────────

/**
 * 调用 OpenAI 兼容的 /chat/completions 接口（非流式），返回模型回复文本。
 */
export function callChatCompletion(
  config: AiModelConfig,
  messages: ChatMessage[],
  options: CallOptions = {}
): Promise<string> {
  return new Promise((resolve, reject) => {
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
      // thinking:{type:'disabled'} 属 /responses 接口格式，注入 /chat/completions 会被
      // deepseek 等通用兼容接口判 400；关思考在 chat-completions 只用 enable_thinking:false
      payload.enable_thinking = false
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

    req.write(body)
    req.end()
  })
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

  return { apiBaseUrl, apiKey, model, maxTokens }
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
