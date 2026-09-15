/**
 * p0-3-closed-gate-test.ts —— p0-3-closed-gate 输出脱敏守卫（2026-09-15）
 *
 * 为什么要单独守：p0-3-closed-gate 会**读取真实客户库**。它此前会把
 * `session_id` / 判断正文（value）/ `message_key` 逐行打印到终端，并打印真实库的绝对路径——
 * 等于把客户私有内容与机器目录结构写进 any 终端输出（日志、截图、CI 记录都留痕）。
 *
 * 两道守卫：
 *   ① 静态守卫：直接读 gate 脚本源码，禁止「把会拿到的列起别名再打印」这类回归写法，
 *      以及把库路径插进 console 的写法（注释先剥离，避免文档说明误报）。
 *   ② 输出捕获守卫（隔离）：用**合成库**（sentinel 值全是编造字符串，不含任何真实客户数据）
 *      起一个子进程跑 gate，捕获 stdout+stderr，断言：
 *        - 哨兵值一个都不出现（sessionId / 判断正文 / 摘要 / evidence_text / messageKey / 姓名）；
 *        - 合成库的绝对路径不出现；
 *        - 聚合计数**仍在**（脱敏不等于把验收输出砍空——那会让 gate 失去验收价值）。
 *
 * 隔离：合成库建在 /tmp 的一次性目录里，跑完即删；**绝不打开真实业务库**。
 * 运行：npx tsx scripts/p0-3-closed-gate-test.ts
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawnSync } from 'child_process'
import initSqlJs from 'sql.js'

const ROOT = join(__dirname, '..')
const GATE = join(__dirname, 'p0-3-closed-gate.ts')

let pass = 0, fail = 0
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; console.log(`  ✅ ${name}`) } else { fail++; console.log(`  ❌ ${name} ${detail}`) }
}

// ── 合成库的哨兵值：全部是编造字符串，与任何真实客户无关 ──────────────────────
const S_SESSION = 'SENTINEL-SESSION-7c1f0a'
const S_VALUE = 'SENTINEL-VALUE-判断正文-8a2d4b'
const S_SUMMARY = 'SENTINEL-SUMMARY-4b9e13'
const S_EVIDENCE = 'SENTINEL-EVIDENCE-1d3c66'
const S_KEY = 'SENTINEL-KEY-5e7a02'
const S_NAME = 'SENTINEL-NAME-2f8b77'
const S_CONTACT = 'SENTINEL-CONTACT-13800000000'

/** 建合成库并落盘到临时目录，返回 { dir, dbPath } */
async function buildSyntheticDb(): Promise<{ dir: string; dbPath: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'p0-3-gate-guard-'))
  const dbPath = join(dir, 'synthetic-sales.db')
  const SQL = await initSqlJs({ locateFile: () => join(ROOT, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm') })
  const db = new SQL.Database()
  db.run(`
    CREATE TABLE customer_profile (id INTEGER PRIMARY KEY, session_id TEXT, name TEXT, stage TEXT);
    CREATE TABLE customer_judgment (
      id INTEGER PRIMARY KEY, session_id TEXT, judgment_type TEXT, value TEXT, summary TEXT,
      evidence_text TEXT, message_key TEXT, generated_at INTEGER, created_at INTEGER
    );
  `)
  db.run('INSERT INTO customer_profile (id, session_id, name, stage) VALUES (?,?,?,?)',
    [1, S_SESSION, S_NAME, 'won'])
  // 四类型各一行 → 覆盖「四类型分布 / 四类全齐 / stale / message_key / 冲突观察」全部打印分支
  const types = ['summary', 'opportunity', 'risk', 'nextAction']
  const now = Date.now()
  types.forEach((t, i) => {
    db.run(
      'INSERT INTO customer_judgment (id, session_id, judgment_type, value, summary, evidence_text, message_key, generated_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      [i + 1, S_SESSION, t, S_VALUE, S_SUMMARY, S_EVIDENCE, `${S_KEY}-${t}`, now - i * 1000, now - i * 1000])
  })
  writeFileSync(dbPath, Buffer.from(db.export()))
  db.close()
  return { dir, dbPath }
}

async function main(): Promise<void> {
  // ── ① 静态守卫：源码里不得存在「取出来再打印」的回归写法 ───────────────────
  console.log('═══ ① 静态守卫：gate 源码不含逐行转储与路径打印 ═══')
  const raw = readFileSync(GATE, 'utf8')
  const source = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

  ok('S1 不把 session_id 起别名供打印（`session_id AS s` 零出现）', !/session_id\s+AS\s+\w/i.test(source))
  ok('S2 不把判断正文起别名供打印（`value AS v` / `summary AS` 零出现）',
    !/\bvalue\s+AS\s+\w/i.test(source) && !/\bsummary\s+AS\s+\w/i.test(source))
  ok('S3 不把 message_key 起别名供打印（`message_key AS k` 零出现）', !/message_key\s+AS\s+\w/i.test(source))
  ok('S4 不读取 evidence_text 列（该列只属于界面展示，验收输出不需要）', !/evidence_text/i.test(source))
  ok('S5 console 输出不插库路径（`console.*(...dbPath...)` 零出现）',
    !/console\s*\.\s*\w+\s*\(\s*`[^`]*\$\{\s*dbPath/.test(source) && !/console\s*\.\s*\w+\([^)]*\bdbPath\b/.test(source))
  ok('S6 逐行样例转储确实已删除（不再有「判断样例」输出段）', !/判断样例/.test(source))
  ok('S7 脚本仍是只读：不开写事务、不写业务库（无 UPDATE/INSERT/DELETE 语句常量）',
    !/\bUPDATE\s+customer_judgment\b/i.test(source) && !/\bINSERT\s+INTO\s+sqlite_master\b/i.test(source) &&
    /new SQL\.Database\(readFileSync\(dbPath\)\)/.test(source))

  // ── ② 输出捕获守卫：合成库跑真实 gate，哨兵一个都不许出现 ────────────────
  console.log('\n═══ ② 输出捕获守卫：合成库运行 gate，输出零哨兵 ═══')
  const { dir, dbPath } = await buildSyntheticDb()
  let captured = ''
  let status: number | null = null
  let crash: string | null = null
  try {
    const run = spawnSync(process.execPath, [join(ROOT, 'node_modules', '.bin', 'tsx'), GATE, dbPath], {
      cwd: ROOT, encoding: 'utf8', timeout: 180_000
    })
    if (run.error) crash = String(run.error)
    status = run.status
    captured = `${run.stdout || ''}${run.stderr || ''}`
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  ok('O0 gate 在合成库上正常跑完（退出码 0，无子进程崩溃）',
    crash === null && status === 0, JSON.stringify({ status, crash: crash && crash.slice(0, 120) }))
  ok('O1 输出不含 session_id 哨兵', !captured.includes(S_SESSION))
  ok('O2 输出不含判断正文哨兵', !captured.includes(S_VALUE))
  ok('O3 输出不含判断摘要哨兵', !captured.includes(S_SUMMARY))
  ok('O4 输出不含 evidence_text 哨兵', !captured.includes(S_EVIDENCE))
  ok('O5 输出不含 message_key 哨兵', !captured.includes(S_KEY))
  ok('O6 输出不含客户姓名哨兵', !captured.includes(S_NAME))
  ok('O7 输出不含联系方式哨兵', !captured.includes(S_CONTACT))
  ok('O8 输出不含合成库绝对路径（不泄露目录结构）',
    !captured.includes(dbPath) && !captured.includes(tmpdir()))
  // 脱敏不等于砍空：聚合计数必须还在，否则 gate 失去验收价值
  ok('O9 聚合计数仍然输出（脱敏不是把验收输出砍空）',
    /customer_profile=\d+/.test(captured) && /customer_judgment=/.test(captured) &&
    /四类型分布：.*summary=/.test(captured) && /stale/.test(captured))
  ok('O10 四类全齐只报计数、不报客户标识', /四类型全齐客户数 \d+/.test(captured))
  ok('O11 静态护栏段正常通过（G1-G6 无 FAIL）', !/FAIL: G\d/.test(captured))
  const missingDbLine = raw.split('\n').find((l) => l.includes('业务库文件不存在')) || ''
  ok('O12 库文件不存在时只报「不存在」，该行不插库路径',
    missingDbLine.length > 0 && !missingDbLine.includes('dbPath') && !missingDbLine.includes('${'))

  console.log(`\n═══ 结果：${pass} 通过 / ${fail} 失败 ═══`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error('测试崩溃:', e); process.exit(1) })
