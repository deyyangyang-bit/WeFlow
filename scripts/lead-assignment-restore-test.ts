/**
 * lead-assignment-restore-test.ts —— 「群扫旧 tag 归属恢复为正式分配」副本验证
 *
 * 验证 restoreLegacyGroupScanAssignments（crmAssignmentService）：
 *   A. 基线核验：assigned/流水/审计 ≥ 基线快照（首次恢复已在 live 真实执行过，抽查 note 终态归属仍成立）
 *   B. 幂等：副本上重跑零新增/不超 note 留痕上限（assignLeads E201 幂等兜底）+ 审计行数不翻倍
 *   C. 静候（丁帅已离职）/未分配 → 留资源池，零 assignment；流水/审计逐条可查
 *
 * ⛔ 基线快照常量（2026-09-05 live 首跑值：杨青 981 / 李林辉 1356 / 秒变→许丽娟 1511，合计 3,848；
 *    不再绑死精确数——漂移原因：① 首次恢复已在 live 真实执行，副本重跑属幂等重入（restored 恒 0）；
 *    ② 回收器/分配员后续操作使流水与审计只增不减（append-only），精确断言必然红，§2.69 遗留修复）。
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

  // 基线快照常量（2026-09-05 live 首跑值，漂移原因见头注释）：断言口径 = ≥ 基线 且 重跑幂等不翻倍
  const BASELINE_ASSIGNED = 3848
  const BASELINE_RESTORED: Record<string, number> = { '杨青': 981, '李林辉': 1356, '许丽娟': 1511 }

  console.log('\n═══ A. 基线核验（首次恢复已在 live 真实执行）═══')
  check('有效分配 ≥ 基线 3,848', activeBefore >= BASELINE_ASSIGNED, `实 ${activeBefore}`)
  const ownRows = count("SELECT COUNT(*) AS c FROM ownership_history WHERE entity_type = 'lead' AND reason = '分配' AND actor = 'system:migration'")
  check('ownership_history 留痕 ≥ 基线 3,848（append-only）', ownRows >= BASELINE_ASSIGNED, `实 ${ownRows}`)
  const auditRows = count("SELECT COUNT(*) AS c FROM audit_event WHERE action = 'lead_assign' AND actor = 'system:migration'")
  check('audit_event 留痕 ≥ 基线 3,848（append-only）', auditRows >= BASELINE_ASSIGNED, `实 ${auditRows}`)
  check('许丽娟名下无「秒变」字面残留（恢复语义生效）', count("SELECT COUNT(*) AS c FROM assignment WHERE sales_name = '秒变'") === 0)
  const sampleId = (lastMarkLeadIds['杨青'] || [])[0]
  check('抽查：最终归属杨青的线索 currentAssignment 命中', !!sampleId && String(currentAssignment(sampleId)?.sales_name || '') === '杨青')

  console.log('\n═══ B. 副本幂等复验（重跑不翻倍）═══')
  const activeBeforeRun = count("SELECT COUNT(*) AS c FROM assignment WHERE deleted = 0 AND status IN ('assigned','claimed')")
  const auditBeforeRun = count("SELECT COUNT(*) AS c FROM audit_event WHERE action = 'lead_assign' AND actor = 'system:migration'")
  const r1 = restoreLegacyGroupScanAssignments()
  const auditAfterR1 = count("SELECT COUNT(*) AS c FROM audit_event WHERE action = 'lead_assign' AND actor = 'system:migration'")
  console.log(`  返回：restored=${JSON.stringify(r1.restored)} pooled=${r1.pooled}`)
  // 恢复动作只补空缺，绝不超 note 留痕分组上限（重复导入防翻倍）
  for (const [name, cap] of Object.entries({ '杨青': expectYangqing, '李林辉': expectLilinhui, '许丽娟': expectMiaobian })) {
    check(`${name} 重跑恢复数 ≤ note 留痕上限（${cap}）`, (r1.restored[name] || 0) <= cap, `实 ${r1.restored[name] || 0}`)
  }
  const restoredTotal = Object.values(r1.restored).reduce((a, b) => a + Number(b || 0), 0)
  check('有效分配总数新增一致（本轮实际恢复数）', count("SELECT COUNT(*) AS c FROM assignment WHERE deleted = 0 AND status IN ('assigned','claimed')") === activeBeforeRun + restoredTotal)
  const r2 = restoreLegacyGroupScanAssignments()
  check('二次执行零新增（E201 幂等兜底）', Object.values(r2.restored).every((n) => n === 0) || Object.keys(r2.restored).length === 0, JSON.stringify(r2.restored))
  check('审计行数不翻倍（r2 相对 r1 零新增）', count("SELECT COUNT(*) AS c FROM audit_event WHERE action = 'lead_assign' AND actor = 'system:migration'") === auditAfterR1)
  void auditBeforeRun
  check('留资源池计数 = 静候+未分配（note 分组口径不变）', r1.pooled === expectPooled, `实 ${r1.pooled} 期望 ${expectPooled}`)

  console.log('\n═══ C. 静候/未分配留资源池 ═══')
  const jhIds = (lastMarkLeadIds['静候'] || []).slice(0, 5)
  check('静候（丁帅已离职）零分配', jhIds.length > 0 && jhIds.every((id) => currentAssignment(id) === null))
  const wfpIds = (lastMarkLeadIds['未分配'] || []).slice(0, 3)
  check('未分配线索保持未分配', wfpIds.every((id) => currentAssignment(id) === null))

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  process.exit(fail ? 1 : 0)
}

void main()
