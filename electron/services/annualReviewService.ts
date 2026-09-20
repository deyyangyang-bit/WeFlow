/**
 * annualReviewService.ts —— 年度经营复盘 · 主进程编排（S3）
 *
 * 职责（规格 §7.1/§7.2 + S3 任务）：
 *   - 生成任务状态机：idle → loading → computing → completed/failed；进度单调不回退、
 *     终态锁定；同一 {accountScopeId, year} 已有运行中任务时合并等待（不重复启动 Worker）；
 *     不同账号作用域独立运行；旧任务迟到消息（taskId 不匹配）不得覆盖新任务。
 *   - 账号作用域内存缓存：键 {accountScopeId, year, reportSchemaVersion}；仅主进程内存、
 *     TTL 10 分钟、不持久化；generate 强制重算覆盖同键缓存；getReport 只读当前作用域
 *     未过期缓存，miss/stale 明确区分，绝不回退其他账号。**不保证实时一致**：迟到同步、
 *     补录、迁移、删除都可能改变结果，靠 TTL + generate 强制重算 + 失效事件兜底。
 *   - Worker 边界：主进程加载数据库窄事实（由外部注入 loader），Worker 只接收可序列化的
 *     period/facts/messageStats/exclusions/reportSchemaVersion/taskId，内部调用已验收纯函数。
 *     本模块零数据库导入、零秘密；Worker 错误结构化（code + 非敏感 message），
 *     不回传堆栈/数据库路径/SQL/原始聊天内容。
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

/** 结构化错误（面向用户，非敏感；绝不携带堆栈/路径/SQL/原文） */
export interface AnnualReviewTaskError {
  code: 'worker_error' | 'worker_exit' | 'invalid_worker_result' | 'fact_load_failed' | 'cancelled' | 'internal'
  message: string
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
  /** salesDb/crmDb 文件名（非路径）——参与作用域派生，区分实际业务库身份 */
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
  /** 当前账号上下文（主进程真实来源：config wxid + 业务库名 + 排除名单） */
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
 * 账号作用域内存缓存。键 = accountScopeId \u0001 year \u0001 reportSchemaVersion。
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

/** FNV-1a 32 位哈希（十六进制）：把账号上下文折叠为不透明短标识，不暴露路径/原文 */
function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/**
 * 生成账号作用域标识：由规范化 wxid + salesDb/crmDb 文件名（非路径）派生的不透明短 id。
 *   - 区分不同规范化微信账号；
 *   - 区分实际业务库身份（含 legacy 回退名）；
 *   - 不包含数据库路径；wxid/库名经哈希折叠，不向渲染层暴露原文；
 *   - 密钥、Token、解密信息绝不参与派生。
 */
export function buildAccountScopeId(ctx: { wxid: string; salesDbName: string; crmDbName: string }): string {
  const raw = [String(ctx.wxid || '').trim(), String(ctx.salesDbName || '').trim(), String(ctx.crmDbName || '').trim()].join('\u0001')
  return `as-${fnv1aHex(raw)}`
}

// ─── 默认线程 runner（生产） ─────────────────────────────────────────────────

/**
 * 真实 Worker runner（生产）：加载 dist-electron/annualReviewWorker.js——与既有
 * annualReportWorker/dualReportWorker 相同的构建与解析约定（vite 构建接线见 vite.config.ts，
 * dev 与打包均为 __dirname 同级产物，scripts/verify-electron-bundle.cjs 扩展守卫覆盖）。
 * 消息契约：{type:'annualReview:progress'|'annualReview:result'|'annualReview:error', taskId, …}；
 * 非法消息 / taskId 不匹配 / exit 无结果 一律 reject，不留下永久 loading。
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
            reject(Object.assign(new Error(failCode === 'cancelled' ? '年度复盘生成已取消' : `年度复盘线程异常退出：${code}`), { code: failCode }))
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
}

interface TaskRecord {
  snapshot: AnnualReviewTaskSnapshot
  running: boolean
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

export class AnnualReviewService {
  private readonly cache: AnnualReviewCache
  private readonly tasks = new Map<string, TaskRecord>() // key: scopeId \u0001 year
  private readonly listeners = new Set<AnnualReviewProgressListener>()
  private readonly runner: AnnualReviewWorkerRunner
  private readonly now: () => number
  private readonly newTaskId: () => string
  private yearsCache = new Map<string, { result: AnnualReviewAvailableYearsResult & { generatedAt: number }; cachedAt: number }>()
  private runningTasksByTaskId = new Map<string, RunningTask>()

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
   * 发起生成并等待完成（与旧 annualReport:generateReport 同款阻塞信封；进度经事件并行推送）。
   * 同一 {scopeId, year} 已有运行中任务 → 合并等待同一任务（reused=true，不重复启动 Worker）。
   * 返回值携带最终状态：completed → success:true；failed → success:false + 结构化错误。
   */
  async generate(year: number): Promise<AnnualReviewGenerateResult> {
    const ctx = this.deps.getAccountContext()
    const scopeId = buildAccountScopeId(ctx)
    const scopeKey = this.keyOf(scopeId, year)
    const existing = this.tasks.get(scopeKey)
    if (existing && existing.running) {
      const reusedTaskId = existing.snapshot.taskId
      const running = this.runningTasksByTaskId.get(reusedTaskId)
      if (running) await running.promise
      const snapshot = this.tasks.get(scopeKey)?.snapshot
      if (snapshot?.status === 'completed') return { success: true, taskId: reusedTaskId, reused: true }
      return {
        success: false,
        taskId: reusedTaskId,
        reused: true,
        error: snapshot?.error ?? { code: 'internal', message: '年度复盘生成失败' }
      }
    }

    const taskId = this.newTaskId()
    const startedAt = this.now()
    const snapshot: AnnualReviewTaskSnapshot = {
      taskId, year, status: 'loading', progress: 0, startedAt, updatedAt: startedAt
    }
    const record: TaskRecord = { snapshot, running: true }
    this.tasks.set(scopeKey, record)
    const running: RunningTask = {
      promise: this.runTask(scopeId, scopeKey, taskId, year, ctx)
        .catch(() => { /* runTask 内部已收敛为 failed；此层只防 unhandled rejection */ })
        .finally(() => {
          record.running = false
          this.runningTasksByTaskId.delete(taskId)
        })
    }
    this.runningTasksByTaskId.set(taskId, running)
    await running.promise

    const finalSnapshot = this.tasks.get(scopeKey)?.snapshot
    if (finalSnapshot?.status === 'completed' && finalSnapshot.taskId === taskId) {
      return { success: true, taskId }
    }
    return {
      success: false,
      taskId,
      error: finalSnapshot?.error ?? { code: 'internal', message: '年度复盘生成失败' }
    }
  }

  private async runTask(scopeId: string, scopeKey: string, taskId: string, year: number, ctx: AnnualReviewAccountContext): Promise<void> {
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
    let facts: AnnualReviewFacts
    let sales: AnnualReviewSalesSegmentsFacts
    let crm: AnnualReviewCrmSegmentsFacts
    try {
      ;[facts, sales, crm] = await Promise.all([
        this.deps.loadFacts(),
        this.deps.loadSalesSegments(),
        this.deps.loadCrmSegments()
      ])
    } catch {
      this.failTask(scopeKey, taskId, 'fact_load_failed', '本地业务数据加载失败，无法生成年报复盘')
      return
    }

    try {
      this.updateTask(scopeKey, taskId, { progress: 30, statusText: '加载消息统计' })
      const messageStats = await this.loadMessageStatsSafe(facts, period, ctx)
      this.updateTask(scopeKey, taskId, { progress: 35, statusText: '计算年度统计' })

      // ── computing：Worker 执行已验收纯统计（只传可序列化载荷，无路径/密钥） ──
      this.updateTask(scopeKey, taskId, { status: 'computing', progress: 40 })
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
      const report = await this.runner.run(payload, (p) => {
        this.updateTask(scopeKey, taskId, { progress: Math.max(40, Math.min(95, p.progress)), statusText: p.statusText })
      })

      if (!report || typeof report !== 'object' || Array.isArray(report)) {
        this.failTask(scopeKey, taskId, 'invalid_worker_result', '年度复盘生成结果非法')
        return
      }
      // generate 强制重算：无条件覆盖同键缓存（含未过期条目）
      this.cache.set(scopeId, year, report)
      this.updateTask(scopeKey, taskId, { status: 'completed', progress: 100, statusText: '生成完成' })
    } catch (e) {
      const err = e as { code?: unknown; message?: unknown }
      if (err?.code === 'cancelled') {
        this.failTask(scopeKey, taskId, 'cancelled', '年度复盘生成已取消')
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

  cancel(taskId: string): { success: boolean; error?: { code: string; message: string } } {
    if (!this.validateTaskId(taskId)) return { success: false, error: { code: 'invalid_task_id', message: '非法的任务标识' } }
    const running = this.runningTasksByTaskId.get(taskId)
    if (running) {
      this.runner.cancel?.(taskId)
      return { success: true }
    }
    // 终态任务（completed/failed）：幂等成功，终态不可变
    for (const record of this.tasks.values()) {
      if (record.snapshot.taskId === taskId) return { success: true }
    }
    return { success: false, error: { code: 'task_not_found', message: '任务不存在或已过期' } }
  }

  private validateTaskId(taskId: string): boolean {
    return typeof taskId === 'string' && taskId.length > 0 && taskId.length <= 128
  }

  // ── 可用年份 ──
  async getAvailableYears(): Promise<AnnualReviewAvailableYearsResult & { generatedAt: number }> {
    const ctx = this.deps.getAccountContext()
    const scopeId = buildAccountScopeId(ctx)
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
    const result: AnnualReviewAvailableYearsResult & { generatedAt: number } = {
      ...computeAnnualReviewAvailableYears({ facts, sales, crm, generatedAt: now }),
      generatedAt: now
    }
    this.yearsCache.set(scopeId, { result, cachedAt: now })
    return result
  }

  // ── 失效 ──
  /** 账号切换 / salesDb/crmDb reopen：清空全部缓存（所有作用域），运行中任务照常收敛但不落新作用域缓存之外的位置 */
  invalidateAll(): void {
    this.cache.invalidateAll()
    this.yearsCache.clear()
  }

  /** 订阅型的数据写入失效（assignment 总线等）：coarse 失效当前全部缓存 */
  handleDataChanged(): void {
    this.cache.invalidateAll()
    this.yearsCache.clear()
  }
}
