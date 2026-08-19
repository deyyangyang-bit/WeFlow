/**
 * TodoSidebar.tsx — 待办清单侧栏(v4 视觉)
 *
 * 数据源：todayActionStore.todos（与今日行动主卡流同源同步，fetchToday 顺带刷新）
 * 行为：展示 pending/overdue 列表 + 完成进度；checkbox 点击即完成；「查看全部」跳 /follow-up
 */
import { useNavigate } from 'react-router-dom'
import { Check, ListTodo } from 'lucide-react'
import { useTodayActionStore, type TodoTask } from '../../stores/todayActionStore'
import './TodoSidebar.scss'

const TRIGGER_LABELS: Record<string, string> = {
  rule_r0_unknown_followup: '待确认',
  rule_r1_quoted_followup: '报价跟进',
  rule_r2_negotiating_stall: '谈判跟进',
  rule_r3_new_no_reply: '新客响应',
  rule_r4_contacted_silent: '激活沉默',
  rule_r5_dormant_wake: '沉默唤醒',
  rule_r6_consider_drop: '考虑放弃',
  manual: '手动',
  ai_detected: 'AI 识别',
}

const MAX_VISIBLE = 8

export default function TodoSidebar() {
  const { todos, completeTodo } = useTodayActionStore()
  const navigate = useNavigate()

  const pending = todos.filter(t => t.status === 'pending' || t.status === 'overdue')
  const doneCount = todos.filter(t => t.status === 'done' || t.status === 'skipped').length
  const total = Math.max(1, todos.length)

  return (
    <div className="todo-sidebar">
      <div className="todo-sidebar__header">
        <span className="todo-sidebar__title"><ListTodo size={14} /> 待办清单</span>
        <span className="todo-sidebar__meta">{pending.length} 项未完成</span>
      </div>

      <div className="todo-sidebar__progress">
        <div
          className="todo-sidebar__progress-pending"
          style={{ width: `${(pending.length / total) * 100}%` }}
        >
          {pending.length > 0 ? pending.length : ''}
        </div>
        <div
          className="todo-sidebar__progress-done"
          style={{ width: `${(doneCount / total) * 100}%` }}
        >
          已完成 {doneCount}
        </div>
      </div>

      <div className="todo-sidebar__list">
        {pending.length === 0 && <div className="todo-sidebar__empty">暂无未完成待办</div>}
        {pending.slice(0, MAX_VISIBLE).map((t) => (
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
        {pending.length > MAX_VISIBLE && (
          <div className="todo-sidebar__more">还有 {pending.length - MAX_VISIBLE} 项…</div>
        )}
      </div>

      <div className="todo-sidebar__footer">
        <button className="todo-sidebar__viewall" onClick={() => navigate('/follow-up')}>
          查看全部
        </button>
      </div>
    </div>
  )
}
