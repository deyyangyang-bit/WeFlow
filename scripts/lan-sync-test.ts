/**
 * lan-sync-test.ts —— Phase 1 内网同步单元验证（设计 docs/规划/Phase1-内网同步最小版-设计.md，
 * 2026-09-08 定向投递修订版）
 *
 * 覆盖：
 *   A. 同步开关：目录/角色未配置 = 静默关闭；runLanSyncOnce 零副作用
 *   B. 中枢下行产出：assign → down/<投递键>/ 事件文件（payload 含 lead 资料+SLA 参数+投递角色）；
 *      落盘后 outbox 行保持 pending（文件落盘 ≠ 终端已接收）；目录不可写时保持 pending 等重放（R3）
 *   C. 上行产出（终端）：claim → up/<终端>/ 事件文件（键带终端前缀）；audit 游标逐条产出 +
 *      Q4 字段裁剪 + detail 脱敏
 *   D. Q2 拦截：lead 已挂 account → recycleAssignment E205 + 审计 reason='converted_skip' +
 *      不下发 recycle 事件 + 重复命中不刷屏
 *   E. first_touch 写点：updateLeadStatus(contacted) 登记 outbox；completeLeadFirstContact 同 key 幂等
 *   F. 定向投递与 ACK（2026-09-08 核心）：
 *      F1 终端只读自己的队列（别人的队列文件原样保留、零消费）
 *      F2 本机已有归属的 assign → conflict 不覆盖 + ACK(conflict)
 *      F3 conflict 结算：ACK 标记 → outbox 行 failed + 审计（不静默当成功）
 *      F4 全 applied 结算：ACK 标记 → outbox 行 sent
 *      F5 重复投递命中 syncApplied 幂等零重复；.tmp 半截文件不消费；毒文件 .bad 隔离
 *      F6 transfer 双接收者：新销售 apply + 原销售 remove（只移除不建行）；单方 ACK 不结算
 *      F7 nolead：ACK(nolead) 不结算，文件保留重试
 *      F8 主管通知：sla1_escalate_supervisor → notify_inbox 落地 + outbox sent（幂等）
 *      F9 中枢跳过自己的 up 目录；up/<终端>/ack/ 由 processUpAcks 消费、consumeUpEvents 不碰
 *
 * 隔离：WEFLOW_WORKER='1' + /tmp 落盘（三个环境变量在模块正文顶部设置，业务模块一律在其后
 *   动态 import，保证隔离先于任何业务模块加载，绝不读/写持久 WeFlow-nodejs 配置）；
 *   crmDb/salesDb 均 fresh 空库，绝不碰 live 库。
 * 运行：npx tsx scripts/lan-sync-test.ts
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync, renameSync } from 'fs'
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

// 仅类型导入：编译后整段擦除、不触发任何模块求值，可安全保留为静态 import type
import type { CrmRow } from '../electron/services/crmDbService'

// ⚠️ 业务模块不得静态 import：ESM 静态 import 会被提升到模块正文之前执行，
// ConfigService 会在上面三行环境变量生效前完成初始化，转而读/写持久配置。
// 一律在 main() 开头动态 await import()；跨辅助函数共享的绑定先声明为模块级 let，
// 在 main() 动态加载完成后、任何测试逻辑运行前赋值。
let crmDbService: (typeof import('../electron/services/crmDbService'))['crmDbService']
let LEAD_SLA_UNASSIGNED_SENTINEL: (typeof import('../shared/leadSla'))['LEAD_SLA_UNASSIGNED_SENTINEL']

const NOW = Date.now()
const SALES = '测试销售甲'
const SALES2 = '测试销售乙'

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
/** 某接收者队列里的投递文件 */
function queueFiles(root: string, rk: string): string[] {
  const d = join(root, 'down', rk)
  return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.json')) : []
}
function readJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf-8'))
}

async function main(): Promise<void> {
  // 动态加载全部业务模块：三行环境变量已在模块正文顶部生效，此后 ConfigService
  // 等模块读到的一定是本轮独立 /tmp 目录，绝不碰持久配置
  const { ConfigService } = await import('../electron/services/config')
  crmDbService = (await import('../electron/services/crmDbService')).crmDbService
  LEAD_SLA_UNASSIGNED_SENTINEL = (await import('../shared/leadSla')).LEAD_SLA_UNASSIGNED_SENTINEL
  const { salesDbService } = await import('../electron/services/salesDbService')
  const { setIdentity } = await import('../electron/services/identityService')
  const { assignLeads, claimLead, recycleAssignment, transferAssignment } = await import('../electron/services/crmAssignmentService')
  const { updateLeadStatus, updateLeadProfile, completeLeadFirstContact } = await import('../electron/services/crmLeadService')
  const {
    getLanSyncConfig, getTerminalId, deliveryKey, deliveryKeyConflict, deliveryBase, deliveryFileName, deliveryHash, safeFilePart, validateDownEventFile, emitDownEvents, consumeDownEvents, emitUpEvents, consumeUpEvents,
    processUpAcks, settleDownDeliveries, consumeSupervisorNotifications,
    runLanSyncOnce, lanSyncStatus, maskAuditText
  } = await import('../electron/services/lanSyncService')
  const { scanClaimed24h } = await import('../electron/services/crmFirstClassifyService')
  /** 与服务层同一有损前缀函数（碰撞前提的直接证据） */
  const safePartForTest = safeFilePart
  const cfg = ConfigService.getInstance()
  cfg.set('crmSalesList', [SALES, SALES2])
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
  ok('A6 投递键稳定可重复计算且安全化', deliveryKey('甲/乙:丙*丁') === deliveryKey('甲_乙_丙_丁') && deliveryKey('测试销售甲') === '测试销售甲')
  ok('A7 同名/安全化后同键身份明确冲突', deliveryKeyConflict(['销售甲', '销售甲']) !== null && deliveryKeyConflict(['甲/乙', '甲_乙']) !== null)

  console.log('\n═══ B. 中枢下行产出（定向投递：按接收者分队列，落盘 ≠ 已接收）═══')
  setIdentity('测试主管', '主管')
  const lb = seedLead('B-线索', '13911112222')
  const ra = assignLeads([lb], SALES, '测试主管')
  const aid = ra.data!.assignments[0].assignmentId
  ok('B1 assign 后 outbox pending=1', outboxPending().length === 1)
  const em1 = emitDownEvents(shared)
  ok('B2 下行产出 1 条', em1.emitted === 1 && em1.failed === 0, JSON.stringify(em1))
  const rk = deliveryKey(SALES)
  const qFiles = queueFiles(shared, rk)
  ok('B3 事件文件落在接收者自己的队列 down/<投递键>/', qFiles.length === 1, qFiles.join(','))
  const ev1 = readJson(join(shared, 'down', rk, qFiles[0]))
  ok('B4 事件字段齐备（eventSeq/idempotencyKey/type/deliveryRole/to/payload）',
    ev1.eventSeq === 1 && ev1.idempotencyKey === `assign:${aid}` && ev1.type === 'assign' &&
    ev1.deliveryRole === 'apply' && ev1.to === rk && typeof ev1.emittedAt === 'number',
    JSON.stringify({ ...ev1, payload: undefined }))
  ok('B5 payload 含 lead 基础资料 + 目标销售 + SLA 参数（设计 §3）',
    ev1.payload.lead?.contactNormalized === '13911112222' && ev1.payload.lead?.name === 'B-线索' &&
    ev1.payload.salesName === SALES && ev1.payload.slaHours === 24 && ev1.payload.sla1Deadline > 0,
    JSON.stringify(ev1.payload))
  ok('B6 文件落盘后 outbox 行仍 pending（文件落盘 ≠ 终端已接收）', outboxPending().length === 1)
  ok('B7 重跑零新增文件（writeEventFile 跳过已存在，重放安全）', (() => { const e = emitDownEvents(shared); return e.emitted === 0 && queueFiles(shared, rk).length === 1 })())
  // R3：目录不可写 → 保持 pending 等重放
  const lc = seedLead('B-线索2', '13911113333')
  assignLeads([lc], SALES, '测试主管')
  const blocker = mkdtempSync(join(tmpdir(), 'lansync-block-'))
  writeFileSync(join(blocker, 'afile'), 'x') // 文件占名，下级 mkdir 必失败
  const badRoot = join(blocker, 'afile', 'sub')
  const emBad = emitDownEvents(badRoot)
  ok('B8 目录不可写：整轮跳过、pending 保留等重放（R3）', emBad.failed === -1 && outboxPending().length === 2, JSON.stringify(emBad))
  ok('B9 恢复可写后重放成功（补齐文件，行仍 pending）', (() => { const e = emitDownEvents(shared); return e.emitted >= 1 && outboxPending().length === 2 && queueFiles(shared, rk).length === 2 })())

  console.log('\n═══ C. 终端上行产出（设计 §5 刀2：claim + audit 游标 + Q4 裁剪脱敏）═══')
  cfg.set('lanSyncRole', 'terminal')
  setIdentity(SALES, '销售')
  ok('C1 终端标识 = 身份档案姓名', getTerminalId() === SALES)
  // 本地认领 B9 中「测试销售甲」的第二条分配（lc）
  const lcAsg = crmDbService.all("SELECT id FROM assignment WHERE lead_id = ? AND status = 'assigned'", [lc])[0]
  const claimRes = claimLead(lc, '')
  ok('C2 认领成功（服务端身份档案判本人）', claimRes.ok === true && !!lcAsg, JSON.stringify(claimRes))
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
  const claimEv = claimFile ? readJson(join(upDir, claimFile)) : null
  ok('C4 上行键带终端标识前缀（全局唯一）+ from 字段', !!claimEv && claimEv.idempotencyKey.startsWith(`${SALES}/claim:`) && claimEv.from === SALES, String(claimEv?.idempotencyKey))
  const auditEvFiles = upFiles.filter((f) => f.startsWith('audit-'))
  ok('C5 audit 事件按游标逐条产出', auditEvFiles.length >= 2, auditEvFiles.join(','))
  const auditEvs = auditEvFiles.map((f) => readJson(join(upDir, f)))
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
    outboxPending().some((r) => r.idempotencyKey === `first_touch:${lg}` || r.idempotency_key === `first_touch:${lg}`))
  updateLeadStatus(lg, 'contacted', { channel: 'PHONE' }) // 已 CONTACTED 也会走 contacted 分支重写——key 相同被幂等吞掉
  ok('E4 同 key 重放幂等零重复', outboxPending().filter((r) => (r.idempotencyKey || r.idempotency_key) === `first_touch:${lg}`).length === 1)

  console.log('\n═══ F. 定向投递与 ACK（2026-09-08 核心）═══')
  // F1 终端只读自己的队列：别人的队列文件原样保留、零消费
  cfg.set('lanSyncRole', 'hub')
  setIdentity('测试主管', '主管')
  const lOther = seedLead('F-线索他人', '13911118888')
  assignLeads([lOther], SALES2, '测试主管') // 乙的队列事件
  emitDownEvents(shared)
  const rkOther = deliveryKey(SALES2)
  const jiaFilesAtF0 = queueFiles(shared, rk).length
  ok('F0 乙的队列有 1 个投递文件、甲的队列有 B/D/E 组积压',
    queueFiles(shared, rkOther).length === 1 && jiaFilesAtF0 >= 2, `${queueFiles(shared, rkOther).length}/${jiaFilesAtF0}`)
  cfg.set('lanSyncRole', 'terminal')
  setIdentity(SALES2, '销售') // 以乙身份轮询
  const cdOther = consumeDownEvents(shared)
  ok('F1 乙轮询只消费自己的队列（本单元测试共库：命中 conflict 亦属正确），甲的队列文件原样保留',
    cdOther.applied + cdOther.conflict === 1 && queueFiles(shared, rk).length === jiaFilesAtF0, JSON.stringify(cdOther))
  ok('F1b 乙没有产生任何针对甲事件的幂等标记',
    crmDbService.getScanState(`syncApplied:assign:${aid}#apply`) <= 0)
  // 回到甲：消费甲的队列（B 组两条 assign 本机已有有效分配 → conflict；D5 recycle 同库已回收 → applied）
  setIdentity(SALES, '销售')
  writeFileSync(join(shared, 'down', rk, 'garbage.json'), '{not-json')
  const cd1 = consumeDownEvents(shared)
  ok('F2 毒文件改名 .bad 隔离不再重试', existsSync(join(shared, 'down', rk, 'garbage.json.bad')) && !existsSync(join(shared, 'down', rk, 'garbage.json')))
  ok('F3 本机已有有效归属的 assign 下行 → conflict 不覆盖（B 组两条在内），recycle 可正常应用',
    cd1.conflict >= 2 && cd1.applied >= 1, JSON.stringify(cd1))
  ok('F4 conflict 也标 syncApplied + ACK(conflict) 已写 + 文件清除',
    crmDbService.getScanState(`syncApplied:assign:${aid}#apply`) > 0 &&
    crmDbService.getScanState(`syncOutcome:assign:${aid}#apply`) === 2 &&
    existsSync(join(shared, 'up', SALES, 'ack', `${deliveryBase(`assign:${aid}`, 'apply')}.json`)) &&
    queueFiles(shared, rk).length === 0, queueFiles(shared, rk).join(','))
  // F5 结算：conflict ACK → 行 failed + 审计（不静默当成功）
  cfg.set('lanSyncRole', 'hub')
  setIdentity('测试主管', '主管')
  processUpAcks(shared)
  const settle1 = settleDownDeliveries(shared)
  const rowAid = crmDbService.all('SELECT status FROM outbox_event WHERE idempotency_key = ?', [`assign:${aid}`])[0]
  ok('F5 conflict ACK 结算 → outbox 行 failed（保留可审计状态）',
    settle1.failedRows >= 1 && String(rowAid?.status) === 'failed' && auditRows('sync_down_fail').length >= 1,
    JSON.stringify({ settle: settle1, status: rowAid?.status }))

  // F6 全 applied 结算：新 lead 分给乙（先删本库分配行模拟乙端 fresh 库）→ applied ACK → 行 sent
  const lNew = seedLead('F-线索新', '13911119999')
  assignLeads([lNew], SALES2, '测试主管')
  emitDownEvents(shared)
  // 单元测试共库：删掉中枢侧刚建的分配行，模拟乙终端还没收到过这条分配
  crmDbService.runTx((tx) => { tx.run('DELETE FROM assignment WHERE lead_id = ?', [lNew]) })
  cfg.set('lanSyncRole', 'terminal')
  setIdentity(SALES2, '销售')
  const cd2 = consumeDownEvents(shared)
  ok('F6 乙消费新 assign → applied + ACK(applied)', cd2.applied === 1, JSON.stringify(cd2))
  cfg.set('lanSyncRole', 'hub')
  setIdentity('测试主管', '主管')
  processUpAcks(shared)
  const settle2 = settleDownDeliveries(shared)
  const keyNew = crmDbService.all('SELECT idempotency_key FROM outbox_event WHERE payload LIKE ? ORDER BY event_seq DESC LIMIT 1', [`%"leadId":${lNew}%`])[0]?.idempotency_key
  const rowNew = keyNew ? crmDbService.all('SELECT status FROM outbox_event WHERE idempotency_key = ?', [keyNew])[0] : null
  ok('F7 全接收者 applied ACK 结算 → outbox 行 sent（投递完成）',
    settle2.completed >= 1 && String(rowNew?.status) === 'sent', JSON.stringify({ settle: settle2, status: rowNew?.status, keyNew }))

  // F8 ACK 绑定：目录终端、真实 pending outbox、接收者和 deliveryRole 必须全部匹配
  const lAck = seedLead('F-ACK绑定', '13911121111')
  assignLeads([lAck], SALES, '测试主管')
  const ackAid = Number(crmDbService.all("SELECT id FROM assignment WHERE lead_id = ? AND status = 'assigned'", [lAck])[0].id)
  emitDownEvents(shared)
  // 单元测试共库：移除中枢本地权属，让合法 ACK 走 applied
  crmDbService.runTx((tx) => { tx.run('DELETE FROM assignment WHERE lead_id = ?', [lAck]) })
  const ackBase = deliveryBase(`assign:${ackAid}`, 'apply')
  const yiAckDir = join(shared, 'up', SALES2, 'ack')
  mkdirSync(yiAckDir, { recursive: true })
  writeFileSync(join(yiAckDir, 'forged.json'), JSON.stringify({
    base: ackBase, key: `assign:${ackAid}`, to: rk, role: 'apply', outcome: 'applied', terminal: SALES2
  }))
  const forgedResult = processUpAcks(shared)
  ok('F8 乙不能替甲 ACK：目录与 to 不一致 → .bad、零 syncAck',
    forgedResult.failed === 1 && existsSync(join(yiAckDir, 'forged.json.bad')) &&
    crmDbService.getScanState(`syncAck:${rk}:assign:${ackAid}#apply`) <= 0, JSON.stringify(forgedResult))
  const missingBase = deliveryBase('assign:missing-delivery', 'apply')
  const jiaAckDir = join(shared, 'up', SALES, 'ack')
  mkdirSync(jiaAckDir, { recursive: true })
  writeFileSync(join(jiaAckDir, 'missing.json'), JSON.stringify({
    base: missingBase, key: 'assign:missing-delivery', to: rk, role: 'apply', outcome: 'applied', terminal: SALES
  }))
  const missingResult = processUpAcks(shared)
  const noAckSettle = settleDownDeliveries(shared)
  ok('F9 不存在对应 pending 投递的 ACK → .bad、不得结算真实 outbox',
    missingResult.failed === 1 && existsSync(join(jiaAckDir, 'missing.json.bad')) &&
    noAckSettle.completed === 0 && String(crmDbService.all('SELECT status FROM outbox_event WHERE idempotency_key = ?', [`assign:${ackAid}`])[0]?.status) === 'pending',
    JSON.stringify({ ack: missingResult, settle: noAckSettle }))
  cfg.set('lanSyncRole', 'terminal')
  setIdentity(SALES, '销售')
  const legalConsume = consumeDownEvents(shared)
  cfg.set('lanSyncRole', 'hub')
  setIdentity('测试主管', '主管')
  const legalAcks = processUpAcks(shared)
  const legalSettle = settleDownDeliveries(shared)
  ok('F10 合法 ACK：真实投递正常结算',
    legalConsume.applied === 1 && legalAcks.recorded === 1 && legalSettle.completed === 1 &&
    String(crmDbService.all('SELECT status FROM outbox_event WHERE idempotency_key = ?', [`assign:${ackAid}`])[0]?.status) === 'sent',
    JSON.stringify({ consume: legalConsume, acks: legalAcks, settle: legalSettle }))

  // F10b ACK 写失败时不删投递；修复 ACK 目录后 dup 路径补 ACK，证明 hub 可可靠重投
  const ackRetrySales = '测试销售丙'
  const lAckRetry = seedLead('F-ACK重投', '13911122222')
  assignLeads([lAckRetry], ackRetrySales, '测试主管')
  const retryAid = Number(crmDbService.all("SELECT id FROM assignment WHERE lead_id = ? AND status = 'assigned'", [lAckRetry])[0].id)
  emitDownEvents(shared)
  crmDbService.runTx((tx) => { tx.run('DELETE FROM assignment WHERE id = ?', [retryAid]) })
  const retryQueue = deliveryKey(ackRetrySales)
  const retryFile = queueFiles(shared, retryQueue)[0]
  const blockedTerminalPath = join(shared, 'up', retryQueue)
  writeFileSync(blockedTerminalPath, 'blocked')
  cfg.set('lanSyncRole', 'terminal')
  setIdentity(ackRetrySales, '销售')
  const ackFailedConsume = consumeDownEvents(shared)
  ok('F10b ACK 写失败：业务已应用但投递文件保留等待补 ACK',
    ackFailedConsume.applied === 1 && existsSync(join(shared, 'down', retryQueue, retryFile)) &&
    crmDbService.getScanState(`syncApplied:assign:${retryAid}#apply`) > 0, JSON.stringify(ackFailedConsume))
  rmSync(blockedTerminalPath, { force: true })
  const ackRetryConsume = consumeDownEvents(shared)
  cfg.set('lanSyncRole', 'hub')
  setIdentity('测试主管', '主管')
  const ackRetryProcess = processUpAcks(shared)
  const ackRetrySettle = settleDownDeliveries(shared)
  ok('F10c ACK 目录恢复后可补 ACK 并可靠结算',
    ackRetryConsume.skippedDup === 1 && !existsSync(join(shared, 'down', retryQueue, retryFile)) &&
    ackRetryProcess.recorded === 1 && ackRetrySettle.completed === 1 &&
    String(crmDbService.all('SELECT status FROM outbox_event WHERE idempotency_key = ?', [`assign:${retryAid}`])[0]?.status) === 'sent',
    JSON.stringify({ consume: ackRetryConsume, acks: ackRetryProcess, settle: ackRetrySettle }))

  // F8 transfer 双接收者：apply + remove 各自独立投递与 ACK；单方 ACK 不结算
  const lTr = seedLead('F-线索调派', '13911120000')
  assignLeads([lTr], SALES, '测试主管')
  emitDownEvents(shared)
  setIdentity(SALES, '销售')
  cfg.set('lanSyncRole', 'terminal')
  consumeDownEvents(shared) // 甲消费自己的 assign（applied）
  cfg.set('lanSyncRole', 'hub')
  setIdentity('测试主管', '主管')
  const trAsg = Number(crmDbService.all("SELECT id FROM assignment WHERE lead_id = ? AND status = 'assigned'", [lTr])[0].id)
  const tr = transferAssignment(trAsg, SALES2, 'F 组调派', '测试主管')
  ok('F8 调派成功（甲 → 乙）', tr.ok === true)
  emitDownEvents(shared)
  const trRow = crmDbService.all("SELECT * FROM outbox_event WHERE payload LIKE ? ORDER BY event_seq DESC LIMIT 1", [`%"oldAssignmentId":${trAsg}%`])[0]
  const rkJia = deliveryKey(SALES)
  const rkYi = deliveryKey(SALES2)
  ok('F9 transfer 产出两个独立投递：乙队列 apply + 甲队列 remove',
    queueFiles(shared, rkYi).some((f) => f.includes('-apply.json')) && queueFiles(shared, rkJia).some((f) => f.includes('-remove.json')),
    `yi=${queueFiles(shared, rkYi).join(',')} jia=${queueFiles(shared, rkJia).join(',')}`)
  // 单元测试共库：删除中枢刚建的新行，模拟乙终端尚未有本地权属，避免把中枢状态当成终端状态
  crmDbService.runTx((tx) => { tx.run('DELETE FROM assignment WHERE id = ?', [tr.data!.assignmentId]) })
  // 乙先 ACK（消费 apply）
  cfg.set('lanSyncRole', 'terminal')
  setIdentity(SALES2, '销售')
  const cdTrYi = consumeDownEvents(shared)
  cfg.set('lanSyncRole', 'hub')
  setIdentity('测试主管', '主管')
  processUpAcks(shared)
  const settleMid = settleDownDeliveries(shared)
  ok('F10 单接收者 ACK 不提前清理：行仍 pending，甲队列 remove 文件保留',
    String(crmDbService.all('SELECT status FROM outbox_event WHERE id = ?', [Number(trRow.id)])[0]?.status) === 'pending' &&
    queueFiles(shared, rkJia).some((f) => f.includes('-remove.json')),
    JSON.stringify({ settle: settleMid, files: queueFiles(shared, rkJia) }))
  // 甲消费 remove：只移除权属，不建新行（单元测试共库：中枢 transfer 已建乙的新行，此处只验甲侧行为）
  cfg.set('lanSyncRole', 'terminal')
  setIdentity(SALES, '销售')
  const cdTrJia = consumeDownEvents(shared)
  ok('F11 甲消费 remove：本地行 transferred + transfer_remove 审计（真实隔离建行验证在 e2e）',
    cdTrJia.applied === 1 &&
    String(crmDbService.all('SELECT status FROM assignment WHERE id = ?', [trAsg])[0]?.status) === 'transferred' &&
    auditRows('sync_apply').some((a) => String(a.detail).includes('transfer_remove') && Number(a.entity_id) === lTr),
    JSON.stringify({ r: cdTrJia }))
  cfg.set('lanSyncRole', 'hub')
  setIdentity('测试主管', '主管')
  processUpAcks(shared)
  const settleTr = settleDownDeliveries(shared)
  ok('F12 双接收者全部 ACK 后行才标 sent',
    String(crmDbService.all('SELECT status FROM outbox_event WHERE id = ?', [Number(trRow.id)])[0]?.status) === 'sent' && settleTr.completed >= 1,
    JSON.stringify(settleTr))

  // F13 nolead：无 lead 资料的孤儿事件 → ACK(nolead) 不结算、文件保留重试
  const noleadKey = 'assign:nolead-test'
  const noleadDir = join(shared, 'down', rk)
  const noleadFile = deliveryFileName(999, noleadKey, 'apply')
  if (!existsSync(noleadDir)) { /* 甲的队列目录 */ }
  writeFileSync(join(noleadDir, noleadFile), JSON.stringify({
    eventSeq: 999, idempotencyKey: noleadKey, type: 'assign', deliveryRole: 'apply', to: rk,
    payload: { type: 'assign', leadId: 424242, salesName: SALES, sla1Deadline: NOW + 86400000 }, emittedAt: NOW
  }))
  cfg.set('lanSyncRole', 'terminal')
  setIdentity(SALES, '销售')
  const cdNolead = consumeDownEvents(shared)
  ok('F13 nolead：ACK(nolead)、文件保留等重试、零业务写',
    cdNolead.nolead === 1 && existsSync(join(noleadDir, noleadFile)) &&
    crmDbService.getScanState(`syncApplied:${noleadKey}#apply`) <= 0, JSON.stringify(cdNolead))
  cfg.set('lanSyncRole', 'hub')
  setIdentity('测试主管', '主管')
  processUpAcks(shared)
  settleDownDeliveries(shared)
  ok('F14 nolead ACK 不结算（行仍 pending，不静默当成功）',
    String(crmDbService.all("SELECT status FROM outbox_event WHERE idempotency_key = 'assign:nolead-test'")[0]?.status || 'absent') !== 'sent')
  // 补上 lead 资料后再投递 → 可应用（模拟 lead 随后续事件到达）
  writeFileSync(join(noleadDir, noleadFile), JSON.stringify({
    eventSeq: 999, idempotencyKey: noleadKey, type: 'assign', deliveryRole: 'apply', to: rk,
    payload: { type: 'assign', leadId: 424242, salesName: SALES, sla1Deadline: NOW + 86400000,
      lead: { leadId: 424242, name: '补投线索', contactType: 'phone', contactNormalized: '13911124444', contactRaw: '13911124444', wechat: '', source: '同步', note: '' } },
    emittedAt: NOW
  }))
  cfg.set('lanSyncRole', 'terminal')
  setIdentity(SALES, '销售')
  const cdRetry = consumeDownEvents(shared)
  ok('F15 lead 到位后重试成功（applied + 删文件）', cdRetry.applied === 1 && !existsSync(join(noleadDir, noleadFile)), JSON.stringify(cdRetry))

  // F16 重复投递命中 syncApplied 幂等零重复（dup 路径按记录 outcome 补 ACK）
  const asgCountBefore = crmDbService.all('SELECT COUNT(*) AS c FROM assignment')[0].c
  writeFileSync(join(noleadDir, noleadFile), JSON.stringify({
    eventSeq: 999, idempotencyKey: noleadKey, type: 'assign', deliveryRole: 'apply', to: rk,
    payload: { type: 'assign', leadId: 424242, salesName: SALES, sla1Deadline: NOW + 86400000,
      lead: { leadId: 424242, name: '补投线索', contactType: 'phone', contactNormalized: '13911124444', contactRaw: '13911124444', wechat: '', source: '同步', note: '' } },
    emittedAt: NOW
  }))
  const cdDup = consumeDownEvents(shared)
  ok('F16 重复投递命中 syncApplied：skippedDup、零业务写、文件清除',
    cdDup.skippedDup === 1 && cdDup.applied === 0 && Number(crmDbService.all('SELECT COUNT(*) AS c FROM assignment')[0].c) === Number(asgCountBefore) &&
    !existsSync(join(noleadDir, noleadFile)), JSON.stringify(cdDup))

  // F17 .tmp 半截文件不消费
  writeFileSync(join(noleadDir, '00000998-half.json.tmp'), JSON.stringify(ev1))
  const cdTmp = consumeDownEvents(shared)
  ok('F17 只写 .tmp 不 rename 的半截文件不被消费（且原样保留）',
    cdTmp.applied === 0 && cdTmp.failed === 0 && cdTmp.skippedDup === 0 && existsSync(join(noleadDir, '00000998-half.json.tmp')), JSON.stringify(cdTmp))

  // F18 主管通知：outbox 登记 → 中枢轮内落地 notify_inbox + 行 sent（幂等）
  cfg.set('lanSyncRole', 'hub')
  setIdentity('测试主管', '主管')
  processUpAcks(shared)
  settleDownDeliveries(shared) // 先结算 F15 的 applied ACK，清干净 pending
  const escKey = 'sla1Escalate:99999'
  crmDbService.runTx((tx) => {
    tx.run("INSERT INTO outbox_event (event_seq, idempotency_key, payload, status, source, created_at, updated_at) VALUES ((SELECT COALESCE(MAX(event_seq),0)+1 FROM outbox_event), ?, ?, 'pending', 'weflow-crm', ?, ?)",
      [escKey, JSON.stringify({ type: 'sla1_escalate_supervisor', leadId: lb, assignmentId: 12345, salesName: SALES, remindCount: 3, reason: 'SLA三次超时回收', recycledAt: NOW }), NOW, NOW])
  })
  emitDownEvents(shared)
  const hubRk = deliveryKey('测试主管')
  ok('F18 主管通知路由到中枢自己的队列', queueFiles(shared, hubRk).some((f) => f.includes('-notify.json')), queueFiles(shared, hubRk).join(','))
  const nc1 = consumeSupervisorNotifications(shared)
  const inboxRow = crmDbService.all('SELECT * FROM notify_inbox WHERE idempotency_key = ?', [escKey])[0]
  ok('F19 通知落地 notify_inbox（脱敏摘要 + 原归属 + 三次超时 + 回收原因/时间）+ outbox sent',
    nc1.applied === 1 && !!inboxRow && String(inboxRow.title).includes('139****2222') &&
    !String(inboxRow.body).includes('13911112222') && String(inboxRow.body).includes('SLA三次超时回收') &&
    String(crmDbService.all('SELECT status FROM outbox_event WHERE idempotency_key = ?', [escKey])[0]?.status) === 'sent' &&
    !queueFiles(shared, hubRk).some((f) => f.includes('-notify.json')),
    JSON.stringify({ nc: nc1, inbox: inboxRow && { title: inboxRow.title, body: inboxRow.body } }))
  // 幂等：重复投递同一通知文件 → skippedDup 零重复
  emitDownEvents(shared)
  const nc2 = consumeSupervisorNotifications(shared)
  const inboxCount = crmDbService.all('SELECT COUNT(*) AS c FROM notify_inbox WHERE idempotency_key = ?', [escKey])[0].c
  ok('F20 重复通知幂等：notify_inbox 零重复、outbox 保持 sent', nc2.applied === 0 && nc2.skippedDup + nc2.failed >= 0 && Number(inboxCount) === 1, JSON.stringify({ nc: nc2, cnt: inboxCount }))

  const collisionKey = 'transfer:delivery-key-collision'
  crmDbService.runTx((tx) => {
    tx.run("INSERT INTO outbox_event (event_seq, idempotency_key, payload, status, source, created_at, updated_at) VALUES ((SELECT COALESCE(MAX(event_seq),0)+1 FROM outbox_event), ?, ?, 'pending', 'weflow-crm', ?, ?)",
      [collisionKey, JSON.stringify({ type: 'transfer', leadId: lb, fromSales: '甲/乙', toSales: '甲_乙' }), NOW, NOW])
  })
  const collisionEmit = emitDownEvents(shared)
  ok('F20b 投递键冲突明确 failed，不静默共用队列',
    collisionEmit.failed === 1 && String(crmDbService.all('SELECT status FROM outbox_event WHERE idempotency_key = ?', [collisionKey])[0]?.status) === 'failed' &&
    auditRows('sync_down_delivery_key_conflict').some((row) => String(row.detail).includes(collisionKey)), JSON.stringify(collisionEmit))

  // F21 中枢跳过自己的 up 目录；ack/ 子目录不被 consumeUpEvents 当业务事件消费
  cfg.set('lanSyncRole', 'hub')
  setIdentity('测试主管', '主管')
  const ownUp = join(shared, 'up', getTerminalId())
  if (!existsSync(ownUp)) mkdirSync(ownUp, { recursive: true })
  writeFileSync(join(ownUp, 'self.json'), JSON.stringify({ eventSeq: 1, idempotencyKey: `${getTerminalId()}/claim:999`, type: 'claim', payload: { leadId: lb, actor: SALES }, emittedAt: NOW, from: getTerminalId() }))
  const ackDir = join(shared, 'up', SALES, 'ack')
  writeFileSync(join(ackDir, 'stray-ack.json'), JSON.stringify({ base: 'stray', to: rk, outcome: 'applied', terminal: SALES, at: NOW }))
  const leadNoteBefore = auditRows('lead_note').length
  const cu1 = consumeUpEvents(shared)
  ok('F21 中枢跳过自己的 up 目录（不消费、不删除）', existsSync(join(ownUp, 'self.json')) && crmDbService.getScanState(`syncApplied:${getTerminalId()}/claim:999`) <= 0)
  ok('F22 中枢消费终端 up：claim 幂等落地 + audit 五字段入库（ack/ 子目录不被当业务事件）',
    cu1.applied >= 1 && auditRows('lead_note').length === leadNoteBefore + 1 &&
    existsSync(join(ackDir, 'stray-ack.json')), JSON.stringify(cu1))
  const pac = processUpAcks(shared)
  ok('F23 非法 stray ACK 进入 .bad：不写 syncAck、不被接受',
    pac.recorded === 0 && pac.failed === 1 && existsSync(join(ackDir, 'stray-ack.json.bad')) &&
    crmDbService.getScanState(`syncAck:${rk}:stray`) <= 0, JSON.stringify(pac))

  // ── G. 下行事件本体校验（2026-09-09：零业务写、零标记、零 ACK，.failed 隔离）──
  console.log('\n═══ G. 下行事件本体校验（非法事件零副作用）═══')
  const gCounts = () => ({
    lead: Number(crmDbService.all('SELECT COUNT(*) AS c FROM lead')[0].c),
    asg: Number(crmDbService.all('SELECT COUNT(*) AS c FROM assignment')[0].c),
    aud: Number(crmDbService.all("SELECT COUNT(*) AS c FROM audit_event WHERE action = 'sync_apply'")[0].c)
  })
  cfg.set('lanSyncRole', 'terminal')
  setIdentity(SALES, '销售')
  const gFile = (tag: string, body: Record<string, unknown>, fileName?: string) => {
    const name = fileName ?? `${String(700).padStart(8, '0')}-${tag}.json`
    writeFileSync(join(noleadDir, name), JSON.stringify(body))
    return name
  }
  const gEv = (over: Record<string, unknown>): Record<string, unknown> => ({
    eventSeq: 700, idempotencyKey: 'assign:g-valid', type: 'assign', deliveryRole: 'apply', to: rk,
    payload: { type: 'assign', leadId: 888888, salesName: SALES, sla1Deadline: NOW + 86400000,
      lead: { leadId: 888888, name: 'G校验线索', contactType: 'phone', contactNormalized: '13999990001', contactRaw: '13999990001', wechat: '', source: '同步', note: '' } },
    emittedAt: NOW, ...over
  })
  const gBefore = gCounts()
  // G1 ev.to 指向其他终端
  const g1 = gFile('g1', gEv({ idempotencyKey: 'assign:g1', to: deliveryKey(SALES2) }))
  // G2 assign + remove（type/role 不匹配）
  const g2 = gFile('g2', gEv({ idempotencyKey: 'assign:g2', deliveryRole: 'remove' }))
  // G3 transfer + notify（type/role 不匹配）
  const g3 = gFile('g3', gEv({ idempotencyKey: 'transfer:g3', type: 'transfer', deliveryRole: 'notify' }))
  // G4 缺失 deliveryRole（禁止默认 apply）
  const g4Body = gEv({ idempotencyKey: 'assign:g4' })
  delete (g4Body as Record<string, unknown>).deliveryRole
  const g4 = gFile('g4', g4Body)
  // G5a eventSeq 与内容不一致（文件名写 seq 700，内容 eventSeq 701）
  const g5a = gFile('g5a', gEv({ idempotencyKey: 'assign:g5a', eventSeq: 701 }))
  // G5b 文件名与内容不一致（规范名应属其他 key）
  const g5b = gFile('g5b', gEv({ idempotencyKey: 'assign:g5b' }), deliveryFileName(700, 'assign:g5-wrong-name', 'apply'))
  // G5c/G5d eventSeq 必须是 JSON number；数字字符串/null 即使文件名可规范化也拒绝
  const g5c = gFile('g5c', gEv({ idempotencyKey: 'assign:g5c', eventSeq: '700' }), deliveryFileName(700, 'assign:g5c', 'apply'))
  const g5d = gFile('g5d', gEv({ idempotencyKey: 'assign:g5d', eventSeq: null }), deliveryFileName(0, 'assign:g5d', 'apply'))
  const gRound = consumeDownEvents(shared)
  const gAfter = gCounts()
  const gFailedDir = join(noleadDir, '.failed')
  ok('G1 八类非法事件（含字符串/null eventSeq）全部 .failed 隔离、计 failed',
    gRound.failed === 8 && existsSync(join(gFailedDir, g1)) && !existsSync(join(noleadDir, g1)) &&
    existsSync(join(gFailedDir, g2)) && existsSync(join(gFailedDir, g3)) && existsSync(join(gFailedDir, g4)) &&
    existsSync(join(gFailedDir, g5a)) && existsSync(join(gFailedDir, g5b)) &&
    existsSync(join(gFailedDir, g5c)) && existsSync(join(gFailedDir, g5d)), JSON.stringify(gRound))
  ok('G6 非法事件业务零写入（lead/assignment/sync_apply 审计零变化）',
    gAfter.lead === gBefore.lead && gAfter.asg === gBefore.asg && gAfter.aud === gBefore.aud,
    JSON.stringify({ before: gBefore, after: gAfter }))
  ok('G7 非法事件零幂等标记、零 ACK（不生成可被中枢接受的成功回执）',
    crmDbService.getScanState('syncApplied:assign:g1#apply') <= 0 && crmDbService.getScanState('syncApplied:assign:g4#apply') <= 0 &&
    !(existsSync(join(shared, 'up', SALES, 'ack')) && readdirSync(join(shared, 'up', SALES, 'ack')).some((f) => f.includes(deliveryHash('assign:g1', 'apply')))),
    undefined)
  ok('G8 validateDownEventFile 纯函数直测（合法事件返回 null）',
    validateDownEventFile({ ...gEv({}), to: rk, deliveryRole: 'apply' } as never, rk, deliveryFileName(700, 'assign:g-valid', 'apply')) === null &&
    validateDownEventFile({ ...gEv({ idempotencyKey: 'transfer:g-valid', type: 'transfer', deliveryRole: 'remove' }) } as never, rk, deliveryFileName(700, 'transfer:g-valid', 'remove')) === null &&
    validateDownEventFile({ ...gEv({}), to: deliveryKey(SALES2) } as never, rk, deliveryFileName(700, 'assign:g-valid', 'apply')) !== null &&
    validateDownEventFile({ ...gEv({ eventSeq: '700' }) } as never, rk, deliveryFileName(700, 'assign:g-valid', 'apply')) !== null &&
    validateDownEventFile({ ...gEv({ eventSeq: null }) } as never, rk, deliveryFileName(0, 'assign:g-valid', 'apply')) !== null)

  // ── H. ACK 身份无损：有损 safeFilePart 碰撞键不得互相误结算 ──
  console.log('\n═══ H. ACK 键碰撞（a/b vs a:b；前 120 字符相同尾部不同）═══')
  const keyAB = 'assign:a/b'
  const keyAC = 'assign:a:b'
  const longPrefix = 'assign:' + 'k'.repeat(130)
  const keyLong1 = `${longPrefix}tail1`
  const keyLong2 = `${longPrefix}tail2`
  ok('H1 有损前缀确实相同（碰撞前提成立），哈希与无损 ACK 键可区分',
    safePartForTest(keyAB) === safePartForTest(keyAC) && safePartForTest(keyLong1) === safePartForTest(keyLong2) &&
    deliveryBase(keyAB, 'apply') !== deliveryBase(keyAC, 'apply') && deliveryBase(keyLong1, 'apply') !== deliveryBase(keyLong2, 'apply'))
  // 两条碰撞键事件，各配一条独立 lead（终端 fresh，可各自 applied），分阶段投递与结算
  const lCol1 = seedLead('H-碰撞1', '13911130001')
  const lCol2 = seedLead('H-碰撞2', '13911130002')
  crmDbService.runTx((tx) => {
    tx.run("INSERT INTO outbox_event (event_seq, idempotency_key, payload, status, source, created_at, updated_at) VALUES ((SELECT COALESCE(MAX(event_seq),0)+1 FROM outbox_event), ?, ?, 'pending', 'weflow-crm', ?, ?)",
      [keyAB, JSON.stringify({ type: 'assign', leadId: lCol1, salesName: SALES, sla1Deadline: NOW + 86400000 }), NOW, NOW])
    tx.run("INSERT INTO outbox_event (event_seq, idempotency_key, payload, status, source, created_at, updated_at) VALUES ((SELECT COALESCE(MAX(event_seq),0)+1 FROM outbox_event), ?, ?, 'pending', 'weflow-crm', ?, ?)",
      [keyAC, JSON.stringify({ type: 'assign', leadId: lCol2, salesName: SALES, sla1Deadline: NOW + 86400000 }), NOW, NOW])
  })
  cfg.set('lanSyncRole', 'hub')
  setIdentity('测试主管', '主管')
  emitDownEvents(shared)
  ok('H2 碰撞键事件各自落独立投递文件（哈希兜底，不互覆盖）',
    queueFiles(shared, rk).length === 2 &&
    new Set(queueFiles(shared, rk)).size === 2 &&
    queueFiles(shared, rk).some((f) => f.includes(deliveryHash(keyAB, 'apply'))) &&
    queueFiles(shared, rk).some((f) => f.includes(deliveryHash(keyAC, 'apply'))),
    queueFiles(shared, rk).join(','))
  // 只消费第一个文件（第二个投递暂不出队）→ 中枢只应结算第一个
  cfg.set('lanSyncRole', 'terminal')
  setIdentity(SALES, '销售')
  const onlyFirst = queueFiles(shared, rk).find((f) => f.includes(deliveryHash(keyAB, 'apply')))!
  const secondFile = queueFiles(shared, rk).find((f) => f !== onlyFirst)!
  const holdPath = join(shared, `.hold-${secondFile}`) // 第二个投递暂挪出队列，模拟「尚未出队」
  renameSync(join(noleadDir, secondFile), holdPath)
  const hConsume1 = consumeDownEvents(shared)
  cfg.set('lanSyncRole', 'hub')
  setIdentity('测试主管', '主管')
  processUpAcks(shared)
  const hSettle1 = settleDownDeliveries(shared)
  ok('H3 第一个事件的 ACK 只结算自己：keyAB 行 sent、碰撞的 keyAC 行仍 pending',
    hConsume1.applied === 1 &&
    String(crmDbService.all('SELECT status FROM outbox_event WHERE idempotency_key = ?', [keyAB])[0]?.status) === 'sent' &&
    String(crmDbService.all('SELECT status FROM outbox_event WHERE idempotency_key = ?', [keyAC])[0]?.status) === 'pending' &&
    hSettle1.completed === 1,
    JSON.stringify({ consume: hConsume1, settle: hSettle1 }))
  ok('H4 有损键的两个事件 ACK 标记互不碰撞（无损 key+role 键）',
    Number(crmDbService.getScanState(`syncAck:${rk}:${keyAB}#apply`)) === 1 &&
    Number(crmDbService.getScanState(`syncAck:${rk}:${keyAC}#apply`)) <= 0)
  // 第二个事件出队消费 → 各自正常 ACK + 独立结算
  renameSync(holdPath, join(noleadDir, secondFile))
  cfg.set('lanSyncRole', 'terminal')
  setIdentity(SALES, '销售')
  const hConsume2 = consumeDownEvents(shared)
  cfg.set('lanSyncRole', 'hub')
  setIdentity('测试主管', '主管')
  processUpAcks(shared)
  const hSettle2 = settleDownDeliveries(shared)
  ok('H5 两个碰撞键事件均能各自正常 ACK 和独立结算 sent',
    hConsume2.applied === 1 && hSettle2.completed === 1 &&
    String(crmDbService.all('SELECT status FROM outbox_event WHERE idempotency_key = ?', [keyAC])[0]?.status) === 'sent' &&
    Number(crmDbService.getScanState(`syncAck:${rk}:${keyAC}#apply`)) === 1,
    JSON.stringify({ consume: hConsume2, settle: hSettle2 }))
  // 长键对（前 120 字符相同）：文件名互不覆盖
  const lCol3 = seedLead('H-碰撞3', '13911130003')
  const lCol4 = seedLead('H-碰撞4', '13911130004')
  crmDbService.runTx((tx) => {
    tx.run("DELETE FROM assignment WHERE lead_id = ?", [lCol3])
    tx.run("DELETE FROM assignment WHERE lead_id = ?", [lCol4])
    tx.run("INSERT INTO outbox_event (event_seq, idempotency_key, payload, status, source, created_at, updated_at) VALUES ((SELECT COALESCE(MAX(event_seq),0)+1 FROM outbox_event), ?, ?, 'pending', 'weflow-crm', ?, ?)",
      [keyLong1, JSON.stringify({ type: 'assign', leadId: lCol3, salesName: SALES, sla1Deadline: NOW + 86400000 }), NOW, NOW])
    tx.run("INSERT INTO outbox_event (event_seq, idempotency_key, payload, status, source, created_at, updated_at) VALUES ((SELECT COALESCE(MAX(event_seq),0)+1 FROM outbox_event), ?, ?, 'pending', 'weflow-crm', ?, ?)",
      [keyLong2, JSON.stringify({ type: 'assign', leadId: lCol4, salesName: SALES, sla1Deadline: NOW + 86400000 }), NOW, NOW])
  })
  emitDownEvents(shared)
  cfg.set('lanSyncRole', 'terminal')
  setIdentity(SALES, '销售')
  const hConsume3 = consumeDownEvents(shared)
  cfg.set('lanSyncRole', 'hub')
  setIdentity('测试主管', '主管')
  processUpAcks(shared)
  const hSettle3 = settleDownDeliveries(shared)
  ok('H6 前 120 字符相同但尾部不同的两个 key：各自投递、各自 ACK、各自结算',
    hConsume3.applied === 2 && hSettle3.completed === 2 &&
    String(crmDbService.all('SELECT status FROM outbox_event WHERE idempotency_key = ?', [keyLong1])[0]?.status) === 'sent' &&
    String(crmDbService.all('SELECT status FROM outbox_event WHERE idempotency_key = ?', [keyLong2])[0]?.status) === 'sent',
    JSON.stringify({ consume: hConsume3, settle: hSettle3 }))

  // ── I. claim 上行携带 claimed_at（2026-09-10 修复：中枢回放落 claimed_at，24h 首次分类主链）──
  console.log('\n═══ I. claim 上行 claimed_at → 中枢落库 → scanClaimed24h 命中 ═══')
  cfg.set('lanSyncRole', 'terminal')
  setIdentity(SALES, '销售')
  const lI = seedLead('I-线索', '13911140001')
  assignLeads([lI], SALES, '测试主管')
  const iClaim = claimLead(lI, '')
  ok('I1 终端本地认领成功', iClaim.ok === true, JSON.stringify(iClaim))
  const iAsg = crmDbService.all("SELECT * FROM assignment WHERE lead_id = ? AND status = 'claimed'", [lI])[0]
  const iClaimedAt = Number(iAsg?.claimed_at || 0)
  ok('I2 本地 assignment.claimed_at 已写入（有限正数）', !!iAsg && iClaimedAt > 0, JSON.stringify(iAsg && { id: iAsg.id, claimed_at: iAsg.claimed_at }))
  emitUpEvents(shared)
  const iClaimEv = readdirSync(join(shared, 'up', SALES)).filter((f) => f.endsWith('.json'))
    .map((f) => readJson(join(shared, 'up', SALES, f)))
    .find((e) => e.type === 'claim' && e.idempotencyKey === `${SALES}/claim:${Number(iAsg.id)}`)
  ok('I3 上行 claim 事件 payload 携带 claimedAt 且等于本地 claimed_at（同一 now）',
    !!iClaimEv && Number(iClaimEv.payload.claimedAt) === iClaimedAt, JSON.stringify(iClaimEv?.payload))
  // 单进程共库：把行拨回「中枢尚未落地」状态，验证回放路径写 claimed_at
  crmDbService.runTx((tx) => { tx.run("UPDATE assignment SET status = 'assigned', claimed_at = NULL WHERE id = ?", [Number(iAsg.id)]) })
  cfg.set('lanSyncRole', 'hub')
  setIdentity('测试主管', '主管')
  const iConsume = consumeUpEvents(shared)
  const iAsgAfter = crmDbService.all('SELECT * FROM assignment WHERE id = ?', [Number(iAsg.id)])[0]
  ok('I4 中枢回放 claim：status=claimed 且 claimed_at = 事件携带值（非消费时刻）',
    iConsume.applied >= 1 && String(iAsgAfter?.status) === 'claimed' && Number(iAsgAfter?.claimed_at) === iClaimedAt,
    JSON.stringify({ applied: iConsume.applied, status: iAsgAfter?.status, claimed_at: iAsgAfter?.claimed_at, expect: iClaimedAt }))
  const iClaimAudits = auditRows('lead_claim').filter((r) => Number(r.entity_id) === lI && String(r.detail).includes('sync:up'))
  ok('I5 中枢 claim 审计 detail 携带 claimedAt 便于核对触发基点',
    iClaimAudits.length === 1 && Number(JSON.parse(String(iClaimAudits[0].detail)).claimedAt) === iClaimedAt,
    JSON.stringify(iClaimAudits.map((r) => r.detail)))
  // 推进满 24h → scanClaimed24h 命中（本测试无 AI 配置 → 轮次落 failed 可重试，不写假结果）
  crmDbService.runTx((tx) => { tx.run('UPDATE assignment SET claimed_at = ? WHERE id = ?', [Date.now() - 25 * 3600_000, Number(iAsg.id)]) })
  const iScan = await scanClaimed24h()
  const iRound = crmDbService.all('SELECT * FROM first_classification WHERE assignment_id = ?', [Number(iAsg.id)])[0]
  ok('I6 满 24h 后 scanClaimed24h 命中该 assignment 并生成轮次行（无 AI → failed）',
    iScan.due === 1 && iScan.triggered === 1 && !!iRound && String(iRound.status) === 'failed',
    JSON.stringify({ scan: iScan, round: iRound && { id: iRound.id, status: iRound.status } }))
  ok('I7 扫描重跑幂等（轮次行已存在，due=0）', (await scanClaimed24h()).due === 0)

  // I8 旧格式事件（无 claimedAt，emittedAt 有效）：回退 ev.emittedAt 安全落 claimed_at
  const lOld = seedLead('I-旧格式', '13911140002')
  assignLeads([lOld], SALES, '测试主管')
  const oldAsg = crmDbService.all("SELECT * FROM assignment WHERE lead_id = ? AND status = 'assigned'", [lOld])[0]
  const legacyEmittedAt = NOW - 3600_000
  writeFileSync(join(shared, 'up', SALES, '00008901-claim-legacy.json'), JSON.stringify({
    eventSeq: 8901, idempotencyKey: `${SALES}/claim:legacy-${Number(oldAsg.id)}`, type: 'claim',
    payload: { leadId: lOld, actor: SALES }, emittedAt: legacyEmittedAt, from: SALES
  }))
  consumeUpEvents(shared)
  const oldAsgAfter = crmDbService.all('SELECT * FROM assignment WHERE id = ?', [Number(oldAsg.id)])[0]
  ok('I8 旧格式无 claimedAt：回退 ev.emittedAt 落下有效 claimed_at',
    String(oldAsgAfter?.status) === 'claimed' && Number(oldAsgAfter?.claimed_at) === legacyEmittedAt,
    JSON.stringify({ status: oldAsgAfter?.status, claimed_at: oldAsgAfter?.claimed_at, expect: legacyEmittedAt }))

  // F24 状态查询
  const st = lanSyncStatus()
  ok('F24 状态：角色/目录/最近时间/积压字段齐备',
    st.enabled && st.role === 'hub' && st.sharedDir === shared && st.lastUpApplyAt > 0 && typeof st.backlogPending === 'number' && typeof st.backlogIncoming === 'number',
    JSON.stringify(st))

  console.log(`\n═══ 结果：${pass} 通过 / ${fail} 失败 ═══`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error('测试崩溃:', e); process.exit(1) })
