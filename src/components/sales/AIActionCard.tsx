/**
 * AIActionCard.tsx — 统一信号流卡片(v4 视觉)
 *
 * - 左侧 4px 紧急度色条
 * - 头部：客户名 + 阶段 chip + 沉默天数（无头像）
 * - teal AI 洞察块：有 insightText 时常显
 * - 来源标签行：task(石墨蓝) / insight(琥珀)
 * - 右列：环形 gauge（纯 SVG，priorityScore/140 归一化，语义=引擎内部优先级分，不改名）
 * - 底部：完成 / 跳过 / AI分析（行为不变）+ AI 五字段折叠面板
 */
import { useCallback, useState } from 'react'
import { Check, ChevronDown, ChevronUp, Clock, Copy, MessageCircle, RotateCw, Sparkles, X } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useTodayActionStore, type ActionItem, type SignalSource, type JudgmentValue } from '../../stores/todayActionStore'
import './AIActionCard.scss'

const STAGE_LABELS: Record<string, { text: string; color: string }> = {
  new: { text: '新客', color: '#3b82f6' },
  contacted: { text: '已沟通', color: '#8b5cf6' },
  quoted: { text: '已报价', color: '#f59e0b' },
  negotiating: { text: '谈判中', color: '#ef4444' },
  won: { text: '成交', color: '#10b981' },
  lost: { text: '流失', color: '#6b7280' },
  dormant: { text: '沉默', color: '#9ca3af' },
  unknown: { text: '未知', color: '#6b7280' },
  manual: { text: '手动', color: '#6b7280' }
}

/** 环形 gauge：score 原始分居中，环按 /140 归一化 */
function RingGauge({ score }: { score: number }) {
  const color = score >= 100
    ? 'var(--wf-urgent, #DC2626)'
    : score >= 60
      ? 'var(--wf-high, #D97706)'
      : 'var(--wf-normal, #64748B)'
  const R = 26
  const C = 2 * Math.PI * R
  const pct = Math.min(1, score / 140)
  return (
    <div className="ring-gauge">
      <svg width={64} height={64} viewBox="0 0 64 64">
        <circle cx={32} cy={32} r={R} fill="none" stroke="var(--wf-gauge-track, #EEF0F3)" strokeWidth={6} />
        <circle
          cx={32} cy={32} r={R} fill="none"
          stroke={color} strokeWidth={6} strokeLinecap="round"
          strokeDasharray={`${C * pct} ${C}`}
          transform="rotate(-90 32 32)"
        />
      </svg>
      <span className="ring-gauge__score" style={{ color }}>{score}</span>
    </div>
  )
}

function SourceTag({ source }: { source: SignalSource }) {
  const isTask = source.type === 'task'
  return (
    <span className={`source-tag ${isTask ? 'source-tag--task' : 'source-tag--insight'}`}>
      <span className="source-tag__code">{isTask ? (source as any).ruleCode : 'AI'}</span>
      <span className="source-tag__label">{source.label}</span>
      <span className="source-tag__reason">· {source.reason}</span>
    </span>
  )
}

export default function AIActionCard({ item }: { item: ActionItem }) {
  const { completeItem, fetchSuggestion } = useTodayActionStore()
  const navigate = useNavigate()
  const [expanded, setExpanded] = useState(false)
  const [loadingSuggestion, setLoadingSuggestion] = useState(false)
  const [copied, setCopied] = useState(false)
  // P0-3.4 证据回查：判断只带 messageKey 锚点，点击才走 P0-2B 拉原话（与 360/上下文条同语义）
  const [evidenceKey, setEvidenceKey] = useState<string | null>(null)
  const [evidenceMsg, setEvidenceMsg] = useState<string | null>(null)
  // 话术 = AI 分析生成的可粘贴话术（无 insightText 时也常显示 suggestion）
  const script = item.suggestion || ''

  const stage = STAGE_LABELS[item.stage] || STAGE_LABELS.unknown
  const hasInsight = item.sources.some(s => s.type === 'insight' && (s as any).insightText)
  const insightText = item.sources.find(s => s.type === 'insight' && (s as any).insightText)
  // P0-3.4：面板可展开 = 有当前判断投影或有话术（不再以 analysis JSON 快照/insight 文本判定）
  const judgments = item.judgments
  const hasJudgments = !!(judgments && (judgments.summary || judgments.opportunity || judgments.risk || judgments.nextAction))
  const hasAnalysis = hasJudgments || !!item.suggestion

  // 判断证据回查（与 Customer 360 判断卡同语义）
  const toggleEvidence = async (j: JudgmentValue) => {
    if (!j?.messageKey || !item.sessionId) return
    if (evidenceKey === j.messageKey) { setEvidenceKey(null); setEvidenceMsg(null); return }
    setEvidenceKey(j.messageKey)
    setEvidenceMsg('正在回查原话…')
    try {
      const r = await (window as any).electronAPI.sales.evidenceGetByKey({
        session_id: item.sessionId,
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

  const handleComplete = useCallback(() => completeItem(item.sessionId, 'done'), [item.sessionId, completeItem])
  const handleSkip = useCallback(() => completeItem(item.sessionId, 'skipped'), [item.sessionId, completeItem])

  const handleSuggest = useCallback(async () => {
    setLoadingSuggestion(true)
    await fetchSuggestion(item)
    setLoadingSuggestion(false)
    setExpanded(true)
  }, [item, fetchSuggestion])

  // 打开聊天：直达该客户的微信聊天页（一键执行第一步）
  // P0-3 E3.3：行动成功点后 fire-and-forget 上报 chat_opened（写失败不影响已成功的动作）
  // P0-4.2.1：task_id 取卡片首个 task source 的 rawTaskId（correlation key；无 task 卡不伪造 → NULL）
  const taskId = item.sources.find(s => s.type === 'task')?.rawTaskId ?? undefined
  const handleOpenChat = useCallback(() => {
    navigate(`/chat?sessionId=${encodeURIComponent(item.sessionId)}`)
    void (window as any).electronAPI?.sales?.actionRecordEvent?.({ sessionId: item.sessionId, eventType: 'chat_opened', taskId })
  }, [navigate, item.sessionId, taskId])

  // 复制话术：无话术先生成再复制，做到"一点即得可粘贴话术"
  const handleCopyScript = useCallback(async () => {
    let text = script
    if (!text) {
      setLoadingSuggestion(true)
      await fetchSuggestion(item)
      setLoadingSuggestion(false)
      const fresh = useTodayActionStore.getState().items.find((i) => i.sessionId === item.sessionId)
      text = fresh?.suggestion || ''
    }
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // fallback：部分受限环境 navigator.clipboard 不可用
      const ta = document.createElement('textarea')
      ta.value = text
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
    // P0-3 E3.3：复制成功后才上报 script_copied（fire-and-forget，写失败不影响"已复制"状态）
    // P0-4.2.1：task_id = 卡片 task source 的 rawTaskId（无 task 卡不伪造 → NULL）
    void (window as any).electronAPI?.sales?.actionRecordEvent?.({ sessionId: item.sessionId, eventType: 'script_copied', taskId })
  }, [script, item, fetchSuggestion, taskId])

  const tierClass = item.urgencyTier === 'urgent'
    ? 'signal-card--urgent'
    : item.urgencyTier === 'high'
      ? 'signal-card--high'
      : 'signal-card--normal'

  // 虚拟卡（无真实微信会话）：todo:<id> 手动待办 / lead:<id> 线索首触 SLA / logi:<id> 物流超期
  // 均无聊天对象 → 隐藏「打开聊天」按钮（SLA 卡 displayName 已含脱敏联系方式，销售自行微信搜索）
  const isVirtualTodo = ['todo:', 'lead:', 'logi:'].some((p) => String(item.sessionId || '').startsWith(p))

  return (
    <div className={`signal-card ${tierClass}`}>
      <div className="signal-card__body">
        <div className="signal-card__main">
          {/* 头部 */}
          <div className="signal-card__header">
            <span className="signal-card__name signal-card__name--link" title="查看客户 360 档案"
              onClick={(e) => { e.stopPropagation(); navigate(`/customers?sid=${encodeURIComponent(item.sessionId)}`) }}
            >{item.displayName}</span>
            <span className="signal-card__stage" style={{ background: `${stage.color}1A`, color: stage.color }}>
              {stage.text}
            </span>
            <span className="signal-card__silence"><Clock size={12} /> {item.silentDays}天未互动</span>
          </div>

          {/* teal AI 洞察块（有 insight 常显） */}
          {hasInsight && (
            <div className="signal-card__insight">
              <Sparkles size={14} className="signal-card__insight-icon" />
              <span>{(insightText as any)?.insightText}</span>
            </div>
          )}

          {/* 来源标签行 */}
          <div className="signal-card__sources">
            {item.sources.map((s, i) => <SourceTag key={i} source={s} />)}
          </div>

          {/* 底部操作 */}
          <div className="signal-card__actions">
            {!isVirtualTodo && (
              <button className="signal-btn signal-btn--chat" onClick={handleOpenChat}>
                <MessageCircle size={14} /> 打开聊天
              </button>
            )}
            <button className="signal-btn signal-btn--copy" onClick={() => void handleCopyScript()} disabled={loadingSuggestion}>
              {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? '已复制' : '复制话术'}
            </button>
            <button className="signal-btn signal-btn--done" onClick={handleComplete}>
              <Check size={14} /> 完成
            </button>
            <button className="signal-btn signal-btn--skip" onClick={handleSkip}>
              <X size={14} /> 跳过
            </button>
            {!isVirtualTodo && (
              <button
                className={`signal-btn signal-btn--ai ${hasInsight ? 'signal-btn--ai-ready' : ''}`}
                onClick={hasAnalysis ? () => setExpanded(!expanded) : handleSuggest}
                disabled={loadingSuggestion}
              >
                {loadingSuggestion ? <RotateCw size={13} className="spinning" /> : hasInsight ? <RotateCw size={13} /> : <Sparkles size={13} />}
                {loadingSuggestion ? '分析中...' : hasAnalysis ? (expanded ? '收起' : (hasInsight ? '查看AI分析' : 'AI深度分析')) : 'AI深度分析'}
                {hasAnalysis && !loadingSuggestion && (expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />)}
              </button>
            )}
          </div>
        </div>

        {/* 右列 gauge */}
        <div className="signal-card__side">
          <RingGauge score={item.priorityScore} />
          <span className="signal-card__score-label">AI 关注度</span>
        </div>
      </div>

      {/* P0-3.4 折叠面板：判断只消费系统已形成的当前视图（currentView.judgments，与 360/上下文条同语义：
          空态不补 / stale 标较旧 / 证据点击回查；analysis JSON 快照与 insight 文本不再冒充当前判断） */}
      {expanded && hasAnalysis && (
        <div className="signal-card__ai-panel">
          {hasJudgments && (
            <div className="signal-card__judgments">
              {([
                { label: '总结', v: judgments.summary },
                { label: '机会', v: judgments.opportunity },
                { label: '风险', v: judgments.risk },
                { label: '下一步', v: judgments.nextAction }
              ] as Array<{ label: string; v: JudgmentValue | null }>)
              .filter((c): c is { label: string; v: JudgmentValue } => !!c.v).map((c) => {
                return (
                <div key={c.label} className="ai-row">
                  <span className="ai-row__label">{c.label}</span>
                  <span className="ai-row__value">
                    {String(c.v.value || '')}
                    {c.v.freshness === 'stale' && <span className="signal-card__j-badge signal-card__j-badge--stale" title="生成已超 24h，可能过时">较旧</span>}
                    {c.v.source === 'manual' && <span className="signal-card__j-badge signal-card__j-badge--manual">人工</span>}
                    {c.v.evidenceStatus === 'ok' && c.v.messageKey && (
                      <button className="signal-card__j-evidence" onClick={() => void toggleEvidence(c.v)}>
                        {evidenceKey === c.v.messageKey ? (evidenceMsg && !evidenceMsg.startsWith('正在') ? '收起' : '回查中…') : '有据可查'}
                      </button>
                    )}
                  </span>
                  {evidenceKey === c.v.messageKey && evidenceMsg && (
                    <div className="signal-card__j-evidence-text">{evidenceMsg}</div>
                  )}
                </div>
                )
              })}
            </div>
          )}
          {script && (
            <div className="ai-row ai-row--script">
              <span className="ai-row__label">话术</span>
              <span className="ai-row__script">{script}</span>
              <button className="signal-btn signal-btn--copy signal-btn--sm" onClick={() => void handleCopyScript()} disabled={loadingSuggestion}>
                {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? '已复制' : '复制'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
