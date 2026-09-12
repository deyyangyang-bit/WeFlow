/**
 * hermes-utility-test.ts —— 任务 3/4：Hermes UtilityProcess 动态集成测试
 *
 * 真实 fork Utility 子进程（electron/hermes/hermesUtilityEntry.ts，经 tsx + IPC shim 以
 * node child_process 模拟 Electron utilityProcess 通道）跑通 Main Manager ↔ Utility 全链路：
 *  - t1  ready + 协议 v1 握手（init 清单只含公开元数据四字段）
 *  - t2  start → 工具 → 模型 → complete 全链路 + 隐私（真实 sessionId 不进模型出站、
 *        不进 Utility 工具上下文之外任何面；跨进程消息零 messageKey；UI 证据经 Main
 *        锚点恢复原始 messageKey 本地回查能力）
 *  - t2b 任务文本 Main 脱敏后才下发（手机号/身份证/wxid/sessionId 不进 task.start；
 *        Utility 侧标签只通用；UI 快照保留原文）
 *  - t3  progress 顺序（planning → running → … → completed，快照结构合法）
 *  - t4  白名单外工具被拒（Utility 清单层 + Main 桥 re-validate 层：capabilityContextId
 *        不匹配 → forbidden；工具不在白名单 → not_whitelisted）
 *  - t5  畸形消息丢弃不致命；数值协议版本 ≠ 当前 → 立即 fail closed（kill + 不重启 +
 *        拒新任务）
 *  - t6  模型请求期间取消：Main abort 模型请求 + Utility 收 task.cancel
 *  - t7  工具执行期间取消：结果被丢弃（不登记证据、不产生完成步骤）
 *  - t8  第一次崩溃：自动重启并回到 ready（每应用生命周期至多一次）
 *  - t9  已收尾任务跨 Utility 重启恢复并可继续追问（checkpoint 还原证据表/对话；
 *        restore 不含 messageKey/handle，Main 锚点仍恢复原始 messageKey）
 *  - t10 运行中任务随崩溃置 failed/agent_unavailable（严禁回退旧进程内 Agent）
 *  - t11 第二次崩溃：fail closed → unavailable，startTask 拒绝
 *  - t12 shutdown：通知 → 退出，无孤儿进程；之后 startTask 拒绝
 *  - t13 静态红线：Utility 入口零禁用 import（electron/DB/AI/配置/队列/日志/旧服务壳）；
 *        main.ts 生产接线改走 Manager 且不再 import 旧进程内 Agent
 *  - t14 shutdown 等待在途宿主操作：模型请求被 abort；工具请求收尾前 shutdown 不返回
 *  - t15 child 亲和：崩溃重启后旧请求的延迟结果绝不发给新 child
 *  - t16 旧协议版本 child 上线 → 立即 fail closed（kill + 不重启 + unavailable 拒绝宿主执行）
 *  - t17 旧 child 迟到消息一律忽略（监听绑定 child/generation，含旧版本消息不误触 fail closed）
 *  - t18 上下文指纹（第三轮 P1-1）：身份姓名/角色/账号 wxid 任一变化 → 下一次 host.request
 *        拒绝（context_expired）+ 任务终止 failed/context_expired + capability 封禁；
 *        continue 拒绝复活；迟到 progress 不能覆盖终态
 *  - t19 指纹（真实 fork）：运行中变化 → 工具不再执行、任务 failed/context_expired；
 *        指纹原文/组件绝不进任何跨进程消息；新上下文新建任务正常完成
 *  - t20 取消终态 vs 迟到消息（P1-2）：cancel 后注入当前轮次 running/completed progress
 *        仍 cancelled；迟到 checkpoint 不进 checkpoint Map
 *  - t21 runId 轮次门禁（真实 fork）：continue 开第二轮后旧轮次 progress/checkpoint 迟到
 *        被拒；第二轮合法 progress 正常；未知 taskId 的 progress/checkpoint 被拒不凭空创建
 *  - t22 崩溃恢复后旧 runId 消息无法覆盖新状态（failed/agent_unavailable 保持）
 *  - t23 Main→Utility 出口扫描（P2）：毒化 goal/question 直呼 sendToUtility 拒发；
 *        调用点脱敏被删（maskText 恒等）时 startTask/continueTask 出口兜底拒发并立即
 *        failed/boundary_violation（不等宿主超时），日志只含 type/路径不含原值
 *  - t24 模型响应二次脱敏（真实 fork）：模型文本里的手机号/wxid 进 Utility 前脱敏
 *  - t25 出口兜底（模型响应脱敏被删 → 统一出口拒发 → boundary_violation 快速落定）+
 *        伪造 evidenceHandle 无法恢复 messageKey 锚点
 *  - t26 模型 await 期间指纹变化：原始模型结果不回 Utility、不进 UI
 *  - t30 工具 await 期间指纹变化：结果不回 Utility、不登记 evidenceHandle/anchor
 *  - t27 第二轮零新工具终态 checkpoint 带 runId=2，崩溃恢复后第三轮上下文完整
 *  - t28 cancel/get 回显合法 runId；旧轮次不取消/读取当前任务
 *  - t29 identity:set 回调主动失效 capability（并保留兼容的可选回调接口）
 *  - t31 failed/cancelled 每个 runId 仅发出一次终态 checkpoint
 *  - t32 打包资源缺失 fail-closed（任务4）：不 fork、不崩主程序、agent_missing 拒绝新任务
 *        （entryExists 缺省 existsSync 与注入式双路径验证）
 *  - t33 fail-closed 状态机：协议不一致后旧 child 迟到的合法 v2 ready 被丢弃（保持
 *        unavailable/protocol_mismatch），随后 exit 不自动重启、不消耗重启预算，
 *        新任务仍被拒 protocol_mismatch
 *  - t34 在途任务保留稳定失败原因：协议不一致发生时运行中任务终止为
 *        failed/protocol_mismatch + 共享人话文案（普通崩溃仍 agent_unavailable 由 t10/t11 覆盖）
 *  - t35 protocolCorrectionCount 按轮次重置：第一轮纠偏计数 1；continue 开第二轮无纠偏
 *        计数必须为 0；旧 runId 迟到快照不得污染新轮次
 *
 * 运行：npx tsx scripts/hermes-utility-test.ts
 */
import { fork, type ChildProcess } from 'child_process'
import { readFileSync } from 'fs'
import { join, resolve } from 'path'
import { fileURLToPath } from 'url'
import {
  createHermesUtilityManager
} from '../electron/hermes/hermesUtilityManager'
import type { HermesUtilityChild, HermesUtilityFork } from '../electron/hermes/hermesUtilityManager'
import { FRIENDLY_ERROR, type HermesCompletion, type HermesTask } from '../electron/services/hermesAgentCore'
import type { HermesToolDef, HermesToolResult } from '../electron/services/hermesToolRegistry'
import { registerIdentityIpcHandlers } from '../electron/services/identityIpcHandlers'
import { ConfigService } from '../electron/services/config'
import { HERMES_PROTOCOL_VERSION, type MainToUtilityMessage } from '../shared/hermesProtocol'
import { HERMES_ERROR_MESSAGES } from '../shared/hermesErrorMessages'

// ─── 断言计数 ────────────────────────────────────────────────────────────────

let pass = 0
let fail = 0

/** 断言：条件为真 */
function ok(cond: boolean, label: string): void {
  if (cond) { pass++; return }
  fail++
  throw new Error(`断言失败: ${label}`)
}

/** 断言：相等 */
function eq<T>(a: T, b: T, label: string): void {
  if (a === b) { pass++; return }
  fail++
  throw new Error(`断言失败: ${label}（期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}）`)
}

// ─── 测试基础设施 ─────────────────────────────────────────────────────────────

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..')
const ENTRY_TS = join(ROOT, 'electron', 'hermes', 'hermesUtilityEntry.ts')
const SHIM_CJS = join(ROOT, 'scripts', 'hermes-utility-child-shim.cjs')
const MAIN_TS = join(ROOT, 'electron', 'main.ts')
const VITE_TS = join(ROOT, 'vite.config.ts')

/** 等待条件成立（轮询；超时抛错） */
async function waitFor(label: string, fn: () => boolean, timeoutMs = 10000): Promise<void> {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error(`等待超时: ${label}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

/** 测试内 fork 的子进程记录（供崩溃模拟与孤儿检测） */
interface TrackedChild extends HermesUtilityChild {
  exited: boolean
}

/** Manager 实例（测试结束后统一 shutdown，防跨测试泄漏子进程） */
type Manager = ReturnType<typeof createHermesUtilityManager>
const openManagers: Manager[] = []

/** 测试 harness：真实 fork Utility 入口 + 双向消息记录窥视（sent=Main→Utility / received=Utility→Main） */
function makeHarness(): { forkProcess: HermesUtilityFork; children: TrackedChild[]; sent: unknown[]; received: unknown[] } {
  const children: TrackedChild[] = []
  const sent: unknown[] = []
  const received: unknown[] = []
  const forkProcess: HermesUtilityFork = (modulePath) => {
    const child: ChildProcess = fork(modulePath, [], {
      execArgv: ['--import', 'tsx', '--require', SHIM_CJS],
      env: { ...process.env, HERMES_UTILITY_IPC_SHIM: '1' }
    })
    const tracked: TrackedChild = {
      postMessage: (msg) => {
        sent.push(msg)
        try { child.send(msg) } catch { /* 子进程已退出 */ }
      },
      on: ((event: 'message' | 'exit', cb: (arg: never) => void) => {
        if (event === 'message') {
          child.on('message', (m) => { received.push(m); (cb as (m: unknown) => void)(m) })
        } else {
          child.on('exit', (code) => (cb as (code: number) => void)(code ?? -1))
        }
        return tracked
      }) as TrackedChild['on'],
      kill: () => { try { child.kill('SIGTERM') } catch { /* 已退出 */ } },
      exited: false
    }
    child.on('exit', () => { tracked.exited = true })
    children.push(tracked)
    return tracked
  }
  return { forkProcess, children, sent, received }
}

/** 假 child（不 fork 真进程；模拟旧协议版本 Utility 与旧进程迟到消息） */
interface FakeChild extends HermesUtilityChild {
  killed: boolean
  inbox: unknown[]
  emitMessage: (msg: unknown) => void
  emitExit: (code: number) => void
}

/** 假 fork 通道：每次 fork 产出一个可手动派发消息/退出的假 child */
function makeFakeFork(): { forkProcess: HermesUtilityFork; fakes: FakeChild[] } {
  const fakes: FakeChild[] = []
  const forkProcess: HermesUtilityFork = () => {
    const messageCbs: Array<(msg: unknown) => void> = []
    const exitCbs: Array<(code: number) => void> = []
    const fake: FakeChild = {
      postMessage: (msg) => { fake.inbox.push(msg) },
      on: ((event: 'message' | 'exit', cb: (arg: never) => void) => {
        if (event === 'message') messageCbs.push(cb as (msg: unknown) => void)
        else exitCbs.push(cb as (code: number) => void)
      }) as FakeChild['on'],
      kill: () => { fake.killed = true },
      killed: false,
      inbox: [],
      emitMessage: (msg) => { for (const cb of [...messageCbs]) cb(msg) },
      emitExit: (code) => { for (const cb of [...exitCbs]) cb(code) }
    }
    fakes.push(fake)
    return fake
  }
  return { forkProcess, fakes }
}

/** 建一个接好测试依赖的 Manager（configured=true / 假身份 / 稳定指纹 / 可注入模型与工具） */
function makeManager(
  harness: { forkProcess: HermesUtilityFork },
  opts?: {
    modelComplete?: HermesCompletion
    tools?: HermesToolDef[]
    contextFingerprint?: () => string
    maskText?: (s: string) => string
    maskId?: (s: string) => string
    log?: (level: 'WARN' | 'INFO' | 'ERROR', msg: string) => void
  }
): Manager {
  const mgr = createHermesUtilityManager({
    entryPath: ENTRY_TS,
    forkProcess: harness.forkProcess,
    configured: () => true,
    identity: () => ({ name: '王销售', role: 'sales' }),
    contextFingerprint: opts?.contextFingerprint ?? (() => 'test-fingerprint'),
    modelComplete: opts?.modelComplete,
    tools: opts?.tools,
    maskText: opts?.maskText,
    maskId: opts?.maskId,
    log: opts?.log,
    timings: { restartDelayMs: 200, shutdownGraceMs: 300 }
  })
  openManagers.push(mgr)
  return mgr
}

/** 模型脚本桩：按脚本顺序返回（tool_call / complete JSON 文本），记录每次调用 */
function makeScriptedModel(responses: string[]): { fn: HermesCompletion; calls: Array<{ messages: unknown; timeoutMs: number; signal: AbortSignal }> } {
  const calls: Array<{ messages: unknown; timeoutMs: number; signal: AbortSignal }> = []
  let i = 0
  const fn: HermesCompletion = (messages, timeoutMs, signal) => {
    calls.push({ messages: JSON.parse(JSON.stringify(messages)), timeoutMs, signal })
    const r = responses[Math.min(i, responses.length - 1)]
    i++
    return Promise.resolve(r)
  }
  return { fn, calls }
}

/** 门控模型桩：调用后挂起直到 releaseAll（模拟模型请求在途） */
function makeGatedModel(response: string): { fn: HermesCompletion; calls: Array<{ signal: AbortSignal }>; releaseAll: () => void } {
  const calls: Array<{ signal: AbortSignal }> = []
  const releases: Array<(v: string) => void> = []
  const fn: HermesCompletion = (messages, timeoutMs, signal) => new Promise<string>((res, rej) => {
    calls.push({ signal })
    signal.addEventListener('abort', () => rej(new Error('aborted')), { once: true })
    releases.push(res)
  })
  return { fn, calls, releaseAll: () => { while (releases.length) releases.shift()!(response) } }
}

const SEARCH_RESULT: HermesToolResult = {
  ok: true,
  data: { customers: [{ name: '张三', accountId: 5, messageKey: 'LOCAL::C:/db/test.db::wxid_secret001' }] },
  evidence: [{ label: '客户：张三', kind: 'customer', entityId: 5, messageKey: 'LOCAL::C:/db/test.db::wxid_secret001' }],
  publicSummary: '找到 1 个客户'
}

/** 假白名单工具（真实 HermesToolDef 形态；记录 args/ctx 供断言） */
function makeSearchTool(result: HermesToolResult = SEARCH_RESULT): { tool: HermesToolDef; calls: Array<{ args: Record<string, unknown>; ctx: unknown }> } {
  const calls: Array<{ args: Record<string, unknown>; ctx: unknown }> = []
  const tool: HermesToolDef = {
    name: 'customer.search',
    publicLabel: '客户检索',
    description: '按关键字检索客户档案',
    argsHint: '{ query: string }',
    run: async (args, ctx) => { calls.push({ args, ctx }); return result }
  }
  return { tool, calls }
}

/** 门控工具桩：run 挂起直到 releaseAll（模拟工具执行在途） */
function makeGatedTool(result: HermesToolResult): { tool: HermesToolDef; calls: Array<{ args: Record<string, unknown> }>; releaseAll: () => void } {
  const calls: Array<{ args: Record<string, unknown> }> = []
  const releases: Array<() => void> = []
  const tool: HermesToolDef = {
    name: 'customer.search',
    publicLabel: '客户检索',
    description: '按关键字检索客户档案',
    argsHint: '{ query: string }',
    run: async (args) => {
      calls.push({ args })
      await new Promise<void>((r) => releases.push(r))
      return result
    }
  }
  return { tool, calls, releaseAll: () => { while (releases.length) releases.shift()!() } }
}

/** 模型 tool_call 输出 */
const toolCall = (tool: string, args: Record<string, unknown> = {}): string =>
  JSON.stringify({ type: 'tool_call', tool, arguments: args, reason: '测试' })

/** 模型 complete 输出 */
const completeWith = (refs: string[], summary = '测试结论'): string => JSON.stringify({
  type: 'complete',
  summary,
  findings: [{ text: '测试发现', evidenceRefs: refs }],
  nextSteps: ['建议'],
  evidenceRefs: refs
})

/** 从发送记录里找 Main → Utility 的 host.response */
function findHostResponse(sent: unknown[], requestId: string): (MainToUtilityMessage & { type: 'host.response' }) | undefined {
  return sent.find((m) => (m as MainToUtilityMessage).type === 'host.response'
    && (m as MainToUtilityMessage & { requestId?: string }).requestId === requestId) as
    MainToUtilityMessage & { type: 'host.response' } | undefined
}

/** 预热：启动 Manager 并等待 ready */
async function startReady(mgr: Manager): Promise<void> {
  mgr.start()
  await waitFor('manager ready', () => mgr.getState() === 'ready')
}

// ─── 36 个动态场景 ────────────────────────────────────────────────────────────

const tests: Array<{ name: string; fn: () => Promise<void> }> = [
  {
    name: 't1 ready + 协议 v2 握手（init 清单只含公开元数据）',
    fn: async () => {
      const harness = makeHarness()
      const mgr = makeManager(harness, { tools: [makeSearchTool().tool] })
      await startReady(mgr)
      eq(mgr.getState(), 'ready', '握手后状态 ready')
      eq(harness.children.length, 1, '恰好一个 Utility 子进程')
      eq(harness.children[0].exited, false, 'Utility 子进程存活')
      const init = harness.sent.find((m) => (m as MainToUtilityMessage).type === 'init') as
        MainToUtilityMessage & { type: 'init' } | undefined
      ok(!!init, 'Main 发送了 init')
      eq(init!.tools.length, 1, '清单含 1 个工具')
      eq(Object.keys(init!.tools[0]).sort().join(','), 'argsHint,description,name,publicLabel', '清单条目只含公开元数据四字段')
      eq(init!.tools[0].name, 'customer.search', '清单工具名正确')
      ok(!JSON.stringify(init).includes('run('), '清单不含工具实现')
    }
  },
  {
    name: 't2 start → 工具 → 模型 → complete 全链路 + 隐私边界',
    fn: async () => {
      const harness = makeHarness()
      const { tool, calls: toolCalls } = makeSearchTool()
      const { fn: modelComplete, calls: modelCalls } = makeScriptedModel([
        toolCall('customer.search', { query: '张三' }),
        completeWith(['e1'])
      ])
      const mgr = makeManager(harness, { modelComplete, tools: [tool] })
      await startReady(mgr)
      const r = await mgr.startTask({
        goal: '分析张三的客户情况',
        context: { kind: 'customer', accountId: 5, sessionId: 'wxid_real_001' }
      })
      ok(r.ok && !!r.task, 'startTask 成功返回 planning 快照')
      const taskId = r.task!.taskId
      await waitFor('task completed', () => mgr.getTask(taskId)?.status === 'completed')
      const snap = mgr.getTask(taskId)!
      eq(snap.result?.summary, '测试结论', '结论来自模型 complete')
      eq(snap.evidence.length, 1, '证据表 1 条')
      eq(snap.evidence[0].label, '客户：张三', '证据 label 保留')
      eq(snap.evidence[0].messageKey, 'LOCAL::C:/db/test.db::wxid_secret001', 'UI 证据经 Main 锚点恢复原始 messageKey（本地回查能力保留）')
      // 跨进程双面均无 messageKey：Main→Utility 与 Utility→Main 全量扫描
      ok(!JSON.stringify(harness.sent).includes('messageKey'), 'Main→Utility 消息不含 messageKey 字段')
      ok(!JSON.stringify(harness.sent).includes('wxid_secret001'), 'Main→Utility 消息不含 messageKey 值')
      ok(!JSON.stringify(harness.received).includes('messageKey'), 'Utility→Main 消息不含 messageKey 字段')
      ok(!JSON.stringify(harness.received).includes('wxid_secret001'), 'Utility→Main 消息不含 messageKey 值')
      // Main 桥：工具上下文 = capabilityContextId 映射出的真实身份/会话（只在 Main 侧）
      eq((toolCalls[0].ctx as { sessionId?: string }).sessionId, 'wxid_real_001', 'Main 把 capId 映射为真实 sessionId 给工具')
      eq((toolCalls[0].ctx as { identity?: { name: string } }).identity?.name, '王销售', 'Main 把 capId 映射为真实身份')
      // 模型出站最终隐私检查：真实 sessionId 不出网
      const promptText = JSON.stringify(modelCalls[0].messages)
      ok(!promptText.includes('wxid_real_001'), '模型出站 prompt 不含真实 sessionId')
      ok(!promptText.includes('wxid_secret001'), '模型出站 prompt 不含数据内 messageKey 会话标识')
      ok(promptText.includes('accountId=5'), 'customer 上下文锚点注入 accountId')
      // 工具结果出 Utility 前再脱敏：data 内 messageKey 字段被删
      ok(!JSON.stringify(modelCalls).includes('wxid_secret001'), '回喂模型的工具结果副本无 messageKey 锚点')
    }
  },
  {
    name: 't2b 任务文本 Main 脱敏后才下发（原文只存 Main 供 UI 快照）',
    fn: async () => {
      const harness = makeHarness()
      const { tool } = makeSearchTool()
      const { fn: modelComplete, calls: modelCalls } = makeScriptedModel([
        toolCall('customer.search', { query: '张三' }),
        completeWith(['e1'])
      ])
      const mgr = makeManager(harness, { modelComplete, tools: [tool] })
      await startReady(mgr)
      const r = await mgr.startTask({
        goal: '跟进手机号 13812345678 身份证 110101199003078891 客户 wxid_leak_001',
        context: { kind: 'customer', accountId: 5, sessionId: 'wxid_real_001' },
        contextLabel: '客户张三（wxid_leak_001）'
      })
      ok(r.ok && !!r.task, 'startTask 成功')
      const taskId = r.task!.taskId
      await waitFor('task completed', () => mgr.getTask(taskId)?.status === 'completed')
      const start = harness.sent.find((m) => (m as MainToUtilityMessage).type === 'task.start') as
        MainToUtilityMessage & { type: 'task.start'; goal: string; context: { label: string } } | undefined
      ok(!!start, '捕获 task.start')
      const wire = JSON.stringify(start)
      ok(!wire.includes('13812345678'), 'task.start 不含手机号')
      ok(!wire.includes('110101199003078891'), 'task.start 不含身份证')
      ok(!wire.includes('wxid_leak_001'), 'task.start 不含任务文本里的 wxid')
      ok(!wire.includes('wxid_real_001'), 'task.start 不含宿主 sessionId')
      ok(!wire.includes('张三'), 'task.start 上下文标签不含客户名')
      eq(start!.context.label, '当前客户', 'Utility 侧标签为通用「当前客户」')
      // UI 快照保留原文（不被脱敏文本覆盖）
      const snap = mgr.getTask(taskId)!
      ok(snap.goal.includes('13812345678'), 'UI goal 保留原文手机号')
      ok(snap.goal.includes('wxid_leak_001'), 'UI goal 保留原文 wxid')
      eq(snap.contextLabel, '客户张三（wxid_leak_001）', 'UI contextLabel 保留原文')
      // 模型出站同样经脱敏（maskText + sessionId 精确替换）
      const promptText = JSON.stringify(modelCalls[0].messages)
      ok(!promptText.includes('13812345678'), '模型出站 prompt 不含手机号')
      ok(!promptText.includes('110101199003078891'), '模型出站 prompt 不含身份证')
      ok(!promptText.includes('wxid_real_001'), '模型出站 prompt 不含 sessionId')
    }
  },
  {
    name: 't3 progress 顺序（planning → running → … → completed）',
    fn: async () => {
      const harness = makeHarness()
      const { tool } = makeSearchTool()
      const { fn: modelComplete } = makeScriptedModel([toolCall('customer.search'), completeWith(['e1'])])
      const mgr = makeManager(harness, { modelComplete, tools: [tool] })
      await startReady(mgr)
      const events: HermesTask[] = []
      mgr.onProgress((t) => events.push(JSON.parse(JSON.stringify(t))))
      const r = await mgr.startTask({ goal: '顺序测试' })
      const taskId = r.task!.taskId
      await waitFor('task completed', () => mgr.getTask(taskId)?.status === 'completed')
      await new Promise((res) => setTimeout(res, 100))
      ok(events.length >= 3, `progress 事件足够多（${events.length}）`)
      eq(events[0].taskId, taskId, '事件 taskId 一致')
      eq(events[0].status, 'planning', '首个 progress 为 planning')
      eq(events[events.length - 1].status, 'completed', '末个 progress 为 completed')
      const statuses = events.map((e) => e.status)
      const firstRunning = statuses.indexOf('running')
      ok(firstRunning > 0 && firstRunning < statuses.length - 1, 'running 在 planning 之后、completed 之前')
      ok(statuses.slice(firstRunning, statuses.indexOf('completed')).every((s) => s === 'running'), '中间过程全为 running')
      const last = events[events.length - 1]
      ok(Array.isArray(last.evidence) && last.evidence.length >= 1, 'completed 快照带证据')
      ok(typeof last.createdAt === 'number', '快照带 createdAt')
    }
  },
  {
    name: 't4 白名单外工具被拒（Utility 清单层 + Main 桥 re-validate 层）',
    fn: async () => {
      const harness = makeHarness()
      const { tool, calls: toolCalls } = makeSearchTool()
      const { fn: modelComplete } = makeScriptedModel([
        toolCall('evil.exfiltrate', { data: 'all' }),
        toolCall('customer.search'),
        completeWith(['e1'])
      ])
      const mgr = makeManager(harness, { modelComplete, tools: [tool] })
      await startReady(mgr)
      const r = await mgr.startTask({ goal: '白名单测试' })
      const taskId = r.task!.taskId
      await waitFor('task completed', () => mgr.getTask(taskId)?.status === 'completed')
      const snap = mgr.getTask(taskId)!
      const evilStep = snap.steps.find((s) => s.tool === 'evil.exfiltrate')
      ok(!!evilStep, '白名单外调用产生步骤')
      eq(evilStep!.label, '执行查询', '白名单外步骤显示通用「执行查询」')
      eq(evilStep!.status, 'error', '白名单外步骤状态 error')
      eq(evilStep!.publicSummary, '工具不存在', '步骤摘要：工具不存在')
      eq(toolCalls.length, 1, 'evil.exfiltrate 从未到达 Main 工具执行（清单层已拒）')
      // Main 桥 re-validate：伪造 capabilityContextId → 拒绝
      const asMgr = mgr as unknown as { onChildMessage: (raw: unknown) => void }
      asMgr.onChildMessage({
        protocolVersion: HERMES_PROTOCOL_VERSION, id: 'hm-test-forged-1', type: 'host.request',
        request: { capability: 'tool.execute', requestId: 'raw-1', taskId, capabilityContextId: 'forged-cap', tool: 'customer.search', arguments: {} }
      })
      const resp1 = findHostResponse(harness.sent, 'raw-1')
      ok(!!resp1 && resp1.ok === false && resp1.error?.code === 'forbidden', 'capId 不匹配 → Main 拒绝（forbidden）')
      asMgr.onChildMessage({
        protocolVersion: HERMES_PROTOCOL_VERSION, id: 'hm-test-forged-2', type: 'host.request',
        request: { capability: 'tool.execute', requestId: 'raw-2', taskId, capabilityContextId: 'forged-cap', tool: 'evil.exfiltrate', arguments: {} }
      })
      const resp2 = findHostResponse(harness.sent, 'raw-2')
      ok(!!resp2 && resp2.ok === false && resp2.error?.code === 'forbidden', '未知 taskId 请求 → Main 拒绝')
      ok(!JSON.stringify(harness.sent).includes('"raw-1"') || findHostResponse(harness.sent, 'raw-1')!.error !== undefined, '被拒请求没有产生任何工具结果回传')
    }
  },
  {
    name: 't5 畸形消息丢弃不致命；数值协议版本 ≠ 当前 → 立即 fail closed',
    fn: async () => {
      const harness = makeHarness()
      const { tool } = makeSearchTool()
      const { fn: modelComplete } = makeScriptedModel([toolCall('customer.search'), completeWith(['e1'])])
      const mgr = makeManager(harness, { modelComplete, tools: [tool] })
      await startReady(mgr)
      const asMgr = mgr as unknown as { onChildMessage: (raw: unknown) => void }
      // 非对象/严格校验不过的消息：丢弃，不致命
      asMgr.onChildMessage('garbage-string')
      asMgr.onChildMessage(null)
      asMgr.onChildMessage({ protocolVersion: HERMES_PROTOCOL_VERSION, id: 'hm-y', type: 'ready', messageKey: 'LOCAL::C:/x' })
      asMgr.onChildMessage({ protocolVersion: HERMES_PROTOCOL_VERSION, id: 'hm-z', type: 'task.progress', taskId: 'fake', runId: 1, snapshot: { bogus: true } })
      eq(mgr.getState(), 'ready', '畸形消息后状态仍 ready')
      // 数值版本 ≠ 当前：立即 fail closed（kill 当前 child + 不自动重启 + 拒新任务）
      asMgr.onChildMessage({ protocolVersion: HERMES_PROTOCOL_VERSION + 1, id: 'hm-x', type: 'ready' })
      await waitFor('fail closed', () => mgr.getState() === 'unavailable')
      await waitFor('版本不一致的 Utility child 已退出', () => harness.children[0].exited)
      await new Promise((res) => setTimeout(res, 300))
      eq(harness.children.length, 1, '版本不一致不触发重启（重试无用）')
      const r = await mgr.startTask({ goal: '版本不一致后的任务' })
      eq(r.ok, false, 'fail closed 后 startTask 拒绝')
      eq(r.errorCode, 'protocol_mismatch', 'errorCode protocol_mismatch')
    }
  },
  {
    name: 't6 模型请求期间取消：Main abort 模型 + Utility 收 task.cancel',
    fn: async () => {
      const harness = makeHarness()
      const { tool } = makeSearchTool()
      const { fn: modelComplete, calls: modelCalls, releaseAll } = makeGatedModel(completeWith(['e1']))
      const mgr = makeManager(harness, { modelComplete, tools: [tool] })
      await startReady(mgr)
      const r = await mgr.startTask({ goal: '模型期取消测试' })
      const taskId = r.task!.taskId
      await waitFor('模型调用在途', () => modelCalls.length === 1)
      const c = mgr.cancelTask(taskId)
      ok(c.ok && c.task?.status === 'cancelled', 'cancelTask 立即返回 cancelled')
      eq(modelCalls[0].signal.aborted, true, 'Main 已 abort 模型请求（AbortController 留在 Main）')
      releaseAll()
      await waitFor('snapshot cancelled', () => mgr.getTask(taskId)?.status === 'cancelled')
      ok(harness.sent.some((m) => (m as MainToUtilityMessage).type === 'task.cancel' && (m as MainToUtilityMessage & { taskId?: string }).taskId === taskId), 'Utility 收到 task.cancel')
      const snap = mgr.getTask(taskId)!
      eq(snap.errorCode, 'cancelled', 'errorCode cancelled')
      eq(snap.errorMessage, FRIENDLY_ERROR.cancelled, '人话取消文案')
    }
  },
  {
    name: 't7 工具执行期间取消：结果被丢弃（不登记证据、不产生完成步骤）',
    fn: async () => {
      const harness = makeHarness()
      const gated = makeGatedTool(SEARCH_RESULT)
      const { fn: modelComplete } = makeScriptedModel([toolCall('customer.search', { query: '张三' }), completeWith(['e1'])])
      const mgr = makeManager(harness, { modelComplete, tools: [gated.tool] })
      await startReady(mgr)
      const r = await mgr.startTask({ goal: '工具期取消测试' })
      const taskId = r.task!.taskId
      await waitFor('工具执行在途', () => gated.calls.length === 1)
      mgr.cancelTask(taskId)
      gated.releaseAll()
      await waitFor('snapshot cancelled', () => mgr.getTask(taskId)?.status === 'cancelled')
      const snap = mgr.getTask(taskId)!
      eq(snap.evidence.length, 0, '在途工具结果被丢弃：不登记证据')
      eq(snap.result, undefined, '不产生完成结论')
      eq(snap.steps.filter((s) => s.status === 'done').length, 0, '不产生完成步骤（在途步骤不置 done）')
      const isCancelledHostResponse = (m: unknown): boolean => {
        const msg = m as MainToUtilityMessage & { ok?: boolean; error?: { code?: string } }
        return msg.type === 'host.response' && msg.ok === false && msg.error?.code === 'cancelled'
      }
      await waitFor('cancelled host.response', () => harness.sent.some(isCancelledHostResponse))
      ok(harness.sent.some(isCancelledHostResponse), 'Main 对在途工具请求回传 cancelled（结果不出宿主）')
    }
  },
  {
    name: 't8 第一次崩溃：自动重启回 ready（每应用生命周期至多一次）',
    fn: async () => {
      const harness = makeHarness()
      const { tool } = makeSearchTool()
      // 两轮任务（重启后还要跑一个新任务）：脚本给足 4 条
      const { fn: modelComplete } = makeScriptedModel([
        toolCall('customer.search'), completeWith(['e1']),
        toolCall('customer.search'), completeWith(['e1'])
      ])
      const mgr = makeManager(harness, { modelComplete, tools: [tool] })
      await startReady(mgr)
      eq(harness.children.length, 1, '初始一个子进程')
      harness.children[0].kill() // 模拟 Utility 崩溃
      await waitFor('重启后 ready', () => mgr.getState() === 'ready' && harness.children.length === 2)
      eq(harness.children[0].exited, true, '旧子进程已退出')
      ok(harness.children[1] && !harness.children[1].exited, '新 Utility 子进程存活')
      // 重启后服务继续可用
      const r = await mgr.startTask({ goal: '重启后任务' })
      ok(r.ok, '重启后 startTask 成功')
      const taskId = r.task!.taskId
      await waitFor('task completed', () => mgr.getTask(taskId)?.status === 'completed')
      eq(mgr.getTask(taskId)!.result?.summary, '测试结论', '重启后任务正常完成')
    }
  },
  {
    name: 't9 已收尾任务跨 Utility 重启恢复并可继续追问',
    fn: async () => {
      const harness = makeHarness()
      const { tool } = makeSearchTool()
      const first = makeScriptedModel([toolCall('customer.search'), completeWith(['e1'])])
      const second = makeScriptedModel([completeWith(['e1'], '继续结论')])
      let currentModel: HermesCompletion = first.fn
      const mgr = makeManager(harness, { modelComplete: (...args) => currentModel(...args), tools: [tool] })
      await startReady(mgr)
      const r = await mgr.startTask({ goal: '恢复测试' })
      const taskId = r.task!.taskId
      await waitFor('task completed', () => mgr.getTask(taskId)?.status === 'completed')
      eq(mgr.getTask(taskId)!.evidence[0].label, '客户：张三', '完成态证据在')
      eq(mgr.getTask(taskId)!.evidence[0].messageKey, 'LOCAL::C:/db/test.db::wxid_secret001', '崩溃前 UI 证据已恢复 messageKey')
      harness.children[0].kill() // 崩溃 → 重启 → restore checkpoint
      await waitFor('重启后 ready', () => mgr.getState() === 'ready' && harness.children.length === 2)
      eq(mgr.getTask(taskId)!.status, 'completed', '重启后快照保持 completed')
      // restore 下发的 checkpoint 只含脱敏展示面：无 messageKey、无 evidenceHandle（锚点只存 Main）
      const restoreMsg = harness.sent.find((m) => (m as MainToUtilityMessage).type === 'restore')
      ok(!!restoreMsg, '重启后向新 child 下发 restore')
      ok(!JSON.stringify(restoreMsg).includes('wxid_secret001'), 'restore checkpoint 不含 messageKey 值')
      ok(!JSON.stringify(restoreMsg).includes('messageKey'), 'restore checkpoint 不含 messageKey 字段')
      ok(!JSON.stringify(restoreMsg).includes('evidenceHandle'), 'restore checkpoint 不含 evidenceHandle')
      // Main 内存中的 ref 锚点跨崩溃存活：UI 快照仍能恢复原始 messageKey
      eq(mgr.getTask(taskId)!.evidence[0].messageKey, 'LOCAL::C:/db/test.db::wxid_secret001', '崩溃恢复后 Main 锚点仍恢复原始 messageKey')
      // 继续追问：checkpoint 还原的证据表/对话可用，e1 仍有效
      currentModel = second.fn
      const r2 = await mgr.continueTask(taskId, '再讲讲细节')
      ok(r2.ok, 'continueTask 成功')
      await waitFor('继续轮 completed', () => mgr.getTask(taskId)?.status === 'completed' && (mgr.getTask(taskId)!.result?.summary === '继续结论'))
      eq(mgr.getTask(taskId)!.result?.summary, '继续结论', '继续轮结论来自新模型脚本')
      eq(mgr.getTask(taskId)!.evidence[0].label, '客户：张三', '还原的证据表支持结论重建')
      eq(mgr.getTask(taskId)!.evidence[0].messageKey, 'LOCAL::C:/db/test.db::wxid_secret001', '继续轮 UI 证据仍恢复原始 messageKey')
      const restoredPrompt = JSON.stringify(second.calls[0].messages)
      ok(restoredPrompt.includes('【销售目标】再讲讲细节'), '追问进入对话窗口')
      ok(restoredPrompt.includes('客户：张三'), '还原对话窗口包含历史工具结果证据')
    }
  },
  {
    name: 't10 运行中任务随崩溃置 failed/agent_unavailable（不回退旧 Agent）',
    fn: async () => {
      const harness = makeHarness()
      const gated = makeGatedTool(SEARCH_RESULT)
      const { fn: modelComplete } = makeScriptedModel([toolCall('customer.search')])
      const mgr = makeManager(harness, { modelComplete, tools: [gated.tool] })
      await startReady(mgr)
      const r = await mgr.startTask({ goal: '运行中崩溃测试' })
      const taskId = r.task!.taskId
      await waitFor('工具执行在途', () => gated.calls.length === 1)
      harness.children[0].kill()
      await waitFor('snapshot failed', () => mgr.getTask(taskId)?.status === 'failed')
      const snap = mgr.getTask(taskId)!
      eq(snap.errorCode, 'agent_unavailable', 'errorCode agent_unavailable')
      eq(snap.errorMessage, 'Hermes 暂时不可用，请重启应用后再试。', '人话错误文案')
      await waitFor('重启后 ready', () => mgr.getState() === 'ready')
      gated.releaseAll()
    }
  },
  {
    name: 't11 第二次崩溃：fail closed → unavailable，startTask 拒绝',
    fn: async () => {
      const harness = makeHarness()
      const { tool } = makeSearchTool()
      const { fn: modelComplete } = makeScriptedModel([completeWith(['e1'])])
      const mgr = makeManager(harness, { modelComplete, tools: [tool] })
      await startReady(mgr)
      harness.children[0].kill()
      await waitFor('第一次重启 ready', () => mgr.getState() === 'ready' && harness.children.length === 2)
      harness.children[1].kill()
      await waitFor('状态 unavailable', () => mgr.getState() === 'unavailable')
      eq(harness.children.length, 2, '不再重启第三个子进程')
      const r = await mgr.startTask({ goal: '不可用时任务' })
      eq(r.ok, false, 'startTask 被拒绝')
      eq(r.errorCode, 'agent_unavailable', 'errorCode agent_unavailable')
      eq(r.task, undefined, '无任务快照')
      const c = await mgr.continueTask('whatever', '问题')
      eq(c.ok, false, 'continueTask 被拒绝')
    }
  },
  {
    name: 't12 shutdown：通知 → 退出，无孤儿进程；之后拒绝新任务',
    fn: async () => {
      const harness = makeHarness()
      const { tool } = makeSearchTool()
      const { fn: modelComplete } = makeScriptedModel([completeWith(['e1'])])
      const mgr = makeManager(harness, { modelComplete, tools: [tool] })
      await startReady(mgr)
      const t0 = Date.now()
      await mgr.shutdown()
      const cost = Date.now() - t0
      eq(mgr.getState(), 'stopped', 'shutdown 后状态 stopped')
      ok(cost < 5000, `shutdown 在宽限期内完成（${cost}ms）`)
      ok(harness.children[0].exited, 'Utility 子进程已退出（无孤儿）')
      const r = await mgr.startTask({ goal: '停机后任务' })
      eq(r.ok, false, 'shutdown 后 startTask 拒绝')
      eq(r.errorCode, 'agent_unavailable', 'errorCode agent_unavailable')
    }
  },
  {
    name: 't13 静态红线：Utility 入口零禁用 import + main.ts 走 Manager',
    fn: async () => {
      const src = readFileSync(ENTRY_TS, 'utf8')
      const forbidden = [
        "from 'electron'", 'from "electron"', "require('electron')",
        "from 'fs'", "from 'node:fs'", "from 'path'", "from 'node:path'",
        "from 'better-sqlite3'",
        "from '../services/config'", "from '../services/identityService'",
        "from '../services/salesQueue'", "from '../services/salesLogger'",
        "from '../services/crmSla2Service'", "from '../services/ai/aiApiClient'",
        "from '../services/crmDbService'", "from '../services/salesDbService'",
        "from '../services/chatService'", "from '../services/hermesAgent'"
      ]
      for (const f of forbidden) ok(!src.includes(f), `Utility 入口不 import ${f}`)
      ok(src.includes("from '../services/hermesAgentCore'"), 'Utility 入口复用 Agent Core（唯一 Loop）')
      ok(/import type \{[^}]*\} from '\.\.\/services\/hermesToolRegistry'/.test(src), '注册表只允许 type import')
      ok(src.includes('process.parentPort') || src.includes('.parentPort'), 'Utility 入口走 parentPort 通信')
      ok(src.includes('host.request'), 'Utility 经 host.request 请求宿主能力')
      // main.ts 生产接线
      const mainSrc = readFileSync(MAIN_TS, 'utf8')
      ok(mainSrc.includes('createHermesUtilityManager'), 'main.ts 构造 Utility Manager')
      ok(mainSrc.includes('resolveHermesUtilityPath'), 'main.ts 指向 Utility 构建产物（单点路径解析）')
      ok(mainSrc.includes('utilityProcess.fork'), 'main.ts 用 Electron utilityProcess.fork')
      ok(mainSrc.includes("await hermesUtilityManager.shutdown()"), '退出流程先结束 Utility')
      ok(!mainSrc.includes("from './services/hermesAgent'"), 'main.ts 不再 import 旧进程内 Agent 服务')
      ok(mainSrc.includes("from './hermes/hermesUtilityManager'"), 'main.ts import Manager')
      // vite 构建
      const viteSrc = readFileSync(VITE_TS, 'utf8')
      ok(viteSrc.includes('hermesUtilityEntry.ts'), 'vite 增加 Utility 入口构建')
      // 第三轮：双向唯一出口 + 指纹生产组成 + 账号切换失效接线
      ok(src.includes('findHermesBoundaryIssues'), 'Utility→Main 出口执行边界扫描（Entry.send）')
      const mgrSrc = readFileSync(join(ROOT, 'electron', 'hermes', 'hermesUtilityManager.ts'), 'utf8')
      ok(mgrSrc.includes('findHermesBoundaryIssues'), 'Main→Utility 出口执行边界扫描（sendToUtility）')
      ok(mgrSrc.includes('getMyWxidCleaned'), '指纹缺省实现含清洗后 myWxid')
      ok(mgrSrc.includes('this.identityFn()'), '指纹缺省实现含身份（姓名/角色）')
      ok(mainSrc.includes("invalidateCapabilities('account_changed')"), 'config:set myWxid 切库后主动失效全部任务能力')
    }
  },
  {
    name: 't14 shutdown 等待在途宿主操作：模型 abort；工具收尾前 shutdown 不返回',
    fn: async () => {
      // (a) 模型请求在途：shutdown 开始即 abort 模型（AbortController 留在 Main）
      const h1 = makeHarness()
      const gatedModel = makeGatedModel(completeWith(['e1']))
      const m1 = makeManager(h1, { modelComplete: gatedModel.fn, tools: [makeSearchTool().tool] })
      await startReady(m1)
      await m1.startTask({ goal: 'shutdown 模型在途' })
      await waitFor('模型调用在途', () => gatedModel.calls.length === 1)
      await m1.shutdown()
      eq(gatedModel.calls[0].signal.aborted, true, 'shutdown 已 abort 在途模型请求')
      eq(m1.getState(), 'stopped', '模型 abort 落定后 shutdown 返回')
      // (b)(c) 工具执行在途：shutdown 不得提前 resolve；工具收尾后 shutdown 完成
      const h2 = makeHarness()
      const gated = makeGatedTool(SEARCH_RESULT)
      const { fn: modelComplete } = makeScriptedModel([toolCall('customer.search')])
      const m2 = makeManager(h2, { modelComplete, tools: [gated.tool] })
      await startReady(m2)
      await m2.startTask({ goal: 'shutdown 工具在途' })
      await waitFor('工具执行在途', () => gated.calls.length === 1)
      let shutdownDone = false
      const p = m2.shutdown().then(() => { shutdownDone = true })
      await new Promise((res) => setTimeout(res, 400))
      eq(shutdownDone, false, '在途工具未收尾前 shutdown 不提前 resolve')
      gated.releaseAll()
      await p
      eq(m2.getState(), 'stopped', '工具收尾后 shutdown 完成')
    }
  },
  {
    name: 't15 child 亲和：崩溃重启后旧请求的延迟结果绝不发给新 child',
    fn: async () => {
      const harness = makeHarness()
      const gated = makeGatedTool(SEARCH_RESULT)
      const { fn: modelComplete } = makeScriptedModel([toolCall('customer.search')])
      const mgr = makeManager(harness, { modelComplete, tools: [gated.tool] })
      await startReady(mgr)
      const r = await mgr.startTask({ goal: '亲和测试' })
      const taskId = r.task!.taskId
      await waitFor('工具执行在途', () => gated.calls.length === 1)
      // 只捕获在途 tool.execute 请求（model.complete 的响应崩溃前已合法回给旧 child）
      const reqMsg = harness.received.find((m) => (m as MainToUtilityMessage).type === 'host.request'
        && (m as MainToUtilityMessage & { request?: { capability?: string } }).request?.capability === 'tool.execute') as
        MainToUtilityMessage & { request: { requestId: string } } | undefined
      ok(!!reqMsg, '捕获旧 child 发起的工具宿主请求')
      harness.children[0].kill() // 崩溃 → 自动重启
      await waitFor('重启后 ready', () => mgr.getState() === 'ready' && harness.children.length === 2)
      ok(harness.children[1] && !harness.children[1].exited, '新 Utility child 存活')
      const sentLenAtRestart = harness.sent.length
      gated.releaseAll() // 旧请求的结果此时才落定
      await new Promise((res) => setTimeout(res, 150))
      eq(findHostResponse(harness.sent, reqMsg!.request.requestId), undefined, '旧请求的延迟结果未回传')
      const isHostResponse = (m: unknown): boolean => (m as MainToUtilityMessage).type === 'host.response'
      ok(!harness.sent.slice(sentLenAtRestart).some(isHostResponse), '重启后没有任何宿主响应（含错误）发给新 child')
      eq(mgr.getTask(taskId)?.status, 'failed', '崩溃时任务已置 failed')
    }
  },
  {
    name: 't16 旧协议版本 child 上线 → 立即 fail closed（kill + 不重启 + 拒绝宿主执行）',
    fn: async () => {
      const { forkProcess, fakes } = makeFakeFork()
      const { tool, calls: toolCalls } = makeSearchTool()
      const mgr = makeManager({ forkProcess }, { tools: [tool] })
      mgr.start()
      eq(fakes.length, 1, 'fork 了一次')
      fakes[0].emitMessage({ protocolVersion: HERMES_PROTOCOL_VERSION, id: 'hm-t16-initial-ready', type: 'ready' })
      await waitFor('首个 child ready', () => mgr.getState() === 'ready')
      const started = await mgr.startTask({ goal: '协议版本不一致后的错误码测试' })
      ok(started.ok && !!started.task, '正常协议 child 下任务已创建')
      // 旧版本 child 发 ready：版本检查先于严格校验，立即 fail closed
      fakes[0].emitMessage({ protocolVersion: HERMES_PROTOCOL_VERSION + 1, id: 'hm-old-ready', type: 'ready' })
      await waitFor('立即 unavailable', () => mgr.getState() === 'unavailable')
      eq(fakes[0].killed, true, '旧版本 child 被 kill')
      await new Promise((res) => setTimeout(res, 300))
      eq(fakes.length, 1, '版本不一致不自动重启（重启预算不消耗）')
      const startAfterMismatch = await mgr.startTask({ goal: '协议不一致后 start' })
      eq(startAfterMismatch.errorCode, 'protocol_mismatch', '协议不一致后 start 保持 protocol_mismatch')
      const continueAfterMismatch = await mgr.continueTask(started.task!.taskId, '协议不一致后 continue')
      eq(continueAfterMismatch.errorCode, 'protocol_mismatch', '协议不一致后 continue 保持 protocol_mismatch')
      // unavailable 状态拒绝一切宿主请求执行
      fakes[0].emitMessage({
        protocolVersion: HERMES_PROTOCOL_VERSION, id: 'hm-t16-req', type: 'host.request',
        request: { capability: 'tool.execute', requestId: 't16-r1', taskId: 't16-task', capabilityContextId: 'cap-1', tool: 'customer.search', arguments: {} }
      })
      await new Promise((res) => setTimeout(res, 100))
      eq(toolCalls.length, 0, 'unavailable 下宿主工具从不执行')
      const resp = fakes[0].inbox.find((m) => (m as MainToUtilityMessage).type === 'host.response') as
        MainToUtilityMessage & { ok: boolean; error?: { code: string } } | undefined
      ok(!!resp && resp.ok === false && resp.error?.code === 'protocol_mismatch', '版本不一致时宿主请求收到 protocol_mismatch 拒绝响应')
    }
  },
  {
    name: 't17 旧 child 迟到消息一律忽略（监听绑定 child/generation）',
    fn: async () => {
      const { forkProcess, fakes } = makeFakeFork()
      const mgr = makeManager({ forkProcess })
      mgr.start()
      fakes[0].emitMessage({ protocolVersion: HERMES_PROTOCOL_VERSION, id: 'r1', type: 'ready' })
      await waitFor('首个 child ready', () => mgr.getState() === 'ready')
      fakes[0].emitExit(1) // 崩溃 → 自动重启
      await waitFor('第二个 child 已 fork', () => fakes.length === 2)
      fakes[1].emitMessage({ protocolVersion: HERMES_PROTOCOL_VERSION, id: 'r2', type: 'ready' })
      await waitFor('重启后 ready', () => mgr.getState() === 'ready')
      // 旧 child（已被替换）迟到消息：合法 progress 不进快照；错误版本不触发 fail closed
      fakes[0].emitMessage({
        protocolVersion: HERMES_PROTOCOL_VERSION, id: 'late-1', type: 'task.progress', taskId: 'late-task', runId: 1,
        snapshot: { taskId: 'late-task', status: 'running', goal: '迟到消息', contextLabel: '全局', steps: [], evidence: [], createdAt: 1 }
      })
      fakes[0].emitMessage({ protocolVersion: HERMES_PROTOCOL_VERSION + 1, id: 'late-2', type: 'ready' })
      await new Promise((res) => setTimeout(res, 100))
      eq(mgr.getTask('late-task'), null, '旧 child 的 progress 不进入快照')
      eq(mgr.getState(), 'ready', '旧 child 的旧版本消息不触发 fail closed（监听层已忽略）')
      eq(fakes.length, 2, '无额外重启')
    }
  },
  {
    name: 't18 上下文指纹：姓名/角色/账号任一变化 → host.request 拒绝 + 任务终止 + 不可复活',
    fn: async () => {
      const { forkProcess, fakes } = makeFakeFork()
      const { tool, calls: toolCalls } = makeSearchTool()
      // 指纹组件与生产缺省实现同构：清洗后 wxid + 身份姓名 + 身份角色
      const fp = { wxid: 'wxid_fp_old', name: '王销售', role: 'sales' }
      const mgr = makeManager({ forkProcess }, {
        tools: [tool],
        contextFingerprint: () => JSON.stringify([fp.wxid, fp.name, fp.role])
      })
      mgr.start()
      fakes[0].emitMessage({ protocolVersion: HERMES_PROTOCOL_VERSION, id: 't18-ready', type: 'ready' })
      await waitFor('ready', () => mgr.getState() === 'ready')
      const inject = (msg: unknown): void => (mgr as unknown as { onChildMessage: (raw: unknown) => void }).onChildMessage(msg)
      const injectReq = (reqId: string, taskId: string, capId: string): void => inject({
        protocolVersion: HERMES_PROTOCOL_VERSION, id: `t18-${reqId}`, type: 'host.request',
        request: { capability: 'tool.execute', requestId: reqId, taskId, capabilityContextId: capId, tool: 'customer.search', arguments: { query: '张三' } }
      })
      const hostResp = (reqId: string) =>
        fakes[0].inbox.find((m) => (m as MainToUtilityMessage).type === 'host.response'
          && (m as MainToUtilityMessage & { requestId?: string }).requestId === reqId) as
          MainToUtilityMessage & { ok: boolean; error?: { code: string; message: string } } | undefined
      const lastStart = () => fakes[0].inbox.filter((m) => (m as MainToUtilityMessage).type === 'task.start').pop() as
        MainToUtilityMessage & { context: { capabilityContextId: string } }

      // ① 身份姓名变化
      const r1 = await mgr.startTask({ goal: '指纹-姓名' })
      ok(r1.ok && !!r1.task, '任务1 创建')
      const t1 = r1.task!.taskId
      const start1 = lastStart()
      eq(start1.context.capabilityContextId.length > 0, true, 'task.start 携带不透明 capId')
      injectReq('req-a', t1, start1.context.capabilityContextId)
      await waitFor('req-a 响应', () => !!hostResp('req-a'))
      ok(hostResp('req-a')?.ok === true, '指纹一致时工具请求正常受理')
      eq(toolCalls.length, 1, '工具执行 1 次')
      fp.name = '李销售'
      injectReq('req-b', t1, start1.context.capabilityContextId)
      await waitFor('req-b 响应', () => !!hostResp('req-b'))
      const respB = hostResp('req-b')
      ok(!!respB && !respB.ok && respB.error?.code === 'context_expired', '姓名变化后 host.request 拒绝 context_expired')
      eq(respB!.error?.message, '当前账号或身份已经变化，请重新发起 Hermes 任务。', '稳定人话文案')
      await waitFor('任务1 终止', () => mgr.getTask(t1)?.status === 'failed' && mgr.getTask(t1)?.errorCode === 'context_expired')
      eq(toolCalls.length, 1, '指纹失效后不再执行数据库工具')

      // ② 身份角色变化（新任务定格新指纹后再变角色）
      const r2 = await mgr.startTask({ goal: '指纹-角色' })
      ok(r2.ok && !!r2.task, '新指纹下任务2 创建')
      const t2 = r2.task!.taskId
      const start2 = lastStart()
      fp.role = 'manager'
      injectReq('req-c', t2, start2.context.capabilityContextId)
      await waitFor('req-c 响应', () => !!hostResp('req-c'))
      const respC = hostResp('req-c')
      ok(!!respC && !respC.ok && respC.error?.code === 'context_expired', '角色变化后 host.request 拒绝')

      // ③ 账号 wxid 变化
      const r3 = await mgr.startTask({ goal: '指纹-wxid' })
      ok(r3.ok && !!r3.task, '新指纹下任务3 创建')
      const t3 = r3.task!.taskId
      const start3 = lastStart()
      fp.wxid = 'wxid_fp_new'
      injectReq('req-d', t3, start3.context.capabilityContextId)
      await waitFor('req-d 响应', () => !!hostResp('req-d'))
      const respD = hostResp('req-d')
      ok(!!respD && !respD.ok && respD.error?.code === 'context_expired', '账号变化后 host.request 拒绝')

      // ④ 过期任务不可复活：continue 拒绝、capability 封禁、迟到 progress 不能覆盖
      const c = await mgr.continueTask(t1, '复活尝试')
      ok(!c.ok && c.errorCode === 'context_expired', '过期任务 continue 拒绝 context_expired')
      injectReq('req-e', t1, start1.context.capabilityContextId)
      await waitFor('req-e 响应', () => !!hostResp('req-e'))
      ok(hostResp('req-e')?.error?.code === 'context_expired', '封禁后再次 host.request 仍拒绝')
      inject({
        protocolVersion: HERMES_PROTOCOL_VERSION, id: 't18-late', type: 'task.progress', taskId: t1, runId: 1,
        snapshot: { taskId: t1, status: 'running', goal: '复活', contextLabel: '全局', steps: [], evidence: [], createdAt: 1 }
      })
      eq(mgr.getTask(t1)?.status, 'failed', '迟到 progress 不能复活 context_expired 任务')
      // 指纹原文与组件绝不进 Utility 消息
      const wire = JSON.stringify(fakes[0].inbox)
      ok(!wire.includes('wxid_fp_old') && !wire.includes('wxid_fp_new'), '指纹 wxid 组件不进 Utility 消息')
      ok(!wire.includes('李销售'), '身份姓名不进 Utility 消息')
    }
  },
  {
    name: 't19 指纹（真实 fork）：运行中账号变化 → 工具不再执行 + failed/context_expired；新上下文新任务正常',
    fn: async () => {
      const harness = makeHarness()
      const gated = makeGatedTool(SEARCH_RESULT)
      const { fn: modelComplete } = makeScriptedModel([toolCall('customer.search'), toolCall('customer.search'), completeWith(['e1'])])
      const fp = { wxid: 'wxid_secret_fp_9', name: '王销售', role: 'sales' }
      const mgr = makeManager(harness, {
        modelComplete, tools: [gated.tool],
        contextFingerprint: () => `FPRINT(${JSON.stringify([fp.wxid, fp.name, fp.role])})`
      })
      await startReady(mgr)
      const r = await mgr.startTask({ goal: '运行中指纹变化' })
      const taskIdA = r.task!.taskId
      await waitFor('工具执行在途', () => gated.calls.length === 1)
      fp.wxid = 'wxid_secret_fp_10'
      gated.releaseAll()
      await waitFor('任务A 终止', () => mgr.getTask(taskIdA)?.status === 'failed' && mgr.getTask(taskIdA)?.errorCode === 'context_expired')
      eq(gated.calls.length, 1, '数据库工具不再执行（仅首轮 1 次）')
      eq(mgr.getTask(taskIdA)!.errorMessage, '当前账号或身份已经变化，请重新发起 Hermes 任务。', '稳定人话文案')
      await new Promise((res) => setTimeout(res, 200))
      eq(mgr.getTask(taskIdA)!.status, 'failed', 'Utility 迟到 progress 未改变 Main 终态')
      // 新上下文新建任务：指纹重新定格，全链路正常完成
      const r2 = await mgr.startTask({ goal: '新账号新任务' })
      ok(r2.ok && !!r2.task, '新上下文 startTask 成功')
      const taskIdB = r2.task!.taskId
      await waitFor('任务B 工具在途', () => gated.calls.length === 2)
      gated.releaseAll()
      await waitFor('任务B 完成', () => mgr.getTask(taskIdB)?.status === 'completed')
      eq(mgr.getTask(taskIdB)!.result?.summary, '测试结论', '新上下文任务正常完成')
      // 指纹原文与组件绝不进任何跨进程消息
      const wire = JSON.stringify([...harness.sent, ...harness.received])
      ok(!wire.includes('wxid_secret_fp_9') && !wire.includes('wxid_secret_fp_10'), '指纹 wxid 组件不进跨进程消息')
      ok(!wire.includes('FPRINT('), '指纹串本身不进跨进程消息')
    }
  },
  {
    name: 't20 取消终态不被迟到消息覆盖：running/completed progress 被拒；迟到 checkpoint 不进 Map',
    fn: async () => {
      const { forkProcess, fakes } = makeFakeFork()
      const mgr = makeManager({ forkProcess }, { tools: [makeSearchTool().tool] })
      mgr.start()
      fakes[0].emitMessage({ protocolVersion: HERMES_PROTOCOL_VERSION, id: 't20-ready', type: 'ready' })
      await waitFor('ready', () => mgr.getState() === 'ready')
      const r = await mgr.startTask({ goal: '取消乱序测试' })
      const taskId = r.task!.taskId
      ok(r.ok && !!r.task, '任务创建')
      mgr.cancelTask(taskId)
      eq(mgr.getTask(taskId)?.status, 'cancelled', '取消后 cancelled')
      const inject = (msg: unknown): void => (mgr as unknown as { onChildMessage: (raw: unknown) => void }).onChildMessage(msg)
      const mkSnap = (status: string): HermesTask => ({
        taskId, status: status as HermesTask['status'], goal: 'x', contextLabel: '全局', steps: [], evidence: [], createdAt: 1
      })
      // 当前轮次（runId=1）的迟到 running / completed 都不能覆盖取消终态
      inject({ protocolVersion: HERMES_PROTOCOL_VERSION, id: 't20-late-running', type: 'task.progress', taskId, runId: 1, snapshot: mkSnap('running') })
      eq(mgr.getTask(taskId)?.status, 'cancelled', '迟到 running 不覆盖 cancelled')
      inject({
        protocolVersion: HERMES_PROTOCOL_VERSION, id: 't20-late-done', type: 'task.progress', taskId, runId: 1,
        snapshot: { ...mkSnap('completed'), result: { summary: '伪造结论', findings: [], nextSteps: [] } }
      })
      eq(mgr.getTask(taskId)?.status, 'cancelled', '迟到 completed 不覆盖 cancelled')
      ok(mgr.getTask(taskId)!.result === undefined, '伪造结论未进入快照')
      // 迟到 checkpoint（当前轮次）不进 checkpoint Map
      const asMgr = mgr as unknown as { checkpoints: Map<string, unknown> }
      eq(asMgr.checkpoints.has(taskId), false, '取消任务无 checkpoint')
      inject({
        protocolVersion: HERMES_PROTOCOL_VERSION, id: 't20-late-cp', type: 'task.checkpoint',
        checkpoint: {
          protocolVersion: HERMES_PROTOCOL_VERSION, taskId, runId: 1, savedAt: 1, goal: 'x',
          context: { kind: 'global', capabilityContextId: 'c', label: '全局' },
          conversation: [], evidenceByRef: {}, nextEvidenceSeq: 0, okToolCalls: 0
        }
      })
      eq(asMgr.checkpoints.has(taskId), false, '取消后迟到 checkpoint 不进 Map')
    }
  },
  {
    name: 't21 runId 轮次门禁：第二轮开启后旧轮次 progress/checkpoint 迟到被拒；未知任务被拒',
    fn: async () => {
      const harness = makeHarness()
      const { tool } = makeSearchTool()
      const first = makeScriptedModel([toolCall('customer.search'), completeWith(['e1'])])
      const second = makeScriptedModel([toolCall('customer.search'), completeWith(['e1'], '第二轮结论')])
      let currentModel: HermesCompletion = first.fn
      const mgr = makeManager(harness, { modelComplete: (...args) => currentModel(...args), tools: [tool] })
      await startReady(mgr)
      const r = await mgr.startTask({ goal: '轮次测试' })
      const taskId = r.task!.taskId
      await waitFor('第一轮 completed', () => mgr.getTask(taskId)?.status === 'completed')
      currentModel = second.fn
      const c = await mgr.continueTask(taskId, '继续查')
      ok(c.ok, 'continue 开启第二轮（runId 递增）')
      await waitFor('第二轮 running', () => mgr.getTask(taskId)?.status === 'running')
      const inject = (msg: unknown): void => (mgr as unknown as { onChildMessage: (raw: unknown) => void }).onChildMessage(msg)
      const mkSnap = (status: string): HermesTask => ({
        taskId, status: status as HermesTask['status'], goal: '旧轮次', contextLabel: '全局', steps: [], evidence: [], createdAt: 1
      })
      // 旧轮次（runId=1）迟到 running / failed
      inject({ protocolVersion: HERMES_PROTOCOL_VERSION, id: 't21-old-running', type: 'task.progress', taskId, runId: 1, snapshot: mkSnap('running') })
      inject({
        protocolVersion: HERMES_PROTOCOL_VERSION, id: 't21-old-failed', type: 'task.progress', taskId, runId: 1,
        snapshot: { ...mkSnap('failed'), errorCode: 'timeout', errorMessage: '旧轮次伪造' }
      })
      await new Promise((res) => setTimeout(res, 100))
      ok(mgr.getTask(taskId)!.status === 'running' || mgr.getTask(taskId)!.status === 'completed', '旧轮次迟到消息未覆盖第二轮状态')
      eq(mgr.getTask(taskId)!.errorCode, undefined, '旧轮次伪造错误未进入快照')
      // 旧轮次迟到 checkpoint 不进 Map（先清掉第一轮合法 checkpoint 再验证）
      const asMgr = mgr as unknown as { checkpoints: Map<string, { runId: number }> }
      asMgr.checkpoints.delete(taskId)
      inject({
        protocolVersion: HERMES_PROTOCOL_VERSION, id: 't21-old-cp', type: 'task.checkpoint',
        checkpoint: {
          protocolVersion: HERMES_PROTOCOL_VERSION, taskId, runId: 1, savedAt: 2, goal: 'g',
          context: { kind: 'global', capabilityContextId: 'c', label: '全局' },
          conversation: [], evidenceByRef: {}, nextEvidenceSeq: 0, okToolCalls: 0
        }
      })
      eq(asMgr.checkpoints.has(taskId), false, '旧轮次 checkpoint 未进入 Map')
      // 第二轮合法消息不受影响：正常完成
      await waitFor('第二轮 completed', () => mgr.getTask(taskId)?.status === 'completed' && mgr.getTask(taskId)?.result?.summary === '第二轮结论')
      // 未知 taskId：progress/checkpoint 均被拒不凭空创建
      inject({ protocolVersion: HERMES_PROTOCOL_VERSION, id: 't21-ghost-p', type: 'task.progress', taskId: 'ghost-task', runId: 1, snapshot: mkSnap('running') })
      inject({
        protocolVersion: HERMES_PROTOCOL_VERSION, id: 't21-ghost-c', type: 'task.checkpoint',
        checkpoint: {
          protocolVersion: HERMES_PROTOCOL_VERSION, taskId: 'ghost-task', runId: 1, savedAt: 3, goal: 'g',
          context: { kind: 'global', capabilityContextId: 'c', label: '全局' },
          conversation: [], evidenceByRef: {}, nextEvidenceSeq: 0, okToolCalls: 0
        }
      })
      eq(mgr.getTask('ghost-task'), null, '未知 taskId progress 未创建任务')
      eq(asMgr.checkpoints.has('ghost-task'), false, '未知 taskId checkpoint 未入库')
    }
  },
  {
    name: 't22 首次崩溃恢复后：旧 runId 消息无法覆盖 failed/agent_unavailable 状态',
    fn: async () => {
      const harness = makeHarness()
      const gated = makeGatedTool(SEARCH_RESULT)
      const { fn: modelComplete } = makeScriptedModel([toolCall('customer.search')])
      const mgr = makeManager(harness, { modelComplete, tools: [gated.tool] })
      await startReady(mgr)
      const r = await mgr.startTask({ goal: '崩溃恢复轮次' })
      const taskId = r.task!.taskId
      await waitFor('工具执行在途', () => gated.calls.length === 1)
      harness.children[0].kill()
      await waitFor('failed/agent_unavailable', () => mgr.getTask(taskId)?.status === 'failed' && mgr.getTask(taskId)?.errorCode === 'agent_unavailable')
      await waitFor('重启 ready', () => mgr.getState() === 'ready' && harness.children.length === 2)
      gated.releaseAll()
      // 新 child 上线后，旧轮次消息直接注入消息入口也无法覆盖
      const inject = (msg: unknown): void => (mgr as unknown as { onChildMessage: (raw: unknown) => void }).onChildMessage(msg)
      inject({ protocolVersion: HERMES_PROTOCOL_VERSION, id: 't22-old-running', type: 'task.progress', taskId, runId: 1, snapshot: { taskId, status: 'running', goal: '旧轮次复活', contextLabel: '全局', steps: [], evidence: [], createdAt: 1 } })
      inject({
        protocolVersion: HERMES_PROTOCOL_VERSION, id: 't22-old-done', type: 'task.progress', taskId, runId: 1,
        snapshot: { taskId, status: 'completed', goal: '旧轮次复活', contextLabel: '全局', steps: [], evidence: [], createdAt: 1, result: { summary: '伪造', findings: [], nextSteps: [] } }
      })
      await new Promise((res) => setTimeout(res, 100))
      eq(mgr.getTask(taskId)!.status, 'failed', 'failed 终态不被旧 runId 消息复活')
      eq(mgr.getTask(taskId)!.errorCode, 'agent_unavailable', 'errorCode 保持 agent_unavailable')
    }
  },
  {
    name: 't23 Main→Utility 出口扫描：毒化 goal/question 拒发；脱敏被删时任务立即 boundary_violation',
    fn: async () => {
      // (a) 直打唯一出口：毒化 task.start / 禁止字段 / 干净消息对照
      const { forkProcess, fakes } = makeFakeFork()
      const logs: string[] = []
      const mgr = makeManager({ forkProcess }, { tools: [makeSearchTool().tool], log: (_l, m) => logs.push(m) })
      mgr.start()
      fakes[0].emitMessage({ protocolVersion: HERMES_PROTOCOL_VERSION, id: 't23-ready', type: 'ready' })
      await waitFor('ready', () => mgr.getState() === 'ready')
      const send = (mgr as unknown as { sendToUtility: (m: unknown) => boolean }).sendToUtility.bind(mgr)
      eq(send({
        protocolVersion: HERMES_PROTOCOL_VERSION, id: 't23-poison', type: 'task.start',
        taskId: 'eg-1', runId: 1, goal: '跟进 wxid_leak_77 的订单',
        context: { kind: 'global', capabilityContextId: 'eg-cap', label: '全局' }
      }), false, '毒化 goal（wxid_*）被出口拒发')
      ok(!fakes[0].inbox.some((m) => (m as MainToUtilityMessage).type === 'task.start'), 'Utility 未收到毒化 task.start')
      eq(send({
        protocolVersion: HERMES_PROTOCOL_VERSION, id: 't23-clean', type: 'task.start',
        taskId: 'eg-2', runId: 1, goal: '分析正常客户',
        context: { kind: 'global', capabilityContextId: 'eg-cap', label: '全局' }
      }), true, '干净 task.start 正常发出')
      ok(fakes[0].inbox.some((m) => (m as MainToUtilityMessage & { taskId?: string }).taskId === 'eg-2'), 'Utility 收到干净 task.start')
      eq(send({
        protocolVersion: HERMES_PROTOCOL_VERSION, id: 't23-forbidden', type: 'task.continue',
        taskId: 'eg-2', runId: 2, question: 'q', messageKey: 'LOCAL::x'
      } as Record<string, unknown>), false, '携带禁止字段 messageKey 的 task.continue 拒发（结构+扫描双闸）')
      ok(logs.some((l) => l.includes('task.start') && l.includes('违规') && !l.includes('wxid_leak_77')), '拒发日志含 type 与违规路径、不含违规原值')
      // (b) 调用点脱敏「被删除」（maskText 恒等模拟）：统一出口兜底，任务立即 failed/boundary_violation
      const harness = makeHarness()
      const logs2: string[] = []
      const { fn: modelComplete } = makeScriptedModel([toolCall('customer.search'), completeWith(['e1'])])
      const mgr2 = makeManager(harness, { modelComplete, tools: [makeSearchTool().tool], maskText: (s) => s, log: (_l, m) => logs2.push(m) })
      await startReady(mgr2)
      const bad = await mgr2.startTask({ goal: '跟进 wxid_leak_99 客户' })
      eq(bad.ok, false, '毒化 goal 的 startTask 失败')
      eq(bad.errorCode, 'boundary_violation', 'errorCode boundary_violation')
      eq(bad.task?.status, 'failed', '任务快照立即置 failed')
      eq(bad.task?.errorMessage, '本次查询未能安全处理，请重新发起任务。', '人话文案')
      ok(!harness.sent.some((m) => (m as MainToUtilityMessage).type === 'task.start'), '毒化任务未向 Utility 下发 task.start')
      ok(!logs2.some((l) => l.includes('wxid_leak_99')), '日志不含违规原值')
      // (c) continue 毒化 question：同样出口兜底
      const good = await mgr2.startTask({ goal: '干净目标' })
      ok(good.ok && !!good.task, '干净任务创建')
      const goodId = good.task!.taskId
      await waitFor('干净任务完成', () => mgr2.getTask(goodId)?.status === 'completed')
      const bad2 = await mgr2.continueTask(goodId, '追问 wxid_leak_55 的记录')
      eq(bad2.ok, false, '毒化 question 的 continue 失败')
      eq(bad2.errorCode, 'boundary_violation', 'continue errorCode boundary_violation')
      ok(!harness.sent.some((m) => (m as MainToUtilityMessage).type === 'task.continue'), '毒化 question 未下发 task.continue')
      eq(bad2.task?.errorCode, 'boundary_violation', '任务快照置 failed/boundary_violation')
      eq(bad2.task?.errorMessage, '本次查询未能安全处理，请重新发起任务。', 'continue 人话文案')
    }
  },
  {
    name: 't24 模型响应二次脱敏：模型文本里的手机号/wxid 进 Utility 前脱敏',
    fn: async () => {
      const harness = makeHarness()
      const { tool } = makeSearchTool()
      const { fn: modelComplete } = makeScriptedModel([
        toolCall('customer.search'),
        completeWith(['e1'], '结论：联系 13812345678 或 wxid_leak_009')
      ])
      const mgr = makeManager(harness, { modelComplete, tools: [tool] })
      await startReady(mgr)
      const r = await mgr.startTask({ goal: '模型响应脱敏测试', context: { kind: 'customer', accountId: 5, sessionId: 'wxid_real_001' } })
      const taskId = r.task!.taskId
      await waitFor('completed', () => mgr.getTask(taskId)?.status === 'completed')
      const respTexts = harness.sent
        .filter((m) => (m as MainToUtilityMessage).type === 'host.response' && (m as MainToUtilityMessage & { ok?: boolean }).ok === true)
        .map((m) => JSON.stringify(m)).join('\n')
      ok(respTexts.length > 0, '捕获成功 host.response')
      ok(!respTexts.includes('13812345678'), '回传 Utility 的模型文本不含手机号')
      ok(!respTexts.includes('wxid_leak_009'), '回传 Utility 的模型文本不含 wxid')
      ok(!respTexts.includes('wxid_real_001'), '回传 Utility 的模型文本不含宿主 sessionId')
      ok(respTexts.includes('***'), '敏感值已替换为 ***')
      const snapText = JSON.stringify(mgr.getTask(taskId))
      ok(!snapText.includes('13812345678') && !snapText.includes('wxid_leak_009'), 'UI 结论不含原值')
    }
  },
  {
    name: 't25 出口兜底（模型响应脱敏被删 → 快速 boundary_violation）+ 伪造 evidenceHandle 无法恢复锚点',
    fn: async () => {
      // (a) 模型文本未被调用点脱敏（maskText 恒等模拟）：出口扫描拒发 → Utility 收受控错误 → 任务快速终态
      const harness = makeHarness()
      const { tool } = makeSearchTool()
      const { fn: modelComplete } = makeScriptedModel([toolCall('customer.search'), completeWith(['e1'], '结论含 wxid_raw_42 泄漏')])
      const logs: string[] = []
      const mgr = makeManager(harness, { modelComplete, tools: [tool], maskText: (s) => s, log: (_l, m) => logs.push(m) })
      await startReady(mgr)
      const r = await mgr.startTask({ goal: '出口兜底测试' })
      const taskId = r.task!.taskId
      await waitFor('任务快速落定', () => mgr.getTask(taskId)?.status === 'failed' && mgr.getTask(taskId)?.errorCode === 'boundary_violation')
      eq(mgr.getTask(taskId)!.errorMessage, '本次查询未能安全处理，请重新发起任务。', '人话文案')
      const errResp = harness.sent.find((m) => (m as MainToUtilityMessage).type === 'host.response'
        && (m as MainToUtilityMessage & { error?: { code?: string } }).error?.code === 'boundary_violation')
      ok(!!errResp, 'Utility 收到 boundary_violation 受控错误（可立即收尾，不等超时）')
      ok(!JSON.stringify(harness.sent).includes('wxid_raw_42'), '带毒文本从未发出')
      ok(logs.some((l) => l.includes('host.response') && l.includes('违规') && !l.includes('wxid_raw_42')), '日志含 type/路径、不含违规原值')
      // (b) 伪造 evidenceHandle 无法恢复 messageKey 锚点（独立干净环境）
      const harness2 = makeHarness()
      const { tool: tool2 } = makeSearchTool()
      const { fn: modelComplete2 } = makeScriptedModel([toolCall('customer.search'), completeWith(['e1'])])
      const mgr2 = makeManager(harness2, { modelComplete: modelComplete2, tools: [tool2] })
      await startReady(mgr2)
      const r2 = await mgr2.startTask({ goal: '伪造 handle 测试', context: { kind: 'customer', accountId: 5, sessionId: 'wxid_real_002' } })
      const taskId2 = r2.task!.taskId
      await waitFor('completed', () => mgr2.getTask(taskId2)?.status === 'completed')
      ok(mgr2.getTask(taskId2)!.evidence.some((e) => e.messageKey === 'LOCAL::C:/db/test.db::wxid_secret001'), '真实登记 handle 恢复原始锚点')
      const currentRun = (mgr2 as unknown as { taskRunGeneration: Map<string, number> }).taskRunGeneration.get(taskId2)!
      ;(mgr2 as unknown as { onChildMessage: (raw: unknown) => void }).onChildMessage({
        protocolVersion: HERMES_PROTOCOL_VERSION, id: 't25-forged', type: 'task.progress', taskId: taskId2, runId: currentRun,
        snapshot: {
          taskId: taskId2, status: 'completed', goal: '伪造', contextLabel: '全局', steps: [],
          evidence: [{ ref: 'e9', label: '伪造证据', kind: 'chat', evidenceHandle: 'evh-999-forged' }],
          createdAt: 1, result: { summary: '伪造结论', findings: [], nextSteps: [] }
        }
      })
      const after = mgr2.getTask(taskId2)!
      ok(!JSON.stringify(after.evidence).includes('messageKey'), '伪造 handle 未恢复任何 messageKey')
      eq(after.evidence[0].label, '伪造证据', '无锚点条目仅保留脱敏展示面')
      ok(!JSON.stringify(after.evidence).includes('wxid_secret001'), '伪造 handle 未带回原始会话锚点值')
    }
  },
  {
    name: 't26 模型 await 期间指纹变化：原始模型结果不回 Utility、不进 UI',
    fn: async () => {
      const harness = makeHarness()
      const gatedModel = makeGatedModel(completeWith(['e1'], '竞态模型原始结果'))
      const fp = { value: 'fingerprint-A' }
      const mgr = makeManager(harness, {
        modelComplete: gatedModel.fn,
        tools: [makeSearchTool().tool],
        contextFingerprint: () => fp.value
      })
      await startReady(mgr)
      const r = await mgr.startTask({ goal: '模型竞态测试', context: { kind: 'chat', sessionId: 'wxid_model_race' } })
      const taskId = r.task!.taskId
      await waitFor('模型调用在途', () => gatedModel.calls.length === 1)
      fp.value = 'fingerprint-B'
      gatedModel.releaseAll()
      await waitFor('模型竞态任务 context_expired', () =>
        mgr.getTask(taskId)?.status === 'failed' && mgr.getTask(taskId)?.errorCode === 'context_expired')
      const snap = mgr.getTask(taskId)!
      eq(snap.result, undefined, '指纹变化后的模型结果不进入 UI 结论')
      eq(snap.evidence.length, 0, '指纹变化后的模型结果不进入 UI 证据')
      const successResponses = harness.sent.filter((m) => {
        const msg = m as MainToUtilityMessage & { taskId?: string; ok?: boolean; text?: string; result?: unknown }
        return msg.type === 'host.response' && msg.taskId === taskId && msg.ok === true
      })
      eq(successResponses.length, 0, '指纹变化后不发送成功 host.response')
      ok(!JSON.stringify(harness.sent).includes('竞态模型原始结果'), '模型原始结果不进入 Utility 消息')
    }
  },
  {
    name: 't30 工具 await 期间指纹变化：结果不回 Utility、不登记 evidenceHandle/anchor',
    fn: async () => {
      const harness = makeHarness()
      const gated = makeGatedTool(SEARCH_RESULT)
      const { fn: modelComplete } = makeScriptedModel([toolCall('customer.search'), completeWith(['e1'], '工具竞态完成')])
      const fp = { value: 'tool-fingerprint-A' }
      const mgr = makeManager(harness, {
        modelComplete,
        tools: [gated.tool],
        contextFingerprint: () => fp.value
      })
      await startReady(mgr)
      const r = await mgr.startTask({ goal: '工具竞态测试' })
      const taskId = r.task!.taskId
      await waitFor('工具调用在途', () => gated.calls.length === 1)
      fp.value = 'tool-fingerprint-B'
      gated.releaseAll()
      await waitFor('工具竞态任务 context_expired', () =>
        mgr.getTask(taskId)?.status === 'failed' && mgr.getTask(taskId)?.errorCode === 'context_expired')
      const snap = mgr.getTask(taskId)!
      eq(gated.calls.length, 1, '指纹失效后工具只执行首个在途调用')
      eq(snap.evidence.length, 0, '指纹变化后的工具结果不进入 UI 证据')
      eq(snap.result, undefined, '指纹变化后的工具结果不产生 UI 结论')
      const successResponses = harness.sent.filter((m) => {
        const msg = m as MainToUtilityMessage & { taskId?: string; ok?: boolean; result?: unknown }
        return msg.type === 'host.response' && msg.taskId === taskId && msg.ok === true && msg.result !== undefined
      })
      eq(successResponses.length, 0, '指纹变化后不发送成功工具 host.response')
      const anchors = (mgr as unknown as { evidenceAnchorsByTask: Map<string, Map<string, unknown>> }).evidenceAnchorsByTask
      eq(anchors.get(taskId)?.size || 0, 0, '指纹变化后不分配 evidenceHandle/登记 Main anchor')
      ok(!JSON.stringify(harness.sent).includes('客户：张三'), '工具原始结果不进入 Utility 消息')
    }
  },
  {
    name: 't27 第二轮零新工具终态 checkpoint 带 runId=2，崩溃恢复后第三轮上下文完整',
    fn: async () => {
      const harness = makeHarness()
      const { tool } = makeSearchTool()
      const first = makeScriptedModel([toolCall('customer.search'), completeWith(['e1'], '第一轮结论')])
      const second = makeScriptedModel([completeWith(['e1'], '第二轮结论')])
      let currentModel: HermesCompletion = first.fn
      const mgr = makeManager(harness, { modelComplete: (...args) => currentModel(...args), tools: [tool] })
      await startReady(mgr)
      const r = await mgr.startTask({ goal: '第一轮问题' })
      const taskId = r.task!.taskId
      await waitFor('第一轮 completed', () => mgr.getTask(taskId)?.status === 'completed')
      const asMgr = mgr as unknown as {
        checkpoints: Map<string, { runId: number; conversation: Array<{ content: string }>; evidenceByRef: Record<string, unknown> }>
        onCheckpoint: (cp: unknown) => void
      }
      const cp1 = JSON.parse(JSON.stringify(asMgr.checkpoints.get(taskId))) as typeof asMgr.checkpoints extends Map<string, infer V> ? V : never
      eq(cp1.runId, 1, '第一轮终态保存 runId=1 checkpoint')
      currentModel = second.fn
      const r2 = await mgr.continueTask(taskId, '第二轮问题：直接引用历史 e1')
      ok(r2.ok, '第二轮开启成功')
      await waitFor('第二轮 completed', () => mgr.getTask(taskId)?.status === 'completed' && mgr.getTask(taskId)?.result?.summary === '第二轮结论')
      const cp2 = asMgr.checkpoints.get(taskId)!
      eq(cp2.runId, 2, '第二轮零新工具终态保存 runId=2 checkpoint')
      ok(cp2.conversation.some((m) => m.content.includes('第二轮结论')), 'checkpoint 保留第二轮结论上下文')
      ok(cp2.evidenceByRef.e1 !== undefined, 'checkpoint 保留历史证据 e1')
      const lastCheckpoint = harness.received.filter((m) => (m as MainToUtilityMessage).type === 'task.checkpoint').pop() as
        MainToUtilityMessage & { type: 'task.checkpoint'; checkpoint: { taskId: string; runId: number } } | undefined
      eq(lastCheckpoint?.checkpoint.runId, 2, 'Utility 上行的第二轮终态 checkpoint runId=2')
      // 注入第一轮旧 checkpoint，Main 当前轮次门禁不得允许它覆盖第二轮。
      asMgr.onCheckpoint(cp1)
      eq(asMgr.checkpoints.get(taskId)?.runId, 2, '旧 runId=1 checkpoint 不覆盖当前 runId=2')

      harness.children[0].kill()
      await waitFor('第二轮恢复后 ready', () => mgr.getState() === 'ready' && harness.children.length === 2)
      const restore = harness.sent.filter((m) => (m as MainToUtilityMessage).type === 'restore').pop() as
        MainToUtilityMessage & { type: 'restore'; checkpoint: { taskId: string; runId: number; conversation: Array<{ content: string }> } } | undefined
      ok(!!restore, '第二轮完成后重启发送 restore')
      eq(restore?.checkpoint.runId, 2, '恢复只发送当前合法 runId=2 checkpoint')

      let thirdMessages: Array<{ role: string; content: string }> = []
      let releaseThird: (() => void) | null = null
      const thirdCompletion: HermesCompletion = async (messages, _timeoutMs, signal) => {
        thirdMessages = JSON.parse(JSON.stringify(messages))
        await new Promise<void>((resolve, reject) => {
          releaseThird = resolve
          if (signal.aborted) reject(new Error('aborted'))
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
        return completeWith(['e1'], '第三轮结论')
      }
      currentModel = thirdCompletion
      const r3 = await mgr.continueTask(taskId, '第三轮追问：为什么保留 e1')
      ok(r3.ok, '第三轮追问进入恢复任务')
      await waitFor('第三轮模型输入', () => thirdMessages.length > 0)
      const prompt = JSON.stringify(thirdMessages)
      ok(prompt.includes('第一轮问题'), '第三轮模型输入包含第一轮对话')
      ok(prompt.includes('第二轮问题：直接引用历史 e1'), '第三轮模型输入包含第二轮问题')
      ok(prompt.includes('第二轮结论'), '第三轮模型输入包含第二轮结论上下文')
      ok(prompt.includes('e1') && prompt.includes('客户：张三'), '第三轮模型输入包含历史证据 e1')
      eq(asMgr.checkpoints.get(taskId)?.runId, 2, '第三轮尚未终态时 checkpoint 仍是第二轮 runId=2')
      releaseThird?.()
      await waitFor('第三轮收尾', () => mgr.getTask(taskId)?.status === 'completed')
    }
  },
  {
    name: 't28 cancel/get 回显合法 runId；旧轮次不取消/读取当前任务',
    fn: async () => {
      const harness = makeHarness()
      const gatedModel = makeGatedModel(completeWith(['e1']))
      const mgr = makeManager(harness, { modelComplete: gatedModel.fn, tools: [makeSearchTool().tool] })
      await startReady(mgr)
      const child = harness.children[0]
      const post = (msg: unknown): void => child.postMessage(msg)
      const responseFor = (taskId: string, op: string, runId: number) => harness.received.find((m) => {
        const msg = m as MainToUtilityMessage & { taskId?: string; op?: string; runId?: number }
        return msg.type === 'task.response' && msg.taskId === taskId && msg.op === op && msg.runId === runId
      }) as (MainToUtilityMessage & { type: 'task.response'; runId: number; ok: boolean; errorCode?: string; snapshot?: { status: string } }) | undefined

      post({ protocolVersion: HERMES_PROTOCOL_VERSION, id: 't28-unknown-cancel', type: 'task.cancel', taskId: 'unknown-cancel', runId: 7 })
      post({ protocolVersion: HERMES_PROTOCOL_VERSION, id: 't28-unknown-get', type: 'task.get', taskId: 'unknown-get', runId: 8 })
      await waitFor('未知 cancel/get 回执', () => !!responseFor('unknown-cancel', 'cancel', 7) && !!responseFor('unknown-get', 'get', 8))
      eq(responseFor('unknown-cancel', 'cancel', 7)?.errorCode, 'not_found', '未知 cancel 通过 Utility 出口返回 not_found')
      eq(responseFor('unknown-get', 'get', 8)?.errorCode, 'not_found', '未知 get 通过 Utility 出口返回 not_found')

      const r = await mgr.startTask({ goal: '当前轮次 cancel/get 测试' })
      const taskId = r.task!.taskId
      await waitFor('模型调用在途', () => gatedModel.calls.length === 1)
      post({ protocolVersion: HERMES_PROTOCOL_VERSION, id: 't28-stale-cancel', type: 'task.cancel', taskId, runId: 2 })
      post({ protocolVersion: HERMES_PROTOCOL_VERSION, id: 't28-stale-get', type: 'task.get', taskId, runId: 2 })
      await waitFor('旧轮次 cancel/get 回执', () => !!responseFor(taskId, 'cancel', 2) && !!responseFor(taskId, 'get', 2))
      eq(responseFor(taskId, 'cancel', 2)?.errorCode, 'stale_run', '旧 runId cancel 不取消当前任务')
      eq(responseFor(taskId, 'get', 2)?.errorCode, 'stale_run', '旧 runId get 不读取当前任务')
      ok(mgr.getTask(taskId)?.status !== 'cancelled', '旧 runId cancel 后任务仍未取消')
      post({ protocolVersion: HERMES_PROTOCOL_VERSION, id: 't28-current-get', type: 'task.get', taskId, runId: 1 })
      await waitFor('当前轮次 get 回执', () => !!responseFor(taskId, 'get', 1))
      ok(responseFor(taskId, 'get', 1)?.ok === true, '当前 runId get 正常返回快照')
      mgr.cancelTask(taskId)
      gatedModel.releaseAll()
      await waitFor('当前轮次 cancel 生效', () => mgr.getTask(taskId)?.status === 'cancelled')
    }
  },
  {
    name: 't29 identity:set 回调主动失效 capability，并保持可选回调兼容',
    fn: async () => {
      const cfg = ConfigService.getInstance()
      const previousName = cfg.get('identityName')
      const previousRole = cfg.get('identityRole')
      const previousDismissed = cfg.get('identityOnboardingDismissed')
      try {
        const { forkProcess, fakes } = makeFakeFork()
        const mgr = makeManager({ forkProcess })
        mgr.start()
        fakes[0].emitMessage({ protocolVersion: HERMES_PROTOCOL_VERSION, id: 't29-ready', type: 'ready' })
        await waitFor('ready', () => mgr.getState() === 'ready')
        let changed = 0
        const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>()
        registerIdentityIpcHandlers({
          handle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) => { handlers.set(channel, handler) }
        } as never, {
          onIdentityChanged: () => {
            changed++
            mgr.invalidateCapabilities('identity_changed')
          }
        })
        const setHandler = handlers.get('identity:set')!
        const bad = await setHandler({}, { name: '', role: '销售' })
        eq((bad as { ok: boolean }).ok, false, '非法身份修改不触发失效回调')
        eq(changed, 0, '非法身份修改回调次数为 0')
        const r = await mgr.startTask({ goal: '身份修改失效测试' })
        const set = await setHandler({}, { name: 'Hermes 测试', role: '销售' })
        eq((set as { ok: boolean }).ok, true, '合法身份修改成功')
        eq(changed, 1, 'identity:set 调用可选 onIdentityChanged 回调一次')
        await waitFor('identity_changed 终止任务', () =>
          mgr.getTask(r.task!.taskId)?.status === 'failed' && mgr.getTask(r.task!.taskId)?.errorCode === 'context_expired')
        const mainSrc = readFileSync(MAIN_TS, 'utf8')
        const identitySrc = readFileSync(join(ROOT, 'electron', 'services', 'identityIpcHandlers.ts'), 'utf8')
        ok(identitySrc.includes('onIdentityChanged'), 'identity IPC 暴露可选变更回调')
        ok(mainSrc.includes("onIdentityChanged: () => hermesUtilityManager.invalidateCapabilities('identity_changed')"), 'main.ts 接线 identity_changed 主动失效')
      } finally {
        cfg.set('identityName', previousName)
        cfg.set('identityRole', previousRole)
        cfg.set('identityOnboardingDismissed', previousDismissed)
      }
    }
  },
  {
    name: 't31 failed/cancelled 每个 runId 仅发出一次终态 checkpoint',
    fn: async () => {
      const failedHarness = makeHarness()
      const failedModel = makeScriptedModel([completeWith([], '无工具结论')])
      const failedMgr = makeManager(failedHarness, { modelComplete: failedModel.fn, tools: [makeSearchTool().tool] })
      await startReady(failedMgr)
      const failed = await failedMgr.startTask({ goal: '失败终态 checkpoint 测试' })
      const failedTaskId = failed.task!.taskId
      await waitFor('失败终态', () => failedMgr.getTask(failedTaskId)?.status === 'failed')
      const failedCheckpoints = failedHarness.received.filter((m) => {
        const msg = m as MainToUtilityMessage & { taskId?: string; checkpoint?: { taskId: string; runId: number } }
        return msg.type === 'task.checkpoint' && msg.checkpoint?.taskId === failedTaskId
      }) as Array<MainToUtilityMessage & { type: 'task.checkpoint'; checkpoint: { taskId: string; runId: number } }>
      eq(failedCheckpoints.length, 1, 'failed runId=1 终态 checkpoint 只发出一次')
      eq(failedCheckpoints[0]?.checkpoint.runId, 1, 'failed checkpoint 携带当前 runId=1')

      const cancelledHarness = makeHarness()
      const cancelledModel = makeGatedModel(completeWith(['e1']))
      const cancelledMgr = makeManager(cancelledHarness, { modelComplete: cancelledModel.fn, tools: [makeSearchTool().tool] })
      await startReady(cancelledMgr)
      const started = await cancelledMgr.startTask({ goal: '取消终态 checkpoint 测试' })
      const cancelledTaskId = started.task!.taskId
      await waitFor('取消模型在途', () => cancelledModel.calls.length === 1)
      cancelledMgr.cancelTask(cancelledTaskId)
      cancelledModel.releaseAll()
      await waitFor('取消终态 checkpoint', () => cancelledHarness.received.some((m) => {
        const msg = m as MainToUtilityMessage & { checkpoint?: { taskId: string; runId: number } }
        return msg.type === 'task.checkpoint' && msg.checkpoint?.taskId === cancelledTaskId
      }))
      const cancelledCheckpoints = cancelledHarness.received.filter((m) => {
        const msg = m as MainToUtilityMessage & { checkpoint?: { taskId: string; runId: number } }
        return msg.type === 'task.checkpoint' && msg.checkpoint?.taskId === cancelledTaskId
      }) as Array<MainToUtilityMessage & { type: 'task.checkpoint'; checkpoint: { taskId: string; runId: number } }>
      eq(cancelledCheckpoints.length, 1, 'cancelled runId=1 终态 checkpoint 只发出一次')
      eq(cancelledCheckpoints[0]?.checkpoint.runId, 1, 'cancelled checkpoint 携带当前 runId=1')
    }
  },
  {
    name: 't32 打包资源缺失 fail-closed（任务4）：不 fork、不崩主程序、agent_missing 拒绝新任务',
    fn: async () => {
      let forkCalls = 0
      const neverFork = (): never => {
        forkCalls++
        throw new Error('产物缺失时绝不应 fork')
      }
      // 缺省 entryExists = existsSync(entryPath)：指向不存在的产物 → 直接 fail closed
      const missingEntry = join(ROOT, 'dist-electron', 'does-not-exist-hermesUtility.js')
      const missingMgr = createHermesUtilityManager({
        entryPath: missingEntry,
        forkProcess: neverFork,
        configured: () => true,
        identity: () => ({ name: '王销售', role: 'sales' }),
        contextFingerprint: () => 'test-fingerprint',
        log: () => {}
      })
      openManagers.push(missingMgr)
      missingMgr.start()
      eq(missingMgr.getState(), 'unavailable', '产物缺失 → 直接 unavailable（不消耗重启预算）')
      const r = await missingMgr.startTask({ goal: '缺失产物下发起任务' })
      eq(r.ok, false, 'startTask 被拒绝')
      eq(r.errorCode, 'agent_missing', 'errorCode = agent_missing（重装指引）')
      eq(forkCalls, 0, '绝不 fork（主程序不崩、不回退旧进程内 Agent）')

      // 注入式 entryExists：存在性检查可注入覆盖（同样的缺失结论）
      let injectedCalls = 0
      const injectedMgr = createHermesUtilityManager({
        entryPath: missingEntry,
        entryExists: () => { injectedCalls++; return false },
        forkProcess: neverFork,
        configured: () => true,
        identity: () => ({ name: '王销售', role: 'sales' }),
        log: () => {}
      })
      openManagers.push(injectedMgr)
      injectedMgr.start()
      ok(injectedCalls >= 1, '注入式 entryExists 被调用')
      eq(injectedMgr.getState(), 'unavailable', '注入式检查 false → 同样 fail closed')
    }
  },
  {
    name: 't33 fail-closed 状态机：协议不一致后迟到合法 ready 不恢复、exit 不重启不耗预算',
    fn: async () => {
      const { forkProcess, fakes } = makeFakeFork()
      const mgr = makeManager({ forkProcess })
      mgr.start()
      eq(fakes.length, 1, 'fork 了一次')
      fakes[0].emitMessage({ protocolVersion: HERMES_PROTOCOL_VERSION, id: 't33-ready', type: 'ready' })
      await waitFor('首个 child ready', () => mgr.getState() === 'ready')
      // 旧版本 child 上线：立即 fail closed（unavailable/protocol_mismatch + kill）
      fakes[0].emitMessage({ protocolVersion: HERMES_PROTOCOL_VERSION + 1, id: 't33-old-ready', type: 'ready' })
      await waitFor('立即 unavailable', () => mgr.getState() === 'unavailable')
      eq(fakes[0].killed, true, '旧版本 child 被 kill')
      // 旧 child 在真正退出前补发合法 v2 ready：必须被丢弃，服务不得恢复
      fakes[0].emitMessage({ protocolVersion: HERMES_PROTOCOL_VERSION, id: 't33-late-valid-ready', type: 'ready' })
      await new Promise((res) => setTimeout(res, 100))
      eq(mgr.getState(), 'unavailable', '迟到合法 ready 未恢复服务（保持 unavailable）')
      // 随后旧 child 真正退出：不得自动重启、不得消耗普通崩溃重启预算
      fakes[0].emitExit(1)
      await new Promise((res) => setTimeout(res, 300)) // 超过 restartDelayMs=200，若误重启此处必然出现第二个 fake
      eq(fakes.length, 1, 'exit 后无自动重启（fork 数量仍为 1）')
      eq(mgr.getState(), 'unavailable', 'exit 后仍保持 unavailable')
      const r = await mgr.startTask({ goal: 'fail-closed 后新任务' })
      eq(r.ok, false, '新任务被拒绝')
      eq(r.errorCode, 'protocol_mismatch', '新任务返回 protocol_mismatch（原因未被覆盖）')
    }
  },
  {
    name: 't34 在途任务保留 protocol_mismatch：协议不一致时运行中任务终止为 failed + 共享文案',
    fn: async () => {
      const harness = makeHarness()
      const gated = makeGatedModel(completeWith(['e1']))
      const mgr = makeManager(harness, { modelComplete: gated.fn, tools: [makeSearchTool().tool] })
      await startReady(mgr)
      const started = await mgr.startTask({ goal: '协议不一致时在途任务' })
      ok(started.ok && !!started.task, '任务已创建')
      const taskId = started.task!.taskId
      await waitFor('模型在途（任务 running）', () => gated.calls.length === 1)
      const inject = (msg: unknown): void => (mgr as unknown as { onChildMessage: (raw: unknown) => void }).onChildMessage(msg)
      // 协议版本不一致 fail closed：在途任务必须终止为 failed/protocol_mismatch + 共享人话文案
      inject({ protocolVersion: HERMES_PROTOCOL_VERSION + 1, id: 't34-old-ready', type: 'ready' })
      await waitFor('任务终止', () => mgr.getTask(taskId)?.status === 'failed')
      const snap = mgr.getTask(taskId)!
      eq(snap.errorCode, 'protocol_mismatch', '在途任务 errorCode = protocol_mismatch（非 agent_unavailable）')
      eq(snap.errorMessage, HERMES_ERROR_MESSAGES.protocol_mismatch, 'errorMessage 使用共享错误文案')
      eq(mgr.getState(), 'unavailable', '服务 fail closed')
      // 旧 child 补发合法 v2 ready 必须被丢弃；其真正退出后不得自动重启、终态原因不被改写
      inject({ protocolVersion: HERMES_PROTOCOL_VERSION, id: 't34-late-ready', type: 'ready' })
      await waitFor('旧 child 真正退出', () => harness.children[0].exited)
      await new Promise((res) => setTimeout(res, 300)) // 超过 restartDelayMs=200，若误重启此处必然出现第二个 child
      eq(harness.children.length, 1, '无自动重启（fork 数量仍为 1）')
      eq(mgr.getState(), 'unavailable', '迟到 ready 未恢复服务')
      const after = mgr.getTask(taskId)!
      eq(after.errorCode, 'protocol_mismatch', '终态原因未被 exit/迟到消息改写')
      eq(after.errorMessage, HERMES_ERROR_MESSAGES.protocol_mismatch, '共享文案保持')
    }
  },
  {
    name: 't35 protocolCorrectionCount 按轮次重置：第一轮纠偏=1、第二轮无纠偏=0、旧轮次迟到快照不污染',
    fn: async () => {
      const harness = makeHarness()
      const { tool } = makeSearchTool()
      // 第一轮：首条输出非法 → 纠偏 1 次 → 工具 → 合法 complete
      const first = makeScriptedModel(['这不是协议输出', toolCall('customer.search'), completeWith(['e1'])])
      // 第二轮：无任何纠偏
      const second = makeScriptedModel([toolCall('customer.search'), completeWith(['e1'], '第二轮结论')])
      let currentModel: HermesCompletion = first.fn
      const mgr = makeManager(harness, { modelComplete: (...args) => currentModel(...args), tools: [tool] })
      await startReady(mgr)
      const r = await mgr.startTask({ goal: '纠偏计数轮次测试' })
      ok(r.ok && !!r.task, '任务创建')
      const taskId = r.task!.taskId
      await waitFor('第一轮 completed', () => mgr.getTask(taskId)?.status === 'completed')
      eq(mgr.getTask(taskId)!.protocolCorrectionCount, 1, '第一轮发生 1 次纠偏，计数 = 1')
      currentModel = second.fn
      const c = await mgr.continueTask(taskId, '继续查')
      ok(c.ok, 'continue 开启第二轮（新 runId）')
      await waitFor('第二轮 completed', () => mgr.getTask(taskId)?.status === 'completed' && mgr.getTask(taskId)?.result?.summary === '第二轮结论')
      eq(mgr.getTask(taskId)!.protocolCorrectionCount, 0, '第二轮无纠偏，计数重置为 0（不携带上一轮）')
      // 旧 runId 迟到快照（伪造计数 1）不得污染新轮次
      const inject = (msg: unknown): void => (mgr as unknown as { onChildMessage: (raw: unknown) => void }).onChildMessage(msg)
      inject({
        protocolVersion: HERMES_PROTOCOL_VERSION, id: 't35-stale', type: 'task.progress', taskId, runId: 1,
        snapshot: { taskId, status: 'completed', goal: '旧轮次', contextLabel: '全局', steps: [], evidence: [], protocolCorrectionCount: 7, createdAt: 1 }
      })
      eq(mgr.getTask(taskId)!.protocolCorrectionCount, 0, '旧 runId 迟到快照被轮次门禁丢弃，新轮次计数不变')
    }
  }
]

// ─── 主流程 ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`── Hermes UtilityProcess 动态测试（${tests.length} 场景，真实 fork Utility）──`)
  for (const t of tests) {
    try {
      await t.fn()
      pass++
      console.log(`✅ ${t.name}`)
    } catch (e) {
      fail++
      console.error(`❌ ${t.name}\n   ${(e as Error).message}`)
    } finally {
      for (const m of openManagers) { try { await m.shutdown() } catch { /* 已停止 */ } }
      openManagers.length = 0
    }
  }
  console.log(`\n${fail === 0 ? '🎉 全部通过' : '⚠️ 存在失败'}：${pass} 通过 / ${fail} 失败`)
  process.exit(fail === 0 ? 0 : 1)
}

void main()
