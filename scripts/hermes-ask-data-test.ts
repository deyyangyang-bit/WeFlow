/**
 * hermes-ask-data-test.ts —— 刀 5 问数据单测（设计-Hermes-MVP 刀 5，业务库联动）
 * 覆盖：
 *  a. 意图分类正反例（纯函数 classifyAskIntent：四模板命中 / 泛化数据词 / 拿不准按知识类）
 *  b. 四模板数字与库内真实值一致（/tmp 副本造数断言）：今日行动+晨间摘要 / 我的商机按阶段+沉默 /
 *     客户到哪步（商机阶段+最新合同+最近信号）/ 本月到款（statsOverview monthPaid 同口径）
 *  c. owner 过滤（铁律：销售查不到他人名下；空归属公共资源可见；manager 全量）
 *  d. 覆盖不了分支（unsupported 诚实不伪造 + 零埋点）
 *  e. 埋点落行（knowledge/generated entity=data_ask；viewed 同 askKey 只记一次）
 *  f. 静态铁律：模板清单=白名单常量两处消费 / 执行器恰四模板 / 每执行器过 filterByOwner /
 *     prompt 只传查询结果不传原始聊天 / LLM 只转述（system prompt 禁新增数字）/ 分发器接线
 * 运行：npx tsx scripts/hermes-ask-data-test.ts
 */
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

let pass = 0, fail = 0
function ok(name: string, cond: boolean): void {
  if (cond) { pass++ } else { fail++; console.error('FAIL:', name) }
}

const isoDir = mkdtempSync(join(tmpdir(), 'hermes-data-'))
process.env.WEFLOW_USER_DATA_PATH = isoDir
process.env.WEFLOW_CONFIG_CWD = isoDir

import { salesDbService } from '../electron/services/salesDbService'
import { crmDbService } from '../electron/services/crmDbService'
import { classifyAskIntent, extractCustomerName, askData, markDataAskViewed, HERMES_DATA_TEMPLATES, ASK_DATA_SYSTEM_PROMPT, ASK_DATA_TEMPERATURE, buildAskDataUserPrompt } from '../electron/services/hermesAskDataService'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DAY = 86400_000
const ME = { name: '杨青', role: '销售' }
const PEER = { name: '王五', role: '销售' }
const BOSS = { name: '主管甲', role: '主管' }

async function main(): Promise<void> {
  await salesDbService.initialize(mkdtempSync(join(tmpdir(), 'hermes-data-sales-')))
  await crmDbService.initialize(mkdtempSync(join(tmpdir(), 'hermes-data-crm-')))
  const now = Date.now()

  // ─── a. 意图分类正反例（纯函数）───────────────────────────────────────────
  ok('a1 今天要办什么 → today_actions', classifyAskIntent('今天我该先跟谁').kind === 'data' && classifyAskIntent('今天我该先跟谁').templateId === 'today_actions')
  ok('a2 我的商机快凉 → my_opportunities', classifyAskIntent('我的商机哪个快凉了').templateId === 'my_opportunities')
  ok('a3 某客户到哪步 → customer_stage', classifyAskIntent('李林辉到哪步了').templateId === 'customer_stage')
  ok('a4 本月到款多少 → month_received', classifyAskIntent('这个月到款多少').templateId === 'month_received')
  ok('a5 反例：这车续航多少 → knowledge（刀 3 旗舰问题不许被「多少」劫持）', classifyAskIntent('这车续航多少').kind === 'knowledge')
  ok('a6 反例：帮我写催款话术 → knowledge', classifyAskIntent('帮我写一段催款话术').kind === 'knowledge')
  ok('a7 泛化数据词无模板 → data/null（unsupported）', classifyAskIntent('我的客户都分布在哪里').kind === 'data' && classifyAskIntent('我的客户都分布在哪里').templateId === null)
  ok('a8 反例：李林辉是谁 → knowledge（「谁」让位知识类）', classifyAskIntent('李林辉是谁').kind === 'knowledge')
  ok('a9 空问题 → knowledge（拿不准按知识类）', classifyAskIntent('').kind === 'knowledge')
  ok('a10 客户名提取纯函数', extractCustomerName('李林辉到哪步了') === '李林辉' && extractCustomerName('常州伟业现在进展如何') === '常州伟业')

  // ─── b1/c. 模板：today_actions（造数断言）─────────────────────────────────
  const t1 = salesDbService.todoCreate({ trigger_type: 'manual', title: '跟张总报价', session_id: 'wxid_a', due_at: now + 3600_000, priority_score: 8, created_by: 'manual' })
  salesDbService.todoCreate({ trigger_type: 'manual', title: '回访李姐', session_id: 'wxid_b', due_at: now + 3 * DAY, priority_score: 5, created_by: 'manual' })
  salesDbService.reportCreate({ period_type: 'morning_digest', period_start: now, period_end: now, stats: '{}', ai_summary: '今天 2 位客户值得跟进' })
  const r1 = await askData({ question: '今天我该先跟谁' }, { identity: ME, now })
  ok('b1 today_actions：数字来自查询结果行（pending=2，卡片名来自行）',
    r1.status === 'answer' && r1.templateId === 'today_actions' &&
    (r1.rows as { pendingCount: number }).pendingCount === 2 &&
    (r1.rows as { top: Array<{ title: string }> }).top.some((t) => t.title === '跟张总报价'))
  ok('b2 today_actions 文案：计数+晨间摘要读口同源', r1.text.includes('2 条待办行动卡') && r1.text.includes('晨间摘要') && r1.text.includes('今天 2 位客户值得跟进'))
  void t1

  // 空分支：清掉任务后 → 仍是 answer（「没有待办」也是答案）
  void t1
  salesDbService.todoList({ status: 'pending', limit: 100 }).forEach((t) => salesDbService.todoUpdate(t.id!, { status: 'done' }))
  const r1b = await askData({ question: '今天要办什么' }, { identity: ME, now, configured: false })
  ok('b3 today_actions 空分支：诚实「没有待办」不伪造', r1b.status === 'answer' && r1b.text.includes('没有待办'))

  // ─── b2/c. 模板：my_opportunities + owner 过滤 ────────────────────────────
  const accA = crmDbService.create('account', { name: '李林辉', owner_sales: '杨青', created_at: now, updated_at: now })
  const accB = crmDbService.create('account', { name: '王五的客户', owner_sales: '王五', created_at: now, updated_at: now })
  const accC = crmDbService.create('account', { name: '公共线索客户', owner_sales: '', created_at: now, updated_at: now })
  crmDbService.create('opportunity', { account_id: accA, name: '李林辉叉车', stage: '决策', amount: 150000, status: 'active', owner_sales: '杨青', last_signal_at: now - 8 * DAY, created_at: now, updated_at: now })
  crmDbService.create('opportunity', { account_id: accA, name: '李林辉仓储', stage: '比价', amount: 50000, status: 'active', owner_sales: '杨青', last_signal_at: now - 2 * DAY, created_at: now, updated_at: now })
  crmDbService.create('opportunity', { account_id: accB, name: '王五单子', stage: '了解', amount: 80000, status: 'active', owner_sales: '王五', last_signal_at: now - DAY, created_at: now, updated_at: now })
  crmDbService.create('opportunity', { account_id: accC, name: '公共单子', stage: '了解', amount: 30000, status: 'active', owner_sales: '', last_signal_at: now - 10 * DAY, created_at: now, updated_at: now })

  const r2 = await askData({ question: '我的商机哪个快凉了' }, { identity: ME, now })
  const r2rows = r2.rows as { totalCount: number; top: Array<{ customer: string; silentDays: number | null; stage: string }> }
  ok('b4 my_opportunities：销售视角 = 本人 2 条 + 空归属 1 条（他人名下不可见）', r2.status === 'answer' && r2rows.totalCount === 3)
  ok('b5 沉默天数与库内真实值一致（10 天前信号 → 沉默 10 天，按最近信号倒序）',
    r2rows.top[0]?.customer === '公共线索客户' && r2rows.top[0]?.silentDays === 10 && r2.text.includes('沉默 10 天'))
  ok('b6 阶段口径与库一致（决策/比价/了解）', r2.text.includes('决策 1') && r2.text.includes('比价 1') && r2.text.includes('了解 1'))

  const r2peer = await askData({ question: '我的商机哪个快凉了' }, { identity: PEER, now })
  const r2peerRows = r2peer.rows as { totalCount: number; top: Array<{ customer: string }> }
  ok('c1 owner 过滤：王五看自己 1 条 + 公共 1 条（他人杨青名下 2 条不可见）',
    r2peerRows.totalCount === 2 && r2peerRows.top.every((t) => t.customer !== '李林辉'))
  const r2boss = await askData({ question: '我的商机哪个快凉了' }, { identity: BOSS, now })
  ok('c2 管理视角全量（4 条）', (r2boss.rows as { totalCount: number }).totalCount === 4)

  // ─── b3/c. 模板：customer_stage ──────────────────────────────────────────
  crmDbService.create('contract', { account_id: accA, name: '李林辉购车合同', amount: 150000, status: 'signed', created_at: now, updated_at: now })
  const r3 = await askData({ question: '李林辉到哪步了' }, { identity: ME, now })
  const r3rows = r3.rows as { found: boolean; opportunity: { stage: string; silentDays: number | null } | null; latestContract: { status: string } | null }
  ok('b7 customer_stage：商机取最近信号行（比价/2 天前）+ 最新合同与库一致',
    r3.status === 'answer' && r3rows.found === true && r3rows.opportunity?.stage === '比价' &&
    r3rows.opportunity?.silentDays === 2 && r3rows.latestContract?.status === 'signed')
  ok('b8 customer_stage 文案三要素齐', r3.text.includes('比价') && r3.text.includes('合同') && r3.text.includes('2 天前'))
  const r3peer = await askData({ question: '李林辉到哪步了' }, { identity: PEER, now })
  ok('c3 owner 过滤：王五问李林辉 → 查不到（不泄露存在性）', (r3peer.rows as { found: boolean }).found === false && r3peer.text.includes('不在你的客户范围内'))
  const r3boss = await askData({ question: '李林辉到哪步了' }, { identity: BOSS, now })
  ok('c4 管理视角可查任意客户', (r3boss.rows as { found: boolean }).found === true)

  // ─── b4. 模板：month_received（statsOverview monthPaid 同口径）────────────
  const pay1 = crmDbService.create('payment_record', { amount_net: 30000, pay_time: now - 2 * DAY, source: 'bank_text', created_at: now })
  crmDbService.create('allocation', { payment_record_id: pay1, credited_amount: 30000, account_id: accA, status: 'confirmed', created_at: now })
  const pay2 = crmDbService.create('payment_record', { amount_net: 7000, pay_time: now - DAY, source: 'bank_text', created_at: now })
  crmDbService.create('allocation', { payment_record_id: pay2, credited_amount: 7000, account_id: accB, status: 'confirmed', created_at: now })
  const pay3 = crmDbService.create('payment_record', { amount_net: 2000, pay_time: now - 40 * DAY, source: 'bank_text', created_at: now - 40 * DAY })
  crmDbService.create('allocation', { payment_record_id: pay3, credited_amount: 2000, account_id: accA, status: 'confirmed', created_at: now - 40 * DAY })
  const r4 = await askData({ question: '这个月到款多少' }, { identity: ME, now })
  ok('b9 month_received：销售口径 = 本人 30000（上月 2000 不入、王五 7000 不入）',
    r4.status === 'answer' && (r4.rows as { total: number }).total === 30000 && r4.text.includes('30,000'))
  const r4boss = await askData({ question: '这个月到款多少' }, { identity: BOSS, now })
  ok('b10 month_received：管理口径 = 全店 37000（与 statsOverview 同口径按到款日归类）',
    (r4boss.rows as { total: number }).total === 37000)
  const statsOverview = crmDbService.statsOverview()
  ok('b11 与 statsOverview.monthPaid 同源交叉验证（37000）', Number(statsOverview.monthPaid) === 37000)

  // ─── d. 覆盖不了分支 + LLM 转述 ───────────────────────────────────────────
  const genBefore = salesDbService.proposalEventCount({ event_type: 'knowledge', stage: 'generated' })
  const r5 = await askData({ question: '我的客户都分布在哪里' }, { identity: ME, now })
  ok('d1 覆盖不了 → 诚实「还不会查」不伪造数字 + 零埋点',
    r5.status === 'unsupported' && r5.text.includes('这个问题我还不会查') &&
    salesDbService.proposalEventCount({ event_type: 'knowledge', stage: 'generated' }) === genBefore)

  let llmUser = ''
  const r6 = await askData({ question: '这个月到款多少' }, {
    identity: ME, now, configured: true,
    completion: async (system, user) => { llmUser = user; return `本月到款三万元整。` }
  })
  ok('d2 LLM 只转述：via=llm 且答案取自 LLM 输出', r6.status === 'answer' && r6.via === 'llm' && r6.text === '本月到款三万元整。')
  ok('d3 转述 prompt 只传查询结果（JSON 行），不传原始聊天', llmUser.includes('【查询结果】') && llmUser.includes('"total":30000') && !llmUser.includes('聊天') && !llmUser.includes('message_key'))
  const r7 = await askData({ question: '今天要办什么' }, { identity: ME, now, configured: false })
  ok('d4 未配置模型 → 文案模板兜底（via=template 链路不断）', r7.status === 'answer' && r7.via === 'template')
  let llmFailCalled = 0
  const r8 = await askData({ question: '这个月到款多少' }, {
    identity: ME, now, configured: true,
    completion: async () => { llmFailCalled++; throw new Error('网络炸了') }
  })
  ok('d5 转述失败回退文案模板（数字同源）', r8.status === 'answer' && r8.via === 'template' && r8.text.includes('30,000') && llmFailCalled === 1)

  // ─── e. 埋点落行 ─────────────────────────────────────────────────────────
  ok('e1 出答案 → knowledge/generated（entity=data_ask，askKey 哈希）',
    salesDbService.proposalEventEntityIds('knowledge', 'generated', 'data_ask').has(r1.askKey))
  markDataAskViewed({ question: '今天我该先跟谁' })
  markDataAskViewed({ question: '今天我该先跟谁' })
  ok('e2 viewed 同 askKey 只记一次（两次展开只落 1 行 data_ask）',
    salesDbService.proposalEventCount({ event_type: 'knowledge', stage: 'viewed' }) === 1 &&
    salesDbService.proposalEventEntityIds('knowledge', 'viewed', 'data_ask').has(r1.askKey))
  ok('e3 unsupported 不记 generated（不出答案不入账）',
    salesDbService.proposalEventCount({ event_type: 'knowledge', stage: 'generated' }) === genBefore + 3) // r1/r3/r4... 见下：答案共 3 条新增（r1,r2,r3,r4 中 r1 已计 e1 基线外）——精确值见断言
  ok('e4 纯函数 buildAskDataUserPrompt 结构', buildAskDataUserPrompt('Q', { a: 1 }).includes('【查询结果】') && buildAskDataUserPrompt('Q', { a: 1 }).includes('"a":1'))

  // ─── f. 静态铁律 ─────────────────────────────────────────────────────────
  const svcSrc = readFileSync(join(ROOT, 'electron/services/hermesAskDataService.ts'), 'utf8')
  ok('f1 模板清单 = 白名单常量恰四个（一处定义）', HERMES_DATA_TEMPLATES.length === 4 && HERMES_DATA_TEMPLATES.map((t) => t.id).join(',') === 'today_actions,my_opportunities,customer_stage,month_received')
  ok('f2 执行器与清单一一对应（两处消费；default 分支不可达兜底）',
    /case 'today_actions'/.test(svcSrc) && /case 'my_opportunities'/.test(svcSrc) &&
    /case 'customer_stage'/.test(svcSrc) && /case 'month_received'/.test(svcSrc) && /default: return/.test(svcSrc))
  ok('f3 所有模板查询先过 filterByOwner（四执行器逐一）',
    (svcSrc.match(/filterByOwner\(/g) || []).length >= 4)
  ok('f4 铁律：LLM system prompt 禁新增数字（数字只能来自查询结果行）',
    ASK_DATA_TEMPERATURE === 0.2 && ASK_DATA_SYSTEM_PROMPT.includes('每一个数字都必须原样来自') && ASK_DATA_SYSTEM_PROMPT.includes('绝不新增'))
  const promptFn = svcSrc.slice(svcSrc.indexOf('export function buildAskDataUserPrompt'), svcSrc.indexOf('function defaultCompletion'))
  ok('f5 prompt 组装函数零原始聊天出口（只有问题 + 查询结果 JSON）',
    promptFn.includes('JSON.stringify(rows)') && !/parsedContent|getMessages|message_key|聊天/.test(promptFn))
  const mainSrc = readFileSync(join(ROOT, 'electron/main.ts'), 'utf8')
  ok('f6 分发器接线：kb:ask 分类 → askData / hermesAskService.askKnowledge（enqueue 最外层）',
    /sales:kb:ask[\s\S]{0,260}classifyAskIntent/.test(mainSrc) && /classifyAskIntent\(question\)\.kind === 'data'/.test(mainSrc) && /askData\(\{ question \}\)/.test(mainSrc))
  const crmSrc = readFileSync(join(ROOT, 'electron/services/crmDbService.ts'), 'utf8')
  ok('f7 三个只读读口在 crmDbService（accountSearchByName/contractsByAccount/monthPaidByOwner 同口径）',
    crmDbService.accountSearchByName('李林辉').length === 1 && crmDbService.contractsByAccount(accA).length === 1 &&
    /monthPaidByOwner[\s\S]{0,900}al\.status = 'confirmed' AND al\.account_id IS NOT NULL/.test(crmSrc))
  const trackSrc = readFileSync(join(ROOT, 'electron/services/proposalEventTracking.ts'), 'utf8')
  ok('f8 viewed 去重单点（data_ask 实体）', trackSrc.includes("proposalEventEntityIds('knowledge', 'viewed', 'data_ask')"))

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail > 0 ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
