/**
 * export-path-authorizer-test.ts —— H3 回归测试：导出 IPC「用户批准导出路径」校验
 *
 * 验证 ExportPathAuthorizer：目录授权允许其内新建导出文件、未授权路径拒绝、
 * 兄弟前缀目录拒绝（/x/exports vs /x/exports-evil）、../ 拒绝、symlink 逃逸拒绝、
 * 文件授权只允许该文件本身。修复前：六个导出 IPC 接受渲染层传入的任意路径。
 * 运行：npx tsx scripts/export-path-authorizer-test.ts
 */
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, rmSync, statSync, readFileSync, lstatSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { ExportPathAuthorizer, exportPathAuthorizer } from '../electron/services/exportPathAuthorizer'
import {
  validateAnnualReportExportPayload,
  preflightAnnualReportExportPayload,
  ANNUAL_REPORT_EXPORT_LIMITS,
  type AnnualReportExportLimits
} from '../electron/services/annualReportExportPolicy'
import { exportAnnualReportImages, defaultAnnualReportImageExportDeps, type AnnualReportImageExportDeps } from '../electron/services/annualReportImageExport'

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

// ── annualReport:exportImages 载荷策略 ────────────────────────────────────────
const pngDataUrl = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64')}`
const validAnnualPayload = {
  baseDir: grantedDir,
  folderName: '2026年度报告',
  images: [{ name: 'summary.png', dataUrl: pngDataUrl }]
}
const rejectsAnnualPayload = (payload: unknown): boolean => {
  try { validateAnnualReportExportPayload(payload); return false } catch { return true }
}
ok('16a 年度报告合法 PNG 载荷通过', validateAnnualReportExportPayload(validAnnualPayload).images[0].buffer.length === 8)
ok('16b 年度报告 baseDir 必须是绝对路径', rejectsAnnualPayload({ ...validAnnualPayload, baseDir: 'relative' }))
ok('16c 年度报告目录名拒绝 ../ 逃逸', rejectsAnnualPayload({ ...validAnnualPayload, folderName: '../escape' }))
ok('16d 年度报告目录名拒绝反斜杠路径', rejectsAnnualPayload({ ...validAnnualPayload, folderName: '..\\escape' }))
ok('16e 图片名拒绝 ../ 逃逸', rejectsAnnualPayload({ ...validAnnualPayload, images: [{ name: '../escape.png', dataUrl: pngDataUrl }] }))
ok('16f 图片名拒绝反斜杠路径', rejectsAnnualPayload({ ...validAnnualPayload, images: [{ name: '..\\escape.png', dataUrl: pngDataUrl }] }))
ok('16g 图片名必须是 PNG 扩展名', rejectsAnnualPayload({ ...validAnnualPayload, images: [{ name: 'payload.bin', dataUrl: pngDataUrl }] }))
ok('16h 图片内容必须有 PNG 签名', rejectsAnnualPayload({ ...validAnnualPayload, images: [{ name: 'fake.png', dataUrl: `data:image/png;base64,${Buffer.from('not png').toString('base64')}` }] }))
ok('16i 图片 data URL MIME 必须是 PNG', rejectsAnnualPayload({ ...validAnnualPayload, images: [{ name: 'fake.png', dataUrl: pngDataUrl.replace('image/png', 'image/jpeg') }] }))
ok('16j 图片名按大小写折叠后不得重复', rejectsAnnualPayload({ ...validAnnualPayload, images: [{ name: 'A.png', dataUrl: pngDataUrl }, { name: 'a.PNG', dataUrl: pngDataUrl }] }))
ok('16k 图片数量有上限', rejectsAnnualPayload({ ...validAnnualPayload, images: Array.from({ length: 65 }, (_, i) => ({ name: `${i}.png`, dataUrl: pngDataUrl })) }))
ok('16l 单图大小限制生效', (() => {
  try {
    validateAnnualReportExportPayload(validAnnualPayload, { maxImages: 1, maxImageBytes: 7, maxTotalBytes: 16 })
    return false
  } catch { return true }
})())
ok('16m 总大小限制生效', (() => {
  try {
    validateAnnualReportExportPayload(
      { ...validAnnualPayload, images: [{ name: 'a.png', dataUrl: pngDataUrl }, { name: 'b.png', dataUrl: pngDataUrl }] },
      { maxImages: 2, maxImageBytes: 8, maxTotalBytes: 15 }
    )
    return false
  } catch { return true }
})())
ok('16n 图片 Base64 中部含等号 → 拒绝', rejectsAnnualPayload({ ...validAnnualPayload, images: [{ name: 'bad.png', dataUrl: 'data:image/png;base64,QUJ=QUJD' }] }))
ok('16o 图片 Base64 长度非 4 倍数 → 拒绝', rejectsAnnualPayload({ ...validAnnualPayload, images: [{ name: 'bad.png', dataUrl: 'data:image/png;base64,AAA' }] }))
ok('16p 图片 Base64 含 base64url 字符 → 拒绝', rejectsAnnualPayload({ ...validAnnualPayload, images: [{ name: 'bad.png', dataUrl: 'data:image/png;base64,A-_A' }] }))
ok('16q 名称含冒号（Windows 盘符/ADS）→ 拒绝', rejectsAnnualPayload({ ...validAnnualPayload, images: [{ name: ':evil.png', dataUrl: pngDataUrl }] })
  && rejectsAnnualPayload({ ...validAnnualPayload, folderName: 'a:b' }))
ok('16r Windows 保留设备名 → 拒绝', rejectsAnnualPayload({ ...validAnnualPayload, images: [{ name: 'NUL.png', dataUrl: pngDataUrl }] })
  && rejectsAnnualPayload({ ...validAnnualPayload, folderName: 'CON' }))
ok('16s 名称尾部点/空格（Win32 剥离）→ 拒绝', rejectsAnnualPayload({ ...validAnnualPayload, images: [{ name: 'a.png.', dataUrl: pngDataUrl }] })
  && rejectsAnnualPayload({ ...validAnnualPayload, folderName: '报告 ' }))
ok('16t 空主干 .png → 拒绝', rejectsAnnualPayload({ ...validAnnualPayload, images: [{ name: '.png', dataUrl: pngDataUrl }] }))
ok('16u baseDir 含 NUL → 拒绝', rejectsAnnualPayload({ ...validAnnualPayload, baseDir: `${grantedDir}\0evil` }))

// ── 现有年度报告渲染层命名兼容（真实场景名 + 真实 1×1 PNG）─────────────────────
const realPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const realPngDataUrl = `data:image/png;base64,${realPngBase64}`
const realPngBytes = Buffer.from(realPngBase64, 'base64')
const realSceneNames = [
  'THE_ARCHIVE', 'VOLUME', 'NOCTURNE', 'GRAVITY_CENTERS', 'TIME_WAVEFORM',
  'MUTUAL_RESONANCE', 'SOCIAL_KINETICS', 'THE_SPARK', 'FADING_SIGNALS', 'LEXICON', 'EXTRACTION'
]
const realAnnualImages = realSceneNames.map((scene, i) => ({
  name: `P${String(i).padStart(2, '0')}_${scene}.png`,
  dataUrl: realPngDataUrl
}))
ok('16v 现有年度报告真实命名兼容（11 张真实场景名 + 年份/历史以来目录名）', (() => {
  try {
    const okYear = validateAnnualReportExportPayload({
      baseDir: grantedDir, folderName: '2026年度报告_分页面', images: realAnnualImages
    }).images.every((img) => img.buffer.subarray(0, 8).toString('hex') === '89504e470d0a1a0a')
    const okLegacy = validateAnnualReportExportPayload({
      baseDir: grantedDir, folderName: '历史以来双人报告_分页面',
      images: [{ name: 'P00_SCENARIO.png', dataUrl: realPngDataUrl }]
    }).images.length === 1
    return okYear && okLegacy
  } catch { return false }
})())

// ── 17 生产导出函数行为（与 main.ts 同一实现：annualReportImageExport.ts）──────
const flowDir = mkdtempSync(join(tmpdir(), 'annual-export-flow-'))
const flowBase = join(flowDir, 'chosen-by-dialog')
mkdirSync(flowBase)
exportPathAuthorizer.grant(flowBase, 'dir') // 与 dialog:openDirectory 相同的授权入口（进程级单例）
const outsideSecret = join(flowDir, 'outside-secret')
writeFileSync(outsideSecret, 'secret')

void (async () => {
  // 17a 合法载荷：生产函数全流程写盘 + 权限收敛
  try {
    const dir = await exportAnnualReportImages({
      baseDir: flowBase, folderName: '2026年度报告_分页面',
      images: [{ name: 'P00_THE_ARCHIVE.png', dataUrl: realPngDataUrl }, { name: 'P01_VOLUME.png', dataUrl: realPngDataUrl }]
    })
    const written = readFileSync(join(dir, 'P00_THE_ARCHIVE.png'))
    ok('17a 生产函数合法写盘成功且权限收敛',
      dir === join(flowBase, '2026年度报告_分页面')
      && written.length === realPngBytes.length
      && written.subarray(0, 8).toString('hex') === '89504e470d0a1a0a'
      && existsSync(join(dir, 'P01_VOLUME.png'))
      && (process.platform === 'win32' || (statSync(join(dir, 'P01_VOLUME.png')).mode & 0o177) === 0))
  } catch (e) {
    console.error(e)
    ok('17a 生产函数合法写盘成功且权限收敛', false)
  }

  // 17b 未授权 baseDir：生产函数（默认授权器单例）直接拦截且不建目录
  let unauthorizedRejected = false
  try {
    await exportAnnualReportImages({
      baseDir: join(flowDir, 'not-authorized'), folderName: '2026年度报告_分页面',
      images: [{ name: 'P00_X.png', dataUrl: realPngDataUrl }]
    })
  } catch { unauthorizedRejected = true }
  ok('17b 未授权 baseDir 被生产函数拦截且不建目录',
    unauthorizedRejected && !existsSync(join(flowDir, 'not-authorized')))

  // 17c symlink：已存在 symlink 目录走 _2 新目录；symlink 文件路径被授权器拦截
  try {
    const trap = join(flowBase, 'symlink-trap')
    mkdirSync(trap)
    symlinkSync(outsideSecret, join(trap, 'P00_TRAP.png'))
    const trapDir = await exportAnnualReportImages({
      baseDir: flowBase, folderName: 'symlink-trap',
      images: [{ name: 'P00_TRAP.png', dataUrl: realPngDataUrl }]
    })
    let symlinkPathRejected = false
    try { exportPathAuthorizer.assertAllowed(join(trap, 'P00_TRAP.png'), 'file') } catch { symlinkPathRejected = true }
    ok('17c symlink 目录被后缀绕开、symlink 路径被拦截、外部文件未被改动',
      trapDir === `${trap}_2`
      && existsSync(join(trapDir, 'P00_TRAP.png'))
      && lstatSync(join(trap, 'P00_TRAP.png')).isSymbolicLink()
      && symlinkPathRejected
      && readFileSync(outsideSecret).toString() === 'secret')
  } catch (e) {
    console.error(e)
    ok('17c symlink 目录被后缀绕开、symlink 路径被拦截、外部文件未被改动', false)
  }

  // 17d 已有文件不覆盖 / 悬空 symlink 不写穿：经窄接口注入模拟「建目录与写入之间已存在同名目标」，
  // writeImageFile 仍用生产默认实现（wx/0600），验证生产写盘原语本身
  try {
    const injectedDeps: AnnualReportImageExportDeps = {
      ...defaultAnnualReportImageExportDeps,
      exists: () => false,
      mkdir: (targetPath) => {
        mkdirSync(targetPath)
        writeFileSync(join(targetPath, 'P00_EXIST.png'), 'original')
        symlinkSync(join(flowDir, 'dangling-target'), join(targetPath, 'P00_DANGLE.png'))
        return Promise.resolve()
      }
    }
    let existRejected = false
    try {
      await exportAnnualReportImages({
        baseDir: flowBase, folderName: 'race-preexist',
        images: [{ name: 'P00_EXIST.png', dataUrl: realPngDataUrl }]
      }, injectedDeps)
    } catch (e) { existRejected = (e as NodeJS.ErrnoException).code === 'EEXIST' }
    let dangleRejected = false
    try {
      await exportAnnualReportImages({
        baseDir: flowBase, folderName: 'race-dangle',
        images: [{ name: 'P00_DANGLE.png', dataUrl: realPngDataUrl }]
      }, injectedDeps)
    } catch { dangleRejected = true }
    ok('17d 生产 wx 写盘不覆盖已有文件、悬空 symlink 被拒且未写穿',
      existRejected && dangleRejected
      && readFileSync(join(flowBase, 'race-preexist', 'P00_EXIST.png')).toString() === 'original'
      && lstatSync(join(flowBase, 'race-dangle', 'P00_DANGLE.png')).isSymbolicLink()
      && !existsSync(join(flowDir, 'dangling-target')))
  } catch (e) {
    console.error(e)
    ok('17d 生产 wx 写盘不覆盖已有文件、悬空 symlink 被拒且未写穿', false)
  }

  // 17e 同名目录后缀查找有上限：预置 _2.._1001 后由生产函数拒绝
  let capRejected = false
  try {
    const capBaseName = join(flowBase, '后缀上限测试')
    mkdirSync(capBaseName)
    for (let i = 2; i <= 1001; i++) mkdirSync(`${capBaseName}_${i}`)
    await exportAnnualReportImages({
      baseDir: flowBase, folderName: '后缀上限测试',
      images: [{ name: 'P00_X.png', dataUrl: realPngDataUrl }]
    })
  } catch (e) { capRejected = String(e).includes('同名报告目录过多') }
  ok('17e 同名目录后缀查找有上限（生产函数）', capRejected)

  // ── 18 两阶段预检：拒绝阶段与边界 ────────────────────────────────────────────
  const pngBytesOfSize = (n: number): Buffer =>
    Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(n - 8, 0x41)])
  const dataUrlOfBytes = (bytes: Buffer): string => `data:image/png;base64,${bytes.toString('base64')}`
  const preflightStageError = (payload: unknown, limits?: Parameters<typeof preflightAnnualReportExportPayload>[1]): string => {
    try { preflightAnnualReportExportPayload(payload, limits); return '' } catch (e) { return String(e) }
  }

  // 18a 编码长度上限在读整个 Base64 之前生效：非法字符的超长字符串按大小拒绝，而非编码错误
  const oversizedIllegal = `data:image/png;base64,${'*'.repeat(4096)}`
  ok('18a 编码长度超限先于全字符校验拒绝（大小错误而非编码错误）', (() => {
    try {
      preflightAnnualReportExportPayload({
        baseDir: grantedDir, folderName: '2026年度报告', images: [{ name: 'a.png', dataUrl: oversizedIllegal }]
      }, { maxImages: 4, maxImageBytes: 4, maxTotalBytes: 64 })
      return false
    } catch (e) { return String(e).includes('单张图片超过大小限制') && !String(e).includes('编码无效') }
  })())
  ok('18b 同一非法字符串在默认限制下报编码错误（证明拒绝顺序由上限决定）', (() => {
    try {
      preflightAnnualReportExportPayload({
        baseDir: grantedDir, folderName: '2026年度报告', images: [{ name: 'a.png', dataUrl: oversizedIllegal }]
      })
      return false
    } catch (e) { return String(e).includes('图片数据编码无效') }
  })())

  // 18c/18d 总量超限在预检期拒绝，先于任何解码/签名验证（两张内容均非 PNG）
  const nonPngDataUrl = dataUrlOfBytes(Buffer.alloc(8, 0x41))
  const totalOverPayload = {
    baseDir: grantedDir, folderName: '2026年度报告',
    images: [{ name: 'a.png', dataUrl: nonPngDataUrl }, { name: 'b.png', dataUrl: nonPngDataUrl }]
  }
  ok('18c 总预计大小超限在预检期拒绝', preflightStageError(totalOverPayload, { maxImages: 4, maxImageBytes: 16, maxTotalBytes: 15 }).includes('导出图片总大小超过限制'))
  ok('18d 完整校验报总量错误而非“不是有效 PNG”（解码从未执行）', (() => {
    try { validateAnnualReportExportPayload(totalOverPayload, { maxImages: 4, maxImageBytes: 16, maxTotalBytes: 15 }); return false }
    catch (e) { return String(e).includes('导出图片总大小超过限制') && !String(e).includes('不是有效 PNG') }
  })())

  // 18e/18f 大小边界：恰好等于上限通过两阶段校验，超 1 字节在预检期拒绝
  ok('18e 恰好等于单图上限通过预检与解码，超 1 字节拒绝', (() => {
    const limits = { maxImages: 2, maxImageBytes: 24, maxTotalBytes: 64 }
    const atLimitOk = preflightStageError({ baseDir: grantedDir, folderName: '2026年度报告', images: [{ name: 'a.png', dataUrl: dataUrlOfBytes(pngBytesOfSize(24)) }] }, limits) === ''
    const overLimit = preflightStageError({ baseDir: grantedDir, folderName: '2026年度报告', images: [{ name: 'a.png', dataUrl: dataUrlOfBytes(pngBytesOfSize(25)) }] }, limits)
    const decoded = validateAnnualReportExportPayload({ baseDir: grantedDir, folderName: '2026年度报告', images: [{ name: 'a.png', dataUrl: dataUrlOfBytes(pngBytesOfSize(24)) }] }, limits)
    return atLimitOk && decoded.images[0].buffer.length === 24 && overLimit.includes('单张图片超过大小限制')
  })())
  ok('18f 恰好等于总量上限通过预检与解码，超 1 字节拒绝', (() => {
    const limits = { maxImages: 2, maxImageBytes: 24, maxTotalBytes: 24 }
    const atLimitOk = preflightStageError({
      baseDir: grantedDir, folderName: '2026年度报告',
      images: [{ name: 'a.png', dataUrl: dataUrlOfBytes(pngBytesOfSize(12)) }, { name: 'b.png', dataUrl: dataUrlOfBytes(pngBytesOfSize(12)) }]
    }, limits) === ''
    const overLimit = preflightStageError({
      baseDir: grantedDir, folderName: '2026年度报告',
      images: [{ name: 'a.png', dataUrl: dataUrlOfBytes(pngBytesOfSize(12)) }, { name: 'b.png', dataUrl: dataUrlOfBytes(pngBytesOfSize(13)) }]
    }, limits)
    const decoded = validateAnnualReportExportPayload({
      baseDir: grantedDir, folderName: '2026年度报告',
      images: [{ name: 'a.png', dataUrl: dataUrlOfBytes(pngBytesOfSize(12)) }, { name: 'b.png', dataUrl: dataUrlOfBytes(pngBytesOfSize(12)) }]
    }, limits)
    return atLimitOk && decoded.images.every((img) => img.buffer.length === 12) && overLimit.includes('导出图片总大小超过限制')
  })())

  // 18g 非法 limits（0/负数/小数/NaN/Infinity）不得绕过任何限制
  const badLimits: Array<Partial<Record<keyof AnnualReportExportLimits, number>>> = [
    { maxImages: 0 }, { maxImages: -1 }, { maxImages: 1.5 }, { maxImages: NaN }, { maxImages: Infinity },
    { maxImageBytes: 0 }, { maxImageBytes: -1 }, { maxImageBytes: NaN }, { maxImageBytes: Infinity },
    { maxTotalBytes: 0 }, { maxTotalBytes: -1 }, { maxTotalBytes: NaN }, { maxTotalBytes: Infinity }
  ]
  ok('18g 非法 limits 全部被拒绝', badLimits.every((bad) => {
    try {
      preflightAnnualReportExportPayload({
        baseDir: grantedDir, folderName: '2026年度报告', images: [{ name: 'a.png', dataUrl: pngDataUrl }]
      }, { ...ANNUAL_REPORT_EXPORT_LIMITS, ...bad } as AnnualReportExportLimits)
      return false
    } catch (e) { return String(e).includes('导出限制参数') }
  }))

  // 18h 预检产物是轻量元数据，不含解码 Buffer
  ok('18h 预检产物为轻量元数据（含预计字节数，不含 Buffer）', (() => {
    const preflighted = preflightAnnualReportExportPayload(validAnnualPayload)
    const first = preflighted.images[0]
    return !!first && first.name === 'summary.png' && first.expectedBytes === 8 && !('buffer' in first)
  })())

  // ── 19 接线守卫：main.ts handler 只调用生产函数，不再内嵌第二套实现 ─────────────
  const mainTsSource = readFileSync(join(__dirname, '..', 'electron', 'main.ts'), 'utf8')
  const handlerMarker = "ipcMain.handle('annualReport:exportImages'"
  const handlerStart = mainTsSource.indexOf(handlerMarker)
  const nextHandler = mainTsSource.indexOf('ipcMain.handle(', handlerStart + handlerMarker.length)
  const handlerSlice = handlerStart === -1 ? '' : mainTsSource.slice(handlerStart, nextHandler === -1 ? handlerStart + 2000 : nextHandler)
  ok('19a handler 调用生产导出函数 exportAnnualReportImages', handlerSlice.includes('await exportAnnualReportImages(payload)'))
  ok('19b handler 不再内嵌建目录/写盘/授权第二套实现', !/mkdir\(|writeFile\(|assertAllowed\(|validateAnnualReportExportPayload\(/.test(handlerSlice))
})().catch((e) => {
  fail++
  console.error('FAIL: 17-19 段异常中断:', e)
}).then(() => {
  rmSync(flowDir, { recursive: true, force: true })
  rmSync(dir, { recursive: true, force: true })
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  if (fail > 0) process.exit(1)
})
