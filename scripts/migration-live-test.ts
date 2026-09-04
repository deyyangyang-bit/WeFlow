/**
 * migration-live-test.ts —— Phase 1 存量迁移执行器（crmMigrationService 模块②/③）副本验证
 *
 *   Part A（fresh 库 + 构造存量数据）：干净锚点 / 无锚失败 / 多名·多归属冲突组 / 已挂接幂等 /
 *     既有 NULL identity 后补挂接 / lead 归并（同 wxid 多线索合一）/ 非法身份失败 /
 *     审计留痕 / scan_state 一次性标记 / 重跑零副作用 / 标记丢失后数据级幂等兜底
 *   Part B（live 库 /tmp 副本全量）：先跑 dryRun 预演取预测值 → 执行 → 实绩与预演口径逐一对账
 *     （挂接数 / customer 数 / identity 数 / 命中锚 / 资源池 NULL / 19 条冲突清单逐条列出）
 *
 * ⛔ 同 dry-run-all 铁律：live 源库复制到 /tmp 副本 → 应用链路 initialize → 绝不触碰 live 库。
 * 用法：npx tsx scripts/migration-live-test.ts
 */
import { copyFileSync, mkdtempSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { crmDbService } from '../electron/services/crmDbService'
import { findExistingBusinessDb } from '../electron/services/businessDbPath'
import {
  runStockDataMigration, accountAnchor, normalizePhone, normalizeWxid
} from '../electron/services/crmMigrationService'
import { dryRun as dryRun02 } from './migration/02-account-to-customer'
import { dryRun as dryRun03 } from './migration/03-lead-to-identity'

let pass = 0, fail = 0
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; console.log(`  ✅ ${name}`) } else { fail++; console.log(`  ❌ ${name} ${detail}`) }
}
function count(sql: string, params: unknown[] = []): number {
  return Number(crmDbService.all(sql, params)[0]?.c ?? 0)
}
const M02_MARKER = 'migration:02-account-to-customer'
const M03_MARKER = 'migration:03-lead-to-identity'

/** 构造 account 行（测试夹具，直插） */
function seedAccount(a: { name: string; phone?: string; sessionId?: string; owner?: string; customerId?: number; updatedAt?: number }): number {
  return crmDbService.runTx((tx) => tx.run(
    'INSERT INTO account (name, industry, province, city, phone, owner_sales, custom_fields, session_id, customer_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    [a.name, '', '', '', a.phone ?? '', a.owner ?? '', '{}', a.sessionId ?? null, a.customerId ?? null, 1700000000000, a.updatedAt ?? 1700000000000]
  ))
}
function seedLead(l: { contactType?: string; normalized: string; wechat?: string; accountId?: number }): number {
  return crmDbService.runTx((tx) => tx.run(
    "INSERT INTO lead (contact_type, contact_normalized, contact_raw, wechat, source, name, status, first_contact_deadline, created_at, updated_at, account_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    [l.contactType ?? 'phone', l.normalized, l.normalized, l.wechat ?? '', '测试', '', 'NEW', 4102444800000, 1700000000000, 1700000000000, l.accountId ?? null]
  ))
}

// ═══ Part A：fresh 库 + 构造存量数据 ═══════════════════════════════════════
async function partA(): Promise<void> {
  console.log('\n═══════ Part A：fresh 库构造存量数据 ═══════')
  const dir = mkdtempSync(join(tmpdir(), 'mig-fresh-'))
  await crmDbService.initialize(dir)

  // 预置：已挂接客户 C0（identity phone:13700000000）+ 一条 NULL identity（等 02 后补挂接）
  const c0 = crmDbService.runTx((tx) => {
    const cid = tx.run(
      'INSERT INTO customer (name, type, brand, vehicle_age, modified, source, updated_by, updated_at, version, deleted) VALUES (?,?,?,?,?,?,?,?,?,?)',
      ['庚', '', '', null, 0, 'migration', 'system:migration', 1700000000000, 1, 0])
    tx.run('INSERT INTO customer_identity (identity_type, identity_value, customer_id, source, confidence, updated_by, updated_at, version, deleted) VALUES (?,?,?,?,?,?,?,?,?)',
      ['phone', '13700000000', cid, 'auto', 1.0, 'system:migration', 1700000000000, 1, 0])
    tx.run('INSERT INTO customer_identity (identity_type, identity_value, customer_id, source, confidence, updated_by, updated_at, version, deleted) VALUES (?,?,?,?,?,?,?,?,?)',
      ['phone', '13911112222', null, 'auto', 1.0, 'system:migration', 1700000000000, 1, 0])
    return cid
  })

  const a1 = seedAccount({ name: '甲公司', phone: '138 0013 8000', owner: '杨青' })      // 干净手机号锚
  const a2 = seedAccount({ name: '乙', sessionId: 'wxid_abc123' })                        // 干净 wxid 锚
  const a3 = seedAccount({ name: '丙公司', phone: '123' })                                // 无锚 → 失败
  seedAccount({ name: '丁A', phone: '13500000000' })                                      // ┐ 同手机号多名 → 冲突
  seedAccount({ name: '丁B', phone: '135 0000 0000' })                                    // ┘
  seedAccount({ name: '戊', phone: '13600000000', owner: '杨青' })                        // ┐ 同手机号多归属 → 冲突
  seedAccount({ name: '戊', phone: '136-0000-0000', owner: '李林辉' })                    // ┘
  seedAccount({ name: '庚', phone: '13700000000', customerId: c0 })                       // 已挂接 → alreadyDone
  const a8 = seedAccount({ name: '己', phone: '13911112222' })                            // 干净 + 既有 NULL identity 后补挂接
  const a11 = seedAccount({ name: '辛', sessionId: 'wxid_xyz789' })                       // 干净 wxid 锚

  seedLead({ normalized: '13800138000' })                                                 // 命中 a1 锚（02 已登记 → alreadyDone）
  seedLead({ normalized: '15000000000' })                                                 // 资源池 NULL
  seedLead({ contactType: 'wechat', normalized: 'wxid_xyz789', wechat: 'wxid_xyz789 ' })  // 命中 a11 锚（去尾空格）
  seedLead({ contactType: 'wechat', normalized: 'dupwx', wechat: 'dupwx' })               // ┐ 同 wxid 两线索归并一行
  seedLead({ contactType: 'wechat', normalized: 'dupwx_dup', wechat: ' dupwx ' })         // ┘（lead 去重键不同，identity 归一后同值）
  seedLead({ normalized: '12345' })                                                       // 非 11 位 → 失败
  seedLead({ normalized: '' })                                                            // 空身份 → 失败
  seedLead({ contactType: 'wechat', normalized: 'wxid_abc123', wechat: 'wxid_abc123', accountId: a1 }) // 命中 a2 锚（alreadyDone 跳过，不产冲突）

  console.log('\n── A1. 首次执行 ──')
  const { m02, m03 } = runStockDataMigration()
  check('02 customersCreated=4（甲/乙/己/辛）', m02.customersCreated === 4, `实 ${m02.customersCreated}`)
  check('02 applied=4（挂接 account 数）', m02.applied === 4, `实 ${m02.applied}`)
  check('02 alreadyDone=1（庚已挂接）', m02.alreadyDone === 1, `实 ${m02.alreadyDone}`)
  check('02 failed=1（丙无锚）', m02.failed === 1 && m02.failures[0]?.key === `account:${a3}`, JSON.stringify(m02.failures))
  check('02 conflicts=2（多名组+多归属组）', m02.conflicts === 2, `实 ${m02.conflicts}`)
  check('03 applied=2（15000000000 + dupwx）', m03.applied === 2, `实 ${m03.applied}`)
  check('03 alreadyDone=3（13800138000/wxid_xyz789/wxid_abc123）', m03.alreadyDone === 3, `实 ${m03.alreadyDone}`)
  check('03 failed=2（非11位+空身份）', m03.failed === 2, `实 ${m03.failed}`)

  console.log('\n── A2. 落行校验 ──')
  check('customer 总数=5（C0+新建4）', count('SELECT COUNT(*) AS c FROM customer') === 5)
  check('account.customer_id 挂接=5', count('SELECT COUNT(*) AS c FROM account WHERE customer_id IS NOT NULL AND customer_id > 0') === 5)
  check('冲突/失败 account 保持未挂接（丙/丁A/丁B/戊×2=5）',
    count('SELECT COUNT(*) AS c FROM account WHERE customer_id IS NULL') === 5)
  check('identity 总数=7', count('SELECT COUNT(*) AS c FROM customer_identity') === 7)
  check('identity 唯一约束无重复', count('SELECT COUNT(*) AS c FROM (SELECT identity_type, identity_value FROM customer_identity GROUP BY 1,2 HAVING COUNT(*)>1)') === 0)
  check('资源池 NULL identity=2', count('SELECT COUNT(*) AS c FROM customer_identity WHERE customer_id IS NULL') === 2)
  const a1c = Number(crmDbService.all('SELECT customer_id FROM account WHERE id = ?', [a1])[0]?.customer_id || 0)
  check('甲 customer 挂接且 identity(phone:13800138000) 同 customer',
    a1c > 0 && count('SELECT COUNT(*) AS c FROM customer_identity WHERE identity_type=? AND identity_value=? AND customer_id=?', ['phone', '13800138000', a1c]) === 1)
  check('既有 NULL identity(13911112222) 后补挂接到己的 customer',
    count('SELECT COUNT(*) AS c FROM customer_identity ci JOIN account a ON a.customer_id = ci.customer_id WHERE ci.identity_value = ? AND a.id = ?', ['13911112222', a8]) === 1)
  const a2c = Number(crmDbService.all('SELECT customer_id FROM account WHERE id = ?', [a2])[0]?.customer_id || 0)
  check('lead 锚 wxid_abc123 的 identity 挂乙的 customer（02 登记的锚身份即 03 的命中结果）',
    count('SELECT COUNT(*) AS c FROM customer_identity WHERE identity_type=? AND identity_value=? AND customer_id=?', ['wxid', 'wxid_abc123', a2c]) === 1)
  check('dupwx 双线索归并为一行 NULL identity',
    count("SELECT COUNT(*) AS c FROM customer_identity WHERE identity_type='wxid' AND identity_value='dupwx'") === 1)

  console.log('\n── A3. 审计 + 标记 ──')
  check('audit_event 两行（02/03 各一，actor=system:migration）',
    count("SELECT COUNT(*) AS c FROM audit_event WHERE actor = 'system:migration' AND action LIKE 'migration_%'") === 2)
  const audit02 = crmDbService.all("SELECT detail FROM audit_event WHERE action = 'migration_02_account_to_customer'")[0]
  const d02 = JSON.parse(String(audit02?.detail || '{}'))
  check('02 审计 detail 含报告摘要+失败/冲突清单', d02.summary?.applied === 4 && d02.failures?.length === 1 && d02.conflicts?.length === 2)
  check('scan_state 两标记已置位', crmDbService.getScanState(M02_MARKER) > 0 && crmDbService.getScanState(M03_MARKER) > 0)

  console.log('\n── A4. 幂等重跑（标记命中）──')
  const again = runStockDataMigration()
  check('重跑 02/03 标记跳过', again.m02.skippedByMarker && again.m03.skippedByMarker)
  check('重跑后 customer/identity/挂接数零变化',
    count('SELECT COUNT(*) AS c FROM customer') === 5 &&
    count('SELECT COUNT(*) AS c FROM customer_identity') === 7 &&
    count('SELECT COUNT(*) AS c FROM account WHERE customer_id IS NOT NULL AND customer_id > 0') === 5)

  console.log('\n── A5. 标记丢失兜底（数据级幂等）──')
  crmDbService.runTx((tx) => { tx.run("DELETE FROM scan_state WHERE key IN (?,?)", [M02_MARKER, M03_MARKER]); return 0 })
  const lost = runStockDataMigration()
  check('02 重入：零新建零挂接（applied=0/customers=0/alreadyDone=5）',
    lost.m02.applied === 0 && lost.m02.customersCreated === 0 && lost.m02.alreadyDone === 5,
    JSON.stringify({ applied: lost.m02.applied, created: lost.m02.customersCreated, already: lost.m02.alreadyDone }))
  check('02 重入：失败/冲突重新评估但不写数据', lost.m02.failed === 1 && lost.m02.conflicts === 2)
  check('03 重入：零新插（applied=0/alreadyDone=5）', lost.m03.applied === 0 && lost.m03.alreadyDone === 5,
    JSON.stringify({ applied: lost.m03.applied, already: lost.m03.alreadyDone }))
  check('数据零变化（customer=5/identity=7/挂接=5/NULL=2）',
    count('SELECT COUNT(*) AS c FROM customer') === 5 &&
    count('SELECT COUNT(*) AS c FROM customer_identity') === 7 &&
    count('SELECT COUNT(*) AS c FROM account WHERE customer_id IS NOT NULL AND customer_id > 0') === 5 &&
    count('SELECT COUNT(*) AS c FROM customer_identity WHERE customer_id IS NULL') === 2)
  check('标记已重建', crmDbService.getScanState(M02_MARKER) > 0 && crmDbService.getScanState(M03_MARKER) > 0)
}

// ═══ Part B：live 库 /tmp 副本全量验证 ═════════════════════════════════════
async function partB(): Promise<void> {
  console.log('\n═══════ Part B：live 库副本全量验证 ═══════')
  const userData = join(homedir(), 'Library', 'Application Support', 'weflow')
  const crmSrc = findExistingBusinessDb(userData, 'crm')
  if (!crmSrc) { console.error('未找到 live CRM 库'); fail++; return }
  const dir = mkdtempSync(join(tmpdir(), 'mig-live-'))
  copyFileSync(crmSrc, join(dir, 'weflow-crm.db'))
  await crmDbService.reopenForWxid(dir) // Part A 库落盘卸载 → 副本接管（应用链路）
  console.log(`副本试跑：crm ← ${crmSrc.replace(homedir(), '~')}`)

  // 预演先行：dryRun 预测值 = 执行器对账基准（口径一致性验证）
  const pre02 = dryRun02('live-copy')
  const pre03 = dryRun03('live-copy')
  console.log(`  dryRun 预测：02 ${JSON.stringify(pre02.summary)}`)
  console.log(`  dryRun 预测：03 ${JSON.stringify(pre03.summary)}`)

  // 测试侧独立重算：无锚未挂接 account 的锚点组数 / lead 身份键 ∩ account 锚点键（重叠数）
  const unlinked = crmDbService.all('SELECT id, phone, session_id, customer_id FROM account WHERE customer_id IS NULL OR customer_id = 0')
  const anchorKeys = new Set<string>()
  for (const a of unlinked) { const an = accountAnchor(a); if (an) anchorKeys.add(`${an.type}:${an.value}`) }
  const leadKeys = new Set<string>()
  for (const l of crmDbService.all('SELECT contact_type, contact_normalized, wechat FROM lead')) {
    const type = String(l.contact_type || 'phone') === 'wechat' ? 'wxid' : 'phone'
    const v = type === 'phone' ? normalizePhone(l.contact_normalized) : normalizeWxid(l.wechat)
    if (v && (type === 'wxid' || v.length === 11)) leadKeys.add(`${type}:${v}`)
  }
  const overlap = [...leadKeys].filter((k) => anchorKeys.has(k)).length
  console.log(`  独立重算：锚点组 ${anchorKeys.size} 个 / lead 身份键 ${leadKeys.size} 个 / 重叠 ${overlap} 个`)

  console.log('\n── B1. 执行 ──')
  const { m02, m03 } = runStockDataMigration()
  console.log(`  02 实绩：${JSON.stringify({ applied: m02.applied, customers: m02.customersCreated, alreadyDone: m02.alreadyDone, failed: m02.failed, conflicts: m02.conflicts })}`)
  console.log(`  03 实绩：${JSON.stringify({ applied: m03.applied, alreadyDone: m03.alreadyDone, failed: m03.failed, conflicts: m03.conflicts })}`)

  check('02 挂接数 = dryRun 预测 wouldApply', m02.applied === pre02.summary.wouldApply, `实 ${m02.applied} 预 ${pre02.summary.wouldApply}`)
  check('02 新建 customer 数 = 独立重算锚点组数 − 冲突组数', m02.customersCreated === anchorKeys.size - m02.conflicts, `实 ${m02.customersCreated} 期 ${anchorKeys.size - m02.conflicts}`)
  check('02 失败数 = dryRun 预测（无锚 account）', m02.failed === pre02.summary.failed, `实 ${m02.failed} 预 ${pre02.summary.failed}`)
  check('02 冲突数 = dryRun 预测', m02.conflicts === pre02.summary.conflicts, `实 ${m02.conflicts} 预 ${pre02.summary.conflicts}`)
  check('03 新插 + 幂等命中 = dryRun 预测唯一身份键数', m03.applied + m03.alreadyDone === pre03.summary.wouldApply + pre03.summary.alreadyDone,
    `实 ${m03.applied}+${m03.alreadyDone} 预 ${pre03.summary.wouldApply}+${pre03.summary.alreadyDone}`)
  check('03 幂等命中数 = 重叠锚点数（02 已登记的 account 锚）', m03.alreadyDone === overlap, `实 ${m03.alreadyDone} 期 ${overlap}`)
  check('03 失败/冲突 = dryRun 预测', m03.failed === pre03.summary.failed && m03.conflicts === pre03.summary.conflicts)

  console.log('\n── B2. 落行核验 ──')
  const customers = count('SELECT COUNT(*) AS c FROM customer')
  const attached = count('SELECT COUNT(*) AS c FROM account WHERE customer_id IS NOT NULL AND customer_id > 0')
  const identities = count('SELECT COUNT(*) AS c FROM customer_identity')
  const linked = count('SELECT COUNT(*) AS c FROM customer_identity WHERE customer_id IS NOT NULL AND customer_id > 0')
  const pooled = count('SELECT COUNT(*) AS c FROM customer_identity WHERE customer_id IS NULL')
  console.log(`  customer=${customers} account挂接=${attached} identity=${identities}（挂 customer ${linked} / 资源池 NULL ${pooled}）`)
  check('customer 落行 = 02 新建数', customers === m02.customersCreated, `${customers} vs ${m02.customersCreated}`)
  check('account.customer_id 挂接 = 02 applied', attached === m02.applied)
  check('identity 总行 = customer 锚 + 03 新插', identities === m02.customersCreated + m03.applied, `${identities} vs ${m02.customersCreated}+${m03.applied}`)
  check('identity 唯一约束无重复', count('SELECT COUNT(*) AS c FROM (SELECT identity_type, identity_value FROM customer_identity GROUP BY 1,2 HAVING COUNT(*)>1)') === 0)
  check('挂 customer 的 identity = customer 锚数（188 上下）', linked === m02.customersCreated, `实 ${linked}`)
  check('资源池 NULL = identity 总数 − 锚数', pooled === identities - linked)
  check('每个 customer 至少一行 identity', count('SELECT COUNT(*) AS c FROM customer c WHERE NOT EXISTS (SELECT 1 FROM customer_identity ci WHERE ci.customer_id = c.id)') === 0)
  check('挂接 account 全有 customer 行可JOIN', count('SELECT COUNT(*) AS c FROM account a LEFT JOIN customer c ON c.id = a.customer_id WHERE a.customer_id > 0 AND c.id IS NULL') === 0)

  console.log('\n── B3. 冲突/失败清单（逐条）──')
  for (const f of m02.failures) console.log(`  ✗ ${f.key}：${f.reason}${f.detail ? `（${f.detail}）` : ''}`)
  for (const c of m02.conflictList) console.log(`  ⚠ ${c.key}：${c.reason}`)
  for (const f of m03.failures) console.log(`  ✗ ${f.key}：${f.reason}`)
  check('19 个无锚 account 全部进失败清单且未挂接', m02.failures.length === pre02.summary.failed &&
    m02.failures.every((f) => count('SELECT COUNT(*) AS c FROM account WHERE id = ? AND customer_id IS NULL', [Number(f.key.split(':')[1])]) === 1))
  check('审计两行 + detail 摘要可对账', (() => {
    const rows = crmDbService.all("SELECT action, detail FROM audit_event WHERE actor = 'system:migration' AND action LIKE 'migration_%'")
    if (rows.length !== 2) return false
    const d = Object.fromEntries(rows.map((r) => [String(r.action), JSON.parse(String(r.detail))]))
    return d.migration_02_account_to_customer?.summary?.applied === m02.applied &&
      d.migration_03_lead_to_identity?.summary?.applied === m03.applied &&
      d.migration_02_account_to_customer?.failures?.length === m02.failed
  })())

  console.log('\n── B4. 幂等重跑 ──')
  const again = runStockDataMigration()
  check('重跑标记跳过零副作用', again.m02.skippedByMarker && again.m03.skippedByMarker &&
    count('SELECT COUNT(*) AS c FROM customer') === customers &&
    count('SELECT COUNT(*) AS c FROM customer_identity') === identities &&
    count('SELECT COUNT(*) AS c FROM account WHERE customer_id IS NOT NULL AND customer_id > 0') === attached)
}

async function main(): Promise<void> {
  await partA()
  await partB()
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  process.exit(fail ? 1 : 0)
}

void main()
