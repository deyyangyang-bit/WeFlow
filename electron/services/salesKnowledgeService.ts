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
   * 为 AI 回复建议检索相关知识条目。
   * 根据用户消息关键词匹配，返回最相关的条目内容（拼接为文本）。
   */
  retrieveForPrompt(userMessage: string, maxEntries: number = 3): string {
    try {
      // 提取关键词（简单分词：按空格和标点拆分，取 2 字以上的词）
      const keywords = userMessage
        .replace(/[？?！!。，,、\s]+/g, ' ')
        .split(' ')
        .filter(w => w.length >= 2)
        .slice(0, 5)

      if (keywords.length === 0) return ''

      const allResults: KnowledgeEntry[] = []
      const seenIds = new Set<number>()

      for (const kw of keywords) {
        const results = salesDbService.kbSearch(kw)
        for (const r of results) {
          if (!seenIds.has(r.id!)) {
            seenIds.add(r.id!)
            allResults.push(r)
          }
        }
        if (allResults.length >= maxEntries * 2) break
      }

      // 取前 N 条
      const topEntries = allResults.slice(0, maxEntries)
      if (topEntries.length === 0) return ''

      // 拼接为 prompt 可用的文本
      return topEntries.map((e, i) =>
        `【参考${i + 1}】${e.title}\n${e.content}`
      ).join('\n\n')
    } catch {
      return ''
    }
  }
}

export const salesKnowledgeService = new SalesKnowledgeService()
