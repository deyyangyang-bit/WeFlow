/**
 * hermes-utility-test.ts —— 任务 3/4：Hermes UtilityProcess 动态集成测试
 *
 * 真实 fork Utility 子进程（electron/hermes/hermesUtilityEntry.ts，经 tsx + IPC shim 以
 * node child_process 模拟 Electron utilityProcess 通道）跑通 Main Manager ↔ Utility 全链路：
 *  - t1  ready + 协议 v1 握手（init 清单只含公开元数据四字段）
 *  - t2  start → 工具 → 模型 → complete 全链路 + 隐私（真实 sessionId 不进模型出站、
 *        不进 Utility 工具上下文之外任何面；messageKey 被剥离；identity 在 Main 侧映射）
 *  - t3  progress 顺序（planning → running → … → completed，快照结构合法）
 *  - t4  白名单外工具被拒（Utility 清单层 + Main 桥 re-validate 层：capabilityContextId
 *        不匹配 → forbidden；工具不在白名单 → not_whitelisted）
 *  - t5  畸形消息 / 错误协议版本被拒（Manager 丢弃不崩，服务继续可用）
 *  - t6  模型请求期间取消：Main abort 模型请求 + Utility 收 task.cancel
 *  - t7  工具执行期间取消：结果被丢弃（不登记证据、不产生完成步骤）
 *  - t8  第一次崩溃：自动重启并回到 ready（每应用生命周期至多一次）
 *  - t9  已收尾任务跨 Utility 重启恢复并可继续追问（checkpoint 还原证据表/对话）
 *  - t10 运行中任务随崩溃置 failed/agent_unavailable（严禁回退旧进程内 Agent）
 *  - t11 第二次崩溃：fail closed → unavailable，startTask 拒绝
 *  - t12 shutdown：通知 → 退出，无孤儿进程；之后 startTask 拒绝
 *  - t13 静态红线：Utility 入口零禁用 import（electron/DB/AI/配置/队列/日志/旧服务壳）；
 *        main.ts 生产接线改走 Manager 且不再 import 旧进程内 Agent
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
import type { MainToUtilityMessage } from '../shared/hermesProtocol'

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

/** 测试 harness：真实 fork Utility 入口 + 发送记录窥视 */
function makeHarness(): { forkProcess: HermesUtilityFork; children: TrackedChild[]; sent: unknown[] } {
  const children: TrackedChild[] = []
  const sent: unknown[] = []
  const forkProcess: HermesUtilityFork = (modulePath) => {
    const child: ChildProcess = fork(modulePath, [], {
      execArgv: ['--import', 'tsx', '--require', SHIM_CJS],
      env: { ...process.env, HERMES_UTILITY_IPC_SHIM: '1' }
    })
    const tracked: TrackedChild = {
      postMessage: (msg) => { sent.push(msg); child.send(msg) },
      on: ((event: 'message' | 'exit', cb: (arg: never) => void) => {
        if (event === 'message') {
          child.on('message', (m) => (cb as (m: unknown) => void)(m))
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
  return { forkProcess, children, sent }
}

/** 建一个接好测试依赖的 Manager（configured=true / 假身份 / 可注入模型与工具） */
function makeManager(
  harness: ReturnType<typeof makeHarness>,
  opts?: { modelComplete?: HermesCompletion; tools?: HermesToolDef[] }
): Manager {
  const mgr = createHermesUtilityManager({
    entryPath: ENTRY_TS,
    forkProcess: harness.forkProcess,
    configured: () => true,
    identity: () => ({ name: '王销售', role: 'sales' }),
    modelComplete: opts?.modelComplete,
    tools: opts?.tools,
    timings: { restartDelayMs: 200 }
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

// ─── 13 个动态场景 ────────────────────────────────────────────────────────────

const tests: Array<{ name: string; fn: () => Promise<void> }> = [
  {
    name: 't1 ready + 协议 v1 握手（init 清单只含公开元数据）',
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
      eq(snap.evidence[0].messageKey, undefined, '证据 messageKey 已剥离（绝不出宿主）')
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
        protocolVersion: 1, id: 'hm-test-forged-1', type: 'host.request',
        request: { capability: 'tool.execute', requestId: 'raw-1', taskId, capabilityContextId: 'forged-cap', tool: 'customer.search', arguments: {} }
      })
      const resp1 = findHostResponse(harness.sent, 'raw-1')
      ok(!!resp1 && resp1.ok === false && resp1.error?.code === 'forbidden', 'capId 不匹配 → Main 拒绝（forbidden）')
      asMgr.onChildMessage({
        protocolVersion: 1, id: 'hm-test-forged-2', type: 'host.request',
        request: { capability: 'tool.execute', requestId: 'raw-2', taskId, capabilityContextId: 'forged-cap', tool: 'evil.exfiltrate', arguments: {} }
      })
      const resp2 = findHostResponse(harness.sent, 'raw-2')
      ok(!!resp2 && resp2.ok === false && resp2.error?.code === 'forbidden', '未知 taskId 请求 → Main 拒绝')
      ok(!JSON.stringify(harness.sent).includes('"raw-1"') || findHostResponse(harness.sent, 'raw-1')!.error !== undefined, '被拒请求没有产生任何工具结果回传')
    }
  },
  {
    name: 't5 畸形消息 / 错误协议版本被拒（不崩，服务继续可用）',
    fn: async () => {
      const harness = makeHarness()
      const { tool } = makeSearchTool()
      const { fn: modelComplete } = makeScriptedModel([toolCall('customer.search'), completeWith(['e1'])])
      const mgr = makeManager(harness, { modelComplete, tools: [tool] })
      await startReady(mgr)
      const asMgr = mgr as unknown as { onChildMessage: (raw: unknown) => void }
      asMgr.onChildMessage('garbage-string')
      asMgr.onChildMessage(null)
      asMgr.onChildMessage({ protocolVersion: 2, id: 'hm-x', type: 'ready' })
      asMgr.onChildMessage({ protocolVersion: 1, id: 'hm-y', type: 'ready', messageKey: 'LOCAL::C:/x' })
      asMgr.onChildMessage({ protocolVersion: 1, id: 'hm-z', type: 'task.progress', taskId: 'fake', snapshot: { bogus: true } })
      eq(mgr.getState(), 'ready', '畸形消息后状态仍 ready')
      // 随后正常任务仍能完成
      const r = await mgr.startTask({ goal: '畸形之后仍可用' })
      ok(r.ok, '畸形消息后 startTask 仍成功')
      const taskId = r.task!.taskId
      await waitFor('task completed', () => mgr.getTask(taskId)?.status === 'completed')
      eq(mgr.getTask(taskId)!.result?.summary, '测试结论', '正常任务未受影响')
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
      harness.children[0].kill() // 崩溃 → 重启 → restore checkpoint
      await waitFor('重启后 ready', () => mgr.getState() === 'ready' && harness.children.length === 2)
      eq(mgr.getTask(taskId)!.status, 'completed', '重启后快照保持 completed')
      // 继续追问：checkpoint 还原的证据表/对话可用，e1 仍有效
      currentModel = second.fn
      const r2 = await mgr.continueTask(taskId, '再讲讲细节')
      ok(r2.ok, 'continueTask 成功')
      await waitFor('继续轮 completed', () => mgr.getTask(taskId)?.status === 'completed' && (mgr.getTask(taskId)!.result?.summary === '继续结论'))
      eq(mgr.getTask(taskId)!.result?.summary, '继续结论', '继续轮结论来自新模型脚本')
      eq(mgr.getTask(taskId)!.evidence[0].label, '客户：张三', '还原的证据表支持结论重建')
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
      ok(mainSrc.includes('hermesUtilityEntry.js'), 'main.ts 指向 Utility 构建产物')
      ok(mainSrc.includes('utilityProcess.fork'), 'main.ts 用 Electron utilityProcess.fork')
      ok(mainSrc.includes("await hermesUtilityManager.shutdown()"), '退出流程先结束 Utility')
      ok(!mainSrc.includes("from './services/hermesAgent'"), 'main.ts 不再 import 旧进程内 Agent 服务')
      ok(mainSrc.includes("from './hermes/hermesUtilityManager'"), 'main.ts import Manager')
      // vite 构建
      const viteSrc = readFileSync(VITE_TS, 'utf8')
      ok(viteSrc.includes('hermesUtilityEntry.ts'), 'vite 增加 Utility 入口构建')
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
