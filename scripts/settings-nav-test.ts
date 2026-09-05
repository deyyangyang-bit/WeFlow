/**
 * settings-nav-test.ts —— 设置页「傻瓜式」导航层护栏（设计稿 docs/UI设计稿-设置页简化.html）
 *
 * 铁律：现有 11 主 tab + AI 5 子 tab 的内容组件一行不改、逻辑不动、配置键不换——本刀只加导航层。
 * 本测试双保险：
 *   A 静态断言（读源码）：
 *     1  App.tsx 已换壳（SettingsNavShell 挂载，不再直接渲染 SettingsPage）
 *     2  常用页四卡渲染（外观 / 通知 / 安全 / 我是谁）
 *     3  常用页复用现有配置键与写入函数（不造第二份）：
 *        主题=useThemeStore.setThemeMode / 通知=notificationEnabled+notificationFilterMode
 *        （config service 同一 get·set）/ 应用锁=auth.verifyEnabled+isLockMode /
 *        身份=identity.get+identity.set；shell 零直写 config 键
 *     4  高级页 11 行三分组（AI/数据/系统），行 tab id ⊆ SettingsPage SettingsTab 联合类型
 *     5  原 tab 组件仍被引用（17 个 tab 的 render 映射、11 主 tab 数组、5 AI 子 tab 数组——防误删）
 *     6  返回链完整（‹ 返回常用 → navBack；SettingsPage initialTab 深链机制原样保留；
 *        侧边栏 initialTab:'security' 直达入口不受影响）
 *     7  新样式零硬编码 hex（SettingsNavShell.scss 全 --token）+ 导航状态机纯函数零依赖
 *     8  审计流水入口指向 security tab 且 AuditTrailSection 原样保留（不按角色显隐）
 *     9  角色选项 = SettingsPage「身份档案」内联枚举（''/销售/主管/分配员）
 *   B 导航状态机纯函数断言（src/utils/settingsNav.ts，抽可测位置）：
 *     默认进常用页 / 深链直达 / 逐级返回链 / 幂等
 *
 * 运行：npx tsx scripts/settings-nav-test.ts
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { navBack, navInitial, navOpenAdvanced, navOpenTab, type SettingsNavLocation } from '../src/utils/settingsNav'

let pass = 0
let fail = 0
function ok(name: string, cond: boolean): void {
  if (cond) { pass++ } else { fail++; console.error('FAIL:', name) }
}
function eq<T>(name: string, actual: T, expected: T): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) { pass++ } else { fail++; console.error(`FAIL: ${name}\n  actual:   ${a}\n  expected: ${e}`) }
}

const ROOT = join(__dirname, '..')
const shellSrc = readFileSync(join(ROOT, 'src/pages/SettingsNavShell.tsx'), 'utf8')
const shellScss = readFileSync(join(ROOT, 'src/pages/SettingsNavShell.scss'), 'utf8')
const settingsSrc = readFileSync(join(ROOT, 'src/pages/SettingsPage.tsx'), 'utf8')
const appSrc = readFileSync(join(ROOT, 'src/App.tsx'), 'utf8')
const sidebarSrc = readFileSync(join(ROOT, 'src/components/Sidebar.tsx'), 'utf8')
const configSrc = readFileSync(join(ROOT, 'src/services/config.ts'), 'utf8')
const themeStoreSrc = readFileSync(join(ROOT, 'src/stores/themeStore.ts'), 'utf8')
const navUtilSrc = readFileSync(join(ROOT, 'src/utils/settingsNav.ts'), 'utf8')

const between = (src: string, startMarker: string, endMarker: string): string => {
  const i = src.indexOf(startMarker)
  ok(`源码定位「${startMarker.slice(0, 24)}…」存在`, i >= 0)
  if (i < 0) return ''
  const j = src.indexOf(endMarker, i)
  return j > i ? src.slice(i, j) : src.slice(i)
}

async function main(): Promise<void> {
  // ── A1. App.tsx 换壳 ────────────────────────────────────────────
  ok('A1a App.tsx 挂载 SettingsNavShell', appSrc.includes('<SettingsNavShell onClose={handleCloseSettings} />'))
  ok('A1b App.tsx 不再直接渲染 <SettingsPage（tab 页只能由壳带入）', !appSrc.includes('<SettingsPage '))

  // ── A2. 常用页四卡 ─────────────────────────────────────────────
  const commonView = between(shellSrc, 'const renderCommonView', '// ── 高级设置二级页')
  ok('A2a 常用页·外观卡', commonView.includes('外观'))
  ok('A2b 常用页·通知卡（接收通知 + 只收白名单）', commonView.includes('接收通知') && commonView.includes('只收白名单'))
  ok('A2c 常用页·安全卡（应用锁）', commonView.includes('应用锁'))
  ok('A2d 常用页·我是谁卡（当前身份 + 切换身份）', commonView.includes('当前身份') && commonView.includes('切换身份'))
  ok('A2e 常用页·高级设置入口', commonView.includes('高级设置'))

  // ── A3. 复用现有配置键与写入函数（不造第二份）──────────────────
  ok('A3a 主题：复用 useThemeStore.setThemeMode（外观 tab 同一写入函数/持久化键）',
    shellSrc.includes('useThemeStore') && shellSrc.includes("setThemeMode('light')") &&
    shellSrc.includes("setThemeMode('dark')") && shellSrc.includes("setThemeMode('system')"))
  ok('A3a’ themeStore 持久化键唯一（echotrace-theme，shell 未另设）',
    themeStoreSrc.includes("name: 'echotrace-theme'") && !shellSrc.includes('echotrace'))
  ok('A3b 通知总开关：configService.get/setNotificationEnabled（通知 tab 同一键 notificationEnabled）',
    shellSrc.includes('configService.getNotificationEnabled') && shellSrc.includes('configService.setNotificationEnabled') &&
    configSrc.includes("NOTIFICATION_ENABLED: 'notificationEnabled'"))
  ok('A3c 白名单开关：复用 notificationFilterMode 三值键（whitelist/all），不新增键',
    shellSrc.includes('configService.getNotificationFilterMode') && shellSrc.includes("configService.setNotificationFilterMode(mode)") &&
    configSrc.includes("NOTIFICATION_FILTER_MODE: 'notificationFilterMode'"))
  ok('A3d 应用锁：与安全 tab 同源（auth.verifyEnabled + auth.isLockMode），不复制密码流程',
    shellSrc.includes('window.electronAPI.auth.verifyEnabled') && shellSrc.includes('window.electronAPI.auth.isLockMode') &&
    !shellSrc.includes('auth.enableLock') && !shellSrc.includes('auth.disableLock'))
  ok('A3e 身份：identity.get + identity.set（与「身份档案」区块同一 IPC）',
    shellSrc.includes('window.electronAPI.identity.get') && shellSrc.includes('window.electronAPI.identity.set'))
  ok('A3f shell 零直写 config 键（一切写入走现有 service 函数，杜绝第二份键名）',
    !shellSrc.includes('config.set(') && !shellSrc.includes('localStorage.setItem'))

  // ── A4. 高级页 11 行三分组 ─────────────────────────────────────
  const groupsSrc = between(shellSrc, 'const ADVANCED_GROUPS', '// 自动下载仅')
  const groups = [...groupsSrc.matchAll(/group: '([^']+)'/g)].map((m) => m[1])
  const rows = [...groupsSrc.matchAll(/tab: '([^']+)', label: '([^']+)'/g)].map((m) => ({ tab: m[1], label: m[2] }))
  eq('A4a 分组 = AI/数据/系统 三组', groups, ['AI', '数据', '系统'])
  eq('A4b 高级行 = 11 行（设计稿屏 2：AI 3 + 数据 4 + 系统 4）', rows.length, 11)
  eq('A4c 行 tab id 全集（每项恰一次）', rows.map((r) => r.tab).sort(),
    ['about', 'aiCommon', 'analytics', 'antiRevoke', 'api', 'autoDownload', 'cache', 'database', 'models', 'notification', 'security'].sort())
  const settingsTabUnion = between(settingsSrc, 'type SettingsTab', '\n\nconst tabs')
  const tabUnionIds = [...settingsTabUnion.matchAll(/'([a-zA-Z]+)'/g)].map((m) => m[1])
  ok('A4d SettingsTab 联合类型完整（17 个 tab id）', tabUnionIds.length === 17)
  ok('A4e 高级行 tab id ⊆ SettingsTab（深链可达，无死行）', rows.every((r) => tabUnionIds.includes(r.tab)))
  ok('A4f 行标签与设计稿一致（AI 设置/API 服务/模型管理/数据库连接/审计流水/缓存/自动下载/防撤回/通知细节/分析/关于）',
    ['AI 设置', 'API 服务', '模型管理', '数据库连接', '审计流水', '缓存', '自动下载', '防撤回', '通知细节', '分析', '关于']
      .every((label) => rows.some((r) => r.label === label)))
  ok('A4g 自动下载行沿用 filteredTabs 平台门控（win32+x64）',
    shellSrc.includes("proc?.platform === 'win32'") && shellSrc.includes("proc?.arch === 'x64'"))

  // ── A5. 原 tab 内容零改动（防误删）─────────────────────────────
  const tabSwitch = between(settingsSrc, "activeTab === 'appearance' && renderAppearanceTab()", 'export default SettingsPage')
  const renderMappings = [...tabSwitch.matchAll(/activeTab === '([a-zA-Z]+)' && render[A-Za-z]+Tab\(\)/g)].map((m) => m[1])
  eq('A5a 内容分派 17 个 tab 全部仍在（render*Tab 原样挂载）', renderMappings.length, 17)
  eq('A5b 17 tab id 与 SettingsTab 联合类型一致', renderMappings.sort(), tabUnionIds.slice().sort())
  const tabsArray = between(settingsSrc, 'const tabs: { id:', 'const getSessionDisplayName')
  eq('A5c 主 tab 数组仍为 11 项', [...tabsArray.matchAll(/\{ id: '/g)].length, 11)
  const aiTabsArray = between(settingsSrc, 'const aiTabs:', 'const isMac')
  eq('A5d AI 子 tab 数组仍为 5 项', [...aiTabsArray.matchAll(/\{ id: '/g)].length, 5)

  // ── A6. 返回链完整 + 深链直达保留 ──────────────────────────────
  ok('A6a 高级页有「‹ 返回常用」且走 navBack', shellSrc.includes('‹ 返回常用') && /snav-back-link" onClick=\{\(\) => setNav\(navBack\(nav\)\)\}/.test(shellSrc))
  ok('A6b 点行经 location.state.initialTab 深链进原 tab（SettingsPage 现有机制，零改动）',
    shellSrc.includes('initialTab: tab') && /navigate\('\/settings', \{[\s\S]*?initialTab/.test(shellSrc))
  ok('A6c SettingsPage 的 initialTab 消费逻辑原样保留（未删未改）',
    settingsSrc.includes("location.state as { initialTab?: SettingsTab } | null)?.initialTab") &&
    settingsSrc.includes('setActiveTab(initialTab)'))
  ok('A6d 侧边栏「设置应用锁」直达安全 tab 入口不受影响',
    sidebarSrc.includes("initialTab: 'security'"))
  ok('A6e 关闭动画与 SettingsPage 同款（isClosing 200ms）', shellSrc.includes('setIsClosing(true)'))

  // ── A7. 视觉红线 + 纯函数纪律 ─────────────────────────────────
  ok('A7a 新样式零硬编码 hex（SettingsNavShell.scss）', !/#[0-9a-fA-F]{3,8}\b/.test(shellScss.replace(/^\s*\/\/.*$/gm, '')))
  ok('A7b 新样式只消费 --color-*/--radius-*/--shadow-* 族（DESIGN-SPEC-MINI：新代码禁旧 --bg-*/--text-* 族）',
    shellScss.includes('var(--color-') && shellScss.includes('var(--radius-') &&
    !/var\(--(bg|text|border-color|primary|card-bg)[-),]/.test(shellScss))
  ok('A7c 导航状态机纯函数零依赖（settingsNav.ts 无 import）', !/^\s*import\s/m.test(navUtilSrc))

  // ── A8. 审计流水：指向 security tab + 组件原样保留 + 不按角色显隐 ──
  const auditRow = rows.find((r) => r.label === '审计流水')
  eq('A8a 审计流水入口指向 security tab（AuditTrailSection 现挂安全 tab）', auditRow?.tab, 'security')
  ok('A8b AuditTrailSection 在安全 tab 原样保留（组件未动）',
    settingsSrc.includes("import AuditTrailSection from '../components/settings/AuditTrailSection'") &&
    settingsSrc.includes('<AuditTrailSection />'))
  ok('A8c 高级页不按角色显隐（无身份角色门禁；页面过滤档纪律：角色只过滤数据）',
    !shellSrc.includes('isSalesView') && !shellSrc.includes('canManageAssignment') && !shellSrc.includes('leadAssignmentView'))

  // ── A9. 角色选项 = SettingsPage 内联枚举 ──────────────────────
  const shellRoleBlock = between(shellSrc, 'const IDENTITY_ROLE_OPTIONS', ']')
  const shellRoles = [...shellRoleBlock.matchAll(/value: '([^']*)'/g)].map((m) => m[1])
  const spIdentityBlock = between(settingsSrc, "{ value: '', label: '暂不选择' }", 'onClick={() => {\n                      setIdentityRole')
  const spRoles = ['', ...( [...spIdentityBlock.matchAll(/value: '([^']+)'/g)].map((m) => m[1]) )]
  eq('A9 切换身份角色选项与 SettingsPage「身份档案」一致', shellRoles, spRoles)

  // ── B. 导航状态机纯函数（src/utils/settingsNav.ts）─────────────
  const isTab = (l: SettingsNavLocation, tab: string, from: string): boolean =>
    l.view === 'tab' && l.tab === tab && l.from === from

  // B1 默认视图 = 常用页（新用户友好）
  eq('B1 无深链 → 常用页', navInitial(), { view: 'common' })
  eq('B1’ 空串深链 → 常用页', navInitial(''), { view: 'common' })

  // B2 深链直达（如侧边栏「设置应用锁」initialTab:'security'）
  ok('B2 深链直达 security（from=common，返回回常用）', isTab(navInitial('security'), 'security', 'common'))
  ok('B2’ 深链 from 可指定 advanced', isTab(navInitial('about', 'advanced'), 'about', 'advanced'))

  // B3-B4 前进链
  eq('B3 常用 → 高级', navOpenAdvanced({ view: 'common' }), { view: 'advanced' })
  eq('B3’ 任意视图（含 tab）→ 高级', navOpenAdvanced({ view: 'tab', tab: 'api', from: 'advanced' }), { view: 'advanced' })
  ok('B4 高级 → 点行 → 原 tab（from=advanced）', isTab(navOpenTab('cache', 'advanced'), 'cache', 'advanced'))

  // B5-B7 返回链
  eq('B5 tab(from=advanced) → 返回高级页', navBack({ view: 'tab', tab: 'security', from: 'advanced' }), { view: 'advanced' })
  eq('B5’ 高级页 → 返回常用页', navBack({ view: 'advanced' }), { view: 'common' })
  ok('B6 深链 tab(from=common) → 返回常用页', navBack(navInitial('security')).view === 'common')
  eq('B7 常用页无返回（幂等）', navBack({ view: 'common' }), { view: 'common' })

  // B8 完整链：常用 → 高级 → tab → 高级 → 常用
  let loc: SettingsNavLocation = navInitial()
  loc = navOpenAdvanced(loc)
  loc = navOpenTab('database', 'advanced')
  loc = navBack(loc)
  ok('B8a 进 tab 后返回落在高级页', loc.view === 'advanced')
  loc = navBack(loc)
  ok('B8b 再返回落在常用页', loc.view === 'common')
  ok('B8c 全链无中间丢级（高级页 view 正确）', navOpenAdvanced({ view: 'tab', tab: 'models', from: 'common' }).view === 'advanced')

  console.log(`\n设置页导航层护栏：${pass} 通过 / ${fail} 失败`)
  if (fail > 0) process.exit(1)
}

void main()
