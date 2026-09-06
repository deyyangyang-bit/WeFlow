/**
 * KnowledgeBasePage.tsx
 * 话术/产品知识库管理页面
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { BookOpen, Plus, Search, Pencil, Trash2, X, Tag, Package, MessageSquareText, HelpCircle, Upload, Sparkles, Clock, CheckCircle2, XCircle, ShieldCheck, Shield, AlertTriangle } from 'lucide-react'
import { useKnowledgeStore, type KnowledgeEntry } from '../stores/knowledgeStore'
import ExtractScriptDialog from '../components/sales/ExtractScriptDialog'
import './KnowledgeBasePage.scss'

// ─── 常量 ────────────────────────────────────────────────────────────────────

const CATEGORY_OPTIONS = [
  { value: '', label: '全部分类' },
  { value: 'product', label: '产品参数' },
  { value: 'script', label: '销售话术' },
  { value: 'faq', label: '常见问题' }
]

const CATEGORY_LABELS: Record<string, string> = {
  product: '产品参数',
  script: '销售话术',
  faq: '常见问题'
}

const CATEGORY_ICONS: Record<string, typeof Package> = {
  product: Package,
  script: MessageSquareText,
  faq: HelpCircle
}

const SCENE_OPTIONS = [
  { value: '', label: '全部场景' },
  { value: '初次接触', label: '初次接触' },
  { value: '报价', label: '报价' },
  { value: '异议处理', label: '异议处理' },
  { value: '售后', label: '售后' }
]

// ─── 工具函数 ─────────────────────────────────────────────────────────────────

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

function parseTags(tagsJson: string): string[] {
  try {
    const parsed = JSON.parse(tagsJson)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

// ─── 知识条目表单 ─────────────────────────────────────────────────────────────

function KnowledgeForm({ onClose }: { onClose: () => void }) {
  const { editingEntry, createEntry, updateEntry } = useKnowledgeStore()
  const isEditing = !!editingEntry

  const [category, setCategory] = useState(editingEntry?.category ?? 'product')
  const [productLine, setProductLine] = useState(editingEntry?.product_line ?? '')
  const [title, setTitle] = useState(editingEntry?.title ?? '')
  const [content, setContent] = useState(editingEntry?.content ?? '')
  const [tagsInput, setTagsInput] = useState(
    editingEntry ? parseTags(editingEntry.tags).join(', ') : ''
  )
  const [scene, setScene] = useState(editingEntry?.scene ?? '')
  const [saving, setSaving] = useState(false)

  const handleSubmit = async () => {
    if (!title.trim() || !content.trim()) return
    setSaving(true)

    const tags = tagsInput
      .split(/[,，]/)
      .map(t => t.trim())
      .filter(Boolean)

    const payload = {
      category,
      product_line: productLine || undefined,
      title: title.trim(),
      content: content.trim(),
      tags,
      scene: scene || undefined
    }

    let success: boolean
    if (isEditing) {
      success = await updateEntry(editingEntry!.id, payload)
    } else {
      success = await createEntry(payload)
    }

    setSaving(false)
    if (success) onClose()
  }

  return (
    <div className="kb-form-overlay" onClick={onClose}>
      <div className="kb-form-dialog" onClick={e => e.stopPropagation()}>
        <div className="kb-form-header">
          <h3>{isEditing ? '编辑知识条目' : '新增知识条目'}</h3>
          <button className="kb-form-close" onClick={onClose}><X size={18} /></button>
        </div>

        <div className="kb-form-body">
          <div className="kb-form-row">
            <label>分类 *</label>
            <select value={category} onChange={e => setCategory(e.target.value)}>
              {CATEGORY_OPTIONS.filter(o => o.value).map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>

          <div className="kb-form-row">
            <label>产品线</label>
            <input
              type="text"
              value={productLine}
              onChange={e => setProductLine(e.target.value)}
              placeholder="如：电动叉车、内燃叉车、仓储设备"
            />
          </div>

          <div className="kb-form-row">
            <label>标题 *</label>
            <input
              type="text"
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="知识条目标题"
            />
          </div>

          <div className="kb-form-row">
            <label>内容 *</label>
            <textarea
              value={content}
              onChange={e => setContent(e.target.value)}
              placeholder="详细的产品参数、话术内容或问答内容"
              rows={6}
            />
          </div>

          <div className="kb-form-row">
            <label>适用场景</label>
            <select value={scene} onChange={e => setScene(e.target.value)}>
              {SCENE_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>

          <div className="kb-form-row">
            <label>标签</label>
            <input
              type="text"
              value={tagsInput}
              onChange={e => setTagsInput(e.target.value)}
              placeholder="用逗号分隔，如：3吨, 电动, 续航"
            />
          </div>
        </div>

        <div className="kb-form-footer">
          <button className="kb-btn kb-btn-secondary" onClick={onClose}>取消</button>
          <button
            className="kb-btn kb-btn-primary"
            onClick={handleSubmit}
            disabled={saving || !title.trim() || !content.trim()}
          >
            {saving ? '保存中...' : isEditing ? '保存修改' : '添加条目'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── 知识条目卡片 ─────────────────────────────────────────────────────────────

/** 刀 1 authority 徽标（published 条目必带）：官方=审定权威口径，社区=默认 */
function AuthorityBadge({ authority }: { authority?: string }) {
  if (authority === 'official') {
    return <span className="kb-badge kb-badge-official"><ShieldCheck size={11} />官方</span>
  }
  return <span className="kb-badge kb-badge-community"><Shield size={11} />社区</span>
}

function KnowledgeCard({ entry, highlighted }: { entry: KnowledgeEntry; highlighted?: boolean }) {
  const { openForm, deleteEntry } = useKnowledgeStore()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const tags = parseTags(entry.tags)
  const IconComp = CATEGORY_ICONS[entry.category] ?? BookOpen
  const isRejected = entry.status === 'rejected'
  const isPublished = entry.status === 'published'

  const handleDelete = async () => {
    if (confirmDelete) {
      await deleteEntry(entry.id)
      setConfirmDelete(false)
    } else {
      setConfirmDelete(true)
      setTimeout(() => setConfirmDelete(false), 3000)
    }
  }

  return (
    <div className={`kb-card ${isRejected ? 'kb-card-rejected' : ''} ${highlighted ? 'kb-card-highlight' : ''}`} data-kb-entry={entry.id}>
      <div className="kb-card-header">
        <span className="kb-card-icon"><IconComp size={16} /></span>
        <span className="kb-card-category">{CATEGORY_LABELS[entry.category] ?? entry.category}</span>
        {entry.product_line && <span className="kb-card-product-line">{entry.product_line}</span>}
        {entry.scene && <span className="kb-card-scene">{entry.scene}</span>}
        <div className="kb-card-actions">
          <button className="kb-card-action" onClick={() => openForm(entry)} title="编辑">
            <Pencil size={14} />
          </button>
          <button
            className={`kb-card-action ${confirmDelete ? 'danger' : ''}`}
            onClick={handleDelete}
            title={confirmDelete ? '再次点击确认删除' : '删除'}
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      <h4 className="kb-card-title">{entry.title}</h4>
      <p className="kb-card-content">{entry.content}</p>

      {tags.length > 0 && (
        <div className="kb-card-tags">
          {tags.map((tag, i) => (
            <span key={i} className="kb-tag"><Tag size={10} />{tag}</span>
          ))}
        </div>
      )}

      <div className="kb-card-footer">
        <span>更新于 {formatTime(entry.updated_at)}</span>
        {isPublished && <AuthorityBadge authority={entry.authority} />}
        {isRejected && (
          <span className="kb-badge kb-badge-rejected"><XCircle size={11} />已拒绝</span>
        )}
      </div>
      {isRejected && entry.reject_reason && (
        <div className="kb-card-reject-reason" title={entry.reject_reason}>
          <AlertTriangle size={11} />拒因：{entry.reject_reason}
        </div>
      )}
    </div>
  )
}

// ─── 待审核区（刀 1：staging 列表 + 逐条发布/拒绝，拒绝必填拒因）────────────────

function ReviewItem({ entry }: { entry: KnowledgeEntry }) {
  const { reviewEntry } = useKnowledgeStore()
  const [rejecting, setRejecting] = useState(false)
  const [reason, setReason] = useState('')
  const [official, setOfficial] = useState(false)
  const [busy, setBusy] = useState(false)
  const IconComp = CATEGORY_ICONS[entry.category] ?? BookOpen

  const handlePublish = async () => {
    setBusy(true)
    const r = await reviewEntry(entry.id, 'publish', { official })
    setBusy(false)
    if (!r.success) alert(`发布失败：${r.error || '未知错误'}`)
  }

  const handleReject = async () => {
    if (!reason.trim()) return // 拒因必填（PRD 铁律：沉底留档反哺，不删）
    setBusy(true)
    const r = await reviewEntry(entry.id, 'reject', { reason: reason.trim() })
    setBusy(false)
    if (r.success) {
      setRejecting(false)
      setReason('')
    } else {
      alert(`拒绝失败：${r.error || '未知错误'}`)
    }
  }

  return (
    <div className="kb-review-item">
      <div className="kb-review-item-main">
        <div className="kb-review-item-head">
          <span className="kb-card-icon"><IconComp size={14} /></span>
          <span className="kb-review-item-title">{entry.title}</span>
          <span className="kb-card-category">{CATEGORY_LABELS[entry.category] ?? entry.category}</span>
          {entry.product_line && <span className="kb-card-product-line">{entry.product_line}</span>}
          {entry.scene && <span className="kb-card-scene">{entry.scene}</span>}
          <span className="kb-review-item-time">更新于 {formatTime(entry.updated_at)}</span>
        </div>
        <p className="kb-review-item-content">{entry.content}</p>
        {rejecting && (
          <div className="kb-review-reject-box">
            <textarea
              value={reason}
              onChange={e => setReason(e.target.value)}
              placeholder="拒因必填：如与产品库冲突、参数有误、内容过时…（留档反哺，不删除条目）"
              rows={2}
              autoFocus
            />
            <div className="kb-review-reject-actions">
              <button className="kb-btn kb-btn-secondary" onClick={() => { setRejecting(false); setReason('') }}>取消</button>
              <button className="kb-btn kb-btn-danger" onClick={handleReject} disabled={busy || !reason.trim()}>
                <XCircle size={14} />确认拒绝
              </button>
            </div>
          </div>
        )}
      </div>
      {!rejecting && (
        <div className="kb-review-item-actions">
          <label className="kb-review-official" title="标记为官方权威口径（官方与社区冲突时以官方为准）">
            <input type="checkbox" checked={official} onChange={e => setOfficial(e.target.checked)} />
            <ShieldCheck size={13} />官方
          </label>
          <button className="kb-btn kb-btn-primary" onClick={handlePublish} disabled={busy}>
            <CheckCircle2 size={14} />发布
          </button>
          <button className="kb-btn kb-btn-secondary" onClick={() => setRejecting(true)} disabled={busy}>
            <XCircle size={14} />拒绝
          </button>
        </div>
      )}
    </div>
  )
}

function ReviewSection({ entries }: { entries: KnowledgeEntry[] }) {
  if (entries.length === 0) return null
  return (
    <div className="kb-review-section">
      <div className="kb-review-header">
        <Clock size={16} />
        <h3>待审核</h3>
        <span className="kb-review-count">{entries.length}</span>
        <span className="kb-review-hint">发布后才会被知识问答引用 · 价格类条目请与产品库对账，冲突以产品库为准</span>
      </div>
      <div className="kb-review-list">
        {entries.map(entry => <ReviewItem key={entry.id} entry={entry} />)}
      </div>
    </div>
  )
}

// ─── 主页面 ──────────────────────────────────────────────────────────────────

export default function KnowledgeBasePage() {
  const {
    entries, total, loading,
    searchKeyword, filterCategory,
    showForm,
    fetchList, search,
    setSearchKeyword, setFilterCategory,
    openForm, closeForm
  } = useKnowledgeStore()

  const [searchInput, setSearchInput] = useState('')
  const [extractOpen, setExtractOpen] = useState(false)
  const [batchExtractOpen, setBatchExtractOpen] = useState(false)

  // 刀 1 治理分区：staging 进待审核区；主列表 published 在前、rejected 沉底留档
  // （status 缺失的行视为 staging，防迁移前旧快照漏审）
  const stagingEntries = useMemo(() => entries.filter(e => (e.status ?? 'staging') === 'staging'), [entries])
  const gridEntries = useMemo(() => {
    const published = entries.filter(e => e.status === 'published')
    const rejected = entries.filter(e => e.status === 'rejected')
    return [...published, ...rejected]
  }, [entries])

  // 刀 3 引用跳转深链：/knowledge-base state.focusEntryId → 滚动定位 + 短暂高亮
  const location = useLocation()
  const [highlightId, setHighlightId] = useState<number | null>(null)
  useEffect(() => {
    const focusId = Number((location.state as { focusEntryId?: number } | null)?.focusEntryId || 0)
    if (!focusId) return
    setHighlightId(focusId)
    const scrollTimer = window.setTimeout(() => {
      document.querySelector(`[data-kb-entry="${focusId}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 300)
    const clearTimer = window.setTimeout(() => setHighlightId(null), 4500)
    return () => { window.clearTimeout(scrollTimer); window.clearTimeout(clearTimer) }
  }, [location.state])

  // 初始加载
  useEffect(() => {
    fetchList()
  }, [fetchList])

  // 分类过滤变化时重新加载
  useEffect(() => {
    if (searchKeyword) {
      search(searchKeyword)
    } else {
      fetchList({ category: filterCategory || undefined })
    }
  }, [filterCategory])

  // 搜索防抖
  const handleSearch = useCallback((value: string) => {
    setSearchInput(value)
    const timer = setTimeout(() => {
      if (value.trim()) {
        search(value.trim())
      } else {
        setSearchKeyword('')
        fetchList({ category: filterCategory || undefined })
      }
    }, 300)
    return () => clearTimeout(timer)
  }, [search, setSearchKeyword, fetchList, filterCategory])

  // ─── CSV 批量导入 ─────────────────────────────────────────────────────────
  const [importing, setImporting] = useState(false)
  const [importResult, setImportResult] = useState<{ imported: number; skipped: number } | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleImportClick = useCallback(() => {
    fileInputRef.current?.click()
  }, [])

  const handleFileSelected = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    // 重置 input 以允许重复选择同一文件
    e.target.value = ''

    try {
      const csvContent = await file.text()
      if (!csvContent.trim()) {
        alert('CSV 文件为空')
        return
      }

      setImporting(true)
      setImportResult(null)
      const res = await (window as any).electronAPI.sales.kbImportCsv(csvContent)
      if (res?.success) {
        setImportResult({ imported: res.imported, skipped: res.skipped })
        fetchList({ category: filterCategory || undefined })
      } else {
        alert('导入失败: ' + (res?.error || '未知错误'))
      }
    } catch (err: any) {
      alert('导入出错: ' + (err?.message || String(err)))
    } finally {
      setImporting(false)
    }
  }, [fetchList, filterCategory])

  return (
    <div className="kb-page">
      {/* 话术提炼弹窗（单选） */}
      <ExtractScriptDialog open={extractOpen} onClose={() => setExtractOpen(false)} />

      {/* 话术提炼弹窗（批量） */}
      <ExtractScriptDialog open={batchExtractOpen} onClose={() => setBatchExtractOpen(false)} batch />

      <div className="kb-page-header">
        <div className="kb-page-title">
          <BookOpen size={22} />
          <h2>知识库</h2>
          <span className="kb-page-count">{total} 条</span>
        </div>

        <div className="kb-page-toolbar">
          <div className="kb-search-box">
            <Search size={16} />
            <input
              type="text"
              value={searchInput}
              onChange={e => handleSearch(e.target.value)}
              placeholder="搜索标题、内容、标签..."
            />
            {searchInput && (
              <button className="kb-search-clear" onClick={() => {
                setSearchInput('')
                setSearchKeyword('')
                fetchList({ category: filterCategory || undefined })
              }}>
                <X size={14} />
              </button>
            )}
          </div>

          <select
            className="kb-category-filter"
            value={filterCategory}
            onChange={e => setFilterCategory(e.target.value)}
          >
            {CATEGORY_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>

          <button className="kb-btn kb-btn-secondary" onClick={handleImportClick} disabled={importing}>
            <Upload size={16} />
            {importing ? '导入中...' : '批量导入'}
          </button>

          <button className="kb-btn kb-btn-accent" onClick={() => setExtractOpen(true)}>
            <Sparkles size={16} />
            提炼话术
          </button>

          <button className="kb-btn kb-btn-accent" onClick={() => setBatchExtractOpen(true)}>
            <Sparkles size={16} />
            一键提炼
          </button>

          <button className="kb-btn kb-btn-primary" onClick={() => openForm()}>
            <Plus size={16} />
            新增
          </button>

          <input
            ref={fileInputRef}
            type="file"
            accept=".csv"
            style={{ display: 'none' }}
            onChange={handleFileSelected}
          />
        </div>
      </div>

      {importResult && (
        <div className="kb-import-toast">
          ✅ 导入完成：成功 {importResult.imported} 条，跳过 {importResult.skipped} 条
          <button onClick={() => setImportResult(null)}><X size={12} /></button>
        </div>
      )}

      <div className="kb-page-body">
        <ReviewSection entries={stagingEntries} />
        {loading ? (
          <div className="kb-loading">加载中...</div>
        ) : gridEntries.length === 0 ? (
          <div className="kb-empty">
            <BookOpen size={48} />
            <p>{searchKeyword ? '没有找到匹配的条目' : stagingEntries.length > 0 ? '没有已发布的条目，先在上方「待审核」区发布' : '知识库为空，点击"新增"添加第一条知识'}</p>
          </div>
        ) : (
          <div className="kb-card-grid">
            {gridEntries.map(entry => (
              <KnowledgeCard key={entry.id} entry={entry} highlighted={highlightId === entry.id} />
            ))}
          </div>
        )}
      </div>

      {showForm && <KnowledgeForm onClose={closeForm} />}
    </div>
  )
}
