/**
 * shared/crmRepeat.ts —— 复购归并口径与等级唯一语义源（前后端共用，纯模块零依赖）
 *
 * 复购归并键：customer_id 优先（跨微信号同一客户主体），未挂接时退回 account_id（单微信号维度）。
 * 复购等级：按同一归并键下的成交（won）笔数分三档，UI / R10 / 报表一律复用本原语，禁止各自手写阈值。
 * 前端 src/utils/crmDealKey.ts 与后端 crmAftersalesService.wonDeals / crmDeliveryService.recomputeRepeatLevel
 * 均从这里导出（或经 re-export 收敛到本模块），保证「单一后端原语」。
 */

/** 复购归并键：customer_id > 0 → `c:<id>`；否则 → `a:<accountId>` */
export function crmCustomerKey(
  customerId: number | string | null | undefined,
  accountId: number | string | null | undefined
): string {
  const customer = Number(customerId || 0)
  return customer > 0 ? `c:${customer}` : `a:${Number(accountId || 0)}`
}

/** 商机 → 归并键：经 account.customer_id 挂接取归并键（缺 accountsById 时退回 account_id） */
export function crmCustomerKeyForOpportunity(
  accountsById: Map<number, { customer_id?: number | string | null }>,
  opportunity: { account_id?: number | string | null }
): string {
  const accountId = Number(opportunity.account_id || 0)
  return crmCustomerKey(accountsById.get(accountId)?.customer_id, accountId)
}

/** 复购等级（三档固定口径；wonCount<1 按 1 处理 = 首购） */
export const REPEAT_LEVEL_FIRST = '首购'
export const REPEAT_LEVEL_REPEAT = '复购老客'
export const REPEAT_LEVEL_HIGH = '高频复购·升A'

/**
 * 复购等级原语（单一后端事实）：按同一归并键下成交笔数分档。
 *  ≥3 高频复购·升A；=2 复购老客；≤1 首购。
 */
export function computeRepeatLevel(wonCount: number): string {
  const n = Number(wonCount) || 0
  if (n >= 3) return REPEAT_LEVEL_HIGH
  if (n === 2) return REPEAT_LEVEL_REPEAT
  return REPEAT_LEVEL_FIRST
}

/** 旧名兼容（src/utils/crmDealKey 历史导出） */
export function crmRepeatLevel(wonCount: number): string {
  return computeRepeatLevel(wonCount)
}
