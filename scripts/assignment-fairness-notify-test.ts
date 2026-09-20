/**
 * assignment-fairness-notify-test.ts —— round_robin 跨批次公平游标 + 分配数据失效通知 验证（2026-09-20）
 *
 * 覆盖：
 *   R. round_robin 跨批次公平游标：
 *      R0 共享纯函数（roundRobinStartIndex / roundRobinPlan / rotateSalesFrom）
 *      R1 三人连续 count=5 批次额外份额轮转（不再永远给名单前部）
 *      R2 长期累计差值在轮询算法应有范围内（9 批 × 5 条 = 15/15/15）
 *      R3 count 小于销售人数时下一批从未轮到的人继续
 *      R4 weight/load 行为不变；manual/非轮询模式不影响游标
 *      R5 名单新增/删除/重排/游标成员不存在/脏游标 → 安全自愈，分配不失败
 *      R6 空池 → 游标不推进（E301）；「整批全部跳过」的不可达性说明见 R6 注释
 *      R7 前端 distributePreview 与后端实际 perSales 逐批一致（同游标同源函数）
 *      R8 游标持久化（config 落盘可读回；重启延续 = 每批从 config 现读，无模块内存态）
 *      R9 round_robin 成功驱动逐条状态机（DI 夹具，2026-09-20 二轮修复）：记录每次尝试的销售序列，
 *         断言失败后同一销售重试、成功才切换下一位、游标 = 批末真实指针；覆盖首条失败/中间失败/
 *         末条失败/全部失败/E201·E301 混合/非零起点/跨批累计公平（9 次成功甲3乙3丙3）/
 *         weight·load 分组执行不变；夹具 'ok' 走真实 assignLeads 落库
 *      R10 游标写盘失败降级（2026-09-20 修复）：定向 monkey-patch ConfigService.set('crmRoundRobinCursor')
 *         抛错 → 仍 ok:true、assignment 落库、批次审计落地、游标保持旧值、无重复分配、weight 不受影响
 *   N. 分配数据失效通知：
 *      N1 assign/claim/recycle/transfer 均产生正确的最小失效载荷
 *      N2 失败/冲突/跳过不发事件（只在事务成功提交后通知）
 *      N3 批量分配 N 次写合并为一条事件（合并总线）
 *      N4 LAN/中央下行 assign/transfer(remove/apply)/recycle 触发通知；幂等重放/conflict/noop 不触发
 *      N5 SLA 自动回收触发通知
 *      N6 监听器清理函数有效，不泄漏
 *      N7 载荷最小化（仅 action/leadIds/at，无敏感字段）+ preload/类型/零依赖静态守卫
 *      N8 固定窗口合并（2026-09-20 修复）：持续高频 emit（间隔 < 窗口）下仍有界延迟定期 flush，
 *         窗口内 leadIds/action 正确合并，flush 后下一窗口正常启动，清理函数有效（真实计时器）
 *      N9 页面合并调度器 coalescedScheduler（2026-09-20 新增）：固定窗口有界延迟 + dispose +
 *         重挂载等价（真实计时器）
 *
 * 隔离：WEFLOW_WORKER='1' + WEFLOW_USER_DATA_PATH / WEFLOW_CONFIG_CWD 指向 /tmp；
 *       crmDb/salesDb 用 fresh 空库，绝不碰 live 库与真实配置。
 * 运行：npx tsx scripts/assignment-fairness-notify-test.ts
 */
import { mkdtempSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const isoDir = mkdtempSync(join(tmpdir(), 'assignment-fairness-notify-'))
process.env.WEFLOW_WORKER = '1'
process.env.WEFLOW_USER_DATA_PATH = isoDir
process.env.WEFLOW_CONFIG_CWD = isoDir

let pass = 0, fail = 0
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; console.log(`  ✅ ${name}`) } else { fail++; console.log(`  ❌ ${name} ${detail}`) }
}

import { ConfigService } from '../electron/services/config'
import { crmDbService } from '../electron/services/crmDbService'
import { salesDbService } from '../electron/services/salesDbService'
import {
  assignLeads, claimLead, recycleAssignment, transferAssignment, assignBatchLeads, assignBatchLeadsWith,
  buildDistribution, runSla1Recycle, getRoundRobinCursor, type AssignResult
} from '../electron/services/crmAssignmentService'
import { applyDownEventDirect } from '../electron/services/lanSyncService'
import {
  emitAssignmentInvalidated, onAssignmentInvalidated,
  flushAssignmentInvalidationForTest, resetAssignmentInvalidationForTest,
  type AssignmentInvalidationEvent
} from '../electron/services/assignmentInvalidationBus'
import { distributePreview } from '../src/utils/leadAssignmentView'
import { createCoalescedScheduler } from '../src/utils/coalescedScheduler'
import { roundRobinStartIndex, roundRobinPlan, rotateSalesFrom } from '../shared/leadRoundRobin'
import { LEAD_SLA_UNASSIGNED_SENTINEL } from '../shared/leadSla'

const S_A = '轮询销售甲'
const S_B = '轮询销售乙'
const S_C = '轮询销售丙'
let sales: string[] = [S_A, S_B, S_C]

let leadSeq = 0
function seedLead(): number {
  const now = Date.now()
  leadSeq++
  return crmDbService.runTx((tx) => tx.run(
    'INSERT INTO lead (contact_type, contact_normalized, contact_raw, wechat, source, name, status, first_contact_deadline, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    ['phone', `139${String(leadSeq).padStart(8, '0')}${String(Math.floor(Math.random() * 90 + 10))}`, `游标线索${leadSeq}`, '', '测试', `游标线索${leadSeq}`, 'NEW', LEAD_SLA_UNASSIGNED_SENTINEL, now, now]
  ))
}
function seedLeads(n: number): number[] {
  return Array.from({ length: n }, () => seedLead())
}
function setCursor(v: string): void {
  ConfigService.getInstance().set('crmRoundRobinCursor', v)
}
function cursor(): string {
  return String(ConfigService.getInstance().get('crmRoundRobinCursor') || '')
}
/** 收集失效事件的小夹具（每次先 reset 清空监听与待发，避免跨用例串扰） */
function makeCollector(): { events: AssignmentInvalidationEvent[]; off: () => void } {
  resetAssignmentInvalidationForTest()
  const events: AssignmentInvalidationEvent[] = []
  const off = onAssignmentInvalidated((e) => events.push(e))
  return { events, off }
}

const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms))

type FakeOutcome = 'ok' | 'fail' | 'E201' | 'E301'
/**
 * 部分失败夹具（R9）：按脚本逐条决定单条分配结果。'ok' 委托**真实 assignLeads**（成功 = 真实
 * 落库，assigned/perSales 断言有 DB 背书）；'fail'/'E201'/'E301' 返回预设失败/跳过信封（不触库）。
 * **记录每次调用实际收到的 salesName 序列**（attemptedSales）——据此断言成功驱动状态机的
 * 「失败后同一销售重试、成功才切换下一位」，不能只看最终游标。
 * 注入点只替换「单条执行」——轮询指针推进、游标落盘、批次审计全部走生产代码，不存在第二套轮询算法。
 * 失败线索不落库 → 会留在待分配池，每个用例结束必须 drainPool() 清场。
 */
function fakeAssigner(script: FakeOutcome[]) {
  let i = 0
  const attemptedSales: string[] = []
  const run = (leadId: number, salesName: string, actor: string, mode: unknown): AssignResult => {
    attemptedSales.push(salesName)
    const o = script[i++] ?? 'fail'
    if (o === 'ok') return assignLeads([leadId], salesName, actor, mode)
    if (o === 'E201') return { ok: true, data: { assignments: [], skipped: [{ leadId, code: 'E201', reason: '夹具模拟：已有有效分配' }] } }
    if (o === 'E301') return { ok: false, code: 'E301', message: '夹具模拟：线索不存在' }
    return { ok: false, code: 'E999', message: '夹具模拟：单条分配失败' }
  }
  return { run, attemptedSales }
}
/** 清空待分配池（真实 weight 批次，不触碰 round_robin 游标），隔离 R9 各用例的池映射 */
function drainPool(): void {
  const r = assignBatchLeads({ count: 9999, mode: 'weight', actor: '夹具清池' })
  if (!r.ok && r.code !== 'E301') throw new Error(`drainPool 失败: ${r.code} ${r.message}`)
}
function batchAuditCount(): number {
  return Number(crmDbService.all("SELECT COUNT(*) AS c FROM audit_event WHERE action = 'lead_assign_batch'")[0]?.c || 0)
}

async function main(): Promise<void> {
  const cfg = ConfigService.getInstance()
  cfg.set('crmSalesList', sales)
  cfg.set('crmLeadSlaHours', 24)
  const dbDir = mkdtempSync(join(tmpdir(), 'assignment-fairness-notify-db-'))
  await crmDbService.initialize(dbDir)
  await salesDbService.initialize(dbDir)

  console.log('═══ R0. 共享纯函数：roundRobinStartIndex / roundRobinPlan / rotateSalesFrom ═══')
  ok('R0.1 起点下标解析：命中返回下标；未命中/空串/脏值安全重置 0',
    roundRobinStartIndex(sales, S_C) === 2 && roundRobinStartIndex(sales, '不存在') === 0 && roundRobinStartIndex(sales, '') === 0,
    `${roundRobinStartIndex(sales, S_C)}/${roundRobinStartIndex(sales, '不存在')}/${roundRobinStartIndex(sales, '')}`)
  ok('R0.2 roundRobinPlan 从起点循环计数（5 条/3 人/起点 2）→ 丙2 甲2 乙1',
    JSON.stringify(roundRobinPlan(5, sales, 2)) === JSON.stringify({ [S_A]: 2, [S_B]: 1, [S_C]: 2 }),
    JSON.stringify(roundRobinPlan(5, sales, 2)))
  ok('R0.3 起点越界/负数按模归一；count<=0 返回全 0',
    JSON.stringify(roundRobinPlan(5, sales, 5)) === JSON.stringify(roundRobinPlan(5, sales, 2)) &&
    JSON.stringify(roundRobinPlan(5, sales, -1)) === JSON.stringify(roundRobinPlan(5, sales, 2)) &&
    JSON.stringify(roundRobinPlan(0, sales, 0)) === JSON.stringify({ [S_A]: 0, [S_B]: 0, [S_C]: 0 }))
  ok('R0.4 rotateSalesFrom 旋转副本不动原数组',
    JSON.stringify(rotateSalesFrom(sales, 1)) === JSON.stringify([S_B, S_C, S_A]) && JSON.stringify(sales) === JSON.stringify([S_A, S_B, S_C]))

  console.log('\n═══ R1. 三人连续 count=5 批次：额外份额轮转 ═══')
  resetAssignmentInvalidationForTest()
  setCursor('') // 游标空 = 从名单第一位开始（兼容旧行为）
  seedLeads(15) // 三个批次 × 5 条
  const b1 = assignBatchLeads({ count: 5, mode: 'round_robin' })
  ok('R1.1 批次1 成功分配 5 条', b1.ok === true && b1.data?.assigned === 5, JSON.stringify(b1.data))
  ok('R1.2 批次1 份额 甲2/乙2/丙1（起点=甲）',
    b1.data?.perSales[S_A] === 2 && b1.data?.perSales[S_B] === 2 && b1.data?.perSales[S_C] === 1,
    JSON.stringify(b1.data?.perSales))
  ok('R1.3 批次1 后游标 = 丙（下一位）', cursor() === S_C, cursor())
  const b2 = assignBatchLeads({ count: 5, mode: 'round_robin' })
  ok('R1.4 批次2 从丙开始：丙2/甲2/乙1（额外份额轮到后部）',
    b2.data?.perSales[S_C] === 2 && b2.data?.perSales[S_A] === 2 && b2.data?.perSales[S_B] === 1,
    JSON.stringify(b2.data?.perSales))
  ok('R1.5 批次2 后游标 = 乙', cursor() === S_B, cursor())
  const b3 = assignBatchLeads({ count: 5, mode: 'round_robin' })
  ok('R1.6 批次3 从乙开始：乙2/丙2/甲1',
    b3.data?.perSales[S_B] === 2 && b3.data?.perSales[S_C] === 2 && b3.data?.perSales[S_A] === 1,
    JSON.stringify(b3.data?.perSales))
  const cum1 = (b1.data!.perSales[S_A] + b2.data!.perSales[S_A] + b3.data!.perSales[S_A])
  const cum2 = (b1.data!.perSales[S_B] + b2.data!.perSales[S_B] + b3.data!.perSales[S_B])
  const cum3 = (b1.data!.perSales[S_C] + b2.data!.perSales[S_C] + b3.data!.perSales[S_C])
  ok('R1.7 三批累计 5/5/5（余数份额轮转而非固定前部）', cum1 === 5 && cum2 === 5 && cum3 === 5, `${cum1}/${cum2}/${cum3}`)

  console.log('\n═══ R2. 长期累计：9 批 × 5 条 = 45，每人 15（差值 0）═══')
  seedLeads(30) // R1 已用 15，再补 30 凑 45
  const totals: Record<string, number> = { [S_A]: cum1, [S_B]: cum2, [S_C]: cum3 }
  let bounded = true
  for (let i = 0; i < 6; i++) {
    const r = assignBatchLeads({ count: 5, mode: 'round_robin' })
    if (!r.ok || !r.data) { bounded = false; break }
    for (const s of sales) totals[s] += r.data.perSales[s] || 0
    const mx = Math.max(...Object.values(totals))
    const mn = Math.min(...Object.values(totals))
    // 轮询应有范围：单批余数 ≤ count % n = 2，跨批游标轮转下任意时刻累计差值 ≤ 2
    if (mx - mn > 2) bounded = false
  }
  ok('R2.1 每个批次后累计差值 ≤ 2（轮询应有范围）', bounded, JSON.stringify(totals))
  ok('R2.2 九批累计 15/15/15（差值 0，长期均衡）',
    totals[S_A] === 15 && totals[S_B] === 15 && totals[S_C] === 15, JSON.stringify(totals))

  console.log('\n═══ R3. count 小于销售人数：下一批从未轮到的人继续 ═══')
  setCursor('')
  seedLeads(4)
  const s1 = assignBatchLeads({ count: 2, mode: 'round_robin' })
  ok('R3.1 count=2 只给 甲/乙', s1.data?.perSales[S_A] === 1 && s1.data?.perSales[S_B] === 1 && s1.data?.perSales[S_C] === 0, JSON.stringify(s1.data?.perSales))
  ok('R3.2 游标推进到 丙（未轮到者）', cursor() === S_C, cursor())
  const s2 = assignBatchLeads({ count: 2, mode: 'round_robin' })
  ok('R3.3 下一批从 丙 继续：丙1/甲1', s2.data?.perSales[S_C] === 1 && s2.data?.perSales[S_A] === 1, JSON.stringify(s2.data?.perSales))

  console.log('\n═══ R4. weight/load 行为不变；非轮询模式不影响游标 ═══')
  ok('R4.1 buildDistribution weight（缺省权重=等权）不变：12 条/3 人 = 4/4/4',
    JSON.stringify(buildDistribution('weight', 12, sales, {}, {})) === JSON.stringify({ [S_A]: 4, [S_B]: 4, [S_C]: 4 }))
  // load 逐条投放手算（3,1,0 起）：丙1 → 乙2 → 丙2 → 乙3 → 丙3，与旧实现逐行同代码路径
  const loadPlan = buildDistribution('load', 5, sales, {}, { [S_A]: 3, [S_B]: 1, [S_C]: 0 })
  ok('R4.2 buildDistribution load 不变：{甲0,乙2,丙3}',
    JSON.stringify(loadPlan) === JSON.stringify({ [S_A]: 0, [S_B]: 2, [S_C]: 3 }), JSON.stringify(loadPlan))
  ok('R4.3 round_robin 缺省起点 = 旧行为（余数给名单前部）',
    JSON.stringify(buildDistribution('round_robin', 5, sales, {}, {})) === JSON.stringify({ [S_A]: 2, [S_B]: 2, [S_C]: 1 }))
  const beforeWeightCursor = cursor()
  seedLeads(6)
  const wb = assignBatchLeads({ count: 6, mode: 'weight' })
  ok('R4.4 weight 批量成功但游标不动', wb.ok && wb.data?.assigned === 6 && cursor() === beforeWeightCursor, `${wb.ok} ${cursor()} vs ${beforeWeightCursor}`)
  seedLeads(6)
  const lb = assignBatchLeads({ count: 6, mode: 'load' })
  ok('R4.5 load 批量成功但游标不动', lb.ok && lb.data?.assigned === 6 && cursor() === beforeWeightCursor, `${lb.ok} ${cursor()} vs ${beforeWeightCursor}`)
  assignLeads([seedLead()], S_B, '分配员') // manual 单条分配
  ok('R4.6 manual assignLeads 不影响游标', cursor() === beforeWeightCursor, cursor())

  console.log('\n═══ R5. 名单增删/重排/脏游标安全自愈 ═══')
  setCursor(S_A)
  cfg.set('crmSalesList', [S_B, S_C]) // 甲被移除，游标指向的成员已不存在
  seedLeads(5)
  const r5a = assignBatchLeads({ count: 5, mode: 'round_robin' })
  ok('R5.1 游标成员已不在名单：安全重置到第一位（乙），分配成功不失败（乙3/丙2）',
    r5a.ok && r5a.data?.assigned === 5 && r5a.data?.perSales[S_B] === 3 && r5a.data?.perSales[S_C] === 2,
    JSON.stringify(r5a.data))
  const S_D = '轮询销售丁'
  cfg.set('crmSalesList', [S_D, S_B, S_C]) // 新增丁并重排
  sales = [S_D, S_B, S_C]
  setCursor(S_C) // 丙在新名单下标 2
  seedLeads(5)
  const r5b = assignBatchLeads({ count: 5, mode: 'round_robin' })
  ok('R5.2 重排后游标成员从新下标开始：丙2/丁2/乙1',
    r5b.ok && r5b.data?.assigned === 5 && r5b.data?.perSales[S_C] === 2 && r5b.data?.perSales[S_D] === 2 && r5b.data?.perSales[S_B] === 1,
    JSON.stringify(r5b.data))
  setCursor('根本不存在的人')
  seedLeads(5)
  const r5c = assignBatchLeads({ count: 5, mode: 'round_robin' })
  ok('R5.3 脏游标（不存在姓名）自愈到名单第一位，分配成功',
    r5c.ok && r5c.data?.assigned === 5 && r5c.data?.perSales[S_D] === 2, JSON.stringify(r5c.data))
  cfg.set('crmSalesList', [S_A, S_B, S_C]) // 恢复三人名单
  sales = [S_A, S_B, S_C]

  console.log('\n═══ R6. 空池：游标不推进 ═══')
  // 「整批全部跳过/失败」在当前同步设计下经公共 API 不可达：待分配池在批次开头用
  // 「NEW 且无有效分配」过滤，单线程同批内不会出现并发 E201；E301 空池在游标逻辑前返回。
  // 防线 = 持久化守卫 `assigned > 0` 才写游标（见 crmAssignmentService）；部分失败/跳过场景
  // 的精确推进由 R9 的 DI 夹具直接验证（失败/E201/E301 不消耗游标推进量）。
  setCursor(S_B)
  const r6a = assignBatchLeads({ count: 5, mode: 'round_robin' })
  ok('R6.1 空池返回 E301 且游标不动', r6a.ok === false && r6a.code === 'E301' && cursor() === S_B, JSON.stringify({ code: r6a.code, c: cursor() }))

  console.log('\n═══ R7. 前端预览与后端实际 perSales 逐批一致（同游标同源函数）═══')
  setCursor('')
  seedLeads(15)
  // 键序归一（后端 perSales 按本批旋转序输出、预览按名单序输出；页面按 key 取值，键序无关）
  const canon = (p: Record<string, number>): string => JSON.stringify(Object.keys(p).sort().map((k) => [k, p[k]]))
  let prevFe: string | null = null
  let feMatched = true
  let feDetail = ''
  for (let i = 0; i < 3; i++) {
    const r = assignBatchLeads({ count: 5, mode: 'round_robin' })
    // 预览 = 本批成功后从持久化游标（下一位）算出的下批份额；应与下一批实际 perSales 逐字段一致
    const fe = canon(distributePreview('round_robin', 5, sales, {}, {}, roundRobinStartIndex(sales, cursor())))
    if (prevFe !== null && prevFe !== canon(r.data?.perSales || {})) { feMatched = false; feDetail = `批${i + 1}: ${prevFe} vs ${canon(r.data?.perSales || {})}` }
    prevFe = fe
  }
  ok('R7.1 每批的预览 = 下一批后端实际 perSales（游标起点同源）', feMatched, feDetail)
  let consistent = true
  for (const m of ['weight', 'load', 'round_robin'] as const) {
    for (let i = 0; i < 3; i++) {
      const w = { [S_A]: 60, [S_B]: 30, [S_C]: 10 }
      const ld = { [S_A]: 5, [S_B]: 3, [S_C]: 1 }
      const be = buildDistribution(m, 7, sales, w, ld, { roundRobinStartIndex: i })
      const fe = distributePreview(m, 7, sales, w, ld, i)
      if (JSON.stringify(be) !== JSON.stringify(fe)) consistent = false
    }
  }
  ok('R7.2 起点参数下 buildDistribution 与 distributePreview 逐模式一致', consistent)

  console.log('\n═══ R8. 游标持久化（config 落盘；重启延续 = 每批从 config 现读）═══')
  setCursor('')
  seedLeads(5)
  assignBatchLeads({ count: 5, mode: 'round_robin' })
  ok('R8.1 getRoundRobinCursor 只读端点返回持久游标', getRoundRobinCursor().ok && getRoundRobinCursor().data.next === S_C, JSON.stringify(getRoundRobinCursor()))
  const cfgFile = join(isoDir, 'WeFlow-config.json')
  let onDisk = ''
  if (existsSync(cfgFile)) {
    try { onDisk = String((JSON.parse(readFileSync(cfgFile, 'utf8')) as Record<string, unknown>).crmRoundRobinCursor || '') } catch { /* ignore */ }
  }
  ok('R8.2 游标已落盘（config 文件可读回）', onDisk === S_C, `disk=${onDisk}`)
  // 等价重启验证：服务无模块级内存游标——直接改 config 值即可改变下一批起点（重启后读同一文件）
  setCursor(S_B)
  seedLeads(5)
  const r8 = assignBatchLeads({ count: 5, mode: 'round_robin' })
  ok('R8.3 下一批从持久化的游标成员开始（乙2/丙2/甲1）',
    r8.ok && r8.data?.perSales[S_B] === 2 && r8.data?.perSales[S_C] === 2 && r8.data?.perSales[S_A] === 1,
    JSON.stringify(r8.data?.perSales))

  console.log('\n═══ R9. round_robin 成功驱动逐条状态机（尝试序列/归属/游标同源，DI 夹具）═══')
  resetAssignmentInvalidationForTest()
  // 三人名单 [甲,乙,丙]、起点甲时，理论逐条轮询 = 甲乙丙甲乙。成功驱动状态机：对每条 lead
  // 由「当前指针」销售尝试，**成功才把指针移到下一位**；失败/E201/E301 指针不动，下一条仍由
  // 同一销售尝试。夹具记录每次 assignOne 实际收到的 salesName（attemptedSales），不能只看最终游标。
  setCursor('')
  const maxAsgIdR9 = Number(crmDbService.all('SELECT COALESCE(MAX(id),0) AS m FROM assignment')[0]?.m || 0)
  const r9a_ids = seedLeads(5)
  const fx1 = fakeAssigner(['fail', 'ok', 'ok', 'ok', 'ok'])
  const r9a = assignBatchLeadsWith({ count: 5, mode: 'round_robin', actor: '夹具' }, fx1.run)
  ok('R9.1 首条失败后 4 条成功：尝试销售序列 = 甲甲乙丙甲（失败后同一销售重试）',
    JSON.stringify(fx1.attemptedSales) === JSON.stringify([S_A, S_A, S_B, S_C, S_A]), JSON.stringify(fx1.attemptedSales))
  ok('R9.2 R9.1 成功归属 = 甲2/乙1/丙1、assigned = 4 且与 DB 真实落库行数一致',
    r9a.ok && r9a.data?.assigned === 4 &&
    r9a.data?.perSales[S_A] === 2 && r9a.data?.perSales[S_B] === 1 && r9a.data?.perSales[S_C] === 1 &&
    Number(crmDbService.all('SELECT COUNT(*) AS c FROM assignment WHERE deleted = 0 AND id > ?', [maxAsgIdR9])[0]?.c || 0) === 4,
    `${JSON.stringify(r9a.data?.perSales)}`)
  ok('R9.3 R9.1 skipped 恰为第一条（E999）',
    r9a.data?.skipped.length === 1 && r9a.data?.skipped[0].leadId === r9a_ids[0] && r9a.data?.skipped[0].code === 'E999',
    JSON.stringify(r9a.data?.skipped))
  ok('R9.4 R9.1 游标 = 批末真实指针（乙）',
    cursor() === S_B, cursor())
  drainPool()

  setCursor('')
  const r9b_ids = seedLeads(5)
  const fx2 = fakeAssigner(['ok', 'fail', 'ok', 'fail', 'ok'])
  const r9b = assignBatchLeadsWith({ count: 5, mode: 'round_robin', actor: '夹具' }, fx2.run)
  ok('R9.5 中间两次失败：失败后下一条仍由同一销售尝试（甲乙乙丙丙）',
    JSON.stringify(fx2.attemptedSales) === JSON.stringify([S_A, S_B, S_B, S_C, S_C]), JSON.stringify(fx2.attemptedSales))
  ok('R9.6 R9.5 成功归属 = 甲1/乙1/丙1、assigned = 3，skipped = 失败的两条',
    r9b.ok && r9b.data?.assigned === 3 &&
    r9b.data?.perSales[S_A] === 1 && r9b.data?.perSales[S_B] === 1 && r9b.data?.perSales[S_C] === 1 &&
    JSON.stringify(r9b.data?.skipped.map((s) => [s.leadId, s.code])) === JSON.stringify([[r9b_ids[1], 'E999'], [r9b_ids[3], 'E999']]),
    JSON.stringify(r9b.data))
  ok('R9.7 R9.5 游标 = 批末真实指针（甲）', cursor() === S_A, cursor())
  drainPool()

  setCursor('')
  const r9c_ids = seedLeads(5)
  const fx3 = fakeAssigner(['ok', 'ok', 'ok', 'ok', 'fail'])
  const r9c = assignBatchLeadsWith({ count: 5, mode: 'round_robin', actor: '夹具' }, fx3.run)
  ok('R9.8 最后一条失败：尝试序列 = 甲乙丙甲乙，游标停在失败对应销售（乙），失败不消耗游标位置',
    JSON.stringify(fx3.attemptedSales) === JSON.stringify([S_A, S_B, S_C, S_A, S_B]) && cursor() === S_B,
    `${JSON.stringify(fx3.attemptedSales)} cursor=${cursor()}`)
  ok('R9.9 R9.8 成功归属 = 甲2/乙1/丙1、assigned = 4，skipped 恰为最后一条',
    r9c.ok && r9c.data?.assigned === 4 &&
    r9c.data?.perSales[S_A] === 2 && r9c.data?.perSales[S_B] === 1 && r9c.data?.perSales[S_C] === 1 &&
    r9c.data?.skipped.length === 1 && r9c.data?.skipped[0].leadId === r9c_ids[4],
    JSON.stringify(r9c.data))
  drainPool()

  setCursor('')
  seedLeads(5)
  const auditBeforeAllFail = batchAuditCount()
  const fx4 = fakeAssigner(['fail', 'fail', 'fail', 'fail', 'fail'])
  const r9d = assignBatchLeadsWith({ count: 5, mode: 'round_robin', actor: '夹具' }, fx4.run)
  ok('R9.10 全部失败：每次尝试都是起始销售（甲×5）',
    JSON.stringify(fx4.attemptedSales) === JSON.stringify([S_A, S_A, S_A, S_A, S_A]), JSON.stringify(fx4.attemptedSales))
  ok('R9.11 全部失败：assigned=0、perSales 全 0、skipped=尝试数 5、游标不变、批次审计不落',
    r9d.ok && r9d.data?.assigned === 0 && r9d.data?.batchNo === '' &&
    r9d.data?.perSales[S_A] === 0 && r9d.data?.perSales[S_B] === 0 && r9d.data?.perSales[S_C] === 0 &&
    r9d.data?.skipped.length === 5 && cursor() === '' && batchAuditCount() === auditBeforeAllFail,
    `cursor=${cursor()} ${JSON.stringify(r9d.data)}`)
  drainPool()

  setCursor('')
  seedLeads(5)
  const fx5 = fakeAssigner(['E201', 'E301', 'fail', 'ok', 'ok'])
  const r9e = assignBatchLeadsWith({ count: 5, mode: 'round_robin', actor: '夹具' }, fx5.run)
  ok('R9.12 E201/E301/普通失败混合：三种失败都不推进指针（尝试序列 = 甲甲甲甲乙）',
    JSON.stringify(fx5.attemptedSales) === JSON.stringify([S_A, S_A, S_A, S_A, S_B]), JSON.stringify(fx5.attemptedSales))
  ok('R9.13 R9.12 assigned = 2（甲1/乙1/丙0），skipped 码序 = E201/E301/E999，游标 = 丙',
    r9e.ok && r9e.data?.assigned === 2 &&
    r9e.data?.perSales[S_A] === 1 && r9e.data?.perSales[S_B] === 1 && r9e.data?.perSales[S_C] === 0 &&
    JSON.stringify(r9e.data?.skipped.map((s) => s.code)) === JSON.stringify(['E201', 'E301', 'E999']) &&
    cursor() === S_C, `${cursor()} ${JSON.stringify(r9e.data)}`)
  drainPool()

  setCursor(S_B) // 非零起点：从乙开始
  seedLeads(5)
  const fx6 = fakeAssigner(['fail', 'ok', 'ok', 'ok', 'ok'])
  const r9f = assignBatchLeadsWith({ count: 5, mode: 'round_robin', actor: '夹具' }, fx6.run)
  ok('R9.14 非零起点（乙起）：尝试序列 = 乙乙丙甲乙（成功才移动）',
    JSON.stringify(fx6.attemptedSales) === JSON.stringify([S_B, S_B, S_C, S_A, S_B]), JSON.stringify(fx6.attemptedSales))
  ok('R9.15 R9.14 成功归属 = 乙2/丙1/甲1、assigned = 4，批末游标 = 真实当前指针（丙）',
    r9f.ok && r9f.data?.assigned === 4 &&
    r9f.data?.perSales[S_B] === 2 && r9f.data?.perSales[S_C] === 1 && r9f.data?.perSales[S_A] === 1 &&
    cursor() === S_C, `${cursor()} ${JSON.stringify(r9f.data?.perSales)}`)
  drainPool()

  // 跨批累计公平：批1 = 首条失败夹具批（甲2/乙1/丙1，游标→乙）；批2 = 真实全成功批（从乙起
  // 乙2/丙2/甲1）。9 次累计成功 = 甲3/乙3/丙3，与连续逐条轮询序列 甲乙丙甲乙|乙丙甲乙丙 一致。
  setCursor('')
  seedLeads(5)
  const fx7 = fakeAssigner(['fail', 'ok', 'ok', 'ok', 'ok'])
  const c7a = assignBatchLeadsWith({ count: 5, mode: 'round_robin', actor: '夹具' }, fx7.run)
  drainPool()
  seedLeads(5)
  const preview7 = distributePreview('round_robin', 5, sales, {}, {}, roundRobinStartIndex(sales, cursor()))
  const c7b = assignBatchLeads({ count: 5, mode: 'round_robin', actor: '夹具' })
  const cum7 = (k: string): number => (c7a.data?.perSales[k] || 0) + (c7b.data?.perSales[k] || 0)
  const canon7 = (p: Record<string, number>): string => JSON.stringify(Object.keys(p).sort().map((k) => [k, p[k]]))
  ok('R9.16 跨批累计公平：首条失败批 + 全成功批 = 9 次累计 甲3/乙3/丙3（连续逐条轮询）',
    c7a.ok && c7b.ok && cum7(S_A) === 3 && cum7(S_B) === 3 && cum7(S_C) === 3,
    `甲${cum7(S_A)}/乙${cum7(S_B)}/丙${cum7(S_C)}`)
  ok('R9.17 批2 实际 perSales == 批2 前预览（全部成功时同源逐条一致）',
    canon7(c7b.data?.perSales || {}) === canon7(preview7),
    `${canon7(preview7)} vs ${canon7(c7b.data?.perSales || {})}`)
  drainPool()

  // 夹具持久化的游标被真实生产路径接续：丙起点真实批次从丙开始逐条轮询
  setCursor(S_C)
  seedLeads(4)
  const r9g = assignBatchLeads({ count: 4, mode: 'round_robin', actor: '夹具' })
  ok('R9.18 夹具持久化的游标被真实批次接续（丙起点：丙2/甲1/乙1，游标→甲）',
    r9g.ok && r9g.data?.assigned === 4 &&
    r9g.data?.perSales[S_C] === 2 && r9g.data?.perSales[S_A] === 1 && r9g.data?.perSales[S_B] === 1 &&
    cursor() === S_A, `${cursor()} ${JSON.stringify(r9g.data?.perSales)}`)
  drainPool()

  setCursor(S_A)
  const beforeW = cursor()
  seedLeads(2)
  const fxw = fakeAssigner(['ok', 'ok'])
  const r9w = assignBatchLeadsWith({ count: 2, mode: 'weight', weights: { [S_A]: 100 }, actor: '夹具' }, fxw.run)
  ok('R9.19 weight 经同一注入点仍是份额分组执行（尝试序列 = 甲甲，未变成逐条轮询）且游标不动',
    r9w.ok && r9w.data?.assigned === 2 &&
    JSON.stringify(fxw.attemptedSales) === JSON.stringify([S_A, S_A]) && cursor() === beforeW,
    `${JSON.stringify(fxw.attemptedSales)} cursor=${cursor()}`)
  drainPool()
  seedLeads(4)
  const fxld = fakeAssigner(['ok', 'ok', 'ok', 'ok'])
  const r9l = assignBatchLeadsWith({ count: 4, mode: 'load', actor: '夹具' }, fxld.run)
  ok('R9.20 load 经同一注入点成功分配且游标不动',
    r9l.ok && r9l.data?.assigned === 4 && cursor() === beforeW, `cursor=${cursor()}`)
  drainPool()

  console.log('\n═══ R10. 游标写盘失败降级：分配/审计照常 ok:true，游标保持旧值 ═══')
  resetAssignmentInvalidationForTest()
  setCursor('')
  const r10_ids = seedLeads(5)
  const cfg10 = ConfigService.getInstance()
  const cfgPatch = cfg10 as unknown as { set: (key: string, value: unknown) => void }
  const origSet = cfgPatch.set
  let cursorWriteAttempts = 0
  cfgPatch.set = function (this: unknown, key: string, value: unknown) {
    if (key === 'crmRoundRobinCursor') { cursorWriteAttempts++; throw new Error('模拟配置写盘失败（R10 夹具）') }
    return origSet.call(this, key, value)
  }
  try {
    const maxAsgIdBefore = Number(crmDbService.all('SELECT COALESCE(MAX(id),0) AS m FROM assignment')[0]?.m || 0)
    const auditBefore10 = batchAuditCount()
    const b10 = assignBatchLeads({ count: 5, mode: 'round_robin', actor: '主管' })
    ok('R10.1 游标写盘抛错时批次仍返回 ok:true、assigned = 5',
      b10.ok === true && b10.data?.assigned === 5, JSON.stringify(b10))
    ok('R10.2 perSales 如实返回（甲2/乙2/丙1）',
      b10.data?.perSales[S_A] === 2 && b10.data?.perSales[S_B] === 2 && b10.data?.perSales[S_C] === 1,
      JSON.stringify(b10.data?.perSales))
    const newRows = crmDbService.all('SELECT id, lead_id FROM assignment WHERE id > ? AND deleted = 0', [maxAsgIdBefore])
    ok('R10.3 5 条 assignment 已真实落库（本轮新增 5 行、lead 无重复）',
      newRows.length === 5 && new Set(newRows.map((r) => Number(r.lead_id))).size === 5 &&
      JSON.stringify(newRows.map((r) => Number(r.lead_id)).sort((a, b) => a - b)) === JSON.stringify([...r10_ids].sort((a, b) => a - b)),
      JSON.stringify(newRows))
    ok('R10.4 lead_assign_batch 批次审计正常落地（恰好新增 1 行且 assigned=5）',
      batchAuditCount() === auditBefore10 + 1, `${batchAuditCount()} vs ${auditBefore10}`)
    ok('R10.5 游标持久化恰好尝试 1 次且保持旧值（空串）',
      cursorWriteAttempts === 1 && cursor() === '', `attempts=${cursorWriteAttempts} cursor=${cursor()}`)
    ok('R10.6 无重复分配（全库每条 lead 至多一条有效归属行）',
      crmDbService.all('SELECT lead_id FROM assignment WHERE deleted = 0 GROUP BY lead_id HAVING COUNT(*) > 1').length === 0, '')
    // 同一故障窗口内 weight 模式不受影响（weight/load 本就不写游标）
    seedLeads(4)
    const w10 = assignBatchLeads({ count: 4, mode: 'weight', actor: '主管' })
    ok('R10.7 weight 批量在游标写盘故障下不受影响（ok、assigned=4、游标零尝试）',
      w10.ok && w10.data?.assigned === 4 && cursorWriteAttempts === 1 && cursor() === '',
      `${w10.ok} attempts=${cursorWriteAttempts} cursor=${cursor()}`)
  } finally {
    // 恢复被 monkey-patch 的方法（删除实例自有属性，回落原型方法），不污染后续用例
    delete (cfg10 as unknown as { set?: unknown }).set
  }
  ok('R10.8 monkey-patch 已恢复（正常 set 可写游标）', (() => { setCursor(S_A); return cursor() === S_A })(), cursor())
  // 恢复后真实批次：游标恢复正常写入；且只分配新线索，先前批次归属不被重复分配
  const r10b_ids = seedLeads(3)
  const b10b = assignBatchLeads({ count: 3, mode: 'round_robin', actor: '主管' })
  const r10bRows = crmDbService.all(`SELECT lead_id FROM assignment WHERE deleted = 0 AND lead_id IN (${r10b_ids.map(() => '?').join(',')})`, r10b_ids)
  ok('R10.9 恢复后批次正常推进游标（起点甲 + 3 成功 → 甲），只分配新线索（无重复）',
    b10b.ok && b10b.data?.assigned === 3 && cursor() === S_A &&
    JSON.stringify(b10b.data?.skipped) === '[]' &&
    r10bRows.length === 3 && new Set(r10bRows.map((r) => Number(r.lead_id))).size === 3 &&
    crmDbService.all('SELECT lead_id FROM assignment WHERE deleted = 0 GROUP BY lead_id HAVING COUNT(*) > 1').length === 0,
    `${cursor()} ${JSON.stringify(b10b.data)}`)
  drainPool()

  console.log('\n═══ N1. assign/claim/recycle/transfer 失效载荷 ═══')
  const col1 = makeCollector()
  const nLead = seedLead()
  const na = assignLeads([nLead], S_A, '分配员')
  flushAssignmentInvalidationForTest()
  ok('N1.1 assign 成功 → action=assign + leadIds',
    na.ok && col1.events.length === 1 && col1.events[0].action === 'assign' && JSON.stringify(col1.events[0].leadIds) === JSON.stringify([nLead]),
    JSON.stringify(col1.events))
  col1.events.length = 0
  const nc = claimLead(nLead, S_A)
  flushAssignmentInvalidationForTest()
  ok('N1.2 claim 成功 → action=claim', nc.ok && col1.events.length === 1 && col1.events[0].action === 'claim' && JSON.stringify(col1.events[0].leadIds) === JSON.stringify([nLead]), JSON.stringify(col1.events))
  col1.events.length = 0
  const asgId = na.data!.assignments[0].assignmentId
  const nt = transferAssignment(asgId, S_B, '测试移交', '分配员')
  flushAssignmentInvalidationForTest()
  ok('N1.3 transfer 成功 → action=transfer', nt.ok && col1.events.length === 1 && col1.events[0].action === 'transfer' && JSON.stringify(col1.events[0].leadIds) === JSON.stringify([nLead]), JSON.stringify(col1.events))
  col1.events.length = 0
  const nAsgId2 = Number(nt.data!.assignmentId)
  const nr = recycleAssignment(nAsgId2, '测试回收', '分配员')
  flushAssignmentInvalidationForTest()
  ok('N1.4 recycle 成功 → action=recycle', nr.ok && col1.events.length === 1 && col1.events[0].action === 'recycle' && JSON.stringify(col1.events[0].leadIds) === JSON.stringify([nLead]), JSON.stringify(col1.events))

  console.log('\n═══ N2. 失败/冲突/跳过不发事件 ═══')
  const col2 = makeCollector()
  // 三条失败路径：E301 无分配行 / E202 已回收 / E201 移交已回收行
  const badClaim = claimLead(4242424, S_A)
  const recycleAgain = recycleAssignment(nAsgId2, '再回收', '分配员')
  const badTransfer = transferAssignment(nAsgId2, S_C, '移交已回收行', '分配员')
  // E201 现场再造：先成功分配（会有一条 pending assign 事件），紧接重复分配应 E201
  // （assignLeads 是批量信封：E201 落 data.skipped，assignments 为空 → 不产生事件）
  const okA = assignLeads([nLead], S_C, '分配员')
  const dupAssign = assignLeads([nLead], S_C, '分配员')
  flushAssignmentInvalidationForTest()
  ok('N2.1 重复分配 E201 落 skipped、零新归属行', okA.ok && okA.data!.assignments.length === 1 &&
    dupAssign.ok === true && dupAssign.data!.assignments.length === 0 && dupAssign.data!.skipped[0]?.code === 'E201', JSON.stringify(dupAssign))
  ok('N2.2 失败路径零事件；成功路径恰好 1 条（okA 的 assign）',
    col2.events.length === 1 && col2.events[0].action === 'assign' &&
    badClaim.ok === false && recycleAgain.ok === false && badTransfer.ok === false,
    JSON.stringify({ events: col2.events, badClaim: badClaim.code, recycleAgain: recycleAgain.code, badTransfer: badTransfer.code }))
  col2.events.length = 0
  // 全部跳过的批次：预分配 3 条后跑 round_robin → 池空 → E301，不产生任何事件
  const preN = seedLeads(3)
  for (const id of preN) assignLeads([id], S_A, '分配员')
  flushAssignmentInvalidationForTest()
  col2.events.length = 0
  const skippedBatch = assignBatchLeads({ count: 3, mode: 'round_robin' })
  flushAssignmentInvalidationForTest()
  ok('N2.3 池空批次（E301）零事件',
    skippedBatch.ok === false && skippedBatch.code === 'E301' && col2.events.length === 0, JSON.stringify(col2.events))

  console.log('\n═══ N3. 批量分配 N 次写合并为一条事件 ═══')
  const col3 = makeCollector()
  seedLeads(6)
  const b6 = assignBatchLeads({ count: 6, mode: 'round_robin' })
  flushAssignmentInvalidationForTest()
  ok('N3.1 批量 6 条只产生 1 条事件（不是 6 次页面刷新）',
    b6.ok && b6.data?.assigned === 6 && col3.events.length === 1, JSON.stringify(col3.events.map((e) => e.action)))
  ok('N3.2 合并事件 leadIds = 全部 6 条（去重升序）',
    !!col3.events[0] && col3.events[0].leadIds.length === 6 && col3.events[0].leadIds.every((v, i, a) => i === 0 || a[i - 1] < v),
    JSON.stringify(col3.events[0]?.leadIds))
  const col3b = makeCollector()
  assignLeads([seedLead()], S_B, '分配员')
  flushAssignmentInvalidationForTest()
  col3b.events.length = 0
  const m3 = assignLeads([seedLead()], S_B, '分配员')
  const m3Id = m3.data!.assignments[0].assignmentId
  recycleAssignment(m3Id, '合并测试', '分配员')
  flushAssignmentInvalidationForTest()
  ok('N3.3 同窗口多动作合并为一条事件，action 按固定顺序连接',
    col3b.events.length === 1 && col3b.events[0].action === 'assign,recycle' && col3b.events[0].leadIds.length === 1,
    JSON.stringify(col3b.events))

  console.log('\n═══ N4. LAN/中央下行 assign/transfer/recycle 触发通知 ═══')
  const col4 = makeCollector()
  const hubLeadId = 910001
  const dnPhone = '13987654321'
  const dnLead = { leadId: hubLeadId, name: '下行通知线索', contactType: 'phone', contactNormalized: dnPhone, contactRaw: dnPhone, wechat: '', source: '同步', note: '' }
  const dnNow = Date.now()
  const downAssign = applyDownEventDirect({
    eventSeq: 1, idempotencyKey: 'notify-test:assign:1', type: 'assign', deliveryRole: 'apply',
    payload: { type: 'assign', leadId: hubLeadId, assignmentId: 910001, salesName: S_A, sla1Deadline: dnNow + 86400000, mode: 'manual', actor: 'system:sync', lead: dnLead },
    emittedAt: dnNow
  })
  flushAssignmentInvalidationForTest()
  const localLeadId = Number(crmDbService.all('SELECT id FROM lead WHERE contact_normalized = ?', [dnPhone])[0]?.id || 0)
  ok('N4.1 下行 assign applied → 事件 action=assign 且 leadIds=本地 lead id',
    downAssign === 'applied' && col4.events.length === 1 && col4.events[0].action === 'assign' &&
    JSON.stringify(col4.events[0].leadIds) === JSON.stringify([localLeadId]) && localLeadId > 0,
    JSON.stringify({ outcome: downAssign, events: col4.events, localLeadId }))
  col4.events.length = 0
  const downAssignReplay = applyDownEventDirect({
    eventSeq: 1, idempotencyKey: 'notify-test:assign:1', type: 'assign', deliveryRole: 'apply',
    payload: { type: 'assign', leadId: hubLeadId, assignmentId: 910001, salesName: S_A, sla1Deadline: dnNow + 86400000, mode: 'manual', actor: 'system:sync', lead: dnLead },
    emittedAt: dnNow
  })
  flushAssignmentInvalidationForTest()
  ok('N4.2 幂等重放零业务写 → 不重复通知',
    downAssignReplay === 'applied' && col4.events.length === 0, JSON.stringify(col4.events))
  const downTransferRemove = applyDownEventDirect({
    eventSeq: 2, idempotencyKey: 'notify-test:transfer:2', type: 'transfer', deliveryRole: 'remove',
    payload: { type: 'transfer', leadId: hubLeadId, fromSales: S_A, toSales: S_B, reason: '移交', mode: 'manual', sla1Deadline: dnNow + 86400000, actor: 'system:sync', lead: dnLead },
    emittedAt: dnNow
  })
  flushAssignmentInvalidationForTest()
  ok('N4.3 下行 transfer(remove) applied → 事件 action=transfer',
    downTransferRemove === 'applied' && col4.events.length === 1 && col4.events[0].action === 'transfer' &&
    JSON.stringify(col4.events[0].leadIds) === JSON.stringify([localLeadId]), JSON.stringify(col4.events))
  col4.events.length = 0
  const downTransferApply = applyDownEventDirect({
    eventSeq: 3, idempotencyKey: 'notify-test:transfer:3', type: 'transfer', deliveryRole: 'apply',
    payload: { type: 'transfer', leadId: hubLeadId, fromSales: S_A, toSales: S_B, reason: '移交', mode: 'manual', sla1Deadline: dnNow + 86400000, actor: 'system:sync', lead: dnLead },
    emittedAt: dnNow
  })
  flushAssignmentInvalidationForTest()
  ok('N4.4 下行 transfer(apply) applied → 新归属行 + 事件 action=transfer',
    downTransferApply === 'applied' && col4.events.length === 1 && col4.events[0].action === 'transfer', JSON.stringify(col4.events))
  col4.events.length = 0
  // conflict 现场必须在 recycle 之前构造（回收后无有效行，assign 会正常落地）
  const downConflict = applyDownEventDirect({
    eventSeq: 5, idempotencyKey: 'notify-test:assign:5', type: 'assign', deliveryRole: 'apply',
    payload: { type: 'assign', leadId: hubLeadId, assignmentId: 910003, salesName: S_C, sla1Deadline: dnNow + 86400000, mode: 'manual', actor: 'system:sync', lead: dnLead },
    emittedAt: dnNow
  })
  flushAssignmentInvalidationForTest()
  ok('N4.5 下行 conflict（本地已有归属）不发事件',
    downConflict === 'conflict' && col4.events.length === 0, JSON.stringify({ outcome: downConflict, events: col4.events }))
  const downRecycle = applyDownEventDirect({
    eventSeq: 4, idempotencyKey: 'notify-test:recycle:4', type: 'recycle', deliveryRole: 'apply',
    payload: { type: 'recycle', leadId: hubLeadId, assignmentId: 910002, reason: '下行回收', actor: 'system:sync', lead: dnLead },
    emittedAt: dnNow
  })
  flushAssignmentInvalidationForTest()
  ok('N4.6 下行 recycle applied → 事件 action=recycle',
    downRecycle === 'applied' && col4.events.length === 1 && col4.events[0].action === 'recycle', JSON.stringify(col4.events))
  col4.events.length = 0
  const downNoop = applyDownEventDirect({
    eventSeq: 6, idempotencyKey: 'notify-test:recycle:6', type: 'recycle', deliveryRole: 'apply',
    payload: { type: 'recycle', leadId: 999999, assignmentId: 910009, reason: '未知线索回收', actor: 'system:sync', lead: { leadId: 999999, name: '不存在', contactType: 'phone', contactNormalized: '13999990000', contactRaw: '13999990000', wechat: '', source: '同步', note: '' } },
    emittedAt: dnNow
  })
  flushAssignmentInvalidationForTest()
  ok('N4.7 下行 recycle 命中未知线索（noop applied）不发事件',
    downNoop === 'applied' && col4.events.length === 0, JSON.stringify({ outcome: downNoop, events: col4.events }))

  console.log('\n═══ N5. SLA 自动回收触发通知 ═══')
  const col5 = makeCollector()
  const slaLead = seedLead()
  assignLeads([slaLead], S_A, '分配员')
  flushAssignmentInvalidationForTest()
  col5.events.length = 0
  const slaAsg = Number(crmDbService.all('SELECT id FROM assignment WHERE lead_id = ? ORDER BY id DESC LIMIT 1', [slaLead])[0]?.id || 0)
  crmDbService.runTx((tx) => tx.run('UPDATE assignment SET sla1_deadline = ?, sla1_remind_count = 2 WHERE id = ?', [Date.now() - 3600_000, slaAsg]))
  const slaRes = runSla1Recycle()
  flushAssignmentInvalidationForTest()
  ok('N5.1 SLA 三次超时回收成功 → 事件 action=recycle',
    slaRes.recycled === 1 && col5.events.length === 1 && col5.events[0].action === 'recycle' &&
    JSON.stringify(col5.events[0].leadIds) === JSON.stringify([slaLead]),
    JSON.stringify({ res: slaRes, events: col5.events }))

  console.log('\n═══ N6. 监听器清理函数有效（不泄漏）═══')
  resetAssignmentInvalidationForTest()
  const seen: number[] = []
  const offA = onAssignmentInvalidated(() => seen.push(1))
  const offB = onAssignmentInvalidated(() => seen.push(2))
  offA()
  emitAssignmentInvalidated('assign', [1])
  flushAssignmentInvalidationForTest()
  ok('N6.1 清理后的监听器不再收到事件（另一监听器仍正常）', JSON.stringify(seen) === JSON.stringify([2]), JSON.stringify(seen))
  offB()
  emitAssignmentInvalidated('assign', [2])
  flushAssignmentInvalidationForTest()
  ok('N6.2 全部清理后零事件', JSON.stringify(seen) === JSON.stringify([2]), JSON.stringify(seen))

  console.log('\n═══ N7. 载荷最小化 + preload/类型/零依赖静态守卫 ═══')
  const col7 = makeCollector()
  emitAssignmentInvalidated('claim', [42, 42, 7, -3, 0, 1.5])
  flushAssignmentInvalidationForTest()
  const ev7 = col7.events[0]
  ok('N7.1 载荷键恰为 action/leadIds/at，leadIds 去重升序且只收正整数',
    !!ev7 && Object.keys(ev7).sort().join(',') === 'action,at,leadIds' &&
    JSON.stringify(ev7.leadIds) === JSON.stringify([7, 42]) &&
    typeof ev7.action === 'string' && typeof ev7.at === 'number',
    JSON.stringify(ev7))
  const preloadSrc = readFileSync(join('electron', 'preload.ts'), 'utf8')
  ok('N7.2 preload 订阅返回 removeListener 清理函数（静态守卫；preload 无法在 tsx 内执行）',
    preloadSrc.includes("ipcRenderer.on('crm:assignment:invalidated'") &&
    preloadSrc.includes("ipcRenderer.removeListener('crm:assignment:invalidated'"),
    'preload.ts 缺少订阅/清理对')
  const dtsSrc = readFileSync(join('src', 'types', 'electron.d.ts'), 'utf8')
  ok('N7.3 electron.d.ts 声明了订阅与清理签名',
    dtsSrc.includes('onAssignmentInvalidated') && dtsSrc.includes('CrmAssignmentInvalidation'), '')
  const busSrc = readFileSync(join('electron', 'services', 'assignmentInvalidationBus.ts'), 'utf8')
  ok('N7.4 失效总线零 Electron 依赖（不得 import electron）',
    !/from\s+'electron'/.test(busSrc) && !/require\('electron'\)/.test(busSrc), '')
  const svcSrc = readFileSync(join('electron', 'services', 'crmAssignmentService.ts'), 'utf8')
  ok('N7.5 crmAssignmentService 零 Electron 依赖（不 import BrowserWindow/ipcMain/webContents）',
    !/BrowserWindow|ipcMain|webContents/.test(svcSrc), '')

  console.log('\n═══ N8. 固定窗口合并：持续高频 emit 下有界延迟定期 flush（真实计时器）═══')
  resetAssignmentInvalidationForTest()
  {
    const ev8: AssignmentInvalidationEvent[] = []
    const off8 = onAssignmentInvalidated((e) => ev8.push(e))
    const firstAt = Date.now()
    // 10 次 emit、间隔 40ms（< 150ms 窗口）：尾随 debounce（每次重置计时）会直到停发后才 flush
    // 甚至无限推迟；固定窗口应在持续发射期间就到期 flush，且首条事件在窗口 + 余量内到达
    let emitted = 0
    const emitTimer = setInterval(() => {
      emitted++
      emitAssignmentInvalidated('assign', [8000 + emitted])
      if (emitted >= 10) clearInterval(emitTimer)
    }, 40)
    const lastEmitAt = firstAt + 9 * 40
    await sleep(900)
    const firstLatency = ev8.length ? ev8[0].at - firstAt : Number.POSITIVE_INFINITY
    ok('N8.1 持续高频 emit（间隔 < 窗口）下仍定期 flush（≥2 条合并事件）',
      ev8.length >= 2, `events=${ev8.length}`)
    ok('N8.2 首条合并事件在最大延迟内到达（≤ 窗口 150ms + 200ms 余量）',
      firstLatency <= 350, `latency=${firstLatency}ms`)
    ok('N8.3 发射停止前就有事件到达（持续发射期间 ≥1 次 flush——尾随 debounce 做不到）',
      ev8.some((e) => e.at < lastEmitAt),
      `times=${ev8.map((e) => e.at - firstAt).join(',')} lastEmit=${lastEmitAt - firstAt}`)
    const union8 = Array.from(new Set(ev8.flatMap((e) => e.leadIds))).sort((a, b) => a - b)
    ok('N8.4 窗口内 leadIds 正确合并（并集 = 全部 10 个 id，事件内去重升序、无丢失）',
      JSON.stringify(union8) === JSON.stringify(Array.from({ length: 10 }, (_, i) => 8001 + i)) &&
      ev8.every((e) => e.leadIds.every((v, i, a) => i === 0 || a[i - 1] < v)),
      JSON.stringify(ev8.map((e) => e.leadIds)))
    ok('N8.5 action 合并正确（assign）', ev8.length > 0 && ev8.every((e) => e.action === 'assign'),
      JSON.stringify(ev8.map((e) => e.action)))
    // flush 后下一窗口可以正常启动
    ev8.length = 0
    emitAssignmentInvalidated('assign', [8011])
    await sleep(450)
    ok('N8.6 flush 后下一窗口正常启动（安静期后单条事件恰好一次到达）',
      ev8.length === 1 && JSON.stringify(ev8[0]?.leadIds) === JSON.stringify([8011]), JSON.stringify(ev8))
    // listener 清理仍有效（真实计时器路径）
    ev8.length = 0
    off8()
    emitAssignmentInvalidated('assign', [8012])
    await sleep(450)
    ok('N8.7 off() 清理后不再收到事件', ev8.length === 0, JSON.stringify(ev8))
  }
  resetAssignmentInvalidationForTest()

  console.log('\n═══ N9. 页面合并调度器 coalescedScheduler：固定窗口有界延迟 + dispose（真实计时器）═══')
  {
    let fires = 0
    const fireTimes: number[] = []
    const start9 = Date.now()
    const sched = createCoalescedScheduler(60, () => { fires++; fireTimes.push(Date.now() - start9) })
    // 每 20ms schedule 一次、持续 15 次（间隔 < 窗口）：尾随 debounce 只会在停发后触发一次；
    // 固定窗口应约每 60-80ms 触发一次
    let n9 = 0
    const t9 = setInterval(() => {
      n9++
      sched.schedule()
      if (n9 >= 15) clearInterval(t9)
    }, 20)
    await sleep(600)
    ok('N9.1 持续 schedule（间隔 < 窗口）下仍定期触发（≥3 次，尾随 debounce 做不到）',
      fires >= 3, `fires=${fires} times=${fireTimes.join(',')}`)
    ok('N9.2 首次触发在最大等待内（窗口 60ms + 90ms 余量）',
      fireTimes.length > 0 && fireTimes[0] <= 150, `first=${fireTimes[0] ?? 'never'}ms`)
    let gapsOk = true
    for (let i = 1; i < fireTimes.length; i++) if (fireTimes[i] - fireTimes[i - 1] > 200) gapsOk = false
    ok('N9.3 相邻触发间隔有界（≤ 窗口 + 调度间隔 + 余量，不会无限推迟）', gapsOk, fireTimes.join(','))
    sched.dispose()
    const beforeDispose = fires
    sched.schedule() // dispose 后应为空操作
    await sleep(200)
    ok('N9.4 dispose 后 schedule 不再触发（组件卸载防泄漏）', fires === beforeDispose, `${fires} vs ${beforeDispose}`)
    // 新实例正常工作（页面重挂载等价场景）
    let fires2 = 0
    const sched2 = createCoalescedScheduler(60, () => { fires2++ })
    sched2.schedule()
    await sleep(200)
    sched2.dispose()
    ok('N9.5 新实例正常触发一次（重挂载等价）', fires2 === 1, `fires2=${fires2}`)
    // CrmLeadPage 接入静态守卫（补充性；行为验证在 N9.1-N9.5）
    const pageSrc = readFileSync(join('src', 'pages', 'CrmLeadPage.tsx'), 'utf8')
    ok('N9.6 CrmLeadPage 使用 coalescedScheduler（页面级尾随 debounce 已移除）',
      pageSrc.includes('createCoalescedScheduler') && !pageSrc.includes('invalidationTimerRef'), '')
  }

  console.log(`\n═══ 结果：${pass} 通过 / ${fail} 失败 ═══`)
  if (fail > 0) process.exit(1)
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
