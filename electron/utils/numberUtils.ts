/**
 * numberUtils.ts —— electron 侧通用数值归一化。
 */

/**
 * 把任意值归一为「非负整数」；非 number / 非有限值 / 布尔字符串一律返回 undefined。
 * 缓存条目 normalize 的脏值防线：负数、小数、字符串、NaN 均被拦下。
 */
export function toNonNegativeInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.max(0, Math.floor(value))
}
