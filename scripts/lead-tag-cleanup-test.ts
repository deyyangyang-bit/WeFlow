/**
 * lead-tag-cleanup-test.ts —— 宪法 §4.2 决策B「群扫 tag 归属残留清理」副本验证
 *
 * 验证 cleanupLegacyGroupScanTags（crmLeadService）：
 *   A. 真实库副本上执行 → 群扫线索 tag 全清空；非「未分配」tag 值挪 note 留痕（曾归属:{tag}（日期））
 *   B. 幂等：二次执行 0/0，audit_event 不重复
 *   C. 边界：tag='未分配' 清空不留痕；note 已含同值曾归属 → 只清 tag 不重复追加；非群扫线索不动
 *
 * ⛔ 同 dry-run-all 铁律：源库复制到 /tmp 副本 → 应用链路 initialize → 绝不触碰 live 库。
 * 用法：npx tsx scripts/lead-tag-cleanup-test.ts
 */
import { copyFileSync, mkdtempSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { crmDbService } from '../electron/services/crmDbService'
import { salesDbService } from '../electron/services/salesDbService'
import { findExistingBusinessDb } from '../electron/services/businessDbPath'
import { cleanupLegacyGroupScanTags } from '../electron/services/crmLeadService'

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

  const dir = mkdtempSync(join(tmpdir(), 'tag-cleanup-test-'))
  copyFileSync(crmSrc, join(dir, 'weflow-crm.db'))
  copyFileSync(salesSrc, join(dir, 'weflow-sales.db'))
  await crmDbService.initialize(dir)
  await salesDbService.initialize(dir)
  console.log(`副本试跑：crm ← ${crmSrc.replace(homedir(), '~')}`)

  const legacyWithTag = count("SELECT COUNT(*) AS c FROM lead WHERE source = '群资源扫描' AND tag IS NOT NULL AND tag <> ''")
  const legacyUnassigned = count("SELECT COUNT(*) AS c FROM lead WHERE source = '群资源扫描' AND tag = '未分配'")
  const nonLegacyWithTag = count("SELECT COUNT(*) AS c FROM lead WHERE source <> '群资源扫描' AND tag IS NOT NULL AND tag <> ''")
  console.log(`\n基线：群扫带 tag ${legacyWithTag} 条（其中「未分配」${legacyUnassigned}）/ 非群扫带 tag ${nonLegacyWithTag} 条`)

  // C 组边界样本：① note 已含同值曾归属；② 非群扫带 tag 线索（不应被动）
  const now = Date.now()
  crmDbService.runTx((tx) => {
    tx.run('INSERT INTO lead (contact_type, contact_normalized, contact_raw, wechat, source, name, tag, note, status, first_contact_deadline, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['手机号', '13899990001', '13899990001', '', '群资源扫描', '边界-已留痕', '杨青', '曾有跟进；曾归属:杨青（2026-09-01）', 'NEW', 4102444800000, now, now])
    tx.run('INSERT INTO lead (contact_type, contact_normalized, contact_raw, wechat, source, name, tag, note, status, first_contact_deadline, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['手机号', '13899990002', '13899990002', '', '自定义', '边界-非群扫', '许丽娟', '', 'NEW', 4102444800000, now, now])
  })
  const expectCleared = legacyWithTag + 1 // 存量 + 边界样本①

  console.log('\n═══ A. 首次执行 ═══')
  const r1 = cleanupLegacyGroupScanTags()
  console.log(`  返回：cleared=${r1.cleared} noted=${r1.noted}`)
  check('清空条数 = 基线 + 边界样本', r1.cleared === expectCleared, `cleared=${r1.cleared} 期望 ${expectCleared}`)
  check('留痕条数 = 清空 - 未分配', r1.noted === expectCleared - legacyUnassigned, `noted=${r1.noted}`)
  check('群扫 tag 残留清零', count("SELECT COUNT(*) AS c FROM lead WHERE source = '群资源扫描' AND tag IS NOT NULL AND tag <> ''") === 0)
  check('留痕行 note 含「曾归属」', count("SELECT COUNT(*) AS c FROM lead WHERE source = '群资源扫描' AND note LIKE '%曾归属:%'") >= r1.noted, `实 ${count("SELECT COUNT(*) AS c FROM lead WHERE source = '群资源扫描' AND note LIKE '%曾归属:%'")}`)
  check('「未分配」行不留痕', count("SELECT COUNT(*) AS c FROM lead WHERE source = '群资源扫描' AND note LIKE '%曾归属:未分配%'") === 0)
  const audit = crmDbService.all("SELECT * FROM audit_event WHERE action = 'lead_tag_owner_cleanup'")
  check('audit_event 留痕 1 条', audit.length === 1, `实 ${audit.length}`)
  if (audit.length) {
    const d = JSON.parse(String(audit[0].detail || '{}'))
    check('审计 detail 计数正确', d.cleared === r1.cleared && d.noted === r1.noted, JSON.stringify(d))
  }

  console.log('\n═══ B. 幂等复验 ═══')
  const r2 = cleanupLegacyGroupScanTags()
  check('二次执行 0/0', r2.cleared === 0 && r2.noted === 0, `cleared=${r2.cleared} noted=${r2.noted}`)
  check('审计仍只有 1 条', count("SELECT COUNT(*) AS c FROM audit_event WHERE action = 'lead_tag_owner_cleanup'") === 1)

  console.log('\n═══ C. 边界 ═══')
  const b1 = crmDbService.all("SELECT tag, note FROM lead WHERE contact_normalized = '13899990001'")[0]
  check('已留痕行不重复追加', String(b1.note).split('曾归属:杨青').length - 1 === 1, String(b1.note))
  check('已留痕行 tag 已清', !b1.tag || String(b1.tag) === '', String(b1.tag))
  const b2 = crmDbService.all("SELECT tag, note FROM lead WHERE contact_normalized = '13899990002'")[0]
  check('非群扫线索不受影响', String(b2.tag) === '许丽娟' && String(b2.note ?? '') === '', `tag=${b2.tag} note=${b2.note}`)
  check('非群扫带 tag 计数不变', count("SELECT COUNT(*) AS c FROM lead WHERE source <> '群资源扫描' AND tag IS NOT NULL AND tag <> ''") === nonLegacyWithTag + 1)

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  process.exit(fail ? 1 : 0)
}

void main()
