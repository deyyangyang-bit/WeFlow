/**
 * AI 接入的「预设档位」映射（纯函数、零 IO、无 React）——设置页「AI 基础配置」用。
 *
 * 对一线销售而言，手填 `https://api.deepseek.com/v1` 和手填 1024 都没有可解释性。
 * 故把这两处收敛成「选一个服务商」「选一档长度」，真实值仍写回既有配置键：
 *   - AI 服务地址 → `aiModelApiBaseUrl`
 *   - 单次回答长度 → `aiModelApiMaxTokens`
 * ⛔ 键名、默认值、读写时机一律未变。
 */

/** AI 服务地址预设 */
export interface AiServicePreset {
  value: string
  label: string
  /** 选中后写入的地址；`''` 表示自定义（保留用户已填内容，不覆盖） */
  url: string
}

/**
 * 地址一律带 `/v1` 结尾、不带尾斜杠——与后端「自动拼接 /chat/completions」的口径一致。
 * 用户不必再知道「末尾不要加斜杠」这条实现细节。
 */
export const AI_SERVICE_PRESETS: readonly AiServicePreset[] = [
  { value: 'deepseek', label: 'DeepSeek', url: 'https://api.deepseek.com/v1' },
  { value: 'openai', label: 'OpenAI 兼容', url: 'https://api.openai.com/v1' },
  { value: 'custom', label: '自定义', url: '' }
]

/** 去掉首尾空白与尾斜杠（后端按 `base + '/chat/completions'` 拼接，尾斜杠会产生 `//`） */
export function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '')
}

/**
 * 由当前地址反推命中的预设；命中不了返回 `'custom'`。
 * 归一化后比较，故用户手填带尾斜杠的同一地址仍能正确显示为对应预设。
 */
export function presetOfBaseUrl(baseUrl: string): string {
  const norm = normalizeBaseUrl(baseUrl)
  const hit = AI_SERVICE_PRESETS.find((p) => p.url !== '' && p.url === norm)
  return hit ? hit.value : 'custom'
}

/** 单次回答长度档位 */
export interface MaxTokensTier {
  value: string
  label: string
  tokens: number
}

/** 三档长度上限。标准档 = 现状默认 1024（改动此值必须同步 SettingsPage 的 useState 初值）。 */
export const MAX_TOKENS_TIERS: readonly MaxTokensTier[] = [
  { value: 'short', label: '短', tokens: 512 },
  { value: 'standard', label: '标准', tokens: 1024 },
  { value: 'long', label: '长', tokens: 2048 }
]

/** 由当前 token 数反推档位；不在任何档位上返回 `''`（未选择态，真实数字在「高级」里如实展示） */
export function maxTokensTierOf(tokens: number): string {
  const hit = MAX_TOKENS_TIERS.find((t) => t.tokens === tokens)
  return hit ? hit.value : ''
}

/** 按档位取 token 数；未知档位返回 `null`（调用方据此跳过写入，不猜） */
export function tokensOfTier(tier: string): number | null {
  const hit = MAX_TOKENS_TIERS.find((t) => t.value === tier)
  return hit ? hit.tokens : null
}
