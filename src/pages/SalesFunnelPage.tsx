/**
 * SalesFunnelPage.tsx —— 销售漏斗：历史累计流转漏斗 + 逐级转化率 + 当前客户状态
 *
 * 口径：窗口内「曾进入过某档位」的去重客户数（同一客户同一档位只计 1 次，绝不按
 * intent_tag_log 行数统计）。时间窗口可切换（近30天/近90天/全部）。
 */
import { FUNNEL_STAGE_COLORS, FUNNEL_NEUTRAL, FUNNEL_NEUTRAL_LIGHT, SALES_STAGE_COLOR_INDEX } from '../../shared/funnelPalette'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useWxidRefresh } from '../utils/useWxidRefresh'
import { buildFunnelSummary } from '../utils/funnelSummary'
import { useNavigate } from 'react-router-dom'
import { RefreshCw } from 'lucide-react'
import ReactECharts from 'echarts-for-react'
import FunnelCylinder from '../components/FunnelCylinder'
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
  // 「详细趋势」堆叠图收进折叠区（设计稿屏 2：默认收起，图表只折叠不删除）
  const [trendOpen, setTrendOpen] = useState(false)

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
  // 切微信号 = 换库（§2.40）：账号切换后按当前时间窗重查
  useWxidRefresh(() => { void fetch(days) })

  // 转化率：后端相邻相除（了解→比价→决策→成交）
  const rateOf = useCallback((from: string, to: string) =>
    data?.conversion.find((c) => c.from === from && c.to === to)?.rate ?? 0, [data])

  // 立体圆柱漏斗数据（A048 风格，2026-09-03 拍板；宽度固定比例纯装饰，段间标注 = 相邻转化率）
  const cylinderStages = useMemo(() => {
    if (!data) return null
    const funnel = data.funnel.filter((f) => (STAGE_ORDER as readonly string[]).includes(f.stage))
    if (!funnel.length) return null
    return funnel.map((n, idx) => ({
      key: n.stage,
      name: n.stage,
      countText: `${n.count} 人`,
      colorIndex: SALES_STAGE_COLOR_INDEX[n.stage] ?? idx,
      gapText: idx === 0 ? null : `转化 ${rateOf(funnel[idx - 1].stage, n.stage)}%`
    }))
  }, [data, rateOf])

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

  // 人话摘要（设计稿屏 2）：窗口内转化率最低的相邻段，纯函数规则计算，数据与漏斗同口径
  const summary = useMemo(() => buildFunnelSummary(data, days), [data, days])

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
          {/* 人话结论置顶（设计稿屏 2）：哪段掉得最多，先给一句 */}
          {summary && (
            <div className="funnel-verdict">
              {summary.windowLabel}：<b>{summary.fromStage} → {summary.toStage}</b> 掉得最多（{summary.fromCount} 个{summary.fromStage}只 {summary.toCount} 个进了{summary.toStage}）。重点看「{summary.fromStage}」阶段的客户是不是没人跟。
            </div>
          )}
          <div className="funnel-stats">
            <div className="funnel-stat"><span className="funnel-stat__label">客户总数</span><span className="funnel-stat__value">{data.totalCustomers}</span></div>
            <div className="funnel-stat"><span className="funnel-stat__label">窗口新进漏斗</span><span className="funnel-stat__value">{data.newCustomersInWindow}</span></div>
            <div className="funnel-stat"><span className="funnel-stat__label">当前成交</span><span className="funnel-stat__value">{currentOf('成交')}</span></div>
            <div className="funnel-stat"><span className="funnel-stat__label">当前决策</span><span className="funnel-stat__value">{currentOf('决策')}</span></div>
            <div className="funnel-stat"><span className="funnel-stat__label">当前流失</span><span className="funnel-stat__value">{currentOf('流失')}</span></div>
          </div>

          {cylinderStages ? (
            <div className="funnel-chart">
              <FunnelCylinder
                stages={cylinderStages}
                widths={STAGE_WIDTHS}
                onStageClick={(k) => navigate(`/customers?stage=${encodeURIComponent(k)}`)}
              />
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

          {/* 堆叠图收进折叠区（设计稿屏 2：默认收起；图表只折叠不删除，展开后原样渲染） */}
          <button className="funnel-fold" onClick={() => setTrendOpen((v) => !v)}>
            <span>📈 详细趋势（每天进入各档位的客户数）</span>
            <span>{trendOpen ? '收起 ▲' : '展开 ▼'}</span>
          </button>
          {trendOpen && trendOption && (
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
