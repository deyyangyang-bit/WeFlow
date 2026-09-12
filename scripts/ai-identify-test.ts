/**
 * ai-identify-test.ts —— 「AI 识别这个客户」按钮 + 持久化游标 + 单飞 + 日上限单测
 * （PRD《AI简报与按需识别》§5.2 / §5.5 / §6.2）
 *
 * 覆盖：
 *  a. todoCreate 的 trigger_type 中立默认（漏传 → 'unknown'，不得被默认记成 'ai_detected'）
 *  b. 持久化游标 ai_scan_cursor：往返读写、单调只进不退、按 scope 隔离
 *  c. identifyCustomer 无新消息（有/无消息两路）→ noNewContent，**零模型调用**
 *  d. identifyCustomer 有新闻消息 → 透传给抽取层的 purpose/trigger/createdBy 全部合规
 *  e. 全局单飞：识别进行中所有入口被拒（identifyCoordinator）
 *  f. 日上限：80% 预警 / 达限阻断；刊例价未收录模型金额记 null 而非 0
 *  g. 额度闸门在没有真实调用的前提下可被独立验证（assertWithinBudget 纯逻辑 + 账本阻断行）
 *
 * 说明：抽取层（extractForSession）内部直接调用 aiApiClient 的模块级函数，
 * 无法在测试中打桩；因此 d 组用打桩的 extractForSession 验证**调用点契约**，
 * 真实抽取-落库路径由 c 组（短路）+ a 组（落库默认值）覆盖。
 *
 * 运行：npx tsx scripts/ai-identify-test.ts
 */
import { mkdtempSync, existsSync, readFileSync } from 'fs'
import { createHash } from 'crypto'
import { tmpdir } from 'os'
import { join } from 'path'

const isoDir = mkdtempSync(join(tmpdir(), 'ai-identify-'))
process.env.WEFLOW_USER_DATA_PATH = isoDir
process.env.WEFLOW_CONFIG_CWD = isoDir

let pass = 0, fail = 0
function ok(name: string, cond: boolean): void {
  if (cond) { pass++ } else { fail++; console.error('FAIL:', name) }
}

import { salesDbService } from '../electron/services/salesDbService'
import { salesFollowUpService, identifyCoordinator } from '../electron/services/salesFollowUpService'
import { wcdbService } from '../electron/services/wcdbService'
import { isAiConfigured } from '../electron/services/ai/aiApiClient'
import type { ConfigService } from '../electron/services/config'
import { evaluateBudget, estimateCost, priceFor, dailyUsage, WARN_RATIO } from '../electron/services/ai/aiBudget'
import { configureAiUsageLedger, recordBlockedCall, readAiUsage } from '../electron/services/ai/aiUsageLedger'

const DAY = 86_400
const nowSec = (): number => Math.floor(Date.now() / 1000)

/** 构造一条最小可用的 WCDB 消息（时间列沿用真实字段名 create_time，秒级） */
function mkMsg(createTimeSec: number): Record<string, unknown> {
  return { create_time: createTimeSec, is_send: 0, sender_username: 'wx_cust', content: '报价发我一下' }
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'ai-identify-db-'))
  await salesDbService.initialize(dir)

  // ── a trigger_type 中立默认 ───────────────────────────────────────────────
  const tA = salesDbService.todoCreate({ trigger_type: '', title: '漏传触发类型的待办', session_id: 'wx_a' } as never)
  const tB = salesDbService.todoCreate({ trigger_type: 'ai_detected', title: 'AI 识别产出的待办', session_id: 'wx_a', created_by: '王销售' } as never)
  const rows = salesDbService.todoList({})
  const rowA = rows.find((r) => r.id === tA.id)
  const rowB = rows.find((r) => r.id === tB.id)
  ok('a1 漏传 trigger_type → 中性 unknown（不伪装成 AI 识别）', rowA?.trigger_type === 'unknown')
  ok('a2 显式 ai_detected 原样保留', rowB?.trigger_type === 'ai_detected')
  ok('a3 created_by 记录产出者', rowB?.created_by === '王销售')

  // ── b 持久化游标 ──────────────────────────────────────────────────────────
  ok('b1 未写过的游标读回 0', salesDbService.cursorGet('manual', 'wx_never') === 0)
  salesDbService.cursorSet('manual', 'wx_a', 1_700_000_000)
  ok('b2 游标读写往返', salesDbService.cursorGet('manual', 'wx_a') === 1_700_000_000)
  salesDbService.cursorSet('manual', 'wx_a', 1_600_000_000)
  ok('b3 游标单调：旧时间被忽略（不回退）', salesDbService.cursorGet('manual', 'wx_a') === 1_700_000_000)
  salesDbService.cursorSet('manual', 'wx_a', 1_800_000_000)
  ok('b4 游标可前进', salesDbService.cursorGet('manual', 'wx_a') === 1_800_000_000)
  salesDbService.cursorSet('manual', 'wx_a', 0)
  salesDbService.cursorSet('manual', 'wx_a', -5)
  ok('b5 非正数不写假进度', salesDbService.cursorGet('manual', 'wx_a') === 1_800_000_000)
  salesDbService.cursorSet('digest', 'wx_a', 1_900_000_000)
  ok('b6 按 scope 隔离（digest 不污染 manual）',
    salesDbService.cursorGet('manual', 'wx_a') === 1_800_000_000 && salesDbService.cursorGet('digest', 'wx_a') === 1_900_000_000)
  ok('b7 cursorMap 批量读只含本 scope', !salesDbService.cursorMap('manual').has('wx_never') && salesDbService.cursorMap('digest').get('wx_a') === 1_900_000_000)

  // ── c/d identifyCustomer ──────────────────────────────────────────────────
  const cfg = { get: (k: string) => (k === 'aiModelApiBaseUrl' ? 'https://api.example.com' : k === 'aiModelApiKey' ? 'sk-test' : undefined) } as unknown as ConfigService
  ok('c0 前置：打桩配置被识别为已配置 AI', isAiConfigured(cfg))

  // 打桩 wcdb（对象单例，方法可覆盖——沿用仓库既有打桩风格）
  const wcdb = wcdbService as unknown as Record<string, unknown>
  const originals = {
    isConnected: wcdb.isConnected,
    getMessages: wcdb.getMessages
  }
  wcdb.isConnected = async () => true

  let extractCalls = 0
  let lastOpts: Record<string, unknown> | null = null
  const svc = salesFollowUpService as unknown as Record<string, unknown>
  const originalExtract = svc.extractForSession
  svc.extractForSession = async (_cfg: unknown, _sid: string, _name: string, opts: Record<string, unknown>) => {
    extractCalls++
    lastOpts = opts
    const msgs = (opts.messages || []) as Array<Record<string, unknown>>
    const latestSec = msgs.reduce((max, m) => Math.max(max, Number(m.create_time || m.createTime || 0)), 0)
    return { created: 2, latestSec, called: true }
  }

  // c1 空会话：无消息 → 无新内容，零调用
  extractCalls = 0
  wcdb.getMessages = async () => ({ success: true, messages: [] })
  const r1 = await salesFollowUpService.identifyCustomer(cfg, { sessionId: 'wx_empty' })
  ok('c1 无消息 → noNewContent 且零模型调用', r1.success && r1.noNewContent === true && extractCalls === 0)

  // c2 消息全在游标之前 → 无新内容，零调用
  extractCalls = 0
  const old = nowSec() - 3 * DAY
  wcdb.getMessages = async () => ({ success: true, messages: [mkMsg(old)] })
  salesDbService.cursorSet('manual', 'wx_old', nowSec() - DAY)
  const r2 = await salesFollowUpService.identifyCustomer(cfg, { sessionId: 'wx_old' })
  ok('c2 游标之后无新消息 → noNewContent 且零模型调用（不重复付费）',
    r2.success && r2.noNewContent === true && extractCalls === 0)

  // c3 首轮无游标、消息落在 7 天回看窗之外 → 无新内容，零调用
  extractCalls = 0
  wcdb.getMessages = async () => ({ success: true, messages: [mkMsg(nowSec() - 30 * DAY)] })
  const r3 = await salesFollowUpService.identifyCustomer(cfg, { sessionId: 'wx_ancient' })
  ok('c3 超出 7 天回看窗 → noNewContent 且零模型调用',
    r3.success && r3.noNewContent === true && extractCalls === 0)

  // d 有新消息 → 抽取层被调用，契约参数合规
  extractCalls = 0
  lastOpts = null
  const fresh = nowSec() - 60
  wcdb.getMessages = async () => ({ success: true, messages: [mkMsg(fresh)] })
  const r4 = await salesFollowUpService.identifyCustomer(cfg, { sessionId: 'wx_new', displayName: '张总' })
  ok('d1 有新消息 → 发起一次抽取', extractCalls === 1 && r4.success === true && r4.newTasks === 2)
  ok('d2 purpose = manual_identify（账本可归因）', lastOpts?.purpose === 'manual_identify')
  ok('d3 trigger = manual_button', lastOpts?.trigger === 'manual_button')
  ok('d4 created_by 非空（记当前销售）', typeof lastOpts?.createdBy === 'string' && String(lastOpts?.createdBy).length > 0)
  ok('d5 输入上界 = 7 天 / 30 条', lastOpts?.messageLimit === 30 && Number(lastOpts?.sinceSec) >= nowSec() - 7 * DAY - 5)
  ok('d6 latestAt 回传毫秒（供界面显示「刚刚更新」）', r4.latestAt === fresh * 1000)

  // 未配置 AI / 库未连接：early return，不发调用
  extractCalls = 0
  const rNoAi = await salesFollowUpService.identifyCustomer(
    { get: () => '' } as unknown as ConfigService, { sessionId: 'wx_new' })
  ok('d7 未配置 AI → 失败且零调用', rNoAi.success === false && extractCalls === 0)
  wcdb.isConnected = async () => false
  const rNoDb = await salesFollowUpService.identifyCustomer(cfg, { sessionId: 'wx_new' })
  ok('d8 微信库未连接 → 失败且零调用', rNoDb.success === false && extractCalls === 0)
  wcdb.isConnected = async () => true

  svc.extractForSession = originalExtract
  wcdb.isConnected = originals.isConnected
  wcdb.getMessages = originals.getMessages

  // ── e 全局单飞 ────────────────────────────────────────────────────────────
  ok('e1 空闲态不忙', identifyCoordinator.get().busy === false)
  const release = identifyCoordinator.acquire('identify', '张总')
  ok('e2 获取成功返回释放函数', typeof release === 'function')
  const busy = identifyCoordinator.get()
  ok('e3 进行中 busy=true 且带 kind/label', busy.busy && busy.kind === 'identify' && busy.label === '张总')
  ok('e4 进行中再获取被拒（全局单飞：所有入口一起禁用）', identifyCoordinator.acquire('identify', '李总') === null)
  ok('e5 简报入口同样被拒（跨入口共用一把锁）', identifyCoordinator.acquire('digest', '早间简报') === null)
  let notified = 0
  const unsub = identifyCoordinator.subscribe(() => { notified++ })
  release!()
  ok('e6 释放后回到空闲', identifyCoordinator.get().busy === false)
  ok('e7 订阅者收到释放广播', notified === 1)
  unsub()
  ok('e8 释放后可再次获取', identifyCoordinator.acquire('digest', '早间简报') !== null)

  // ── f 日上限与刊例价 ──────────────────────────────────────────────────────
  ok('f1 未收录模型无刊例价（返回 null，不臆造）', priceFor('deepseek-chat') === null)
  ok('f2 收录模型可查到价', priceFor('deepseek-flash') !== null)
  ok('f3 型号族前缀匹配（带日期后缀仍可计价）', priceFor('deepseek-flash-0912') !== null)
  ok('f4 未收录模型金额记 null（不得记 0）',
    estimateCost({ model: 'deepseek-chat', inputTokens: 1000, cachedInputTokens: 0, outputTokens: 500 }) === null)
  const priced = estimateCost({ model: 'deepseek-v4-pro', inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0 })
  ok('f5 收录模型按刊例价算（1M 输入 = 峰时 1.32 USD）', priced === 1.32)
  ok('f6 全 null token（阻断行）金额记 null',
    estimateCost({ model: 'deepseek-v4-pro', inputTokens: null, cachedInputTokens: null, outputTokens: null }) === null)

  ok('f7 未设上限 → off 不阻断', evaluateBudget(999, 0).level === 'off')
  ok('f8 未达 80% → ok', evaluateBudget(10, 60).level === 'ok')
  ok(`f9 达 ${WARN_RATIO * 100}% → warn`, evaluateBudget(48, 60).level === 'warn')
  ok('f10 达上限 → blocked', evaluateBudget(60, 60).level === 'blocked')
  ok('f11 超上限 → blocked 且 reason 含「上限」（界面据此判定额度类错误）',
    evaluateBudget(61, 60).level === 'blocked' && /额度|上限/.test(evaluateBudget(61, 60).message))
  ok('f12 预算判定不含金额依赖（未收录模型也能拦截）', evaluateBudget(60, 60).level === 'blocked')

  // ── g 账本阻断行 ──────────────────────────────────────────────────────────
  configureAiUsageLedger(isoDir, () => 'acc_test')
  recordBlockedCall('deepseek-v4-pro', { purpose: 'manual_identify', trigger: 'manual_button' }, '测试阻断')
  const ledger = readAiUsage()
  const blockedRow = ledger.find((r) => r.status === 'blocked')
  ok('g1 阻断行落账（额度事件可追溯）', !!blockedRow)
  ok('g2 阻断行 tokens 记 null 而非 0', blockedRow?.inputTokens === null && blockedRow?.outputTokens === null)
  ok('g3 阻断行保留 purpose/trigger（可归因到入口）',
    blockedRow?.purpose === 'manual_identify' && blockedRow?.trigger === 'manual_button')
  const daily = dailyUsage(ledger)
  ok('g4 阻断行计入 blockedCalls', daily.blockedCalls === 1 && daily.calls === 1)
  ok('g5 阻断行不计入计价（未收录也不虚增 unpriced）', daily.unpricedCalls === 0)
  ok('g6 账本文件确实落盘（原子写）',
    existsSync(join(isoDir, 'ai-usage'))
    && readFileSync(join(isoDir, 'ai-usage', `${createHash('sha256').update('acc_test').digest('hex')}.json`), 'utf8').includes('blocked'))

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  process.exit(fail > 0 ? 1 : 0)
}

main().catch((e) => { console.error('FAIL: 异常', e); process.exit(1) })
