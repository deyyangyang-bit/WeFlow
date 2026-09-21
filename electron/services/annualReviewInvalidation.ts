/**
 * annualReviewInvalidation.ts —— 年度经营复盘数据失效总线（S7.2 修复轮）
 *
 * 为什么需要它：确定性报告缓存与 AI 结果缓存此前只在「账号切换 / 业务库重开 / 名单变化 /
 * Assignment」四处失效，其余业务写入（客户、合同、核销、出货、阶段、商机、LAN/Central 同步
 * 应用）都不失效——只能靠 10 分钟 TTL 兜底，等于报告可能长时间停留在旧口径上。
 *
 * 设计（与 assignmentInvalidationBus 同一纪律）：
 *   - **零 Electron 依赖**：纯模块，可被任意主进程服务 import，也可直接单测；广播到渲染层
 *     不是它的职责（这里只做主进程内部失效）。
 *   - **只在写成功后通知**：总线不感知事务，由调用方保证「写语句/事务已成功提交且未抛错」
 *     才调用 emit；失败/回滚路径**不得**调用。写入漏斗（crmDbService.run/runTx、
 *     salesDbService.run、wcdbService.open）已按此约定接入。
 *   - **固定窗口合并**：首个事件开启一个固定窗口（ANNUAL_REVIEW_INVALIDATION_FLUSH_MS），
 *     窗口内的后续事件合并成一次派发。窗口**不随事件顺延**，因此批量同步/解析管线的
 *     事件风暴不会造成无限延迟，最大延迟有界。
 *   - **单点订阅**：主进程只在一处订阅（installAnnualReviewInvalidation），在那里同时失效
 *     确定性报告缓存与 AI 结果缓存——避免两处各自遗漏不同的领域。
 *   - **监听器异常隔离**：单个订阅者抛错不影响其他订阅者，更不影响写入路径。
 *   - 只做「失效」：总线上不携带任何数据内容（不含客户、金额、会话或路径），只有原因与计数。
 */

/** 失效原因（稳定值，用于诊断与测试断言；不参与任何业务判断） */
export type AnnualReviewInvalidationReason =
  /** crmDb 业务写入（客户/合同/核销/出货/阶段/商机/分配表等，写漏斗统一上报） */
  | 'crm_write'
  /** salesDb 业务写入（customer_profile / intent_tag_log 等，写漏斗统一上报） */
  | 'sales_write'
  /** WCDB 连接成功（切号或重连的稳定成功点） */
  | 'wcdb_connected'
  /** Assignment 失效总线（LAN/中央下行的归属变化） */
  | 'assignment'
  /** 账号切换 / 业务库 reopen / 归档（立即失效，无合并窗口） */
  | 'account_switch'
  /** 手动排除名单 / 内部人员名单变化（立即失效） */
  | 'config_exclusions'
  /** 其他主进程内部调用方显式声明（保留扩展位） */
  | 'manual'

export interface AnnualReviewInvalidationEvent {
  /** 本次派发合并到的原因（稳定升序，去重） */
  reasons: string[]
  /** 本次派发合并了多少次上报（≥1） */
  count: number
  /** 窗口内首次上报时刻 */
  firstAt: number
  /** 派发时刻 */
  at: number
}

export type AnnualReviewInvalidationListener = (event: AnnualReviewInvalidationEvent) => void

/**
 * 合并窗口（毫秒）。取值与 assignmentInvalidationBus 一致：足够吸收批量写/同步风暴，
 * 又让失效延迟有界（用户感知不到，也不会长时间停留在旧口径上）。
 */
export const ANNUAL_REVIEW_INVALIDATION_FLUSH_MS = 150

interface PendingFlush {
  reasons: Set<string>
  count: number
  firstAt: number
  timer: ReturnType<typeof setTimeout> | null
}

const listeners = new Set<AnnualReviewInvalidationListener>()
let pending: PendingFlush | null = null

function now(): number {
  return Date.now()
}

function dispatch(event: AnnualReviewInvalidationEvent): void {
  for (const listener of listeners) {
    try {
      listener(event)
    } catch {
      // 订阅者异常不阻断其他订阅者，也绝不冒泡回写入路径
    }
  }
}

function takePending(): PendingFlush | null {
  const current = pending
  pending = null
  if (current?.timer) {
    try { clearTimeout(current.timer) } catch { /* ignore */ }
  }
  return current
}

function flushPending(): void {
  const current = takePending()
  if (!current || current.count === 0) return
  dispatch({
    reasons: [...current.reasons].sort(),
    count: current.count,
    firstAt: current.firstAt,
    at: now()
  })
}

/** 订阅失效事件；返回取消订阅函数（幂等） */
export function onAnnualReviewInvalidation(listener: AnnualReviewInvalidationListener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/**
 * 上报一次业务数据变更（合并窗口内派发一次）。**调用方必须保证写已成功提交**——
 * 失败/回滚路径不得调用。上报本身永不抛错（失效通知不得影响写入路径）。
 */
export function announceAnnualReviewDataChanged(reason: AnnualReviewInvalidationReason): void {
  try {
    if (!pending) {
      pending = { reasons: new Set(), count: 0, firstAt: now(), timer: null }
      const timer = setTimeout(() => { flushPending() }, ANNUAL_REVIEW_INVALIDATION_FLUSH_MS)
      pending.timer = timer
    }
    pending.reasons.add(reason)
    pending.count++
  } catch {
    // 忽略：失效是尽力而为的通知，不能反向影响已成功的写入
  }
}

/**
 * 立即失效（不进入合并窗口）：账号切换 / 业务库重开 / 名单变化这类「必须立刻作废」的动作。
 * 与合并路径共用同一批订阅者——因此仍然是同一条失效事实。
 */
export function announceAnnualReviewDataChangedNow(reason: AnnualReviewInvalidationReason): void {
  try {
    // 先派发窗口内已积压的事件，避免它们在「立即失效」之后才到达（顺序倒挂）
    flushPending()
    dispatch({ reasons: [reason], count: 1, firstAt: now(), at: now() })
  } catch {
    // 同上：绝不向调用方抛出
  }
}

/** 年度复盘侧的两个失效目标（确定性报告缓存 / AI 结果缓存） */
export interface AnnualReviewInvalidationTarget {
  /** 确定性报告缓存与可用年份缓存失效 + 终止运行中任务（AnnualReviewService.handleDataChanged） */
  handleDataChanged(): void
  /** AI 结果缓存失效 + 中止在途调用（AnnualReviewAiCoordinator.invalidateAll） */
  invalidateAll(): void
}

/**
 * **唯一订阅点**：主进程只调用一次，把两类缓存挂到同一条失效事实上。
 * 抽成函数（而不是在 main.ts 里内联两行）是为了让接线本身可被行为测试覆盖：
 * 测试用真实的 service/coordinator 调同一个函数，再驱动真实写入路径。
 */
export function installAnnualReviewInvalidation(target: AnnualReviewInvalidationTarget): () => void {
  return onAnnualReviewInvalidation(() => {
    target.handleDataChanged()
    target.invalidateAll()
  })
}

/**
 * Assignment 失效总线 → 年度复盘失效总线（LAN/中央下行的 assign/transfer/recycle 等归属变化）。
 *
 * 为什么仍需这条桥：归属变化虽然也经 crmDb 写漏斗被覆盖，但 assignment 总线是「已提交且确实
 * 改写了归属行」的显式信号（含 LAN/中央下行应用成功），保留它让失效原因可诊断，也覆盖未来
 * 任何绕过写漏斗的归属写入路径。与写漏斗上报共用同一订阅点，因此不会产生第二套失效语义。
 */
export function bridgeAssignmentInvalidationToAnnualReview(
  subscribeAssignment: (listener: (event: { action: string }) => void) => () => void
): () => void {
  return subscribeAssignment(() => {
    announceAnnualReviewDataChanged('assignment')
  })
}

/** 测试辅助：立即派发窗口内积压的事件（生产代码不调用） */
export function flushAnnualReviewInvalidationForTest(): void {
  flushPending()
}

/** 测试辅助：清空窗口与订阅者（生产代码不调用） */
export function resetAnnualReviewInvalidationForTest(): void {
  takePending()
  listeners.clear()
}

/** 测试/诊断辅助：是否存在待派发的上报（不含任何内容） */
export function hasPendingAnnualReviewInvalidation(): boolean {
  return pending !== null && pending.count > 0
}
