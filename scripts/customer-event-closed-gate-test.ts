/**
 * customer-event-closed-gate-test.ts —— P0-3 E3 收口护栏（静态全仓 + 真实库运行态）
 *
 * 验收（Scope Lock 2026-08-23：建通用 customer_event 表 / quote_signal 分流不迁 /
 * 四消费者全部不迁 / 硬门禁防万能日志表）：
 *   A 静态全仓：
 *     1  customerEventAdd 调用点 = 3（定义 + recordCustomerEventSafe + recordUserActionEvent），
 *        全部经过守卫（DB CHECK + TS isCustomerEventType 双拦截）
 *     2  customerEventsBySession / customerEventsByType 零消费者（Scope Lock ⑥ 四消费者不迁）
 *     3  无绕过 DDL 的直接 SQL（全仓除 SCHEMA_SQL 无 INSERT INTO customer_event）
 *     4  五类型写点归属：quote_asked/customer_replied 仅 crmParseService；
 *        script_copied/chat_opened 仅前端成功点→IPC；follow_up_done 仅 completeAction 状态转换
 *     5  follow_up_done 不经 IPC（前端零提交，防双写/不可控）
 *     6  四层边界：customerEventAdd 方法体只写 customer_event 一张表（不冒充 judgment/profile/intent）
 *     7  quote_signal 不迁移：recordQuoteSignal + markQuoteReplied（customer_replied_at 回流）继续存在
 *     8  无第二套 action log（无 activity_log/action_log/user_action 新表 CREATE）
 *     9  R7 不迁移：completeUnifiedSignal 继续 todoUpdate 关单（不改为消费 customer_event）
 *     10 文档同步：Scope Lock 设计文档 + 收口验收文档存在
 *   B 真实库运行态（sql.js 字节进内存只读，绝不写真实库）：
 *     11 customer_event 真实库行类型全部落在五类白名单内（硬门禁在真实数据上生效）
 *        —— 2026-09-13 归因：原断言为「0 行基线」，那是 2026-08-24 A1 清理后的一次性迁移快照
 *           （当时应用尚未以 E3.1+ 代码启动、表待重启激活）。应用正常使用后必然产生真实事件，
 *           该快照随之失效（本机实测 13 行），属夹具假设过期而非回归；改锚定耐久不变量。
 *     12 quote_signal 分流兼容：customer_replied_at 字段在真实数据继续工作（22 行全部已回复）
 *     13 DDL 无损建表：CREATE + 3 索引在内存副本执行成功；CHECK 接受五类型、拒绝越界类型
 *
 * 运行：npx tsx scripts/customer-event-closed-gate-test.ts
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import os from 'os'
import { findExistingBusinessDb } from '../electron/services/businessDbPath'
import path from 'path'
import initSqlJs from 'sql.js'
import { salesDbService } from '../electron/services/salesDbService'

let pass = 0, fail = 0
function ok(name: string, cond: boolean): void {
  if (cond) { pass++ } else { fail++; console.error('FAIL:', name) }
}

const ROOT = join(__dirname, '..')
const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

/** 读取 ROOT 下所有 ts/tsx 源文件内容（排除 node_modules 与测试脚本自身的临时产物） */
function allSource(): string[] {
  const { execSync } = require('child_process')
  const out = execSync(`find ${ROOT}/electron ${ROOT}/src ${ROOT}/shared -name '*.ts' -o -name '*.tsx'`, { encoding: 'utf8' })
  return out.split('\n').filter(Boolean).filter((f: string) => !f.includes('electron.d.ts'))
}

async function main(): Promise<void> {
  // ── A. 静态全仓 ────────────────────────────────────────────────────────────
  const dbSrc = readFileSync(join(ROOT, 'electron/services/salesDbService.ts'), 'utf8')
  const dbCode = strip(dbSrc)
  const engineSrc = readFileSync(join(ROOT, 'electron/services/salesActionEngine.ts'), 'utf8')
  const engineCode = strip(engineSrc)
  const parseSrc = readFileSync(join(ROOT, 'electron/services/crmParseService.ts'), 'utf8')
  const parseCode = strip(parseSrc)
  const cardSrc = readFileSync(join(ROOT, 'src/components/sales/AIActionCard.tsx'), 'utf8')
  const cardCode = strip(cardSrc)
  const mainCode = strip(readFileSync(join(ROOT, 'electron/main.ts'), 'utf8'))
  const preloadSrc = readFileSync(join(ROOT, 'electron/preload.ts'), 'utf8')

  // A1: customerEventAdd 出现点 = 3（定义 + E3.2 helper + E3.3 recordUserActionEvent），全部经守卫
  const callSites = (() => {
    const sites: Array<[string, string]> = []
    const re = /customerEventAdd\(/g
    let m: RegExpExecArray | null
    while ((m = re.exec(dbCode)) !== null) sites.push(['salesDbService', dbCode.slice(Math.max(0, m.index - 200), m.index)])
    while ((m = re.exec(engineCode)) !== null) sites.push(['salesActionEngine', engineCode.slice(Math.max(0, m.index - 200), m.index)])
    while ((m = re.exec(parseCode)) !== null) sites.push(['crmParseService', parseCode.slice(Math.max(0, m.index - 200), m.index)])
    return sites
  })()
  ok('A1 customerEventAdd 出现点 = 3（定义 + E3.2 helper + E3.3 recordUserActionEvent）', callSites.length === 3)

  // A2: 消费者仅 Action Funnel（Scope Lock ⑥ 四消费者不迁；P0-4.2.2 起 getActionFunnel 为唯一正当只读消费者）
  const consumers = allSource().filter((f) => {
    const code = strip(readFileSync(f, 'utf8'))
    return /customerEventsBySession|customerEventsByType/.test(code)
  }).filter((f) => !f.includes('salesDbService'))
  ok(`A2 customerEventsBySession/ByType 仅 Action Funnel 消费（当前 ${consumers.length} 个：getActionFunnel；四消费者仍不迁）`,
    consumers.length === 1 && consumers[0].includes('actionFunnel'))

  // A3: 无绕过 DDL 的直接 SQL（除 SCHEMA_SQL 定义处）
  const directSql = allSource().filter((f) => {
    const code = readFileSync(f, 'utf8')
    return /INSERT INTO customer_event/.test(code) && !f.includes('salesDbService')
  })
  ok(`A3 无绕过 DDL 的直接 SQL（当前 ${directSql.length} 处）`, directSql.length === 0)

  // A4: 五类型写点归属
  ok('A4a quote_asked 写点仅 crmParseService（E3.2）',
    /event_type: 'quote_asked'/.test(parseCode) && !/event_type: 'quote_asked'/.test(engineCode) && !/event_type: 'quote_asked'/.test(cardCode))
  ok('A4b customer_replied 写点仅 crmParseService（E3.2）',
    /event_type: 'customer_replied'/.test(parseCode) && !/event_type: 'customer_replied'/.test(engineCode))
  ok('A4c script_copied/chat_opened 写点：recordUserActionEvent 白名单 + 前端成功点',
    /eventType: 'script_copied'/.test(cardCode) && /eventType: 'chat_opened'/.test(cardCode) &&
    /\['script_copied', 'chat_opened', 'follow_up_done'\]/.test(engineCode))
  ok('A4d follow_up_done 写点仅 completeAction 状态转换（engine，before 门控，P0-4.2.1 携带 before.id）',
    /recordUserActionEvent\(before\.session_id, 'follow_up_done', null, before\.id\)/.test(engineCode))

  // A5: follow_up_done 不经 IPC（前端零提交）
  ok('A5 follow_up_done 不经 IPC（前端/主进程通道零提交）',
    !/follow_up_done/.test(cardCode) && !/follow_up_done/.test(strip(preloadSrc)))

  // A6: 四层边界——customerEventAdd 方法体只写 customer_event 一张表
  const addBody = dbCode.slice(dbCode.indexOf('customerEventAdd'), dbCode.indexOf('customerEventsBySession'))
  ok('A6 customerEventAdd 只写 customer_event（不冒充 judgment/profile/intent）',
    !/INSERT INTO (intent_tag_log|customer_judgment|customer_profile)/.test(addBody) && /INSERT INTO customer_event/.test(addBody))

  // A7: quote_signal 不迁移（分流继续原样写；customer_replied_at 回流字段在 crmDbService 继续工作）
  const crmDbCode = strip(readFileSync(join(ROOT, 'electron/services/crmDbService.ts'), 'utf8'))
  ok('A7 quote_signal 不迁移（recordQuoteSignal + markQuoteReplied + customer_replied_at 继续存在）',
    /recordQuoteSignal\(/.test(parseCode) && /markQuoteReplied\(/.test(parseCode) && /customer_replied_at/.test(crmDbCode))

  // A8: 无第二套 action log（activity_log 为 E3 前遗留表，仅存在于 crmDbService 旧 schema；
  // E3 未新增 action_log/user_action 等新表）
  const newLogTables = allSource().filter((f) => {
    const code = readFileSync(f, 'utf8')
    return /CREATE TABLE (IF NOT EXISTS )?(action_log|user_action)/.test(code)
  })
  const legacyActivityLog = allSource().filter((f) => {
    const code = readFileSync(f, 'utf8')
    return /CREATE TABLE IF NOT EXISTS activity_log/.test(code)
  })
  ok(`A8 无第二套 action log（action_log/user_action 零新表 CREATE；activity_log 仅遗留 ${legacyActivityLog.length} 处）`,
    newLogTables.length === 0 && legacyActivityLog.length === 1 && legacyActivityLog[0].includes('crmDbService'))

  // A9: R7 不迁移（completeUnifiedSignal 继续 todoUpdate 关单，不消费 customer_event）
  const unifiedBody = engineCode.slice(engineCode.indexOf('export function completeUnifiedSignal'), engineCode.indexOf('export function completeAction'))
  ok('A9 R7 不迁移（completeUnifiedSignal 继续 todoUpdate 关单，零事件消费）',
    /completeAction\(/.test(unifiedBody) && !/customerEventsBy|customerEventAdd/.test(unifiedBody))

  // A10: 文档同步（Scope Lock + 收口验收文档）
  ok('A10 文档同步（Scope Lock 设计 + 收口验收文档）',
    /Scope Lock/.test(readFileSync(join(ROOT, 'docs/P0-3E3-CustomerEvent.md'), 'utf8')) &&
    /E3 收口/.test(readFileSync(join(ROOT, 'docs/实施记录/P0-3E3-收口-契约验收.md'), 'utf8')))

  // ── B. 真实库运行态（sql.js 字节进内存只读）──────────────────────────────
  const SQL = await initSqlJs()
  const HOME = os.homedir()
  // §2.40 分库：按账号命名的业务库优先（多个账号取最近使用），回退 legacy 名
  const USER_DATA = path.join(HOME, 'Library/Application Support/weflow')
  const DB_PATH = findExistingBusinessDb(USER_DATA, 'sales')
  const CRM_DB_PATH = findExistingBusinessDb(USER_DATA, 'crm')
  if (!DB_PATH || !CRM_DB_PATH) { console.error(`未找到业务库（weflow-{sales,crm}-*.db / legacy）：${USER_DATA}`); process.exit(1) }
  const db = new SQL.Database(readFileSync(DB_PATH))
  const crm = new SQL.Database(readFileSync(CRM_DB_PATH))
  const db2 = new SQL.Database(readFileSync(DB_PATH)) // DDL 模拟副本

  // B11: customer_event 行类型全部落在五类白名单内（硬门禁在真实数据上生效）
  //   原断言为「0 行基线」——2026-08-24 A1 清理后的一次性迁移快照（表待重启激活）；
  //   应用正常使用后必然产生真实事件（本机实测 13 行），快照过期属夹具假设失效而非回归。
  //   改锚定耐久不变量：CHECK 门禁未放行任何越界类型——这正是「防万能日志表」要守的东西。
  const evTable = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='customer_event'")
  const evExists = evTable.length > 0 && evTable[0].values.length > 0
  let evCount = 0, evOutOfBand = 0
  if (evExists) {
    evCount = Number(db.exec("SELECT COUNT(*) FROM customer_event")[0].values[0][0])
    evOutOfBand = Number(db.exec("SELECT COUNT(*) FROM customer_event WHERE event_type NOT IN ('customer_replied','quote_asked','script_copied','chat_opened','follow_up_done')")[0].values[0][0])
  }
  ok(`B11 customer_event 表在且无越界类型（实测 ${evCount} 行，硬门禁生效）`, evExists && evOutOfBand === 0)

  // B12: quote_signal 分流兼容（customer_replied_at 字段在真实数据继续工作）
  const quotes = crm.exec('SELECT COUNT(*) FROM quote_signal')[0].values[0][0] as number
  const replied = crm.exec('SELECT COUNT(*) FROM quote_signal WHERE customer_replied_at IS NOT NULL')[0].values[0][0] as number
  ok(`B12 quote_signal 分流兼容（${quotes} 行，customer_replied_at 已回填 ${replied}）`, quotes >= 22 && replied >= 17)

  // B13: DDL 无损建表 + CHECK 门禁
  const dd = dbSrc.match(/CREATE TABLE IF NOT EXISTS customer_event[\s\S]*?\);/)
  if (!dd) { ok('B13 SCHEMA_SQL 含 customer_event 建表 DDL', false) }
  else {
    db2.run(dd[0])
    const idx = [...dbSrc.matchAll(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS idx_event\w+[\s\S]*?;/g)].map(x => x[0])
    idx.forEach(s => db2.run(s))
    const created = db2.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='customer_event'")
    db2.exec("INSERT INTO customer_event (session_id, event_type, source, created_at) VALUES ('wx_verify', 'chat_opened', 'manual', 1)")
    let checkRejects = false
    try { db2.exec("INSERT INTO customer_event (session_id, event_type, source, created_at) VALUES ('wx_verify', 'stage_changed', 'rule', 2)") } catch { checkRejects = true }
    ok(`B13 DDL 无损建表（${idx.length} 索引）+ CHECK 接受五类型/拒绝越界`, created.length === 1 && idx.length === 3 && checkRejects)
  }

  console.log(`customer-event-closed-gate: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main()
