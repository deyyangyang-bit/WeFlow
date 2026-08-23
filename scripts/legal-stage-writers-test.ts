/**
 * legal-stage-writers-test.ts —— P0-2A.6 合法写者元数据收口回归测试
 *
 * 验收断言（真实 DB 级，temp 目录）：
 *   ① manual correct：合法值写入 —— intent_tag_log(source=manual) + 同步 stage + 写 last_stage_change_at
 *   ② manual correct：拒绝非枚举值（垃圾值 / 沉默 dormant），且不产生写入副作用
 *   ③ manual correct：同阶段重复确认不刷新 changedAt（幂等拦截），判断记录仍保留
 *   ④ manual correct：新客户建档（stage + manual 记录 + changedAt）
 *   ⑤ deal rule：补写 intent_tag_log(source=deal_rule) + stage=won + 写 last_stage_change_at
 *   ⑥ deal rule：已 won 重复成交信号不刷新 changedAt，判断记录仍保留
 *   ⑦ read model 集成：getCanonicalState 看到 stage=won + stateMeta.source=deal_rule + changedAt 对齐
 *
 * 设计说明：写路径抽到 electron/services/legalStageWriters.ts（不依赖 Electron），
 * 测试加载真实生产函数而非复制行为。运行：npx tsx scripts/legal-stage-writers-test.ts
 */
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { salesDbService } from '../electron/services/salesDbService'
import { applyManualStageCorrection, applyDealStageWon } from '../electron/services/legalStageWriters'

let pass = 0, fail = 0
function ok(name: string, cond: boolean): void {
  if (cond) { pass++ } else { fail++; console.error('FAIL:', name) }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'legal-writers-'))
  await salesDbService.initialize(dir)

  // ── ① manual 合法写入 ──────────────────────────────────────────────────────
  salesDbService.customerUpsert({ session_id: 'wx_m', display_name: '手动客户', stage: '比价' })
  const r1 = applyManualStageCorrection('wx_m', '决策', '手动切换阶段')
  const m1 = salesDbService.customerGetBySession('wx_m')
  ok('1a 返回 success', r1.success === true)
  ok('1b stage 更新为 决策', m1?.stage === '决策')
  const intent1 = salesDbService.intentHistory('wx_m', 5)[0]
  ok('1c intent_tag_log 有 manual 记录', intent1?.stage === '决策' && intent1?.source === 'manual')
  ok('1d reason 透传', intent1?.reason === '手动切换阶段')
  ok('1e last_stage_change_at 已写入（>0）', !!m1?.last_stage_change_at && m1.last_stage_change_at > 0)

  // ── ② manual 拒绝非枚举值 ──────────────────────────────────────────────────
  const rBad = applyManualStageCorrection('wx_m', 'foo', '手动')
  ok('2a 垃圾值被拒绝（success=false）', rBad.success === false)
  ok('2b 拒绝后 stage 不变', salesDbService.customerGetBySession('wx_m')?.stage === '决策')
  const rDorm = applyManualStageCorrection('wx_m', '沉默', '手动')
  ok('2c 沉默(dormant)被拒绝 —— dormant 是活动状态非阶段', rDorm.success === false)
  const rEmpty = applyManualStageCorrection('wx_m', '', '手动')
  ok('2d 空值被拒绝', rEmpty.success === false)
  ok('2e 拒绝后无新增记录（仅 1a 的 1 条）', salesDbService.intentHistory('wx_m', 10).length === 1)

  // ── ③ manual 同阶段重复确认不刷 changedAt ──────────────────────────────────
  const t1 = salesDbService.customerGetBySession('wx_m')?.last_stage_change_at
  await sleep(10)
  applyManualStageCorrection('wx_m', '决策', '手动切换阶段')
  const m3 = salesDbService.customerGetBySession('wx_m')
  ok('3a 同阶段重复确认 changedAt 不刷新（幂等拦截）', m3?.last_stage_change_at === t1)
  ok('3b 判断记录仍保留（+1 条 manual）', salesDbService.intentHistory('wx_m', 10).length === 2)

  // ── ④ manual 新客户建档 ────────────────────────────────────────────────────
  const rNew = applyManualStageCorrection('wx_newm', '比价', '手动建档')
  const nm = salesDbService.customerGetBySession('wx_newm')
  ok('4a 新客户已建档 stage=比价', rNew.success === true && nm?.stage === '比价')
  ok('4b manual 记录写入', salesDbService.intentHistory('wx_newm', 5)[0]?.source === 'manual')
  ok('4c changedAt 已写入', !!nm?.last_stage_change_at && nm.last_stage_change_at > 0)
  // 中文别名合法值
  ok('4d 中文别名已报价 被接受', applyManualStageCorrection('wx_newm', '已报价', '别名').success === true)

  // ── ⑤ deal rule 补写元数据 ─────────────────────────────────────────────────
  salesDbService.customerUpsert({ session_id: 'wx_d', display_name: '成交客户', stage: '比价' })
  applyDealStageWon('wx_d', '成交客户')
  const d1 = salesDbService.customerGetBySession('wx_d')
  ok('5a stage 更新为 won', d1?.stage === 'won')
  const dIntent = salesDbService.intentHistory('wx_d', 5)[0]
  ok('5b intent_tag_log 补写 deal_rule 记录', dIntent?.stage === 'won' && dIntent?.source === 'deal_rule')
  ok('5c reason=私聊成交信号', dIntent?.reason === '私聊成交信号')
  ok('5d last_stage_change_at 已写入', !!d1?.last_stage_change_at && d1.last_stage_change_at > 0)

  // ── ⑥ deal rule 已 won 重复成交不刷 changedAt ─────────────────────────────
  const tD = d1?.last_stage_change_at
  await sleep(10)
  applyDealStageWon('wx_d', '成交客户')
  const d2 = salesDbService.customerGetBySession('wx_d')
  ok('6a 重复成交信号不刷新 changedAt', d2?.last_stage_change_at === tD)
  ok('6b 判断记录仍保留（+1 条 deal_rule）', salesDbService.intentHistory('wx_d', 10).length === 2)

  // ── ⑦ read model 集成 ─────────────────────────────────────────────────────
  const integ = salesDbService.getCanonicalState('wx_d')
  ok('7a canonical stage=won', !!integ && integ.stage === 'won')
  ok('7b stateMeta.source=deal_rule（谁判的）', !!integ && integ.stateMeta.source === 'deal_rule')
  ok('7c stateMeta.changedAt 对齐 last_stage_change_at', !!integ && integ.stateMeta.changedAt === salesDbService.customerGetBySession('wx_d')?.last_stage_change_at)

  console.log(`\nlegal-stage-writers-test: ${pass}/${pass + fail} 通过`)
  process.exit(fail > 0 ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
