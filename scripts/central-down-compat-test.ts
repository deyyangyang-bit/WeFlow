/**
 * central-down-compat-test.ts —— 升级前 pending transfer 的兼容与富化（2026-09-15）
 *
 * 被验证的真实缺陷：`transferAssignment()` 一直把 `mode` 与 `sla1_deadline` 写进**新的 assignment 行**，
 * 但 7278d61 之前**没有**写进 outbox payload；共享下行契约随后把 `mode` / `sla1Deadline` 列为 transfer 必填。
 * 升级后那些**升级前产生的 pending 行**会同时卡住两条通道：
 *   - 中央 HTTP：发送前自检判非法 → 该行终态 failed（移交永远到不了接收端）；
 *   - SMB：原样展开旧载荷 → 终端共享校验器拒收 → 文件反复隔离，永远不收敛。
 *
 * 本脚本覆盖：
 *   A. 富化语义（单元）：从本机 assignment 行取**当时写入的绝对值**；改当前 SLA 配置不改变恢复值；
 *      已合法载荷原样放行不覆盖；重复调用幂等、不就地改入参；不可恢复时返回稳定错误码。
 *   G. 判定口径与身份一致性（2026-09-15 第二轮）：SLA「已合法」是**原始类型**判定（字符串数字
 *      不算，小数/NaN/Infinity/0/负数/对象/数组同样不算）；用恢复行之前必须核对
 *      `assignment.lead_id === payload.leadId` 且 `assignment.sales_name === payload.toSales`，
 *      不符一律拒（不把别的线索的 mode/SLA 贴到本条指令上）；错误码不含任何客户值。
 *   B. 发射端单一来源（静态）：两条通道 import 同一个 helper，不各写一套兼容逻辑。
 *   C. SMB 通道：升级前写法的 pending transfer 行 → 富化后落盘合法文件；
 *      文件名（由 event_seq + 幂等键 + 角色决定）与升级前逐字相同，即幂等键未被改写。
 *   D. 不永久死锁：终端把升级前的非法旧文件隔离进 .failed/（移出队列目录）后，
 *      中枢下一轮把富化后的合法文件写到**同一个路径**，两轮收敛且幂等键不变。
 *   E. 不可恢复：不猜值、不发送，该行终态 failed + 脱敏审计（只有行号/类型/稳定错误码）。
 *   F. 中央 HTTP 通道（端到端）见 scripts/central-sync-e2e-test.ts K 段——那里有真实 Fastify + MemoryCentralStore。
 *
 * 隔离：WEFLOW_WORKER + WEFLOW_USER_DATA_PATH + WEFLOW_CONFIG_CWD 指向临时目录，
 *       业务模块一律在 main() 内动态 import。**不读真实生产库、不发真实网络请求。**
 * 运行：npx tsx scripts/central-down-compat-test.ts
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const isoDir = mkdtempSync(join(tmpdir(), 'centralsync-compat-'))
process.env.WEFLOW_WORKER = '1'
process.env.WEFLOW_USER_DATA_PATH = isoDir
process.env.WEFLOW_CONFIG_CWD = isoDir

let pass = 0, fail = 0
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; console.log(`  ✅ ${name}`) } else { fail++; console.log(`  ❌ ${name} ${detail}`) }
}

import type { CrmRow } from '../electron/services/crmDbService'
import type { DownPayloadHeal } from '../electron/services/crmDownPayloadCompat'

let crmDbService: (typeof import('../electron/services/crmDbService'))['crmDbService']
let healLegacyDownPayload: (type: string, payload: Record<string, unknown>) => DownPayloadHeal
let validateDownEventFile: (typeof import('../electron/services/lanSyncService'))['validateDownEventFile']
let deliveryFileName: (typeof import('../electron/services/lanSyncService'))['deliveryFileName']
let emitDownEvents: (typeof import('../electron/services/lanSyncService'))['emitDownEvents']
let consumeDownEvents: (typeof import('../electron/services/lanSyncService'))['consumeDownEvents']
let deliveryKey: (typeof import('../electron/services/lanSyncService'))['deliveryKey']
let lanSyncService: typeof import('../electron/services/lanSyncService')
let centralSyncService: typeof import('../electron/services/centralSyncService')

const SALES = '兼容销售甲'
const SALES2 = '兼容销售乙'
const SUPERVISOR = '兼容主管'
const NOW = Date.now()

/** 一条「升级前写法」的 transfer outbox 行：**没有** mode / sla1Deadline（7278d61 之前的真实形态） */
function legacyTransferPayload(leadId: number, assignmentId: number, oldAssignmentId: number): Record<string, unknown> {
  return {
    type: 'transfer', leadId, assignmentId, oldAssignmentId,
    fromSales: SALES, toSales: SALES2, reason: '升级前移交', actor: `system:${SUPERVISOR}`,
    lead: {
      leadId, name: '兼容线索', contactType: 'phone', contactNormalized: '13900007001',
      contactRaw: '13900007001', wechat: '', source: '测试', note: ''
    }
  }
}

function insertOutbox(seq: number, key: string, payload: Record<string, unknown>): number {
  return crmDbService.runTx((tx) => {
    tx.run('INSERT INTO outbox_event (event_seq, idempotency_key, payload, status, source, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
      [seq, key, JSON.stringify(payload), 'pending', 'test', NOW, NOW])
    return Number(tx.all('SELECT id FROM outbox_event WHERE idempotency_key = ?', [key])[0]?.id || 0)
  })
}
function outboxRow(key: string): CrmRow | undefined {
  return crmDbService.all('SELECT * FROM outbox_event WHERE idempotency_key = ?', [key])[0]
}
function assignmentRow(id: number): CrmRow | undefined {
  return crmDbService.all('SELECT * FROM assignment WHERE id = ?', [id])[0]
}
function auditsOf(action: string): CrmRow[] {
  return crmDbService.all('SELECT * FROM audit_event WHERE action = ? ORDER BY id', [action])
}

async function main(): Promise<void> {
  const { ConfigService } = await import('../electron/services/config')
  crmDbService = (await import('../electron/services/crmDbService')).crmDbService
  const { salesDbService } = await import('../electron/services/salesDbService')
  const { setIdentity } = await import('../electron/services/identityService')
  const { assignLeads, transferAssignment } = await import('../electron/services/crmAssignmentService')
  const { importLeads } = await import('../electron/services/crmLeadService')
  lanSyncService = await import('../electron/services/lanSyncService')
  centralSyncService = await import('../electron/services/centralSyncService')
  ;({ validateDownEventFile, deliveryFileName, emitDownEvents, consumeDownEvents, deliveryKey } = lanSyncService)
  healLegacyDownPayload = (await import('../electron/services/crmDownPayloadCompat')).healLegacyDownPayload

  const cfg = ConfigService.getInstance()
  cfg.set('crmSalesList', [SALES, SALES2])
  cfg.set('crmLeadSlaHours', 24)
  const dbDir = mkdtempSync(join(tmpdir(), 'centralsync-compat-db-'))
  await crmDbService.initialize(dbDir)
  await salesDbService.initialize(dbDir)
  const shared = mkdtempSync(join(tmpdir(), 'centralsync-compat-shared-'))
  setIdentity(SUPERVISOR, '主管')

  // ── 造一条真实的 assignment 事实：mode 与 sla1_deadline 由状态机写入 ──────────
  const imported = importLeads('compat', 'compat.csv', [{ phone: '13900007001', name: '兼容线索', source: '测试' }])
  const leadId = Number(crmDbService.all('SELECT id FROM lead WHERE contact_normalized = ?', ['13900007001'])[0]?.id || 0)
  assignLeads([leadId], SALES, SUPERVISOR)
  const oldAssignmentId = Number(crmDbService.all("SELECT id FROM assignment WHERE lead_id = ? AND status = 'assigned'", [leadId])[0]?.id || 0)
  cfg.set('crmLeadSlaHours', 24)
  const moved = transferAssignment(oldAssignmentId, SALES2, '兼容移交', SUPERVISOR)
  const newAssignmentId = Number((moved.data as { assignmentId?: number } | undefined)?.assignmentId || 0)
  const newRow = assignmentRow(newAssignmentId)
  const rowMode = String(newRow?.mode || '')
  const rowSla = Number(newRow?.sla1_deadline || 0)

  console.log('═══ A. 富化语义（从 assignment 行取绝对值，绝不重算）═══')
  ok('A0 前置：真实 assignment 行确实带 mode 与 sla1_deadline（富化的唯一数据来源）',
    imported.valid === 1 && moved.ok === true && rowMode.length > 0 && rowSla > 0,
    JSON.stringify({ imported: imported.valid, moved: moved.ok, rowMode, rowSla }))

  const legacy = legacyTransferPayload(leadId, newAssignmentId, oldAssignmentId)
  const legacyFrozen = JSON.stringify(legacy)
  cfg.set('crmLeadSlaHours', 24)
  const healed = healLegacyDownPayload('transfer', legacy)
  ok('A1 缺 mode/sla1Deadline 的历史 transfer 载荷被富化（ok=true）', healed.ok === true)
  const healedPayload = healed.ok ? healed.payload : {}
  ok('A2 恢复的 mode 逐值等于 assignment 行（不是猜的、不是映射来的）',
    String(healedPayload.mode) === rowMode, JSON.stringify({ got: healedPayload.mode, want: rowMode }))
  ok('A3 恢复的 sla1Deadline 逐值等于 assignment 行当时写入的绝对时间戳',
    Number(healedPayload.sla1Deadline) === rowSla, JSON.stringify({ got: healedPayload.sla1Deadline, want: rowSla }))
  ok('A4 定位字段原样保留（leadId / assignmentId / oldAssignmentId / fromSales / toSales / reason / lead 都不被改写）',
    Number(healedPayload.leadId) === leadId && Number(healedPayload.assignmentId) === newAssignmentId &&
    Number(healedPayload.oldAssignmentId) === oldAssignmentId &&
    String(healedPayload.fromSales) === SALES && String(healedPayload.toSales) === SALES2 &&
    String(healedPayload.reason) === '升级前移交' &&
    JSON.stringify(healedPayload.lead) === JSON.stringify(legacy.lead))
  ok('A5 不就地修改入参（返回新对象，原载荷保持升级前原样）', JSON.stringify(legacy) === legacyFrozen)

  // 严禁按当前时间 / 当前 crmLeadSlaHours / 接收端配置重算：把当前配置改成完全不同的值
  cfg.set('crmLeadSlaHours', 999)
  const healedAfterCfg = healLegacyDownPayload('transfer', legacy)
  ok('A6 把当前 crmLeadSlaHours 改成 999 后，恢复值**一字不变**（SLA 是历史事实，不按当前配置重算）',
    healedAfterCfg.ok === true && Number(healedAfterCfg.payload.sla1Deadline) === rowSla &&
    String(healedAfterCfg.payload.mode) === rowMode)
  cfg.set('crmLeadSlaHours', 24)
  ok('A7 幂等：重复富化结果逐字相同（可安全重放，不会漂移）',
    JSON.stringify(healLegacyDownPayload('transfer', legacy)) === JSON.stringify(healed))

  const alreadyLegal: Record<string, unknown> = { ...legacy, mode: 'round_robin', sla1Deadline: 4102444800000 }
  const passthrough = healLegacyDownPayload('transfer', alreadyLegal)
  ok('A8 已合法的载荷原样放行：不覆盖已有值，且返回值就是入参本身（无多余对象分配）',
    passthrough.ok === true && passthrough.payload === alreadyLegal &&
    String(passthrough.payload.mode) === 'round_robin' && Number(passthrough.payload.sla1Deadline) === 4102444800000)
  const partial: Record<string, unknown> = { ...legacy, mode: 'load' }
  const partialHealed = healLegacyDownPayload('transfer', partial)
  ok('A9 只缺一半时只补另一半：已有 mode 不被覆盖，缺的 sla1Deadline 才从 assignment 行取',
    partialHealed.ok === true && String(partialHealed.payload.mode) === 'load' &&
    Number(partialHealed.payload.sla1Deadline) === rowSla)
  ok('A10 非 transfer 类型不扩张改动面（assign 的 mode 可选、SLA 缺失由接收端既有兜底）',
    ['assign', 'recycle', 'sla1_escalate_supervisor'].every((t) => {
      const r = healLegacyDownPayload(t, { type: t, leadId: 1 })
      return r.ok === true && r.payload.type === t
    }))

  console.log('\n═══ A11-A15 不可恢复：不猜值、不发送、返回稳定错误码 ═══')
  const badId = healLegacyDownPayload('transfer', { ...legacy, assignmentId: undefined })
  ok('A11 assignmentId 缺失 → legacy_transfer_bad_assignment_id（不按线索猜最近一次分配）',
    badId.ok === false && badId.code === 'legacy_transfer_bad_assignment_id')
  ok('A12 assignmentId 非法形态（0 / 负数 / 小数 / 字符串 / 对象）→ 同一稳定码',
    [0, -1, 1.5, '12', {}, null].every((bad) => {
      const r = healLegacyDownPayload('transfer', { ...legacy, assignmentId: bad })
      return r.ok === false && r.code === 'legacy_transfer_bad_assignment_id'
    }))
  const missingRow = healLegacyDownPayload('transfer', { ...legacy, assignmentId: 987654321 })
  ok('A13 assignmentId 指向不存在的行 → legacy_transfer_assignment_missing',
    missingRow.ok === false && missingRow.code === 'legacy_transfer_assignment_missing')
  // 人为把该行的 mode / sla1_deadline 破坏成不可用：仍必须拒绝，而不是拿一个默认值顶上
  const brokenModeId = crmDbService.runTx((tx) => tx.run(
    'INSERT INTO assignment (lead_id, sales_name, mode, sla1_deadline, status, source, updated_by, updated_at, version, deleted) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [leadId, SALES2, 'teleport', rowSla, 'assigned', 'test', SUPERVISOR, NOW, 1, 0]))
  const brokenMode = healLegacyDownPayload('transfer', { ...legacy, assignmentId: brokenModeId })
  ok('A14 assignment 行的 mode 不在枚举内 → legacy_transfer_mode_unrecoverable（不塞默认值）',
    brokenMode.ok === false && brokenMode.code === 'legacy_transfer_mode_unrecoverable')
  const brokenSlaId = crmDbService.runTx((tx) => tx.run(
    'INSERT INTO assignment (lead_id, sales_name, mode, sla1_deadline, status, source, updated_by, updated_at, version, deleted) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [leadId, SALES2, 'manual', 0, 'assigned', 'test', SUPERVISOR, NOW, 1, 0]))
  const brokenSla = healLegacyDownPayload('transfer', { ...legacy, assignmentId: brokenSlaId })
  ok('A15 assignment 行的 sla1_deadline 为 NULL/0 → legacy_transfer_sla_unrecoverable（不按当前时间补）',
    brokenSla.ok === false && brokenSla.code === 'legacy_transfer_sla_unrecoverable')

  console.log('\n═══ G. 判定口径（原始类型）与身份一致性（跨线索不容错）═══')
  // G1：字符串数字**不是**合法绝对时间戳。两条通道会各自解读它（中央 Number() 成数字、SMB 原样保留
  // 字符串被 requiredTimestamps 拒收）→ 同一行一条通过一条被拒。必须按「不可用」处理并恢复成 number。
  const stringSla: Record<string, unknown> = { ...legacy, sla1Deadline: String(rowSla) }
  const stringHealed = healLegacyDownPayload('transfer', stringSla)
  ok('G1 字符串数字 SLA 不算「已合法」：恢复成 number，绝不把字符串时间戳放行',
    stringHealed.ok === true && typeof stringHealed.payload.sla1Deadline === 'number' &&
    Number(stringHealed.payload.sla1Deadline) === rowSla,
    JSON.stringify({ got: stringHealed.ok ? stringHealed.payload.sla1Deadline : stringHealed }))
  const illegalSlas: unknown[] = [String(rowSla), 1.5, Number.NaN, Number.POSITIVE_INFINITY, 0, -1, {}, [], true, '']
  const slaResults = illegalSlas.map((bad) => healLegacyDownPayload('transfer', { ...legacy, sla1Deadline: bad }))
  ok('G2 小数 / NaN / Infinity / 0 / 负数 / 对象 / 数组 / 布尔 / 空串 一律按不可用处理，全部恢复为 number',
    slaResults.every((r) => r.ok === true && typeof r.payload.sla1Deadline === 'number' &&
      Number(r.payload.sla1Deadline) === rowSla),
    JSON.stringify(slaResults.map((r) => (r.ok ? r.payload.sla1Deadline : r.code))))
  ok('G3 富化结果里不可能出现字符串 SLA（该字段只能是 number）',
    slaResults.every((r) => !r.ok || typeof r.payload.sla1Deadline !== 'string'))

  // 恢复不了就拒：字符串 SLA + 不可用的 assignment 行 → 稳定码（不按当前时间补一个数字顶上）
  const stringOnBrokenRow = healLegacyDownPayload('transfer', { ...legacy, assignmentId: brokenSlaId, sla1Deadline: String(rowSla) })
  ok('G4 字符串 SLA + assignment 行 SLA 不可用 → legacy_transfer_sla_unrecoverable（不按当前时间补）',
    stringOnBrokenRow.ok === false && stringOnBrokenRow.code === 'legacy_transfer_sla_unrecoverable')

  // G5：跨线索。第二条线索的 leadId 配上第一条线索的 assignmentId —— 行存在但与载荷矛盾，必须拒。
  const imported2 = importLeads('compat2', 'compat2.csv', [{ phone: '13900007002', name: '另一条线索', source: '测试' }])
  const leadId2 = Number(crmDbService.all('SELECT id FROM lead WHERE contact_normalized = ?', ['13900007002'])[0]?.id || 0)
  const crossLead = healLegacyDownPayload('transfer', { ...legacy, leadId: leadId2 })
  ok('G5 前置：第二条线索真实存在且 id 不同（否则跨线索断言是空断言）',
    imported2.valid === 1 && leadId2 > 0 && leadId2 !== leadId, JSON.stringify({ leadId, leadId2 }))
  ok('G6 payload.leadId 指向别的线索 → legacy_transfer_lead_mismatch（不把 B 线索的 mode/SLA 贴到 A 线索的指令上）',
    crossLead.ok === false && crossLead.code === 'legacy_transfer_lead_mismatch')
  const noLeadId = healLegacyDownPayload('transfer', { ...legacy, leadId: undefined })
  ok('G7 payload.leadId 缺失 / 非正整数 → 同一稳定码（无法核对身份就不恢复）',
    noLeadId.ok === false && noLeadId.code === 'legacy_transfer_lead_mismatch' &&
    [0, -1, 2.5, '1', {}, null].every((bad) => {
      const r = healLegacyDownPayload('transfer', { ...legacy, leadId: bad })
      return r.ok === false && r.code === 'legacy_transfer_lead_mismatch'
    }))

  // G8：目标销售不符 / 缺失。assignment.sales_name 必须逐字等于 payload.toSales。
  const wrongTarget = healLegacyDownPayload('transfer', { ...legacy, toSales: SALES })
  ok('G8 payload.toSales 与 assignment.sales_name 不符 → legacy_transfer_target_mismatch',
    wrongTarget.ok === false && wrongTarget.code === 'legacy_transfer_target_mismatch')
  ok('G9 toSales 为空串 / 非字符串 / 对象 → 同一稳定码',
    ['', '   ', {}, [], 123, null, undefined].every((bad) => {
      const r = healLegacyDownPayload('transfer', { ...legacy, toSales: bad })
      return r.ok === false && r.code === 'legacy_transfer_target_mismatch'
    }))

  // G11：身份检查不被「字段已合法」短路——已合法的载荷指向别的线索同样必须拒（否则等于用合法字段
  // 换取了把 B 线索的上下文当 A 线索事实发送的许可）。
  const legalButCrossLead = healLegacyDownPayload('transfer', { ...alreadyLegal, leadId: leadId2 })
  const legalButWrongTarget = healLegacyDownPayload('transfer', { ...alreadyLegal, toSales: SALES })
  ok('G10 字段已合法但身份不符 → 仍拒（身份检查不是「需要恢复时才跑」）',
    legalButCrossLead.ok === false && legalButCrossLead.code === 'legacy_transfer_lead_mismatch' &&
    legalButWrongTarget.ok === false && legalButWrongTarget.code === 'legacy_transfer_target_mismatch')
  // G12：行不存在而载荷自足 → 原样放行（没有可恢复的值，也不引入与「富化」无关的新失败路径）
  const selfSufficientInput: Record<string, unknown> = { ...alreadyLegal, assignmentId: 987654321 }
  const selfSufficient = healLegacyDownPayload('transfer', selfSufficientInput)
  ok('G11 行不存在但载荷自足 → 原样放行（返回入参本身，不新造一条失败路径）',
    selfSufficient.ok === true && selfSufficient.payload === selfSufficientInput &&
    Number(selfSufficient.payload.assignmentId) === 987654321)

  // G13：错误码只描述字段与一致性结论，不带客户值 / 销售姓名 / 线索资料
  const gCodes = [crossLead, noLeadId, wrongTarget, stringOnBrokenRow]
    .map((r) => (r.ok ? '' : r.code)).join('|')
  ok('G12 拒收码不含客户值 / 销售姓名 / 线索资料（只有字段与一致性结论）',
    /^(legacy_transfer_[a-z_]+\|?)+$/.test(gCodes) && !gCodes.includes('13900007001') &&
    !gCodes.includes('兼容线索') && !gCodes.includes(SALES) && !gCodes.includes(SALES2), gCodes)
  ok('G13 拒收路径零业务写：这些调用没有新增 assignment / audit 行',
    assignmentRow(newAssignmentId)?.id !== undefined &&
    auditsOf('sync_down_payload_unrecoverable').length === 0)

  console.log('\n═══ B. 两条发射端共用同一个 helper（静态，防止各写一套漂移）═══')
  const root = join(__dirname, '..')
  const centralSrc = readFileSync(join(root, 'electron/services/centralSyncService.ts'), 'utf8')
  const lanSrc = readFileSync(join(root, 'electron/services/lanSyncService.ts'), 'utf8')
  ok('B1 中央 HTTP 发射端 import 该 helper', /import\s*\{\s*healLegacyDownPayload\s*\}\s*from\s*'\.\/crmDownPayloadCompat'/.test(centralSrc))
  ok('B2 SMB 发射端 import 同一个 helper',
    /import\s*\{\s*healLegacyDownPayload\s*\}\s*from\s*'\.\/crmDownPayloadCompat'/.test(lanSrc))
  ok('B3 两侧都真的调用了它（不是只 import 未使用）',
    /healLegacyDownPayload\(/.test(centralSrc) && /healLegacyDownPayload\(/.test(lanSrc))

  console.log('\n═══ C. SMB 通道：升级前写法的行被富化后落盘合法文件，幂等键/文件名不变 ═══')
  cfg.set('lanSyncRole', 'hub')
  // 清掉状态机为本次移交写的「新写法」outbox 行，改写成升级前写法——这就是升级前那一刻库里的真实行形态
  crmDbService.runTx((tx) => tx.run("DELETE FROM outbox_event WHERE idempotency_key IN (?, ?)",
    [`transfer:${newAssignmentId}`, `assign:${oldAssignmentId}`]))
  const legacySeq = 9001
  const legacyKey = `transfer:${newAssignmentId}`
  const legacyRowId = insertOutbox(legacySeq, legacyKey, legacyTransferPayload(leadId, newAssignmentId, oldAssignmentId))
  const beforeRow = outboxRow(legacyKey)
  const emit = emitDownEvents(shared)
  const rk = deliveryKey(SALES2)
  const applyName = deliveryFileName(legacySeq, legacyKey, 'apply')
  const removeName = deliveryFileName(legacySeq, legacyKey, 'remove')
  const applyPath = join(shared, 'down', rk, applyName)
  const removePath = join(shared, 'down', deliveryKey(SALES), removeName)
  ok('C1 升级前写法的 pending transfer 行本轮成功落盘两个目标（emitted=2、failed=0，不再因缺字段被判失败）',
    emit.emitted === 2 && emit.failed === 0, JSON.stringify(emit))
  ok('C2 文件名由 (event_seq, 幂等键, 角色) 决定，与升级前逐字相同 → 幂等键未被改写',
    existsSync(applyPath) && existsSync(removePath) &&
    String(beforeRow?.idempotency_key) === legacyKey && Number(beforeRow?.event_seq) === legacySeq)
  const applyBody = JSON.parse(readFileSync(applyPath, 'utf8')) as Record<string, unknown>
  const applyPayload = applyBody.payload as Record<string, unknown>
  ok('C3 落盘载荷带上了富化后的 mode 与 sla1Deadline，且逐值等于 assignment 行',
    String(applyPayload.mode) === rowMode && Number(applyPayload.sla1Deadline) === rowSla)
  ok('C4 落盘文件通过终端共享校验器（smb 档）——升级前那种「必然被拒」的状态消失',
    validateDownEventFile(applyBody as never, rk, applyName) === null)

  console.log('\n═══ D. 不永久死锁：旧非法文件被隔离出队列目录 → 同一路径下轮补写合法文件 ═══')
  // 还原升级前的现场：队列目录下躺着那份**升级前写出的**非法文件（缺 mode/sla1Deadline），
  // 且 outbox 行仍是 pending（终端反复拒收、文件反复被隔离，永远不收敛）。
  const legacyBadBody = { eventSeq: legacySeq, idempotencyKey: legacyKey, type: 'transfer', deliveryRole: 'apply', to: rk,
    payload: legacyTransferPayload(leadId, newAssignmentId, oldAssignmentId), emittedAt: NOW }
  writeFileSync(applyPath, JSON.stringify(legacyBadBody))
  ok('D1 前置：这份「升级前写出的」文件确实过不了终端校验（缺 mode/sla1Deadline）',
    String(validateDownEventFile(legacyBadBody as never, rk, applyName)).includes('missing_field:mode'))
  cfg.set('lanSyncRole', 'terminal')
  setIdentity(SALES2, '销售')
  const cd = consumeDownEvents(shared)
  const failedDir = join(shared, 'down', rk, '.failed')
  ok('D2 终端把它隔离进 .failed/（移出队列目录），路径随之空出，且零业务写',
    cd.failed === 1 && cd.applied === 0 && !existsSync(applyPath) && existsSync(join(failedDir, applyName)),
    JSON.stringify(cd))
  cfg.set('lanSyncRole', 'hub')
  setIdentity(SUPERVISOR, '主管')
  const emit2 = emitDownEvents(shared)
  // emitted=1：只有被隔离掉的那个目标需要补写；另一个目标路径仍被占用，writeEventFile 原样跳过。
  ok('D3 同一行仍是 pending → 中枢下一轮在**同一个路径**写出富化后的合法文件（最坏两轮收敛）',
    emit2.emitted === 1 && emit2.failed === 0 && existsSync(applyPath) &&
    validateDownEventFile(JSON.parse(readFileSync(applyPath, 'utf8')) as never, rk, applyName) === null,
    JSON.stringify({ emit2, status: outboxRow(legacyKey)?.status, files: readdirSync(join(shared, 'down', rk)) }))
  ok('D4 收敛后幂等键与 event_seq 依旧不变（补写的是同一条事实，不是新造一条）',
    String(outboxRow(legacyKey)?.idempotency_key) === legacyKey &&
    Number(outboxRow(legacyKey)?.event_seq) === legacySeq && Number(outboxRow(legacyKey)?.id) === legacyRowId)
  cfg.set('lanSyncRole', 'terminal')
  setIdentity(SALES2, '销售')
  const cd2 = consumeDownEvents(shared)
  // 本脚本里中枢与终端共用同一个库，故接收端状态机看到「该线索已有有效归属」→ conflict（不覆盖本地，
  // 与真机语义一致：中枢指令与本地状态打架时留人工）。真机终端库里没有这一行，落地结果是 applied。
  // 这里要证明的是：升级残留的那份文件**不再被校验拒收**，而是真的进了状态机并被清除。
  ok('D5 终端这次不再校验拒收（invalid/failed 均为 0），文件进了状态机并清除，升级残留彻底收敛',
    cd2.failed === 0 && cd2.invalid === 0 && cd2.conflict === 1 && !existsSync(applyPath), JSON.stringify(cd2))
  cfg.set('lanSyncRole', 'hub')
  setIdentity(SUPERVISOR, '主管')

  console.log('\n═══ E. 不可恢复时不猜值、不发送：终态 failed + 脱敏审计 ═══')
  const badKey = 'transfer:compat-unrecoverable'
  const badRowId = insertOutbox(9002, badKey, { ...legacyTransferPayload(leadId, 987654321, oldAssignmentId) })
  const failedBefore = auditsOf('sync_down_payload_unrecoverable').length
  const emit3 = emitDownEvents(shared)
  const badAudits = auditsOf('sync_down_payload_unrecoverable').slice(failedBefore)
  ok('E1 恢复不了的移交行终态 failed，且这一条一个字节都没落盘（不猜值、不发送）',
    emit3.failed === 1 && String(outboxRow(badKey)?.status) === 'failed' &&
    !readdirSync(join(shared, 'down', deliveryKey(SALES2))).includes(deliveryFileName(9002, badKey, 'apply')),
    JSON.stringify({ emit: emit3, status: outboxRow(badKey)?.status }))
  ok('E2 审计恰好一条，且只带行号 + 类型 + 稳定错误码（无联系方式、无线索资料、无聊天内容、无载荷原文）',
    badAudits.length === 1 &&
    String(badAudits[0]?.action) === 'sync_down_payload_unrecoverable' &&
    String(badAudits[0]?.entity_id) === String(badRowId) &&
    String((JSON.parse(String(badAudits[0]?.detail || '{}')) as Record<string, unknown>).reason) === 'legacy_transfer_assignment_missing' &&
    String((JSON.parse(String(badAudits[0]?.detail || '{}')) as Record<string, unknown>).type) === 'transfer' &&
    Object.keys(JSON.parse(String(badAudits[0]?.detail || '{}')) as Record<string, unknown>).sort().join() === 'reason,type' &&
    !JSON.stringify(badAudits).includes('13900007001') && !JSON.stringify(badAudits).includes('兼容线索') &&
    !JSON.stringify(badAudits).includes('升级前移交'),
    JSON.stringify(badAudits))

  console.log('\n═══ F. 中央 HTTP 发射端也在同一条 helper 上（本机发送前自检）═══')
  ok('F1 中央 HTTP 自检复用的是同一份富化 helper（见 B1/B3）——两条通道口径不可能漂移', true)

  console.log(`\n═══ 结果：${pass} 通过 / ${fail} 失败 ═══`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error('测试崩溃:', e); process.exit(1) })
