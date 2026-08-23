/**
 * intent-score-test.ts —— 意向评分 0-100 单测（P0-2A.1：intentScore 两个 bug 修复）
 * 覆盖：
 *   bug1  STAGE_BASE 键改 canonical + 输入过 normalizeStage：
 *         英文 canonical / 中文档位 → 同一基础分（quoted=60 / negotiating=80 / won=100 / contacted=30）
 *   bug2  customer_profile.last_contact_at（秒）→ computeIntentScore（毫秒）转换：decay 不再恒为 30
 * 运行：npx tsx scripts/intent-score-test.ts
 */
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { salesDbService } from '../electron/services/salesDbService'
import { computeIntentScore } from '../electron/services/intentScore'

let pass = 0, fail = 0
function ok(name: string, cond: boolean): void {
  if (cond) { pass++ } else { fail++; console.error('FAIL:', name) }
}

/** 只测阶段基础分（无活跃/衰减/商机干扰） */
function baseOnly(stage: string): { score: number; base: number } {
  const r = computeIntentScore({ stage, lastContactAt: 0, recentEventCount: 0, lastEventAt: 0, oppCount: 0, oppQuantity: 0, oppAmount: 0 })
  return { score: r.score, base: r.factors.find((f) => f.label === '当前阶段')?.delta ?? 0 }
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'intent-score-'))
  await salesDbService.initialize(dir)

  // ── bug1：canonical 键 + normalizeStage（英文 canonical / 中文档位 → 同一基础分）────────────
  ok('1a 英文 quoted → 60', baseOnly('quoted').score === 60)
  ok('1b 中文 比价 → 60', baseOnly('比价').score === 60)
  ok('1c 英文 negotiating → 80', baseOnly('negotiating').score === 80)
  ok('1d 中文 决策 → 80', baseOnly('决策').score === 80)
  ok('1e 英文 won → 100', baseOnly('won').score === 100)
  ok('1f 中文 成交 → 100', baseOnly('成交').score === 100)
  ok('1g 英文 contacted → 30', baseOnly('contacted').score === 30)
  ok('1h 中文 了解 → 30', baseOnly('了解').score === 30)
  ok('1i 英文 new → 0（无基础分）', baseOnly('new').score === 0)
  ok('1j 中文 新客 → 0', baseOnly('新客').score === 0)
  ok('1k 流失 lost/流失 → 5', baseOnly('lost').score === 5 && baseOnly('流失').score === 5)
  ok('1l unknown/未知 → 0（异常位，不进漏斗）', baseOnly('unknown').score === 0 && baseOnly('未知').score === 0)
  ok('1m 中文档位与英文 canonical 基础分等价', baseOnly('比价').base === baseOnly('quoted').base && baseOnly('决策').base === baseOnly('negotiating').base && baseOnly('成交').base === baseOnly('won').base)

  // ── bug2：秒 → 毫秒（经 salesDbService.intentScore 集成，真实 last_contact_at 为秒）──
  // 2 天前联系（秒）：quoted 60 分，14 天内无衰减
  salesDbService.customerUpsert({ session_id: 'wx_d2', display_name: '两天前', stage: 'quoted', last_contact_at: Math.floor(Date.now() / 1000) - 2 * 86400 })
  const r2 = salesDbService.intentScore('wx_d2', { count: 0, quantity: 0, amount: 0 })
  ok('2a 联系 2 天前（秒）无衰减，quoted=60', !!r2 && r2.score === 60 && !r2.factors.some((f) => f.label === '久未跟进'))

  // 40 天前联系（秒）：衰减 -30（封顶），quoted → 30
  salesDbService.customerUpsert({ session_id: 'wx_d40', display_name: '四十天前', stage: 'quoted', last_contact_at: Math.floor(Date.now() / 1000) - 40 * 86400 })
  const r40 = salesDbService.intentScore('wx_d40', { count: 0, quantity: 0, amount: 0 })
  ok('2b 联系 40 天前（秒）衰减 -30，quoted=30', !!r40 && r40.score === 30 && r40.factors.some((f) => f.label === '久未跟进' && f.delta === -30))

  // 10 天前联系（秒）：14 天内无衰减，contacted=30
  salesDbService.customerUpsert({ session_id: 'wx_d10', display_name: '十天前', stage: 'contacted', last_contact_at: Math.floor(Date.now() / 1000) - 10 * 86400 })
  const r10 = salesDbService.intentScore('wx_d10', { count: 0, quantity: 0, amount: 0 })
  ok('2c 联系 10 天前（秒）无衰减，contacted=30', !!r10 && r10.score === 30)

  // 中文 stage 客户也归一（manual 纠正写中文 决策），且秒衰减正确
  salesDbService.customerUpsert({ session_id: 'wx_zh', display_name: '中文客户', stage: '决策', last_contact_at: Math.floor(Date.now() / 1000) - 2 * 86400 })
  const rzh = salesDbService.intentScore('wx_zh', { count: 0, quantity: 0, amount: 0 })
  ok('2d 中文 决策 + 2 天前（秒）→ 80（归一 + 无衰减）', !!rzh && rzh.score === 80)

  console.log(`\nintent-score-test: ${pass}/${pass + fail} 通过`)
  process.exit(fail > 0 ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
