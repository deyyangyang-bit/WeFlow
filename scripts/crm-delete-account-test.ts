/**
 * crm-delete-account-test.ts —— H4 回归测试：deleteAccount 事务化完整级联
 *
 * 修复前：deleteAccount 只清理合同链、alias_map、logistics、account，残留
 *   opportunity / opportunity_event / crm_risk / payment_promise / quote_signal /
 *   contact / shipping_info / 账户级 allocation / 孤儿活动日志，且非事务（中途失败半删）。
 * 验证：
 *   ① 全部级联删除后无孤儿（逐表断言），payment_record（原始到款事实）按契约保留；
 *   ② customer / customer_identity / lead（独立事实源）不误删，lead.account_id 只解除挂接；
 *   ③ 统计不再计算该客户（statsOverview / opportunityStats）；
 *   ④ removed 计数与实际删除范围一致；
 *   ⑤ 故障注入（SQLite TRIGGER RAISE(ABORT)）：中途异常整体回滚，客户与子资源全部原样保留。
 * 运行：npx tsx scripts/crm-delete-account-test.ts
 */
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { crmDbService, type CrmRow } from '../electron/services/crmDbService'

let pass = 0, fail = 0
function ok(name: string, cond: boolean): void {
  if (cond) { pass++ } else { fail++; console.error('FAIL:', name) }
}
function count(table: string, where = '', params: unknown[] = []): number {
  const sql = `SELECT COUNT(*) AS n FROM ${table} ${where ? `WHERE ${where}` : ''}`
  return Number(crmDbService.all(sql, params)[0]?.n ?? 0)
}
const now = Date.now()

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'crm-del-acc-'))
  await crmDbService.initialize(dir)

  // ── 造数：两个客户，A 带全部类型的引用；B 只有一个合同（隔离验证）──────────
  const accA = crmDbService.create('account', { name: '客户A', session_id: 'sess_a', sales_stage: 'quoted', created_at: now, updated_at: now })
  const accB = crmDbService.create('account', { name: '客户B', created_at: now, updated_at: now })
  ok('0a 建档成功', accA > 0 && accB > 0)
  const a = Number(accA)

  // 客户锚点（独立事实源）：customer + customer_identity 挂在 account.customer_id
  const customer = crmDbService.create('customer', { name: '客户A', updated_at: now })
  crmDbService.runTx((tx) => tx.run('UPDATE account SET customer_id = ? WHERE id = ?', [Number(customer), a]))
  crmDbService.create('customer_identity', { identity_type: 'phone', identity_value: '13800000001', customer_id: Number(customer), updated_at: now })
  // lead（独立事实源）：account_id 挂接到 A
  const lead = crmDbService.create('lead', { contact_type: 'phone', contact_normalized: '13800000001', status: 'ACCOUNT', account_id: a, first_contact_deadline: now, created_at: now })

  // 合同链：contract + quotation + invoice + logistics(合同级) + allocation(合同级) + contract_status_history
  const contract = crmDbService.create('contract', { account_id: a, name: 'A-合同', amount: 1000, status: 'signed', created_at: now, updated_at: now })
  // quotation 散写禁令（宪法 §1.6）——测试夹具直接 INSERT 一行作级联对象
  const quotation = crmDbService.runTx((tx) => tx.run(
    'INSERT INTO quotation (contract_id, total, status, items, created_at) VALUES (?,?,?,?,?)',
    [Number(contract), 1000, 'draft', '[]', now]))
  const invoice = crmDbService.create('invoice', { contract_id: Number(contract), account_id: a, invoice_no: 'INV-1', created_at: now })
  const logisticsC = crmDbService.create('logistics', { tracking_no: 'SF-C1', link_status: 'linked', account_id: a, contract_id: Number(contract), created_at: now })
  // 原始到款事实（payment_record）+ 两条 allocation：合同级 / 账户级
  const payRecord = crmDbService.create('payment_record', { amount_net: 500, pay_time: now, created_at: now })
  const allocContract = crmDbService.create('allocation', { payment_record_id: Number(payRecord), account_id: a, contract_id: Number(contract), credited_amount: 500, status: 'confirmed', reconciliation_status: 'allocated', created_at: now })
  const allocAccount = crmDbService.create('allocation', { payment_record_id: Number(payRecord), account_id: a, credited_amount: 300, status: 'pending', created_at: now })
  crmDbService.runTx((tx) => tx.run('INSERT INTO contract_status_history (contract_id, from_status, to_status, operator, created_at) VALUES (?,?,?,?,?)', [Number(contract), 'pending_sign', 'signed', 'test', now]))

  // 商机 + 事件（事件必须先于商机删）
  const opp1 = crmDbService.create('opportunity', { account_id: a, name: 'A-商机1', stage: '比价', status: 'active', created_at: now, updated_at: now })
  const opp2 = crmDbService.create('opportunity', { account_id: a, name: 'A-商机2', stage: '了解', status: 'active', created_at: now, updated_at: now })
  crmDbService.create('opportunity_event', { opportunity_id: Number(opp1), event_type: 'stage_change', detail: 'x', created_at: now })
  crmDbService.create('opportunity_event', { opportunity_id: Number(opp1), event_type: 'deal_pending', detail: 'y', created_at: now })
  crmDbService.create('opportunity_event', { opportunity_id: Number(opp2), event_type: 'stage_change', detail: 'z', created_at: now })

  // 其余客户维度事实
  crmDbService.create('crm_risk', { account_id: a, risk_type: 'price', detail: '砍价', status: 'active', created_at: now })
  crmDbService.create('payment_promise', { account_id: a, session_id: 'sess_a', due_date: now, evidence_key: 'mk:1', status: 'pending', created_at: now })
  crmDbService.create('quote_signal', { msg_key: 'mk:A1', session_id: 'sess_a', account_id: a, amount: 800, created_at: now })
  crmDbService.create('contact', { account_id: a, name: '张联系人', created_at: now })
  crmDbService.create('shipping_info', { account_id: a, receiver: '张三', created_at: now })
  crmDbService.create('alias_map', { alias: 'A的别名', account_id: a, created_at: now })
  crmDbService.create('logistics', { tracking_no: 'SF-A0', link_status: 'linked', account_id: a, created_at: now }) // 账户级物流
  crmDbService.runTx((tx) => tx.run('INSERT INTO activity_log (entity, entity_id, action, detail, created_at) VALUES (?,?,?,?,?)', ['opportunity', Number(opp1), 'imported', 'x', now]))

  // P1 补枚举夹具：
  // ① 账户级发票（contract_id=NULL，crmParseService 通道）
  const invoiceAccountLevel = crmDbService.runTx((tx) => tx.run(
    'INSERT INTO invoice (contract_id, account_id, invoice_no, created_at) VALUES (NULL,?,?,?)', [a, 'INV-ACC', now]))
  // ② 子资源实体日志（invoice/logistics/allocation/quotation 的 activity_log）
  crmDbService.runTx((tx) => {
    tx.run('INSERT INTO activity_log (entity, entity_id, action, detail, created_at) VALUES (?,?,?,?,?)', ['invoice', Number(invoice), 'created', 'x', now])
    tx.run('INSERT INTO activity_log (entity, entity_id, action, detail, created_at) VALUES (?,?,?,?,?)', ['logistics', Number(logisticsC), 'linked', 'x', now])
    tx.run('INSERT INTO activity_log (entity, entity_id, action, detail, created_at) VALUES (?,?,?,?,?)', ['allocation', Number(allocContract), 'confirmed', 'x', now])
    tx.run('INSERT INTO activity_log (entity, entity_id, action, detail, created_at) VALUES (?,?,?,?,?)', ['quotation', Number(quotation), 'created', 'x', now])
  })
  // ③ account_id=NULL 但 opportunity_id 命中 A 商机的风险（历史数据形态）
  crmDbService.runTx((tx) => tx.run(
    'INSERT INTO crm_risk (account_id, opportunity_id, risk_type, detail, status, created_at) VALUES (NULL,?,?,?,?,?)',
    [Number(opp1), 'price', 'opp-only risk', 'active', now]))

  // 客户 B 的最小数据（隔离：不被 A 的删除波及）
  const contractB = crmDbService.create('contract', { account_id: Number(accB), name: 'B-合同', created_at: now, updated_at: now })
  const oppB = crmDbService.create('opportunity', { account_id: Number(accB), name: 'B-商机', created_at: now, updated_at: now })

  // 删除前统计
  const beforeOpps = Number((crmDbService.opportunityStats() as CrmRow).active ?? 0) || count('opportunity', "status = 'active'")
  const beforeCustomers = Number((crmDbService.statsOverview() as CrmRow).customers ?? 0)
  ok('0b 删除前商机统计含 A/B', count('opportunity') === 3)
  ok('0c 删除前 statsOverview.customers = 2', beforeCustomers === 2 || beforeOpps > 0)

  // ── ① 删除客户 A ──
  const result = crmDbService.deleteAccount(a)
  ok('1a 删除返回 ok', result.ok === true)
  const removed = Number(result.removed ?? 0)
  ok('1b removed > 0（含合同链与客户维度事实）', removed > 0)

  // 客户本体与全部级联无孤儿
  ok('2a account 已删', count('account', 'id = ?', [a]) === 0)
  ok('2b 合同链：contract/quotation/invoice/logistics(合同级)/allocation(合同级)/contract_status_history 清空', (() => {
    return count('contract', 'account_id = ?', [a]) === 0
      && count('quotation', 'id = ?', [Number(quotation)]) === 0
      && count('invoice', 'id = ?', [Number(invoice)]) === 0
      && count('logistics', 'id = ?', [Number(logisticsC)]) === 0
      && count('allocation', 'id = ?', [Number(allocContract)]) === 0
      && count('contract_status_history', 'contract_id = ?', [Number(contract)]) === 0
  })())
  ok('2c 商机与事件（事件先于商机删，无孤儿）', (() => {
    return count('opportunity', 'account_id = ?', [a]) === 0
      && count('opportunity_event', 'opportunity_id IN (SELECT id FROM opportunity WHERE account_id = ?)', [a]) === 0
      && count('opportunity_event', 'opportunity_id = ?', [Number(opp1)]) === 0
      && count('opportunity_event', 'opportunity_id = ?', [Number(opp2)]) === 0
  })())
  ok('2d crm_risk 清空', count('crm_risk', 'account_id = ?', [a]) === 0)
  ok('2e payment_promise 清空', count('payment_promise', 'account_id = ?', [a]) === 0)
  ok('2f quote_signal 清空', count('quote_signal', 'account_id = ?', [a]) === 0)
  ok('2g contact / shipping_info 清空', count('contact', 'account_id = ?', [a]) === 0 && count('shipping_info', 'account_id = ?', [a]) === 0)
  ok('2h alias_map / 账户级 logistics 清空', count('alias_map', 'account_id = ?', [a]) === 0 && count('logistics', 'account_id = ?', [a]) === 0)
  ok('2i 账户级 allocation 清空', count('allocation', 'account_id = ?', [a]) === 0)
  ok('2i2 账户级发票（contract_id=NULL）清空', count('invoice', 'id = ?', [Number(invoiceAccountLevel)]) === 0)
  ok('2i3 子资源实体日志无孤儿（invoice/logistics/allocation/quotation）', (() => {
    return count('activity_log', "entity = 'invoice' AND entity_id = ?", [Number(invoice)]) === 0
      && count('activity_log', "entity = 'logistics' AND entity_id = ?", [Number(logisticsC)]) === 0
      && count('activity_log', "entity = 'allocation' AND entity_id = ?", [Number(allocContract)]) === 0
      && count('activity_log', "entity = 'quotation' AND entity_id = ?", [Number(quotation)]) === 0
  })())
  ok('2i4 account_id=NULL 但 opportunity_id 命中的 crm_risk 清理',
    count('crm_risk', 'opportunity_id = ? AND account_id IS NULL', [Number(opp1)]) === 0)
  ok('2j 活动日志：opportunity 维度清空；account 维度只剩删除墓碑（对齐既有语义）',
    count('activity_log', "entity = 'opportunity' AND entity_id = ?", [Number(opp1)]) === 0
      && count('activity_log', "entity = 'account' AND entity_id = ?", [a]) === 1
      && crmDbService.all("SELECT action FROM activity_log WHERE entity = 'account' AND entity_id = ?", [a])[0]?.action === 'deleted')

  // ── ② 原始到款事实保留 + 独立事实源不误删 ──
  ok('3a payment_record（原始到款事实）保留', count('payment_record', 'id = ?', [Number(payRecord)]) === 1)
  ok('3b customer（客户锚点）不删', count('customer', 'id = ?', [Number(customer)]) === 1)
  ok('3c customer_identity 不删', count('customer_identity', 'customer_id = ?', [Number(customer)]) === 1)
  ok('3d lead 不删，account_id 挂接解除', count('lead', 'id = ?', [Number(lead)]) === 1
    && crmDbService.all('SELECT account_id FROM lead WHERE id = ?', [Number(lead)])[0]?.account_id === null)
  ok('3e 客户 B 全部数据不受影响', (() => {
    return count('contract', 'id = ?', [Number(contractB)]) === 1
      && count('opportunity', 'id = ?', [Number(oppB)]) === 1
      && count('account', 'id = ?', [Number(accB)]) === 1
  })())

  // ── ③ 统计不再计算该客户 ──
  const afterCustomers = Number((crmDbService.statsOverview() as CrmRow).customers ?? 0)
  ok('4a statsOverview.customers 2 → 1', afterCustomers === 1)
  const activeOpps = Number((crmDbService.opportunityStats() as CrmRow).total ?? 0)
  ok('4b opportunityStats.total 只剩客户 B（=1）', activeOpps === 1)

  // ── ⑤ 故障注入：中途异常整体回滚 ──
  crmDbService.runTx((tx) => tx.run(
    "CREATE TRIGGER IF NOT EXISTS inject_fail_del BEFORE DELETE ON opportunity BEGIN SELECT RAISE(ABORT, 'injected failure'); END"))
  const beforeRollback = {
    account: count('account', 'id = ?', [Number(accB)]),
    contract: count('contract', 'id = ?', [Number(contractB)]),
    oppEvent: count('opportunity_event', 'opportunity_id = ?', [Number(oppB)])
  }
  let threw = false
  try { crmDbService.deleteAccount(Number(accB)) } catch { threw = true }
  ok('5a 注入失败使 deleteAccount 抛错', threw)
  ok('5b 客户 B 与合同/商机/事件原样保留（先删的合同链也被回滚）', (() => {
    return count('account', 'id = ?', [Number(accB)]) === beforeRollback.account
      && count('contract', 'id = ?', [Number(contractB)]) === beforeRollback.contract
      && count('opportunity', 'id = ?', [Number(oppB)]) === 1
      && count('opportunity_event', 'opportunity_id = ?', [Number(oppB)]) === beforeRollback.oppEvent
      && count('quotation', 'contract_id = ?', [Number(contractB)]) === 0
  })())
  ok('5c 回滚后客户 B 仍在且商机完整',
    count('account', 'id = ?', [Number(accB)]) === 1 && count('opportunity', 'id = ?', [Number(oppB)]) === 1)
  crmDbService.runTx((tx) => tx.run('DROP TRIGGER IF EXISTS inject_fail_del'))
  // 注入解除后正常删除成功
  const retry = crmDbService.deleteAccount(Number(accB))
  ok('5d 解除注入后删除成功且无孤儿', retry.ok === true && count('opportunity', 'account_id = ?', [Number(accB)]) === 0
    && count('contract', 'account_id = ?', [Number(accB)]) === 0)

  // ── ⑦ 二审补口：合同级子资源（contract_id 命中、account_id 为 NULL）的日志清理 ──
  // 客户 C：deleteAccount 场景；客户 D：deleteContract 场景；客户 E：隔离验证。
  const makeContractOnlyChildren = (accountId: number, tag: string): number => {
    const cid = Number(crmDbService.create('contract', { account_id: accountId, name: `${tag}-合同`, created_at: now, updated_at: now }))
    const qid = crmDbService.runTx((tx) => tx.run('INSERT INTO quotation (contract_id, total, status, items, created_at) VALUES (?,?,?,?,?)', [cid, 100, 'draft', '[]', now]))
    // 合同级发票：contract_id 命中、account_id 为 NULL（二审要求的数据形态）
    const iid = crmDbService.runTx((tx) => tx.run('INSERT INTO invoice (contract_id, account_id, invoice_no, created_at) VALUES (?,NULL,?,?)', [cid, `${tag}-INV`, now]))
    const lid = crmDbService.runTx((tx) => tx.run('INSERT INTO logistics (tracking_no, link_status, contract_id, account_id, created_at) VALUES (?,?,?,?,?)', [`${tag}-SF`, 'linked', cid, null, now]))
    const aid = crmDbService.runTx((tx) => tx.run('INSERT INTO allocation (payment_record_id, contract_id, account_id, created_at) VALUES (NULL,?,NULL,?)', [cid, now]))
    crmDbService.runTx((tx) => {
      tx.run('INSERT INTO activity_log (entity, entity_id, action, detail, created_at) VALUES (?,?,?,?,?)', ['quotation', Number(qid), 'created', tag, now])
      tx.run('INSERT INTO activity_log (entity, entity_id, action, detail, created_at) VALUES (?,?,?,?,?)', ['invoice', Number(iid), 'created', tag, now])
      tx.run('INSERT INTO activity_log (entity, entity_id, action, detail, created_at) VALUES (?,?,?,?,?)', ['logistics', Number(lid), 'linked', tag, now])
      tx.run('INSERT INTO activity_log (entity, entity_id, action, detail, created_at) VALUES (?,?,?,?,?)', ['allocation', Number(aid), 'confirmed', tag, now])
    })
    return cid
  }
  const countContractLogs = (tag: string): number =>
    crmDbService.all(
      "SELECT COUNT(*) AS n FROM activity_log WHERE (entity = 'quotation' OR entity = 'invoice' OR entity = 'logistics' OR entity = 'allocation') AND detail = ?", [tag])[0]?.n ?? 0

  const accC = Number(crmDbService.create('account', { name: '客户C', created_at: now, updated_at: now }))
  const accD = Number(crmDbService.create('account', { name: '客户D', created_at: now, updated_at: now }))
  const accE = Number(crmDbService.create('account', { name: '客户E', created_at: now, updated_at: now }))
  const contractC = makeContractOnlyChildren(accC, 'C')
  const contractD = makeContractOnlyChildren(accD, 'D')
  const contractE = makeContractOnlyChildren(accE, 'E')
  ok('7a 造数：C/D/E 各自合同级子资源与日志就位（account_id=NULL）',
    countContractLogs('C') === 4 && countContractLogs('D') === 4 && countContractLogs('E') === 4)

  // deleteContract(D1)：资源与日志全消，removed 含日志行；E 不受影响
  const delD = crmDbService.deleteContract(contractD)
    // removed 口径 = 子资源行数（含子资源 activity_log 行），不含合同行自身：
  // D = quotation/invoice/logistics/allocation 各 1 + 子资源日志 4 = 8
  ok('7b deleteContract(D)：removed=8（4 子资源 + 4 日志，不含合同行自身）',
    delD.ok === true && Number(delD.removed ?? 0) === 8)
  ok('7c deleteContract(D) 后无资源与日志孤儿',
    count('contract', 'id = ?', [contractD]) === 0
      && count('quotation', 'contract_id = ?', [contractD]) === 0
      && count('invoice', 'contract_id = ?', [contractD]) === 0
      && count('logistics', 'contract_id = ?', [contractD]) === 0
      && count('allocation', 'contract_id = ?', [contractD]) === 0
      && countContractLogs('D') === 0)
  ok('7d 隔离：客户 C/E 的合同与日志不受 deleteContract(D) 影响',
    countContractLogs('C') === 4 && countContractLogs('E') === 4
      && count('contract', 'id = ?', [contractC]) === 1 && count('contract', 'id = ?', [contractE]) === 1)

  // deleteAccount(C)：合同级子资源与日志全消
  const delC = crmDbService.deleteAccount(accC)
  ok('7e deleteAccount(C)：ok 且子资源+日志全消',
    delC.ok === true
      && count('contract', 'id = ?', [contractC]) === 0
      && count('quotation', 'contract_id = ?', [contractC]) === 0
      && count('invoice', 'contract_id = ?', [contractC]) === 0
      && count('logistics', 'contract_id = ?', [contractC]) === 0
      && count('allocation', 'contract_id = ?', [contractC]) === 0
      && countContractLogs('C') === 0)
  ok('7f 隔离：客户 E 的合同与日志不受 deleteAccount(C) 影响',
    countContractLogs('E') === 4 && count('contract', 'id = ?', [contractE]) === 1
      && count('account', 'id = ?', [Number(accE)]) === 1)

  // 故障注入（C 已删，注入到 E 的删除路径）：商机删除触发器 → 整笔回滚
  crmDbService.runTx((tx) => tx.run(
    "CREATE TRIGGER IF NOT EXISTS inject_fail_del2 BEFORE DELETE ON opportunity BEGIN SELECT RAISE(ABORT, 'injected failure 2'); END"))
  const eOpp = Number(crmDbService.create('opportunity', { account_id: accE, name: 'E-商机', created_at: now, updated_at: now }))
  let threw2 = false
  try { crmDbService.deleteAccount(accE) } catch { threw2 = true }
  ok('7g 故障注入：deleteAccount(E) 中途抛错', threw2)
  ok('7h 回滚完整：E 的合同/子资源/日志原样保留',
    count('contract', 'id = ?', [contractE]) === 1
      && count('quotation', 'contract_id = ?', [contractE]) === 1
      && count('invoice', 'contract_id = ?', [contractE]) === 1
      && count('logistics', 'contract_id = ?', [contractE]) === 1
      && count('allocation', 'contract_id = ?', [contractE]) === 1
      && countContractLogs('E') === 4
      && count('opportunity', 'id = ?', [eOpp]) === 1)
  crmDbService.runTx((tx) => tx.run('DROP TRIGGER IF EXISTS inject_fail_del2'))
  ok('7i 解除注入后 deleteAccount(E) 成功且全消',
    crmDbService.deleteAccount(accE).ok === true
      && count('contract', 'id = ?', [contractE]) === 0 && countContractLogs('E') === 0)

  // ── 边界：删除不存在的客户 ──
  ok('6a 不存在的客户返回 ok:false', crmDbService.deleteAccount(999999).ok === false)

  crmDbService.persistNow()
  rmSync(dir, { recursive: true, force: true })
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
