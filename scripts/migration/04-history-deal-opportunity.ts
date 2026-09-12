/**
 * 04-history-deal-opportunity.ts —— Phase 0 D4 模块④：历史成交 → opportunity 补列（won 态）+ quotation 首版本
 *
 * 执行器已上收至 crmMigrationService.migrate04HistoryDealToOpportunity（启动链路直接跑）；
 * 本文件保留 dryRun() 只读预演，apply()/Apply04Result 为 re-export 兼容既有 import 路径。
 *
 * ⛔ 铁律：迁移执行必须走应用自身链路（crmDbService 的 create/update），禁止直接改库文件
 *    （sql.js 内存库 + 500ms 防抖落盘会覆盖外部直改，HANDOVER §2.40 前科）。
 *
 * 范围（PRD §9 迁移表「历史成交记录 → opportunity（won）+ 成交登记 | 补 quote 首版本」+ 宪法 §1.5/§1.6）：
 *   - 历史成交 = contract.status ∈ {signed, shipped}（crmDbService 状态机：pending_sign → signed → shipped）；
 *   - 每张成交合同确保存在 won 态 opportunity：缺则建（source='migration'、account_id 沿用、
 *     amount_cny ← contract.amount、币种默认 CNY、rate_note 空；其余字段映射按 PRD 5.1 字段级规格，
 *     合同 custom_fields 里没有的量（main_model/order_qty/发运窗口）留空待人工补录，不伪造）；
 *   - opportunity 补列预检（§1.5）：成交账户的商机缺 amount_cny/type 等新列值 → 执行时回填；
 *   - quotation 首版本：既有报价行 version=1（D3 ALTER DEFAULT 1 已生效，此处核验）+
 *     effective_from=0 的行回填 ← created_at（首版本生效起点）；effective_to 保持 0（未被替代）；
 *   - contract.quote_version_id ← 该合同最新报价版本 id（宪法 §1.6 权威方向；
 *     既有反向链 quotation.contract_id 过渡期双写保留，Phase 2 读路径切换后退役）。
 *
 * dryRun：只读统计——会补建多少 won 商机 / 回填多少列值 / quote 版本核验与回填量。
 *
 * 执行器（2026-09-09 本刀落地，宪法 §1.6 修订）：apply() 走应用自身链路（铁律 1）——
 *   - won 商机补建 / amount_cny 回填走 crmDbService.create/update/opportunityEventAdd/auditAppend；
 *   - quote 版本链规范化复用 crmDbService.normalizeQuotationVersionChain 单点
 *     （与应用内 createQuotation → createQuotationVersionTx 同一套不变量：version 递增 /
 *      effective 窗口 / 合同指针接管 / 同事务 audit_event），不复制 SQL；
 *   - 幂等：已归一化合同（quotationChainNormalized）跳过，不重复写审计；重复执行零第二份数据。
 *   （该执行逻辑现位于 crmMigrationService.migrate04HistoryDealToOpportunity，此处仅 re-export。）
 */

import { crmDbService } from '../../electron/services/crmDbService'
import type { MigrationItemIssue, MigrationReport } from './types'

export function dryRun(dbLabel: string): MigrationReport {
  const ranAt = Date.now()
  const failures: MigrationItemIssue[] = []
  const conflicts: MigrationItemIssue[] = []
  const samples: Array<{ key: string; plan: string }> = []
  const notes: string[] = []

  const contracts = crmDbService.all(
    "SELECT id, account_id, name, amount, status, sign_date, quote_version_id FROM contract WHERE status IN ('signed','shipped')")
  const opps = crmDbService.all(
    'SELECT id, account_id, status, stage, amount, amount_cny, type, source FROM opportunity')
  const quotes = crmDbService.all(
    'SELECT id, contract_id, version, effective_from, effective_to, created_at FROM quotation')

  // account_id → 商机索引
  const oppsByAccount = new Map<number, Array<{ id: number; status: string; amountCny: number; type: string; source: string }>>()
  for (const o of opps) {
    const aid = Number(o.account_id || 0)
    if (!aid) continue
    if (!oppsByAccount.has(aid)) oppsByAccount.set(aid, [])
    oppsByAccount.get(aid)!.push({
      id: Number(o.id), status: String(o.status || ''),
      amountCny: Number(o.amount_cny || 0), type: String(o.type || ''), source: String(o.source || '')
    })
  }
  // contract_id → 报价列表（既有反向链）
  const quotesByContract = new Map<number, Array<{ id: number; version: number; effectiveFrom: number; createdAt: number }>>()
  for (const q of quotes) {
    const cid = Number(q.contract_id || 0)
    if (!cid) continue
    if (!quotesByContract.has(cid)) quotesByContract.set(cid, [])
    quotesByContract.get(cid)!.push({
      id: Number(q.id), version: Number(q.version || 0),
      effectiveFrom: Number(q.effective_from || 0), createdAt: Number(q.created_at || 0)
    })
  }

  // ── 1. 成交合同 → won 商机预演 ──
  let wouldCreateOpp = 0     // 无任何商机的成交合同 → 建 won 商机
  let wouldCloseOpp = 0      // 有商机但非 won → 补关单（opportunityClose won + event）
  let alreadyDone = 0        // 已有 won 商机（幂等）
  let wouldFillCols = 0      // 成交账户商机缺新列值 → 回填
  for (const c of contracts) {
    const cid = Number(c.id)
    const aid = Number(c.account_id || 0)
    const amount = Number(c.amount || 0)
    const accOpps = aid ? oppsByAccount.get(aid) || [] : []
    if (!aid) {
      failures.push({
        key: `contract:${cid}`,
        reason: '成交合同缺 account_id——无法定位/建商机，进失败清单人工处理',
        detail: `name='${String(c.name)}' status='${String(c.status)}'`
      })
      continue
    }
    if (accOpps.length === 0) {
      wouldCreateOpp++
      if (samples.length < 10) {
        samples.push({
          key: `contract:${cid}`,
          plan: `建 won 商机（account:${aid}，source='migration'，amount_cny=${amount}，type/main_model 等留空待人工——不伪造）`
        })
      }
      continue
    }
    const hasWon = accOpps.some((o) => o.status === 'won')
    if (hasWon) {
      alreadyDone++
    } else {
      const hasLost = accOpps.some((o) => o.status === 'lost')
      if (hasLost) {
        conflicts.push({
          key: `contract:${cid}`,
          reason: `账户已有 lost 商机但合同已成交（account:${aid}）——won/lost 矛盾，需人工裁决建新商机还是复活的口径`,
          detail: 'opportunity.status ∈ {active, won, lost}；宪法 §1.5 写入者含迁移回填，但矛盾数据不自动改判'
        })
      } else {
        wouldCloseOpp++
        if (samples.length < 10) {
          samples.push({
            key: `contract:${cid}`,
            plan: `既有商机补关单 won（account:${aid} 的 active 商机，reason='历史成交迁移'）+ 补列 amount_cny=${amount}`
          })
        }
      }
    }
    // 补列预检：成交账户的商机 amount_cny 仍为 0 → 执行时以合同金额回填
    const needFill = accOpps.filter((o) => o.amountCny === 0 && amount > 0)
    wouldFillCols += needFill.length
  }

  // ── 2. quotation 首版本核验与回填预演 ──
  let versionOk = 0
  let wouldBackfillEffective = 0
  for (const q of quotes) {
    const v = Number(q.version || 0)
    if (v !== 1) {
      failures.push({
        key: `quotation:${Number(q.id)}`,
        reason: `version=${v} ≠ 1（D3 ALTER DEFAULT 1 应已覆盖，异常）——首版本核验不过`,
        detail: '宪法 §1.6：既有报价行 = 首版本；执行器应 UPDATE version=1'
      })
    } else {
      versionOk++
    }
    if (Number(q.effective_from || 0) === 0) wouldBackfillEffective++
  }
  notes.push(`quotation 首版本核验：version=1 共 ${versionOk}/${quotes.length} 行；effective_from=0 待回填（← created_at）${wouldBackfillEffective} 行`)

  // ── 3. contract.quote_version_id 挂接预演（宪法 §1.6 权威方向） ──
  let wouldLinkQuote = 0
  let noQuote = 0
  for (const c of contracts) {
    const cid = Number(c.id)
    if (c.quote_version_id != null && Number(c.quote_version_id) > 0) { alreadyDone++; continue }
    const qs = quotesByContract.get(cid) || []
    if (qs.length === 0) { noQuote++; continue }
    // 最新版本 = version 最大者，再按 id 兜底（同版本取新行）
    const latest = qs.reduce((a, b) => (b.version > a.version || (b.version === a.version && b.id > a.id) ? b : a))
    wouldLinkQuote++
    if (samples.length < 10) {
      samples.push({ key: `contract:${cid}`, plan: `quote_version_id ← quotation:${latest.id}（version=${latest.version}，${qs.length} 版中最新）` })
    }
  }
  notes.push(`contract.quote_version_id 待挂接 ${wouldLinkQuote} 张；成交但无报价 ${noQuote} 张（PRD 5.1 成交登记允许无报价历史，留人工补录窗口）`)
  notes.push('quotation.contract_id 旧方向保留双写（Phase 1 写入路径上线起同事务双写，Phase 2 读路径切换后退役——D3 拍板，见 crmDbService 迁移注释）')

  return {
    module: '04-history-deal-opportunity',
    title: '历史成交 → opportunity 补列（won 态）+ quotation 首版本（version=1）',
    ranAt, dbLabel, dryRun: true,
    summary: {
      total: contracts.length,
      wouldApply: wouldCreateOpp + wouldCloseOpp + wouldFillCols + wouldBackfillEffective + wouldLinkQuote,
      alreadyDone, skipped: 0,
      failed: failures.length,
      conflicts: conflicts.length
    },
    failures, conflicts, samples, notes
  }
}

// ─── 执行器（宪法 §1.6 修订 2026-09-09 落地；铁律：只走 crmDbService 链路，幂等可重入）───
// 执行逻辑已上收至 crmMigrationService.migrate04HistoryDealToOpportunity（启动链路直接跑，
// 不再「骨架只写不跑」）。此处 re-export 仅为兼容既有 import 路径（crm-opportunity-test 等）。
export { migrate04HistoryDealToOpportunity as apply } from '../../electron/services/crmMigrationService'
export type { ModuleMigrationResult as Apply04Result } from '../../electron/services/crmMigrationService'
