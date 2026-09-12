/**
 * aiBudget.ts
 *
 * AI 用量预算：官方刊例价静态表 + 日上限判定（PRD §5.5）。
 *
 * 三条纪律（写死在实现里，改之前先读 PRD §5.5）：
 *   1. 价格表是**静态输入**，只写官方公布过的刊例价，并记录 as-of 日期与来源；
 *      未收录的模型（含当前默认的 deepseek-chat）一律返回 null —— 金额显示为「未收录」，
 *      绝不用相似模型的价格臆造一个数字。
 *   2. 硬拦截按**调用次数**判定，不按金额判定。理由：价格表对未收录模型为 null，
 *      按金额拦截会把「算不出钱」误判成「没花钱」，从而静默超支。
 *   3. 达到上限不得静默超支：阻断发生在 HTTP 请求之前，并写一条 status='blocked'
 *      的账本行（tokens 记 null，不记 0）。
 */

import type { UsageRow } from './aiUsageLedger'

/** 预警阈值：用量的 80% */
export const WARN_RATIO = 0.8

export interface ModelPrice {
  /** 缓存未命中输入，每 1M tokens 的官方刊例价 */
  inputPerM: number
  /** 缓存命中输入，每 1M tokens */
  cachedInputPerM: number
  /** 输出，每 1M tokens */
  outputPerM: number
  /** 计价币种（价格表按币种分组，不做汇率换算——汇率是另一个会过期的臆造数字） */
  currency: 'USD' | 'CNY'
}

/**
 * 官方刊例价静态表（as-of 2026-09-12，来源见 PRICE_TABLE_SOURCE）。
 * 分时定价的模型取**峰时**价填入（保守上界），非峰时实际更低。
 */
export const PRICE_TABLE_AS_OF = '2026-09-12'
export const PRICE_TABLE_SOURCE = 'https://api-docs.deepseek.com/quick_start/pricing'

export const PRICE_TABLE: Record<string, ModelPrice> = {
  // DeepSeek 官方刊例价（USD / 1M tokens）。峰时价：输入未命中 0.3、命中 0.006、输出 1.2；
  // 非峰时为其一半。此处取峰时价作为保守上界。
  'deepseek-v4-pro': { inputPerM: 1.32, cachedInputPerM: 0.044, outputPerM: 3.96, currency: 'USD' },
  'deepseek-flash': { inputPerM: 0.3, cachedInputPerM: 0.006, outputPerM: 1.2, currency: 'USD' }
}

/**
 * 查模型刊例价。先精确匹配，再按「型号族前缀」匹配（如 deepseek-v4-pro-0912 → deepseek-v4-pro）。
 * 查不到返回 null —— 调用方必须把 null 当作「未收录」，不得当作 0。
 */
export function priceFor(model: string): ModelPrice | null {
  const key = String(model || '').trim().toLowerCase()
  if (!key) return null
  if (PRICE_TABLE[key]) return PRICE_TABLE[key]
  const families = Object.keys(PRICE_TABLE).sort((a, b) => b.length - a.length)
  for (const family of families) {
    if (key.startsWith(`${family}-`) || key.startsWith(`${family}_`) || key.startsWith(`${family}:`)) {
      return PRICE_TABLE[family]
    }
  }
  return null
}

/**
 * 估算单行用量金额。三项 token 均为 null（如阻断行）或模型未收录时返回 null。
 * cachedInputPerM 缺失时按未命中价计（保守上界）。
 */
export function estimateCost(row: Pick<UsageRow, 'model' | 'inputTokens' | 'cachedInputTokens' | 'outputTokens'>): number | null {
  const price = priceFor(row.model)
  if (!price) return null
  const input = row.inputTokens
  const output = row.outputTokens
  if (input === null && output === null) return null
  const cached = row.cachedInputTokens ?? 0
  const billedInput = Math.max(0, (input ?? 0) - cached)
  const cost =
    (billedInput / 1e6) * price.inputPerM +
    (cached / 1e6) * price.cachedInputPerM +
    ((output ?? 0) / 1e6) * price.outputPerM
  return Number.isFinite(cost) ? cost : null
}

export interface DailyUsage {
  /** 当日账本行数（含未计入计费的 blocked 行） */
  calls: number
  /** 当日被额度阻断的次数 */
  blockedCalls: number
  /** 当日已估算金额（币种为 currency；未收录模型的用量不计入） */
  cost: number
  /** 计价币种；当日无任何可计价用量时为 'USD' 占位 */
  currency: 'USD' | 'CNY'
  /** 当日无法计价的行数（未收录模型）——界面必须显示，否则会让人误读为「没花钱」 */
  unpricedCalls: number
}

/** 取本地时区当日零点毫秒 */
export function startOfLocalDay(now: number = Date.now()): number {
  const date = new Date(now)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** 汇总某个自然日（本地时区）的用量。rows 为账本原始行。 */
export function dailyUsage(rows: UsageRow[], now: number = Date.now()): DailyUsage {
  const dayStart = startOfLocalDay(now)
  const today = rows.filter((row) => Number(row?.at) >= dayStart)
  let cost = 0
  let unpriced = 0
  let currency: 'USD' | 'CNY' = 'USD'
  for (const row of today) {
    if (row.status === 'blocked') continue
    const price = priceFor(row.model)
    if (!price) {
      unpriced++
      continue
    }
    currency = price.currency
    const value = estimateCost(row)
    if (value === null) unpriced++
    else cost += value
  }
  return {
    calls: today.length,
    blockedCalls: today.filter((row) => row.status === 'blocked').length,
    cost: Number(cost.toFixed(6)),
    currency,
    unpricedCalls: unpriced
  }
}

export type BudgetLevel = 'ok' | 'warn' | 'blocked' | 'off'

export interface BudgetVerdict {
  level: BudgetLevel
  /** 当日已发生的模型调用次数（阻断行不计入，否则阻断本身会把计数推得更高） */
  used: number
  limit: number
  /** 已用比例（limit<=0 时为 0） */
  ratio: number
  message: string
}

/**
 * 判定当日额度。
 * @param callsUsed 当日已发生的调用次数（应来自 dailyUsage().calls - blockedCalls）
 * @param limit 日上限；<=0 或未启用时视为不限
 */
export function evaluateBudget(callsUsed: number, limit: number): BudgetVerdict {
  const used = Math.max(0, Math.floor(callsUsed))
  const cap = Math.floor(Number(limit) || 0)
  if (cap <= 0) {
    return { level: 'off', used, limit: 0, ratio: 0, message: '未设置每日上限' }
  }
  const ratio = used / cap
  if (used >= cap) {
    return {
      level: 'blocked', used, limit: cap, ratio,
      message: `今日 AI 调用已达上限（${used}/${cap} 次），已阻断本次调用；可在设置中提高上限`
    }
  }
  if (ratio >= WARN_RATIO) {
    return {
      level: 'warn', used, limit: cap, ratio,
      message: `今日 AI 调用已用 ${used}/${cap} 次（${Math.round(ratio * 100)}%）`
    }
  }
  return { level: 'ok', used, limit: cap, ratio, message: `今日 AI 调用 ${used}/${cap} 次` }
}

// ─── 全局上限 provider ────────────────────────────────────────────────────────

/**
 * 日上限的全局来源。callChatCompletion 在调用方未显式传 dailyCallLimit 时用它兜底——
 * 这样任何「手工拼一个 AiModelConfig」的调用点也无法绕开闸门（闸门不能依赖调用方自觉）。
 */
let limitProvider: () => number = () => 0

/** 由 main.ts 在配置服务就绪后注入一次 */
export function configureAiBudget(provider: () => number): void {
  limitProvider = provider
}

/** 读取当前日上限；provider 抛错时按「不限」处理（额度是护栏，不该成为正确性前提） */
export function currentDailyCallLimit(): number {
  try {
    const value = Math.floor(Number(limitProvider()) || 0)
    return value > 0 ? value : 0
  } catch {
    return 0
  }
}

/** 额度阻断异常：调用方据此区分「额度不足」与「网络/模型失败」，不得混为一谈 */
export class AiBudgetBlockedError extends Error {
  readonly verdict: BudgetVerdict
  constructor(verdict: BudgetVerdict) {
    super(verdict.message)
    this.name = 'AiBudgetBlockedError'
    this.verdict = verdict
  }
}

/** 判断任意错误是否为额度阻断（跨模块用，避免 instanceof 因模块副本失效） */
export function isBudgetBlockedError(error: unknown): boolean {
  if (error instanceof AiBudgetBlockedError) return true
  return !!error && typeof error === 'object' && (error as { name?: string }).name === 'AiBudgetBlockedError'
}
