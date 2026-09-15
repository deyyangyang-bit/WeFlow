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
 * SLA1 三次提醒回收器（PRD 1.4 + 设计稿屏 4/屏 6，2026-09-05）：assigned/claimed 且 sla1_deadline 过期
 *   且未停表 → 第 1/2 次只提醒（sla1_remind_count+1+审计），满第 3 次才自动回收 + 主管通知事件；
 *   A 档引擎动作（规则驱动非 LLM，宪法 §1.3），审计照写（actor='system:sla'）。
 */
import { crmDbService, type CrmRow } from './crmDbService'
import { getIdentity, getActorLabel } from './identityService'
import { recordOutboxTx } from './crmOutboxService'
import { recordSupervisorNotificationTx } from './crmNotifyService'
import { outboxTransportEnabled } from './lanSyncService'
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
 * 同事务写 claimed_at=now（宪法 §1.3 修订 2026-09-10：认领计时唯一基准，PRD 2.4 首次分类触发轴；
 * 禁止用 updated_at 反推——提醒/回收等动作会刷新 updated_at）。
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
    tx.run("UPDATE assignment SET status = 'claimed', claimed_at = ?, updated_by = ?, updated_at = ?, version = version + 1 WHERE id = ? AND status = 'assigned'", [now, by, now, row.id])
    tx.run('INSERT INTO audit_event (actor, action, entity_type, entity_id, detail, created_at) VALUES (?,?,?,?,?,?)',
      [by, 'lead_claim', 'lead', id, JSON.stringify({ assignmentId: Number(row.id), salesName: String(row.sales_name) }), now])
    // outbox 登记（上行 claim 认领回执，同步设计 §3；claimedAt 与本地 assignment.claimed_at 同一 now，
    // 中枢回放落 claimed_at——PRD 2.4 首次分类 24h 触发轴跨机一致）
    recordOutboxTx(tx, 'claim', `claim:${Number(row.id)}`, { leadId: id, assignmentId: Number(row.id), salesName: String(row.sales_name), actor: by, claimedAt: now }, now)
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
/**
 * 回收核心（可在调用方事务内执行）：状态校验 + Q2 converted_skip 拦截 + 三表写
 * （assignment + ownership_history + audit_event）+ lead 期限回哨兵 + recycle outbox 登记。
 * 业务规则唯一真源；recycleAssignment（独立事务）与 runSla1Recycle 的「回收+主管通知原子事务」
 * 都复用本核心，避免复制规则导致口径漂移（2026-09-09 原子化提取）。
 */
export function recycleAssignmentTx(
  tx: { run: (sql: string, params?: unknown[]) => number; all: (sql: string, params?: unknown[]) => CrmRow[] },
  assignmentId: number,
  reason: string,
  actor: string
): AssignActionResult {
  const id = Number(assignmentId)
  if (!Number.isInteger(id) || id <= 0) return { ok: false, code: 'E101', message: 'assignmentId 必填' }
  const by = String(actor || '').trim() || getActorLabel() || '分配员'
  const rows = tx.all('SELECT * FROM assignment WHERE id = ? AND deleted = 0', [id])
  if (!rows.length) return { ok: false, code: 'E301', message: '分配行不存在' }
  const row = rows[0]
  if (String(row.status) === 'recycled') return { ok: false, code: 'E202', message: '该分配已回收' }
  if (String(row.status) === 'transferred') return { ok: false, code: 'E201', message: '该分配已移交，当前分配在新行' }
  // Q2 拦截（内网同步设计 §4）：lead 已转客户（已挂 account）→ 跳过回收、不下发 recycle 事件，
  // 写审计（detail.reason='converted_skip'）。回收器每轮会再命中同一行 → 用 scan_state 标记
  // `convertedSkip:<assignmentId>` 保证一行只留一条拦截审计，不每 30 分钟刷屏。
  const leadRow = tx.all('SELECT account_id FROM lead WHERE id = ?', [Number(row.lead_id)])[0]
  if (leadRow && Number(leadRow.account_id || 0) > 0) {
    const marker = `convertedSkip:${id}`
    if (Number(tx.all('SELECT last_scan FROM scan_state WHERE key = ?', [marker])[0]?.last_scan || 0) <= 0) {
      const markedAt = Date.now()
      tx.run('INSERT INTO audit_event (actor, action, entity_type, entity_id, detail, created_at) VALUES (?,?,?,?,?,?)',
        [by, 'lead_recycle', 'lead', Number(row.lead_id), JSON.stringify({ assignmentId: id, salesName: String(row.sales_name), reason: 'converted_skip', requestedReason: String(reason || '') }), markedAt])
      tx.run('INSERT INTO scan_state (key, last_scan) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET last_scan = excluded.last_scan', [marker, markedAt])
    }
    return { ok: false, code: 'E205', message: '该线索已转客户，跳过回收（converted_skip）' }
  }
  const why = String(reason || '').trim() || '回收'
  const now = Date.now()
  tx.run("UPDATE assignment SET status = 'recycled', updated_by = ?, updated_at = ?, version = version + 1 WHERE id = ? AND status IN ('assigned','claimed')", [by, now, id])
  tx.run('INSERT INTO ownership_history (entity_type, entity_id, old_owner, new_owner, reason, actor, created_at) VALUES (?,?,?,?,?,?,?)',
    ['lead', Number(row.lead_id), String(row.sales_name), '', why, by, now])
  tx.run('INSERT INTO audit_event (actor, action, entity_type, entity_id, detail, created_at) VALUES (?,?,?,?,?,?)',
    [by, 'lead_recycle', 'lead', Number(row.lead_id), JSON.stringify({ assignmentId: id, salesName: String(row.sales_name), reason: why }), now])
  tx.run('UPDATE lead SET first_contact_deadline = ?, updated_at = ? WHERE id = ?', [LEAD_SLA_UNASSIGNED_SENTINEL, now, Number(row.lead_id)])
  // outbox 登记（下行 recycle 事件，同步设计 §3）
  recordOutboxTx(tx, 'recycle', `recycle:${id}`, { leadId: Number(row.lead_id), assignmentId: id, salesName: String(row.sales_name), reason: why, actor: by }, now)
  return { ok: true, data: { assignmentId: id } }
}

/** 回收（crm:assignment:recycle，契约 267 行）：recycleAssignmentTx 独立事务包装（信封语义不变）。 */
export function recycleAssignment(assignmentId: number, reason: string, actor: string): AssignActionResult {
  const id = Number(assignmentId)
  if (!Number.isInteger(id) || id <= 0) return { ok: false, code: 'E101', message: 'assignmentId 必填' }
  return crmDbService.runTx((tx) => recycleAssignmentTx(tx, id, reason, actor))
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
  const mode = String(row.mode || 'manual')
  const newId = crmDbService.runTx((tx) => {
    tx.run("UPDATE assignment SET status = 'transferred', updated_by = ?, updated_at = ?, version = version + 1 WHERE id = ? AND status IN ('assigned','claimed')", [by, now, id])
    const nid = tx.run(
      'INSERT INTO assignment (lead_id, sales_name, mode, sla1_deadline, sla2_scan_ref, status, source, updated_by, updated_at, version, deleted) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [Number(row.lead_id), target, mode, sla1, '', 'assigned', 'transfer', by, now, 1, 0]
    )
    tx.run('INSERT INTO ownership_history (entity_type, entity_id, old_owner, new_owner, reason, actor, created_at) VALUES (?,?,?,?,?,?,?)',
      ['lead', Number(row.lead_id), String(row.sales_name), target, why, by, now])
    tx.run('INSERT INTO audit_event (actor, action, entity_type, entity_id, detail, created_at) VALUES (?,?,?,?,?,?)',
      [by, 'lead_transfer', 'lead', Number(row.lead_id), JSON.stringify({ fromSales: String(row.sales_name), toSales: target, reason: why, oldAssignmentId: id, assignmentId: nid }), now])
    tx.run('UPDATE lead SET first_contact_deadline = ?, updated_at = ? WHERE id = ?', [sla1, now, Number(row.lead_id)])
    // outbox 登记（下行 transfer 事件，同步设计 §3；key 用新行 id = 每次移交一条事件）。
    // sla1Deadline/mode 是移交事实产生时就确定的值，必须随指令传递：接收端落地精确等于本值，
    // 绝不按接收端当前配置/时钟重算（2026-09-15 修复：此前缺这两个字段，接收端 sla1_deadline 落 NULL）。
    recordOutboxTx(tx, 'transfer', `transfer:${nid}`, { leadId: Number(row.lead_id), fromSales: String(row.sales_name), toSales: target, reason: why, oldAssignmentId: id, assignmentId: nid, mode, sla1Deadline: sla1, actor: by }, now)
    return nid
  })
  return { ok: true, data: { assignmentId: newId } }
}

// ─── SLA1 三次提醒回收器（PRD 1.4 第一段「加了没有」+ 设计稿屏 4/屏 6 三次提醒制，A 档引擎动作）──
/** 已提醒行距上次动作的最小间隔：20h（复查节奏 24h，回收器默认 30 分钟轮巡 → 20h 护栏防一轮刷满 3 次） */
const SLA1_REMIND_MIN_GAP_MS = 20 * 3600_000
/**
 * 扫描一轮（三次提醒制，宪法 §1.3 修订 2026-09-05）：
 * 范围 = status IN ('assigned','claimed') 且 sla1_deadline 已过期且未停表（sla1_met_at IS NULL）——
 * claimed 行的 SLA 语义 = 认领后 24h 内加好友，认领不重置计时（沿用分配时的 sla1_deadline）。
 *   sla1_remind_count < 2 → 提醒第 N 次：计数 +1 + audit_event(action='sla1_remind'，detail 含第几次)
 *     + assignment 状态/归属零变更（ownership_history 不写、lead 不动）；已提醒过（count≥1）的行
 *     距上次动作（updated_at）≥20h 才允许下一次提醒——§2.54 教训延伸：回收器不凭「行存在即处置」，
 *     须尊重计数与间隔状态，防 30 分钟轮巡把 3 次一次刷完。
 *   count ≥ 2（第 3 次超时）→ 回收与主管通知「同一事务」原子落地（2026-09-09，
 *     recycleAssignmentTx 核心复用）：LAN 同步启用时同事务登记 sla1_escalate_supervisor outbox
 *     走中枢投递；单机模式同事务直接写 notify_inbox。通知/outbox 写失败整体回滚、下轮重试，
 *     幂等键保证恢复后最终只产生一条通知。
 * 已停表行（绑定微信/自动检测命中）不在扫描范围，自然跳过；逐条独立事务，单条失败不阻塞其余。
 */
export function runSla1Recycle(now = Date.now()): { recycled: number; reminded: number } {
  const rows = crmDbService.all(
    "SELECT * FROM assignment WHERE deleted = 0 AND status IN ('assigned','claimed') AND sla1_deadline IS NOT NULL AND sla1_met_at IS NULL AND sla1_deadline < ? ORDER BY id",
    [now]
  )
  let recycled = 0
  let reminded = 0
  for (const r of rows) {
    const id = Number(r.id)
    const count = Number(r.sla1_remind_count || 0)
    if (count < 2) {
      // 间隔护栏：首提（count=0）不受限；已提醒行距上次 ≥20h 才再提醒
      if (count > 0 && now - Number(r.updated_at || 0) < SLA1_REMIND_MIN_GAP_MS) continue
      const remindNo = count + 1
      try {
        crmDbService.runTx((tx) => {
          // 条件带 status IN (assigned,claimed) AND sla1_met_at IS NULL：与扫描口径一致，防并发窗口误写
          tx.run("UPDATE assignment SET sla1_remind_count = ?, updated_at = ?, version = version + 1 WHERE id = ? AND status IN ('assigned','claimed') AND sla1_met_at IS NULL", [remindNo, now, id])
          tx.run('INSERT INTO audit_event (actor, action, entity_type, entity_id, detail, created_at) VALUES (?,?,?,?,?,?)',
            ['system:sla', 'sla1_remind', 'lead', Number(r.lead_id),
             JSON.stringify({ assignmentId: id, salesName: String(r.sales_name), remindNo, total: 3, deadline: Number(r.sla1_deadline) }), now])
        })
        reminded++
      } catch (e) {
        console.warn(`[CRM] SLA1 提醒失败 assignment=${id}：${e}`)
      }
    } else {
      // 满第 3 次：「回收 + 主管通知」同一事务原子落地（2026-09-09）——
      //   LAN 同步启用：recycleAssignmentTx 三表写 + sla1_escalate_supervisor outbox 登记同事务；
      //   单机：recycleAssignmentTx + recordSupervisorNotificationTx（notify_inbox）同事务。
      // 通知/outbox 写失败 → 整体回滚 → assignment 仍 assigned/claimed，下轮扫描自然重试；
      // 幂等：recycleAssignmentTx 状态机拒重复回收，outbox/notify_inbox 幂等键拒重复登记——
      // 绝不出现「已回收但既无 notify_inbox 又无待发送 outbox」的脱节状态。
      try {
        const notification = {
          idempotencyKey: `sla1Escalate:${id}`,
          leadId: Number(r.lead_id),
          salesName: String(r.sales_name),
          remindCount: 3,
          reason: 'SLA三次超时回收',
          recycledAt: now
        }
        const res = crmDbService.runTx((tx) => {
          const rec = recycleAssignmentTx(tx, id, 'SLA三次超时回收', 'system:sla')
          if (!rec.ok) return rec
          // 任一传输层启用（SMB 或中央 HTTP）都必须登记 outbox：中央启用会关掉 SMB，
          // 若这里仍只看 SMB，主管升级通知将既不进 outbox 也不出机（§三.6）。
          if (outboxTransportEnabled()) {
            recordOutboxTx(tx, 'sla1_escalate_supervisor', notification.idempotencyKey, { leadId: notification.leadId, assignmentId: id, salesName: notification.salesName, remindCount: 3, reason: notification.reason, recycledAt: notification.recycledAt }, now)
          } else {
            recordSupervisorNotificationTx(tx, notification, 'local:sla')
          }
          return rec
        })
        if (res.ok) recycled++
        else console.warn(`[CRM] SLA1 回收失败 assignment=${id}：${res.code} ${res.message}`)
      } catch (e) {
        console.warn(`[CRM] SLA1 回收+主管通知原子事务失败（已回滚，待下轮重试）assignment=${id}：${e}`)
      }
    }
  }
  return { recycled, reminded }
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
      const { recycled, reminded } = runSla1Recycle()
      if (recycled > 0) console.log(`[CRM] SLA1 三次超时回收 ${recycled} 条（actor=system:sla，主管通知已登记投递）`)
      if (reminded > 0) console.log(`[CRM] SLA1 超时提醒 ${reminded} 条（三次提醒制）`)
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

// ─── 审计流水查询（crm:audit:query，API-CONTRACT §1.14 契约端点）──────────────
export interface AuditQueryOpts { entityType?: string; entityId?: number; actor?: string; action?: string; keyword?: string; beginAt?: number; endAt?: number; page?: number; pageSize?: number }

/**
 * action 类别过滤（人话化设计稿 §01 筛选 chips）→ action 值清单。
 * assign  = lead_assign/lead_transfer/lead_claim/departure_handoff；
 * bind    = identity_bind；recycle = lead_recycle；
 * weight  = 精确匹配 assignment_weight_change（§2.75 遗留补齐：写点 = main.ts config:set 拦截，宪法 §3 登记）；
 * remind  = SLA1 三段提醒 + 主管上报（设计稿 §01 新增）；
 * config  = 改变系统行为口径的操作：分配权重 / AI 额度 / SLA 存量清零 / 归属残留清理 / SLA 回填 / 误回收纠正
 *           （设计稿 §01 新增；`weight` 保留为精确子集，供既有调用方与测试沿用）。
 * 导出供 scripts/audit-dict-test.ts 守卫「chips 的每个 id 都有对应类别」。
 */
export const AUDIT_ACTION_CATEGORY: Record<string, string[]> = {
  assign: ['lead_assign', 'lead_transfer', 'lead_claim', 'departure_handoff'],
  bind: ['identity_bind'],
  recycle: ['lead_recycle'],
  weight: ['assignment_weight_change'],
  remind: ['sla1_remind', 'sla1_supervisor_notify'],
  config: [
    'assignment_weight_change',
    'ai_daily_limit_change',
    'lead_sla_stock_reset',
    'lead_tag_owner_cleanup',
    'assignment_sla1_backfill',
    'sla1_misrecycle_correction'
  ]
}

/** 单次标签解析的 id 上限（整页最多 100 行，正常远达不到；防御异常入参撑爆 IN 列表） */
const LABEL_LOOKUP_MAX = 500

/**
 * 实体显示名解析（纯读，不写库）：把整页行的 entity_type/entity_id 批量换成可读名。
 * 仅覆盖有稳定名称列的实体（lead/account/customer）——其余类型不编造名字，
 * 由渲染层回落到 `#id`（契约：解析不到显示原名，不留空白）。
 * 一次查询覆盖整页，不做 N+1。返回 key = `<entity_type>:<entity_id>`。
 */
function resolveEntityLabels(rows: CrmRow[]): Record<string, string> {
  const txt = (v: unknown): string => String(v ?? '').trim()
  const idsOf = (type: string): number[] => Array.from(new Set(
    rows.filter((r) => r.entity_type === type && Number(r.entity_id) > 0).map((r) => Number(r.entity_id))
  )).slice(0, LABEL_LOOKUP_MAX)
  const out: Record<string, string> = {}
  const put = (type: string, id: unknown, label: string): void => {
    const name = label.trim()
    if (name) out[`${type}:${Number(id)}`] = name
  }
  const leadIds = idsOf('lead')
  if (leadIds.length) {
    const ph = leadIds.map(() => '?').join(',')
    const rowsL = crmDbService.all(
      `SELECT id, name, contact_raw, contact_normalized, wechat FROM lead WHERE id IN (${ph})`, leadIds
    )
    for (const r of rowsL) {
      // 线索名常为空（实测库中约 48%）：回落到联系方式——仍远比 `lead #4680` 可读
      put('lead', r.id, txt(r.name) || txt(r.contact_raw) || txt(r.contact_normalized) || txt(r.wechat))
    }
  }
  for (const type of ['account', 'customer'] as const) {
    const ids = idsOf(type)
    if (!ids.length) continue
    const ph = ids.map(() => '?').join(',')
    for (const r of crmDbService.all(`SELECT id, name FROM ${type} WHERE id IN (${ph})`, ids)) {
      put(type, r.id, txt(r.name))
    }
  }
  return out
}

/** 审计流水查询（R，只读，append-only 表无软删列）：契约参数 + keyword 扩展（actor/detail/entity 一把搜） */
export function queryAuditEvents(opts: AuditQueryOpts = {}): {
  ok: boolean
  data: { rows: CrmRow[]; total: number; labels: Record<string, string> }
} {
  const where: string[] = ['1=1']
  const params: unknown[] = []
  const entityType = String(opts.entityType || '').trim()
  if (entityType) { where.push('entity_type = ?'); params.push(entityType) }
  if (opts.entityId !== undefined && Number(opts.entityId) > 0) { where.push('entity_id = ?'); params.push(Number(opts.entityId)) }
  const actor = String(opts.actor || '').trim()
  if (actor) { where.push('actor LIKE ?'); params.push(`%${actor}%`) }
  // 显式 action 优先；否则按类别映射
  const action = String(opts.action || '').trim()
  if (action) {
    if (AUDIT_ACTION_CATEGORY[action]) {
      const list = AUDIT_ACTION_CATEGORY[action]
      where.push(`action IN (${list.map(() => '?').join(',')})`)
      params.push(...list)
    } else { where.push('action = ?'); params.push(action) }
  }
  const keyword = String(opts.keyword || '').trim()
  if (keyword) {
    where.push('(actor LIKE ? OR detail LIKE ? OR entity_type LIKE ? OR CAST(entity_id AS TEXT) = ?)')
    const like = `%${keyword}%`
    params.push(like, like, like, keyword)
  }
  if (Number(opts.beginAt) > 0) { where.push('created_at >= ?'); params.push(Number(opts.beginAt)) }
  if (Number(opts.endAt) > 0) { where.push('created_at <= ?'); params.push(Number(opts.endAt)) }
  const page = Math.max(1, Number(opts.page) || 1)
  const pageSize = Math.min(100000, Math.max(1, Number(opts.pageSize) || 50))
  const w = ' WHERE ' + where.join(' AND ')
  const total = Number(crmDbService.all(`SELECT COUNT(*) AS c FROM audit_event${w}`, params)[0]?.c || 0)
  const rows = crmDbService.all(`SELECT * FROM audit_event${w} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`, [...params, pageSize, (page - 1) * pageSize])
  return { ok: true, data: { rows, total, labels: resolveEntityLabels(rows) } }
}

// ─── 归属留痕时间线（crm:ownership:history，API-CONTRACT §1.14 契约端点）──────
export interface OwnershipHistoryOpts { entityType?: string; entityId?: number; page?: number; pageSize?: number }

/** 归属留痕查询（R，只读，append-only）：按实体取时间线，新→旧 */
export function listOwnershipHistory(opts: OwnershipHistoryOpts = {}): { ok: boolean; data: { rows: CrmRow[]; total: number } } {
  const entityType = String(opts.entityType || '').trim()
  const entityId = Number(opts.entityId) || 0
  if (!entityType || entityId <= 0) return { ok: false, data: { rows: [], total: 0 } }
  const page = Math.max(1, Number(opts.page) || 1)
  const pageSize = Math.min(100000, Math.max(1, Number(opts.pageSize) || 100))
  const total = Number(crmDbService.all('SELECT COUNT(*) AS c FROM ownership_history WHERE entity_type = ? AND entity_id = ?', [entityType, entityId])[0]?.c || 0)
  const rows = crmDbService.all(
    'SELECT * FROM ownership_history WHERE entity_type = ? AND entity_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?',
    [entityType, entityId, pageSize, (page - 1) * pageSize]
  )
  return { ok: true, data: { rows, total } }
}

// ─── 批量分配（crm:assignment:assignBatch，设计稿屏 3 分配控制台）─────────────
export interface AssignBatchInput {
  /** 本次从待分配池取的条数 */
  count: number
  /** 分配模式（落 assignment.mode）：weight=比例权重（默认）/ round_robin=轮询 / load=负载均衡 */
  mode: 'weight' | 'round_robin' | 'load'
  /** weight 模式的权重表（销售名 → 0-100；缺省等权） */
  weights?: Record<string, number>
  actor?: string
}
export interface AssignBatchData {
  /** 批次号 = '#A' + 批次审计行号（不建新列，可追溯到操作人，设计稿屏 3 口径） */
  batchNo: string
  assigned: number
  skipped: Array<{ leadId: number; code: string; reason: string }>
  perSales: Record<string, number>
  mode: string
}
export interface AssignBatchResult { ok: boolean; data?: AssignBatchData; code?: string; message?: string }

/**
 * 按模式把 N 条待分配线索分给销售名单：
 *   待分配池 = lead.status='NEW' 且无当前有效分配行（SQL 取，避免逐条 currentAssignment N+1）；
 *   分配方式 = 按模式算出各人份额 → 逐组走现有 assignLeads（同事务写 assignment + ownership_history +
 *   audit_event + outbox + lead.first_contact_deadline 起计时，mode 落 assignment.mode）；
 *   收尾写一行批次审计 action='lead_assign_batch'（detail 含模式/数量/份额/跳过），批次号 = '#A'+审计行号。
 *   权重调整属 C 类操作（宪法 §1.3），调整在前端写 config crmAssignWeights（应用内审计另行记录，本函数只读权重）。
 */
export function assignBatchLeads(input: AssignBatchInput): AssignBatchResult {
  const sales = (ConfigService.getInstance().get('crmSalesList') || []).map((s) => String(s).trim()).filter(Boolean)
  if (!sales.length) return { ok: false, code: 'E101', message: '还没有销售名单。请先到线索页「资源池」勾选线索后点击「分配给…」，在弹窗中添加销售姓名。' }
  const mode = (['weight', 'round_robin', 'load'] as const).includes(input?.mode as never) ? input.mode : 'weight'
  const weights = input?.weights && typeof input.weights === 'object' ? input.weights : {}
  const count = Math.max(1, Math.floor(Number(input?.count) || 0))

  // 待分配池（NEW 且无当前有效分配行），按导入先后（id ASC）取前 N
  const pool = crmDbService.all(
    `SELECT l.id FROM lead l WHERE l.status = 'NEW' AND NOT EXISTS (
       SELECT 1 FROM assignment a WHERE a.lead_id = l.id AND a.deleted = 0 AND ${ACTIVE_STATUS_SQL})
     ORDER BY l.id LIMIT ?`,
    [count]
  ).map((r) => Number(r.id))
  if (!pool.length) return { ok: false, code: 'E301', message: '待分配池为空' }

  // 各人在手条数（当前有效归属）
  const loads: Record<string, number> = {}
  for (const s of sales) loads[s] = 0
  const loadRows = crmDbService.all(
    `SELECT sales_name, COUNT(*) AS c FROM assignment WHERE deleted = 0 AND ${ACTIVE_STATUS_SQL} GROUP BY sales_name`
  )
  for (const r of loadRows) if (loads[String(r.sales_name)] !== undefined) loads[String(r.sales_name)] = Number(r.c)

  // 份额计算（纯函数 distributePreview 同口径，见 leadAssignmentView.ts / 共享逻辑在 buildDistribution）
  const plan = buildDistribution(mode, pool.length, sales, weights, loads)

  // 逐组分配：每组一个销售，组内逐条走 assignLeads（单条事务失败不阻塞其余，E201/E301 落 skipped）
  // 计数口径（2026-09-08 修复）：按实际新增 assignments 行数计，跳过/冲突（res.ok 但 assignments 空）
  // 不算入 assigned/perSales，落 skipped 可查
  const perSales: Record<string, number> = {}
  const skipped: Array<{ leadId: number; code: string; reason: string }> = []
  let assigned = 0
  let cursor = 0
  for (const s of sales) {
    const take = plan[s] || 0
    if (take <= 0) { perSales[s] = 0; continue }
    const chunk = pool.slice(cursor, cursor + take)
    cursor += take
    let got = 0
    for (const leadId of chunk) {
      const res = assignLeads([leadId], s, String(input?.actor || '').trim() || '分配员', mode)
      const gotN = res.ok && res.data ? res.data.assignments.length : 0
      if (gotN > 0) {
        got += gotN
      } else {
        const s1 = res.ok && res.data && res.data.skipped.length ? res.data.skipped[0] : null
        skipped.push({ leadId, code: s1?.code || res.code || 'E999', reason: s1?.reason || res.message || '分配失败' })
      }
    }
    perSales[s] = got
    assigned += got
  }
  // 计划外剩余（上游池被并发取走）：归到负载最轻者——保证「取 N 条」语义，除非池已空
  while (cursor < pool.length) {
    const s = [...sales].sort((a, b) => (loads[a] + (perSales[a] || 0)) - (loads[b] + (perSales[b] || 0)))[0]
    const leadId = pool[cursor++]
    const res = assignLeads([leadId], s, String(input?.actor || '').trim() || '分配员', mode)
    const gotN = res.ok && res.data ? res.data.assignments.length : 0
    if (gotN > 0) { perSales[s] = (perSales[s] || 0) + gotN; assigned += gotN }
    else {
      const s1 = res.ok && res.data && res.data.skipped.length ? res.data.skipped[0] : null
      skipped.push({ leadId, code: s1?.code || res.code || 'E999', reason: s1?.reason || res.message || '分配失败' })
    }
  }

  // 批次审计一行（设计稿屏 3「最近分配记录」，批次号 = '#A'+行号，可追溯到操作人）
  let batchNo = ''
  if (assigned > 0) {
    const actor = String(input?.actor || '').trim() || getActorLabel() || '分配员'
    const now = Date.now()
    const auditId = crmDbService.runTx((tx) => tx.run(
      'INSERT INTO audit_event (actor, action, entity_type, entity_id, detail, created_at) VALUES (?,?,?,?,?,?)',
      [actor, 'lead_assign_batch', 'lead', null,
       JSON.stringify({ mode, count: pool.length, assigned, perSales, skipped: skipped.length }), now]
    ))
    batchNo = `#A${Number(auditId)}`
  }
  return { ok: true, data: { batchNo, assigned, skipped, perSales, mode } }
}

/**
 * 份额分配（assignBatchLeads 与前端预览共用口径，屏 3 预览表 = 后端执行的逐条一致）：
 *   weight：按权重占比最大余数法分配（缺省等权；总量 = count）；
 *   round_robin：轮询均分（余数给名单前几位）；
 *   load：负载均衡——逐条给「在手 + 本批已得」最少者。
 */
export function buildDistribution(mode: 'weight' | 'round_robin' | 'load', count: number, sales: string[], weights: Record<string, number>, loads: Record<string, number>): Record<string, number> {
  const plan: Record<string, number> = {}
  for (const s of sales) plan[s] = 0
  if (count <= 0 || !sales.length) return plan
  if (mode === 'weight') {
    const w = sales.map((s) => Math.max(0, Number(weights[s] ?? 0)))
    const totalW = w.reduce((a, b) => a + b, 0)
    // 全 0 视为等权
    const eff = totalW > 0 ? w : sales.map(() => 1)
    const effTotal = eff.reduce((a, b) => a + b, 0)
    // 最大余数法：floor 后按小数部分从大到小补齐
    const remainders = sales.map((s, i) => ({ s, base: Math.floor((count * eff[i]) / effTotal), frac: (count * eff[i]) / effTotal - Math.floor((count * eff[i]) / effTotal) }))
    let used = remainders.reduce((a, r) => a + r.base, 0)
    remainders.sort((a, b) => b.frac - a.frac)
    let ri = 0
    while (used < count && remainders.length) { remainders[ri % remainders.length].base++; used++; ri++ }
    for (const r of remainders) plan[r.s] = r.base
  } else if (mode === 'round_robin') {
    for (let i = 0; i < count; i++) plan[sales[i % sales.length]]++
  } else {
    // load：模拟逐条投放给「在手 + 本批已得」最少者
    const cur: Record<string, number> = {}
    for (const s of sales) cur[s] = Number(loads[s] || 0)
    for (let i = 0; i < count; i++) {
      const s = sales.reduce((min, x) => (cur[x] < cur[min] ? x : min), sales[0])
      plan[s]++
      cur[s]++
    }
  }
  return plan
}
