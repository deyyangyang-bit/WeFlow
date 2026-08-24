/**
 * 漏斗图表色板单一真源（2026-08-24 UI 美化地基）。
 * 销售漏斗 / 行动漏斗共用同一套 Apple 蓝渐变体系（P0-4.4 视觉基准的系统化收口，非重新设计）。
 * 红线：页面不得各自硬编码漏斗色；将来若需跟随主题 accent，只改本文件。
 * 与 --color-accent 默认值 #0071E3 同族。
 */

/** 五段深端基准色（浅蓝→藏青；行动漏斗按序 0-4，销售漏斗经 SALES_STAGE_COLOR_INDEX 取档） */
export const FUNNEL_STAGE_COLORS = ['#5CA8F0', '#2E86E8', '#0071E3', '#0059BE', '#00459B'] as const

/** 每段渐变浅端（左上→右下极轻微加深到深端基准色） */
export const FUNNEL_STAGE_GRADIENT_LIGHT = ['#85BDF7', '#5A9DED', '#2E86E8', '#0059BE', '#003678'] as const

/** 销售漏斗阶段 → 色板档位（成交取第 5 档藏青强调） */
export const SALES_STAGE_COLOR_INDEX: Record<string, number> = {
  了解: 0, 比价: 1, 决策: 2, 成交: 4
}

/** 中性档：流失 / 未知（= CSS --color-chart-neutral，图表层独立导出供 svg/echarts 使用） */
export const FUNNEL_NEUTRAL = '#94A3B8'
export const FUNNEL_NEUTRAL_LIGHT = '#CBD5E1'

/** 销售漏斗按阶段名取色（未知阶段回退中性） */
export function salesStageColor(stage: string): string {
  const i = SALES_STAGE_COLOR_INDEX[stage]
  return i === undefined ? FUNNEL_NEUTRAL : FUNNEL_STAGE_COLORS[i]
}
