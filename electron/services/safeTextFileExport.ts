/**
 * safeTextFileExport.ts —— 通用安全文本导出执行器（S6，单一生产实现）
 *
 * 职责（规格 §6.3）：为 Markdown/CSV 及后续文本类导出提供「叶子名清洗 + 授权 +
 * 独占写 + 大小上限」的单一执行路径；**不复制第二套路径授权逻辑**——授权复用
 * exportPathAuthorizer（main.ts 注入单例；测试可注入假实现）。
 *
 * 安全语义：
 *   - 叶子名策略（唯一入口 sanitizeLeafName）：拒绝绝对路径、`/`/`\` 目录分隔、
 *     NUL、冒号、`..` 段、尾部点/空格、Windows 保留名（CON/PRN/AUX/NUL/COM1-9/
 *     LPT1-9，含带扩展名形态）、超长名——全部拒绝而非静默改写（所见即所选）。
 *   - 写入前先授权（assertAllowed(dirLeaf, 'file')），再独占创建 `wx` + mode 0600，
 *     不覆盖任何已存在文件/符号链接（EEXIST 直接失败）。
 *   - 失败不残留半文件：写错误时关闭句柄并 unlink 本次创建的目标（仅刚创建的）；
 *     本实现不使用临时文件（独占创建一步到位）。
 *   - 大小上限：缺省 10 MB，超限在触碰文件系统前拒绝。
 */
import { closeSync, fstatSync, lstatSync, openSync, unlinkSync, writeSync } from 'fs'
import { join } from 'path'
import { exportPathAuthorizer, type GrantKind } from './exportPathAuthorizer'

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024
const MAX_LEAF_LENGTH = 200

export interface SafeTextExportDeps {
  /** 授权钩子（缺省 = 进程级 exportPathAuthorizer.assertAllowed）；抛错 = 拒绝导出 */
  assertAllowed?: (targetPath: string, expect: GrantKind) => void
  /** 写入窄接口（可注入：测试部分写/失败路径）；语义 = fs.writeSync(fd, buffer, offset, length) */
  write?: (fd: number, buffer: Buffer, offset: number, length: number) => number
  /** 字节核验窄接口（可注入）；语义 = fs.fstatSync(fd).size */
  fstat?: (fd: number) => { size: number }
}

export interface SafeTextFileRequest {
  /** 目标目录（必须绝对路径且经授权） */
  dir: string
  /** 期望叶子文件名（经 sanitizeLeafName 策略校验，不做静默改写） */
  fileName: string
  /** 完整文本内容（UTF-8） */
  content: string
  /** 单文件字节上限；缺省 10 MB */
  maxSizeBytes?: number
}

export type SafeTextFileResult =
  | { ok: true; path: string; bytes: number }
  | { ok: false; code: 'invalid_leaf_name' | 'unauthorized' | 'too_large' | 'exists' | 'write_failed'; message: string }

const WINDOWS_RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`)
])

/**
 * 叶子文件名策略（唯一入口）：合法返回原样叶子名；非法返回 null（调用方拒绝，
 * 绝不静默改写）。拒绝：空、含 `/` 或 `\` 或 NUL 或冒号、`..` 段、尾部点/空格
 * （按原始串判定，trim 不得吞掉该违规）、Windows 保留基名、超长（>200 字符）。
 */
export function sanitizeLeafName(name: string): string | null {
  if (typeof name !== 'string') return null
  if (name === '' || name.length > MAX_LEAF_LENGTH) return null
  if (/[\s.]$/.test(name)) return null // 尾部点/空格（原始串；Windows 语义下不可见丢失）
  const trimmed = name.trim()
  if (trimmed === '') return null
  if (/[/\\\u0000:]/.test(trimmed)) return null
  if (trimmed.includes('..')) return null
  const base = trimmed.split('.')[0]?.toUpperCase() ?? ''
  if (WINDOWS_RESERVED.has(base)) return null
  return trimmed
}

/** 单文件文本导出（唯一生产入口）。绝不覆盖已有文件；失败不残留半文件。 */
export function exportTextFile(req: SafeTextFileRequest, deps: SafeTextExportDeps = {}): SafeTextFileResult {
  const leaf = sanitizeLeafName(req.fileName)
  if (leaf === null) {
    return { ok: false, code: 'invalid_leaf_name', message: '文件名不合法（禁止路径分隔/冒号/保留名/尾部点空格等）' }
  }
  const bytes = Buffer.byteLength(req.content, 'utf8')
  const maxBytes = req.maxSizeBytes ?? DEFAULT_MAX_BYTES
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    return { ok: false, code: 'too_large', message: '导出大小上限配置非法' }
  }
  if (bytes > maxBytes) {
    return { ok: false, code: 'too_large', message: `导出内容超出单文件上限（${maxBytes} 字节）` }
  }
  const targetPath = join(req.dir, leaf)
  try {
    ;(deps.assertAllowed ?? defaultAssertAllowed)(targetPath, 'file')
  } catch (e) {
    return { ok: false, code: 'unauthorized', message: e instanceof Error ? e.message : '导出路径未授权' }
  }  // 目标若是符号链接：显式拒绝（不跟随、不创建）
  try {
    if (lstatSync(targetPath).isSymbolicLink()) {
      return { ok: false, code: 'exists', message: '导出目标不能是符号链接' }
    }
  } catch { /* 尚不存在：正常路径 */ }
  let fd: number | null = null
  let created = false
  const buffer = Buffer.from(req.content, 'utf8')
  const writeFn = deps.write ?? writeSync
  const fstatFn = deps.fstat ?? fstatSync
  try {
    fd = openSync(targetPath, 'wx', 0o600) // 独占创建：已存在（含链接）→ EEXIST
    created = true
    // 完整写循环：writeSync 单次可能部分写入——循环写满全部字节，绝不把部分写当成功
    let written = 0
    while (written < buffer.length) {
      const n = writeFn(fd, buffer, written, buffer.length - written)
      if (!Number.isFinite(n) || n <= 0) throw new Error('写入停滞')
      written += n
    }
    const size = fstatFn(fd).size
    if (size !== bytes) throw new Error('写入字节数与预期不一致') // 落盘字节数必须等于 UTF-8 字节数
    closeSync(fd)
    fd = null
    return { ok: true, path: targetPath, bytes: size }
  } catch (e) {
    if (fd !== null) {
      try { closeSync(fd) } catch { /* 尽力而为 */ }
    }
    const code = (e as { code?: string }).code
    if (created) {
      try { unlinkSync(targetPath) } catch { /* 清理本次创建的半文件；失败不影响结果语义 */ }
    }
    if (code === 'EEXIST') {
      return { ok: false, code: 'exists', message: '同名文件已存在，导出未覆盖（请换目录或删除后重试）' }
    }
    return { ok: false, code: 'write_failed', message: '文件写入失败，已清理未完成文件' }
  }
}

function defaultAssertAllowed(targetPath: string, expect: GrantKind): void {
  exportPathAuthorizer.assertAllowed(targetPath, expect)
}
