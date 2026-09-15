/**
 * central-down-fields-test.ts —— 下行指令「顶层字段严格运行时契约」的边界验证（2026-09-15）
 *
 * 被验证的真实缺陷：`validateDownCommand()` 的顶层必填只做 `isBlank()` 判定，
 * 因此 `assignmentId: 0`、`assignmentId: {}`、`leadId: "41"`、`remindCount: {}` 全被判为合法并返回
 * `null`。中央 `/sync/commands` 依赖该共享校验器，校验通过即保存指令；本机接收状态机随后对部分值
 * `Number()` 转换、或根本不使用远端 `assignmentId` —— 于是畸形指令会在业务写入前**不被终止**，
 * 产生真实的分配 / 移交 / 回收 / 通知。同一条缺陷也在 `crmDownPayloadCompat.healLegacyDownPayload()`：
 * transfer 的 mode/SLA 已合法时，非正整数或指向不存在行的 `assignmentId` 会被放行。
 *
 * 本脚本覆盖四层，每层都要求**零副作用**（不写 lead / assignment / audit_event / notify_inbox，
 * 不写成功幂等标记，不生成可被中枢接受的 ACK）：
 *   A. 共享校验器逐字段负例（纯函数层，错误码稳定且只带字段名）；
 *   B. 中央 HTTP：真实 Fastify 路由 → 4xx，且库内无痕（不落下行事件 / 投影 / 审计 / 幂等键）；
 *   C. SMB 文件通道：真实 `consumeDownEvents` → `.failed/` 隔离 + 零业务写 + 零幂等标记 + 零 ACK；
 *   D. 历史 transfer 富化：来源行不存在 / 身份不符一律拒，合法来源行幂等通过并精确恢复。
 *
 * 隔离：WEFLOW_WORKER + WEFLOW_USER_DATA_PATH + WEFLOW_CONFIG_CWD 指向临时目录，
 *       业务模块一律在 main() 内动态 import。**不读真实生产库、不发真实网络请求。**
 * 运行：npx tsx scripts/central-down-fields-test.ts
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'
import { join } from 'path'

const isoDir = mkdtempSync(join(tmpdir(), 'central-down-fields-'))
process.env.WEFLOW_WORKER = '1'
process.env.WEFLOW_USER_DATA_PATH = isoDir
process.env.WEFLOW_CONFIG_CWD = isoDir

let pass = 0
let fail = 0
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; console.log(`  ✅ ${name}`) } else { fail++; console.log(`  ❌ ${name} ${detail}`) }
}

import type { CrmRow } from '../electron/services/crmDbService'
import type { DownTransport } from '../shared/centralDownCommand'

let crmDbService: (typeof import('../electron/services/crmDbService'))['crmDbService']
let validateDownCommand: (typeof import('../shared/centralDownCommand'))['validateDownCommand']
let healLegacyDownPayload: (typeof import('../electron/services/crmDownPayloadCompat'))['healLegacyDownPayload']
let lanSync: typeof import('../electron/services/lanSyncService')
let service: typeof import('../electron/services/centralSyncService')

/** Fastify 实例的最小结构（不引 fastify 类型，只用 inject） */
interface InjectResult { statusCode: number; payload: string }
interface AppLike { inject: (opts: { method: string; url: string; headers?: Record<string, string>; payload?: string }) => Promise<InjectResult> }

const ADMIN_TOKEN = 'admin-token-for-down-fields-that-is-longer-than-thirty-two-chars'
const WORKSPACE = randomUUID()
const BASE_URL = 'https://central.fields.local'
const SALES = '字段销售甲'
const SALES2 = '字段销售乙'
const SUPERVISOR = '字段主管'
const NOW = Date.now()
/** 与真实状态机写入的形态一致（identityService 的 actor 前缀口径） */
const ACTOR = `system:${SUPERVISOR}`

/** 全部非法 id 形态：0 / 负数 / 小数 / 字符串数字 / 空串 / NaN / Infinity / 对象 / 数组 / 布尔 */
const BAD_IDS: Array<[string, unknown]> = [
  ['0', 0], ['负数', -1], ['小数', 1.5], ['字符串数字', '41'], ['空串', ''],
  ['NaN', Number.NaN], ['Infinity', Number.POSITIVE_INFINITY], ['对象', {}], ['数组', []],
  ['布尔 true', true], ['布尔 false', false], ['null', null]
]

function insertAuditCounts(): { lead: number; assignment: number; audit: number; notify: number } {
  const n = (sql: string): number => Number(crmDbService.all(sql)[0]?.n || 0)
  return {
    lead: n('SELECT COUNT(*) AS n FROM lead'),
    assignment: n('SELECT COUNT(*) AS n FROM assignment'),
    audit: n('SELECT COUNT(*) AS n FROM audit_event'),
    notify: n('SELECT COUNT(*) AS n FROM notify_inbox')
  }
}

function countsEqual(a: ReturnType<typeof insertAuditCounts>, b: ReturnType<typeof insertAuditCounts>): boolean {
  return a.lead === b.lead && a.assignment === b.assignment && a.audit === b.audit && a.notify === b.notify
}

async function main(): Promise<void> {
  const { buildCentralApp } = await import('../central/src/app.js' as string)
  const { MemoryCentralStore } = await import('../central/src/memoryStore.js' as string)
  const { ConfigService } = await import('../electron/services/config')
  const shared = await import('../shared/centralDownCommand')
  validateDownCommand = shared.validateDownCommand
  crmDbService = (await import('../electron/services/crmDbService')).crmDbService
  const { salesDbService } = await import('../electron/services/salesDbService')
  const { setIdentity } = await import('../electron/services/identityService')
  const assignmentSvc = await import('../electron/services/crmAssignmentService')
  const leadSvc = await import('../electron/services/crmLeadService')
  healLegacyDownPayload = (await import('../electron/services/crmDownPayloadCompat')).healLegacyDownPayload
  lanSync = await import('../electron/services/lanSyncService')
  service = await import('../electron/services/centralSyncService')

  const cfg = ConfigService.getInstance()
  cfg.set('crmSalesList', [SALES, SALES2])
  cfg.set('crmLeadSlaHours', 24)
  await crmDbService.initialize(isoDir)
  await salesDbService.initialize(isoDir)
  setIdentity(SUPERVISOR, '主管')

  const memory = new MemoryCentralStore()
  const app = buildCentralApp({
    store: memory as never,
    config: { host: '127.0.0.1', port: 0, databaseUrl: 'memory://', adminToken: ADMIN_TOKEN, tlsTerminated: true, logLevel: 'silent' }
  } as never) as unknown as AppLike

  // ── 真值准备：一条真实线索 + 一次真实分配（供合法对照与身份一致性用例） ────────
  leadSvc.importLeads('fields', 'fields.csv', [
    { phone: '13900008001', name: '字段线索甲', source: '测试' },
    { phone: '13900008002', name: '字段线索乙', source: '测试' },
    { phone: '13900008003', name: '字段隔离占位线索', source: '测试' }
  ])
  const leadId = Number(crmDbService.all("SELECT id FROM lead WHERE contact_normalized = '13900008001'")[0]?.id || 0)
  const leadId2 = Number(crmDbService.all("SELECT id FROM lead WHERE contact_normalized = '13900008002'")[0]?.id || 0)
  const placeholderLeadId = Number(crmDbService.all("SELECT id FROM lead WHERE contact_normalized = '13900008003'")[0]?.id || 0)
  // 先为无关线索建一条 assignment，保证后面的 transfer 夹具不会把 leadId 恰好复用成 assignmentId；
  // D0 要证明真实移交确实是「旧行 + 新行」两条不同记录，而不是数字碰巧相等。
  assignmentSvc.assignLeads([placeholderLeadId], SALES2, SUPERVISOR)
  assignmentSvc.assignLeads([leadId], SALES2, SUPERVISOR)
  const assignmentId = Number(assignmentSvc.currentAssignment(leadId)?.id || 0)
  assignmentSvc.assignLeads([leadId2], SALES2, SUPERVISOR)
  const otherLeadAssignmentId = Number(assignmentSvc.currentAssignment(leadId2)?.id || 0)

  const leadSub = {
    leadId, name: '字段线索甲', contactType: 'phone', contactNormalized: '13900008001',
    contactRaw: '13900008001', wechat: '', source: '测试', note: ''
  }
  // 中央 HTTP 的 lead 口径固定为 6 字段；SMB 夹具继续使用上面的历史 8 字段口径。
  const centralLeadSub = {
    leadId, name: '字段线索甲', contactType: 'phone', contactNormalized: '13900008001', source: '测试', note: ''
  }
  /** 一条合法的 assign 载荷（逐用例只改一个字段，隔离变量） */
  const assignBase = (): Record<string, unknown> => ({
    type: 'assign', deliveryRole: 'apply', leadId, assignmentId, salesName: SALES,
    sla1Deadline: NOW + 86_400_000, actor: ACTOR, lead: { ...leadSub }
  })
  const assignSubject = (payload: Record<string, unknown>) => ({
    eventType: 'assign', entityType: 'assignment', payload, localDeliveryKey: 'k-fields'
  })
  const transferBase = (): Record<string, unknown> => ({
    type: 'transfer', deliveryRole: 'apply', leadId, assignmentId, oldAssignmentId: otherLeadAssignmentId,
    fromSales: SALES2, toSales: SALES, reason: '字段移交', mode: 'manual',
    sla1Deadline: NOW + 86_400_000, actor: ACTOR, lead: { ...leadSub }
  })
  const transferSubject = (payload: Record<string, unknown>) => ({
    eventType: 'transfer', entityType: 'assignment', payload, localDeliveryKey: 'k-fields'
  })

  console.log('═══ A. 共享校验器：顶层字段严格运行时契约 ═══')
  ok('A0 前置：真实线索与真实分配行已就位（否则后续全部是空断言）',
    leadId > 0 && leadId2 > 0 && placeholderLeadId > 0 && leadId !== leadId2 && assignmentId > 0 &&
    otherLeadAssignmentId > 0 && otherLeadAssignmentId !== assignmentId,
    JSON.stringify({ leadId, leadId2, assignmentId, otherLeadAssignmentId }))
  ok('A0b 对照：完全合法的 assign / transfer 载荷通过校验（证明负例不是被别的规则误伤）',
    validateDownCommand(assignSubject(assignBase()), 'smb') === null &&
    validateDownCommand(transferSubject(transferBase()), 'smb') === null,
    String(validateDownCommand(assignSubject(assignBase()), 'smb')))

  // ── A1 必填 id 字段：leadId / assignmentId 全部非法形态 ─────────────────────
  const idFieldCases: Array<{ field: string; build: (bad: unknown) => Record<string, unknown> }> = [
    { field: 'leadId', build: (bad) => ({ ...assignBase(), leadId: bad }) },
    { field: 'assignmentId', build: (bad) => ({ ...assignBase(), assignmentId: bad }) }
  ]
  // 期望码逐条明确写死：缺失 → missing_field；形态非法 → invalid_type；数值越界 → invalid_integer。
  // 不写「以 invalid_ 开头即可」这种比实现更宽的断言——那会让任何错误码都算通过。
  const idResults: Array<{ tag: string; code: string; want: string }> = []
  for (const { field, build } of idFieldCases) {
    for (const [tag, bad] of BAD_IDS) {
      const code = String(validateDownCommand(assignSubject(build(bad)), 'smb'))
      const want = (tag === '0' || tag === '负数' || tag === '小数') ? `invalid_integer:${field}`
        : tag === '空串' ? `missing_field:${field}`
        : `invalid_type:${field}`
      idResults.push({ tag: `${field}=${tag}`, code, want })
    }
    idResults.push({ tag: `${field}=缺失`, code: String(validateDownCommand(assignSubject({ ...assignBase(), [field]: undefined }), 'smb')), want: `missing_field:${field}` })
  }
  ok('A1 必填 leadId / assignmentId 的 12 种非法形态 + 缺失全部按稳定码拒收（缺失 missing_field / 形态 invalid_type / 越界 invalid_integer）',
    idResults.every((r) => r.code === r.want),
    JSON.stringify(idResults.filter((r) => r.code !== r.want)))
  // 静默转换的具体证据：这些值曾经全部返回 null（= 合法）
  // 缺陷复现（修复前这四条全部返回 null，即被判为合法并放行到业务写入）
  const repro: Array<[string, unknown]> = [
    ['assignmentId=0', String(validateDownCommand(assignSubject({ ...assignBase(), assignmentId: 0 }), 'smb'))],
    ['assignmentId={}', String(validateDownCommand(assignSubject({ ...assignBase(), assignmentId: {} }), 'smb'))],
    ['leadId="41"（子对象 leadId=41）', String(validateDownCommand(assignSubject({ ...assignBase(), leadId: '41' }), 'smb'))],
    ['oldAssignmentId=0', String(validateDownCommand(transferSubject({ ...transferBase(), oldAssignmentId: 0 }), 'smb'))]
  ]
  ok('A1b 缺陷复现：`assignmentId: 0` / `assignmentId: {}` / `leadId: "41"` / `oldAssignmentId: 0` 修复前全部返回 null（合法），现在全部按稳定码拒收',
    repro[0][1] === 'invalid_integer:assignmentId' && repro[1][1] === 'invalid_type:assignmentId' &&
    repro[2][1] === 'invalid_type:leadId' && repro[3][1] === 'invalid_integer:oldAssignmentId',
    JSON.stringify(repro))
  ok('A1c `remindCount: {}`（对象）同样不再合法 —— 旧实现只做 isBlank，对象被判为「非空」而放行',
    String(validateDownCommand({
      eventType: 'sla1_escalate_supervisor', entityType: 'assignment', localDeliveryKey: 'k-fields',
      payload: { type: 'sla1_escalate_supervisor', deliveryRole: 'notify', leadId, assignmentId, salesName: SALES, remindCount: {}, recycledAt: NOW }
    }, 'smb')) === 'invalid_type:remindCount')

  // ── A2 可选 oldAssignmentId：缺失允许，出现则同样严格 ────────────────────────
  const withoutOld = { ...transferBase() }
  delete withoutOld.oldAssignmentId
  ok('A2 oldAssignmentId 缺失时按现有协议允许（Phase 1 之外的历史信封可能不带）',
    validateDownCommand(transferSubject(withoutOld), 'smb') === null,
    String(validateDownCommand(transferSubject(withoutOld), 'smb')))
  const oldIdCodes = BAD_IDS.map(([tag, bad]) =>
    [tag, String(validateDownCommand(transferSubject({ ...transferBase(), oldAssignmentId: bad }), 'smb'))] as [string, string])
  ok('A2b oldAssignmentId 出现即必须是原始 number 正整数：0 / 负数 / 小数 / 字符串 / 空串 / 对象 / 数组 / 布尔 / NaN / Infinity 一律稳定码拒收（null 与省略同义 = 未提供，故合法）',
    oldIdCodes.every(([tag, code]) =>
      // 可选字段的 `null` 与「省略该键」同义（未提供）；其余形态一律按稳定码拒收。
      code === ((tag === '0' || tag === '负数' || tag === '小数') ? 'invalid_integer:oldAssignmentId'
        : tag === 'null' ? 'null'
        : 'invalid_type:oldAssignmentId')) &&
    validateDownCommand(transferSubject({ ...transferBase(), oldAssignmentId: 1 }), 'smb') === null &&
    validateDownCommand(transferSubject({ ...transferBase(), oldAssignmentId: assignmentId }), 'smb') === null,
    JSON.stringify(oldIdCodes))

  // ── A3 remindCount：0/3 边界允许，越界与非法形态拒收 ──────────────────────────
  const sla1Subject = (remindCount: unknown) => ({
    eventType: 'sla1_escalate_supervisor', entityType: 'assignment', localDeliveryKey: 'k-fields',
    payload: { type: 'sla1_escalate_supervisor', deliveryRole: 'notify', leadId, assignmentId, salesName: SALES, remindCount, reason: 'SLA三次超时回收', recycledAt: NOW }
  })
  ok('A3 remindCount 真实值域 [0,3] 的边界值允许：所有到达终端的值都在此区间（生产者恒发 3，列语义是「已提醒次数」）',
    validateDownCommand(sla1Subject(0), 'smb') === null && validateDownCommand(sla1Subject(3), 'smb') === null,
    JSON.stringify({ v0: String(validateDownCommand(sla1Subject(0), 'smb')), v3: String(validateDownCommand(sla1Subject(3), 'smb')) }))
  ok('A3b remindCount 越界（-1 / 4 / 999）与非法形态一律拒收 `invalid_integer:remindCount` —— 越界值会让主管收到的「N/3 次」变成假话',
    [-1, 4, 999].every((bad) => validateDownCommand(sla1Subject(bad), 'smb') === 'invalid_integer:remindCount') &&
    [1.5, '3', {}, [], true, Number.NaN, Number.POSITIVE_INFINITY].every((bad) => String(validateDownCommand(sla1Subject(bad), 'smb')).includes('remindCount')))
  ok('A3c remindCount 缺失仍返回 missing_field:remindCount（缺失与非法是两回事）',
    validateDownCommand(sla1Subject(undefined), 'smb') === 'missing_field:remindCount')

  // ── A4 slaHours：SMB 历史信封口径，出现即必须是 1-72 的原始 number 整数 ───────
  ok('A4 slaHours 真实值域 [1,72] 的边界值允许（口径 = crmLeadSlaHours 配置的可接受区间）',
    [1, 24, 72].every((v) => validateDownCommand(assignSubject({ ...assignBase(), slaHours: v }), 'smb') === null))
  ok('A4b slaHours 越界（0 / 73 / -1）与非法形态（字符串数字 / 对象 / 数组 / 布尔 / NaN / Infinity / 小数）一律拒收，绝不让下游 Number() 静默变成另一段时间',
    [0, 73, -1].every((bad) => validateDownCommand(assignSubject({ ...assignBase(), slaHours: bad }), 'smb') === 'invalid_integer:slaHours') &&
    ['24', 1.5, {}, [], true, Number.NaN, Number.POSITIVE_INFINITY].every((bad) => {
      const code = String(validateDownCommand(assignSubject({ ...assignBase(), slaHours: bad }), 'smb'))
      return code === 'invalid_type:slaHours' || code === 'invalid_integer:slaHours'
    }))

  // ── A4c JS 安全整数边界：所有整数/时间戳字段统一拒绝 unsafe number ────────
  const maxSafe = Number.MAX_SAFE_INTEGER
  const minUnsafe = Number.MIN_SAFE_INTEGER - 1
  const safeLead = { ...leadSub, leadId: maxSafe }
  const safeBoundaryCases: Array<[string, string | null, string | null]> = [
    ['leadId=max_safe', validateDownCommand(assignSubject({ ...assignBase(), leadId: maxSafe, lead: safeLead }), 'smb'), null],
    ['assignmentId=max_safe', validateDownCommand(assignSubject({ ...assignBase(), assignmentId: maxSafe }), 'smb'), null],
    ['oldAssignmentId=max_safe', validateDownCommand(transferSubject({ ...transferBase(), oldAssignmentId: maxSafe }), 'smb'), null],
    ['sla1Deadline=max_safe', validateDownCommand(transferSubject({ ...transferBase(), sla1Deadline: maxSafe }), 'smb'), null],
    ['recycledAt=max_safe', validateDownCommand({
      eventType: 'sla1_escalate_supervisor', entityType: 'assignment', localDeliveryKey: 'k-fields',
      payload: { ...sla1Subject(3).payload, recycledAt: maxSafe }
    }, 'smb'), null],
    ['leadId=min_unsafe', validateDownCommand(assignSubject({ ...assignBase(), leadId: minUnsafe }), 'smb'), 'invalid_integer:leadId'],
    ['assignmentId=min_unsafe', validateDownCommand(assignSubject({ ...assignBase(), assignmentId: minUnsafe }), 'smb'), 'invalid_integer:assignmentId'],
    ['oldAssignmentId=min_unsafe', validateDownCommand(transferSubject({ ...transferBase(), oldAssignmentId: minUnsafe }), 'smb'), 'invalid_integer:oldAssignmentId'],
    ['sla1Deadline=min_unsafe', validateDownCommand(transferSubject({ ...transferBase(), sla1Deadline: minUnsafe }), 'smb'), 'invalid_timestamp:sla1Deadline'],
    ['recycledAt=min_unsafe', validateDownCommand({
      eventType: 'sla1_escalate_supervisor', entityType: 'assignment', localDeliveryKey: 'k-fields',
      payload: { ...sla1Subject(3).payload, recycledAt: minUnsafe }
    }, 'smb'), 'invalid_timestamp:recycledAt'],
    ['leadId=max_safe+1', validateDownCommand(assignSubject({ ...assignBase(), leadId: maxSafe + 1 }), 'smb'), 'invalid_integer:leadId'],
    ['sla1Deadline=max_safe+1', validateDownCommand(transferSubject({ ...transferBase(), sla1Deadline: maxSafe + 1 }), 'smb'), 'invalid_timestamp:sla1Deadline']
  ]
  ok('A4c 安全整数边界：MAX_SAFE_INTEGER 可作为未收窄字段值，超出/低于安全范围按稳定 integer/timestamp 码拒收',
    safeBoundaryCases.every(([, got, want]) => want === null ? got === null : got === want),
    JSON.stringify(safeBoundaryCases.filter(([, got, want]) => want === null ? got !== null : got !== want)))

  // ── A5 顶层 leadId 与 lead.leadId 一致性：原始数字直接比较 ─────────────────────
  ok('A5 顶层 `leadId: "41"`（字符串）+ 子对象 `leadId: 41`（数字）→ 拒收，而不是因 Number() 相等而通过',
    validateDownCommand(assignSubject({ ...assignBase(), leadId: '41', lead: { ...leadSub, leadId: 41 } }), 'smb') !== null)
  ok('A5b 两侧都是原始 number 且相等 → 通过',
    validateDownCommand(assignSubject({ ...assignBase(), leadId, lead: { ...leadSub, leadId } }), 'smb') === null)
  ok('A5c 两侧都是原始 number 但不相等 → lead_id_mismatch（不按其中一个猜）',
    validateDownCommand(assignSubject({ ...assignBase(), leadId, lead: { ...leadSub, leadId: leadId2 } }), 'smb') === 'lead_id_mismatch')

  // ── A6 顶层标量字符串字段：出现即不许是对象 / 数组 / undefined ─────────────────
  //    注意 reason/toSales/fromSales 是 transfer/sla1 专属字段，在 assign 载荷里属白名单外，
  //    由更早的 unknown_field 兜底——这里只对 assign 载荷中登记的字符串字段做断言。
  const stringFields: Array<[string, unknown]> = [['salesName', {}], ['salesName', []], ['actor', {}], ['actor', []]]
  const stringCodes = stringFields.map(([field, bad]) =>
    [field, String(validateDownCommand(assignSubject({ ...assignBase(), [field]: bad }), 'smb'))] as [string, string])
  ok('A6 已登记的顶层字符串字段出现即必须是字符串字面量（对象 / 数组一律 invalid_type，不被 String() 洗白）',
    stringCodes.every(([field, code]) => code === `invalid_type:${field}`), JSON.stringify(stringCodes))
  const sameCode = (field: string, expect: string): boolean => {
    const explicit = String(validateDownCommand(assignSubject({ ...assignBase(), [field]: undefined }), 'smb'))
    const omittedPayload = assignBase(); delete omittedPayload[field]
    return explicit === expect && String(validateDownCommand(assignSubject(omittedPayload), 'smb')) === expect
  }
  ok('A6b 必填字符串字段：显式 undefined 与「省略该键」同为 missing_field（JSON 信道上 undefined 键会被序列化掉，两者本就是同一件事）',
    sameCode('salesName', 'missing_field:salesName'))
  ok('A6b2 可选字符串字段（actor）：显式 undefined 与省略同为「未提供」而合法 —— 不得把可选字段的省略误判成非法形态',
    sameCode('actor', 'null'))
  const optionalNullCases: Array<[string, string | null, string]> = [
    ['actor:null', validateDownCommand(assignSubject({ ...assignBase(), actor: null }), 'smb'), 'invalid_type:actor'],
    ['sla1Deadline:null', validateDownCommand(assignSubject({ ...assignBase(), sla1Deadline: null }), 'smb'), 'invalid_timestamp:sla1Deadline'],
    ['reason:null', validateDownCommand(transferSubject({ ...transferBase(), reason: null }), 'smb'), 'invalid_type:reason'],
    ['oldAssignmentId:null', validateDownCommand(transferSubject({ ...transferBase(), oldAssignmentId: null }), 'smb'), null],
    ['mode:null', validateDownCommand(assignSubject({ ...assignBase(), mode: null }), 'smb'), 'invalid_enum:mode']
  ]
  const optionalOmittedCases: Array<[string, Record<string, unknown>, string | null]> = [
    ['actor', (() => { const p = assignBase(); delete p.actor; return p })(), null],
    ['sla1Deadline', (() => { const p = assignBase(); delete p.sla1Deadline; return p })(), null],
    ['reason', (() => { const p = transferBase(); delete p.reason; return p })(), null],
    ['oldAssignmentId', (() => { const p = transferBase(); delete p.oldAssignmentId; return p })(), null],
    ['mode', assignBase(), null]
  ]
  ok('A6d 可选字段显式 null 不再静默等同省略；唯一历史例外是 transfer.oldAssignmentId:null 合法',
    optionalNullCases.every(([, got, want]) => got === want), JSON.stringify(optionalNullCases))
  ok('A6e 上述可选字段完全省略仍合法（undefined 也按省略处理）',
    optionalOmittedCases.every(([field, payload, want]) => {
      if (field === 'mode') return validateDownCommand(assignSubject(payload), 'smb') === want
      if (field === 'reason' || field === 'oldAssignmentId') return validateDownCommand(transferSubject(payload), 'smb') === want
      return validateDownCommand(assignSubject(payload), 'smb') === want
    }))
  ok('A6c 白名单外的字段一律 unknown_field 拦截，绝不进入业务写入（不是「未登记所以不查」）',
    ([['reason', {}], ['toSales', []], ['fromSales', {}], ['remindCount', 3]] as Array<[string, unknown]>).every(([field, bad]) =>
      String(validateDownCommand(assignSubject({ ...assignBase(), [field]: bad }), 'smb')) === `unknown_field:${field}`))

  // ── A7 注册表责任归属：allowed 不能成为「登记但不校验」的旁路 ────────────────
  const registryErrors = shared.downCommandSpecResponsibilityErrors()
  ok('A7 注册表结构自查：每个 allowed 顶层字段都有唯一/明确责任（fields / enums / lead / deliveryRole）',
    registryErrors.length === 0, JSON.stringify(registryErrors))
  const brokenSpecs = {
    ...shared.DOWN_COMMAND_SPECS,
    assign: { ...shared.DOWN_COMMAND_SPECS.assign, allowed: [...shared.DOWN_COMMAND_SPECS.assign.allowed, 'unregistered'] }
  }
  const brokenRegistryErrors = shared.downCommandSpecResponsibilityErrors(brokenSpecs)
  ok('A7b 注册表新增未登记 allowed 字段时责任自查会明确失败（防止 detail 旁路回归）',
    brokenRegistryErrors.includes('assign:allowed:unregistered:missing'), JSON.stringify(brokenRegistryErrors))

  // ── A8 supervisor_correction.detail：普通对象结构 + 递归禁字段 ───────────────
  const correctionBase = (): Record<string, unknown> => ({
    type: 'supervisor_correction', deliveryRole: 'apply', leadId,
    assignmentId, title: '主管修正', summary: '请确认'
  })
  const correctionSubject = (payload: Record<string, unknown>) => ({
    eventType: 'supervisor_correction', entityType: 'assignment', payload, localDeliveryKey: 'k-fields'
  })
  ok('A8 detail 省略、空对象、普通对象均通过共享校验',
    validateDownCommand(correctionSubject(correctionBase()), 'smb') === null &&
    validateDownCommand(correctionSubject({ ...correctionBase(), detail: {} }), 'smb') === null &&
    validateDownCommand(correctionSubject({ ...correctionBase(), detail: { reasonCode: 'x' } }), 'smb') === null)
  const detailBadCases: Array<[string, unknown, string]> = [
    ['null', null, 'invalid_type:detail'], ['array', [], 'invalid_type:detail'],
    ['string', 'not-an-object', 'invalid_type:detail'], ['number', 1, 'invalid_type:detail'],
    ['boolean', true, 'invalid_type:detail'],
    ['nested forbidden', { nested: { messageBody: '客户原话' } }, 'forbidden_field:detail.nested.messageBody']
  ]
  ok('A8b detail 的 null/数组/字符串/数字/布尔按唯一错误码拒收，深层禁字段仍由共享扫描拒收',
    detailBadCases.every(([, value, want]) => validateDownCommand(correctionSubject({ ...correctionBase(), detail: value }), 'smb') === want),
    JSON.stringify(detailBadCases.map(([name, value, want]) => ({ name, got: validateDownCommand(correctionSubject({ ...correctionBase(), detail: value }), 'smb'), want }))))

  // ═══ B. 中央 HTTP：4xx 且库内无痕 ════════════════════════════════════════════
  console.log('\n═══ B. 中央 HTTP /sync/commands：非法顶层字段 → 4xx，且不落下行事件 / 投影 / 审计 ═══')
  /** 走真实邀请码 → 认领链路，得到一个已绑定工作区的设备主体 */
  const onboard = async (employeeCode: string, displayName: string, role: string) => {
    const invite = await app.inject({
      method: 'POST', url: '/api/v1/bindings/invitations',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: JSON.stringify({ workspaceId: WORKSPACE, employeeCode, displayName, role })
    })
    const inviteCode = String((JSON.parse(invite.payload) as { data?: { inviteCode?: string } }).data?.inviteCode || '')
    const claim = await app.inject({
      method: 'POST', url: '/api/v1/bindings/claim',
      headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ inviteCode, deviceName: `${employeeCode}-机器` })
    })
    const d = (JSON.parse(claim.payload) as {
      data?: { deviceToken?: string; principal?: { employeeId?: string; deviceId?: string; workspaceId?: string } }
    }).data
    return {
      token: String(d?.deviceToken || ''), employeeId: String(d?.principal?.employeeId || ''),
      deviceId: String(d?.principal?.deviceId || ''), workspaceId: String(d?.principal?.workspaceId || '')
    }
  }
  // ⚠️ 用**主管**身份签发：销售设备没有 command.issue 能力，用它发指令会在 preHandler 就 403
  //    （E403「当前角色无权执行 command.issue」），那样测到的是权限而不是字段契约。销售设备只作投递目标。
  const issuer = await onboard('F001', SUPERVISOR, 'supervisor')
  const target = await onboard('F002', SALES, 'sales')
  const token = issuer.token
  const targetEmployeeId = target.employeeId
  const deviceId = target.deviceId
  ok('B0 前置：主管设备（具备 command.issue）与销售设备（作为投递目标）均已通过真实邀请码认领，工作区一致',
    token.length > 0 && deviceId.length > 0 && targetEmployeeId.length > 0 &&
    issuer.workspaceId === target.workspaceId && issuer.workspaceId.length > 0)

  const downCommand = {
    protocolVersion: 1, eventId: '', eventSeq: 1, idempotencyKey: '', direction: 'down',
    entityType: 'assignment', entityId: `${deviceId}/assignment:${assignmentId}`,
    eventType: 'assign', aggregateVersion: 1, payload: {},
    targetEmployeeId, targetDeviceId: deviceId, occurredAt: NOW
  }
  const post = (suffix: string, payload: Record<string, unknown>, eventType = 'assign') => app.inject({
    method: 'POST', url: '/api/v1/sync/commands',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() },
    payload: JSON.stringify({ ...downCommand, eventId: `f-${suffix}`, idempotencyKey: `f-${suffix}`, eventType, payload })
  })
  const storeLike = memory as unknown as { downEventCount: () => number }
  const downBefore = storeLike.downEventCount()
  const centralAuditBefore = memory.auditActions().length

  const centralAssignBase = (): Record<string, unknown> => ({ ...assignBase(), lead: { ...centralLeadSub } })
  const centralTransferBase = (): Record<string, unknown> => ({ ...transferBase(), lead: { ...centralLeadSub } })

  const httpCases: Array<[string, Record<string, unknown>, string, string]> = []
  for (const [tag, bad] of BAD_IDS) {
    httpCases.push([`assign-leadId-${tag}`, { ...centralAssignBase(), leadId: bad }, 'assign', 'leadId'])
    httpCases.push([`assign-assignmentId-${tag}`, { ...centralAssignBase(), assignmentId: bad }, 'assign', 'assignmentId'])
  }
  httpCases.push(['assign-leadId-missing', { ...centralAssignBase(), leadId: undefined }, 'assign', 'leadId'])
  httpCases.push(['assign-assignmentId-missing', { ...centralAssignBase(), assignmentId: undefined }, 'assign', 'assignmentId'])
  httpCases.push(['transfer-oldAssignmentId-object', { ...centralTransferBase(), oldAssignmentId: {} }, 'transfer', 'oldAssignmentId'])
  httpCases.push(['sla1-remindCount-object', {
    type: 'sla1_escalate_supervisor', deliveryRole: 'notify', leadId, assignmentId, salesName: SALES,
    remindCount: {}, recycledAt: NOW
  }, 'sla1_escalate_supervisor', 'remindCount'])
  httpCases.push(['sla1-remindCount-overflow', {
    type: 'sla1_escalate_supervisor', deliveryRole: 'notify', leadId, assignmentId, salesName: SALES,
    remindCount: 99, recycledAt: NOW
  }, 'sla1_escalate_supervisor', 'remindCount'])
  httpCases.push(['assign-slaHours-object', { ...centralAssignBase(), slaHours: {} }, 'assign', 'slaHours'])
  httpCases.push(['assign-slaHours-overflow', { ...centralAssignBase(), slaHours: 999 }, 'assign', 'slaHours'])
  httpCases.push(['assign-actor-null', { ...centralAssignBase(), actor: null }, 'assign', 'invalid_type:actor'])
  httpCases.push(['assign-sla1Deadline-null', { ...centralAssignBase(), sla1Deadline: null }, 'assign', 'invalid_timestamp:sla1Deadline'])
  httpCases.push(['assign-mode-null', { ...centralAssignBase(), mode: null }, 'assign', 'invalid_enum:mode'])
  httpCases.push(['transfer-reason-null', { ...centralTransferBase(), reason: null }, 'transfer', 'invalid_type:reason'])
  // 跨类型：顶层字符串 vs 子对象数字 —— 在**字段类型层**就被拦（不靠 Number() 相等侥幸放过）
  httpCases.push(['assign-leadId-string', { ...centralAssignBase(), leadId: '41', lead: { ...centralLeadSub, leadId: 41 } }, 'assign', 'invalid_type:leadId'])
  // 同为 number 但不等 —— 必须走到一致性判定
  const httpLead = (id: number) => ({
    leadId: id, name: '字段线索甲', contactType: 'phone', contactNormalized: '13900008001', source: '测试', note: ''
  })
  httpCases.push(['assign-leadId-mismatch', { ...centralAssignBase(), leadId, lead: httpLead(leadId2) }, 'assign', 'lead_id_mismatch'])
  const invalidRoleValues: Array<[string, unknown, string]> = [
    ['missing', undefined, 'missing_field:deliveryRole'], ['array', ['apply'], 'invalid_type:deliveryRole'],
    ['object', { 0: 'apply' }, 'invalid_type:deliveryRole'], ['number', 1, 'invalid_type:deliveryRole'],
    ['boolean', true, 'invalid_type:deliveryRole'], ['null', null, 'missing_field:deliveryRole'],
    ['empty', '', 'missing_field:deliveryRole']
  ]
  for (const [tag, role, expect] of invalidRoleValues) {
    const payload = { ...centralAssignBase(), deliveryRole: role }
    if (tag === 'missing') delete payload.deliveryRole
    httpCases.push([`assign-deliveryRole-${tag}`, payload, 'assign', expect])
  }
  const missingType = centralAssignBase()
  delete missingType.type
  httpCases.push(['assign-type-missing', missingType, 'assign', 'missing_field:type'])
  for (const [tag, value, expect] of [
    ['object', {}, 'invalid_type:type'], ['array', ['assign'], 'invalid_type:type'],
    ['number', 1, 'invalid_type:type'], ['boolean', true, 'invalid_type:type'],
    ['null', null, 'invalid_type:type'], ['empty', '', 'missing_field:type']
  ] as Array<[string, unknown, string]>) {
    httpCases.push([`assign-type-${tag}`, { ...centralAssignBase(), type: value }, 'assign', expect])
  }
  httpCases.push(['assign-type-mismatch-recycle', { ...centralAssignBase(), type: 'recycle' }, 'assign', 'payload_type_mismatch'])
  httpCases.push(['transfer-type-mismatch-assign', { ...centralTransferBase(), type: 'assign' }, 'transfer', 'payload_type_mismatch'])
  const correctionHttpBase = (detail?: unknown): Record<string, unknown> => ({
    type: 'supervisor_correction', deliveryRole: 'apply', leadId, assignmentId,
    title: '主管修正', summary: '请确认', ...(detail === undefined ? {} : { detail })
  })
  for (const [tag, detail, expect] of [
    ['null', null, 'invalid_type:detail'], ['array', [], 'invalid_type:detail'],
    ['string', 'not-an-object', 'invalid_type:detail'], ['number', 1, 'invalid_type:detail'],
    ['boolean', true, 'invalid_type:detail'],
    ['nested-forbidden', { nested: { messageBody: '客户原话' } }, 'detail.nested.messageBody']
  ] as Array<[string, unknown, string]>) {
    httpCases.push([`supervisor-correction-detail-${tag}`, correctionHttpBase(detail), 'supervisor_correction', expect])
  }

  const httpResults: Array<[string, number, string]> = []
  let httpAllReject = true
  for (const [suffix, payload, eventType, expect] of httpCases) {
    const res = await post(suffix, payload, eventType)
    const message = String((JSON.parse(res.payload) as { message?: string }).message || '')
    httpResults.push([suffix, res.statusCode, message])
    if (res.statusCode < 400 || res.statusCode >= 500 || !message.includes(expect)) httpAllReject = false
  }
  ok(`B1 中央 HTTP 对 ${httpCases.length} 类非法顶层字段载荷全部返 4xx，且拒收原因指向对应字段`,
    httpAllReject,
    JSON.stringify(httpResults.filter(([s, c, m]) => c < 400 || c >= 500 || !m.includes(httpCases.find(([x]) => x === s)![3]))))
  ok('B2 全部被拒请求在中央零痕迹：不落下行事件、不留审计（被拒请求不留痕，审计条数不随探测增长）',
    storeLike.downEventCount() === downBefore && memory.auditActions().length === centralAuditBefore,
    JSON.stringify({ downBefore, downAfter: storeLike.downEventCount(), centralAuditBefore, centralAuditAfter: memory.auditActions().length }))
  // 不消耗幂等键：修正后的同一 key 必须被受理（否则探测一次就把正常指令永久卡死）
  const reuseKey = 'f-reuse-after-reject'
  const reused = await app.inject({
    method: 'POST', url: '/api/v1/sync/commands',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() },
    payload: JSON.stringify({ ...downCommand, eventId: 'f-reuse', idempotencyKey: reuseKey, payload: { ...assignBase(), leadId: 0 } })
  })
  const recovered = await app.inject({
    method: 'POST', url: '/api/v1/sync/commands',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() },
    payload: JSON.stringify({
      ...downCommand, eventId: 'f-reuse', idempotencyKey: reuseKey,
      payload: { type: 'assign', deliveryRole: 'apply', leadId, assignmentId, salesName: SALES, sla1Deadline: NOW + 86_400_000, actor: ACTOR,
        lead: { leadId, name: '字段线索甲', contactType: 'phone', contactNormalized: '13900008001', source: '测试', note: '' } }
    })
  })
  ok('B3 非法指令不消耗幂等键：修正后同 key 受理 → 201（不把一次探测变成永久卡死）',
    reused.statusCode === 400 && recovered.statusCode === 201,
    JSON.stringify({ reused: reused.statusCode, recovered: recovered.statusCode }))
  const transferNullOld = await post('transfer-oldAssignmentId-null', {
    ...centralTransferBase(), oldAssignmentId: null
  }, 'transfer')
  const correctionValid = await post('supervisor-correction-detail-valid', correctionHttpBase({ reasonCode: 'name_mismatch', source: 'fields' }), 'supervisor_correction')
  ok('B4 历史例外 oldAssignmentId:null 仍可受理，普通 detail 对象也可受理 → 201',
    transferNullOld.statusCode === 201 && correctionValid.statusCode === 201,
    JSON.stringify({ transferNullOld: transferNullOld.statusCode, correctionValid: correctionValid.statusCode }))

  // ═══ C. SMB 文件通道：.failed 隔离 + 零业务写 ═════════════════════════════════
  console.log('\n═══ C. SMB 文件通道：非法顶层字段经真实 consumeDownEvents → .failed 隔离，零业务写 / 零幂等标记 / 零 ACK ═══')
  // ⚠️ 隔离根目录必须与业务库 isoDir 分开：队列由 up/down 目录结构定义，把队列塞进业务库根
  //    会让 up/ 与 down/ 的扫描互相干扰。业务库 = isoDir，SMB 共享根 = smbRoot。
  const smbRoot = mkdtempSync(join(tmpdir(), 'central-down-fields-smb-'))
  cfg.set('lanSyncSharedDir', smbRoot)
  cfg.set('lanSyncRole', 'terminal')
  setIdentity(SALES, '销售')
  const rk = lanSync.deliveryKey(SALES)
  const downDir = join(smbRoot, 'down', rk)
  const failedDir = join(downDir, '.failed')
  mkdirSync(downDir, { recursive: true })
  const missingRole = Symbol('missing-delivery-role')
  const smbFile = (tag: string, seq: number, payload: Record<string, unknown>, eventType = 'assign', outerRole: unknown = 'apply') => ({
    name: lanSync.deliveryFileName(seq, `${eventType}:f-${tag}`, 'apply'),
    body: {
      eventSeq: seq, idempotencyKey: `${eventType}:f-${tag}`, type: eventType, deliveryRole: outerRole,
      to: rk, payload, emittedAt: NOW
    }
  })
  const smbCases: Array<[string, Record<string, unknown>, string, string, unknown?]> = [
    ['assign-assignmentId-zero', { ...assignBase(), assignmentId: 0 }, 'assign', 'invalid_integer:assignmentId'],
    ['assign-assignmentId-object', { ...assignBase(), assignmentId: {} }, 'assign', 'invalid_type:assignmentId'],
    ['assign-leadId-numeric-string', { ...assignBase(), leadId: '41' }, 'assign', 'invalid_type:leadId'],
    ['assign-leadId-missing', { ...assignBase(), leadId: undefined }, 'assign', 'missing_field:leadId'],
    ['assign-slaHours-overflow', { ...assignBase(), slaHours: 999 }, 'assign', 'invalid_integer:slaHours'],
    ['assign-slaHours-numeric-string', { ...assignBase(), slaHours: '24' }, 'assign', 'invalid_type:slaHours'],
    ['transfer-oldAssignmentId-array', { ...transferBase(), oldAssignmentId: [] }, 'transfer', 'invalid_type:oldAssignmentId'],
    ['assign-actor-null', { ...assignBase(), actor: null }, 'assign', 'invalid_type:actor'],
    ['assign-sla1Deadline-null', { ...assignBase(), sla1Deadline: null }, 'assign', 'invalid_timestamp:sla1Deadline'],
    ['assign-mode-null', { ...assignBase(), mode: null }, 'assign', 'invalid_enum:mode'],
    ['transfer-reason-null', { ...transferBase(), reason: null }, 'transfer', 'invalid_type:reason'],
    ['transfer-lead-id-cross-type', { ...transferBase(), leadId: '41', lead: { ...leadSub, leadId: 41 } }, 'transfer', 'invalid_type:leadId'],
    ['assign-outer-role-missing', { ...assignBase() }, 'assign', 'deliveryRole 缺失或非法', missingRole],
    ['assign-outer-role-array', { ...assignBase() }, 'assign', 'deliveryRole 缺失或非法', ['apply']],
    ['assign-outer-role-object', { ...assignBase() }, 'assign', 'deliveryRole 缺失或非法', { role: 'apply' }],
    ['assign-outer-role-number', { ...assignBase() }, 'assign', 'deliveryRole 缺失或非法', 1],
    ['assign-outer-role-boolean', { ...assignBase() }, 'assign', 'deliveryRole 缺失或非法', true],
    ['assign-outer-role-null', { ...assignBase() }, 'assign', 'deliveryRole 缺失或非法', null],
    ['assign-outer-role-empty', { ...assignBase() }, 'assign', 'deliveryRole 缺失或非法', ''],
    ['assign-payload-role-array', { ...assignBase(), deliveryRole: ['apply'] }, 'assign', 'invalid_type:deliveryRole'],
    ['assign-payload-role-object', { ...assignBase(), deliveryRole: { role: 'apply' } }, 'assign', 'invalid_type:deliveryRole'],
    ['assign-payload-role-number', { ...assignBase(), deliveryRole: 1 }, 'assign', 'invalid_type:deliveryRole'],
    ['assign-payload-role-boolean', { ...assignBase(), deliveryRole: true }, 'assign', 'invalid_type:deliveryRole'],
    ['assign-payload-role-null', { ...assignBase(), deliveryRole: null }, 'assign', 'missing_field:deliveryRole'],
    ['assign-payload-role-empty', { ...assignBase(), deliveryRole: '' }, 'assign', 'missing_field:deliveryRole'],
    ['assign-type-missing', (() => { const p = assignBase(); delete p.type; return p })(), 'assign', 'missing_field:type'],
    ['assign-type-object', { ...assignBase(), type: {} }, 'assign', 'invalid_type:type'],
    ['assign-type-array', { ...assignBase(), type: ['assign'] }, 'assign', 'invalid_type:type'],
    ['assign-type-number', { ...assignBase(), type: 1 }, 'assign', 'invalid_type:type'],
    ['assign-type-boolean', { ...assignBase(), type: true }, 'assign', 'invalid_type:type'],
    ['assign-type-null', { ...assignBase(), type: null }, 'assign', 'invalid_type:type'],
    ['assign-type-empty', { ...assignBase(), type: '' }, 'assign', 'missing_field:type'],
    ['assign-type-mismatch-recycle', { ...assignBase(), type: 'recycle' }, 'assign', 'payload_type_mismatch'],
    ['transfer-type-mismatch-assign', { ...transferBase(), type: 'assign' }, 'transfer', 'payload_type_mismatch'],
    ['supervisor-correction-detail-null', {
      type: 'supervisor_correction', deliveryRole: 'apply', leadId, assignmentId,
      title: '主管修正', summary: '请确认', detail: null
    }, 'supervisor_correction', 'invalid_type:detail'],
    ['supervisor-correction-detail-array', {
      type: 'supervisor_correction', deliveryRole: 'apply', leadId, assignmentId,
      title: '主管修正', summary: '请确认', detail: []
    }, 'supervisor_correction', 'invalid_type:detail'],
    ['supervisor-correction-detail-string', {
      type: 'supervisor_correction', deliveryRole: 'apply', leadId, assignmentId,
      title: '主管修正', summary: '请确认', detail: 'not-an-object'
    }, 'supervisor_correction', 'invalid_type:detail'],
    ['supervisor-correction-detail-number', {
      type: 'supervisor_correction', deliveryRole: 'apply', leadId, assignmentId,
      title: '主管修正', summary: '请确认', detail: 1
    }, 'supervisor_correction', 'invalid_type:detail'],
    ['supervisor-correction-detail-boolean', {
      type: 'supervisor_correction', deliveryRole: 'apply', leadId, assignmentId,
      title: '主管修正', summary: '请确认', detail: true
    }, 'supervisor_correction', 'invalid_type:detail'],
    ['supervisor-correction-detail-nested-forbidden', {
      type: 'supervisor_correction', deliveryRole: 'apply', leadId, assignmentId,
      title: '主管修正', summary: '请确认', detail: { nested: { messageBody: '客户原话' } }
    }, 'supervisor_correction', 'detail.nested.messageBody']
  ]
  let smbDirectPass = true
  for (const [tag, payload, eventType, expect, outerRole] of smbCases) {
    const f = smbFile(tag, 900, payload, eventType, outerRole)
    const reason = String(lanSync.validateDownEventFile(f.body as never, rk, f.name))
    if (!reason.includes(expect)) { smbDirectPass = false; console.log(`    ✗ ${tag}: ${reason}（期望含 ${expect}）`) }
  }
  ok(`C1 ${smbCases.length} 类非法 SMB 载荷在进入状态机前被拒，错误码指向对应字段`, smbDirectPass)
  const validSmbCorrection = smbFile('supervisor-correction-detail-valid', 901, {
    type: 'supervisor_correction', deliveryRole: 'apply', leadId, assignmentId,
    title: '主管修正', summary: '请确认', detail: { reasonCode: 'name_mismatch', source: 'fields' }
  }, 'supervisor_correction')
  ok('C1b SMB 普通 detail 对象通过共享校验（非法形态才隔离）',
    lanSync.validateDownEventFile(validSmbCorrection.body as never, rk, validSmbCorrection.name) === null)
  const validSmbTransfer = smbFile('transfer-oldAssignmentId-null', 902, {
    ...transferBase(), oldAssignmentId: null
  }, 'transfer')
  ok('C1c SMB 历史例外 oldAssignmentId:null 仍按未提供处理并通过共享校验',
    lanSync.validateDownEventFile(validSmbTransfer.body as never, rk, validSmbTransfer.name) === null)

  /** 把一批事件写进队列目录，跑一轮真实消费，返回结果 */
  const runQueue = (root: string, cases: Array<[string, Record<string, unknown>, string, string, unknown?]>, seq: number) => {
    const dir = join(root, 'down', lanSync.deliveryKey(SALES))
    mkdirSync(dir, { recursive: true })
    for (const [tag, payload, eventType, , outerRole] of cases) {
      const f = smbFile(tag, seq, payload, eventType, outerRole)
      writeFileSync(join(dir, f.name), JSON.stringify(f.body))
    }
    return { dir, result: lanSync.consumeDownEvents(root) }
  }

  const beforeSmb = insertAuditCounts()
  const { dir: cDir, result: smbRound } = runQueue(smbRoot, smbCases, 900)
  const cFailedDir = join(cDir, '.failed')
  ok(`C2 非法文件全部 .failed 隔离（failed=${smbCases.length}）、零 applied / conflict / invalid / nolead —— 校验失败的文件绝不能被算作「已消费」或留下重试残影`,
    smbRound.failed === smbCases.length && smbRound.applied === 0 &&
    smbRound.conflict === 0 && smbRound.invalid === 0 && smbRound.nolead === 0 && smbRound.skippedDup === 0,
    JSON.stringify(smbRound))
  ok('C3 目的：零业务写（lead / assignment / audit_event / notify_inbox 四表计数一个不涨）',
    countsEqual(insertAuditCounts(), beforeSmb),
    JSON.stringify({ before: beforeSmb, after: insertAuditCounts() }))
  ok('C4 不写成功幂等标记（syncApplied / syncOutcome 全为零）',
    smbCases.every(([tag, , eventType]) =>
      Number(crmDbService.getScanState(`syncApplied:${eventType}:f-${tag}#apply`) || 0) === 0 &&
      Number(crmDbService.getScanState(`syncOutcome:${eventType}:f-${tag}#apply`) || 0) === 0))
  ok('C5 不生成可被中枢接受的成功 ACK（ACK 目录里没有这些事件的 applied/conflict 回执）',
    smbCases.every(([tag, , eventType]) => {
      const ackPath = join(smbRoot, 'up', lanSync.getTerminalId(), 'ack',
        `${lanSync.deliveryBase(`${eventType}:f-${tag}`, 'apply')}.json`)
      if (!existsSync(ackPath)) return true
      const outcome = String((JSON.parse(readFileSync(ackPath, 'utf-8')) as { outcome?: string }).outcome || '')
      return outcome !== 'applied' && outcome !== 'conflict'
    }))
  ok('C6 隔离文件本体确实落在 .failed/（可审计保留，未被静默删除），且原队列目录已清空',
    smbCases.every(([tag, , eventType, , outerRole]) => existsSync(join(cFailedDir, smbFile(tag, 900, {}, eventType, outerRole).name))) &&
    readdirSync(cDir).filter((f) => f.endsWith('.json')).length === 0)

  // 正反对照（独立根目录、独立 lead）：完全合法的 assign 经同一入口真实落地 applied
  const ctlRoot = mkdtempSync(join(tmpdir(), 'central-down-fields-ctl-'))
  leadSvc.importLeads('fields-ctl', 'ctl.csv', [{ phone: '13900008009', name: '字段线索丙', source: '测试' }])
  const ctlLeadId = Number(crmDbService.all("SELECT id FROM lead WHERE contact_normalized = '13900008009'")[0]?.id || 0)
  const ctlFile = {
    name: lanSync.deliveryFileName(901, 'assign:f-legal-assign', 'apply'),
    body: {
      eventSeq: 901, idempotencyKey: 'assign:f-legal-assign', type: 'assign', deliveryRole: 'apply', to: rk, emittedAt: NOW,
      payload: {
        type: 'assign', deliveryRole: 'apply', leadId: ctlLeadId, assignmentId: 1, salesName: SALES,
        sla1Deadline: NOW + 86_400_000, actor: ACTOR,
        lead: { leadId: ctlLeadId, name: '字段线索丙', contactType: 'phone', contactNormalized: '13900008009', contactRaw: '13900008009', wechat: '', source: '测试', note: '' }
      }
    }
  }
  const ctlDir = join(ctlRoot, 'down', rk)
  mkdirSync(ctlDir, { recursive: true })
  writeFileSync(join(ctlDir, ctlFile.name), JSON.stringify(ctlFile.body))
  const ctlRound = lanSync.consumeDownEvents(ctlRoot)
  const ctlRows = Number(crmDbService.all(
    "SELECT COUNT(*) AS n FROM assignment WHERE lead_id = ? AND source = 'sync:down' AND deleted = 0", [ctlLeadId])[0]?.n || 0)
  ok('C7 正反对照：完全合法的 assign 经同一入口真实落地（applied=1，且确实写了 assignment 行）—— 证明 C1-C6 不是「一律拒绝」',
    ctlRound.applied === 1 && ctlRound.failed === 0 && ctlRows === 1 && ctlLeadId > 0,
    JSON.stringify({ round: ctlRound, ctlRows, ctlLeadId }))

  // ═══ D. 历史 transfer 富化：来源行必须存在且必须指对行 ═══════════════════════
  // 语义前提（读代码得到、非猜测）：`healLegacyDownPayload` 核对的一致性三元组是
  //   assignment.id === payload.assignmentId ∧ assignment.lead_id === payload.leadId
  //   ∧ assignment.sales_name === payload.toSales。
  // 其中 sales_name = **本次移交的目标销售**——因为 crmAssignmentService.transferAssignment()
  // 就是先把新行写成 toSales 再发指令。所以一条**合法**的历史 transfer 载荷，其
  // assignmentId 指向的行必须是「已经指派给 toSales 的那一行」；把 toSales 写回源行所属销售
  // 反而与生产者的写法矛盾（核对必然失败）。本段据此构造：一次真实移交 → 新行(目标销售) + 旧行(原销售)。
  console.log('\n═══ D. 历史 transfer 富化：不可核对即拒（不猜、不发），合法来源行幂等通过 ═══')
  const rowOf = (id: number): Record<string, unknown> =>
    (crmDbService.all('SELECT lead_id, sales_name, mode, sla1_deadline FROM assignment WHERE id = ?', [id])[0] || {}) as Record<string, unknown>

  // 真实移交：leadId 当时归 SALES2，现移交给 SALES。结束状态：旧行=源销售(SALES2)、新行=目标销售(SALES)。
  setIdentity(SUPERVISOR, '主管')
  const beforeTransferId = Number(assignmentSvc.currentAssignment(leadId)?.id || 0)
  const beforeTransfer = rowOf(beforeTransferId)
  const heldBy = String(beforeTransfer.sales_name || '')
  const moved = assignmentSvc.transferAssignment(beforeTransferId, SALES, '字段移交', SUPERVISOR) as unknown as
    { ok?: boolean; data?: { assignmentId?: number } }
  const legacyRowId = Number(moved?.data?.assignmentId || assignmentSvc.currentAssignment(leadId)?.id || 0)
  const newRow = rowOf(legacyRowId)
  const legacyOldRowId = beforeTransferId
  const legacySourceLead = String(newRow.sales_name || '')

  /** 一条**合法**的历史 transfer 载荷：assignmentId 指向本次移交写下的那一行（= toSales 的行） */
  const legacyTransfer = (): Record<string, unknown> => ({
    type: 'transfer', leadId, assignmentId: legacyRowId, oldAssignmentId: legacyOldRowId,
    fromSales: heldBy, toSales: legacySourceLead, reason: '升级前移交', actor: ACTOR, lead: { ...leadSub }
  })
  const legacyFrozen = JSON.stringify(legacyTransfer())
  ok('D0 前置：一次真实移交同时留下「目标销售的新行」(assigned) 与「原持有者的旧行」(transferred)；合法载荷的来源行 = 新行，与生产者 transferAssignment 的写法一致',
    moved?.ok === true && leadId !== beforeTransferId && legacyRowId > 0 && legacyOldRowId > 0 && legacyRowId !== legacyOldRowId &&
    String(newRow.lead_id) === String(leadId) && String(newRow.sales_name) === SALES &&
    String(crmDbService.all('SELECT status FROM assignment WHERE id = ?', [legacyOldRowId])[0]?.status) === 'transferred',
    JSON.stringify({ legacyRowId, legacyOldRowId, newRow, old: rowOf(legacyOldRowId), heldBy,
      oldStatus: String(crmDbService.all('SELECT status FROM assignment WHERE id = ?', [legacyOldRowId])[0]?.status) }))

  // D1：完整 mode/SLA + assignmentId=0 / 字符串 assignmentId → 必须失败
  const full = { ...legacyTransfer(), mode: 'manual', sla1Deadline: NOW + 86_400_000 }
  const dZero = healLegacyDownPayload('transfer', { ...full, assignmentId: 0 })
  const dString = healLegacyDownPayload('transfer', { ...full, assignmentId: '41' })
  ok('D1 完整 mode/SLA + assignmentId=0 / 字符串 assignmentId → 一律失败（不再交给下游校验器侥幸处理）',
    dZero.ok === false && dZero.code === 'legacy_transfer_bad_assignment_id' &&
    dString.ok === false && dString.code === 'legacy_transfer_bad_assignment_id',
    JSON.stringify([dZero, dString]))
  // D2：完整 mode/SLA + 不存在的正整数 assignmentId → 必须失败
  const dMissingRow = healLegacyDownPayload('transfer', { ...full, assignmentId: 987654321 })
  ok('D2 完整 mode/SLA + 不存在的正整数 assignmentId → 失败（本机 assignment 只软删/只改状态，正常 outbox 行必能定位来源；定位不到 = 库被外部改动，无从核对身份，不猜不放行）',
    dMissingRow.ok === false && dMissingRow.code === 'legacy_transfer_assignment_missing',
    JSON.stringify(dMissingRow))
  // D3a：来源行属于**别的 lead** → lead 身份矛盾
  const dCrossLead = healLegacyDownPayload('transfer', { ...full, leadId: leadId2 })
  ok('D3a 来源行属于其他 lead → legacy_transfer_lead_mismatch（不把 B 线索的 mode/SLA 贴到 A 线索的指令上）',
    dCrossLead.ok === false && dCrossLead.code === 'legacy_transfer_lead_mismatch', JSON.stringify(dCrossLead))
  // D3b：来源行属于**别的销售** → 目标身份矛盾（把 toSales 换成源行的原销售，行就不再是本次移交的事实）
  const dCrossSales = healLegacyDownPayload('transfer', { ...full, toSales: SALES2 })
  ok('D3b 来源行属于其他销售 → legacy_transfer_target_mismatch（不从别的销售的行恢复 mode/SLA）',
    dCrossSales.ok === false && dCrossSales.code === 'legacy_transfer_target_mismatch', JSON.stringify(dCrossSales))
  // D4：合法来源行 + 缺 mode/SLA → 精确恢复历史行中的原值
  const rowMode = String(newRow.mode || '')
  const rowSla = Number(newRow.sla1_deadline || 0)
  const dHeal = healLegacyDownPayload('transfer', legacyTransfer())
  ok('D4 合法来源行 + 缺 mode/SLA → 精确恢复 assignment 行中当时写入的绝对值（不重算、不漂移）',
    dHeal.ok === true && String(dHeal.payload.mode) === rowMode && Number(dHeal.payload.sla1Deadline) === rowSla &&
    rowMode.length > 0 && rowSla > 0,
    JSON.stringify({ got: dHeal.ok ? dHeal.payload : dHeal, rowMode, rowSla }))
  // D5：合法来源行 + 完整载荷 → 幂等原样通过，且不就地改入参
  const dPass = healLegacyDownPayload('transfer', full)
  ok('D5 合法来源行 + 完整载荷 → 幂等原样通过（返回入参本身，不重算覆盖成历史值），且重复调用结果逐字相同、不就地改入参',
    dPass.ok === true && dPass.payload === full &&
    JSON.stringify(legacyTransfer()) === legacyFrozen &&
    JSON.stringify(healLegacyDownPayload('transfer', legacyTransfer())) ===
      JSON.stringify(healLegacyDownPayload('transfer', legacyTransfer())))
  // D6：不能重算 SLA —— 改当前配置后恢复值一字不变
  cfg.set('crmLeadSlaHours', 999)
  const dAfterCfg = healLegacyDownPayload('transfer', legacyTransfer())
  cfg.set('crmLeadSlaHours', 24)
  ok('D6 把当前 crmLeadSlaHours 改成 999 后恢复值一字不变（SLA 是历史事实，绝不按当前配置重算）',
    dAfterCfg.ok === true && Number(dAfterCfg.payload.sla1Deadline) === rowSla && String(dAfterCfg.payload.mode) === rowMode)
  // D7：错误码不含客户标识 / 联系方式 / 销售姓名 / 载荷原文
  const dCodes = [dZero, dString, dMissingRow, dCrossLead, dCrossSales].map((r) => (r.ok ? '' : r.code)).join('|')
  ok('D7 拒收码不含客户标识 / 联系方式 / 销售姓名 / 载荷原文（只有字段与一致性结论）',
    !dCodes.includes('13900008001') && !dCodes.includes(SALES) && !dCodes.includes(SALES2) &&
    !dCodes.includes('字段线索甲') && /^(legacy_transfer_[a-z_]+\|?)+$/.test(dCodes),
    dCodes)
  // D8：富化不写库（惰性兼容，不做破坏性整表 UPDATE）
  const dBefore = insertAuditCounts()
  ok('D8 富化与拒收路径零业务写（惰性兼容，不改 outbox 行、不写审计）',
    countsEqual(insertAuditCounts(), dBefore) &&
    crmDbService.all("SELECT id FROM audit_event WHERE action = 'sync_down_payload_unrecoverable'").length === 0)

  await app.close()
  console.log(`\ncentral down fields test: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exitCode = 1
}

void main()
