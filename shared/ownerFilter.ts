/**
 * shared/ownerFilter.ts —— 展示层 owner 过滤档（§2.74 页面过滤档口径，2026-09-05 拍板）唯一语义源。
 *
 * 刀 5 起主进程（hermes 问数据模板查询）与前端页面共用本模块——「一处定义两处消费」，
 * 禁止第二套 owner 过滤语义。原实现位于 src/utils/leadAssignmentView.ts（前端入口保留 re-export）。
 *
 * 销售视角行可见 ⟺ owner_sales = 本人姓名 或 owner_sales 为空（空 = 未归属公共资源——
 * 销售自己聊出来新建档的客户 owner 为空，不能让自己看不见自己的新客户）。管理视角原样。
 * ⚠️ 展示层便利过滤，不是安全边界（宪法 §1.12：角色仅署名，不作访问控制依据；门禁靠机器部署形态 + 应用锁）。
 * 归属 SSOT（crmOwnershipService 头注释钦定）：account/opportunity/logistics 三表 owner_sales 列；
 * contract 无 owner_sales 列，经 account_id JOIN account.owner_sales 推导（crmDbService.workbench 已带出）。
 */

export interface IdentityLike {
  name: string
  role: string
  /**
   * 归属别名（2026-09-17）：与本地署名指**同一人**的其他姓名，目前仅一项——
   * 本设备绑定的中央身份 displayName（仅中央同步启用且持员工 id 时由 identityService 提供）。
   * 背景：下行 assign 落地的 assignment.sales_name = 中央目录显示名（发送侧口径），
   * 与本机署名可以不同；历史 assignment 只存姓名（宪法 §1.3），因此姓名仍是匹配面之一，
   * **不是** employeeId 替换姓名，也绝不把 displayName 当永久唯一标识——别名只在绑定期间
   * 生效，解绑随配置清空（identityService）。
   */
  nameAliases?: string[]
  /**
   * 本机绑定的中央员工 id（稳定 employeeId，仅中央同步启用时非空）。
   * 中央下行归属行带 owner_employee_id（指令声明的归属员工）时，核对以它为**权威**：
   * 同名员工（不同 employeeId）的行即使姓名完全一致也不算本人——显示名只是展示面，
   * 员工 id 才是跨机唯一标识；历史/本地/SMB 行未带该列，回退姓名集合（署名 ∪ 别名）。
   */
  employeeId?: string
}

/** 是否销售视角：角色=销售 且 已建档（有姓名）。未建档一律视为管理视角（看全部）。
 * ⚠️ 视角判定只用本地身份档案，中央绑定/中央角色声明不改变视角（宪法 §1.12：不因中央声明提权）。 */
export function isSalesView(identity: IdentityLike): boolean {
  return identity.role === '销售' && !!identity.name.trim()
}

/**
 * 某 owner 姓名是否指「本人」：本人署名或绑定别名（两侧 trim 后精确相等）。
 * 空署名 = 未建档，不匹配任何 owner（调用方按管理视角另行处理）。
 */
export function isOwnedName(identity: IdentityLike, owner: string | null | undefined): boolean {
  const me = String(identity.name || '').trim()
  const ownerName = String(owner || '').trim()
  if (!me || !ownerName) return false
  if (ownerName === me) return true
  const aliases = Array.isArray(identity.nameAliases) ? identity.nameAliases : []
  return aliases.some((a) => String(a || '').trim() === ownerName)
}

/** 归属行的核对入参：assignment 行的姓名 + 中央归属员工 id（owner_employee_id，可空） */
export interface OwnedLeadRef {
  salesName?: string | null
  ownerEmployeeId?: string | null
}

/**
 * 某条归属行是否指「本人」（销售视角可见性 / 认领共用的唯一核对口径）：
 *   - 行带 owner_employee_id（中央下行落地行）→ **employeeId 权威核对**：必须等于本机绑定的
 *     稳定员工 id；未绑定（无 employeeId）一律不算本人。姓名完全一致的两个同名员工
 *     （不同 employeeId）在此被区分——显示名不参与判定，杜绝同名串线；
 *   - 行未带（历史 / 本地创建 / SMB 行）→ 姓名集合回退（署名 ∪ 绑定别名）。
 * 这是「新落地的中央归属按 id、既有数据按姓名」的兼容口径；不改写任何存量行的归属。
 */
export function isOwnedLead(identity: IdentityLike, owner: OwnedLeadRef): boolean {
  const rowEmp = String(owner.ownerEmployeeId || '').trim()
  if (rowEmp) {
    const myEmp = String(identity.employeeId || '').trim()
    return !!myEmp && rowEmp === myEmp
  }
  return isOwnedName(identity, owner.salesName)
}

/** owner 过滤档：销售视角只留本人（含绑定别名）/空归属行；管理视角原样返回（同一数组引用或过滤副本） */
export function filterByOwner<T extends { owner_sales?: string | null }>(rows: T[], identity: IdentityLike): T[] {
  if (!isSalesView(identity)) return rows
  if (!identity.name.trim()) return rows
  return rows.filter((r) => {
    const owner = String(r.owner_sales || '').trim()
    return !owner || isOwnedName(identity, owner)
  })
}

/**
 * 到款「我的」过滤档：只返回本人已认领；未认领属于独立公共池，由页面显式展示，
 * 不能再混进「只看我的」。管理视角仍原样返回。
 */
export function filterPaymentsForView<T extends { sales_name?: string | null }>(rows: T[], identity: IdentityLike): T[] {
  if (!isSalesView(identity)) return rows
  if (!identity.name.trim()) return rows
  return rows.filter((p) => isOwnedName(identity, String(p.sales_name || '').trim()))
}

/**
 * owner 由调用方推导的过滤档：发票等无归属列的实体（invoice 只有 account_id/contract_id），
 * 页面经「直接挂客户 → 关联合同的客户」推导出 owner 姓名后走同一条可见规则；
 * 推导不了（无客户无合同）= 空 = 未归属公共池，销售可见、诚实保留（不做猜测归属）。
 * 核对仍走 isOwnedName，不新造第二套姓名匹配。
 */
export function filterByOwnerOf<T>(rows: T[], identity: IdentityLike, ownerOf: (row: T) => string | null | undefined): T[] {
  if (!isSalesView(identity)) return rows
  if (!identity.name.trim()) return rows
  return rows.filter((r) => {
    const owner = String(ownerOf(r) ?? '').trim()
    return !owner || isOwnedName(identity, owner)
  })
}
