/**
 * annualReviewAiCoordinator.ts —— 年度经营复盘 · AI 分析 IPC 层编排（S7.2）
 *
 * 职责（规格 §8 + §8.3 + S7.2）：
 *   - **报告定位**：请求只带 `taskId`。报告由主进程按 taskId 在当前账号作用域内定位
 *     （AnnualReviewService.getTaskReport：任务存在 + 属于当前作用域 + 已完成 + 报告仍有效
 *     且由该任务产出），渲染层永远不上传报告内容——伪造报告、改口径、注入自由文本都没有入口。
 *   - **唯一模型出口**：调用 `generateAnnualReviewAiAnalysis`（S7.1 已验收的服务层），
 *     不复制第二套 prompt / 校验 / 模型客户端；额度闸门与用量账本沿用同一条链路。
 *   - **失败码原样透传**：S7.1 的九个失败码（invalid_report / unsupported_report_contract /
 *     not_configured / budget_blocked / call_failed / empty_output / invalid_json /
 *     invalid_shape / numeric_claim）逐字保留；本层只新增「定位/并发/失效」类失败码
 *     （见 shared/annualReviewAi.ts 的 ANNUAL_REVIEW_AI_IPC_FAILURE_CODES）。
 *   - **脱敏**：本层所有失败文案都是**编译期常量**（不拼接异常、报告内容、路径、URL）；
 *     成功/失败响应都不含报告正文、prompt、模型原始输出、scopeId、wxid、数据库路径、Token。
 *   - **取消**：每次 run 持有自己的 AbortController（外部 signal 只做转发），cancel(taskId)
 *     中止在途调用；窗口销毁后不再向该窗口发送结果（见 bindAnnualReviewAiSenderAbort）。
 *   - **结果缓存（仅主进程内存）**：键 = {accountScopeId, taskId, promptVersion}，TTL 与报告
 *     缓存一致（10 分钟）。不跨账号、不跨报告身份、不跨 promptVersion 复用；账号切换 /
 *     业务库 reopen / 数据写入失效 → invalidateAll() 清空缓存并中止在途调用。
 *     **不持久化**（规格 §8.3：AI 层不写库、不写 config；本轮没有为 AI 结果新建数据库表）。
 *   - **零副作用于确定性报告**：只读报告；不写报告缓存、不触发重新统计、不改变任务终态。
 *
 * 测试纪律：全部外部依赖（报告定位、配置、模型出口、时钟）经 deps 注入；注入后本模块
 * 不接触 aiApiClient、不读真实配置、不发真实请求、不触碰数据库。
 */
import type { ConfigService } from './config'
import {
  ANNUAL_REVIEW_CACHE_TTL_MS,
  type AnnualReviewTaskReportResult
} from './annualReviewService'
import {
  ANNUAL_REVIEW_AI_PROMPT_VERSION
} from './annualReviewAiCore'
import { validateAnnualReviewTaskId } from './annualReviewReport'
import {
  ANNUAL_REVIEW_AI_FAILURE_MESSAGES,
  generateAnnualReviewAiAnalysis,
  type AnnualReviewAiCompletion,
  type AnnualReviewAiRunOptions
} from './annualReviewAiService'
import type {
  AnnualReviewAiAnalysis,
  AnnualReviewAiAnalysisFailureCode,
  AnnualReviewAiAnalysisResponse,
  AnnualReviewAiIpcFailureCode
} from '../../shared/annualReviewAi'

// ─── 失败文案（全部为编译期常量，绝非异常投影） ──────────────────────────────

/**
 * IPC 层固定文案。与 S7.1 的 ANNUAL_REVIEW_AI_FAILURE_MESSAGES 同一纪律：底层 error.message
 * 常携带 API URL、Bearer Token、供应商响应正文、数据库路径与堆栈，一旦透传就会随错误提示、
 * 日志、崩溃报告扩散。因此这里逐码映射**常量文案**，原始异常既不返回也不记录。
 */
export const ANNUAL_REVIEW_AI_IPC_FAILURE_MESSAGES: Record<AnnualReviewAiIpcFailureCode, string> = {
  invalid_task_id: '非法的任务标识',
  invalid_request: '非法的请求载荷（只允许 { taskId, force? }）',
  task_not_found: '未找到该报告对应的生成任务（可能已被新任务取代），请重新生成报告后再试',
  task_not_completed: '该生成任务尚未成功完成，暂时无法生成 AI 分析',
  report_not_available: '报告已过期或已被新的生成结果取代，请重新生成后再试',
  analysis_in_progress: '该报告已有 AI 分析正在进行，请稍候',
  invalidated: '账号或业务库已变更，本次 AI 分析结果已作废，请重试',
  internal: 'AI 分析失败，请稍后重试'
}

// ─── 请求载荷解析（严格对象；不依赖 truthy 转换） ────────────────────────────

export type AnnualReviewAiRequestParseResult =
  | { ok: true; taskId: string; force: boolean }
  | { ok: false; code: 'invalid_request' | 'invalid_task_id'; message: string }

/**
 * 解析 `annualReview:aiAnalysis` / `annualReview:aiAnalysisCancel` 载荷。
 *
 * **只允许严格对象 `{ taskId, force? }`**：
 *   - 非对象（字符串/数组/null）或多出任何字段 → `invalid_request`（渲染层无法夹带报告、
 *     prompt、模型参数等额外内容，也无法用额外字段绕过语义）；
 *   - `taskId` 必须通过统一的任务标识校验（空/超长/含 NUL）→ `invalid_task_id`；
 *   - `force` 只接受 boolean 或省略；数字/字符串/对象等一律 `invalid_request`——
 *     **不做 truthy 转换**（`force: 'yes'`、`force: 1` 都不是「强制」）。
 */
export function parseAnnualReviewAiAnalysisRequest(payload: unknown): AnnualReviewAiRequestParseResult {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, code: 'invalid_request', message: ANNUAL_REVIEW_AI_IPC_FAILURE_MESSAGES.invalid_request }
  }
  const record = payload as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (key !== 'taskId' && key !== 'force') {
      return { ok: false, code: 'invalid_request', message: ANNUAL_REVIEW_AI_IPC_FAILURE_MESSAGES.invalid_request }
    }
  }
  if (!validateAnnualReviewTaskId(record.taskId)) {
    return { ok: false, code: 'invalid_task_id', message: ANNUAL_REVIEW_AI_IPC_FAILURE_MESSAGES.invalid_task_id }
  }
  const force = record.force
  if (force !== undefined && typeof force !== 'boolean') {
    return { ok: false, code: 'invalid_request', message: ANNUAL_REVIEW_AI_IPC_FAILURE_MESSAGES.invalid_request }
  }
  return { ok: true, taskId: record.taskId, force: force === true }
}

// ─── 依赖注入 ────────────────────────────────────────────────────────────────

export interface AnnualReviewAiCoordinatorDeps {
  /**
   * 按 taskId 定位「当前账号作用域内、已完成、报告仍有效」的结果。
   * 生产 = AnnualReviewService.getTaskReport（纯读）。
   */
  getTaskReport: (taskId: string) => AnnualReviewTaskReportResult
  /** 当前 AI 配置（每次调用解析一次，避免持有过期配置对象） */
  getConfig: () => ConfigService
  /** 窄依赖注入：唯一模型出口（缺省 = simpleCompletion 真实链路） */
  completion?: AnnualReviewAiCompletion
  /** 注入：AI 配置可用性（缺省按 config 判定） */
  configured?: boolean
  /** 注入：当前时刻（缓存新鲜度与成功结果 generatedAt） */
  now?: () => number
  /** 注入：AI 分析执行（缺省 = generateAnnualReviewAiAnalysis） */
  generate?: typeof generateAnnualReviewAiAnalysis
  /** 结果缓存 TTL（缺省与报告缓存一致；测试可注入短 TTL） */
  ttlMs?: number
}

export interface AnnualReviewAiRunRequestOptions {
  /** 请求来源（窗口）的中止信号：窗口销毁 → 中止在途调用，不再向该窗口发送结果 */
  signal?: AbortSignal
  /**
   * true = 跳过结果缓存并**真实调用模型**（页面成功态「重新生成 AI 诊断」）。
   * 只跳过「结果缓存命中」这一步，不绕过任何校验：taskId/账号/报告身份定位、同键 single-flight、
   * 日调用额度、输入与输出契约、取消与失效防护全部照旧生效；成功后覆盖同键缓存，
   * 失败时保留旧缓存条目。
   */
  force?: boolean
}

export interface AnnualReviewAiCancelResult {
  success: boolean
  error?: { code: string; message: string }
}

interface InFlightEntry {
  taskId: string
  controller: AbortController
}

interface CachedSuccess {
  analysis: AnnualReviewAiAnalysis
  model: string
  promptVersion: string
  generatedAt: number
}

// ─── 窗口销毁 → 中止 ─────────────────────────────────────────────────────────

/** webContents 的最小结构（只用到这三个成员，便于测试用假对象驱动） */
export interface AnnualReviewAiSenderLike {
  isDestroyed?: () => boolean
  once: (event: 'destroyed', listener: () => void) => unknown
  removeListener: (event: 'destroyed', listener: () => void) => unknown
}

/**
 * 把「请求来源窗口销毁」绑定为调用中止：窗口没了就不必再占用模型额度，也绝不会向一个
 * 已销毁的 webContents 发送结果（ipcMain.handle 的响应本来就会丢弃，但**调用本身**
 * 必须停下，否则会产生无人接收的计费调用）。返回 dispose() 在调用收敛后摘除监听。
 */
export function bindAnnualReviewAiSenderAbort(sender: AnnualReviewAiSenderLike): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController()
  const onDestroyed = (): void => controller.abort()
  if (typeof sender.isDestroyed === 'function' && sender.isDestroyed()) {
    controller.abort()
    return { signal: controller.signal, dispose: () => { /* 无需摘除：未注册监听 */ } }
  }
  sender.once('destroyed', onDestroyed)
  return {
    signal: controller.signal,
    dispose: () => { sender.removeListener('destroyed', onDestroyed) }
  }
}

// ─── 编排器 ──────────────────────────────────────────────────────────────────

/**
 * AI 结果缓存键：`accountScopeId + taskId（报告身份） + promptVersion`——三者任一变化都
 * 不复用。跨账号复用会把一个账号的经营结论显示在另一个账号下（最严重的一类泄漏）；
 * 跨报告复用会把旧报告的分析挂到新报告上；跨 promptVersion 复用会让提示词/输出契约
 * 变更后的旧结果继续可比。键含内部作用域复合串（可能含数据库路径身份），因此
 * **只作主进程内部 Map 键**：不写日志、不返回渲染层、不进 Worker 载荷。
 */
export function annualReviewAiCacheKey(internalScopeId: string, taskId: string, promptVersion: string): string {
  return JSON.stringify([internalScopeId, taskId, promptVersion])
}

export class AnnualReviewAiCoordinator {
  private readonly cache = new Map<string, { result: CachedSuccess; cachedAt: number }>()
  private readonly inFlight = new Map<string, InFlightEntry>()
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly generate: typeof generateAnnualReviewAiAnalysis
  /** 失效纪元：账号切换 / 业务库 reopen / 数据写入失效时 +1；在途调用完成后复核 */
  private epoch = 0

  constructor(private readonly deps: AnnualReviewAiCoordinatorDeps) {
    this.now = deps.now ?? Date.now
    this.ttlMs = deps.ttlMs ?? ANNUAL_REVIEW_CACHE_TTL_MS
    this.generate = deps.generate ?? generateAnnualReviewAiAnalysis
  }

  /** 缓存键：账号作用域 + 报告身份（taskId） + promptVersion（三者任一变化都不复用） */
  private key(internalScopeId: string, taskId: string): string {
    return annualReviewAiCacheKey(internalScopeId, taskId, ANNUAL_REVIEW_AI_PROMPT_VERSION)
  }

  private fail(code: AnnualReviewAiAnalysisFailureCode, message: string): AnnualReviewAiAnalysisResponse {
    return { success: false, error: { code, message } }
  }

  /**
   * 生成本次报告的 AI 分析。**只读报告**（不写报告缓存、不改任务状态）。
   *
   * 判定顺序：taskId/force 载荷校验 → 报告定位（任务归属/完成度/报告有效性）→ 非 force
   * 时命中内存缓存则直接返回 → 同键在途则拒绝重复调用（不重复计费）→ 调用 S7.1 服务层 →
   * **失效/取消复核** → 成功结果写缓存。
   *
   * 取消与失效是**权威终态**：底层模型可能忽略 AbortSignal，因此 `await` 返回后必须重新
   * 检查一次——期间发生账号/业务库失效（epoch 变化）优先返回 `invalidated`；用户取消或
   * 窗口销毁则一律按取消返回（不返回成功、不写缓存、缓存条目数不增加）。
   */
  async run(taskId: unknown, options: AnnualReviewAiRunRequestOptions = {}): Promise<AnnualReviewAiAnalysisResponse> {
    if (typeof taskId !== 'string' || taskId.length === 0) {
      return this.fail('invalid_task_id', ANNUAL_REVIEW_AI_IPC_FAILURE_MESSAGES.invalid_task_id)
    }
    // force 只接受 boolean（不做 truthy 转换）：'yes' / 1 / {} 一律视为非法载荷
    const force = options.force
    if (force !== undefined && typeof force !== 'boolean') {
      return this.fail('invalid_request', ANNUAL_REVIEW_AI_IPC_FAILURE_MESSAGES.invalid_request)
    }

    let lookup: AnnualReviewTaskReportResult
    try {
      lookup = this.deps.getTaskReport(taskId)
    } catch {
      // 定位过程异常同样不外泄异常正文（可能是数据库/服务内部错误）
      return this.fail('internal', ANNUAL_REVIEW_AI_IPC_FAILURE_MESSAGES.internal)
    }
    if (!lookup.ok) {
      const code = lookup.code
      return this.fail(code, this.lookupMessage(code))
    }

    const key = this.key(lookup.internalScopeId, taskId)
    // force 绕过的是「结果缓存命中」，不是 single-flight：在途判断在缓存读取之外独立生效
    if (force !== true) {
      const cached = this.cache.get(key)
      if (cached && this.now() - cached.cachedAt <= this.ttlMs) {
        return { success: true, ...cached.result, cached: true }
      }
    }
    if (this.inFlight.has(key)) {
      return this.fail('analysis_in_progress', ANNUAL_REVIEW_AI_IPC_FAILURE_MESSAGES.analysis_in_progress)
    }

    const controller = new AbortController()
    const epochAtStart = this.epoch
    this.inFlight.set(key, { taskId, controller })
    // 外部 signal（窗口销毁）只做转发：本层始终持有自己的 controller，取消路径统一
    const forwardAbort = (): void => controller.abort()
    const external = options.signal
    if (external) {
      if (external.aborted) controller.abort()
      else external.addEventListener('abort', forwardAbort, { once: true })
    }
    /** 取消/窗口销毁是否已发生（权威判定：只看 controller，不假设底层模型遵守信号） */
    const aborted = (): boolean => controller.signal.aborted

    try {
      const runOptions: AnnualReviewAiRunOptions = {
        config: this.deps.getConfig(),
        completion: this.deps.completion,
        configured: this.deps.configured,
        now: this.deps.now,
        signal: controller.signal
      }
      const result = await this.generate(lookup.report, runOptions)

      // ① 失效复核（优先）：账号切换/业务库 reopen/数据写入失效后，结果作废（不返回、不缓存）
      if (this.epoch !== epochAtStart) {
        return this.fail('invalidated', ANNUAL_REVIEW_AI_IPC_FAILURE_MESSAGES.invalidated)
      }
      // ② 取消复核：取消/窗口销毁后即使底层忽略 AbortSignal 并「成功」返回，也不得当作成功
      //    ——不返回成功、不写缓存；失败结果同样按取消语义收敛（沿用固定文案，不透传异常）
      if (aborted()) {
        return this.fail('call_failed', ANNUAL_REVIEW_AI_FAILURE_MESSAGES.cancelled)
      }
      if (!result.ok) {
        // S7.1 失败码与固定文案原样透传（含 numeric_claim/invalid_shape 等解析类失败）
        return this.fail(result.code, result.message)
      }
      const payload: CachedSuccess = {
        analysis: result.analysis,
        model: result.model,
        promptVersion: result.promptVersion,
        generatedAt: result.generatedAt
      }
      // 成功结果只在失效与取消复核均通过后写入；force 时覆盖同键旧条目（失败路径从不删除旧缓存）
      this.cache.set(key, { result: payload, cachedAt: this.now() })
      return { success: true, ...payload, cached: false }
    } catch {
      // 出口抛错（含被中止的真实链路）：失效优先，其次取消，其余归为内部错误
      if (this.epoch !== epochAtStart) {
        return this.fail('invalidated', ANNUAL_REVIEW_AI_IPC_FAILURE_MESSAGES.invalidated)
      }
      if (aborted()) {
        return this.fail('call_failed', ANNUAL_REVIEW_AI_FAILURE_MESSAGES.cancelled)
      }
      return this.fail('internal', ANNUAL_REVIEW_AI_IPC_FAILURE_MESSAGES.internal)
    } finally {
      if (external) external.removeEventListener('abort', forwardAbort)
      this.inFlight.delete(key)
    }
  }

  /**
   * 中止在途分析（页面「取消」入口 / 窗口销毁）。只影响**正在跑**的调用：
   * 没有在途调用时返回 `analysis_not_found`，让调用方知道「没有真的取消任何东西」
   * （例如响应已返回、或该报告从未发起过分析），而不是假装取消成功。
   */
  cancel(taskId: unknown): AnnualReviewAiCancelResult {
    if (typeof taskId !== 'string' || taskId.length === 0) {
      return { success: false, error: { code: 'invalid_task_id', message: ANNUAL_REVIEW_AI_IPC_FAILURE_MESSAGES.invalid_task_id } }
    }
    for (const entry of this.inFlight.values()) {
      if (entry.taskId !== taskId) continue
      entry.controller.abort()
      return { success: true }
    }
    return { success: false, error: { code: 'analysis_not_found', message: '没有正在进行的 AI 分析' } }
  }

  /**
   * 失效（账号切换 / 业务库 reopen / 数据写入失效 / 名单变化）：纪元 +1、清空结果缓存、
   * 中止全部在途调用。在途调用的结果不会写回缓存，也不会返回给渲染层——跨账号返回旧账号
   * 的聚合结果是最严重的一类泄漏，这里与报告缓存采用同一套失效纪律。
   */
  invalidateAll(): void {
    this.epoch++
    this.cache.clear()
    for (const entry of this.inFlight.values()) entry.controller.abort()
  }

  /** 当前在途分析数量（仅测试与诊断用；不暴露 taskId/scope 等内部标识） */
  inFlightCount(): number {
    return this.inFlight.size
  }

  /** 缓存条目数量（仅测试与诊断用；不含任何内容） */
  cacheSize(): number {
    return this.cache.size
  }

  private lookupMessage(code: Extract<AnnualReviewTaskReportResult, { ok: false }>['code']): string {
    // 定位类失败码与 IPC 词表同名同义；逐码映射避免把服务层文案当作 IPC 契约
    switch (code) {
      case 'invalid_task_id': return ANNUAL_REVIEW_AI_IPC_FAILURE_MESSAGES.invalid_task_id
      case 'task_not_found': return ANNUAL_REVIEW_AI_IPC_FAILURE_MESSAGES.task_not_found
      case 'task_not_completed': return ANNUAL_REVIEW_AI_IPC_FAILURE_MESSAGES.task_not_completed
      case 'report_not_available': return ANNUAL_REVIEW_AI_IPC_FAILURE_MESSAGES.report_not_available
    }
  }
}
