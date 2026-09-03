/**
 * lead-assignment-restore-test.ts —— 「群扫旧 tag 归属恢复为正式分配」副本验证
 *
 * 验证 restoreLegacyGroupScanAssignments（crmAssignmentService）：
 *   A. 真实库副本执行 → 杨青/李林辉 直挂、秒变→许丽娟，计数与 note 留痕分组一致
 *   B. 幂等：二次执行全部 0（assignLeads E201 幂等兜底）
 *   C. 静候（丁帅已离职）/未分配 → 留资源池，零 assignment；流水/审计逐条可查
 *
 * ⛔ 同 dry-run-all 铁律：源库复制到 /tmp 副本 → 应用链路 initialize → 绝不触碰 live 库。
 * 用法：npx tsx scripts/lead-assignment-restore-test.ts
 */
import { copyFileSync, mkdtempSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { crmDbService } from '../electron/services/crmDbService'
import { salesDbService } from '../electron/services/salesDbService'
import { findExistingBusinessDb } from '../electron/services/businessDbPath'
import { restoreLegacyGroupScanAssignments, currentAssignment } from '../electron/services/crmAssignmentService'

let pass = 0, fail = 0
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; console.log(`  ✅ ${name}`) } else { fail++; console.log(`  ❌ ${name} ${detail}`) }
}
function count(sql: string, params: unknown[] = []): number {
  return Number(crmDbService.all(sql, params)[0].c)
}

async function main(): Promise<void> {
  const userData = join(homedir(), 'Library', 'Application Support', 'weflow')
  const crmSrc = findExistingBusinessDb(userData, 'crm')
  const salesSrc = findExistingBusinessDb(userData, 'sales')
  if (!crmSrc || !salesSrc) { console.error('未找到 live 业务库'); process.exit(1) }

  const dir = mkdtempSync(join(tmpdir(), 'restore-test-'))
  copyFileSync(crmSrc, join(dir, 'weflow-crm.db'))
  copyFileSync(salesSrc, join(dir, 'weflow-sales.db'))
  await crmDbService.initialize(dir)
  await salesDbService.initialize(dir)
  console.log(`副本试跑：crm ← ${crmSrc.replace(homedir(), '~')}`)

  // 基线：按 note 留痕分组计数（live 已经过 tag 清理，旧归属全在 note 里）
  // ⚠️ note 可能含多个历史标记，字符串顺序即时间顺序，取最后一个 = 清理时最终归属
  const groups: Record<string, number> = {}
  const lastMarkLeadIds: Record<string, number[]> = {}
  for (const r of crmDbService.all("SELECT id, note FROM lead WHERE source = '群资源扫描' AND note LIKE '%曾归属:%'")) {
    const marks = [...String(r.note).matchAll(/曾归属:([^（；;]+)/g)]
    if (!marks.length) continue
    const last = marks[marks.length - 1][1].trim()
    groups[last] = (groups[last] || 0) + 1
    ;(lastMarkLeadIds[last] = lastMarkLeadIds[last] || []).push(Number(r.id))
  }
  console.log('\n基线（note 留痕分组）:', JSON.stringify(groups))
  const expectYangqing = groups['杨青'] || 0
  const expectLilinhui = groups['李林辉'] || 0
  const expectMiaobian = groups['秒变'] || 0 // → 许丽娟
  const expectPooled = (groups['静候'] || 0) + (groups['未分配'] || 0)
  const activeBefore = count("SELECT COUNT(*) AS c FROM assignment WHERE deleted = 0 AND status IN ('assigned','claimed')")

  console.log('\n═══ A. 首次执行 ═══')
  const r1 = restoreLegacyGroupScanAssignments()
  console.log(`  返回：restored=${JSON.stringify(r1.restored)} pooled=${r1.pooled}`)
  check('杨青恢复计数正确', (r1.restored['杨青'] || 0) === expectYangqing, `实 ${r1.restored['杨青']} 期望 ${expectYangqing}`)
  check('李林辉恢复计数正确', (r1.restored['李林辉'] || 0) === expectLilinhui, `实 ${r1.restored['李林辉']} 期望 ${expectLilinhui}`)
  check('秒变→许丽娟计数正确', (r1.restored['许丽娟'] || 0) === expectMiaobian, `实 ${r1.restored['许丽娟']} 期望 ${expectMiaobian}`)
  check('留资源池计数 = 静候+未分配', r1.pooled === expectPooled, `实 ${r1.pooled} 期望 ${expectPooled}`)
  const restoredTotal = expectYangqing + expectLilinhui + expectMiaobian
  check('有效分配总数新增一致', count("SELECT COUNT(*) AS c FROM assignment WHERE deleted = 0 AND status IN ('assigned','claimed')") === activeBefore + restoredTotal)
  check('许丽娟名下无「秒变」字面残留', count("SELECT COUNT(*) AS c FROM assignment WHERE sales_name = '秒变'") === 0)
  const ownRows = count("SELECT COUNT(*) AS c FROM ownership_history WHERE entity_type = 'lead' AND reason = '分配' AND actor = 'system:migration'")
  check('ownership_history 逐条留痕', ownRows === restoredTotal, `实 ${ownRows} 期望 ${restoredTotal}`)
  const auditRows = count("SELECT COUNT(*) AS c FROM audit_event WHERE action = 'lead_assign' AND actor = 'system:migration'")
  check('audit_event 逐条留痕', auditRows === restoredTotal, `实 ${auditRows} 期望 ${restoredTotal}`)
  const sampleId = (lastMarkLeadIds['杨青'] || [])[0]
  check('抽查：最终归属杨青的线索 currentAssignment 命中', !!sampleId && String(currentAssignment(sampleId)?.sales_name || '') === '杨青')

  console.log('\n═══ B. 幂等复验 ═══')
  const r2 = restoreLegacyGroupScanAssignments()
  check('二次执行零新增', Object.values(r2.restored).every((n) => n === 0) || Object.keys(r2.restored).length === 0, JSON.stringify(r2.restored))
  check('审计行数不翻倍', count("SELECT COUNT(*) AS c FROM audit_event WHERE action = 'lead_assign' AND actor = 'system:migration'") === restoredTotal)

  console.log('\n═══ C. 静候/未分配留资源池 ═══')
  const jhIds = (lastMarkLeadIds['静候'] || []).slice(0, 5)
  check('静候（丁帅已离职）零分配', jhIds.length > 0 && jhIds.every((id) => currentAssignment(id) === null))
  const wfpIds = (lastMarkLeadIds['未分配'] || []).slice(0, 3)
  check('未分配线索保持未分配', wfpIds.every((id) => currentAssignment(id) === null))

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  process.exit(fail ? 1 : 0)
}

void main()
