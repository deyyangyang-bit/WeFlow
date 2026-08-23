/**
 * today-action-consumer-test.ts —— P0-3.4 验收：今日行动卡判断展示消费 currentView（analysis JSON 不再冒充）
 *
 * 验收（用户拍板契约）：
 *   判断展示 = currentView.judgments；任务自身字段保留 follow_up_task；insight_record 保留为历史
 *   A 静态护栏：
 *     1  AIActionCard 消费 item.judgments（判断只来自主进程组装的当前视图投影）
 *     2  AIActionCard 不再渲染 analysis JSON 五字段（whyNow/opportunity/riskSignal/nextMove/degradationNote）
 *     3  AIActionCard 不直读 customer_judgment / insight_record / follow_up_task（不自拼判断真源）
 *     4  AIActionCard 证据回查走 evidenceGetByKey（P0-2B 统一入口）
 *     5  todayActionStore 不再 Object.assign analysis JSON（历史快照不进卡片冒充当前判断）
 *     6  store fetchSuggestion 成功后重读 customerCurrentView（生成 → 落库 → 重读 → 显示闭环）
 *     7  getUnifiedSignals 组装 judgments（主进程真源组装，UI 零额外 IPC）
 *     8  InsightInboxPage 保持历史收件箱语义（消费 insight.listRecords，不冒充当前判断）
 *   B 行为（temp DB，真实生产函数）：
 *     9  有判断客户 + pending task → signal.judgments 四字段可读（value/source/freshness）
 *     10 无判断客户 → judgments 四类 null（UI 空态）
 *     11 虚拟卡（todo: 无会话绑定）→ judgments null
 *     12 判断 append 后重跑 → judgments 反映最新（闭环）
 *
 * 运行：npx tsx scripts/today-action-consumer-test.ts
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { salesDbService } from '../electron/services/salesDbService'
import { getUnifiedSignals } from '../electron/services/salesActionEngine'

let pass = 0, fail = 0
function ok(name: string, cond: boolean): void {
  if (cond) { pass++ } else { fail++; console.error('FAIL:', name) }
}

const ROOT = join(__dirname, '..')

async function main(): Promise<void> {
  // ── A. 静态护栏 ────────────────────────────────────────────────────────────
  const cardSrc = readFileSync(join(ROOT, 'src/components/sales/AIActionCard.tsx'), 'utf8')
  const storeSrc = readFileSync(join(ROOT, 'src/stores/todayActionStore.ts'), 'utf8')
  const engineSrc = readFileSync(join(ROOT, 'electron/services/salesActionEngine.ts'), 'utf8')
  const inboxSrc = readFileSync(join(ROOT, 'src/pages/InsightInboxPage.tsx'), 'utf8')
  const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

  ok('A1 AIActionCard 消费 item.judgments（判断只来自当前视图投影）', /item\.judgments/.test(cardSrc) && /judgments\.(summary|opportunity|risk|nextAction)/.test(cardSrc))
  const cardCode = strip(cardSrc)
  ok('A2 AIActionCard 不再渲染 analysis JSON 五字段', !/item\.whyNow/.test(cardCode) && !/item\.opportunity/.test(cardCode) && !/item\.riskSignal/.test(cardCode) && !/item\.nextMove/.test(cardCode) && !/item\.degradationNote/.test(cardCode))
  ok('A3 AIActionCard 不直读判断真源', !/customer_judgment/.test(cardCode) && !/insight_record/.test(cardCode) && !/follow_up_task/.test(cardCode))
  ok('A4 AIActionCard 证据回查走 evidenceGetByKey', /evidenceGetByKey/.test(cardSrc))
  const storeCode = strip(storeSrc)
  ok('A5 todayActionStore 不再 Object.assign analysis JSON（历史快照不进卡）', !/JSON\.parse\(\s*sig\.analysis/.test(storeCode) && !/Object\.assign\(\s*base,\s*parsed/.test(storeCode))
  const suggestAt = storeSrc.indexOf('actionSuggest')
  const refreshAt = storeSrc.indexOf('customerCurrentView', suggestAt)
  ok('A6 fetchSuggestion 成功后重读 customerCurrentView（生成后立即刷新闭环）', suggestAt > 0 && refreshAt > suggestAt)
  ok('A7 getUnifiedSignals 组装 judgments（主进程真源组装）', /getCustomerCurrentView\(/.test(engineSrc))
  ok('A8 InsightInboxPage 历史收件箱语义（消费 insight.listRecords，不冒充当前判断）',
    /insight\.listRecords/.test(inboxSrc) && !/customerCurrentView/.test(inboxSrc) && !/customer_judgment/.test(strip(inboxSrc)))

  // ── B. 行为（temp DB）─────────────────────────────────────────────────────
  const dir = mkdtempSync(join(tmpdir(), 'tac-'))
  await salesDbService.initialize(dir)
  const NOW = Date.now()

  // B1/B4: 有判断客户 + 绑定真实会话的 manual 任务
  salesDbService.customerUpsert({ session_id: 'wx_tac_have', display_name: '有判断客户', stage: 'quoted', last_contact_at: (NOW - 2 * 86400_000) / 1000 })
  salesDbService.judgmentCreate({
    session_id: 'wx_tac_have', judgment_type: 'opportunity', value: '有追加采购机会', source: 'ai',
    generated_at: NOW - 3600_000, message_key: 'k:tac:opp:1', createdAt: NOW - 3600_000
  })
  salesDbService.judgmentCreate({
    session_id: 'wx_tac_have', judgment_type: 'risk', value: '可能转向竞品', source: 'ai',
    generated_at: NOW - 3600_000, message_key: 'k:tac:risk:1', createdAt: NOW - 3600_000
  })
  salesDbService.todoCreate({
    session_id: 'wx_tac_have', display_name: '有判断客户', trigger_type: 'manual',
    title: '跟进有判断客户', status: 'pending', priority_score: 40, created_by: 'manual'
  })

  // B2: 无判断客户
  salesDbService.customerUpsert({ session_id: 'wx_tac_empty', display_name: '无判断客户', stage: 'new', last_contact_at: (NOW - 2 * 86400_000) / 1000 })
  salesDbService.todoCreate({
    session_id: 'wx_tac_empty', display_name: '无判断客户', trigger_type: 'manual',
    title: '跟进无判断客户', status: 'pending', priority_score: 40, created_by: 'manual'
  })

  // B3: 虚拟卡（无会话绑定）
  salesDbService.todoCreate({
    session_id: null, display_name: '个人待办', trigger_type: 'manual',
    title: '整理下周报价单', status: 'pending', priority_score: 40, created_by: 'manual'
  })

  const result = await getUnifiedSignals()
  const sigHave = result.signals.find(s => s.sessionId === 'wx_tac_have')
  const sigEmpty = result.signals.find(s => s.sessionId === 'wx_tac_empty')
  const sigTodo = result.signals.find(s => String(s.sessionId).startsWith('todo:'))

  ok('B1a 有判断客户 signal.judgments 组装（opportunity/risk 可读）',
    !!sigHave?.judgments && sigHave.judgments.opportunity?.value === '有追加采购机会' &&
    sigHave.judgments.risk?.value === '可能转向竞品')
  ok('B1b judgments 视图字段完备（source/freshness/messageKey）',
    sigHave?.judgments?.opportunity?.source === 'ai' && sigHave.judgments.opportunity?.freshness === 'fresh' &&
    sigHave.judgments.opportunity?.messageKey === 'k:tac:opp:1')
  ok('B1c 任务自身字段保留（sources 仍来自 follow_up_task）',
    sigHave?.sources.some(s => s.type === 'task' && s.reason === '跟进有判断客户'))
  ok('B2 无判断客户 judgments 四类全 null（UI 空态）',
    sigEmpty?.judgments && sigEmpty.judgments.summary === null && sigEmpty.judgments.opportunity === null &&
    sigEmpty.judgments.risk === null && sigEmpty.judgments.nextAction === null)
  ok('B3 虚拟卡（todo: 无会话绑定）judgments null',
    !!sigTodo && sigTodo.judgments === null)

  // B4: 判断 append 后重跑 → judgments 反映最新（生成 → 落库 → 重读闭环）
  salesDbService.judgmentCreate({
    session_id: 'wx_tac_have', judgment_type: 'opportunity', value: '机会已更新', source: 'manual',
    generated_at: NOW + 1000, message_key: 'k:tac:opp:2', createdAt: NOW + 1000
  })
  const again = await getUnifiedSignals()
  const sigHave2 = again.signals.find(s => s.sessionId === 'wx_tac_have')
  ok('B4 判断 append 后重跑 → judgments 反映最新（闭环）',
    sigHave2?.judgments?.opportunity?.value === '机会已更新' && sigHave2.judgments.opportunity?.source === 'manual')

  console.log(`today-action-consumer-test: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main()
