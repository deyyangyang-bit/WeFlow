/**
 * sla1-supervisor-notify-test.ts —— SLA1 第三次超时「主管通知闭环」验证（2026-09-08）
 *
 * 修复背景：旧实现只写一条 sla1_escalate_supervisor outbox 占位记录，DOWN_TYPES 不处理该事件，
 * 通知永久 pending 无人消费。修复后闭环：
 *   runSla1Recycle（第 3 次超时回收，事务语义不变）
 *     → outbox 登记 sla1_escalate_supervisor（含 leadId/原销售/remindCount=3/recycledAt/reason）
 *     → lanSyncService 定向投递到中枢自己的下行队列（中枢 = 主管/分配员工作机）
 *     → consumeSupervisorNotifications 落地 notify_inbox（幂等键唯一）+ outbox 标 sent + 审计
 *     → listNotifyInbox / markNotifyRead（UI「升级提醒」列表 + 已读）。
 * 通知内容可见：线索（脱敏摘要）、原销售、三次超时、回收时间与原因；全程 ACK/幂等/审计。
 *
 * 隔离：WEFLOW_WORKER='1' + /tmp 空库。运行：npx tsx scripts/sla1-supervisor-notify-test.ts
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const isoDir = mkdtempSync(join(tmpdir(), 'sla1-notify-'))
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
import { assignLeads, runSla1Recycle } from '../electron/services/crmAssignmentService'
import { emitDownEvents, consumeSupervisorNotifications, deliveryFileName, deliveryKey } from '../electron/services/lanSyncService'
import { listNotifyInbox, markNotifyRead } from '../electron/services/crmNotifyService'
import { LEAD_SLA_UNASSIGNED_SENTINEL } from '../shared/leadSla'

const NOW = Date.now()

async function main(): Promise<void> {
  const cfg = ConfigService.getInstance()
  cfg.set('crmSalesList', ['销售甲'])
  cfg.set('crmLeadSlaHours', 24)
  const dbDir = mkdtempSync(join(tmpdir(), 'sla1-notify-db-'))
  await crmDbService.initialize(dbDir)
  await salesDbService.initialize(dbDir)
  const shared = mkdtempSync(join(tmpdir(), 'sla1-notify-shared-'))
  cfg.set('lanSyncSharedDir', shared)
  cfg.set('lanSyncRole', 'hub')
  setIdentity('测试主管', '主管')

  console.log('═══ A. 三次提醒制：第 1/2 次只提醒，满第 3 次才回收 + 通知 ═══')
  const lid = crmDbService.runTx((tx) => tx.run(
    'INSERT INTO lead (contact_type, contact_normalized, contact_raw, wechat, source, name, note, status, first_contact_deadline, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    ['phone', '13922220001', '13922220001', '', '测试', '超时线索甲', '', 'NEW', LEAD_SLA_UNASSIGNED_SENTINEL, NOW, NOW]
  ))
  assignLeads([lid], '销售甲', '测试主管')
  const aid = Number(crmDbService.all("SELECT id FROM assignment WHERE lead_id = ?", [lid])[0]?.id)
  // 把 sla1_deadline 拨到 4 天前（远超 20h 提醒间隔护栏）
  crmDbService.runTx((tx) => { tx.run('UPDATE assignment SET sla1_deadline = ? WHERE id = ?', [NOW - 4 * 86400_000, aid]) })
  const r1 = runSla1Recycle(NOW)
  ok('A1 第 1 轮：只提醒不回收', r1.reminded === 1 && r1.recycled === 0, JSON.stringify(r1))
  // 第 2 次提醒受 20h 间隔护栏保护：把 updated_at 拨回 21h 前
  crmDbService.runTx((tx) => { tx.run('UPDATE assignment SET updated_at = ? WHERE id = ?', [NOW - 21 * 3600_000, aid]) })
  const r2 = runSla1Recycle(NOW)
  ok('A2 第 2 轮：第 2 次提醒', r2.reminded === 1 && r2.recycled === 0, JSON.stringify(r2))
  crmDbService.runTx((tx) => { tx.run('UPDATE assignment SET updated_at = ? WHERE id = ?', [NOW - 21 * 3600_000, aid]) })
  const r3 = runSla1Recycle(NOW)
  ok('A3 第 3 轮：满 3 次自动回收（现有事务语义不变）', r3.recycled === 1,
    JSON.stringify({ r3, status: crmDbService.all('SELECT status FROM assignment WHERE id = ?', [aid])[0]?.status }))
  ok('A4 回收后分配行 recycled + ownership_history/audit 照写',
    String(crmDbService.all('SELECT status FROM assignment WHERE id = ?', [aid])[0]?.status) === 'recycled' &&
    Number(crmDbService.all("SELECT COUNT(*) AS c FROM ownership_history WHERE entity_id = ? AND reason = 'SLA三次超时回收'", [lid])[0].c) === 1)

  console.log('\n═══ B. 通知事件产出到落地（定向投递 → notify_inbox）═══')
  const esc = crmDbService.all("SELECT * FROM outbox_event WHERE idempotency_key = ?", [`sla1Escalate:${aid}`])[0] as CrmRow
  ok('B1 通知事件已登记（含原销售/三次超时/回收时间/原因）', !!esc && (() => {
    const p = JSON.parse(String(esc.payload))
    return p.salesName === '销售甲' && Number(p.remindCount) === 3 && Number(p.recycledAt) > 0 && p.reason === 'SLA三次超时回收'
  })(), String(esc?.payload))
  const em = emitDownEvents(shared)
  const hubRk = deliveryKey('测试主管')
  ok('B2 通知路由到中枢自己的下行队列（assign/recycle 各路由给销售甲，notify 只给中枢）', em.emitted === 3 && (() => {
    const { readdirSync, existsSync } = require('fs') as typeof import('fs')
    const d = join(shared, 'down', hubRk)
    return existsSync(d) && readdirSync(d).some((f) => f.endsWith('.json') && f.includes('-notify.json'))
  })(), JSON.stringify(em))
  const nc = consumeSupervisorNotifications(shared)
  const inbox = listNotifyInbox({})
  ok('B3 通知落地 notify_inbox：1 条未读 + outbox 标 sent（不再是永久待发送占位）',
    nc.applied === 1 && inbox.data.unread === 1 &&
    String(crmDbService.all('SELECT status FROM outbox_event WHERE idempotency_key = ?', [`sla1Escalate:${aid}`])[0]?.status) === 'sent',
    JSON.stringify({ nc, unread: inbox.data.unread }))
  const row = inbox.data.rows[0]
  ok('B4 主管可见：线索（脱敏摘要）+ 原销售 + 三次超时 + 回收时间与原因',
    String(row.title).includes('139****0001') && !String(row.title).includes('13922220001') &&
    String(row.body).includes('销售甲') && String(row.body).includes('3/3') && String(row.body).includes('SLA三次超时回收'),
    JSON.stringify({ title: row.title, body: row.body }))
  ok('B5 通知留审计（action=sla1_supervisor_notify）',
    Number(crmDbService.all("SELECT COUNT(*) AS c FROM audit_event WHERE action = 'sla1_supervisor_notify'")[0].c) === 1)
  // 外形完整的 notify 借用 pending assign 的 key/seq：仍须因 outbox 类型不匹配被拒绝。
  const assignKey = `assign:${aid}`
  const assignOutbox = crmDbService.all('SELECT event_seq, status FROM outbox_event WHERE idempotency_key = ?', [assignKey])[0]
  const forgedName = deliveryFileName(Number(assignOutbox.event_seq), assignKey, 'notify')
  const forgedPath = join(shared, 'down', hubRk, forgedName)
  writeFileSync(forgedPath, JSON.stringify({
    eventSeq: Number(assignOutbox.event_seq),
    idempotencyKey: assignKey,
    type: 'sla1_escalate_supervisor',
    deliveryRole: 'notify',
    to: hubRk,
    payload: { type: 'sla1_escalate_supervisor', leadId: lid, salesName: '销售甲', remindCount: 3, recycledAt: NOW },
    emittedAt: NOW
  }))
  const forgedConsume = consumeSupervisorNotifications(shared)
  ok('B6 伪造 notify 借用 pending assign key：隔离且不能绕过 ACK 结算无关 outbox',
    forgedConsume.failed === 1 &&
    String(crmDbService.all('SELECT status FROM outbox_event WHERE idempotency_key = ?', [assignKey])[0]?.status) === 'pending' &&
    listNotifyInbox({}).data.rows.length === 1 &&
    existsSync(join(shared, 'down', hubRk, '.failed', forgedName)),
    JSON.stringify(forgedConsume))

  // P1 回归：主管通知也必须经过共享 role/type 校验；外层 notify 不能把 payload 中的
  // 数组/对象角色或类型洗成合法值。夹具只插入 pending outbox，不改状态结算语义，消费失败后删除夹具行。
  const protocolCases: Array<[string, (payload: Record<string, unknown>) => void]> = [
    ['sla1-protocol-type-array', (payload) => { payload.type = ['sla1_escalate_supervisor'] }],
    ['sla1-protocol-role-object', (payload) => { payload.deliveryRole = { role: 'notify' } }]
  ]
  crmDbService.runTx((tx) => {
    for (const [key] of protocolCases) {
      const seq = Number(tx.all('SELECT COALESCE(MAX(event_seq), 0) + 1 AS s FROM outbox_event')[0]?.s || 1)
      tx.run(
        "INSERT INTO outbox_event (event_seq, idempotency_key, payload, status, source, created_at, updated_at) VALUES (?,?,?,'pending','weflow-crm',?,?)",
        [seq, key, JSON.stringify({ type: 'sla1_escalate_supervisor', leadId: lid, assignmentId: aid, salesName: '销售甲', remindCount: 3, reason: '协议负例', recycledAt: NOW }), NOW, NOW]
      )
    }
  })
  const protocolEmit = emitDownEvents(shared)
  const protocolRows = protocolCases.map(([key]) => crmDbService.all('SELECT event_seq, status FROM outbox_event WHERE idempotency_key = ?', [key])[0])
  for (const [key, mutate] of protocolCases) {
    const seq = Number(crmDbService.all('SELECT event_seq FROM outbox_event WHERE idempotency_key = ?', [key])[0]?.event_seq || 0)
    const name = deliveryFileName(seq, key, 'notify')
    const path = join(shared, 'down', hubRk, name)
    const body = JSON.parse(readFileSync(path, 'utf-8')) as { payload: Record<string, unknown> }
    mutate(body.payload)
    writeFileSync(path, JSON.stringify(body))
  }
  const protocolBeforeInbox = listNotifyInbox({}).data.rows.length
  const protocolConsume = consumeSupervisorNotifications(shared)
  ok('B7 主管通知的 payload.type / payload.deliveryRole 畸形值均被共享校验拒收：隔离、零落 inbox、outbox 保持 pending',
    protocolEmit.emitted === 2 && protocolConsume.failed === 2 &&
    listNotifyInbox({}).data.rows.length === protocolBeforeInbox &&
    protocolRows.every((row) => String(row?.status) === 'pending') &&
    protocolCases.every(([key]) => {
      const seq = Number(crmDbService.all('SELECT event_seq FROM outbox_event WHERE idempotency_key = ?', [key])[0]?.event_seq || 0)
      return existsSync(join(shared, 'down', hubRk, '.failed', deliveryFileName(seq, key, 'notify')))
    }),
    JSON.stringify({ protocolEmit, protocolConsume, protocolRows }))
  crmDbService.runTx((tx) => {
    for (const [key] of protocolCases) tx.run('DELETE FROM outbox_event WHERE idempotency_key = ? AND status = \'pending\'', [key])
  })

  console.log('\n═══ C. 幂等：重复投递/重复落地/重复已读 ═══')
  emitDownEvents(shared) // 行已 sent，重跑不产新文件
  const nc2 = consumeSupervisorNotifications(shared)
  ok('C1 重复消费零新增（notify_inbox 幂等键唯一）', nc2.applied === 0 && listNotifyInbox({}).data.rows.length === 1, JSON.stringify({ nc: nc2 }))
  const mr1 = markNotifyRead([Number(row.id)])
  ok('C2 已读标记成功', mr1.ok && mr1.updated === 1 && listNotifyInbox({}).data.unread === 0, JSON.stringify(mr1))
  const mr2 = markNotifyRead([Number(row.id)])
  ok('C3 重复已读幂等（updated=0）', mr2.ok && mr2.updated === 0, JSON.stringify(mr2))
  ok('C4 unread 过滤查询可用', listNotifyInbox({ status: 'unread' }).data.rows.length === 0 && listNotifyInbox({ status: 'read' }).data.rows.length === 1)

  console.log('\n═══ D. 单机模式：第三次回收直接落 notify_inbox，幂等且可已读 ═══')
  cfg.set('lanSyncSharedDir', '')
  cfg.set('lanSyncRole', '')
  const localLead = crmDbService.runTx((tx) => tx.run(
    'INSERT INTO lead (contact_type, contact_normalized, contact_raw, wechat, source, name, note, status, first_contact_deadline, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    ['phone', '13922220002', '13922220002', '', '测试', '单机超时线索', '', 'NEW', LEAD_SLA_UNASSIGNED_SENTINEL, NOW, NOW]
  ))
  assignLeads([localLead], '销售甲', '测试主管')
  const localAssignment = Number(crmDbService.all('SELECT id FROM assignment WHERE lead_id = ?', [localLead])[0].id)
  crmDbService.runTx((tx) => { tx.run('UPDATE assignment SET sla1_deadline = ? WHERE id = ?', [NOW - 4 * 86400_000, localAssignment]) })
  runSla1Recycle(NOW)
  crmDbService.runTx((tx) => { tx.run('UPDATE assignment SET updated_at = ? WHERE id = ?', [NOW - 21 * 3600_000, localAssignment]) })
  runSla1Recycle(NOW)
  crmDbService.runTx((tx) => { tx.run('UPDATE assignment SET updated_at = ? WHERE id = ?', [NOW - 21 * 3600_000, localAssignment]) })
  const localRecycle = runSla1Recycle(NOW)
  const localKey = `sla1Escalate:${localAssignment}`
  const localInbox = crmDbService.all('SELECT * FROM notify_inbox WHERE idempotency_key = ?', [localKey])[0]
  ok('D1 同步关闭时第三次回收直接落 notify_inbox，不创建通知 outbox',
    localRecycle.recycled === 1 && !!localInbox && crmDbService.all('SELECT id FROM outbox_event WHERE idempotency_key = ?', [localKey]).length === 0,
    JSON.stringify({ recycle: localRecycle, inbox: localInbox }))
  const localRead = markNotifyRead([Number(localInbox?.id)])
  ok('D2 单机通知可已读', localRead.ok && localRead.updated === 1 && listNotifyInbox({ status: 'unread' }).data.rows.every((row) => row.id !== localInbox?.id), JSON.stringify(localRead))
  const localRepeat = runSla1Recycle(NOW)
  ok('D3 单机重复执行不重复通知', localRepeat.recycled === 0 && Number(crmDbService.all('SELECT COUNT(*) AS c FROM notify_inbox WHERE idempotency_key = ?', [localKey])[0].c) === 1, JSON.stringify(localRepeat))
  ok('D4 hub 模式通知仍只有一条（不与单机路径双写）', Number(crmDbService.all('SELECT COUNT(*) AS c FROM notify_inbox WHERE idempotency_key = ?', [`sla1Escalate:${aid}`])[0].c) === 1)

  console.log('\n═══ E. 故障注入（SQLite RAISE 触发器）：通知/outbox 写失败 → 原子回滚，恢复后只产生一条通知 ═══')
  // 单机模式故障：notify_inbox 的 INSERT 被 BEFORE INSERT 触发器 RAISE(ABORT) →
  // 回收+通知同一事务整体回滚，assignment 仍 assigned，下轮可重试
  cfg.set('lanSyncSharedDir', '')
  cfg.set('lanSyncRole', '')
  const eLead = crmDbService.runTx((tx) => tx.run(
    'INSERT INTO lead (contact_type, contact_normalized, contact_raw, wechat, source, name, note, status, first_contact_deadline, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    ['phone', '13922220003', '13922220003', '', '测试', '故障注入线索', '', 'NEW', LEAD_SLA_UNASSIGNED_SENTINEL, NOW, NOW]
  ))
  assignLeads([eLead], '销售甲', '测试主管')
  const eAsg = Number(crmDbService.all('SELECT id FROM assignment WHERE lead_id = ?', [eLead])[0].id)
  crmDbService.runTx((tx) => { tx.run('UPDATE assignment SET sla1_remind_count = 2, sla1_deadline = ?, updated_at = ? WHERE id = ?', [NOW - 4 * 86400_000, NOW - 21 * 3600_000, eAsg]) })
  const eKey = `sla1Escalate:${eAsg}`
  // 注入触发器（真实 SQLite 级故障）：notify_inbox 禁止插入
  crmDbService.run("CREATE TRIGGER fault_notify_inbox BEFORE INSERT ON notify_inbox BEGIN SELECT RAISE(ABORT, '注入式 notify_inbox 写入失败'); END")
  const eRound1 = runSla1Recycle(NOW)
  crmDbService.run('DROP TRIGGER fault_notify_inbox')
  const eStatus1 = String(crmDbService.all('SELECT status FROM assignment WHERE id = ?', [eAsg])[0]?.status)
  ok('E1 通知写失败 → 整体回滚：assignment 仍 assigned（可在下轮重试），recycled 计数为 0',
    eRound1.recycled === 0 && eStatus1 === 'assigned', JSON.stringify({ round: eRound1, status: eStatus1 }))
  ok('E2 回滚后无孤儿状态：无 notify_inbox、无 escalate outbox、ownership_history 零新增',
    crmDbService.all('SELECT id FROM notify_inbox WHERE idempotency_key = ?', [eKey]).length === 0 &&
    crmDbService.all('SELECT id FROM outbox_event WHERE idempotency_key = ?', [eKey]).length === 0 &&
    crmDbService.all("SELECT COUNT(*) AS c FROM ownership_history WHERE entity_id = ? AND reason = 'SLA三次超时回收'", [eLead])[0].c === 0)
  // 恢复（撤触发器）后重试：回收+通知同事务成功，最终只产生一条通知
  const eRound2 = runSla1Recycle(NOW)
  const eInboxCount = Number(crmDbService.all('SELECT COUNT(*) AS c FROM notify_inbox WHERE idempotency_key = ?', [eKey])[0].c)
  ok('E3 恢复后重试成功：recycled=1 + notify_inbox 恰好一条 + 重复扫描零重复',
    eRound2.recycled === 1 && eInboxCount === 1 &&
    String(crmDbService.all('SELECT status FROM assignment WHERE id = ?', [eAsg])[0]?.status) === 'recycled' &&
    runSla1Recycle(NOW).recycled === 0 && Number(crmDbService.all('SELECT COUNT(*) AS c FROM notify_inbox WHERE idempotency_key = ?', [eKey])[0].c) === 1,
    JSON.stringify({ round: eRound2, inbox: eInboxCount }))

  // LAN 模式故障：escalate outbox 登记被触发器 RAISE(ABORT)（只拦 escalate 键，recycle 事件放行）→ 同样整体回滚
  cfg.set('lanSyncSharedDir', '/tmp/sla1-notify-e-lan-' + NOW)
  cfg.set('lanSyncRole', 'hub')
  const lLead = crmDbService.runTx((tx) => tx.run(
    'INSERT INTO lead (contact_type, contact_normalized, contact_raw, wechat, source, name, note, status, first_contact_deadline, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    ['phone', '13922220004', '13922220004', '', '测试', 'LAN故障注入线索', '', 'NEW', LEAD_SLA_UNASSIGNED_SENTINEL, NOW, NOW]
  ))
  assignLeads([lLead], '销售甲', '测试主管')
  const lAsg = Number(crmDbService.all('SELECT id FROM assignment WHERE lead_id = ?', [lLead])[0].id)
  crmDbService.runTx((tx) => { tx.run('UPDATE assignment SET sla1_remind_count = 2, sla1_deadline = ?, updated_at = ? WHERE id = ?', [NOW - 4 * 86400_000, NOW - 21 * 3600_000, lAsg]) })
  const lKey = `sla1Escalate:${lAsg}`
  crmDbService.run(`CREATE TRIGGER fault_escalate_outbox BEFORE INSERT ON outbox_event
    WHEN NEW.idempotency_key LIKE 'sla1Escalate:%' BEGIN SELECT RAISE(ABORT, '注入式 escalate outbox 写入失败'); END`)
  const lRound1 = runSla1Recycle(NOW)
  crmDbService.run('DROP TRIGGER fault_escalate_outbox')
  ok('E4 LAN 模式 outbox 写失败 → 整体回滚：assignment 仍 assigned、无孤儿 recycle 事件',
    lRound1.recycled === 0 && String(crmDbService.all('SELECT status FROM assignment WHERE id = ?', [lAsg])[0]?.status) === 'assigned' &&
    crmDbService.all('SELECT id FROM outbox_event WHERE idempotency_key = ?', [lKey]).length === 0 &&
    crmDbService.all('SELECT id FROM outbox_event WHERE idempotency_key = ?', [`recycle:${lAsg}`]).length === 0,
    JSON.stringify({ round: lRound1 }))
  const lRound2 = runSla1Recycle(NOW)
  ok('E5 LAN 恢复后重试：recycled=1 + escalate outbox 恰好一条 + 重复扫描零重复',
    lRound2.recycled === 1 && crmDbService.all('SELECT id FROM outbox_event WHERE idempotency_key = ?', [lKey]).length === 1 &&
    runSla1Recycle(NOW).recycled === 0,
    JSON.stringify({ round: lRound2 }))

  console.log(`\n═══ 结果：${pass} 通过 / ${fail} 失败 ═══`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error('测试崩溃:', e); process.exit(1) })
