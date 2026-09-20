/**
 * annualReviewExportContent.ts —— 年度经营复盘 · Markdown/CSV 内容渲染（S6，纯模块）
 *
 * 职责（规格 §6.3）：把最终 AnnualReviewReport 渲染为 Markdown 报告与 CSV 明细。
 *   - 内容 = 元数据（scopeKind/统计区间/generatedAt/dataRange）+ 完整性/warnings 全文
 *     + 全部 V1 确定性指标 + 数据说明；**不导出聊天正文**。
 *   - unavailable 一律导出「不可用（原因/口径）」，绝不写成 0。
 *   - 注入防护：CSV 单元格以 `=`/`+`/`-`/`@`/制表符开头 → 前置 `'`（Excel 公式注入）；
 *     Markdown 中用户可控字符串（名称/原因/detail）转义 `<`/`>`/`&`，避免被解释为 HTML。
 *   - 零 Electron/零 fs 依赖、零数据库访问；同输入同输出（与报告字段序无关）；
 *     输入报告本身已保证不含 sessionId/wxid/路径/SQL/Token（组装层契约）。
 */
import type { AnnualReviewReport } from './annualReviewReport'
import type { MetricWarning as AnnualReviewMetricWarning } from './annualReviewStats'

// ─── 转义工具 ────────────────────────────────────────────────────────────────

/** Markdown/正文用户字段转义：& < > → 实体（避免被解释为 HTML/标签） */
export function escapeMarkdownText(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** CSV 单元格转义：公式注入前缀（= + - @ \t）前置单引号；含逗号/引号/换行 → 引号包裹 */
export function escapeCsvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v)
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`
  return s
}

/** BOM（Excel 兼容） */
export const CSV_BOM = '\uFEFF'

// ─── 值格式化（四态确定） ─────────────────────────────────────────────────────

interface MetricLike { value: number | string | null; state: string; warnings?: AnnualReviewMetricWarning[] }

const STATE_LABELS: Record<string, string> = {
  complete: '完整',
  partial: '部分完整',
  snapshot_only: '当前快照',
  unavailable: '不可用'
}

/** unavailable/null → 「不可用」；绝不把不可用渲染成 0 */
function metricText(m: MetricLike | null | undefined, format: (v: number) => string): string {
  if (!m || m.state === 'unavailable' || m.value === null || m.value === undefined) return '不可用'
  return typeof m.value === 'number' ? format(m.value) : escapeMarkdownText(m.value)
}

function fmtInt(v: number): string {
  return v.toLocaleString('zh-CN')
}
function fmtAmount(v: number): string {
  return `¥${v.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`
}
function fmtDate(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function scopeRangeText(report: AnnualReviewReport): string {
  if (report.scopeKind === 'all_time') return '全部本地数据（截至生成时间）'
  if (report.periodStart !== null && report.periodEndExclusive !== null) {
    return `${fmtDate(report.periodStart)} 至 ${fmtDate(report.periodEndExclusive)}`
  }
  return '以主进程返回为准'
}

function dataRangeText(report: AnnualReviewReport): string {
  if (report.dataRange.from === null || report.dataRange.to === null) return '无有效数据范围'
  return `${fmtDate(report.dataRange.from)} 至 ${fmtDate(report.dataRange.to)}`
}

const SCOPE_LABELS: Record<string, string> = {
  current_year: '当前年度',
  historical_year: '历史年度',
  all_time: '历史以来'
}

// ─── Markdown ────────────────────────────────────────────────────────────────

/** 渲染 Markdown 报告（用户可控字段全部经 escapeMarkdownText） */
export function buildAnnualReviewMarkdown(report: AnnualReviewReport): string {
  const L: string[] = []
  const yearText = report.year === 0 ? '历史以来' : `${report.year} 年`
  L.push(`# 年度经营复盘 · ${escapeMarkdownText(yearText)}`)
  L.push('')
  L.push(`- 统计范围：${escapeMarkdownText(SCOPE_LABELS[report.scopeKind] ?? report.scopeKind)}（${escapeMarkdownText(scopeRangeText(report))}）`)
  L.push(`- 数据范围（实际输入事实）：${escapeMarkdownText(dataRangeText(report))}`)
  L.push(`- 生成时间：${escapeMarkdownText(new Date(report.generatedAt).toLocaleString('zh-CN'))}`)
  L.push(`- 整体完整性：${escapeMarkdownText(STATE_LABELS[report.completeness.overall] ?? report.completeness.overall)}`)
  const blockText = Object.entries(report.completeness.blocks)
    .map(([id, s]) => `${id}=${escapeMarkdownText(STATE_LABELS[s] ?? s)}`)
    .join('，')
  L.push(`- 区块完整性：${blockText}`)
  L.push('')

  // ── 年度经营摘要 ──
  L.push('## 年度经营摘要')
  L.push('')
  L.push('| 指标 | 值 | 状态 |')
  L.push('| --- | --- | --- |')
  const summaryRows: Array<[string, MetricLike, (v: number) => string]> = [
    ['客户总数', report.summary.customerTotal, fmtInt],
    ['年度新增客户', report.summary.customerNew, fmtInt],
    ['年度活跃客户', report.summary.customerActive, fmtInt],
    ['年度签约合同数', report.summary.contractCount, fmtInt],
    ['年度签约合同金额', report.summary.contractAmount, fmtAmount],
    ['年度已核销回款金额', report.summary.creditedAmount, fmtAmount],
    ['年度已发货合同数', report.summary.shippedCount, fmtInt],
    ['年度已发货合同金额', report.summary.shippedAmount, fmtAmount],
    ['成交客户数', report.summary.dealingCustomers, fmtInt],
    ['客单价', report.summary.avgDealSize, fmtAmount]
  ]
  for (const [label, metric, fmt] of summaryRows) {
    L.push(`| ${label} | ${metricText(metric, fmt)} | ${escapeMarkdownText(STATE_LABELS[metric.state] ?? metric.state)} |`)
  }
  L.push('')

  // ── 漏斗与阶段 ──
  L.push('## 漏斗与阶段')
  L.push('')
  const distTable = (title: string, kind: string | undefined, rows: Array<{ bucket: string; count: number }> | null, coverageRatio: number | null | undefined, state: string): void => {
    L.push(`### ${escapeMarkdownText(title)}`)
    L.push('')
    if (state === 'unavailable' || rows === null) {
      L.push('不可用（历史时点无法可靠重建或总体为空声明）')
      L.push('')
      return
    }
    if (kind) {
      const kindText = kind === 'historical_reconstruction'
        ? (typeof coverageRatio === 'number' ? `历史年末重建（覆盖率 ${Math.round(coverageRatio * 100)}%）` : '历史年末重建')
        : '当前快照（截至生成时间）'
      L.push(`形态：${escapeMarkdownText(kindText)}`)
      L.push('')
    }
    L.push('| 档位 | 数量 |')
    L.push('| --- | --- |')
    for (const row of rows) L.push(`| ${escapeMarkdownText(row.bucket)} | ${fmtInt(row.count)} |`)
    L.push('')
  }
  distTable('客户阶段分布', report.funnel.customerStage.kind, report.funnel.customerStage.distribution, report.funnel.customerStage.coverage.coverageRatio, report.funnel.customerStage.coverage.status)
  distTable('商机阶段分布', report.funnel.opportunityStage.kind, report.funnel.opportunityStage.distribution, report.funnel.opportunityStage.coverage.coverageRatio, report.funnel.opportunityStage.coverage.status)
  distTable('年内阶段流转', undefined, report.funnel.stageFlow.distribution, report.funnel.stageFlow.coverage.coverageRatio, report.funnel.stageFlow.coverage.status)
  L.push(`### 停滞客户`)
  L.push('')
  L.push(report.funnel.stuck.value === null || report.funnel.stuck.coverage.status === 'unavailable' ? '不可用' : `停滞客户数：${fmtInt(report.funnel.stuck.value)}`)
  L.push('')
  L.push(`### 流失归因`)
  L.push('')
  if (report.funnel.lostBreakdown.coverage.status === 'unavailable' || report.funnel.lostBreakdown.customerPreviousStage === null) {
    L.push('不可用')
    L.push('')
  } else {
    L.push('| 流失前档位 | 数量 |')
    L.push('| --- | --- |')
    for (const row of report.funnel.lostBreakdown.customerPreviousStage) L.push(`| ${escapeMarkdownText(row.bucket)} | ${fmtInt(row.count)} |`)
    L.push('')
    L.push('| 商机流失原因 | 数量 |')
    L.push('| --- | --- |')
    for (const row of report.funnel.lostBreakdown.opportunityReasons ?? []) L.push(`| ${escapeMarkdownText(row.reason)} | ${fmtInt(row.count)} |`)
    L.push('')
  }

  // ── 客户经营 ──
  L.push('## 客户经营')
  L.push('')
  const listSection = (title: string, block: { value: unknown[] | null; coverage: { status: string }; warnings?: AnnualReviewMetricWarning[] }, rowText: (row: never) => string): void => {
    L.push(`### ${escapeMarkdownText(title)}`)
    L.push('')
    if (block.coverage.status === 'unavailable' || block.value === null) {
      L.push('不可用')
      L.push('')
      return
    }
    if (block.value.length === 0) {
      L.push('该年度没有符合条件的事实（真实零）')
      L.push('')
      return
    }
    for (const row of block.value) L.push(`- ${rowText(row as never)}`)
    L.push('')
  }
  listSection('高价值客户（按年度核销回款）', report.customers.highValue, (r: { name: string | null; accountId: number; creditedAmount: number; contractAmount: number }) =>
    `${escapeMarkdownText(r.name ?? `客户 #${r.accountId}`)}：核销 ${fmtAmount(r.creditedAmount)} · 签约 ${fmtAmount(r.contractAmount)}`)
  listSection('新增客户', report.customers.newCustomers, (r: { name: string | null; accountId: number; createdAt: number; imported: boolean }) =>
    `${escapeMarkdownText(r.name ?? `客户 #${r.accountId}`)}：建档 ${fmtDate(r.createdAt)}${r.imported ? '（导入建档）' : ''}`)
  listSection('成交客户', report.customers.dealing, (r: { name: string | null; accountId: number; contractCount: number; contractAmount: number }) =>
    `${escapeMarkdownText(r.name ?? `客户 #${r.accountId}`)}：${fmtInt(r.contractCount)} 份 · ${fmtAmount(r.contractAmount)}`)
  listSection('复购客户', report.customers.repeat, (r: { name: string | null; accountId: number; contractCount: number }) =>
    `${escapeMarkdownText(r.name ?? `客户 #${r.accountId}`)}：${fmtInt(r.contractCount)} 份`)
  listSection('活跃客户', report.customers.active, (r: { name: string | null; accountId: number | null }) =>
    escapeMarkdownText(r.name ?? (r.accountId !== null ? `客户 #${r.accountId}` : '客户')))
  listSection('沉默客户（>90 天未沟通）', report.customers.silent, (r: { name: string | null; accountId: number | null; lastContactAtMs: number }) =>
    `${escapeMarkdownText(r.name ?? (r.accountId !== null ? `客户 #${r.accountId}` : '客户'))}：最近联系 ${fmtDate(r.lastContactAtMs)}`)
  listSection('流失风险客户（>60 天未沟通）', report.customers.risk, (r: { name: string | null; accountId: number | null; stage: string; lastContactAtMs: number }) =>
    `${escapeMarkdownText(r.name ?? (r.accountId !== null ? `客户 #${r.accountId}` : '客户'))}：${escapeMarkdownText(r.stage)} · 最近联系 ${fmtDate(r.lastContactAtMs)}`)
  listSection('当前重点推进客户', report.customers.priority, (r: { name: string | null; accountId: number | null; lastContactAtMs: number }) =>
    `${escapeMarkdownText(r.name ?? (r.accountId !== null ? `客户 #${r.accountId}` : '客户'))}：最近联系 ${fmtDate(r.lastContactAtMs)}`)

  // ── 沟通质量 ──
  L.push('## 沟通质量')
  L.push('')
  L.push(`- 年度客户消息量：${metricText(report.communication.volume, fmtInt)}`)
  L.push(`- 有沟通客户数：${metricText(report.communication.contacted, fmtInt)}`)
  L.push(`- 主动联系率：${metricText(report.communication.outboundRate, (v) => `${Math.round(v * 100)}%`)}`)
  const months = report.communication.monthlyTrend.months
  if (months !== null) {
    L.push(`- 月度趋势：${months.map((m) => `${m.month}=${fmtInt(m.count)}`).join('，')}`)
  } else {
    L.push('- 月度趋势：不可用')
  }
  const longSilent = report.communication.longSilent.value
  if (longSilent === null) {
    L.push('- 长期未联系客户：不可用')
  } else if (longSilent.length === 0) {
    L.push('- 长期未联系客户：无（真实零）')
  } else {
    L.push('- 长期未联系客户：')
    for (const row of longSilent) {
      L.push(`  - ${escapeMarkdownText(row.name ?? (row.accountId !== null ? `客户 #${row.accountId}` : '客户'))}：最近联系 ${fmtDate(row.lastContactAtMs)}`)
    }
  }
  L.push('')

  // ── 销售与分配 ──
  L.push('## 销售与分配（本机记录视角）')
  L.push('')
  const af = report.salesAssignment.assignedFacts
  L.push(`- 初始分配：${fmtInt(af.initialAssignments.total)}（按销售：${af.initialAssignments.groups.map((g) => `${escapeMarkdownText(g.salesName ?? '未署名')}${g.mode ? `/${escapeMarkdownText(g.mode)}` : ''}=${fmtInt(g.count)}`).join('，') || '无'}）`)
  L.push(`- 移交转入：${fmtInt(af.transfersIn.total)}`)
  L.push(`- 移交转出：${fmtInt(af.transfersOut.total)}`)
  L.push(`- 有效跟进客户（认领且已首触）：${metricText(report.salesAssignment.effectiveFollowup, fmtInt)}`)
  const cc = report.salesAssignment.contractContribution.value
  if (cc === null) L.push('- 合同贡献：不可用')
  else L.push(`- 合同贡献（按当前归属销售）：${cc.map((r) => `${escapeMarkdownText(r.ownerSales ?? '未归属')}=${fmtAmount(r.totalAmount)}（${fmtInt(r.contractCount)} 份）`).join('，') || '无'}`)
  const kc = report.salesAssignment.creditedContribution.value
  if (kc === null) L.push('- 核销回款贡献：不可用')
  else L.push(`- 核销回款贡献（按认领销售）：${kc.map((r) => `${escapeMarkdownText(r.salesName ?? '未认领')}=${fmtAmount(r.totalAmount)}`).join('，') || '无'}`)
  if (report.salesAssignment.coverage.status === 'partial') {
    L.push('- 检测到中枢下发的分配/移交记录；当前统计只覆盖本机审计事件，实际总量可能更高（不显示覆盖率）')
  }
  L.push('')

  // ── 数据说明 ──
  L.push('## 数据说明')
  L.push('')
  if (report.warnings.length === 0) {
    L.push('- 本报告无降级告警。')
  } else {
    for (const w of report.warnings) {
      const counts = w.counts && Object.values(w.counts).some((n) => n > 0)
        ? `（涉及 ${Math.max(...Object.values(w.counts))} 条）`
        : ''
      L.push(`- ${escapeMarkdownText(w.message)}${escapeMarkdownText(counts)}`)
    }
  }
  L.push('- 本报告为本机数据视角；「当前快照」为截至生成时间的投影，「历史年末重建」为事件流重放结果。')
  L.push('- 「不可用」表示当前数据无法可靠统计（不显示为 0）；「部分完整」附有降级原因。')
  L.push('- 统计口径：本地时区；金额单位为元；历史年度联系时间类指标不可重建。')
  L.push('')
  L.push('| 数据源 | 表 | 输入行数 |')
  L.push('| --- | --- | --- |')
  for (const s of report.sourceSummary) {
    L.push(`| ${escapeMarkdownText(s.source)} | ${escapeMarkdownText(s.tables.join(' / '))} | ${fmtInt(s.rows)} |`)
  }
  return L.join('\n')
}

// ─── CSV ─────────────────────────────────────────────────────────────────────

interface CsvRow { metric: string; scope: string; value: string; state: string }

/** 渲染 CSV 明细（BOM + 公式注入转义；unavailable → 「不可用」） */
export function buildAnnualReviewCsv(report: AnnualReviewReport): string {
  const rows: CsvRow[] = []
  const push = (metric: string, scope: string, m: MetricLike | { value: number | string | null; state: string }, format?: (v: number) => string): void => {
    rows.push({
      metric,
      scope,
      value: metricText(m as MetricLike, format ?? fmtInt),
      state: STATE_LABELS[(m as MetricLike).state] ?? (m as MetricLike).state
    })
  }

  for (const [key, metric] of Object.entries(report.summary)) {
    const label: Record<string, string> = {
      customerTotal: '客户总数', customerNew: '年度新增客户', customerActive: '年度活跃客户',
      contractCount: '年度签约合同数', contractAmount: '年度签约合同金额', creditedAmount: '年度已核销回款',
      shippedCount: '年度已发货合同数', shippedAmount: '年度已发货金额', dealingCustomers: '成交客户数', avgDealSize: '客单价'
    }
    const isAmount = key === 'contractAmount' || key === 'creditedAmount' || key === 'shippedAmount' || key === 'avgDealSize'
    push(label[key] ?? key, '年度经营摘要', metric, isAmount ? fmtAmount : fmtInt)
  }
  for (const [title, block] of [['客户阶段分布', report.funnel.customerStage], ['商机阶段分布', report.funnel.opportunityStage]] as const) {
    for (const row of block.distribution ?? []) push(`${title}·${row.bucket}`, '漏斗与阶段', { value: row.count, state: block.coverage.status })
  }
  for (const row of report.funnel.stageFlow.distribution) push(`阶段流转·${row.bucket}`, '漏斗与阶段', { value: row.count, state: report.funnel.stageFlow.coverage.status })
  push('停滞客户', '漏斗与阶段', { value: report.funnel.stuck.value, state: report.funnel.stuck.coverage.status })

  // 客户列表统一为计数行（明细条目在 Markdown；CSV 不导出可回溯身份的组合列）
  for (const [label, block] of [
    ['高价值客户', report.customers.highValue], ['新增客户', report.customers.newCustomers],
    ['成交客户', report.customers.dealing], ['复购客户', report.customers.repeat],
    ['活跃客户', report.customers.active], ['沉默客户', report.customers.silent],
    ['流失风险客户', report.customers.risk], ['当前重点推进客户', report.customers.priority]
  ] as const) {
    push(`${label}·人数`, '客户经营', { value: block.value === null ? null : block.value.length, state: block.coverage.status })
  }

  push('年度客户消息量', '沟通质量', report.communication.volume)
  push('有沟通客户数', '沟通质量', report.communication.contacted)
  push('主动联系率', '沟通质量', report.communication.outboundRate, (v) => `${Math.round(v * 100)}%`)
  for (const m of report.communication.monthlyTrend.months ?? []) {
    push(`月度趋势·${m.month}`, '沟通质量', { value: m.count, state: report.communication.monthlyTrend.state })
  }
  push('长期未联系客户·人数', '沟通质量', { value: report.communication.longSilent.value === null ? null : report.communication.longSilent.value.length, state: report.communication.longSilent.state })

  push('初始分配', '销售与分配', { value: report.salesAssignment.assignedFacts.initialAssignments.total, state: report.salesAssignment.coverage.status })
  push('移交转入', '销售与分配', { value: report.salesAssignment.assignedFacts.transfersIn.total, state: report.salesAssignment.coverage.status })
  push('移交转出', '销售与分配', { value: report.salesAssignment.assignedFacts.transfersOut.total, state: report.salesAssignment.coverage.status })
  push('有效跟进客户', '销售与分配', report.salesAssignment.effectiveFollowup)
  for (const row of report.salesAssignment.contractContribution.value ?? []) {
    push(`合同贡献·${row.ownerSales ?? '未归属'}`, '销售与分配', { value: row.totalAmount, state: report.salesAssignment.contractContribution.state }, fmtAmount)
  }
  for (const row of report.salesAssignment.creditedContribution.value ?? []) {
    push(`核销回款贡献·${row.salesName ?? '未认领'}`, '销售与分配', { value: row.totalAmount, state: report.salesAssignment.creditedContribution.state }, fmtAmount)
  }

  const lines: string[] = ['指标,区块,值,状态']
  for (const row of rows) {
    lines.push([escapeCsvCell(row.metric), escapeCsvCell(row.scope), escapeCsvCell(row.value), escapeCsvCell(row.state)].join(','))
  }
  return CSV_BOM + lines.join('\r\n') + '\r\n'
}
