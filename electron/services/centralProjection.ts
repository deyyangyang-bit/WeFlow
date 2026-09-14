/**
 * Phase 3a 上行投影：把**本机既有结构化业务事实**映射为 CentralSyncEvent。
 *
 * 纪律（PRD §7.1 / docs/DATA-CONSTITUTION.md）：
 *  - 只读既有业务表与既有 append-only 流水，**禁止扫描聊天表**产生上行事件；
 *  - 一个实体类型 → 一组明确字段，字段名与中央 projections.ts 注册表一一对应；
 *  - 聊天正文、消息正文、session_id、WCDB 路径与原始聊天数据**永不出现在 payload 中**；
 *  - 身份值（手机号 / wxid）只上不可逆哈希 + 展示掩码，原文不出本机；
 *  - 不新建第二套 seq / idempotency / ACK 语义：游标复用 scan_state，幂等键复用 outbox 口径。
 *
 * entityId 一律带设备前缀（`<deviceId>/<localRef>`）：本地自增 id 在不同机器上必然重号，
 * 不带前缀会让两台机器的 `customer:5` 在中央互相覆盖。
 */
import { createHash } from 'crypto'
import type { CentralEntityType } from '../../shared/centralSync'
import { crmDbService, type CrmRow } from './crmDbService'
import { salesDbService } from './salesDbService'

/** 单条待上行投影（尚未封成传输信封） */
export interface ProjectionDraft {
  entityType: CentralEntityType
  /** 本地稳定引用（不含设备前缀），最终 entityId = `${deviceId}/${localRef}` */
  localRef: string
  eventType: string
  aggregateVersion: number
  eventSeq: number
  payload: Record<string, unknown>
  occurredAt: number
}

export interface LocalProjection {
  /** 投影名（也用于 scan_state 游标键与状态展示） */
  key: string
  entityType: CentralEntityType
  /** 从既有结构化来源按自增 id 游标增量读取 */
  read(cursor: number, limit: number): ProjectionDraft[]
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
  return Number.isFinite(n) ? n : null
}

function text(value: unknown): string {
  return value === null || value === undefined ? '' : String(value)
}

function nullableText(value: unknown): string | null {
  const s = text(value).trim()
  return s === '' ? null : s
}

/** 身份值不可逆哈希（只上行哈希，原文留本机） */
export function identityHash(identityType: string, identityValue: string): string {
  return createHash('sha256').update(`${identityType}:${identityValue}`).digest('hex')
}

/** 身份值展示掩码：手机号保留前 3 后 2，其余保留前 2 后 2（PRD §10 R4 脱敏清单） */
export function maskIdentity(identityType: string, identityValue: string): string {
  const value = text(identityValue)
  if (!value) return ''
  if (identityType === 'phone' && value.length >= 7) return `${value.slice(0, 3)}****${value.slice(-2)}`
  if (value.length <= 4) return '*'.repeat(value.length)
  return `${value.slice(0, 2)}${'*'.repeat(Math.max(2, value.length - 4))}${value.slice(-2)}`
}

// ─── 各实体投影 ────────────────────────────────────────────────────────────────

const customerProjection: LocalProjection = {
  key: 'customer', entityType: 'customer',
  read(cursor, limit) {
    const rows = crmDbService.all('SELECT * FROM customer WHERE id > ? ORDER BY id LIMIT ?', [cursor, clampLimit(limit)])
    const out: ProjectionDraft[] = []
    for (const row of rows) {
      const name = text(row.name).trim()
      // displayName 是中央必填字段：本机连名字都没有的行没有可上行内容，跳过（不足的用后续事件补齐）
      if (!name) continue
      out.push({
        entityType: 'customer', localRef: `customer:${num(row.id)}`, eventType: 'customer_projected',
        aggregateVersion: Math.max(1, num(row.version, 1)), eventSeq: num(row.id), occurredAt: num(row.updated_at, Date.now()),
        payload: {
          customerRef: `customer:${num(row.id)}`,
          displayName: name,
          customerType: nullableText(row.type),
          source: nullableText(row.source),
          updatedBy: nullableText(row.updated_by),
          deleted: num(row.deleted) === 1
        }
      })
    }
    return out
  }
}

const customerIdentityProjection: LocalProjection = {
  key: 'customer_identity', entityType: 'customer_identity',
  read(cursor, limit) {
    const rows = crmDbService.all('SELECT * FROM customer_identity WHERE id > ? ORDER BY id LIMIT ?', [cursor, clampLimit(limit)])
    const out: ProjectionDraft[] = []
    for (const row of rows) {
      const customerId = nullableNum(row.customer_id)
      // 未归并到客户的孤立身份没有中央可挂靠的客户引用，跳过（归并后由后续事件补齐）
      if (customerId === null) continue
      const type = text(row.identity_type)
      out.push({
        entityType: 'customer_identity', localRef: `identity:${num(row.id)}`, eventType: 'identity_projected',
        aggregateVersion: Math.max(1, num(row.version, 1)), eventSeq: num(row.id), occurredAt: num(row.updated_at, Date.now()),
        payload: {
          customerRef: `customer:${customerId}`,
          identityType: type,
          identityHash: identityHash(type, text(row.identity_value)),
          identityMasked: maskIdentity(type, text(row.identity_value)),
          confidence: nullableNum(row.confidence),
          source: nullableText(row.source),
          deleted: num(row.deleted) === 1
        }
      })
    }
    return out
  }
}

const assignmentProjection: LocalProjection = {
  key: 'assignment', entityType: 'assignment',
  read(cursor, limit) {
    const rows = crmDbService.all('SELECT * FROM assignment WHERE id > ? ORDER BY id LIMIT ?', [cursor, clampLimit(limit)])
    return rows.map((row) => {
      const leadId = num(row.lead_id)
      return {
        entityType: 'assignment' as CentralEntityType, localRef: `assignment:${num(row.id)}`, eventType: 'assignment_projected',
        aggregateVersion: Math.max(1, num(row.version, 1)), eventSeq: num(row.id), occurredAt: num(row.updated_at, Date.now()),
        payload: {
          // 本地 assignment 挂在 lead 上；lead↔customer 归并发生在迁移链路，这里只带本地稳定引用
          customerRef: `lead:${leadId}`,
          leadRef: `lead:${leadId}`,
          salesName: text(row.sales_name),
          status: text(row.status),
          mode: nullableText(row.mode),
          sla1Deadline: nullableNum(row.sla1_deadline),
          assignedAt: nullableNum(row.claimed_at),
          updatedBy: nullableText(row.updated_by),
          deleted: num(row.deleted) === 1
        }
      }
    })
  }
}

const ownershipProjection: LocalProjection = {
  key: 'ownership', entityType: 'ownership',
  read(cursor, limit) {
    // 宪法 §1：ownership 的真源是 account.owner_sales 列语义，本机没有独立 ownership 表
    const rows = crmDbService.all("SELECT * FROM account WHERE id > ? AND owner_sales IS NOT NULL AND TRIM(owner_sales) != '' ORDER BY id LIMIT ?", [cursor, clampLimit(limit)])
    return rows.map((row) => ({
      entityType: 'ownership' as CentralEntityType, localRef: `account:${num(row.id)}`, eventType: 'ownership_projected',
      aggregateVersion: Math.max(1, num(row.id)), eventSeq: num(row.id), occurredAt: num(row.updated_at, Date.now()),
      payload: {
        customerRef: `account:${num(row.id)}`,
        ownerSales: text(row.owner_sales),
        effectiveFrom: nullableNum(row.updated_at),
        deleted: false
      }
    }))
  }
}

const opportunityProjection: LocalProjection = {
  key: 'opportunity', entityType: 'opportunity',
  read(cursor, limit) {
    const rows = crmDbService.all('SELECT * FROM opportunity WHERE id > ? ORDER BY id LIMIT ?', [cursor, clampLimit(limit)])
    const out: ProjectionDraft[] = []
    for (const row of rows) {
      const accountId = nullableNum(row.account_id)
      if (accountId === null) continue // 无客户引用的商机在中央无法归属，跳过
      out.push({
        entityType: 'opportunity', localRef: `opportunity:${num(row.id)}`, eventType: 'opportunity_projected',
        aggregateVersion: Math.max(1, num(row.id)), eventSeq: num(row.id), occurredAt: num(row.updated_at, Date.now()),
        payload: {
          customerRef: `account:${accountId}`,
          name: nullableText(row.name),
          stage: text(row.stage) || 'initial',
          status: nullableText(row.status),
          amountCny: nullableNum(row.amount),
          originalCurrency: 'CNY',
          originalAmount: nullableNum(row.amount),
          orderQty: nullableNum(row.quantity),
          updatedBy: nullableText(row.owner_sales),
          deleted: false
        }
      })
    }
    return out
  }
}

const quoteProjection: LocalProjection = {
  key: 'quote', entityType: 'quote',
  read(cursor, limit) {
    // 报价版本链真源：quotation 版本行 + contract.quote_version_id 指针（宪法 §1.6 append-only）
    const rows = crmDbService.all(
      `SELECT q.*, c.account_id AS account_id, c.quote_version_id AS contract_current_quote
       FROM quotation q JOIN contract c ON c.id = q.contract_id
       WHERE q.id > ? ORDER BY q.id LIMIT ?`, [cursor, clampLimit(limit)])
    const out: ProjectionDraft[] = []
    for (const row of rows) {
      const contractId = num(row.contract_id)
      const draft = documentHash(row)
      out.push({
        // 本地报价挂在合同上，引用即合同；versionNo 在合同内唯一，满足中央 (opportunity_ref, version_no) 唯一键
        entityType: 'quote', localRef: `quotation:${num(row.id)}`, eventType: 'quote_projected',
        aggregateVersion: Math.max(1, num(row.version, 1)), eventSeq: num(row.id), occurredAt: num(row.created_at, Date.now()),
        payload: {
          opportunityRef: `contract:${contractId}`,
          customerRef: nullableNum(row.account_id) === null ? null : `account:${num(row.account_id)}`,
          versionNo: Math.max(1, num(row.version, 1)),
          amountCny: nullableNum(row.total),
          currency: 'CNY',
          effectiveFrom: nullableNum(row.effective_from),
          effectiveTo: nullableNum(row.effective_to),
          docHash: draft
        }
      })
    }
    return out
  }
}

/** 报价单文档哈希（宪法 §1.6 证据链）：只认已生成的 PDF 哈希，缺失即 null，不伪造 */
function documentHash(row: CrmRow): string | null {
  try {
    const raw = String(row.custom_fields || '{}')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const value = parsed.quote_pdf_sha256 ?? parsed.quote_pdf_hash
    return typeof value === 'string' && value.length >= 32 ? value : null
  } catch { return null }
}

const auditProjection: LocalProjection = {
  key: 'audit', entityType: 'audit_event',
  read(cursor, limit) {
    const rows = crmDbService.all("SELECT * FROM audit_event WHERE id > ? AND action NOT LIKE 'sync_%' ORDER BY id LIMIT ?", [cursor, clampLimit(limit)])
    return rows.map((row) => ({
      entityType: 'audit_event' as CentralEntityType, localRef: `audit:${num(row.id)}`, eventType: text(row.action) || 'audit',
      aggregateVersion: 0, eventSeq: num(row.id), occurredAt: num(row.created_at, Date.now()),
      payload: {
        sourceAuditId: String(num(row.id)),
        actor: text(row.actor),
        action: text(row.action),
        subjectType: nullableText(row.entity_type),
        subjectId: row.entity_id === null || row.entity_id === undefined ? null : String(row.entity_id),
        detailMasked: maskAuditDetail(text(row.detail)),
        occurredAt: num(row.created_at) || null
      }
    }))
  }
}

/** 审计 detail 过本机既有脱敏（lanSyncService.maskAuditText 同款口径；此处内联避免循环依赖） */
function maskAuditDetail(detail: string): string | null {
  const s = text(detail).trim()
  if (!s) return null
  return s
    .replace(/\b1[3-9]\d{9}\b/g, (m) => `${m.slice(0, 3)}****${m.slice(-2)}`)
    .replace(/("?(?:device[_-]?token|invite[_-]?code|password|api[_-]?key|secret)"?\s*[:=]\s*"?)[^",}\s]+/gi, '$1***')
}

const judgmentProjection: LocalProjection = {
  key: 'customer_judgment', entityType: 'customer_judgment',
  read(cursor, limit) {
    const refs = sessionCustomerRefs()
    const rows = salesDbService.judgmentSince(cursor, clampLimit(limit))
    const out: ProjectionDraft[] = []
    for (const row of rows) {
      const customerRef = refs.get(String(row.session_id))
      // session_id 属禁上传字段：只能通过既有 customer_profile→customer_id 归并映射成客户引用，
      // 映射不到的判断本机保留、不上行（绝不把 session_id 或哈希后的 session_id 送出去）
      if (!customerRef) continue
      out.push({
        entityType: 'customer_judgment', localRef: `judgment:${num(row.id)}`, eventType: 'judgment_projected',
        aggregateVersion: Math.max(1, num(row.id)), eventSeq: num(row.id), occurredAt: num(row.generated_at, num(row.created_at, Date.now())),
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
      })
    }
    return out
  }
}

/** session_id → 中央客户引用映射（只读既有 customer_profile 归并列，不新建映射表） */
function sessionCustomerRefs(): Map<string, string> {
  const map = new Map<string, string>()
  for (const profile of salesDbService.listCustomerProfileIds()) {
    const customerId = text(profile.customer_id).trim()
    if (!customerId) continue
    map.set(String(profile.session_id), `customer:${customerId}`)
  }
  return map
}

const knowledgeProposalProjection: LocalProjection = {
  key: 'knowledge_proposal', entityType: 'knowledge_proposal',
  read(cursor, limit) {
    const rows = salesDbService.kbSince(cursor, clampLimit(limit))
    return rows.map((row) => ({
      entityType: 'knowledge_proposal' as CentralEntityType, localRef: `kb:${num(row.id)}`, eventType: 'knowledge_proposal_projected',
      aggregateVersion: Math.max(1, num(row.version, 1)), eventSeq: num(row.id), occurredAt: num(row.updated_at, Date.now()),
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
    }))
  }
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
