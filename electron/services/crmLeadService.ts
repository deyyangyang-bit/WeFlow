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
import { recordOutboxTx } from './crmOutboxService'
import { getActorLabel } from './identityService'
import { LEAD_SLA_UNASSIGNED_SENTINEL } from '../../shared/leadSla'

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
  /** 已加微信时填客户微信号/昵称（1.4a 手动绑定的过渡期载体，写 lead.wechat） */
  wechat?: string
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
      // outbox 登记（上行 first_touch 首触回执，同步设计 §3；key 按 lead 幂等——首触语义上只发生一次）
      recordOutboxTx(tx, 'first_touch', `first_touch:${id}`, {
        leadId: id, channel, at: now, actor: getActorLabel() || '销售',
        contactType: String(lead.contact_type || ''), contactNormalized: String(lead.contact_normalized || '')
      }, now)
    } else if (action === 'wx_added') {
      const wechat = String(opts.wechat || '').trim()
      if (wechat) {
        tx.run("UPDATE lead SET status = 'WX_ADDED', wechat = ?, updated_at = ? WHERE id = ?", [wechat, now, id])
        tx.run('INSERT INTO lead_activity (lead_id, action, note, created_at) VALUES (?,?,?,?)', [id, 'WX_ADDED', `已添加微信：${wechat}`, now])
      } else {
        tx.run("UPDATE lead SET status = 'WX_ADDED', updated_at = ? WHERE id = ?", [now, id])
        tx.run('INSERT INTO lead_activity (lead_id, action, note, created_at) VALUES (?,?,?,?)', [id, 'WX_ADDED', String(opts.note || '已添加微信'), now])
      }
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

// ─── 资料编辑（姓名 / 微信号·昵称，不动状态机）─────────────────────────────
/** 行内铅笔入口用：随时补填/修改姓名与微信号，状态不受影响；写 lead_activity 留痕 */
export function updateLeadProfile(leadId: number, fields: { name?: string; wechat?: string }): { ok: boolean; error?: string } {
  const id = Number(leadId)
  const lead = crmDbService.getById('lead', id)
  if (!lead) return { ok: false, error: '线索不存在' }
  const name = String(fields.name ?? lead.name ?? '').trim()
  const wechat = String(fields.wechat ?? lead.wechat ?? '').trim()
  const changed: string[] = []
  if (name !== String(lead.name || '')) changed.push(`姓名：${lead.name || '（空）'} → ${name || '（空）'}`)
  if (wechat !== String(lead.wechat || '')) changed.push(`微信：${lead.wechat || '（空）'} → ${wechat || '（空）'}`)
  if (!changed.length) return { ok: true }
  const now = Date.now()
  crmDbService.runTx((tx) => {
    tx.run('UPDATE lead SET name = ?, wechat = ?, updated_at = ? WHERE id = ?', [name, wechat, now, id])
    tx.run('INSERT INTO lead_activity (lead_id, action, note, created_at) VALUES (?,?,?,?)', [id, 'EDIT', changed.join('；'), now])
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
    const rows = tx.all('SELECT id, status, contact_type, contact_normalized FROM lead WHERE id = ?', [leadId])
    if (!rows.length) return
    if (rows[0].status === 'NEW') {
      tx.run('UPDATE lead SET status = ?, first_contacted_at = ?, updated_at = ? WHERE id = ?', ['CONTACTED', now, now, leadId])
      tx.run('INSERT INTO lead_activity (lead_id, action, note, created_at) VALUES (?,?,?,?)', [leadId, 'CONTACTED', '今日行动完成首触', now])
      // outbox 登记（上行 first_touch；与 updateLeadStatus 同 key，先登记者生效、后到者幂等吞掉）
      recordOutboxTx(tx, 'first_touch', `first_touch:${leadId}`, {
        leadId, channel: '', at: now, actor: getActorLabel() || '销售',
        contactType: String(rows[0].contact_type || ''), contactNormalized: String(rows[0].contact_normalized || '')
      }, now)
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

// ─── 存量重置：群扫线索首触期限清零（2026-09-03 用户拍板「存量重置」）───────
/**
 * 决策 B 配套存量处置。群资源扫描导入的约 4,680 条线索，first_contact_deadline 在扫描
 * 导入日即被设置（导入即起计时），从未分配也无人该首触 → 全部超时 + sla_lead 卡刷屏
 * （5,551 张 pending，行动卡执行率被稀释到 0.6% 的主因）。
 * 处置：deadline 置 LEAD_SLA_UNASSIGNED_SENTINEL（NOT NULL 列不能置 NULL；哨兵 = 待分配、
 * 不起计时，不再超时、不再产新卡；Phase 1 分配上线后 SLA 从 assignment 起算，宪法 §1.3
 * 两段计时），存量 pending sla_lead 卡批量 skipped 关单，写 audit_event。
 * 天然幂等：二次执行命中 0 行直接返回。顺序守跨库铁律：先 crmDb 后 salesDb。
 */
export function resetLegacyGroupScanSla(): { leads: number; cards: number } {
  const now = Date.now()
  const resetIds = crmDbService.runTx((tx) => {
    const rows = tx.all("SELECT id FROM lead WHERE source = '群资源扫描' AND status = 'NEW' AND first_contact_deadline <> ?", [LEAD_SLA_UNASSIGNED_SENTINEL])
    if (!rows.length) return [] as number[]
    tx.run("UPDATE lead SET first_contact_deadline = ?, updated_at = ? WHERE source = '群资源扫描' AND status = 'NEW' AND first_contact_deadline <> ?", [LEAD_SLA_UNASSIGNED_SENTINEL, now, LEAD_SLA_UNASSIGNED_SENTINEL])
    return rows.map((r) => Number(r.id))
  })

  // 卡关单不随 resetIds 空而短路：孤儿卡（source_id 指向已不存在的 lead）每次启动都要扫
  const idSet = new Set(resetIds)
  let cards = 0
  for (const t of salesDbService.todoList({ status: 'pending', limit: 100000 })) {
    if (t.trigger_type !== 'sla_lead' || !t.source_id || !t.id) continue
    // 关单两类：① 被重置群扫线索的卡；② 孤儿卡（source_id 指向已不存在的 lead——历史重复
    // 建卡前科，真实库实测 872 张，留着永远挂在今日行动里）
    const orphan = !idSet.has(Number(t.source_id)) && !crmDbService.getById('lead', Number(t.source_id))
    if (idSet.has(Number(t.source_id)) || orphan) { salesDbService.todoUpdate(t.id, { status: 'skipped' }); cards++ }
  }
  if (!resetIds.length) {
    if (cards > 0) console.log(`[CRM] SLA 孤儿卡清扫：${cards} 张`)
    return { leads: 0, cards }
  }
  // 审计留痕（宪法 §1.12：新审计写点一律 audit_event；失败不阻塞重置本体）
  try {
    crmDbService.create('audit_event', {
      actor: 'system:migration', action: 'lead_sla_stock_reset', entity_type: 'lead', entity_id: 0,
      detail: JSON.stringify({ leads: resetIds.length, cardsClosed: cards, reason: '决策B存量处置：群扫线索首触期限清零，Phase 1 起 SLA 从分配（assignment）起算' }),
      created_at: now
    })
  } catch (e) { console.warn('[CRM] 存量重置审计写入失败（不阻塞）:', e) }
  console.log(`[CRM] 群扫存量 SLA 重置：${resetIds.length} 条线索首触期限清零，${cards} 张 SLA 卡关单`)
  return { leads: resetIds.length, cards }
}

// ─── 存量处置：群扫线索 tag 归属清理（宪法 §4.2 决策B，2026-09-03 用户当面拍板执行）───
/**
 * 群扫时代的 tag 列被当作「归属销售」用（秒变/李林辉/杨青/静候/未分配），群扫下线后
 * 归属改由 assignment 承载（宪法 §1.3：分配状态不放 lead），旧 tag 残留与新归属筛选
 * 同名打架。处置：tag='未分配' 直接清空不留痕；其余 tag 值挪进 note 留痕
 * （`曾归属:{tag}（YYYY-MM-DD）`，note 已含同值则只清 tag），同事务 UPDATE，
 * 写 audit_event。天然幂等：二次执行命中 0 行直接返回。
 */
export function cleanupLegacyGroupScanTags(): { cleared: number; noted: number } {
  const now = Date.now()
  const today = new Date(now).toISOString().slice(0, 10)
  const result = crmDbService.runTx((tx) => {
    const rows = tx.all("SELECT id, tag, note FROM lead WHERE source = '群资源扫描' AND tag IS NOT NULL AND tag <> ''", [])
    if (!rows.length) return { cleared: 0, noted: 0 }
    let cleared = 0, noted = 0
    for (const r of rows) {
      const id = Number(r.id)
      const tag = String(r.tag)
      const note = r.note == null ? '' : String(r.note)
      if (tag === '未分配') {
        tx.run("UPDATE lead SET tag = '', updated_at = ? WHERE id = ?", [now, id])
        cleared++
      } else {
        const marker = `曾归属:${tag}（${today}）`
        if (note.includes(`曾归属:${tag}`)) {
          tx.run("UPDATE lead SET tag = '', updated_at = ? WHERE id = ?", [now, id])
        } else {
          const newNote = note ? `${note}；${marker}` : marker
          tx.run("UPDATE lead SET tag = '', note = ?, updated_at = ? WHERE id = ?", [newNote, now, id])
        }
        cleared++; noted++
      }
    }
    return { cleared, noted }
  })
  if (!result.cleared) return result
  try {
    crmDbService.create('audit_event', {
      actor: 'system:migration', action: 'lead_tag_owner_cleanup', entity_type: 'lead', entity_id: 0,
      detail: JSON.stringify({ cleared: result.cleared, noted: result.noted, reason: '宪法 §4.2 决策B：群扫 tag 归属残留清理，归属改由 assignment 承载' }),
      created_at: now
    })
  } catch (e) { console.warn('[CRM] tag 清理审计写入失败（不阻塞）:', e) }
  console.log(`[CRM] 群扫存量 tag 归属清理：${result.cleared} 条清空（${result.noted} 条 note 留痕）`)
  return result
}
