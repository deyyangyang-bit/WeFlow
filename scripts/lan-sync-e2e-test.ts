/**
 * lan-sync-e2e-test.ts —— Phase 1 内网同步最小版「模拟双机」端到端验证
 * （设计 docs/规划/Phase1-内网同步最小版-设计.md §5 三刀 + §4 四裁决）
 *
 * 拓扑：单进程内用 crmDbService.reopenForWxid 在两台「机器」间换库（各自 /tmp userData 目录
 *   各持一份独立 sql.js 库文件），共享目录 = /tmp 下一个文件夹模拟 SMB 挂载点：
 *     中枢 A（主管机，dirA，身份=测试主管）  ←→  <shared>/down/ + up/<终端>/  ←→  终端 B（销售机，dirB，身份=销售甲）
 * 配置（角色/共享目录/身份档案）按阶段切换 = 两台机器各自的本地配置。
 *
 * 闭环断言：
 *   1. A 分配 lead 给销售甲 → down 事件落盘（lead 基础资料+SLA 参数齐备）→ B 消费 → B 库出现该分配且资料齐全
 *   2. B 认领 → up 事件 → A 消费 → A 的 assignment 行 status=claimed
 *   3. 重复投递同一事件文件 → syncApplied 幂等零重复
 *   4. B 只见自己线索：filterLeadsForView（leadAssignmentView 口径）在销售甲视角只留自己的
 *   5. tmp 半截文件（只写 .tmp 不 rename）不被消费
 *   附：transfer/recycle 下行闭环 + 中枢不消费自己的 up 目录
 *
 * 隔离：WEFLOW_WORKER='1' + /tmp 落盘；两库均 fresh 空库，绝不碰 live 库、不起 Electron。
 * 运行：npx tsx scripts/lan-sync-e2e-test.ts
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'fs'
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

import { ConfigService } from '../electron/services/config'
import { crmDbService, type CrmRow } from '../electron/services/crmDbService'
import { setIdentity } from '../electron/services/identityService'
import { assignLeads, claimLead, transferAssignment, listAssignments } from '../electron/services/crmAssignmentService'
import { runLanSyncOnce, getTerminalId } from '../electron/services/lanSyncService'
import { buildOwnerMap, filterLeadsForView, isSalesView } from '../src/utils/leadAssignmentView'
import { LEAD_SLA_UNASSIGNED_SENTINEL } from '../shared/leadSla'

const HUB = '测试主管'
const S_JIA = '销售甲'
const S_YI = '销售乙'
const NOW = Date.now()

const dirA = mkdtempSync(join(tmpdir(), 'lansync-e2e-hub-'))
const dirB = mkdtempSync(join(tmpdir(), 'lansync-e2e-terminal-'))
const shared = mkdtempSync(join(tmpdir(), 'lansync-e2e-shared-'))

function downDir(): string { return join(shared, 'down') }
function downJsonFiles(): string[] {
  return existsSync(downDir()) ? readdirSync(downDir()).filter((f) => f.endsWith('.json')).sort() : []
}
function upJsonFiles(tid: string): string[] {
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

/** 换机：落盘当前库 → 卸载 → 打开另一台机器的库（§2.40 分库切换同款链路） */
async function switchTo(machine: 'A' | 'B'): Promise<void> {
  const cfg = ConfigService.getInstance()
  if (machine === 'A') {
    cfg.set('lanSyncRole', 'hub')
    setIdentity(HUB, '主管')
  } else {
    cfg.set('lanSyncRole', 'terminal')
    setIdentity(S_JIA, '销售')
  }
  await crmDbService.reopenForWxid(machine === 'A' ? dirA : dirB)
}

async function main(): Promise<void> {
  const cfg = ConfigService.getInstance()
  cfg.set('crmSalesList', [S_JIA, S_YI])
  cfg.set('crmLeadSlaHours', 24)
  cfg.set('lanSyncSharedDir', shared)
  cfg.set('lanSyncRole', 'hub')
  setIdentity(HUB, '主管')
  await crmDbService.initialize(dirA)

  // ── ① 中枢 A 分配 → down 落盘 ─────────────────────────────────────────────
  console.log('═══ ① A 分配 lead 给销售甲/销售乙 → down 事件落盘 ═══')
  const l1 = seedLeadOnHub('13922221111', '张老板')
  const l2 = seedLeadOnHub('13922223333', '李老板')
  const r1 = assignLeads([l1], S_JIA, HUB)
  const r2 = assignLeads([l2], S_YI, HUB)
  ok('1.1 中枢两条分配成功', r1.ok && r2.ok)
  const roundA1 = runLanSyncOnce()
  ok('1.2 下行产出 2 条、无失败', roundA1.down?.emitted === 2 && roundA1.down?.failed === 0, JSON.stringify(roundA1.down))
  const dFiles = downJsonFiles()
  ok('1.3 down/ 一事件一 JSON（2 个文件）', dFiles.length === 2, dFiles.join(','))
  const evAssign1 = JSON.parse(readFileSync(join(downDir(), dFiles[0]), 'utf-8'))
  ok('1.4 事件含 eventSeq/idempotencyKey/payload（lead 基础资料+目标销售+SLA 参数）',
    evAssign1.eventSeq >= 1 && !!evAssign1.idempotencyKey && evAssign1.type === 'assign' &&
    evAssign1.payload.lead?.name === '张老板' && evAssign1.payload.lead?.contactNormalized === '13922221111' &&
    evAssign1.payload.salesName === S_JIA && evAssign1.payload.slaHours === 24 && evAssign1.payload.sla1Deadline > 0,
    JSON.stringify(evAssign1.payload))
  ok('1.5 中枢 outbox 两行已标 sent', crmDbService.all("SELECT COUNT(*) AS c FROM outbox_event WHERE status = 'sent'")[0].c === 2)
  // 留档 L1 的 assign 文件内容，供 ③ 重复投递用
  const redeliverCopy = join(isoDir, 'redeliver-copy.json')
  copyFileSync(join(downDir(), dFiles[0]), redeliverCopy)

  // ── ② 终端 B 消费下行 → 认领 → up 上行 ────────────────────────────────────
  console.log('\n═══ ② B 消费下行（库出现分配+资料齐全）→ 认领 → up 事件 ═══')
  await switchTo('B')
  ok('2.0 终端库是 fresh 空库（无 lead）', crmDbService.all('SELECT COUNT(*) AS c FROM lead')[0].c === 0)
  const roundB1 = runLanSyncOnce()
  ok('2.1 B 下行消费 applied=2', roundB1.consumeDown?.applied === 2 && roundB1.consumeDown?.failed === 0, JSON.stringify(roundB1.consumeDown))
  const bLead1 = leadByPhone('13922221111')
  ok('2.2 B 库出现该 lead 且基础资料齐全（姓名/来源/备注/联系方式）',
    !!bLead1 && bLead1.name === '张老板' && bLead1.source === '抖音' && bLead1.note === 'e2e 备注' && bLead1.contact_normalized === '13922221111',
    JSON.stringify(bLead1 && { name: bLead1.name, source: bLead1.source, note: bLead1.note }))
  const bAssign1 = bLead1 ? assignmentsOf(Number(bLead1.id)) : []
  ok('2.3 B 库出现该分配（assigned/销售甲/SLA1 期限齐备/source=sync:down）',
    bAssign1.length === 1 && bAssign1[0].status === 'assigned' && bAssign1[0].sales_name === S_JIA &&
    Number(bAssign1[0].sla1_deadline) > 0 && bAssign1[0].source === 'sync:down',
    JSON.stringify(bAssign1[0]))
  ok('2.4 B 的 lead 首触期限与中枢 sla1 一致（起计时口径）', Number(bLead1?.first_contact_deadline) === Number(bAssign1[0]?.sla1_deadline))
  ok('2.5 消费后 down/ 已清空', downJsonFiles().length === 0)

  // ②b 终端视角过滤（leadAssignmentView 口径）
  const bAll = crmDbService.all('SELECT * FROM lead ORDER BY id')
  const bOwnerMap = buildOwnerMap(listAssignments({ pageSize: 100000 }).data.rows as never)
  const viewJia = filterLeadsForView(bAll, bOwnerMap, { name: S_JIA, role: '销售' })
  const viewYi = filterLeadsForView(bAll, bOwnerMap, { name: S_YI, role: '销售' })
  ok('2.6 销售甲视角只见自己的 1 条（张老板）', isSalesView({ name: S_JIA, role: '销售' }) && viewJia.length === 1 && viewJia[0].id === Number(bLead1?.id))
  ok('2.7 销售乙视角只见自己的 1 条（李老板），管理视角看全部',
    viewYi.length === 1 && filterLeadsForView(bAll, bOwnerMap, { name: HUB, role: '主管' }).length === 2)

  // ②c B 认领 → 上行
  const claimRes = claimLead(Number(bLead1!.id), '')
  ok('2.8 B 认领成功（身份档案判本人）', claimRes.ok === true, JSON.stringify(claimRes))
  const roundB2 = runLanSyncOnce()
  ok('2.9 B 上行产出 claim + audit 游标事件', (roundB2.emitUp?.emitted || 0) >= 2, JSON.stringify(roundB2.emitUp))
  const upFiles = upJsonFiles(getTerminalId())
  ok('2.10 up/销售甲/ 目录落文件（claim 在内）', upFiles.length >= 2 && upFiles.some((f) => f.includes('claim')), upFiles.join(','))
  const claimUpEv = JSON.parse(readFileSync(join(shared, 'up', getTerminalId(), upFiles.find((f) => f.includes('claim'))!), 'utf-8'))
  ok('2.11 claim 事件键带终端前缀 + 附 lead 身份（供中枢解析）',
    claimUpEv.idempotencyKey.startsWith(`${S_JIA}/claim:`) && claimUpEv.payload.lead?.contactNormalized === '13922221111')

  // ── ③ 中枢 A 消费上行 → assignment claimed ────────────────────────────────
  console.log('\n═══ ③ A 消费上行 → assignment status=claimed ═══')
  await switchTo('A')
  const roundA2 = runLanSyncOnce()
  ok('3.1 A 上行消费 applied≥1（claim + audit）', (roundA2.up?.applied || 0) >= 1 && roundA2.up?.failed === 0, JSON.stringify(roundA2.up))
  const aAssign1 = assignmentsOf(l1)
  ok('3.2 A 的 assignment 行 status=claimed（updated_by 含销售甲署名）',
    aAssign1.length === 1 && aAssign1[0].status === 'claimed' && String(aAssign1[0].updated_by).includes(S_JIA),
    JSON.stringify(aAssign1[0] && { status: aAssign1[0].status, updated_by: aAssign1[0].updated_by }))
  ok('3.3 A 落 lead_claim 审计（via=sync:up 可溯源终端）',
    crmDbService.all("SELECT id FROM audit_event WHERE action = 'lead_claim' AND detail LIKE '%sync:up%'").length === 1)
  ok('3.4 消费后 up/销售甲/ 已清空', upJsonFiles(S_JIA).length === 0)
  ok('3.5 A 重跑一轮零消费（幂等，目录已空）', runLanSyncOnce().up?.applied === 0)

  // ── ④ 重复投递同一事件文件 → 幂等零重复 ───────────────────────────────────
  console.log('\n═══ ④ 重复投递（同一 assign 文件再放回 down/）→ B 幂等零重复 ═══')
  await switchTo('B')
  const bAssignCountBefore = crmDbService.all('SELECT COUNT(*) AS c FROM assignment')[0].c
  const bLeadCountBefore = crmDbService.all('SELECT COUNT(*) AS c FROM lead')[0].c
  copyFileSync(redeliverCopy, join(downDir(), 'redeliver.json'))
  const roundB3 = runLanSyncOnce()
  ok('4.1 重复投递命中 syncApplied（skippedDup=1，零业务写）',
    roundB3.consumeDown?.skippedDup === 1 && roundB3.consumeDown?.applied === 0, JSON.stringify(roundB3.consumeDown))
  ok('4.2 B 的 lead/assignment 行数零变化', crmDbService.all('SELECT COUNT(*) AS c FROM assignment')[0].c === bAssignCountBefore &&
    crmDbService.all('SELECT COUNT(*) AS c FROM lead')[0].c === bLeadCountBefore)

  // ── ⑤ tmp 半截文件不被消费 ────────────────────────────────────────────────
  console.log('\n═══ ⑤ tmp 半截文件（只写 .tmp 不 rename）不被消费 ═══')
  const halfEv = JSON.parse(readFileSync(redeliverCopy, 'utf-8'))
  halfEv.idempotencyKey = 'assign:half-written-never-applied'
  writeFileSync(join(downDir(), '00000099-half.json.tmp'), JSON.stringify(halfEv))
  const roundB4 = runLanSyncOnce()
  ok('5.1 半截 .tmp 不入消费视野（applied/failed/skipped 全 0）且原样保留',
    roundB4.consumeDown?.applied === 0 && roundB4.consumeDown?.failed === 0 && roundB4.consumeDown?.skippedDup === 0 &&
    existsSync(join(downDir(), '00000099-half.json.tmp')) && crmDbService.getScanState('syncApplied:assign:half-written-never-applied') <= 0,
    JSON.stringify(roundB4.consumeDown))

  // ── ⑥ 附：transfer/recycle 下行闭环 + 中枢不消费自己的 up ─────────────────
  console.log('\n═══ ⑥ 附：transfer 下行闭环 + 中枢跳过自己的 up 目录 ═══')
  await switchTo('A')
  const aAssign2 = assignmentsOf(l2)[0]
  const tr = transferAssignment(Number(aAssign2.id), S_JIA, 'e2e 调派', HUB)
  ok('6.1 A 调派李老板 销售乙→销售甲 成功', tr.ok === true)
  const roundA3 = runLanSyncOnce()
  ok('6.2 调派下行产出 1 条', roundA3.down?.emitted === 1, JSON.stringify(roundA3.down))
  // 中枢自己的 up 目录放一条假事件：不应被消费
  const ownUpDir = join(shared, 'up', getTerminalId())
  mkdirSync(ownUpDir, { recursive: true })
  writeFileSync(join(ownUpDir, 'self-claim.json'), JSON.stringify({
    eventSeq: 99, idempotencyKey: `${HUB}/claim:999`, type: 'claim',
    payload: { leadId: l2, actor: HUB }, emittedAt: NOW, from: HUB
  }))
  await switchTo('B')
  const roundB5 = runLanSyncOnce()
  ok('6.3 B 消费 transfer：旧行 transferred + 新行 assigned 归销售甲', (() => {
    const bLead2 = leadByPhone('13922223333')
    if (!bLead2) return false
    const rows = assignmentsOf(Number(bLead2.id))
    return roundB5.consumeDown?.applied === 1 && rows.length === 2 &&
      rows[0].status === 'transferred' && rows[1].status === 'assigned' && rows[1].sales_name === S_JIA
  })(), JSON.stringify(roundB5.consumeDown))
  ok('6.4 调派后 B 销售甲视角变 2 条（只见自己线索口径成立）', (() => {
    const all = crmDbService.all('SELECT * FROM lead ORDER BY id')
    const map = buildOwnerMap(listAssignments({ pageSize: 100000 }).data.rows as never)
    return filterLeadsForView(all, map, { name: S_JIA, role: '销售' }).length === 2
  })())
  await switchTo('A')
  const roundA4 = runLanSyncOnce()
  ok('6.5 中枢不消费自己的 up 目录（self-claim.json 原样保留、无 claimed 误写）',
    existsSync(join(ownUpDir, 'self-claim.json')) &&
    crmDbService.getScanState(`syncApplied:${HUB}/claim:999`) <= 0 &&
    String(assignmentsOf(l2)[1]?.status) === 'assigned',
    JSON.stringify(roundA4.up))

  console.log(`\n═══ 结果：${pass} 通过 / ${fail} 失败 ═══`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error('测试崩溃:', e); process.exit(1) })
