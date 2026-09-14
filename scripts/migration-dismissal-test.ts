/**
 * migration-dismissal-test.ts —— 迁移失败/冲突项人工闭环（2026-09-14）
 *
 * 背景：模块② 归并的 no_identity_anchor 失败项（真实库 21 条：无 11 位手机号且无 session_id）
 * 此前每次启动都报失败且无人工出口。本刀新增 migration_dismissal 表 + 忽略/恢复 IPC +
 * 迁移扫描过滤。本测试锁定：
 *   a. dismissal 表往返（忽略→列出→恢复）
 *   b. 幂等（重复忽略 upsert 不重复行）
 *   c. 模块② 扫描过滤（忽略后 failures 减少、dismissed 计数上升；恢复后回归失败）
 *   d. 审计词典覆盖（migration_failure_dismiss / migration_failure_restore 已入 shared/auditDict）
 *   e. IPC/preload 接线（crm:migration:failure:dismiss / :restore / :dismissal:list）
 *   f. ENTITIES 白名单已注册 migration_dismissal（crmDb 漏注册静默失败前科）
 */
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let pass = 0, fail = 0
const ok = (name: string, cond: boolean) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.error(`  ✗ ${name}`) }
}

import { crmDbService } from '../electron/services/crmDbService'
import { migrate02AccountToCustomer } from '../electron/services/crmMigrationService'

const main = async () => {
const dbDir = mkdtempSync(join(tmpdir(), 'migration-dismissal-'))
await crmDbService.initialize(dbDir)

// ── a/b. dismissal 表往返与幂等 ──
console.log('a/b. dismissal 往返与幂等')
crmDbService.migrationDismiss('02-account-to-customer', 'account:999', '测试员')
let list = crmDbService.migrationDismissals('02-account-to-customer')
ok('a1 忽略后可列出', list.length === 1 && String(list[0].entity_key) === 'account:999')
ok('a2 记录操作人与时间', String(list[0].dismissed_by) === '测试员' && Number(list[0].dismissed_at) > 0)
crmDbService.migrationDismiss('02-account-to-customer', 'account:999', '测试员2')
list = crmDbService.migrationDismissals('02-account-to-customer')
ok('b1 重复忽略 upsert 不重复行', list.length === 1 && String(list[0].dismissed_by) === '测试员2')
crmDbService.migrationUndismiss('02-account-to-customer', 'account:999')
ok('a3 恢复后清单为空', crmDbService.migrationDismissals('02-account-to-customer').length === 0)

// ── c. 模块② 扫描过滤（临时库上跑真实迁移函数）──
console.log('c. 模块② 扫描过滤')
// 造一条无锚点 account（手机号非 11 位且无 session_id）
crmDbService.run("INSERT INTO account (name, phone, session_id, owner_sales, customer_id, updated_at) VALUES ('测试无锚点公司', '', NULL, '', NULL, ?)", [Date.now()])
const r1 = migrate02AccountToCustomer()
ok('c1 未忽略时计入失败', r1.failed === 1 && r1.dismissed === 0 && r1.failures.some((f) => f.key.startsWith('account:')))
const failKey = r1.failures[0].key
crmDbService.migrationDismiss('02-account-to-customer', failKey, '测试员')
const r2 = migrate02AccountToCustomer()
ok('c2 忽略后不计失败、计入 dismissed', r2.failed === 0 && r2.dismissed === 1 && r2.failures.length === 0)
crmDbService.migrationUndismiss('02-account-to-customer', failKey)
const r3 = migrate02AccountToCustomer()
ok('c3 恢复后回归失败清单', r3.failed === 1 && r3.dismissed === 0)
crmDbService.migrationUndismiss('02-account-to-customer', failKey)

// ── d. 审计词典覆盖（不写词典的 action 会让 audit-dict 护栏红）──
console.log('d. 词典覆盖')
const dictSrc = readFileSync(join(__dirname, '../shared/auditDict.ts'), 'utf-8')
ok('d1 migration_failure_dismiss 已入词典', /migration_failure_dismiss:\s*\{/.test(dictSrc))
ok('d2 migration_failure_restore 已入词典', /migration_failure_restore:\s*\{/.test(dictSrc))

// ── e. IPC / preload 接线 ──
console.log('e. 接线')
const ipcSrc = readFileSync(join(__dirname, '../electron/services/crmIpcHandlers.ts'), 'utf-8')
const preloadSrc = readFileSync(join(__dirname, '../electron/preload.ts'), 'utf-8')
ok('e1 三个 IPC handler 已注册', ['crm:migration:failure:dismiss', 'crm:migration:failure:restore', 'crm:migration:dismissal:list'].every((h) => ipcSrc.includes(`'${h}'`)))
ok('e2 忽略/恢复写审计（auditAppend 两动作）', ipcSrc.includes("'migration_failure_dismiss'") && ipcSrc.includes("'migration_failure_restore'"))
ok('e3 preload 三桥接', ['migrationDismissals', 'migrationDismissFailure', 'migrationRestoreFailure'].every((m) => preloadSrc.includes(m)))

// ── f. ENTITIES 白名单 ──
console.log('f. ENTITIES 白名单')
const dbSrc = readFileSync(join(__dirname, '../electron/services/crmDbService.ts'), 'utf-8')
ok('f1 migration_dismissal 已注册 ENTITIES', /'migration_dismissal'/.test(dbSrc))
ok('f2 DDL 存在且主键 (module, entity_key)', /CREATE TABLE IF NOT EXISTS migration_dismissal/.test(dbSrc) && /PRIMARY KEY \(module, entity_key\)/.test(dbSrc))

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
}

void main()
