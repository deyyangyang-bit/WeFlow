/**
 * crm-image-file-test.ts —— H1 回归测试：crm:file:readImage / saveImage 安全校验
 *
 * 验证 crmImageFile 的路径闸门 / 常规文件判定 / magic bytes MIME 判定 / 文件名清洗：
 *   合法图片可读（JPEG/PNG/WebP magic）、目录外文件拒绝、伪装扩展名拒绝（MIME 由内容决定）、
 *   前缀碰撞拒绝（crm-images-x）、../ 逃逸拒绝、symlink 逃逸拒绝、目录/非常规文件拒绝、
 *   清洗后空名回退、saveImage 目标严格位于 crm-images 内。
 * 修复前：readImage 接受任意路径（任意文件读取）、MIME 按扩展名伪造。
 * 运行：npx tsx scripts/crm-image-file-test.ts
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { crmImagesRoot, resolveInsideRoot, isRegularFile, detectImageMime, sanitizeImageFileName } from '../electron/services/crmImageFile'

let pass = 0, fail = 0
function ok(name: string, cond: boolean): void {
  if (cond) { pass++ } else { fail++; console.error('FAIL:', name) }
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0])
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])
const WEBP_MAGIC = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')])

const dir = mkdtempSync(join(tmpdir(), 'crm-image-'))
const userData = dir
const root = crmImagesRoot(userData)
mkdirSync(root, { recursive: true })

// ── magic bytes MIME 判定 ──
ok('1a PNG magic → image/png', detectImageMime(PNG_MAGIC) === 'image/png')
ok('1b JPEG magic → image/jpeg', detectImageMime(JPEG_MAGIC) === 'image/jpeg')
ok('1c WebP magic → image/webp', detectImageMime(WEBP_MAGIC) === 'image/webp')
ok('1d 伪装 PNG（txt 内容 + .png 名）→ null（不信任扩展名）', detectImageMime(Buffer.from('hello world image', 'utf8')) === null)
ok('1e 短 buffer → null', detectImageMime(Buffer.from([0x89, 0x50])) === null)

// ── 合法图片：crm-images 内真实 PNG ──
writeFileSync(join(root, 'a.png'), PNG_MAGIC)
const legal = resolveInsideRoot(root, join(root, 'a.png'))
ok('2a crm-images 内文件通过路径闸门', legal.ok === true)
if (legal.ok) ok('2b 常规文件判定', isRegularFile(legal.path))

// ── 目录外文件拒绝 ──
const outsideFile = join(dir, 'secret.txt')
writeFileSync(outsideFile, 'top secret')
ok('3a userData 根下（crm-images 外）拒绝', resolveInsideRoot(root, outsideFile).ok === false)
ok('3b 全然无关路径拒绝', resolveInsideRoot(root, '/etc/passwd').ok === false)

// ── 前缀碰撞：crm-images-x 与 crm-images 仅差后缀 ──
const collisionDir = join(dir, 'crm-images-x')
mkdirSync(collisionDir, { recursive: true })
const collisionFile = join(collisionDir, 'evil.png')
writeFileSync(collisionFile, PNG_MAGIC)
ok('4a 前缀碰撞目录（crm-images-x）拒绝', resolveInsideRoot(root, collisionFile).ok === false)

// ── ../ 逃逸 ──
ok('5a ../ 逃逸拒绝', resolveInsideRoot(root, join(root, '..', 'secret.txt')).ok === false)
ok('5b 相对 ../ 拒绝', resolveInsideRoot(root, '../secret.txt').ok === false)

// ── 符号链接逃逸 ──
const outsideImage = join(dir, 'outside.png')
writeFileSync(outsideImage, PNG_MAGIC)
try { symlinkSync(outsideImage, join(root, 'link.png')) } catch { /* 平台不支持时跳过建链 */ }
const linkPath = join(root, 'link.png')
if (require('fs').existsSync(linkPath)) {
  const linkCheck = resolveInsideRoot(root, linkPath)
  // 真径逃出 root → 拒绝（即使 lstat 存在）
  ok('6a symlink 指向 root 外 → 拒绝', linkCheck.ok === false || isRegularFile(linkCheck.path!) === false)
} else {
  ok('6a symlink 用例（平台不支持 symlink，跳过建链）', true)
}
// root 内部相对链接（真径仍在 root 内）→ 路径闸门放行但 isRegularFile 拒绝（lstat 为链接）
try { symlinkSync('a.png', join(root, 'inner-link.png')) } catch { /* ignore */ }
const innerLink = join(root, 'inner-link.png')
if (require('fs').existsSync(innerLink)) {
  ok('6b root 内 symlink 本体不是常规文件（拒绝读取）', isRegularFile(innerLink) === false)
} else {
  ok('6b root 内 symlink 用例（平台不支持，跳过）', true)
}

// ── 目录拒绝 ──
const subDir = join(root, 'subdir')
mkdirSync(subDir, { recursive: true })
ok('7a 目录不是常规文件', isRegularFile(subDir) === false)

// ── 尚不存在的输出文件（saveImage 场景）：最近存在父目录在 root 内 → 放行 ──
const newFile = join(subDir, 'new.png')
const newCheck = resolveInsideRoot(root, newFile)
ok('8a root 内新建文件路径放行', newCheck.ok === true)
const newEscape = resolveInsideRoot(root, join(dir, 'new-evil.png'))
ok('8b root 外新建文件路径拒绝', newEscape.ok === false)

// ── 文件名清洗 ──
ok('9a basename 提取', sanitizeImageFileName('../../etc/passwd') === 'passwd')
ok('9b 特殊字符替换', !/[^\w.\-]/.test(sanitizeImageFileName('a b/c:d?.png')))
ok('9c 空名清洗为空（调用方回退 img.jpg）', sanitizeImageFileName('') === '' && sanitizeImageFileName('///') === '')

// ── root 缺失 ──
ok('10 root 不存在拒绝', resolveInsideRoot(join(dir, 'no-such-root'), join(dir, 'x.png')).ok === false)

// ── 端到端模拟 readImage 行为（复刻 handler 逻辑）──
function simulateReadImage(filePath: string): string {
  const check = resolveInsideRoot(root, String(filePath || ''))
  if (!check.ok) return ''
  if (!isRegularFile(check.path)) return ''
  const buf = readFileSync(check.path)
  const mime = detectImageMime(buf)
  if (!mime) return ''
  return `data:${mime};base64,${buf.toString('base64')}`
}
ok('11a 合法 PNG 读出 data URL（MIME=png）', simulateReadImage(join(root, 'a.png')).startsWith('data:image/png;base64,'))
ok('11b 伪装扩展名（txt 内容 .png 名）→ 空', simulateReadImage(join(root, 'fake.png')) === '')
writeFileSync(join(root, 'fake.png'), Buffer.from('this is not an image at all!!'))
ok('11b2 伪装文件确认 → 空', simulateReadImage(join(root, 'fake.png')) === '')
ok('11c 目录外文件 → 空且不区分是否存在（无泄漏）', simulateReadImage(outsideFile) === '' && simulateReadImage(join(dir, 'not-exist.txt')) === '')
ok('11d symlink 逃逸 → 空', require('fs').existsSync(join(root, 'link.png')) ? simulateReadImage(join(root, 'link.png')) === '' : true)
ok('11e ../ → 空', simulateReadImage(join(root, '..', 'secret.txt')) === '')

rmSync(dir, { recursive: true, force: true })
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)
