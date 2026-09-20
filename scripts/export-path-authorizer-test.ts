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
import { ExportPathAuthorizer } from '../electron/services/exportPathAuthorizer'
import { validateAnnualReportExportPayload } from '../electron/services/annualReportExportPolicy'

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

// ── 17 写盘链路行为模拟（按 main.ts handler 相同原语序列：validate → 授权 → mkdir → wx 写入）──
const flowDir = mkdtempSync(join(tmpdir(), 'annual-export-flow-'))
const flowBase = join(flowDir, 'chosen-by-dialog')
mkdirSync(flowBase)
const flowAuth = new ExportPathAuthorizer()
flowAuth.grant(flowBase, 'dir') // 模拟 dialog:openDirectory → exportPathAuthorizer.grant(p, 'dir')
const outsideSecret = join(flowDir, 'outside-secret')
writeFileSync(outsideSecret, 'secret')

const runExportFlow = (auth: ExportPathAuthorizer, validated: ReturnType<typeof validateAnnualReportExportPayload>): string => {
  const { baseDir, folderName, images } = validated
  auth.assertAllowed(baseDir, 'dir')
  let targetDir = resolve(baseDir, folderName)
  if (existsSync(targetDir)) {
    let idx = 2
    while (idx <= 1000 && existsSync(`${targetDir}_${idx}`)) idx++
    if (idx > 1000) throw new Error('同名报告目录过多')
    targetDir = `${targetDir}_${idx}`
  }
  auth.assertAllowed(targetDir, 'dir')
  mkdirSync(targetDir)
  auth.assertAllowed(targetDir, 'dir')
  for (const img of images) {
    const filePath = resolve(targetDir, img.name)
    auth.assertAllowed(filePath, 'file')
    writeFileSync(filePath, img.buffer, { flag: 'wx', mode: 0o600 })
  }
  return targetDir
}

ok('17a 合法载荷全流程写盘成功且权限收敛', (() => {
  try {
    const validated = validateAnnualReportExportPayload({
      baseDir: flowBase, folderName: '2026年度报告_分页面',
      images: [{ name: 'P00_THE_ARCHIVE.png', dataUrl: realPngDataUrl }, { name: 'P01_VOLUME.png', dataUrl: realPngDataUrl }]
    })
    const target = runExportFlow(flowAuth, validated)
    const written = readFileSync(join(target, 'P00_THE_ARCHIVE.png'))
    if (written.length !== realPngBytes.length) return false
    if (written.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return false
    if (process.platform !== 'win32' && (statSync(join(target, 'P01_VOLUME.png')).mode & 0o177) !== 0) return false
    return existsSync(join(target, 'P01_VOLUME.png'))
  } catch { return false }
})())

ok('17b 未授权 baseDir → assertAllowed 拦截且不建目录', (() => {
  const noGrantAuth = new ExportPathAuthorizer()
  const unauthorizedBase = join(flowDir, 'not-authorized')
  let rejected = false
  try { noGrantAuth.assertAllowed(unauthorizedBase, 'dir') } catch { rejected = true }
  return rejected && !existsSync(unauthorizedBase) && !existsSync(join(unauthorizedBase, '2026年度报告_分页面'))
})())

ok('17c symlink 目录被后缀绕开、symlink 路径被授权器拦截、外部文件未被改动', (() => {
  try {
    const trap = join(flowBase, 'symlink-trap')
    mkdirSync(trap)
    symlinkSync(outsideSecret, join(trap, 'P00_TRAP.png'))
    const target = runExportFlow(flowAuth, validateAnnualReportExportPayload({
      baseDir: flowBase, folderName: 'symlink-trap',
      images: [{ name: 'P00_TRAP.png', dataUrl: realPngDataUrl }]
    }))
    // 目录已存在 → handler 走 _2 后缀新目录，绝不写进 symlink 目录
    if (target !== `${trap}_2` || !existsSync(join(target, 'P00_TRAP.png'))) return false
    if (!lstatSync(join(trap, 'P00_TRAP.png')).isSymbolicLink()) return false
    let symlinkPathRejected = false
    try { flowAuth.assertAllowed(resolve(trap, 'P00_TRAP.png'), 'file') } catch { symlinkPathRejected = true }
    return symlinkPathRejected && readFileSync(outsideSecret).toString() === 'secret'
  } catch { return false }
})())

ok('17d 已存在文件 wx 不可覆盖；悬空 symlink 被授权器与 wx 双重拦截', (() => {
  try {
    const target = join(flowBase, 'no-overwrite')
    mkdirSync(target)
    writeFileSync(join(target, 'P00_EXIST.png'), 'original')
    symlinkSync(join(flowDir, 'dangling-target'), join(target, 'P00_DANGLE.png'))

    let threwEexist = false
    const existPath = resolve(target, 'P00_EXIST.png')
    flowAuth.assertAllowed(existPath, 'file')
    try {
      writeFileSync(existPath, realPngBytes, { flag: 'wx', mode: 0o600 })
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') threwEexist = true
      else throw e
    }

    const danglePath = resolve(target, 'P00_DANGLE.png')
    let symlinkRejected = false
    try { flowAuth.assertAllowed(danglePath, 'file') } catch { symlinkRejected = true }
    let wxRejectedSymlink = false
    try {
      writeFileSync(danglePath, realPngBytes, { flag: 'wx', mode: 0o600 })
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') wxRejectedSymlink = true
      else throw e
    }

    return threwEexist && symlinkRejected && wxRejectedSymlink
      && readFileSync(join(target, 'P00_EXIST.png')).toString() === 'original'
      && !existsSync(join(flowDir, 'dangling-target'))
  } catch { return false }
})())

ok('17e 同名目录后缀查找有上限（镜像 main.ts 循环）', (() => {
  const capBaseName = join(flowBase, '后缀上限测试')
  mkdirSync(capBaseName)
  for (let i = 2; i <= 1001; i++) mkdirSync(`${capBaseName}_${i}`)
  let idx = 2
  while (idx <= 1000 && existsSync(`${capBaseName}_${idx}`)) idx++
  return idx > 1000
})())

rmSync(flowDir, { recursive: true, force: true })

rmSync(dir, { recursive: true, force: true })
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)
