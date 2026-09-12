/**
 * safeJson.ts — JSON 安全解析共享实现（SSOT）
 *
 * 收敛仓库里散落的 `try { x = JSON.parse(String(raw || '{}')) } catch { x = {} }` 内联写法，
 * 以及 ChatPage 的局部 safeParseJson。所有函数都不抛异常。
 *
 * 语义与原内联写法逐字一致：
 *   - 输入为假值（null/undefined/''）时改用 emptyLiteral 作为 JSON 文本；
 *   - 解析失败返回 fallback；
 *   - 不做形状/类型校验 —— 原写法亦不校验（例如 `'5'` 会解析出数字 5），保持一致。
 */

/**
 * 解析 JSON，失败时返回 fallback，不抛异常。
 *
 * @param raw 待解析值；假值时改用 emptyLiteral
 * @param fallback 解析失败时的返回值
 * @param emptyLiteral raw 为假值时的替代 JSON 文本，默认 '{}'
 */
export function parseJsonOr<T>(raw: unknown, fallback: T, emptyLiteral = '{}'): T {
  try {
    return JSON.parse(String(raw || emptyLiteral)) as T
  } catch {
    return fallback
  }
}

/**
 * 解析 JSON 对象，失败时返回 {}。
 * 等价于原写法 `try { x = JSON.parse(String(raw || '{}')) } catch { x = {} }`。
 */
export function parseJsonObject<T extends object = Record<string, unknown>>(raw: unknown): T {
  return parseJsonOr<T>(raw, {} as T, '{}')
}

/**
 * 解析 JSON 数组，失败时返回 []。
 * 等价于原写法 `try { x = JSON.parse(String(raw || '[]')) } catch { x = [] }`。
 */
export function parseJsonArray<T = unknown>(raw: unknown): T[] {
  return parseJsonOr<T[]>(raw, [], '[]')
}
