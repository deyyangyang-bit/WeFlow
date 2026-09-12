/**
 * promptUtils.ts —— AI prompt 链路共用的纯工具函数。
 *
 * insightService / insightProfileService / groupSummaryService 三处此前各自
 * 复制了同一套 buildApiUrl / clampText / stripJsonFence / shouldFallbackJsonMode /
 * normalizeSessionIdList / formatPromptCurrentTime / appendPromptCurrentTime，
 * 此处收敛为唯一实现，勿再各自复制。
 */

/** 错误对象的结构化视图（各 service 自有的 ApiRequestError 形状一致） */
interface ApiErrorLike {
  statusCode?: number
  responseBody?: string
  message?: string
}

/**
 * 拼接 OpenAI 兼容 endpoint。
 *
 * 例如 baseUrl="https://api.ohmygpt.com/v1"、path="/chat/completions"
 * 结果为 "https://api.ohmygpt.com/v1/chat/completions"。
 * 用字符串拼接而非 new URL(path, base)：后者会把 v1 丢掉。
 */
export function buildApiUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '') // 去掉末尾斜杠
  const suffix = path.startsWith('/') ? path : `/${path}`
  return `${base}${suffix}`
}

/** 压缩连续空白后按上限截断；超长时以「…」结尾（占位算 1 字符） */
export function clampText(value: unknown, maxLength: number): string {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  if (text.length <= maxLength) return text
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`
}

/** 剥掉 ```json 围栏；无围栏时退化为「首个 { 到末个 }」之间的内容 */
export function stripJsonFence(value: string): string {
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

/** 判断错误是否属于「服务端不支持 response_format」——命中则应降级改为纯提示词约束重试 */
export function shouldFallbackJsonMode(error: unknown): boolean {
  const err = error as ApiErrorLike | undefined
  const statusCode = Number(err?.statusCode || 0)
  if (statusCode === 400 || statusCode === 404 || statusCode === 422) return true
  const text = `${(error as Error)?.message || ''}\n${err?.responseBody || ''}`.toLowerCase()
  return text.includes('response_format') || text.includes('json_object') || text.includes('json mode')
}

/** 会话 ID 列表归一：非数组返空、逐项 trim、去空、去重（保序） */
export function normalizeSessionIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return Array.from(new Set(value.map((item) => String(item || '').trim()).filter(Boolean)))
}

/** prompt 里的「当前系统时间」行 */
export function formatPromptCurrentTime(date: Date = new Date()): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `当前系统时间：${year}年${month}月${day}日 ${hours}:${minutes}`
}

/** 在 prompt 末尾追加「当前系统时间」；空 prompt 则只返回时间行 */
export function appendPromptCurrentTime(prompt: string): string {
  const base = String(prompt || '').trimEnd()
  if (!base) return formatPromptCurrentTime()
  return `${base}\n\n${formatPromptCurrentTime()}`
}
