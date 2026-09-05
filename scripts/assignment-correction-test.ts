/**
 * assignment-correction-test.ts —— §2.54 SLA1 误扫事故纠正块 live 副本验证
 *
 * 事故：backfill 初版口径「分配时刻+24h」→ 存量 3,848 条补写完即全部过期 →
 *       回收器首扫一次性误回收（actor='system:sla'）。
 *
 * ⚠️ 口径变更（2026-09-04，两次）：① live 库已被真实执行过纠正，「纠正前现场」口径永久失效；
 *    ② live 实际恢复路径核查：3,848 条 assigned 行为 source='manual'/updated_by='system:migration'
 *    （先于纠正块启动的迁移恢复），correctSla1Misrecycle 首跑即 alreadyAssigned=3848 跳过、
 *    只落 1 条汇总审计——system:correction 补偿流水在 live 不存在（属正常，非缺失）。
 *    补偿路径本身由 assignment-full-test G 组（fresh 库构造误扫现场端到端）覆盖。
 * 本脚本为「已纠正副本」验证（2026-09-06 起改「基线快照 + 幂等」口径，§2.69 遗留修复）：
 *   A. 终态核验：assigned ≥ 基线、三销售归属分布、期限列非空（三次提醒制后过期行在提醒期内保持
 *      assigned 属合法态，见 §2.71）、误扫回收行原样保留（append-only 只增不减）
 *   B. 重跑幂等：skippedByMarker=true、全库计数零漂移
 *   C. 留痕对账：误扫审计/流水 ≥ 基线（append-only）+ 汇总审计落行
 *   D. 标记丢失重入：数据级判重零补偿（alreadyAssigned=当前 assigned 总数）、标记重建、无重复新行
 *
 * ⛔ 基线快照常量（2026-09-05 live 首验值；不再绑死精确数——数据自然增长后精确断言必然红）：
 *   漂移原因：① 回收器每日继续回收过期行（system:sla 回收行/流水只增不减，append-only）；
 *            ② §2.71 三次提醒制后「超时未停表的 assigned 行」在提醒期内保持 assigned（A4 口径随之变化）；
 *            ③ 回收后的再分配使 assigned 总数随分配员操作起伏，但误扫历史行永不被改写。
 * ⛔ 铁律：live 源库复制到 /tmp 副本 → 应用链路 initialize → 绝不触碰 live 库。
 * 用法：npx tsx scripts/assignment-correction-test.ts
 */
import { copyFileSync, mkdtempSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'

const isoDir = mkdtempSync(join(tmpdir(), 'correction-test-'))
process.env.WEFLOW_WORKER = '1'
process.env.WEFLOW_USER_DATA_PATH = isoDir
process.env.WEFLOW_CONFIG_CWD = isoDir

import { crmDbService } from '../electron/services/crmDbService'
import { findExistingBusinessDb } from '../electron/services/businessDbPath'
import { correctSla1Misrecycle } from '../electron/services/crmAssignmentService'
import { LEAD_SLA_UNASSIGNED_SENTINEL } from '../shared/leadSla'

let pass = 0, fail = 0
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; console.log(`  ✅ ${name}`) } else { fail++; console.log(`  ❌ ${name} ${detail}`) }
}
function count(sql: string, params: unknown[] = []): number {
  return Number(crmDbService.all(sql, params)[0]?.c ?? 0)
}

const MISS_SQL = "FROM assignment WHERE deleted = 0 AND status = 'recycled' AND updated_by = 'system:sla'"
const MARKER = 'migration:sla1-misrecycle-correction'
const EXPECT_DIST: Record<string, number> = { '许丽娟': 1511, '李林辉': 1356, '杨青': 981 }
const ASSIGNED_SQL = "SELECT COUNT(*) AS c FROM assignment WHERE deleted=0 AND status='assigned'"
// 基线快照（2026-09-05 live 首验值）：断言口径 = ≥ 基线 且 重跑幂等不翻倍（漂移原因见头注释）
const BASELINE_ASSIGNED = 3848
const BASELINE_MISS_RECYCLED = 3848

async function main(): Promise<void> {
  const userData = join(homedir(), 'Library', 'Application Support', 'weflow')
  const crmSrc = findExistingBusinessDb(userData, 'crm')
  if (!crmSrc) { console.error('未找到 live crm 业务库'); process.exit(1) }
  const dir = mkdtempSync(join(tmpdir(), 'correction-test-db-'))
  copyFileSync(crmSrc, join(dir, 'weflow-crm.db'))
  await crmDbService.initialize(dir)
  console.log(`副本试跑：crm ← ${crmSrc.replace(homedir(), '~')}`)

  console.log('\n═══ A. 已纠正终态核验 ═══')
  check('A1 assigned ≥ 基线 3,848（数据自然增长合法）', count(ASSIGNED_SQL) >= BASELINE_ASSIGNED, `实 ${count(ASSIGNED_SQL)}`)
  const dist = crmDbService.all("SELECT sales_name, COUNT(*) AS c FROM assignment WHERE deleted=0 AND status='assigned' GROUP BY sales_name")
  check('A2 归属分布 许丽娟1511/李林辉1356/杨青981',
    dist.length === 3 && dist.every((r) => EXPECT_DIST[String(r.sales_name)] === Number(r.c)),
    JSON.stringify(dist))
  check('A3 assigned 行均为迁移恢复（source=manual / updated_by=system:migration）', count("SELECT COUNT(*) AS c FROM assignment WHERE deleted=0 AND status='assigned' AND (source<>'manual' OR updated_by<>'system:migration')") === 0)
  const now = Date.now()
  // §2.71 三次提醒制后「超时未停表的 assigned 行」在提醒期内保持 assigned 属合法态 → 只验期限列非空
  check('A4 sla1 期限列全部非空（过期行在提醒期内保持 assigned 合法）', count('SELECT COUNT(*) AS c FROM assignment WHERE deleted=0 AND status=\'assigned\' AND sla1_deadline IS NULL') === 0)
  check('A5 误扫回收行 ≥ 基线 3,848（append-only 只增不减）', count(`SELECT COUNT(*) AS c ${MISS_SQL}`) >= BASELINE_MISS_RECYCLED, `实 ${count(`SELECT COUNT(*) AS c ${MISS_SQL}`)}`)
  check('A6 被恢复 lead 无哨兵残留',
    count(`SELECT COUNT(*) AS c FROM lead l WHERE l.first_contact_deadline = ${LEAD_SLA_UNASSIGNED_SENTINEL} AND EXISTS (SELECT 1 FROM assignment a WHERE a.lead_id = l.id AND a.status='assigned')`) === 0)
  check('A7 lead 期限 = 当前分配行 sla1', count("SELECT COUNT(*) AS c FROM lead l JOIN assignment a ON a.lead_id = l.id AND a.status='assigned' WHERE l.first_contact_deadline <> a.sla1_deadline") === 0)
  check('A8 纠正标记已置位', crmDbService.getScanState(MARKER) > 0)

  console.log('\n═══ B. 重跑幂等（标记在）═══')
  const assignedBefore = count(ASSIGNED_SQL)
  const histBefore = count('SELECT COUNT(*) AS c FROM ownership_history')
  const auditBefore = count('SELECT COUNT(*) AS c FROM audit_event')
  const r1 = correctSla1Misrecycle()
  console.log(`  重跑结果：${JSON.stringify(r1)}`)
  check('B1 重跑标记跳过（skippedByMarker）', r1.skippedByMarker === true)
  check('B2 重跑零副作用（assigned/流水/审计计数不变）',
    count(ASSIGNED_SQL) === assignedBefore
    && count('SELECT COUNT(*) AS c FROM ownership_history') === histBefore
    && count('SELECT COUNT(*) AS c FROM audit_event') === auditBefore)

  console.log('\n═══ C. 留痕对账（append-only）═══')
  check('C1 误扫审计 lead_recycle/system:sla ≥ 基线（append-only）', count("SELECT COUNT(*) AS c FROM audit_event WHERE action='lead_recycle' AND actor='system:sla'") >= BASELINE_MISS_RECYCLED)
  check('C2 误扫流水 SLA超时回收/system:sla ≥ 基线（append-only）', count("SELECT COUNT(*) AS c FROM ownership_history WHERE reason='SLA超时回收' AND actor='system:sla'") >= BASELINE_MISS_RECYCLED)
  check('C3 汇总审计 sla1_misrecycle_correction ≥1 且首跑即 alreadyAssigned 跳过',
    count("SELECT COUNT(*) AS c FROM audit_event WHERE action='sla1_misrecycle_correction' AND actor='system:correction' AND detail LIKE '%\"corrected\":0%' AND detail LIKE '%\"alreadyAssigned\":3848%'") >= 1)

  console.log('\n═══ D. 标记丢失重入 ═══')
  crmDbService.run('DELETE FROM scan_state WHERE key = ?', [MARKER])
  const assignedAtDStart = count(ASSIGNED_SQL)
  const r2 = correctSla1Misrecycle()
  // alreadyAssigned 口径 = 误回收行中 lead 已有有效分配的条数（数据级判重）；corrected=0 且全覆盖 → 零补偿
  check('D1 数据级判重零补偿（alreadyAssigned = 误回收行总数 ≥ 基线）', r2.corrected === 0 && r2.alreadyAssigned === r2.total && Number(r2.total) >= BASELINE_MISS_RECYCLED, JSON.stringify(r2))
  check('D2 标记已重建', crmDbService.getScanState(MARKER) > 0)
  check('D3 重入后 assigned 零新增（无重复新行）', count(ASSIGNED_SQL) === assignedAtDStart && assignedAtDStart >= BASELINE_ASSIGNED)
  check('D4 重入后流水零漂移 / 审计仅 +1 汇总行',
    count('SELECT COUNT(*) AS c FROM ownership_history') === histBefore
    && count('SELECT COUNT(*) AS c FROM audit_event') === auditBefore + 1)

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  process.exit(fail ? 1 : 0)
}

void main()
