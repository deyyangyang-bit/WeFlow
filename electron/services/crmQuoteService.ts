/**
 * crmQuoteService.ts
 * AI 报价辅助：从私聊需求 → 提取产品型号/数量 → 产品库选型 → 生成报价单草稿。
 * 流程：拉最近聊天 → AI 结构化提取 → 产品库模糊匹配 → crmDbService.createQuotation。
 */
import { simpleCompletion, isAiConfigured } from './ai/aiApiClient'
import { chatService } from './chatService'
import { crmDbService, type CrmRow } from './crmDbService'
import { salesLog } from './salesLogger'
import type { ConfigService } from './config'

interface ExtractedNeed {
  models: Array<{ keyword: string; qty: number }>
  budget?: string
  deliveryNote?: string
}

const EXTRACT_PROMPT = `你是 B2B 工业设备（叉车/搬运设备）销售助手。从客户聊天记录中提取采购需求。
只输出 JSON：{"models":[{"keyword":"产品关键词或型号","qty":数量}],"budget":"预算(没有就空串)","deliveryNote":"交期/备注(没有就空串)"}
- keyword 用客户原话中的型号/称呼（如"2吨电动叉车""CDD12""堆高车"）
- 没有明确数量时 qty=1
- 提取不到任何产品需求时输出 {"models":[],"budget":"","deliveryNote":""}`

function parseExtractResult(text: string): ExtractedNeed | null {
  try {
    const m = String(text || '').match(/\{[\s\S]*\}/)
    if (!m) return null
    const o = JSON.parse(m[0]) as { models?: Array<{ keyword?: string; qty?: number }>; budget?: string; deliveryNote?: string }
    const models = (o.models || [])
      .filter((x) => x && typeof x.keyword === 'string' && x.keyword.trim())
      .map((x) => ({ keyword: x.keyword!.trim().slice(0, 40), qty: Math.max(1, Math.floor(Number(x.qty) || 1)) }))
    if (models.length === 0) return null
    return { models, budget: String(o.budget || ''), deliveryNote: String(o.deliveryNote || '') }
  } catch { return null }
}

/** 产品库模糊匹配：keyword 命中 name/model/sku/specs 返回最佳产品 */
function matchProduct(keyword: string, products: CrmRow[]): CrmRow | null {
  const kw = keyword.toLowerCase()
  const hits = products.filter((p) => {
    const hay = `${p.name || ''} ${p.model || ''} ${p.sku || ''} ${p.spec || ''} ${p.subcategory || ''}`.toLowerCase()
    // 双向包含：keyword 在产品里，或产品型号在 keyword 里（如 "2吨叉车" 含型号片段）
    return hay.includes(kw) || kw.includes(String(p.model || '').toLowerCase())
  })
  if (hits.length === 0) return null
  // 优先命中 model 精确的
  return hits.sort((a, b) => {
    const am = String(a.model || '')
    const bm = String(b.model || '')
    const amExact = kw.includes(am.toLowerCase()) ? 1 : 0
    const bmExact = kw.includes(bm.toLowerCase()) ? 1 : 0
    return bmExact - amExact
  })[0]
}

/**
 * AI 报价辅助：给客户生成报价单草稿（挂到该客户最近可挂款合同）。
 * @returns { ok, quotationId?, contractId?, reason?, matched? }
 */
export async function aiGenerateQuotation(
  sessionId: string,
  displayName: string,
  config: ConfigService
): Promise<{ ok: boolean; quotationId?: number; contractId?: number; reason?: string; matched?: Array<{ keyword: string; productName: string }> }> {
  if (!sessionId) return { ok: false, reason: '会话无效' }
  if (!isAiConfigured(config)) return { ok: false, reason: 'AI 未配置' }
  try {
    const msgs = await chatService.getLatestMessages(sessionId, 40)
    const texts = (msgs?.messages || [])
      .map((m: any) => String(m.parsedContent || m.content || '').trim())
      .filter((t: string) => t && t.length > 2)
      .slice(-20)
    if (texts.length === 0) return { ok: false, reason: '无聊天记录' }

    const out = await simpleCompletion(config, EXTRACT_PROMPT, `客户：${displayName}\n聊天记录：\n${texts.join('\n')}`, { responseFormatJson: true, temperature: 0.2, maxTokens: 300 })
    const need = parseExtractResult(out)
    if (!need) return { ok: false, reason: '未提取到产品需求' }

    const products = crmDbService.list('product', { limit: 500 })
    const matched: Array<{ keyword: string; productName: string }> = []
    const items: Array<{ product_id: number; qty: number }> = []
    for (const md of need.models) {
      const p = matchProduct(md.keyword, products)
      if (p) {
        items.push({ product_id: Number(p.id), qty: md.qty })
        matched.push({ keyword: md.keyword, productName: String(p.name || p.model || '') })
      }
    }
    if (items.length === 0) return { ok: false, reason: `产品库未匹配到：${need.models.map((x) => x.keyword).join('、')}` }

    // 客户 account → 最近可挂款合同（无则建）
    let accountId = 0
    const accRows = crmDbService.all('SELECT id FROM account WHERE session_id = ? LIMIT 1', [sessionId])
    if (accRows.length) accountId = Number(accRows[0].id)
    else {
      const imp = crmDbService.importCustomerFromProfile({ name: displayName, sessionId, stage: 'quoted', reason: 'AI 报价辅助' })
      accountId = imp.id
    }
    if (!accountId) return { ok: false, reason: '客户未入库' }
    const contract = crmDbService.activeContractForAccount(accountId)
    let contractId = contract ? Number(contract.id) : 0
    if (!contractId) {
      const dc = crmDbService.createDealContract(accountId, `AI 报价辅助（${displayName}）`)
      if (dc.contractId) contractId = dc.contractId
    }
    if (!contractId) return { ok: false, reason: '合同创建失败' }

    const q = crmDbService.createQuotation({ contract_id: contractId, items })
    if (!q.ok || !q.id) return { ok: false, reason: q.reason || '报价单创建失败' }
    salesLog('INFO', `[CrmQuote] ${displayName} AI 报价生成：${matched.length} 项 → 报价单 ${q.id}`)
    return { ok: true, quotationId: q.id, contractId, matched }
  } catch (e) {
    salesLog('WARN', `[CrmQuote] 报价生成失败 ${displayName}: ${e}`)
    return { ok: false, reason: String(e) }
  }
}
