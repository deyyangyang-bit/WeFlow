import GeneratedFileResult, { type GeneratedArtifact } from '../components/crm/GeneratedFileResult'
/**
 * CrmReviewPage.tsx —— 跟单中心：到款认领（7 天一页，销售认领+开票状态）/ 物流跟单（7 天一页，待认领+待签收+已签收）/ 发票待开
 * 2026-08-24 改造：去掉 AI 自动确认（销售手动认领），到款按天分组展示，认领后显示开票状态（订单群 PDF 发票解析）。
 * 2026-09-19 §2.80 销售归属收口（§2.78 屏 4 认领三区不动的延续）：identity 接入 + 展示层视图档——
 * 销售默认「只看我的」（仅本人认领，shared/ownerFilter 唯一姓名口径），未认领数据进入显式公共池；可切「全员」临时看全库；
 * 列表 / 四格 / hero / rail 角标全部用同一批过滤后数组（数字同源）；发票为一等队列档；页器收进节标题行。
 */
import { Fragment, useEffect, useState, type ReactNode } from 'react'
import { RefreshCw, Radio, Users, X } from 'lucide-react'
import { useCrmStore } from '../stores/crmStore'
import { getCrmLogisticsOverdueHours } from '../services/config'
import CustomerPicker from '../components/sales/CustomerPicker'
import { filterByOwner, filterPaymentsForView, identityLikeFromIpc, isOwnedName, isSalesView, type IdentityLike } from '../utils/leadAssignmentView'
import './CrmReviewPage.scss'

// 一页七天（到款认领 / 物流三队列共用）：以今天为基准滚动 7 天窗口分页（第 0 页 = 今天往前 6 天，如 8/18~8/24），
// 页内每天一个折叠行（默认折叠，点击展开当天明细）；跨窗口翻页（上一页/下一页）。
const DAY_MS = 24 * 3600 * 1000
const WEEK_MS = 7 * DAY_MS
/** 时间戳 → 所在自然日零点（作天 key，跨时区/夏令时安全） */
const dayStartOf = (ms: number): number => {
  const d = new Date(Number(ms))
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}
/** 第 page 页的 7 个自然日零点（从最早到最晚；page 0 = 今天往前 6 天） */
const weekDaysOf = (page: number): number[] => {
  const today = dayStartOf(Date.now())
  const start = today - (page + 1) * WEEK_MS + DAY_MS
  return [...Array(7)].map((_, i) => start + i * DAY_MS)
}
/** 最老一条所在页（翻页下限）；无数据 = 0。列表内页器与节标题行页器共用同一上限口径 */
const weekMaxPageOf = (items: any[], timeOf: (it: any) => number): number => {
  if (items.length === 0) return 0
  const oldest = Math.min(...items.map((it) => dayStartOf(timeOf(it))))
  return Math.max(0, Math.floor((dayStartOf(Date.now()) - oldest) / WEEK_MS))
}
/** 日标签：8/24（今天）· 8/23（昨天）· 8/16 */
const dayLabelOf = (start: number): string => {
  const diff = Math.round((dayStartOf(Date.now()) - start) / DAY_MS)
  const label = `${new Date(start).getMonth() + 1}/${new Date(start).getDate()}`
  if (diff === 0) return `${label}（今天）`
  if (diff === 1) return `${label}（昨天）`
  return label
}

/**
 * 7 天窗口翻页器：列表底部（完整窗口范围）与节标题行（compact，只留页码）共用一个皮。
 * 布局收编（§2.80）：款项认领的页器放节标题行（不再插在日分组与已确认到款之间），物流三队列留在各自列表底部。
 */
function DayPager(props: { cur: number; maxPage: number; days?: number[]; onPage: (p: number) => void }) {
  const { cur, maxPage, days, onPage } = props
  if (maxPage <= 0) return null
  return (
    <div className={`crm-pager${days ? '' : ' crm-pager--compact'}`}>
      <button className="btn btn--plain btn--sm" disabled={cur >= maxPage} onClick={() => onPage(cur + 1)}>上一页</button>
      <span className="crm-pager-info">{days ? `${dayLabelOf(days[0])} ~ ${dayLabelOf(days[6])} · ` : ''}第 {cur + 1} / {maxPage + 1} 页</span>
      <button className="btn btn--plain btn--sm" disabled={cur <= 0} onClick={() => onPage(cur - 1)}>下一页</button>
    </div>
  )
}

/**
 * 一页七天折叠列表（到款认领 / 物流三队列共用）：每页 7 个自然日，每天一行（默认折叠，点 header 展开当天明细）；
 * 翻页按 7 天窗口前移，上限 = 最老一条所在页；forceOpen 用于筛选模式强制全展开。
 * 分页收编（§2.80）：传受控 page/onPageChange 时行内不再渲染页器（页器上提到节标题行），否则留在列表底部。
 */
function WeekDayGroups(props: {
  items: any[]
  timeOf: (it: any) => number
  render: (it: any) => ReactNode
  headerInfo?: (list: any[]) => ReactNode
  forceOpen?: boolean
  page?: number
  onPageChange?: (p: number) => void
}) {
  const { items, timeOf, render, headerInfo, forceOpen } = props
  const [innerPage, setInnerPage] = useState(0) // 0 = 最近 7 天窗口
  const [expandedDays, setExpandedDays] = useState<Set<string>>(new Set()) // 用户显式展开的天 key
  if (items.length === 0) return null
  const page = props.page ?? innerPage
  const setPage = (p: number) => (props.onPageChange ? props.onPageChange(p) : setInnerPage(p))
  // 按天分组（key = 日零点时间戳）
  const byDay = (() => {
    const m = new Map<string, any[]>()
    for (const it of items) {
      const k = String(dayStartOf(timeOf(it)))
      const list = m.get(k) || []
      list.push(it)
      m.set(k, list)
    }
    return m
  })()
  // 最老一条所在页（翻页下限）；当前页越界自动收敛
  const maxPage = weekMaxPageOf(items, timeOf)
  const cur = Math.min(page, maxPage)
  const days = weekDaysOf(cur)
  // 页内倒序展示（最新/今天在最上）；pager 标签仍用升序窗口范围
  const displayDays = [...days].reverse()
  const toggle = (k: string) => {
    setExpandedDays((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n })
  }
  return (
    <div>
      {displayDays.filter((d) => byDay.has(String(d))).map((d) => {
        const k = String(d)
        const list = byDay.get(k)!
        const open = !!forceOpen || expandedDays.has(k)
        return (
          <div key={k}>
            <h4 className="day-header" onClick={() => toggle(k)} title={open ? '点击收起' : '点击展开'}>
              <span className="day-arrow">{open ? '▾' : '▸'}</span> <span className="day-date">{dayLabelOf(d).replace('（今天）', '').replace('（昨天）', '')}</span>
              {dayLabelOf(d).includes('（今天）') && <span className="day-pill">今天</span>}
              {dayLabelOf(d).includes('（昨天）') && <span className="day-pill day-pill--muted">昨天</span>}
              <span className="day-count">{list.length} 笔</span>
              {headerInfo ? headerInfo(list) : null}
            </h4>
            {open && list.map((it) => <Fragment key={it.id}>{render(it)}</Fragment>)}
          </div>
        )
      })}
      {props.onPageChange === undefined && (
        <DayPager cur={cur} maxPage={maxPage} days={days} onPage={setPage} />
      )}
    </div>
  )
}

export default function CrmReviewPage() {
  const [generatedArtifacts, setGeneratedArtifacts] = useState<Record<string, GeneratedArtifact>>({})
  const [generating, setGenerating] = useState<string | null>(null)
  const generateInvoice = async (type: string, id: number) => {
    if (generating) return
    const key = `${type}:${id}`; setGenerating(key)
    try {
      const result = await window.electronAPI.crm.docGenerate(type, id)
      if (result.ok && result.path) setGeneratedArtifacts(v => ({ ...v, [key]: { label: type === 'invoice-info' ? '开票信息单' : '开票申请单', path: result.path! } }))
      else setNotice(result.reason || '生成失败')
    } catch (e) { setNotice(String(e)) } finally { setGenerating(null) }
  }
  const { queues, fetchQueues, scanNow, loading, notice, setNotice } = useCrmStore()
  const [contracts, setContracts] = useState<any[]>([])
  const [groups, setGroups] = useState<any[]>([])
  // ── 身份档案（§2.80 A1，同 CrmWorkbenchPage）：identity.get → IdentityLike，销售归属收口的唯一核对依据 ──
  const [identity, setIdentity] = useState<IdentityLike>({ name: '', role: '' })
  const [showPick, setShowPick] = useState(false)
  const [pickSearch, setPickSearch] = useState('')
  const [groupSessions, setGroupSessions] = useState<any[]>([])
  const [pickType, setPickType] = useState<Record<string, string>>({})
  const [invoiceContract, setInvoiceContract] = useState<Record<number, string>>({})
  const [invoiceAmount, setInvoiceAmount] = useState<Record<number, string>>({}) // invoiceId → 金额输入
  // ── 每日到款：按天分组清单 + 认领控件 state ─────────────────────────────────
  const [paymentsAll, setPaymentsAll] = useState<any[]>([]) // paymentsByDay 全库平铺（带认领/开票状态）；视图档过滤后为 payments
  const [claimCustomer, setClaimCustomer] = useState<Record<number, string>>({}) // paymentId → 客户名（匹配已有客户或直接建档）
  const [claimContract, setClaimContract] = useState<Record<number, string>>({}) // paymentId → 合同 id
  const [claimSales, setClaimSales] = useState<Record<number, string>>({}) // paymentId → 认领销售（不填=默认本人，认领不一定是自己的）
  const [onlyUnclaimed, setOnlyUnclaimed] = useState(false) // 只看未认领（销售视角默认开启，见下方 identity effect）
  // 2026-08-29 对齐设计稿：款项认领 / 物流跟单 分 Tab（默认款项认领）；§2.80 发票升一等队列档
  const [reviewTab, setReviewTab] = useState<'payments' | 'logistics' | 'invoices'>('payments')
  // 视图档（§2.80 A3）：销售默认「只看我的」（仅本人已认领），未认领另进公共池；可切「全员」临时看全库；管理视角隐藏开关（恒全量）
  const [viewAll, setViewAll] = useState(false)
  // 已确认到款默认折叠（认领优先级：未认领 > 已确认；header 复用每日分组样式，须真实可点）
  const [claimedOpen, setClaimedOpen] = useState(false)
  // 款项认领页器（§2.80 分页收编：放节标题行，受控分页传给 WeekDayGroups）
  const [payPage, setPayPage] = useState(0)
  const [salesTeam, setSalesTeam] = useState<Array<{ name: string; orderCount: number; amount: number }>>([]) // 销售团队名单
  const [addSalesName, setAddSalesName] = useState('') // 添加销售输入
  // 「管理」折叠区（设计稿屏 4：扫描群聊设置 + 销售团队，默认收起，功能原样）
  const [manageOpen, setManageOpen] = useState(false)
  // ── 物流跟单 ─────────────────────────────────────────────────────────────
  const [logiLinkedAll, setLogiLinkedAll] = useState<any[]>([]) // 已认领待签收（全库；视图档过滤后为 logiLinked）
  const [logiSignedAll, setLogiSignedAll] = useState<any[]>([]) // 已签收（全库；视图档过滤后为 logiSigned）
  const [logiContract, setLogiContract] = useState<Record<number, string>>({}) // logisticsId → 合同 id（认领下拉，可选）
  const [logiCustomer, setLogiCustomer] = useState<Record<number, string>>({}) // logisticsId → 客户名（匹配已有客户或直接建档）
  const [logiSales, setLogiSales] = useState<Record<number, string>>({}) // logisticsId → 认领销售（不填=默认本人）
  const [savedSalesName, setSavedSalesName] = useState('') // currentSalesName 持久默认（微信显示名；未建档身份的兜底）
  const [mySalesName, setMySalesName] = useState('') // 认领默认名（§2.80 A1：与身份档案对齐，勿与可见性核对双口径打架）
  const [logiOverdueHours, setLogiOverdueHours] = useState(24) // 超期阈值（设置页配置）
  const [logiNotice, setLogiNotice] = useState('') // 物流区行内反馈（认领/签收结果就近显示，避免顶部 notice 被滚动遮挡）
  const [contractName, setContractName] = useState<Record<number, string>>({}) // contract_id → 名称（跟单视图展示）
  const [accounts, setAccounts] = useState<any[]>([]) // 全部客户（认领下拉 + 待签收/已签收客户名展示 + 发票归属推导）
  const [accountName, setAccountName] = useState<Record<number, string>>({}) // account_id → 客户名
  const displayNameOf = (c: any) => String(c?.profile_display_name || '') || String(c?.name || '')
  // 客户名 → 已有客户 id（精确匹配）；无匹配返回 undefined（认领时按输入名建档）
  const customerIdOf = (name: string) => accounts.find((a) => displayNameOf(a).toLowerCase() === name.trim().toLowerCase())?.id

  const TYPE_LABELS: Record<string, string> = { logistics: '物流发货', payment: '货款认领', order: '订单截图' }

  const fetchGroups = async () => setGroups((await window.electronAPI.crm.groupsList()) || [])
  // 来源展示辅助：群名映射 + 时间格式化（供确认卡片核对"这笔数据哪来的"）
  const groupName = (gid?: string) => groups.find((g) => String(g.group_id) === String(gid || ''))?.group_name || gid || ''
  const fmtTime = (ms?: number) => (ms ? new Date(Number(ms)).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '')
  const openPick = async () => {
    setShowPick(true)
    const r = await window.electronAPI.chat.getSessions()
    setGroupSessions(((r?.sessions ?? []) as any[]).filter((x) => String(x.username || '').endsWith('@chatroom')))
  }
  const addGroup = async (g: any) => {
    const type = pickType[String(g.username)] || 'payment'
    await window.electronAPI.crm.groupsSave({ group_id: g.username, group_name: g.displayName || g.username, group_type: type })
    await fetchGroups()
    setNotice(`已添加「${g.displayName || g.username}」，开始扫描该群聊`)
    void scanNow()
  }
  const toggleGroup = async (g: any, on: boolean) => { await window.electronAPI.crm.groupsUpdate(Number(g.id), { enabled: on ? 1 : 0 }); await fetchGroups() }
  const retypeGroup = async (g: any, t: string) => { await window.electronAPI.crm.groupsUpdate(Number(g.id), { group_type: t }); await fetchGroups() }

  // ── 物流跟单数据：已认领待签收 / 已签收 + 合同名映射 + 超期阈值 ─────────────
  // 超期判定：已发货且超过阈值小时未签收 → 返回超期小时数，否则 0（阈值显式传参，避免闭包捕获旧值）
  const overdueHoursOf = (l: any, hours: number) => {
    const cutoff = Date.now() - hours * 3600 * 1000
    return l.status === 'shipped' && l.latest_update_at > 0 && Number(l.latest_update_at) < cutoff
      ? Math.max(1, Math.floor((Date.now() - Number(l.latest_update_at)) / 3600000))
      : 0
  }
  const logisticsStatusLabel = (status: string) => ({
    shipped: '已发货', delayed: '物流停滞', urgent: '客户催件', partial: '少件/分批',
    returned: '退回处理中', self_pickup: '自提/待补单号', exception: '物流异常',
    cancelled: '已取消', signed: '已签收'
  } as Record<string, string>)[status] || status
  const fetchLogi = async (hours: number) => {
    const [pending, signed] = await Promise.all([
      window.electronAPI.crm.logisticsList({ filter: 'pending' }),
      window.electronAPI.crm.logisticsList({ filter: 'signed' }),
    ])
    setLogiLinkedAll((pending || []).map((l: any) => ({ ...l, _overdueHours: overdueHoursOf(l, hours) })))
    setLogiSignedAll((signed || []).map((l: any) => ({ ...l, _overdueHours: overdueHoursOf(l, hours) })))
  }

  // ── 款项认领清单：平铺按 pay_time 7 天窗口分组（组内时间倒序）────
  const fetchPayments = async () => setPaymentsAll((await window.electronAPI.crm.paymentsByDay(30)) || [])
  // 销售团队名单（header 下拉）：历史认领人名词条 + 当前登录账户，可新增/移除（离职）
  const fetchSalesTeam = async () => {
    const r = await window.electronAPI.crm.salesTeam()
    if (r) setSalesTeam(r.team || [])
  }
  const addSalesMember = async () => {
    const n = addSalesName.trim()
    if (!n) return
    const r = await window.electronAPI.crm.salesTeamAdd(n)
    if (!r?.ok) { setNotice(`添加失败：${r?.reason || '未知错误'}`); return }
    setAddSalesName('')
    await fetchSalesTeam()
  }
  const removeSalesMember = async (name: string) => {
    const r = await window.electronAPI.crm.salesTeamRemove(name)
    if (!r?.ok) { setNotice(`移除失败：${r?.reason || '未知错误'}`); return }
    await fetchSalesTeam()
  }
  // ── 视图档派生（§2.80 A2/A4）：拉全量后前端 filter，一份过滤结果喂 列表 + 四格 + hero + rail（数字同源）──
  // 销售视角（isSalesView）：到款 = 本人已认领（公共未认领另列）；物流 = 未归属公共池 + 本人（owner_sales，
  // 直接复用 filterByOwner——与合同台账同一口径，勿新造第二套）；发票无归属列，经「直接挂客户 → 关联合同的客户」
  // 推导 owner 后走同一规则（推导不了 = 未归属公共池，诚实保留可见，不做猜测）。管理 / 未建档视角全量。
  const salesScope = isSalesView(identity) && !viewAll
  // 归属推导底表：account_id → owner_sales；contract_id → account_id（contracts 为台账 200 条窗口，窗口外推导不了按未归属保留）
  const accountOwnerById: Record<number, string> = {}
  for (const a of accounts) if (a?.id) accountOwnerById[Number(a.id)] = String(a.owner_sales || '')
  const contractAccountById: Record<number, number> = {}
  for (const c of contracts) if (c?.id && c.account_id) contractAccountById[Number(c.id)] = Number(c.account_id)
  const invoiceOwnerSalesOf = (inv: any): string => {
    const accId = Number(inv?.account_id) || contractAccountById[Number(inv?.contract_id)] || 0
    return accountOwnerById[accId] || String(inv?.requested_by || '')
  }
  const payments = salesScope ? filterPaymentsForView(paymentsAll, identity) : paymentsAll
  // 未归属到款/物流是显式公共池，不再混入「我的」过滤结果；页面仍单独给销售认领入口。
  const logiUnlinked = salesScope ? queues.logistics.filter((l: any) => !String(l.owner_sales || '').trim()) : queues.logistics
  const logiLinked = salesScope ? filterByOwner(logiLinkedAll, identity) : logiLinkedAll
  const logiSigned = salesScope ? filterByOwner(logiSignedAll, identity) : logiSignedAll
  const invoices = salesScope ? queues.invoices.filter((inv: any) => isOwnedName(identity, invoiceOwnerSalesOf(inv))) : queues.invoices
  // 视图档切换（销售 only，管理视角整行不渲染）：切档回该档默认——我的 = 只看未认领；全员 = 看全库
  // （验收口径：切「全员」须能看到他人已认领，不能被「只看未认领」叠着挡住）
  const switchScope = (all: boolean) => { setViewAll(all); setOnlyUnclaimed(!all) }

  // 可认领 = 无归属 / 归属待确认 / 旧自动确认遗留（confirmed 但未挂客户合同）
  const isClaimable = (p: any) => !p.alloc_status || p.alloc_status === 'pending' || (p.alloc_status === 'confirmed' && !p.account_id && !p.contract_id)
  // 已确认到款 = 已认领且挂上客户或合同（确认收到款项集中罗列，与每日流水分开）
  const claimedPayments = payments.filter((p) => p.alloc_status === 'confirmed' && (p.account_id || p.contract_id))
  // 只看未认领：行数已很少，强制全展开（折叠不挡筛选结果）
  const claimablePayments = salesScope
    ? paymentsAll.filter((p) => isClaimable(p) && !String(p.sales_name || '').trim())
    : payments.filter(isClaimable)
  // 「今天要办」verdict（设计稿屏 4）：今日到款待认领 = 现有 claimable 口径 + pay_time 落在今天（与按天分组同口径），
  // 零新查询；§2.80 起基于视图档过滤后的 claimablePayments（hero/四格/rail 数字同源）
  const todayClaimable = claimablePayments.filter((p) => dayStartOf(Number(p.pay_time)) === dayStartOf(Date.now())).length
  // 待认领笔数（与 rail 档位角标 / 四格副行共用同一口径）
  const unclaimedCount = claimablePayments.filter((p) => !p.alloc_status || p.alloc_status === 'pending').length
  // 款项认领页器数据（页器在节标题行，受控分页；上限随当前过滤结果收敛）
  const payItems = onlyUnclaimed ? claimablePayments : payments
  const payMaxPage = weekMaxPageOf(payItems, (p) => Number(p.pay_time))
  const payCur = Math.min(payPage, payMaxPage)
  // 开票状态：认领后按订单群 PDF 发票解析结果展示（invoice_status='issued' 即已开票）；
  // 旧自动确认遗留（confirmed 无客户合同）补认领前不显示开票状态
  const invoiceBadgeOf = (p: any) => {
    if (!p.alloc_status || p.alloc_status === 'pending') return null
    if (p.alloc_status === 'confirmed' && !p.account_id && !p.contract_id) return null
    if (p.invoice_status === 'issued') return <em className="logi-card__time invoice-ok">已开票 {p.invoice_no ? `· ${p.invoice_no}` : ''}</em>
    if (p.invoice_requirement === 'not_required') return <em className="review-tag">本单不开发票</em>
    if (p.invoice_requirement === 'info_pending') return <em className="review-tag review-tag--warn">待补开票资料</em>
    if (p.invoice_status || p.invoice_requirement === 'required') return <em className="review-tag">待开票</em>
    return <em className="review-tag review-tag--warn">待确认是否开票</em>
  }
  // 到款显示金额：拆单认领场景 credited_amount 是解析出的客户实际付款额（银行聚合流水拆单），
  // 未认领/无拆单时回退 amount_net——统计卡（SUM credited_amount）与清单口径一致
  const shownAmountOf = (p: any) => Number(p.credited_amount ?? p.amount_net)
  // 销售手动认领：选客户（下拉或新客户名建档） + 合同（可选，按客户过滤） + 销售名
  const doClaimPayment = async (p: any) => {
    const name = claimCustomer[p.id]?.trim() || ''
    const cid = claimContract[p.id] ? Number(claimContract[p.id]) : undefined
    if (!name) { setNotice('请输入客户名'); return }
    let accountId: number | undefined = customerIdOf(name)
    if (!accountId) {
      const created = await window.electronAPI.crm.accountEnsure(name)
      if (!created) { setNotice('新建客户失败，请重试'); return }
      accountId = Number(created)
    }
    const r = await window.electronAPI.crm.paymentClaim(p.id, { account_id: accountId, contract_id: cid, sales_name: claimSales[p.id]?.trim() || mySalesName || undefined })
    setNotice(r.ok ? `已认领 ¥${shownAmountOf(p).toLocaleString()}，等待财务核销${r.linked ? '（已选择合同）' : ''}` : `认领失败：${r.reason}`)
    await fetchPayments(); await fetchQueues()
  }
  const setInvoiceRequirement = async (p: any, requirement: 'unknown' | 'required' | 'not_required' | 'info_pending') => {
    if (!p.allocation_id) return
    const r = await window.electronAPI.crm.allocationInvoiceRequirement(Number(p.allocation_id), requirement)
    setNotice(r.ok ? '开票需求已更新' : `更新失败：${r.reason || ''}`)
    await fetchPayments(); await fetchQueues()
  }
  const reconcilePayment = async (p: any) => {
    if (!p.allocation_id) return
    if (!window.confirm(`确认已完成「${p.account_name || p.payer || '该客户'}」¥${shownAmountOf(p).toLocaleString()} 的财务核销？`)) return
    const r = await window.electronAPI.crm.allocationReconcile(Number(p.allocation_id))
    setNotice(r.ok ? '财务核销已确认' : `核销失败：${r.reason || ''}`)
    await fetchPayments(); await fetchQueues()
  }
  const paymentFollowupActions = (p: any) => p.allocation_id && p.alloc_status === 'confirmed' ? (
    <div className="logi-card__actions">
      <select className="review-field" aria-label="开票需求" value={p.invoice_requirement || 'unknown'}
        onChange={(e) => void setInvoiceRequirement(p, e.target.value as 'unknown' | 'required' | 'not_required' | 'info_pending')}>
        <option value="unknown">开票待确认</option>
        <option value="required">需要开票</option>
        <option value="info_pending">待补开票资料</option>
        <option value="not_required">本单不开发票</option>
      </select>
      {p.reconciliation_status === 'allocated' || p.reconciliation_status === 'legacy_confirmed'
        ? <em className="review-tag invoice-ok">财务已核销</em>
        : <button className="btn btn--quiet btn--sm" onClick={() => void reconcilePayment(p)}>财务确认核销</button>}
    </div>
  ) : null

  useEffect(() => {
    void fetchQueues()
    void fetchGroups()
    void fetchPayments()
    void window.electronAPI.identity.get().then((idt) => setIdentity(identityLikeFromIpc(idt))).catch(() => undefined)
    void window.electronAPI.crm.list('contract', { limit: 200 }).then((rows) => {
      setContracts(rows || [])
      const map: Record<number, string> = {}
      for (const c of rows || []) if (c.id) map[Number(c.id)] = String(c.name || '')
      setContractName(map)
    })
    void window.electronAPI.crm.customers().then((rows) => {
      const list = (rows || []).filter((c: any) => c && c.id)
      setAccounts(list)
      const map: Record<number, string> = {}
      for (const c of list) map[Number(c.id)] = displayNameOf(c)
      setAccountName(map)
    })
    void window.electronAPI.crm.currentSalesName().then((n) => { if (n) setSavedSalesName(n) })
    void fetchSalesTeam()
    void fetchLogi(logiOverdueHours)
    void getCrmLogisticsOverdueHours().then((h) => { setLogiOverdueHours(h); void fetchLogi(h) })
  }, [fetchQueues])

  // 认领默认名与身份档案对齐（§2.80 A1）：可见性按 identity 姓名集合核对，认领默认必须落在同一姓名上——
  // 档案有名字用档案名；未建档（管理视角）回落 currentSalesName。团队名单点选仍可手动改（A5 认领写入不动）。
  useEffect(() => {
    if (identity.name.trim()) setMySalesName(identity.name.trim())
    else if (savedSalesName) setMySalesName(savedSalesName)
  }, [identity.name, savedSalesName])
  // 销售视角默认「只看我的」+「只看未认领」（§2.80 A3/C2）；管理视角不翻这两个默认
  useEffect(() => {
    if (isSalesView(identity)) setOnlyUnclaimed(true)
  }, [identity.role, identity.name])

  // 物流区行内提示（认领/签收操作反馈就近展示，滚动到列表下方时也能看到）
  const logiToast = (msg: string) => { setLogiNotice(msg) }
  // 自动匹配：收件人+城市 → 候选（合同优先）；唯一合同候选 → 认领到合同；无合同但唯一客户候选 → 认领到客户
  const linkLogi = async (l: any) => {
    const cands = await window.electronAPI.crm.logisticsCandidates(l.receiver, l.city)
    const contracts = cands.filter((c: any) => String(c.cand_kind || 'contract') === 'contract')
    const accounts = cands.filter((c: any) => String(c.cand_kind) === 'account')
    if (contracts.length === 1) {
      const r = await window.electronAPI.crm.logisticsLink(l.id, { contractId: Number(contracts[0].id), ownerSales: logiSales[l.id]?.trim() || mySalesName || undefined })
      logiToast(r.ok ? (r.warning ? `已认领，但${r.warning}` : `已认领：物流已关联「${contracts[0].name}」，转入「待签收」`) : `认领失败：${r.reason || '请重试'}`)
      await fetchQueues(); await fetchLogi(logiOverdueHours)
      return
    }
    if (accounts.length === 1) {
      const r = await window.electronAPI.crm.logisticsLink(l.id, { accountId: Number(accounts[0].account_id), ownerSales: logiSales[l.id]?.trim() || mySalesName || undefined })
      logiToast(r.ok ? `已认领：物流已关联客户「${accounts[0].name}」，转入「待签收」` : `认领失败：${r.reason || '请重试'}`)
      await fetchQueues(); await fetchLogi(logiOverdueHours)
      return
    }
    if (!contracts.length && !accounts.length) { logiToast('未找到匹配的客户或合同，请手动选择'); return }
    logiToast(`命中 ${contracts.length + accounts.length} 个候选，请用下拉选择`)
  }
  // 手动认领：客户（必选其一：下拉已有客户 或 新客户名建档） + 合同（可选） + 填销售 → 确认
  const doClaimLogi = async (l: any) => {
    const name = logiCustomer[l.id]?.trim() || ''
    const cid = logiContract[l.id] ? Number(logiContract[l.id]) : undefined
    if (!name && !cid) { logiToast('请先输入客户名'); return }
    let accountId: number | undefined = name ? customerIdOf(name) : undefined
    if (name && !accountId) {
      const created = await window.electronAPI.crm.accountEnsure(name)
      if (!created) { logiToast('新建客户失败，请重试'); return }
      accountId = Number(created)
    }
    const r = await window.electronAPI.crm.logisticsLink(l.id, { accountId, contractId: cid, ownerSales: logiSales[l.id]?.trim() || mySalesName || undefined })
    logiToast(r.ok ? (r.warning ? `已认领，但${r.warning}` : '已认领：物流转入「待签收」') : `认领失败：${r.reason || '请重试'}`)
    await fetchQueues(); await fetchLogi(logiOverdueHours)
  }
  // 确认签收：状态 → signed（销售联系客户/自查快递后标记）
  const doSignedLogi = async (l: any) => {
    if (!window.confirm(`确认「${l.tracking_no} · ${l.receiver}」已签收？`)) return
    const r = await window.electronAPI.crm.logisticsSigned(Number(l.id))
    logiToast(r.ok ? `已确认签收 ${l.receiver}` : `确认失败：${r.reason || ''}`)
    await fetchQueues(); await fetchLogi(logiOverdueHours)
  }
  // 超期未签收统计（顶部徽章 / 四格，随视图档过滤）
  const logiOverdueCount = logiLinked.filter((l: any) => l._overdueHours > 0).length
  const invoiceUnlinked = invoices.filter((i) => !i.contract_id).length // 四格副行：未挂合同的发票张数（过滤后口径）
  const noAccount = accounts.length === 0 // 无任何客户 → 认领不可行，给引导

  return (
    <div className="crm-review-page">
      {/* 页眉（概念稿 .shead）：eyebrow 保持真实队列命名；hero = 「今天要办」三计数 verdict（设计稿屏 4），
          全部来自视图档过滤后数组（数字同源，A4）；右侧 刷新 quiet + 立即扫描 轻 primary（本屏唯一主操作档） */}
      <div className="shead">
        <div>
          <p className="eyebrow">跟单 · 款项与物流</p>
          <h1 className="hero">今天要办：<b>{todayClaimable}</b> 笔到款待认领 · <b>{logiLinked.length}</b> 单物流待签收 · <b>{invoices.length}</b> 张发票待开</h1>
          <p className="sub">到款与物流来自本机扫描的群消息，需人工认领 / 签收，不会自动确认</p>
        </div>
        <div className="shead__actions">
          <button className="btn btn--quiet" onClick={() => { void fetchQueues(); void fetchPayments(); void fetchLogi(logiOverdueHours); void fetchSalesTeam(); void fetchGroups() }}><RefreshCw size={14} /> 刷新</button>
          <button className="btn btn--primary-soft" onClick={() => void scanNow()} disabled={loading}><Radio size={14} /> 立即扫描群消息</button>
        </div>
      </div>
      {/* 视图档（§2.80 A3）：quiet chipbar 同合同台「工作台/交付售后」降级写法，shead 下单独一行；管理视角不渲染 */}
      {isSalesView(identity) && (
        <div className="crm-view-row">
          <div className="chipbar" role="tablist" aria-label="数据范围">
            <button role="tab" aria-selected={!viewAll} className={`chip${!viewAll ? ' is-on' : ''}`} onClick={() => switchScope(false)}>只看我的</button>
            <button role="tab" aria-selected={viewAll} className={`chip${viewAll ? ' is-on' : ''}`} onClick={() => switchScope(true)}>全员</button>
          </div>
        </div>
      )}
      {/* 四格概览（概念稿 .stats 发丝顶底）：全部取过滤后队列计数；超期危险色仅 >0；「近 30 天」只进副行小字 */}
      <div className="stats">
        <div className="stat">
          <div className={`stat__n${logiOverdueCount > 0 ? ' stat__n--danger' : ''}`}>{logiOverdueCount}</div>
          <div className="stat__l">物流超期</div>
          <div className="stat__d">{logiOverdueCount > 0 ? `超过 ${logiOverdueHours}h 未签收` : `阈值 ${logiOverdueHours}h 未签收`}</div>
        </div>
        <div className="stat">
          <div className="stat__n">{todayClaimable}</div>
          <div className="stat__l">今日待认领到款</div>
          <div className="stat__d">近 30 天待认领 {unclaimedCount} 笔</div>
        </div>
        <div className="stat">
          <div className="stat__n">{logiLinked.length}</div>
          <div className="stat__l">待签收物流</div>
          <div className="stat__d">待认领 {logiUnlinked.length} 单</div>
        </div>
        <div className="stat">
          <div className="stat__n">{invoices.length}</div>
          <div className="stat__l">发票待开</div>
          <div className="stat__d">{invoiceUnlinked > 0 ? `${invoiceUnlinked} 张未关联合同` : '均已关联合同'}</div>
        </div>
      </div>
      {/* 队列栏（概念稿 .rail）：§2.80 三档 款项 | 物流 | 发票（三区一等公民）+ 右侧弱汇总（近 30 天只在此小字，不与四格大数字抢戏） */}
      <div className="rail" role="tablist" aria-label="跟单队列">
        <button type="button" role="tab" aria-selected={reviewTab === 'payments'}
          className={`rail__item${reviewTab === 'payments' ? ' is-on' : ''}`} onClick={() => setReviewTab('payments')}>
          款项认领<span className="rail__n">{unclaimedCount}</span>
        </button>
        <button type="button" role="tab" aria-selected={reviewTab === 'logistics'}
          className={`rail__item${reviewTab === 'logistics' ? ' is-on' : ''}`} onClick={() => setReviewTab('logistics')}>
          物流跟单<span className="rail__n">{logiUnlinked.length}</span>
        </button>
        <button type="button" role="tab" aria-selected={reviewTab === 'invoices'}
          className={`rail__item${reviewTab === 'invoices' ? ' is-on' : ''}`} onClick={() => setReviewTab('invoices')}>
          发票待开<span className="rail__n">{invoices.length}</span>
        </button>
        <span className="rail__sum">近 30 天到款 <b>{payments.length}</b> 笔</span>
      </div>
      {notice && <div className="crm-notice">{notice}</div>}

      {reviewTab === 'logistics' && (
      <section className="review-sec">
        <div className="review-sec__head">
          <span className="review-sec__t">物流跟单</span>
          <em className="logi-stats">
            待认领 {logiUnlinked.length} · 待签收 {logiLinked.length}
            <span className={logiOverdueCount > 0 ? 'logi-stats__overdue' : ''}>{logiOverdueCount > 0 ? ` · 超期 ${logiOverdueCount}` : ''}</span>
          </em>
        </div>
        {logiNotice && <div className="logi-notice">{logiNotice}</div>}
        <div className="logi-queue">
          <h4 className="review-queue__h">待认领<span className="review-queue__n">{logiUnlinked.length}</span></h4>
          {noAccount && logiUnlinked.length > 0 && (
            <div className="logi-notice logi-notice--warn">
              暂无客户，无法认领物流。请先在「客户工作台」创建客户。
            </div>
          )}
          {logiUnlinked.length === 0 && <div className="crm-card crm-card--empty">暂无待认领物流</div>}
          <WeekDayGroups items={logiUnlinked} timeOf={(l) => Number(l.latest_update_at)} render={(l) => {
            const selAcc = logiCustomer[l.id]?.trim() ? customerIdOf(logiCustomer[l.id]) : undefined
            const accContracts = selAcc ? contracts.filter((c) => Number(c.account_id) === selAcc) : []
            const claimReady = Boolean(logiCustomer[l.id]?.trim() || logiContract[l.id])
            return (
              <div className="crm-card logi-card">
                <div className="logi-card__main">
                  <span className="logi-card__info">{l.tracking_no} · {l.brand} · {l.receiver} {l.city}
                    {l.status !== 'shipped' && <em className="review-tag review-tag--warn">{logisticsStatusLabel(l.status)}</em>}
                  </span>
                  {l.exception_note && <em className="crm-card__src">「{String(l.exception_note).slice(0, 80)}」</em>}
                  <em className="logi-card__time">发货 {fmtTime(l.latest_update_at)}</em>
                </div>
                <div className="logi-card__actions">
                  <input className="review-field review-field--sales" placeholder="认领销售（默认本人）" value={logiSales[l.id] ?? ''}
                    onChange={(e) => setLogiSales((m) => ({ ...m, [l.id]: e.target.value }))} />
                  <div className="review-field review-field--account">
                    <CustomerPicker accounts={accounts} value={logiCustomer[l.id] ?? ''} onChange={(name) => setLogiCustomer((m) => ({ ...m, [l.id]: name }))} displayNameOf={displayNameOf} />
                  </div>
                  <select className="review-field review-field--contract" value={logiContract[l.id] ?? ''} onChange={(e) => setLogiContract((m) => ({ ...m, [l.id]: e.target.value }))}>
                    <option value="">关联合同（可选）</option>
                    {accContracts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                  <button className="btn btn--primary-soft btn--sm" disabled={!claimReady} title={claimReady ? '' : '请先输入客户名'} onClick={() => void doClaimLogi(l)}>确认认领</button>
                  <button className="btn btn--quiet btn--sm" onClick={() => void linkLogi(l)}>自动匹配</button>
                </div>
              </div>
            )
          }} />
        </div>
        <h4 className="review-queue__h">已认领待签收<span className="review-queue__n">{logiLinked.length}</span></h4>
        {logiLinked.length === 0 && <div className="crm-card crm-card--empty">暂无待签收物流（发货后 {logiOverdueHours}h 未签收会标红提醒）</div>}
        <WeekDayGroups items={logiLinked} timeOf={(l) => Number(l.latest_update_at)} render={(l) => (
          <div className="crm-card logi-card">
            <div className="logi-card__main">
              <span className="logi-card__info">
                {l.tracking_no} · {l.brand} · {l.receiver} {l.city}
                {l.owner_sales ? ` · ${l.owner_sales}` : ''}
                {contractName[Number(l.contract_id)] ? ` · ${contractName[Number(l.contract_id)]}` : accountName[Number(l.account_id)] ? ` · ${accountName[Number(l.account_id)]}` : ''}
                {l.status !== 'shipped' && <em className="review-tag review-tag--warn">{logisticsStatusLabel(l.status)}</em>}
              </span>
              {l._overdueHours > 0 && <em className="logi-overdue">超期 {l._overdueHours} 小时</em>}
              {l.exception_note && <em className="crm-card__src">「{String(l.exception_note).slice(0, 80)}」</em>}
              <em className="logi-card__time">发货 {fmtTime(l.latest_update_at)}{logiOverdueHours ? ` · 阈值 ${logiOverdueHours}h` : ''}</em>
            </div>
            <div className="logi-card__actions">
              <button className="btn btn--primary-soft btn--sm" onClick={() => void doSignedLogi(l)}>确认签收</button>
            </div>
          </div>
        )} />
        <h4 className="review-queue__h">已签收<span className="review-queue__n">{logiSigned.length}</span></h4>
        {logiSigned.length === 0
          ? <div className="crm-card crm-card--empty">暂无已签收物流</div>
          : <WeekDayGroups items={logiSigned} timeOf={(l) => Number(l.latest_update_at)} render={(l) => (
              <div className="crm-card logi-card">
                <div className="logi-card__main">
                  <span className="logi-card__info">{l.tracking_no} · {l.brand} · {l.receiver} {l.city}
                    {l.owner_sales ? ` · ${l.owner_sales}` : ''}
                    {contractName[Number(l.contract_id)] ? ` · ${contractName[Number(l.contract_id)]}` : accountName[Number(l.account_id)] ? ` · ${accountName[Number(l.account_id)]}` : ''}
                  </span>
                  <em className="logi-card__time">发货 {fmtTime(l.latest_update_at)} · 签收 {fmtTime(l.signed_at)}</em>
                </div>
              </div>
            )} />}
      </section>
      )}

      {reviewTab === 'payments' && (
      <section className="review-sec">
        <div className="review-sec__head">
          <span className="review-sec__t">款项认领（7 天一页）</span>
          <em className="logi-stats">近 30 天 {payments.length} 笔 · 待认领 {unclaimedCount} 笔</em>
          {/* 页器收进节标题行（§2.80 分页收编：不再插在日分组与已确认到款之间） */}
          <span className="review-sec__pager">
            <DayPager cur={payCur} maxPage={payMaxPage} onPage={setPayPage} />
          </span>
          <button className={`btn btn--quiet btn--sm review-only-unclaimed${onlyUnclaimed ? ' is-on' : ''}`} aria-pressed={onlyUnclaimed} onClick={() => setOnlyUnclaimed((v) => !v)}>公共待认领</button>
        </div>
        {payItems.length === 0 && <div className="crm-card crm-card--empty">{onlyUnclaimed ? '没有待认领的到款' : '近 30 天无到款记录'}</div>}
        <WeekDayGroups
          items={payItems}
          timeOf={(p) => Number(p.pay_time)}
          forceOpen={onlyUnclaimed}
          page={payPage}
          onPageChange={setPayPage}
          headerInfo={(list) => {
            const dayTotal = list.reduce((s, p) => s + shownAmountOf(p), 0)
            const unclaimed = list.filter(isClaimable).length
            return (
              <>
                · ¥{dayTotal.toLocaleString()}
                {unclaimed > 0 && <em className="logi-card__time day-unclaimed">· {unclaimed} 未认领</em>}
              </>
            )
          }}
          render={(p) => {
                const claimable = isClaimable(p)
                const claimed = !claimable
                const selAcc = claimCustomer[p.id]?.trim() ? customerIdOf(claimCustomer[p.id]) : undefined
                const accContracts = selAcc ? contracts.filter((c) => Number(c.account_id) === selAcc) : []
                return (
                  <div key={p.id} className="crm-card logi-card">
                    <div className="logi-card__main">
                      <span className="logi-card__info">
                        {p.payer || '(截图/未知)'} · ¥{shownAmountOf(p).toLocaleString()}
                        {claimed && <span className="claim-ok">
                          {p.account_name ? ` · 客户「${p.account_name}」` : ''}{p.contract_name ? ` · 合同「${p.contract_name}」` : ''}
                          {p.sales_name ? ` · 销售 ${p.sales_name}` : ''}
                        </span>}
                        {invoiceBadgeOf(p)}
                        {p.alloc_status === 'confirmed' && !p.account_id && !p.contract_id && <em className="logi-card__time">旧自动认领遗留 · 请补认领</em>}
                      </span>
                      <em className="logi-card__time">{groupName(p.group_id)}{p.pay_time ? ` · ${fmtTime(p.pay_time)}` : ''}</em>
                      {p.raw_content && <em className="crm-card__src">「{String(p.raw_content).slice(0, 40)}」</em>}
                    </div>
                    {!claimed && (
                      <div className="logi-card__actions">
                        <input className="review-field review-field--sales" placeholder="认领销售（默认本人）" value={claimSales[p.id] ?? ''}
                          onChange={(e) => setClaimSales((m) => ({ ...m, [p.id]: e.target.value }))} />
                        <div className="review-field review-field--account">
                          <CustomerPicker accounts={accounts} value={claimCustomer[p.id] ?? ''} onChange={(name) => setClaimCustomer((m) => ({ ...m, [p.id]: name }))} displayNameOf={displayNameOf} />
                        </div>
                        <select className="review-field review-field--contract" value={claimContract[p.id] ?? ''} onChange={(e) => setClaimContract((m) => ({ ...m, [p.id]: e.target.value }))}>
                          <option value="">关联合同（可选）</option>
                          {accContracts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                        </select>
                        <button className="btn btn--primary-soft btn--sm" disabled={!Boolean(claimCustomer[p.id]?.trim())}
                          title={claimCustomer[p.id]?.trim() ? '' : '请先输入客户名'} onClick={() => void doClaimPayment(p)}>认领</button>
                      </div>
                    )}
                    {claimed && paymentFollowupActions(p)}
                  </div>
                )
          }}
        />
        {claimedPayments.length > 0 && (
          <div className="claimed-section">
            <h4 className="day-header" onClick={() => setClaimedOpen((v) => !v)}>
              <span className="day-arrow">{claimedOpen ? '▾' : '▸'}</span> 已确认到款（{claimedPayments.length} 笔 · ¥
              {claimedPayments.reduce((s, p) => s + shownAmountOf(p), 0).toLocaleString()}）
            </h4>
            {claimedOpen && claimedPayments.map((p) => (
              <div key={p.id} className="crm-card claimed-row">
                <span className="claimed-row__ico">¥</span>
                <div className="logi-card__main">
                  <span className="logi-card__info claimed-row__amt">
                    ¥{shownAmountOf(p).toLocaleString()}
                    <span className="claim-ok">
                      {p.account_name ? ` · 客户「${p.account_name}」` : ''}{p.contract_name ? ` · 合同「${p.contract_name}」` : ''}
                    </span>
                  </span>
                  <span className="logi-card__time">
                    {p.payer || '(截图/未知)'}{p.sales_name ? ` · 销售 ${p.sales_name}` : ''}
                  </span>
                </div>
                {invoiceBadgeOf(p)}
                <em className="logi-card__time claimed-row__time">{p.pay_time ? `到账 ${fmtTime(p.pay_time)}` : ''}</em>
                {paymentFollowupActions(p)}
              </div>
            ))}
          </div>
        )}
      </section>
      )}

      {reviewTab === 'invoices' && (
      <section className="review-sec">
        <div className="review-sec__head">
          <span className="review-sec__t">发票待开</span>
          <em className="logi-stats">{invoices.length} 张{invoiceUnlinked > 0 ? ` · ${invoiceUnlinked} 张未关联合同` : ''}</em>
        </div>
        {invoices.length === 0 && <div className="crm-card crm-card--empty">暂无待开发票</div>}
        {invoices.map((i) => (
          <div key={i.id} className="crm-card">
            <span>{i.buyer} · 发票号 {i.invoice_no || '-'} · 金额 ¥{Number(i.amount ?? 0).toLocaleString()}
              <em className={`review-tag${i.contract_id || i.account_id ? '' : ' review-tag--warn'}`}>{i.contract_id || i.account_id ? '已关联合同' : '未关联合同'}</em>
            </span>
            <input className="crm-card__amt" type="number" min="0" placeholder="填写金额" value={invoiceAmount[i.id] ?? ''}
              onChange={(e) => setInvoiceAmount((m) => ({ ...m, [i.id]: e.target.value }))} />
            <button className="btn btn--quiet btn--sm" onClick={() => {
              const amt = parseFloat(invoiceAmount[i.id] ?? '')
              if (!amt || amt <= 0) { setNotice('请先填写发票金额'); return }
              void window.electronAPI.crm.update('invoice', i.id, { amount: amt }).then(() => { setNotice(`发票金额已保存 ¥${amt.toLocaleString()}`); void fetchQueues() })
            }}>保存金额</button>
            <select value={invoiceContract[i.id] ?? ''} onChange={(e) => {
              const v = e.target.value
              setInvoiceContract((m) => ({ ...m, [i.id]: v }))
              if (v) { void window.electronAPI.crm.update('invoice', i.id, { contract_id: Number(v) }).then(fetchQueues) }
            }}>
              <option value="">关联合同…</option>
              {contracts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <button className="btn btn--quiet btn--sm" disabled={!!generating} onClick={() => void generateInvoice('invoice-info', i.id)}>开票信息单</button>
            <button className="btn btn--quiet btn--sm" disabled={!!generating} onClick={() => void generateInvoice('invoice-app', i.id)}>开票申请</button>
            {['invoice-info', 'invoice-app'].map(type => generatedArtifacts[`${type}:${i.id}`] && <GeneratedFileResult key={`${type}:${i.id}`} artifact={generatedArtifacts[`${type}:${i.id}`]} onClose={() => setGeneratedArtifacts(v => { const next = { ...v }; delete next[`${type}:${i.id}`]; return next })} />)}
          </div>
        ))}
        </section>
      )}

      {/* 「管理」折叠区（设计稿屏 4）：扫描群聊设置 + 销售团队管理收编于此，默认收起，功能原样 */}
      <button className="review-fold" onClick={() => setManageOpen((v) => !v)}>
        <span>⚙️ 管理（扫描群聊设置 / 销售团队）</span>
        <span>{manageOpen ? '收起 ▲' : '展开 ▼'}</span>
      </button>
      {manageOpen && (
        <div className="review-manage">
          <section>
            <h3>销售团队（{salesTeam.length}）<em className="logi-stats">{mySalesName ? `当前认领默认：${mySalesName}` : '点成员名可设为认领默认'}</em></h3>
            <div className="sales-team-drop sales-team-drop--inline">
              <div className="sales-team-drop__title">
                在职销售 {salesTeam.length} 人
                {mySalesName ? <em>当前认领默认：{mySalesName}</em> : null}
              </div>
              {salesTeam.length === 0 && <div className="customer-picker__empty">暂无销售成员</div>}
              {salesTeam.map((m) => (
                <div key={m.name} className="sales-team-drop__row">
                  <button className="sales-team-drop__pick" onClick={() => setMySalesName(m.name)}>
                    {m.name}
                    <em>{m.orderCount} 单 · ¥{m.amount.toLocaleString()}</em>
                  </button>
                  <button className="sales-team-drop__rm" title="移除（离职）" onClick={() => void removeSalesMember(m.name)}>移除</button>
                </div>
              ))}
              <div className="sales-team-drop__add">
                <input placeholder="添加销售（输入姓名）" value={addSalesName}
                  onChange={(e) => setAddSalesName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void addSalesMember() }} />
                <button className="btn btn--plain btn--sm" onClick={() => void addSalesMember()}>添加</button>
              </div>
            </div>
          </section>
          <section>
            <h3>扫描群聊（{groups.filter((g) => Number(g.enabled) === 1).length}/{groups.length} 启用）· 物流发货 / 货款认领固定群</h3>
            {groups.map((g) => (
              <div key={g.id} className="crm-card">
                <span>{g.group_name} <em className="gtype">{TYPE_LABELS[String(g.group_type)] || g.group_type}</em></span>
                <select value={String(g.group_type)} onChange={(e) => void retypeGroup(g, e.target.value)}>
                  <option value="logistics">物流发货</option>
                  <option value="payment">货款认领</option>
                  <option value="order">订单截图</option>
                </select>
                <label className="gswitch"><input type="checkbox" checked={Number(g.enabled) === 1} onChange={(e) => void toggleGroup(g, e.target.checked)} /> 启用</label>
              </div>
            ))}
            <button className="btn btn--plain btn--sm" onClick={() => void openPick()}><Users size={14} /> 筛选群聊</button>
          </section>
        </div>
      )}
      {showPick && (
        <div className="crm-modal">
          <div className="crm-modal-body">
            <h3>筛选扫描群聊 <button className="btn btn--plain btn--sm" onClick={() => setShowPick(false)}><X size={14} /></button></h3>
            <input className="crm-search" placeholder="搜索群聊名称 / ID" value={pickSearch} onChange={(e) => setPickSearch(e.target.value)} />
            <div className="pick-list">
              {groupSessions
                .filter((x) => !groups.some((g) => g.group_id === x.username))
                .filter((x) => {
                  const q = pickSearch.trim().toLowerCase()
                  if (!q) return true
                  return String(x.displayName || '').toLowerCase().includes(q) || String(x.username || '').toLowerCase().includes(q)
                })
                .slice(0, 50)
                .map((x) => (
                  <div key={x.username} className="crm-card">
                    <span>{x.displayName || x.username}</span>
                    <select value={pickType[String(x.username)] || 'payment'} onChange={(e) => setPickType((m) => ({ ...m, [String(x.username)]: e.target.value }))}>
                      <option value="payment">货款认领</option>
                      <option value="logistics">物流发货</option>
                      <option value="order">订单截图</option>
                    </select>
                    <button className="btn btn--primary btn--sm" onClick={() => void addGroup(x)}>添加并扫描</button>
                  </div>
                ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
