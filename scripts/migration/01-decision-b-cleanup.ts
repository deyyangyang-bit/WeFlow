/**
 * 01-decision-b-cleanup.ts —— Phase 0 D4 模块①：决策 B 存量处置（骨架，只写不跑）
 *
 * ⛔ 铁律：迁移执行必须走应用自身链路（crmDbService 的 update 等），禁止直接改库文件
 *    （sql.js 内存库 + 500ms 防抖落盘会覆盖外部直改，HANDOVER §2.40 前科）。
 *
 * 范围（宪法 §4.2 决策 B + PRD §9 迁移表）：
 *   1. 群扫线索 tag 归属清理：历史归属写入 note「曾归属:X（YYYY-MM-DD）」备查（沿用群扫时代
 *      既有格式，HANDOVER §2.39），随后 tag 置空——tag 自此仅保留 Excel 导入「需求标签」语义。
 *   2. scan_state `leadScan:*` 游标清理核验（D3 起 initialize 幂等清理，本模块只核验计数）。
 *   3. 存量不迁 assignment：统一回资源池，由分配员按 PRD 1.3 重新分配（先 200 条小批量验证）。
 *
 * dryRun：只读统计——会清多少 tag / 留痕多少 note / 幂等跳过多少 / 游标是否已清。
 */

import { crmDbService } from '../../electron/services/crmDbService'
import type { MigrationItemIssue, MigrationReport } from './types'

/** 群扫线索的 source 值（HANDOVER §2.39：群扫复用 importLeads('群资源扫描', …) 写路径） */
const SCAN_SOURCE = '群资源扫描'
/** 群扫时代的「无归属」哨兵值（§2.39：非白名单 @ 录线索 tag=未分配）——清 tag 但无需留痕 */
const UNASSIGNED_TAG = '未分配'
/** 执行器写 note 的留痕格式（宪法 §4.2 指定沿用群扫时代既有格式） */
export const NOTE_FORMAT = '曾归属:{owner}（{date}）'

export function dryRun(dbLabel: string): MigrationReport {
  const ranAt = Date.now()
  const failures: MigrationItemIssue[] = []
  const conflicts: MigrationItemIssue[] = []
  const samples: Array<{ key: string; plan: string }> = []
  const notes: string[] = []

  // ── 1. 源分布盘点（防 source 值口径漂移：真实分布进报告，操作者可核对） ──
  const sources = crmDbService.all('SELECT source, COUNT(*) AS c FROM lead GROUP BY source ORDER BY c DESC')
  notes.push(`lead.source 分布：${sources.map((r) => `${String(r.source) || '(空)'}=${Number(r.c)}`).join(' / ')}`)
  const scanLeads = crmDbService.all(
    'SELECT id, tag, note, status FROM lead WHERE source = ?', [SCAN_SOURCE])
  if (scanLeads.length === 0) {
    notes.push(`⚠️ source='${SCAN_SOURCE}' 零命中——若上表存在疑似群扫来源值，先人工确认口径再改 SCAN_SOURCE 常量`)
  }

  // ── 2. tag 归属清理预演 ──
  let wouldApply = 0        // tag 会被置空的条数（有 tag 的群扫线索）
  let alreadyDone = 0       // note 已含「曾归属:tag 值」→ 执行时只清 tag 不重复留痕
  let skipped = 0           // tag 本就空（含未分配哨兵）→ 无需处理
  const tagDist = new Map<string, number>()
  for (const l of scanLeads) {
    const tag = String(l.tag || '').trim()
    const note = String(l.note || '')
    if (!tag || tag === UNASSIGNED_TAG) { skipped++; continue }
    wouldApply++
    tagDist.set(tag, (tagDist.get(tag) || 0) + 1)
    if (note.includes(`曾归属:${tag}`)) {
      alreadyDone++ // 幂等：群扫时代「同号换归属」已写过同值留痕，执行时跳过 note 追加
    }
    if (samples.length < 10) {
      samples.push({
        key: `lead:${Number(l.id)}`,
        plan: alreadyDone > 0 && note.includes(`曾归属:${tag}`)
          ? `tag='${tag}' 置空（note 已含该归属留痕，仅清 tag）`
          : `note 追加「${NOTE_FORMAT.replace('{owner}', tag).replace('{date}', 'YYYY-MM-DD')}」+ tag 置空`
      })
    }
  }
  notes.push(`群扫线索 tag 归属分布：${[...tagDist.entries()].map(([t, c]) => `${t}=${c}`).join(' / ') || '（全部无归属）'}`)

  // 状态分布（回资源池预览：ACCOUNT=已转客户、DEAD=已失效，均不进重分配池）
  const statusDist = crmDbService.all(
    'SELECT status, COUNT(*) AS c FROM lead WHERE source = ? GROUP BY status ORDER BY c DESC', [SCAN_SOURCE])
  notes.push(`群扫线索状态分布：${statusDist.map((r) => `${String(r.status)}=${Number(r.c)}`).join(' / ')}`)
  const poolSize = statusDist
    .filter((r) => !['ACCOUNT', 'DEAD'].includes(String(r.status)))
    .reduce((n, r) => n + Number(r.c), 0)
  notes.push(`回资源池候选（status ∉ {ACCOUNT, DEAD}）：${poolSize} 条；PRD 1.3 要求先 200 条小批量验证再放量`)

  // ── 3. 非群扫线索的归属语义污染检查（冲突：Excel 线索 tag 若像销售名，需人工分辨） ──
  const nonScanWithOwnerLikeTag = crmDbService.all(
    "SELECT id, source, tag FROM lead WHERE source != ? AND tag IS NOT NULL AND tag != '' AND tag != ?",
    [SCAN_SOURCE, UNASSIGNED_TAG])
  const ownerNames = new Set(tagDist.keys())
  for (const r of nonScanWithOwnerLikeTag) {
    const tag = String(r.tag || '').trim()
    if (ownerNames.has(tag)) {
      conflicts.push({
        key: `lead:${Number(r.id)}`,
        reason: `非群扫线索（source='${String(r.source)}'）tag='${tag}' 与群扫销售归属同名——需人工分辨是需求标签还是历史归属污染`,
        detail: '宪法 §4.2：tag 仅保留需求标签语义；若为污染执行器应一并清理，若为需求标签则保留'
      })
    }
  }
  if (nonScanWithOwnerLikeTag.length > 0 && conflicts.length === 0) {
    notes.push(`非群扫线索带 tag 共 ${nonScanWithOwnerLikeTag.length} 条，无与销售归属同名者（按需求标签语义保留，不动）`)
  }

  // ── 4. scan_state leadScan:* 游标核验（D3 起 initialize 幂等清理，此处应为 0） ──
  const cursorRows = crmDbService.all("SELECT COUNT(*) AS c FROM scan_state WHERE key LIKE 'leadScan:%'")
  const cursorCount = Number(cursorRows[0]?.c || 0)
  if (cursorCount > 0) {
    failures.push({
      key: 'scan_state:leadScan:*',
      reason: `残留 ${cursorCount} 条群扫游标——执行器需 DELETE（幂等），D3 起 initialize 理论上已清`,
      detail: '宪法 §4.2 下线清单；信号扫描 priv:* 游标不在清理范围'
    })
  }
  const privCount = Number(crmDbService.all("SELECT COUNT(*) AS c FROM scan_state WHERE key LIKE 'priv:%'")[0]?.c || 0)
  notes.push(`游标核验：leadScan:*=${cursorCount}（期望 0）；priv:*=${privCount}（信号扫描游标，只读不动）`)

  return {
    module: '01-decision-b-cleanup',
    title: '决策 B 存量处置：群扫线索 tag 归属清理 + 游标核验',
    ranAt, dbLabel, dryRun: true,
    summary: {
      total: scanLeads.length,
      wouldApply, alreadyDone, skipped,
      failed: failures.length,
      conflicts: conflicts.length
    },
    failures, conflicts, samples, notes
  }
}
