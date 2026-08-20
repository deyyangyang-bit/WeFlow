/**
 * crmLeadService.ts —— 单机线索流转模块装配层
 * 导入（Excel/文本）→ 清洗去重落库 → SLA 扫描/今日行动 → 首触闭环 → 转客户。
 * 表分布：lead/lead_activity/import_batch 在 crmDb（weflow-crm.db）；
 *         follow_up_task（SLA 卡）在 salesDb（weflow-sales.db）。
 * 跨库铁律：先 crmDb 后 salesDb + 扫描自愈（两库独立 sql.js 连接，无法单事务）。
 */
import { crmDbService, type CrmRow } from './crmDbService'
import { salesDbService } from './salesDbService'
import { classifyLead, dedupeRows, maskContact, type RawLeadRow } from './crmLeadImportCore'

// ─── 配置注入（registerCrmIpcHandlers 装配）─────────────────────────────────
export interface LeadConfigRef { get: (key: string) => unknown }
let configRef: LeadConfigRef | null = null
export function setLeadConfig(ref: LeadConfigRef): void { configRef = ref }

function slaHours(): number {
  const n = Number(configRef?.get('crmLeadSlaHours') ?? 24)
  return Number.isFinite(n) && n > 0 && n <= 72 ? n : 24
}

export const DEFAULT_DEAD_REASONS = ['号码无效', '重复留资', '明确不要', '同行', '非目标客户', '已购车', '联系不上', '其他']

// ─── 导入 ───────────────────────────────────────────────────────────────────
export interface ImportResult {
  batchId: number
  total: number
  valid: number
  duplicate: number
  invalid: number
  /** 无效行的原始行号（0 基） */
  invalidIndexes: number[]
}

/** 批量导入：清洗 → 同批去重 → 事务落库（跨批重复靠唯一索引捕获）→ import_batch 统计 */
export function importLeads(source: string, fileName: string, rows: RawLeadRow[]): ImportResult {
  const src = String(source || '').trim() || '自定义'
  const parsed = rows.map((r) => classifyLead({ ...r, source: src }))
  const dedupe = dedupeRows(parsed)
  const now = Date.now()
  const deadline = now + slaHours() * 3600_000
  let valid = 0
  let duplicate = dedupe.duplicateCount

  const batchId = crmDbService.runTx((tx) => {
    for (const p of dedupe.valid) {
      try {
        const id = tx.run(
          `INSERT INTO lead (contact_type, contact_normalized, contact_raw, wechat, source, name, tag, note,
           status, first_contact_deadline, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          [p.contactType, p.contactNormalized, p.contactRaw, p.wechat, src, p.name, p.tag, p.note, 'NEW', deadline, now, now]
        )
        tx.run('INSERT INTO lead_activity (lead_id, action, note, created_at) VALUES (?,?,?,?)', [id, 'IMPORTED', `来源：${src}`, now])
        valid++
      } catch {
        duplicate++ // UNIQUE 冲突 = 跨批重复
      }
    }
    return tx.run(
      'INSERT INTO import_batch (source, file_name, total, valid, duplicate, invalid, created_at) VALUES (?,?,?,?,?,?,?)',
      [src, String(fileName || '粘贴文本'), rows.length, valid, duplicate, dedupe.invalidCount, now]
    )
  })

  scanLeadSla()
  return { batchId, total: rows.length, valid, duplicate, invalid: dedupe.invalidCount, invalidIndexes: dedupe.invalidIndexes }
}

// ─── 列表 / 详情 ────────────────────────────────────────────────────────────
export interface LeadListOpts {
  status?: string
  source?: string
  overdueOnly?: boolean
  q?: string
  limit?: number
  offset?: number
}

export function listLeads(opts: LeadListOpts = {}): CrmRow[] {
  const where: string[] = []
  const params: unknown[] = []
  if (opts.status && opts.status !== '全部') { where.push('status = ?'); params.push(opts.status) }
  if (opts.source && opts.source !== '全部') { where.push('source = ?'); params.push(opts.source) }
  if (opts.overdueOnly) { where.push("status = 'NEW' AND first_contact_deadline < ?"); params.push(Date.now()) }
  const q = String(opts.q || '').trim()
  if (q) { where.push('(contact_normalized LIKE ? OR name LIKE ? OR tag LIKE ?)'); const like = `%${q}%`; params.push(like, like, like) }
  // 排序：超时未首触的 NEW 线索置顶（SLA 紧急度优先）→ 其余按 id DESC（新导入在前，方便确认导入结果）
  const now = Date.now()
  const sql = `SELECT * FROM lead${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY (CASE WHEN status = 'NEW' AND first_contact_deadline < ? THEN 0 ELSE 1 END) ASC, id DESC LIMIT ? OFFSET ?`
  params.push(now, opts.limit ?? 200, opts.offset ?? 0)
  return crmDbService.all(sql, params)
}

export interface LeadOverview {
  total: number
  byStatus: Record<string, number>
  /** 超时未首触的 NEW 线索（SLA 提醒目标） */
  overdue: number
  todayImported: number
  todayContacted: number
  /** 未处理（pending）的 SLA 今日行动卡数 */
  pendingSla: number
  sources: Array<{ source: string; count: number }>
}

/** 线索池顶部统计卡片：总数/状态分布/超时/今日导入/今日首触/待处理 SLA 卡/来源分布 */
export function leadOverview(): LeadOverview {
  const dayStart = new Date()
  dayStart.setHours(0, 0, 0, 0)
  const ts = dayStart.getTime()
  const now = Date.now()
  const total = Number(crmDbService.all('SELECT COUNT(*) AS c FROM lead')[0].c)
  const byStatus: Record<string, number> = {}
  for (const r of crmDbService.all('SELECT status, COUNT(*) AS c FROM lead GROUP BY status')) byStatus[String(r.status)] = Number(r.c)
  const overdue = Number(crmDbService.all("SELECT COUNT(*) AS c FROM lead WHERE status = 'NEW' AND first_contact_deadline < ?", [now])[0].c)
  const todayImported = Number(crmDbService.all('SELECT COUNT(*) AS c FROM lead WHERE created_at >= ?', [ts])[0].c)
  const todayContacted = Number(crmDbService.all('SELECT COUNT(*) AS c FROM lead WHERE first_contacted_at >= ?', [ts])[0].c)
  const pendingSla = salesDbService.todoList({ status: 'pending' }).filter((t) => t.trigger_type === 'sla_lead').length
  const sources = crmDbService.all('SELECT source, COUNT(*) AS c FROM lead GROUP BY source ORDER BY c DESC').map((r) => ({ source: String(r.source), count: Number(r.c) }))
  return { total, byStatus, overdue, todayImported, todayContacted, pendingSla, sources }
}

export function leadDetail(leadId: number): { lead: CrmRow | null; activities: CrmRow[] } {
  const lead = crmDbService.getById('lead', Number(leadId))
  const activities = crmDbService.all('SELECT * FROM lead_activity WHERE lead_id = ? ORDER BY id DESC', [Number(leadId)])
  return { lead, activities }
}

// ─── 状态流转 ───────────────────────────────────────────────────────────────
export interface StatusActionOpts {
  /** 首触渠道 PHONE/WECHAT/SMS */
  channel?: string
  /** 死因（DEAD 必填） */
  reason?: string
  note?: string
}

const ACTION_ACTION: Record<string, string> = { contacted: 'CONTACTED', wx_added: 'WX_ADDED', dead: 'DEAD', reopen: 'REOPEN' }

/** 状态流转（事务）：contacted/wx_added/dead(必填死因)/reopen。返回 { ok, error? } */
export function updateLeadStatus(leadId: number, action: keyof typeof ACTION_ACTION, opts: StatusActionOpts = {}): { ok: boolean; error?: string } {
  const id = Number(leadId)
  const lead = crmDbService.getById('lead', id)
  if (!lead) return { ok: false, error: '线索不存在' }
  if (action === 'dead' && !String(opts.reason || '').trim()) return { ok: false, error: 'DEAD 必须填写死因' }
  const now = Date.now()
  crmDbService.runTx((tx) => {
    if (action === 'contacted') {
      const channel = String(opts.channel || 'PHONE').toUpperCase()
      tx.run('UPDATE lead SET status = ?, first_contacted_at = ?, first_contact_channel = ?, updated_at = ? WHERE id = ?', ['CONTACTED', now, channel, now, id])
      tx.run('INSERT INTO lead_activity (lead_id, action, note, created_at) VALUES (?,?,?,?)', [id, 'CONTACTED', `首触渠道：${channel}`, now])
    } else if (action === 'wx_added') {
      tx.run("UPDATE lead SET status = 'WX_ADDED', updated_at = ? WHERE id = ?", [now, id])
      tx.run('INSERT INTO lead_activity (lead_id, action, note, created_at) VALUES (?,?,?,?)', [id, 'WX_ADDED', String(opts.note || '已添加微信'), now])
    } else if (action === 'dead') {
      const reason = String(opts.reason || '').trim()
      tx.run('UPDATE lead SET status = ?, dead_reason = ?, updated_at = ? WHERE id = ?', ['DEAD', reason, now, id])
      tx.run('INSERT INTO lead_activity (lead_id, action, note, created_at) VALUES (?,?,?,?)', [id, 'DEAD', `死因：${reason}`, now])
    } else if (action === 'reopen') {
      tx.run("UPDATE lead SET status = 'NEW', dead_reason = '', updated_at = ? WHERE id = ?", [now, id])
      tx.run('INSERT INTO lead_activity (lead_id, action, note, created_at) VALUES (?,?,?,?)', [id, 'REOPEN', String(opts.note || '恢复跟进'), now])
    }
  })
  return { ok: true }
}

// ─── 转客户（与 account 打通）───────────────────────────────────────────────
export interface ToAccountResult { ok: boolean; error?: string; accountId?: number; existed?: boolean }

/** 转客户：查重（phone / custom_fields.wxid）→ 建或关联 account → ACCOUNT + 流水 */
export function toAccount(leadId: number): ToAccountResult {
  const id = Number(leadId)
  const lead = crmDbService.getById('lead', id)
  if (!lead) return { ok: false, error: '线索不存在' }
  const isPhone = lead.contact_type === 'phone' || lead.contact_type === 'both'
  const isWechat = lead.contact_type === 'wechat'
  const now = Date.now()
  let accountId = Number(lead.account_id || 0)
  let existed = false

  const result = crmDbService.runTx((tx) => {
    // 已关联则直接复用
    if (accountId > 0) return { accountId, existed: false }
    // 查重：手机号 → account.phone；微信 → custom_fields.wxid
    if (isPhone) {
      const hit = tx.all('SELECT id FROM account WHERE phone = ? LIMIT 1', [String(lead.contact_normalized)])
      if (hit.length) { accountId = Number(hit[0].id); existed = true }
    } else if (isWechat) {
      const hit = tx.all("SELECT id FROM account WHERE custom_fields LIKE ? LIMIT 1", [`%\"wxid\":\"${String(lead.contact_normalized)}\"%`])
      if (hit.length) { accountId = Number(hit[0].id); existed = true }
    }
    if (!accountId) {
      const name = String(lead.name || '').trim() || `线索客户${maskContact({ contactType: lead.contact_type, contactNormalized: lead.contact_normalized })}`
      const cf: Record<string, unknown> = {}
      if (isWechat) cf.wxid = String(lead.contact_normalized)
      if (lead.note) cf.lead_note = String(lead.note)
      accountId = tx.run(
        'INSERT INTO account (name, phone, custom_fields, created_at, updated_at) VALUES (?,?,?,?,?)',
        [name, isPhone ? String(lead.contact_normalized) : '', JSON.stringify(cf), now, now]
      )
    }
    tx.run('UPDATE lead SET status = ?, account_id = ?, updated_at = ? WHERE id = ?', ['ACCOUNT', accountId, now, id])
    tx.run('INSERT INTO lead_activity (lead_id, action, note, created_at) VALUES (?,?,?,?)', [id, 'TO_ACCOUNT', existed ? `关联已有客户 #${accountId}` : `新建客户 #${accountId}`, now])
    return { accountId, existed }
  })

  return { ok: true, accountId: result.accountId, existed: result.existed }
}

// ─── 首触 SLA 扫描 + 闭环 ───────────────────────────────────────────────────
/** 扫描超时 NEW 线索 → 建 SLA 卡（应用层幂等 + partial unique index 双兜底）；随后自愈脏卡 */
export function scanLeadSla(): number {
  const now = Date.now()
  const overdue = crmDbService.all("SELECT * FROM lead WHERE status = 'NEW' AND first_contact_deadline < ?", [now])
  let created = 0
  for (const lead of overdue) {
    const leadId = Number(lead.id)
    if (salesDbService.hasSlaPendingTask(leadId)) continue
    const masked = maskContact({ contactType: String(lead.contact_type) as 'phone' | 'wechat' | 'both', contactNormalized: String(lead.contact_normalized) })
    const hours = Math.max(1, Math.floor((now - Number(lead.first_contact_deadline)) / 3600_000))
    salesDbService.todoCreate({
      display_name: `📥 ${String(lead.source)}线索 ${masked}`,
      title: `线索 ${masked} 已超 ${hours} 小时未首触`,
      trigger_type: 'sla_lead',
      source_id: leadId,
      priority_score: Math.min(140, 80 + Math.min(hours, 30)),
      due_at: now,
      action_type: 'call_lead',
      created_by: 'sla'
    } as any)
    created++
  }
  selfHealSlaTasks()
  return created
}

/** 自愈：lead 已非 NEW 但残留 pending 的 sla_lead 卡 → 标 DONE（防脏卡） */
function selfHealSlaTasks(): void {
  const pending = salesDbService.todoList({ status: 'pending', limit: 200 })
  for (const t of pending) {
    if (t.trigger_type !== 'sla_lead' || !t.source_id || !t.id) continue
    const lead = crmDbService.getById('lead', Number(t.source_id))
    if (lead && lead.status !== 'NEW') salesDbService.todoUpdate(t.id, { status: 'done' })
  }
}

/** 今日行动完成 SLA 卡闭环：先 crmDb（NEW→CONTACTED+流水）再 salesDb（卡 DONE）。 */
export function completeLeadFirstContact(taskId: number): boolean {
  const task = salesDbService.getTask(Number(taskId))
  if (!task || task.trigger_type !== 'sla_lead' || !task.source_id) return false
  const leadId = Number(task.source_id)
  const now = Date.now()
  crmDbService.runTx((tx) => {
    const rows = tx.all('SELECT status FROM lead WHERE id = ?', [leadId])
    if (!rows.length) return
    if (rows[0].status === 'NEW') {
      tx.run('UPDATE lead SET status = ?, first_contacted_at = ?, updated_at = ? WHERE id = ?', ['CONTACTED', now, now, leadId])
      tx.run('INSERT INTO lead_activity (lead_id, action, note, created_at) VALUES (?,?,?,?)', [leadId, 'CONTACTED', '今日行动完成首触', now])
    }
  })
  salesDbService.todoUpdate(Number(taskId), { status: 'done' })
  return true
}

/** 今日行动跳过 SLA 卡：卡标 skipped，线索保持 NEW（下次扫描超时仍提醒） */
export function skipLeadFirstContact(taskId: number): boolean {
  const task = salesDbService.getTask(Number(taskId))
  if (!task || task.trigger_type !== 'sla_lead') return false
  salesDbService.todoUpdate(Number(taskId), { status: 'skipped' })
  return true
}
