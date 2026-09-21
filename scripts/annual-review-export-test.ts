/**
 * annual-review-export-test.ts —— 年度经营复盘 S6 护栏（安全文本导出）
 *
 * 覆盖：唯一生产导出函数 exportTextFile（真实 fs，tmpdir）——合法 Markdown/CSV、
 *       未授权目录、路径穿越/绝对路径/NUL/冒号/保留名/尾部点空格、symlink、已存在文件、
 *       大小上限、失败不残留半文件；内容渲染——CSV 公式注入、Markdown HTML 字段、
 *       unavailable 文案、敏感字段不出现；IPC/preload/types/页面接线（源码守卫）。
 * 运行：npx tsx scripts/annual-review-export-test.ts
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { exportTextFile, sanitizeLeafName } from '../electron/services/safeTextFileExport'
import { buildAnnualReviewCsv, buildAnnualReviewMarkdown, escapeCsvCell, escapeMarkdownText, E8_NOTES, CSV_BOM } from '../electron/services/annualReviewExportContent'
import { composeAnnualReviewReport, validateAnnualReviewReport } from '../electron/services/annualReviewReport'
import { resolveAnnualReviewPeriod, type AnnualReviewFacts } from '../electron/services/annualReviewStats'
import type { AnnualReviewSalesSegmentsFacts, AnnualReviewCrmSegmentsFacts } from '../electron/services/annualReviewSegments'

let pass = 0, fail = 0
function ok(name: string, cond: boolean): void {
  if (cond) { pass++ } else { fail++; console.error('FAIL:', name) }
}
const T = (y: number, m: number, d: number, hh = 0, mm = 0, ss = 0, ms = 0): number =>
  new Date(y, m - 1, d, hh, mm, ss, ms).getTime()
const GEN = T(2026, 6, 15, 12, 0, 0)

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 授权通过目录下的临时工作区 */
function makeWorkdir(): string {
  return mkdtempSync(join(tmpdir(), 'ar-export-'))
}
const allowAll = (): void => { /* 全授权（内容/写路径测试用） */ }

function buildReport(): ReturnType<typeof composeAnnualReviewReport> {
  const facts: AnnualReviewFacts = {
    accounts: [
      { id: 1, name: '客户<script>alert(1)</script>', createdAt: T(2025, 2, 1), importedAt: T(2025, 2, 1), sessionId: 'wx_a', lastContactAtSec: Math.floor(T(2025, 10, 1) / 1000) },
      { id: 2, name: '客户,二"号', createdAt: T(2025, 3, 1), importedAt: null, sessionId: 'wx_b', lastContactAtSec: null }
    ],
    contracts: [
      { id: 1, accountId: 1, amount: 1200, status: 'signed', signDate: T(2025, 3, 1), createdAt: T(2024, 1, 1), ownerSales: '=张三' },
      { id: 2, accountId: 2, amount: 500, status: 'signed', signDate: T(2025, 6, 1), createdAt: T(2024, 1, 1), ownerSales: null }
    ],
    allocations: [
      { id: 1, accountId: 1, creditedAmount: 800.5, reconciledAt: T(2025, 4, 1), status: 'confirmed', reconciliationStatus: 'allocated', confirmedAt: null, contractId: 1, salesName: '@李四' }
    ],
    shippedEvents: [{ id: 1, contractId: 1, toStatus: 'shipped', createdAt: T(2025, 5, 1) }],
    auditEvents: [
      { id: 1, action: 'lead_assign', createdAt: T(2025, 2, 10), detailType: null, salesName: '张三', toSales: null, fromSales: null, mode: 'manual', assignmentId: 9 },
      { id: 2, action: 'sync_apply', createdAt: T(2025, 2, 20), detailType: 'assign', salesName: null, toSales: null, fromSales: null, mode: null, assignmentId: null }
    ],
    assignments: [{ id: 1, leadId: 1, salesName: '张三', mode: 'manual', claimedAt: T(2025, 3, 2) }],
    leads: [{ id: 1, accountId: 1, firstContactedAt: T(2025, 3, 3) }]
  }
  const sales: AnnualReviewSalesSegmentsFacts = {
    profiles: [{ id: 1, sessionId: 'wx_a', stage: 'quoted', lastContactAtSec: Math.floor(T(2025, 1, 5) / 1000), customerId: '501' }],
    intentEvents: [
      { id: 1, sessionId: 'wx_a', stage: 'quoted', createdAt: T(2025, 3, 1) },
      { id: 2, sessionId: 'wx_a', stage: 'lost', createdAt: T(2025, 8, 1) },
      { id: 3, sessionId: 'wx_b', stage: 'contacted', createdAt: T(2025, 4, 1) },
      { id: 4, sessionId: 'wx_b', stage: 'won', createdAt: T(2025, 9, 1) }
    ]
  }
  const crm: AnnualReviewCrmSegmentsFacts = { opportunities: [], opportunityEvents: [] }
  const report = composeAnnualReviewReport({
    period: resolveAnnualReviewPeriod(2025, GEN), facts, sales, crm,
    opts: { messageStats: { ok: true, sessions: { wx_a: { sent: 5, received: 2 } }, daily: { '2025-02-01': 7 } } }
  })
  if (!validateAnnualReviewReport(report, 2025).ok) throw new Error('fixture report invalid')
  return report
}

async function main(): Promise<void> {
  // ══ 1 叶子名策略 ═══════════════════════════════════════════════════════════
  {
    ok('1 合法叶子名通过', sanitizeLeafName('年度经营复盘-2025.md') === '年度经营复盘-2025.md' &&
      sanitizeLeafName('report.v2.csv') === 'report.v2.csv')
    const bads = ['../evil.md', '/abs/path.md', 'a\\b.md', 'with:colon.md', 'trail.md ', 'trail.md.', '..md',
      'CON.md', 'com1', 'nul.csv', '', 'x'.repeat(201), 'a\u0000b.md', '  ']
    let rejected = 0
    for (const b of bads) if (sanitizeLeafName(b) === null) rejected++
    ok(`1b 非法叶子名全拒绝（${rejected}/${bads.length}）`, rejected === bads.length)
  }

  // ══ 2 独占写/已存在/未授权/大小上限/清理/完整写循环 ════════════════════════
  {
    const dir = makeWorkdir()
    const r1 = exportTextFile({ dir, fileName: 'report.md', content: '# 内容\n第一版' }, { assertAllowed: allowAll })
    const st1 = r1.ok === true ? statSync((r1 as { path: string }).path) : null
    ok('2 合法导出成功且权限 0600', r1.ok === true && st1 !== null && (st1.mode & 0o777) === 0o600)

    const r2 = exportTextFile({ dir, fileName: 'report.md', content: '# 覆盖尝试' }, { assertAllowed: allowAll })
    ok('2b 已存在文件拒绝覆盖且内容不变', r2.ok === false && (r2 as { code: string }).code === 'exists' &&
      readFileSync(join(dir, 'report.md'), 'utf8') === '# 内容\n第一版')

    const r3 = exportTextFile({ dir, fileName: 'evil.md', content: 'x' }, { assertAllowed: () => { throw new Error('导出路径未经过本会话授权') } })
    ok('2c 未授权目录拒绝', r3.ok === false && (r3 as { code: string }).code === 'unauthorized' &&
      !existsSync(join(dir, 'evil.md')))

    const big = 'x'.repeat(1000)
    const r4 = exportTextFile({ dir, fileName: 'big.md', content: big, maxSizeBytes: 100 }, { assertAllowed: allowAll })
    ok('2d 超过大小上限拒绝（不落盘）', r4.ok === false && (r4 as { code: string }).code === 'too_large' && !existsSync(join(dir, 'big.md')))

    // symlink 目标：已存在的符号链接 → 拒绝
    const outside = makeWorkdir()
    writeFileSync(join(outside, 'real.md'), 'real')
    try { symlinkSync(join(outside, 'real.md'), join(dir, 'link.md')) } catch { /* 平台不支持则跳过 */ }
    if (existsSync(join(dir, 'link.md'))) {
      const r5 = exportTextFile({ dir, fileName: 'link.md', content: 'overwrite?' }, { assertAllowed: allowAll })
      ok('2e symlink 目标拒绝且原链接内容不变', r5.ok === false &&
        readFileSync(join(outside, 'real.md'), 'utf8') === 'real')
    } else {
      ok('2e symlink 目标拒绝（平台不支持 symlink，跳过）', true)
    }

    const traversal = exportTextFile({ dir, fileName: '../escape.md', content: 'x' }, { assertAllowed: allowAll })
    ok('2f 路径穿越文件名拒绝', traversal.ok === false && (traversal as { code: string }).code === 'invalid_leaf_name' &&
      !existsSync(join(dir, '..', 'escape.md')))

    const roDir = makeWorkdir()
    writeFileSync(join(roDir, 'keep.txt'), 'keep')
    let cleaned = true
    try {
      const r6 = exportTextFile({ dir: join(roDir, 'missing-sub'), fileName: 'x.md', content: 'x' }, { assertAllowed: allowAll })
      cleaned = r6.ok === false && (r6 as { code: string }).code === 'write_failed'
    } catch {
      cleaned = false
    }
    ok('2g 目录不存在 → write_failed（不抛错、不残留）', cleaned)

    // 2h 完整写循环：注入「每次只写 1 字节」的 write（模拟部分写）→ 循环写满全部字节
    const partialDir = makeWorkdir()
    const content = 'x'.repeat(50)
    const contentBuf = Buffer.from(content, 'utf8')
    const simBuf = Buffer.alloc(contentBuf.length)
    let simPos = 0
    const r7 = exportTextFile(
      { dir: partialDir, fileName: 'partial.bin', content },
      {
        assertAllowed: allowAll,
        write: (fd, buf, offset, length) => {
          if (simPos >= simBuf.length) return 0
          simBuf[offset] = buf[offset] // 每次只落地 1 字节（部分写）
          simPos++
          void fd; void length
          return 1
        },
        fstat: () => ({ size: simPos })
      }
    )
    ok('2h 部分写循环写满全部字节', r7.ok === true && (r7 as { bytes: number }).bytes === contentBuf.length &&
      simBuf.equals(contentBuf))

    // 2i 写后字节数核验：fstat 返回错误 size → 失败并清理（不残留半文件）
    const mismatchDir = makeWorkdir()
    const r8 = exportTextFile(
      { dir: mismatchDir, fileName: 'mismatch.bin', content: 'hello' },
      { assertAllowed: allowAll, fstat: () => ({ size: 3 }) }
    )
    ok('2i 落盘字节数≠预期 → 失败并清理', r8.ok === false && (r8 as { code: string }).code === 'write_failed' &&
      !existsSync(join(mismatchDir, 'mismatch.bin')))

    // ── 2j–2q 短写循环 fail closed：异常适配器返回值一律拒绝，绝不报告成功、不残留 ──
    // fstatSize 由用例决定：可模拟「适配器返回值异常 + fstat 恰好相符」——旧实现只拒绝
    // n<=0，会把 0.5 或超过 remaining 的返回值当成功并报告 ok:true
    const abnormalCase = (
      label: string,
      name: string,
      content: string,
      writeImpl: (offset: number, length: number, totalBytes: number) => number,
      fstatSize: (totalBytes: number) => number
    ): void => {
      const d = makeWorkdir()
      const totalBytes = Buffer.byteLength(content, 'utf8')
      const r = exportTextFile({ dir: d, fileName: name, content }, {
        assertAllowed: allowAll,
        write: (_fd, _buf, offset, length) => writeImpl(offset, length, totalBytes),
        fstat: () => ({ size: fstatSize(totalBytes) })
      })
      ok(label, r.ok === false && (r as { code: string }).code === 'write_failed' && !existsSync(join(d, name)))
      rmSync(d, { recursive: true, force: true })
    }
    abnormalCase('2j 单次写入返回 0 → fail closed 且不残留', 'zero.bin', 'hello', () => 0, () => 0)
    abnormalCase('2k 单次写入返回负数 → fail closed 且不残留', 'neg.bin', 'hello', () => -1, () => 0)
    abnormalCase('2l 单次写入返回小数（旧实现会当成功）→ fail closed 且不残留', 'frac.bin', 'hello',
      () => 0.5, (total) => total)
    abnormalCase('2m 单次写入返回 NaN → fail closed 且不残留', 'nan.bin', 'hello', () => Number.NaN, () => 0)
    abnormalCase('2n 单次写入返回 Infinity → fail closed 且不残留', 'inf.bin', 'hello', () => Number.POSITIVE_INFINITY, () => 0)
    abnormalCase('2o 单次写入返回 > 本次剩余字节（旧实现会当成功）→ fail closed 且不残留', 'over.bin', 'hello',
      (_offset, length) => length + 1, (total) => total)

    // 2p 正常路径不受影响：真实 fs.writeSync 一次写完，字节数精确、内容完整
    const okDir = makeWorkdir()
    const okContent = '年度经营复盘导出'
    const rOk = exportTextFile({ dir: okDir, fileName: 'normal.md', content: okContent }, { assertAllowed: allowAll })
    ok('2p 正常一次写完（真实 writeSync 路径）', rOk.ok === true &&
      (rOk as { bytes: number }).bytes === Buffer.byteLength(okContent, 'utf8') &&
      readFileSync(join(okDir, 'normal.md'), 'utf8') === okContent)
    rmSync(okDir, { recursive: true, force: true })

    // 2q offset 只按合法写入字节数推进（多次短写：0,3,6,9）
    const stepDir = makeWorkdir()
    const stepContent = 'abcdefghij'
    const stepTotal = Buffer.byteLength(stepContent, 'utf8')
    const offsets: number[] = []
    const stepWritten = Buffer.alloc(stepTotal)
    const rStep = exportTextFile({ dir: stepDir, fileName: 'step.bin', content: stepContent }, {
      assertAllowed: allowAll,
      write: (_fd, buf, offset, length) => {
        offsets.push(offset)
        const n = Math.min(3, length)
        buf.copy(stepWritten, offset, offset, offset + n)
        return n
      },
      fstat: () => ({ size: stepTotal })
    })
    ok('2q 多次短写：offset 只按合法字节数推进且内容完整', rStep.ok === true &&
      offsets.join(',') === '0,3,6,9' && stepWritten.equals(Buffer.from(stepContent, 'utf8')))
    rmSync(stepDir, { recursive: true, force: true })

    rmSync(dir, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
    rmSync(roDir, { recursive: true, force: true })
    rmSync(partialDir, { recursive: true, force: true })
    rmSync(mismatchDir, { recursive: true, force: true })
  }

  // ══ 3 Markdown/CSV 完整契约（解析实际输出） ═══════════════════════════════
  {
    const report = buildReport()
    const md = buildAnnualReviewMarkdown(report)
    const csv = buildAnnualReviewCsv(report)

    // CSV 结构解析
    const lines = csv.replace(CSV_BOM, '').split('\r\n').filter((l) => l !== '')
    const header = lines[0]
    ok('3 CSV BOM + 12 列表头', csv.startsWith(CSV_BOM) &&
      header === 'rowType,key,label,value,state,source,reasonCodes,coverageRatio,exactCoverage,metricKeys,count,note')
    const parsed = lines.slice(1).map((line) => {
      // 简易 CSV 行解析（支持引号包裹与 "" 转义）
      const cells: string[] = []
      let cur = ''
      let inQuotes = false
      for (let i = 0; i < line.length; i++) {
        const ch = line[i]
        if (inQuotes) {
          if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++ }
          else if (ch === '"') inQuotes = false
          else cur += ch
        } else if (ch === '"') {
          inQuotes = true
        } else if (ch === ',') {
          cells.push(cur); cur = ''
        } else cur += ch
      }
      cells.push(cur)
      return cells
    })
    const byType = (t: string): string[][] => parsed.filter((r) => r[0] === t)
    const findRow = (type: string, key: string): string[] | undefined => byType(type).find((r) => r[1] === key)

    // metadata
    ok('3a CSV 元数据行齐全且正确', findRow('metadata', 'reportSchemaVersion')?.[3] === '2' &&
      findRow('metadata', 'year')?.[3] === '2025' && findRow('metadata', 'scopeKind')?.[3] === 'historical_year' &&
      findRow('metadata', 'asOf')?.[3] === String(report.asOf) && findRow('metadata', 'generatedAt')?.[3] === String(report.generatedAt) &&
      findRow('metadata', 'dataRangeFrom') !== undefined && findRow('metadata', 'dataRangeTo') !== undefined)

    // completeness
    ok('3b CSV completeness（overall + 6 区块）', byType('completeness').length === 7 &&
      findRow('completeness', 'overall')?.[3] === '不可用')

    // coverage：固定 metricKey 全集
    const csvCoverageKeys = byType('coverage').map((r) => r[1]).sort()
    const expectedCoverageKeys = Object.keys(report.coverage).sort()
    ok('3c CSV coverage 行 = 固定 metricKey 全集（35）', csvCoverageKeys.length === 35 &&
      JSON.stringify(csvCoverageKeys) === JSON.stringify(expectedCoverageKeys))
    ok('3d coverage 行携带状态与 source', byType('coverage').every((r) => r[4] !== '' && r[5] !== ''))
    const assignedCoverageRow = findRow('coverage', 'salesAssignment.assignedFacts')
    ok('3e E1 sync 缺口 coverage：partial + exactCoverage=false + ratio=null', assignedCoverageRow?.[4] === 'partial' &&
      assignedCoverageRow?.[8] === 'false' && assignedCoverageRow?.[7] === 'null')

    // metric：unavailable 不为 0
    const metricRows = byType('metric')
    ok('3f 全部 metric 行值不为伪装 0（unavailable → 不可用）', metricRows.every((r) => !(r[4] === 'unavailable' && r[3] === '0')))
    ok('3g A 组指标值正确', findRow('metric', 'summary.customerTotal')?.[3] === '2')

    // detail：漏斗分布/流失归因/三个月度序列/E1 分组
    ok('3h 流失归因 detail 存在', byType('detail').some((r) => r[2].startsWith('流失前档位·')))
    ok('3i 三个月度序列 detail 存在', byType('detail').some((r) => r[2].startsWith('签约金额·')) &&
      byType('detail').some((r) => r[2].startsWith('核销回款·')) && byType('detail').some((r) => r[2].startsWith('客户消息量·')))
    ok('3j E1 分组 detail 存在（初始分配·张三/manual）', byType('detail').some((r) => r[2] === '初始分配·张三/manual'))

    // warning：code/message/metricKeys/count
    const warningRows = byType('warning')
    ok('3k warning 行携带 metricKeys', warningRows.every((r) => r[9] !== ''))

    // source
    ok('3l source 行 4 组', byType('source').length === 4)

    // note：E8 三句
    const notes = byType('note').map((r) => r[3])
    ok('3m E8 三句固定说明存在', E8_NOTES.every((sentence) => notes.some((n) => n === sentence)))

    // 注入防护：全部单元格不以公式字符开头（允许 ' 前缀转义与引号包裹）
    ok('3n CSV 单元格无未转义公式前导', parsed.every((cells) => cells.every((c) => c === '' || c.startsWith("'") || !/^[=+@\t]/.test(c))))

    // Markdown：元数据/完整性/coverage 附表/E8/月度/流失归因
    ok('3o Markdown 元数据（schemaVersion/asOf/dataRange/整体完整性）', md.includes('reportSchemaVersion：2') &&
      md.includes('asOf：') && md.includes('dataRange：') && md.includes('整体完整性：'))
    ok('3p Markdown coverage 附表 = 固定 metricKey 全集', (() => {
      const table = md.slice(md.indexOf('## 指标覆盖（coverage）'))
      const keys = Object.keys(report.coverage)
      return keys.every((k) => table.includes(`| ${k} |`))
    })())
    ok('3q Markdown E8 三句 + 月度趋势 + 流失归因', E8_NOTES.every((s) => md.includes(s)) &&
      md.includes('## 月度趋势') && md.includes('流失归因'))
    ok('3r Markdown unavailable 不写 0', md.includes('不可用') && !md.includes('| 客单价 | ¥0') && !md.includes('| 客单价 | 0'))

    // 敏感字段
    ok('3s CSV/Markdown 无 sessionId/wxid/路径/SQL/Token', !csv.includes('wx_a') && !csv.includes('sessionId') &&
      !csv.includes('.db') && !csv.includes('SELECT') && !md.includes('wx_a') && !md.includes('sessionId') &&
      !md.includes('/Users/') && !md.includes('.db'))

    // Markdown 与 CSV 的 metricKey 集合一致
    const mdCoverageKeys = (() => {
      const table = md.slice(md.indexOf('## 指标覆盖（coverage）'))
      return Object.keys(report.coverage).filter((k) => table.includes(`| ${k} |`)).sort()
    })()
    ok('3t Markdown 与 CSV metricKey 集合一致', JSON.stringify(mdCoverageKeys) === JSON.stringify(csvCoverageKeys))

    // 转义函数单元：前导空白 + tab/CR + 引号换行
    ok('3u escapeCsvCell 单元（前导空白公式/tab/引号/换行）', escapeCsvCell(' =x') === "' =x" &&
      escapeCsvCell('\t=x') === "'\t=x" && escapeCsvCell('a\nb') === '"a\nb"' &&
      escapeCsvCell('a"b') === '"a""b"' && escapeCsvCell('普通') === '普通')

    // Markdown 转义
    ok('3v escapeMarkdownText 单元', escapeMarkdownText('<b>&') === '&lt;b&gt;&amp;')
  }

  // ══ 4 接线守卫（IPC/preload/types/页面） ═══════════════════════════════════
  {
    const mainSrc = readFileSync(join(ROOT, 'electron', 'main.ts'), 'utf8')
    const preloadSrc = readFileSync(join(ROOT, 'electron', 'preload.ts'), 'utf8')
    const dtsSrc = readFileSync(join(ROOT, 'src', 'types', 'electron.d.ts'), 'utf8')
    const pageSrc = readFileSync(join(ROOT, 'src', 'pages', 'AnnualReviewPage.tsx'), 'utf8')
    const executorSrc = readFileSync(join(ROOT, 'electron', 'services', 'safeTextFileExport.ts'), 'utf8')

    ok("4 main 注册 annualReview:export", mainSrc.includes("'annualReview:export'"))
    // 4b 只在 annualReview:export 这一个 handler 范围内检查：导出必须走唯一执行器 + 授权单例，
    // 且该范围内不得出现第二套写盘/PNG 校验实现（边界不依赖其它 handler 的存在——S8 下线旧链路后
    // 原先用作右界的旧 IPC 名已不存在，改为按 handler 自身定位）。
    const exportHandlerStart = mainSrc.indexOf("ipcMain.handle('annualReview:export'")
    const exportHandlerEnd = mainSrc.indexOf('ipcMain.handle(', exportHandlerStart + 10)
    const exportHandlerSrc = (exportHandlerStart >= 0 && exportHandlerEnd > exportHandlerStart)
      ? mainSrc.slice(exportHandlerStart, exportHandlerEnd)
      : ''
    ok('4b main 导出走唯一执行器 + 授权单例', exportHandlerSrc.length > 0 &&
      exportHandlerSrc.includes('exportTextFile({ dir, fileName, content })') &&
      exportHandlerSrc.includes('exportPathAuthorizer.grant(dir') &&
      !/exportAnnualReportImages|validateAnnualReportExportPayload/.test(exportHandlerSrc))
    ok('4c preload/d.ts 暴露 export', preloadSrc.includes("invoke('annualReview:export', { year, format })") &&
      dtsSrc.includes("export: (year: number, format: 'markdown' | 'csv')"))
    ok('4d 页面经安全 IPC 触发导出（目录授权在主进程对话框）', pageSrc.includes("annualReview.export(selectedYear, format)") &&
      !pageSrc.includes('exportTextFile') && !pageSrc.includes('dialog'))
    ok('4e 执行器独占创建 wx + 0600 + 拒绝覆盖', executorSrc.includes("openSync(targetPath, 'wx', 0o600)") &&
      executorSrc.includes("unlinkSync(targetPath)"))
    ok('4f 导出内容不经 PNG 校验器', !executorSrc.includes('validateAnnualReportExportPayload') && !executorSrc.includes('signature') && !executorSrc.includes('data:image/png'))
  }
}

main().then(() => {
  console.log(`结果：${pass} 通过 / ${fail} 失败`)
  process.exit(fail > 0 ? 1 : 0)
}).catch((e) => {
  console.error('FATAL:', e)
  process.exit(1)
})
