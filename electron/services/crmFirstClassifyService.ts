/**
 * crmFirstClassifyService.ts —— 认领满 24h AI 首次分类 + 信息缺口反问卡（PRD 2.4，宪法 §3 登记 2026-09-10）
 *
 * 与新消息阶段分类（salesStageClassifier，A 档直写）是两条独立链路：
 *  - 触发轴 = assignment 生命周期（status=claimed 且 claimed_at 满 24h）+ 手动「立即分析」，不是消息流；
 *  - 写入纪律 = B 档：分类结果只写 first_classification 提案行（proposed），人工 confirm 后才落正式事实；
 *  - 副产物 = 信息缺口反问卡（follow_up_task trigger_type='info_gap_ask'），建议销售自然提问，不自动发消息。
 *
 * 状态机（first_classification.status）：
 *   无行 →（扫描/手动触发）→ pending →（模型成功）→ proposed →（人工）→ confirmed / rejected（终态，不重跑）
 *                                  →（模型失败）→ failed（可重试，不写假结果）
 * 幂等：assignment_id UNIQUE = 认领轮次键（转派新建 assignment 行 = 新轮次，旧轮次历史保留）；
 *   proposed/confirmed/rejected 行存在时不重复调模型。
 *
 * confirmed 落正式事实的边界（宪法 §3 登记行）：
 *   customer_type → customer.type（仅已关联 customer，经 setCustomerType 人工写入口径与审计）；
 *   stage → customer_profile.stage 仅当前 unknown/空才落（不覆盖新消息分类 A 档结果）；
 *   intent_score 无正式字段，只留在 confirmed 行；画像字段 → account enrich 字段集（不覆盖 manual/locked）。
 *
 * 铁律：执行入口一律 enqueueSalesTask（最外层），引擎内部绝不 enqueue。
 */
import { crmDbService, ENRICH_FIELDS, parseEnrichMeta, type CrmRow, type EnrichIncomingField } from './crmDbService'
import { salesDbService } from './salesDbService'
import { chatService } from './chatService'
import { getActorLabel } from './identityService'
import { ConfigService } from './config'
import { simpleCompletion, isAiConfigured, getAiModelConfig } from './ai/aiApiClient'
import { enqueueSalesTask } from './salesQueue'
import { salesLog } from './salesLogger'
import { trackProposalEvent } from './proposalEventTracking'
import { setCustomerType } from './crmCustomerService'
import { onInfoFieldConfirmed, onCustomerTypeSet, onOpportunityDealRegistered } from './crmLifecycleHooks'
import { normalizeStage } from '../../shared/salesStage'
import {
  FIRST_CLASSIFY_PROMPT, GAP_DEFS, gapDefByKey, gapSourceId, decodeGapSourceId,
  detectInfoGaps, parseFirstClassifyResult,
  type FirstClassifyResult, type GapFacts
} from './crmFirstClassifyCore'

// ─── 可注入配置（同 crmEnrichService 模式）──────────────────────────────────
let configRef: { get: (k: string) => unknown } | null = null
export function setFirstClassifyConfig(cfg: { get: (k: string) => unknown } | null): void { configRef = cfg }
let aiConfigRef: ConfigService | null = null
export function setFirstClassifyAiConfig(cfg: ConfigService | null): void { aiConfigRef = cfg }

/** AI 调用注入点（测试用；生产为 null = 走 simpleCompletion 真实链路） */
let aiRunner: ((userPrompt: string) => Promise<string>) | null = null
export function setFirstClassifyAiRunner(fn: ((userPrompt: string) => Promise<string>) | null): void { aiRunner = fn }

function isEnabled(): boolean { return Boolean(configRef?.get('crmFirstClassifyEnabled') ?? true) }
function delayMs(): number {
  const h = Number(configRef?.get('crmFirstClassifyDelayHours') ?? 24)
  return (Number.isFinite(h) && h > 0 && h <= 24 * 30 ? h : 24) * 3600_000
}
function scanIntervalMin(): number {
  const n = Number(configRef?.get('crmFirstClassifyScanIntervalMin') ?? 30)
  return Number.isFinite(n) && n >= 1 ? Math.min(24 * 60, Math.floor(n)) : 30
}

// ─── 类型 ──────────────────────────────────────────────────────────────────
export interface FirstClassifyRunResult {
  ok: boolean
  data?: { roundId: number; status: string; reused?: boolean; gapsCreated?: number }
  code?: string
  message?: string
}

const SYS_ACTOR = 'system:first-classify'

function roundById(roundId: number): CrmRow | null {
  return crmDbService.all('SELECT * FROM first_classification WHERE id = ? AND deleted = 0', [roundId])[0] || null
}
function roundByAssignment(assignmentId: number): CrmRow | null {
  return crmDbService.all('SELECT * FROM first_classification WHERE assignment_id = ? AND deleted = 0', [assignmentId])[0] || null
}

/** 轮次列表（审核队列/前端展示用，只读） */
export function listFirstClassifyRounds(opts: { status?: string; leadId?: number; page?: number; pageSize?: number } = {}): { ok: boolean; data: { rows: CrmRow[]; total: number } } {
  const where: string[] = ['deleted = 0']
  const params: unknown[] = []
  const status = String(opts.status || '').trim()
  if (status) { where.push('status = ?'); params.push(status) }
  if (opts.leadId) { where.push('lead_id = ?'); params.push(Number(opts.leadId)) }
  const w = ' WHERE ' + where.join(' AND ')
  const page = Math.max(1, Number(opts.page) || 1)
  const pageSize = Math.min(1000, Math.max(1, Number(opts.pageSize) || 50))
  const total = Number(crmDbService.all(`SELECT COUNT(*) AS c FROM first_classification${w}`, params)[0]?.c || 0)
  const rows = crmDbService.all(`SELECT * FROM first_classification${w} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, pageSize, (page - 1) * pageSize])
  return { ok: true, data: { rows, total } }
}

// ─── 事实现状读取（缺口检测与 confirm 落事实共用同一口径）───────────────────
interface LeadFacts extends GapFacts {
  accountId: number
  customerId: number
  sessionId: string
  displayName: string
}

function gapFactsForLead(leadId: number): LeadFacts {
  const lead = crmDbService.all('SELECT * FROM lead WHERE id = ?', [leadId])[0]
  const accountId = Number(lead?.account_id || 0)
  const acc = accountId > 0 ? crmDbService.all('SELECT * FROM account WHERE id = ?', [accountId])[0] : null
  let custom: Record<string, unknown> = {}
  try { custom = JSON.parse(String(acc?.custom_fields || '{}')) } catch { custom = {} }
  const customerId = Number(acc?.customer_id || 0)
  const cust = customerId > 0 ? crmDbService.all('SELECT * FROM customer WHERE id = ? AND deleted = 0', [customerId])[0] : null
  let orderQty = 0
  let oppModel = ''
  if (accountId > 0) {
    // 数量/型号事实来源含 won（成交登记后商机即关单转 won，只看 active 会让已成交数量永远判缺）
    for (const o of crmDbService.all("SELECT order_qty, main_model FROM opportunity WHERE account_id = ? AND status IN ('active','won')", [accountId])) {
      orderQty += Number(o.order_qty || 0)
      if (!oppModel && String(o.main_model || '').trim()) oppModel = String(o.main_model).trim()
    }
  }
  return {
    customerType: String(cust?.type || ''),
    company: String(acc?.company || ''),
    industry: String(acc?.industry || ''),
    intentModel: String(custom.intent_model || '') || oppModel,
    orderQty,
    budget: String(custom.budget || ''),
    purchaseTimeframe: String(custom.purchase_timeframe || ''),
    accountId,
    customerId,
    sessionId: String(acc?.session_id || ''),
    displayName: String(acc?.name || lead?.name || '')
  }
}

// ─── 材料收集（聊天/昵称备注/地址档案/客户档案；全部尽力而为，缺啥不编啥）────
const MATERIAL_LIMIT_CHARS = 3000

async function gatherMaterials(facts: LeadFacts, lead?: CrmRow | null): Promise<{ material: string; sourcesUsed: string[] }> {
  const parts: string[] = []
  const sourcesUsed: string[] = []
  // 线索登记信息（导入时人工录入，结构化来源，非 AI 推测）
  if (lead) {
    const reg = [`姓名=${String(lead.name || '')}`, `来源=${String(lead.source || '')}`, `标签=${String(lead.tag || '')}`, `备注=${String(lead.note || '')}`]
      .filter((s) => !s.endsWith('='))
    if (reg.length) { parts.push('【线索登记信息】\n' + reg.join('；')); sourcesUsed.push('registration') }
  }
  if (facts.sessionId) {
    try {
      const msgs = await chatService.getLatestMessages(facts.sessionId, 80)
      const texts = (msgs?.messages || [])
        .map((msg: any) => {
          const content = String(msg.parsedContent || msg.content || '').trim()
          if (!content || /^(<\?xml|<msg\b|<img\b|<emoji\b)/i.test(content)) return ''
          const isSend = Number(msg.isSend ?? msg.computed_is_send ?? msg.is_send ?? 0)
          const key = String(msg.messageKey || '')
          return `${isSend === 1 ? '销售' : '客户'}：${content.slice(0, 150)}${key ? `（key:${key}）` : ''}`
        })
        .filter(Boolean)
        .slice(-50)
      if (texts.length) { parts.push('【聊天记录】\n' + texts.join('\n')); sourcesUsed.push('chat') }
    } catch { /* 聊天不可用不阻断 */ }
    try {
      const r = await chatService.getContacts()
      const c = (r.contacts || []).find((x) => x.username === facts.sessionId)
      if (c && (c.remark || c.nickname)) {
        parts.push(`【微信昵称/备注】昵称：${c.nickname || '无'}；备注：${c.remark || '无'}（间接信号，仅可作疑似提案依据）`)
        sourcesUsed.push('nickname', 'remark')
      }
    } catch { /* 联系人不可用不阻断 */ }
  }
  if (facts.accountId > 0) {
    try {
      const addr = crmDbService.all('SELECT id, receiver, city, address FROM shipping_info WHERE account_id = ? ORDER BY id DESC LIMIT 3', [facts.accountId])
      if (addr.length) {
        parts.push('【已确认收货地址档案】\n' + addr.map((a) => `- 档案#${a.id}：${a.receiver || ''} ${a.city || ''} ${a.address || ''}`.trim()).join('\n'))
        sourcesUsed.push('address')
      }
    } catch { /* ignore */ }
    const acc = crmDbService.all('SELECT * FROM account WHERE id = ?', [facts.accountId])[0]
    if (acc) {
      const profileLines = ['company', 'industry', 'province', 'city']
        .map((f) => `${f}=${String(acc[f] || '').trim()}`)
        .filter((s) => !s.endsWith('='))
      let custom: Record<string, unknown> = {}
      try { custom = JSON.parse(String(acc.custom_fields || '{}')) } catch { custom = {} }
      for (const f of ['needs', 'budget', 'intent_model', 'purchase_timeframe']) {
        const v = String(custom[f] || '').trim()
        if (v) profileLines.push(`${f}=${v}`)
      }
      if (facts.customerType) profileLines.push(`customer_type=${facts.customerType}`)
      if (profileLines.length) { parts.push('【已有客户档案】\n' + profileLines.join('；')); sourcesUsed.push('profile') }
    }
  }
  let material = parts.join('\n\n')
  if (material.length > MATERIAL_LIMIT_CHARS) material = material.slice(0, MATERIAL_LIMIT_CHARS)
  return { material, sourcesUsed }
}

// ─── 执行核心（扫描与手动共用；调用方负责外层 enqueueSalesTask）──────────────
async function executeRound(roundId: number, trigger: 'scan' | 'manual'): Promise<FirstClassifyRunResult> {
  const round = roundById(roundId)
  if (!round) return { ok: false, code: 'E301', message: '分类轮次不存在' }
  // 只许 pending/failed 进入执行；check-and-set 防并发双跑
  const claim = crmDbService.run(
    "UPDATE first_classification SET status = 'pending', updated_at = ?, version = version + 1 WHERE id = ? AND status IN ('pending','failed')",
    [Date.now(), roundId]
  )
  void claim // sql.js run 无 affected 行数返回；下方以状态复查为准
  const cur = roundById(roundId)
  if (!cur || String(cur.status) !== 'pending') {
    return { ok: true, data: { roundId, status: String(cur?.status || ''), reused: true } }
  }

  const facts = gapFactsForLead(Number(round.lead_id))
  const leadRow = crmDbService.all('SELECT * FROM lead WHERE id = ?', [Number(round.lead_id)])[0] || null
  const failRound = (errMsg: string): FirstClassifyRunResult => {
    const now = Date.now()
    crmDbService.runTx((tx) => {
      tx.run("UPDATE first_classification SET status = 'failed', error = ?, updated_at = ?, version = version + 1 WHERE id = ? AND status = 'pending'", [errMsg.slice(0, 300), now, roundId])
      tx.run('INSERT INTO audit_event (actor, action, entity_type, entity_id, detail, created_at) VALUES (?,?,?,?,?,?)',
        [SYS_ACTOR, 'first_classify_failed', 'first_classification', roundId,
          JSON.stringify({ leadId: Number(round.lead_id), assignmentId: Number(round.assignment_id), trigger, error: errMsg.slice(0, 200) }), now])
    })
    salesLog('WARN', `[FirstClassify] 轮次 #${roundId} 失败（可重试）: ${errMsg}`)
    return { ok: false, code: 'E501', message: errMsg, data: { roundId, status: 'failed' } }
  }

  // AI 链路：未配置/调用失败 → failed 可重试，绝不写假结果
  if (!aiRunner) {
    const cfg = aiConfigRef
    if (!cfg || !isAiConfigured(cfg)) return failRound('AI 未配置')
  }
  const g = await gatherMaterials(facts, leadRow)
  if (!g.material) return failRound('无可用材料（聊天/档案/登记信息均空）')

  const userPrompt = `客户：${facts.displayName || `线索#${round.lead_id}`}\n\n${g.material}\n\n请输出首次分类提案 JSON。`
  const model = aiRunner ? 'injected-runner' : getAiModelConfig(aiConfigRef as ConfigService).model
  let raw = ''
  try {
    raw = aiRunner
      ? await aiRunner(userPrompt)
      : await simpleCompletion(aiConfigRef as ConfigService, FIRST_CLASSIFY_PROMPT, userPrompt, { usageContext: { purpose: 'first_classify' }, responseFormatJson: true, temperature: 0.2, maxTokens: 1200 })
  } catch (e) {
    return failRound(`模型调用失败: ${e instanceof Error ? e.message : String(e)}`)
  }
  const result = parseFirstClassifyResult(raw)
  if (!result) return failRound('模型输出无法解析为有效分类结果')

  // 成功：落 proposed 提案行 + 缺口快照 + 审计 + proposal_event + 反问卡
  const gaps = detectInfoGaps(facts)
  const now = Date.now()
  const evidenceJson = {
    fields: Object.fromEntries(Object.entries(result.fields).map(([k, v]) => [k, { source: v.source, evidenceKey: v.evidenceKey || '', evidenceText: v.evidenceText || '' }])),
    droppedNoEvidence: result.droppedNoEvidence,
    sourcesUsed: g.sourcesUsed
  }
  crmDbService.runTx((tx) => {
    tx.run(
      "UPDATE first_classification SET status = 'proposed', result_json = ?, evidence_json = ?, gaps_json = ?, model = ?, error = '', trigger_source = ?, updated_at = ?, version = version + 1 WHERE id = ? AND status = 'pending'",
      [JSON.stringify(result), JSON.stringify(evidenceJson), JSON.stringify(gaps), model, trigger, now, roundId]
    )
    tx.run('INSERT INTO audit_event (actor, action, entity_type, entity_id, detail, created_at) VALUES (?,?,?,?,?,?)',
      [SYS_ACTOR, 'first_classify_proposed', 'first_classification', roundId,
        JSON.stringify({
          leadId: Number(round.lead_id), assignmentId: Number(round.assignment_id), trigger, model,
          stage: result.stage, customerType: result.customerType, intentScore: result.intentScore,
          proposedFields: Object.keys(result.fields), droppedNoEvidence: result.droppedNoEvidence, gaps
        }), now])
  })
  trackProposalEvent({ event_type: 'proposal', stage: 'generated', entity_type: 'first_classification', entity_id: roundId, actor: SYS_ACTOR })
  const gapsCreated = generateGapCards(Number(round.assignment_id), Number(round.lead_id), roundId, gaps, facts)
  salesLog('INFO', `[FirstClassify] 轮次 #${roundId} proposed（stage=${result.stage} type=${result.customerType} 缺口卡+${gapsCreated}）`)
  return { ok: true, data: { roundId, status: 'proposed', gapsCreated } }
}

/**
 * 触发入口（扫描/手动共用）：解析轮次 → 已终结/待确认则不重复调模型；pending/failed 重跑。
 * E301 无线索/无 claimed 分配行；E202 已有 proposed/confirmed/rejected 轮次（返回现状，不调模型）。
 */
export async function runFirstClassification(opts: { leadId?: number; assignmentId?: number; trigger: 'scan' | 'manual'; actor?: string }): Promise<FirstClassifyRunResult> {
  if (!isEnabled()) return { ok: false, code: 'E403', message: '首次分类已关闭（crmFirstClassifyEnabled）' }
  let assignment: CrmRow | null = null
  if (opts.assignmentId) {
    assignment = crmDbService.all("SELECT * FROM assignment WHERE id = ? AND deleted = 0", [Number(opts.assignmentId)])[0] || null
  } else if (opts.leadId) {
    assignment = crmDbService.all(
      "SELECT * FROM assignment WHERE lead_id = ? AND deleted = 0 AND status = 'claimed' ORDER BY id DESC LIMIT 1",
      [Number(opts.leadId)]
    )[0] || null
  }
  if (!assignment) return { ok: false, code: 'E301', message: '无 claimed 状态的分配行（未认领不触发首次分类）' }
  if (String(assignment.status) !== 'claimed') return { ok: false, code: 'E201', message: `分配行状态 ${String(assignment.status)} 非 claimed` }
  const assignmentId = Number(assignment.id)
  const leadId = Number(assignment.lead_id)

  const existing = roundByAssignment(assignmentId)
  if (existing && ['proposed', 'confirmed', 'rejected'].includes(String(existing.status))) {
    // 幂等：该轮已有提案/裁决 → 不重复调模型（契约：已有该轮结果时不重复调用）
    return { ok: true, data: { roundId: Number(existing.id), status: String(existing.status), reused: true } }
  }
  let roundId = Number(existing?.id || 0)
  if (!roundId) {
    const now = Date.now()
    roundId = crmDbService.runTx((tx) => tx.run(
      "INSERT INTO first_classification (assignment_id, lead_id, status, trigger_source, source, updated_by, updated_at, version, deleted, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      [assignmentId, leadId, 'pending', opts.trigger, 'first-classify', SYS_ACTOR, now, 1, 0, now]
    ))
  }
  return executeRound(roundId, opts.trigger)
}

/**
 * 后台扫描一轮：status=claimed 且 claimed_at 满 24h 且尚无轮次行 → 触发。
 * 逐条独立执行（单条失败不影响其余）；claimed_at  NULL/0（存量/未认领）一律跳过。
 */
export async function scanClaimed24h(now: number = Date.now()): Promise<{ due: number; triggered: number; proposed: number; failed: number }> {
  if (!isEnabled()) return { due: 0, triggered: 0, proposed: 0, failed: 0 }
  const threshold = now - delayMs()
  const rows = crmDbService.all(
    `SELECT a.id FROM assignment a
     WHERE a.deleted = 0 AND a.status = 'claimed' AND a.claimed_at > 0 AND a.claimed_at <= ?
       AND NOT EXISTS (SELECT 1 FROM first_classification f WHERE f.assignment_id = a.id AND f.deleted = 0)
     ORDER BY a.id LIMIT 50`,
    [threshold]
  )
  let triggered = 0, proposed = 0, failed = 0
  for (const r of rows) {
    const res = await runFirstClassification({ assignmentId: Number(r.id), trigger: 'scan' })
    if (!res.data) continue
    triggered++
    if (res.data.status === 'proposed') proposed++
    if (res.data.status === 'failed') failed++
  }
  if (rows.length) salesLog('INFO', `[FirstClassify] 24h 扫描：到期 ${rows.length}，触发 ${triggered}，proposed ${proposed}，failed ${failed}`)
  return { due: rows.length, triggered, proposed, failed }
}

// ─── 人工裁决（B 档：proposed → confirmed / rejected）────────────────────────
/**
 * 确认：提案落正式事实（边界见文件头/宪法 §3 登记行）+ 状态 confirmed + 审计 + proposal/accepted。
 * 顺序 = 先落事实（各自带审计/幂等）再置 confirmed——confirm 行审计 detail 如实记录 applied 清单。
 */
export async function confirmFirstClassification(roundId: number, actor: string): Promise<FirstClassifyRunResult> {
  const id = Number(roundId)
  const round = roundById(id)
  if (!round) return { ok: false, code: 'E301', message: '分类轮次不存在' }
  if (String(round.status) !== 'proposed') return { ok: false, code: 'E201', message: `当前状态 ${String(round.status)} 不可确认（仅 proposed）` }
  const by = String(actor || '').trim() || getActorLabel() || '未署名'
  const result = JSON.parse(String(round.result_json || '{}')) as FirstClassifyResult
  const leadId = Number(round.lead_id)
  const facts = gapFactsForLead(leadId)
  const applied: string[] = []

  // ① customer_type → customer.type（仅已关联 customer；走 setCustomerType 人工写入口径，自带审计）
  if (result.customerType !== 'unknown' && facts.customerId > 0) {
    const r = setCustomerType(facts.customerId, result.customerType, by)
    if (r.ok && !r.data?.unchanged) applied.push(`customer.type=${result.customerType}`)
  }
  // ② stage → customer_profile.stage（仅当前 unknown/空，不覆盖新消息分类 A 档结果）
  if (result.stage !== 'unknown' && facts.sessionId && salesDbService.isInitialized()) {
    const profile = salesDbService.customerGetBySession(facts.sessionId)
    // stage 中英文混存，统一经 shared/salesStage.normalizeStage 归一后判断是否 unknown
    if (normalizeStage(profile?.stage) === 'unknown') {
      salesDbService.customerUpsert({ session_id: facts.sessionId, display_name: facts.displayName || undefined, stage: result.stage })
      salesDbService.updateStageChangeTime(facts.sessionId, Date.now())
      salesDbService.intentCreate({
        session_id: facts.sessionId, stage: result.stage, confidence: result.stageConfidence,
        source: 'first_classification_confirmed', reason: `认领24h首次分类（轮次#${id}，人工确认）`,
        evidence_text: result.stageEvidence || undefined
      })
      applied.push(`customer_profile.stage=${result.stage}`)
    }
  }
  // ③ 画像字段 → account enrich 字段集（不覆盖已有值与 manual/locked；quantity 无正式落点只留提案行）
  if (facts.accountId > 0) {
    const acc = crmDbService.all('SELECT * FROM account WHERE id = ?', [facts.accountId])[0]
    if (acc) {
      const meta = parseEnrichMeta(String(acc.enrich_meta || ''))
      let custom: Record<string, unknown> = {}
      try { custom = JSON.parse(String(acc.custom_fields || '{}')) } catch { custom = {} }
      const updates: Record<string, { value: string; meta: { source: 'ai'; confidence: number; at: number; evidence?: string; model?: string; sourceId?: string } }> = {}
      for (const [field, p] of Object.entries(result.fields)) {
        if (!(ENRICH_FIELDS as readonly string[]).includes(field)) continue // quantity 等无正式落点
        const fm = meta.fields?.[field]
        if (fm?.locked || fm?.source === 'manual') continue
        const curVal = String(acc[field] ?? custom[field] ?? '').trim()
        if (curVal) continue // 已有事实不覆盖（enrich 链路负责持续更新）
        updates[field] = {
          value: p.value,
          meta: { source: 'ai', confidence: p.confidence, at: Date.now(), evidence: p.evidenceText || p.evidenceKey || '', model: String(round.model || ''), sourceId: p.evidenceKey || '' }
        }
      }
      if (Object.keys(updates).length) {
        crmDbService.applyEnrichment(facts.accountId, updates, meta.pending || {})
        applied.push(...Object.keys(updates).map((f) => `account.${f}`))
      }
    }
  }

  const now = Date.now()
  crmDbService.runTx((tx) => {
    tx.run(
      "UPDATE first_classification SET status = 'confirmed', decided_by = ?, decided_at = ?, updated_by = ?, updated_at = ?, version = version + 1 WHERE id = ? AND status = 'proposed'",
      [by, now, by, now, id]
    )
    tx.run('INSERT INTO audit_event (actor, action, entity_type, entity_id, detail, created_at) VALUES (?,?,?,?,?,?)',
      [by, 'first_classify_confirmed', 'first_classification', id,
        JSON.stringify({ leadId, assignmentId: Number(round.assignment_id), applied, stage: result.stage, customerType: result.customerType, intentScore: result.intentScore }), now])
  })
  trackProposalEvent({ event_type: 'proposal', stage: 'accepted', entity_type: 'first_classification', entity_id: id, actor: by })
  // 字段确认后自动关闭对应缺口卡（confirm 自带字段已落事实）
  reevaluateInfoGapCards(leadId, by)
  salesLog('INFO', `[FirstClassify] 轮次 #${id} confirmed by ${by}（applied: ${applied.join(',') || '无'}）`)
  return { ok: true, data: { roundId: id, status: 'confirmed' } }
}

/** 拒绝：proposed → rejected（保留拒绝记录与原因；零正式字段写入） */
export function rejectFirstClassification(roundId: number, actor: string, reason: string): FirstClassifyRunResult {
  const id = Number(roundId)
  const round = roundById(id)
  if (!round) return { ok: false, code: 'E301', message: '分类轮次不存在' }
  if (String(round.status) !== 'proposed') return { ok: false, code: 'E201', message: `当前状态 ${String(round.status)} 不可拒绝（仅 proposed）` }
  const by = String(actor || '').trim() || getActorLabel() || '未署名'
  const now = Date.now()
  crmDbService.runTx((tx) => {
    tx.run(
      "UPDATE first_classification SET status = 'rejected', decided_by = ?, decided_at = ?, updated_by = ?, updated_at = ?, version = version + 1 WHERE id = ? AND status = 'proposed'",
      [by, now, by, now, id]
    )
    tx.run('INSERT INTO audit_event (actor, action, entity_type, entity_id, detail, created_at) VALUES (?,?,?,?,?,?)',
      [by, 'first_classify_rejected', 'first_classification', id,
        JSON.stringify({ leadId: Number(round.lead_id), assignmentId: Number(round.assignment_id), reason: String(reason || '').slice(0, 200) }), now])
  })
  trackProposalEvent({ event_type: 'proposal', stage: 'rejected', entity_type: 'first_classification', entity_id: id, actor: by })
  salesLog('INFO', `[FirstClassify] 轮次 #${id} rejected by ${by}（${String(reason || '').slice(0, 50)}）`)
  return { ok: true, data: { roundId: id, status: 'rejected' } }
}

// ─── 信息缺口反问卡（follow_up_task trigger_type='info_gap_ask'，宪法 §3 登记行）──
export const INFO_GAP_TRIGGER = 'info_gap_ask'

/** 出卡：同轮次同缺口只留一张 pending（应用层查重 + idx_ft_sla_once partial unique 双保险） */
function generateGapCards(assignmentId: number, leadId: number, roundId: number, gaps: string[], facts: LeadFacts): number {
  if (!salesDbService.isInitialized() || !gaps.length) return 0
  let created = 0
  for (const gapKey of gaps) {
    const def = gapDefByKey(gapKey)
    if (!def) continue
    const sourceId = gapSourceId(assignmentId, def.gapIndex)
    if (salesDbService.pendingTaskBySource(INFO_GAP_TRIGGER, sourceId)) continue
    try {
      const task = salesDbService.todoCreate({
        session_id: facts.sessionId || null,
        display_name: facts.displayName || null,
        action_type: 'reply_customer',
        trigger_type: INFO_GAP_TRIGGER,
        title: `信息缺口反问：${def.label}`,
        due_at: null,
        status: 'pending',
        priority_score: 0,
        created_by: 'first-classify',
        source_id: sourceId
      })
      salesDbService.todoUpdate(Number(task.id), {
        analysis: JSON.stringify({
          gap: gapKey, label: def.label, suggestion: def.suggestion,
          basis: `首次分类轮次 #${roundId} 缺口检测：${def.label} 无已确认事实（认领满24h，assignment #${assignmentId}）`,
          assignmentId, leadId, roundId
        })
      })
      created++
    } catch { /* partial unique 并发兜底：已存在即跳过 */ }
  }
  return created
}

/**
 * 字段确认后重评（双向往返）：
 *  ① 该 lead 所有轮次的 pending 反问卡，缺口已满足的置 done（历史保留，不删行）；
 *  ② 当前 claimed 轮次（已有 proposed/confirmed 提案）仍有缺口的补出卡（幂等，同缺口不重复）。
 * 触发点：applyInfoField accept / setAccountFieldManual / setCustomerType / registerOpportunityDeal / 首次分类 confirm。
 */
export function reevaluateInfoGapCards(leadId: number, actor: string): { closed: number; created: number } {
  if (!salesDbService.isInitialized()) return { closed: 0, created: 0 }
  const id = Number(leadId)
  if (!Number.isInteger(id) || id <= 0) return { closed: 0, created: 0 }
  const facts = gapFactsForLead(id)
  const missing = new Set(detectInfoGaps(facts))
  const assignmentIds = new Set(
    crmDbService.all('SELECT id FROM assignment WHERE lead_id = ?', [id]).map((r) => Number(r.id))
    )
  if (!assignmentIds.size) return { closed: 0, created: 0 }
  const pending = salesDbService.todoList({ status: 'pending' })
  const cards = (pending || []).filter((t) => String(t.trigger_type) === INFO_GAP_TRIGGER)
  let closed = 0
  for (const card of cards) {
    const decoded = decodeGapSourceId(Number(card.source_id || 0))
    if (!decoded || !assignmentIds.has(decoded.assignmentId)) continue
    const def = GAP_DEFS.find((g) => g.gapIndex === decoded.gapIndex)
    if (!def || missing.has(def.key)) continue // 仍缺 → 保留
    let analysis: Record<string, unknown> = {}
    try { analysis = JSON.parse(String(card.analysis || '{}')) } catch { analysis = {} }
    analysis.closedReason = `字段已确认（${def.label} 已有正式事实），反问卡自动关闭`
    analysis.closedBy = actor
    analysis.closedAt = Date.now()
    salesDbService.todoUpdate(Number(card.id), { status: 'done', analysis: JSON.stringify(analysis) })
    crmDbService.run(
      'INSERT INTO audit_event (actor, action, entity_type, entity_id, detail, created_at) VALUES (?,?,?,?,?,?)',
      [actor, 'info_gap_autoclose', 'lead', id,
        JSON.stringify({ taskId: Number(card.id), gap: def.key, label: def.label, assignmentId: decoded.assignmentId }), Date.now()]
    )
    closed++
  }
  // ② 补出卡：仅当前 claimed 且已跑过首次分类提案的轮次（分类未激活的轮次不出卡）
  let created = 0
  const curRound = crmDbService.all(
    `SELECT f.id AS roundId, f.assignment_id FROM first_classification f
     JOIN assignment a ON a.id = f.assignment_id
     WHERE f.lead_id = ? AND f.deleted = 0 AND f.status IN ('proposed','confirmed')
       AND a.deleted = 0 AND a.status = 'claimed'
     ORDER BY f.id DESC LIMIT 1`,
    [id]
  )[0]
  if (curRound) {
    created = generateGapCards(Number(curRound.assignment_id), id, Number(curRound.roundId), [...missing], facts)
  }
  return { closed, created }
}

// ─── 字段确认钩子注册（crmLifecycleHooks；模块加载即生效，幂等无副作用）───────
/** enrich 字段 → 缺口 key（不在映射内的字段不触发重评） */
const FIELD_TO_GAP: Record<string, string> = {
  company: 'company_industry', industry: 'company_industry',
  intent_model: 'intent_model', budget: 'budget', purchase_timeframe: 'purchase_timeframe'
}

function leadIdsByAccount(accountId: number): number[] {
  return crmDbService.all('SELECT id FROM lead WHERE account_id = ?', [accountId]).map((r) => Number(r.id))
}

onInfoFieldConfirmed((accountId, field) => {
  if (!FIELD_TO_GAP[field]) return
  for (const leadId of leadIdsByAccount(accountId)) reevaluateInfoGapCards(leadId, 'system:gap-hook')
})
onCustomerTypeSet((customerId) => {
  const accounts = crmDbService.all('SELECT id FROM account WHERE customer_id = ?', [customerId])
  for (const acc of accounts) {
    for (const leadId of leadIdsByAccount(Number(acc.id))) reevaluateInfoGapCards(leadId, 'system:gap-hook')
  }
})
onOpportunityDealRegistered((accountId) => {
  for (const leadId of leadIdsByAccount(accountId)) reevaluateInfoGapCards(leadId, 'system:gap-hook')
})

// ─── 后台调度器（main.ts 挂载；terminal 角色不跑——同 SLA1 回收器纪律）─────────
let schedulerStarted = false
export function startFirstClassifyScheduler(): void {
  if (schedulerStarted) return
  schedulerStarted = true
  const tick = (): void => {
    void enqueueSalesTask(() => scanClaimed24h()).catch((e) => {
      salesLog('WARN', `[FirstClassify] 扫描轮失败: ${e instanceof Error ? e.message : String(e)}`)
    })
  }
  const first = setTimeout(tick, 60_000) // 首扫延迟 60s（同 SLA 回收器先例，避让启动高峰）
  first.unref?.()
  const timer = setInterval(tick, scanIntervalMin() * 60_000)
  timer.unref?.()
}
