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
 *    至多等 2s 再 kill，且必须在数据库服务关闭之前完成；入口产物缺失（打包资源不完整）
 *    → 不 fork 直接 unavailable/agent_missing，人话文案指引重装，绝不回退旧进程内 Agent
 *  - checkpoint：每次成功的工具结果与任务终态后由 Utility 上行；Main 最多保存 50 份；
 *    已收尾（completed/failed/cancelled）任务在 Utility 重启后 restore；运行中任务随崩溃
 *    置 failed/agent_unavailable（协议不一致 fail-closed 则保留 failed/protocol_mismatch；
 *    崩溃时在途结果一律丢弃）
 *  - ready 门禁：ready 只能完成 starting → ready 握手；unavailable/stopped/shutdown 中
 *    的迟到或重复 ready 一律丢弃，服务恢复只有 start() 一条路
 *  - 入口校验：Main ↔ Utility 双向消息先过协议运行时校验，不过 = 丢弃（畸形不致命）
 *  - 出口扫描（v2）：Main → Utility 唯一出口 sendToUtility 执行协议校验 +
 *    findHermesBoundaryIssues 双检；拒发返回 false，调用方让任务立即落定
 *    failed/boundary_violation，绝不挂到宿主超时；Utility → Main 出口同规（Entry.send）
 *  - 任务轮次（v2 runId）：task.start=1，continueTask 递增；Utility 回传 progress/
 *    checkpoint/回执必须携带当前轮次，旧轮次迟到消息一律丢弃，取消/终态不可被覆盖复活
 *  - 上下文指纹：startTask 定格（缺省 = 清洗后 myWxid + 身份姓名 + 身份角色，只存 Main），
 *    每次 host.request / continueTask 重读比对，不一致 = capability 失效、任务终止
 *    failed/context_expired；config:set myWxid 切库后主动 invalidateCapabilities
 *  - 日志走 salesLog，只记 taskId/状态/工具名，不记密钥/完整 prompt/聊天内容
 */
import { existsSync } from 'node:fs'
import { callChatCompletion, getAiModelConfig, isAiConfigured } from '../services/ai/aiApiClient'
import { ConfigService } from '../services/config'
import { getIdentity } from '../services/identityService'
import { maskPrivateText } from '../services/crmSla2Service'
import {
  HERMES_TOOLS,
  maskStructuredId,
  type HermesEvidence,
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
  findHermesBoundaryIssues,
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
import { HERMES_ERROR_MESSAGES } from '../../shared/hermesErrorMessages'
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
  ...HERMES_ERROR_MESSAGES
}

type HermesUnavailableReason = 'agent_missing' | 'protocol_mismatch' | 'agent_unavailable'

export interface HermesUtilityManagerDeps {
  forkProcess: HermesUtilityFork
  /** Utility 入口构建产物绝对路径（经 hermesUtilityPath.resolveHermesUtilityPath 解析：
   *  开发态 dist-electron/hermesUtility.js，打包态 resources/hermes/hermesUtility.js） */
  entryPath: string
  /** 入口产物存在性检查（缺省 existsSync(entryPath)；fork 前检查，缺失 = agent_missing
   *  fail-closed，不 fork、不崩主程序、绝不回退旧进程内 Agent） */
  entryExists?: () => boolean
  configured?: () => boolean
  identity?: () => IdentityLike
  /** 当前上下文指纹（账号/身份组合的本地摘要，只存 Main 绝不下发 Utility；
   *  缺省 = 清洗后 myWxid + 身份姓名 + 身份角色。startTask 定格，每次 host.request /
   *  continueTask 重读比对，不一致 = 旧任务能力失效）。注意：这只是本地展示范围的
   *  任务上下文隔离机制，UtilityProcess 不是安全沙箱 */
  contextFingerprint?: () => string
  /** 测试注入：模型补全（缺省 callChatCompletion + AGENT_TEMPERATURE + JSON 响应格式） */
  modelComplete?: HermesCompletion
  /** 工具白名单唯一真源（缺省 HERMES_TOOLS） */
  tools?: readonly HermesToolDef[]
  maskText?: (s: string) => string
  maskId?: (s: string) => string
  log?: (level: 'WARN' | 'INFO' | 'ERROR', msg: string) => void
  timings?: Partial<HermesUtilityTimings>
}

/** capabilityContextId → 真实上下文映射（只存 Main；Utility 只见不透明 ID。
 *  fingerprint = 发起任务时的上下文指纹定格，host.request / continueTask 时重读比对） */
interface CapContext {
  identity: IdentityLike
  accountId?: number
  sessionId?: string
  contextKind: 'global' | 'chat' | 'customer'
  fingerprint: string
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
  private readonly entryExistsFn: () => boolean
  private readonly timings: HermesUtilityTimings
  private readonly configuredFn: () => boolean
  private readonly identityFn: () => IdentityLike
  private readonly contextFingerprintFn: () => string
  private readonly modelComplete: HermesCompletion
  private readonly tools: readonly HermesToolDef[]
  private readonly maskTextFn: (s: string) => string
  private readonly maskIdFn: (s: string) => string
  private readonly log: (level: 'WARN' | 'INFO' | 'ERROR', msg: string) => void

  private state: HermesUtilityState = 'stopped'
  private child: HermesUtilityChild | null = null
  /** child 世代号：消息/退出监听绑定具体 child，旧进程迟到消息一律忽略 */
  private generation = 0
  private seq = 0
  private readonly snapshots = new Map<string, HermesTask>()
  private readonly checkpoints = new Map<string, HermesCheckpoint>()
  private readonly settled = new Set<string>()
  private readonly capContexts = new Map<string, CapContext>()
  private readonly taskCap = new Map<string, string>()
  private readonly modelAborts = new Map<string, Set<AbortController>>()
  private readonly cancelledTasks = new Set<string>()
  /** 已失效任务（账号/身份指纹变化或边界违规）：capability 已封，progress/checkpoint/
   *  continue/host.request 一律拒绝复活 */
  private readonly expiredTasks = new Set<string>()
  /** taskId → 当前轮次号（task.start=1；continueTask 递增。Utility 回传消息必须携带
   *  当前轮次 runId，旧轮次迟到消息在 progress/checkpoint/ack 三处被门禁丢弃） */
  private readonly taskRunGeneration = new Map<string, number>()
  private readonly pendingAcks = new Map<string, {
    expectedRunId: number
    resolve: (r: { ok: boolean; errorCode?: string }) => void
    timer: ReturnType<typeof setTimeout>
  }>()
  private readonly listeners = new Set<ProgressListener>()
  private restartedOnce = false
  /** unavailable 的稳定原因：缺产物、协议不一致、普通崩溃耗尽预算三者不串用。 */
  private unavailableReason: HermesUnavailableReason | null = null
  private shuttingDown = false
  private shutdownPromise: Promise<void> | null = null
  private readyTimer: ReturnType<typeof setTimeout> | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private lastPongAt = 0
  /** Main 保存的原始任务文本（goal/contextLabel 原文，仅供本地 UI 快照；跨进程一律脱敏形态） */
  private readonly rawTextByTask = new Map<string, { goal: string; contextLabel: string }>()
  /** taskId → (evidenceHandle → 原始证据含 messageKey)；跨进程证据只带 handle，锚点只存 Main */
  private readonly evidenceAnchorsByTask = new Map<string, Map<string, HermesEvidence>>()
  /** taskId → (eN ref → 原始证据)；Utility 上报 ref+handle 时建立，UI 快照按 ref 恢复 messageKey */
  private readonly refAnchorsByTask = new Map<string, Map<string, HermesEvidence>>()
  private evidenceHandleSeq = 0
  /** 在途宿主操作（model.complete / tool.execute）；shutdown 等全部收尾后才返回 */
  private readonly hostOps = new Set<Promise<unknown>>()

  constructor(deps: HermesUtilityManagerDeps) {
    this.forkProcess = deps.forkProcess
    this.entryPath = deps.entryPath
    this.entryExistsFn = deps.entryExists ?? (() => existsSync(this.entryPath))
    this.timings = { ...DEFAULT_TIMINGS, ...deps.timings }
    this.configuredFn = deps.configured ?? (() => isAiConfigured(ConfigService.getInstance()))
    this.identityFn = deps.identity ?? (() => getIdentity() ?? { name: '', role: '' })
    // 上下文指纹缺省实现：清洗后 myWxid + 身份姓名 + 身份角色的组合摘要（JSON 数组避免
    // 分隔符歧义）。真实值只存 Main——指纹与组成部分绝不进任何跨进程消息
    this.contextFingerprintFn = deps.contextFingerprint ?? (() => {
      let wxid = ''
      try { wxid = String(ConfigService.getInstance().getMyWxidCleaned() || '').trim() } catch { /* 无配置环境 */ }
      const id = this.identityFn()
      return JSON.stringify([wxid, String(id?.name || ''), String(id?.role || '')])
    })
    this.modelComplete = deps.modelComplete ?? ((messages, timeoutMs, signal) =>
      callChatCompletion(
        getAiModelConfig(ConfigService.getInstance()),
        messages.map((m) => ({ role: m.role, content: m.content })),
        { temperature: AGENT_TEMPERATURE, timeoutMs, signal, responseFormatJson: true, usageContext: { purpose: 'hermes' } }
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
    // 入口产物存在性检查（打包资源缺失 = 安装包不完整）：不 fork、不崩主程序、
    // 不消耗重启预算，直接 fail-closed 拒绝新任务（agent_missing）
    if (!this.entryExistsFn()) {
      this.state = 'unavailable'
      this.unavailableReason = 'agent_missing'
      this.log('ERROR', 'Hermes Utility 打包资源缺失，服务不可用（请重新安装或升级应用）')
      return
    }
    this.state = 'starting'
    this.unavailableReason = null
    const gen = ++this.generation
    try {
      const child = this.forkProcess(this.entryPath)
      this.child = child
      child.on('message', (msg) => {
        // 世代绑定：只有当前 child 的消息进处理（旧进程/已替换 child 的迟到消息一律忽略）
        if (this.generation !== gen || this.child !== child) return
        try { this.onChildMessage(msg) } catch {
          this.log('WARN', 'Utility 消息处理异常 errorCode=internal')
        }
      })
      child.on('exit', (code) => {
        if (this.generation !== gen || this.child !== child) return
        this.onChildExit(code)
      })
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
      this.log('WARN', 'Utility fork 失败 errorCode=agent_unavailable')
      this.child = null
      this.enterUnavailable('agent_unavailable')
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
    if (this.state !== 'ready') {
      return { ok: false, errorCode: this.unavailableReason ?? 'agent_unavailable' }
    }
    const now = Date.now()
    const taskId = `hermes-${now}-${++this.seq}`
    const capId = `hctx-${now}-${this.seq}`
    const ctx = input.context?.kind === 'chat' || input.context?.kind === 'customer' ? input.context : { kind: 'global' as const }
    // capabilityContextId → 真实上下文映射只存 Main（identity/sessionId 绝不下发 Utility；
    // accountId 按协议随上下文进 Utility 作工具锚点）；指纹定格发起时刻的账号/身份组合
    const cap: CapContext = {
      identity: this.identityFn(),
      accountId: ctx.kind === 'customer' ? Number(ctx.accountId || 0) || undefined : undefined,
      sessionId: 'sessionId' in ctx ? String(ctx.sessionId || '') || undefined : undefined,
      contextKind: ctx.kind,
      fingerprint: this.contextFingerprintFn()
    }
    this.capContexts.set(capId, cap)
    this.taskCap.set(taskId, capId)
    this.modelAborts.set(taskId, new Set())
    // 原始任务文本只存 Main（UI 快照真源）；跨进程 goal 一律脱敏（maskText + 当前宿主
    // sessionId 精确替换）；Utility 侧标签只用通用「全局/当前会话/当前客户」
    this.rawTextByTask.set(taskId, { goal, contextLabel: input.contextLabel || defaultContextLabel(ctx) })
    this.evidenceAnchorsByTask.set(taskId, new Map())
    this.refAnchorsByTask.set(taskId, new Map())
    const exact = new Map<string, string>()
    if (cap.sessionId) exact.set(cap.sessionId, '***')
    const wireGoal = maskOutboundTextForBridge(goal, exact, this.maskTextFn)
    const protoCtx: HermesUtilityContext = {
      kind: ctx.kind,
      capabilityContextId: capId,
      ...(cap.accountId !== undefined ? { accountId: cap.accountId } : {}),
      label: defaultContextLabel(ctx)
    }
    const task: HermesTask = {
      taskId,
      status: 'planning',
      goal,
      contextLabel: input.contextLabel || defaultContextLabel(ctx),
      steps: [],
      evidence: [],
      createdAt: now
    }
    this.snapshots.set(taskId, task)
    this.evictOldTasks()
    // 轮次号从 1 起（协议 runId；Utility 回传消息必须携带当前轮次）
    this.taskRunGeneration.set(taskId, 1)
    const started = this.sendToUtility({
      protocolVersion: HERMES_PROTOCOL_VERSION,
      id: createHermesMessageId(),
      type: 'task.start',
      taskId,
      runId: 1,
      goal: wireGoal,
      context: protoCtx
    })
    if (!started) {
      // 出站唯一出口拒发（结构非法或边界违规）：任务立即失败，不等宿主超时
      this.expireTask(taskId, 'boundary_violation')
      return { ok: false, errorCode: 'boundary_violation', task: this.snapshots.get(taskId) }
    }
    this.emit(task)
    return { ok: true, task: { ...task, steps: [], evidence: [] } }
  }

  /** 多轮追问：清上轮步骤/结果后下发 Utility；等受理回执（崩溃后任务丢失时准确报错）。
   *  每次追问先重读上下文指纹并递增轮次号——旧轮次的迟到消息从此全部被门禁丢弃 */
  async continueTask(taskId: string, question: string): Promise<{ ok: boolean; task?: HermesTask; errorCode?: string }> {
    const snap = this.snapshots.get(String(taskId || '').trim())
    if (!snap) return { ok: false, errorCode: 'not_found' }
    const q = String(question || '').trim()
    if (!q) return { ok: false, errorCode: 'bad_request' }
    if (snap.status === 'running' || snap.status === 'planning') return { ok: false, errorCode: 'busy' }
    if (this.cancelledTasks.has(snap.taskId)) return { ok: false, errorCode: 'cancelled' }
    if (this.expiredTasks.has(snap.taskId)) return { ok: false, errorCode: 'context_expired' }
    // 指纹重校验：账号/身份在任务收尾后发生变化 = 旧能力已失效，不能靠追问复活
    const contCapId0 = this.taskCap.get(snap.taskId)
    const contCap0 = contCapId0 ? this.capContexts.get(contCapId0) : undefined
    if (!contCap0) return { ok: false, errorCode: 'context_expired' }
    if (this.contextFingerprintFn() !== contCap0.fingerprint) {
      this.expireTask(snap.taskId, 'context_expired')
      return { ok: false, errorCode: 'context_expired' }
    }
    if (!this.configuredFn()) return { ok: false, errorCode: 'not_configured' }
    if (this.state === 'starting') return { ok: false, errorCode: 'agent_starting' }
    if (this.state !== 'ready') {
      return { ok: false, errorCode: this.unavailableReason ?? 'agent_unavailable' }
    }
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
    // 追问文本同样在 Main 脱敏后才下发（maskText + 该任务宿主 sessionId 精确替换）
    const contCapId = this.taskCap.get(snap.taskId)
    const contCap = contCapId ? this.capContexts.get(contCapId) : undefined
    const contExact = new Map<string, string>()
    if (contCap?.sessionId) contExact.set(contCap.sessionId, '***')
    // 递增轮次号后再下发：旧轮次在途消息自此全部过期
    const nextRun = (this.taskRunGeneration.get(snap.taskId) || 1) + 1
    this.taskRunGeneration.set(snap.taskId, nextRun)
    const sent = this.sendToUtility({
      protocolVersion: HERMES_PROTOCOL_VERSION,
      id: createHermesMessageId(),
      type: 'task.continue',
      taskId: snap.taskId,
      runId: nextRun,
      question: maskOutboundTextForBridge(q, contExact, this.maskTextFn)
    })
    if (!sent) {
      // 出站唯一出口拒发（结构非法或边界违规）：回滚轮次，任务立即置 failed/boundary_violation
      this.taskRunGeneration.set(snap.taskId, nextRun - 1)
      this.expireTask(snap.taskId, 'boundary_violation', true)
      return { ok: false, errorCode: 'boundary_violation', task: this.snapshots.get(snap.taskId) }
    }
    const ack = await this.waitTaskAck(snap.taskId, 'continue', nextRun)
    if (!ack.ok) {
      // Utility 不认识该任务（如崩溃且无 checkpoint 可恢复）：回滚到原快照并报错
      this.taskRunGeneration.set(snap.taskId, nextRun - 1)
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
      taskId: id,
      runId: this.taskRunGeneration.get(id) || 1
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

  /** 关闭（幂等，memoized）：拒绝新宿主请求 → abort 在途模型 → 通知并停止 Utility →
   *  等已进入 Main 的 tool/model 宿主操作全部收尾后才返回。必须在数据库服务关闭之前
   *  调用（main.ts 退出流程）；工具读库卡死时交给外层现有 5s app.exit 兜底，绝不提前
   *  返回让数据库先关 */
  shutdown(): Promise<void> {
    if (!this.shutdownPromise) this.shutdownPromise = this.doShutdown()
    return this.shutdownPromise
  }

  private async doShutdown(): Promise<void> {
    this.shuttingDown = true
    this.stopHeartbeat()
    this.clearReadyTimer()
    for (const p of this.pendingAcks.values()) {
      clearTimeout(p.timer)
      p.resolve({ ok: false, errorCode: 'agent_unavailable' })
    }
    this.pendingAcks.clear()
    // ① shutdown 已开始：新 host.request 一律拒绝（onHostRequest shuttingDown 守卫）
    // ② abort 全部在途模型请求（Main 侧真实出网立即中断）
    for (const set of this.modelAborts.values()) {
      for (const ac of set) ac.abort()
    }
    // ③ 通知 Utility 自行退出 → 至多等宽限期 → kill
    const child = this.child
    if (child) {
      this.sendToUtility({ protocolVersion: HERMES_PROTOCOL_VERSION, id: createHermesMessageId(), type: 'shutdown' })
      await new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (!this.child) { clearInterval(check); resolve() }
        }, 25)
        setTimeout(() => { clearInterval(check); resolve() }, this.timings.shutdownGraceMs)
      })
      if (this.child) {
        try { this.child.kill() } catch { /* 已退出 */ }
      }
    }
    // ④ 等已进入 Main 的宿主操作收尾（abort 已让模型操作尽快落定；工具读库只能等完成）
    if (this.hostOps.size > 0) {
      await Promise.allSettled([...this.hostOps])
    }
    this.child = null
    this.state = 'stopped'
    this.log('INFO', 'Utility 已关闭')
  }

  // ── Utility 下行消息 ──────────────────────────────────────────────────────

  private onChildMessage(raw: unknown): void {
    // 协议版本 fail-closed（严格校验之前先看版本）：数值版本 ≠ 当前 → 立即 unavailable +
    // kill 当前 child + 不自动重启（版本不一致重试无用，服务不可继续使用）
    const v = raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>).protocolVersion
      : undefined
    if (typeof v === 'number' && v !== HERMES_PROTOCOL_VERSION) {
      this.log('ERROR', `Utility 协议版本不一致（${String(v)} ≠ ${HERMES_PROTOCOL_VERSION}），fail closed`)
      this.enterUnavailable('protocol_mismatch')
      this.killChild()
      return
    }
    // 入口校验单点：畸形消息一律丢弃（不致命，服务继续可用）
    if (!isUtilityToMainMessage(raw)) {
      this.log('WARN', `丢弃 Utility 非法消息（protocolVersion=${String(v)}）`)
      return
    }
    const msg = raw as UtilityToMainMessage
    switch (msg.type) {
      case 'ready': this.onReady(); return
      case 'pong': this.lastPongAt = Date.now(); return
      case 'task.progress': this.onProgressSnapshot(msg.taskId, msg.snapshot as HermesTask, msg.runId); return
      case 'task.checkpoint': this.onCheckpoint(msg.checkpoint); return
      case 'task.response': this.onTaskResponse(msg); return
      case 'host.request': {
        // 宿主请求绑定发起时的 child：响应只回给它（child 崩溃重启后，旧请求的延迟结果
        // 绝不发给新 child）；操作进入 hostOps 跟踪（shutdown 等全部收尾）
        const childAtRequest = this.child
        const op = this.onHostRequest(msg.request, childAtRequest).catch(() => {
          this.log('WARN', `${msg.request.taskId} host.request 处理异常 errorCode=internal`)
        })
        this.hostOps.add(op)
        void op.finally(() => { this.hostOps.delete(op) })
        return
      }
      case 'fatal': this.onFatal(msg.code, msg.message); return
    }
  }

  private onReady(): void {
    // fail-closed 门禁：ready 只能完成 starting → ready 的握手。重复 ready、shutdown 中、
    // stopped、以及协议不一致等 unavailable 场景下旧 child 迟到/补发的合法 ready 一律
    // 丢弃——服务恢复只有 start() 一条路，绝不由此消息把 fail-closed 状态拉回 ready
    if (this.state !== 'starting') {
      this.log('WARN', `非 starting 状态收到 ready（state=${this.state}），已丢弃`)
      return
    }
    this.clearReadyTimer()
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
      if (cp.runId !== this.taskRunGeneration.get(taskId)) {
        this.log('WARN', `task.checkpoint 恢复轮次过期 taskId=${taskId} runId=${cp.runId}，丢弃`)
        continue
      }
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
      this.enterUnavailable('agent_unavailable')
    }
  }

  /** 运行中任务随 Utility 异常退出统一置 failed（严禁回退旧进程内 Agent）。
   *  errorCode 缺省 agent_unavailable（普通首次/二次崩溃语义不变）；协议不一致 fail-closed
   *  时由 enterUnavailable 传入 protocol_mismatch——在途任务保留真实稳定失败原因与
   *  共享人话文案（MANAGER_ERROR = HERMES_ERROR_MESSAGES 唯一真源），三者不串用 */
  private failRunningTasks(errorCode: HermesUnavailableReason = 'agent_unavailable'): void {
    const errorMessage = MANAGER_ERROR[errorCode] ?? MANAGER_ERROR.agent_unavailable
    for (const [taskId, snap] of this.snapshots) {
      if (snap.status !== 'planning' && snap.status !== 'running') continue
      const failed: HermesTask = {
        ...snap,
        status: 'failed',
        errorCode,
        errorMessage,
        steps: []
      }
      this.snapshots.set(taskId, failed)
      this.settled.add(taskId)
      this.emit(failed)
    }
  }

  private enterUnavailable(reason: HermesUnavailableReason = 'agent_unavailable'): void {
    this.stopHeartbeat()
    this.clearReadyTimer()
    this.state = 'unavailable'
    this.unavailableReason = reason
    this.failRunningTasks(reason)
    this.log('ERROR', reason === 'protocol_mismatch'
      ? 'Utility 协议版本不一致，已关闭且不会自动重启'
      : 'Utility 不可用（重启预算已用尽），已拒绝新任务')
  }

  /** Utility 进度快照门禁（防乱序/防复活）：任务存在、capability 仍有效、轮次一致、
   *  取消/终态不被覆盖——任一不过只记 taskId/runId/原因后丢弃（绝不凭空创建或复活状态） */
  private onProgressSnapshot(taskId: string, snap: HermesTask, runId: number): void {
    if (snap.taskId !== taskId) {
      this.log('WARN', `task.progress taskId 不一致（${taskId} ≠ ${snap.taskId}），丢弃`)
      return
    }
    if (!this.snapshots.has(taskId)) {
      this.log('WARN', `task.progress 未知任务 taskId=${taskId}，丢弃`)
      return
    }
    if (!this.taskCap.has(taskId) || this.expiredTasks.has(taskId)) {
      this.log('WARN', `task.progress capability 已失效 taskId=${taskId}，丢弃`)
      return
    }
    if (runId !== this.taskRunGeneration.get(taskId)) {
      this.log('WARN', `task.progress 轮次过期 taskId=${taskId} runId=${runId}，丢弃`)
      return
    }
    if (this.cancelledTasks.has(taskId) && snap.status !== 'cancelled') {
      this.log('WARN', `task.progress 迟到消息被取消终态拦截 taskId=${taskId} runId=${runId}，丢弃`)
      return
    }
    const current = this.snapshots.get(taskId)!
    const currentTerminal = current.status === 'completed' || current.status === 'failed' || current.status === 'cancelled'
    if (currentTerminal && snap.status !== current.status) {
      this.log('WARN', `task.progress 终态后变化被拒 taskId=${taskId} runId=${runId}，丢弃`)
      return
    }
    const ui = this.uiSnapshot(taskId, snap)
    this.snapshots.set(taskId, ui)
    this.evictOldTasks()
    if (ui.status === 'completed' || ui.status === 'failed' || ui.status === 'cancelled') {
      this.settled.add(taskId)
    }
    this.emit(ui)
  }

  /** Utility 快照 → UI 快照合并：①goal/contextLabel 恢复 Main 保存的原文（跨进程是脱敏
   *  形态，不能让 UI 被脱敏文本覆盖）；②证据按 ref/handle 从 Main 锚点表恢复原始形态
   *  （含 messageKey 本地回查锚点），无锚点的条目只保留脱敏展示面 */
  private uiSnapshot(taskId: string, snap: HermesTask): HermesTask {
    const raw = this.rawTextByTask.get(taskId)
    const refAnchors = this.refAnchorsByTask.get(taskId)
    const handleAnchors = this.evidenceAnchorsByTask.get(taskId)
    const evidence = snap.evidence.map((e) => {
      const byRef = e.ref ? refAnchors?.get(e.ref) : undefined
      const byHandle = e.evidenceHandle ? handleAnchors?.get(e.evidenceHandle) : undefined
      const anchor = byRef ?? byHandle
      if (anchor) {
        if (e.ref && refAnchors) refAnchors.set(e.ref, anchor)
        return { ...anchor, ref: e.ref }
      }
      return {
        ref: e.ref,
        label: e.label,
        kind: e.kind,
        ...(e.entityId !== undefined ? { entityId: e.entityId } : {}),
        ...(e.excerpt !== undefined ? { excerpt: e.excerpt } : {})
      }
    })
    return {
      ...snap,
      goal: raw?.goal ?? snap.goal,
      contextLabel: raw?.contextLabel ?? snap.contextLabel,
      evidence
    }
  }

  /** checkpoint 保存门禁：任务归属 + capability 有效 + 轮次一致；取消任务的 checkpoint
   *  一律拒收（取消即终态，恢复面只剩 Main 缓存快照，Utility 侧无从继续）。不过 =
   *  只记 taskId/runId/原因后丢弃，绝不进入 checkpoint Map */
  private onCheckpoint(cp: HermesCheckpoint): void {
    const taskId = cp.taskId
    if (!this.snapshots.has(taskId)) {
      this.log('WARN', `task.checkpoint 未知任务 taskId=${taskId}，丢弃`)
      return
    }
    if (!this.taskCap.has(taskId) || this.expiredTasks.has(taskId)) {
      this.log('WARN', `task.checkpoint capability 已失效 taskId=${taskId}，丢弃`)
      return
    }
    if (this.cancelledTasks.has(taskId)) {
      this.log('WARN', `task.checkpoint 已取消任务拒收 taskId=${taskId}，丢弃`)
      return
    }
    if (cp.runId !== this.taskRunGeneration.get(taskId)) {
      this.log('WARN', `task.checkpoint 轮次过期 taskId=${taskId} runId=${cp.runId}，丢弃`)
      return
    }
    this.checkpoints.set(taskId, cp)
    while (this.checkpoints.size > MAX_CHECKPOINTS) {
      const oldest = this.checkpoints.keys().next().value
      if (oldest === undefined) break
      this.checkpoints.delete(oldest)
    }
  }

  /** 受理回执：只有轮次匹配的 continue 回执才能解除等待（旧轮次迟到回执一律丢弃，
   *  防止旧回执错配新一轮的 pending） */
  private onTaskResponse(msg: UtilityToMainMessage & { type: 'task.response' }): void {
    const key = `${msg.taskId}:${msg.op}`
    const ack = this.pendingAcks.get(key)
    if (ack && msg.runId === ack.expectedRunId) {
      clearTimeout(ack.timer)
      this.pendingAcks.delete(key)
      ack.resolve({ ok: msg.ok, errorCode: msg.errorCode })
    }
  }

  private onFatal(code: string, _message: string): void {
    this.log('WARN', `Utility fatal errorCode=${code}`)
    if (code === 'protocol_mismatch') {
      // 版本不一致重试无用：直接 fail closed（不消耗重启预算），并停掉对端
      this.enterUnavailable('protocol_mismatch')
      this.killChild()
    }
  }

  private waitTaskAck(taskId: string, op: 'continue', expectedRunId: number): Promise<{ ok: boolean; errorCode?: string }> {
    return new Promise((resolve) => {
      const key = `${taskId}:${op}`
      const timer = setTimeout(() => {
        this.pendingAcks.delete(key)
        resolve({ ok: true }) // 回执超时按已受理处理（后续异常由退出检测兜底）
      }, this.timings.ackTimeoutMs)
      this.pendingAcks.set(key, { expectedRunId, resolve, timer })
    })
  }

  // ── 宿主能力（Main 唯一可信执行点）─────────────────────────────────────────

  /**
   * 宿主异步操作的统一生命周期校验。
   *
   * 该校验必须在每个模型/工具 await 返回后、构造任何成功或失败回执前再次执行。
   * 返回 stale_run 表示旧 child、旧轮次、shutdown 或任务已不存在：调用方不得写当前
   * 任务快照，respondHost 也会因 child 亲和检查阻止结果进入新 Utility。
   */
  private validateHostOperation(
    taskId: string,
    expectedCapId: string,
    expectedFingerprint: string,
    expectedRunId?: number,
    expectedChild?: HermesUtilityChild | null
  ): 'ok' | 'cancelled' | 'context_expired' | 'stale_run' {
    if (this.shuttingDown || (expectedChild !== undefined && this.child !== expectedChild)) return 'stale_run'
    if (!this.snapshots.has(taskId)) return 'stale_run'
    if (this.cancelledTasks.has(taskId)) return 'cancelled'
    if (this.expiredTasks.has(taskId)) return 'context_expired'
    if (this.taskCap.get(taskId) !== expectedCapId) return 'context_expired'
    const cap = this.capContexts.get(expectedCapId)
    if (!cap || cap.fingerprint !== expectedFingerprint) return 'context_expired'
    if (expectedRunId !== undefined && this.taskRunGeneration.get(taskId) !== expectedRunId) return 'stale_run'
    let currentFingerprint = ''
    try { currentFingerprint = this.contextFingerprintFn() } catch { return 'context_expired' }
    if (currentFingerprint !== expectedFingerprint) return 'context_expired'
    return 'ok'
  }

  /** 将统一校验结果转换为受控回执；context_expired 是唯一会封禁 capability 的结果。 */
  private settleInvalidHostOperation(
    req: HermesHostRequest,
    child: HermesUtilityChild | null,
    result: 'cancelled' | 'context_expired' | 'stale_run'
  ): void {
    if (result === 'context_expired') {
      this.expireTask(req.taskId, 'context_expired')
      this.respondHost(req.requestId, req.taskId, child, {
        ok: false,
        error: { code: 'context_expired', message: MANAGER_ERROR.context_expired }
      })
      return
    }
    if (result === 'cancelled') {
      this.respondHost(req.requestId, req.taskId, child, {
        ok: false,
        error: { code: 'cancelled', message: FRIENDLY_ERROR.cancelled }
      })
      return
    }
    this.respondHost(req.requestId, req.taskId, child, {
      ok: false,
      error: { code: 'stale_run', message: '任务轮次已过期，本次结果已丢弃。' }
    })
  }

  private async onHostRequest(req: HermesHostRequest, child: HermesUtilityChild | null): Promise<void> {
    // shutdown 已开始 / 非 ready 状态（含版本 fail closed 后的 unavailable）：拒绝一切宿主
    // 请求执行（不跑模型、不跑工具，立即回错误让 Utility 侧收尾）
    if (this.shuttingDown || this.state !== 'ready') {
      const errorCode = this.shuttingDown
        ? 'agent_unavailable'
        : this.state === 'starting'
          ? 'agent_starting'
          : this.unavailableReason ?? 'agent_unavailable'
      this.respondHost(req.requestId, req.taskId, child, {
        ok: false,
        error: { code: errorCode, message: MANAGER_ERROR[errorCode] ?? MANAGER_ERROR.agent_unavailable }
      })
      return
    }
    const capId = this.taskCap.get(req.taskId)
    const cap = capId ? this.capContexts.get(capId) : undefined
    if (!cap) {
      // capability 缺席 = 已失效（账号/身份变化或边界违规封禁）：给稳定错误码让人话归因
      const expired = this.expiredTasks.has(req.taskId)
      this.respondHost(req.requestId, req.taskId, child, {
        ok: false,
        error: expired
          ? { code: 'context_expired', message: MANAGER_ERROR.context_expired }
          : { code: 'forbidden', message: '任务上下文不存在或已结束，已拒绝执行。' }
      })
      return
    }
    const capStatus = this.validateHostOperation(req.taskId, capId!, cap.fingerprint,
      this.taskRunGeneration.get(req.taskId), child)
    if (capStatus !== 'ok') {
      if (capStatus === 'stale_run') {
        this.respondHost(req.requestId, req.taskId, child, {
          ok: false,
          error: { code: 'stale_run', message: '任务轮次已过期，本次请求已拒绝。' }
        })
      } else {
        this.settleInvalidHostOperation(req, child, capStatus)
      }
      return
    }
    if (req.capability === 'model.complete') {
      await this.hostModelComplete(req, cap, capId!, this.taskRunGeneration.get(req.taskId), child)
      return
    }
    await this.hostToolExecute(req, cap, capId!, this.taskRunGeneration.get(req.taskId), child)
  }

  /** 模型补全宿主：API Key 与出网留在 Main；出网前最终隐私检查；每请求独立 AbortController；
   *  响应只回给发起请求的 child（亲和） */
  private async hostModelComplete(
    req: Extract<HermesHostRequest, { capability: 'model.complete' }>,
    cap: CapContext,
    capId: string,
    expectedRunId: number | undefined,
    child: HermesUtilityChild | null
  ): Promise<void> {
    const exact = new Map<string, string>()
    if (cap.sessionId) exact.set(cap.sessionId, '***')
    const safeMessages = req.messages.map((m) => ({
      role: m.role,
      content: maskOutboundTextForBridge(m.content, exact, this.maskTextFn)
    }))
    this.logModelEgressDiagnostic(req.taskId, safeMessages, cap.sessionId)
    const ac = new AbortController()
    this.modelAborts.get(req.taskId)?.add(ac)
    try {
      const text = await this.modelComplete(safeMessages, req.timeoutMs, ac.signal)
      const status = this.validateHostOperation(req.taskId, capId, cap.fingerprint, expectedRunId, child)
      if (status !== 'ok') {
        this.settleInvalidHostOperation(req, child, status)
        return
      }
      // 模型返回文本是不可信外部输入：回传 Utility 前再过统一出站脱敏（maskText +
      // 宿主已知标识符精确替换）。残留边界违规由 respondHost 的出口扫描兜底拒发
      const safeText = maskOutboundTextForBridge(String(text ?? ''), exact, this.maskTextFn)
      this.respondHost(req.requestId, req.taskId, child, { ok: true, text: safeText })
    } catch (e) {
      const status = this.validateHostOperation(req.taskId, capId, cap.fingerprint, expectedRunId, child)
      if (status !== 'ok') {
        this.settleInvalidHostOperation(req, child, status)
      } else {
        const cancelled = this.cancelledTasks.has(req.taskId) || ac.signal.aborted
        this.respondHost(req.requestId, req.taskId, child, {
          ok: false,
          error: cancelled
            ? { code: 'cancelled', message: FRIENDLY_ERROR.cancelled }
            : { code: 'ai_error', message: FRIENDLY_ERROR.ai_error }
        })
        if (!cancelled) this.log('WARN', `${req.taskId} 模型调用失败 errorCode=ai_error`)
      }
    } finally {
      this.modelAborts.get(req.taskId)?.delete(ac)
    }
  }

  /** 开发诊断观测（七-隐私）：Main 模型出口脱敏形态计数。默认完全静默，仅当
   *  WEFLOW_HERMES_PRIVACY_DIAG=1（开发诊断自选开启）时输出计数字段——taskId / 条数 /
   *  边界问题数 / 已知会话残留 / 手机号 / 身份证号形态布尔。绝不输出 prompt/响应全文、
   *  API Key、真实 sessionId/wxid/姓名/聊天文本；不落任何持久化存储（仅运行日志一行） */
  private logModelEgressDiagnostic(
    taskId: string,
    safeMessages: Array<{ role: string; content: string }>,
    knownSessionId: string | undefined
  ): void {
    if (process.env.WEFLOW_HERMES_PRIVACY_DIAG !== '1') return
    const texts = safeMessages.map((m) => String(m?.content ?? ''))
    const joined = texts.join('\n')
    const issueCount = findHermesBoundaryIssues({ messages: texts }).length
    this.log('INFO', [
      '[隐私诊断] 模型出口',
      `taskId=${taskId}`,
      `messageCount=${texts.length}`,
      `boundaryIssueCount=${issueCount}`,
      `containsKnownSessionId=${knownSessionId ? texts.some((t) => t.includes(knownSessionId)) : false}`,
      `containsPhone=${/(?<!\d)1[3-9]\d{9}(?!\d)/.test(joined)}`,
      `containsIdCard=${/(?<!\d)\d{17}[\dXx](?!\d)/.test(joined)}`
    ].join(' '))
  }

  /** 工具执行宿主：白名单 + capabilityContextId 重校验 → 真实上下文映射 → 只把具体数据库
   *  读取放进 enqueueSalesTask → 结果回传前再脱敏（原始 messageKey 换成不透明 evidenceHandle
   *  存 Main 锚点表） */
  private async hostToolExecute(
    req: Extract<HermesHostRequest, { capability: 'tool.execute' }>,
    cap: CapContext,
    capId: string,
    expectedRunId: number | undefined,
    child: HermesUtilityChild | null
  ): Promise<void> {
    if (req.capabilityContextId !== capId) {
      this.respondHost(req.requestId, req.taskId, child, {
        ok: false,
        error: { code: 'forbidden', message: '任务上下文不匹配，已拒绝执行。' }
      })
      return
    }
    const tool = this.tools.find((t) => t.name === req.tool)
    if (!tool) {
      this.respondHost(req.requestId, req.taskId, child, {
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
    } catch {
      this.log('WARN', `${req.taskId} 工具 ${req.tool} 执行异常 errorCode=internal`)
      result = { ok: false, publicSummary: '查询失败', errorCode: 'internal' }
    }
    // 工具 await 返回后统一复验：在此之前不做脱敏、evidenceHandle 分配或 evidence anchor 登记。
    const status = this.validateHostOperation(req.taskId, capId, cap.fingerprint, expectedRunId, child)
    if (status !== 'ok') {
      this.settleInvalidHostOperation(req, child, status)
      return
    }
    this.respondHost(req.requestId, req.taskId, child, {
      ok: true,
      result: this.maskToolResult(req.taskId, tool.name, result, cap.sessionId)
    })
  }

  /** 工具结果出 Utility 前再脱敏：data 走 Core 同源实现（IDENTITY_FIELD_PATHS 真源共享 +
   *  messageKey 删除 + 敏感值精确收集）；evidence/summary 文本走 maskText + 精确替换；
   *  每条原始证据分配不透明 evidenceHandle（原始 messageKey 只存 Main 锚点表，绝不回传） */
  private maskToolResult(
    taskId: string,
    toolName: string,
    result: HermesToolResult,
    sessionId?: string
  ): HermesProtocolToolResult {
    const exact = new Map<string, string>()
    if (sessionId) exact.set(sessionId, '***')
    const anchors = this.evidenceAnchorsByTask.get(taskId)
    const data = maskDataCopyForBridge(toolName, result.data ?? null, exact, this.maskTextFn, this.maskIdFn)
    const evidence = (result.evidence ?? []).map((ev) => {
      let handle: string | undefined
      if (anchors) {
        handle = `evh-${Date.now().toString(36)}-${++this.evidenceHandleSeq}`
        anchors.set(handle, ev)
      }
      return {
        label: maskOutboundTextForBridge(ev.label, exact, this.maskTextFn),
        kind: ev.kind,
        entityId: ev.entityId,
        excerpt: ev.excerpt !== undefined ? maskOutboundTextForBridge(ev.excerpt, exact, this.maskTextFn) : undefined,
        evidenceHandle: handle
      }
    })
    return {
      ok: result.ok,
      data,
      evidence,
      publicSummary: maskOutboundTextForBridge(result.publicSummary, exact, this.maskTextFn),
      errorCode: result.errorCode
    }
  }

  /** 回应宿主请求：只发给发起请求的 child（child 已崩溃/被替换 → 丢弃，绝不发给新 child）。
   *  成功载荷被出站唯一出口拒发（脱敏后仍含边界违规）时：立即回受控错误让 Utility 侧
   *  马上落定（绝不挂到请求超时），并把任务终止为 failed/boundary_violation */
  private respondHost(
    requestId: string,
    taskId: string,
    child: HermesUtilityChild | null,
    payload: { ok: boolean; text?: string; result?: HermesProtocolToolResult; error?: { code: string; message: string } }
  ): void {
    if (!child || this.child !== child) return // 亲和失败：旧请求的延迟结果一律丢弃
    const base = { protocolVersion: HERMES_PROTOCOL_VERSION, id: createHermesMessageId(), type: 'host.response' as const, requestId, taskId }
    const msg: MainToUtilityMessage = payload.ok
      ? payload.text !== undefined
        ? { ...base, ok: true, text: payload.text }
        : { ...base, ok: true, result: payload.result }
      : { ...base, ok: false, error: payload.error ?? { code: 'internal', message: FRIENDLY_ERROR.internal } }
    if (this.sendToUtility(msg)) return
    if (!payload.ok) return // 错误响应由 Main 常量构造，理论必过；真被拒只留出口日志
    this.log('WARN', `host.response 出口拒发，任务按边界违规收尾 taskId=${taskId}`)
    this.sendToUtility({
      protocolVersion: HERMES_PROTOCOL_VERSION,
      id: createHermesMessageId(),
      type: 'host.response',
      requestId,
      taskId,
      ok: false,
      error: { code: 'boundary_violation', message: MANAGER_ERROR.boundary_violation }
    })
    this.expireTask(taskId, 'boundary_violation')
  }

  // ── 内部辅助 ──────────────────────────────────────────────────────────────

  /** 任务能力失效（capability 封禁单点）：删除 capability 映射并加入 expiredTasks →
   *  abort 在途模型请求 → 快照未收尾时置 failed/errorCode 并广播。此后该任务的
   *  continue/host.request 一律 context_expired，progress/checkpoint 一律被门禁丢弃 */
  private expireTask(taskId: string, errorCode: 'context_expired' | 'boundary_violation', force = false): void {
    const capId = this.taskCap.get(taskId)
    if (capId) {
      this.taskCap.delete(taskId)
      this.capContexts.delete(capId)
    }
    this.expiredTasks.add(taskId)
    for (const ac of this.modelAborts.get(taskId) ?? []) ac.abort()
    const snap = this.snapshots.get(taskId)
    const terminal = snap && (snap.status === 'completed' || snap.status === 'failed' || snap.status === 'cancelled')
    if (snap && (!terminal || force)) {
      const failed: HermesTask = {
        ...snap,
        status: 'failed',
        errorCode,
        errorMessage: MANAGER_ERROR[errorCode] ?? FRIENDLY_ERROR.internal,
        steps: [],
        result: undefined
      }
      this.snapshots.set(taskId, failed)
      this.settled.add(taskId)
      this.emit(failed)
    }
  }

  /** 账号/身份切换的主动失效入口（main.ts 在 config:set myWxid 切库后调用）：立即终止
   *  全部未收尾任务并封禁其 capability。已完成任务只封能力不复写结果（历史展示不变，
   *  但 continue/host.request 全部被拒）。reason 仅进日志，便于归因 account_changed 等 */
  invalidateCapabilities(reason: string): void {
    const taskIds = [...this.taskCap.keys()]
    if (taskIds.length === 0) return
    this.log('WARN', `上下文变化，失效全部任务能力 reason=${reason} count=${taskIds.length}`)
    for (const taskId of taskIds) this.expireTask(taskId, 'context_expired')
  }

  /** 工具清单（只含公开元数据四字段；绝无工具实现与凭据） */
  private manifest(): HermesToolManifestEntry[] {
    return this.tools.map((t) => ({
      name: t.name,
      publicLabel: t.publicLabel,
      description: t.description,
      argsHint: t.argsHint
    }))
  }

  /** Main → Utility 唯一出口：协议运行时校验 + findHermesBoundaryIssues 边界扫描双检。
   *  返回是否真正发出——调用方据此让对应任务及时落定（如 boundary_violation），
   *  绝不出现「拒发后干等宿主超时」。日志只含消息 type 与违规路径，不含违规值 */
  private sendToUtility(msg: MainToUtilityMessage): boolean {
    if (!this.child) return false
    const type = String((msg as { type?: unknown }).type)
    if (!isMainToUtilityMessage(msg)) {
      this.log('WARN', `拒绝发送非法出站消息 type=${type}`)
      return false
    }
    const issues = findHermesBoundaryIssues(msg)
    if (issues.length > 0) {
      this.log('WARN', `拒绝发送边界违规出站消息 type=${type} errorCode=boundary_violation`)
      return false
    }

    this.child.postMessage(msg)
    return true
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
    this.expiredTasks.delete(taskId)
    this.taskRunGeneration.delete(taskId)
    const capId = this.taskCap.get(taskId)
    if (capId) {
      this.taskCap.delete(taskId)
      this.capContexts.delete(capId)
    }
    this.modelAborts.delete(taskId)
    // 原始任务文本与证据锚点（含真实 messageKey）随任务淘汰同步删除，Main 侧不留痕
    this.rawTextByTask.delete(taskId)
    this.evidenceAnchorsByTask.delete(taskId)
    this.refAnchorsByTask.delete(taskId)
  }
}

/** 工厂（main.ts 生产接线与动态测试共用；electron 依赖经 forkProcess 注入，模块可被 tsx 加载） */
export function createHermesUtilityManager(deps: HermesUtilityManagerDeps): HermesUtilityManager {
  return new HermesUtilityManager(deps)
}
