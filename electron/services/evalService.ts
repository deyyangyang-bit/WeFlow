/**
 * evalService.ts —— D7 商机评测集：应用内候选生成 / 标注写回 / 进度与人机一致率统计
 *
 * 纯服务层，零 electron 依赖（同 crmAssignmentService 模式，方便 tsx 测试直接引用）。
 * 候选三路逻辑复用 scripts/opportunity-eval.ts 的 D7 定标口径，三处修正（本刀数据质量修复）：
 *   ① 过滤群聊（session_id 含 @chatroom 一律不进候选池——评测只标私聊）；
 *   ② 按 session 去重：同一客户只保留一行（取最新锚点：intent 按 created_at、quote 按 quoted_at 倒序首条）；
 *   ③ 对照样本改确定性抽样（按 session_id 排序取前 N）——应用内刷新按钮必须幂等，
 *      随机洗牌每轮都会抽中新会话导致候选池无限膨胀；一次性导出脚本仍可用 shuffle。
 * 幂等：UNIQUE 键 (session_id, anchor_key) 已存在则跳过插入；已存在但缺 AI 预标注的只做 ai_* 回填
 * （evalCaseUpsert 只更新显式提供的字段，人工结论 label/evidence_* 永不被生成流程覆盖，防锚定偏差）。
 *
 * AI 预标注回填：读取 opportunity-eval-pack-*.ai.jsonl（GLM 预填结果），
 * 按 (session_id, anchor_key) 精确匹配优先、session 级兜底；匹配不上的候选 ai_* 留空。
 *
 * ⛔ 铁律：读写 salesDb 只走 salesDbService 应用链路，绝不直改库文件。
 */
import { existsSync, readFileSync } from 'fs'
import { salesDbService } from './salesDbService'
import { crmDbService } from './crmDbService'
import type { OpportunityEvalCase } from './salesDbService'

/** 商机相关阶段（中英混存双轨，shared/salesStage.ts 定标「比价=quoted」） */
const OPP_STAGES = new Set(['quoted', 'negotiating', 'won', '比价', '决策', '成交'])
/** 人工三档（DB CHECK 同口径，这里先做 TS 层守卫给出友好报错） */
const LABELS = new Set(['has', 'none', 'uncertain'])
const EVIDENCE_TEXT_MAX = 200

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
  /** 幂等键已存在跳过数（含触发 ai 回填的） */
  skippedExisting: number
  /** 已存在行本次补齐 ai_* 的数量 */
  aiBackfilled: number
  /** 新插入行中匹配到 AI 预标注的数量 */
  aiMatched: number
  /** 被过滤的群聊候选数（①+②合计） */
  chatroomFiltered: number
  /** crm 库未就绪导致候选②整体跳过 */
  quoteSkipped: boolean
  bySource: { intent: number; quote: number; sample: number }
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
}

function clip200(text: string): string {
  const t = String(text || '').replace(/\s+/g, ' ').trim()
  return t.length > EVIDENCE_TEXT_MAX ? t.slice(0, EVIDENCE_TEXT_MAX) : t
}

function isChatroom(sessionId: string): boolean {
  return sessionId.includes('@chatroom')
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
    if (isChatroom(sid)) continue // 群聊预标注一律不进库（评测只标私聊）
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
 * 幂等：同 (session_id, anchor_key) 已存在则跳过；重复执行 inserted=0。
 */
export function generateEvalCandidates(opts?: { sample?: number; aiPackPath?: string }): EvalGenerateResult {
  const sampleN = Math.max(0, Math.floor(opts?.sample ?? 30) || 0)
  const pack = loadAiPack(opts?.aiPackPath)

  // 会话显示名映射（customer_profile 优先）
  const nameOf = new Map<string, string>()
  for (const p of salesDbService.customerAll()) {
    if (p.session_id && p.display_name) nameOf.set(String(p.session_id), String(p.display_name))
  }

  const result: EvalGenerateResult = {
    inserted: 0, skippedExisting: 0, aiBackfilled: 0, aiMatched: 0,
    chatroomFiltered: 0, quoteSkipped: false,
    bySource: { intent: 0, quote: 0, sample: 0 }, total: 0
  }
  /** 本次运行已覆盖的私聊 session（一 session 只留一行） */
  const covered = new Set<string>()
  /** 有商机类信号的 session（不进对照池） */
  const signalSessions = new Set<string>()

  /** 幂等入库：已存在跳过（缺 ai_* 则只回填 ai_*）；未存在插入并按内容推导 status。返回是否新插入 */
  const upsertCandidate = (c: {
    session_id: string
    anchor_key: string
    candidate_source: string
    evidence_text: string
  }): boolean => {
    const ai = aiFor(pack, c.session_id, c.anchor_key)
    const existing = salesDbService.evalCaseGet(c.session_id, c.anchor_key)
    if (existing) {
      result.skippedExisting++
      // 已存在行缺 AI 预标注且本次匹配到 → 只回填 ai_*（人工字段绝不动）
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
    if (ai) result.aiMatched++
    result.inserted++
    return true
  }

  // ① intent_tag_log 商机相关阶段 + message_key 证据锚点（created_at 倒序 → session 首条即最新锚点）
  const intents = salesDbService.intentWithEvidence(500)
  for (const it of intents) {
    const sid = String(it.session_id || '')
    if (!sid || isChatroom(sid)) { if (sid) result.chatroomFiltered++; continue }
    signalSessions.add(sid) // 凡带锚点打标都算「有信号」，不进对照池
    if (!OPP_STAGES.has(String(it.stage || ''))) continue
    if (covered.has(sid)) continue // 同 session 只留最新一条
    covered.add(sid)
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
    if (isChatroom(sid)) { result.chatroomFiltered++; continue }
    signalSessions.add(sid)
    if (covered.has(sid)) continue
    covered.add(sid)
    if (upsertCandidate({
      session_id: sid,
      anchor_key: String(q.msg_key || ''),
      candidate_source: 'quote_signal',
      evidence_text: '' // quote_signal 无原话快照，标注页直接看最近聊天记录判
    })) result.bySource.quote++
  }

  // ③ 无信号私聊会话对照样本（no_opportunity 候选）。
  // 确定性抽样（按 session_id 排序取前 N）：刷新按钮必须幂等——随机洗牌每轮会抽中新会话持续膨胀候选池；
  // 已入库的对照样本本轮再抽中走 skippedExisting，只有调大 sample 或出现新会话才会新增。
  // 群聊整体排除（customer_profile 里也有 @chatroom 会话，2026-09-02 导出包曾混入，本刀修复）。
  const pool = salesDbService.customerAll()
    .filter((p) => {
      const sid = String(p.session_id || '')
      if (!sid) return false
      if (isChatroom(sid)) { result.chatroomFiltered++; return false }
      return !signalSessions.has(sid)
    })
    .map((p) => String(p.session_id))
    .sort()
  for (const sid of pool.slice(0, sampleN)) {
    if (covered.has(sid)) continue
    covered.add(sid)
    if (upsertCandidate({
      session_id: sid,
      anchor_key: '',
      candidate_source: 'no_opportunity_sample',
      evidence_text: ''
    })) result.bySource.sample++
  }

  result.total = salesDbService.evalCaseCount()
  return result
}

/** 评测集列表（附展示名；pending/prelabeled 在前，confirmed 沉底，各自按更新时间倒序） */
export function evalListCases(): EvalCaseRow[] {
  const nameOf = new Map<string, string>()
  for (const p of salesDbService.customerAll()) {
    if (p.session_id && p.display_name) nameOf.set(String(p.session_id), String(p.display_name))
  }
  const rows = salesDbService.evalCaseList({ limit: 1000 }).map((r) => ({
    ...r,
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

/** 进度 + 人机一致率（只看候选池 = opportunity_eval_case 未软删全量） */
export function evalStats(): EvalStats {
  const rows = salesDbService.evalCaseList({ limit: 10000 })
  const confirmed = rows.filter((r) => r.status === 'confirmed')
  const compared = confirmed.filter((r) => r.ai_label && LABELS.has(String(r.ai_label)))
  const agree = compared.filter((r) => r.label === r.ai_label).length
  return {
    total: rows.length,
    confirmed: confirmed.length,
    compared: compared.length,
    agree,
    agreeRate: compared.length ? Math.round((agree / compared.length) * 100) : null
  }
}
