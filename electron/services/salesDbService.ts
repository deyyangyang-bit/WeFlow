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
import { computeIntentScore, ACTIVE_WINDOW_MS, type IntentScore } from './intentScore'
import { stageToFunnel, FUNNEL_ORDER, type FunnelStage } from '../../shared/salesStage'
import { computeCanonicalState, type CanonicalState } from '../../shared/canonicalState'
import { isCustomerJudgmentType, type CustomerJudgmentRecord, type CustomerJudgmentType } from '../../shared/customerJudgment'
import { isCustomerEventType, type CustomerEventRecord, type CustomerEventType } from '../../shared/customerEvent'

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
  last_stage_change_at?: number | null
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
  /** 证据：来源消息 messageKey（可回查原话） */
  message_key?: string | null
  /** 证据：判断依据关键句（客户原话/转述，非 AI 结论） */
  evidence_text?: string | null
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
  /** 业务源 id（SLA 卡=lead.id），配合 trigger_type 做幂等 */
  source_id?: number | null
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
  message_key TEXT,
  evidence_text TEXT,
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

-- P0-2C AI 判断记录（append-only 历史；projection 取最新一条）
-- 只服务 summary/opportunity/risk/next_action，严禁 stage（归 P0-2A Canonical State，CHECK 硬拦截）
CREATE TABLE IF NOT EXISTS customer_judgment (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  judgment_type TEXT NOT NULL CHECK (judgment_type IN ('summary', 'opportunity', 'risk', 'next_action')),
  value TEXT NOT NULL,
  confidence REAL,
  source TEXT NOT NULL,
  model TEXT,
  reason TEXT,
  message_key TEXT,
  evidence_text TEXT,
  basis TEXT,
  generated_at INTEGER,
  created_at INTEGER NOT NULL
);

-- P0-3 E3 客户事件（append-only；客观发生的事实，非判断/状态——四者不互相冒充）
-- 硬门禁：event_type 只允许五类（新增类型必须走迁移）；message_key 为 P0-2B 证据锚点
-- 幂等：有 key 的事件同 key 拒绝（partial unique）；无 key 的手动事件允许重复
CREATE TABLE IF NOT EXISTS customer_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  task_id INTEGER,
  event_type TEXT NOT NULL CHECK (event_type IN ('customer_replied', 'quote_asked', 'script_copied', 'chat_opened', 'follow_up_done')),
  message_key TEXT,
  evidence_text TEXT,
  source TEXT NOT NULL,
  metadata TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_kb_category ON knowledge_base(category);
CREATE INDEX IF NOT EXISTS idx_kb_product_line ON knowledge_base(product_line);
CREATE INDEX IF NOT EXISTS idx_report_period ON report_snapshot(period_type, period_start);
CREATE INDEX IF NOT EXISTS idx_customer_session ON customer_profile(session_id);
CREATE INDEX IF NOT EXISTS idx_todo_status ON follow_up_task(status);
CREATE INDEX IF NOT EXISTS idx_todo_due ON follow_up_task(due_at);
CREATE INDEX IF NOT EXISTS idx_intent_session ON intent_tag_log(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_todo_status ON follow_up_task(status, due_at);
CREATE INDEX IF NOT EXISTS idx_judgment_session ON customer_judgment(session_id, judgment_type, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_event_msgkey ON customer_event(message_key) WHERE message_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_event_session ON customer_event(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_event_type ON customer_event(event_type, created_at);
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

    // sql.js 需要定位 WASM 二进制文件。打包态在 electron/node_modules；dev/测试态在项目根 node_modules
    const wasmCandidates = [
      join(__dirname, '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
      join(__dirname, '..', '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm')
    ]
    const wasmPath = wasmCandidates.find((p) => existsSync(p)) ?? wasmCandidates[0]
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
      ['source_id', 'INTEGER'],
    ]
    for (const [col, type] of migrationCols) {
      try { this.db.run(`ALTER TABLE follow_up_task ADD COLUMN ${col} ${type}`) } catch { /* 列已存在 */ }
    }
    // Migration: 线索 SLA 卡幂等兜底（一个 lead 最多一张 pending 的 sla_lead 卡）
    try { this.db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_ft_sla_once ON follow_up_task(trigger_type, source_id) WHERE status = 'pending'") } catch { /* 已存在 */ }
    // Migration: customer_profile 增加 last_stage_change_at
    try { this.db.run('ALTER TABLE customer_profile ADD COLUMN last_stage_change_at INTEGER') } catch { /* 列已存在 */ }
    // Migration: intent_tag_log 证据列（message_key 可回查原话 / evidence_text 判断依据句，P0-1 第一刀）
    for (const [col, type] of [['message_key', 'TEXT'], ['evidence_text', 'TEXT']] as const) {
      try { this.db.run(`ALTER TABLE intent_tag_log ADD COLUMN ${col} ${type}`) } catch { /* 列已存在 */ }
    }
    // Migration: customer_event 行动关联列（P0-4.2.1 correlation：task_id 串「哪条建议 → 哪次执行」；
    // NULL 允许——不是每个事件都有行动上下文，禁止伪造）
    try { this.db.run('ALTER TABLE customer_event ADD COLUMN task_id INTEGER') } catch { /* 列已存在 */ }
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

  customerUpsert(data: { session_id: string; display_name?: string; stage?: string; tags?: string; notes?: string; customer_id?: string; external_source?: string; last_contact_at?: number; created_at?: number }): CustomerProfile {
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
      // created_at 可选覆盖（默认 now）：AI 导入等场景保留真实建档时间；lastContactSec 回退链依赖它
      const createdMs = data.created_at ?? now
      this.run(
        `INSERT INTO customer_profile (session_id, display_name, customer_id, external_source, stage, tags, notes, last_contact_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [data.session_id, data.display_name ?? null, data.customer_id ?? null, data.external_source ?? null, data.stage ?? 'unknown', data.tags ?? '[]', data.notes ?? null, data.last_contact_at ?? null, createdMs, now]
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

  /** createdAt 可选：测试回填历史时间戳用；默认当前时间。message_key/evidence_text 为 P0-1 证据透传，可空 */
  intentCreate(tag: Omit<IntentTagLog, 'id' | 'created_at'> & { createdAt?: number }): IntentTagLog {
    const created = tag.createdAt ?? Date.now()
    this.run(
      `INSERT INTO intent_tag_log (session_id, stage, confidence, source, reason, message_key, evidence_text, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [tag.session_id, tag.stage, tag.confidence ?? null, tag.source, tag.reason ?? null,
       tag.message_key ?? null, tag.evidence_text ?? null, created]
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

  /** 某时间点之前的最新一条意向记录（周复盘基线对比用：上周最终阶段） */
  intentBefore(sessionId: string, ts: number): IntentTagLog | undefined {
    return this.get<IntentTagLog>(
      'SELECT * FROM intent_tag_log WHERE session_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT 1',
      [sessionId, ts]
    )
  }

  // ─── AI 判断记录（P0-2C）───────────────────────────────────────────────────

  /**
   * 追加一条 AI 判断记录（append-only，一行 = 一次判断）。
   * message_key 为 P0-2B 证据锚点：无可靠 key 必须留空（证据诚实，绝不伪造）。
   * judgment_type 非法（含 'stage'）→ 抛错（TS 层守卫 + DB CHECK 双拦截）。
   * createdAt 可选：测试回填历史时间戳用；默认当前时间。
   */
  judgmentCreate(input: Omit<CustomerJudgmentRecord, 'id' | 'created_at'> & { createdAt?: number }): CustomerJudgmentRecord {
    if (!isCustomerJudgmentType(input.judgment_type)) {
      throw new Error(`[SalesDb] 非法 AI 判断类型: ${input.judgment_type}（P0-2C 仅允许 summary/opportunity/risk/next_action）`)
    }
    const created = input.createdAt ?? Date.now()
    this.run(
      `INSERT INTO customer_judgment (session_id, judgment_type, value, confidence, source, model, reason, message_key, evidence_text, basis, generated_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [input.session_id, input.judgment_type, input.value, input.confidence ?? null, input.source,
       input.model ?? null, input.reason ?? null, input.message_key ?? null, input.evidence_text ?? null,
       input.basis ?? null, input.generated_at ?? null, created]
    )
    const id = this.lastInsertRowId()
    return this.get<CustomerJudgmentRecord>('SELECT * FROM customer_judgment WHERE id = ?', [id])!
  }

  /** 当前投影：该 session 该类型最新一条（无则 undefined）。id 兜底同毫秒并列 */
  judgmentCurrent(sessionId: string, judgmentType: CustomerJudgmentType): CustomerJudgmentRecord | undefined {
    return this.get<CustomerJudgmentRecord>(
      'SELECT * FROM customer_judgment WHERE session_id = ? AND judgment_type = ? ORDER BY created_at DESC, id DESC LIMIT 1',
      [sessionId, judgmentType]
    )
  }

  /** 四类型当前投影一次取回（客户 360 / 卡流展示用）：无记录的类型为 undefined */
  judgmentCurrentAll(sessionId: string): Record<CustomerJudgmentType, CustomerJudgmentRecord | undefined> {
    const rows = this.all<CustomerJudgmentRecord>(
      'SELECT * FROM customer_judgment WHERE session_id = ? ORDER BY created_at DESC, id DESC',
      [sessionId]
    )
    const out: Record<CustomerJudgmentType, CustomerJudgmentRecord | undefined> = {
      summary: undefined, opportunity: undefined, risk: undefined, next_action: undefined
    }
    for (const r of rows) {
      if (out[r.judgment_type as CustomerJudgmentType] === undefined) out[r.judgment_type as CustomerJudgmentType] = r
    }
    return out
  }

  /** 历史（append-only 列表，倒序；可按类型过滤 + limit） */
  judgmentHistory(sessionId: string, judgmentType?: CustomerJudgmentType, limit: number = 20): CustomerJudgmentRecord[] {
    if (judgmentType) {
      return this.all<CustomerJudgmentRecord>(
        'SELECT * FROM customer_judgment WHERE session_id = ? AND judgment_type = ? ORDER BY created_at DESC, id DESC LIMIT ?',
        [sessionId, judgmentType, limit]
      )
    }
    return this.all<CustomerJudgmentRecord>(
      'SELECT * FROM customer_judgment WHERE session_id = ? ORDER BY created_at DESC, id DESC LIMIT ?',
      [sessionId, limit]
    )
  }

  /** 去重基础：该 session 该类型 windowMs 内是否已有判断（配合判断再生成节流；参考 hasRecentTask） */
  hasRecentJudgment(sessionId: string, judgmentType: CustomerJudgmentType, windowMs: number): boolean {
    const row = this.get<{ c: number }>(
      'SELECT COUNT(*) as c FROM customer_judgment WHERE session_id = ? AND judgment_type = ? AND created_at >= ?',
      [sessionId, judgmentType, Date.now() - windowMs]
    )
    return (row?.c ?? 0) > 0
  }

  // ─── 客户事件（P0-3 E3.1：客观事实，append-only）──────────────────────────────

  /**
   * 追加一条客户事件（append-only，一行 = 一次客观事实）。
   * event_type 非法（含 stage / judgment 类）→ 抛错（TS 层守卫 + DB CHECK 双拦截，防万能日志表）。
   * message_key 为 P0-2B 证据锚点：无可靠 key 必须留空（证据诚实）。
   * 幂等：message_key 已存在（partial unique）→ 返回 null 拒绝重复写；无 key 的手动事件允许重复。
   * createdAt 可选：测试回填历史时间戳用；默认当前时间。
   */
  customerEventAdd(input: Omit<CustomerEventRecord, 'id' | 'created_at'> & { createdAt?: number }): CustomerEventRecord | null {
    if (!isCustomerEventType(input.event_type)) {
      throw new Error(`[SalesDb] 非法客户事件类型: ${input.event_type}（P0-3 E3 仅允许 customer_replied/quote_asked/script_copied/chat_opened/follow_up_done）`)
    }
    if (input.message_key) {
      const dup = this.get<{ c: number }>('SELECT COUNT(*) as c FROM customer_event WHERE message_key = ?', [input.message_key])
      if ((dup?.c ?? 0) > 0) return null // 幂等拒绝：同 key 已存在
    }
    const created = input.createdAt ?? Date.now()
    this.run(
      'INSERT INTO customer_event (session_id, task_id, event_type, message_key, evidence_text, source, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [input.session_id, input.task_id ?? null, input.event_type, input.message_key ?? null, input.evidence_text ?? null,
       input.source, input.metadata ?? null, created]
    )
    const id = this.lastInsertRowId()
    return this.get<CustomerEventRecord>('SELECT * FROM customer_event WHERE id = ?', [id])!
  }

  /** 事件流：该 session 全部事件（倒序；append-only 历史） */
  customerEventsBySession(sessionId: string, limit: number = 50): CustomerEventRecord[] {
    return this.all<CustomerEventRecord>(
      'SELECT * FROM customer_event WHERE session_id = ? ORDER BY created_at DESC, id DESC LIMIT ?',
      [sessionId, limit]
    )
  }

  /** 按类型查询事件（sinceMs 可选：只取该时刻之后；E3.2+ 生产者验证 / P0-4 漏斗用） */
  customerEventsByType(eventType: CustomerEventType, sinceMs?: number, limit: number = 100): CustomerEventRecord[] {
    const sql = sinceMs !== undefined
      ? 'SELECT * FROM customer_event WHERE event_type = ? AND created_at >= ? ORDER BY created_at DESC, id DESC LIMIT ?'
      : 'SELECT * FROM customer_event WHERE event_type = ? ORDER BY created_at DESC, id DESC LIMIT ?'
    const params: unknown[] = sinceMs !== undefined ? [eventType, sinceMs, limit] : [eventType, limit]
    return this.all<CustomerEventRecord>(sql, params)
  }

  // ─── 跟进待办 ─────────────────────────────────────────────────────────────

  /** P0-4.2.2：窗口内创建的任务（created_at >= ms，ms=null 全量；Action Funnel created 段数据源） */
  tasksCreatedSince(ms: number | null): FollowUpTask[] {
    if (ms === null) return this.all<FollowUpTask>('SELECT * FROM follow_up_task ORDER BY created_at ASC')
    return this.all<FollowUpTask>('SELECT * FROM follow_up_task WHERE created_at >= ? ORDER BY created_at ASC', [ms])
  }

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
      `INSERT INTO follow_up_task (session_id, customer_profile_id, display_name, source_message_id, promise_summary, action_type, trigger_type, title, due_at, status, priority_score, created_by, confidence, feedback_log, source_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [task.session_id ?? null, task.customer_profile_id ?? null, task.display_name ?? null, task.source_message_id ?? null, task.promise_summary ?? null, task.action_type ?? 'reply_customer', task.trigger_type, task.title, task.due_at ?? null, task.status ?? 'pending', task.priority_score ?? 0, task.created_by ?? 'ai', task.confidence ?? null, task.feedback_log ?? '[]', task.source_id ?? null, now]
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
  /**
   * 历史累计流转漏斗（days=0 表示全部历史）。
   * 统计口径：窗口内「曾进入过某档位」的去重客户数（同一客户同一档位只计 1 次，
   * 绝不按 intent_tag_log 行数统计——部分写入方不跳过未变化会产生重复记录）。
   */
  funnelStats(days = 30): {
    funnel: Array<{ stage: FunnelStage; count: number }>
    conversion: Array<{ from: string; to: string; rate: number }>
    intentTimeline: Array<{ date: string; stage: string; count: number }>
    currentDistribution: Array<{ stage: string; count: number }>
    totalCustomers: number
    newCustomersInWindow: number
  } {
    const sinceMs = days > 0 ? Date.now() - days * 86400_000 : 0
    // ① 窗口内意向日志（归一化必须在 TS 层，sql.js 无自定义函数）
    const rows = sinceMs > 0
      ? this.all<{ session_id: string; stage: string; created_at: number }>(
          'SELECT session_id, stage, created_at FROM intent_tag_log WHERE created_at >= ?', [sinceMs])
      : this.all<{ session_id: string; stage: string; created_at: number }>(
          'SELECT session_id, stage, created_at FROM intent_tag_log', [])
    // ② 独立去重：firstIn[档位][session_id] = 窗口内首次进入时间
    const firstIn: Record<string, Record<string, number>> = {}
    for (const r of rows) {
      const bucket = stageToFunnel(r.stage)
      const m = (firstIn[bucket] ??= {})
      const ts = Number(r.created_at)
      if (m[r.session_id] === undefined || ts < m[r.session_id]) m[r.session_id] = ts
    }
    // ③ 各档位去重人数
    const funnel = FUNNEL_ORDER.map((s) => ({ stage: s, count: Object.keys(firstIn[s] ?? {}).length }))
    // ④ 相邻转化率（了解→比价→决策→成交；除零为 0；跳级可 >100%）
    const cnt = (s: FunnelStage) => funnel.find((f) => f.stage === s)?.count ?? 0
    const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0)
    const conversion = [
      { from: '了解', to: '比价', rate: pct(cnt('比价'), cnt('了解')) },
      { from: '比价', to: '决策', rate: pct(cnt('决策'), cnt('比价')) },
      { from: '决策', to: '成交', rate: pct(cnt('成交'), cnt('决策')) },
    ]
    // ⑤ 每天流入各档位（以窗口内首次进入该档位时间落日，逐日×逐档位补零）
    const trend: Record<string, Record<string, number>> = {}
    for (const [bucket, m] of Object.entries(firstIn)) {
      for (const ts of Object.values(m)) {
        const d = this.dayKey(ts)
        const dm = (trend[d] ??= {})
        dm[bucket] = (dm[bucket] ?? 0) + 1
      }
    }
    const intentTimeline = this.orderedDays(sinceMs).flatMap((d) =>
      FUNNEL_ORDER.map((s) => ({ date: d, stage: s, count: trend[d]?.[s] ?? 0 })))
    // ⑥ 当前快照（customer_profile 当前阶段，归一化归桶）
    const curMap: Record<string, number> = {}
    for (const r of this.all<{ stage: string; cnt: number }>('SELECT stage, COUNT(*) AS cnt FROM customer_profile GROUP BY stage', [])) {
      const b = stageToFunnel(r.stage)
      curMap[b] = (curMap[b] ?? 0) + Number(r.cnt)
    }
    const currentDistribution = FUNNEL_ORDER.map((s) => ({ stage: s, count: curMap[s] ?? 0 }))
    const totalCustomers = Number(this.get<{ c: number }>('SELECT COUNT(*) AS c FROM customer_profile', [])?.c || 0)
    // ⑦ 窗口内新进漏斗客户（出现过任意档位记录的去重 session 数）
    const newCustomersInWindow = new Set(rows.map((r) => r.session_id)).size
    return { funnel, conversion, intentTimeline, currentDistribution, totalCustomers, newCustomersInWindow }
  }

  /** 毫秒 → 本地日期键 YYYY-MM-DD（与前端 weekTrend 口径一致） */
  private dayKey(ts: number): string {
    const d = new Date(ts)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }

  /** 窗口起始日 → 今天 逐日生成日期键（days=0 全部历史时数据可能跨多周，仍逐日补零） */
  private orderedDays(sinceMs: number): string[] {
    const start = sinceMs > 0 ? sinceMs : Math.min(...(this.all<{ created_at: number }>('SELECT created_at FROM intent_tag_log', []).map((r) => Number(r.created_at))), Date.now())
    const days: string[] = []
    const cur = new Date(start)
    const today = new Date()
    while (cur <= today) {
      days.push(`${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}-${String(cur.getDate()).padStart(2, '0')}`)
      cur.setDate(cur.getDate() + 1)
    }
    return days
  }

  customerAll(): CustomerProfile[] {
    return this.all<CustomerProfile>('SELECT * FROM customer_profile', [])
  }

  /**
   * 客户意向评分 0-100（P0）：阶段 + 近 7 天意向活跃 + 久未跟进衰减 + 商机进展。
   * opp 由调用方跨库装配（crmDbService.activeOpportunitiesByAccount）。
   */
  intentScore(sessionId: string, opp?: { count: number; quantity: number; amount: number }): IntentScore | null {
    const p = this.customerGetBySession(sessionId)
    if (!p) return null
    const since = Date.now() - ACTIVE_WINDOW_MS
    const recent = Number(this.all('SELECT COUNT(*) AS c FROM intent_tag_log WHERE session_id = ? AND created_at >= ?', [sessionId, since])[0]?.c ?? 0)
    const last = this.all('SELECT created_at FROM intent_tag_log WHERE session_id = ? ORDER BY id DESC LIMIT 1', [sessionId])[0]
    return computeIntentScore({
      stage: String(p.stage || 'unknown'),
      // last_contact_at 生产环境为秒（WCDB createTime 回填，salesActionEngine 亦按秒比较）；
      // computeIntentScore 内部用 Date.now()（毫秒），秒→毫秒转换，否则衰减恒 30（P0-2A.1 bug2）
      lastContactAt: (Number(p.last_contact_at) || 0) * 1000,
      recentEventCount: recent,
      lastEventAt: last ? Number(last.created_at) : 0,
      oppCount: opp?.count || 0,
      oppQuantity: opp?.quantity || 0,
      oppAmount: opp?.amount || 0
    })
  }

  /**
   * 客户当前状态读取模型（P0-2A.2）：把现有 stage 存储（中英混存 + dormant 曾混入）解释为
   * 统一状态 stage(6) + activityState + stateMeta。只读，不改 schema。
   * nowSec 可注入固定时间（测试）；生产默认 Date.now()/1000。
   */
  getCanonicalState(sessionId: string, nowSec?: number): CanonicalState | null {
    const p = this.customerGetBySession(sessionId)
    if (!p) return null
    const recentIntents = this.intentHistory(sessionId, 20).map((r) => ({
      stage: r.stage,
      source: r.source ?? null,
      confidence: r.confidence ?? null,
      createdAt: r.created_at ?? null,
      reason: r.reason ?? null,
      evidenceText: r.evidence_text ?? null,
      messageKey: r.message_key ?? null
    }))
    return computeCanonicalState({
      rawStage: p.stage,
      lastContactAt: Number(p.last_contact_at) || 0,
      lastStageChangeAt: p.last_stage_change_at ?? null,
      nowSec: nowSec ?? Math.floor(Date.now() / 1000),
      recentIntents
    })
  }

  /** 按 id 查跟进任务（SLA 闭环需要读 task 的 source_id/trigger_type） */
  getTask(id: number): FollowUpTask | undefined {
    return this.get<FollowUpTask>('SELECT * FROM follow_up_task WHERE id = ?', [id])
  }

  /** 线索 SLA 卡：按 source_id 查该 lead 当前 pending 的 sla_lead 卡 */
  slaTaskByLead(leadId: number): FollowUpTask | undefined {
    return this.get<FollowUpTask>(
      "SELECT * FROM follow_up_task WHERE trigger_type = 'sla_lead' AND source_id = ? AND status = 'pending'",
      [leadId]
    )
  }

  /** 该 lead 是否已存在 pending 的 SLA 卡（scanLeadSla 幂等应用层判断） */
  hasSlaPendingTask(leadId: number): boolean {
    return this.slaTaskByLead(leadId) !== undefined
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
