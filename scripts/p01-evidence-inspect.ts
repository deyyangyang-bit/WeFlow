/**
 * p01-evidence-inspect.ts —— P0-1 runtime 验收核对脚本（只读，不改库，无 electron 依赖）
 *
 * 用法：
 *   npx tsx scripts/p01-evidence-inspect.ts [dbPath] [条数]
 *   （默认读 ~/Library/Application Support/weflow/weflow-sales.db，最近 20 条）
 *
 * 验收三件事怎么对：
 *   1. 新消息触发 AI 后新出现的行，message_key 应 ✓（老行 NULL 正常——历史数据没迁移）
 *   2. 复制每行生成的 curl（需 app 运行中 + HTTP API 开启 + httpApiToken 已配置），
 *      比对返回消息里是否包含与 evidence_text 一致的原话
 *   3. evidence 列应是客户原话（如「我们预计9月份采购10台」），
 *      不是 AI reason（如「客户当前处于高意向决策阶段」）
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import initSqlJs from 'sql.js'

const appData = join(homedir(), 'Library/Application Support/weflow')
const dbPath = process.argv[2] || join(appData, 'weflow-sales.db')
const limit = Math.min(50, Math.max(1, Number(process.argv[3] || 20)))

// 读配置拿 httpApiToken（curl 命令用）
let token = ''
try {
  const cfg = JSON.parse(readFileSync(join(appData, 'WeFlow-config.json'), 'utf-8'))
  token = cfg.httpApiToken || ''
} catch { /* 无配置时 curl 不带 token */ }

function fmt(ms: number): string {
  const d = new Date(Number(ms) || 0)
  if (isNaN(d.getTime())) return String(ms)
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

async function main(): Promise<void> {
  const SQL = await initSqlJs()
  const db = new SQL.Database(new Uint8Array(readFileSync(dbPath)))

  // schema 检测：旧库还没有证据列（migration 要等新代码启动 app 时才跑）
  const cols = (db.exec('PRAGMA table_info(intent_tag_log)')[0]?.values || []).map((c: any[]) => String(c[1]))
  if (!cols.includes('message_key') || !cols.includes('evidence_text')) {
    console.log(`\n⚠️  当前库还是旧 schema（intent_tag_log 无 message_key/evidence_text 列）。`)
    console.log(`    migration 由 salesDbService.initialize 触发——请先：`)
    console.log(`    1. 用 P0-1 新代码启动 app（npm run dev）→ 启动时自动加列`)
    console.log(`    2. 在 app 里触发一次 AI（新消息自动分类 / 客户卡片点「AI 意向分析」）`)
    console.log(`    3. 重新运行本脚本核对`)
    console.log(`    （本脚本只读，不会帮你改库。若 app 已跑过仍报此错，检查启动的是否是新代码）`)
    db.close()
    return
  }

  const res = db.exec(
    `SELECT id, session_id, stage, confidence, source, reason, message_key, evidence_text, created_at
     FROM intent_tag_log ORDER BY created_at DESC LIMIT ${limit}`
  )
  const rows = (res[0]?.values || []) as any[][]

  console.log(`\n=== intent_tag_log 最近 ${rows.length} 条（${dbPath}） ===`)
  let withKey = 0, withEv = 0
  rows.forEach((r, i) => {
    const [id, sid, stage, conf, source, reason, mk, ev, ts] = r
    const hasKey = !!mk
    const hasEv = !!ev
    if (hasKey) withKey++
    if (hasEv) withEv++

    console.log(`\n[${i + 1}] ${fmt(ts)}  source=${source}  stage=${stage}  conf=${conf}  id=${id}`)
    console.log(`     sid        = ${sid}`)
    console.log(`     message_key = ${hasKey ? '✓ ' + String(mk).slice(0, 80) : '✗ NULL（老数据或无证据）'}`)
    console.log(`     evidence    = ${hasEv ? '✓ ' + String(ev).slice(0, 60) : '✗ NULL'}`)
    if (reason) console.log(`     reason(AI) = ${String(reason).slice(0, 60)}`)

    if (hasKey && token) {
      const win = 3 * 3600_000
      console.log(`   → 验证点2 API 回查（app 运行时执行）：`)
      console.log(`     curl -s "http://127.0.0.1:5031/api/v1/messages?talker=${encodeURIComponent(String(sid))}&limit=50&access_token=${token}&start=${Number(ts) - win}&end=${Number(ts) + win}" | python3 -m json.tool | head -60`)
    }
  })

  console.log(`\n=== 统计：${rows.length} 条中 带 message_key ${withKey} / 带 evidence_text ${withEv} ===`)
  console.log(`\n验收三件事：`)
  console.log(`  1. 最近一次 AI 触发后出现的新行，message_key 应 ✓（老行 NULL 正常，历史数据未迁移）`)
  console.log(`  2. 复制上面的 curl（app 运行中 + HTTP API 已开启 + httpApiToken 已配置），比对返回消息是否含 evidence_text 原话`)
  console.log(`  3. evidence 列应为客户原话（如「我们预计9月份采购10台」），不是 AI reason（如「高意向决策阶段」）`)
  db.close()
}

main().catch((e) => { console.error(e); process.exit(1) })
