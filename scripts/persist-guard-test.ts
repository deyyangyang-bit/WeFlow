/**
 * persist-guard-test.ts —— §2.52 原子落盘 + 启动守卫 副本隔离验证
 *
 * 事故背景（HANDOVER §2.52）：sql.js 旧 persist 直写目标文件（先截断为 0 再写入），
 * 窗口期被 kill → 磁盘 0 字节 → 启动静默初始化空库 → persist 把空库写回 → 数据全灭。
 *
 * 覆盖：
 *   A. 原子落盘 atomicWriteFileSync：内容正确 / 无 .tmp- 残留 / 重复写幂等
 *   B. salesDbService 全链路：flushNow 落盘内容正确（哨兵行对账）/ 无 tmp 残留 / 重复 flush 幂等
 *   C. 0 字节文件启动：有备份 → 留证 + 从备份恢复（core 日志断言 + service 端到端数据对账）
 *   D. 0 字节文件启动：无备份 → 留证 + 空库启动 + ERROR 日志「从空库启动，原文件已损坏」
 *   E. corrupt（非 0 字节不可解析）文件：有备份 → 恢复；留证不覆盖已有留证（同名加毫秒后缀）
 *   F. manifest 校验：最新备份 size 不符/manifest 缺失 → 跳过，回退更早合规备份
 *   G. crmDb 恢复成功补写 audit_event（action='db_recover'）
 *
 * 隔离：WEFLOW_WORKER='1' + 全部 /tmp 临时目录 + fresh 库，绝不碰 live 库与真实配置。
 * 运行：npx tsx scripts/persist-guard-test.ts
 */
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// 隔离落盘路径（必须在 import 前设置；手法同 identity-test）
const isoDir = mkdtempSync(join(tmpdir(), 'persist-guard-test-'))
process.env.WEFLOW_WORKER = '1'
process.env.WEFLOW_USER_DATA_PATH = isoDir
process.env.WEFLOW_CONFIG_CWD = isoDir

import initSqlJs from 'sql.js'
import { salesDbService } from '../electron/services/salesDbService'
import { crmDbService } from '../electron/services/crmDbService'
import {
  atomicWriteFileSync, loadBusinessDbWithGuard, quarantineCorruptDbFile,
  type GuardLogLevel
} from '../electron/services/atomicPersist'
import { autoBackupLocalRoot, backupDirName } from '../electron/services/autoBackupCore'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; console.log(`  ✅ ${name}`) } else { fail++; console.log(`  ❌ ${name} ${detail}`) }
}

const WASM = join(__dirname, '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm')

/** 目录下残留 .tmp- 文件清单（原子写不得留残渣） */
function tmpResidues(dir: string): string[] {
  return readdirSync(dir).filter((f) => f.includes('.tmp-'))
}
/** 目录下 .corrupt- 留证文件清单 */
function corruptFiles(dir: string): string[] {
  return readdirSync(dir).filter((f) => f.includes('.corrupt-'))
}

/** 日志收集器 */
function makeLogCollector(): { logs: Array<{ level: GuardLogLevel; msg: string }>; collect: (l: GuardLogLevel, m: string) => void } {
  const logs: Array<{ level: GuardLogLevel; msg: string }> = []
  return { logs, collect: (level, msg) => { logs.push({ level, msg }) } }
}

/** 造一份合规自动备份目录（同名 db 副本 + manifest.json，size 与实际一致） */
function makeBackupDir(userData: string, dirName: string, dbFileName: string, dbSrcPath: string, opts?: { sizeOverride?: number; skipManifest?: boolean }): string {
  const dir = join(autoBackupLocalRoot(userData), dirName)
  mkdirSync(dir, { recursive: true })
  const dest = join(dir, dbFileName)
  copyFileSync(dbSrcPath, dest)
  if (!opts?.skipManifest) {
    const manifest = {
      app: '0.0.0-test', createdAt: new Date().toISOString(), trigger: 'manual',
      files: [{ kind: 'sales', name: dbFileName, size: opts?.sizeOverride ?? statSync(dest).size }],
      missing: [], layers: { local: { status: 'ok', dir }, network: { status: 'skipped_not_configured' } }, durationMs: 1
    }
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  }
  return dir
}

async function main(): Promise<void> {
  const SQL = await initSqlJs({ locateFile: () => WASM })

  // ═══ A. 原子落盘 atomicWriteFileSync ═══
  console.log('═══ A. 原子落盘（atomicWriteFileSync）═══')
  const dirA = mkdtempSync(join(tmpdir(), 'pg-a-'))
  const targetA = join(dirA, 'weflow-sales.db')
  const payload1 = Buffer.from('payload-v1')
  const payload2 = Buffer.from('payload-v2-longer')
  atomicWriteFileSync(targetA, payload1)
  ok('A1 写入后内容正确', readFileSync(targetA).equals(payload1))
  ok('A2 无 .tmp- 残留', tmpResidues(dirA).length === 0, tmpResidues(dirA).join(','))
  atomicWriteFileSync(targetA, payload2)
  atomicWriteFileSync(targetA, payload2)
  ok('A3 重复写幂等（最终内容 = 最后一次）', readFileSync(targetA).equals(payload2))
  ok('A4 重复写后仍无 .tmp- 残留', tmpResidues(dirA).length === 0)

  // ═══ B. salesDbService 全链路原子落盘 ═══
  console.log('\n═══ B. salesDbService flushNow 原子落盘（哨兵行对账）═══')
  const dirB = mkdtempSync(join(tmpdir(), 'pg-b-'))
  await salesDbService.initialize(dirB)
  const marker = `persist-guard-marker-${Date.now()}`
  salesDbService.todoCreate({
    trigger_type: 'manual', title: marker, action_type: 'custom',
    status: 'pending', priority_score: 0, created_by: 'manual'
  } as Parameters<typeof salesDbService.todoCreate>[0])
  salesDbService.flushNow()
  const dbFileB = join(dirB, 'weflow-sales.db')
  ok('B1 flushNow 后 db 文件存在且非 0 字节', existsSync(dbFileB) && statSync(dbFileB).size > 0)
  ok('B2 无 .tmp- 残留', tmpResidues(dirB).length === 0, tmpResidues(dirB).join(','))
  {
    // sql.js 直开落盘文件，哨兵行必须在（不经 service 内存库）
    const raw = new SQL.Database(readFileSync(dbFileB))
    const res = raw.exec(`SELECT COUNT(*) FROM follow_up_task WHERE title = '${marker}'`)
    raw.close()
    ok('B3 落盘文件含哨兵行（sql.js 直开对账）', Number(res[0]?.values[0]?.[0]) === 1)
  }
  const sizeAfterFirst = statSync(dbFileB).size
  salesDbService.flushNow()
  salesDbService.flushNow()
  ok('B4 重复 flushNow 幂等（仍可开、哨兵行仍在、无 tmp 残留）', (() => {
    const raw = new SQL.Database(readFileSync(dbFileB))
    const res = raw.exec(`SELECT COUNT(*) FROM follow_up_task WHERE title = '${marker}'`)
    raw.close()
    return Number(res[0]?.values[0]?.[0]) === 1 && tmpResidues(dirB).length === 0 && statSync(dbFileB).size >= sizeAfterFirst
  })())

  // ═══ C. 0 字节文件启动：有备份 → 留证 + 恢复 ═══
  console.log('\n═══ C. 0 字节启动 → 从自动备份恢复 ═══')
  // C1 core 级（日志断言）：用 B 产出的真实 sales db 造备份
  const dirC = mkdtempSync(join(tmpdir(), 'pg-c-'))
  makeBackupDir(dirC, backupDirName(new Date('2026-09-04T10:00:00')), 'weflow-sales.db', dbFileB)
  writeFileSync(join(dirC, 'weflow-sales.db'), Buffer.alloc(0)) // 模拟截断窗口被杀
  {
    const { logs, collect } = makeLogCollector()
    const res = loadBusinessDbWithGuard(SQL, join(dirC, 'weflow-sales.db'), dirC, '[Test]', collect)
    ok('C1 outcome=restored', res.outcome === 'restored')
    ok('C2 留证文件存在（.corrupt-）', corruptFiles(dirC).length === 1 && existsSync(res.corruptPath || ''), corruptFiles(dirC).join(','))
    ok('C3 留证文件就是那份 0 字节坏文件', statSync(res.corruptPath!).size === 0)
    ok('C4 ERROR 日志打出「0 字节」与「禁止静默初始化空库」',
      logs.some((l) => l.level === 'ERROR' && l.msg.includes('0 字节') && l.msg.includes('禁止静默初始化空库')))
    ok('C5 WARN 日志打出「已从自动备份恢复」', logs.some((l) => l.level === 'WARN' && l.msg.includes('已从自动备份恢复')))
    ok('C6 restoredFrom 指向备份目录文件', (res.restoredFrom || '').includes('we-flow-auto-'))
    const cnt = res.db.exec(`SELECT COUNT(*) FROM follow_up_task WHERE title = '${marker}'`)
    res.db.close()
    ok('C7 恢复件含哨兵行（数据回来了）', Number(cnt[0]?.values[0]?.[0]) === 1)
    ok('C8 恢复后目标路径非 0 字节', statSync(join(dirC, 'weflow-sales.db')).size > 0)
  }
  // C2 service 端到端：0 字节 + 备份 → initialize 恢复，应用链路可读回哨兵行
  const dirC2 = mkdtempSync(join(tmpdir(), 'pg-c2-'))
  makeBackupDir(dirC2, backupDirName(new Date('2026-09-04T10:05:00')), 'weflow-sales.db', dbFileB)
  writeFileSync(join(dirC2, 'weflow-sales.db'), Buffer.alloc(0))
  salesDbService.close() // 关掉 dirB 的库（persistNow 落 dirB，无碍）
  await salesDbService.initialize(dirC2)
  const found = salesDbService.todoList({ limit: 1000000 }).filter((t) => t.title === marker).length
  ok('C9 service 端到端：0 字节启动后从备份恢复，哨兵行可读回', found === 1, `found=${found}`)
  ok('C10 service 端到端：留证文件存在', corruptFiles(dirC2).length === 1, corruptFiles(dirC2).join(','))

  // ═══ D. 0 字节文件启动：无备份 → 留证 + 空库启动 + ERROR 日志 ═══
  console.log('\n═══ D. 0 字节启动 → 无备份空库启动（留证 + ERROR 日志）═══')
  const dirD = mkdtempSync(join(tmpdir(), 'pg-d-'))
  writeFileSync(join(dirD, 'weflow-sales.db'), Buffer.alloc(0))
  {
    const { logs, collect } = makeLogCollector()
    const res = loadBusinessDbWithGuard(SQL, join(dirD, 'weflow-sales.db'), dirD, '[Test]', collect)
    ok('D1 outcome=fresh-corrupt', res.outcome === 'fresh-corrupt')
    ok('D2 坏文件留证存在（0 字节）', corruptFiles(dirD).length === 1 && statSync(res.corruptPath!).size === 0)
    ok('D3 ERROR 日志「从空库启动，原文件已损坏」',
      logs.some((l) => l.level === 'ERROR' && l.msg.includes('从空库启动，原文件已损坏')), JSON.stringify(logs))
    const tables = res.db.exec("SELECT COUNT(*) FROM sqlite_master WHERE type='table'")
    res.db.close()
    ok('D4 空库可正常打开（无表）', Number(tables[0]?.values[0]?.[0]) === 0)
  }

  // ═══ E. corrupt 文件（非 0 字节不可解析）→ 恢复；留证绝不覆盖 ═══
  console.log('\n═══ E. corrupt 文件启动 + 留证不覆盖 ═══')
  const dirE = mkdtempSync(join(tmpdir(), 'pg-e-'))
  makeBackupDir(dirE, backupDirName(new Date('2026-09-04T10:10:00')), 'weflow-sales.db', dbFileB)
  writeFileSync(join(dirE, 'weflow-sales.db'), Buffer.from('this-is-not-a-sqlite-database'))
  {
    const { logs, collect } = makeLogCollector()
    const res = loadBusinessDbWithGuard(SQL, join(dirE, 'weflow-sales.db'), dirE, '[Test]', collect)
    ok('E1 corrupt 文件 outcome=restored', res.outcome === 'restored')
    ok('E2 ERROR 日志打出「打开/解析失败」', logs.some((l) => l.level === 'ERROR' && l.msg.includes('打开/解析失败')))
    const cnt = res.db.exec(`SELECT COUNT(*) FROM follow_up_task WHERE title = '${marker}'`)
    res.db.close()
    ok('E3 恢复件数据正确', Number(cnt[0]?.values[0]?.[0]) === 1)
    ok('E4 corrupt 留证存在且内容是坏数据', corruptFiles(dirE).length === 1 &&
      readFileSync(corruptFiles(dirE).map((f) => join(dirE, f))[0]).toString() === 'this-is-not-a-sqlite-database')
  }
  // 留证不覆盖：同一时刻戳两次 quarantine → 两份并存
  const dirE2 = mkdtempSync(join(tmpdir(), 'pg-e2-'))
  const junkPath = join(dirE2, 'weflow-sales.db')
  const fixedAt = new Date('2026-09-04T12:00:00')
  writeFileSync(junkPath, Buffer.from('junk-1'))
  const q1 = quarantineCorruptDbFile(junkPath, fixedAt)
  writeFileSync(junkPath, Buffer.from('junk-2'))
  const q2 = quarantineCorruptDbFile(junkPath, fixedAt)
  ok('E5 同时刻戳两次留证 → 两份并存不覆盖', !!q1 && !!q2 && q1 !== q2 && existsSync(q1!) && existsSync(q2!), `${q1} / ${q2}`)
  ok('E6 两份留证内容各自完整', readFileSync(q1!).toString() === 'junk-1' && readFileSync(q2!).toString() === 'junk-2')

  // ═══ F. manifest 校验：不符/缺失的备份跳过，回退更早合规备份 ═══
  console.log('\n═══ F. manifest 校验回退 ═══')
  const dirF = mkdtempSync(join(tmpdir(), 'pg-f-'))
  // 更早一份合规备份（含哨兵行）
  makeBackupDir(dirF, backupDirName(new Date('2026-09-04T09:00:00')), 'weflow-sales.db', dbFileB)
  // 最新一份 manifest size 登记错误（模拟半截副本）
  makeBackupDir(dirF, backupDirName(new Date('2026-09-04T11:00:00')), 'weflow-sales.db', dbFileB, { sizeOverride: 999999 })
  // 中间一份 manifest 缺失
  makeBackupDir(dirF, backupDirName(new Date('2026-09-04T10:00:00')), 'weflow-sales.db', dbFileB, { skipManifest: true })
  writeFileSync(join(dirF, 'weflow-sales.db'), Buffer.alloc(0))
  {
    const { logs, collect } = makeLogCollector()
    const res = loadBusinessDbWithGuard(SQL, join(dirF, 'weflow-sales.db'), dirF, '[Test]', collect)
    ok('F1 outcome=restored', res.outcome === 'restored')
    ok('F2 回退到最早合规备份（09:00）', (res.restoredFrom || '').includes('0900'), res.restoredFrom)
    ok('F3 size 不符的备份被跳过（WARN 日志）', logs.some((l) => l.level === 'WARN' && l.msg.includes('≠ 实际')))
    ok('F4 manifest 缺失的备份被跳过（WARN 日志）', logs.some((l) => l.level === 'WARN' && l.msg.includes('manifest.json 缺失/损坏')))
    res.db.close()
  }

  // ═══ G. crmDb 恢复成功补写 audit_event ═══
  console.log('\n═══ G. crmDb 恢复 → audit_event 补写 db_recover ═══')
  const dirG1 = mkdtempSync(join(tmpdir(), 'pg-g1-'))
  await crmDbService.initialize(dirG1) // fresh 全 schema crm 库（含 audit_event 表）
  crmDbService.persistNow()
  const crmDbFile = join(dirG1, 'weflow-crm.db')
  const dirG2 = mkdtempSync(join(tmpdir(), 'pg-g2-'))
  makeBackupDir(dirG2, backupDirName(new Date('2026-09-04T10:20:00')), 'weflow-crm.db', crmDbFile)
  writeFileSync(join(dirG2, 'weflow-crm.db'), Buffer.alloc(0))
  await crmDbService.reopenForWxid(dirG2) // persistNow(dirG1) → detach → initialize(dirG2) 走守卫
  ok('G1 crmDb 0 字节启动后从备份恢复（留证存在）', corruptFiles(dirG2).length === 1, corruptFiles(dirG2).join(','))
  const audits = crmDbService.all("SELECT * FROM audit_event WHERE action = 'db_recover'", [])
  ok('G2 audit_event 补写 db_recover 一条', audits.length === 1, `len=${audits.length}`)
  ok('G3 审计 actor=system:persist-guard', String(audits[0]?.actor || '') === 'system:persist-guard', String(audits[0]?.actor || ''))
  const detail = String(audits[0]?.detail || '')
  ok('G4 审计 detail 含留证与恢复来源', detail.includes('corruptPath') && detail.includes('restoredFrom') && detail.includes('we-flow-auto-'), detail)

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
