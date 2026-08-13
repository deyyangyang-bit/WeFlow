/**
 * SalesFunnelPage.tsx —— 销售漏斗：阶段分布 + 转化率 + 近 30 天意向标记趋势
 */
import { useEffect, useMemo, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import './SalesFunnelPage.scss'

interface FunnelData {
  stageDistribution: Array<{ stage: string; count: number }>
  intentTimeline: Array<{ date: string; stage: string; count: number }>
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

  const conversion = useMemo(() => {
    if (!normalized) return []
    let prev = 0
    return normalized.map((n, i) => {
      const rate = i === 0 ? 100 : prev > 0 ? Math.round((n.count / prev) * 100) : 0
      prev = n.count
      return { ...n, rate }
    })
  }, [normalized])

  // 流失/未分类客户数（不参与漏斗形状，单独展示）
  const lostCount = useMemo(() => {
    if (!data) return 0
    return data.stageDistribution.reduce((s, r) => s + ((STAGE_NORM[r.stage] || '未知') === '流失' ? r.count : 0), 0)
  }, [data])
  const unknownCount = useMemo(() => {
    if (!data) return 0
    return data.stageDistribution.reduce((s, r) => s + ((STAGE_NORM[r.stage] || '未知') === '未知' ? r.count : 0), 0)
  }, [data])

  // 近 7 天每天新增意向标记数（缺失日期补 0，避免柱子稀疏）
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

          <div className="funnel-bars">
            {conversion.map((n) => (
              <div key={n.stage} className="funnel-bar">
                <div className="funnel-bar__label">
                  <span className="funnel-bar__name">{n.stage}</span>
                  <span className="funnel-bar__count">{n.count}</span>
                </div>
                <div className="funnel-bar__track">
                  <div
                    className="funnel-bar__fill"
                    style={{ width: `${n.count > 0 ? Math.max(4, (n.count / (normalized[0]?.count || 1)) * 100) : 0}%`, background: STAGE_COLORS[n.stage] }}
                  />
                </div>
                <div className="funnel-bar__rate">转化率 {n.rate}%</div>
              </div>
            ))}
          </div>
          <div className="funnel-footnote">
            转化率为相对上一阶段的比例 · 成交 &gt; 决策说明部分客户直接标记成交（跳级）· 流失 {lostCount} 人 / 未分类 {unknownCount} 人未计入漏斗
          </div>

          {weekTrend.length > 0 && (
            <div className="funnel-trend">
              <h3>近 7 天意向标记数</h3>
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
