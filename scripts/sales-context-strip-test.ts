/**
 * sales-context-strip-test.ts —— P0-3.3 验收：SalesContextStrip 被动消费 currentView + suggest 主动生成保留
 *
 * 验收（用户拍板契约）：
 *   A 静态护栏（被动展示层）：
 *     1  SalesContextStrip.tsx 消费 customerCurrentView（判断只来自 currentView）
 *     2  actionSuggest 保留（用户主动生成能力未删）
 *     3  UI 不直读 customer_judgment / insight_record / follow_up_task（不自拼判断真源）
 *     4  suggest item 带 sessionId（P0-3.3 修复：缺失会导致落库 invalid_input 跳过）
 *     5  生成后刷新闭环：actionSuggest 成功后重读 customerCurrentView（源码顺序断言）
 *   B 行为（temp DB，真实生产函数）：
 *     6  suggest 落库 → 立即 currentView 可见（生成 → append → 重读 → 显示闭环）
 *     7  无 sessionId → invalid_input 跳过（断链复现）
 *     8  suggest=manual 通道不跳过去重（重复主动生成保留覆盖权利）
 *
 * 运行：npx tsx scripts/sales-context-strip-test.ts
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { salesDbService } from '../electron/services/salesDbService'
import { getCustomerCurrentView } from '../electron/services/customerCurrentView'
import { persistActionAnalysisJudgments } from '../electron/services/salesActionAnalysisJudgment'

let pass = 0, fail = 0
function ok(name: string, cond: boolean): void {
  if (cond) { pass++ } else { fail++; console.error('FAIL:', name) }
}

const ROOT = join(__dirname, '..')

async function main(): Promise<void> {
  // ── A. 静态护栏 ────────────────────────────────────────────────────────────
  const src = readFileSync(join(ROOT, 'src/components/sales/SalesContextStrip.tsx'), 'utf8')

  ok('A1 被动消费 customerCurrentView', /customerCurrentView/.test(src))
  ok('A2 actionSuggest 主动生成保留', /actionSuggest/.test(src))
  // 去注释后扫描（注释可解释链路，代码不得直读真源）
  const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  ok('A3 UI 不直读判断真源', !/customer_judgment/.test(codeOnly) && !/insight_record/.test(codeOnly) && !/follow_up_task/.test(codeOnly))
  ok('A4 suggest item 带 sessionId（落库断链已修复）', /actionSuggest\(\{\s*sessionId,/.test(src) || /sessionId,\s*\/\/ P0-3\.3/.test(src))
  // A5 生成后刷新闭环：actionSuggest 之后的代码里重读 customerCurrentView
  const suggestAt = src.indexOf('actionSuggest')
  const refreshAt = src.indexOf('customerCurrentView', suggestAt)
  ok('A5 suggest 成功后重读 currentView（生成后立即刷新）', suggestAt > 0 && refreshAt > suggestAt)

  // ── B. 行为（temp DB）─────────────────────────────────────────────────────
  const dir = mkdtempSync(join(tmpdir(), 'scs-'))
  await salesDbService.initialize(dir)
  const NOW = Date.now()
  salesDbService.customerUpsert({ session_id: 'wx_scs', display_name: '跟进客户', stage: 'quoted', last_contact_at: NOW / 1000 })

  // B1: suggest 落库（channel=suggest/manual）→ 立即 currentView 可见
  const analysis = {
    whyNow: '客户在比价',
    opportunity: '有追加采购机会',
    riskSignal: '可能转向竞品',
    script: '话术',
    nextMove: '周五跟进合同'
  }
  const r1 = await persistActionAnalysisJudgments({ item: { sessionId: 'wx_scs', id: 0, triggerType: 'customer_profile' }, analysis, channel: 'suggest' })
  ok('B1a suggest 落库 3 条', r1.persisted === 3)
  const v1 = getCustomerCurrentView('wx_scs', NOW + 1000)!
  ok('B1b 生成后立即可见（append → 重读闭环）',
    v1.judgments.opportunity?.value === '有追加采购机会' && v1.judgments.risk?.value === '可能转向竞品' &&
    v1.judgments.nextAction?.value === '周五跟进合同')
  ok('B1c 新判断 fresh', v1.judgments.opportunity?.freshness === 'fresh')

  // B2: 无 sessionId → invalid_input 跳过（断链复现）
  const r2 = await persistActionAnalysisJudgments({ item: {}, analysis, channel: 'suggest' })
  ok('B2 无 sessionId → invalid_input 不落库', r2.persisted === 0 && r2.reason === 'invalid_input')

  // B3: suggest=manual 通道跳过去重（重复主动生成保留覆盖权利）
  const analysis2 = { ...analysis, opportunity: '机会已更新' }
  const r3 = await persistActionAnalysisJudgments({ item: { sessionId: 'wx_scs', id: 0, triggerType: 'customer_profile' }, analysis: analysis2, channel: 'suggest' })
  const v3 = getCustomerCurrentView('wx_scs', NOW + 2000)!
  ok('B3 suggest 重复生成不跳过去重（覆盖权利）', r3.persisted === 3 && v3.judgments.opportunity?.value === '机会已更新')

  console.log(`sales-context-strip-test: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main()
