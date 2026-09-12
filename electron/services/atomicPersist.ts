/**
 * atomicPersist.ts —— sql.js 业务库「原子落盘 + 启动守卫」（HANDOVER §2.52 事故修复）
 *
 * 事故根因（2026-09-03/04 两次实证）：sql.js 是内存库，旧 persist 用 writeFileSync 直写
 * 目标文件——先截断为 0 再整体写入；窗口期被 kill/崩溃 → 磁盘 0 字节 → 下次启动静默
 * 初始化空库 → 后续 persist 把空库写回 → 数据全灭且无人察觉。
 *
 * 本模块两条防线：
 *   ① atomicWriteFileSync：写 `目标.tmp-<pid>` → fsync → renameSync 原子替换目标
 *      （POSIX rename 原子性）。任何时刻目标文件要么旧版完整、要么新版完整，
 *      绝不出现 0 字节/半截中间态。所有写 .db 的落盘点必须走它（铁律）。
 *   ② loadBusinessDbWithGuard：启动打开 db 前的守卫——文件存在但 0 字节或打开/解析失败
 *      时⛔禁止静默初始化空库：坏文件改名 `<原名>.corrupt-<时间戳>` 留证（绝不覆盖已有留证）
 *      → 从最新 `backups/auto/we-flow-auto-*` 快照恢复同名文件（manifest.json 校验 size，
 *      不可解析/不一致的备份跳过）→ 恢复件必须能被 sql.js 打开才算数，否则试更早快照；
 *      全部无可用备份才允许空库启动，并打 ERROR 日志「从空库启动，原文件已损坏」。
 *
 * 零 electron 依赖（sql.js 仅用类型、构造器由调用方传入），可 tsx 单测
 * （scripts/persist-guard-test.ts）。
 */
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync,
  readFileSync, renameSync, rmSync, statSync, writeFileSync
} from 'fs'
import { basename, dirname, join } from 'path'
import type { Database as SqlJsDatabase } from 'sql.js'
import initSqlJs from 'sql.js'
import { archiveStampOf } from './businessDbPath'
import { salesLog } from './salesLogger'
import { autoBackupLocalRoot, listBackupDirs, type AutoBackupManifest } from './autoBackupCore'

/** sql.js 构造器类型（其 d.ts 未导出 SqlJsStatic 具名类型，从默认导出推导） */
type SqlJsStaticType = Awaited<ReturnType<typeof initSqlJs>>

export type GuardLogLevel = 'INFO' | 'WARN' | 'ERROR'
export type GuardLogger = (level: GuardLogLevel, message: string) => void

/**
 * §2.52 启动守卫日志桥：落盘 salesLog（打包可见）+ console（dev 可见）。
 * 各业务库 service 统一复用本实现，勿再各自复制一份。
 */
export function dbGuardLog(level: GuardLogLevel, msg: string): void {
  salesLog(level, msg)
  if (level === 'ERROR') console.error(msg)
  else console.warn(msg)
}

/** 默认日志：走 console（service 层会注入 salesLog 桥接，测试注入收集器） */
const defaultLog: GuardLogger = (level, message) => {
  if (level === 'ERROR') console.error(message)
  else if (level === 'WARN') console.warn(message)
  else console.log(message)
}

/**
 * 原子写文件：tmp（同目录，保证同文件系统 rename 原子）→ fsync → rename 替换目标。
 * 失败时清理 tmp 残留并把原始错误抛给调用方（调用方按既有风格 catch 打日志）。
 */
export function atomicWriteFileSync(targetPath: string, data: Uint8Array): void {
  const dir = dirname(targetPath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const tmp = `${targetPath}.tmp-${process.pid}`
  try {
    writeFileSync(tmp, data)
    const fd = openSync(tmp, 'r')
    try { fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(tmp, targetPath)
  } catch (e) {
    try { rmSync(tmp, { force: true }) } catch { /* 清理失败不遮蔽原始错误 */ }
    throw e
  }
}

/**
 * 坏文件留证：整文件改名 `<原名>.corrupt-<yyyyMMdd-HHmmss>`，返回新路径。
 * 同名留证已存在时追加毫秒后缀——⛔ 留证绝不覆盖（事故现场可能有多份）。
 * 文件不存在返回 null；改名失败打日志返回 null（不抛错，由调用方继续走恢复/空库路径）。
 */
export function quarantineCorruptDbFile(dbPath: string, at: Date = new Date()): string | null {
  if (!existsSync(dbPath)) return null
  let to = `${dbPath}.corrupt-${archiveStampOf(at)}`
  if (existsSync(to)) to = `${to}-${Date.now()}`
  try {
    renameSync(dbPath, to)
    return to
  } catch (e) {
    console.error(`[AtomicPersist] 损坏文件留证改名失败 ${dbPath}:`, e)
    return null
  }
}

/**
 * 枚举可用自动备份（最新 → 最旧）：同名文件存在、size>0、且 manifest.json 可解析、
 * files 条目 size 与实际一致才认；任一不满足跳过该份（含 9/3 那种「备份只备到空壳」之外
 * 的半截写入场景）。
 */
function* autoBackupCandidates(dbPath: string, userData: string, log: GuardLogger): Generator<string> {
  const root = autoBackupLocalRoot(userData)
  const name = basename(dbPath)
  const dirs = listBackupDirs(root) // 升序 = 最旧在前
  for (let i = dirs.length - 1; i >= 0; i--) {
    const dir = join(root, dirs[i])
    const file = join(dir, name)
    if (!existsSync(file)) continue
    let size = 0
    try { size = statSync(file).size } catch { continue }
    if (size <= 0) {
      log('WARN', `[AtomicPersist] 备份 ${dirs[i]} 的 ${name} 为 0 字节，跳过`)
      continue
    }
    let manifest: AutoBackupManifest | null = null
    try {
      manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf-8')) as AutoBackupManifest
    } catch { manifest = null }
    if (!manifest) {
      log('WARN', `[AtomicPersist] 备份 ${dirs[i]} manifest.json 缺失/损坏，跳过`)
      continue
    }
    const entry = (manifest.files || []).find((f) => f.name === name)
    if (!entry) {
      log('WARN', `[AtomicPersist] 备份 ${dirs[i]} manifest 无 ${name} 条目，跳过`)
      continue
    }
    if (entry.size !== size) {
      log('WARN', `[AtomicPersist] 备份 ${dirs[i]} manifest 登记 ${entry.size}B ≠ 实际 ${size}B（疑似半截副本），跳过`)
      continue
    }
    yield file
  }
}

export type GuardedOpenOutcome = 'existing' | 'fresh' | 'restored' | 'fresh-corrupt'

export interface GuardedDbOpen {
  db: SqlJsDatabase
  outcome: GuardedOpenOutcome
  /** 坏文件留证路径（留证失败/未发生为 undefined） */
  corruptPath?: string
  /** 恢复来源备份文件绝对路径 */
  restoredFrom?: string
}

/**
 * 打开并做最小解析验证：sql.js 构造器对坏文件是惰性的（new Database 不抛、首条语句才抛
 * 「file is not a database」），必须实跑一条 sqlite_master 探测才算「能打开」。
 */
function openVerified(SQL: SqlJsStaticType, buffer: Buffer): SqlJsDatabase {
  const db = new SQL.Database(buffer)
  try {
    db.exec('SELECT count(*) FROM sqlite_master')
  } catch (e) {
    try { db.close() } catch { /* ignore */ }
    throw e
  }
  return db
}

/**
 * 带启动守卫地打开业务库。返回已打开的 sql.js Database 与处置结果：
 *   existing      文件健康，正常加载
 *   fresh         文件本来就不存在（新装/新账号分库），正常空库
 *   restored      原文件损坏 → 留证 → 已从自动备份恢复（调用方补 WARN/audit）
 *   fresh-corrupt 原文件损坏且无可用备份 → 空库启动（本函数已打 ERROR，调用方不得再静默）
 */
export function loadBusinessDbWithGuard(
  SQL: SqlJsStaticType,
  dbPath: string,
  userData: string,
  label: string,
  log: GuardLogger = defaultLog
): GuardedDbOpen {
  if (!existsSync(dbPath)) return { db: new SQL.Database(), outcome: 'fresh' }

  let size = 0
  try { size = statSync(dbPath).size } catch { /* 按损坏处理 */ }
  if (size > 0) {
    try {
      return { db: openVerified(SQL, readFileSync(dbPath)), outcome: 'existing' }
    } catch (e) {
      log('ERROR', `${label} 数据库文件打开/解析失败（${dbPath}，${size}B）：${String(e)}——⛔ 禁止静默初始化空库`)
    }
  } else {
    log('ERROR', `${label} 数据库文件为 0 字节（${dbPath}，疑似 persist 截断窗口期被 kill/崩溃）——⛔ 禁止静默初始化空库`)
  }

  // 留证（绝不覆盖已有 .corrupt- 文件）
  const corruptPath = quarantineCorruptDbFile(dbPath)
  if (corruptPath) log('WARN', `${label} 损坏文件已改名留证：${corruptPath}`)

  // 从最新自动备份逐级回退恢复；恢复件必须能被 sql.js 实际打开才算数
  for (const cand of autoBackupCandidates(dbPath, userData, log)) {
    try {
      atomicWriteFileSync(dbPath, readFileSync(cand))
      const db = openVerified(SQL, readFileSync(dbPath))
      log('WARN', `${label} 已从自动备份恢复：${cand} → ${dbPath}`)
      return { db, outcome: 'restored', corruptPath: corruptPath ?? undefined, restoredFrom: cand }
    } catch (e) {
      log('WARN', `${label} 备份 ${cand} 恢复/打开失败（${String(e)}），尝试更早快照`)
      try { rmSync(dbPath, { force: true }) } catch { /* ignore */ }
    }
  }

  log('ERROR', `${label} 无可用自动备份可恢复，从空库启动，原文件已损坏（留证：${corruptPath ?? '改名失败，原文件仍在原位'}）`)
  return { db: new SQL.Database(), outcome: 'fresh-corrupt', corruptPath: corruptPath ?? undefined }
}
