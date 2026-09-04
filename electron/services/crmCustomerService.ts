/**
 * crmCustomerService.ts —— customer 表人工维护入口（PRD §1.5 客户类型，宪法 §1.1）
 *
 * customer.type ∈ { dealer, end_user }（'' = 未设置），是 R9/R10（经销商拿货/回访规则）的前置。
 * 写入纪律：单事务 UPDATE customer + audit_event（action='customer_type_set'，detail 含新旧值）；
 * actor 兜底链 = 显式传入 > 身份档案署名（getActorLabel）> 「操作员」（宪法 §1.12，仅署名）。
 * AI 档位（宪法 §1.1）：type 是 B 档（proposed→人工 confirm），本服务只承载人工写入，
 * AI 提议走 enrich 待确认链路，不直接调本服务。
 */
import { crmDbService } from './crmDbService'
import { getActorLabel } from './identityService'

export const CUSTOMER_TYPES = ['dealer', 'end_user'] as const
export type CustomerType = (typeof CUSTOMER_TYPES)[number]

export interface CustomerTypeResult { ok: boolean; data?: { customerId: number; type: string; unchanged: boolean }; code?: string; message?: string }

/**
 * 设置客户类型（契约式信封）。'' = 清除回未设置。
 * E101 类型非法（枚举外）；E301 客户不存在/已删除。幂等：值未变 → unchanged=true 零写入零新审计。
 */
export function setCustomerType(customerId: number, type: string, actor?: string): CustomerTypeResult {
  const id = Number(customerId)
  const value = String(type ?? '').trim()
  if (!Number.isInteger(id) || id <= 0) return { ok: false, code: 'E101', message: 'customerId 必填' }
  if (value !== '' && !(CUSTOMER_TYPES as readonly string[]).includes(value)) {
    return { ok: false, code: 'E101', message: `客户类型须为 ${CUSTOMER_TYPES.join('/')}（或空=未设置）` }
  }
  const row = crmDbService.all('SELECT id, name, type FROM customer WHERE id = ? AND deleted = 0', [id])[0]
  if (!row) return { ok: false, code: 'E301', message: '客户不存在' }
  const oldType = String(row.type || '')
  if (oldType === value) return { ok: true, data: { customerId: id, type: value, unchanged: true } }

  const by = String(actor || '').trim() || getActorLabel() || '操作员'
  const now = Date.now()
  crmDbService.runTx((tx) => {
    tx.run('UPDATE customer SET type = ?, updated_by = ?, updated_at = ?, version = version + 1 WHERE id = ?', [value, by, now, id])
    tx.run('INSERT INTO audit_event (actor, action, entity_type, entity_id, detail, created_at) VALUES (?,?,?,?,?,?)',
      [by, 'customer_type_set', 'customer', id, JSON.stringify({ name: String(row.name || ''), oldType, newType: value }), now])
  })
  return { ok: true, data: { customerId: id, type: value, unchanged: false } }
}

/** 按 id 取 customer 行（档案投影用；不存在/已删除回 null） */
export function getCustomerById(customerId: number): Record<string, unknown> | null {
  const id = Number(customerId)
  if (!Number.isInteger(id) || id <= 0) return null
  return crmDbService.all('SELECT * FROM customer WHERE id = ? AND deleted = 0', [id])[0] || null
}
