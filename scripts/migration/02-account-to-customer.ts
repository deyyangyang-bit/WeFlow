/**
 * 02-account-to-customer.ts —— Phase 0 D4 模块②：account → customer 回填 + customer_id 挂接（骨架，只写不跑）
 *
 * ⛔ 铁律：迁移执行必须走应用自身链路（crmDbService 的 create/update），禁止直接改库文件
 *    （sql.js 内存库 + 500ms 防抖落盘会覆盖外部直改，HANDOVER §2.40 前科）。
 *
 * 范围（宪法 §1.1 customer / §1.2 customer_identity / §2.4 Identity Resolution + PRD §9 迁移表）：
 *   - 每个归并组建一个 customer（name 取组内主名），组内 account 写 customer_id 挂接；
 *   - 查重（§2.4 身份优先级）：手机号优先（account.phone 归一化：去非数字字符），
 *     wxid 兜底（account.session_id——私聊会话 id 即客户 wxid，去首尾空白）；
 *   - owner_sales 为空的 account → 归销售本人，留迁移标记（PRD §9；执行时同步写
 *     ownership_history + audit_event，owner_sales 回写同事务——宪法 §1.7/§1.8）；
 *   - 同手机号挂到不同 customer（重复执行/脏数据）→ 只产合并提案 → 人工审批（§2.4 冲突处理）。
 *
 * ⚠️ 依赖顺序：本模块先于 03（lead → customer_identity）执行——03 的归并需要本模块产出的
 *    customer 锚点。salesDb 侧 customer_profile.customer_id 对齐是独立执行步骤（跨库铁律：
 *    先 crmDb 后 salesDb），本 dryRun 仅覆盖 crmDb。
 *
 * dryRun：只读统计——会建多少 customer / 挂接多少 account / 归并组多少 / 冲突多少。
 */

import { crmDbService } from '../../electron/services/crmDbService'
import { normalizePhone, normalizeWxid, accountAnchor } from '../../electron/services/crmMigrationService'
import type { MigrationItemIssue, MigrationReport } from './types'

// 归一化口径唯一真源 = crmMigrationService（执行器同款函数，预演/执行零漂移）；
// 此处 re-export 仅为兼容既有 import 路径（03 模块曾从本文件导入）。
export { normalizePhone, normalizeWxid, accountAnchor }

export function dryRun(dbLabel: string): MigrationReport {
  const ranAt = Date.now()
  const failures: MigrationItemIssue[] = []
  const conflicts: MigrationItemIssue[] = []
  const samples: Array<{ key: string; plan: string }> = []
  const notes: string[] = []

  const accounts = crmDbService.all(
    'SELECT id, name, phone, session_id, owner_sales, customer_id FROM account')

  // ── 1. 锚点解析与归并组 ──
  let phoneAnchored = 0
  let wxidAnchored = 0
  let invalidPhoneFallback = 0 // 手机号格式不合法、已回退 wxid 的
  let alreadyDone = 0          // customer_id 已挂接（幂等）
  const groups = new Map<string, Array<{ id: number; name: string; owner: string }>>()

  for (const a of accounts) {
    const aid = Number(a.id)
    if (a.customer_id != null && Number(a.customer_id) > 0) { alreadyDone++; continue }
    const rawPhone = String(a.phone ?? '').trim()
    const anchor = accountAnchor(a)
    if (rawPhone && normalizePhone(rawPhone).length !== 11) invalidPhoneFallback++
    if (!anchor) {
      failures.push({
        key: `account:${aid}`,
        reason: '无可用身份锚点（手机号非 11 位且无 session_id）——无法参与查重归并',
        detail: `name='${String(a.name)}' phone='${rawPhone}'`
      })
      continue
    }
    if (anchor.type === 'phone') phoneAnchored++; else wxidAnchored++
    const gk = `${anchor.type}:${anchor.value}`
    if (!groups.has(gk)) groups.set(gk, [])
    groups.get(gk)!.push({ id: aid, name: String(a.name || ''), owner: String(a.owner_sales || '') })
  }

  // ── 2. 归并组分析（同锚点 = 同一 customer；组内多名/多归属 → 冲突） ──
  let mergeGroups = 0
  let wouldApply = 0 // 会写入的 account.customer_id 条数（未挂接且锚点有效者）
  let ownerEmpty = 0 // owner_sales 空 → 归销售本人（PRD §9）
  for (const [gk, members] of groups) {
    if (members.length > 1) {
      mergeGroups++
      const names = [...new Set(members.map((m) => m.name).filter(Boolean))]
      const owners = [...new Set(members.map((m) => m.owner).filter(Boolean))]
      if (names.length > 1) {
        conflicts.push({
          key: gk,
          reason: `同 ${gk.split(':')[0]} 归并组内 account 名字不一致（${names.length} 个），主名需人工确认`,
          detail: `names=${JSON.stringify(names)}——宪法 §2.4：同手机号→同 customer；执行器默认取最新 updated_at 的名字，冲突组留人工`
        })
      }
      if (owners.length > 1) {
        conflicts.push({
          key: gk,
          reason: `归并组内 owner_sales 不一致（${owners.length} 人），归并后归属销售需裁决`,
          detail: `owners=${JSON.stringify(owners)}——宪法 §1.7：归属变更走 ownership_history + owner_sales 回写同事务，不静默取一`
        })
      }
      if (samples.length < 10) {
        samples.push({
          key: gk,
          plan: `建 1 个 customer（${names[0] || '(无名)'}）+ ${members.length} 个 account 挂接（ids=${members.map((m) => m.id).join(',')}）`
        })
      }
    }
    wouldApply += members.length
    ownerEmpty += members.filter((m) => !m.owner).length
  }

  // ── 3. 与既有 customer_identity 的唯一约束冲突预演（重复执行/脏数据场景） ──
  const identityRows = crmDbService.all(
    'SELECT identity_type, identity_value, customer_id FROM customer_identity')
  const identityOwners = new Map<string, number>() // 已被占用的锚点 → customer_id
  for (const r of identityRows) {
    identityOwners.set(`${String(r.identity_type)}:${String(r.identity_value)}`, Number(r.customer_id || 0))
  }
  for (const [gk] of groups) {
    const takenBy = identityOwners.get(gk)
    if (takenBy && takenBy > 0) {
      conflicts.push({
        key: gk,
        reason: `身份锚点已被 customer:${takenBy} 占用（唯一约束）——若与本组目标 customer 不同，只能走合并提案`,
        detail: '宪法 §2.4 冲突处理：同 identity 挂不同 customer → 合并提案 → 人工审批执行（改挂 + ownership_history + audit_event 同事务）'
      })
    }
  }

  notes.push(`锚点分布：手机号 ${phoneAnchored} / wxid 兜底 ${wxidAnchored}（其中手机号格式非法回退 ${invalidPhoneFallback}）`)
  notes.push(`将建 customer ${groups.size} 个；多 account 归并组 ${mergeGroups} 个；owner_sales 空（→ 归销售本人，留迁移标记）${ownerEmpty} 个`)
  notes.push('salesDb 侧 customer_profile.customer_id 对齐 = 执行器第二步（先 crmDb 后 salesDb，宪法 §2.1），dryRun 不覆盖')

  return {
    module: '02-account-to-customer',
    title: 'account → customer 回填 + customer_id 挂接（§2.4：手机号优先 / wxid 兜底）',
    ranAt, dbLabel, dryRun: true,
    summary: {
      total: accounts.length,
      wouldApply, alreadyDone,
      skipped: 0,
      failed: failures.length,
      conflicts: conflicts.length
    },
    failures, conflicts, samples, notes
  }
}
