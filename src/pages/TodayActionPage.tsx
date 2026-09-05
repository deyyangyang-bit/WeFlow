/**
 * TodayActionPage.tsx — 统一信号流首页(v4 布局)
 *
 * 结构：header(标题+销售复盘+刷新) → KPI 单行条 → 高意向提示条
 *       → 主两栏(左:筛选chips+信号卡流 | 右:待办侧栏)
 *       → 可折叠「数据概览」(来源/紧急度/阶段)
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useWxidRefresh } from '../utils/useWxidRefresh'
import { useNavigate } from 'react-router-dom'
import {
  Activity, BarChart3, ChevronDown, ChevronLeft, ChevronRight, ChevronUp,
  Clock, Flame, ListTodo, Plus, RefreshCw, Sunrise, TrendingUp, Users, X,
} from 'lucide-react'
import AIActionCard from '../components/sales/AIActionCard'
import TodoSidebar from '../components/sales/TodoSidebar'
import { useTodayActionStore, type SignalFilter } from '../stores/todayActionStore'
import './TodayActionPage.scss'

const CHIPS: { key: SignalFilter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'task', label: '该联系' },
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
  const { items, stats, loading, error, filter, fetchToday, setFilter, createTodo } = useTodayActionStore()
  const [refreshing, setRefreshing] = useState(false)
  const [overviewOpen, setOverviewOpen] = useState(false)
  const [page, setPage] = useState(1)
  const navigate = useNavigate()

  // 新建待办弹窗
  const [showTodoModal, setShowTodoModal] = useState(false)
  const [todoTitle, setTodoTitle] = useState('')
  const [todoDue, setTodoDue] = useState('')
  const [todoError, setTodoError] = useState<string | null>(null)
  const [todoSubmitting, setTodoSubmitting] = useState(false)
  const [customers, setCustomers] = useState<Array<{ session_id: string; name?: string }>>([])
  const [customerSearch, setCustomerSearch] = useState('')
  const [customerOpen, setCustomerOpen] = useState(false)
  const [selectedCustomer, setSelectedCustomer] = useState<{ session_id: string; name?: string } | null>(null)

  // 晨间摘要（设计-AI见解重定位 §3.1）：每日一条「今天先跟谁」，取代高意向提示条
  const [digest, setDigest] = useState<{ date: string; items: Array<{ sessionId: string; displayName: string; reason: string }>; text: string; aiUsed: boolean } | null>(null)
  const [digestDismissed, setDigestDismissed] = useState(false)
  const [digestRegenerating, setDigestRegenerating] = useState(false)
  const fetchDigest = useCallback(async () => {
    try {
      const res = await (window as any).electronAPI.sales.morningDigestGet()
      setDigest(res?.ok && res.data && Array.isArray(res.data.items) && res.data.items.length > 0 ? res.data : null)
    } catch { setDigest(null) }
  }, [])
  // 手动重生成（用户测试入口，不必等早上 8 点）：覆盖当天旧行后回拉
  const regenerateDigest = useCallback(async () => {
    setDigestRegenerating(true)
    try {
      await (window as any).electronAPI.sales.morningDigestRegenerate()
    } catch (e) {
      console.warn('[TodayAction] 晨间摘要重新生成失败:', e)
    }
    await fetchDigest()
    setDigestRegenerating(false)
  }, [fetchDigest])

  // 打开弹窗时拉取客户列表（可选关联），重置表单
  const openTodoModal = useCallback(async () => {
    setShowTodoModal(true)
    setTodoTitle('')
    setTodoDue('')
    setTodoError(null)
    setCustomerSearch('')
    setSelectedCustomer(null)
    setCustomerOpen(false)
    try {
      const rows = await (window as any).electronAPI.crm.customers()
      setCustomers(Array.isArray(rows) ? rows : [])
    } catch { setCustomers([]) }
  }, [])

  const filteredCustomers = useMemo(() => {
    const kw = customerSearch.trim().toLowerCase()
    return kw
      ? customers.filter(c => String(c.name || '').toLowerCase().includes(kw) || String(c.session_id || '').toLowerCase().includes(kw)).slice(0, 20)
      : customers.slice(0, 20)
  }, [customers, customerSearch])

  const submitTodo = useCallback(async () => {
    const title = todoTitle.trim()
    if (!title || todoSubmitting) return
    setTodoSubmitting(true)
    setTodoError(null)
    const res = await createTodo({
      title,
      session_id: selectedCustomer?.session_id || undefined,
      due_at: todoDue ? new Date(todoDue).getTime() : undefined
    })
    setTodoSubmitting(false)
    if (res.ok) setShowTodoModal(false)
    else setTodoError(res.error || '创建失败')
  }, [todoTitle, todoDue, selectedCustomer, todoSubmitting, createTodo])

  // 卡片流分页：每页条数（信号卡较高，10 条一页避免页面过长）
  const PAGE_SIZE = 10

  useEffect(() => { fetchToday() }, [fetchToday])
  useEffect(() => { void fetchDigest() }, [fetchDigest])
  // 切微信号 = 换库（§2.40）：账号切换后重查
  useWxidRefresh(() => { void fetchToday(); void fetchDigest(); setDigestDismissed(false) })

  const handleRefresh = useCallback(async () => {
    setRefreshing(true)
    await fetchToday()
    setRefreshing(false)
  }, [fetchToday])

  // 筛选
  const filtered = useMemo(() => {
    if (filter === 'all') return items
    if (filter === 'task') return items.filter(i => i.sources.every(s => s.type === 'task'))
    if (filter === 'urgent') return items.filter(i => i.urgencyTier === 'urgent')
    return items
  }, [items, filter])

  // 切筛选时回到第一页
  useEffect(() => { setPage(1) }, [filter])

  // 分页切片（page 超出范围时钳制到最后一页，避免刷新后空页）
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const curPage = Math.min(Math.max(1, page), pageCount)
  const pageItems = useMemo(
    () => filtered.slice((curPage - 1) * PAGE_SIZE, curPage * PAGE_SIZE),
    [filtered, curPage],
  )

  // chips 计数
  const chipCounts = useMemo(() => ({
    all: items.length,
    task: items.filter(i => i.sources.every(s => s.type === 'task')).length,
    urgent: items.filter(i => i.urgencyTier === 'urgent').length,
  }), [items])

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
          <button className="ta-btn ta-btn--todo" onClick={() => void openTodoModal()}>
            <Plus size={14} /> 新建待办
          </button>
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

      {/* 晨间摘要（设计-AI见解重定位 §3.1；§3.2 起原「高意向动向」提示条已随 insight 卡流一并移除） */}
      {!digestDismissed && digest && digest.items.length > 0 && (
        <div className="signal-notice signal-notice--digest">
          <Sunrise size={14} />
          <div className="signal-notice__digest-body">
            {digest.items.map((it) => (
              <button
                key={it.sessionId}
                className="signal-notice__digest-item"
                onClick={() => navigate(`/customers?sid=${encodeURIComponent(it.sessionId)}`)}
              >
                <strong>{it.displayName}</strong>——{it.reason}
              </button>
            ))}
          </div>
          <span className="signal-notice__dismiss" onClick={() => setDigestDismissed(true)}>收起</span>
          <button
            className="signal-notice__digest-refresh"
            title="重新生成今日摘要"
            disabled={digestRegenerating}
            onClick={regenerateDigest}
          >
            <RefreshCw size={12} className={digestRegenerating ? 'spinning' : undefined} />
          </button>
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
          {filtered.length > 0 && (
            <>
              <div className="signal-list">
                {pageItems.map(item => (
                  <AIActionCard key={item.sessionId} item={item} />
                ))}
              </div>

              {/* 分页 */}
              {pageCount > 1 && (
                <div className="signal-pagination">
                  <button
                    className="signal-pagination__btn"
                    disabled={curPage === 1}
                    onClick={() => setPage(curPage - 1)}
                  >
                    <ChevronLeft size={14} /> 上一页
                  </button>
                  <span className="signal-pagination__info">
                    {curPage} / {pageCount} 页 · 共 {filtered.length} 条
                  </span>
                  <button
                    className="signal-pagination__btn"
                    disabled={curPage === pageCount}
                    onClick={() => setPage(curPage + 1)}
                  >
                    下一页 <ChevronRight size={14} />
                  </button>
                </div>
              )}
            </>
          )}
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

      {/* 新建待办弹窗 */}
      {showTodoModal && (
        <div className="ta-modal-overlay" onClick={() => setShowTodoModal(false)}>
          <div className="ta-modal" onClick={(e) => e.stopPropagation()}>
            <div className="ta-modal__header">
              <h3 className="ta-modal__title"><ListTodo size={16} /> 新建待办</h3>
              <button className="ta-modal__close" onClick={() => setShowTodoModal(false)} aria-label="关闭">
                <X size={16} />
              </button>
            </div>

            <input
              className="ta-modal__input"
              placeholder="待办内容（如：下午联系王总确认合同）"
              value={todoTitle}
              onChange={(e) => setTodoTitle(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void submitTodo() }}
              autoFocus
            />

            {/* 关联客户（可选，搜索下拉） */}
            <div className="ta-customer-picker">
              <input
                className="ta-modal__input"
                placeholder="关联客户（可选，输入搜索）"
                value={selectedCustomer ? String(selectedCustomer.name || selectedCustomer.session_id) : customerSearch}
                onChange={(e) => { setSelectedCustomer(null); setCustomerSearch(e.target.value) }}
                onFocus={() => setCustomerOpen(true)}
                onBlur={() => setTimeout(() => setCustomerOpen(false), 150)}
              />
              {customerOpen && filteredCustomers.length > 0 && (
                <div className="ta-customer-list">
                  {filteredCustomers.map((c) => (
                    <button
                      key={String(c.session_id)}
                      className="ta-customer-item"
                      onMouseDown={() => { setSelectedCustomer(c); setCustomerSearch(''); setCustomerOpen(false) }}
                    >
                      <span className="ta-customer-item__name">{c.name || '未命名客户'}</span>
                      <span className="ta-customer-item__sid">{String(c.session_id).slice(0, 18)}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <input
              className="ta-modal__input"
              type="datetime-local"
              value={todoDue}
              onChange={(e) => setTodoDue(e.target.value)}
            />

            {todoError && <div className="ta-modal__error">{todoError}</div>}

            <div className="ta-modal__actions">
              <button className="ta-modal__cancel" onClick={() => setShowTodoModal(false)}>取消</button>
              <button className="ta-modal__submit" onClick={() => void submitTodo()} disabled={!todoTitle.trim() || todoSubmitting}>
                {todoSubmitting ? '添加中...' : '添加待办'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
