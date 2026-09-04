/**
 * auto-backup-test.ts —— Phase 1 W3「自动备份」（PRD 1.1 双保险定时备份）副本隔离验证
 *
 * 覆盖（对应交付验收五条）：
 *   ① 备份产出完整：本机层 + 网络层各产出 两 db 副本 + manifest.json（版本/时间/大小/两层状态）
 *   ② 恢复演练：删掉副本库 → 从备份恢复 → sql.js 直开恢复件，行数对账一致
 *   ③ 保留策略：造 21 份 → 每层只留最近 20 份、最旧被删（小尺寸假库，独立 userData）
 *   ④ 网络层不可达：skipped_unreachable 跳过、不报错、整体 ok；空路径 skipped_not_configured
 *   ⑤ 二次运行幂等：同分钟重跑同目录覆盖，目录数不变、文件完好、审计逐次留痕
 *
 * ⛔ 同 dry-run-all 铁律：源库复制到 /tmp 副本 → 应用链路 initialize → 绝不触碰 live 库。
 * 用法：npx tsx scripts/auto-backup-test.ts
 */
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'

// 隔离 config 落盘路径（必须在 import config 前设置）
const isoDir = mkdtempSync(join(tmpdir(), 'auto-backup-test-'))
process.env.WEFLOW_USER_DATA_PATH = isoDir
process.env.WEFLOW_CONFIG_CWD = isoDir

import initSqlJs from 'sql.js'
import { crmDbService } from '../electron/services/crmDbService'
import { salesDbService } from '../electron/services/salesDbService'
import { findExistingBusinessDb } from '../electron/services/businessDbPath'
import { ConfigService } from '../electron/services/config'
import { executeAutoBackup, initAutoBackup, getAutoBackupStatus, parseAutoBackupTime, lastAutoBackupSuccessAt } from '../electron/services/autoBackupService'
import { runAutoBackup, autoBackupLocalRoot, listBackupDirs, backupDirName, AUTO_BACKUP_KEEP } from '../electron/services/autoBackupCore'

let pass = 0, fail = 0
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; console.log(`  ✅ ${name}`) } else { fail++; console.log(`  ❌ ${name} ${detail}`) }
}

/** sql.js 直开 db 文件数行数（恢复演练对账用，不经 service 单例） */
async function countRowsOf(dbFile: string, table: string): Promise<number> {
  const SQL = await initSqlJs({ locateFile: () => join(__dirname, '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm') })
  const db = new SQL.Database(readFileSync(dbFile))
  try {
    const res = db.exec(`SELECT COUNT(*) FROM ${table}`)
    return Number(res[0]?.values[0]?.[0] ?? -1)
  } finally {
    db.close()
  }
}

async function main(): Promise<void> {
  const userData = join(homedir(), 'Library', 'Application Support', 'weflow')
  const crmSrc = findExistingBusinessDb(userData, 'crm')
  const salesSrc = findExistingBusinessDb(userData, 'sales')
  if (!crmSrc || !salesSrc) { console.error('未找到 live 业务库'); process.exit(1) }

  const dir = mkdtempSync(join(tmpdir(), 'auto-backup-data-'))
  copyFileSync(crmSrc, join(dir, 'weflow-crm.db'))
  copyFileSync(salesSrc, join(dir, 'weflow-sales.db'))
  await crmDbService.initialize(dir)
  await salesDbService.initialize(dir)
  console.log(`副本试跑：crm ← ${crmSrc.replace(homedir(), '~')}`)

  const config = ConfigService.getInstance()
  initAutoBackup({ config, userData: dir, appVersion: '0.0.0-test' })

  // 往 sales 副本库写一行哨兵待办，并立刻备份（<500ms 防抖窗口内）——
  // 专测「备份前 flushNow 强制落盘」：恢复件里必须含这行，否则说明备出了落盘前的旧文件
  const markerTitle = `auto-backup-test-marker-${Date.now()}`
  salesDbService.todoCreate({
    trigger_type: 'manual', title: markerTitle, action_type: 'custom',
    status: 'pending', priority_score: 0, created_by: 'manual'
  } as Parameters<typeof salesDbService.todoCreate>[0])
  const todoBefore = salesDbService.todoList({ limit: 1000000 }).filter((t) => t.title === markerTitle).length
  console.log(`  哨兵行已写入内存库（todoList 命中 ${todoBefore}），立即触发备份`)

  // ═══ ① 备份产出完整（本机层 + 网络层）═══
  console.log('\n═══ ① 备份产出完整 ═══')
  const netDir = mkdtempSync(join(tmpdir(), 'auto-backup-net-'))
  config.set('autoBackupNetworkPath', netDir)
  const r1 = executeAutoBackup('manual')
  const localDir = join(autoBackupLocalRoot(dir), r1.dirName)
  check('整体 ok', r1.ok)
  check('本机层目录存在', existsSync(localDir), localDir)
  check('本机层含 crm db 副本', existsSync(join(localDir, 'weflow-crm.db')))
  check('本机层含 sales db 副本', existsSync(join(localDir, 'weflow-sales.db')))
  check('本机层含 manifest.json', existsSync(join(localDir, 'manifest.json')))
  const m1 = r1.manifest
  check('manifest 记 app 版本', m1.app === '0.0.0-test')
  check('manifest 记两个 db 文件大小', m1.files.length === 2 && m1.files.every((f) => f.size > 0))
  check('manifest 本机层 ok', m1.layers.local.status === 'ok')
  check('manifest 网络层 ok', m1.layers.network.status === 'ok', m1.layers.network.error || '')
  const netBackupDir = join(netDir, r1.dirName)
  check('网络层目录含两 db + manifest', existsSync(join(netBackupDir, 'weflow-crm.db')) && existsSync(join(netBackupDir, 'weflow-sales.db')) && existsSync(join(netBackupDir, 'manifest.json')))
  const audit1 = crmDbService.all("SELECT * FROM audit_event WHERE action = 'auto_backup'", [])
  check('审计 auto_backup 已写', audit1.length >= 1)
  check('审计 detail 含两层状态', String(audit1[0]?.detail || '').includes('"local":"ok"') && String(audit1[0]?.detail || '').includes('"network":"ok"'), String(audit1[0]?.detail || ''))
  const st1 = getAutoBackupStatus()
  check('status：上次时间 = 本次 manifest', st1.last?.at === m1.createdAt)
  check('status：下次计划时刻合法', !!st1.nextPlannedAt && /^\d{2}:\d{2}$/.test(st1.configuredTime))
  check('parseAutoBackupTime 非法值回退 14:37', parseAutoBackupTime('99:99').hh === 14 && parseAutoBackupTime('').mm === 37)
  check('lastAutoBackupSuccessAt 已更新', lastAutoBackupSuccessAt(dir) === Date.parse(m1.createdAt))

  // ═══ ② 恢复演练：删副本库 → 从备份恢复 → 行数对账 ═══
  console.log('\n═══ ② 恢复演练 ═══')
  const leadBefore = Number(crmDbService.all('SELECT COUNT(*) AS c FROM lead', [])[0].c)
  const todoAllBefore = salesDbService.todoList({ limit: 1000000 }).length
  console.log(`  对账基线：lead=${leadBefore} follow_up_task=${todoAllBefore}（含哨兵行）`)
  const lossDir = mkdtempSync(join(tmpdir(), 'auto-backup-loss-'))
  copyFileSync(join(localDir, 'weflow-crm.db'), join(lossDir, 'weflow-crm.db'))
  copyFileSync(join(localDir, 'weflow-sales.db'), join(lossDir, 'weflow-sales.db'))
  // 模拟数据丢失：删掉副本库
  rmSync(join(lossDir, 'weflow-crm.db'))
  rmSync(join(lossDir, 'weflow-sales.db'))
  check('副本库已删除', !existsSync(join(lossDir, 'weflow-crm.db')) && !existsSync(join(lossDir, 'weflow-sales.db')))
  // 从本机层备份恢复
  copyFileSync(join(localDir, 'weflow-crm.db'), join(lossDir, 'weflow-crm.db'))
  copyFileSync(join(localDir, 'weflow-sales.db'), join(lossDir, 'weflow-sales.db'))
  const leadAfter = await countRowsOf(join(lossDir, 'weflow-crm.db'), 'lead')
  const todoAfter = await countRowsOf(join(lossDir, 'weflow-sales.db'), 'follow_up_task')
  check('恢复后 lead 行数一致', leadAfter === leadBefore, `${leadAfter} vs ${leadBefore}`)
  check('恢复后 follow_up_task 行数一致（含 500ms 防抖窗口内写入的哨兵行 → flush 生效）', todoAfter === todoAllBefore && todoAllBefore >= todoBefore && todoBefore === 1, `${todoAfter} vs ${todoAllBefore}`)

  // ═══ ③ 保留策略：造 21 份 → 每层只留最近 20 ═══
  console.log('\n═══ ③ 保留策略（21 份 → 留 20）═══')
  const dirC = mkdtempSync(join(tmpdir(), 'auto-backup-retention-'))
  const netC = mkdtempSync(join(tmpdir(), 'auto-backup-retention-net-'))
  // 小尺寸假库（21 份 × 两层 × 真实库太大，保留策略只关心目录滚动）
  writeFileSync(join(dirC, 'weflow-crm.db'), Buffer.alloc(1024, 1))
  writeFileSync(join(dirC, 'weflow-sales.db'), Buffer.alloc(1024, 2))
  const base = new Date('2026-09-01T10:00:00')
  for (let i = 0; i < 21; i++) {
    const r = runAutoBackup({ userData: dirC, networkPath: netC, appVersion: 't', now: new Date(base.getTime() + i * 60 * 1000) })
    if (!r.ok) { check(`第 ${i + 1} 份备份 ok`, false, r.error || ''); break }
  }
  const localDirs = listBackupDirs(autoBackupLocalRoot(dirC))
  const netDirs = listBackupDirs(netC)
  check(`本机层只剩 ${AUTO_BACKUP_KEEP} 份`, localDirs.length === AUTO_BACKUP_KEEP, `实际 ${localDirs.length}`)
  check(`网络层只剩 ${AUTO_BACKUP_KEEP} 份`, netDirs.length === AUTO_BACKUP_KEEP, `实际 ${netDirs.length}`)
  const oldestExpected = backupDirName(new Date(base.getTime()))
  check('最旧一份已被删', !localDirs.includes(oldestExpected) && !netDirs.includes(oldestExpected))
  check('最新一份保留', localDirs.includes(backupDirName(new Date(base.getTime() + 20 * 60 * 1000))))
  // 幂等清理：无新增时再跑不删
  const r3 = runAutoBackup({ userData: dirC, networkPath: netC, appVersion: 't', now: new Date(base.getTime() + 20 * 60 * 1000) })
  check('同刻重跑仍 20 份（覆盖同目录不膨胀）', listBackupDirs(autoBackupLocalRoot(dirC)).length === AUTO_BACKUP_KEEP && r3.ok)

  // ═══ ④ 网络层不可达：跳过不报错 ═══
  console.log('\n═══ ④ 网络层不可达 ═══')
  config.set('autoBackupNetworkPath', join(tmpdir(), 'auto-backup-nonexistent-share-xxx'))
  const r4 = executeAutoBackup('manual')
  check('不可达时整体仍 ok（本机兜底成功）', r4.ok)
  check('网络层记 skipped_unreachable', r4.manifest.layers.network.status === 'skipped_unreachable', r4.manifest.layers.network.status)
  const audit4 = crmDbService.all("SELECT * FROM audit_event WHERE action = 'auto_backup' ORDER BY id DESC LIMIT 1", [])
  check('审计记 network=skipped_unreachable', String(audit4[0]?.detail || '').includes('skipped_unreachable'), String(audit4[0]?.detail || ''))
  config.set('autoBackupNetworkPath', '')
  const r4b = executeAutoBackup('manual')
  check('空路径记 skipped_not_configured', r4b.ok && r4b.manifest.layers.network.status === 'skipped_not_configured')

  // ═══ ⑤ 二次运行幂等 ═══
  console.log('\n═══ ⑤ 二次运行幂等 ═══')
  const dirCountBefore = listBackupDirs(autoBackupLocalRoot(dir)).length
  const r5a = executeAutoBackup('manual')
  const r5b = executeAutoBackup('manual')
  const dirCountAfter = listBackupDirs(autoBackupLocalRoot(dir)).length
  // 同分钟重跑命中同目录覆盖（①④ 三次运行也可能同分钟同目录，故容忍 +0/+1）
  check('同分钟重跑同目录覆盖（目录数不膨胀）', r5a.dirName === r5b.dirName && dirCountAfter <= dirCountBefore + 1, `${dirCountBefore}→${dirCountAfter}`)
  check('重跑后文件完好', existsSync(join(autoBackupLocalRoot(dir), r5b.dirName, 'weflow-crm.db')) && existsSync(join(autoBackupLocalRoot(dir), r5b.dirName, 'manifest.json')))
  check('重跑 manifest 可解析', (() => { try { JSON.parse(readFileSync(join(autoBackupLocalRoot(dir), r5b.dirName, 'manifest.json'), 'utf-8')); return true } catch { return false } })())
  const audit5 = crmDbService.all("SELECT COUNT(*) AS c FROM audit_event WHERE action = 'auto_backup'", [])
  // ① r1 + ④ r4/r4b + ⑤ r5a/r5b = 5 次 executeAutoBackup，各写一条审计
  check('每次运行各写一条审计（不聚合不丢失）', Number(audit5[0].c) >= 5, `共 ${audit5[0].c} 条`)

  console.log(`\n═══ 结果：${pass} 通过 / ${fail} 失败 ═══`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
