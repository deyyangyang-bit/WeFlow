/**
 * autoBackupService.ts —— 自动备份 electron 侧装配（PRD 1.1 双保险定时备份）。
 * 分层：纯逻辑在 autoBackupCore.ts（零 electron，可 tsx 单测）；本文件负责
 *   ① 依赖注入（ConfigService / userData / appVersion，由 main.ts 传入，自身不 import electron）
 *   ② 备份前落盘：crm/sales 是 sql.js 内存库，写操作后 500ms 防抖落盘
 *      （crmDbService.persist / salesDbService.persist）——备份前必须 persistNow/flushNow
 *      强制刷盘，否则可能备出 500ms 前的旧文件。依据：crmDbService.ts persistNow /
 *      salesDbService.ts flushNow（公开入口，注释即「备份前强制刷盘用」）。
 *   ③ 审计：每次备份写 audit_event（action=auto_backup，成功/失败都写，宪法 §1.12）
 *   ④ 调度：每日 autoBackupTime（默认 14:37）；启动补跑——距上次成功 >20h 且在
 *      工作时段（8:00-19:00）立即补一次（防周末/关机错过）
 * 串行化铁律：enqueueSalesTask 只加最外层（调度 tick / 启动补跑 / IPC runNow），
 * executeAutoBackup 内部不再 enqueue。
 */
import { crmDbService } from './crmDbService'
import { salesDbService } from './salesDbService'
import { enqueueSalesTask } from './salesQueue'
import type { ConfigService } from './config'
import {
  AUTO_BACKUP_KEEP,
  autoBackupLocalRoot,
  readLatestManifest,
  runAutoBackup,
  type AutoBackupManifest,
  type AutoBackupResult
} from './autoBackupCore'

export const AUTO_BACKUP_DEFAULT_TIME = '14:37'
/** 启动补跑阈值：距上次成功超过 20h */
const CATCHUP_STALE_MS = 20 * 60 * 60 * 1000
/** 工作时段 8:00-19:00（补跑只在该窗口内触发，深夜开机不跑） */
const WORK_START_HOUR = 8
const WORK_END_HOUR = 19
/** 调度 tick 间隔（同周复盘定时器 30min 先例，缩短到 5min 保证到点及时触发） */
const TICK_MS = 5 * 60 * 1000

export interface AutoBackupDeps {
  config: ConfigService
  userData: string
  appVersion: string
}

let deps: AutoBackupDeps | null = null
let tickTimer: NodeJS.Timeout | null = null
let bootTimer: NodeJS.Timeout | null = null
/** 防止 tick 与补跑/手动并发重入（enqueue 串行化之外的双保险） */
let running = false

/** 解析 autoBackupTime 'HH:mm'，非法值回退默认 14:37 */
export function parseAutoBackupTime(raw: unknown): { hh: number; mm: number } {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(raw || '').trim())
  if (!m) {
    const d = /^(\d+):(\d+)$/.exec(AUTO_BACKUP_DEFAULT_TIME)!
    return { hh: Number(d[1]), mm: Number(d[2]) }
  }
  return { hh: Number(m[1]), mm: Number(m[2]) }
}

/** 最近一次成功备份时间（本机层最新 manifest 的 createdAt；无备份返回 0） */
export function lastAutoBackupSuccessAt(userData: string): number {
  const m = readLatestManifest(autoBackupLocalRoot(userData))
  const t = m ? Date.parse(m.createdAt) : NaN
  return Number.isFinite(t) ? t : 0
}

/**
 * 执行一次自动备份（同步 core + 落盘 + 审计）。不 enqueue——由最外层入口串行化。
 * 失败也写审计；任何异常收进返回值，不抛出（调度器/IPC 都不该被炸）。
 */
export function executeAutoBackup(trigger: 'scheduled' | 'startup-catchup' | 'manual'): AutoBackupResult {
  if (!deps) return { ok: false, dirName: '', manifest: {} as AutoBackupManifest, error: 'autoBackupService 未初始化' }
  const t0 = Date.now()
  // ① 备份前强制落盘（sql.js 内存库 500ms 防抖，见文件头注释）
  try { crmDbService.persistNow() } catch (e) { console.warn('[AutoBackup] crm 落盘失败:', e) }
  try { salesDbService.flushNow() } catch (e) { console.warn('[AutoBackup] sales 落盘失败:', e) }

  let result: AutoBackupResult
  try {
    result = runAutoBackup({
      userData: deps.userData,
      networkPath: deps.config.get('autoBackupNetworkPath'),
      appVersion: deps.appVersion,
      trigger
    })
  } catch (e) {
    result = { ok: false, dirName: '', manifest: {} as AutoBackupManifest, error: String(e) }
  }

  // ② 审计留痕（成功/失败都写；审计失败不阻塞备份本体）
  try {
    const m = result.manifest
    crmDbService.create('audit_event', {
      actor: 'system:auto-backup',
      action: 'auto_backup',
      entity_type: 'backup',
      entity_id: 0,
      detail: JSON.stringify({
        trigger,
        ok: result.ok,
        dir: result.dirName || undefined,
        local: m?.layers?.local?.status,
        network: m?.layers?.network?.status,
        files: m?.files?.map((f) => `${f.name}:${f.size}`),
        pruned: { local: m?.layers?.local?.pruned?.length || 0, network: m?.layers?.network?.pruned?.length || 0 },
        durationMs: m?.durationMs,
        error: result.error || m?.layers?.local?.error || undefined
      }),
      created_at: t0
    })
  } catch (e) {
    console.warn('[AutoBackup] 审计写入失败:', e)
  }

  if (result.ok) {
    console.log(`[AutoBackup] ${trigger} 备份完成：${result.dirName}（本机 ${result.manifest.layers.local.status} / 网络 ${result.manifest.layers.network.status}，${result.manifest.durationMs}ms）`)
  } else {
    console.warn(`[AutoBackup] ${trigger} 备份失败:`, result.error || result.manifest?.layers?.local?.error)
  }
  return result
}

/** 外层入口统一包装：串行化 + 防重入（调度 tick / 启动补跑 / IPC runNow 共用） */
function runGuarded(trigger: 'scheduled' | 'startup-catchup' | 'manual'): Promise<AutoBackupResult> {
  if (running) return Promise.resolve({ ok: false, dirName: '', manifest: {} as AutoBackupManifest, error: '已有备份任务在执行' })
  running = true
  return enqueueSalesTask(async () => executeAutoBackup(trigger))
    .finally(() => { running = false })
}

/** 手动「立即备份」（IPC 最外层入口） */
export function runAutoBackupNow(): Promise<AutoBackupResult> {
  return runGuarded('manual')
}

// ─── 状态查询（IPC backup:auto:status 数据源）─────────────────────────────

export interface AutoBackupStatus {
  configuredTime: string
  networkPath: string
  /** 最近一次备份（本机层最新 manifest 摘要；从未备份为 null） */
  last: {
    at: string
    trigger: string
    dirName: string
    local: string
    network: string
    files: Array<{ kind: string; name: string; size: number }>
    durationMs: number
  } | null
  /** 下一次计划执行时间（ISO；按 configuredTime 推算） */
  nextPlannedAt: string | null
}

export function getAutoBackupStatus(): AutoBackupStatus {
  if (!deps) return { configuredTime: AUTO_BACKUP_DEFAULT_TIME, networkPath: '', last: null, nextPlannedAt: null }
  const timeRaw = String(deps.config.get('autoBackupTime') || AUTO_BACKUP_DEFAULT_TIME)
  const { hh, mm } = parseAutoBackupTime(timeRaw)
  const lastManifest = readLatestManifest(autoBackupLocalRoot(deps.userData))

  const now = new Date()
  const next = new Date(now)
  next.setHours(hh, mm, 0, 0)
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1)

  return {
    configuredTime: `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`,
    networkPath: String(deps.config.get('autoBackupNetworkPath') || ''),
    last: lastManifest
      ? {
          at: lastManifest.createdAt,
          trigger: lastManifest.trigger,
          dirName: backupDirNameFromManifest(lastManifest),
          local: lastManifest.layers.local.status,
          network: lastManifest.layers.network.status,
          files: lastManifest.files,
          durationMs: lastManifest.durationMs
        }
      : null,
    nextPlannedAt: next.toISOString()
  }
}

function backupDirNameFromManifest(m: AutoBackupManifest): string {
  const d = new Date(m.createdAt)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `we-flow-auto-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}

// ─── 调度器 ────────────────────────────────────────────────────────────────

/** 启动补跑：距上次成功 >20h 且当前在工作时段（8:00-19:00）→ 立即补跑一次 */
function maybeCatchUp(): void {
  if (!deps) return
  const now = Date.now()
  const hour = new Date(now).getHours()
  const last = lastAutoBackupSuccessAt(deps.userData)
  if (now - last > CATCHUP_STALE_MS && hour >= WORK_START_HOUR && hour < WORK_END_HOUR) {
    console.log(`[AutoBackup] 距上次备份 ${Math.round((now - last) / 3600000)}h，工作时段内补跑`)
    void runGuarded('startup-catchup')
  }
}

/** 每日到点检查：now >= 今日计划时刻 且 上次成功 < 今日计划时刻 → 跑 */
function tick(): void {
  if (!deps) return
  const now = new Date()
  const { hh, mm } = parseAutoBackupTime(deps.config.get('autoBackupTime'))
  const scheduled = new Date(now)
  scheduled.setHours(hh, mm, 0, 0)
  if (now.getTime() >= scheduled.getTime() && lastAutoBackupSuccessAt(deps.userData) < scheduled.getTime()) {
    void runGuarded('scheduled')
  }
}

/**
 * 注入依赖（幂等赋值）。main.ts 走 startAutoBackupScheduler（内含本调用）；
 * 测试脚本（scripts/auto-backup-test.ts）只需执行入口、不要定时器时直接调本函数。
 */
export function initAutoBackup(d: AutoBackupDeps): void {
  deps = d
}

/**
 * 启动自动备份调度器（main.ts 启动链路调用，放 SLA 存量处置之后）。
 * 幂等：重复调用直接返回。
 */
export function startAutoBackupScheduler(d: AutoBackupDeps): void {
  if (tickTimer) return
  initAutoBackup(d)
  // 启动补跑延迟 10s：让启动链路（迁移/扫描/落盘）先收尾，避免与预热争抢
  bootTimer = setTimeout(() => { try { maybeCatchUp() } catch (e) { console.warn('[AutoBackup] 启动补跑检查失败:', e) } }, 10 * 1000)
  if (bootTimer.unref) bootTimer.unref()
  tickTimer = setInterval(() => { try { tick() } catch (e) { console.warn('[AutoBackup] 定时检查失败:', e) } }, TICK_MS)
  if (tickTimer.unref) tickTimer.unref()
  console.log(`[AutoBackup] 调度器已启动（每日 ${String(d.config.get('autoBackupTime') || AUTO_BACKUP_DEFAULT_TIME)}，保留 ${AUTO_BACKUP_KEEP} 份）`)
}

export function stopAutoBackupScheduler(): void {
  if (bootTimer) { clearTimeout(bootTimer); bootTimer = null }
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null }
}
