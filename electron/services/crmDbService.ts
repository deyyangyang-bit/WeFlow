import { createHash } from 'crypto'
import { isPriceOverride, type PriceOverride } from '../../shared/priceOverride'
import { parseJsonObject } from '../../shared/safeJson'
/**
 * crmDbService.ts
 * CRM 模块数据层：独立 weflow-crm.db（sql.js/WASM），模式复用 salesDbService。
 * 蓝本：Cordys(领域骨架/表单形态) 悟空-11(财务字段) MoChat(归属状态机) Twenty(增量元数据)。
 * 合规：数据本地；删除为级联且删除前自动备份（crm-backups/）；时间戳统一毫秒。
 */
import { existsSync, mkdirSync, renameSync, rmSync } from 'fs'
import { readdirSync } from 'fs'
import { basename, dirname, join } from 'path'
import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js'
import { salesLog } from './salesLogger'
import { archivedDbName, businessDbPath } from './businessDbPath'
import { atomicWriteFileSync, loadBusinessDbWithGuard, dbGuardLog } from './atomicPersist'
import { trackProposalEvent, currentActor } from './proposalEventTracking'
import { emitInfoFieldConfirmed, emitOpportunityDealRegistered } from './crmLifecycleHooks'

// ─── 建表 SQL ────────────────────────────────────────────────────────────────
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS lead (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_type TEXT NOT NULL DEFAULT 'phone',
  contact_normalized TEXT NOT NULL,
  contact_raw TEXT,
  wechat TEXT DEFAULT '',
  source TEXT DEFAULT '抖音',
  name TEXT DEFAULT '',
  tag TEXT DEFAULT '',
  note TEXT DEFAULT '',
  status TEXT DEFAULT 'NEW',
  dead_reason TEXT DEFAULT '',
  first_contact_channel TEXT DEFAULT '',
  account_id INTEGER,
  first_contacted_at INTEGER,
  first_contact_deadline INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER,
  owner_id INTEGER DEFAULT 0,
  pool_id INTEGER DEFAULT 0,
  assigned_at INTEGER,
  private_deadline INTEGER
);
CREATE TABLE IF NOT EXISTS lead_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  note TEXT DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lead_activity_lead ON lead_activity(lead_id);
CREATE TABLE IF NOT EXISTS import_batch (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  file_name TEXT DEFAULT '',
  total INTEGER DEFAULT 0,
  valid INTEGER DEFAULT 0,
  duplicate INTEGER DEFAULT 0,
  invalid INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
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
  product TEXT DEFAULT '', quantity INTEGER DEFAULT 0,
  intent_score INTEGER DEFAULT 0, status TEXT DEFAULT 'active',
  last_signal_at INTEGER DEFAULT 0, expected_close_at INTEGER DEFAULT 0,
  main_resistance TEXT DEFAULT '', competitor TEXT DEFAULT '',
  custom_fields TEXT DEFAULT '{}', created_at INTEGER, updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS opportunity_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  opportunity_id INTEGER NOT NULL, event_type TEXT NOT NULL,
  stage TEXT DEFAULT '', detail TEXT DEFAULT '', created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_opp_event_opp ON opportunity_event(opportunity_id);
CREATE TABLE IF NOT EXISTS crm_risk (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER, opportunity_id INTEGER,
  risk_type TEXT NOT NULL, detail TEXT DEFAULT '',
  severity TEXT DEFAULT 'medium', source_msg TEXT DEFAULT '',
  status TEXT DEFAULT 'active', created_at INTEGER NOT NULL, resolved_at INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_crm_risk_account ON crm_risk(account_id, status);
CREATE TABLE IF NOT EXISTS contract (
  id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER, name TEXT,
  amount REAL DEFAULT 0, status TEXT DEFAULT 'pending_sign', sign_date INTEGER,
  custom_fields TEXT DEFAULT '{}', attachment_path TEXT, created_at INTEGER, updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS quotation (
  id INTEGER PRIMARY KEY AUTOINCREMENT, contract_id INTEGER, total REAL DEFAULT 0,
  valid_until INTEGER, status TEXT DEFAULT 'draft', items TEXT DEFAULT '[]',
  attachment_path TEXT, custom_fields TEXT DEFAULT '{}', created_at INTEGER
);
CREATE TABLE IF NOT EXISTS invoice (
  id INTEGER PRIMARY KEY AUTOINCREMENT, contract_id INTEGER, account_id INTEGER, invoice_no TEXT,
  buyer TEXT, invoice_type TEXT, amount REAL DEFAULT 0, tax_rate REAL,
  invoice_date INTEGER, status TEXT DEFAULT 'pre_issue', attachment_path TEXT,
  custom_fields TEXT DEFAULT '{}', created_at INTEGER, auto_updated_by TEXT
);
CREATE TABLE IF NOT EXISTS payment_record (
  id INTEGER PRIMARY KEY AUTOINCREMENT, msg_id TEXT, group_id TEXT, bank TEXT,
  account_tail TEXT, payer TEXT, amount_net REAL DEFAULT 0, pay_time INTEGER,
  memo TEXT, source TEXT DEFAULT 'bank_text', pay_channel TEXT DEFAULT 'bank_direct',
  needs_review INTEGER DEFAULT 0, attachment_path TEXT, raw_content TEXT, created_at INTEGER,
  auto_approved_by TEXT
);
CREATE TABLE IF NOT EXISTS allocation (
  id INTEGER PRIMARY KEY AUTOINCREMENT, payment_record_id INTEGER,
  customer_hint TEXT, sales_hint TEXT, amount_hint REAL DEFAULT 0,
  credited_amount REAL DEFAULT 0, account_id INTEGER, contract_id INTEGER,
  sales_name TEXT, status TEXT DEFAULT 'pending', created_at INTEGER, confirmed_at INTEGER,
  auto_confirmed_by TEXT, auto_reason TEXT
);
CREATE TABLE IF NOT EXISTS logistics (
  id INTEGER PRIMARY KEY AUTOINCREMENT, tracking_no TEXT, brand TEXT,
  receiver TEXT, city TEXT, courier TEXT, status TEXT DEFAULT 'shipped',
  latest_update_at INTEGER, source_msg_id TEXT, link_status TEXT DEFAULT 'unlinked',
  account_id INTEGER, contract_id INTEGER, created_at INTEGER, auto_linked_by TEXT
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
CREATE TABLE IF NOT EXISTS migration_report (
  module TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '{}', failures TEXT NOT NULL DEFAULT '[]',
  conflicts TEXT NOT NULL DEFAULT '[]', ran_at INTEGER NOT NULL DEFAULT 0
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
CREATE TABLE IF NOT EXISTS auto_confirm_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, entity TEXT, entity_id INTEGER,
  decision TEXT, confidence REAL DEFAULT 0, reason TEXT DEFAULT '', action TEXT DEFAULT '',
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_crm_auto_confirm_created ON auto_confirm_log(created_at);
CREATE TABLE IF NOT EXISTS quote_signal (
  id INTEGER PRIMARY KEY AUTOINCREMENT, msg_key TEXT UNIQUE, session_id TEXT, account_id INTEGER,
  display_name TEXT, amount REAL, model TEXT, quoted_at INTEGER,
  customer_replied_at INTEGER DEFAULT 0, created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_crm_quote_session ON quote_signal(session_id, quoted_at);
-- ── Phase 0 D3（宪法 §4.1，2026-09-02）新建 6 表 ─────────────────────────────
-- 通用五列：source/updated_by/updated_at/version/deleted；append-only 表例外见宪法 §2.2
-- （ownership_history/outbox_event/audit_event 无删除标记；沿用 intent_tag_log/customer_event
--   先例只带 source/时间列，不设永不更新的 version/updated_by 死列——防 lead 四死列教训）
CREATE TABLE IF NOT EXISTS customer (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL DEFAULT '',
  type TEXT DEFAULT '',
  brand TEXT DEFAULT '',
  vehicle_age INTEGER,
  modified INTEGER DEFAULT 0,
  source TEXT DEFAULT '',
  updated_by TEXT DEFAULT '',
  updated_at INTEGER,
  version INTEGER DEFAULT 1,
  deleted INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_customer_name ON customer(name);
CREATE TABLE IF NOT EXISTS customer_identity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  identity_type TEXT NOT NULL CHECK (identity_type IN ('phone', 'wxid')),
  identity_value TEXT NOT NULL,
  customer_id INTEGER,
  source TEXT DEFAULT 'auto',
  confidence REAL DEFAULT 1.0,
  updated_by TEXT DEFAULT '',
  updated_at INTEGER,
  version INTEGER DEFAULT 1,
  deleted INTEGER DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cust_ident_pair ON customer_identity(identity_type, identity_value);
CREATE INDEX IF NOT EXISTS idx_cust_ident_customer ON customer_identity(customer_id);
CREATE TABLE IF NOT EXISTS assignment (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL,
  sales_name TEXT DEFAULT '',
  mode TEXT DEFAULT '',
  sla1_deadline INTEGER,
  sla1_met_at INTEGER,
  claimed_at INTEGER,
  sla2_scan_ref TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'assigned' CHECK (status IN ('assigned', 'claimed', 'recycled', 'transferred')),
  source TEXT DEFAULT '',
  updated_by TEXT DEFAULT '',
  updated_at INTEGER,
  version INTEGER DEFAULT 1,
  deleted INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_assignment_lead ON assignment(lead_id);
-- ── first_classification（宪法 §3，2026-09-10 本刀登记后建表；PRD 2.4 认领满 24h AI 首次分类配套）──
-- 认领轮次级提案事实表：assignment_id UNIQUE = 轮次幂等键（转派新建 assignment 行 = 新轮次）。
-- status 有穷枚举 CHECK 硬门禁；failed 可重试不写假结果；confirmed/rejected 历史行保留。
CREATE TABLE IF NOT EXISTS first_classification (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assignment_id INTEGER NOT NULL,
  lead_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'proposed', 'confirmed', 'rejected', 'failed')),
  result_json TEXT DEFAULT '{}',
  evidence_json TEXT DEFAULT '{}',
  gaps_json TEXT DEFAULT '[]',
  error TEXT DEFAULT '',
  trigger_source TEXT DEFAULT 'scan',
  model TEXT DEFAULT '',
  decided_by TEXT DEFAULT '',
  decided_at INTEGER,
  source TEXT DEFAULT '',
  updated_by TEXT DEFAULT '',
  updated_at INTEGER,
  version INTEGER DEFAULT 1,
  deleted INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_first_classify_round ON first_classification(assignment_id);
CREATE INDEX IF NOT EXISTS idx_first_classify_lead ON first_classification(lead_id, status);
CREATE TABLE IF NOT EXISTS ownership_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  old_owner TEXT DEFAULT '',
  new_owner TEXT DEFAULT '',
  reason TEXT DEFAULT '',
  actor TEXT DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ownhist_entity ON ownership_history(entity_type, entity_id);
CREATE TABLE IF NOT EXISTS outbox_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_seq INTEGER,
  idempotency_key TEXT,
  payload TEXT DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  source TEXT DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_outbox_idem ON outbox_event(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox_event(status);
CREATE TABLE IF NOT EXISTS audit_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT DEFAULT '',
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id INTEGER,
  detail TEXT DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_event(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_event(created_at);
-- ── payment_promise（宪法 §3，2026-09-05 本刀登记后建表；告警 D「承诺打款日过期」配套）──
-- 客户明确承诺付款时间登记：到期无款 → alertService.createAlert({type:'payment_overdue'}) 四道闸。
-- 通用五列齐全；status 有穷枚举 CHECK 硬门禁（§1 新表约定）；幂等键 UNIQUE(account_id, evidence_key)。
CREATE TABLE IF NOT EXISTS payment_promise (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  session_id TEXT DEFAULT '',
  lead_id INTEGER,
  promise_text TEXT DEFAULT '',
  due_date INTEGER NOT NULL,
  evidence_key TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'kept', 'overdue', 'cancelled')),
  source TEXT DEFAULT 'llm',
  updated_by TEXT DEFAULT '',
  updated_at INTEGER,
  version INTEGER DEFAULT 1,
  deleted INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_promise_evidence ON payment_promise(account_id, evidence_key);
CREATE INDEX IF NOT EXISTS idx_payment_promise_scan ON payment_promise(status, due_date);
-- ── notify_inbox（主管升级提醒收件箱，2026-09-08 SLA1 三次超时主管通知闭环）────
-- sla1_escalate_supervisor 下行通知在中枢的落地终点（lanSyncService.consumeSupervisorNotifications
-- 单写者）：idempotency_key 唯一幂等；status unread/read 两态供 UI 列表与已读；detail 存脱敏摘要
-- （原归属/三次超时/回收时间/原因，宪法 §1.12 配套；联系方式过 maskContact 脱敏）。
CREATE TABLE IF NOT EXISTS notify_inbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  notify_type TEXT NOT NULL DEFAULT 'sla1_escalate',
  idempotency_key TEXT NOT NULL,
  title TEXT DEFAULT '',
  body TEXT DEFAULT '',
  lead_id INTEGER,
  detail TEXT DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'unread' CHECK (status IN ('unread', 'read')),
  source TEXT DEFAULT 'sync',
  updated_by TEXT DEFAULT '',
  updated_at INTEGER,
  version INTEGER DEFAULT 1,
  deleted INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notify_inbox_key ON notify_inbox(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_notify_inbox_status ON notify_inbox(status, created_at);
`

// lead 索引独立于 SCHEMA_SQL：旧空壳 lead 表无 contact_type 列，若在 SCHEMA_SQL 中建索引
// 会在旧表上直接报 no such column 导致 initialize 在迁移逻辑前崩溃。故在迁移重建后执行（幂等）。
const LEAD_INDEXES_SQL = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_lead_contact ON lead(contact_type, contact_normalized);
CREATE INDEX IF NOT EXISTS idx_lead_status ON lead(status);
CREATE INDEX IF NOT EXISTS idx_lead_source ON lead(source);
CREATE INDEX IF NOT EXISTS idx_lead_sla ON lead(status, first_contact_deadline);
`

export interface CrmRow { [key: string]: any }

const ENTITIES = [
  'lead', 'lead_activity', 'import_batch',
  'account', 'contact', 'opportunity', 'contract', 'quotation', 'invoice',
  'payment_record', 'allocation', 'logistics', 'product', 'alias_map', 'group_config', 'shipping_info',
  'contract_status_history', 'activity_log', 'quote_signal', 'opportunity_event', 'crm_risk',
  'customer', 'customer_identity', 'assignment', 'ownership_history', 'outbox_event', 'audit_event',
  'payment_promise', 'notify_inbox', 'first_classification'
] as const
export type CrmEntity = (typeof ENTITIES)[number]

// ─── 客户信息自动填充（enrich）：字段定义 + 纯合并规则（可单测）───────────────
/** AI 可自动填充的客户字段：前 6 个为 account 正式列，其余存 custom_fields */
export const ENRICH_FIELDS = [
  'company', 'position', 'phone', 'industry', 'province', 'city',
  'needs', 'budget', 'intent_model', 'purchase_timeframe', 'competitor', 'price_sensitive'
] as const
export const ENRICH_FORMAL_COLUMNS: ReadonlySet<string> = new Set(['company', 'position', 'phone', 'industry', 'province', 'city'])

export type EnrichFieldSource = 'ai' | 'manual'
/** model：生成该值的 AI 模型名（PRD§23 可追溯）；sourceId：该值依据的聊天消息 messageKey（可追溯到具体聊天） */
export interface EnrichFieldMetaEntry { source: EnrichFieldSource; confidence: number; at: number; evidence?: string; locked?: boolean; model?: string; sourceId?: string }
export interface PendingFieldEntry { value: string; confidence: number; evidence?: string; at: number; model?: string; sourceId?: string }
export interface EnrichMeta { fields?: Record<string, EnrichFieldMetaEntry>; pending?: Record<string, PendingFieldEntry> }
export interface EnrichIncomingField { value: string; confidence: number; evidence?: string; model?: string; sourceId?: string }

export function parseEnrichMeta(raw: string | null | undefined): EnrichMeta {
  if (!raw) return {}
  try {
    const o = JSON.parse(String(raw))
    return o && typeof o === 'object' ? (o as EnrichMeta) : {}
  } catch { return {} }
}

export interface MergeEnrichResult {
  /** 直接写入的字段（含新 meta） */
  updates: Record<string, { value: string; meta: EnrichFieldMetaEntry }>
  /** 与既有高值冲突、需人工裁决的字段 */
  pending: Record<string, PendingFieldEntry>
  /** 手动/锁定字段，AI 不覆盖 */
  skipped: string[]
  /** 新证据弱于既有 AI 证据，丢弃 */
  discarded: string[]
  /** 值相同，仅刷新 meta */
  refreshed: string[]
}

/**
 * 字段合并规则（纯函数）：
 * 1 手动/锁定字段永不覆盖（skipped）
 * 2 目标为空 → 写入
 * 3 值相同 → 仅刷新 meta（置信度取高）
 * 4 既有 ai 值：新置信 ≥ 旧置信 → 覆盖；否则丢弃
 * 5 既有值无 meta（历史/手动数据）且新值置信 ≥ threshold → 进 pending 人工裁决；否则丢弃
 */
export function mergeEnrichFields(
  current: Record<string, string | null | undefined>,
  meta: EnrichMeta,
  incoming: Record<string, EnrichIncomingField>,
  opts: { threshold?: number; now?: number } = {}
): MergeEnrichResult {
  const threshold = opts.threshold ?? 0.7
  const now = opts.now ?? Date.now()
  const result: MergeEnrichResult = { updates: {}, pending: {}, skipped: [], discarded: [], refreshed: [] }
  const fields = meta.fields || {}
  for (const [field, item] of Object.entries(incoming)) {
    const value = String(item?.value || '').trim()
    if (!value) continue
    const m = fields[field]
    if (m?.locked || m?.source === 'manual') { result.skipped.push(field); continue }
    const cur = String(current[field] ?? '').trim()
    if (!cur) {
      result.updates[field] = { value, meta: { source: 'ai', confidence: item.confidence, at: now, evidence: item.evidence, model: item.model, sourceId: item.sourceId } }
      continue
    }
    if (cur === value) {
      result.refreshed.push(field)
      result.updates[field] = {
        value,
        meta: { source: 'ai', confidence: Math.max(item.confidence, m?.confidence ?? 0), at: now, evidence: item.evidence || m?.evidence, model: item.model || m?.model, sourceId: item.sourceId || m?.sourceId }
      }
      continue
    }
    if (m?.source === 'ai') {
      if (item.confidence >= (m.confidence ?? 0)) {
        result.updates[field] = { value, meta: { source: 'ai', confidence: item.confidence, at: now, evidence: item.evidence, model: item.model, sourceId: item.sourceId } }
      } else {
        result.discarded.push(field)
      }
      continue
    }
    // 既有值无 AI meta（历史/手动数据）：够置信则进 pending 人工裁决
    if (item.confidence >= threshold) {
      result.pending[field] = { value, confidence: item.confidence, evidence: item.evidence, at: now, model: item.model, sourceId: item.sourceId }
    } else {
      result.discarded.push(field)
    }
  }
  return result
}

/** 正式成交登记 payload（PRD 5.1 字段级规格；宪法 §1.5 修订 2026-09-09） */
export interface OpportunityDealPayload {
  /** CNY 结算额（业绩/报表统一口径），必须 > 0 */
  amount_cny: number
  /** 原币币种（ISO 代码，缺省 CNY）；非 CNY 时 original_amount / rate_note 必填 */
  original_currency?: string
  original_amount?: number
  /** 汇率折算口径/凭证说明（支付订单号、回单截图哈希等） */
  rate_note?: string
  /** 主型号：必须来自 product（model 或 name 精确命中） */
  main_model: string
  /** 补充型号（自由文本；落 custom_fields.supplementary_models，与商机页展示同键） */
  model_extra?: string
  /** 订单量（台），正整数 */
  order_qty: number
  /** 预计发运窗口（epoch ms；end 不得早于 start） */
  expected_ship_start?: number
  expected_ship_end?: number
  /** 交付日期（售后设备提醒起算基准） */
  delivery_date?: number
  /** 整车 / 改装 */
  type?: string
  /** 绑定报价版本：必须属于该商机客户的合同且为现行有效版本（历史版本只读不可绑定） */
  quote_version_id?: number | null
  /** 成交备注（写入 opportunity_event 留痕） */
  note?: string
  /** 操作者署名（缺省取本机身份档案，宪法 §1.12） */
  actor?: string
}

class CrmDbService {
  private db: SqlJsDatabase | null = null
  private dbPath: string | null = null
  private entryGeneration = 0
  private saveTimer: NodeJS.Timeout | null = null
  // 并发护栏：main.ts 启动 await 与 crmIpcHandlers void 双路径会同时 initialize，
  // 分库后两次加载的是不同账号库，必须去重为同一次加载
  private initPromise: Promise<void> | null = null

  async initialize(userDataPath: string, wxid?: string): Promise<void> {
    if (this.db) return
    if (this.initPromise) return this.initPromise
    this.initPromise = this.doInitialize(userDataPath, wxid)
    try {
      await this.initPromise
    } catch (e) {
      this.initPromise = null // 失败允许后续重试
      throw e
    }
  }

  private async doInitialize(userDataPath: string, wxid?: string): Promise<void> {
    if (!existsSync(userDataPath)) mkdirSync(userDataPath, { recursive: true })
    // §2.40 微信号分库：wxid 空（未完成引导）回退 legacy 名
    this.entryGeneration++
    this.dbPath = businessDbPath(userDataPath, wxid, 'crm')
    // 打包态 wasm 在 electron/node_modules；dev/测试态在项目根 node_modules
    const wasmCandidates = [
      join(__dirname, '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
      join(__dirname, '..', '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm')
    ]
    const wasmPath = wasmCandidates.find((p) => existsSync(p)) ?? wasmCandidates[0]
    const SQL = await initSqlJs({ locateFile: () => wasmPath })
    // §2.52 启动守卫：0 字节/解析失败禁止静默空库——留证 → 自动备份恢复 → 无备份才空库（ERROR 日志）。
    // 恢复成功（outcome='restored'）的 audit_event 补写在本函数尾部（SCHEMA_SQL 保证表存在之后）。
    const openRes = loadBusinessDbWithGuard(SQL, this.dbPath, userDataPath, '[CrmDb]', dbGuardLog)
    this.db = openRes.db
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
      ['last_contact_at', 'INTEGER'], ['imported_at', 'INTEGER'],
      ['company', 'TEXT'], ['position', 'TEXT'], ['enrich_meta', "TEXT DEFAULT '{}'"]
    ]
    for (const [col, type] of accountCols) {
      try { this.db.run(`ALTER TABLE account ADD COLUMN ${col} ${type}`) } catch { /* 列已存在 */ }
    }
    // Migration: 确认中心自动确认审计列（auto_confirm_log 表由 SCHEMA_SQL 保证）
    const autoConfirmCols: Array<[string, string, string]> = [
      ['allocation', 'auto_confirmed_by', 'TEXT'], ['allocation', 'auto_reason', 'TEXT'],
      ['payment_record', 'auto_approved_by', 'TEXT'],
      ['logistics', 'auto_linked_by', 'TEXT'],
      ['invoice', 'account_id', 'INTEGER'], ['invoice', 'auto_updated_by', 'TEXT']
    ]
    for (const [table, col, type] of autoConfirmCols) {
      try { this.db.run(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`) } catch { /* 列已存在 */ }
    }
    // Migration: logistics 跟单列（认领销售 + 签收时间 + 认领客户；signed_at 0 = 未签收）
    // account_id = 物流归属客户（无合同客户也认领），contract_id 可选关联合同
    const logisticsTrackCols: Array<[string, string]> = [
      ['owner_sales', "TEXT DEFAULT ''"], ['signed_at', 'INTEGER DEFAULT 0'],
      ['account_id', 'INTEGER']
    ]
    for (const [col, type] of logisticsTrackCols) {
      try { this.db.run(`ALTER TABLE logistics ADD COLUMN ${col} ${type}`) } catch { /* 列已存在 */ }
    }
    // Migration: contract 补 attachment_path（docgen 生成的合同 docx 路径写回用）
    try { this.db.run('ALTER TABLE contract ADD COLUMN attachment_path TEXT') } catch { /* 列已存在 */ }
    // Migration: opportunity 商机模块列（AI 从聊天自动识别采购信号 → 商机；opportunity_event 表由 SCHEMA_SQL 保证）
    const oppCols: Array<[string, string]> = [
      ['product', "TEXT DEFAULT ''"], ['quantity', 'INTEGER DEFAULT 0'],
      ['intent_score', 'INTEGER DEFAULT 0'], ['status', "TEXT DEFAULT 'active'"],
      ['last_signal_at', 'INTEGER DEFAULT 0'], ['expected_close_at', 'INTEGER DEFAULT 0'],
      ['main_resistance', "TEXT DEFAULT ''"], ['competitor', "TEXT DEFAULT ''"]
    ]
    for (const [col, type] of oppCols) {
      try { this.db.run(`ALTER TABLE opportunity ADD COLUMN ${col} ${type}`) } catch { /* 列已存在 */ }
    }
    // Migration: Phase 0 D3（宪法 §4.1，2026-09-02）存量表补列（幂等 ALTER 吞错；6 新表由 SCHEMA_SQL 保证）
    // ① account.customer_id 可空挂接（宪法 §1.1/§4.3：Phase 1 迁移回填，account 本体 28 项能力照旧）
    try { this.db.run('ALTER TABLE account ADD COLUMN customer_id INTEGER') } catch { /* 列已存在 */ }
    // ①' assignment.sla1_met_at（PRD 1.4a 加好友判定「停表」标记，2026-09-04）：
    //     NULL=计时中；命中加好友（手动绑定/自动检测）写停表时刻；SLA1 回收器只扫 sla1_met_at IS NULL 的行
    try { this.db.run('ALTER TABLE assignment ADD COLUMN sla1_met_at INTEGER') } catch { /* 列已存在 */ }
    // ①'' assignment.sla1_remind_count（三次提醒制，宪法 §1.3 修订 2026-09-05，UI设计稿屏 4/屏 6）：
    //     0=未提醒过；超时未停表第 1/2 次只提醒（+1+审计，状态零变更），满第 3 次才回收
    try { this.db.run('ALTER TABLE assignment ADD COLUMN sla1_remind_count INTEGER DEFAULT 0') } catch { /* 列已存在 */ }
    // ①''' assignment.claimed_at（PRD 2.4 认领满 24h 首次分类触发轴，宪法 §1.3 修订 2026-09-10）：
    //     认领时刻毫秒，NULL=未认领；claimLead 单点写入；存量 NULL 不回填（不拿过去时刻当触发基点）
    try { this.db.run('ALTER TABLE assignment ADD COLUMN claimed_at INTEGER') } catch { /* 列已存在 */ }
    // ② opportunity 补列（宪法 §1.5：发现来源 / 整车改装类型 / 多币种金额 / 主车型 / 订单与发货量 /
    //    预期发货窗口 / 报价版本与 customer 挂接；逻辑外键，不建 FK 约束——跨库与既有表铁律）
    const oppPhase0Cols: Array<[string, string]> = [
      ['source', "TEXT DEFAULT ''"], ['type', "TEXT DEFAULT ''"],
      ['amount_cny', 'REAL DEFAULT 0'], ['original_currency', "TEXT DEFAULT ''"],
      ['original_amount', 'REAL DEFAULT 0'], ['rate_note', "TEXT DEFAULT ''"],
      ['main_model', "TEXT DEFAULT ''"], ['order_qty', 'INTEGER DEFAULT 0'],
      ['shipped_qty', 'INTEGER DEFAULT 0'], ['expected_ship_start', 'INTEGER DEFAULT 0'],
      ['expected_ship_end', 'INTEGER DEFAULT 0'], ['delivery_date', 'INTEGER DEFAULT 0'],
      ['quote_version_id', 'INTEGER'], ['customer_id', 'INTEGER']
    ]
    for (const [col, type] of oppPhase0Cols) {
      try { this.db.run(`ALTER TABLE opportunity ADD COLUMN ${col} ${type}`) } catch { /* 列已存在 */ }
    }
    // ②″ opportunity.over_ship_reason（交付售后超发原因，宪法 §3 登记 2026-09-10）：快照文本，0 字 = 未超发
    try { this.db.run("ALTER TABLE opportunity ADD COLUMN over_ship_reason TEXT DEFAULT ''") } catch { /* 列已存在 */ }
    // ②‴ customer 设备档案 7 字段 + 质保 + 复购等级补列（宪法 §1.1/§3 登记 2026-09-10）：
    //     日期/期限列 0/NULL = 未登记合法态，服务端不得拿缺失日期猜周期；AI 只出提案，人工确认后写
    const customerDeliveryCols: Array<[string, string]> = [
      ['model', "TEXT DEFAULT ''"], ['purchase_date', 'INTEGER DEFAULT 0'],
      ['modified_date', 'INTEGER DEFAULT 0'], ['battery_type', "TEXT DEFAULT ''"],
      ['last_maintenance_date', 'INTEGER DEFAULT 0'], ['warranty_start_date', 'INTEGER DEFAULT 0'],
      ['warranty_days', 'INTEGER DEFAULT 0'], ['repeat_level', "TEXT DEFAULT ''"]
    ]
    for (const [col, type] of customerDeliveryCols) {
      try { this.db.run(`ALTER TABLE customer ADD COLUMN ${col} ${type}`) } catch { /* 列已存在 */ }
    }
    // ②' quotation 版本模型补列 + contract.quote_version_id（宪法 §1.6）。
    // 权威方向 = contract.quote_version_id → quotation 版本行；既有反向链 quotation.contract_id 过渡期
    // 双写只读兼容。双写起止（D3 拍板）：Phase 1 版本链写入路径上线起，同一事务双写两侧；
    // Phase 2 读路径全部切换到新方向后，quotation.contract_id 退役（只读留档）。
    const quotePhase0Cols: Array<[string, string]> = [
      ['version', 'INTEGER DEFAULT 1'], ['effective_from', 'INTEGER DEFAULT 0'],
      ['effective_to', 'INTEGER DEFAULT 0'], ['pdf_hash', "TEXT DEFAULT ''"],
      // 宪法 §1.6 修订（2026-09-09）：DOCX 产物 SHA-256 存证列；pdf_hash 仅真实 PDF 才写（见 crmDocGenService）
      ['artifact_hash', "TEXT DEFAULT ''"]
    ]
    for (const [col, type] of quotePhase0Cols) {
      try { this.db.run(`ALTER TABLE quotation ADD COLUMN ${col} ${type}`) } catch { /* 列已存在 */ }
    }
    try { this.db.run('ALTER TABLE contract ADD COLUMN quote_version_id INTEGER') } catch { /* 列已存在 */ }
    // 决策 B（宪法 §4.2，2026-09-02）：群资源扫描整功能下线，清理遗留游标（幂等；服务已删，键不再产生）
    try { this.db.run("DELETE FROM scan_state WHERE key LIKE 'leadScan:%'") } catch { /* ignore */ }
    // 存量清理（2026-09-05）：旧版解析规则曾把手机号/单号误判为金额写进 opportunity/quote_signal
    // （PHONE_NUM_RE + AMOUNT_MAX 护栏 9/2 才随 86b3ece 上线，此前存量需清；Windows 覆盖安装保留旧库故仍会看到）。
    // 口径：amount ≥ 1 亿（叉车整机/改装单价远不及此，必为误识别）→ 归零=待人工确认，幂等（二次启动命中 0 行）。
    try {
      const AMOUNT_ABSURD = 100000000
      const oppDirty = this.all('SELECT id, amount FROM opportunity WHERE amount >= ?', [AMOUNT_ABSURD])
      for (const row of oppDirty) {
        this.db.run('UPDATE opportunity SET amount = 0, updated_at = ? WHERE id = ?', [Date.now(), Number(row.id)])
        this.opportunityEventAdd(Number(row.id), 'amount_reset', '', `旧版误识别金额 ¥${row.amount} 已清零，待人工确认`)
      }
      const qsDirty = this.all('SELECT id, amount FROM quote_signal WHERE amount >= ?', [AMOUNT_ABSURD])
      for (const row of qsDirty) {
        this.db.run('UPDATE quote_signal SET amount = 0 WHERE id = ?', [Number(row.id)])
      }
      if (oppDirty.length || qsDirty.length) {
        this.db.run(
          'INSERT INTO audit_event (actor, action, entity_type, entity_id, detail, created_at) VALUES (?,?,?,?,?,?)',
          ['system:migration', 'absurd_amount_sweep', 'opportunity', null,
            JSON.stringify({ opportunity: oppDirty.length, quote_signal: qsDirty.length, threshold: AMOUNT_ABSURD }), Date.now()]
        )
        console.log(`[CRM] 存量脏金额清理：opportunity ${oppDirty.length} 行 / quote_signal ${qsDirty.length} 行（≥1亿 判为误识别）`)
      }
    } catch { /* 表结构差异忽略 */ }
    // Migration: lead 旧结构表（空壳 name/company/phone 或中间态 contact_phone/contact_wechat）→ 线索流转结构
    // 旧表缺 contact_type 或 contact_normalized 任一 → 迁移旧数据（如有）后重建为新 SCHEMA。
    // 注意：lead 索引独立于 SCHEMA_SQL（LEAD_INDEXES_SQL），避免旧表上建索引先崩。
    try {
      const leadCols = this.all('PRAGMA table_info(lead)').map((c) => String(c.name))
      const hasNewSchema = leadCols.includes('contact_normalized') && leadCols.includes('contact_type')
      if (leadCols.length && !hasNewSchema) {
        const oldRows = this.all('SELECT * FROM lead')
        this.db.run('DROP TABLE lead')
        this.db.run(SCHEMA_SQL)
        const now = Date.now()
        for (const r of oldRows) {
          const ph = String(r.contact_phone ?? r.phone ?? '').trim()
          const wx = String(r.contact_wechat ?? r.wechat ?? '').trim()
          if (!ph && !wx) continue
          const contactType = ph ? (wx ? 'both' : 'phone') : 'wechat'
          const normalized = ph || wx
          this.db.run(
            'INSERT INTO lead (contact_type, contact_normalized, contact_raw, wechat, source, name, status, first_contact_deadline, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
            [contactType, normalized, normalized, wx, String(r.source || '自定义').trim() || '自定义', String(r.name || '').trim(), 'NEW', now, now, now]
          )
        }
      }
    } catch (e) { console.error('[CrmDb] lead 迁移失败:', e) }
    this.db.run(LEAD_INDEXES_SQL)
    // Migration: lead.import_batch_id（§2.75 遗留入池方式精确化，宪法 §3 登记 2026-09-06）：
    //     导入批次回溯（→ import_batch.id 逻辑外键）；写者 = importLeads 单点；存量 = NULL。
    //     独立 ALTER 幂等吞错——lead 旧结构 DROP 重建块上方已跑过，此处保证重建后列必在（双路径模式）。
    try { this.db.run('ALTER TABLE lead ADD COLUMN import_batch_id INTEGER') } catch { /* 列已存在 */ }
    // §2.52 启动守卫补写审计：库从自动备份恢复时留一条 db_recover（此时 SCHEMA 已就位可写）
    if (openRes.outcome === 'restored') {
      try {
        this.db.run(
          'INSERT INTO audit_event (actor, action, entity_type, entity_id, detail, created_at) VALUES (?,?,?,?,?,?)',
          ['system:persist-guard', 'db_recover', 'db', null,
            JSON.stringify({ kind: 'crm', corruptPath: openRes.corruptPath ?? '', restoredFrom: openRes.restoredFrom ?? '' }), Date.now()]
        )
      } catch (e) { console.error('[CrmDb] db_recover 审计写入失败:', e) }
    }
    this.persist()
  }

  /** 事务执行一组写操作（sql.js 单库事务）：成功 COMMIT+persist，失败 ROLLBACK 后抛错。tx.run 返回 last_insert_rowid。 */
  runTx<T>(fn: (tx: { run: (sql: string, params?: unknown[]) => number; all: (sql: string, params?: unknown[]) => CrmRow[] }) => T): T {
    if (!this.db) throw new Error('CrmDb 未初始化')
    this.db.run('BEGIN')
    try {
      const tx = {
        run: (sql: string, params: unknown[] = []) => {
          this.db!.run(sql, params as any[])
          const stmt = this.db!.prepare('SELECT last_insert_rowid() AS id')
          try {
            stmt.step()
            return Number(stmt.getAsObject().id || 0)
          } finally { stmt.free() }
        },
        all: (sql: string, params: unknown[] = []) => {
          const stmt = this.db!.prepare(sql)
          try {
            stmt.bind(params as any[])
            const rows: CrmRow[] = []
            while (stmt.step()) rows.push(stmt.getAsObject() as CrmRow)
            return rows
          } finally { stmt.free() }
        }
      }
      const out = fn(tx)
      this.db.run('COMMIT')
      this.persist()
      return out
    } catch (e) {
      try { this.db.run('ROLLBACK') } catch { /* ignore */ }
      throw e
    }
  }

  private persist(): void {
    if (!this.db || !this.dbPath) return
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      try { atomicWriteFileSync(this.dbPath!, Buffer.from(this.db!.export())) } catch (e) { console.error('[CrmDb] persist error:', e) }
    }, 500)
  }

  persistNow(): void {
    if (!this.db || !this.dbPath) return
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null }
    try { atomicWriteFileSync(this.dbPath, Buffer.from(this.db.export())) } catch (e) { console.error('[CrmDb] persistNow error:', e) }
  }

  /**
   * 备份前强制刷盘（严格版）：失败抛出，调用方（autoBackupService）必须终止本轮备份，
   * 不允许吞错继续备份——否则会把 500ms 防抖窗口前的旧文件当成功备份写入 manifest。
   */
  persistNowStrict(): void {
    if (!this.db || !this.dbPath) return
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null }
    atomicWriteFileSync(this.dbPath, Buffer.from(this.db.export()))
  }

  /** 当前业务库文件绝对路径（未初始化为 null；归档 IPC / 备份用） */
  currentDbPath(): string | null { return this.dbPath }

  /**
   * §2.40 微信号分库切换：落盘 → 卸载当前库 → 以新 wxid 重新 initialize。
   * 调用方必须经 enqueueSalesTask 串行，避免扫描中途换库。
   */
  async reopenForWxid(userDataPath: string, wxid?: string): Promise<void> {
    this.persistNow()
    this.detach()
    await this.initialize(userDataPath, wxid)
  }

  /**
   * §2.40 归档逃生舱：落盘 → 卸载 → 当前库整文件改名 .archived-<时间戳>.db。
   * 返回归档文件路径；未初始化或文件不存在返回 null（不抛错）。调用方随后 reopenForWxid 重开新空库。
   */
  archiveCurrentDb(at: Date = new Date()): string | null {
    const from = this.dbPath
    if (!from) return null
    this.persistNow()
    this.detach()
    if (!existsSync(from)) return null
    const to = join(dirname(from), archivedDbName(basename(from), at))
    try {
      renameSync(from, to)
      return to
    } catch (e) {
      console.error('[CrmDb] 归档失败:', e)
      return null
    }
  }

  /** 卸载当前库（不落盘——调用方负责先 persistNow；同时清 initPromise 允许重新加载） */
  private detach(): void {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null }
    this.db = null
    this.entryGeneration++
    this.dbPath = null
    this.initPromise = null
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

  contractEntryScope(): { accountKey: string; generation: number } {
    if (!this.db || !this.dbPath) throw new Error('业务库未就绪')
    return { accountKey: createHash('sha256').update(this.dbPath).digest('hex'), generation: this.entryGeneration }
  }

  assertContractEntryScope(scope: { accountKey: string; generation: number }): void {
    const current = this.contractEntryScope()
    if (!scope || scope.accountKey !== current.accountKey || scope.generation !== current.generation) throw new Error('账号已切换，请重新打开合同')
  }

  contractByCreationRequest(requestId: string): CrmRow | null {
    if (!/^[a-zA-Z0-9-]{16,80}$/.test(requestId)) throw new Error('创建标识无效')
    const candidates = this.all("SELECT * FROM contract WHERE custom_fields LIKE ? ORDER BY id", [`%${requestId}%`])
    return candidates.find(row => { try { return JSON.parse(String(row.custom_fields || '{}')).creation_request_id === requestId } catch { return false } }) || null
  }

  /** 客户与合同在同一同步事务内创建；报价/文件仍各自独立，失败按标识恢复。 */
  beginContractEntry(input: { requestId: string; accountId?: number; name: string; amount: number; header: Record<string, string>; updateHeaderKeys?: string[] }): CrmRow {
    const existing = this.contractByCreationRequest(input.requestId)
    if (existing) return existing
    if (!input.name?.trim() || !Number.isFinite(input.amount) || input.amount < 0) throw new Error('客户名称或合同金额无效')
    const headerKeys = ['buyer_addr', 'buyer_bank', 'buyer_account', 'tax_no', 'buyer_phone']
    const header = Object.fromEntries(headerKeys.map(key => [key, String(input.header?.[key] || '').trim()]))
    const contractId = this.runTx(tx => {
      const now = Date.now()
      let accountId = Number(input.accountId || 0)
      let name = input.name.trim()
      if (accountId) {
        const account = tx.all('SELECT * FROM account WHERE id = ?', [accountId])[0]
        if (!account) throw new Error('客户不存在')
        name = String(account.name)
        let fields: Record<string, unknown> = {}
        try { fields = JSON.parse(String(account.custom_fields || '{}')) } catch { /* retain empty */ }
        const empty = headerKeys.every(key => !String(fields[key] || '').trim())
        const selected = empty ? headerKeys : (input.updateHeaderKeys || []).filter(key => headerKeys.includes(key))
        if (selected.length) {
          for (const key of selected) fields[key] = header[key]
          tx.run('UPDATE account SET custom_fields = ?, updated_at = ? WHERE id = ?', [JSON.stringify(fields), now, accountId])
        }
      } else {
        accountId = tx.run('INSERT INTO account (name, custom_fields, created_at, updated_at) VALUES (?,?,?,?)', [name, JSON.stringify(header), now, now])
      }
      const id = tx.run('INSERT INTO contract (account_id, name, amount, status, custom_fields, created_at, updated_at) VALUES (?,?,?,?,?,?,?)', [accountId, `${name}-合同`, input.amount, 'pending_sign', JSON.stringify({ ...header, creation_request_id: input.requestId }), now, now])
      tx.run('INSERT INTO audit_event (actor, action, entity_type, entity_id, detail, created_at) VALUES (?,?,?,?,?,?)', [currentActor(), 'contract_entry_create', 'contract', id, JSON.stringify({ account_id: accountId, creation_request_id: input.requestId }), now])
      return id
    })
    this.persistNowStrict()
    return this.getById('contract', contractId)!
  }

  create(entity: string, data: CrmRow): number {
    if (!this.isEntity(entity)) return 0
    // 宪法 §1.6（2026-09-09 修订）：报价 = append-only 版本链，写入单点是 createQuotation；
    // 散写 quotation 行会绕过 version/effective 语义污染版本链，响亮失败。
    if (entity === 'quotation') throw new Error('报价单禁止散写：请走 createQuotation 版本链（宪法 §1.6 append-only）')
    const keys = Object.keys(data)
    const sql = `INSERT INTO ${entity} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`
    return this.run(sql, keys.map((k) => data[k]))
  }

  /** 报价版本现行态允许回写的字段（文件/存证哈希/备注/有效期）；价格与行项变更必须新建版本 */
  private static readonly QUOTATION_MUTABLE_FIELDS: ReadonlySet<string> = new Set([
    'attachment_path', 'artifact_hash', 'pdf_hash', 'custom_fields', 'valid_until'
  ])

  update(entity: string, id: number, patch: CrmRow): void {
    if (!this.isEntity(entity)) return
    if (entity === 'contract' && patch.custom_fields != null) {
      const existing = this.getById(entity, id)
      const oldFields = JSON.parse(String(existing?.custom_fields || '{}'))
      const newFields = JSON.parse(String(patch.custom_fields))
      patch = { ...patch, custom_fields: JSON.stringify({ ...oldFields, ...newFields, ...(oldFields.creation_request_id ? { creation_request_id: oldFields.creation_request_id } : {}) }) }
    }
    const keys = Object.keys(patch)
    if (!keys.length) return
    if (entity === 'quotation') {
      // 宪法 §1.6（2026-09-09 修订）：历史版本（effective_to>0，已被新版本替代）只读，一律拒绝；
      // 现行版本仅允许文件/哈希/备注类回写，价格与行项改动必须走 createQuotation 新版本。
      const row = this.getById('quotation', id)
      if (!row) return
      const contract = Number(row.contract_id || 0) > 0
        ? this.getById('contract', Number(row.contract_id))
        : null
      if (Number(row.effective_to || 0) > 0 || Number(contract?.quote_version_id || 0) !== id) {
        throw new Error(`报价版本 #${id} 已被新版本替代（历史版本只读，宪法 §1.6 append-only）`)
      }
      const illegal = keys.filter((k) => !CrmDbService.QUOTATION_MUTABLE_FIELDS.has(k))
      if (illegal.length) {
        throw new Error(`报价单字段不可直改（${illegal.join(',')}）：价格/行项变更请新建报价版本（宪法 §1.6）`)
      }
      this.run(`UPDATE quotation SET ${keys.map((k) => `${k} = ?`).join(',')} WHERE id = ?`, [...keys.map((k) => patch[k]), id])
      return
    }
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
  /**
   * 按名称匹配客户（session 精确未命中时的兜底）。
   * @param opts.excludeSessionId 传入当前会话 id 时，跳过已绑定【其他】会话的同名客户，
   *   避免跨会话误关联（多个「张总」「李经理」串客户）。
   */
  matchAccountByName(name: string, opts?: { excludeSessionId?: string }): CrmRow | null {
    if (!name) return null
    const sid = opts?.excludeSessionId
    const sids = sid ? ' AND (session_id IS NULL OR session_id = ?)' : ''
    const args: unknown[] = sid ? [sid] : []
    const exact = this.all(`SELECT * FROM account WHERE name = ?${sids}`, [name, ...args])
    if (exact.length) return exact[0]
    const prefixed = this.all(`SELECT * FROM account WHERE name LIKE ?${sids}`, [name + '%', ...args])
    if (prefixed.length) return prefixed[0]
    return null
  }
  /**
   * 客户候选集（供自动确认引擎判断"唯一 vs 多候选"）。
   * 命中强度降序：精确 name= → 前缀 name% → 别名 alias_map → 收货人 shipping_info.receiver → 双向包含 %name%。
   * 精确命中时只返回精确候选（模糊命中不叠加）；其余按序去重收集。
   * 每行附 match_tier / match_strength 供引擎计算置信度。
   */
  matchAccountCandidates(name: string): CrmRow[] {
    if (!name) return []
    const exact = this.all('SELECT * FROM account WHERE name = ?', [name])
    if (exact.length) return [{ ...exact[0], match_tier: 'exact', match_strength: 0.95 }]
    const out: CrmRow[] = []
    const seen = new Set<number>()
    const push = (row: CrmRow, tier: string, strength: number): void => {
      if (!row || seen.has(Number(row.id))) return
      seen.add(Number(row.id))
      out.push({ ...row, match_tier: tier, match_strength: strength })
    }
    for (const r of this.all('SELECT * FROM account WHERE name LIKE ?', [name + '%'])) push(r, 'prefix', 0.9)
    for (const r of this.all('SELECT a.* FROM alias_map m JOIN account a ON a.id = m.account_id WHERE m.alias = ?', [name])) push(r, 'alias', 0.88)
    for (const r of this.all('SELECT a.* FROM shipping_info s JOIN account a ON a.id = s.account_id WHERE s.receiver = ?', [name])) push(r, 'receiver', 0.85)
    for (const r of this.all('SELECT * FROM account WHERE name LIKE ?', ['%' + name + '%'])) push(r, 'contains', 0.8)
    return out
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
    // 名称兜底为幂等合并语义（同人多微信号合并到同一 account），不跨会话排除——跨会话防护仅用于 AI enrich
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
  // ─── 客户信息自动填充（enrich）────────────────────────────────────────────
  /** 读取并解析 account.enrich_meta */
  accountEnrichMeta(accountId: number): EnrichMeta {
    const acc = this.getById('account', accountId)
    return parseEnrichMeta(acc ? String(acc.enrich_meta || '') : '')
  }

  /**
   * 写入 AI 填充结果：updates → 正式列/custom_fields + meta；pending 整体替换为新合并结果。
   * 写 activity_log（客户可见时间线）+ auto_confirm_log（enrich_auto 审计，供历史/回溯）。
   */
  applyEnrichment(
    accountId: number,
    updates: Record<string, { value: string; meta: EnrichFieldMetaEntry }>,
    pending: Record<string, PendingFieldEntry>,
    opts: { discarded?: string[] } = {}
  ): { ok: boolean; reason?: string } {
    const acc = this.getById('account', accountId)
    if (!acc) return { ok: false, reason: '客户不存在' }
    const patch: CrmRow = { updated_at: Date.now() }
    let customFields: Record<string, unknown> = {}
    customFields = parseJsonObject(acc.custom_fields)
    const meta = parseEnrichMeta(String(acc.enrich_meta || ''))
    const fields = { ...(meta.fields || {}) }
    const labels: string[] = []
    for (const [field, u] of Object.entries(updates)) {
      if (ENRICH_FORMAL_COLUMNS.has(field)) patch[field] = u.value
      else customFields[field] = u.value
      fields[field] = u.meta
      labels.push(field)
    }
    patch.custom_fields = JSON.stringify(customFields)
    patch.enrich_meta = JSON.stringify({ fields, pending })
    this.update('account', accountId, patch)
    if (labels.length) {
      this.logActivity('account', accountId, 'enriched', `AI 自动填充 ${labels.length} 项：${labels.join('、')}`)
      const avgConf = labels.reduce((s, f) => s + (updates[f]?.meta?.confidence ?? 0), 0) / labels.length
      this.logAutoConfirm('account', accountId, 'enrich_auto', Math.round(avgConf * 100) / 100, `AI 填充 ${labels.join('、')}${opts.discarded?.length ? `（丢弃 ${opts.discarded.length} 项低置信）` : ''}`, 'enrichCustomer')
    } else if (Object.keys(pending).length) {
      this.update('account', accountId, { enrich_meta: JSON.stringify({ fields, pending }) })
    }
    return { ok: true }
  }

  /** 确认中心「信息待确认」队列：从 account.enrich_meta.pending 派生（不建表） */
  infoPendingQueue(): CrmRow[] {
    const rows = this.all("SELECT id, name, session_id, enrich_meta FROM account WHERE enrich_meta LIKE '%\"pending\"%'")
    const out: CrmRow[] = []
    for (const r of rows) {
      const meta = parseEnrichMeta(String(r.enrich_meta || ''))
      const pending = meta.pending || {}
      for (const [field, p] of Object.entries(pending)) {
        out.push({
          account_id: Number(r.id), account_name: String(r.name || ''), session_id: String(r.session_id || ''),
          field, value: p.value, confidence: p.confidence, evidence: p.evidence || '', at: p.at ?? 0
        })
      }
    }
    return out.sort((a, b) => Number(a.at) - Number(b.at))
  }

  /** 人工裁决待确认字段：accept 写入（source=ai，可被后续 AI 更新）；reject 仅清除 pending */
  applyInfoField(accountId: number, field: string, action: 'accept' | 'reject'): { ok: boolean; reason?: string } {
    const acc = this.getById('account', accountId)
    if (!acc) return { ok: false, reason: '客户不存在' }
    const meta = parseEnrichMeta(String(acc.enrich_meta || ''))
    const pending = { ...(meta.pending || {}) }
    const p = pending[field]
    if (!p) return { ok: false, reason: '该条目已处理' }
    delete pending[field]
    if (action === 'accept') {
      const patch: CrmRow = { updated_at: Date.now() }
      let customFields: Record<string, unknown> = {}
      customFields = parseJsonObject(acc.custom_fields)
      if (ENRICH_FORMAL_COLUMNS.has(field)) patch[field] = p.value
      else customFields[field] = p.value
      patch.custom_fields = JSON.stringify(customFields)
      const fields = { ...(meta.fields || {}) }
      fields[field] = { source: 'ai', confidence: p.confidence, at: Date.now(), evidence: p.evidence }
      patch.enrich_meta = JSON.stringify({ fields, pending })
      this.update('account', accountId, patch)
      this.logActivity('account', accountId, 'info_accepted', `人工采纳 AI 填充「${field}」= ${p.value}`)
      this.logAutoConfirm('account', accountId, 'info_accept', p.confidence, `采纳 ${field}=${p.value}`, 'applyInfoField')
      // 刀 2 埋点写点①（设计-Hermes-MVP）：信息待确认人工采纳 → proposal/accepted
      trackProposalEvent({ event_type: 'proposal', stage: 'accepted', entity_type: 'account_info', entity_id: `${accountId}:${field}`, actor: currentActor() })
      // 生命周期钩子（PRD 2.4 反问卡自动关闭等派生消费；尽力而为，失败不影响主语义）
      emitInfoFieldConfirmed(accountId, field)
      return { ok: true }
    }
    this.update('account', accountId, { enrich_meta: JSON.stringify({ fields: meta.fields || {}, pending }), updated_at: Date.now() })
    this.logActivity('account', accountId, 'info_rejected', `人工放弃 AI 填充「${field}」`)
    this.logAutoConfirm('account', accountId, 'info_reject', p.confidence, `放弃 ${field}=${p.value}`, 'applyInfoField')
    // 刀 2 埋点写点①：信息待确认人工放弃 → proposal/rejected
    trackProposalEvent({ event_type: 'proposal', stage: 'rejected', entity_type: 'account_info', entity_id: `${accountId}:${field}`, actor: currentActor() })
    return { ok: true }
  }

  /** 手动编辑 enrich 字段：写值并标 source=manual + locked（AI 永不再覆盖），同时清该字段 pending */
  setAccountFieldManual(accountId: number, field: string, value: string): { ok: boolean; reason?: string } {
    const acc = this.getById('account', accountId)
    if (!acc) return { ok: false, reason: '客户不存在' }
    if (!(ENRICH_FIELDS as readonly string[]).includes(field)) return { ok: false, reason: '未知字段' }
    const patchRow: CrmRow = { updated_at: Date.now() }
    let customFields: Record<string, unknown> = {}
    customFields = parseJsonObject(acc.custom_fields)
    const v = String(value ?? '').trim()
    if (ENRICH_FORMAL_COLUMNS.has(field)) patchRow[field] = v || null
    else { if (v) customFields[field] = v; else delete customFields[field] }
    patchRow.custom_fields = JSON.stringify(customFields)
    const meta = parseEnrichMeta(String(acc.enrich_meta || ''))
    const fields = { ...(meta.fields || {}) }
    fields[field] = { source: 'manual', confidence: 1, at: Date.now(), locked: true }
    const pending = { ...(meta.pending || {}) }
    delete pending[field]
    patchRow.enrich_meta = JSON.stringify({ fields, pending })
    this.update('account', accountId, patchRow)
    this.logActivity('account', accountId, 'field_edited', `手动编辑「${field}」${v ? `= ${v.slice(0, 60)}` : '（清空）'}`)
    // 生命周期钩子（PRD 2.4 反问卡自动关闭等派生消费；尽力而为）
    emitInfoFieldConfirmed(accountId, field)
    return { ok: true }
  }

  // ─── 报价信号（R7 报价跟进的事实来源）─────────────────────────────────────
  /** 记录报价信号（msg_key 幂等）。返回是否新记录 */
  recordQuoteSignal(p: { msgKey: string; sessionId: string; accountId: number; displayName: string; amount: number | null; model: string | null; quotedAt: number }): boolean {
    if (!p.msgKey || !p.sessionId) return false
    if (this.all('SELECT 1 AS x FROM quote_signal WHERE msg_key = ?', [p.msgKey]).length) return false
    this.run(
      'INSERT INTO quote_signal (msg_key, session_id, account_id, display_name, amount, model, quoted_at, customer_replied_at, created_at) VALUES (?,?,?,?,?,?,?,0,?)',
      [p.msgKey, p.sessionId, p.accountId || null, p.displayName || '', p.amount ?? null, p.model ?? null, p.quotedAt, Date.now()]
    )
    return true
  }
  /** 客户回复 → 关闭该会话所有更早的未回复报价信号。返回关闭条数 */
  markQuoteReplied(sessionId: string, replyMs: number): number {
    if (!sessionId) return 0
    const rows = this.all('SELECT id FROM quote_signal WHERE session_id = ? AND customer_replied_at = 0 AND quoted_at <= ?', [sessionId, replyMs])
    for (const r of rows) this.update('quote_signal', Number(r.id), { customer_replied_at: replyMs })
    return rows.length
  }
  /** 待跟进报价信号：发出在 [maxDays 前, minHours 前] 区间且客户至今未回复 */
  pendingQuoteFollowups(minHours: number, maxDays: number): CrmRow[] {
    const now = Date.now()
    return this.all(
      'SELECT * FROM quote_signal WHERE customer_replied_at = 0 AND quoted_at <= ? AND quoted_at >= ? ORDER BY quoted_at',
      [now - minHours * 3600000, now - maxDays * 86400000]
    )
  }

  // ─── 商机模块（AI 从聊天自动识别采购信号 → 商机，P0）────────────────────────
  /** 商机列表（JOIN 客户名），按最近信号倒序。opts.status 默认 active */
  opportunityList(opts?: { accountId?: number; status?: string }): CrmRow[] {
    const where: string[] = []
    const params: unknown[] = []
    if (opts?.accountId) { where.push('o.account_id = ?'); params.push(opts.accountId) }
    if (opts?.status) { where.push('o.status = ?'); params.push(opts.status) }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : ''
    return this.all(
      `SELECT o.*, a.name AS account_name, a.session_id AS session_id
       FROM opportunity o LEFT JOIN account a ON a.id = o.account_id ${w}
       ORDER BY o.last_signal_at DESC, o.id DESC`, params
    )
  }
  /** 单商机详情 */
  opportunityById(id: number): CrmRow | undefined {
    if (!id) return undefined
    return this.all(
      'SELECT o.*, a.name AS account_name, a.session_id AS session_id FROM opportunity o LEFT JOIN account a ON a.id = o.account_id WHERE o.id = ?',
      [id]
    )[0]
  }
  /** 商机事件时间线（倒序） */
  opportunityEvents(oppId: number): CrmRow[] {
    return this.all('SELECT * FROM opportunity_event WHERE opportunity_id = ? ORDER BY id DESC', [oppId])
  }
  /** 追加商机事件（信号累积/阶段变更都留痕：事件驱动，不覆盖式写状态） */
  opportunityEventAdd(oppId: number, eventType: string, stage = '', detail = ''): void {
    if (!oppId) return
    this.run('INSERT INTO opportunity_event (opportunity_id, event_type, stage, detail, created_at) VALUES (?,?,?,?,?)',
      [oppId, eventType, stage, detail.slice(0, 200), Date.now()])
  }
  /** 商机漏斗统计：active 商机按阶段分布 + 总金额 */
  opportunityStats(): { stageDist: Array<{ stage: string; count: number; amount: number }>; total: number; totalAmount: number } {
    const rows = this.all<{ stage: string; cnt: number; amt: number }>(
      "SELECT COALESCE(stage,'unknown') AS stage, COUNT(*) AS cnt, COALESCE(SUM(amount),0) AS amt FROM opportunity WHERE status = 'active' GROUP BY stage ORDER BY cnt DESC", [])
    const total = Number(this.all("SELECT COUNT(*) AS c FROM opportunity WHERE status = 'active'", [])[0]?.c ?? 0)
    const totalAmount = Number(this.all("SELECT COALESCE(SUM(amount),0) AS s FROM opportunity WHERE status = 'active'", [])[0]?.s ?? 0)
    return {
      stageDist: rows.map((r) => ({ stage: String(r.stage || 'unknown'), count: Number(r.cnt) || 0, amount: Number(r.amt) || 0 })),
      total: Number(total), totalAmount: Number(totalAmount)
    }
  }
  /** 客户当前活跃商机（供阶段联动/列表徽章） */
  activeOpportunitiesByAccount(accountId: number): CrmRow[] {
    if (!accountId) return []
    return this.all("SELECT * FROM opportunity WHERE account_id = ? AND status = 'active' ORDER BY last_signal_at DESC", [accountId])
  }
  /** 采购信号落库：同客户同产品已有 active 商机 → 累积更新；product 未知时累积到最近的无产品
   *  active 商机（否则每条信号都新建出重复商机）；否则新建。
   *  amount=0 表示待确认；stage 复用客户阶段（了解/比价/决策）。 */
  opportunityUpsertBySignal(accountId: number, customerName: string, signal: { product: string; quantity: number; amount: number; stage: string; detail: string }): { id: number; created: boolean } {
    const product = String(signal.product || '').trim()
    const now = Date.now()
    const opp = product
      ? this.all("SELECT * FROM opportunity WHERE account_id = ? AND status = 'active' AND product = ? ORDER BY last_signal_at DESC LIMIT 1", [accountId, product])[0]
      : this.all("SELECT * FROM opportunity WHERE account_id = ? AND status = 'active' AND (product = '' OR product IS NULL) ORDER BY last_signal_at DESC LIMIT 1", [accountId])[0]
    if (opp) {
      const patch: CrmRow = { last_signal_at: now, updated_at: now }
      if (signal.quantity > 0 && (Number(opp.quantity) === 0 || signal.quantity > Number(opp.quantity))) patch.quantity = signal.quantity
      if (signal.amount > 0 && (Number(opp.amount) === 0 || signal.amount > Number(opp.amount))) patch.amount = signal.amount
      this.update('opportunity', Number(opp.id), patch)
      this.opportunityEventAdd(Number(opp.id), 'signal', String(opp.stage || ''), `${customerName}：${signal.detail}`)
      return { id: Number(opp.id), created: false }
    }
    const name = product ? `${product}采购` : '新商机'
    const id = this.create('opportunity', {
      account_id: accountId, name, product,
      quantity: signal.quantity || 0, amount: signal.amount || 0,
      stage: signal.stage || '了解', status: 'active',
      last_signal_at: now, created_at: now, updated_at: now,
      intent_score: 0, custom_fields: '{}'
    })
    if (id) this.opportunityEventAdd(id, 'created', signal.stage || '了解', `AI 识别采购信号：${signal.detail}`)
    return { id: Number(id), created: true }
  }
  /** 商机阶段更新（AI 判定/人工），留痕事件 */
  opportunityUpdateStage(oppId: number, stage: string, source = 'ai'): boolean {
    const opp = this.all('SELECT * FROM opportunity WHERE id = ?', [oppId])[0]
    if (!opp) return false
    const fromStage = String(opp.stage || '')
    if (fromStage === stage) return false
    this.update('opportunity', oppId, { stage, updated_at: Date.now() })
    this.opportunityEventAdd(oppId, 'stage_change', stage, `${source}：${fromStage} → ${stage}`)
    return true
  }
  /** 关闭商机（仅丢单）。成交一律走 registerOpportunityDeal；此处只接受 lost，原因必填，不写成交字段。 */
  opportunityClose(oppId: number, status: 'lost', reason: string): boolean {
    if (status !== 'lost') return false // 成交只走 registerOpportunityDeal；won 一律拒绝
    const reasonText = String(reason || '').trim()
    if (!reasonText) return false // 丢单原因必填
    const opp = this.all('SELECT * FROM opportunity WHERE id = ?', [oppId])[0]
    if (!opp) return false
    if (String(opp.status || '') !== 'active') return false // 已关闭（won/lost）商机禁止再次丢单/覆盖成交
    this.update('opportunity', oppId, { status: 'lost', updated_at: Date.now() })
    this.opportunityEventAdd(oppId, 'lost', String(opp.stage || ''), reasonText)
    return true
  }

  // ─── 正式成交登记（宪法 §1.5 修订 2026-09-09：字段/won/事件/审计同一事务）───
  /**
   * 人工正式成交登记（单点）：成交字段 + opportunity.status='won' + opportunity_event + audit_event
   * 同一事务（runTx），任一步失败整体回滚。
   * 硬校验（事务内执行，失败即抛错回滚）：
   *   ① amount_cny > 0；② order_qty 正整数；③ expected_ship_end 不早于 expected_ship_start；
   *   ④ 非 CNY 必填 original_amount + rate_note；⑤ main_model 必填且必须命中 product（model/name）；
   *   ⑥ type 只能是「整车」或「改装」（空值/任意字符串一律拒绝）；
   *   ⑦ quote_version_id（如绑定）必须属于该商机客户的合同，且为现行有效版本（effective_to=0，历史只读）。
   * 丢单（lost）不走本方法：opportunityClose('lost') 只写丢单状态和原因，不写成交字段。
   */
  registerOpportunityDeal(oppId: number, deal: OpportunityDealPayload): { ok: boolean; reason?: string } {
    const id = Number(oppId || 0)
    try {
      this.runTx((tx) => {
        const opp = id ? tx.all('SELECT * FROM opportunity WHERE id = ?', [id])[0] : null
        if (!opp) throw new Error('商机不存在')
        if (String(opp.status) !== 'active') throw new Error(`商机已关闭（${opp.status}），不可重复登记`)
        const now = Date.now()
        const amountCny = Number(deal.amount_cny)
        if (!Number.isFinite(amountCny) || amountCny <= 0) throw new Error('成交金额（CNY）必须大于 0')
        const orderQty = Number(deal.order_qty)
        if (!Number.isInteger(orderQty) || orderQty <= 0) throw new Error('订单量必须是正整数')
        const shipStart = Number(deal.expected_ship_start || 0)
        const shipEnd = Number(deal.expected_ship_end || 0)
        if (shipStart > 0 && shipEnd > 0 && shipEnd < shipStart) throw new Error('预计发货结束不得早于预计发货开始')
        const currency = (String(deal.original_currency || '').trim().toUpperCase() || 'CNY')
        const originalAmount = Number(deal.original_amount || 0)
        const rateNote = String(deal.rate_note || '').trim()
        if (currency !== 'CNY' && (originalAmount <= 0 || !rateNote)) {
          throw new Error(`非 CNY 成交必须填写原币金额与汇率说明（${currency}）`)
        }
        const mainModel = String(deal.main_model || '').trim()
        if (!mainModel) throw new Error('主型号必填（必须来自产品库）')
        if (!tx.all('SELECT id FROM product WHERE model = ? OR name = ? LIMIT 1', [mainModel, mainModel]).length) {
          throw new Error(`主型号必须来自产品库：${mainModel}`)
        }
        const dealType = String(deal.type || '').trim()
        if (dealType !== '整车' && dealType !== '改装') throw new Error('成交类型必须为「整车」或「改装」')
        const quoteVersionId = Number(deal.quote_version_id || 0)
        if (quoteVersionId > 0) {
          const q = tx.all(
            `SELECT q.id, q.contract_id, q.effective_to, c.account_id, c.quote_version_id
             FROM quotation q JOIN contract c ON c.id = q.contract_id WHERE q.id = ?`,
            [quoteVersionId]
          )[0]
          if (!q) throw new Error(`报价版本不存在：#${quoteVersionId}`)
          if (Number(q.effective_to || 0) > 0 || Number(q.quote_version_id || 0) !== quoteVersionId) {
            throw new Error(`报价版本 #${quoteVersionId} 已被新版本替代（历史版本只读），请绑定当前有效版本`)
          }
          if (Number(q.account_id || 0) !== Number(opp.account_id || 0)) {
            throw new Error(`报价版本 #${quoteVersionId} 不属于该商机客户的合同`)
          }
        }
        let customFields: Record<string, unknown> = {}
        customFields = parseJsonObject(opp.custom_fields)
        if (deal.model_extra != null) customFields.supplementary_models = String(deal.model_extra).trim()
        // ① 成交字段落库 + status='won'（amount 同步 = 漏斗/统计口径，与商机页登记一致）
        tx.run(
          `UPDATE opportunity SET amount_cny = ?, amount = ?, original_currency = ?, original_amount = ?, rate_note = ?,
           main_model = ?, order_qty = ?, expected_ship_start = ?, expected_ship_end = ?, delivery_date = ?, type = ?,
           quote_version_id = ?, custom_fields = ?, status = 'won', updated_at = ? WHERE id = ?`,
          [amountCny, amountCny, currency, currency !== 'CNY' ? originalAmount : 0, currency !== 'CNY' ? rateNote : '',
            mainModel, orderQty, shipStart, shipEnd, Number(deal.delivery_date || 0), dealType,
            quoteVersionId > 0 ? quoteVersionId : null, JSON.stringify(customFields), now, id]
        )
        // ② 商机事件留痕
        tx.run(
          'INSERT INTO opportunity_event (opportunity_id, event_type, stage, detail, created_at) VALUES (?,?,?,?,?)',
          [id, 'won', String(opp.stage || ''),
            `${String(deal.note || '').trim() || '人工登记成交'}（¥${amountCny} · ${mainModel} ×${orderQty}${quoteVersionId > 0 ? ` · 报价 #${quoteVersionId}` : ''}）`.slice(0, 200), now]
        )
        // ③ 审计（宪法 §1.12：append-only，与写操作同事务）
        tx.run(
          'INSERT INTO audit_event (actor, action, entity_type, entity_id, detail, created_at) VALUES (?,?,?,?,?,?)',
          [String(deal.actor || '').trim() || currentActor(), 'opportunity_deal_register', 'opportunity', id,
            JSON.stringify({
              amount_cny: amountCny, original_currency: currency,
              original_amount: currency !== 'CNY' ? originalAmount : 0,
              main_model: mainModel, order_qty: orderQty, type: dealType,
              quote_version_id: quoteVersionId > 0 ? quoteVersionId : null
            }), now]
        )
        return true
      })
      // 生命周期钩子（PRD 2.4 反问卡「数量/型号」缺口自动关闭等派生消费；事务外尽力而为）
      try {
        const acc = this.getById('opportunity', id)
        if (acc && Number(acc.account_id || 0) > 0) emitOpportunityDealRegistered(Number(acc.account_id), id)
      } catch { /* 钩子失败不影响主语义 */ }
      return { ok: true }
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) }
    }
  }
  /** 客户阶段 AI 判定后联动：客户 active 商机同步推进。
   *  了解→比价→决策 顺推；成交→生成待人工成交登记提醒（不直接置 won）；流失→商机 lost。 */
  syncOpportunityStageByAccount(accountId: number, customerStage: string): number {
    if (!accountId) return 0
    const opps = this.activeOpportunitiesByAccount(accountId)
    if (!opps.length) return 0
    const ORDER = ['了解', '比价', '决策'] as const
    let changed = 0
    for (const o of opps) {
      const cur = String(o.stage || '了解')
      if (customerStage === '成交') { if (this.dealPendingReminder(Number(o.id))) changed++; continue }
      if (customerStage === '流失') { if (this.opportunityClose(Number(o.id), 'lost', '客户阶段判定流失，自动关单')) changed++; continue }
      if (!ORDER.includes(customerStage as (typeof ORDER)[number])) continue
      const curIdx = ORDER.indexOf(cur as (typeof ORDER)[number])
      const newIdx = ORDER.indexOf(customerStage as (typeof ORDER)[number])
      if (newIdx > curIdx && this.opportunityUpdateStage(Number(o.id), customerStage, 'customer_sync')) changed++
    }
    return changed
  }

  /** 客户阶段联动成交 → 生成待人工成交登记提醒（幂等：同商机只保留一条 deal_pending 事件）。
   *  不直接置 won——成交必须人工走 registerOpportunityDeal 补齐字段。返回是否新生成。 */
  private dealPendingReminder(oppId: number): boolean {
    const opp = this.all('SELECT * FROM opportunity WHERE id = ?', [oppId])[0]
    if (!opp) return false
    const exists = this.all(
      "SELECT 1 AS x FROM opportunity_event WHERE opportunity_id = ? AND event_type = 'deal_pending' LIMIT 1",
      [oppId]
    ).length > 0
    if (exists) return false
    this.opportunityEventAdd(oppId, 'deal_pending', String(opp.stage || ''), '客户阶段判定成交，请登记成交表单')
    return true
  }

  // ─── 风险预警（P0：竞品/价格/服务消息信号 → crm_risk，PRD §18）────────────
  /** 客户风险列表（active 在前，含客户名） */
  riskList(opts?: { accountId?: number; status?: string }): CrmRow[] {
    const where: string[] = []
    const params: unknown[] = []
    if (opts?.accountId) { where.push('r.account_id = ?'); params.push(opts.accountId) }
    if (opts?.status) { where.push('r.status = ?'); params.push(opts.status) }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : ''
    return this.all(
      `SELECT r.*, a.name AS account_name FROM crm_risk r LEFT JOIN account a ON a.id = r.account_id ${w}
       ORDER BY (r.status = 'active') DESC, r.created_at DESC`, params
    )
  }
  /** 幂等记录风险：同客户同类型 active → 追加详情 + 取更高严重度；否则新建 */
  upsertRisk(accountId: number, risk: { riskType: 'competitor' | 'price' | 'service'; severity: 'high' | 'medium' | 'low'; detail: string; opportunityId?: number; sourceMsg?: string }): { id: number; created: boolean } {
    const now = Date.now()
    const existing = this.all("SELECT * FROM crm_risk WHERE account_id = ? AND risk_type = ? AND status = 'active' ORDER BY id DESC LIMIT 1", [accountId, risk.riskType])[0]
    if (existing) {
      const severityRank = { high: 3, medium: 2, low: 1 } as const
      const curRank = severityRank[String(existing.severity) as keyof typeof severityRank] ?? 1
      const newRank = severityRank[risk.severity] ?? 1
      const patch: CrmRow = { detail: `${String(existing.detail || '')}\n${risk.detail}`.slice(0, 300) }
      if (newRank > curRank) patch.severity = risk.severity
      if (!existing.opportunity_id && risk.opportunityId) patch.opportunity_id = risk.opportunityId
      // 阶段三告警锚点（设计-AI见解重定位 §4.2 告警 A）：source_msg 列一直空置，本次激活——只补空不覆盖
      if (!String(existing.source_msg || '') && risk.sourceMsg) patch.source_msg = risk.sourceMsg
      this.update('crm_risk', Number(existing.id), patch)
      return { id: Number(existing.id), created: false }
    }
    const id = this.create('crm_risk', {
      account_id: accountId, opportunity_id: risk.opportunityId || null,
      risk_type: risk.riskType, severity: risk.severity,
      detail: risk.detail, source_msg: risk.sourceMsg || '', status: 'active', created_at: now, resolved_at: 0
    })
    return { id: Number(id), created: true }
  }
  /** 风险解决（人工确认已处理） */
  resolveRisk(id: number): boolean {
    const r = this.all("SELECT id FROM crm_risk WHERE id = ? AND status = 'active'", [id])[0]
    if (!r) return false
    this.update('crm_risk', Number(r.id), { status: 'resolved', resolved_at: Date.now() })
    return true
  }

  /** 批量按微信会话查 account（灵感信箱徽章用，避免 N+1） */
  accountsBySessions(sessionIds: string[]): Record<string, { id: number; name: string }> {
    const ids = Array.from(new Set((sessionIds || []).filter(Boolean)))
    if (!ids.length) return {}
    const placeholders = ids.map(() => '?').join(',')
    const rows = this.all(`SELECT id, name, session_id FROM account WHERE session_id IN (${placeholders})`, ids)
    const out: Record<string, { id: number; name: string }> = {}
    for (const r of rows) out[String(r.session_id)] = { id: Number(r.id), name: String(r.name || '') }
    return out
  }

  /** 存量回填候选：已导入但核心字段缺失多的客户（按导入时间倒序） */
  enrichCandidates(limit: number): CrmRow[] {
    const rows = this.all('SELECT * FROM account WHERE session_id IS NOT NULL AND session_id <> \'\' ORDER BY imported_at DESC, id DESC LIMIT 200')
    const coreFields = ['company', 'phone', 'needs', 'budget', 'intent_model']
    return rows.filter((r) => {
      let customFields: Record<string, unknown> = {}
      customFields = parseJsonObject(r.custom_fields)
      const missing = coreFields.filter((f) => {
        const v = ENRICH_FORMAL_COLUMNS.has(f) ? r[f] : customFields[f]
        return v == null || String(v).trim() === ''
      })
      return missing.length >= 3
    }).slice(0, Math.max(1, limit))
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
  confirmAllocation(id: number, patch: { account_id?: number; contract_id?: number; sales_name?: string }, opts: { autoBy?: string; reason?: string } = {}): { ok: boolean; reason?: string } {
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
    if (opts.autoBy) {
      final.auto_confirmed_by = opts.autoBy
      if (opts.reason) final.auto_reason = opts.reason
    }
    this.update('allocation', id, final)
    const operator = opts.autoBy ?? patch.sales_name ?? String(a.sales_name ?? '')
    this.logActivity('allocation', id, 'confirmed',
      `归属 ${a.customer_hint || ''} ${Number(a.amount_hint ?? 0)} → 合同 ${contractId ?? '未关联'}${accountId ? ` 客户${accountId}` : ''}${opts.reason ? `（${opts.reason}）` : ''}`,
      operator)
    return { ok: true, linked: Boolean(contractId) }
  }

  /**
   * 到款审核通过：若该笔到款尚无任何归属，则自动建一条 pending 归属（挂到归属待确认）。
   * 保证审核通过后钱不"消失"——最终通过归属确认计入合同回款。
   */
  approvePayment(id: number, opts: { autoBy?: string } = {}): { ok: boolean; reason?: string; allocationCreated?: boolean } {
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
    const patch: CrmRow = { needs_review: 0 }
    if (opts.autoBy) patch.auto_approved_by = opts.autoBy
    this.update('payment_record', id, patch)
    this.logActivity('payment_record', id, 'approved', `确认到款 ${String(p.payer || '')} ¥${Number(p.amount_net ?? 0)}，${created ? '已转入归属待确认' : '已有归属记录'}`, opts.autoBy ?? '')
    return { ok: true, allocationCreated: created }
  }
  /**
   * 每日到款清单（销售认领视图）：近 N 天 payment_record 平铺，带认领状态 + 客户/合同/开票状态。
   * 开票判定：该认领账户最近一张非作废发票（订单群 PDF 归档 → status='issued' 即已开票）。
   * 未认领（allocation 为空）时 invoice 各列为 null——开票状态认领后可见。
   */
  paymentsByDay(days = 30): CrmRow[] {
    const startMs = Date.now() - days * 24 * 3600 * 1000
    return this.all(
      `SELECT pr.id, pr.payer, pr.amount_net, pr.pay_time, pr.group_id, pr.source, pr.raw_content,
              pr.pay_channel, pr.needs_review,
              al.id AS allocation_id, al.status AS alloc_status, al.account_id, al.contract_id,
              al.sales_name, al.confirmed_at, al.credited_amount,
              ac.name AS account_name, c.name AS contract_name,
              iv.id AS invoice_id, iv.invoice_no, iv.status AS invoice_status
       FROM payment_record pr
       LEFT JOIN allocation al ON al.payment_record_id = pr.id
       LEFT JOIN account ac ON ac.id = al.account_id
       LEFT JOIN contract c ON c.id = al.contract_id
       LEFT JOIN invoice iv ON iv.id = (
         SELECT id FROM invoice WHERE account_id = al.account_id AND status != 'voided'
         ORDER BY id DESC LIMIT 1)
       WHERE pr.pay_time >= ?
       ORDER BY pr.pay_time DESC`, [startMs])
  }

  /**
   * 销售手动认领到款：无归属则先建（approvePayment），已确认的拒绝重复认领，
   * 然后确认归属到客户/合同。返回 linked 表示已计入合同回款。
   * 历史遗留：AutoConfirm 确认过但未挂客户/合同的行（仅 confirmed + 公司名）允许补认领。
   */
  claimPayment(id: number, patch: { account_id?: number; contract_id?: number; sales_name?: string } = {}): { ok: boolean; reason?: string; linked?: boolean } {
    const p = this.getById('payment_record', id)
    if (!p) return { ok: false, reason: '到款不存在' }
    let alloc = this.all('SELECT * FROM allocation WHERE payment_record_id = ? LIMIT 1', [id])[0] || null
    if (!alloc) {
      const approved = this.approvePayment(id)
      if (!approved.ok) return approved
      alloc = this.all('SELECT * FROM allocation WHERE payment_record_id = ? LIMIT 1', [id])[0] || null
      if (!alloc) return { ok: false, reason: '归属创建失败' }
    }
    if (alloc.status === 'confirmed' && (alloc.account_id || alloc.contract_id)) return { ok: false, reason: '该笔到款已认领' }
    if (alloc.status === 'confirmed') {
      // 旧自动确认遗留：confirmed 但未挂客户/合同 → 手动补挂
      this.update('allocation', alloc.id, { ...patch, confirmed_at: Number(alloc.confirmed_at) })
      this.logActivity('allocation', alloc.id, 'confirmed',
        `补认领 ${String(alloc.customer_hint || '')} → ${patch.contract_id ? `合同 ${patch.contract_id}` : '客户'}`,
        patch.sales_name ?? '')
      return { ok: true, linked: Boolean(patch.contract_id) }
    }
    return this.confirmAllocation(Number(alloc.id), patch)
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
  /** 审计单点（宪法 §1.12 append-only）：非事务路径的 audit_event 写入；事务内请直接 tx.run 保持原子性 */
  auditAppend(actor: string, action: string, entityType: string, entityId: number | null, detail: unknown): void {
    this.run(
      'INSERT INTO audit_event (actor, action, entity_type, entity_id, detail, created_at) VALUES (?,?,?,?,?,?)',
      [actor, action, entityType, entityId, typeof detail === 'string' ? detail : JSON.stringify(detail), Date.now()]
    )
  }
  contractStatusHistory(contractId: number): CrmRow[] {
    return this.all('SELECT * FROM contract_status_history WHERE contract_id = ? ORDER BY id', [contractId])
  }
  activityBy(entity: string, entityId: number): CrmRow[] {
    return this.all('SELECT * FROM activity_log WHERE entity = ? AND entity_id = ? ORDER BY id', [entity, entityId])
  }
  /**
   * 统一时间线（Customer 360）：一个客户的所有关键事件一条流。
   * 聚合 CRM 业务动作（activity_log 的 account/contract/logistics/quotation/allocation/payment_record 实体）
   * + 线索流转（lead_activity）+ 商机事件（opportunity_event）。按时间升序返回。
   * 返回项：{ at, kind: 'crm'|'lead'|'opportunity', text }
   */
  accountTimeline(accountId: number): { at: number; kind: string; text: string }[] {
    const sql = `
      SELECT created_at AS at, 'crm' AS kind, detail AS text FROM activity_log WHERE entity='account' AND entity_id=?
      UNION ALL SELECT created_at, 'crm', detail FROM activity_log WHERE entity='contract' AND entity_id IN (SELECT id FROM contract WHERE account_id=?)
      UNION ALL SELECT created_at, 'crm', detail FROM activity_log WHERE entity='logistics' AND entity_id IN (SELECT id FROM logistics WHERE contract_id IN (SELECT id FROM contract WHERE account_id=?) OR account_id = ?)
      UNION ALL SELECT created_at, 'crm', detail FROM activity_log WHERE entity='quotation' AND entity_id IN (SELECT id FROM quotation WHERE contract_id IN (SELECT id FROM contract WHERE account_id=?))
      UNION ALL SELECT created_at, 'crm', detail FROM activity_log WHERE entity='allocation' AND entity_id IN (SELECT id FROM allocation WHERE account_id=?)
      UNION ALL SELECT created_at, 'crm', detail FROM activity_log WHERE entity='payment_record' AND entity_id IN (SELECT id FROM payment_record WHERE id IN (SELECT payment_record_id FROM allocation WHERE account_id=?))
      UNION ALL SELECT created_at, 'lead', note FROM lead_activity WHERE lead_id IN (SELECT id FROM lead WHERE account_id=?)
      UNION ALL SELECT created_at, 'opportunity', detail FROM opportunity_event WHERE opportunity_id IN (SELECT id FROM opportunity WHERE account_id=?)
      ORDER BY at`
    return this.all(sql, Array(9).fill(accountId)) as { at: number; kind: string; text: string }[]
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
  /**
   * 公开快照备份：把当前数据库完整快照写入 userData/crm-backups/weflow-crm-before-<tag>-<stamp>.db。
   * 滚动保留最近 20 份（旧的删除）。供删除前自动备份与自动确认批前快照共用。返回快照路径，失败返回 ''。
   */
  exportSnapshot(tag: string): string {
    if (!this.db || !this.dbPath) return ''
    try {
      const dir = join(dirname(this.dbPath), 'crm-backups')
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      const file = join(dir, `weflow-crm-before-${tag}-${stamp}.db`)
      atomicWriteFileSync(file, Buffer.from(this.db.export()))
      this.pruneSnapshots(dir)
      return file
    } catch (e) { console.error('[CrmDb] backup error:', e) }
    return ''
  }
  /** 滚动清理：crm-backups/ 下只保留最近 20 份快照 */
  private pruneSnapshots(dir: string): void {
    try {
      const files = readdirSync(dir).filter((f) => f.endsWith('.db')).sort().reverse()
      for (const f of files.slice(20)) rmSync(join(dir, f), { force: true })
    } catch { /* ignore */ }
  }
  /** 删除前自动备份（deleteContract/deleteAccount 调用） */
  private backupDb(): void {
    this.exportSnapshot('delete')
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
    // 账户级认领的物流（无合同）随客户删除清理；合同级已由上方 deleteContractCascade 处理
    removed += this.db.run('DELETE FROM logistics WHERE account_id = ?', [id]).changes
    this.db.run('DELETE FROM activity_log WHERE entity = ? AND entity_id = ?', ['account', id])
    this.db.run('DELETE FROM account WHERE id = ?', [id])
    this.logActivity('account', id, 'deleted', `删除客户「${String(acc.name ?? '')}」（含 ${contracts.length} 份合同）`)
    this.persistNow()
    return { ok: true, removed }
  }

  // ─── 物流 ─────────────────────────────────────────────────────────────────
  // 待认领队列：最新发货在前（配合跟单中心分页，今天的发货直接出现在第 1 页）
  unlinkedLogistics(): CrmRow[] { return this.all("SELECT * FROM logistics WHERE link_status = 'unlinked' ORDER BY id DESC") }
  /** 单号查重：物流群每晚同批列表重扫/补扫时幂等判断 */
  logisticsByTrackingNo(trackingNo: string): CrmRow | null {
    if (!trackingNo) return null
    const rows = this.all('SELECT * FROM logistics WHERE tracking_no = ? LIMIT 1', [trackingNo])
    return rows.length ? rows[0] : null
  }
  /**
   * 跟单视图：全量物流，按入库时间倒序。
   * opts.filter: 'unlinked'（待认领）| 'pending'（已认领待签收）| 'signed'（已签收）| 省略=全部
   */
  logisticsList(opts: { filter?: 'unlinked' | 'pending' | 'signed' } = {}): CrmRow[] {
    let where = ''
    if (opts.filter === 'unlinked') where = "WHERE link_status = 'unlinked'"
    else if (opts.filter === 'pending') where = "WHERE link_status = 'linked' AND status = 'shipped'"
    else if (opts.filter === 'signed') where = "WHERE status = 'signed'"
    return this.all(`SELECT * FROM logistics ${where} ORDER BY created_at DESC, id DESC`)
  }
  /** 确认签收：status='signed' + signed_at=now（二期快递 API 命中签收也调此方法） */
  markLogisticsSigned(id: number, opts: { actor?: string } = {}): { ok: boolean; reason?: string } {
    const l = this.getById('logistics', id)
    if (!l) return { ok: false, reason: '物流单不存在' }
    if (String(l.status) === 'signed') return { ok: true }
    this.update('logistics', id, { status: 'signed', signed_at: Date.now() })
    this.logActivity('logistics', id, 'signed', `单号 ${String(l.tracking_no ?? '')} 确认签收`, opts.actor ?? '')
    return { ok: true }
  }
  /**
   * 跟单超期：已发货（status='shipped'）超过 hours 小时未确认签收。
   * 客户经 contract→account（合同级）或 l.account_id（账户级认领）带出客户名 / 归属销售 / session_id。
   */
  pendingLogisticsOverdue(hours: number): CrmRow[] {
    const cutoff = Date.now() - hours * 3600 * 1000
    return this.all(
      `SELECT l.*, COALESCE(c.account_id, l.account_id) AS account_id, a.name AS customer_name, a.session_id, a.owner_sales AS account_owner_sales
       FROM logistics l
       LEFT JOIN contract c ON c.id = l.contract_id
       LEFT JOIN account a ON a.id = COALESCE(c.account_id, l.account_id)
       WHERE l.link_status = 'linked' AND l.status = 'shipped' AND l.latest_update_at < ? AND l.latest_update_at > 0
       ORDER BY l.latest_update_at ASC`,
      [cutoff]
    )
  }
  /**
   * 认领物流：归属到客户（account_id 必填其一），合同（contract_id）可选上下文。
   * 传 contractId 时自动带出其 account_id；两者皆缺返回 ok:false。
   * 合同级认领保留「未全款已发货」预警；账户级（无合同）正常认领不预警。
   */
  linkLogistics(id: number, opts: { accountId?: number; contractId?: number; autoBy?: string; ownerSales?: string } = {}): { ok: boolean; warning?: string; reason?: string } {
    const l = this.getById('logistics', id)
    if (!l) return { ok: false, reason: '物流单不存在' }
    const c = opts.contractId ? this.getById('contract', opts.contractId) : null
    const accountId = opts.accountId ?? (c ? Number(c.account_id) : undefined)
    if (!accountId && !opts.contractId) return { ok: false, reason: '缺少认领目标（客户或合同）' }
    const patch: CrmRow = { account_id: accountId, link_status: 'linked' }
    if (opts.contractId) patch.contract_id = opts.contractId
    if (opts.autoBy) patch.auto_linked_by = opts.autoBy
    if (opts.ownerSales) patch.owner_sales = opts.ownerSales
    this.update('logistics', id, patch)
    const acc = accountId ? this.getById('account', accountId) : null
    const accName = String(acc?.name ?? accountId ?? '')
    const warning = c && this.creditedTotal(Number(c.id)) + 0.005 < Number(c.amount ?? 0) ? '未全款已发货' : undefined
    const suffix = opts.contractId ? `（合同 ${opts.contractId}）` : ''
    this.logActivity('logistics', id, 'linked', `单号 ${String(l.tracking_no ?? '')} → 客户 ${accName}${suffix}${opts.ownerSales ? `（${opts.ownerSales}）` : ''}`, opts.autoBy ?? '')
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
  /**
   * 迁移报告落库（幂等 upsert：每个模块只保留最新一份快照）——设置页「存量迁移报告」的 SSOT。
   * 与 audit_event（append-only 业务留痕）解耦：audit 只在有实际写入时追加，报告每次扫描都刷新。
   */
  saveMigrationReport(module: string, title: string, summary: Record<string, number>, failures: unknown[], conflicts: unknown[], ranAt: number): void {
    this.run(
      'INSERT INTO migration_report (module, title, summary, failures, conflicts, ran_at) VALUES (?,?,?,?,?,?) ON CONFLICT(module) DO UPDATE SET title = excluded.title, summary = excluded.summary, failures = excluded.failures, conflicts = excluded.conflicts, ran_at = excluded.ran_at',
      [module, title, JSON.stringify(summary), JSON.stringify(failures), JSON.stringify(conflicts), ranAt]
    )
  }
  listMigrationReports(): CrmRow[] {
    return this.all('SELECT module, title, summary, failures, conflicts, ran_at FROM migration_report ORDER BY module')
  }
  /**
   * 按收件人自动认领：收件人命中客户（shipping_info/私聊地址）即认领到该客户，
   * 有 signed/shipped 合同则同时关联合同（发货主体）；无合同只挂客户。写 auto_linked_by 供撤销。
   */
  autoLinkLogisticsByReceiver(logiId: number, receiver: string): boolean {
    const acc = this.accountByReceiver(receiver)
    if (!acc) return false
    const c = this.all("SELECT * FROM contract WHERE account_id = ? AND status IN ('signed','shipped') ORDER BY id DESC LIMIT 1", [Number(acc.id)])
    const patch: CrmRow = { account_id: Number(acc.id), link_status: 'linked', auto_linked_by: 'auto' }
    if (c.length) patch.contract_id = Number(c[0].id)
    this.update('logistics', logiId, patch)
    const l = this.getById('logistics', logiId)
    this.logActivity('logistics', logiId, 'linked', `单号 ${String(l?.tracking_no ?? '')} → 客户 ${String(acc.name ?? '')}${c.length ? `（合同 ${c[0].id}）` : ''}`, 'auto')
    return true
  }
  /**
   * 物流认领候选：收件人+城市 → 候选合同 或 候选客户。
   * 返回项统一带 cand_kind（'contract' | 'account'）+ cand_tier（byAccount|viaShip|fallback）：
   * - byAccount / fallback：合同候选（account 名称/城市模糊匹配 / 近期已签约兜底）
   * - viaShip：私聊收货地址确定性命中客户 → 有合同返回其合同，无合同返回该客户本身（账户级候选，无合同客户可认领）
   * contract 候选附带 account_city / account_name，供自动确认引擎消歧与识别兜底。
   */
  logisticsCandidates(receiver: string, city: string): CrmRow[] {
    const byAccount = this.all(
      "SELECT c.*, a.city AS account_city, a.name AS account_name FROM contract c JOIN account a ON a.id = c.account_id WHERE a.name LIKE ? OR (a.city = ? AND ? <> '') ORDER BY c.id DESC LIMIT 5",
      ['%' + (receiver || '') + '%', city || '', city || '']
    )
    if (byAccount.length) return byAccount.map((r) => ({ ...r, cand_kind: 'contract', cand_tier: 'byAccount' }))
    // 私聊收货地址 → 客户 → 合同（无合同则返回客户本身，供无合同客户认领）
    const acc = this.accountByReceiver(receiver || '')
    if (acc) {
      const viaShip = this.all('SELECT * FROM contract WHERE account_id = ? ORDER BY id DESC LIMIT 5', [Number(acc.id)])
      if (viaShip.length) return viaShip.map((r) => ({ ...r, cand_kind: 'contract', cand_tier: 'viaShip' }))
      return [{ ...acc, account_id: Number(acc.id), cand_kind: 'account', cand_tier: 'viaShip' } as CrmRow]
    }
    return this.all("SELECT * FROM contract WHERE status IN ('signed','shipped') ORDER BY id DESC LIMIT 5")
      .map((r) => ({ ...r, cand_kind: 'contract', cand_tier: 'fallback' }))
  }

  // ─── 报价单（append-only 版本链：行项必须来自 product，宪法 §1.6）───────────
  /**
   * 版本链核心（事务内调用，写入单点）：INSERT 新版本行 + 关闭上一有效版本 + 合同指针 + 审计。
   * createQuotation 与模块 04 迁移共用（宪法 §1.6 修订 2026-09-09：迁移复用相同版本创建逻辑）。
   * version 按合同递增（MAX(version)+1）；quotation.contract_id 过渡期双写（§4.3 只读兼容）。
   * @returns { id, version, supersededId } supersededId = 被本版本关闭的上一有效版本（0 = 无）
   */
  createQuotationVersionTx(
    tx: { run: (sql: string, params?: unknown[]) => number; all: (sql: string, params?: unknown[]) => CrmRow[] },
    p: { contractId: number; itemsJson: string; total: number; validUntil?: number | null; actor?: string; source?: string; priceOverrides?: PriceOverride[] }
  ): { id: number; version: number; supersededId: number } {
    const now = Date.now()
    const cid = Number(p.contractId)
    const version = Number(tx.all('SELECT COALESCE(MAX(version),0) + 1 AS v FROM quotation WHERE contract_id = ?', [cid])[0]?.v || 1)
    const id = tx.run(
      'INSERT INTO quotation (contract_id, items, total, valid_until, custom_fields, status, version, effective_from, effective_to, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [cid, p.itemsJson, p.total, p.validUntil ?? null, '{}', 'effective', version, now, 0, now]
    )
    const supersededId = this.linkQuotationVersionTx(tx, {
      contractId: cid, quotationId: id, total: p.total, actor: p.actor, action: 'quote_version_create', source: p.source || 'app', priceOverrides: p.priceOverrides
    })
    return { id, version, supersededId }
  }

  /**
   * 合同指针接管 + 关闭上一有效版本（事务内调用；createQuotationVersionTx 与存量链规范化共用）。
   * 关闭语义 = 「新版本生效即关闭上一有效版本」：同合同 effective_to=0 的其他行 → effective_to=切换时刻
   * （effective_from 缺省的存量行顺手回填 ← created_at，保证每个关闭版本都有生效窗口）；
   * 指针：contract.quote_version_id ← 新版本（宪法 §1.6 权威方向）；同事务写 audit_event（§1.12）。
   * @returns 被关闭的上一有效版本 id（0 = 本版本即首版本）
   */
  private linkQuotationVersionTx(
    tx: { run: (sql: string, params?: unknown[]) => number; all: (sql: string, params?: unknown[]) => CrmRow[] },
    p: { contractId: number; quotationId: number; total?: number; actor?: string; action: string; source?: string; priceOverrides?: PriceOverride[] }
  ): number {
    const now = Date.now()
    const previous = tx.all(
      'SELECT id FROM quotation WHERE contract_id = ? AND COALESCE(effective_to,0) = 0 AND id != ? ORDER BY id DESC',
      [Number(p.contractId), Number(p.quotationId)]
    )
    const supersededIds = previous.map((row) => Number(row.id)).filter((id) => id > 0)
    const supersededId = supersededIds[0] || 0
    if (supersededIds.length) {
      tx.run(
        `UPDATE quotation SET effective_to = ?,
         effective_from = CASE WHEN COALESCE(effective_from,0) = 0 THEN COALESCE(NULLIF(created_at,0), ?) ELSE effective_from END
         WHERE contract_id = ? AND COALESCE(effective_to,0) = 0 AND id != ?`,
        [now, now, Number(p.contractId), Number(p.quotationId)]
      )
    }
    tx.run('UPDATE contract SET quote_version_id = ?, updated_at = ? WHERE id = ?', [Number(p.quotationId), now, Number(p.contractId)])
    tx.run(
      'INSERT INTO audit_event (actor, action, entity_type, entity_id, detail, created_at) VALUES (?,?,?,?,?,?)',
      [p.actor || currentActor(), p.action, 'quotation', Number(p.quotationId),
        JSON.stringify({ contract_id: Number(p.contractId), version_switch: true, superseded_id: supersededId, superseded_ids: supersededIds, total: p.total ?? null, source: p.source || 'app', ...(p.priceOverrides?.length ? { price_overrides: p.priceOverrides } : {}) }), now]
    )
    return supersededId
  }

  /**
   * 创建报价（= 新版本）：合同校验 → 行项必须来自 product → 版本链事务
   * （INSERT 新版本 + 关闭上一有效版本 + contract.quote_version_id + audit_event 同一事务，§1.6 修订）。
   * 行项校验：qty 正整数；unit_price（如提供）≥ 0；product_id 必须命中 product 主数据。
   * 任一步失败整体回滚，不覆盖旧行。
   */
  createQuotation(data: { contract_id: number; items: Array<{ product_id: number; qty: number; unit_price?: number }>; valid_until?: number; creation_request_id?: string }): { ok: boolean; id?: number; version?: number; reason?: string } {
    const contractId = Number(data.contract_id || 0)
    if (!contractId) return { ok: false, reason: '合同不能为空' }
    const items = Array.isArray(data.items) ? data.items : []
    if (!items.length) return { ok: false, reason: '报价至少一行产品' }
    try {
      const v = this.runTx((tx) => {
        if (!tx.all('SELECT id FROM contract WHERE id = ?', [contractId]).length) throw new Error('合同不存在')
        if (data.creation_request_id) {
          const contract = this.contractByCreationRequest(data.creation_request_id)
          if (Number(contract?.id) !== contractId) throw new Error('创建标识与合同不匹配')
          const existing = tx.all('SELECT id, version FROM quotation WHERE contract_id = ? ORDER BY version LIMIT 1', [contractId])[0]
          if (existing) return { id: Number(existing.id), version: Number(existing.version), supersededId: 0 }
        }
        const rows: CrmRow[] = []
        const priceOverrides: PriceOverride[] = []
        let total = 0
        for (const it of items) {
          const qty = Number(it.qty)
          if (!Number.isInteger(qty) || qty <= 0) throw new Error(`报价数量必须是正整数：${it.qty}`)
          if (it.unit_price != null) {
            const unitPrice = Number(it.unit_price)
            if (!Number.isFinite(unitPrice) || unitPrice < 0) throw new Error(`报价单价不可为负：${it.unit_price}`)
          }
          const p = tx.all('SELECT * FROM product WHERE id = ?', [Number(it.product_id)])[0]
          if (!p) throw new Error(`型号不存在: ${it.product_id}`)
          const unit = it.unit_price ?? Number(p.unit_price ?? 0)
          if (isPriceOverride(p.unit_price, it.unit_price)) priceOverrides.push({ product_id: Number(p.id), model: String(p.model || ''), catalog_unit_price: Number(p.unit_price || 0), quoted_unit_price: Number(unit) })
          const subtotal = Math.round(unit * qty * 100) / 100
          total = Math.round((total + subtotal) * 100) / 100
          let specsObj: Record<string, string> = {}
          specsObj = parseJsonObject<Record<string, string>>(p.specs)
          const specSummary = [p.material, ...Object.entries(specsObj).map(([k, v2]) => `${k}:${v2}`)].filter(Boolean).join('；')
          rows.push({ product_id: p.id, model: p.model, name: p.name, spec: p.spec, material: p.material ?? '', spec_summary: specSummary, qty, unit_price: unit, subtotal })
        }
        const ver = this.createQuotationVersionTx(tx, { contractId, itemsJson: JSON.stringify(rows), total, validUntil: data.valid_until ?? null, priceOverrides })
        // 时间线留痕（Customer 360 消费 activity_log；审计真源 = 同事务 audit_event，§1.12）
        tx.run('INSERT INTO activity_log (entity, entity_id, action, detail, operator, created_at) VALUES (?,?,?,?,?,?)',
          ['quotation', ver.id, 'created', `合同 ${contractId} v${ver.version}，${rows.length} 行，合计 ${total}`, '', Date.now()])
        return ver
      })
      return { ok: true, id: v.id, version: v.version }
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) }
    }
  }

  /** 当前有效报价（§1.6 权威方向：contract.quote_version_id → quotation；指针缺失时回退 effective_to=0 最新行） */
  currentQuotationForContract(contractId: number): CrmRow | null {
    const cid = Number(contractId || 0)
    if (!cid) return null
    const c = this.getById('contract', cid)
    const ptr = c && c.quote_version_id != null ? this.getById('quotation', Number(c.quote_version_id)) : null
    if (ptr && Number(ptr.effective_to || 0) === 0 && Number(ptr.contract_id || 0) === cid) return ptr
    return this.all('SELECT * FROM quotation WHERE contract_id = ? AND COALESCE(effective_to,0) = 0 ORDER BY id DESC LIMIT 1', [cid])[0] ?? null
  }

  /** 报价历史（版本链全量，新版本在前；历史版本只读——update() 守卫拒绝改写） */
  quotationHistoryForContract(contractId: number): CrmRow[] {
    const cid = Number(contractId || 0)
    if (!cid) return []
    return this.all('SELECT * FROM quotation WHERE contract_id = ? ORDER BY version DESC, id DESC', [cid])
  }

  /**
   * 存量报价行版本链规范化（模块 04 迁移复用点，宪法 §1.6 修订 2026-09-09）：
   * 同合同内按创建序重排 version=1..N；effective_from 缺省回填 ← created_at；
   * 旧行 effective_to ← 后继版本生效点（与 createQuotation「新版本生效即关闭上一版本」同一不变量）；
   * 最新版本保持 effective_to=0 并接管 contract.quote_version_id；同事务 audit_event(action='quote_version_backfill')。
   * 幂等：重复执行收敛到同一终态（迁移执行器据此判 alreadyDone，不重复写审计）。
   */
  quotationChainNormalized(contractId: number): boolean {
    const qs = this.all(
      'SELECT id, version, effective_from, effective_to, created_at FROM quotation WHERE contract_id = ? ORDER BY COALESCE(NULLIF(created_at,0), id), id',
      [Number(contractId)]
    )
    if (!qs.length) return false
    const last = qs[qs.length - 1]
    return qs.every((q, i) => Number(q.version || 0) === i + 1 && Number(q.effective_from || 0) > 0)
      && qs.slice(0, -1).every((q) => Number(q.effective_to || 0) > 0)
      && Number(last.effective_to || 0) === 0
      && Number(this.getById('contract', Number(contractId))?.quote_version_id || 0) === Number(last.id)
  }

  normalizeQuotationVersionChain(contractId: number, opts: { actor?: string } = {}): { ok: boolean; versions?: number; linkedId?: number; reason?: string } {
    try {
      const r = this.runTx((tx) => {
        const rows = tx.all(
          'SELECT id, effective_from, created_at FROM quotation WHERE contract_id = ? ORDER BY COALESCE(NULLIF(created_at,0), id), id',
          [Number(contractId)]
        )
        if (!rows.length) throw new Error('合同无报价行')
        const effFrom = rows.map((row) => {
          if (Number(row.effective_from || 0) > 0) return Number(row.effective_from)
          if (Number(row.created_at || 0) > 0) return Number(row.created_at)
          return Date.now()
        })
        const lastIdx = rows.length - 1
        rows.forEach((row, i) => {
          tx.run('UPDATE quotation SET version = ?, effective_from = ?, effective_to = ? WHERE id = ?',
            [i + 1, effFrom[i], i < lastIdx ? effFrom[i + 1] : 0, Number(row.id)])
        })
        const linkedId = Number(rows[lastIdx].id)
        tx.run('UPDATE contract SET quote_version_id = ?, updated_at = ? WHERE id = ?', [linkedId, Date.now(), Number(contractId)])
        tx.run(
          'INSERT INTO audit_event (actor, action, entity_type, entity_id, detail, created_at) VALUES (?,?,?,?,?,?)',
          [opts.actor || 'system:migration', 'quote_version_backfill', 'quotation', linkedId,
            JSON.stringify({ contract_id: Number(contractId), versions: rows.length, source: 'migration:04' }), Date.now()]
        )
        return { versions: rows.length, linkedId }
      })
      return { ok: true, versions: r.versions, linkedId: r.linkedId }
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) }
    }
  }

  // ─── 元数据表单（借 Twenty 增量元数据 / Cordys module/form 形态）──────────
  formDefinition(entity: string): CrmRow[] {
    return this.all('SELECT * FROM crm_field_meta WHERE entity = ? AND enabled = 1 ORDER BY sort', [entity])
  }
  saveFieldMeta(meta: CrmRow): number { return this.create('crm_field_meta', meta) }

  // ─── 确认中心队列 ─────────────────────────────────────────────────────────
  reviewQueues(): { allocations: CrmRow[]; logistics: CrmRow[]; payments: CrmRow[]; invoices: CrmRow[]; infoPending: CrmRow[] } {
    return {
      // JOIN 支付记录带来源（群/时间/原始内容），供确认卡片核对"这笔钱哪来的"
      allocations: this.all(`SELECT al.*, pr.group_id AS src_group_id, pr.pay_time AS src_time, pr.raw_content AS src_raw
        FROM allocation al LEFT JOIN payment_record pr ON al.payment_record_id = pr.id
        WHERE al.status = 'pending' ORDER BY al.id`),
      logistics: this.unlinkedLogistics(),
      payments: this.all('SELECT * FROM payment_record WHERE needs_review = 1 ORDER BY id'),
      invoices: this.all("SELECT * FROM invoice WHERE status = 'pre_issue' ORDER BY id"),
      // 信息待确认：account.enrich_meta.pending 派生（AI 填充低置信字段人工裁决）
      infoPending: this.infoPendingQueue()
    }
  }

  // ─── 自动确认：审计日志 / 历史 / 撤销 ──────────────────────────────────────
  /** 写一条结构化自动确认日志（auto_confirm_log，供前端回看/撤销） */
  logAutoConfirm(entity: string, entityId: number, decision: string, confidence: number, reason: string, action: string): void {
    if (!this.db) return
    this.db.run(
      'INSERT INTO auto_confirm_log (entity, entity_id, decision, confidence, reason, action, created_at) VALUES (?,?,?,?,?,?,?)',
      [entity, entityId, decision, confidence, reason, action, Date.now()]
    )
    this.persist()
  }
  /** 自动确认历史（倒序） */
  autoConfirmHistory(limit = 50): CrmRow[] {
    return this.all('SELECT * FROM auto_confirm_log ORDER BY id DESC LIMIT ?', [limit])
  }
  /** 撤销自动确认归属：恢复 pending 并清空 account/contract/审计字段（仅限自动确认的条目） */
  undoAllocation(id: number): { ok: boolean; reason?: string } {
    const a = this.getById('allocation', id)
    if (!a) return { ok: false, reason: '归属项不存在' }
    if (String(a.auto_confirmed_by || '') !== 'auto') return { ok: false, reason: '非自动确认，无需撤销' }
    this.update('allocation', id, { status: 'pending', account_id: null, contract_id: null, auto_confirmed_by: null, auto_reason: null, confirmed_at: null })
    this.logActivity('allocation', id, 'unconfirmed', `撤销自动确认 ${String(a.customer_hint || '')}`, 'auto')
    this.logAutoConfirm('allocation', id, 'undo', 0, '人工撤销自动确认', 'undoAllocation')
    return { ok: true }
  }
  /** 撤销自动通过到款：needs_review=1 恢复待审（仅限自动通过的条目） */
  undoPayment(id: number): { ok: boolean; reason?: string } {
    const p = this.getById('payment_record', id)
    if (!p) return { ok: false, reason: '到款不存在' }
    if (String(p.auto_approved_by || '') !== 'auto') return { ok: false, reason: '非自动通过，无需撤销' }
    this.update('payment_record', id, { needs_review: 1, auto_approved_by: null })
    this.logActivity('payment_record', id, 'unapproved', `撤销自动通过 ${String(p.payer || '')}`, 'auto')
    this.logAutoConfirm('payment_record', id, 'undo', 0, '人工撤销自动通过', 'undoPayment')
    return { ok: true }
  }
  /** 撤销自动链接物流：unlinked 恢复（仅限自动链接的条目） */
  undoLogistics(id: number): { ok: boolean; reason?: string } {
    const l = this.getById('logistics', id)
    if (!l) return { ok: false, reason: '物流不存在' }
    if (String(l.auto_linked_by || '') !== 'auto') return { ok: false, reason: '非自动链接，无需撤销' }
    this.update('logistics', id, { account_id: null, contract_id: null, link_status: 'unlinked', auto_linked_by: null })
    this.logActivity('logistics', id, 'unlinked', `撤销自动链接 ${String(l.tracking_no || '')}`, 'auto')
    this.logAutoConfirm('logistics', id, 'undo', 0, '人工撤销自动链接', 'undoLogistics')
    return { ok: true }
  }
  /** 撤销自动关联发票：清 account/contract/amount（仅限自动关联的条目） */
  undoInvoice(id: number): { ok: boolean; reason?: string } {
    const inv = this.getById('invoice', id)
    if (!inv) return { ok: false, reason: '发票不存在' }
    if (String(inv.auto_updated_by || '') !== 'auto') return { ok: false, reason: '非自动关联，无需撤销' }
    this.update('invoice', id, { account_id: null, contract_id: null, amount: 0, auto_updated_by: null })
    this.logActivity('invoice', id, 'unlinked', `撤销自动关联发票 ${String(inv.invoice_no || '')}`, 'auto')
    this.logAutoConfirm('invoice', id, 'undo', 0, '人工撤销自动关联', 'undoInvoice')
    return { ok: true }
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
    return rows.map((r) => {
      let customFields: Record<string, unknown> = {}
      customFields = parseJsonObject(r.custom_fields)
      let filled = 0
      for (const f of ENRICH_FIELDS) {
        const v = ENRICH_FORMAL_COLUMNS.has(f) ? r[f] : customFields[f]
        if (v != null && String(v).trim() !== '') filled++
      }
      return { ...r, credited_total: Number(r.credited_total || 0), contract_count: Number(r.contract_count || 0), enrich_filled: filled, enrich_total: ENRICH_FIELDS.length }
    })
  }

  // ─── 统计概览（工作台可视化面板）──────────────────────────────────────────
  /** 工作台概览：总量 + 近 8 周到款趋势 + 客户阶段分布 + 合同管道（前端 ECharts 渲染） */
  statsOverview(): CrmRow {
    const customers = Number(this.all('SELECT COUNT(*) AS n FROM account')[0]?.n ?? 0)
    const active = this.all("SELECT COALESCE(SUM(amount),0) AS s, COUNT(*) AS n FROM contract WHERE status IN ('pending_sign','signed')")[0]
    const now = new Date()
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime()
    // 口径：只计已人工认领（account_id 非空）+ 按**到款日**（pay_time）归类——
    // 历史补扫入库后集中认领的款按真实到账日进月/周统计，不冒充当月；旧 AutoConfirm 遗留 confirmed 无客户/合同不算
    const monthPaid = Number(this.all(
      "SELECT COALESCE(SUM(al.credited_amount),0) AS s FROM allocation al JOIN payment_record pr ON pr.id = al.payment_record_id WHERE al.status = 'confirmed' AND al.account_id IS NOT NULL AND pr.pay_time >= ?", [monthStart])[0]?.s ?? 0)
    const q = this.reviewQueues()
    const pendingReview = q.allocations.length + q.logistics.length + q.payments.length + q.invoices.length + q.infoPending.length
    // 近 8 周到款趋势（周一为一周起点）
    const weekMs = 7 * 24 * 3600 * 1000
    const thisMonday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7)).getTime()
    const paidWeekly: Array<{ week: string; amount: number }> = []
    for (let i = 7; i >= 0; i--) {
      const start = thisMonday - i * weekMs
      const r = this.all(
        "SELECT COALESCE(SUM(al.credited_amount),0) AS s FROM allocation al JOIN payment_record pr ON pr.id = al.payment_record_id WHERE al.status = 'confirmed' AND al.account_id IS NOT NULL AND pr.pay_time >= ? AND pr.pay_time < ?", [start, start + weekMs])
      const d = new Date(start)
      paidWeekly.push({ week: `${d.getMonth() + 1}/${d.getDate()}`, amount: Number(r[0]?.s ?? 0) })
    }
    const stageDist = this.all("SELECT COALESCE(sales_stage,'') AS stage, COUNT(*) AS count FROM account GROUP BY sales_stage ORDER BY count DESC")
      .map((r) => ({ stage: String(r.stage || 'unknown'), count: Number(r.count) }))
    const pipeline = this.all('SELECT status, COUNT(*) AS count, COALESCE(SUM(amount),0) AS amount FROM contract GROUP BY status')
      .map((r) => ({ status: String(r.status), count: Number(r.count), amount: Number(r.amount) }))
    return {
      customers,
      activeContractCount: Number(active?.n ?? 0),
      activeContractAmount: Number(active?.s ?? 0),
      monthPaid, pendingReview, paidWeekly, stageDist, pipeline
    }
  }

  // ─── 刀 5 问数据读口（hermesAskDataService 模板专用，全部参数化只读 SQL）───────
  // 三个读口与页面同源：account 名匹配 / 商机与合同经既有列直读 / 月到款 = statsOverview monthPaid
  // 同口径（confirmed + account_id 非空 + pay_time 归类）按 owner 分组，owner 过滤由调用方 filterByOwner 统一执行。

  /** 按微信会话 id 精确取客户档案（Hermes customer.by_session 专用；参数化只读） */
  accountBySession(sessionId: string): CrmRow | null {
    const sid = String(sessionId || '').trim()
    if (!sid) return null
    return this.all('SELECT * FROM account WHERE session_id = ? LIMIT 1', [sid])[0] ?? null
  }

  /** 按客户名模糊匹配（刀 5「某客户到哪步」模板参数化查询；LIKE 只读）。
   *  limit <= 0 表示不限制（Hermes 工具先取完整匹配集合再过滤后 slice 用） */
  accountSearchByName(name: string, limit: number = 5): CrmRow[] {
    const q = String(name || '').trim()
    if (!q) return []
    if (limit > 0) {
      return this.all('SELECT * FROM account WHERE name LIKE ? ORDER BY updated_at DESC LIMIT ?', [`%${q}%`, limit])
    }
    return this.all('SELECT * FROM account WHERE name LIKE ? ORDER BY updated_at DESC', [`%${q}%`])
  }

  /** 某客户名下合同（创建倒序；刀 5「某客户到哪步」最新合同读口） */
  contractsByAccount(accountId: number): CrmRow[] {
    if (!accountId) return []
    return this.all('SELECT * FROM contract WHERE account_id = ? ORDER BY created_at DESC, id DESC', [accountId])
  }

  /**
   * 本月已确认到款按归属销售分组（刀 5「本月到款」读口；与 statsOverview.monthPaid 同口径：
   * allocation confirmed + account_id 非空 + JOIN payment_record 按 pay_time 落月）。
   * 空 owner_sales 归 ''（公共未归属——filterByOwner 语义下销售可见自己 + 空归属）。
   */
  monthPaidByOwner(): Array<{ owner_sales: string; amount: number; count: number }> {
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime()
    return this.all(
      "SELECT COALESCE(a.owner_sales, '') AS owner_sales, COALESCE(SUM(al.credited_amount),0) AS amount, COUNT(*) AS count " +
      'FROM allocation al JOIN payment_record pr ON pr.id = al.payment_record_id ' +
      'LEFT JOIN account a ON a.id = al.account_id ' +
      "WHERE al.status = 'confirmed' AND al.account_id IS NOT NULL AND pr.pay_time >= ? " +
      "GROUP BY COALESCE(a.owner_sales, '')",
      [monthStart]
    ).map((r) => ({ owner_sales: String(r.owner_sales || ''), amount: Number(r.amount || 0), count: Number(r.count || 0) }))
  }

  /** AI 准确率统计（近 N 天）：自动填充/人工采纳修正/报价信号转化 */
  aiAccuracyStats(days = 7): CrmRow {
    const since = Date.now() - days * 86400000
    const cnt = (sql: string, params: unknown[] = []) => Number(this.all(sql, params)[0]?.n ?? 0)
    const enrichAuto = cnt("SELECT COUNT(*) AS n FROM auto_confirm_log WHERE entity = 'account' AND decision = 'enrich_auto' AND created_at >= ?", [since])
    const infoAccept = cnt("SELECT COUNT(*) AS n FROM auto_confirm_log WHERE entity = 'account' AND decision = 'info_accept' AND created_at >= ?", [since])
    const infoReject = cnt("SELECT COUNT(*) AS n FROM auto_confirm_log WHERE entity = 'account' AND decision = 'info_reject' AND created_at >= ?", [since])
    const manualEdit = cnt("SELECT COUNT(*) AS n FROM activity_log WHERE entity = 'account' AND action = 'field_edited' AND created_at >= ?", [since])
    const writtenTotal = enrichAuto + infoAccept
    const quoteTotal = cnt('SELECT COUNT(*) AS n FROM quote_signal WHERE quoted_at >= ?', [since])
    const quoteReplied = cnt('SELECT COUNT(*) AS n FROM quote_signal WHERE quoted_at >= ? AND customer_replied_at > 0', [since])
    const quoteReplied24 = cnt('SELECT COUNT(*) AS n FROM quote_signal WHERE quoted_at >= ? AND customer_replied_at > 0 AND customer_replied_at - quoted_at <= 86400000', [since])
    const quotePending = cnt('SELECT COUNT(*) AS n FROM quote_signal WHERE quoted_at >= ? AND customer_replied_at = 0', [since])
    return {
      days, enrichAuto, infoAccept, infoReject, manualEdit, writtenTotal,
      correctionRate: writtenTotal > 0 ? Math.round((manualEdit / writtenTotal) * 100) : 0,
      acceptRate: infoAccept + infoReject > 0 ? Math.round((infoAccept / (infoAccept + infoReject)) * 100) : null,
      quoteTotal, quoteReplied, quoteReplied24, quotePending
    }
  }

  // ─── 工作台 ───────────────────────────────────────────────────────────────
  workbench(): CrmRow[] {
    // 合同无 owner_sales 列（宪法设计）：owner 经 account_id JOIN account 带出（页面过滤档用，只加 SELECT 列不改口径）
    const contracts = this.all(
      'SELECT c.*, a.owner_sales AS owner_sales FROM contract c LEFT JOIN account a ON a.id = c.account_id ORDER BY c.id DESC LIMIT 200'
    )
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
