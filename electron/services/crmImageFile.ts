/**
 * crmImageFile.ts —— CRM 图片文件读写安全校验（可单测纯模块，不依赖 Electron）
 *
 * 背景（H1）：crm:file:readImage / crm:file:saveImage 此前接受渲染层传入的任意路径，
 * 只查 existsSync 就读文件 —— 任意文件读取。本模块收口：
 *   ① 路径闸门：目标必须严格位于 userData/crm-images 内（resolve + 前缀含 sep 防前缀碰撞，
 *      最深存在祖先的 realpath 防符号链接逃逸与 ../）；
 *   ② 常规文件闸门：lstat 必须 isFile（符号链接/目录/FIFO 一律拒绝）；
 *   ③ 内容闸门：MIME 由 magic bytes 判定（JPEG/PNG/WebP），不信任扩展名；
 *   ④ 文件名清洗：saveImage 的文件名清洗后不得为空，且最终目标同样过路径闸门。
 * 校验失败一律返回「目标不存在」同款安全结果（''），不泄露目标是否存在。
 */
import { lstatSync, realpathSync } from 'fs'
import { dirname, isAbsolute, join, resolve, sep } from 'path'

export const CRM_IMAGES_DIR_NAME = 'crm-images'

export function crmImagesRoot(userDataDir: string): string {
  return join(userDataDir, CRM_IMAGES_DIR_NAME)
}

export type PathCheck = { ok: true; path: string } | { ok: false; reason: string }

/** 最深存在祖先的 realpath：目标不存在时逐级向上找第一个存在节点解析（macOS /tmp → /private/tmp 等场景） */
function deepestExistingRealPath(target: string): string | null {
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

/**
 * 解析 target 并验证其严格位于 root 真径内（含符号链接逃逸检查）。
 * - 全程用 **realpath** 比较：root 先取真径，目标（不存在时取最近存在祖先）也取真径；
 * - 目标本身是符号链接时，其真径落点必须在 root 内，否则拒绝（逃逸）；
 * - 前缀比较带 sep，防 /x/crm-images 与 /x/crm-images-evil 碰撞。
 * 返回的 path 是原始解析路径（调用方用它读写；真径一致性已由本闸门保证）。
 */
export function resolveInsideRoot(root: string, target: string): PathCheck {
  if (!root || typeof target !== 'string' || !target.trim()) return { ok: false, reason: 'empty path' }
  let rootReal: string
  try {
    rootReal = realpathSync(root)
  } catch {
    return { ok: false, reason: 'root missing' }
  }
  const abs = isAbsolute(target) ? target : join(rootReal, target)
  const resolved = resolve(abs)
  const targetReal = deepestExistingRealPath(resolved)
  if (!targetReal) return { ok: false, reason: 'unresolvable' }
  if (targetReal !== rootReal && !targetReal.startsWith(rootReal + sep)) {
    return { ok: false, reason: 'outside root or symlink escape' }
  }
  return { ok: true, path: resolved }
}

/** 常规文件判定：lstat（不跟随末段符号链接）——链接本身、目录、设备文件一律不算 */
export function isRegularFile(p: string): boolean {
  try {
    return lstatSync(p).isFile()
  } catch {
    return false
  }
}

/** 按 magic bytes 判定受支持的图片 MIME；不认识返回 null（调用方拒绝读取） */
export function detectImageMime(buf: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (!buf || buf.length < 12) return null
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) return 'image/png'
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp'
  return null
}

/**
 * saveImage 文件名清洗：取 basename、剥路径分隔与控制字符，只留 [\w.\-]。
 * 清洗后为空返回 ''（调用方必须用非空回退，不得把空名拼进目标路径）。
 */
export function sanitizeImageFileName(name: string): string {
  const base = String(name || '').split(/[\\/]/).pop() || ''
  const cleaned = base.replace(/[^\w.\-]/g, '_').replace(/^[._]+/, '').trim()
  return cleaned
}
