/**
 * migrationReportCsv.ts —— 存量迁移报告 CSV 组装（纯函数，无 IO，可测试）
 *
 * 数据源：migration_report SSOT（crm:migration:report:list → MigrationReportRow）。
 * 行结构：每个模块至少一行「汇总」（全成功时报告也不落空），失败/冲突逐条追加明细行。
 * 列（21 列）：类型、模块、总数、成功、幂等跳过、无动作、失败、冲突、新建客户、新建身份、
 *              挂接客户、进入线索池、新建赢单商机、已有赢单商机、金额回填、版本链规范化、
 *              无报价合同、对象、原因、明细、报告时间。
 * 「幂等跳过」= alreadyDone（已有/已挂接），「无动作」= skipped（规则无动作），两列分开不合并。
 * 转义：RFC 4180 标准双引号包裹 + 内部双引号翻倍；BOM 由 buildMigrationCsv 写入（Excel 中文不乱码）。
 */
import type { MigrationReportIssue, MigrationReportRow } from '../../types/electron'

export interface MigrationCsvReport {
  /** 模块展示名（如「模块② account → customer 归并」） */
  moduleLabel: string
  /** 报告时间（migration_report 快照 ranAt 的格式化时间） */
  time: string
  /** migration_report 快照（crm:migration:report:list 解析出的迁移报告行，SSOT） */
  report: MigrationReportRow
}

const CSV_HEADER = '类型,模块,总数,成功,幂等跳过,无动作,失败,冲突,新建客户,新建身份,挂接客户,进入线索池,新建赢单商机,已有赢单商机,金额回填,版本链规范化,无报价合同,对象,原因,明细,报告时间'

/** RFC 4180 字段转义：双引号包裹 + 内部 " 翻倍 */
function csvEsc(value: unknown): string {
  return `"${String(value ?? '').replace(/"/g, '""')}"`
}

/** 组装 CSV 行（首行为表头）；不含 BOM，BOM 由 buildMigrationCsv 统一写 */
export function buildMigrationCsvRows(reports: MigrationCsvReport[]): string[] {
  const lines: string[] = [CSV_HEADER]
  for (const { moduleLabel, time, report } of reports) {
    const s = report.summary
    const counts = [
      s.total, s.applied, s.alreadyDone, s.skipped, s.failed, s.conflicts,
      s.customersCreated, s.identitiesCreated, s.linkedToCustomer, s.pooled,
      s.wonOppCreated, s.wonOppAlready, s.amountBackfilled, s.chainsNormalized, s.noQuoteContracts
    ].map((n) => String(Number(n) || 0))
    // 汇总行：全部计数入行，对象/原因/明细留空——没有失败或冲突时报告至少有这一行
    lines.push([csvEsc('汇总'), csvEsc(moduleLabel), ...counts, csvEsc(''), csvEsc(''), csvEsc(''), csvEsc(time)].join(','))
    const issueLine = (type: string, iss: MigrationReportIssue): string =>
      [csvEsc(type), csvEsc(moduleLabel), ...counts.map(() => ''), csvEsc(iss.key), csvEsc(iss.reason), csvEsc(iss.detail || ''), csvEsc(time)].join(',')
    for (const iss of report.failures || []) lines.push(issueLine('失败', iss))
    for (const iss of report.conflicts || []) lines.push(issueLine('冲突', iss))
  }
  return lines
}

/** 完整 CSV 文件内容（UTF-8 BOM 头） */
export function buildMigrationCsv(reports: MigrationCsvReport[]): string {
  return '\uFEFF' + buildMigrationCsvRows(reports).join('\n')
}
