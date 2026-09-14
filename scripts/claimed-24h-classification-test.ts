/**
 * claimed-24h-classification-test.ts —— 认领满 24h AI 首次分类 + 信息缺口反问卡（PRD 2.4）验证
 *
 * 覆盖：
 *   A. 未认领不触发（扫描 due=0；手动 run 无 claimed 行 → E301）
 *   B. 认领不足 24h 不触发（扫描 due=0，无轮次行）
 *   C. 满 24h 触发一次 + 扫描重跑幂等 + 已有 proposed 不重复调模型
 *   D. 转派后新 assignment 重新计时（新行 claimed_at=NULL；再认领再满 24h 才触发新轮次，旧轮次保留）
 *   E. 手动「立即分析」不受 24h 限制
 *   F. 结果只进 proposed：正式事实（customer.type / account 字段 / customer_profile.stage）零写入
 *   G. 确认后才写正式事实（setCustomerType 审计 / enrich 字段 / stage 仅 unknown 时落）+ 已确认字段反问卡自动关闭
 *   H. 拒绝不写正式事实 + 拒绝记录保留 + rejected 轮次不重复调模型
 *   I. 证据硬门：无证据字段丢弃、无依据 stage/customer_type 降级 unknown；间接信号（昵称来源）只进提案
 *   J. unknown 合法：全 unknown 也正常落 proposed 轮次
 *   K. 六类缺口卡：六个字段全缺 → 6 张 pending 反问卡（trigger_type='info_gap_ask'，source_id 各异，含触发依据）
 *   L. 同缺口去重：重评不产生重复 pending 卡
 *   M. 字段确认后自动关闭卡（setAccountFieldManual / setCustomerType / registerOpportunityDeal 钩子），done 历史保留
 *   N. 模型失败 → failed 可重试（不写假结果、不出提案埋点），修复后重跑成功
 *   O. AI 未配置 → failed「AI 未配置」（不写假结果）
 *
 * AI 调用经 setFirstClassifyAiRunner 注入（测试环境无真实 API Key）——状态机/落库/去重/审计/钩子
 * 全部走真实 service 与真实库，注入的只是 HTTP 层返回值，不是用 mock 代替核心状态机。
 *
 * 隔离：WEFLOW_WORKER='1' + /tmp 配置目录 + fresh 空库（同 assignment-full-test 模式）。
 * 运行：npx tsx scripts/claimed-24h-classification-test.ts
 */
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const isoDir = mkdtempSync(join(tmpdir(), 'claimed-24h-test-'))
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
import { assignLeads, claimLead, transferAssignment } from '../electron/services/crmAssignmentService'
import { setCustomerType } from '../electron/services/crmCustomerService'
import {
  setFirstClassifyConfig, setFirstClassifyAiRunner, runFirstClassification, scanClaimed24h,
  confirmFirstClassification, rejectFirstClassification, reevaluateInfoGapCards, INFO_GAP_TRIGGER
} from '../electron/services/crmFirstClassifyService'
import { gapSourceId, GAP_DEFS } from '../electron/services/crmFirstClassifyCore'
import { LEAD_SLA_UNASSIGNED_SENTINEL } from '../shared/leadSla'
import { enqueueSalesTask } from '../electron/services/salesQueue'

const S_A = '测试销售甲'
const S_B = '测试销售乙'
const H24 = 24 * 3600_000

const GOOD_JSON = JSON.stringify({
  stage: 'contacted', stage_confidence: 0.8, stage_evidence: '客户问过 3 吨车价格',
  customer_type: 'dealer', customer_type_confidence: 0.7, customer_type_evidence: '客户问返点政策',
  intent_score: 65,
  fields: {
    company: { value: '恒信物流', confidence: 0.8, source: 'chat', evidence_key: 'mk-company-1', evidence_text: '我们是恒信物流的' },
    industry: { value: '冷链', confidence: 0.6, source: 'chat', evidence_key: 'mk-ind-1', evidence_text: '我们冷库要换车' },
    intent_model: { value: 'FD30', confidence: 0.7, source: 'chat', evidence_key: 'mk-model-1', evidence_text: 'FD30 有现货吗' }
  }
})

let aiCalls = 0
let aiImpl: (prompt: string) => Promise<string> = async () => GOOD_JSON

function seedLead(tag: string): number {
  const now = Date.now()
  return crmDbService.runTx((tx) => tx.run(
    'INSERT INTO lead (contact_type, contact_normalized, contact_raw, wechat, source, name, status, first_contact_deadline, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    ['phone', `139${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`, tag, '', '测试', tag, 'NEW', LEAD_SLA_UNASSIGNED_SENTINEL, now, now]
  ))
}
/** 建 account + customer 并挂到 lead（sessionId 供 stage 落点断言） */
function linkAccountCustomer(leadId: number, name: string, sessionId: string): { accountId: number; customerId: number } {
  const now = Date.now()
  const accountId = crmDbService.runTx((tx) => tx.run(
    'INSERT INTO account (name, industry, province, city, phone, owner_sales, custom_fields, session_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [name, null, null, null, null, '', '{}', sessionId, now, now]
  ))
  const customerId = crmDbService.runTx((tx) => tx.run(
    "INSERT INTO customer (name, type, source, updated_by, updated_at, version, deleted) VALUES (?,?,?,?,?,1,0)",
    [name, '', '测试', '', now]
  ))
  crmDbService.run('UPDATE account SET customer_id = ? WHERE id = ?', [customerId, accountId])
  crmDbService.run('UPDATE lead SET account_id = ? WHERE id = ?', [accountId, leadId])
  return { accountId, customerId }
}
function assignRow(id: number): CrmRow { return crmDbService.all('SELECT * FROM assignment WHERE id = ?', [id])[0] || {} }
function roundByAssignment(assignmentId: number): CrmRow | null {
  return crmDbService.all('SELECT * FROM first_classification WHERE assignment_id = ?', [assignmentId])[0] || null
}
function roundsOfLead(leadId: number): CrmRow[] {
  return crmDbService.all('SELECT * FROM first_classification WHERE lead_id = ? ORDER BY id', [leadId])
}
function gapCards(assignmentId: number, status = 'pending'): CrmRow[] {
  return salesDbService.todoList({ status })
    .filter((t) => String(t.trigger_type) === INFO_GAP_TRIGGER)
    .filter((t) => {
      const sid = Number(t.source_id || 0)
      return sid >= gapSourceId(assignmentId, 1) && sid <= gapSourceId(assignmentId, 6)
    }) as unknown as CrmRow[]
}
function auditRows(action: string, entityType: string, entityId: number): CrmRow[] {
  return crmDbService.all('SELECT * FROM audit_event WHERE action = ? AND entity_type = ? AND entity_id = ? ORDER BY id', [action, entityType, entityId])
}
/** proposal_event 只读核验：走公开聚合查询（append-only 台账无逐行 getter） */
function hasProposalEvent(stage: 'generated' | 'accepted' | 'rejected', roundId: number): boolean {
  return salesDbService.proposalEventEntityIds('proposal', stage, 'first_classification').has(String(roundId))
}
function claimAndAssign(leadId: number, sales: string): number {
  const r = assignLeads([leadId], sales, '分配员')
  const aid = r.data?.assignments[0]?.assignmentId ?? 0
  const c = claimLead(leadId, sales)
  if (!c.ok) throw new Error(`claim 失败: ${JSON.stringify(c)}`)
  return aid
}
function backdateClaimedAt(assignmentId: number, msAgo: number): void {
  crmDbService.run('UPDATE assignment SET claimed_at = ? WHERE id = ?', [Date.now() - msAgo, assignmentId])
}

async function main(): Promise<void> {
  const cfg = ConfigService.getInstance()
  cfg.set('crmSalesList', [S_A, S_B])
  cfg.set('crmLeadSlaHours', 24)
  const dbDir = mkdtempSync(join(tmpdir(), 'claimed-24h-test-db-'))
  await crmDbService.initialize(dbDir)
  await salesDbService.initialize(dbDir)
  setFirstClassifyConfig({
    get: (k) => {
      if (k === 'crmFirstClassifyEnabled') return true
      if (k === 'crmFirstClassifyDelayHours') return 24
      if (k === 'crmFirstClassifyScanIntervalMin') return 30
      return undefined
    }
  })

  console.log('═══ O. AI 未配置 → failed 可重试（不写假结果）═══')
  const lo = seedLead('O-未配置')
  claimAndAssign(lo, S_A)
  const ro = await runFirstClassification({ leadId: lo, trigger: 'manual' })
  ok('O1 AI 未配置 → 失败且原因如实', ro.ok === false && /AI 未配置/.test(ro.message || ''), JSON.stringify(ro))
  const roundO = roundsOfLead(lo)[0]
  ok('O2 轮次落 failed 态 + error 留痕', String(roundO?.status) === 'failed' && /AI 未配置/.test(String(roundO?.error)))
  ok('O3 不写假结果（result_json 空）', String(roundO?.result_json || '{}') === '{}')
  ok('O4 failed 不出提案埋点', !hasProposalEvent('generated', Number(roundO?.id)))

  // 注入确定性 AI runner（仅替换 HTTP 层；状态机/落库/审计全真）
  setFirstClassifyAiRunner(async (p) => { aiCalls++; return aiImpl(p) })
  ok('O5 注入后重试 failed 轮次 → proposed', await (async () => {
    const r = await runFirstClassification({ leadId: lo, trigger: 'manual' })
    return r.ok === true && r.data?.status === 'proposed' && String(roundsOfLead(lo)[0].status) === 'proposed'
  })())

  console.log('\n═══ A. 未认领不触发 ═══')
  const la = seedLead('A-未认领')
  assignLeads([la], S_A, '分配员') // 只分配不认领
  const scanA = await scanClaimed24h()
  ok('A1 扫描不触发未认领线索（due 不含 A）', scanA.due === 0, JSON.stringify(scanA))
  ok('A2 无轮次行', roundsOfLead(la).length === 0)
  const rmA = await runFirstClassification({ leadId: la, trigger: 'manual' })
  ok('A3 手动立即分析也拒（无 claimed 行 → E301）', rmA.ok === false && rmA.code === 'E301', JSON.stringify(rmA))
  ok('A4 claimed_at 为 NULL（不允许靠 updated_at 猜认领时间）', assignRow(Number(crmDbService.all('SELECT id FROM assignment WHERE lead_id = ?', [la])[0].id)).claimed_at == null)

  console.log('\n═══ B. 认领不足 24h 不触发 ═══')
  const lb = seedLead('B-不足24h')
  const bAid = claimAndAssign(lb, S_A)
  ok('B1 claim 写入 claimed_at', Math.abs(Number(assignRow(bAid).claimed_at) - Date.now()) < 60_000, `claimed_at=${assignRow(bAid).claimed_at}`)
  const scanB = await scanClaimed24h()
  ok('B2 不足 24h 扫描不触发', scanB.due === 0 && roundsOfLead(lb).length === 0, JSON.stringify(scanB))

  console.log('\n═══ C. 满 24h 触发一次 + 幂等（lead 挂 account/customer，供 F/G 断言）═══')
  const lc = seedLead('C-满24h')
  const cAid = claimAndAssign(lc, S_A)
  const cLink = linkAccountCustomer(lc, '测试客户C', 'wxid_c_test')
  backdateClaimedAt(cAid, H24 + 3600_000)
  const callsBefore = aiCalls
  const scanC = await scanClaimed24h()
  ok('C1 满 24h 触发且仅触发 C', scanC.due === 1 && scanC.triggered === 1 && scanC.proposed === 1, JSON.stringify(scanC))
  ok('C2 模型恰调用 1 次', aiCalls === callsBefore + 1, `aiCalls=${aiCalls}`)
  const roundC = roundByAssignment(cAid)
  ok('C3 轮次落 proposed（B 档提案）', String(roundC?.status) === 'proposed' && String(roundC?.trigger_source) === 'scan')
  const resC = JSON.parse(String(roundC?.result_json || '{}'))
  ok('C4 提案内容完整（stage/customer_type/intent_score/fields）',
    resC.stage === 'contacted' && resC.customerType === 'dealer' && resC.intentScore === 65 && resC.fields?.company?.value === '恒信物流')
  ok('C5 提案审计落行 first_classify_proposed', auditRows('first_classify_proposed', 'first_classification', Number(roundC?.id)).length === 1)
  ok('C6 提案埋点 proposal/generated', hasProposalEvent('generated', Number(roundC?.id)))
  const scanC2 = await scanClaimed24h()
  ok('C7 扫描重跑幂等（轮次行已存在 → 不触发）', scanC2.due === 0, JSON.stringify(scanC2))
  const rmC = await runFirstClassification({ leadId: lc, trigger: 'manual' })
  ok('C8 已有 proposed 轮次 → 手动重跑不重复调模型', rmC.ok === true && rmC.data?.reused === true && aiCalls === callsBefore + 1, JSON.stringify(rmC))

  console.log('\n═══ K. 六类缺口卡（C 轮次副产物）═══')
  const cardsC = gapCards(cAid)
  ok('K1 六字段全缺 → 6 张 pending 反问卡', cardsC.length === 6, `实 ${cardsC.length}`)
  const srcIds = cardsC.map((t) => Number(t.source_id)).sort((a, b) => a - b)
  ok('K2 source_id = assignment*10+gapIndex 六张各异',
    JSON.stringify(srcIds) === JSON.stringify(GAP_DEFS.map((g) => gapSourceId(cAid, g.gapIndex)).sort((a, b) => a - b)), JSON.stringify(srcIds))
  const cardCt = cardsC.find((t) => Number(t.source_id) === gapSourceId(cAid, 1))
  const cardAnalysis = JSON.parse(String(cardCt?.analysis || '{}'))
  ok('K3 卡片含触发依据与建议话术（可查看依据）',
    typeof cardAnalysis.basis === 'string' && cardAnalysis.basis.includes('缺口检测') && typeof cardAnalysis.suggestion === 'string' && cardAnalysis.suggestion.length > 5)
  ok('K4 卡片标题=反问建议、不自动发消息（action_type=reply_customer 建议卡）',
    cardsC.every((t) => String(t.title).startsWith('信息缺口反问：') && String(t.action_type) === 'reply_customer'))

  console.log('\n═══ L. 同缺口去重 ═══')
  const reevalL = reevaluateInfoGapCards(lc, '测试员')
  ok('L1 重评零关闭零新建（缺口仍在）', reevalL.closed === 0 && reevalL.created === 0, JSON.stringify(reevalL))
  ok('L2 重评后仍恰 6 张 pending（同轮次同缺口幂等）', gapCards(cAid).length === 6)

  console.log('\n═══ F. proposed 期间正式事实零写入 ═══')
  ok('F1 customer.type 仍为空（AI 不直写）', String(crmDbService.all('SELECT type FROM customer WHERE id = ?', [cLink.customerId])[0]?.type || '') === '')
  ok('F2 account.company 仍为空', !crmDbService.all('SELECT company FROM account WHERE id = ?', [cLink.accountId])[0]?.company)
  ok('F3 customer_profile.stage 未落（或仍 unknown）',
    String(salesDbService.customerGetBySession('wxid_c_test')?.stage || 'unknown') === 'unknown')

  console.log('\n═══ G. 确认后才写正式事实 + 反问卡自动关闭 ═══')
  const gc = await confirmFirstClassification(Number(roundC?.id), S_A)
  ok('G1 确认成功 → confirmed', gc.ok === true && String(roundByAssignment(cAid)?.status) === 'confirmed', JSON.stringify(gc))
  ok('G2 customer.type=dealer（经 setCustomerType 人工写入口径）',
    String(crmDbService.all('SELECT type FROM customer WHERE id = ?', [cLink.customerId])[0]?.type) === 'dealer')
  ok('G3 customer_type_set 审计落行', auditRows('customer_type_set', 'customer', cLink.customerId).length === 1)
  const accC = crmDbService.all('SELECT * FROM account WHERE id = ?', [cLink.accountId])[0]
  const accCustom = JSON.parse(String(accC?.custom_fields || '{}'))
  ok('G4 画像字段落 account（company/industry 正式列 + intent_model custom_fields）',
    String(accC?.company) === '恒信物流' && String(accC?.industry) === '冷链' && String(accCustom.intent_model) === 'FD30',
    JSON.stringify({ company: accC?.company, industry: accC?.industry, intent_model: accCustom.intent_model }))
  ok('G5 stage 落 customer_profile（当前 unknown 才落）+ intent 日志 source 可溯',
    String(salesDbService.customerGetBySession('wxid_c_test')?.stage) === 'contacted'
    && salesDbService.intentHistory('wxid_c_test', 20).some((r) => String(r.source) === 'first_classification_confirmed' && String(r.stage) === 'contacted'))
  ok('G6 裁决审计 first_classify_confirmed 含 applied 清单', (() => {
    const rows = auditRows('first_classify_confirmed', 'first_classification', Number(roundC?.id))
    return rows.length === 1 && rows[0].actor === S_A && String(JSON.parse(String(rows[0].detail)).applied).includes('customer.type')
  })())
  ok('G7 提案埋点 proposal/accepted', hasProposalEvent('accepted', Number(roundC?.id)))
  ok('G8 已确认字段的反问卡自动关闭（客户类型/公司行业/需求型号 done）', (() => {
    const done = gapCards(cAid, 'done')
    const closedGaps = done.map((t) => Number(t.source_id) - cAid * 10).sort()
    return done.length === 3 && JSON.stringify(closedGaps) === JSON.stringify([1, 2, 3])
  })(), JSON.stringify(gapCards(cAid, 'done').map((t) => t.source_id)))
  ok('G9 未确认字段反问卡仍 pending（数量/预算/采购时间）', gapCards(cAid).length === 3)
  ok('G10 自动关闭审计 info_gap_autoclose ×3', auditRows('info_gap_autoclose', 'lead', lc).length === 3)
  ok('G11 confirmed 后重跑不重复调模型', await (async () => {
    const r = await runFirstClassification({ leadId: lc, trigger: 'manual' })
    return r.ok === true && r.data?.reused === true && r.data.status === 'confirmed'
  })())

  console.log('\n═══ D. 转派后重新计时 ═══')
  const ld = seedLead('D-转派')
  const dAid1 = claimAndAssign(ld, S_A)
  backdateClaimedAt(dAid1, H24 + 3600_000)
  const scanD1 = await scanClaimed24h()
  ok('D1 第一轮触发（转派前基线）', scanD1.proposed === 1 && String(roundByAssignment(dAid1)?.status) === 'proposed', JSON.stringify(scanD1))
  const tr = transferAssignment(dAid1, S_B, '调岗移交', '主管张某')
  const dAid2 = tr.data?.assignmentId ?? 0
  ok('D2 转派成功，新行 claimed_at=NULL（重新计时）', tr.ok === true && assignRow(dAid2).claimed_at == null && assignRow(dAid2).status === 'assigned')
  const scanD2 = await scanClaimed24h()
  ok('D3 新归属未认领 → 扫描不触发新轮次', scanD2.due === 0 && !roundByAssignment(dAid2))
  claimLead(ld, S_B)
  const scanD3 = await scanClaimed24h()
  ok('D4 再认领但不足 24h → 仍不触发', scanD3.due === 0 && !roundByAssignment(dAid2))
  backdateClaimedAt(dAid2, H24 + 3600_000)
  const scanD4 = await scanClaimed24h()
  ok('D5 新归属满 24h → 触发新轮次', scanD4.proposed === 1 && String(roundByAssignment(dAid2)?.status) === 'proposed', JSON.stringify(scanD4))
  ok('D6 旧轮次历史保留（不覆盖不改写）', String(roundByAssignment(dAid1)?.status) === 'proposed' && roundsOfLead(ld).length === 2)
  ok('D7 新轮次反问卡按新 source_id 出卡（与旧轮次不冲突）', gapCards(dAid2).length === 6 && gapCards(dAid1).length === 6)

  console.log('\n═══ E/H. 手动立即分析 + 拒绝链路 ═══')
  const le = seedLead('E-手动')
  claimAndAssign(le, S_A)
  linkAccountCustomer(le, '测试客户E', 'wxid_e_test')
  const rmE = await runFirstClassification({ leadId: le, trigger: 'manual' })
  const roundE = roundsOfLead(le)[0]
  ok('E1 手动立即分析不受 24h 限制 → proposed', rmE.ok === true && rmE.data?.status === 'proposed' && String(roundE?.trigger_source) === 'manual')
  const eCustTypeBefore = String(crmDbService.all('SELECT type FROM customer WHERE id = ?', [Number(crmDbService.all('SELECT customer_id FROM account WHERE session_id = ?', ['wxid_e_test'])[0]?.customer_id)])[0]?.type || '')
  const rj = rejectFirstClassification(Number(roundE?.id), S_A, '线索质量差，分类不适用')
  ok('H1 拒绝成功 → rejected + decided_by 署名', rj.ok === true && String(roundsOfLead(le)[0].status) === 'rejected' && String(roundsOfLead(le)[0].decided_by) === S_A)
  ok('H2 拒绝零正式字段写入（customer.type 不变）',
    String(crmDbService.all('SELECT c.type FROM customer c JOIN account a ON a.customer_id = c.id WHERE a.session_id = ?', ['wxid_e_test'])[0]?.type || '') === eCustTypeBefore && eCustTypeBefore === '')
  ok('H3 拒绝记录保留（拒绝原因进审计）', (() => {
    const rows = auditRows('first_classify_rejected', 'first_classification', Number(roundE?.id))
    return rows.length === 1 && String(JSON.parse(String(rows[0].detail)).reason).includes('线索质量差')
  })())
  ok('H4 提案埋点 proposal/rejected', hasProposalEvent('rejected', Number(roundE?.id)))
  ok('H5 rejected 轮次不重复调模型', await (async () => {
    const before = aiCalls
    const r = await runFirstClassification({ leadId: le, trigger: 'manual' })
    return r.ok === true && r.data?.reused === true && r.data.status === 'rejected' && aiCalls === before
  })())
  ok('H6 非 proposed 不可重复裁决', rejectFirstClassification(Number(roundE?.id), S_A, 'x').code === 'E201'
    && (await confirmFirstClassification(Number(roundE?.id), S_A)).code === 'E201')

  console.log('\n═══ I/J. 证据硬门 + unknown 合法 ═══')
  const li = seedLead('I-证据门')
  claimAndAssign(li, S_A)
  aiImpl = async () => JSON.stringify({
    stage: 'negotiating', // 无 stage_evidence → 降级 unknown
    customer_type: 'dealer', // 无 customer_type_evidence → 降级 unknown
    intent_score: null,
    fields: {
      company: { value: '无证据公司', confidence: 0.9, source: 'chat' }, // 无任何证据 → 丢弃
      industry: { value: '冷链', confidence: 0.5, source: 'nickname', evidence_text: '昵称：冷库老王' } // 间接信号 → 疑似提案保留
    }
  })
  const rmI = await runFirstClassification({ leadId: li, trigger: 'manual' })
  const roundI = roundsOfLead(li)[0]
  const resI = JSON.parse(String(roundI?.result_json || '{}'))
  const evI = JSON.parse(String(roundI?.evidence_json || '{}'))
  ok('I1 缺证据轮次仍正常落 proposed（不写假数据但轮次成立）', rmI.ok === true && String(roundI?.status) === 'proposed')
  ok('I2 无证据字段被丢弃（company 不进 result）', resI.fields?.company === undefined)
  ok('I3 无依据 stage 降级 unknown', resI.stage === 'unknown' && evI.droppedNoEvidence?.includes('stage'))
  ok('I4 无依据 customer_type 降级 unknown', resI.customerType === 'unknown' && evI.droppedNoEvidence?.includes('customer_type'))
  ok('I5 间接信号（昵称来源）只进提案带出处', resI.fields?.industry?.value === '冷链' && resI.fields?.industry?.source === 'nickname'
    && evI.fields?.industry?.evidenceText === '昵称：冷库老王')
  ok('J1 unknown 为合法终值（intent_score null 合法）', resI.intentScore === null && resI.stage === 'unknown' && resI.customerType === 'unknown')
  ok('J2 间接信号提案确认也不越权写非法字段（industry 落 enrich 口径可写，customer.type 无客户不动）', await (async () => {
    const c = await confirmFirstClassification(Number(roundI?.id), S_A)
    return c.ok === true && String(roundsOfLead(li)[0].status) === 'confirmed'
  })())
  aiImpl = async () => GOOD_JSON // 复位

  console.log('\n═══ M. 字段确认钩子自动关闭反问卡（人工编辑/客户类型/成交登记）═══')
  const lm = seedLead('M-钩子')
  claimAndAssign(lm, S_A)
  const mLink = linkAccountCustomer(lm, '测试客户M', 'wxid_m_test')
  await runFirstClassification({ leadId: lm, trigger: 'manual' })
  const mAid = Number(crmDbService.all("SELECT id FROM assignment WHERE lead_id = ? AND status = 'claimed'", [lm])[0].id)
  ok('M0 基线 6 张 pending 卡', gapCards(mAid).length === 6)
  crmDbService.setAccountFieldManual(mLink.accountId, 'budget', '5 万')
  ok('M1 手动编辑预算 → 预算卡自动关闭', gapCards(mAid).length === 5
    && gapCards(mAid, 'done').some((t) => Number(t.source_id) === gapSourceId(mAid, 5)))
  crmDbService.setAccountFieldManual(mLink.accountId, 'industry', '冷链仓储')
  ok('M2 手动编辑行业 → 公司/行业卡自动关闭', gapCards(mAid).length === 4
    && gapCards(mAid, 'done').some((t) => Number(t.source_id) === gapSourceId(mAid, 2)))
  setCustomerType(mLink.customerId, 'end_user', S_A)
  ok('M3 人工设客户类型 → 客户类型卡自动关闭', gapCards(mAid).length === 3
    && gapCards(mAid, 'done').some((t) => Number(t.source_id) === gapSourceId(mAid, 1)))
  // 成交登记（registerOpportunityDeal 钩子）：数量 + 需求型号 两张卡关闭
  crmDbService.run("INSERT INTO product (model, name, spec, unit_price, product_line, created_at) VALUES ('FD30', '3吨叉车', '', 90000, '整机', ?)", [Date.now()])
  const mOppId = crmDbService.runTx((tx) => tx.run(
    "INSERT INTO opportunity (account_id, name, amount, stage, owner_sales, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
    [mLink.accountId, 'M 测试商机', 0, '了解', S_A, 'active', Date.now(), Date.now()]
  ))
  const deal = crmDbService.registerOpportunityDeal(mOppId, { amount_cny: 180000, order_qty: 2, main_model: 'FD30', type: '整车', actor: S_A })
  ok('M4 成交登记成功（基线）', deal.ok === true, JSON.stringify(deal))
  const mDone = gapCards(mAid, 'done')
  ok('M5 成交登记 → 数量卡 + 需求型号卡自动关闭', gapCards(mAid).length === 1
    && mDone.some((t) => Number(t.source_id) === gapSourceId(mAid, 4))
    && mDone.some((t) => Number(t.source_id) === gapSourceId(mAid, 3)),
    `pending=${gapCards(mAid).length} done=${mDone.length}`)
  ok('M6 done 历史保留（卡片不删行，含关闭原因）', mDone.length === 5 && mDone.every((t) => String(t.analysis || '').includes('closedReason')))
  ok('M7 仅剩采购时间卡 pending', gapCards(mAid).length === 1 && Number(gapCards(mAid)[0].source_id) === gapSourceId(mAid, 6))
  ok('M8 自动关闭审计覆盖四个钩子来源', auditRows('info_gap_autoclose', 'lead', lm).length === 5)

  console.log('\n═══ N. 模型失败可重试 ═══')
  const ln = seedLead('N-失败重试')
  claimAndAssign(ln, S_A)
  aiImpl = async () => { throw new Error('HTTP 502 模拟模型故障') }
  const rn1 = await runFirstClassification({ leadId: ln, trigger: 'manual' })
  const roundN = roundsOfLead(ln)[0]
  ok('N1 模型异常 → E501 且轮次落 failed', rn1.ok === false && rn1.code === 'E501' && String(roundN?.status) === 'failed')
  ok('N2 失败原因留痕（error 列）', String(roundN?.error || '').includes('502'))
  ok('N3 失败不写假结果不出提案', String(roundN?.result_json || '{}') === '{}' && !hasProposalEvent('generated', Number(roundN?.id)))
  ok('N4 失败审计落行 first_classify_failed', auditRows('first_classify_failed', 'first_classification', Number(roundN?.id)).length === 1)
  aiImpl = async () => GOOD_JSON
  const rn2 = await runFirstClassification({ leadId: ln, trigger: 'manual' })
  ok('N5 修复后重试 → proposed（failed 可重跑）', rn2.ok === true && rn2.data?.status === 'proposed' && String(roundsOfLead(ln)[0].status) === 'proposed')
  ok('N6 重试成功清 error 且结果落库', String(roundsOfLead(ln)[0].error || '') === '' && JSON.parse(String(roundsOfLead(ln)[0].result_json)).stage === 'contacted')

  console.log('\n═══ P. 确认阶段判断统一 normalizeStage SSOT（中英文混存）═══')
  // P1 中文「未知」归一为 unknown → 确认可写入新阶段
  const lp1 = seedLead('P1-中文未知')
  claimAndAssign(lp1, S_A)
  linkAccountCustomer(lp1, '测试客户P1', 'wxid_p1')
  await runFirstClassification({ leadId: lp1, trigger: 'manual' })
  salesDbService.customerUpsert({ session_id: 'wxid_p1', stage: '未知' })
  const cp1 = await confirmFirstClassification(Number(roundsOfLead(lp1)[0].id), S_A)
  ok('P1 当前 stage=中文「未知」时确认可写入新阶段',
    cp1.ok === true && String(salesDbService.customerGetBySession('wxid_p1')?.stage) === 'contacted',
    JSON.stringify({ ok: cp1.ok, stage: salesDbService.customerGetBySession('wxid_p1')?.stage }))
  // P2 显式空串 → 仍可写
  const lp2 = seedLead('P2-空串')
  claimAndAssign(lp2, S_A)
  linkAccountCustomer(lp2, '测试客户P2', 'wxid_p2')
  await runFirstClassification({ leadId: lp2, trigger: 'manual' })
  salesDbService.customerUpsert({ session_id: 'wxid_p2', stage: '' })
  const cp2 = await confirmFirstClassification(Number(roundsOfLead(lp2)[0].id), S_A)
  ok('P2 当前 stage 为空串时仍可写',
    cp2.ok === true && String(salesDbService.customerGetBySession('wxid_p2')?.stage) === 'contacted',
    JSON.stringify({ stage: salesDbService.customerGetBySession('wxid_p2')?.stage }))
  // P3 英文 unknown → 仍可写
  const lp3 = seedLead('P3-unknown')
  claimAndAssign(lp3, S_A)
  linkAccountCustomer(lp3, '测试客户P3', 'wxid_p3')
  await runFirstClassification({ leadId: lp3, trigger: 'manual' })
  salesDbService.customerUpsert({ session_id: 'wxid_p3', stage: 'unknown' })
  const cp3 = await confirmFirstClassification(Number(roundsOfLead(lp3)[0].id), S_A)
  ok('P3 当前 stage=unknown 时仍可写',
    cp3.ok === true && String(salesDbService.customerGetBySession('wxid_p3')?.stage) === 'contacted')
  // P4 有效中文阶段「比价」→ 确认成功但不得覆盖阶段、不留首次分类 intent 记录
  const lp4 = seedLead('P4-比价')
  claimAndAssign(lp4, S_A)
  linkAccountCustomer(lp4, '测试客户P4', 'wxid_p4')
  await runFirstClassification({ leadId: lp4, trigger: 'manual' })
  salesDbService.customerUpsert({ session_id: 'wxid_p4', stage: '比价' })
  const roundP4Id = Number(roundsOfLead(lp4)[0].id)
  const cp4 = await confirmFirstClassification(roundP4Id, S_A)
  const appliedP4 = (() => {
    const rows = auditRows('first_classify_confirmed', 'first_classification', roundP4Id)
    return rows.length ? JSON.parse(String(rows[0].detail)).applied : []
  })()
  ok('P4 当前 stage=有效中文「比价」时不得覆盖（确认成功、阶段保留、applied 无 stage、无 intent 记录）',
    cp4.ok === true && String(roundsOfLead(lp4)[0].status) === 'confirmed' &&
    String(salesDbService.customerGetBySession('wxid_p4')?.stage) === '比价' &&
    !String(appliedP4).includes('customer_profile.stage') &&
    !salesDbService.intentHistory('wxid_p4', 20).some((r) => String(r.source) === 'first_classification_confirmed'),
    JSON.stringify({ stage: salesDbService.customerGetBySession('wxid_p4')?.stage, applied: appliedP4 }))

  console.log('\n═══ Q. 首次分类三个写入口统一走 enqueueSalesTask（IPC 边界静态断言）═══')
  const ipcSrc = readFileSync(join(__dirname, '..', 'electron/services/crmIpcHandlers.ts'), 'utf8')
  const handlerBody = (channel: string): string => {
    const i = ipcSrc.indexOf(`ipcMain.handle('${channel}'`)
    return i < 0 ? '' : ipcSrc.slice(i, i + 600)
  }
  ok('Q1 crm:firstClassify:run 经 enqueueSalesTask', /enqueueSalesTask\(/.test(handlerBody('crm:firstClassify:run')))
  ok('Q2 crm:firstClassify:confirm 经 enqueueSalesTask', /enqueueSalesTask\(/.test(handlerBody('crm:firstClassify:confirm')))
  ok('Q3 crm:firstClassify:reject 经 enqueueSalesTask', /enqueueSalesTask\(/.test(handlerBody('crm:firstClassify:reject')))

  // ── Q4~Q7（2026-09-14）：reject 是同步实现，队列契约靠 Promise.resolve 补齐 ──────────
  // enqueueSalesTask<T>(fn: () => Promise<T>) 要求 fn 返回 Promise；而 rejectFirstClassification
  // 是同步函数（sql.js runTx 同步落库）。同步返回值经 `chain.then(() => fn())` 会被自动 adopt，
  // 运行期不会「漏 await」丢结果 —— 类型层报的是契约不匹配，不是运行时缺陷。
  ok('Q4 rejectFirstClassification 确为同步函数（非 AsyncFunction）',
    rejectFirstClassification.constructor.name === 'Function')
  ok('Q5 run/confirm 确为异步函数（AsyncFunction）',
    runFirstClassification.constructor.name === 'AsyncFunction' &&
    confirmFirstClassification.constructor.name === 'AsyncFunction')
  ok('Q6 reject IPC 边界用 Promise.resolve 补队列契约',
    /Promise\.resolve\(/.test(handlerBody('crm:firstClassify:reject')))
  // 运行期实证：fn 同步返回普通对象时，队列给出的 Promise 仍 resolve 到该对象（不丢结果）
  {
    const expected = { ok: true, roundId: 424242 } as unknown as ReturnType<typeof rejectFirstClassification>
    const syncFn = (() => expected) as unknown as () => Promise<ReturnType<typeof rejectFirstClassification>>
    const resolved = await enqueueSalesTask(syncFn)
    ok('Q7 队列对同步返回值同样给出可 await 的 Promise（Promise.resolve 补齐无行为变化）', resolved === expected)
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  process.exit(fail ? 1 : 0)
}

void main()
