/**
 * hermesProtocol.ts —— Hermes Main ↔ UtilityProcess 共享通信协议（版本 1，唯一真源）
 *
 * 本模块是 Main 进程与未来 Hermes UtilityProcess 之间的消息协议层：类型（discriminated union）
 * 与运行时校验都在这里，两边共用，禁止任何一侧自建第二套消息形态。
 * 本轮只定义协议（含校验），不 fork UtilityProcess、不接线 Main Bridge（后续刀）。
 *
 * 协议边界（宪法 §1.12 / HANDOVER §2.86 信任边界的跨进程版，违反 = 出宿主）：
 *  - 消息中禁止出现：API Key、模型供应商完整配置、ConfigService 对象、用户身份对象、
 *    真实 sessionId/wxid、数据库实例或文件路径、函数、AbortController、Error 原对象、Electron 对象。
 *    可序列化硬门禁 isHermesSerializable 只放行与 JSON 等价的值（有限数字/字符串/布尔/null/
 *    普通对象/数组；NaN/±Infinity、顶层与数组内 undefined 拒绝，undefined 仅作为对象字段值
 *    等价缺席；类实例/函数一律拒绝）。
 *  - 严格键集：所有协议载荷（消息分支/messages/evidence/error/tool result/清单条目/
 *    checkpoint/snapshot 及其嵌套 steps/result/findings）的运行时校验都拒绝未声明字段
 *    ——messageKey/sessionId/apiKey/stack 等在入口校验即拦，不依赖可选的
 *    findHermesBoundaryIssues。自由载荷袋（tool.execute.arguments / tool result.data）
 *    仍只做可序列化门禁，避免误伤合法工具业务参数。
 *  - messageKey（canonical/local/server/fallback 各形态内含本机绝对路径 + 发送者标识）绝不出宿主：
 *    协议证据形态 HermesProtocolEvidence 无此字段，校验器对多余字段硬拒绝；模型引用证据只走 eN ref。
 *  - 上下文唯一允许形态 HermesUtilityContext：capabilityContextId 是 Main 生成的不透明 ID
 *    （Main 侧映射真实 sessionId/accountId），真实 sessionId 不跨进程；chat 上下文不含真实 sessionId。
 *  - 错误跨进程只传受控 errorCode + 人话 message，不传堆栈。
 *  - 发送前建议过一遍 findHermesBoundaryIssues（防泄漏护栏，不替代发送方脱敏）。
 *    ⚠️ 自定义微信号（字母开头 5-20 位）与业务名（ModelX/AgreementA）同形，泛化扫描必误伤
 *    （hermes-agent-test a31 教训）——扫描器只抓无歧义形态（wxid_ 前缀号/@chatroom 群号），
 *    自定义微信号识别责任留在发送方（maskStructuredId/maskPrivateText）。
 *
 * 校验原则：不能只依赖 TypeScript 类型——所有跨进程消息入口必须先过对应运行时校验
 * （isMainToUtilityMessage / isUtilityToMainMessage：严格键集 + 分支载荷 + 可序列化门禁），
 * 不过 = 丢弃并按协议错误处理。
 */

// ─── 协议版本 ────────────────────────────────────────────────────────────────

/** 协议版本 v2：v2 起引入 runId 任务轮次号（task.start/task.continue/task.progress/
 *  task.response/checkpoint 必带；Main 只接受当前轮次的回传，旧轮次迟到消息一律丢弃），
 *  并收紧 evidenceHandle 格式为 /^evh-[a-z0-9-]+$/。Main 与 Utility 同应用分发、永远成对
 *  升级——版本号只用于半更新/外来进程的 fail closed 判定 */
export const HERMES_PROTOCOL_VERSION = 2 as const

// ─── 共享载荷类型 ──────────────────────────────────────────────────────────────

/** Agent 对话消息（发往模型的消息形态；Agent Core 会话窗口与协议消息共用同一形态） */
export interface HermesAgentMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** 工具清单条目（init 下发给 Utility；只有公开元数据，绝无工具实现与任何凭据） */
export interface HermesToolManifestEntry {
  name: string
  /** 人话名称（步骤 label / 兜底证据 label 统一用它，绝不显示内部工具 ID） */
  publicLabel: string
  description: string
  argsHint: string
}

/** 跨进程上下文（脱敏后的任务上下文，唯一允许形态）。
 *  - capabilityContextId：Main 生成的不透明 ID，Utility 原样回传给 host.request；
 *    ⛔ 模型 prompt 不得包含 capabilityContextId（模型可见摘要零会话标识的跨进程版）。
 *  - accountId：现有客户工具需要，当前允许保留；真实可见性校验仍由 Main 侧执行。
 *  - chat 上下文不能含真实 sessionId（校验器对多余字段硬拒绝）。 */
export interface HermesUtilityContext {
  kind: 'global' | 'chat' | 'customer'
  capabilityContextId: string
  accountId?: number
  label: string
}

/** Utility 只能请求的两类宿主能力（ Main 是唯一执行点：模型凭据与工具/WCDB 都不出 Main） */
export type HermesHostRequest =
  | {
      capability: 'model.complete'
      requestId: string
      taskId: string
      messages: HermesAgentMessage[]
      timeoutMs: number
    }
  | {
      capability: 'tool.execute'
      requestId: string
      taskId: string
      capabilityContextId: string
      tool: string
      arguments: Record<string, unknown>
    }

/** 受控错误（跨进程唯一错误形态：errorCode + 人话 message，不传堆栈/底层细节） */
export interface HermesProtocolError {
  code: string
  message: string
}

/** 协议证据（脱敏形态）：⛔ 无 messageKey 字段（校验器对多余字段硬拒绝）。
 *  evidenceHandle 是 Main 桥分配的不透明回查句柄（Main 按 taskId+handle 找回原始
 *  messageKey/本地证据元数据），可跨进程；messageKey 绝不出宿主 */
export interface HermesProtocolEvidence {
  ref: string
  label: string
  kind: 'customer' | 'chat' | 'crm' | 'knowledge' | 'action' | 'result'
  entityId?: number
  excerpt?: string
  evidenceHandle?: string
}

/** 工具结果在途证据（host.response tool.execute 分支）：ref 是 Utility 侧消费时才分配的
 *  登记号，桥接阶段不存在——⛔ 无 ref 无 messageKey；evidenceHandle 为 Main 侧不透明
 *  回查句柄（原始 messageKey 只存 Main），校验器对多余字段硬拒绝 */
export type HermesBridgeEvidence = Omit<HermesProtocolEvidence, 'ref'>

/** 工具执行结果（host.response tool.execute 分支 / Main 返回给 Utility 的统一形态） */
export interface HermesProtocolToolResult {
  ok: boolean
  data?: unknown
  evidence?: HermesBridgeEvidence[]
  publicSummary: string
  errorCode?: string
}

/** 协议任务快照（task.progress / task.response 携带；与 Main 内存 HermesTask 同构，
 *  但证据为脱敏协议形态——messageKey 留在 Main，模型引用只走 eN ref） */
export interface HermesProtocolTaskSnapshot {
  taskId: string
  status: 'planning' | 'running' | 'completed' | 'failed' | 'cancelled'
  goal: string
  /** 入口上下文的人话标签：「全局」/「会话：xxx」/「客户：xxx」 */
  contextLabel: string
  steps: Array<{
    label: string
    status: 'running' | 'done' | 'error'
    tool?: string
    publicSummary?: string
  }>
  evidence: HermesProtocolEvidence[]
  result?: {
    summary: string
    findings: Array<{ text: string; evidenceRefs: string[] }>
    nextSteps: string[]
  }
  /** 机器错误码（not_configured/cancelled/timeout/too_many_steps/ai_invalid_output/ai_error/internal/busy/not_found） */
  errorCode?: string
  /** 人话错误文案（绝不出现 SQL/IPC/堆栈/路径） */
  errorMessage?: string
  createdAt: number
}

/** 可恢复的脱敏 checkpoint（task.checkpoint 下行 / restore 上行）：
 *  足以让 Utility 重建任务对话窗口与证据核验表，零敏感锚点（messageKey 不出宿主，
 *  跨进程后证据回查仍由 Main 按 taskId+ref 自行映射） */
export interface HermesCheckpoint {
  protocolVersion: typeof HERMES_PROTOCOL_VERSION
  taskId: string
  /** 任务轮次号（与产生它的 task.start/task.continue 一致；Main 按轮次门禁拒绝旧轮次 checkpoint） */
  runId: number
  savedAt: number
  goal: string
  context: HermesUtilityContext
  /** 对话窗口（发往模型的消息形态；已按发送方窗口规则裁剪） */
  conversation: HermesAgentMessage[]
  /** 证据登记表 ref → 脱敏证据（⚠️ 无 messageKey；伪造编号校验在 Utility 侧照常可用） */
  evidenceByRef: Record<string, Omit<HermesProtocolEvidence, 'ref'>>
  nextEvidenceSeq: number
  okToolCalls: number
}

// ─── 消息 union（信封：protocolVersion + id + type 三字段必备）──────────────────

interface HermesMessageBase {
  protocolVersion: typeof HERMES_PROTOCOL_VERSION
  /** 消息 id（createHermesMessageId 生成；响应方用它关联，不回传也必备） */
  id: string
}

/** Main → Utility（九类） */
export type MainToUtilityMessage =
  | (HermesMessageBase & { type: 'init'; tools: HermesToolManifestEntry[] })
  | (HermesMessageBase & { type: 'restore'; checkpoint: HermesCheckpoint })
  | (HermesMessageBase & { type: 'task.start'; taskId: string; runId: number; goal: string; context: HermesUtilityContext })
  | (HermesMessageBase & { type: 'task.continue'; taskId: string; runId: number; question: string })
  | (HermesMessageBase & { type: 'task.cancel'; taskId: string })
  | (HermesMessageBase & { type: 'task.get'; taskId: string })
  | (HermesMessageBase & {
      type: 'host.response'
      requestId: string
      taskId: string
      ok: boolean
      /** model.complete 成功 → 模型输出文本 */
      text?: string
      /** tool.execute 成功 → 工具结果（协议证据形态，messageKey 已剥离） */
      result?: HermesProtocolToolResult
      /** 失败 → 受控错误（errorCode + 人话 message） */
      error?: HermesProtocolError
    })
  | (HermesMessageBase & { type: 'shutdown' })
  | (HermesMessageBase & { type: 'ping' })

/** Utility → Main（七类） */
export type UtilityToMainMessage =
  | (HermesMessageBase & { type: 'ready' })
  | (HermesMessageBase & {
      type: 'task.response'
      taskId: string
      /** 受理回执所属轮次（continue 受理时回传收到的那轮；Main 按轮次匹配回执，防旧轮次迟到回执错配新轮次） */
      runId: number
      op: 'start' | 'continue' | 'cancel' | 'get'
      ok: boolean
      snapshot?: HermesProtocolTaskSnapshot
      errorCode?: string
    })
  | (HermesMessageBase & { type: 'task.progress'; taskId: string; runId: number; snapshot: HermesProtocolTaskSnapshot })
  | (HermesMessageBase & { type: 'task.checkpoint'; checkpoint: HermesCheckpoint })
  | (HermesMessageBase & { type: 'host.request'; request: HermesHostRequest })
  | (HermesMessageBase & { type: 'fatal'; code: string; message: string })
  | (HermesMessageBase & { type: 'pong' })

export type HermesProtocolMessage = MainToUtilityMessage | UtilityToMainMessage

// ─── 基础运行时校验 ───────────────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

/** 严格键集校验（协议边界硬门禁）：对象自身键必须全部落在声明键集内——
 *  任何未在协议类型中声明的字段（messageKey/stack/apiKey/草稿字段等）一律拒绝，
 *  不依赖可选的 findHermesBoundaryIssues（那是发送前护栏，不是入口校验） */
function keysDeclared(v: object, allowed: readonly string[]): boolean {
  const set = new Set(allowed)
  return Object.keys(v).every((k) => set.has(k))
}

/** 可序列化硬门禁：只放行与 JSON 等价的值（原语 + 普通对象 + 数组）。
 *  - number 仅放行有限数：NaN / ±Infinity 经 JSON.stringify 会变 null，语义破坏，拒绝
 *  - undefined 仅允许作为普通对象字段值（序列化时字段缺席）；顶层 undefined 与数组元素
 *    undefined 拒绝（JSON 往返后变缺失或 null，语义破坏）
 *  - 函数 / Symbol / BigInt / 类实例（Error 原对象、AbortController、ConfigService、
 *    数据库实例、Electron 对象等一切非普通对象）一律拒绝；超深/循环结构拒绝 */
export function isHermesSerializable(v: unknown, depth = 0): boolean {
  if (depth > 32) return false // 防循环引用/超深嵌套
  if (v === undefined) return false
  if (v === null) return true
  if (typeof v === 'string' || typeof v === 'boolean') return true
  if (typeof v === 'number') return Number.isFinite(v)
  if (typeof v === 'function' || typeof v === 'symbol' || typeof v === 'bigint') return false
  if (Array.isArray(v)) return v.every((x) => isHermesSerializable(x, depth + 1))
  if (!isPlainObject(v)) return false
  return Object.values(v).every((x) => x === undefined || isHermesSerializable(x, depth + 1))
}

const AGENT_ROLES: readonly string[] = ['system', 'user', 'assistant']

/** HermesProtocolError 运行时校验（严格键集：只能 code + message——stack/cause/原始 Error
 *  等任何多余字段拒绝；错误跨进程只传受控 errorCode + 人话 message） */
export function isHermesProtocolError(v: unknown): v is HermesProtocolError {
  if (!isPlainObject(v) || !keysDeclared(v, ['code', 'message'])) return false
  return typeof v.code === 'string' && v.code.trim().length > 0
    && typeof v.message === 'string' && v.message.trim().length > 0
}

/** HermesAgentMessage 运行时校验（严格键集：多带 sessionId 等任何未声明字段拒绝） */
export function isHermesAgentMessage(v: unknown): v is HermesAgentMessage {
  if (!isPlainObject(v) || !keysDeclared(v, ['role', 'content'])) return false
  return AGENT_ROLES.includes(String(v.role)) && typeof v.content === 'string'
}

/** HermesToolManifestEntry 运行时校验（严格键集：只含公开元数据四字段） */
export function isHermesToolManifestEntry(v: unknown): v is HermesToolManifestEntry {
  if (!isPlainObject(v) || !keysDeclared(v, ['name', 'publicLabel', 'description', 'argsHint'])) return false
  return typeof v.name === 'string' && v.name.trim().length > 0
    && typeof v.publicLabel === 'string' && typeof v.description === 'string' && typeof v.argsHint === 'string'
}

const CONTEXT_KINDS: readonly string[] = ['global', 'chat', 'customer']

/** HermesUtilityContext 运行时校验（严格键集：多带 sessionId 等敏感字段 = 携带真实会话标识，拒绝） */
export function isHermesUtilityContext(v: unknown): v is HermesUtilityContext {
  if (!isPlainObject(v)) return false
  const keys = Object.keys(v).sort()
  const allowed = (v.accountId === undefined
    ? ['capabilityContextId', 'kind', 'label']
    : ['accountId', 'capabilityContextId', 'kind', 'label']).sort()
  if (keys.join(',') !== allowed.join(',')) return false
  if (!CONTEXT_KINDS.includes(String(v.kind))) return false
  if (typeof v.capabilityContextId !== 'string' || !v.capabilityContextId.trim()) return false
  if (typeof v.label !== 'string') return false
  if (v.accountId !== undefined && (typeof v.accountId !== 'number' || !Number.isFinite(v.accountId))) return false
  return true
}

/** HermesHostRequest 运行时校验（能力清单外一律拒绝；每类能力严格键集） */
export function isHermesHostRequest(v: unknown): v is HermesHostRequest {
  if (!isPlainObject(v)) return false
  if (typeof v.requestId !== 'string' || !v.requestId.trim()) return false
  if (typeof v.taskId !== 'string' || !v.taskId.trim()) return false
  if (v.capability === 'model.complete') {
    if (!keysDeclared(v, ['capability', 'requestId', 'taskId', 'messages', 'timeoutMs'])) return false
    if (!Array.isArray(v.messages) || !v.messages.every((m) => isHermesAgentMessage(m))) return false
    if (typeof v.timeoutMs !== 'number' || !(v.timeoutMs > 0) || !Number.isFinite(v.timeoutMs)) return false
    return true
  }
  if (v.capability === 'tool.execute') {
    if (!keysDeclared(v, ['capability', 'requestId', 'taskId', 'capabilityContextId', 'tool', 'arguments'])) return false
    if (typeof v.capabilityContextId !== 'string' || !v.capabilityContextId.trim()) return false
    if (typeof v.tool !== 'string' || !v.tool.trim()) return false
    if (!isPlainObject(v.arguments) || !isHermesSerializable(v.arguments)) return false
    return true
  }
  return false
}

const EVIDENCE_KINDS: readonly string[] = ['customer', 'chat', 'crm', 'knowledge', 'action', 'result']

/** evidenceHandle 合法性（Main 侧 maskToolResult 生成的固定格式 evh-…；本地锚点
 *  messageKey 形态与任意伪造字符串一律拒绝——恢复锚点前先过形态门） */
const EVIDENCE_HANDLE_RE = /^evh-[a-z0-9-]+$/
function isEvidenceHandleLike(v: unknown): v is string {
  return typeof v === 'string' && EVIDENCE_HANDLE_RE.test(v)
}

/** HermesProtocolEvidence 运行时校验（严格键集：⛔ messageKey 等任何多余字段拒绝；
 *  evidenceHandle 必须为不透明非空字符串） */
export function isHermesProtocolEvidence(v: unknown): v is HermesProtocolEvidence {
  if (!isPlainObject(v)) return false
  const allowed = new Set(['ref', 'label', 'kind', 'entityId', 'excerpt', 'evidenceHandle'])
  for (const k of Object.keys(v)) {
    if (!allowed.has(k)) return false // 多余字段（如 messageKey）= 边界违规，硬拒绝
  }
  if (typeof v.ref !== 'string' || !v.ref.trim()) return false
  if (typeof v.label !== 'string') return false
  if (!EVIDENCE_KINDS.includes(String(v.kind))) return false
  if (v.entityId !== undefined && (typeof v.entityId !== 'number' || !Number.isFinite(v.entityId))) return false
  if (v.excerpt !== undefined && typeof v.excerpt !== 'string') return false
  if (v.evidenceHandle !== undefined && !isEvidenceHandleLike(v.evidenceHandle)) return false
  return true
}

/** 工具结果在途证据校验（无 ref 无 messageKey；ref 由 Utility 消费时分配，出现在工具结果 =
 *  违规；evidenceHandle 必须为不透明非空字符串） */
export function isHermesBridgeEvidence(v: unknown): v is HermesBridgeEvidence {
  if (!isPlainObject(v)) return false
  const allowed = new Set(['label', 'kind', 'entityId', 'excerpt', 'evidenceHandle'])
  for (const k of Object.keys(v)) {
    if (!allowed.has(k)) return false // ref / messageKey 等多余字段 = 边界违规，硬拒绝
  }
  if (typeof v.label !== 'string') return false
  if (!EVIDENCE_KINDS.includes(String(v.kind))) return false
  if (v.entityId !== undefined && (typeof v.entityId !== 'number' || !Number.isFinite(v.entityId))) return false
  if (v.excerpt !== undefined && typeof v.excerpt !== 'string') return false
  if (v.evidenceHandle !== undefined && !isEvidenceHandleLike(v.evidenceHandle)) return false
  return true
}

/** HermesProtocolToolResult 运行时校验（严格键集 + 递归：空对象拒绝；evidence 逐条过
 *  isHermesBridgeEvidence——ref/messageKey 等多余字段硬拒绝；data 过可序列化门禁） */
export function isHermesProtocolToolResult(v: unknown): v is HermesProtocolToolResult {
  if (!isPlainObject(v) || !keysDeclared(v, ['ok', 'data', 'evidence', 'publicSummary', 'errorCode'])) return false
  if (typeof v.ok !== 'boolean') return false
  if (typeof v.publicSummary !== 'string') return false
  if (v.data !== undefined && !isHermesSerializable(v.data)) return false
  if (v.evidence !== undefined
    && (!Array.isArray(v.evidence) || !v.evidence.every((e) => isHermesBridgeEvidence(e)))) return false
  if (v.errorCode !== undefined && (typeof v.errorCode !== 'string' || !v.errorCode.trim())) return false
  return true
}

const TASK_STATUSES: readonly string[] = ['planning', 'running', 'completed', 'failed', 'cancelled']
const STEP_STATUSES: readonly string[] = ['running', 'done', 'error']

// 嵌套协议对象严格键集（未声明字段 = 边界违规，校验器自身直接拒绝）
const SNAPSHOT_KEYS: readonly string[] = [
  'taskId', 'status', 'goal', 'contextLabel', 'steps', 'evidence',
  'result', 'errorCode', 'errorMessage', 'createdAt'
]
const STEP_KEYS: readonly string[] = ['label', 'status', 'tool', 'publicSummary']
const RESULT_KEYS: readonly string[] = ['summary', 'findings', 'nextSteps']
const FINDING_KEYS: readonly string[] = ['text', 'evidenceRefs']
const CHECKPOINT_KEYS: readonly string[] = [
  'protocolVersion', 'taskId', 'runId', 'savedAt', 'goal', 'context',
  'conversation', 'evidenceByRef', 'nextEvidenceSeq', 'okToolCalls'
]

/** HermesProtocolTaskSnapshot 运行时校验（findings v2：逐条 {text, evidenceRefs}；
 *  顶层/steps/result/findings 全部严格键集，messageKey/sessionId 等未声明字段出现即拒绝） */
export function isHermesProtocolTaskSnapshot(v: unknown): v is HermesProtocolTaskSnapshot {
  if (!isPlainObject(v) || !keysDeclared(v, SNAPSHOT_KEYS)) return false
  if (typeof v.taskId !== 'string' || !v.taskId.trim()) return false
  if (!TASK_STATUSES.includes(String(v.status))) return false
  if (typeof v.goal !== 'string' || typeof v.contextLabel !== 'string') return false
  if (typeof v.createdAt !== 'number' || !Number.isFinite(v.createdAt)) return false
  if (!Array.isArray(v.steps)) return false
  for (const s of v.steps) {
    if (!isPlainObject(s) || !keysDeclared(s, STEP_KEYS)) return false
    if (typeof s.label !== 'string' || !STEP_STATUSES.includes(String(s.status))) return false
    if (s.tool !== undefined && typeof s.tool !== 'string') return false
    if (s.publicSummary !== undefined && typeof s.publicSummary !== 'string') return false
  }
  if (!Array.isArray(v.evidence) || !v.evidence.every((e) => isHermesProtocolEvidence(e))) return false
  if (v.result !== undefined) {
    if (!isPlainObject(v.result) || !keysDeclared(v.result, RESULT_KEYS)) return false
    if (typeof v.result.summary !== 'string') return false
    if (!Array.isArray(v.result.nextSteps) || !v.result.nextSteps.every((x) => typeof x === 'string')) return false
    if (!Array.isArray(v.result.findings)) return false
    for (const f of v.result.findings) {
      if (!isPlainObject(f) || !keysDeclared(f, FINDING_KEYS)) return false
      if (typeof f.text !== 'string') return false
      if (!Array.isArray(f.evidenceRefs) || !f.evidenceRefs.every((x) => typeof x === 'string')) return false
    }
  }
  if (v.errorCode !== undefined && typeof v.errorCode !== 'string') return false
  if (v.errorMessage !== undefined && typeof v.errorMessage !== 'string') return false
  return true
}

/** 非负安全整数（协议计数字段专用）：NaN/±Infinity/负数/小数/超安全整数/非 number 一律 false。
 *  只查 >= 0 会放过 Infinity 与小数——可序列化门禁拦得住 Infinity 但拦不住小数，
 *  计数语义（证据序号/成功工具次数）必须自身自洽 */
function isNonNegSafeInt(v: unknown): boolean {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
}

/** HermesCheckpoint 运行时校验（严格键集 + 脱敏：证据条目走严格键集，messageKey 出现即拒绝；
 *  计数字段必须是非负安全整数） */
export function isHermesCheckpoint(v: unknown): v is HermesCheckpoint {
  if (!isPlainObject(v) || !keysDeclared(v, CHECKPOINT_KEYS)) return false
  if (v.protocolVersion !== HERMES_PROTOCOL_VERSION) return false
  if (typeof v.taskId !== 'string' || !v.taskId.trim()) return false
  if (!isRunId(v.runId)) return false
  if (typeof v.savedAt !== 'number' || !Number.isFinite(v.savedAt)) return false
  if (typeof v.goal !== 'string' || !v.goal) return false
  if (!isHermesUtilityContext(v.context)) return false
  if (!Array.isArray(v.conversation) || !v.conversation.every((m) => isHermesAgentMessage(m))) return false
  if (!isPlainObject(v.evidenceByRef)) return false
  for (const [ref, ev] of Object.entries(v.evidenceByRef)) {
    if (!ref.trim()) return false
    const evOk = isPlainObject(ev)
      && typeof ev.label === 'string'
      && EVIDENCE_KINDS.includes(String(ev.kind))
      && (ev.entityId === undefined || (typeof ev.entityId === 'number' && Number.isFinite(ev.entityId)))
      && (ev.excerpt === undefined || typeof ev.excerpt === 'string')
      // ⛔ messageKey 等多余字段（本机路径/发送者标识）绝不出宿主
      && Object.keys(ev).every((k) => ['label', 'kind', 'entityId', 'excerpt'].includes(k))
    if (!evOk) return false
  }
  if (!isNonNegSafeInt(v.nextEvidenceSeq)) return false
  if (!isNonNegSafeInt(v.okToolCalls)) return false
  return true
}

// ─── 消息级校验（信封 + 分支载荷 + 可序列化硬门禁）─────────────────────────────

function validEnvelope(raw: unknown): raw is Record<string, unknown> & { id: string; type: string } {
  return isPlainObject(raw)
    && raw.protocolVersion === HERMES_PROTOCOL_VERSION
    && typeof raw.id === 'string' && raw.id.length > 0
    && typeof raw.type === 'string'
}

function hasTaskId(raw: Record<string, unknown>): boolean {
  return typeof raw.taskId === 'string' && raw.taskId.trim().length > 0
}

// ─── 每类消息的严格键集（信封三键 + 分支声明字段；未声明字段一律拒绝）─────────────

const ENV_KEYS: readonly string[] = ['protocolVersion', 'id', 'type']

const M2U_KEY_SETS: Record<string, readonly string[]> = {
  init: [...ENV_KEYS, 'tools'],
  restore: [...ENV_KEYS, 'checkpoint'],
  'task.start': [...ENV_KEYS, 'taskId', 'runId', 'goal', 'context'],
  'task.continue': [...ENV_KEYS, 'taskId', 'runId', 'question'],
  'task.cancel': [...ENV_KEYS, 'taskId'],
  'task.get': [...ENV_KEYS, 'taskId'],
  'host.response': [...ENV_KEYS, 'requestId', 'taskId', 'ok', 'text', 'result', 'error'],
  shutdown: ENV_KEYS,
  ping: ENV_KEYS
}

const U2M_KEY_SETS: Record<string, readonly string[]> = {
  ready: ENV_KEYS,
  'task.response': [...ENV_KEYS, 'taskId', 'runId', 'op', 'ok', 'snapshot', 'errorCode'],
  'task.progress': [...ENV_KEYS, 'taskId', 'runId', 'snapshot'],
  'task.checkpoint': [...ENV_KEYS, 'checkpoint'],
  'host.request': [...ENV_KEYS, 'request'],
  fatal: [...ENV_KEYS, 'code', 'message'],
  pong: ENV_KEYS
}

/** runId 任务轮次号校验：正安全整数（≥1；Main 从 task.start=1 起递增） */
function isRunId(v: unknown): boolean {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 1
}

/** Main → Utility 消息运行时校验（严格键集 → 九类逐一校验载荷 → 可序列化硬门禁） */
export function isMainToUtilityMessage(raw: unknown): raw is MainToUtilityMessage {
  if (!validEnvelope(raw)) return false
  const m = raw as Record<string, unknown>
  const keys = M2U_KEY_SETS[m.type as string]
  if (!keys || !keysDeclared(m, keys)) return false // 未声明字段（messageKey/apiKey 等）= 边界违规
  let payloadOk = false
  switch (m.type) {
    case 'init':
      payloadOk = Array.isArray(m.tools) && m.tools.every((t) => isHermesToolManifestEntry(t))
      break
    case 'restore':
      payloadOk = isHermesCheckpoint(m.checkpoint)
      break
    case 'task.start':
      payloadOk = hasTaskId(m) && isRunId(m.runId)
        && typeof m.goal === 'string' && m.goal.trim().length > 0
        && isHermesUtilityContext(m.context)
      break
    case 'task.continue':
      payloadOk = hasTaskId(m) && isRunId(m.runId)
        && typeof m.question === 'string' && m.question.trim().length > 0
      break
    case 'task.cancel':
    case 'task.get':
      payloadOk = hasTaskId(m)
      break
    case 'host.response': {
      if (typeof m.requestId !== 'string' || !m.requestId.trim() || !hasTaskId(m) || typeof m.ok !== 'boolean') break
      if (m.text !== undefined && typeof m.text !== 'string') break
      if (m.result !== undefined && !isHermesProtocolToolResult(m.result)) break
      if (m.error !== undefined && !isHermesProtocolError(m.error)) break
      if (m.ok) {
        // 成功：text 与 result 恰好存在一个，且不得携带 error
        payloadOk = (m.text !== undefined) !== (m.result !== undefined) && m.error === undefined
      } else {
        // 失败：必须携带受控错误，且不得携带任何结果
        payloadOk = m.error !== undefined && m.text === undefined && m.result === undefined
      }
      break
    }
    case 'shutdown':
    case 'ping':
      payloadOk = true
      break
    default:
      payloadOk = false
  }
  if (!payloadOk) return false
  return isHermesSerializable(raw)
}

const RESPONSE_OPS: readonly string[] = ['start', 'continue', 'cancel', 'get']

/** Utility → Main 消息运行时校验（严格键集 → 七类逐一校验载荷 → 可序列化硬门禁） */
export function isUtilityToMainMessage(raw: unknown): raw is UtilityToMainMessage {
  if (!validEnvelope(raw)) return false
  const m = raw as Record<string, unknown>
  const keys = U2M_KEY_SETS[m.type as string]
  if (!keys || !keysDeclared(m, keys)) return false // 未声明字段（stack/cause 等）= 边界违规
  let payloadOk = false
  switch (m.type) {
    case 'ready':
    case 'pong':
      payloadOk = true
      break
    case 'task.response':
      payloadOk = hasTaskId(m)
        && isRunId(m.runId)
        && RESPONSE_OPS.includes(String(m.op))
        && typeof m.ok === 'boolean'
        && (m.snapshot === undefined || isHermesProtocolTaskSnapshot(m.snapshot))
        && (m.errorCode === undefined || typeof m.errorCode === 'string')
      break
    case 'task.progress':
      payloadOk = hasTaskId(m) && isRunId(m.runId) && isHermesProtocolTaskSnapshot(m.snapshot)
      break
    case 'task.checkpoint':
      payloadOk = isHermesCheckpoint(m.checkpoint)
      break
    case 'host.request':
      payloadOk = isHermesHostRequest(m.request)
      break
    case 'fatal':
      payloadOk = typeof m.code === 'string' && m.code.trim().length > 0
        && typeof m.message === 'string' && m.message.trim().length > 0
      break
    default:
      payloadOk = false
  }
  if (!payloadOk) return false
  return isHermesSerializable(raw)
}

/** 双向消息校验（入口单点：不过 = 丢弃） */
export function isHermesProtocolMessage(raw: unknown): raw is HermesProtocolMessage {
  return isMainToUtilityMessage(raw) || isUtilityToMainMessage(raw)
}

// ─── 边界扫描（发送前护栏）────────────────────────────────────────────────────

/** 禁止出现在跨进程消息里的字段名（key 级硬边界） */
const FORBIDDEN_KEY_RE = /^(messageKey|sessionId|session_id|apiKey|api_key|apiBaseUrl|api_base_url|authorization)$/i

/** 无歧义会话标识形态（wxid_ 前缀号 / 群号），正文内子串命中也算泄漏（wxid_ 前缀无歧义）。
 *  自定义微信号与业务名（ModelX/AgreementA）同形，泛化检测必误伤（hermes-agent-test a31 教训）
 *  ——识别责任留在发送方脱敏函数，此处不扫 */
const UNAMBIGUOUS_SESSION_ID_RE = /wxid_[a-z0-9_]+/i

/** 深度扫描值树，返回边界违规清单（human-readable path 列表）：
 *  - 禁止字段名（messageKey/sessionId/session_id/apiKey 等）
 *  - 无歧义会话标识字符串值（wxid_ 前缀号；@chatroom 群号）
 *  - 不可序列化值（函数/Symbol/BigInt/类实例）
 *  发送方建议在 send 前调用；返回非空 = 有内容试图出宿主，应丢弃或脱敏后重发 */
export function findHermesBoundaryIssues(value: unknown): string[] {
  const issues: string[] = []
  const walk = (v: unknown, path: string, depth: number): void => {
    if (depth > 32) {
      issues.push(`${path}: 嵌套过深或循环引用`)
      return
    }
    if (v === null || v === undefined) return
    const t = typeof v
    if (t === 'function' || t === 'symbol' || t === 'bigint') {
      issues.push(`${path}: 含不可跨进程的 ${t} 值（函数/Error/AbortController/db/Electron 对象不得出宿主）`)
      return
    }
    if (typeof v === 'string') {
      if (UNAMBIGUOUS_SESSION_ID_RE.test(v)) issues.push(`${path}: 疑似真实会话标识（wxid_ 前缀号）`)
      else if (/[a-z0-9_]+@chatroom/i.test(v)) issues.push(`${path}: 疑似真实群号（@chatroom）`)
      return
    }
    if (t !== 'object') return // number/boolean 原语放行
    if (!Array.isArray(v)) {
      if (!isPlainObject(v)) {
        issues.push(`${path}: 非普通对象（类实例/内置对象不得出宿主）`)
        return
      }
      for (const [k, val] of Object.entries(v)) {
        const childPath = `${path}.${k}`
        if (FORBIDDEN_KEY_RE.test(k)) issues.push(`${childPath}: 禁止字段（协议边界）`)
        walk(val, childPath, depth + 1)
      }
      return
    }
    (v as unknown[]).forEach((x, i) => walk(x, `${path}[${i}]`, depth + 1))
  }
  walk(value, '$', 0)
  return issues
}

// ─── 消息 id ─────────────────────────────────────────────────────────────────

let messageIdSeq = 0

/** 生成协议消息 id（hm- 前缀 + 时间戳 + 序号 + 随机段；同毫秒内也唯一） */
export function createHermesMessageId(): string {
  messageIdSeq = (messageIdSeq + 1) % Number.MAX_SAFE_INTEGER
  return `hm-${Date.now()}-${messageIdSeq}-${Math.random().toString(36).slice(2, 8)}`
}
