/**
 * CustomerListPage.tsx
 * 客户列表页：集中管理客户，按阶段筛选/搜索/排序，点击行展开画像抽屉。
 */
import React, { useEffect, useState, useCallback, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Search, X, Users } from 'lucide-react'
import { Avatar } from '../components/Avatar'
import CustomerCard from '../components/sales/CustomerCard'
import { useCustomerListStore } from '../stores/customerListStore'
import type { CustomerRow } from '../stores/customerListStore'
import './CustomerListPage.scss'

const STAGE_TABS = ['全部', '了解', '比价', '决策', '成交', '流失'] as const
const STAGE_COLOR: Record<string, string> = {
  '决策': '#e74c3c', '比价': '#f5a623', '了解': '#4a9eff',
  '成交': '#27ae60', '流失': '#95a5a6', 'unknown': '#95a5a6'
}
const SORT_OPTIONS: Array<{ value: 'updated_at' | 'last_contact_at' | 'stage'; label: string }> = [
  { value: 'updated_at', label: '最近更新' },
  { value: 'last_contact_at', label: '最近联系' },
  { value: 'stage', label: '按阶段' }
]

function silenceDays(lastContactAt?: number | null): string {
  if (!lastContactAt) return '-'
  const days = Math.floor((Date.now() - lastContactAt) / 86400000)
  return `${days}天`
}

function parseTags(tags?: string): string[] {
  try {
    const arr = JSON.parse(tags || '[]')
    return Array.isArray(arr) ? arr : []
  } catch { return [] }
}

export default function CustomerListPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const { customers, loading, filters, loadCustomers, setFilter } = useCustomerListStore()
  const [searchInput, setSearchInput] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 初始化：读 URL ?stage=
  useEffect(() => {
    const stage = searchParams.get('stage') || undefined
    loadCustomers({ stage, sortBy: 'updated_at' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 搜索防抖
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      setFilter({ search: searchInput.trim() || undefined })
    }, 300)
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput])

  const handleTab = useCallback((tab: string) => {
    const stage = tab === '全部' ? undefined : tab
    if (stage) setSearchParams({ stage })
    else setSearchParams({})
    setFilter({ stage })
  }, [setFilter, setSearchParams])

  const handleSort = useCallback((sortBy: 'updated_at' | 'last_contact_at' | 'stage') => {
    setFilter({ sortBy })
  }, [setFilter])

  const activeTab = filters.stage && STAGE_TABS.includes(filters.stage as any) ? filters.stage : '全部'

  return (
    <div className="customer-list-page">
      <div className="cl-header">
        <h2><Users size={20} /> 客户管理 <span className="cl-count">{customers.length}</span></h2>
        <div className="cl-toolbar">
          <div className="cl-search">
            <Search size={14} />
            <input
              placeholder="搜索客户名"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
            />
            {searchInput && <button className="cl-clear" onClick={() => setSearchInput('')}><X size={12} /></button>}
          </div>
          <select className="cl-sort" value={filters.sortBy || 'updated_at'} onChange={(e) => handleSort(e.target.value as any)}>
            {SORT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
      </div>

      <div className="cl-tabs">
        {STAGE_TABS.map((tab) => (
          <button key={tab} className={`cl-tab ${activeTab === tab ? 'active' : ''}`} onClick={() => handleTab(tab)}>
            {tab}
          </button>
        ))}
      </div>

      <div className="cl-body">
        {loading && <div className="cl-empty">加载中...</div>}
        {!loading && customers.length === 0 && <div className="cl-empty">暂无客户，去聊天页详情面板或「批量画像」生成客户档案</div>}
        {!loading && customers.map((row) => {
          const tags = parseTags(row.tags)
          const sd = silenceDays(row.last_contact_at)
          const muted = row.last_contact_at && (Date.now() - row.last_contact_at) > 30 * 86400000
          return (
            <div
              key={row.id}
              className={`cl-row ${selectedId === row.session_id ? 'selected' : ''}`}
              onClick={() => setSelectedId(row.session_id)}
            >
              <Avatar name={row.display_name || row.session_id} size={38} />
              <div className="cl-row-main">
                <div className="cl-row-top">
                  <span className="cl-name">{row.display_name || row.session_id}</span>
                  <span className="cl-stage-badge" style={{ background: (STAGE_COLOR[row.stage] || '#95a5a6') + '1a', color: STAGE_COLOR[row.stage] || '#95a5a6' }}>
                    {row.stage === 'unknown' ? '未知' : row.stage}
                  </span>
                  <span className={`cl-silence ${muted ? 'muted' : ''}`}>{sd}</span>
                </div>
                <div className="cl-row-bottom">
                  {tags.slice(0, 3).map((t) => <span key={t} className="cl-tag">{t}</span>)}
                  {tags.length > 3 && <span className="cl-tag more">+{tags.length - 3}</span>}
                  {row.notes && <span className="cl-notes">{row.notes.slice(0, 30)}</span>}
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {/* 画像抽屉 */}
      {selectedId && (
        <>
          <div className="cl-drawer-backdrop" onClick={() => setSelectedId(null)} />
          <div className="cl-drawer">
            <div className="cl-drawer-header">
              <span>客户画像</span>
              <button onClick={() => setSelectedId(null)}><X size={16} /></button>
            </div>
            <div className="cl-drawer-body">
              <CustomerCard sessionId={selectedId} />
            </div>
          </div>
        </>
      )}
    </div>
  )
}
