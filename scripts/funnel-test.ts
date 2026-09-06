/**
 * funnel-test.ts —— 销售漏斗（历史累计流转）数据单测
 *
 * 覆盖：funnelStats(days) 新返回结构（funnel/conversion/intentTimeline/currentDistribution/
 *       totalCustomers/newCustomersInWindow）：
 *  - 英文 classifier 阶段（contacted/quoted/negotiating/won/lost/dormant）与中文归一
 *  - 独立去重：同一客户同一档位多条日志只计 1 次（绝不按行数）
 *  - 中英混写同档合并（比价 + quoted → 比价 1 次）
 *  - 跳级场景相邻转化率 >100%
 *  - 时间窗口：createdAt 早于窗口的日志不计入（30/90/全部）
 *  - currentDistribution 6 档求和 = 建档数；new→了解、dormant→流失 桶映射
 *  - intentTimeline 逐日×逐档位补零，且各档位纵向求和 = funnel 该档人数
 *  - 除零不产生 NaN
 *
 * 运行：npx tsx scripts/funnel-test.ts
 */
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { salesDbService } from '../electron/services/salesDbService'
import { FUNNEL_ORDER } from '../shared/salesStage'
import { toMessageSnippets, extractEvidence } from '../electron/services/salesStageClassifier'
import { buildFunnelSummary } from '../src/utils/funnelSummary'

let pass = 0, fail = 0
function ok(name: string, cond: boolean): void {
  if (cond) { pass++ } else { fail++; console.error('FAIL:', name) }
}
const DAY = 86400_000

function makeDb(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'funnel-'))
  return salesDbService.initialize(dir).then(() => dir)
}

async function runScenario1(): Promise<void> {
  const now = Date.now()
  // wx_a：英文 classifier 全链路，跳过「决策」直接 比价→成交（跳级）
  salesDbService.customerUpsert({ session_id: 'wx_a', display_name: '客户A', stage: 'won' })
  salesDbService.intentCreate({ session_id: 'wx_a', stage: 'contacted', source: 'auto_message_trigger', confidence: 0.8, reason: 'c1', createdAt: now - 5 * DAY })
  salesDbService.intentCreate({ session_id: 'wx_a', stage: 'quoted', source: 'auto_message_trigger', confidence: 0.8, reason: 'c2', createdAt: now - 4 * DAY })
  salesDbService.intentCreate({ session_id: 'wx_a', stage: 'won', source: 'auto_message_trigger', confidence: 0.9, reason: 'c3', createdAt: now - 2 * DAY })
  // wx_b：中英混写同档（比价 + quoted）→ 只计 1 次；另有中文「决策」
  salesDbService.customerUpsert({ session_id: 'wx_b', display_name: '客户B', stage: '比价' })
  salesDbService.intentCreate({ session_id: 'wx_b', stage: '比价', source: 'ai', confidence: 0.7, reason: 'm1', createdAt: now - 5 * DAY })
  salesDbService.intentCreate({ session_id: 'wx_b', stage: 'quoted', source: 'ai', confidence: 0.7, reason: 'm2', createdAt: now - 4 * DAY })
  salesDbService.intentCreate({ session_id: 'wx_b', stage: '决策', source: 'ai', confidence: 0.7, reason: 'm3', createdAt: now - 3 * DAY })
  // wx_c：dormant → 流失 桶映射
  salesDbService.customerUpsert({ session_id: 'wx_c', display_name: '客户C', stage: 'dormant' })
  salesDbService.intentCreate({ session_id: 'wx_c', stage: 'dormant', source: 'auto_message_trigger', confidence: 0.6, reason: 'd1', createdAt: now - 2 * DAY })
  // wx_d：new → 了解 桶映射
  salesDbService.customerUpsert({ session_id: 'wx_d', display_name: '客户D', stage: 'new' })
  salesDbService.intentCreate({ session_id: 'wx_d', stage: 'new', source: 'auto_message_trigger', confidence: 0.6, reason: 'n1', createdAt: now - 1 * DAY })
  // wx_e：40 天前的旧日志 → 只进 90/全部，不进 30
  salesDbService.customerUpsert({ session_id: 'wx_e', display_name: '客户E', stage: 'quoted' })
  salesDbService.intentCreate({ session_id: 'wx_e', stage: 'quoted', source: 'ai', confidence: 0.7, reason: 'old', createdAt: now - 40 * DAY })
  // wx_f：仅建档无意向日志 → 计入 currentDistribution/totalCustomers，不计入漏斗/窗口新增
  salesDbService.customerUpsert({ session_id: 'wx_f', display_name: '客户F', stage: '决策' })
  // wx_g：只成交（跳级，无 决策）→ 决策→成交 转化 >100%
  salesDbService.customerUpsert({ session_id: 'wx_g', display_name: '客户G', stage: 'won' })
  salesDbService.intentCreate({ session_id: 'wx_g', stage: 'won', source: 'auto_message_trigger', confidence: 0.9, reason: 'g1', createdAt: now - 1 * DAY })

  // ── 30 天窗口 ──────────────────────────────────────────────
  const s30 = salesDbService.funnelStats(30)
  const f30 = Object.fromEntries(s30.funnel.map((f) => [f.stage, f.count]))
  ok('1.1 funnel 6 档齐全', s30.funnel.length === 6)
  ok('1.2 30天 了解=2（wx_a+wx_d new）', f30['了解'] === 2)
  ok('1.3 30天 比价=2（wx_a+wx_b，中英混写去重）', f30['比价'] === 2)
  ok('1.4 30天 决策=1（仅 wx_b，wx_a 跳级）', f30['决策'] === 1)
  ok('1.5 30天 成交=2（wx_a+wx_g）', f30['成交'] === 2)
  ok('1.6 30天 流失=1（wx_c dormant 归桶）', f30['流失'] === 1)
  ok('1.7 30天 未知=0', f30['未知'] === 0)
  const c30 = Object.fromEntries(s30.conversion.map((c) => [`${c.from}→${c.to}`, c.rate]))
  ok('1.8 转化率 了解→比价 = 100%', c30['了解→比价'] === 100)
  ok('1.9 转化率 比价→决策 = 50%', c30['比价→决策'] === 50)
  ok('1.10 转化率 决策→成交 = 200%（跳级可 >100%）', c30['决策→成交'] === 200)
  ok('1.11 窗口新进客户 = 5（wx_e 40天前与 wx_f 无日志不计入）', s30.newCustomersInWindow === 5)
  ok('1.12 当前快照 6 档求和 = 建档数 7', s30.currentDistribution.reduce((s, r) => s + r.count, 0) === s30.totalCustomers && s30.totalCustomers === 7)
  const cur30 = Object.fromEntries(s30.currentDistribution.map((c) => [c.stage, c.count]))
  ok('1.13 当前 比价=2（wx_b 中文 + wx_e quoted）', cur30['比价'] === 2)
  ok('1.14 当前 成交=2 / 流失=1 / 了解=1 / 决策=1 / 未知=0', cur30['成交'] === 2 && cur30['流失'] === 1 && cur30['了解'] === 1 && cur30['决策'] === 1 && cur30['未知'] === 0)
  // 逐日补零：窗口起始日（now-30d 当天）→ 今日 含两端共 31 天 × 6 档
  ok('1.15 intentTimeline 逐日补零（31×6=186 条）', s30.intentTimeline.length === 31 * 6)
  for (const s of FUNNEL_ORDER) {
    const sum = s30.intentTimeline.filter((t) => t.stage === s).reduce((a, t) => a + t.count, 0)
    ok(`1.16 时间线${s}纵向求和 = funnel ${s}`, sum === f30[s])
  }

  // ── 90 天窗口（wx_e 进入） ─────────────────────────────────
  const s90 = salesDbService.funnelStats(90)
  const f90 = Object.fromEntries(s90.funnel.map((f) => [f.stage, f.count]))
  ok('2.1 90天 比价=3（含 wx_e 40天前日志）', f90['比价'] === 3)
  ok('2.2 90天 了解/决策/成交/流失 同 30 天', f90['了解'] === 2 && f90['决策'] === 1 && f90['成交'] === 2 && f90['流失'] === 1)
  ok('2.3 90天 窗口新进客户 = 6', s90.newCustomersInWindow === 6)

  // ── 全部历史 ───────────────────────────────────────────────
  const sAll = salesDbService.funnelStats(0)
  const fAll = Object.fromEntries(sAll.funnel.map((f) => [f.stage, f.count]))
  ok('3.1 全部历史 比价=3', fAll['比价'] === 3)
  ok('3.2 全部历史 窗口新进客户 = 6', sAll.newCustomersInWindow === 6)
  ok('3.3 全部历史 时间线覆盖首条日志（40 天前）到今日', sAll.intentTimeline.length >= 40 * 6)

  // ── 6 人话摘要（设计稿四页简化·屏 2）：转化率最低段识别，数据与漏斗同口径 ──
  const sum30 = buildFunnelSummary(s30, 30)
  ok('6.1 摘要命中转化率最低段（比价→决策 50%）', !!sum30 && sum30.fromStage === '比价' && sum30.toStage === '决策')
  ok('6.2 摘要带漏斗人数（2 个比价只 1 个进了决策）', !!sum30 && sum30.fromCount === 2 && sum30.toCount === 1)
  ok('6.3 摘要句完整（近 30 天 + 掉得最多 + 行动引导）',
    sum30?.text === '近 30 天：比价 → 决策 掉得最多（2 个比价只 1 个进了决策）。重点看「比价」阶段的客户是不是没人跟。')
  const sum90 = buildFunnelSummary(s90, 90)
  ok('6.4 90 天窗口摘要随口径更新（比价 3 → 决策 1）',
    !!sum90 && sum90.fromCount === 3 && sum90.toCount === 1 && sum90.windowLabel === '近 90 天')
  const sumAll = buildFunnelSummary(sAll, 0)
  ok('6.5 全部历史窗口标签（days=0 → 全部历史）', !!sumAll && sumAll.windowLabel === '全部历史')
}

/**
 * P0-1 证据（message_key / evidence_text）：
 * - intentCreate 写入 message_key/evidence_text 并能回读（DB 落盘路径）
 * - toMessageSnippets 保留 chatService 形状的 messageKey
 * - extractEvidence 取「客户最近一条实质消息」，不取 AI reason/结论
 */
async function runScenario3(): Promise<void> {
  // 证据写读回环
  const key = 'db:local:msg_abc'
  const tag = salesDbService.intentCreate({
    session_id: 'wx_ev1', stage: '决策', confidence: 0.85, source: 'ai',
    reason: '判断依据（AI 结论，不应进入 evidence_text）',
    message_key: key, evidence_text: '客户表示预计9月份采购10台。',
    createdAt: Date.now() - 1 * DAY
  })
  ok('5.1 写入回读 message_key 一致', tag.message_key === key)
  ok('5.2 写入回读 evidence_text 一致', tag.evidence_text === '客户表示预计9月份采购10台。')
  const history = salesDbService.intentHistory('wx_ev1', 5)
  ok('5.3 intentHistory 也能读到 message_key/evidence_text',
    history[0]?.message_key === key && history[0]?.evidence_text === '客户表示预计9月份采购10台。')
  // 缺证据时不伪造：不传 message_key/evidence_text → 存 null
  const noEv = salesDbService.intentCreate({
    session_id: 'wx_ev2', stage: '了解', confidence: 0.5, source: 'ai', reason: 'x'
  })
  ok('5.4 缺证据存 null 不伪造', noEv.message_key == null && noEv.evidence_text == null)

  // 证据提取语义：chatService.Message 形状（parsedContent/isSend/senderUsername/messageKey）
  const msgs: any[] = [
    { parsedContent: '我们预计9月份采购10台。', isSend: 0, createTime: 200, messageKey: 'k_cust_latest' },
    { parsedContent: '好的，我给您报个价。', isSend: 1, createTime: 100, messageKey: 'k_me' },
    { parsedContent: '预算大概多少？', isSend: 0, createTime: 50, messageKey: 'k_cust_older' }
  ]
  const snippets = toMessageSnippets(msgs)
  ok('5.5 chatService 形状转换保留 messageKey', snippets.every((s) => s.messageKey))
  const evidence = extractEvidence(snippets)
  ok('5.6 取客户（other）最近一条消息', evidence.evidenceText === '我们预计9月份采购10台。')
  ok('5.7 证据 messageKey 指向该消息', evidence.messageKey === 'k_cust_latest')
  ok('5.8 证据是原话非 AI 结论', !evidence.evidenceText?.includes('决策') && !evidence.evidenceText?.includes('判断依据'))
  // 无客户消息时不伪造证据
  const onlyMe = extractEvidence(toMessageSnippets([
    { parsedContent: '在吗？', isSend: 1, createTime: 300, messageKey: 'k_me2' }
  ]))
  ok('5.9 无客户消息 → 不伪造证据', onlyMe.messageKey == null && onlyMe.evidenceText == null)
}

async function runScenario2(): Promise<void> {
  // 除零：无任何前序档位，仅一条 won → 转化率全部为 0 且不为 NaN
  salesDbService.intentCreate({ session_id: 'wx_z1', stage: 'won', source: 'auto_message_trigger', confidence: 0.9, reason: 'z', createdAt: Date.now() - 1 * DAY })
  const s = salesDbService.funnelStats(30)
  const f = Object.fromEntries(s.funnel.map((x) => [x.stage, x.count]))
  ok('4.1 除零场景 了解=0/比价=0/决策=0/成交=1', f['了解'] === 0 && f['比价'] === 0 && f['决策'] === 0 && f['成交'] === 1)
  ok('4.2 转化率均为 0 且无 NaN', s.conversion.every((c) => c.rate === 0))
  ok('4.3 窗口新进客户 = 1', s.newCustomersInWindow === 1)
  ok('4.4 无建档时 currentDistribution 全 0 / totalCustomers=0', s.totalCustomers === 0 && s.currentDistribution.every((c) => c.count === 0))
  // 摘要护栏：所有相邻段 from 档都没人 → 不伪造「掉得最多」结论
  ok('4.5 无可判段时摘要为 null（from 档全 0，不伪造掉段）', buildFunnelSummary(s, 30) === null)
  // 纯函数边界：空数据 / 空转化率 / 并列取先出现
  ok('4.6 空数据摘要为 null', buildFunnelSummary(null, 30) === null && buildFunnelSummary({ funnel: [], conversion: [] }, 30) === null)
  const tie = buildFunnelSummary({
    funnel: [{ stage: '了解', count: 4 }, { stage: '比价', count: 2 }, { stage: '决策', count: 1 }],
    conversion: [{ from: '了解', to: '比价', rate: 50 }, { from: '比价', to: '决策', rate: 50 }]
  }, 7)
  ok('4.7 并列最低取先出现段（了解→比价）', !!tie && tie.fromStage === '了解' && tie.toStage === '比价' && tie.fromCount === 4 && tie.toCount === 2)
}

async function main(): Promise<void> {
  await makeDb()
  await runScenario1()
  salesDbService.close()
  await makeDb()
  await runScenario2()
  salesDbService.close()
  await makeDb()
  await runScenario3()
  salesDbService.close()

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
