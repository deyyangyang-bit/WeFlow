/**
 * report-review-test.ts —— 销售复盘模块单测
 * 覆盖：
 *  A. computeWeeklyReviewStats 周复盘统计纯函数
 *     - 热了：本周 vs 上周基线对比（前进/新进/后退/无变化/已成交不热）
 *     - 冷：contacted/negotiating/quoted 沉默 >30 天；won/lost/unknown 不冷
 *     - 放弃：沉默 >60 天且未成交未流失
 *     - 阶段分布：中英混合 stage 归一化到英文 key
 *     - 活跃客户明细
 *  B. filterCustomerSessions 非客户过滤纯函数
 *     - account/profile 命中保留，两者皆无剔除；按消息量排序 top10
 *  C. salesDbService.intentBefore 集成：上周基线查询
 * 运行：npx tsx scripts/report-review-test.ts
 */
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { computeWeeklyReviewStats, filterCustomerSessions } from '../electron/services/salesReportService'
import type { CustomerProfile } from '../electron/services/salesDbService'

let pass = 0, fail = 0
function ok(name: string, cond: boolean): void {
  if (cond) { pass++ } else { fail++; console.error('FAIL:', name) }
}

// 相对时间（秒）：NOW 为基准日，WEEK_START 为本周一
const DAY = 86400
const NOW = 100 * DAY
const WEEK_START = 94 * DAY

function customer(sid: string, stage: string, lastContactAgoDays: number): CustomerProfile {
  return { session_id: sid, display_name: sid, stage, last_contact_at: NOW - lastContactAgoDays * DAY, created_at: NOW - 200 * DAY }
}

/** 构造 getIntentLatest/getIntentBefore mock：stageBefore = 上周基线，stageNow = 本周最新 */
function intentOpts(history: Record<string, { before?: string; now?: string }>) {
  return {
    nowSec: NOW,
    weekStartSec: WEEK_START,
    getIntentLatest: (sid: string) => (history[sid]?.now ? { stage: history[sid].now } : undefined),
    getIntentBefore: (sid: string) => (history[sid]?.before ? { stage: history[sid].before } : undefined)
  }
}

function main(): void {
  // ── A1 热了：本周 vs 上周基线对比 ──────────────────────────────────────────
  const hotIntent = {
    wx_h1: { now: 'quoted' },                                  // 上周无 → 新进入管道，热
    wx_h2: { before: 'contacted', now: 'negotiating' },        // 前进 了解→决策，热
    wx_h3: { before: 'negotiating', now: 'quoted' },           // 后退 决策→比价，不热
    wx_h4: { before: 'quoted', now: 'quoted' },                // 无变化，不热
    wx_h5: { before: 'contacted', now: 'won' }                 // 已成交，不热
  }
  const hotCust = [
    customer('wx_h1', 'quoted', 2),
    customer('wx_h2', 'negotiating', 3),
    customer('wx_h3', 'quoted', 4),
    customer('wx_h4', 'quoted', 5),
    customer('wx_h5', 'won', 6)
  ]
  const hotStats = computeWeeklyReviewStats(hotCust, intentOpts(hotIntent))
  ok('A1a 上周无记录本周有 → 热（新进入管道）', hotStats.hotCustomers.some((s) => s.includes('wx_h1') && s.includes('比价')))
  ok('A1b 阶段前进 了解→决策 → 热', hotStats.hotCustomers.some((s) => s.includes('wx_h2') && s.includes('决策')))
  ok('A1c 阶段后退 决策→比价 → 不热', !hotStats.hotCustomers.some((s) => s.includes('wx_h3')))
  ok('A1d 阶段无变化 → 不热', !hotStats.hotCustomers.some((s) => s.includes('wx_h4')))
  ok('A1e 已成交 won → 不热', !hotStats.hotCustomers.some((s) => s.includes('wx_h5')))
  ok('A1f 热数统计一致', hotStats.hotCount === 2)

  // ── A2 冷：contacted/negotiating/quoted 沉默 >30 天 ─────────────────────────
  const coldCust = [
    customer('wx_c1', '比价', 35),          // 中文 stage，35 天 → 冷（验证中英归一化）
    customer('wx_c2', 'won', 70),           // 已成交 70 天 → 不冷不放弃
    customer('wx_c3', 'lost', 40),          // 已流失 → 不冷
    customer('wx_c4', 'unknown', 45)        // 未知 → 不冷（不在冷名单）
  ]
  const coldStats = computeWeeklyReviewStats(coldCust, intentOpts({}))
  ok('A2a 中文"比价" 35 天 → 冷', coldStats.coldCustomers.some((s) => s.includes('wx_c1') && s.includes('比价')))
  ok('A2b won 不冷', !coldStats.coldCustomers.some((s) => s.includes('wx_c2')))
  ok('A2c lost 不冷', !coldStats.coldCustomers.some((s) => s.includes('wx_c3')))
  ok('A2d unknown 不冷', !coldStats.coldCustomers.some((s) => s.includes('wx_c4')))
  ok('A2e 冷数统计一致', coldStats.coldCount === 1)

  // ── A3 放弃：沉默 >60 天且未成交未流失 ─────────────────────────────────────
  const dropCust = [
    customer('wx_d1', 'contacted', 65),     // 65 天 → 冷 + 放弃
    customer('wx_d2', 'won', 90),           // 90 天 won → 不放弃
    customer('wx_d3', 'quoted', 20)         // 20 天 → 都不触发
  ]
  const dropStats = computeWeeklyReviewStats(dropCust, intentOpts({}))
  ok('A3a 65 天 contacted → 放弃', dropStats.dropCandidates.includes('wx_d1'))
  ok('A3b 90 天 won → 不放弃', !dropStats.dropCandidates.includes('wx_d2'))
  ok('A3c 20 天 → 不放弃', !dropStats.dropCandidates.includes('wx_d3'))
  ok('A3d 放弃数统计一致', dropStats.dropCount === 1)

  // ── A4 阶段分布：中英混合归一化 + 活跃明细 + 管道数 ──────────────────────
  const distCust = [
    customer('wx_e1', '比价', 2),           // 中文 → quoted
    customer('wx_e2', 'quoted', 1),         // 英文 → quoted（合并）
    customer('wx_e3', '了解', 1),           // 中文 → contacted
    customer('wx_e4', 'won', 10)
  ]
  const distStats = computeWeeklyReviewStats(distCust, intentOpts({}))
  ok('A4a 中英"比价/quoted"归一合并', distStats.stageCounts.quoted === 2)
  ok('A4b 中文"了解"→contacted', distStats.stageCounts.contacted === 1)
  ok('A4c won 计入阶段分布', distStats.stageCounts.won === 1)
  ok('A4d 管道数排除 won/lost', distStats.pipelineTotal === 3)
  ok('A4e 活跃客户明细（本周有互动，10 天前不算本周）', distStats.activeCount === 3 && distStats.activeCustomers.length === 3)

  // ── B 非客户过滤 ────────────────────────────────────────────────────────────
  const contactMessages = new Map<string, number>([
    ['wx_a', 100],  // 非客户，最高消息量 → 应被剔除
    ['wx_b', 50],   // account 命中 → 保留
    ['wx_c', 10]    // profile 命中 → 保留
  ])
  const accountMap = { wx_b: { id: 1, name: 'B公司' } }
  const profileMap = new Map<string, CustomerProfile>([['wx_c', customer('wx_c', 'contacted', 1)]])
  const filtered = filterCustomerSessions(contactMessages, accountMap, profileMap)
  ok('B1 非客户（最高消息量）被剔除', !filtered.topSessions.includes('wx_a'))
  ok('B2 account 命中保留', filtered.topSessions.includes('wx_b'))
  ok('B3 profile 命中保留', filtered.topSessions.includes('wx_c'))
  ok('B4 活跃客户数=命中数', filtered.activeContacts === 2)

  // 排序：多客户会话按消息量倒序
  const sortMsgs = new Map<string, number>([['wx_x', 5], ['wx_y', 9], ['wx_z', 3]])
  const sortFiltered = filterCustomerSessions(sortMsgs, { wx_x: { id: 2, name: 'X' }, wx_y: { id: 3, name: 'Y' }, wx_z: { id: 4, name: 'Z' } }, new Map())
  ok('B5 topSessions 按消息量倒序', JSON.stringify(sortFiltered.topSessions) === JSON.stringify(['wx_y', 'wx_x', 'wx_z']))

  // ── C intentBefore/intentHistory 集成冒烟（created_at 由 db 自动取 Date.now）────
  void (async () => {
    const dir = mkdtempSync(join(tmpdir(), 'report-review-'))
    const { salesDbService } = await import('../electron/services/salesDbService')
    await salesDbService.initialize(dir)
    salesDbService.customerUpsert({ session_id: 'wx_base', display_name: '基线客户', stage: 'quoted' })
    salesDbService.intentCreate({ session_id: 'wx_base', stage: 'contacted', source: 'ai', confidence: 0.7, reason: '第一条' })
    salesDbService.intentCreate({ session_id: 'wx_base', stage: 'quoted', source: 'ai', confidence: 0.8, reason: '第二条' })
    // 未来时间戳 → 返回最新一条（created_at < ts 的倒序首条）
    const future = salesDbService.intentBefore('wx_base', Date.now() + 10_000)
    const latest = salesDbService.intentGetLatest('wx_base')
    const history = salesDbService.intentHistory('wx_base', 10)
    ok('C1 intentBefore 时间过滤返回最新记录', future?.stage === 'quoted')
    ok('C2 intentGetLatest 返回最新阶段', latest?.stage === 'quoted')
    ok('C3 intentHistory 按时间倒序', history.length === 2 && history[0].stage === 'quoted' && history[1].stage === 'contacted')
    await import('fs').then((fs) => fs.rmSync(dir, { recursive: true, force: true }))

    console.log(`结果：${pass} 通过 / ${fail} 失败`)
    process.exit(fail > 0 ? 1 : 0)
  })()
}

main()
