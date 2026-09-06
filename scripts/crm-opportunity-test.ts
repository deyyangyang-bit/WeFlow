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

  // ── 3 syncOpportunityStageByAccount：客户阶段联动 ──────────────────────────
  const n1 = crmDbService.syncOpportunityStageByAccount(accId, '比价')
  ok('3a 了解→比价 顺推（两个活跃商机都推进）', n1 === 2 && String(crmDbService.opportunityById(r1.id)?.stage) === '比价')
  const n2 = crmDbService.syncOpportunityStageByAccount(accId, '了解')
  ok('3b 阶段倒退不回退', n2 === 0 && String(crmDbService.opportunityById(r1.id)?.stage) === '比价')
  const n3 = crmDbService.syncOpportunityStageByAccount(accId, '成交')
  ok('3c 客户成交 → 商机 won 关单', n3 === 2 && String(crmDbService.opportunityById(r1.id)?.status) === 'won')
  const wonEvents = crmDbService.opportunityEvents(r1.id).some((e) => e.event_type === 'won')
  ok('3d 关单事件留痕', wonEvents)
  // 流失场景：新建一个商机后客户流失
  const acc2 = crmDbService.ensureAccount('南京某商贸')
  crmDbService.opportunityUpsertBySignal(acc2, '南京某商贸', { product: '电动搬运车', quantity: 2, amount: 0, stage: '了解', detail: '询价2台电动搬运车' })
  crmDbService.syncOpportunityStageByAccount(acc2, '流失')
  const lostOpp = crmDbService.activeOpportunitiesByAccount(acc2)
  ok('3e 客户流失 → 商机 lost 关单', lostOpp.length === 0 && crmDbService.opportunityList({ accountId: acc2, status: 'lost' }).length === 1)

  // ── 4 opportunityStats / list：漏斗聚合与客户名 JOIN ───────────────────────
  const stats = crmDbService.opportunityStats()
  ok('4a 漏斗总数为 active 商机数', stats.total === 0) // 前两个都关单了，active=0
  const acc3 = crmDbService.ensureAccount('无锡某仓储')
  crmDbService.opportunityUpsertBySignal(acc3, '无锡某仓储', { product: '堆高车', quantity: 4, amount: 16000, stage: '了解', detail: '要4台堆高车' })
  const stats2 = crmDbService.opportunityStats()
  ok('4b 漏斗统计 active=1', stats2.total === 1)
  ok('4c 漏斗金额聚合', stats2.totalAmount === 16000)
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

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
