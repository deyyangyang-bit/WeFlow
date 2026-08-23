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
import { useTodayActionStore, type ActionItem, type SignalSource } from '../../stores/todayActionStore'
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
  // 话术 = AI 分析生成的可粘贴话术（无 insightText 时也常显示 suggestion）
  const script = item.suggestion || ''

  const stage = STAGE_LABELS[item.stage] || STAGE_LABELS.unknown
  const hasInsight = item.sources.some(s => s.type === 'insight' && (s as any).insightText)
  const insightText = item.sources.find(s => s.type === 'insight' && (s as any).insightText)
  const insightContent = (insightText as any)?.insightText || item.suggestion || ''
  const hasAnalysis = !!insightContent || !!item.whyNow

  const handleComplete = useCallback(() => completeItem(item.sessionId, 'done'), [item.sessionId, completeItem])
  const handleSkip = useCallback(() => completeItem(item.sessionId, 'skipped'), [item.sessionId, completeItem])

  const handleSuggest = useCallback(async () => {
    setLoadingSuggestion(true)
    await fetchSuggestion(item)
    setLoadingSuggestion(false)
    setExpanded(true)
  }, [item, fetchSuggestion])

  // 打开聊天：直达该客户的微信聊天页（一键执行第一步）
  const handleOpenChat = useCallback(() => {
    navigate(`/chat?sessionId=${encodeURIComponent(item.sessionId)}`)
  }, [navigate, item.sessionId])

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
  }, [script, item, fetchSuggestion])

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

      {/* AI 五字段折叠面板 */}
      {expanded && hasAnalysis && (
        <div className="signal-card__ai-panel">
          {item.whyNow && <div className="ai-row"><span className="ai-row__label">为什么现在</span><span>{item.whyNow}</span></div>}
          {item.opportunity && <div className="ai-row"><span className="ai-row__label">机会</span><span>{item.opportunity}</span></div>}
          {item.riskSignal && <div className="ai-row ai-row--risk"><span className="ai-row__label">风险</span><span>{item.riskSignal}</span></div>}
          {(insightText as any)?.insightText && !item.whyNow && <div className="ai-row"><span className="ai-row__label">AI 洞察</span><span>{(insightText as any)?.insightText}</span></div>}
          {script && (
            <div className="ai-row ai-row--script">
              <span className="ai-row__label">话术</span>
              <span className="ai-row__script">{script}</span>
              <button className="signal-btn signal-btn--copy signal-btn--sm" onClick={() => void handleCopyScript()} disabled={loadingSuggestion}>
                {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? '已复制' : '复制'}
              </button>
            </div>
          )}
          {item.nextMove && <div className="ai-row"><span className="ai-row__label">下一步</span><span>{item.nextMove}</span></div>}
          {item.degradationNote && <div className="ai-degradation">{item.degradationNote}</div>}
        </div>
      )}
    </div>
  )
}
