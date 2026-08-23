/**
 * intentScore.ts —— 客户意向评分 0-100（P0）
 * 从客户阶段 + 意向事件累计加权计算综合分（PRD §9/§25）：
 *   阶段基础分 → 近期意向活跃加分 → 久未跟进衰减 → 商机进展加分
 * 每项带 依据（label/delta/reason），前端可展开看「为什么 AI 这么判断」。
 * 纯函数，零 electron 依赖（对齐 crmEnrichCore 风格），便于单测。
 * P0-2A.1：STAGE_BASE 键改 canonical + 输入过 normalizeStage（修复分类器英文 stage 基础分恒 0）。
 */
import { normalizeStage, stageLabel } from '../../shared/salesStage'
export interface ScoreFactor {
  label: string
  delta: number
  reason: string
}
export interface IntentScore {
  score: number
  level: '高意向' | '中意向' | '低意向' | '未知'
  factors: ScoreFactor[]
}

// 阶段基础分（canonical 键：new/contacted/quoted/negotiating/won/lost/unknown）
// P0-2A.1：旧中文键（了解/比价/决策/成交/流失）经输入 normalizeStage 归一，dormant 是活动状态非销售阶段，不参与基础分
const STAGE_BASE: Record<string, number> = {
  new: 0, contacted: 30, quoted: 60, negotiating: 80, won: 100, lost: 5, unknown: 0
}
// 意向活跃窗口：近 N 天内有意向标记视为活跃
const ACTIVE_WINDOW_MS = 7 * 86400_000
// 久未跟进衰减起点：超过 N 天无新意向开始扣分
const DECAY_AFTER_DAYS = 14
const DAY_MS = 86400_000

export function computeIntentScore(input: {
  stage: string
  lastContactAt: number // 0 = 未知
  recentEventCount: number // 近 7 天意向标记次数
  lastEventAt: number // 最近一次意向标记时间（0 = 无）
  oppCount: number // 活跃商机数
  oppQuantity: number // 商机数量合计
  oppAmount: number // 商机金额合计
}): IntentScore {
  const now = Date.now()
  const factors: ScoreFactor[] = []

  // 1. 阶段基础分（输入先归一：classifier 写英文 canonical、AI 见解/手动纠正写中文，统一走 shared 映射）
  const canonical = normalizeStage(input.stage)
  const base = STAGE_BASE[canonical] ?? 0
  if (base > 0) factors.push({ label: '当前阶段', delta: base, reason: `客户阶段：${stageLabel(canonical)}` })
  let score = base

  // 2. 近期意向活跃加分（近 7 天，单次 6 分，封顶 20）
  if (input.recentEventCount > 0) {
    const boost = Math.min(20, input.recentEventCount * 6)
    factors.push({ label: '近期意向', delta: boost, reason: `近 7 天 ${input.recentEventCount} 次意向标记` })
    score += boost
  }

  // 3. 久未跟进衰减：最后意向时间（优先）或最后联系时间
  const lastAt = input.lastEventAt > 0 ? input.lastEventAt : input.lastContactAt
  if (lastAt > 0) {
    const days = Math.floor((now - lastAt) / DAY_MS)
    if (days >= DECAY_AFTER_DAYS) {
      const dec = Math.min(30, (days - DECAY_AFTER_DAYS) * 2)
      factors.push({ label: '久未跟进', delta: -dec, reason: `${days} 天无新意向` })
      score -= dec
    }
  }

  // 4. 商机进展加分：有活跃商机 + 数量 + 金额
  if (input.oppCount > 0) {
    const details: string[] = []
    if (input.oppQuantity > 0) details.push(`数量 ${input.oppQuantity}`)
    if (input.oppAmount > 0) details.push(`金额 ¥${input.oppAmount.toLocaleString()}`)
    const add = 10 + (details.length > 0 ? 5 : 0)
    factors.push({ label: '商机进展', delta: add, reason: details.length ? `${input.oppCount} 个活跃商机（${details.join('、')}）` : '已有活跃商机' })
    score += add
  }

  // 5. 封顶 0-100 + 等级
  const final = Math.max(0, Math.min(100, Math.round(score)))
  const level: IntentScore['level'] = final >= 70 ? '高意向' : final >= 40 ? '中意向' : final >= 15 ? '低意向' : '未知'
  return { score: final, level, factors }
}

// 活跃窗口导出供测试断言
export { ACTIVE_WINDOW_MS }
