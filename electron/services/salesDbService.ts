/**
 * salesDbService.ts
 *
 * 销售助手独立数据库管理服务。
 * 使用 sql.js（SQLite WASM 编译版）管理 weflow-sales.db，与微信 WCDB 完全解耦。
 * 无需原生编译，兼容所有 Electron 版本。
 */

import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js'
import { join } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'

// ─── 类型 ────────────────────────────────────────────────────────────────────

export interface KnowledgeEntry {
  id?: number
  category: string
  product_line?: string | null
  title: string
  content: string
  tags?: string
  scene?: string | null
  created_at?: number
  updated_at?: number
}

export interface ReportSnapshot {
  id?: number
  period_type: string
  period_start: number
  period_end: number
  stats: string
  ai_summary?: string | null
  created_at?: number
}

export interface CustomerProfile {
  id?: number
  session_id: string
  display_name?: string | null
  customer_id?: string | null
  external_source?: string | null
  stage?: string
  tags?: string
  notes?: string | null
  last_contact_at?: number | null
  created_at?: number
  updated_at?: number
}

export interface IntentTagLog {
  id?: number
  session_id: string
  stage: string
  confidence?: number | null
  source: string
  reason?: string | null
  created_at?: number
}

export interface FollowUpTask {
  id?: number
  session_id?: string | null
  customer_profile_id?: number | null
  display_name?: string | null
  source_message_id?: string | null
  promise_summary?: string | null
  action_type?: string
  trigger_type: string
  title: string
  due_at?: number | null
  status?: string
  priority_score?: number
  created_by?: string
  confidence?: number | null
  feedback_log?: string
  created_at?: number
  completed_at?: number | null
}

// ─── Migration SQL ───────────────────────────────────────────────────────────

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS knowledge_base (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,
  product_line TEXT,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  tags TEXT DEFAULT '[]',
  scene TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS report_snapshot (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  period_type TEXT NOT NULL,
  period_start INTEGER NOT NULL,
  period_end INTEGER NOT NULL,
  stats TEXT NOT NULL,
  ai_summary TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS customer_profile (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  display_name TEXT,
  customer_id TEXT,
  external_source TEXT,
  stage TEXT DEFAULT 'unknown',
  tags TEXT DEFAULT '[]',
  notes TEXT,
  last_contact_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS intent_tag_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  confidence REAL,
  source TEXT NOT NULL,
  reason TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS follow_up_task (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  customer_profile_id INTEGER,
  display_name TEXT,
  source_message_id TEXT,
  promise_summary TEXT,
  action_type TEXT DEFAULT 'reply_customer',
  trigger_type TEXT NOT NULL DEFAULT 'ai_detected',
  title TEXT NOT NULL,
  due_at INTEGER,
  status TEXT DEFAULT 'pending',
  priority_score REAL DEFAULT 0,
  created_by TEXT DEFAULT 'ai',
  confidence REAL,
  feedback_log TEXT DEFAULT '[]',
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_kb_category ON knowledge_base(category);
CREATE INDEX IF NOT EXISTS idx_kb_product_line ON knowledge_base(product_line);
CREATE INDEX IF NOT EXISTS idx_report_period ON report_snapshot(period_type, period_start);
CREATE INDEX IF NOT EXISTS idx_customer_session ON customer_profile(session_id);
CREATE INDEX IF NOT EXISTS idx_todo_status ON follow_up_task(status);
CREATE INDEX IF NOT EXISTS idx_todo_due ON follow_up_task(due_at);
CREATE INDEX IF NOT EXISTS idx_intent_session ON intent_tag_log(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_todo_status ON follow_up_task(status, due_at);
`

// ─── 服务类 ──────────────────────────────────────────────────────────────────

class SalesDbService {
  private db: SqlJsDatabase | null = null
  private dbPath: string | null = null
  private saveTimer: NodeJS.Timeout | null = null

  /**
   * 初始化数据库（异步加载 WASM + 读取/创建文件）
   */
  async initialize(userDataPath: string): Promise<void> {
    if (this.db) return

    if (!existsSync(userDataPath)) {
      mkdirSync(userDataPath, { recursive: true })
    }

    this.dbPath = join(userDataPath, 'weflow-sales.db')

    // sql.js 需要定位 WASM 二进制文件。打包后 __dirname 为 dist-electron/，
    // 因此向上一级找到项目根目录下的 node_modules。
    const wasmPath = join(__dirname, '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm')
    const SQL = await initSqlJs({
      locateFile: () => wasmPath
    })

    if (existsSync(this.dbPath)) {
      const buffer = readFileSync(this.dbPath)
      this.db = new SQL.Database(buffer)
    } else {
      this.db = new SQL.Database()
    }

    // 执行建表
    this.db.run(SCHEMA_SQL)
    // Migration: 为旧表添加新列（如果不存在）
    const migrationCols: Array<[string, string]> = [
      ['display_name', 'TEXT'],
      ['source_message_id', 'TEXT'],
      ['promise_summary', 'TEXT'],
      ['action_type', "TEXT DEFAULT 'reply_customer'"],
      ['priority_score', 'REAL DEFAULT 0'],
      ['created_by', "TEXT DEFAULT 'ai'"],
      ['confidence', 'REAL'],
      ['feedback_log', "TEXT DEFAULT '[]'"],
      ['analysis', 'TEXT'],
    ]
    for (const [col, type] of migrationCols) {
      try { this.db.run(`ALTER TABLE follow_up_task ADD COLUMN ${col} ${type}`) } catch { /* 列已存在 */ }
    }
    // Migration: customer_profile 增加 last_stage_change_at
    try { this.db.run('ALTER TABLE customer_profile ADD COLUMN last_stage_change_at INTEGER') } catch { /* 列已存在 */ }
    this.persist()
  }

  /**
   * 将数据库持久化到磁盘（防抖写入）
   */
  private persist(): void {
    if (!this.db || !this.dbPath) return
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      try {
        const data = this.db!.export()
        writeFileSync(this.dbPath!, Buffer.from(data))
      } catch (e) {
        console.error('[SalesDb] persist error:', e)
      }
    }, 500)
  }

  /**
   * 立即持久化（用于关键操作后）
   */
  /** 公开落盘入口（备份前强制刷盘用） */
  flushNow(): void { this.persistNow() }

  private persistNow(): void {
    if (!this.db || !this.dbPath) return
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null }
    try {
      const data = this.db.export()
      writeFileSync(this.dbPath, Buffer.from(data))
    } catch (e) {
      console.error('[SalesDb] persistNow error:', e)
    }
  }

  /**
   * 检查数据库是否已初始化（供 actionEngine 容错调用）
   */
  isInitialized(): boolean {
    return this.db !== null
  }

  private getDb(): SqlJsDatabase {
    if (!this.db) throw new Error('SalesDbService 未初始化')
    return this.db
  }

  /**
   * 执行查询并返回所有行（对象数组）
   */
  private all<T>(sql: string, params: unknown[] = []): T[] {
    const db = this.getDb()
    const stmt = db.prepare(sql)
    stmt.bind(params as any[])
    const results: T[] = []
    while (stmt.step()) {
      results.push(stmt.getAsObject() as T)
    }
    stmt.free()
    return results
  }

  /**
   * 执行查询并返回第一行
   */
  private get<T>(sql: string, params: unknown[] = []): T | undefined {
    const db = this.getDb()
    const stmt = db.prepare(sql)
    stmt.bind(params as any[])
    let result: T | undefined
    if (stmt.step()) {
      result = stmt.getAsObject() as T
    }
    stmt.free()
    return result
  }

  /**
   * 执行写操作
   */
  private run(sql: string, params: unknown[] = []): void {
    const db = this.getDb()
    db.run(sql, params as any[])
    this.persist()
  }

  /**
   * 获取最后插入的 rowid
   */
  private lastInsertRowId(): number {
    const db = this.getDb()
    const result = this.get<{ id: number }>('SELECT last_insert_rowid() as id')
    return result?.id ?? 0
  }

  // ─── 知识库 CRUD ─────────────────────────────────────────────────────────

  kbList(filters?: { category?: string; product_line?: string; scene?: string }): KnowledgeEntry[] {
    let sql = 'SELECT * FROM knowledge_base'
    const conditions: string[] = []
    const params: unknown[] = []

    if (filters?.category) { conditions.push('category = ?'); params.push(filters.category) }
    if (filters?.product_line) { conditions.push('product_line = ?'); params.push(filters.product_line) }
    if (filters?.scene) { conditions.push('scene = ?'); params.push(filters.scene) }

    if (conditions.length > 0) sql += ' WHERE ' + conditions.join(' AND ')
    sql += ' ORDER BY updated_at DESC'

    return this.all<KnowledgeEntry>(sql, params)
  }

  kbGet(id: number): KnowledgeEntry | undefined {
    return this.get<KnowledgeEntry>('SELECT * FROM knowledge_base WHERE id = ?', [id])
  }

  kbCreate(entry: Omit<KnowledgeEntry, 'id' | 'created_at' | 'updated_at'>): KnowledgeEntry {
    const now = Date.now()
    this.run(
      `INSERT INTO knowledge_base (category, product_line, title, content, tags, scene, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [entry.category, entry.product_line ?? null, entry.title, entry.content, entry.tags ?? '[]', entry.scene ?? null, now, now]
    )
    const id = this.lastInsertRowId()
    return this.kbGet(id)!
  }

  kbUpdate(id: number, updates: Partial<Omit<KnowledgeEntry, 'id' | 'created_at'>>): KnowledgeEntry | undefined {
    const existing = this.kbGet(id)
    if (!existing) return undefined

    const fields: string[] = []
    const params: unknown[] = []

    if (updates.category !== undefined) { fields.push('category = ?'); params.push(updates.category) }
    if (updates.product_line !== undefined) { fields.push('product_line = ?'); params.push(updates.product_line) }
    if (updates.title !== undefined) { fields.push('title = ?'); params.push(updates.title) }
    if (updates.content !== undefined) { fields.push('content = ?'); params.push(updates.content) }
    if (updates.tags !== undefined) { fields.push('tags = ?'); params.push(updates.tags) }
    if (updates.scene !== undefined) { fields.push('scene = ?'); params.push(updates.scene) }

    if (fields.length === 0) return existing

    fields.push('updated_at = ?')
    params.push(Date.now())
    params.push(id)

    this.run(`UPDATE knowledge_base SET ${fields.join(', ')} WHERE id = ?`, params)
    return this.kbGet(id)
  }

  kbDelete(id: number): boolean {
    const existing = this.kbGet(id)
    if (!existing) return false
    this.run('DELETE FROM knowledge_base WHERE id = ?', [id])
    return true
  }

  kbSearch(keyword: string, filters?: { category?: string; product_line?: string }): KnowledgeEntry[] {
    let sql = 'SELECT * FROM knowledge_base WHERE (title LIKE ? OR content LIKE ? OR tags LIKE ?)'
    const params: unknown[] = [`%${keyword}%`, `%${keyword}%`, `%${keyword}%`]

    if (filters?.category) { sql += ' AND category = ?'; params.push(filters.category) }
    if (filters?.product_line) { sql += ' AND product_line = ?'; params.push(filters.product_line) }

    sql += ' ORDER BY updated_at DESC LIMIT 50'
    return this.all<KnowledgeEntry>(sql, params)
  }

  // ─── 报表快照 ─────────────────────────────────────────────────────────────

  reportCreate(snapshot: Omit<ReportSnapshot, 'id' | 'created_at'>): ReportSnapshot {
    const now = Date.now()
    this.run(
      `INSERT INTO report_snapshot (period_type, period_start, period_end, stats, ai_summary, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [snapshot.period_type, snapshot.period_start, snapshot.period_end, snapshot.stats, snapshot.ai_summary ?? null, now]
    )
    const id = this.lastInsertRowId()
    return this.get<ReportSnapshot>('SELECT * FROM report_snapshot WHERE id = ?', [id])!
  }

  reportList(limit: number = 20): ReportSnapshot[] {
    return this.all<ReportSnapshot>('SELECT * FROM report_snapshot ORDER BY created_at DESC LIMIT ?', [limit])
  }

  reportGet(id: number): ReportSnapshot | undefined {
    return this.get<ReportSnapshot>('SELECT * FROM report_snapshot WHERE id = ?', [id])
  }

  reportDelete(id: number): boolean {
    const existing = this.reportGet(id)
    if (!existing) return false
    this.run('DELETE FROM report_snapshot WHERE id = ?', [id])
    return true
  }

  // ─── 客户画像 ─────────────────────────────────────────────────────────────

  customerGetBySession(sessionId: string): CustomerProfile | undefined {
    return this.get<CustomerProfile>('SELECT * FROM customer_profile WHERE session_id = ?', [sessionId])
  }

  customerUpsert(data: { session_id: string; display_name?: string; stage?: string; tags?: string; notes?: string; customer_id?: string; external_source?: string; last_contact_at?: number }): CustomerProfile {
    const existing = this.customerGetBySession(data.session_id)
    const now = Date.now()

    if (existing) {
      const fields: string[] = []
      const params: unknown[] = []
      if (data.display_name !== undefined) { fields.push('display_name = ?'); params.push(data.display_name) }
      if (data.stage !== undefined) { fields.push('stage = ?'); params.push(data.stage) }
      if (data.tags !== undefined) { fields.push('tags = ?'); params.push(data.tags) }
      if (data.notes !== undefined) { fields.push('notes = ?'); params.push(data.notes) }
      if (data.customer_id !== undefined) { fields.push('customer_id = ?'); params.push(data.customer_id) }
      if (data.external_source !== undefined) { fields.push('external_source = ?'); params.push(data.external_source) }
      if (data.last_contact_at !== undefined) { fields.push('last_contact_at = ?'); params.push(data.last_contact_at) }
      fields.push('updated_at = ?'); params.push(now)
      params.push(existing.id)
      this.run(`UPDATE customer_profile SET ${fields.join(', ')} WHERE id = ?`, params)
    } else {
      this.run(
        `INSERT INTO customer_profile (session_id, display_name, customer_id, external_source, stage, tags, notes, last_contact_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [data.session_id, data.display_name ?? null, data.customer_id ?? null, data.external_source ?? null, data.stage ?? 'unknown', data.tags ?? '[]', data.notes ?? null, data.last_contact_at ?? null, now, now]
      )
    }
    return this.customerGetBySession(data.session_id)!
  }

  customerList(filters?: { stage?: string; search?: string; sortBy?: 'updated_at' | 'last_contact_at' | 'stage'; limit?: number }): CustomerProfile[] {
    let sql = 'SELECT * FROM customer_profile'
    const params: unknown[] = []
    const conditions: string[] = []
    if (filters?.stage) { conditions.push('stage = ?'); params.push(filters.stage) }
    if (filters?.search && filters.search.trim()) {
      conditions.push('display_name LIKE ?')
      params.push('%' + filters.search.trim() + '%')
    }
    if (conditions.length > 0) sql += ' WHERE ' + conditions.join(' AND ')
    // 排序：stage 用权重 CASE，其它按字段 DESC
    if (filters?.sortBy === 'stage') {
      sql += " ORDER BY CASE stage WHEN '决策' THEN 0 WHEN '比价' THEN 1 WHEN '了解' THEN 2 WHEN '成交' THEN 3 WHEN '流失' THEN 4 ELSE 5 END, updated_at DESC"
    } else if (filters?.sortBy === 'last_contact_at') {
      sql += ' ORDER BY COALESCE(last_contact_at, 0) DESC'
    } else {
      sql += ' ORDER BY updated_at DESC'
    }
    if (filters?.limit) { sql += ' LIMIT ?'; params.push(filters.limit) }
    return this.all<CustomerProfile>(sql, params)
  }

  /**
   * 仪表盘聚合统计（纯本地 COUNT/GROUP BY，无 WCDB/AI 调用）
   */
  getDashboardStats(): {
    stageCounts: Record<string, number>
    highIntentCount: number
    totalCustomers: number
    newCustomersThisWeek: number
    pendingTodos: number
    overdueTodos: number
    suspectedTodos: number
  } {
    // 本周一 0 点（毫秒），逻辑同周报
    const d = new Date()
    const day = d.getDay() || 7
    d.setDate(d.getDate() - day + 1)
    d.setHours(0, 0, 0, 0)
    const weekStartMs = d.getTime()

    const stageCounts: Record<string, number> = {}
    try {
      const rows = this.all<{ stage: string; cnt: number }>(
        'SELECT stage, COUNT(*) as cnt FROM customer_profile GROUP BY stage', []
      )
      for (const r of rows) stageCounts[r.stage || 'unknown'] = Number(r.cnt) || 0
    } catch { /* ignore */ }

    const highIntentCount = Number(this.get<{ c: number }>(
      "SELECT COUNT(*) as c FROM customer_profile WHERE stage IN ('比价','决策')", []
    )?.c || 0)
    const totalCustomers = Number(this.get<{ c: number }>(
      'SELECT COUNT(*) as c FROM customer_profile', []
    )?.c || 0)
    const newCustomersThisWeek = Number(this.get<{ c: number }>(
      'SELECT COUNT(*) as c FROM customer_profile WHERE created_at >= ?', [weekStartMs]
    )?.c || 0)
    const pendingTodos = Number(this.get<{ c: number }>(
      "SELECT COUNT(*) as c FROM follow_up_task WHERE status = 'pending'", []
    )?.c || 0)
    const overdueTodos = Number(this.get<{ c: number }>(
      "SELECT COUNT(*) as c FROM follow_up_task WHERE status = 'overdue'", []
    )?.c || 0)
    const suspectedTodos = Number(this.get<{ c: number }>(
      "SELECT COUNT(*) as c FROM follow_up_task WHERE status = 'suspected'", []
    )?.c || 0)

    return { stageCounts, highIntentCount, totalCustomers, newCustomersThisWeek, pendingTodos, overdueTodos, suspectedTodos }
  }

  // ─── 意向标签 ─────────────────────────────────────────────────────────────

  intentCreate(tag: Omit<IntentTagLog, 'id' | 'created_at'>): IntentTagLog {
    const now = Date.now()
    this.run(
      `INSERT INTO intent_tag_log (session_id, stage, confidence, source, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [tag.session_id, tag.stage, tag.confidence ?? null, tag.source, tag.reason ?? null, now]
    )
    const id = this.lastInsertRowId()
    return this.get<IntentTagLog>('SELECT * FROM intent_tag_log WHERE id = ?', [id])!
  }

  intentHistory(sessionId: string, limit: number = 20): IntentTagLog[] {
    return this.all<IntentTagLog>(
      'SELECT * FROM intent_tag_log WHERE session_id = ? ORDER BY created_at DESC LIMIT ?',
      [sessionId, limit]
    )
  }

  intentGetLatest(sessionId: string): IntentTagLog | undefined {
    return this.get<IntentTagLog>(
      'SELECT * FROM intent_tag_log WHERE session_id = ? ORDER BY created_at DESC LIMIT 1',
      [sessionId]
    )
  }

  // ─── 跟进待办 ─────────────────────────────────────────────────────────────

  todoList(filters?: { status?: string; session_id?: string; limit?: number }): FollowUpTask[] {
    let sql = 'SELECT * FROM follow_up_task'
    const params: unknown[] = []
    const conditions: string[] = []
    if (filters?.status) { conditions.push('status = ?'); params.push(filters.status) }
    if (filters?.session_id) { conditions.push('session_id = ?'); params.push(filters.session_id) }
    if (conditions.length > 0) { sql += ' WHERE ' + conditions.join(' AND ') }
    sql += ' ORDER BY created_at DESC'
    if (filters?.limit) { sql += ' LIMIT ?'; params.push(filters.limit) }
    return this.all<FollowUpTask>(sql, params)






  }

  todoCreate(task: Omit<FollowUpTask, 'id' | 'created_at' | 'completed_at'>): FollowUpTask {
    const now = Date.now()
    this.run(
      `INSERT INTO follow_up_task (session_id, customer_profile_id, display_name, source_message_id, promise_summary, action_type, trigger_type, title, due_at, status, priority_score, created_by, confidence, feedback_log, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [task.session_id ?? null, task.customer_profile_id ?? null, task.display_name ?? null, task.source_message_id ?? null, task.promise_summary ?? null, task.action_type ?? 'reply_customer', task.trigger_type, task.title, task.due_at ?? null, task.status ?? 'pending', task.priority_score ?? 0, task.created_by ?? 'ai', task.confidence ?? null, task.feedback_log ?? '[]', now]
    )
    const id = this.lastInsertRowId()
    return this.get<FollowUpTask>('SELECT * FROM follow_up_task WHERE id = ?', [id])!
  }

  todoUpdate(id: number, updates: { status?: string; title?: string; due_at?: number; priority_score?: number; feedback_log?: string; completed_at?: number; analysis?: string }): FollowUpTask | undefined {
    const fields: string[] = []
    const params: unknown[] = []

    if (updates.status !== undefined) {
      fields.push('status = ?'); params.push(updates.status)
      if (updates.status === 'done') { fields.push('completed_at = ?'); params.push(Date.now()) }
    }
    if (updates.title !== undefined) { fields.push('title = ?'); params.push(updates.title) }
    if (updates.due_at !== undefined) { fields.push('due_at = ?'); params.push(updates.due_at) }

    if (fields.length === 0) return undefined

    params.push(id)
    this.run(`UPDATE follow_up_task SET ${fields.join(', ')} WHERE id = ?`, params)
    return this.get<FollowUpTask>('SELECT * FROM follow_up_task WHERE id = ?', [id])
  }

  // ─── 生命周期 ─────────────────────────────────────────────────────────────

  close(): void {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null }
    if (this.db) {
      this.persistNow()
      this.db.close()
      this.db = null
    }
  }

  /**
   * 更新客户阶段变更时间（供 salesStageClassifier 调用）
   */
  updateStageChangeTime(sessionId: string, timestampMs: number): void {
    this.run('UPDATE customer_profile SET last_stage_change_at = ? WHERE session_id = ?', [timestampMs, sessionId])
  }

  /**
   * 获取所有客户（供 actionEngine 全量扫描）
   */
  /** 销售漏斗：阶段分布 + 意向标记时间线（近 30 天），前端做归一化与转化计算 */
  funnelStats(): {
    stageDistribution: Array<{ stage: string; count: number }>
    intentTimeline: Array<{ date: string; stage: string; count: number }>
    totalCustomers: number
  } {
    const stageDistribution = this.all<{ stage: string; cnt: number }>(
      'SELECT stage, COUNT(*) AS cnt FROM customer_profile GROUP BY stage', []
    ).map((r) => ({ stage: String(r.stage || 'unknown'), count: Number(r.cnt) || 0 }))
    const intentTimeline = this.all<{ date: string; stage: string; cnt: number }>(
      "SELECT date(created_at / 1000, 'unixepoch', 'localtime') AS date, stage, COUNT(*) AS cnt FROM intent_tag_log WHERE created_at >= ? GROUP BY date, stage ORDER BY date",
      [Date.now() - 30 * 86400_000]
    ).map((r) => ({ date: String(r.date || ''), stage: String(r.stage || 'unknown'), count: Number(r.cnt) || 0 }))
    const totalCustomers = Number(this.get<{ c: number }>('SELECT COUNT(*) AS c FROM customer_profile', [])?.c || 0)
    return { stageDistribution, intentTimeline, totalCustomers }
  }

  customerAll(): CustomerProfile[] {
    return this.all<CustomerProfile>('SELECT * FROM customer_profile', [])
  }

  /**
   * 检查某客户某规则在指定时间窗口内是否已生成过任务（去重）
   */
  hasRecentTask(sessionId: string, triggerType: string, sinceMs: number): boolean {
    const row = this.get<{ c: number }>(
      'SELECT COUNT(*) as c FROM follow_up_task WHERE session_id = ? AND trigger_type = ? AND created_at >= ? AND status = \'pending\'',
      [sessionId, triggerType, sinceMs]
    )
    return (row?.c ?? 0) > 0
  }

  getDbPath(): string | null {
    return this.dbPath
  }
}

export const salesDbService = new SalesDbService()
