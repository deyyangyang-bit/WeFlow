/**
 * summary-judgment-test.ts —— P0-2C.2 验收：summary 判断落 customer_judgment
 *
 * 验收（用户拍板的 6 项）：
 *   ① 正常生成 → customer_judgment(summary) 落库（value/model/generated_at/source）
 *   ② messageKey 正确保存（P0-2B 可回查原话）
 *   ③ evidenceText 是客户/消息依据，不是 AI summary 本身（含调用点 extractEvidence 链路验证）
 *   ④ 无可靠 messageKey → 允许落库但证据 unavailable，绝不伪造
 *   ⑤ 同一判断重复触发 → 持久化去重（append-only；手动保留覆盖权利）
 *   ⑥ 原现场生成路径行为不变（不碰 insight_record / 不抛错 / 返回结果契约稳定）
 *
 * 运行：npx tsx scripts/summary-judgment-test.ts
 */
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { salesDbService } from '../electron/services/salesDbService'
import { persistSummaryJudgment, SUMMARY_JUDGMENT_DEDUP_MS } from '../electron/services/salesSummaryJudgment'
import { extractEvidence, toMessageSnippets } from '../electron/services/salesStageClassifier'
import { judgmentEvidenceStatus } from '../shared/customerJudgment'

let pass = 0, fail = 0
function ok(name: string, cond: boolean): void {
  if (cond) { pass++ } else { fail++; console.error('FAIL:', name) }
}

const EVIDENCE_KEY = 'local:msg_0.db:101:1700000000:0:wxid_a:1'
const INSIGHT = '客户近期关注报价，需求明确'
const CUSTOMER_QUOTE = '你们叉车多少钱一台'

async function runScenario(): Promise<void> {
  // ── ① 正常生成 → summary 判断落库 ────────────────────────────────────────
  const r1 = persistSummaryJudgment({
    sessionId: 'wx_s1',
    insight: INSIGHT,
    model: 'deepseek-chat',
    generatedAt: 1700000000,
    triggerReason: 'activity',
    evidence: { messageKey: EVIDENCE_KEY, evidenceText: CUSTOMER_QUOTE }
  })
  ok('①a persisted=true', r1.persisted)
  ok('①b 返回 recordId', typeof r1.recordId === 'number' && (r1.recordId ?? 0) > 0)
  const cur1 = salesDbService.judgmentCurrent('wx_s1', 'summary')
  ok('①c value=最终见解（无【阶段】标签正文）', cur1?.value === INSIGHT)
  ok('①d 类型=summary', cur1?.judgment_type === 'summary')
  ok('①e model 记录（PRD§23 可追溯）', cur1?.model === 'deepseek-chat')
  ok('①f generated_at 记录（名义生成时间）', cur1?.generated_at === 1700000000)
  ok('①g source=ai（非手动自动触发）', cur1?.source === 'ai')

  // ── ② messageKey 正确保存 ────────────────────────────────────────────────
  ok('②a message_key 原样落库', cur1?.message_key === EVIDENCE_KEY)
  ok('②b 证据状态派生 ok（可 P0-2B 回查）', judgmentEvidenceStatus(cur1 as any) === 'ok')

  // ── ③ evidenceText 是客户依据，不是 AI summary 本身 ─────────────────────
  ok('③a evidence_text=客户原话', cur1?.evidence_text === CUSTOMER_QUOTE)
  ok('③b evidence_text ≠ AI summary 本身', cur1?.evidence_text !== cur1?.value)
  // ③c-e：调用点链路 extractEvidence(toMessageSnippets(messages)) 取客户最近一条实质消息
  const fakeMsgs = [
    { isSend: 1, parsedContent: '我这边报价 X 元，可优惠', createTime: 1700000001, messageKey: 'local:m:1' },
    { isSend: 0, parsedContent: '价格还可以，我再考虑下', createTime: 1700000002, messageKey: 'local:m:2' },
    { isSend: 0, parsedContent: CUSTOMER_QUOTE, createTime: 1700000003, messageKey: 'local:m:3' }
  ]
  const ev = extractEvidence(toMessageSnippets(fakeMsgs))
  ok('③c 取客户最新消息（排除我方报价）', ev.messageKey === 'local:m:3')
  ok('③d evidenceText=客户最新原话', ev.evidenceText === CUSTOMER_QUOTE)
  ok('③e 非 AI 结论（不混入 my 侧文本）', !ev.evidenceText?.includes('我这边报价'))
  // ③f：消息来源=chatService.Message 形状（无 messageKey 字段 → undefined，不崩）
  const fakeNoKey = [{ isSend: 0, parsedContent: '尽快报价吧', createTime: 1700000004 }]
  ok('③f 无 messageKey 的消息 → evidence 无 key（诚实）', extractEvidence(toMessageSnippets(fakeNoKey)).messageKey === undefined)

  // ── ④ 无可靠 key → 允许落库但证据 unavailable，不伪造 ──────────────────
  const r4 = persistSummaryJudgment({
    sessionId: 'wx_s2',
    insight: '无法回查原话的判断',
    triggerReason: 'silence',
    evidence: {}
  })
  ok('④a 无 key 仍允许落库', r4.persisted)
  const cur4 = salesDbService.judgmentCurrent('wx_s2', 'summary')
  ok('④b message_key 留空（null 而非伪造）', cur4?.message_key === null)
  ok('④c evidence_text 留空', cur4?.evidence_text === null)
  ok('④d 证据状态派生 unavailable（绝不伪造）', judgmentEvidenceStatus(cur4 as any) === 'unavailable')
  // ④e：空白串 messageKey 同样视为不可靠
  const r4b = persistSummaryJudgment({
    sessionId: 'wx_s2b', insight: '空白 key', triggerReason: 'activity',
    evidence: { messageKey: '   ', evidenceText: '   ' }
  })
  const cur4b = salesDbService.judgmentCurrent('wx_s2b', 'summary')
  ok('④e 空白 messageKey → 不落库（unavailable）', r4b.persisted && cur4b?.message_key === null && cur4b?.evidence_text === null)

  // ── ⑤ 同一判断重复触发 → 持久化去重（append-only）──────────────────────
  const d1 = persistSummaryJudgment({ sessionId: 'wx_s3', insight: 'A', triggerReason: 'activity' })
  const d2 = persistSummaryJudgment({ sessionId: 'wx_s3', insight: 'B', triggerReason: 'activity' })
  ok('⑤a 第一次 persisted', d1.persisted)
  ok('⑤b 第二次 dedup（窗口内已有 summary）', !d2.persisted && d2.reason === 'dedup')
  ok('⑤c 窗口内只落一条', salesDbService.judgmentHistory('wx_s3', 'summary').length === 1)
  // ⑤d：窗口外（旧记录）再触发 → 新判断落库（append-only 历史保留）
  salesDbService.judgmentCreate({ session_id: 'wx_s4', judgment_type: 'summary', value: '旧', source: 'ai', createdAt: 1700000000 })
  const d3 = persistSummaryJudgment({ sessionId: 'wx_s4', insight: '新', triggerReason: 'activity' })
  ok('⑤d 窗口外再触发 → 落库', d3.persisted)
  const hist4 = salesDbService.judgmentHistory('wx_s4', 'summary')
  ok('⑤e 历史两条且最新在前（append-only 不 UPDATE）', hist4.length === 2 && hist4[0]?.value === '新' && hist4[1]?.value === '旧')
  // ⑤f：手动触发 → 跳过窗口去重（覆盖权利）
  const m1 = persistSummaryJudgment({ sessionId: 'wx_s5', insight: '手动1', triggerReason: 'manual' })
  const m2 = persistSummaryJudgment({ sessionId: 'wx_s5', insight: '手动2', triggerReason: 'manual' })
  ok('⑤f 手动连续触发两次都 persisted', m1.persisted && m2.persisted)
  ok('⑤g 手动历史两条（append-only）', salesDbService.judgmentHistory('wx_s5', 'summary').length === 2)
  const cur5 = salesDbService.judgmentCurrent('wx_s5', 'summary')
  ok('⑤h 手动 source=manual（可区分）', cur5?.source === 'manual')
  ok('⑤i 去重窗口常量=24h（沿用现有业务语义）', SUMMARY_JUDGMENT_DEDUP_MS === 24 * 3600 * 1000)

  // ── ⑥ 原现场生成路径行为不变 ───────────────────────────────────────────
  // ⑥a：无效输入不抛错，返回契约结果（调用方 try/catch 兜底 + 模块自兜底）
  let threw6 = false
  let r6: ReturnType<typeof persistSummaryJudgment>
  try {
    r6 = persistSummaryJudgment({ sessionId: '', insight: '', triggerReason: 'activity' })
  } catch { threw6 = true }
  ok('⑥a 无效输入不抛错且返回 invalid_input', !threw6 && !!r6 && !r6.persisted && r6.reason === 'invalid_input')
  // ⑥b：判断写路径不碰 insight_record（JSON 存储，未在本 DB 建表）——容器分离
  const hasInsightTable = (salesDbService as any).all("SELECT name FROM sqlite_master WHERE type='table' AND name='insight_record'") as Array<{ name: string }>
  ok('⑥b persistSummaryJudgment 不建/不写 insight_record 表', hasInsightTable.length === 0)
  // ⑥c：persist 不污染其他判断类型（只写 summary）
  ok('⑥c 只写 summary（无 opportunity/risk/next_action）', salesDbService.judgmentHistory('wx_s1').every((r) => r.judgment_type === 'summary'))
  // ⑥d：重复调用幂等（同输入再次手动触发 → 追加而非覆盖，projection 仍取最新落库）
  const m3 = persistSummaryJudgment({ sessionId: 'wx_s5', insight: '手动1', triggerReason: 'manual', generatedAt: 1700000000 })
  const cur6d = salesDbService.judgmentCurrent('wx_s5', 'summary')
  ok('⑥d 手动重复 → 追加（append-only 不 UPDATE），最新可见', m3.persisted && cur6d?.value === '手动1' && salesDbService.judgmentHistory('wx_s5', 'summary').length === 3)
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'sumj-'))
  await salesDbService.initialize(dir)
  await runScenario()
  console.log(`summary-judgment-test: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main()
