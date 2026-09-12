/**
 * insight-unnamed-session-test.ts —— 无名 session 不得进见解链 + 自动链路删除护栏
 *
 * 历史背景（2026-08-24）：为防观察期再次污染 customer_event，两处扫描门控落地——
 *   ① 沉默扫描（silence scan）：salesDb 无客户档案（customerGetBySession 为空）→ continue
 *   ② 活跃分析 blacklist 模式：同上 → continue（whitelist 为用户显式配置，不受影响）
 *
 * 现状（2026-09-12，PRD《AI简报与按需识别》§5.4 / R）：承载上述两处门控的**自动链路已整体删除**——
 * 沉默扫描、活跃会话分析、催办识别均不复存在，见解服务不再监听 DB 变更、不再定时扫描。
 * 因此本文件断言改为两条：
 *   A. 删除结果锁定（不得复活无人触发的自动链路）+ 门控不因删除而"看起来达标"；
 *   B. 仍在生效的历史护栏：isSessionIdLike 的调用形式（模块函数不走 this）。
 *
 * 无名 session 污染的原风险源是「扫描器自己挑会话」；自动链路删除后见解入口全部由用户显式指定客户，
 * 该风险面消失。**这不等于门控可以放松**：若将来重新引入任何扫描类入口，必须同时带回客户档案门控。
 *
 * 运行：npx tsx scripts/insight-unnamed-session-test.ts
 */
import { readFileSync } from 'fs'
import { join } from 'path'

let pass = 0, fail = 0
function ok(name: string, cond: boolean): void {
  if (cond) { pass++ } else { fail++; console.error('FAIL:', name) }
}

const ROOT = join(__dirname, '..')
const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

async function main(): Promise<void> {
  const src = readFileSync(join(ROOT, 'electron/services/insightService.ts'), 'utf8')
  const code = strip(src)

  // ── A 自动链路删除结果锁定（PRD §5.4：无人触发不得调模型）──────────────────
  ok('a1 沉默扫描已删除（runSilenceScan 不复存在）', !code.includes('runSilenceScan'))
  ok('a2 活跃会话分析已删除（analyzeRecentActivity 不复存在）', !code.includes('analyzeRecentActivity'))
  ok('a3 催办识别已删除（scanUrgeFollowUps 不复存在）', !code.includes('scanUrgeFollowUps'))
  ok('a4 无 lastSeenTimestamp 内存游标（已由持久化 ai_scan_cursor 取代）',
    !code.includes('lastSeenTimestamp'))
  ok('a5 不再注册 DB 变更监听 / 定时器（无 setInterval 自动扫描）',
    !/this\.dbMonitor|dbDebounceTimer|silenceScanTimer/.test(code))
  ok('a6 不再把新消息事件自动分派给阶段分类器', !code.includes('actionStageClassifier'))
  ok('a7 无客户档案门控是「删除」而非「失效」：不得留下半截判定',
    !/if \(!hasProfile\) continue/.test(code) && !/if \(!profile\) continue/.test(code))

  // ── B 仍在生效的历史护栏 ─────────────────────────────────────────────────
  // isSessionIdLike 是模块级函数（shared/wechatId），零 this. 前缀调用
  // （运行时 TypeError 回归护栏：曾致活跃分析整链报错 this.isSessionIdLike is not a function）
  ok('b1 零 this.isSessionIdLike 调用（模块函数不走 this）', !/this\.isSessionIdLike/.test(src))
  ok('b2 仍以模块函数形式调用 isSessionIdLike', /!isSessionIdLike\(/.test(code))

  console.log(`insight-unnamed-session-test: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

void main()
