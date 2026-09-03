/**
 * FunnelCylinder —— A048 立体圆柱漏斗（2026-09-03 用户拍板风格，行动/销售两漏斗页共用）
 *
 * 每段 = SVG 圆柱体（椭圆顶面高光 + 竖向渐变柱身 + 底部弧线）+ HTML 文字层；
 * 段间 = 下行箭头 + 转化率标注（A048 链路感）。
 * 宽度纯装饰固定比例收窄（P0-4.4 规格：跳级/转化率>100% 不改变形状，不与数值绑定）。
 * 色板单一真源 shared/funnelPalette（红线 3）；柱面字面白文字属彩色面豁免（DESIGN-SPEC-MINI §颜色）。
 */
import { ChevronDown, Info } from 'lucide-react'
import { FUNNEL_STAGE_COLORS, FUNNEL_STAGE_GRADIENT_LIGHT } from '../../shared/funnelPalette'
import './FunnelCylinder.scss'

export interface FunnelCylinderStage {
  key: string
  name: string
  /** 段内主数字（含单位已由调用方格式化，如「71 人」） */
  countText: string
  /** 段间转化率标注（显示在该段上方空隙，如「转化 62.5%」）；第一段忽略；null/undefined 显示 N/A */
  gapText?: string | null
  /** 色板档位（默认按段序取；销售漏斗成交段取第 5 档藏青强调用 SALES_STAGE_COLOR_INDEX） */
  colorIndex?: number
  /** 口径说明（段名旁 Info 徽标，hover/focus 出 tooltip） */
  hint?: string
}

interface FunnelCylinderProps {
  stages: FunnelCylinderStage[]
  /** 每段宽度百分比（固定比例收窄，纯装饰） */
  widths: readonly number[]
  onStageClick?: (key: string) => void
}

export default function FunnelCylinder({ stages, widths, onStageClick }: FunnelCylinderProps) {
  const colorOf = (s: FunnelCylinderStage, i: number) => {
    const idx = (s.colorIndex ?? i) % FUNNEL_STAGE_COLORS.length
    return { deep: FUNNEL_STAGE_COLORS[idx], light: FUNNEL_STAGE_GRADIENT_LIGHT[idx] }
  }
  return (
    <div className="fc">
      {stages.map((s, i) => {
        const { deep, light } = colorOf(s, i)
        return (
          <div className="fc__row" key={s.key}>
            {i > 0 && (
              <div className="fc__gap">
                <ChevronDown size={14} />
                <span>{s.gapText ?? 'N/A'}</span>
              </div>
            )}
            <div className="fc__wrap" style={{ width: `${widths[i] ?? widths[widths.length - 1]}%` }}>
              <button
                className="fc__layer"
                onClick={onStageClick ? () => onStageClick(s.key) : undefined}
                disabled={!onStageClick}
              >
                {/* 圆柱体：顶面椭圆（白色高光）+ 柱身（竖向渐变 + 底部前弧）；stroke 同色 round join 柔化边缘 */}
                <svg className="fc__bg" viewBox="0 0 100 44" preserveAspectRatio="none" aria-hidden="true">
                  <defs>
                    <linearGradient id={`fc-g-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={light} />
                      <stop offset="100%" stopColor={deep} />
                    </linearGradient>
                  </defs>
                  <path
                    d="M 0 8 L 100 8 L 100 36 A 50 8 0 0 1 0 36 Z"
                    fill={`url(#fc-g-${s.key})`}
                    stroke={`url(#fc-g-${s.key})`}
                    strokeWidth="3"
                    strokeLinejoin="round"
                  />
                  <ellipse cx="50" cy="8" rx="50" ry="8" fill="rgba(255, 255, 255, .3)" />
                </svg>
                <span className="fc__content">
                  <span className="fc__name">
                    {s.name}
                    {s.hint && (
                      <span className="fc__hint" tabIndex={0} aria-label="口径说明">
                        <Info size={11} />
                        <span className="fc__hint-tip">{s.hint}</span>
                      </span>
                    )}
                  </span>
                  <span className="fc__count">{s.countText}</span>
                </span>
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}
