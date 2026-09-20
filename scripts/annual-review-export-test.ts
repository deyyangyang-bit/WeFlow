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
import { buildAnnualReviewCsv, buildAnnualReviewMarkdown, escapeCsvCell, escapeMarkdownText, CSV_BOM } from '../electron/services/annualReviewExportContent'
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
  const sales: AnnualReviewSalesSegmentsFacts = { profiles: [{ id: 1, sessionId: 'wx_a', stage: 'quoted', lastContactAtSec: Math.floor(T(2025, 1, 5) / 1000), customerId: '501' }], intentEvents: [] }
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

  // ══ 2 独占写/已存在/未授权/大小上限/清理 ═══════════════════════════════════
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

    // 路径穿越形态：文件名内含分隔/相对段全部拒绝（不落盘）
    const traversal = exportTextFile({ dir, fileName: '../escape.md', content: 'x' }, { assertAllowed: allowAll })
    ok('2f 路径穿越文件名拒绝', traversal.ok === false && (traversal as { code: string }).code === 'invalid_leaf_name' &&
      !existsSync(join(dir, '..', 'escape.md')))

    // 写失败清理（目录内目标被占、伪造不可写场景用只读目录模拟）
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
    rmSync(dir, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
    rmSync(roDir, { recursive: true, force: true })
  }

  // ══ 3 Markdown/CSV 内容 ════════════════════════════════════════════════════
  {
    const report = buildReport()
    const md = buildAnnualReviewMarkdown(report)
    const csv = buildAnnualReviewCsv(report)

    ok('3 Markdown 元数据齐全（范围/生成时间/整体完整性）', md.includes('历史年度（') && md.includes('数据范围（实际输入事实）') &&
      md.includes('生成时间：') && md.includes('整体完整性：'))
    ok('3b Markdown unavailable 不写成 0（客单价/异常区块）', md.includes('不可用') &&
      !md.includes('| 客单价 | ¥0') && !md.includes('| 客单价 | 0'))
    ok('3c Markdown HTML 字段转义', md.includes('客户&lt;script&gt;') && !md.includes('<script>'))
    ok('3d Markdown 数值指标真实值（历史年度 A1 为 partial）', md.includes('| 客户总数 | 2 | 部分完整 |') && md.includes('| 年度签约合同数 | 2 | 完整 |'))
    ok('3e Markdown 含 warnings 全文与来源摘要', md.includes('## 数据说明') && md.includes('检测到中枢下发的分配/移交记录') &&
      md.includes('| crmdb | account / contract'))

    ok('3f CSV BOM + 表头', csv.startsWith(CSV_BOM + '指标,区块,值,状态'))
    // CSV 注入防护是结构性的：用户文本只出现在带固定前缀的标签列（无法领跑单元格），
    // 值列全部来自格式化器；escapeCsvCell 作为纵深防御单测覆盖
    ok('3g CSV 单元格不以公式字符开头', csv.split('\r\n').slice(1).every((line) =>
      line === '' || line.split(',').every((cell) => cell === '' || cell.startsWith('"') || !/^[=+@\t]/.test(cell))))
    ok('3h CSV 转义函数单元（逗号/引号包裹）', escapeCsvCell('含,逗号') === '"含,逗号"' &&
      escapeCsvCell('带"引号') === '"带""引号"')
    ok('3i CSV unavailable 行为「不可用」（沉默客户/长期未联系——历史年度）', csv.split('\r\n').some((line) => line.includes('沉默客户·人数,客户经营,不可用')) &&
      csv.split('\r\n').some((line) => line.includes('长期未联系客户·人数,沟通质量,不可用')))
    ok('3j CSV 无敏感字段', !csv.includes('wx_a') && !csv.includes('wx_b') && !csv.includes('sessionId') &&
      !csv.includes('.db') && !csv.includes('SELECT'))
    ok('3k Markdown 无敏感字段', !md.includes('wx_a') && !md.includes('sessionId') && !md.includes('/Users/') && !md.includes('.db'))
    ok('3l CSV 逃逸函数单元（制表符前缀）', escapeCsvCell('=1+1') === "'=1+1" && escapeCsvCell('@x') === "'@x" &&
      escapeCsvCell('-1') === "'-1" && escapeCsvCell('+1') === "'+1" && escapeCsvCell('普通') === '普通' &&
      escapeCsvCell('含,逗号') === '"含,逗号"')
    ok('3m Markdown 转义函数单元', escapeMarkdownText('<b>&') === '&lt;b&gt;&amp;')
  }

  // ══ 4 接线守卫（IPC/preload/types/页面） ═══════════════════════════════════
  {
    const mainSrc = readFileSync(join(ROOT, 'electron', 'main.ts'), 'utf8')
    const preloadSrc = readFileSync(join(ROOT, 'electron', 'preload.ts'), 'utf8')
    const dtsSrc = readFileSync(join(ROOT, 'src', 'types', 'electron.d.ts'), 'utf8')
    const pageSrc = readFileSync(join(ROOT, 'src', 'pages', 'AnnualReviewPage.tsx'), 'utf8')
    const executorSrc = readFileSync(join(ROOT, 'electron', 'services', 'safeTextFileExport.ts'), 'utf8')

    ok("4 main 注册 annualReview:export", mainSrc.includes("'annualReview:export'"))
    ok('4b main 导出走唯一执行器 + 授权单例', mainSrc.includes('exportTextFile({ dir, fileName, content })') &&
      mainSrc.includes('exportPathAuthorizer.grant(dir') && !/annualReportImageExport|annualReportExportPolicy/.test(
        mainSrc.slice(mainSrc.indexOf('annualReview:export'), mainSrc.indexOf('annualReport:getAvailableYears'))))
    ok('4c preload/d.ts 暴露 export', preloadSrc.includes("invoke('annualReview:export', { year, format })") &&
      dtsSrc.includes("export: (year: number, format: 'markdown' | 'csv')"))
    ok('4d 页面经安全 IPC 触发导出（目录授权在主进程对话框）', pageSrc.includes("annualReview.export(selectedYear, format)") &&
      !pageSrc.includes('exportTextFile') && !pageSrc.includes('dialog'))
    ok('4e 执行器独占创建 wx + 0600 + 拒绝覆盖', executorSrc.includes("openSync(targetPath, 'wx', 0o600)") &&
      executorSrc.includes("unlinkSync(targetPath)"))
    ok('4f 导出内容不经 PNG 校验器', !executorSrc.includes('annualReportImageExport') && !executorSrc.includes('signature'))
  }
}

main().then(() => {
  console.log(`结果：${pass} 通过 / ${fail} 失败`)
  process.exit(fail > 0 ? 1 : 0)
}).catch((e) => {
  console.error('FATAL:', e)
  process.exit(1)
})
