/**
 * crmOutboxService.ts —— local_outbox 外发事件登记（PRD §1.10，宪法 §1.11）
 *
 * 现阶段「只记录不发送」：业务写点在**同一事务**内登记 outbox_event
 * （event_seq 单调递增 / idempotency_key 唯一 / payload JSON / status='pending'），
 * 不写调度发送器、不做真实发送。崩溃语义按宪法 §1.11：sql.js 500ms 防抖落盘，
 * 崩溃丢失的 pending 行 = 事件未发生（只记录阶段无业务后果）。
 *
 * 事件清单与内网同步设计对齐（docs/规划/Phase1-内网同步最小版-设计.md §3）：
 *   下行（中枢权威）：assign / transfer / recycle
 *   上行（终端回执）：claim / bind_wx / first_touch（2026-09-04 补上首触写点）
 *   ⚠️ 上行 audit（审计行）不走 outbox——按 Q4 字段裁剪+脱敏后由 lanSyncService 游标
 *     （scan_state `syncUp:auditCursor`）逐条产出，不经过本表。
 * 实际落盘发送由 lanSyncService 承担（共享目录已配置时 pending → 事件 JSON 文件 → sent）。
 *
 * payload 内携带 type 字段 = 事件类型（表结构无 event_type 列，宪法 §1.11 字段定格不加列）。
 */
import { crmDbService, type CrmRow } from './crmDbService'

/** 事务句柄最小形状（与 crmDbService.runTx 的 tx 一致） */
export interface OutboxTx {
  run: (sql: string, params?: unknown[]) => number
  all: (sql: string, params?: unknown[]) => CrmRow[]
}

/** 业务写点事件类型（与同步设计 §3 事件清单一一对应；audit 走游标路径不经本表，故不在列） */
export type OutboxEventType = 'assign' | 'transfer' | 'recycle' | 'claim' | 'bind_wx' | 'first_touch'

/**
 * 在既有事务内登记一条 outbox 事件。
 * 幂等：idempotency_key 已存在 → 返回 false 零写入（唯一索引 idx_outbox_idem 兜底）；
 * 业务侧重放安全（宪法 §1.11「idempotency_key 保证业务侧可重放」）。
 * event_seq = 当前 MAX+1（同事务内读取，单调递增）。
 */
export function recordOutboxTx(
  tx: OutboxTx,
  eventType: OutboxEventType,
  idempotencyKey: string,
  payload: Record<string, unknown>,
  now = Date.now()
): boolean {
  const key = String(idempotencyKey || '').trim()
  if (!key) return false
  if (tx.all('SELECT id FROM outbox_event WHERE idempotency_key = ?', [key]).length) return false
  const seq = Number(tx.all('SELECT COALESCE(MAX(event_seq), 0) + 1 AS s FROM outbox_event')[0]?.s || 1)
  tx.run(
    "INSERT INTO outbox_event (event_seq, idempotency_key, payload, status, source, created_at, updated_at) VALUES (?,?,?,'pending',?,?,?)",
    [seq, key, JSON.stringify({ type: eventType, ...payload }), 'weflow-crm', now, now]
  )
  return true
}

/** 查询 pending 事件（排障/核对用；只读，Phase 3a 上行发送器的前置读取口） */
export function listPendingOutbox(limit = 100): CrmRow[] {
  return crmDbService.all(
    "SELECT * FROM outbox_event WHERE status = 'pending' ORDER BY event_seq LIMIT ?",
    [Math.max(1, Math.min(10000, Number(limit) || 100))]
  )
}
