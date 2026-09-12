/**
 * crmFirstClassifyCore.ts —— 认领满 24h AI 首次分类：纯逻辑核（零 electron 依赖，可单测）
 *
 * 内含：固定 system prompt / 模型输出容错解析（证据硬门）/ 信息缺口六字段定义与检测 /
 * 反问卡 source_id 编解码。装配层见 crmFirstClassifyService.ts。
 *
 * 纪律（宪法 §1.10 + PRD 2.4）：
 *  - 一切提案字段必须带证据（evidence_key 或证据原文/结构化来源），无证据字段一律丢弃；
 *  - 证据不足输出 'unknown'（合法态，不瞎填）；
 *  - 昵称/备注/朋友圈等间接信号只形成疑似提案，永不直接成为正式事实。
 */

// ─── 信息缺口六字段（PRD 2.4；顺序 = gapIndex 编码序，勿改）─────────────────
export interface GapDef {
  key: string
  /** gapIndex 1-6：source_id = assignment_id * 10 + gapIndex（宪法 §3 info_gap_ask 登记行） */
  gapIndex: number
  label: string
  /** 反问卡话术建议（静态模板，建议销售下次聊天自然提问；不自动发消息） */
  suggestion: string
}

export const GAP_DEFS: readonly GapDef[] = [
  { key: 'customer_type', gapIndex: 1, label: '客户类型', suggestion: '下次聊天自然确认对方身份：自家用车还是做经销/批发（例如问「您这边是自已用还是帮客户采购？」）' },
  { key: 'company_industry', gapIndex: 2, label: '公司/行业', suggestion: '下次聊天自然了解对方公司与行业场景（例如问「您公司主要做哪块业务？仓库是什么类型的？」）' },
  { key: 'intent_model', gapIndex: 3, label: '需求型号', suggestion: '下次聊天自然锁定意向型号（例如问「您看中的是哪款？载重要求多少吨？」）' },
  { key: 'quantity', gapIndex: 4, label: '数量', suggestion: '下次聊天自然确认采购数量（例如问「这次大概要几台？」）' },
  { key: 'budget', gapIndex: 5, label: '预算', suggestion: '下次聊天自然探预算区间（例如问「这批采购预算大概在什么范围？」）' },
  { key: 'purchase_timeframe', gapIndex: 6, label: '采购时间', suggestion: '下次聊天自然确认采购时间窗（例如问「打算什么时候要车？着急用吗？」）' }
] as const

export function gapDefByKey(key: string): GapDef | undefined {
  return GAP_DEFS.find((g) => g.key === key)
}

/** 反问卡幂等键编码（宪法 §3：source_id = assignment_id * 10 + gapIndex） */
export function gapSourceId(assignmentId: number, gapIndex: number): number {
  return assignmentId * 10 + gapIndex
}
/** 解码：source_id → { assignmentId, gapIndex }；非反问卡编码返回 null */
export function decodeGapSourceId(sourceId: number): { assignmentId: number; gapIndex: number } | null {
  const n = Number(sourceId)
  if (!Number.isInteger(n) || n <= 0) return null
  const gapIndex = n % 10
  const assignmentId = (n - gapIndex) / 10
  if (gapIndex < 1 || gapIndex > GAP_DEFS.length || assignmentId <= 0) return null
  return { assignmentId, gapIndex }
}

// ─── 缺口检测（纯函数）─────────────────────────────────────────────────────
export interface GapFacts {
  customerType: string   // customer.type（''=未设置）
  company: string        // account.company
  industry: string       // account.industry
  intentModel: string    // account.custom_fields.intent_model 或 active 商机 main_model
  orderQty: number       // active 商机 order_qty 合计
  budget: string         // account.custom_fields.budget
  purchaseTimeframe: string // account.custom_fields.purchase_timeframe
}

/** 返回当前仍缺失的缺口 key 列表（按 GAP_DEFS 顺序） */
export function detectInfoGaps(f: GapFacts): string[] {
  const missing: string[] = []
  if (!String(f.customerType || '').trim()) missing.push('customer_type')
  if (!String(f.company || '').trim() && !String(f.industry || '').trim()) missing.push('company_industry')
  if (!String(f.intentModel || '').trim()) missing.push('intent_model')
  if (!(Number(f.orderQty) > 0)) missing.push('quantity')
  if (!String(f.budget || '').trim()) missing.push('budget')
  if (!String(f.purchaseTimeframe || '').trim()) missing.push('purchase_timeframe')
  return missing
}

// ─── 首次分类结果结构与解析 ────────────────────────────────────────────────
export const FIRST_CLASSIFY_STAGES = ['new', 'contacted', 'quoted', 'negotiating', 'won', 'lost', 'unknown'] as const
export type FirstClassifyStage = (typeof FIRST_CLASSIFY_STAGES)[number]

/** 证据来源枚举（结构化来源；昵称/备注/朋友圈/地址/档案只能形成疑似提案） */
export const EVIDENCE_SOURCES = ['chat', 'nickname', 'remark', 'moments', 'address', 'profile'] as const
export type EvidenceSource = (typeof EVIDENCE_SOURCES)[number]

/** 允许模型输出的画像字段白名单（白名单外一律丢弃） */
export const FIRST_CLASSIFY_FIELDS = ['company', 'industry', 'intent_model', 'quantity', 'budget', 'purchase_timeframe', 'needs'] as const
export type FirstClassifyFieldKey = (typeof FIRST_CLASSIFY_FIELDS)[number]

export interface FirstClassifyFieldProposal {
  value: string
  confidence: number
  source: EvidenceSource
  /** chat 来源的消息锚点 messageKey；结构化来源可空（用 evidenceText 说明出处） */
  evidenceKey?: string
  /** 证据原文快照/出处说明（客户原话 ≤200 字，或「昵称：xxx」类结构化说明） */
  evidenceText?: string
}

export interface FirstClassifyResult {
  stage: FirstClassifyStage
  stageConfidence: number
  /** 阶段判断依据（客户原话/来源说明；无依据阶段会被降级为 unknown） */
  stageEvidence?: string
  customerType: 'dealer' | 'end_user' | 'unknown'
  customerTypeConfidence: number
  /** 客户类型判断依据（间接信号原文，如「问返点」「我们冷库」；无依据降级 unknown） */
  customerTypeEvidence?: string
  intentScore: number | null
  fields: Partial<Record<FirstClassifyFieldKey, FirstClassifyFieldProposal>>
  /** 因缺证据被丢弃/降级的字段（诚实留痕，进 evidence_json 的 dropped 段） */
  droppedNoEvidence: string[]
}

// ─── 固定 system prompt（单一固定，差异放 user prompt；API 缓存命中率铁律）──
export const FIRST_CLASSIFY_PROMPT = `你是叉车/仓储设备销售场景的「认领满24小时首次分类」分析器。
根据销售认领客户后 24 小时内积累的材料，给出首次分类提案（仅供人工确认，不直接生效）。

输出字段：
1. stage：销售阶段初判 ∈ new/contacted/quoted/negotiating/won/lost/unknown
   - 非 unknown 必须给 stage_evidence（判断依据的聊天原话或来源说明）；无任何依据输出 unknown
2. customer_type：客户类型 ∈ dealer（经销商）/end_user（终端自用）/unknown
   - 非 unknown 必须给 customer_type_evidence（依据原文）
   - 间接信号只给疑似结论：聊天问返点/批发价 → dealer 疑似；自称「我们冷库/我们仓库」→ 按行业理解
   - 仅凭昵称/备注的模糊关键词不得下结论，输出 unknown
3. intent_score：意向评分 0-100，证据不足给 null
4. fields：画像字段，可含 company/industry/intent_model/quantity/budget/purchase_timeframe/needs。
   每个字段必须带：value、confidence(0-1)、source ∈ chat/nickname/remark/moments/address/profile、
   evidence_key（聊天来源的消息锚点，没有则空串）、evidence_text（证据原文或出处说明，≤200字）。
   没有任何证据的字段不要输出。

铁律：
- 只根据给定材料判断，不推测不编造；证据不足一律 unknown/null/不输出
- 严格输出 JSON，不要输出其他内容：
{"stage":"...","stage_confidence":0.0,"stage_evidence":"...","customer_type":"unknown","customer_type_confidence":0.0,"customer_type_evidence":"...","intent_score":null,"fields":{"company":{"value":"...","confidence":0.7,"source":"chat","evidence_key":"...","evidence_text":"..."}}}`

/**
 * 容错解析模型输出。失败返回 null（调用方落 failed 可重试，不写假结果）。
 * 证据硬门：字段缺（evidence_key 或 evidence_text）或 source 非法 → 丢弃并记 droppedNoEvidence。
 */
export function parseFirstClassifyResult(raw: string): FirstClassifyResult | null {
  let parsed: Record<string, unknown>
  try {
    const m = String(raw || '').match(/\{[\s\S]*\}/)
    if (!m) return null
    parsed = JSON.parse(m[0])
  } catch { return null }
  if (!parsed || typeof parsed !== 'object') return null

  const clamp01 = (v: unknown): number => {
    const n = Number(v)
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0
  }

  const stageRaw = String(parsed.stage || '').toLowerCase()
  let stage = (FIRST_CLASSIFY_STAGES as readonly string[]).includes(stageRaw) ? stageRaw as FirstClassifyStage : 'unknown'
  const ctRaw = String(parsed.customer_type || '').toLowerCase()
  let customerType: FirstClassifyResult['customerType'] = ctRaw === 'dealer' || ctRaw === 'end_user' ? ctRaw : 'unknown'

  const droppedNoEvidence: string[] = []
  // 证据硬门（宪法 §1.10 + PRD 2.4）：阶段/客户类型非 unknown 必须带依据，否则降级 unknown
  const stageEvidenceKey = String(parsed.stage_evidence_key || '').trim()
  const stageEvidence = String(parsed.stage_evidence || '').trim().slice(0, 200)
  if (stage !== 'unknown' && !stageEvidence && !stageEvidenceKey) { stage = 'unknown'; droppedNoEvidence.push('stage') }
  const ctEvidenceKey = String(parsed.customer_type_evidence_key || '').trim()
  const ctEvidence = String(parsed.customer_type_evidence || '').trim().slice(0, 200)
  if (customerType !== 'unknown' && !ctEvidence && !ctEvidenceKey) { customerType = 'unknown'; droppedNoEvidence.push('customer_type') }

  const scoreRaw = parsed.intent_score
  const scoreNum = Number(scoreRaw)
  // null/空 = 证据不足合法态（Number(null)=0 陷阱：不得误判为 0 分）
  const intentScore = (scoreRaw === null || scoreRaw === undefined || scoreRaw === '')
    ? null
    : (Number.isInteger(scoreNum) && scoreNum >= 0 && scoreNum <= 100 ? scoreNum : null)

  const fields: FirstClassifyResult['fields'] = {}
  const rawFields = (parsed.fields && typeof parsed.fields === 'object') ? parsed.fields as Record<string, Record<string, unknown>> : {}
  for (const [key, item] of Object.entries(rawFields)) {
    if (!(FIRST_CLASSIFY_FIELDS as readonly string[]).includes(key)) continue
    const value = String(item?.value ?? '').trim()
    if (!value || value.toLowerCase() === 'unknown') continue
    const source = String(item?.source || '') as EvidenceSource
    if (!(EVIDENCE_SOURCES as readonly string[]).includes(source)) { droppedNoEvidence.push(key); continue }
    const evidenceKey = String(item?.evidence_key || '').trim()
    const evidenceText = String(item?.evidence_text || '').trim().slice(0, 200)
    // 证据硬门（宪法 §1.10）：锚点或原文至少其一，否则丢弃
    if (!evidenceKey && !evidenceText) { droppedNoEvidence.push(key); continue }
    fields[key as FirstClassifyFieldKey] = {
      value: value.slice(0, 120),
      confidence: clamp01(item?.confidence),
      source,
      evidenceKey: evidenceKey || undefined,
      evidenceText: evidenceText || undefined
    }
  }

  return {
    stage,
    stageConfidence: clamp01(parsed.stage_confidence),
    stageEvidence: stageEvidence || stageEvidenceKey || undefined,
    customerType,
    customerTypeConfidence: clamp01(parsed.customer_type_confidence),
    customerTypeEvidence: ctEvidence || ctEvidenceKey || undefined,
    intentScore,
    fields,
    droppedNoEvidence
  }
}
