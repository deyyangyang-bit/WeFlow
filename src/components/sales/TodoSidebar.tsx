/**
 * TodoSidebar.tsx — 散任务清单侧栏
 *
 * 数据源：todayActionStore.todos（与今日行动主卡流同源同步，fetchToday 顺带刷新）
 * 职责分工：主卡流（getUnifiedSignals）是唯一动作入口——有真实客户的 R1–R8 行动任务
 *           已按客户合并成信号卡；本侧栏只展示【无客户上下文】的散任务
 *           （无 session 的手动待办、SLA 首触卡、物流卡），避免同一批任务在首页重影。
 * 行为：散任务 pending 列表（分页 10 条/页）+ 完成进度统计；checkbox 点击即完成。
 */
import { useEffect, useState } from 'react'
import { Check, ChevronLeft, ChevronRight, ListTodo } from 'lucide-react'
import { useTodayActionStore, type TodoTask } from '../../stores/todayActionStore'
import './TodoSidebar.scss'

const TRIGGER_LABELS: Record<string, string> = {
  manual: '手动',
  sla_lead: '线索首触',
  rule_r8_logistics_overdue: '物流跟进',
  ai_detected: 'AI 识别',
}

const PAGE_SIZE = 10

/** 散任务判定：无客户会话（manual 无 session / SLA 卡）或虚拟会话（logi: 物流卡）→ 只在侧栏出现 */
function isScatteredTask(t: TodoTask): boolean {
  const sid = t.session_id ? String(t.session_id) : ''
  return sid === '' || /^(todo:|lead:|logi:)/.test(sid)
}

export default function TodoSidebar() {
  const { todos, completeTodo } = useTodayActionStore()
  const [page, setPage] = useState(1)

  // 只统计散任务（有客户的任务已在主卡流出现，不重复计）
  const scattered = todos.filter(isScatteredTask)
  // 未完成 = pending/overdue；已完成 = done/skipped/manual_done
  // 分母排除 superseded（自动顶替，非用户行为）、ignored/dismissed（中性），避免虚高
  const pending = scattered.filter(t => t.status === 'pending' || t.status === 'overdue')
  const doneCount = scattered.filter(t => t.status === 'done' || t.status === 'skipped' || t.status === 'manual_done').length
  const total = Math.max(1, pending.length + doneCount)

  // 分页：10 条/页，完成/数据变化后自动钳制回合法页
  const pageCount = Math.max(1, Math.ceil(pending.length / PAGE_SIZE))
  const curPage = Math.min(Math.max(1, page), pageCount)
  const pageItems = pending.slice((curPage - 1) * PAGE_SIZE, curPage * PAGE_SIZE)
  useEffect(() => { if (page > pageCount) setPage(pageCount) }, [pageCount, page])

  return (
    <div className="todo-sidebar">
      <div className="todo-sidebar__header">
        <span className="todo-sidebar__title"><ListTodo size={14} /> 待办清单</span>
        <span className="todo-sidebar__meta">{pending.length} 项未完成</span>
      </div>

      {/* 进度条：纯视觉轨道（数字移到下方统计行，避免窄段文字溢出重叠） */}
      <div className="todo-sidebar__progress">
        <div className="todo-sidebar__progress-active" style={{ width: `${(pending.length / total) * 100}%` }} />
        <div className="todo-sidebar__progress-done" style={{ width: `${(doneCount / total) * 100}%` }} />
      </div>
      <div className="todo-sidebar__stat">已完成 {doneCount} · 共 {total}</div>

      <div className="todo-sidebar__list">
        {pageItems.length === 0 && <div className="todo-sidebar__empty">暂无未完成待办</div>}
        {pageItems.map((t) => (
          <div key={t.id ?? t.title} className="todo-sidebar__item">
            <button
              className="todo-sidebar__checkbox"
              title="标记完成"
              onClick={() => { if (t.id) void completeTodo(t.id) }}
            >
              <Check size={11} />
            </button>
            <div className="todo-sidebar__item-body">
              <div className="todo-sidebar__item-title">{t.title}</div>
              <div className="todo-sidebar__item-meta">
                {t.display_name || '未知'} · {TRIGGER_LABELS[t.trigger_type || ''] || t.trigger_type || '待办'}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* 分页：10 条/页 */}
      {pending.length > PAGE_SIZE && (
        <div className="todo-sidebar__pagination">
          <button
            className="todo-sidebar__page-btn"
            disabled={curPage === 1}
            onClick={() => setPage(curPage - 1)}
            aria-label="上一页"
          >
            <ChevronLeft size={12} />
          </button>
          <span className="todo-sidebar__page-info">{curPage} / {pageCount}</span>
          <button
            className="todo-sidebar__page-btn"
            disabled={curPage === pageCount}
            onClick={() => setPage(curPage + 1)}
            aria-label="下一页"
          >
            <ChevronRight size={12} />
          </button>
        </div>
      )}
    </div>
  )
}
