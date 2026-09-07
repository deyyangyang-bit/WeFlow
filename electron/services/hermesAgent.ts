/**
 * hermesAgent.ts —— Hermes 只读智能体（设计-Hermes-MVP 智能体第一刀，深模块）
 *
 * 对外只有四个接口：startTask / continueTask / cancelTask / getTask。
 * prompt 格式、严格 JSON 协议、工具选择校验、可见性过滤（ownerFilter 展示层，经工具注册表）、
 * 非法输出重试、证据核验、超时/步数上限——全部内藏在本模块，调用方（IPC 层）零逻辑。
 *
 * 铁律（hermes-agent-test 动态/静态断言锚点，改本文件先跑测试）：
 *  - 真实多步骤 Agent Loop：模型 → 白名单选工具 → 本地校验 → 执行 → 结果回喂 → complete；
 *    绝不用关键词模板冒充 Loop，绝不伪造步骤（每个 step 对应一次真实模型决策或真实工具执行）
 *  - 严格 JSON 协议：{type:'tool_call',tool,arguments,reason} /
 *    {type:'complete',summary,findings:[{text,evidenceRefs}],nextSteps,evidenceRefs}；
 *    非法 JSON 纠正重试至多 1 次；模型不输出 SQL/不指定 IPC/不碰文件系统/绕不过可见性过滤
 *    （filterByOwner 是展示层可见性过滤非安全边界，语义唯一源在工具注册表，模型不可指定身份）
 *  - 结论必须来自真实查询：本任务没有任何成功的工具执行时，complete 一律拒绝（回喂纠偏
 *    至多 1 次，坚持则 failed）；findings 逐条绑定 evidenceRefs
 *  - 证据约束闭环：工具零行证据时兜底登记 result 级证据（查询无结果/未成功，kind='result'）；
 *    接受 complete 要求「顶层 refs ∪ findings refs 的有效并集非空 + 每条 finding 至少一个
 *    有效编号」；展示证据按有效引用并集从 evidenceByRef 真源重建（多轮重引可恢复）
 *  - 限制：最大 6 次工具调用；单任务约 90s；重复同工具同参数不执行（回喂提示）；
 *    取消后丢弃在途结果；不无限循环
 *  - 任务状态只存主进程内存（Map，上限 50 条 FIFO），不建表、不落盘
 *  - 日志不记密钥/完整 prompt/大段聊天内容（只记 taskId/状态/工具名）
 */
import { callChatCompletion, getAiModelConfig, isAiConfigured } from './ai/aiApiClient'
import { ConfigService } from './config'
import { getIdentity } from './identityService'
import type { IdentityLike } from '../../shared/ownerFilter'
import {
  findHermesTool,
  buildToolManifestPrompt,
  type HermesToolDef,
  type HermesEvidence,
  type HermesToolContext,
  type HermesToolResult
} from './hermesToolRegistry'
import { salesLog } from './salesLogger'
import { enqueueSalesTask } from './salesQueue'

// ─── 状态模型（任务书 §6）──────────────────────────────────────────────────────

export type HermesTaskStatus = 'planning' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface HermesTaskStep {
  /** 人话步骤名（给用户看） */
  label: string
  status: 'running' | 'done' | 'error'
  /** 实际调用的白名单工具名 */
  tool?: string
  /** 面向用户的一句话结果摘要（来自工具 publicSummary，不是模型转述） */
  publicSummary?: string
}

/** 单条发现：结论事实必须绑定支持它的证据编号（核验后保留，伪造编号剔除） */
export interface HermesFinding {
  text: string
  evidenceRefs: string[]
}

export interface HermesTaskResult {
  summary: string
  findings: HermesFinding[]
  nextSteps: string[]
}

export interface HermesTask {
  taskId: string
  status: HermesTaskStatus
  goal: string
  /** 入口上下文的人话标签：「全局」/「会话：xxx」/「客户：xxx」 */
  contextLabel: string
  steps: HermesTaskStep[]
  evidence: Array<HermesEvidence & { ref: string }>
  result?: HermesTaskResult
  /** 机器错误码（not_configured/cancelled/timeout/too_many_steps/ai_invalid_output/ai_error/internal/busy/not_found） */
  errorCode?: string
  /** 人话错误文案（绝不出现 SQL/IPC/堆栈/路径） */
  errorMessage?: string
  createdAt: number
}

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

// ─── 限制常量（任务书 §8）──────────────────────────────────────────────────────

const MAX_TOOL_CALLS = 6
const TASK_DEADLINE_MS = 90_000
const MAX_INVALID_RETRIES = 1
/** 零数据 complete 纠偏次数（回喂让模型先去调工具；坚持则 failed） */
const MAX_DATA_RETRIES = 1
const MAX_KEPT_TASKS = 50
/** 多轮摘要窗口：最近保留的对话条数（system + goal 首条不占） */
const CONVERSATION_WINDOW = 16
const AGENT_TEMPERATURE = 0.2

/** 人话错误文案（唯一映射出口；UI 只显示这条，绝不透传底层异常） */
const FRIENDLY_ERROR: Record<string, string> = {
  not_configured: '还没有配置 AI 模型：请到 设置 → AI 设置 完成配置后再试。',
  cancelled: '任务已取消。',
  timeout: '这次分析用时太长，已停止。请换个更具体的目标重试。',
  too_many_steps: '这个问题需要太多查询步骤，已停止。请把目标拆得更具体一些。',
  ai_invalid_output: '暂时无法查询，请重试。若问题持续，请重启 WeFlow 或联系管理员。',
  ai_error: '暂时无法查询，请重试。若问题持续，请重启 WeFlow 或联系管理员。',
  internal: '暂时无法查询，请重试。若问题持续，请重启 WeFlow 或联系管理员。'
}

// ─── 内部结构 ────────────────────────────────────────────────────────────────

/** 对话消息（内存窗口，绝不落盘/不进日志） */
interface AgentMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** 内存任务运行时（真源；getTask 返回对外快照） */
interface AgentTaskRuntime {
  task: HermesTask
  conversation: AgentMessage[]
  /** 证据登记表 ref → evidence（防伪造校验的真源） */
  evidenceByRef: Map<string, HermesEvidence>
  nextEvidenceSeq: number
  /** 最近一次同工具同参数（重复检测） */
  lastCallKey: string
  deadlineAt: number
  abort: AbortController | null
  cancelRequested: boolean
  turnRunning: boolean
  /** 任务级成功工具执行计数（跨轮累计；0 = 还没有真实数据，complete 一律拒绝） */
  okToolCalls: number
  /** 零数据 complete 的纠偏次数（至多 1 次，坚持则 failed） */
  dataRetries: number
  /** 任务上下文（startTask 时定格；工具 owner 过滤与 prompt 锚点共用） */
  identity: IdentityLike
  contextKind: 'global' | 'chat' | 'customer'
  accountId?: number
  sessionId?: string
}

/** 单一固定 system prompt（差异全部放 user prompt；铁律：不拼第二套 persona） */
const AGENT_SYSTEM_PROMPT = [
  '你是 Hermes，WeFlow 的只读销售分析助手。你通过调用白名单工具查询本机业务数据后给出结构化建议。',
  '硬性规则：',
  '1. 你只能输出一个 JSON 对象，绝不输出任何其他文字、解释或 Markdown 代码块。',
  '2. 需要数据时输出：{"type":"tool_call","tool":"工具名","arguments":{...},"reason":"一句话说明为什么查"}。',
  '3. 数据足够时输出：{"type":"complete","summary":"一句话结论","findings":[{"text":"发现","evidenceRefs":["e1"]}],"nextSteps":["建议"],"evidenceRefs":["e1"]}——findings 每条发现必须绑定支持它的证据编号。',
  '4. 没有通过工具查询到任何真实数据之前，绝不能输出 complete；必须先调用工具。',
  '5. 结论里的每一个事实都必须来自工具返回的数据，绝不编造数字、客户、合同或知识内容。',
  '6. evidenceRefs 只能引用工具结果里给你的证据编号（如 e1、e2），绝不虚构编号。',
  '7. 你是只读助手：不能发消息、不能建待办、不能改客户或商机、不能发布知识。',
  '8. 工具查不到就照实说，不要猜测你看不到的客户是否存在。',
  '9. 绝不输出 SQL、内部接口名或文件路径。',
  '可用工具清单：'
].join('\n')

// ─── JSON 解析（严格协议；失败返回 null 由调用方决定重试）──────────────────────

type AgentDecision =
  | { type: 'tool_call'; tool: string; arguments: Record<string, unknown>; reason: string }
  | { type: 'complete'; summary: string; findings: Array<{ text: string; evidenceRefs: string[] }>; nextSteps: string[]; evidenceRefs: string[] }

/** 提取首个 {...} JSON（容忍模型裹 ```json 围栏——但内容仍必须严格匹配协议字段） */
function extractJsonObject(text: string): Record<string, unknown> | null {
  const s = String(text || '').trim()
  const start = s.indexOf('{')
  if (start < 0) return null
  const candidate = s.slice(start, s.lastIndexOf('}') + 1)
  if (!candidate) return null
  try {
    const j = JSON.parse(candidate)
    return j && typeof j === 'object' ? j as Record<string, unknown> : null
  } catch {
    return null
  }
}

/** 解析模型决策（协议字段逐一校验；不匹配 = null → 走重试） */
function parseAgentDecision(text: string): AgentDecision | null {
  const j = extractJsonObject(text)
  if (!j) return null
  if (j.type === 'tool_call') {
    const tool = String(j.tool || '').trim()
    const args = (j.arguments && typeof j.arguments === 'object') ? j.arguments as Record<string, unknown> : {}
    if (!tool) return null
    return { type: 'tool_call', tool, arguments: args, reason: String(j.reason || '') }
  }
  if (j.type === 'complete') {
    const summary = String(j.summary || '').trim()
    if (!summary) return null
    const arr = (v: unknown): string[] =>
      Array.isArray(v) ? v.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 8) : []
    const refs = Array.isArray(j.evidenceRefs) ? j.evidenceRefs.map((x) => String(x || '').trim()).filter(Boolean) : []
    // findings 协议 v2：对象数组 [{text, evidenceRefs}]；字符串数组（旧格式）= 非法协议走重试
    const findings: Array<{ text: string; evidenceRefs: string[] }> = []
    if (Array.isArray(j.findings)) {
      for (const item of j.findings) {
        if (!item || typeof item !== 'object') continue
        const rec = item as Record<string, unknown>
        const text = String(rec.text || '').trim()
        if (!text) continue
        const frefs = Array.isArray(rec.evidenceRefs)
          ? rec.evidenceRefs.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 6)
          : []
        findings.push({ text, evidenceRefs: frefs })
        if (findings.length >= 8) break
      }
      // 旧格式（纯字符串条目）解析不出任何结构化发现 = 非法协议，强制纠偏
      if (findings.length === 0 && j.findings.length > 0) return null
    }
    return { type: 'complete', summary, findings, nextSteps: arr(j.nextSteps), evidenceRefs: refs }
  }
  return null
}

/** 工具调用去重键（同工具同参数 = 重复） */
function callKeyOf(tool: string, args: Record<string, unknown>): string {
  return `${tool}::${JSON.stringify(args)}`
}

// ─── 服务 ────────────────────────────────────────────────────────────────────

/** completion 依赖（测试注入 fake；生产走 aiApiClient） */
export type HermesCompletion = (messages: AgentMessage[], timeoutMs: number, signal: AbortSignal) => Promise<string>

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
  private tasks = new Map<string, AgentTaskRuntime>()
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
    const rt: AgentTaskRuntime = {
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
      deadlineAt: now + TASK_DEADLINE_MS,
      abort: null,
      cancelRequested: false,
      turnRunning: false,
      okToolCalls: 0,
      dataRetries: 0,
      identity: getIdentity() ?? { name: '', role: '' },
      contextKind: ctx.kind,
      accountId: ctx.kind === 'customer' ? Number(ctx.accountId || 0) || undefined : undefined,
      sessionId: 'sessionId' in ctx ? String(ctx.sessionId || '') || undefined : undefined
    }
    this.tasks.set(taskId, rt)
    this.evictOldTasks()
    this.emit(rt)
    // 异步跑 Loop（IPC 层立即返回 planning 快照；后续经 progress 事件推送）
    void this.runTurn(rt, goal, deps).catch((e) => {
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
    // 重复检测键重置——追问「重新查一下」不算循环）
    rt.task.steps = []
    rt.task.result = undefined
    rt.task.errorCode = undefined
    rt.task.errorMessage = undefined
    rt.task.status = 'running'
    rt.lastCallKey = ''
    rt.deadlineAt = Date.now() + TASK_DEADLINE_MS
    this.emit(rt)
    void this.runTurn(rt, q, deps).catch((e) => {
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

  // ─── Agent Loop 核心（真实多步骤；一切校验内藏）─────────────────────────────

  private async runTurn(rt: AgentTaskRuntime, userQuestion: string, deps?: HermesAgentDeps): Promise<void> {
    rt.turnRunning = true
    rt.task.status = 'running'
    this.emit(rt)
    try {
      // 组对话窗口（system 固定；goal 首条保留；超出窗口的旧消息按摘要窗口丢弃）
      this.pushConversation(rt, { role: 'user', content: this.buildUserPrompt(rt, userQuestion) })
      const messages = (): AgentMessage[] => [
        { role: 'system', content: `${AGENT_SYSTEM_PROMPT}\n${buildToolManifestPrompt()}` },
        ...this.windowedConversation(rt)
      ]

      let invalidRetries = 0
      let toolCalls = 0

      while (true) {
        // 取消 / 超时安全点
        if (rt.cancelRequested) { this.discardInFlight(rt); return }
        if (Date.now() > rt.deadlineAt) { this.failTask(rt, 'timeout'); return }

        let said: string
        try {
          const remain = Math.max(3_000, rt.deadlineAt - Date.now())
          rt.abort = new AbortController()
          said = await this.completion(deps)(messages(), remain, rt.abort.signal)
        } catch (e) {
          if (rt.cancelRequested) { this.discardInFlight(rt); return }
          this.failTask(rt, 'ai_error')
          salesLog('WARN', `[HermesAgent] ${rt.task.taskId} AI 调用失败: ${(e as Error)?.message || e}`)
          return
        }
        rt.abort = null

        // 取消后丢弃在途结果（completion 已返回也不采纳）
        if (rt.cancelRequested) { this.discardInFlight(rt); return }

        const decision = parseAgentDecision(said)
        if (!decision) {
          if (invalidRetries >= MAX_INVALID_RETRIES) { this.failTask(rt, 'ai_invalid_output'); return }
          invalidRetries++
          this.pushConversation(rt, [
            { role: 'assistant', content: String(said || '').slice(0, 500) },
            { role: 'user', content: '输出不符合协议：只输出一个 JSON 对象，type 必须是 tool_call 或 complete。请重新输出。' }
          ])
          continue
        }

        if (decision.type === 'complete') {
          // 证据约束闭环：零真实查询 / 结论无任何有效证据引用 / 个别发现缺有效引用 →
          // 一律拒绝并回喂纠偏（至多 1 次，坚持则 failed）——绝不把无据结论标记为完成
          const rejectReason = this.validateCompletion(rt, decision)
          if (rejectReason) {
            if (rt.dataRetries >= MAX_DATA_RETRIES) { this.failTask(rt, 'ai_invalid_output'); return }
            rt.dataRetries++
            this.pushConversation(rt, [
              { role: 'assistant', content: String(said || '').slice(0, 500) },
              { role: 'user', content: rejectReason }
            ])
            continue
          }
          this.completeTask(rt, decision)
          return
        }

        // tool_call：步数上限
        toolCalls++
        if (toolCalls > MAX_TOOL_CALLS) { this.failTask(rt, 'too_many_steps'); return }

        // 白名单校验（清单外 = 调不到：不执行，回喂错误让模型改道）
        const tool = this.resolveTool(decision.tool, deps)
        const step: HermesTaskStep = {
          label: decision.reason ? `${decision.reason}` : `调用 ${decision.tool}`,
          status: 'running',
          tool: decision.tool
        }
        rt.task.steps.push(step)
        this.emit(rt)

        if (!tool) {
          step.status = 'error'
          step.publicSummary = '工具不存在'
          this.pushConversation(rt, [
            { role: 'assistant', content: JSON.stringify({ type: 'tool_call', tool: decision.tool }) },
            { role: 'user', content: `工具 ${decision.tool} 不在白名单内，已拒绝执行。只能使用清单中的工具。` }
          ])
          this.emit(rt)
          continue
        }

        // 重复同工具同参数：不执行（防模型绕圈烧步数）
        const callKey = callKeyOf(decision.tool, decision.arguments)
        if (callKey === rt.lastCallKey) {
          step.status = 'error'
          step.publicSummary = '重复调用已跳过'
          this.pushConversation(rt, [
            { role: 'user', content: '这是与上一步完全相同的工具和参数，结果不会变化。请直接给 complete 结论，或换其他工具/参数。' }
          ])
          this.emit(rt)
          continue
        }
        rt.lastCallKey = callKey

        // 执行（owner 过滤/脱敏/只读都在工具注册表内；模型指定不了身份）。
        // 工具读库统一入 salesQueue 串行（铁律：防原生 WCDB 并发；Loop 本体不在队列内，
        // 此处 enqueue 不会等待自己，无死锁；AI 网络调用不入队——它不碰 WCDB）。
        let result: HermesToolResult
        try {
          result = await enqueueSalesTask(() => tool.run(decision.arguments, this.toolContext(rt)))
        } catch (e) {
          if (rt.cancelRequested) { this.discardInFlight(rt); return }
          // 工具实现异常也不外泄底层细节（错误码给人话；细节只进日志，不含聊天内容）
          salesLog('WARN', `[HermesAgent] ${rt.task.taskId} 工具 ${decision.tool} 异常: ${(e as Error)?.message || e}`)
          result = { ok: false, publicSummary: '查询失败', errorCode: 'internal' }
        }

        // 取消发生在工具执行期间：返回后立即检查，丢弃在途结果
        // （不改步骤、不登记证据、不回喂，绝不影响任务证据表）
        if (rt.cancelRequested) { this.discardInFlight(rt); return }

        if (result.ok) {
          rt.okToolCalls++
          step.status = 'done'
          step.publicSummary = result.publicSummary
        } else {
          step.status = 'error'
          step.publicSummary = result.publicSummary
        }
        this.emit(rt)

        // 登记真实证据 → 编号表回喂（模型只能引用编号，引用即校验）。
        // 工具没返回行证据时兜底登记一条 result 级证据（查询无结果/未成功）——
        // 「查不到」也是真实查询结论，模型给这类结论时必须有编号可绑。
        const refs: Array<{ ref: string; label: string }> = []
        for (const ev of result.evidence ?? []) {
          const ref = `e${++rt.nextEvidenceSeq}`
          rt.evidenceByRef.set(ref, ev)
          rt.task.evidence.push({ ...ev, ref })
          refs.push({ ref, label: ev.label })
        }
        if (refs.length === 0) {
          const fallback: HermesEvidence = {
            label: `「${decision.tool}」${result.ok ? '查询完成，无匹配结果' : '查询未成功'}${result.publicSummary ? `：${result.publicSummary.slice(0, 60)}` : ''}`,
            kind: 'result'
          }
          const ref = `e${++rt.nextEvidenceSeq}`
          rt.evidenceByRef.set(ref, fallback)
          rt.task.evidence.push({ ...fallback, ref })
          refs.push({ ref, label: fallback.label })
        }
        this.pushConversation(rt, [
          { role: 'user', content: JSON.stringify({
            type: 'tool_result',
            tool: decision.tool,
            ok: result.ok,
            data: result.data ?? null,
            error: result.ok ? undefined : (result.publicSummary || result.errorCode || '查询失败'),
            evidence: refs
          }) }
        ])
      }
    } finally {
      rt.turnRunning = false
      this.emit(rt)
    }
  }

  /** 工具解析（测试注入 fake registry；生产用白名单唯一真源 HERMES_TOOLS） */
  private resolveTool(name: string, deps?: HermesAgentDeps): HermesToolDef | undefined {
    if (deps?.tools) return deps.tools.find((t) => t.name === name)
    return findHermesTool(name)
  }

  // ─── 收尾（completed / failed / cancelled）─────────────────────────────────

  /** 证据约束校验（接受 complete 前置；返回 null = 接受，返回字符串 = 回喂给模型的纠偏语）：
   *  ① 本任务必须有过成功工具执行（okToolCalls）；② 顶层 refs + 全部 findings refs 的有效并集
   *  必须非空；③ 每条 finding 至少绑定一个有效编号（「查询无结果」的 result 级证据也算有效引用） */
  private validateCompletion(rt: AgentTaskRuntime, d: Extract<AgentDecision, { type: 'complete' }>): string | null {
    if (rt.okToolCalls <= 0) {
      return '你还没有通过工具查询到任何真实数据，不能直接给出结论。请根据目标调用合适的白名单工具，拿到数据后再输出 complete。'
    }
    const has = (ref: string): boolean => rt.evidenceByRef.has(ref)
    const anyValid = d.evidenceRefs.some(has) || d.findings.some((f) => f.evidenceRefs.some(has))
    if (!anyValid) {
      return '你的结论没有引用任何有效证据编号。只能引用工具结果里给你的编号（如 e1、e2），每条发现都要绑定支持它的证据；查询无结果时引用那条「无匹配结果」的证据编号。'
    }
    const badFinding = d.findings.find((f) => !f.evidenceRefs.some(has))
    if (badFinding) {
      return `发现「${badFinding.text.slice(0, 40)}」没有绑定任何有效证据编号。请为它补充支持它的证据编号（如 e1），或删除这条发现。`
    }
    return null
  }

  /** 完成：有效引用 = 顶层 refs ∪ 全部 findings refs（都过登记表核验），展示证据从
   *  evidenceByRef 真源按编号重建（多轮追问重新引用旧编号也能恢复）→ result */
  private completeTask(rt: AgentTaskRuntime, d: Extract<AgentDecision, { type: 'complete' }>): void {
    const has = (ref: string): boolean => rt.evidenceByRef.has(ref)
    const validRefs = [...new Set([...d.evidenceRefs, ...d.findings.flatMap((f) => f.evidenceRefs)])]
      .filter(has)
      .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))
    rt.task.result = {
      summary: d.summary,
      findings: d.findings.map((f) => ({ text: f.text, evidenceRefs: f.evidenceRefs.filter(has) })),
      nextSteps: d.nextSteps,
    }
    rt.task.evidence = validRefs
      .map((ref) => ({ ...rt.evidenceByRef.get(ref)!, ref }))
      .filter((ev) => !!ev.label)
    rt.task.status = 'completed'
    this.emit(rt)
  }

  private failTask(rt: AgentTaskRuntime, errorCode: string): void {
    if (rt.task.status === 'cancelled') return // 取消优先，不踩状态
    rt.task.status = 'failed'
    rt.task.errorCode = errorCode
    rt.task.errorMessage = FRIENDLY_ERROR[errorCode] || FRIENDLY_ERROR.internal
    this.emit(rt)
  }

  /** 取消后丢弃在途结果：状态定格 cancelled，不再采纳任何已返回内容 */
  private discardInFlight(rt: AgentTaskRuntime): void {
    rt.task.status = 'cancelled'
    rt.task.errorCode = 'cancelled'
    rt.task.errorMessage = FRIENDLY_ERROR.cancelled
    this.emit(rt)
  }

  // ─── 辅助 ──────────────────────────────────────────────────────────────────

  /** 工具执行上下文（身份 + 入口上下文锚点；工具内统一做 owner 过滤）。
   *  注意：sessionId 只是提示锚点，绝非授权凭据——客户类工具必须走
   *  account 行归属校验（registry 内 filterByOwner），不得信任工具上下文。 */
  private toolContext(rt: AgentTaskRuntime): HermesToolContext {
    if (rt.contextKind === 'customer') {
      return { identity: rt.identity, accountId: rt.accountId, sessionId: rt.sessionId }
    }
    if (rt.contextKind === 'chat') {
      return { identity: rt.identity, sessionId: rt.sessionId }
    }
    return { identity: rt.identity }
  }

  /** 入口上下文人话标签 */
  private defaultContextLabel(ctx: HermesAgentTaskInput['context']): string {
    if (!ctx || ctx.kind === 'global') return '全局'
    return ctx.kind === 'chat' ? '当前会话' : '当前客户'
  }

  /** user prompt：目标 + 上下文锚点（customer 入口注入 accountId；chat 入口引导先用 by_session 解析客户） */
  private buildUserPrompt(rt: AgentTaskRuntime, question: string): string {
    const ctxPart = rt.contextKind === 'customer' && rt.accountId
      ? `\n【当前上下文】用户在查看客户档案（accountId=${Number(rt.accountId)}），可先用 customer.current_view / crm.customer_business / chat.recent 查询该客户。`
      : rt.contextKind === 'chat' && rt.sessionId
        ? `\n【当前上下文】用户在会话「${rt.sessionId}」中发起。可先用 customer.by_session（sessionId="${rt.sessionId}"）解析出客户档案，再继续分析该客户。`
        : ''
    return `【销售目标】${question}${ctxPart}\n请开始分析。`
  }

  private pushConversation(rt: AgentTaskRuntime, msgs: AgentMessage | AgentMessage[]): void {
    const arr = Array.isArray(msgs) ? msgs : [msgs]
    rt.conversation.push(...arr)
  }

  /** 摘要窗口：goal 首条永远保留，其后只留最近 CONVERSATION_WINDOW 条 */
  private windowedConversation(rt: AgentTaskRuntime): AgentMessage[] {
    const conv = rt.conversation
    if (conv.length <= CONVERSATION_WINDOW + 1) return [...conv]
    return [conv[0], ...conv.slice(conv.length - CONVERSATION_WINDOW)]
  }

  private completion(deps?: HermesAgentDeps): HermesCompletion {
    if (deps?.completion) return deps.completion
    return (messages, timeoutMs, signal) => {
      const mc = getAiModelConfig(deps?.config as ConfigService)
      return callChatCompletion(
        mc,
        messages.map((m) => ({ role: m.role, content: m.content })),
        { temperature: AGENT_TEMPERATURE, timeoutMs, signal, responseFormatJson: true }
      )
    }
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

  private snapshot(rt: AgentTaskRuntime): HermesTask {
    return {
      ...rt.task,
      steps: rt.task.steps.map((s) => ({ ...s })),
      evidence: rt.task.evidence.map((e) => ({ ...e })),
      result: rt.task.result ? { ...rt.task.result } : undefined
    }
  }

  private emit(rt: AgentTaskRuntime): void {
    const snap = this.snapshot(rt)
    for (const l of this.listeners) {
      try { l(snap) } catch { /* 单个监听失败不影响任务 */ }
    }
  }
}

/** 单例（主进程内存；不落盘不建表） */
export const hermesAgentService = new HermesAgentService()
