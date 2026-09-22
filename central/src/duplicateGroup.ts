/**
 * duplicateGroup.ts —— 重复组成员合并与下行事件摘要（撞客一期 H7）
 *
 * PostgresCentralStore 与 MemoryCentralStore 共用的**唯一**实现，保证两套存储的
 * payload / eventId / idempotencyKey / aggregateVersion 语义一致：
 *   - 成员永久累积：新冲突到达时读取旧成员并按 customerRef 合并去重，不再整组重建
 *     （旧实现只用 holderRef+incomingRef 重建，第三成员会覆盖第二成员）；
 *   - ownerSales 用最新可得值更新，查不到 owner **不清空已有非空值**；
 *   - 稳定排序：按 customerRef 字典序，两套存储产出逐字节一致的 canonical 成员集；
 *   - 幂等键 / eventId / aggregateVersion 基于 canonical 成员内容摘要（sha256 前 16 hex）：
 *     成员数相同但成员内容变化也会产生新下行事件；成员内容不变则不重发。
 */
import { createHash } from 'node:crypto'

export interface DupMember {
  customerRef: string
  ownerSales: string
}

/** 成员合并：旧成员 ∪ 新成员，按 customerRef 去重 + 稳定排序；ownerSales 空值不清空非空旧值 */
export function mergeDuplicateGroupMembers(existing: DupMember[], incoming: DupMember[]): DupMember[] {
  const byRef = new Map<string, DupMember>()
  for (const m of existing) {
    if (!m || typeof m.customerRef !== 'string' || !m.customerRef) continue
    byRef.set(m.customerRef, { customerRef: m.customerRef, ownerSales: typeof m.ownerSales === 'string' ? m.ownerSales : '' })
  }
  for (const m of incoming) {
    if (!m || typeof m.customerRef !== 'string' || !m.customerRef) continue
    const prev = byRef.get(m.customerRef)
    const fresh = typeof m.ownerSales === 'string' ? m.ownerSales : ''
    byRef.set(m.customerRef, { customerRef: m.customerRef, ownerSales: fresh || prev?.ownerSales || '' })
  }
  return [...byRef.values()].sort((a, b) => (a.customerRef < b.customerRef ? -1 : a.customerRef > b.customerRef ? 1 : 0))
}

/** canonical 成员内容摘要（sha256 前 16 hex）：成员集合或 ownerSales 变化都会改变摘要；输入顺序无关（内部按 customerRef 排序） */
export function duplicateGroupDigest(members: DupMember[]): string {
  const canonical = JSON.stringify(
    [...members]
      .filter((m) => m && typeof m.customerRef === 'string')
      .sort((a, b) => (a.customerRef < b.customerRef ? -1 : a.customerRef > b.customerRef ? 1 : 0))
      .map((m) => ({ customerRef: m.customerRef, ownerSales: typeof m.ownerSales === 'string' ? m.ownerSales : '' }))
  )
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16)
}

/** 下行重复组事件的标识组（两套存储同构）；aggregateVersion 单调 = max(旧版本+1, 2) */
export function duplicateGroupEventIdentity(anchorType: string, anchorHash: string, digest: string, prevAggregateVersion: number): {
  eventId: string
  idempotencyKey: string
  aggregateVersion: number
} {
  return {
    eventId: `dupgroup-${anchorHash}-${digest}`,
    idempotencyKey: `dupgroup:${anchorType}:${anchorHash}:${digest}`,
    aggregateVersion: Math.max(prevAggregateVersion + 1, 2)
  }
}

/** 重复组实体键（与 003 迁移登记的 entity_id 同构） */
export function duplicateGroupGroupId(anchorType: string, anchorHash: string): string {
  return `dupgroup:${anchorType}:${anchorHash}`
}

/** advisory 锁键：以 (workspace, anchor) 为粒度串行化同组登记 */
export function duplicateGroupLockKey(workspaceId: string, anchorType: string, anchorHash: string): string {
  return [workspaceId, anchorType, anchorHash].join(':')
}

/** 下行 duplicate_group 广播载荷（宪法 §3.1：只含身份哈希/掩码/成员引用/归属销售，无聊天内容） */
export function buildDuplicateGroupDownPayload(input: {
  anchorType: string
  anchorHash: string
  anchorMasked: string
  members: DupMember[]
  deleted: boolean
  registeredByDeviceId: string
}): Record<string, unknown> {
  return {
    anchorType: input.anchorType,
    anchorHash: input.anchorHash,
    anchorMasked: input.anchorMasked,
    membersJson: JSON.stringify(input.members),
    memberCount: input.members.length,
    deleted: input.deleted,
    registeredBy: `device:${input.registeredByDeviceId}`
  }
}
