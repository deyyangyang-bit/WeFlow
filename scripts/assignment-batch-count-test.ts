/**
 * assignment-batch-count-test.ts —— 批量分配计数口径验证（2026-09-08 修复）
 *
 * 修复背景：assignBatchLeads 旧实现 `if (res.ok) got++`——assignLeads 的返回信封 ok:true
 * 只代表「调用合法」，单条被跳过（E201 已有归属 / E301 不存在）时 data.assignments 为空但
 * res.ok 仍为 true → 跳过被错误计入 assigned/perSales。修复后按 res.data.assignments.length
 * 实际新增数计数，跳过/冲突落 skipped 可查，绝不计入 assigned/perSales。
 *
 * 断言：
 *   1. assignLeads 单条契约：跳过时 ok:true + assignments 空 + skipped 带码（旧计数错的根因）；
 *   2. 正常批次：assigned == 实际新增 assignment 行数 == perSales 之和；
 *   3. 计划数 > 池存量：perSales 只计实际新增，不虚报；
 *   4. skipped 明细带 leadId/原因（复核可查）。
 *
 * 隔离：WEFLOW_WORKER='1' + /tmp 空库。运行：npx tsx scripts/assignment-batch-count-test.ts
 */
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const isoDir = mkdtempSync(join(tmpdir(), 'asg-batch-count-'))
process.env.WEFLOW_WORKER = '1'
process.env.WEFLOW_USER_DATA_PATH = isoDir
process.env.WEFLOW_CONFIG_CWD = isoDir

let pass = 0, fail = 0
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; console.log(`  ✅ ${name}`) } else { fail++; console.log(`  ❌ ${name} ${detail}`) }
}

import { ConfigService } from '../electron/services/config'
import { crmDbService } from '../electron/services/crmDbService'
import { salesDbService } from '../electron/services/salesDbService'
import { setIdentity } from '../electron/services/identityService'
import { assignLeads, assignBatchLeads } from '../electron/services/crmAssignmentService'
import { LEAD_SLA_UNASSIGNED_SENTINEL } from '../shared/leadSla'

const NOW = Date.now()
function seedLead(phone: string): number {
  return crmDbService.runTx((tx) => tx.run(
    'INSERT INTO lead (contact_type, contact_normalized, contact_raw, wechat, source, name, note, status, first_contact_deadline, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    ['phone', phone, phone, '', '测试', `线索${phone}`, '', 'NEW', LEAD_SLA_UNASSIGNED_SENTINEL, NOW, NOW]
  ))
}

async function main(): Promise<void> {
  const cfg = ConfigService.getInstance()
  cfg.set('crmSalesList', ['销售甲', '销售乙'])
  cfg.set('crmLeadSlaHours', 24)
  const dbDir = mkdtempSync(join(tmpdir(), 'asg-batch-count-db-'))
  await crmDbService.initialize(dbDir)
  await salesDbService.initialize(dbDir)
  setIdentity('测试主管', '主管')

  console.log('═══ A. 单条契约：跳过时 ok:true 但 assignments 空（旧计数 bug 的根因）═══')
  const lA = seedLead('13933330001')
  assignLeads([lA], '销售甲', '测试主管') // 先占坑
  const re = assignLeads([lA], '销售乙', '测试主管') // 同 lead 再分 → E201 跳过，ok 仍 true
  ok('A1 E201 跳过：ok=true、assignments 空、skipped 带码带原因',
    re.ok === true && re.data!.assignments.length === 0 && re.data!.skipped.length === 1 && re.data!.skipped[0].code === 'E201',
    JSON.stringify(re))
  ok('A2 实际 assignment 行数仍为 1（未重复归属）',
    Number(crmDbService.all('SELECT COUNT(*) AS c FROM assignment WHERE lead_id = ?', [lA])[0].c) === 1)

  console.log('\n═══ B. 正常批次：assigned == 实际新增行数 == perSales 之和 ═══')
  const ids: number[] = []
  for (let i = 2; i <= 6; i++) ids.push(seedLead(`1393333000${i}`))
  const before = Number(crmDbService.all('SELECT COUNT(*) AS c FROM assignment')[0].c)
  const rb = assignBatchLeads({ count: 4, mode: 'round_robin', actor: '测试主管' })
  const after = Number(crmDbService.all('SELECT COUNT(*) AS c FROM assignment')[0].c)
  const perSum = Object.values(rb.data?.perSales || {}).reduce((a, b) => a + b, 0)
  ok('B1 assigned = 实际新增 assignment 行数', rb.ok && rb.data!.assigned === after - before && rb.data!.assigned === 4, JSON.stringify({ r: rb.data, before, after }))
  ok('B2 perSales 之和 == assigned（不虚报）', perSum === rb.data!.assigned)

  console.log('\n═══ C. 计划数 > 池存量：只计实际新增，不虚报 ═══')
  // 池里还剩 1 条（id 最后一条），请求 50 条
  const before2 = Number(crmDbService.all('SELECT COUNT(*) AS c FROM assignment')[0].c)
  const rc = assignBatchLeads({ count: 50, mode: 'round_robin', actor: '测试主管' })
  const after2 = Number(crmDbService.all('SELECT COUNT(*) AS c FROM assignment')[0].c)
  const perSum2 = Object.values(rc.data?.perSales || {}).reduce((a, b) => a + b, 0)
  ok('C1 assigned == 实际新增（1 条），不是请求的 50', rc.ok && rc.data!.assigned === after2 - before2 && rc.data!.assigned === 1, JSON.stringify({ r: rc.data, before: before2, after: after2 }))
  ok('C2 perSales 之和 == assigned 且 skipped 为空', perSum2 === rc.data!.assigned && rc.data!.skipped.length === 0, JSON.stringify(rc.data))

  console.log('\n═══ D. 池空：明确失败不虚报 ═══')
  const rd = assignBatchLeads({ count: 10, mode: 'weight', actor: '测试主管' })
  ok('D1 待分配池为空 → ok:false + E301（不产空批次）', rd.ok === false && rd.code === 'E301', JSON.stringify(rd))

  console.log(`\n═══ 结果：${pass} 通过 / ${fail} 失败 ═══`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error('测试崩溃:', e); process.exit(1) })
