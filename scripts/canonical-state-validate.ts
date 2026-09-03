/**
 * canonical-state-validate.ts —— P0-2A.2 并行验证（只读诊断脚本）
 *
 * 新 getCanonicalState 与旧读取路径逐客户对照，确认 read model 是「忠实解释」而非语义改动：
 *   ① 现有 8 值 → 6 stage + activityState 映射正确
 *   ② 中文/英文全部归一
 *   ③ unknown 不误入漏斗
 *   ④ dormant 不再污染 stage
 *   ⑤ stateMeta 能找到对应 intent 记录
 *   ⑥ 历史客户不会出现大面积阶段变化（关键验收：0 或可解释的少量变化）
 *
 * 只读纪律：将真实 weflow-sales.db 复制到临时目录后打开，绝不触碰原库。
 * 用法：npx tsx scripts/canonical-state-validate.ts [userDataPath]
 *   默认 ~/Library/Application Support/weflow（打包版活跃 DB；dev 用 Electron 目录）
 */
import { copyFileSync, mkdtempSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { homedir } from 'os'
import { salesDbService } from '../electron/services/salesDbService'
import { findExistingBusinessDb } from '../electron/services/businessDbPath'
import { normalizeStage, stageLabel, stageToFunnel, funnelBucket } from '../shared/salesStage'

const DEFAULT_DIR = join(homedir(), 'Library', 'Application Support', 'weflow')

async function main(): Promise<void> {
  const userDataPath = process.argv[2] || DEFAULT_DIR
  const src = findExistingBusinessDb(userDataPath, 'sales') ?? join(userDataPath, 'weflow-sales.db')
  if (!existsSync(src)) {
    console.error(`DB 不存在：${src}（可用参数指定 userDataPath）`)
    process.exit(1)
  }
  const tmp = mkdtempSync(join(tmpdir(), 'cs-validate-'))
  copyFileSync(src, join(tmp, 'weflow-sales.db'))
  console.log(`只读复制：${src} → ${tmp}/weflow-sales.db\n`)
  await salesDbService.initialize(tmp)

  const all = salesDbService.customerList()
  const nowSec = Math.floor(Date.now() / 1000)

  let stageChanged = 0, funnelChanged = 0, dormant = 0, unknown = 0, metaFound = 0
  const changedRows: Array<{ name: string; raw: string | undefined; oldLabel: string; newLabel: string; activity: string }> = []

  for (const c of all) {
    const st = salesDbService.getCanonicalState(c.session_id, nowSec)
    if (!st) continue
    const oldLabel = stageLabel(normalizeStage(c.stage))
    const newLabel = stageLabel(st.stage)
    const oldFunnel = stageToFunnel(c.stage)
    const newFunnel = funnelBucket(st.stage)
    if (oldLabel !== newLabel) { stageChanged++; changedRows.push({ name: c.display_name ?? c.session_id, raw: c.stage, oldLabel, newLabel, activity: st.activityState }) }
    if (oldFunnel !== newFunnel) funnelChanged++
    if (st.activityState === 'dormant') dormant++
    if (st.stage === 'unknown') unknown++
    if (st.stateMeta.source) metaFound++
  }

  console.log(`客户总数：${all.length}`)
  console.log(`阶段展示变化：${stageChanged}（旧读取 → 新 read model）`)
  console.log(`漏斗档位变化：${funnelChanged}`)
  console.log(`activityState=dormant：${dormant}（stage 不再被 dormant 污染）`)
  console.log(`stage=unknown（异常位）：${unknown}`)
  console.log(`stateMeta 找到对应 intent 记录：${metaFound}`)

  if (changedRows.length > 0) {
    console.log('\n变化明细：')
    for (const r of changedRows.slice(0, 30)) {
      console.log(`  ${r.name}: ${r.raw ?? '(null)'} → ${r.oldLabel} → ${r.newLabel} [${r.activity}]`)
    }
    if (changedRows.length > 30) console.log(`  … 共 ${changedRows.length} 条，仅列前 30`)
  }

  // 验收：历史客户无大面积阶段变化（漏斗档位变化应为 0 或可解释）
  const ok = funnelChanged === 0
  console.log(`\n${ok ? 'PASS' : 'FAIL'}：历史客户漏斗档位变化 ${funnelChanged}/0（大面积变化 = read model 逻辑问题）`)
  process.exit(ok ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
