/**
 * hermesUtilityManager.ts —— Hermes UtilityProcess 宿主管理器（Main 侧，任务 3/4）
 *
 * Main 是唯一可信宿主：本模块负责 UtilityProcess 的生命周期与两个宿主能力
 * （model.complete / tool.execute）的落地，生产由 electron/main.ts 以
 * electron.utilityProcess.fork 接线（forkProcess 注入；动态测试注入 node child_process 同形通道）。
 *
 * 铁律（hermes-utility-test 动态/静态断言锚点）：
 *  - API Key / ConfigService / 模型出网全部留在 Main；Utility 只见协议消息
 *  - 模型出网前执行最终隐私检查（maskText + 宿主已知 sessionId 精确替换）；每个模型请求
 *    独立 AbortController，取消时在 Main 侧 abort 真实出网请求
 *  - 工具白名单唯一真源 HERMES_TOOLS（可注入）；Utility 的每次 tool.execute 都在 Main
 *    重校验工具名与 capabilityContextId；真实身份/accountId/sessionId 只在 Main 按
 *    capabilityContextId 映射构造工具上下文；只有具体数据库读取进入 enqueueSalesTask
 *    （Agent Loop 在 Utility，绝不入队）；工具结果回传 Utility 前再脱敏（Core 同源实现 +
 *    证据锚点 messageKey 彻底剥离）
 *  - 旧进程内 Agent（hermesAgentService）只能作测试 adapter，严禁作为运行时回退：
 *    Utility 不可用 = 拒绝（agent_starting / agent_unavailable），绝不降级回进程内实现
 *  - 失败策略：ready 超时 5s；心跳 15s 一次、35s 无回应判定异常；首次异常退出 500ms 后
 *    重启一次；第二次失败（或协议版本不一致）→ unavailable；关闭先通知 Utility、
 *    至多等 2s 再 kill，且必须在数据库服务关闭之前完成
 *  - checkpoint：每次成功的工具结果与任务终态后由 Utility 上行；Main 最多保存 50 份；
 *    已收尾（completed/failed/cancelled）任务在 Utility 重启后 restore；运行中任务随崩溃
 *    置 failed/agent_unavailable（崩溃时在途结果一律丢弃）
 *  - 入口校验：Main ↔ Utility 双向消息先过协议运行时校验，不过 = 丢弃（畸形不致命）
 *  - 日志走 salesLog，只记 taskId/状态/工具名，不记密钥/完整 prompt/聊天内容
 */
import { callChatCompletion, getAiModelConfig, isAiConfigured } from '../services/ai/aiApiClient'
import { ConfigService } from '../services/config'
import { getIdentity } from '../services/identityService'
import { maskPrivateText } from '../services/crmSla2Service'
import {
  HERMES_TOOLS,
  maskStructuredId,
  type HermesToolContext,
  type HermesToolDef,
  type HermesToolResult
} from '../services/hermesToolRegistry'
import { salesLog } from '../services/salesLogger'
import { enqueueSalesTask } from '../services/salesQueue'
import {
  AGENT_TEMPERATURE,
  FRIENDLY_ERROR,
  maskDataCopyForBridge,
  maskOutboundTextForBridge,
  type HermesCompletion,
  type HermesTask
} from '../services/hermesAgentCore'
import {
  HERMES_PROTOCOL_VERSION,
  createHermesMessageId,
  isMainToUtilityMessage,
  isUtilityToMainMessage,
  type HermesCheckpoint,
  type HermesHostRequest,
  type HermesProtocolToolResult,
  type HermesToolManifestEntry,
  type HermesUtilityContext,
  type MainToUtilityMessage,
  type UtilityToMainMessage
} from '../../shared/hermesProtocol'
import type { IdentityLike } from '../../shared/ownerFilter'

// ─── 类型 ────────────────────────────────────────────────────────────────────

/** Utility 生命周期状态（固定四态） */
export type HermesUtilityState = 'starting' | 'ready' | 'unavailable' | 'stopped'

/** Utility 子进程最小面（生产：electron.utilityProcess 适配；测试：node child_process 同形适配） */
export interface HermesUtilityChild {
  postMessage(msg: unknown): void
  on(event: 'message', cb: (msg: unknown) => void): void
  on(event: 'exit', cb: (code: number) => void): void
  kill(): void
}

/** fork 通道（生产：utilityProcess.fork；测试：child_process.fork + IPC shim） */
export type HermesUtilityFork = (modulePath: string) => HermesUtilityChild

/** 入口上下文（与渲染层 IPC 载荷同形；真实 sessionId 只到 Main 为止） */
export type HermesTaskContext =
  | { kind: 'global' }
  | { kind: 'chat'; sessionId?: string }
  | { kind: 'customer'; accountId?: number; sessionId?: string }

export interface HermesUtilityTaskInput {
  goal: string
  context?: HermesTaskContext
  contextLabel?: string
}

/** 失败策略时序（可注入以便测试；生产默认见 DEFAULT_TIMINGS） */
export interface HermesUtilityTimings {
  readyTimeoutMs: number
  heartbeatMs: number
  staleMs: number
  restartDelayMs: number
  shutdownGraceMs: number
  ackTimeoutMs: number
}

const DEFAULT_TIMINGS: HermesUtilityTimings = {
  readyTimeoutMs: 5_000, // ready 超时
  heartbeatMs: 15_000, // 心跳间隔
  staleMs: 35_000, // 无回应判定异常
  restartDelayMs: 500, // 首次异常退出后的重启延迟
  shutdownGraceMs: 2_000, // shutdown 通知后的宽限期
  ackTimeoutMs: 3_000 // continue 受理回执等待
}

/** Manager 级人话错误文案（Utility 生命周期错误；与 Core.FRIENDLY_ERROR 分层） */
export const MANAGER_ERROR: Record<string, string> = {
  agent_starting: 'Hermes 正在启动，请稍后再试。',
  agent_unavailable: 'Hermes 暂时不可用，请重启应用后再试。',
  protocol_mismatch: 'Hermes 组件版本不一致，请重新安装或升级应用。',
  timeout: '本次分析超时，请稍后重试。'
}

export interface HermesUtilityManagerDeps {
  forkProcess: HermesUtilityFork
  /** Utility 入口构建产物绝对路径（生产 join(__dirname, 'hermesUtilityEntry.js')） */
  entryPath: string
  configured?: () => boolean
  identity?: () => IdentityLike
  /** 测试注入：模型补全（缺省 callChatCompletion + AGENT_TEMPERATURE + JSON 响应格式） */
  modelComplete?: HermesCompletion
  /** 工具白名单唯一真源（缺省 HERMES_TOOLS） */
  tools?: readonly HermesToolDef[]
  maskText?: (s: string) => string
  maskId?: (s: string) => string
  log?: (level: 'WARN' | 'INFO' | 'ERROR', msg: string) => void
  timings?: Partial<HermesUtilityTimings>
}

/** capabilityContextId → 真实上下文映射（只存 Main；Utility 只见不透明 ID） */
interface CapContext {
  identity: IdentityLike
  accountId?: number
  sessionId?: string
  contextKind: 'global' | 'chat' | 'customer'
}

type ProgressListener = (task: HermesTask) => void

/** 任务/快照缓存上限（与旧进程内服务同规模 FIFO） */
const MAX_TASKS = 50
/** checkpoint 保存上限（spec：最多保存最近 50 份） */
const MAX_CHECKPOINTS = 50

/** 入口上下文人话标签 */
function defaultContextLabel(ctx: HermesTaskContext): string {
  if (!ctx || ctx.kind === 'global') return '全局'
  return ctx.kind === 'chat' ? '当前会话' : '当前客户'
}

// ─── Manager ────────────────────────────────────────────────────────────────

export class HermesUtilityManager {
  private readonly forkProcess: HermesUtilityFork
  private readonly entryPath: string
  private readonly timings: HermesUtilityTimings
  private readonly configuredFn: () => boolean
  private readonly identityFn: () => IdentityLike
  private readonly modelComplete: HermesCompletion
  private readonly tools: readonly HermesToolDef[]
  private readonly maskTextFn: (s: string) => string
  private readonly maskIdFn: (s: string) => string
  private readonly log: (level: 'WARN' | 'INFO' | 'ERROR', msg: string) => void

  private state: HermesUtilityState = 'stopped'
  private child: HermesUtilityChild | null = null
  private seq = 0
  private readonly snapshots = new Map<string, HermesTask>()
  private readonly checkpoints = new Map<string, HermesCheckpoint>()
  private readonly settled = new Set<string>()
  private readonly capContexts = new Map<string, CapContext>()
  private readonly taskCap = new Map<string, string>()
  private readonly modelAborts = new Map<string, Set<AbortController>>()
  private readonly cancelledTasks = new Set<string>()
  private readonly pendingAcks = new Map<string, {
    resolve: (r: { ok: boolean; errorCode?: string }) => void
    timer: ReturnType<typeof setTimeout>
  }>()
  private readonly listeners = new Set<ProgressListener>()
  private restartedOnce = false
  private shuttingDown = false
  private readyTimer: ReturnType<typeof setTimeout> | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private lastPongAt = 0

  constructor(deps: HermesUtilityManagerDeps) {
    this.forkProcess = deps.forkProcess
    this.entryPath = deps.entryPath
    this.timings = { ...DEFAULT_TIMINGS, ...deps.timings }
    this.configuredFn = deps.configured ?? (() => isAiConfigured(ConfigService.getInstance()))
    this.identityFn = deps.identity ?? (() => getIdentity() ?? { name: '', role: '' })
    this.modelComplete = deps.modelComplete ?? ((messages, timeoutMs, signal) =>
      callChatCompletion(
        getAiModelConfig(ConfigService.getInstance()),
        messages.map((m) => ({ role: m.role, content: m.content })),
        { temperature: AGENT_TEMPERATURE, timeoutMs, signal, responseFormatJson: true }
      ))
    this.tools = deps.tools ?? HERMES_TOOLS
    this.maskTextFn = deps.maskText ?? ((s) => maskPrivateText(s))
    this.maskIdFn = deps.maskId ?? ((s) => maskStructuredId(s))
    this.log = deps.log ?? ((level, msg) => salesLog(level, `[HermesUtility] ${msg}`))
  }

  // ── 公共 API ──────────────────────────────────────────────────────────────

  /** 启动/重启 Utility（fork → init → ready 握手；幂等） */
  start(): void {
    if (this.shuttingDown || this.state === 'starting' || this.state === 'ready') return
    this.beginFork()
  }

  /** fork 并发起握手（start 与异常退出重启共用；调用方负责状态守卫） */
  private beginFork(): void {
    this.state = 'starting'
    try {
      const child = this.forkProcess(this.entryPath)
      this.child = child
      child.on('message', (msg) => {
        try { this.onChildMessage(msg) } catch (e) {
          this.log('WARN', `Utility 消息处理异常: ${(e as Error)?.message || e}`)
        }
      })
      child.on('exit', (code) => this.onChildExit(code))
      this.sendToUtility({
        protocolVersion: HERMES_PROTOCOL_VERSION,
        id: createHermesMessageId(),
        type: 'init',
        tools: this.manifest()
      })
      this.readyTimer = setTimeout(() => {
        if (this.state !== 'starting') return
        this.log('WARN', 'Utility ready 超时，判定异常退出')
        this.killChild()
      }, this.timings.readyTimeoutMs)
    } catch (e) {
      this.log('WARN', `Utility fork 失败: ${(e as Error)?.message || e}`)
      this.child = null
      this.enterUnavailable()
    }
  }

  /** 注册进度监听（返回退订函数；main.ts 接线 hermes:task:progress 事件用） */
  onProgress(listener: ProgressListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getState(): HermesUtilityState {
    return this.state
  }

  /** 对外任务快照（缓存真源；含 Utility 推送的最新状态） */
  getTask(taskId: string): HermesTask | null {
    return this.snapshots.get(String(taskId || '').trim()) ?? null
  }

  /** 发起任务：建 planning 快照并下发 Utility（Loop 在 Utility 执行；进度经 progress 回推） */
  async startTask(input: HermesUtilityTaskInput): Promise<{ ok: boolean; task?: HermesTask; errorCode?: string }> {
    const goal = String(input?.goal || '').trim()
    if (!goal) return { ok: false, errorCode: 'bad_request' }
    if (!this.configuredFn()) return { ok: false, errorCode: 'not_configured' }
    if (this.state === 'starting') return { ok: false, errorCode: 'agent_starting' }
    if (this.state !== 'ready') return { ok: false, errorCode: 'agent_unavailable' }
    const now = Date.now()
    const taskId = `hermes-${now}-${++this.seq}`
    const capId = `hctx-${now}-${this.seq}`
    const ctx = input.context?.kind === 'chat' || input.context?.kind === 'customer' ? input.context : { kind: 'global' as const }
    // capabilityContextId → 真实上下文映射只存 Main（identity/sessionId 绝不下发 Utility）
    const cap: CapContext = {
      identity: this.identityFn(),
      accountId: ctx.kind === 'customer' ? Number(ctx.accountId || 0) || undefined : undefined,
      sessionId: 'sessionId' in ctx ? String(ctx.sessionId || '') || undefined : undefined,
      contextKind: ctx.kind
    }
    this.capContexts.set(capId, cap)
    this.taskCap.set(taskId, capId)
    this.modelAborts.set(taskId, new Set())
    const protoCtx: HermesUtilityContext = {
      kind: ctx.kind,
      capabilityContextId: capId,
      ...(cap.accountId !== undefined ? { accountId: cap.accountId } : {}),
      label: input.contextLabel || defaultContextLabel(ctx)
    }
    const task: HermesTask = {
      taskId,
      status: 'planning',
      goal,
      contextLabel: protoCtx.label,
      steps: [],
      evidence: [],
      createdAt: now
    }
    this.snapshots.set(taskId, task)
    this.evictOldTasks()
    this.sendToUtility({
      protocolVersion: HERMES_PROTOCOL_VERSION,
      id: createHermesMessageId(),
      type: 'task.start',
      taskId,
      goal,
      context: protoCtx
    })
    this.emit(task)
    return { ok: true, task: { ...task, steps: [], evidence: [] } }
  }

  /** 多轮追问：清上轮步骤/结果后下发 Utility；等受理回执（崩溃后任务丢失时准确报错） */
  async continueTask(taskId: string, question: string): Promise<{ ok: boolean; task?: HermesTask; errorCode?: string }> {
    const snap = this.snapshots.get(String(taskId || '').trim())
    if (!snap) return { ok: false, errorCode: 'not_found' }
    const q = String(question || '').trim()
    if (!q) return { ok: false, errorCode: 'bad_request' }
    if (snap.status === 'running' || snap.status === 'planning') return { ok: false, errorCode: 'busy' }
    if (this.cancelledTasks.has(snap.taskId)) return { ok: false, errorCode: 'cancelled' }
    if (!this.configuredFn()) return { ok: false, errorCode: 'not_configured' }
    if (this.state === 'starting') return { ok: false, errorCode: 'agent_starting' }
    if (this.state !== 'ready') return { ok: false, errorCode: 'agent_unavailable' }
    const running: HermesTask = {
      ...snap,
      status: 'running',
      steps: [],
      evidence: snap.evidence,
      result: undefined,
      errorCode: undefined,
      errorMessage: undefined
    }
    this.snapshots.set(snap.taskId, running)
    this.emit(running)
    this.sendToUtility({
      protocolVersion: HERMES_PROTOCOL_VERSION,
      id: createHermesMessageId(),
      type: 'task.continue',
      taskId: snap.taskId,
      question: q
    })
    const ack = await this.waitTaskAck(snap.taskId, 'continue')
    if (!ack.ok) {
      // Utility 不认识该任务（如崩溃且无 checkpoint 可恢复）：回滚到原快照并报错
      this.snapshots.set(snap.taskId, snap)
      this.emit(snap)
      return { ok: false, errorCode: ack.errorCode || 'not_found' }
    }
    return { ok: true, task: running }
  }

  /** 取消：abort 在途模型请求 + 通知 Utility + 在途工具结果由 Main 丢弃（不回传不产生证据面） */
  cancelTask(taskId: string): { ok: boolean; task?: HermesTask } {
    const id = String(taskId || '').trim()
    const snap = this.snapshots.get(id)
    if (!snap) return { ok: false }
    if (snap.status === 'completed' || snap.status === 'failed' || snap.status === 'cancelled') {
      return { ok: true, task: snap }
    }
    this.cancelledTasks.add(id)
    for (const ac of this.modelAborts.get(id) ?? []) ac.abort()
    this.sendToUtility({
      protocolVersion: HERMES_PROTOCOL_VERSION,
      id: createHermesMessageId(),
      type: 'task.cancel',
      taskId: id
    })
    const cancelled: HermesTask = {
      ...snap,
      status: 'cancelled',
      errorCode: 'cancelled',
      errorMessage: FRIENDLY_ERROR.cancelled,
      steps: [],
      result: undefined
    }
    this.snapshots.set(id, cancelled)
    this.settled.add(id)
    this.emit(cancelled)
    return { ok: true, task: cancelled }
  }

  /** 关闭：通知 Utility → 至多等宽限期 → kill。必须在数据库服务关闭之前调用（main.ts 退出流程） */
  async shutdown(): Promise<void> {
    this.shuttingDown = true
    this.stopHeartbeat()
    this.clearReadyTimer()
    for (const p of this.pendingAcks.values()) {
      clearTimeout(p.timer)
      p.resolve({ ok: false, errorCode: 'agent_unavailable' })
    }
    this.pendingAcks.clear()
    const child = this.child
    if (!child) {
      this.state = 'stopped'
      return
    }
    this.sendToUtility({ protocolVersion: HERMES_PROTOCOL_VERSION, id: createHermesMessageId(), type: 'shutdown' })
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (!this.child) { clearInterval(check); resolve() }
      }, 25)
      setTimeout(() => { clearInterval(check); resolve() }, this.timings.shutdownGraceMs)
    })
    if (this.child) {
      try { this.child.kill() } catch { /* 已退出 */ }
      this.child = null
    }
    this.state = 'stopped'
    this.log('INFO', 'Utility 已关闭')
  }

  // ── Utility 下行消息 ──────────────────────────────────────────────────────

  private onChildMessage(raw: unknown): void {
    // 入口校验单点：畸形/错误版本一律丢弃（不致命，服务继续可用）
    if (!isUtilityToMainMessage(raw)) {
      const v = raw && typeof raw === 'object' && !Array.isArray(raw)
        ? (raw as Record<string, unknown>).protocolVersion
        : undefined
      this.log('WARN', `丢弃 Utility 非法消息（protocolVersion=${String(v)}）`)
      return
    }
    const msg = raw as UtilityToMainMessage
    switch (msg.type) {
      case 'ready': this.onReady(); return
      case 'pong': this.lastPongAt = Date.now(); return
      case 'task.progress': this.onProgressSnapshot(msg.taskId, msg.snapshot as HermesTask); return
      case 'task.checkpoint': this.onCheckpoint(msg.checkpoint); return
      case 'task.response': this.onTaskResponse(msg); return
      case 'host.request': void this.onHostRequest(msg.request); return
      case 'fatal': this.onFatal(msg.code, msg.message); return
    }
  }

  private onReady(): void {
    this.clearReadyTimer()
    if (this.state === 'ready') return
    this.state = 'ready'
    this.lastPongAt = Date.now()
    this.startHeartbeat()
    this.restoreSettledCheckpoints()
    this.log('INFO', 'Utility ready')
  }

  /** 已收尾任务跨 Utility 重启恢复（restore 下发；运行中任务不恢复） */
  private restoreSettledCheckpoints(): void {
    for (const [taskId, cp] of this.checkpoints) {
      if (!this.settled.has(taskId)) continue
      this.sendToUtility({
        protocolVersion: HERMES_PROTOCOL_VERSION,
        id: createHermesMessageId(),
        type: 'restore',
        checkpoint: cp
      })
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      if (this.state !== 'ready') return
      if (Date.now() - this.lastPongAt > this.timings.staleMs) {
        this.log('WARN', `Utility ${this.timings.staleMs}ms 无心跳，判定异常退出`)
        this.killChild()
        return
      }
      this.sendToUtility({ protocolVersion: HERMES_PROTOCOL_VERSION, id: createHermesMessageId(), type: 'ping' })
    }, this.timings.heartbeatMs)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null }
  }

  private clearReadyTimer(): void {
    if (this.readyTimer) { clearTimeout(this.readyTimer); this.readyTimer = null }
  }

  private onChildExit(_code: number): void {
    this.stopHeartbeat()
    this.clearReadyTimer()
    this.child = null
    if (this.shuttingDown) return
    if (this.state === 'stopped') return
    this.failRunningTasks()
    if (this.state === 'unavailable') return // 协议不匹配等 fail closed 场景：不重试
    if (!this.restartedOnce) {
      this.restartedOnce = true // 每应用生命周期至多自动重启一次
      this.state = 'starting'
      this.log('WARN', 'Utility 异常退出，即将自动重启（每应用生命周期一次）')
      setTimeout(() => {
        if (!this.shuttingDown && this.state === 'starting') this.beginFork()
      }, this.timings.restartDelayMs)
    } else {
      this.enterUnavailable()
    }
  }

  /** 运行中任务随 Utility 异常退出统一置 failed（严禁回退旧进程内 Agent） */
  private failRunningTasks(): void {
    for (const [taskId, snap] of this.snapshots) {
      if (snap.status !== 'planning' && snap.status !== 'running') continue
      const failed: HermesTask = {
        ...snap,
        status: 'failed',
        errorCode: 'agent_unavailable',
        errorMessage: MANAGER_ERROR.agent_unavailable,
        steps: []
      }
      this.snapshots.set(taskId, failed)
      this.settled.add(taskId)
      this.emit(failed)
    }
  }

  private enterUnavailable(): void {
    this.stopHeartbeat()
    this.clearReadyTimer()
    this.state = 'unavailable'
    this.failRunningTasks()
    this.log('ERROR', 'Utility 不可用（重启预算已用尽或协议不匹配），已拒绝新任务')
  }

  private onProgressSnapshot(taskId: string, snap: HermesTask): void {
    if (snap.taskId !== taskId) {
      this.log('WARN', `task.progress taskId 不一致（${taskId} ≠ ${snap.taskId}），丢弃`)
      return
    }
    this.snapshots.set(taskId, snap)
    this.evictOldTasks()
    if (snap.status === 'completed' || snap.status === 'failed' || snap.status === 'cancelled') {
      this.settled.add(taskId)
    }
    this.emit(snap)
  }

  private onCheckpoint(cp: HermesCheckpoint): void {
    this.checkpoints.set(cp.taskId, cp)
    while (this.checkpoints.size > MAX_CHECKPOINTS) {
      const oldest = this.checkpoints.keys().next().value
      if (oldest === undefined) break
      this.checkpoints.delete(oldest)
    }
  }

  private onTaskResponse(msg: UtilityToMainMessage & { type: 'task.response' }): void {
    const key = `${msg.taskId}:${msg.op}`
    const ack = this.pendingAcks.get(key)
    if (ack) {
      clearTimeout(ack.timer)
      this.pendingAcks.delete(key)
      ack.resolve({ ok: msg.ok, errorCode: msg.errorCode })
    }
  }

  private onFatal(code: string, message: string): void {
    this.log('WARN', `Utility fatal: ${code} ${message}`)
    if (code === 'protocol_mismatch') {
      // 版本不一致重试无用：直接 fail closed（不消耗重启预算）
      this.enterUnavailable()
    }
  }

  private waitTaskAck(taskId: string, op: 'continue'): Promise<{ ok: boolean; errorCode?: string }> {
    return new Promise((resolve) => {
      const key = `${taskId}:${op}`
      const timer = setTimeout(() => {
        this.pendingAcks.delete(key)
        resolve({ ok: true }) // 回执超时按已受理处理（后续异常由退出检测兜底）
      }, this.timings.ackTimeoutMs)
      this.pendingAcks.set(key, { resolve, timer })
    })
  }

  // ── 宿主能力（Main 唯一可信执行点）─────────────────────────────────────────

  private async onHostRequest(req: HermesHostRequest): Promise<void> {
    const capId = this.taskCap.get(req.taskId)
    const cap = capId ? this.capContexts.get(capId) : undefined
    if (!cap) {
      this.respondHost(req.requestId, req.taskId, {
        ok: false,
        error: { code: 'forbidden', message: '任务上下文不存在或已结束，已拒绝执行。' }
      })
      return
    }
    if (this.cancelledTasks.has(req.taskId)) {
      this.respondHost(req.requestId, req.taskId, {
        ok: false,
        error: { code: 'cancelled', message: FRIENDLY_ERROR.cancelled }
      })
      return
    }
    if (req.capability === 'model.complete') {
      await this.hostModelComplete(req, cap)
      return
    }
    await this.hostToolExecute(req, cap, capId!)
  }

  /** 模型补全宿主：API Key 与出网留在 Main；出网前最终隐私检查；每请求独立 AbortController */
  private async hostModelComplete(
    req: Extract<HermesHostRequest, { capability: 'model.complete' }>,
    cap: CapContext
  ): Promise<void> {
    const exact = new Map<string, string>()
    if (cap.sessionId) exact.set(cap.sessionId, '***')
    const safeMessages = req.messages.map((m) => ({
      role: m.role,
      content: maskOutboundTextForBridge(m.content, exact, this.maskTextFn)
    }))
    const ac = new AbortController()
    this.modelAborts.get(req.taskId)?.add(ac)
    try {
      const text = await this.modelComplete(safeMessages, req.timeoutMs, ac.signal)
      if (this.cancelledTasks.has(req.taskId)) {
        this.respondHost(req.requestId, req.taskId, {
          ok: false,
          error: { code: 'cancelled', message: FRIENDLY_ERROR.cancelled }
        })
        return
      }
      this.respondHost(req.requestId, req.taskId, { ok: true, text })
    } catch (e) {
      const cancelled = this.cancelledTasks.has(req.taskId) || ac.signal.aborted
      this.respondHost(req.requestId, req.taskId, {
        ok: false,
        error: cancelled
          ? { code: 'cancelled', message: FRIENDLY_ERROR.cancelled }
          : { code: 'ai_error', message: FRIENDLY_ERROR.ai_error }
      })
      if (!cancelled) this.log('WARN', `${req.taskId} 模型调用失败: ${(e as Error)?.message || e}`)
    } finally {
      this.modelAborts.get(req.taskId)?.delete(ac)
    }
  }

  /** 工具执行宿主：白名单 + capabilityContextId 重校验 → 真实上下文映射 → 只把具体数据库
   *  读取放进 enqueueSalesTask → 结果回传前再脱敏 */
  private async hostToolExecute(
    req: Extract<HermesHostRequest, { capability: 'tool.execute' }>,
    cap: CapContext,
    capId: string
  ): Promise<void> {
    if (req.capabilityContextId !== capId) {
      this.respondHost(req.requestId, req.taskId, {
        ok: false,
        error: { code: 'forbidden', message: '任务上下文不匹配，已拒绝执行。' }
      })
      return
    }
    const tool = this.tools.find((t) => t.name === req.tool)
    if (!tool) {
      this.respondHost(req.requestId, req.taskId, {
        ok: false,
        error: { code: 'not_whitelisted', message: '工具不在白名单内，已拒绝执行。' }
      })
      return
    }
    const ctx: HermesToolContext = cap.contextKind === 'customer'
      ? { identity: cap.identity, accountId: cap.accountId, sessionId: cap.sessionId, contextKind: 'customer' }
      : cap.contextKind === 'chat'
        ? { identity: cap.identity, sessionId: cap.sessionId, contextKind: 'chat' }
        : { identity: cap.identity, contextKind: 'global' }
    let result: HermesToolResult
    try {
      result = await enqueueSalesTask(() => tool.run(req.arguments, ctx))
    } catch (e) {
      this.log('WARN', `${req.taskId} 工具 ${req.tool} 执行异常: ${(e as Error)?.message || e}`)
      result = { ok: false, publicSummary: '查询失败', errorCode: 'internal' }
    }
    // 取消发生在工具执行期间：结果丢弃（不回传 → Utility 不可能登记证据或产生完成步骤）
    if (this.cancelledTasks.has(req.taskId)) {
      this.respondHost(req.requestId, req.taskId, {
        ok: false,
        error: { code: 'cancelled', message: FRIENDLY_ERROR.cancelled }
      })
      return
    }
    this.respondHost(req.requestId, req.taskId, {
      ok: true,
      result: this.maskToolResult(tool.name, result, cap.sessionId)
    })
  }

  /** 工具结果出 Utility 前再脱敏：data 走 Core 同源实现（IDENTITY_FIELD_PATHS 真源共享 +
   *  messageKey 删除 + 敏感值精确收集）；evidence/summary 文本走 maskText + 精确替换；
   *  证据锚点 messageKey 字段在此彻底剥离（绝不出宿主） */
  private maskToolResult(toolName: string, result: HermesToolResult, sessionId?: string): HermesProtocolToolResult {
    const exact = new Map<string, string>()
    if (sessionId) exact.set(sessionId, '***')
    const data = maskDataCopyForBridge(toolName, result.data ?? null, exact, this.maskTextFn, this.maskIdFn)
    const evidence = (result.evidence ?? []).map((ev) => ({
      label: maskOutboundTextForBridge(ev.label, exact, this.maskTextFn),
      kind: ev.kind,
      entityId: ev.entityId,
      excerpt: ev.excerpt !== undefined ? maskOutboundTextForBridge(ev.excerpt, exact, this.maskTextFn) : undefined
    }))
    return {
      ok: result.ok,
      data,
      evidence,
      publicSummary: maskOutboundTextForBridge(result.publicSummary, exact, this.maskTextFn),
      errorCode: result.errorCode
    }
  }

  private respondHost(
    requestId: string,
    taskId: string,
    payload: { ok: boolean; text?: string; result?: HermesProtocolToolResult; error?: { code: string; message: string } }
  ): void {
    const base = { protocolVersion: HERMES_PROTOCOL_VERSION, id: createHermesMessageId(), type: 'host.response' as const, requestId, taskId }
    const msg: MainToUtilityMessage = payload.ok
      ? payload.text !== undefined
        ? { ...base, ok: true, text: payload.text }
        : { ...base, ok: true, result: payload.result }
      : { ...base, ok: false, error: payload.error ?? { code: 'internal', message: FRIENDLY_ERROR.internal } }
    this.sendToUtility(msg)
  }

  // ── 内部辅助 ──────────────────────────────────────────────────────────────

  /** 工具清单（只含公开元数据四字段；绝无工具实现与凭据） */
  private manifest(): HermesToolManifestEntry[] {
    return this.tools.map((t) => ({
      name: t.name,
      publicLabel: t.publicLabel,
      description: t.description,
      argsHint: t.argsHint
    }))
  }

  private sendToUtility(msg: MainToUtilityMessage): void {
    if (!this.child) return
    if (!isMainToUtilityMessage(msg)) {
      this.log('WARN', `拒绝发送非法出站消息 type=${String((msg as { type?: unknown }).type)}`)
      return
    }
    this.child.postMessage(msg)
  }

  private killChild(): void {
    if (!this.child) return
    try { this.child.kill() } catch { /* 已退出 */ }
  }

  private emit(task: HermesTask): void {
    for (const l of this.listeners) {
      try { l(task) } catch { /* 单个监听失败不影响任务 */ }
    }
  }

  private evictOldTasks(): void {
    while (this.snapshots.size > MAX_TASKS) {
      const oldest = this.snapshots.keys().next().value
      if (oldest === undefined) break
      this.dropTask(oldest)
    }
  }

  private dropTask(taskId: string): void {
    this.snapshots.delete(taskId)
    this.checkpoints.delete(taskId)
    this.settled.delete(taskId)
    this.cancelledTasks.delete(taskId)
    const capId = this.taskCap.get(taskId)
    if (capId) {
      this.taskCap.delete(taskId)
      this.capContexts.delete(capId)
    }
    this.modelAborts.delete(taskId)
  }
}

/** 工厂（main.ts 生产接线与动态测试共用；electron 依赖经 forkProcess 注入，模块可被 tsx 加载） */
export function createHermesUtilityManager(deps: HermesUtilityManagerDeps): HermesUtilityManager {
  return new HermesUtilityManager(deps)
}
