/**
 * 03-lead-to-identity.ts —— Phase 0 D4 模块③：lead → customer_identity 归并（骨架，只写不跑）
 *
 * ⛔ 铁律：迁移执行必须走应用自身链路（crmDbService 的 create/update），禁止直接改库文件
 *    （sql.js 内存库 + 500ms 防抖落盘会覆盖外部直改，HANDOVER §2.40 前科）。
 *
 * 范围（宪法 §1.2 customer_identity / §2.4 Identity Resolution + PRD §9 迁移表：
 *      「现有线索（含群扫描）→ lead → customer_identity，手机号/wxid 查重归并」）：
 *   - contact_type='phone' → identity(phone, contact_normalized 归一化)；
 *     contact_type='wechat' → identity(wxid, wechat 列 trim——宪法 §2.4 wxid 仅去首尾空白)；
 *   - 同 (identity_type, identity_value) 多条线索 → 归并为一条 identity 行（唯一约束）；
 *   - 值命中 account 侧锚点（模块②）→ identity.customer_id 指向该 account 的 customer；
 *     未命中 → customer_id = NULL（资源池线索合法态，§2.4 后补关联：绑定/认领/转客户时补挂）；
 *   - 同值已挂不同 customer → 合并提案 → 人工审批（§2.4 冲突处理，AI 永不执行合并）。
 *
 * ⚠️ 依赖顺序：模块②先跑（customer 锚点就位）；本模块 dryRun 在「customer_id 尚未回填」的
 *    库上运行时，account 侧只统计「将来会命中」的锚点数，不模拟挂接值。
 *
 * dryRun：只读统计——会插多少 identity / 归并多少组 / 多少挂 NULL（资源池）/ 冲突多少。
 */

import { crmDbService } from '../../electron/services/crmDbService'
import { normalizePhone, normalizeWxid, accountAnchor } from '../../electron/services/crmMigrationService'
import type { MigrationItemIssue, MigrationReport } from './types'

export function dryRun(dbLabel: string): MigrationReport {
  const ranAt = Date.now()
  const failures: MigrationItemIssue[] = []
  const conflicts: MigrationItemIssue[] = []
  const samples: Array<{ key: string; plan: string }> = []
  const notes: string[] = []

  const leads = crmDbService.all(
    'SELECT id, contact_type, contact_normalized, wechat, source, status, account_id FROM lead')
  const accounts = crmDbService.all('SELECT id, phone, session_id FROM account')

  // account 侧锚点索引（模块②的目标 customer 尚未回填 customer_id，这里只判「将来可命中」）
  const anchorToAccount = new Map<string, number>()
  for (const a of accounts) {
    const anchor = accountAnchor(a)
    if (anchor) anchorToAccount.set(`${anchor.type}:${anchor.value}`, Number(a.id))
  }

  // ── 1. 逐 lead 解析身份（宪法 §2.4 归一化），按 (type, value) 归并 ──
  let alreadyDone = 0        // identity 已存在（重复执行幂等跳过）
  let skipped = 0            // 无任何可用身份（不产生 identity 行）
  let linkedToAccount = 0    // 身份值命中 account 锚点 → 将来挂该 customer
  let dangling = 0           // 未命中 → customer_id=NULL（资源池合法态）
  const groups = new Map<string, Array<{ id: number; source: string; account: number | null }>>()

  for (const l of leads) {
    const lid = Number(l.id)
    const type = String(l.contact_type || 'phone') === 'wechat' ? 'wxid' : 'phone'
    const raw = type === 'phone' ? String(l.contact_normalized ?? '') : String(l.wechat ?? '')
    const value = type === 'phone' ? normalizePhone(raw) : normalizeWxid(raw)

    if (!value) {
      skipped++
      failures.push({
        key: `lead:${lid}`,
        reason: `无可用身份（contact_type='${type}' 但值为空）——不产生 identity 行，进迁移报告失败清单人工处理`,
        detail: `source='${String(l.source)}' status='${String(l.status)}'`
      })
      continue
    }
    if (type === 'phone' && value.length !== 11) {
      failures.push({
        key: `lead:${lid}`,
        reason: `手机号归一化后非 11 位（'${value}'），不满足 phone 身份格式`,
        detail: '宪法 §2.4 归一化仅去非数字；格式非法者不迁，留人工处理窗口'
      })
      continue
    }

    const gk = `${type}:${value}`
    if (!groups.has(gk)) groups.set(gk, [])
    groups.get(gk)!.push({ id: lid, source: String(l.source || ''), account: l.account_id != null ? Number(l.account_id) : null })
  }

  // ── 2. 归并组分析 + account 锚点命中 ──
  let dupGroups = 0
  let maxGroup = 0
  const accountHits = new Map<string, Set<number>>() // 锚点 → 命中的 account id 集合（跨 account 冲突检测用）
  for (const [gk, members] of groups) {
    if (members.length > 1) { dupGroups++; maxGroup = Math.max(maxGroup, members.length) }
    const accId = anchorToAccount.get(gk)
    if (accId != null) {
      linkedToAccount += members.length
      if (!accountHits.has(gk)) accountHits.set(gk, new Set())
      accountHits.get(gk)!.add(accId)
      for (const m of members) {
        if (m.account != null && m.account !== accId) {
          // 线索已转客户（lead.account_id）但身份值命中另一 account → 身份与挂接矛盾
          conflicts.push({
            key: `lead:${m.id}`,
            reason: `已转客户（account:${m.account}）但身份 ${gk} 命中另一 account:${accId}——跨客户身份冲突`,
            detail: '宪法 §2.4：只能走合并提案 → 人工审批（改挂 identity + ownership_history + audit_event 同事务）'
          })
        }
      }
      if (samples.length < 10) {
        samples.push({ key: gk, plan: `identity(${gk}) customer_id ← account:${accId} 的 customer（模块②产物）+ ${members.length} 条线索归并` })
      }
    } else {
      dangling += members.length
      if (samples.length < 10) {
        samples.push({ key: gk, plan: `identity(${gk}) customer_id=NULL（资源池，绑定/认领时后补关联）+ ${members.length} 条线索归并` })
      }
    }
  }

  // ── 3. 既有 customer_identity 幂等/冲突预演 ──
  const identityRows = crmDbService.all(
    'SELECT identity_type, identity_value, customer_id FROM customer_identity')
  const existing = new Map<string, number>()
  for (const r of identityRows) {
    existing.set(`${String(r.identity_type)}:${String(r.identity_value)}`, Number(r.customer_id || 0))
  }
  for (const [gk] of groups) {
    if (existing.has(gk)) {
      alreadyDone++ // 值已登记：执行器跳过插入，只做 lead 维度引用（如需）
    }
  }
  notes.push(`既有 customer_identity ${identityRows.length} 行；本批命中已存在锚点 ${alreadyDone} 个（幂等跳过插入）`)

  notes.push(`将插 identity ${groups.size - alreadyDone} 行；跨线索归并组 ${dupGroups} 个${dupGroups ? `（最大组 ${maxGroup} 条线索）` : '（全部唯一，无归并）'}`)
  notes.push(`挂接预演：命中 account 锚点 ${linkedToAccount} 条线索 / 资源池 NULL ${dangling} 条线索（§2.4 后补关联为合法态，非失败）`)
  notes.push('⚠️ lead 侧 contact_normalized 对 wechat 曾用小写归一（去重键惯例）；identity 入库按宪法 §2.4 只 trim 不转小写，执行时以 wechat 原值归一')

  return {
    module: '03-lead-to-identity',
    title: 'lead → customer_identity 归并（手机号/wxid 查重，唯一约束 (identity_type, identity_value)）',
    ranAt, dbLabel, dryRun: true,
    summary: {
      total: leads.length,
      wouldApply: groups.size - Math.max(0, alreadyDone),
      alreadyDone, skipped,
      failed: failures.length,
      conflicts: conflicts.length
    },
    failures, conflicts, samples, notes
  }
}
