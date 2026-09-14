/**
 * Phase 3a 上行投影：把**本机既有结构化业务事实**映射为 CentralSyncEvent。
 *
 * 纪律（PRD §7.1 / docs/DATA-CONSTITUTION.md）：
 *  - 只读既有业务表与既有 append-only 流水，**禁止扫描聊天表**产生上行事件；
 *  - 一个实体类型 → 一组**显式最小字段**，字段名与中央 projections.ts 注册表一一对应；
 *    中央对 payload 做严格白名单，未登记字段会被整条拒收，这里绝不夹带额外内容；
 *  - 聊天正文、消息正文、session_id、WCDB 路径与原始聊天数据**永不出现在 payload 中**；
 *  - 身份值（手机号 / wxid / contactNormalized / contactRaw）**原文不出本机**：
 *    一律先过既有归一规则（crmMigrationService.normalizePhone / normalizeWxid）再哈希，
 *    展示掩码复用既有 maskContact，不另写一套归一或脱敏口径；
 *  - 不新建第二套 seq / idempotency / ACK 语义：游标复用 scan_state，幂等键沿用 outbox 口径。
 *
 * 跨机引用（§六 收口）：entityId 与 payload 内所有指向本机投影的引用一律 `scopedRef(deviceId, localRef)`
 * （`<deviceId>/<localRef>`）。本地自增 id 在两台机器上必然重号，裸 `customer:1` 会让 A 机的客户 1
 * 与 B 机的客户 1 在中央互相覆盖，也让中央无法把 customer_identity / judgment / ownership 关联回客户。
 *
 * 增量水位（§四 收口）：
 *  - append-only 表（audit / judgment / quote 版本行）按自增 id 游标，行不会变；
 *  - 可变表按 **(updated_at, id) 复合水位**——只按 id 游标会漏掉「已同步行的后续更新」
 *    （客户改名、assignment 状态流转、商机阶段与金额变化），等于永远只上行首版。
 *  - 同一实体的新版本 → 幂等键带版本（`…#v<rev>`），entityId 稳定，aggregateVersion 严格递增。
 *
 * 跳过的行（§五 收口）：业务上暂不可投影的行（无名称客户 / 孤立身份 / 未归并 account）**不阻塞**
 * 后续合法行——跳过照常推进水位，同时把 localRef 记进 scan_state 的待重试台账，后续补齐后重新进入扫描。
 */
import { createHash } from 'crypto'
import { scopedRef, isForbiddenChatFieldName, isForbiddenIdentityFieldName, type CentralEntityType } from '../../shared/centralSync'
import { maskContact } from '../../shared/auditDict'
import { crmDbService, type CrmRow } from './crmDbService'
import { salesDbService } from './salesDbService'
import { normalizePhone, normalizeWxid } from './crmMigrationService'

/** 单条待上行投影（尚未封成传输信封） */
export interface ProjectionDraft {
  entityType: CentralEntityType
  /** 本地稳定引用（不含设备前缀），最终 entityId = `${deviceId}/${localRef}` */
  localRef: string
  eventType: string
  /** 中央版本闸门用的严格递增值（本机修订号，见 localRevision） */
  aggregateVersion: number
  eventSeq: number
  payload: Record<string, unknown>
  occurredAt: number
}

/** 可变表水位：(updated_at, id) 复合；append-only 表只用 id（ts 恒为 0） */
export interface ProjectionWatermark { ts: number; id: number }

/** 业务上暂不可投影的行；调用方记入待重试台账，补齐后重新进入扫描 */
export interface ProjectionSkip { localRef: string; reason: string }

export interface ProjectionReadResult {
  drafts: ProjectionDraft[]
  /** 本页推进到的水位；网络/中央临时失败时调用方**不得**推进 */
  watermark: ProjectionWatermark
  /** 本次扫描的行数（含跳过） */
  scanned: number
  skipped: ProjectionSkip[]
  /** 是否读满一页（还有余量，下一拍继续） */
  full: boolean
}

export interface LocalProjection {
  /** 投影名（也用于 scan_state 游标键与状态展示） */
  key: string
  entityType: CentralEntityType
  /** id = append-only 表；versioned = 可变表（按 updated_at+id 复合水位） */
  mode: 'id' | 'versioned'
  read(watermark: ProjectionWatermark, limit: number, deviceId: string): ProjectionReadResult
  /** 重新评估此前跳过的行；仍不可投影返回 null（缺参数/未归并/结构不合法） */
  recheck(localRef: string, deviceId: string): ProjectionSkip | ProjectionDraft | null
}

const MAX_LIMIT = 200

function clampLimit(limit: number): number {
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit) || 1))
}

function num(value: unknown, fallback = 0): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function nullableNum(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) && n !== 0 ? n : null
}

function text(value: unknown): string {
  return value === null || value === undefined ? '' : String(value)
}

function nullableText(value: unknown): string | null {
  const s = text(value).trim()
  return s === '' ? null : s
}

function idOf(localRef: string, kind: string): number {
  const prefix = `${kind}:`
  if (!localRef.startsWith(prefix)) return 0
  const n = Number(localRef.slice(prefix.length))
  return Number.isInteger(n) && n > 0 ? n : 0
}

/**
 * 本机修订号（中央 aggregateVersion 的来源）：以 `updated_at` 毫秒为主序，`version` 列作同毫秒
 * 次级序。**不能只用 version 列**——`crmDbService.update()` 不会自动 +1，多名写入者只在部分路径
 * 显式递增，用它当版本闸门会静默丢掉「同版本号的后一次修改」。也不能只用 updated_at——同毫秒
 * 两次写入会相等而被中央 `<` 闸门拒收。
 */
function localRevision(row: CrmRow): number {
  const updatedAt = Math.max(0, Math.trunc(num(row.updated_at, 0)))
  const version = Math.max(0, Math.min(999, Math.trunc(num(row.version, 0))))
  if (updatedAt > 0) return updatedAt * 1000 + version
  return Math.max(1, Math.trunc(num(row.version, 0)) || 1)
}

// ─── 身份归一与脱敏（复用既有单点，不另写一套）────────────────────────────────

/** 身份值归一：手机号走 normalizePhone，wxid 走 normalizeWxid（与迁移模块②③同口径） */
export function normalizeIdentity(identityType: string, identityValue: string): string {
  return identityType === 'phone' ? normalizePhone(identityValue) : normalizeWxid(identityValue)
}

/** 身份值不可逆哈希（**归一后再哈希**，原文与归一值都留本机） */
export function identityHash(identityType: string, identityValue: string): string {
  return createHash('sha256').update(`${identityType}:${normalizeIdentity(identityType, identityValue)}`).digest('hex')
}

/**
 * 身份值展示掩码：复用全局脱敏口径 `shared/auditDict.maskContact`（手机号 → 138****1111、
 * `wxid_xxx` → 掩码），**不另写第二套掩码规则**。
 *
 * 注意 maskContact 是**擦除器**：它只按正则擦掉认得的形态，认不出就把输入原样返回。
 * 上行掩码是「原文不出机」的最后一道保险，原样返回等于泄漏，因此这里把「没擦掉」当泄漏处理，
 * 退化为全掩码——宁可展示上少几个字符，也不能让原文出机。
 */
export function maskIdentity(identityType: string, identityValue: string): string {
  const normalized = normalizeIdentity(identityType, identityValue)
  if (!normalized) return ''
  const scrubbed = maskContact(normalized)
  return scrubbed === normalized ? '*'.repeat(Math.min(normalized.length, 8)) : scrubbed
}

/** 客户引用（中央 central_customer.entity_id 的同一命名空间） */
export function customerRefOf(deviceId: string, customerId: number): string {
  return scopedRef(deviceId, `customer:${customerId}`)
}

/** 设备命名空间内的本地引用（供测试与调用方共用，禁止手拼） */
export const localRefOf = scopedRef

// ─── 跨表归并解析：本地业务行 → canonical customer ──────────────────────────

function customerIdOfAccount(accountId: number): number | null {
  if (!accountId) return null
  const row = crmDbService.all('SELECT customer_id FROM account WHERE id = ?', [accountId])[0]
  const cid = Number(row?.customer_id || 0)
  return cid > 0 ? cid : null
}

/**
 * lead → canonical customer（宪法 §2.4 Identity Resolution，与 friendDetect 同口径）：
 *  ① lead 已转客户：沿 lead.account_id → account.customer_id；
 *  ② 否则用 customer_identity 的归一身份值精确匹配（手机号优先，wxid 兜底）。
 * 命中多个不同 customer = 身份冲突，返回 null 并说明原因（绝不按显示名猜一个）。
 */
export function resolveCustomerIdForLead(leadId: number): { customerId: number | null; reason: string } {
  const lead = crmDbService.all('SELECT account_id, contact_type, contact_normalized FROM lead WHERE id = ?', [leadId])[0]
  if (!lead) return { customerId: null, reason: '线索不存在' }
  const viaAccount = customerIdOfAccount(Number(lead.account_id || 0))
  if (viaAccount) return { customerId: viaAccount, reason: '' }
  const type = text(lead.contact_type) === 'wxid' ? 'wxid' : 'phone'
  const value = normalizeIdentity(type, text(lead.contact_normalized))
  if (!value) return { customerId: null, reason: '线索无可用身份锚点，尚未归并到 canonical 客户' }
  const hits = crmDbService.all(
    'SELECT DISTINCT customer_id FROM customer_identity WHERE identity_type = ? AND identity_value = ? AND customer_id IS NOT NULL AND deleted = 0',
    [type, value]
  ).map((row) => Number(row.customer_id)).filter((cid) => cid > 0)
  if (hits.length === 1) return { customerId: hits[0]!, reason: '' }
  if (hits.length > 1) return { customerId: null, reason: `身份锚点命中 ${hits.length} 个 customer，需人工合并后再同步` }
  return { customerId: null, reason: '线索尚未归并到 canonical 客户（宪法 §2.4 后补关联合法态）' }
}

// ─── 各实体投影 ────────────────────────────────────────────────────────────────

/** customer 行 → 投影草稿（read 与 recheck 共用同一构造，避免两处口径漂移） */
function customerDraftOf(row: CrmRow, deviceId: string): ProjectionDraft | ProjectionSkip {
  const localRef = `customer:${num(row.id)}`
  const name = text(row.name).trim()
  // displayName 是中央必填字段：本机连名字都没有的行没有可上行内容，跳过（后续补齐由台账重试）
  if (!name) return { localRef, reason: '客户无名称（中央 displayName 必填）' }
  return {
    entityType: 'customer', localRef, eventType: 'customer_projected',
    aggregateVersion: localRevision(row), eventSeq: num(row.id), occurredAt: num(row.updated_at, Date.now()),
    payload: {
      customerRef: customerRefOf(deviceId, num(row.id)),
      displayName: name,
      customerType: nullableText(row.type),
      source: nullableText(row.source),
      updatedBy: nullableText(row.updated_by),
      deleted: num(row.deleted) === 1
    }
  }
}

const customerProjection: LocalProjection = {
  key: 'customer', entityType: 'customer', mode: 'versioned',
  read(watermark, limit, deviceId) {
    const rows = readVersioned('customer', watermark, limit, { alias: 't' })
    const out: ProjectionDraft[] = []
    const skipped: ProjectionSkip[] = []
    for (const row of rows) {
      const draft = customerDraftOf(row, deviceId)
      if (isSkip(draft)) skipped.push(draft)
      else out.push(draft)
    }
    return result(out, rows, watermark, limit, skipped)
  },
  // 按 id 精确定位这一行再判定，绝不用「从头读一页再找」的方式（limit=1 时永远只看得到第一行）
  recheck(localRef, deviceId) {
    const row = crmDbService.all('SELECT * FROM customer WHERE id = ?', [idOf(localRef, 'customer')])[0]
    return row ? customerDraftOf(row, deviceId) : null
  }
}

/** customer_identity 行 → 投影草稿（read 与 recheck 共用同一构造，身份哈希/掩码口径唯一） */
function identityDraftOf(row: CrmRow, deviceId: string): ProjectionDraft | ProjectionSkip {
  const localRef = `identity:${num(row.id)}`
  const customerId = nullableNum(row.customer_id)
  // 未归并到客户的孤立身份没有中央可挂靠的客户引用（宪法 §2.4 后补关联合法态）
  if (customerId === null) return { localRef, reason: '身份未归并到 canonical 客户' }
  const type = text(row.identity_type)
  return {
    entityType: 'customer_identity', localRef, eventType: 'identity_projected',
    aggregateVersion: localRevision(row), eventSeq: num(row.id), occurredAt: num(row.updated_at, Date.now()),
    payload: {
      customerRef: customerRefOf(deviceId, customerId),
      identityType: type,
      identityHash: identityHash(type, text(row.identity_value)),
      identityMasked: maskIdentity(type, text(row.identity_value)),
      confidence: nullableNum(row.confidence),
      source: nullableText(row.source),
      deleted: num(row.deleted) === 1
    }
  }
}

const customerIdentityProjection: LocalProjection = {
  key: 'customer_identity', entityType: 'customer_identity', mode: 'versioned',
  read(watermark, limit, deviceId) {
    const rows = readVersioned('customer_identity', watermark, limit, { alias: 't' })
    const out: ProjectionDraft[] = []
    const skipped: ProjectionSkip[] = []
    for (const row of rows) {
      const draft = identityDraftOf(row, deviceId)
      if (isSkip(draft)) skipped.push(draft)
      else out.push(draft)
    }
    return result(out, rows, watermark, limit, skipped)
  },
  recheck(localRef, deviceId) {
    const row = crmDbService.all('SELECT * FROM customer_identity WHERE id = ?', [idOf(localRef, 'identity')])[0]
    return row ? identityDraftOf(row, deviceId) : null
  }
}

/** assignment 行 → 投影草稿（read 与 recheck 共用同一构造，避免两处口径漂移） */
function assignmentDraftOf(row: CrmRow, deviceId: string): ProjectionDraft | ProjectionSkip {
  const localRef = `assignment:${num(row.id)}`
  const leadId = num(row.lead_id)
  const resolved = resolveCustomerIdForLead(leadId)
  if (!resolved.customerId) return { localRef, reason: resolved.reason }
  return {
    entityType: 'assignment', localRef, eventType: 'assignment_projected',
    aggregateVersion: localRevision(row), eventSeq: num(row.id), occurredAt: num(row.updated_at, Date.now()),
    payload: {
      customerRef: customerRefOf(deviceId, resolved.customerId),
      // 本机线索锚点：中央无独立 lead 实体（协议未登记），仅用于回溯与下行指令对齐
      leadRef: scopedRef(deviceId, `lead:${leadId}`),
      salesName: text(row.sales_name),
      status: text(row.status),
      mode: nullableText(row.mode),
      sla1Deadline: nullableNum(row.sla1_deadline),
      // assigned_at 是「进入轮次」的稳定锚点：优先 lead.assigned_at，回退本行 claimed_at
      assignedAt: nullableNum(row.lead_assigned_at) ?? nullableNum(row.claimed_at),
      updatedBy: nullableText(row.updated_by),
      deleted: num(row.deleted) === 1
    }
  }
}

const assignmentProjection: LocalProjection = {
  key: 'assignment', entityType: 'assignment', mode: 'versioned',
  read(watermark, limit, deviceId) {
    // 关联 lead：assignment 表本身没有 assigned_at 列，而 lead.assigned_at 是本轮分配进入时刻的强事实源。
    // 用 LEFT JOIN + 显式列：lead 行缺失或尚未置 assigned_at 的 assignment **照常上行**
    // （只按 id 游标推进的水位不会因丢行而回退，静默丢行 = 该分配事实永远漏同步）。
    const rows = readVersioned(
      'assignment LEFT JOIN lead ON lead.id = assignment.lead_id', watermark, limit,
      { alias: 'assignment', select: 'assignment.*, lead.assigned_at AS lead_assigned_at' })
    const out: ProjectionDraft[] = []
    const skipped: ProjectionSkip[] = []
    for (const row of rows) {
      const draft = assignmentDraftOf(row, deviceId)
      if (isSkip(draft)) skipped.push(draft)
      else out.push(draft)
    }
    return result(out, rows, watermark, limit, skipped)
  },
  recheck(localRef, deviceId) {
    const row = crmDbService.all(
      'SELECT assignment.*, lead.assigned_at AS lead_assigned_at FROM assignment'
      + ' LEFT JOIN lead ON lead.id = assignment.lead_id WHERE assignment.id = ?',
      [idOf(localRef, 'assignment')])[0]
    return row ? assignmentDraftOf(row, deviceId) : null
  }
}

function ownershipDraftOf(row: CrmRow, deviceId: string): ProjectionDraft | ProjectionSkip {
  const accountId = num(row.id)
  const localRef = `ownership:${accountId}`
  const customerId = customerIdOfAccount(accountId)
  // 宪法 §1.1/§4.3：account.customer_id 可空（未归并合法态）。中央 ownership 的 customerRef 必须能
  // 关联到 central_customer——未归并的 account 明确跳过并记原因，归并完成后由台账重试进入同步。
  if (!customerId) return { localRef, reason: 'account 未归并到 canonical 客户（customer_id 为空）' }
  // 中央 central_ownership.owner_sales 是 NOT NULL 口径的必填列：归属为空的 account 还没有「归属事实」，
  // 属于**暂不可投影**而不是可投影的空值。放在草稿构造里，read 与台账 recheck 共用同一条规则，
  // 否则 recheck 会把空归属当合法投影推上去，被中央永久拒收并且永远结算不掉（§五.3）。
  if (!text(row.owner_sales).trim()) return { localRef, reason: 'account 归属销售为空（owner_sales 未填），中央 ownership 必填' }
  return {
    entityType: 'ownership', localRef, eventType: 'ownership_projected',
    aggregateVersion: localRevision(row), eventSeq: accountId, occurredAt: num(row.updated_at, Date.now()),
    payload: {
      customerRef: customerRefOf(deviceId, customerId),
      ownerSales: text(row.owner_sales),
      reason: null,
      effectiveFrom: nullableNum(row.updated_at),
      updatedBy: null,
      deleted: false
    }
  }
}

const ownershipProjection: LocalProjection = {
  key: 'ownership', entityType: 'ownership', mode: 'versioned',
  read(watermark, limit, deviceId) {
    // 宪法 §1：ownership 的真源是 account.owner_sales 列语义，本机没有独立 ownership 表。
    // 归属为空的行由 ownershipDraftOf 判为「暂不可投影」并记原因，不在这里用谓词藏掉——
    // 藏掉就没有跳过数与原因，补充归属后也无从核对（§五.2）。
    const rows = readVersioned('account', watermark, limit, { alias: 't' })
    const out: ProjectionDraft[] = []
    const skipped: ProjectionSkip[] = []
    for (const row of rows) {
      const draft = ownershipDraftOf(row, deviceId)
      if (isSkip(draft)) skipped.push(draft)
      else out.push(draft)
    }
    return result(out, rows, watermark, limit, skipped)
  },
  recheck(localRef, deviceId) {
    const row = crmDbService.all('SELECT * FROM account WHERE id = ?', [idOf(localRef, 'ownership')])[0]
    return row ? ownershipDraftOf(row, deviceId) : null
  }
}

function opportunityDraftOf(row: CrmRow, deviceId: string): ProjectionDraft | ProjectionSkip {
  const localRef = `opportunity:${num(row.id)}`
  const accountId = num(row.account_id)
  if (!accountId) return { localRef, reason: '商机无 account 引用，中央无法归属' }
  const customerId = customerIdOfAccount(accountId)
  if (!customerId) return { localRef, reason: '商机所属 account 未归并到 canonical 客户' }
  return {
    entityType: 'opportunity', localRef, eventType: 'opportunity_projected',
    aggregateVersion: localRevision(row), eventSeq: num(row.id), occurredAt: num(row.updated_at, Date.now()),
    payload: {
      customerRef: customerRefOf(deviceId, customerId),
      name: nullableText(row.name),
      stage: text(row.stage).trim() || 'initial',
      status: nullableText(row.status),
      oppType: nullableText(row.type),
      amountCny: nullableNum(row.amount_cny) ?? nullableNum(row.amount),
      originalCurrency: nullableText(row.original_currency),
      originalAmount: nullableNum(row.original_amount),
      orderQty: nullableNum(row.order_qty) ?? nullableNum(row.quantity),
      shippedQty: nullableNum(row.shipped_qty),
      expectedShipStart: nullableNum(row.expected_ship_start),
      expectedShipEnd: nullableNum(row.expected_ship_end),
      deliveryDate: nullableNum(row.delivery_date),
      updatedBy: nullableText(row.owner_sales),
      deleted: false
    }
  }
}

const opportunityProjection: LocalProjection = {
  key: 'opportunity', entityType: 'opportunity', mode: 'versioned',
  read(watermark, limit, deviceId) {
    const rows = readVersioned('opportunity', watermark, limit, { alias: 't' })
    const out: ProjectionDraft[] = []
    const skipped: ProjectionSkip[] = []
    for (const row of rows) {
      const draft = opportunityDraftOf(row, deviceId)
      if (isSkip(draft)) skipped.push(draft)
      else out.push(draft)
    }
    return result(out, rows, watermark, limit, skipped)
  },
  recheck(localRef, deviceId) {
    const row = crmDbService.all('SELECT * FROM opportunity WHERE id = ?', [idOf(localRef, 'opportunity')])[0]
    return row ? opportunityDraftOf(row, deviceId) : null
  }
}

/**
 * 报价版本行 → 投影草稿。
 * 中央 central_quote 的 `opportunity_ref` 必须能关联**实际存在的** central_opportunity：
 * 本地没有 contract→opportunity 的外键，但 `opportunity.quote_version_id` 指向本合同的现行报价版本，
 * 因此「本合同的报价版本链」归一到「指向该链任一版本的商机」。链上查不到商机 = 尚未绑定，
 * 明确跳过并记原因（绝不生成中央不存在的 `contract:<id>` 充当商机引用）。
 */
function resolveOpportunityRefOfQuotation(quotationId: number, contractId: number, deviceId: string): string | null {
  const direct = crmDbService.all('SELECT id FROM opportunity WHERE quote_version_id = ? ORDER BY id LIMIT 1', [quotationId])[0]
  if (direct) return scopedRef(deviceId, `opportunity:${num(direct.id)}`)
  const viaChain = crmDbService.all(
    `SELECT o.id AS id FROM opportunity o JOIN quotation q ON q.id = o.quote_version_id
     WHERE q.contract_id = ? ORDER BY o.id LIMIT 1`, [contractId])[0]
  return viaChain ? scopedRef(deviceId, `opportunity:${num(viaChain.id)}`) : null
}

function quoteDraftOf(row: CrmRow, deviceId: string): ProjectionDraft | ProjectionSkip {
  const quotationId = num(row.id)
  const contractId = num(row.contract_id)
  const localRef = `quotation:${quotationId}`
  if (!contractId) return { localRef, reason: '报价未挂合同，中央无法关联商机' }
  const opportunityRef = resolveOpportunityRefOfQuotation(quotationId, contractId, deviceId)
  if (!opportunityRef) return { localRef, reason: '报价链未绑定任何中央可关联商机（opportunity.quote_version_id 未指向本链）' }
  const customerId = customerIdOfAccount(num(row.account_id))
  return {
    entityType: 'quote', localRef, eventType: 'quote_projected',
    aggregateVersion: Math.max(1, num(row.version, 1)), eventSeq: quotationId, occurredAt: num(row.created_at, Date.now()),
    payload: {
      opportunityRef,
      customerRef: customerId ? customerRefOf(deviceId, customerId) : null,
      versionNo: Math.max(1, num(row.version, 1)),
      amountCny: nullableNum(row.total),
      currency: 'CNY',
      effectiveFrom: nullableNum(row.effective_from),
      effectiveTo: nullableNum(row.effective_to),
      docHash: documentHash(row)
    }
  }
}

/** 报价单文档哈希（宪法 §1.6 证据链）：只认已生成产物的 SHA-256，缺失即 null，不伪造 */
function documentHash(row: CrmRow): string | null {
  for (const candidate of [row.artifact_hash, row.pdf_hash]) {
    const value = text(candidate).trim()
    if (value.length >= 32) return value
  }
  try {
    const parsed = JSON.parse(String(row.custom_fields || '{}')) as Record<string, unknown>
    const value = parsed.quote_pdf_sha256 ?? parsed.quote_pdf_hash
    return typeof value === 'string' && value.length >= 32 ? value : null
  } catch { return null }
}

const quoteProjection: LocalProjection = {
  // quotation 版本行一旦生成即不可变（宪法 §1.6 append-only：改动只能出新版本行），故按 id 游标
  key: 'quote', entityType: 'quote', mode: 'id',
  read(watermark, limit, deviceId) {
    const rows = readAppendOnly(
      `SELECT q.*, c.account_id AS account_id, c.quote_version_id AS contract_current_quote
       FROM quotation q JOIN contract c ON c.id = q.contract_id WHERE q.id > ? ORDER BY q.id LIMIT ?`,
      watermark.id, limit)
    const out: ProjectionDraft[] = []
    const skipped: ProjectionSkip[] = []
    for (const row of rows) {
      const draft = quoteDraftOf(row, deviceId)
      if (isSkip(draft)) skipped.push(draft)
      else out.push(draft)
    }
    return result(out, rows, watermark, limit, skipped)
  },
  recheck(localRef, deviceId) {
    const row = crmDbService.all(
      `SELECT q.*, c.account_id AS account_id FROM quotation q JOIN contract c ON c.id = q.contract_id WHERE q.id = ?`,
      [idOf(localRef, 'quotation')])[0]
    return row ? quoteDraftOf(row, deviceId) : null
  }
}

const auditProjection: LocalProjection = {
  key: 'audit', entityType: 'audit_event', mode: 'id',
  read(watermark, limit) {
    const rows = readAppendOnly(
      "SELECT * FROM audit_event WHERE id > ? AND action NOT LIKE 'sync_%' ORDER BY id LIMIT ?", watermark.id, limit)
    const out: ProjectionDraft[] = []
    const skipped: ProjectionSkip[] = []
    for (const row of rows) {
      const localRef = `audit:${num(row.id)}`
      if (!text(row.actor).trim() || !text(row.action).trim()) {
        // 中央 central_audit_projection 的 actor/action 是 NOT NULL 必填：缺项行本机跳过并记原因
        skipped.push({ localRef, reason: '审计行缺 actor/action，中央必填' })
        continue
      }
      out.push({
      entityType: 'audit_event' as CentralEntityType, localRef, eventType: text(row.action) || 'audit',
      aggregateVersion: 1, eventSeq: num(row.id), occurredAt: num(row.created_at, Date.now()),
      payload: {
        sourceAuditId: String(num(row.id)),
        actor: text(row.actor),
        action: text(row.action),
        subjectType: nullableText(row.entity_type),
        subjectId: row.entity_id === null || row.entity_id === undefined ? null : String(row.entity_id),
        detailMasked: maskAuditDetail(text(row.detail)),
        occurredAt: num(row.created_at) || null
      }
      })
    }
    return result(out, rows, watermark, limit, skipped)
  },
  recheck() { return null }
}

const SECRET_PATTERN = /("?(?:device[_-]?token|invite[_-]?code|password|api[_-]?key|secret)"?\s*[:=]\s*"?)[^",}\s]+/gi

/** 自由文本擦除：手机号 / `wxid_xxx` 走全局 maskContact，凭据类走占位符 */
function scrubAuditText(value: string): string {
  return maskContact(value).replace(SECRET_PATTERN, '$1***')
}

/**
 * 身份值擦除：maskContact 只擦认得的形态，认不出就原样返回——原样返回等于原文出机，
 * 因此这里与 maskIdentity 同款口径，把「没擦掉」当泄漏处理，退化为全掩码（§一.6）。
 */
function scrubIdentityValue(value: unknown): unknown {
  if (typeof value !== 'string') return scrubAuditValue(value)
  const scrubbed = maskContact(value)
  if (!value.trim()) return scrubbed
  return scrubbed === value ? '*'.repeat(Math.min(value.length, 8)) : scrubbed
}

/**
 * 递归擦除审计 detail 中**禁止出机**的字段值：
 *  - 聊天/会话类字段名（两会话方向都禁）→ 只留本地；
 *  - 原始身份类字段名（手机号 / wxid / contactRaw…）→ 掩码，认不出形态则全掩码；
 *  - 其余字符串走自由文本擦除（手机号与凭据）。
 * 判定复用 shared 的字段名清单，不另立第二套规则。
 */
function scrubAuditValue(value: unknown): unknown {
  if (typeof value === 'string') return scrubAuditText(value)
  if (Array.isArray(value)) return value.map(scrubAuditValue)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (isForbiddenChatFieldName(key)) out[key] = '[本地留存]'
      else if (isForbiddenIdentityFieldName(key)) out[key] = scrubIdentityValue(child)
      else out[key] = scrubAuditValue(child)
    }
    return out
  }
  return value
}

/**
 * 审计 detail 出机前擦除。detail 在库里是 JSON 文本，但**不保证**始终合法 JSON，
 * 因此优先按 JSON 逐字段擦（能按字段名认身份值）；解析失败退化为纯文本擦除，宁可擦过头。
 */
function maskAuditDetail(detail: string): string | null {
  const s = text(detail).trim()
  if (!s) return null
  try { return JSON.stringify(scrubAuditValue(JSON.parse(s))) } catch { return scrubAuditText(s) }
}

function judgmentDraftOf(row: CrmRow, customerRef: string): ProjectionDraft {
  return {
    entityType: 'customer_judgment', localRef: `judgment:${num(row.id)}`, eventType: 'judgment_projected',
    aggregateVersion: Math.max(1, num(row.id)), eventSeq: num(row.id),
    occurredAt: num(row.generated_at, num(row.created_at, Date.now())),
    payload: {
      customerRef,
      judgmentType: text(row.judgment_type),
      value: text(row.value),
      confidence: nullableNum(row.confidence),
      source: nullableText(row.source),
      model: nullableText(row.model),
      generatedAt: nullableNum(row.generated_at),
      // 证据锚点复用本机 messageKey（P0-2B），不另造 evidence ID 体系；evidence_text 是客户原话，不上行
      evidenceKey: nullableText(row.message_key),
      deleted: false
    }
  }
}

const judgmentProjection: LocalProjection = {
  // customer_judgment 无 updated_at，append-only（判断一旦生成不被改写），按 id 游标
  key: 'customer_judgment', entityType: 'customer_judgment', mode: 'id',
  read(watermark, limit, deviceId) {
    const refs = sessionCustomerRefs(deviceId)
    const rows = salesDbService.judgmentSince(watermark.id, clampLimit(limit))
    const out: ProjectionDraft[] = []
    const skipped: ProjectionSkip[] = []
    for (const row of rows) {
      const localRef = `judgment:${num(row.id)}`
      const customerRef = refs.get(String(row.session_id))
      // session_id 属禁上传字段：只能通过既有 customer_profile→customer_id 归并映射成客户引用，
      // 映射不到的判断本机保留、不上行（绝不把 session_id 或哈希后的 session_id 送出去）
      if (!customerRef) { skipped.push({ localRef, reason: '会话未归并到 canonical 客户' }); continue }
      out.push(judgmentDraftOf(row as unknown as CrmRow, customerRef))
    }
    return result(out, rows as unknown as CrmRow[], watermark, limit, skipped)
  },
  recheck(localRef, deviceId) {
    const id = idOf(localRef, 'judgment')
    const rows = salesDbService.judgmentSince(id - 1, 1)
    const row = rows.find((item) => Number(item.id) === id)
    if (!row) return null
    const customerRef = sessionCustomerRefs(deviceId).get(String(row.session_id))
    return customerRef ? judgmentDraftOf(row as unknown as CrmRow, customerRef) : { localRef, reason: '会话未归并到 canonical 客户' }
  }
}

/** session_id → 中央客户引用映射（只读既有 customer_profile 归并列，不新建映射表） */
function sessionCustomerRefs(deviceId: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const profile of salesDbService.listCustomerProfileIds()) {
    const customerId = num(text(profile.customer_id).trim())
    if (customerId <= 0) continue
    map.set(String(profile.session_id), customerRefOf(deviceId, customerId))
  }
  return map
}

function knowledgeDraftOf(row: CrmRow): ProjectionDraft {
  return {
    entityType: 'knowledge_proposal', localRef: `kb:${num(row.id)}`, eventType: 'knowledge_proposal_projected',
    aggregateVersion: localRevision(row), eventSeq: num(row.id), occurredAt: num(row.updated_at, Date.now()),
    payload: {
      // logicalId 是知识链稳定锚点（PRD 2.3），缺失时退回本机行引用
      logicalId: text(row.logical_id).trim() || `kb:${num(row.id)}`,
      title: text(row.title),
      content: nullableText(row.content),
      category: nullableText(row.category),
      productLine: nullableText(row.product_line),
      scene: nullableText(row.scene),
      authority: nullableText(row.authority),
      versionNo: Math.max(1, num(row.version, 1)),
      status: text(row.status) || 'staging',
      source: nullableText(row.source),
      evidenceKey: nullableText(row.evidence_key),
      ttlDate: nullableText(row.ttl_date),
      reviewedBy: nullableText(row.reviewed_by),
      reviewedAt: nullableNum(row.reviewed_at),
      deleted: false
    }
  }
}

const knowledgeProposalProjection: LocalProjection = {
  key: 'knowledge_proposal', entityType: 'knowledge_proposal', mode: 'versioned',
  read(watermark, limit) {
    // 知识治理行会原地变化（审核通过 / 版本升级 / TTL 生效），必须走复合水位而不是 id 游标
    const rows = salesDbService.kbWatermarkSince(watermark.ts, watermark.id, clampLimit(limit)) as unknown as CrmRow[]
    return result(rows.map(knowledgeDraftOf), rows, watermark, limit, [])
  },
  recheck(localRef) {
    const id = idOf(localRef, 'kb')
    const row = salesDbService.kbGet(id)
    if (!row || String(row.source || '') !== 'proposal') return null
    return knowledgeDraftOf(row as unknown as CrmRow)
  }
}

// ─── 读取骨架（水位推进与「跳过不阻塞」的统一实现）──────────────────────────

function isSkip(value: ProjectionDraft | ProjectionSkip): value is ProjectionSkip {
  return typeof (value as ProjectionSkip).reason === 'string' && !(value as ProjectionDraft).payload
}

function result(
  drafts: ProjectionDraft[], rows: CrmRow[], watermark: ProjectionWatermark, limit: number, skipped: ProjectionSkip[]
): ProjectionReadResult {
  const last = rows[rows.length - 1]
  const next: ProjectionWatermark = last
    ? { ts: Math.max(0, Math.trunc(num(last.updated_at, watermark.ts))), id: num(last.id, watermark.id) }
    : watermark
  return { drafts, watermark: next, scanned: rows.length, skipped, full: rows.length >= clampLimit(limit) }
}

/**
 * 可变表增量读：`(updated_at, id) > (ts, id)` 复合水位。
 * 只按 id 游标会漏掉已同步行的后续更新（客户改名 / assignment 状态流转 / 商机金额与阶段变化），
 * 中央那侧看起来「这个客户永远是首版」。同毫秒多行由 id 次级序兜住，不会漏。
 */
function readVersioned(
  from: string, watermark: ProjectionWatermark, limit: number,
  options: { alias?: string; select?: string } = {}
): CrmRow[] {
  // from / 别名 / 附加谓词均为本文件内的字面量（非用户输入）；值一律参数化
  const alias = options.alias || 't'
  // from 含空白 = 调用方给的是**完整 FROM 子句**（自带 JOIN，别名已写在子句里），不能再追加别名：
  // `FROM assignment JOIN lead ON ... assignment` 是非法 SQL（SQLite: near "assignment": syntax error）。
  const fromClause = /\s/.test(from.trim()) ? from : `${from} ${alias}`
  // JOIN 场景必须显式列选择：只取 `alias.*` 会丢掉关联表要用的列，取 `*` 又会让同名列互相覆盖
  const select = options.select || `${alias}.*`
  // 注意：这里**不再支持扫描级附加谓词**。曾经有过一个 extraWhere 参数，写法是
  // `ts > ? OR (ts = ? AND id > ? AND 谓词)` —— SQL 里 AND 优先级高于 OR，实际被判成
  // `ts > ? OR (ts = ? AND id > ? AND 谓词)`，于是所有「更新时刻晚于水位」的行都绕过谓词出机
  // （实测：owner_sales 为空的 account 照常上行，被中央以 missing_required:ownerSales 永久拒收，
  // 对应 outbox 行永远结算不掉）。「这一行现在能不能投影」属于**投影自身的规则**，一律放进
  // 该投影的 draft 构造里，由 read 与台账 recheck 共用，而不是散在扫描 SQL 里（§五.3）。
  return crmDbService.all(
    `SELECT ${select} FROM ${fromClause}
     WHERE COALESCE(${alias}.updated_at, 0) > ? OR (COALESCE(${alias}.updated_at, 0) = ? AND ${alias}.id > ?)
     ORDER BY COALESCE(${alias}.updated_at, 0), ${alias}.id LIMIT ?`,
    [watermark.ts, watermark.ts, watermark.id, clampLimit(limit)])
}

function readAppendOnly(sql: string, cursor: number, limit: number): CrmRow[] {
  return crmDbService.all(sql, [Math.max(0, Math.trunc(cursor)), clampLimit(limit)])
}

/** 上行投影注册表（顺序 = 执行顺序；audit 复用既有游标键） */
export const LOCAL_PROJECTIONS: readonly LocalProjection[] = [
  customerProjection,
  customerIdentityProjection,
  assignmentProjection,
  ownershipProjection,
  opportunityProjection,
  quoteProjection,
  auditProjection,
  judgmentProjection,
  knowledgeProposalProjection
]

export function projectionByKey(key: string): LocalProjection | undefined {
  return LOCAL_PROJECTIONS.find((item) => item.key === key)
}
