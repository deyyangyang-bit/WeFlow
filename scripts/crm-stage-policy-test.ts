/**
 * crm-stage-policy-test.ts —— H6 回归测试：客户阶段口径统一 + 终态保护 + 人工纠正同步
 *
 * 修复前：insightService 将「比价」错误映射为 negotiating（正确 canonical 是 quoted）；
 *   importCustomerFromProfile 对已有 account 无条件覆写 sales_stage（won/lost 终态可被回退）；
 *   applyManualStageCorrection 只写 salesDb，不同步 account.sales_stage 与商机。
 * 验证：
 *   ① normalizeStage 唯一语义源：比价→quoted（insightService/crmImportService 不再有本地映射）；
 *   ② nextAutoStage 策略：won/lost 终态保护、negotiating 不被 contacted 回退、同阶段幂等；
 *   ③ importCustomerFromProfile 行为：单调前进、终态不被覆盖、重复导入幂等（updated_at 不刷新）；
 *   ④ 人工纠正：salesDb + account.sales_stage + active 商机三处同步；account 未建档不失败。
 * 运行：npx tsx scripts/crm-stage-policy-test.ts
 */
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { normalizeStage, CANONICAL_TO_CN } from '../shared/salesStage'
import { nextAutoStage } from '../electron/services/salesStagePolicy'
import { crmDbService } from '../electron/services/crmDbService'
import { salesDbService } from '../electron/services/salesDbService'
import { applyManualStageCorrection } from '../electron/services/legalStageWriters'

let pass = 0, fail = 0
function ok(name: string, cond: boolean): void {
  if (cond) { pass++ } else { fail++; console.error('FAIL:', name) }
}

const now = Date.now()

async function main(): Promise<void> {
  // ── ① 唯一语义源：删除重复映射后的静态断言（源码不含本地 STAGE_TO_CRM/BACKFILL 映射）──
  const insightSrc = readFileSync(join(__dirname, '../electron/services/insightService.ts'), 'utf8')
  const importSrc = readFileSync(join(__dirname, '../electron/services/crmImportService.ts'), 'utf8')
  ok('1a insightService 不再有本地 STAGE_TO_CRM 映射（按代码形状而非注释）',
    !/const STAGE_TO_CRM|STAGE_TO_CRM\[/.test(insightSrc))
  ok('1b crmImportService 不再有本地 BACKFILL_STAGE_TO_CRM 映射（按代码形状而非注释）',
    !/const BACKFILL_STAGE_TO_CRM|BACKFILL_STAGE_TO_CRM\[/.test(importSrc))
  ok('1c 比价 → quoted（normalizeStage 唯一语义源）', normalizeStage('比价') === 'quoted')
  ok('1d 决策 → negotiating', normalizeStage('决策') === 'negotiating')
  ok('1e 了解 → contacted', normalizeStage('了解') === 'contacted')

  // ── ② nextAutoStage 策略 ──
  ok('2a won 不被 contacted 覆盖', nextAutoStage('won', 'contacted').changed === false && nextAutoStage('won', 'contacted').stage === 'won')
  ok('2b won 不被 quoted 覆盖', nextAutoStage('won', 'quoted').changed === false)
  ok('2c lost 不被 negotiating 覆盖', nextAutoStage('lost', 'negotiating').changed === false)
  ok('2d negotiating 不被 contacted 回退', nextAutoStage('negotiating', 'contacted').changed === false && nextAutoStage('negotiating', 'contacted').stage === 'negotiating')
  ok('2e quoted 不被 contacted 回退', nextAutoStage('quoted', 'contacted').changed === false)
  ok('2f contacted → quoted 单调前进', nextAutoStage('contacted', '比价').changed === true && nextAutoStage('contacted', '比价').stage === 'quoted')
  ok('2g quoted → negotiating 前进', nextAutoStage('quoted', 'negotiating').changed === true)
  ok('2h 同阶段幂等（contacted→了解）', nextAutoStage('contacted', '了解').changed === false)
  ok('2i 非终态可落终态（成交信号）', nextAutoStage('quoted', 'won').changed === true && nextAutoStage('quoted', 'won').stage === 'won')

  // ── ③ importCustomerFromProfile 行为（真实库）──
  const dir = mkdtempSync(join(tmpdir(), 'crm-stage-'))
  await crmDbService.initialize(dir)
  await salesDbService.initialize(dir)

  // 已有 won 客户：导入不得回退
  const wonAcc = Number(crmDbService.create('account', { name: '王成交', session_id: 'sess_won', sales_stage: 'won', created_at: now, updated_at: now }))
  const r1 = crmDbService.importCustomerFromProfile({ name: '王成交', sessionId: 'sess_won', stage: 'contacted', reason: '测试' })
  ok('3a won 客户不被 contacted 导入回退',
    crmDbService.getById('account', wonAcc)?.sales_stage === 'won' && r1.created === false)
  const r1b = crmDbService.importCustomerFromProfile({ name: '王成交', sessionId: 'sess_won', stage: 'quoted', reason: '测试' })
  ok('3b won 客户不被 quoted 导入回退', crmDbService.getById('account', wonAcc)?.sales_stage === 'won' && r1b.created === false)

  // quoted 客户：contacted 不回退；比价→quoted 前进
  const qAcc = Number(crmDbService.create('account', { name: '钱比价', session_id: 'sess_q', sales_stage: 'quoted', created_at: now, updated_at: now }))
  crmDbService.importCustomerFromProfile({ name: '钱比价', sessionId: 'sess_q', stage: 'contacted', reason: '测试' })
  ok('3c quoted 不被 contacted 回退', crmDbService.getById('account', qAcc)?.sales_stage === 'quoted')

  // 比价导入 → quoted（修复前会写 negotiating）
  const newAcc = Number(crmDbService.create('account', { name: '李新客', session_id: 'sess_n', sales_stage: 'contacted', created_at: now, updated_at: now }))
  crmDbService.importCustomerFromProfile({ name: '李新客', sessionId: 'sess_n', stage: '比价', reason: '测试' })
  ok('3d 比价导入 → quoted（修复前 negotiating）', crmDbService.getById('account', newAcc)?.sales_stage === 'quoted')

  // 幂等：重复写相同阶段不刷新行
  const beforeUpdatedAt = crmDbService.getById('account', newAcc)?.updated_at
  await new Promise((r) => setTimeout(r, 5))
  const r2 = crmDbService.importCustomerFromProfile({ name: '李新客', sessionId: 'sess_n', stage: 'quoted', reason: '测试' })
  ok('3e 重复导入同阶段幂等（行不刷新）',
    crmDbService.getById('account', newAcc)?.updated_at === beforeUpdatedAt && r2.created === false)

  // 新建路径：中文档位归一成 canonical
  const r3 = crmDbService.importCustomerFromProfile({ name: '赵决策', sessionId: 'sess_z', stage: '决策', reason: '测试' })
  ok('3f 新建账户阶段归一为 canonical', r3.created === true
    && crmDbService.getById('account', Number(r3.id))?.sales_stage === 'negotiating')

  // ── ④ applyManualStageCorrection 三处同步 ──
  // account + active 商机（stage=了解）+ salesDb customer_profile
  const mAcc = Number(crmDbService.create('account', { name: '孙纠正', session_id: 'sess_m', sales_stage: 'contacted', created_at: now, updated_at: now }))
  const mOpp = Number(crmDbService.create('opportunity', { account_id: mAcc, name: '孙商机', stage: '了解', status: 'active', created_at: now, updated_at: now }))
  salesDbService.customerUpsert({ session_id: 'sess_m', display_name: '孙纠正', stage: 'contacted' })

  const corr = applyManualStageCorrection('sess_m', '比价', '人工纠正测试')
  ok('4a 人工纠正成功', corr.success === true)
  ok('4b salesDb stage 更新为 quoted', normalizeStage(salesDbService.customerGetBySession('sess_m')?.stage) === 'quoted')
  ok('4c account.sales_stage 同步为 quoted', crmDbService.getById('account', mAcc)?.sales_stage === 'quoted')
  ok('4d active 商机同步推进到「比价」',
    crmDbService.getById('opportunity', mOpp)?.stage === '比价' && corr.sync?.opportunitiesChanged === 1)
  ok('4e sync 携带 accountId', corr.sync?.accountUpdated === true && corr.sync?.accountId === mAcc)

  // 人工纠正到 won（终态走显式人工路径）
  const corrWon = applyManualStageCorrection('sess_m', 'won')
  ok('4f 人工纠正可落 won（显式人工路径）', corrWon.success === true
    && crmDbService.getById('account', mAcc)?.sales_stage === 'won'
    && normalizeStage(salesDbService.customerGetBySession('sess_m')?.stage) === 'won')

  // 重复纠正相同阶段幂等
  const tagCountBefore = salesDbService.all("SELECT COUNT(*) AS n FROM intent_tag_log WHERE session_id = 'sess_m'")[0]?.n
  applyManualStageCorrection('sess_m', 'won')
  const tagCountAfter = salesDbService.all("SELECT COUNT(*) AS n FROM intent_tag_log WHERE session_id = 'sess_m'")[0]?.n
  ok('4g 重复纠正仍写判断记录（append-only 历史保留）', Number(tagCountAfter) === Number(tagCountBefore) + 1)

  // account 未建档：salesDb 操作成功，返回清晰同步结果
  salesDbService.customerUpsert({ session_id: 'sess_no_acc', display_name: '无档客户', stage: 'contacted' })
  const corrNoAcc = applyManualStageCorrection('sess_no_acc', 'quoted')
  ok('4h account 未建档不失败', corrNoAcc.success === true)
  ok('4i 未建档返回清晰同步说明', corrNoAcc.sync?.accountUpdated === false && Boolean(corrNoAcc.sync?.note))

  // ── ⑤ P2：阶段被拦截后不得触发商机副作用（裁决驱动联动）────────────────────
  // lost + 成交信号：account 保持 lost，商机不生成 deal_pending
  const lostAcc = Number(crmDbService.create('account', { name: '周流失', session_id: 'sess_lost', sales_stage: 'lost', created_at: now, updated_at: now }))
  const lostOpp = Number(crmDbService.create('opportunity', { account_id: lostAcc, name: '周商机', stage: '决策', status: 'active', created_at: now, updated_at: now }))
  const rLost = crmDbService.importCustomerFromProfile({ name: '周流失', sessionId: 'sess_lost', stage: 'won', reason: '成交判定' })
  ok('5a lost + won：terminal-kept 拦截且阶段未变',
    rLost.effectiveStage === 'lost' && rLost.stageChanged === false && rLost.stageDecisionReason === 'terminal-kept')
  ok('5b lost + won：商机无 deal_pending 且回写零副作用',
    crmDbService.getById('account', lostAcc)?.sales_stage === 'lost'
      && crmDbService.all("SELECT id FROM opportunity_event WHERE opportunity_id = ? AND event_type = 'deal_pending'", [lostOpp]).length === 0
      && crmDbService.getById('opportunity', lostOpp)?.stage === '决策')

  // won + contacted：无回退、无新商机事件
  const wonAcc2 = Number(crmDbService.create('account', { name: '吴已成', session_id: 'sess_won2', sales_stage: 'won', created_at: now, updated_at: now }))
  const wonOpp2 = Number(crmDbService.create('opportunity', { account_id: wonAcc2, name: '吴商机', stage: '成交', status: 'active', created_at: now, updated_at: now }))
  const beforeWonEvents = crmDbService.all('SELECT id FROM opportunity_event WHERE opportunity_id = ?', [wonOpp2]).length
  const rWon = crmDbService.importCustomerFromProfile({ name: '吴已成', sessionId: 'sess_won2', stage: 'contacted', reason: 'contacted 判定' })
  ok('5c won + contacted：terminal-kept，商机事件零新增',
    rWon.stageChanged === false && rWon.effectiveStage === 'won'
      && crmDbService.all('SELECT id FROM opportunity_event WHERE opportunity_id = ?', [wonOpp2]).length === beforeWonEvents)

  // negotiating + contacted：regression-blocked，无联动
  const negAcc = Number(crmDbService.create('account', { name: '郑谈判', session_id: 'sess_neg', sales_stage: 'negotiating', created_at: now, updated_at: now }))
  const negOpp = Number(crmDbService.create('opportunity', { account_id: negAcc, name: '郑商机', stage: '决策', status: 'active', created_at: now, updated_at: now }))
  const rNeg = crmDbService.importCustomerFromProfile({ name: '郑谈判', sessionId: 'sess_neg', stage: 'contacted', reason: 'contacted 判定' })
  ok('5d negotiating + contacted：regression-blocked，商机保持决策',
    rNeg.stageChanged === false && rNeg.stageDecisionReason === 'regression-blocked'
      && crmDbService.getById('opportunity', negOpp)?.stage === '决策')

  // contacted + 比价：account→quoted，商机→比价（真实推进才联动）
  const advAcc = Number(crmDbService.create('account', { name: '王推进', session_id: 'sess_adv', sales_stage: 'contacted', created_at: now, updated_at: now }))
  const advOpp = Number(crmDbService.create('opportunity', { account_id: advAcc, name: '王商机', stage: '了解', status: 'active', created_at: now, updated_at: now }))
  const rAdv = crmDbService.importCustomerFromProfile({ name: '王推进', sessionId: 'sess_adv', stage: '比价', reason: '比价判定' })
  ok('5e contacted + 比价：advanced 且 account→quoted',
    rAdv.stageChanged === true && rAdv.stageDecisionReason === 'advanced' && rAdv.effectiveStage === 'quoted'
      && crmDbService.getById('account', advAcc)?.sales_stage === 'quoted')
  // 5f 复刻 insightService.importIntentCustomerToCrm 的消费方式：stageChanged 时用
  // effectiveStage（canonical → 中文档位）驱动 syncOpportunityStageByAccount——验证裁决数据
  // 足以正确联动（而非原始 AI 字符串「比价」直接透传）。
  const cnOf = (canonical: string): string => CANONICAL_TO_CN[canonical as keyof typeof CANONICAL_TO_CN] || canonical
  const synced = crmDbService.syncOpportunityStageByAccount(advAcc, cnOf(String(rAdv.effectiveStage)))
  ok('5f 联动用 effectiveStage：商机推进到「比价」',
    synced === 1 && crmDbService.getById('opportunity', advOpp)?.stage === '比价')

  // 同阶段重复导入：same，零副作用（行不刷新 + 无商机事件）
  const beforeAdvEvents = crmDbService.all('SELECT id FROM opportunity_event WHERE opportunity_id = ?', [advOpp]).length
  const beforeAdvUpdatedAt = crmDbService.getById('account', advAcc)?.updated_at
  await new Promise((r) => setTimeout(r, 5))
  const rSame = crmDbService.importCustomerFromProfile({ name: '王推进', sessionId: 'sess_adv', stage: 'quoted', reason: '重复判定' })
  ok('5g 同阶段重复导入：same，行不刷新 + 商机事件零新增',
    rSame.stageChanged === false && rSame.stageDecisionReason === 'same'
      && crmDbService.getById('account', advAcc)?.updated_at === beforeAdvUpdatedAt
      && crmDbService.all('SELECT id FROM opportunity_event WHERE opportunity_id = ?', [advOpp]).length === beforeAdvEvents)

  crmDbService.persistNow()
  rmSync(dir, { recursive: true, force: true })
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
