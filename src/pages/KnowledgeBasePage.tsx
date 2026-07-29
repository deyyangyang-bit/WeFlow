/**
 * KnowledgeBasePage.tsx
 * 话术/产品知识库管理页面
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BookOpen, Plus, Search, Pencil, Trash2, X, Tag, Package, MessageSquareText, HelpCircle, Upload, Sparkles } from 'lucide-react'
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

function KnowledgeCard({ entry }: { entry: KnowledgeEntry }) {
  const { openForm, deleteEntry } = useKnowledgeStore()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const tags = parseTags(entry.tags)
  const IconComp = CATEGORY_ICONS[entry.category] ?? BookOpen

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
    <div className="kb-card">
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
        {loading ? (
          <div className="kb-loading">加载中...</div>
        ) : entries.length === 0 ? (
          <div className="kb-empty">
            <BookOpen size={48} />
            <p>{searchKeyword ? '没有找到匹配的条目' : '知识库为空，点击"新增"添加第一条知识'}</p>
          </div>
        ) : (
          <div className="kb-card-grid">
            {entries.map(entry => (
              <KnowledgeCard key={entry.id} entry={entry} />
            ))}
          </div>
        )}
      </div>

      {showForm && <KnowledgeForm onClose={closeForm} />}
    </div>
  )
}
