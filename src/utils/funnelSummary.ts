/**
 * 漏斗页「人话摘要」计算（设计稿 docs/UI设计稿-四页简化.html 屏 2）
 * 纯函数零依赖：从现有 funnelStats 返回结构（funnel/conversion，SalesFunnelPage 同一口径）
 * 取窗口内转化率最低的相邻段，生成一句结论。不新造口径、不用 LLM。
 */

export interface FunnelSummaryInput {
  funnel: Array<{ stage: string; count: number }>
  conversion: Array<{ from: string; to: string; rate: number }>
}

export interface FunnelSummary {
  windowLabel: string
  fromStage: string
  toStage: string
  fromCount: number
  toCount: number
  /** 完整一句话（与页面分段渲染同一文案） */
  text: string
}

export function buildFunnelSummary(data: FunnelSummaryInput | null | undefined, days: number): FunnelSummary | null {
  if (!data || !Array.isArray(data.conversion) || data.conversion.length === 0) return null
  const countOf = (stage: string) => data.funnel.find((f) => f.stage === stage)?.count ?? 0
  // 只有「from 档真的有人」的段才可判「掉」（from=0 时该段无意义，跳过）
  const segs = data.conversion.filter((c) => countOf(c.from) > 0)
  if (segs.length === 0) return null
  // 转化率最低的一段（并列取先出现者）
  const worst = segs.reduce((min, c) => (c.rate < min.rate ? c : min), segs[0])
  const fromCount = countOf(worst.from)
  const toCount = countOf(worst.to)
  const windowLabel = days > 0 ? `近 ${days} 天` : '全部历史'
  const text = `${windowLabel}：${worst.from} → ${worst.to} 掉得最多（${fromCount} 个${worst.from}只 ${toCount} 个进了${worst.to}）。重点看「${worst.from}」阶段的客户是不是没人跟。`
  return { windowLabel, fromStage: worst.from, toStage: worst.to, fromCount, toCount, text }
}
