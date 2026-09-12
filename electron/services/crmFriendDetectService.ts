/**
 * crmFriendDetectService.ts —— 加好友判定双路（PRD 1.4a，宪法 §1.2/§2.4）
 *
 * ① 手动路：销售在线索行「绑定微信」（搜本机联系人 → 选 → 确认）→ bindLeadWxid(source='manual')；
 *    认领弹窗可选填的微信号也走同一链路。
 * ② 自动路（保守版，2026-09-08 多分库覆盖）：startFriendDetectScheduler 定时扫 assigned/claimed
 *    且未停表的分配行，拿 lead 的 wxid/手机号与本机**全部已配置微信账号分库**的联系人逐库
 *    **精确等值**匹配（username/alias；remark/nickName 仅展示用，宪法 §2.4：昵称永不作匹配依据，
 *    绝不因昵称模糊匹配自动判定已加好友），任一账号命中即视同绑定（source='auto'，宁缺毋滥）。
 *    命中的微信账号标识随审计留痕（过既有脱敏规范 maskContact）；单个账号库不可用只跳过该账号。
 *
 * 命中/绑定的四件套（单事务）：
 *   1. customer_identity 登记（identity_type='wxid'，source=manual/auto，confidence=1.0；
 *      customer_id 按 §2.4 Identity Resolution 能挂则挂，挂不上 NULL 合法；已挂他人 → E204 不改挂）；
 *   2. assignment 停 SLA1 表：sla1_met_at = 停表时刻（停表方案见 HANDOVER §2.56：加列而非复用 status，
 *      status 语义 = 分配生命周期不承载「加了没有」结果；回收器只扫 sla1_met_at IS NULL）；
 *   3. lead.status 推进 WX_ADDED（仅 NEW/CONTACTED，DEAD/ACCOUNT 不动）+ lead.wechat 空则回填；
 *   4. audit_event action='identity_bind' 全程留痕（手动 actor=getActorLabel()，自动 actor='system:friend-detect'）。
 *
 * 幂等：同一 (lead, wxid) 重复绑定 → 四件套均已落则 alreadyBound=true 直接返回，零重复写（无新审计行）；
 * 多分库重复联系人 → 标识表先到先得，跨账号重复命中归一为同一次绑定，零重复写。
 * ⚠️ 内部一律绑 contact.username（微信内部 id，改名不失效）；alias 命中的也归一到 username 入库。
 */
import { crmDbService, type CrmRow } from './crmDbService'
import { getActorLabel } from './identityService'
import { recordOutboxTx } from './crmOutboxService'
import { ConfigService } from './config'
import { maskContact } from './crmLeadImportCore'
import { normalizePhone, normalizeWxid } from './crmMigrationService'

/** 本机联系人的最小匹配/展示字段（chatService.getContacts({lite:true}) 的映射子集） */
export interface ContactLite { username: string; alias?: string; remark?: string; nickname?: string }

export interface BindData {
  identityId: number
  customerId: number | null
  /** true = 重复绑定/重复命中，四件套此前已落，本次零写入（幂等短路） */
  alreadyBound: boolean
  /** 本次是否新停了 SLA1 表（false 可能是本就无有效分配行或已停过） */
  slaStopped: boolean
}
export interface BindResult { ok: boolean; data?: BindData; code?: string; message?: string }

/** lead 身份解析（宪法 §2.4，手机号 > wxid）：返回可挂接的唯一 customer，多个候选 = 冲突挂 NULL */
function resolveLeadCustomer(lead: CrmRow, wxid: string): { customerId: number | null; conflictNote: string } {
  const candidates = new Set<number>()
  // ① lead 已转客户：直接沿 account 挂接
  if (lead.account_id != null && Number(lead.account_id) > 0) {
    const acc = crmDbService.all('SELECT customer_id FROM account WHERE id = ?', [Number(lead.account_id)])[0]
    if (acc && Number(acc.customer_id || 0) > 0) candidates.add(Number(acc.customer_id))
  }
  // ② account 锚点：session_id = wxid 或 手机号锚（归一化后等值，与迁移模块②③同口径）
  const phone = normalizePhone(lead.contact_normalized)
  for (const a of crmDbService.all('SELECT id, phone, session_id, customer_id FROM account WHERE customer_id IS NOT NULL AND customer_id > 0')) {
    const cid = Number(a.customer_id)
    if (normalizeWxid(a.session_id) === wxid) candidates.add(cid)
    else if (phone.length === 11 && normalizePhone(a.phone) === phone) candidates.add(cid)
  }
  if (candidates.size === 1) return { customerId: [...candidates][0], conflictNote: '' }
  if (candidates.size > 1) {
    return { customerId: null, conflictNote: `身份锚点命中 ${candidates.size} 个不同 customer（${[...candidates].join(',')}），挂 NULL 留人工合并审批（宪法 §2.4）` }
  }
  return { customerId: null, conflictNote: '' }
}

/**
 * 绑定微信（双路共用核心；IPC `crm:identity:bind` 契约端点，API-CONTRACT §1.14）。
 * E101 wxid 空；E301 lead 不存在；E204 wxid 已挂其他 customer（冲突不自动改挂，留合并提案人工审批）。
 */
export function bindLeadWxid(
  leadId: number,
  wxid: string,
  opts: { actor?: string; source?: 'manual' | 'auto'; displayName?: string; matchField?: string; account?: string } = {}
): BindResult {
  const id = Number(leadId)
  const value = normalizeWxid(wxid)
  if (!Number.isInteger(id) || id <= 0 || !value) return { ok: false, code: 'E101', message: 'leadId 与 wxid 必填' }
  const source = opts.source === 'auto' ? 'auto' : 'manual'
  const by = String(opts.actor || '').trim() || (source === 'auto' ? 'system:friend-detect' : (getActorLabel() || '销售'))
  const lead = crmDbService.all('SELECT * FROM lead WHERE id = ?', [id])[0]
  if (!lead) return { ok: false, code: 'E301', message: '线索不存在' }

  const { customerId: resolved, conflictNote } = resolveLeadCustomer(lead, value)
  const existing = crmDbService.all(
    "SELECT * FROM customer_identity WHERE identity_type = 'wxid' AND identity_value = ?", [value]
  )[0]
  let customerId = resolved
  if (existing && Number(existing.customer_id || 0) > 0) {
    const held = Number(existing.customer_id)
    if (resolved != null && resolved !== held) {
      // 契约 E204：命中冲突 → 返回冲突信息（合并提案走 crm:customer:mergeProposal 人工审批），不自动改挂
      return { ok: false, code: 'E204', message: `该微信已挂客户 #${held}，与本线索解析到的客户 #${resolved} 冲突；请走合并提案人工审批` }
    }
    customerId = held
  }

  const now = Date.now()
  const identityId: number = existing ? Number(existing.id) : 0
  // 幂等短路判定：identity 已落（且无后补挂接要做）+ SLA1 已停（或无有效分配行）+ 状态已推进 → 零写入
  const needIdentityInsert = !existing
  const needIdentityLink = !!existing && Number(existing.customer_id || 0) === 0 && customerId != null
  const unstopped = crmDbService.all(
    "SELECT id FROM assignment WHERE lead_id = ? AND deleted = 0 AND status IN ('assigned','claimed') AND sla1_met_at IS NULL ORDER BY id DESC",
    [id]
  )
  const needStatusAdvance = String(lead.status) === 'NEW' || String(lead.status) === 'CONTACTED'
  const needWechatBackfill = !String(lead.wechat || '').trim()
  if (!needIdentityInsert && !needIdentityLink && !unstopped.length && !needStatusAdvance && !needWechatBackfill) {
    return { ok: true, data: { identityId, customerId: Number(existing.customer_id || 0) || null, alreadyBound: true, slaStopped: false } }
  }

  let finalIdentityId = identityId
  let slaStopped = false
  crmDbService.runTx((tx) => {
    // ① customer_identity 登记 / 后补关联（§2.4 后补关联合法路径：NULL → 挂 customer）
    if (needIdentityInsert) {
      finalIdentityId = tx.run(
        'INSERT INTO customer_identity (identity_type, identity_value, customer_id, source, confidence, updated_by, updated_at, version, deleted) VALUES (?,?,?,?,?,?,?,?,?)',
        ['wxid', value, customerId, source, 1.0, by, now, 1, 0]
      )
    } else if (needIdentityLink) {
      tx.run('UPDATE customer_identity SET customer_id = ?, updated_by = ?, updated_at = ?, version = version + 1 WHERE id = ? AND customer_id IS NULL',
        [customerId, by, now, identityId])
    }
    // ② 停 SLA1 表（PRD 1.4a「任一命中即停表」）：该 lead 当前有效分配行写停表时刻
    for (const r of unstopped) {
      tx.run('UPDATE assignment SET sla1_met_at = ?, updated_by = ?, updated_at = ?, version = version + 1 WHERE id = ? AND sla1_met_at IS NULL',
        [now, by, now, Number(r.id)])
      slaStopped = true
    }
    // ③ lead 状态推进（仅 NEW/CONTACTED → WX_ADDED；DEAD/ACCOUNT 不动）+ wechat 空则回填绑定的 wxid
    if (needStatusAdvance) {
      tx.run("UPDATE lead SET status = 'WX_ADDED', wechat = CASE WHEN wechat = '' OR wechat IS NULL THEN ? ELSE wechat END, updated_at = ? WHERE id = ?",
        [value, now, id])
      tx.run('INSERT INTO lead_activity (lead_id, action, note, created_at) VALUES (?,?,?,?)',
        [id, 'WX_ADDED', source === 'auto' ? `加好友自动检测命中：${String(opts.displayName || value)}` : `手动绑定微信：${String(opts.displayName || value)}`, now])
    } else if (needWechatBackfill) {
      tx.run('UPDATE lead SET wechat = ?, updated_at = ? WHERE id = ?', [value, now, id])
    }
    // ④ 审计留痕（宪法 §1.12；冲突注记 + 命中账号标识（脱敏）一并入 detail）
    tx.run('INSERT INTO audit_event (actor, action, entity_type, entity_id, detail, created_at) VALUES (?,?,?,?,?,?)',
      [by, 'identity_bind', 'lead', id, JSON.stringify({
        wxid: value, source, confidence: 1.0, identityId: finalIdentityId, customerId,
        assignmentIds: unstopped.map((r) => Number(r.id)), slaStopped,
        statusAdvanced: needStatusAdvance, displayName: String(opts.displayName || ''),
        matchField: String(opts.matchField || ''),
        // 命中的微信账号标识只留脱敏形态（既有 maskContact 规范：微信号 ab***c）
        ...(opts.account ? { friendAccount: maskContact({ contactType: 'wechat', contactNormalized: String(opts.account) }) } : {}),
        ...(conflictNote ? { conflictNote } : {})
      }), now])
    // outbox 登记（PRD §1.10 只记录不发送；上行 bind_wx 绑定回执，同步设计 §3）
    recordOutboxTx(tx, 'bind_wx', `bind_wx:${id}:${value}`, {
      leadId: id, wxid: value, identityId: finalIdentityId, customerId, source, slaStopped, actor: by
    }, now)
  })
  return { ok: true, data: { identityId: finalIdentityId, customerId, alreadyBound: false, slaStopped } }
}

// ─── 自动检测（保守版：只精确等值匹配，宁缺毋滥；多账号分库覆盖）────────────────
export interface FriendDetectScanResult { scanned: number; matched: number; bound: number; alreadyBound: number; conflicts: number }

/** 单账号联系人快照（生产 = 逐账号只读读取；contacts=null 表示该账号库不可用，扫描时跳过） */
export interface FriendDetectAccountSnapshot { account: string; contacts: ContactLite[] | null; error?: string }

/**
 * 扫一轮（2026-09-08 多账号版）：assigned/claimed 且未停表的分配行 → lead 的 wxid/手机号 ×
 * 各账号分库联系人标识（username/alias）精确等值匹配，任一账号命中即绑定。
 *   - 多分库合并：同标识在多个账号重复出现 → 先到先得归一为一条（跨账号重复命中幂等）；
 *   - contacts=null（单库不可用）只跳过该账号，不中止其他账号；全部不可用 → 本轮零副作用；
 * 命中即走 bindLeadWxid(source='auto') 四件套（审计记脱敏后的命中账号）；逐条独立事务。
 * ⚠️ remark/nickName 永不参与匹配（宪法 §2.4 昵称仅显示用）；联系人无可靠手机号字段，
 *    手机号命中仅发生在 username/alias 恰为同一个 11 位号码时（仍是精确等值）。
 */
export function runFriendDetectScan(accounts: FriendDetectAccountSnapshot[]): FriendDetectScanResult {
  const r: FriendDetectScanResult = { scanned: 0, matched: 0, bound: 0, alreadyBound: 0, conflicts: 0 }
  // 标识 → 联系人（username 与 alias 都是标识级字段；同名标识指不同联系人是脏数据，先到先得不动；
  // 多账号重复联系人 → 标识先到先得，归一为同一次绑定）
  const byIdent = new Map<string, { contact: ContactLite; field: 'username' | 'alias'; account: string }>()
  for (const snap of Array.isArray(accounts) ? accounts : []) {
    if (!snap || !Array.isArray(snap.contacts) || !snap.contacts.length) continue // 单库不可用/空 → 跳过
    for (const c of snap.contacts) {
      const username = normalizeWxid(c?.username)
      if (!username || username.endsWith('@chatroom') || username.startsWith('gh_')) continue
      if (!byIdent.has(username)) byIdent.set(username, { contact: c, field: 'username', account: String(snap.account || '') })
      const alias = normalizeWxid(c?.alias)
      if (alias && !byIdent.has(alias)) byIdent.set(alias, { contact: c, field: 'alias', account: String(snap.account || '') })
    }
  }
  if (!byIdent.size) return r

  const rows = crmDbService.all(
    `SELECT a.id AS assignment_id, a.lead_id FROM assignment a
     WHERE a.deleted = 0 AND a.status IN ('assigned','claimed') AND a.sla1_met_at IS NULL ORDER BY a.id`
  )
  // 同 lead 多条有效行属脏数据，只处理最新一条（与 currentAssignment 口径一致）
  const seen = new Set<number>()
  const targets: number[] = []
  for (const row of rows.reverse()) {
    const lid = Number(row.lead_id)
    if (seen.has(lid)) continue
    seen.add(lid)
    targets.push(lid)
  }
  for (const lid of targets) {
    r.scanned++
    const lead = crmDbService.all('SELECT id, contact_normalized, wechat FROM lead WHERE id = ?', [lid])[0]
    if (!lead) continue
    const wx = normalizeWxid(lead.wechat)
    const phone = normalizePhone(lead.contact_normalized)
    const hit = (wx && byIdent.get(wx)) || (phone.length === 11 ? byIdent.get(phone) : undefined)
    if (!hit) continue
    r.matched++
    const displayName = String(hit.contact.remark || hit.contact.nickname || hit.contact.alias || hit.contact.username)
    const res = bindLeadWxid(lid, hit.contact.username, {
      actor: 'system:friend-detect', source: 'auto', displayName, matchField: hit.field, account: hit.account
    })
    if (res.ok) {
      if (res.data?.alreadyBound) r.alreadyBound++
      else r.bound++
    } else {
      if (res.code === 'E204') r.conflicts++
      console.warn(`[CRM] 加好友自动检测绑定失败 lead=${lid}：${res.code} ${res.message}`)
    }
  }
  return r
}

/** 自动检测扫描间隔（分钟）：配置 crmFriendDetectIntervalMin，5-1440，默认 30（与 SLA 回收器同款） */
function detectIntervalMin(): number {
  const n = Number(ConfigService.getInstance().get('crmFriendDetectIntervalMin') ?? 30)
  return Number.isFinite(n) && n >= 5 && n <= 1440 ? n : 30
}

let friendDetectBoot: ReturnType<typeof setTimeout> | null = null
let friendDetectTimer: ReturnType<typeof setInterval> | null = null

/**
 * 启动加好友自动检测调度器（main.ts 启动链路调用，挂在 SLA1 回收器旁）。
 * fetchAccounts 由调用方注入（生产 = 枚举本机全部已配置微信账号，逐账号只读读联系人；
 * 单账号库不可用 → 该快照 contacts=null 跳过；全部不可用 → 本轮零匹配零副作用）。
 * 幂等：重复调用直接返回。启动延迟 90s 首扫（让迁移/补写/回收器先收尾），之后按间隔轮巡。
 */
export function startFriendDetectScheduler(fetchAccounts: () => Promise<FriendDetectAccountSnapshot[]>): void {
  if (friendDetectTimer) return
  const tick = async (): Promise<void> => {
    try {
      const accounts = await fetchAccounts()
      const usable = Array.isArray(accounts) ? accounts.filter((a) => a && Array.isArray(a.contacts) && a.contacts.length) : []
      if (!usable.length) return
      const r = runFriendDetectScan(accounts)
      if (r.bound > 0 || r.conflicts > 0) {
        console.log(`[CRM] 加好友自动检测：扫 ${r.scanned} 行，命中 ${r.matched}，新绑定 ${r.bound}（冲突 ${r.conflicts}，actor=system:friend-detect）`)
      }
    } catch (e) {
      console.warn('[CRM] 加好友自动检测扫描失败:', e)
    }
  }
  friendDetectBoot = setTimeout(() => { void tick() }, 90 * 1000)
  if (friendDetectBoot.unref) friendDetectBoot.unref()
  friendDetectTimer = setInterval(() => { void tick() }, detectIntervalMin() * 60 * 1000)
  if (friendDetectTimer.unref) friendDetectTimer.unref()
}
