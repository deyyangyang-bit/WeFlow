/**
 * salesKnowledgeService.ts
 *
 * 话术/产品知识库业务服务。
 * 提供知识库条目的增删改查、搜索，以及为 AI 回复建议提供知识检索能力。
 *
 * 治理收口（PRD 2.3/2.7/2.9，宪法 §3 登记行）：
 *  - AI 有效知识读取唯一原语 = salesDbService.kbValidEntries（published + TTL 未过期 + 每链当前版本）；
 *    本服务的 retrieveForPrompt / buildKnowledgeContext 只经该原语取数，禁止直连无过滤 kbList/kbSearch；
 *  - published 编辑 = fork 同链 version+1 staging 新版本（原版本不动，发布后接替关闭）；
 *    staging 原地编辑；rejected/closed 只读；
 *  - 物理删除仅限从未审核的 staging，且先写 crmDb audit_event（跨库铁律「先 crmDb 后 salesDb」）；
 *  - 价格类条目发布 official 前与 crmDb product 主数据对账，冲突禁止 official（产品库价格为最终权威）；
 *  - TTL 到期只生成待处理提醒（follow_up_task/knowledge_ttl），不删除知识。
 */

import { salesDbService, todayIsoDate, type KnowledgeEntry } from './salesDbService'
import { crmDbService } from './crmDbService'
import { wcdbService } from './wcdbService'
import { simpleCompletion, isAiConfigured } from './ai/aiApiClient'
import type { ConfigService } from './config'
import { salesLog } from './salesLogger'
import { currentActor, trackProposalEvent } from './proposalEventTracking'

// ─── 类型 ────────────────────────────────────────────────────────────────────

export interface KbListResult {
  success: boolean
  entries: KnowledgeEntry[]
  total: number
}

export interface KbCreatePayload {
  category: string
  product_line?: string
  title: string
  content: string
  tags?: string[]
  scene?: string
  ttl_date?: string | null
}

export interface KbUpdatePayload {
  category?: string
  product_line?: string
  title?: string
  content?: string
  tags?: string[]
  scene?: string
  /** 到期日 YYYY-MM-DD（可传 null 清除）；staging 原地生效，published 随 fork 继承 */
  ttl_date?: string | null
}

export interface KbSearchPayload {
  keyword: string
  category?: string
  product_line?: string
}

/**
 * 刀 4 知识提案载荷（设计-Hermes-MVP 刀 4，宪法 §3 提案列登记行）。
 * evidence_key 硬门（§1.10）：空锚提案不进审核队列——问答路径 = 问题摘要哈希 askKey，
 * 手动「补充知识」路径 = 客户原话 messageKey 或出处摘要。
 */
export interface KbProposePayload {
  title: string
  content: string
  category?: string
  scene?: string
  tags?: string[]
  evidence_key: string
}

// ─── 价格对账（PRD 2.7：价格类条目与 product 主数据核对，冲突以产品库为准）───

/** 价格冲突字段（返回给审核端的具体冲突明细） */
export interface PriceConflictField {
  field: 'unit_price'
  product_id: number
  model: string
  /** 产品主数据权威价（元） */
  product_price: number
  /** 条目文本中提取到的价格（元） */
  knowledge_prices: number[]
}

/** 主数据产品行最小面（crmDb.product；对账只读 model/name/unit_price） */
export interface PriceMasterProduct {
  id: number
  model?: string | null
  name?: string | null
  unit_price?: number | null
}

const PRICE_WAN_RE = /(\d+(?:\.\d+)?)\s*万/g
const PRICE_YEN_RE = /[¥￥]\s*(\d[\d,]*(?:\.\d+)?)/g
const PRICE_YUAN_RE = /(\d[\d,]*(?:\.\d+)?)\s*元/g

/**
 * 从知识文本提取价格声明（统一换算为元）：「12.8万」「¥128000」「12,800 元」三种口径。
 * 识别为价格必须带 万/¥/元 单位锚点，避免载重/吨位/续航数字误伤；纯函数，测试可直接断言。
 */
export function extractMentionedPrices(text: string): number[] {
  const s = String(text || '')
  const out: number[] = []
  const push = (raw: string, scale = 1) => {
    const n = Number(raw.replace(/,/g, ''))
    if (Number.isFinite(n) && n > 0) {
      const v = n * scale
      if (v >= 100 && v <= 100_000_000) out.push(v) // 廉价配件/亿元以上误识别排除
    }
  }
  for (const m of s.matchAll(PRICE_WAN_RE)) push(m[1], 10_000)
  for (const m of s.matchAll(PRICE_YEN_RE)) push(m[1])
  for (const m of s.matchAll(PRICE_YUAN_RE)) push(m[1])
  return [...new Set(out.map((v) => Math.round(v)))]
}

/** 文本是否提及该产品（model 精确子串 / name ≥2 字子串）；无主数据可提即视为未提及 */
export function productMentionedInText(text: string, p: PriceMasterProduct): boolean {
  const s = String(text || '')
  const model = String(p.model || '').trim()
  const name = String(p.name || '').trim()
  if (model && s.includes(model)) return true
  if (name.length >= 2 && s.includes(name)) return true
  return false
}

/**
 * 价格冲突对账（纯函数）：对文本提及的每个有权威价产品，若条目提取价中没有任何一个
 * 与主数据价相差 ≤1%（容差四舍五入/利率文案），判为冲突——产品主数据价格为最终权威。
 * 未提及产品 / 提及但无权威价 / 条目未声明价格 → 不判冲突（无据可对，诚实放行，人工审核兜底）。
 */
export function checkPriceConflicts(text: string, products: PriceMasterProduct[]): PriceConflictField[] {
  const prices = extractMentionedPrices(text)
  if (prices.length === 0) return []
  const conflicts: PriceConflictField[] = []
  for (const p of products) {
    const unit = Number(p.unit_price || 0)
    if (!productMentionedInText(text, p) || unit <= 0) continue
    const close = prices.some((v) => Math.abs(v - unit) / unit <= 0.01)
    if (!close) {
      conflicts.push({
        field: 'unit_price',
        product_id: Number(p.id),
        model: String(p.model || p.name || `#${p.id}`),
        product_price: unit,
        knowledge_prices: prices
      })
    }
  }
  return conflicts
}

// ─── 引用台账轨道（PRD 2.9 效果回流）────────────────────────────────────────

/** AI 消费知识的引用记账轨道：reply = 聊天回复建议，action = 行动建议/话术建议（ask 走 hermesAskService） */
export interface KnowledgeUsageTrack {
  source: 'reply' | 'action'
  sessionId?: string | null
}

/** 引用台账尽力而为（append-only 埋点，失败绝不影响 AI 主链路） */
function recordKnowledgeUsage(entries: KnowledgeEntry[], track: KnowledgeUsageTrack): void {
  for (const e of entries) {
    try {
      salesDbService.knowledgeUsageAdd({
        knowledge_id: Number(e.id || 0),
        logical_id: e.logical_id ?? null,
        version: e.version ?? 1,
        title: String(e.title || ''),
        session_id: track.sessionId ?? null,
        ask_key: null,
        source: track.source
      })
    } catch { /* 台账尽力而为 */ }
  }
}

/** 话术提炼候选条目（v2：分析+诊断+优化+多版本） */
export interface ExtractedScriptCandidate {
  index: number
  title: string
  /** 优化后的标准话术（主文本，导入知识库的 content） */
  content: string
  /** 销售原话（脱敏后，供对照） */
  original: string
  /** AI 分析诊断 */
  analysis: string
  scene: string
  tags: string[]
  /** 多版本话术 */
  versions: {
    normal: string
    professional: string
    closing: string
  }
  /** 与已有条目的重复标题（相似度 >60% 时填充） */
  duplicateOf?: string
}

// ─── 服务类 ──────────────────────────────────────────────────────────────────

class SalesKnowledgeService {

  /**
   * 列出知识条目（支持按分类/产品线/场景过滤）
   */
  list(filters?: { category?: string; product_line?: string; scene?: string; status?: string }): KbListResult {
    try {
      const entries = salesDbService.kbList(filters)
      return { success: true, entries, total: entries.length }
    } catch (e) {
      return { success: false, entries: [], total: 0 }
    }
  }

  /**
   * 获取单条知识
   */
  get(id: number): { success: boolean; entry?: KnowledgeEntry; error?: string } {
    try {
      const entry = salesDbService.kbGet(id)
      if (!entry) return { success: false, error: '条目不存在' }
      return { success: true, entry }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  /**
   * 新增知识条目（一律落 staging；ttl_date 随创建携带，PRD 2.3 治理列）
   */
  create(payload: KbCreatePayload): { success: boolean; entry?: KnowledgeEntry; error?: string } {
    try {
      if (!payload.title?.trim()) return { success: false, error: '标题不能为空' }
      if (!payload.content?.trim()) return { success: false, error: '内容不能为空' }
      if (!payload.category?.trim()) return { success: false, error: '分类不能为空' }

      const entry = salesDbService.kbCreate({
        category: payload.category,
        product_line: payload.product_line,
        title: payload.title.trim(),
        content: payload.content.trim(),
        tags: JSON.stringify(payload.tags ?? []),
        scene: payload.scene,
        ttl_date: payload.ttl_date?.trim() || null
      })
      return { success: true, entry }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  /**
   * 编辑知识条目（PRD 2.3 版本链编辑语义，状态分派在 salesDbService.kbUpdate 单点）：
   *  - staging：原地编辑；
   *  - published：fork 同链 version+1 的 staging 新版本（fork=true 返回新行），原版本发布中不动；
   *  - rejected / closed：只读沉底留档，拒绝编辑。
   */
  update(id: number, payload: KbUpdatePayload): { success: boolean; entry?: KnowledgeEntry; forked?: boolean; error?: string } {
    try {
      const before = salesDbService.kbGet(id)
      if (!before) return { success: false, error: '条目不存在' }

      const updates: Record<string, unknown> = {}
      if (payload.category !== undefined) updates.category = payload.category
      if (payload.product_line !== undefined) updates.product_line = payload.product_line
      if (payload.title !== undefined) updates.title = payload.title.trim()
      if (payload.content !== undefined) updates.content = payload.content.trim()
      if (payload.tags !== undefined) updates.tags = JSON.stringify(payload.tags)
      if (payload.scene !== undefined) updates.scene = payload.scene
      if (payload.ttl_date !== undefined) updates.ttl_date = payload.ttl_date?.trim() || null

      const entry = salesDbService.kbUpdate(id, updates)
      if (!entry) {
        return { success: false, error: `当前状态 ${before.status || 'staging'} 只读（rejected 拒因留档 / closed 历史版本，不允许编辑）` }
      }
      const forked = Number(entry.id) !== id
      return {
        success: true,
        entry,
        forked,
        error: undefined
      }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  /** 续期当前已发布版本：TTL 是治理元数据，就地更新，不产生内容版本。 */
  renewTtl(id: number, ttlDate: string): { success: boolean; entry?: KnowledgeEntry; error?: string } {
    const normalized = String(ttlDate || '').trim()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized) || normalized < todayIsoDate()) {
      return { success: false, error: 'TTL 续期日期必须是今天或之后的 YYYY-MM-DD' }
    }
    const result = salesDbService.kbRenewTtl(id, normalized)
    if (!result.ok) return { success: false, error: result.error }
    const reminder = salesDbService.pendingTaskBySource('knowledge_ttl', id)
    if (reminder?.id) salesDbService.todoUpdate(reminder.id, { status: 'done', completed_at: Date.now() })
    return { success: true, entry: result.entry }
  }

  /**
   * 删除知识条目（PRD 2.3 删除纪律 + 宪法 §1.12 审计）：
   * 仅从未审核的 staging 可删；published/rejected/closed 一律拒绝（kbDelete 最后防线守卫）。
   * 跨库铁律「先 crmDb 后 salesDb」：先写 audit_event（action=knowledge_delete，条目快照留证），
   * 审计失败则删除中止——未留证的物理删除绝不放行。
   */
  delete(id: number): { success: boolean; error?: string } {
    try {
      const entry = salesDbService.kbGet(id)
      if (!entry) return { success: false, error: '条目不存在' }
      // 守卫前置（与 kbDelete 最后防线同口径）：非未审核 staging 直接拒绝，不产生审计噪音
      if ((entry.status || 'staging') !== 'staging' || entry.reviewed_by) {
        return { success: false, error: salesDbService.kbDelete(id).error || '该条目不允许物理删除' }
      }

      // 跨库铁律「先 crmDb 后 salesDb」：审计先行——未留证的物理删除绝不放行（审计失败即删除中止）
      try {
        crmDbService.runTx((tx) => tx.run(
          'INSERT INTO audit_event (actor, action, entity_type, entity_id, detail, created_at) VALUES (?,?,?,?,?,?)',
          [currentActor(), 'knowledge_delete', 'knowledge', id,
            JSON.stringify({ title: entry.title, category: entry.category, source: entry.source ?? 'manual',
              logical_id: entry.logical_id ?? null, version: entry.version ?? 1 }), Date.now()]
        ))
      } catch (auditErr) {
        return { success: false, error: `删除审计（audit_event）写入失败，删除已中止：${String(auditErr)}` }
      }

      const r = salesDbService.kbDelete(id)
      if (!r.ok) return { success: false, error: r.error }
      return { success: true }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  /**
   * 刀 1 知识审核（待审核区「发布 / 拒绝」唯一入口）。
   * 状态机/拒因必填校验在 salesDbService.kbReview（服务层 + CHECK 双守卫）；
   * actor = 当前身份档案姓名（宪法 §1.12 署名口径），reviewed_by/reviewed_at 与
   * knowledge/accepted|rejected 埋点（刀 2 写点②）由 kbReview 同步落库。
   * 价格对账门（PRD 2.7/宪法 §3）：official 发布前与 crmDb product 主数据对账，冲突禁止 official
   * 并返回具体冲突字段（产品主数据价格为最终权威）；community 发布不作硬门但回带冲突提示。
   * 版本链发布语义（接替关闭旧版本）在 kbReview 状态机内闭环。
   */
  review(
    id: number,
    action: 'publish' | 'reject',
    payload?: { reason?: string; official?: boolean }
  ): { success: boolean; entry?: KnowledgeEntry; error?: string; conflictFields?: PriceConflictField[] } {
    try {
      if (action !== 'publish' && action !== 'reject') return { success: false, error: '非法审核动作' }

      let conflictFields: PriceConflictField[] | undefined
      if (action === 'publish') {
        const entry = salesDbService.kbGet(id)
        if (entry) {
          conflictFields = this.priceConflictsForEntry(entry)
          if (conflictFields.length > 0 && payload?.official) {
            return {
              success: false,
              error: '价格与产品主数据冲突（以产品库为准），禁止 official 发布：'
                + conflictFields.map((c) => `${c.model} 主数据价 ¥${c.product_price} vs 条目价 [${c.knowledge_prices.join('、')}]`).join('；'),
              conflictFields
            }
          }
        }
      }

      const r = salesDbService.kbReview(id, action, {
        reason: payload?.reason,
        reviewer: currentActor(),
        authority: payload?.official ? 'official' : 'community'
      })
      if (!r.ok) return { success: false, error: r.error }
      return { success: true, entry: r.entry, conflictFields }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  /**
   * 价格对账数据装配：条目文本价格 vs crmDb product 主数据。
   * crmDb 未初始化 / 读失败 → 返回空（无主数据可对，诚实放行，WARN 留痕）。
   */
  private priceConflictsForEntry(entry: KnowledgeEntry): PriceConflictField[] {
    try {
      const products = crmDbService.list('product', { limit: 5000 }) as unknown as Array<Record<string, unknown>>
      const text = `${entry.title || ''}\n${entry.content || ''}`
      return checkPriceConflicts(text, products.map((p) => ({
        id: Number(p.id),
        model: (p.model as string) ?? null,
        name: (p.name as string) ?? null,
        unit_price: (p.unit_price as number) ?? null
      })))
    } catch (e) {
      salesLog('WARN', `[SalesKnowledge] 价格对账跳过（主数据不可用）: ${String((e as Error)?.message || e)}`)
      return []
    }
  }

  /**
   * TTL 到期巡检（PRD 2.9：知识到期主动问负责人）：为已过期 published 条目生成待处理提醒卡
   * （follow_up_task/knowledge_ttl，散任务侧栏展示），不删除知识、不下架、不重复提醒（幂等：
   * 应用层 pendingTaskBySource 查重 + idx_ft_sla_once partial unique 兜底）。
   * 接入点：今日行动全量/懒扫描与卡流刷新（salesActionEngine），与 SLA 扫描同款模式。
   */
  scanTtlReminders(today?: string): { scanned: number; reminded: number } {
    try {
      const expired = salesDbService.kbExpiredEntries(today)
      let reminded = 0
      for (const entry of expired) {
        if (!entry.id) continue
        if (salesDbService.pendingTaskBySource('knowledge_ttl', entry.id)) continue
        try {
          salesDbService.todoCreate({
            trigger_type: 'knowledge_ttl',
            title: `知识到期：《${entry.title}》（v${entry.version ?? 1}）有效期至 ${entry.ttl_date} 已过期，请续期或安排修正版本`,
            session_id: null,
            display_name: null,
            source_id: entry.id,
            status: 'pending',
            priority_score: 60,
            created_by: 'knowledge_ttl_scan'
          })
          reminded++
        } catch { /* partial unique 兜底：已有 pending 提醒卡则跳过 */ }
      }
      return { scanned: expired.length, reminded }
    } catch (e) {
      salesLog('WARN', `[SalesKnowledge] TTL 巡检失败: ${String((e as Error)?.message || e)}`)
      return { scanned: 0, reminded: 0 }
    }
  }

  /** 知识引用统计透传（PRD 2.9 效果回流只读聚合；UI/测试消费） */
  usageStats(knowledgeId?: number) {
    return salesDbService.knowledgeUsageStats(knowledgeId)
  }

  /**
   * 刀 4 知识提案写入路（唯一入口）：问答无命中「生成知识提案」/ 知识页「补充知识」共用。
   * 落 knowledge_base staging 行（source='proposal'，治理铁律：先审后发布，AI 永不发布），
   * 审核走路径 = 刀 1 待审核区（kbReview 状态机，裁决埋点 knowledge/accepted|rejected 沿用不双记）。
   * 硬门（宪法 §1.10）：evidence_key 必填——空锚提案不进审核队列。
   * 成功落埋点 proposal/generated（entity_type=knowledge，entity_id=条目 id，刀 2 写点⑥）。
   */
  propose(payload: KbProposePayload): { success: boolean; entry?: KnowledgeEntry; error?: string } {
    try {
      if (!payload.title?.trim()) return { success: false, error: '提案标题不能为空' }
      if (!payload.content?.trim()) return { success: false, error: '提案内容不能为空' }
      const evidenceKey = String(payload.evidence_key || '').trim()
      if (!evidenceKey) return { success: false, error: '提案必须带证据锚点（客户原话 messageKey 或出处摘要）' }

      const entry = salesDbService.kbCreate({
        category: payload.category?.trim() || 'faq',
        title: payload.title.trim(),
        content: payload.content.trim(),
        tags: JSON.stringify(payload.tags ?? []),
        scene: payload.scene,
        source: 'proposal',
        evidence_key: evidenceKey
      })
      trackProposalEvent({
        event_type: 'proposal', stage: 'generated',
        entity_type: 'knowledge', entity_id: Number(entry.id),
        actor: currentActor()
      })
      return { success: true, entry }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  /**
   * 搜索知识条目（关键词匹配标题/内容/标签）
   */
  search(payload: KbSearchPayload): KbListResult {
    try {
      if (!payload.keyword?.trim()) {
        return this.list({ category: payload.category, product_line: payload.product_line })
      }
      const entries = salesDbService.kbSearch(payload.keyword.trim(), {
        category: payload.category,
        product_line: payload.product_line
      })
      return { success: true, entries, total: entries.length }
    } catch (e) {
      return { success: false, entries: [], total: 0 }
    }
  }

  /**
   * 为 AI 检索相关知识条目（中文友好的 n-gram 内存打分，零外部依赖）。
   * 数据源铁律：只经 salesDbService.kbValidEntries 唯一原语（published + TTL 未过期 + 每链当前版本），
   * 禁止直连无过滤 kbList/kbSearch。track 非空时对实际选中的条目记引用台账（PRD 2.9 效果回流）。
   */
  retrieveForPrompt(userMessage: string, maxEntries: number = 3, track?: KnowledgeUsageTrack): string {
    try {
      const msg = (userMessage || '').trim()
      if (!msg) return ''
      const all = salesDbService.kbValidEntries()
      if (all.length === 0) return ''

      // 停用字组合（避免"的是""了吗"等让所有条目都高分）
      const STOP = new Set(['的是','了是','是在','在我','的你','我的','你的','吗呢','呢吧','吧啊','和与','与或','不是','有了','这个','那个','什么','怎么','多少','可以','一下','一个','你们','我们','他们','么什','么怎','会能','能为'])
      const grams = new Set<string>()
      for (let i = 0; i < msg.length - 1; i++) {
        const g2 = msg.slice(i, i + 2)
        if (!STOP.has(g2)) grams.add('2:' + g2)
        if (i < msg.length - 2) grams.add('3:' + msg.slice(i, i + 3))
      }
      if (grams.size === 0) return ''

      const scored = all.map(e => {
        const hay = `${e.title || ''} ${e.content || ''} ${e.tags || ''}`
        let score = 0
        for (const g of grams) {
          const token = g.slice(2)
          if (g.startsWith('3:')) { if (hay.includes(token)) score += 3 }
          else if (hay.includes(token)) score += 1
        }
        // 标题被整句包含 → 强相关
        if (e.title && e.title.length >= 2 && msg.includes(e.title)) score += 100
        return { e, score }
      }).filter(x => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, maxEntries)

      if (scored.length === 0) return ''
      if (track) recordKnowledgeUsage(scored.map((s) => s.e), track)
      return scored.map((s, i) => `【参考${i + 1}】${s.e.title}\n${s.e.content}`).join('\n\n')
    } catch {
      return ''
    }
  }

  /**
   * 为 AI 构建知识库上下文（产品种类有限场景的最优策略，无需向量库）。
   * 数据源铁律：只经 salesDbService.kbValidEntries 唯一原语（小库全量注入 / 大库 n-gram 检索兜底）。
   * 引用台账口径（PRD 2.9）：检索路径选中的条目逐条记账；小库全量注入无法归因到单条，不计引用。
   */
  buildKnowledgeContext(
    userMessage: string,
    fullBudget: number = 2500,
    maxRetrieve: number = 3,
    track?: KnowledgeUsageTrack
  ): string {
    try {
      const all = salesDbService.kbValidEntries()
      if (all.length === 0) return ''
      const fullText = all
        .map(e => `- [${e.category}${e.product_line ? '/' + e.product_line : ''}] ${e.title}：${e.content}`)
        .join('\n')
      if (fullText.length <= fullBudget) return fullText
      return this.retrieveForPrompt(userMessage, maxRetrieve, track)
    } catch {
      return ''
    }
  }

  /**
   * 从真实聊天记录提炼销售话术，返回候选条目供用户审核后入库。
   *
   * @param sessionId 微信会话 ID
   * @param config AI 配置（由 IPC handler 注入）
   * @param maxMessages 最多取最近 N 条消息，默认 100
   */
  async extractScriptsFromChat(
    sessionId: string,
    config: ConfigService,
    maxMessages: number = 100,
    beginDate?: string,  // ISO date "2025-01-01"
    endDate?: string     // ISO date "2025-09-30"
  ): Promise<{ success: boolean; candidates?: ExtractedScriptCandidate[]; error?: string }> {
    try {
      if (!isAiConfigured(config)) {
        return { success: false, error: 'AI 模型未配置' }
      }

      // 计算日期区间秒级时间戳
      const beginSec = beginDate ? Math.floor(new Date(beginDate + 'T00:00:00+08:00').getTime() / 1000) : 0
      const endSec = endDate ? Math.floor(new Date(endDate + 'T23:59:59+08:00').getTime() / 1000) : 0

      // 有日期区间时取更多消息（最多 300 条），再按时间过滤
      const fetchLimit = (beginDate || endDate) ? 300 : maxMessages

      // 1. 读取聊天记录
      const msgResult = await wcdbService.getMessages(sessionId, fetchLimit, 0)
      if (!msgResult?.success || !msgResult.messages?.length) {
        return { success: false, error: '无法读取该联系人的聊天记录' }
      }

      let messages = msgResult.messages

      // 日期区间过滤
      if (beginSec > 0 || endSec > 0) {
        messages = messages.filter((m: any) => {
          const ts = m.create_time || m.createTime || 0
          if (!ts) return false
          if (beginSec > 0 && ts < beginSec) return false
          if (endSec > 0 && ts > endSec) return false
          return true
        })
        salesLog('INFO', `[ExtractScripts] ${sessionId}: date filter ${beginDate || '*'}-${endDate || '*'}: ${msgResult.messages.length}→${messages.length}`)
      }

      if (messages.length < 10) {
        return { success: false, error: '聊天记录不足 10 条，无法提炼话术' }
      }

      // 拼接对话文本（脱敏前保留原始内容给用户对照）
      const myWxid = config.getMyWxidCleaned()
      let selfCount = 0

      const conversationLines = messages.map((m: any) => {
        // WCDB 原生字段: snake_case — is_send, create_time, message_content, sender_username, real_sender_id
        const ts = m.create_time || m.createTime || 0
        const timeStr = ts ? new Date(ts * 1000).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '?'
        const content = (m.message_content || m.content || m.msg || '').slice(0, 300)
        // is_send 是 WCDB 原生字段: "0"=收到, "1"=发送
        const isSelf =
          m.is_send === '1' || m.is_send === 1 || m.computed_is_send === '1' ||
          (myWxid && (
            m.sender_username === myWxid ||
            m.real_sender_id === myWxid
          ))
        if (isSelf) selfCount++
        const speaker = isSelf ? '我' : '客户'
        return `[${timeStr}] ${speaker}: ${content}`
      }).join('\n')
      salesLog('INFO', `[ExtractScripts] ${sessionId}: ${messages.length} msgs, myWxid=${myWxid || '(empty)'}, selfCount=${selfCount}`)

      // 2. AI 分析+诊断+优化
      const systemPrompt = `你是一名拥有10年以上工业品（叉车/仓储设备）销售经验的销售培训专家。你的任务不是简单复制销售人员的话，而是：

1. 找出销售人员（标注为"我"）在真实聊天中具有销售价值的表达
2. 判断当前表达的问题（是否建立信任？突出价值？推动成交？）
3. 保留真实销售意图和产品事实，优化成更专业、更容易成交的话术
4. 生成 3 个版本：普通版（日常客户）、专业版（老板/采购）、逼单版（犹豫客户）
5. 把优化后的话术整理为可复用的销售模板

严格规则：
- 不虚构产品参数（型号/吨位/电池/价格等必须来自原文，未提及的写"未提及"）
- 不夸大承诺
- 保留原始价格信息
- 金额→{金额}，人名→{客户名}，公司名→{公司名}，日期→{日期}，手机号→{手机号}
- 场景分类：初次接触/需求确认/产品介绍/报价/价格异议/竞品比较/成交推进/售后维护
- 如果对话中没有值得优化的销售话术，返回空数组 []（合法输出，不要硬编）

必须返回 JSON：
{"scripts":[{
  "title":"简短标题(≤15字)",
  "scene":"销售场景",
  "original":"销售原话（脱敏后）",
  "analysis":"诊断：优点/缺点/缺失什么（2-3句）",
  "optimized":"优化后标准话术",
  "versions":{
    "normal":"普通版",
    "professional":"专业版",
    "closing":"逼单版"
  },
  "tags":["标签1","标签2"]
}]}`

      const userPrompt = `分析以下微信聊天记录，将销售人员的表达优化成标准话术：\n\n${conversationLines}\n\n请返回 JSON。如果确实没有值得优化的销售话术，返回 {"scripts": []}。`

      const aiText = await simpleCompletion(config, systemPrompt, userPrompt, {
        temperature: 0.3,
        maxTokens: 2000,
        responseFormatJson: true,
        disableThinking: true,
        timeoutMs: 30_000
      })

      // 3. 解析 AI 输出
      let parsed: any
      try {
        parsed = JSON.parse(aiText || '{}')
      } catch {
        const jsonMatch = (aiText || '').match(/\{[\s\S]*\}/)
        parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {}
      }

      const rawScripts: any[] = parsed?.scripts || []
      if (!Array.isArray(rawScripts) || rawScripts.length === 0) {
        salesLog('INFO', `[ExtractScripts] ${sessionId}: AI returned 0 scripts. Raw response preview: ${(aiText || '').slice(0, 200)}`)
        return { success: true, candidates: [] }
      }

      // 4. n-gram 去重检测（仅比对同 scene 分类下的已有条目）
      const existingAll = salesDbService.kbList()
      const candidates: ExtractedScriptCandidate[] = rawScripts.map((s: any, idx: number) => {
        const scene = s.scene || '其他'
        const optimized = s.optimized || s.content || ''
        const sceneEntries = existingAll.filter(e => (e.scene || '其他') === scene)

        let maxSim = 0
        let similarTitle = ''
        const candGrams = buildGrams(optimized.slice(0, 100))
        for (const existing of sceneEntries) {
          const existGrams = buildGrams((existing.content || '').slice(0, 100))
          if (candGrams.size === 0 || existGrams.size === 0) continue
          let hits = 0
          for (const g of candGrams) { if (existGrams.has(g)) hits++ }
          const sim = hits / candGrams.size
          if (sim > maxSim) { maxSim = sim; similarTitle = existing.title }
        }

        return {
          index: idx,
          title: (s.title || '未命名话术').slice(0, 30),
          content: optimized,
          original: s.original || '',
          analysis: s.analysis || '',
          scene,
          tags: Array.isArray(s.tags) ? s.tags.slice(0, 5) : [],
          versions: {
            normal: s.versions?.normal || '',
            professional: s.versions?.professional || '',
            closing: s.versions?.closing || ''
          },
          duplicateOf: maxSim > 0.6 ? similarTitle : undefined
        }
      })

      return { success: true, candidates }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  /**
   * 从 CSV 内容批量导入知识库条目（PRD v2 P1）。
   * CSV 格式：category,product_line,title,content,tags,scene
   * 第一行为表头，自动跳过。支持带 BOM 的 UTF-8。
   */
  importFromCsv(csvContent: string): { success: boolean; imported: number; skipped: number; error?: string } {
    try {
      // 去除 BOM
      const clean = csvContent.replace(/^\uFEFF/, '').trim()
      if (!clean) return { success: false, imported: 0, skipped: 0, error: 'CSV 内容为空' }

      const lines = clean.split(/\r?\n/)
      if (lines.length < 2) return { success: false, imported: 0, skipped: 0, error: 'CSV 至少需要表头+1行数据' }

      // 解析表头
      const header = this.parseCsvLine(lines[0])
      const colMap: Record<string, number> = {}
      header.forEach((h, i) => { colMap[h.trim().toLowerCase()] = i })

      // 必须有 title 和 content 列
      if (colMap['title'] === undefined || colMap['content'] === undefined) {
        return { success: false, imported: 0, skipped: 0, error: 'CSV 必须包含 title 和 content 列' }
      }

      let imported = 0
      let skipped = 0

      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim()
        if (!line) { skipped++; continue }

        const cols = this.parseCsvLine(line)
        const title = (cols[colMap['title']] || '').trim()
        const contentVal = (cols[colMap['content']] || '').trim()

        if (!title || !contentVal) { skipped++; continue }

        const category = (cols[colMap['category']] || 'product').trim() || 'product'
        const productLine = colMap['product_line'] !== undefined ? (cols[colMap['product_line']] || '').trim() : ''
        const tags = colMap['tags'] !== undefined ? (cols[colMap['tags']] || '').trim() : ''
        const scene = colMap['scene'] !== undefined ? (cols[colMap['scene']] || '').trim() : ''

        // 去重：同 title 不重复导入
        const existing = salesDbService.kbList()
        if (existing.some(e => e.title === title)) { skipped++; continue }

        salesDbService.kbCreate({
          category,
          product_line: productLine || null,
          title,
          content: contentVal,
          tags: tags ? JSON.stringify(tags.split(/[,，]/).map(t => t.trim()).filter(Boolean)) : '[]',
          scene: scene || null
        })
        imported++
      }

      return { success: true, imported, skipped }
    } catch (e) {
      return { success: false, imported: 0, skipped: 0, error: String(e) }
    }
  }

  /**
   * 解析 CSV 行（支持引号内逗号）
   */
  private parseCsvLine(line: string): string[] {
    const result: string[] = []
    let current = ''
    let inQuotes = false

    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"'
          i++
        } else {
          inQuotes = !inQuotes
        }
      } else if (ch === ',' && !inQuotes) {
        result.push(current)
        current = ''
      } else {
        current += ch
      }
    }
    result.push(current)
    return result
  }
}

// ─── 辅助函数 ─────────────────────────────────────────────────────────────────

/** 构建 2/3-gram 集合，用于去重相似度比对 */
function buildGrams(text: string): Set<string> {
  const grams = new Set<string>()
  for (let i = 0; i < text.length - 1; i++) {
    grams.add(text.slice(i, i + 2))
    if (i < text.length - 2) grams.add(text.slice(i, i + 3))
  }
  return grams
}

export const salesKnowledgeService = new SalesKnowledgeService()
