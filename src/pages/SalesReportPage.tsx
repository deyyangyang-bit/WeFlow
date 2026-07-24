/**
 * SalesReportPage.tsx
 * 销售周报/月报分析页面
 */

import { useCallback, useEffect, useMemo } from 'react'
import ReactECharts from 'echarts-for-react'
import { BarChart3, Calendar, RefreshCw, Trash2, Sparkles, Users, MessageSquare, TrendingUp, AlertCircle } from 'lucide-react'
import { useSalesReportStore, type ReportStats } from '../stores/salesReportStore'
import { Avatar } from '../components/Avatar'
import './SalesReportPage.scss'

// ─── 工具函数 ─────────────────────────────────────────────────────────────────

function formatPeriod(start: number, end: number, type: string): string {
  const s = new Date(start)
  const e = new Date(end)
  const fmt = (d: Date) => `${d.getMonth() + 1}/${d.getDate()}`
  if (type === 'week') return `${fmt(s)} - ${fmt(e)}`
  return `${s.getFullYear()}年${s.getMonth() + 1}月`
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

// ─── 统计卡片 ─────────────────────────────────────────────────────────────────

function StatCard({ icon: Icon, label, value, color }: { icon: any; label: string; value: string | number; color: string }) {
  return (
    <div className="sr-stat-card" style={{ '--stat-color': color } as React.CSSProperties}>
      <div className="sr-stat-icon"><Icon size={20} /></div>
      <div className="sr-stat-info">
        <span className="sr-stat-value">{value}</span>
        <span className="sr-stat-label">{label}</span>
      </div>
    </div>
  )
}

// ─── 图表组件 ─────────────────────────────────────────────────────────────────

function DailyChart({ data }: { data: Array<{ date: string; count: number }> }) {
  const option = useMemo(() => ({
    tooltip: { trigger: 'axis' as const },
    grid: { left: 40, right: 20, top: 20, bottom: 30 },
    xAxis: {
      type: 'category' as const,
      data: data.map(d => d.date.slice(5)),
      axisLabel: { fontSize: 11 }
    },
    yAxis: { type: 'value' as const, minInterval: 1 },
    series: [{
      type: 'bar',
      data: data.map(d => d.count),
      itemStyle: { borderRadius: [4, 4, 0, 0], color: '#007aff' },
      barMaxWidth: 32
    }]
  }), [data])

  return <ReactECharts option={option} style={{ height: 220 }} />
}

function TopContactsChart({ contacts }: { contacts: ReportStats['topContacts'] }) {
  const top5 = contacts.slice(0, 5).reverse()
  const option = useMemo(() => ({
    tooltip: { trigger: 'axis' as const, axisPointer: { type: 'shadow' as const } },
    grid: { left: 100, right: 30, top: 10, bottom: 10 },
    xAxis: { type: 'value' as const, minInterval: 1 },
    yAxis: {
      type: 'category' as const,
      data: top5.map(c => c.displayName),
      axisLabel: { fontSize: 12, width: 80, overflow: 'truncate' as const }
    },
    series: [{
      type: 'bar',
      data: top5.map(c => c.messageCount),
      itemStyle: { borderRadius: [0, 4, 4, 0], color: '#34c759' },
      barMaxWidth: 24
    }]
  }), [top5])

  return <ReactECharts option={option} style={{ height: Math.max(150, top5.length * 40) }} />
}

// ─── 主页面 ──────────────────────────────────────────────────────────────────

export default function SalesReportPage() {
  const {
    reports, currentReport, currentStats,
    generating, error, periodType,
    setPeriodType, generateReport, fetchReports, viewReport, deleteReport
  } = useSalesReportStore()

  useEffect(() => { fetchReports() }, [fetchReports])

  const handleGenerate = useCallback(() => {
    generateReport()
  }, [generateReport])

  return (
    <div className="sr-page">
      <div className="sr-page-header">
        <div className="sr-page-title">
          <BarChart3 size={22} />
          <h2>销售报表</h2>
        </div>

        <div className="sr-page-toolbar">
          <div className="sr-period-toggle">
            <button
              className={`sr-period-btn ${periodType === 'week' ? 'active' : ''}`}
              onClick={() => setPeriodType('week')}
            >
              周报
            </button>
            <button
              className={`sr-period-btn ${periodType === 'month' ? 'active' : ''}`}
              onClick={() => setPeriodType('month')}
            >
              月报
            </button>
          </div>

          <button
            className="sr-btn sr-btn-primary"
            onClick={handleGenerate}
            disabled={generating}
          >
            <RefreshCw size={16} className={generating ? 'spinning' : ''} />
            {generating ? '生成中...' : `生成${periodType === 'week' ? '周' : '月'}报`}
          </button>
        </div>
      </div>

      {error && (
        <div className="sr-error">
          <AlertCircle size={16} />
          <span>{error}</span>
        </div>
      )}

      <div className="sr-page-body">
        {/* 当前报表 */}
        {currentReport && currentStats && (
          <div className="sr-current-report">
            <div className="sr-report-header">
              <Calendar size={16} />
              <span>{formatPeriod(currentReport.period_start, currentReport.period_end, currentReport.period_type)}</span>
              <span className="sr-report-time">生成于 {formatTime(currentReport.created_at)}</span>
            </div>

            {/* 统计卡片 */}
            <div className="sr-stats-grid">
              <StatCard icon={MessageSquare} label="消息总量" value={currentStats.totalMessages} color="#007aff" />
              <StatCard icon={Users} label="活跃客户" value={currentStats.activeContacts} color="#34c759" />
              <StatCard icon={TrendingUp} label="日均消息" value={
                currentStats.dailyMessageCounts.length > 0
                  ? Math.round(currentStats.totalMessages / currentStats.dailyMessageCounts.length)
                  : 0
              } color="#ff9500" />
            </div>

            {/* AI 摘要 */}
            {currentReport.ai_summary && (
              <div className="sr-ai-summary">
                <div className="sr-ai-summary-header">
                  <Sparkles size={16} />
                  <span>AI 分析摘要</span>
                </div>
                <p>{currentReport.ai_summary}</p>
              </div>
            )}

            {/* 图表 */}
            <div className="sr-charts-grid">
              {currentStats.dailyMessageCounts.length > 0 && (
                <div className="sr-chart-card">
                  <h4>每日消息量</h4>
                  <DailyChart data={currentStats.dailyMessageCounts} />
                </div>
              )}

              {currentStats.topContacts.length > 0 && (
                <div className="sr-chart-card">
                  <h4>Top 互动客户</h4>
                  <TopContactsChart contacts={currentStats.topContacts} />
                </div>
              )}
            </div>

            {/* Top 客户列表 */}
            {currentStats.topContacts.length > 0 && (
              <div className="sr-top-list">
                <h4>互动排行</h4>
                <div className="sr-top-items">
                  {currentStats.topContacts.map((c, i) => (
                    <div key={c.sessionId} className="sr-top-item">
                      <span className="sr-top-rank">{i + 1}</span>
                      <Avatar src={c.avatarUrl} name={c.displayName} size={32} />
                      <span className="sr-top-name">{c.displayName}</span>
                      <span className="sr-top-count">{c.messageCount} 条</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* 历史报表 */}
        <div className="sr-history">
          <h3>历史报表</h3>
          {reports.length === 0 ? (
            <div className="sr-empty">
              <BarChart3 size={40} />
              <p>暂无报表，点击上方按钮生成第一份{periodType === 'week' ? '周' : '月'}报</p>
            </div>
          ) : (
            <div className="sr-history-list">
              {reports.map(r => {
                let stats: ReportStats | null = null
                try { stats = JSON.parse(r.stats) } catch {}
                return (
                  <div
                    key={r.id}
                    className={`sr-history-item ${currentReport?.id === r.id ? 'active' : ''}`}
                    onClick={() => viewReport(r.id)}
                  >
                    <div className="sr-history-info">
                      <span className="sr-history-period">
                        {r.period_type === 'week' ? '周报' : '月报'} · {formatPeriod(r.period_start, r.period_end, r.period_type)}
                      </span>
                      <span className="sr-history-meta">
                        {stats ? `${stats.totalMessages} 条消息 · ${stats.activeContacts} 位客户` : ''}
                      </span>
                    </div>
                    <div className="sr-history-actions">
                      <span className="sr-history-time">{formatTime(r.created_at)}</span>
                      <button
                        className="sr-history-delete"
                        onClick={(e) => { e.stopPropagation(); deleteReport(r.id) }}
                        title="删除"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
