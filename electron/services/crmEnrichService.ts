/**
 * crmEnrichService.ts
 * CRM 客户信息自动填充引擎：AI 从聊天上下文 + 见解记录 + 关系画像中结构化提取客户字段，
 * 高置信自动写入 account（正式列 + custom_fields），中置信进 pending 队列由人工确认，低置信丢弃。
 *
 * 设计对齐：PRD-v2「用户不录入、不标记、不操作」；模式借鉴 AI CRM 主流做法
 * （对话提取 → 置信分级 → 自动写入/人工确认 + 字段级来源溯源）。
 * 纯解析逻辑在 crmEnrichCore（零 electron，可单测）；本文件为 electron 装配层。
 *
 * 铁律：
 * - 引擎绝不创建 account（只充实已存在客户；创建归导入链路）
 * - 手动修改过的字段（source=manual 或 locked）永不覆盖
 * - 执行入口一律 enqueueSalesTask（最外层），引擎内部绝不 enqueue
 * - 只从材料提取、不推测不编造（prompt 铁律 + evidence 随字段落库）
 */
import { simpleCompletion, isAiConfigured, getAiModelConfig } from './ai/aiApiClient'
import { chatService } from './chatService'
import { crmDbService, ENRICH_FIELDS, parseEnrichMeta, mergeEnrichFields, type CrmRow, type EnrichIncomingField, type EnrichMeta } from './crmDbService'
import { ENRICH_PROMPT, parseEnrichResult } from './crmEnrichCore'
import { insightProfileService } from './insightProfileService'
import { insightRecordService } from './insightRecordService'
import { salesLog } from './salesLogger'
import { trackProposalEvent } from './proposalEventTracking'
import type { ConfigService } from './config'

// ─── 可注入配置（同 crmAutoConfirmService.setAutoConfirmConfig 模式）────────
let configRef: { get: (k: string) => unknown } | null = null
export function setEnrichConfig(cfg: { get: (k: string) => unknown } | null): void {
  configRef = cfg
}
// 完整 ConfigService 注入（AI 调用需要 apiBaseUrl/apiKey 等全量键；configRef shim 只含 enrich 键）
let aiConfigRef: ConfigService | null = null
export function setEnrichAiConfig(cfg: ConfigService | null): void {
  aiConfigRef = cfg
}

function isEnabled(): boolean { return Boolean(configRef?.get('crmEnrichEnabled') ?? true) }
function thresholdOf(): number {
  const t = Number(configRef?.get('crmEnrichThreshold') ?? 0.7)
  return Number.isFinite(t) && t > 0 && t <= 1 ? t : 0.7
}
function autoApplyOf(): number {
  const t = Number(configRef?.get('crmEnrichAutoApply') ?? 0.85)
  return Number.isFinite(t) && t > 0 && t <= 1 ? t : 0.85
}
export function backfillLimitOf(): number {
  const n = Number(configRef?.get('crmEnrichBackfillLimit') ?? 20)
  return Number.isFinite(n) && n > 0 ? Math.min(100, Math.floor(n)) : 20
}

// ─── 材料收集（聊天上下文 + 见解 + 画像，截断控 token）──────────────────────
const MATERIAL_LIMIT_CHARS = 3000

/** 收集结果：material=喂给 AI 的材料文本；lastMsgKey=最近一条有效聊天消息的 messageKey（PRD§23 溯源用） */
async function gatherMaterials(sessionId: string, displayName: string): Promise<{ material: string; lastMsgKey?: string }> {
  const parts: string[] = []
  let lastMsgKey: string | undefined
  try {
    const msgs = await chatService.getLatestMessages(sessionId, 80)
    const texts = (msgs?.messages || [])
      .map((msg: any) => {
        const content = String(msg.parsedContent || msg.content || '').trim()
        if (!content || /^(<\?xml|<msg\b|<img\b|<emoji\b)/i.test(content)) return ''
        const isSend = Number(msg.isSend ?? msg.computed_is_send ?? msg.is_send ?? 0)
        lastMsgKey = String(msg.messageKey || '')
        return `${isSend === 1 ? '销售' : displayName}：${content.slice(0, 150)}`
      })
      .filter(Boolean)
      .slice(-50)
    if (texts.length) parts.push('【聊天记录】\n' + texts.join('\n'))
  } catch { /* 聊天不可用不阻断 */ }
  try {
    const r = insightRecordService.listRecords({ sessionId, limit: 10, includeArchive: true })
    const insights = (r.records || [])
      .map((rec: any) => String(rec.insight || '').slice(0, 120))
      .filter(Boolean)
      .map((s: string) => `- ${s}`)
    if (insights.length) parts.push('【AI 见解记录】\n' + insights.join('\n'))
  } catch { /* ignore */ }
  try {
    const rec = insightProfileService.getProfileRecord(sessionId)
    if (rec?.finalProfile) parts.push('【关系画像摘要】\n' + String(rec.finalProfile).slice(0, 800))
  } catch { /* ignore */ }
  let material = parts.join('\n\n')
  if (material.length > MATERIAL_LIMIT_CHARS) material = material.slice(0, MATERIAL_LIMIT_CHARS)
  return { material, lastMsgKey }
}

// ─── 核心：充实单个客户（调用方负责 enqueueSalesTask）───────────────────────
export interface EnrichResult {
  ok: boolean
  reason?: string
  accountId?: number
  updated?: string[]
  pending?: string[]
  discarded?: string[]
  skippedManual?: string[]
}

/**
 * 对已存在 account 执行 AI 信息填充。不创建 account（硬前提同自动确认引擎）。
 * 置信分级：≥ crmEnrichAutoApply 直接写入；[threshold, autoApply) 进 pending；< threshold 丢弃。
 */
export async function enrichCustomer(sessionId: string, displayName: string, opts?: { config?: ConfigService }): Promise<EnrichResult> {
  if (!sessionId || sessionId.endsWith('@chatroom')) return { ok: false, reason: '非私聊会话' }
  if (!isEnabled()) return { ok: false, reason: '自动填充已关闭' }
  const cfg = opts?.config ?? aiConfigRef
  if (!cfg) return { ok: false, reason: '配置未装配' }
  if (!isAiConfigured(cfg)) return { ok: false, reason: 'AI 未配置' }

  // 只充实已存在客户（session_id 精确 → 名称匹配兜底，不跨会话：排除已绑定其他 session 的同名客户）
  let acc: CrmRow | null = null
  const bySid = crmDbService.all('SELECT * FROM account WHERE session_id = ? LIMIT 1', [sessionId])
  if (bySid.length) acc = bySid[0]
  if (!acc && displayName) acc = crmDbService.matchAccountByName(displayName, { excludeSessionId: sessionId })
  if (!acc) return { ok: false, reason: '客户未在 CRM（引擎不创建客户）' }
  const accountId = Number(acc.id)

  const g = await gatherMaterials(sessionId, displayName || String(acc.name || ''))
  if (!g.material) return { ok: false, reason: '无可用聊天材料', accountId }
  // PRD§23 可追溯：记录本次提取用的模型名 + 依据的最近一条聊天消息 messageKey
  const model = getAiModelConfig(cfg).model
  const sourceId = g.lastMsgKey

  let out = ''
  try {
    out = await simpleCompletion(
      cfg,
      ENRICH_PROMPT,
      `客户：${displayName || acc.name}\n\n${g.material}`,
      { responseFormatJson: true, temperature: 0.2, maxTokens: 1200 }
    )
  } catch (e) {
    salesLog('WARN', `[CrmEnrich] AI 提取失败 ${displayName || acc.name}: ${e instanceof Error ? e.message : String(e)}`)
    return { ok: false, reason: 'AI 提取失败', accountId }
  }
  const incoming = parseEnrichResult(out)
  if (!incoming) return { ok: false, reason: 'AI 未输出有效提取结果', accountId }

  // 置信分级
  const autoApply = autoApplyOf()
  const threshold = thresholdOf()
  const directIncoming: Record<string, EnrichIncomingField> = {}
  const manualPending: Record<string, EnrichIncomingField> = {}
  const discardedLow: string[] = []
  for (const [field, item] of Object.entries(incoming)) {
    // 每条 AI 提取结果打上 model/sourceId 溯源标签（PRD§23）
    const tagged: EnrichIncomingField = { ...item, model, sourceId }
    if (item.confidence >= autoApply) directIncoming[field] = tagged
    else if (item.confidence >= threshold) manualPending[field] = tagged
    else discardedLow.push(field)
  }

  // 组装现状（正式列 + custom_fields 合并视图）
  const current: Record<string, string | null> = {}
  for (const f of ENRICH_FIELDS) current[f] = acc[f] != null && String(acc[f]).trim() !== '' ? String(acc[f]) : null
  let customFields: Record<string, unknown> = {}
  try { customFields = JSON.parse(String(acc.custom_fields || '{}')) } catch { customFields = {} }
  for (const f of ENRICH_FIELDS) {
    if (current[f] == null && customFields[f] != null && String(customFields[f]).trim() !== '') current[f] = String(customFields[f])
  }
  const meta: EnrichMeta = parseEnrichMeta(String(acc.enrich_meta || ''))

  const merged = mergeEnrichFields(current, meta, directIncoming, { threshold })
  const pendingMerged = { ...(meta.pending || {}) }
  const now = Date.now()
  for (const [field, item] of Object.entries(manualPending)) {
    const m = meta.fields?.[field]
    if (m?.locked || m?.source === 'manual') continue // 手动字段不进 pending 打扰
    pendingMerged[field] = { value: item.value, confidence: item.confidence, evidence: item.evidence, at: now, model: item.model, sourceId: item.sourceId }
  }

  const updatedFields = Object.keys(merged.updates)
  const newPendingFields = Object.keys(manualPending)
  if (updatedFields.length === 0 && newPendingFields.length === 0 && Object.keys(pendingMerged).length === Object.keys(meta.pending || {}).length) {
    salesLog('INFO', `[CrmEnrich] ${displayName || acc.name}：无需更新（discarded=${[...discardedLow, ...merged.discarded].join(',') || '无'} skipped=${merged.skipped.join(',') || '无'}）`)
    return { ok: true, accountId, updated: [], pending: [], discarded: [...discardedLow, ...merged.discarded], skippedManual: merged.skipped }
  }

  crmDbService.applyEnrichment(accountId, merged.updates, pendingMerged, {
    discarded: [...discardedLow, ...merged.discarded]
  })
  salesLog('INFO', `[CrmEnrich] ${displayName || acc.name}：自动写入 ${updatedFields.join(',') || '无'}；pending ${newPendingFields.join(',') || '无'}`)
  // 刀 2 埋点：提案生成点——新增进 pending 的字段逐条记 proposal/generated（append-only，trackProposalEvent 吞错）
  for (const field of newPendingFields) {
    trackProposalEvent({ event_type: 'proposal', stage: 'generated', entity_type: 'account_info', entity_id: `${accountId}:${field}`, actor: 'system:enrich' })
  }
  return {
    ok: true, accountId,
    updated: updatedFields,
    pending: newPendingFields,
    discarded: [...discardedLow, ...merged.discarded],
    skippedManual: merged.skipped
  }
}

// ─── 存量回填（限额串行；调用方负责 enqueueSalesTask）────────────────────────
export async function backfillEnrich(limit?: number): Promise<{ processed: number; updated: number; failed: number }> {
  const n = limit ?? backfillLimitOf()
  const candidates = crmDbService.enrichCandidates(n)
  let processed = 0, updated = 0, failed = 0
  for (const acc of candidates) {
    const sessionId = String(acc.session_id || '')
    if (!sessionId) continue
    try {
      const r = await enrichCustomer(sessionId, String(acc.name || ''))
      processed++
      if (r.ok && (r.updated?.length || 0) > 0) updated++
      if (!r.ok) {
        failed++
        salesLog('WARN', `[CrmEnrich] 回填未更新 ${acc.name}: ${r.reason || '未知原因'}`)
      }
    } catch (e) {
      failed++
      salesLog('WARN', `[CrmEnrich] 回填失败 ${acc.name}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  salesLog('INFO', `[CrmEnrich] 存量回填完成：处理 ${processed}，有更新 ${updated}，失败 ${failed}`)
  return { processed, updated, failed }
}
