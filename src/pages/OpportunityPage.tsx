/**
 * OpportunityPage.tsx —— 商机：AI 从微信聊天自动识别采购信号 → 商机列表 / 漏斗 / 详情
 * 数据源 window.electronAPI.crm.opportunity*（crmDbService 商机模块）
 */
import { useEffect, useMemo, useState } from 'react'
import { RefreshCw, X, CheckCircle2, XCircle } from 'lucide-react'
import ReactECharts from 'echarts-for-react'
import './OpportunityPage.scss'

// 商机阶段（复用客户漏斗 5 档：了解/比价/决策 进漏斗；成交=won / 流失=lost 单独展示）
const STAGE_ORDER = ['了解', '比价', '决策'] as const
const STAGE_COLORS: Record<string, string> = {
  了解: '#60a5fa', 比价: '#f59e0b', 决策: '#ef4444', 成交: '#16a34a', 流失: '#94a3b8', unknown: '#cbd5e1'
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
    } catch (e) { setNotice(String(e)) }
    setLoading(false)
  }
  useEffect(() => { void fetch() }, [])

  // 漏斗 option：active 商机按阶段分布（了解/比价/决策），点击下钻筛选列表
  const funnelOption = useMemo(() => {
    if (!stats || !stats.stageDist.length) return null
    const data = stats.stageDist
      .filter((d) => STAGE_ORDER.includes(d.stage as (typeof STAGE_ORDER)[number]))
      .map((d) => ({ name: d.stage, value: d.count, itemStyle: { color: STAGE_COLORS[d.stage] || '#94a3b8' } }))
    if (!data.length) return null
    return {
      tooltip: { trigger: 'item' as const, formatter: '{b}: {c} 个' },
      series: [{
        type: 'funnel', left: '16%', right: '16%', top: 12, bottom: 12,
        minSize: '16%', maxSize: '100%', sort: 'none' as const, gap: 4,
        label: { show: true, position: 'inside' as const, fontSize: 12, color: '#fff' },
        data
      }]
    }
  }, [stats])
  const funnelEvents = useMemo(() => ({
    click: (p: { name?: string }) => setStageFilter(String(p?.name || ''))
  }), [])

  const filtered = stageFilter ? opps.filter((o) => o.stage === stageFilter) : opps
  const pendingAmount = opps.filter((o) => Number(o.amount) <= 0).length

  // 详情：拉事件时间线
  const openDetail = async (o: OppRow) => {
    setSelected(o)
    try { setEvents((await window.electronAPI.crm.opportunityEvents(o.id)) || []) } catch { setEvents([]) }
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
        <h2>商机</h2>
        {notice && <span className="opp-notice">{notice}</span>}
        <button className="opp-btn" onClick={() => void fetch()} disabled={loading}><RefreshCw size={14} /> 刷新</button>
      </div>

      {stats && (
        <div className="opp-stats">
          <div className="opp-stat"><span className="opp-stat__value">{stats.total}</span><span className="opp-stat__label">活跃商机</span></div>
          <div className="opp-stat"><span className="opp-stat__value">{stats.totalAmount > 0 ? `¥${(stats.totalAmount / 10000).toFixed(1)}万` : '—'}</span><span className="opp-stat__label">商机金额</span></div>
          <div className="opp-stat"><span className="opp-stat__value">{pendingAmount}</span><span className="opp-stat__label">金额待确认</span></div>
          <div className="opp-stat"><span className="opp-stat__value">{opps.filter((o) => o.status === 'active' && o.stage === '决策').length}</span><span className="opp-stat__label">决策中</span></div>
        </div>
      )}

      {funnelOption ? (
        <div className="opp-chart">
          <ReactECharts option={funnelOption} style={{ height: 220 }} notMerge onEvents={funnelEvents} />
          <div className="opp-drill-hint">点击漏斗阶段 → 筛选下方商机列表</div>
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

      <div className="opp-list">
        {filtered.map((o) => (
          <div key={o.id} className="opp-card" onClick={() => void openDetail(o)}>
            <div className="opp-card__main">
              <span className="opp-card__name">{o.account_name || '未命名客户'}</span>
              <span className="opp-card__product">{o.product || o.name}</span>
              {Number(o.quantity) > 0 && <span className="opp-card__qty">×{o.quantity}</span>}
              <span className={`opp-badge opp-badge--${o.stage}`}>{o.stage}</span>
            </div>
            <div className="opp-card__sub">
              <span className="opp-card__amt">{fmtAmount(Number(o.amount))}</span>
              <span className="opp-card__time">最近信号 {fmtTime(Number(o.last_signal_at))}</span>
            </div>
          </div>
        ))}
        {!filtered.length && <div className="opp-empty">该阶段暂无商机</div>}
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
