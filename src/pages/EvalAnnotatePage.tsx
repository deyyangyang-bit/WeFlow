/**
 * EvalAnnotatePage.tsx —— D7 评测集应用内标注页（替代 Excel 流程）
 *
 * 两页签（cws-tabs 全局分段控件）：商机样本（opportunity_eval_case）/ 告警样本（alert_eval_case，宪法 §3）。
 * 版式（概念稿屏 11）：左「判断队列」（qrow 行式：来源色条 + 样本名 + 状态副行 + 类型 tag）、
 * 右「标注详情」（判断依据 + 标注档位）。点队列行换详情；标注即写库并自动跳下一条。
 * 商机详情看会话最近消息，三档「有商机 / 无商机 / 不确定」即写库（status=confirmed + annotated_by）。
 * 防锚定偏差（宪法 §1.10 / 评测集标注指引）：AI 预标注在人工标注前不可见——
 * 服务端（evalListCases）对未确认行不下发 ai_*，本页 UI 只是第二道闸；已标注样本可展开比对 AI 答案。
 * 标注档位以真实存储枚举为准：商机 has/none/uncertain、告警 correct/wrong/uncertain（DB CHECK 同口径），
 * 概念稿的「正确 / 部分正确 / 错误」档位名不套用；「纠正备注」后端 eval.label 无此字段，本页不造。
 * 每个样本带「证据可回查」锚点（evidence_key = messageKey，经 evidenceGetByKey 可回原话）。
 * 基线门槛（PRD ≥100 样本 + ≥100 人工确认）：未达标时顶部横幅显示「未达到评测门槛」，
 * P/R/F1 与混淆矩阵只在达标后展示；「导出基线报告」输出 JSON + Markdown（未达标报告明确标注）。
 * 告警页签：候选由 scripts/alert-eval.ts import 通道产出（应用内不生成）；行 = 类型 pill + 会话 + 证据锚点 +
 * AI 预判（标注前只显示「AI 已预判」不显值——防锚定同商机口径）+ 人工三档；
 * 有 anchor_key 的行显示「证据可回查」标识；统计行给出各类型「已标注数 / 人机一致率」——≥85% 开门判定直接读数。
 * PIPL：聊天原话就地展示、不出本机；库内只存 messageKey 引用 + ≤200 字原话快照。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { RefreshCw, ChevronDown, ChevronUp, UserCircle, ShieldCheck, Ban, FileWarning, CheckCircle2 } from 'lucide-react'
import type { EvalCaseRow, EvalGenerateResult, EvalStats, AlertEvalCaseRow, AlertEvalStats,
  EvalBaselineReport } from '../types/electron'
import type { Message } from '../types/models'
import { buildEvalCasesCsv, countConfirmed } from '../../shared/evalExport'
import './EvalAnnotatePage.scss'

/** 标注人 localStorage 键（记住一次，不用每卡填） */
const ANNOTATOR_KEY = 'eval_annotator_name'
/** 详情区展示的最近消息条数 */
const MSG_LIMIT = 15

const LABEL_TEXT: Record<string, string> = { has: '有商机', none: '无商机', uncertain: '不确定' }
const SOURCE_TEXT: Record<string, string> = {
  intent_tag_log: '意向打标',
  quote_signal: '报价信号',
  intent_signal: '意向信号',
  no_opportunity_sample: '对照样本'
}
/** 告警类型 → 中文（未在册类型回退原文；与 alertService.ALERT_PUSH_APPROVED 键同空间） */
const ALERT_TYPE_TEXT: Record<string, string> = {
  competitor: '竞品提及',
  loss: '客户流失',
  payment_overdue: '承诺打款过期'
}
/** 告警人工三档（correct=告警成立 / wrong=不成立 / uncertain=不确定，DB CHECK 同口径） */
const ALERT_LABEL_TEXT: Record<string, string> = { correct: '告警成立', wrong: '不成立', uncertain: '不确定' }
/** 开门判定阈值：人工标注准确率 ≥85% 该告警类型才获得推送资格（设计-AI见解重定位 §4.1 第 4 条） */
const GATE_THRESHOLD = 85

/** 消息气泡文本：非文本类型给占位提示（标注只需看懂上下文，不渲染媒体） */
function messageText(m: Message): string {
  const t = String(m.parsedContent || '').trim()
  if (t) return t
  switch (m.localType) {
    case 3: return '[图片]'
    case 34: return '[语音]'
    case 43: return '[视频]'
    case 47: return '[表情]'
    case 49: return m.linkTitle ? `[链接] ${m.linkTitle}` : '[链接/文件]'
    default: return '[非文本消息]'
  }
}

function shortTime(sec: number): string {
  const d = new Date(sec * 1000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 队列行色条语义：商机样本按来源，告警样本按类型（与详情档位/类型 pill 同一色族） */
function sourceStripeClass(source: string): string {
  switch (String(source || '')) {
    case 'intent_tag_log': return 'st-accent'
    case 'quote_signal': return 'st-warning'
    case 'intent_signal': return 'st-success'
    default: return 'st-neutral'
  }
}

function alertStripeClass(alertType: string): string {
  switch (String(alertType || '')) {
    case 'competitor': return 'st-danger'
    case 'loss': return 'st-warning'
    case 'payment_overdue': return 'st-success'
    default: return 'st-neutral'
  }
}

/** 证据锚点标识（有 anchor_key 才「可回查」，无锚点行明确「待补」，不得让标注员误以为有编号可查） */
function AnchorBadge({ anchorKey }: { anchorKey: string }) {
  const hasAnchor = Boolean(String(anchorKey || '').trim())
  if (hasAnchor) {
    return <span className="ec-anchor" title={`evidence_key（anchor_key）：${anchorKey}`}><ShieldCheck size={12} /> 证据可回查</span>
  }
  return (
    <span className="ec-anchor-missing" title="本条没有可回查的消息编号（历史存量样本）；判定依据以聊天记录为准，锚点待补，不要臆造编号">
      <FileWarning size={12} /> 待补证据
    </span>
  )
}

// ─── 商机样本：队列行 + 详情 ──────────────────────────────────────────────────

/** 判断队列行（概念稿 .qrow 语法）：色条 + 样本名 + 状态副行 + 来源 tag */
function EvalQueueRow({ item, index, selected, onSelect, rowRef }: {
  item: EvalCaseRow
  index: number
  selected: boolean
  onSelect: () => void
  rowRef: (el: HTMLDivElement | null) => void
}) {
  const confirmed = item.status === 'confirmed'
  const sourceText = SOURCE_TEXT[String(item.source || '')] || item.source || '未知来源'
  const hint = confirmed
    ? `已标：${LABEL_TEXT[String(item.label)] || item.label} · ${item.annotated_by || '—'}`
    : `${item.display_name} · 待标注`
  return (
    <div ref={rowRef}>
      <button type="button" className={`qrow ${selected ? 'is-on' : ''}`} onClick={onSelect} data-eval-index={index}>
        <span className={`qrow__stripe ${sourceStripeClass(String(item.source || ''))}`} />
        <span className="qrow__main">
          <span className="qrow__n">{item.display_name}</span>
          <span className="qrow__s">{hint}</span>
        </span>
        <span className="tag tag--plain">{sourceText}</span>
      </button>
    </div>
  )
}

/** 详情区会话消息（点选后才拉取：一次只取当前样本的最近消息，按时间升序截尾 MSG_LIMIT 条） */
function DetailMessages({ sessionId }: { sessionId: string }) {
  const [messages, setMessages] = useState<Message[] | null>(null)
  const [msgError, setMsgError] = useState('')

  useEffect(() => {
    let alive = true
    setMessages(null)
    setMsgError('')
    void (async () => {
      try {
        // 调现有 chat 端点取最近消息（应用读取层，不碰 WCDB）
        const r = await window.electronAPI.chat.getLatestMessages(sessionId, MSG_LIMIT)
        if (!alive) return
        if (r.success && r.messages) {
          const asc = r.messages.slice().sort((a, b) => a.createTime - b.createTime).slice(-MSG_LIMIT)
          setMessages(asc)
        } else {
          setMsgError(r.error || '读取失败')
        }
      } catch (e) {
        if (alive) setMsgError(String(e))
      }
    })()
    return () => { alive = false }
  }, [sessionId])

  return (
    <div className="ec-msgs">
      {messages === null && !msgError && <div className="ec-msg-loading">读取聊天记录中…</div>}
      {msgError && <div className="ec-msg-loading">无法读取聊天记录（会话可能已删除或无权限）：{msgError}</div>}
      {messages?.length === 0 && <div className="ec-msg-loading">该会话暂无消息记录</div>}
      {messages?.map((m) => (
        <div key={m.messageKey || `${m.localId}`} className={`ec-msg ${m.isSend === 1 ? 'me' : 'other'}`}>
          <div className="ec-msg-meta">{m.isSend === 1 ? '销售' : '客户'} · {shortTime(m.createTime)}</div>
          <div className="ec-msg-bubble">{messageText(m)}</div>
        </div>
      ))}
    </div>
  )
}

/** 商机详情（概念稿 judge/markbar 语法）：判断依据 + 标注档位；已标注行显结果与 AI 比对 */
function EvalDetail(props: {
  item: EvalCaseRow
  index: number
  total: number
  busy: boolean
  onLabel: (item: EvalCaseRow, label: string) => void
}) {
  const { item, index, total, busy, onLabel } = props
  const confirmed = item.status === 'confirmed'
  const [showAi, setShowAi] = useState(false)
  const sourceText = SOURCE_TEXT[String(item.source || '')] || item.source || '未知来源'
  const aiLabel = String(item.ai_label || '')
  const agree = confirmed && aiLabel ? item.label === aiLabel : null

  return (
    <div className="ea-detail">
      <div className="ea-detail__name">第 {index + 1} / {total} 条 · {sourceText}</div>
      <div className="ea-detail__sub">
        {item.display_name} · {item.session_id}
        {confirmed ? ` · 已标注` : ' · 待标注'}
      </div>

      {/* 判断依据区：信号原文 + 会话最近消息（先看聊天自己判） */}
      <div className="ea-judge">
        <div className="ea-judge__k">判断依据</div>
        {item.evidence_text
          ? <div className="ea-judge__v">信号原文：{item.evidence_text}</div>
          : <div className="ea-judge__v">（本条无信号原文，以聊天记录为准）</div>}
        <div className="ea-judge__ev">
          <AnchorBadge anchorKey={String(item.anchor_key || '')} />
          <DetailMessages sessionId={item.session_id} />
        </div>
      </div>

      {/* 标注档位：三档以存储枚举为准（has/none/uncertain），点击即写库并自动跳下一条 */}
      {!confirmed && (
        <>
          {aiLabel && <div className="ec-ai-hint">AI 已预判（标注后可见，防锚定）</div>}
          <div className="ea-markbar">
            <button className="ea-mark ea-mark--has" disabled={busy} onClick={() => onLabel(item, 'has')}>有商机</button>
            <button className="ea-mark ea-mark--none" disabled={busy} onClick={() => onLabel(item, 'none')}>无商机</button>
            <button className="ea-mark ea-mark--uncertain" disabled={busy} onClick={() => onLabel(item, 'uncertain')}>不确定</button>
          </div>
          <p className="sub ea-detail__hint">口径：先看聊天自己判，再点档位；点击即写库并跳到下一条。AI 答案标完后才能看（防锚定）。</p>
        </>
      )}

      {confirmed && (
        <div className="ea-markbar ea-markbar--done">
          <span className={`ea-mark ea-mark--has${item.label === 'has' ? ' is-on' : ''} is-static`}>{LABEL_TEXT.has}</span>
          <span className={`ea-mark ea-mark--none${item.label === 'none' ? ' is-on' : ''} is-static`}>{LABEL_TEXT.none}</span>
          <span className={`ea-mark ea-mark--uncertain${item.label === 'uncertain' ? ' is-on' : ''} is-static`}>{LABEL_TEXT.uncertain}</span>
        </div>
      )}

      {confirmed && (
        <div className="ec-ai">
          <button className="btn btn--plain btn--sm" onClick={() => setShowAi(!showAi)}>
            {showAi ? <ChevronUp size={13} /> : <ChevronDown size={13} />} AI 预标注
          </button>
          {showAi && (
            <div className="ec-ai-body">
              {aiLabel
                ? <>
                    AI 判断：<b>{LABEL_TEXT[aiLabel]}</b>
                    {agree !== null && (
                      <span className={`ec-agree ${agree ? 'yes' : 'no'}`}>{agree ? '与人工一致' : '与人工不一致'}</span>
                    )}
                  </>
                : '（本条无 AI 预标注）'}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── 告警样本：队列行 + 详情 ──────────────────────────────────────────────────

/** 告警队列行：色条按类型（competitor=danger / loss=warning / payment_overdue=success） */
function AlertQueueRow({ item, selected, onSelect, rowRef }: {
  item: AlertEvalCaseRow
  selected: boolean
  onSelect: () => void
  rowRef: (el: HTMLDivElement | null) => void
}) {
  const confirmed = item.status === 'confirmed'
  const typeText = ALERT_TYPE_TEXT[String(item.alert_type || '')] || String(item.alert_type || '未分类')
  const hint = confirmed
    ? `已标：${ALERT_LABEL_TEXT[String(item.label)] || item.label} · ${item.annotated_by || '—'}`
    : `${item.display_name} · 待标注`
  return (
    <div ref={rowRef}>
      <button type="button" className={`qrow ${selected ? 'is-on' : ''}`} onClick={onSelect}>
        <span className={`qrow__stripe ${alertStripeClass(String(item.alert_type || ''))}`} />
        <span className="qrow__main">
          <span className="qrow__n">{item.display_name}</span>
          <span className="qrow__s">{hint}</span>
        </span>
        <span className="tag tag--plain">{typeText}</span>
      </button>
    </div>
  )
}

/** 告警详情：告警依据原话 + 三档（correct/wrong/uncertain）；已标注行显结果与 AI 预判比对 */
function AlertDetail(props: {
  item: AlertEvalCaseRow
  index: number
  total: number
  busy: boolean
  onLabel: (item: AlertEvalCaseRow, label: string) => void
}) {
  const { item, index, total, busy, onLabel } = props
  const confirmed = item.status === 'confirmed'
  const [showAi, setShowAi] = useState(false)
  const typeText = ALERT_TYPE_TEXT[String(item.alert_type || '')] || String(item.alert_type || '未分类')
  const aiLabel = String(item.ai_label || '')
  const agree = confirmed && aiLabel ? item.label === aiLabel : null

  return (
    <div className="ea-detail">
      <div className="ea-detail__name">第 {index + 1} / {total} 条 · {typeText}</div>
      <div className="ea-detail__sub">
        {item.display_name} · {item.session_id}
        {confirmed ? ' · 已标注' : ' · 待标注'}
      </div>

      {/* 判断依据区：告警依据原话（消息锚点回查在依据区标识） */}
      <div className="ea-judge">
        <div className="ea-judge__k">判断依据</div>
        {item.evidence_text
          ? <div className="ea-judge__v">告警依据原话：{item.evidence_text}</div>
          : <div className="ea-judge__v">（本条无依据原话）</div>}
        <div className="ea-judge__ev">
          <AnchorBadge anchorKey={String(item.anchor_key || '')} />
        </div>
      </div>

      {/* 标注档位：三档以存储枚举为准（correct/wrong/uncertain），点击即写库 */}
      {!confirmed && (
        <>
          {aiLabel && <div className="ec-ai-hint">AI 已预判（标注后可见，防锚定）</div>}
          <div className="ea-markbar">
            <button className="ea-mark ea-mark--has" disabled={busy} onClick={() => onLabel(item, 'correct')}>告警成立</button>
            <button className="ea-mark ea-mark--none ea-mark--no" disabled={busy} onClick={() => onLabel(item, 'wrong')}>不成立</button>
            <button className="ea-mark ea-mark--uncertain" disabled={busy} onClick={() => onLabel(item, 'uncertain')}>不确定</button>
          </div>
          <p className="sub ea-detail__hint">口径：对照原话判类型是否成立；分母只算人工已标且非「不确定」的样本。</p>
        </>
      )}

      {confirmed && (
        <div className="ea-markbar ea-markbar--done">
          <span className={`ea-mark ea-mark--has${item.label === 'correct' ? ' is-on' : ''} is-static`}>{ALERT_LABEL_TEXT.correct}</span>
          <span className={`ea-mark ea-mark--none ea-mark--no${item.label === 'wrong' ? ' is-on' : ''} is-static`}>{ALERT_LABEL_TEXT.wrong}</span>
          <span className={`ea-mark ea-mark--uncertain${item.label === 'uncertain' ? ' is-on' : ''} is-static`}>{ALERT_LABEL_TEXT.uncertain}</span>
        </div>
      )}

      {confirmed && (
        <div className="ec-ai">
          <button className="btn btn--plain btn--sm" onClick={() => setShowAi(!showAi)}>
            {showAi ? <ChevronUp size={13} /> : <ChevronDown size={13} />} AI 预判
          </button>
          {showAi && (
            <div className="ec-ai-body">
              {aiLabel
                ? <>
                    AI 判断：<b>{ALERT_LABEL_TEXT[aiLabel]}</b>
                    {agree !== null && (
                      <span className={`ec-agree ${agree ? 'yes' : 'no'}`}>{agree ? '与人工一致' : '与人工不一致'}</span>
                    )}
                  </>
                : '（本条无 AI 预标注）'}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default function EvalAnnotatePage() {
  const [tab, setTab] = useState<'opportunity' | 'alert'>('opportunity')
  const [cases, setCases] = useState<EvalCaseRow[]>([])
  const [stats, setStats] = useState<EvalStats | null>(null)
  const [report, setReport] = useState<EvalBaselineReport | null>(null)
  const [reportMd, setReportMd] = useState('')
  const [alertCases, setAlertCases] = useState<AlertEvalCaseRow[]>([])
  const [alertStats, setAlertStats] = useState<AlertEvalStats | null>(null)
  const [alertFilter, setAlertFilter] = useState<'pending' | 'done'>('pending')
  /** 商机页签队列过滤：默认只列待标注（100+ 样本全量铺开滚不动） */
  const [oppFilter, setOppFilter] = useState<'pending' | 'done'>('pending')
  /** 判断队列选中项（左右双栏联动：点左侧行换右侧详情） */
  const [selectedOppId, setSelectedOppId] = useState<number | null>(null)
  const [selectedAlertId, setSelectedAlertId] = useState<number | null>(null)
  const [annotator, setAnnotator] = useState(() => window.localStorage.getItem(ANNOTATOR_KEY) || '')
  const [busy, setBusy] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [notice, setNotice] = useState('')
  const oppRowRefs = useRef(new Map<number, HTMLDivElement>())
  const alertRowRefs = useRef(new Map<number, HTMLDivElement>())
  const annotatorRef = useRef<HTMLInputElement>(null)

  const reload = useCallback(async () => {
    const [lr, sr, rr] = await Promise.all([
      window.electronAPI.eval.list(),
      window.electronAPI.eval.stats(),
      window.electronAPI.eval.report()
    ])
    if (lr.success) setCases(lr.cases)
    else setNotice(lr.error || '加载候选失败')
    if (sr.success && sr.stats) setStats(sr.stats)
    if (rr.success && rr.report) {
      setReport(rr.report)
      setReportMd(rr.markdown || '')
    }
  }, [])

  const reloadAlert = useCallback(async () => {
    const [lr, sr] = await Promise.all([
      window.electronAPI.eval.alertList(),
      window.electronAPI.eval.alertStats()
    ])
    if (lr.success) setAlertCases(lr.cases)
    if (sr.success && sr.stats) setAlertStats(sr.stats)
  }, [])

  useEffect(() => { void reload(); void reloadAlert() }, [reload, reloadAlert])

  /** 生成/刷新商机候选（幂等：全库同客户占坑；过滤群聊 + 意向信号/对照扩量到门槛；顺带回填 AI 预标注） */
  const doGenerate = async () => {
    setGenerating(true)
    setNotice('')
    try {
      const r = await window.electronAPI.eval.candidatesGenerate({})
      if (r.success && r.result) {
        const g: EvalGenerateResult = r.result
        setNotice(`候选刷新完成：新增 ${g.inserted} 条（意向 ${g.bySource.intent} / 报价 ${g.bySource.quote} / ` +
          `意向信号 ${g.bySource.intent_signal} / 对照 ${g.bySource.sample}），已存在跳过 ${g.skippedExisting} 条，` +
          `AI 回填 ${g.aiMatched + g.aiBackfilled} 条，过滤非客户会话 ${g.chatroomFiltered} 条` +
          (g.anchorMissing ? `，${g.anchorMissing} 个会话暂无可用消息锚点未入库（下轮刷新重试）` : '') +
          `；当前候选池共 ${g.total}/${g.target} 条` +
          `${g.quoteSkipped ? '（CRM 库未就绪，报价信号候选本次跳过）' : ''}`)
        await reload()
      } else {
        setNotice(r.error || '生成候选失败')
      }
    } finally { setGenerating(false) }
  }

  /** 导出基线报告（JSON / Markdown；门槛未达的报告内含「未达到评测门槛」，不会误当正式基线） */
  const downloadReport = (kind: 'json' | 'md') => {
    if (!report) return
    const stamp = report.generatedAt.slice(0, 10).replace(/-/g, '')
    const isJson = kind === 'json'
    const body = isJson ? JSON.stringify(report, null, 2) : reportMd
    if (!body) return
    const blob = new Blob([body], { type: isJson ? 'application/json;charset=utf-8' : 'text/markdown;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `opportunity-eval-baseline-${stamp}.${kind}`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  /** 导出人工标注结果 CSV（逐条 session/label/标注人/时间/锚点/AI 比对；不含聊天原文——PIPL） */
  const downloadLabels = () => {
    const body = buildEvalCasesCsv(cases)
    if (!countConfirmed(cases)) {
      setNotice('还没有人工确认的样本可导出——先完成标注')
      return
    }
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    // BOM 前缀：Excel 打开 UTF-8 CSV 不乱码
    const blob = new Blob(['\uFEFF' + body], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `opportunity-eval-labels-${stamp}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const requireAnnotator = (): boolean => {
    const by = annotator.trim()
    if (by) return true
    // 未填标注人：滚回顶部 + 聚焦姓名框 + 红圈提示（原来只在顶部出提示条，滚下去后看不见，像「点不动」）
    setNotice('请先在右上角填写标注人姓名，再点标注档位')
    window.scrollTo({ top: 0, behavior: 'smooth' })
    annotatorRef.current?.focus()
    return false
  }

  /** 商机样本：点击档位即写库，成功后自动选中下一条未标注样本 */
  const doLabel = async (item: EvalCaseRow, label: string) => {
    if (!requireAnnotator()) return
    const by = annotator.trim()
    window.localStorage.setItem(ANNOTATOR_KEY, by)
    setBusy(true)
    setNotice('')
    try {
      const r = await window.electronAPI.eval.label({ id: Number(item.id), label, annotatedBy: by })
      if (r.success && r.case) {
        const updated = { ...r.case, display_name: item.display_name } as EvalCaseRow
        // 就地更新并保持「未标在前、已标沉底」排序
        const next = cases.map((c) => (c.id === item.id ? updated : c))
        const rank = (c: EvalCaseRow) => (c.status === 'confirmed' ? 1 : 0)
        const sorted = next.slice().sort((a, b) => rank(a) - rank(b) || Number(b.updated_at || 0) - Number(a.updated_at || 0))
        setCases(sorted)
        // 进度/门槛/基线指标都随标注推进（门槛达标瞬间指标区即时出现）
        void Promise.all([window.electronAPI.eval.stats(), window.electronAPI.eval.report()]).then(([sr, rr]) => {
          if (sr.success && sr.stats) setStats(sr.stats)
          if (rr.success && rr.report) { setReport(rr.report); setReportMd(rr.markdown || '') }
        })
        // 自动跳下一条：排序后第一条未标注样本
        const nextPending = sorted.find((c) => c.status !== 'confirmed' && c.id !== item.id)
        if (nextPending?.id != null) {
          setSelectedOppId(nextPending.id)
          requestAnimationFrame(() => {
            oppRowRefs.current.get(nextPending.id!)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
          })
        }
      } else {
        setNotice(r.error || '标注失败')
      }
    } catch (e) {
      // IPC 异常也亮出来（原来无 catch，失败静默 = 「点不动」）
      setNotice(`标注失败：${String(e)}`)
    } finally { setBusy(false) }
  }

  /** 告警样本：点击档位即写库（import 式幂等 upsert，ai_* 不动）；已标行退出待标注队列 */
  const doAlertLabel = async (item: AlertEvalCaseRow, label: string) => {
    if (!requireAnnotator()) return
    const by = annotator.trim()
    window.localStorage.setItem(ANNOTATOR_KEY, by)
    setBusy(true)
    setNotice('')
    try {
      const r = await window.electronAPI.eval.alertLabel({ id: Number(item.id), label, annotatedBy: by })
      if (r.success && r.case) {
        const updated = { ...r.case, display_name: item.display_name } as AlertEvalCaseRow
        setAlertCases((prev) => {
          const next = prev.map((c) => (c.id === item.id ? updated : c))
          const rank = (c: AlertEvalCaseRow) => (c.status === 'confirmed' ? 1 : 0)
          return next.slice().sort((a, b) => rank(a) - rank(b) || Number(b.updated_at || 0) - Number(a.updated_at || 0))
        })
        void window.electronAPI.eval.alertStats().then((sr) => { if (sr.success && sr.stats) setAlertStats(sr.stats) })
        // 自动跳下一条待标注样本
        const pool = alertCases.filter((c) => c.id !== item.id)
        const nextPending = pool.find((c) => c.status !== 'confirmed')
        if (nextPending?.id != null) setSelectedAlertId(nextPending.id)
      } else {
        setNotice(r.error || '标注失败')
      }
    } catch (e) {
      setNotice(`标注失败：${String(e)}`)
    } finally { setBusy(false) }
  }

  /** 告警页签队列过滤：待标注（pending/prelabeled）/ 已标注（confirmed） */
  const filteredAlertCases = alertCases.filter((c) => (alertFilter === 'pending' ? c.status !== 'confirmed' : c.status === 'confirmed'))
  /** 商机页签队列过滤（口径同告警页签） */
  const filteredOppCases = cases.filter((c) => (oppFilter === 'pending' ? c.status !== 'confirmed' : c.status === 'confirmed'))

  // 队列过滤视图变化时，选中项回落到视图内第一行（详情永远显示真实存在的样本）
  useEffect(() => {
    if (filteredOppCases.length === 0) {
      if (selectedOppId !== null) setSelectedOppId(null)
      return
    }
    if (selectedOppId == null || !filteredOppCases.some((c) => c.id === selectedOppId)) {
      setSelectedOppId(filteredOppCases[0]?.id ?? null)
    }
  }, [filteredOppCases, selectedOppId])

  useEffect(() => {
    if (filteredAlertCases.length === 0) {
      if (selectedAlertId !== null) setSelectedAlertId(null)
      return
    }
    if (selectedAlertId == null || !filteredAlertCases.some((c) => c.id === selectedAlertId)) {
      setSelectedAlertId(filteredAlertCases[0]?.id ?? null)
    }
  }, [filteredAlertCases, selectedAlertId])

  const selectedOpp = filteredOppCases.find((c) => c.id === selectedOppId) ?? null
  const selectedOppIndex = filteredOppCases.findIndex((c) => c.id === selectedOppId)
  const selectedAlert = filteredAlertCases.find((c) => c.id === selectedAlertId) ?? null
  const selectedAlertIndex = filteredAlertCases.findIndex((c) => c.id === selectedAlertId)

  return (
    <div className="eval-annotate-page">
      {/* 页眉（概念稿 .shead）：小标 → 衬线主张句（真实待标注数）→ 口径说明；右侧为标注人与生成动作 */}
      <div className="shead ea-header">
        <div className="ea-header-main">
          <p className="eyebrow">AI · 评测标注</p>
          <h1 className="hero">
            {tab === 'opportunity'
              ? `待标注 ${cases.filter((c) => c.status !== 'confirmed').length} 条`
              : `待标注 ${alertCases.filter((c) => c.status !== 'confirmed').length} 条`}
          </h1>
          <p className="sub">人工判定写回样本库，用于评测基线；AI 答案在标注前不可见（防锚定）。</p>
        </div>
        <div className="ea-header-acts">
          <label className={`ea-annotator${annotator.trim() ? '' : ' need'}`}>
            <UserCircle size={14} /> 标注人
            <input
              ref={annotatorRef}
              value={annotator}
              placeholder="姓名（必填）"
              onChange={(e) => {
                setAnnotator(e.target.value)
                window.localStorage.setItem(ANNOTATOR_KEY, e.target.value.trim())
              }}
            />
          </label>
          {tab === 'opportunity' && (
            <button className="btn btn--primary" disabled={generating} onClick={() => void doGenerate()}
              title="从意向打标 / 报价信号 / 意向信号会话 / 无信号对照四路生成候选（幂等，已存在不重复；自动排除群聊，同一客户只留一行）">
              <RefreshCw size={14} /> {generating ? '生成中…' : '生成/刷新候选'}
            </button>
          )}
        </div>
      </div>

      {/* 类型页签：商机样本 / 告警样本（cws-tabs 全局分段控件，跟单中心两 Tab 同款） */}
      <div className="cws-tabs">
        <button className={`cws-tab ${tab === 'opportunity' ? 'active' : ''}`} onClick={() => setTab('opportunity')}>
          商机样本（已标 {stats?.confirmed ?? 0} / 共 {stats?.total ?? 0}）
        </button>
        <button className={`cws-tab ${tab === 'alert' ? 'active' : ''}`} onClick={() => setTab('alert')}>
          告警样本（已标 {alertStats?.annotated ?? 0} / 共 {alertStats?.total ?? 0}）
        </button>
      </div>

      {notice && <div className="ea-notice" role="status">{notice}</div>}

      {tab === 'opportunity' && (
        <>
          {/* 评测门槛（PRD ≥100 样本 + ≥100 人工确认）：概念稿 .notice 细条款——左侧 2px 语义条
              （通过=accent / 未达=warn），不铺满色块；导出按钮收进 acts 次级位（plain 档），
              未达标也绝不输出成已达标 */}
          {(stats?.gate || report) && (
            <div className={`notice notice--brief ${stats?.gate ? (stats.gate.met ? 'notice--accent' : 'notice--warn') : ''}`}>
              {stats?.gate
                ? (stats.gate.met ? <CheckCircle2 size={15} className="icon" /> : <Ban size={15} className="icon" />)
                : <span aria-hidden />}
              <div className="notice__row">
                {stats?.gate && (
                  <>
                    <span className="notice__h">{stats.gate.met ? '已达到评测门槛' : '未达到评测门槛'}</span>
                    <span className="ea-gate-text">
                      {stats.gate.met
                        ? `候选样本 ${stats.gate.total}/${stats.gate.minTotal}，人工确认 ${stats.gate.confirmed}/${stats.gate.minConfirmed}——基线指标生效，可导出基线报告`
                        : `${stats.gate.shortfalls.join('；')}——先「生成/刷新候选」补足样本并完成人工标注，基线指标暂不生效`}
                    </span>
                  </>
                )}
                {report && (
                  <div className="notice__acts">
                    <button className="btn btn--plain btn--sm" disabled={!countConfirmed(cases)} onClick={downloadLabels}
                      title="逐条导出人工标注结果（会话/结论/标注人/时间/锚点/AI 比对）；不含聊天原文">
                      标注结果 CSV（{countConfirmed(cases)} 条）
                    </button>
                    <button className="btn btn--plain btn--sm" onClick={() => downloadReport('md')}>Markdown</button>
                    <button className="btn btn--plain btn--sm" onClick={() => downloadReport('json')}>JSON</button>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* 四格统计条（概念稿 .stats 语法；数字全部用真实字段，没有的口径不造假——
              「本周已标注」无按周字段，落为累计「已标注」；纠正样本 = 人工与引擎不一致数） */}
          <div className="stats ea-stats4">
            <div className="stat">
              <div className="stat__n">{stats?.confirmed ?? 0}<small>/ {stats?.total ?? 0}</small></div>
              <div className="stat__l">已标注</div>
              <div className="stat__d">
                has {stats?.byLabel?.has ?? 0} · none {stats?.byLabel?.none ?? 0} · uncertain {stats?.byLabel?.uncertain ?? 0}
              </div>
            </div>
            <div className="stat">
              <div className="stat__n">{stats?.agreeRate == null ? '—' : <>{stats.agreeRate}<small>%</small></>}</div>
              <div className="stat__l">与引擎一致</div>
              <div className="stat__d">{stats?.compared ? `${stats.agree}/${stats.compared} 可比对` : '暂无可比对样本'}</div>
            </div>
            <div className="stat">
              <div className="stat__n">{(stats?.total ?? 0) - (stats?.confirmed ?? 0)}</div>
              <div className="stat__l">待标注</div>
              <div className="stat__d">含 AI 预标注 {cases.filter((c) => c.status !== 'confirmed' && String(c.ai_label || '')).length} 条</div>
            </div>
            <div className="stat">
              <div className="stat__n">{stats?.compared ? stats.compared - stats.agree : '—'}</div>
              <div className="stat__l">纠正样本</div>
              <div className="stat__d">人工与引擎判定不一致</div>
            </div>
          </div>
          <p className="sub ea-tip">口径：先看聊天自己判，再点档位；AI 答案标完后才能看（防锚定）。三档定义见《评测集标注指引》。</p>

          {/* 基线指标（只统计人工确认样本）：门槛达标才展示，未达标不给正式数字 */}
          {stats?.gate?.met && report?.metrics && (
            <div className="ea-metrics">
              <div className="ea-metrics-head">
                <span className="ea-metrics-title">基线指标（{report.metrics.compared} 条可比对的人工确认样本）</span>
              </div>
              <div className="ea-class-row">
                {(['has', 'none', 'uncertain'] as const).map((c) => {
                  const m = report.metrics!.classes[c]
                  return (
                    <div className="ea-class" key={c}>
                      <div className={`ea-class-name lb-${c}`}>{LABEL_TEXT[c]}（{m.support} 条）</div>
                      <div className="ea-class-prf">
                        <span>P {m.precision == null ? '—' : `${m.precision}%`}</span>
                        <span>R {m.recall == null ? '—' : `${m.recall}%`}</span>
                        <span>F1 {m.f1 == null ? '—' : `${m.f1}%`}</span>
                      </div>
                      <div className="ea-class-cm">TP {m.tp} / FP {m.fp} / FN {m.fn}</div>
                    </div>
                  )
                })}
              </div>
              <div className="ea-confusion">
                <div className="ea-confusion-title">
                  混淆矩阵（行=人工，列=AI） · accuracy {report.metrics.accuracy == null ? '—' : `${report.metrics.accuracy}%`} · macroF1 {report.metrics.macroF1 == null ? '—' : `${report.metrics.macroF1}%`}
                </div>
                <table>
                  <thead>
                    <tr><th>人工 \ AI</th>{report.metrics.confusion.labels.map((l) => <th key={l}>{LABEL_TEXT[l]}</th>)}</tr>
                  </thead>
                  <tbody>
                    {report.metrics.confusion.labels.map((h, i) => (
                      <tr key={h}>
                        <th>{LABEL_TEXT[h]}</th>
                        {report.metrics!.confusion.matrix[i].map((v, j) => (
                          <td key={j} className={i === j ? 'diag' : ''}>{v}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* 队列过滤：只列待标注 / 只看已标注——100+ 样本全量铺开时滚不到底 */}
          <div className="cws-tabs ea-subtabs">
            <button className={`cws-tab ${oppFilter === 'pending' ? 'active' : ''}`} onClick={() => setOppFilter('pending')}>
              待标注（{cases.filter((c) => c.status !== 'confirmed').length}）
            </button>
            <button className={`cws-tab ${oppFilter === 'done' ? 'active' : ''}`} onClick={() => setOppFilter('done')}>
              已标注（{cases.filter((c) => c.status === 'confirmed').length}）
            </button>
          </div>

          <div className="ea-grid">
            {/* 左：判断队列（概念稿 .qrow 行式；点一条在右侧看依据） */}
            <div className="ea-queue">
              <div className="seclabel ea-queue__head">
                <span className="seclabel__t">{oppFilter === 'pending' ? '待标注队列' : '已标注队列'}</span>
                <span className="num ea-queue__hint">点一条看依据</span>
              </div>
              <div className="ea-queue__list">
                {filteredOppCases.length === 0 ? (
                  <div className="empty">
                    {cases.length === 0
                      ? '暂无候选样本——点右上角「生成/刷新候选」开始'
                      : oppFilter === 'pending' ? '待标注队列已清空——全部样本都标完了' : '暂无已标注样本'}
                  </div>
                ) : filteredOppCases.map((c, i) => (
                  <EvalQueueRow
                    key={c.id}
                    item={c}
                    index={i}
                    selected={c.id === selectedOppId}
                    onSelect={() => setSelectedOppId(c.id ?? null)}
                    rowRef={(el) => {
                      if (c.id == null) return
                      if (el) oppRowRefs.current.set(c.id, el); else oppRowRefs.current.delete(c.id)
                    }}
                  />
                ))}
              </div>
            </div>

            {/* 右：标注详情（判断依据 + 标注档位） */}
            {selectedOpp ? (
              <EvalDetail
                item={selectedOpp}
                index={selectedOppIndex}
                total={filteredOppCases.length}
                busy={busy}
                onLabel={(item, label) => void doLabel(item, label)}
              />
            ) : (
              <div className="ea-detail ea-detail--empty">
                <p>{cases.length === 0 ? '先「生成/刷新候选」，再从这里逐条判断' : '队列里没有样本——换个过滤看看'}</p>
              </div>
            )}
          </div>
        </>
      )}

      {tab === 'alert' && (
        <>
          {/* 告警统计：同一套四格语法，每类型一格 + 待标注一格（分母只算人工已标且非「不确定」） */}
          <div className="stats ea-stats4">
            {(alertStats?.types ?? []).map((t) => (
              <div className="stat" key={t.alertType}>
                <div className="stat__n">
                  {t.annotated}<small>/ {t.total}</small>
                </div>
                <div className="stat__l">
                  {ALERT_TYPE_TEXT[t.alertType] || t.alertType || '未分类'}
                  {t.agreeRate != null && (
                    <span className={`ea-gate ${t.agreeRate >= GATE_THRESHOLD ? 'pass' : 'fail'}`}>
                      {t.agreeRate >= GATE_THRESHOLD ? '≥85% 达标' : '未达 85%'}
                    </span>
                  )}
                </div>
                <div className="stat__d">一致率 {t.agreeRate == null ? '—' : `${t.agreeRate}%（${t.agree}/${t.compared}）`}</div>
              </div>
            ))}
            <div className="stat">
              <div className="stat__n">{alertCases.filter((c) => c.status !== 'confirmed').length}</div>
              <div className="stat__l">待标注</div>
              <div className="stat__d">共 {alertStats?.total ?? 0} 条 · import 通道产出</div>
            </div>
            {(!alertStats || alertStats.types.length === 0) && (
              <div className="stat"><div className="stat__n">—</div><div className="stat__l">暂无告警样本</div></div>
            )}
          </div>
          <p className="sub ea-tip">口径：分母只算人工已标且非「不确定」的样本；某类型一致率 ≥85% 才允许开推送门（ALERT_PUSH_APPROVED）。
            候选由 alert-eval.ts export/import 通道产出，本页不生成。</p>

          <div className="cws-tabs ea-subtabs">
            <button className={`cws-tab ${alertFilter === 'pending' ? 'active' : ''}`} onClick={() => setAlertFilter('pending')}>
              待标注（{alertCases.filter((c) => c.status !== 'confirmed').length}）
            </button>
            <button className={`cws-tab ${alertFilter === 'done' ? 'active' : ''}`} onClick={() => setAlertFilter('done')}>
              已标注（{alertCases.filter((c) => c.status === 'confirmed').length}）
            </button>
          </div>

          <div className="ea-grid">
            <div className="ea-queue">
              <div className="seclabel ea-queue__head">
                <span className="seclabel__t">{alertFilter === 'pending' ? '待标注队列' : '已标注队列'}</span>
                <span className="num ea-queue__hint">点一条看依据</span>
              </div>
              <div className="ea-queue__list">
                {filteredAlertCases.length === 0 ? (
                  <div className="empty">
                    {alertFilter === 'pending' ? '待标注队列为空——样本由 alert-eval.ts import 通道产出' : '暂无已标注样本'}
                  </div>
                ) : filteredAlertCases.map((c) => (
                  <AlertQueueRow
                    key={c.id}
                    item={c}
                    selected={c.id === selectedAlertId}
                    onSelect={() => setSelectedAlertId(c.id ?? null)}
                    rowRef={(el) => {
                      if (c.id == null) return
                      if (el) alertRowRefs.current.set(c.id, el); else alertRowRefs.current.delete(c.id)
                    }}
                  />
                ))}
              </div>
            </div>

            {selectedAlert ? (
              <AlertDetail
                item={selectedAlert}
                index={selectedAlertIndex}
                total={filteredAlertCases.length}
                busy={busy}
                onLabel={(item, label) => void doAlertLabel(item, label)}
              />
            ) : (
              <div className="ea-detail ea-detail--empty">
                <p>{alertFilter === 'pending' ? '待标注队列为空——样本由 alert-eval.ts import 通道产出' : '队列里没有样本'}</p>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
