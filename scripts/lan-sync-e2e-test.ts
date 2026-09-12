/**
 * lan-sync-e2e-test.ts —— Phase 1 内网同步「真实多终端」端到端验证
 * （设计 docs/规划/Phase1-内网同步最小版-设计.md，2026-09-08 定向投递修订版）
 *
 * ⚠️ 2026-09-08 重写：废弃旧版「一台终端消费甲乙两人全部事件」的伪多人拓扑，
 *    改为三台相互隔离的本地数据库（各持独立 sql.js 库文件）：
 *      中枢（主管机，dirHub，身份=测试主管）  ←→  <shared>/down/<投递键>/ + up/<终端>/  ←→
 *      销售甲终端（dirJia，身份=销售甲） · 销售乙终端（dirYi，身份=销售乙）
 *
 * 九项证明（对应「真实多人线索分配」验收标准）：
 *   1. 分给甲的线索只有甲能领取（乙库里根本没有该线索/分配）
 *   2. 乙先轮询也不能消费、删除或看到甲的事件（文件字节级不变 + 甲库零变化）
 *   3. 甲离线时，乙正常工作不会影响甲的待投递事件
 *   4. 甲恢复后能收到积压事件（applied=1，本地事务齐备）
 *   5. transfer 后原销售失去线索（乙库行 transferred、绝不为甲建行），新销售获得线索（甲库新行 assigned）
 *   6. recycle 后原销售本地状态正确更新（行 recycled + 首触期限回 2100 哨兵 + 审计）
 *   7. 重复投递和重复 ACK 不产生重复 assignment/ownership_history/audit_event
 *   8. 一个接收者 ACK 不会提前清理其他接收者的投递（transfer 双投递：甲 ACK 后乙的 remove 文件仍在、行仍 pending）
 *   9. 中枢重启、终端重启后状态可以继续恢复（reopen 库 + 队列文件/幂等标记持久）
 *
 * 隔离：WEFLOW_WORKER='1' + /tmp 落盘（三个环境变量在模块正文顶部设置，业务模块一律在其后
 *   动态 import，保证隔离先于任何业务模块加载，绝不读/写持久 WeFlow-nodejs 配置）；
 *   三库均 fresh 空库，绝不碰 live 库、不起 Electron。
 * 运行：npx tsx scripts/lan-sync-e2e-test.ts
 */
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const isoDir = mkdtempSync(join(tmpdir(), 'lansync-e2e-cfg-'))
process.env.WEFLOW_WORKER = '1'
process.env.WEFLOW_USER_DATA_PATH = isoDir
process.env.WEFLOW_CONFIG_CWD = isoDir

let pass = 0, fail = 0
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; console.log(`  ✅ ${name}`) } else { fail++; console.log(`  ❌ ${name} ${detail}`) }
}

// 仅类型导入：编译后整段擦除、不触发任何模块求值，可安全保留为静态 import type
import type { CrmRow } from '../electron/services/crmDbService'

// ⚠️ 业务模块不得静态 import：ESM 静态 import 会被提升到模块正文之前执行，
// ConfigService 会在上面三行环境变量生效前完成初始化，转而读/写持久配置。
// 一律在 main() 开头动态 await import()；跨辅助函数（switchTo/seedLeadOnHub 等）共享的
// 绑定先声明为模块级 let，在 main() 动态加载完成后、任何测试逻辑运行前赋值。
let ConfigService: (typeof import('../electron/services/config'))['ConfigService']
let crmDbService: (typeof import('../electron/services/crmDbService'))['crmDbService']
let setIdentity: (typeof import('../electron/services/identityService'))['setIdentity']
let LEAD_SLA_UNASSIGNED_SENTINEL: (typeof import('../shared/leadSla'))['LEAD_SLA_UNASSIGNED_SENTINEL']

const HUB = '测试主管'
const S_JIA = '销售甲'
const S_YI = '销售乙'
const NOW = Date.now()

const dirHub = mkdtempSync(join(tmpdir(), 'lansync-e2e-hub-'))
const dirJia = mkdtempSync(join(tmpdir(), 'lansync-e2e-jia-'))
const dirYi = mkdtempSync(join(tmpdir(), 'lansync-e2e-yi-'))
const shared = mkdtempSync(join(tmpdir(), 'lansync-e2e-shared-'))

function queueDir(rk: string): string { return join(shared, 'down', rk) }
function queueFiles(rk: string): string[] {
  const d = queueDir(rk)
  return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.json')).sort() : []
}
function upFiles(tid: string): string[] {
  const d = join(shared, 'up', tid)
  return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.json')).sort() : []
}
function seedLeadOnHub(phone: string, name: string): number {
  return crmDbService.runTx((tx) => tx.run(
    'INSERT INTO lead (contact_type, contact_normalized, contact_raw, wechat, source, name, note, status, first_contact_deadline, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    ['phone', phone, phone, '', '抖音', name, 'e2e 备注', 'NEW', LEAD_SLA_UNASSIGNED_SENTINEL, NOW, NOW]
  ))
}
function leadByPhone(phone: string): CrmRow | null {
  return crmDbService.all("SELECT * FROM lead WHERE contact_type = 'phone' AND contact_normalized = ?", [phone])[0] || null
}
function assignmentsOf(leadId: number): CrmRow[] {
  return crmDbService.all('SELECT * FROM assignment WHERE lead_id = ? AND deleted = 0 ORDER BY id', [leadId])
}

/** 换机：落盘当前库 → 卸载 → 打开另一台机器的库（§2.40 分库切换同款链路），并切该机的角色/身份 */
async function switchTo(machine: 'hub' | 'jia' | 'yi'): Promise<void> {
  const cfg = ConfigService.getInstance()
  if (machine === 'hub') {
    cfg.set('lanSyncRole', 'hub')
    setIdentity(HUB, '主管')
    await crmDbService.reopenForWxid(dirHub)
  } else if (machine === 'jia') {
    cfg.set('lanSyncRole', 'terminal')
    setIdentity(S_JIA, '销售')
    await crmDbService.reopenForWxid(dirJia)
  } else {
    cfg.set('lanSyncRole', 'terminal')
    setIdentity(S_YI, '销售')
    await crmDbService.reopenForWxid(dirYi)
  }
}

async function main(): Promise<void> {
  // 动态加载全部业务模块：三行环境变量已在模块正文顶部生效，此后 ConfigService
  // 等模块读到的一定是本轮独立 /tmp 目录，绝不碰持久配置
  ConfigService = (await import('../electron/services/config')).ConfigService
  crmDbService = (await import('../electron/services/crmDbService')).crmDbService
  setIdentity = (await import('../electron/services/identityService')).setIdentity
  LEAD_SLA_UNASSIGNED_SENTINEL = (await import('../shared/leadSla')).LEAD_SLA_UNASSIGNED_SENTINEL
  const { assignLeads, claimLead, recycleAssignment, transferAssignment, listAssignments } = await import('../electron/services/crmAssignmentService')
  const {
    runLanSyncOnce, deliveryKey, deliveryFileName, deliveryBase, emitDownEvents, consumeDownEvents, processUpAcks, settleDownDeliveries
  } = await import('../electron/services/lanSyncService')
  const { buildOwnerMap, filterLeadsForView, isSalesView } = await import('../src/utils/leadAssignmentView')
  const RK_JIA = deliveryKey(S_JIA)
  const RK_YI = deliveryKey(S_YI)
  const cfg = ConfigService.getInstance()
  cfg.set('crmSalesList', [S_JIA, S_YI])
  cfg.set('crmLeadSlaHours', 24)
  cfg.set('lanSyncSharedDir', shared)
  cfg.set('lanSyncRole', 'hub')
  setIdentity(HUB, '主管')
  await crmDbService.initialize(dirHub)

  // ── ① 中枢分配：甲得张老板、乙得李老板 → 各自队列定向落盘（落盘 ≠ 已接收）────
  console.log('═══ ① 中枢分配 → 定向投递（甲/乙各自独立队列，outbox 保持 pending）═══')
  const l1 = seedLeadOnHub('13922221111', '张老板')
  const l2 = seedLeadOnHub('13922223333', '李老板')
  const r1 = assignLeads([l1], S_JIA, HUB)
  const r2 = assignLeads([l2], S_YI, HUB)
  ok('1.1 中枢两条分配成功', r1.ok && r2.ok)
  const roundHub1 = runLanSyncOnce()
  ok('1.2 下行产出 2 条、无失败', roundHub1.down?.emitted === 2 && roundHub1.down?.failed === 0, JSON.stringify(roundHub1.down))
  ok('1.3 甲队列 1 个文件（张老板 apply）、乙队列 1 个文件（李老板 apply）——互不可见',
    queueFiles(RK_JIA).length === 1 && queueFiles(RK_YI).length === 1 &&
    JSON.parse(readFileSync(join(queueDir(RK_JIA), queueFiles(RK_JIA)[0]), 'utf-8')).payload.salesName === S_JIA &&
    JSON.parse(readFileSync(join(queueDir(RK_YI), queueFiles(RK_YI)[0]), 'utf-8')).payload.salesName === S_YI,
    `jia=${queueFiles(RK_JIA).join(',')} yi=${queueFiles(RK_YI).join(',')}`)
  ok('1.4 文件落盘 ≠ 终端已接收：outbox 两行仍 pending（等 ACK）',
    crmDbService.all("SELECT COUNT(*) AS c FROM outbox_event WHERE status = 'pending'")[0].c === 2)

  // ── ② 乙先轮询：不能消费、删除或看到甲的事件（断言 2/3 前半 + 断言 1 前半）───
  console.log('\n═══ ② 乙先轮询（甲离线）：甲的事件字节级不动，乙只拿到自己的 ═══')
  await switchTo('jia') // 先把甲的库建好（fresh 空库）再回到乙，保证「甲离线」状态
  ok('2.0 甲终端库 fresh 空库（0 lead / 0 assignment）',
    crmDbService.all('SELECT COUNT(*) AS c FROM lead')[0].c === 0 && crmDbService.all('SELECT COUNT(*) AS c FROM assignment')[0].c === 0)
  await switchTo('yi')
  const jiaFileBefore = queueFiles(RK_JIA)[0]
  const jiaBytesBefore = readFileSync(join(queueDir(RK_JIA), jiaFileBefore))
  const roundYi1 = runLanSyncOnce()
  ok('2.1 乙轮询只消费自己的队列：applied=1（李老板），失败 0',
    roundYi1.consumeDown?.applied === 1 && roundYi1.consumeDown?.failed === 0, JSON.stringify(roundYi1.consumeDown))
  ok('2.2 甲的事件文件字节级原样保留（乙没看见、没删、没改）',
    queueFiles(RK_JIA).length === 1 && queueFiles(RK_JIA)[0] === jiaFileBefore &&
    Buffer.compare(jiaBytesBefore, readFileSync(join(queueDir(RK_JIA), jiaFileBefore))) === 0)
  ok('2.3 乙库里只有李老板：张老板根本不存在（看不到甲的线索）',
    !!leadByPhone('13922223333') && !leadByPhone('13922221111'))
  const yiLead2 = leadByPhone('13922223333')!
  ok('2.4 乙库出现李老板的分配（assigned/销售甲?否/销售乙/source=sync:down）',
    assignmentsOf(Number(yiLead2.id)).length === 1 && assignmentsOf(Number(yiLead2.id))[0].sales_name === S_YI &&
    assignmentsOf(Number(yiLead2.id))[0].status === 'assigned' && assignmentsOf(Number(yiLead2.id))[0].source === 'sync:down')
  // 乙视角过滤：只见自己的 1 条
  const yiAll = crmDbService.all('SELECT * FROM lead ORDER BY id')
  const yiOwnerMap = buildOwnerMap(listAssignments({ pageSize: 100000 }).data.rows as never)
  ok('2.5 乙视角只见自己的 1 条；甲视角（在乙库模拟）为 0 条',
    isSalesView({ name: S_YI, role: '销售' }) && filterLeadsForView(yiAll, yiOwnerMap, { name: S_YI, role: '销售' }).length === 1 &&
    filterLeadsForView(yiAll, yiOwnerMap, { name: S_JIA, role: '销售' }).length === 0)

  // ── ③ 甲离线期间乙正常工作（认领 + 上行），甲的待投递不受影响（断言 3）──────
  console.log('\n═══ ③ 甲离线期间乙正常工作：认领 + 上行，甲的事件不受影响 ═══')
  const claimYi = claimLead(Number(yiLead2.id), '')
  ok('3.1 乙认领李老板成功（身份档案判本人）', claimYi.ok === true, JSON.stringify(claimYi))
  const roundYi2 = runLanSyncOnce()
  ok('3.2 乙上行产出（claim + audit 游标）', (roundYi2.emitUp?.emitted || 0) >= 2, JSON.stringify(roundYi2.emitUp))
  ok('3.3 甲离线中：甲的队列文件仍在、甲库仍 0 分配（乙的往返零影响）',
    queueFiles(RK_JIA).length === 1 && queueFiles(RK_JIA)[0] === jiaFileBefore &&
    Buffer.compare(jiaBytesBefore, readFileSync(join(queueDir(RK_JIA), jiaFileBefore))) === 0)

  // ── ④ 甲恢复联网：收到积压事件；分给甲的线索只有甲能领取（断言 4/1）─────────
  console.log('\n═══ ④ 甲恢复：消费积压 assign → 本地事务齐备；只有甲能领取 ═══')
  await switchTo('jia')
  const roundJia1 = runLanSyncOnce()
  ok('4.1 甲恢复后收到积压事件：applied=1、队列清空',
    roundJia1.consumeDown?.applied === 1 && queueFiles(RK_JIA).length === 0, JSON.stringify(roundJia1.consumeDown))
  const jiaLead1 = leadByPhone('13922221111')!
  const jiaAsg1 = assignmentsOf(Number(jiaLead1.id))
  ok('4.2 甲库张老板资料与分配齐备（assigned/销售甲/sla1 期限/sync:down + 首触期限同步）',
    jiaLead1.name === '张老板' && jiaAsg1.length === 1 && jiaAsg1[0].sales_name === S_JIA &&
    jiaAsg1[0].status === 'assigned' && Number(jiaAsg1[0].sla1_deadline) > 0 &&
    Number(jiaLead1.first_contact_deadline) === Number(jiaAsg1[0].sla1_deadline))
  const claimJia = claimLead(Number(jiaLead1.id), '')
  ok('4.3 分给甲的线索甲能领取（claimed）', claimJia.ok === true, JSON.stringify(claimJia))
  const roundJia2 = runLanSyncOnce()
  ok('4.4 甲上行 claim 回执 + ACK 已写（applied）',
    (roundJia2.emitUp?.emitted || 0) >= 1 && existsSync(join(shared, 'up', S_JIA, 'ack')) &&
    readdirSync(join(shared, 'up', S_JIA, 'ack')).some((f) => f.endsWith('.json')))

  // ── ⑤ 中枢结算：全部 ACK → 行 sent；消费乙的 claim 回执 ─────────────────────
  console.log('\n═══ ⑤ 中枢消费 ACK/上行 → 投递完成（sent）═══')
  await switchTo('hub')
  const roundHub2 = runLanSyncOnce()
  ok('5.1 中枢消费 ACK 记录 + 上行（claim/audit）', (roundHub2.acks?.recorded || 0) >= 2 && (roundHub2.up?.applied || 0) >= 1,
    JSON.stringify({ acks: roundHub2.acks, up: roundHub2.up }))
  ok('5.2 两条 assign 投递全部 ACK applied → outbox 标 sent（中枢收到 ACK 才完成）',
    crmDbService.all("SELECT COUNT(*) AS c FROM outbox_event WHERE status = 'sent'")[0].c === 2 &&
    crmDbService.all("SELECT COUNT(*) AS c FROM outbox_event WHERE status = 'pending'")[0].c === 0)
  ok('5.3 中枢侧李老板 claim 回执落地（status=claimed）',
    String(assignmentsOf(l2)[0]?.status) === 'claimed')

  // ── ⑥ transfer（乙 → 甲）：双接收者独立投递；单方 ACK 不提前清理（断言 5/8）──
  console.log('\n═══ ⑥ transfer 李老板 乙→甲：apply + remove 双投递，单方 ACK 不结算 ═══')
  const yiAsg2 = assignmentsOf(l2)[0]
  const tr = transferAssignment(Number(yiAsg2.id), S_JIA, 'e2e 调派', HUB)
  ok('6.1 中枢调派成功', tr.ok === true)
  emitDownEvents(shared)
  ok('6.2 双接收者独立投递：甲队列 apply 文件 + 乙队列 remove 文件',
    queueFiles(RK_JIA).some((f) => f.includes('-apply.json')) && queueFiles(RK_YI).some((f) => f.includes('-remove.json')),
    `jia=${queueFiles(RK_JIA).join(',')} yi=${queueFiles(RK_YI).join(',')}`)
  // 甲先消费并 ACK
  await switchTo('jia')
  const roundJia3 = consumeDownEvents(shared)
  ok('6.3 甲消费 apply：新行 assigned 归甲（旧无行）', roundJia3.applied === 1, JSON.stringify(roundJia3))
  const jiaLead2 = leadByPhone('13922223333')!
  const jiaAsgs2 = assignmentsOf(Number(jiaLead2.id))
  ok('6.4 甲库出现李老板新权属（assigned/销售甲）', jiaAsgs2.length === 1 && jiaAsgs2[0].sales_name === S_JIA && jiaAsgs2[0].status === 'assigned')
  // 中枢只收到甲的 ACK：行必须仍 pending，乙的 remove 文件必须保留（断言 8）
  await switchTo('hub')
  processUpAcks(shared)
  const settleMid = settleDownDeliveries(shared)
  const trRow = crmDbService.all('SELECT * FROM outbox_event WHERE payload LIKE ? ORDER BY event_seq DESC LIMIT 1', [`%"oldAssignmentId":${Number(yiAsg2.id)}%`])[0]
  ok('6.5 单接收者 ACK 不提前清理：transfer 行仍 pending、乙队列 remove 文件原样保留',
    String(trRow?.status) === 'pending' && queueFiles(RK_YI).some((f) => f.includes('-remove.json')) && settleMid.completed === 0,
    JSON.stringify({ settle: settleMid, status: trRow?.status, yi: queueFiles(RK_YI) }))
  // 乙消费 remove：失去线索，绝不出现甲的新行（断言 5）
  await switchTo('yi')
  const roundYi3 = consumeDownEvents(shared)
  const yiAsgs2After = assignmentsOf(Number(yiLead2.id))
  ok('6.6 乙消费 remove：本地行 transferred、绝不为甲建新行（原销售失去线索）',
    roundYi3.applied === 1 && yiAsgs2After.length === 1 && yiAsgs2After[0].status === 'transferred' &&
    crmDbService.all('SELECT COUNT(*) AS c FROM assignment WHERE lead_id = ? AND sales_name = ?', [Number(yiLead2.id), S_JIA])[0].c === 0,
    JSON.stringify({ r: roundYi3, rows: yiAsgs2After.map((a) => ({ status: a.status, sales: a.sales_name })) }))
  ok('6.7 乙视角资源卡清零（李老板已不属乙）', (() => {
    const all = crmDbService.all('SELECT * FROM lead ORDER BY id')
    const map = buildOwnerMap(listAssignments({ pageSize: 100000 }).data.rows as never)
    return filterLeadsForView(all, map, { name: S_YI, role: '销售' }).length === 0
  })())
  await switchTo('hub')
  const roundHub3 = runLanSyncOnce()
  ok('6.8 双方 ACK 齐后 transfer 行标 sent',
    String(crmDbService.all('SELECT status FROM outbox_event WHERE id = ?', [Number(trRow.id)])[0]?.status) === 'sent' &&
    (roundHub3.settle?.completed || 0) >= 1, JSON.stringify(roundHub3.settle))

  // ── ⑥b transfer 失败隔离：新销售 conflict、原销售离线，结算后 remove 不得再应用 ──
  console.log('\n═══ ⑥b transfer 失败隔离：新销售 conflict + 原销售离线 ═══')
  const failPhone = '13922225555'
  const lFail = seedLeadOnHub(failPhone, '隔离线索')
  assignLeads([lFail], S_YI, HUB)
  emitDownEvents(shared)
  await switchTo('yi')
  const initialYi = runLanSyncOnce()
  await switchTo('hub')
  const initialHub = runLanSyncOnce()
  const yiOriginalLead = leadByPhone(failPhone)!
  ok('6b.1 原销售先收到初始归属并完成 ACK',
    initialYi.consumeDown?.applied === 1 && initialHub.acks?.recorded === 1 && initialHub.settle?.completed === 1 &&
    assignmentsOf(Number(yiOriginalLead.id))[0]?.sales_name === S_YI, JSON.stringify({ yi: initialYi, hub: initialHub }))

  await switchTo('jia')
  const jiaConflictLead = seedLeadOnHub(failPhone, '隔离线索')
  assignLeads([jiaConflictLead], S_JIA, S_JIA) // 新销售已有有效归属，transfer-apply 必须 conflict
  const jiaConflictRows = assignmentsOf(jiaConflictLead)
  await switchTo('hub')
  const yiHubAssignment = assignmentsOf(lFail).find((a) => a.sales_name === S_YI && a.status === 'assigned')!
  const failTransfer = transferAssignment(Number(yiHubAssignment.id), S_JIA, 'e2e 失败隔离', HUB)
  emitDownEvents(shared)
  ok('6b.2 transfer 生成新销售 apply 与原销售 remove',
    failTransfer.ok && queueFiles(RK_JIA).some((f) => f.includes('-apply.json')) && queueFiles(RK_YI).some((f) => f.includes('-remove.json')),
    `jia=${queueFiles(RK_JIA).join(',')} yi=${queueFiles(RK_YI).join(',')}`)

  await switchTo('jia')
  const failJiaRound = runLanSyncOnce()
  await switchTo('hub') // 原销售保持离线，先由中枢结算新销售的终态 conflict
  const failHubRound = runLanSyncOnce()
  const failTransferRow = crmDbService.all('SELECT * FROM outbox_event WHERE idempotency_key = ?', [`transfer:${failTransfer.data?.assignmentId}`])[0]
  const failedDir = join(queueDir(RK_YI), '.failed')
  const failedRemove = existsSync(failedDir) ? readdirSync(failedDir).find((f) => f.includes('-remove.json')) : undefined
  ok('6b.3 新销售 conflict → 中枢结算 transfer failed，原销售 remove 进入 .failed',
    failJiaRound.consumeDown?.conflict === 1 && failHubRound.settle?.failedRows === 1 && String(failTransferRow?.status) === 'failed' &&
    !!failedRemove && existsSync(join(queueDir(RK_YI), '.failed', failedRemove)),
    JSON.stringify({ jia: failJiaRound, jiaConflictRows, hub: failHubRound, status: failTransferRow?.status, failedRemove }))
  ok('6b.4 结算后活动队列没有原销售 remove 文件', !queueFiles(RK_YI).some((f) => f.includes('-remove.json')))

  await switchTo('yi')
  const offlineYiRound = runLanSyncOnce()
  const yiOriginalAfter = leadByPhone(failPhone)!
  ok('6b.5 原销售恢复轮询不再应用 remove，原归属保持有效',
    offlineYiRound.consumeDown?.applied === 0 && assignmentsOf(Number(yiOriginalAfter.id)).some((a) => a.sales_name === S_YI && a.status === 'assigned'),
    JSON.stringify({ round: offlineYiRound, rows: assignmentsOf(Number(yiOriginalAfter.id)) }))

  // ── ⑦ recycle：甲本地状态正确更新（断言 6）──────────────────────────────────
  console.log('\n═══ ⑦ 中枢回收甲的张老板 → 甲本地行 recycled + 期限回哨兵 ═══')
  await switchTo('hub')
  const jiaAsg1HubSide = assignmentsOf(l1)[0] // 中枢侧张老板当前分配行（甲已 claim）
  const rec = recycleAssignment(Number(jiaAsg1HubSide.id), 'e2e 人工回收', HUB)
  ok('7.1 中枢回收成功', rec.ok === true)
  emitDownEvents(shared)
  await switchTo('jia')
  const roundJia4 = consumeDownEvents(shared)
  const jiaLead1After = leadByPhone('13922221111')!
  const jiaAsg1After = assignmentsOf(Number(jiaLead1After.id))
  ok('7.2 甲消费 recycle：行 recycled + 首触期限回 2100 哨兵 + sync_apply 审计',
    roundJia4.applied === 1 && jiaAsg1After.length === 1 && jiaAsg1After[0].status === 'recycled' &&
    Number(jiaLead1After.first_contact_deadline) === LEAD_SLA_UNASSIGNED_SENTINEL &&
    crmDbService.all("SELECT COUNT(*) AS c FROM audit_event WHERE action = 'sync_apply' AND detail LIKE '%recycle%' AND entity_id = ?",
      [Number(jiaLead1After.id)])[0].c === 1,
    JSON.stringify({ r: roundJia4, rows: jiaAsg1After.map((a) => a.status) }))

  // ── ⑧ 重复投递 + 重复 ACK：零重复行（断言 7）────────────────────────────────
  console.log('\n═══ ⑧ 重复投递 + 重复 ACK → assignment/ownership_history/audit_event 零重复 ═══')
  const cnts = () => ({
    asg: Number(crmDbService.all('SELECT COUNT(*) AS c FROM assignment')[0].c),
    own: Number(crmDbService.all('SELECT COUNT(*) AS c FROM ownership_history')[0].c),
    aud: Number(crmDbService.all('SELECT COUNT(*) AS c FROM audit_event')[0].c)
  })
  const beforeDup = cnts()
  // 重复投递：重放一条等价事件（同 idempotencyKey，命中甲库 syncApplied；dup 路径会按记录 outcome 补写 ACK）
  const evSeq = Number(trRow.event_seq) + 100
  writeFileSync(join(queueDir(RK_JIA), deliveryFileName(evSeq, `assign:${r1.data!.assignments[0].assignmentId}`, 'apply')), JSON.stringify({
    eventSeq: evSeq, idempotencyKey: `assign:${r1.data!.assignments[0].assignmentId}`, type: 'assign', deliveryRole: 'apply', to: RK_JIA,
    payload: { type: 'assign', leadId: l1, salesName: S_JIA, sla1Deadline: NOW + 86400000,
      lead: { leadId: l1, name: '张老板', contactType: 'phone', contactNormalized: '13922221111', contactRaw: '13922221111', wechat: '', source: '抖音', note: 'e2e 备注' } },
    emittedAt: NOW
  }))
  const roundJia5 = consumeDownEvents(shared)
  const afterDup = cnts()
  ok('8.1 重复投递命中 syncApplied：skippedDup=1，assignment/ownership_history/audit_event 零新增',
    roundJia5.skippedDup === 1 && roundJia5.applied === 0 &&
    afterDup.asg === beforeDup.asg && afterDup.own === beforeDup.own && afterDup.aud === beforeDup.aud,
    JSON.stringify({ r: roundJia5, before: beforeDup, after: afterDup }))
  // 已结算 outbox 的迟到 ACK 不再被接受：对应 pending 不存在，必须隔离
  await switchTo('hub')
  const ackBefore = cnts()
  const roundHub4 = runLanSyncOnce()
  const afterAck = cnts()
  ok('8.2 已结算投递的迟到 ACK 进入 .bad，不产生重复业务写',
    (roundHub4.acks?.failed || 0) >= 1 &&
    existsSync(join(shared, 'up', S_JIA, 'ack', `${deliveryBase(`assign:${r1.data!.assignments[0].assignmentId}`, 'apply')}.json.bad`)) &&
    afterAck.asg === ackBefore.asg && afterAck.own === ackBefore.own && afterAck.aud === ackBefore.aud,
    JSON.stringify({ acks: roundHub4.acks, before: ackBefore, after: afterAck }))

  // ── ⑨ 中枢重启 + 终端重启后状态继续恢复（断言 9）────────────────────────────
  console.log('\n═══ ⑨ 双端重启：reopen 库 + 队列文件/幂等标记持久，同步继续恢复 ═══')
  const l3 = seedLeadOnHub('13922224444', '王老板')
  assignLeads([l3], S_JIA, HUB)
  emitDownEvents(shared)
  ok('9.1 新 assign 已定向落盘、行仍 pending（等 ACK）',
    queueFiles(RK_JIA).some((f) => f.includes('-apply.json')) &&
    crmDbService.all("SELECT COUNT(*) AS c FROM outbox_event WHERE status = 'pending'")[0].c === 1)
  // 中枢重启（reopen 库）
  await switchTo('hub')
  ok('9.2 中枢重启后状态恢复：pending 行仍在、队列文件仍在',
    crmDbService.all("SELECT COUNT(*) AS c FROM outbox_event WHERE status = 'pending'")[0].c === 1 && queueFiles(RK_JIA).length >= 1)
  // 终端重启（reopen 库）→ 消费积压
  await switchTo('jia')
  const roundJia6 = runLanSyncOnce()
  ok('9.3 甲终端重启后消费积压：applied=1 + ACK 落盘（syncApplied 标记持久可幂等）',
    roundJia6.consumeDown?.applied === 1 && readdirSync(join(shared, 'up', S_JIA, 'ack')).some((f) => f.endsWith('.json')),
    JSON.stringify(roundJia6.consumeDown))
  // 中枢重启 → 收 ACK → 结算完成
  await switchTo('hub')
  const l3Key = crmDbService.all('SELECT idempotency_key FROM outbox_event WHERE payload LIKE ? ORDER BY event_seq DESC LIMIT 1', [`%"leadId":${l3}%`])[0]?.idempotency_key || ''
  const roundHub5 = runLanSyncOnce()
  ok('9.4 中枢重启后收到 ACK 并结算：pending 清零（6 条全 sent，含失败隔离对照之外的成功投递）',
    crmDbService.all("SELECT COUNT(*) AS c FROM outbox_event WHERE status = 'pending'")[0].c === 0 &&
    crmDbService.all("SELECT COUNT(*) AS c FROM outbox_event WHERE status = 'sent'")[0].c === 6,
    JSON.stringify({ settle: roundHub5.settle, acks: roundHub5.acks }))
  ok('9.5 终端重启后重复投递同事件仍幂等（零新增）', await (async () => {
    await switchTo('jia') // 9.4 结束时停在 hub，这里必须回到甲终端再重复投递
    const c0 = cnts()
    writeFileSync(join(queueDir(RK_JIA), deliveryFileName(500, l3Key, 'apply')), JSON.stringify({
      eventSeq: 500, idempotencyKey: l3Key,
      type: 'assign', deliveryRole: 'apply', to: RK_JIA,
      payload: { type: 'assign', leadId: l3, salesName: S_JIA, sla1Deadline: NOW + 86400000,
        lead: { leadId: l3, name: '王老板', contactType: 'phone', contactNormalized: '13922224444', contactRaw: '13922224444', wechat: '', source: '抖音', note: 'e2e 备注' } },
      emittedAt: NOW
    }))
    const rr = consumeDownEvents(shared)
    const c1 = cnts()
    return rr.skippedDup === 1 && rr.applied === 0 && c1.asg === c0.asg && c1.own === c0.own && c1.aud === c0.aud
  })(), '重复投递应 skippedDup 且零业务写')

  console.log(`\n═══ 结果：${pass} 通过 / ${fail} 失败 ═══`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error('测试崩溃:', e); process.exit(1) })
