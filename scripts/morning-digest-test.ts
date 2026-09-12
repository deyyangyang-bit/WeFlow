/**
 * morning-digest-test.ts —— 早间简报单测（PRD《AI简报与按需识别》§5.1 / §6.1）
 *
 * 覆盖：
 *  a. 时间窗纯函数（历史接口保留）
 *  b. 事实版降级：**保留全部信号**（不再 top3）、正文口径、空态不假装分析过
 *  c. 「可选 AI 整理」关闭 → parseAiDigest 恒 null，调用方走事实版
 *  d. 六态裁决穷举（顺序即优先级；失败/阻断永远压过「看起来没事」）
 *  e. 文案纪律：任何状态都不得出现「无风险 / 无需跟进 / 全部跟完」
 *  f. 落库往返 + 同日幂等 + regenerate 覆盖 + 同日仅一行
 * 运行：npx tsx scripts/morning-digest-test.ts
 */
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// 隔离落盘路径（必须在 import 前设置）
const isoDir = mkdtempSync(join(tmpdir(), 'morning-digest-'))
process.env.WEFLOW_USER_DATA_PATH = isoDir
process.env.WEFLOW_CONFIG_CWD = isoDir

let pass = 0, fail = 0
function ok(name: string, cond: boolean): void {
  if (cond) { pass++ } else { fail++; console.error('FAIL:', name) }
}

import {
  buildFallbackDigest, parseAiDigest, isInDigestWindow, buildDigestPrompt, morningDigestService, __testing,
  type MorningDigest, type DigestState
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

/** 六态裁决的入参工厂：只覆盖要断言的那一维 */
function stateOf(over: Partial<Parameters<typeof __testing.decideState>[0]>): DigestState {
  return __testing.decideState({
    aiConfigured: true, scanFailed: false, blocked: false, hasChat: true, itemCount: 1, partial: false, ...over
  })
}

/** 文案纪律：这些词一律不得出现（PRD §6.1 / §7.3） */
const BANNED = ['无风险', '无需跟进', '全部跟完', '🎉']

function assertNoBannedWords(name: string, text: string): void {
  const hit = BANNED.find((word) => text.includes(word))
  ok(`${name}（不得含「${hit || ''}」）`, !hit)
}

function main(): void {
  // ── a 时间窗（历史接口保留；开工入口不再要求此时段在线）─────────────────────
  const at = (h: number, m: number): Date => new Date(2026, 8, 5, h, m, 0)
  ok('a1 08:04 不在窗内', !isInDigestWindow(at(8, 4)))
  ok('a2 08:05 在窗内', isInDigestWindow(at(8, 5)))
  ok('a3 08:10 在窗内', isInDigestWindow(at(8, 10)))
  ok('a4 08:35 不在窗内', !isInDigestWindow(at(8, 35)))
  ok('a5 09:00 不在窗内', !isInDigestWindow(at(9, 0)))

  // ── b 事实版：保留全部信号，不做结论 ──────────────────────────────────────
  const sigs = [
    mkSignal({ sessionId: 'wx_a', displayName: '客户A', priorityScore: 130 }),
    mkSignal({ sessionId: 'wx_b', displayName: '客户B', priorityScore: 120 }),
    mkSignal({ sessionId: 'wx_c', displayName: '客户C', priorityScore: 110 }),
    mkSignal({ sessionId: 'wx_d', displayName: '客户D', priorityScore: 100 }),
    mkSignal({ sessionId: 'wx_e', displayName: '客户E', priorityScore: 90 })
  ]
  const fb = buildFallbackDigest(sigs, '2026-09-05')
  ok('b1 全部信号保留（不再 top3）', fb.items.length === 5)
  ok('b2 事项理由来自规则原文', fb.items.some((it) => it.reason.includes('谈判中 3 天未互动')))
  ok('b3 正文按条数报事实', fb.text.includes('当前 5 个业务事项'))
  ok('b4 事实版标记 aiUsed=false', fb.aiUsed === false)
  assertNoBannedWords('b5 事实版正文不含结论词', fb.text)
  const fbEmpty = buildFallbackDigest([], '2026-09-05')
  ok('b6 空信号不假装分析过', fbEmpty.items.length === 0 && fbEmpty.text.includes('尚未核验'))
  ok('b7 事实版不携带 coverage（六态由 buildDigest 装配）', fb.coverage === undefined)
  const fbMust = buildFallbackDigest([mkSignal({ dueAt: Date.parse('2026-09-05T10:00:00') })], '2026-09-05')
  ok('b8 已到期事项归入 must', fbMust.items[0].group === 'must')

  // ── c 「可选 AI 整理」关闭 ────────────────────────────────────────────────
  ok('c1 parseAiDigest 恒 null（不发起调用）',
    parseAiDigest('wx_a|任何文本', sigs, '2026-09-05') === null)
  const prompt = buildDigestPrompt(sigs)
  ok('c2 提示词只有「会话|理由」清单、不含聊天原文',
    prompt.split('\n').length === sigs.length && prompt.includes('wx_a|') && !prompt.includes('聊天'))

  // ── d 六态裁决穷举（顺序即优先级）─────────────────────────────────────────
  ok('d1 阻断优先于一切', stateOf({ blocked: true, itemCount: 0, hasChat: false }) === 'failed_or_blocked')
  ok('d2 阻断优先于有事项', stateOf({ blocked: true, itemCount: 9 }) === 'failed_or_blocked')
  ok('d3 扫描失败压过有事项', stateOf({ scanFailed: true, itemCount: 9 }) === 'failed_or_blocked')
  ok('d4 未配 AI 但有事实 → crm_only', stateOf({ aiConfigured: false, itemCount: 3 }) === 'crm_only')
  ok('d5 未配 AI 有聊天无事实 → failed_or_blocked（不许说没事）',
    stateOf({ aiConfigured: false, hasChat: true, itemCount: 0 }) === 'failed_or_blocked')
  ok('d6 未配 AI 无聊天无事实 → empty_account',
    stateOf({ aiConfigured: false, hasChat: false, itemCount: 0 }) === 'empty_account')
  ok('d7 有 AI 无聊天有事实 → crm_only',
    stateOf({ hasChat: false, itemCount: 2 }) === 'crm_only')
  ok('d8 有 AI 无聊天无事实 → empty_account',
    stateOf({ hasChat: false, itemCount: 0 }) === 'empty_account')
  ok('d9 有 AI 有聊天有事实 → pending_data', stateOf({ itemCount: 4 }) === 'pending_data')
  // d9b/d9c 复核修复（2026-09-12）：crm_only 的文案不得在「有聊天」时反着说
  // （decideState 的 !aiConfigured 分支不看 hasChat，竞态下可能仍有聊天数据）
  ok('d9b 未配 AI 但有聊天 → crm_only 文案不得声称「暂无聊天数据」',
    !__testing.crmOnlyMessage(3).includes('暂无聊天数据') && __testing.crmOnlyMessage(3).includes('未配置 AI'))
  ok('d9c 未配 AI 且确无聊天 → 明确「暂无聊天数据」', __testing.crmOnlyMessage(0).includes('暂无聊天数据'))
  assertNoBannedWords('d9d crm_only 文案不含结论词',
    `${__testing.crmOnlyMessage(0)} ${__testing.crmOnlyMessage(3)}`)
  ok('d10 有 AI 有聊天无事实但被截断 → failed_or_blocked（不许说清空）',
    stateOf({ itemCount: 0, partial: true }) === 'failed_or_blocked')
  ok('d11 全覆盖且无事项 → all_covered_clear',
    stateOf({ itemCount: 0, partial: false }) === 'all_covered_clear')

  // ── e 覆盖区间文案：未知就说未知，不含糊 ──────────────────────────────────
  ok('e1 区间双空 → 覆盖区间未知', __testing.rangeText(null, null) === '覆盖区间未知')
  ok('e2 仅起点 → 明确标未知', __testing.rangeText(1757000000, null).includes('未知'))
  assertNoBannedWords('e3 区间文案不含结论词', __testing.rangeText(1757000000, 1757100000))

  // ── f 落库 + 同日幂等（异步）──────────────────────────────────────────────
  void (async (): Promise<void> => {
    const dir = mkdtempSync(join(tmpdir(), 'morning-digest-db-'))
    await crmDbService.initialize(dir)
    await salesDbService.initialize(dir)
    // 未注入 config（setConfig 不调）→ 必走「未配置 AI」分支；空库 0 信号 → empty_account
    const d1: MorningDigest = await morningDigestService.regenerateToday()
    ok('f1 空库生成空态六态', d1.coverage?.state === 'empty_account')
    ok('f2 空态正文不假装分析过', d1.text.includes('暂无'))
    assertNoBannedWords('f3 空态文案合规', `${d1.text} ${d1.coverage?.message || ''}`)

    const read1 = morningDigestService.getLatestDigest()
    ok('f4 落库可读回且 coverage 保留', !!read1 && read1.coverage?.state === 'empty_account')

    const d2 = await morningDigestService.generateTodayDigest()
    ok('f5 同日 generate 幂等（返回既有快照）', d2.createdAt === read1!.createdAt)
    const rowsAfterGen = salesDbService.reportList(50).filter((r) => r.period_type === 'morning_digest')
    ok('f6 同日仅一行', rowsAfterGen.length === 1)

    const d3 = await morningDigestService.regenerateToday()
    const rowsAfterRegen = salesDbService.reportList(50).filter((r) => r.period_type === 'morning_digest')
    ok('f7 regenerate 覆盖旧行（行数不变、时间前移）',
      rowsAfterRegen.length === 1 && d3.createdAt >= d1.createdAt)
    ok('f8 未配 AI 时不产生 AI 调用（aiUsed=false）', d3.aiUsed === false)

    // ─── g. 启动竞态：未就绪必须是可区分的「加载态」，不是错误、也不是空态 ───────
    {
      const mainSrc = readFileSync(join(__dirname, '..', 'electron/main.ts'), 'utf8')
      const pageSrc = readFileSync(join(__dirname, '..', 'src/pages/TodayActionPage.tsx'), 'utf8')
      ok('g1 getLatestDigest 未就绪仍抛错（服务层不静默返回空）',
        /getLatestDigest\(\): MorningDigest \| null \{\s*\n\s*if \(!salesDbService\.isInitialized\(\)\) throw new Error\('业务库尚未就绪，请稍后重试'\)/.test(
          readFileSync(join(__dirname, '..', 'electron/services/morningDigestService.ts'), 'utf8')))
      ok('g2 IPC 未就绪改返 notReady（不再抛 IPC 错误）',
        /if \(!salesDbService\.isInitialized\(\)\) return \{ ok: true, data: null, notReady: true \}/.test(mainSrc))
      ok('g3 前端把 notReady 与「无快照」分开处理（不落 error、不置 ready）',
        /if \(res\?\.notReady\) \{ setDigestNotReady\(true\); setDigestError\(''\); return \}/.test(pageSrc) &&
        /setDigestNotReady\(false\)\n\s*setDigest\(res\?\.ok \? res\.data : null\)/.test(pageSrc))
      ok('g4 10s 超时不把「未就绪」说成「生成超时」',
        /digestNotReady\s*\n?\s*\? '业务库尚未就绪（正在打开当前账号数据），暂无简报。'/.test(pageSrc))
      ok('g5 120s 时间预算状态机保留（300ms/2s/10s，未就绪不越权置 ready）',
        /setTimeout\(\(\) => setDigestPhase\(p => \(p === 'frame' \? 'local' : p\)\), 300\)/.test(pageSrc) &&
        /2_000\)/.test(pageSrc) && /10_000\)/.test(pageSrc))
      // 收起态重开入口：样式与 crm-btn 同族，且「不可当作已核对」的两态都带在按钮上
      const scss = readFileSync(join(__dirname, '..', 'src/pages/TodayActionPage.scss'), 'utf8')
      ok('g6 收起后可重开，且按钮标注阻断/降级态',
        /className="crm-btn signal-notice--digest-reopen"/.test(pageSrc) &&
        /\? '（有未完成分析）'/.test(pageSrc) && /\? '（仅旧快照）'/.test(pageSrc))
      ok('g7 重开按钮样式落在本页 SCSS（crm-btn 族 + 蓝主色，不新造样式表）',
        /&--digest-reopen \{[\s\S]*?border-color: var\(--color-accent-border\);[\s\S]*?\}/.test(scss))
    }

    console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
    process.exit(fail > 0 ? 1 : 0)
  })().catch((e) => { console.error('FAIL: 异步部分异常', e); process.exit(1) })
}

main()
