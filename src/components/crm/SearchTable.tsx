/**
 * SearchTable.tsx —— 搜索表格页骨架（借鉴 Arco Design Pro search-table，2026-08-25）
 *
 * 受控组件：数据与分页由调用方持有（WeFlow 数据源是 IPC，没有 axios 层），
 * 组件负责「筛选栏 + 工具栏 + 表格 + 分页条」的布局编排，不改数据获取方式。
 *
 * 使用：
 *   <SearchTable columns={cols} data={rows} rowKey={(r) => r.id}
 *     page={page} onPageChange={setPage}
 *     filterBar={<状态筛选 + 搜索框 />} toolbar={<新建合同按钮 />}
 *     onRowClick={select} rowClassName={(r) => (selected?.id === r.id ? 'active' : '')} />
 *
 * 约定：筛选/搜索变化时调用方自行 setPage(1) 并重新取数（数据量小也可前端过滤直接喂 data）。
 */
import { type ReactNode } from 'react'
import './SearchTable.scss'

/** 表格列定义：key 仅作标识，渲染交给 render（数据形态各异，不用内置字段映射） */
export type SearchTableColumn<T> = {
  key: string
  title: string
  render?: (row: T) => ReactNode
  className?: string
  width?: number
}

type SearchTableProps<T> = {
  columns: Array<SearchTableColumn<T>>
  data: T[]
  rowKey: (row: T) => string | number
  /** 当前页（1 起） */
  page: number
  onPageChange: (page: number) => void
  pageSize?: number
  /** 总条数（默认 data.length，后端分页时可显式传） */
  total?: number
  loading?: boolean
  /** 顶部筛选栏（状态下拉/关键字搜索等） */
  filterBar?: ReactNode
  /** 右上操作按钮组（新增/导入/导出） */
  toolbar?: ReactNode
  onRowClick?: (row: T) => void
  rowClassName?: (row: T) => string
  emptyText?: string
}

/** 分页条：上一页/下一页 + 第 n / m 页 · 共 N 条（仅当 total > pageSize 时显示） */
function Pager(props: { page: number; totalPages: number; total: number; onPage: (p: number) => void }) {
  const { page, totalPages, total, onPage } = props
  if (totalPages <= 1) return null
  return (
    <div className="search-table__pager">
      <button className="crm-btn" disabled={page <= 1} onClick={() => onPage(page - 1)}>上一页</button>
      <span className="search-table__pager-info">第 {page} / {totalPages} 页 · 共 {total} 条</span>
      <button className="crm-btn" disabled={page >= totalPages} onClick={() => onPage(page + 1)}>下一页</button>
    </div>
  )
}

export default function SearchTable<T>(props: SearchTableProps<T>) {
  const { columns, data, rowKey, page, onPageChange, pageSize = 10, total, loading, filterBar, toolbar, onRowClick, rowClassName, emptyText = '暂无数据' } = props
  const totalCount = total ?? data.length
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize))
  const cur = Math.min(page, totalPages)
  // 前端分页切片（后端分页时调用方直接传当页 data + 显式 total）
  const rows = total === undefined ? data.slice((cur - 1) * pageSize, cur * pageSize) : data
  return (
    <div className="search-table">
      {(filterBar || toolbar) && (
        <div className="search-table__bar">
          <div className="search-table__filters">{filterBar}</div>
          <div className="search-table__toolbar">{toolbar}</div>
        </div>
      )}
      <div className="search-table__grid">
        <table>
          <thead>
            <tr>{columns.map((c) => <th key={c.key} className={c.className} style={c.width ? { width: c.width } : undefined}>{c.title}</th>)}</tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={columns.length} className="search-table__state">加载中…</td></tr>}
            {!loading && rows.length === 0 && <tr><td colSpan={columns.length} className="search-table__state">{emptyText}</td></tr>}
            {!loading && rows.map((r) => (
              <tr
                key={rowKey(r)}
                className={rowClassName?.(r)}
                onClick={onRowClick ? () => onRowClick(r) : undefined}
                style={onRowClick ? { cursor: 'pointer' } : undefined}
              >
                {columns.map((c) => (
                  <td key={c.key} className={c.className}>{c.render ? c.render(r) : String((r as Record<string, unknown>)[c.key] ?? '')}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pager page={cur} totalPages={totalPages} total={totalCount} onPage={onPageChange} />
    </div>
  )
}
