/**
 * EvalAnnotatePage.tsx —— D7 评测集应用内标注页（替代 Excel 流程）
 *
 * 两页签（cws-tabs 全局分段控件）：商机样本（opportunity_eval_case）/ 告警样本（alert_eval_case，宪法 §3）。
 * 商机页签：主管逐卡看会话最近消息，点「有商机 / 无商机 / 不确定」即写库（status=confirmed + annotated_by），
 * 自动跳下一卡。防锚定偏差（宪法 §1.10 / 评测集标注指引）：AI 预标注在人工标注前不可见——
 * 服务端（evalListCases）对未确认行不下发 ai_*，本页 UI 只是第二道闸。已标注卡可展开比对 AI 答案。
 * 每张候选卡带「证据可回查」锚点（evidence_key = messageKey，经 evidenceGetByKey 可回原话）。
 * 基线门槛（PRD ≥100 样本 + ≥100 人工确认）：未达标时顶部横幅显示「未达到评测门槛」，
 * P/R/F1 与混淆矩阵只在达标后展示；「导出基线报告」输出 JSON + Markdown（未达标报告明确标注）。
 * 告警页签：候选由 scripts/alert-eval.ts import 通道产出（应用内不生成）；行 = 类型 pill + 会话 + 证据锚点 +
 * AI 预判（标注前只显示「AI 已预判」不显值——防锚定同商机口径）+ 人工三档（成立 correct / 不成立 wrong / 不确定）；
 * 有 anchor_key 的行显示「证据可回查」标识；统计行给出各类型「已标注数 / 人机一致率」——≥85% 开门判定直接读数。
 * PIPL：聊天原话就地展示、不出本机；库内只存 messageKey 引用 + ≤200 字原话快照。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { ClipboardCheck, RefreshCw, ChevronDown, ChevronUp, UserCircle, ShieldCheck, Download, Ban, FileWarning } from 'lucide-react'
import type { EvalCaseRow, EvalGenerateResult, EvalStats, AlertEvalCaseRow, AlertEvalStats,
  EvalBaselineReport } from '../types/electron'
import type { Message } from '../types/models'
import { buildEvalCasesCsv, countConfirmed } from '../../shared/evalExport'
import './EvalAnnotatePage.scss'

/** 标注人 localStorage 键（记住一次，不用每卡填） */
const ANNOTATOR_KEY = 'eval_annotator_name'
/** 每卡展示的最近消息条数 */
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

/** 单张商机标注卡：客户名 + 会话最近消息 + 三档标注按钮；已标注后可展开 AI 答案比对 */
function EvalCard(props: {
  item: EvalCaseRow
  busy: boolean
  onLabel: (item: EvalCaseRow, label: string) => void
  cardRef: (el: HTMLDivElement | null) => void
}) {
  const { item, busy, onLabel } = props
  const confirmed = item.status === 'confirmed'
  const [messages, setMessages] = useState<Message[] | null>(null)
  const [msgError, setMsgError] = useState('')
  const [showAi, setShowAi] = useState(false)
  const hasAnchor = Boolean(String(item.anchor_key || '').trim())

  // 调现有 chat 端点取最近消息（应用读取层，不碰 WCDB）；按时间升序后截尾 MSG_LIMIT 条
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const r = await window.electronAPI.chat.getLatestMessages(item.session_id, MSG_LIMIT)
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
  }, [item.session_id])

  const aiLabel = String(item.ai_label || '')
  const agree = confirmed && aiLabel ? item.label === aiLabel : null

  return (
    <div className={`eval-card ${confirmed ? 'done' : ''}`} ref={props.cardRef}>
      <div className="ec-head">
        <span className="ec-name">{item.display_name}</span>
        <span className="ec-sid">{item.session_id}</span>
        <span className="ec-src">{SOURCE_TEXT[String(item.source || '')] || item.source}</span>
        {hasAnchor ? (
          <span className="ec-anchor" title={`evidence_key（anchor_key）：${item.anchor_key}`}>
            <ShieldCheck size={12} /> 证据可回查
          </span>
        ) : (
          <span className="ec-anchor-missing" title="本条没有可回查的消息编号（历史存量样本）；判定依据以下方聊天记录为准，锚点待补，不要臆造编号">
            <FileWarning size={12} /> 待补证据
          </span>
        )}
        {confirmed && (
          <span className={`ec-verdict v-${item.label}`}>{LABEL_TEXT[String(item.label)] || item.label} · {item.annotated_by}</span>
        )}
      </div>

      {item.evidence_text ? <div className="ec-evidence">信号原文：{item.evidence_text}</div> : null}

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

      {!confirmed && (
        <div className="ec-actions">
          <button className="ec-btn has" disabled={busy} onClick={() => onLabel(item, 'has')}>有商机</button>
          <button className="ec-btn none" disabled={busy} onClick={() => onLabel(item, 'none')}>无商机</button>
          <button className="ec-btn uncertain" disabled={busy} onClick={() => onLabel(item, 'uncertain')}>不确定</button>
        </div>
      )}

      {confirmed && (
        <div className="ec-ai">
          <button className="crm-btn" onClick={() => setShowAi(!showAi)}>
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

/** 单行告警样本：类型 pill + 会话 + 证据锚点标识 + AI 预判（标注前不显值防锚定）+ 三档标注 */
function AlertRow(props: {
  item: AlertEvalCaseRow
  busy: boolean
  onLabel: (item: AlertEvalCaseRow, label: string) => void
  rowRef: (el: HTMLDivElement | null) => void
}) {
  const { item, busy, onLabel } = props
  const confirmed = item.status === 'confirmed'
  const [showAi, setShowAi] = useState(false)

  const aiLabel = String(item.ai_label || '')
  const agree = confirmed && aiLabel ? item.label === aiLabel : null
  const hasAnchor = Boolean(String(item.anchor_key || '').trim())
  const typeText = ALERT_TYPE_TEXT[String(item.alert_type || '')] || String(item.alert_type || '未分类')

  return (
    <div className={`eval-card alert-row ${confirmed ? 'done' : ''}`} ref={props.rowRef}>
      <div className="ec-head">
        <span className={`ec-type t-${String(item.alert_type || 'other')}`}>{typeText}</span>
        <span className="ec-name">{item.display_name}</span>
        <span className="ec-sid">{item.session_id}</span>
        {hasAnchor
          ? <span className="ec-anchor" title={`anchor_key：${item.anchor_key}`}><ShieldCheck size={12} /> 证据可回查</span>
          : <span className="ec-anchor-missing" title="本条没有可回查的消息编号；锚点待补"><FileWarning size={12} /> 待补证据</span>}
        {confirmed && (
          <span className={`ec-verdict v-${String(item.label)}`}>
            {ALERT_LABEL_TEXT[String(item.label)] || item.label} · {item.annotated_by}
          </span>
        )}
      </div>

      {item.evidence_text ? <div className="ec-evidence">告警依据原话：{item.evidence_text}</div> : null}

      {!confirmed && (
        <>
          {aiLabel && <div className="ec-ai-hint">AI 已预判（标注后可见，防锚定）</div>}
          <div className="ec-actions">
            <button className="ec-btn has" disabled={busy} onClick={() => onLabel(item, 'correct')}>告警成立</button>
            <button className="ec-btn none" disabled={busy} onClick={() => onLabel(item, 'wrong')}>不成立</button>
            <button className="ec-btn uncertain" disabled={busy} onClick={() => onLabel(item, 'uncertain')}>不确定</button>
          </div>
        </>
      )}

      {confirmed && (
        <div className="ec-ai">
          <button className="crm-btn" onClick={() => setShowAi(!showAi)}>
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
  /** 商机页签队列过滤：默认只列待标注（100+ 卡片全量铺开滚不动，逐卡标注效率低） */
  const [oppFilter, setOppFilter] = useState<'pending' | 'done'>('pending')
  const [annotator, setAnnotator] = useState(() => window.localStorage.getItem(ANNOTATOR_KEY) || '')
  const [busy, setBusy] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [notice, setNotice] = useState('')
  const cardRefs = useRef(new Map<number, HTMLDivElement>())
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

  /** 商机样本：点击即写库，成功后自动跳到下一张未标注卡 */
  const doLabel = async (item: EvalCaseRow, label: string) => {
    const by = annotator.trim()
    if (!by) {
      // 未填标注人：滚回顶部 + 聚焦姓名框 + 红圈提示（原来只在顶部出提示条，滚下去后看不见，像「点不动」）
      setNotice('请先在右上角填写标注人姓名，再点标注按钮')
      window.scrollTo({ top: 0, behavior: 'smooth' })
      annotatorRef.current?.focus()
      return
    }
    window.localStorage.setItem(ANNOTATOR_KEY, by)
    setBusy(true)
    setNotice('')
    try {
      const r = await window.electronAPI.eval.label({ id: Number(item.id), label, annotatedBy: by })
      if (r.success && r.case) {
        const updated = { ...r.case, display_name: item.display_name } as EvalCaseRow
        // 就地更新并保持「未标在前、已标沉底」排序
        setCases((prev) => {
          const next = prev.map((c) => (c.id === item.id ? updated : c))
          const rank = (c: EvalCaseRow) => (c.status === 'confirmed' ? 1 : 0)
          return next.slice().sort((a, b) => rank(a) - rank(b) || Number(b.updated_at || 0) - Number(a.updated_at || 0))
        })
        // 进度/门槛/基线指标都随标注推进（门槛达标瞬间指标区即时出现）
        void Promise.all([window.electronAPI.eval.stats(), window.electronAPI.eval.report()]).then(([sr, rr]) => {
          if (sr.success && sr.stats) setStats(sr.stats)
          if (rr.success && rr.report) { setReport(rr.report); setReportMd(rr.markdown || '') }
        })
        // 自动跳下一卡：排序后第一张未标注卡
        requestAnimationFrame(() => {
          setCases((prev) => {
            const nextPending = prev.find((c) => c.status !== 'confirmed' && c.id !== item.id)
            const el = nextPending?.id != null ? cardRefs.current.get(nextPending.id) : undefined
            el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
            return prev
          })
        })
      } else {
        setNotice(r.error || '标注失败')
      }
    } catch (e) {
      // IPC 异常也亮出来（原来无 catch，失败静默 = 「点不动」）
      setNotice(`标注失败：${String(e)}`)
    } finally { setBusy(false) }
  }

  /** 告警样本：点击即写库（import 式幂等 upsert，ai_* 不动）；已标行退出待标注队列 */
  const doAlertLabel = async (item: AlertEvalCaseRow, label: string) => {
    const by = annotator.trim()
    if (!by) {
      setNotice('请先在右上角填写标注人姓名，再点标注按钮')
      window.scrollTo({ top: 0, behavior: 'smooth' })
      annotatorRef.current?.focus()
      return
    }
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

  return (
    <div className="eval-annotate-page">
      <div className="crm-header">
        <h2><ClipboardCheck size={18} /> 评测标注</h2>
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
          <button className="crm-btn primary" disabled={generating} onClick={() => void doGenerate()}
            title="从意向打标 / 报价信号 / 意向信号会话 / 无信号对照四路生成候选（幂等，已存在不重复；自动排除群聊，同一客户只留一行）">
            <RefreshCw size={14} /> {generating ? '生成中…' : '生成/刷新候选'}
          </button>
        )}
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

      {notice && <div className="crm-notice">{notice}</div>}

      {tab === 'opportunity' && (
        <>
          {/* 评测门槛横幅（PRD ≥100 样本 + ≥100 人工确认）：未达标必须显眼，不能输出已达标 */}
          {stats?.gate && (
            <div className={`ea-gate-banner ${stats.gate.met ? 'pass' : 'fail'}`}>
              {stats.gate.met
                ? <>✅ 已达到评测门槛：候选样本 {stats.gate.total}/{stats.gate.minTotal}，人工确认 {stats.gate.confirmed}/{stats.gate.minConfirmed}——基线指标生效，可导出基线报告</>
                : <><Ban size={14} /> 未达到评测门槛：{stats.gate.shortfalls.join('；')}——先「生成/刷新候选」补足样本并完成人工标注，基线指标暂不生效</>}
            </div>
          )}

          {report && (
            <div className="ea-report-bar">
              <span>{report.gate.met ? '导出正式基线报告' : '导出当前评测进度（未达门槛）'}</span>
              <button className="crm-btn" disabled={!countConfirmed(cases)} onClick={downloadLabels}
                title="逐条导出人工标注结果（会话/结论/标注人/时间/锚点/AI 比对）；不含聊天原文">
                <Download size={13} /> 标注结果 CSV（{countConfirmed(cases)} 条）
              </button>
              <button className="crm-btn" onClick={() => downloadReport('md')}><Download size={13} /> Markdown</button>
              <button className="crm-btn" onClick={() => downloadReport('json')}><Download size={13} /> JSON</button>
            </div>
          )}

          <div className="ea-stats">
            <div className="ea-stat">
              <div className="ea-num">{stats?.confirmed ?? 0}<span className="ea-den">/ {stats?.total ?? 0}</span></div>
              <div className="ea-label">标注进度</div>
            </div>
            <div className="ea-stat">
              <div className="ea-num">{stats?.agreeRate == null ? '—' : `${stats.agreeRate}%`}</div>
              <div className="ea-label">人机一致率{stats?.compared ? `（${stats.agree}/${stats.compared}）` : ''}</div>
            </div>
            <div className="ea-stat">
              <div className="ea-num ea-split">
                <span className="lb-has">{stats?.byLabel?.has ?? 0}</span>
                <span className="lb-none">{stats?.byLabel?.none ?? 0}</span>
                <span className="lb-uncertain">{stats?.byLabel?.uncertain ?? 0}</span>
              </div>
              <div className="ea-label">人工分档 has / none / uncertain</div>
            </div>
            <div className="ea-tip">口径：先看聊天自己判，再点按钮；AI 答案标完后才能看（防锚定）。三档定义见《评测集标注指引》。</div>
          </div>

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

          {/* 队列过滤：只列待标注 / 只看已标注——100+ 卡片全量铺开时滚不到底，逐卡标注效率低 */}
          <div className="cws-tabs ea-subtabs">
            <button className={`cws-tab ${oppFilter === 'pending' ? 'active' : ''}`} onClick={() => setOppFilter('pending')}>
              待标注（{cases.filter((c) => c.status !== 'confirmed').length}）
            </button>
            <button className={`cws-tab ${oppFilter === 'done' ? 'active' : ''}`} onClick={() => setOppFilter('done')}>
              已标注（{cases.filter((c) => c.status === 'confirmed').length}）
            </button>
          </div>

          {filteredOppCases.length === 0 && (
            <div className="empty">
              {cases.length === 0
                ? '暂无候选样本——点右上角「生成/刷新候选」开始'
                : oppFilter === 'pending' ? '待标注队列已清空——全部样本都标完了' : '暂无已标注样本'}
            </div>
          )}
          {filteredOppCases.map((c) => (
            <EvalCard
              key={c.id}
              item={c}
              busy={busy}
              onLabel={(item, label) => void doLabel(item, label)}
              cardRef={(el) => {
                if (c.id == null) return
                if (el) cardRefs.current.set(c.id, el); else cardRefs.current.delete(c.id)
              }}
            />
          ))}
        </>
      )}

      {tab === 'alert' && (
        <>
          <div className="ea-stats">
            {(alertStats?.types ?? []).map((t) => (
              <div className="ea-stat" key={t.alertType}>
                <div className="ea-num">
                  {t.annotated}<span className="ea-den">/ {t.total}</span>
                </div>
                <div className="ea-label">
                  {ALERT_TYPE_TEXT[t.alertType] || t.alertType || '未分类'} · 人机一致率
                  {t.agreeRate == null ? '—' : `${t.agreeRate}%（${t.agree}/${t.compared}）`}
                  {t.agreeRate != null && (
                    <span className={`ea-gate ${t.agreeRate >= GATE_THRESHOLD ? 'pass' : 'fail'}`}>
                      {t.agreeRate >= GATE_THRESHOLD ? '≥85% 达标' : '未达 85%'}
                    </span>
                  )}
                </div>
              </div>
            ))}
            {(!alertStats || alertStats.types.length === 0) && (
              <div className="ea-stat"><div className="ea-num">—</div><div className="ea-label">暂无告警样本</div></div>
            )}
            <div className="ea-tip">口径：分母只算人工已标且非「不确定」的样本；某类型一致率 ≥85% 才允许开推送门（ALERT_PUSH_APPROVED）。
              候选由 alert-eval.ts export/import 通道产出，本页不生成。</div>
          </div>

          <div className="cws-tabs ea-subtabs">
            <button className={`cws-tab ${alertFilter === 'pending' ? 'active' : ''}`} onClick={() => setAlertFilter('pending')}>
              待标注（{alertCases.filter((c) => c.status !== 'confirmed').length}）
            </button>
            <button className={`cws-tab ${alertFilter === 'done' ? 'active' : ''}`} onClick={() => setAlertFilter('done')}>
              已标注（{alertCases.filter((c) => c.status === 'confirmed').length}）
            </button>
          </div>

          {filteredAlertCases.length === 0 && (
            <div className="empty">
              {alertFilter === 'pending' ? '待标注队列为空——样本由 alert-eval.ts import 通道产出' : '暂无已标注样本'}
            </div>
          )}
          {filteredAlertCases.map((c) => (
            <AlertRow
              key={c.id}
              item={c}
              busy={busy}
              onLabel={(item, label) => void doAlertLabel(item, label)}
              rowRef={(el) => {
                if (c.id == null) return
                if (el) alertRowRefs.current.set(c.id, el); else alertRowRefs.current.delete(c.id)
              }}
            />
          ))}
        </>
      )}
    </div>
  )
}
