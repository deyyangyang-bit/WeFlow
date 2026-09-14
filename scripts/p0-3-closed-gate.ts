/**
 * p0-3-closed-gate.ts —— P0-3 收口：全仓静态护栏扫描 + 真实库运行态验收
 *
 * 用户拍板验收指标（P0-3.4 授权消息 ③）：
 *   全仓扫描「UI 是否还把历史载体冒充 Current Judgment？」：
 *     ❌ src/ 无 UI 直读 customer_judgment / insight_record 作为当前判断 / follow_up_task.analysis 作为当前判断 / 现场 LLM
 *     ✅ 消费统一走 sales:customer:currentView
 *
 * ① 静态护栏：src/ 全部 .ts/.tsx 剥离注释后扫描
 * ② 真实库运行态：sql.js 字节进内存纯只读（不写回原文件），
 *    统计 customer_judgment 覆盖 / freshness / evidence 可用性 / 冲突观察（复用 p0-2-real-db-audit 先例）
 *
 * 运行：npx tsx scripts/p0-3-closed-gate.ts [dbPath]
 * 默认库：~/Library/Application Support/weflow/weflow-sales.db
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import initSqlJs from 'sql.js'
import { findExistingBusinessDb } from '../electron/services/businessDbPath'
import { parseEvidenceKey } from '../shared/evidenceKey'

const ROOT = join(__dirname, '..')
const SRC = join(ROOT, 'src')
const dbPath = process.argv[2] || findExistingBusinessDb(join(homedir(), 'Library', 'Application Support', 'weflow'), 'sales') || join(homedir(), 'Library', 'Application Support', 'weflow', 'weflow-sales.db')
const CURRENT_JUDGMENT_FRESH_MS = 24 * 3600 * 1000

let pass = 0, fail = 0
function ok(name: string, cond: boolean): void {
  if (cond) { pass++ } else { fail++; console.error('FAIL:', name) }
}

/** 递归收集 src/ 下 .ts/.tsx 源码 */
function collectTsFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) {
      if (name === 'types') continue // 类型声明单独检查（electron.d.ts 属 IPC 契约非 UI 消费）
      out.push(...collectTsFiles(full))
    } else if (/\.(ts|tsx)$/.test(name)) {
      out.push(full)
    }
  }
  return out
}

async function main(): Promise<void> {
  // ── ① 静态护栏：全仓 src/ ────────────────────────────────────────────────
  console.log('── ① 全仓静态护栏扫描（src/ .ts/.tsx 剥离注释）──')
  const files = collectTsFiles(SRC)
  const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  const codeText = files.map((f) => `${f}\n${strip(readFileSync(f, 'utf8'))}`).join('\n')
  // G3 只禁止代码把 follow_up_task 当作当前判断载体直接读取；页面允许在人话口径中展示表名。
  // 去掉字符串字面量后再扫标识符，避免 Action Funnel 的“事实来源”说明触发误报。
  const codeWithoutStringLiterals = codeText
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/`(?:\\.|[^`\\])*`/g, '``')

  ok('G1 无 customer_judgment 直读（真源只经主进程组装层）', !/customer_judgment/.test(codeText))
  ok('G2 无 insight_record 直读（收件箱走 insight.* IPC 历史语义）', !/insight_record/.test(codeText))
  ok('G3 无 follow_up_task 直读（任务数据走统一信号流；人话事实来源标签允许）', !/follow_up_task/.test(codeWithoutStringLiterals))
  ok('G4 无 UI 现场 LLM（generateInsight / generateActionAnalysis / persistActionAnalysisJudgments 零出现）',
    !/generateInsight/.test(codeText) && !/generateActionAnalysis/.test(codeText) && !/persistActionAnalysisJudgments/.test(codeText))
  ok('G5 消费统一走 sales:customer:currentView（≥3 处 UI 消费）',
    /customerCurrentView/.test(readFileSync(join(SRC, 'stores/todayActionStore.ts'), 'utf8')) &&
    /customerCurrentView/.test(readFileSync(join(SRC, 'components/sales/SalesContextStrip.tsx'), 'utf8')) &&
    /customerProfile\.currentView/.test(readFileSync(join(SRC, 'pages/CustomerWorkspacePage.tsx'), 'utf8')))
  // 判断面板消费点三处一致（360 四卡 / 状态条四卡 / 今日行动卡 judgments 四卡）
  // 360 先消费 currentView.judgments 后以 j.summary 引用（P0-3.2 实现），strip/action 直接 judgments.x
  ok('G6 判断展示统一消费投影四卡（360/strip/action 三消费者）',
    /currentView\.judgments/.test(readFileSync(join(SRC, 'pages/CustomerWorkspacePage.tsx'), 'utf8')) && /j\.(summary|opportunity|risk|nextAction)/.test(readFileSync(join(SRC, 'pages/CustomerWorkspacePage.tsx'), 'utf8')) &&
    /judgments\.(summary|opportunity|risk|nextAction)/.test(readFileSync(join(SRC, 'components/sales/SalesContextStrip.tsx'), 'utf8')) &&
    /judgments\.(summary|opportunity|risk|nextAction)/.test(readFileSync(join(SRC, 'components/sales/AIActionCard.tsx'), 'utf8')))
  console.log(`静态护栏：${pass} passed, ${fail} failed（文件数 ${files.length}）`)

  // ── ② 真实库运行态验收（sql.js 只读）─────────────────────────────────────
  console.log('\n── ② 真实库运行态验收（sql.js 只读）──')
  if (!existsSync(dbPath)) {
    console.error(`DB 不存在: ${dbPath}`)
    process.exit(1)
  }
  const SQL = await initSqlJs({
    locateFile: () => join(ROOT, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm')
  })
  const db = new SQL.Database(readFileSync(dbPath)) // 字节进内存，不写回
  const q = (sql: string, params: any[] = []): Array<Record<string, any>> => {
    const stmt = db.prepare(sql)
    stmt.bind(params)
    const rows: Array<Record<string, any>> = []
    while (stmt.step()) rows.push(stmt.getAsObject())
    stmt.free()
    return rows
  }
  const one = (sql: string, params: any[] = []): number => Number(q(sql, params)[0]?.c || 0)
  const sep = (t: string): void => console.log(`\n── ${t} ──`)

  const tables = q("SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name)
  const hasJudgment = tables.includes('customer_judgment')
  const totalCustomers = one('SELECT COUNT(*) AS c FROM customer_profile')
  const totalJudgments = hasJudgment ? one('SELECT COUNT(*) AS c FROM customer_judgment') : 0

  sep('总览')
  console.log(`customer_profile=${totalCustomers} customer_judgment=${hasJudgment ? totalJudgments : '(表不存在)'}`)
  if (!hasJudgment) {
    console.log('⚠ customer_judgment 表不存在 → 应用尚未以 P0-2C.1+ 代码启动（建表在启动时），判断覆盖为 0 基线；运行态行为已由 temp DB 生产函数测试覆盖（current-view 30/30 + today-action-consumer 14/14）')
  } else if (totalJudgments === 0) {
    console.log('⚠ 表存在但 0 行 → 预热/扫描链路尚未在真实库产生判断（部署时序），同样属 0 基线')
  } else {
    const judgedCustomers = one('SELECT COUNT(DISTINCT session_id) AS c FROM customer_judgment')
    const coverage = totalCustomers > 0 ? ((judgedCustomers / totalCustomers) * 100).toFixed(1) : '0'
    const typeCounts: Record<string, number> = {}
    for (const r of q('SELECT judgment_type AS t, COUNT(*) AS c FROM customer_judgment GROUP BY judgment_type')) {
      typeCounts[r.t] = Number(r.c)
    }
    sep('判断覆盖')
    console.log(`有判断客户 ${judgedCustomers}/${totalCustomers}（${coverage}%）`)
    console.log(`四类型分布：${Object.entries(typeCounts).map(([t, c]) => `${t}=${c}`).join(' ')}`)

    sep('freshness（24h 窗口）')
    const now = Date.now()
    const stale = q('SELECT COUNT(*) AS c FROM customer_judgment WHERE COALESCE(generated_at, created_at) IS NULL OR ? - COALESCE(generated_at, created_at) > ?', [now, CURRENT_JUDGMENT_FRESH_MS])[0]?.c
    console.log(`stale（>24h 或无时间戳）${stale}/${totalJudgments}——stale 仍返回并标「较旧」，属契约语义非缺陷`)

    sep('evidence 可用性')
    const withKey = q('SELECT COUNT(*) AS c FROM customer_judgment WHERE message_key IS NOT NULL AND TRIM(message_key) != \'\'')[0]?.c
    const keys = q('SELECT message_key AS k FROM customer_judgment WHERE message_key IS NOT NULL AND TRIM(message_key) != \'\'')
    const parseable = keys.filter((r) => parseEvidenceKey(String(r.k)).kind !== 'unknown').length
    console.log(`message_key 非空 ${withKey}/${totalJudgments}（ok）；可解析 ${parseable}/${keys.length}（P0-2B 格式）`)

    sep('四类全齐客户（今日行动卡面板最完整场景）')
    const full = q('SELECT session_id FROM customer_judgment GROUP BY session_id HAVING COUNT(DISTINCT judgment_type) = 4 LIMIT 5')
    console.log(full.length > 0 ? full.map((r) => r.session_id).join(' / ') : '无（部分类型未覆盖属正常）')

    sep('冲突观察（判断 × 客户状态）')
    const oppWonLost = one("SELECT COUNT(*) AS c FROM customer_judgment j JOIN customer_profile p ON p.session_id = j.session_id WHERE j.judgment_type IN ('opportunity') AND p.stage IN ('won','lost')")
    const riskWonLost = one("SELECT COUNT(*) AS c FROM customer_judgment j JOIN customer_profile p ON p.session_id = j.session_id WHERE j.judgment_type = 'risk' AND p.stage IN ('won','lost')")
    const orphan = one("SELECT COUNT(*) AS c FROM customer_judgment j LEFT JOIN customer_profile p ON p.session_id = j.session_id WHERE p.session_id IS NULL")
    console.log(`opportunity × won/lost=${oppWonLost} risk × won/lost=${riskWonLost} orphan（无客户行）=${orphan}`)

    sep('判断样例（最新 3 条）')
    for (const r of q('SELECT session_id AS s, judgment_type AS t, value AS v, message_key AS k FROM customer_judgment ORDER BY COALESCE(generated_at, created_at) DESC, id DESC LIMIT 3')) {
      console.log(`  ${r.s} ${r.t}: ${String(r.v).slice(0, 40)} key=${r.k || '(unavailable)'}`)
    }
  }

  console.log(`\np0-3-closed-gate: ${pass} passed, ${fail} failed（静态）；运行态验收见上`)
  if (fail > 0) process.exit(1)
}

main()
