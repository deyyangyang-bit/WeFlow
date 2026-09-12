/**
 * businessDbPath.ts
 * 微信号分库（§2.40）：业务库文件按当前微信号隔离。
 * 纯 fs/path，无 Electron 依赖，可单测（scripts/account-db-isolation-test.ts）。
 *
 * 命名：weflow-crm-<wxid>.db / weflow-sales-<wxid>.db；
 *       wxid 清洗 [^A-Za-z0-9_-] → '-'；空 wxid（未完成引导）回退 legacy 名
 *       （weflow-crm.db / weflow-sales.db，兼容现有测试与初始化顺序）。
 * 迁移：升级后首次启动把 legacy 单库整文件改名到当前账号 suffixed 库（零改写）。
 */
import { existsSync, readdirSync, renameSync, statSync } from 'fs'
import { join } from 'path'

export type BusinessDbKind = 'crm' | 'sales'

export interface DiscoveredBusinessDb {
  kind: BusinessDbKind
  path: string
  name: string
  /** legacy 单库为 null；分库为文件名中已清洗的 wxid。仅用于生成安全标识，不写入 manifest。 */
  wxid: string | null
}

const LEGACY_NAMES: Record<BusinessDbKind, string> = {
  crm: 'weflow-crm.db',
  sales: 'weflow-sales.db'
}

const DB_BASES: Record<BusinessDbKind, string> = {
  crm: 'weflow-crm',
  sales: 'weflow-sales'
}

/** wxid 清洗：仅保留字母/数字/下划线/连字符，其余替换为 '-'；空值原样返回（回退 legacy 名） */
export function sanitizeWxidForDbName(wxid: string | null | undefined): string {
  const raw = String(wxid ?? '').trim()
  if (!raw) return ''
  return raw.replace(/[^A-Za-z0-9_-]/g, '-')
}

/** 业务库文件名。wxid 空 → legacy 名 */
export function businessDbName(wxid: string | null | undefined, kind: BusinessDbKind): string {
  const clean = sanitizeWxidForDbName(wxid)
  return clean ? `${DB_BASES[kind]}-${clean}.db` : LEGACY_NAMES[kind]
}

/** 业务库绝对路径 */
export function businessDbPath(userDataPath: string, wxid: string | null | undefined, kind: BusinessDbKind): string {
  return join(userDataPath, businessDbName(wxid, kind))
}

/**
 * legacy 单库 → 按账号 suffixed 库一次性迁移（整文件改名，零改写风险）。
 * 规则：wxid 非空 && suffixed 不存在 && legacy 存在 → renameSync；
 *       两者共存不动（不重复迁移、不覆盖）。幂等：二次调用无迁移。
 * 返回本次发生迁移的列表（无迁移返回空数组）。
 */
export function migrateLegacyBusinessDbs(
  userDataPath: string,
  wxid: string | null | undefined
): Array<{ kind: BusinessDbKind; from: string; to: string }> {
  const clean = sanitizeWxidForDbName(wxid)
  if (!clean || !userDataPath) return []
  const moved: Array<{ kind: BusinessDbKind; from: string; to: string }> = []
  for (const kind of ['crm', 'sales'] as const) {
    const from = join(userDataPath, LEGACY_NAMES[kind])
    const to = join(userDataPath, `${DB_BASES[kind]}-${clean}.db`)
    if (existsSync(to) || !existsSync(from)) continue
    try {
      renameSync(from, to)
      moved.push({ kind, from, to })
    } catch (e) {
      console.error(`[BusinessDbPath] ${LEGACY_NAMES[kind]} 迁移失败:`, e)
    }
  }
  return moved
}

/**
 * 定位现存的业务库文件（真实库只读脚本用，如 payments-claim-test / p0-3-closed-gate）：
 * 按账号 suffixed 优先（多个账号库取 mtime 最新 = 最近使用的当前账号），回退 legacy 名；
 * 排除 .archived 归档件。只做 existsSync/readdirSync，零写入。都不存在返回 null。
 */
export function findExistingBusinessDb(userDataPath: string, kind: BusinessDbKind): string | null {
  if (!userDataPath) return null
  const legacy = join(userDataPath, LEGACY_NAMES[kind])
  let best: { path: string; mtimeMs: number } | null = null
  try {
    for (const entry of readdirSync(userDataPath)) {
      if (!entry.startsWith(`${DB_BASES[kind]}-`) || !entry.endsWith('.db')) continue
      if (entry.includes('.archived-')) continue
      const p = join(userDataPath, entry)
      const mtimeMs = statSync(p).mtimeMs
      if (!best || mtimeMs > best.mtimeMs) best = { path: p, mtimeMs }
    }
  } catch { /* 目录不可读按无 suffixed 处理，走 legacy 回退 */ }
  if (best) return best.path
  return existsSync(legacy) ? legacy : null
}

/**
 * 枚举全部业务库：legacy 双库 + 所有账号分库。排除归档、损坏留证和临时文件。
 * 返回按文件名稳定排序的普通文件，供自动备份一次性覆盖所有账号。
 */
export function discoverBusinessDbs(userDataPath: string): DiscoveredBusinessDb[] {
  if (!userDataPath) return []
  const rows: DiscoveredBusinessDb[] = []
  let names: string[] = []
  try { names = readdirSync(userDataPath) } catch { return [] }
  for (const name of names.sort()) {
    let kind: BusinessDbKind | null = null
    let wxid: string | null = null
    if (name === LEGACY_NAMES.crm) kind = 'crm'
    else if (name === LEGACY_NAMES.sales) kind = 'sales'
    else {
      const match = /^weflow-(crm|sales)-([A-Za-z0-9_-]+)\.db$/.exec(name)
      if (!match) continue
      kind = match[1] as BusinessDbKind
      wxid = match[2]
    }
    const path = join(userDataPath, name)
    try {
      if (!statSync(path).isFile()) continue
      rows.push({ kind, path, name, wxid })
    } catch { /* 文件在枚举期间消失则跳过 */ }
  }
  return rows
}

/** 归档文件时间戳后缀：yyyyMMdd-HHmmss（本地时间） */
export function archiveStampOf(date: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
}

/** 归档文件名：<原名>.archived-<yyyyMMdd-HHmmss>.db */
export function archivedDbName(originalName: string, at: Date): string {
  return `${originalName}.archived-${archiveStampOf(at)}.db`
}
