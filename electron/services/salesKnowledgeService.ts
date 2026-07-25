/**
 * salesKnowledgeService.ts
 *
 * 话术/产品知识库业务服务。
 * 提供知识库条目的增删改查、搜索，以及为 AI 回复建议提供知识检索能力。
 */

import { salesDbService, type KnowledgeEntry } from './salesDbService'

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
}

export interface KbUpdatePayload {
  category?: string
  product_line?: string
  title?: string
  content?: string
  tags?: string[]
  scene?: string
}

export interface KbSearchPayload {
  keyword: string
  category?: string
  product_line?: string
}

// ─── 服务类 ──────────────────────────────────────────────────────────────────

class SalesKnowledgeService {

  /**
   * 列出知识条目（支持按分类/产品线/场景过滤）
   */
  list(filters?: { category?: string; product_line?: string; scene?: string }): KbListResult {
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
   * 新增知识条目
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
        scene: payload.scene
      })
      return { success: true, entry }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  /**
   * 更新知识条目
   */
  update(id: number, payload: KbUpdatePayload): { success: boolean; entry?: KnowledgeEntry; error?: string } {
    try {
      const updates: Record<string, unknown> = {}
      if (payload.category !== undefined) updates.category = payload.category
      if (payload.product_line !== undefined) updates.product_line = payload.product_line
      if (payload.title !== undefined) updates.title = payload.title.trim()
      if (payload.content !== undefined) updates.content = payload.content.trim()
      if (payload.tags !== undefined) updates.tags = JSON.stringify(payload.tags)
      if (payload.scene !== undefined) updates.scene = payload.scene

      const entry = salesDbService.kbUpdate(id, updates)
      if (!entry) return { success: false, error: '条目不存在' }
      return { success: true, entry }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  /**
   * 删除知识条目
   */
  delete(id: number): { success: boolean; error?: string } {
    try {
      const deleted = salesDbService.kbDelete(id)
      if (!deleted) return { success: false, error: '条目不存在' }
      return { success: true }
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
   * 一次拉全表，在内存里用 2/3-gram 命中数打分，过滤停用字组合，避免整句 LIKE 匹配失败。
   */
  retrieveForPrompt(userMessage: string, maxEntries: number = 3): string {
    try {
      const msg = (userMessage || '').trim()
      if (!msg) return ''
      const all = salesDbService.kbList()
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
      return scored.map((s, i) => `【参考${i + 1}】${s.e.title}\n${s.e.content}`).join('\n\n')
    } catch {
      return ''
    }
  }

  /**
   * 为 AI 构建知识库上下文（产品种类有限场景的最优策略，无需向量库）。
   * 知识量小（全量文本在预算内）→ 全量喂入，让模型自行挑选相关条目，零检索误差；
   * 知识量大（超预算）→ 退回 n-gram 检索兜底。
   */
  buildKnowledgeContext(userMessage: string, fullBudget: number = 2500, maxRetrieve: number = 3): string {
    try {
      const all = salesDbService.kbList()
      if (all.length === 0) return ''
      const fullText = all
        .map(e => `- [${e.category}${e.product_line ? '/' + e.product_line : ''}] ${e.title}：${e.content}`)
        .join('\n')
      if (fullText.length <= fullBudget) return fullText
      return this.retrieveForPrompt(userMessage, maxRetrieve)
    } catch {
      return ''
    }
  }
}

export const salesKnowledgeService = new SalesKnowledgeService()
