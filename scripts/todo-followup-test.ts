/**
 * todo-followup-test.ts —— 手动待办进今日行动信号流单测
 * 覆盖：无客户手动待办 → 虚拟 sessionId todo:<id> 独立卡（绕过沉默过滤）、
 *       绑客户手动待办 → 并入客户卡（不受 silentDays=0 过滤）、
 *       completeUnifiedSignal 对 todo: 虚拟卡完成即关闭、todoCreate 老链路兼容、
 *       见解记录（archive/存量 insight）不进卡流（设计-AI见解重定位 §3.2）。
 *
 * 行为变更出处（B 组）：W2a「修复手动卡覆盖、错误批量完成」——完成必须显式指定 taskId，
 *   按客户 session 一次扫掉该客户全部待办被拒绝。引入于 c325179（feat(ai): AI 见解、
 *   用量账本与今日行动）；设计见 docs/规划/AI见解-CRM-今日行动联合优化方案.md §W2a
 *   （定位修正见 docs/规划/AI见解方案-定位修正-20260912.md，标注 W2a「已完成」）。
 *   2026-09-13 归因：本测试 b2 原断言「完成绑客户卡 → 该客户手动待办一并 done」，
 *   正是 W2a 有意移除的批量关闭，故改写为逐条显式 taskId 完成——等价强度：关闭链路仍被验证，
 *   仅入口由「按客户」改为「按待办」。
 * 运行：npx tsx scripts/todo-followup-test.ts
 */
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { salesDbService } from '../electron/services/salesDbService'
import { getUnifiedSignals, completeUnifiedSignal } from '../electron/services/salesActionEngine'
import { insightRecordService } from '../electron/services/insightRecordService'

let pass = 0, fail = 0
function ok(name: string, cond: boolean): void {
  if (cond) { pass++ } else { fail++; console.error('FAIL:', name) }
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'todo-fu-'))
  // 隔离 insightRecordService 落盘（必须在首次调用前；env 生效于 resolveFilePath 首次执行）
  process.env.WEFLOW_USER_DATA_PATH = dir
  await salesDbService.initialize(dir)

  // 绑客户：contacted + last_contact=now → silentDays=0（通用任务路径会丢，manual 分支必须保住）
  salesDbService.customerUpsert({ session_id: 'wx_contacted', display_name: '张总', stage: 'contacted', last_contact_at: Math.floor(Date.now() / 1000) })
  // E 组前置：archive/存量 insight 各一条（该客户无任何 task，若出卡必来自 insight 合流——§3.2 后不应出现）
  salesDbService.customerUpsert({ session_id: 'wx_insight_only', display_name: '动向客户', stage: 'contacted', last_contact_at: Math.floor(Date.now() / 1000) })
  const insightLog = {
    endpoint: 'http://localhost', model: 'test', maxTokens: 100, temperature: 0.7,
    triggerReason: 'activity' as const, allowContext: false, contextCount: 10,
    systemPrompt: 's', userPrompt: 'u', rawOutput: 'o', finalInsight: '测试见解', durationMs: 1, createdAt: Date.now()
  }
  insightRecordService.addRecord({ sessionId: 'wx_insight_only', displayName: '动向客户', sourceType: 'archive', triggerReason: 'activity', insight: '归档见解', log: insightLog })
  insightRecordService.addRecord({ sessionId: 'wx_insight_only', displayName: '动向客户', sourceType: 'insight', triggerReason: 'activity', insight: '存量见解', log: insightLog })

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

  // B2: W2a 起「完成绑客户卡（通用路径）→ 该客户手动待办一并关闭」被有意移除（出处见文件头），
  //     同客户多任务必须逐条显式 taskId 完成，禁止按客户 session 批量扫掉。
  let batchRejected = false
  try { completeUnifiedSignal('wx_contacted', 'done') } catch { batchRejected = true }
  ok('b2 按客户 session 完成被拒（W2a：不能按客户批量完成）', batchRejected)
  ok('b3 被拒后该客户手动待办仍 pending（未被批量扫掉）', salesDbService.getTask(t1.id!)?.status === 'pending')
  completeUnifiedSignal('wx_contacted', 'done', t1.id!)
  ok('b4 显式 taskId 逐条完成 → 该条 done', salesDbService.getTask(t1.id!)?.status === 'done')

  // E: 见解记录不进卡流（设计-AI见解重定位 §3.2：合流分支与 INSIGHT_BOOST 已删）
  ok('e1 archive/存量 insight 记录不产生卡流信号', !signals.some((s: any) => s.sessionId === 'wx_insight_only'))
  ok('e2 卡流无 insight 来源', signals.every((s: any) => (s.sources || []).every((src: any) => src.type !== 'insight')))
  ok('e3 stats.insightOnly/merged 恒 0（字段保留防前端断裂）', result.stats?.insightOnly === 0 && result.stats?.merged === 0)

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
