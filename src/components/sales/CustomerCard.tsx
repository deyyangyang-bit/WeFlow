/**
 * CustomerCard.tsx
 *
 * 客户画像卡片组件，嵌入 ChatPage 会话详情面板。
 * 展示：意向阶段、标签、备注、消息统计、AI 画像、意向历史、跟进待办。
 */

import React, { useEffect, useState, useRef, useCallback } from 'react'
import {
  ChevronDown,
  ChevronRight,
  UserCircle,
  MessageSquare,
  Calendar,
  Tag,
  X,
  Plus,
  Check,
  Circle,
  Clock,
  Sparkles,
  TrendingUp
} from 'lucide-react'
import { useCustomerProfileStore } from '../../stores/customerProfileStore'
import type { IntentTagRecord, TodoRecord } from '../../stores/customerProfileStore'
import './CustomerCard.scss'

// ─── 常量 ────────────────────────────────────────────────────────────────────

const STAGE_OPTIONS = [
  { value: 'unknown', label: '未知', color: '#8b8b8b' },
  { value: '了解', label: '了解', color: '#4a9eff' },
  { value: '比价', label: '比价', color: '#f5a623' },
  { value: '决策', label: '决策', color: '#e74c3c' },
  { value: '成交', label: '成交', color: '#27ae60' },
  { value: '流失', label: '流失', color: '#95a5a6' }
]

function getStageInfo(stage: string) {
  return STAGE_OPTIONS.find((s) => s.value === stage) || STAGE_OPTIONS[0]
}

function formatTime(ts: number | null | undefined): string {
  if (!ts) return '-'
  const d = new Date(ts)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function formatDateTime(ts: number | null | undefined): string {
  if (!ts) return '-'
  const d = new Date(ts)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const h = String(d.getHours()).padStart(2, '0')
  const min = String(d.getMinutes()).padStart(2, '0')
  return `${y}-${m}-${day} ${h}:${min}`
}

// ─── 子组件 ──────────────────────────────────────────────────────────────────

function SectionHeader({ title, icon, collapsed, onToggle }: {
  title: string
  icon: React.ReactNode
  collapsed: boolean
  onToggle: () => void
}) {
  return (
    <div className="cc-section-header" onClick={onToggle}>
      <span className="cc-section-icon">{icon}</span>
      <span className="cc-section-title">{title}</span>
      {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
    </div>
  )
}

function IntentTimeline({ history }: { history: IntentTagRecord[] }) {
  if (history.length === 0) {
    return <div className="cc-empty">暂无意向变更记录</div>
  }
  return (
    <div className="cc-timeline">
      {history.map((item) => {
        const stageInfo = getStageInfo(item.stage)
        return (
          <div key={item.id} className="cc-timeline-item">
            <div className="cc-timeline-dot" style={{ backgroundColor: stageInfo.color }} />
            <div className="cc-timeline-content">
              <span className="cc-timeline-stage" style={{ color: stageInfo.color }}>
                {item.stage}
              </span>
              <span className="cc-timeline-source">
                {item.source === 'ai' ? 'AI' : '手动'}
              </span>
              {item.reason && <span className="cc-timeline-reason">{item.reason}</span>}
              <span className="cc-timeline-time">{formatDateTime(item.created_at)}</span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function TodoList({ todos, onToggle }: { todos: TodoRecord[]; onToggle: (id: number, status: string) => void }) {
  if (todos.length === 0) {
    return <div className="cc-empty">暂无跟进待办</div>
  }
  return (
    <div className="cc-todo-list">
      {todos.map((item) => (
        <div key={item.id} className={`cc-todo-item ${item.status === 'done' ? 'done' : ''}`}>
          <button className="cc-todo-check" onClick={() => onToggle(item.id, item.status)}>
            {item.status === 'done' ? <Check size={12} /> : <Circle size={12} />}
          </button>
          <div className="cc-todo-content">
            <span className="cc-todo-title">{item.title}</span>
            {item.due_at && (
              <span className="cc-todo-due">
                <Clock size={10} /> {formatTime(item.due_at)}
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

// ─── 主组件 ──────────────────────────────────────────────────────────────────

interface CustomerCardProps {
  sessionId: string
}

export default function CustomerCard({ sessionId }: CustomerCardProps) {
  const {
    loading,
    profile,
    messageStats,
    aiProfile,
    aiProfileMeta,
    intentHistory,
    todos,
    loadDetail,
    updateStage,
    updateTags,
    updateNotes,
    toggleTodo,
    reset
  } = useCustomerProfileStore()

  const [mainCollapsed, setMainCollapsed] = useState(false)
  const [aiCollapsed, setAiCollapsed] = useState(true)
  const [intentCollapsed, setIntentCollapsed] = useState(true)
  const [todoCollapsed, setTodoCollapsed] = useState(true)
  const [tagInput, setTagInput] = useState('')
  const [tagInputVisible, setTagInputVisible] = useState(false)
  const [notesDraft, setNotesDraft] = useState<string | null>(null)
  const notesRef = useRef<HTMLTextAreaElement>(null)
  const prevSessionRef = useRef<string | null>(null)

  // 加载数据
  useEffect(() => {
    if (sessionId && sessionId !== prevSessionRef.current) {
      prevSessionRef.current = sessionId
      loadDetail(sessionId)
    }
    return () => {
      // 切换会话时重置
    }
  }, [sessionId, loadDetail])

  // 切换会话时重置
  useEffect(() => {
    return () => { reset() }
  }, [sessionId, reset])

  // 解析 tags
  const tags: string[] = (() => {
    try {
      const parsed = JSON.parse(profile?.tags || '[]')
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  })()

  // 添加标签
  const handleAddTag = useCallback(() => {
    const tag = tagInput.trim()
    if (!tag || tags.includes(tag)) {
      setTagInput('')
      setTagInputVisible(false)
      return
    }
    updateTags(sessionId, [...tags, tag])
    setTagInput('')
    setTagInputVisible(false)
  }, [tagInput, tags, sessionId, updateTags])

  // 删除标签
  const handleRemoveTag = useCallback((tag: string) => {
    updateTags(sessionId, tags.filter((t) => t !== tag))
  }, [tags, sessionId, updateTags])

  // 备注失焦保存
  const handleNotesBlur = useCallback(() => {
    if (notesDraft !== null && notesDraft !== (profile?.notes || '')) {
      updateNotes(sessionId, notesDraft)
    }
    setNotesDraft(null)
  }, [notesDraft, profile?.notes, sessionId, updateNotes])

  const stageInfo = getStageInfo(profile?.stage || 'unknown')

  if (loading && !profile) {
    return (
      <div className="customer-card">
        <div className="cc-loading">加载中...</div>
      </div>
    )
  }

  return (
    <div className="customer-card">
      {/* 主标题 */}
      <div className="cc-header" onClick={() => setMainCollapsed(!mainCollapsed)}>
        <UserCircle size={16} className="cc-header-icon" />
        <span className="cc-header-title">销售画像</span>
        {profile?.stage && profile.stage !== 'unknown' && (
          <span className="cc-stage-badge" style={{ backgroundColor: stageInfo.color }}>
            {stageInfo.label}
          </span>
        )}
        {mainCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
      </div>

      {!mainCollapsed && (
        <div className="cc-body">
          {/* 意向阶段选择 */}
          <div className="cc-field">
            <label className="cc-label">
              <TrendingUp size={12} /> 意向阶段
            </label>
            <select
              className="cc-stage-select"
              value={profile?.stage || 'unknown'}
              onChange={(e) => updateStage(sessionId, e.target.value)}
            >
              {STAGE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>

          {/* 标签 */}
          <div className="cc-field">
            <label className="cc-label">
              <Tag size={12} /> 标签
            </label>
            <div className="cc-tags">
              {tags.map((tag) => (
                <span key={tag} className="cc-tag">
                  {tag}
                  <button className="cc-tag-remove" onClick={() => handleRemoveTag(tag)}>
                    <X size={10} />
                  </button>
                </span>
              ))}
              {tagInputVisible ? (
                <input
                  className="cc-tag-input"
                  value={tagInput}
                  onChange={(e) => setTagInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleAddTag(); if (e.key === 'Escape') { setTagInputVisible(false); setTagInput('') } }}
                  onBlur={handleAddTag}
                  autoFocus
                  placeholder="回车确认"
                />
              ) : (
                <button className="cc-tag-add" onClick={() => setTagInputVisible(true)}>
                  <Plus size={10} /> 添加
                </button>
              )}
            </div>
          </div>

          {/* 备注 */}
          <div className="cc-field">
            <label className="cc-label">备注</label>
            <textarea
              ref={notesRef}
              className="cc-notes"
              value={notesDraft !== null ? notesDraft : (profile?.notes || '')}
              onChange={(e) => setNotesDraft(e.target.value)}
              onBlur={handleNotesBlur}
              placeholder="添加客户备注..."
              rows={2}
            />
          </div>

          {/* 消息统计 */}
          <div className="cc-field">
            <label className="cc-label">
              <MessageSquare size={12} /> 消息统计
            </label>
            <div className="cc-stats">
              <div className="cc-stat-item">
                <span className="cc-stat-value">{messageStats?.total ?? '-'}</span>
                <span className="cc-stat-label">总消息</span>
              </div>
              <div className="cc-stat-item">
                <span className="cc-stat-value">{formatTime(messageStats?.firstContactAt)}</span>
                <span className="cc-stat-label">首次联系</span>
              </div>
              <div className="cc-stat-item">
                <span className="cc-stat-value">{formatTime(messageStats?.lastContactAt)}</span>
                <span className="cc-stat-label">最近联系</span>
              </div>
            </div>
          </div>

          {/* AI 画像 */}
          {aiProfile && (
            <div className="cc-section">
              <SectionHeader
                title="AI 画像"
                icon={<Sparkles size={13} />}
                collapsed={aiCollapsed}
                onToggle={() => setAiCollapsed(!aiCollapsed)}
              />
              {!aiCollapsed && (
                <div className="cc-ai-profile">
                  {aiProfileMeta?.updatedAt && (
                    <div className="cc-ai-meta">
                      <Calendar size={10} />
                      生成于 {formatDateTime(aiProfileMeta.updatedAt)}
                      {aiProfileMeta.rangeStart && aiProfileMeta.rangeEnd && (
                        <span> | 覆盖 {formatTime(aiProfileMeta.rangeStart)} ~ {formatTime(aiProfileMeta.rangeEnd)}</span>
                      )}
                    </div>
                  )}
                  <div className="cc-ai-text">{aiProfile}</div>
                </div>
              )}
            </div>
          )}

          {/* 意向记录 */}
          <div className="cc-section">
            <SectionHeader
              title={`意向记录 (${intentHistory.length})`}
              icon={<TrendingUp size={13} />}
              collapsed={intentCollapsed}
              onToggle={() => setIntentCollapsed(!intentCollapsed)}
            />
            {!intentCollapsed && <IntentTimeline history={intentHistory} />}
          </div>

          {/* 跟进待办 */}
          <div className="cc-section">
            <SectionHeader
              title={`跟进待办 (${todos.filter((t) => t.status !== 'done').length})`}
              icon={<Clock size={13} />}
              collapsed={todoCollapsed}
              onToggle={() => setTodoCollapsed(!todoCollapsed)}
            />
            {!todoCollapsed && <TodoList todos={todos} onToggle={toggleTodo} />}
          </div>
        </div>
      )}
    </div>
  )
}
