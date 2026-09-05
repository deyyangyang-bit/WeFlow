/**
 * crmAssignmentService.ts —— 线索分配服务（Phase 1 完整版：assign/claim/recycle/transfer/list）
 * 宪法 §1.3：assignment 表是 lead 归属唯一事实源（lead↔assignment 1:N，
 *   当前分配 = 该 lead 最新一条 status ∈ (assigned, claimed) 的有效行）；
 *   lead 状态机绝对不动、分配状态永不入 lead 表。
 *   ⚠️ 唯一例外（2026-09-04 拍板）：lead.first_contact_deadline 是首触 SLA 计时列（非分配状态），
 *   assign/transfer 起计时（= sla1_deadline）、recycle 重置回 2100 哨兵（回资源池 = 待分配）。
 * 写入纪律（API-CONTRACT §1.14）：分配/归属动作单事务写 assignment + ownership_history + audit_event
 *   （claim 归属没变不写 ownership_history，只写 assignment + audit_event）。
 * 响应信封：{ ok: true, data } / { ok: false, code, message }；错误码 E1xx 参数 / E2xx 状态冲突 / E3xx 不存在。
 * SLA1 回收器（PRD 1.4 第一段「加了没有」机械计时）：status=assigned 且 sla1_deadline 过期 → 自动回收，
 *   A 档引擎动作（规则驱动非 LLM，宪法 §1.3），审计照写（actor='system:sla'）。
 */
import { crmDbService, type CrmRow } from './crmDbService'
import { getIdentity, getActorLabel } from './identityService'
import { recordOutboxTx } from './crmOutboxService'
import { ConfigService } from './config'
import { LEAD_SLA_UNASSIGNED_SENTINEL } from '../../shared/leadSla'

/** 当前有效分配状态（宪法 §1.3：最新有效行 = 当前归属；recycled/transferred 即失效） */
const ACTIVE_STATUS_SQL = "status IN ('assigned','claimed')"

/** 第一段 SLA 小时数（与 crmLeadService.slaHours 同口径：配置 crmLeadSlaHours，1-72，默认 24） */
function sla1Hours(): number {
  const n = Number(ConfigService.getInstance().get('crmLeadSlaHours') ?? 24)
  return Number.isFinite(n) && n > 0 && n <= 72 ? n : 24
}
function sla1Ms(): number { return sla1Hours() * 3600_000 }

// ─── 分配（crm:assignment:assign）──────────────────────────────────────────
export interface AssignSkipped { leadId: number; code: 'E201' | 'E301'; reason: string }
export interface AssignData { assignments: Array<{ leadId: number; assignmentId: number }>; skipped: AssignSkipped[] }
export interface AssignResult { ok: boolean; data?: AssignData; code?: string; message?: string }

/** 某 lead 的当前有效分配行（无 = 未分配 / 已回收 / 已移交） */
export function currentAssignment(leadId: number): CrmRow | null {
  const rows = crmDbService.all(
    `SELECT * FROM assignment WHERE lead_id = ? AND deleted = 0 AND ${ACTIVE_STATUS_SQL} ORDER BY id DESC LIMIT 1`,
    [Number(leadId)]
  )
  return rows.length ? rows[0] : null
}

/**
 * 批量分配：逐条校验（E301 线索不存在 / E201 已有有效分配 → 跳过计入 skipped，不阻塞其余），
 * 可分配的线索在**同一事务**内写 assignment + ownership_history + audit_event，全部成功才提交。
 * 幂等（契约 U）：同 lead 已有当前有效行则拒绝，重放不产生重复归属。
 */
export function assignLeads(leadIds: number[], salesName: string, actor: string, mode = 'manual'): AssignResult {
  const name = String(salesName || '').trim()
  // actor 仅署名用途（宪法 §1.12）：显式传入 > 本地身份档案「姓名（角色）」（PRD §1.2a）> 未建档兜底「分配员」
  const by = String(actor || '').trim() || getActorLabel() || '分配员'
  const ids = Array.from(new Set((Array.isArray(leadIds) ? leadIds : []).map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0)))
  if (!ids.length || !name) return { ok: false, code: 'E101', message: 'leadIds 与 salesName 必填' }

  const now = Date.now()
  // 分配起计时（PRD 1.4 第一段「加了没有」）：sla1_deadline = now + crmLeadSlaHours；
  // 已分配 lead 的 first_contact_deadline 从 2100 哨兵改为同一期限（scanLeadSla 现有机制继续工作）
  const sla1 = now + sla1Ms()
  const m = String(mode || 'manual')
  const data = crmDbService.runTx((tx) => {
    const assignments: Array<{ leadId: number; assignmentId: number }> = []
    const skipped: AssignSkipped[] = []
    for (const leadId of ids) {
      if (!tx.all('SELECT id FROM lead WHERE id = ?', [leadId]).length) {
        skipped.push({ leadId, code: 'E301', reason: '线索不存在' })
        continue
      }
      const cur = tx.all(`SELECT id, sales_name FROM assignment WHERE lead_id = ? AND deleted = 0 AND ${ACTIVE_STATUS_SQL} ORDER BY id DESC LIMIT 1`, [leadId])
      if (cur.length) {
        skipped.push({ leadId, code: 'E201', reason: `已有有效分配（${String(cur[0].sales_name)}）` })
        continue
      }
      const assignmentId = tx.run(
        'INSERT INTO assignment (lead_id, sales_name, mode, sla1_deadline, sla2_scan_ref, status, source, updated_by, updated_at, version, deleted) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        [leadId, name, m, sla1, '', 'assigned', 'manual', by, now, 1, 0]
      )
      // 首触 SLA 起计时：哨兵 → 真实期限（只覆盖计时列，lead 状态机不动）
      tx.run('UPDATE lead SET first_contact_deadline = ?, updated_at = ? WHERE id = ?', [sla1, now, leadId])
      // 归属变更流水（宪法 §1.8，append-only）+ 审计（宪法 §1.12，action=lead_assign）
      tx.run('INSERT INTO ownership_history (entity_type, entity_id, old_owner, new_owner, reason, actor, created_at) VALUES (?,?,?,?,?,?,?)',
        ['lead', leadId, '', name, '分配', by, now])
      tx.run('INSERT INTO audit_event (actor, action, entity_type, entity_id, detail, created_at) VALUES (?,?,?,?,?,?)',
        [by, 'lead_assign', 'lead', leadId, JSON.stringify({ salesName: name, mode: m, assignmentId, sla1Deadline: sla1 }), now])
      // outbox 登记（PRD §1.10 只记录不发送；下行 assign 事件，同步设计 §3）
      recordOutboxTx(tx, 'assign', `assign:${assignmentId}`, { leadId, salesName: name, mode: m, assignmentId, sla1Deadline: sla1, actor: by }, now)
      assignments.push({ leadId, assignmentId })
    }
    return { assignments, skipped }
  })
  return { ok: true, data }
}

// ─── 查询（crm:assignment:list）────────────────────────────────────────────
export interface AssignmentListOpts { leadId?: number; salesName?: string; status?: string; page?: number; pageSize?: number }

/** 分配记录查询：按 leadId / salesName / status 过滤 + 分页（契约 R，只读） */
export function listAssignments(opts: AssignmentListOpts = {}): { ok: boolean; data: { rows: CrmRow[]; total: number } } {
  const where: string[] = ['deleted = 0']
  const params: unknown[] = []
  if (opts.leadId) { where.push('lead_id = ?'); params.push(Number(opts.leadId)) }
  const salesName = String(opts.salesName || '').trim()
  if (salesName) { where.push('sales_name = ?'); params.push(salesName) }
  const status = String(opts.status || '').trim()
  if (status) { where.push('status = ?'); params.push(status) }
  const page = Math.max(1, Number(opts.page) || 1)
  const pageSize = Math.min(100000, Math.max(1, Number(opts.pageSize) || 50))
  const w = ' WHERE ' + where.join(' AND ')
  const total = Number(crmDbService.all(`SELECT COUNT(*) AS c FROM assignment${w}`, params)[0]?.c || 0)
  const rows = crmDbService.all(`SELECT * FROM assignment${w} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, pageSize, (page - 1) * pageSize])
  return { ok: true, data: { rows, total } }
}

// ─── 认领（crm:assignment:claim，契约 266 行）──────────────────────────────
export interface AssignActionResult { ok: boolean; data?: { assignmentId: number }; code?: string; message?: string }

/**
 * 认领：assigned → claimed（契约 S：重复 claim 被状态机拒）。
 * E301 无分配行；E201 非 assigned 态 / 非本人（actor 或身份档案姓名 ≠ sales_name）。
 * 归属没变 → 不写 ownership_history，只写 assignment 状态 + audit_event（action=lead_claim）。
 */
export function claimLead(leadId: number, actor: string): AssignActionResult {
  const id = Number(leadId)
  if (!Number.isInteger(id) || id <= 0) return { ok: false, code: 'E101', message: 'leadId 必填' }
  const by = String(actor || '').trim() || getActorLabel() || '分配员'
  const rows = crmDbService.all('SELECT * FROM assignment WHERE lead_id = ? AND deleted = 0 ORDER BY id DESC LIMIT 1', [id])
  if (!rows.length) return { ok: false, code: 'E301', message: '该线索无分配行' }
  const row = rows[0]
  if (String(row.status) !== 'assigned') return { ok: false, code: 'E201', message: `当前状态 ${String(row.status)} 不可认领` }
  const me = getIdentity()?.name || ''
  if (String(row.sales_name) !== by && (!me || String(row.sales_name) !== me)) {
    return { ok: false, code: 'E201', message: `非本人分配（归属 ${String(row.sales_name)}）` }
  }
  const now = Date.now()
  crmDbService.runTx((tx) => {
    tx.run("UPDATE assignment SET status = 'claimed', updated_by = ?, updated_at = ?, version = version + 1 WHERE id = ? AND status = 'assigned'", [by, now, row.id])
    tx.run('INSERT INTO audit_event (actor, action, entity_type, entity_id, detail, created_at) VALUES (?,?,?,?,?,?)',
      [by, 'lead_claim', 'lead', id, JSON.stringify({ assignmentId: Number(row.id), salesName: String(row.sales_name) }), now])
    // outbox 登记（上行 claim 认领回执，同步设计 §3）
    recordOutboxTx(tx, 'claim', `claim:${Number(row.id)}`, { leadId: id, assignmentId: Number(row.id), salesName: String(row.sales_name), actor: by }, now)
  })
  return { ok: true, data: { assignmentId: Number(row.id) } }
}

// ─── 回收（crm:assignment:recycle，契约 267 行）─────────────────────────────
/**
 * 回收：有效分配行（assigned/claimed）→ recycled，lead 回资源池。
 * E301 行不存在；E202 已回收；E201 已移交（当前分配在新行，不可回收旧行）。
 * 同事务：assignment 状态 + ownership_history（reason=回收类）+ audit_event（lead_recycle）
 *   + lead.first_contact_deadline 重置回 2100 哨兵（回资源池 = 待分配、不起计时）。
 */
export function recycleAssignment(assignmentId: number, reason: string, actor: string): AssignActionResult {
  const id = Number(assignmentId)
  if (!Number.isInteger(id) || id <= 0) return { ok: false, code: 'E101', message: 'assignmentId 必填' }
  const by = String(actor || '').trim() || getActorLabel() || '分配员'
  const rows = crmDbService.all('SELECT * FROM assignment WHERE id = ? AND deleted = 0', [id])
  if (!rows.length) return { ok: false, code: 'E301', message: '分配行不存在' }
  const row = rows[0]
  if (String(row.status) === 'recycled') return { ok: false, code: 'E202', message: '该分配已回收' }
  if (String(row.status) === 'transferred') return { ok: false, code: 'E201', message: '该分配已移交，当前分配在新行' }
  // Q2 拦截（内网同步设计 §4）：lead 已转客户（已挂 account）→ 跳过回收、不下发 recycle 事件，
  // 写审计（detail.reason='converted_skip'）。回收器每轮会再命中同一行 → 用 scan_state 标记
  // `convertedSkip:<assignmentId>` 保证一行只留一条拦截审计，不每 30 分钟刷屏。
  const leadRow = crmDbService.all('SELECT account_id FROM lead WHERE id = ?', [Number(row.lead_id)])[0]
  if (leadRow && Number(leadRow.account_id || 0) > 0) {
    const marker = `convertedSkip:${id}`
    if (crmDbService.getScanState(marker) <= 0) {
      const markedAt = Date.now()
      crmDbService.runTx((tx) => {
        tx.run('INSERT INTO audit_event (actor, action, entity_type, entity_id, detail, created_at) VALUES (?,?,?,?,?,?)',
          [by, 'lead_recycle', 'lead', Number(row.lead_id), JSON.stringify({ assignmentId: id, salesName: String(row.sales_name), reason: 'converted_skip', requestedReason: String(reason || '') }), markedAt])
        tx.run('INSERT INTO scan_state (key, last_scan) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET last_scan = excluded.last_scan', [marker, markedAt])
      })
    }
    return { ok: false, code: 'E205', message: '该线索已转客户，跳过回收（converted_skip）' }
  }
  const why = String(reason || '').trim() || '回收'
  const now = Date.now()
  crmDbService.runTx((tx) => {
    tx.run("UPDATE assignment SET status = 'recycled', updated_by = ?, updated_at = ?, version = version + 1 WHERE id = ? AND status IN ('assigned','claimed')", [by, now, id])
    tx.run('INSERT INTO ownership_history (entity_type, entity_id, old_owner, new_owner, reason, actor, created_at) VALUES (?,?,?,?,?,?,?)',
      ['lead', Number(row.lead_id), String(row.sales_name), '', why, by, now])
    tx.run('INSERT INTO audit_event (actor, action, entity_type, entity_id, detail, created_at) VALUES (?,?,?,?,?,?)',
      [by, 'lead_recycle', 'lead', Number(row.lead_id), JSON.stringify({ assignmentId: id, salesName: String(row.sales_name), reason: why }), now])
    tx.run('UPDATE lead SET first_contact_deadline = ?, updated_at = ? WHERE id = ?', [LEAD_SLA_UNASSIGNED_SENTINEL, now, Number(row.lead_id)])
    // outbox 登记（下行 recycle 事件，同步设计 §3）
    recordOutboxTx(tx, 'recycle', `recycle:${id}`, { leadId: Number(row.lead_id), assignmentId: id, salesName: String(row.sales_name), reason: why, actor: by }, now)
  })
  return { ok: true, data: { assignmentId: id } }
}

// ─── 移交（crm:assignment:transfer，契约 268 行）─────────────────────────────
/**
 * 移交：旧行 → transferred + 新建 assigned 行（toSales，重新起 SLA1 计时）。
 * E301 行不存在；E201 非有效态 / 目标=当前归属；E203 目标销售不在 config crmSalesList。
 * 同事务：assignment 双行 + ownership_history（reason=移交类）+ audit_event（lead_transfer）
 *   + lead.first_contact_deadline 跟随新 sla1_deadline。
 * 离职移交批量 = 循环调本函数（契约原文），不复活旧 reassign。
 */
export function transferAssignment(assignmentId: number, toSales: string, reason: string, actor: string): AssignActionResult {
  const id = Number(assignmentId)
  const target = String(toSales || '').trim()
  if (!Number.isInteger(id) || id <= 0 || !target) return { ok: false, code: 'E101', message: 'assignmentId 与 toSales 必填' }
  const by = String(actor || '').trim() || getActorLabel() || '分配员'
  const rows = crmDbService.all('SELECT * FROM assignment WHERE id = ? AND deleted = 0', [id])
  if (!rows.length) return { ok: false, code: 'E301', message: '分配行不存在' }
  const row = rows[0]
  if (String(row.status) !== 'assigned' && String(row.status) !== 'claimed') {
    return { ok: false, code: 'E201', message: `当前状态 ${String(row.status)} 不可移交` }
  }
  if (String(row.sales_name) === target) return { ok: false, code: 'E201', message: '目标销售与当前归属相同' }
  const salesList = ConfigService.getInstance().get('crmSalesList')
  if (!Array.isArray(salesList) || !salesList.map((s) => String(s).trim()).includes(target)) {
    return { ok: false, code: 'E203', message: `目标销售不存在（${target} 不在销售名单）` }
  }
  const why = String(reason || '').trim() || '移交'
  const now = Date.now()
  const sla1 = now + sla1Ms()
  const newId = crmDbService.runTx((tx) => {
    tx.run("UPDATE assignment SET status = 'transferred', updated_by = ?, updated_at = ?, version = version + 1 WHERE id = ? AND status IN ('assigned','claimed')", [by, now, id])
    const nid = tx.run(
      'INSERT INTO assignment (lead_id, sales_name, mode, sla1_deadline, sla2_scan_ref, status, source, updated_by, updated_at, version, deleted) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [Number(row.lead_id), target, String(row.mode || 'manual'), sla1, '', 'assigned', 'transfer', by, now, 1, 0]
    )
    tx.run('INSERT INTO ownership_history (entity_type, entity_id, old_owner, new_owner, reason, actor, created_at) VALUES (?,?,?,?,?,?,?)',
      ['lead', Number(row.lead_id), String(row.sales_name), target, why, by, now])
    tx.run('INSERT INTO audit_event (actor, action, entity_type, entity_id, detail, created_at) VALUES (?,?,?,?,?,?)',
      [by, 'lead_transfer', 'lead', Number(row.lead_id), JSON.stringify({ fromSales: String(row.sales_name), toSales: target, reason: why, oldAssignmentId: id, assignmentId: nid }), now])
    tx.run('UPDATE lead SET first_contact_deadline = ?, updated_at = ? WHERE id = ?', [sla1, now, Number(row.lead_id)])
    // outbox 登记（下行 transfer 事件，同步设计 §3；key 用新行 id = 每次移交一条事件）
    recordOutboxTx(tx, 'transfer', `transfer:${nid}`, { leadId: Number(row.lead_id), fromSales: String(row.sales_name), toSales: target, reason: why, oldAssignmentId: id, assignmentId: nid, actor: by }, now)
    return nid
  })
  return { ok: true, data: { assignmentId: newId } }
}

// ─── SLA1 回收器（PRD 1.4 第一段「加了没有」机械计时，A 档引擎动作）──────────
/**
 * 扫描一轮：status='assigned' 且 sla1_deadline 已过期 → 逐条 recycle
 * （reason='SLA超时回收'，actor='system:sla'，审计/流水照写）。
 * claimed 不动（已认领进第二段「聊了没有」，由 LLM 扫描接管，本刀不做）；未过期不动；
 * **已停表（sla1_met_at 非 NULL，PRD 1.4a 加好友命中）不动**。
 * 返回回收条数；逐条独立事务，单条失败不阻塞其余。
 */
export function runSla1Recycle(now = Date.now()): { recycled: number } {
  const rows = crmDbService.all(
    "SELECT id FROM assignment WHERE deleted = 0 AND status = 'assigned' AND sla1_deadline IS NOT NULL AND sla1_met_at IS NULL AND sla1_deadline < ? ORDER BY id",
    [now]
  )
  let recycled = 0
  for (const r of rows) {
    const res = recycleAssignment(Number(r.id), 'SLA超时回收', 'system:sla')
    if (res.ok) recycled++
    else console.warn(`[CRM] SLA1 回收失败 assignment=${Number(r.id)}：${res.code} ${res.message}`)
  }
  return { recycled }
}

/** 回收器扫描间隔（分钟）：配置 crmSlaRecycleIntervalMin，5-1440，默认 30 */
function recycleIntervalMin(): number {
  const n = Number(ConfigService.getInstance().get('crmSlaRecycleIntervalMin') ?? 30)
  return Number.isFinite(n) && n >= 5 && n <= 1440 ? n : 30
}

let slaRecycleBoot: ReturnType<typeof setTimeout> | null = null
let slaRecycleTimer: ReturnType<typeof setInterval> | null = null

/**
 * 启动 SLA1 回收调度器（main.ts 启动链路调用，挂在自动备份/行动引擎调度器旁）。
 * 幂等：重复调用直接返回。启动延迟 60s 首扫（让迁移/补写先收尾），之后按间隔轮巡。
 */
export function startSlaRecycleScheduler(): void {
  if (slaRecycleTimer) return
  const tick = (): void => {
    try {
      const { recycled } = runSla1Recycle()
      if (recycled > 0) console.log(`[CRM] SLA1 超时回收 ${recycled} 条（actor=system:sla）`)
    } catch (e) {
      console.warn('[CRM] SLA1 回收扫描失败:', e)
    }
  }
  slaRecycleBoot = setTimeout(tick, 60 * 1000)
  if (slaRecycleBoot.unref) slaRecycleBoot.unref()
  slaRecycleTimer = setInterval(tick, recycleIntervalMin() * 60 * 1000)
  if (slaRecycleTimer.unref) slaRecycleTimer.unref()
}

// ─── 存量补写：历史分配行 sla1_deadline 回填（2026-09-04）───────────────────
/**
 * assign 起计时上线前的存量行 sla1_deadline 全 NULL；不回补的话回收器一上线就把存量全回收。
 * 补写 sla1_deadline = **补写执行时刻** + crmLeadSlaHours —— 给存量一个全新的首触窗口。
 * ⚠️ 事故教训（HANDOVER §2.54）：初版用「分配时刻（updated_at）+24h」，分配时刻在过去 →
 *    补写完立即全部过期 → 回收器首扫把 3,848 条存量一次性误回收。存量补写绝不能用过去的时间基点。
 * 幂等：只补 NULL 行，重跑命中 0 行。有实际补写时落一条汇总审计（actor='system:migration'）。
 */
export function backfillAssignmentSla1(): number {
  const rows = crmDbService.all(
    "SELECT id FROM assignment WHERE deleted = 0 AND status = 'assigned' AND sla1_deadline IS NULL ORDER BY id"
  )
  if (!rows.length) return 0
  const now = Date.now()
  const sla1 = now + sla1Ms()
  crmDbService.runTx((tx) => {
    for (const r of rows) {
      tx.run('UPDATE assignment SET sla1_deadline = ? WHERE id = ? AND sla1_deadline IS NULL', [sla1, Number(r.id)])
    }
    tx.run('INSERT INTO audit_event (actor, action, entity_type, entity_id, detail, created_at) VALUES (?,?,?,?,?,?)',
      ['system:migration', 'assignment_sla1_backfill', 'assignment', null, JSON.stringify({ count: rows.length, slaHours: sla1Hours(), base: 'now' }), now])
  })
  return rows.length
}

// ─── 纠正性恢复：SLA1 误扫回收的补偿性再分配（2026-09-04 事故，一次性迁移块）───
/**
 * 事故：backfill 初版口径「分配时刻+24h」导致存量 3,848 条补写完即全部过期，
 * 回收器首扫（actor='system:sla'）把它们一次性置 recycled（HANDOVER §2.54）。
 * 本函数 = 一次性纠正：为每条误扫 lead 补偿性再分配给原销售。
 *
 * 方案选择（B：插入新 assigned 行，不改写回收行）：
 *   ① 回收行是误扫的事实记录，保留它让「分配→回收→纠正分配」链路在 ownership/audit 上完整可对账；
 *   ② currentAssignment 取该 lead id 最大的有效行，新行自然成为当前归属，状态语义不破坏；
 *   ③ 方案 A（recycled→assigned 回写）会抹掉回收事实，违背 append-only 精神且 version 语义混乱。
 * ⛔ append-only 铁律：ownership_history / audit_event 历史行绝不删改，只用补偿流水纠正。
 *
 * 幂等双保险（沿 crmMigrationService 模式）：
 *   ① scan_state 一次性标记 'migration:sla1-misrecycle-correction'（与数据同事务）；
 *   ② 数据级判重：该 lead 已有当前有效分配（assigned/claimed）即跳过——已纠正的 lead 重跑全跳过。
 */
const MISRECYCLE_MARKER = 'migration:sla1-misrecycle-correction'
export interface CorrectionResult { skippedByMarker: boolean; total: number; corrected: number; alreadyAssigned: number }

export function correctSla1Misrecycle(): CorrectionResult {
  const r: CorrectionResult = { skippedByMarker: false, total: 0, corrected: 0, alreadyAssigned: 0 }
  if (crmDbService.getScanState(MISRECYCLE_MARKER) > 0) { r.skippedByMarker = true; return r }
  // 误扫行精确条件（live 副本核实命中=3,848，分布 许丽娟1511/李林辉1356/杨青981）：
  // recycled 且回收执行者 updated_by='system:sla'；事发时全部 recycled 行均出自误扫（无人工回收夹杂）
  const rows = crmDbService.all(
    "SELECT id, lead_id, sales_name, mode FROM assignment WHERE deleted = 0 AND status = 'recycled' AND updated_by = 'system:sla' ORDER BY id"
  )
  r.total = rows.length
  if (!rows.length) {
    crmDbService.runTx((tx) => {
      tx.run('INSERT INTO scan_state (key, last_scan) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET last_scan = excluded.last_scan', [MISRECYCLE_MARKER, Date.now()])
    })
    return r
  }
  const now = Date.now()
  const sla1 = now + sla1Ms()
  const by = 'system:correction'
  crmDbService.runTx((tx) => {
    for (const row of rows) {
      const leadId = Number(row.lead_id)
      const sales = String(row.sales_name)
      // 数据级判重：已有当前有效分配（含本函数上一轮补的新行）→ 跳过
      const cur = tx.all(`SELECT id FROM assignment WHERE lead_id = ? AND deleted = 0 AND ${ACTIVE_STATUS_SQL} ORDER BY id DESC LIMIT 1`, [leadId])
      if (cur.length) { r.alreadyAssigned++; continue }
      const newId = tx.run(
        'INSERT INTO assignment (lead_id, sales_name, mode, sla1_deadline, sla2_scan_ref, status, source, updated_by, updated_at, version, deleted) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        [leadId, sales, String(row.mode || 'manual'), sla1, '', 'assigned', 'system:correction', by, now, 1, 0]
      )
      // 补偿流水（append-only）：reason='分配'，actor='system:correction'；纠正说明写进 audit detail
      tx.run('INSERT INTO ownership_history (entity_type, entity_id, old_owner, new_owner, reason, actor, created_at) VALUES (?,?,?,?,?,?,?)',
        ['lead', leadId, '', sales, '分配', by, now])
      tx.run('INSERT INTO audit_event (actor, action, entity_type, entity_id, detail, created_at) VALUES (?,?,?,?,?,?)',
        [by, 'lead_assign', 'lead', leadId, JSON.stringify({ salesName: sales, assignmentId: newId, sla1Deadline: sla1, correction: 'SLA1误扫回收纠正', recycledAssignmentId: Number(row.id) }), now])
      // lead 首触期限同步恢复（不再是 2100 哨兵）
      tx.run('UPDATE lead SET first_contact_deadline = ?, updated_at = ? WHERE id = ?', [sla1, now, leadId])
      r.corrected++
    }
    // 汇总审计 + 一次性标记，与数据同事务
    tx.run('INSERT INTO audit_event (actor, action, entity_type, entity_id, detail, created_at) VALUES (?,?,?,?,?,?)',
      [by, 'sla1_misrecycle_correction', 'migration', null, JSON.stringify({ total: r.total, corrected: r.corrected, alreadyAssigned: r.alreadyAssigned, slaHours: sla1Hours() }), now])
    tx.run('INSERT INTO scan_state (key, last_scan) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET last_scan = excluded.last_scan', [MISRECYCLE_MARKER, now])
  })
  return r
}

// ─── 存量修复：lead 首触期限对齐当前有效分配（2026-09-04）───────────────────
/**
 * 不变量：lead.status='NEW' 且有有效分配（assigned/claimed）时，
 * lead.first_contact_deadline 必须 = 当前分配行 sla1_deadline（assignLeads/transfer/纠正块都守这条）。
 * 存量破坏来源：resetLegacyGroupScanSla 旧版每次启动把已分配群扫 lead 期限打回哨兵
 * （已修，排除有效分配）；本函数把 live 已被打回哨兵的 3,800+ 条修回对齐。
 * 幂等：只改不一致行；不改 lead 状态机、不动哨兵中的未分配 lead（资源池不起计时）。
 */
export function syncLeadDeadlineFromAssignment(): number {
  const now = Date.now()
  const MISMATCH_SQL = `FROM lead WHERE lead.status = 'NEW' AND EXISTS (
    SELECT 1 FROM assignment a
    WHERE a.lead_id = lead.id AND a.deleted = 0 AND ${ACTIVE_STATUS_SQL} AND a.sla1_deadline IS NOT NULL
      AND a.sla1_deadline <> lead.first_contact_deadline
  )`
  // ⚠️ runTx 的 tx.run 返回 last_insert_rowid 而非修改行数（UPDATE 下是旧值），
  // 只能前后数差算命中数
  const before = Number(crmDbService.all(`SELECT COUNT(*) AS c ${MISMATCH_SQL}`)[0]?.c ?? 0)
  if (!before) return 0
  crmDbService.runTx((tx) => {
    tx.run(
      `UPDATE lead SET first_contact_deadline = (
         SELECT a.sla1_deadline FROM assignment a
         WHERE a.lead_id = lead.id AND a.deleted = 0 AND ${ACTIVE_STATUS_SQL} AND a.sla1_deadline IS NOT NULL
         ORDER BY a.id DESC LIMIT 1
       ), updated_at = ?
       WHERE lead.status = 'NEW' AND EXISTS (
         SELECT 1 FROM assignment a
         WHERE a.lead_id = lead.id AND a.deleted = 0 AND ${ACTIVE_STATUS_SQL} AND a.sla1_deadline IS NOT NULL
           AND a.sla1_deadline <> lead.first_contact_deadline
       )`,
      [now])
  })
  const after = Number(crmDbService.all(`SELECT COUNT(*) AS c ${MISMATCH_SQL}`)[0]?.c ?? 0)
  const aligned = before - after
  if (aligned > 0) console.log(`[CRM] lead 首触期限对齐当前分配：${aligned} 条`)
  return aligned
}

// ─── 存量处置：群扫旧 tag 归属恢复为正式分配（2026-09-03 用户当面拍板「恢复成正式分配」）───
/**
 * 群扫时代 lead.tag 当归属用，§2.47 清理时把旧值挪进 note（曾归属:{tag}（日期））。
 * 用户拍板恢复成正式分配：杨青→杨青、李林辉→李林辉、秒变→许丽娟（外号，用户确认）、
 * 静候→丁帅（已离职，不挂名，留资源池）、未分配→留资源池。
 * 复用 assignLeads（自带 E201 幂等：已有有效分配的跳过），天然幂等。
 * 分配纪律同 §1.3/契约：assignment + ownership_history + audit_event 单事务。
 */
export function restoreLegacyGroupScanAssignments(): { restored: Record<string, number>; pooled: number } {
  const TAG_TO_SALES: Record<string, string | null> = {
    '杨青': '杨青',
    '李林辉': '李林辉',
    '秒变': '许丽娟',
    '静候': null, // 丁帅，已离职，不挂名
    '未分配': null
  }
  const rows = crmDbService.all(
    "SELECT id, note FROM lead WHERE source = '群资源扫描' AND note LIKE '%曾归属:%'"
  )
  const bySales = new Map<string, number[]>()
  let pooled = 0
  for (const r of rows) {
    // note 可能含多个历史「曾归属」标记（群扫时代多次换归属 + 今日清理追加）；
    // 字符串顺序即时间顺序，取**最后一个** = 清理时的最终归属
    const marks = [...String(r.note || '').matchAll(/曾归属:([^（；;]+)/g)]
    if (!marks.length) { pooled++; continue }
    const target = TAG_TO_SALES[marks[marks.length - 1][1].trim()]
    if (!target) { pooled++; continue } // 静候/未分配/未知旧值 → 留资源池
    const list = bySales.get(target) || []
    list.push(Number(r.id))
    bySales.set(target, list)
  }
  const restored: Record<string, number> = {}
  for (const [sales, ids] of bySales) {
    const res = assignLeads(ids, sales, 'system:migration', 'manual')
    restored[sales] = res.ok && res.data ? res.data.assignments.length : 0
  }
  const total = Object.values(restored).reduce((a, b) => a + b, 0)
  if (total > 0) console.log(`[CRM] 群扫旧归属恢复为正式分配：${JSON.stringify(restored)}，留资源池 ${pooled} 条`)
  return { restored, pooled }
}
