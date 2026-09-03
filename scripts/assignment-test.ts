/**
 * assignment-test.ts —— 线索分配（Phase 1 最小可用：assign + list）副本验证
 *
 * 验证 crmAssignmentService（API-CONTRACT §1.14 契约）：
 *   A. 分配 3 条 NEW 线索成功 → assignment / ownership_history / audit_event 三表各落行
 *   B. 重复分配同一线索被拒（E201，进 skipped）；不存在线索 E301；缺参数 E101
 *   C. list 按 salesName 过滤 + 分页正确
 *   D. assignment 行通用五列齐全（source/updated_by/updated_at/version/deleted）
 *   E. 分配后 lead.status 不变（分配状态永不入 lead 表，宪法 §1.3）
 *
 * ⛔ 同 dry-run-all 铁律：源库复制到 /tmp 副本 → 应用链路 initialize → 绝不触碰 live 库。
 * 用法：npx tsx scripts/assignment-test.ts
 */
import { copyFileSync, mkdtempSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { crmDbService } from '../electron/services/crmDbService'
import { findExistingBusinessDb } from '../electron/services/businessDbPath'
import { assignLeads, listAssignments, currentAssignment } from '../electron/services/crmAssignmentService'

let pass = 0, fail = 0
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; console.log(`  ✅ ${name}`) } else { fail++; console.log(`  ❌ ${name} ${detail}`) }
}

const SALES = '测试销售甲'
const ACTOR = '分配员'

async function main(): Promise<void> {
  const userData = join(homedir(), 'Library', 'Application Support', 'weflow')
  const crmSrc = findExistingBusinessDb(userData, 'crm')
  if (!crmSrc) { console.error('未找到 live crm 业务库'); process.exit(1) }

  // 副本隔离：live 库复制到 /tmp，initialize 指向副本目录，全程不写 live 库
  const dir = mkdtempSync(join(tmpdir(), 'assignment-test-'))
  copyFileSync(crmSrc, join(dir, 'weflow-crm.db'))
  await crmDbService.initialize(dir)
  console.log(`副本试跑：crm ← ${crmSrc.replace(homedir(), '~')}`)

  // 取 3 条 NEW 且无当前有效分配的线索作样本（分配前快照 status，供 E 步对照）
  const sample = crmDbService.all(
    `SELECT id, status FROM lead l WHERE l.status = 'NEW'
     AND NOT EXISTS (SELECT 1 FROM assignment a WHERE a.lead_id = l.id AND a.deleted = 0 AND a.status IN ('assigned','claimed'))
     ORDER BY l.id LIMIT 3`)
  if (sample.length < 3) { console.error('副本内可分配 NEW 线索不足 3 条'); process.exit(1) }
  const ids = sample.map((r) => Number(r.id))
  console.log(`样本线索：${ids.join(', ')}（均 NEW 且无有效分配）`)

  console.log('\n═══ A. 分配 3 条 NEW 线索 → 三表同事务落行 ═══')
  const r1 = assignLeads(ids, SALES, ACTOR)
  check('返回 ok=true', r1.ok === true, JSON.stringify(r1))
  check('3 条全部分配成功', (r1.data?.assignments.length ?? 0) === 3, JSON.stringify(r1.data))
  check('无跳过', (r1.data?.skipped.length ?? -1) === 0)
  check('assignmentId 均为正整数', (r1.data?.assignments || []).every((a) => a.assignmentId > 0))
  const inIds = ids.join(',')
  const aRows = crmDbService.all(`SELECT * FROM assignment WHERE lead_id IN (${inIds})`)
  check('assignment 落 3 行', aRows.length === 3, `实 ${aRows.length}`)
  check('assignment status/mode/sales 正确', aRows.every((r) => r.status === 'assigned' && r.mode === 'manual' && r.sales_name === SALES))
  const hRows = crmDbService.all(`SELECT * FROM ownership_history WHERE entity_type = 'lead' AND entity_id IN (${inIds})`)
  check('ownership_history 落 3 行', hRows.length === 3, `实 ${hRows.length}`)
  check('流水字段正确（old=空/new=销售/reason=分配/actor）', hRows.every((r) => r.old_owner === '' && r.new_owner === SALES && r.reason === '分配' && r.actor === ACTOR))
  const eRows = crmDbService.all(`SELECT * FROM audit_event WHERE action = 'lead_assign' AND entity_type = 'lead' AND entity_id IN (${inIds})`)
  check('audit_event 落 3 行（action=lead_assign）', eRows.length === 3, `实 ${eRows.length}`)
  check('审计 actor/明细正确', eRows.every((r) => r.actor === ACTOR && String(r.detail).includes(SALES)))

  console.log('\n═══ B. 幂等拒绝 + 错误码 ═══')
  const r2 = assignLeads([ids[0]], '测试销售乙', ACTOR)
  check('重复分配整体 ok（批量部分成功语义）', r2.ok === true)
  check('重复分配被拒进 skipped（E201）', r2.data?.skipped.length === 1 && r2.data.skipped[0].code === 'E201', JSON.stringify(r2.data))
  check('E201 不产生新 assignment 行', crmDbService.all(`SELECT COUNT(*) AS c FROM assignment WHERE lead_id = ${ids[0]}`)[0].c === 1)
  check('E201 不写流水/审计', crmDbService.all(`SELECT COUNT(*) AS c FROM ownership_history WHERE entity_type='lead' AND entity_id = ${ids[0]}`)[0].c === 1
    && crmDbService.all(`SELECT COUNT(*) AS c FROM audit_event WHERE action='lead_assign' AND entity_id = ${ids[0]}`)[0].c === 1)
  const r3 = assignLeads([999999999], SALES, ACTOR)
  check('不存在线索被拒（E301）', r3.ok === true && r3.data?.skipped[0]?.code === 'E301', JSON.stringify(r3))
  const r4 = assignLeads([], SALES, ACTOR)
  check('空 leadIds 拒（E101）', r4.ok === false && r4.code === 'E101')
  const r5 = assignLeads(ids, '', ACTOR)
  check('空 salesName 拒（E101）', r5.ok === false && r5.code === 'E101')

  console.log('\n═══ C. list 过滤 + 分页 ═══')
  const l1 = listAssignments({ salesName: SALES })
  check('按 salesName 过滤：3 行', l1.ok && l1.data.total === 3 && l1.data.rows.length === 3, `total=${l1.data?.total}`)
  check('过滤行全是该销售', l1.data.rows.every((r) => r.sales_name === SALES))
  const l2 = listAssignments({ salesName: SALES, pageSize: 2, page: 1 })
  const l3 = listAssignments({ salesName: SALES, pageSize: 2, page: 2 })
  check('分页 page1=2 行', l2.data.rows.length === 2 && l2.data.total === 3)
  check('分页 page2=1 行', l3.data.rows.length === 1)
  check('分页行不重叠', l2.data.rows[0] && l3.data.rows[0] && l2.data.rows[0].id !== l3.data.rows[0].id)
  const l4 = listAssignments({ leadId: ids[1] })
  check('按 leadId 过滤：1 行', l4.data.total === 1 && Number(l4.data.rows[0]?.lead_id) === ids[1])
  const l5 = listAssignments({ salesName: SALES, status: 'assigned' })
  check('按 status=assigned 过滤：3 行', l5.data.total === 3)
  check('当前归属查询命中', currentAssignment(ids[0])?.sales_name === SALES)

  console.log('\n═══ D. 通用五列 ═══')
  check('source=manual / updated_by=actor', aRows.every((r) => r.source === 'manual' && r.updated_by === ACTOR))
  check('updated_at 已写 / version=1 / deleted=0', aRows.every((r) => Number(r.updated_at) > 0 && Number(r.version) === 1 && Number(r.deleted) === 0))

  console.log('\n═══ E. lead 状态机零影响 ═══')
  const after = crmDbService.all(`SELECT id, status FROM lead WHERE id IN (${inIds})`)
  check('分配后 lead.status 全部保持 NEW', after.every((r, i) => r.status === sample[i].status), JSON.stringify(after))

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  process.exit(fail ? 1 : 0)
}

void main()
