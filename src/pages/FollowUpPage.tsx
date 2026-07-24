/**
 * FollowUpPage.tsx
 *
 * 跟进待办页面：展示所有客户的跟进任务，支持手动创建、完成、删除。
 */

import React, { useEffect, useState, useCallback } from 'react'
import { Clock, Plus, Check, X, Trash2, Calendar, User } from 'lucide-react'
import { useFollowUpStore } from '../stores/followUpStore'
import type { FollowUpTask } from '../stores/followUpStore'
import './FollowUpPage.scss'

const TRIGGER_LABELS: Record<string, string> = {
  promise_contact: '约定联系',
  unanswered_quote: '问价未回',
  manual: '手动创建',
  ai_detected: 'AI 识别'
}

function formatTime(ts?: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const h = String(d.getHours()).padStart(2, '0')
  const min = String(d.getMinutes()).padStart(2, '0')
  return `${m}-${day} ${h}:${min}`
}

function isOverdue(task: FollowUpTask): boolean {
  return task.status === 'pending' && !!task.due_at && task.due_at < Date.now()
}

export default function FollowUpPage() {
  const { loading, tasks, error, loadTasks, createTask, updateTask } = useFollowUpStore()
  const [filter, setFilter] = useState<'all' | 'pending' | 'done'>('pending')
  const [showCreate, setShowCreate] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newDue, setNewDue] = useState('')

  useEffect(() => {
    loadTasks(filter === 'all' ? undefined : { status: filter })
  }, [filter, loadTasks])

  const handleCreate = useCallback(async () => {
    const title = newTitle.trim()
    if (!title) return
    const dueAt = newDue ? new Date(newDue).getTime() : undefined
    await createTask({ trigger_type: 'manual', title, due_at: dueAt })
    setNewTitle('')
    setNewDue('')
    setShowCreate(false)
  }, [newTitle, newDue, createTask])

  const handleDone = useCallback((id: number) => {
    updateTask(id, { status: 'done' })
  }, [updateTask])

  const handleDismiss = useCallback((id: number) => {
    updateTask(id, { status: 'dismissed' })
  }, [updateTask])

  const pendingCount = tasks.filter(t => t.status === 'pending').length

  return (
    <div className="follow-up-page">
      <div className="fu-header">
        <h2><Clock size={20} /> 跟进待办</h2>
        <div className="fu-header-actions">
          <div className="fu-filter">
            {(['pending', 'done', 'all'] as const).map((f) => (
              <button
                key={f}
                className={`fu-filter-btn ${filter === f ? 'active' : ''}`}
                onClick={() => setFilter(f)}
              >
                {f === 'pending' ? `待办${pendingCount > 0 ? ` (${pendingCount})` : ''}` : f === 'done' ? '已完成' : '全部'}
              </button>
            ))}
          </div>
          <button className="fu-create-btn" onClick={() => setShowCreate(!showCreate)}>
            <Plus size={14} /> 新建
          </button>
        </div>
      </div>

      {/* 新建表单 */}
      {showCreate && (
        <div className="fu-create-form">
          <input
            className="fu-input"
            placeholder="待办内容（如：周三前给张总发报价单）"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleCreate() }}
            autoFocus
          />
          <input
            className="fu-input fu-input-date"
            type="datetime-local"
            value={newDue}
            onChange={(e) => setNewDue(e.target.value)}
          />
          <button className="fu-submit-btn" onClick={handleCreate} disabled={!newTitle.trim()}>
            添加
          </button>
          <button className="fu-cancel-btn" onClick={() => setShowCreate(false)}>
            取消
          </button>
        </div>
      )}

      {error && <div className="fu-error">{error}</div>}

      {/* 任务列表 */}
      <div className="fu-list">
        {loading && <div className="fu-loading">加载中...</div>}
        {!loading && tasks.length === 0 && (
          <div className="fu-empty">
            <Clock size={32} />
            <p>{filter === 'pending' ? '暂无待办事项' : '暂无记录'}</p>
          </div>
        )}
        {!loading && tasks.map((task) => (
          <div key={task.id} className={`fu-item ${task.status} ${isOverdue(task) ? 'overdue' : ''}`}>
            <div className="fu-item-left">
              <button
                className="fu-check-btn"
                onClick={() => task.status === 'pending' ? handleDone(task.id) : undefined}
                disabled={task.status !== 'pending'}
              >
                {task.status === 'done' ? <Check size={14} /> : <span className="fu-circle" />}
              </button>
              <div className="fu-item-content">
                <span className="fu-item-title">{task.title}</span>
                <div className="fu-item-meta">
                  <span className="fu-trigger">{TRIGGER_LABELS[task.trigger_type] || task.trigger_type}</span>
                  {task.due_at && (
                    <span className={`fu-due ${isOverdue(task) ? 'overdue' : ''}`}>
                      <Calendar size={10} /> {formatTime(task.due_at)}
                    </span>
                  )}
                  <span className="fu-time">{formatTime(task.created_at)}</span>
                </div>
              </div>
            </div>
            {task.status === 'pending' && (
              <button className="fu-dismiss-btn" onClick={() => handleDismiss(task.id)} title="忽略">
                <X size={13} />
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
