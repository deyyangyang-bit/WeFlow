/**
 * funnel-test.ts —— 销售漏斗数据单测（修复：转化率口径 + 近7天按客户去重）
 * 覆盖：funnelStats.stageDistribution 阶段分布、
 *       intentTimeline 按客户首次打标日期去重（同一客户重复扫描只计 1 次）、
 *       totalCustomers 客户总数。
 * 运行：npx tsx scripts/funnel-test.ts
 */
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { salesDbService } from '../electron/services/salesDbService'

let pass = 0, fail = 0
function ok(name: string, cond: boolean): void {
  if (cond) { pass++ } else { fail++; console.error('FAIL:', name) }
}

// JS 本地日期键（与前端 weekTrend 一致，用于校验 SQLite localtime 同源）
function todayKey(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
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

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
