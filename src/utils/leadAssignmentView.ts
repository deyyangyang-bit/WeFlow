/**
 * leadAssignmentView.ts —— 线索池分配交互的纯判定函数（Phase 1 完整交互）
 * 归属唯一事实源 = assignment 表（宪法 §1.3）；本模块只做「行该显示哪些按钮 / 该看哪些线索」的判定。
 *
 * ⚠️ 展示层便利过滤，不是安全边界（宪法 §1.12：角色仅署名用途，不作访问控制依据；
 *    门禁靠机器部署形态 + 应用锁）。销售视角的过滤只是让销售少看无关数据，
 *    绝不作为权限控制来依赖。
 */
import type { AssignmentRow } from '../types/electron'

/** 某 lead 的当前有效归属（assigned/claimed 态的最新一条分配行） */
export interface LeadOwnerInfo {
  assignmentId: number
  salesName: string
  status: 'assigned' | 'claimed'
  /** SLA1 停表时刻（PRD 1.4a：加好友命中后非空；0/null=计时中） */
  sla1MetAt: number
}

export interface IdentityLike {
  name: string
  role: string
}

/**
 * 当前归属映射：leadId → 最新有效分配行。
 * assignmentList 返回按 id DESC，首个 assigned/claimed 命中即最新；为防乱序仍按 id 取大。
 */
export function buildOwnerMap(rows: Array<Pick<AssignmentRow, 'id' | 'lead_id' | 'sales_name' | 'status' | 'sla1_met_at'>>): Record<number, LeadOwnerInfo> {
  const map: Record<number, LeadOwnerInfo> = {}
  for (const r of rows) {
    if (r.status !== 'assigned' && r.status !== 'claimed') continue
    const lid = Number(r.lead_id)
    const cur = map[lid]
    if (!cur || Number(r.id) > cur.assignmentId) {
      map[lid] = { assignmentId: Number(r.id), salesName: String(r.sales_name || ''), status: r.status, sla1MetAt: Number(r.sla1_met_at || 0) }
    }
  }
  return map
}

/** 是否销售视角：角色=销售 且 已建档（有姓名）。未建档一律视为管理视角（看全部）。 */
export function isSalesView(identity: IdentityLike): boolean {
  return identity.role === '销售' && !!identity.name.trim()
}

/**
 * 认领按钮可见性：已建档 + 该 lead 当前归属销售 = 本人姓名 + 分配处于 assigned 态。
 * （后端 claim 的「本人」判定 = actor 姓名或身份档案姓名 === sales_name，前端同名口径提前隐藏。）
 * 未建档（姓名空）→ 永不可见；已 claimed 的不再出现（状态机也会拒）。
 */
export function canClaimLead(identity: IdentityLike, owner?: LeadOwnerInfo): boolean {
  const name = identity.name.trim()
  if (!name || !owner) return false
  return owner.status === 'assigned' && owner.salesName === name
}

/**
 * 调派/回收按钮可见性：该 lead 已归属（assigned/claimed）+ 身份角色 ≠ 销售。
 * 销售不能自己调派回收；空角色（未选角色但已建档/未建档）= 管理视角，可见。
 */
export function canManageAssignment(identity: IdentityLike, owner?: LeadOwnerInfo): boolean {
  if (!owner) return false
  return identity.role !== '销售'
}

/**
 * 「绑定微信」按钮可见性（PRD 1.4a 手动路）：该 lead 已归属（assigned/claimed）+
 * 销售视角仅本人归属行可见；管理视角（角色≠销售/未建档）任意已归属行可见。
 * 已停表（sla1MetAt 非空）仍可见——再点走后端幂等短路，提示「已绑定」不重复写。
 */
export function canBindWxid(identity: IdentityLike, owner?: LeadOwnerInfo): boolean {
  if (!owner) return false
  if (!isSalesView(identity)) return true
  return owner.salesName === identity.name.trim()
}

/**
 * 销售视角下的列表过滤：只保留当前归属 = 本人姓名的线索。
 * 未分配资源池对销售不可见（不混入）。管理视角返回原列表。
 */
export function filterLeadsForView<T extends { id: number }>(leads: T[], ownerByLead: Record<number, LeadOwnerInfo>, identity: IdentityLike): T[] {
  if (!isSalesView(identity)) return leads
  const name = identity.name.trim()
  return leads.filter((l) => ownerByLead[l.id]?.salesName === name)
}

/**
 * 归属筛选 chips 可见集合。
 * 管理视角：全部归属 / 未分配 / 各销售名；销售视角：只留「我的」（未分配 chip 不渲染）。
 */
export function visibleOwnerChips(
  identity: IdentityLike,
  counts: { unassigned: number; names: Array<{ value: string; count: number }> }
): Array<{ value: string; label: string; count?: number }> {
  if (isSalesView(identity)) {
    const name = identity.name.trim()
    const mine = counts.names.find((n) => n.value === name)?.count ?? 0
    return [{ value: '我的', label: '我的', count: mine }]
  }
  return [
    { value: '全部', label: '全部归属' },
    { value: '未分配', label: '未分配', count: counts.unassigned },
    ...counts.names.map((n) => ({ value: n.value, label: n.value, count: n.count }))
  ]
}
