/**
 * hermesAskService.ts —— 刀 3 带引用知识问答（设计-Hermes-MVP 刀 3，PRD 2.1 第一件）
 *
 * 流程：问题 → 关键词 2/3-gram 提取 → kbValidEntries（AI 有效知识读取唯一原语，SQL 级三重过滤：
 * 只查 published + TTL 未过期 + 每个 logical_id 只出当前有效版本——staging/rejected/closed/过期
 * 条目永不出检索口）→ n-gram 命中打分取 top3 →
 * 条目正文过 maskPrivateText（宪法 §2.6 脱敏前置，未脱敏原文不出本机）→
 * callChatCompletion（temperature 0.2，单一固定 system prompt，差异放 user prompt）→
 * 答案 + 结构化引用（《title》（vN），保留 id/logical_id/version/title，前端渲染可点击跳知识库条目）
 * + 引用台账（knowledge_usage/ask，PRD 2.9 效果回流：同问同条目去重计 1）。
 *
 * 铁律：
 *  - 检索只经 AI 有效读取原语 kbValidEntries（published/TTL/版本三重 SQL 级过滤，hermes-ask-test 静态断言锚点）
 *  - 送 LLM 的条目正文先过 maskPrivateText（buildAskUserPrompt 是唯一 prompt 出口）
 *  - 无命中 / 未配置模型 / 模型空返回不记 generated 埋点（漏斗诚实，不出答案不入账）
 *  - 不自动发送给客户：本服务只产答案文本，无任何发送通道（AI 碰不到发送键）
 *  - 未配置模型整链静默提示「先配置模型」，不抛错
 */
import { callChatCompletion, getAiModelConfig, isAiConfigured } from './ai/aiApiClient'
import type { ConfigService } from './config'
import { salesDbService, type KnowledgeEntry } from './salesDbService'
import { maskPrivateText } from './crmSla2Service'
import { trackProposalEvent, trackKnowledgeAskViewed } from './proposalEventTracking'
import { salesLog } from './salesLogger'

/** 送入 LLM 的最大命中条数（引用随条目数走） */
export const ASK_MAX_ENTRIES = 3
/** 设计稿刀 3.3 固定温度 */
export const ASK_TEMPERATURE = 0.2

/** 单一固定 system prompt（铁律：差异全放 user prompt，API 缓存命中率） */
export const ASK_SYSTEM_PROMPT =
  '你是工业设备（叉车/仓储设备）销售的知识库问答助手。只依据【知识库参考】中的内容回答问题；' +
  '参考内容里没有的信息必须回答「知识库里暂时没有这条信息」，绝不编造参数、价格与数字。' +
  '回答用中文，简洁直接，不超过 200 字。'

/** 引用条目（结构化下发，前端渲染「引用自：《title》（vN）」可点击跳知识库；
 *  引用四要素 id/logical_id/version/title 齐备——logical_id 是跨版本稳定锚点，供回查版本链） */
export interface AskCitation {
  id: number
  logical_id: string
  title: string
  version: number
}

export type HermesAskStatus = 'empty' | 'not_configured' | 'no_hit' | 'answer' | 'error'

export interface HermesAskResult {
  status: HermesAskStatus
  question: string
  /** 问题摘要哈希（proposal_event knowledge_ask entity_id 口径，宪法 §3 登记行） */
  askKey: string
  /** 命中且送入 LLM 的条目（no_hit/未配置为空；answer 时 = 引用集） */
  entries: AskCitation[]
  /** LLM 组答案正文（不含引用行——引用由前端按 citations 结构化渲染，防模型编造引用） */
  answer?: string
  citations?: AskCitation[]
  error?: string
}

/** 停用字组合（同 salesKnowledgeService.retrieveForPrompt 口径，防「的是/怎么」类全表高分） */
const STOP_2 = new Set([
  '的是', '了是', '是在', '在我', '的你', '我的', '你的', '吗呢', '呢吧', '吧啊', '和与', '与或',
  '不是', '有了', '这个', '那个', '什么', '怎么', '多少', '可以', '一下', '一个', '你们', '我们',
  '他们', '么什', '么怎', '会能', '能为', '多少', '哪里', '哪几'
])

/**
 * 问题 → LIKE 关键词（2/3-gram，短问题整句入列；纯函数，hermes-ask-test 可单测）。
 */
export function extractKeywords(question: string): string[] {
  const msg = String(question || '').trim()
  if (!msg) return []
  const grams = new Set<string>()
  for (let i = 0; i < msg.length - 1; i++) {
    const g2 = msg.slice(i, i + 2)
    if (!STOP_2.has(g2)) grams.add(g2)
    if (i < msg.length - 2) grams.add(msg.slice(i, i + 3))
  }
  if (msg.length <= 12) grams.add(msg)
  return [...grams].slice(0, 12)
}

/**
 * 问题摘要哈希（djb2，确定性；同问同 key —— viewed 去重与埋点 entity_id 依据）。
 */
export function askKeyOf(question: string): string {
  const s = String(question || '').trim()
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return 'ask' + h.toString(16).padStart(8, '0')
}

/** 命中打分：关键词命中数（3-gram 权重高）+ 标题被整句包含强加权（retrieveForPrompt 同思路） */
function rankEntries(question: string, candidates: KnowledgeEntry[]): KnowledgeEntry[] {
  const kws = extractKeywords(question)
  return candidates
    .map((e) => {
      const hay = `${e.title || ''} ${e.content || ''} ${e.tags || ''}`
      let score = 0
      for (const kw of kws) if (hay.includes(kw)) score += kw.length >= 3 ? 2 : 1
      if (e.title && e.title.length >= 2 && question.includes(e.title)) score += 50
      return { e, score }
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || (Number(b.e.updated_at) || 0) - (Number(a.e.updated_at) || 0))
    .slice(0, ASK_MAX_ENTRIES)
    .map((s) => s.e)
}

/**
 * 组答案 user prompt（唯一 prompt 出口；条目正文必须已在调用前过 maskPrivateText——
 * 本函数不再处理脱敏，测试断言「脱敏前置」以此为准：入参即视为送 LLM 的最终文本）。
 */
export function buildAskUserPrompt(
  question: string,
  maskedEntries: Array<{ title: string; content: string; version?: number }>
): string {
  const refs = maskedEntries
    .map((e, i) => `【参考${i + 1}】《${e.title}》（v${e.version ?? 1}）\n${e.content}`)
    .join('\n\n')
  return `【客户问题】\n${question}\n\n【知识库参考】\n${refs}\n\n只依据上面的【知识库参考】回答【客户问题】；参考中没有的信息回答「知识库里暂时没有这条信息」。`
}

function defaultCompletion(config?: ConfigService): (system: string, user: string) => Promise<string> {
  return (system, user) => {
    const mc = getAiModelConfig(config as ConfigService)
    return callChatCompletion(
      mc,
      [{ role: 'system', content: system }, { role: 'user', content: user }],
      { temperature: ASK_TEMPERATURE }
    )
  }
}

/**
 * 问知识库主链路。status：
 *  - empty：问题为空
 *  - not_configured：模型未配置（整链静默提示「先配置模型」，不检索不调用不埋点）
 *  - no_hit：published 条目零命中（前端显示「知识库里没有答案」+ 生成知识提案按钮）
 *  - answer：出答案（记 knowledge/generated 埋点）
 *  - error：检索有命中但组答案失败（不记 generated——没出答案）
 */
export async function askKnowledge(
  input: { question: string },
  opts?: {
    config?: ConfigService
    /** 测试注入：覆盖 isAiConfigured（缺省按 config 判定） */
    configured?: boolean
    /** 测试注入：替换 callChatCompletion（缺省按 getAiModelConfig(config) 出口） */
    completion?: (system: string, user: string) => Promise<string>
  }
): Promise<HermesAskResult> {
  const question = String(input?.question || '').trim()
  const askKey = askKeyOf(question)
  if (!question) return { status: 'empty', question: '', askKey, entries: [] }

  const configured = opts?.configured ?? (opts?.config ? isAiConfigured(opts.config) : false)
  if (!configured) {
    return { status: 'not_configured', question, askKey, entries: [] }
  }

  const top = rankEntries(question, salesDbService.kbValidEntries({ keywords: extractKeywords(question) }))
  if (top.length === 0) {
    return { status: 'no_hit', question, askKey, entries: [] }
  }

  const citations: AskCitation[] = top.map((e) => ({
    id: Number(e.id),
    logical_id: String(e.logical_id || ''),
    title: e.title,
    version: e.version ?? 1
  }))
  try {
    // 脱敏前置（宪法 §2.6）：送 LLM 的条目正文强制过 maskPrivateText（未脱敏原文不出本机）
    const masked = top.map((e) => ({ title: e.title, content: maskPrivateText(String(e.content || '')), version: e.version ?? 1 }))
    const run = opts?.completion ?? defaultCompletion(opts?.config)
    const answer = String(await run(ASK_SYSTEM_PROMPT, buildAskUserPrompt(question, masked)) || '').trim()
    if (!answer) {
      return { status: 'error', question, askKey, entries: citations, error: '模型返回为空' }
    }
    // 埋点 generated（出答案，刀 3.5 复用刀 2 表）：无命中/未配置/空返回不记
    trackProposalEvent({ event_type: 'knowledge', stage: 'generated', entity_type: 'knowledge_ask', entity_id: askKey, actor: 'system:hermes-ask' })
    // 引用台账（PRD 2.9 效果回流）：引用次数/引用时间/关联客户阶段统计的数据源；
    // 同 (条目, askKey) 幂等去重，尽力而为不阻断答案
    for (const e of top) {
      try {
        salesDbService.knowledgeUsageAdd({
          knowledge_id: Number(e.id),
          logical_id: e.logical_id ?? null,
          version: e.version ?? 1,
          title: String(e.title || ''),
          ask_key: askKey,
          source: 'ask'
        })
      } catch { /* 台账尽力而为 */ }
    }
    return { status: 'answer', question, askKey, entries: citations, answer, citations }
  } catch (e) {
    salesLog('WARN', `[HermesAsk] 组答案失败: ${(e as Error).message}`)
    return { status: 'error', question, askKey, entries: citations, error: String((e as Error).message || e) }
  }
}

/**
 * 问答 viewed 埋点入口（用户展开答案卡时前端调用；同 askKey 只记一次）。
 */
export function markAskViewed(input: { question?: string; askKey?: string }): { ok: boolean } {
  const key = String(input?.askKey || '').trim() || askKeyOf(String(input?.question || ''))
  if (key === 'ask00000000') return { ok: false }
  trackKnowledgeAskViewed(key)
  return { ok: true }
}

// 服务命名空间出口（IPC 层调用形态与其他 service 一致）
export const hermesAskService = { askKnowledge, markAskViewed }
