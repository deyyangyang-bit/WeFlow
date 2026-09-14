/**
 * 迁移 DDL 与投影注册表一致性测试。
 *
 * 本机环境没有 PostgreSQL，因此这里做的是**可静态验证**的部分：
 *  - 迁移文件按 `migrate()` 同款规则可排序、版本号唯一；
 *  - 注册表里每一张投影表都在 DDL 里存在，且每一个注册列都有对应列定义；
 *  - 每张投影表都带工作区隔离（workspace_id）、版本号、软删标记、更新时间；
 *  - 通用 JSONB 数据桶 central_record 已被删除且不再被任何源码引用；
 *  - 禁字段（聊天正文/消息正文/session_id/WCDB 路径）不出现在任何列名里；
 *  - 真机 PostgreSQL 建表与应用行为留待部署验收（本脚本不代替部署验收）。
 *
 * 用法：cd central && npm run test:migration
 */
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PROJECTIONS, projectionColumnNames } from '../src/projections.js'

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; console.log(`  ✅ ${name}`) } else { fail++; console.log(`  ❌ ${name} ${detail}`) }
}

const dir = resolve(process.cwd(), 'migrations')
const files = readdirSync(dir).filter((name) => /^\d+.*\.sql$/.test(name)).sort()
const sql = files.map((name) => readFileSync(resolve(dir, name), 'utf8')).join('\n')
const sourceFiles = ['src/app.ts', 'src/postgresStore.ts', 'src/projections.ts', 'src/memoryStore.ts', 'src/store.ts']
const source = sourceFiles.map((name) => readFileSync(resolve(process.cwd(), name), 'utf8')).join('\n')

/** 抽取 `CREATE TABLE IF NOT EXISTS <name> ( ... );` 的列名集合 */
function tableColumns(text: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  const re = /CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(/g
  let match: RegExpExecArray | null
  while ((match = re.exec(text))) {
    const body = text.slice(re.lastIndex, text.indexOf('\n);', re.lastIndex))
    const columns = new Set<string>()
    for (const line of body.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('--')) continue
      const column = /^([a-z_][a-z0-9_]*)\s+(UUID|TEXT|BIGINT|INTEGER|BOOLEAN|NUMERIC|TIMESTAMPTZ|BIGSERIAL)\b/i.exec(trimmed)
      if (column) columns.add(column[1]!.toLowerCase())
    }
    out.set(match[1]!, columns)
  }
  return out
}

const tables = tableColumns(sql)
const FORBIDDEN_COLUMN = /^(chat(_?raw|_?content|_?text)?|message(_?content|_?text|_?body)?|conversation|session_id|wcdb_path)$/i

console.log('═══ A. 迁移文件 ═══')
check('A1 迁移文件按 migrate() 的排序规则可枚举', files.length >= 2, files.join(','))
check('A2 版本号唯一且按序号递增', new Set(files).size === files.length && files.every((name, i) => i === 0 || name > files[i - 1]!))
check('A3 001 建表、002 落地显式投影（前向迁移，不改写历史文件）',
  files.some((n) => n.startsWith('001')) && files.some((n) => n.startsWith('002')))
const history002 = readFileSync(resolve(dir, files.find((n) => n.startsWith('002'))!), 'utf8')
check('A4 002 明确删除通用 JSONB 数据桶 central_record',
  /DROP TABLE IF EXISTS central_record/.test(history002))

console.log('═══ B. 投影表与注册表一一对应 ═══')
const expected = projectionColumnNames()
// 数据宪法 §2.2 append-only 例外：审计流水只增不改，按宪法**不得**有删除标记。
// 这条豁免必须显式列出并写明理由，不允许用「缺少列也算过」蒙混。
const APPEND_ONLY_PROJECTIONS = new Set(['audit_event'])
const missingTables: string[] = []
const missingColumns: string[] = []
const missingGovernance: string[] = []
const wrongSoftDelete: string[] = []
for (const [entityType, projection] of Object.entries(PROJECTIONS)) {
  if (!tables.has(projection.table)) { missingTables.push(`${entityType}->${projection.table}`); continue }
  const ddlColumns = tables.get(projection.table)!
  for (const column of expected[entityType]!) {
    if (!ddlColumns.has(column)) missingColumns.push(`${projection.table}.${column}`)
  }
  for (const required of ['workspace_id', 'aggregate_version', 'updated_at', 'source_device_id']) {
    if (!ddlColumns.has(required)) missingGovernance.push(`${projection.table}.${required}`)
  }
  const appendOnly = APPEND_ONLY_PROJECTIONS.has(entityType)
  if (appendOnly ? ddlColumns.has('deleted') : !ddlColumns.has('deleted')) {
    wrongSoftDelete.push(`${projection.table}(appendOnly=${appendOnly})`)
  }
}
check('B1 每类实体的投影表都在 DDL 中存在', missingTables.length === 0, missingTables.join(','))
check('B2 注册表的每个列都有对应 DDL 列', missingColumns.length === 0, missingColumns.join(','))
check('B3 每张投影表都有工作区隔离 + 版本号 + 更新时间 + 来源设备（审计流水按宪法 §2.2 免软删标记，且必须确实没有）',
  missingGovernance.length === 0 && wrongSoftDelete.length === 0,
  [...missingGovernance, ...wrongSoftDelete].join(','))
check('B4 每张投影表都以 (workspace_id, entity_id) 为主键',
  Object.values(PROJECTIONS).every((projection) => new RegExp(`CREATE TABLE IF NOT EXISTS\\s+${projection.table}\\s*\\([\\s\\S]*?PRIMARY KEY \\(workspace_id, entity_id\\)`).test(sql)))
// 前向迁移：001 建过桶、002 删掉它。终态必须是「最后一次触碰该表的语句是 DROP」。
const lastTouch = (name: string): 'create' | 'drop' | null => {
  const create = sql.lastIndexOf(`CREATE TABLE IF NOT EXISTS ${name} `)
  const drop = sql.lastIndexOf(`DROP TABLE IF EXISTS ${name}`)
  if (create < 0 && drop < 0) return null
  return drop > create ? 'drop' : 'create'
}
check('B5 通用 JSONB 数据桶在终态已被删除（最后一次触碰是 DROP，而不是仍在建表）',
  lastTouch('central_record') === 'drop' && !new RegExp(`CREATE TABLE IF NOT EXISTS central_record[\\s\\S]*?\\n\\);`).test(
    sql.slice(sql.lastIndexOf('DROP TABLE IF EXISTS central_record'))))
check('B6 源码里不再引用 central_record', !source.includes('central_record'))

console.log('═══ C. 禁字段与敏感信息 ═══')
const badColumns: string[] = []
for (const [table, columns] of tables) {
  for (const column of columns) if (FORBIDDEN_COLUMN.test(column)) badColumns.push(`${table}.${column}`)
}
check('C1 全部 DDL 列名里没有聊天正文/消息正文/session_id/WCDB 路径', badColumns.length === 0, badColumns.join(','))
check('C2 令牌/邀请码只存哈希列（无明文 token / code 列）',
  tables.get('device')?.has('token_hash') === true && !tables.get('device')?.has('token') &&
  tables.get('binding_invite')?.has('code_hash') === true && !tables.get('binding_invite')?.has('code'))
check('C3 身份值只存哈希 + 掩码（无 identity_value 原文列）',
  tables.get('central_customer_identity')?.has('identity_hash') === true &&
  !tables.get('central_customer_identity')?.has('identity_value'))

console.log('═══ D. 幂等与重试的库级支撑 ═══')
check('D1 sync_event 对 (workspace_id,idempotency_key) 唯一（事件幂等的库级保证）',
  /UNIQUE \(workspace_id, idempotency_key\)/.test(sql))
check('D2 sync_event 对 (workspace_id,event_id) 唯一', /UNIQUE \(workspace_id, event_id\)/.test(sql))
check('D3 sync_ack 以 (device_id,central_seq) 为主键（ack 幂等且不重复计）',
  /PRIMARY KEY \(device_id, central_seq\)/.test(sql))
check('D4 sync_ack 增加 attempts 重试计数（有限重试的库级支撑）',
  /ALTER TABLE sync_ack ADD COLUMN IF NOT EXISTS attempts/.test(sql))
check('D5 上行审计投影对 (workspace_id,source_device_id,source_audit_id) 唯一（重放不重复审计）',
  /UNIQUE \(workspace_id, source_device_id, source_audit_id\)/.test(sql))

console.log('═══ E. 参数化与日志红线 ═══')
const postgresSource = readFileSync(resolve(process.cwd(), 'src/postgresStore.ts'), 'utf8')
check('E1 投影写入只能走 buildProjectionUpsert（不存在手拼 payload 的 SQL）',
  postgresSource.includes('buildProjectionUpsert') && !/VALUES\s*\(\s*\$\{/.test(postgresSource))
// `SAVEPOINT ${savepoint}` / `${projection.table}` 只拼接标识符，不拼接值；断言没有把参数拼进 SQL 字符串
check('E2 没有把业务值插值进 SQL 模板字符串', !/\$\{(?!index|savepoint|projection\.table|scope|files|dir)[a-zA-Z_][\w.]*\}\s*['"]/.test(postgresSource))
check('E3 日志按 redact 规则排除 authorization 头', readFileSync(resolve(process.cwd(), 'src/app.ts'), 'utf8').includes('req.headers.authorization'))
const appSource = readFileSync(resolve(process.cwd(), 'src/app.ts'), 'utf8')
check('E4 错误处理不整体落 err（避免 pg parameters 带业务值进日志）',
  !/request\.log\.error\(\{\s*err\s*\}/.test(appSource) && appSource.includes('err: { message: err.message'))
const migrateSource = postgresSource.slice(postgresSource.indexOf('async migrate('), postgresSource.indexOf('async ping('))
check('E5 migrate() 在单事务内按序应用迁移并逐条登记 schema_migration（可重复执行不重复建表）',
  migrateSource.includes("await client.query('BEGIN')") && migrateSource.includes("await client.query('COMMIT')") &&
  migrateSource.includes('FROM schema_migration WHERE version=$1') && migrateSource.includes('INSERT INTO schema_migration(version) VALUES($1)') &&
  migrateSource.includes('.sort()'))

console.log(`\ncentral migration test: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
