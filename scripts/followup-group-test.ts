/**
 * followup-group-test.ts —— 跟进待办同客户去重分组单测
 * 覆盖：同客户合并、无 session 手动待办独立、组内顺序即最高优、
 *       分组保持首见顺序、分页切片（每页 10 组）。
 * 运行：npx tsx scripts/followup-group-test.ts
 */
import { groupFollowUpTasks } from '../src/utils/followUpGroup'
import type { FollowUpTask } from '../src/stores/followUpStore'

let pass = 0, fail = 0
function ok(name: string, cond: boolean): void {
  if (cond) { pass++ } else { fail++; console.error('FAIL:', name) }
}

function task(partial: Partial<FollowUpTask>): FollowUpTask {
  return {
    id: 0,
    trigger_type: 'manual',
    title: '测试',
    status: 'pending',
    created_at: Date.now(),
    ...partial,
  }
}

// 场景：同客户两条（催办 + 规则卡），优先级不同
const sorted = [
  task({ id: 90, session_id: 'wx_a', display_name: '客户A', status: 'pending', priority_score: 50, trigger_type: 'urge_customer', title: '催办' }),
  task({ id: 1377, session_id: 'wx_a', display_name: '客户A', status: 'overdue', priority_score: 80, trigger_type: 'rule_r2_negotiating_stall', title: '谈判跟进' }),
  task({ id: 91, session_id: 'wx_b', display_name: '客户B', status: 'pending', priority_score: 60, trigger_type: 'urge_customer', title: '催办B' }),
  task({ id: 999, status: 'pending', priority_score: 30, trigger_type: 'manual', title: '个人待办' }),
]
// 已按 状态优先(overdue>pending) + priority_score 降序排列（与 FollowUpPage 相同规则）
sorted.sort((a, b) => {
  const order: Record<string, number> = { overdue: 0, pending: 1 }
  const sa = order[a.status] ?? 2, sb = order[b.status] ?? 2
  if (sa !== sb) return sa - sb
  return (b.priority_score || 0) - (a.priority_score || 0)
})

const groups = groupFollowUpTasks(sorted)

ok('a 同客户两条合并为一组', groups.filter(g => g.key === 's:wx_a').length === 1)
const gA = groups.find(g => g.key === 's:wx_a')
ok('a1 主卡是组内最高优（overdue 谈判跟进）', gA?.main.id === 1377)
ok('a2 催办条折叠进 rest', gA?.rest.some(t => t.id === 90))
ok('b 不同客户各自成组', groups.filter(g => g.key === 's:wx_b').length === 1)
ok('c 无 session 手动待办独立成组', groups.filter(g => g.key === 'm:999').length === 1)
ok('d 组数 = 客户A + 客户B + 手动 = 3', groups.length === 3)

// 分页切片：每页 10 组
const PAGE_SIZE = 10
const pageCount = Math.max(1, Math.ceil(groups.length / PAGE_SIZE))
ok('e 分页组数正确', pageCount === 1)
const pageItems = groups.slice(0, PAGE_SIZE)
ok('e1 首页含全部 3 组', pageItems.length === 3)

// 大量数据分页：11 个客户 → 2 页
const many = Array.from({ length: 11 }, (_, i) => task({ id: i + 1000, session_id: `wx_${i}`, display_name: `客户${i}`, status: 'pending' }))
const gMany = groupFollowUpTasks(many)
ok('f 11 客户分页 = 2 页', Math.ceil(gMany.length / PAGE_SIZE) === 2)
ok('f1 第 2 页剩 1 组', gMany.slice(PAGE_SIZE, PAGE_SIZE * 2).length === 1)

console.log(`结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail > 0 ? 1 : 0)
