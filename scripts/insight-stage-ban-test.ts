/**
 * insight-stage-ban-test.ts —— P0-2A.4 insightService 禁写 stage 回归测试
 *
 * 验收断言（真实 DB 级，temp 目录）：
 *   ① 同一客户经过 insightService 扫描（applyParsedStageSignal）前后，
 *      customer_profile.stage 必须保持不变
 *   ② 即使 AI 解析出「推进」阶段（如 比价 → 决策），stage 也不被覆盖（无仲裁逻辑）
 *   ③ 对应 intent_tag_log 必须仍有新的 source='ai' signal 记录（且 confidence=0.7 / reason 与生产一致）
 *   ④ 新客户建档为 stage='unknown'，绝不落 AI 解析的阶段
 *   ⑤ 负向控制：customerUpsert 显式传 stage 才会覆盖 —— 证明「省略 stage」才是保阶段机制，
 *      任何把 stage 重新加回 applyParsedStageSignal 都会让 ① 失败
 *
 * 设计说明：写路径抽到 electron/services/salesInsightWrite.ts（不依赖 Electron），
 * 测试加载真实生产函数而非复制行为；网络/Electron 依赖被隔离在 insightService 之外。
 * 1127 条历史 source:'ai' 记录不回写、不清洗（本次只改变未来写入行为）。
 * 运行：npx tsx scripts/insight-stage-ban-test.ts
 */
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { salesDbService } from '../electron/services/salesDbService'
import { applyParsedStageSignal } from '../electron/services/salesInsightWrite'

let pass = 0, fail = 0
function ok(name: string, cond: boolean): void {
  if (cond) { pass++ } else { fail++; console.error('FAIL:', name) }
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'insight-stage-ban-'))
  await salesDbService.initialize(dir)

  // ── ① 已有客户：扫描前后 stage 保持不变 ────────────────────────────────────
  // Arrange：既有客户，阶段=比价
  salesDbService.customerUpsert({ session_id: 'wx_a', display_name: '比价客户', stage: '比价' })
  const beforeCount = salesDbService.intentHistory('wx_a', 50).length

  // Act：模拟 AI 见解扫描解析出「决策」（本应对应阶段推进）
  applyParsedStageSignal('wx_a', '比价客户', '决策')

  // Assert：customer_profile.stage 未变
  const after = salesDbService.customerGetBySession('wx_a')
  ok('1a 扫描后 stage 仍为 比价（customer_profile.stage 未被 AI 覆盖）', after?.stage === '比价')

  // Assert：intent_tag_log 有新的 signal 记录
  const intents = salesDbService.intentHistory('wx_a', 50)
  const newest = intents[0]
  ok('1b 新增 1 条 signal 记录（intent_tag_log 数量 +1）', intents.length === beforeCount + 1)
  ok('1c signal stage=决策（AI 判断已记录）', newest?.stage === '决策')
  ok('1d signal source=ai（与生产调用一致）', newest?.source === 'ai')
  ok('1e signal confidence=0.7', newest?.confidence === 0.7)
  ok('1f signal reason=见解扫描自动识别', newest?.reason === '见解扫描自动识别')

  // Assert：read model 仍看到原阶段（推进未发生）
  const integ = salesDbService.getCanonicalState('wx_a')
  ok('1g canonical stage 仍为 quoted（比价归一，AI 推进被拒绝）', !!integ && integ.stage === 'quoted')

  // ── ② AI 解析出与当前一致的阶段：signal 进入 stateMeta ─────────────────────
  applyParsedStageSignal('wx_a', '比价客户', '比价')
  const integ2 = salesDbService.getCanonicalState('wx_a')
  ok('2a stage 仍 quoted（不因重复判断而变）', !!integ2 && integ2.stage === 'quoted')
  ok('2b stateMeta.source=ai（signal 仍驱动 read model 元数据）', !!integ2 && integ2.stateMeta.source === 'ai')

  // ── ③ 新客户：建档为 unknown，绝不落 AI 解析阶段 ───────────────────────────
  applyParsedStageSignal('wx_new', '新客户', '成交')
  const created = salesDbService.customerGetBySession('wx_new')
  ok('3a 新客户已建档（display_name 写入）', !!created && created.display_name === '新客户')
  ok('3b 新客户 stage=unknown（绝不落 AI 的 成交）', created?.stage === 'unknown')
  ok('3c signal 仍记录 成交', salesDbService.intentHistory('wx_new', 5)[0]?.stage === '成交')
  ok('3d read model 视图 unknown（异常位，不进漏斗）', salesDbService.getCanonicalState('wx_new')?.stage === 'unknown')

  // ── ④ 改名路径：只改 display_name，stage 不动 ──────────────────────────────
  applyParsedStageSignal('wx_a', '比价客户(改)', '决策')
  const renamed = salesDbService.customerGetBySession('wx_a')
  ok('4a display_name 更新为 (改)', renamed?.display_name === '比价客户(改)')
  ok('4b stage 仍 比价（改名不连带改阶段）', renamed?.stage === '比价')

  // ── ⑤ 负向控制：显式传 stage 才会覆盖（回归护栏）────────────────────────────
  salesDbService.customerUpsert({ session_id: 'wx_a', display_name: '比价客户(改)', stage: '决策' })
  ok('5a customerUpsert 显式传 stage → 确实会覆盖（省略 stage 才是保阶段机制）', salesDbService.customerGetBySession('wx_a')?.stage === '决策')

  console.log(`\ninsight-stage-ban-test: ${pass}/${pass + fail} 通过`)
  process.exit(fail > 0 ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
