/**
 * account-db-isolation-test.ts —— 微信号分库护栏（§2.40，2026-08-29）
 *
 * 背景：业务库原为全局单份（weflow-crm.db / weflow-sales.db），切换微信号后上一账号的
 *       客户/跟进卡全量残留，且新微信会话继续写进同一库（两账号客户混表）。
 *       分库后业务库按当前 wxid 命名：weflow-crm-<wxid>.db / weflow-sales-<wxid>.db。
 *
 * 断言：
 *   A 静态：
 *     1  businessDbPath 命名规则（weflow-<kind>-<wxid>.db + [^A-Za-z0-9_-]→'-' 清洗 + 空 wxid 回退 legacy）
 *     2  迁移规则：suffixed 不存在 && legacy 存在 → renameSync；共存/空 wxid 不动
 *     3  两服务 initialize 加 wxid 第二参 + businessDbPath 路径 + initPromise 并发护栏 + reopenForWxid + archiveCurrentDb
 *     4  main.ts config:set myWxid 钩子（值变化才触发，经 enqueueSalesTask 串行）
 *     5  main.ts 启动：migrateLegacyBusinessDbs 在 salesDbService.initialize 之前
 *     6  main.ts 归档 IPC chat:archiveBusinessData（归档两库 + reopen 新空库）
 *     7  crmIpcHandlers initialize 补 wxid 参
 *     8  backupService 备份清单覆盖 suffixed 库（glob + .archived 排除）
 *     9  桥接齐全：preload + electron.d.ts archiveBusinessData
 *     10 设置页「业务数据归档」按钮（confirm 确认 + 归档调用）
 *   B 行为（sql.js 真实库，tmpdir）：
 *     11 sanitizeWxidForDbName 单元（清洗 / 空回退）
 *     12 migrateLegacyBusinessDbs 行为（rename / 幂等 / 共存不动 / 空 wxid no-op）
 *     13 CRM 库隔离：wxidA 写入 → reopen wxidB 为空 → reopen wxidA 数据在
 *     14 sales 库隔离：customerUpsert 同上
 *     15 归档行为：archiveCurrentDb 产出 .archived-<yyyyMMdd-HHmmss>.db 文件 + reopen 后空库
 *     16 空 wxid 回退 legacy 名（兼容现有测试/初始化顺序）
 *     17 并发 initialize 去重（Promise.all 双路径同一 dbPath）
 *
 * 运行：npx tsx scripts/account-db-isolation-test.ts
 */
import { existsSync, mkdtempSync, writeFileSync, rmSync, readFileSync, utimesSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { crmDbService } from '../electron/services/crmDbService'
import { salesDbService } from '../electron/services/salesDbService'
import {
  sanitizeWxidForDbName, businessDbName, businessDbPath,
  migrateLegacyBusinessDbs, archivedDbName, archiveStampOf, findExistingBusinessDb
} from '../electron/services/businessDbPath'

let pass = 0, fail = 0
function ok(name: string, cond: boolean): void {
  if (cond) { pass++ } else { fail++; console.error('FAIL:', name) }
}

const ROOT = join(__dirname, '..')
const read = (p: string): string => { try { return existsSync(join(ROOT, p)) ? require('fs').readFileSync(join(ROOT, p), 'utf8') : '' } catch { return '' } }
const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

async function main(): Promise<void> {
  // ── A. 静态 ────────────────────────────────────────────────────────────────
  const bdSrc = read('electron/services/businessDbPath.ts')
  const crmSrc = strip(read('electron/services/crmDbService.ts'))
  const salesSrc = strip(read('electron/services/salesDbService.ts'))
  const mainSrc = strip(read('electron/main.ts'))
  const ipcSrc = strip(read('electron/services/crmIpcHandlers.ts'))
  const backupRaw = read('electron/services/backupService.ts')
  const preloadSrc = read('electron/preload.ts')
  const dtsSrc = read('src/types/electron.d.ts')
  const settingsSrc = read('src/pages/SettingsPage.tsx')

  // A1: 命名规则
  ok('A1 businessDbPath 命名（weflow-<kind>-<wxid>.db + [^A-Za-z0-9_-]→- 清洗）',
    /businessDbName/.test(bdSrc) &&
    /\$\{DB_BASES\[kind\]\}-\$\{clean\}\.db/.test(bdSrc) &&
    /replace\(\/\[\^A-Za-z0-9_-\]\/g, '-'\)/.test(bdSrc))
  ok('A2 空 wxid 回退 legacy 名（weflow-crm.db / weflow-sales.db）',
    /crm: 'weflow-crm\.db'/.test(bdSrc) && /sales: 'weflow-sales\.db'/.test(bdSrc) &&
    /clean \? `\$\{DB_BASES\[kind\]\}-\$\{clean\}\.db` : LEGACY_NAMES\[kind\]/.test(bdSrc))

  // A3: 迁移规则 + 两服务装配
  ok('A3 迁移规则（suffixed 不存在 && legacy 存在 → renameSync；共存不动）',
    /existsSync\(to\) \|\| !existsSync\(from\)/.test(bdSrc) && /renameSync\(from, to\)/.test(bdSrc))
  ok('A4 两服务 initialize(wxid?) + businessDbPath + initPromise 护栏 + reopenForWxid + archiveCurrentDb',
    /async initialize\(userDataPath: string, wxid\?: string\): Promise<void>/.test(crmSrc) &&
    /businessDbPath\(userDataPath, wxid, 'crm'\)/.test(crmSrc) &&
    /this\.initPromise/.test(crmSrc) && /reopenForWxid/.test(crmSrc) && /archiveCurrentDb/.test(crmSrc) &&
    /async initialize\(userDataPath: string, wxid\?: string\): Promise<void>/.test(salesSrc) &&
    /businessDbPath\(userDataPath, wxid, 'sales'\)/.test(salesSrc) &&
    /this\.initPromise/.test(salesSrc) && /reopenForWxid/.test(salesSrc) && /archiveCurrentDb/.test(salesSrc))

  // A5: config:set myWxid 钩子（值变化才触发 + enqueueSalesTask 串行）
  ok('A5 main.ts config:set myWxid 钩子（previousMyWxid 比较 + switchBusinessDbsForWxid）',
    /const previousMyWxid = key === 'myWxid' \? String\(configService\?\.get\('myWxid'\) \?\? ''\) : ''/.test(mainSrc) &&
    /key === 'myWxid' && configService && String\(value \?\? ''\) !== previousMyWxid/.test(mainSrc) &&
    /switchBusinessDbsForWxid\(currentBusinessWxid\(\)\)/.test(mainSrc) &&
    /await enqueueSalesTask\(async \(\) =>/.test(mainSrc) &&
    /migrateLegacyBusinessDbs\(userData, wxid\)/.test(mainSrc) &&
    /await crmDbService\.reopenForWxid\(userData, wxid\)/.test(mainSrc) &&
    /await salesDbService\.reopenForWxid\(userData, wxid\)/.test(mainSrc))

  // A6: 启动迁移在两服务 initialize 之前（index 严格比较）
  const migrateIdx = mainSrc.indexOf('migrateLegacyBusinessDbs(app.getPath(\'userData\'), startupWxid)')
  const salesInitIdx = mainSrc.indexOf('salesDbService.initialize(app.getPath(\'userData\'), startupWxid)')
  const crmInitIdx = mainSrc.indexOf('crmDbService.initialize(app.getPath(\'userData\'), startupWxid)')
  ok('A6 main.ts 启动：迁移在 sales/crm initialize 之前且传 startupWxid',
    migrateIdx > -1 && salesInitIdx > migrateIdx && crmInitIdx > migrateIdx)

  // A7: 归档 IPC
  ok('A7 main.ts 归档 IPC chat:archiveBusinessData（两库 archiveCurrentDb + reopen 新空库 + enqueueSalesTask）',
    /ipcMain\.handle\('chat:archiveBusinessData'/.test(mainSrc) &&
    /svc\.archiveCurrentDb\(\)/.test(mainSrc) &&
    /svc\.currentDbPath\(\)/.test(mainSrc) &&
    /await crmDbService\.reopenForWxid\(userData, wxid\)/.test(mainSrc) &&
    /await salesDbService\.reopenForWxid\(userData, wxid\)/.test(mainSrc))

  // A8: crmIpcHandlers initialize 补 wxid 参
  ok('A8 crmIpcHandlers initialize 补 wxid（config.getMyWxidCleaned）',
    /crmDbService\.initialize\(app\.getPath\('userData'\), config\.getMyWxidCleaned\(\) \|\| undefined\)/.test(ipcSrc))

  // A9: backupService 覆盖 suffixed 库
  ok('A9 backupService 备份清单覆盖 weflow-(crm|sales)-<wxid>.db（glob + .archived 排除）',
    /readdirSync\(userData\)/.test(backupRaw) &&
    /\^weflow-\(crm\|sales\)-\[\^\/\\\\\]\+\\\.db\$\/i/.test(backupRaw) &&
    /\.archived-/.test(backupRaw))

  // A10: preload + d.ts 桥接
  ok('A10 桥接齐全（preload archiveBusinessData + electron.d.ts 类型）',
    /archiveBusinessData: \(\) => ipcRenderer\.invoke\('chat:archiveBusinessData'\)/.test(preloadSrc) &&
    /archiveBusinessData: \(\) => Promise<\{/.test(dtsSrc) &&
    /archived\?: Array<\{ from: string; to: string \}>/.test(dtsSrc))

  // A11: 设置页按钮
  ok('A11 设置页「业务数据归档」区（confirm 确认 + chat.archiveBusinessData 调用）',
    settingsSrc.includes('业务数据归档') &&
    /window\.confirm\(/.test(settingsSrc) &&
    /chat\.archiveBusinessData\(\)/.test(settingsSrc))

  // ── B. 行为（真实 sql.js，tmpdir） ─────────────────────────────────────────
  // B12: sanitize 单元
  ok('B12 sanitizeWxidForDbName（保留字母数字下划线连字符 / 其余转 - / 空回空）',
    sanitizeWxidForDbName('wxid_abc-123') === 'wxid_abc-123' &&
    sanitizeWxidForDbName('a b/c.d') === 'a-b-c-d' &&
    sanitizeWxidForDbName('  ') === '' &&
    sanitizeWxidForDbName(undefined as unknown as string) === '')

  // B13: 迁移行为
  const mdir = mkdtempSync(join(tmpdir(), 'acct-iso-mig-'))
  writeFileSync(join(mdir, 'weflow-crm.db'), Buffer.from('legacy-crm'))
  const moved = migrateLegacyBusinessDbs(mdir, 'wxid_a')
  ok('B13a 迁移 rename（crm legacy → suffixed，原文件消失）',
    moved.length === 1 && moved[0].kind === 'crm' &&
    existsSync(join(mdir, 'weflow-crm-wxid_a.db')) && !existsSync(join(mdir, 'weflow-crm.db')))
  const moved2 = migrateLegacyBusinessDbs(mdir, 'wxid_a')
  ok('B13b 二次调用幂等（无迁移）', moved2.length === 0)
  writeFileSync(join(mdir, 'weflow-sales.db'), Buffer.from('legacy-sales'))
  writeFileSync(join(mdir, 'weflow-sales-wxid_a.db'), Buffer.from('existing'))
  const moved3 = migrateLegacyBusinessDbs(mdir, 'wxid_a')
  ok('B13c 两者共存不动（不覆盖 suffixed、不删 legacy）',
    moved3.length === 0 && existsSync(join(mdir, 'weflow-sales.db')) &&
    existsSync(join(mdir, 'weflow-sales-wxid_a.db')) && existsSync(join(mdir, 'weflow-crm-wxid_a.db')))
  const moved4 = migrateLegacyBusinessDbs(mdir, '')
  ok('B13d 空 wxid no-op', moved4.length === 0 && existsSync(join(mdir, 'weflow-sales.db')))
  rmSync(mdir, { recursive: true, force: true })

  // 归档命名格式
  const stampDate = new Date(2026, 7, 29, 10, 15, 0)
  ok('B14 归档命名 <原名>.archived-<yyyyMMdd-HHmmss>.db',
    archiveStampOf(stampDate) === '20260829-101500' &&
    archivedDbName('weflow-crm-wxid_a.db', stampDate) === 'weflow-crm-wxid_a.db.archived-20260829-101500.db')

  // B14b: findExistingBusinessDb（真实库只读脚本的路径解析：suffixed mtime 最新优先 / 排除 .archived / legacy 回退 / 无则 null）
  const fdir = mkdtempSync(join(tmpdir(), 'acct-iso-find-'))
  const oldDb = join(fdir, 'weflow-crm-wxid_old.db')
  const newDb = join(fdir, 'weflow-crm-wxid_new.db')
  writeFileSync(oldDb, 'a')
  writeFileSync(newDb, 'b')
  utimesSync(newDb, new Date(), new Date(2020, 0, 1))
  writeFileSync(join(fdir, 'weflow-crm-wxid_new.db.archived-20260829-101500.db'), 'c')
  const legacyDir = mkdtempSync(join(tmpdir(), 'acct-iso-find2-'))
  writeFileSync(join(legacyDir, 'weflow-sales.db'), 'l')
  ok('B14b findExistingBusinessDb（suffixed mtime 最新优先 / 排除 .archived / legacy 回退 / 无则 null）',
    findExistingBusinessDb(fdir, 'crm') === oldDb &&
    findExistingBusinessDb(legacyDir, 'sales') === join(legacyDir, 'weflow-sales.db') &&
    findExistingBusinessDb(fdir, 'sales') === null)
  rmSync(fdir, { recursive: true, force: true })
  rmSync(legacyDir, { recursive: true, force: true })

  // B15: CRM 库隔离
  const dir = mkdtempSync(join(tmpdir(), 'acct-iso-crm-'))
  await crmDbService.initialize(dir, 'wxidA')
  const accId = crmDbService.create('account', { name: '客户A', created_at: Date.now(), updated_at: Date.now() })
  ok('B15a wxidA 写入成功', accId > 0)
  await crmDbService.reopenForWxid(dir, 'wxidB')
  ok('B15b 切 wxidB 后客户为空 + wxidA 库文件已落盘',
    crmDbService.list('account').length === 0 &&
    existsSync(join(dir, 'weflow-crm-wxidA.db')) &&
    crmDbService.currentDbPath() === join(dir, 'weflow-crm-wxidB.db'))
  await crmDbService.reopenForWxid(dir, 'wxidA')
  ok('B15c 切回 wxidA 数据原样恢复', crmDbService.list('account').length === 1 && crmDbService.list('account')[0].name === '客户A')

  // B16: sales 库隔离
  await salesDbService.reopenForWxid(dir, 'wxidA')
  salesDbService.customerUpsert({ session_id: 's1', display_name: '客户甲' })
  await salesDbService.reopenForWxid(dir, 'wxidB')
  ok('B16a sales 切 wxidB 后画像为空 + wxidA 库文件已落盘',
    salesDbService.customerGetBySession('s1') === undefined &&
    existsSync(join(dir, 'weflow-sales-wxidA.db')))
  await salesDbService.reopenForWxid(dir, 'wxidA')
  ok('B16b sales 切回 wxidA 数据原样恢复', salesDbService.customerGetBySession('s1')?.display_name === '客户甲')

  // B17: 归档行为（当前 wxidA 两库均有数据）
  crmDbService.create('account', { name: '客户B', created_at: Date.now(), updated_at: Date.now() })
  const crmArchived = crmDbService.archiveCurrentDb()
  const salesArchived = salesDbService.archiveCurrentDb()
  ok('B17 归档产出 .archived-<时间戳>.db 文件 + 服务卸载',
    !!crmArchived && crmArchived.includes('.archived-') && existsSync(crmArchived) &&
    !!salesArchived && salesArchived.includes('.archived-') && existsSync(salesArchived) &&
    crmDbService.currentDbPath() === null && salesDbService.currentDbPath() === null)
  await crmDbService.reopenForWxid(dir, 'wxidA')
  await salesDbService.reopenForWxid(dir, 'wxidA')
  ok('B18 归档后 reopen 新空库', crmDbService.list('account').length === 0 && salesDbService.customerGetBySession('s1') === undefined)

  // B19: 空 wxid 回退 legacy 名 + 并发 initialize 去重（先归档卸载当前库，模拟冷启动双路径）
  const dir2 = mkdtempSync(join(tmpdir(), 'acct-iso-legacy-'))
  crmDbService.archiveCurrentDb()
  await Promise.all([
    crmDbService.initialize(dir2),
    crmDbService.initialize(dir2)
  ])
  ok('B19 空 wxid legacy 名 + 并发 initialize 去重（同一 dbPath）',
    crmDbService.currentDbPath() === join(dir2, 'weflow-crm.db'))
  await salesDbService.reopenForWxid(dir2)
  ok('B20 sales 空 wxid legacy 名', salesDbService.currentDbPath() === join(dir2, 'weflow-sales.db'))

  // ── 汇总 ──────────────────────────────────────────────────────────────────
  console.log(`\n账号分库护栏：${pass} 通过 / ${fail} 失败`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
