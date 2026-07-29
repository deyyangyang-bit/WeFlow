/**
 * ExtractScriptDialog.tsx
 * 话术提炼弹窗：选联系人 → AI 分析 → 预览编辑 → 导入知识库
 *
 * 三步流程：
 *   Step 1: 选择联系人（从聊天会话列表搜索/选择）
 *   Step 2: AI 提炼中（两段式 loading：读聊天→AI 分析）
 *   Step 3: 预览结果（编辑/勾选/导入，含原始对话对照）
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Check, ChevronLeft, LoaderCircle, MessageSquareText, Plus, RefreshCw, Search, Sparkles, X } from 'lucide-react'
import { useChatStore } from '../../stores/chatStore'
import { useKnowledgeStore } from '../../stores/knowledgeStore'
import './ExtractScriptDialog.scss'

// ─── 类型 ──────────────────────────────────────────────────────────────────────

interface Candidate {
  index: number
  title: string
  content: string
  scene: string
  tags: string[]
  duplicateOf?: string
  selected: boolean
  /** 批量模式的来源联系人 */
  sourceContact?: string
  /** 用户编辑后的值（覆盖 AI 原始输出） */
  editedTitle?: string
  editedContent?: string
  /** 原始对话片段（折叠对照） */
  originalSnippet?: string
}

type Step = 'select' | 'scanning' | 'confirm_candidates' | 'analyzing' | 'preview'

interface ScanCandidate {
  sessionId: string
  nickname: string
  messageCount: number
  lastContactAt: number
  isKnownCustomer: boolean
  score: number
  selected: boolean
}

const SCENE_LABELS: Record<string, string> = {
  '初次接触': '初次接触',
  '报价': '报价',
  '异议处理': '异议处理',
  '售后': '售后',
  '其他': '其他'
}

// ─── 组件 ──────────────────────────────────────────────────────────────────────

interface Props {
  open: boolean
  onClose: () => void
  /** 批量模式：一键提炼全部私聊，跳过选人步骤 */
  batch?: boolean
}

export default function ExtractScriptDialog({ open, onClose, batch = false }: Props) {
  const sessions = useChatStore(s => s.sessions)
  const { fetchList } = useKnowledgeStore()

  const [step, setStep] = useState<Step>('select')
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedSessionId, setSelectedSessionId] = useState('')
  const [selectedName, setSelectedName] = useState('')
  const [loadingStage, setLoadingStage] = useState<'messages' | 'ai' | ''>('')
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [error, setError] = useState('')
  const [importing, setImporting] = useState(false)
  const [showOriginal, setShowOriginal] = useState<Record<number, boolean>>({})
  // 批量模式扫描结果
  const [scanResult, setScanResult] = useState<{ totalScanned: number; candidates: ScanCandidate[]; scanDurationMs: number } | null>(null)
  const [scanError, setScanError] = useState('')
  // 过滤阈值（可调整）
  const [minMsgs, setMinMsgs] = useState(10)
  const [maxDays, setMaxDays] = useState(365)
  // 批量模式进度
  const [batchProgress, setBatchProgress] = useState({ current: 0, total: 0, contactName: '', foundSoFar: 0 })

  // 过滤非群聊会话
  const contacts = useMemo(() =>
    sessions
      .filter(s => {
        if (!s.displayName) return false
        const u = (s.username || '').toLowerCase()
        if (!u || u.includes('@chatroom') || u.startsWith('gh_')) return false
        if (u === 'weixin' || u === 'newsapp' || u.startsWith('qmessage')) return false
        return true
      })
      .sort((a, b) => (b.sortTimestamp || 0) - (a.sortTimestamp || 0)),
    [sessions]
  )

  const filtered = useMemo(() => {
    if (!searchQuery.trim()) return contacts.slice(0, 50)
    const q = searchQuery.toLowerCase()
    return contacts.filter(c =>
      (c.displayName || '').toLowerCase().includes(q) ||
      (c.username || '').toLowerCase().includes(q)
    ).slice(0, 30)
  }, [contacts, searchQuery])

  // 重置状态
  const reset = useCallback(() => {
    setStep(batch ? 'scanning' : 'select')
    setSearchQuery('')
    setSelectedSessionId('')
    setSelectedName('')
    setLoadingStage('')
    setCandidates([])
    setError('')
    setImporting(false)
    setShowOriginal({})
    setScanResult(null)
    setScanError('')
    setBatchProgress({ current: 0, total: 0, contactName: '', foundSoFar: 0 })
  }, [batch])

  // 批量模式：弹窗打开时自动开始扫描
  useEffect(() => {
    if (!open || !batch) return
    handleBatchScan()
  }, [open, batch])

  // ─── 批量 Step 1: 扫描候选 ────────────────────────────────────────────────
  const handleBatchScan = useCallback(async (overrideMinMsgs?: number, overrideMaxDays?: number) => {
    setStep('scanning')
    setScanError('')
    try {
      const result = await (window as any).electronAPI.sales.kbScanCandidates({
        minMessages: overrideMinMsgs ?? minMsgs,
        maxDaysAgo: overrideMaxDays ?? maxDays
      })
      if (!result?.success) { setScanError(result?.error || '扫描失败'); return }
      setScanResult({
        totalScanned: result.totalScanned,
        candidates: (result.candidates || []).map((c: any) => ({ ...c, selected: true })),
        scanDurationMs: result.scanDurationMs
      })
      setStep('confirm_candidates')
    } catch (e: any) {
      setScanError(e?.message || '扫描出错')
    }
  }, [minMsgs, maxDays])

  // ─── 批量 Step 2→3: 确认后提炼 ────────────────────────────────────────────
  const handleBatchExtract = useCallback(async () => {
    if (!scanResult) return
    const selected = scanResult.candidates.filter(c => c.selected)
    if (selected.length === 0) return
    const contacts = selected.map(c => ({ sessionId: c.sessionId, nickname: c.nickname }))
    setStep('analyzing')
    setError('')
    setBatchProgress({ current: 0, total: contacts.length, contactName: '准备中...', foundSoFar: 0 })
    const unsub = (window as any).electronAPI.sales.onExtractProgress(
      (data: { current: number; total: number; contactName: string; foundSoFar: number }) => setBatchProgress(data)
    )
    try {
      const result = await (window as any).electronAPI.sales.kbExtractScriptsAll(contacts)
      unsub()
      if (!result?.success) { setError(result?.error || '批量提炼失败'); setStep('confirm_candidates'); return }
      const list: Candidate[] = (result.candidates || []).map((c: any, idx: number) => ({
        index: idx, title: c.title || '未命名话术', content: c.content || '',
        scene: c.scene || '其他', tags: c.tags || [], duplicateOf: c.duplicateOf,
        sourceContact: c.sourceContact, selected: !c.duplicateOf,
        editedTitle: undefined, editedContent: undefined,
        originalSnippet: c.content?.slice(0, 120) || ''
      }))
      if (list.length === 0) { setError(`已处理 ${result.stats?.processed || 0} 个联系人，未发现可提炼的销售话术。`); setStep('confirm_candidates'); return }
      setCandidates(list); setStep('preview')
    } catch (e: any) { unsub(); setError(e?.message || '批量提炼出错'); setStep('confirm_candidates') }
  }, [scanResult])

  // ─── 候选勾选 ──────────────────────────────────────────────────────────────
  const toggleCandidate = (sessionId: string) => {
    if (!scanResult) return
    setScanResult({ ...scanResult, candidates: scanResult.candidates.map(c => c.sessionId === sessionId ? { ...c, selected: !c.selected } : c) })
  }
  const toggleAllCandidates = () => {
    if (!scanResult) return
    const all = scanResult.candidates.every(c => c.selected)
    setScanResult({ ...scanResult, candidates: scanResult.candidates.map(c => ({ ...c, selected: !all })) })
  }
  const selectedCandidateCount = scanResult?.candidates.filter(c => c.selected).length || 0

  // 关闭弹窗
  const handleClose = useCallback(() => {
    reset()
    onClose()
  }, [reset, onClose])

  // Step 1 → Step 2：发起提炼
  const handleExtract = useCallback(async () => {
    if (!selectedSessionId) return
    setStep('analyzing')
    setError('')
    setLoadingStage('messages')

    try {
      // 模拟两段式 loading 感知（实际 WCDB 查询嵌入在后端 extractScriptsFromChat 内）
      const timer = setTimeout(() => setLoadingStage('ai'), 1500)

      const result = await (window as any).electronAPI.sales.kbExtractScripts(selectedSessionId)

      clearTimeout(timer)

      if (!result?.success) {
        setError(result?.error || '提炼失败')
        setStep('select')
        return
      }

      const list: Candidate[] = (result.candidates || []).map((c: any) => ({
        ...c,
        selected: !c.duplicateOf, // 疑似重复的默认不勾选
        editedTitle: undefined,
        editedContent: undefined,
        originalSnippet: c.content?.slice(0, 120) || ''
      }))

      if (list.length === 0) {
        setError('未发现可提炼的销售话术。该对话中销售可能没有复用价值较高的发言。')
        setStep('select')
        return
      }

      setCandidates(list)
      setStep('preview')
    } catch (e: any) {
      setError(e?.message || '提炼出错')
      setStep('select')
    }
  }, [selectedSessionId])

  // Step 3：切换原始对话对照
  const toggleOriginal = useCallback((idx: number) => {
    setShowOriginal(prev => ({ ...prev, [idx]: !prev[idx] }))
  }, [])

  // Step 3：编辑候选
  const updateCandidate = useCallback((idx: number, field: 'editedTitle' | 'editedContent', value: string) => {
    setCandidates(prev => prev.map(c => c.index === idx ? { ...c, [field]: value } : c))
  }, [])

  // Step 3：勾选/取消
  const toggleSelect = useCallback((idx: number) => {
    setCandidates(prev => prev.map(c => c.index === idx ? { ...c, selected: !c.selected } : c))
  }, [])

  const toggleAll = useCallback(() => {
    setCandidates(prev => {
      const allSelected = prev.every(c => c.selected)
      return prev.map(c => ({ ...c, selected: !allSelected }))
    })
  }, [])

  // Step 3：导入选中
  const handleImport = useCallback(async () => {
    const selected = candidates.filter(c => c.selected)
    if (selected.length === 0) return

    setImporting(true)
    let imported = 0
    let skipped = 0

    for (const c of selected) {
      try {
        const title = c.editedTitle || c.title
        const content = c.editedContent || c.content
        if (!title.trim() || !content.trim()) { skipped++; continue }

        await (window as any).electronAPI.sales.kbCreate({
          category: 'script',
          title: title.trim(),
          content: content.trim(),
          tags: c.tags,
          scene: c.scene
        })
        imported++
      } catch {
        skipped++
      }
    }

    // 刷新知识库列表
    fetchList()
    handleClose()

    // 简洁提示（后续可替换为 toast）
    alert(`已导入 ${imported} 条话术${skipped > 0 ? `，${skipped} 条跳过` : ''}`)
    setImporting(false)
  }, [candidates, fetchList, handleClose])

  if (!open) return null

  const selectedCount = candidates.filter(c => c.selected).length
  const allSelected = candidates.length > 0 && candidates.every(c => c.selected)

  return (
    <div className="extract-dialog-overlay" onClick={handleClose}>
      <div className="extract-dialog" onClick={e => e.stopPropagation()}>
        {/* 标题栏 */}
        <div className="extract-dialog__header">
          <h3>
            <Sparkles size={18} />
            提炼话术
          </h3>
          <button className="extract-dialog__close" onClick={handleClose}><X size={18} /></button>
        </div>

        {/* ── Step 1: 选择联系人 ──────────────────────────────────────────── */}
        {step === 'select' && (
          <div className="extract-step extract-step--select">
            <p className="extract-step__desc">
              选择一个微信联系人，AI 将分析你们的聊天记录，自动提炼可复用的销售话术。
            </p>

            <div className="extract-search">
              <Search size={16} />
              <input
                type="text"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="搜索联系人..."
                autoFocus
              />
            </div>

            <div className="extract-contact-list">
              {filtered.map(c => (
                <button
                  key={c.username}
                  className={`extract-contact-item ${selectedSessionId === c.username ? 'selected' : ''}`}
                  onClick={() => { setSelectedSessionId(c.username); setSelectedName(c.displayName || c.username) }}
                >
                  <span className="extract-contact-avatar">{(c.displayName || '?')[0]}</span>
                  <span className="extract-contact-name">{c.displayName}</span>
                  <span className="extract-contact-wxid">{c.username}</span>
                </button>
              ))}
              {filtered.length === 0 && (
                <p className="extract-contact-empty">
                  {searchQuery ? '无匹配联系人' : '暂无可用的聊天会话'}
                </p>
              )}
            </div>

            {error && <p className="extract-error">{error}</p>}

            <div className="extract-step__actions">
              <button className="extract-btn extract-btn--secondary" onClick={handleClose}>取消</button>
              <button
                className="extract-btn extract-btn--primary"
                disabled={!selectedSessionId}
                onClick={handleExtract}
              >
                <Sparkles size={14} />
                开始提炼
              </button>
            </div>
          </div>
        )}

        {/* ── Batch Step 1: 扫描中 ─────────────────────────────────────────── */}
        {step === 'scanning' && (
          <div className="extract-step extract-step--analyzing">
            <div className="extract-analyzing-icon">
              {scanError ? <AlertTriangle size={36} /> : <LoaderCircle size={36} className="spinning" />}
            </div>
            {!scanError ? (
              <>
                <p className="extract-analyzing-title">正在扫描私聊会话...</p>
                <p className="extract-analyzing-hint">纯本地查询，预计 3 秒内完成</p>
              </>
            ) : (
              <>
                <p className="extract-error-title">扫描失败</p>
                <p className="extract-error-msg">{scanError}</p>
                <button className="extract-btn extract-btn--primary" onClick={() => handleBatchScan()}>重试</button>
              </>
            )}
          </div>
        )}

        {/* ── Batch Step 2: 确认候选 ────────────────────────────────────────── */}
        {step === 'confirm_candidates' && scanResult && (
          <div className="extract-step extract-step--candidates">
            <p className="extract-step__desc">
              共扫描 <strong>{scanResult.totalScanned}</strong> 个会话，筛选出 <strong>{scanResult.candidates.length}</strong> 个候选
              （耗时 {scanResult.scanDurationMs}ms）
            </p>

            {/* 阈值调整 */}
            <div className="extract-filter-row">
              <label>消息数 ≥ <input type="number" min={1} value={minMsgs} onChange={e => { setMinMsgs(Number(e.target.value)); handleBatchScan(Number(e.target.value), undefined) }} style={{ width: 50 }} /></label>
              <label>最近 <input type="number" min={1} value={Math.round(maxDays / 30)} onChange={e => { const m = Number(e.target.value); setMaxDays(m * 30); handleBatchScan(undefined, m * 30) }} style={{ width: 50 }} /> 个月内</label>
            </div>

            {scanResult.candidates.length > 200 && (
              <p className="extract-candidate-warn">候选数量较多（{scanResult.candidates.length}），提炼将耗时较长，建议提高筛选门槛</p>
            )}

            {/* 候选列表 */}
            <div className="extract-candidate-list">
              <div className="extract-candidate-header">
                <label><input type="checkbox" checked={scanResult.candidates.every(c => c.selected)} onChange={toggleAllCandidates} /> 全选</label>
                <span className="extract-candidate-col">联系人</span>
                <span className="extract-candidate-col">消息数</span>
                <span className="extract-candidate-col">最近联系</span>
                <span className="extract-candidate-col">客户</span>
              </div>
              {scanResult.candidates.map(c => (
                <label key={c.sessionId} className="extract-candidate-row">
                  <input type="checkbox" checked={c.selected} onChange={() => toggleCandidate(c.sessionId)} />
                  <span className="extract-candidate-col extract-candidate-name">{c.nickname}</span>
                  <span className="extract-candidate-col">{c.messageCount}</span>
                  <span className="extract-candidate-col">{c.lastContactAt ? new Date(c.lastContactAt * 1000).toLocaleDateString('zh-CN') : '-'}</span>
                  <span className="extract-candidate-col">{c.isKnownCustomer ? '✅' : '-'}</span>
                </label>
              ))}
            </div>

            {scanResult.candidates.length === 0 && (
              <p className="extract-contact-empty">未找到符合条件的联系人，请放宽消息数或时间范围</p>
            )}

            <div className="extract-step__actions">
              <button className="extract-btn extract-btn--secondary" onClick={handleClose}>取消</button>
              <button className="extract-btn extract-btn--primary" disabled={selectedCandidateCount === 0} onClick={handleBatchExtract}>
                <Sparkles size={14} /> 开始批量提炼 ({selectedCandidateCount})
              </button>
            </div>
          </div>
        )}

        {/* ── Step 2/3: AI 分析中 ──────────────────────────────────────────── */}
        {step === 'analyzing' && (
          <div className="extract-step extract-step--analyzing">
            <div className="extract-analyzing-icon">
              {error ? <AlertTriangle size={36} /> : <LoaderCircle size={36} className="spinning" />}
            </div>

            {!error ? (
              <>
                <p className="extract-analyzing-title">
                  {batch ? '正在批量提炼话术...' : '正在提炼话术...'}
                </p>

                {batch && batchProgress.total > 0 ? (
                  <div className="extract-batch-progress">
                    <div className="extract-batch-bar">
                      <div
                        className="extract-batch-bar__fill"
                        style={{ width: `${Math.round((batchProgress.current / batchProgress.total) * 100)}%` }}
                      />
                    </div>
                    <p className="extract-batch-status">
                      {batchProgress.current} / {batchProgress.total} 个联系人
                    </p>
                    <p className="extract-batch-contact">
                      当前：{batchProgress.contactName}
                    </p>
                    <p className="extract-batch-found">
                      已找到 {batchProgress.foundSoFar} 条话术
                    </p>
                  </div>
                ) : (
                  <>
                    <div className="extract-progress">
                      <div className={`extract-progress-step ${loadingStage === 'messages' ? 'active' : loadingStage === 'ai' ? 'done' : ''}`}>
                        <span className="extract-progress-dot">
                          {loadingStage === 'ai' ? <Check size={12} /> : loadingStage === 'messages' ? <RefreshCw size={12} className="spinning" /> : <span />}
                        </span>
                        <span>正在读取聊天记录</span>
                      </div>
                      <div className={`extract-progress-step ${loadingStage === 'ai' ? 'active' : ''}`}>
                        <span className="extract-progress-dot">
                          {loadingStage === 'ai' ? <RefreshCw size={12} className="spinning" /> : <span />}
                        </span>
                        <span>AI 分析中（识别有效话术、脱敏、分类...）</span>
                      </div>
                    </div>
                    <p className="extract-analyzing-hint">最长约 30 秒，取决于聊天量</p>
                  </>
                )}
              </>
            ) : (
              <>
                <p className="extract-error-title">提炼失败</p>
                <p className="extract-error-msg">{error}</p>
                <button className="extract-btn extract-btn--primary" onClick={() => { setError(''); setStep('select') }}>
                  <ChevronLeft size={14} /> 返回重选
                </button>
              </>
            )}
          </div>
        )}

        {/* ── Step 3: 预览结果 ─────────────────────────────────────────────── */}
        {step === 'preview' && (
          <div className="extract-step extract-step--preview">
            <div className="extract-preview-header">
              <span className="extract-preview-contact">
                <MessageSquareText size={14} />
                {batch ? `全部私聊（${candidates.length} 条）` : selectedName}
              </span>
              <span className="extract-preview-count">
                已选 {selectedCount} 条
              </span>
              <button className="extract-select-all" onClick={toggleAll}>
                {allSelected ? '取消全选' : '全选'}
              </button>
            </div>

            <div className="extract-preview-list">
              {candidates.map(c => (
                <div key={c.index} className={`extract-candidate ${c.selected ? 'selected' : ''}`}>
                  <label className="extract-candidate__check">
                    <input
                      type="checkbox"
                      checked={c.selected}
                      onChange={() => toggleSelect(c.index)}
                    />
                  </label>

                  <div className="extract-candidate__body">
                    <div className="extract-candidate__title-row">
                      <input
                        className="extract-candidate__title"
                        value={c.editedTitle ?? c.title}
                        onChange={e => updateCandidate(c.index, 'editedTitle', e.target.value)}
                      />
                      {c.sourceContact && (
                        <span className="extract-candidate__source" title={`来源：${c.sourceContact}`}>
                          {c.sourceContact}
                        </span>
                      )}
                      <span className="extract-candidate__scene">{SCENE_LABELS[c.scene] || c.scene}</span>
                    </div>

                    <textarea
                      className="extract-candidate__content"
                      value={c.editedContent ?? c.content}
                      onChange={e => updateCandidate(c.index, 'editedContent', e.target.value)}
                      rows={3}
                    />

                    <div className="extract-candidate__meta">
                      {c.tags.length > 0 && (
                        <span className="extract-candidate__tags">
                          {c.tags.map((t, i) => <span key={i} className="extract-tag">{t}</span>)}
                        </span>
                      )}
                      {c.duplicateOf && (
                        <span className="extract-candidate__dup" title="与已有条目相似度高">
                          <AlertTriangle size={11} /> 疑似重复：「{c.duplicateOf}」
                        </span>
                      )}
                      <button
                        className="extract-candidate__toggle-original"
                        onClick={() => toggleOriginal(c.index)}
                      >
                        {showOriginal[c.index] ? '收起原文' : '查看原文对照'}
                      </button>
                    </div>

                    {showOriginal[c.index] && (
                      <div className="extract-candidate__original">
                        {c.originalSnippet || c.content.slice(0, 150)}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>

            <div className="extract-import-warning">
              <AlertTriangle size={12} />
              导入前请确认已脱敏（金额/人名/手机号等已替换为占位符）
            </div>

            <div className="extract-step__actions">
              <button className="extract-btn extract-btn--secondary" onClick={() => { setError(''); setStep('select'); setCandidates([]) }}>
                <ChevronLeft size={14} /> 重新选择
              </button>
              <button
                className="extract-btn extract-btn--primary"
                disabled={selectedCount === 0 || importing}
                onClick={handleImport}
              >
                <Plus size={14} />
                {importing ? '导入中...' : `导入选中 (${selectedCount})`}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
