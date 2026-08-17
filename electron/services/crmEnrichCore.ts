/**
 * crmEnrichCore.ts
 * 客户信息自动填充纯核心：提取 prompt + AI 输出解析 + 本地校验。
 * 零 electron 依赖，可直接被 tsx 脚本单测（架构同 crmDocGenCore）。
 */
import { ENRICH_FIELDS } from './crmDbService'

export const ENRICH_PROMPT = `你是 B2B 工业设备（叉车/仓储搬运设备）销售客户信息提取器。
从给定的聊天材料中提取客户信息，只输出 JSON，不要输出其他内容。

输出 schema（提取不到的字段一律输出 null，禁止推测编造）：
{
  "company": "客户公司/单位全称",
  "position": "客户职位/角色（如采购经理/老板/个体户）",
  "phone": "客户手机号/座机号（材料中明确出现的）",
  "province": "省份",
  "city": "城市",
  "industry": "客户所在行业（如包装制品/模具制造/物流仓储）",
  "needs": "设备需求描述（1-2句：要什么设备/用途/数量）",
  "budget": "预算信息（原话或数额）",
  "intent_model": "意向型号（如 3吨内燃叉车/CPD20 电动叉车，可多个用顿号分隔）",
  "purchase_timeframe": "采购时间计划（如 下月/年底/急用）",
  "competitor": "客户提到的竞品品牌",
  "price_sensitive": "价格敏感度：high/mid/low（有明确砍价比价=high，只问价格=mid，无价格话题=low）",
  "confidence": { "字段名": 0到1的置信度 },
  "evidence": { "字段名": "材料中的原话依据（不超过40字）" }
}

规则：
- 只提取材料中明确出现或可直接推出的信息；模糊、暗示、猜测一律 null
- phone 必须是完整号码，不允许拼接或补全
- confidence 诚实给：原话明确=0.9+，需要一步推断=0.7-0.85，勉强推断=0.5-0.7
- evidence 必须是材料原话摘录，不允许改写杜撰`

// ─── 本地校验（通过则置信加成，同 crmParseRules 风格）────────────────────────
const PHONE_RE = /^(?:1[3-9]\d{9}|0\d{2,3}-?\d{7,8})$/

/** 纯函数：字段值本地校验+置信加成。返回 null 表示校验失败应丢弃 */
export function validateAndBoost(field: string, value: string, confidence: number): { value: string; confidence: number } | null {
  const v = String(value || '').trim()
  if (!v) return null
  if (field === 'phone') {
    const digits = v.replace(/[\s-]/g, '')
    if (!PHONE_RE.test(digits)) return null
    return { value: digits, confidence: Math.min(1, confidence + 0.1) }
  }
  if (field === 'price_sensitive') {
    const norm = v.toLowerCase()
    if (!['high', 'mid', 'low'].includes(norm)) return null
    return { value: norm, confidence }
  }
  return { value: v.slice(0, 500), confidence: Math.max(0, Math.min(1, confidence)) }
}

export interface CoreEnrichIncomingField { value: string; confidence: number; evidence?: string }

/** 解析 AI 提取输出：仅保留 ENRICH_FIELDS 内的字段，逐个本地校验，非法值丢弃 */
export function parseEnrichResult(text: string): Record<string, CoreEnrichIncomingField> | null {
  try {
    const m = String(text || '').match(/\{[\s\S]*\}/)
    if (!m) return null
    const o = JSON.parse(m[0]) as Record<string, any>
    const conf = (o.confidence && typeof o.confidence === 'object' ? o.confidence : {}) as Record<string, unknown>
    const evi = (o.evidence && typeof o.evidence === 'object' ? o.evidence : {}) as Record<string, unknown>
    const out: Record<string, CoreEnrichIncomingField> = {}
    for (const field of ENRICH_FIELDS) {
      const raw = o[field]
      if (raw === null || raw === undefined || raw === '') continue
      const value = String(raw).trim()
      if (!value || value === 'null' || value === '无' || value === '未知') continue
      let confidence = Number(conf[field])
      if (!Number.isFinite(confidence)) confidence = 0.6
      const validated = validateAndBoost(field, value, confidence)
      if (!validated) continue
      const evidence = String(evi[field] || '').slice(0, 80)
      out[field] = { value: validated.value, confidence: validated.confidence, evidence: evidence || undefined }
    }
    return Object.keys(out).length ? out : null
  } catch { return null }
}
