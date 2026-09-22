/**
 * crmDeliveryService.ts —— 交付售后专用后端（宪法 §1.1/§1.5/§3 登记 2026-09-10）
 *
 * 取代前端「零后端」的交付售后页：交付登记 / 设备档案 / 数量差异任务 / 改装质保提醒 /
 * 以旧换新提案 / 复购等级，全部落在后端事实（opportunity/customer/audit_event +
 * follow_up_task + proposal_event），页面只读后端事实与任务，禁止前端本地计算。
 *
 * 写入纪律（沿用 crmCustomerService / registerOpportunityDeal 先例）：
 *  - 交付登记 / 设备档案 / 复购等级：单事务 UPDATE + audit_event（detail 记新旧值 + operator + source）
 *  - 数量差异任务 / 质保提醒 / 以旧换新提案：follow_up_task 行动卡（created_by='delivery'），
 *    幂等 = pendingTaskBySource + idx_ft_sla_once（(trigger_type, source_id) WHERE status='pending'）
 *    + latestTaskBySource 终态/周期判重（已裁决提案/已完成提醒不因刷新重出；差异卡内容随订单量原地更新）
 *  - 以旧换新 confirm/reject：proposal_event（accepted/rejected 只由人工触发）+ audit_event，不自动改客户事实
 *  - 设备档案 AI 只出提案（B 档），本服务只承载人工确认后写入
 *  - actor 兜底链 = 显式 > 身份档案署名（currentActor）> 「未署名」（宪法 §1.12 诚实署名）
 */
import { crmDbService, type CrmRow } from './crmDbService'
import { salesDbService, type FollowUpTask } from './salesDbService'
import { trackProposalEvent, currentActor } from './proposalEventTracking'
import { onOpportunityDealRegistered } from './crmLifecycleHooks'
import { computeRepeatLevel } from '../../shared/crmRepeat'
import { parseJsonObject } from '../../shared/safeJson'

const DAY_MS = 86400_000

// ─── 稳定触发枚举（宪法 §3 登记行；沿用 follow_up_task 载体不建新表）──────────
/** 数量差异：order_qty > shipped_qty，source_id = opportunity.id */
export const DIFF_TRIGGER = 'diff_shipped_shortage'
/** 改装质保临期：warranty_start_date + warranty_days 到期前 N 天，source_id = customer.id */
export const WARRANTY_NEAR_TRIGGER = 'warranty_mod_near'
/** 改装质保已到期：source_id = customer.id */
export const WARRANTY_EXPIRED_TRIGGER = 'warranty_mod_expired'
/** 以旧换新提案：source_id = customer.id，proposal_event entity_type='trade_in' */
export const TRADE_IN_TRIGGER = 'trade_in_proposal'

// ─── 阈值常量 ────────────────────────────────────────────────────────────────
/** 质保临期提醒窗口（天） */
export const WARRANTY_NEAR_DAYS = 30
/** 以旧换新：车龄阈值（年） */
export const TRADE_IN_MIN_VEHICLE_AGE = 3
/** 以旧换新：购置日期阈值（天 = 3 年） */
export const TRADE_IN_MIN_PURCHASE_DAYS = 3 * 365

// ─── 工具 ────────────────────────────────────────────────────────────────────
/** 毫秒 → YYYY-MM-DD（0/非法 → 空串；只做展示，不做周期推导） */
function fmtDate(ms: number): string {
  const n = Number(ms || 0)
  if (!n) return ''
  const d = new Date(n)
  if (Number.isNaN(d.getTime()) || d.getFullYear() < 1970 || d.getFullYear() > 2100) return ''
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 是否合法日期毫秒（> 0 且落在 1970~2100，杜绝 Infinity/NaN/任意字符串） */
function isValidDateMs(ms: number): boolean {
  if (!Number.isFinite(ms) || ms <= 0) return false
  const d = new Date(ms)
  return d.getTime() === ms && d.getFullYear() >= 1970 && d.getFullYear() <= 2100
}

/** actor 兜底链：显式 > 身份档案署名（currentActor） */
function resolveActor(actor?: string): string {
  return String(actor || '').trim() || currentActor()
}

/** 追加一条 audit_event（append-only；单条写入用 public create，不触碰私有 run） */
function writeAudit(action: string, entityType: string, entityId: number | null, detail: unknown, actor: string): void {
  crmDbService.create('audit_event', {
    actor, action, entity_type: entityType, entity_id: entityId,
    detail: JSON.stringify(detail ?? {}), created_at: Date.now()
  })
}

// ─── ① 交付登记（专用服务，取代通用 crm.update）──────────────────────────────
export interface DeliveryRegisterPayload {
  shipped_qty?: number
  delivery_date?: number
  over_ship_reason?: string
  actor?: string
}

export interface DeliveryRegisterResult {
  ok: boolean
  data?: {
    oppId: number
    shipped_qty: number
    delivery_date: number
    diffTaskCreated: number
    diffTaskClosed: number
    /** 差异仍在但数量变化：同一张 pending 卡被原地更新的次数（0/1） */
    diffTaskUpdated: number
  }
  code?: string
  message?: string
}

/**
 * 人工交付登记（单点）：实发量 + 交付日期 + 超发原因，同事务写 opportunity + audit_event。
 * 硬校验：① shipped_qty 非负整数；② shipped_qty > order_qty 必须带 over_ship_reason；
 * ③ delivery_date 若填非 0 必须是合法日期；④ 商机必须 status='won'（成交单才可登记交付）。
 * 事务外派生：数量差异任务同步（syncDiffTask）。
 */
export function registerDelivery(oppId: number, payload: DeliveryRegisterPayload = {}): DeliveryRegisterResult {
  const id = Number(oppId || 0)
  if (!Number.isInteger(id) || id <= 0) return { ok: false, code: 'E101', message: '商机 id 必填' }
  const opp = crmDbService.opportunityById(id)
  if (!opp) return { ok: false, code: 'E301', message: '商机不存在' }
  if (String(opp.status) !== 'won') return { ok: false, code: 'E301', message: '仅成交单可登记交付' }

  const orderQty = Number(opp.order_qty || 0)
  const oldShipped = Number(opp.shipped_qty || 0)
  const oldDelivery = Number(opp.delivery_date || 0)

  // ① 实发量：非负整数（缺省保留旧值，不覆盖）
  let shippedQty = oldShipped
  if (payload.shipped_qty !== undefined && payload.shipped_qty !== null) {
    const v = Number(payload.shipped_qty)
    if (!Number.isInteger(v) || v < 0) return { ok: false, code: 'E102', message: '实发量必须是非负整数' }
    shippedQty = v
  }
  // ② 超发必须带原因（快照文本）
  const overShipReason = String(payload.over_ship_reason || '').trim()
  if (shippedQty > orderQty && !overShipReason) {
    return { ok: false, code: 'E103', message: `实发量（${shippedQty}）超过订单量（${orderQty}），必须填写超发原因` }
  }
  // ③ 交付日期：0 = 未登记（合法清空态）；非 0 必须是合法日期
  let deliveryDate = oldDelivery
  if (payload.delivery_date !== undefined && payload.delivery_date !== null) {
    const v = Number(payload.delivery_date || 0)
    if (v !== 0 && !isValidDateMs(v)) return { ok: false, code: 'E104', message: '交付日期必须是合法日期' }
    deliveryDate = v
  }

  const by = resolveActor(payload.actor)
  const now = Date.now()
  crmDbService.runTx((tx) => {
    tx.run(
      'UPDATE opportunity SET shipped_qty = ?, delivery_date = ?, over_ship_reason = ?, updated_at = ? WHERE id = ?',
      [shippedQty, deliveryDate, shippedQty > orderQty ? overShipReason : '', now, id]
    )
    tx.markAnnualReviewChangedIfWrote('crm:opportunity') // 条件 UPDATE：确实改行才标记
    // 审计（宪法 §1.12 append-only，与写操作同事务）：记旧值/新值/操作者/来源
    tx.run(
      'INSERT INTO audit_event (actor, action, entity_type, entity_id, detail, created_at) VALUES (?,?,?,?,?,?)',
      [by, 'delivery_register', 'opportunity', id,
        JSON.stringify({
          old: { shipped_qty: oldShipped, delivery_date: oldDelivery },
          new: { shipped_qty: shippedQty, delivery_date: deliveryDate, over_ship_reason: shippedQty > orderQty ? overShipReason : '' },
          operator: by, source: 'delivery_aftersales'
        }), now]
    )
  })
  // 派生：数量差异任务同步（补齐自动关闭 / 新差异出卡 / 差异量变化原地更新）
  const diff = syncDiffTask(id, by)
  return {
    ok: true,
    data: {
      oppId: id, shipped_qty: shippedQty, delivery_date: deliveryDate,
      diffTaskCreated: diff.created, diffTaskClosed: diff.closed, diffTaskUpdated: diff.updated
    }
  }
}

// ─── ② 数量差异任务（真实 follow_up_task，不用前端列表冒充）───────────────────
/**
 * 数量差异任务同步：order_qty > shipped_qty → 确保一张 pending diff 卡（幂等，同商机唯一）；
 * 已有 pending 卡且差异量变化 → 原地更新卡面（title/priority/analysis，不新开卡、保持任务连续）；
 * 无变化零写入。shipped_qty ≥ order_qty → 关闭该商机 pending diff 卡（done + analysis 记关闭原因 + audit_event）。
 * 历史 done 卡保留（不删行）；差异再现时按规则重新出卡，不覆盖历史。
 */
export function syncDiffTask(oppId: number, actor = 'system:delivery'): { created: number; closed: number; updated: number } {
  if (!salesDbService.isInitialized()) return { created: 0, closed: 0, updated: 0 }
  const id = Number(oppId || 0)
  const opp = crmDbService.opportunityById(id)
  if (!opp) return { created: 0, closed: 0, updated: 0 }
  const orderQty = Number(opp.order_qty || 0)
  const shippedQty = Number(opp.shipped_qty || 0)
  const name = String(opp.account_name || opp.name || `商机 #${id}`)
  const sid = String(opp.session_id || '') || `deal:${id}`

  if (orderQty > 0 && shippedQty < orderQty) {
    const gap = orderQty - shippedQty
    const existing = salesDbService.pendingTaskBySource(DIFF_TRIGGER, id)
    if (existing) {
      // 幂等：同商机只留一张；但部分发货等使差异量变化时，原地更新卡面而不是装没看见
      let analysis: Record<string, unknown> = {}
      analysis = parseJsonObject(existing.analysis)
      if (Number(analysis.orderQty) === orderQty && Number(analysis.shippedQty) === shippedQty && Number(analysis.gap) === gap) {
        return { created: 0, closed: 0, updated: 0 } // 无变化零写入
      }
      analysis.orderQty = orderQty
      analysis.shippedQty = shippedQty
      analysis.gap = gap
      analysis.oppId = id
      analysis.updatedAt = Date.now()
      analysis.updatedBy = actor
      salesDbService.todoUpdate(Number(existing.id), {
        title: `数量差异跟进：${name} 订单 ${orderQty} 台 / 实发 ${shippedQty} 台，差 ${gap} 台待核对补发`,
        priority_score: 70 + Math.min(gap, 30),
        analysis: JSON.stringify(analysis)
      })
      return { created: 0, closed: 0, updated: 1 }
    }
    const task = salesDbService.todoCreate({
      session_id: sid || null,
      display_name: name || null,
      trigger_type: DIFF_TRIGGER,
      title: `数量差异跟进：${name} 订单 ${orderQty} 台 / 实发 ${shippedQty} 台，差 ${gap} 台待核对补发`,
      source_id: id,
      status: 'pending',
      priority_score: 70 + Math.min(gap, 30),
      due_at: null,
      created_by: 'delivery'
    })
    salesDbService.todoUpdate(Number(task.id), {
      analysis: JSON.stringify({ orderQty, shippedQty, gap, oppId: id })
    })
    return { created: 1, closed: 0, updated: 0 }
  }

  // 已补齐：关闭 pending diff 卡（历史保留）
  const pending = salesDbService.pendingTaskBySource(DIFF_TRIGGER, id)
  if (!pending) return { created: 0, closed: 0, updated: 0 }
  let analysis: Record<string, unknown> = {}
  analysis = parseJsonObject(pending.analysis)
  analysis.closedReason = `实发量已补齐（shipped_qty=${shippedQty} ≥ order_qty=${orderQty}），差异任务自动关闭`
  analysis.closedBy = actor
  analysis.closedAt = Date.now()
  salesDbService.todoUpdate(Number(pending.id), { status: 'done', analysis: JSON.stringify(analysis) })
  writeAudit('diff_task_autoclose', 'opportunity', id, { taskId: Number(pending.id), shippedQty, orderQty }, actor)
  return { created: 0, closed: 1, updated: 0 }
}

// ─── ③ 设备档案（7 字段，AI 只出提案，人工确认后写入）───────────────────────
export interface EquipmentFields {
  brand?: string
  model?: string
  vehicle_age?: number
  purchase_date?: number
  modified?: number
  modified_date?: number
  battery_type?: string
  last_maintenance_date?: number
  warranty_start_date?: number
  warranty_days?: number
}

export interface SaveEquipmentResult {
  ok: boolean
  data?: { customerId: number; changedFields: string[] }
  code?: string
  message?: string
}

/** 设备档案字段 → customer 列映射（白名单，防散写） */
const EQUIPMENT_COLUMNS: ReadonlyArray<{ key: keyof EquipmentFields; col: string; isDate: boolean }> = [
  { key: 'brand', col: 'brand', isDate: false },
  { key: 'model', col: 'model', isDate: false },
  { key: 'vehicle_age', col: 'vehicle_age', isDate: false },
  { key: 'purchase_date', col: 'purchase_date', isDate: true },
  { key: 'modified', col: 'modified', isDate: false },
  { key: 'modified_date', col: 'modified_date', isDate: true },
  { key: 'battery_type', col: 'battery_type', isDate: false },
  { key: 'last_maintenance_date', col: 'last_maintenance_date', isDate: true },
  { key: 'warranty_start_date', col: 'warranty_start_date', isDate: true },
  { key: 'warranty_days', col: 'warranty_days', isDate: false }
]

/**
 * 保存客户设备档案：单事务 UPDATE（仅变更字段）+ audit_event（detail 记旧/新值）。
 * 日期字段非 0 必须合法；vehicle_age 非负整数；warranty_days 非负整数。
 * 事务外派生：该客户质保提醒同步（syncWarrantyReminders）。
 */
export function saveEquipment(customerId: number, fields: EquipmentFields = {}, actor?: string): SaveEquipmentResult {
  const id = Number(customerId || 0)
  if (!Number.isInteger(id) || id <= 0) return { ok: false, code: 'E101', message: '客户 id 必填' }
  const cust = crmDbService.all('SELECT * FROM customer WHERE id = ? AND deleted = 0', [id])[0]
  if (!cust) return { ok: false, code: 'E301', message: '客户不存在' }

  const patch: Record<string, unknown> = {}
  const oldVals: Record<string, unknown> = {}
  const newVals: Record<string, unknown> = {}
  for (const def of EQUIPMENT_COLUMNS) {
    const v = (fields as Record<string, unknown>)[def.key]
    if (v === undefined || v === null) continue
    let value: unknown = v
    if (def.isDate) {
      const n = Number(v || 0)
      if (n !== 0 && !isValidDateMs(n)) return { ok: false, code: 'E104', message: `${def.col} 必须是合法日期` }
      value = n
    } else if (def.key === 'vehicle_age' || def.key === 'warranty_days') {
      const n = Number(v || 0)
      if (!Number.isInteger(n) || n < 0) return { ok: false, code: 'E102', message: `${def.col} 必须是非负整数` }
      value = n
    } else if (def.key === 'modified') {
      value = v ? 1 : 0
    } else {
      value = String(v ?? '')
    }
    const oldVal = def.isDate ? Number(cust[def.col] || 0) : (def.key === 'modified' ? Number(cust[def.col] || 0) : String(cust[def.col] ?? ''))
    if (String(oldVal) === String(value)) continue // 未变更跳过
    patch[def.col] = value
    oldVals[def.col] = oldVal
    newVals[def.col] = value
  }
  if (!Object.keys(patch).length) {
    return { ok: true, data: { customerId: id, changedFields: [] } }
  }

  const by = resolveActor(actor)
  const now = Date.now()
  crmDbService.runTx((tx) => {
    const cols = Object.keys(patch)
    const setClause = ['updated_by = ?', 'updated_at = ?', 'version = version + 1', ...cols.map((c) => `${c} = ?`)]
    const params: unknown[] = [by, now, ...cols.map((c) => patch[c])]
    tx.run(`UPDATE customer SET ${setClause.join(', ')} WHERE id = ?`, [...params, id])
    tx.run(
      'INSERT INTO audit_event (actor, action, entity_type, entity_id, detail, created_at) VALUES (?,?,?,?,?,?)',
      [by, 'customer_equipment_set', 'customer', id,
        JSON.stringify({ name: String(cust.name || ''), old: oldVals, new: newVals, operator: by, source: 'delivery_aftersales' }), now]
    )
  })
  // 派生：质保提醒同步（warranty_start_date / warranty_days 变化可能触发临期/到期卡，或令旧卡失效关闭）
  syncWarrantyReminders(id, Date.now(), by)
  return { ok: true, data: { customerId: id, changedFields: Object.keys(patch) } }
}

// ─── ④ 改装质保提醒（显式 warranty_start_date + warranty_days，无真实日期不猜）──
/** 任务卡 analysis JSON 解析（容错：空/坏 JSON → {}；旧数据卡无 analysis 视为周期未知） */
function parseTaskAnalysis(raw: unknown): Record<string, unknown> {
  return parseJsonObject(raw)
}

/** 质保卡被服务自动失效关闭后允许同一周期恢复；人工完成的 done 卡仍然终态判重。 */
function isWarrantyAutoClosed(analysis: Record<string, unknown>): boolean {
  return typeof analysis.closedReason === 'string' && analysis.closedReason.trim().length > 0
}

/**
 * 关闭指定 trigger 的 pending 质保卡（周期变更/清空/跨档失效自动关闭）：
 * status→done + analysis 追加 closedReason/closedBy/closedAt + audit_event 留痕；历史 done 行保留不删。
 */
function closeWarrantyPending(cid: number, trigger: string, reason: string, actor: string): number {
  const pending = salesDbService.pendingTaskBySource(trigger, cid)
  if (!pending) return 0
  const analysis = parseTaskAnalysis(pending.analysis)
  analysis.closedReason = reason
  analysis.closedBy = actor
  analysis.closedAt = Date.now()
  salesDbService.todoUpdate(Number(pending.id), { status: 'done', analysis: JSON.stringify(analysis) })
  writeAudit('warranty_reminder_autoclose', 'customer', cid, { taskId: Number(pending.id), trigger, reason }, actor)
  return 1
}

/**
 * 单客户质保提醒同步。周期身份 = (warranty_start_date, warranty_days) 推出的 expiry（到期毫秒）：
 *  - 起算日/期限缺失或已清空 → 两类 pending 全关（提醒失效），不出卡；
 *  - pending 卡与当前周期/档位不符 → 自动关闭（临期→到期用「接替」口径，其余为「已变更」）；
 *  - 同周期最新卡（无论 pending 还是人工完成的 done）expiry 一致 → 不重出；
 *  - 出卡即写 analysis { kind, expiry, start, days }，供后续周期判重。
 */
function warrantyReminderForCustomer(cu: CrmRow, now: number, actor = 'system:delivery'): { near: boolean; expired: boolean; closed: number } {
  const cid = Number(cu.id)
  const start = Number(cu.warranty_start_date || 0)
  const days = Number(cu.warranty_days || 0)
  const out = { near: false, expired: false, closed: 0 }
  // 无真实起算日/期限 → 不猜周期；旧卡（若有）全部失效关闭
  if (start <= 0 || days <= 0) {
    out.closed += closeWarrantyPending(cid, WARRANTY_NEAR_TRIGGER, '质保起算日或期限已清空，提醒失效', actor)
    out.closed += closeWarrantyPending(cid, WARRANTY_EXPIRED_TRIGGER, '质保起算日或期限已清空，提醒失效', actor)
    return out
  }
  const expiry = start + days * DAY_MS
  // 当前周期应出类别：已到期 > 临期（到期前 WARRANTY_NEAR_DAYS 天窗口）> 无需出卡
  const dueKind: 'near' | 'expired' | null = now >= expiry ? 'expired' : (now >= expiry - WARRANTY_NEAR_DAYS * DAY_MS ? 'near' : null)

  // 先清理与当前周期/档位不符的 stale pending（日期变更、清空以外，还有 near→expired 跨档）
  const nearPending = salesDbService.pendingTaskBySource(WARRANTY_NEAR_TRIGGER, cid)
  if (nearPending && (dueKind !== 'near' || Number(parseTaskAnalysis(nearPending.analysis).expiry || 0) !== expiry)) {
    out.closed += closeWarrantyPending(cid, WARRANTY_NEAR_TRIGGER,
      dueKind === 'expired' ? '质保已到期，临期提醒由到期提醒接替' : '质保起算日或期限已变更，旧提醒失效', actor)
  }
  const expiredPending = salesDbService.pendingTaskBySource(WARRANTY_EXPIRED_TRIGGER, cid)
  if (expiredPending && (dueKind !== 'expired' || Number(parseTaskAnalysis(expiredPending.analysis).expiry || 0) !== expiry)) {
    out.closed += closeWarrantyPending(cid, WARRANTY_EXPIRED_TRIGGER, '质保起算日或期限已变更，旧提醒失效', actor)
  }
  if (!dueKind) return out

  // 同周期判重：最新一张卡（含人工完成的 done）expiry 一致 → 不再出卡（完成后重扫不重出）
  const trigger = dueKind === 'expired' ? WARRANTY_EXPIRED_TRIGGER : WARRANTY_NEAR_TRIGGER
  const latest = salesDbService.latestTaskBySource(trigger, cid)
  if (latest) {
    const latestAnalysis = parseTaskAnalysis(latest.analysis)
    // 清空/改期/跨档自动关闭的历史卡不是人工完成；恢复到原 expiry 时应允许重新出卡。
    if (Number(latestAnalysis.expiry || 0) === expiry && !isWarrantyAutoClosed(latestAnalysis)) return out
  }

  const name = String(cu.name || '客户')
  const acc = crmDbService.all("SELECT session_id FROM account WHERE customer_id = ? AND session_id IS NOT NULL AND session_id != '' LIMIT 1", [cid])[0]
  const sid = String(acc?.session_id || '') || `cust:${cid}`
  if (dueKind === 'expired') {
    const task = salesDbService.todoCreate({
      session_id: sid, display_name: name,
      trigger_type: WARRANTY_EXPIRED_TRIGGER,
      title: `改装质保已到期：${name} 质保到期日 ${fmtDate(expiry)}，需联系确认质保状态`,
      source_id: cid, status: 'pending', priority_score: 85, due_at: null, created_by: 'delivery'
    })
    salesDbService.todoUpdate(Number(task.id), { analysis: JSON.stringify({ kind: 'expired', expiry, start, days }) })
    out.expired = true
  } else {
    const task = salesDbService.todoCreate({
      session_id: sid, display_name: name,
      trigger_type: WARRANTY_NEAR_TRIGGER,
      title: `改装质保临期：${name} 质保到期日 ${fmtDate(expiry)}（剩 ${Math.ceil((expiry - now) / DAY_MS)} 天）`,
      source_id: cid, status: 'pending', priority_score: 60, due_at: expiry, created_by: 'delivery'
    })
    salesDbService.todoUpdate(Number(task.id), { analysis: JSON.stringify({ kind: 'near', expiry, start, days }) })
    out.near = true
  }
  return out
}

/** 全量质保提醒扫描（挂交付售后扫描）：只按真实起算日 + 期限出卡，幂等（同周期一张卡，closed=本轮自动关闭的失效 pending 数） */
export function runWarrantyReminderScan(now = Date.now()): { near: number; expired: number; closed: number } {
  if (!salesDbService.isInitialized()) return { near: 0, expired: 0, closed: 0 }
  let near = 0, expired = 0, closed = 0
  for (const cu of crmDbService.all('SELECT * FROM customer WHERE deleted = 0')) {
    const r = warrantyReminderForCustomer(cu, now)
    if (r.near) near++
    if (r.expired) expired++
    closed += r.closed
  }
  return { near, expired, closed }
}

/** 单客户质保提醒同步（saveEquipment 后派生，actor 透传操作者；不重扫全表） */
export function syncWarrantyReminders(customerId: number, now = Date.now(), actor = 'system:delivery'): { near: number; expired: number; closed: number } {
  if (!salesDbService.isInitialized()) return { near: 0, expired: 0, closed: 0 }
  const cu = crmDbService.all('SELECT * FROM customer WHERE id = ? AND deleted = 0', [Number(customerId)])[0]
  if (!cu) return { near: 0, expired: 0, closed: 0 }
  const r = warrantyReminderForCustomer(cu, now, actor)
  return { near: r.near ? 1 : 0, expired: r.expired ? 1 : 0, closed: r.closed }
}

// ─── ⑤ 以旧换新（必须真实设备日期或聊天证据；只出提案，不自动改客户事实）─────
export interface TradeInBasis {
  kind: 'purchase_date' | 'vehicle_age' | 'chat_evidence'
  /** 证据锚点：真实设备日期 device:<field>:<id>:<事实值>（依据真实变化即新键）或聊天证据 messageKey */
  evidenceKey: string
  reason: string
  at?: number
}

export interface TradeInResult {
  ok: boolean
  taskId?: number
  code?: string
  message?: string
}

/** 从客户设备事实推导以旧换新依据（无真实日期/车龄 → null，绝不猜） */
export function tradeInBasisOf(customer: CrmRow, now = Date.now()): TradeInBasis | null {
  const cid = Number(customer.id)
  const purchase = Number(customer.purchase_date || 0)
  if (purchase > 0 && now - purchase >= TRADE_IN_MIN_PURCHASE_DAYS * DAY_MS) {
    return {
      kind: 'purchase_date',
      evidenceKey: `device:purchase_date:${cid}:${purchase}`,
      reason: `购置日期 ${fmtDate(purchase)} 已满 3 年，建议发起以旧换新评估`,
      at: purchase
    }
  }
  const vehicleAge = Number(customer.vehicle_age || 0)
  if (vehicleAge >= TRADE_IN_MIN_VEHICLE_AGE) {
    return {
      kind: 'vehicle_age',
      evidenceKey: `device:vehicle_age:${cid}:${vehicleAge}`,
      reason: `车龄 ${vehicleAge} 年（≥3 年），建议发起以旧换新评估`,
      at: now
    }
  }
  return null
}

/**
 * 发起以旧换新提案：硬门 evidenceKey + reason 必填（真实设备日期或聊天证据），
 * 只生成 proposal_event(generated) + follow_up_task 行动卡，绝不改动客户事实。
 * 幂等：同客户只保留一张 pending trade_in_proposal 卡（DUP）；
 * 终态判重：相同依据（evidenceKey 一致）的提案已裁决（analysis 含 decision）→ DECIDED 不重出，
 * 依据真实变化（evidenceKey 不同）才允许重新提案。
 */
export function proposeTradeIn(customerId: number, basis: TradeInBasis, actor?: string): TradeInResult {
  const id = Number(customerId || 0)
  if (!Number.isInteger(id) || id <= 0) return { ok: false, code: 'E101', message: '客户 id 必填' }
  const cust = crmDbService.all('SELECT * FROM customer WHERE id = ? AND deleted = 0', [id])[0]
  if (!cust) return { ok: false, code: 'E301', message: '客户不存在' }
  const evidenceKey = String(basis?.evidenceKey || '').trim()
  const reason = String(basis?.reason || '').trim()
  if (!evidenceKey) return { ok: false, code: 'E101', message: '以旧换新提案必须携带证据（真实设备日期或聊天证据）' }
  if (!reason) return { ok: false, code: 'E101', message: '以旧换新提案必须说明原因' }
  const by = resolveActor(actor)
  const now = Date.now()
  if (salesDbService.pendingTaskBySource(TRADE_IN_TRIGGER, id)) {
    return { ok: true, taskId: 0, code: 'DUP', message: '该客户已有待处理的以旧换新提案' }
  }
  // 终态判重：相同依据已裁决（终态保留，裁决卡永不被覆盖）；不写埋点、不建卡
  const latest = salesDbService.latestTaskBySource(TRADE_IN_TRIGGER, id)
  if (latest) {
    const latestAnalysis = parseTaskAnalysis(latest.analysis)
    if (latestAnalysis.decision && String(latestAnalysis.evidenceKey || '') === evidenceKey) {
      return { ok: true, taskId: 0, code: 'DECIDED', message: '相同依据的提案已裁决（终态保留），依据变化才会重新提案' }
    }
  }
  // 提案埋点（generated；accepted/rejected 只由人工裁决触发）
  trackProposalEvent({ event_type: 'proposal', stage: 'generated', entity_type: 'trade_in', entity_id: id, actor: by, createdAt: now })
  const acc = crmDbService.all("SELECT session_id FROM account WHERE customer_id = ? AND session_id IS NOT NULL AND session_id != '' LIMIT 1", [id])[0]
  const task = salesDbService.todoCreate({
    session_id: String(acc?.session_id || '') || null,
    display_name: String(cust.name || '') || null,
    trigger_type: TRADE_IN_TRIGGER,
    title: `以旧换新提案：${String(cust.name || '客户')} —— ${reason}`,
    source_id: id,
    status: 'pending',
    priority_score: 50,
    due_at: null,
    created_by: 'delivery'
  })
  salesDbService.todoUpdate(Number(task.id), {
    analysis: JSON.stringify({ kind: basis.kind, evidenceKey, reason, at: basis.at ?? now, proposedBy: by })
  })
  return { ok: true, taskId: Number(task.id) }
}

/**
 * 裁决以旧换新提案（accept/reject）：写 proposal_event(accepted/rejected) + audit_event，
 * 关闭 pending 提案卡；**绝不自动改客户事实**（确认后由人工另行建档）。
 */
export function decideTradeIn(customerId: number, decision: 'accept' | 'reject', actor?: string): TradeInResult {
  const id = Number(customerId || 0)
  if (!Number.isInteger(id) || id <= 0) return { ok: false, code: 'E101', message: '客户 id 必填' }
  if (decision !== 'accept' && decision !== 'reject') return { ok: false, code: 'E101', message: '裁决只能是 accept/reject' }
  const by = resolveActor(actor)
  const now = Date.now()
  trackProposalEvent({
    event_type: 'proposal', stage: decision === 'accept' ? 'accepted' : 'rejected',
    entity_type: 'trade_in', entity_id: id, actor: by, createdAt: now
  })
  writeAudit(`trade_in_proposal_${decision}`, 'customer', id, { decision, at: now }, by)
  const pending = salesDbService.pendingTaskBySource(TRADE_IN_TRIGGER, id)
  if (pending) {
    let analysis: Record<string, unknown> = {}
    analysis = parseJsonObject(pending.analysis)
    analysis.decision = decision
    analysis.decidedBy = by
    analysis.decidedAt = now
    salesDbService.todoUpdate(Number(pending.id), { status: 'done', analysis: JSON.stringify(analysis) })
  }
  return { ok: true }
}

/** 以旧换新全量扫描：对满足依据（真实日期/车龄）且无 pending 提案的客户出提案卡 */
export function runTradeInProposalScan(now = Date.now()): number {
  if (!salesDbService.isInitialized()) return 0
  let created = 0
  for (const cu of crmDbService.all('SELECT * FROM customer WHERE deleted = 0')) {
    const basis = tradeInBasisOf(cu, now)
    if (!basis) continue
    const r = proposeTradeIn(Number(cu.id), basis, 'system:delivery-scan')
    if (r.ok && r.taskId) created++
  }
  return created
}

// ─── ⑥ 复购等级（单一后端原语 shared/crmRepeat.computeRepeatLevel）───────────
export interface RepeatLevelResult {
  ok: boolean
  level?: string
  changed?: boolean
}

/**
 * 重算某客户复购等级：按 account.customer_id 挂接的 won 成交笔数分档（单一原语）。
 * 等级变化才写 audit_event(action='customer_repeat_level_change')，未变零写入。
 */
export function recomputeRepeatLevel(customerId: number, actor?: string): RepeatLevelResult {
  const id = Number(customerId || 0)
  if (!Number.isInteger(id) || id <= 0) return { ok: false }
  const cust = crmDbService.all('SELECT id, repeat_level FROM customer WHERE id = ? AND deleted = 0', [id])[0]
  if (!cust) return { ok: false }
  const count = Number(
    crmDbService.all(
      "SELECT COUNT(*) AS c FROM opportunity o JOIN account a ON a.id = o.account_id WHERE a.customer_id = ? AND o.status = 'won'",
      [id]
    )[0]?.c || 0
  )
  const level = computeRepeatLevel(count)
  const oldLevel = String(cust.repeat_level || '')
  if (oldLevel === level) return { ok: true, level, changed: false }
  const by = resolveActor(actor)
  const now = Date.now()
  crmDbService.runTx((tx) => {
    tx.run('UPDATE customer SET repeat_level = ?, updated_by = ?, updated_at = ?, version = version + 1 WHERE id = ?', [level, by, now, id])
    tx.run(
      'INSERT INTO audit_event (actor, action, entity_type, entity_id, detail, created_at) VALUES (?,?,?,?,?,?)',
      [by, 'customer_repeat_level_change', 'customer', id,
        JSON.stringify({ oldLevel, newLevel: level, wonCount: count, operator: by }), now]
    )
  })
  return { ok: true, level, changed: true }
}

/** 全量重算复购等级（兜底扫描；返回变化客户数） */
export function recomputeAllRepeatLevels(actor = 'system:delivery'): number {
  let changed = 0
  for (const c of crmDbService.all('SELECT id FROM customer WHERE deleted = 0')) {
    if (recomputeRepeatLevel(Number(c.id), actor).changed) changed++
  }
  return changed
}

// ─── ⑦ 交付售后任务读口（页面事实源：后端 follow_up_task，非前端推导）─────────
export interface DeliveryTasks {
  diff: FollowUpTask[]
  warrantyNear: FollowUpTask[]
  warrantyExpired: FollowUpTask[]
  tradeIn: FollowUpTask[]
}

/** 读取交付售后四类 pending 行动卡（页面提醒唯一来源；历史 done 卡不进列表） */
export function listDeliveryTasks(): DeliveryTasks {
  if (!salesDbService.isInitialized()) return { diff: [], warrantyNear: [], warrantyExpired: [], tradeIn: [] }
  const pending = salesDbService.todoList({ status: 'pending' })
  const by = (t: string) => pending.filter((x) => String(x.trigger_type) === t)
  return {
    diff: by(DIFF_TRIGGER),
    warrantyNear: by(WARRANTY_NEAR_TRIGGER),
    warrantyExpired: by(WARRANTY_EXPIRED_TRIGGER),
    tradeIn: by(TRADE_IN_TRIGGER)
  }
}

/** 交付日期建议（只读，Suggestion；真实写入必须经 registerDelivery 人工确认） */
export function suggestDeliveryDate(oppId: number): { date: number; source: string } | null {
  const opp = crmDbService.opportunityById(Number(oppId || 0))
  if (!opp) return null
  if (Number(opp.delivery_date || 0) > 0) return { date: Number(opp.delivery_date), source: '交付日期（人工登记）' }
  const accountId = Number(opp.account_id || 0)
  if (accountId > 0) {
    const signed = crmDbService.all(
      "SELECT MAX(signed_at) AS t FROM logistics WHERE account_id = ? AND status = 'signed' AND signed_at > 0",
      [accountId]
    )[0]
    if (Number(signed?.t || 0) > 0) return { date: Number(signed.t), source: '物流签收时间（自动推断）' }
    const updated = crmDbService.all(
      'SELECT MAX(latest_update_at) AS t FROM logistics WHERE account_id = ? AND latest_update_at > 0',
      [accountId]
    )[0]
    if (Number(updated?.t || 0) > 0) return { date: Number(updated.t), source: '物流最新轨迹（弱推断，请人工核对）' }
  }
  return null
}

// ─── ⑧ 交付售后统一扫描（挂全量扫描，与 runAftersalesScan 并列；不回归 R9-R12）──
export interface DeliveryScanResult {
  diffCreated: number
  diffClosed: number
  /** 差异仍在但数量变化：原地更新的差异卡数 */
  diffUpdated: number
  warrantyNear: number
  warrantyExpired: number
  /** 质保周期变更/清空/跨档：本轮自动关闭的失效提醒卡数 */
  warrantyClosed: number
  tradeIn: number
}

export function runDeliveryScan(now = Date.now()): DeliveryScanResult {
  let diffCreated = 0, diffClosed = 0, diffUpdated = 0
  for (const o of crmDbService.opportunityList({ status: 'won' })) {
    const r = syncDiffTask(Number(o.id))
    diffCreated += r.created
    diffClosed += r.closed
    diffUpdated += r.updated
  }
  const w = runWarrantyReminderScan(now)
  const t = runTradeInProposalScan(now)
  return { diffCreated, diffClosed, diffUpdated, warrantyNear: w.near, warrantyExpired: w.expired, warrantyClosed: w.closed, tradeIn: t }
}

// ─── 生命周期钩子注册（模块加载即生效；幂等无副作用）─────────────────────────
// 成交登记完成 → ① 该成交单数量差异任务出卡；② 该客户复购等级重算。
// 尽力而为（失败不影响成交登记主语义），与 crmFirstClassifyService 的同类钩子并列订阅。
onOpportunityDealRegistered((accountId, opportunityId) => {
  try { syncDiffTask(Number(opportunityId), 'system:delivery-hook') } catch { /* 钩子失败不影响主语义 */ }
  try {
    const acc = crmDbService.getById('account', Number(accountId))
    const customerId = Number(acc?.customer_id || 0)
    if (customerId > 0) recomputeRepeatLevel(customerId, 'system:delivery-hook')
  } catch { /* 钩子失败不影响主语义 */ }
})
