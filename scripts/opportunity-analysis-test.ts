/**
 * opportunity-analysis-test.ts —— 商机「阶段分析 + 优先处理 + 汇入统一信号流」单测
 *
 * 覆盖（对应《商机合并与优先处理-实施任务提示》验收要求）：
 *  A. 事实投影纯函数（shared/opportunitySignals）：quote_signal 判定与降级文案、
 *     待办 due_at 语义、阶段滞留阈值与降级、优先层排序、候选资格；
 *  B. active-only 口径：won/lost 不进管道与滞留判定，只进「近 30 天成交」独立指标；
 *  C. 最大卡点＝滞留数与滞留金额双指标同时最大（不合成单一综合分）；
 *  D. 汇入统一信号流：同 session 并入既有卡不重复出卡、opp:<id> 兜底新卡、
 *     聚合只读（不落库）、TOP N 只是排序结果的截取。
 *
 * 运行：npx tsx scripts/opportunity-analysis-test.ts
 */
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let pass = 0, fail = 0
function ok(name: string, cond: boolean): void {
  if (cond) { pass++ } else { fail++; console.error('FAIL:', name) }
}

import { crmDbService } from '../electron/services/crmDbService'
import { salesDbService } from '../electron/services/salesDbService'
import {
  deriveOppAssessment, rankCandidates, compareByUrgency, dwellThresholdDays,
  PIPELINE_STAGES, STAGE_DWELL_DAYS,
  type OppFactsInput
} from '../shared/opportunitySignals'
import { collectOpportunityAssessments, buildOpportunityAnalysis, WON_WINDOW_DAYS } from '../electron/services/opportunityAnalysisService'
import { getUnifiedSignals, opportunityPriorityScore } from '../electron/services/salesActionEngine'

const DAY = 86400_000

/** 事实输入基线：无任何信号的空商机，供各用例按需覆盖 */
function facts(over: Partial<OppFactsInput> = {}): OppFactsInput {
  const nowMs = over.nowMs ?? Date.now()
  return {
    opportunityId: 1,
    accountId: 1,
    sessionId: 'wxid_base',
    displayName: '基线客户',
    stage: '比价',
    amount: 50000,
    intentScore: 60,
    createdAt: nowMs - 30 * DAY,
    lastContactAt: nowMs - 2 * DAY,
    stageEnteredAt: nowMs - 1 * DAY,
    stageEnteredFromEvent: true,
    tasks: [],
    quoteSignal: null,
    quotation: null,
    risks: [],
    intent: null,
    nowMs,
    ...over
  }
}

function main(): void {
  const now = Date.now()

  // ══ A. 事实投影纯函数 ═══════════════════════════════════════════════════════

  // A1 报价未回：只有 quote_signal 能断言「未回复」，且带可追溯来源
  const a1 = deriveOppAssessment(facts({
    nowMs: now,
    quoteSignal: { id: 7, quotedAt: now - 9 * DAY, customerRepliedAt: 0 }
  }))
  const a1q = a1.reasons.find(r => r.kind === 'quote_unreplied')
  ok('a1a quote_signal 未回复 → 产出「报价发出 9 天未获回复」', a1q?.text === '报价发出 9 天未获回复')
  ok('a1b 报价未回标为确定性紧迫信号（热）', a1q?.hot === true)
  ok('a1c 来源标注含 quoted_at 与 customer_replied_at 空',
    !!a1q && /quote_signal/.test(a1q.source) && /customer_replied_at 空/.test(a1q.source))

  // A2 客户已回复 → 该维度不产出理由，且不得拿 quotation 凑数
  const a2 = deriveOppAssessment(facts({
    nowMs: now,
    quoteSignal: { id: 8, quotedAt: now - 9 * DAY, customerRepliedAt: now - 3 * DAY },
    quotation: { id: 3, createdAt: now - 12 * DAY }
  }))
  ok('a2a 已回复 → 不产出 quote_unreplied', !a2.reasons.some(r => r.kind === 'quote_unreplied'))
  ok('a2b 已回复 → 不降级成「报价记录创建」（不拿 quotation 凑数）',
    !a2.reasons.some(r => r.kind === 'quotation_created'))

  // A3 无 quote_signal 关联、仅有 quotation → 降级文案，措辞不得断言「未回复」
  const a3 = deriveOppAssessment(facts({
    nowMs: now,
    stageEnteredAt: now - 1 * DAY,
    quotation: { id: 11, createdAt: now - 5 * DAY }
  }))
  const a3q = a3.reasons.find(r => r.kind === 'quotation_created')
  ok('a3a 无 quote_signal → 降级为「报价记录创建 5 天」', a3q?.text === '报价记录创建 5 天')
  ok('a3b 降级文案的措辞不断言「未回复」', !!a3q && !/未获回复|未回复/.test(a3q.text))
  ok('a3c 降级文案的来源明写「无 quote_signal 关联，不断言未回复」',
    !!a3q && /无 quote_signal 关联/.test(a3q.source))
  ok('a3d 降级文案不是确定性紧迫信号（不标热）', a3q?.hot === false)

  // A4 两者皆无 → 不产出报价理由（不编造）
  const a4 = deriveOppAssessment(facts({ nowMs: now }))
  ok('a4 无 quote_signal 也无 quotation → 不产出报价理由',
    !a4.reasons.some(r => r.kind === 'quote_unreplied' || r.kind === 'quotation_created'))

  // A5 待办：due_at 是销售自己承诺的截止；逾期优先于今日到期
  const a5 = deriveOppAssessment(facts({
    nowMs: now,
    tasks: [{ id: 318, title: '发送分期方案', dueAt: now - 2 * DAY, status: 'pending' }]
  }))
  const a5t = a5.reasons.find(r => r.kind === 'task_overdue')
  ok('a5a 逾期待办 → 「你的待办「发送分期方案」已逾期 2 天」', a5t?.text === '你的待办「发送分期方案」已逾期 2 天')
  ok('a5b 来源标注到具体待办 id', a5t?.source === '待办 #318')
  ok('a5c overdueDays 供排序第一层使用', a5.overdueDays === 2)
  ok('a5d 有 pending 待办 → pendingTaskCount=1（界面据此显示「查看待办」）', a5.pendingTaskCount === 1)
  const a5today = deriveOppAssessment(facts({
    nowMs: now,
    tasks: [{ id: 1, title: '回电', dueAt: now + 3600_000, status: 'pending' }]
  }))
  ok('a5e 今日到期 → 独立措辞（不与逾期混用）', a5today.reasons.some(r => r.kind === 'task_due_today'))
  ok('a5f 今日到期 overdueDays=0', a5today.overdueDays === 0)
  const a5none = deriveOppAssessment(facts({
    nowMs: now,
    tasks: [{ id: 2, title: '无期限待办', dueAt: null, status: 'pending' }]
  }))
  ok('a5g 无期限待办不产出到期待办理由', !a5none.reasons.some(r => r.kind.startsWith('task_')))
  ok('a5h 无期限待办仍计入 pendingTaskCount', a5none.pendingTaskCount === 1)

  // A6 阶段滞留：阈值 了解 7 / 比价 3 / 决策 2；无 stage_change 事件时降级措辞
  ok('a6a 阈值常量：了解 7 / 比价 3 / 决策 2',
    STAGE_DWELL_DAYS['了解'] === 7 && STAGE_DWELL_DAYS['比价'] === 3 && STAGE_DWELL_DAYS['决策'] === 2)
  ok('a6b 成交段不适用滞留（阈值 null）', dwellThresholdDays('成交') === null && dwellThresholdDays('流失') === null)
  ok('a6c 管道分段只有 了解/比价/决策（成交不进漏斗段）',
    PIPELINE_STAGES.length === 3 && !PIPELINE_STAGES.includes('成交' as never))
  const a6stuck = deriveOppAssessment(facts({
    nowMs: now, stage: '比价', stageEnteredAt: now - 5 * DAY, stageEnteredFromEvent: true
  }))
  ok('a6d 滞留比价段 5 天（阈值 3）→ stuck', a6stuck.stuck && a6stuck.stageDwellDays === 5)
  const a6r = a6stuck.reasons.find(r => r.kind === 'stage_stuck')
  ok('a6e 滞留理由带阈值与天数', !!a6r && /5 天/.test(a6r.text) && /阈值 3 天/.test(a6r.text))
  const a6noEvt = deriveOppAssessment(facts({
    nowMs: now, stage: '比价', stageEnteredAt: now - 5 * DAY, stageEnteredFromEvent: false
  }))
  const a6r2 = a6noEvt.reasons.find(r => r.kind === 'stage_stuck')
  ok('a6f 无阶段事件 → 降级为「至少 5 天」（不假装知道精确入段时刻）',
    !!a6r2 && /至少 5 天/.test(a6r2.text))
  const a6fresh = deriveOppAssessment(facts({
    nowMs: now, stage: '比价', stageEnteredAt: now - 2 * DAY, stageEnteredFromEvent: true
  }))
  ok('a6g 未超阈值 → 不滞留、不产出滞留理由', !a6fresh.stuck && !a6fresh.reasons.some(r => r.kind === 'stage_stuck'))

  // A7 候选资格 = 待办到期/逾期 或 超阶段滞留阈值
  ok('a7a 无待办且未滞留 → 无候选资格', a4.eligible === false)
  ok('a7b 有逾期待办 → 有候选资格（即使未滞留）',
    deriveOppAssessment(facts({
      nowMs: now, stageEnteredAt: now - 1 * DAY,
      tasks: [{ id: 9, title: 't', dueAt: now - DAY, status: 'pending' }]
    })).eligible === true)
  ok('a7c 滞留但无待办 → 有候选资格', a6stuck.eligible === true)

  // A8 优先层排序：逾期时点 → 紧迫信号条数 → 价值 → 意向 → 沉默时长 → id
  const base = { nowMs: now, stageEnteredAt: now - 1 * DAY }
  const overdue3 = deriveOppAssessment(facts({ ...base, opportunityId: 1, tasks: [{ id: 1, title: 't', dueAt: now - 3 * DAY, status: 'pending' }] }))
  const overdue1 = deriveOppAssessment(facts({ ...base, opportunityId: 2, tasks: [{ id: 2, title: 't', dueAt: now - 1 * DAY, status: 'pending' }] }))
  const sortedByOverdue = rankCandidates([overdue1, overdue3])
  ok('a8a 逾期越久越靠前', sortedByOverdue[0].opportunityId === 1)
  // 同为「今天到期」（overdueDays=0）时：紧迫信号条数多者前
  const today1 = deriveOppAssessment(facts({ ...base, opportunityId: 3, amount: 999999, intentScore: 99, tasks: [{ id: 3, title: 't', dueAt: now + 3600_000, status: 'pending' }] }))
  const todayHot = deriveOppAssessment(facts({
    ...base, opportunityId: 4, amount: 1, intentScore: 1,
    tasks: [{ id: 4, title: 't', dueAt: now + 3600_000, status: 'pending' }],
    quoteSignal: { id: 5, quotedAt: now - 6 * DAY, customerRepliedAt: 0 }
  }))
  ok('a8b 同为今天到期 → 紧迫信号多者优先（不受金额劫持）',
    rankCandidates([today1, todayHot])[0].opportunityId === 4)
  ok('a8c 条数相同时按金额降序',
    rankCandidates([
      deriveOppAssessment(facts({ ...base, opportunityId: 5, amount: 10000, tasks: [{ id: 5, title: 't', dueAt: now - DAY, status: 'pending' }] })),
      deriveOppAssessment(facts({ ...base, opportunityId: 6, amount: 20000, tasks: [{ id: 6, title: 't', dueAt: now - DAY, status: 'pending' }] }))
    ])[0].opportunityId === 6)
  ok('a8d 金额相同时按意向降序',
    rankCandidates([
      deriveOppAssessment(facts({ ...base, opportunityId: 7, amount: 10000, intentScore: 20, tasks: [{ id: 7, title: 't', dueAt: now - DAY, status: 'pending' }] })),
      deriveOppAssessment(facts({ ...base, opportunityId: 8, amount: 10000, intentScore: 80, tasks: [{ id: 8, title: 't', dueAt: now - DAY, status: 'pending' }] }))
    ])[0].opportunityId === 8)
  ok('a8e 全并列时按商机 id 升序（顺序稳定可复现）', compareByUrgency(
    deriveOppAssessment(facts({ ...base, opportunityId: 10, tasks: [{ id: 10, title: 't', dueAt: now - DAY, status: 'pending' }] })),
    deriveOppAssessment(facts({ ...base, opportunityId: 11, tasks: [{ id: 11, title: 't', dueAt: now - DAY, status: 'pending' }] }))
  ) < 0)
  ok('a8f 名单只含候选（不合格者被过滤）', rankCandidates([overdue3, a4]).length === 1)

  // A9 沉默时长来自最近联系时刻（无联系记录不拿创建时刻冒充）
  const a9 = deriveOppAssessment(facts({ nowMs: now, lastContactAt: now - 4 * DAY }))
  ok('a9a 沉默时长 = 距最近一次真实联系', a9.silentDays === 4)
  ok('a9b 无联系记录 → 沉默 0（不拿创建时刻冒充）',
    deriveOppAssessment(facts({ nowMs: now, lastContactAt: 0 })).silentDays === 0)

  // A10 意向理由读历史抽取产物，不产出公式
  const a10 = deriveOppAssessment(facts({ nowMs: now, intent: { createdAt: now - 8 * DAY, reason: '曾表示"再比较两家"' } }))
  const a10r = a10.reasons.find(r => r.kind === 'intent')
  ok('a10a 意向记录 → 理由含原话', !!a10r && a10r.text.includes('再比较两家'))
  ok('a10b 意向理由标注来源与日期', !!a10r && /意向记录/.test(a10r.source))
  ok('a10c 无意向记录 → 不编造意向理由',
    !deriveOppAssessment(facts({ nowMs: now })).reasons.some(r => r.kind === 'intent'))

  // A11 风险理由读存量 crm_risk active 行
  const a11 = deriveOppAssessment(facts({
    nowMs: now,
    risks: [{ id: 21, riskType: 'competitor', severity: 'high', detail: '竞对已报价', status: 'active', createdAt: now - DAY }]
  }))
  ok('a11 未处理风险 → 产出风险理由', a11.reasons.some(r => r.kind === 'risk'))

  mainDb(now)
}

/** B/C/D：库装配层（active-only 口径、最大卡点双指标、汇入统一信号流的合并与只读） */
function mainDb(now: number): void {
  const dir = mkdtempSync(join(tmpdir(), 'opp-analysis-'))
  void (async () => {
    await crmDbService.initialize(dir)
    await salesDbService.initialize(dir)

    // ── 种子：账户 + 商机 + 阶段事件 + 报价信号 + 待办 ─────────────────────
    const mkAccount = (name: string, sid: string): number => {
      const id = crmDbService.ensureAccount(name)
      crmDbService.update('account', id, { session_id: sid })
      return id
    }
    const mkOpp = (accountId: number, stage: string, status: string, amount: number, createdAt: number): number =>
      crmDbService.create('opportunity', {
        account_id: accountId, name: `${stage}-商机`, stage, status, amount,
        created_at: createdAt, updated_at: createdAt, last_signal_at: createdAt
      })
    const mkStageEvent = (oppId: number, stage: string, at: number): void => {
      crmDbService.create('opportunity_event', { opportunity_id: oppId, event_type: 'stage_change', stage, detail: '', created_at: at })
    }

    // 了解段：2 条滞留，滞留金额合计 9 万
    const accA = mkAccount('了解滞留甲', 'wxid_opp_ua')
    const accB = mkAccount('了解滞留乙', 'wxid_opp_ub')
    const oA = mkOpp(accA, '了解', 'active', 50000, now - 40 * DAY)
    const oB = mkOpp(accB, '了解', 'active', 40000, now - 40 * DAY)
    mkStageEvent(oA, '了解', now - 20 * DAY) // 阈值 7 → 滞留
    mkStageEvent(oB, '了解', now - 20 * DAY)

    // 比价段：2 条滞留，滞留金额合计 20 万（滞留数与了解段并列最大，金额更大 → 唯一最大卡点）
    const accC = mkAccount('比价滞留丙', 'wxid_opp_uc')
    const accD = mkAccount('比价滞留丁', 'wxid_opp_ud')
    const oC = mkOpp(accC, '比价', 'active', 120000, now - 30 * DAY)
    const oD = mkOpp(accD, '比价', 'active', 80000, now - 30 * DAY)
    mkStageEvent(oC, '比价', now - 10 * DAY) // 阈值 3 → 滞留
    mkStageEvent(oD, '比价', now - 10 * DAY)

    // 决策段：1 条未滞留（未超阈值 2 天）
    const accE = mkAccount('决策新鲜戊', 'wxid_opp_ue')
    const oE = mkOpp(accE, '决策', 'active', 30000, now - 5 * DAY)
    mkStageEvent(oE, '决策', now - 1 * DAY)

    // won / lost：都不得进管道
    const accW = mkAccount('已成交己', 'wxid_opp_uw')
    const oW = mkOpp(accW, '成交', 'won', 0, now - 40 * DAY)
    crmDbService.update('opportunity', oW, { amount_cny: 152000 })
    crmDbService.create('opportunity_event', { opportunity_id: oW, event_type: 'won', stage: '成交', detail: '', created_at: now - 3 * DAY })
    const accL = mkAccount('已丢单庚', 'wxid_opp_ul')
    const oL = mkOpp(accL, '流失', 'lost', 66000, now - 40 * DAY)
    crmDbService.create('opportunity_event', { opportunity_id: oL, event_type: 'lost', stage: '流失', detail: '价格过高', created_at: now - 5 * DAY })

    // 丙：报价未回（quote_signal）+ 逾期待办 → 强候选
    crmDbService.create('quote_signal', {
      msg_key: 'qk_c', session_id: 'wxid_opp_uc', account_id: accC, display_name: '比价滞留丙',
      amount: 120000, model: '', quoted_at: now - 9 * DAY, customer_replied_at: 0, created_at: now - 9 * DAY
    })
    salesDbService.customerUpsert({ session_id: 'wxid_opp_uc', display_name: '比价滞留丙', stage: 'quoted', last_contact_at: Math.floor((now - 2 * DAY) / 1000) })
    salesDbService.todoCreate({ session_id: 'wxid_opp_uc', trigger_type: 'manual', title: '发送分期方案', due_at: now - 2 * DAY, status: 'pending' })

    // 丁：无 quote_signal，仅有 quotation → 降级文案路径
    // 报价单走版本链（宪法 §1.6 append-only，直写 quotation 被守卫拒绝）
    const productD = crmDbService.create('product', { model: 'WF-T', name: '丁型号', spec: '', unit_price: 80000, product_line: '', created_at: now - 30 * DAY })
    const contractD = crmDbService.create('contract', { account_id: accD, name: '丁合同', amount: 80000, created_at: now - 20 * DAY, updated_at: now - 20 * DAY })
    const quoD = crmDbService.createQuotation({ contract_id: contractD, items: [{ product_id: productD, qty: 1, unit_price: 80000 }] })
    ok('b0 报价单经版本链创建成功（不散写 quotation）', quoD.ok === true && Number(quoD.version) === 1)
    salesDbService.customerUpsert({ session_id: 'wxid_opp_ud', display_name: '比价滞留丁', stage: 'quoted', last_contact_at: Math.floor((now - 1 * DAY) / 1000) })

    // ── B. active-only 口径 ────────────────────────────────────────────────
    // 装配用调用时刻（不早于种子时刻）：避免种子时刻恰好整日导致的天数取整偏移
    const all = collectOpportunityAssessments()
    ok('b1 只装配 active 商机（won/lost 不在其中）', all.length === 5 && !all.some(a => a.opportunityId === oW || a.opportunityId === oL))

    const res = buildOpportunityAnalysis()
    const activeAmount = 50000 + 40000 + 120000 + 80000 + 30000
    ok('b2 管道只统计 active：5 条', res.overview.activeCount === 5)
    ok('b3 管道金额只含 active', res.overview.activeAmount === activeAmount)
    ok('b4 管道分段不含成交/流失段', res.stages.every(s => ['了解', '比价', '决策'].includes(s.stage)) && res.stages.length === 3)
    ok('b5 分段计数与金额配平总览',
      res.stages.reduce((s, x) => s + x.count, 0) === res.overview.activeCount &&
      res.stages.reduce((s, x) => s + x.amount, 0) === res.overview.activeAmount)
    ok('b6 已成交商机不进任何分段', res.stages.every(s => s.candidates.every(c => c.opportunityId !== oW)))

    // 近 30 天成交 = 独立指标（含 amount_cny 口径）
    ok('b7 近 30 天成交独立计数（won 不计入管道）', res.overview.wonCount30d === 1 && res.overview.wonAmount30d === 152000)
    ok('b8 成交窗口为 30 天', WON_WINDOW_DAYS === 30)

    // ── 报价信号与降级文案（库装配路径）────────────────────────────────────
    const assC = all.find(a => a.opportunityId === oC)!
    const assD = all.find(a => a.opportunityId === oD)!
    ok('b9 丙：quote_signal 未回 → 「报价发出 9 天未获回复」',
      assC.reasons.some(r => r.kind === 'quote_unreplied' && /9 天未获回复/.test(r.text)))
    ok('b10 丙：逾期待办 + 报价未回 + 比价滞留 → 三条理由齐备',
      assC.reasons.length === 3 && assC.stuck)
    ok('b10b 阶段滞留是候选资格门槛，不计入「确定性紧迫信号」条数',
      assC.reasons.find(r => r.kind === 'stage_stuck')?.hot === false && assC.hotSignalCount === 2)
    ok('b11 丁：无 quote_signal 关联 → 降级「报价记录创建 X 天」，不断言未回复',
      assD.reasons.some(r => r.kind === 'quotation_created' && /^报价记录创建 \d+ 天$/.test(r.text)) &&
      !assD.reasons.some(r => r.kind === 'quote_unreplied'))
    ok('b11b 丁：降级文案不是确定性紧迫信号（不标热）',
      assD.reasons.filter(r => r.hot).length === 0)
    ok('b12 戊：决策段入段 1 天（阈值 2）→ 未滞留', !all.find(a => a.opportunityId === oE)!.stuck)

    // ── C. 最大卡点双指标 ──────────────────────────────────────────────────
    const understand = res.stages.find(s => s.stage === '了解')!
    const compare = res.stages.find(s => s.stage === '比价')!
    ok('c1 了解段滞留数与金额', understand.stuckCount === 2 && understand.stuckAmount === 90000)
    ok('c2 比价段滞留数与金额', compare.stuckCount === 2 && compare.stuckAmount === 200000)
    ok('c3 滞留数并列时由滞留金额决胜 → 只有比价段是最大卡点', compare.isMaxStuck && !understand.isMaxStuck)
    ok('c4 决策段无滞留 → 不是最大卡点', res.stages.find(s => s.stage === '决策')!.isMaxStuck === false)
    ok('c5 滞留总数与金额配平分段', res.overview.stuckCount === 4 && res.overview.stuckAmount === 290000)

    // ── 优先处理名单 ──────────────────────────────────────────────────────
    const cCands = compare.candidates.map(c => c.opportunityId)
    ok('c6 比价段名单按紧迫度排序：逾期待办者在前', cCands[0] === oC && cCands.length === 2)
    ok('c7 丙的排名分高于丁（同一打分函数）', opportunityPriorityScore(assC) > opportunityPriorityScore(assD))

    // ══ D. 汇入统一信号流 ═══════════════════════════════════════════════════
    void (async () => {
      // 快照：验证聚合只读（不落库）
      const countAll = (): number => {
        const t = (sql: string): number => Number(crmDbService.all(sql, [])[0]?.c ?? 0)
        return t('SELECT COUNT(*) AS c FROM opportunity') + t('SELECT COUNT(*) AS c FROM opportunity_event') +
          t('SELECT COUNT(*) AS c FROM quote_signal') + t('SELECT COUNT(*) AS c FROM crm_risk')
      }
      const before = countAll()
      const tasksBefore = salesDbService.todoList({}).length

      const u1 = await getUnifiedSignals()
      const u2 = await getUnifiedSignals()

      ok('d1 聚合只读：crmDb 行数不变', countAll() === before)
      ok('d2 聚合只读：salesDb 待办数不变', salesDbService.todoList({}).length === tasksBefore)
      ok('d3 二次调用结果稳定（无副作用累积）', u1.signals.length === u2.signals.length)

      // 丙有 pending 待办 → 应并入该客户既有卡，而不是重复出卡
      const cardsWithC = u1.signals.filter(s => (s.sources || []).some(x => x.type === 'opportunity' && x.opportunityId === oC))
      ok('d4 同一客户不重复出卡（商机信号并入既有卡）', cardsWithC.length === 1)
      ok('d5 并入的卡仍保留该客户原有待办来源',
        (cardsWithC[0]?.sources || []).some(x => x.type === 'task'))
      ok('d6 商机信号以 sourceRef 保留可追溯来源',
        (cardsWithC[0]?.sources || []).filter(x => x.type === 'opportunity')
          .every(x => typeof (x as { sourceRef?: string }).sourceRef === 'string' && String((x as { sourceRef?: string }).sourceRef).length > 0))

      // 丁无待办 → 新建 opp:<id> 卡（不伪造 AI 来源）
      const dCard = u1.signals.find(s => s.itemKey === `opp:${oD}`)
      ok('d7 无既有卡的商机 → 新建 opp:<id> 卡', !!dCard)
      ok('d8 新卡来源全部为 opportunity（不冒充 task/AI）',
        !!dCard && dCard.sources.length > 0 && dCard.sources.every(s => s.type === 'opportunity'))

      // TOP N 只是排序结果的截取：全列表按 priorityScore 降序
      const scores = u1.signals.map(s => s.priorityScore)
      ok('d9 聚合结果按 priorityScore 降序（TOP N 即其前缀）',
        scores.every((v, i) => i === 0 || scores[i - 1] >= v))
      ok('d10 参与聚合的商机数与阶段分析同源（同一装配函数）',
        u1.signals.filter(s => (s.sources || []).some(x => x.type === 'opportunity')).length > 0 &&
        collectOpportunityAssessments().length === all.length)

      console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
      if (fail > 0) process.exit(1)
    })()
  })().catch((e) => { console.error(e); process.exit(1) })
}

main()
