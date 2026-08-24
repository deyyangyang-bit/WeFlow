/**
 * action-rules-test.ts —— 今日行动规则阶段口径单测（P0-2A.3）
 *
 * 只修「阶段比较口径」：RULES.match 的 p.stage 比较统一过 normalizeStage → canonical。
 * 验收断言：
 *   ① 中文 stage 命中对应规则（比价→R1 / 了解→R4 / 决策→R2 / 新客→R3 / 未知→R0）
 *   ② 同一客户中文 stage 与 canonical stage → 命中结果一致
 *   ③ rule_r1_quoted_followup 对真实 比价/quoted 客户确实命中
 *   ④ dormant 不走 stage 判断：R5/R6 显式读 activityState（时间性沉默），已成交/流失不触发
 *   ⑤ runFullScan 集成：真实中文 stage 客户落库 → 生成对应规则任务
 * 运行：npx tsx scripts/action-rules-test.ts
 */
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { salesDbService, type CustomerProfile } from '../electron/services/salesDbService'
import { getActionRule, runFullScan, lazyScan, lastContactSec } from '../electron/services/salesActionEngine'

let pass = 0, fail = 0
function ok(name: string, cond: boolean): void {
  if (cond) { pass++ } else { fail++; console.error('FAIL:', name) }
}

const NOW_SEC = Math.floor(Date.now() / 1000)
const DAY_SEC = 86400

/** 构造规则匹配用的客户画像（last_contact_at 为秒；created_at 为毫秒） */
function prof(stage: string, silentDays: number, extra: Partial<CustomerProfile> = {}): CustomerProfile {
  return {
    session_id: 'wx_test',
    display_name: '测试客户',
    stage,
    last_contact_at: NOW_SEC - silentDays * DAY_SEC,
    created_at: NOW_SEC * 1000,
    ...extra
  }
}

/** 直接调 rule.match：中文或 canonical stage 在给定沉默天数下是否命中 */
function hits(ruleId: string, stage: string, silentDays: number): boolean {
  const rule = getActionRule(ruleId)
  if (!rule) { fail++; console.error('FAIL: 找不到规则', ruleId); return false }
  return rule.match(prof(stage, silentDays), NOW_SEC)
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'action-rules-'))
  await salesDbService.initialize(dir)

  // ── ① 中文 stage 命中对应规则 ────────────────────────────────────────────
  ok('1a 比价+3天 → R1 quoted 命中', hits('rule_r1_quoted_followup', '比价', 3))
  ok('1b 了解+6天 → R4 contacted 命中', hits('rule_r4_contacted_silent', '了解', 6))
  ok('1c 决策+3天 → R2 negotiating 命中', hits('rule_r2_negotiating_stall', '决策', 3))
  ok('1d 新客+2天 → R3 new 命中', hits('rule_r3_new_no_reply', '新客', 2))
  ok('1e 未知+2天 → R0 unknown 命中', hits('rule_r0_unknown_followup', '未知', 2))
  ok('1f 新客+2天 → R0 new 兜底命中', hits('rule_r0_unknown_followup', '新客', 2))
  ok('1g 成交+3天 → R1 不命中（已成交不进跟进池）', !hits('rule_r1_quoted_followup', '成交', 3))
  ok('1h 流失+3天 → R1 不命中', !hits('rule_r1_quoted_followup', '流失', 3))

  // ── ② 中文 stage 与 canonical stage → 命中结果一致 ───────────────────────
  const pairs: Array<[string, string, string, number]> = [
    ['比价', 'quoted', 'rule_r1_quoted_followup', 3],
    ['了解', 'contacted', 'rule_r4_contacted_silent', 6],
    ['决策', 'negotiating', 'rule_r2_negotiating_stall', 3],
    ['新客', 'new', 'rule_r3_new_no_reply', 2],
    ['未知', 'unknown', 'rule_r0_unknown_followup', 2]
  ]
  for (const [zh, en, ruleId, days] of pairs) {
    ok(`2a ${zh}(${days}天) == ${en}(${days}天) → ${ruleId} 命中一致`, hits(ruleId, zh, days) === hits(ruleId, en, days))
  }
  ok('2b 比价 vs quoted 同为真（R1 能命中真实 比价 客户）', hits('rule_r1_quoted_followup', '比价', 3) && hits('rule_r1_quoted_followup', 'quoted', 3))

  // ── ③ R5/R6 dormant 走 activityState（时间性沉默），不判 stage === dormant ──
  ok('3a quoted+40天 → R5 唤醒命中（activityState dormant）', hits('rule_r5_dormant_wake', 'quoted', 40))
  ok('3b 比价+40天 → R5 唤醒命中（中文 + 时间沉默）', hits('rule_r5_dormant_wake', '比价', 40))
  ok('3c quoted+5天 → R5 不命中（未达 30 天沉默）', !hits('rule_r5_dormant_wake', 'quoted', 5))
  ok('3d quoted+95天 → R5 不命中（超出 90 天唤醒窗口）', !hits('rule_r5_dormant_wake', 'quoted', 95))
  ok('3e 成交+40天 → R5 不命中（已成交不唤醒）', !hits('rule_r5_dormant_wake', '成交', 40))
  ok('3f 流失+40天 → R5 不命中（已流失不唤醒）', !hits('rule_r5_dormant_wake', '流失', 40))
  ok('3g legacy 沉默 stage → R5 按 activityState 命中', hits('rule_r5_dormant_wake', '沉默', 40))
  ok('3h 成交+40天 → R6 不触发（已成交不放弃）', !hits('rule_r6_consider_drop', '成交', 40))
  ok('3i 比价+5天 → R6 阶段门不进（非 contacted、非 dormant）', !hits('rule_r6_consider_drop', '比价', 5))
  ok('3j 了解+40天无历史任务 → R6 不触发（需 2 次 R4/R5）', !hits('rule_r6_consider_drop', '了解', 40))

  // ── ⑤ runFullScan 集成：真实中文 stage 客户 → 对应规则任务落库 ───────────
  salesDbService.customerUpsert({ session_id: 'wx_c1', display_name: '比价客户', stage: '比价', last_contact_at: NOW_SEC - 3 * DAY_SEC })
  salesDbService.customerUpsert({ session_id: 'wx_c2', display_name: '了解客户', stage: '了解', last_contact_at: NOW_SEC - 6 * DAY_SEC })
  salesDbService.customerUpsert({ session_id: 'wx_c3', display_name: '决策客户', stage: '决策', last_contact_at: NOW_SEC - 3 * DAY_SEC })
  salesDbService.customerUpsert({ session_id: 'wx_c4', display_name: '成交客户', stage: '成交', last_contact_at: NOW_SEC - 3 * DAY_SEC })
  salesDbService.customerUpsert({ session_id: 'wx_c5', display_name: '流失客户', stage: '流失', last_contact_at: NOW_SEC - 3 * DAY_SEC })
  salesDbService.customerUpsert({ session_id: 'wx_c6', display_name: 'quoted 英文客户', stage: 'quoted', last_contact_at: NOW_SEC - 3 * DAY_SEC })
  salesDbService.customerUpsert({ session_id: 'wx_c7', display_name: '新客客户', stage: '新客', last_contact_at: NOW_SEC - 2 * DAY_SEC })

  const result = await runFullScan()
  ok('4a 全量扫描生成任务（R1-R5 共 ≥5 条 + R6）', result.generated >= 5)

  const taskOf = (sid: string) => salesDbService.todoList({ session_id: sid, limit: 5 }).map((t) => t.trigger_type)
  ok('4b 比价 客户 → R1 命中（真实 bug 修复：中文 比价 现在能命中 quoted 规则）', taskOf('wx_c1').includes('rule_r1_quoted_followup'))
  ok('4c 了解 客户 → R4 命中', taskOf('wx_c2').includes('rule_r4_contacted_silent'))
  ok('4d 决策 客户 → R2 命中', taskOf('wx_c3').includes('rule_r2_negotiating_stall'))
  ok('4e 成交 客户 → 无跟进任务（won 跳过）', taskOf('wx_c4').length === 0)
  ok('4f 流失 客户 → 无跟进任务（lost 跳过）', taskOf('wx_c5').length === 0)
  ok('4g quoted 英文客户 → R1 命中（与中文 比价 行为一致）', taskOf('wx_c6').includes('rule_r1_quoted_followup'))
  ok('4h 新客 客户 → R3 命中（urgent 压过 R0）', taskOf('wx_c7').includes('rule_r3_new_no_reply'))

  // ──  last_contact_at 缺失口径漂移回归（线上 20689 天 bug）─────────────────
  const createdMs3d = (NOW_SEC - 3 * DAY_SEC) * 1000
  const pNull: CustomerProfile = { session_id: 'wx_null_lc', display_name: '空最后联系客户', stage: '比价', last_contact_at: null, created_at: createdMs3d }
  const lcNull = lastContactSec(pNull)
  ok('6a lastContactSec 在 last_contact_at=null 时回退 created_at（非 0）', lcNull > 0 && Math.abs(lcNull - (NOW_SEC - 3 * DAY_SEC)) <= 2)
  ok('6b R1 命中 last_contact 为 null 的客户', !!getActionRule('rule_r1_quoted_followup') && getActionRule('rule_r1_quoted_followup')!.match(pNull, NOW_SEC))
  salesDbService.customerUpsert({ session_id: 'wx_lazy_null', display_name: '懒扫描空最后联系', stage: '比价', last_contact_at: null, created_at: createdMs3d })
  await lazyScan()
  const lazyTasks = salesDbService.todoList({ session_id: 'wx_lazy_null', limit: 5 })
  ok('6c 懒扫描为 last_contact=null 客户生成任务', lazyTasks.length === 1)
  ok('6d 标题用回退 3 天而非纪元 20689 天', !!lazyTasks[0] && lazyTasks[0].title.includes('3天') && !lazyTasks[0].title.includes('20689'))

  console.log(`\naction-rules-test: ${pass}/${pass + fail} 通过`)
  process.exit(fail > 0 ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
