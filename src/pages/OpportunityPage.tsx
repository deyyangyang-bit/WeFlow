import GeneratedFileResult from '../components/crm/GeneratedFileResult'
/**
 * OpportunityPage.tsx —— 商机：AI 从微信聊天自动识别采购信号 → 商机列表 / 漏斗 / 详情
 * 数据源 window.electronAPI.crm.opportunity*（crmDbService 商机模块）
 *
 * 成交登记（宪法 §1.5 / PRD v3.4 §5.1）：
 *   - 成交按钮 → 正式成交表单（金额/币种/原币金额/汇率说明/主型号/补充型号/订单量/
 *     预计发运区间/交付日期/整车改装/报价版本），统一走 opportunityRegisterDeal 事务单点。
 *   - 主型号从产品库下拉（禁手填）；补充型号落 custom_fields.supplementary_models。
 *   - 非 CNY 单要求原币金额 + 汇率说明；旧数据空字段统一显示「未登记」。
 *   - 丢单保持原因表单（预设原因 + 补充说明，必填）。
 *   - 报价历史只读展示（版本/生效期/总额/文件/哈希状态，宪法 §1.6 append-only）。
 *
 * 2026-09-18 P2.1b：纯视觉对齐（按钮接共享档位 / 漏斗条改 .rail / 列表安静 tag / 详情弹窗压平），
 * 数据链路、字段与契约不变。
 *
 * 2026-09-18 P2.1b-A：默认主视图改概念稿式阶段看板（.board：了解/比价/决策/成交 四列，
 * 列 key = stage 真源；「成交」列 = active 已推进到成交档 + 近 30 天 won，流失不进看板）。
 * 卡片点击开既有详情；拖拽跨列走既有 opportunityStage（与「推进到 xx」同一写路径，留痕一致）；
 * 正式 won 只走成交登记表单（宪法 §1.5 单点），接口 opportunity* 不新增不改签名。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { filterByOwner, isSalesView, identityLikeFromIpc, type IdentityLike } from '../utils/leadAssignmentView'
import { useWxidRefresh } from '../utils/useWxidRefresh'
import { buildNextStep, RISK_TYPE_LABEL, RISK_SEVERITY_LABEL } from '../utils/oppNextStep'
import { fmtDate, fmtQty, toDateInput, fromDateInput } from '../utils/formatBiz'
import { isSessionIdLike } from '../../shared/wechatId'
import { useCrmStore } from '../stores/crmStore'
import type { OpportunityDealRegistration, OpportunityRecord, QuotationRecord } from '../types/electron'
import type { OpportunityAnalysisResult, OppAssessment } from '../../shared/opportunitySignals'
import OpportunityStageAnalysis from '../components/crm/OpportunityStageAnalysis'
import { RefreshCw, X, CheckCircle2, XCircle, Lock, BarChart3, List, KanbanSquare } from 'lucide-react'
// 阶段色单一真源（红线 3）：与销售漏斗同族 Apple 蓝渐变。P2.1b 起段色只作安静 tag 文字与
// rail 圆点点缀，不再整块铺色；unknown 无段色，回落 CSS tertiary。
import { FUNNEL_STAGE_COLORS, FUNNEL_NEUTRAL } from '../../shared/funnelPalette'
import './OpportunityPage.scss'

// 商机阶段（复用客户漏斗 5 档：了解/比价/决策 进漏斗；成交=won / 流失=lost 单独展示）
const STAGE_ORDER = ['了解', '比价', '决策'] as const
const STAGE_COLORS: Record<string, string> = {
  了解: FUNNEL_STAGE_COLORS[0], 比价: FUNNEL_STAGE_COLORS[1], 决策: FUNNEL_STAGE_COLORS[2],
  成交: FUNNEL_STAGE_COLORS[4], 流失: FUNNEL_NEUTRAL
}
// 阶段推进路径：了解 → 比价 → 决策 → 成交
const NEXT_STAGE: Record<string, string> = { 了解: '比价', 比价: '决策', 决策: '成交' }

// 行类型：SQL SELECT o.* 实际带 owner_sales（归属过滤档用），类型声明里没有——交叉补齐可选字段，
// 只补类型不改运行时数据
type OppRow = OpportunityRecord & { owner_sales?: string | null }
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

// 风险类型/严重度文案迁至 utils/oppNextStep（与「建议下一步」投影共用单一真源）

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
// 发运区间：双 0 = 未登记；单边 = 起/至
function fmtRange(a: number | undefined, b: number | undefined): string {
  const s = Number(a || 0); const e = Number(b || 0)
  if (!s && !e) return '未登记'
  if (s && !e) return `${fmtDate(s)} 起`
  if (!s && e) return `至 ${fmtDate(e)}`
  return `${fmtDate(s)} ~ ${fmtDate(e)}`
}
// 补充型号：custom_fields.supplementary_models（PRD「扩展属性：自由文本」）
function supplementaryModels(o: OppRow | null): string {
  if (!o?.custom_fields) return ''
  try {
    const cf = JSON.parse(o.custom_fields)
    return String(cf.supplementary_models || '')
  } catch { return '' }
}
// 事件类型文案
const EVENT_LABEL: Record<string, string> = {
  created: '创建', signal: '采购信号', stage_change: '阶段推进', won: '成交', lost: '丢单', deal_pending: '待成交登记'
}

// 备注名里的日期前缀剥离（同客户页 namePartsOf 思路，纯展示；store 字段与检索口径不动）
const NAME_DATE_PREFIX = /^(?:[[(（【])?((?:\d{2}|\d{4})[.\-/]\d{1,2}[.\-/]\d{1,2})(?:[\])）】])?[\s·\-—–,，、|]*/
function namePartsOf(raw: string): { main: string; date: string } {
  const full = String(raw || '').trim()
  const m = full.match(NAME_DATE_PREFIX)
  const rest = m ? full.slice(m[0].length).trim() : ''
  if (!m || !rest) return { main: full, date: '' }
  return { main: rest, date: m[1] }
}
function nameOnlyOf(raw: string) { return namePartsOf(raw).main }

// 币种下拉（人工登记；外贸单以 RMB 结算，不做自动换算——宪法 §1.5）
const CURRENCY_OPTIONS = ['CNY', 'USD', 'EUR', 'JPY', 'HKD', 'AUD', 'CAD', 'GBP']
// 整车/改装
const DEAL_TYPE_OPTIONS = ['整车', '改装']
// 丢单预设原因（后端无枚举 IPC，前端预设；原因写 opportunity_event.detail 留痕）
const LOST_REASONS = ['价格过高', '竞品抢单', '预算不足', '需求变化', '决策周期过长', '失联', '其他']

// 商机 → 客户合同 → 报价版本链。成交候选只取合同指针指向的当前版本；详情读取完整历史。
async function fetchQuotationsByAccount(accountId: number, currentOnly = false): Promise<QuotationRecord[]> {
  if (!accountId) return []
  try {
    const contracts = await window.electronAPI.crm.list('contract', { account_id: accountId, limit: 100 })
    const groups = await Promise.all((contracts || []).map(async (c: any) => {
      if (currentOnly) {
        const current = await window.electronAPI.crm.quotationCurrent(Number(c.id)).catch(() => null)
        return current ? [current] : []
      }
      return window.electronAPI.crm.quotationHistory(Number(c.id)).catch(() => [])
    }))
    return groups.flat() as QuotationRecord[]
  } catch { return [] }
}

// ─── 正式成交表单（宪法 §1.5 D3 列；替代原 window.prompt）──────────────────────

function DealForm({ opp, onClose, onDone }: {
  opp: OppRow
  onClose: () => void
  onDone: (msg: string) => void
}) {
  const { products, fetchProducts } = useCrmStore()
  const [amountCny, setAmountCny] = useState(
    Number(opp.amount_cny) > 0 ? String(opp.amount_cny) : Number(opp.amount) > 0 ? String(opp.amount) : ''
  )
  const [currency, setCurrency] = useState(opp.original_currency || 'CNY')
  const [originalAmount, setOriginalAmount] = useState(Number(opp.original_amount) > 0 ? String(opp.original_amount) : '')
  const [rateNote, setRateNote] = useState(opp.rate_note || '')
  const [mainModel, setMainModel] = useState(opp.main_model || '')
  const [extraModels, setExtraModels] = useState(supplementaryModels(opp))
  const [orderQty, setOrderQty] = useState(
    Number(opp.order_qty) > 0 ? String(opp.order_qty) : Number(opp.quantity) > 0 ? String(opp.quantity) : ''
  )
  const [shipStart, setShipStart] = useState(toDateInput(opp.expected_ship_start))
  const [shipEnd, setShipEnd] = useState(toDateInput(opp.expected_ship_end))
  const [deliveryDate, setDeliveryDate] = useState(toDateInput(opp.delivery_date))
  const [dealType, setDealType] = useState(opp.type || '')
  const [quoteVersionId, setQuoteVersionId] = useState<number>(Number(opp.quote_version_id) || 0)
  const [quotations, setQuotations] = useState<QuotationRecord[]>([])
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!products.length) void fetchProducts()
    void fetchQuotationsByAccount(Number(opp.account_id), true).then(setQuotations)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opp.account_id])

  const isNonCny = currency !== 'CNY'
  const canSubmit = !saving && (!isNonCny || (parseFloat(originalAmount) > 0 && rateNote.trim().length > 0))

  const submit = async () => {
    const amountCnyNum = parseFloat(amountCny) || 0
    const payload: OpportunityDealRegistration = {
      amount_cny: amountCnyNum,
      original_currency: currency,
      original_amount: isNonCny ? (parseFloat(originalAmount) || 0) : 0,
      rate_note: isNonCny ? rateNote.trim() : '',
      main_model: mainModel.trim(),
      order_qty: parseInt(orderQty, 10) || 0,
      expected_ship_start: fromDateInput(shipStart),
      expected_ship_end: fromDateInput(shipEnd),
      delivery_date: fromDateInput(deliveryDate),
      type: dealType,
      quote_version_id: quoteVersionId > 0 ? quoteVersionId : null,
      model_extra: extraModels.trim(),
      note: note.trim()
    }
    setSaving(true)
    try {
      const result = await window.electronAPI.crm.opportunityRegisterDeal(opp.id, payload)
      onDone(result.ok ? '已登记成交' : `成交登记失败：${result.reason || '未知原因'}`)
    } catch (e) {
      onDone(`成交登记失败：${String(e)}`)
    }
  }

  return (
    <div className="opp-modal" onClick={onClose}>
      <div className="opp-modal__body opp-form" onClick={e => e.stopPropagation()}>
        <h3>
          正式成交登记 · {opp.account_name || '未命名客户'}
          <button className="iconbtn" aria-label="关闭" onClick={onClose}><X size={15} /></button>
        </h3>

        <div className="opp-form__grid">
          <label className="opp-form__label">金额（CNY 结算）</label>
          <input type="number" min="0" step="0.01" value={amountCny} onChange={e => setAmountCny(e.target.value)}
            placeholder="人民币结算额，业绩/报表统一口径" />

          <label className="opp-form__label">币种</label>
          <select value={currency} onChange={e => setCurrency(e.target.value)}>
            {CURRENCY_OPTIONS.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>

          {isNonCny && (
            <>
              <label className="opp-form__label">原币金额（{currency}）</label>
              <input type="number" min="0" step="0.01" value={originalAmount} onChange={e => setOriginalAmount(e.target.value)}
                placeholder="以外币成交时必填" />

              <label className="opp-form__label">汇率说明</label>
              <input type="text" value={rateNote} onChange={e => setRateNote(e.target.value)}
                placeholder="折算口径/凭证（支付订单号、回单截图哈希等），必填" />
            </>
          )}

          <label className="opp-form__label">产品型号</label>
          <select value={mainModel} onChange={e => setMainModel(e.target.value)}>
            <option value="">从产品库选择…</option>
            {products.map((p: any) => (
              <option key={p.id} value={String(p.model || p.name)}>{p.name}{p.model ? ` · ${p.model}` : ''}</option>
            ))}
          </select>
          {products.length === 0 && <span className="opp-form__hint">产品库为空，请先到「型号库」添加产品</span>}

          <label className="opp-form__label">补充型号</label>
          <input type="text" value={extraModels} onChange={e => setExtraModels(e.target.value)}
            placeholder="自由文本，多型号用 / 分隔" />

          <label className="opp-form__label">订单量（台）</label>
          <input type="number" min="0" step="1" value={orderQty} onChange={e => setOrderQty(e.target.value)} placeholder="订单量" />

          <label className="opp-form__label">预计发运区间</label>
          <span className="opp-form__range">
            <input type="date" value={shipStart} onChange={e => setShipStart(e.target.value)} />
            <i>~</i>
            <input type="date" value={shipEnd} onChange={e => setShipEnd(e.target.value)} />
          </span>

          <label className="opp-form__label">交付日期</label>
          <input type="date" value={deliveryDate} onChange={e => setDeliveryDate(e.target.value)}
            title="售后设备提醒起算基准" />

          <label className="opp-form__label">整车/改装</label>
          <select value={dealType} onChange={e => setDealType(e.target.value)}>
            <option value="">未登记</option>
            {DEAL_TYPE_OPTIONS.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>

          <label className="opp-form__label">报价版本</label>
          <select value={quoteVersionId} onChange={e => setQuoteVersionId(Number(e.target.value))}>
            <option value={0}>未绑定</option>
            {quotations.map((q) => (
              <option key={q.id} value={q.id}>
                报价单 #{q.id} · v{q.version || 1} · ¥{Number(q.total || 0).toLocaleString()}
              </option>
            ))}
          </select>
          {quotations.length === 0 && <span className="opp-form__hint">该客户暂无报价单，可稍后在合同工作台创建后回填</span>}

          <label className="opp-form__label">成交备注</label>
          <input type="text" value={note} onChange={e => setNote(e.target.value)} placeholder="选填，写入商机事件留痕" />
        </div>

        <div className="opp-form__actions">
          <span className="opp-form__hint">
            {isNonCny ? '非 CNY 单需填写原币金额与汇率说明' : '成交字段、关单事件与审计将一次提交'}
          </span>
          <button className="btn btn--plain" onClick={onClose} disabled={saving}>取消</button>
          <button className="btn btn--primary" onClick={() => void submit()} disabled={!canSubmit}>
            {saving ? '登记中…' : '确认成交'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── 丢单原因表单（保持原因必填；预设原因 + 补充说明）─────────────────────────

function LostReasonForm({ opp, onClose, onDone }: {
  opp: OppRow
  onClose: () => void
  onDone: (msg: string) => void
}) {
  const [reason, setReason] = useState('')
  const [detail, setDetail] = useState('')
  const [saving, setSaving] = useState(false)

  const submit = async () => {
    if (!reason) return
    const text = detail.trim() ? `${reason}：${detail.trim()}` : reason
    setSaving(true)
    try {
      const ok = await window.electronAPI.crm.opportunityClose(opp.id, 'lost', text)
      onDone(ok ? '已登记丢单' : '操作失败')
    } catch (e) {
      onDone(`丢单登记失败：${String(e)}`)
    }
  }

  return (
    <div className="opp-modal" onClick={onClose}>
      <div className="opp-modal__body opp-form" onClick={e => e.stopPropagation()}>
        <h3>
          丢单登记 · {opp.account_name || '未命名客户'}
          <button className="iconbtn" aria-label="关闭" onClick={onClose}><X size={15} /></button>
        </h3>
        <div className="opp-form__grid">
          <label className="opp-form__label">丢单原因 *</label>
          <select value={reason} onChange={e => setReason(e.target.value)}>
            <option value="">选择原因…</option>
            {LOST_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          <label className="opp-form__label">补充说明</label>
          <input type="text" value={detail} onChange={e => setDetail(e.target.value)}
            placeholder="选填；原因留档在商机事件，反哺复盘" />
        </div>
        <div className="opp-form__actions">
          <span className="opp-form__hint">丢单原因必填（沉底留档）</span>
          <button className="btn btn--plain" onClick={onClose} disabled={saving}>取消</button>
          <button className="btn btn--plain btn--lose" onClick={() => void submit()} disabled={saving || !reason}>
            确认丢单
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── 报价历史（只读；宪法 §1.6 append-only 版本链）────────────────────────────

function QuoteHistory({ quotations, boundVersionId }: { quotations: QuotationRecord[]; boundVersionId: number }) {
  if (!quotations.length) return null
  return (
    <div className="box opp-quotes">
      <div className="box__t">
        报价历史
        <span className="box__h opp-quotes__hint"><Lock size={10} /> 历史版本只读（append-only 版本链）</span>
      </div>
      <table className="opp-quotes__table">
        <thead>
          <tr><th>版本</th><th>生效期</th><th>总额</th><th>文件</th><th>哈希状态</th></tr>
        </thead>
        <tbody>
          {quotations.map((q) => (
            <tr key={q.id} className={Number(boundVersionId) === q.id ? 'is-bound' : ''}>
              <td>v{q.version || 1}#{q.id}{Number(boundVersionId) === q.id ? '（本单绑定）' : ''}</td>
              <td>
                {(Number(q.effective_from) > 0 || Number(q.effective_to) > 0)
                  ? fmtRange(Number(q.effective_from), Number(q.effective_to))
                  : Number(q.valid_until) > 0 ? `至 ${fmtDate(q.valid_until)}` : '未登记'}
              </td>
              <td className="num">¥{Number(q.total || 0).toLocaleString()}</td>
              <td>{q.attachment_path ? <GeneratedFileResult artifact={{ label: `报价 v${q.version || 1}`, path: q.attachment_path }} /> : '未生成'}</td>
              <td>{q.pdf_hash ? <span title={q.pdf_hash}>已存证</span> : '未存证'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─── 「建待办」表单（候选行没有待办时出现；复用既有 sales.todoCreate，不另开待办写入口）──

function TodoForm({ assessment, onClose, onDone }: {
  assessment: OppAssessment
  onClose: () => void
  onDone: (msg: string) => void
}) {
  const [title, setTitle] = useState(`跟进 ${assessment.displayName}`)
  const [dueDate, setDueDate] = useState(toDateInput(Date.now() + 86400000))
  const [saving, setSaving] = useState(false)

  const submit = async () => {
    const t = title.trim()
    if (!t) return
    setSaving(true)
    try {
      const r = await window.electronAPI.sales.todoCreate({
        trigger_type: 'manual',
        title: t,
        session_id: assessment.sessionId || undefined,
        due_at: fromDateInput(dueDate) || undefined
      })
      onDone(r?.success ? '已创建待办' : `创建待办失败：${r?.error || '未知原因'}`)
    } catch (e) {
      onDone(`创建待办失败：${String(e)}`)
    }
  }

  return (
    <div className="opp-modal" onClick={onClose}>
      <div className="opp-modal__body opp-form" onClick={e => e.stopPropagation()}>
        <h3>
          建待办 · {assessment.displayName}
          <button className="iconbtn" aria-label="关闭" onClick={onClose}><X size={15} /></button>
        </h3>
        <div className="opp-form__grid">
          <label className="opp-form__label">待办标题 *</label>
          <input type="text" value={title} onChange={e => setTitle(e.target.value)} placeholder="要交付给客户的下一步动作" />
          <label className="opp-form__label">截止日期</label>
          <input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)}
            title="你自己承诺的截止时间（不是客户承诺）" />
        </div>
        <div className="opp-form__actions">
          <span className="opp-form__hint">截止日期 = 你自己承诺的时间；到期后该商机会进入优先处理名单</span>
          <button className="btn btn--plain" onClick={onClose} disabled={saving}>取消</button>
          <button className="btn btn--primary" onClick={() => void submit()} disabled={saving || !title.trim()}>
            {saving ? '创建中…' : '创建待办'}
          </button>
        </div>
      </div>
    </div>
  )
}

/** 看板卡（概念稿 .deal）：标题去备注日期前缀（纯展示）；赢率条用真实意向评分，无分则隐藏（禁止造假%） */
function DealCard({ o, score, dragging, onOpen, onDragStart, onDragEnd }: {
  o: OppRow
  score: OppScore | null
  dragging: boolean
  onOpen: (o: OppRow) => void
  onDragStart: () => void
  onDragEnd: () => void
}) {
  const isWon = o.status === 'won'
  const model = o.main_model || o.product || o.name
  const qty = Number(o.order_qty) > 0 ? `×${o.order_qty}` : Number(o.quantity) > 0 ? `×${o.quantity}` : ''
  const reason = score?.factors[0]?.reason || ''
  const scoreN = score ? Math.max(0, Math.min(100, Number(score.score) || 0)) : 0
  return (
    <div
      className={`deal${dragging ? ' is-dragging' : ''}${isWon ? ' deal--won' : ''}`}
      draggable={!isWon}
      onClick={() => onOpen(o)}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/plain', String(o.id))
        onDragStart()
      }}
      onDragEnd={onDragEnd}
      title={`${o.account_name || '未命名客户'} · ${isWon ? '已赢单' : o.stage} · 点击查看详情`}
    >
      <div className="deal__n">
        <span className="deal__nt">{nameOnlyOf(o.account_name || o.name)}</span>
        {!isWon && o.stage === '成交' && <span className="deal__reg">待成交登记</span>}
      </div>
      <div className="deal__d">{[model, qty].filter(Boolean).join(' · ')}</div>
      <div className="deal__d num">最近信号 {fmtTime(Number(o.last_signal_at))}</div>
      {reason && <div className="deal__d deal__d--reason" title={reason}>{reason}</div>}
      <div className={`deal__amt${Number(o.amount) > 0 ? '' : ' deal__amt--pending'}`}>
        {Number(o.amount) > 0 ? `¥${Number(o.amount).toLocaleString()}` : '金额待确认'}
      </div>
      {isWon ? (
        <div className="win">
          <span className="win__n win__n--won">已赢单{Number(o.updated_at) > 0 ? ` · ${fmtDate(Number(o.updated_at))}` : ''}</span>
        </div>
      ) : score ? (
        <div className="win">
          <span className="win__bar"><i style={{ width: `${scoreN}%` }} /></span>
          <span className="win__n">意向 {score.score}</span>
        </div>
      ) : null}
    </div>
  )
}

/** 最近的纵向可滚动祖先：滚动容器是 App shell 的 .content，不由本页拥有 */
function scrollParentOf(el: HTMLElement | null): HTMLElement | null {
  let node: HTMLElement | null = el?.parentElement ?? null
  while (node) {
    const oy = getComputedStyle(node).overflowY
    if (oy === 'auto' || oy === 'scroll') return node
    node = node.parentElement
  }
  return null
}

type OppView = 'board' | 'list' | 'analysis'
/** 看板列（概念稿 .board/.bcol）：列 key = 商机 stage 真源（了解/比价/决策/成交），不新造枚举 */
interface BoardCol { key: string; color: string; cards: OppRow[]; emptyText: string }

export default function OpportunityPage() {
  const [opps, setOpps] = useState<OppRow[]>([])
  // won 行只喂看板「成交」列（近 30 天）；流失不进主看板
  const [wonRows, setWonRows] = useState<OppRow[]>([])
  // 拖拽推进（P1）：拖起的卡与悬停列；写路径与「推进到 xx」同为 opportunityStage
  const [dragOpp, setDragOpp] = useState<OppRow | null>(null)
  const [dragOverStage, setDragOverStage] = useState('')
  // 页面过滤档（2026-09-05 拍板）：销售视角只看 owner_sales=本人 或 未归属；展示层便利，非安全边界（宪法 §1.12）
  const [identity, setIdentity] = useState<IdentityLike>({ name: '', role: '' })
  const [stats, setStats] = useState<OppStats | null>(null)
  const [stageFilter, setStageFilter] = useState('')
  // 「金额待确认」筛选（设计稿屏 1：摘要行琥珀可点，点出 amount<=0 的行，再点取消）
  const [pendingOnly, setPendingOnly] = useState(false)
  const [selected, setSelected] = useState<OppRow | null>(null)
  const [events, setEvents] = useState<OppEvent[]>([])
  const [risks, setRisks] = useState<RiskRow[]>([])
  const [scores, setScores] = useState<Record<number, OppScore>>({})
  const [quotations, setQuotations] = useState<QuotationRecord[]>([])
  const [dealFormOpp, setDealFormOpp] = useState<OppRow | null>(null)
  const [lostFormOpp, setLostFormOpp] = useState<OppRow | null>(null)
  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(false)
  // 阶段分析（只读载荷）：只在切到该视图时才拉，避免每次进列表页都多一次 IPC
  const [analysis, setAnalysis] = useState<OpportunityAnalysisResult | null>(null)
  const [analysisLoading, setAnalysisLoading] = useState(false)
  const [todoFormOpp, setTodoFormOpp] = useState<OppAssessment | null>(null)
  const [toast, setToast] = useState('')
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 视图由 URL 承载（看板 = 默认主视图；`/sales-funnel` 旧链接仍重定向到 `?view=analysis`），
  // 刷新/回退保持同一视图；未知取值回落看板
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const rawView = searchParams.get('view')
  const view: OppView = rawView === 'analysis' ? 'analysis' : rawView === 'list' ? 'list' : 'board'
  const pageRef = useRef<HTMLDivElement>(null)
  // 两视图各自的筛选是各自的 state；滚动位置在这里按视图记忆，切换时互不覆盖
  const scrollMem = useRef<Record<OppView, number>>({ board: 0, list: 0, analysis: 0 })
  const viewMounted = useRef(false)

  const showToast = (msg: string) => {
    setToast(msg)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(''), 5000)
  }
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current) }, [])

  const switchView = (next: OppView) => {
    if (next === view) return
    const scroller = scrollParentOf(pageRef.current)
    if (scroller) scrollMem.current[view] = scroller.scrollTop
    const params = new URLSearchParams(searchParams)
    params.set('view', next)
    setSearchParams(params, { replace: true })
  }
  // 切回某视图时恢复它上次的滚动位置；首次挂载不动滚动（避免影响从其他页进入时的落点）
  useEffect(() => {
    if (!viewMounted.current) { viewMounted.current = true; return }
    const scroller = scrollParentOf(pageRef.current)
    if (scroller) scroller.scrollTop = scrollMem.current[view] || 0
  }, [view])

  const fetchAnalysis = async () => {
    setAnalysisLoading(true)
    try {
      setAnalysis(await window.electronAPI.crm.opportunityAnalysis())
    } catch (e) {
      showToast(`阶段分析加载失败：${String(e)}`)
    }
    setAnalysisLoading(false)
  }
  useEffect(() => {
    if (view === 'analysis' && !analysis) void fetchAnalysis()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view])

  const fetch = async () => {
    setLoading(true)
    try {
      const [list, st, idt] = await Promise.all([
        window.electronAPI.crm.opportunityList({ status: 'active' }),
        window.electronAPI.crm.opportunityStats(),
        window.electronAPI.identity.get().catch(() => ({ name: '', role: '', nameAliases: [] }))
      ])
      // 看板「成交」列数据源；老版本缺该通道时降级为空列，不影响主流程
      const wonList: OppRow[] = await window.electronAPI.crm.opportunityList({ status: 'won' }).catch(() => [])
      const idLike = identityLikeFromIpc(idt)
      setIdentity(idLike)
      setOpps(filterByOwner(list || [], idLike))
      setWonRows(filterByOwner(wonList, idLike))
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
  // 切微信号 = 换库（§2.40）：账号切换后重查（两个视图都要重查，否则阶段分析停在旧号数据）
  useWxidRefresh(() => { void fetch(); void fetchAnalysis() })

  // 阶段筛选（P2.1b 降权）：渐变实心漏斗条改共享 .rail（发丝底 / 选中 2px / mono 计数），
  // 段色只留圆点；递进率收进行尾 sum。点击阶段筛选列表的行为与口径（stats.stageDist）不变。
  const funnelStages = useMemo(() => {
    if (!stats || !stats.stageDist.length) return []
    const data = STAGE_ORDER
      .map((stage) => {
        const row = stats.stageDist.find((d: any) => d.stage === stage)
        const color = STAGE_COLORS[stage] || FUNNEL_NEUTRAL
        return { stage, count: Number(row?.count ?? 0), amount: Number(row?.amount ?? 0), color }
      })
    if (!data.some((d) => d.count > 0)) return []
    return data.map((d, i) => ({
      ...d,
      rate: i > 0 && data[i - 1].count > 0 && d.count > 0 ? Math.round((d.count / data[i - 1].count) * 100) : null
    }))
  }, [stats])

  // 看板列（概念稿 .board）：活跃列 = status=active 且 stage 匹配；「成交」列 = active 且已推进到
  // 成交档（待登记）+ 近 30 天 won。流失（lost）不进看板。列顶色条沿用 FUNNEL_STAGE_COLORS 单一真源。
  const boardCols = useMemo<BoardCol[]>(() => {
    const activeOf = (stage: string) => opps.filter((o) => o.status === 'active' && o.stage === stage)
    const wonRecent = wonRows.filter((o) => Number(o.updated_at || 0) >= Date.now() - 30 * 86400000)
    const wonCol = [...activeOf('成交'), ...wonRecent]
    return [
      { key: '了解', color: FUNNEL_STAGE_COLORS[0], cards: activeOf('了解'), emptyText: '暂无商机' },
      { key: '比价', color: FUNNEL_STAGE_COLORS[1], cards: activeOf('比价'), emptyText: '暂无商机' },
      { key: '决策', color: FUNNEL_STAGE_COLORS[2], cards: activeOf('决策'), emptyText: '暂无商机' },
      { key: '成交', color: 'var(--color-success)', cards: wonCol, emptyText: '近 30 天暂无赢单' }
    ]
  }, [opps, wonRows])

  // 拖拽落列（P1）：与「推进到 xx」同一写路径 opportunityStage（后端留痕 stage_change 事件），
  // 成交列同样只写 stage（=推进到成交），正式 won 一律走成交登记表单（宪法 §1.5 单点）；
  // 失败/无变化只提示不改数据
  const handleDrop = async (targetStage: string) => {
    const o = dragOpp
    setDragOpp(null)
    setDragOverStage('')
    if (!o || o.status !== 'active' || o.stage === targetStage) return
    try {
      const ok = await window.electronAPI.crm.opportunityStage(o.id, targetStage)
      if (ok) showToast(`已推进到「${targetStage}」`)
      else showToast(`「${o.stage} → ${targetStage}」未生效（阶段无变化或商机已关闭）`)
      await fetch()
    } catch (e) {
      showToast(`推进失败：${String(e)}`)
    }
  }

  const filtered = opps
    .filter((o) => !stageFilter || o.stage === stageFilter)
    .filter((o) => !pendingOnly || Number(o.amount) <= 0)
  const pendingAmount = opps.filter((o) => Number(o.amount) <= 0).length
  const decisionCount = opps.filter((o) => o.status === 'active' && o.stage === '决策').length
  // 统计条（概念稿 .stats 四格）口径：金额/决策段取 opportunityStats（与 hero 同源），
  // 高分意向按本机引擎的意向评分投影，不新增 IPC
  const decisionAmount = Number(stats?.stageDist.find((d: any) => d.stage === '决策')?.amount ?? 0)
  const highIntentCount = opps.filter((o) => (scores[o.id]?.score ?? 0) >= 80).length

  // 详情：拉事件时间线 + 客户风险 + 报价历史（只读）；先清上一商机的残留，避免慢 IPC 时闪现旧数据
  const openDetail = async (o: OppRow) => {
    setSelected(o)
    setEvents([]); setRisks([]); setQuotations([])
    try { setEvents((await window.electronAPI.crm.opportunityEvents(o.id)) || []) } catch { setEvents([]) }
    try { setRisks((await window.electronAPI.crm.riskList({ accountId: Number(o.account_id) })) || []) } catch { setRisks([]) }
    void fetchQuotationsByAccount(Number(o.account_id)).then(setQuotations)
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
  // 关单入口：成交 → 正式成交表单（D3 字段登记 + 关单留痕）；丢单 → 原因表单（必填）
  const afterClose = async (msg: string) => {
    setDealFormOpp(null)
    setLostFormOpp(null)
    setSelected(null)
    setNotice(msg)
    await fetch()
  }

  // 「去跟进」默认落点 = 应用内会话上下文（与 AIActionCard.handleOpenChat 同一路径）。
  // 该客户无有效聊天会话时降级打开商机详情，并用 toast 说明降级原因——不静默、不装死（设计稿状态 5）。
  const goFollow = (a: OppAssessment) => {
    if (a.sessionId && isSessionIdLike(a.sessionId)) {
      navigate(`/chat?sessionId=${encodeURIComponent(a.sessionId)}`)
      return
    }
    const row = opps.find((o) => o.id === a.opportunityId)
    if (row) {
      void openDetail(row)
      showToast('未找到与 TA 的聊天会话，已打开商机详情')
    } else {
      showToast('未找到与 TA 的聊天会话，且该商机不在当前列表中')
    }
  }

  // 「查看待办」跳今日行动（待办清单的唯一所在页），本页不复刻第二份清单
  const handleTodo = (a: OppAssessment, action: 'create' | 'view') => {
    if (action === 'view') { navigate('/home'); return }
    setTodoFormOpp(a)
  }

  // 「生成跟进建议」= 按需 AI：只有点击才发生调用，走既有受控链路 sales.actionSuggest
  // （usageContext.purpose='action'，见《AI调用入口与消费清单》）。本页不直连模型、不新增 purpose。
  const suggestFollowUp = async (a: OppAssessment): Promise<{ script: string; nextMove: string }> => {
    const top = a.reasons[0]
    const r = await window.electronAPI.sales.actionSuggest({
      id: a.opportunityId,
      sessionId: a.sessionId,
      displayName: a.displayName,
      // 阶段传商机真实阶段（了解/比价/决策），不套用客户档期的另一套词汇
      stage: a.stage,
      triggerType: top?.kind || 'opportunity_signal',
      title: top?.text || `${a.stage}段跟进`,
      reason: a.reasons.map((x) => x.text).join('；') || `${a.stage}段商机`,
      silentDays: a.silentDays,
      priorityScore: 0,
      priority: 'info',
      status: 'active',
      suggestion: '',
      createdAt: Date.now()
    })
    if (r?.notConfigured) throw new Error(r.error || 'AI 模型未配置')
    if (r?.error) throw new Error(String(r.error))
    return { script: String(r?.script || ''), nextMove: String(r?.nextMove || '') }
  }

  const refreshAll = async () => {
    await fetch()
    if (view === 'analysis') await fetchAnalysis()
  }

  const ownerFiltered = isSalesView(identity)
  return (
    <div className="opp-page" ref={pageRef}>
      {ownerFiltered && <div className="owner-filter-hint">仅显示我名下及未归属的数据</div>}
      {/* 页眉（概念稿 .shead）：小标 → 主张句 → 已有口径的一行摘要；右侧视图分段 + 刷新 */}
      <div className="shead">
        <div>
          <p className="eyebrow">CRM · 商机</p>
          <h1 className="hero">{stats ? `在谈 ${stats.total} 个商机` : '在谈商机'}</h1>
          <p className="sub">
            {stats ? (
              <>
                决策中 <span className="num">{decisionCount}</span> ·{' '}
                <button
                  type="button"
                  className={`opp-summary__pending${pendingOnly ? ' on' : ''}`}
                  aria-pressed={pendingOnly}
                  onClick={() => setPendingOnly((v) => !v)}
                >
                  金额待确认 <span className="num">{pendingAmount}</span>{pendingOnly ? '（再点取消）' : '（点我筛出来）'}
                </button>
              </>
            ) : '客户在微信里表达采购意向（如「要几台」「多少钱」）后自动创建'}
          </p>
        </div>
        <div className="shead__actions">
          {/* 视图分段（设计稿状态 1）：看板 = 默认主视图；列表 = 逐条看；阶段分析 = 每周复盘看卡点。
              P2.1b 接共享 .chipbar（quiet 分段，不做三颗实心钮） */}
          <div className="chipbar" role="tablist" aria-label="商机视图">
            <button
              role="tab"
              aria-selected={view === 'board'}
              className={`chip${view === 'board' ? ' is-on' : ''}`}
              onClick={() => switchView('board')}
            ><KanbanSquare size={13} /> 看板</button>
            <button
              role="tab"
              aria-selected={view === 'list'}
              className={`chip${view === 'list' ? ' is-on' : ''}`}
              onClick={() => switchView('list')}
            ><List size={13} /> 列表</button>
            <button
              role="tab"
              aria-selected={view === 'analysis'}
              className={`chip${view === 'analysis' ? ' is-on' : ''}`}
              onClick={() => switchView('analysis')}
            ><BarChart3 size={13} /> 阶段分析</button>
          </div>
          {notice && <span className="opp-notice">{notice}</span>}
          <button className="btn btn--quiet" onClick={() => void refreshAll()} disabled={loading}>
            <RefreshCw size={14} /> 刷新
          </button>
        </div>
      </div>

      {/* 统计条（概念稿 deals 屏 .stats 四格）：mono 数字 / 发丝分隔，口径全部来自既有数据投影 */}
      {(view === 'board' || view === 'list') && stats && stats.total > 0 && (
        <div className="stats opp-stats">
          <div className="stat">
            <div className="stat__n">{stats.totalAmount > 0 ? `¥${stats.totalAmount.toLocaleString()}` : '—'}</div>
            <div className="stat__l">在谈金额</div>
            <div className="stat__d">{stats.total} 个商机</div>
          </div>
          <div className="stat">
            <div className="stat__n">{decisionCount}</div>
            <div className="stat__l">决策中</div>
            <div className="stat__d">{decisionAmount > 0 ? `¥${decisionAmount.toLocaleString()}` : '金额待确认'}</div>
          </div>
          <div className="stat">
            <div className="stat__n">{pendingAmount}</div>
            <div className="stat__l">金额待确认</div>
            <div className="stat__d">点上方摘要行筛出</div>
          </div>
          <div className="stat">
            <div className="stat__n">{Object.keys(scores).length > 0 ? highIntentCount : '—'}</div>
            <div className="stat__l">高分意向</div>
            <div className="stat__d">意向评分 ≥ 80</div>
          </div>
        </div>
      )}

      {/* 看板主视图（概念稿 .board）：阶段列 + 发丝卡；列 key = stage 真源，点击卡开详情，拖卡跨列推进。
          首屏 loading 且 stats 未到时不渲染（避免闪「暂无商机」空态）；0 active 但有近期赢单仍显示看板 */}
      {view === 'board' && pendingOnly && (
        <div className="opp-filter">
          <span>看板已筛：<b>金额待确认</b></span>
          <button className="btn btn--sm btn--quiet" onClick={() => setPendingOnly(false)}>清除</button>
        </div>
      )}
      {view === 'board' && stats && (stats.total > 0 || boardCols.some((c) => c.cards.length > 0)) && (
        <div className="opp-board">
          {boardCols.map((col) => {
            const cards = pendingOnly ? col.cards.filter((o) => Number(o.amount) <= 0) : col.cards
            const sum = cards.reduce((s, o) => s + Number(o.amount || 0), 0)
            return (
              <div
                key={col.key}
                className={`bcol${dragOverStage === col.key ? ' is-over' : ''}`}
                style={{ borderTopColor: col.color }}
                onDragOver={(e) => {
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'move'
                  if (dragOverStage !== col.key) setDragOverStage(col.key)
                }}
                onDragLeave={() => { if (dragOverStage === col.key) setDragOverStage('') }}
                onDrop={(e) => { e.preventDefault(); void handleDrop(col.key) }}
              >
                <div className="bcol__h">
                  <span className="bcol__t">{col.key}</span>
                  <span className="bcol__n">{cards.length}</span>
                </div>
                <div className="bcol__sum">{sum > 0 ? `¥${sum.toLocaleString()}` : '—'}</div>
                {cards.map((o) => (
                  <DealCard
                    key={`${o.status}-${o.id}`}
                    o={o}
                    score={scores[o.id] || null}
                    dragging={dragOpp?.id === o.id}
                    onOpen={(x) => void openDetail(x)}
                    onDragStart={() => setDragOpp(o)}
                    onDragEnd={() => { setDragOpp(null); setDragOverStage('') }}
                  />
                ))}
                {!cards.length && <div className="bcol__empty">{col.emptyText}</div>}
              </div>
            )
          })}
        </div>
      )}
      {view === 'board' && !loading && stats && stats.total === 0 && !boardCols.some((c) => c.cards.length > 0) && (
        <div className="opp-empty">暂无商机。客户在微信里表达采购意向（如"要几台""多少钱"）后会自动创建。</div>
      )}

      {view === 'analysis' && (
        <OpportunityStageAnalysis
          data={analysis}
          loading={analysisLoading}
          onGoFollow={goFollow}
          onTodo={handleTodo}
          onSuggest={suggestFollowUp}
        />
      )}

      {view === 'list' && (funnelStages.length > 0 ? (
        <div className="opp-rail-block">
          <div className="seclabel">
            <span className="seclabel__t">商机阶段</span>
            <span className="opp-hint">点击阶段筛选下方列表</span>
          </div>
          <div className="rail" role="group" aria-label="按阶段筛选">
            {funnelStages.map((d) => (
              <button
                key={d.stage}
                type="button"
                className={`rail__item${stageFilter === d.stage ? ' is-on' : ''}`}
                onClick={() => setStageFilter(stageFilter === d.stage ? '' : d.stage)}
                title={`${d.stage}：${d.count} 个 · ${d.amount > 0 ? `金额 ¥${d.amount.toLocaleString()}` : '金额待确认'} · 点击筛选列表`}
              >
                <i className="opp-rail__dot" style={{ background: d.color }} aria-hidden />
                {d.stage}
                <span className="rail__n">{d.count}</span>
              </button>
            ))}
            {funnelStages.some((d) => d.rate !== null) && (
              <span className="rail__sum">
                递进 {funnelStages.filter((d) => d.rate !== null).map((d) => `${d.stage} ${d.rate}%`).join(' · ')}
              </span>
            )}
          </div>
        </div>
      ) : (
        <div className="opp-empty">暂无商机。客户在微信里表达采购意向（如"要几台""多少钱"）后会自动创建。</div>
      ))}

      {view === 'list' && (stageFilter || pendingOnly) && (
        <div className="opp-filter">
          <span>当前筛选：{[stageFilter, pendingOnly ? '金额待确认' : ''].filter(Boolean).join(' · ')}</span>
          <button className="btn btn--sm btn--quiet" onClick={() => { setStageFilter(''); setPendingOnly(false) }}>清除</button>
        </div>
      )}

      {view === 'list' && (
      <div className="opp-list-block">
        {/* 细线行表（概念稿 .tbl/.thead/.trow）：行内网格列模板按页定义，整行点击开详情 */}
        <div className="seclabel">
          <span className="seclabel__t">商机列表{stageFilter ? ` · ${stageFilter}` : ''}{pendingOnly ? ' · 金额待确认' : ''}</span>
          <span className="opp-list-count num">{filtered.length} 条</span>
        </div>
        <div className="tbl">
          <div className="thead opp-head">
            <span>客户 · 产品 / 最近信号</span><span>阶段</span><span className="tc-r">金额</span>
          </div>
          {filtered.map((o) => (
            <div key={o.id} className="trow opp-grid" onClick={() => void openDetail(o)}>
              <span className="opp-row__avatar" aria-hidden>{(String(o.account_name || '').trim()[0]) || '客'}</span>
              <span className="opp-row__main">
                <span className="opp-row__name">{o.account_name || '未命名客户'}</span>
                <span className="opp-row__sub num">
                  {[
                    o.main_model || o.product || o.name,
                    Number(o.order_qty) > 0 ? `×${o.order_qty}` : Number(o.quantity) > 0 ? `×${o.quantity}` : '',
                    scores[o.id] ? `意向 ${scores[o.id].score}` : '',
                    `最近信号 ${fmtTime(Number(o.last_signal_at))}`
                  ].filter(Boolean).join(' · ')}
                </span>
              </span>
              <span className="opp-row__stage">
                <span className="opp-qtag" style={STAGE_COLORS[o.stage] ? { color: STAGE_COLORS[o.stage] } : undefined}>{o.stage}</span>
              </span>
              <span className={`opp-row__amt${Number(o.amount) > 0 ? '' : ' opp-row__amt--pending'}`}>
                {Number(o.amount) > 0 ? fmtAmount(Number(o.amount)) : '金额待确认'}
              </span>
            </div>
          ))}
          {!filtered.length && <div className="opp-empty">该阶段暂无商机</div>}
        </div>
      </div>
      )}

      {selected && (
        <div className="opp-modal">
          <div className="opp-modal__body">
            <h3>
              {selected.main_model || selected.product || selected.name}
              <button className="iconbtn" aria-label="关闭" onClick={() => setSelected(null)}><X size={15} /></button>
            </h3>
            {/* 「AI 建议下一步」（设计稿屏 1）：内容从现有数据投影，零 LLM 零新接口；P2.1b 去 tint 底改左 2px accent 条 */}
            <div className="opp-next-step">
              <span className="opp-next-step__tag">AI 建议下一步</span>
              <p>{buildNextStep({ stage: selected.stage, nextStage: NEXT_STAGE[selected.stage], risks, score: scores[selected.id] || null })}</p>
            </div>
            {/* 主操作行：推进 = 轻 primary（本屏唯一），成交 = 描边，丢单 = quiet */}
            <div className="opp-actions">
              {NEXT_STAGE[selected.stage] && (
                <button className="btn btn--sm btn--primary-soft" onClick={() => void advance()}>
                  推进到 {NEXT_STAGE[selected.stage]}
                </button>
              )}
              <button className="btn btn--sm btn--plain" onClick={() => setDealFormOpp(selected)}><CheckCircle2 size={13} /> 成交</button>
              <button className="btn btn--sm btn--quiet" onClick={() => setLostFormOpp(selected)}><XCircle size={13} /> 丢单</button>
            </div>
            {/* 基本信息键值行（共享 .kv，两列排布） */}
            <div className="opp-detail">
              <div className="kv"><span className="kv__k">客户</span><span className="kv__v">{selected.account_name || '—'}</span></div>
              <div className="kv"><span className="kv__k">产品</span><span className="kv__v">{selected.product || '—'}</span></div>
              <div className="kv"><span className="kv__k">数量</span><span className="kv__v num">{selected.quantity > 0 ? `${selected.quantity} 台` : '—'}</span></div>
              <div className="kv"><span className="kv__k">阶段</span><span className="kv__v">{selected.stage}</span></div>
              <div className="kv"><span className="kv__k">最近信号</span><span className="kv__v num">{fmtTime(Number(selected.last_signal_at))}</span></div>
              <div className="kv"><span className="kv__k">意向评分</span><span className="kv__v num">{scores[selected.id] ? `${scores[selected.id].score} / 100 · ${scores[selected.id].level}` : '—'}</span></div>
            </div>
            {/* 成交/交付登记信息（宪法 §1.5 D3 列）：空字段统一「未登记」，旧数据可见、可回填 */}
            <div className="box">
              <div className="box__t">成交与交付登记 <span className="box__h">空字段统一「未登记」，旧数据可回填</span></div>
              <div className="opp-detail opp-detail--flush">
                <div className="kv"><span className="kv__k">金额（CNY 结算）</span><span className="kv__v num">{Number(selected.amount_cny) > 0 ? `¥${Number(selected.amount_cny).toLocaleString()}` : fmtAmount(Number(selected.amount))}</span></div>
                {Number(selected.original_amount) > 0 && (selected.original_currency || 'CNY') !== 'CNY' && (
                  <>
                    <div className="kv"><span className="kv__k">原币金额（{selected.original_currency}）</span><span className="kv__v num">{Number(selected.original_amount).toLocaleString()}</span></div>
                    <div className="kv"><span className="kv__k">汇率说明</span><span className="kv__v">{selected.rate_note || '未登记'}</span></div>
                  </>
                )}
                <div className="kv"><span className="kv__k">产品型号</span><span className="kv__v">{selected.main_model || '未登记'}</span></div>
                <div className="kv"><span className="kv__k">补充型号</span><span className="kv__v">{supplementaryModels(selected) || '未登记'}</span></div>
                <div className="kv"><span className="kv__k">订单量</span><span className="kv__v num">{fmtQty(selected.order_qty)}</span></div>
                <div className="kv"><span className="kv__k">预计发运区间</span><span className="kv__v num">{fmtRange(selected.expected_ship_start, selected.expected_ship_end)}</span></div>
                <div className="kv"><span className="kv__k">交付日期</span><span className="kv__v num">{fmtDate(selected.delivery_date)}</span></div>
                <div className="kv"><span className="kv__k">整车/改装</span><span className="kv__v">{selected.type || '未登记'}</span></div>
                <div className="kv"><span className="kv__k">报价版本</span><span className="kv__v num">{Number(selected.quote_version_id) > 0 ? `#${selected.quote_version_id}` : '未登记'}</span></div>
              </div>
            </div>
            <QuoteHistory quotations={quotations} boundVersionId={Number(selected.quote_version_id) || 0} />
            {scores[selected.id] && (
              <div className="box opp-factors">
                <div className="box__t">意向评分依据</div>
                {/* 意向度分数条从列表挪进详情弹窗（设计稿屏 1） */}
                <div className="opp-factors__score">
                  <span className="opp-score" title={scores[selected.id].factors.map((f) => `${f.label} ${f.delta >= 0 ? '+' : ''}${f.delta}：${f.reason}`).join('\n')}>
                    <span className="opp-score__t"><span>意向度</span><span className="opp-score__num">{scores[selected.id].score}</span></span>
                    <span className="opp-score__bar"><span className="opp-score__fill" style={{ width: `${scores[selected.id].score}%` }} /></span>
                  </span>
                </div>
                {scores[selected.id].factors.map((f) => (
                  <div key={f.label} className="opp-factor">
                    <span className="opp-factor__label">{f.label}</span>
                    <span className={`opp-factor__delta ${f.delta >= 0 ? 'pos' : 'neg'}`}>{f.delta >= 0 ? `+${f.delta}` : f.delta}</span>
                    <span className="opp-factor__reason">{f.reason}</span>
                  </div>
                ))}
              </div>
            )}
            <div className="box opp-risks">
              <div className="box__t">风险预警</div>
              {risks.map((r) => (
                <div key={r.id} className={`opp-risk opp-risk--${r.severity} ${r.status === 'resolved' ? 'is-resolved' : ''}`}>
                  <div className="opp-risk__head">
                    <span className="opp-risk__type">{RISK_TYPE_LABEL[r.risk_type] || r.risk_type}</span>
                    <span className="opp-risk__severity">{RISK_SEVERITY_LABEL[r.severity] || r.severity}</span>
                    <span className="opp-risk__time num">{fmtTime(Number(r.created_at))}</span>
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
            <div className="box opp-events">
              <div className="box__t">商机事件</div>
              {events.map((e) => (
                <div key={e.id} className="opp-event">
                  <span className="opp-event__tag">{EVENT_LABEL[e.event_type] || e.event_type}</span>
                  {e.stage && <span className="opp-event__stage num">{e.stage}</span>}
                  <span className="opp-event__detail">{e.detail}</span>
                  <span className="opp-event__time num">{fmtTime(Number(e.created_at))}</span>
                </div>
              ))}
              {!events.length && <div className="opp-empty">暂无事件</div>}
            </div>
          </div>
        </div>
      )}

      {dealFormOpp && (
        <DealForm opp={dealFormOpp} onClose={() => setDealFormOpp(null)} onDone={(msg) => void afterClose(msg)} />
      )}
      {lostFormOpp && (
        <LostReasonForm opp={lostFormOpp} onClose={() => setLostFormOpp(null)} onDone={(msg) => void afterClose(msg)} />
      )}

      {todoFormOpp && (
        <TodoForm
          assessment={todoFormOpp}
          onClose={() => setTodoFormOpp(null)}
          onDone={(msg) => {
            setTodoFormOpp(null)
            showToast(msg)
            // 新待办会改变候选资格与排序，两个视图都重取
            void fetch().then(() => fetchAnalysis())
          }}
        />
      )}

      {/* 降级/结果提示（设计稿状态 5「不静默」）：页面内浮层，自动消失 */}
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  )
}
