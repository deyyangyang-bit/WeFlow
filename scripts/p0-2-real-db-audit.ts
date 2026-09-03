/**
 * p0-2-real-db-audit.ts —— P0-2 收口：真实 DB 只读盘点
 *
 * 原则：纯只读。用 sql.js 把真实库字节读进内存再查询，
 * 全程不写回原文件（sql.js 内存库天然只读）。
 * 运行：npx tsx scripts/p0-2-real-db-audit.ts [dbPath]
 * 默认库：~/Library/Application Support/weflow/weflow-sales.db
 *
 * 统计维度（对应收口 ②）：
 *   1. canonical stage 分布（normalizeStage 归一，unknown/空归 unknown）
 *   2. current judgment 覆盖率：有判断客户数 / 四类型各自 distinct session / 覆盖率
 *   3. evidence 可用性：四类型 message_key 非空(ok) 与空(unavailable) 比例 + key 格式可解析性
 *   4. 去重健康度：重复行（同 session+type 多行）、24h 窗口内重复行（疑似漏网）
 *   5. 冲突观察：risk 判断×stage=won、opportunity 判断×stage=lost、orphan 判断（无客户行）
 *   6. follow_up_task 证据锚点覆盖率（source_message_id）
 */
import { readFileSync, existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import initSqlJs from 'sql.js'
import { findExistingBusinessDb } from '../electron/services/businessDbPath'
import { normalizeStage } from '../shared/salesStage'
import { parseEvidenceKey } from '../shared/evidenceKey'

const dbPath = process.argv[2] || findExistingBusinessDb(join(homedir(), 'Library', 'Application Support', 'weflow'), 'sales') || join(homedir(), 'Library', 'Application Support', 'weflow', 'weflow-sales.db')

async function main(): Promise<void> {
  if (!existsSync(dbPath)) {
    console.error(`DB 不存在: ${dbPath}`)
    process.exit(1)
  }
  const SQL = await initSqlJs({
    locateFile: () => join(__dirname, '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm')
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

  // ── 1. 总览 ─────────────────────────────────────────────────────────────
  sep('总览')
  const tables = q("SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name)
  const hasJudgment = tables.includes('customer_judgment')
  const totalCustomers = one('SELECT COUNT(*) AS c FROM customer_profile')
  const totalAccounts = tables.includes('account') ? one('SELECT COUNT(*) AS c FROM account') : -1
  const totalJudgments = hasJudgment ? one('SELECT COUNT(*) AS c FROM customer_judgment') : 0
  const totalTasks = one('SELECT COUNT(*) AS c FROM follow_up_task')
  const totalIntents = one('SELECT COUNT(*) AS c FROM intent_tag_log')
  console.log(`customer_profile=${totalCustomers} account=${totalAccounts < 0 ? '(CRM 库)' : totalAccounts} customer_judgment=${hasJudgment ? totalJudgments : '(表不存在)'} follow_up_task=${totalTasks} intent_tag_log=${totalIntents}`)
  if (!hasJudgment) console.log('⚠ customer_judgment 表不存在 → 应用尚未以 P0-2C.1+ 代码启动（建表在启动时），判断覆盖率为 0，以下 judgment 各节为前 C 基线')

  // ── 2. canonical stage 分布 ─────────────────────────────────────────────
  sep('canonical stage 分布（normalizeStage 归一，含 unknown）')
  const stageBuckets: Record<string, number> = {}
  for (const r of q('SELECT stage FROM customer_profile')) {
    const c = normalizeStage(String(r.stage ?? ''))
    stageBuckets[c] = (stageBuckets[c] ?? 0) + 1
  }
  console.log(Object.entries(stageBuckets).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(' '))

  const pct = (a: number, b: number): string => (b > 0 ? `${Math.round((a / b) * 100)}%` : '-')
  // ── 3. current judgment 覆盖率 ──────────────────────────────────────────
  sep('current judgment 覆盖率')
  if (!hasJudgment) {
    console.log('（表不存在 → 判断链未在真实运行中激活，覆盖率为 0 基线）')
  } else {
    const judgedSessions = one('SELECT COUNT(DISTINCT session_id) AS c FROM customer_judgment')
    console.log(`有判断客户 ${judgedSessions} / ${totalCustomers}（${pct(judgedSessions, totalCustomers)}）`)
    const TYPES = ['summary', 'opportunity', 'risk', 'next_action'] as const
    const cov: Record<string, number> = {}
    for (const t of TYPES) {
      cov[t] = one("SELECT COUNT(DISTINCT session_id) AS c FROM customer_judgment WHERE judgment_type = ?", [t])
    }
    for (const t of TYPES) {
      console.log(`  ${t.padEnd(13)} ${String(cov[t]).padStart(4)} 客户（占全客户 ${pct(cov[t], totalCustomers)} / 占有判断客户 ${pct(cov[t], judgedSessions)}）`)
    }

    // ── 4. evidence 可用性 ────────────────────────────────────────────────
    sep('evidence 可用性（message_key 非空=ok / 空=unavailable）')
    for (const t of TYPES) {
      const ok = one('SELECT COUNT(*) AS c FROM customer_judgment WHERE judgment_type = ? AND message_key IS NOT NULL AND message_key != \'\'', [t])
      const total = one('SELECT COUNT(*) AS c FROM customer_judgment WHERE judgment_type = ?', [t])
      console.log(`  ${t.padEnd(13)} ok=${ok} / ${total}（${pct(ok, total)}），unavailable=${total - ok}`)
    }
    // key 格式可解析性（P0-2B parseEvidenceKey）
    const keys = q('SELECT DISTINCT message_key FROM customer_judgment WHERE message_key IS NOT NULL AND message_key != \'\'')
    let parseable = 0
    for (const k of keys) {
      try { if (parseEvidenceKey(String(k.message_key)).kind !== 'unparseable') parseable++ } catch { /* 解析失败计数 */ }
    }
    console.log(`message_key 可解析 ${parseable}/${keys.length}（P0-2B 格式）`)

    // ── 5. 去重健康度 ─────────────────────────────────────────────────────
    sep('去重健康度（append-only：同 session+type 多行属历史，24h 窗口内多行=疑似漏网）')
    const dup = q('SELECT session_id, judgment_type, COUNT(*) AS n FROM customer_judgment GROUP BY session_id, judgment_type HAVING n > 1')
    console.log(`重复组合（session+type>1 行）: ${dup.length} 组，涉及行数 ${dup.reduce((s, d) => s + Number(d.n), 0)}`)
    const win24h = one(`SELECT COUNT(*) AS c FROM customer_judgment a JOIN customer_judgment b
      ON a.session_id = b.session_id AND a.judgment_type = b.judgment_type AND a.id != b.id
      WHERE a.created_at >= ? AND b.created_at >= ? AND ABS(a.created_at - b.created_at) < 86400000`, [Date.now() - 86400000, Date.now() - 86400000])
    console.log(`24h 窗口内重复对: ${win24h}`)
    const srcs = q('SELECT source, COUNT(*) AS c FROM customer_judgment GROUP BY source')
    console.log(`source 分布: ${srcs.map((s) => `${s.source}=${s.c}`).join(' ')}`)

    // ── 6. 冲突观察（结构级，不判语义）────────────────────────────────────
    sep('冲突观察')
    const riskSessions = q(`SELECT c.session_id AS sid, p.stage AS st FROM customer_judgment c
      JOIN customer_profile p ON p.session_id = c.session_id WHERE c.judgment_type = 'risk'`)
    const riskWonCount = riskSessions.filter((r) => normalizeStage(String(r.st ?? '')) === 'won').length
    console.log(`risk 判断 × canonical stage=won: ${riskWonCount}`)
    const oppLostCount = q(`SELECT c.session_id AS sid, p.stage AS st FROM customer_judgment c
      JOIN customer_profile p ON p.session_id = c.session_id WHERE c.judgment_type = 'opportunity'`)
      .filter((r) => normalizeStage(String(r.st ?? '')) === 'lost').length
    console.log(`opportunity 判断 × canonical stage=lost: ${oppLostCount}`)
    const orphan = one('SELECT COUNT(*) AS c FROM customer_judgment c LEFT JOIN customer_profile p ON p.session_id = c.session_id WHERE p.id IS NULL')
    console.log(`orphan 判断（session 无客户行）: ${orphan}`)
  }

  // ── 7. follow_up_task 证据锚点 ──────────────────────────────────────────
  sep('follow_up_task 证据锚点（P0-1 source_message_id）')
  const tasksWithKey = one("SELECT COUNT(*) AS c FROM follow_up_task WHERE source_message_id IS NOT NULL AND source_message_id != ''")
  console.log(`带 source_message_id: ${tasksWithKey} / ${totalTasks}（${pct(tasksWithKey, totalTasks)}）`)

  // ── 8. CHECK 硬门禁存在性 ───────────────────────────────────────────────
  sep('禁 stage 硬门禁')
  if (!hasJudgment) {
    console.log('customer_judgment 表不存在（随应用启动建表后生效）')
  } else {
    const check = q("SELECT sql FROM sqlite_master WHERE type='table' AND name='customer_judgment'")
    const hasCheck = String(check[0]?.sql || '').includes("judgment_type IN ('summary', 'opportunity', 'risk', 'next_action')")
    console.log(`DB CHECK 拦截 stage: ${hasCheck ? '✓ 生效' : '✗ 缺失'}`)
  }

  db.close()
  console.log('\n盘点完成（只读，未写回原库）')
}

main().catch((e) => { console.error(e); process.exit(1) })
