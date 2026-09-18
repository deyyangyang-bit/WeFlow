/**
 * AIActionCard.tsx — 统一信号流细线行（2026-09-17 概念稿语法）
 *
 * - 行内：7px 紧急度点（概念稿 .dot）+ 客户名 + 阶段 pill / 来源标签 / 沉默天数
 * - 右列：等宽数字 + 2px 细刻度（概念稿 .score；原环形 gauge 按稿子设计说明去掉）
 * - 点整行展开：四栏判断（概念稿 .verdicts：摘要 / 机会 / 风险 / 下一步，含出处标记与证据回查，语义未变）
 * - 动作行（打开聊天 / 复制话术 / 完成 / 跳过 / AI 深度分析）常驻可见，行为与文案不变
 *
 * 2026-09-18 P1.6（观感细修，纯视觉）：动作行全部降档 —— 文字项走 quiet 文字钮，「完成」为
 * 唯一轻 primary（.btn--primary-soft）；信号行档默认再压平为文字链、行指向/展开才升 accent
 * 字色（同客户 P1.4b）。出处按钮与证据块对齐客户/聊天侧栏同一套（.ahead--btn / .verdict__evi）。
 */
import { useCallback, useState } from 'react'
import { Check, ChevronDown, Copy, MessageCircle, RotateCw, Sparkles, X } from 'lucide-react'
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

/** 优先级分刻度：与旧环形 gauge 同一归一化（/140），只换表现不换口径 */
const SCORE_SCALE = 140

function SourceTag({ source }: { source: SignalSource }) {
  // 阶段三例外告警：专属红色徽章（复用 source-tag 结构）；task 石墨蓝；
  // 商机确定性信号（已落库字段投影，非 AI 产物）用「商机」而非「AI」标注，避免误导为模型输出；
  // 其余（历史）走 insight 黄
  const cls = source.type === 'task' ? 'source-tag--task'
    : source.type === 'alert' ? 'source-tag--alert'
      : source.type === 'opportunity' ? 'source-tag--opportunity' : 'source-tag--insight'
  const code = source.type === 'task' ? (source as any).ruleCode
    : source.type === 'alert' ? '!'
      : source.type === 'opportunity' ? '商机' : 'AI'
  return (
    <span className={`source-tag ${cls}`}>
      <span className="source-tag__code">{code}</span>
      <span className="source-tag__label">{source.label}</span>
      <span className="source-tag__reason" title={source.reason}>· {source.reason}</span>
    </span>
  )
}

/**
 * @param lead 主张卡档（概念稿 .lead-card）：排序首位提升到索引上方时用。
 *   数据、判断、证据回查与动作全部沿用细线行那一套，只是外壳与头部换成「一句话答案」的排布，
 *   并且四栏判断默认摊开且四格常驻（缺哪栏标「尚未识别」）—— 完整判断只留给被主张的这一位。
 */
export default function AIActionCard({ item, lead = false }: { item: ActionItem; lead?: boolean }) {
  const { completeItem, fetchSuggestion } = useTodayActionStore()
  const navigate = useNavigate()
  const [expanded, setExpanded] = useState(lead)
  const [loadingSuggestion, setLoadingSuggestion] = useState(false)
  const [copied, setCopied] = useState(false)
  // P0-3.4 证据回查：判断只带 messageKey 锚点，点击才走 P0-2B 拉原话（与 360/上下文条同语义）
  const [evidenceKey, setEvidenceKey] = useState<string | null>(null)
  const [evidenceMsg, setEvidenceMsg] = useState<string | null>(null)
  // 话术 = AI 分析生成的可粘贴话术（无 analysis 时也常显示 suggestion）
  const script = item.suggestion || ''

  const stage = STAGE_LABELS[item.stage] || STAGE_LABELS.unknown
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

  const handleComplete = useCallback(() => completeItem(item, 'done'), [item, completeItem])
  const handleSkip = useCallback(() => completeItem(item, 'skipped'), [item, completeItem])

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
  // 紧急度点/刻度档位（概念稿 .dot--* / .score--*）
  const tier = item.urgencyTier === 'urgent' ? 'urgent' : item.urgencyTier === 'high' ? 'high' : 'normal'
  const scorePct = Math.max(0, Math.min(1, Number(item.priorityScore || 0) / SCORE_SCALE))

  // 虚拟卡（无真实微信会话）：todo:<id> 手动待办 / lead:<id> 线索首触 SLA / logi:<id> 物流超期
  // 均无聊天对象 → 隐藏「打开聊天」按钮（SLA 卡 displayName 已含脱敏联系方式，销售自行微信搜索）
  const isVirtualTodo = ['todo:', 'lead:', 'logi:'].some((p) => String(item.sessionId || '').startsWith(p))

  // P0-3.4 判断面板：只消费系统已形成的当前视图（currentView.judgments，与 360/上下文条同语义：
  // 空态不补 / stale 标较旧 / 证据点击回查；analysis JSON 快照与 insight 文本不再冒充当前判断）。
  // 细线行档收在 .sigdetail 里按需展开，主张卡档直接摊在卡内 —— 内容同一份，只有外壳不同。
  // 2026-09-18 P1.2：主张卡（lead）四格常驻（摘要 / 机会 / 风险 / 下一步），不再 filter 掉空判断 ——
  // 整格消失会被读成「这一栏没问题」，缺哪栏就如实标「尚未识别」（与聊天上下文条 / 客户 360 同一句空态文案）。
  // 细线行档保持原样：仍然按需展开，展开后也只列已有判断，不改列表密度。
  const cells: Array<{ label: string; v: JudgmentValue | null }> = [
    { label: '摘要', v: judgments?.summary ?? null },
    { label: '机会', v: judgments?.opportunity ?? null },
    { label: '风险', v: judgments?.risk ?? null },
    { label: '下一步', v: judgments?.nextAction ?? null }
  ]
  // 细线行展开档保持原密度：只列已有判断；主张卡四格常驻，缺栏如实标「尚未识别」
  const visibleCells = lead ? cells : cells.filter((c) => !!c.v)

  const panel = <>
          {(lead || hasJudgments) && (
            <div className="verdicts">
              {visibleCells.map((c) => {
                // const 绑定：narrow 后的判断值在 onClick 闭包里仍然非空（属性访问的 narrow 进不了闭包）
                const v = c.v
                if (!v) {
                  return (
                    <div key={c.label} className="verdict verdict--muted">
                      <div className="verdict__k">{c.label}</div>
                      <div className="verdict__v">尚未识别</div>
                    </div>
                  )
                }
                return (
                <div key={c.label} className="verdict">
                  <div className="verdict__k">{c.label}</div>
                  <div className="verdict__v">
                    {String(v.value || '')}
                    <div className="verdict__meta">
                      {/* 出处标记：新鲜 = AI 当前判断，较旧 = 生成超 24h，人工 = 手动锁定 */}
                      <span className={`ahead ${v.source === 'manual' ? 'ahead--human' : 'ahead--ai'}`}>
                        <span className="ahead__i" />
                        {v.source === 'manual' ? '人工确认' : v.freshness === 'stale' ? 'AI·较旧' : 'AI·新鲜'}
                      </span>
                      {v.evidenceStatus === 'ok' && v.messageKey && (
                        /* P1.6：出处按钮压平到客户 360 同一个 .ahead--btn 语法（tertiary 字，hover accent），
                            不再自带蓝底小按钮 —— 判断栏在今日行动 / 客户 / 聊天侧栏是同一套 */
                        <button className="ahead ahead--src ahead--btn" onClick={(e) => { e.stopPropagation(); void toggleEvidence(v) }}>
                          <i className="ahead__i" />
                          {evidenceKey === v.messageKey ? (evidenceMsg && !evidenceMsg.startsWith('正在') ? '收起依据' : '回查中…') : '依据消息'}
                        </button>
                      )}
                    </div>
                    {evidenceKey === v.messageKey && evidenceMsg && (
                      <div className="verdict__evi">{evidenceMsg}</div>
                    )}
                  </div>
                </div>
                )
              })}
            </div>
          )}
          {script && (
            <div className="verdict verdict--muted">
              <div className="verdict__k">话术</div>
              <div className="verdict__v">
                <span className="signal-card__script">{script}</span>
                <div className="verdict__meta">
                  <button className="btn btn--sm btn--quiet" onClick={() => void handleCopyScript()} disabled={loadingSuggestion}>
                    {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? '已复制' : '复制'}
                  </button>
                </div>
              </div>
            </div>
          )}
  </>

  return (
    <div className={lead ? 'lead-card' : `sig ${tierClass} ${expanded ? 'is-open' : ''}`}>
      {lead ? (
        /* 主张卡头部（概念稿 .lead-card__top）：名字 + 阶段 + 沉默/优先级，右侧标明它是被引擎置顶的那一条 */
        <div className="lead-card__top">
          <div className="lead-card__who">
            <span
              className="lead-card__name signal-card__name--link"
              title="查看客户 360 档案"
              onClick={() => navigate(`/customers?sid=${encodeURIComponent(item.sessionId)}`)}
            >{item.displayName}</span>
            <span className="pill" style={{ background: `${stage.color}1A`, color: stage.color }}>{stage.text}</span>
            <span className="lead-card__meta">沉默 {item.silentDays} 天 · 优先级 {item.priorityScore}</span>
          </div>
          <span className="tag tag--plain">引擎置顶</span>
        </div>
      ) : (
        /* 整行可点：展开/收起四栏判断（原「AI深度分析」入口同语义，键盘可达） */
        <button
          type="button"
          className="sigrow signal-sigrow"
          aria-expanded={expanded}
          onClick={() => { if (hasAnalysis) setExpanded(!expanded) }}
        >
          <span className={`dot ${tier === 'normal' ? '' : `dot--${tier}`}`} />
          <span className="sigrow__main">
            <span
              className="sigrow__name signal-card__name--link"
              title="查看客户 360 档案"
              onClick={(e) => { e.stopPropagation(); navigate(`/customers?sid=${encodeURIComponent(item.sessionId)}`) }}
            >{item.displayName}</span>
            <span className="sigrow__sub">
              <span className="signal-card__stage" style={{ background: `${stage.color}1A`, color: stage.color }}>
                {stage.text}
              </span>
              <span className="sigrow__tags">
                {item.sources.map((s, i) => <SourceTag key={i} source={s} />)}
              </span>
              <span className="sigrow__silent">{item.silentDays} 天未互动</span>
            </span>
          </span>
          <span className={`score ${tier === 'normal' ? '' : `score--${tier}`}`}>
            <span className="score__n">{item.priorityScore}<small>分</small></span>
            <span className="score__bar"><i style={{ width: `${scorePct * 100}%` }} /></span>
          </span>
          <ChevronDown size={16} strokeWidth={1.6} className="chev" />
        </button>
      )}

      {/* 主张卡档摊开判断（四格常驻，无判断时也如实标「尚未识别」）；细线行档按需展开 */}
      {lead
        ? panel
        : (expanded && hasAnalysis && <div className="sigdetail">{panel}</div>)}

      {/* 动作行：常驻可见（红线 5：行动任务可见性与可点击性不变），行为与文案与改造前一致。
          P1.6 观感降档：文字链档（打开聊天 / 复制话术 / 跳过 / AI 分析都是 quiet 文字钮），
          主操作只留「完成」一档轻 primary（.btn--primary-soft）；信号行档在 scss 里再压平为
          文字链、hover/is-open 才升 accent 字色（同客户 P1.4b），列表里不摆色块。 */}
      <div className={lead ? 'lead-card__acts' : 'sigdetail__acts signal-card__actions'}>
        {!isVirtualTodo && (
          <button className="btn btn--sm btn--quiet" onClick={handleOpenChat}>
            <MessageCircle size={14} strokeWidth={1.6} /> 打开聊天
          </button>
        )}
        <button className="btn btn--sm btn--quiet" onClick={() => void handleCopyScript()} disabled={loadingSuggestion}>
          {copied ? <Check size={14} strokeWidth={1.6} /> : <Copy size={14} strokeWidth={1.6} />} {copied ? '已复制' : '复制话术'}
        </button>
        <button className="btn btn--sm btn--primary-soft" onClick={handleComplete}>
          <Check size={14} strokeWidth={1.6} /> 完成
        </button>
        <button className="btn btn--sm btn--quiet" onClick={handleSkip}>
          <X size={14} strokeWidth={1.6} /> 跳过
        </button>
        {!isVirtualTodo && (
          <button
            className="btn btn--sm btn--quiet signal-card__ai-btn"
            onClick={hasAnalysis ? () => setExpanded(!expanded) : handleSuggest}
            disabled={loadingSuggestion}
          >
            {loadingSuggestion ? <RotateCw size={13} className="spinning" /> : <Sparkles size={13} strokeWidth={1.6} />}
            {loadingSuggestion ? '分析中...' : expanded ? '收起判断' : 'AI深度分析'}
            {hasAnalysis && !loadingSuggestion && <ChevronDown size={13} strokeWidth={1.6} className={`chev ${expanded ? 'is-flip' : ''}`} />}
          </button>
        )}
      </div>
    </div>
  )
}
