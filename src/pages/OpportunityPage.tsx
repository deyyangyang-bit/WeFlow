/**
 * OpportunityPage.tsx —— 商机：AI 从微信聊天自动识别采购信号 → 商机列表 / 漏斗 / 详情
 * 数据源 window.electronAPI.crm.opportunity*（crmDbService 商机模块）
 */
import { useEffect, useMemo, useState } from 'react'
import { useWxidRefresh } from '../utils/useWxidRefresh'
import { RefreshCw, X, CheckCircle2, XCircle, Activity, Banknote, Clock, Star, Target } from 'lucide-react'
// 阶段色单一真源（红线 3）：与销售漏斗同族 Apple 蓝渐变（红/橙退出阶段色，红只留语义）
import { FUNNEL_STAGE_COLORS, FUNNEL_STAGE_GRADIENT_LIGHT, FUNNEL_NEUTRAL, FUNNEL_NEUTRAL_LIGHT } from '../../shared/funnelPalette'
import './OpportunityPage.scss'

// 商机阶段（复用客户漏斗 5 档：了解/比价/决策 进漏斗；成交=won / 流失=lost 单独展示）
const STAGE_ORDER = ['了解', '比价', '决策'] as const
const STAGE_COLORS: Record<string, string> = {
  了解: FUNNEL_STAGE_COLORS[0], 比价: FUNNEL_STAGE_COLORS[1], 决策: FUNNEL_STAGE_COLORS[2],
  成交: FUNNEL_STAGE_COLORS[4], 流失: FUNNEL_NEUTRAL, unknown: FUNNEL_NEUTRAL_LIGHT
}
// 阶段推进路径：了解 → 比价 → 决策 → 成交
const NEXT_STAGE: Record<string, string> = { 了解: '比价', 比价: '决策', 决策: '成交' }

interface OppRow {
  id: number
  account_id: number
  account_name?: string
  name: string
  product: string
  quantity: number
  amount: number
  stage: string
  status: string
  intent_score: number
  last_signal_at: number
  created_at: number
  session_id?: string
}
interface OppEvent { id: number; event_type: string; stage: string; detail: string; created_at: number }
interface OppStats { stageDist: Array<{ stage: string; count: number; amount: number }>; total: number; totalAmount: number }
interface OppScore { score: number; level: string; factors: Array<{ label: string; delta: number; reason: string }> }
interface RiskRow {
  id: number
  account_id: number
  opportunity_id?: number
  risk_type: string
  severity: string
  detail: string
  status: string
  created_at: number
  resolved_at: number
}

// 风险类型文案（P0：竞品 / 价格 / 服务）
const RISK_TYPE_LABEL: Record<string, string> = {
  competitor: '竞品比较', price: '价格异议', service: '服务疑虑'
}
const RISK_SEVERITY_LABEL: Record<string, string> = {
  high: '高风险', medium: '中风险', low: '低风险'
}

// 金额展示：0 = 待确认
function fmtAmount(n: number): string {
  return n > 0 ? `¥${n.toLocaleString()}` : '待确认'
}
// 时间：MM-DD HH:mm
function fmtTime(ms: number): string {
  if (!ms) return '—'
  const d = new Date(Number(ms))
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${mm}-${dd} ${hh}:${mi}`
}
// 事件类型文案
const EVENT_LABEL: Record<string, string> = {
  created: '创建', signal: '采购信号', stage_change: '阶段推进', won: '成交', lost: '丢单'
}

export default function OpportunityPage() {
  const [opps, setOpps] = useState<OppRow[]>([])
  const [stats, setStats] = useState<OppStats | null>(null)
  const [stageFilter, setStageFilter] = useState('')
  const [selected, setSelected] = useState<OppRow | null>(null)
  const [events, setEvents] = useState<OppEvent[]>([])
  const [risks, setRisks] = useState<RiskRow[]>([])
  const [scores, setScores] = useState<Record<number, OppScore>>({})
  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(false)

  const fetch = async () => {
    setLoading(true)
    try {
      const [list, st] = await Promise.all([
        window.electronAPI.crm.opportunityList({ status: 'active' }),
        window.electronAPI.crm.opportunityStats()
      ])
      setOpps(list || [])
      setStats(st || null)
      // 逐个客户拉意向评分 0-100（跨库装配，失败忽略单个）
      const scoreMap: Record<number, OppScore> = {}
      await Promise.all((list || []).map(async (o: OppRow) => {
        try {
          const s = await window.electronAPI.crm.opportunityIntentScore(Number(o.account_id))
          if (s) scoreMap[o.id] = s
        } catch { /* 单个客户评分失败不影响列表 */ }
      }))
      setScores(scoreMap)
    } catch (e) { setNotice(String(e)) }
    setLoading(false)
  }
  useEffect(() => { void fetch() }, [])
  // 切微信号 = 换库（§2.40）：账号切换后重查
  useWxidRefresh(() => { void fetch() })

  // 漏斗（2026-08-29 对齐设计稿：HTML/CSS 阶段条替代 ECharts，同源 stageDist，点击阶段仍筛选列表）
  const funnelStages = useMemo(() => {
    if (!stats || !stats.stageDist.length) return []
    const data = STAGE_ORDER
      .map((stage) => {
        const row = stats.stageDist.find((d: any) => d.stage === stage)
        const idx = STAGE_ORDER.indexOf(stage as (typeof STAGE_ORDER)[number])
        const color = STAGE_COLORS[stage] || FUNNEL_NEUTRAL
        const light = idx >= 0 ? FUNNEL_STAGE_GRADIENT_LIGHT[idx] : '#CBD5E1'
        return { stage, count: Number(row?.count ?? 0), color, gradient: `linear-gradient(135deg, ${light}, ${color})` }
      })
    if (!data.some((d) => d.count > 0)) return []
    const max = Math.max(...data.map((d) => d.count), 1)
    return data.map((d, i) => ({
      ...d,
      width: `${Math.max(18, Math.round((d.count / max) * 100))}%`,
      rate: i > 0 && data[i - 1].count > 0 && d.count > 0 ? Math.round((d.count / data[i - 1].count) * 100) : null
    }))
  }, [stats])

  const filtered = stageFilter ? opps.filter((o) => o.stage === stageFilter) : opps
  const pendingAmount = opps.filter((o) => Number(o.amount) <= 0).length

  // 详情：拉事件时间线 + 客户风险（P0：竞品/价格/服务）；先清上一商机的残留，避免慢 IPC 时闪现旧数据
  const openDetail = async (o: OppRow) => {
    setSelected(o)
    setEvents([]); setRisks([])
    try { setEvents((await window.electronAPI.crm.opportunityEvents(o.id)) || []) } catch { setEvents([]) }
    try { setRisks((await window.electronAPI.crm.riskList({ accountId: Number(o.account_id) })) || []) } catch { setRisks([]) }
  }
  // 风险解决：人工确认已处理
  const resolveRisk = async (id: number) => {
    const ok = await window.electronAPI.crm.riskResolve(id)
    if (!ok) return
    setRisks((prev) => prev.map((r) => r.id === id ? { ...r, status: 'resolved', resolved_at: Date.now() } : r))
    setNotice('已确认处理该风险')
  }
  // 阶段推进（人工，留痕）
  const advance = async () => {
    if (!selected) return
    const next = NEXT_STAGE[selected.stage]
    if (!next) return
    const ok = await window.electronAPI.crm.opportunityStage(selected.id, next)
    setNotice(ok ? `已推进到「${next}」` : '阶段无变化')
    await openDetail(selected)
    await fetch()
  }
  // 关单：成交 / 丢单（丢单必填原因）
  const closeOpp = async (status: 'won' | 'lost') => {
    if (!selected) return
    const reason = status === 'won'
      ? (window.prompt('成交备注（可选）') ?? '').trim()
      : (window.prompt('丢单原因（必填）') ?? '').trim()
    if (status === 'lost' && !reason) { setNotice('丢单需填写原因'); return }
    const ok = await window.electronAPI.crm.opportunityClose(selected.id, status, reason || `人工标记${status === 'won' ? '成交' : '丢单'}`)
    setNotice(ok ? `已标记${status === 'won' ? '成交' : '丢单'}` : '操作失败')
    setSelected(null)
    await fetch()
  }

  return (
    <div className="opp-page">
      <div className="opp-header">
        <h2><Target size={18} /> 商机</h2>
        {notice && <span className="opp-notice">{notice}</span>}
        <button className="opp-btn opp-btn--ghost" onClick={() => void fetch()} disabled={loading}><RefreshCw size={14} /> 刷新</button>
      </div>

      {stats && (
        <div className="opp-stats">
          <div className="opp-stat"><span className="opp-stat__ico"><Activity size={17} /></span><div className="opp-stat__body"><span className="opp-stat__value">{stats.total}</span><span className="opp-stat__label">活跃商机</span></div></div>
          <div className="opp-stat"><span className="opp-stat__ico"><Banknote size={17} /></span><div className="opp-stat__body"><span className="opp-stat__value">{stats.totalAmount > 0 ? (stats.totalAmount >= 1e8 ? `¥${(stats.totalAmount / 1e8).toFixed(2)}亿` : `¥${(stats.totalAmount / 10000).toFixed(1)}万`) : '—'}</span><span className="opp-stat__label">商机金额（待人工确认）</span></div></div>
          <div className="opp-stat"><span className="opp-stat__ico neu"><Clock size={17} /></span><div className="opp-stat__body"><span className="opp-stat__value">{pendingAmount}</span><span className="opp-stat__label">金额待确认</span></div></div>
          <div className="opp-stat"><span className="opp-stat__ico"><Star size={17} /></span><div className="opp-stat__body"><span className="opp-stat__value">{opps.filter((o) => o.status === 'active' && o.stage === '决策').length}</span><span className="opp-stat__label">决策中</span></div></div>
        </div>
      )}

      {funnelStages.length > 0 ? (
        <div className="opp-chart">
          <h4 style={{ margin: '0 0 10px', fontSize: 13, fontWeight: 600 }}>商机阶段漏斗 <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)', fontWeight: 400, marginLeft: 6 }}>点击阶段筛选下方列表</span></h4>
          <div className="opp-funnel">
            {funnelStages.map((d, i) => (
              <div key={d.stage}>
                {i > 0 && <div className="opp-funnel__arrow">{d.rate !== null ? <>▼ 递进 <b>{d.rate}%</b></> : '▼'}</div>}
                <button
                  className={`opp-funnel__stage${stageFilter === d.stage ? ' active' : ''}`}
                  style={{ width: d.width, background: d.gradient }}
                  onClick={() => setStageFilter(stageFilter === d.stage ? '' : d.stage)}
                  title={`${d.stage}：${d.count} 个 · 点击筛选列表`}
                >
                  <span className="opp-funnel__name">{d.stage}</span>
                  <span className="opp-funnel__count">{d.count}</span>
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="opp-empty">暂无商机。客户在微信里表达采购意向（如"要几台""多少钱"）后会自动创建。</div>
      )}

      {stageFilter && (
        <div className="opp-filter">
          当前筛选：{stageFilter}
          <button className="opp-btn" onClick={() => setStageFilter('')}>清除</button>
        </div>
      )}

      <div className="card opp-list-card">
        <h4>商机列表{stageFilter ? ` · ${stageFilter}` : ''} <span className="opp-list-count">{filtered.length} 条</span></h4>
        <div className="opp-list">
        {filtered.map((o) => (
          <div key={o.id} className="opp-card" onClick={() => void openDetail(o)}>
            <div className="opp-card__main">
              <span className="opp-card__date">{fmtTime(Number(o.last_signal_at)).slice(0, 5)}</span>
              <span className="opp-card__name">{o.account_name || '未命名客户'}</span>
              <span className="opp-card__product">{o.product || o.name}</span>
              {Number(o.quantity) > 0 && <span className="opp-card__qty">×{o.quantity}</span>}
              <span className={`opp-badge opp-badge--${o.stage}`} style={{ background: STAGE_COLORS[o.stage] || FUNNEL_NEUTRAL }}>{o.stage}</span>
              {scores[o.id]?.level === '高意向' && <span className="crm-pill crm-pill--ok opp-card__intent">{scores[o.id].score} 高意向</span>}
              <span className={`opp-card__amt${Number(o.amount) > 0 ? '' : ' opp-card__amt--pending'}`}>{Number(o.amount) > 0 ? fmtAmount(Number(o.amount)) : '待确认'}</span>
              {scores[o.id] && (
                <span className={`opp-score opp-score--${scores[o.id].level}`} title={scores[o.id].factors.map((f) => `${f.label} ${f.delta >= 0 ? '+' : ''}${f.delta}：${f.reason}`).join('\n')}>
                  <span className="opp-score__t"><span>意向度</span><span className="opp-score__num">{scores[o.id].score}</span></span>
                  <span className="opp-score__bar"><span className="opp-score__fill" style={{ width: `${scores[o.id].score}%` }} /></span>
                </span>
              )}
              <span className="opp-card__time">最近信号 {fmtTime(Number(o.last_signal_at))}</span>
            </div>
          </div>
        ))}
        {!filtered.length && <div className="opp-empty">该阶段暂无商机</div>}
        </div>
      </div>

      {selected && (
        <div className="opp-modal">
          <div className="opp-modal__body">
            <h3>
              {selected.product || selected.name}
              <button className="opp-btn" onClick={() => setSelected(null)}><X size={14} /></button>
            </h3>
            <div className="opp-detail">
              <div className="opp-detail__row"><span>客户</span><b>{selected.account_name || '—'}</b></div>
              <div className="opp-detail__row"><span>产品</span><b>{selected.product || '—'}</b></div>
              <div className="opp-detail__row"><span>数量</span><b>{selected.quantity > 0 ? `${selected.quantity} 台` : '—'}</b></div>
              <div className="opp-detail__row"><span>金额</span><b>{fmtAmount(Number(selected.amount))}</b></div>
              <div className="opp-detail__row"><span>阶段</span><b>{selected.stage}</b></div>
              <div className="opp-detail__row"><span>最近信号</span><b>{fmtTime(Number(selected.last_signal_at))}</b></div>
              <div className="opp-detail__row"><span>意向评分</span><b>{scores[selected.id] ? `${scores[selected.id].score} / 100 · ${scores[selected.id].level}` : '—'}</b></div>
            </div>
            {scores[selected.id] && scores[selected.id].factors.length > 0 && (
              <div className="opp-factors">
                <h4>意向评分依据</h4>
                {scores[selected.id].factors.map((f) => (
                  <div key={f.label} className="opp-factor">
                    <span className="opp-factor__label">{f.label}</span>
                    <span className={`opp-factor__delta ${f.delta >= 0 ? 'pos' : 'neg'}`}>{f.delta >= 0 ? `+${f.delta}` : f.delta}</span>
                    <span className="opp-factor__reason">{f.reason}</span>
                  </div>
                ))}
              </div>
            )}
            <div className="opp-risks">
              <h4>风险预警</h4>
              {risks.map((r) => (
                <div key={r.id} className={`opp-risk opp-risk--${r.severity} ${r.status === 'resolved' ? 'is-resolved' : ''}`}>
                  <div className="opp-risk__head">
                    <span className="opp-risk__type">{RISK_TYPE_LABEL[r.risk_type] || r.risk_type}</span>
                    <span className="opp-risk__severity">{RISK_SEVERITY_LABEL[r.severity] || r.severity}</span>
                    <span className="opp-risk__time">{fmtTime(Number(r.created_at))}</span>
                    {r.status === 'active' && (
                      <button className="opp-risk__resolve" onClick={() => void resolveRisk(r.id)}>确认处理</button>
                    )}
                    {r.status === 'resolved' && <span className="opp-risk__done">已处理</span>}
                  </div>
                  <div className="opp-risk__detail">{r.detail}</div>
                </div>
              ))}
              {!risks.length && <div className="opp-empty">暂无风险信号</div>}
            </div>
            <div className="opp-actions">
              {NEXT_STAGE[selected.stage] && (
                <button className="opp-btn opp-btn--primary" onClick={() => void advance()}>
                  推进到 {NEXT_STAGE[selected.stage]}
                </button>
              )}
              <button className="opp-btn opp-btn--win" onClick={() => void closeOpp('won')}><CheckCircle2 size={14} /> 成交</button>
              <button className="opp-btn opp-btn--lose" onClick={() => void closeOpp('lost')}><XCircle size={14} /> 丢单</button>
            </div>
            <div className="opp-events">
              <h4>商机事件</h4>
              {events.map((e) => (
                <div key={e.id} className="opp-event">
                  <span className="opp-event__tag">{EVENT_LABEL[e.event_type] || e.event_type}</span>
                  {e.stage && <span className="opp-event__stage">{e.stage}</span>}
                  <span className="opp-event__detail">{e.detail}</span>
                  <span className="opp-event__time">{fmtTime(Number(e.created_at))}</span>
                </div>
              ))}
              {!events.length && <div className="opp-empty">暂无事件</div>}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
