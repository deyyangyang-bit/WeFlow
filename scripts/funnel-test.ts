/**
 * funnel-test.ts —— 销售漏斗数据单测（修复：转化率口径 + 近7天按客户去重）
 * 覆盖：funnelStats.stageDistribution 阶段分布、
 *       intentTimeline 按客户首次打标日期去重（同一客户重复扫描只计 1 次）、
 *       totalCustomers 客户总数。
 * P0-1 证据（message_key / evidence_text）：
 *       intentCreate 写入证据并能回读、toMessageSnippets 保留 messageKey、
 *       extractEvidence 取客户最近实质消息、缺证据不伪造。
 * 运行：npx tsx scripts/funnel-test.ts
 */
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { salesDbService } from '../electron/services/salesDbService'
import { toMessageSnippets, extractEvidence } from '../electron/services/salesStageClassifier'

let pass = 0, fail = 0
function ok(name: string, cond: boolean): void {
  if (cond) { pass++ } else { fail++; console.error('FAIL:', name) }
}
const DAY = 86400_000

// JS 本地日期键（与前端 weekTrend 一致，用于校验 SQLite localtime 同源）
function todayKey(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
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
  const msgs: Array<{ parsedContent: string; isSend: number; createTime: number; messageKey: string }> = [
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

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'funnel-'))
  await salesDbService.initialize(dir)

  // 客户 A：3 条意向标签（模拟同一客户被重复扫描）→ 首次打标今天，应只计 1 个新客
  salesDbService.customerUpsert({ session_id: 'wx_a', display_name: '客户A', stage: '了解' })
  salesDbService.intentCreate({ session_id: 'wx_a', stage: '了解', source: 'ai', confidence: 0.7, reason: '扫描1' })
  salesDbService.intentCreate({ session_id: 'wx_a', stage: '比价', source: 'ai', confidence: 0.7, reason: '扫描2' })
  salesDbService.intentCreate({ session_id: 'wx_a', stage: '比价', source: 'ai', confidence: 0.7, reason: '扫描3' })
  // 客户 B：1 条标签 → 今天第 2 个新客
  salesDbService.customerUpsert({ session_id: 'wx_b', display_name: '客户B', stage: '比价' })
  salesDbService.intentCreate({ session_id: 'wx_b', stage: '比价', source: 'ai', confidence: 0.7, reason: '扫描1' })
  // 客户 C：只建档无标签 → 不计入新增
  salesDbService.customerUpsert({ session_id: 'wx_c', display_name: '客户C', stage: '决策' })

  const stats = salesDbService.funnelStats()
  ok('a 阶段分布聚合正确', stats.stageDistribution.reduce((s, r) => s + r.count, 0) === 3)
  ok('b 客户总数 = 3', stats.totalCustomers === 3)
  const today = todayKey()
  const todayNew = stats.intentTimeline.find((t) => t.date === today)
  ok('c 今天新增进漏斗客户 = 2（A 重复扫描只算 1 次）', todayNew?.count === 2)
  ok('d 无标签客户不计入新增', stats.intentTimeline.length === 1)
  // 阶段分布按 customer_profile.stage 归并
  const stageOf = (s: string) => stats.stageDistribution.find((r) => r.stage === s)?.count || 0
  ok('e 了解=1 / 比价=1 / 决策=1', stageOf('了解') === 1 && stageOf('比价') === 1 && stageOf('决策') === 1)

  // P0-1 证据断言（5.1–5.9）
  await runScenario3()

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
