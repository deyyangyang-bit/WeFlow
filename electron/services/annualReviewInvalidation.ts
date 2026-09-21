/**
 * annualReviewInvalidation.ts —— 年度经营复盘数据失效总线（S7.2 修复轮 + 范围收窄轮）
 *
 * 职责：把「年度复盘读取的数据发生了变化」这一事实，从**显式声明**的写入点广播给
 * 确定性报告缓存与 AI 结果缓存（主进程唯一的订阅点见 installAnnualReviewInvalidation）。
 *
 * ## 范围白名单（本文件是唯一事实源，改这里等于改失效范围）
 *
 * 只有**年度复盘真实读取**的数据源才触发失效；其余写入**默认不影响年度复盘**（不再有
 * 「所有数据库写入都失效」的兜底策略）：
 *
 * | 库 | 数据源 | 说明 |
 * |---|---|---|
 * | crmDb | `account` / `contract` / `allocation` / `contract_status_history` | A/C 组指标 |
 * | crmDb | `assignment` / `lead` | E 组分配事实与客户关联 |
 * | crmDb | `opportunity` / `opportunity_event` | B2 商机漏斗 |
 * | crmDb | `audit_event` 仅 `lead_assign` / `lead_transfer` / `sync_apply` | E1 分配事实与 sync 缺口检测 |
 * | salesDb | `customer_profile` / `intent_tag_log` | B1/B3 阶段与流转 |
 * | WCDB | 连接建立成功（切号 / 重连） | A3/D1/D5 消息类指标 |
 *
 * **明确不触发**（写入频繁但与年报复盘无关）：`scan_state`、`processed_msg`、
 * `migration_report`、`migration_dismissal`、`activity_log`、`auto_confirm_log`、
 * 无关 `audit_event` action、`knowledge_base`、`report_snapshot`、`opportunity_eval_case`、
 * `alert_eval_case`、`follow_up_task`、`outbox_event`、`notify_inbox`、`dup_group`、
 * `match_proposal`、`ownership_history`、`customer` / `customer_identity`、
 * `payment_record` / `payment_promise` / `logistics` / `invoice`、`quotation` 版本链等。
 *
 * ## 声明方式（显式、可审查）
 *
 *   - 表名**来自调用点的类型化参数**（如 `create('contract', …)` 的 entity、
 *     `runTx(fn, { affectsAnnualReview: 'crm:contract' })` 的选项），**不做 SQL 字符串匹配**；
 *   - `crmDbService.create/update` 按 entity 自动声明（entity 已是类型化入参）；
 *   - 原始 SQL 事务必须显式声明 `affectsAnnualReview`（默认**不**影响年度复盘）；
 *   - 辅助函数 `announceAnnualReviewCrmWrite` / `announceAnnualReviewSalesWrite` /
 *     `announceAnnualReviewAuditAction` 对白名单外的表/action 直接 no-op。
 *
 * ## 通知时机
 *
 * **只在写入成功后**：事务在 COMMIT 返回后、单语句写在其执行与 persist 均未抛错后才调用
 * （失败与 ROLLBACK 路径绝不通知）；纯读路径不经过这些声明点。
 *
 * ## 窗口语义：leading-edge（首条立即）
 *
 *   - 窗口空闲时，**第一条**相关事件**立即派发**——报告缓存与 AI 缓存马上失效、运行中任务
 *     马上收敛，不存在「首次失效还要等 150ms」；
 *   - 其后 150ms 内的重复事件被抑制（去重计数），窗口结束时若确有被抑制的事件，**补一次**
 *     合并派发（每个窗口最多一次）：覆盖「窗口内又有写入、而期间缓存可能已重建」的窄窗口；
 *   - 窗口**从首条事件起算固定长度**，不随新事件顺延，因此持续写入不会形成无限延迟；
 *   - 关键失效（账号切换 / 名单变化）用 `announceAnnualReviewDataChangedNow` 立即派发，
 *     即使正处在窗口内也不等待。
 *
 * 监听器异常相互隔离；上报只携带**原因与计数**，不含任何业务数据（客户、金额、路径、密钥）。
 */

/** 年度复盘读取的 crmDb 数据源表（唯一白名单） */
export const ANNUAL_REVIEW_CRM_SOURCE_TABLES = [
  'account',
  'contract',
  'allocation',
  'contract_status_history',
  'assignment',
  'lead',
  'opportunity',
  'opportunity_event'
] as const
export type AnnualReviewCrmSourceTable = (typeof ANNUAL_REVIEW_CRM_SOURCE_TABLES)[number]

/** `audit_event` 中年度复盘读取的 action（E1 分配事实 / sync 缺口检测） */
export const ANNUAL_REVIEW_AUDIT_ACTIONS = ['lead_assign', 'lead_transfer', 'sync_apply'] as const
export type AnnualReviewAuditAction = (typeof ANNUAL_REVIEW_AUDIT_ACTIONS)[number]

/** 年度复盘读取的 salesDb 数据源表（唯一白名单） */
export const ANNUAL_REVIEW_SALES_SOURCE_TABLES = ['customer_profile', 'intent_tag_log'] as const
export type AnnualReviewSalesSourceTable = (typeof ANNUAL_REVIEW_SALES_SOURCE_TABLES)[number]

/**
 * 失效原因（稳定值，用于诊断与测试断言；不参与业务判断）。
 * 表级原因让「谁触发了失效」在日志/测试里可直接读出，不需要反推写入实现。
 */
export type AnnualReviewInvalidationReason =
  | `crm:${AnnualReviewCrmSourceTable}`
  | `crm:audit_event:${AnnualReviewAuditAction}`
  | `sales:${AnnualReviewSalesSourceTable}`
  /** assignment 归属变化的总线信号（LAN/中央下行应用成功后的显式通知） */
  | 'assignment'
  /** WCDB 连接建立成功（切号 / 重连的稳定成功点） */
  | 'wcdb_connected'
  /** 账号切换 / 业务库 reopen / 归档（立即失效） */
  | 'account_switch'
  /** 手动排除名单 / 内部人员名单变化（立即失效） */
  | 'config_exclusions'

export interface AnnualReviewInvalidationEvent {
  /** 本次派发的原因（稳定升序，去重） */
  reasons: string[]
  /** 本次派发覆盖的上报次数（≥1） */
  count: number
  /** 首条上报时刻 */
  firstAt: number
  /** 派发时刻 */
  at: number
  /** true = 窗口结束时对「被抑制事件」的补派发；false = 首条事件的即时派发 */
  coalesced: boolean
}

export type AnnualReviewInvalidationListener = (event: AnnualReviewInvalidationEvent) => void

/**
 * 合并窗口长度（毫秒）。只用于抑制窗口内的重复事件；**首条事件不受窗口影响**（立即派发）。
 * 取值与 assignmentInvalidationBus 一致：足够吸收批量写/同步风暴，又让补派发的延迟有界。
 */
export const ANNUAL_REVIEW_INVALIDATION_FLUSH_MS = 150

interface PendingWindow {
  reasons: Set<string>
  count: number
  firstAt: number
  timer: ReturnType<typeof setTimeout> | null
}

const CRM_SOURCE_TABLE_SET: ReadonlySet<string> = new Set(ANNUAL_REVIEW_CRM_SOURCE_TABLES)
const SALES_SOURCE_TABLE_SET: ReadonlySet<string> = new Set(ANNUAL_REVIEW_SALES_SOURCE_TABLES)
const AUDIT_ACTION_SET: ReadonlySet<string> = new Set(ANNUAL_REVIEW_AUDIT_ACTIONS)

let listeners = new Set<AnnualReviewInvalidationListener>()
let window: PendingWindow | null = null

function clock(): number {
  return Date.now()
}

function dispatch(event: AnnualReviewInvalidationEvent): void {
  for (const listener of listeners.values()) {
    try {
      listener(event)
    } catch {
      // 订阅者异常不阻断其他订阅者，也绝不冒泡回写入路径
    }
  }
}

function clearWindowTimer(w: PendingWindow | null): void {
  if (!w?.timer) return
  try { clearTimeout(w.timer) } catch { /* ignore */ }
  w.timer = null
}

/** 窗口结束：把窗口内**被抑制**的事件补一次合并派发（首条已在开启窗口时立即派发过） */
function closeWindow(): void {
  const w = window
  window = null
  clearWindowTimer(w)
  if (!w || w.count <= 1) return
  dispatch({
    reasons: [...w.reasons].sort(),
    count: w.count,
    firstAt: w.firstAt,
    at: clock(),
    coalesced: true
  })
}

/** 订阅失效事件；返回取消订阅函数（幂等） */
export function onAnnualReviewInvalidation(listener: AnnualReviewInvalidationListener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/**
 * 上报一次「年度复盘读取的数据已变更」。**调用方必须保证写已成功提交**。
 * 窗口空闲时立即派发（leading edge）；窗口打开时只计数抑制，窗口结束时补一次。
 * 上报本身永不抛错（失效通知不得影响写入路径）。
 */
export function announceAnnualReviewDataChanged(reason: AnnualReviewInvalidationReason): void {
  try {
    if (window) {
      window.reasons.add(reason)
      window.count++
      return
    }
    const opened: PendingWindow = { reasons: new Set([reason]), count: 1, firstAt: clock(), timer: null }
    window = opened
    opened.timer = setTimeout(() => { closeWindow() }, ANNUAL_REVIEW_INVALIDATION_FLUSH_MS)
    // leading edge：首条相关事件立即失效，不等窗口结束
    dispatch({ reasons: [reason], count: 1, firstAt: opened.firstAt, at: clock(), coalesced: false })
  } catch {
    // 忽略：失效是尽力而为的通知，不能反向影响已成功的写入
  }
}

/**
 * 立即失效（即使正处于合并窗口内也**立刻**派发）：账号切换 / 业务库重开 / 名单变化这类
 * 「必须马上作废」的动作。与合并路径共用同一批订阅者——仍是同一条失效事实。
 */
export function announceAnnualReviewDataChangedNow(reason: AnnualReviewInvalidationReason): void {
  try {
    if (window) {
      window.reasons.add(reason)
      window.count++
    }
    dispatch({ reasons: [reason], count: 1, firstAt: clock(), at: clock(), coalesced: false })
  } catch {
    // 同上：绝不向调用方抛出
  }
}

/** crmDb 表写入声明：**只有白名单表**才触发失效，其余 no-op（默认不影响年度复盘） */
export function announceAnnualReviewCrmWrite(table: string): boolean {
  if (!CRM_SOURCE_TABLE_SET.has(table)) return false
  announceAnnualReviewDataChanged(`crm:${table as AnnualReviewCrmSourceTable}`)
  return true
}

/** salesDb 表写入声明：只有 customer_profile / intent_tag_log 触发失效 */
export function announceAnnualReviewSalesWrite(table: string): boolean {
  if (!SALES_SOURCE_TABLE_SET.has(table)) return false
  announceAnnualReviewDataChanged(`sales:${table as AnnualReviewSalesSourceTable}`)
  return true
}

/** audit_event 写入声明：只有 lead_assign / lead_transfer / sync_apply 触发失效 */
export function announceAnnualReviewAuditAction(action: string): boolean {
  if (!AUDIT_ACTION_SET.has(action)) return false
  announceAnnualReviewDataChanged(`crm:audit_event:${action as AnnualReviewAuditAction}`)
  return true
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
 * Assignment 失效总线 → 年度复盘失效总线（LAN/中央下行的归属变化）。
 *
 * 为什么保留这条桥：assignment 总线是「事务已提交且**确实改写了归属行**」的显式信号
 * （LAN/中央下行 `applied` 才发，conflict/nolead/脏类型不发），比在同步事务里静态声明更精确；
 * 与写声明共用同一订阅点，因此不会产生第二套失效语义。
 */
export function bridgeAssignmentInvalidationToAnnualReview(
  subscribeAssignment: (listener: (event: { action: string }) => void) => () => void
): () => void {
  return subscribeAssignment(() => {
    announceAnnualReviewDataChanged('assignment')
  })
}

/** 测试辅助：关闭当前窗口并派发被抑制的事件（生产代码不调用） */
export function flushAnnualReviewInvalidationForTest(): void {
  closeWindow()
}

/** 测试辅助：清空窗口与订阅者（生产代码不调用） */
export function resetAnnualReviewInvalidationForTest(): void {
  clearWindowTimer(window)
  window = null
  listeners = new Set()
}

/** 测试/诊断辅助：当前是否处于抑制窗口内（不含任何内容） */
export function hasPendingAnnualReviewInvalidation(): boolean {
  return window !== null && window.count > 0
}
