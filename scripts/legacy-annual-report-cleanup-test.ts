/**
 * legacy-annual-report-cleanup-test.ts —— S8 旧社交年度报告链路清理守卫
 *
 * 背景：旧 `/annual-report`、`/dual-report`（微信年度回忆式社交报告 + 双人报告）已下线，
 * 新「年度经营复盘」`/annual-review`（annualReview:*）是唯一在册报告链路。本脚本把
 * 「旧链路不得复活 + 新链路不得被误伤」固化为可复核断言，防回归。
 *
 * 覆盖：
 *   A 旧链路文件已删除（页面/窗口/样式/Worker/Service/图片导出/字体）
 *   B App 不再注册四条旧路由，且不 import 已删页面
 *   C preload/d.ts/main 不再暴露旧 IPC；vite 不再构建两个旧 Worker
 *   D Sidebar 无隐藏旧入口
 *   E 全仓代码残留扫描（旧 IPC 名/路由/模块名/通道名零命中）
 *   F 防线：新 /annual-review 与 annualReview:*、年度复盘统计/AI/导出/失效链路完整保留
 *   G 防线：getAnnualReportStats 仍存在且销售报告 / 年度复盘仍引用（命名旧但为共享底层能力）
 *   H 共享底层包装：仅旧链路使用的 getAnnualReportExtras / getDualReportStats 已随旧链路删除
 *   I exportPathAuthorizer 通用能力与新复盘文本导出保留
 *
 * 运行：npx tsx scripts/legacy-annual-report-cleanup-test.ts
 */
import { existsSync, readFileSync } from 'fs'
import { execFileSync } from 'child_process'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

let pass = 0, fail = 0
function ok(name: string, cond: boolean): void {
  if (cond) { pass++ } else { fail++; console.error('FAIL:', name) }
}
function eq<T>(name: string, actual: T, expected: T): void {
  ok(`${name}（实际 ${JSON.stringify(actual)}）`, JSON.stringify(actual) === JSON.stringify(expected))
}

const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

/** 版本库内的源码文件清单（排除构建产物与第三方依赖：已跟踪文件即为源码事实源） */
function collectSourceFiles(paths: string[]): string[] {
  const out = execFileSync('git', ['ls-files', '-z', ...paths], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
  return out.filter((f) => /\.(ts|tsx|scss|css|mjs|cjs|js|json)$/.test(f))
}

function main(): void {
  // ══ A 旧链路文件已删除 ══════════════════════════════════════════════════════
  {
    const deadFiles = [
      'src/pages/AnnualReportPage.tsx', 'src/pages/AnnualReportPage.scss',
      'src/pages/AnnualReportWindow.tsx', 'src/pages/AnnualReportWindow.scss',
      'src/pages/DualReportPage.tsx', 'src/pages/DualReportPage.scss',
      'src/pages/DualReportWindow.tsx', 'src/pages/DualReportWindow.scss',
      'electron/annualReportWorker.ts', 'electron/dualReportWorker.ts',
      'electron/services/annualReportService.ts', 'electron/services/dualReportService.ts',
      'electron/services/annualReportExportPolicy.ts', 'electron/services/annualReportImageExport.ts'
    ]
    for (const f of deadFiles) ok(`A ${f} 已删除`, !existsSync(join(ROOT, f)))
    ok('A2 旧链路专属字体目录已删除', !existsSync(join(ROOT, 'resources/fonts/annual-report')))
    ok('A3 未误删复用字体（editorial 子集仍在）', existsSync(join(ROOT, 'resources/fonts/editorial/NotoSerifSC-Subset.woff2')))
  }

  // ══ B App.tsx：四条旧路由不再注册，且不引用已删页面 ═════════════════════════
  {
    const appSrc = read('src/App.tsx')
    const legacyRoutes = ['/annual-report/view', '/annual-report', '/dual-report/view', '/dual-report']
    for (const route of legacyRoutes) {
      ok(`B App 不再注册路由 ${route}`,
        !appSrc.includes(`<Route path="${route}"`) && !appSrc.includes(`pathname === '${route}'`))
    }
    ok('B2 App 不再 import 旧页面（lazy import）',
      !/AnnualReportPage|AnnualReportWindow|DualReportPage|DualReportWindow/.test(appSrc))
    ok('B3 App 不再有旧窗口判断标识符',
      !appSrc.includes('isAnnualReportWindow') && !appSrc.includes('isDualReportWindow'))
    ok('B4 App 仍注册新路由 /annual-review', appSrc.includes('path="/annual-review"') &&
      appSrc.includes("import('./pages/AnnualReviewPage')"))
    ok('B5 独立窗口判定保留既有成员（未被误删）',
      appSrc.includes('isNotificationWindow') && appSrc.includes('isStandaloneChatWindow') &&
      appSrc.includes("location.pathname === '/image-viewer-window'"))
  }

  // ══ C preload / d.ts / main / vite ═════════════════════════════════════════
  {
    const preloadSrc = read('electron/preload.ts')
    const mainSrc = read('electron/main.ts')
    const dtsSrc = read('src/types/electron.d.ts')
    const viteSrc = read('vite.config.ts')

    // 旧 IPC：命名空间、invoke/on 通道、handler 注册全部不得存在
    ok('C1 preload 无旧命名空间', !preloadSrc.includes('annualReport: {') && !preloadSrc.includes('dualReport: {'))
    ok('C2 preload 无旧 invoke/on 通道',
      !/invoke\('annualReport:|invoke\('dualReport:|on\('annualReport:|on\('dualReport:/.test(preloadSrc))
    ok('C3 main 无旧 IPC handler',
      !/ipcMain\.handle\('annualReport:|ipcMain\.handle\('dualReport:/.test(mainSrc))
    ok('C4 main 不再引用旧 Worker / Service / 图片导出',
      !/annualReportWorker|dualReportWorker|annualReportService|dualReportService|exportAnnualReportImages/.test(mainSrc))
    ok('C5 main 不再有旧年份加载任务状态机',
      !mainSrc.includes('AnnualReportYears') && !mainSrc.includes('isYearsLoadCanceled'))
    ok('C6 d.ts 无旧命名空间', !dtsSrc.includes('annualReport: {') && !dtsSrc.includes('dualReport: {'))
    ok('C7 d.ts 保留 annualReview 命名空间与报告类型',
      dtsSrc.includes('annualReview: {') && dtsSrc.includes('interface AnnualReviewReport'))
    ok('C8 vite 不再构建两个旧 Worker',
      !viteSrc.includes('annualReportWorker') && !viteSrc.includes('dualReportWorker'))
    ok('C9 vite 仍构建 annualReviewWorker + 产物名不变',
      viteSrc.includes("entry: 'electron/annualReviewWorker.ts'") &&
      viteSrc.includes("entryFileNames: 'annualReviewWorker.js'"))
    ok('C10 Worker 源文件与产物名接线一致', existsSync(join(ROOT, 'electron/annualReviewWorker.ts')))
    ok('C11 旧 Worker 产物名不再被任何构建脚本引用',
      !read('scripts/verify-electron-bundle.cjs').includes('annualReportWorker'))
  }

  // ══ D Sidebar：无隐藏旧入口 ════════════════════════════════════════════════
  {
    const sidebarSrc = read('src/components/Sidebar.tsx')
    ok('D1 Sidebar 不含旧路由字面量', !sidebarSrc.includes('/annual-report') && !sidebarSrc.includes('/dual-report'))
    ok('D2 Sidebar 不再引用已删旧入口专属图标 FileText', !sidebarSrc.includes('FileText'))
    ok('D3 Sidebar 仍保留其他隐藏入口（未越界清理）',
      sidebarSrc.includes('{false && <NavLink') && sidebarSrc.includes('to="/analytics"'))
    ok('D4 导航定义仍保留「年度经营复盘」入口',
      read('src/utils/appNav.ts').includes("path: '/annual-review'") &&
      read('src/utils/appNav.ts').includes('年度经营复盘'))
  }

  // ══ E 全仓代码残留扫描：旧链路标识零命中 ═══════════════════════════════════
  {
    // 这些 token 只允许出现在文档与测试脚本（断言"已删除"的脚本必然要写出被删标识）；
    // src/electron/shared/central 的产品代码中必须为零。
    const forbidden = [
      'annual-report', 'dual-report',
      'annualReport:', 'dualReport:',
      'annualReportService', 'dualReportService',
      'AnnualReportPage', 'AnnualReportWindow', 'DualReportPage', 'DualReportWindow',
      'annualReportWorker', 'dualReportWorker',
      'annualReportImageExport', 'annualReportExportPolicy',
      'getAnnualReportExtras', 'getDualReportStats',
      'wcdb_get_annual_report_extras', 'wcdb_get_dual_report_stats'
    ]
    const hits: string[] = []
    for (const rel of collectSourceFiles(['src', 'electron', 'shared', 'central'])) {
      if (rel.startsWith('scripts/') || rel.endsWith('.d.ts')) continue
      const content = readFileSync(join(ROOT, rel), 'utf8')
      for (const token of forbidden) {
        if (content.includes(token)) hits.push(`${rel}: ${token}`)
      }
    }
    eq('E 旧链路代码 token 零残留', hits, [])
  }

  // ══ F 防线：新年度经营复盘链路完整保留 ═════════════════════════════════════
  {
    const mainSrc = read('electron/main.ts')
    const preloadSrc = read('electron/preload.ts')
    const dtsSrc = read('src/types/electron.d.ts')
    const viteSrc = read('vite.config.ts')

    for (const channel of ['annualReview:getAvailableYears', 'annualReview:generate', 'annualReview:getReport',
      'annualReview:cancel', 'annualReview:getTaskStatus']) {
      ok(`F1 main 仍注册 ${channel}`, mainSrc.includes(`'${channel}'`))
      ok(`F2 preload 仍对接 ${channel}`, preloadSrc.includes(`'${channel}'`))
    }
    ok('F3 新链路 AI / 导出 / 失效链路接线保留',
      mainSrc.includes("'annualReview:aiAnalysis'") && mainSrc.includes("'annualReview:aiAnalysisCancel'") &&
      mainSrc.includes("'annualReview:export'") && mainSrc.includes('installAnnualReviewInvalidation') &&
      mainSrc.includes('annualReviewService.handleDataChanged') &&
      mainSrc.includes('annualReviewAiCoordinator.invalidateAll'))
    ok('F4 新复盘服务/统计/AI/导出模块文件均在',
      ['electron/services/annualReviewService.ts', 'electron/services/annualReviewStats.ts',
        'electron/services/annualReviewReport.ts', 'electron/services/annualReviewAiService.ts',
        'electron/services/annualReviewAiCoordinator.ts', 'electron/services/annualReviewInvalidation.ts',
        'electron/services/safeTextFileExport.ts', 'src/pages/AnnualReviewPage.tsx'].every((f) => existsSync(join(ROOT, f))))
    ok('F5 新复盘导出仍走 safeTextFileExport + 授权单例（未回退到旧图片导出）',
      mainSrc.includes('exportTextFile({ dir, fileName, content })') && mainSrc.includes('exportPathAuthorizer.grant(dir'))
    ok('F6 preload 新命名空间方法齐全',
      ['getAvailableYears', 'generate', 'getReport', 'cancel', 'getTaskStatus', 'export', 'aiAnalysis']
        .every((m) => preloadSrc.includes(`${m}: `)))
    ok('F7 d.ts 与 vite 的新链路声明/构建保留',
      dtsSrc.includes('annualReview: {') && dtsSrc.includes('getTaskStatus: (taskId: string)') &&
      viteSrc.includes('annualReviewWorker.js'))
  }

  // ══ G 防线：getAnnualReportStats 命名旧但为共享底层能力，必须保留 ═══════════
  {
    const wcdbServiceSrc = read('electron/services/wcdbService.ts')
    const wcdbCoreSrc = read('electron/services/wcdbCore.ts')
    const wcdbWorkerSrc = read('electron/wcdbWorker.ts')
    const statsSrc = read('electron/services/annualReviewStats.ts')
    const salesReportSrc = read('electron/services/salesReportService.ts')

    ok('G1 wcdbService 包装仍存在', wcdbServiceSrc.includes('async getAnnualReportStats(') &&
      wcdbServiceSrc.includes("this.callWorker('getAnnualReportStats'"))
    ok('G2 wcdbCore 原生绑定与方法仍存在',
      wcdbCoreSrc.includes('wcdb_get_annual_report_stats') && wcdbCoreSrc.includes('async getAnnualReportStats(') &&
      wcdbCoreSrc.includes('this.wcdbGetAnnualReportStats'))
    ok('G3 wcdbWorker 分派分支仍存在', wcdbWorkerSrc.includes("case 'getAnnualReportStats':"))
    ok('G4 年度经营复盘统计层仍引用',
      statsSrc.includes('getAnnualReportStats') &&
      statsSrc.split('getAnnualReportStats').length - 1 >= 1)
    ok('G5 销售报告仍引用',
      salesReportSrc.includes('wcdbService.getAnnualReportStats('))
    ok('G6 main 主进程新链路仍接线该统计（loadMessageStats）',
      read('electron/main.ts').includes('wcdbService.getAnnualReportStats(sessionIds, beginSec, endSec)'))
  }

  // ══ H 仅旧链路使用的底层包装已随旧链路删除 ═════════════════════════════════
  {
    const wcdbServiceSrc = read('electron/services/wcdbService.ts')
    const wcdbCoreSrc = read('electron/services/wcdbCore.ts')
    const wcdbWorkerSrc = read('electron/wcdbWorker.ts')
    ok('H1 wcdbService 不再有 getAnnualReportExtras / getDualReportStats',
      !wcdbServiceSrc.includes('getAnnualReportExtras') && !wcdbServiceSrc.includes('getDualReportStats'))
    ok('H2 wcdbCore 不再有对应绑定/方法',
      !wcdbCoreSrc.includes('wcdbGetAnnualReportExtras') && !wcdbCoreSrc.includes('wcdbGetDualReportStats') &&
      !wcdbCoreSrc.includes('wcdb_get_annual_report_extras') && !wcdbCoreSrc.includes('wcdb_get_dual_report_stats'))
    ok('H3 wcdbWorker 不再分派这两个方法',
      !wcdbWorkerSrc.includes("case 'getAnnualReportExtras':") && !wcdbWorkerSrc.includes("case 'getDualReportStats':"))
  }

  // ══ I 通用导出授权与新复盘文本导出保留 ═════════════════════════════════════
  {
    ok('I1 exportPathAuthorizer 通用能力保留',
      existsSync(join(ROOT, 'electron/services/exportPathAuthorizer.ts')) &&
      read('electron/services/exportPathAuthorizer.ts').includes('export class ExportPathAuthorizer'))
    // 通用授权用例保留；已删图片导出模块不再被导入/调用（脚本头部对删除原因的说明不算引用）
    const authTestSrc = read('scripts/export-path-authorizer-test.ts')
    ok('I2 通用授权测试脚本保留且不再导入已删图片导出模块',
      !/from '\.\.\/electron\/services\/annualReport(ImageExport|ExportPolicy)'/.test(authTestSrc) &&
      !authTestSrc.includes('exportAnnualReportImages') && !authTestSrc.includes('validateAnnualReportExportPayload'))
    ok('I3 通用授权器断言未被削弱（1x–15 段仍在）',
      authTestSrc.includes("ok('1a 已授权目录本身放行'") &&
      authTestSrc.includes("ok('15 自动化导出未授权 outputDir → assertAllowed 明确抛错'"))
    ok('I4 background task 不再声明旧来源页',
      !read('src/types/backgroundTask.ts').includes("'annualReport'") &&
      !read('src/pages/Export/constants.ts').includes('annualReport:'))
  }

  console.log(`结果：${pass} 通过 / ${fail} 失败`)
  if (fail > 0) process.exit(1)
}

main()
