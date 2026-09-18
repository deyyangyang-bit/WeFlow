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
import { Check, ChevronLeft, ChevronRight } from 'lucide-react'
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
  // 真实总数（未完成 + 已完成）：空列表就是 0，不用 Math.max(1, …) 把保护值当真实数量展示
  const total = pending.length + doneCount
  // 仅进度条做除零保护；两个展示数字都取真实值
  const progressPct = total > 0 ? (doneCount / total) * 100 : 0

  // 分页：10 条/页，完成/数据变化后自动钳制回合法页
  const pageCount = Math.max(1, Math.ceil(pending.length / PAGE_SIZE))
  const curPage = Math.min(Math.max(1, page), pageCount)
  const pageItems = pending.slice((curPage - 1) * PAGE_SIZE, curPage * PAGE_SIZE)
  useEffect(() => { if (page > pageCount) setPage(pageCount) }, [pageCount, page])

  return (
    <div className="side todo-sidebar">
      {/* 右栏抬头：细线 + 等宽进度数字（概念稿侧栏语法）。
          两个数字都取真实值：未完成 = 真实待办条数（空态显示 0，不再显示 0 / 1）；
          已完成/共 = 真实分子分母（总数 = 未完成 + 已完成）。 */}
      <div className="side-head">
        <span className="side-head__t">今日待办</span>
        <span className="num todo-sidebar__count">未完成 {pending.length}</span>
      </div>
      <div className="bar todo-sidebar__bar" aria-hidden="true">
        <i style={{ width: `${progressPct}%` }} />
      </div>
      <div className="num todo-sidebar__progress">已完成 {doneCount} / 共 {total}</div>

      <div className="todo-sidebar__list">
        {pageItems.length === 0 && <div className="todo-sidebar__empty">暂无未完成待办</div>}
        {pageItems.map((t) => (
          <div key={t.id ?? t.title} className="todo">
            <button
              className="checkbox todo-sidebar__checkbox"
              title="标记完成"
              aria-label="标记完成"
              onClick={() => { if (t.id) void completeTodo(t.id) }}
            >
              <Check size={11} strokeWidth={2.4} />
            </button>
            <div>
              <div className="todo__t">{t.title}</div>
              <div className="todo__m">
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
            className="iconbtn todo-sidebar__page-btn"
            disabled={curPage === 1}
            onClick={() => setPage(curPage - 1)}
            aria-label="上一页"
          >
            <ChevronLeft size={12} />
          </button>
          <span className="num todo-sidebar__page-info">{curPage} / {pageCount}</span>
          <button
            className="iconbtn todo-sidebar__page-btn"
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
