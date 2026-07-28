/**
 * TodayActionPage.tsx
 * 今日行动清单 — 产品核心页面
 * 用户每天打开看到的第一个屏幕：谁该联系、为什么、说什么、打勾完成。
 */
import { useCallback, useEffect, useState } from 'react'
import { Check, ChevronRight, Copy, RefreshCw, SkipForward, Sparkles } from 'lucide-react'
import { useTodayActionStore, type ActionItem } from '../stores/todayActionStore'
import './TodayActionPage.scss'

const STAGE_LABELS: Record<string, { text: string; color: string }> = {
  new: { text: '新客', color: '#3b82f6' },
  contacted: { text: '已沟通', color: '#8b5cf6' },
  quoted: { text: '已报价', color: '#f59e0b' },
  negotiating: { text: '谈判中', color: '#ef4444' },
  won: { text: '成交', color: '#10b981' },
  lost: { text: '流失', color: '#6b7280' },
  dormant: { text: '沉默', color: '#9ca3af' },
  unknown: { text: '未知', color: '#6b7280' }
}

const PRIORITY_LABELS: Record<string, { text: string; color: string }> = {
  urgent: { text: '紧急', color: '#dc2626' },
  high: { text: '高', color: '#ea580c' },
  medium: { text: '中', color: '#ca8a04' },
  low: { text: '低', color: '#2563eb' },
  info: { text: '参考', color: '#6b7280' }
}

function ActionCard({ item }: { item: ActionItem }) {
  const { completeItem, fetchSuggestion } = useTodayActionStore()
  const [copied, setCopied] = useState(false)
  const [loadingSuggestion, setLoadingSuggestion] = useState(false)

  const stage = STAGE_LABELS[item.stage] || STAGE_LABELS.unknown
  const priority = PRIORITY_LABELS[item.priority] || PRIORITY_LABELS.info

  const handleCopy = useCallback(async () => {
    if (!item.suggestion) return
    try {
      await navigator.clipboard.writeText(item.suggestion)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch { /* ignore */ }
  }, [item.suggestion])

  const handleSuggest = useCallback(async () => {
    setLoadingSuggestion(true)
    await fetchSuggestion(item)
    setLoadingSuggestion(false)
  }, [item, fetchSuggestion])

  return (
    <div className={`action-card priority-${item.priority}`}>
      <div className="action-card__header">
        <div className="action-card__avatar">
          {(item.displayName || '?')[0]}
        </div>
        <div className="action-card__meta">
          <div className="action-card__name-row">
            <span className="action-card__name">{item.displayName}</span>
            <span className="action-card__stage" style={{ background: stage.color }}>{stage.text}</span>
            <span className="action-card__priority" style={{ color: priority.color }}>{priority.text}</span>
          </div>
          <div className="action-card__reason">{item.reason}</div>
        </div>
        <div className="action-card__silent">{item.silentDays}天</div>
      </div>

      <div className="action-card__title">{item.title}</div>

      {item.suggestion && (
        <div className="action-card__suggestion">
          <div className="action-card__suggestion-text">{item.suggestion}</div>
          <button className="action-card__copy-btn" onClick={handleCopy} title="复制话术">
            {copied ? <Check size={14} /> : <Copy size={14} />}
            {copied ? '已复制' : '复制'}
          </button>
        </div>
      )}

      <div className="action-card__actions">
        {!item.suggestion && (
          <button
            className="action-card__btn action-card__btn--suggest"
            onClick={handleSuggest}
            disabled={loadingSuggestion}
          >
            <Sparkles size={14} />
            {loadingSuggestion ? '生成中...' : 'AI 话术'}
          </button>
        )}
        {item.notConfigured && (
          <span className="action-card__suggest-error">请在 设置 → AI 设置 中配置模型</span>
        )}
        {!item.notConfigured && item.suggestionError && (
          <span className="action-card__suggest-error">AI 调用失败：{item.suggestionError}</span>
        )}
        <div className="action-card__spacer" />
        <button
          className="action-card__btn action-card__btn--skip"
          onClick={() => completeItem(item.id, 'skipped')}
        >
          <SkipForward size={14} />
          跳过
        </button>
        <button
          className="action-card__btn action-card__btn--done"
          onClick={() => completeItem(item.id, 'done')}
        >
          <Check size={14} />
          完成
        </button>
      </div>
    </div>
  )
}

export default function TodayActionPage() {
  const { items, stats, loading, error, fetchToday } = useTodayActionStore()
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    fetchToday()
  }, [fetchToday])

  const handleRefresh = useCallback(async () => {
    setRefreshing(true)
    await fetchToday()
    // 保证旋转动画至少转 800ms，让用户看到反馈
    setTimeout(() => setRefreshing(false), 800)
  }, [fetchToday])

  return (
    <div className="today-action-page">
      <div className="today-action-page__header">
        <h1 className="today-action-page__title">今日行动</h1>
        <button className="today-action-page__refresh" onClick={handleRefresh} disabled={refreshing}>
          <RefreshCw size={16} className={refreshing ? 'spinning' : ''} />
        </button>
      </div>

      {stats && (
        <div className="today-action-page__stats">
          <div className="stat-chip">
            <span className="stat-chip__value">{stats.todayPending}</span>
            <span className="stat-chip__label">待跟进</span>
          </div>
          <div className="stat-chip stat-chip--warn">
            <span className="stat-chip__value">{stats.overdue}</span>
            <span className="stat-chip__label">逾期</span>
          </div>
          <div className="stat-chip">
            <span className="stat-chip__value">{stats.newThisWeek}</span>
            <span className="stat-chip__label">本周新增</span>
          </div>
          <div className="stat-chip">
            <span className="stat-chip__value">{stats.pipelineTotal}</span>
            <span className="stat-chip__label">管道中</span>
          </div>
        </div>
      )}

      {error && (
        <div className="today-action-page__error">
          {error}
          <button onClick={fetchToday}>重试</button>
        </div>
      )}

      {loading && items.length === 0 && (
        <div className="today-action-page__loading">
          <RefreshCw size={24} className="spinning" />
          <p>正在分析客户数据...</p>
        </div>
      )}

      {!loading && items.length === 0 && !error && (
        <div className="today-action-page__empty">
          <div className="today-action-page__empty-icon">🎉</div>
          <p>今天全部跟完了！</p>
          {stats && <p className="today-action-page__empty-sub">管道中还有 {stats.pipelineTotal} 个客户</p>}
        </div>
      )}

      <div className="today-action-page__list">
        {items.map(item => (
          <ActionCard key={item.id} item={item} />
        ))}
      </div>
    </div>
  )
}
