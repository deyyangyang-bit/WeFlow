/**
 * lanSyncService.ts —— Phase 1 内网同步最小版（docs/规划/Phase1-内网同步最小版-设计.md）
 *
 * 传输通道：SMB 共享文件夹（NAS 后补只换 adapter），一事件一 JSON 文件：
 *   `<共享根>/down/`                中枢 → 终端（assign / transfer / recycle）
 *   `<共享根>/up/<终端标识>/`       终端 → 中枢（claim / bind_wx / first_touch / audit）
 * 落盘一律 tmp+rename 原子写（复用 atomicPersist.atomicWriteFileSync，铁律）；
 * 消费方只认 *.json，`.tmp` 半截文件永不入眼。
 *
 * 事件登记复用 outbox_event（设计 §2）：业务写点同事务登记 pending（§2.58 已落地），
 * 本服务负责「pending → 事件文件 → sent」的落盘段；共享目录不可用/未挂载时事件
 * 积压 pending，恢复后重放（R3；idempotency_key 保证业务侧可重放，宪法 §1.11）。
 * 共享目录未配置（lanSyncSharedDir 空）或角色未选 = 同步关闭，所有入口静默跳过。
 *
 * 角色差异（同一套代码按角色启停）：
 *   中枢 hub      = emitDown（下行产出）+ consumeUp（上行消费，跳过自己的 up 目录）
 *   终端 terminal = consumeDown（下行消费）+ emitUp（上行产出）；
 *                   终端不跑 SLA1 回收器（main.ts 按角色门控 startSlaRecycleScheduler）。
 *
 * 幂等（设计 §4 Q3）：已应用键存 scan_state `syncApplied:<idempotencyKey>`，与
 * leadScan 游标同模式。上行事件发出前把键加上终端标识前缀（`<终端标识>/<原键>`），
 * 保证多终端键全局唯一，`syncApplied:` 判定照原文成立。
 *
 * 上行 audit 事件（设计 §4 Q4）：不走 outbox，按 scan_state 游标 `syncUp:auditCursor`
 * 逐条扫 audit_event（排除 sync_* 同步层自身行防回声），只上行
 * actor/action/entity_type/entity_id/detail 五字段 + idempotencyKey；
 * detail 过 maskAuditText 脱敏（手机号中段打码 ***同前端 maskLead 格式 + 身份证号/wxid，
 * 复用 crmSla2Service.maskPrivateText）。聊天原文永不出机（宪法 §2.6）。
 *
 * 终端标识：身份档案姓名（identityName）优先，未建档回退机器名 hostname；
 * 目录名做文件系统安全化（空白/路径分隔符等 → _）。
 *
 * 零 electron 依赖（config/identity 均为条件 try-catch），tsx 可单测
 * （scripts/lan-sync-test.ts / lan-sync-e2e-test.ts）。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'fs'
import { join } from 'path'
import { hostname } from 'os'
import { crmDbService, type CrmRow } from './crmDbService'
import { ConfigService } from './config'
import { getIdentity } from './identityService'
import { atomicWriteFileSync } from './atomicPersist'
import { maskPrivateText } from './crmSla2Service'
import { expandHomePath } from '../utils/pathUtils'
import { LEAD_SLA_UNASSIGNED_SENTINEL } from '../../shared/leadSla'

// ─── 配置与身份 ──────────────────────────────────────────────────────────────
export type LanSyncRole = 'hub' | 'terminal'

export interface LanSyncConfig { enabled: boolean; role: LanSyncRole | ''; root: string }

/** 读取同步配置；目录空或角色非法 = 同步关闭（enabled=false，所有入口静默跳过） */
export function getLanSyncConfig(): LanSyncConfig {
  const cfg = ConfigService.getInstance()
  const root = expandHomePath(String(cfg.get('lanSyncSharedDir') || '').trim())
  const rawRole = String(cfg.get('lanSyncRole') || '').trim()
  const role: LanSyncRole | '' = rawRole === 'hub' || rawRole === 'terminal' ? rawRole : ''
  return { enabled: !!root && !!role, role, root }
}

/** 终端标识：身份档案姓名优先，未建档回退机器名；目录名安全化 */
export function getTerminalId(): string {
  const raw = getIdentity()?.name || hostname() || 'unknown'
  return raw.replace(/[\\/:*?"<>|\s]+/g, '_') || 'unknown'
}

/** 同步轮巡间隔（分钟）：配置 lanSyncPollIntervalMin，1-60，默认 1 */
function pollIntervalMin(): number {
  const n = Number(ConfigService.getInstance().get('lanSyncPollIntervalMin') ?? 1)
  return Number.isFinite(n) && n >= 1 && n <= 60 ? n : 1
}

// ─── 事件文件 ────────────────────────────────────────────────────────────────
export interface SyncEventFile {
  eventSeq: number
  idempotencyKey: string
  type: string
  payload: Record<string, unknown>
  emittedAt: number
  /** 上行事件的发出终端标识（下行无） */
  from?: string
}

const DOWN_TYPES = ['assign', 'transfer', 'recycle'] as const
const UP_TYPES = ['claim', 'bind_wx', 'first_touch'] as const

function safeFilePart(s: string): string {
  return String(s).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 120) || 'event'
}

/** 写事件文件：tmp+rename 原子写（atomicWriteFileSync 铁律），目标已存在则跳过（重放安全） */
function writeEventFile(path: string, ev: SyncEventFile): void {
  if (existsSync(path)) return
  atomicWriteFileSync(path, Buffer.from(JSON.stringify(ev), 'utf-8'))
}

/** 目录下待消费事件文件（*.json，.tmp 半截文件天然被过滤；按文件名升序 = 按 eventSeq 顺序） */
function listEventFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
  } catch {
    return []
  }
}

function readEventFile(path: string): SyncEventFile | null {
  try {
    const j = JSON.parse(readFileSync(path, 'utf-8'))
    if (!j || typeof j.idempotencyKey !== 'string' || !j.idempotencyKey) return null
    if (typeof j.type !== 'string' || !j.type) return null
    return j as SyncEventFile
  } catch {
    return null
  }
}

// ─── 脱敏（Q4）：audit detail 上行前必过 ─────────────────────────────────────
/**
 * 手机号中段打码复用前端既有格式（CrmLeadPage.maskLead：`138****5678`），
 * 再交 maskPrivateText 处理身份证号/wxid（宪法 §2.6）。聊天原文不在上行字段内。
 */
export function maskAuditText(text: string): string {
  let s = String(text ?? '')
  s = s.replace(/\b(1\d{2})\d{4}(\d{4})\b/g, '$1****$2')
  return maskPrivateText(s)
}

// ─── scan_state 键（Q3：幂等键与最近同步状态都存这里，无新表）─────────────────
const K_LAST_DOWN_EMIT = 'sync:lastDownEmitAt'
const K_LAST_DOWN_APPLY = 'sync:lastDownApplyAt'
const K_LAST_UP_EMIT = 'sync:lastUpEmitAt'
const K_LAST_UP_APPLY = 'sync:lastUpApplyAt'
const K_AUDIT_CURSOR = 'syncUp:auditCursor'
const appliedKey = (idempotencyKey: string) => `syncApplied:${idempotencyKey}`

// ─── 下行产出（中枢）：pending outbox → down/ 事件文件 → sent ────────────────
export interface EmitResult { emitted: number; failed: number }

/** 从 outbox payload 取 leadId 并回查 lead 基础资料（下行 payload 必须带，设计 §3） */
function leadProfileOf(leadId: unknown): Record<string, unknown> | null {
  const id = Number(leadId)
  if (!Number.isInteger(id) || id <= 0) return null
  const lead = crmDbService.all('SELECT * FROM lead WHERE id = ?', [id])[0]
  if (!lead) return null
  return {
    leadId: id,
    name: String(lead.name || ''),
    contactType: String(lead.contact_type || 'phone'),
    contactNormalized: String(lead.contact_normalized || ''),
    contactRaw: String(lead.contact_raw || ''),
    wechat: String(lead.wechat || ''),
    source: String(lead.source || ''),
    note: String(lead.note || '')
  }
}

function slaHoursNow(): number {
  const n = Number(ConfigService.getInstance().get('crmLeadSlaHours') ?? 24)
  return Number.isFinite(n) && n > 0 && n <= 72 ? n : 24
}

/**
 * 中枢下行产出：扫 pending outbox，挑 assign/transfer/recycle，
 * 富化 payload（lead 基础资料 + 目标销售 + SLA 参数）写 `down/` 事件文件后标 sent。
 * 目录不可写/未挂载：整轮 failed 返回、行保持 pending 等下轮重放（不抛错不惊扰）。
 */
export function emitDownEvents(root: string): EmitResult {
  const r: EmitResult = { emitted: 0, failed: 0 }
  const downDir = join(root, 'down')
  try {
    if (!existsSync(downDir)) mkdirSync(downDir, { recursive: true })
  } catch (e) {
    console.warn('[LanSync] 共享目录不可写，本轮下行产出跳过:', e)
    return { emitted: 0, failed: -1 }
  }
  const rows = crmDbService.all("SELECT * FROM outbox_event WHERE status = 'pending' ORDER BY event_seq")
  for (const row of rows) {
    let payload: Record<string, unknown>
    try { payload = JSON.parse(String(row.payload || '{}')) } catch { continue }
    const type = String(payload.type || '')
    if (!(DOWN_TYPES as readonly string[]).includes(type)) continue
    const key = String(row.idempotency_key || '')
    if (!key) continue
    try {
      const lead = leadProfileOf(payload.leadId)
      const ev: SyncEventFile = {
        eventSeq: Number(row.event_seq || 0),
        idempotencyKey: key,
        type,
        payload: { ...payload, lead, slaHours: slaHoursNow() },
        emittedAt: Date.now()
      }
      const file = join(downDir, `${String(ev.eventSeq).padStart(8, '0')}-${safeFilePart(key)}.json`)
      writeEventFile(file, ev)
      crmDbService.runTx((tx) => {
        tx.run("UPDATE outbox_event SET status = 'sent', updated_at = ? WHERE id = ? AND status = 'pending'", [Date.now(), Number(row.id)])
      })
      r.emitted++
    } catch (e) {
      r.failed++
      console.warn(`[LanSync] 下行事件落盘失败 key=${key}:`, e)
    }
  }
  if (r.emitted > 0) crmDbService.setScanState(K_LAST_DOWN_EMIT, Date.now())
  return r
}

// ─── 下行消费（终端）：down/ → 应用 → 幂等标记 → 删文件 ──────────────────────
export interface ConsumeResult { applied: number; skippedDup: number; conflict: number; failed: number }

/** 按联系方式身份解析本机 lead（跨机 id 不可信，身份 = contact_type+contact_normalized） */
function findLocalLead(tx: { all: (sql: string, params?: unknown[]) => CrmRow[] }, lead: Record<string, unknown> | null | undefined, fallbackLeadId: unknown): CrmRow | null {
  const ct = String(lead?.contactType || '').trim()
  const cn = String(lead?.contactNormalized || '').trim()
  if (ct && cn) {
    const hit = tx.all('SELECT * FROM lead WHERE contact_type = ? AND contact_normalized = ?', [ct, cn])
    if (hit.length) return hit[0]
  }
  const fid = Number(fallbackLeadId)
  if (Number.isInteger(fid) && fid > 0) {
    const hit = tx.all('SELECT * FROM lead WHERE id = ?', [fid])
    if (hit.length) return hit[0]
  }
  return null
}

const ACTIVE_STATUS_SQL = "status IN ('assigned','claimed')"

/** 应用一条下行事件（调用方事务内）；返回 'applied' | 'conflict' | 'nolead' */
function applyDownEventTx(
  tx: { run: (sql: string, params?: unknown[]) => number; all: (sql: string, params?: unknown[]) => CrmRow[] },
  ev: SyncEventFile
): 'applied' | 'conflict' | 'nolead' {
  const p = ev.payload || {}
  const leadInfo = (p.lead && typeof p.lead === 'object' ? p.lead : null) as Record<string, unknown> | null
  const now = Date.now()
  const actor = String(p.actor || 'system:sync')
  const sla1 = Number(p.sla1Deadline || 0) || 0

  let lead = findLocalLead(tx, leadInfo, p.leadId)
  if (ev.type === 'assign') {
    if (!lead && leadInfo) {
      // 终端本机没有该 lead → 随下行事件建档（lead 基础资料齐备，设计 §3）
      const newId = tx.run(
        'INSERT INTO lead (contact_type, contact_normalized, contact_raw, wechat, source, name, note, status, first_contact_deadline, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        [String(leadInfo.contactType || 'phone'), String(leadInfo.contactNormalized || ''), String(leadInfo.contactRaw || ''),
          String(leadInfo.wechat || ''), String(leadInfo.source || '同步'), String(leadInfo.name || ''), String(leadInfo.note || ''),
          'NEW', sla1 || LEAD_SLA_UNASSIGNED_SENTINEL, now, now]
      )
      lead = tx.all('SELECT * FROM lead WHERE id = ?', [newId])[0]
    }
    if (!lead) return 'nolead'
    const leadId = Number(lead.id)
    const cur = tx.all(`SELECT id FROM assignment WHERE lead_id = ? AND deleted = 0 AND ${ACTIVE_STATUS_SQL} ORDER BY id DESC LIMIT 1`, [leadId])
    if (cur.length) return 'conflict' // 已有有效归属，中枢指令与本地状态打架 → 不覆盖，留人工
    // 既有 lead：补全空资料 + 首触期限跟中枢 sla1（分配起计时口径同 assignLeads）
    tx.run(
      "UPDATE lead SET name = CASE WHEN name = '' OR name IS NULL THEN ? ELSE name END, wechat = CASE WHEN wechat = '' OR wechat IS NULL THEN ? ELSE wechat END, first_contact_deadline = ?, updated_at = ? WHERE id = ?",
      [String(leadInfo?.name || ''), String(leadInfo?.wechat || ''), sla1 || Number(lead.first_contact_deadline || LEAD_SLA_UNASSIGNED_SENTINEL), now, leadId]
    )
    tx.run(
      'INSERT INTO assignment (lead_id, sales_name, mode, sla1_deadline, sla2_scan_ref, status, source, updated_by, updated_at, version, deleted) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [leadId, String(p.salesName || ''), String(p.mode || 'manual'), sla1 || null, '', 'assigned', 'sync:down', actor, now, 1, 0]
    )
    tx.run('INSERT INTO audit_event (actor, action, entity_type, entity_id, detail, created_at) VALUES (?,?,?,?,?,?)',
      ['system:sync', 'sync_apply', 'lead', leadId, JSON.stringify({ type: 'assign', idempotencyKey: ev.idempotencyKey, salesName: String(p.salesName || ''), hubLeadId: Number(p.leadId || 0) }), now])
    return 'applied'
  }

  if (ev.type === 'transfer' || ev.type === 'recycle') {
    if (!lead) return 'nolead'
    const leadId = Number(lead.id)
    const cur = tx.all(`SELECT * FROM assignment WHERE lead_id = ? AND deleted = 0 AND ${ACTIVE_STATUS_SQL} ORDER BY id DESC LIMIT 1`, [leadId])[0]
    if (ev.type === 'recycle') {
      if (cur) {
        tx.run("UPDATE assignment SET status = 'recycled', updated_by = ?, updated_at = ?, version = version + 1 WHERE id = ?", [actor, now, Number(cur.id)])
      }
      tx.run('UPDATE lead SET first_contact_deadline = ?, updated_at = ? WHERE id = ?', [LEAD_SLA_UNASSIGNED_SENTINEL, now, leadId])
      tx.run('INSERT INTO audit_event (actor, action, entity_type, entity_id, detail, created_at) VALUES (?,?,?,?,?,?)',
        ['system:sync', 'sync_apply', 'lead', leadId, JSON.stringify({ type: 'recycle', idempotencyKey: ev.idempotencyKey, reason: String(p.reason || '') }), now])
      return 'applied'
    }
    // transfer：旧行 transferred + 新行 assigned（sla1 重起计时）
    if (cur) {
      tx.run("UPDATE assignment SET status = 'transferred', updated_by = ?, updated_at = ?, version = version + 1 WHERE id = ?", [actor, now, Number(cur.id)])
    }
    tx.run(
      'INSERT INTO assignment (lead_id, sales_name, mode, sla1_deadline, sla2_scan_ref, status, source, updated_by, updated_at, version, deleted) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [leadId, String(p.toSales || ''), String(p.mode || 'manual'), sla1 || null, '', 'assigned', 'sync:down', actor, now, 1, 0]
    )
    tx.run('UPDATE lead SET first_contact_deadline = ?, updated_at = ? WHERE id = ?', [sla1 || Number(lead.first_contact_deadline || LEAD_SLA_UNASSIGNED_SENTINEL), now, leadId])
    tx.run('INSERT INTO audit_event (actor, action, entity_type, entity_id, detail, created_at) VALUES (?,?,?,?,?,?)',
      ['system:sync', 'sync_apply', 'lead', leadId, JSON.stringify({ type: 'transfer', idempotencyKey: ev.idempotencyKey, toSales: String(p.toSales || '') }), now])
    return 'applied'
  }
  return 'conflict' // 未知类型不应用
}

/**
 * 终端消费下行：逐文件应用（单事务：业务写 + `syncApplied:` 幂等标记），成功后删文件。
 * 解析失败的毒文件改名 `.bad` 隔离（不反复重试）；重复投递命中幂等标记 → 删文件零业务写。
 */
export function consumeDownEvents(root: string): ConsumeResult {
  const r: ConsumeResult = { applied: 0, skippedDup: 0, conflict: 0, failed: 0 }
  const downDir = join(root, 'down')
  for (const f of listEventFiles(downDir)) {
    const path = join(downDir, f)
    const ev = readEventFile(path)
    if (!ev) {
      try { renameSync(path, `${path}.bad`) } catch { /* ignore */ }
      r.failed++
      continue
    }
    if (crmDbService.getScanState(appliedKey(ev.idempotencyKey)) > 0) {
      try { rmSync(path, { force: true }) } catch { /* ignore */ }
      r.skippedDup++
      continue
    }
    try {
      const outcome = crmDbService.runTx((tx) => {
        const o = applyDownEventTx(tx, ev)
        if (o === 'applied' || o === 'conflict') {
          // conflict 也标记已应用：中枢权威指令与本地冲突时不反复重试，留人工（审计可查）
          tx.run('INSERT INTO scan_state (key, last_scan) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET last_scan = excluded.last_scan', [appliedKey(ev.idempotencyKey), Date.now()])
        }
        return o
      })
      if (outcome === 'applied') { r.applied++; try { rmSync(path, { force: true }) } catch { /* ignore */ } }
      else if (outcome === 'conflict') { r.conflict++; try { rmSync(path, { force: true }) } catch { /* ignore */ } }
      else { r.failed++ } // nolead：文件留下轮（lead 可能随后续事件到达）
    } catch (e) {
      r.failed++
      console.warn(`[LanSync] 下行事件应用失败 file=${f}:`, e)
    }
  }
  if (r.applied > 0) crmDbService.setScanState(K_LAST_DOWN_APPLY, Date.now())
  return r
}

// ─── 上行产出（终端）：claim/bind_wx/first_touch 走 outbox + audit 走游标 ─────
/**
 * 终端上行产出到 `up/<终端标识>/`：
 *   ① pending outbox 中 claim/bind_wx/first_touch → 富化 lead 身份后落文件（键加终端前缀保证全局唯一）→ 标 sent；
 *   ② audit 游标（Q4）：scan_state `syncUp:auditCursor` 之后的本地审计行（排除 sync_* 同步层行），
 *      裁剪五字段 + detail 脱敏后逐条落文件，游标随成功落盘推进。
 */
export function emitUpEvents(root: string): EmitResult {
  const r: EmitResult = { emitted: 0, failed: 0 }
  const tid = getTerminalId()
  const upDir = join(root, 'up', tid)
  try {
    if (!existsSync(upDir)) mkdirSync(upDir, { recursive: true })
  } catch (e) {
    console.warn('[LanSync] 共享目录不可写，本轮上行产出跳过:', e)
    return { emitted: 0, failed: -1 }
  }

  // ① 业务回执（outbox 口径）
  const rows = crmDbService.all("SELECT * FROM outbox_event WHERE status = 'pending' ORDER BY event_seq")
  for (const row of rows) {
    let payload: Record<string, unknown>
    try { payload = JSON.parse(String(row.payload || '{}')) } catch { continue }
    const type = String(payload.type || '')
    if (!(UP_TYPES as readonly string[]).includes(type)) continue
    const key = String(row.idempotency_key || '')
    if (!key) continue
    try {
      const ev: SyncEventFile = {
        eventSeq: Number(row.event_seq || 0),
        idempotencyKey: `${tid}/${key}`,
        type,
        payload: { ...payload, lead: leadProfileOf(payload.leadId) },
        emittedAt: Date.now(),
        from: tid
      }
      const file = join(upDir, `${String(ev.eventSeq).padStart(8, '0')}-${safeFilePart(key)}.json`)
      writeEventFile(file, ev)
      crmDbService.runTx((tx) => {
        tx.run("UPDATE outbox_event SET status = 'sent', updated_at = ? WHERE id = ? AND status = 'pending'", [Date.now(), Number(row.id)])
      })
      r.emitted++
    } catch (e) {
      r.failed++
      console.warn(`[LanSync] 上行事件落盘失败 key=${key}:`, e)
    }
  }

  // ② 审计行（Q4 裁剪 + 脱敏；游标逐条推进，落盘失败不推进下轮重试）
  const cursor = crmDbService.getScanState(K_AUDIT_CURSOR)
  const audits = crmDbService.all(
    "SELECT * FROM audit_event WHERE id > ? AND action NOT LIKE 'sync_%' ORDER BY id LIMIT 200",
    [cursor]
  )
  for (const a of audits) {
    try {
      const ev: SyncEventFile = {
        eventSeq: Number(a.id),
        idempotencyKey: `${tid}/audit:${Number(a.id)}`,
        type: 'audit',
        payload: {
          actor: String(a.actor || ''),
          action: String(a.action || ''),
          entity_type: String(a.entity_type || ''),
          entity_id: Number(a.entity_id || 0),
          detail: maskAuditText(String(a.detail || ''))
        },
        emittedAt: Date.now(),
        from: tid
      }
      writeEventFile(join(upDir, `audit-${String(Number(a.id)).padStart(8, '0')}.json`), ev)
      crmDbService.setScanState(K_AUDIT_CURSOR, Number(a.id))
      r.emitted++
    } catch (e) {
      r.failed++
      console.warn(`[LanSync] 上行审计落盘失败 audit=${Number(a.id)}:`, e)
      break // 保序：断了就停，下轮从游标继续
    }
  }

  if (r.emitted > 0) crmDbService.setScanState(K_LAST_UP_EMIT, Date.now())
  return r
}

// ─── 上行消费（中枢）：up/*/ → 应用 → 幂等标记 → 删文件（跳过自己的目录）─────
/** 应用一条上行事件（调用方事务内）；返回是否已处理（未知类型返回 false 不消费） */
function applyUpEventTx(
  tx: { run: (sql: string, params?: unknown[]) => number; all: (sql: string, params?: unknown[]) => CrmRow[] },
  ev: SyncEventFile
): boolean {
  const p = ev.payload || {}
  const now = Date.now()
  const actor = String(p.actor || '') || String(ev.from || 'terminal')
  const leadInfo = (p.lead && typeof p.lead === 'object' ? p.lead : null) as Record<string, unknown> | null

  if (ev.type === 'audit') {
    // Q4 裁剪口径：五字段原样入库（entity_id 是终端本机 id，Phase 1 接受；detail 发出端已脱敏）
    tx.run('INSERT INTO audit_event (actor, action, entity_type, entity_id, detail, created_at) VALUES (?,?,?,?,?,?)',
      [actor, String(p.action || ''), String(p.entity_type || ''), Number(p.entity_id || 0), String(p.detail || ''), now])
    return true
  }

  const lead = findLocalLead(tx, leadInfo, p.leadId)
  if (!lead) return false
  const leadId = Number(lead.id)

  if (ev.type === 'claim') {
    const cur = tx.all(`SELECT * FROM assignment WHERE lead_id = ? AND deleted = 0 AND ${ACTIVE_STATUS_SQL} ORDER BY id DESC LIMIT 1`, [leadId])[0]
    if (cur && String(cur.status) === 'assigned') {
      tx.run("UPDATE assignment SET status = 'claimed', updated_by = ?, updated_at = ?, version = version + 1 WHERE id = ? AND status = 'assigned'", [actor, now, Number(cur.id)])
      tx.run('INSERT INTO audit_event (actor, action, entity_type, entity_id, detail, created_at) VALUES (?,?,?,?,?,?)',
        [actor, 'lead_claim', 'lead', leadId, JSON.stringify({ assignmentId: Number(cur.id), salesName: String(cur.sales_name), via: 'sync:up', terminal: String(ev.from || '') }), now])
    }
    return true
  }

  if (ev.type === 'bind_wx') {
    const wxid = String(p.wxid || '').trim()
    const unstopped = tx.all(
      `SELECT id FROM assignment WHERE lead_id = ? AND deleted = 0 AND ${ACTIVE_STATUS_SQL} AND sla1_met_at IS NULL ORDER BY id DESC`,
      [leadId]
    )
    for (const row of unstopped) {
      tx.run('UPDATE assignment SET sla1_met_at = ?, updated_by = ?, updated_at = ?, version = version + 1 WHERE id = ? AND sla1_met_at IS NULL', [now, actor, now, Number(row.id)])
    }
    if (String(lead.status) === 'NEW' || String(lead.status) === 'CONTACTED') {
      tx.run("UPDATE lead SET status = 'WX_ADDED', wechat = CASE WHEN wechat = '' OR wechat IS NULL THEN ? ELSE wechat END, updated_at = ? WHERE id = ?", [wxid, now, leadId])
      tx.run('INSERT INTO lead_activity (lead_id, action, note, created_at) VALUES (?,?,?,?)', [leadId, 'WX_ADDED', `终端回执：已绑定微信 ${wxid}`, now])
    } else if (wxid && !String(lead.wechat || '').trim()) {
      tx.run('UPDATE lead SET wechat = ?, updated_at = ? WHERE id = ?', [wxid, now, leadId])
    }
    tx.run('INSERT INTO audit_event (actor, action, entity_type, entity_id, detail, created_at) VALUES (?,?,?,?,?,?)',
      [actor, 'identity_bind', 'lead', leadId, JSON.stringify({ wxid, via: 'sync:up', terminal: String(ev.from || ''), slaStopped: unstopped.length > 0 }), now])
    return true
  }

  if (ev.type === 'first_touch') {
    if (String(lead.status) === 'NEW') {
      const channel = String(p.channel || '').toUpperCase()
      tx.run('UPDATE lead SET status = ?, first_contacted_at = ?, first_contact_channel = CASE WHEN ? <> \'\' THEN ? ELSE first_contact_channel END, updated_at = ? WHERE id = ?',
        ['CONTACTED', Number(p.at || now), channel, channel, now, leadId])
      tx.run('INSERT INTO lead_activity (lead_id, action, note, created_at) VALUES (?,?,?,?)', [leadId, 'CONTACTED', `终端回执：完成首触${channel ? `（渠道 ${channel}）` : ''}`, now])
      tx.run('INSERT INTO audit_event (actor, action, entity_type, entity_id, detail, created_at) VALUES (?,?,?,?,?,?)',
        [actor, 'lead_first_touch', 'lead', leadId, JSON.stringify({ channel, via: 'sync:up', terminal: String(ev.from || '') }), now])
    }
    return true
  }
  return false
}

/**
 * 中枢消费上行：扫 `up/<终端>/` 各目录（**跳过自己的终端标识目录**——中枢不消费自己的 up），
 * 逐文件应用（单事务：业务写 + `syncApplied:` 幂等标记），成功删文件；毒文件改名 `.bad`。
 * 未知类型/找不到 lead：文件留下轮不删（后续事件可能带全资料），计 failed。
 */
export function consumeUpEvents(root: string): ConsumeResult {
  const r: ConsumeResult = { applied: 0, skippedDup: 0, conflict: 0, failed: 0 }
  const upRoot = join(root, 'up')
  if (!existsSync(upRoot)) return r
  const ownTid = getTerminalId()
  let dirs: string[] = []
  try {
    dirs = readdirSync(upRoot).filter((d) => {
      try { return statSync(join(upRoot, d)).isDirectory() } catch { return false }
    })
  } catch { return r }
  for (const d of dirs) {
    if (d === ownTid) continue // 中枢不消费自己的 up（角色差异纪律）
    const dir = join(upRoot, d)
    for (const f of listEventFiles(dir)) {
      const path = join(dir, f)
      const ev = readEventFile(path)
      if (!ev) {
        try { renameSync(path, `${path}.bad`) } catch { /* ignore */ }
        r.failed++
        continue
      }
      if (crmDbService.getScanState(appliedKey(ev.idempotencyKey)) > 0) {
        try { rmSync(path, { force: true }) } catch { /* ignore */ }
        r.skippedDup++
        continue
      }
      try {
        const handled = crmDbService.runTx((tx) => {
          const okApply = applyUpEventTx(tx, ev)
          if (okApply) {
            tx.run('INSERT INTO scan_state (key, last_scan) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET last_scan = excluded.last_scan', [appliedKey(ev.idempotencyKey), Date.now()])
          }
          return okApply
        })
        if (handled) { r.applied++; try { rmSync(path, { force: true }) } catch { /* ignore */ } }
        else r.failed++
      } catch (e) {
        r.failed++
        console.warn(`[LanSync] 上行事件应用失败 file=${d}/${f}:`, e)
      }
    }
  }
  if (r.applied > 0) crmDbService.setScanState(K_LAST_UP_APPLY, Date.now())
  return r
}

// ─── 统一入口：按角色跑一轮 ──────────────────────────────────────────────────
export interface LanSyncRound { role: LanSyncRole | ''; down?: EmitResult; up?: ConsumeResult; consumeDown?: ConsumeResult; emitUp?: EmitResult }

/** 按角色跑一轮同步；未配置（目录空/角色未选）→ 静默返回（同步关闭） */
export function runLanSyncOnce(): LanSyncRound {
  const cfg = getLanSyncConfig()
  if (!cfg.enabled) return { role: cfg.role }
  if (cfg.role === 'hub') {
    return { role: 'hub', down: emitDownEvents(cfg.root), up: consumeUpEvents(cfg.root) }
  }
  return { role: 'terminal', consumeDown: consumeDownEvents(cfg.root), emitUp: emitUpEvents(cfg.root) }
}

// ─── 状态（设置页「内网同步」区块）────────────────────────────────────────────
export interface LanSyncStatus {
  enabled: boolean
  role: LanSyncRole | ''
  terminalId: string
  sharedDir: string
  lastDownEmitAt: number
  lastDownApplyAt: number
  lastUpEmitAt: number
  lastUpApplyAt: number
  /** 待产出积压（pending outbox 中本角色该发的方向 + 终端 audit 游标积压） */
  backlogPending: number
  /** 待消费积压（共享目录里本角色该消费方向未消费的事件文件数） */
  backlogIncoming: number
}

export function lanSyncStatus(): LanSyncStatus {
  const cfg = getLanSyncConfig()
  const st: LanSyncStatus = {
    enabled: cfg.enabled, role: cfg.role, terminalId: getTerminalId(), sharedDir: cfg.root,
    lastDownEmitAt: crmDbService.getScanState(K_LAST_DOWN_EMIT),
    lastDownApplyAt: crmDbService.getScanState(K_LAST_DOWN_APPLY),
    lastUpEmitAt: crmDbService.getScanState(K_LAST_UP_EMIT),
    lastUpApplyAt: crmDbService.getScanState(K_LAST_UP_APPLY),
    backlogPending: 0, backlogIncoming: 0
  }
  if (!cfg.enabled) return st
  const types = cfg.role === 'hub' ? DOWN_TYPES : UP_TYPES
  for (const row of crmDbService.all("SELECT payload FROM outbox_event WHERE status = 'pending'")) {
    try {
      const t = String(JSON.parse(String(row.payload || '{}')).type || '')
      if ((types as readonly string[]).includes(t)) st.backlogPending++
    } catch { /* ignore */ }
  }
  if (cfg.role === 'terminal') {
    const cursor = crmDbService.getScanState(K_AUDIT_CURSOR)
    st.backlogPending += Number(crmDbService.all("SELECT COUNT(*) AS c FROM audit_event WHERE id > ? AND action NOT LIKE 'sync_%'", [cursor])[0]?.c || 0)
    st.backlogIncoming = listEventFiles(join(cfg.root, 'down')).length
  } else {
    const upRoot = join(cfg.root, 'up')
    if (existsSync(upRoot)) {
      try {
        for (const d of readdirSync(upRoot)) {
          if (d === st.terminalId) continue
          st.backlogIncoming += listEventFiles(join(upRoot, d)).length
        }
      } catch { /* ignore */ }
    }
  }
  return st
}

// ─── 调度器（main.ts 启动链路，挂在 SLA2 扫描旁）──────────────────────────────
let lanSyncBoot: ReturnType<typeof setTimeout> | null = null
let lanSyncTimer: ReturnType<typeof setInterval> | null = null

/**
 * 启动内网同步调度器。幂等：重复调用直接返回。启动延迟 150s 首巡（让迁移/回收器等先收尾）。
 * 每轮按当前配置动态分派角色（改配置下轮生效，间隔本身重启生效）。
 */
export function startLanSyncScheduler(): void {
  if (lanSyncTimer) return
  const tick = (): void => {
    try {
      const r = runLanSyncOnce()
      const out = r.down?.emitted || 0
      const inUp = r.up?.applied || 0
      const inDown = r.consumeDown?.applied || 0
      const outUp = r.emitUp?.emitted || 0
      if (out + inUp + inDown + outUp > 0) {
        console.log(`[LanSync] 一轮同步（role=${r.role}）：下行产出 ${out}，上行消费 ${inUp}，下行消费 ${inDown}，上行产出 ${outUp}`)
      }
    } catch (e) {
      console.warn('[LanSync] 同步轮巡失败:', e)
    }
  }
  lanSyncBoot = setTimeout(tick, 150 * 1000)
  if (lanSyncBoot.unref) lanSyncBoot.unref()
  lanSyncTimer = setInterval(tick, pollIntervalMin() * 60 * 1000)
  if (lanSyncTimer.unref) lanSyncTimer.unref()
}
