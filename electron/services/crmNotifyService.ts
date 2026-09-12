/**
 * crmNotifyService.ts —— 主管升级提醒收件箱（notify_inbox 查询 + 已读标记）
 *
 * 主管通知落库唯一实现 = recordSupervisorNotificationTx；单机 SLA 回收和
 * lanSyncService.consumeSupervisorNotifications 都复用它，同事务写 notify_inbox + audit_event。
 * 本模块提供 UI 供数（资源分配管理页「升级提醒」列表）、已读标记和统一通知落库。
 * 幂等：notify_inbox.idempotency_key 唯一（表级约束），重复落地天然去重。
 */
import { crmDbService, type CrmRow } from './crmDbService'
import { maskContact } from './crmLeadImportCore'

export interface SupervisorNotificationTx {
  run: (sql: string, params?: unknown[]) => number
  all: (sql: string, params?: unknown[]) => CrmRow[]
}

export interface SupervisorNotificationInput {
  idempotencyKey: string
  leadId: number
  salesName: string
  remindCount: number
  reason: string
  recycledAt: number
  lead?: { contactType?: string; contactNormalized?: string }
}

function supervisorContact(tx: SupervisorNotificationTx, input: SupervisorNotificationInput): { contactType: 'phone' | 'wechat' | 'both'; contactNormalized: string } | null {
  const supplied = input.lead
  if (supplied && supplied.contactNormalized) {
    const contactType = supplied.contactType === 'wechat' || supplied.contactType === 'both' ? supplied.contactType : 'phone'
    return { contactType, contactNormalized: String(supplied.contactNormalized) }
  }
  const row = tx.all('SELECT contact_type, contact_normalized FROM lead WHERE id = ?', [Number(input.leadId)])[0]
  if (!row) return null
  const contactType = String(row.contact_type) === 'wechat' || String(row.contact_type) === 'both' ? String(row.contact_type) as 'wechat' | 'both' : 'phone'
  return { contactType, contactNormalized: String(row.contact_normalized || '') }
}

function fmtSupervisorTime(ts: number): string {
  const d = new Date(Number(ts) || 0)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 在调用方既有事务内幂等落地一条主管升级通知；返回本次是否新增。 */
export function recordSupervisorNotificationTx(
  tx: SupervisorNotificationTx,
  input: SupervisorNotificationInput,
  source: 'local:sla' | 'sync:down'
): boolean {
  const key = String(input.idempotencyKey || '').trim()
  if (!key) return false
  if (tx.all('SELECT id FROM notify_inbox WHERE idempotency_key = ?', [key]).length) return false
  const contact = supervisorContact(tx, input)
  const masked = contact ? maskContact(contact) : `#${Number(input.leadId || 0)}`
  const title = `线索 ${masked} 三次超时已回收`
  const body = `原归属 ${String(input.salesName || '-')}；${Number(input.remindCount || 3)}/3 次超时未完成首触；` +
    `回收时间 ${fmtSupervisorTime(Number(input.recycledAt))}；原因：${String(input.reason || 'SLA三次超时回收')}`
  const now = Date.now()
  tx.run(
    'INSERT INTO notify_inbox (notify_type, idempotency_key, title, body, lead_id, detail, status, source, updated_by, updated_at, version, deleted, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    ['sla1_escalate', key, title, body, Number(input.leadId || 0) || null,
      JSON.stringify({ salesName: String(input.salesName || ''), remindCount: Number(input.remindCount || 3), recycledAt: Number(input.recycledAt), reason: String(input.reason || ''), contactMasked: masked, hubLeadId: Number(input.leadId || 0) }),
      'unread', source, source === 'local:sla' ? 'system:sla' : 'system:sync', now, 1, 0, now]
  )
  tx.run('INSERT INTO audit_event (actor, action, entity_type, entity_id, detail, created_at) VALUES (?,?,?,?,?,?)',
    [source === 'local:sla' ? 'system:sla' : 'system:sync', 'sla1_supervisor_notify', 'lead', Number(input.leadId || 0) || null,
      JSON.stringify({ idempotencyKey: key, salesName: String(input.salesName || ''), remindCount: Number(input.remindCount || 3), contactMasked: masked }), now])
  return true
}

export interface NotifyListOpts { status?: string; limit?: number; offset?: number }

/** 升级提醒列表（新→旧）+ 未读数；status 传 'unread' 只看未读 */
export function listNotifyInbox(opts: NotifyListOpts = {}): { ok: boolean; data: { rows: CrmRow[]; unread: number } } {
  const where: string[] = ['deleted = 0']
  const params: unknown[] = []
  const status = String(opts.status || '').trim()
  if (status === 'unread' || status === 'read') { where.push('status = ?'); params.push(status) }
  const limit = Math.min(200, Math.max(1, Number(opts.limit) || 50))
  const offset = Math.max(0, Number(opts.offset) || 0)
  const w = ' WHERE ' + where.join(' AND ')
  const rows = crmDbService.all(
    `SELECT * FROM notify_inbox${w} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  )
  const unread = Number(crmDbService.all("SELECT COUNT(*) AS c FROM notify_inbox WHERE deleted = 0 AND status = 'unread'")[0]?.c || 0)
  return { ok: true, data: { rows, unread } }
}

/** 批量已读：只允许 unread → read（append 精神：不提供删除/回退）；返回实际更新数 */
export function markNotifyRead(ids: number[]): { ok: boolean; updated: number } {
  const clean = Array.from(new Set((Array.isArray(ids) ? ids : []).map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0)))
  if (!clean.length) return { ok: false, updated: 0 }
  let updated = 0
  const now = Date.now()
  crmDbService.runTx((tx) => {
    for (const id of clean) {
      const before = tx.all('SELECT status FROM notify_inbox WHERE id = ? AND deleted = 0', [id])[0]
      if (!before || String(before.status) !== 'unread') continue
      tx.run("UPDATE notify_inbox SET status = 'read', updated_by = 'ui:supervisor', updated_at = ?, version = version + 1 WHERE id = ? AND status = 'unread'", [now, id])
      updated++
    }
  })
  return { ok: true, updated }
}
