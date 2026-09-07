/**
 * hermesUtilityEntry.ts —— Hermes UtilityProcess 入口（任务 3/4）
 *
 * 运行在 Electron UtilityProcess 子进程内（生产经 utilityProcess.fork 加载构建产物
 * hermesUtilityEntry.js；动态测试经 tsx + IPC shim 以 node child_process fork 同一入口）。
 *
 * 职责边界（铁律，hermes-utility-test t13 静态红线锚点）：
 *  - 只承载 Agent Loop（复用 hermesAgentCore，唯一 Loop 真源）与任务运行时状态（内存 Map），
 *    零持久化、零数据库访问、不发任何模型请求——模型补全与工具执行一律经 host.request 回宿主；
 *    Main 是唯一可信宿主：API Key / ConfigService / 工具白名单 / 真实身份与 sessionId 全在 Main
 *  - Utility 侧上下文只有脱敏形态 HermesUtilityContext（capabilityContextId 不透明 ID +
 *    accountId + 人话 label）；工具执行上下文（identity/sessionId）由 Main 按
 *    capabilityContextId 映射构造，Utility 从不掌握真实会话锚点
 *  - 出站脱敏最终关卡在 Main（模型出网前最终隐私检查 + 工具结果回传前再脱敏）：
 *    Utility 侧 maskText/maskId 为恒等，不掌握脱敏函数与规则
 *  - parentPort 关闭 / 收到 shutdown → 自行退出；Main 退出流程先结束 Utility 再关数据库
 *  - 协议：shared/hermesProtocol v1 唯一真源；入口校验不过 = 丢弃；
 *    显式版本不一致 → fatal(protocol_mismatch)（重试无用，Main 直接 fail closed）
 *  - 多任务并发：每个任务一个 Core 实例（completion/executeTool 闭包绑定 taskId），
 *    host.request 互不串线；Core 本身无状态（状态在 rt）
 */
import {
  HermesAgentCore,
  FRIENDLY_ERROR,
  TASK_DEADLINE_MS,
  type HermesAgentTaskRuntime,
  type HermesCompletion
} from '../services/hermesAgentCore'
import type { HermesToolDef, HermesToolResult } from '../services/hermesToolRegistry'
import {
  HERMES_PROTOCOL_VERSION,
  createHermesMessageId,
  isMainToUtilityMessage,
  isUtilityToMainMessage,
  type HermesCheckpoint,
  type HermesHostRequest,
  type HermesProtocolTaskSnapshot,
  type HermesToolManifestEntry,
  type HermesUtilityContext,
  type MainToUtilityMessage,
  type UtilityToMainMessage
} from '../../shared/hermesProtocol'

// ─── 类型 ────────────────────────────────────────────────────────────────────

/** Utility 侧端口最小面（Electron parentPort 子集；测试 shim 同形） */
export interface HermesUtilityPort {
  postMessage(msg: unknown): void
  on(event: 'message', cb: (e: { data: unknown }) => void): void
  on(event: 'close', cb: () => void): void
}

/** host.request 应答载荷（Main → Utility 的 host.response 解包） */
interface HostResponsePayload {
  ok: boolean
  text?: string
  result?: HermesToolResult
  error?: { code: string; message: string }
}

/** host.request 载荷去关联字段（分布式 Omit，保持 model.complete / tool.execute 两分支形态） */
type HostRequestPayload<T> = T extends unknown ? Omit<T, 'requestId' | 'taskId'> : never

/** 任务表上限（与 Main 侧快照缓存同规模，FIFO） */
const MAX_TASKS = 50

// ─── 入口主逻辑 ──────────────────────────────────────────────────────────────

export function runHermesUtility(port: HermesUtilityPort): void {
  let initialized = false
  const tasks = new Map<string, HermesAgentTaskRuntime>()
  const contextByTask = new Map<string, HermesUtilityContext>()
  const checkpointMark = new Map<string, { okToolCalls: number; status: string }>()
  const pending = new Map<string, { settle: (p: HostResponsePayload) => void }>()
  let manifestTools: HermesToolDef[] = []

  /** 日志（Utility 子进程无 salesLog/文件通道，与现有 worker 一致走 stdout；只记状态不记内容） */
  const log = (level: 'INFO' | 'WARN' | 'ERROR', msg: string): void => {
    if (level === 'ERROR') console.error(`[HermesUtility][ERROR] ${msg}`)
    else if (level === 'WARN') console.warn(`[HermesUtility][WARN] ${msg}`)
    else console.log(`[HermesUtility][INFO] ${msg}`)
  }

  /** 出站发送（发送前协议校验；非法出站消息一律拒发并记日志） */
  const send = (msg: UtilityToMainMessage): void => {
    if (!isUtilityToMainMessage(msg)) {
      log('WARN', `拒绝发送非法出站消息 type=${String((msg as { type?: unknown }).type)}`)
      return
    }
    port.postMessage(msg)
  }

  // ── host.request 通道 ──────────────────────────────────────────────────────

  /** 发 host.request 并等待 host.response（requestId 关联；signal abort / 超时兜底失败） */
  function hostRequest(
    taskId: string,
    req: HostRequestPayload<HermesHostRequest>,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<HostResponsePayload> {
    return new Promise((resolve, reject) => {
      const requestId = createHermesMessageId()
      let timer: ReturnType<typeof setTimeout>
      let settled = false
      const onAbort = (): void => fail(new Error('aborted'))
      const fail = (err: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        pending.delete(requestId)
        reject(err)
      }
      const settle = (p: HostResponsePayload): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        pending.delete(requestId)
        resolve(p)
      }
      timer = setTimeout(() => fail(new Error('host request timeout')), Math.max(1_000, timeoutMs))
      if (signal) {
        if (signal.aborted) { fail(new Error('aborted')); return }
        signal.addEventListener('abort', onAbort, { once: true })
      }
      pending.set(requestId, { settle })
      send({
        protocolVersion: HERMES_PROTOCOL_VERSION,
        id: createHermesMessageId(),
        type: 'host.request',
        request: { ...req, requestId, taskId } as HermesHostRequest
      })
    })
  }

  /** 为单个任务构建 Core：completion/executeTool 闭包绑定 taskId（多任务并发互不串线） */
  function createCore(taskId: string, capId: string): HermesAgentCore {
    // 模型补全走 host.request：API Key 与出网都在 Main（出网前 Main 做最终隐私检查）
    const completion: HermesCompletion = (messages, timeoutMs, signal) =>
      hostRequest(
        taskId,
        { capability: 'model.complete', messages: messages.map((m) => ({ ...m })), timeoutMs },
        timeoutMs,
        signal
      ).then((p) => {
        if (!p.ok || typeof p.text !== 'string') {
          throw new Error(p.error?.code || 'ai_error')
        }
        return p.text
      })
    return new HermesAgentCore({
      completion,
      // init 下发的白名单清单（只有公开元数据；Main 是白名单与执行唯一真源，run 永不本地调用）
      tools: manifestTools,
      // 工具执行走 host.request：真实身份/sessionId 由 Main 按 capId 映射，结果回传前 Main 再脱敏
      executeTool: (tool, args) =>
        hostRequest(
          taskId,
          { capability: 'tool.execute', capabilityContextId: capId, tool: tool.name, arguments: args },
          TASK_DEADLINE_MS
        ).then((p) => {
          if (!p.ok) {
            const code = p.error?.code || 'internal'
            // 取消走异常路径（Core 在安全点丢弃在途结果）；其余按工具失败回喂
            if (code === 'cancelled') throw new Error('cancelled')
            return { ok: false, publicSummary: p.error?.message || '查询失败', errorCode: code }
          }
          return p.result ?? { ok: false, publicSummary: '查询失败', errorCode: 'internal' }
        }),
      // 出站脱敏最终关卡在 Main；Utility 侧恒等（不掌握脱敏函数与规则）
      maskText: (s) => s,
      maskId: (s) => s,
      onUpdate: (rt) => { emitProgress(rt); maybeCheckpoint(rt) },
      log
    })
  }

  // ── 任务运行时 ─────────────────────────────────────────────────────────────

  /** 建任务运行时（上下文只有协议脱敏形态；真实 identity/sessionId 不进 Utility） */
  function buildRuntime(taskId: string, goal: string, context: HermesUtilityContext): HermesAgentTaskRuntime {
    const now = Date.now()
    return {
      task: {
        taskId,
        status: 'planning',
        goal,
        contextLabel: context.label,
        steps: [],
        evidence: [],
        createdAt: now
      },
      conversation: [],
      evidenceByRef: new Map(),
      nextEvidenceSeq: 0,
      lastCallKey: '',
      deadlineAt: now + TASK_DEADLINE_MS,
      abort: null,
      cancelRequested: false,
      turnRunning: false,
      okToolCalls: 0,
      unresolvedToolFailure: false,
      dataRetries: 0,
      // 身份只作占位：工具上下文由 Main 映射真实身份，Utility 侧恒为匿名
      identity: { name: '', role: '' },
      contextKind: context.kind,
      accountId: context.accountId,
      sessionId: undefined
    }
  }

  /** 快照 → 协议形态（防御性重建：messageKey 不可能出现在 Utility，此处结构性排除） */
  function toProtocolSnapshot(rt: HermesAgentTaskRuntime): HermesProtocolTaskSnapshot {
    return {
      taskId: rt.task.taskId,
      status: rt.task.status,
      goal: rt.task.goal,
      contextLabel: rt.task.contextLabel,
      steps: rt.task.steps.map((s) => ({ ...s })),
      evidence: rt.task.evidence.map((e) => ({
        ref: e.ref,
        label: e.label,
        kind: e.kind,
        entityId: e.entityId,
        excerpt: e.excerpt
      })),
      result: rt.task.result
        ? {
            summary: rt.task.result.summary,
            findings: rt.task.result.findings.map((f) => ({ ...f })),
            nextSteps: [...rt.task.result.nextSteps]
          }
        : undefined,
      errorCode: rt.task.errorCode,
      errorMessage: rt.task.errorMessage,
      createdAt: rt.task.createdAt
    }
  }

  /** 脱敏 checkpoint（证据表显式重建，messageKey 结构性排除；绝不出宿主） */
  function toCheckpoint(rt: HermesAgentTaskRuntime): HermesCheckpoint {
    const context = contextByTask.get(rt.task.taskId)!
    return {
      protocolVersion: HERMES_PROTOCOL_VERSION,
      taskId: rt.task.taskId,
      savedAt: Date.now(),
      goal: rt.task.goal,
      context,
      conversation: rt.conversation.map((m) => ({ ...m })),
      evidenceByRef: Object.fromEntries(
        [...rt.evidenceByRef.entries()].map(([ref, ev]) => [ref, {
          label: ev.label,
          kind: ev.kind,
          entityId: ev.entityId,
          excerpt: ev.excerpt
        }])
      ),
      nextEvidenceSeq: rt.nextEvidenceSeq,
      okToolCalls: rt.okToolCalls
    }
  }

  function emitProgress(rt: HermesAgentTaskRuntime): void {
    send({
      protocolVersion: HERMES_PROTOCOL_VERSION,
      id: createHermesMessageId(),
      type: 'task.progress',
      taskId: rt.task.taskId,
      snapshot: toProtocolSnapshot(rt)
    })
  }

  /** checkpoint 触发：每次成功的工具结果后（okToolCalls 变化）与任务终态后 */
  function maybeCheckpoint(rt: HermesAgentTaskRuntime): void {
    const mark = checkpointMark.get(rt.task.taskId)
    const terminal = rt.task.status === 'completed' || rt.task.status === 'failed' || rt.task.status === 'cancelled'
    const okChanged = !mark || mark.okToolCalls !== rt.okToolCalls
    const wentTerminal = terminal && (!mark || mark.status !== rt.task.status)
    if (!okChanged && !wentTerminal) return
    checkpointMark.set(rt.task.taskId, { okToolCalls: rt.okToolCalls, status: rt.task.status })
    if (!contextByTask.has(rt.task.taskId)) return
    send({
      protocolVersion: HERMES_PROTOCOL_VERSION,
      id: createHermesMessageId(),
      type: 'task.checkpoint',
      checkpoint: toCheckpoint(rt)
    })
  }

  function sendTaskResponse(
    taskId: string,
    op: 'start' | 'continue' | 'cancel' | 'get',
    ok: boolean,
    rt?: HermesAgentTaskRuntime,
    errorCode?: string
  ): void {
    send({
      protocolVersion: HERMES_PROTOCOL_VERSION,
      id: createHermesMessageId(),
      type: 'task.response',
      taskId,
      op,
      ok,
      snapshot: rt ? toProtocolSnapshot(rt) : undefined,
      errorCode
    })
  }

  /** Loop 兜底：Core 内部已兜底一切已知失败，这里防意外异常把任务卡死在 running */
  function runTurnGuarded(core: HermesAgentCore, rt: HermesAgentTaskRuntime, question: string): void {
    void core.runTurn(rt, question).catch((e) => {
      if (!rt.cancelRequested && rt.task.status !== 'cancelled') {
        rt.task.status = 'failed'
        rt.task.errorCode = 'internal'
        rt.task.errorMessage = FRIENDLY_ERROR.internal
        emitProgress(rt)
      }
      log('ERROR', `${rt.task.taskId} Loop 意外异常: ${(e as Error)?.message || e}`)
    })
  }

  function evictTasks(): void {
    while (tasks.size > MAX_TASKS) {
      const oldest = tasks.keys().next().value
      if (oldest === undefined) break
      tasks.delete(oldest)
      contextByTask.delete(oldest)
      checkpointMark.delete(oldest)
    }
  }

  // ── 消息处理 ───────────────────────────────────────────────────────────────

  function onInit(tools: HermesToolManifestEntry[]): void {
    if (initialized) return
    initialized = true
    manifestTools = tools.map((t) => ({
      name: t.name,
      publicLabel: t.publicLabel,
      description: t.description,
      argsHint: t.argsHint,
      // run 永不本地调用：工具执行一律 host.request 由 Main 执行（此实现仅为满足 Core 类型面）
      run: async (): Promise<HermesToolResult> => ({ ok: false, publicSummary: '查询失败', errorCode: 'internal' })
    }))
    log('INFO', `init 完成，白名单 ${manifestTools.length} 个工具`)
    send({ protocolVersion: HERMES_PROTOCOL_VERSION, id: createHermesMessageId(), type: 'ready' })
  }

  /** 已收尾任务恢复（跨 Utility 重启的 checkpoint）：重建对话窗口与证据表，恢复为可继续
   *  追问的静止态（快照展示仍由 Main 侧缓存负责，Utility 只服务 continue 的执行面） */
  function restoreFromCheckpoint(cp: HermesCheckpoint): void {
    if (tasks.has(cp.taskId)) return
    const evidence = Object.entries(cp.evidenceByRef).map(([ref, ev]) => ({ ...ev, ref }))
    const rt: HermesAgentTaskRuntime = {
      task: {
        taskId: cp.taskId,
        status: 'completed',
        goal: cp.goal,
        contextLabel: cp.context.label,
        steps: [],
        evidence,
        createdAt: cp.savedAt
      },
      conversation: cp.conversation.map((m) => ({ ...m })),
      evidenceByRef: new Map(Object.entries(cp.evidenceByRef).map(([ref, ev]) => [ref, { ...ev }])),
      nextEvidenceSeq: cp.nextEvidenceSeq,
      lastCallKey: '',
      deadlineAt: Date.now(),
      abort: null,
      cancelRequested: false,
      turnRunning: false,
      okToolCalls: cp.okToolCalls,
      unresolvedToolFailure: false,
      dataRetries: 0,
      identity: { name: '', role: '' },
      contextKind: cp.context.kind,
      accountId: cp.context.accountId,
      sessionId: undefined
    }
    tasks.set(cp.taskId, rt)
    contextByTask.set(cp.taskId, cp.context)
    log('INFO', `恢复任务 ${cp.taskId}（对话 ${rt.conversation.length} 条 / 证据 ${evidence.length} 条）`)
  }

  function onStart(taskId: string, goal: string, context: HermesUtilityContext): void {
    if (tasks.has(taskId)) { log('WARN', `任务重复 start: ${taskId}`); return }
    const rt = buildRuntime(taskId, goal, context)
    tasks.set(taskId, rt)
    contextByTask.set(taskId, context)
    evictTasks()
    emitProgress(rt)
    runTurnGuarded(createCore(taskId, context.capabilityContextId), rt, goal)
  }

  function onContinue(taskId: string, question: string): void {
    const rt = tasks.get(taskId)
    if (!rt) { sendTaskResponse(taskId, 'continue', false, undefined, 'not_found'); return }
    if (rt.turnRunning || rt.task.status === 'running' || rt.task.status === 'planning') {
      sendTaskResponse(taskId, 'continue', false, undefined, 'busy')
      return
    }
    if (rt.cancelRequested) { sendTaskResponse(taskId, 'continue', false, undefined, 'cancelled'); return }
    // 新一轮：清上轮步骤/错误；对话窗口与证据表保留（与 in-process 服务语义一致）
    rt.task.steps = []
    rt.task.result = undefined
    rt.task.errorCode = undefined
    rt.task.errorMessage = undefined
    rt.task.status = 'running'
    rt.lastCallKey = ''
    rt.unresolvedToolFailure = false
    rt.dataRetries = 0
    rt.deadlineAt = Date.now() + TASK_DEADLINE_MS
    sendTaskResponse(taskId, 'continue', true, rt)
    emitProgress(rt)
    const capId = contextByTask.get(taskId)?.capabilityContextId || ''
    runTurnGuarded(createCore(taskId, capId), rt, question)
  }

  function onCancel(taskId: string): void {
    const rt = tasks.get(taskId)
    if (!rt) { sendTaskResponse(taskId, 'cancel', false, undefined, 'not_found'); return }
    rt.cancelRequested = true
    rt.abort?.abort() // abort 在途模型 host.request（Main 侧同步 abort 真实出网请求）
    // 只在任务未收尾时置 cancelled（已完成的结果不受取消影响）
    if (rt.task.status === 'planning' || rt.task.status === 'running') {
      rt.task.status = 'cancelled'
      rt.task.errorCode = 'cancelled'
      rt.task.errorMessage = FRIENDLY_ERROR.cancelled
      rt.turnRunning = false
      emitProgress(rt)
    }
    sendTaskResponse(taskId, 'cancel', true, rt)
  }

  function onGet(taskId: string): void {
    const rt = tasks.get(taskId)
    if (!rt) { sendTaskResponse(taskId, 'get', false, undefined, 'not_found'); return }
    sendTaskResponse(taskId, 'get', true, rt)
  }

  function onHostResponse(requestId: string, payload: HostResponsePayload): void {
    pending.get(requestId)?.settle(payload)
  }

  function handle(raw: unknown): void {
    // 显式协议版本比对：版本不一致不静默丢弃（Main 需 protocol_mismatch 信号做 fail closed）
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const v = (raw as Record<string, unknown>).protocolVersion
      if (typeof v === 'number' && v !== HERMES_PROTOCOL_VERSION) {
        send({
          protocolVersion: HERMES_PROTOCOL_VERSION,
          id: createHermesMessageId(),
          type: 'fatal',
          code: 'protocol_mismatch',
          message: 'Hermes 组件版本不一致，请重新安装或升级应用。'
        })
        log('ERROR', `协议版本不一致: ${String(v)} ≠ ${HERMES_PROTOCOL_VERSION}`)
        return
      }
    }
    if (!isMainToUtilityMessage(raw)) { log('WARN', '丢弃非法入站消息'); return }
    const msg = raw as MainToUtilityMessage
    switch (msg.type) {
      case 'init': onInit(msg.tools); return
      case 'restore': if (initialized) restoreFromCheckpoint(msg.checkpoint); return
      case 'task.start': if (initialized) onStart(msg.taskId, msg.goal, msg.context); return
      case 'task.continue': if (initialized) onContinue(msg.taskId, msg.question); return
      case 'task.cancel': if (initialized) onCancel(msg.taskId); return
      case 'task.get': if (initialized) onGet(msg.taskId); return
      case 'host.response': onHostResponse(msg.requestId, {
        ok: msg.ok, text: msg.text, result: msg.result, error: msg.error
      }); return
      case 'shutdown': log('INFO', '收到 shutdown，退出'); process.exit(0); return
      case 'ping': send({ protocolVersion: HERMES_PROTOCOL_VERSION, id: createHermesMessageId(), type: 'pong' }); return
    }
  }

  port.on('message', (e) => {
    try { handle(e?.data) } catch (err) { log('ERROR', `消息处理异常: ${(err as Error)?.message || err}`) }
  })
  port.on('close', () => {
    log('INFO', 'parentPort 关闭，Utility 退出')
    process.exit(0)
  })
}

// ─── 自动引导 ────────────────────────────────────────────────────────────────
// Electron UtilityProcess 注入 process.parentPort；测试 shim 同形注入。
// 两者都不存在（普通 tsx import 本模块做静态检查）时不引导，模块可安全加载。

const utilityPort = (process as unknown as { parentPort?: HermesUtilityPort }).parentPort
if (utilityPort) runHermesUtility(utilityPort)
