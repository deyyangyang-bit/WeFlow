/**
 * lead-assignment-view-test.ts —— 线索池 Phase 1 完整交互的纯判定函数测试
 * 覆盖 src/utils/leadAssignmentView.ts：
 *   A. buildOwnerMap 当前归属映射（最新有效行 / recycled 不算 / 乱序取大 id）
 *   B. isSalesView 销售视角判定（角色+已建档；空身份=管理视角）
 *   C. canClaimLead 认领按钮可见性（本人+assigned 才可见；claimed/他人/未建档不可见）
 *   D. canManageAssignment 调派/回收可见性（非销售可见；销售不可见；未归属不可见）
 *   E. filterLeadsForView 销售只见自己的（未分配不混入；管理视角全量）
 *   F. visibleOwnerChips 归属 chips（销售只留「我的」；管理视角全量含未分配计数）
 *
 * 纯函数直测，无需 DB / electron。用法：npx tsx scripts/lead-assignment-view-test.ts
 */
import {
  buildOwnerMap, isSalesView, canClaimLead, canManageAssignment,
  filterLeadsForView, visibleOwnerChips, leadPageView, distributePreview,
  suggestReassignOwner, sla1Countdown, type LeadOwnerInfo
} from '../src/utils/leadAssignmentView'

let pass = 0, fail = 0
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; console.log(`  ✅ ${name}`) } else { fail++; console.log(`  ❌ ${name} ${detail}`) }
}

const SALES = { name: '张三', role: '销售' }
const MANAGER = { name: '李主管', role: '主管' }
const EMPTY = { name: '', role: '' }

function main(): void {
  console.log('═══ A. buildOwnerMap 当前归属映射 ═══')
  const rows = [
    { id: 10, lead_id: 1, sales_name: '张三', status: 'assigned' as const },
    { id: 11, lead_id: 1, sales_name: '张三', status: 'claimed' as const },   // 更新，应为当前
    { id: 12, lead_id: 2, sales_name: '李四', status: 'recycled' as const },  // 已回收，不算归属
    { id: 13, lead_id: 3, sales_name: '王五', status: 'transferred' as const } // 已移交，不算归属
  ]
  const map = buildOwnerMap(rows)
  check('lead1 当前归属=张三/claimed/assignmentId=11', map[1]?.salesName === '张三' && map[1]?.status === 'claimed' && map[1]?.assignmentId === 11, JSON.stringify(map[1]))
  check('lead2 recycled 无归属', map[2] === undefined)
  check('lead3 transferred 无归属', map[3] === undefined)
  // 乱序防御：id 大者胜，不依赖返回顺序
  const messy = buildOwnerMap([
    { id: 21, lead_id: 5, sales_name: '李四', status: 'assigned' as const },
    { id: 20, lead_id: 5, sales_name: '张三', status: 'assigned' as const }
  ])
  check('乱序时取 id 最大行', messy[5]?.salesName === '李四' && messy[5]?.assignmentId === 21, JSON.stringify(messy[5]))

  console.log('\n═══ B. isSalesView 销售视角判定 ═══')
  check('销售+已建档 = 销售视角', isSalesView(SALES) === true)
  check('主管 = 管理视角', isSalesView(MANAGER) === false)
  check('分配员 = 管理视角', isSalesView({ name: '王分配', role: '分配员' }) === false)
  check('空身份 = 管理视角（未建档兜底）', isSalesView(EMPTY) === false)
  check('角色销售但姓名空 = 管理视角', isSalesView({ name: '', role: '销售' }) === false)
  check('姓名空格 = 管理视角', isSalesView({ name: '  ', role: '销售' }) === false)

  console.log('\n═══ C. canClaimLead 认领按钮可见性 ═══')
  const mine: LeadOwnerInfo = { assignmentId: 11, salesName: '张三', status: 'assigned' }
  const mineClaimed: LeadOwnerInfo = { assignmentId: 11, salesName: '张三', status: 'claimed' }
  const others: LeadOwnerInfo = { assignmentId: 12, salesName: '李四', status: 'assigned' }
  check('本人+assigned → 可见', canClaimLead(SALES, mine) === true)
  check('本人+claimed → 不可见（已认领）', canClaimLead(SALES, mineClaimed) === false)
  check('他人+assigned → 不可见', canClaimLead(SALES, others) === false)
  check('未归属 → 不可见', canClaimLead(SALES, undefined) === false)
  check('未建档 → 不可见（即使归属名恰好匹配不上空名）', canClaimLead(EMPTY, mine) === false)
  check('主管身份但归属名=主管名+assigned → 可见（判定只看姓名匹配）', canClaimLead({ name: '张三', role: '主管' }, mine) === true)

  console.log('\n═══ D. canManageAssignment 调派/回收可见性 ═══')
  check('主管+已归属 → 可见', canManageAssignment(MANAGER, mine) === true)
  check('分配员+已归属 → 可见', canManageAssignment({ name: '王分配', role: '分配员' }, mine) === true)
  check('空身份（管理视角兜底）+已归属 → 可见', canManageAssignment(EMPTY, mine) === true)
  check('销售+已归属 → 不可见（销售不能调派回收）', canManageAssignment(SALES, mine) === false)
  check('主管+未归属 → 不可见（无可操作分配行）', canManageAssignment(MANAGER, undefined) === false)
  check('claimed 态主管仍可见（已归属即可调派/回收）', canManageAssignment(MANAGER, mineClaimed) === true)

  console.log('\n═══ E. filterLeadsForView 销售视角过滤 ═══')
  const leads = [{ id: 1 }, { id: 2 }, { id: 3 }]
  const owners: Record<number, LeadOwnerInfo> = {
    1: { assignmentId: 11, salesName: '张三', status: 'assigned' },
    2: { assignmentId: 12, salesName: '李四', status: 'claimed' }
    // 3 未分配
  }
  const salesLeads = filterLeadsForView(leads, owners, SALES)
  check('销售只见自己的（id=1）', salesLeads.length === 1 && salesLeads[0].id === 1, JSON.stringify(salesLeads))
  check('未分配不混入销售视角', salesLeads.every((l) => l.id !== 3))
  const mgrLeads = filterLeadsForView(leads, owners, MANAGER)
  check('管理视角全量 3 条', mgrLeads.length === 3)
  check('空身份全量 3 条', filterLeadsForView(leads, owners, EMPTY).length === 3)

  console.log('\n═══ F. visibleOwnerChips 归属 chips ═══')
  const counts = { unassigned: 7, names: [{ value: '张三', count: 2 }, { value: '李四', count: 5 }] }
  const salesChips = visibleOwnerChips(SALES, counts)
  check('销售只留「我的」一个 chip', salesChips.length === 1 && salesChips[0].value === '我的', JSON.stringify(salesChips))
  check('「我的」计数=本人归属数', salesChips[0].count === 2)
  check('销售视角无未分配 chip', salesChips.every((c) => c.value !== '未分配'))
  const mgrChips = visibleOwnerChips(MANAGER, counts)
  check('管理视角 = 全部/未分配/各销售', mgrChips.length === 4 && mgrChips[0].value === '全部' && mgrChips[1].value === '未分配')
  check('未分配计数正确', mgrChips[1].count === 7)
  check('销售不在名单时「我的」计数=0', visibleOwnerChips({ name: '赵六', role: '销售' }, counts)[0].count === 0)

  console.log('\n═══ G. 三视角改版纯函数（设计稿屏 2/3/4/6）═══')
  check('G1 销售身份 → sales 视角', leadPageView(SALES) === 'sales')
  check('G2 主管/分配员/空身份 → manager 视角', leadPageView(MANAGER) === 'manager' && leadPageView(EMPTY) === 'manager' && leadPageView({ name: '王分配', role: '分配员' }) === 'manager')

  // distributePreview 三模式（12 条 / 3 人）
  const sales3 = ['李林辉', '杨青', '许丽娟']
  const wPlan = distributePreview('weight', 12, sales3, { 李林辉: 40, 杨青: 35, 许丽娟: 25 }, {})
  check('G3 权重模式 40/35/25 → 5/4/3（最大余数法）', wPlan['李林辉'] === 5 && wPlan['杨青'] === 4 && wPlan['许丽娟'] === 3, JSON.stringify(wPlan))
  const wSum = sales3.reduce((a, s) => a + (wPlan[s] || 0), 0)
  check('G4 权重模式总量守恒 = 12', wSum === 12)
  const wEq = distributePreview('weight', 10, sales3, {}, {})
  check('G5 缺省等权 → 4/3/3', wEq['李林辉'] === 4 && wEq['杨青'] === 3 && wEq['许丽娟'] === 3, JSON.stringify(wEq))
  const rr = distributePreview('round_robin', 8, sales3, {}, {})
  check('G6 轮询 8 条 → 3/3/2', rr['李林辉'] === 3 && rr['杨青'] === 3 && rr['许丽娟'] === 2, JSON.stringify(rr))
  const ld = distributePreview('load', 5, sales3, {}, { 李林辉: 21, 杨青: 18, 许丽娟: 13 })
  check('G7 负载均衡逐条给最少者（许 13→18→…）', ld['许丽娟'] === 5, JSON.stringify(ld))

  // suggestReassignOwner：在手最少且非原归属
  check('G8 建议改派 = 在手最少且非原归属', suggestReassignOwner('李林辉', sales3, { 李林辉: 21, 杨青: 18, 许丽娟: 13 }) === '许丽娟')
  check('G9 原归属被排除（防循环占位）', suggestReassignOwner('许丽娟', sales3, { 李林辉: 21, 杨青: 18, 许丽娟: 1 }) === '杨青')
  check('G10 名单只有原归属一人 → 空（提示手动选择）', suggestReassignOwner('李林辉', ['李林辉'], { 李林辉: 3 }) === '')

  // sla1Countdown 档位（屏 4 第 1-4 张卡）
  const now = 1_800_000_000_000
  const D = 24 * 3600_000
  const c1 = sla1Countdown({ status: 'assigned', sla1Deadline: now + 22 * 3600_000, sla1MetAt: 0, sla1RemindCount: 0 }, now)
  check('G11 待认领：wait_claim 档 + 认领引导文案 + 蓝 pill', c1.tier === 'wait_claim' && c1.label === '认领后 24h 内加好友' && c1.pill === 'info')
  const c2 = sla1Countdown({ status: 'claimed', sla1Deadline: now + 3 * 3600_000, sla1MetAt: 0, sla1RemindCount: 0 }, now)
  check('G12 已认领剩 3h：warn 档（<4h 临近超时）+ 琥珀 pill', c2.tier === 'warn' && c2.label === '加好友倒计时 · 临近超时' && c2.pill === 'warning')
  const c2b = sla1Countdown({ status: 'claimed', sla1Deadline: now + 20 * 3600_000, sla1MetAt: 0 }, now)
  check('G13 已认领剩 20h：ok 档', c2b.tier === 'ok')
  const c3 = sla1Countdown({ status: 'claimed', sla1Deadline: now - 3600_000, sla1MetAt: 0, sla1RemindCount: 2 }, now)
  check('G14 已超时：over 档 + 「第 2 次超时提醒」pill + 2/3 进度', c3.tier === 'over' && c3.pillText === '第 2 次超时提醒' && c3.label === '24h 复查中 · 2/3' && c3.pill === 'danger')
  const c4 = sla1Countdown({ status: 'claimed', sla1Deadline: now - D, sla1MetAt: now - 2 * D }, now)
  check('G15 已加好友：done 档 + 绿 pill + 进入第二段', c4.tier === 'done' && c4.pill === 'success' && c4.pillText === '已加好友 ✓')
  check('G16 倒计时格式 = 时:分:秒', c2.text.includes(':') && /^\d{1,2}:\d{2}:\d{2}$/.test(c2.text), c2.text)

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  if (fail > 0) process.exit(1)
}

main()
