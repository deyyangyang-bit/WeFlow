/**
 * upsert-stage-ban-test.ts —— P0-2A.5 通用 upsert 撤销 stage 写权限回归测试
 *
 * 验收断言（真实 DB 级，temp 目录）：
 *   ① stripStageFromUpsert：剥离 stage，其余字段（display_name/tags/notes/customer_id/external_source/last_contact_at）原样保留
 *   ② 用户新增验收：`sales:customer:upsert({stage, tags, notes})` 执行后，tags/notes 正常更新，而 stage 保持原值
 *   ③ 新客户：stripped upsert → stage='unknown'（绝不落调用方传入的阶段），其余字段写入
 *   ④ 组合 payload 不因禁 stage 而整体损坏（display_name/tags/notes/customer_id/external_source/last_contact_at 全部写入）
 *   ⑤ 底层 salesDbService.customerUpsert 未被破坏：合法写者（manual/intent/deal/classifier）仍能写 stage（负向控制）
 *   ⑥ updateStage 等价流程（manual 写者）：intentCreate(source=manual) + customerUpsert(stage) → stage 正确更新 + intent_tag_log 有 manual 记录
 *
 * 设计说明：IPC 运行时剥离抽到 electron/services/customerUpsertPolicy.ts（不依赖 Electron），
 * 测试加载真实生产函数而非复制行为；类型层删除由 preload/electron.d.ts 移除 stage 字段保证（tsc 校验）。
 * 运行：npx tsx scripts/upsert-stage-ban-test.ts
 */
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { salesDbService } from '../electron/services/salesDbService'
import { stripStageFromUpsert } from '../electron/services/customerUpsertPolicy'

let pass = 0, fail = 0
function ok(name: string, cond: boolean): void {
  if (cond) { pass++ } else { fail++; console.error('FAIL:', name) }
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'upsert-stage-ban-'))
  await salesDbService.initialize(dir)

  // ── ① stripStageFromUpsert：剥离 stage，其余原样保留 ───────────────────────
  const input = { session_id: 'wx_a', display_name: '客户A', stage: '决策', tags: '[1]', notes: '备注', customer_id: 'cid', external_source: 'wechat', last_contact_at: 1700000000 }
  const stripped = stripStageFromUpsert(input)
  ok('1a stage 已剥离', !('stage' in stripped))
  ok('1b display_name 保留', stripped.display_name === '客户A')
  ok('1c tags 保留', stripped.tags === '[1]')
  ok('1d notes 保留', stripped.notes === '备注')
  ok('1e customer_id 保留', stripped.customer_id === 'cid')
  ok('1f external_source 保留', stripped.external_source === 'wechat')
  ok('1g last_contact_at 保留', stripped.last_contact_at === 1700000000)
  ok('1h 入参未被修改', input.stage === '决策')

  // ── ② 用户验收：upsert({stage, tags, notes}) → tags/notes 更新，stage 保持原值 ──
  salesDbService.customerUpsert({ session_id: 'wx_b', display_name: '比价客户', stage: '比价' })
  const payloadB = stripStageFromUpsert({ session_id: 'wx_b', stage: '决策', tags: '[1,2]', notes: '新增备注' })
  salesDbService.customerUpsert(payloadB)
  const b = salesDbService.customerGetBySession('wx_b')
  ok('2a stage 保持原值 比价（未被 payload 的 决策 覆盖）', b?.stage === '比价')
  ok('2b tags 正常更新为 [1,2]', b?.tags === '[1,2]')
  ok('2c notes 正常更新为 新增备注', b?.notes === '新增备注')

  // ── ③ 新客户：stripped upsert → stage=unknown，其余字段写入 ────────────────
  salesDbService.customerUpsert(stripStageFromUpsert({ session_id: 'wx_new', display_name: '新客户', stage: '成交', notes: 'n' }))
  const n = salesDbService.customerGetBySession('wx_new')
  ok('3a 新客户已建档（display_name 写入）', !!n && n.display_name === '新客户')
  ok('3b 新客户 stage=unknown（绝不落 成交）', n?.stage === 'unknown')
  ok('3c notes 写入', n?.notes === 'n')

  // ── ④ 组合 payload 不因禁 stage 而整体损坏 ─────────────────────────────────
  salesDbService.customerUpsert(stripStageFromUpsert({ session_id: 'wx_full', display_name: '全字段', stage: '决策', tags: '[3]', notes: '全', customer_id: 'cid2', external_source: 'wechat', last_contact_at: 1710000000 }))
  const f = salesDbService.customerGetBySession('wx_full')
  ok('4a display_name 写入', f?.display_name === '全字段')
  ok('4b stage=unknown（默认）', f?.stage === 'unknown')
  ok('4c tags 写入', f?.tags === '[3]')
  ok('4d notes 写入', f?.notes === '全')
  ok('4e customer_id 写入', f?.customer_id === 'cid2')
  ok('4f external_source 写入', f?.external_source === 'wechat')
  ok('4g last_contact_at 写入', f?.last_contact_at === 1710000000)

  // ── ⑤ 负向控制：底层 customerUpsert 未被破坏（合法写者仍能写 stage）──────────
  salesDbService.customerUpsert({ session_id: 'wx_b', display_name: '比价客户', stage: '决策' })
  ok('5a 合法写者路径（manual/intent/deal/classifier 直调底层）仍能写 stage', salesDbService.customerGetBySession('wx_b')?.stage === '决策')

  // ── ⑥ updateStage 等价流程（manual 写者，即 intentCorrect 行为）────────────
  salesDbService.intentCreate({ session_id: 'wx_b', stage: '成交', source: 'manual', reason: '手动切换阶段' })
  salesDbService.customerUpsert({ session_id: 'wx_b', stage: '成交' })
  const manual = salesDbService.intentHistory('wx_b', 5)[0]
  ok('6a intent_tag_log 有 manual 记录（stage=成交）', manual?.stage === '成交' && manual?.source === 'manual')
  ok('6b manual 写者同步更新 stage', salesDbService.customerGetBySession('wx_b')?.stage === '成交')

  console.log(`\nupsert-stage-ban-test: ${pass}/${pass + fail} 通过`)
  process.exit(fail > 0 ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
