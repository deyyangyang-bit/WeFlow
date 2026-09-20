/**
 * annualReviewAssignment.ts —— 年度经营复盘 · E 组销售与分配（S5，确定性统计）
 *
 * 规格 docs/设计-年度经营复盘-规格.md §5.5 / §10（V1 必做；本机记录视角）：
 *   - E1 assigned_facts：append-only audit_event（**不用 assignment.updated_at**）。
 *     initialAssignments = action='lead_assign'（按 detail.salesName+mode 分组）；
 *     transfersIn/Out = action='lead_transfer'（按 detail.toSales / fromSales 分组）；
 *     **初始分配与移交分开统计，不相加命名**。sync 缺口检测：区间内存在
 *     action='sync_apply' 且 detail.type ∈ (assign/transfer) → 整体 partial、
 *     exactCoverage=false、coverageRatio=null（禁止显示覆盖率百分比）。
 *     无本机事实且无 sync_apply → 空数据（真实零，coverage.rows=0）；
 *     无本机事实但有 sync_apply → partial 缺口状态（不得显示真实零）。
 *   - E3 effective_followup：assignment.claimed_at ∈ [start, asOf)（认领动作一次性写入）
 *     且 lead.first_contacted_at 非空 → 计数。
 *   - E4 contract_contribution：A4 同款 sign_date 口径合同，按
 *     contract.account_id → account.owner_sales（当下值）分组求和 → 恒 partial
 *     （reasonCode=owner_current_value）。
 *   - E5 credited_contribution：A6 同口径核销，按 allocation.sales_name（认领销售）
 *     分组求和；legacy 回退继承 partial。
 *   - E2 批次成功率 / E6 计划份额 / E7 份额偏差：**移出 V1**（批次审计字段未落齐），
 *     本模块不实现、不改 Schema 偷跑。
 *
 * 纪律：纯函数、注入事实、不修改输入、同输入同输出且与输入行序无关；零 Electron
 * 依赖；输出可 structuredClone；不包含 wxid/路径/SQL/正文。
 */
import {
  annualReviewCreditedAllocationsInRange,
  annualReviewSignedContractsInRange,
  asFinite,
  deterministicSum,
  type AnnualReviewComputeOptions,
  type AnnualReviewPeriod,
  type MetricState,
  type MetricWarning
} from './annualReviewStats'
import type { AnnualReviewSegmentInputs } from './annualReviewSegments'

// ─── 输出结构 ────────────────────────────────────────────────────────────────

export interface AnnualReviewSalesGroup {
  /** 销售名；null = detail 缺失（保留分组，UI 显示「未署名」，不并入其他销售） */
  salesName: string | null
  count: number
}

export interface AnnualReviewAssignedFacts {
  /** 初始分配（lead_assign；按 salesName+mode 分组）——不得与移交相加命名 */
  initialAssignments: { total: number; groups: Array<{ salesName: string | null; mode: string | null; count: number }> }
  /** 移入（lead_transfer 按 detail.toSales） */
  transfersIn: { total: number; groups: AnnualReviewSalesGroup[] }
  /** 移出（lead_transfer 按 detail.fromSales） */
  transfersOut: { total: number; groups: AnnualReviewSalesGroup[] }
}

export interface AnnualReviewAssignmentBlock {
  assignedFacts: AnnualReviewAssignedFacts
  /** sync 缺口检测 → partial + exactCoverage=false + coverageRatio=null；空数据 → complete；事实缺失 → unavailable */
  coverage: { source: string; status: MetricState; rows?: number; reasonCodes?: string[]; exactCoverage?: boolean; coverageRatio?: number | null }
  warnings: MetricWarning[]
  effectiveFollowup: { value: number | null; state: MetricState; warnings: MetricWarning[] }
  contractContribution: { value: Array<{ ownerSales: string | null; contractCount: number; totalAmount: number }> | null; state: MetricState; warnings: MetricWarning[] }
  creditedContribution: { value: Array<{ salesName: string | null; totalAmount: number }> | null; state: MetricState; warnings: MetricWarning[] }
}

const E_WARN = {
  sync_import_not_audited: '检测到中枢下发的分配/移交记录；当前统计只覆盖本机审计事件，实际总量可能更高',
  audit_time_missing: '部分分配/移交审计事件缺少有效时间，已排除',
  audit_detail_invalid: '部分分配/移交审计事件 detail 无法解析，已排除出分组',
  owner_current_value: '按当前归属销售统计（历史归属不可重现）',
  contribution_account_missing: '存在未关联客户的合同/核销记录，未计入贡献',
  effective_followup_lead_missing: '部分认领对应的线索不存在或已删除，无法核实首触，已排除',
  legacy_time_fallback: '部分回款使用 legacy 确认时间回退口径'
} as const

function sortedWarnings(list: MetricWarning[]): MetricWarning[] {
  return [...list].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
}

interface GroupAcc { salesName: string | null; mode: string | null; count: number }

/** 分组排序（与行序无关）：count 降序 → 销售名升序 → mode 升序（null 排最前） */
function groupSort(groups: GroupAcc[]): GroupAcc[] {
  return [...groups].sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count
    const an = a.salesName ?? ''
    const bn = b.salesName ?? ''
    if (an !== bn) return an < bn ? -1 : 1
    const am = a.mode ?? ''
    const bm = b.mode ?? ''
    if (am !== bm) return am < bm ? -1 : 1
    return 0
  })
}

/** 贡献行排序：金额降序 → 合同数降序 → 名字升序（确定全序） */
function byAmountThenName<T extends { totalAmount: number; contractCount?: number; ownerSales?: string | null; salesName?: string | null }>(rows: T[], nameOf: (r: T) => string | null): T[] {
  return [...rows].sort((a, b) => {
    if (b.totalAmount !== a.totalAmount) return b.totalAmount - a.totalAmount
    if (a.contractCount !== undefined && b.contractCount !== undefined && b.contractCount !== a.contractCount) return b.contractCount - a.contractCount
    const an = nameOf(a) ?? ''
    const bn = nameOf(b) ?? ''
    if (an !== bn) return an < bn ? -1 : 1
    return 0
  })
}

/**
 * E 组销售与分配。facts.auditEvents/assignments/leads 缺失（旧载荷）→ 对应指标
 * unavailable（不伪造）。
 */
export function computeAnnualReviewSalesAssignment(
  period: AnnualReviewPeriod,
  inputs: AnnualReviewSegmentInputs
): AnnualReviewAssignmentBlock {
  const start = period.periodStart
  const end = period.asOf
  const inRange = (t: number | null): boolean => t !== null && (start === null || t >= start) && t < end

  // ── E1：append-only 审计事实 ──
  const auditEvents = inputs.facts.auditEvents
  const warnings: MetricWarning[] = []
  let coverage: AnnualReviewAssignmentBlock['coverage']
  let assignedFacts: AnnualReviewAssignedFacts

  if (!auditEvents) {
    // 事实缺失（旧 Worker 载荷 / loader 失败）：unavailable，不伪造
    coverage = { source: 'crmdb.audit_event', status: 'unavailable', reasonCodes: ['facts_missing'] }
    assignedFacts = {
      initialAssignments: { total: 0, groups: [] },
      transfersIn: { total: 0, groups: [] },
      transfersOut: { total: 0, groups: [] }
    }
  } else {
    const initialBy = new Map<string, GroupAcc>()
    const inBy = new Map<string, { salesName: string; count: number }>()
    const outBy = new Map<string, { salesName: string; count: number }>()
    let initialTotal = 0
    let inTotal = 0
    let outTotal = 0
    let timeMissing = 0
    let detailInvalid = 0
    let hasLocalFacts = false
    let hasSyncGap = false
    for (const ev of auditEvents) {
      if (!inRange(ev.createdAt)) {
        if (ev.createdAt === null && (ev.action === 'lead_assign' || ev.action === 'lead_transfer')) timeMissing++
        continue
      }
      if (ev.action === 'lead_assign') {
        if (ev.salesName === null && ev.mode === null && ev.assignmentId === null) detailInvalid++
        hasLocalFacts = true
        initialTotal++
        const key = `${ev.salesName ?? ''}\u0001${ev.mode ?? ''}`
        const acc = initialBy.get(key) ?? { salesName: ev.salesName, mode: ev.mode, count: 0 }
        acc.count++
        initialBy.set(key, acc)
      } else if (ev.action === 'lead_transfer') {
        if (ev.toSales === null && ev.fromSales === null && ev.assignmentId === null) detailInvalid++
        hasLocalFacts = true
        if (ev.toSales !== null) {
          inTotal++
          const acc = inBy.get(ev.toSales) ?? { salesName: ev.toSales, count: 0 }
          acc.count++
          inBy.set(ev.toSales, acc)
        }
        if (ev.fromSales !== null) {
          outTotal++
          const acc = outBy.get(ev.fromSales) ?? { salesName: ev.fromSales, count: 0 }
          acc.count++
          outBy.set(ev.fromSales, acc)
        }
      } else if (ev.action === 'sync_apply') {
        // 缺口检测只取 assign/transfer（lanSyncService 落地形态；noop/回收不计）
        if (ev.detailType === 'assign' || ev.detailType === 'transfer') hasSyncGap = true
      }
    }
    if (timeMissing > 0) warnings.push({ code: 'audit_time_missing', message: E_WARN.audit_time_missing, count: timeMissing })
    if (detailInvalid > 0) warnings.push({ code: 'audit_detail_invalid', message: E_WARN.audit_detail_invalid, count: detailInvalid })
    if (hasSyncGap) warnings.push({ code: 'sync_import_not_audited', message: E_WARN.sync_import_not_audited })

    // 状态：有缺口 → partial（缺口语义，exactCoverage=false + coverageRatio=null）；
    // 无缺口 → complete（含空数据真实零；只称本机操作审计完整，不宣称跨设备全量）
    const status: MetricState = hasSyncGap ? 'partial' : 'complete'
    coverage = {
      source: 'crmdb.audit_event',
      status,
      rows: initialTotal + inTotal + outTotal,
      reasonCodes: warnings.map((w) => w.code),
      exactCoverage: hasSyncGap ? false : undefined,
      coverageRatio: hasSyncGap ? null : undefined
    }
    assignedFacts = {
      initialAssignments: { total: initialTotal, groups: groupSort([...initialBy.values()]) },
      transfersIn: { total: inTotal, groups: [...inBy.values()].sort((a, b) => b.count - a.count || (a.salesName < b.salesName ? -1 : a.salesName > b.salesName ? 1 : 0)) },
      transfersOut: { total: outTotal, groups: [...outBy.values()].sort((a, b) => b.count - a.count || (a.salesName < b.salesName ? -1 : a.salesName > b.salesName ? 1 : 0)) }
    }
  }

  // ── E3：有效跟进 ──
  let effectiveFollowup: AnnualReviewAssignmentBlock['effectiveFollowup']
  if (!inputs.facts.assignments || !inputs.facts.leads) {
    effectiveFollowup = { value: null, state: 'unavailable', warnings: [{ code: 'facts_missing', message: '认领/线索事实缺失，无法统计有效跟进' }] }
  } else {
    const firstContactByLead = new Map<number, number | null>()
    for (const lead of inputs.facts.leads) {
      if (lead.id > 0) firstContactByLead.set(lead.id, asFinite(lead.firstContactedAt))
    }
    const seenAssignment = new Set<number>()
    let count = 0
    let leadMissing = 0
    for (const a of inputs.facts.assignments) {
      const claimed = asFinite(a.claimedAt)
      if (claimed === null || !inRange(claimed)) continue
      if (a.id > 0) {
        if (seenAssignment.has(a.id)) continue // 同一认领事实幂等（行序无关）
        seenAssignment.add(a.id)
      }
      if (a.leadId === null || !firstContactByLead.has(a.leadId)) {
        leadMissing++ // 线索行不存在/已删除：无法核实首触 → 排除并告警
        continue
      }
      const first = firstContactByLead.get(a.leadId) ?? null
      if (first === null) continue // 已认领但未首触：正常不计入（非异常）
      count++
    }
    const w: MetricWarning[] = leadMissing > 0 ? [{ code: 'effective_followup_lead_missing', message: E_WARN.effective_followup_lead_missing, count: leadMissing }] : []
    effectiveFollowup = { value: count, state: leadMissing > 0 ? 'partial' : 'complete', warnings: sortedWarnings(w) }
  }

  // ── E4：合同贡献（A4 同一 sign_date 口径；owner_sales 当下值 → 恒 partial） ──
  let contractContribution: AnnualReviewAssignmentBlock['contractContribution']
  {
    const signed = annualReviewSignedContractsInRange(period, inputs.facts.contracts ?? [])
    const ownerByAccount = new Map<number, string | null>()
    for (const acc of inputs.facts.accounts ?? []) ownerByAccount.set(acc.id, acc.ownerSales ?? null)
    const amountsByOwner = new Map<string, { ownerSales: string | null; contractCount: number; amounts: number[] }>()
    let accountMissing = 0
    for (const c of signed.signedInRange) {
      const owner = c.accountId !== null ? ownerByAccount.get(c.accountId) : undefined
      if (owner === undefined) {
        accountMissing++
        continue
      }
      const key = owner ?? ''
      const acc = amountsByOwner.get(key) ?? { ownerSales: owner, contractCount: 0, amounts: [] }
      acc.contractCount++
      if (c.amount !== null) acc.amounts.push(c.amount)
      amountsByOwner.set(key, acc)
    }
    const w: MetricWarning[] = [{ code: 'owner_current_value', message: E_WARN.owner_current_value }]
    if (accountMissing > 0) w.push({ code: 'contribution_account_missing', message: E_WARN.contribution_account_missing, count: accountMissing })
    contractContribution = {
      value: byAmountThenName([...amountsByOwner.values()].map((acc) => ({ ownerSales: acc.ownerSales, contractCount: acc.contractCount, totalAmount: deterministicSum(acc.amounts) })), (r) => r.ownerSales),
      state: 'partial',
      warnings: sortedWarnings(w)
    }
  }

  // ── E5：核销回款贡献（A6 同一口径；按认领销售 sales_name 分组） ──
  let creditedContribution: AnnualReviewAssignmentBlock['creditedContribution']
  {
    const credited = annualReviewCreditedAllocationsInRange(period, inputs.facts.allocations ?? [])
    const bySales = new Map<string, { salesName: string | null; amounts: number[] }>()
    for (const row of credited.rows) {
      const salesName = row.allocation.salesName ?? null
      const key = salesName ?? ''
      const acc = bySales.get(key) ?? { salesName, amounts: [] }
      acc.amounts.push(row.amount)
      bySales.set(key, acc)
    }
    const w: MetricWarning[] = []
    if (credited.legacyFallback > 0) w.push({ code: 'legacy_time_fallback', message: E_WARN.legacy_time_fallback, count: credited.legacyFallback })
    creditedContribution = {
      value: byAmountThenName([...bySales.values()].map((acc) => ({ salesName: acc.salesName, totalAmount: deterministicSum(acc.amounts) })), (r) => r.salesName),
      state: credited.legacyFallback > 0 ? 'partial' : 'complete',
      warnings: sortedWarnings(w)
    }
  }

  return { assignedFacts, coverage, warnings: sortedWarnings(warnings), effectiveFollowup, contractContribution, creditedContribution }
}
