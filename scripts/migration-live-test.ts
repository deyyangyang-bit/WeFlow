/**
 * migration-live-test.ts —— Phase 1 存量迁移执行器（crmMigrationService 模块②/③/④/⑤）副本验证
 *
 *   Part A（fresh 库 + 构造存量数据）：干净锚点 / 无锚失败 / 多名·多归属冲突组 / 已挂接幂等 /
 *     既有 NULL identity 后补挂接 / lead 归并（同 wxid 多线索合一）/ 非法身份失败 /
 *     审计留痕（只在有写入时）/ scan_state 最后扫描时间戳 / 重跑零副作用（数据级幂等兜底）/
 *     marker 存在时新增候选仍被处理（增量迁移）/ 模块④版本链与合同指针闭合。
 *   Part B（live 库 /tmp 副本，动态不变量）：不得写死 188/19/4680 等业务数量，改用动态不变量——
 *     已挂接 + 未挂接 = account 总数；identity = 挂接 + 资源池；唯一约束成立；
 *     收敛重跑零新增；注入新增候选（marker 仍在）仍被迁移；再次重跑零新增；报告 SSOT 落库。
 *
 * ⛔ 铁律：live 源库复制到 /tmp 副本 → 应用链路 initialize → 绝不触碰 live 库。
 * 用法：npx tsx scripts/migration-live-test.ts
 */
import { copyFileSync, mkdtempSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { crmDbService } from '../electron/services/crmDbService'
import { findExistingBusinessDb } from '../electron/services/businessDbPath'
import {
  runStockDataMigration, migrate04HistoryDealToOpportunity, accountAnchor
} from '../electron/services/crmMigrationService'

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
  console.log('\n═══════ Part A：fresh 库构造存量数据 ═══')
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

  console.log('\n── A3. 审计 + 标记 + 报告 SSOT ──')
  check('audit_event 两行（02/03 各一，actor=system:migration）',
    count("SELECT COUNT(*) AS c FROM audit_event WHERE actor = 'system:migration' AND action LIKE 'migration_%'") === 2)
  const audit02 = crmDbService.all("SELECT detail FROM audit_event WHERE action = 'migration_02_account_to_customer'")[0]
  const d02 = JSON.parse(String(audit02?.detail || '{}'))
  check('02 审计 detail 含报告摘要+失败/冲突清单', d02.summary?.applied === 4 && d02.failures?.length === 1 && d02.conflicts?.length === 2)
  check('scan_state 两标记已置位（最后扫描时间戳）', crmDbService.getScanState(M02_MARKER) > 0 && crmDbService.getScanState(M03_MARKER) > 0)
  // 报告 SSOT：migration_report 落库（不依赖 audit_event）
  const reports = crmDbService.listMigrationReports()
  check('migration_report 落库（02/03 各一份快照）',
    reports.some((r) => String(r.module) === '02-account-to-customer') &&
    reports.some((r) => String(r.module) === '03-lead-to-identity'), JSON.stringify(reports.map((r) => r.module)))
  const rep02 = reports.find((r) => String(r.module) === '02-account-to-customer')
  const sum02 = JSON.parse(String(rep02?.summary || '{}'))
  check('02 报告 summary 反映 applied=4/failed=1/conflicts=2', sum02.applied === 4 && sum02.failed === 1 && sum02.conflicts === 2, JSON.stringify(sum02))

  console.log('\n── A4. 幂等重跑（数据级判重兜底）──')
  const again = runStockDataMigration()
  check('重跑 02/03 零写入（applied=0/customers=0）', again.m02.applied === 0 && again.m02.customersCreated === 0 && again.m03.applied === 0)
  check('重跑后 customer/identity/挂接数零变化',
    count('SELECT COUNT(*) AS c FROM customer') === 5 &&
    count('SELECT COUNT(*) AS c FROM customer_identity') === 7 &&
    count('SELECT COUNT(*) AS c FROM account WHERE customer_id IS NOT NULL AND customer_id > 0') === 5)
  check('重跑不重复审计（仍 2 行）', count("SELECT COUNT(*) AS c FROM audit_event WHERE actor = 'system:migration' AND action LIKE 'migration_%'") === 2)

  console.log('\n── A5. 标记丢失兜底（数据级幂等，与标记无关）──')
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
  check('标记丢失重跑不重复审计（仍 2 行）', count("SELECT COUNT(*) AS c FROM audit_event WHERE actor = 'system:migration' AND action LIKE 'migration_%'") === 2)

  console.log('\n── A6. 增量迁移：marker 存在时新增候选仍被处理 ──')
  const incPhone = '19' + String(Date.now()).slice(-9)
  const incLeadPhone = '18' + String(Date.now()).slice(-9)
  seedAccount({ name: `增量壬${Date.now()}`, phone: incPhone })          // 新增干净手机号 account
  seedLead({ normalized: incLeadPhone })                                  // 新增干净身份 lead
  const inc = runStockDataMigration()
  check('02 增量：新增 account 被迁移（applied=1）', inc.m02.applied === 1, `实 ${inc.m02.applied}`)
  check('03 增量：新增 lead 被建档（applied=1）', inc.m03.applied === 1, `实 ${inc.m03.applied}`)
  check('增量后 identity 唯一约束仍成立',
    count('SELECT COUNT(*) AS c FROM (SELECT identity_type, identity_value FROM customer_identity GROUP BY 1,2 HAVING COUNT(*)>1)') === 0)
  // 再次重跑 → 零新增（幂等闭环）
  const inc2 = runStockDataMigration()
  check('增量后再次重跑零新增（applied=0）', inc2.m02.applied === 0 && inc2.m03.applied === 0,
    JSON.stringify({ m02: inc2.m02.applied, m03: inc2.m03.applied }))

  console.log('\n── A7. 模块④：历史成交 → won 商机 + 报价版本链闭合 ──')
  const accM = seedAccount({ name: '洛阳历史成交迁移公司' })
  const cidM = crmDbService.create('contract', {
    account_id: accM, name: '洛阳-历史成交合同', amount: 88000, status: 'signed',
    sign_date: Date.now() - 10 * 86400000, created_at: Date.now() - 40 * 86400000, updated_at: Date.now() - 40 * 86400000
  })
  crmDbService.runTx((tx) => {
    for (const [total, daysAgo] of [[1000, 40], [2000, 30], [88000, 20]] as Array<[number, number]>) {
      tx.run('INSERT INTO quotation (contract_id, items, total, created_at, custom_fields) VALUES (?,?,?,?,?)',
        [cidM, '[]', total, Date.now() - daysAgo * 86400000, '{}'])
    }
  })
  const r04a = migrate04HistoryDealToOpportunity()
  check('04 补建 won 商机（wonOppCreated=1）', r04a.wonOppCreated === 1, `实 ${r04a.wonOppCreated}`)
  const mOpp = crmDbService.all('SELECT * FROM opportunity WHERE account_id = ? AND status = ?', [accM, 'won'])[0]
  check('04 won 商机 source=migration + amount_cny=88000', !!mOpp && String(mOpp.source) === 'migration' && Number(mOpp.amount_cny) === 88000)
  const chain = crmDbService.quotationHistoryForContract(cidM)
  check('04 版本链闭合 version=1..3（按创建序）', chain.length === 3 && Number(chain[0].version) === 3 && Number(chain[2].version) === 1, JSON.stringify(chain.map((r) => r.version)))
  check('04 effective_from 回填 ← created_at', chain.every((row) => Number(row.effective_from) > 0))
  check('04 旧版本 effective_to 关闭、最新版本开放',
    Number(chain[2].effective_to) > 0 && Number(chain[1].effective_to) > 0 && Number(chain[0].effective_to) === 0)
  check('04 合同指针接管 → 最新版本', Number(crmDbService.getById('contract', cidM)?.quote_version_id) === Number(chain[0].id))
  const r04b = migrate04HistoryDealToOpportunity()
  const chainAfter = crmDbService.quotationHistoryForContract(cidM)
  check('04 幂等（重跑零第二份数据、链不再改写）', r04b.wonOppCreated === 0 && r04b.chainsNormalized === 0 && JSON.stringify(chainAfter) === JSON.stringify(chain))
}

// ═══ Part B：live 库 /tmp 副本「已迁移」动态不变量验证 ═══════════════════
// ⚠️ 不得写死 188/19/4680 等业务数量——live 库数字随真实业务变化，改用动态不变量：
//   已挂接 + 未挂接 = account 总数；identity = 挂接 + 资源池；唯一约束成立；
//   收敛重跑零新增；注入新增候选（marker 仍在）仍被迁移；再次重跑零新增。
async function partB(): Promise<void> {
  console.log('\n═══════ Part B：live 库副本（已迁移）动态不变量验证 ═══')
  const userData = join(homedir(), 'Library', 'Application Support', 'weflow')
  const crmSrc = findExistingBusinessDb(userData, 'crm')
  if (!crmSrc) { console.error('未找到 live CRM 库'); fail++; return }
  const dir = mkdtempSync(join(tmpdir(), 'mig-live-'))
  copyFileSync(crmSrc, join(dir, 'weflow-crm.db'))
  await crmDbService.reopenForWxid(dir) // Part A 库落盘卸载 → 副本接管（应用链路）
  console.log(`副本试跑：crm ← ${crmSrc.replace(homedir(), '~')}`)

  const totalAccounts = count('SELECT COUNT(*) AS c FROM account')
  const attachedBefore = count('SELECT COUNT(*) AS c FROM account WHERE customer_id IS NOT NULL AND customer_id > 0')
  const unlinkedBefore = count('SELECT COUNT(*) AS c FROM account WHERE customer_id IS NULL')
  const customersBefore = count('SELECT COUNT(*) AS c FROM customer')
  const identitiesBefore = count('SELECT COUNT(*) AS c FROM customer_identity')
  const linkedBefore = count('SELECT COUNT(*) AS c FROM customer_identity WHERE customer_id IS NOT NULL AND customer_id > 0')
  const pooledBefore = count('SELECT COUNT(*) AS c FROM customer_identity WHERE customer_id IS NULL')
  const auditBefore = count("SELECT COUNT(*) AS c FROM audit_event WHERE actor = 'system:migration' AND action LIKE 'migration_%'")

  console.log('\n── B0. 静态不变量（结构一致，与具体数量无关）──')
  check('已挂接 + 未挂接 = account 总数', attachedBefore + unlinkedBefore === totalAccounts, `${attachedBefore}+${unlinkedBefore}=${totalAccounts}`)
  check('identity = 挂接 + 资源池 NULL', linkedBefore + pooledBefore === identitiesBefore, `${linkedBefore}+${pooledBefore}=${identitiesBefore}`)
  check('identity 唯一约束无重复',
    count('SELECT COUNT(*) AS c FROM (SELECT identity_type, identity_value FROM customer_identity GROUP BY 1,2 HAVING COUNT(*)>1)') === 0)
  check('scan_state 两标记已置位（最后扫描时间戳）', crmDbService.getScanState(M02_MARKER) > 0 && crmDbService.getScanState(M03_MARKER) > 0)

  console.log('\n── B1. 收敛重跑（live 可能仍有未迁候选 → applied 可 >0，总数守恒）──')
  const first = runStockDataMigration()
  const attachedAfter = count('SELECT COUNT(*) AS c FROM account WHERE customer_id IS NOT NULL AND customer_id > 0')
  const unlinkedAfter = count('SELECT COUNT(*) AS c FROM account WHERE customer_id IS NULL')
  // 动态不变量：本轮挂接增量 = applied（若 live 仍有未迁候选则 >0，否则 0），总数守恒
  check('挂接增量 = 02.applied（已挂接总数守恒）', attachedAfter - attachedBefore === first.m02.applied, `${attachedAfter}-${attachedBefore}=${first.m02.applied}`)
  check('未挂接减量 = 02.applied', unlinkedBefore - unlinkedAfter === first.m02.applied)
  // 动态不变量：失败数 = 无锚且未挂接的 account 数（独立用 accountAnchor 复算，不写死）
  const anchorless = crmDbService.all('SELECT id, phone, session_id, customer_id FROM account')
    .filter((a) => !(a.customer_id != null && Number(a.customer_id) > 0) && accountAnchor(a) === null).length
  check('02.failed = 无锚未挂接 account 数（独立复算）', first.m02.failed === anchorless, `${first.m02.failed}=${anchorless}`)
  check('03 收敛零新插（applied=0）', first.m03.applied === 0, `实 ${first.m03.applied}`)
  // 收敛后快照（供 B2 零变化对账）
  const customersAfter = count('SELECT COUNT(*) AS c FROM customer')
  const identitiesAfter = count('SELECT COUNT(*) AS c FROM customer_identity')
  const pooledAfter = count('SELECT COUNT(*) AS c FROM customer_identity WHERE customer_id IS NULL')
  const auditAfter = count("SELECT COUNT(*) AS c FROM audit_event WHERE actor = 'system:migration' AND action LIKE 'migration_%'")
  // 报告 SSOT 落库（不依赖 audit_event）
  const repRows = crmDbService.listMigrationReports()
  check('migration_report 落库 02/03 快照',
    repRows.some((r) => String(r.module) === '02-account-to-customer') && repRows.some((r) => String(r.module) === '03-lead-to-identity'))

  console.log('\n── B2. 再次重跑：零新增、零副作用（幂等闭环）──')
  const second = runStockDataMigration()
  check('再次重跑 02/03 零新增（applied=0）', second.m02.applied === 0 && second.m03.applied === 0,
    JSON.stringify({ m02: second.m02.applied, m03: second.m03.applied }))
  check('再次重跑后业务计数零变化（对收敛后快照）',
    count('SELECT COUNT(*) AS c FROM customer') === customersAfter &&
    count('SELECT COUNT(*) AS c FROM customer_identity') === identitiesAfter &&
    count('SELECT COUNT(*) AS c FROM account WHERE customer_id IS NOT NULL AND customer_id > 0') === attachedAfter &&
    count('SELECT COUNT(*) AS c FROM customer_identity WHERE customer_id IS NULL') === pooledAfter)
  check('再次重跑不重复审计（audit 与收敛后一致）', count("SELECT COUNT(*) AS c FROM audit_event WHERE actor = 'system:migration' AND action LIKE 'migration_%'") === auditAfter)

  console.log('\n── B3. 注入新增候选（marker 仍在）仍被迁移 → 再次重跑零新增 ──')
  const incPhone = '19' + String(Date.now()).slice(-9)
  const incLeadPhone = '18' + String(Date.now()).slice(-9)
  crmDbService.runTx((tx) => {
    tx.run("INSERT INTO account (name, industry, province, city, phone, owner_sales, custom_fields, session_id, customer_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      [`增量迁移测试-${Date.now()}`, '', '', '', incPhone, '', '{}', null, null, 1700000000000, 1700000000000])
    tx.run("INSERT INTO lead (contact_type, contact_normalized, contact_raw, wechat, source, name, status, first_contact_deadline, created_at, updated_at, account_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      ['phone', incLeadPhone, incLeadPhone, '', '测试', '', 'NEW', 4102444800000, 1700000000000, 1700000000000, null])
  })
  const third = runStockDataMigration()
  check('marker 存在时新增 account 仍被迁移（02.applied=1）', third.m02.applied === 1, `实 ${third.m02.applied}`)
  check('marker 存在时新增 lead 仍被建档（03.applied=1）', third.m03.applied === 1, `实 ${third.m03.applied}`)
  check('新增 account 已挂接（customer_id>0）',
    count('SELECT COUNT(*) AS c FROM account WHERE phone = ? AND customer_id > 0', [incPhone]) === 1)
  check('新增 lead 已建档（identity 存在且唯一约束成立）',
    count("SELECT COUNT(*) AS c FROM customer_identity WHERE identity_type='phone' AND identity_value=?", [incLeadPhone]) === 1)
  const fourth = runStockDataMigration()
  check('再次重跑零新增（02/03 applied=0）', fourth.m02.applied === 0 && fourth.m03.applied === 0,
    JSON.stringify({ m02: fourth.m02.applied, m03: fourth.m03.applied }))
}

async function main(): Promise<void> {
  await partA()
  await partB()
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  process.exit(fail ? 1 : 0)
}

void main()
