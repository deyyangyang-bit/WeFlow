/**
 * aiDailyLimitAudit.ts —— AI 每日调用上限变更 → 审计 detail（AI 简报 PRD §4.4 / §7.4-3）
 *
 * 上限是当天 AI 花费的硬门禁（aiBudget 按调用次数阻断），放宽或收紧它都是敏感操作，
 * 必须在 audit_event 留痕。写入点仍走 crmDbService 的既有审计单点（宪法 §1.12），
 * 本模块只负责「要不要记、记什么」这一确定性问题，便于穷举断言。
 */

/** 未设置上限时的读取口径（与设置页 getAiDailyCallLimit 的默认值一致） */
export const AI_DAILY_LIMIT_DEFAULT = 60
const AI_DAILY_LIMIT_MAX = 100000

export interface AiDailyLimitAuditDetail {
  configKey: 'aiDailyCallLimit'
  old_limit: number
  new_limit: number
  /** 方向仅供前端筛选区分；提额与降额同记 */
  direction: 'increase' | 'decrease'
}

/** 归一化：与设置页写入侧同一口径（≥1、≤100000、取整；非法值回落默认 60） */
export function normalizeAiDailyLimit(value: unknown): number {
  const num = Number(value)
  if (!Number.isFinite(num) || num <= 0) return AI_DAILY_LIMIT_DEFAULT
  return Math.min(AI_DAILY_LIMIT_MAX, Math.max(1, Math.floor(num)))
}

/**
 * 上限变更的审计 detail；值未变（含等价写法如 '60' 与 60）返回 null = 不留痕。
 * @param previous 配置里的旧值（未设置传 undefined，按默认口径折算）
 * @param next 本次写入的新值
 */
export function aiDailyLimitAuditDetail(previous: unknown, next: unknown): AiDailyLimitAuditDetail | null {
  const oldLimit = normalizeAiDailyLimit(previous)
  const newLimit = normalizeAiDailyLimit(next)
  if (oldLimit === newLimit) return null
  return {
    configKey: 'aiDailyCallLimit',
    old_limit: oldLimit,
    new_limit: newLimit,
    direction: newLimit > oldLimit ? 'increase' : 'decrease'
  }
}
