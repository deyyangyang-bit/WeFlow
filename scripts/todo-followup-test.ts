/**
 * todo-followup-test.ts —— 手动待办进今日行动信号流单测
 * 覆盖：无客户手动待办 → 虚拟 sessionId todo:<id> 独立卡（绕过沉默过滤）、
 *       绑客户手动待办 → 并入客户卡（不受 silentDays=0 过滤）、
 *       completeUnifiedSignal 对 todo: 虚拟卡完成即关闭、todoCreate 老链路兼容。
 * 运行：npx tsx scripts/todo-followup-test.ts
 */
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { salesDbService } from '../electron/services/salesDbService'
import { getUnifiedSignals, completeUnifiedSignal } from '../electron/services/salesActionEngine'

let pass = 0, fail = 0
function ok(name: string, cond: boolean): void {
  if (cond) { pass++ } else { fail++; console.error('FAIL:', name) }
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'todo-fu-'))
  await salesDbService.initialize(dir)

  // 绑客户：contacted + last_contact=now → silentDays=0（通用任务路径会丢，manual 分支必须保住）
  salesDbService.customerUpsert({ session_id: 'wx_contacted', display_name: '张总', stage: 'contacted', last_contact_at: Math.floor(Date.now() / 1000) })

  // 手动待办 A（绑客户）+ B（无客户）
  const t1 = salesDbService.todoCreate({ trigger_type: 'manual', title: '下午联系张总确认合同', session_id: 'wx_contacted', status: 'pending', priority_score: 40, created_by: 'manual' })
  const t2 = salesDbService.todoCreate({ trigger_type: 'manual', title: '整理下周报价单', session_id: null, status: 'pending', priority_score: 40, created_by: 'manual' })

  // D: 老链路兼容 —— 无 session 也正常落库，todoList 可见
  const all = salesDbService.todoList({})
  ok('d1 两条手动待办都落库', all.length === 2)
  ok('d2 无客户待办 session_id 为空仍可查', all.some(t => t.id === t2.id && !t.session_id))

  const result = await getUnifiedSignals()
  const signals = result.signals || []

  // A: 无客户手动待办 → 虚拟 todo:<id> 卡
  const t2key = `todo:${t2.id}`
  const t2sig = signals.find((s: any) => s.sessionId === t2key)
  ok('a1 无客户手动待办出现在信号流（todo:<id> 独立卡）', !!t2sig)
  ok('a2 stage=manual', t2sig?.stage === 'manual')
  ok('a3 来源标签=手动待办', t2sig?.sources?.[0]?.label === '手动待办')
  ok('a4 displayName 回退标题', t2sig?.displayName === '整理下周报价单')

  // C: 绑客户手动待办 → 并入客户卡（silentDays=0 不丢）
  const csig = signals.find((s: any) => s.sessionId === 'wx_contacted')
  ok('c1 绑客户手动待办并入客户卡（不受沉默0天过滤）', !!csig)
  ok('c2 卡含手动待办来源 MAN', csig?.sources?.some((s: any) => s.ruleCode === 'MAN'))
  ok('c3 卡显示客户名', csig?.displayName === '张总')

  // B: completeUnifiedSignal 对 todo: 虚拟卡完成 → 任务 done
  completeUnifiedSignal(t2key, 'done')
  const t2after = salesDbService.getTask(t2.id!)
  ok('b1 完成虚拟待办 → 状态 done', t2after?.status === 'done')

  // B2: 完成绑客户卡（通用路径）→ 该客户手动待办一并关闭
  completeUnifiedSignal('wx_contacted', 'done')
  const t1after = salesDbService.getTask(t1.id!)
  ok('b2 完成绑客户卡 → 该客户手动待办 done', t1after?.status === 'done')

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
