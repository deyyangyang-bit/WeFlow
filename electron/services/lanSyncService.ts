/**
 * lanSyncService.ts —— Phase 1 内网同步最小版（docs/规划/Phase1-内网同步最小版-设计.md，
 * 2026-09-08 定向投递修订：修复多人终端下行事件串领）
 *
 * 传输通道：SMB 共享文件夹（NAS 后补只换 adapter），一事件一 JSON 文件：
 *   `<共享根>/down/<投递键>/`            中枢 → 指定接收者（assign / transfer / recycle / 主管通知）；
 *       每个销售身份一个独立下行队列（投递键 = 稳定化的身份标识，见 deliveryKey），
 *       终端只读自己的队列，非目标终端读不到、碰不到别人的事件（修复串领根因）。
 *   `<共享根>/down/<投递键>/.failed/`    毒文件/终态失败事件隔离区（保留可审计状态）。
 *   `<共享根>/up/<终端标识>/`            终端 → 中枢（claim / bind_wx / first_touch / audit）；
 *   `<共享根>/up/<终端标识>/ack/`        终端 → 中枢的投递回执（ACK，一个投递一个文件）。
 * 落盘一律 tmp+rename 原子写（复用 atomicPersist.atomicWriteFileSync，铁律）；
 * 消费方只认 *.json，`.tmp` 半截文件永不入眼。
 *
 * 投递语义（2026-09-08 修订，替代「落盘即 sent」旧口径）：
 *   - 中枢产出 = 把事件写进每个接收者的队列，outbox 行**保持 pending**（文件落盘 ≠ 终端已接收）；
 *   - 终端完成本地事务后写 ACK（outcome=applied/conflict/nolead/invalid），applied/conflict 在 ACK 成功后删事件文件；
 *     ACK 写失败则保留文件，由下轮按幂等结果补写 ACK；nolead 保留文件等下轮重试（lead 可能随后续事件到达）；
 *   - 中枢收到某投递的全部接收者 ACK 且均 applied → outbox 行标 sent（投递完成）；
 *     任一接收者 conflict/invalid → outbox 行标 failed + 审计（失败事件保留可审计状态，不静默当成功）；
 *   - 一个业务事件多接收者（transfer = 新销售 apply + 原销售 remove）各自独立投递与 ACK，
 *     一个接收者确认不会提前清理其他接收者的投递；
 *   - 中枢重启（outbox 行仍 pending + 队列文件仍在）、终端重启（syncApplied 标记 + 队列文件仍在）、
 *     重复投递/重复 ACK 全部幂等（scan_state 标记 + writeEventFile 跳过已存在文件）。
 *
 * 事件登记复用 outbox_event（设计 §2）：业务写点同事务登记 pending（§2.58 已落地），
 * 本服务负责「pending → 事件文件 →（ACK）→ sent/failed」全生命周期；共享目录不可用/未挂载时
 * 事件积压 pending，恢复后重放（R3；idempotency_key 保证业务侧可重放，宪法 §1.11）。
 *
 * 角色差异（同一套代码按角色启停）：
 *   中枢 hub      = emitDown（下行产出）+ settleDown（ACK 结算）+ consumeUp（上行消费，跳过自己的 up 目录）
 *                   + consumeSupervisorNotifications（主管通知本机落地，见下）；
 *   终端 terminal = consumeDown（只消费自己的下行队列）+ emitUp（上行产出）；
 *                   终端不跑 SLA1 回收器（main.ts 按角色门控 startSlaRecycleScheduler）。
 *
 * 主管通知（sla1_escalate_supervisor）：中枢是主管/分配员工作机（Phase 1 拓扑），通知路由到
 * 中枢自己的下行队列，由中枢在同步轮内落地 notify_inbox（幂等键唯一）+ outbox 标 sent，
 * 不再是永远无人消费的占位记录。
 *
 * 幂等（设计 §4 Q3）：已应用键存 scan_state `syncApplied:<key>#<投递角色>`（与 leadScan 游标同模式）；
 * 上行事件发出前把键加上终端标识前缀（`<终端标识>/<原键>`）；ACK 结算标记 `syncAck:<投递键>:<投递名>`。
 *
 * 上行 audit 事件（设计 §4 Q4）：不走 outbox，按 scan_state 游标 `syncUp:auditCursor` 逐条扫
 * audit_event（排除 sync_* 同步层自身行防回声），只上行五字段 + idempotencyKey；
 * detail 过 maskAuditText 脱敏。聊天原文永不出机（宪法 §2.6）。
 *
 * 零 electron 依赖（config/identity 均为条件 try-catch），tsx 可单测
 * （scripts/lan-sync-test.ts / lan-sync-e2e-test.ts）。
 */
import { createHash } from 'crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'fs'
import { join } from 'path'
import { hostname } from 'os'
import { crmDbService, type CrmRow } from './crmDbService'
import { ConfigService } from './config'
import { getIdentity } from './identityService'
import { atomicWriteFileSync } from './atomicPersist'
import { maskPrivateText } from './crmSla2Service'
import { recordSupervisorNotificationTx } from './crmNotifyService'
import { expandHomePath } from '../utils/pathUtils'
import { LEAD_SLA_UNASSIGNED_SENTINEL } from '../../shared/leadSla'
import { downCommandSpec, validateDownCommand } from '../../shared/centralDownCommand'
import { findForbiddenDownlinkField } from '../../shared/centralSync'
import { healLegacyDownPayload } from './crmDownPayloadCompat'
import { emitAssignmentInvalidated, type AssignmentInvalidationAction } from './assignmentInvalidationBus'

// ─── 配置与身份 ──────────────────────────────────────────────────────────────
export type LanSyncRole = 'hub' | 'terminal'

export interface LanSyncConfig { enabled: boolean; role: LanSyncRole | ''; root: string }

/** 读取同步配置；目录空或角色非法 = 同步关闭（enabled=false，所有入口静默跳过） */
export function getLanSyncConfig(): LanSyncConfig {
  const cfg = ConfigService.getInstance()
  // Phase 3a HTTP 已启用时，SMB adapter 必须停用，避免同一 outbox 被两个传输层竞争结算。
  if (cfg.get('centralSyncEnabled')) return { enabled: false, role: '', root: '' }
  const root = expandHomePath(String(cfg.get('lanSyncSharedDir') || '').trim())
  const rawRole = String(cfg.get('lanSyncRole') || '').trim()
  const role: LanSyncRole | '' = rawRole === 'hub' || rawRole === 'terminal' ? rawRole : ''
  return { enabled: !!root && !!role, role, root }
}

/**
 * outbox 是否仍有传输层在消费：SMB 与中央 HTTP **任一**启用都成立。
 * 生产侧据此决定「登记 outbox 交给传输层」还是「本机直接落地」——
 * 不能让判据停留在 `getLanSyncConfig().enabled`：中央同步启用会关闭 SMB，
 * 那样 SLA1 主管升级通知就会既不进 outbox 也不出机（静默丢失，§三.6）。
 */
export function outboxTransportEnabled(): boolean {
  const cfg = ConfigService.getInstance()
  return Boolean(cfg.get('centralSyncEnabled')) || getLanSyncConfig().enabled
}

/** 终端标识：身份档案姓名优先，未建档回退机器名；目录名安全化 */
export function getTerminalId(): string {
  const raw = getIdentity()?.name || hostname() || 'unknown'
  return deliveryKey(raw)
}

/**
 * 投递键（下行队列目录名）：按接收者身份（销售姓名）稳定、安全、可重复计算——
 * 中枢按 assignment 的 sales_name 路由，终端按本机身份档案姓名计算同一个键，
 * 两端独立计算结果一致。名字只做文件系统安全化 + 限长，绝不使用未经处理的原文。
 */
export function deliveryKey(name: string): string {
  return String(name || '').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 120) || 'unknown'
}

/** 当前姓名投递键无法区分两个不同身份时，返回明确冲突；不引入终端注册表。 */
export function deliveryKeyConflict(names: string[]): string | null {
  const seen = new Map<string, string>()
  for (const raw of names) {
    const name = String(raw || '').trim()
    if (!name) continue
    const key = deliveryKey(name)
    const previous = seen.get(key)
    if (previous) {
      return previous === name
        ? `销售姓名「${name}」重复，无法唯一绑定投递键「${key}」`
        : `销售身份「${previous}」与「${name}」共用投递键「${key}」`
    }
    seen.set(key, name)
  }
  return null
}

function downDeliveryKeyConflict(type: string, payload: Record<string, unknown>): string | null {
  const salesList = ConfigService.getInstance().get('crmSalesList')
  if (Array.isArray(salesList)) {
    const configured = deliveryKeyConflict(salesList.map((s) => String(s)))
    if (configured) return configured
  }
  if (type === 'transfer') {
    const from = String(payload.fromSales || '').trim()
    const to = String(payload.toSales || '').trim()
    if (from && to && from === to) return `移交双方使用同一销售姓名「${from}」，无法区分原/新终端`
    if (from && to && from !== to && deliveryKey(from) === deliveryKey(to)) {
      return `移交双方「${from}」与「${to}」共用投递键「${deliveryKey(from)}」`
    }
  }
  return null
}

/** 同步轮巡间隔（分钟）：配置 lanSyncPollIntervalMin，1-60，默认 1 */
function pollIntervalMin(): number {
  const n = Number(ConfigService.getInstance().get('lanSyncPollIntervalMin') ?? 1)
  return Number.isFinite(n) && n >= 1 && n <= 60 ? n : 1
}

// ─── 事件文件 ────────────────────────────────────────────────────────────────
export type DeliveryRole = 'apply' | 'remove' | 'notify'

export interface SyncEventFile {
  eventSeq: number
  idempotencyKey: string
  type: string
  /** 投递角色：apply=应用权属 / remove=移除权属（transfer 原销售）/ notify=主管通知 */
  deliveryRole?: DeliveryRole
  /** 接收者投递键（下行事件带，供 ACK 回填路由） */
  to?: string
  payload: Record<string, unknown>
  emittedAt: number
  /** 上行事件的发出终端标识（下行无） */
  from?: string
  /**
   * 下行指令的**来源设备**（中央 HTTP 通道独有：取自信封 entityId 的设备命名空间前缀）。
   * 用途：① hub leadId → 本地 lead id 映射必须按来源设备命名（不同发送设备的本地行号空间
   * 互不相通，裸 hubLeadId 撞号会回收错线索）；② 该员工的中央归属 id（targetEmployeeId）
   * 落库到 assignment.owner_employee_id，作为同名员工的权威归属核对依据。
   * SMB 文件通道不携带（历史口径），两个字段缺省 = 既有行为。
   */
  sourceDeviceId?: string
  targetEmployeeId?: string
}

const DOWN_TYPES = ['assign', 'transfer', 'recycle', 'sla1_escalate_supervisor'] as const
const UP_TYPES = ['claim', 'bind_wx', 'first_touch'] as const

/** ACK 回执结果（终端 → 中枢）：applied/conflict/invalid 为终态，nolead 可重试 */
export type AckOutcome = 'applied' | 'conflict' | 'nolead' | 'invalid'
const ACK_CODE: Record<AckOutcome, number> = { nolead: 0, applied: 1, conflict: 2, invalid: 3 }

export function safeFilePart(s: string): string {
  return String(s).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 120) || 'event'
}

/** 写事件文件：tmp+rename 原子写（atomicWriteFileSync 铁律），目标已存在则跳过（重放安全）；返回是否真实落盘 */
function writeEventFile(path: string, ev: SyncEventFile): boolean {
  if (existsSync(path)) return false
  atomicWriteFileSync(path, Buffer.from(JSON.stringify(ev), 'utf-8'))
  return true
}

/** 目录下待消费事件文件（*.json，.tmp 半截文件天然被过滤；按文件名升序 = 按 eventSeq 顺序） */
function listEventFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('.')).sort()
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
const outcomeKey = (idempotencyKey: string) => `syncOutcome:${idempotencyKey}`
/** ACK 结算标记键：无损绑定原始 idempotencyKey+role（scan_state 是 TEXT 键，不经文件系统安全化，
 *  有损的 safeFilePart 截断/替换会制造碰撞——`a/b` 与 `a:b`、前 120 字符相同的两个 key 必须可区分） */
const ackKey = (to: string, idempotencyKey: string, role: DeliveryRole) => `syncAck:${to}:${idempotencyKey}#${role}`

// ─── 下行路由：一个业务事件 → 各接收者（每接收者独立投递与 ACK）───────────────
/**
 * 事件接收者规则（2026-09-08 修订）：
 *   assign   → 新销售（apply）；
 *   recycle  → 原销售（apply，本地把行置 recycled + 期限回哨兵）；
 *   transfer → 新销售（apply，新权属）+ 原销售（remove，权属移除，不建新行）；
 *   sla1_escalate_supervisor → 中枢自己的队列（notify；中枢 = 主管/分配员工作机）。
 * 投递键按接收者身份重复计算；空名字 = 无法路由（调用方标 failed 留审计）。
 */
export function routeDownRecipients(type: string, payload: Record<string, unknown>): Array<{ key: string; role: DeliveryRole }> {
  const p = payload || {}
  if (type === 'assign' || type === 'recycle') {
    const s = String(p.salesName || '').trim()
    return s ? [{ key: deliveryKey(s), role: 'apply' as const }] : []
  }
  if (type === 'transfer') {
    const from = String(p.fromSales || '').trim()
    const to = String(p.toSales || '').trim()
    const out: Array<{ key: string; role: DeliveryRole }> = []
    if (to) out.push({ key: deliveryKey(to), role: 'apply' })
    if (from) out.push({ key: deliveryKey(from), role: 'remove' })
    return out
  }
  if (type === 'sla1_escalate_supervisor') {
    return [{ key: deliveryKey(getTerminalId()), role: 'notify' }]
  }
  return []
}

/** 投递身份哈希：sha256(`<原始幂等键>#<角色>`) 前 16 hex——文件系统安全且抗碰撞 */
export function deliveryHash(idempotencyKey: string, role: DeliveryRole): string {
  return createHash('sha256').update(`${idempotencyKey}#${role}`, 'utf-8').digest('hex').slice(0, 16)
}

/**
 * 投递/ACK 文件基名（不含扩展名）：`<可读前缀>-<身份哈希>-<角色>`。
 * ⚠️ 只由幂等键+角色决定——同一业务事件的原始投递与任何重复投递（换文件名/换 eventSeq）
 * 都映射到同一基名，ACK 幂等标记才能命中；⚠️ 可读前缀经过 safeFilePart（有损），碰撞由
 * 强哈希兜底：`a/b` 与 `a:b`、前 120 字符相同但尾部不同的两个 key，哈希必不同。
 */
export function deliveryBase(idempotencyKey: string, role: DeliveryRole): string {
  return `${safeFilePart(idempotencyKey).slice(0, 80)}-${deliveryHash(idempotencyKey, role)}-${role}`
}

/** 下行事件文件名：`<seq8>-<投递基名>.json`（seq 前缀只用于队列内排序）。导出供测试计算规范名。 */
export function deliveryFileName(eventSeq: number, idempotencyKey: string, role: DeliveryRole): string {
  return `${String(Math.max(0, eventSeq)).padStart(8, '0')}-${deliveryBase(idempotencyKey, role)}.json`
}

function downQueueDir(root: string, key: string): string {
  return join(root, 'down', key)
}

// ─── 下行产出（中枢）：pending outbox → 各接收者队列事件文件（行保持 pending）─
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
 * 中枢下行产出：先结算已 ACK 的投递（settleDownDeliveries），再把仍 pending 的
 * assign/transfer/recycle/主管通知写进每个接收者的队列文件。目录不可写/未挂载：
 * 整轮 failed 返回、行保持 pending 等下轮重放（不抛错不惊扰）。
 * ⚠️ 文件落盘 ≠ 终端已接收：outbox 行要等全部接收者 ACK applied 才由结算标 sent。
 */
export function emitDownEvents(root: string): EmitResult {
  const r: EmitResult = { emitted: 0, failed: 0 }
  try {
    if (!existsSync(join(root, 'down'))) mkdirSync(join(root, 'down'), { recursive: true })
  } catch (e) {
    console.warn('[LanSync] 共享目录不可写，本轮下行产出跳过:', e)
    return { emitted: 0, failed: -1 }
  }
  const rows = crmDbService.all("SELECT * FROM outbox_event WHERE status = 'pending' ORDER BY event_seq")
  for (const row of rows) {
    let payload: Record<string, unknown>
    try { payload = JSON.parse(String(row.payload || '{}')) } catch { continue }
    const type = payload.type
    if (typeof type !== 'string' || !(DOWN_TYPES as readonly string[]).includes(type)) continue
    const key = String(row.idempotency_key || '')
    if (!key) continue
    let lead: Record<string, unknown> | null = null
    try {
      const keyConflict = downDeliveryKeyConflict(type, payload)
      if (keyConflict) {
        const at = Date.now()
        crmDbService.runTx((tx) => {
          tx.run("UPDATE outbox_event SET status = 'failed', updated_at = ? WHERE id = ? AND status = 'pending'", [at, Number(row.id)])
          tx.run('INSERT INTO audit_event (actor, action, entity_type, entity_id, detail, created_at) VALUES (?,?,?,?,?,?)',
            ['system:sync', 'sync_down_delivery_key_conflict', 'outbox', Number(row.id), JSON.stringify({ type, idempotencyKey: key, reason: keyConflict }), at])
        })
        r.failed++
        continue
      }
      // 升级兼容（惰性，与中央 HTTP 发射端**共用同一个 helper**）：升级前写出的 pending transfer
      // 载荷缺 mode/sla1Deadline，按注册表已属必填。从本机 assignment 行恢复当时写入的绝对值，
      // 不改幂等键、不改 event_seq —— 文件名仍由 (event_seq, key, role) 决定，故富化后目标文件名不变：
      // 升级前写出的旧文件会被终端本体校验判非法、隔离进 .failed/（移出队列目录），路径随之空出，
      // 本轮即可补写合法文件；writeEventFile 在路径占用时跳过，因此最坏两轮收敛，不会永久死锁。
      // 恢复不了则不猜值、不落盘：本行终态 failed + 脱敏审计（只有行号、类型与稳定错误码）。
      // 置于投递键冲突检查**之后**：冲突行的真实病因是路由（两个身份共用一个队列目录），
      // 那个诊断更具体、更可操作，不该被「载荷缺字段」盖掉。
      const healed = healLegacyDownPayload(type, payload)
      if (!healed.ok) {
        const at = Date.now()
        crmDbService.runTx((tx) => {
          tx.run("UPDATE outbox_event SET status = 'failed', updated_at = ? WHERE id = ? AND status = 'pending'", [at, Number(row.id)])
          tx.run('INSERT INTO audit_event (actor, action, entity_type, entity_id, detail, created_at) VALUES (?,?,?,?,?,?)',
            ['system:sync', 'sync_down_payload_unrecoverable', 'outbox', Number(row.id), JSON.stringify({ type, reason: healed.code }), at])
        })
        r.failed++
        continue
      }
      payload = healed.payload
      lead = leadProfileOf(payload.leadId)
      const recipients = routeDownRecipients(type, payload)
      if (!recipients.length) {
        // 无法路由（如 payload 缺目标销售）：标 failed + 审计，绝不静默丢
        const at = Date.now()
        crmDbService.runTx((tx) => {
          tx.run("UPDATE outbox_event SET status = 'failed', updated_at = ? WHERE id = ? AND status = 'pending'", [at, Number(row.id)])
          tx.run('INSERT INTO audit_event (actor, action, entity_type, entity_id, detail, created_at) VALUES (?,?,?,?,?,?)',
            ['system:sync', 'sync_down_unroutable', 'outbox', Number(row.id),
             JSON.stringify({ type, idempotencyKey: key, reason: '无接收者（payload 缺目标身份）' }), at])
        })
        r.failed++
        continue
      }
      for (const rc of recipients) {
        const ev: SyncEventFile = {
          eventSeq: Number(row.event_seq || 0),
          idempotencyKey: key,
          type,
          deliveryRole: rc.role,
          to: rc.key,
          payload: type === 'sla1_escalate_supervisor'
            ? { ...payload, lead }
            : { ...payload, lead, slaHours: slaHoursNow() },
          emittedAt: Date.now()
        }
        const dir = downQueueDir(root, rc.key)
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
        if (writeEventFile(join(dir, deliveryFileName(ev.eventSeq, key, rc.role)), ev)) r.emitted++
      }
    } catch (e) {
      r.failed++
      console.warn(`[LanSync] 下行事件落盘失败 key=${key}:`, e)
    }
  }
  if (r.emitted > 0) crmDbService.setScanState(K_LAST_DOWN_EMIT, Date.now())
  return r
}

// ─── ACK 结算（中枢）：ACK 标记 → outbox 行 sent/failed → 清理残留文件 ─────────
export interface SettleResult { completed: number; failedRows: number }

/** 静默尽力清理：只隔离本业务事件的实际投递文件，保留可审计。 */
function quarantineDelivery(root: string, key: string, eventSeq: number, idempotencyKey: string, role: DeliveryRole): void {
  const dir = downQueueDir(root, key)
  const fileName = deliveryFileName(eventSeq, idempotencyKey, role)
  const path = join(dir, fileName)
  if (!existsSync(path)) return
  try {
    const ev = readEventFile(path)
    if (!ev || ev.idempotencyKey !== idempotencyKey || ev.deliveryRole !== role || ev.to !== key) return
    const failedDir = join(dir, '.failed')
    if (!existsSync(failedDir)) mkdirSync(failedDir, { recursive: true })
    renameSync(path, join(failedDir, fileName))
  } catch { /* 清理失败不影响结算状态 */ }
}

/**
 * ACK 结算：逐条 pending 下行 outbox 行，取其全部接收者投递的 ACK 标记：
 *   全部 applied            → 行标 sent（投递完成），清理残留文件；
 *   任一 conflict/invalid   → 行标 failed + 审计（失败事件保留可审计状态），文件入 .failed/；
 *   否则（含 nolead/未 ACK）→ 行保持 pending 等下一轮（nolead 可重试，未收到 ACK 不清理）。
 * 一个接收者 ACK 不会影响其他接收者的独立投递状态。
 */
export function settleDownDeliveries(root: string): SettleResult {
  const r: SettleResult = { completed: 0, failedRows: 0 }
  const rows = crmDbService.all("SELECT * FROM outbox_event WHERE status = 'pending' ORDER BY event_seq")
  for (const row of rows) {
    let payload: Record<string, unknown>
    try { payload = JSON.parse(String(row.payload || '{}')) } catch { continue }
    const type = payload.type
    if (typeof type !== 'string' || !(DOWN_TYPES as readonly string[]).includes(type)) continue
    const key = String(row.idempotency_key || '')
    if (!key) continue
    const keyConflict = downDeliveryKeyConflict(type, payload)
    if (keyConflict) {
      const recipients = routeDownRecipients(type, payload)
      const now = Date.now()
      crmDbService.runTx((tx) => {
        tx.run("UPDATE outbox_event SET status = 'failed', updated_at = ? WHERE id = ? AND status = 'pending'", [now, Number(row.id)])
        tx.run('INSERT INTO audit_event (actor, action, entity_type, entity_id, detail, created_at) VALUES (?,?,?,?,?,?)',
          ['system:sync', 'sync_down_delivery_key_conflict', 'outbox', Number(row.id), JSON.stringify({ type, idempotencyKey: key, reason: keyConflict }), now])
      })
      for (const rc of recipients) quarantineDelivery(root, rc.key, Number(row.event_seq || 0), key, rc.role)
      r.failedRows++
      continue
    }
    const recipients = routeDownRecipients(type, payload)
    if (!recipients.length) continue // 无法路由的行由 emitDownEvents 标 failed
    const marks = recipients.map((rc) => Number(crmDbService.getScanState(ackKey(rc.key, key, rc.role))))
    const allApplied = marks.length > 0 && marks.every((m) => m === ACK_CODE.applied)
    const anyFailed = marks.some((m) => m === ACK_CODE.conflict || m === ACK_CODE.invalid)
    if (!allApplied && !anyFailed) continue
    const now = Date.now()
    const nextStatus = allApplied ? 'sent' : 'failed'
    crmDbService.runTx((tx) => {
      tx.run('UPDATE outbox_event SET status = ?, updated_at = ? WHERE id = ? AND status = \'pending\'', [nextStatus, now, Number(row.id)])
      if (!allApplied) {
        tx.run('INSERT INTO audit_event (actor, action, entity_type, entity_id, detail, created_at) VALUES (?,?,?,?,?,?)',
          ['system:sync', 'sync_down_fail', 'outbox', Number(row.id),
           JSON.stringify({
             type, idempotencyKey: key,
             deliveries: recipients.map((rc, i) => ({ to: rc.key, role: rc.role, outcome: marks[i] === ACK_CODE.conflict ? 'conflict' : marks[i] === ACK_CODE.invalid ? 'invalid' : 'pending' }))
           }), now])
      }
    })
    for (const rc of recipients) quarantineDelivery(root, rc.key, Number(row.event_seq || 0), key, rc.role)
    if (allApplied) r.completed++
    else r.failedRows++
  }
  return r
}

// ─── ACK 消费（中枢）：up/<终端>/ack/ → scan_state 标记 → 删 ACK 文件 ──────────
export interface AckConsumeResult { recorded: number; skippedDup: number; failed: number }

interface AckFile {
  base?: string
  key?: string
  to?: string
  role?: string
  outcome?: string
  terminal?: string
}

function isolateAck(path: string): void {
  try { renameSync(path, `${path}.bad`) } catch { /* ignore */ }
}

/** ACK 必须由其目录、真实 pending outbox 及该事件的真实接收者共同证明。 */
function validateAck(ack: AckFile, directoryTerminal: string): { key: string; base: string; role: DeliveryRole; outcome: AckOutcome } | null {
  const key = String(ack.key || '')
  const to = String(ack.to || '')
  const role = String(ack.role || '') as DeliveryRole
  const base = String(ack.base || '')
  const outcome = String(ack.outcome || '') as AckOutcome
  if (!key || !to || !base || to !== directoryTerminal || String(ack.terminal || '') !== directoryTerminal) return null
  if (!Object.prototype.hasOwnProperty.call(ACK_CODE, outcome) || (role !== 'apply' && role !== 'remove' && role !== 'notify')) return null
  if (base !== deliveryBase(key, role)) return null

  const pending = crmDbService.all("SELECT payload FROM outbox_event WHERE status = 'pending' AND idempotency_key = ?", [key])
  if (pending.length !== 1) return null
  let payload: Record<string, unknown>
  try { payload = JSON.parse(String(pending[0].payload || '{}')) } catch { return null }
  const type = payload.type
  if (typeof type !== 'string' || !(DOWN_TYPES as readonly string[]).includes(type)) return null
  const expected = routeDownRecipients(type, payload).some((rc) => rc.key === to && rc.role === role)
  return expected ? { key, base, role, outcome } : null
}

/**
 * 中枢消费终端 ACK：ACK 文件所在目录是发送终端的权威身份，且 ACK 必须对应当前 pending
 * outbox 的 idempotencyKey、真实接收者和 deliveryRole。非法 ACK 移入 .bad，不写 syncAck。
 * nolead 不落标记；合法 ACK 处理完删除。重复 ACK 仅在对应 outbox 仍 pending 时幂等消费。
 */
export function processUpAcks(root: string): AckConsumeResult {
  const r: AckConsumeResult = { recorded: 0, skippedDup: 0, failed: 0 }
  const upRoot = join(root, 'up')
  if (!existsSync(upRoot)) return r
  let dirs: string[] = []
  try {
    dirs = readdirSync(upRoot).filter((d) => {
      try { return statSync(join(upRoot, d)).isDirectory() } catch { return false }
    })
  } catch { return r }
  const ownTid = getTerminalId()
  for (const d of dirs) {
    if (d === ownTid) continue // 中枢不消费自己的 up（角色差异纪律）
    const ackDir = join(upRoot, d, 'ack')
    for (const f of listEventFiles(ackDir)) {
      const path = join(ackDir, f)
      let ack: AckFile
      try { ack = JSON.parse(readFileSync(path, 'utf-8')) } catch {
        isolateAck(path)
        r.failed++
        continue
      }
      const valid = validateAck(ack, d)
      if (!valid) {
        isolateAck(path)
        r.failed++
        continue
      }
      const { key, base, role, outcome } = valid
      const to = d
      if (Number(crmDbService.getScanState(ackKey(to, key, role))) > 0) {
        try { rmSync(path, { force: true }) } catch { /* ignore */ }
        r.skippedDup++
        continue
      }
      if (outcome !== 'nolead') {
        crmDbService.setScanState(ackKey(to, key, role), ACK_CODE[outcome])
        r.recorded++
      }
      // nolead：不落标记（投递未完成），ACK 文件消费掉即可，等终端重试后的新回执
      try { rmSync(path, { force: true }) } catch { /* ignore */ }
    }
  }
  return r
}

// ─── 下行消费（终端）：只读自己的队列 → 应用 → 幂等标记 → ACK → 清理 ──────────
export interface ConsumeResult { applied: number; skippedDup: number; conflict: number; nolead: number; invalid: number; failed: number }

/**
 * 按身份解析本机 lead（跨机 id 不可信，主锚点 = contact_type+contact_normalized）。
 * 解析顺序（2026-09-17 三轮收口：中央通道 fail closed，裸 id 兼容仅保留给历史通道）：
 *   ① 联系方式锚点（assign/transfer 载荷带 lead 资料时的唯一权威锚点）；带锚点而未命中 =
 *      本机没有该 lead（联系方式即身份），调用方据此建档——**绝不**回落裸 id（不同设备的
 *      本地行号空间互不相通，同号只是巧合，命中即错线索）；
 *   ② 中央通道（带 sourceDeviceId）：**只有**来源设备命名空间下的映射
 *      `centralSync:hubLead:<src>:<hubId>` 能建立对应；映射缺失或指向已不存在的行 →
 *      返回未解析（调用方按 noop/审计处理），绝不回落裸 id；
 *   ③ Phase 1 SMB 历史通道（无 sourceDeviceId）且无 lead 锚点：保留**明确允许**的裸 id
 *      兼容（两端同库/同源导入、行号对齐的既有部署口径，行为不变）；未命中走 noop/nolead。
 */
function findLocalLead(
  tx: { all: (sql: string, params?: unknown[]) => CrmRow[] },
  lead: Record<string, unknown> | null | undefined,
  fallbackLeadId: unknown,
  sourceDeviceId?: string
): CrmRow | null {
  const ct = String(lead?.contactType || '').trim()
  const cn = String(lead?.contactNormalized || '').trim()
  if (ct && cn) {
    const hit = tx.all('SELECT * FROM lead WHERE contact_type = ? AND contact_normalized = ?', [ct, cn])
    if (hit.length) return hit[0]
    // 有身份锚点而未命中 = 本机没有该 lead（建档由调用方决定）；不再回落裸 id 撞同号行
    return null
  }
  const fid = Number(fallbackLeadId)
  if (!Number.isSafeInteger(fid) || fid <= 0) return null
  if (sourceDeviceId) {
    // 中央通道（fail closed，2026-09-17 第三轮收口）：裸 hubLeadId 属于「来源设备的行号空间」，
    // 与本地行号空间互不相通——**只有映射**能建立与本地行的对应。映射缺失、或映射指向的行
    // 已不存在 → 返回未解析（调用方按 noop/审计处理）；绝不回落裸 id：同号只是巧合，
    // 命中即错线索（诱饵负例：无映射＋同号、失效映射＋同号）。
    // 已知边界：本修复上线**之前**经中央分配的存量线索没有映射，其后续 recycle 会落
    // 「leadUnknown 空操作」审计（线索滞留，不误回收）；持久修法 = recycle 载荷带 lead 资料
    // （下行契约变更，另轮处理）。
    const mapped = Number(tx.all('SELECT last_scan AS v FROM scan_state WHERE key = ?',
      [`centralSync:hubLead:${sourceDeviceId}:${fid}`])[0]?.v || 0)
    if (mapped > 0) {
      const hit = tx.all('SELECT * FROM lead WHERE id = ?', [mapped])
      if (hit.length) return hit[0]
    }
    return null
  }
  // Phase 1 SMB 历史通道（无来源设备命名空间）：**明确允许**的裸 id 兼容——
  // 两端同库/同源导入、行号对齐的既有部署口径，行为不变。
  const hit = tx.all('SELECT * FROM lead WHERE id = ?', [fid])
  if (hit.length) return hit[0]
  return null
}

/**
 * 落地事务内记录「来源设备 + hub leadId → 本地 lead id」映射（下行后续 recycle/remove 的兜底
 * 身份锚点）。中央 HTTP 通道恒带 sourceDeviceId；SMB 历史文件不带 → 不写映射、行为不变。
 */
function recordHubLeadMappingTx(
  tx: { run: (sql: string, params?: unknown[]) => number },
  sourceDeviceId: string | undefined,
  hubLeadId: unknown,
  localLeadId: number
): void {
  const hubId = Number(hubLeadId)
  if (!sourceDeviceId || !Number.isSafeInteger(hubId) || hubId <= 0 || !(localLeadId > 0)) return
  tx.run('INSERT INTO scan_state (key, last_scan) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET last_scan = excluded.last_scan',
    [`centralSync:hubLead:${sourceDeviceId}:${hubId}`, localLeadId])
}

const ACTIVE_STATUS_SQL = "status IN ('assigned','claimed')"

/** 终端随下行事件建档（lead 基础资料齐备，设计 §3）：assign / transfer-apply 共用 */
function createLeadFromInfoTx(
  tx: { run: (sql: string, params?: unknown[]) => number },
  leadInfo: Record<string, unknown>,
  sla1: number,
  now: number
): number {
  return tx.run(
    'INSERT INTO lead (contact_type, contact_normalized, contact_raw, wechat, source, name, note, status, first_contact_deadline, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    [String(leadInfo.contactType || 'phone'), String(leadInfo.contactNormalized || ''), String(leadInfo.contactRaw || ''),
      String(leadInfo.wechat || ''), String(leadInfo.source || '同步'), String(leadInfo.name || ''), String(leadInfo.note || ''),
      'NEW', sla1 || LEAD_SLA_UNASSIGNED_SENTINEL, now, now]
  )
}

/** 应用一条下行事件（调用方事务内）；返回 'applied' | 'conflict' | 'nolead' | 'invalid'
 *  （可选 touched 收集器：由调用方传入，事务提交后据此发失效通知——事务内绝不直接通知） */
function applyDownEventTx(
  tx: { run: (sql: string, params?: unknown[]) => number; all: (sql: string, params?: unknown[]) => CrmRow[] },
  ev: SyncEventFile,
  touched?: { leadIds: number[] }
): 'applied' | 'conflict' | 'nolead' | 'invalid' {
  const p = ev.payload || {}
  const leadInfo = (p.lead && typeof p.lead === 'object' ? p.lead : null) as Record<string, unknown> | null
  const now = Date.now()
  const actor = String(p.actor || 'system:sync')
  const sla1 = Number(p.sla1Deadline || 0) || 0

  let lead = findLocalLead(tx, leadInfo, p.leadId, ev.sourceDeviceId)
  if (ev.type === 'assign') {
    if (!lead && leadInfo) {
      // 终端本机没有该 lead → 随下行事件建档（lead 基础资料齐备，设计 §3）
      const newId = createLeadFromInfoTx(tx, leadInfo, sla1, now)
      lead = tx.all('SELECT * FROM lead WHERE id = ?', [newId])[0]
    }
    if (!lead) return 'nolead'
    const leadId = Number(lead.id)
    recordHubLeadMappingTx(tx, ev.sourceDeviceId, p.leadId, leadId)
    const cur = tx.all(`SELECT id FROM assignment WHERE lead_id = ? AND deleted = 0 AND ${ACTIVE_STATUS_SQL} ORDER BY id DESC LIMIT 1`, [leadId])
    if (cur.length) return 'conflict' // 已有有效归属，中枢指令与本地状态打架 → 不覆盖，留人工
    // 既有 lead：补全空资料 + 首触期限跟中枢 sla1（分配起计时口径同 assignLeads）
    tx.run(
      "UPDATE lead SET name = CASE WHEN name = '' OR name IS NULL THEN ? ELSE name END, wechat = CASE WHEN wechat = '' OR wechat IS NULL THEN ? ELSE wechat END, first_contact_deadline = ?, updated_at = ? WHERE id = ?",
      [String(leadInfo?.name || ''), String(leadInfo?.wechat || ''), sla1 || Number(lead.first_contact_deadline || LEAD_SLA_UNASSIGNED_SENTINEL), now, leadId]
    )
    // owner_employee_id = 指令声明的中央归属员工 id（信封 targetEmployeeId，服务端按它路由）：
    // 同名员工各自设备只认自己的 id；SMB 历史文件不带 → 落 NULL，走既有姓名集合口径
    tx.run(
      'INSERT INTO assignment (lead_id, sales_name, owner_employee_id, mode, sla1_deadline, sla2_scan_ref, status, source, updated_by, updated_at, version, deleted) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      [leadId, String(p.salesName || ''), String(ev.targetEmployeeId || ''), String(p.mode || 'manual'), sla1 || null, '', 'assigned', 'sync:down', actor, now, 1, 0]
    )
    tx.run('INSERT INTO audit_event (actor, action, entity_type, entity_id, detail, created_at) VALUES (?,?,?,?,?,?)',
      ['system:sync', 'sync_apply', 'lead', leadId, JSON.stringify({ type: 'assign', idempotencyKey: ev.idempotencyKey, salesName: String(p.salesName || ''), hubLeadId: Number(p.leadId || 0) }), now])
    touched?.leadIds.push(leadId)
    return 'applied'
  }

  if (ev.type === 'transfer' || ev.type === 'recycle') {
    // 队列内文件按 event_seq 有序：同 lead 的 assign 必先于 recycle/remove 到达并被应用。
    // 因此「本地无该 lead」只可能是迟到 enroll/外部兜底场景：remove/recycle 记审计空操作（leadUnknown），
    // 不挂死队列；transfer-apply 则随事件建档后正常应用（payload 带全 lead 资料）。
    if (!lead && ev.type === 'transfer' && ev.deliveryRole !== 'remove' && leadInfo) {
      const newId = createLeadFromInfoTx(tx, leadInfo, sla1, now)
      lead = tx.all('SELECT * FROM lead WHERE id = ?', [newId])[0]
    }
    if (!lead) {
      if (ev.type === 'transfer' && ev.deliveryRole === 'remove') {
        tx.run('INSERT INTO audit_event (actor, action, entity_type, entity_id, detail, created_at) VALUES (?,?,?,?,?,?)',
          ['system:sync', 'sync_apply', 'lead', null, JSON.stringify({ type: 'transfer_remove_noop', idempotencyKey: ev.idempotencyKey, leadUnknown: true, toSales: String(p.toSales || '') }), now])
        return 'applied'
      }
      if (ev.type === 'recycle') {
        tx.run('INSERT INTO audit_event (actor, action, entity_type, entity_id, detail, created_at) VALUES (?,?,?,?,?,?)',
          ['system:sync', 'sync_apply', 'lead', null, JSON.stringify({ type: 'recycle_noop', idempotencyKey: ev.idempotencyKey, leadUnknown: true }), now])
        return 'applied'
      }
      return 'nolead'
    }
    const leadId = Number(lead.id)
    // transfer-apply 也登记来源设备命名空间的 hub→本地映射（后续 recycle/remove 依赖它解析）
    recordHubLeadMappingTx(tx, ev.sourceDeviceId, p.leadId, leadId)
    const cur = tx.all(`SELECT * FROM assignment WHERE lead_id = ? AND deleted = 0 AND ${ACTIVE_STATUS_SQL} ORDER BY id DESC LIMIT 1`, [leadId])[0]
    if (ev.type === 'recycle') {
      if (cur) {
        tx.run("UPDATE assignment SET status = 'recycled', updated_by = ?, updated_at = ?, version = version + 1 WHERE id = ?", [actor, now, Number(cur.id)])
        touched?.leadIds.push(leadId)
      }
      tx.run('UPDATE lead SET first_contact_deadline = ?, updated_at = ? WHERE id = ?', [LEAD_SLA_UNASSIGNED_SENTINEL, now, leadId])
      tx.run('INSERT INTO audit_event (actor, action, entity_type, entity_id, detail, created_at) VALUES (?,?,?,?,?,?)',
        ['system:sync', 'sync_apply', 'lead', leadId, JSON.stringify({ type: 'recycle', idempotencyKey: ev.idempotencyKey, reason: String(p.reason || '') }), now])
      return 'applied'
    }
    // transfer：投递角色分流（2026-09-08）——
    //   apply（新销售）：旧行 transferred + 新行 assigned（sla1 重起计时）
    //   remove（原销售）：只把自己名下权属移除（旧行 transferred），绝不建新行
    if (ev.deliveryRole === 'remove') {
      if (cur) {
        tx.run("UPDATE assignment SET status = 'transferred', updated_by = ?, updated_at = ?, version = version + 1 WHERE id = ?", [actor, now, Number(cur.id)])
        touched?.leadIds.push(leadId)
      }
      tx.run('INSERT INTO audit_event (actor, action, entity_type, entity_id, detail, created_at) VALUES (?,?,?,?,?,?)',
        ['system:sync', 'sync_apply', 'lead', leadId, JSON.stringify({ type: 'transfer_remove', idempotencyKey: ev.idempotencyKey, toSales: String(p.toSales || ''), hadActiveRow: !!cur }), now])
      return 'applied'
    }
    if (cur) return 'conflict' // 新销售已有有效归属，中枢移交与本地状态冲突，不覆盖本地权属
    tx.run(
      'INSERT INTO assignment (lead_id, sales_name, owner_employee_id, mode, sla1_deadline, sla2_scan_ref, status, source, updated_by, updated_at, version, deleted) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      [leadId, String(p.toSales || ''), String(ev.targetEmployeeId || ''), String(p.mode || 'manual'), sla1 || null, '', 'assigned', 'sync:down', actor, now, 1, 0]
    )
    tx.run('UPDATE lead SET first_contact_deadline = ?, updated_at = ? WHERE id = ?', [sla1 || Number(lead.first_contact_deadline || LEAD_SLA_UNASSIGNED_SENTINEL), now, leadId])
    tx.run('INSERT INTO audit_event (actor, action, entity_type, entity_id, detail, created_at) VALUES (?,?,?,?,?,?)',
      ['system:sync', 'sync_apply', 'lead', leadId, JSON.stringify({ type: 'transfer', idempotencyKey: ev.idempotencyKey, toSales: String(p.toSales || '') }), now])
    touched?.leadIds.push(leadId)
    return 'applied'
  }
  return 'invalid' // 未知类型/通知类型不应用（通知走中枢本机通道，不该到终端队列）
}

/**
 * Phase 3a HTTP adapter 的业务应用入口：复用 Phase 1 已封板的下行状态机与幂等标记，
 * 不经 SMB 文件系统。传输层只能换 adapter，禁止复制 assign/transfer/recycle 业务语义。
 */
export function applyDownEventDirect(ev: SyncEventFile): AckOutcome {
  const role = ev.deliveryRole
  if (role !== 'apply' && role !== 'remove' && role !== 'notify') return 'invalid'
  const mkey = `${ev.idempotencyKey}#${role}`
  const knownOutcome = Number(crmDbService.getScanState(outcomeKey(mkey)))
  if (crmDbService.getScanState(appliedKey(mkey)) > 0) {
    return knownOutcome === ACK_CODE.conflict ? 'conflict' : knownOutcome === ACK_CODE.invalid ? 'invalid' : 'applied'
  }
  const touched = { leadIds: [] as number[] }
  const outcome = crmDbService.runTx((tx) => {
    const next = applyDownEventTx(tx, { ...ev, deliveryRole: role }, touched)
    if (next === 'applied' || next === 'conflict') {
      tx.run('INSERT INTO scan_state (key, last_scan) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET last_scan = excluded.last_scan', [appliedKey(mkey), Date.now()])
      tx.run('INSERT INTO scan_state (key, last_scan) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET last_scan = excluded.last_scan', [outcomeKey(mkey), next === 'applied' ? ACK_CODE.applied : ACK_CODE.conflict])
    }
    return next
  })
  // 事务已提交才通知：只对真正改写 assignment 行的 applied 事件发（conflict/nolead/脏类型不发）
  const downAction: AssignmentInvalidationAction | null = ev.type === 'assign' ? 'assign' : ev.type === 'transfer' ? 'transfer' : ev.type === 'recycle' ? 'recycle' : null
  if (outcome === 'applied' && downAction && touched.leadIds.length) {
    emitAssignmentInvalidated(downAction, touched.leadIds)
  }
  return outcome
}

/** 终端写 ACK 回执（覆盖写：nolead → applied 的升级必须能覆盖旧回执） */
function writeAckFile(root: string, ev: SyncEventFile, base: string, outcome: AckOutcome): void {
  const ackDir = join(root, 'up', getTerminalId(), 'ack')
  if (!existsSync(ackDir)) mkdirSync(ackDir, { recursive: true })
  atomicWriteFileSync(join(ackDir, `${base}.json`), Buffer.from(JSON.stringify({
    base, to: String(ev.to || ''), key: ev.idempotencyKey, role: String(ev.deliveryRole || 'apply'),
    outcome, terminal: getTerminalId(), at: Date.now()
  }), 'utf-8'))
}

/**
 * 下行事件「本体校验」（2026-09-09 并发修复补强；2026-09-15 接入共享业务校验器）：进入任何业务事务/幂等标记/ACK 之前执行。
 * 校验失败返回原因（不写 lead/assignment/audit_event、不写 syncApplied/syncOutcome、
 * 不生成可被中枢接受的成功 ACK）；文件移入本机队列 .failed/ 保留可审计、计 failed。
 *   - ev.to 必须等于本机投递键（防替换/误放置的文件改写本机业务）；
 *   - eventSeq 必须是合法非负整数；
 *   - deliveryRole 必须显式存在且合法（禁止缺失时默认 apply）；
 *   - type/role 组合必须匹配：assign→apply；recycle→apply；transfer→apply|remove；
 *     sla1_escalate_supervisor 及未知类型不得由终端应用（通知走中枢本机通道）；
 *   - payload 业务校验走 shared/centralDownCommand.validateDownCommand(transport='smb')：
 *     白名单/必填/类型/枚举/lead 建档契约与中央 HTTP 同一份规则（lead 字段集按 smb 档 8 字段）；
 *   - 文件名必须与 deliveryFileName(eventSeq, idempotencyKey, role) 完全一致。
 */
export function validateDownEventFile(ev: SyncEventFile, ownDeliveryKey: string, fileName: string): string | null {
  if (typeof ev.to !== 'string' || ev.to !== ownDeliveryKey) return 'ev.to 与本机投递键不一致'
  if (typeof ev.eventSeq !== 'number' || !Number.isSafeInteger(ev.eventSeq) || ev.eventSeq < 0) {
    return 'eventSeq 非法'
  }
  const role = ev.deliveryRole
  if (role !== 'apply' && role !== 'remove' && role !== 'notify') {
    return 'deliveryRole 缺失或非法'
  }
  if (!ev.payload || typeof ev.payload !== 'object' || Array.isArray(ev.payload)) return '业务校验失败(invalid_payload)'
  // 类型/角色矩阵不再在本文件另写一份：以下行指令注册表为唯一真源（与中央 HTTP /sync/commands 同源）。
  // sla1_escalate_supervisor 由中枢本机消费（见 validateSupervisorNotificationFile），不经终端应用。
  const type = ev.type
  if (typeof type !== 'string' || !type) return 'type/role 组合非法'
  const spec = downCommandSpec(type)
  if (!spec || type === 'sla1_escalate_supervisor' || !spec.roles.includes(role)) return 'type/role 组合非法'
  // 聊天原文任何方向都不出机：下行文件同样递归扫描（报字段路径，不报值）
  const chatLeak = findForbiddenDownlinkField(ev.payload)
  if (chatLeak) {
    return `载荷含禁止下行字段(${chatLeak})`
  }
  // 业务校验（2026-09-15 接入共享校验器）：进入任何业务事务/幂等标记/ACK 之前，
  // payload 白名单/必填/类型/lead 建档契约一律走 shared/centralDownCommand 同一份规则
  // （transport='smb'：lead 保留历史 8 字段口径；目标存在性用上面已验证的本机投递键证明，
  //  SMB 没有中央 UUID target 字段，绝不伪造）。此前合法信封配 payload={} 也能进入状态机。
  const businessError = validateDownCommand({
    eventType: type, entityType: spec.entityType,
    payload: ev.payload,
    deliveryRole: role,
    localDeliveryKey: ev.to
  }, 'smb')
  if (businessError) return `业务校验失败(${businessError})`
  const expectedName = deliveryFileName(Number(ev.eventSeq), ev.idempotencyKey, role)
  if (fileName !== expectedName) {
    return `文件名(${fileName})与事件内容不一致(应为 ${expectedName})`
  }
  return null
}

/** 中枢自消费的主管通知也必须与原始 outbox 和规范投递文件逐项绑定。 */
function validateSupervisorNotificationFile(
  ev: SyncEventFile,
  ownDeliveryKey: string,
  fileName: string
): { outboxStatus: string } | null {
  if (ev.type !== 'sla1_escalate_supervisor' || ev.deliveryRole !== 'notify') return null
  if (String(ev.to || '') !== ownDeliveryKey) return null
  if (typeof ev.eventSeq !== 'number' || !Number.isSafeInteger(ev.eventSeq) || ev.eventSeq < 0) return null
  const key = typeof ev.idempotencyKey === 'string' ? ev.idempotencyKey : ''
  if (!key || fileName !== deliveryFileName(ev.eventSeq, key, 'notify')) return null
  const rows = crmDbService.all('SELECT event_seq, payload, status FROM outbox_event WHERE idempotency_key = ?', [key])
  if (rows.length !== 1 || Number(rows[0].event_seq) !== ev.eventSeq) return null
  const status = String(rows[0].status || '')
  if (status !== 'pending' && status !== 'sent') return null
  let payload: Record<string, unknown>
  try { payload = JSON.parse(String(rows[0].payload || '{}')) } catch { return null }
  const sourceType = payload.type
  if (sourceType !== 'sla1_escalate_supervisor') return null
  const sourceError = validateDownCommand({
    eventType: 'sla1_escalate_supervisor', entityType: 'assignment', payload,
    deliveryRole: 'notify', localDeliveryKey: ownDeliveryKey
  }, 'smb')
  if (sourceError) return null
  const expected = routeDownRecipients('sla1_escalate_supervisor', payload)
  if (expected.length !== 1 || expected[0].key !== ownDeliveryKey || expected[0].role !== 'notify') return null
  if (!ev.payload || typeof ev.payload !== 'object' || Array.isArray(ev.payload)) return null
  const body = ev.payload
  const bodyError = validateDownCommand({
    eventType: 'sla1_escalate_supervisor', entityType: 'assignment', payload: body,
    deliveryRole: 'notify', localDeliveryKey: ownDeliveryKey
  }, 'smb')
  if (bodyError) return null
  if (
    body.type !== payload.type ||
    body.leadId !== payload.leadId ||
    body.assignmentId !== payload.assignmentId ||
    body.remindCount !== payload.remindCount ||
    body.recycledAt !== payload.recycledAt ||
    body.salesName !== payload.salesName ||
    body.reason !== payload.reason
  ) return null
  return { outboxStatus: status }
}

/** 校验失败隔离：移入本机队列 .failed/（保留原文件供下轮/运维处理）；失败时原文件留在原地下轮重试 */
function isolateInvalidDownFile(dir: string, path: string, fileName: string): void {
  try {
    const failedDir = join(dir, '.failed')
    if (!existsSync(failedDir)) mkdirSync(failedDir, { recursive: true })
    renameSync(path, join(failedDir, fileName))
  } catch { /* 隔离失败时原文件保留，下轮继续处理 */ }
}

/**
 * 终端消费下行（2026-09-08 定向投递版）：**只读自己的队列** `down/<deliveryKey(本机身份)/>`，
 * 其他接收者的事件既不可见也不可碰（非目标终端不能应用、移动或删除）。
 * 逐文件应用（单事务：业务写 + syncApplied/syncOutcome 幂等标记）→ 写 ACK → 按结果清理：
 *   applied/conflict → ACK 后删事件文件（conflict 也标已应用：中枢权威指令与本地冲突时不反复重试，留人工）；
 *   nolead           → ACK(nolead) 后**保留**文件（lead 可能随后续事件到达，下轮重试）；
 *   invalid          → ACK 成功后移入自己队列的 .failed/ 隔离区（保留可审计状态）；
 * 本体校验失败（to/eventSeq/deliveryRole/type-role/文件名不一致）→ 零业务写零标记零 ACK，移入 .failed/；
 * 解析失败的毒文件改名 `.bad` 隔离（不反复重试）；重复投递命中 syncApplied → 按记录 outcome 补 ACK 零业务写。
 */
export function consumeDownEvents(root: string): ConsumeResult {
  const r: ConsumeResult = { applied: 0, skippedDup: 0, conflict: 0, nolead: 0, invalid: 0, failed: 0 }
  const own = deliveryKey(getTerminalId())
  const dir = downQueueDir(root, own)
  for (const f of listEventFiles(dir)) {
    const path = join(dir, f)
    const ev = readEventFile(path)
    if (!ev) {
      try { renameSync(path, `${path}.bad`) } catch { /* ignore */ }
      r.failed++
      continue
    }
    // 本体校验先行（2026-09-09）：不合法事件零业务写、零幂等标记、零 ACK，直接隔离 .failed/
    const invalidReason = validateDownEventFile(ev, own, f)
    if (invalidReason) {
      console.warn(`[LanSync] 下行事件本体校验失败（已隔离 .failed，零业务写）file=${f}: ${invalidReason}`)
      isolateInvalidDownFile(dir, path, f)
      r.failed++
      continue
    }
    const role: DeliveryRole = ev.deliveryRole as DeliveryRole
    // ACK 基名从事件内容推导（幂等键+角色），与文件名无关——重复投递换了文件名也命中同一 ACK 标记
    const base = deliveryBase(ev.idempotencyKey, role)
    const mkey = `${ev.idempotencyKey}#${role}`
    const knownOutcome = Number(crmDbService.getScanState(outcomeKey(mkey)))
    const isDup = crmDbService.getScanState(appliedKey(mkey)) > 0
    if (isDup) {
      // 重复投递：按记录 outcome 补 ACK，零业务写（本体校验已过，dup 路径安全）
      const oc: AckOutcome = knownOutcome === ACK_CODE.conflict ? 'conflict' : knownOutcome === ACK_CODE.invalid ? 'invalid' : 'applied'
      let ackWritten = false
      try { writeAckFile(root, ev, base, oc); ackWritten = true } catch { /* ACK 失败，保留文件由下轮 dup 路径补写 */ }
      r.skippedDup++
      if (ackWritten && (oc === 'applied' || oc === 'conflict')) { try { rmSync(path, { force: true }) } catch { /* ignore */ } }
      continue
    }
    try {
      const touched = { leadIds: [] as number[] }
      const outcome = crmDbService.runTx((tx) => {
        const o = applyDownEventTx(tx, ev, touched)
        if (o === 'applied' || o === 'conflict') {
          // conflict 也标记已应用：中枢权威指令与本地冲突时不反复重试，留人工（审计可查）
          tx.run('INSERT INTO scan_state (key, last_scan) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET last_scan = excluded.last_scan', [appliedKey(mkey), Date.now()])
          tx.run('INSERT INTO scan_state (key, last_scan) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET last_scan = excluded.last_scan', [outcomeKey(mkey), o === 'applied' ? ACK_CODE.applied : ACK_CODE.conflict])
        }
        return o
      })
      if (outcome === 'applied') {
        r.applied++
        // 事务已提交才通知（SMB 下行与中央 HTTP 共用 applyDownEventTx 状态机，两处提交点各自通知）
        const downAction: AssignmentInvalidationAction | null = ev.type === 'assign' ? 'assign' : ev.type === 'transfer' ? 'transfer' : ev.type === 'recycle' ? 'recycle' : null
        if (downAction && touched.leadIds.length) emitAssignmentInvalidated(downAction, touched.leadIds)
        let ackWritten = false
        try { writeAckFile(root, ev, base, 'applied'); ackWritten = true } catch { /* ACK 写失败：文件保留，下轮 dup 路径补 ACK */ }
        if (ackWritten) { try { rmSync(path, { force: true }) } catch { /* ignore */ } }
      } else if (outcome === 'conflict') {
        r.conflict++
        let ackWritten = false
        try { writeAckFile(root, ev, base, 'conflict'); ackWritten = true } catch { /* ACK 写失败：文件保留，下轮 dup 路径补 ACK */ }
        if (ackWritten) { try { rmSync(path, { force: true }) } catch { /* ignore */ } }
      } else if (outcome === 'invalid') {
        r.invalid++
        let ackWritten = false
        try { writeAckFile(root, ev, base, 'invalid'); ackWritten = true } catch { /* ACK 写失败：保留文件下轮重试 */ }
        if (ackWritten) isolateInvalidDownFile(dir, path, f)
      } else {
        // nolead：回执 nolead（中枢不结算，行保持 pending），文件留下轮重试
        r.nolead++
        try { writeAckFile(root, ev, base, 'nolead') } catch { /* ignore */ }
      }
    } catch (e) {
      r.failed++
      console.warn(`[LanSync] 下行事件应用失败 file=${f}:`, e)
    }
  }
  if (r.applied > 0) crmDbService.setScanState(K_LAST_DOWN_APPLY, Date.now())
  return r
}

// ─── 主管通知消费（中枢本机通道）：down/<中枢投递键>/ → notify_inbox ────────────
export interface NotifyConsumeResult { applied: number; skippedDup: number; failed: number }

/**
 * 中枢消费主管通知（sla1_escalate_supervisor 的落地点）：中枢 = 主管/分配员工作机，
 * 通知事件由 emitDownEvents 路由到中枢自己的下行队列，本函数在本轮同步内落地：
 * notify_inbox 一行（idempotency_key 唯一幂等）+ audit_event + outbox 行标 sent → 删事件文件。
 * 主管端 UI（资源分配页「回收改派」页签「升级提醒」）读 notify_inbox 展示与已读。
 */
export function consumeSupervisorNotifications(root: string): NotifyConsumeResult {
  const r: NotifyConsumeResult = { applied: 0, skippedDup: 0, failed: 0 }
  const own = deliveryKey(getTerminalId())
  const dir = downQueueDir(root, own)
  for (const f of listEventFiles(dir)) {
    const path = join(dir, f)
    const ev = readEventFile(path)
    if (!ev) {
      try { renameSync(path, `${path}.bad`) } catch { /* ignore */ }
      r.failed++
      continue
    }
    if (ev.type !== 'sla1_escalate_supervisor') continue // 只处理通知，业务事件留给终端角色
    const valid = validateSupervisorNotificationFile(ev, own, f)
    if (!valid) {
      console.warn(`[LanSync] 主管通知本体或 outbox 绑定校验失败（已隔离 .failed，零业务写）file=${f}`)
      isolateInvalidDownFile(dir, path, f)
      r.failed++
      continue
    }
    try {
      const p = ev.payload || {}
      const leadInfo = (p.lead && typeof p.lead === 'object' ? p.lead : null) as Record<string, unknown> | null
      const inserted = crmDbService.runTx((tx) => {
        const created = recordSupervisorNotificationTx(tx, {
          idempotencyKey: ev.idempotencyKey,
          leadId: Number(p.leadId || 0),
          salesName: String(p.salesName || ''),
          remindCount: Number(p.remindCount || 3),
          reason: String(p.reason || 'SLA三次超时回收'),
          recycledAt: Number(p.recycledAt || ev.emittedAt),
          lead: leadInfo ? { contactType: String(leadInfo.contactType || ''), contactNormalized: String(leadInfo.contactNormalized || '') } : undefined
        }, 'sync:down')
        tx.run("UPDATE outbox_event SET status = 'sent', updated_at = ? WHERE idempotency_key = ? AND status = 'pending'", [Date.now(), ev.idempotencyKey])
        return created
      })
      if (inserted) r.applied++
      else r.skippedDup++
      try { rmSync(path, { force: true }) } catch { /* ignore */ }
    } catch (e) {
      r.failed++
      console.warn(`[LanSync] 主管通知落地失败 file=${f}:`, e)
    }
  }
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
      if (writeEventFile(file, ev)) r.emitted++
      crmDbService.runTx((tx) => {
        tx.run("UPDATE outbox_event SET status = 'sent', updated_at = ? WHERE id = ? AND status = 'pending'", [Date.now(), Number(row.id)])
      })
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
      if (writeEventFile(join(upDir, `audit-${String(Number(a.id)).padStart(8, '0')}.json`), ev)) r.emitted++
      crmDbService.setScanState(K_AUDIT_CURSOR, Number(a.id))
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
  ev: SyncEventFile,
  touched?: { leadIds: number[] }
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
      // claimedAt：优先新事件 payload.claimedAt（与终端本地 assignment.claimed_at 同一 now），
      // 兼容旧事件回退 ev.emittedAt，再无有效值才用中枢消费时的 now；只做有限正数校验
      const claimedAt = [Number(p.claimedAt), Number(ev.emittedAt)].find((v) => Number.isFinite(v) && v > 0) ?? now
      tx.run("UPDATE assignment SET status = 'claimed', claimed_at = ?, updated_by = ?, updated_at = ?, version = version + 1 WHERE id = ? AND status = 'assigned'", [claimedAt, actor, now, Number(cur.id)])
      tx.run('INSERT INTO audit_event (actor, action, entity_type, entity_id, detail, created_at) VALUES (?,?,?,?,?,?)',
        [actor, 'lead_claim', 'lead', leadId, JSON.stringify({ assignmentId: Number(cur.id), salesName: String(cur.sales_name), claimedAt, via: 'sync:up', terminal: String(ev.from || '') }), now])
      touched?.leadIds.push(leadId)
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
  const r: ConsumeResult = { applied: 0, skippedDup: 0, conflict: 0, nolead: 0, invalid: 0, failed: 0 }
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
        const touched = { leadIds: [] as number[] }
        const handled = crmDbService.runTx((tx) => {
          const okApply = applyUpEventTx(tx, ev, touched)
          if (okApply) {
            tx.run('INSERT INTO scan_state (key, last_scan) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET last_scan = excluded.last_scan', [appliedKey(ev.idempotencyKey), Date.now()])
          }
          return okApply
        })
        if (handled) {
          r.applied++
          // 事务已提交才通知：中枢收到终端认领回执并真正改写归属状态（assigned → claimed）时发
          if (touched.leadIds.length) emitAssignmentInvalidated('claim', touched.leadIds)
          try { rmSync(path, { force: true }) } catch { /* ignore */ }
        }
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
export interface LanSyncRound { role: LanSyncRole | ''; down?: EmitResult; up?: ConsumeResult; consumeDown?: ConsumeResult; emitUp?: EmitResult; settle?: SettleResult; acks?: AckConsumeResult; notify?: NotifyConsumeResult }

/** 按角色跑一轮同步；未配置（目录空/角色未选）→ 静默返回（同步关闭） */
export function runLanSyncOnce(): LanSyncRound {
  const cfg = getLanSyncConfig()
  if (!cfg.enabled) return { role: cfg.role }
  if (cfg.role === 'hub') {
    const acks = processUpAcks(cfg.root)
    const settle = settleDownDeliveries(cfg.root)
    const down = emitDownEvents(cfg.root)
    const up = consumeUpEvents(cfg.root)
    const notify = consumeSupervisorNotifications(cfg.root)
    return { role: 'hub', acks, settle, down, up, notify }
  }
  return { role: 'terminal', consumeDown: consumeDownEvents(cfg.root), emitUp: emitUpEvents(cfg.root) }
}

// ─── 状态（设置页「内网同步」区块）────────────────────────────────────────────
export interface LanSyncStatus {
  enabled: boolean
  role: LanSyncRole | ''
  terminalId: string
  sharedDir: string
  /** 以下四个最近时间均为毫秒（Date.now() 写入），0 = 未发生；注意与 WCDB 的秒级口径区分 */
  lastDownEmitAt: number
  lastDownApplyAt: number
  lastUpEmitAt: number
  lastUpApplyAt: number
  /** 待产出积压（pending outbox 中本角色该发的方向 + 终端 audit 游标积压） */
  backlogPending: number
  /** 待消费积压（共享目录里本角色该消费方向未完成的事件文件数） */
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
    // 终端只关心自己的下行队列
    st.backlogIncoming = listEventFiles(downQueueDir(cfg.root, deliveryKey(st.terminalId))).length
  } else {
    // 中枢：全部接收者队列的未完成事件 + 各终端待消费的 ACK
    const downRoot = join(cfg.root, 'down')
    if (existsSync(downRoot)) {
      try {
        for (const d of readdirSync(downRoot)) {
          if (d.startsWith('.')) continue
          try {
            if (!statSync(join(downRoot, d)).isDirectory()) continue
          } catch { continue }
          st.backlogIncoming += listEventFiles(join(downRoot, d)).length
        }
      } catch { /* ignore */ }
    }
    const upRoot = join(cfg.root, 'up')
    if (existsSync(upRoot)) {
      try {
        for (const d of readdirSync(upRoot)) {
          if (d === st.terminalId) continue
          st.backlogIncoming += listEventFiles(join(upRoot, d)).length
          st.backlogIncoming += listEventFiles(join(upRoot, d, 'ack')).length
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
      const settled = r.settle?.completed || 0
      if (out + inUp + inDown + outUp + settled > 0) {
        console.log(`[LanSync] 一轮同步（role=${r.role}）：下行产出 ${out}，投递完成 ${settled}，上行消费 ${inUp}，下行消费 ${inDown}，上行产出 ${outUp}`)
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
