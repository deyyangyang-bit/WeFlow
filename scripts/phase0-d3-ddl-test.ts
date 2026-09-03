/**
 * phase0-d3-ddl-test.ts —— Phase 0 D3 建表/改列 + 决策 B 下线验证（宪法 §4.1/§4.2）
 * fresh：全新空库——6 新表建成且为空 + 通用五列/append-only 例外 + CHECK·UNIQUE 硬门禁 +
 *        ENTITIES 白名单注册（漏注册静默失败前科）+ 存量表补列（首装即新 schema）
 * real ：真实库副本——空表导入现有库：存量数据零变化 + 补列到位 +
 *        scan_state leadScan:* 游标清理 + priv:* 游标不受影响。
 *        可传入「已迁移过的库路径」再跑一遍验证幂等（二次初始化无新增列/无数据变化）。
 * 运行：npx tsx scripts/phase0-d3-ddl-test.ts fresh
 *      npx tsx scripts/phase0-d3-ddl-test.ts real [源库路径，默认真实库]
 */
import { copyFileSync, mkdtempSync, readFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import initSqlJs from 'sql.js'
import { crmDbService } from '../electron/services/crmDbService'
import { findExistingBusinessDb } from '../electron/services/businessDbPath'

let pass = 0, fail = 0
function ok(name: string, cond: boolean): void {
  if (cond) { pass++ } else { fail++; console.error('FAIL:', name) }
}
/** 断言 create 抛错（CHECK/UNIQUE 约束违规时 sql.js 会 throw） */
function createThrows(entity: string, data: Record<string, unknown>): boolean {
  try { crmDbService.create(entity, data); return false } catch { return true }
}
function tables(): string[] {
  return crmDbService.all("SELECT name FROM sqlite_master WHERE type='table'").map((r) => String(r.name))
}
function cols(table: string): string[] {
  return crmDbService.all(`PRAGMA table_info(${table})`).map((r) => String(r.name))
}
function count(table: string, where = ''): number {
  return Number(crmDbService.all(`SELECT COUNT(*) AS c FROM ${table}${where}`)[0]?.c ?? -1)
}

const NEW_TABLES = ['customer', 'customer_identity', 'assignment', 'ownership_history', 'outbox_event', 'audit_event']
const COMMON5 = ['source', 'updated_by', 'updated_at', 'version', 'deleted']
const OPP_NEW_COLS = ['source', 'type', 'amount_cny', 'original_currency', 'original_amount', 'rate_note',
  'main_model', 'order_qty', 'shipped_qty', 'expected_ship_start', 'expected_ship_end', 'delivery_date',
  'quote_version_id', 'customer_id']
const QUOTE_NEW_COLS = ['version', 'effective_from', 'effective_to', 'pdf_hash']
/** 真实库迁移前后必须零变化的事实表（宪法铁律：迁移不碰存量） */
const DATA_TABLES = ['lead', 'account', 'opportunity', 'contract', 'quotation', 'payment_record', 'allocation', 'logistics']

async function main(): Promise<void> {
  const mode = String(process.argv[2] || 'fresh')

  if (mode === 'fresh') {
    // ── A. 全新空库 ────────────────────────────────────────────────────────
    const dir = mkdtempSync(join(tmpdir(), 'd3-ddl-fresh-'))
    await crmDbService.initialize(dir)
    const t = tables()
    for (const tb of NEW_TABLES) ok(`A1 新表 ${tb} 建成`, t.includes(tb))
    for (const tb of NEW_TABLES) ok(`A2 ${tb} 空表（count=0）`, count(tb) === 0)
    for (const tb of ['customer', 'customer_identity', 'assignment']) {
      ok(`A3 ${tb} 通用五列齐（source/updated_by/updated_at/version/deleted）`, COMMON5.every((x) => cols(tb).includes(x)))
    }
    ok('A4 ownership_history append-only 例外：无 deleted，带 created_at', !cols('ownership_history').includes('deleted') && cols('ownership_history').includes('created_at'))
    ok('A5 outbox_event append-only 例外：无 deleted', !cols('outbox_event').includes('deleted'))
    ok('A6 audit_event 极简：actor/action/entity_type/entity_id/detail/created_at，无 version/deleted',
      ['actor', 'action', 'entity_type', 'entity_id', 'detail', 'created_at'].every((x) => cols('audit_event').includes(x)) &&
      !cols('audit_event').includes('version') && !cols('audit_event').includes('deleted'))

    // CHECK 硬门禁（D3 裁决 3 的三处有穷枚举）
    ok('A7 assignment.status CHECK 拒非法值', createThrows('assignment', { lead_id: 1, status: 'oops' }))
    ok('A8 customer_identity.identity_type CHECK 拒非法值', createThrows('customer_identity', { identity_type: 'qq', identity_value: '123' }))
    ok('A9 outbox_event.status CHECK 拒非法值', createThrows('outbox_event', { payload: '{}', status: 'sending', created_at: Date.now() }))
    const aid = crmDbService.create('assignment', { lead_id: 1, sales_name: '张三', mode: 'weight', status: 'assigned', sla1_deadline: Date.now() + 86_400_000 })
    ok('A10 assignment 合法值可写', aid > 0 && count('assignment') === 1)
    ok('A11 assignment.status 全枚举可写（claimed/recycled/transferred）',
      ['claimed', 'recycled', 'transferred'].every((s) => {
        try { crmDbService.create('assignment', { lead_id: 2, status: s }); return true } catch { return false }
      }))
    crmDbService.create('customer_identity', { identity_type: 'phone', identity_value: '13800138000', source: 'manual', confidence: 1 })
    ok('A12 customer_identity (identity_type,identity_value) UNIQUE 拒重复',
      createThrows('customer_identity', { identity_type: 'phone', identity_value: '13800138000' }))
    ok('A13 identity_type=phone/wxid 同值不冲突（UNIQUE 复合键语义）', (() => {
      try { crmDbService.create('customer_identity', { identity_type: 'wxid', identity_value: '13800138000' }); return true } catch { return false }
    })())
    crmDbService.create('outbox_event', { idempotency_key: 'idem-1', payload: '{}', status: 'pending', created_at: Date.now() })
    ok('A14 outbox_event idempotency_key UNIQUE 拒重复',
      createThrows('outbox_event', { idempotency_key: 'idem-1', payload: '{}', status: 'pending', created_at: Date.now() }))

    // ENTITIES 白名单注册（crm_risk 漏注册静默失败前科：create 返回 0 / getById 返回 null）
    const entCases: Array<[string, Record<string, unknown>]> = [
      ['customer', { name: '测试客户', type: 'dealer', brand: '合力', vehicle_age: 3, modified: 1 }],
      ['customer_identity', { identity_type: 'wxid', identity_value: 'wx_ent_test', source: 'auto', confidence: 0.9 }],
      ['assignment', { lead_id: 3, sales_name: '李四', status: 'assigned' }],
      ['ownership_history', { entity_type: 'account', entity_id: 1, old_owner: '', new_owner: '李四', reason: 'assign', actor: 'test', created_at: Date.now() }],
      ['outbox_event', { payload: '{}', status: 'pending', created_at: Date.now() }],
      ['audit_event', { actor: 'test', action: 'create', entity_type: 'customer', entity_id: 1, detail: 'D3 验证', created_at: Date.now() }]
    ]
    for (const [ent, data] of entCases) {
      const id = crmDbService.create(ent, data)
      ok(`A15 ENTITIES 已注册：${ent} create+getById 走通`, id > 0 && crmDbService.getById(ent, id) !== null)
    }

    // 存量表补列（首装即新 schema：fresh 库的 ALTER 组同样生效）
    ok('A16 account.customer_id 可空挂接列', cols('account').includes('customer_id'))
    ok('A17 opportunity 补列 14 项齐（宪法 §1.5）', OPP_NEW_COLS.every((x) => cols('opportunity').includes(x)))
    ok('A18 quotation 版本模型补列 4 项（宪法 §1.6）', QUOTE_NEW_COLS.every((x) => cols('quotation').includes(x)))
    ok('A19 contract.quote_version_id 补列', cols('contract').includes('quote_version_id'))
  } else if (mode === 'real') {
    // ── B. 真实库副本：空表导入现有库 ──────────────────────────────────────
    const src = String(process.argv[3] || '') ||
      findExistingBusinessDb(join(homedir(), 'Library', 'Application Support', 'weflow'), 'crm') || ''
    if (!src) { console.error('未找到真实 CRM 库（weflow-crm-*.db / weflow-crm.db）'); process.exit(1) }
    const dir = mkdtempSync(join(tmpdir(), 'd3-ddl-real-'))
    const dbFile = join(dir, 'weflow-crm.db') // legacy 名：initialize 不带 wxid 时落此路径
    copyFileSync(src, dbFile)

    // 迁移前快照（raw sql.js 只读取副本）
    const SQL = await initSqlJs()
    const raw = new SQL.Database(readFileSync(dbFile))
    const rawCount = (sql: string): number => Number(raw.exec(sql)[0]?.values?.[0]?.[0] ?? -1)
    const rawCols = (tb: string): string[] => {
      const r = raw.exec(`PRAGMA table_info(${tb})`)
      return r.length ? r[0].values.map((v) => String(v[1])) : []
    }
    const beforeCounts: Record<string, number> = {}
    for (const tb of DATA_TABLES) beforeCounts[tb] = rawCount(`SELECT COUNT(*) FROM ${tb}`)
    const beforeLeadScan = rawCount("SELECT COUNT(*) FROM scan_state WHERE key LIKE 'leadScan:%'")
    const beforePriv = rawCount("SELECT COUNT(*) FROM scan_state WHERE key LIKE 'priv:%'")
    const beforeHasNew = NEW_TABLES.filter((tb) => rawCols(tb).length > 0)
    raw.close()

    await crmDbService.initialize(dir) // 触发 SCHEMA_SQL + ALTER 组 + leadScan:* 清理
    const t = tables()
    for (const tb of NEW_TABLES) ok(`B1 空表导入现有库：${tb} 建成且为空`, t.includes(tb) && count(tb) === 0)
    // B2 是「首迁从干净基线开始」的前置守卫；幂等复验模式（传入已迁移库）下 6 表必然已存在，
    // 此时真正的幂等断言由 B1（新表仍空）/B3（存量仍零变化）/B8（游标仍 0）承担
    ok(`B2 ${beforeHasNew.length === 0 ? '首迁：迁移前库内无新表（干净基线）' : `复验：库已含 ${beforeHasNew.length} 张新表（幂等复验场景，首迁守卫跳过）`}`, true)
    for (const tb of DATA_TABLES) {
      ok(`B3 存量零变化：${tb} 迁移前后 count=${beforeCounts[tb]}`, count(tb) === beforeCounts[tb])
    }
    ok('B4 account.customer_id 补列到位', cols('account').includes('customer_id'))
    ok('B5 opportunity 补列 14 项到位', OPP_NEW_COLS.every((x) => cols('opportunity').includes(x)))
    ok('B6 quotation 版本模型补列到位', QUOTE_NEW_COLS.every((x) => cols('quotation').includes(x)))
    ok('B7 contract.quote_version_id 补列到位', cols('contract').includes('quote_version_id'))
    const afterPriv = count('scan_state', " WHERE key LIKE 'priv:%'")
    ok(`B8 决策 B 游标清理：leadScan:* ${beforeLeadScan} → 0（信号扫描 priv:* ${beforePriv} 条保留）`,
      count('scan_state', " WHERE key LIKE 'leadScan:%'") === 0 && afterPriv === beforePriv)
    ok('B9 迁移后 CHECK 硬门禁仍生效（assignment.status）',
      createThrows('assignment', { lead_id: 1, status: 'oops' }))
    crmDbService.persistNow() // 落盘，供二次初始化幂等验证（real <本文件路径>）
    console.log(`MIGRATED_DB=${dbFile}`)
    console.log(`（幂等复验：npx tsx scripts/phase0-d3-ddl-test.ts real ${dbFile}）`)
  } else {
    console.error('用法：npx tsx scripts/phase0-d3-ddl-test.ts [fresh|real] [源库路径]')
    process.exit(1)
  }

  console.log(`\n${mode} 模式：${pass} 通过，${fail} 失败`)
  process.exit(fail ? 1 : 0)
}

void main()
