/**
 * annualReviewService.ts —— 年度经营复盘 · 主进程编排（S3）
 *
 * 职责（规格 §7.1/§7.2 + S3 任务）：
 *   - 生成任务状态机：idle → loading → computing → completed/failed；进度单调不回退、
 *     终态锁定；同一 {accountScopeId, year} 已有运行中任务时合并等待（不重复启动 Worker）；
 *     不同账号作用域独立运行；旧任务迟到消息（taskId 不匹配）不得覆盖新任务。
 *   - 取消（TaskControl）：cancel 对 loading 与 computing 都有效。loading 阶段取消后
 *     不再启动 Worker；computing 阶段取消真实 terminate Worker（runner.cancel）。
 *     服务级 cancel signal（Promise race）让阻塞中的 generate() 立即收敛为
 *     failed + error.code='cancelled'，不必等待无法中断的数据库查询；迟到的底层
 *     查询结果与 Worker 结果一律丢弃。终态任务重复 cancel 幂等成功；未知 taskId
 *     返回 task_not_found；多次 cancel 不抛错、不产生相互冲突的终态。
 *   - 失效 epoch：每次 invalidateAll()/handleDataChanged() 递增失效纪元；任务与
 *     getAvailableYears 在开始时捕获 epoch 与账号作用域，任一 await 完成后、Worker
 *     启动前、缓存写入前复核；epoch 或账号上下文已变化的旧任务收敛为
 *     failed + error.code='invalidated'，绝不写回任何账号的报告/年份缓存；失效后
 *     新请求重新加载事实。
 *   - 账号作用域内存缓存：键 = 完整复合作用域（JSON 复合键，无哈希折叠碰撞）+
 *     year + reportSchemaVersion；仅主进程内存、TTL 10 分钟、不持久化；generate 强制
 *     重算覆盖同键缓存；getReport 只读当前作用域未过期缓存，miss/stale 明确区分，
 *     绝不回退其他账号。**不保证实时一致**：迟到同步、补录、迁移、删除都可能改变
 *     结果，靠 TTL + generate 强制重算 + 失效事件兜底。
 *   - Worker 边界：主进程加载数据库窄事实（由外部注入 loader），Worker 只接收可序列化的
 *     period/facts/messageStats/exclusions/reportSchemaVersion/taskId，内部调用已验收纯函数。
 *     本模块零数据库导入、零秘密；Worker 结果经 validateAnnualReviewReport 运行时结构
 *     校验（非法结果不写缓存，收敛 failed/invalid_worker_result）；错误结构化
 *     （code + 非敏感 message），不回传堆栈/数据库路径/SQL/原始聊天内容。
 *
 * 测试纪律：全部外部依赖（事实加载、消息统计、账号上下文、Worker runner、时钟）经
 * AnnualReviewServiceDeps 注入，tsx 测试用假依赖驱动完整状态机，不触碰真实数据库。
 */
import { Worker } from 'worker_threads'
import { join } from 'path'
import {
  ANNUAL_REVIEW_REPORT_SCHEMA_VERSION,
  resolveAnnualReviewPeriod,
  annualReviewWcdbSeconds,
  buildExclusionSet,
  isStructurallyExcluded,
  normSession,
  type AnnualReviewExclusions,
  type AnnualReviewFacts,
  type AnnualReviewMessageStats,
  type AnnualReviewPeriod
} from './annualReviewStats'
import type {
  AnnualReviewCrmSegmentsFacts,
  AnnualReviewSalesSegmentsFacts
} from './annualReviewSegments'
import {
  computeAnnualReviewAvailableYears,
  composeAnnualReviewReport,
  validateAnnualReviewReport,
  validateAnnualReviewYearInput,
  type AnnualReviewAvailableYearsResult,
  type AnnualReviewReport
} from './annualReviewReport'

// ─── 任务与进度 ──────────────────────────────────────────────────────────────

export type AnnualReviewTaskStatus = 'loading' | 'computing' | 'completed' | 'failed'

export interface AnnualReviewTaskSnapshot {
  taskId: string
  year: number
  status: AnnualReviewTaskStatus
  /** 0–100，单调不回退；completed 恒 100 */
  progress: number
  statusText?: string
  error?: { code: string; message: string }
  startedAt: number
  updatedAt: number
}

/** 进度事件载荷（广播给渲染层；规格 §7.2 annualReview:progress） */
export interface AnnualReviewProgressEvent {
  taskId: string
  year: number
  phase: 'loading' | 'computing' | 'completed' | 'failed'
  /** 0–100 */
  progress: number
  statusText?: string
  done: boolean
  error?: { code: string; message: string }
}

export type AnnualReviewProgressListener = (event: AnnualReviewProgressEvent) => void

/**
 * 结构化错误（面向用户，非敏感；绝不携带堆栈/路径/SQL/原文）。
 * invalidated = 失效纪元或账号上下文在任务运行期间发生变化（规格 §7.2 失效条件命中），
 * 任务被收敛终止；与用户主动取消（cancelled）语义区分，code 稳定且对 UI 可文档化。
 */
export interface AnnualReviewTaskError {
  code: 'worker_error' | 'worker_exit' | 'invalid_worker_result' | 'fact_load_failed' | 'cancelled' | 'invalidated' | 'internal'
  message: string
}

// ─── 取消/失效控制（服务级 TaskControl） ─────────────────────────────────────

const CANCELLED_MESSAGE = '年度复盘生成已取消'
const INVALIDATED_MESSAGE = '数据已失效（账号/业务库变更或数据写入），本次生成已终止'

function abortError(code: 'cancelled' | 'invalidated'): Error {
  return Object.assign(new Error(code === 'cancelled' ? CANCELLED_MESSAGE : INVALIDATED_MESSAGE), { code })
}

type AbortCode = 'cancelled' | 'invalidated'

/**
 * 单任务的取消/失效控制。abort(code) 让所有经 race() 挂起的 await 立即以该 code 收敛，
 * 不依赖底层查询/Worker 可中断；迟到的底层结果由调用方在 race 收敛后统一丢弃。
 * promise 常驻一个 no-op catch，保证「无人 race 时 abort」不产生 unhandled rejection。
 */
class TaskControl {
  readonly promise: Promise<never>
  private trigger!: (e: Error) => void
  private state: 'running' | AbortCode = 'running'

  constructor() {
    this.promise = new Promise<never>((_, reject) => { this.trigger = reject })
    this.promise.catch(() => { /* 常驻处理：abort 无人 race 时静默 */ })
  }

  get cancelled(): boolean { return this.state === 'cancelled' }
  get invalidated(): boolean { return this.state === 'invalidated' }
  get aborted(): boolean { return this.state !== 'running' }

  /** 幂等；首个 code 生效（取消与失效互斥，先到先得，不产生冲突终态） */
  abort(code: AbortCode): void {
    if (this.state !== 'running') return
    this.state = code
    this.trigger(abortError(code))
  }

  /** 同步检查点：已中止则抛出（Worker 启动前 / 缓存写入前等） */
  check(): void {
    if (this.state !== 'running') throw abortError(this.state)
  }

  /**
   * race 一个异步步骤：abort 时立刻以 abortError 收敛，p 的结果被丢弃
   * （p 的 rejection 由 race 挂接的 handler 吸收，不产生 unhandled rejection）。
   */
  race<T>(p: Promise<T>): Promise<T> {
    return Promise.race([p, this.promise])
  }
}

// ─── Worker runner（窄接口，可注入） ────────────────────────────────────────

/** Worker 输入：全部可结构化克隆；不含数据库路径、密钥、Token、wxid 原文 */
export interface AnnualReviewWorkerPayload {
  taskId: string
  reportSchemaVersion: number
  period: AnnualReviewPeriod
  facts: AnnualReviewFacts
  sales: AnnualReviewSalesSegmentsFacts
  crm: AnnualReviewCrmSegmentsFacts
  messageStats: AnnualReviewMessageStats
  exclusions?: AnnualReviewExclusions
}

/** Worker 进度消息（ taskId 标记，供状态机丢弃迟到消息） */
export interface AnnualReviewWorkerProgressMessage {
  type: 'annualReview:progress'
  taskId: string
  data: { phase: 'loading' | 'computing'; progress: number; statusText?: string }
}

export interface AnnualReviewWorkerResultMessage {
  type: 'annualReview:result'
  taskId: string
  data: AnnualReviewReport
}

export interface AnnualReviewWorkerErrorMessage {
  type: 'annualReview:error'
  taskId: string
  error: { code: string; message: string }
}

export type AnnualReviewWorkerMessage = AnnualReviewWorkerProgressMessage | AnnualReviewWorkerResultMessage | AnnualReviewWorkerErrorMessage

export interface AnnualReviewWorkerRunner {
  /** 运行一次生成；resolve 值必须是合法报告对象；任何失败 reject（Error 或 {code,message}） */
  run(payload: AnnualReviewWorkerPayload, onProgress: (p: { progress: number; statusText?: string }) => void): Promise<AnnualReviewReport>
  /** 请求终止任务（best-effort；runner 内部保证对应 promise 收敛） */
  cancel?(taskId: string): void
  /** 释放资源（进程退出/重开库时调用） */
  dispose?(): void
}

// ─── 依赖注入 ────────────────────────────────────────────────────────────────

export interface AnnualReviewAccountContext {
  /** 规范化微信账号（仅参与作用域派生，不进入缓存键原文、不发给渲染层） */
  wxid: string
  /**
   * 实际业务库身份（主进程内部键；不发给渲染层、不写日志）。
   * 生产来源 = salesDbService/crmDbService.currentDbPath()（当前实际打开的库文件路径），
   * 未打开时回退按 wxid 推导的规范文件名；路径只参与作用域派生。
   */
  salesDbName: string
  crmDbName: string
  exclusions: AnnualReviewExclusions
}

export interface AnnualReviewServiceDeps {
  /** 加载 A 组窄事实（crmDb） */
  loadFacts: () => Promise<AnnualReviewFacts>
  /** 加载 salesDb 段事实（customer_profile / intent_tag_log） */
  loadSalesSegments: () => Promise<AnnualReviewSalesSegmentsFacts>
  /** 加载 crmDb 段事实（opportunity / opportunity_event） */
  loadCrmSegments: () => Promise<AnnualReviewCrmSegmentsFacts>
  /** WCDB 消息统计（A3 主口径；秒区间已换算后调用） */
  loadMessageStats: (sessionIds: string[], beginSec: number, endSec: number) => Promise<AnnualReviewMessageStats>
  /** 当前账号上下文（主进程真实来源：config wxid + 实际业务库身份 + 排除名单） */
  getAccountContext: () => AnnualReviewAccountContext
  /** Worker runner；缺省 = 真实线程 runner（annualReviewWorker.js） */
  runner?: AnnualReviewWorkerRunner
  /** 时钟（测试注入）；缺省 Date.now */
  now?: () => number
  /** taskId 生成器（测试注入）；缺省随机 */
  newTaskId?: () => string
}

// ─── 缓存 ────────────────────────────────────────────────────────────────────

export const ANNUAL_REVIEW_CACHE_TTL_MS = 10 * 60_000

interface AnnualReviewCacheEntry {
  report: AnnualReviewReport
  cachedAt: number
}

export type AnnualReviewCacheLookup = { hit: true; report: AnnualReviewReport } | { hit: false; stale: boolean }

/**
 * 账号作用域内存缓存。键 = accountScopeId（完整复合键）\u0001 year \u0001 reportSchemaVersion。
 * 仅内存、TTL 10 分钟、不持久化、不写 config；历史年度同样受 TTL 约束
 * （边界稳定 ≠ 底层数据不可变：迟到同步/补录/迁移/删除都会改变结果）。
 */
export class AnnualReviewCache {
  private readonly entries = new Map<string, AnnualReviewCacheEntry>()

  constructor(
    private readonly ttlMs: number = ANNUAL_REVIEW_CACHE_TTL_MS,
    private readonly now: () => number = Date.now
  ) {}

  private static key(scopeId: string, year: number): string {
    return `${scopeId}\u0001${year}\u0001${ANNUAL_REVIEW_REPORT_SCHEMA_VERSION}`
  }

  get(scopeId: string, year: number): AnnualReviewCacheLookup {
    const entry = this.entries.get(AnnualReviewCache.key(scopeId, year))
    if (!entry) return { hit: false, stale: false }
    if (this.now() - entry.cachedAt > this.ttlMs) return { hit: false, stale: true }
    return { hit: true, report: entry.report }
  }

  set(scopeId: string, year: number, report: AnnualReviewReport): void {
    this.entries.set(AnnualReviewCache.key(scopeId, year), { report, cachedAt: this.now() })
  }

  /** 失效一个账号作用域的全部年份（账号切换 / reopen / 写入失效事件时调用） */
  invalidateScope(scopeId: string): void {
    for (const key of this.entries.keys()) {
      if (key.startsWith(`${scopeId}\u0001`)) this.entries.delete(key)
    }
  }

  invalidateAll(): void {
    this.entries.clear()
  }
}

// ─── accountScopeId ──────────────────────────────────────────────────────────

/**
 * 生成账号作用域标识：完整复合键（JSON 数组编码，长度自描述、字符转义无歧义，
 * 任意输入组合两两可区分——无 32/64 位哈希折叠碰撞面）。
 *   - 区分不同规范化微信账号与实际业务库身份（含 legacy 回退名）；
 *   - 仅作为主进程内部 Map 键使用，绝不写日志、绝不返回渲染层、绝不进入 Worker 载荷；
 *   - 不包含解密密钥/Token；数据库路径仅以 currentDbPath 身份参与派生（内部键允许）。
 */
export function buildAccountScopeId(ctx: { wxid: string; salesDbName: string; crmDbName: string }): string {
  return JSON.stringify([
    String(ctx.wxid || '').trim(),
    String(ctx.salesDbName || '').trim(),
    String(ctx.crmDbName || '').trim()
  ])
}

// ─── 默认线程 runner（生产） ─────────────────────────────────────────────────

/**
 * 真实 Worker runner（生产）：加载 dist-electron/annualReviewWorker.js——与既有
 * annualReportWorker/dualReportWorker 相同的构建与解析约定（vite 构建接线见 vite.config.ts，
 * dev 与打包均为 __dirname 同级产物，scripts/verify-electron-bundle.cjs 扩展守卫覆盖）。
 * 消息契约：{type:'annualReview:progress'|'annualReview:result'|'annualReview:error', taskId, …}；
 * 非法消息 / taskId 不匹配 / exit 无结果 一律 reject，不留下永久 loading。
 * cancel(taskId) 真实 terminate Worker（computing 阶段取消的落地动作）。
 */
export function createThreadRunner(workerFileName = 'annualReviewWorker.js'): AnnualReviewWorkerRunner {
  const workerPath = join(__dirname, workerFileName)
  const running = new Map<string, { worker: Worker; reject: (e: unknown) => void; settled: boolean; cancelled: boolean }>()

  const failRunning = (taskId: string, error: AnnualReviewTaskError): void => {
    const entry = running.get(taskId)
    if (!entry || entry.settled) return
    entry.settled = true
    running.delete(taskId)
    entry.reject(Object.assign(new Error(error.message), { code: error.code }))
  }

  return {
    run(payload, onProgress) {
      return new Promise<AnnualReviewReport>((resolve, reject) => {
        let worker: Worker
        try {
          worker = new Worker(workerPath, { workerData: payload })
        } catch {
          reject(Object.assign(new Error('年度复盘线程启动失败'), { code: 'worker_error' }))
          return
        }
        const taskId = payload.taskId
        const entry = { worker, reject, settled: false, cancelled: false }
        running.set(taskId, entry)
        const settleOk = (report: AnnualReviewReport): void => {
          if (entry.settled) return
          entry.settled = true
          running.delete(taskId)
          resolve(report)
        }
        worker.on('message', (msg: unknown) => {
          if (!msg || typeof msg !== 'object' || typeof (msg as { type?: unknown }).type !== 'string') {
            failRunning(taskId, { code: 'invalid_worker_result', message: '年度复盘线程返回非法消息' })
            return
          }
          const m = msg as { type: string; taskId?: unknown; data?: unknown; error?: unknown }
          if (m.taskId !== taskId) return // 迟到/串线消息直接丢弃
          if (m.type === 'annualReview:progress') {
            const d = m.data as { progress?: unknown; statusText?: unknown } | undefined
            const progress = typeof d?.progress === 'number' && Number.isFinite(d.progress) ? d.progress : null
            if (progress === null) {
              failRunning(taskId, { code: 'invalid_worker_result', message: '年度复盘线程进度消息非法' })
              return
            }
            onProgress({ progress, statusText: typeof d?.statusText === 'string' ? d.statusText : undefined })
            return
          }
          if (m.type === 'annualReview:result') {
            if (!m.data || typeof m.data !== 'object') {
              failRunning(taskId, { code: 'invalid_worker_result', message: '年度复盘线程返回非法报告' })
              return
            }
            settleOk(m.data as AnnualReviewReport)
            return
          }
          if (m.type === 'annualReview:error') {
            const err = m.error as { code?: unknown; message?: unknown } | undefined
            failRunning(taskId, {
              code: 'worker_error',
              message: typeof err?.message === 'string' && err.message ? err.message : '年度复盘生成失败'
            })
            return
          }
          failRunning(taskId, { code: 'invalid_worker_result', message: '年度复盘线程消息类型未知' })
        })
        worker.on('error', () => {
          failRunning(taskId, { code: 'worker_error', message: '年度复盘线程异常' })
        })
        worker.on('exit', (code) => {
          if (!entry.settled) {
            entry.settled = true
            running.delete(taskId)
            const failCode = entry.cancelled ? 'cancelled' : 'worker_exit'
            reject(Object.assign(new Error(failCode === 'cancelled' ? CANCELLED_MESSAGE : `年度复盘线程异常退出：${code}`), { code: failCode }))
          }
        })
      })
    },
    cancel(taskId) {
      const entry = running.get(taskId)
      if (!entry) return
      entry.cancelled = true // exit 收敛时以 cancelled 而非 worker_exit 拒绝
      try { entry.worker.terminate() } catch { /* terminate 失败由 exit/超时收敛 */ }
    },
    dispose() {
      for (const [, entry] of running) {
        try { entry.worker.terminate() } catch { /* 进程退出路径，尽力而为 */ }
      }
      running.clear()
    }
  }
}

// ─── 服务主体 ────────────────────────────────────────────────────────────────

interface RunningTask {
  promise: Promise<void>
  control: TaskControl
  /** 真实终止只请求一次（单任务 cancel / invalidateAll / handleDataChanged / 账号切换共用） */
  terminateRequested: boolean
}

interface TaskRecord {
  snapshot: AnnualReviewTaskSnapshot
  running: boolean
}

export interface AnnualReviewStartResult {
  taskId: string
  /** true = 合并到已运行的同一 {scopeId, year} 任务 */
  reused: boolean
}

export interface AnnualReviewGenerateResult {
  success: boolean
  taskId?: string
  /** true = 同键已有任务，本次合并等待同一任务 */
  reused?: boolean
  error?: { code: string; message: string }
}

export interface AnnualReviewGetReportResult {
  success: boolean
  /** 'hit' 命中未过期缓存；'miss' 无缓存；'stale' 有缓存但已过期（绝不回退其他账号） */
  cache: 'hit' | 'miss' | 'stale'
  report?: AnnualReviewReport
  error?: { code: string; message: string }
}

/** 失效收敛错误（assertCurrent 抛出；runTask 捕获后映射为 failed/invalidated） */
function invalidationError(message: string): Error {
  return Object.assign(new Error(message), { code: 'invalidated' as const })
}

export class AnnualReviewService {
  private readonly cache: AnnualReviewCache
  private readonly tasks = new Map<string, TaskRecord>() // key: scopeId \u0001 year
  private readonly listeners = new Set<AnnualReviewProgressListener>()
  private readonly runner: AnnualReviewWorkerRunner
  private readonly now: () => number
  private readonly newTaskId: () => string
  private yearsCache = new Map<string, { result: AnnualReviewAvailableYearsResult & { generatedAt: number }; cachedAt: number }>()
  private runningTasksByTaskId = new Map<string, RunningTask>()
  /** 失效纪元：invalidateAll/handleDataChanged 各自递增；任务开始时捕获、完成后复核 */
  private epoch = 0

  constructor(private readonly deps: AnnualReviewServiceDeps) {
    this.cache = new AnnualReviewCache(ANNUAL_REVIEW_CACHE_TTL_MS, deps.now ?? Date.now)
    this.runner = deps.runner ?? createThreadRunner()
    this.now = deps.now ?? Date.now
    this.newTaskId = deps.newTaskId ?? (() => `ar-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`)
  }

  // ── 进度事件 ──
  /** 订阅进度事件；返回清理函数（调用后不再收到事件） */
  onProgress(listener: AnnualReviewProgressListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private emitProgress(snapshot: AnnualReviewTaskSnapshot): void {
    const event: AnnualReviewProgressEvent = {
      taskId: snapshot.taskId,
      year: snapshot.year,
      phase: snapshot.status,
      progress: snapshot.progress,
      statusText: snapshot.statusText,
      done: snapshot.status === 'completed' || snapshot.status === 'failed',
      error: snapshot.error
    }
    for (const listener of this.listeners) {
      try { listener(event) } catch { /* 监听器异常不阻断任务 */ }
    }
  }

  // ── 任务状态机 ──
  private updateTask(scopeKey: string, taskId: string, patch: { status?: AnnualReviewTaskStatus; progress?: number; statusText?: string; error?: AnnualReviewTaskError }): void {
    const record = this.tasks.get(scopeKey)
    if (!record || record.snapshot.taskId !== taskId) return // 迟到消息：非当前任务，丢弃
    const s = record.snapshot
    if (s.status === 'completed' || s.status === 'failed') return // 终态锁定
    if (patch.status !== undefined) s.status = patch.status
    if (patch.progress !== undefined && patch.progress > s.progress) s.progress = Math.min(100, patch.progress) // 单调
    if (patch.statusText !== undefined) s.statusText = patch.statusText
    if (patch.error !== undefined) s.error = patch.error
    if (s.status === 'completed') s.progress = 100
    s.updatedAt = this.now()
    this.emitProgress(s)
  }

  private keyOf(scopeId: string, year: number): string {
    return `${scopeId}\u0001${year}`
  }

  // ── 生成 ──
  /**
   * 非阻塞启动（「启动」与「等待」分离；页面/IPC 用）：立即返回 taskId 与 reused。
   * 同一 {scopeId, year} 已有运行中任务 → 合并该任务（reused=true，不重复启动 Worker）。
   * 完成与失败经 progress 事件（done=true）推送；cancel(taskId) 对 loading/computing 有效。
   */
  start(year: number): AnnualReviewStartResult {
    const ctx = this.deps.getAccountContext()
    const scopeId = buildAccountScopeId(ctx)
    return this.startWithScope(scopeId, this.keyOf(scopeId, year), year)
  }

  private startWithScope(scopeId: string, scopeKey: string, year: number): AnnualReviewStartResult {
    const ctx = this.deps.getAccountContext()
    const existing = this.tasks.get(scopeKey)
    if (existing && existing.running) {
      return { taskId: existing.snapshot.taskId, reused: true }
    }
    const taskId = this.newTaskId()
    const startedAt = this.now()
    const snapshot: AnnualReviewTaskSnapshot = {
      taskId, year, status: 'loading', progress: 0, startedAt, updatedAt: startedAt
    }
    const record: TaskRecord = { snapshot, running: true }
    this.tasks.set(scopeKey, record)
    const control = new TaskControl()
    const running: RunningTask = {
      control,
      terminateRequested: false,
      promise: this.runTask({ scopeId, scopeKey, taskId, year, ctx, control, epochAtStart: this.epoch })
        .catch(() => { /* runTask 内部已收敛为 failed；此层只防 unhandled rejection */ })
        .finally(() => {
          record.running = false
          this.runningTasksByTaskId.delete(taskId)
        })
    }
    this.runningTasksByTaskId.set(taskId, running)
    return { taskId, reused: false }
  }

  /**
   * 发起生成并等待完成（阻塞信封 = start + await；进度经事件并行推送）。
   * 同一 {scopeId, year} 已有运行中任务 → 合并等待同一任务（reused=true）。
   * 返回值携带最终状态：completed → success:true；failed（含 cancelled/invalidated）→
   * success:false + 结构化错误。
   */
  async generate(year: number): Promise<AnnualReviewGenerateResult> {
    const ctx = this.deps.getAccountContext()
    const scopeId = buildAccountScopeId(ctx)
    const scopeKey = this.keyOf(scopeId, year)
    const started = this.startWithScope(scopeId, scopeKey, year)
    const running = this.runningTasksByTaskId.get(started.taskId)
    if (running) await running.promise
    const finalSnapshot = this.tasks.get(scopeKey)?.snapshot
    if (finalSnapshot?.status === 'completed' && finalSnapshot.taskId === started.taskId) {
      return { success: true, taskId: started.taskId, reused: started.reused }
    }
    return {
      success: false,
      taskId: started.taskId,
      reused: started.reused,
      error: finalSnapshot?.error ?? { code: 'internal', message: '年度复盘生成失败' }
    }
  }

  /**
   * 时效复核：失效纪元或账号上下文（账号/实际业务库身份）已变化 → 抛 invalidated。
   * 调用点 = 每个 await 完成后、Worker 启动前、缓存写入前（规格 §2 强制失效条件）。
   */
  private assertCurrent(scopeId: string, epochAtStart: number): void {
    if (this.epoch !== epochAtStart) {
      throw invalidationError(INVALIDATED_MESSAGE)
    }
    const currentScopeId = buildAccountScopeId(this.deps.getAccountContext())
    if (currentScopeId !== scopeId) {
      throw invalidationError('账号或业务库已变更，本次生成结果已作废')
    }
  }

  private async runTask(args: {
    scopeId: string
    scopeKey: string
    taskId: string
    year: number
    ctx: AnnualReviewAccountContext
    control: TaskControl
    epochAtStart: number
  }): Promise<void> {
    const { scopeId, scopeKey, taskId, year, ctx, control, epochAtStart } = args
    try {
      const generatedAt = this.now()
      let period: AnnualReviewPeriod
      try {
        period = resolveAnnualReviewPeriod(year, generatedAt)
      } catch (e) {
        this.failTask(scopeKey, taskId, 'internal', e instanceof Error ? e.message : '时间契约解析失败')
        return
      }

      // ── loading：主进程加载窄事实（数据库访问只在主进程服务边界内） ──
      this.updateTask(scopeKey, taskId, { progress: 5, statusText: '加载本地业务数据' })
      control.check() // loading 阶段已取消 → 不发起任何加载，更不启动 Worker
      let facts: AnnualReviewFacts
      let sales: AnnualReviewSalesSegmentsFacts
      let crm: AnnualReviewCrmSegmentsFacts
      try {
        ;[facts, sales, crm] = await control.race(Promise.all([
          this.deps.loadFacts(),
          this.deps.loadSalesSegments(),
          this.deps.loadCrmSegments()
        ]))
      } catch (e) {
        if (control.aborted) {
          this.failTask(scopeKey, taskId, control.cancelled ? 'cancelled' : 'invalidated', control.cancelled ? CANCELLED_MESSAGE : INVALIDATED_MESSAGE)
          return
        }
        this.failTask(scopeKey, taskId, 'fact_load_failed', '本地业务数据加载失败，无法生成年报复盘')
        return
      }
      this.assertCurrent(scopeId, epochAtStart)
      control.check()

      this.updateTask(scopeKey, taskId, { progress: 30, statusText: '加载消息统计' })
      const messageStats = await control.race(this.loadMessageStatsSafe(facts, period, ctx))
      this.assertCurrent(scopeId, epochAtStart)
      control.check()
      this.updateTask(scopeKey, taskId, { progress: 35, statusText: '计算年度统计' })

      // ── computing：Worker 执行已验收纯统计（只传可序列化载荷，无路径/密钥） ──
      this.updateTask(scopeKey, taskId, { status: 'computing', progress: 40 })
      this.assertCurrent(scopeId, epochAtStart)
      control.check() // Worker 启动前最后检查：取消/失效后绝不启动 Worker
      const payload: AnnualReviewWorkerPayload = {
        taskId,
        reportSchemaVersion: ANNUAL_REVIEW_REPORT_SCHEMA_VERSION,
        period,
        facts,
        sales,
        crm,
        messageStats,
        exclusions: ctx.exclusions
      }
      const report = await control.race(this.runner.run(payload, (p) => {
        this.updateTask(scopeKey, taskId, { progress: Math.max(40, Math.min(95, p.progress)), statusText: p.statusText })
      }))

      // Worker 返回后、缓存写入前：终检（取消/失效的迟到收敛一律丢弃结果）
      this.assertCurrent(scopeId, epochAtStart)
      control.check()
      const validation = validateAnnualReviewReport(report, year)
      if (!validation.ok) {
        this.failTask(scopeKey, taskId, 'invalid_worker_result', '年度复盘生成结果非法')
        return
      }
      // generate 强制重算：无条件覆盖同键缓存（含未过期条目）
      this.cache.set(scopeId, year, report)
      this.updateTask(scopeKey, taskId, { status: 'completed', progress: 100, statusText: '生成完成' })
    } catch (e) {
      if (control.cancelled) {
        this.failTask(scopeKey, taskId, 'cancelled', CANCELLED_MESSAGE)
        return
      }
      if (control.invalidated) {
        this.failTask(scopeKey, taskId, 'invalidated', INVALIDATED_MESSAGE)
        return
      }
      const err = e as { code?: unknown; message?: unknown }
      if (err?.code === 'cancelled') {
        this.failTask(scopeKey, taskId, 'cancelled', CANCELLED_MESSAGE)
        return
      }
      if (err?.code === 'invalidated') {
        this.failTask(scopeKey, taskId, 'invalidated', e instanceof Error && e.message ? e.message : INVALIDATED_MESSAGE)
        return
      }
      this.failTask(scopeKey, taskId, 'worker_error', e instanceof Error && e.message ? e.message : '年度复盘生成失败')
    }
  }

  private failTask(scopeKey: string, taskId: string, code: AnnualReviewTaskError['code'], message: string): void {
    const record = this.tasks.get(scopeKey)
    if (!record || record.snapshot.taskId !== taskId) return
    this.updateTask(scopeKey, taskId, { status: 'failed', error: { code, message } })
  }

  /** A3 消息统计：WCDB 失败/未连接 → ok=false（统计层回退或 unavailable，不伪造） */
  private async loadMessageStatsSafe(facts: AnnualReviewFacts, period: AnnualReviewPeriod, ctx: AnnualReviewAccountContext): Promise<AnnualReviewMessageStats> {
    const exclusions = buildExclusionSet(ctx.exclusions)
    const sessionIds: string[] = []
    const seen = new Set<string>()
    for (const acc of facts.accounts ?? []) {
      const sid = normSession(acc.sessionId)
      if (!sid || isStructurallyExcluded(sid) || exclusions.has(sid) || seen.has(sid)) continue
      seen.add(sid)
      sessionIds.push(sid)
    }
    const { beginSec, endSec } = annualReviewWcdbSeconds(period)
    try {
      return await this.deps.loadMessageStats(sessionIds, beginSec, endSec)
    } catch {
      return { ok: false, sessions: {} }
    }
  }

  // ── 查询 ──
  getReport(year: number, generatedAtForValidation?: number): AnnualReviewGetReportResult {
    const validation = validateAnnualReviewYearInput(year, generatedAtForValidation ?? this.now())
    if (!validation.ok) {
      return { success: false, cache: 'miss', error: { code: validation.code, message: validation.message } }
    }
    const ctx = this.deps.getAccountContext()
    const scopeId = buildAccountScopeId(ctx)
    const lookup = this.cache.get(scopeId, validation.year)
    if (lookup.hit) return { success: true, cache: 'hit', report: lookup.report }
    return { success: true, cache: lookup.stale ? 'stale' : 'miss' }
  }

  getTaskState(year: number): AnnualReviewTaskSnapshot | null {
    const ctx = this.deps.getAccountContext()
    const scopeId = buildAccountScopeId(ctx)
    const record = this.tasks.get(this.keyOf(scopeId, year))
    return record ? { ...record.snapshot } : null
  }

  /**
   * 取消任务：loading 与 computing 都有效（loading = 收敛并不再启动 Worker；
   * computing = 真实 terminate Worker + control 收敛）。
   * 终态任务幂等成功（终态不可变）；未知 taskId → task_not_found；
   * 多次 cancel 幂等，不抛错、不产生相互冲突的终态。
   */
  cancel(taskId: string): { success: boolean; error?: { code: string; message: string } } {
    if (!this.validateTaskId(taskId)) return { success: false, error: { code: 'invalid_task_id', message: '非法的任务标识' } }
    const running = this.runningTasksByTaskId.get(taskId)
    if (running) {
      this.requestTerminate(taskId, running, 'cancelled')
      return { success: true }
    }
    // 终态任务（completed/failed）：幂等成功，终态不可变
    for (const record of this.tasks.values()) {
      if (record.snapshot.taskId === taskId) return { success: true }
    }
    return { success: false, error: { code: 'task_not_found', message: '任务不存在或已过期' } }
  }

  /**
   * 统一终止语义（单任务 cancel / invalidateAll / handleDataChanged / 账号切换共用）：
   * 先请求真实终止（幂等：一个任务最多触发一次 runner.cancel；抛错被稳定吸收，
   * 不影响收敛、不使缓存重新可用、不崩溃），再 abort control 让任务立即收敛。
   * 两者在同一同步块内执行，不存在「服务已忘记、Worker 仍运行」的窗口。
   */
  private requestTerminate(taskId: string, running: RunningTask, code: 'cancelled' | 'invalidated'): void {
    if (!running.terminateRequested) {
      running.terminateRequested = true
      try {
        this.runner.cancel?.(taskId)
      } catch { /* 终止失败：任务仍经 control 收敛为 failed，Worker 退出事件兜底 */ }
    }
    running.control.abort(code)
  }

  private validateTaskId(taskId: string): boolean {
    return typeof taskId === 'string' && taskId.length > 0 && taskId.length <= 128
  }

  // ── 可用年份 ──
  /**
   * 可用年份（主进程计算，renderer 不推断）。开始时捕获失效纪元与账号作用域；
   * 加载完成后复核——失效或账号已变化的旧结果绝不写回年份缓存（也不返回），
   * 新请求会重新加载事实。失效期间并发到达的调用以结构化 invalidated 错误收敛。
   */
  async getAvailableYears(): Promise<AnnualReviewAvailableYearsResult & { generatedAt: number }> {
    const ctx = this.deps.getAccountContext()
    const scopeId = buildAccountScopeId(ctx)
    const epochAtStart = this.epoch
    const cached = this.yearsCache.get(scopeId)
    const now = this.now()
    if (cached && now - cached.cachedAt <= ANNUAL_REVIEW_CACHE_TTL_MS) {
      return cached.result
    }
    const [facts, sales, crm] = await Promise.all([
      this.deps.loadFacts(),
      this.deps.loadSalesSegments(),
      this.deps.loadCrmSegments()
    ])
    this.assertCurrent(scopeId, epochAtStart)
    const result: AnnualReviewAvailableYearsResult & { generatedAt: number } = {
      ...computeAnnualReviewAvailableYears({ facts, sales, crm, generatedAt: now }),
      generatedAt: now
    }
    this.yearsCache.set(scopeId, { result, cachedAt: now })
    return result
  }

  // ── 失效 ──
  /**
   * 账号切换 / salesDb/crmDb reopen：递增失效纪元 + 清空全部缓存（所有作用域）+
   * 终止全部运行中任务（收敛 failed/invalidated）。旧作用域任务绝不写回任何缓存。
   */
  invalidateAll(): void {
    this.epoch++
    this.cache.invalidateAll()
    this.yearsCache.clear()
    this.abortRunningTasks()
  }

  /**
   * 订阅型的数据写入失效（assignment 总线等）：递增失效纪元 + coarse 清空全部缓存 +
   * 终止全部运行中任务（收敛 failed/invalidated，结果一律丢弃不写缓存）。
   */
  handleDataChanged(): void {
    this.epoch++
    this.cache.invalidateAll()
    this.yearsCache.clear()
    this.abortRunningTasks()
  }

  private abortRunningTasks(): void {
    for (const [taskId, running] of this.runningTasksByTaskId) {
      this.requestTerminate(taskId, running, 'invalidated')
    }
  }
}
