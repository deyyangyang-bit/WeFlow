/**
 * action-analysis-judgment-test.ts —— P0-2C.3 验收：action analysis 三调用点统一落 judgment
 *
 * 验收（盘点刀3 契约 + C.2 先例，6 项）：
 *   ① 三类型映射落库（opportunity/riskSignal/nextMove → opportunity/risk/next_action）
 *   ② 证据：关联任务 source_message_id（P0-1 锚点）默认解析器直接回查
 *   ③ 证据兜底：最近消息 key 链路（injected resolver），evidenceText=客户原话非 AI 结论
 *   ④ 无可靠证据 → 允许落库但 unavailable，绝不伪造
 *   ⑤ 去重：非手动（预热/360）沿用 24h 窗口按类型去重；suggest=手动跳过去重；
 *      窗口外重触发 → 追加；append-only 历史保留
 *   ⑥ 现场路径不变：invalid_input 不抛错 / 空字段不落 / 证据解析失败不阻断 /
 *      basis 记录输入快照 / 不碰 follow_up_task（三层分离）
 *
 * 运行：npx tsx scripts/action-analysis-judgment-test.ts
 */
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { salesDbService } from '../electron/services/salesDbService'
import {
  persistActionAnalysisJudgments,
  ACTION_JUDGMENT_DEDUP_MS
} from '../electron/services/salesActionAnalysisJudgment'
import { judgmentEvidenceStatus } from '../shared/customerJudgment'

let pass = 0, fail = 0
function ok(name: string, cond: boolean): void {
  if (cond) { pass++ } else { fail++; console.error('FAIL:', name) }
}

const ANALYSIS = {
  whyNow: '客户近期询价频繁',
  opportunity: '成交可能性高，预算充足',
  riskSignal: '客户在对比多家报价，价格敏感',
  script: '王总，这款叉车今天有活动价',
  nextMove: '明早 10 点电话跟进报价细节'
}
const QUOTE = '你们价格还能再低点吗'
const EV_KEY = 'local:msg.db:101:1700000000:0:wxid_a:1'

type Item = { id?: number; sessionId?: string; triggerType?: string }
function persist(item: Item, analysis: any, channel: any, extra: any = {}): Promise<any> {
  return persistActionAnalysisJudgments({ item, analysis, channel, model: 'test-model', ...extra })
}

async function runScenario(): Promise<void> {
  // ── ① 三类型映射落库 ─────────────────────────────────────────────────────
  const r1 = await persist(
    { id: 0, sessionId: 'wx_c1', triggerType: 'customer_profile' },
    ANALYSIS,
    'customer_360',
    { resolveEvidence: async () => ({ messageKey: EV_KEY, evidenceText: QUOTE }) }
  )
  ok('①a 三判断全部落库（persisted=3）', r1.persisted === 3 && r1.total === 3)
  const cur1 = salesDbService.judgmentCurrentAll('wx_c1')
  ok('①b opportunity 值=AI 机会判断', cur1.opportunity?.value === '成交可能性高，预算充足')
  ok('①c risk 值=riskSignal 映射', cur1.risk?.value === '客户在对比多家报价，价格敏感')
  ok('①d next_action 值=nextMove 映射', cur1.next_action?.value === '明早 10 点电话跟进报价细节')
  ok('①e model 记录（PRD§23 可追溯）', cur1.opportunity?.model === 'test-model')
  ok('①f 只写三类型（不产生 summary/stage）', salesDbService.judgmentHistory('wx_c1').every((r) => ['opportunity', 'risk', 'next_action'].includes(r.judgment_type)))

  // ── ② 证据：关联任务 source_message_id（默认解析器直读 task）───────────
  const task = salesDbService.todoCreate({
    session_id: 'wx_c2', display_name: '测试客户', trigger_type: 'r1',
    title: '高意向跟进', status: 'pending', source_message_id: EV_KEY
  })
  const r2 = await persist({ id: task.id, sessionId: 'wx_c2' }, ANALYSIS, 'preheat')
  ok('②a persisted=3', r2.persisted === 3)
  const cur2 = salesDbService.judgmentCurrent('wx_c2', 'opportunity')
  ok('②b message_key=任务 source_message_id（P0-1 锚点）', cur2?.message_key === EV_KEY)
  ok('②c 证据状态 ok（可 P0-2B 回查）', judgmentEvidenceStatus(cur2 as any) === 'ok')

  // ── ③ 证据兜底链路（最近消息 key；injected resolver 模拟 chatService 读取）─
  const r3 = await persist(
    { id: 0, sessionId: 'wx_c3' },
    ANALYSIS,
    'customer_360',
    { resolveEvidence: async () => ({ messageKey: 'local:m:9', evidenceText: QUOTE }) }
  )
  ok('③a persisted=3', r3.persisted === 3)
  const cur3 = salesDbService.judgmentCurrent('wx_c3', 'risk')
  ok('③b 兜底证据 message_key 落库', cur3?.message_key === 'local:m:9')
  ok('③c evidence_text=客户原话（非 AI 结论）', cur3?.evidence_text === QUOTE)
  ok('③d evidence_text ≠ 判断值本身', cur3?.evidence_text !== cur3?.value)

  // ── ④ 无可靠证据 → unavailable 不伪造 ──────────────────────────────────
  const r4 = await persist(
    { id: 0, sessionId: 'wx_c4' },
    ANALYSIS,
    'preheat',
    { resolveEvidence: async () => ({}) }
  )
  ok('④a 无证据仍允许落库', r4.persisted === 3)
  const cur4 = salesDbService.judgmentCurrent('wx_c4', 'next_action')
  ok('④b message_key 留空（null 不伪造）', cur4?.message_key === null)
  ok('④c evidence_text 留空', cur4?.evidence_text === null)
  ok('④d 证据状态派生 unavailable', judgmentEvidenceStatus(cur4 as any) === 'unavailable')

  // ── ⑤ 去重：非手动 24h 按类型 / suggest 手动跳过去重 / append-only ─────
  // ⑤a-c：preheat（非手动）同窗口重复 → 全 dedup；suggest（手动）→ 追加
  const a1 = await persist({ id: 0, sessionId: 'wx_c5' }, ANALYSIS, 'preheat')
  const a2 = await persist({ id: 0, sessionId: 'wx_c5' }, ANALYSIS, 'preheat')
  ok('⑤a 第一次 persisted=3', a1.persisted === 3)
  ok('⑤b 同窗口重复触发 → 全 dedup（persisted=0）', a2.persisted === 0 && a2.reason === 'dedup')
  ok('⑤c 窗口内每类型只一条', salesDbService.judgmentHistory('wx_c5').length === 3)
  const s1 = await persist({ id: 0, sessionId: 'wx_c5' }, ANALYSIS, 'suggest')
  ok('⑤d suggest 手动 → 跳过窗口去重（覆盖权利）', s1.persisted === 3)
  ok('⑤e 历史 6 条（append-only 不 UPDATE）', salesDbService.judgmentHistory('wx_c5').length === 6)
  const cur5 = salesDbService.judgmentCurrent('wx_c5', 'opportunity')
  ok('⑤f suggest 源 source=manual（可区分）', cur5?.source === 'manual')
  ok('⑤g 预热源 source=ai', salesDbService.judgmentHistory('wx_c5').some((r) => r.source === 'ai'))
  // ⑤h-i：按类型去重——同类型窗口内跳过、异类型照常
  const p1 = await persist({ id: 0, sessionId: 'wx_c6' }, { opportunity: '机会A' }, 'preheat')
  const p2 = await persist({ id: 0, sessionId: 'wx_c6' }, { opportunity: '机会B', riskSignal: '风险B' }, 'preheat')
  ok('⑤h 同类型窗口内去重（opportunity 跳过）', p2.persisted === 1)
  const hist6 = salesDbService.judgmentHistory('wx_c6')
  ok('⑤i opportunity 仍一条（值=机会A 不被覆盖）', hist6.filter((r) => r.judgment_type === 'opportunity').length === 1 && hist6.filter((r) => r.judgment_type === 'opportunity')[0]?.value === '机会A')
  ok('⑤j risk 照常落库', hist6.filter((r) => r.judgment_type === 'risk').length === 1)
  // ⑤k：窗口外（旧记录）→ 重触发追加
  salesDbService.judgmentCreate({ session_id: 'wx_c7', judgment_type: 'risk', value: '旧风险', source: 'ai', createdAt: 1700000000 })
  const w1 = await persist({ id: 0, sessionId: 'wx_c7' }, ANALYSIS, 'preheat')
  const hist7 = salesDbService.judgmentHistory('wx_c7')
  ok('⑤k 窗口外再触发 → 落库（历史保留）', w1.persisted === 3 && hist7.length === 4)
  ok('⑤l 去重窗口沿用 24h 业务语义', ACTION_JUDGMENT_DEDUP_MS === 24 * 3600 * 1000)

  // ── ⑥ 现场路径不变 ─────────────────────────────────────────────────────
  // ⑥a：无 sessionId → 不落库不抛错
  let threw6 = false
  let r6a: any
  try {
    r6a = await persist({ id: 0 }, ANALYSIS, 'preheat')
  } catch { threw6 = true }
  ok('⑥a 无 sessionId → invalid_input 不抛错', !threw6 && r6a?.persisted === 0 && r6a?.reason === 'invalid_input')
  // ⑥b：无三判断字段 → 不落库
  const r6b = await persist({ id: 0, sessionId: 'wx_c6b' }, { whyNow: '仅 whyNow' }, 'preheat')
  ok('⑥b 无三判断字段 → 不落库（total=0）', r6b.persisted === 0 && r6b.total === 0)
  // ⑥c：空字段不落——只有 opportunity 时只落 1 条
  const r6c = await persist({ id: 0, sessionId: 'wx_c6c' }, { opportunity: '仅机会' }, 'preheat')
  ok('⑥c 空字段不落（只落 opportunity）', r6c.persisted === 1 && r6c.total === 1 && salesDbService.judgmentHistory('wx_c6c').length === 1)
  // ⑥d：证据解析抛错 → 不阻断，无证据落库（unavailable 诚实）
  const r6d = await persist(
    { id: 0, sessionId: 'wx_c6d' },
    ANALYSIS,
    'preheat',
    { resolveEvidence: async () => { throw new Error('resolver boom') } }
  )
  ok('⑥d 证据解析失败仍落库（不伪造证据）', r6d.persisted === 3 && salesDbService.judgmentCurrent('wx_c6d', 'risk')?.message_key === null)
  // ⑥e：basis 记录输入快照（taskId/triggerType/channel）
  const cur6e = salesDbService.judgmentCurrent('wx_c6', 'risk')
  const basis6e = cur6e?.basis ? JSON.parse(cur6e.basis) : {}
  ok('⑥e basis 含 taskId/triggerType/channel', basis6e.taskId === 0 && basis6e.channel === 'preheat')
  const cur6e2 = salesDbService.judgmentCurrent('wx_c1', 'opportunity')
  const basis6e2 = cur6e2?.basis ? JSON.parse(cur6e2.basis) : {}
  ok('⑥f basis 记录 360 通道与触发类型', basis6e2.channel === 'customer_360' && basis6e2.triggerType === 'customer_profile')
  // ⑥g：三层分离——judgment 写路径不产生 follow_up_task 行
  const tasks = salesDbService.todoList({ session_id: 'wx_c1' })
  ok('⑥g 只写 customer_judgment（无 follow_up_task 行，三层不冒充）', tasks.length === 0)
  // ⑥h：跨 session 不污染
  ok('⑥h wx_c2 无 wx_c1 判断', salesDbService.judgmentHistory('wx_c2').every((r) => r.session_id === 'wx_c2'))
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'aaj-'))
  await salesDbService.initialize(dir)
  await runScenario()
  console.log(`action-analysis-judgment-test: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main()
