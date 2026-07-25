/**
 * SalesDashboardPage.tsx
 * 销售仪表盘（接管首页 / 与 /home）。
 * 把 customer_profile / 待办 / 阶段分布串成日常全局视图。
 */
import React, { useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import ReactECharts from 'echarts-for-react'
import { Clock, AlertTriangle, TrendingUp, UserPlus, LayoutDashboard } from 'lucide-react'
import { useDashboardStore } from '../stores/dashboardStore'
import './SalesDashboardPage.scss'

function greeting(): string {
  const h = new Date().getHours()
  if (h < 6) return '夜深了'
  if (h < 12) return '早上好'
  if (h < 14) return '中午好'
  if (h < 18) return '下午好'
  return '晚上好'
}

export default function SalesDashboardPage() {
  const navigate = useNavigate()
  const { stats, loading, loadStats } = useDashboardStore()

  useEffect(() => { loadStats() }, [loadStats])

  const s = stats
  const needFollow = (s?.pendingTodos || 0) + (s?.overdueTodos || 0)

  const funnelOption = useMemo(() => {
    const sc = s?.stageCounts || {}
    const stages = ['了解', '比价', '决策', '成交']
    return {
      grid: { left: 60, right: 30, top: 10, bottom: 20 },
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      xAxis: { type: 'value', minInterval: 1 },
      yAxis: { type: 'category', data: stages, inverse: true },
      series: [{
        type: 'bar',
        data: stages.map((st, i) => ({
          value: sc[st] || 0,
          itemStyle: { color: ['#4a9eff', '#f5a623', '#e74c3c', '#27ae60'][i], borderRadius: [0, 4, 4, 0] }
        })),
        barWidth: 18,
        label: { show: true, position: 'right', color: '#888' }
      }]
    }
  }, [s])

  const todoPieOption = useMemo(() => {
    const data = [
      { name: '待跟进', value: s?.pendingTodos || 0, itemStyle: { color: '#4a9eff' } },
      { name: '疑似跟进', value: s?.suspectedTodos || 0, itemStyle: { color: '#f5a623' } },
      { name: '逾期', value: s?.overdueTodos || 0, itemStyle: { color: '#e74c3c' } }
    ]
    return {
      tooltip: { trigger: 'item' },
      legend: { bottom: 0, textStyle: { color: '#888' } },
      series: [{
        type: 'pie',
        radius: ['40%', '65%'],
        center: ['50%', '45%'],
        avoidLabelOverlap: true,
        label: { show: false },
        data
      }]
    }
  }, [s])

  const cards = [
    { key: 'follow', label: '今日待跟进', value: needFollow, icon: <Clock size={18} />, color: '#4a9eff', to: '/follow-up' },
    { key: 'overdue', label: '逾期未跟进', value: s?.overdueTodos || 0, icon: <AlertTriangle size={18} />, color: '#e74c3c', to: '/follow-up' },
    { key: 'high', label: '高意向客户', value: s?.highIntentCount || 0, icon: <TrendingUp size={18} />, color: '#f5a623', to: '/customers?stage=决策' },
    { key: 'new', label: '本周新增', value: s?.newCustomersThisWeek || 0, icon: <UserPlus size={18} />, color: '#27ae60', to: '/customers' }
  ]

  return (
    <div className="sales-dashboard">
      <div className="sd-header">
        <div className="sd-greet">
          <LayoutDashboard size={22} />
          <div>
            <h2>{greeting()}，销售顾问</h2>
            <p className="sd-sub">
              {loading ? '加载中...' : `今天有 ${needFollow} 个客户需要跟进，共 ${s?.totalCustomers || 0} 位客户在管理中`}
            </p>
          </div>
        </div>
        <button className="sd-refresh" onClick={() => loadStats()} title="刷新">刷新</button>
      </div>

      <div className="sd-cards">
        {cards.map((c) => (
          <div key={c.key} className="sd-card" onClick={() => navigate(c.to)} style={{ borderTopColor: c.color }}>
            <div className="sd-card-icon" style={{ color: c.color, background: c.color + '1a' }}>{c.icon}</div>
            <div className="sd-card-value" style={{ color: c.color }}>{c.value}</div>
            <div className="sd-card-label">{c.label}</div>
          </div>
        ))}
      </div>

      <div className="sd-charts">
        <div className="sd-chart-box">
          <h3>销售漏斗</h3>
          <ReactECharts option={funnelOption} style={{ height: 220 }} notMerge />
        </div>
        <div className="sd-chart-box">
          <h3>待办状态分布</h3>
          <ReactECharts option={todoPieOption} style={{ height: 220 }} notMerge />
        </div>
      </div>
    </div>
  )
}
