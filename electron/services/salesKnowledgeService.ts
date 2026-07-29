/**
 * salesKnowledgeService.ts
 *
 * 话术/产品知识库业务服务。
 * 提供知识库条目的增删改查、搜索，以及为 AI 回复建议提供知识检索能力。
 */

import { salesDbService, type KnowledgeEntry } from './salesDbService'
import { wcdbService } from './wcdbService'
import { simpleCompletion, isAiConfigured } from './ai/aiApiClient'
import type { ConfigService } from './config'

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

/** 话术提炼候选条目 */
export interface ExtractedScriptCandidate {
  index: number
  title: string
  content: string
  scene: string
  tags: string[]
  /** 与已有条目的重复标题（相似度 >60% 时填充） */
  duplicateOf?: string
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
    maxMessages: number = 100
  ): Promise<{ success: boolean; candidates?: ExtractedScriptCandidate[]; error?: string }> {
    try {
      if (!isAiConfigured(config)) {
        return { success: false, error: 'AI 模型未配置' }
      }

      // 1. 读取聊天记录
      const msgResult = await wcdbService.getMessages(sessionId, maxMessages, 0)
      if (!msgResult?.success || !msgResult.messages?.length) {
        return { success: false, error: '无法读取该联系人的聊天记录' }
      }

      const messages = msgResult.messages
      if (messages.length < 10) {
        return { success: false, error: '聊天记录不足 10 条，无法提炼话术' }
      }

      // 拼接对话文本（脱敏前保留原始内容给用户对照）
      const myWxid = config.getMyWxidCleaned()
      let selfCount = 0
      const conversationLines = messages.map((m: any) => {
        const ts = m.createTime || m.create_time || m.msg_time || 0
        const timeStr = ts ? new Date(ts * 1000).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '?'
        const content = (m.content || m.msg || '').slice(0, 300)
        // 用 talker 字段比对当前用户 wxid 判断说话人（WCDB 原始消息无 isSelf 字段）
        const talker = m.talker || m.senderUsername || ''
        const isSelf = myWxid ? talker === myWxid : false
        if (isSelf) selfCount++
        const speaker = isSelf ? '我' : '客户'
        return `[${timeStr}] ${speaker}: ${content}`
      }).join('\n')
      salesLog('INFO', `[ExtractScripts] ${sessionId}: ${messages.length} msgs, myWxid=${myWxid || '(empty)'}, selfCount=${selfCount}`)

      // 2. AI 提炼
      const systemPrompt = `你是销售话术提炼助手。从微信聊天记录中识别销售人员（标注为"我"）的有效话术，提取为可复用的知识库条目。

规则：
- 只提取销售人员（"我"）的发言，不提取客户的话
- 只提取有复用价值的：产品介绍、报价话术、异议处理、逼单技巧、售后服务话术
- 金额→{金额}，人名→{客户名}，公司名→{公司名}，日期→{日期}，手机号→{手机号}
- 场景归类：初次接触 / 报价 / 异议处理 / 售后 / 其他
- 如果对话中没有值得提炼的销售话术，返回空数组 []（这是合法输出，不要硬编）

必须返回 JSON：{"scripts":[{"title":"简短标题(≤15字)","content":"脱敏后的话术内容","scene":"场景","tags":["标签1","标签2"]}]}`

      const userPrompt = `从以下微信聊天记录中提炼可复用的销售话术：\n\n${conversationLines}\n\n请返回 JSON。如果确实没有值得提炼的话术，返回 {"scripts": []}。`

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
        const sceneEntries = existingAll.filter(e => (e.scene || '其他') === scene)

        // 简单 n-gram 相似度：2-gram 命中率
        let maxSim = 0
        let similarTitle = ''
        const candGrams = buildGrams((s.content || '').slice(0, 100))
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
          content: s.content || '',
          scene,
          tags: Array.isArray(s.tags) ? s.tags.slice(0, 5) : [],
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
