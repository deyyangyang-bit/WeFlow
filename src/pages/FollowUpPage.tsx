/**
 * FollowUpPage.tsx
 *
 * 跟进待办页面（V1 产品方案版）
 * 状态机：待跟进 → 已跟进(AI) / 疑似跟进(待确认) / 逾期 / 手动完成 / 已忽略
 */

import React, { useEffect, useState, useCallback } from 'react'
import { Clock, Plus, Check, X, Calendar, Sparkles, Loader2, AlertTriangle, CheckCircle2, HelpCircle, Users } from 'lucide-react'
import { useFollowUpStore } from '../stores/followUpStore'
import type { FollowUpTask } from '../stores/followUpStore'
import './FollowUpPage.scss'

const STATUS_CONFIG: Record<string, { label: string; color: string; icon: React.ReactNode }> = {
  pending: { label: '待跟进', color: '#4a9eff', icon: <Clock size={12} /> },
  followed_ai: { label: '已跟进(AI)', color: '#27ae60', icon: <CheckCircle2 size={12} /> },
  suspected: { label: '疑似跟进', color: '#f5a623', icon: <HelpCircle size={12} /> },
  overdue: { label: '逾期未跟进', color: '#e74c3c', icon: <AlertTriangle size={12} /> },
  manual_done: { label: '手动完成', color: '#8b8b8b', icon: <Check size={12} /> },
  ignored: { label: '已忽略', color: '#bbb', icon: <X size={12} /> },
  done: { label: '已完成', color: '#27ae60', icon: <Check size={12} /> },
}

const ACTION_LABELS: Record<string, string> = {
  reply_customer: '回复客户',
  urge_customer: '催办客户',
  internal_action: '内部动作',
  node_reminder: '节点提醒',
  promise_contact: '约定联系',
  unanswered_quote: '问价未回',
  ai_detected: 'AI识别',
  manual: '手动',
}

function formatTime(ts?: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function formatDate(ts?: number): string {
  if (!ts) return '未定'
  const d = new Date(ts)
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

export default function FollowUpPage() {
  const { loading, tasks, error, loadTasks, createTask, updateTask } = useFollowUpStore()
  const [filter, setFilter] = useState<string>('active')
  const [showCreate, setShowCreate] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newDue, setNewDue] = useState('')
  const [scanning, setScanning] = useState(false)
  const [scanPeriod, setScanPeriod] = useState<'day' | 'week' | 'month'>('week')
  const [scanResult, setScanResult] = useState<string | null>(null)
  const [batchRunning, setBatchRunning] = useState(false)
  const [batchResult, setBatchResult] = useState<string | null>(null)

  useEffect(() => {
    if (filter === 'active') {
      loadTasks()  // 加载全部，前端过滤
    } else {
      loadTasks({ status: filter })
    }
  }, [filter, loadTasks])

  // 前端过滤 + 优先级排序
  const displayTasks = tasks
    .filter(t => {
      if (filter === 'active') return ['pending', 'suspected', 'overdue'].includes(t.status || 'pending')
      if (filter === 'all') return true
      return t.status === filter
    })
    .sort((a, b) => {
      // 优先级排序：逾期 > 疑似 > 待跟进，同级按 priority_score 降序
      const statusOrder: Record<string, number> = { overdue: 0, suspected: 1, pending: 2 }
      const sa = statusOrder[a.status || 'pending'] ?? 3
      const sb = statusOrder[b.status || 'pending'] ?? 3
      if (sa !== sb) return sa - sb
      return (b.priority_score || 0) - (a.priority_score || 0)
    })

  const handleScan = useCallback(async () => {
    setScanning(true)
    setScanResult(null)
    try {
      const result = await window.electronAPI.sales.todoScan(scanPeriod)
      if (result.success) {
        const parts: string[] = []
        if (result.newTasks && result.newTasks > 0) parts.push(`新增 ${result.newTasks} 条待办`)
        if (result.verifiedTasks && result.verifiedTasks.length > 0) parts.push(`核验 ${result.verifiedTasks.length} 条已有待办`)
        setScanResult(parts.length > 0 ? parts.join('，') : '扫描完成，无新发现')
        await loadTasks()
      } else {
        setScanResult(result.error || 'AI 扫描失败')
      }
    } catch (e) {
      setScanResult(String(e))
    } finally {
      setScanning(false)
    }
  }, [loadTasks, scanPeriod])

  const handleBatchProfile = useCallback(async () => {
    setBatchRunning(true)
    setBatchResult(null)
    try {
      const result = await window.electronAPI.sales.profileBatch(50, 6)
      if (result.success) {
        setBatchResult(`批量画像完成，已分析 ${result.processed || 0} 个客户`)
      } else {
        setBatchResult(result.error || '批量画像失败')
      }
    } catch (e) {
      setBatchResult(String(e))
    } finally {
      setBatchRunning(false)
    }
  }, [])

  const handleCreate = useCallback(async () => {
    const title = newTitle.trim()
    if (!title) return
    await createTask({ trigger_type: 'manual', title, due_at: newDue ? new Date(newDue).getTime() : undefined })
    setNewTitle('')
    setNewDue('')
    setShowCreate(false)
  }, [newTitle, newDue, createTask])

  const handleConfirm = useCallback((id: number) => {
    updateTask(id, { status: 'manual_done' })
  }, [updateTask])

  const handleReject = useCallback((id: number) => {
    updateTask(id, { status: 'ignored' })
  }, [updateTask])

  const activeCount = tasks.filter(t => ['pending', 'suspected', 'overdue'].includes(t.status || '')).length

  return (
    <div className="follow-up-page">
      <div className="fu-header">
        <h2><Clock size={20} /> 跟进待办 {activeCount > 0 && <span className="fu-badge">{activeCount}</span>}</h2>
        <div className="fu-header-actions">
          <select className="fu-period-select" value={scanPeriod} onChange={(e) => setScanPeriod(e.target.value as any)}>
            <option value="day">今天</option>
            <option value="week">本周</option>
            <option value="month">本月</option>
          </select>
          <button className="fu-scan-btn" onClick={handleScan} disabled={scanning}>
            {scanning ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />}
            {scanning ? '扫描中...' : 'AI 扫描'}
          </button>
          <button className="fu-create-btn fu-batch-btn" onClick={handleBatchProfile} disabled={batchRunning}>
            {batchRunning ? <Loader2 size={14} className="spin" /> : <Users size={14} />}
            {batchRunning ? '画像中...' : '批量画像'}
          </button>
          <button className="fu-create-btn" onClick={() => setShowCreate(!showCreate)}>
            <Plus size={14} /> 新建
          </button>
        </div>
      </div>

      {/* 筛选 */}
      <div className="fu-filter-bar">
        {([['active', '待处理'], ['pending', '待跟进'], ['suspected', '疑似跟进'], ['overdue', '逾期'], ['all', '全部']] as const).map(([key, label]) => (
          <button key={key} className={`fu-filter-btn ${filter === key ? 'active' : ''}`} onClick={() => setFilter(key)}>
            {label}
          </button>
        ))}
      </div>

      {showCreate && (
        <div className="fu-create-form">
          <input className="fu-input" placeholder="待办内容" value={newTitle} onChange={(e) => setNewTitle(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') handleCreate() }} autoFocus />
          <input className="fu-input fu-input-date" type="datetime-local" value={newDue} onChange={(e) => setNewDue(e.target.value)} />
          <button className="fu-submit-btn" onClick={handleCreate} disabled={!newTitle.trim()}>添加</button>
          <button className="fu-cancel-btn" onClick={() => setShowCreate(false)}>取消</button>
        </div>
      )}

      {error && <div className="fu-error">{error}</div>}
      {scanResult && <div className="fu-scan-result">{scanResult}</div>}
      {batchResult && <div className="fu-scan-result">{batchResult}</div>}

      <div className="fu-list">
        {loading && <div className="fu-loading">加载中...</div>}
        {!loading && displayTasks.length === 0 && (
          <div className="fu-empty"><Clock size={32} /><p>暂无待办</p></div>
        )}
        {!loading && displayTasks.map((task) => {
          const statusCfg = STATUS_CONFIG[task.status || 'pending'] || STATUS_CONFIG.pending
          return (
            <div key={task.id} className={`fu-item status-${task.status || 'pending'}`}>
              <div className="fu-item-main">
                <div className="fu-item-top">
                  <span className="fu-status-badge" style={{ background: statusCfg.color }}>
                    {statusCfg.icon} {statusCfg.label}
                  </span>
                  <span className="fu-action-type">{ACTION_LABELS[task.action_type || task.trigger_type] || task.trigger_type}</span>
                  {task.confidence != null && task.confidence > 0 && (
                    <span className="fu-confidence">{Math.round(task.confidence * 100)}%</span>
                  )}
                </div>
                <div className="fu-item-title">{task.promise_summary || task.title}</div>
                <div className="fu-item-meta">
                  {task.display_name && <span className="fu-customer">{task.display_name}</span>}
                  {task.due_at && (
                    <span className={`fu-due ${task.due_at < Date.now() && task.status === 'pending' ? 'overdue' : ''}`}>
                      <Calendar size={10} /> {formatDate(task.due_at)}
                    </span>
                  )}
                  <span className="fu-time">{formatTime(task.created_at)}</span>
                  {task.created_by === 'ai' && <span className="fu-ai-tag">AI</span>}
                </div>
              </div>
              {/* 操作按钮 */}
              <div className="fu-item-actions">
                {['pending', 'suspected', 'overdue'].includes(task.status || '') && (
                  <>
                    <button className="fu-action-btn confirm" onClick={() => handleConfirm(task.id!)} title="确认完成">
                      <Check size={14} />
                    </button>
                    <button className="fu-action-btn reject" onClick={() => handleReject(task.id!)} title="忽略">
                      <X size={14} />
                    </button>
                  </>
                )}
                {task.status === 'followed_ai' && (
                  <button className="fu-action-btn reject" onClick={() => handleReject(task.id!)} title="撤销AI判断">
                    <X size={14} /> 撤销
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
