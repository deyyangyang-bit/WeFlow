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
  /** 中央归属员工 id（owner_employee_id；中央下行落地行非空，历史/本地/SMB 行为空） */
  ownerEmployeeId: string
}

// 刀 5 起 IdentityLike/isSalesView/filterByOwner 迁 shared/ownerFilter.ts（主进程问数据模板与前端页面共用，
// 一处定义两处消费）；此处 re-export 保持既有 import 路径全部兼容（本模块内部调用走下面的值导入）。
// isOwnedName（2026-09-17）：归属匹配 = 本人署名 ∪ 绑定别名（中央 displayName），见 shared/ownerFilter。
// isOwnedLead（2026-09-17 同日修订）：行带 owner_employee_id 时以绑定 employeeId 权威核对（同名员工不串线）；
// 未带该列的行回退姓名集合。两口径见 shared/ownerFilter。
export { isSalesView, filterByOwner, isOwnedName, isOwnedLead, type IdentityLike } from '../../shared/ownerFilter'
import { isSalesView, filterByOwner, isOwnedName, isOwnedLead, type IdentityLike } from '../../shared/ownerFilter'

/**
 * 当前归属映射：leadId → 最新有效分配行。
 * assignmentList 返回按 id DESC，首个 assigned/claimed 命中即最新；为防乱序仍按 id 取大。
 */
export function buildOwnerMap(rows: Array<Pick<AssignmentRow, 'id' | 'lead_id' | 'sales_name' | 'status' | 'sla1_met_at'> & { owner_employee_id?: string | null }>): Record<number, LeadOwnerInfo> {
  const map: Record<number, LeadOwnerInfo> = {}
  for (const r of rows) {
    if (r.status !== 'assigned' && r.status !== 'claimed') continue
    const lid = Number(r.lead_id)
    const cur = map[lid]
    if (!cur || Number(r.id) > cur.assignmentId) {
      map[lid] = { assignmentId: Number(r.id), salesName: String(r.sales_name || ''), status: r.status, sla1MetAt: Number(r.sla1_met_at || 0), ownerEmployeeId: String((r as { owner_employee_id?: string | null }).owner_employee_id || '') }
    }
  }
  return map
}

/**
 * 认领按钮可见性：已建档 + 该 lead 当前归属 = 本人（shared/ownerFilter.isOwnedLead 唯一口径：
 * 行带 owner_employee_id → 绑定 employeeId 权威；未带 → 姓名集合 署名∪别名）+ assigned 态。
 * （后端 claimLead 调用同一共享函数；仅历史行另有「actor 姓名」兼容分支，中央行不适用。）
 * 未建档（姓名空）→ 永不可见；已 claimed 的不再出现（状态机也会拒）。
 */
export function canClaimLead(identity: IdentityLike, owner?: LeadOwnerInfo): boolean {
  if (!owner) return false
  return owner.status === 'assigned' && isOwnedLead(identity, owner)
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
  return isOwnedLead(identity, owner)
}

/**
 * 销售视角下的列表过滤：只保留当前归属 = 本人的线索（employeeId 权威 / 姓名集合回退，
 * 见 shared/ownerFilter.isOwnedLead）。未分配资源池对销售不可见（不混入）。管理视角返回原列表。
 */
export function filterLeadsForView<T extends { id: number }>(leads: T[], ownerByLead: Record<number, LeadOwnerInfo>, identity: IdentityLike): T[] {
  if (!isSalesView(identity)) return leads
  return leads.filter((l) => isOwnedLead(identity, ownerByLead[l.id] ?? {}))
}

/**
 * 归属筛选 chips 可见集合。
 * 管理视角：全部归属 / 未分配 / 各销售名；销售视角：只留「我的」（未分配 chip 不渲染）。
 * 可选第三参 owners（leadId → 行核对入参）：提供时「我的」计数按 isOwnedLead 精确统计
 * （含 employeeId 权威行，即使其 salesName 不在姓名集合内）；缺省退回姓名集合计数（既有调用方兼容）。
 */
export function visibleOwnerChips(
  identity: IdentityLike,
  counts: { unassigned: number; names: Array<{ value: string; count: number }> },
  owners?: Record<number, { salesName?: string | null; ownerEmployeeId?: string | null }>
): Array<{ value: string; label: string; count?: number }> {
  if (isSalesView(identity)) {
    if (owners) {
      const mine = Object.values(owners).reduce((sum, o) => (isOwnedLead(identity, o) ? sum + 1 : sum), 0)
      return [{ value: '我的', label: '我的', count: mine }]
    }
    // 「我的」计数 = 全部归属名里指本人的计数之和（署名 + 绑定别名；同名不重复计，别名==署名时去重）
    const seen = new Set<string>([identity.name.trim(), ...(identity.nameAliases || []).map((a) => String(a || '').trim())].filter(Boolean))
    const mine = counts.names.reduce((sum, n) => (seen.has(String(n.value || '').trim()) ? sum + Number(n.count || 0) : sum), 0)
    return [{ value: '我的', label: '我的', count: mine }]
  }
  return [
    { value: '全部', label: '全部归属' },
    { value: '未分配', label: '未分配', count: counts.unassigned },
    ...counts.names.map((n) => ({ value: n.value, label: n.value, count: n.count }))
  ]
}

// ─── 三视角改版（设计稿屏 2/3/4/6，2026-09-05）：以下均为纯判定/纯计算函数 ──

/** 线索页视角形态：销售 = 我的资源卡（屏 4）；其余（分配员/主管/空身份）= 管理三页签（屏 2/3/6左） */
export type LeadPageView = 'sales' | 'manager'
export function leadPageView(identity: IdentityLike): LeadPageView {
  return isSalesView(identity) ? 'sales' : 'manager'
}

/** 管理视角三个分段页签（屏 2 资源池 / 屏 3 分配控制台 / 屏 6 左 回收改派） */
export type ManagerTab = 'pool' | 'console' | 'reassign'

/** 分配模式（设计稿屏 3 三模式，weight 为默认） */
export type AssignMode = 'weight' | 'round_robin' | 'load'

/**
 * 份额分配预览（屏 3 右卡，纯前端预览；与后端 assignBatchLeads.buildDistribution 同口径——
 * 由 scripts/assignment-full-test.ts H 节断言两实现逐模式一致，防口径漂移）：
 *   weight：最大余数法（缺省等权）；round_robin：轮询均分；load：逐条给「在手+本批已得」最少者。
 */
export function distributePreview(mode: AssignMode, count: number, sales: string[], weights: Record<string, number>, loads: Record<string, number>): Record<string, number> {
  const plan: Record<string, number> = {}
  for (const s of sales) plan[s] = 0
  if (count <= 0 || !sales.length) return plan
  if (mode === 'weight') {
    const w = sales.map((s) => Math.max(0, Number(weights[s] ?? 0)))
    const totalW = w.reduce((a, b) => a + b, 0)
    const eff = totalW > 0 ? w : sales.map(() => 1)
    const effTotal = eff.reduce((a, b) => a + b, 0)
    const remainders = sales.map((s, i) => {
      const exact = (count * eff[i]) / effTotal
      return { s, base: Math.floor(exact), frac: exact - Math.floor(exact) }
    })
    let used = remainders.reduce((a, r) => a + r.base, 0)
    remainders.sort((a, b) => b.frac - a.frac)
    let ri = 0
    while (used < count && remainders.length) { remainders[ri % remainders.length].base++; used++; ri++ }
    for (const r of remainders) plan[r.s] = r.base
  } else if (mode === 'round_robin') {
    for (let i = 0; i < count; i++) plan[sales[i % sales.length]]++
  } else {
    const cur: Record<string, number> = {}
    for (const s of sales) cur[s] = Number(loads[s] || 0)
    for (let i = 0; i < count; i++) {
      const s = sales.reduce((min, x) => (cur[x] < cur[min] ? x : min), sales[0])
      plan[s]++
      cur[s]++
    }
  }
  return plan
}

/**
 * 回收改派建议人（屏 6 左）：在手最少且非原归属；全同名时回 ''（前端提示手动选择）。
 * recycledRow 原归属 = 原分配行 sales_name。
 */
export function suggestReassignOwner(fromSales: string, sales: string[], loads: Record<string, number>): string {
  const cands = sales.filter((s) => s && s !== fromSales)
  if (!cands.length) return ''
  return cands.reduce((min, x) => (Number(loads[x] || 0) < Number(loads[min] || 0) ? x : min), cands[0])
}

export type Sla1Tier = 'wait_claim' | 'ok' | 'warn' | 'over' | 'done'

export interface Sla1Countdown {
  tier: Sla1Tier
  /** 倒计时文案（num 列展示）：待认领=剩余认领时间；claimed=加好友剩余；超时='已超时'；已加好友='—' */
  text: string
  /** 说明行（l 列）：如「认领后 24h 内加好友」「加好友倒计时 · 临近超时」「24h 复查中 · 2/3」 */
  label: string
  /** 剩余毫秒（负=已超时；已停表为 0） */
  remainMs: number
  /** 已超时提醒次数（0=未提醒过；用于「第 N 次提醒」pill 与 N/3 进度） */
  remindCount: number
  /** 状态 pill 语义（pill 五语义） */
  pill: 'info' | 'success' | 'warning' | 'danger' | 'neutral'
  pillText: string
}

const SLA1_WARN_MS = 4 * 3600_000

function fmtRemain(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const p = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${p(m)}:${p(sec)}` : `${p(m)}:${p(sec)}`
}

/**
 * 屏 4 资源卡倒计时档位（第一段 SLA，纯函数；now 注入便于测试）：
 *   assigned（未认领）→ wait_claim：认领引导（剩余认领时间，蓝 pill「待认领」）；
 *   claimed 未停表：剩余 >4h → ok；≤4h → warn（琥珀「临近超时」）；已过 → over（红「第 N 次超时提醒」）；
 *   已停表（sla1MetAt 非空）→ done（绿「已加好友 ✓」，进入第二段）。
 */
export function sla1Countdown(a: { status: string; sla1Deadline: number; sla1MetAt: number; sla1RemindCount?: number }, now: number): Sla1Countdown {
  const remindCount = Math.max(0, Math.floor(Number(a.sla1RemindCount || 0)))
  const deadline = Number(a.sla1Deadline || 0)
  if (Number(a.sla1MetAt || 0) > 0) {
    return { tier: 'done', text: '—', label: '进入第二段「聊了没有」', remainMs: 0, remindCount, pill: 'success', pillText: '已加好友 ✓' }
  }
  const remainMs = deadline - now
  if (String(a.status) === 'claimed') {
    if (remainMs > 0) {
      const warn = remainMs <= SLA1_WARN_MS
      return {
        tier: warn ? 'warn' : 'ok',
        text: fmtRemain(remainMs),
        label: warn ? '加好友倒计时 · 临近超时' : '加好友倒计时',
        remainMs, remindCount,
        pill: warn ? 'warning' : 'info',
        pillText: '已认领·未加好友'
      }
    }
    return {
      tier: 'over', text: '已超时',
      label: `24h 复查中 · ${Math.min(remindCount, 3)}/3`,
      remainMs, remindCount,
      pill: 'danger', pillText: remindCount > 0 ? `第 ${remindCount} 次超时提醒` : '已超时·待提醒'
    }
  }
  // assigned（待认领）
  if (remainMs > 0) {
    return { tier: 'wait_claim', text: fmtRemain(remainMs), label: '认领后 24h 内加好友', remainMs, remindCount, pill: 'info', pillText: '待认领' }
  }
  return { tier: 'over', text: '已超时', label: `24h 复查中 · ${Math.min(remindCount, 3)}/3`, remainMs, remindCount, pill: 'danger', pillText: remindCount > 0 ? `第 ${remindCount} 次超时提醒` : '已超时·待提醒' }
}

/**
 * 屏 5 右卡「跟进状态」（第二段 SLA「聊了没有」，LLM/规则/人工三路结论的展示投影）：
 * 读 assignment.sla2_scan_ref JSON 串（{ verdict, confidence, scanRef, source, at, note? }，
 * 写入口径 crmSla2Service.markSla2ScanResult；'' = 尚无结论）。
 * 纯函数，脏数据/空串/未知 verdict 一律回 null（宁缺毋滥不瞎判，与后端 parseSla2ScanRef 同哲学）。
 * pill 语义（设计稿）：contacted=绿「已有效触达」/ need_intervention=琥珀「需介入」/ uncertain=灰「低置信 · 转人工」。
 */
export interface Sla2StatusView {
  verdict: 'contacted' | 'need_intervention' | 'uncertain'
  /** pill 五语义 */
  pill: 'success' | 'warning' | 'neutral'
  label: string
  /** 结论摘要（note 优先，缺省按 verdict 给默认文案） */
  note: string
  /** 结论落定时刻（ms） */
  at: number
  /** 证据锚点（客户原话 messageKey，宪法 §1.10 可回查） */
  evidenceKey: string
}

export function sla2StatusView(raw: unknown): Sla2StatusView | null {
  if (raw === null || raw === undefined || raw === '') return null
  let j: any = raw
  if (typeof raw === 'string') {
    try { j = JSON.parse(raw) } catch { return null }
  }
  if (!j || typeof j !== 'object') return null
  const verdict = String(j.verdict || '')
  if (!['contacted', 'need_intervention', 'uncertain'].includes(verdict)) return null
  const meta: Record<string, { pill: Sla2StatusView['pill']; label: string; fallback: string }> = {
    contacted: { pill: 'success', label: '已有效触达', fallback: '客户已回复' },
    need_intervention: { pill: 'warning', label: '需介入', fallback: '需要人工尽快跟进' },
    uncertain: { pill: 'neutral', label: '低置信 · 转人工', fallback: 'AI 不判断，请人工看一眼再定状态' }
  }
  const m = meta[verdict]
  const note = String(j.note || '').trim() || m.fallback
  return {
    verdict: verdict as Sla2StatusView['verdict'],
    pill: m.pill,
    label: m.label,
    note,
    at: Number(j.at || 0),
    evidenceKey: String(j.scanRef || '')
  }
}

// ─── 屏 4 销售资源卡三分段（2026-09-08 修复「已回收」永远为空）─────────────────
/** 单张资源卡（与 CrmLeadPage 渲染字段对齐；T = LeadRow 等任意 lead 行） */
export interface MyLeadCard<T> {
  lead: T
  cd: Sla1Countdown
  recycled: boolean
  sla2: Sla2StatusView | null
  assignedAt: number
}
export interface MyCardsResult<T> { wait: Array<MyLeadCard<T>>; active: Array<MyLeadCard<T>>; recycled: Array<MyLeadCard<T>> }

/**
 * 销售资源卡三分段（纯函数，now 注入便于测试）：
 *   - 待跟进 / 跟进中：按**当前有效权属**（ownerByLead，宪法 §1.3 最新有效分配行）过滤，
 *     归属本人且最新分配行不是 recycled——转派给他人的线索（latest=transferred、有效权属已易主）
 *     自然不再出现在原销售的当前资源中；
 *   - 已回收：按**最新分配行**（含 recycled/transferred）的 sales_name + recycled 状态过滤——
 *     回收行的 status 已不在 ownerByLead（有效权属）集合里，旧实现只用 ownerByLead 构建集合，
 *     导致「已回收」分段永远为空（2026-09-08 修复根因）；只显示本人曾持有且最新记录属于自己的回收线索。
 */
export function buildMyCards<T extends { id: number; status: string }>(
  leads: T[],
  latestAsg: Record<number, Record<string, unknown>>,
  ownerByLead: Record<number, LeadOwnerInfo>,
  identity: IdentityLike,
  now: number
): MyCardsResult<T> {
  const wait: Array<MyLeadCard<T>> = []
  const active: Array<MyLeadCard<T>> = []
  const recycled: Array<MyLeadCard<T>> = []
  for (const l of leads) {
    const latest = latestAsg[l.id]
    const own = ownerByLead[l.id]
    const latestStatus = String(latest?.status || '')
    const latestSales = String(latest?.sales_name || '')
    const isRecycled = latestStatus === 'recycled'
    // 「本人」核对：行带 owner_employee_id 时按绑定 employeeId 权威判定（同名员工不串线），
    // 未带该列的行回退姓名集合（署名或绑定别名）——shared/ownerFilter.isOwnedLead 唯一口径
    const mine = isRecycled
      ? isOwnedLead(identity, { salesName: latestSales, ownerEmployeeId: String(latest?.owner_employee_id || '') })
      : isOwnedLead(identity, own ?? {})
    if (!mine) continue
    const cd = sla1Countdown({
      status: String(own?.status || latestStatus || ''),
      sla1Deadline: Number(latest?.sla1_deadline || 0),
      sla1MetAt: Number(latest?.sla1_met_at || 0),
      sla1RemindCount: Number(latest?.sla1_remind_count || 0)
    }, now)
    const card: MyLeadCard<T> = {
      lead: l, cd, recycled: isRecycled,
      sla2: sla2StatusView(latest?.sla2_scan_ref),
      assignedAt: Number(latest?.updated_at || latest?.created_at || 0)
    }
    if (isRecycled) { recycled.push(card); continue }
    if (card.cd.tier !== 'done' && l.status === 'NEW') wait.push(card)
    else active.push(card)
  }
  return { wait, active, recycled }
}

/**
 * 页面过滤档 filterByOwner / isSalesView：语义源已迁 shared/ownerFilter.ts（本文件 re-export，上方）。
 * 契约不变：销售视角 = owner_sales 本人（含绑定别名）或空；管理视角原样；展示层便利过滤非安全边界（宪法 §1.12）。
 */

/** identity:get 回包 → 过滤档 IdentityLike：nameAliases 缺省 []、employeeId 缺省 ''（防御旧回包/异常路径），别名逐项 String + 去空 */
export function identityLikeFromIpc(p: { name?: string; role?: string; nameAliases?: string[]; employeeId?: string } | null | undefined): IdentityLike {
  return {
    name: String(p?.name || ''),
    role: String(p?.role || ''),
    nameAliases: Array.isArray(p?.nameAliases) ? p.nameAliases.map((a) => String(a || '')).filter(Boolean) : [],
    employeeId: String(p?.employeeId || '')
  }
}
