/**
 * evalService.ts —— D7 评测集：应用内候选生成 / 标注写回 / 进度与基线指标统计
 * （opportunity_eval_case 商机样本 + alert_eval_case 告警样本，宪法 §3 两特许扩展行）
 *
 * 纯服务层，零 electron 依赖（同 crmAssignmentService 模式，方便 tsx 测试直接引用）。
 *
 * 候选四路逻辑（2026-09-09 扩量刀，PRD ≥100 条基线门槛）：
 *   ① intent_tag_log 商机相关阶段 + message_key 证据锚点；
 *   ② crmDb quote_signal 报价信号；
 *   ③ 「意向信号会话」（本刀新增）：intent_tag_log 有打标但 ①② 没接住的会话（打标多无 message_key），
 *      锚点回退到「会话最新消息 key」（resolveAnchor 注入，主进程走 chatService；脚本/测试可传替身）；
 *   ④ 无信号私聊对照样本（no_opportunity 候选），锚点同样回退到会话最新消息 key。
 * 三条数据质量纪律（沿用 2026-09-03 口径）：
 *   ① 过滤非客户会话：群聊（@chatroom）+ 系统号（filehelper / gh_* / @openim / @kefu.openim）
 *      一律不进候选池——评测只标私聊客户；
 *   ② 同客户去重升级为「全库占坑」：opportunity_eval_case 里已有的 session 无论锚点形态一律跳过
 *      （旧逻辑只挡本轮同锚点，同 session 换锚点会插重行）；
 *   ③ 对照样本确定性抽样（按 session_id 排序取前 N）——应用内刷新按钮必须幂等。
 * 锚点诚实（宪法 §1.10）：resolveAnchor 拿不到 key 的会话不入库、计入 anchorMissing，
 * 绝不伪造 key（宁缺毋滥）；带锚点的样本 evidence_key 可经 evidenceGetByKey 回查原话。
 *
 * 扩量目标：默认 target=100（PRD 门槛）。①② 信号路不设上限（信号候选永远珍贵）；
 * ③④ 共用扩量预算 budget=target-存量，且为对照路预留 30%（标注指引「无商机对照 ≥30%」），
 * 意向信号最多吃 70%。显式传 sample 时退回老语义（③④ 合计 ≤ sample，测试与脚本批导出用）。
 *
 * 幂等：UNIQUE 键 (session_id, anchor_key) + 全库 session 占坑；已存在但缺 AI 预标注的只做 ai_* 回填
 * （evalCaseUpsert 只更新显式提供的字段，人工结论 label/evidence_* 永不被生成流程覆盖，防锚定偏差）。
 *
 * AI 预标注回填：读取 opportunity-eval-pack-*.ai.jsonl（GLM 预填结果），
 * 按 (session_id, anchor_key) 精确匹配优先、session 级兜底；匹配不上的候选 ai_* 留空。
 * 防锚定偏差（服务端级）：evalListCases 对 status≠confirmed 的行不下发 ai_* 字段。
 *
 * 基线指标（PRD：≥100 样本 + 基线 P/R）：只有 status=confirmed 的人工确认样本进指标；
 * 分档 has/none/uncertain 各算 P/R/F1（one-vs-rest）+ 3×3 混淆矩阵（行=人工，列=AI）；
 * 评测门槛 = 样本 ≥100 且人工确认 ≥100，未达标一律「未达到评测门槛」，不输出正式基线。
 *
 * ⛔ 铁律：读写 salesDb 只走 salesDbService 应用链路，绝不直改库文件。
 */
import { existsSync, readFileSync } from 'fs'
import { salesDbService } from './salesDbService'
import { crmDbService } from './crmDbService'
import type { OpportunityEvalCase, AlertEvalCase } from './salesDbService'

/** 商机相关阶段（中英混存双轨，shared/salesStage.ts 定标「比价=quoted」） */
const OPP_STAGES = new Set(['quoted', 'negotiating', 'won', '比价', '决策', '成交'])
/** 人工三档（DB CHECK 同口径，这里先做 TS 层守卫给出友好报错） */
const LABELS = new Set(['has', 'none', 'uncertain'])
const EVIDENCE_TEXT_MAX = 200

// ─── 评测门槛（PRD：至少 100 条样本 + 基线 P/R；标注指引 W8 目标 ≥100 条标注）────────
export const EVAL_GATE_MIN_TOTAL = 100
export const EVAL_GATE_MIN_CONFIRMED = 100
/** 对照样本占比咨询目标（标注指引「无商机对照 ≥30%」）：进报告 notes 提示，不做硬门槛 */
export const EVAL_NONE_SHARE_TARGET = 0.3

/** 评测三档（固定顺序：混淆矩阵行列序） */
export const EVAL_CLASSES = ['has', 'none', 'uncertain'] as const
export type EvalClassLabel = (typeof EVAL_CLASSES)[number]

/** AI 预标注包行（jsonl，scripts/opportunity-eval.ts export 的 PackRow + ai_* 预填） */
interface AiPackRow {
  session_id?: string
  anchor_key?: string
  ai_label?: string
  ai_evidence_keys?: string[]
}

export interface EvalGenerateResult {
  /** 本次新插入候选数 */
  inserted: number
  /** 幂等跳过数（含全库 session 占坑与同锚点已存在，含触发 ai 回填的） */
  skippedExisting: number
  /** 已存在行本次补齐 ai_* 的数量 */
  aiBackfilled: number
  /** 新插入行中匹配到 AI 预标注的数量 */
  aiMatched: number
  /** 被过滤的非客户候选数（群聊 + 系统号，①+②+③+④合计） */
  chatroomFiltered: number
  /** crm 库未就绪导致候选②整体跳过 */
  quoteSkipped: boolean
  bySource: { intent: number; quote: number; intent_signal: number; sample: number }
  /** ③④路因拿不到可回查锚点未入库的会话数（锚点诚实：宁缺毋滥，下轮刷新重试） */
  anchorMissing: number
  /** 本次扩量目标池规模（默认 = 评测门槛样本数） */
  target: number
  /** 生成后候选池总量（含历史存量） */
  total: number
}

export interface EvalCaseRow extends OpportunityEvalCase {
  /** 展示名（customer_profile.display_name 优先，兜底 session_id） */
  display_name: string
}

export interface EvalStats {
  total: number
  confirmed: number
  /** 已标且有 AI 预标注（可比对）的数量 */
  compared: number
  /** 人机一致数量 */
  agree: number
  /** 一致率 0-100；无可比对样本时为 null */
  agreeRate: number | null
  /** 人工确认分档计数（has/none/uncertain） */
  byLabel: { has: number; none: number; uncertain: number }
  /** 评测门槛判定（PRD ≥100 样本 + ≥100 人工确认） */
  gate: EvalGateStatus
}

function clip200(text: string): string {
  const t = String(text || '').replace(/\s+/g, ' ').trim()
  return t.length > EVIDENCE_TEXT_MAX ? t.slice(0, EVIDENCE_TEXT_MAX) : t
}

function isChatroom(sessionId: string): boolean {
  return sessionId.includes('@chatroom')
}

/**
 * 系统会话（非客户）：文件传输助手 / 公众号 / 企业微信客服。
 * 这些不是客户，进评测集只会让标注员白标一行并污染「无商机对照」分母
 * （live 库曾把 filehelper 收编成对照样本，且它在 intent_tag_log 里带「比价」打标）。
 * 判据沿用 analyticsService 既有口径。
 */
function isSystemSession(sessionId: string): boolean {
  return sessionId === 'filehelper' || sessionId.startsWith('gh_') ||
    sessionId.includes('@openim') || sessionId.includes('@kefu.openim')
}

/** 读 AI 预标注包：建 (session|anchor) 精确索引 + session 兜底索引（同 session 多行取首行） */
function loadAiPack(aiPackPath?: string): {
  byAnchor: Map<string, AiPackRow>
  bySession: Map<string, AiPackRow>
} {
  const byAnchor = new Map<string, AiPackRow>()
  const bySession = new Map<string, AiPackRow>()
  if (!aiPackPath || !existsSync(aiPackPath)) return { byAnchor, bySession }
  for (const line of readFileSync(aiPackPath, 'utf8').split('\n')) {
    const t = line.trim()
    if (!t) continue
    let row: AiPackRow
    try { row = JSON.parse(t) } catch { continue }
    const sid = String(row.session_id || '').trim()
    const aiLabel = String(row.ai_label || '').trim()
    if (!sid || !LABELS.has(aiLabel)) continue // 只回填有效三档预标注
    if (isChatroom(sid) || isSystemSession(sid)) continue // 群聊/系统号预标注一律不进库（评测只标私聊客户）
    const anchor = String(row.anchor_key || '')
    byAnchor.set(`${sid}|${anchor}`, row)
    if (!bySession.has(sid)) bySession.set(sid, row)
  }
  return { byAnchor, bySession }
}

function aiFor(pack: ReturnType<typeof loadAiPack>, sessionId: string, anchor: string): AiPackRow | undefined {
  return pack.byAnchor.get(`${sessionId}|${anchor}`) ?? pack.bySession.get(sessionId)
}

/**
 * 生成/刷新候选（标注页按钮触发；写库，调用方须走 enqueueSalesTask）。
 * 幂等：全库 session 占坑 + (session_id, anchor_key) 唯一——重复执行 inserted=0。
 * resolveAnchor：会话 → 可回查 messageKey（主进程注入 chatService 实现，取会话最新消息）；
 * ③④路候选拿不到锚点不入库（计入 anchorMissing），保证入库样本每条都有 evidence_key 可回查。
 */
export async function generateEvalCandidates(opts?: {
  /** 扩量目标池规模，默认 = 评测门槛样本数（100） */
  target?: number
  /** 显式上限（老语义：③④合计新增 ≤ sample）；不传则按 target 补足 */
  sample?: number
  aiPackPath?: string
  resolveAnchor?: (sessionId: string) => string | null | Promise<string | null>
}): Promise<EvalGenerateResult> {
  const targetN = Math.max(0, Math.floor(opts?.target ?? EVAL_GATE_MIN_TOTAL) || 0)
  const sampleN = opts?.sample != null ? Math.max(0, Math.floor(opts.sample) || 0) : null
  const pack = loadAiPack(opts?.aiPackPath)
  const resolveAnchor = opts?.resolveAnchor ?? null

  // 会话显示名映射（customer_profile 优先）
  const nameOf = new Map<string, string>()
  for (const p of salesDbService.customerAll()) {
    if (p.session_id && p.display_name) nameOf.set(String(p.session_id), String(p.display_name))
  }

  const result: EvalGenerateResult = {
    inserted: 0, skippedExisting: 0, aiBackfilled: 0, aiMatched: 0,
    chatroomFiltered: 0, quoteSkipped: false,
    bySource: { intent: 0, quote: 0, intent_signal: 0, sample: 0 },
    anchorMissing: 0, target: targetN, total: 0
  }

  // 同客户去重（全库占坑）：库里已有的 session 一律不再插入——旧逻辑只挡本轮同锚点，
  // 同 session 换锚点（新报价/新打标）会插重行，一客户多行会虚增样本量（2026-09-09 修复）。
  const existingRows = salesDbService.evalCaseList({ limit: 10000 })
  const covered = new Set<string>()
  const existingByKey = new Map<string, OpportunityEvalCase>()
  for (const r of existingRows) {
    covered.add(String(r.session_id))
    existingByKey.set(`${r.session_id}|${String(r.anchor_key || '')}`, r)
  }
  const beforeCount = existingRows.length

  // ③④扩量预算：默认补到 target；显式 sample 退回老语义。对照路预留 30%（指引：无商机对照 ≥30%），
  // 对照池吃不完的预留回流给③续收——一次刷新把池子补满。
  const budget = sampleN ?? Math.max(0, targetN - beforeCount)
  const controlReserve = Math.ceil(budget * EVAL_NONE_SHARE_TARGET)
  const signalBudget = Math.max(0, budget - controlReserve) // ③ 意向信号路首波上限（④拿预留+③吃剩的）

  /** 锚点解析：优先信号自带 messageKey，否则会话最新消息 key；都拿不到返回 null（绝不伪造，宪法 §1.10） */
  const anchorOf = async (sid: string, preferred?: string | null): Promise<string | null> => {
    const p = String(preferred || '').trim()
    if (p) return p
    if (!resolveAnchor) return null
    try {
      const k = await resolveAnchor(sid)
      const t = String(k || '').trim()
      return t || null
    } catch {
      return null
    }
  }

  /** 裸插入（③④专用，调用方保证 session 未占坑、锚点已解析）：入库 + 登记占坑/幂等索引 */
  const insertNew = (c: {
    session_id: string
    anchor_key: string
    candidate_source: string
    evidence_text: string
  }): boolean => {
    const ai = aiFor(pack, c.session_id, c.anchor_key)
    salesDbService.evalCaseUpsert({
      session_id: c.session_id,
      anchor_key: c.anchor_key,
      evidence_message_keys: c.anchor_key ? JSON.stringify([c.anchor_key]) : '[]',
      evidence_text: clip200(c.evidence_text),
      ...(ai ? {
        ai_label: String(ai.ai_label),
        ai_evidence_keys: JSON.stringify(Array.isArray(ai.ai_evidence_keys) ? ai.ai_evidence_keys : [])
      } : {}),
      source: c.candidate_source
    })
    existingByKey.set(`${c.session_id}|${c.anchor_key}`, salesDbService.evalCaseGet(c.session_id, c.anchor_key)!)
    if (ai) result.aiMatched++
    result.inserted++
    covered.add(c.session_id)
    return true
  }

  /** 幂等入库（①②）：同键已存在只回填 ai_*；同 session 异锚点（全库占坑）跳过不重插；否则新插 */
  const upsertCandidate = (c: {
    session_id: string
    anchor_key: string
    candidate_source: string
    evidence_text: string
  }): boolean => {
    const key = `${c.session_id}|${c.anchor_key}`
    const existing = existingByKey.get(key)
    if (existing) {
      result.skippedExisting++
      // 已存在行缺 AI 预标注且本次匹配到 → 只回填 ai_*（人工字段绝不动）
      const ai = aiFor(pack, c.session_id, c.anchor_key)
      if (ai && !existing.ai_label) {
        salesDbService.evalCaseUpsert({
          session_id: c.session_id,
          anchor_key: c.anchor_key,
          ai_label: String(ai.ai_label),
          ai_evidence_keys: JSON.stringify(Array.isArray(ai.ai_evidence_keys) ? ai.ai_evidence_keys : [])
        })
        result.aiBackfilled++
      }
      return false
    }
    if (covered.has(c.session_id)) {
      // 同客户不同锚点：库里已有该客户一行（可能旧锚点），绝不重插第二行（同客户去重）
      result.skippedExisting++
      return false
    }
    return insertNew(c)
  }

  /** ③④共用：解析锚点（信号自带 key → 会话最新消息 key）后插入；拿不到锚点不入库（锚点诚实） */
  const insertWithAnchor = async (c: {
    session_id: string
    preferred_anchor?: string | null
    candidate_source: string
    evidence_text: string
  }): Promise<boolean> => {
    const anchor = await anchorOf(c.session_id, c.preferred_anchor)
    if (!anchor) { result.anchorMissing++; return false }
    return insertNew({ session_id: c.session_id, anchor_key: anchor, candidate_source: c.candidate_source, evidence_text: c.evidence_text })
  }

  // ① intent_tag_log 商机相关阶段 + message_key 证据锚点（created_at 倒序 → session 首条即最新锚点）。
  // 同键已存在的行走 upsertCandidate 内的 AI 回填分支；同 session 异锚点的在库内占坑跳过。
  const intents = salesDbService.intentWithEvidence(500)
  for (const it of intents) {
    const sid = String(it.session_id || '')
    if (!sid) continue
    if (isChatroom(sid) || isSystemSession(sid)) { result.chatroomFiltered++; continue }
    if (!OPP_STAGES.has(String(it.stage || ''))) continue
    if (upsertCandidate({
      session_id: sid,
      anchor_key: String(it.message_key || ''),
      candidate_source: 'intent_tag_log',
      evidence_text: String(it.evidence_text || '')
    })) result.bySource.intent++
  }

  // ② crmDb quote_signal 报价信号（quoted_at 倒序 → session 首条即最新锚点；crm 未就绪整体跳过）
  let quotes: Array<Record<string, unknown>> = []
  try {
    quotes = crmDbService.all('SELECT * FROM quote_signal ORDER BY quoted_at DESC LIMIT 500')
  } catch {
    result.quoteSkipped = true
  }
  for (const q of quotes) {
    const sid = String(q.session_id || '')
    if (!sid) continue
    if (isChatroom(sid) || isSystemSession(sid)) { result.chatroomFiltered++; continue }
    if (upsertCandidate({
      session_id: sid,
      anchor_key: String(q.msg_key || ''),
      candidate_source: 'quote_signal',
      evidence_text: '' // quote_signal 无原话快照，标注页直接看最近聊天记录判
    })) result.bySource.quote++
  }

  // ③ 意向信号会话（本刀新增扩量路）：intent_tag_log 有打标但 ①② 没接住的会话——
  // live 库打标几乎全无 message_key，旧口径下这些「有信号」会话反被当无信号对照抽样。
  // 每会话取最新一条打标（intentLatestPerSession），锚点回退到会话最新消息 key。
  // 先全量收集未收编的信号会话并占坑（无论本轮是否入库都不进④对照池），按预算顺序入库。
  const eligibleSignals: Array<{ session_id: string; preferred_anchor?: string | null; evidence_text: string }> = []
  const intentSignals = salesDbService.intentLatestPerSession(1000)
  for (const it of intentSignals) {
    const sid = String(it.session_id || '')
    if (!sid) continue
    if (isChatroom(sid) || isSystemSession(sid)) { result.chatroomFiltered++; continue }
    if (covered.has(sid)) continue // ①②已收编或库内已有
    covered.add(sid) // 信号会话占坑：无论本轮是否入库都不进④对照池
    eligibleSignals.push({
      session_id: sid,
      preferred_anchor: String(it.message_key || ''),
      evidence_text: String(it.evidence_text || '')
    })
  }
  let signalCursor = 0
  const insertSignalBatch = async (cap: number): Promise<number> => {
    let n = 0
    while (signalCursor < eligibleSignals.length && n < cap) {
      const e = eligibleSignals[signalCursor++]
      if (await insertWithAnchor({ ...e, candidate_source: 'intent_signal' })) {
        n++; result.bySource.intent_signal++
      }
    }
    return n
  }
  const signalFilled = await insertSignalBatch(signalBudget)

  // ④ 无信号私聊会话对照样本（no_opportunity 候选）。
  // 确定性抽样（按 session_id 排序取前 N）：刷新按钮必须幂等——随机洗牌每轮会抽中新会话持续膨胀候选池。
  const controlBudget = Math.max(0, budget - result.bySource.intent - result.bySource.quote - signalFilled)
  const pool = salesDbService.customerAll()
    .filter((p) => {
      const sid = String(p.session_id || '')
      if (!sid) return false
      if (isChatroom(sid) || isSystemSession(sid)) { result.chatroomFiltered++; return false }
      return !covered.has(sid)
    })
    .map((p) => String(p.session_id))
    .sort()
  let sampleFilled = 0
  for (const sid of pool) {
    if (sampleFilled >= controlBudget) break
    if (covered.has(sid)) continue
    covered.add(sid)
    if (await insertWithAnchor({
      session_id: sid,
      candidate_source: 'no_opportunity_sample',
      evidence_text: ''
    })) { sampleFilled++; result.bySource.sample++ }
  }

  // ④对照池吃不完的预算（无足够无信号会话时）回流给③续收——一次刷新就把池子补满到 target
  await insertSignalBatch(controlBudget - sampleFilled)

  result.total = salesDbService.evalCaseCount()
  return result
}

/**
 * 评测集列表（附展示名；pending/prelabeled 在前，confirmed 沉底，各自按更新时间倒序）。
 * 防锚定偏差（服务端级）：人工未确认（status≠confirmed）的行不下发 ai_* —— UI 层之外的兜底，
 * 任何调用方都拿不到未确认样本的 AI 答案。
 */
export function evalListCases(): EvalCaseRow[] {
  const nameOf = new Map<string, string>()
  for (const p of salesDbService.customerAll()) {
    if (p.session_id && p.display_name) nameOf.set(String(p.session_id), String(p.display_name))
  }
  const rows = salesDbService.evalCaseList({ limit: 1000 }).map((r) => ({
    ...r,
    ai_label: r.status === 'confirmed' ? r.ai_label : '',
    ai_evidence_keys: r.status === 'confirmed' ? r.ai_evidence_keys : '[]',
    display_name: nameOf.get(String(r.session_id)) || String(r.session_id)
  }))
  const rank = (r: EvalCaseRow): number => (r.status === 'confirmed' ? 1 : 0)
  return rows.sort((a, b) => rank(a) - rank(b) || Number(b.updated_at || 0) - Number(a.updated_at || 0))
}

/**
 * 人工标注写回：label + annotated_by + status=confirmed（点击即写库）。
 * label 非法 / 标注人空缺 / 记录不存在 → 抛错（友好文案，IPC 层包 success:false）。
 */
export function evalLabelCase(id: number, label: string, annotatedBy: string): OpportunityEvalCase {
  const lab = String(label || '').trim()
  if (!LABELS.has(lab)) throw new Error(`非法标注结果「${lab}」（仅 有商机 has / 无商机 none / 不确定 uncertain）`)
  const by = String(annotatedBy || '').trim()
  if (!by) throw new Error('请先填写标注人')
  const row = salesDbService.evalCaseGetById(id)
  if (!row) throw new Error(`评测样本 #${id} 不存在`)
  return salesDbService.evalCaseUpsert({
    session_id: String(row.session_id),
    anchor_key: String(row.anchor_key || ''),
    label: lab,
    annotated_by: by,
    status: 'confirmed',
    updated_by: by
  })
}

/** 进度 + 人机一致率 + 分档计数 + 门槛判定（只看候选池 = opportunity_eval_case 未软删全量） */
export function evalStats(): EvalStats {
  const rows = salesDbService.evalCaseList({ limit: 10000 })
  const confirmed = rows.filter((r) => r.status === 'confirmed')
  const compared = confirmed.filter((r) => r.ai_label && LABELS.has(String(r.ai_label)))
  const agree = compared.filter((r) => r.label === r.ai_label).length
  const byLabel = { has: 0, none: 0, uncertain: 0 }
  for (const r of confirmed) {
    const lab = String(r.label || '')
    if (lab === 'has' || lab === 'none' || lab === 'uncertain') byLabel[lab]++
  }
  return {
    total: rows.length,
    confirmed: confirmed.length,
    compared: compared.length,
    agree,
    agreeRate: compared.length ? Math.round((agree / compared.length) * 100) : null,
    byLabel,
    gate: evalGateStatus(rows)
  }
}

// ─── 基线指标（PRD：≥100 样本 + 基线 P/R；纯函数可单测）────────────────────────
// 铁律：只有 status=confirmed 的人工确认样本进指标（pending/prelabeled 只是候选，不是答案）。

/** 评测门槛判定入参（可传库行自行计算；不传读库） */
export interface EvalGateStatus {
  minTotal: number
  minConfirmed: number
  /** 候选池总量（未软删） */
  total: number
  /** 人工确认数（status=confirmed） */
  confirmed: number
  /** 门槛是否达标：样本 ≥100 且人工确认 ≥100 */
  met: boolean
  /** 未达标原因（中文，达标时为空数组）——UI 与报告直接展示，绝不把未达标说成已达标 */
  shortfalls: string[]
}

/** 单档指标（one-vs-rest：以该档为正类；分子分母只数人工确认样本） */
export interface EvalClassMetric {
  label: EvalClassLabel
  /** 真阳：人工=AI=该档 */
  tp: number
  /** 假阳：AI=该档而人工≠该档（AI 误报） */
  fp: number
  /** 假阴：人工=该档而 AI≠该档（AI 漏报） */
  fn: number
  /** 支持度：人工确认 = 该档的样本数 */
  support: number
  precision: number | null
  recall: number | null
  f1: number | null
}

export interface EvalMetrics {
  /** 参与计算的样本：status=confirmed 且人工 label 与 ai_label 均为有效三档 */
  compared: number
  /** 逐样本命中率：人工=AI（含 uncertain 档） */
  accuracy: number | null
  /** 三档 F1 宏平均（仅对可计算档取平均；全部不可算为 null） */
  macroF1: number | null
  /** has/none/uncertain 分档指标 */
  classes: Record<EvalClassLabel, EvalClassMetric>
  /** 混淆矩阵：行=人工 label，列=AI label，行列序同 EVAL_CLASSES */
  confusion: { labels: EvalClassLabel[]; matrix: number[][] }
}

/** 门槛判定（rows 不传读库） */
export function evalGateStatus(rows?: OpportunityEvalCase[]): EvalGateStatus {
  const list = rows ?? salesDbService.evalCaseList({ limit: 10000 })
  const total = list.length
  const confirmed = list.filter((r) => r.status === 'confirmed').length
  const shortfalls: string[] = []
  if (total < EVAL_GATE_MIN_TOTAL) shortfalls.push(`候选样本不足：${total}/${EVAL_GATE_MIN_TOTAL} 条`)
  if (confirmed < EVAL_GATE_MIN_CONFIRMED) shortfalls.push(`人工确认不足：${confirmed}/${EVAL_GATE_MIN_CONFIRMED} 条`)
  return { minTotal: EVAL_GATE_MIN_TOTAL, minConfirmed: EVAL_GATE_MIN_CONFIRMED, total, confirmed, met: shortfalls.length === 0, shortfalls }
}

const pct = (n: number): number => Math.round(n * 1000) / 10 // 0.846 → 84.6

/** 单档 one-vs-rest 指标（返回 rawF1 供宏平均用，避免对已百分化值二次换算） */
function classMetric(label: EvalClassLabel, confirmed: OpportunityEvalCase[]): { metric: EvalClassMetric; rawF1: number | null } {
  let tp = 0, fp = 0, fn = 0
  for (const r of confirmed) {
    const h = String(r.label || '')
    const a = String(r.ai_label || '')
    if (h === label && a === label) tp++
    else if (h !== label && a === label) fp++
    else if (h === label && a !== label) fn++
  }
  const support = tp + fn
  const precision = tp + fp > 0 ? tp / (tp + fp) : null
  const recall = support > 0 ? tp / support : null
  const f1 = precision != null && recall != null
    ? (precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0)
    : null
  return {
    metric: {
      label, tp, fp, fn, support,
      precision: precision != null ? pct(precision) : null,
      recall: recall != null ? pct(recall) : null,
      f1: f1 != null ? pct(f1) : null
    },
    rawF1: f1
  }
}

/**
 * 基线指标计算（纯函数，tsx 可单测）：入参 = 库行全集；内部只取 status=confirmed 且
 * label/ai_label 均为有效三档的样本。分档 P/R/F1（one-vs-rest）+ 3×3 混淆矩阵（行=人工，列=AI）。
 */
export function computeEvalMetrics(rows: OpportunityEvalCase[]): EvalMetrics {
  const confirmed = rows.filter((r) =>
    r.status === 'confirmed' && LABELS.has(String(r.label || '')) && LABELS.has(String(r.ai_label || '')))
  const perClass = {
    has: classMetric('has', confirmed),
    none: classMetric('none', confirmed),
    uncertain: classMetric('uncertain', confirmed)
  }
  const classes = {
    has: perClass.has.metric,
    none: perClass.none.metric,
    uncertain: perClass.uncertain.metric
  } as Record<EvalClassLabel, EvalClassMetric>
  const matrix = EVAL_CLASSES.map(() => EVAL_CLASSES.map(() => 0))
  let hit = 0
  for (const r of confirmed) {
    const h = EVAL_CLASSES.indexOf(String(r.label) as EvalClassLabel)
    const a = EVAL_CLASSES.indexOf(String(r.ai_label) as EvalClassLabel)
    if (h >= 0 && a >= 0) matrix[h][a]++
    if (h === a) hit++
  }
  const f1s = EVAL_CLASSES.map((c) => perClass[c].rawF1).filter((v): v is number => v != null)
  return {
    compared: confirmed.length,
    accuracy: confirmed.length ? pct(hit / confirmed.length) : null,
    macroF1: f1s.length ? pct(f1s.reduce((s, v) => s + v, 0) / f1s.length) : null,
    classes,
    confusion: { labels: [...EVAL_CLASSES], matrix }
  }
}

// ─── 基线报告（可导出；门槛未达时不产出正式指标）──────────────────────────────

export interface EvalBaselineReport {
  schema: 'weflow-opportunity-eval-baseline/1'
  generatedAt: string
  /** 评测门槛判定——未达标时本报告不是正式基线 */
  gate: EvalGateStatus
  /** 候选池构成（未软删全量） */
  candidates: {
    total: number
    bySource: Record<string, number>
    /** 有可回查证据锚点（anchor_key 非空）的样本数 */
    withAnchor: number
    /** 无锚点样本数（历史存量；新入库样本保证有锚点） */
    withoutAnchor: number
  }
  /** 标注分档分布：人工（confirmed 内）与 AI 预标注（候选池内） */
  labelDistribution: {
    human: { has: number; none: number; uncertain: number; unlabeled: number }
    ai: { has: number; none: number; uncertain: number; absent: number }
  }
  /** 正式基线指标：门槛未达时为 null（未达到评测门槛，不输出基线数字） */
  metrics: EvalMetrics | null
  /** 人机一致率（confirm ∩ 有 AI 预标注） */
  agreement: { compared: number; agree: number; agreeRate: number | null }
  notes: string[]
}

/** 基线报告（读库；门槛未达 → metrics=null，报告明确「未达到评测门槛」） */
export function evalBaselineReport(): EvalBaselineReport {
  const rows = salesDbService.evalCaseList({ limit: 10000 })
  const gate = evalGateStatus(rows)
  const bySource: Record<string, number> = {}
  let withAnchor = 0
  const human = { has: 0, none: 0, uncertain: 0, unlabeled: 0 }
  const ai = { has: 0, none: 0, uncertain: 0, absent: 0 }
  for (const r of rows) {
    const src = String(r.source || 'unknown')
    bySource[src] = (bySource[src] || 0) + 1
    if (String(r.anchor_key || '').trim()) withAnchor++
    const lab = String(r.label || '')
    if (lab === 'has' || lab === 'none' || lab === 'uncertain') human[lab]++
    else human.unlabeled++
    const al = String(r.ai_label || '')
    if (al === 'has' || al === 'none' || al === 'uncertain') ai[al]++
    else ai.absent++
  }
  const confirmed = rows.filter((r) => r.status === 'confirmed')
  const compared = confirmed.filter((r) => r.ai_label && LABELS.has(String(r.ai_label)))
  const agree = compared.filter((r) => r.label === r.ai_label).length
  const noneShare = confirmed.length ? (human.none / confirmed.length) : 0
  const notes: string[] = []
  if (gate.met && noneShare < EVAL_NONE_SHARE_TARGET) {
    notes.push(`无商机对照样本占比 ${pct(noneShare)}%，低于 ${EVAL_NONE_SHARE_TARGET * 100}% 目标（标注指引 W8 口径），基线召回数字对误报偏乐观`)
  }
  notes.push(`候选池锚点覆盖率 ${rows.length ? pct(withAnchor / rows.length) : 0}%（evidence_key 可经消息编号回查原话）`)
  notes.push('指标只统计人工确认（status=confirmed）样本；AI 预标注仅作比对，不进分母')
  return {
    schema: 'weflow-opportunity-eval-baseline/1',
    generatedAt: new Date().toISOString(),
    gate,
    candidates: { total: rows.length, bySource, withAnchor, withoutAnchor: rows.length - withAnchor },
    labelDistribution: { human, ai },
    metrics: gate.met ? computeEvalMetrics(rows) : null,
    agreement: { compared: compared.length, agree, agreeRate: compared.length ? Math.round((agree / compared.length) * 100) : null },
    notes
  }
}

/** 基线报告 → Markdown（导出用；门槛未达时首行即「未达到评测门槛」） */
export function renderBaselineReportMarkdown(r: EvalBaselineReport): string {
  const L: string[] = []
  const n = (v: number | null): string => (v == null ? '—' : String(v))
  L.push('# 商机判定评测基线报告')
  L.push('')
  L.push(`- 生成时间：${r.generatedAt}`)
  L.push(`- 数据来源：opportunity_eval_case（应用内候选池，只统计未软删行）`)
  L.push(`- 评测门槛：候选样本 ≥ ${r.gate.minTotal} 条 且 人工确认 ≥ ${r.gate.minConfirmed} 条`)
  L.push('')
  if (r.gate.met) {
    L.push('## 门槛判定：✅ 已达到评测门槛')
  } else {
    L.push('## 门槛判定：⛔ 未达到评测门槛')
    for (const s of r.gate.shortfalls) L.push(`- ${s}`)
    L.push('- 本报告不产出正式基线指标（P/R/F1 只在门槛达标后输出）')
  }
  L.push('')
  L.push('## 候选池构成')
  L.push('')
  L.push(`- 样本总量：${r.candidates.total} 条（有证据锚点 ${r.candidates.withAnchor} / 无锚点 ${r.candidates.withoutAnchor}）`)
  for (const [src, cnt] of Object.entries(r.candidates.bySource)) L.push(`- 来源 ${src}：${cnt} 条`)
  L.push(`- 人工确认进度：${r.gate.confirmed}/${r.candidates.total}（has ${r.labelDistribution.human.has} / none ${r.labelDistribution.human.none} / uncertain ${r.labelDistribution.human.uncertain} / 未标 ${r.labelDistribution.human.unlabeled}）`)
  L.push(`- AI 预标注覆盖：has ${r.labelDistribution.ai.has} / none ${r.labelDistribution.ai.none} / uncertain ${r.labelDistribution.ai.uncertain} / 无预标注 ${r.labelDistribution.ai.absent}`)
  L.push(`- 人机一致率：${r.agreement.agreeRate == null ? '—' : `${r.agreement.agreeRate}%`}（${r.agreement.agree}/${r.agreement.compared}）`)
  L.push('')
  if (r.metrics) {
    const mets = r.metrics
    L.push('## 基线指标（以 has 为正类 + 分档 one-vs-rest）')
    L.push('')
    L.push('| 档位 | 支持度 | TP | FP | FN | Precision | Recall | F1 |')
    L.push('|---|---|---|---|---|---|---|---|')
    for (const c of EVAL_CLASSES) {
      const cm = mets.classes[c]
      L.push(`| ${c} | ${cm.support} | ${cm.tp} | ${cm.fp} | ${cm.fn} | ${n(cm.precision)}${cm.precision == null ? '' : '%'} | ${n(cm.recall)}${cm.recall == null ? '' : '%'} | ${n(cm.f1)}${cm.f1 == null ? '' : '%'} |`)
    }
    L.push(`| 宏平均 | — | — | — | — | — | — | ${n(mets.macroF1)}${mets.macroF1 == null ? '' : '%'} |`)
    L.push('')
    L.push(`- 逐样本命中率（accuracy）：${n(mets.accuracy)}${mets.accuracy == null ? '' : '%'}（${mets.compared} 条可比对）`)
    L.push('')
    L.push('### 混淆矩阵（行=人工确认，列=AI 预标注）')
    L.push('')
    L.push(`| 人工 \\ AI | ${mets.confusion.labels.join(' | ')} |`)
    L.push(`|---|${mets.confusion.labels.map(() => '---').join('|')}|`)
    mets.confusion.labels.forEach((h, i) => {
      L.push(`| **${h}** | ${mets.confusion.matrix[i].join(' | ')} |`)
    })
    L.push('')
  }
  if (r.notes.length) {
    L.push('## 备注')
    L.push('')
    for (const nt of r.notes) L.push(`- ${nt}`)
    L.push('')
  }
  L.push('---')
  L.push('')
  L.push('PIPL：报告只含计数与标注结论，不含聊天原文；样本证据只存 messageKey 引用 + ≤200 字原话快照，不出本机。')
  return L.join('\n')
}

// ─── 告警评测集（alert_eval_case，宪法 §3；标注页「告警样本」页签 + eval:alert:* 三端点）────
// 读写全走 salesDbService.alertEvalCase* 既有五入口（只读为主，不新增表不新增写路径）；
// 写回沿用 import 式幂等 upsert（ai_* 与人工字段分存互不覆盖——undefined 字段零触碰）。

/** 告警人工三档（DB CHECK 同口径；语义 = 告警是否成立，非商机有无） */
export const ALERT_LABELS = new Set(['correct', 'wrong', 'uncertain'])
/** 告警类型 → 中文（标注页 pill 与统计行共用；未在册类型回退原文） */
export const ALERT_TYPE_TEXT: Record<string, string> = {
  competitor: '竞品提及',
  loss: '客户流失',
  payment_overdue: '承诺打款过期'
}

export interface AlertEvalCaseRow extends AlertEvalCase {
  /** 展示名（customer_profile.display_name 优先，兜底 session_id） */
  display_name: string
}

/** 单类型统计（≥85% 开门判定的直接读数） */
export interface AlertTypeEvalStat {
  alertType: string
  /** 人工已标注数（status=confirmed） */
  annotated: number
  /** 候选总数（未软删） */
  total: number
  /** 可比对数：人工已标且非「不确定」且有 AI 预标注（不确定 = 人机都拿不准，计入一致率会虚增分母） */
  compared: number
  /** AI 预判与人工一致数 */
  agree: number
  /** 一致率 0-100；无可比对样本时为 null */
  agreeRate: number | null
}

export interface AlertEvalStats {
  /** 按告警类型分组（类型集取自库内数据） */
  types: AlertTypeEvalStat[]
  total: number
  annotated: number
}

/**
 * 统计口径（纯函数，tsx 可单测）：分母 = 人工已标（status=confirmed）且 label ≠ 'uncertain' 且 ai_label
 * 有效三档；分子 = 其中 label === ai_label。未标注行只进 total，不进分母。
 */
export function computeAlertAnnotateStats(rows: AlertEvalCase[]): AlertEvalStats {
  const byType = new Map<string, AlertEvalCase[]>()
  for (const r of rows) {
    const t = String(r.alert_type || '').trim() || ''
    if (!byType.has(t)) byType.set(t, [])
    byType.get(t)!.push(r)
  }
  const types: AlertTypeEvalStat[] = [...byType.keys()].sort().map((t) => {
    const list = byType.get(t)!
    const annotatedRows = list.filter((r) => r.status === 'confirmed')
    const compared = annotatedRows.filter((r) => String(r.label || '') !== 'uncertain' && r.ai_label && ALERT_LABELS.has(String(r.ai_label)))
    const agree = compared.filter((r) => r.label === r.ai_label).length
    return {
      alertType: t,
      annotated: annotatedRows.length,
      total: list.length,
      compared: compared.length,
      agree,
      agreeRate: compared.length ? Math.round((agree / compared.length) * 100) : null
    }
  })
  return {
    types,
    total: rows.length,
    annotated: rows.filter((r) => r.status === 'confirmed').length
  }
}

/** 告警评测集列表（附展示名；待标注在前已标注沉底，各自按更新时间倒序） */
export function alertEvalListCases(): AlertEvalCaseRow[] {
  const nameOf = new Map<string, string>()
  for (const p of salesDbService.customerAll()) {
    if (p.session_id && p.display_name) nameOf.set(String(p.session_id), String(p.display_name))
  }
  const rows = salesDbService.alertEvalCaseList({ limit: 1000 }).map((r) => ({
    ...r,
    display_name: nameOf.get(String(r.session_id)) || String(r.session_id)
  }))
  const rank = (r: AlertEvalCaseRow): number => (r.status === 'confirmed' ? 1 : 0)
  return rows.sort((a, b) => rank(a) - rank(b) || Number(b.updated_at || 0) - Number(a.updated_at || 0))
}

/**
 * 告警样本人工标注写回（点击即写库，import 式幂等）：label 三档 + annotated_by + status=confirmed。
 * ai_label / ai_evidence_keys / evidence_* 等字段不传即不动（ai_* 与人工互不覆盖，防锚定语义保留）。
 * label 非法 / 标注人空缺 / 记录不存在 → 抛错（IPC 层包 success:false）。
 */
export function alertEvalLabelCase(id: number, label: string, annotatedBy: string): AlertEvalCase {
  const lab = String(label || '').trim()
  if (!ALERT_LABELS.has(lab)) throw new Error(`非法标注结果「${lab}」（仅 告警成立 correct / 不成立 wrong / 不确定 uncertain）`)
  const by = String(annotatedBy || '').trim()
  if (!by) throw new Error('请先填写标注人')
  const row = salesDbService.alertEvalCaseGetById(id)
  if (!row) throw new Error(`告警评测样本 #${id} 不存在`)
  return salesDbService.alertEvalCaseUpsert({
    session_id: String(row.session_id),
    anchor_key: String(row.anchor_key || ''),
    alert_type: String(row.alert_type || ''),
    label: lab,
    annotated_by: by,
    status: 'confirmed',
    updated_by: by
  })
}

/** 告警评测进度 + 人机一致率（只读；按 alert_type 分组，≥85% 开门判定直接读数） */
export function alertEvalStats(): AlertEvalStats {
  return computeAlertAnnotateStats(salesDbService.alertEvalCaseList({ limit: 10000 }))
}
