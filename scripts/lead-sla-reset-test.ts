/**
 * lead-sla-reset-test.ts —— 决策B存量处置「群扫线索 SLA 存量重置」副本验证
 *
 * 验证 resetLegacyGroupScanSla（crmLeadService）：
 *   A. 真实库副本上执行 → 超时 NEW 线索清零、pending sla_lead 卡全关单、audit_event 留痕
 *   B. 二次执行 → 0/0（天然幂等）
 *   C. 非群扫/非 NEW 线索不受影响；新导入线索（导入即起计时）不受影响
 *
 * ⛔ 同 dry-run-all 铁律：源库复制到 /tmp 副本 → 应用链路 initialize → 绝不触碰 live 库。
 * 用法：npx tsx scripts/lead-sla-reset-test.ts
 */
import { copyFileSync, mkdtempSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { crmDbService } from '../electron/services/crmDbService'
import { salesDbService } from '../electron/services/salesDbService'
import { findExistingBusinessDb } from '../electron/services/businessDbPath'
import { resetLegacyGroupScanSla, importLeads } from '../electron/services/crmLeadService'
import { LEAD_SLA_UNASSIGNED_SENTINEL } from '../shared/leadSla'

let pass = 0, fail = 0
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; console.log(`  ✅ ${name}`) } else { fail++; console.log(`  ❌ ${name} ${detail}`) }
}

async function main(): Promise<void> {
  const userData = join(homedir(), 'Library', 'Application Support', 'weflow')
  const crmSrc = findExistingBusinessDb(userData, 'crm')
  const salesSrc = findExistingBusinessDb(userData, 'sales')
  if (!crmSrc || !salesSrc) { console.error('未找到 live 业务库'); process.exit(1) }

  // 副本隔离：两库同名 legacy 落到同一 tmp 目录（initialize 不带 wxid）
  const dir = mkdtempSync(join(tmpdir(), 'sla-reset-test-'))
  copyFileSync(crmSrc, join(dir, 'weflow-crm.db'))
  copyFileSync(salesSrc, join(dir, 'weflow-sales.db'))
  await crmDbService.initialize(dir)
  await salesDbService.initialize(dir)
  console.log(`副本试跑：crm ← ${crmSrc.replace(homedir(), '~')}；sales ← ${salesSrc.replace(homedir(), '~')}`)

  const now = Date.now()
  const overdueBefore = Number(crmDbService.all("SELECT COUNT(*) AS c FROM lead WHERE status = 'NEW' AND first_contact_deadline < ?", [now])[0].c)
  const pendingBefore = salesDbService.todoList({ status: 'pending', limit: 100000 }).filter((t) => t.trigger_type === 'sla_lead').length
  const untouchedBefore = Number(crmDbService.all("SELECT COUNT(*) AS c FROM lead WHERE NOT (source = '群资源扫描' AND status = 'NEW')")[0].c)
  console.log(`\n基线：超时 NEW ${overdueBefore} 条 / pending sla_lead 卡 ${pendingBefore} 张 / 非群扫NEW线索 ${untouchedBefore} 条`)

  console.log('\n═══ A. 首次执行 ═══')
  const r1 = resetLegacyGroupScanSla()
  console.log(`  返回：leads=${r1.leads} cards=${r1.cards}`)
  const overdueAfter = Number(crmDbService.all("SELECT COUNT(*) AS c FROM lead WHERE status = 'NEW' AND first_contact_deadline < ?", [Date.now()])[0].c)
  const pendingAfter = salesDbService.todoList({ status: 'pending', limit: 100000 }).filter((t) => t.trigger_type === 'sla_lead').length
  const skippedAfter = salesDbService.todoList({ status: 'skipped', limit: 100000 }).filter((t) => t.trigger_type === 'sla_lead').length
  check('超时 NEW 线索清零', overdueAfter === 0, `余 ${overdueAfter}`)
  check('pending sla_lead 卡清零', pendingAfter === 0, `余 ${pendingAfter}`)
  check('关单数与基线一致', r1.cards === pendingBefore && skippedAfter >= r1.cards, `cards=${r1.cards} baseline=${pendingBefore}`)
  check('重置条数与基线一致', r1.leads === overdueBefore, `leads=${r1.leads} baseline=${overdueBefore}`)
  check('非群扫/非 NEW 线索零影响', Number(crmDbService.all("SELECT COUNT(*) AS c FROM lead WHERE NOT (source = '群资源扫描' AND status = 'NEW')")[0].c) === untouchedBefore)
  check('重置行 deadline = 待分配哨兵（2100）', Number(crmDbService.all("SELECT COUNT(*) AS c FROM lead WHERE source = '群资源扫描' AND status = 'NEW' AND first_contact_deadline = ?", [LEAD_SLA_UNASSIGNED_SENTINEL])[0].c) === r1.leads)
  const audit = crmDbService.all("SELECT * FROM audit_event WHERE action = 'lead_sla_stock_reset'")
  check('audit_event 留痕 1 条', audit.length === 1, `实 ${audit.length}`)
  if (audit.length) {
    const d = JSON.parse(String(audit[0].detail || '{}'))
    check('审计 detail 计数正确', d.leads === r1.leads && d.cardsClosed === r1.cards, JSON.stringify(d))
  }

  console.log('\n═══ B. 幂等复验 ═══')
  const r2 = resetLegacyGroupScanSla()
  check('二次执行 0/0', r2.leads === 0 && r2.cards === 0, `leads=${r2.leads} cards=${r2.cards}`)
  check('审计仍只有 1 条', crmDbService.all("SELECT COUNT(*) AS c FROM audit_event WHERE action = 'lead_sla_stock_reset'")[0].c === 1)

  console.log('\n═══ C. 新导入线索不受影响（导入即起计时现状保留） ═══')
  const imp = importLeads('自定义', 'test.txt', [{ text: '13800001234 测试客户' }])
  check('新导入成功', imp.valid === 1, JSON.stringify(imp))
  const newLead = crmDbService.all("SELECT * FROM lead WHERE source = '自定义' ORDER BY id DESC LIMIT 1")[0]
  check('新线索仍有首触期限', newLead && newLead.first_contact_deadline !== null && Number(newLead.first_contact_deadline) > Date.now())
  const r3 = resetLegacyGroupScanSla()
  check('新线索不被重置误伤', r3.leads === 0 && newLead && crmDbService.getById('lead', Number(newLead.id))!.first_contact_deadline !== null)

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  process.exit(fail ? 1 : 0)
}

void main()
