/**
 * crmLeadService.ts —— 单机线索流转模块装配层
 * 导入（Excel/文本/单条表单）→ 清洗去重落库 → SLA 扫描/今日行动 → 首触闭环 → 转客户。
 * 表分布：lead/lead_activity/import_batch 在 crmDb（weflow-crm.db）；
 *         follow_up_task（SLA 卡）在 salesDb（weflow-sales.db）。
 * 跨库铁律：先 crmDb 后 salesDb + 扫描自愈（两库独立 sql.js 连接，无法单事务）。
 */
import { crmDbService, type CrmRow , type CrmWriteTx } from './crmDbService'
import { salesDbService } from './salesDbService'
import { classifyLead, dedupeRows, maskContact, identityKeysOf, normalizeCnMobile, normalizeWechat, type ParsedLead, type RawLeadRow } from './crmLeadImportCore'
import { recordOutboxTx } from './crmOutboxService'
import { getActorLabel, getIdentity } from './identityService'
import { LEAD_SLA_UNASSIGNED_SENTINEL } from '../../shared/leadSla'
import { emitAssignmentInvalidated } from './assignmentInvalidationBus'

// ─── 配置注入（registerCrmIpcHandlers 装配）─────────────────────────────────
export interface LeadConfigRef { get: (key: string) => unknown }
let configRef: LeadConfigRef | null = null
export function setLeadConfig(ref: LeadConfigRef): void { configRef = ref }

export const DEFAULT_DEAD_REASONS = ['号码无效', '重复留资', '明确不要', '同行', '非目标客户', '已购车', '联系不上', '其他']

// ─── 导入 ───────────────────────────────────────────────────────────────────
export interface ImportResult {
  batchId: number
  total: number
  valid: number
  /** 查重拦截总数（同批 + 线索池已有 + 正式客户已有 + 冲突，兼容旧字段口径） */
  duplicate: number
  invalid: number
  /** 无效行的原始行号（0 基） */
  invalidIndexes: number[]
  /** 分类计数（2026-09-08 查重完善） */
  dupSameBatch: number
  dupExistingLead: number
  dupExistingCustomer: number
  /** 双标识冲突（手机号命中甲、微信号命中乙）：标冲突待人工确认，不自动合并 */
  conflicts: number
}

/** 导入查重明细行（脱敏后落审计、可导出 CSV 复核） */
export interface ImportDedupeDetailRow {
  /** 原始行号（0 基） */
  line: number
  verdict: 'inserted' | 'duplicate' | 'existing_lead' | 'existing_customer' | 'conflict' | 'invalid'
  reason: string
  phoneMasked: string
  wechatMasked: string
  name: string
  matchedLeadId?: number
  matchedAccountId?: number
}

/** 读取某批次的查重明细（来源 = lead_import_dedupe 审计行，脱敏后入库，可直接展示/导出） */
export function getImportDedupeDetail(batchId: number): { ok: boolean; rows: ImportDedupeDetailRow[] } {
  const id = Number(batchId)
  if (!Number.isInteger(id) || id <= 0) return { ok: false, rows: [] }
  const hit = crmDbService.all(
    "SELECT detail FROM audit_event WHERE action = 'lead_import_dedupe' AND entity_type = 'import_batch' AND entity_id = ? ORDER BY id DESC LIMIT 1",
    [id]
  )[0]
  if (!hit) return { ok: false, rows: [] }
  try {
    const j = JSON.parse(String(hit.detail || '{}'))
    return { ok: true, rows: Array.isArray(j.rows) ? j.rows as ImportDedupeDetailRow[] : [] }
  } catch {
    return { ok: false, rows: [] }
  }
}

/** 联系方式脱敏（导入查重明细/通知均用）：手机号 138****5678 / 微信号 ab***c */
function maskLeadContact(contactType: string, contactNormalized: string): string {
  return maskContact({ contactType: (contactType === 'wechat' ? 'wechat' : contactType === 'both' ? 'both' : 'phone') as 'phone' | 'wechat' | 'both', contactNormalized: String(contactNormalized || '') })
}

/**
 * 批量导入（2026-09-08 查重完善 + SLA 哨兵修正）：
 *   清洗 → 同批跨 contactType 查重 → 库内查重（手机号/微信号双标识分别跨类型查重：
 *   线索池已有 / 正式客户已有 / 双标识分属不同联系人 = 冲突待人工，不自动合并）→ 事务落库。
 *   新导入且尚未分配的线索 first_contact_deadline 写 LEAD_SLA_UNASSIGNED_SENTINEL（待分配不起计时，
 *   与 shared/leadSla.ts 哨兵约定一致；分配（assignLeads）后才写真实 SLA1 期限）。
 *   查重明细（脱敏）落 lead_import_dedupe 审计行，供结果展示与 CSV 导出复核。
 */
export function importLeads(source: string, fileName: string, rows: RawLeadRow[]): ImportResult {
  const src = String(source || '').trim() || '自定义'
  const parsed = rows.map((r) => classifyLead({ ...r, source: src }))
  const dedupe = dedupeRows(parsed)
  const now = Date.now()
  let valid = 0
  let dupSameBatch = dedupe.duplicateCount
  let dupExistingLead = 0
  let dupExistingCustomer = 0
  let conflicts = 0
  const invalidSet = new Set(dedupe.invalidIndexes)
  for (const d of dedupe.duplicates) invalidSet.add(d.index)
  const detailRows: ImportDedupeDetailRow[] = []
  const maskOf = (p: ParsedLead): { phoneMasked: string; wechatMasked: string } => {
    const keys = identityKeysOf(p)
    return {
      phoneMasked: keys.phone ? maskLeadContact('phone', keys.phone) : '',
      wechatMasked: keys.wechat ? maskLeadContact('wechat', keys.wechat) : ''
    }
  }
  for (let i = 0; i < parsed.length; i++) {
    const p = parsed[i]
    if (!p) { detailRows.push({ line: i, verdict: 'invalid', reason: '无法识别手机号/微信号', phoneMasked: '', wechatMasked: '', name: String((rows[i] || {}).name || '') }); continue }
    const m = maskOf(p)
    if (dedupe.duplicates.some((d) => d.index === i)) {
      const reason = dedupe.duplicates.find((d) => d.index === i)!.reason
      detailRows.push({ line: i, verdict: 'duplicate', reason, ...m, name: p.name })
      continue
    }
    detailRows.push({ line: i, verdict: 'inserted', reason: '', ...m, name: p.name })
  }

  const batchId = crmDbService.runTx((tx) => {
    // 先建批次行拿 id——lead.import_batch_id 逐行回填用（宪法 §3 登记列，写者=importLeads 单点）；
    // 批次计数在插入完成后一次性 UPDATE（同事务，外部只见最终值）
    const batchId = tx.run(
      'INSERT INTO import_batch (source, file_name, total, valid, duplicate, invalid, created_at) VALUES (?,?,?,?,?,?,?)',
      [src, String(fileName || '粘贴文本'), rows.length, 0, dupSameBatch, dedupe.invalidCount, now]
    )
    for (let i = 0; i < parsed.length; i++) {
      const p = parsed[i]
      const row = detailRows[i]
      if (!p || !row) continue
      if (row.verdict !== 'inserted') continue
      const keys = identityKeysOf(p)
      // 库内查重（双标识分别跨 contactType）：先正式客户（已有客户不能再次进入线索池），
      // 再线索池；手机号与微信号命中不同联系人 = 冲突待人工，不自动合并、不插入
      let phoneLeadId = 0
      let wechatLeadId = 0
      let accountId = 0
      if (keys.phone) {
        phoneLeadId = Number(tx.all("SELECT id FROM lead WHERE contact_type IN ('phone','both') AND contact_normalized = ? ORDER BY id DESC LIMIT 1", [keys.phone])[0]?.id || 0)
        accountId = Number(tx.all('SELECT id FROM account WHERE phone = ? ORDER BY id DESC LIMIT 1', [keys.phone])[0]?.id || 0)
      }
      if (keys.wechat) {
        wechatLeadId = Number(tx.all("SELECT id FROM lead WHERE (contact_type = 'wechat' AND contact_normalized = ?) OR (contact_type = 'both' AND wechat = ?) ORDER BY id DESC LIMIT 1", [keys.wechat, keys.wechat])[0]?.id || 0)
        if (!accountId) {
          accountId = Number(tx.all("SELECT id FROM account WHERE custom_fields LIKE ? ORDER BY id DESC LIMIT 1", [`%\"wxid\":\"${keys.wechat}\"%`])[0]?.id || 0)
        }
      }
      if (phoneLeadId && wechatLeadId && phoneLeadId !== wechatLeadId) {
        row.verdict = 'conflict'
        row.reason = `双标识冲突：手机号命中线索 #${phoneLeadId}，微信号命中线索 #${wechatLeadId}，待人工确认`
        row.matchedLeadId = phoneLeadId
        conflicts++
        continue
      }
      if (accountId) {
        row.verdict = 'existing_customer'
        row.reason = `正式客户已有（account #${accountId}），不再次进入线索池`
        row.matchedAccountId = accountId
        dupExistingCustomer++
        continue
      }
      const hitLeadId = phoneLeadId || wechatLeadId
      if (hitLeadId) {
        row.verdict = 'existing_lead'
        row.reason = `线索池已有（lead #${hitLeadId}，${keys.phone && phoneLeadId ? '手机号命中' : '微信号命中'}）`
        row.matchedLeadId = hitLeadId
        dupExistingLead++
        continue
      }
      try {
        const id = tx.run(
          `INSERT INTO lead (contact_type, contact_normalized, contact_raw, wechat, source, name, tag, note,
           status, first_contact_deadline, created_at, updated_at, import_batch_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [p.contactType, p.contactNormalized, p.contactRaw, p.wechat, src, p.name, p.tag, p.note, 'NEW', LEAD_SLA_UNASSIGNED_SENTINEL, now, now, batchId]
        )
        tx.run('INSERT INTO lead_activity (lead_id, action, note, created_at) VALUES (?,?,?,?)', [id, 'IMPORTED', `来源：${src}`, now])
        valid++
      } catch {
        // UNIQUE (contact_type, contact_normalized) 兜底（理论上库内查重已拦截）= 线索池已有
        row.verdict = 'existing_lead'
        row.reason = '线索池已有（唯一索引拦截）'
        dupExistingLead++
      }
    }
    const duplicate = dupSameBatch + dupExistingLead + dupExistingCustomer + conflicts
    tx.run('UPDATE import_batch SET valid = ?, duplicate = ? WHERE id = ?', [valid, duplicate, batchId])
    // 资源导入审计（设计稿屏 2 蓝色横幅数据源；宪法 §1.12 统一流水；append-only）
    tx.run('INSERT INTO audit_event (actor, action, entity_type, entity_id, detail, created_at) VALUES (?,?,?,?,?,?)',
      [getIdentity()?.name || '分配员', 'lead_import', 'lead', null,
       JSON.stringify({ batchId: Number(batchId), source: src, fileName: String(fileName || '粘贴文本'), total: rows.length, valid, duplicate, invalid: dedupe.invalidCount, dupSameBatch, dupExistingLead, dupExistingCustomer, conflicts }), now])
    // 查重明细审计（脱敏后入库，供结果展示与 CSV 导出复核；同事务保证批次可追溯）
    tx.run('INSERT INTO audit_event (actor, action, entity_type, entity_id, detail, created_at) VALUES (?,?,?,?,?,?)',
      [getIdentity()?.name || '分配员', 'lead_import_dedupe', 'import_batch', Number(batchId),
       JSON.stringify({ batchId: Number(batchId), rows: detailRows }), now])
    // 只有真正插入了线索行才标记（整批重复/冲突 = 无数据变化 = 不失效）
    if (valid > 0) tx.markAnnualReviewChanged('crm:lead')
    return batchId
  })

  scanLeadSla()
  const duplicate = dupSameBatch + dupExistingLead + dupExistingCustomer + conflicts
  return {
    batchId, total: rows.length, valid, duplicate, invalid: dedupe.invalidCount, invalidIndexes: dedupe.invalidIndexes,
    dupSameBatch, dupExistingLead, dupExistingCustomer, conflicts
  }
}

// ─── 单条录入 + 查重面板 + 历史分配导入（2026-09-19，宪法 §1.4/§3 登记行）─────────────────
/**
 * checkLeadDuplicate：手机号/微信号双标识跨 contact_type 实时查重（与 importLeads 库内查重同口径：
 * 先正式客户后线索池；双标识命中不同联系人 = conflict 待人工）。命中返回线索当前归属 + assignment
 * 历史（1:N：谁/何时/怎么结束的），前端查重面板强制三选一（联系原销售/走移交/复购归并）——
 * 三者都**不建新线索**。
 * createLead：服务端硬拒收重复（E201，即使前端被绕过也建不进去，UNIQUE 索引再兜一层）；
 * wx_nickname 填手机号时必填（2026-09-19 用户拍板），只作绑定弹窗人工核对锚点，永不参与自动
 * 好友判定（宪法 §2.4 铁律不变）；qr_path 存图不解析。
 * 新线索 first_contact_deadline = LEAD_SLA_UNASSIGNED_SENTINEL（入池不起计时，分配才起算，与导入同口径）。
 * 角色可见性 = UI 门禁（!salesView，与「导入线索」按钮同口径；宪法 §1.12 角色仅署名，本地不新增强拦截）。
 */
export interface LeadDupAssignmentRow {
  id: number
  salesName: string
  mode: string
  status: string
  assignedAt: number
  sla1Stopped: boolean
}
export interface LeadDuplicateDetail {
  kind: 'lead' | 'customer' | 'conflict'
  contactMasked: string
  leadId?: number
  accountId?: number
  status?: string
  source?: string
  currentOwner?: string
  assignments: LeadDupAssignmentRow[]
  message: string
}
export interface LeadDupCheckResult { duplicate: boolean; detail: LeadDuplicateDetail | null }

/** 表单联系方式归一化与格式校验（业务规则：大陆手机号；微信号 6-20 位字母开头，同 crmLeadImportCore 识别口径） */
function normalizeLeadContactInput(phone?: string, wechat?: string): { phone: string; wechat: string; error: string } {
  const rawPhone = String(phone || '').trim()
  const rawWechat = String(wechat || '').trim()
  const p = rawPhone ? normalizeCnMobile(rawPhone) : ''
  const w = rawWechat ? normalizeWechat(rawWechat) : ''
  if (rawPhone && !/^1[3-9]\d{9}$/.test(p)) return { phone: '', wechat: '', error: '手机号格式无效：需大陆手机号（1 开头 11 位）' }
  if (rawWechat && !/^[A-Za-z][A-Za-z0-9_-]{5,19}$/.test(w)) return { phone: '', wechat: '', error: '微信号格式无效：6-20 位、字母开头（微信官方规则）' }
  return { phone: p, wechat: w, error: '' }
}

/** 双标识库内查重（与 importLeads 库内查重同一 SQL 口径：手机号匹配 phone/both 的 normalized；微信号匹配 wechat 行或 both.wechat 列） */
function lookupLeadDup(tx: { all: (sql: string, params?: unknown[]) => CrmRow[] }, q: { phone: string; wechat: string }): { phoneLeadId: number; wechatLeadId: number; accountId: number } {
  let phoneLeadId = 0
  let wechatLeadId = 0
  let accountId = 0
  if (q.phone) {
    phoneLeadId = Number(tx.all("SELECT id FROM lead WHERE contact_type IN ('phone','both') AND contact_normalized = ? ORDER BY id DESC LIMIT 1", [q.phone])[0]?.id || 0)
    accountId = Number(tx.all('SELECT id FROM account WHERE phone = ? ORDER BY id DESC LIMIT 1', [q.phone])[0]?.id || 0)
  }
  if (q.wechat) {
    wechatLeadId = Number(tx.all("SELECT id FROM lead WHERE (contact_type = 'wechat' AND contact_normalized = ?) OR (contact_type = 'both' AND wechat = ?) ORDER BY id DESC LIMIT 1", [q.wechat, q.wechat])[0]?.id || 0)
    if (!accountId) accountId = Number(tx.all("SELECT id FROM account WHERE custom_fields LIKE ? ORDER BY id DESC LIMIT 1", [`%\"wxid\":\"${q.wechat}\"%`])[0]?.id || 0)
  }
  return { phoneLeadId, wechatLeadId, accountId }
}

function assignmentHistoryOf(leadId: number): LeadDupAssignmentRow[] {
  return crmDbService.all(
    'SELECT id, sales_name, mode, status, updated_at, sla1_met_at FROM assignment WHERE lead_id = ? AND deleted = 0 ORDER BY id DESC LIMIT 10',
    [leadId]
  ).map((r) => ({
    id: Number(r.id),
    salesName: String(r.sales_name || ''),
    mode: String(r.mode || ''),
    status: String(r.status || ''),
    assignedAt: Number(r.updated_at || 0),
    sla1Stopped: Number(r.sla1_met_at || 0) > 0
  }))
}

export function checkLeadDuplicate(input: { phone?: string; wechat?: string }): LeadDupCheckResult {
  const q = normalizeLeadContactInput(input?.phone, input?.wechat)
  if (q.error || (!q.phone && !q.wechat)) return { duplicate: false, detail: null }
  const { phoneLeadId, wechatLeadId, accountId } = lookupLeadDup(crmDbService, q)
  if (phoneLeadId && wechatLeadId && phoneLeadId !== wechatLeadId) {
    return { duplicate: true, detail: {
      kind: 'conflict', contactMasked: maskContact({ contactType: 'phone', contactNormalized: q.phone || q.wechat }),
      message: `双标识冲突：手机号命中线索 #${phoneLeadId}、微信号命中线索 #${wechatLeadId}，待人工确认，请先联系原归属人核对`,
      assignments: []
    } }
  }
  if (accountId) {
    return { duplicate: true, detail: {
      kind: 'customer', accountId, contactMasked: maskContact({ contactType: q.phone ? 'phone' : 'wechat', contactNormalized: q.phone || q.wechat }),
      message: `已是正式客户（account #${accountId}）——复购请走客户页复购归并，不新建线索`,
      assignments: []
    } }
  }
  const hitLeadId = phoneLeadId || wechatLeadId
  if (!hitLeadId) return { duplicate: false, detail: null }
  const lead = crmDbService.all('SELECT id, status, source FROM lead WHERE id = ?', [hitLeadId])[0]
  const assignments = assignmentHistoryOf(hitLeadId)
  const active = assignments.find((a) => a.status === 'assigned' || a.status === 'claimed')
  return { duplicate: true, detail: {
    kind: 'lead', leadId: hitLeadId,
    contactMasked: maskContact({ contactType: (q.phone && phoneLeadId) ? 'phone' : 'wechat', contactNormalized: (q.phone && phoneLeadId) ? q.phone : q.wechat }),
    status: String(lead?.status || ''), source: String(lead?.source || ''),
    currentOwner: active?.salesName || '',
    assignments,
    message: active
      ? `该联系方式已在线索池（lead #${hitLeadId}），当前归属：${active.salesName}`
      : `该联系方式已在线索池（lead #${hitLeadId}，资源池待分配）`
  } }
}

export interface CreateLeadInput { source?: string; phone?: string; wechat?: string; wxNickname?: string; qrPath?: string; note?: string }
export type CreateLeadResult =
  | { ok: true; data: { leadId: number } }
  | { ok: false; code: 'E101' | 'E201'; message: string; duplicate?: LeadDuplicateDetail }

export function createLead(input: CreateLeadInput): CreateLeadResult {
  const src = String(input?.source || '').trim()
  if (!src) return { ok: false, code: 'E101', message: '渠道来源必填' }
  const q = normalizeLeadContactInput(input?.phone, input?.wechat)
  if (q.error) return { ok: false, code: 'E101', message: q.error }
  if (!q.phone && !q.wechat) return { ok: false, code: 'E101', message: '手机号 / 微信号至少填一项（二选一，可都填）' }
  const nick = String(input?.wxNickname || '').trim()
  if (q.phone && !nick) return { ok: false, code: 'E101', message: '填了手机号必须同步填写微信昵称（加好友人工核对用）' }
  if (nick.length > 64) return { ok: false, code: 'E101', message: '微信昵称过长（≤64 字）' }
  const qrPath = String(input?.qrPath || '').trim()
  const note = String(input?.note || '').trim()
  const now = Date.now()
  const contactType = q.phone && q.wechat ? 'both' : q.phone ? 'phone' : 'wechat'
  const contactNormalized = q.phone || q.wechat
  const contactRaw = [q.phone, q.wechat].filter(Boolean).join(' ')
  const leadWechat = contactType === 'both' ? q.wechat : ''

  const dup = checkLeadDuplicate({ phone: q.phone || undefined, wechat: q.wechat || undefined })
  if (dup.duplicate && dup.detail) return { ok: false, code: 'E201', message: dup.detail.message, duplicate: dup.detail }

  try {
    const leadId = crmDbService.runTx((tx) => {
      const id = tx.run(
        `INSERT INTO lead (contact_type, contact_normalized, contact_raw, wechat, source, name, note, status, first_contact_deadline, wx_nickname, qr_path, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [contactType, contactNormalized, contactRaw, leadWechat, src, '', note, 'NEW', LEAD_SLA_UNASSIGNED_SENTINEL, nick, qrPath, now, now]
      )
      tx.markAnnualReviewChanged('crm:lead') // 新建 lead 行成功（本路径必然插入）
      tx.run('INSERT INTO lead_activity (lead_id, action, note, created_at) VALUES (?,?,?,?)',
        [id, 'CREATED', `单条录入：渠道 ${src}${qrPath ? '，含微信二维码' : ''}`, now])
      tx.run('INSERT INTO audit_event (actor, action, entity_type, entity_id, detail, created_at) VALUES (?,?,?,?,?,?)',
        [getActorLabel() || '分配员', 'lead_create', 'lead', id,
         JSON.stringify({ source: src, contactMasked: maskContact({ contactType, contactNormalized }), hasQr: Boolean(qrPath) }), now])
      return id
    })
    scanLeadSla()
    return { ok: true, data: { leadId } }
  } catch {
    // UNIQUE (contact_type, contact_normalized) 兜底（理论上查重已拦截）
    return { ok: false, code: 'E201', message: '线索池已有该联系方式（唯一索引拦截）' }
  }
}

export interface HistoricalAssignmentInput {
  contactType?: string
  contactValue?: string
  sales?: string
  assignedAt?: string | number
  endState?: string
  source?: string
  note?: string
}
export interface HistoricalImportSkipped { line: number; contactMasked: string; reason: string }
export interface HistoricalImportResult {
  total: number
  leadsCreated: number
  leadsReused: number
  assignmentsCreated: number
  recycled: number
  skipped: HistoricalImportSkipped[]
}

const HISTORY_SOURCE = '历史导入'

/**
 * 历史分配导入（宪法 §3 登记行，assignment 第 4 类写入者）：升级前的历史客户分配事实回填。
 * 每行写 assignment（status=claimed/recycled；⚠️ 铁律：`sla1_deadline` 强制 2100 哨兵——
 * 历史行永不参与 SLA 计时，leadSla.ts 2026-09-03 存量超时事故预防）+ ownership_history
 * （仅 active 行且归属变化）+ lead_activity（ASSIGN_HISTORY 时间线）+ audit_event 批次汇总。
 * 线索不存在时新建 lead（查重口径同 importLeads；created_at = 历史分配时间）；幂等：active 行
 * 命中「已归属同一销售」跳过。
 */
export function importHistoricalAssignments(fileName: string, rows: HistoricalAssignmentInput[]): HistoricalImportResult {
  const now = Date.now()
  const skipped: HistoricalImportSkipped[] = []
  const valid: Array<{ contactType: 'phone' | 'wechat'; normalized: string; sales: string; assignedAt: number; recycled: boolean; source: string; note: string }> = []
  rows.forEach((r, i) => {
    const type = String(r?.contactType || '').trim().toLowerCase() === 'wechat' ? 'wechat' : 'phone'
    const rawValue = String(r?.contactValue || '').trim()
    const normalized = type === 'phone' ? normalizeCnMobile(rawValue) : normalizeWechat(rawValue)
    const maskedOf = () => maskContact({ contactType: type, contactNormalized: normalized || '?' })
    if (!rawValue || (type === 'phone' && !/^1[3-9]\d{9}$/.test(normalized)) || (type === 'wechat' && !/^[A-Za-z][A-Za-z0-9_-]{5,19}$/.test(normalized))) {
      skipped.push({ line: i + 1, contactMasked: maskedOf(), reason: '联系方式缺失或格式无效' }); return
    }
    const sales = String(r?.sales || '').trim()
    if (!sales) { skipped.push({ line: i + 1, contactMasked: maskedOf(), reason: '缺少销售姓名' }); return }
    const ts = typeof r?.assignedAt === 'number' ? r.assignedAt : Date.parse(String(r?.assignedAt || '').trim().replace(/-/g, '/'))
    if (!Number.isFinite(ts) || ts <= 0) { skipped.push({ line: i + 1, contactMasked: maskedOf(), reason: '缺少或无法解析分配时间（YYYY-MM-DD）' }); return }
    const end = String(r?.endState || '').trim().toLowerCase()
    if (end && end !== 'active' && end !== 'recycled') {
      skipped.push({ line: i + 1, contactMasked: maskedOf(), reason: `结束状态仅支持 active/recycled/空，收到「${end}」` }); return
    }
    valid.push({ contactType: type, normalized, sales, assignedAt: ts, recycled: end === 'recycled', source: String(r?.source || '').trim() || HISTORY_SOURCE, note: String(r?.note || '').trim() })
  })

  let leadsCreated = 0
  let leadsReused = 0
  let assignmentsCreated = 0
  let recycledCount = 0
  const touchedLeadIds: number[] = []
  if (valid.length) {
    crmDbService.runTx((tx) => {
      for (const v of valid) {
        const { phoneLeadId, wechatLeadId, accountId } = lookupLeadDup(tx, v.contactType === 'phone' ? { phone: v.normalized, wechat: '' } : { phone: '', wechat: v.normalized })
        const masked = maskContact({ contactType: v.contactType, contactNormalized: v.normalized })
        if (accountId) { skipped.push({ line: 0, contactMasked: masked, reason: `正式客户已有（account #${accountId}），历史分配不回填` }); continue }
        if (phoneLeadId && wechatLeadId && phoneLeadId !== wechatLeadId) {
          skipped.push({ line: 0, contactMasked: masked, reason: `双标识冲突（lead #${phoneLeadId} / #${wechatLeadId}），待人工` }); continue
        }
        let leadId = phoneLeadId || wechatLeadId
        if (leadId) leadsReused++
        else {
          leadId = tx.run(
            `INSERT INTO lead (contact_type, contact_normalized, contact_raw, wechat, source, name, note, status, first_contact_deadline, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
            [v.contactType, v.normalized, v.normalized, '', v.source, '', v.note, 'NEW', LEAD_SLA_UNASSIGNED_SENTINEL, v.assignedAt, now]
          )
          tx.run('INSERT INTO lead_activity (lead_id, action, note, created_at) VALUES (?,?,?,?)', [leadId, 'IMPORTED_HISTORY', `历史导入：来源 ${v.source}`, now])
          leadsCreated++
        }
        const prevOwner = String(tx.all("SELECT sales_name FROM assignment WHERE lead_id = ? AND status IN ('assigned','claimed') AND deleted = 0 ORDER BY id DESC LIMIT 1", [leadId])[0]?.sales_name || '')
        if (!v.recycled && prevOwner === v.sales) {
          skipped.push({ line: 0, contactMasked: masked, reason: `lead #${leadId} 已归属 ${v.sales}，跳过重复行` }); continue
        }
        if (v.recycled && Number(tx.all("SELECT id FROM assignment WHERE lead_id = ? AND sales_name = ? AND status = 'recycled' AND deleted = 0 LIMIT 1", [leadId, v.sales])[0]?.id || 0) > 0) {
          skipped.push({ line: 0, contactMasked: masked, reason: `lead #${leadId} 的历史回收行已存在（${v.sales}），跳过` }); continue
        }
        // ⚠️ 铁律：sla1_deadline 强制 2100 哨兵——历史行绝不参与 SLA 计时（recycler 只扫过期未停表行）
        const aid = tx.run(
          'INSERT INTO assignment (lead_id, sales_name, mode, sla1_deadline, claimed_at, status, source, updated_by, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
          [leadId, v.sales, 'manual', LEAD_SLA_UNASSIGNED_SENTINEL, v.recycled ? null : v.assignedAt, v.recycled ? 'recycled' : 'claimed', HISTORY_SOURCE, getActorLabel() || '分配员', v.assignedAt]
        )
        assignmentsCreated++
        if (v.recycled) recycledCount++
        else {
          touchedLeadIds.push(leadId)
          tx.run('INSERT INTO ownership_history (entity_type, entity_id, old_owner, new_owner, reason, actor, created_at) VALUES (?,?,?,?,?,?,?)',
            ['assignment', aid, prevOwner, v.sales, '历史导入', getActorLabel() || '分配员', now])
        }
        tx.run('INSERT INTO lead_activity (lead_id, action, note, created_at) VALUES (?,?,?,?)',
          [leadId, 'ASSIGN_HISTORY', `历史分配：${v.sales}（${new Date(v.assignedAt).toISOString().slice(0, 10)}）${v.recycled ? '，已回收' : ''}`, now])
      }
      // 只有真正新建了 lead / assignment 行才标记（全部 skipped = 无数据变化 = 不失效）
      if (leadsCreated > 0) tx.markAnnualReviewChanged('crm:lead')
      if (assignmentsCreated > 0) tx.markAnnualReviewChanged('crm:assignment')
      tx.run('INSERT INTO audit_event (actor, action, entity_type, entity_id, detail, created_at) VALUES (?,?,?,?,?,?)',
        [getActorLabel() || '分配员', 'assignment_history_import', 'lead', null,
         JSON.stringify({ fileName: String(fileName || '粘贴文本'), total: rows.length, valid: valid.length, leadsCreated, leadsReused, assignmentsCreated, recycled: recycledCount, skipped: skipped.length }), now])
    })
    // 事务已提交才通知：历史导入会新建 claimed 态的**当前有效**归属行（recycled 历史行不改当前归属，不通知）
    if (touchedLeadIds.length) emitAssignmentInvalidated('assign', touchedLeadIds)
  }
  scanLeadSla()
  return { total: rows.length, leadsCreated, leadsReused, assignmentsCreated, recycled: recycledCount, skipped }
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
        tx.markAnnualReviewChangedIfWrote('crm:lead')
        tx.run('INSERT INTO lead_activity (lead_id, action, note, created_at) VALUES (?,?,?,?)', [id, 'WX_ADDED', `已添加微信：${wechat}`, now])
      } else {
        tx.run("UPDATE lead SET status = 'WX_ADDED', updated_at = ? WHERE id = ?", [now, id])
        tx.markAnnualReviewChangedIfWrote('crm:lead')
        tx.run('INSERT INTO lead_activity (lead_id, action, note, created_at) VALUES (?,?,?,?)', [id, 'WX_ADDED', String(opts.note || '已添加微信'), now])
      }
    } else if (action === 'dead') {
      const reason = String(opts.reason || '').trim()
      tx.run('UPDATE lead SET status = ?, dead_reason = ?, updated_at = ? WHERE id = ?', ['DEAD', reason, now, id])
      tx.markAnnualReviewChangedIfWrote('crm:lead')
      tx.run('INSERT INTO lead_activity (lead_id, action, note, created_at) VALUES (?,?,?,?)', [id, 'DEAD', `死因：${reason}`, now])
    } else if (action === 'reopen') {
      tx.run("UPDATE lead SET status = 'NEW', dead_reason = '', updated_at = ? WHERE id = ?", [now, id])
      tx.markAnnualReviewChangedIfWrote('crm:lead')
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
    tx.markAnnualReviewChangedIfWrote('crm:lead')
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
      tx.markAnnualReviewChanged('crm:account') // 新建正式客户 → A/C 组客户结构变化
    }
    tx.run('UPDATE lead SET status = ?, account_id = ?, updated_at = ? WHERE id = ?', ['ACCOUNT', accountId, now, id])
    tx.markAnnualReviewChangedIfWrote('crm:lead')
    tx.run('INSERT INTO lead_activity (lead_id, action, note, created_at) VALUES (?,?,?,?)', [id, 'TO_ACCOUNT', existed ? `关联已有客户 #${accountId}` : `新建客户 #${accountId}`, now])
    return { accountId, existed }
  })

  return { ok: true, accountId: result.accountId, existed: result.existed }
}

// ─── 首触 SLA 扫描 + 闭环 ───────────────────────────────────────────────────
/**
 * 扫描超时 NEW 线索 → 建 SLA 卡（应用层幂等 + partial unique index 双兜底）；随后自愈脏卡。
 * 未分配线索（first_contact_deadline = LEAD_SLA_UNASSIGNED_SENTINEL，2100 哨兵）天然不满足
 * `first_contact_deadline < now`，不会产生 SLA 超时任务——SLA1 只从分配（assignment）起算（宪法 §1.3）。
 */
export function scanLeadSla(): number {
  const now = Date.now()
  const overdue = crmDbService.all("SELECT * FROM lead WHERE status = 'NEW' AND first_contact_deadline < ? AND first_contact_deadline < ?", [now, LEAD_SLA_UNASSIGNED_SENTINEL])
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
      tx.markAnnualReviewChangedIfWrote('crm:lead')
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
  // ⛔ 2026-09-04 修复：必须排除已有有效分配（assigned/claimed）的 lead——
  // 分配后 first_contact_deadline = assignment.sla1_deadline 是在计时状态（assignLeads 同步），
  // 本函数每次启动都跑，不排除会把 3,800+ 条已分配线索的期限打回哨兵（live 已发生）。
  const NO_ACTIVE_ASSIGNMENT = "AND NOT EXISTS (SELECT 1 FROM assignment a WHERE a.lead_id = lead.id AND a.deleted = 0 AND a.status IN ('assigned','claimed'))"
  const resetIds = crmDbService.runTx((tx) => {
    const rows = tx.all(`SELECT id FROM lead WHERE source = '群资源扫描' AND status = 'NEW' AND first_contact_deadline <> ? ${NO_ACTIVE_ASSIGNMENT}`, [LEAD_SLA_UNASSIGNED_SENTINEL])
    if (!rows.length) return [] as number[]
    tx.run(`UPDATE lead SET first_contact_deadline = ?, updated_at = ? WHERE source = '群资源扫描' AND status = 'NEW' AND first_contact_deadline <> ? ${NO_ACTIVE_ASSIGNMENT}`, [LEAD_SLA_UNASSIGNED_SENTINEL, now, LEAD_SLA_UNASSIGNED_SENTINEL])
    tx.markAnnualReviewChangedIfWrote('crm:lead') // 命中 0 行（已全部对齐）时不标记
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
    // 只有确实清了 tag/note 的行才标记（命中 0 行 = 无数据变化 = 不失效）
    if (cleared > 0) tx.markAnnualReviewChanged('crm:lead')
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
