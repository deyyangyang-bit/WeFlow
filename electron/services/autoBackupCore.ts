/**
 * autoBackupCore.ts —— 自动备份纯逻辑核心（零 electron 依赖，可 tsx 单测）。
 * 职责：双保险定时备份（PRD 1.1）——
 *   本机层  userData/backups/auto/we-flow-auto-YYYYMMDD-HHmm/（始终执行）
 *   网络层  config.autoBackupNetworkPath 指向的 SMB 挂载目录（空=跳过；不可达=正常情况，
 *           记 skipped_unreachable，不报错不惊扰——对方电脑下班会关机）
 * 每次产出：两个业务 db 文件副本 + manifest.json；每层滚动保留最近 20 份。
 * autoBackupService.ts 仅做 electron 侧的依赖注入（落盘触发 / 审计 / 调度 / IPC）。
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { basename, join } from 'path'
import { findExistingBusinessDb, type BusinessDbKind } from './businessDbPath'

export const AUTO_BACKUP_DIR_PREFIX = 'we-flow-auto-'
export const AUTO_BACKUP_KEEP = 20

export type AutoBackupLayerStatus = 'ok' | 'skipped_not_configured' | 'skipped_unreachable' | 'failed'

export interface AutoBackupLayerResult {
  status: AutoBackupLayerStatus
  /** 本层备份目录绝对路径（ok 时有值） */
  dir?: string
  /** 本层保留策略删除的最旧目录名列表 */
  pruned?: string[]
  error?: string
}

export interface AutoBackupManifest {
  app: string
  /** ISO 时间（本地时区） */
  createdAt: string
  /** 触发来源：scheduled 定时 / startup-catchup 启动补跑 / manual 立即备份 */
  trigger: string
  files: Array<{ kind: BusinessDbKind; name: string; size: number }>
  /** 未找到的业务库（正常不应出现；出现说明该库尚未创建） */
  missing: BusinessDbKind[]
  layers: { local: AutoBackupLayerResult; network: AutoBackupLayerResult }
  durationMs: number
}

export interface AutoBackupOptions {
  userData: string
  /** 网络共享备份目录（SMB 挂载路径）；空 = 跳过网络层 */
  networkPath?: string
  appVersion: string
  trigger?: string
  /** 每层滚动保留份数（默认 20） */
  keep?: number
  /** 测试注入当前时间 */
  now?: Date
}

export interface AutoBackupResult {
  ok: boolean
  dirName: string
  manifest: AutoBackupManifest
  error?: string
}

/** 备份目录名：we-flow-auto-YYYYMMDD-HHmm（本地时间，字典序=时间序） */
export function backupDirName(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${AUTO_BACKUP_DIR_PREFIX}${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}

/** 本机兜底层根目录 */
export function autoBackupLocalRoot(userData: string): string {
  return join(userData, 'backups', 'auto')
}

/** 列出某层根目录下全部自动备份目录名（升序 = 最旧在前）；目录不可读返回 [] */
export function listBackupDirs(root: string): string[] {
  try {
    return readdirSync(root)
      .filter((e) => e.startsWith(AUTO_BACKUP_DIR_PREFIX))
      .sort()
  } catch {
    return []
  }
}

/** 保留策略：滚动留最近 keep 份，超出删最旧。返回被删的目录名列表。 */
export function pruneBackups(root: string, keep: number): string[] {
  const dirs = listBackupDirs(root)
  const excess = dirs.length - keep
  if (excess <= 0) return []
  const removed: string[] = []
  for (const name of dirs.slice(0, excess)) {
    try {
      rmSync(join(root, name), { recursive: true, force: true })
      removed.push(name)
    } catch (e) {
      console.warn(`[AutoBackup] 清理旧备份失败 ${name}:`, e)
    }
  }
  return removed
}

/** 读取某层最新一份备份的 manifest（无备份或解析失败返回 null） */
export function readLatestManifest(root: string): AutoBackupManifest | null {
  const dirs = listBackupDirs(root)
  for (let i = dirs.length - 1; i >= 0; i--) {
    try {
      const raw = readFileSync(join(root, dirs[i], 'manifest.json'), 'utf-8')
      return JSON.parse(raw) as AutoBackupManifest
    } catch { /* 损坏的目录跳过，看上一份 */ }
  }
  return null
}

/** 网络层可达性：路径存在且是目录即视为已挂载可达（SMB 未挂载时 /Volumes/xxx 不存在） */
function networkReachable(networkPath: string): boolean {
  try {
    return statSync(networkPath).isDirectory()
  } catch {
    return false
  }
}

/**
 * 执行一次双保险备份。
 * 调用方负责：① 备份前触发两库落盘（sql.js 内存库 500ms 防抖，见 autoBackupService）；
 *             ② 审计写点；③ 串行化（enqueueSalesTask 最外层）。
 * 不抛异常——任何失败都收进 result/manifest（网络层不可达是正常情况，非失败）。
 */
export function runAutoBackup(opts: AutoBackupOptions): AutoBackupResult {
  const t0 = Date.now()
  const now = opts.now ?? new Date()
  const keep = opts.keep ?? AUTO_BACKUP_KEEP
  const dirName = backupDirName(now)
  const networkPath = String(opts.networkPath || '').trim()

  const manifest: AutoBackupManifest = {
    app: opts.appVersion,
    createdAt: now.toISOString(),
    trigger: opts.trigger || 'scheduled',
    files: [],
    missing: [],
    layers: {
      local: { status: 'failed' },
      network: { status: 'skipped_not_configured' }
    },
    durationMs: 0
  }

  // 定位两个业务库（按账号 suffixed 优先，回退 legacy 名）
  const sources: Array<{ kind: BusinessDbKind; path: string }> = []
  for (const kind of ['crm', 'sales'] as const) {
    const p = findExistingBusinessDb(opts.userData, kind)
    if (p) sources.push({ kind, path: p })
    else manifest.missing.push(kind)
  }
  if (!sources.length) {
    manifest.durationMs = Date.now() - t0
    return { ok: false, dirName, manifest, error: '未找到任何业务库文件' }
  }

  // ── 本机兜底层（始终执行）──
  const localRoot = autoBackupLocalRoot(opts.userData)
  const localDir = join(localRoot, dirName)
  try {
    mkdirSync(localDir, { recursive: true })
    for (const s of sources) {
      copyFileSync(s.path, join(localDir, basename(s.path)))
      manifest.files.push({ kind: s.kind, name: basename(s.path), size: statSync(s.path).size })
    }
    manifest.layers.local = { status: 'ok', dir: localDir }
  } catch (e) {
    manifest.layers.local = { status: 'failed', error: String(e) }
  }

  // ── 网络共享层（空=跳过；不可达=正常跳过，不算失败）──
  if (networkPath) {
    if (!networkReachable(networkPath)) {
      manifest.layers.network = { status: 'skipped_unreachable' }
    } else {
      const netDir = join(networkPath, dirName)
      try {
        mkdirSync(netDir, { recursive: true })
        for (const s of sources) copyFileSync(s.path, join(netDir, basename(s.path)))
        manifest.layers.network = { status: 'ok', dir: netDir }
      } catch (e) {
        // 挂载途中掉线/权限不足等：记 failed 但不影响本机层结果
        manifest.layers.network = { status: 'failed', error: String(e) }
      }
    }
  }

  // manifest 落盘（本机层必写；网络层 ok 时同步一份，保证单层即可独立恢复解读）
  manifest.durationMs = Date.now() - t0
  const manifestJson = JSON.stringify(manifest, null, 2)
  if (manifest.layers.local.status === 'ok') {
    try { writeFileSync(join(localDir, 'manifest.json'), manifestJson) } catch (e) { console.warn('[AutoBackup] 本机 manifest 写入失败:', e) }
  }
  if (manifest.layers.network.status === 'ok' && manifest.layers.network.dir) {
    try { writeFileSync(join(manifest.layers.network.dir, 'manifest.json'), manifestJson) } catch (e) { console.warn('[AutoBackup] 网络 manifest 写入失败:', e) }
  }

  // 保留策略：每层滚动留最近 keep 份（网络层仅本次可达时清理，不可达时不碰）
  if (manifest.layers.local.status === 'ok') manifest.layers.local.pruned = pruneBackups(localRoot, keep)
  if (manifest.layers.network.status === 'ok') manifest.layers.network.pruned = pruneBackups(networkPath, keep)

  // 整体成败只看本机兜底层（网络层 skipped/failed 不惊扰）
  return { ok: manifest.layers.local.status === 'ok', dirName, manifest }
}
