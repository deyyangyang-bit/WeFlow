/**
 * crmDbService.ts
 * CRM 模块数据层：独立 weflow-crm.db（sql.js/WASM），模式复用 salesDbService。
 * 蓝本：Cordys(领域骨架/表单形态) 悟空-11(财务字段) MoChat(归属状态机) Twenty(增量元数据)。
 * 合规：数据本地；删除为级联且删除前自动备份（crm-backups/）；时间戳统一毫秒。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js'
import { salesLog } from './salesLogger'

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
CREATE TABLE IF NOT EXISTS shipping_info (
  id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER, receiver TEXT, phone TEXT,
  address TEXT, city TEXT, source_msg_id TEXT, created_at INTEGER
);
CREATE TABLE IF NOT EXISTS scan_state (
  key TEXT PRIMARY KEY, last_scan INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS contract_status_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT, contract_id INTEGER, from_status TEXT,
  to_status TEXT, operator TEXT, created_at INTEGER
);
CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, entity TEXT, entity_id INTEGER,
  action TEXT, detail TEXT, operator TEXT, created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_crm_status_hist_contract ON contract_status_history(contract_id, created_at);
CREATE INDEX IF NOT EXISTS idx_crm_activity_entity ON activity_log(entity, entity_id);
CREATE INDEX IF NOT EXISTS idx_crm_activity_action ON activity_log(action, created_at);
`

export interface CrmRow { [key: string]: any }

const ENTITIES = [
  'lead', 'account', 'contact', 'opportunity', 'contract', 'quotation', 'invoice',
  'payment_record', 'allocation', 'logistics', 'product', 'alias_map', 'group_config', 'shipping_info',
  'contract_status_history', 'activity_log'
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
    // 打包态 wasm 在 electron/node_modules；dev/测试态在项目根 node_modules
    const wasmCandidates = [
      join(__dirname, '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
      join(__dirname, '..', '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm')
    ]
    const wasmPath = wasmCandidates.find((p) => existsSync(p)) ?? wasmCandidates[0]
    const SQL = await initSqlJs({ locateFile: () => wasmPath })
    this.db = existsSync(this.dbPath) ? new SQL.Database(readFileSync(this.dbPath)) : new SQL.Database()
    this.db.run(SCHEMA_SQL)
    // Migration: product 升级产品库字段（v8.1）
    const productCols: Array<[string, string]> = [
      ['sku', 'TEXT'], ['category', 'TEXT'], ['subcategory', 'TEXT'], ['image_path', 'TEXT'],
      ['cost_price', 'REAL'], ['reference_price', 'REAL'], ['moq', 'INTEGER DEFAULT 1'],
      ['material', 'TEXT'], ['description', 'TEXT'],
      ['specs', "TEXT DEFAULT '{}'"], ['variants', "TEXT DEFAULT '[]'"]
    ]
    for (const [col, type] of productCols) {
      try { this.db.run(`ALTER TABLE product ADD COLUMN ${col} ${type}`) } catch { /* 列已存在 */ }
    }
    try { this.db.run("UPDATE product SET category = product_line WHERE (category IS NULL OR category = '') AND product_line IS NOT NULL") } catch { /* ignore */ }
    // Migration: account 增加 AI 导入联动列（意向客户自动导入）
    const accountCols: Array<[string, string]> = [
      ['session_id', 'TEXT'], ['sales_stage', 'TEXT'],
      ['last_contact_at', 'INTEGER'], ['imported_at', 'INTEGER']
    ]
    for (const [col, type] of accountCols) {
      try { this.db.run(`ALTER TABLE account ADD COLUMN ${col} ${type}`) } catch { /* 列已存在 */ }
    }
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

  /** 内部人员名单（同事等），匹配则导入跳过。由 main.ts 从 config 载入 */
  private internalNames: string[] = []

  setInternalList(names: string[]): void {
    this.internalNames = Array.isArray(names) ? names.filter(Boolean) : []
  }

  /** 名字/微信号命中内部名单（同事）则跳过导入 */
  private isInternal(name: string, sessionId: string): boolean {
    if (this.internalNames.length === 0) return false
    const haystack = `${name} ${sessionId}`
    return this.internalNames.some((n) => n && haystack.includes(n))
  }

  /**
   * AI 意向客户导入（幂等）：session_id 精确命中或 display_name 匹配则补联动列，
   * 未命中则新建 account。命中内部名单（同事）则跳过。返回 { id, created }。
   */
  importCustomerFromProfile(p: { name: string; sessionId: string; stage: string; lastContactAt?: number | null; reason?: string }): { id: number; created: boolean } {
    const name = String(p.name || '').trim()
    if (!name) return { id: 0, created: false }
    if (this.isInternal(name, String(p.sessionId || ''))) {
      salesLog('INFO', `[CrmImport] 跳过内部人员：${name}`)
      return { id: 0, created: false }
    }
    let acc: CrmRow | null = null
    if (p.sessionId) {
      const bySid = this.all('SELECT * FROM account WHERE session_id = ? LIMIT 1', [p.sessionId])
      if (bySid.length) acc = bySid[0]
    }
    if (!acc) acc = this.matchAccountByName(name)
    const now = Date.now()
    if (acc) {
      // 已存在：补联动信息（不清空已有业务字段）
      const patch: CrmRow = { updated_at: now }
      if (p.sessionId && !acc.session_id) patch.session_id = p.sessionId
      if (p.stage) patch.sales_stage = p.stage
      if (p.lastContactAt) patch.last_contact_at = Number(p.lastContactAt)
      this.update('account', Number(acc.id), patch)
      return { id: Number(acc.id), created: false }
    }
    const id = this.create('account', {
      name, session_id: p.sessionId || null, sales_stage: p.stage || null,
      last_contact_at: p.lastContactAt ?? null, imported_at: now, created_at: now, updated_at: now
    })
    if (!id) return { id: 0, created: false } // db 未初始化时静默失败，不虚报 created
    this.logActivity('account', id, 'imported', `AI 意向客户导入（${p.stage || 'unknown'}）${p.reason ? `：${p.reason}` : ''}`)
    return { id, created: true }
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
    // 客户已确定但未选合同 → 自动挂到该客户最近一条可挂款合同，避免确认后回款不落地
    const accountId = patch.account_id ?? (a.account_id ? Number(a.account_id) : null)
    let contractId = patch.contract_id
    if (!contractId && accountId) {
      const contract = this.activeContractForAccount(accountId)
      if (contract) contractId = Number(contract.id)
    }
    const final: CrmRow = { ...patch, status: 'confirmed', confirmed_at: Date.now() }
    if (contractId) final.contract_id = contractId
    this.update('allocation', id, final)
    this.logActivity('allocation', id, 'confirmed',
      `归属 ${a.customer_hint || ''} ${Number(a.amount_hint ?? 0)} → 合同 ${contractId ?? '未关联'}${accountId ? ` 客户${accountId}` : ''}`,
      patch.sales_name ?? String(a.sales_name ?? ''))
    return { ok: true, linked: Boolean(contractId) }
  }

  /**
   * 到款审核通过：若该笔到款尚无任何归属，则自动建一条 pending 归属（挂到归属待确认）。
   * 保证审核通过后钱不"消失"——最终通过归属确认计入合同回款。
   */
  approvePayment(id: number): { ok: boolean; reason?: string; allocationCreated?: boolean } {
    const p = this.getById('payment_record', id)
    if (!p) return { ok: false, reason: '到款不存在' }
    let created = false
    const existing = this.all('SELECT id FROM allocation WHERE payment_record_id = ?', [id])
    if (existing.length === 0) {
      const account = p.pay_channel === 'bank_direct' ? this.matchAccountByName(String(p.payer || '')) : null
      this.create('allocation', {
        payment_record_id: id, customer_hint: String(p.payer || '待确认'), sales_hint: '',
        amount_hint: p.amount_net, credited_amount: p.amount_net,
        account_id: account ? Number(account.id) : null, sales_name: '',
        status: 'pending', created_at: Date.now()
      })
      created = true
    }
    this.update('payment_record', id, { needs_review: 0 })
    this.logActivity('payment_record', id, 'approved', `确认到款 ${String(p.payer || '')} ¥${Number(p.amount_net ?? 0)}，${created ? '已转入归属待确认' : '已有归属记录'}`)
    return { ok: true, allocationCreated: created }
  }
  rejectAllocation(id: number): void {
    this.update('allocation', id, { status: 'conflict' })
    this.logActivity('allocation', id, 'rejected', `驳回归属 ${String(this.getById('allocation', id)?.customer_hint ?? '')}`)
  }
  creditedTotal(contractId: number): number {
    const r = this.all("SELECT COALESCE(SUM(credited_amount),0) AS s FROM allocation WHERE contract_id = ? AND status = 'confirmed'", [contractId])
    return Number(r[0]?.s ?? 0)
  }

  /** 该客户最近一条可挂款合同（待签约/已签约），无则 null */
  activeContractForAccount(accountId: number): CrmRow | null {
    const r = this.all("SELECT * FROM contract WHERE account_id = ? AND status IN ('pending_sign','signed') ORDER BY id DESC LIMIT 1", [accountId])
    return r.length ? r[0] : null
  }

  /**
   * 私聊成交检测 → 自动建合同（若该客户无待签约/已签约合同则不重复建）。
   * 金额留 0（待补，到款确认后由工作台/归属关联），custom_fields 记录成交来源。
   */
  createDealContract(accountId: number, reason: string): { created: boolean; contractId?: number } {
    const acc = this.getById('account', accountId)
    if (!acc) return { created: false }
    const active = this.activeContractForAccount(accountId)
    if (active) return { created: false, contractId: Number(active.id) }
    const contractId = this.create('contract', {
      account_id: accountId, name: `${String(acc.name || '')}-合同`,
      amount: 0, status: 'pending_sign',
      custom_fields: JSON.stringify({ deal_source: '私聊成交', deal_reason: String(reason || '').slice(0, 200) }),
      created_at: Date.now(), updated_at: Date.now()
    })
    if (contractId) this.logActivity('contract', contractId, 'created', `私聊成交自动创建（${String(reason || '').slice(0, 80)}）`)
    return { created: true, contractId }
  }

  // ─── 事件/行为日志（状态可追溯 + AI 分析素材）──────────────────────────────
  /** 记录合同状态迁移（status 不是唯一事实，历史可回溯） */
  recordStatusChange(contractId: number, from: string, to: string, operator = ''): void {
    this.create('contract_status_history', { contract_id: contractId, from_status: from, to_status: to, operator, created_at: Date.now() })
  }
  /** 记录业务动作（跟进/签约/发货/确认归属/报价/物流/发票…），SOP 执行率统计的计数源 */
  logActivity(entity: string, entityId: number, action: string, detail = '', operator = ''): void {
    this.create('activity_log', { entity, entity_id: entityId, action, detail, operator, created_at: Date.now() })
  }
  contractStatusHistory(contractId: number): CrmRow[] {
    return this.all('SELECT * FROM contract_status_history WHERE contract_id = ? ORDER BY id', [contractId])
  }
  activityBy(entity: string, entityId: number): CrmRow[] {
    return this.all('SELECT * FROM activity_log WHERE entity = ? AND entity_id = ? ORDER BY id', [entity, entityId])
  }

  // ─── 合同状态机：全款到账才发货 ────────────────────────────────────────────
  signContract(id: number): { ok: boolean; reason?: string } {
    const c = this.getById('contract', id)
    if (!c) return { ok: false, reason: '合同不存在' }
    if (c.status === 'signed') return { ok: false, reason: '已签约' }
    if (c.status === 'shipped') return { ok: false, reason: '已发货，不可签约' }
    if (c.status !== 'pending_sign') return { ok: false, reason: '仅待签约合同可签' }
    this.update('contract', id, { status: 'signed', sign_date: Date.now(), updated_at: Date.now() })
    this.recordStatusChange(id, String(c.status), 'signed')
    this.logActivity('contract', id, 'signed', `签约金额 ${Number(c.amount ?? 0)}`)
    return { ok: true }
  }

  shipContract(id: number): { ok: boolean; gap?: number; reason?: string } {
    const c = this.getById('contract', id)
    if (!c) return { ok: false, reason: '合同不存在' }
    if (c.status === 'shipped') return { ok: false, reason: '已发货，不可回退' }
    if (c.status !== 'signed') return { ok: false, reason: '仅已签约合同可发货' }
    const paid = this.creditedTotal(id)
    const amount = Number(c.amount ?? 0)
    if (paid + 0.005 < amount) return { ok: false, gap: Math.round((amount - paid) * 100) / 100, reason: '未全款到账' }
    this.update('contract', id, { status: 'shipped', updated_at: Date.now() })
    this.recordStatusChange(id, String(c.status), 'shipped')
    this.logActivity('contract', id, 'shipped', `发货金额 ${amount}，已确认回款 ${paid}`)
    return { ok: true }
  }

  // ─── 删除（级联，删除前自动备份）──────────────────────────────────────────
  /** 删除前把当前数据库快照备份到 userData/crm-backups/ 下（带时间戳） */
  private backupDb(): void {
    if (!this.db || !this.dbPath) return
    try {
      const dir = join(dirname(this.dbPath), 'crm-backups')
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      writeFileSync(join(dir, `weflow-crm-before-delete-${stamp}.db`), Buffer.from(this.db.export()))
    } catch (e) { console.error('[CrmDb] backup error:', e) }
  }

  /** 级联删除单个合同的全部子资源（不含 activity_log，调用方处理） */
  private deleteContractCascade(id: number): number {
    if (!this.db) return 0
    let removed = 0
    for (const t of ['quotation', 'invoice', 'logistics', 'allocation', 'contract_status_history']) {
      removed += this.db.run(`DELETE FROM ${t} WHERE contract_id = ?`, [id]).changes
    }
    this.db.run('DELETE FROM activity_log WHERE entity = ? AND entity_id = ?', ['contract', id])
    this.db.run('DELETE FROM contract WHERE id = ?', [id])
    return removed
  }

  /**
   * 删除合同及其全部子资源（报价单/发票/物流/回款归属/状态历史/操作日志）。
   * @returns removed = 级联删除的子资源行数
   */
  deleteContract(id: number): { ok: boolean; reason?: string; removed?: number } {
    const c = this.getById('contract', id)
    if (!c || !this.db) return { ok: false, reason: '合同不存在' }
    this.backupDb()
    const removed = this.deleteContractCascade(id)
    this.logActivity('contract', id, 'deleted', `删除合同「${String(c.name ?? '')}」（含 ${removed} 条子资源）`)
    this.persistNow()
    return { ok: true, removed }
  }

  /**
   * 删除客户及其全部合同（合同子资源一并级联），同时清理别名与操作日志。
   * @returns removed = 级联删除的子资源行数
   */
  deleteAccount(id: number): { ok: boolean; reason?: string; removed?: number } {
    const acc = this.getById('account', id)
    if (!acc || !this.db) return { ok: false, reason: '客户不存在' }
    this.backupDb()
    let removed = 0
    const contracts = this.all('SELECT id FROM contract WHERE account_id = ?', [id])
    for (const c of contracts) removed += this.deleteContractCascade(Number(c.id))
    removed += this.db.run('DELETE FROM alias_map WHERE account_id = ?', [id]).changes
    this.db.run('DELETE FROM activity_log WHERE entity = ? AND entity_id = ?', ['account', id])
    this.db.run('DELETE FROM account WHERE id = ?', [id])
    this.logActivity('account', id, 'deleted', `删除客户「${String(acc.name ?? '')}」（含 ${contracts.length} 份合同）`)
    this.persistNow()
    return { ok: true, removed }
  }

  // ─── 物流 ─────────────────────────────────────────────────────────────────
  unlinkedLogistics(): CrmRow[] { return this.all("SELECT * FROM logistics WHERE link_status = 'unlinked' ORDER BY id") }
  linkLogistics(id: number, contractId: number): { ok: boolean; warning?: string } {
    const l = this.getById('logistics', id)
    if (!l) return { ok: false }
    this.update('logistics', id, { contract_id: contractId, link_status: 'linked' })
    const c = this.getById('contract', contractId)
    const warning = c && this.creditedTotal(contractId) + 0.005 < Number(c.amount ?? 0) ? '未全款已发货' : undefined
    this.logActivity('logistics', id, 'linked', `单号 ${String(l.tracking_no ?? '')} → 合同 ${contractId}`)
    return { ok: true, warning }
  }
  saveShippingInfo(row: CrmRow): number {
    if (row.source_msg_id && this.all('SELECT 1 AS x FROM shipping_info WHERE source_msg_id = ?', [row.source_msg_id]).length) return 0
    return this.create('shipping_info', row)
  }
  findShippingByReceiver(receiver: string): CrmRow | null {
    if (!receiver) return null
    const exact = this.all('SELECT * FROM shipping_info WHERE receiver = ? ORDER BY id DESC LIMIT 1', [receiver])
    if (exact.length) return exact[0]
    const fuzzy = this.all("SELECT * FROM shipping_info WHERE receiver <> '' AND (receiver LIKE ? OR ? LIKE '%' || receiver || '%') ORDER BY id DESC LIMIT 1", [receiver + '%', receiver])
    return fuzzy.length ? fuzzy[0] : null
  }
  accountByReceiver(receiver: string): CrmRow | null {
    const sh = this.findShippingByReceiver(receiver)
    if (!sh || !sh.account_id) return null
    return this.getById('account', Number(sh.account_id))
  }
  getScanState(key: string): number {
    const r = this.all('SELECT last_scan FROM scan_state WHERE key = ?', [key])
    return r.length ? Number(r[0].last_scan || 0) : 0
  }
  setScanState(key: string, ms: number): void {
    this.run('INSERT INTO scan_state (key, last_scan) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET last_scan = excluded.last_scan', [key, ms])
  }
  autoLinkLogisticsByReceiver(logiId: number, receiver: string): boolean {
    const acc = this.accountByReceiver(receiver)
    if (!acc) return false
    const c = this.all("SELECT * FROM contract WHERE account_id = ? AND status IN ('signed','shipped') ORDER BY id DESC LIMIT 1", [Number(acc.id)])
    if (!c.length) return false
    this.update('logistics', logiId, { contract_id: Number(c[0].id), link_status: 'linked' })
    return true
  }
  logisticsCandidates(receiver: string, city: string): CrmRow[] {
    // 收件人+城市 → 候选合同（经 account 名称/城市模糊匹配），兜底近期已签约合同
    const byAccount = this.all(
      "SELECT c.* FROM contract c JOIN account a ON a.id = c.account_id WHERE a.name LIKE ? OR (a.city = ? AND ? <> '') ORDER BY c.id DESC LIMIT 5",
      ['%' + (receiver || '') + '%', city || '', city || '']
    )
    if (byAccount.length) return byAccount
    // 私聊收货地址 → 客户 → 合同
    const acc = this.accountByReceiver(receiver || '')
    if (acc) {
      const viaShip = this.all('SELECT * FROM contract WHERE account_id = ? ORDER BY id DESC LIMIT 5', [Number(acc.id)])
      if (viaShip.length) return viaShip
    }
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
      const specsObj = JSON.parse(String(p.specs || '{}')) as Record<string, string>
      const specSummary = [p.material, ...Object.entries(specsObj).map(([k, v]) => `${k}:${v}`)].filter(Boolean).join('；')
      items.push({ product_id: p.id, model: p.model, name: p.name, spec: p.spec, material: p.material ?? '', spec_summary: specSummary, qty: it.qty, unit_price: unit, subtotal })
    }
    const id = this.create('quotation', { contract_id: data.contract_id, items: JSON.stringify(items), total, valid_until: data.valid_until ?? null, created_at: Date.now() })
    if (id) this.logActivity('quotation', id, 'created', `合同 ${data.contract_id}，${items.length} 行，合计 ${total}`)
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
      // JOIN 支付记录带来源（群/时间/原始内容），供确认卡片核对"这笔钱哪来的"
      allocations: this.all(`SELECT al.*, pr.group_id AS src_group_id, pr.pay_time AS src_time, pr.raw_content AS src_raw
        FROM allocation al LEFT JOIN payment_record pr ON al.payment_record_id = pr.id
        WHERE al.status = 'pending' ORDER BY al.id`),
      logistics: this.unlinkedLogistics(),
      payments: this.all('SELECT * FROM payment_record WHERE needs_review = 1 ORDER BY id'),
      invoices: this.all("SELECT * FROM invoice WHERE status = 'pre_issue' ORDER BY id")
    }
  }

  // ─── 群配置 ───────────────────────────────────────────────────────────────
  groups(): CrmRow[] { return this.all('SELECT * FROM group_config ORDER BY id') }
  saveGroup(g: CrmRow): number { return this.create('group_config', { enabled: 1, ...g }) }
  updateGroup(id: number, patch: CrmRow): void { this.update('group_config', id, patch) }

  /** 删除已导入的命中内部名单（同事）的 account，含关联 activity。返回删除数 */
  removeInternalAccounts(): number {
    if (!this.db) return 0
    const rows = this.all('SELECT id, name, session_id FROM account')
    const ids = rows
      .filter((r) => this.isInternal(String(r.name || ''), String(r.session_id || '')))
      .map((r) => Number(r.id))
    if (!ids.length) return 0
    const placeholders = ids.map(() => '?').join(',')
    this.db.run(`DELETE FROM account WHERE id IN (${placeholders})`, ids)
    this.db.run(`DELETE FROM activity_log WHERE entity = 'account' AND entity_id IN (${placeholders})`, ids)
    this.persist()
    return ids.length
  }

  /** 清理孤立 account（无微信会话关联且无合同、无归属项）。仅供本地数据清理。返回删除数 */
  cleanupOrphanAccounts(): number {
    if (!this.db) return 0
    const orphans = this.all(`
      SELECT id FROM account
      WHERE (session_id IS NULL OR session_id = '')
        AND id NOT IN (SELECT account_id FROM contract WHERE account_id IS NOT NULL)
        AND id NOT IN (SELECT account_id FROM allocation WHERE account_id IS NOT NULL)
    `)
    if (!orphans.length) return 0
    const ids = orphans.map((o) => Number(o.id))
    const placeholders = ids.map(() => '?').join(',')
    this.db.run(`DELETE FROM account WHERE id IN (${placeholders})`, ids)
    this.db.run(`DELETE FROM activity_log WHERE entity = 'account' AND entity_id IN (${placeholders})`, ids)
    this.persist()
    return ids.length
  }

  // ─── 客户列表（含合同数/累计回款聚合）──────────────────────────────────────
  customers(): CrmRow[] {
    const rows = this.all(`
      SELECT a.*,
        (SELECT COUNT(*) FROM contract c WHERE c.account_id = a.id) AS contract_count,
        (SELECT COALESCE(SUM(al.credited_amount), 0) FROM allocation al
           JOIN contract c2 ON c2.id = al.contract_id
           WHERE c2.account_id = a.id AND al.status = 'confirmed') AS credited_total
      FROM account a ORDER BY a.imported_at DESC, a.id DESC
    `)
    return rows.map((r) => ({ ...r, credited_total: Number(r.credited_total || 0), contract_count: Number(r.contract_count || 0) }))
  }

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
