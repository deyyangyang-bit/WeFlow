/**
 * exportPathAuthorizer.ts —— 「用户批准导出路径」统一校验（H3/P1b，可单测纯模块）
 *
 * 信任模型：**只有经 Electron 原生 dialog 批准的路径**才可作为导出目标。三类授权来源：
 *   ① 会话授权（内存）：本次进程内 dialog 返回的目录/文件（文件授权重启即失效）；
 *   ② 持久授权根（主进程托管存储）：目录对话框批准的导出根目录，重启后恢复——
 *      恢复时与每次使用前都重新验证：必须仍存在、是真实目录、不是符号链接、
 *      realpath 与批准时一致（被替换/删除/失效 → 授权作废，要求重新选择）；
 *   ③ 内置授权根：系统 Downloads（明确的内置目录，使首次默认导出可用）。
 * 通用 config 里的 exportPath **不构成授权**（只作 UI 展示的偏好值）；自动化导出只能落在
 * 持久授权根 / 内置根（或本会话新批准的目录）。resolve + 带 sep 前缀比较防 ../ 与前缀碰撞。
 * 存储钩子（loadRoots/saveRoots）与内置根由 main.ts 注入，模块本身零 Electron 依赖。
 */
import { lstatSync, realpathSync, statSync } from 'fs'
import { dirname, isAbsolute, resolve, sep } from 'path'

export type GrantKind = 'file' | 'dir'

export interface GrantEntry {
  kind: GrantKind
  /** 授权时刻的 realpath（目录）或最近存在祖先的 realpath（文件） */
  realPath: string
  grantedAt: number
}

export interface PersistedRoot {
  /** 批准时刻的 realpath；恢复时重新验证仍解析到同一路径 */
  realPath: string
  /** 展示/比对用原始路径 */
  path: string
  grantedAt: number
}

const MAX_GRANTS = 200
const GRANT_TTL_MS = 24 * 3600 * 1000

/** 最深存在祖先的 realpath：目标不存在时逐级向上找第一个存在节点解析 */
export function deepestExistingRealPath(target: string): string | null {
  let probe = resolve(target)
  for (;;) {
    try {
      return realpathSync(probe)
    } catch {
      const parent = dirname(probe)
      if (parent === probe) return null
      probe = parent
    }
  }
}

/** 路径必须以 root + sep 开头（或恰好等于 root）：防前缀碰撞 */
function isWithinRoot(root: string, target: string): boolean {
  return target === root || target.startsWith(root + sep)
}

export interface AuthorizerPersistence {
  loadRoots?: () => PersistedRoot[]
  saveRoots?: (roots: PersistedRoot[]) => void
  /** 内置授权根（如系统 Downloads），每次校验时取最新值 */
  builtinRoots?: () => string[]
}

/** 单个持久根的当下有效性：存在 + 真实目录 + 非符号链接 + realpath 与批准时一致 */
export function validatePersistedRoot(root: PersistedRoot): boolean {
  try {
    if (lstatSync(root.path).isSymbolicLink()) return false
    if (!statSync(root.path).isDirectory()) return false
    return realpathSync(root.path) === root.realPath
  } catch {
    return false
  }
}

export class ExportPathAuthorizer {
  private grants = new Map<string, GrantEntry>()
  private persistence: AuthorizerPersistence = {}

  /** main.ts 注入存储钩子与内置根（纯测试环境可不注入） */
  configure(persistence: AuthorizerPersistence): void {
    this.persistence = persistence
  }

  /** 登记一条「用户经原生对话框批准」的路径；kind 缺省按文件系统现状判定。
   *  opts.persist=true 时目录授权同时写入主进程托管存储（导出根目录场景）。 */
  grant(path: string, kind?: GrantKind, opts?: { persist?: boolean }): GrantEntry | null {
    const trimmed = String(path || '').trim()
    if (!trimmed || !isAbsolute(trimmed)) return null
    let kindResolved = kind
    if (!kindResolved) {
      try { kindResolved = statSync(trimmed).isDirectory() ? 'dir' : 'file' } catch { kindResolved = 'file' }
    }
    const real = deepestExistingRealPath(trimmed)
    if (!real) return null
    const entry: GrantEntry = { kind: kindResolved, realPath: real, grantedAt: Date.now() }
    this.grants.set(resolve(trimmed), entry)
    this.evict()
    if (opts?.persist && kindResolved === 'dir') {
      this.persistRoot(trimmed)
    }
    return entry
  }

  /** 把目录升级为持久授权根（要求本会话内已被 dialog grant），成功返回根条目 */
  persistRoot(path: string): PersistedRoot | null {
    const trimmed = String(path || '').trim()
    const resolved = resolve(trimmed)
    const entry = this.grants.get(resolved)
    if (!entry || entry.kind !== 'dir') return null
    const roots = this.loadRootsValid()
    if (!roots.some((r) => r.realPath === entry.realPath)) {
      roots.push({ realPath: entry.realPath, path: resolved, grantedAt: Date.now() })
      this.persistence.saveRoots?.(roots)
    }
    return { realPath: entry.realPath, path: resolved, grantedAt: entry.grantedAt }
  }

  private loadRootsValid(): PersistedRoot[] {
    const raw = this.persistence.loadRoots?.() || []
    // 恢复/读取时即剔除失效根（被替换/删除/symlink 化）——失效根不再提供授权
    return raw.filter(validatePersistedRoot)
  }

  /** 供测试/启动诊断：当前有效的持久根（失效项已被剔除，不回写存储） */
  persistedRootsValid(): PersistedRoot[] {
    return this.loadRootsValid()
  }

  private evict(): void {
    const now = Date.now()
    for (const [key, g] of this.grants) {
      if (now - g.grantedAt > GRANT_TTL_MS) this.grants.delete(key)
    }
    while (this.grants.size > MAX_GRANTS) {
      const oldest = [...this.grants.entries()].sort((a, b) => a[1].grantedAt - b[1].grantedAt)[0]
      if (!oldest) break
      this.grants.delete(oldest[0])
    }
  }

  grantsForTest(): Array<{ path: string; kind: GrantKind; grantedAt: number }> {
    return [...this.grants.entries()].map(([path, g]) => ({ path, kind: g.kind, grantedAt: g.grantedAt }))
  }

  /** 校验 targetPath 可作为 expect 类型的导出目标；不合法返回具体原因（不抛错，供调用方决定语义） */
  check(targetPath: string, expect: GrantKind): { ok: true } | { ok: false; reason: string } {
    const trimmed = String(targetPath || '').trim()
    if (!trimmed || !isAbsolute(trimmed)) return { ok: false, reason: '导出路径为空或不是绝对路径' }
    const resolved = resolve(trimmed)
    // 目标若已存在且是符号链接 → 直接拒绝（不跟随）
    try { if (lstatSync(resolved).isSymbolicLink()) return { ok: false, reason: '导出目标不能是符号链接' } } catch { /* 尚不存在，走祖先校验 */ }
    const now = Date.now()
    const targetReal = deepestExistingRealPath(resolved)
    if (!targetReal) return { ok: false, reason: '导出路径无法解析（祖先目录缺失或链接断裂）' }
    // ① 会话授权
    for (const [grantedPath, g] of this.grants) {
      if (now - g.grantedAt > GRANT_TTL_MS) continue
      if (g.kind === 'dir') {
        if (isWithinRoot(g.realPath, targetReal)) return { ok: true }
      } else if (resolved === resolve(grantedPath) && targetReal === g.realPath) {
        return { ok: true }
      }
    }
    // ② 持久授权根（当下重新验证有效性）
    for (const root of this.loadRootsValid()) {
      if (isWithinRoot(root.realPath, targetReal)) return { ok: true }
    }
    // ③ 内置授权根（如系统 Downloads）
    for (const builtin of this.persistence.builtinRoots?.() || []) {
      try {
        const real = realpathSync(builtin)
        if (isWithinRoot(real, targetReal)) return { ok: true }
      } catch { /* 内置根不可用时跳过 */ }
    }
    return { ok: false, reason: '导出路径未经过本会话授权，请重新通过文件对话框选择' }
  }

  /** 导出 IPC 入口统一调用：不合法直接抛错（在真正写文件前拦截） */
  assertAllowed(targetPath: string, expect: GrantKind): void {
    const result = this.check(targetPath, expect)
    if (!result.ok) throw new Error(result.reason)
  }
}

/** 进程级单例：dialog 处理器与导出 IPC 共用；main.ts 启动时 configure 注入持久化与内置根 */
export const exportPathAuthorizer = new ExportPathAuthorizer()
