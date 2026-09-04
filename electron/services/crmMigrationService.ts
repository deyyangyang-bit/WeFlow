/**
 * crmMigrationService.ts —— Phase 1 存量数据迁移执行器（PRD §9 / 宪法 §1.1/§1.2/§2.4）
 *
 * 模块② account → customer 回填 + customer_id 挂接；模块③ lead → customer_identity 归并。
 * （模块① 决策B 群扫清理已于 Phase 0 以别的形式 live 执行完，不在此；模块④ 历史成交
 *   真实库 0 合同 0 报价，只核验不建执行器——见 scripts/migration/04。）
 *
 * ⛔ 铁律：
 *   1. 迁移只走应用自身链路（本服务 → crmDbService.runTx 事务），由 main.ts 启动链路调用；
 *      禁止外部脚本直改库文件（sql.js 内存库 + 500ms 防抖落盘会覆盖，HANDOVER §2.40 前科）。
 *   2. 幂等双保险：scan_state 一次性标记（migration:02/03 键，同事务写入）+ 数据级判重
 *      （account.customer_id 已挂 / (identity_type, identity_value) 已存在即跳过），
 *      标记丢失重跑也零副作用（宪法 §2.2 迁移铁律：无版本表，全靠幂等）。
 *   3. 冲突不静默：无锚 account、多名/多归属归并组、跨客户身份冲突 → 进迁移报告冲突/失败
 *      清单，不动数据；合并处置走人工审批（宪法 §2.4，AI 永不执行合并）。
 *   4. 每模块单事务提交 + audit_event 留痕（actor='system:migration'，detail=报告摘要 JSON，
 *      与 crmAssignmentService 的 system:migration 先例一致）。
 *
 * ⚠️ 有意不做：owner_sales 为空的 account 不回写「归销售本人」——归属变更是 C 档人工动作
 *    （宪法 §1.7），且单机库 188 个 anchored account 的 owner 全空属历史现状，迁移不静默改写；
 *    只在报告 notes 计数，归属补登走分配/认领流程或人工。
 *    salesDb 侧 customer_profile.customer_id 对齐 = 独立后续步骤（先 crmDb 后 salesDb 铁律），
 *    本服务只覆盖 crmDb。
 */

import { crmDbService, type CrmRow } from './crmDbService'
import { isSessionIdLike } from '../../shared/wechatId'

// ─── 身份锚点归一化（宪法 §2.4；dry-run 骨架 scripts/migration/02·03 也从这里导入，口径唯一真源）───
/** 手机号归一化：去非数字字符；11 位才算可用手机号锚点 */
export function normalizePhone(raw: unknown): string {
  return String(raw ?? '').replace(/\D/g, '')
}
/** wxid 归一化：仅去首尾空白——不转小写，wxid 大小写敏感 */
export function normalizeWxid(raw: unknown): string {
  return String(raw ?? '').trim()
}
/** 单个 account 的身份锚点（手机号优先，wxid 兜底；两者皆无 = null） */
export function accountAnchor(acc: { phone?: unknown; session_id?: unknown }): { type: 'phone' | 'wxid'; value: string } | null {
  const phone = normalizePhone(acc.phone)
  if (phone.length === 11) return { type: 'phone', value: phone }
  const sid = normalizeWxid(acc.session_id)
  if (sid && isSessionIdLike(sid)) return { type: 'wxid', value: sid }
  return null
}

// ─── 报告结构（与 scripts/migration/types.ts 口径对齐：总数/实绩/幂等跳过/失败/冲突）───
export interface MigrationIssue { key: string; reason: string; detail?: string }

export interface ModuleMigrationResult {
  module: string
  /** true = scan_state 标记命中，本次整体跳过（重跑零副作用） */
  skippedByMarker: boolean
  /** 扫描候选总数 */
  total: number
  /** 本次实际写入主条数（02=挂接 account 数；03=新插 identity 数） */
  applied: number
  /** 02：新建 customer 数；03：恒 0 */
  customersCreated: number
  /** 幂等跳过（数据级判重命中） */
  alreadyDone: number
  failed: number
  conflicts: number
  failures: MigrationIssue[]
  conflictList: MigrationIssue[]
}

const ACTOR = 'system:migration'
const M02_MARKER = 'migration:02-account-to-customer'
const M03_MARKER = 'migration:03-lead-to-identity'
/** audit detail 里失败/冲突清单上限（防极端脏库 detail 膨胀；超出截断并标记） */
const AUDIT_LIST_CAP = 200

function emptyResult(module: string, skippedByMarker: boolean): ModuleMigrationResult {
  return {
    module, skippedByMarker, total: 0, applied: 0, customersCreated: 0,
    alreadyDone: 0, failed: 0, conflicts: 0, failures: [], conflictList: []
  }
}

function auditDetail(r: ModuleMigrationResult, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    module: r.module,
    summary: {
      total: r.total, applied: r.applied, customersCreated: r.customersCreated,
      alreadyDone: r.alreadyDone, failed: r.failed, conflicts: r.conflicts
    },
    failures: r.failures.slice(0, AUDIT_LIST_CAP),
    conflicts: r.conflictList.slice(0, AUDIT_LIST_CAP),
    truncated: r.failures.length > AUDIT_LIST_CAP || r.conflictList.length > AUDIT_LIST_CAP,
    ...extra
  })
}

// ─── 模块②：account → customer 回填 + customer_id 挂接 ─────────────────────
/**
 * 每个有效锚点组（手机号优先 / wxid 兜底，宪法 §2.4）建 1 个 customer + 1 行 customer_identity，
 * 组内 account 挂接 customer_id。多名/多归属组与「锚点已被其他 customer 占用」只进冲突清单不动数据。
 */
export function migrate02AccountToCustomer(): ModuleMigrationResult {
  const r = emptyResult('02-account-to-customer', false)
  if (crmDbService.getScanState(M02_MARKER) > 0) {
    r.skippedByMarker = true
    return r
  }
  const now = Date.now()

  return crmDbService.runTx((tx) => {
    const accounts = tx.all(
      'SELECT id, name, phone, session_id, owner_sales, customer_id, updated_at FROM account ORDER BY id')
    r.total = accounts.length

    // 既有 identity 占用索引（重复执行/脏数据场景 → 冲突，不自动处置）
    const identityOwners = new Map<string, number>()
    for (const row of tx.all('SELECT identity_type, identity_value, customer_id FROM customer_identity')) {
      identityOwners.set(`${String(row.identity_type)}:${String(row.identity_value)}`, Number(row.customer_id || 0))
    }

    interface Member { id: number; name: string; owner: string; updatedAt: number }
    const groups = new Map<string, { type: 'phone' | 'wxid'; value: string; members: Member[] }>()
    for (const a of accounts) {
      const aid = Number(a.id)
      if (a.customer_id != null && Number(a.customer_id) > 0) { r.alreadyDone++; continue }
      const anchor = accountAnchor(a)
      if (!anchor) {
        r.failures.push({
          key: `account:${aid}`,
          reason: '无可用身份锚点（手机号非 11 位且无 session_id）——无法参与查重归并，留人工处理',
          detail: `name='${String(a.name)}' phone='${String(a.phone ?? '').trim()}'`
        })
        continue
      }
      const gk = `${anchor.type}:${anchor.value}`
      if (!groups.has(gk)) groups.set(gk, { type: anchor.type, value: anchor.value, members: [] })
      groups.get(gk)!.members.push({
        id: aid, name: String(a.name || ''), owner: String(a.owner_sales || ''),
        updatedAt: Number(a.updated_at || 0)
      })
    }

    let identitiesCreated = 0
    let identitiesLinked = 0 // 既有 NULL identity 后补挂接（§2.4 后补关联合法路径）
    for (const [gk, g] of groups) {
      const names = [...new Set(g.members.map((m) => m.name).filter(Boolean))]
      const owners = [...new Set(g.members.map((m) => m.owner).filter(Boolean))]
      if (names.length > 1) {
        r.conflictList.push({
          key: gk,
          reason: `归并组内 account 名字不一致（${names.length} 个），主名需人工确认`,
          detail: `names=${JSON.stringify(names)} accountIds=${g.members.map((m) => m.id).join(',')}`
        })
        continue
      }
      if (owners.length > 1) {
        r.conflictList.push({
          key: gk,
          reason: `归并组内 owner_sales 不一致（${owners.length} 人），归并后归属需人工裁决`,
          detail: `owners=${JSON.stringify(owners)} accountIds=${g.members.map((m) => m.id).join(',')}`
        })
        continue
      }

      // 目标 customer：锚点已有 identity 且已挂 customer → 复用（幂等重入路径）；否则新建
      const takenBy = identityOwners.get(gk)
      let customerId: number
      if (takenBy != null && takenBy > 0) {
        customerId = takenBy
      } else {
        // 主名取组内 updated_at 最新者（组内名字一致或仅一个非空，无歧义）
        const main = g.members.slice().sort((a, b) => b.updatedAt - a.updatedAt)[0]
        customerId = tx.run(
          'INSERT INTO customer (name, type, brand, vehicle_age, modified, source, updated_by, updated_at, version, deleted) VALUES (?,?,?,?,?,?,?,?,?,?)',
          [main?.name || '', '', '', null, 0, 'migration', ACTOR, now, 1, 0]
        )
        r.customersCreated++
      }

      // identity 登记：锚点未登记 → 新插；已登记但 customer_id=NULL → 后补挂接（§2.4 合法态消解）
      if (takenBy == null) {
        tx.run(
          'INSERT INTO customer_identity (identity_type, identity_value, customer_id, source, confidence, updated_by, updated_at, version, deleted) VALUES (?,?,?,?,?,?,?,?,?)',
          [g.type, g.value, customerId, 'auto', 1.0, ACTOR, now, 1, 0]
        )
        identitiesCreated++
      } else if (takenBy === 0) {
        tx.run('UPDATE customer_identity SET customer_id = ?, updated_by = ?, updated_at = ?, version = version + 1 WHERE identity_type = ? AND identity_value = ? AND customer_id IS NULL',
          [customerId, ACTOR, now, g.type, g.value])
        identitiesLinked++
      }

      // 组内 account 挂接（同事务；已挂接的行靠 WHERE customer_id IS NULL 兜底）
      for (const m of g.members) {
        tx.run('UPDATE account SET customer_id = ?, updated_at = ? WHERE id = ? AND customer_id IS NULL',
          [customerId, now, m.id])
        r.applied++
      }
    }

    r.failed = r.failures.length
    r.conflicts = r.conflictList.length
    tx.run('INSERT INTO audit_event (actor, action, entity_type, entity_id, detail, created_at) VALUES (?,?,?,?,?,?)',
      [ACTOR, 'migration_02_account_to_customer', 'migration', null,
        auditDetail(r, { identitiesCreated, identitiesLinked }), now])
    // 一次性标记与数据同事务提交（双保险第一层；第二层 = 上面的数据级判重）
    tx.run('INSERT INTO scan_state (key, last_scan) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET last_scan = excluded.last_scan',
      [M02_MARKER, now])
    return r
  })
}

// ─── 模块③：lead → customer_identity 归并 ─────────────────────────────────
/**
 * 每条 lead 解析身份（phone←contact_normalized 归一化须 11 位；wxid←wechat 列 trim），
 * 按 (identity_type, identity_value) 唯一约束归并登记；值命中 account 锚点（模块②产物）
 * → 挂该 customer，未命中 → customer_id=NULL（资源池合法态，§2.4 后补关联）。
 * 跨客户身份冲突 → 登记 NULL + 冲突清单，归属裁决留人工（不自动处置）。
 */
export function migrate03LeadToIdentity(): ModuleMigrationResult {
  const r = emptyResult('03-lead-to-identity', false)
  if (crmDbService.getScanState(M03_MARKER) > 0) {
    r.skippedByMarker = true
    return r
  }
  const now = Date.now()

  return crmDbService.runTx((tx) => {
    const leads = tx.all(
      'SELECT id, contact_type, contact_normalized, wechat, source, status, account_id FROM lead ORDER BY id')
    r.total = leads.length

    // account 锚点 → customer_id 集合（模块②产物；customer_id 空的无锚 account 不参与命中）
    const anchorCustomers = new Map<string, Set<number>>()
    const accountCustomer = new Map<number, number>() // account_id → customer_id（跨客户冲突检测）
    for (const a of tx.all('SELECT id, phone, session_id, customer_id FROM account')) {
      const cid = Number(a.customer_id || 0)
      if (cid > 0) accountCustomer.set(Number(a.id), cid)
      const anchor = accountAnchor(a)
      if (!anchor || cid <= 0) continue
      const gk = `${anchor.type}:${anchor.value}`
      if (!anchorCustomers.has(gk)) anchorCustomers.set(gk, new Set())
      anchorCustomers.get(gk)!.add(cid)
    }

    const existing = new Map<string, number>()
    for (const row of tx.all('SELECT identity_type, identity_value, customer_id FROM customer_identity')) {
      existing.set(`${String(row.identity_type)}:${String(row.identity_value)}`, Number(row.customer_id || 0))
    }

    interface Member { id: number; account: number | null }
    const groups = new Map<string, { type: 'phone' | 'wxid'; value: string; members: Member[] }>()
    for (const l of leads) {
      const lid = Number(l.id)
      const type = String(l.contact_type || 'phone') === 'wechat' ? 'wxid' : 'phone'
      const raw = type === 'phone' ? String(l.contact_normalized ?? '') : String(l.wechat ?? '')
      const value = type === 'phone' ? normalizePhone(raw) : normalizeWxid(raw)
      if (!value) {
        r.failures.push({
          key: `lead:${lid}`,
          reason: `无可用身份（contact_type='${type}' 但值为空）——不产生 identity 行，留人工处理`,
          detail: `source='${String(l.source)}' status='${String(l.status)}'`
        })
        continue
      }
      if (type === 'phone' && value.length !== 11) {
        r.failures.push({
          key: `lead:${lid}`,
          reason: `手机号归一化后非 11 位（'${value}'），不满足 phone 身份格式`,
          detail: '宪法 §2.4 归一化仅去非数字；格式非法者不迁，留人工处理窗口'
        })
        continue
      }
      const gk = `${type}:${value}`
      if (!groups.has(gk)) groups.set(gk, { type: type as 'phone' | 'wxid', value, members: [] })
      groups.get(gk)!.members.push({
        id: lid, account: l.account_id != null ? Number(l.account_id) : null
      })
    }

    let linkedToCustomer = 0 // 挂 customer 的新 identity 数
    let pooled = 0           // customer_id=NULL（资源池合法态）
    for (const [gk, g] of groups) {
      if (existing.has(gk)) { r.alreadyDone++; continue }
      const hits = anchorCustomers.get(gk)
      // 跨客户冲突：①锚点命中多个 customer；②线索已转客户（lead.account_id）但锚点指向另一 customer
      const conflictMembers = g.members.filter((m) => {
        if (m.account == null || !hits || hits.size !== 1) return false
        const own = accountCustomer.get(m.account)
        return own != null && !hits.has(own)
      })
      if ((hits && hits.size > 1) || conflictMembers.length > 0) {
        r.conflictList.push({
          key: gk,
          reason: hits && hits.size > 1
            ? `身份值命中 ${hits.size} 个不同 customer——跨客户身份冲突`
            : `线索已转客户但身份值命中另一 customer（leads=${conflictMembers.map((m) => m.id).join(',')}）`,
          detail: '宪法 §2.4：归属裁决走合并提案 → 人工审批；本行登记 customer_id=NULL 不自动处置'
        })
      }
      const customerId = hits && hits.size === 1 && conflictMembers.length === 0
        ? [...hits][0] : null
      tx.run(
        'INSERT INTO customer_identity (identity_type, identity_value, customer_id, source, confidence, updated_by, updated_at, version, deleted) VALUES (?,?,?,?,?,?,?,?,?)',
        [g.type, g.value, customerId, 'auto', 1.0, ACTOR, now, 1, 0]
      )
      r.applied++
      if (customerId != null) linkedToCustomer++; else pooled++
    }

    r.failed = r.failures.length
    r.conflicts = r.conflictList.length
    tx.run('INSERT INTO audit_event (actor, action, entity_type, entity_id, detail, created_at) VALUES (?,?,?,?,?,?)',
      [ACTOR, 'migration_03_lead_to_identity', 'migration', null,
        auditDetail(r, { linkedToCustomer, pooled }), now])
    tx.run('INSERT INTO scan_state (key, last_scan) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET last_scan = excluded.last_scan',
      [M03_MARKER, now])
    return r
  })
}

// ─── 启动入口（main.ts 启动链路调用一次；顺序即依赖顺序：②先于③）────────────
export function runStockDataMigration(): { m02: ModuleMigrationResult; m03: ModuleMigrationResult } {
  const m02 = migrate02AccountToCustomer()
  const m03 = migrate03LeadToIdentity()
  for (const r of [m02, m03]) {
    if (r.skippedByMarker) continue
    console.log(`[CRM] 存量迁移 ${r.module}：applied=${r.applied} customers=${r.customersCreated} ` +
      `alreadyDone=${r.alreadyDone} failed=${r.failed} conflicts=${r.conflicts}` +
      (r.failed || r.conflicts ? '（失败/冲突清单见 audit_event detail）' : ''))
  }
  return { m02, m03 }
}
