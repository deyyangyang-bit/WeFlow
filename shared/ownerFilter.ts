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
}

/** 是否销售视角：角色=销售 且 已建档（有姓名）。未建档一律视为管理视角（看全部）。 */
export function isSalesView(identity: IdentityLike): boolean {
  return identity.role === '销售' && !!identity.name.trim()
}

/** owner 过滤档：销售视角只留本人/空归属行；管理视角原样返回（同一数组引用或过滤副本） */
export function filterByOwner<T extends { owner_sales?: string | null }>(rows: T[], identity: IdentityLike): T[] {
  if (!isSalesView(identity)) return rows
  const me = identity.name.trim()
  if (!me) return rows
  return rows.filter((r) => {
    const owner = String(r.owner_sales || '').trim()
    return !owner || owner === me
  })
}
