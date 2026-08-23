/**
 * actionFunnel.ts —— P0-4.2.2：Action Funnel 只读组装层（Task-level，非 Event-volume）
 *              + P0-4.3：getActionFunnelBreakdown 下钻原语（KPI 点击可追溯到事件）
 *
 * 拍板契约（用户 2026-08-24 P0-4.2 三刀 + P0-4.3 三件事）：
 *   - 只读组装：绝不实时推理（不调 LLM、不从 customer_judgment 推导）；
 *     只消费 follow_up_task / customer_event / customer_profile（canonical State）。
 *   - 每段唯一事实来源可解释：sources 字段逐段声明（见 ACTION_FUNNEL_SOURCES）。
 *   - 任何分母为 0 → rate = null（不是 0%，避免 UI 把「没有样本」误读成「0% 转化」）。
 *   - Task-level 去重（不是 event-volume）：
 *       executed  = 该 task 至少存在一个执行事件（script_copied OR chat_opened OR follow_up_done，task_id 关联）
 *       responded = 该 task 的 session 在 task 产生后存在 customer_replied / quote_asked
 *     每个 task 的 executed/responded 都是 0/1 布尔，而不是按事件条数计数。
 *   - G1 曝光段本期不做：exposed = null（不可测，N-A），不伪造分母、不算曝光→执行率。
 *   - 窗口语义：days 只过滤 created（task.created_at >= now - days）；null = 全量。
 *     每 task 的后续判定用其全生命周期（>= task.created_at），不截断窗口。
 *   - P0-4.3 下钻：数字必须能追溯到事件——breakdown 返回事件类型计数 + 任务样本，
 *     聚合与下钻共享同一判定行（collectTaskRows），防口径分叉。
 *
 * 六段漏斗：① 行动产生 → ② 行动曝光（不可测 N-A）→ ③ 销售执行 → ④ 客户响应 →
 *           ⑤ 有效推进（stage 前进）→ ⑥ 商机转化（won）
 *
 * 纯只读：不写库、不调 LLM、不消费 customer_judgment / intent_tag_log（判断层）。
 */
import { salesDbService, type FollowUpTask } from './salesDbService'
import { normalizeStage } from '../../shared/salesStage'
import type { CustomerEventType } from '../../shared/customerEvent'

/** 每段唯一事实来源（可解释性：每个指标都能说清来自哪张表；G1 曝光段本期不可测） */
export const ACTION_FUNNEL_SOURCES = {
  created: 'follow_up_task',
  exposed: 'unmeasured',
  executed: 'customer_event',
  responded: 'customer_event',
  progressed: 'customer_profile.stage',
  won: 'customer_profile.stage'
} as const

/** Action Funnel 只读视图（read model，同 customerCurrentView 先例；无第二套 Action Log） */
export interface ActionFunnel {
  /** 统计窗口（days=null → 全量） */
  window: { days: number | null; startMs: number | null }
  stages: {
    /** ① 行动产生：窗口内 follow_up_task（superseded 不重复计） */
    created: number
    /** ② 行动曝光：G1 不可测（本期承认 N-A，不伪造分母） */
    exposed: null
    /** ③ 销售执行：至少一个执行事件（task_id 关联）的 task 数 */
    executed: number
    /** ④ 客户响应：task 产生后 session 有客户响应事件的 task 数 */
    responded: number
    /** ⑤ 有效推进：task 产生后 stage 有变更（last_stage_change_at）的 task 数 */
    progressed: number
    /** ⑥ 商机转化：当前 stage=won 的 task 数 */
    won: number
  }
  /** 段间转化率（相邻段之比；分母为 0 → null，不返回 0%） */
  rates: {
    exposure: null
    execution: number | null
    response: number | null
    progression: number | null
    conversion: number | null
  }
  sources: typeof ACTION_FUNNEL_SOURCES
  /** 口径透明：被排除的 superseded 任务数（盘点：superseded 不重复计） */
  supersededCount: number
}

/** P0-4.3 下钻：KPI 点击后的事件级解释——计数可追溯到事件类型与任务样本（与聚合共享判定行） */
export interface ActionFunnelBreakdown {
  window: { days: number | null; startMs: number | null }
  executed: {
    /** 已执行 task 数（与 stages.executed 一致） */
    count: number
    /** 未执行 task 数（created - executed） */
    unexecuted: number
    /** 执行事件类型计数（事件条数，非 task 数——一个 task 可有多事件） */
    eventTypeCounts: { script_copied: number; chat_opened: number; follow_up_done: number }
    /** 最近已执行任务样本（created_at 降序，上限 SAMPLE_LIMIT） */
    samples: Array<{ taskId: number; sessionId: string; title: string; createdAt: number; eventTypes: CustomerEventType[] }>
  }
  responded: {
    /** 已响应 task 数（与 stages.responded 一致） */
    count: number
    /** 执行后未响应 task 数（executed - responded） */
    unresponded: number
    /** 响应事件类型计数（事件条数，非 task 数） */
    eventTypeCounts: { customer_replied: number; quote_asked: number }
    samples: Array<{ taskId: number; sessionId: string; title: string; createdAt: number }>
  }
}

/** 执行三事件（E3.3）：任一存在即算该 task 被销售执行 */
const EXECUTED_EVENT_TYPES: CustomerEventType[] = ['script_copied', 'chat_opened', 'follow_up_done']

/** 客户响应两事件（E3.2）：客户真实反馈（含报价询问） */
const RESPONDED_EVENT_TYPES: CustomerEventType[] = ['customer_replied', 'quote_asked']

const DAY_MS = 24 * 3600 * 1000

function divRate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null
}

/** 单 task 的漏斗判定行（Task-level 布尔 + 命中事件类型，聚合与下钻共享，防口径分叉） */
interface TaskFunnelRow {
  task: FollowUpTask
  executed: boolean
  /** 该 task 时序通过的执行事件类型（去重，供下钻展示「这个任务执行了哪些动作」） */
  executedTypes: CustomerEventType[]
  responded: boolean
  progressed: boolean
  won: boolean
}

/** 全零事件计数（5 类型显式列出——未来新增类型将触发 TS 编译错误，白名单不膨胀的编译期保障） */
function zeroEventCounts(): Record<CustomerEventType, number> {
  return { script_copied: 0, chat_opened: 0, follow_up_done: 0, customer_replied: 0, quote_asked: 0 }
}

/**
 * 构建 Task 级判定行 + 事件级计数（P0-4.3 提取自 getActionFunnel，聚合与 breakdown 共享同一口径）。
 * 只读：不写库、不调 LLM；无 task_id 执行事件不归入任何 task（不伪造关联）。
 */
function collectTaskRows(startMs: number | null): {
  rows: TaskFunnelRow[]
  supersededCount: number
  executedEventCounts: Record<CustomerEventType, number>
  respondedEventCounts: Record<CustomerEventType, number>
} {
  const tasks = salesDbService.tasksCreatedSince(startMs)

  // 执行事件索引：task_id → 事件明细（P0-4.2.1 correlation 三元组）
  const executedByTask = new Map<number, Array<{ type: CustomerEventType; ts: number }>>()
  for (const type of EXECUTED_EVENT_TYPES) {
    for (const ev of salesDbService.customerEventsByType(type)) {
      if (ev.task_id == null) continue // insight 卡等无任务上下文的事件：不归入任何 task
      const item = { type, ts: ev.created_at ?? 0 }
      const list = executedByTask.get(ev.task_id)
      if (list) list.push(item)
      else executedByTask.set(ev.task_id, [item])
    }
  }

  // 响应事件索引：session_id → 事件明细（客户事件无 task_id，session 轴关联——用户拍板）
  const respondedBySession = new Map<string, Array<{ type: CustomerEventType; ts: number }>>()
  for (const type of RESPONDED_EVENT_TYPES) {
    for (const ev of salesDbService.customerEventsByType(type)) {
      const item = { type, ts: ev.created_at ?? 0 }
      const list = respondedBySession.get(ev.session_id)
      if (list) list.push(item)
      else respondedBySession.set(ev.session_id, [item])
    }
  }

  const rows: TaskFunnelRow[] = []
  let supersededCount = 0
  const executedEventCounts = zeroEventCounts()
  const respondedEventCounts = zeroEventCounts()

  for (const task of tasks) {
    // ① created：superseded 不重复计（其「产生」已由取代者代表）
    if (task.status === 'superseded') { supersededCount++; continue }
    const taskCreatedAt = task.created_at ?? 0
    const sessionId = task.session_id ?? ''
    const taskId = task.id

    // ③ executed：task 至少一个执行事件（task_id 精确关联；事件须在 task 产生后）
    let executed = false
    const executedTypes: CustomerEventType[] = []
    if (taskId != null) {
      const events = executedByTask.get(taskId)
      if (events) {
        for (const e of events) {
          if (e.ts < taskCreatedAt) continue // 时序守卫：task 产生前的事件不算
          executed = true
          executedEventCounts[e.type]++
          if (!executedTypes.includes(e.type)) executedTypes.push(e.type)
        }
      }
    }

    // ④ responded：session 级关联（客户事件无 task_id，session 轴足够）
    let responded = false
    if (sessionId) {
      const events = respondedBySession.get(sessionId)
      if (events) {
        for (const e of events) {
          if (e.ts < taskCreatedAt) continue
          responded = true
          respondedEventCounts[e.type]++
        }
      }
    }

    // ⑤⑥ progressed / won：customer_profile canonical State（不消费 customer_judgment）
    let progressed = false
    let won = false
    const profile = sessionId ? salesDbService.customerGetBySession(sessionId) : undefined
    if (profile) {
      if (profile.last_stage_change_at != null && profile.last_stage_change_at >= taskCreatedAt) progressed = true
      if (normalizeStage(profile.stage) === 'won') won = true
    }

    rows.push({ task, executed, executedTypes, responded, progressed, won })
  }

  return { rows, supersededCount, executedEventCounts, respondedEventCounts }
}

/**
 * Action Funnel 只读组装（Task-level 去重；days=null → 全量 created）。
 * 只读：不写库、不调 LLM；executed/responded 均为 task 布尔，非事件条数。
 */
export function getActionFunnel(days: number | null = null, now: number = Date.now()): ActionFunnel {
  const startMs = days !== null && days > 0 ? now - days * DAY_MS : null
  const { rows, supersededCount } = collectTaskRows(startMs)

  let created = 0
  let executed = 0
  let responded = 0
  let progressed = 0
  let won = 0
  for (const r of rows) {
    created++
    if (r.executed) executed++
    if (r.responded) responded++
    if (r.progressed) progressed++
    if (r.won) won++
  }

  return {
    window: { days, startMs },
    stages: {
      created,
      exposed: null,
      executed,
      responded,
      progressed,
      won
    },
    rates: {
      exposure: null,
      execution: divRate(executed, created),
      response: divRate(responded, executed),
      progression: divRate(progressed, responded),
      conversion: divRate(won, progressed)
    },
    sources: ACTION_FUNNEL_SOURCES,
    supersededCount
  }
}

/** 下钻样本上限（KPI 点击后展示最近任务，不做全量列表） */
const SAMPLE_LIMIT = 10

/**
 * Action Funnel 下钻（P0-4.3）：KPI 数字可追溯到事件——事件类型计数 + 最近任务样本。
 * 与 getActionFunnel 共享 collectTaskRows 判定行，口径严格一致；只读不写库。
 */
export function getActionFunnelBreakdown(days: number | null = null, now: number = Date.now()): ActionFunnelBreakdown {
  const startMs = days !== null && days > 0 ? now - days * DAY_MS : null
  const { rows, executedEventCounts, respondedEventCounts } = collectTaskRows(startMs)

  const executedRows = rows.filter((r) => r.executed)
  const respondedRows = rows.filter((r) => r.responded)
  const byCreatedDesc = (a: TaskFunnelRow, b: TaskFunnelRow): number => (b.task.created_at ?? 0) - (a.task.created_at ?? 0)

  return {
    window: { days, startMs },
    executed: {
      count: executedRows.length,
      unexecuted: rows.length - executedRows.length,
      eventTypeCounts: {
        script_copied: executedEventCounts.script_copied,
        chat_opened: executedEventCounts.chat_opened,
        follow_up_done: executedEventCounts.follow_up_done
      },
      samples: [...executedRows].sort(byCreatedDesc).slice(0, SAMPLE_LIMIT).map((r) => ({
        taskId: r.task.id ?? 0, // 任务主键 DB 必有；?? 0 仅类型兜底（interface id 可选）
        sessionId: r.task.session_id ?? '',
        title: r.task.title ?? '',
        createdAt: r.task.created_at ?? 0,
        eventTypes: r.executedTypes
      }))
    },
    responded: {
      count: respondedRows.length,
      unresponded: executedRows.length - respondedRows.length,
      eventTypeCounts: {
        customer_replied: respondedEventCounts.customer_replied,
        quote_asked: respondedEventCounts.quote_asked
      },
      samples: [...respondedRows].sort(byCreatedDesc).slice(0, SAMPLE_LIMIT).map((r) => ({
        taskId: r.task.id ?? 0, // 任务主键 DB 必有；?? 0 仅类型兜底（interface id 可选）
        sessionId: r.task.session_id ?? '',
        title: r.task.title ?? '',
        createdAt: r.task.created_at ?? 0
      }))
    }
  }
}
