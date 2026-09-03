/**
 * dry-run-all.ts —— Phase 0 D4 迁移骨架 · 统一试跑入口（只读 dryRun，不写执行）
 *
 * ⛔ 铁律：迁移执行必须走应用自身链路（crmDbService / salesDbService），禁止直接改库文件
 *    （sql.js 内存库 + 500ms 防抖落盘会覆盖外部直改，HANDOVER §2.40 前科）。
 *    本入口只跑各模块 dryRun() 只读统计——等价 WEFLOW_USER_DATA_PATH 隔离意图：
 *    源库复制到 /tmp 副本后初始化，统计查询全部只读，绝不触碰 live 库。
 *    ⚠️ initialize 会对副本执行幂等 DDL 迁移（CREATE IF NOT EXISTS / ALTER 吞错 / leadScan 游标清理），
 *    对副本无害；live 库上的同等 DDL 由应用自身启动链路完成。
 *
 * 用法：npx tsx scripts/migration/dry-run-all.ts [源库路径] [--json <输出文件>]
 *   源库缺省 = findExistingBusinessDb 解析当前账号 live CRM 库（只读复制源，不写）
 *   --json   = 四模块报告落盘为 JSON（迁移报告结构：总数/成功/失败/冲突清单）
 */

import { copyFileSync, mkdtempSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { crmDbService } from '../../electron/services/crmDbService'
import { findExistingBusinessDb } from '../../electron/services/businessDbPath'
import type { MigrationReport } from './types'
import { fmtSummary, mergeSummaries } from './types'
import { dryRun as dryRun01 } from './01-decision-b-cleanup'
import { dryRun as dryRun02 } from './02-account-to-customer'
import { dryRun as dryRun03 } from './03-lead-to-identity'
import { dryRun as dryRun04 } from './04-history-deal-opportunity'

/** 打印单模块报告（人读；冲突/失败全量列出，抽样 ≤10） */
function printReport(r: MigrationReport): void {
  console.log(`\n═══ ${r.module} · ${r.title} ═══`)
  console.log(`  ${fmtSummary(r.summary)}`)
  for (const n of r.notes) console.log(`  · ${n}`)
  for (const s of r.samples) console.log(`  ▸ ${s.key} → ${s.plan}`)
  for (const f of r.failures) console.log(`  ✗ ${f.key}：${f.reason}${f.detail ? `（${f.detail}）` : ''}`)
  for (const c of r.conflicts) console.log(`  ⚠ ${c.key}：${c.reason}${c.detail ? `（${c.detail}）` : ''}`)
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const jsonIdx = argv.indexOf('--json')
  const jsonPath = jsonIdx >= 0 ? argv[jsonIdx + 1] : ''
  const posArgs = argv.filter((_, i) => i !== jsonIdx && i !== jsonIdx + 1)
  const src = String(posArgs[0] || '') ||
    findExistingBusinessDb(join(homedir(), 'Library', 'Application Support', 'weflow'), 'crm') || ''
  if (!src) { console.error('未找到源库（weflow-crm-*.db / weflow-crm.db）；可显式传路径'); process.exit(1) }

  // 副本隔离：复制 → legacy 名（initialize 不带 wxid 落此路径）→ 应用链路初始化
  const dir = mkdtempSync(join(tmpdir(), 'd4-dryrun-'))
  const dbFile = join(dir, 'weflow-crm.db')
  copyFileSync(src, dbFile)
  await crmDbService.initialize(dir)
  console.log(`dryRun 试跑（只读）：源 ${src.replace(homedir(), '~')} → 副本 ${dbFile}`)

  // 执行顺序即依赖顺序：② 先于 ③（customer 锚点就位）；①/④ 独立
  const reports = [
    dryRun01(dbFile), dryRun02(dbFile), dryRun03(dbFile), dryRun04(dbFile)
  ]
  for (const r of reports) printReport(r)

  const merged = mergeSummaries(reports.map((r) => r.summary))
  console.log(`\n═══ 总计 ═══`)
  console.log(`  ${fmtSummary(merged)}`)
  console.log('  （骨架 dryRun：wouldApply 为预演计数；执行器 Phase 1 落地，产出实绩迁移报告）')

  if (jsonPath) {
    writeFileSync(jsonPath, JSON.stringify({ ranAt: Date.now(), dbLabel: dbFile, reports }, null, 2))
    console.log(`JSON 报告：${jsonPath}`)
  }
  process.exit(0)
}

void main()
