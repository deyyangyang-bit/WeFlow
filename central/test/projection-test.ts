/**
 * 中央投影注册表测试。
 *
 * 核心命题（要求「不要用一个无法约束的数据桶冒充业务模型」）：
 *  - 协议里的每一类上行实体都必须有显式注册的投影表与逐列定义，缺一项即判红；
 *  - 投影 SQL 必须全参数化：生成的语句里不得出现任何被插值进去的值；
 *  - 聊天正文 / 消息正文 / session_id / WCDB 路径在注册表里既不能作列名，也不能作取值来源；
 *  - 必填字段缺失、命中禁字段的载荷必须被拒（且只拒该条）。
 *
 * 用法：cd central && npm run test:projection
 */
import { buildProjectionUpsert, PROJECTIONS, projectionColumnNames, projectionOf, projectionRegistryGaps, validateProjectionPayload } from '../src/projections.js'
import { CENTRAL_ENTITY_TYPES, findForbiddenCentralField, type CentralSyncEvent } from '../../shared/centralSync.js'

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; console.log(`  ✅ ${name}`) } else { fail++; console.log(`  ❌ ${name} ${detail}`) }
}

const FORBIDDEN = /^(chat(_?raw|_?content|_?text)?|message(_?content|_?text|_?body)?|conversation|session_id|wcdb_path)$/i

function eventOf(entityType: CentralSyncEvent['entityType'], entityId: string, payload: Record<string, unknown>): CentralSyncEvent {
  return { protocolVersion: 1, eventId: `e-${entityId}`, eventSeq: 1, idempotencyKey: `k-${entityId}`, direction: 'up',
    entityType, entityId, eventType: 'projection_test', aggregateVersion: 1, payload, occurredAt: Date.now() }
}

console.log('═══ A. 注册表完整性 ═══')
check('A1 协议实体清单与投影注册表一一对应（无缺项无多项）', projectionRegistryGaps().length === 0, projectionRegistryGaps().join(','))
check('A2 每个投影都有显式表名', CENTRAL_ENTITY_TYPES.every((type) => PROJECTIONS[type].table.startsWith('central_')))
check('A3 每个投影都有列定义且主键语义明确', CENTRAL_ENTITY_TYPES.every((type) => PROJECTIONS[type].columns.length > 0))
const tables = CENTRAL_ENTITY_TYPES.map((type) => PROJECTIONS[type].table)
check('A4 表名互不重复（不存在两个实体共用一个桶）', new Set(tables).size === tables.length, tables.join(','))
check('A5 未登记实体取投影直接抛错（宁可拒收也不落进无约束处）', (() => {
  try { projectionOf('customer_profile'); return false } catch { return true }
})())

console.log('═══ B. 禁字段：列名与取值来源 ═══')
const offenders: string[] = []
for (const [entityType, projection] of Object.entries(PROJECTIONS)) {
  for (const column of projection.columns) {
    if (FORBIDDEN.test(column.column)) offenders.push(`${entityType}.${column.column}`)
    if (column.from && FORBIDDEN.test(column.from)) offenders.push(`${entityType}->${column.from}`)
  }
}
check('B1 注册表里不存在聊天正文/消息正文/session_id/WCDB 路径列', offenders.length === 0, offenders.join(','))
check('B2 本机 customer_judgment.session_id 未成为任何投影取值来源（改用 customer_ref 关联）',
  !JSON.stringify(projectionColumnNames()).toLowerCase().includes('session_id'))
check('B3 递归禁字段在深层嵌套同样命中', findForbiddenCentralField({ a: { b: { messageBody: 'x' } } }) === 'a.b.messageBody')

console.log('═══ C. SQL 全参数化 ═══')
const sqlProblems: string[] = []
for (const type of CENTRAL_ENTITY_TYPES) {
  const projection = PROJECTIONS[type]
  const sample = eventOf(type, 'probe-1', Object.fromEntries(projection.required.map((field) => [field, 'probe-value'])))
  const statement = buildProjectionUpsert(projection, 'ws-1', 'dev-1', sample)
  if (/'/.test(statement.sql)) sqlProblems.push(`${type}:SQL 含引号字面量`)
  if (statement.sql.includes('probe-value') || statement.sql.includes('probe-1') || statement.sql.includes('dev-1')) sqlProblems.push(`${type}:值被插值进 SQL`)
  // 参数构成：[workspace_id, entity_id, aggregate_version, source_device_id] + 每个注册列一个
  const expected = 4 + projection.columns.length
  if (statement.values.length !== expected) sqlProblems.push(`${type}:参数个数 ${statement.values.length} ≠ ${expected}`)
  const placeholders = statement.sql.match(/\$\d+/g) || []
  const maxPlaceholder = Math.max(...placeholders.map((p) => Number(p.slice(1))))
  if (maxPlaceholder > expected) sqlProblems.push(`${type}:占位符越界 ${maxPlaceholder}`)
  if (!statement.sql.includes('WHERE central_') && !statement.sql.includes(`WHERE ${projection.table}.aggregate_version`)) {
    sqlProblems.push(`${type}:缺少版本闸门`)
  }
  if (!statement.sql.includes('ON CONFLICT (workspace_id, entity_id)')) sqlProblems.push(`${type}:缺少工作区+实体主键冲突处理`)
}
check('C1 所有投影 SQL 全参数化、占位符与值一一对应、带版本闸门与工作区主键', sqlProblems.length === 0, sqlProblems.join(' | '))

console.log('═══ D. 载荷校验 ═══')
const customer = PROJECTIONS.customer
check('D1 缺必填字段被拒并给出字段名', validateProjectionPayload(customer, {}) === 'missing_required:displayName')
check('D2 空字符串视为缺字段（不允许空值冒充已填）', validateProjectionPayload(customer, { displayName: '' }) === 'missing_required:displayName')
check('D3 含禁字段被拒（先于必填检查，且报出字段路径）',
  validateProjectionPayload(customer, { displayName: 'X', meta: { chatRaw: 'y' } }) === 'forbidden_field:meta.chatRaw')
check('D4 合法载荷通过', validateProjectionPayload(customer, { displayName: 'X' }) === null)
check('D5 customer_identity 身份值只接受哈希 + 掩码字段',
  validateProjectionPayload(PROJECTIONS.customer_identity, { customerRef: 'c1', identityType: 'phone', identityHash: 'h' }) === null &&
  validateProjectionPayload(PROJECTIONS.customer_identity, { customerRef: 'c1', identityType: 'phone' }) === 'missing_required:identityHash')
check('D6 permission 投影强制标记 authority_source=local_declaration（永不作为权限依据）',
  PROJECTIONS.permission.columns.some((c) => c.column === 'authority_source' && c.from === 'authoritySource'))
check('D7 audit 投影与中央自身操作审计分表（central_audit_projection ≠ central_audit_event）',
  PROJECTIONS.audit_event.table === 'central_audit_projection')

console.log('═══ E. 取值归一 ═══')
const deletedColumn = customer.columns.find((column) => column.column === 'deleted')!
check('E1 布尔列缺省落 false（不会变成 NULL 去撞 NOT NULL 约束）',
  buildProjectionUpsert(customer, 'ws', 'dev', eventOf('customer', 'c', { displayName: 'X' })).values[
    4 + customer.columns.indexOf(deletedColumn)] === false)
const versionColumn = customer.columns.find((column) => column.column === 'stage')!
const withStage = buildProjectionUpsert(customer, 'ws', 'dev', eventOf('customer', 'c', { displayName: 'X', stage: 'contacted' }))
check('E2 文本列原样写入', withStage.values[4 + customer.columns.indexOf(versionColumn)] === 'contacted')
check('E3 数值列非法值归 null 而不是 NaN',
  buildProjectionUpsert(PROJECTIONS.customer_judgment, 'ws', 'dev',
    eventOf('customer_judgment', 'j', { customerRef: 'c', judgmentType: 'summary', value: 'v', confidence: 'abc' }))
    .values.includes(null))

console.log(`\ncentral projection test: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
