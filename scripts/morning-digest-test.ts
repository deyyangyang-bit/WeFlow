/**
 * morning-digest-test.ts —— 晨间摘要单测（设计-AI见解重定位 §3.1，阶段二 a）
 * 覆盖：
 *  a. 时间窗纯函数：08:05-08:35 内才生成（08:04 否 / 08:10 是 / 08:35 否 / 09:00 否）
 *  b. 降级路径：无 AI 时 buildFallbackDigest 取 priorityScore top3 + 规则理由；空信号 → 空态
 *  c. AI 输出解析：合法行解析、幻觉 sessionId 过滤、全不匹配 → null（走降级）
 *  d. 落库往返 + 同日幂等：generate 同日第二次直接返回不新建；regenerate 覆盖旧行（计数不变）
 * 运行：WEFLOW_WORKER=1 npx tsx scripts/morning-digest-test.ts
 */
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// 隔离 insightRecordService 与 config 的落盘路径（必须在 import 前设置）
const isoDir = mkdtempSync(join(tmpdir(), 'morning-digest-'))
process.env.WEFLOW_USER_DATA_PATH = isoDir
process.env.WEFLOW_CONFIG_CWD = isoDir

let pass = 0, fail = 0
function ok(name: string, cond: boolean): void {
  if (cond) { pass++ } else { fail++; console.error('FAIL:', name) }
}

import {
  buildFallbackDigest, parseAiDigest, isInDigestWindow, buildDigestPrompt, morningDigestService,
  type MorningDigest
} from '../electron/services/morningDigestService'
import type { UnifiedSignal } from '../electron/services/salesActionEngine'
import { crmDbService } from '../electron/services/crmDbService'
import { salesDbService } from '../electron/services/salesDbService'

function mkSignal(over: Partial<UnifiedSignal>): UnifiedSignal {
  return {
    sessionId: 'wx_test', displayName: '测试客户', stage: 'negotiating', silentDays: 3,
    sources: [{ type: 'task', ruleCode: 'rule_r2', label: '谈判停滞', reason: '谈判中 3 天未互动', rawTaskId: 1 }],
    priorityScore: 100, urgencyTier: 'high', status: 'pending', ...over
  }
}

function main(): void {
  // ── a 时间窗 ──────────────────────────────────────────────────────────────
  const at = (h: number, m: number): Date => new Date(2026, 8, 5, h, m, 0)
  ok('a1 08:04 不生成', !isInDigestWindow(at(8, 4)))
  ok('a2 08:05 生成', isInDigestWindow(at(8, 5)))
  ok('a3 08:10 生成', isInDigestWindow(at(8, 10)))
  ok('a4 08:35 不生成', !isInDigestWindow(at(8, 35)))
  ok('a5 09:00 不生成', !isInDigestWindow(at(9, 0)))

  // ── b 降级路径 ────────────────────────────────────────────────────────────
  const sigs = [
    mkSignal({ sessionId: 'wx_a', displayName: '客户A', priorityScore: 130 }),
    mkSignal({ sessionId: 'wx_b', displayName: '客户B', priorityScore: 120 }),
    mkSignal({ sessionId: 'wx_c', displayName: '客户C', priorityScore: 110 }),
    mkSignal({ sessionId: 'wx_d', displayName: '客户D', priorityScore: 100 }),
    mkSignal({ sessionId: 'wx_e', displayName: '客户E', priorityScore: 90 })
  ]
  const fb = buildFallbackDigest(sigs, '2026-09-05')
  ok('b1 降级取 top3', fb.items.length === 3 && fb.items[0].sessionId === 'wx_a' && fb.items[2].sessionId === 'wx_c')
  ok('b2 降级理由来自规则', fb.items[0].reason.includes('谈判中 3 天未互动'))
  ok('b3 降级正文含客户名', fb.text.includes('客户A') && fb.text.includes('3 位客户'))
  ok('b4 降级标记 aiUsed=false', fb.aiUsed === false)
  const fbEmpty = buildFallbackDigest([], '2026-09-05')
  ok('b5 空信号空态', fbEmpty.items.length === 0 && fbEmpty.text.includes('无待跟进'))

  // ── c AI 输出解析 ─────────────────────────────────────────────────────────
  const aiText = 'wx_b|报价发出 3 天未回，今天不追就凉了\nwx_a|谈判停滞，竞对可能在接触\nwx_d|沉默 20 天但有改装需求'
  const parsed = parseAiDigest(aiText, sigs, '2026-09-05')
  ok('c1 AI 解析 3 条', !!parsed && parsed.items.length === 3 && parsed.aiUsed === true)
  ok('c2 AI 顺序按输出而非分数', parsed!.items[0].sessionId === 'wx_b')
  ok('c3 displayName 取信号真名', parsed!.items[0].displayName === '客户B')
  const hallucinated = parseAiDigest('wx_ghost|不存在的客户\nwx_a|正常理由', sigs, '2026-09-05')
  ok('c4 幻觉 sessionId 被过滤', !!hallucinated && hallucinated.items.length === 1 && hallucinated.items[0].sessionId === 'wx_a')
  ok('c5 全不匹配 → null 走降级', parseAiDigest('wx_ghost|x\nwx_ghost2|y', sigs, '2026-09-05') === null)
  ok('c6 垃圾文本 → null', parseAiDigest('抱歉我无法完成', sigs, '2026-09-05') === null)
  ok('c7 prompt 不含聊天原文（只含卡片清单）', buildDigestPrompt(sigs).includes('sessionId=wx_a') && !buildDigestPrompt(sigs).includes('聊天'))

  // ── d 落库 + 同日幂等（异步部分）──────────────────────────────────────────
  void (async (): Promise<void> => {
    const dir = mkdtempSync(join(tmpdir(), 'morning-digest-db-'))
    await crmDbService.initialize(dir)
    await salesDbService.initialize(dir)
    // 无 AI 配置（setConfig 不调）→ 必走降级；空库 0 信号 → 空态
    const d1: MorningDigest = await morningDigestService.regenerateToday()
    ok('d1 空库生成空态摘要', d1.items.length === 0 && d1.aiUsed === false && d1.text.includes('无待跟进'))
    const read1 = morningDigestService.getLatestDigest()
    ok('d2 落库可读回', !!read1 && read1.items.length === 0 && read1.text === d1.text)
    const d2 = await morningDigestService.generateTodayDigest()
    ok('d3 同日 generate 幂等（返回既有，不新建）', d2.createdAt === read1!.createdAt)
    const rowsAfterGen = salesDbService.reportList(50).filter((r) => r.period_type === 'morning_digest')
    ok('d4 同日仅一行', rowsAfterGen.length === 1)
    const d3 = await morningDigestService.regenerateToday()
    const rowsAfterRegen = salesDbService.reportList(50).filter((r) => r.period_type === 'morning_digest')
    ok('d5 regenerate 覆盖旧行（计数不变）', rowsAfterRegen.length === 1 && d3.createdAt > d1.createdAt)

    console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
    process.exit(fail > 0 ? 1 : 0)
  })().catch((e) => { console.error('FAIL: 异步部分异常', e); process.exit(1) })
}

main()
