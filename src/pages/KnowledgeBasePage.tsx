/**
 * KnowledgeBasePage.tsx
 * 话术/产品知识库管理页面
 *
 * 知识治理规则（与 salesKnowledgeService 状态机一致，前端只做入口收敛）：
 *   - staging：可编辑、可删除（kbUpdate / kbDelete）
 *   - published：只读、不可删除，内容修改通过 kbUpdate fork 同 logical_id 新版本
 *   - rejected/closed：只读、不可删除，拒因/历史版本沉底留档
 *   - 条目展示：logical_id 版本链、当前版本、TTL、拒绝原因
 *   - evidence_key → 「查看依据」按钮：sales:evidence:getByKey 回查原话；查不到显示「依据不可用」
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { BookOpen, Plus, Search, Pencil, Trash2, X, Tag, Package, MessageSquareText, HelpCircle, Upload, Sparkles, Clock, CheckCircle2, XCircle, ShieldCheck, Shield, AlertTriangle, GitCompare, FilePlus2, FileSearch, GitBranch } from 'lucide-react'
import { useKnowledgeStore, type KnowledgeEntry } from '../stores/knowledgeStore'
import ExtractScriptDialog from '../components/sales/ExtractScriptDialog'
// 版本接替读取语义（单一真源）：当前版本 = 同一 logical_id 链中最高版号 published
import {
  knowledgeChainKey,
  currentPublishedEntries,
  currentPublishedOfChain,
  visibleCurrentPublishedEntries
} from '../utils/knowledgeVersion'
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

/** 今天的 YYYY-MM-DD（本地时区），TTL 过期判定用（字符串比较对 ISO 日期安全） */
function todayIso(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// ─── 价格冲突字段（纯前端投影：价格类字段两侧取值不同才算冲突，冲突以产品库为准）───

/** 价格类字段抽取：`字段：数值` 与 `¥数值` 两种形态（带字段名的取值覆盖泛化「金额」；同名字段取首次出现） */
function extractPriceFields(content: string): Map<string, number> {
  const map = new Map<string, number>()
  const text = String(content || '')
  const symbol = /[¥￥]\s*([0-9][0-9,]*(?:\.[0-9]+)?)/g
  for (const m of text.matchAll(symbol)) {
    const num = Number(m[1].replace(/,/g, ''))
    if (Number.isFinite(num) && !map.has('金额')) map.set('金额', num)
  }
  const labeled = /(价格|单价|租金|售价|优惠价|活动价|报价|运费|定金|首付|月租)\s*[：:]?\s*[¥￥]?\s*([0-9][0-9,]*(?:\.[0-9]+)?)/g
  for (const m of text.matchAll(labeled)) {
    const num = Number(m[2].replace(/,/g, ''))
    if (Number.isFinite(num)) map.set(m[1], num)
  }
  return map
}

function priceConflicts(stagingContent: string, publishedContent: string): Array<{ label: string; stagingValue: number; publishedValue: number }> {
  const a = extractPriceFields(stagingContent)
  const b = extractPriceFields(publishedContent)
  const out: Array<{ label: string; stagingValue: number; publishedValue: number }> = []
  for (const [label, v] of a) {
    const pv = b.get(label)
    if (pv !== undefined && pv !== v) out.push({ label, stagingValue: v, publishedValue: pv })
  }
  return out
}

// ─── 「查看依据」：evidence_key → sales:evidence:getByKey 回查（查不到 = 依据不可用）───

const EVIDENCE_UNAVAILABLE_REASON: Record<string, string> = {
  unparseable: '锚点不是可回查的消息Key（askKey 摘要或出处摘要）',
  message_not_found: '会话中未找到锚点对应的原话',
  reader_error: '聊天记录读取失败',
  no_message_key: '证据锚点为空'
}

function EvidenceViewer({ entry, onClose }: { entry: KnowledgeEntry; onClose: () => void }) {
  const [loading, setLoading] = useState(true)
  const [result, setResult] = useState<
    | { status: 'found'; message: any; before: any[]; after: any[] }
    | { status: 'unavailable'; reason: string; evidenceText?: string }
    | null
  >(null)

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        // 知识条目只存 evidence_key（消息Key / askKey / 出处摘要），不存会话——
        // 交给统一回查入口解析定位；解析不了或查不到 → unavailable（前端显示「依据不可用」）
        const r = await window.electronAPI.sales.evidenceGetByKey({
          session_id: '',
          message_key: String(entry.evidence_key || ''),
          evidence_text: entry.content
        })
        if (alive) setResult(r)
      } catch (e) {
        if (alive) setResult({ status: 'unavailable', reason: 'reader_error' })
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => { alive = false }
  }, [entry.evidence_key, entry.content])

  const msgText = (m: any): string => String(m?.parsedContent || m?.content || m?.rawContent || '')
  const msgTime = (m: any): string => {
    const t = Number(m?.createTime || 0)
    return t ? new Date(t).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''
  }

  return (
    <div className="kb-form-overlay" onClick={onClose}>
      <div className="kb-form-dialog kb-evidence-dialog" onClick={e => e.stopPropagation()}>
        <div className="kb-form-header">
          <h3>查看依据</h3>
          <button className="kb-form-close" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="kb-form-body">
          <div className="kb-evidence-key" title={entry.evidence_key || ''}>锚点：{entry.evidence_key || '（空）'}</div>
          {loading && <div className="kb-evidence-loading">正在回查原话…</div>}
          {!loading && result?.status === 'found' && (
            <div className="kb-evidence-found">
              <div className="kb-evidence-msg">
                <span className="kb-evidence-msg__time">{msgTime(result.message)}</span>
                <p>{msgText(result.message) || '（空消息）'}</p>
              </div>
              {(result.before.length > 0 || result.after.length > 0) && (
                <div className="kb-evidence-context">
                  <span className="kb-evidence-context__label">上下文</span>
                  {[...result.before, ...result.after].slice(0, 12).map((m: any, i: number) => (
                    <div key={i} className="kb-evidence-context__line">
                      <span>{msgTime(m)}</span>
                      <p>{msgText(m)}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          {!loading && result?.status === 'unavailable' && (
            <div className="kb-evidence-unavailable">
              <AlertTriangle size={16} />
              <b>依据不可用</b>
              <span>{EVIDENCE_UNAVAILABLE_REASON[result.reason] || '无法回查原话'}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── 知识条目表单 ─────────────────────────────────────────────────────────────

function KnowledgeForm({ onClose, versionBase }: { onClose: () => void; versionBase?: KnowledgeEntry | null }) {
  const { editingEntry, createEntry, updateEntry } = useKnowledgeStore()
  const base = versionBase ?? null
  const isEditing = !base && !!editingEntry
  const isVersion = !!base
  const source = base ?? editingEntry

  const [category, setCategory] = useState(source?.category ?? 'product')
  const [productLine, setProductLine] = useState(source?.product_line ?? '')
  const [title, setTitle] = useState(source?.title ?? '')
  const [content, setContent] = useState(source?.content ?? '')
  const [tagsInput, setTagsInput] = useState(
    source ? parseTags(source.tags).join(', ') : ''
  )
  const [scene, setScene] = useState(source?.scene ?? '')
  const [ttlDate, setTtlDate] = useState(source?.ttl_date ?? '')
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
      scene: scene || undefined,
      ttl_date: ttlDate || null
    }

    let success: boolean
    if (isEditing || isVersion) {
      success = await updateEntry((base ?? editingEntry)!.id, payload)
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
          <h3>{isVersion ? '创建新版本' : isEditing ? '编辑知识条目' : '新增知识条目'}</h3>
          <button className="kb-form-close" onClick={onClose}><X size={18} /></button>
        </div>

        {isVersion && (
          <div className="kb-version-hint">
            已发布条目不可直接修改。新版本将继承原版本链与依据，以<b>待审核</b>状态进入审核区。
          </div>
        )}

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

          <div className="kb-form-row">
            <label>TTL 到期日</label>
            <input type="date" value={ttlDate} onChange={e => setTtlDate(e.target.value)} />
          </div>
        </div>

        <div className="kb-form-footer">
          <button className="kb-btn kb-btn-secondary" onClick={onClose}>取消</button>
          <button
            className="kb-btn kb-btn-primary"
            onClick={handleSubmit}
            disabled={saving || !title.trim() || !content.trim()}
          >
            {saving ? '保存中...' : isVersion ? '提交新版本（进待审核）' : isEditing ? '保存修改' : '添加条目'}
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

/** 状态徽标（版本链节点/卡片通用） */
function statusLabel(e: Pick<KnowledgeEntry, 'status'>): string {
  if (e.status === 'published') return '已发布'
  if (e.status === 'rejected') return '已拒绝'
  if (e.status === 'closed') return '历史版本'
  return '待审核'
}

function KnowledgeCard({ entry, highlighted, chain, onNewVersion, onShowEvidence }: {
  entry: KnowledgeEntry
  highlighted?: boolean
  /** 版本链：同名标题的全部条目（含自身），created_at 升序 */
  chain: KnowledgeEntry[]
  onNewVersion: (e: KnowledgeEntry) => void
  onShowEvidence: (e: KnowledgeEntry) => void
}) {
  const { openForm, deleteEntry, renewTtl } = useKnowledgeStore()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const tags = parseTags(entry.tags)
  const IconComp = CATEGORY_ICONS[entry.category] ?? BookOpen
  const isRejected = entry.status === 'rejected'
  const isPublished = entry.status === 'published'
  const isStaging = (entry.status ?? 'staging') === 'staging'
  // 治理规则：published/rejected 只读且不能删除；staging 可编辑删除
  const canEdit = isStaging
  const canDelete = isStaging
  // 版本链当前版本：最新 published（updated_at DESC、id DESC，与 kbSearchPublished 读取语义一致）
  const currentPublished = currentPublishedOfChain(chain)
  // TTL：YYYY-MM-DD，空 = 未设置；过期红标
  const ttlExpired = Boolean(entry.ttl_date && entry.ttl_date < todayIso())

  const handleDelete = async () => {
    if (confirmDelete) {
      await deleteEntry(entry.id)
      setConfirmDelete(false)
    } else {
      setConfirmDelete(true)
      setTimeout(() => setConfirmDelete(false), 3000)
    }
  }

  const handleRenewTtl = async () => {
    const nextYear = new Date()
    nextYear.setFullYear(nextYear.getFullYear() + 1)
    const suggested = `${nextYear.getFullYear()}-${String(nextYear.getMonth() + 1).padStart(2, '0')}-${String(nextYear.getDate()).padStart(2, '0')}`
    const value = window.prompt('TTL 续期至（YYYY-MM-DD）', entry.ttl_date && entry.ttl_date >= todayIso() ? entry.ttl_date : suggested)
    if (value && !(await renewTtl(entry.id, value.trim()))) window.alert('TTL 续期失败，请输入今天或之后的日期')
  }

  return (
    <div className={`kb-card ${isRejected ? 'kb-card-rejected' : ''} ${highlighted ? 'kb-card-highlight' : ''}`} data-kb-entry={entry.id}>
      <div className="kb-card-header">
        <span className="kb-card-icon"><IconComp size={16} /></span>
        <span className="kb-card-category">{CATEGORY_LABELS[entry.category] ?? entry.category}</span>
        {entry.product_line && <span className="kb-card-product-line">{entry.product_line}</span>}
        {entry.scene && <span className="kb-card-scene">{entry.scene}</span>}
        <div className="kb-card-actions">
          {canEdit && (
            <button className="kb-card-action" onClick={() => openForm(entry)} title="编辑（待审核条目可改）">
              <Pencil size={14} />
            </button>
          )}
          {canDelete && (
            <button
              className={`kb-card-action ${confirmDelete ? 'danger' : ''}`}
              onClick={handleDelete}
              title={confirmDelete ? '再次点击确认删除' : '删除（仅待审核条目可删）'}
            >
              <Trash2 size={14} />
            </button>
          )}
          {isPublished && (
            <>
              <button className="kb-card-action" onClick={handleRenewTtl} title="续期 TTL（不产生新内容版本）">
                <Clock size={14} />
              </button>
              <button className="kb-card-action" onClick={() => onNewVersion(entry)} title="创建新版本（生成待审核条目，发布后接替当前版本）">
                <FilePlus2 size={14} />
              </button>
            </>
          )}
        </div>
      </div>

      <h4 className="kb-card-title">
        {entry.title}
        <span className="kb-card-version" title={`版本 v${entry.version ?? 1} · ${statusLabel(entry)}`}>v{entry.version ?? 1}</span>
      </h4>
      <p className="kb-card-content">{entry.content}</p>

      {chain.length > 1 && (
        <div className="kb-chain" title="同一 logical_id 的知识条目构成版本链；发布新版本后旧版被接替">
          <span className="kb-chain__label"><GitBranch size={11} />版本链</span>
          {chain.map(c => (
            <span
              key={c.id}
              className={`kb-chain__node is-${c.status ?? 'staging'} ${c.id === entry.id ? 'is-self' : ''}`}
            >
              v{c.version ?? 1} {statusLabel(c)}{c.id === currentPublished?.id ? '（当前）' : ''}
            </span>
          ))}
        </div>
      )}

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

      <div className="kb-card-meta">
        <span className={`kb-ttl ${ttlExpired ? 'kb-ttl--expired' : entry.ttl_date ? '' : 'kb-ttl--none'}`}>
          <Clock size={10} />
          {entry.ttl_date ? `TTL 至 ${entry.ttl_date}${ttlExpired ? '（已过期）' : ''}` : 'TTL 未设置'}
        </span>
        {entry.evidence_key && (
          <button className="kb-evidence-btn" onClick={() => onShowEvidence(entry)}>
            <FileSearch size={11} />查看依据
          </button>
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
// 治理补齐：staging 行可编辑（kbUpdate）/ 可删除（kbDelete）；published 只能创建新版本 → 不在审核区出现

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

function ReviewItem({ entry, conflict, selected, onToggle, forceDiffOpen, onShowEvidence }: {
  entry: KnowledgeEntry
  /** 刀 4 冲突条目：同标题已发布行（存在才显示「只看 diff」） */
  conflict?: KnowledgeEntry
  selected: boolean
  onToggle: (id: number, checked: boolean) => void
  /** 区级「只看 diff」开启时强制展开并排对照 */
  forceDiffOpen?: boolean
  onShowEvidence: (e: KnowledgeEntry) => void
}) {
  const { reviewEntry, openForm, deleteEntry } = useKnowledgeStore()
  const [rejecting, setRejecting] = useState(false)
  const [reason, setReason] = useState('')
  const [official, setOfficial] = useState(false)
  const [busy, setBusy] = useState(false)
  const [showDiff, setShowDiff] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const diffOpen = showDiff || Boolean(forceDiffOpen)
  const IconComp = CATEGORY_ICONS[entry.category] ?? BookOpen
  const priceConflictsOf = useMemo(
    () => (conflict ? priceConflicts(entry.content, conflict.content) : []),
    [conflict, entry.content]
  )

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
    <div className="kb-review-item">
      <label className="kb-review-check" title="勾选后可批量发布">
        <input type="checkbox" checked={selected} onChange={e => onToggle(entry.id, e.target.checked)} />
      </label>
      <div className="kb-review-item-main">
        <div className="kb-review-item-head">
          <span className="kb-card-icon"><IconComp size={14} /></span>
          <span className="kb-review-item-title">{entry.title}</span>
          <span className="kb-card-version" title="版本 vN（发布新版本时接替旧版）">v{entry.version ?? 1}</span>
          <span className="kb-card-category">{CATEGORY_LABELS[entry.category] ?? entry.category}</span>
          {entry.product_line && <span className="kb-card-product-line">{entry.product_line}</span>}
          {entry.scene && <span className="kb-card-scene">{entry.scene}</span>}
          {entry.source === 'proposal' && <span className="kb-badge kb-badge-proposal">提案</span>}
          {entry.ttl_date && (
            <span className={`kb-ttl ${entry.ttl_date < todayIso() ? 'kb-ttl--expired' : ''}`}><Clock size={10} />TTL 至 {entry.ttl_date}</span>
          )}
          <span className="kb-review-item-time">更新于 {formatTime(entry.updated_at)}</span>
        </div>
        <p className="kb-review-item-content">{entry.content}</p>
        {entry.source === 'proposal' && entry.evidence_key && (
          <div className="kb-review-evidence">
            <span className="kb-review-evidence__key" title={entry.evidence_key}>证据锚点：{entry.evidence_key}</span>
            <button className="kb-evidence-btn" onClick={() => onShowEvidence(entry)} title="回查客户原话（sales:evidence:getByKey）">
              <FileSearch size={11} />查看依据
            </button>
          </div>
        )}
        {conflict && (
          <button className="kb-diff-toggle" onClick={() => setShowDiff(v => !v)} title="与同标题已发布条目并排对照差异">
            <GitCompare size={13} />{diffOpen ? '收起 diff' : '只看 diff（与已发布条目冲突）'}
          </button>
        )}
        {conflict && priceConflictsOf.length > 0 && (
          <div className="kb-price-conflict" title="价格类字段两侧取值不一致（冲突以产品库为准，人工裁决）">
            <AlertTriangle size={12} />
            <b>价格冲突字段</b>
            {priceConflictsOf.map(c => (
              <span key={c.label} className="kb-price-conflict__item">
                {c.label}：提案 ¥{c.stagingValue.toLocaleString()} ↔ 已发布 ¥{c.publishedValue.toLocaleString()}
              </span>
            ))}
          </div>
        )}
        {conflict && diffOpen && (() => {
          const d = diffLines(conflict.content, entry.content)
          return (
            <div className="kb-diff">
              <div className="kb-diff-col">
                <div className="kb-diff-col-head">已发布：《{conflict.title}》（v{conflict.version ?? 1}）</div>
                {d.left.map((l, i) => (
                  <div key={i} className={`kb-diff-line ${l.changed ? 'kb-diff-line--old' : ''}`}>{l.text || ' '}</div>
                ))}
              </div>
              <div className="kb-diff-col">
                <div className="kb-diff-col-head">提案（待审核）</div>
                {d.right.map((l, i) => (
                  <div key={i} className={`kb-diff-line ${l.changed ? 'kb-diff-line--new' : ''}`}>{l.text || ' '}</div>
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
          <button className="kb-btn kb-btn-secondary" onClick={() => openForm(entry)} title="编辑（待审核条目可改）">
            <Pencil size={13} />编辑
          </button>
          <button
            className={`kb-btn kb-btn-secondary ${confirmDelete ? 'kb-btn-danger' : ''}`}
            onClick={handleDelete}
            title={confirmDelete ? '再次点击确认删除（物理删除，仅限待审核）' : '删除（仅限待审核条目）'}
          >
            <Trash2 size={13} />{confirmDelete ? '确认删除' : '删除'}
          </button>
        </div>
      )}
    </div>
  )
}

function ReviewSection({ entries, publishedEntries, onShowEvidence }: {
  entries: KnowledgeEntry[]
  publishedEntries: KnowledgeEntry[]
  onShowEvidence: (e: KnowledgeEntry) => void
}) {
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
        <span className="kb-review-hint">待审核条目可编辑/删除 · 发布后成为当前版本 · 价格类条目请与产品库对账，冲突以产品库为准</span>
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
            onShowEvidence={onShowEvidence}
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
  // 治理补齐：published「创建新版本」（预填表单 → 新 staging 行）+「查看依据」弹窗
  const [versionBase, setVersionBase] = useState<KnowledgeEntry | null>(null)
  const [evidenceEntry, setEvidenceEntry] = useState<KnowledgeEntry | null>(null)

  // 搜索/分类结果不是版本事实源；过滤态额外读取全量条目，避免只命中旧正文或旧分类时把历史版误判为当前。
  const [versionEntries, setVersionEntries] = useState<KnowledgeEntry[]>([])
  useEffect(() => {
    if (!searchKeyword && !filterCategory) {
      setVersionEntries(entries)
      return
    }
    void window.electronAPI.sales.kbList().then((result) => {
      if (result.success) setVersionEntries(result.entries)
    })
  }, [entries, searchKeyword, filterCategory])

  // 刀 1 治理分区：staging 进待审核区
  // （status 缺失的行视为 staging，防迁移前旧快照漏审）
  const stagingEntries = useMemo(() => entries.filter(e => (e.status ?? 'staging') === 'staging'), [entries])
  // 版本接替读取闭合：主列表每条版本链只出当前 published（最新 published；历史 published 不进卡片网格，
  // 但仍在卡片的「版本链」行可见）；rejected 沉底留档
  const currentPublished = useMemo(() => currentPublishedEntries(versionEntries), [versionEntries])
  const gridEntries = useMemo(() => {
    const published = visibleCurrentPublishedEntries(entries, versionEntries)
    const rejected = entries.filter(e => e.status === 'rejected')
    return [...published, ...rejected]
  }, [entries, versionEntries])

  // 版本链：logical_id 归并（created_at 升序）；标题可随版本修改而不断链。
  const chainMap = useMemo(() => {
    const map = new Map<string, KnowledgeEntry[]>()
    for (const e of versionEntries) {
      const key = knowledgeChainKey(e)
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(e)
    }
    for (const list of map.values()) list.sort((a, b) => a.created_at - b.created_at)
    return map
  }, [versionEntries])

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
      const res = await window.electronAPI.sales.kbImportCsv(csvContent)
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
        <ReviewSection entries={stagingEntries} publishedEntries={currentPublished} onShowEvidence={setEvidenceEntry} />
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
              <KnowledgeCard
                key={entry.id}
                entry={entry}
                highlighted={highlightId === entry.id}
                chain={chainMap.get(knowledgeChainKey(entry)) ?? [entry]}
                onNewVersion={setVersionBase}
                onShowEvidence={setEvidenceEntry}
              />
            ))}
          </div>
        )}
      </div>

      {showForm && <KnowledgeForm onClose={closeForm} />}
      {versionBase && (
        <KnowledgeForm
          versionBase={versionBase}
          onClose={() => setVersionBase(null)}
        />
      )}
      {proposalOpen && <ProposalForm onClose={() => setProposalOpen(false)} />}
      {evidenceEntry && <EvidenceViewer entry={evidenceEntry} onClose={() => setEvidenceEntry(null)} />}
    </div>
  )
}
