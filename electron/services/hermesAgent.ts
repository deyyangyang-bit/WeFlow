/**
 * hermesAgent.ts —— Hermes 只读智能体服务壳（主进程侧组装与生命周期）
 *
 * 本文件只负责：任务表（Map，上限 50 FIFO）、进度监听、依赖组装（AI 补全通道 / 白名单
 * 工具 / salesQueue 串行执行 / 出站脱敏 / 日志）。Agent Loop 本体（prompt 格式、严格 JSON
 * 协议、工具选择校验、非法输出重试、证据核验、超时/步数上限）全部在 hermesAgentCore.ts，
 * 依赖全注入——调用方（IPC 层）零逻辑，未来 UtilityProcess 复用同一 Core。
 *
 * 铁律锚点（hermes-agent-test 动态/静态断言）详见 hermesAgentCore.ts 顶部注释；
 * 改 Agent 行为先跑 scripts/hermes-agent-test.ts。
 */
import { callChatCompletion, getAiModelConfig, isAiConfigured } from './ai/aiApiClient'
import { ConfigService } from './config'
import { getOwnerIdentity } from './identityService'
import { maskPrivateText } from './crmSla2Service'
import {
  HERMES_TOOLS,
  maskStructuredId,
  type HermesToolDef,
  type HermesToolContext,
  type HermesToolResult
} from './hermesToolRegistry'
import { salesLog } from './salesLogger'
import { enqueueSalesTask } from './salesQueue'
import {
  HermesAgentCore,
  AGENT_TEMPERATURE,
  TASK_DEADLINE_MS,
  FRIENDLY_ERROR,
  type HermesAgentTaskRuntime,
  type HermesCompletion,
  type HermesTask
} from './hermesAgentCore'

// 域类型真源在 hermesAgentCore（Loop 本体）；此处 re-export 维持既有 import 路径不变
export type {
  HermesTaskStatus,
  HermesTaskStep,
  HermesFinding,
  HermesTaskResult,
  HermesTask,
  HermesCompletion,
  HermesAgentTaskRuntime,
  HermesCoreDeps
} from './hermesAgentCore'

/** 工具入参契约（startTask/continueTask 共用） */
export type HermesTaskContext =
  | { kind: 'global' }
  | { kind: 'chat'; sessionId?: string }
  | { kind: 'customer'; accountId?: number; sessionId?: string }

export interface HermesAgentTaskInput {
  goal: string
  /** 入口上下文：customer=客户档案（带 accountId/sessionId）/ chat=会话 / global=全局 */
  context?: HermesTaskContext
  contextLabel?: string
}

/** 进度监听（主进程接线到 hermes:task:progress 事件；callback 收到任务快照拷贝） */
type ProgressListener = (task: HermesTask) => void

/** 任务表上限（FIFO 淘汰；服务壳职责，与 Loop 无关） */
const MAX_KEPT_TASKS = 50

/** 服务层依赖（测试注入；Loop 的注入依赖见 hermesAgentCore.HermesCoreDeps） */
export interface HermesAgentDeps {
  config?: ConfigService
  /** 测试注入：AI 补全（缺省 callChatCompletion + responseFormatJson） */
  completion?: HermesCompletion
  /** 测试注入：configured 判定（缺省 isAiConfigured） */
  configured?: () => boolean
  /** 测试注入：工具注册表（缺省白名单唯一真源 HERMES_TOOLS） */
  tools?: readonly HermesToolDef[]
}

export class HermesAgentService {
  private tasks = new Map<string, HermesAgentTaskRuntime>()
  private listeners = new Set<ProgressListener>()
  private seq = 0

  /** 注册进度监听（返回退订函数；IPC 层接线用） */
  onProgress(listener: ProgressListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** 对外任务快照（拷贝 steps/evidence/result，防调用方改内部真源） */
  getTask(taskId: string): HermesTask | null {
    const rt = this.tasks.get(String(taskId || '').trim())
    if (!rt) return null
    return this.snapshot(rt)
  }

  /** 发起任务：建任务（planning）→ 异步跑 Loop。立即返回快照；进度经 onProgress 推送 */
  async startTask(input: HermesAgentTaskInput, deps?: HermesAgentDeps): Promise<{ ok: boolean; task?: HermesTask; errorCode?: string }> {
    const goal = String(input?.goal || '').trim()
    if (!goal) return { ok: false, errorCode: 'bad_request' }
    if (this.isConfigured(deps) === false) {
      return { ok: false, errorCode: 'not_configured' }
    }
    const now = Date.now()
    const taskId = `hermes-${now}-${++this.seq}`
    const ctx = input.context?.kind === 'chat' || input.context?.kind === 'customer' ? input.context : { kind: 'global' as const }
    const rt: HermesAgentTaskRuntime = {
      task: {
        taskId,
        status: 'planning',
        goal,
        contextLabel: input.contextLabel || this.defaultContextLabel(ctx),
        steps: [],
        evidence: [],
        createdAt: now
      },
      conversation: [],
      evidenceByRef: new Map(),
      nextEvidenceSeq: 0,
      lastCallKey: '',
      runId: 1,
      deadlineAt: now + TASK_DEADLINE_MS,
      abort: null,
      cancelRequested: false,
      turnRunning: false,
      okToolCalls: 0,
      unresolvedToolFailure: false,
      dataRetries: 0,
      // 归属别名随身份一并下发（中央下行归属用中央显示名落地，署名可以不同；问数据过滤与页面同口径）
      identity: getOwnerIdentity() ?? { name: '', role: '' },
      contextKind: ctx.kind,
      accountId: ctx.kind === 'customer' ? Number(ctx.accountId || 0) || undefined : undefined,
      sessionId: 'sessionId' in ctx ? String(ctx.sessionId || '') || undefined : undefined
    }
    this.tasks.set(taskId, rt)
    this.evictOldTasks()
    this.emit(rt)
    // 异步跑 Loop（IPC 层立即返回 planning 快照；后续经 progress 事件推送）
    void this.buildCore(deps).runTurn(rt, goal).catch((e) => {
      salesLog('WARN', `[HermesAgent] ${taskId} loop 异常: ${(e as Error)?.message || e}`)
    })
    return { ok: true, task: this.snapshot(rt) }
  }

  /** 多轮追问：completed/failed 任务带摘要窗口续跑；running 期间拒绝（busy） */
  async continueTask(taskId: string, question: string, deps?: HermesAgentDeps): Promise<{ ok: boolean; task?: HermesTask; errorCode?: string }> {
    const rt = this.tasks.get(String(taskId || '').trim())
    if (!rt) return { ok: false, errorCode: 'not_found' }
    const q = String(question || '').trim()
    if (!q) return { ok: false, errorCode: 'bad_request' }
    if (rt.turnRunning || rt.task.status === 'running' || rt.task.status === 'planning') return { ok: false, errorCode: 'busy' }
    if (rt.cancelRequested) return { ok: false, errorCode: 'cancelled' }
    if (this.isConfigured(deps) === false) return { ok: false, errorCode: 'not_configured' }

    // 新一轮：清上轮步骤/错误（历史对话保留做摘要窗口；证据表保留可继续引用；
    // 重复检测键重置——追问「重新查一下」不算循环；零数据纠偏次数与失败查询闭锁按轮重置，
    // 每轮追问都重新拥有完整的纠偏预算，跨轮其他语义不变）
    rt.task.steps = []
    rt.task.result = undefined
    rt.task.errorCode = undefined
    rt.task.errorMessage = undefined
    rt.task.status = 'running'
    rt.lastCallKey = ''
    rt.unresolvedToolFailure = false
    rt.dataRetries = 0
    rt.deadlineAt = Date.now() + TASK_DEADLINE_MS
    this.emit(rt)
    void this.buildCore(deps).runTurn(rt, q).catch((e) => {
      salesLog('WARN', `[HermesAgent] ${rt.task.taskId} continue 异常: ${(e as Error)?.message || e}`)
    })
    return { ok: true, task: this.snapshot(rt) }
  }

  /** 取消：置标志 + abort 在途 AI 调用；Loop 在安全点检查并丢弃在途结果 */
  cancelTask(taskId: string): { ok: boolean; task?: HermesTask } {
    const rt = this.tasks.get(String(taskId || '').trim())
    if (!rt) return { ok: false }
    rt.cancelRequested = true
    rt.abort?.abort()
    // 只在任务未收尾时置 cancelled（已完成的结果不受取消影响）
    if (rt.task.status === 'planning' || rt.task.status === 'running') {
      rt.task.status = 'cancelled'
      rt.task.errorCode = 'cancelled'
      rt.task.errorMessage = FRIENDLY_ERROR.cancelled
      rt.turnRunning = false
      this.emit(rt)
    }
    return { ok: true, task: this.snapshot(rt) }
  }

  // ─── Core 依赖组装（主进程生产实现）────────────────────────────────────────

  /** 组装 Agent Core：AI 补全走 aiApiClient（AGENT_TEMPERATURE + JSON 响应格式），
   *  工具执行统一入 salesQueue 串行（铁律：防原生 WCDB 并发；Loop 本体不在队列内，
   *  此处 enqueue 不会等待自己，无死锁；AI 网络调用不入队——它不碰 WCDB），
   *  出站脱敏走 maskPrivateText / maskStructuredId，进度回灌 emit，日志走 salesLog。
   *  测试可整体覆盖（deps.completion/configured/tools）。 */
  private buildCore(deps?: HermesAgentDeps): HermesAgentCore {
    const self = this
    const completion: HermesCompletion = deps?.completion ?? ((messages, timeoutMs, signal) => {
      const mc = getAiModelConfig(deps?.config as ConfigService)
      return callChatCompletion(
        mc,
        messages.map((m) => ({ role: m.role, content: m.content })),
        { temperature: AGENT_TEMPERATURE, timeoutMs, signal, responseFormatJson: true, usageContext: { purpose: 'hermes' } }
      )
    })
    return new HermesAgentCore({
      completion,
      tools: deps?.tools ?? HERMES_TOOLS,
      executeTool: (tool: HermesToolDef, args: Record<string, unknown>, ctx: HermesToolContext): Promise<HermesToolResult> =>
        enqueueSalesTask(() => tool.run(args, ctx)),
      maskText: (s) => maskPrivateText(s),
      maskId: (s) => maskStructuredId(s),
      onUpdate: (rt) => self.emit(rt),
      log: (level, msg) => salesLog(level, `[HermesAgent] ${msg}`)
    })
  }

  // ─── 辅助 ──────────────────────────────────────────────────────────────────

  /** 入口上下文人话标签 */
  private defaultContextLabel(ctx: HermesAgentTaskInput['context']): string {
    if (!ctx || ctx.kind === 'global') return '全局'
    return ctx.kind === 'chat' ? '当前会话' : '当前客户'
  }

  private isConfigured(deps?: HermesAgentDeps): boolean {
    if (deps?.configured) return deps.configured()
    if (deps?.config) return isAiConfigured(deps.config)
    // 缺省走运行时配置（与 identityService 同口径：ConfigService.getInstance）
    try {
      return isAiConfigured(ConfigService.getInstance())
    } catch {
      return false
    }
  }

  private evictOldTasks(): void {
    if (this.tasks.size <= MAX_KEPT_TASKS) return
    const keys = [...this.tasks.keys()]
    while (keys.length > MAX_KEPT_TASKS) {
      const k = keys.shift()
      if (k) this.tasks.delete(k)
    }
  }

  private snapshot(rt: HermesAgentTaskRuntime): HermesTask {
    return {
      ...rt.task,
      steps: rt.task.steps.map((s) => ({ ...s })),
      evidence: rt.task.evidence.map((e) => ({ ...e })),
      result: rt.task.result ? { ...rt.task.result } : undefined
    }
  }

  private emit(rt: HermesAgentTaskRuntime): void {
    const snap = this.snapshot(rt)
    for (const l of this.listeners) {
      try { l(snap) } catch { /* 单个监听失败不影响任务 */ }
    }
  }
}

/** 单例（主进程内存；不落盘不建表） */
export const hermesAgentService = new HermesAgentService()
