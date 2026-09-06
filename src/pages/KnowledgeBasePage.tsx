/**
 * KnowledgeBasePage.tsx
 * 话术/产品知识库管理页面
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { BookOpen, Plus, Search, Pencil, Trash2, X, Tag, Package, MessageSquareText, HelpCircle, Upload, Sparkles, Clock, CheckCircle2, XCircle, ShieldCheck, Shield, AlertTriangle, GitCompare, FilePlus2 } from 'lucide-react'
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

// ─── 刀 4 知识提案表单（「补充知识」入口：staging 行 source=proposal，证据锚点必填）────────────

function ProposalForm({ onClose }: { onClose: () => void }) {
  const { proposeEntry } = useKnowledgeStore()
  const [category, setCategory] = useState('faq')
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [evidenceKey, setEvidenceKey] = useState('')
  const [saving, setSaving] = useState(false)

  const handleSubmit = async () => {
    if (!title.trim() || !content.trim() || !evidenceKey.trim()) return
    setSaving(true)
    const r = await proposeEntry({
      title: title.trim(),
      content: content.trim(),
      category,
      evidence_key: evidenceKey.trim()
    })
    setSaving(false)
    if (r.success) onClose()
    else alert(`提案失败：${r.error || '未知错误'}`)
  }

  return (
    <div className="kb-form-overlay" onClick={onClose}>
      <div className="kb-form-dialog" onClick={e => e.stopPropagation()}>
        <div className="kb-form-header">
          <h3>补充知识（提案）</h3>
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
            <label>标题 *</label>
            <input type="text" value={title} onChange={e => setTitle(e.target.value)} placeholder="客户问过但知识库答不上的问题" />
          </div>
          <div className="kb-form-row">
            <label>内容 *</label>
            <textarea value={content} onChange={e => setContent(e.target.value)} placeholder="建议答案（主管审核发布后才被问答引用）" rows={5} />
          </div>
          <div className="kb-form-row">
            <label>证据锚点 *</label>
            <input
              type="text"
              value={evidenceKey}
              onChange={e => setEvidenceKey(e.target.value)}
              placeholder="客户原话 messageKey 或出处摘要（如「9/5 某客户咨询续航」），必填"
            />
          </div>
        </div>

        <div className="kb-form-footer">
          <button className="kb-btn kb-btn-secondary" onClick={onClose}>取消</button>
          <button
            className="kb-btn kb-btn-primary"
            onClick={handleSubmit}
            disabled={saving || !title.trim() || !content.trim() || !evidenceKey.trim()}
          >
            {saving ? '提交中...' : '提交提案（进待审核）'}
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

// ─── 待审核区（刀 1：staging 列表 + 逐条发布/拒绝，拒绝必填拒因；刀 4：批量通过 + 只看 diff）────────────────

/** 刀 4 行级对照（只看 diff）：右（提案）行不在左（已发布）行集里 → 新增高亮；反向 → 被改/删高亮。纯展示辅助，不裁决 */
function diffLines(oldText: string, newText: string): { left: Array<{ text: string; changed: boolean }>; right: Array<{ text: string; changed: boolean }> } {
  const oldLines = String(oldText || '').split('\n')
  const newLines = String(newText || '').split('\n')
  const oldSet = new Set(oldLines.map(l => l.trim()))
  const newSet = new Set(newLines.map(l => l.trim()))
  return {
    left: oldLines.map(l => ({ text: l, changed: l.trim() !== '' && !newSet.has(l.trim()) })),
    right: newLines.map(l => ({ text: l, changed: l.trim() !== '' && !oldSet.has(l.trim()) }))
  }
}

function ReviewItem({ entry, conflict, selected, onToggle, forceDiffOpen }: {
  entry: KnowledgeEntry
  /** 刀 4 冲突条目：同标题已发布行（存在才显示「只看 diff」） */
  conflict?: KnowledgeEntry
  selected: boolean
  onToggle: (id: number, checked: boolean) => void
  /** 区级「只看 diff」开启时强制展开并排对照 */
  forceDiffOpen?: boolean
}) {
  const { reviewEntry } = useKnowledgeStore()
  const [rejecting, setRejecting] = useState(false)
  const [reason, setReason] = useState('')
  const [official, setOfficial] = useState(false)
  const [busy, setBusy] = useState(false)
  const [showDiff, setShowDiff] = useState(false)
  const diffOpen = showDiff || Boolean(forceDiffOpen)
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
      <label className="kb-review-check" title="勾选后可批量发布">
        <input type="checkbox" checked={selected} onChange={e => onToggle(entry.id, e.target.checked)} />
      </label>
      <div className="kb-review-item-main">
        <div className="kb-review-item-head">
          <span className="kb-card-icon"><IconComp size={14} /></span>
          <span className="kb-review-item-title">{entry.title}</span>
          <span className="kb-card-category">{CATEGORY_LABELS[entry.category] ?? entry.category}</span>
          {entry.product_line && <span className="kb-card-product-line">{entry.product_line}</span>}
          {entry.scene && <span className="kb-card-scene">{entry.scene}</span>}
          {entry.source === 'proposal' && <span className="kb-badge kb-badge-proposal">提案</span>}
          <span className="kb-review-item-time">更新于 {formatTime(entry.updated_at)}</span>
        </div>
        <p className="kb-review-item-content">{entry.content}</p>
        {entry.source === 'proposal' && entry.evidence_key && (
          <div className="kb-review-evidence" title={entry.evidence_key}>证据锚点:{entry.evidence_key}</div>
        )}
        {conflict && (
          <button className="kb-diff-toggle" onClick={() => setShowDiff(v => !v)} title="与同标题已发布条目并排对照差异">
            <GitCompare size={13} />{diffOpen ? '收起 diff' : '只看 diff（与已发布条目冲突）'}
          </button>
        )}
        {conflict && diffOpen && (() => {
          const d = diffLines(conflict.content, entry.content)
          return (
            <div className="kb-diff">
              <div className="kb-diff-col">
                <div className="kb-diff-col-head">已发布：《{conflict.title}》（v{conflict.version ?? 1}）</div>
                {d.left.map((l, i) => (
                  <div key={i} className={`kb-diff-line ${l.changed ? 'kb-diff-line--old' : ''}`}>{l.text || ' '}</div>
                ))}
              </div>
              <div className="kb-diff-col">
                <div className="kb-diff-col-head">提案（待审核）</div>
                {d.right.map((l, i) => (
                  <div key={i} className={`kb-diff-line ${l.changed ? 'kb-diff-line--new' : ''}`}>{l.text || ' '}</div>
                ))}
              </div>
            </div>
          )
        })()}
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

function ReviewSection({ entries, publishedEntries }: { entries: KnowledgeEntry[]; publishedEntries: KnowledgeEntry[] }) {
  const { reviewEntries } = useKnowledgeStore()
  // 刀 4 批量通过（确认队列升级，防确认疲劳）：勾选多条一次发布
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [batchBusy, setBatchBusy] = useState(false)
  // 刀 4「只看 diff」区级开关：只显示与已发布条目同标题冲突的提案（并排对照）
  const [onlyDiff, setOnlyDiff] = useState(false)
  if (entries.length === 0) return null

  const conflictOf = (e: KnowledgeEntry) =>
    publishedEntries.find(p => (p.title || '').trim() === (e.title || '').trim())
  const conflictEntries = entries.filter(e => conflictOf(e))
  const visible = onlyDiff ? conflictEntries : entries

  const toggleOne = (id: number, checked: boolean) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (checked) next.add(id); else next.delete(id)
      return next
    })
  }
  const allSelected = visible.length > 0 && visible.every(e => selected.has(e.id))
  const toggleAll = (checked: boolean) => setSelected(checked ? new Set(visible.map(e => e.id)) : new Set())
  const selectedIds = visible.filter(e => selected.has(e.id)).map(e => e.id)

  const handleBatchPublish = async () => {
    if (selectedIds.length === 0 || batchBusy) return
    setBatchBusy(true)
    const r = await reviewEntries(selectedIds)
    setBatchBusy(false)
    setSelected(new Set())
    if (r.failed > 0) alert(`批量发布完成：成功 ${r.published} 条，失败 ${r.failed} 条\n${r.errors.join('\n')}`)
  }

  return (
    <div className="kb-review-section">
      <div className="kb-review-header">
        <Clock size={16} />
        <h3>待审核</h3>
        <span className="kb-review-count">{entries.length}</span>
        <label className="kb-review-check" title="全选本区">
          <input type="checkbox" checked={allSelected} onChange={e => toggleAll(e.target.checked)} />
        </label>
        <button
          className="kb-btn kb-btn-primary kb-btn-sm"
          onClick={handleBatchPublish}
          disabled={batchBusy || selectedIds.length === 0}
          title="勾选多条一次发布（community 口径；标官方请逐条勾选发布）"
        >
          <CheckCircle2 size={14} />{batchBusy ? '发布中…' : `批量发布${selectedIds.length > 0 ? `（${selectedIds.length}）` : ''}`}
        </button>
        <button
          className={`kb-btn kb-btn-sm ${onlyDiff ? 'kb-btn-accent' : 'kb-btn-secondary'}`}
          onClick={() => setOnlyDiff(v => !v)}
          disabled={conflictEntries.length === 0}
          title="只显示与已发布条目同标题冲突的提案，展开并排内容对照（冲突以产品库为准，人工裁决）"
        >
          <GitCompare size={14} />只看 diff{conflictEntries.length > 0 ? `（${conflictEntries.length}）` : ''}
        </button>
        <span className="kb-review-hint">发布后才会被知识问答引用 · 价格类条目请与产品库对账，冲突以产品库为准</span>
      </div>
      <div className="kb-review-list">
        {visible.length === 0 ? (
          <div className="kb-review-evidence">只看 diff：没有与已发布条目同标题冲突的提案</div>
        ) : visible.map(entry => (
          <ReviewItem
            key={entry.id}
            entry={entry}
            conflict={conflictOf(entry)}
            selected={selected.has(entry.id)}
            onToggle={toggleOne}
            forceDiffOpen={onlyDiff}
          />
        ))}
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
  const [proposalOpen, setProposalOpen] = useState(false) // 刀 4「补充知识」提案表单

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

          <button className="kb-btn kb-btn-secondary" onClick={() => setProposalOpen(true)} title="客户问过但知识库答不上来的问题，登记为提案进待审核（证据锚点必填）">
            <FilePlus2 size={16} />
            补充知识
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
        <ReviewSection entries={stagingEntries} publishedEntries={entries.filter(e => e.status === 'published')} />
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
      {proposalOpen && <ProposalForm onClose={() => setProposalOpen(false)} />}
    </div>
  )
}
