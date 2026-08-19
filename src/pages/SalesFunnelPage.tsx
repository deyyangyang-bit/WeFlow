/**
 * SalesFunnelPage.tsx —— 销售漏斗：阶段分布 + 转化率 + 近 30 天意向标记趋势
 */
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { RefreshCw } from 'lucide-react'
import ReactECharts from 'echarts-for-react'
import './SalesFunnelPage.scss'

// 漏斗阶段 → CRM 客户列表阶段筛选（下钻深链）
const FUNNEL_TO_CRM_LABEL: Record<string, string> = {
  了解: '已沟通', 比价: '已报价', 决策: '谈判中', 成交: '已成交'
}

interface FunnelData {
  stageDistribution: Array<{ stage: string; count: number }>
  intentTimeline: Array<{ date: string; count: number }>
  totalCustomers: number
}

// 阶段归一化：中文（AI 见解）与英文（分类器）统一到漏斗 5 档
const STAGE_NORM: Record<string, string> = {
  了解: '了解', contacted: '了解', new: '了解',
  比价: '比价', quoted: '比价',
  决策: '决策', negotiating: '决策',
  成交: '成交', won: '成交',
  流失: '流失', lost: '流失', dormant: '流失',
  未知: '未知', unknown: '未知'
}
const STAGE_ORDER = ['了解', '比价', '决策', '成交'] as const
const STAGE_COLORS: Record<string, string> = {
  了解: '#60a5fa', 比价: '#f59e0b', 决策: '#ef4444', 成交: '#16a34a', 流失: '#94a3b8', 未知: '#cbd5e1'
}

export default function SalesFunnelPage() {
  const navigate = useNavigate()
  const [data, setData] = useState<FunnelData | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const fetch = async () => {
    setLoading(true)
    try {
      const r = await window.electronAPI.sales.funnelStats()
      if (r.success && r.data) setData(r.data)
      else setError(r.error || '加载失败')
    } catch (e) { setError(String(e)) }
    setLoading(false)
  }

  useEffect(() => { void fetch() }, [])

  const normalized = useMemo(() => {
    if (!data) return null
    const counts = new Map<string, number>()
    for (const row of data.stageDistribution) {
      const s = STAGE_NORM[row.stage] || '未知'
      counts.set(s, (counts.get(s) || 0) + row.count)
    }
    return STAGE_ORDER.map((s) => ({ stage: s, count: counts.get(s) || 0 }))
  }, [data])

  // 转化率 = 相对漏斗顶部「了解」的比例（快照非队列，阶段间相除在成交>决策时会失真）
  const conversion = useMemo(() => {
    if (!normalized) return []
    const top = normalized[0]?.count || 0
    return normalized.map((n, i) => ({
      ...n,
      rate: i === 0 ? 100 : top > 0 ? Math.round((n.count / top) * 100) : 0
    }))
  }, [normalized])

  // ECharts 真漏斗（点击阶段 → 下钻 CRM 客户列表按该阶段筛选）
  const funnelOption = useMemo(() => {
    if (!conversion.length) return null
    return {
      tooltip: { trigger: 'item' as const, formatter: '{b}: {c} 人' },
      series: [{
        type: 'funnel', left: '12%', right: '12%', top: 12, bottom: 12,
        minSize: '14%', maxSize: '100%', sort: 'none' as const, gap: 4,
        label: { show: true, position: 'inside' as const, fontSize: 12, color: '#fff' },
        itemStyle: { borderWidth: 0 },
        emphasis: { label: { fontSize: 14 } },
        data: conversion.map((n, i) => ({
          name: n.stage, value: n.count,
          itemStyle: { color: STAGE_COLORS[n.stage] },
          label: { formatter: `${n.stage}  ${n.count} 人 · 转化 ${conversion[i]?.rate ?? 0}%` }
        }))
      }]
    }
  }, [conversion])
  const funnelEvents = useMemo(() => ({
    click: (p: any) => {
      const label = FUNNEL_TO_CRM_LABEL[String(p?.name || '')]
      if (label) navigate(`/crm?tab=customer&stage=${encodeURIComponent(label)}`)
    }
  }), [navigate])

  // 流失/未分类客户数（不参与漏斗形状，单独展示）
  const lostCount = useMemo(() => {
    if (!data) return 0
    return data.stageDistribution.reduce((s, r) => s + ((STAGE_NORM[r.stage] || '未知') === '流失' ? r.count : 0), 0)
  }, [data])
  const unknownCount = useMemo(() => {
    if (!data) return 0
    return data.stageDistribution.reduce((s, r) => s + ((STAGE_NORM[r.stage] || '未知') === '未知' ? r.count : 0), 0)
  }, [data])

  // 近 7 天每天新增进漏斗客户数（缺失日期补 0，避免柱子稀疏）
  const weekTrend = useMemo(() => {
    if (!data) return []
    const dayCounts = new Map<string, number>()
    for (const row of data.intentTimeline) {
      dayCounts.set(row.date, (dayCounts.get(row.date) || 0) + row.count)
    }
    const days: Array<{ date: string; count: number }> = []
    const today = new Date()
    for (let i = 6; i >= 0; i--) {
      const d = new Date(today)
      d.setDate(d.getDate() - i)
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      days.push({ date: key, count: dayCounts.get(key) || 0 })
    }
    return days
  }, [data])
  // 柱高按近 7 天最大值相对缩放，封顶 120px（原实现 count*12 会因单日数百条标记把页面撑爆）
  const maxTrend = Math.max(...weekTrend.map((d) => d.count), 1)

  return (
    <div className="funnel-page">
      <div className="funnel-header">
        <h2>销售漏斗</h2>
        <button className="funnel-btn" onClick={() => void fetch()} disabled={loading}><RefreshCw size={14} /> 刷新</button>
      </div>
      {error && <div className="funnel-error">{error}</div>}
      {loading && <div className="funnel-empty">加载中…</div>}

      {normalized && (
        <div className="funnel-body">
          <div className="funnel-stats">
            <div className="funnel-stat"><span className="funnel-stat__value">{data?.totalCustomers ?? 0}</span><span className="funnel-stat__label">客户总数</span></div>
            <div className="funnel-stat"><span className="funnel-stat__value">{conversion.find((c) => c.stage === '成交')?.count ?? 0}</span><span className="funnel-stat__label">成交</span></div>
            <div className="funnel-stat"><span className="funnel-stat__value">{normalized.find((n) => n.stage === '决策')?.count ?? 0}</span><span className="funnel-stat__label">决策中</span></div>
            <div className="funnel-stat"><span className="funnel-stat__value">{lostCount}</span><span className="funnel-stat__label">流失</span></div>
          </div>

          {funnelOption ? (
            <div className="funnel-chart">
              <ReactECharts option={funnelOption} style={{ height: 300 }} notMerge onEvents={funnelEvents} />
              <div className="funnel-drill-hint">点击漏斗任一阶段 → 下钻 CRM 客户列表</div>
            </div>
          ) : (
            <div className="funnel-empty">暂无阶段数据</div>
          )}
          <div className="funnel-footnote">
            转化为相对漏斗顶部「了解」客户的比例 · 成交 ÷ 了解 = 赢单率 · 流失 {lostCount} 人 / 未分类 {unknownCount} 人未计入漏斗
          </div>

          {weekTrend.length > 0 && (
            <div className="funnel-trend">
              <h3>近 7 天新增进漏斗客户数</h3>
              <div className="funnel-trend__bars">
                {weekTrend.map((d) => (
                  <div key={d.date} className="funnel-trend__col">
                    <span className="funnel-trend__num">{d.count}</span>
                    <div className="funnel-trend__bar" style={{ height: `${d.count > 0 ? Math.max(4, (d.count / maxTrend) * 120) : 2}px`, opacity: d.count > 0 ? 1 : 0.35 }} />
                    <span className="funnel-trend__date">{d.date.slice(5)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
