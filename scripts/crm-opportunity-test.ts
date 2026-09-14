/**
 * crm-opportunity-test.ts —— 商机模块单测（P0：AI 从聊天自动识别采购信号 → 商机）
 * 覆盖：parseBuySignal 采购信号识别（命中/闲聊排除/数量金额提取）、
 *       opportunityUpsertBySignal 同客户同产品累积 / 不同产品新建、
 *       syncOpportunityStageByAccount 客户阶段联动（顺推/成交关单/流失关单）、
 *       opportunityStats 漏斗聚合、opportunityEvent 事件留痕。
 * 运行：npx tsx scripts/crm-opportunity-test.ts
 */
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { crmDbService } from '../electron/services/crmDbService'
import { parseBuySignal, parseRiskSignal } from '../electron/services/crmParseRules'
import { salesDbService } from '../electron/services/salesDbService'
import { computeIntentScore } from '../electron/services/intentScore'
import { buildNextStep } from '../src/utils/oppNextStep'
import { apply as applyM04 } from './migration/04-history-deal-opportunity'

let pass = 0, fail = 0
function ok(name: string, cond: boolean): void {
  if (cond) { pass++ } else { fail++; console.error('FAIL:', name) }
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'crm-opportunity-'))
  await crmDbService.initialize(dir)
  await salesDbService.initialize(dir)

  // ── 0 意向评分 0-100（computeIntentScore 纯函数）──────────────────────────
  const sc1 = computeIntentScore({ stage: '比价', lastContactAt: 0, recentEventCount: 3, lastEventAt: Date.now() - 2 * 86400_000, oppCount: 1, oppQuantity: 20, oppAmount: 70000 })
  ok('0a 比价+近期活跃+商机 → 高分', sc1.score >= 80 && sc1.level === '高意向')
  ok('0b 评分依据含阶段/活跃/商机', sc1.factors.some((f) => f.label === '当前阶段') && sc1.factors.some((f) => f.label === '商机进展'))
  const sc2 = computeIntentScore({ stage: '了解', lastContactAt: Date.now() - 40 * 86400_000, recentEventCount: 0, lastEventAt: 0, oppCount: 0, oppQuantity: 0, oppAmount: 0 })
  ok('0c 久未跟进低分', sc2.score < 30)
  const sc3 = computeIntentScore({ stage: '流失', lastContactAt: 0, recentEventCount: 0, lastEventAt: 0, oppCount: 0, oppQuantity: 0, oppAmount: 0 })
  ok('0d 流失极低分', sc3.score <= 5)
  const sc4 = computeIntentScore({ stage: '决策', lastContactAt: 0, recentEventCount: 10, lastEventAt: Date.now() - 86400_000, oppCount: 2, oppQuantity: 30, oppAmount: 100000 })
  ok('0e 分数封顶 100', sc4.score === 100)
  // salesDbService.intentScore 集成：写入客户+意向标记后评分
  salesDbService.customerUpsert({ session_id: 'wx_ck_score', display_name: '评分客户', stage: '比价' })
  salesDbService.intentCreate({ session_id: 'wx_ck_score', stage: '比价', source: 'ai', confidence: 0.8, reason: '测试' })
  salesDbService.intentCreate({ session_id: 'wx_ck_score', stage: '比价', source: 'ai', confidence: 0.8, reason: '测试' })
  const sc5 = salesDbService.intentScore('wx_ck_score', { count: 1, quantity: 5, amount: 0 })
  ok('0f intentScore 跨库装配可用', !!sc5 && sc5.score >= 60)
  ok('0g 无客户返回 null', salesDbService.intentScore('wx_nonexist', undefined) === null)

  // ── 1 parseBuySignal：采购信号识别（客户消息 isSend=0）────────────────────
  const s1 = parseBuySignal('我们准备采购10台2吨的电动叉车，你们多少钱？', 0)
  ok('1a 命中采购：提取产品+数量', !!s1 && s1.product === '2吨电动叉车' && s1.quantity === 10)
  const s2 = parseBuySignal('3台手动搬运车什么价格', 0)
  ok('1b 命中采购：无吨位取大类', !!s2 && s2.product === '手动搬运车' && s2.quantity === 3)
  const s3 = parseBuySignal('6500我可以考虑，你们能再便宜点吗', 0)
  ok('1c 客户给价：提取金额', !!s3 && s3.amount === 6500)
  ok('1d 我方消息不触发（isSend=1）', parseBuySignal('2吨叉车给你报 7000', 1) === null)
  ok('1e 闲聊排除（你在吗）', parseBuySignal('你好，你在吗？', 0) === null)
  ok('1f 无采购意向不触发', parseBuySignal('今天天气不错', 0) === null)
  ok('1g 无数量无设备不触发', parseBuySignal('你们最近怎么样啊', 0) === null)
  const s8 = parseBuySignal('想了解下 5 台叉车的价格', 0)
  ok('1h 命中采购：了解+数量', !!s8 && s8.quantity === 5)
  const s9 = parseBuySignal('哪个店有货啊，发个图看看', 0)
  ok('1i 噪声排除（发个图/哪个店）', s9 === null)

  // ── 2 opportunityUpsertBySignal：同客户同产品累积 / 不同产品新建 ──────────
  const accId = crmDbService.ensureAccount('合肥某物流公司')
  crmDbService.update('account', accId, { session_id: 'wx_ck_hefei' })
  const r1 = crmDbService.opportunityUpsertBySignal(accId, '合肥某物流公司', {
    product: '2吨电动叉车', quantity: 10, amount: 0, stage: '了解', detail: '准备采购10台2吨的电动叉车'
  })
  ok('2a 首次信号创建商机', r1.created)
  const opp1 = crmDbService.opportunityById(r1.id)
  ok('2b 商机字段落库', !!opp1 && String(opp1.product) === '2吨电动叉车' && Number(opp1.quantity) === 10 && Number(opp1.amount) === 0)
  ok('2c 商机名自动生成', !!opp1 && String(opp1.name) === '2吨电动叉车采购')
  const r2 = crmDbService.opportunityUpsertBySignal(accId, '合肥某物流公司', {
    product: '2吨电动叉车', quantity: 20, amount: 70000, stage: '了解', detail: '20台，6500一台'
  })
  ok('2d 同产品同客户不重复建', r2.id === r1.id && r2.created === false)
  const opp2 = crmDbService.opportunityById(r1.id)
  ok('2e 信号累积更新数量/金额', Number(opp2?.quantity) === 20 && Number(opp2?.amount) === 70000)
  const r3 = crmDbService.opportunityUpsertBySignal(accId, '合肥某物流公司', {
    product: '手动搬运车', quantity: 5, amount: 0, stage: '了解', detail: '还要5台手动搬运车'
  })
  ok('2f 不同产品新建第二个商机', r3.created && r3.id !== r1.id)
  ok('2g 客户活跃商机数=2', crmDbService.activeOpportunitiesByAccount(accId).length === 2)
  ok('2h 商机事件已留痕', crmDbService.opportunityEvents(r1.id).length >= 2)

  // ── 2i~2l 跨库装配回归（2026-09-14）：CrmRow 与「合计」的字段映射 ─────────────
  // 背景：合计此前是 handler 里的内联 reduce，TS 对 `CrmRow[]` 的累加器形参报 TS2345
  //（形参类型 {count,quantity,amount} 与 CrmRow 无重叠），曾被误读为「商机统计恒 0 的真 bug」。
  // 运行期本来就是对的；这里用真实行锁住「合计按 opportunity 列名求和、非 0」，并反证错误形态会归零。
  salesDbService.customerUpsert({ session_id: 'wx_ck_hefei', display_name: '合肥某物流公司', stage: '比价' })
  const totals = crmDbService.activeOpportunityTotals(accId)
  ok('2i 活跃商机合计 count=2', totals.count === 2, JSON.stringify(totals))
  ok('2j 合计按 opportunity 列名 quantity/amount 求和（20+5=25 / 70000+0）',
    totals.quantity === 25 && totals.amount === 70000, JSON.stringify(totals))
  const scOpp = salesDbService.intentScore('wx_ck_hefei', crmDbService.activeOpportunityTotals(accId))
  ok('2k 合计喂入 intentScore →「商机进展」因子 15 分（有数量+金额），商机统计不恒 0',
    (scOpp?.factors.find((f) => f.label === '商机进展')?.delta ?? 0) === 15, JSON.stringify(scOpp?.factors))
  const badTotals = salesDbService.intentScore(
    'wx_ck_hefei',
    crmDbService.activeOpportunitiesByAccount(accId) as unknown as { count: number; quantity: number; amount: number }
  )
  ok('2l 反证：把 CrmRow 数组整个当合计传 → count 读不到，无「商机进展」因子（归零形态）',
    !!badTotals && !badTotals.factors.some((f) => f.label === '商机进展'), JSON.stringify(badTotals?.factors))

  // ── 3 syncOpportunityStageByAccount：客户阶段联动 ──────────────────────────
  const n1 = crmDbService.syncOpportunityStageByAccount(accId, '比价')
  ok('3a 了解→比价 顺推（两个活跃商机都推进）', n1 === 2 && String(crmDbService.opportunityById(r1.id)?.stage) === '比价')
  const n2 = crmDbService.syncOpportunityStageByAccount(accId, '了解')
  ok('3b 阶段倒退不回退', n2 === 0 && String(crmDbService.opportunityById(r1.id)?.stage) === '比价')
  const n3 = crmDbService.syncOpportunityStageByAccount(accId, '成交')
  ok('3c 客户成交 → 只生成待成交登记提醒，不直接置 won', n3 === 2 && String(crmDbService.opportunityById(r1.id)?.status) === 'active')
  const pendingEvents = crmDbService.opportunityEvents(r1.id).some((e) => e.event_type === 'deal_pending')
  ok('3d 待成交登记事件留痕（无 won 事件）', pendingEvents && !crmDbService.opportunityEvents(r1.id).some((e) => e.event_type === 'won'))
  const n3b = crmDbService.syncOpportunityStageByAccount(accId, '成交')
  ok('3d2 待成交登记提醒幂等（二次联动不重复）', n3b === 0 && crmDbService.opportunityEvents(r1.id).filter((e) => e.event_type === 'deal_pending').length === 1)
  // 流失场景：新建一个商机后客户流失
  const acc2 = crmDbService.ensureAccount('南京某商贸')
  crmDbService.opportunityUpsertBySignal(acc2, '南京某商贸', { product: '电动搬运车', quantity: 2, amount: 0, stage: '了解', detail: '询价2台电动搬运车' })
  crmDbService.syncOpportunityStageByAccount(acc2, '流失')
  const lostOpp = crmDbService.activeOpportunitiesByAccount(acc2)
  ok('3e 客户流失 → 商机 lost 关单', lostOpp.length === 0 && crmDbService.opportunityList({ accountId: acc2, status: 'lost' }).length === 1)

  // ── 4 opportunityStats / list：漏斗聚合与客户名 JOIN ───────────────────────
  const stats = crmDbService.opportunityStats()
  ok('4a 漏斗总数为 active 商机数（成交联动不再自动关单）', stats.total === 2) // accId 两商机仍 active
  const acc3 = crmDbService.ensureAccount('无锡某仓储')
  crmDbService.opportunityUpsertBySignal(acc3, '无锡某仓储', { product: '堆高车', quantity: 4, amount: 16000, stage: '了解', detail: '要4台堆高车' })
  const stats2 = crmDbService.opportunityStats()
  ok('4b 漏斗统计 active=3', stats2.total === 3)
  ok('4c 漏斗金额聚合', stats2.totalAmount === 86000)
  const list = crmDbService.opportunityList()
  ok('4d 列表 JOIN 客户名', list.some((o) => String(o.account_name) === '无锡某仓储'))
  ok('4e 阶段手动推进留痕', (() => {
    const oid = crmDbService.opportunityList().find((o) => String(o.account_name) === '无锡某仓储')?.id ?? 0
    crmDbService.opportunityUpdateStage(Number(oid), '决策', 'manual')
    return crmDbService.opportunityEvents(Number(oid)).some((e) => e.event_type === 'stage_change' && String(e.detail).includes('manual'))
  })())

  // ── 5 风险预警（P0）：parseRiskSignal 命中 + upsertRisk 幂等 + resolve ───────
  const rk1 = parseRiskSignal('别家比你们便宜500，我看看', 0)
  ok('5a 竞品风险命中（比你们便宜）', !!rk1 && rk1.riskType === 'competitor' && rk1.severity === 'high')
  const rk2 = parseRiskSignal('6500太贵了，还能不能便宜点', 0)
  ok('5b 价格风险命中（太贵/便宜）', !!rk2 && rk2.riskType === 'price' && rk2.severity === 'medium')
  const rk3 = parseRiskSignal('你们售后怎么处理？', 0)
  ok('5c 服务风险命中（售后+怎么）', !!rk3 && rk3.riskType === 'service' && rk3.severity === 'low')
  ok('5d 我方消息不触发（isSend=1）', parseRiskSignal('别家比我们便宜', 1) === null)
  ok('5e 无风险词不触发', parseRiskSignal('好的，那先这样', 0) === null)
  const accR = crmDbService.ensureAccount('苏州某机械')
  const rk5 = crmDbService.upsertRisk(accR, { riskType: 'price', severity: 'medium', detail: '6500太贵了' })
  ok('5f 首次风险创建', rk5.created)
  const rk6 = crmDbService.upsertRisk(accR, { riskType: 'price', severity: 'high', detail: '别家报6500' })
  ok('5g 同类型幂等累积 + 严重度提升', rk6.id === rk5.id && rk6.created === false)
  const riskRow = crmDbService.riskList({ accountId: accR })[0]
  ok('5h 风险详情累积、severity 升为 high', !!riskRow && String(riskRow.severity) === 'high' && String(riskRow.detail).includes('6500太贵了'))
  ok('5i riskList 支持 accountId 过滤', crmDbService.riskList({ accountId: accR }).length === 1 && crmDbService.riskList().length >= 1)
  ok('5j resolveRisk 解决 active 风险', crmDbService.resolveRisk(Number(riskRow?.id)) === true && String(crmDbService.riskList({ accountId: accR })[0]?.status) === 'resolved')
  ok('5k 重复解决返回 false', crmDbService.resolveRisk(Number(riskRow?.id)) === false)

  // ── 6 展示层简化（设计稿 docs/UI设计稿-四页简化.html 屏 1）：静态断言 + 建议下一步投影 ──
  const pageSrc = readFileSync(join(__dirname, '..', 'src/pages/OpportunityPage.tsx'), 'utf8')
  ok('6a 4 统计卡收成一行小字摘要（opp-summary：活跃/决策中/金额待确认；金额大字¥X亿从首屏消失）',
    /className="opp-summary"/.test(pageSrc) && /活跃 \{stats\.total\}/.test(pageSrc) &&
    /决策中 \{decisionCount\}/.test(pageSrc) && /金额待确认 \{pendingAmount\}/.test(pageSrc) &&
    !/opp-stats/.test(pageSrc) && !/stats\.totalAmount/.test(pageSrc) && !/1e8/.test(pageSrc))
  ok('6b 「金额待确认」琥珀可点筛选（pendingOnly 开关 → amount<=0 行，再点取消；与阶段筛选叠加）',
    /const \[pendingOnly, setPendingOnly\] = useState\(false\)/.test(pageSrc) &&
    /setPendingOnly\(\(v\) => !v\)/.test(pageSrc) &&
    /!pendingOnly \|\| Number\(o\.amount\) <= 0/.test(pageSrc))
  ok('6c 列表行减到 4 样（opp-row：头像+客户名 / 副行 产品×数量·最近信号 / 阶段 / 金额待确认灰字），旧 opp-card 行退场',
    /className="opp-row"/.test(pageSrc) && /opp-row__avatar/.test(pageSrc) && /opp-row__name/.test(pageSrc) &&
    /opp-row__sub/.test(pageSrc) && /opp-row__amt--pending/.test(pageSrc) && !/opp-card/.test(pageSrc))
  ok('6d 意向度分数条撤出列表、挪进详情弹窗（opp-factors__score 容器 + opp-score 保留）',
    /opp-factors__score/.test(pageSrc) && /opp-score__bar/.test(pageSrc) &&
    !/opp-card__intent/.test(pageSrc))
  ok('6e 详情弹窗重排：「AI 建议下一步」置顶蓝块（opp-next-step + buildNextStep，零 LLM 零新接口）',
    /className="opp-next-step"/.test(pageSrc) && /AI 建议下一步/.test(pageSrc) &&
    /buildNextStep\(\{ stage: selected\.stage, nextStage: NEXT_STAGE\[selected\.stage\], risks, score: scores\[selected\.id\] \|\| null \}\)/.test(pageSrc))
  ok('6f 漏斗图点击筛阶段交互保留不动', /setStageFilter\(stageFilter === d\.stage \? '' : d\.stage\)/.test(pageSrc))
  ok('6g owner 过滤不丢（filterByOwner 仍在取数路径）', /setOpps\(filterByOwner\(list/.test(pageSrc))

  // buildNextStep 投影优先级：风险命中 → 评分关键因素 → 阶段兜底（纯函数，零 LLM）
  const nx1 = buildNextStep({
    stage: '比价', nextStage: '决策',
    risks: [{ risk_type: 'price', severity: 'medium', detail: '嫌贵', status: 'active' }],
    score: { score: 90, level: '高意向', factors: [{ label: '商机进展', delta: 25, reason: '20台' }] }
  })
  ok('6h 风险命中优先 → 显示风险 + 建议介入', nx1.includes('风险预警') && nx1.includes('价格异议') && nx1.includes('建议尽快介入'))
  const nx2 = buildNextStep({
    stage: '了解', nextStage: '比价', risks: [],
    score: { score: 72, level: '中意向', factors: [{ label: '近期活跃', delta: 8, reason: '三天两条询价' }, { label: '当前阶段', delta: 15, reason: '已进入了解' }] }
  })
  ok('6i 无风险取最高权重因素（|delta| 最大）', nx2.includes('意向评分 72 分') && nx2.includes('当前阶段') && nx2.includes('推进到「比价」'))
  const nx3 = buildNextStep({ stage: '了解', nextStage: '比价', risks: [], score: null })
  ok('6j 无风险无评分 → 按阶段兜底引导', nx3.includes('摸清需求与预算'))
  const nx4 = buildNextStep({ stage: '未知', risks: [], score: null })
  ok('6k 兜底恒有文案（未知阶段）', nx4.length > 0)

  // ── 7 正式成交登记（宪法 §1.5 修订 2026-09-09：字段/won/事件/审计同一事务）──
  {
    const accD = crmDbService.ensureAccount('珠海成交登记测试公司')
    const oppD = crmDbService.opportunityUpsertBySignal(accD, '珠海成交登记测试公司', { product: '2吨电动叉车', quantity: 3, amount: 0, stage: '决策', detail: '要3台2吨车' })
    const prodId = crmDbService.create('product', { model: 'CPD15', name: '平衡重叉车', unit_price: 50000, specs: '{}', variants: '[]', created_at: Date.now() })
    const prodModel = String(crmDbService.getById('product', prodId)?.model)
    const cidD = crmDbService.create('contract', { account_id: accD, name: '珠海-合同', amount: 150000, status: 'signed', created_at: Date.now(), updated_at: Date.now() })
    const qv1 = crmDbService.createQuotation({ contract_id: cidD, items: [{ product_id: prodId, qty: 3 }] })
    ok('7a-0 报价版本创建成功（供成交绑定）', qv1.ok && Number(qv1.version) === 1)
    const d1 = crmDbService.registerOpportunityDeal(oppD.id, {
      amount_cny: 150000, original_currency: 'USD', original_amount: 21000, rate_note: '汇率 7.14，付款回单 #A1',
      main_model: prodModel, model_extra: '托盘 X2', order_qty: 3,
      expected_ship_start: Date.now(), expected_ship_end: Date.now() + 5 * 86400000,
      delivery_date: Date.now() + 30 * 86400000, type: '整车',
      quote_version_id: Number(qv1.id), note: '客户定金已付'
    })
    ok('7a 正式成交登记成功', d1.ok)
    const wonOpp = crmDbService.opportunityById(oppD.id)
    ok('7b 成交金额/币种/原币额/汇率说明落库',
      Number(wonOpp?.amount_cny) === 150000 && Number(wonOpp?.amount) === 150000 &&
      String(wonOpp?.original_currency) === 'USD' && Number(wonOpp?.original_amount) === 21000 &&
      String(wonOpp?.rate_note).includes('7.14'))
    ok('7c 主型号/订单量/整车类型/发运窗口/报价版本落库',
      String(wonOpp?.main_model) === prodModel && Number(wonOpp?.order_qty) === 3 && String(wonOpp?.type) === '整车' &&
      Number(wonOpp?.expected_ship_end) >= Number(wonOpp?.expected_ship_start) &&
      Number(wonOpp?.quote_version_id) === Number(qv1.id))
    ok('7d status=won', String(wonOpp?.status) === 'won')
    ok('7e 商机事件 won 留痕', crmDbService.opportunityEvents(oppD.id).some((e) => e.event_type === 'won' && String(e.detail).includes('定金')))
    ok('7f audit_event 留痕（opportunity_deal_register ×1）',
      Number(crmDbService.all("SELECT COUNT(*) AS c FROM audit_event WHERE action = 'opportunity_deal_register' AND entity_type = 'opportunity' AND entity_id = ?", [oppD.id])[0]?.c) === 1)
    ok('7g 补充型号进 custom_fields.supplementary_models', (() => {
      try { return String(JSON.parse(String(wonOpp?.custom_fields || '{}')).supplementary_models) === '托盘 X2' } catch { return false }
    })())

    // ── 校验失败逐项拒绝 + 零残留（回滚语义：状态/事件/审计三者纹丝不动）──
    const accE = crmDbService.ensureAccount('珠海失败校验公司')
    const oppE = crmDbService.opportunityUpsertBySignal(accE, '珠海失败校验公司', { product: '电动搬运车', quantity: 2, amount: 0, stage: '比价', detail: '询价2台' })
    // 为「报价版本归属/有效版本」用例准备：本客户合同 v1 被 v2 替代成历史版本；另建别家客户的报价
    const cidE = crmDbService.create('contract', { account_id: accE, name: '珠海失败校验-合同', amount: 120000, status: 'signed', created_at: Date.now(), updated_at: Date.now() })
    const qvE1 = crmDbService.createQuotation({ contract_id: cidE, items: [{ product_id: prodId, qty: 2 }] })
    const qvE2 = crmDbService.createQuotation({ contract_id: cidE, items: [{ product_id: prodId, qty: 2, unit_price: 58000 }] })
    ok('7h-0 v2 递增且替代 v1', qvE1.ok && qvE2.ok && Number(qvE2.version) === 2 && Number(crmDbService.getById('quotation', qvE1.id as number)?.effective_to) > 0)
    const accOther = crmDbService.ensureAccount('青岛别家公司')
    const cidOther = crmDbService.create('contract', { account_id: accOther, name: '青岛-合同', amount: 9000, status: 'pending_sign', created_at: Date.now(), updated_at: Date.now() })
    const qOther = crmDbService.createQuotation({ contract_id: cidOther, items: [{ product_id: prodId, qty: 2 }] })
    ok('7h-1 别家客户报价已建', qOther.ok)
    const snapE = () => ({
      status: String(crmDbService.opportunityById(oppE.id)?.status),
      events: crmDbService.opportunityEvents(oppE.id).length,
      audits: Number(crmDbService.all("SELECT COUNT(*) AS c FROM audit_event WHERE entity_type = 'opportunity' AND entity_id = ? AND action = 'opportunity_deal_register'", [oppE.id])[0]?.c)
    })
    const beforeE = snapE()
    const expectFail = (name: string, payload: Record<string, unknown>): void => {
      const r = crmDbService.registerOpportunityDeal(oppE.id, payload as never)
      const after = snapE()
      ok(name, !r.ok && after.status === 'active' && after.events === beforeE.events && after.audits === beforeE.audits)
    }
    const base = { amount_cny: 120000, main_model: prodModel, order_qty: 2, type: '整车' }
    expectFail('7h 成交金额必须 > 0（amount_cny=0）', { ...base, amount_cny: 0 })
    expectFail('7i 订单量必须正整数（0）', { ...base, order_qty: 0 })
    expectFail('7i2 订单量必须正整数（2.5）', { ...base, order_qty: 2.5 })
    expectFail('7j 发运结束早于开始被拒', { ...base, expected_ship_start: Date.now() + 86400000, expected_ship_end: Date.now() })
    expectFail('7k 非CNY缺原币金额被拒', { ...base, original_currency: 'USD' })
    expectFail('7k2 非CNY缺汇率说明被拒', { ...base, original_currency: 'EUR', original_amount: 15000 })
    expectFail('7l 非法主型号（产品库无此型号）被拒', { ...base, main_model: '幽灵型号-999' })
    expectFail('7l2 空主型号被拒', { ...base, main_model: '' })
    expectFail('7m 报价版本不存在被拒', { ...base, quote_version_id: 999999 })
    expectFail('7m2 报价版本属于别家客户被拒', { ...base, quote_version_id: Number(qOther.id) })
    expectFail('7m3 历史报价版本（已被替代）不可绑定', { ...base, quote_version_id: Number(qvE1.id) })
    expectFail('7t 成交类型为空被拒（回滚）', { ...base, type: '' })
    expectFail('7t2 成交类型非法值被拒（回滚）', { ...base, type: '随便写' })
    expectFail('7t3 成交类型缺省被拒（回滚）', { amount_cny: 120000, main_model: prodModel, order_qty: 2 })
    let orphanCurrentId = 0
    crmDbService.runTx((tx) => {
      orphanCurrentId = tx.run(
        'INSERT INTO quotation (contract_id, items, total, version, effective_from, effective_to, created_at) VALUES (?,?,?,?,?,?,?)',
        [cidE, '[]', 1, 99, Date.now(), 0, Date.now()]
      )
    })
    expectFail('7m4 effective_to=0 但非合同指针版本仍不可绑定', { ...base, quote_version_id: orphanCurrentId })

    // 绑定本客户当前有效版本 v2 → 成功（归属与有效版本判定放行）
    const d2 = crmDbService.registerOpportunityDeal(oppE.id, { ...base, quote_version_id: Number(qvE2.id), actor: '测试销售' })
    ok('7n 绑定当前有效版本登记成功', d2.ok && String(crmDbService.opportunityById(oppE.id)?.status) === 'won')
    ok('7o 丢单只写状态和原因（不写成交字段）', (() => {
      const accL = crmDbService.ensureAccount('珠海丢单公司')
      const oppL = crmDbService.opportunityUpsertBySignal(accL, '珠海丢单公司', { product: '堆高车', quantity: 1, amount: 0, stage: '比价', detail: '询价' })
      const closeOk = crmDbService.opportunityClose(oppL.id, 'lost', '价格过高')
      const o = crmDbService.opportunityById(oppL.id)
      return closeOk && String(o?.status) === 'lost' && Number(o?.amount_cny || 0) === 0 && !o?.main_model &&
        crmDbService.opportunityEvents(oppL.id).some((e) => e.event_type === 'lost' && String(e.detail).includes('价格过高'))
    })())

    // ── 事务回滚机制：事务中途抛错 → 已执行语句全部回滚（runTx ROLLBACK 语义）──
    const rbAcc = crmDbService.ensureAccount('回滚探针客户')
    try {
      crmDbService.runTx((tx) => {
        tx.run('UPDATE account SET name = ? WHERE id = ?', ['不应留存', rbAcc])
        tx.run('INSERT INTO opportunity_event (opportunity_id, event_type, stage, detail, created_at) VALUES (?,?,?,?,?)',
          [oppE.id, 'rollback_probe', '', '不应留存', Date.now()])
        throw new Error('模拟事务中途失败')
      })
    } catch { /* 预期抛错 */ }
    ok('7p 事务中途失败整体回滚（改名+事件均未留存）',
      String(crmDbService.all('SELECT name FROM account WHERE id = ?', [rbAcc])[0]?.name) === '回滚探针客户' &&
      !crmDbService.opportunityEvents(oppE.id).some((e) => e.event_type === 'rollback_probe'))
  }

  // ── 8 模块 04 迁移 apply：历史成交 → won 商机 + 存量报价版本链规范化（复用 crmDbService 单点）──
  {
    const accM = crmDbService.ensureAccount('洛阳历史成交迁移公司')
    const cidM = crmDbService.create('contract', {
      account_id: accM, name: '洛阳-历史成交合同', amount: 88000, status: 'signed',
      sign_date: Date.now() - 10 * 86400000, created_at: Date.now() - 40 * 86400000, updated_at: Date.now() - 40 * 86400000
    })
    // 三条散写存量行模拟迁移前数据（无 version/effective 语义）——迁移面对的正是这类存量
    crmDbService.runTx((tx) => {
      for (const [total, daysAgo] of [[1000, 40], [2000, 30], [88000, 20]] as Array<[number, number]>) {
        tx.run('INSERT INTO quotation (contract_id, items, total, created_at, custom_fields) VALUES (?,?,?,?,?)',
          [cidM, '[]', total, Date.now() - daysAgo * 86400000, '{}'])
      }
    })
    const rep1 = applyM04('crm-opportunity-test')
    ok('8a 迁移补建 won 商机', rep1.wonOppCreated >= 1)
    const mOpp = crmDbService.opportunityList({ accountId: accM, status: 'won' })[0]
    ok('8b won 商机 source=migration + amount_cny 回填', !!mOpp && String(mOpp.source) === 'migration' && Number(mOpp.amount_cny) === 88000)
    const chain = crmDbService.quotationHistoryForContract(cidM)
    ok('8c 版本链规范化 version=1..3（按创建序）', chain.length === 3 && Number(chain[0].version) === 3 && Number(chain[2].version) === 1)
    ok('8d effective_from 回填 ← created_at', chain.every((row) => Number(row.effective_from) > 0))
    ok('8e 旧版本 effective_to 关闭、最新版本开放',
      Number(chain[2].effective_to) > 0 && Number(chain[1].effective_to) > 0 && Number(chain[0].effective_to) === 0)
    ok('8f 合同指针接管 → 最新版本', Number(crmDbService.getById('contract', cidM)?.quote_version_id) === Number(chain[0].id))
    ok('8g 迁移幂等（重复执行零第二份数据、链不再改写）', (() => {
      const before = crmDbService.all('SELECT id, version, effective_from, effective_to FROM quotation WHERE contract_id = ? ORDER BY id', [cidM])
      const auditsBefore = Number(crmDbService.all("SELECT COUNT(*) AS c FROM audit_event WHERE action = 'quote_version_backfill' AND entity_id = ?", [Number(chain[0].id)])[0]?.c)
      const rep2 = applyM04('crm-opportunity-test-again')
      const after = crmDbService.all('SELECT id, version, effective_from, effective_to FROM quotation WHERE contract_id = ? ORDER BY id', [cidM])
      const auditsAfter = Number(crmDbService.all("SELECT COUNT(*) AS c FROM audit_event WHERE action = 'quote_version_backfill' AND entity_id = ?", [Number(chain[0].id)])[0]?.c)
      return rep2.wonOppCreated === 0 && JSON.stringify(before) === JSON.stringify(after) && auditsAfter === auditsBefore
    })())
    const cidReverse = crmDbService.create('contract', {
      account_id: accM, name: '创建时间逆序合同', amount: 1, status: 'pending_sign', created_at: Date.now(), updated_at: Date.now()
    })
    crmDbService.runTx((tx) => {
      tx.run('INSERT INTO quotation (contract_id, items, total, created_at) VALUES (?,?,?,?)', [cidReverse, '[]', 2, 200])
      tx.run('INSERT INTO quotation (contract_id, items, total, created_at) VALUES (?,?,?,?)', [cidReverse, '[]', 1, 100])
    })
    const reverseNormalized = crmDbService.normalizeQuotationVersionChain(cidReverse)
    ok('8h ID 与 created_at 逆序时归一后仍能被幂等判定识别', reverseNormalized.ok && crmDbService.quotationChainNormalized(cidReverse))
  }

  // ── 9 成交登记旁路收口回归（2026-09-10）：won 拒绝 / 阶段联动仅提醒 / type 校验 / 报价行校验 ──
  {
    // opportunityClose 只允许丢单（won 一律拒绝；丢单原因必填）
    const accW = crmDbService.ensureAccount('won拒绝探针公司')
    const oppW = crmDbService.opportunityUpsertBySignal(accW, 'won拒绝探针公司', { product: '电动叉车', quantity: 1, amount: 0, stage: '了解', detail: 'x' })
    ok('9a opportunityClose(won) 被拒绝', crmDbService.opportunityClose(oppW.id, 'won' as never, 'x') === false && String(crmDbService.opportunityById(oppW.id)?.status) === 'active')
    ok('9a2 opportunityClose(lost) 缺原因被拒绝', crmDbService.opportunityClose(oppW.id, 'lost', '   ') === false && String(crmDbService.opportunityById(oppW.id)?.status) === 'active')

    // 阶段自动成交 → 待登记提醒（不置 won）+ 幂等 + 提醒后仍可正式成交
    const nW = crmDbService.syncOpportunityStageByAccount(accW, '成交')
    ok('9b 阶段成交只产生待登记提醒，不改 status', nW === 1 && String(crmDbService.opportunityById(oppW.id)?.status) === 'active')
    const pendingCount = () => crmDbService.opportunityEvents(oppW.id).filter((e) => e.event_type === 'deal_pending').length
    ok('9b2 待登记提醒事件留痕', pendingCount() === 1)
    ok('9b3 提醒幂等（二次联动不重复）', crmDbService.syncOpportunityStageByAccount(accW, '成交') === 0 && pendingCount() === 1)
    ok('9b4 提醒后仍可正式成交登记', (() => {
      crmDbService.create('product', { model: 'WON-1', name: 'won探针车', unit_price: 5000, specs: '{}', variants: '[]', created_at: Date.now() })
      const r = crmDbService.registerOpportunityDeal(oppW.id, { amount_cny: 10000, main_model: 'WON-1', order_qty: 2, type: '整车' })
      return r.ok && String(crmDbService.opportunityById(oppW.id)?.status) === 'won'
    })())

    // 改装正常成交（type 校验放行合法枚举）
    const accG = crmDbService.ensureAccount('改装成交公司')
    const oppG = crmDbService.opportunityUpsertBySignal(accG, '改装成交公司', { product: '手动搬运车', quantity: 1, amount: 0, stage: '决策', detail: 'x' })
    crmDbService.create('product', { model: 'MOD-1', name: '改装测试车', unit_price: 1000, specs: '{}', variants: '[]', created_at: Date.now() })
    ok('9c 改装正常成交', crmDbService.registerOpportunityDeal(oppG.id, { amount_cny: 2000, main_model: 'MOD-1', order_qty: 1, type: '改装' }).ok && String(crmDbService.opportunityById(oppG.id)?.status) === 'won' && String(crmDbService.opportunityById(oppG.id)?.type) === '改装')

    // 已关闭商机禁止再次丢单/覆盖成交（won/lost 均拒）
    ok('9c2 已 won 商机再次丢单被拒（成交字段不覆盖）', (() => {
      const again = crmDbService.opportunityClose(oppG.id, 'lost', '误操作再次丢单')
      const o = crmDbService.opportunityById(oppG.id)
      return again === false && String(o?.status) === 'won' && String(o?.type) === '改装' &&
        Number(o?.amount_cny) === 2000 && String(o?.main_model) === 'MOD-1' &&
        !crmDbService.opportunityEvents(oppG.id).some((e) => e.event_type === 'lost')
    })())
    ok('9c3 已 lost 商机再次丢单被拒（lost 事件不重复）', (() => {
      const accL2 = crmDbService.ensureAccount('重复丢单公司')
      const oppL2 = crmDbService.opportunityUpsertBySignal(accL2, '重复丢单公司', { product: '堆高车', quantity: 1, amount: 0, stage: '比价', detail: 'x' })
      const first = crmDbService.opportunityClose(oppL2.id, 'lost', '价格高')
      const second = crmDbService.opportunityClose(oppL2.id, 'lost', '再丢一次')
      return first === true && second === false &&
        crmDbService.opportunityEvents(oppL2.id).filter((e) => e.event_type === 'lost').length === 1
    })())

    // 报价行校验（数量/单价/产品主数据）
    const accQ = crmDbService.ensureAccount('报价校验公司')
    const cidQ = crmDbService.create('contract', { account_id: accQ, name: '报价校验合同', amount: 0, status: 'pending_sign', created_at: Date.now(), updated_at: Date.now() })
    const prodQ = crmDbService.create('product', { model: 'Q-1', name: '报价校验车', unit_price: 5000, specs: '{}', variants: '[]', created_at: Date.now() })
    ok('9d 报价数量必须正整数（0 拒绝）', !crmDbService.createQuotation({ contract_id: cidQ, items: [{ product_id: prodQ, qty: 0 }] }).ok)
    ok('9d2 报价数量必须正整数（小数拒绝）', !crmDbService.createQuotation({ contract_id: cidQ, items: [{ product_id: prodQ, qty: 1.5 }] }).ok)
    ok('9d3 报价单价不可为负', !crmDbService.createQuotation({ contract_id: cidQ, items: [{ product_id: prodQ, qty: 1, unit_price: -1 }] }).ok)
    ok('9d4 报价产品必须命中产品主数据', !crmDbService.createQuotation({ contract_id: cidQ, items: [{ product_id: 999999, qty: 1 }] }).ok)
    ok('9d5 合法报价（unit_price=0 允许）正常创建', crmDbService.createQuotation({ contract_id: cidQ, items: [{ product_id: prodQ, qty: 1, unit_price: 0 }] }).ok)
  }

  // ── 10 通用 IPC 边界封堵（crmIpcHandlers 源码静态断言：商机禁止通用散写，非法调用抛错）──
  const ipcSrc = readFileSync(join(__dirname, '..', 'electron/services/crmIpcHandlers.ts'), 'utf8')
  ok('10a crm:entity:create 禁止 entity=opportunity 并抛错',
    /crm:entity:create/.test(ipcSrc) && /entity === 'opportunity'/.test(ipcSrc))
  // 2026-09-10 收口：原 shipped_qty/delivery_date 白名单零调用者且绕过 registerDelivery（丢审计+差异任务同步），整路关闭
  ok('10b crm:entity:update 商机一律抛错（交付写入唯一入口 registerDelivery，白名单已移除）',
    /crm:entity:update/.test(ipcSrc) &&
    /crm:entity:update', async[\s\S]{0,400}entity === 'opportunity'[\s\S]{0,200}throw new Error/.test(ipcSrc) &&
    !/ALLOWED/.test(ipcSrc) && !/'shipped_qty',\s*'delivery_date'/.test(ipcSrc))
  ok('10c 抛错文案指引专用端点（非静默忽略）',
    /商机禁止走通用更新：成交登记用 crm:opportunity:registerDeal，交付登记用 crm:delivery:register/.test(ipcSrc))

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
