/**
 * SalesContextStrip.tsx
 *
 * 聊天页顶部轻量上下文条（PRD v2 P2）。
 * 始终可见（非群聊时），一行显示：阶段标签 + 沉默天数 + 最近意向 + 快捷操作。
 * 不弹窗、不打断，纯被动展示。点击展开可查看 AI 建议。
 */
import { useCallback, useEffect, useState } from 'react'
import { ChevronDown, ChevronUp, Copy, Check, Sparkles, TrendingUp } from 'lucide-react'
import './SalesContextStrip.scss'

const STAGE_MAP: Record<string, { label: string; color: string }> = {
  new: { label: '新客', color: '#3b82f6' },
  contacted: { label: '已沟通', color: '#8b5cf6' },
  quoted: { label: '已报价', color: '#f59e0b' },
  negotiating: { label: '谈判中', color: '#ef4444' },
  won: { label: '成交', color: '#10b981' },
  lost: { label: '流失', color: '#6b7280' },
  dormant: { label: '沉默', color: '#9ca3af' },
  unknown: { label: '未知', color: '#6b7280' },
  '了解': { label: '了解', color: '#4a9eff' },
  '比价': { label: '比价', color: '#f5a623' },
  '决策': { label: '决策', color: '#e74c3c' },
  '成交': { label: '成交', color: '#27ae60' },
  '流失': { label: '流失', color: '#95a5a6' }
}

interface ProfileData {
  stage: string
  display_name: string | null
  last_contact_at: number | null
  notes: string | null
}

interface IntentData {
  stage: string
  confidence: number | null
  reason: string | null
  created_at: number
}

interface Props {
  sessionId: string
}

export default function SalesContextStrip({ sessionId }: Props) {
  const [profile, setProfile] = useState<ProfileData | null>(null)
  const [latestIntent, setLatestIntent] = useState<IntentData | null>(null)
  const [judgments, setJudgments] = useState<any>(null)
  const [expanded, setExpanded] = useState(false)
  const [suggestion, setSuggestion] = useState('')
  const [loadingSuggestion, setLoadingSuggestion] = useState(false)
  const [copied, setCopied] = useState(false)
  // P0-3.3 证据回查：视图只带 messageKey 锚点，点击才走 P0-2B 拉原话（与 360 同语义）
  const [evidenceKey, setEvidenceKey] = useState<string | null>(null)
  const [evidenceMsg, setEvidenceMsg] = useState<string | null>(null)

  // P0-3.3 判断证据回查（与 Customer 360 判断卡同语义）
  const toggleEvidence = async (j: any) => {
    if (!j?.messageKey || !sessionId) return
    if (evidenceKey === j.messageKey) { setEvidenceKey(null); setEvidenceMsg(null); return }
    setEvidenceKey(j.messageKey)
    setEvidenceMsg('正在回查原话…')
    try {
      const r = await (window as any).electronAPI.sales.evidenceGetByKey({
        session_id: sessionId,
        message_key: j.messageKey,
        evidence_text: j.value ? `判断：${j.value}` : undefined
      })
      if (r?.status === 'found') {
        const m = r.message
        const text = String(m?.parsedContent || m?.content || m?.rawContent || '')
        const t = Number(m?.createTime || 0)
        const time = t ? new Date(t).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''
        setEvidenceMsg(`原话（${time}）：${text}`)
      } else {
        setEvidenceMsg(`未找到原话（${r?.reason || 'unavailable'}）；判断依据句：${j.value}`)
      }
    } catch (e) {
      setEvidenceMsg(`回查失败：${String(e)}`)
    }
  }

  // 加载客户画像 + 意图 + 当前视图（P0-3.3：判断只消费 currentView，不自拼真源）
  useEffect(() => {
    if (!sessionId) return
    let cancelled = false

    async function load() {
      try {
        const p = await (window as any).electronAPI.sales.customerGet(sessionId)
        if (!cancelled && p) setProfile(p)

        const history = await (window as any).electronAPI.sales.intentHistory(sessionId, 1)
        if (!cancelled && history?.length > 0) setLatestIntent(history[0])

        const v = await (window as any).electronAPI.sales.customerCurrentView(sessionId)
        if (!cancelled && v?.success) setJudgments(v.data?.judgments || null)
      } catch { /* ignore */ }
    }
    load()

    // 每 30 秒刷新一次（阶段/判断可能被后台自动更新）
    const timer = setInterval(load, 30_000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [sessionId])

  const handleSuggest = useCallback(async () => {
    if (!profile) return
    setLoadingSuggestion(true)
    try {
      const nowSec = Math.floor(Date.now() / 1000)
      const lastContact = profile.last_contact_at ?? 0
      const silentDays = Math.max(0, Math.floor((nowSec - lastContact) / 86400))

      const result = await (window as any).electronAPI.sales.actionSuggest({
        sessionId, // P0-3.3：补 sessionId——suggest 落库（channel=suggest/manual）依赖它定位客户，缺失会 invalid_input 跳过
        displayName: profile.display_name || sessionId,
        stage: profile.stage || 'unknown',
        silentDays,
        title: `跟进客户 ${profile.display_name || sessionId}`
      })
      if (result?.suggestion) setSuggestion(result.suggestion)
      // P0-3.3 验证闭环：生成成功 → customer_judgment append → 立即重读 currentView → UI 显示新判断
      const v = await (window as any).electronAPI.sales.customerCurrentView(sessionId)
      if (v?.success) setJudgments(v.data?.judgments || null)
    } catch { /* ignore */ }
    setLoadingSuggestion(false)
  }, [profile, sessionId])

  const handleCopy = useCallback(async () => {
    if (!suggestion) return
    try {
      await navigator.clipboard.writeText(suggestion)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch { /* ignore */ }
  }, [suggestion])

  // 无数据时不渲染
  if (!profile && !latestIntent) return null

  const stage = profile?.stage || latestIntent?.stage || 'unknown'
  const stageInfo = STAGE_MAP[stage] || STAGE_MAP.unknown
  const nowSec = Math.floor(Date.now() / 1000)
  const lastContact = profile?.last_contact_at ?? 0
  const silentDays = lastContact > 0 ? Math.max(0, Math.floor((nowSec - lastContact) / 86400)) : 0

  return (
    <div className="sales-context-strip">
      <div className="sales-context-strip__bar" onClick={() => setExpanded(!expanded)}>
        <span className="sales-context-strip__stage" style={{ background: stageInfo.color }}>
          {stageInfo.label}
        </span>

        {silentDays > 0 && (
          <span className={`sales-context-strip__silent ${silentDays > 7 ? 'warn' : ''}`}>
            {silentDays}天未联系
          </span>
        )}

        {latestIntent?.reason && (
          <span className="sales-context-strip__reason">{latestIntent.reason}</span>
        )}

        <span className="sales-context-strip__toggle">
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </span>
      </div>

      {expanded && (
        <div className="sales-context-strip__detail">
          {profile?.notes && (
            <div className="sales-context-strip__notes">📝 {profile.notes}</div>
          )}

          {/* P0-3.3：AI 当前判断（被动消费 currentView.judgments，与 360 同语义：空态不补/stale 标较旧/证据点击回查） */}
          {judgments && (
            <div className="sales-context-strip__judgments">
              {(() => {
                const cards = [
                  { label: '总结', v: judgments.summary },
                  { label: '机会', v: judgments.opportunity },
                  { label: '风险', v: judgments.risk },
                  { label: '下一步', v: judgments.nextAction }
                ]
                const present = cards.filter((c) => c.v)
                if (!present.length) {
                  return <div className="sales-context-strip__empty">暂无 AI 判断（可点击下方按钮主动生成）</div>
                }
                return present.map((c) => (
                  <div key={c.label} className="sales-context-strip__j-row">
                    <span className="sales-context-strip__j-label">{c.label}</span>
                    <span className="sales-context-strip__j-value">
                      {String(c.v.value || '')}
                      {c.v.freshness === 'stale' && <span className="sales-context-strip__j-badge sales-context-strip__j-badge--stale" title="生成已超 24h，可能过时">较旧</span>}
                      {c.v.source === 'manual' && <span className="sales-context-strip__j-badge sales-context-strip__j-badge--manual">人工</span>}
                      {c.v.evidenceStatus === 'ok' && c.v.messageKey && (
                        <button className="sales-context-strip__j-evidence" onClick={() => void toggleEvidence(c.v)}>
                          {evidenceKey === c.v.messageKey ? (evidenceMsg && !evidenceMsg.startsWith('正在') ? '收起' : '回查中…') : '有据可查'}
                        </button>
                      )}
                    </span>
                    {evidenceKey === c.v.messageKey && evidenceMsg && (
                      <div className="sales-context-strip__j-evidence-text">{evidenceMsg}</div>
                    )}
                  </div>
                ))
              })()}
            </div>
          )}

          {suggestion ? (
            <div className="sales-context-strip__suggestion">
              <div className="sales-context-strip__suggestion-text">{suggestion}</div>
              <button className="sales-context-strip__copy" onClick={handleCopy}>
                {copied ? <Check size={12} /> : <Copy size={12} />}
                {copied ? '已复制' : '复制'}
              </button>
            </div>
          ) : (
            <button
              className="sales-context-strip__suggest-btn"
              onClick={handleSuggest}
              disabled={loadingSuggestion}
            >
              <Sparkles size={13} />
              {loadingSuggestion ? '生成中...' : 'AI 跟进建议'}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
