/**
 * export-path-authorizer-test.ts —— H3 回归测试：导出 IPC「用户批准导出路径」校验
 *
 * 验证 ExportPathAuthorizer：目录授权允许其内新建导出文件、未授权路径拒绝、
 * 兄弟前缀目录拒绝（/x/exports vs /x/exports-evil）、../ 拒绝、symlink 逃逸拒绝、
 * 文件授权只允许该文件本身。修复前：六个导出 IPC 接受渲染层传入的任意路径。
 * 运行：npx tsx scripts/export-path-authorizer-test.ts
 */
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { ExportPathAuthorizer } from '../electron/services/exportPathAuthorizer'

let pass = 0, fail = 0
function ok(name: string, cond: boolean): void {
  if (cond) { pass++ } else { fail++; console.error('FAIL:', name) }
}

const dir = mkdtempSync(join(tmpdir(), 'export-auth-'))
const grantedDir = join(dir, 'exports')
mkdirSync(grantedDir, { recursive: true })

const auth = new ExportPathAuthorizer()
auth.grant(grantedDir, 'dir')

// ── 合法：目录授权内（含尚不存在的输出文件）──
ok('1a 已授权目录本身放行', auth.check(grantedDir, 'dir').ok === true)
ok('1b 授权目录内已存在文件放行', (() => {
  writeFileSync(join(grantedDir, 'a.csv'), 'x')
  return auth.check(join(grantedDir, 'a.csv'), 'file').ok === true
})())
ok('1c 授权目录内新建（尚不存在）导出文件放行', auth.check(join(grantedDir, 'new-report.csv'), 'file').ok === true)
ok('1d 授权目录内新建子路径文件放行', auth.check(join(grantedDir, 'sub', 'deep.csv'), 'file').ok === true)

// ── 未授权路径 ──
ok('2a 完全无关路径拒绝', auth.check(join(dir, 'other', 'x.csv'), 'file').ok === false)
ok('2b 空路径拒绝', auth.check('', 'file').ok === false)
ok('2c 相对路径拒绝', auth.check('relative/x.csv', 'file').ok === false)

// ── 兄弟前缀目录（/x/exports-evil）──
const sibling = join(dir, 'exports-evil')
mkdirSync(sibling, { recursive: true })
ok('3a 兄弟前缀目录拒绝', auth.check(join(sibling, 'x.csv'), 'file').ok === false)
ok('3b 兄弟前缀目录本身拒绝', auth.check(sibling, 'dir').ok === false)

// ── ../ ──
ok('4a ../ 逃逸拒绝', auth.check(join(grantedDir, '..', 'evil.csv'), 'file').ok === false)
ok('4b 深层 ../ 拒绝', auth.check(join(grantedDir, 'sub', '..', '..', 'evil2.csv'), 'file').ok === false)

// ── symlink 逃逸 ──
const outsideDir = join(dir, 'outside')
mkdirSync(outsideDir, { recursive: true })
const outsideFile = join(outsideDir, 'leak.csv')
writeFileSync(outsideFile, 'secret')
try { symlinkSync(outsideFile, join(grantedDir, 'link.csv')) } catch { /* ignore */ }
const linkPath = join(grantedDir, 'link.csv')
ok('5a 授权目录内 symlink 指向外部文件 → 拒绝', existsSync(linkPath) ? auth.check(linkPath, 'file').ok === false : true)
try { symlinkSync(outsideDir, join(grantedDir, 'linkdir')) } catch { /* ignore */ }
const linkDirPath = join(grantedDir, 'linkdir', 'new.csv')
ok('5b 授权目录内 symlink 目录逃逸 → 拒绝', existsSync(join(grantedDir, 'linkdir')) ? auth.check(linkDirPath, 'file').ok === false : true)

// ── 文件授权：只允许对应文件 ──
const fileAuth = new ExportPathAuthorizer()
const grantedFile = join(dir, 'footprint.csv')
writeFileSync(grantedFile, 'x')
fileAuth.grant(grantedFile, 'file')
ok('6a 文件授权对应文件放行', fileAuth.check(grantedFile, 'file').ok === true)
ok('6b 文件授权不允许目录内其他新文件', fileAuth.check(join(dir, 'footprint2.csv'), 'file').ok === false)
ok('6c 文件授权不允许同目录其他文件', fileAuth.check(join(dir, 'other.csv'), 'file').ok === false)

// ── 授权按文件系统现状判定（不传 kind）──
const autoAuth = new ExportPathAuthorizer()
autoAuth.grant(grantedDir)
ok('7a 授权时目录自动判为 dir', autoAuth.check(join(grantedDir, 'x.csv'), 'file').ok === true)
const autoFileAuth = new ExportPathAuthorizer()
autoFileAuth.grant(grantedFile)
ok('7b 授权时文件自动判为 file', autoFileAuth.check(grantedFile, 'file').ok === true)
ok('7c dir 校验期望不匹配也不放行文件授权', autoFileAuth.check(join(dir, 'x.csv'), 'file').ok === false)

// ── 尚不存在文件的授权（save dialog 可返回未创建路径）──
const saveAuth = new ExportPathAuthorizer()
const notYet = join(grantedDir, 'fresh.csv')
saveAuth.grant(notYet, 'file')
ok('8a 未创建文件的授权可匹配同一（尚未创建）路径', saveAuth.check(notYet, 'file').ok === true)

// ── 非绝对路径 / 空授权 ──
ok('9a 相对路径不能登记授权', (new ExportPathAuthorizer()).grant('relative/path') === null)
ok('9b 空路径不能登记授权', (new ExportPathAuthorizer()).grant('') === null)

// ── P1b：持久化授权根 + 内置 Downloads 根 + 重启恢复 ─────────────────────────
// 主进程托管存储（模拟：临时 JSON 文件 = 重启后仍在的持久层）
const storePath = join(dir, 'auth-roots.json')
const loadRoots = (): Array<{ path: string; realPath: string; grantedAt: number }> => {
  try { return JSON.parse(require('fs').readFileSync(storePath, 'utf8')) } catch { return [] }
}
const saveRoots = (roots: Array<{ path: string; realPath: string; grantedAt: number }>): void => {
  require('fs').writeFileSync(storePath, JSON.stringify(roots))
}
// 内置根：模拟系统 Downloads（受控临时目录）
const downloadsDir = join(dir, 'downloads-sim')
mkdirSync(downloadsDir, { recursive: true })

const auth2 = new ExportPathAuthorizer()
auth2.configure({ loadRoots, saveRoots, builtinRoots: () => [downloadsDir] })

// 首次启动：无持久根，Downloads 默认导出可用
ok('10a 内置 Downloads 根：目录本身放行', auth2.check(downloadsDir, 'dir').ok === true)
ok('10b 内置 Downloads 根：其内新建导出文件放行', auth2.check(join(downloadsDir, 'out.csv'), 'file').ok === true)
ok('10c 未授权目录（无持久根）拒绝', auth2.check(join(dir, 'exports'), 'file').ok === false)

// dialog 选择目录后（grant persist）→ 导出成功 + 持久化
auth2.grant(grantedDir, 'dir', { persist: true })
ok('11a dialog 批准目录后其内导出放行', auth2.check(join(grantedDir, 'manual.csv'), 'file').ok === true)
ok('11b 持久根已落主进程托管存储', loadRoots().length === 1)

// 模拟重启：新实例（内存授权清空）从持久层恢复
const auth3 = new ExportPathAuthorizer()
auth3.configure({ loadRoots, saveRoots, builtinRoots: () => [downloadsDir] })
ok('12a 重启后已授权目录仍可用于手动导出', auth3.check(join(grantedDir, 'again.csv'), 'file').ok === true)
ok('12b 重启后持久根可用于自动化导出', auth3.check(join(grantedDir, 'sub', 'auto.csv'), 'file').ok === true)
ok('12c 重启后 Downloads 仍可用', auth3.check(join(downloadsDir, 'auto2.csv'), 'file').ok === true)

// 仅篡改普通 config 的 exportPath 不构成授权（无持久根/会话授权的路径拒绝）
ok('13 未授权路径（即使写入过 exportPath 偏好）明确失败', auth3.check(join(dir, 'tampered', 'x.csv'), 'file').ok === false)

// 授权目录被替换为 symlink → 拒绝并从持久层剔除
const realTarget = join(dir, 'real-target')
mkdirSync(realTarget, { recursive: true })
auth3.grant(realTarget, 'dir', { persist: true })
ok('14a 新持久根生效', auth3.check(join(realTarget, 'x.csv'), 'file').ok === true)
rmSync(realTarget, { recursive: true, force: true })
const evilTarget = join(dir, 'evil-target')
mkdirSync(evilTarget, { recursive: true })
symlinkSync(evilTarget, realTarget) // 替换为指向非授权目录的符号链接
const auth4 = new ExportPathAuthorizer()
auth4.configure({ loadRoots, saveRoots, builtinRoots: () => [downloadsDir] })
ok('14b 授权根被替换为 symlink → 拒绝', auth4.check(join(realTarget, 'y.csv'), 'file').ok === false)
ok('14c 失效根被恢复流程剔除（不再提供授权）', !auth4.persistedRootsValid().some((r) => r.path === resolve(realTarget)))
// 清理 symlink 恢复真实目录，避免影响外层清理
rmSync(realTarget, { force: true }); mkdirSync(realTarget)

// 自动化任务使用未授权 outputDir → 明确失败（assertAllowed 抛错）
let threwAutomation = false
try { auth4.assertAllowed(join(dir, 'not-authorized-auto'), 'file') } catch { threwAutomation = true }
ok('15 自动化导出未授权 outputDir → assertAllowed 明确抛错', threwAutomation)

rmSync(dir, { recursive: true, force: true })
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)
