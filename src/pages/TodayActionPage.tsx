/**
 * TodayActionPage.tsx — 统一信号流首页(v4 布局)
 *
 * 结构：header(标题+销售复盘+刷新) → KPI 单行条 → 高意向提示条
 *       → 主两栏(左:筛选chips+信号卡流 | 右:待办侧栏)
 *       → 可折叠「数据概览」(来源/紧急度/阶段)
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Activity, BarChart3, Bell, ChevronDown, ChevronUp,
  Clock, Flame, RefreshCw, TrendingUp, Users,
} from 'lucide-react'
import AIActionCard from '../components/sales/AIActionCard'
import TodoSidebar from '../components/sales/TodoSidebar'
import { useTodayActionStore, type SignalFilter } from '../stores/todayActionStore'
import './TodayActionPage.scss'

const CHIPS: { key: SignalFilter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'task', label: '该联系' },
  { key: 'insight', label: '有动向' },
  { key: 'urgent', label: '紧急' },
]

const STAGE_LABELS: Record<string, string> = {
  contacted: '沟通', quoted: '报价', negotiating: '谈判',
  unknown: '未知', new: '新客', dormant: '沉默',
}
const STAGE_COLORS: Record<string, string> = {
  contacted: '#8b5cf6', quoted: '#f59e0b', negotiating: '#ef4444',
  unknown: '#9ca3af', new: '#3b82f6', dormant: '#6b7280',
}

function KpiStat({ icon, value, label }: { icon: React.ReactNode; value: number; label: string }) {
  return (
    <div className="kpi-strip__stat">
      {icon}
      <div>
        <div className="kpi-strip__value">{value}</div>
        <div className="kpi-strip__label">{label}</div>
      </div>
    </div>
  );
}

export default function TodayActionPage() {
  const { items, stats, loading, error, filter, noticeDismissed, fetchToday, setFilter, dismissNotice } = useTodayActionStore()
  const [refreshing, setRefreshing] = useState(false)
  const [overviewOpen, setOverviewOpen] = useState(false)
  const navigate = useNavigate()

  useEffect(() => { fetchToday() }, [fetchToday])

  const handleRefresh = useCallback(async () => {
    setRefreshing(true)
    await fetchToday()
    setRefreshing(false)
  }, [fetchToday])

  // 筛选
  const filtered = useMemo(() => {
    if (filter === 'all') return items
    if (filter === 'task') return items.filter(i => i.sources.every(s => s.type === 'task'))
    if (filter === 'insight') return items.filter(i => i.sources.some(s => s.type === 'insight'))
    if (filter === 'urgent') return items.filter(i => i.urgencyTier === 'urgent')
    return items
  }, [items, filter])

  // chips 计数
  const chipCounts = useMemo(() => ({
    all: items.length,
    task: items.filter(i => i.sources.every(s => s.type === 'task')).length,
    insight: items.filter(i => i.sources.some(s => s.type === 'insight')).length,
    urgent: items.filter(i => i.urgencyTier === 'urgent').length,
  }), [items])

  // 高意向提示条
  const highIntentWithInsight = items.filter(i =>
    i.urgencyTier === 'urgent' && i.sources.some(s => s.type === 'insight')
  ).length

  // 概览:阶段分布
  const stageCounts = useMemo(() => {
    const m: Record<string, number> = {}
    for (const item of items) {
      const s = item.stage || 'unknown'
      m[s] = (m[s] || 0) + 1
    }
    return Object.entries(m).sort((a, b) => b[1] - a[1])
  }, [items])
  const maxStageCount = Math.max(1, ...stageCounts.map(([, c]) => c))

  return (
    <div className="today-action-page">
      {/* header */}
      <div className="today-action-page__header">
        <div>
          <h1 className="today-action-page__title">今日行动</h1>
          <p className="today-action-page__subtitle">任务与动态已合并 · 共 {filtered.length} 条信号</p>
        </div>
        <div className="today-action-page__header-actions">
          <button className="ta-btn ta-btn--teal" onClick={() => navigate('/sales-report')}>
            <BarChart3 size={14} /> 销售复盘
          </button>
          <button className="today-action-page__refresh" onClick={handleRefresh} disabled={refreshing}>
            <RefreshCw size={16} className={refreshing ? 'spinning' : ''} />
          </button>
        </div>
      </div>

      {/* KPI 单行条 */}
      {stats && (
        <div className="kpi-strip">
          <KpiStat icon={<Flame size={15} />} value={stats.highPriorityCount} label="高优行动" />
          <span className="kpi-strip__divider" />
          <KpiStat icon={<Clock size={15} />} value={stats.riskCustomerCount} label="沉默风险" />
          <span className="kpi-strip__divider" />
          <KpiStat icon={<TrendingUp size={15} />} value={stats.activeDeals} label="活跃商机" />
          <span className="kpi-strip__divider" />
          <KpiStat icon={<Users size={15} />} value={stats.totalSignals} label="待处理" />
        </div>
      )}

      {/* 高意向提示条 */}
      {!noticeDismissed && highIntentWithInsight > 0 && (
        <div className="signal-notice" onClick={dismissNotice}>
          <Bell size={14} />
          {highIntentWithInsight} 位客户有高意向动向，已置顶排序
          <span className="signal-notice__dismiss">点击收起</span>
        </div>
      )}

      {/* 主两栏 */}
      <div className="today-action-page__main">
        <div className="today-action-page__left">
          {/* 筛选 chips */}
          <div className="signal-chips">
            {CHIPS.map(c => (
              <button
                key={c.key}
                className={`signal-chip ${filter === c.key ? 'signal-chip--active' : ''}`}
                onClick={() => setFilter(c.key)}
              >
                {c.label}
                <span className="signal-chip__count">{chipCounts[c.key]}</span>
              </button>
            ))}
          </div>

          {/* 错误 */}
          {error && (
            <div className="today-action-page__error">
              {error}
              <button onClick={fetchToday}>重试</button>
            </div>
          )}

          {/* 加载 */}
          {loading && items.length === 0 && (
            <div className="today-action-page__loading">
              <RefreshCw size={24} className="spinning" />
              <p>正在分析客户数据...</p>
            </div>
          )}

          {/* 空状态 */}
          {!loading && filtered.length === 0 && !error && (
            <div className="signal-empty">
              {items.length === 0
                ? '🎉 今天全部跟完了！'
                : '这个筛选下暂无信号，你已经跟上了所有客户'}
            </div>
          )}

          {/* 信号卡片流 */}
          <div className="signal-list">
            {filtered.map(item => (
              <AIActionCard key={item.sessionId} item={item} />
            ))}
          </div>
        </div>

        {/* 右栏:待办侧栏 */}
        <div className="today-action-page__right">
          <TodoSidebar />
        </div>
      </div>

      {/* 可折叠数据概览 */}
      <div className="overview-card">
        <button className="overview-card__toggle" onClick={() => setOverviewOpen(!overviewOpen)}>
          <span className="overview-card__title">
            <Activity size={14} /> 数据概览 · 来源 / 紧急度 / 阶段
          </span>
          {overviewOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </button>

        {overviewOpen && stats && stats.totalSignals > 0 && (
          <div className="overview-grid">
            {/* 来源分布 */}
            <div className="overview-section">
              <span className="overview-section__title">信号来源</span>
              <div className="overview-section__bar">
                {stats.taskOnly > 0 && (
                  <div className="overview-section__seg overview-section__seg--task" style={{ flex: stats.taskOnly }} title={`该联系 ${stats.taskOnly}`} />
                )}
                {stats.merged > 0 && (
                  <div className="overview-section__seg overview-section__seg--merged" style={{ flex: stats.merged }} title={`双重信号 ${stats.merged}`} />
                )}
                {stats.insightOnly > 0 && (
                  <div className="overview-section__seg overview-section__seg--insight" style={{ flex: stats.insightOnly }} title={`有动向 ${stats.insightOnly}`} />
                )}
              </div>
              <div className="overview-section__legend">
                {stats.taskOnly > 0 && <><span className="overview-section__dot overview-section__dot--task" /> 该联系 {stats.taskOnly}</>}
                {stats.merged > 0 && <><span className="overview-section__dot overview-section__dot--merged" /> 双重 {stats.merged}</>}
                {stats.insightOnly > 0 && <><span className="overview-section__dot overview-section__dot--insight" /> 有动向 {stats.insightOnly}</>}
              </div>
            </div>

            {/* 紧急度分布 */}
            <div className="overview-section">
              <span className="overview-section__title">紧急度</span>
              <div className="overview-section__urgency">
                {(['urgent', 'high', 'normal'] as const).map(tier => (
                  <div key={tier} className="overview-section__urgency-item">
                    <span className={`overview-section__urgency-dot overview-section__urgency-dot--${tier}`} />
                    <span className="overview-section__urgency-num">{items.filter(i => i.urgencyTier === tier).length}</span>
                    <span className="overview-section__urgency-label">{tier === 'urgent' ? '紧急' : tier === 'high' ? '高' : '常规'}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* 阶段分布 */}
            <div className="overview-section overview-section--wide">
              <span className="overview-section__title">客户阶段</span>
              <div className="overview-section__stages">
                {stageCounts.map(([stage, count]) => (
                  <div key={stage} className="overview-section__stage-bar">
                    <span className="overview-section__stage-label">{STAGE_LABELS[stage] || stage}</span>
                    <div className="overview-section__stage-track">
                      <div
                        className="overview-section__stage-fill"
                        style={{ width: `${(count / maxStageCount) * 100}%`, background: STAGE_COLORS[stage] || '#9ca3af' }}
                      />
                    </div>
                    <span className="overview-section__stage-count">{count}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
