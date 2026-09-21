/**
 * annualReviewExportContent.ts —— 年度经营复盘 · Markdown/CSV 内容渲染（S6/阶段4，纯模块）
 *
 * 职责（规格 §6.3）：把最终 AnnualReviewReport 渲染为 Markdown 报告与 CSV 明细。
 * 两种格式都必须包含（与 API-CONTRACT §1.15 导出契约一致）：
 *   - 元数据：reportSchemaVersion / year / scopeKind / periodStart / periodEndExclusive /
 *     asOf / generatedAt / dataRange；
 *   - completeness：overall + 各 block；
 *   - **固定 metricKey 全集的 coverage 行**：状态 / source / reasonCodes /
 *     coverageRatio / exactCoverage（存在时）；
 *   - 聚合 warnings：code / message / metricKeys / count；
 *   - sourceSummary；
 *   - 全部 V1 确定性指标：A1–A9、B1/B2/B3/B6/B7、C1–C8、D1/D2/D3/D5/D7、
 *     E1/E3/E4/E5、三个月度趋势序列、E8 三句固定说明。
 * unavailable 一律输出「不可用（原因）」，绝不写成 0；E1 sync 缺口不输出百分比。
 *
 * 注入防护：CSV 单元格前导（可选空白后）`=`/`+`/`-`/`@`/Tab/CR → 前置 `'`；
 * 含逗号/引号/换行 → RFC 引号包裹。Markdown 用户可控字符串转义 `&`/`<`/`>`。
 * 输入报告本身已保证不含 sessionId/wxid/路径/SQL/Token（组装层契约 + validator）。
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

/**
 * CSV 单元格转义（公式注入防护）：
 *   - 前导（允许空白后）以 `=`/`+`/`-`/`@`/Tab 开头 → 前置 `'`（防 Excel 公式解释）；
 *   - 含逗号/引号/换行 → RFC 风格引号包裹（内部引号翻倍）。
 */
export function escapeCsvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v)
  if (/^\s*[=+\-@\t\r]/.test(s)) s = `'${s}`
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`
  return s
}

/** BOM（Excel 兼容） */
export const CSV_BOM = '\uFEFF'

// ─── 值格式化（四态确定） ─────────────────────────────────────────────────────

const STATE_LABELS: Record<string, string> = {
  complete: '完整',
  partial: '部分完整',
  snapshot_only: '当前快照',
  unavailable: '不可用'
}

/** unavailable/null → 「不可用」；绝不把不可用渲染成 0 */
function metricText(m: { value: number | string | null; state: string } | null | undefined, format: (v: number) => string): string {
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
function fmtDateTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN')
}

const SCOPE_LABELS: Record<string, string> = {
  current_year: '当前年度',
  historical_year: '历史年度',
  all_time: '历史以来'
}

export function scopeRangeText(report: AnnualReviewReport): string {
  if (report.scopeKind === 'all_time') return '全部本地数据（截至生成时间）'
  if (report.periodStart !== null && report.periodEndExclusive !== null) {
    return `${fmtDate(report.periodStart)} 至 ${fmtDate(report.periodEndExclusive)}`
  }
  return '以主进程返回为准'
}

export function dataRangeText(report: AnnualReviewReport): string {
  if (report.dataRange.from === null || report.dataRange.to === null) return '无有效数据范围'
  return `${fmtDate(report.dataRange.from)} 至 ${fmtDate(report.dataRange.to)}`
}

const BLOCK_LABELS: Record<string, string> = {
  summary: '年度经营摘要',
  funnel: '漏斗与阶段',
  customers: '客户经营',
  monthly: '月度趋势',
  communication: '沟通质量',
  salesAssignment: '销售与分配'
}

/** E8 三句固定说明（数据说明区固定文案；不得写成公平性结论） */
export const E8_NOTES: readonly string[] = [
  '全部失败批次不留批次审计（assigned=0 不落行）。',
  '部分失败批次的 skipped 只存在于幸存批次的 audit detail 中。',
  'round_robin 游标写盘失败属于辅助降级，可能造成不超过一批的份额漂移并长期自愈；weight/load 不读写游标。'
]

/** 顾客名显示（name → 客户 #accountId → 客户资料 #customerId → 客户） */
function customerName(row: { name?: string | null; accountId?: number | null; customerId?: string | null }): string {
  if (row.name) return row.name
  if (typeof row.accountId === 'number') return `客户 #${row.accountId}`
  if (row.customerId) return `客户资料 #${row.customerId}`
  return '客户'
}

// ─── Markdown ────────────────────────────────────────────────────────────────

/** 渲染 Markdown 报告（用户可控字段全部经 escapeMarkdownText） */
export function buildAnnualReviewMarkdown(report: AnnualReviewReport): string {
  const L: string[] = []
  const yearText = report.year === 0 ? '历史以来' : `${report.year} 年`
  L.push(`# 年度经营复盘 · ${escapeMarkdownText(yearText)}`)
  L.push('')
  L.push('## 报告元数据')
  L.push('')
  L.push(`- reportSchemaVersion：${report.reportSchemaVersion}`)
  L.push(`- year：${report.year}（${escapeMarkdownText(SCOPE_LABELS[report.scopeKind] ?? report.scopeKind)}）`)
  L.push(`- scopeKind：${escapeMarkdownText(report.scopeKind)}`)
  L.push(`- 统计区间：${escapeMarkdownText(scopeRangeText(report))}`)
  L.push(`- periodStart：${report.periodStart === null ? 'null' : report.periodStart}`)
  L.push(`- periodEndExclusive：${report.periodEndExclusive === null ? 'null' : report.periodEndExclusive}`)
  L.push(`- asOf：${report.asOf}`)
  L.push(`- generatedAt：${report.generatedAt}（${escapeMarkdownText(fmtDateTime(report.generatedAt))}）`)
  L.push(`- dataRange：${escapeMarkdownText(dataRangeText(report))}（from=${report.dataRange.from === null ? 'null' : report.dataRange.from}，to=${report.dataRange.to === null ? 'null' : report.dataRange.to}）`)
  L.push(`- 整体完整性：${escapeMarkdownText(STATE_LABELS[report.completeness.overall] ?? report.completeness.overall)}`)
  for (const [blockId, state] of Object.entries(report.completeness.blocks)) {
    L.push(`  - ${escapeMarkdownText(BLOCK_LABELS[blockId] ?? blockId)}：${escapeMarkdownText(STATE_LABELS[state] ?? state)}`)
  }
  L.push('')

  // ── 年度经营摘要（A1–A9）──
  L.push('## 年度经营摘要')
  L.push('')
  L.push('| 指标 | 值 | 状态 |')
  L.push('| --- | --- | --- |')
  const summaryRows: Array<[string, { value: number | null; state: string }, (v: number) => string]> = [
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

  // ── 漏斗与阶段（B1/B2/B3/B6/B7）──
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
  L.push('### 停滞客户')
  L.push('')
  L.push(report.funnel.stuck.value === null || report.funnel.stuck.coverage.status === 'unavailable' ? '不可用' : `停滞客户数：${fmtInt(report.funnel.stuck.value)}`)
  L.push('')
  L.push('### 流失归因')
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

  // ── 客户经营（C1–C8）──
  L.push('## 客户经营')
  L.push('')
  const listSection = (title: string, block: { value: unknown[] | null; coverage: { status: string } }, rowText: (row: never) => string): void => {
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
    `${escapeMarkdownText(customerName(r))}：核销 ${fmtAmount(r.creditedAmount)} · 签约 ${fmtAmount(r.contractAmount)}`)
  listSection('新增客户', report.customers.newCustomers, (r: { name: string | null; accountId: number; createdAt: number; imported: boolean }) =>
    `${escapeMarkdownText(customerName(r))}：建档 ${fmtDate(r.createdAt)}${r.imported ? '（导入建档）' : ''}`)
  listSection('成交客户', report.customers.dealing, (r: { name: string | null; accountId: number; contractCount: number; contractAmount: number }) =>
    `${escapeMarkdownText(customerName(r))}：${fmtInt(r.contractCount)} 份 · ${fmtAmount(r.contractAmount)}`)
  listSection('复购客户', report.customers.repeat, (r: { name: string | null; accountId: number; contractCount: number }) =>
    `${escapeMarkdownText(customerName(r))}：${fmtInt(r.contractCount)} 份`)
  listSection('活跃客户', report.customers.active, (r: { name: string | null; accountId: number | null }) =>
    escapeMarkdownText(customerName(r)))
  listSection('沉默客户（>90 天未沟通）', report.customers.silent, (r: { name: string | null; accountId: number | null; lastContactAtMs: number }) =>
    `${escapeMarkdownText(customerName(r))}：最近联系 ${fmtDate(r.lastContactAtMs)}`)
  listSection('流失风险客户（>60 天未沟通）', report.customers.risk, (r: { name: string | null; accountId: number | null; stage: string; lastContactAtMs: number }) =>
    `${escapeMarkdownText(customerName(r))}：${escapeMarkdownText(r.stage)} · 最近联系 ${fmtDate(r.lastContactAtMs)}`)
  listSection('当前重点推进客户', report.customers.priority, (r: { name: string | null; accountId: number | null; lastContactAtMs: number }) =>
    `${escapeMarkdownText(customerName(r))}：最近联系 ${fmtDate(r.lastContactAtMs)}`)

  // ── 月度趋势（三序列）──
  L.push('## 月度趋势')
  L.push('')
  const monthlySeries = (title: string, months: Array<{ month: string; amount?: number; count?: number }> | null, state: string, format: (v: number) => string): void => {
    L.push(`### ${escapeMarkdownText(title)}`)
    L.push('')
    if (state === 'unavailable' || months === null) {
      L.push('不可用')
      L.push('')
      return
    }
    L.push('| 月份 | 值 |')
    L.push('| --- | --- |')
    for (const p of months) L.push(`| ${escapeMarkdownText(p.month)} | ${format(p.amount ?? p.count ?? 0)} |`)
    L.push('')
  }
  monthlySeries('签约金额（元/月）', report.monthly.contractSign.months, report.monthly.contractSign.state, fmtAmount)
  monthlySeries('已核销回款（元/月）', report.monthly.credited.months, report.monthly.credited.state, fmtAmount)
  monthlySeries('客户消息量（条/月）', report.monthly.messageVolume.months, report.monthly.messageVolume.state, fmtInt)

  // ── 沟通质量（D1/D2/D3/D5/D7）──
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
      L.push(`  - ${escapeMarkdownText(customerName(row))}：最近联系 ${fmtDate(row.lastContactAtMs)}`)
    }
  }
  L.push('')

  // ── 销售与分配（E1/E3/E4/E5）──
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

  // ── 数据说明（warnings + E8 + sourceSummary）──
  L.push('## 数据说明')
  L.push('')
  if (report.warnings.length === 0) {
    L.push('- 本报告无降级告警。')
  } else {
    for (const w of report.warnings) {
      const count = w.counts && Object.values(w.counts).some((n) => n > 0) ? Math.max(...Object.values(w.counts)) : null
      L.push(`- ${escapeMarkdownText(w.message)}${count !== null ? `（涉及 ${fmtInt(count)} 条）` : ''}（${escapeMarkdownText(w.metricKeys.join('、'))}）`)
    }
  }
  for (const sentence of E8_NOTES) L.push(`- ${escapeMarkdownText(sentence)}`)
  L.push('- 本报告为本机数据视角；「当前快照」为截至生成时间的投影，「历史年末重建」为事件流重放结果。')
  L.push('- 「不可用」表示当前数据无法可靠统计（不显示为 0）；「部分完整」附有降级原因。')
  L.push('- 统计口径：本地时区；金额单位为元；历史年度联系时间类指标不可重建。')
  L.push('')
  L.push('| 数据源 | 表 | 输入行数 |')
  L.push('| --- | --- | --- |')
  for (const s of report.sourceSummary) {
    L.push(`| ${escapeMarkdownText(s.source)} | ${escapeMarkdownText(s.tables.join(' / '))} | ${fmtInt(s.rows)} |`)
  }
  L.push('')

  // ── coverage 附表（固定 metricKey 全集；与 CSV coverage 行集合一致）──
  L.push('## 指标覆盖（coverage）')
  L.push('')
  L.push('| metricKey | 状态 | 来源 | reasonCodes | coverageRatio | exactCoverage |')
  L.push('| --- | --- | --- | --- | --- | --- |')
  for (const [key, cov] of Object.entries(report.coverage)) {
    L.push(`| ${escapeMarkdownText(key)} | ${escapeMarkdownText(STATE_LABELS[cov.status] ?? cov.status)} | ${escapeMarkdownText(cov.source)} | ${escapeMarkdownText((cov.reasonCodes ?? []).join('、'))} | ${cov.coverageRatio === undefined ? '' : cov.coverageRatio === null ? 'null' : String(cov.coverageRatio)} | ${cov.exactCoverage === undefined ? '' : String(cov.exactCoverage)} |`)
  }
  return L.join('\n')
}

// ─── CSV（多 rowType 完整契约） ──────────────────────────────────────────────

/**
 * CSV 结构（rowType 列区分；表头固定 12 列）：
 *   rowType,key,label,value,state,source,reasonCodes,coverageRatio,exactCoverage,metricKeys,count,note
 *   - metadata    报告元数据（reportSchemaVersion / year / scopeKind / period 边界 / asOf / generatedAt / dataRange）
 *   - completeness 完整性（overall + 各 block，value=四态）
 *   - coverage    固定 metricKey 全集（value=状态，source/reasonCodes/ratio/exactCoverage）
 *   - metric      V1 指标值（unavailable → 「不可用」）
 *   - detail      指标明细（分布桶/客户条目/月度点/贡献行/流失归因）
 *   - warning     聚合告警（code/message/metricKeys/count）
 *   - source      数据源摘要（source/tables/rows）
 *   - note        固定说明（E8 三句、口径声明）
 */
export function buildAnnualReviewCsv(report: AnnualReviewReport): string {
  const HEADER = 'rowType,key,label,value,state,source,reasonCodes,coverageRatio,exactCoverage,metricKeys,count,note'
  const rows: string[] = []
  const push = (cells: Array<string | number | null | undefined>): void => {
    rows.push(cells.map((c) => escapeCsvCell(c)).join(','))
  }

  // metadata
  push(['metadata', 'reportSchemaVersion', '报告结构版本', report.reportSchemaVersion, '', '', '', '', '', '', '', ''])
  push(['metadata', 'year', '年份', report.year, '', '', '', '', '', '', '', SCOPE_LABELS[report.scopeKind] ?? report.scopeKind])
  push(['metadata', 'scopeKind', '统计范围', report.scopeKind, '', '', '', '', '', '', '', ''])
  push(['metadata', 'periodStart', '区间起', report.periodStart === null ? 'null' : report.periodStart, '', '', '', '', '', '', '', '左闭'])
  push(['metadata', 'periodEndExclusive', '区间止', report.periodEndExclusive === null ? 'null' : report.periodEndExclusive, '', '', '', '', '', '', '', '右开'])
  push(['metadata', 'asOf', '统计时点', report.asOf, '', '', '', '', '', '', '', ''])
  push(['metadata', 'generatedAt', '生成时间', report.generatedAt, '', '', '', '', '', '', '', fmtDateTime(report.generatedAt)])
  push(['metadata', 'dataRangeFrom', '数据范围起', report.dataRange.from === null ? 'null' : report.dataRange.from, '', '', '', '', '', '', '', ''])
  push(['metadata', 'dataRangeTo', '数据范围止', report.dataRange.to === null ? 'null' : report.dataRange.to, '', '', '', '', '', '', '', ''])

  // completeness
  push(['completeness', 'overall', '整体完整性', STATE_LABELS[report.completeness.overall] ?? report.completeness.overall, report.completeness.overall, '', '', '', '', '', '', ''])
  for (const [blockId, state] of Object.entries(report.completeness.blocks)) {
    push(['completeness', blockId, BLOCK_LABELS[blockId] ?? blockId, STATE_LABELS[state] ?? state, state, '', '', '', '', '', '', ''])
  }

  // coverage：固定 metricKey 全集
  for (const [key, cov] of Object.entries(report.coverage)) {
    push([
      'coverage', key, '', STATE_LABELS[cov.status] ?? cov.status, cov.status, cov.source,
      (cov.reasonCodes ?? []).join('|'),
      cov.coverageRatio === undefined ? '' : cov.coverageRatio === null ? 'null' : String(cov.coverageRatio),
      cov.exactCoverage === undefined ? '' : String(cov.exactCoverage),
      '', '', ''
    ])
  }

  // metric + detail：A 组
  const summaryDefs: Array<[string, string, { value: number | null; state: string }, (v: number) => string]> = [
    ['summary.customerTotal', '客户总数', report.summary.customerTotal, fmtInt],
    ['summary.customerNew', '年度新增客户', report.summary.customerNew, fmtInt],
    ['summary.customerActive', '年度活跃客户', report.summary.customerActive, fmtInt],
    ['summary.contractCount', '年度签约合同数', report.summary.contractCount, fmtInt],
    ['summary.contractAmount', '年度签约合同金额', report.summary.contractAmount, fmtAmount],
    ['summary.creditedAmount', '年度已核销回款金额', report.summary.creditedAmount, fmtAmount],
    ['summary.shippedCount', '年度已发货合同数', report.summary.shippedCount, fmtInt],
    ['summary.shippedAmount', '年度已发货合同金额', report.summary.shippedAmount, fmtAmount],
    ['summary.dealingCustomers', '成交客户数', report.summary.dealingCustomers, fmtInt],
    ['summary.avgDealSize', '客单价', report.summary.avgDealSize, fmtAmount]
  ]
  for (const [key, label, metric, fmt] of summaryDefs) {
    push(['metric', key, label, metricText(metric, fmt), metric.state, '', '', '', '', '', '', ''])
  }

  // B 组：状态行 + 分布明细
  const funnelDefs: Array<[string, string, { distribution: Array<{ bucket: string; count: number }> | null; coverage: { status: string; source: string; reasonCodes?: string[] } }]> = [
    ['funnel.customerStage', '客户阶段分布', report.funnel.customerStage],
    ['funnel.opportunityStage', '商机阶段分布', report.funnel.opportunityStage]
  ]
  for (const [key, label, block] of funnelDefs) {
    push(['metric', key, label, block.coverage.status === 'unavailable' || block.distribution === null ? '不可用' : '见 detail', block.coverage.status, block.coverage.source, (block.coverage.reasonCodes ?? []).join('|'), '', '', '', '', ''])
    if (block.distribution !== null && block.coverage.status !== 'unavailable') {
      for (const row of block.distribution) push(['detail', key, `${label}·${row.bucket}`, fmtInt(row.count), '', '', '', '', '', '', '', ''])
    }
  }
  push(['metric', 'funnel.stageFlow', '年内阶段流转', '见 detail', report.funnel.stageFlow.coverage.status, report.funnel.stageFlow.coverage.source, (report.funnel.stageFlow.coverage.reasonCodes ?? []).join('|'), '', '', '', '', ''])
  for (const row of report.funnel.stageFlow.distribution) {
    push(['detail', 'funnel.stageFlow', `阶段流转·${row.bucket}`, fmtInt(row.count), '', '', '', '', '', '', '', ''])
  }
  push(['metric', 'funnel.stuck', '停滞客户', metricText({ value: report.funnel.stuck.value, state: report.funnel.stuck.coverage.status }, fmtInt), report.funnel.stuck.coverage.status, report.funnel.stuck.coverage.source, (report.funnel.stuck.coverage.reasonCodes ?? []).join('|'), '', '', '', '', ''])
  push(['metric', 'funnel.lostBreakdown', '流失归因', report.funnel.lostBreakdown.coverage.status === 'unavailable' || report.funnel.lostBreakdown.customerPreviousStage === null ? '不可用' : '见 detail', report.funnel.lostBreakdown.coverage.status, report.funnel.lostBreakdown.coverage.source, (report.funnel.lostBreakdown.coverage.reasonCodes ?? []).join('|'), '', '', '', '', ''])
  if (report.funnel.lostBreakdown.customerPreviousStage !== null && report.funnel.lostBreakdown.coverage.status !== 'unavailable') {
    for (const row of report.funnel.lostBreakdown.customerPreviousStage) {
      push(['detail', 'funnel.lostBreakdown', `流失前档位·${row.bucket}`, fmtInt(row.count), '', '', '', '', '', '', '', ''])
    }
    for (const row of report.funnel.lostBreakdown.opportunityReasons ?? []) {
      push(['detail', 'funnel.lostBreakdown', `商机流失原因·${row.reason}`, fmtInt(row.count), '', '', '', '', '', '', '', ''])
    }
  }

  // C 组：计数 + 明细
  const customerDefs: Array<[string, string, { value: unknown[] | null; coverage: { status: string; source: string; reasonCodes?: string[] } }]> = [
    ['customers.highValue', '高价值客户', report.customers.highValue],
    ['customers.newCustomers', '新增客户', report.customers.newCustomers],
    ['customers.dealing', '成交客户', report.customers.dealing],
    ['customers.repeat', '复购客户', report.customers.repeat],
    ['customers.active', '活跃客户', report.customers.active],
    ['customers.silent', '沉默客户', report.customers.silent],
    ['customers.risk', '流失风险客户', report.customers.risk],
    ['customers.priority', '当前重点推进客户', report.customers.priority]
  ]
  for (const [key, label, block] of customerDefs) {
    push(['metric', key, label, block.coverage.status === 'unavailable' || block.value === null ? '不可用' : fmtInt(block.value.length), block.coverage.status, block.coverage.source, (block.coverage.reasonCodes ?? []).join('|'), '', '', '', '', ''])
  }

  // D 组
  push(['metric', 'communication.volume', '年度客户消息量', metricText(report.communication.volume, fmtInt), report.communication.volume.state, 'wcdb.messages', (report.communication.volume.warnings.map((w) => w.code)).join('|'), '', '', '', '', ''])
  push(['metric', 'communication.contacted', '有沟通客户数', metricText(report.communication.contacted, fmtInt), report.communication.contacted.state, '', '', '', '', '', '', ''])
  push(['metric', 'communication.outboundRate', '主动联系率', metricText(report.communication.outboundRate, (v) => `${Math.round(v * 100)}%`), report.communication.outboundRate.state, '', '', '', '', '', '', ''])
  if (report.communication.monthlyTrend.months !== null) {
    for (const p of report.communication.monthlyTrend.months) {
      push(['detail', 'communication.monthlyTrend', `月度沟通·${p.month}`, fmtInt(p.count), '', '', '', '', '', '', '', ''])
    }
  }
  push(['metric', 'communication.longSilent', '长期未联系客户', report.communication.longSilent.value === null ? '不可用' : fmtInt(report.communication.longSilent.value.length), report.communication.longSilent.state, '', '', '', '', '', '', ''])

  // 月度趋势（三序列 detail）
  for (const p of report.monthly.contractSign.months ?? []) {
    push(['detail', 'monthly.contractSign', `签约金额·${p.month}`, fmtAmount(p.amount), report.monthly.contractSign.state, '', '', '', '', '', '', ''])
  }
  for (const p of report.monthly.credited.months ?? []) {
    push(['detail', 'monthly.credited', `核销回款·${p.month}`, fmtAmount(p.amount), report.monthly.credited.state, '', '', '', '', '', '', ''])
  }
  for (const p of report.monthly.messageVolume.months ?? []) {
    push(['detail', 'monthly.messageVolume', `客户消息量·${p.month}`, fmtInt(p.count), report.monthly.messageVolume.state, '', '', '', '', '', '', ''])
  }

  // E 组
  const e1State = report.salesAssignment.coverage.status
  push(['metric', 'salesAssignment.assignedFacts', '初始分配', fmtInt(report.salesAssignment.assignedFacts.initialAssignments.total), e1State, report.salesAssignment.coverage.source, (report.salesAssignment.coverage.reasonCodes ?? []).join('|'), report.salesAssignment.coverage.coverageRatio === undefined ? '' : report.salesAssignment.coverage.coverageRatio === null ? 'null' : String(report.salesAssignment.coverage.coverageRatio), report.salesAssignment.coverage.exactCoverage === undefined ? '' : String(report.salesAssignment.coverage.exactCoverage), '', '', ''])
  for (const g of report.salesAssignment.assignedFacts.initialAssignments.groups) {
    push(['detail', 'salesAssignment.assignedFacts', `初始分配·${g.salesName ?? '未署名'}${g.mode ? `/${g.mode}` : ''}`, fmtInt(g.count), '', '', '', '', '', '', '', ''])
  }
  push(['metric', 'salesAssignment.transfersIn', '移交转入', fmtInt(report.salesAssignment.assignedFacts.transfersIn.total), e1State, '', '', '', '', '', '', ''])
  for (const g of report.salesAssignment.assignedFacts.transfersIn.groups) {
    push(['detail', 'salesAssignment.transfersIn', `移交转入·${g.salesName ?? '未署名'}`, fmtInt(g.count), '', '', '', '', '', '', '', ''])
  }
  push(['metric', 'salesAssignment.transfersOut', '移交转出', fmtInt(report.salesAssignment.assignedFacts.transfersOut.total), e1State, '', '', '', '', '', '', ''])
  push(['metric', 'salesAssignment.effectiveFollowup', '有效跟进客户', metricText(report.salesAssignment.effectiveFollowup, fmtInt), report.salesAssignment.effectiveFollowup.state, '', '', '', '', '', '', ''])
  for (const row of report.salesAssignment.contractContribution.value ?? []) {
    push(['detail', 'salesAssignment.contractContribution', `合同贡献·${row.ownerSales ?? '未归属'}`, fmtAmount(row.totalAmount), report.salesAssignment.contractContribution.state, '', '', '', '', '', '', `${row.contractCount} 份`])
  }
  for (const row of report.salesAssignment.creditedContribution.value ?? []) {
    push(['detail', 'salesAssignment.creditedContribution', `核销回款贡献·${row.salesName ?? '未认领'}`, fmtAmount(row.totalAmount), report.salesAssignment.creditedContribution.state, '', '', '', '', '', '', ''])
  }
  if (report.salesAssignment.coverage.status === 'partial') {
    push(['note', 'salesAssignment.syncGap', 'sync 缺口', '检测到中枢下发的分配/移交记录；当前统计只覆盖本机审计事件，实际总量可能更高（不显示覆盖率）', '', '', '', '', '', '', '', ''])
  }

  // warning
  for (const w of report.warnings) {
    const count = w.counts && Object.values(w.counts).some((n) => n > 0) ? Math.max(...Object.values(w.counts)) : ''
    push(['warning', w.code, w.message, '', '', '', '', '', '', w.metricKeys.join('|'), count, ''])
  }

  // source
  for (const s of report.sourceSummary) {
    push(['source', s.source, s.tables.join(' / '), fmtInt(s.rows), '', '', '', '', '', '', '', s.note ?? ''])
  }

  // note：E8 三句 + 口径声明
  for (const sentence of E8_NOTES) {
    push(['note', 'e8', '分配统计说明', sentence, '', '', '', '', '', '', '', ''])
  }
  push(['note', 'perspective', '视角声明', '本报告为本机数据视角；「当前快照」为截至生成时间的投影，「历史年末重建」为事件流重放结果。', '', '', '', '', '', '', '', ''])
  push(['note', 'unavailable', '不可用语义', '「不可用」表示当前数据无法可靠统计（不显示为 0）；「部分完整」附有降级原因。', '', '', '', '', '', '', '', ''])
  push(['note', 'timezone', '统计口径', '本地时区；金额单位为元；历史年度联系时间类指标不可重建。', '', '', '', '', '', '', '', ''])

  return CSV_BOM + HEADER + '\r\n' + rows.join('\r\n') + '\r\n'
}
