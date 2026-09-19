/**
 * SalesReportPage.tsx
 * 销售复盘页面：周报 / 月报（消息量统计）+ 周复盘（经营分析：谁热了/谁冷了/谁该放弃/下周重点）
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import ReactECharts from 'echarts-for-react'
import { BarChart3, RefreshCw, Trash2, Sparkles, AlertCircle, EyeOff, SlidersHorizontal, X } from 'lucide-react'
import { useSalesReportStore, type ReportStats, type WeeklyReviewStats } from '../stores/salesReportStore'
import { Avatar } from '../components/Avatar'
// 图表色单一真源（红线 3：页面不硬编码品牌色）
import { FUNNEL_STAGE_COLORS } from '../../shared/funnelPalette'
import './SalesReportPage.scss'

interface ExcludeSession {
  username: string
  displayName: string
  avatarUrl?: string
}

function sessionDisplayName(s: { username: string; displayName?: string }): string {
  return s.displayName || s.username
}

// ─── 工具函数 ─────────────────────────────────────────────────────────────────

function formatPeriod(start: number, end: number, type: string): string {
  const s = new Date(start)
  const e = new Date(end)
  const fmt = (d: Date) => `${d.getMonth() + 1}/${d.getDate()}`
  if (type === 'week' || type === 'weekly_review') return `${fmt(s)} - ${fmt(e)}`
  return `${s.getFullYear()}年${s.getMonth() + 1}月`
}

function periodTypeLabel(type: string): string {
  if (type === 'weekly_review') return '周复盘'
  return type === 'week' ? '周报' : '月报'
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

// ─── 图表组件（数据源不动，外壳去卡壳） ──────────────────────────────────────

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
      itemStyle: { borderRadius: [4, 4, 0, 0], color: FUNNEL_STAGE_COLORS[2] },
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
      itemStyle: { borderRadius: [0, 4, 4, 0], color: FUNNEL_STAGE_COLORS[1] },
      barMaxWidth: 24
    }]
  }), [top5])

  return <ReactECharts option={option} style={{ height: Math.max(150, top5.length * 40) }} />
}

// ─── 周复盘子组件 ─────────────────────────────────────────────────────────────

function ReviewList({ title, items, empty, tone }: { title: string; items: string[]; empty: string; tone: 'hot' | 'cold' | 'drop' }) {
  return (
    <div className={`sr-review-list ${tone}`}>
      <h4>{title} {items.length > 0 && <span className="sr-review-count num">{items.length}</span>}</h4>
      {items.length === 0 ? (
        <div className="sr-empty-mini">{empty}</div>
      ) : (
        <ul>
          {items.map((it, i) => (
            <li key={i}><span className="sr-review-item-dot" />{it}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * 周复盘指标条：与周报/月报同序——数字先出现，结论（AI 复盘正文）随后。
 * 只搬位置不改口径：四个数仍取 stats 里的现有字段，走共享 .stats 发丝语法。
 */
function ReviewMetrics({ stats }: { stats: WeeklyReviewStats }) {
  return (
    <div className="stats sr-stats">
      <div className="stat">
        <div className="stat__n">{stats.pipelineTotal}</div>
        <div className="stat__l">管道客户</div>
        <div className="stat__d">本周活跃 {stats.activeCount} 人</div>
      </div>
      <div className="stat">
        <div className="stat__n">{stats.hotCount}</div>
        <div className="stat__l">本周热了</div>
        <div className="stat__d">阶段有前进</div>
      </div>
      <div className="stat">
        <div className="stat__n">{stats.coldCount}</div>
        <div className="stat__l">变冷</div>
        <div className="stat__d">&gt;30 天无互动</div>
      </div>
      <div className="stat">
        <div className="stat__n">{stats.dropCount}</div>
        <div className="stat__l">建议放弃</div>
        <div className="stat__d">&gt;60 天无互动</div>
      </div>
    </div>
  )
}

function ReviewSections({ stats }: { stats: WeeklyReviewStats }) {
  const stageEntries = useMemo(() =>
    Object.entries(stats.stageCounts || {})
      .filter(([, v]) => Number(v) > 0)
      .sort((a, b) => Number(b[1]) - Number(a[1])),
    [stats.stageCounts])
  const maxCount = stageEntries.length > 0 ? Number(stageEntries[0][1]) : 1
  const labelOf = (en: string) => stats.stageLabel?.[en] || en

  return (
    <>
      {stageEntries.length > 0 && (
        <div className="sr-review-stage">
          <div className="seclabel"><span className="seclabel__t">阶段分布</span></div>
          <div className="sr-stage-dist">
            {stageEntries.map(([en, count]) => (
              <div key={en} className="sr-stage-row">
                <span className="sr-stage-label">{labelOf(en)}</span>
                <div className="sr-stage-bar-track">
                  <div className="sr-stage-bar" style={{ width: `${(Number(count) / maxCount) * 100}%` }} />
                </div>
                <span className="sr-stage-count num">{count}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="sr-review-sections">
        <ReviewList title="谁热了" items={stats.hotCustomers || []} empty="本周没有阶段前进的客户" tone="hot" />
        <ReviewList title="谁冷了" items={stats.coldCustomers || []} empty="没有沉默超 30 天的客户" tone="cold" />
        <ReviewList title="建议放弃" items={stats.dropCandidates || []} empty="没有需要放弃的客户" tone="drop" />
      </div>
    </>
  )
}

// ─── 主页面 ──────────────────────────────────────────────────────────────────

export default function SalesReportPage() {
  const {
    reports, currentReport, currentStats, currentReviewStats,
    generating, error, periodType, excludedSessions,
    setPeriodType, generateReport, generateReview, fetchReports, viewReport, deleteReport,
    loadExcludedSessions, excludeContact, setExcludedSessions
  } = useSalesReportStore()

  // ── 排除联系人弹窗 ──────────────────────────────────────────────────────────
  const [showExcludeDialog, setShowExcludeDialog] = useState(false)
  const [allSessions, setAllSessions] = useState<ExcludeSession[]>([])
  const [sessionsLoading, setSessionsLoading] = useState(false)
  const [excludeSearch, setExcludeSearch] = useState('')
  const [draftExcluded, setDraftExcluded] = useState<Set<string>>(new Set())

  useEffect(() => {
    fetchReports()
    loadExcludedSessions()
  }, [fetchReports, loadExcludedSessions])

  // ── 刀 2 采纳率行（只读聚合，PRD DoD 只看这两个数；分母 0 → 「—」不伪造）──────
  const [adoption, setAdoption] = useState<{ processed: number; rate: number | null } | null>(null)
  useEffect(() => {
    let alive = true
    window.electronAPI.sales.proposalStats()
      .then((r) => { if (alive && r?.success && r.stats) setAdoption({ processed: r.stats.processed, rate: r.stats.rate }) })
      .catch(() => { /* 聚合失败静默，不阻塞复盘页 */ })
    return () => { alive = false }
  }, [])

  const handleGenerate = useCallback(() => {
    generateReport()
  }, [generateReport])

  const handleReview = useCallback(() => {
    generateReview()
  }, [generateReview])

  const openExcludeDialog = useCallback(async () => {
    setShowExcludeDialog(true)
    setDraftExcluded(new Set(excludedSessions))
    setExcludeSearch('')
    if (allSessions.length > 0) return
    setSessionsLoading(true)
    try {
      const result = await window.electronAPI.chat.getSessions()
      if (result.success && result.sessions) {
        const filtered = result.sessions
          .filter((s) => {
            const u = String(s.username || '')
            if (!u || u.toLowerCase().includes('placeholder_foldgroup')) return false
            if (u.endsWith('@chatroom') || u.startsWith('gh_')) return false
            return true
          })
          .map((s) => ({ username: String(s.username), displayName: sessionDisplayName(s), avatarUrl: s.avatarUrl }))
          .sort((a, b) => a.displayName.localeCompare(b.displayName, 'zh'))
        setAllSessions(filtered)
      }
    } finally {
      setSessionsLoading(false)
    }
  }, [allSessions.length, excludedSessions])

  const saveExcluded = useCallback(async () => {
    await setExcludedSessions([...draftExcluded])
    setShowExcludeDialog(false)
  }, [draftExcluded, setExcludedSessions])

  const isWeeklyReview = currentReport?.period_type === 'weekly_review'

  // 页头（概念稿 .shead）：hero 只用页内既有计数拼一句，没有报告就弱化为周期标题；不编没有的结论
  const periodText = currentReport
    ? formatPeriod(currentReport.period_start, currentReport.period_end, currentReport.period_type)
    : ''
  const heroLine = (() => {
    if (!currentReport) return '周报 · 月报 · 周复盘'
    if (isWeeklyReview && currentReviewStats) {
      return <>管道 <b>{currentReviewStats.pipelineTotal}</b> 位客户 · 本周热了 <b>{currentReviewStats.hotCount}</b> 位</>
    }
    if (!isWeeklyReview && currentStats) {
      return <><b>{currentStats.totalMessages}</b> 条消息 · <b>{currentStats.activeContacts}</b> 位活跃客户</>
    }
    return periodTypeLabel(currentReport.period_type)
  })()
  const subLine = currentReport
    ? `${periodText} · 数据来自本机会话与业务库${excludedSessions.length > 0 ? `，已排除 ${excludedSessions.length} 位非销售联系人` : ''}`
    : '数据来自本机会话与业务库，可把同事 / 朋友排除出统计'

  return (
    <div className="sr-page">
      {/* 页头（概念稿 .shead）：eyebrow → hero（既有计数拼句）→ sub（数据来源说明）；右侧动作降档，周复盘=本屏唯一轻 primary */}
      <div className="shead sr-shead">
        <div>
          <p className="eyebrow">报表 · 复盘</p>
          <h1 className="hero">{heroLine}</h1>
          <p className="sub">{subLine}</p>
        </div>
        <div className="shead__actions">
          <div className="chipbar" role="tablist" aria-label="报告类型">
            <button role="tab" aria-selected={periodType === 'week'} className={`chip${periodType === 'week' ? ' is-on' : ''}`} onClick={() => setPeriodType('week')}>周报</button>
            <button role="tab" aria-selected={periodType === 'month'} className={`chip${periodType === 'month' ? ' is-on' : ''}`} onClick={() => setPeriodType('month')}>月报</button>
          </div>
          <button className="btn btn--primary-soft" onClick={handleReview} disabled={generating}>
            <Sparkles size={14} className={generating ? 'spinning' : ''} />
            生成周复盘
          </button>
          <button className="btn btn--plain" onClick={handleGenerate} disabled={generating}>
            <RefreshCw size={14} className={generating ? 'spinning' : ''} />
            {generating ? '生成中…' : `生成${periodType === 'week' ? '周' : '月'}报`}
          </button>
          <button className="btn btn--quiet" onClick={openExcludeDialog}>
            <SlidersHorizontal size={14} />
            排除联系人
            {excludedSessions.length > 0 && <span className="chip__n">{excludedSessions.length}</span>}
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
        {/* 刀 2 采纳率行（设计-Hermes-MVP 刀 2.3：只聚合，不做花哨漏斗图） */}
        {adoption && (
          <div className="sr-adoption-line">
            <Sparkles size={14} />
            <span>近 7 天：提案 <strong>{adoption.processed}</strong> 条 · 采纳率 <strong>{adoption.rate == null ? '—' : `${adoption.rate}%`}</strong></span>
          </div>
        )}
        {/* 当前报告 */}
        {currentReport && (
          <div className="sr-current-report">
            <div className="seclabel sr-report-meta">
              <span className="seclabel__t">{periodTypeLabel(currentReport.period_type)} · {formatPeriod(currentReport.period_start, currentReport.period_end, currentReport.period_type)}</span>
              <span className="num sr-report-time">生成于 {formatTime(currentReport.created_at)}</span>
            </div>

            {isWeeklyReview ? (
              /* ── 周复盘视图：指标条 → 本机给出的复盘结论 → 阶段分布 → 热/冷/放弃三列 ── */
              <>
                {currentReviewStats && <ReviewMetrics stats={currentReviewStats} />}
                {currentReport.ai_summary && (
                  <div className="sr-conclusion">
                    <div className="seclabel">
                      <span className="seclabel__t">本机给出的复盘结论</span>
                      <span className="sr-sec-hint">生成周复盘时由本机产出并留存</span>
                    </div>
                    <div className="notice notice--accent sr-ai-summary">
                      <Sparkles size={14} className="icon" />
                      <p>{currentReport.ai_summary}</p>
                    </div>
                  </div>
                )}
                {currentReviewStats ? (
                  <ReviewSections stats={currentReviewStats} />
                ) : (
                  <div className="sr-empty-mini" style={{ padding: '20px 4px' }}>
                    该周复盘为旧格式，点击右上角「生成周复盘」重新生成以查看完整视图
                  </div>
                )}
              </>
            ) : (
              /* ── 周报 / 月报视图 ── */
              currentStats && (
                <>
                  <div className="stats sr-stats sr-stats--3">
                    <div className="stat">
                      <div className="stat__n">{currentStats.totalMessages}</div>
                      <div className="stat__l">消息总量</div>
                      <div className="stat__d">{periodTypeLabel(currentReport.period_type)} · 本机会话</div>
                    </div>
                    <div className="stat">
                      <div className="stat__n">{currentStats.activeContacts}</div>
                      <div className="stat__l">活跃客户</div>
                    </div>
                    <div className="stat">
                      <div className="stat__n">
                        {currentStats.dailyMessageCounts.length > 0
                          ? Math.round(currentStats.totalMessages / currentStats.dailyMessageCounts.length)
                          : 0}
                      </div>
                      <div className="stat__l">日均消息</div>
                    </div>
                  </div>

                  {currentReport.ai_summary && (
                    <div className="sr-conclusion">
                      <div className="seclabel"><span className="seclabel__t">AI 分析摘要</span></div>
                      <div className="notice notice--accent sr-ai-summary">
                        <Sparkles size={14} className="icon" />
                        <p>{currentReport.ai_summary}</p>
                      </div>
                    </div>
                  )}

                  <div className="sr-charts-grid">
                    {currentStats.dailyMessageCounts.length > 0 && (
                      <section className="sr-chart-sec">
                        <div className="seclabel"><span className="seclabel__t">每日消息量</span></div>
                        <DailyChart data={currentStats.dailyMessageCounts} />
                      </section>
                    )}

                    {currentStats.topContacts.length > 0 && (
                      <section className="sr-chart-sec">
                        <div className="seclabel"><span className="seclabel__t">Top 互动客户</span></div>
                        <TopContactsChart contacts={currentStats.topContacts} />
                      </section>
                    )}
                  </div>

                  {currentStats.topContacts.length > 0 && (
                    <div className="sr-top-list">
                      <div className="seclabel"><span className="seclabel__t">互动排行</span></div>
                      <div className="sr-top-items">
                        {currentStats.topContacts.map((c, i) => (
                          <div key={c.sessionId} className="sr-top-item">
                            <span className="sr-top-rank num">{i + 1}</span>
                            <Avatar src={c.avatarUrl} name={c.displayName} size={32} />
                            <span className="sr-top-name">{c.displayName}</span>
                            <span className="sr-top-count num">{c.messageCount} 条</span>
                            <button
                              className="sr-top-exclude"
                              title="从复盘中排除该联系人（同事/朋友）"
                              onClick={() => excludeContact(c.sessionId)}
                            >
                              <EyeOff size={14} />
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )
            )}
          </div>
        )}

        {/* 历史报告 */}
        <div className="sr-history">
          <div className="seclabel"><span className="seclabel__t">历史报告</span></div>
          {reports.length === 0 ? (
            <div className="sr-empty">
              <BarChart3 size={40} />
              <p>暂无报告，点击上方按钮生成第一份</p>
            </div>
          ) : (
            <div className="sr-history-list">
              {reports.map(r => {
                let stats: ReportStats | null = null
                try {
                  const parsed = JSON.parse(r.stats)
                  if (r.period_type !== 'weekly_review' && parsed && Array.isArray(parsed.dailyMessageCounts)) {
                    stats = parsed as ReportStats
                  }
                } catch { /* 脏 stats 忽略 */ }
                return (
                  <div
                    key={r.id}
                    className={`sr-history-item ${currentReport?.id === r.id ? 'active' : ''}`}
                    onClick={() => viewReport(r.id)}
                  >
                    <div className="sr-history-info">
                      <span className="sr-history-period">
                        <span className={`sr-history-badge ${r.period_type === 'weekly_review' ? 'review' : ''}`}>
                          {periodTypeLabel(r.period_type)}
                        </span>
                        {formatPeriod(r.period_start, r.period_end, r.period_type)}
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

      {/* 排除联系人弹窗 */}
      {showExcludeDialog && (
        <div className="sr-exclude-mask" onClick={() => setShowExcludeDialog(false)}>
          <div className="sr-exclude-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="sr-exclude-header">
              <div>
                <h3>排除联系人</h3>
                <span className="sr-exclude-hint">同事/朋友等非销售关系会从周报/月报/周复盘的统计中剔除</span>
              </div>
              <button className="sr-exclude-close" onClick={() => setShowExcludeDialog(false)} title="关闭">
                <X size={18} />
              </button>
            </div>

            <input
              className="sr-exclude-search"
              placeholder="搜索联系人..."
              value={excludeSearch}
              onChange={(e) => setExcludeSearch(e.target.value)}
            />

            <div className="sr-exclude-list">
              {sessionsLoading ? (
                <div className="sr-empty-mini sr-exclude-tip">加载联系人...</div>
              ) : (
                (() => {
                  const kw = excludeSearch.trim().toLowerCase()
                  const shown = allSessions.filter(
                    (s) => !kw || s.displayName.toLowerCase().includes(kw) || s.username.toLowerCase().includes(kw)
                  )
                  const sorted = [...shown].sort((a, b) => {
                    const ae = draftExcluded.has(a.username) ? 1 : 0
                    const be = draftExcluded.has(b.username) ? 1 : 0
                    return be - ae // 已排除置顶
                  })
                  if (sorted.length === 0) {
                    return <div className="sr-empty-mini sr-exclude-tip">没有匹配的联系人</div>
                  }
                  return sorted.map((s) => (
                    <label key={s.username} className={`sr-exclude-item ${draftExcluded.has(s.username) ? 'excluded' : ''}`}>
                      <Avatar src={s.avatarUrl} name={s.displayName} size={28} />
                      <span className="sr-exclude-name">{s.displayName}</span>
                      <input
                        type="checkbox"
                        checked={draftExcluded.has(s.username)}
                        onChange={() => {
                          setDraftExcluded((prev) => {
                            const next = new Set(prev)
                            if (next.has(s.username)) next.delete(s.username)
                            else next.add(s.username)
                            return next
                          })
                        }}
                      />
                    </label>
                  ))
                })()
              )}
            </div>

            <div className="sr-exclude-footer">
              <span className="sr-exclude-count">已排除 {draftExcluded.size} 个联系人</span>
              <button className="btn btn--plain" onClick={() => setShowExcludeDialog(false)}>取消</button>
              <button className="btn btn--primary" onClick={saveExcluded} disabled={sessionsLoading}>保存</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
