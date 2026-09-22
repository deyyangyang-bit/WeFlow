/**
 * assignmentInvalidationBus.ts —— CRM 分配数据失效通知（主进程内部轻量领域事件总线，2026-09-20）
 *
 * 要解决的问题：线索页打开期间，后台/外部来源改变 assignment（SLA 定时回收、LAN/中央下行
 * assign/transfer/recycle、其他主进程写入、未来其他窗口的分配）后页面不知情。页面自己发起的
 * 操作本就主动 fetchAll，不靠本事件。
 *
 * 设计纪律：
 *   - **零 Electron 依赖**：本模块不知道 BrowserWindow/ipcMain 的存在；「广播给存活窗口」
 *     的桥接在 IPC 注册层（crmIpcHandlers）完成。因此可在 tsx 测试里直接驱动。
 *   - **只读最小载荷**：`{ action, leadIds, at }`——action ∈ assign/claim/recycle/transfer
 *     （多动作合并时按固定顺序逗号连接），leadIds 为去重排序后的正整数。绝不携带联系方式、
 *     聊天内容或任何客户敏感字段；页面收到后自行重拉所需数据。
 *   - **提交后才发**：本总线不感知事务，由调用方保证「只在写事务成功提交后调用 emit」；
 *     失败/回滚路径不得调用。
 *   - **固定窗口合并（有界延迟，2026-09-20 修订）**：首个 emit 启动 ASSIGN_INVALIDATION_FLUSH_MS
 *     窗口；窗口内后续 emit 只合并（action 并集 + leadIds 并集），**不重置计时**；窗口到期必然
 *     发出一条合并事件。因此持续写入（批量分配逐条、连续同步轮巡）下最大通知延迟 = 首个事件起
 *     150ms——不会像尾随 debounce（每次 clearTimeout 重计）那样被间隔小于窗口的连续事件无限
 *     推迟。sql.js 单线程模型下这就是普通的 setTimeout 合并，不伪造任何锁。
 *   - **监听器异常隔离**：单个 listener 抛错只记警告，不影响其他 listener 与后续事件。
 */

export type AssignmentInvalidationAction = 'assign' | 'claim' | 'recycle' | 'transfer'

/** 最小失效载荷（只读；不含任何客户敏感字段） */
export interface AssignmentInvalidationEvent {
  /** 单动作 = 原动作；去抖窗口内多动作合并时按固定顺序逗号连接（如 'assign,recycle'） */
  action: string
  /** 本次窗口内发生归属变化的 lead id（去重升序） */
  leadIds: number[]
  /** 事件生成时刻（ms） */
  at: number
}

export type AssignmentInvalidationListener = (event: AssignmentInvalidationEvent) => void

/** 合并窗口（毫秒）：固定窗口——首个事件启动、窗口内只合并不重置、到期必然 flush，最大通知延迟 = 本值 */
export const ASSIGN_INVALIDATION_FLUSH_MS = 150

/** 固定动作顺序：合并时输出稳定，不随触发先后抖动 */
const ACTION_ORDER: AssignmentInvalidationAction[] = ['assign', 'claim', 'recycle', 'transfer']

const listeners = new Set<AssignmentInvalidationListener>()
const pendingActions = new Set<AssignmentInvalidationAction>()
const pendingLeadIds = new Set<number>()
let flushTimer: ReturnType<typeof setTimeout> | null = null

function flushPending(): void {
  flushTimer = null
  if (!pendingLeadIds.size && !pendingActions.size) return
  const action = ACTION_ORDER.filter((a) => pendingActions.has(a)).join(',')
  const leadIds = Array.from(pendingLeadIds).sort((a, b) => a - b)
  pendingActions.clear()
  pendingLeadIds.clear()
  if (!leadIds.length) return
  const event: AssignmentInvalidationEvent = { action, leadIds, at: Date.now() }
  for (const listener of listeners) {
    try { listener(event) } catch (e) {
      console.warn('[CRM] assignment invalidation 监听器异常（已隔离）:', e)
    }
  }
}

/**
 * 通知「assignment 归属数据已变化」。**只能在写事务成功提交后调用**；
 * leadIds 只收正整数（防御脏入参），非法 action 忽略。固定窗口内多次调用合并为一条事件：
 * 首次调用启动计时，后续调用只合并不重置，窗口到期必然 flush（最大延迟有界，见头注释）。
 */
export function emitAssignmentInvalidated(action: AssignmentInvalidationAction, leadIds: number[]): void {
  if (!ACTION_ORDER.includes(action)) return
  const ids = Array.isArray(leadIds) ? leadIds : []
  const valid = new Set<number>()
  for (const id of ids) {
    const n = Number(id)
    if (Number.isInteger(n) && n > 0) valid.add(n)
  }
  if (!valid.size) return
  for (const n of valid) pendingLeadIds.add(n)
  pendingActions.add(action)
  // 固定窗口：只在窗口未开启时启动计时；窗口内后续事件只合并不重置，到期 flushPending 必然执行
  if (flushTimer === null) {
    flushTimer = setTimeout(flushPending, ASSIGN_INVALIDATION_FLUSH_MS)
  }
}

/** 订阅失效事件；返回清理函数（调用后不再收到事件，防监听器泄漏） */
export function onAssignmentInvalidated(listener: AssignmentInvalidationListener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** 测试钩子：同步冲刷待发合并窗口（生产路径不用） */
export function flushAssignmentInvalidationForTest(): void {
  if (flushTimer) { clearTimeout(flushTimer); flushPending() }
  else flushPending()
}

/** 测试钩子：清空待发状态与全部监听（用例间隔离） */
export function resetAssignmentInvalidationForTest(): void {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
  pendingActions.clear()
  pendingLeadIds.clear()
  listeners.clear()
}
