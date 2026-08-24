/**
 * SalesFunnelPage.tsx —— 销售漏斗：历史累计流转漏斗 + 逐级转化率 + 当前客户状态
 *
 * 口径：窗口内「曾进入过某档位」的去重客户数（同一客户同一档位只计 1 次，绝不按
 * intent_tag_log 行数统计）。时间窗口可切换（近30天/近90天/全部）。
 */
import { FUNNEL_STAGE_COLORS, FUNNEL_STAGE_GRADIENT_LIGHT, FUNNEL_NEUTRAL, FUNNEL_NEUTRAL_LIGHT, SALES_STAGE_COLOR_INDEX } from '../../shared/funnelPalette'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { RefreshCw } from 'lucide-react'
import ReactECharts from 'echarts-for-react'
import * as echarts from 'echarts'
import './SalesFunnelPage.scss'

interface FunnelStats {
  funnel: Array<{ stage: string; count: number }>
  conversion: Array<{ from: string; to: string; rate: number }>
  intentTimeline: Array<{ date: string; stage: string; count: number }>
  currentDistribution: Array<{ stage: string; count: number }>
  totalCustomers: number
  newCustomersInWindow: number
}

const STAGE_ORDER = ['了解', '比价', '决策', '成交'] as const
// 阶段色：浅蓝→深蓝渐变（进行中档位），成交藏青强调，流失中性灰——与行动漏斗同一视觉体系（P0-4.4）
// 色板单一真源：shared/funnelPalette（与行动漏斗同族 Apple 蓝；页面不硬编码品牌色）
const STAGE_COLORS: Record<string, string> = {
  ...Object.fromEntries(Object.entries(SALES_STAGE_COLOR_INDEX).map(([k, i]) => [k, FUNNEL_STAGE_COLORS[i]])),
  流失: FUNNEL_NEUTRAL, 未知: FUNNEL_NEUTRAL_LIGHT
}
// 梯形固定比例收窄（P0-4.4 修复版）：宽度纯装饰不绑数值——客户可跳级/转化率>100% 时形状不变（决策 14→成交 28 不再"突然变宽"）
const STAGE_WIDTHS = [100, 85, 70, 55] as const
// 每段渐变浅端（与行动漏斗统一色板；深端 = STAGE_COLORS 基准色，左上→右下极轻微加深）
const STAGE_GRADIENT_LIGHT = FUNNEL_STAGE_GRADIENT_LIGHT
const DAY_OPTIONS = [
  { label: '近7天', value: 7 },
  { label: '近30天', value: 30 },
  { label: '近90天', value: 90 },
  { label: '全部', value: 0 }
] as const

export default function SalesFunnelPage() {
  const navigate = useNavigate()
  const [days, setDays] = useState(30)
  const [data, setData] = useState<FunnelStats | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const fetch = useCallback(async (d: number) => {
    setLoading(true)
    try {
      const r = await window.electronAPI.sales.funnelStats(d)
      if (r.success && r.data) setData(r.data)
      else setError(r.error || '加载失败')
    } catch (e) { setError(String(e)) }
    setLoading(false)
  }, [])

  useEffect(() => { void fetch(days) }, [days, fetch])

  // 转化率：后端相邻相除（了解→比价→决策→成交）
  const rateOf = useCallback((from: string, to: string) =>
    data?.conversion.find((c) => c.from === from && c.to === to)?.rate ?? 0, [data])

  // ECharts 漏斗（4 档，sort:'none' 按顺序排布；宽度 = 固定比例 STAGE_WIDTHS，不随人数变化——修复跳级变宽）
  // 每档：段名 + 人数（大字，取 data.real）+ 相邻转化率（小字浅色）；selectedMode 提供点击态视觉反馈
  const funnelOption = useMemo(() => {
    if (!data) return null
    const funnel = data.funnel.filter((f) => (STAGE_ORDER as readonly string[]).includes(f.stage))
    if (!funnel.length) return null
    return {
      tooltip: {
        trigger: 'item' as const,
        formatter: (p: { name?: string; data?: { real?: number } }) =>
          `${p?.name ?? ''}: ${p?.data?.real ?? 0} 人`
      },
      series: [{
        type: 'funnel', left: '12%', right: '12%', top: 12, bottom: 12,
        // minSize 0：宽度 = value/max × 100% 严格等于 STAGE_WIDTHS 固定比例（14% 会让比例偏移）
        minSize: 0, maxSize: '100%', sort: 'none' as const, gap: 2,
        label: {
          show: true, position: 'inside' as const, fontSize: 16, color: '#fff', lineHeight: 20,
          rich: {
            // 转化率小字：缩小 + 白色 70% 透明度，与主数字（16px 纯白）形成明显主次
            sub: { fontSize: 10, color: 'rgba(255,255,255,.7)' }
          },
          formatter: (p: { name?: string; data?: { real?: number } }) => {
            const i = Math.max(0, (STAGE_ORDER as readonly string[]).indexOf(String(p?.name ?? '')))
            const rate = i === 0 ? 100 : rateOf(STAGE_ORDER[i - 1], STAGE_ORDER[i])
            return `${p?.name ?? ''}  ${p?.data?.real ?? 0} 人\n{sub|转化 ${rate}%}`
          }
        },
        itemStyle: { borderWidth: 0, borderColor: '#fff' },
        emphasis: {
          label: { fontSize: 14 },
          itemStyle: { borderWidth: 2, borderColor: '#fff', shadowBlur: 10, shadowColor: 'rgba(15, 23, 42, .2)' }
        },
        selectedMode: 'single',
        select: { itemStyle: { borderWidth: 2, borderColor: '#fff', shadowBlur: 10, shadowColor: 'rgba(30, 58, 138, .35)' } },
        data: funnel.map((n, idx) => ({
          name: n.stage, value: STAGE_WIDTHS[idx] ?? 0, real: n.count,
          itemStyle: {
            // 极细微渐变（左上→右下轻微加深，与行动漏斗同一色板）+ 小圆角柔和边缘
            color: new echarts.graphic.LinearGradient(0, 0, 1, 1, [
              { offset: 0, color: STAGE_GRADIENT_LIGHT[idx] ?? STAGE_COLORS[n.stage] },
              { offset: 1, color: STAGE_COLORS[n.stage] }
            ]),
            borderRadius: 2
          }
        }))
      }]
    }
  }, [data, rateOf])
  const funnelEvents = useMemo(() => ({
    click: (p: { name?: string }) => {
      const stage = String(p?.name || '')
      if (stage) navigate(`/customers?stage=${encodeURIComponent(stage)}`)
    }
  }), [navigate])

  // 趋势：窗口内每天进入各档位的去重客户数（按档位堆叠柱状）
  const trendOption = useMemo(() => {
    if (!data || !data.intentTimeline.length) return null
    const dates = Array.from(new Set(data.intentTimeline.map((t) => t.date)))
    const series = (STAGE_ORDER as readonly string[]).map((stage) => ({
      name: stage,
      type: 'bar' as const,
      stack: 'total',
      barMaxWidth: 18,
      itemStyle: { color: STAGE_COLORS[stage], borderRadius: [0, 0, 0, 0] },
      data: dates.map((d) => data.intentTimeline.find((t) => t.date === d && t.stage === stage)?.count ?? 0)
    }))
    return {
      tooltip: { trigger: 'axis' as const, axisPointer: { type: 'shadow' as const } },
      legend: { data: [...STAGE_ORDER], top: 0, textStyle: { fontSize: 11 } },
      grid: { left: 40, right: 12, top: 32, bottom: 40 },
      xAxis: { type: 'category' as const, data: dates, axisLabel: { fontSize: 10, formatter: (v: string) => v.slice(5) } },
      yAxis: { type: 'value' as const, axisLabel: { fontSize: 10 }, minInterval: 1 },
      series
    }
  }, [data])

  // 当前状态卡片（customer_profile 当前阶段，后端已归一化归桶）
  const currentOf = (s: string) =>
    data?.currentDistribution.find((c) => c.stage === s)?.count ?? 0

  return (
    <div className="funnel-page">
      <div className="funnel-header">
        <h2>销售漏斗</h2>
        <span className="funnel-header__sub">客户当前所处销售阶段分布</span>
        <div className="funnel-days">
          {DAY_OPTIONS.map((o) => (
            <button
              key={o.value}
              className={`funnel-days__btn${days === o.value ? ' funnel-days__btn--active' : ''}`}
              onClick={() => setDays(o.value)}
            >{o.label}</button>
          ))}
        </div>
        <button className="funnel-btn" onClick={() => void fetch(days)} disabled={loading}><RefreshCw size={14} /> 刷新</button>
      </div>
      {error && <div className="funnel-error">{error}</div>}
      {loading && <div className="funnel-empty">加载中…</div>}

      {data && (
        <div className="funnel-body">
          <div className="funnel-stats">
            <div className="funnel-stat"><span className="funnel-stat__value">{data.totalCustomers}</span><span className="funnel-stat__label">客户总数</span></div>
            <div className="funnel-stat"><span className="funnel-stat__value">{data.newCustomersInWindow}</span><span className="funnel-stat__label">窗口新进漏斗</span></div>
            <div className="funnel-stat"><span className="funnel-stat__value">{currentOf('成交')}</span><span className="funnel-stat__label">当前成交</span></div>
            <div className="funnel-stat"><span className="funnel-stat__value">{currentOf('决策')}</span><span className="funnel-stat__label">当前决策</span></div>
            <div className="funnel-stat"><span className="funnel-stat__value">{currentOf('流失')}</span><span className="funnel-stat__label">当前流失</span></div>
          </div>

          {funnelOption ? (
            <div className="funnel-chart">
              <ReactECharts option={funnelOption} style={{ height: 300 }} notMerge onEvents={funnelEvents} />
              <div className="funnel-drill-hint">点击漏斗任一阶段 → 下钻 CRM 客户列表（当前阶段为该档位的客户）</div>
            </div>
          ) : (
            <div className="funnel-empty">当前窗口暂无阶段数据</div>
          )}
          <div className="funnel-footnote">
            历史累计流转口径：{days === 0 ? '全部历史' : `近 ${days} 天`}内曾进入各档位的去重客户数（同一客户只计 1 次）· 转化率为相邻档位相除，客户可跳级进入故非严格递减 · 当前状态小卡为 customer_profile 现时快照
          </div>

          <div className="funnel-current">
            <h3>当前客户状态（快照）</h3>
            <div className="funnel-current__cards">
              {data.currentDistribution.map((c) => (
                <button
                  key={c.stage}
                  className="funnel-current__card"
                  style={{ borderTopColor: STAGE_COLORS[c.stage] }}
                  onClick={() => navigate(`/customers?stage=${encodeURIComponent(c.stage)}`)}
                >
                  <span className="funnel-current__value">{c.count}</span>
                  <span className="funnel-current__label">{c.stage}</span>
                </button>
              ))}
            </div>
          </div>

          {trendOption && (
            <div className="funnel-trend">
              <h3>窗口内每天进入各档位的去重客户数（堆叠）</h3>
              <div className="funnel-trend__chart">
                <ReactECharts option={trendOption} style={{ height: 220 }} notMerge />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
