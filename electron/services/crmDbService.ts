/**
 * crmDbService.ts
 * CRM 模块数据层：独立 weflow-crm.db（sql.js/WASM），模式复用 salesDbService。
 * 蓝本：Cordys(领域骨架/表单形态) 悟空-11(财务字段) MoChat(归属状态机) Twenty(增量元数据)。
 * 合规：数据本地；不暴露删除端点；时间戳统一毫秒。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js'

// ─── 建表 SQL ────────────────────────────────────────────────────────────────
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS lead (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, company TEXT, phone TEXT,
  source TEXT, owner_sales TEXT, stage TEXT DEFAULT 'new',
  custom_fields TEXT DEFAULT '{}', created_at INTEGER, updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS account (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, industry TEXT,
  province TEXT, city TEXT, phone TEXT, owner_sales TEXT,
  custom_fields TEXT DEFAULT '{}', created_at INTEGER, updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS contact (
  id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER, name TEXT,
  phone TEXT, position TEXT, created_at INTEGER
);
CREATE TABLE IF NOT EXISTS opportunity (
  id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER, name TEXT,
  amount REAL DEFAULT 0, stage TEXT DEFAULT 'initial', owner_sales TEXT,
  custom_fields TEXT DEFAULT '{}', created_at INTEGER, updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS contract (
  id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER, name TEXT,
  amount REAL DEFAULT 0, status TEXT DEFAULT 'pending_sign', sign_date INTEGER,
  custom_fields TEXT DEFAULT '{}', created_at INTEGER, updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS quotation (
  id INTEGER PRIMARY KEY AUTOINCREMENT, contract_id INTEGER, total REAL DEFAULT 0,
  valid_until INTEGER, status TEXT DEFAULT 'draft', items TEXT DEFAULT '[]',
  attachment_path TEXT, custom_fields TEXT DEFAULT '{}', created_at INTEGER
);
CREATE TABLE IF NOT EXISTS invoice (
  id INTEGER PRIMARY KEY AUTOINCREMENT, contract_id INTEGER, invoice_no TEXT,
  buyer TEXT, invoice_type TEXT, amount REAL DEFAULT 0, tax_rate REAL,
  invoice_date INTEGER, status TEXT DEFAULT 'pre_issue', attachment_path TEXT,
  custom_fields TEXT DEFAULT '{}', created_at INTEGER
);
CREATE TABLE IF NOT EXISTS payment_record (
  id INTEGER PRIMARY KEY AUTOINCREMENT, msg_id TEXT, group_id TEXT, bank TEXT,
  account_tail TEXT, payer TEXT, amount_net REAL DEFAULT 0, pay_time INTEGER,
  memo TEXT, source TEXT DEFAULT 'bank_text', pay_channel TEXT DEFAULT 'bank_direct',
  needs_review INTEGER DEFAULT 0, attachment_path TEXT, raw_content TEXT, created_at INTEGER
);
CREATE TABLE IF NOT EXISTS allocation (
  id INTEGER PRIMARY KEY AUTOINCREMENT, payment_record_id INTEGER,
  customer_hint TEXT, sales_hint TEXT, amount_hint REAL DEFAULT 0,
  credited_amount REAL DEFAULT 0, account_id INTEGER, contract_id INTEGER,
  sales_name TEXT, status TEXT DEFAULT 'pending', created_at INTEGER, confirmed_at INTEGER
);
CREATE TABLE IF NOT EXISTS logistics (
  id INTEGER PRIMARY KEY AUTOINCREMENT, tracking_no TEXT, brand TEXT,
  receiver TEXT, city TEXT, courier TEXT, status TEXT DEFAULT 'shipped',
  latest_update_at INTEGER, source_msg_id TEXT, link_status TEXT DEFAULT 'unlinked',
  contract_id INTEGER, created_at INTEGER
);
CREATE TABLE IF NOT EXISTS product (
  id INTEGER PRIMARY KEY AUTOINCREMENT, model TEXT, name TEXT, spec TEXT,
  unit_price REAL, product_line TEXT, created_at INTEGER
);
CREATE TABLE IF NOT EXISTS alias_map (
  id INTEGER PRIMARY KEY AUTOINCREMENT, alias TEXT, account_id INTEGER,
  hit_count INTEGER DEFAULT 0, created_at INTEGER
);
CREATE TABLE IF NOT EXISTS group_config (
  id INTEGER PRIMARY KEY AUTOINCREMENT, group_id TEXT, group_name TEXT,
  group_type TEXT, default_courier TEXT, enabled INTEGER DEFAULT 1,
  last_scan INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS crm_field_meta (
  id INTEGER PRIMARY KEY AUTOINCREMENT, entity TEXT, field_key TEXT, label TEXT,
  field_type TEXT, options TEXT, form_group TEXT, sort INTEGER DEFAULT 0,
  enabled INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS processed_msg (
  msg_id TEXT PRIMARY KEY, handled_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_crm_alloc_pay ON allocation(payment_record_id);
CREATE INDEX IF NOT EXISTS idx_crm_alloc_contract ON allocation(contract_id, status);
CREATE INDEX IF NOT EXISTS idx_crm_logi_link ON logistics(link_status);
CREATE INDEX IF NOT EXISTS idx_crm_pay_channel ON payment_record(pay_channel, needs_review);
CREATE INDEX IF NOT EXISTS idx_crm_account_name ON account(name);
`

export interface CrmRow { [key: string]: any }

const ENTITIES = [
  'lead', 'account', 'contact', 'opportunity', 'contract', 'quotation', 'invoice',
  'payment_record', 'allocation', 'logistics', 'product', 'alias_map', 'group_config'
] as const
export type CrmEntity = (typeof ENTITIES)[number]

class CrmDbService {
  private db: SqlJsDatabase | null = null
  private dbPath: string | null = null
  private saveTimer: NodeJS.Timeout | null = null

  async initialize(userDataPath: string): Promise<void> {
    if (this.db) return
    if (!existsSync(userDataPath)) mkdirSync(userDataPath, { recursive: true })
    this.dbPath = join(userDataPath, 'weflow-crm.db')
    const wasmPath = join(__dirname, '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm')
    const SQL = await initSqlJs({ locateFile: () => wasmPath })
    this.db = existsSync(this.dbPath) ? new SQL.Database(readFileSync(this.dbPath)) : new SQL.Database()
    this.db.run(SCHEMA_SQL)
    this.persist()
  }

  private persist(): void {
    if (!this.db || !this.dbPath) return
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      try { writeFileSync(this.dbPath!, Buffer.from(this.db!.export())) } catch (e) { console.error('[CrmDb] persist error:', e) }
    }, 500)
  }

  persistNow(): void {
    if (!this.db || !this.dbPath) return
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null }
    try { writeFileSync(this.dbPath, Buffer.from(this.db.export())) } catch (e) { console.error('[CrmDb] persistNow error:', e) }
  }

  // ─── 通用 SQL 助手 ─────────────────────────────────────────────────────────
  all(sql: string, params: unknown[] = []): CrmRow[] {
    if (!this.db) return []
    const stmt = this.db.prepare(sql)
    try {
      stmt.bind(params as any[])
      const rows: CrmRow[] = []
      while (stmt.step()) rows.push(stmt.getAsObject() as CrmRow)
      return rows
    } finally { stmt.free() }
  }

  private run(sql: string, params: unknown[] = []): number {
    if (!this.db) return 0
    this.db.run(sql, params as any[])
    const r = this.all('SELECT last_insert_rowid() AS id')
    this.persist()
    return r.length ? Number(r[0].id) : 0
  }

  private isEntity(e: string): e is CrmEntity { return (ENTITIES as readonly string[]).includes(e) }

  list(entity: string, opts: { limit?: number; offset?: number; contract_id?: number; account_id?: number; status?: string } = {}): CrmRow[] {
    if (!this.isEntity(entity)) return []
    const where: string[] = []
    const params: unknown[] = []
    if (opts.contract_id !== undefined) { where.push('contract_id = ?'); params.push(opts.contract_id) }
    if (opts.account_id !== undefined) { where.push('account_id = ?'); params.push(opts.account_id) }
    if (opts.status !== undefined) { where.push('status = ?'); params.push(opts.status) }
    const sql = `SELECT * FROM ${entity}${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ? OFFSET ?`
    params.push(opts.limit ?? 100, opts.offset ?? 0)
    return this.all(sql, params)
  }

  getById(entity: string, id: number): CrmRow | null {
    if (!this.isEntity(entity)) return null
    const r = this.all(`SELECT * FROM ${entity} WHERE id = ?`, [id])
    return r.length ? r[0] : null
  }

  create(entity: string, data: CrmRow): number {
    if (!this.isEntity(entity)) return 0
    const keys = Object.keys(data)
    const sql = `INSERT INTO ${entity} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`
    return this.run(sql, keys.map((k) => data[k]))
  }

  update(entity: string, id: number, patch: CrmRow): void {
    if (!this.isEntity(entity)) return
    const keys = Object.keys(patch)
    if (!keys.length) return
    this.run(`UPDATE ${entity} SET ${keys.map((k) => `${k} = ?`).join(',')} WHERE id = ?`, [...keys.map((k) => patch[k]), id])
  }

  // ─── 幂等 ─────────────────────────────────────────────────────────────────
  isMsgProcessed(msgId: string): boolean {
    return this.all('SELECT 1 AS x FROM processed_msg WHERE msg_id = ?', [msgId]).length > 0
  }
  markMsgProcessed(msgId: string): void {
    this.run('INSERT OR IGNORE INTO processed_msg (msg_id, handled_at) VALUES (?, ?)', [msgId, Date.now()])
  }

  // ─── 客户匹配 / 别名（借 MoChat 归属思路）─────────────────────────────────
  matchAccountByName(name: string): CrmRow | null {
    if (!name) return null
    const exact = this.all('SELECT * FROM account WHERE name = ?', [name])
    if (exact.length) return exact[0]
    const prefixed = this.all('SELECT * FROM account WHERE name LIKE ?', [name + '%'])
    if (prefixed.length) return prefixed[0]
    return null
  }
  findAccountByPrefix(prefix: string): CrmRow | null {
    if (!prefix) return null
    const r = this.all('SELECT * FROM account WHERE name LIKE ?', [prefix + '%'])
    return r.length ? r[0] : null
  }
  ensureAccount(name: string): number {
    const hit = this.matchAccountByName(name)
    if (hit) return Number(hit.id)
    return this.create('account', { name, created_at: Date.now(), updated_at: Date.now() })
  }
  aliasLookup(alias: string): CrmRow | null {
    const r = this.all('SELECT * FROM alias_map WHERE alias = ?', [alias])
    return r.length ? r[0] : null
  }
  aliasLearn(alias: string, accountId: number): void {
    const hit = this.aliasLookup(alias)
    if (hit) this.run('UPDATE alias_map SET account_id = ?, hit_count = hit_count + 1 WHERE id = ?', [accountId, hit.id])
    else this.run('INSERT INTO alias_map (alias, account_id, hit_count, created_at) VALUES (?,?,1,?)', [alias, accountId, Date.now()])
  }

  // ─── 回款 / 归属 ───────────────────────────────────────────────────────────
  createPaymentRecord(rec: CrmRow): number {
    return this.create('payment_record', { created_at: Date.now(), ...rec })
  }
  addAllocations(paymentRecordId: number, rows: Array<{ customerHint: string; salesHint: string; amountHint: number }>): number[] {
    return rows.map((r) => this.create('allocation', {
      payment_record_id: paymentRecordId, customer_hint: r.customerHint, sales_hint: r.salesHint,
      amount_hint: r.amountHint, credited_amount: r.amountHint, status: 'pending', created_at: Date.now()
    }))
  }
  pendingAllocations(): CrmRow[] { return this.all("SELECT * FROM allocation WHERE status = 'pending' ORDER BY id") }
  confirmAllocation(id: number, patch: { account_id?: number; contract_id?: number; sales_name?: string }): { ok: boolean; reason?: string } {
    const a = this.getById('allocation', id)
    if (!a) return { ok: false, reason: '归属项不存在' }
    if (a.status !== 'pending') return { ok: false, reason: '已被处理（先到先得）' }
    this.update('allocation', id, { ...patch, status: 'confirmed', confirmed_at: Date.now() })
    return { ok: true }
  }
  rejectAllocation(id: number): void { this.update('allocation', id, { status: 'conflict' }) }
  creditedTotal(contractId: number): number {
    const r = this.all("SELECT COALESCE(SUM(credited_amount),0) AS s FROM allocation WHERE contract_id = ? AND status = 'confirmed'", [contractId])
    return Number(r[0]?.s ?? 0)
  }

  // ─── 合同状态机：全款到账才发货 ────────────────────────────────────────────
  shipContract(id: number): { ok: boolean; gap?: number; reason?: string } {
    const c = this.getById('contract', id)
    if (!c) return { ok: false, reason: '合同不存在' }
    if (c.status === 'shipped') return { ok: false, reason: '已发货，不可回退' }
    if (c.status !== 'signed') return { ok: false, reason: '仅已签约合同可发货' }
    const paid = this.creditedTotal(id)
    const amount = Number(c.amount ?? 0)
    if (paid + 0.005 < amount) return { ok: false, gap: Math.round((amount - paid) * 100) / 100, reason: '未全款到账' }
    this.update('contract', id, { status: 'shipped', updated_at: Date.now() })
    return { ok: true }
  }

  // ─── 物流 ─────────────────────────────────────────────────────────────────
  unlinkedLogistics(): CrmRow[] { return this.all("SELECT * FROM logistics WHERE link_status = 'unlinked' ORDER BY id") }
  linkLogistics(id: number, contractId: number): { ok: boolean; warning?: string } {
    const l = this.getById('logistics', id)
    if (!l) return { ok: false }
    this.update('logistics', id, { contract_id: contractId, link_status: 'linked' })
    const c = this.getById('contract', contractId)
    const warning = c && this.creditedTotal(contractId) + 0.005 < Number(c.amount ?? 0) ? '未全款已发货' : undefined
    return { ok: true, warning }
  }
  logisticsCandidates(receiver: string, city: string): CrmRow[] {
    // 收件人+城市 → 候选合同（经 account 名称/城市模糊匹配），兜底近期已签约合同
    const byAccount = this.all(
      "SELECT c.* FROM contract c JOIN account a ON a.id = c.account_id WHERE a.name LIKE ? OR (a.city = ? AND ? <> '') ORDER BY c.id DESC LIMIT 5",
      ['%' + (receiver || '') + '%', city || '', city || '']
    )
    if (byAccount.length) return byAccount
    return this.all("SELECT * FROM contract WHERE status IN ('signed','shipped') ORDER BY id DESC LIMIT 5")
  }

  // ─── 报价单（行项型号必须来自 product）─────────────────────────────────────
  createQuotation(data: { contract_id: number; items: Array<{ product_id: number; qty: number; unit_price?: number }>; valid_until?: number }): { ok: boolean; id?: number; reason?: string } {
    const items: CrmRow[] = []
    let total = 0
    for (const it of data.items) {
      const p = this.getById('product', it.product_id)
      if (!p) return { ok: false, reason: `型号不存在: ${it.product_id}` }
      const unit = it.unit_price ?? Number(p.unit_price ?? 0)
      const subtotal = Math.round(unit * it.qty * 100) / 100
      total = Math.round((total + subtotal) * 100) / 100
      items.push({ product_id: p.id, model: p.model, name: p.name, spec: p.spec, qty: it.qty, unit_price: unit, subtotal })
    }
    const id = this.create('quotation', { contract_id: data.contract_id, items: JSON.stringify(items), total, valid_until: data.valid_until ?? null, created_at: Date.now() })
    return { ok: true, id }
  }

  // ─── 元数据表单（借 Twenty 增量元数据 / Cordys module/form 形态）──────────
  formDefinition(entity: string): CrmRow[] {
    return this.all('SELECT * FROM crm_field_meta WHERE entity = ? AND enabled = 1 ORDER BY sort', [entity])
  }
  saveFieldMeta(meta: CrmRow): number { return this.create('crm_field_meta', meta) }

  // ─── 确认中心队列 ─────────────────────────────────────────────────────────
  reviewQueues(): { allocations: CrmRow[]; logistics: CrmRow[]; payments: CrmRow[]; invoices: CrmRow[] } {
    return {
      allocations: this.pendingAllocations(),
      logistics: this.unlinkedLogistics(),
      payments: this.all('SELECT * FROM payment_record WHERE needs_review = 1 ORDER BY id'),
      invoices: this.all("SELECT * FROM invoice WHERE status = 'pre_issue' ORDER BY id")
    }
  }

  // ─── 群配置 ───────────────────────────────────────────────────────────────
  groups(): CrmRow[] { return this.all('SELECT * FROM group_config ORDER BY id') }
  saveGroup(g: CrmRow): number { return this.create('group_config', { enabled: 1, ...g }) }
  updateGroup(id: number, patch: CrmRow): void { this.update('group_config', id, patch) }

  // ─── 工作台 ───────────────────────────────────────────────────────────────
  workbench(): CrmRow[] {
    const contracts = this.all('SELECT * FROM contract ORDER BY id DESC LIMIT 200')
    return contracts.map((c) => {
      const paid = this.creditedTotal(Number(c.id))
      const amount = Number(c.amount ?? 0)
      return {
        ...c, paid,
        paidRatio: amount > 0 ? Math.min(1, paid / amount) : 0,
        fullyPaid: paid + 0.005 >= amount,
        warning: c.status === 'shipped' && paid + 0.005 < amount ? '未全款已发货' : null
      }
    })
  }
}

export const crmDbService = new CrmDbService()
