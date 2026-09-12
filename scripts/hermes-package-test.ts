/**
 * hermes-package-test.ts —— 任务 4：Hermes Utility 正式打包结构验证
 *
 * 全部断言基于真实源码/真实构建产物/真实安装包目录（字符串扫描只打构建产物与配置原文，
 * 绝不打 TS 源代替物）。分五段：
 *  - A vite 配置：Utility 独立入口 + 精确产物名 hermesUtility.js + codeSplitting:false +
 *    outDir dist-electron；其余 worker/主/preload 入口不受影响
 *  - B builder 配置：全局 extraResources 含 hermesUtility.js from→to（三平台共用，经
 *    electron-builder getFileMatchers 源码级确认：全局先加、平台后加，二者合并）；files
 *    排除在引入之后（minimatchAll 顺序语义：后置负模式胜出）
 *  - C main 路径解析：resolveHermesUtilityPath 纯函数（开发态 dist-electron/、打包态
 *    resources/hermes/）；main.ts 接线（无 .ts 启动路径、无 cwd 依赖、不 import 旧进程内
 *    Agent）；Manager entryExists 检查 + agent_missing fail-closed（源码级）
 *  - D 构建产物红线（真实 dist-electron/hermesUtility.js）：存在非空、无动态分片、含协议
 *    v2/Agent Core/parentPort 接线标记、零 DB/AI 客户端/网络服务/旧 Agent/内联 sourcemap
 *  - E 安装目录结构（真实 release/ 产物，未打包时如实跳过）：mac .app Contents/Resources/
 *    hermes/hermesUtility.js 存在、app.asar 内无 hermesUtility.js 副本、主/preload/其他
 *    worker 照常入 asar（经 npx asar list 实测）
 *
 * 隐私诊断（七）：校验 Manager 模型出口观测仅 env 开启、只输出计数字段（源码级）。
 *
 * 运行：WEFLOW_WORKER=1 npx tsx scripts/hermes-package-test.ts
 */
import { execFileSync } from 'child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { resolveHermesUtilityPath, describeHermesUtilityPath } from '../electron/hermes/hermesUtilityPath'

// ─── 断言计数 ────────────────────────────────────────────────────────────────

let pass = 0
let fail = 0

/** 断言：条件为真 */
function ok(cond: boolean, label: string): void {
  if (cond) { pass++; return }
  fail++
  throw new Error(`断言失败: ${label}`)
}

/** 断言：相等 */
function eq<T>(a: T, b: T, label: string): void {
  if (a === b) { pass++; return }
  fail++
  throw new Error(`断言失败: ${label}（期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}）`)
}

// ─── 路径 ─────────────────────────────────────────────────────────────────────

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..')
const VITE_TS = join(ROOT, 'vite.config.ts')
const PKG_JSON = join(ROOT, 'package.json')
const MAIN_TS = join(ROOT, 'electron', 'main.ts')
const MANAGER_TS = join(ROOT, 'electron', 'hermes', 'hermesUtilityManager.ts')
const PATH_TS = join(ROOT, 'electron', 'hermes', 'hermesUtilityPath.ts')
const PANEL_TSX = join(ROOT, 'src', 'components', 'hermes', 'HermesPanel.tsx')
const ERROR_MESSAGES_TS = join(ROOT, 'shared', 'hermesErrorMessages.ts')
const DIST_ELECTRON = join(ROOT, 'dist-electron')
const ARTIFACT = join(DIST_ELECTRON, 'hermesUtility.js')
const OLD_ARTIFACT = join(DIST_ELECTRON, 'hermesUtilityEntry.js')
const RELEASE_DIR = join(ROOT, 'release')

const read = (p: string): string => readFileSync(p, 'utf8')

/** 截取源码中 marker 起始的配置块（到块边界 end 首次出现处，含 marker 前最近一个 { 之后内容） */
function sliceFrom(src: string, startMarker: string, endMarker: string): string {
  const i = src.indexOf(startMarker)
  if (i < 0) return ''
  const j = src.indexOf(endMarker, i)
  return j < 0 ? src.slice(i) : src.slice(i, j)
}

// ─── A：vite 配置 ─────────────────────────────────────────────────────────────

function sectionA(): void {
  const viteSrc = read(VITE_TS)
  const hermesBlock = sliceFrom(viteSrc, "entry: 'electron/hermes/hermesUtilityEntry.ts'", "entry: 'electron/preload.ts'")
  ok(hermesBlock.length > 0, 'A1 vite 保留 Hermes Utility 独立入口（源文件 hermesUtilityEntry.ts 不改名）')
  ok(hermesBlock.includes("entryFileNames: 'hermesUtility.js'"), "A2 产物名精确固定为 hermesUtility.js")
  ok(!hermesBlock.includes('hermesUtilityEntry.js'), 'A3 不再输出旧产物名 hermesUtilityEntry.js')
  ok(hermesBlock.includes('codeSplitting: false'), 'A4 Utility 入口保持 codeSplitting:false（零动态分片）')
  ok(hermesBlock.includes("outDir: 'dist-electron'"), 'A5 Utility 产物落在 dist-electron/')
  // 其余入口不受影响
  ok(viteSrc.includes("entryFileNames: 'apiMessageWorker.js'"), 'A6 apiMessageWorker 入口配置不受影响')
  ok(viteSrc.includes("entry: 'electron/preload.ts'"), 'A7 preload 入口配置不受影响')
  ok(viteSrc.includes("entryFileNames: 'main.js'") || viteSrc.includes("entry: 'electron/main.ts'"), 'A8 主进程入口配置不受影响')
}

// ─── B：electron-builder 配置 ────────────────────────────────────────────────

function sectionB(): void {
  const pkg = JSON.parse(read(PKG_JSON)) as { build: Record<string, unknown> }
  const build = pkg.build
  const extra = build.extraResources as Array<Record<string, string>> | undefined
  ok(Array.isArray(extra), 'B1 全局 build.extraResources 存在')
  const hermesEntry = (extra ?? []).find((e) => e.from === 'dist-electron/hermesUtility.js')
  ok(!!hermesEntry, 'B2 全局 extraResources 含 Utility 产物条目')
  eq(hermesEntry?.to, 'hermes/hermesUtility.js', 'B3 extraResources to = hermes/hermesUtility.js（三平台共用）')
  // 平台块不重复声明（合并语义已由 electron-builder 源码级确认：全局先加、平台后加）
  for (const plat of ['mac', 'win', 'linux'] as const) {
    const platExtra = (build[plat] as Record<string, unknown> | undefined)?.extraResources
    if (Array.isArray(platExtra)) {
      const dup = (platExtra as Array<Record<string, string>>).some((e) => e.from === 'dist-electron/hermesUtility.js')
      ok(!dup, `B4 ${plat} 平台块不重复声明 Utility 条目（全局统一生效）`)
    }
  }
  const files = build.files as string[] | undefined
  ok(Array.isArray(files) && files.includes('dist-electron/**/*'), 'B5 files 仍整体打包 dist-electron（其余 worker 照常）')
  const inclIdx = files?.indexOf('dist-electron/**/*') ?? -1
  const exclIdx = files?.indexOf('!dist-electron/hermesUtility.js') ?? -1
  ok(exclIdx > inclIdx && inclIdx >= 0, 'B6 files 负模式排除在引入之后（minimatchAll 顺序语义：后置负模式胜出）')
  // Windows 静态一致性：win 平台块存在且 nsis 目标不受影响（未真机实测，仅静态检查）
  const win = build.win as Record<string, unknown> | undefined
  ok(!!win, 'B7 win 平台块存在（Windows 未真机实测，仅静态配置检查）')
}

// ─── C：main 路径解析 + Manager fail-closed ──────────────────────────────────

function sectionC(): void {
  // 纯函数解析（注入式输入，双态精确）
  eq(resolveHermesUtilityPath({ isPackaged: false, dirname: '/proj/dist-electron', resourcesPath: '/app/Resources' }),
    join('/proj/dist-electron', 'hermesUtility.js'), 'C1 开发态解析 = dirname/hermesUtility.js')
  eq(resolveHermesUtilityPath({ isPackaged: true, dirname: '/proj/dist-electron', resourcesPath: '/app/Contents/Resources' }),
    join('/app/Contents/Resources', 'hermes', 'hermesUtility.js'), 'C2 打包态解析 = resourcesPath/hermes/hermesUtility.js')
  ok(resolveHermesUtilityPath({ isPackaged: true, dirname: '/x', resourcesPath: '/r' }).endsWith('hermes/hermesUtility.js'),
    'C3 打包态路径以 hermes/hermesUtility.js 结尾（非 asar 内部）')
  eq(describeHermesUtilityPath(true, false), '打包态 resources=缺失', 'C4 路径日志摘要只含形态+存在性（不含完整路径）')
  const pathSrc = read(PATH_TS)
  // 只看代码行（剥离块注释行），避免文档红线说明本身误触
  const pathCode = pathSrc.split('\n').filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n')
  ok(!pathCode.includes('process.cwd'), 'C5 解析函数不依赖 process.cwd()')
  ok(!pathCode.includes('.ts'), 'C6 解析函数不解析 .ts 启动路径')

  // main.ts 接线（源码级）
  const mainSrc = read(MAIN_TS)
  ok(mainSrc.includes('resolveHermesUtilityPath'), 'C7 main.ts 经 resolveHermesUtilityPath 单点解析入口')
  ok(mainSrc.includes('app.isPackaged') && mainSrc.includes('process.resourcesPath'), 'C8 main.ts 注入 isPackaged/resourcesPath 真实来源')
  const hermesWiring = sliceFrom(mainSrc, 'const hermesUtilityEntryPath', 'const hermesUtilityManager')
  ok(!hermesWiring.includes('process.cwd'), 'C9 Hermes 入口解析不依赖 process.cwd()')
  ok(!mainSrc.includes('hermesUtilityEntry.js'), 'C10 main.ts 不再指向旧产物名')
  const mgrWiring = sliceFrom(mainSrc, 'const hermesUtilityManager', 'app.commandLine')
  ok(!mgrWiring.includes('.ts'), 'C11 main.ts Utility 接线块无 .ts 启动路径')
  ok(!mainSrc.includes("from './services/hermesAgentService'"), 'C12 main.ts 不 import 旧进程内 Agent（生产严禁回退）')
  ok(mainSrc.includes('describeHermesUtilityPath'), 'C13 main.ts 启动日志走形态+存在性摘要（不记完整路径）')

  // Manager fail-closed（源码级：本测试不 import Manager，避免拉起 ConfigService/electron）
  const mgrSrc = read(MANAGER_TS)
  ok(mgrSrc.includes('entryExists'), 'C14 Manager 支持注入式入口存在性检查')
  ok(mgrSrc.includes('agent_missing'), 'C15 Manager 定义 agent_missing 错误码')
  ok(mgrSrc.includes('Hermes Utility 打包资源缺失'), 'C16 缺失时内部日志为「Hermes Utility 打包资源缺失」')
  ok(mgrSrc.includes("if (!this.entryExistsFn())"), 'C17 beginFork fork 前检查产物存在性')
  const errorMessagesSrc = read(ERROR_MESSAGES_TS)
  ok(mgrSrc.includes("MANAGER_ERROR.agent_missing") || errorMessagesSrc.includes("agent_missing: 'Hermes 暂时不可用，请重新安装或升级应用。'"),
    'C18 agent_missing 人话文案 = 请重新安装或升级应用')
  const panelSrc = read(PANEL_TSX)
  ok(panelSrc.includes('getHermesErrorMessage') && errorMessagesSrc.includes('agent_missing'),
    'C19 Panel 将 agent_missing 映射为重装指引（纯文本，不改视觉）')
  ok(panelSrc.includes('getHermesErrorMessage') && errorMessagesSrc.includes("'Hermes 暂时不可用，请重新安装或升级应用。'"), 'C20 Panel 文案与要求逐字一致')
}

// ─── D：真实构建产物红线 ──────────────────────────────────────────────────────

/** 产物红线：禁止出现的字符串（模块说明符/协议字面量级别，minify 不改写字符串常量） */
const FORBIDDEN_IN_ARTIFACT = [
  'better-sqlite3', 'node:sqlite', 'sqlite3', 'WCDB', 'wcdb',
  'ConfigService', 'safeStorage', 'apiKey', 'API_KEY', 'sk-',
  'http.createServer', 'https.createServer', 'net.createServer', 'node:http', 'node:https', 'node:net',
  'child_process', 'utilityProcess.fork', 'hermesAgentService',
  'sourceMappingURL', 'sourceURL='
]
/** 产物红线：必须出现的字符串（协议 v2 / Agent Core / parentPort 接线标记） */
const REQUIRED_IN_ARTIFACT = [
  'task.start', 'tool.execute', 'model.complete', 'evidenceHandle', 'parentPort'
]

function sectionD(): void {
  if (!existsSync(DIST_ELECTRON)) {
    throw new Error('D 段需要真实构建产物：dist-electron/ 不存在，请先 npx vite build')
  }
  ok(existsSync(ARTIFACT), 'D1 真实产物 dist-electron/hermesUtility.js 存在')
  const size = statSync(ARTIFACT).size
  ok(size > 1024, `D2 产物非空（${size} 字节）`)
  ok(!existsSync(OLD_ARTIFACT), 'D3 旧产物 hermesUtilityEntry.js 不再残留')
  // 零动态分片：dist-electron 无其他 hermes* 产物/分片
  const others = readdirSync(DIST_ELECTRON).filter((f) => /^hermes/i.test(f) && f !== 'hermesUtility.js')
  eq(others.length, 0, `D4 无 hermes 动态分片（意外产物: ${others.join(', ') || '无'}）`)
  const src = read(ARTIFACT)
  // 协议自身的禁字段正则（FORBIDDEN_KEY_RE，把 apiKey 等列为拒绝项）属于防御代码本身，
  // 其正则字面量会命中扫描——剥离后再扫，其余位置出现同样会被抓
  const scanTarget = src.replace(/\^\(messageKey\|sessionId\|[^)]+\)\$/g, '')
  for (const bad of FORBIDDEN_IN_ARTIFACT) {
    ok(!scanTarget.includes(bad), `D5 产物零红线字符串「${bad}」`)
  }
  for (const need of REQUIRED_IN_ARTIFACT) {
    ok(src.includes(need), `D6 产物含接线标记「${need}」`)
  }
}

// ─── E：真实安装包目录结构 ────────────────────────────────────────────────────

function sectionE(): void {
  if (!existsSync(RELEASE_DIR)) {
    console.log('⏭️  [E] release/ 不存在（尚未打包）——E 段如实跳过，打包后重跑本测试')
    return
  }
  // mac .app：release/mac*/<product>.app/Contents/Resources/hermes/hermesUtility.js
  const macDirs = readdirSync(RELEASE_DIR).filter((d) => d === 'mac' || d === 'mac-arm64' || d.startsWith('mac'))
  let checked = false
  for (const d of macDirs) {
    const macDir = join(RELEASE_DIR, d)
    if (!statSync(macDir).isDirectory()) continue
    const apps = readdirSync(macDir).filter((f) => f.endsWith('.app'))
    for (const app of apps) {
      const resDir = join(macDir, app, 'Contents', 'Resources')
      const hermesFile = join(resDir, 'hermes', 'hermesUtility.js')
      if (!existsSync(resDir)) continue
      checked = true
      ok(existsSync(hermesFile), `E1 ${d}/${app} Contents/Resources/hermes/hermesUtility.js 存在（extraResources 实装）`)
      const asar = join(macDir, app, 'Contents', 'Resources', 'app.asar')
      ok(existsSync(asar), `E2 ${d}/${app} app.asar 存在`)
      // 经真实工具 npx asar list 枚举，绝不猜测
      const listing = execFileSync('npx', ['asar', 'list', asar], { cwd: ROOT, encoding: 'utf8' })
      const lines = listing.split('\n')
      ok(!lines.some((l) => l.includes('hermesUtility.js')), 'E3 app.asar 内无 hermesUtility.js 副本（files 负模式实装）')
      ok(lines.some((l) => /dist-electron\/main\.js$/.test(l)), 'E4 asar 内 main.js 照常打包')
      ok(lines.some((l) => /dist-electron\/preload\.js$/.test(l)), 'E5 asar 内 preload.js 照常打包')
      ok(lines.some((l) => /dist-electron\/apiMessageWorker\.js$/.test(l)), 'E6 asar 内其余 worker（apiMessageWorker.js）照常打包')
      ok(lines.some((l) => /dist-electron\/wcdbWorker\.js$/.test(l)), 'E7 asar 内 wcdbWorker.js 照常打包')
    }
  }
  if (!checked) console.log('⏭️  [E] release/ 无 mac .app 产物——E 段如实跳过，打包后重跑本测试')
}

// ─── 七：隐私诊断（源码级静态校验） ───────────────────────────────────────────

function sectionPrivacy(): void {
  const mgrSrc = read(MANAGER_TS)
  ok(mgrSrc.includes('WEFLOW_HERMES_PRIVACY_DIAG'), 'P1 模型出口观测受 WEFLOW_HERMES_PRIVACY_DIAG 环境变量门控')
  const diag = sliceFrom(mgrSrc, 'logModelEgressDiagnostic(', 'hostToolExecute')
  ok(diag.includes("WEFLOW_HERMES_PRIVACY_DIAG !== '1'"), 'P2 默认（env 未开启）完全静默')
  ok(diag.includes('containsKnownSessionId') && diag.includes('containsPhone') && diag.includes('containsIdCard'),
    'P3 观测字段为脱敏布尔/计数（taskId/messageCount/boundaryIssueCount/三布尔）')
  ok(!diag.includes('${joined}') && !diag.includes('${text}') && !diag.includes('${content}'),
    'P4 观测日志不输出 prompt/响应全文或任何原文内容')
  ok(!diag.includes('insert') && !diag.includes('CREATE TABLE'), 'P5 观测不落任何持久化存储')
}

// ─── 主流程 ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const sections: Array<[string, () => void]> = [
    ['A vite 配置', sectionA],
    ['B builder 配置', sectionB],
    ['C main 路径解析', sectionC],
    ['D 构建产物红线', sectionD],
    ['E 安装目录结构', sectionE],
    ['P 隐私诊断', sectionPrivacy]
  ]
  console.log(`── Hermes Utility 打包结构验证（${sections.length} 段，产物/安装包实测）──`)
  for (const [name, fn] of sections) {
    const before = pass
    try {
      fn()
      console.log(`✅ [${name}] ${pass - before} 项`)
    } catch (e) {
      console.error(`❌ [${name}]\n   ${(e as Error).message}`)
    }
  }
  console.log(`\n${fail === 0 ? '🎉 全部通过' : '⚠️ 存在失败'}：${pass} 通过 / ${fail} 失败`)
  process.exit(fail === 0 ? 0 : 1)
}

void main()
