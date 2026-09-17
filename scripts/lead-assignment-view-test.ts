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
  suggestReassignOwner, sla1Countdown, sla2StatusView, buildMyCards, type LeadOwnerInfo
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
  const mine: LeadOwnerInfo = { assignmentId: 11, salesName: '张三', status: 'assigned', ownerEmployeeId: '' }
  const mineClaimed: LeadOwnerInfo = { assignmentId: 11, salesName: '张三', status: 'claimed', ownerEmployeeId: '' }
  const others: LeadOwnerInfo = { assignmentId: 12, salesName: '李四', status: 'assigned', ownerEmployeeId: '' }
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
    1: { assignmentId: 11, salesName: '张三', status: 'assigned', ownerEmployeeId: '' },
    2: { assignmentId: 12, salesName: '李四', status: 'claimed', ownerEmployeeId: '' }
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

  console.log('\n═══ H. sla2StatusView 跟进状态投影（设计稿屏 5 右）═══')
  const nowMs = 1_800_000_000_000
  const c = sla2StatusView(JSON.stringify({ verdict: 'contacted', confidence: 1.0, scanRef: 'local:msg_0.db:9:1700000000:0:w:1', source: 'rule', at: nowMs, note: '规则命中：停表后客户有回复（事实判定）' }))
  check('H1 contacted → 绿「已有效触达」+ note 透传', c?.verdict === 'contacted' && c.pill === 'success' && c.label === '已有效触达' && c.note.includes('客户有回复'))
  check('H2 evidenceKey = scanRef（证据可回查锚点）', c?.evidenceKey === 'local:msg_0.db:9:1700000000:0:w:1')
  check('H3 at 时间透传', c?.at === nowMs)
  const n = sla2StatusView(JSON.stringify({ verdict: 'need_intervention', confidence: 0.8, scanRef: 'k2', source: 'llm', at: nowMs }))
  check('H4 need_intervention → 琥珀「需介入」', n?.pill === 'warning' && n.label === '需介入')
  const u = sla2StatusView(JSON.stringify({ verdict: 'uncertain', confidence: 0.3, scanRef: '', source: 'llm', at: nowMs }))
  check('H5 uncertain → 灰「低置信 · 转人工」+ 默认文案', u?.pill === 'neutral' && u.label === '低置信 · 转人工' && u.note.includes('人工'))
  check('H6 note 缺省回退 verdict 默认文案（contacted）', sla2StatusView(JSON.stringify({ verdict: 'contacted', scanRef: '', source: '', at: 0 }))?.note === '客户已回复')
  check('H7 空串/空/undefined → null（尚无结论）', sla2StatusView('') === null && sla2StatusView(null) === null && sla2StatusView(undefined) === null)
  check('H8 脏数据：非 JSON/未知 verdict/非对象 → null（宁缺毋滥）',
    sla2StatusView('not-json') === null && sla2StatusView(JSON.stringify({ verdict: 'weird', at: 1 })) === null && sla2StatusView(42) === null)

  // ── I. buildMyCards 销售资源卡三分段（2026-09-08 修复「已回收」永远为空）──────
  console.log('\n═══ I. buildMyCards 三分段（待跟进/跟进中按有效权属；已回收按最新分配行）═══')
  const NOW_T = 1_800_000_000_000
  const mkLead = (id: number, status: string) => ({ id, status })
  const mkLatest = (id: number, status: string, sales: string, extra: Record<string, unknown> = {}) => ({
    id: 1000 + id, lead_id: id, status, sales_name: sales, sla1_deadline: NOW_T + 3600_000,
    sla1_met_at: 0, sla1_remind_count: 0, sla2_scan_ref: '', created_at: NOW_T - 1000, updated_at: NOW_T - 1000, ...extra
  })
  const leadsI = [mkLead(1, 'NEW'), mkLead(2, 'WX_ADDED'), mkLead(3, 'NEW'), mkLead(4, 'NEW'), mkLead(5, 'NEW'), mkLead(6, 'NEW')]
  const latestAsgI: Record<number, Record<string, unknown>> = {
    1: mkLatest(1, 'assigned', '张三'),                          // 有效权属张三 + NEW → 待跟进
    2: mkLatest(2, 'claimed', '张三', { sla1_met_at: NOW_T }),   // 已停表 → 跟进中
    3: mkLatest(3, 'recycled', '张三'),                          // 最新行 recycled 归张三 → 已回收（旧实现看不到）
    4: mkLatest(4, 'recycled', '李四'),                          // 回收但原归属是李四 → 张三不可见
    5: mkLatest(5, 'transferred', '张三'),                       // 张三曾持有、已转出 → 不出现在张三任何分段
    6: mkLatest(6, 'assigned', '李四')                           // 他人线索 → 不可见
  }
  const ownerI = buildOwnerMap([
    { id: 1001, lead_id: 1, sales_name: '张三', status: 'assigned', sla1_met_at: 0 },
    { id: 1002, lead_id: 2, sales_name: '张三', status: 'claimed', sla1_met_at: NOW_T },
    { id: 1006, lead_id: 6, sales_name: '李四', status: 'assigned', sla1_met_at: 0 }
  ] as never)
  const cardsI = buildMyCards(leadsI, latestAsgI, ownerI, SALES, NOW_T)
  check('I1 待跟进 = 当前有效权属本人且 NEW（lead1）', cardsI.wait.length === 1 && cardsI.wait[0].lead.id === 1, JSON.stringify(cardsI.wait.map((c) => c.lead.id)))
  check('I2 跟进中 = 已停表/非 NEW（lead2）', cardsI.active.length === 1 && cardsI.active[0].lead.id === 2, JSON.stringify(cardsI.active.map((c) => c.lead.id)))
  check('I3 已回收 = 最新分配行 recycled 且 sales_name 本人（lead3；旧实现恒空已修复）',
    cardsI.recycled.length === 1 && cardsI.recycled[0].lead.id === 3 && cardsI.recycled[0].recycled === true,
    JSON.stringify(cardsI.recycled.map((c) => c.lead.id)))
  check('I4 他人名下的回收线索不进我的已回收（lead4 排除）', !cardsI.recycled.some((c) => c.lead.id === 4))
  check('I5 转派给他人的线索不出现在原销售当前资源（lead5 三段全排除）',
    !cardsI.wait.concat(cardsI.active, cardsI.recycled).some((c) => c.lead.id === 5))
  check('I6 他人有效权属线索不可见（lead6 排除）', !cardsI.wait.concat(cardsI.active, cardsI.recycled).some((c) => c.lead.id === 6))
  check('I7 三分段互斥且并集=本人可见集', cardsI.wait.length + cardsI.active.length + cardsI.recycled.length === 3)
  const cardsYi = buildMyCards(leadsI, latestAsgI, buildOwnerMap([
    { id: 1004, lead_id: 4, sales_name: '李四', status: 'assigned', sla1_met_at: 0 }
  ] as never), { name: '李四', role: '销售' }, NOW_T)
  check('I8 换身份视角：回收行归属谁，谁的销售才在自己的已回收分段看到它', (() => {
    // 李四视角（无任何有效权属）：把 lead4 的回收行归属改为李四 → 只出现在李四的已回收分段
    const l4 = { ...latestAsgI[4], sales_name: '李四' }
    const yi = buildMyCards(leadsI, { ...latestAsgI, 4: l4 }, {}, { name: '李四', role: '销售' }, NOW_T)
    return yi.recycled.map((c) => c.lead.id).includes(4) && yi.wait.length === 0 && yi.active.length === 0
  })())

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  if (fail > 0) process.exit(1)
}

main()
