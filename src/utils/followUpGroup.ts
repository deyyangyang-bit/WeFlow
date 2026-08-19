/**
 * followUpGroup.ts —— 跟进待办同客户去重分组（纯函数）
 *
 * 老页面 FollowUpPage 直接平铺 follow_up_task，同一客户常有多条待办
 * （urge_customer 催办 + rule_r1/r2 规则卡），列表刷屏。这里按客户合并：
 * 同 session_id 的任务归为一组，组内第一条（调用方已按 状态+priority_score
 * 排序，首见即最高优先级）为主卡，其余折叠为 rest。
 * 无 session_id 的手动待办各自独立成组（key 用 task.id），不互相合并。
 */
import type { FollowUpTask } from '../stores/followUpStore'

export interface FollowUpGroup {
  /** 分组键：s:<session_id> 或 m:<task.id>（无客户的手动待办） */
  key: string
  /** 主卡：组内最高优先级任务 */
  main: FollowUpTask
  /** 折叠的其余任务（同客户，低于主卡优先级） */
  rest: FollowUpTask[]
}

/**
 * 同客户去重分组。
 * 输入应为已排序任务数组（FollowUpPage 现有 displayTasks），
 * 分组顺序保持首见顺序，组内保持原顺序 → main 即最高优任务。
 */
export function groupFollowUpTasks(tasks: FollowUpTask[]): FollowUpGroup[] {
  const byKey = new Map<string, FollowUpTask[]>()
  for (const t of tasks) {
    const key = t.session_id && String(t.session_id).trim() ? `s:${t.session_id}` : `m:${t.id}`
    const list = byKey.get(key)
    if (list) list.push(t)
    else byKey.set(key, [t])
  }
  const groups: FollowUpGroup[] = []
  for (const [key, list] of byKey) {
    groups.push({ key, main: list[0], rest: list.slice(1) })
  }
  return groups
}
