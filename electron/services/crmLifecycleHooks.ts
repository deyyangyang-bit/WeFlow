/**
 * crmLifecycleHooks.ts —— CRM 生命周期事件钩子（零依赖，防循环引用）
 *
 * 用途：低层服务（crmDbService / crmCustomerService）在「字段被人工确认」时发事件，
 * 上层服务（crmFirstClassifyService 信息缺口反问卡自动关闭）订阅消费。
 * 钩子模块不 import 任何业务服务，任何方向引用都不会成环。
 *
 * 纪律：
 *  - emit 逐个 try/catch（监听器失败绝不影响主语义，同 trackProposalEvent 尽力而为原则）
 *  - 监听器只做派生动作（关卡/留痕），严禁回写触发方刚写的字段（防递归）
 */
export type InfoFieldConfirmedListener = (accountId: number, field: string) => void
export type CustomerTypeSetListener = (customerId: number, type: string) => void
export type OpportunityDealListener = (accountId: number, opportunityId: number) => void

const infoFieldConfirmedListeners: InfoFieldConfirmedListener[] = []
const customerTypeSetListeners: CustomerTypeSetListener[] = []
const opportunityDealListeners: OpportunityDealListener[] = []

export function onInfoFieldConfirmed(fn: InfoFieldConfirmedListener): void { infoFieldConfirmedListeners.push(fn) }
export function onCustomerTypeSet(fn: CustomerTypeSetListener): void { customerTypeSetListeners.push(fn) }
export function onOpportunityDealRegistered(fn: OpportunityDealListener): void { opportunityDealListeners.push(fn) }

/** enrich 字段被人工采纳 / 手动编辑确认（applyInfoField accept / setAccountFieldManual） */
export function emitInfoFieldConfirmed(accountId: number, field: string): void {
  for (const fn of infoFieldConfirmedListeners) {
    try { fn(accountId, field) } catch { /* 监听器失败不影响主语义 */ }
  }
}

/** 客户类型被人工设置（setCustomerType 值变化时） */
export function emitCustomerTypeSet(customerId: number, type: string): void {
  for (const fn of customerTypeSetListeners) {
    try { fn(customerId, type) } catch { /* 监听器失败不影响主语义 */ }
  }
}

/** 商机成交登记完成（registerOpportunityDeal，order_qty 等字段已落正式事实） */
export function emitOpportunityDealRegistered(accountId: number, opportunityId: number): void {
  for (const fn of opportunityDealListeners) {
    try { fn(accountId, opportunityId) } catch { /* 监听器失败不影响主语义 */ }
  }
}
