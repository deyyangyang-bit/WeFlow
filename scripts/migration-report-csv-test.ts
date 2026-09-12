/**
 * migration-report-csv-test.ts —— 存量迁移报告 CSV 组装纯函数（src/components/settings/migrationReportCsv.ts）
 *
 * 覆盖（迁移报告 CSV 必须可独立留档）：
 *   1. 全成功：每个模块至少一行「汇总」，无失败冲突时报告不落空
 *   2. 两模块全成功：两条模块汇总行
 *   3. 幂等跳过（alreadyDone）与无动作（skipped）分列，skipped 非零不丢失
 *   4. 模块④ 专项计数（wonOppCreated/wonOppAlready/amountBackfilled/chainsNormalized/noQuoteContracts）全量导出
 *   5. 含失败/冲突：汇总行 + 明细行；汇总/失败/冲突行列数均等于表头列数
 *   6. 中文与双引号转义（RFC 4180）、含逗号字段不裂列、UTF-8 BOM 头
 * 运行：npx tsx scripts/migration-report-csv-test.ts
 */
import { buildMigrationCsv, buildMigrationCsvRows } from '../src/components/settings/migrationReportCsv'
import type { MigrationReportRow } from '../src/types/electron'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; console.log(`  ✅ ${name}`) } else { fail++; console.log(`  ❌ ${name} ${detail}`) }
}

/** 解析单行 CSV（RFC 4180：引号包裹 + 内部 " 翻倍），用于按列断言 */
function parseCsvLine(line: string): string[] {
  const fields: string[] = []
  let cur = '', inQ = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++ } else inQ = false
      } else cur += c
    } else if (c === '"') inQ = true
    else if (c === ',') { fields.push(cur); cur = '' }
    else cur += c
  }
  fields.push(cur)
  return fields
}

// 列索引（21 列）：0 类型 / 1 模块 / 2 总数 / 3 成功 / 4 幂等跳过 / 5 无动作 / 6 失败 / 7 冲突 /
// 8 新建客户 / 9 新建身份 / 10 挂接客户 / 11 进入线索池 / 12 新建赢单商机 / 13 已有赢单商机 /
// 14 金额回填 / 15 版本链规范化 / 16 无报价合同 / 17 对象 / 18 原因 / 19 明细 / 20 报告时间
const COL = { type: 0, module: 1, total: 2, applied: 3, alreadyDone: 4, skipped: 5, failed: 6, conflicts: 7, customersCreated: 8, identitiesCreated: 9, linkedToCustomer: 10, pooled: 11, wonOppCreated: 12, wonOppAlready: 13, amountBackfilled: 14, chainsNormalized: 15, noQuoteContracts: 16, key: 17, reason: 18, detail: 19, time: 20 } as const
const HEADER_COLS = 21

const report = (over: Partial<MigrationReportRow> = {}): MigrationReportRow => ({
  module: '02-account-to-customer',
  title: 'account → customer 归并',
  summary: { total: 10, applied: 10, alreadyDone: 0, skipped: 0, failed: 0, conflicts: 0, customersCreated: 7, identitiesCreated: 0, linkedToCustomer: 0, pooled: 0 },
  failures: [],
  conflicts: [],
  ranAt: 1757373600000,
  ...over
})

function main(): void {
  // 1. 表头明确区分「幂等跳过」与「无动作」两列
  const headRows = buildMigrationCsvRows([])
  ok('1 表头区分「幂等跳过」「无动作」两列', headRows[0].includes('幂等跳过') && headRows[0].includes('无动作') &&
    parseCsvLine(headRows[0]).length === HEADER_COLS, headRows[0])

  // 2-4. 全成功：表头 + 一条汇总行（计数齐全，对象/原因/明细为空，报告时间在列）
  const allOk = buildMigrationCsvRows([{ moduleLabel: '模块② account → customer 归并', time: '2026-09-09 10:00', report: report() }])
  ok('2 全成功：表头 + 1 条汇总行（无明细行，报告不落空）', allOk.length === 2, `rows=${allOk.length}`)
  const sumFields = parseCsvLine(allOk[1])
  ok('3 汇总行写全部计数（总数/成功/幂等跳过/无动作/失败/冲突/新建客户…）',
    sumFields[COL.type] === '汇总' && sumFields[COL.total] === '10' && sumFields[COL.applied] === '10' &&
    sumFields[COL.alreadyDone] === '0' && sumFields[COL.skipped] === '0' && sumFields[COL.failed] === '0' &&
    sumFields[COL.conflicts] === '0' && sumFields[COL.customersCreated] === '7' &&
    sumFields[COL.wonOppCreated] === '0' && sumFields[COL.noQuoteContracts] === '0', allOk[1])
  ok('4 汇总行对象/原因/明细为空、保留报告时间',
    sumFields[COL.key] === '' && sumFields[COL.reason] === '' && sumFields[COL.detail] === '' && sumFields[COL.time] === '2026-09-09 10:00', allOk[1])

  // 5-6. 两模块全成功：两条模块汇总行
  const twoModules = buildMigrationCsvRows([
    { moduleLabel: '模块②', time: 't1', report: report() },
    {
      moduleLabel: '模块③ lead → identity 建档', time: 't2',
      report: report({
        module: '03-lead-to-identity',
        title: 'lead → identity 建档',
        summary: { total: 5, applied: 3, alreadyDone: 2, skipped: 0, failed: 0, conflicts: 0, identitiesCreated: 3, linkedToCustomer: 2, pooled: 1 }
      })
    }
  ])
  ok('5 两模块全成功：表头 + 2 条模块汇总行', twoModules.length === 3 && twoModules[1].includes('模块②') && twoModules[2].includes('模块③'))
  const m3 = parseCsvLine(twoModules[2])
  ok('6 模块③ 汇总含 m03 计数（新建身份/挂接客户/进入线索池）',
    m3[COL.identitiesCreated] === '3' && m3[COL.linkedToCustomer] === '2' && m3[COL.pooled] === '1', twoModules[2])

  // 7-8. 幂等跳过与无动作分列：alreadyDone/skipped 进入不同列，skipped 非零不丢失
  const skippedRows = buildMigrationCsvRows([{
    moduleLabel: '模块④', time: 't4',
    report: report({
      module: '04-history-deal-opportunity',
      title: '历史成交 → won 商机 + 报价首版本',
      summary: { total: 20, applied: 9, alreadyDone: 2, skipped: 6, failed: 2, conflicts: 1 }
    })
  }])
  const sk = parseCsvLine(skippedRows[1])
  ok('7 alreadyDone 与 skipped 分别进入不同列', sk[COL.alreadyDone] === '2' && sk[COL.skipped] === '6' && COL.alreadyDone !== COL.skipped, skippedRows[1])
  ok('8 skipped 非零时不丢失（汇总行无动作列=6）', sk[COL.skipped] === '6' && sk[COL.skipped] !== '0', skippedRows[1])

  // 9. 模块④ 专项计数全部导出
  const m4Rows = buildMigrationCsvRows([{
    moduleLabel: '模块④ 历史成交 → won 商机 + 报价首版本', time: 't4',
    report: report({
      module: '04-history-deal-opportunity',
      title: '历史成交 → won 商机 + 报价首版本',
      summary: {
        total: 20, applied: 9, alreadyDone: 2, skipped: 6, failed: 2, conflicts: 1,
        wonOppCreated: 4, wonOppAlready: 3, amountBackfilled: 5, chainsNormalized: 7, noQuoteContracts: 8
      }
    })
  }])
  const m4 = parseCsvLine(m4Rows[1])
  ok('9 模块④ 专项计数全量导出（新建赢单/已有赢单/金额回填/版本链规范化/无报价合同）',
    m4[COL.wonOppCreated] === '4' && m4[COL.wonOppAlready] === '3' && m4[COL.amountBackfilled] === '5' &&
    m4[COL.chainsNormalized] === '7' && m4[COL.noQuoteContracts] === '8', m4Rows[1])

  // 10-12. 含失败：汇总行 + 失败明细行，两类行列数均等于表头
  const withFail = buildMigrationCsvRows([{
    moduleLabel: '模块②', time: 't1',
    report: report({
      summary: { total: 10, applied: 9, alreadyDone: 0, skipped: 0, failed: 1, conflicts: 0 },
      failures: [{ key: 'account:12', reason: '无可用身份锚点', detail: "name='甲' phone='138'" }]
    })
  }])
  const failFields = parseCsvLine(withFail[2])
  ok('10 含失败：表头 + 汇总行 + 失败明细行', withFail.length === 3, `rows=${withFail.length}`)
  ok('11 失败行写类型/对象/原因/明细，汇总行计数仍在',
    failFields[COL.type] === '失败' && failFields[COL.key] === 'account:12' &&
    failFields[COL.reason] === '无可用身份锚点' && parseCsvLine(withFail[1])[COL.type] === '汇总', withFail[2])
  ok('12 失败明细行列数 = 表头列数', failFields.length === HEADER_COLS && parseCsvLine(withFail[0]).length === HEADER_COLS,
    `fail=${failFields.length} header=${parseCsvLine(withFail[0]).length}`)

  // 13-14. 含冲突：冲突明细行，列数等于表头
  const withConflict = buildMigrationCsvRows([{
    moduleLabel: '模块③', time: 't2',
    report: report({
      summary: { total: 5, applied: 4, alreadyDone: 0, skipped: 0, failed: 0, conflicts: 1 },
      conflicts: [{ key: 'phone:13800000000', reason: '归并组内名字不一致', detail: 'names=[甲/乙] accountIds=[1,2]' }]
    })
  }])
  const conflictFields = parseCsvLine(withConflict[2])
  ok('13 含冲突：汇总行 + 冲突明细行（类型=冲突、对象/原因在列）',
    withConflict.length === 3 && conflictFields[COL.type] === '冲突' && conflictFields[COL.key] === 'phone:13800000000', withConflict[2])
  ok('14 汇总/失败/冲突行列数均 = 表头列数',
    conflictFields.length === HEADER_COLS && parseCsvLine(withConflict[1]).length === HEADER_COLS &&
    parseCsvLine(withConflict[0]).length === HEADER_COLS, `conflict=${conflictFields.length}`)

  // 15-17. 中文与双引号转义 + BOM
  const quoted = buildMigrationCsv([{
    moduleLabel: '模块"引号"测试', time: 't9',
    report: report({ failures: [{ key: 'k1', reason: '客户说"停机"了', detail: '含,逗号' }] })
  }])
  ok('15 UTF-8 BOM 头（Excel 中文不乱码）', quoted.charCodeAt(0) === 0xFEFF)
  ok('16 双引号翻倍转义（RFC 4180）', quoted.includes('"模块""引号""测试"') && quoted.includes('"客户说""停机""了"'))
  ok('17 含逗号字段被引号包裹不裂列', quoted.includes('"含,逗号"') && parseCsvLine(quoted.split('\n')[2]).length === HEADER_COLS)

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail > 0 ? 1 : 0)
}

main()
