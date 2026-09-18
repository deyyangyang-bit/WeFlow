/**
 * ActionFunnelPage.tsx —— P0-4.3：Action Funnel 展示（Task-level 六段漏斗 + KPI + 点击下钻）
 *
 * 拍板契约（用户 2026-08-24 P0-4.3 三件事）：
 *   ① 漏斗展示：五段直观漏斗（行动产生 → 销售执行 → 客户响应 → 有效推进 → 成交）；
 *      行动曝光显示「N/A · 当前未埋点」（G1 不硬算曝光率，不为好看伪造分母）
 *   ② KPI 只放有意义的：行动数 / 执行率 / 客户响应率★（执行→响应）/ 响应→推进转化率 / 成交数；
 *      分母 0 → N/A（不显示 0%，防「无样本」误读成「0% 转化」）
 *   ③ 点击可解释：执行/响应率点击 → 事件类型计数 + 最近任务样本（数字可追溯到事件）
 *
 * 数据：sales:actionFunnel:get（聚合）+ sales:actionFunnel:breakdown（下钻），纯只读不调 LLM。
 * 口径真源：electron/services/actionFunnel.ts（§2.36）；本页只消费不重算。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { RefreshCw, X, Filter } from 'lucide-react'
import FunnelCylinder from '../components/FunnelCylinder'
import './ActionFunnelPage.scss'

interface FunnelData {
  window: { days: number | null; startMs: number | null }
  stages: { created: number; exposed: null; executed: number; responded: number; progressed: number; won: number }
  rates: { exposure: null; execution: number | null; response: number | null; progression: number | null; conversion: number | null }
  sources: { created: string; exposed: string; executed: string; responded: string; progressed: string; won: string }
  supersededCount: number
}

interface BreakdownData {
  executed: {
    count: number; unexecuted: number
    eventTypeCounts: { script_copied: number; chat_opened: number; follow_up_done: number }
    samples: Array<{ taskId: number; sessionId: string; title: string; createdAt: number; eventTypes: string[] }>
  }
  responded: {
    count: number; unresponded: number
    eventTypeCounts: { customer_replied: number; quote_asked: number }
    samples: Array<{ taskId: number; sessionId: string; title: string; createdAt: number }>
  }
}

const DAY_OPTIONS = [
  { label: '近7天', value: 7 },
  { label: '近30天', value: 30 },
  { label: '近90天', value: 90 },
  { label: '全部', value: 0 }
] as const

// 五段行为阶段：色板由 FunnelCylinder 组件内部统一取 shared/funnelPalette（页面不碰色值）
const STAGE_NAMES = ['行动产生', '销售执行', '客户响应', '有效推进', '成交']
// 梯形固定比例收窄（纯装饰分层，不与数值绑定——跳级/转化率>100% 不改变形状；修复版规格）
const STAGE_WIDTHS = [100, 76, 56, 40, 28] as const

/** 推进/成交段与销售漏斗的映射关系（tooltip 弱化，非常驻文字） */
const STAGE_MAPPINGS: Partial<Record<string, string>> = {
  progressed: '有效推进 = 比价→决策→成交 的阶段变更（customer_profile.stage 变更）',
  won: '成交 = 销售漏斗「成交」档（同一 customer_profile.stage 口径）'
}

/** 下钻弹层内容（统一结构：说明行 + 可选事件明细 + 可选任务样本 + 口径注）；value 兼容 number（事件计数直传） */
interface DrillContent {
  title: string
  rows: Array<{ label: string; value: string | number }>
  eventRows?: Array<{ label: string; value: string | number }>
  samples?: Array<{ taskId: number; sessionId: string; title: string; createdAt: number; eventTypes?: string[] }>
  note?: string
}

const EVENT_TYPE_LABELS: Record<string, string> = {
  script_copied: '复制话术', chat_opened: '打开聊天', follow_up_done: '完成跟进',
  customer_replied: '客户回复', quote_asked: '询问报价'
}

/** rate 显示：null = N/A（分母 0），数字 = 百分比一位小数 */
function fmtRate(r: number | null): string {
  return r === null ? 'N/A' : `${(r * 100).toFixed(1)}%`
}

function fmtTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

interface KpiCardProps {
  label: string
  value: string
  note?: string
  highlight?: boolean
  onClick?: () => void
}

function KpiCard({ label, value, note, highlight, onClick }: KpiCardProps) {
  return (
    <button className={`af-kpi${highlight ? ' af-kpi--star' : ''}${onClick ? ' af-kpi--clickable' : ''}`} onClick={onClick}>
      <span className="af-kpi__label">{label}{highlight && <span className="af-kpi__star">★</span>}</span>
      <span className="af-kpi__value">{value}</span>
      {note && <span className="af-kpi__note">{note}</span>}
    </button>
  )
}

type DrillKey = 'executed' | 'responded' | 'created' | 'progressed' | 'won'

export default function ActionFunnelPage() {
  const [days, setDays] = useState(7)
  const [data, setData] = useState<FunnelData | null>(null)
  const [breakdown, setBreakdown] = useState<BreakdownData | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [drill, setDrill] = useState<DrillKey | null>(null)

  const fetch = useCallback(async (d: number) => {
    setLoading(true)
    try {
      const [f, b] = await Promise.all([
        window.electronAPI.sales.actionFunnelGet(d === 0 ? null : d),
        window.electronAPI.sales.actionFunnelBreakdown(d === 0 ? null : d)
      ])
      if (f.success && f.data) setData(f.data)
      else setError(f.error || '加载失败')
      if (b.success && b.data) setBreakdown(b.data)
      else setError(b.error || '下钻加载失败')
    } catch (e) { setError(String(e)) }
    setLoading(false)
  }, [])

  useEffect(() => { void fetch(days) }, [days, fetch])

  // 立体圆柱漏斗数据（A048 风格，2026-09-03 拍板；宽度固定比例纯装饰，不与数值绑定）
  // 每段 = 段名 + 人数（大字）；段间标注 = 相邻转化率（第 1 段为源头不显示；N/A = 分母 0 不硬算）
  const funnelStages = useMemo(() => {
    if (!data) return null
    return [
      { key: 'created', name: STAGE_NAMES[0], count: data.stages.created, rate: null as number | null },
      { key: 'executed', name: STAGE_NAMES[1], count: data.stages.executed, rate: data.rates.execution },
      { key: 'responded', name: STAGE_NAMES[2], count: data.stages.responded, rate: data.rates.response },
      { key: 'progressed', name: STAGE_NAMES[3], count: data.stages.progressed, rate: data.rates.progression },
      { key: 'won', name: STAGE_NAMES[4], count: data.stages.won, rate: data.rates.conversion }
    ] as Array<{ key: DrillKey; name: string; count: number; rate: number | null }>
  }, [data])
  const hasAny = funnelStages?.some((s) => s.count > 0) ?? false
  const cylinderStages = useMemo(() =>
    funnelStages?.map((s, i) => ({
      key: s.key,
      name: s.name,
      countText: String(s.count),
      gapText: i === 0 ? null : (s.rate === null ? 'N/A' : `转化 ${(s.rate * 100).toFixed(1)}%`),
      hint: STAGE_MAPPINGS[s.key]
    })), [funnelStages])

  // 下钻说明文案（数字可解释，不裸给数字；执行/响应有事件明细，推进/成交只有口径说明）
  const drillContent = useMemo(() => {
    if (!data || !breakdown || !drill) return null
    if (drill === 'created') {
      return {
        title: '行动产生',
        rows: [
          { label: '窗口内行动', value: String(data.stages.created) },
          { label: '被取代（superseded）', value: String(data.supersededCount) },
          { label: '事实来源', value: 'follow_up_task（created_at 落在窗口内，非 superseded）' }
        ],
        note: 'superseded 不重复计：其「产生」已由取代者代表（盘点口径透明）'
      } as DrillContent
    }
    if (drill === 'executed') {
      const et = breakdown.executed.eventTypeCounts
      return {
        title: '销售执行',
        rows: [
          { label: '已执行', value: String(breakdown.executed.count) },
          { label: '未执行', value: String(breakdown.executed.unexecuted) }
        ],
        eventRows: [
          { label: EVENT_TYPE_LABELS.script_copied, value: et.script_copied },
          { label: EVENT_TYPE_LABELS.chat_opened, value: et.chat_opened },
          { label: EVENT_TYPE_LABELS.follow_up_done, value: et.follow_up_done }
        ],
        samples: breakdown.executed.samples,
        note: '执行 = 任务至少一个执行事件（事件须在任务产生后）；类型计数为事件条数，一个任务可有多动作'
      } as DrillContent
    }
    if (drill === 'responded') {
      const et = breakdown.responded.eventTypeCounts
      return {
        title: '客户响应',
        rows: [
          { label: '已响应', value: String(breakdown.responded.count) },
          { label: '执行后未响应', value: String(breakdown.responded.unresponded) }
        ],
        eventRows: [
          { label: EVENT_TYPE_LABELS.customer_replied, value: et.customer_replied },
          { label: EVENT_TYPE_LABELS.quote_asked, value: et.quote_asked }
        ],
        samples: breakdown.responded.samples,
        note: '响应 = 任务产生后该客户有实质回复/报价询问（session 轴关联）；执行→响应是北极星指标'
      } as DrillContent
    }
    // progressed / won：无事件级明细（事实来源是 customer_profile.stage，非 customer_event）——诚实说明口径
    if (drill === 'progressed') {
      return {
        title: '有效推进',
        rows: [
          { label: '已推进', value: String(data.stages.progressed) },
          { label: '响应后未推进', value: String(Math.max(0, data.stages.responded - data.stages.progressed)) }
        ],
        note: '推进 = 任务产生后该客户 stage 有变更（last_stage_change_at）；事实来源 customer_profile.stage，事件明细属 P0-2A.6 阶段变更记录，不在 customer_event——本段暂不提供事件级下钻'
      } as DrillContent
    }
    return {
      title: '商机转化',
      rows: [
        { label: '当前成交', value: String(data.stages.won) },
        { label: '事实来源', value: 'customer_profile.stage = 成交（normalizeStage 中文口径）' }
      ],
      note: '成交 = 推进的最终落点；真实库当前 won 计数来自客户档案 stage，非本窗口事件'
    } as DrillContent
  }, [data, breakdown, drill])

  return (
    <div className="af-page">
      {/* 页眉（概念稿 .shead：左小标/标题/口径说明，右时间窗与刷新）——hero 用窗口内既有计数拼句
          （行动/执行/响应均为窗口口径；成交数是「当前 stage」，不进 hero，避免跨口径混读） */}
      <header className="shead af-header">
        <div className="af-header__lead">
          <p className="eyebrow">报表 · 行动漏斗</p>
          <h1 className="hero af-header__title">
            {data
              ? `${days === 0 ? '全部' : `近${days}天`} ${data.stages.created} 个行动，${data.stages.executed} 已执行、${data.stages.responded} 已响应`
              : '行动漏斗'}
          </h1>
          <p className="sub af-header__sub">AI 推荐 → 销售执行 → 客户响应 → 商机推进（Task-level，P0-4）</p>
        </div>
        <div className="shead__actions af-header__actions">
          <div className="chipbar" role="group" aria-label="统计时间窗">
            {DAY_OPTIONS.map((o) => (
              <button
                key={o.value}
                className={`chip${days === o.value ? ' is-on' : ''}`}
                onClick={() => setDays(o.value)}
              >{o.label}</button>
            ))}
          </div>
          <button className="btn btn--quiet" onClick={() => void fetch(days)} disabled={loading}><RefreshCw size={14} /> 刷新</button>
        </div>
      </header>
      {error && <div className="af-error">{error}</div>}
      {loading && !data && <div className="af-empty">加载中…</div>}

      {data && (
        <div className="af-body">
          {/* KPI：只放有意义的几个；★ = 北极星（执行→响应） */}
          <div className="af-kpis">
            <KpiCard label="行动数" value={String(data.stages.created)} note={`窗口 ${days === 0 ? '全部' : `近${days}天`}`} onClick={() => setDrill('created')} />
            <KpiCard label="执行率" value={fmtRate(data.rates.execution)} note={`${data.stages.executed}/${data.stages.created} 执行`} onClick={() => setDrill('executed')} />
            <KpiCard label="执行 → 响应" value={fmtRate(data.rates.response)} note={`${data.stages.responded}/${data.stages.executed} 响应`} highlight onClick={() => setDrill('responded')} />
            <KpiCard label="响应 → 推进" value={fmtRate(data.rates.progression)} note={`${data.stages.progressed}/${data.stages.responded} 推进`} onClick={() => setDrill('progressed')} />
            <KpiCard label="成交数" value={String(data.stages.won)} note="当前 stage=成交" onClick={() => setDrill('won')} />
            {/* 曝光段：G1 未埋点，诚实 N/A 不硬算——第 6 张 KPI 卡，与其余卡同格呈现（设计稿对齐） */}
            <KpiCard label="曝光" value="N/A" note="当前未埋点——不为好看硬算曝光率" />
          </div>

          {/* 五段漏斗（A048 立体圆柱，共用组件 FunnelCylinder；不含曝光段——无数字不入图） */}
          <div className="af-chart">
            {cylinderStages && hasAny ? (
              <FunnelCylinder
                stages={cylinderStages}
                widths={STAGE_WIDTHS}
                onStageClick={(k) => setDrill(k as DrillKey)}
              />
            ) : (
              <div className="af-empty">暂无行动数据</div>
            )}
          </div>

          <p className="af-footnote">
            口径：每个任务布尔 0/1（非事件条数）；分母为 0 显示 N/A（不误读 0%）；执行/响应率点击可下钻到事件明细。
            事实来源：行动产生=follow_up_task · 执行/响应=customer_event · 推进/成交=customer_profile.stage · 曝光=未埋点。
          </p>
        </div>
      )}

      {/* 下钻弹层：数字可追溯到事件 */}
      {drillContent && (
        <div className="af-modal" onClick={() => setDrill(null)}>
          <div className="af-modal__panel" onClick={(e) => e.stopPropagation()}>
            <div className="af-modal__head">
              <h3><Filter size={14} /> {drillContent.title}下钻</h3>
              <button className="af-modal__close" onClick={() => setDrill(null)}><X size={16} /></button>
            </div>
            <div className="af-modal__rows">
              {drillContent.rows.map((r) => (
                <div key={r.label} className="af-modal__row">
                  <span>{r.label}</span>
                  <b>{r.value}</b>
                </div>
              ))}
            </div>
            {drillContent.eventRows && (
              <div className="af-modal__events">
                <div className="af-modal__section-title">事件明细</div>
                {drillContent.eventRows.map((e) => (
                  <div key={e.label} className="af-modal__row">
                    <span>{e.label}</span>
                    <b>{e.value}</b>
                  </div>
                ))}
              </div>
            )}
            {drillContent.samples && drillContent.samples.length > 0 && (
              <div className="af-modal__samples">
                <div className="af-modal__section-title">最近任务（可追溯到事件）</div>
                {drillContent.samples.map((s) => (
                  <div key={s.taskId} className="af-modal__sample">
                    <div className="af-modal__sample-title">{s.title || '(无标题)'}</div>
                    <div className="af-modal__sample-meta">
                      <span>{s.sessionId}</span>
                      <span>{fmtTime(s.createdAt)}</span>
                      {s.eventTypes && s.eventTypes.length > 0 && (
                        <span className="af-modal__sample-tags">
                          {s.eventTypes.map((t) => <i key={t} className="af-modal__tag">{EVENT_TYPE_LABELS[t] ?? t}</i>)}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
            {drillContent.note && <p className="af-modal__note">{drillContent.note}</p>}
          </div>
        </div>
      )}
    </div>
  )
}
