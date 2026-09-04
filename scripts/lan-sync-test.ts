/**
 * lan-sync-test.ts —— Phase 1 内网同步最小版单元验证（设计 docs/规划/Phase1-内网同步最小版-设计.md）
 *
 * 覆盖：
 *   A. 同步开关：目录/角色未配置 = 静默关闭；runLanSyncOnce 零副作用
 *   B. 中枢下行产出：assign → pending outbox → down/ 事件文件（payload 含 lead 基础资料+SLA 参数）→ sent；
 *      目录不可写时保持 pending 下轮重放（R3 积压语义）
 *   C. 上行产出（终端）：claim → up/<终端标识>/ 事件文件（键带终端前缀）；audit 游标逐条产出 +
 *      Q4 字段裁剪（五字段）+ detail 脱敏（手机号中段打码，复用前端 maskLead 格式；wxid/身份证 ***）
 *   D. Q2 拦截：lead 已挂 account → recycleAssignment E205 + 审计 reason='converted_skip' +
 *      不下发 recycle 事件 + 重复命中不刷屏（scan_state 标记一行一条审计）
 *   E. first_touch 写点：updateLeadStatus(contacted) 登记 outbox；completeLeadFirstContact 同 key 幂等不重复
 *   F. 消费侧韧性：毒文件改名 .bad 隔离；.tmp 半截文件不被消费；重复投递命中 syncApplied: 幂等零重复；
 *      中枢不消费自己的 up 目录；本地已有有效归属时下行 assign 不覆盖（conflict 标记已应用留人工）
 *
 * 隔离：WEFLOW_WORKER='1' + /tmp 落盘；crmDb/salesDb 均 fresh 空库，绝不碰 live 库。
 * 运行：npx tsx scripts/lan-sync-test.ts
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const isoDir = mkdtempSync(join(tmpdir(), 'lansync-test-'))
process.env.WEFLOW_WORKER = '1'
process.env.WEFLOW_USER_DATA_PATH = isoDir
process.env.WEFLOW_CONFIG_CWD = isoDir

let pass = 0, fail = 0
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; console.log(`  ✅ ${name}`) } else { fail++; console.log(`  ❌ ${name} ${detail}`) }
}

import { ConfigService } from '../electron/services/config'
import { crmDbService, type CrmRow } from '../electron/services/crmDbService'
import { salesDbService } from '../electron/services/salesDbService'
import { setIdentity } from '../electron/services/identityService'
import { assignLeads, claimLead, recycleAssignment } from '../electron/services/crmAssignmentService'
import { updateLeadStatus, updateLeadProfile, completeLeadFirstContact } from '../electron/services/crmLeadService'
import {
  getLanSyncConfig, getTerminalId, emitDownEvents, consumeDownEvents, emitUpEvents, consumeUpEvents,
  runLanSyncOnce, lanSyncStatus, maskAuditText
} from '../electron/services/lanSyncService'
import { LEAD_SLA_UNASSIGNED_SENTINEL } from '../shared/leadSla'

const NOW = Date.now()
const SALES = '测试销售甲'

function seedLead(tag: string, phone: string): number {
  return crmDbService.runTx((tx) => tx.run(
    'INSERT INTO lead (contact_type, contact_normalized, contact_raw, wechat, source, name, note, status, first_contact_deadline, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    ['phone', phone, tag, '', '测试', tag, '', 'NEW', LEAD_SLA_UNASSIGNED_SENTINEL, NOW, NOW]
  ))
}
function outboxPending(): CrmRow[] {
  return crmDbService.all("SELECT * FROM outbox_event WHERE status = 'pending' ORDER BY event_seq")
}
function auditRows(action?: string): CrmRow[] {
  return action
    ? crmDbService.all('SELECT * FROM audit_event WHERE action = ? ORDER BY id', [action])
    : crmDbService.all('SELECT * FROM audit_event ORDER BY id')
}
function downFiles(root: string): string[] {
  const d = join(root, 'down')
  return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.json')) : []
}

async function main(): Promise<void> {
  const cfg = ConfigService.getInstance()
  cfg.set('crmSalesList', [SALES])
  cfg.set('crmLeadSlaHours', 24)
  const dbDir = mkdtempSync(join(tmpdir(), 'lansync-test-db-'))
  await crmDbService.initialize(dbDir)
  await salesDbService.initialize(dbDir)
  const shared = mkdtempSync(join(tmpdir(), 'lansync-shared-'))

  console.log('═══ A. 同步开关（未配置 = 静默关闭）═══')
  ok('A1 目录空 → enabled=false', getLanSyncConfig().enabled === false)
  cfg.set('lanSyncSharedDir', shared)
  ok('A2 只配目录不配角色 → 仍关闭', getLanSyncConfig().enabled === false)
  const r0 = runLanSyncOnce()
  ok('A3 未配置时 runLanSyncOnce 零副作用（无产出目录）', !existsSync(join(shared, 'down')) && r0.down === undefined)
  cfg.set('lanSyncRole', 'hub')
  ok('A4 目录+角色齐全 → enabled', getLanSyncConfig().enabled && getLanSyncConfig().role === 'hub')
  ok('A5 非法角色值归一为未配置', (() => { cfg.set('lanSyncRole', 'bogus'); const e = getLanSyncConfig().enabled; cfg.set('lanSyncRole', 'hub'); return !e })())

  console.log('\n═══ B. 中枢下行产出（设计 §5 刀1）═══')
  setIdentity('测试主管', '主管')
  const lb = seedLead('B-线索', '13911112222')
  const ra = assignLeads([lb], SALES, '测试主管')
  const aid = ra.data!.assignments[0].assignmentId
  ok('B1 assign 后 outbox pending=1', outboxPending().length === 1)
  const em1 = emitDownEvents(shared)
  ok('B2 下行产出 1 条', em1.emitted === 1 && em1.failed === 0, JSON.stringify(em1))
  const dFiles = downFiles(shared)
  ok('B3 down/ 落一事件一 JSON 文件', dFiles.length === 1, dFiles.join(','))
  const ev1 = JSON.parse(readFileSync(join(shared, 'down', dFiles[0]), 'utf-8'))
  ok('B4 事件字段齐备（eventSeq/idempotencyKey/type/payload/emittedAt）',
    ev1.eventSeq === 1 && ev1.idempotencyKey === `assign:${aid}` && ev1.type === 'assign' && typeof ev1.emittedAt === 'number')
  ok('B5 payload 含 lead 基础资料 + 目标销售 + SLA 参数（设计 §3）',
    ev1.payload.lead?.contactNormalized === '13911112222' && ev1.payload.lead?.name === 'B-线索' &&
    ev1.payload.salesName === SALES && ev1.payload.slaHours === 24 && ev1.payload.sla1Deadline > 0,
    JSON.stringify(ev1.payload))
  ok('B6 产出后 outbox 行 status=sent', outboxPending().length === 0 && crmDbService.all("SELECT id FROM outbox_event WHERE status = 'sent'").length === 1)
  ok('B7 重跑零产出（无 pending）', emitDownEvents(shared).emitted === 0)
  // R3：目录不可写 → 保持 pending 等重放
  const lc = seedLead('B-线索2', '13911113333')
  assignLeads([lc], SALES, '测试主管')
  const blocker = mkdtempSync(join(tmpdir(), 'lansync-block-'))
  writeFileSync(join(blocker, 'afile'), 'x') // 文件占名，下级 mkdir 必失败
  const badRoot = join(blocker, 'afile', 'sub')
  const emBad = emitDownEvents(badRoot)
  ok('B8 目录不可写：整轮跳过、pending 保留等重放（R3）', emBad.failed === -1 && outboxPending().length === 1, JSON.stringify(emBad))
  ok('B9 恢复可写后重放成功', emitDownEvents(shared).emitted === 1 && outboxPending().length === 0)

  console.log('\n═══ C. 终端上行产出（设计 §5 刀2：claim + audit 游标 + Q4 裁剪脱敏）═══')
  cfg.set('lanSyncRole', 'terminal')
  setIdentity(SALES, '销售')
  ok('C1 终端标识 = 身份档案姓名', getTerminalId() === SALES)
  // 本地有一条可认领的分配（B9 的第二条 assign 下行已被本测试直接消费场景化——这里直接本地 claim 已有行）
  const claimRes = claimLead(lb, '')
  ok('C2 认领成功（服务端身份档案判本人）', claimRes.ok === true, JSON.stringify(claimRes))
  // 造一条含手机号的审计行验证 Q4 脱敏
  crmDbService.runTx((tx) => {
    tx.run('INSERT INTO audit_event (actor, action, entity_type, entity_id, detail, created_at) VALUES (?,?,?,?,?,?)',
      [SALES, 'lead_note', 'lead', lb, JSON.stringify({ text: '客户手机 13812345678，wxid_secret99，身份证 11010119900307771X 已记录' }), NOW])
  })
  const upDir = join(shared, 'up', SALES)
  const emUp = emitUpEvents(shared)
  const upFiles = existsSync(upDir) ? readdirSync(upDir).filter((f) => f.endsWith('.json')) : []
  ok('C3 上行产出 = claim 事件 + audit 游标事件（≥2 文件）', emUp.emitted >= 2 && upFiles.length >= 2, `emitted=${emUp.emitted} files=${upFiles.join(',')}`)
  const claimFile = upFiles.find((f) => f.includes('claim'))
  const claimEv = claimFile ? JSON.parse(readFileSync(join(upDir, claimFile), 'utf-8')) : null
  ok('C4 上行键带终端标识前缀（全局唯一）+ from 字段', !!claimEv && claimEv.idempotencyKey.startsWith(`${SALES}/claim:`) && claimEv.from === SALES, String(claimEv?.idempotencyKey))
  const auditEvFiles = upFiles.filter((f) => f.startsWith('audit-'))
  ok('C5 audit 事件按游标逐条产出', auditEvFiles.length >= 2, auditEvFiles.join(','))
  const auditEvs = auditEvFiles.map((f) => JSON.parse(readFileSync(join(upDir, f), 'utf-8')))
  const noteEv = auditEvs.find((e) => e.payload.action === 'lead_note')
  ok('C6 Q4 字段裁剪：audit 上行只含五字段 + idempotencyKey',
    !!noteEv && Object.keys(noteEv.payload).sort().join(',') === 'action,actor,detail,entity_id,entity_type', JSON.stringify(noteEv && Object.keys(noteEv.payload)))
  ok('C7 Q4 脱敏：手机号中段打码 + wxid/身份证 ***，不出原文',
    !!noteEv && noteEv.payload.detail.includes('138****5678') && !noteEv.payload.detail.includes('13812345678') &&
    !noteEv.payload.detail.includes('wxid_secret99') && !noteEv.payload.detail.includes('11010119900307771X'),
    String(noteEv?.payload?.detail))
  ok('C8 sync_apply 同步层审计永不上行（防回声）', !auditEvs.some((e) => String(e.payload.action).startsWith('sync_')))
  ok('C9 重跑零新增（游标已推进 + outbox 已 sent）', emitUpEvents(shared).emitted === 0)
  ok('C10 maskAuditText 单测：手机中段打码/wxid/身份证', maskAuditText('致电 13912345678 加 wxid_abc123 证 11010119900307771X') === '致电 139****5678 加 *** 证 ***', maskAuditText('致电 13912345678 加 wxid_abc123 证 11010119900307771X'))

  console.log('\n═══ D. Q2 拦截：已转客户 lead 不回收、不下发、审计一行 ═══')
  const ld = seedLead('D-线索', '13911114444')
  assignLeads([ld], SALES, '测试主管')
  const dAid = Number(crmDbService.all("SELECT id FROM assignment WHERE lead_id = ? AND status = 'assigned'", [ld])[0].id)
  crmDbService.runTx((tx) => { tx.run('UPDATE lead SET account_id = 999 WHERE id = ?', [ld]) }) // 模拟已转客户
  const outboxBefore = crmDbService.all('SELECT COUNT(*) AS c FROM outbox_event')[0].c
  const rec1 = recycleAssignment(dAid, 'SLA超时回收', 'system:sla')
  ok('D1 E205 拦截 + 行保持 assigned', rec1.ok === false && rec1.code === 'E205' &&
    String(crmDbService.all('SELECT status FROM assignment WHERE id = ?', [dAid])[0].status) === 'assigned', JSON.stringify(rec1))
  const skipAudits = auditRows('lead_recycle').filter((r) => String(r.detail).includes('converted_skip'))
  ok('D2 审计落行 reason=converted_skip', skipAudits.length === 1 && Number((skipAudits[0] as CrmRow).entity_id) === ld, JSON.stringify(skipAudits.map((r) => r.detail)))
  ok('D3 不下发 recycle 事件（outbox 零新增）', Number(crmDbService.all('SELECT COUNT(*) AS c FROM outbox_event')[0].c) === Number(outboxBefore))
  recycleAssignment(dAid, 'SLA超时回收', 'system:sla')
  ok('D4 回收器再次命中不重复审计（scan_state 防刷屏）', auditRows('lead_recycle').filter((r) => String(r.detail).includes('converted_skip')).length === 1)
  // 未转客户的正常回收不受影响
  const le = seedLead('D-线索2', '13911115555')
  assignLeads([le], SALES, '测试主管')
  const eAid = Number(crmDbService.all("SELECT id FROM assignment WHERE lead_id = ? AND status = 'assigned'", [le])[0].id)
  ok('D5 未转客户正常回收（对照组）', recycleAssignment(eAid, '人工回收', '测试主管').ok === true)

  console.log('\n═══ E. first_touch 上行写点（Q1 对照：行内编辑不上行）═══')
  const lf = seedLead('E-线索', '13911116666')
  assignLeads([lf], SALES, '测试主管')
  const pendBeforeEdit = outboxPending().length
  updateLeadProfile(lf, { name: '改名了' }) // Q1：行内编辑
  ok('E1 Q1：行内编辑不产生任何 outbox 事件', outboxPending().length === pendBeforeEdit,
    `pending=${outboxPending().length} before=${pendBeforeEdit}`)
  const pendBeforeTouch = outboxPending().length
  updateLeadStatus(lf, 'contacted', { channel: 'wechat' })
  const ftRows = outboxPending().filter((r) => String(r.payload).includes('first_touch'))
  ok('E2 首触登记 outbox first_touch（含 lead 身份与渠道）',
    ftRows.length === 1 && ftRows[0].idempotency_key === `first_touch:${lf}` &&
    String(ftRows[0].payload).includes('13911116666') && String(ftRows[0].payload).includes('WECHAT'),
    JSON.stringify(ftRows.map((r) => r.idempotency_key)))
  // completeLeadFirstContact 同 key 幂等（补一条 NEW 线索验证今日行动闭环路径）
  const lg = seedLead('E-线索2', '13911117777')
  assignLeads([lg], SALES, '测试主管')
  salesDbService.todoCreate({ display_name: 'x', title: 't', trigger_type: 'sla_lead', source_id: lg, status: 'pending' } as never)
  const gTask = salesDbService.todoList({ status: 'pending', limit: 100000 }).filter((t) => t.trigger_type === 'sla_lead' && Number(t.source_id) === lg)[0]
  ok('E3 今日行动完成首触登记 first_touch', completeLeadFirstContact(Number(gTask.id)) === true &&
    outboxPending().some((r) => r.idempotency_key === `first_touch:${lg}`))
  updateLeadStatus(lg, 'contacted', { channel: 'PHONE' }) // 已 CONTACTED 也会走 contacted 分支重写——key 相同被幂等吞掉
  ok('E4 同 key 重放幂等零重复', outboxPending().filter((r) => r.idempotency_key === `first_touch:${lg}`).length === 1)
  ok('E5 pending 增量 = ft×2 + lg 的 assign 登记（3 条，无多余事件）', outboxPending().length - pendBeforeTouch === 3, `pending=${outboxPending().length} before=${pendBeforeTouch}`)

  console.log('\n═══ F. 消费侧韧性（幂等/毒文件/半截 tmp/自己目录/冲突）═══')
  cfg.set('lanSyncRole', 'hub')
  // F1+F2 一轮消费：毒文件 + B 组两条 assign 下行（本机两 lead 均已有有效分配 → conflict 不覆盖）
  const aid2 = Number(crmDbService.all("SELECT id FROM assignment WHERE lead_id = ? AND status = 'assigned'", [lc])[0]?.id || 0)
  writeFileSync(join(shared, 'down', 'garbage.json'), '{not-json')
  const cd1 = consumeDownEvents(shared)
  ok('F1 毒文件改名 .bad 隔离不再重试', cd1.failed === 1 && existsSync(join(shared, 'down', 'garbage.json.bad')) && !existsSync(join(shared, 'down', 'garbage.json')))
  ok('F2 本机已有有效归属的 assign 下行 → conflict 不覆盖（两条）', cd1.conflict === 2 && cd1.applied === 0, JSON.stringify(cd1))
  ok('F3 conflict 也标 syncApplied（不反复重试）+ 文件清除',
    crmDbService.getScanState(`syncApplied:assign:${aid}`) > 0 && crmDbService.getScanState(`syncApplied:assign:${aid2}`) > 0 && downFiles(shared).length === 0,
    downFiles(shared).join(','))
  // F4 重复投递：同一文件再放回 → 幂等零业务写
  const assignmentCountBefore = crmDbService.all('SELECT COUNT(*) AS c FROM assignment')[0].c
  writeFileSync(join(shared, 'down', 'redeliver.json'), JSON.stringify(ev1))
  const cd3 = consumeDownEvents(shared)
  ok('F4 重复投递命中 syncApplied 幂等零重复', cd3.skippedDup === 1 && Number(crmDbService.all('SELECT COUNT(*) AS c FROM assignment')[0].c) === Number(assignmentCountBefore))
  // F5 半截 .tmp 永不消费
  writeFileSync(join(shared, 'down', '00000099-half.json.tmp'), JSON.stringify(ev1))
  const cd4 = consumeDownEvents(shared)
  ok('F5 只写 .tmp 不 rename 的半截文件不被消费（且原样保留）',
    cd4.applied === 0 && cd4.failed === 0 && cd4.skippedDup === 0 && existsSync(join(shared, 'down', '00000099-half.json.tmp')), JSON.stringify(cd4))
  // F6+F7 中枢身份下消费上行：跳过自己的 up 目录，消费 C 组终端（测试销售甲）的 claim+audit
  setIdentity('测试主管', '主管')
  const ownUp = join(shared, 'up', getTerminalId())
  mkdirSync(ownUp, { recursive: true })
  writeFileSync(join(ownUp, 'self.json'), JSON.stringify({ eventSeq: 1, idempotencyKey: `${getTerminalId()}/claim:999`, type: 'claim', payload: { leadId: lb, actor: SALES }, emittedAt: NOW, from: getTerminalId() }))
  const leadNoteBefore = auditRows('lead_note').length
  const cu1 = consumeUpEvents(shared)
  ok('F6 中枢跳过自己的 up 目录（不消费、不删除）', existsSync(join(ownUp, 'self.json')) && crmDbService.getScanState(`syncApplied:${getTerminalId()}/claim:999`) <= 0)
  ok('F7 中枢消费终端 up：claim 幂等落地 + audit 五字段入库',
    cu1.applied >= 2 && auditRows('lead_note').length === leadNoteBefore + 1 &&
    crmDbService.getScanState(`syncApplied:${SALES}/claim:${aid}`) > 0,
    JSON.stringify(cu1))
  // F8 状态查询
  const st = lanSyncStatus()
  ok('F8 状态：角色/目录/最近时间/积压字段齐备',
    st.enabled && st.role === 'hub' && st.sharedDir === shared && st.lastUpApplyAt > 0 && typeof st.backlogPending === 'number' && typeof st.backlogIncoming === 'number',
    JSON.stringify(st))

  console.log(`\n═══ 结果：${pass} 通过 / ${fail} 失败 ═══`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error('测试崩溃:', e); process.exit(1) })
