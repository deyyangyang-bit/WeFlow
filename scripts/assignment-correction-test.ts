/**
 * assignment-correction-test.ts —— §2.54 SLA1 误扫事故纠正块 live 副本验证
 *
 * 事故：backfill 初版口径「分配时刻+24h」→ 存量 3,848 条补写完即全部过期 →
 *       回收器首扫一次性误回收（actor='system:sla'）。
 * 本脚本：live 库 /tmp 副本上实跑 correctSla1Misrecycle()，断言——
 *   A. 命中数核验：recycled & updated_by='system:sla' = 3,848（许丽娟1511/李林辉1356/杨青981）
 *   B. 纠正后：assigned=3,848、三销售归属分布恢复、sla1_deadline 全部在未来 24h 窗口、
 *      lead.first_contact_deadline 同步恢复（非哨兵）
 *   C. append-only：ownership_history/audit_event 只增不改（各 +3,848 补偿流水 + 汇总审计），
 *      误扫回收行保持 recycled 不改写
 *   D. 幂等：重跑标记跳过零副作用；标记丢失重入数据级判重零补偿
 *
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

async function main(): Promise<void> {
  const userData = join(homedir(), 'Library', 'Application Support', 'weflow')
  const crmSrc = findExistingBusinessDb(userData, 'crm')
  if (!crmSrc) { console.error('未找到 live crm 业务库'); process.exit(1) }
  const dir = mkdtempSync(join(tmpdir(), 'correction-test-db-'))
  copyFileSync(crmSrc, join(dir, 'weflow-crm.db'))
  await crmDbService.initialize(dir)
  console.log(`副本试跑：crm ← ${crmSrc.replace(homedir(), '~')}`)

  console.log('\n═══ A. 误扫命中数核验（纠正前现场）═══')
  const total = count(`SELECT COUNT(*) AS c ${MISS_SQL}`)
  check('A1 误扫行 = 3,848', total === 3848, `实 ${total}`)
  const dist = crmDbService.all(`SELECT sales_name, COUNT(*) AS c ${MISS_SQL} GROUP BY sales_name`)
  check('A2 归属分布 许丽娟1511/李林辉1356/杨青981',
    dist.length === 3 && dist.every((r) => EXPECT_DIST[String(r.sales_name)] === Number(r.c)),
    JSON.stringify(dist))
  check('A3 纠正前 assigned=0（全灭现场确认）', count("SELECT COUNT(*) AS c FROM assignment WHERE deleted=0 AND status='assigned'") === 0)
  check('A4 无非误扫 recycled 夹杂', count("SELECT COUNT(*) AS c FROM assignment WHERE deleted=0 AND status='recycled' AND updated_by<>'system:sla'") === 0)
  check('A5 误扫 lead 全部回哨兵', count(`SELECT COUNT(*) AS c FROM lead l WHERE l.first_contact_deadline <> ${LEAD_SLA_UNASSIGNED_SENTINEL} AND EXISTS (SELECT 1 FROM assignment a WHERE a.lead_id = l.id AND a.status='recycled' AND a.updated_by='system:sla')`) === 0)

  console.log('\n═══ B. 实跑纠正块 ═══')
  const histBefore = count('SELECT COUNT(*) AS c FROM ownership_history')
  const auditBefore = count('SELECT COUNT(*) AS c FROM audit_event')
  const before = Date.now()
  const r1 = correctSla1Misrecycle()
  console.log(`  纠正结果：${JSON.stringify(r1)}`)
  check('B1 total=3848 / corrected=3848 / alreadyAssigned=0', r1.total === 3848 && r1.corrected === 3848 && r1.alreadyAssigned === 0, JSON.stringify(r1))
  check('B2 assigned 恢复 = 3,848', count("SELECT COUNT(*) AS c FROM assignment WHERE deleted=0 AND status='assigned'") === 3848)
  const dist2 = crmDbService.all("SELECT sales_name, COUNT(*) AS c FROM assignment WHERE deleted=0 AND status='assigned' GROUP BY sales_name")
  check('B3 三销售归属分布恢复', dist2.length === 3 && dist2.every((r) => EXPECT_DIST[String(r.sales_name)] === Number(r.c)), JSON.stringify(dist2))
  const now = Date.now()
  check('B4 新 sla1 全部在未来 24h 窗口', count("SELECT COUNT(*) AS c FROM assignment WHERE deleted=0 AND status='assigned' AND (sla1_deadline IS NULL OR sla1_deadline < ? OR sla1_deadline > ?)", [now - 1000, now + 86400_000 + 60_000]) === 0
    && count('SELECT COUNT(*) AS c FROM assignment WHERE deleted=0 AND status=\'assigned\' AND sla1_deadline >= ?', [before + 86400_000]) === 3848)
  check('B5 补偿行 source=system:correction / updated_by=system:correction', count("SELECT COUNT(*) AS c FROM assignment WHERE deleted=0 AND status='assigned' AND (source<>'system:correction' OR updated_by<>'system:correction')") === 0)
  check('B6 lead 期限同步恢复（无哨兵残留于被纠正 lead）',
    count(`SELECT COUNT(*) AS c FROM lead l WHERE l.first_contact_deadline = ${LEAD_SLA_UNASSIGNED_SENTINEL} AND EXISTS (SELECT 1 FROM assignment a WHERE a.lead_id = l.id AND a.status='assigned' AND a.source='system:correction')`) === 0)
  check('B7 lead 期限 = 当前分配行 sla1', count("SELECT COUNT(*) AS c FROM lead l JOIN assignment a ON a.lead_id = l.id AND a.status='assigned' AND a.source='system:correction' WHERE l.first_contact_deadline <> a.sla1_deadline") === 0)

  console.log('\n═══ C. append-only 对账 ═══')
  check('C1 误扫回收行保持 recycled（历史不改写）', count(`SELECT COUNT(*) AS c ${MISS_SQL}`) === 3848)
  check('C2 ownership_history +3,848（补偿流水，只增）', count('SELECT COUNT(*) AS c FROM ownership_history') === histBefore + 3848, `实 ${count('SELECT COUNT(*) AS c FROM ownership_history')} 前 ${histBefore}`)
  check('C3 补偿流水 reason=分配 actor=system:correction', count("SELECT COUNT(*) AS c FROM ownership_history WHERE reason='分配' AND actor='system:correction'") === 3848)
  check('C4 audit_event +3,849（3,848 补偿 + 1 汇总）', count('SELECT COUNT(*) AS c FROM audit_event') === auditBefore + 3849, `实 ${count('SELECT COUNT(*) AS c FROM audit_event')} 前 ${auditBefore}`)
  check('C5 补偿审计 detail 含纠正说明', count("SELECT COUNT(*) AS c FROM audit_event WHERE action='lead_assign' AND actor='system:correction' AND detail LIKE '%SLA1误扫回收纠正%'") === 3848)
  check('C6 汇总审计 sla1_misrecycle_correction 落行', count("SELECT COUNT(*) AS c FROM audit_event WHERE action='sla1_misrecycle_correction' AND actor='system:correction'") === 1)
  check('C7 误扫审计/流水原样保留', count("SELECT COUNT(*) AS c FROM audit_event WHERE action='lead_recycle' AND actor='system:sla'") === 3848
    && count("SELECT COUNT(*) AS c FROM ownership_history WHERE reason='SLA超时回收' AND actor='system:sla'") === 3848)

  console.log('\n═══ D. 幂等 ═══')
  const r2 = correctSla1Misrecycle()
  check('D1 重跑标记跳过（skippedByMarker）', r2.skippedByMarker === true)
  check('D2 重跑零副作用（assigned/流水/审计计数不变）',
    count("SELECT COUNT(*) AS c FROM assignment WHERE deleted=0 AND status='assigned'") === 3848
    && count('SELECT COUNT(*) AS c FROM ownership_history') === histBefore + 3848
    && count('SELECT COUNT(*) AS c FROM audit_event') === auditBefore + 3849)
  crmDbService.run('DELETE FROM scan_state WHERE key = ?', [MARKER])
  const r3 = correctSla1Misrecycle()
  check('D3 标记丢失重入：数据级判重零补偿', r3.corrected === 0 && r3.alreadyAssigned === 3848, JSON.stringify(r3))
  check('D4 标记已重建', crmDbService.getScanState(MARKER) > 0)
  check('D5 重入后 assigned 仍 3,848（无重复新行）', count("SELECT COUNT(*) AS c FROM assignment WHERE deleted=0 AND status='assigned'") === 3848)

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  process.exit(fail ? 1 : 0)
}

void main()
