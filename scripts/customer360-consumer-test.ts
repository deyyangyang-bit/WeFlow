/**
 * customer360-consumer-test.ts —— P0-3.2 验收：Customer 360 AI 判断卡消费 currentView
 *
 * 验收（用户拍板契约）：
 *   A 静态护栏（360 从「现场生成」改为「消费已形成的视图」）：
 *     1  crmIpcHandlers.ts 不再调 generateActionAnalysis（360 不再现场调 LLM）
 *     2  crmIpcHandlers.ts 不再调 persistActionAnalysisJudgments（360 不再生产者，判断只由预热/扫描链路生产）
 *     3  crmIpcHandlers.ts 改调 getCustomerCurrentView（消费 P0-3 只读组装层）
 *     4  CustomerWorkspacePage.tsx 不再读 customerProfile.advice（UI 不再消费现场建议）
 *     5  CustomerWorkspacePage.tsx 消费 currentView + evidenceGetByKey（判断卡 + 证据点击回查 P0-2B）
 *     6  CustomerWorkspacePage.tsx 不直读 customer_judgment / insight_record / follow_up_task（UI 不自拼数据）
 *   B 行为（temp DB，真实生产函数）：
 *     7  有判断客户 → 投影含 UI 卡消费的全部字段（value/freshness/source/evidenceStatus/messageKey）
 *     8  无判断客户 → 四类全 null（UI 显示空态，不补生成）
 *     9  stale 仍返回（UI 标「较旧」而不消失）
 *
 * 运行：npx tsx scripts/customer360-consumer-test.ts
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { salesDbService } from '../electron/services/salesDbService'
import { getCustomerCurrentView } from '../electron/services/customerCurrentView'

let pass = 0, fail = 0
function ok(name: string, cond: boolean): void {
  if (cond) { pass++ } else { fail++; console.error('FAIL:', name) }
}

const ROOT = join(__dirname, '..')

async function main(): Promise<void> {
  // ── A. 静态护栏 ────────────────────────────────────────────────────────────
  const handlerSrc = readFileSync(join(ROOT, 'electron/services/crmIpcHandlers.ts'), 'utf8')
  const pageSrc = readFileSync(join(ROOT, 'src/pages/CustomerWorkspacePage.tsx'), 'utf8')

  ok('A1 360 handler 不再现场调 generateActionAnalysis', !/generateActionAnalysis/.test(handlerSrc))
  ok('A2 360 handler 不再调 persistActionAnalysisJudgments', !/persistActionAnalysisJudgments/.test(handlerSrc))
  ok('A3 360 handler 消费 getCustomerCurrentView', /getCustomerCurrentView/.test(handlerSrc))
  ok('A4 UI 不再读 customerProfile.advice', !/customerProfile\.advice/.test(pageSrc))
  ok('A5 UI 消费 currentView', /customerProfile\.currentView/.test(pageSrc))
  ok('A5b UI 证据回查走 evidenceGetByKey（P0-2B 统一入口）', /evidenceGetByKey/.test(pageSrc))
  ok('A6 UI 不直读底层真源', !/customer_judgment/.test(pageSrc) && !/insight_record/.test(pageSrc) && !/follow_up_task/.test(pageSrc))

  // ── B. 行为（temp DB）─────────────────────────────────────────────────────
  const dir = mkdtempSync(join(tmpdir(), 'c360-'))
  await salesDbService.initialize(dir)
  const NOW = Date.now()

  // 无判断客户 → 空态数据形状
  salesDbService.customerUpsert({ session_id: 'wx_c360_empty', display_name: '空态客户', stage: 'new', last_contact_at: NOW / 1000 })
  const empty = getCustomerCurrentView('wx_c360_empty', NOW)!
  ok('B1 无判断客户四类全 null（UI 显示空态不补生成）',
    empty.judgments.summary === null && empty.judgments.opportunity === null &&
    empty.judgments.risk === null && empty.judgments.nextAction === null)

  // 有判断客户 → UI 卡消费字段完备
  salesDbService.customerUpsert({ session_id: 'wx_c360_have', display_name: '有判断客户', stage: 'quoted', last_contact_at: NOW / 1000 })
  salesDbService.judgmentCreate({
    session_id: 'wx_c360_have', judgment_type: 'opportunity', value: '追加采购机会', source: 'ai',
    generated_at: NOW - 3600_000, message_key: 'k:opp:1', createdAt: NOW - 3600_000
  })
  salesDbService.judgmentCreate({
    session_id: 'wx_c360_have', judgment_type: 'risk', value: '价格敏感', source: 'ai',
    generated_at: NOW - 3600_000, message_key: 'k:risk:1', createdAt: NOW - 3600_000
  })
  salesDbService.judgmentCreate({
    session_id: 'wx_c360_have', judgment_type: 'next_action', value: '周五发合同', source: 'manual',
    generated_at: NOW - 3600_000, createdAt: NOW - 3600_000
  })
  const have = getCustomerCurrentView('wx_c360_have', NOW)!
  const opp = have.judgments.opportunity as any
  ok('B2 投影含 UI 卡消费字段（value/freshness/source/evidenceStatus/messageKey）',
    opp && typeof opp.value === 'string' && typeof opp.freshness === 'string' &&
    typeof opp.source === 'string' && typeof opp.evidenceStatus === 'string' &&
    (opp.messageKey === null || typeof opp.messageKey === 'string'))
  ok('B3 有 key → evidenceStatus ok（UI 显示「有据可查」）', opp?.evidenceStatus === 'ok' && opp?.messageKey === 'k:opp:1')
  ok('B4 无 key → unavailable + 无按钮（UI 不显示「有据可查」）',
    have.judgments.nextAction?.evidenceStatus === 'unavailable' && have.judgments.nextAction?.messageKey === null)
  ok('B5 source=manual 透传（UI 标「人工」）', have.judgments.nextAction?.source === 'manual')

  // stale 仍返回
  salesDbService.judgmentCreate({
    session_id: 'wx_c360_have', judgment_type: 'summary', value: '旧总结', source: 'ai',
    generated_at: NOW - 48 * 3600_000, createdAt: NOW - 48 * 3600_000
  })
  const stale = getCustomerCurrentView('wx_c360_have', NOW)!
  ok('B6 stale 仍返回（UI 标「较旧」不消失）',
    stale.judgments.summary?.value === '旧总结' && stale.judgments.summary?.freshness === 'stale')

  console.log(`customer360-consumer-test: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main()
