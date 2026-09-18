import GeneratedFileResult, { type GeneratedArtifact } from '../components/crm/GeneratedFileResult'
/**
 * CrmReviewPage.tsx —— 跟单中心：到款认领（7 天一页，销售认领+开票状态）/ 物流跟单（7 天一页，待认领+待签收+已签收）/ 发票待开
 * 2026-08-24 改造：去掉 AI 自动确认（销售手动认领），到款按天分组展示，认领后显示开票状态（订单群 PDF 发票解析）。
 */
import { Fragment, useEffect, useState, type ReactNode } from 'react'
import { RefreshCw, Radio, Users, X } from 'lucide-react'
import { useCrmStore } from '../stores/crmStore'
import { getCrmLogisticsOverdueHours } from '../services/config'
import CustomerPicker from '../components/sales/CustomerPicker'
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
/** 日标签：8/24（今天）· 8/23（昨天）· 8/16 */
const dayLabelOf = (start: number): string => {
  const diff = Math.round((dayStartOf(Date.now()) - start) / DAY_MS)
  const label = `${new Date(start).getMonth() + 1}/${new Date(start).getDate()}`
  if (diff === 0) return `${label}（今天）`
  if (diff === 1) return `${label}（昨天）`
  return label
}

/**
 * 一页七天折叠列表（到款认领 / 物流三队列共用）：每页 7 个自然日，每天一行（默认折叠，点 header 展开当天明细）；
 * 翻页按 7 天窗口前移，上限 = 最老一条所在页；forceOpen 用于筛选模式强制全展开。
 */
function WeekDayGroups(props: {
  items: any[]
  timeOf: (it: any) => number
  render: (it: any) => ReactNode
  headerInfo?: (list: any[]) => ReactNode
  forceOpen?: boolean
}) {
  const { items, timeOf, render, headerInfo, forceOpen } = props
  const [page, setPage] = useState(0) // 0 = 最近 7 天窗口
  const [expandedDays, setExpandedDays] = useState<Set<string>>(new Set()) // 用户显式展开的天 key
  if (items.length === 0) return null
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
  const oldest = Math.min(...items.map((it) => dayStartOf(timeOf(it))))
  const maxPage = Math.max(0, Math.floor((dayStartOf(Date.now()) - oldest) / WEEK_MS))
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
      {maxPage > 0 && (
        <div className="crm-pager">
          <button className="btn btn--plain btn--sm" disabled={cur >= maxPage} onClick={() => setPage(cur + 1)}>上一页</button>
          <span className="crm-pager-info">{dayLabelOf(days[0])} ~ {dayLabelOf(days[6])} · 第 {cur + 1} / {maxPage + 1} 页</span>
          <button className="btn btn--plain btn--sm" disabled={cur <= 0} onClick={() => setPage(cur - 1)}>下一页</button>
        </div>
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
  const [showPick, setShowPick] = useState(false)
  const [pickSearch, setPickSearch] = useState('')
  const [groupSessions, setGroupSessions] = useState<any[]>([])
  const [pickType, setPickType] = useState<Record<string, string>>({})
  const [invoiceContract, setInvoiceContract] = useState<Record<number, string>>({})
  const [invoiceAmount, setInvoiceAmount] = useState<Record<number, string>>({}) // invoiceId → 金额输入
  // ── 每日到款：按天分组清单 + 认领控件 state ─────────────────────────────────
  const [payments, setPayments] = useState<any[]>([]) // paymentsByDay 平铺（带认领/开票状态）
  const [claimCustomer, setClaimCustomer] = useState<Record<number, string>>({}) // paymentId → 客户名（匹配已有客户或直接建档）
  const [claimContract, setClaimContract] = useState<Record<number, string>>({}) // paymentId → 合同 id
  const [claimSales, setClaimSales] = useState<Record<number, string>>({}) // paymentId → 认领销售（不填=默认本人，认领不一定是自己的）
  const [onlyUnclaimed, setOnlyUnclaimed] = useState(false) // 只看未认领
  // 2026-08-29 对齐设计稿：款项认领 / 物流跟单 分 Tab（默认款项认领）
  const [reviewTab, setReviewTab] = useState<'payments' | 'logistics'>('payments')
  const [claimedOpen, setClaimedOpen] = useState(true) // 已确认到款默认展开、可折叠（header 复用每日分组样式，须真实可点）
  const [salesTeam, setSalesTeam] = useState<Array<{ name: string; orderCount: number; amount: number }>>([]) // 销售团队名单
  const [addSalesName, setAddSalesName] = useState('') // 添加销售输入
  // 「管理」折叠区（设计稿屏 4：扫描群聊设置 + 销售团队，默认收起，功能原样）
  const [manageOpen, setManageOpen] = useState(false)
  // ── 物流跟单 ─────────────────────────────────────────────────────────────
  const [logiLinked, setLogiLinked] = useState<any[]>([]) // 已认领待签收
  const [logiSigned, setLogiSigned] = useState<any[]>([]) // 已签收
  const [logiContract, setLogiContract] = useState<Record<number, string>>({}) // logisticsId → 合同 id（认领下拉，可选）
  const [logiCustomer, setLogiCustomer] = useState<Record<number, string>>({}) // logisticsId → 客户名（匹配已有客户或直接建档）
  const [logiSales, setLogiSales] = useState<Record<number, string>>({}) // logisticsId → 认领销售（不填=默认本人）
  const [mySalesName, setMySalesName] = useState('') // 当前登录账户显示名（认领销售自动带，单人团队不用手输）
  const [logiOverdueHours, setLogiOverdueHours] = useState(24) // 超期阈值（设置页配置）
  const [logiNotice, setLogiNotice] = useState('') // 物流区行内反馈（认领/签收结果就近显示，避免顶部 notice 被滚动遮挡）
  const [contractName, setContractName] = useState<Record<number, string>>({}) // contract_id → 名称（跟单视图展示）
  const [accounts, setAccounts] = useState<any[]>([]) // 全部客户（认领下拉 + 待签收/已签收客户名展示）
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
  const fetchLogi = async (hours: number) => {
    const [pending, signed] = await Promise.all([
      window.electronAPI.crm.logisticsList({ filter: 'pending' }),
      window.electronAPI.crm.logisticsList({ filter: 'signed' }),
    ])
    setLogiLinked((pending || []).map((l: any) => ({ ...l, _overdueHours: overdueHoursOf(l, hours) })))
    setLogiSigned((signed || []).map((l: any) => ({ ...l, _overdueHours: overdueHoursOf(l, hours) })))
  }

  // ── 款项认领清单：平铺按 pay_time 7 天窗口分组（组内时间倒序）────
  const fetchPayments = async () => setPayments((await window.electronAPI.crm.paymentsByDay(30)) || [])
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
  // 可认领 = 无归属 / 归属待确认 / 旧自动确认遗留（confirmed 但未挂客户合同）
  const isClaimable = (p: any) => !p.alloc_status || p.alloc_status === 'pending' || (p.alloc_status === 'confirmed' && !p.account_id && !p.contract_id)
  // 已确认到款 = 已认领且挂上客户或合同（确认收到款项集中罗列，与每日流水分开）
  const claimedPayments = payments.filter((p) => p.alloc_status === 'confirmed' && (p.account_id || p.contract_id))
  // 只看未认领：行数已很少，强制全展开（折叠不挡筛选结果）
  const claimablePayments = payments.filter(isClaimable)
  // 「今天要办」摘要（设计稿屏 4）：今日到款待认领 = 现有 claimable 口径 + pay_time 落在今天（与按天分组同口径），零新查询
  const todayClaimable = claimablePayments.filter((p) => dayStartOf(Number(p.pay_time)) === dayStartOf(Date.now())).length
  // 待认领笔数（与原「款项认领」标题内联同一口径，提到变量供视图栏与本段共用）
  const unclaimedCount = payments.filter((p) => !p.alloc_status || p.alloc_status === 'pending').length
  // 开票状态：认领后按订单群 PDF 发票解析结果展示（invoice_status='issued' 即已开票）；
  // 旧自动确认遗留（confirmed 无客户合同）补认领前不显示开票状态
  const invoiceBadgeOf = (p: any) => {
    if (!p.alloc_status || p.alloc_status === 'pending') return null
    if (p.alloc_status === 'confirmed' && !p.account_id && !p.contract_id) return null
    if (p.invoice_status === 'issued') return <em className="logi-card__time invoice-ok">已开票 {p.invoice_no ? `· ${p.invoice_no}` : ''}</em>
    if (p.invoice_status) return <em className="logi-card__time">开票中</em>
    return <em className="logi-card__time">未开票</em>
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
    setNotice(r.ok ? (r.linked ? `已认领 ¥${shownAmountOf(p).toLocaleString()}：计入合同回款` : '已认领（未关联合同，回款未计入）') : `认领失败：${r.reason}`)
    await fetchPayments(); await fetchQueues()
  }

  useEffect(() => {
    void fetchQueues()
    void fetchGroups()
    void fetchPayments()
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
    void window.electronAPI.crm.currentSalesName().then((n) => { if (n) setMySalesName(n) })
    void fetchSalesTeam()
    void fetchLogi(logiOverdueHours)
    void getCrmLogisticsOverdueHours().then((h) => { setLogiOverdueHours(h); void fetchLogi(h) })
  }, [fetchQueues])

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
  // 超期未签收统计（顶部徽章）
  const logiOverdueCount = logiLinked.filter((l: any) => l._overdueHours > 0).length
  const invoiceUnlinked = queues.invoices.filter((i) => !i.contract_id).length // 四格副行：未挂合同的发票张数
  const noAccount = accounts.length === 0 // 无任何客户 → 认领不可行，给引导

  return (
    <div className="crm-review-page">
      {/* 页眉（概念稿 .shead）：eyebrow 按真实队列命名；hero 用页内既有计数（今日待认领到款 + 待签收），
          不写「承诺」腔；右侧 刷新 quiet + 立即扫描 轻 primary（本屏唯一主操作档） */}
      <div className="shead">
        <div>
          <p className="eyebrow">跟单 · 款项与物流</p>
          <h1 className="hero">今天待办 {todayClaimable + logiLinked.length} 件，物流超期 {logiOverdueCount} 件</h1>
          <p className="sub">到款与物流来自本机扫描的群消息，需人工认领 / 签收，不会自动确认</p>
        </div>
        <div className="shead__actions">
          <button className="btn btn--quiet" onClick={() => { void fetchQueues(); void fetchPayments(); void fetchLogi(logiOverdueHours); void fetchSalesTeam(); void fetchGroups() }}><RefreshCw size={14} /> 刷新</button>
          <button className="btn btn--primary-soft" onClick={() => void scanNow()} disabled={loading}><Radio size={14} /> 立即扫描群消息</button>
        </div>
      </div>
      {/* 四格概览（概念稿 .stats）：全部取页内既有队列计数，不新造口径；超期危险色仅 >0 */}
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
          <div className="stat__d">待认领 {queues.logistics.length} 单</div>
        </div>
        <div className="stat">
          <div className="stat__n">{queues.invoices.length}</div>
          <div className="stat__l">发票待开</div>
          <div className="stat__d">{invoiceUnlinked > 0 ? `${invoiceUnlinked} 张未关联合同` : '均已关联合同'}</div>
        </div>
      </div>
      {/* 视图栏（概念稿 .rail）：两个队列档位 + 右侧弱汇总（只留四格没有的近 30 天到款笔数，不与四格重复） */}
      <div className="rail" role="tablist" aria-label="跟单队列">
        <button type="button" role="tab" aria-selected={reviewTab === 'payments'}
          className={`rail__item${reviewTab === 'payments' ? ' is-on' : ''}`} onClick={() => setReviewTab('payments')}>
          款项认领<span className="rail__n">{unclaimedCount}</span>
        </button>
        <button type="button" role="tab" aria-selected={reviewTab === 'logistics'}
          className={`rail__item${reviewTab === 'logistics' ? ' is-on' : ''}`} onClick={() => setReviewTab('logistics')}>
          物流跟单<span className="rail__n">{queues.logistics.length}</span>
        </button>
        <span className="rail__sum">近 30 天到款 <b>{payments.length}</b> 笔</span>
      </div>
      {notice && <div className="crm-notice">{notice}</div>}

      {reviewTab === 'logistics' && (
      <section className="review-sec">
        <div className="review-sec__head">
          <span className="review-sec__t">物流跟单</span>
          <em className="logi-stats">
            待认领 {queues.logistics.length} · 待签收 {logiLinked.length}
            <span className={logiOverdueCount > 0 ? 'logi-stats__overdue' : ''}>{logiOverdueCount > 0 ? ` · 超期 ${logiOverdueCount}` : ''}</span>
          </em>
        </div>
        {logiNotice && <div className="logi-notice">{logiNotice}</div>}
        <div className="logi-queue">
          <h4 className="review-queue__h">待认领<span className="review-queue__n">{queues.logistics.length}</span></h4>
          {noAccount && queues.logistics.length > 0 && (
            <div className="logi-notice logi-notice--warn">
              暂无客户，无法认领物流。请先在「客户工作台」创建客户。
            </div>
          )}
          {queues.logistics.length === 0 && <div className="crm-card crm-card--empty">暂无待认领物流</div>}
          <WeekDayGroups items={queues.logistics} timeOf={(l) => Number(l.latest_update_at)} render={(l) => {
            const selAcc = logiCustomer[l.id]?.trim() ? customerIdOf(logiCustomer[l.id]) : undefined
            const accContracts = selAcc ? contracts.filter((c) => Number(c.account_id) === selAcc) : []
            const claimReady = Boolean(logiCustomer[l.id]?.trim() || logiContract[l.id])
            return (
              <div className="crm-card logi-card">
                <div className="logi-card__main">
                  <span className="logi-card__info">{l.tracking_no} · {l.brand} · {l.receiver} {l.city}</span>
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
              </span>
              {l._overdueHours > 0 && <em className="logi-overdue">超期 {l._overdueHours} 小时</em>}
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
          <button className={`btn btn--quiet btn--sm review-only-unclaimed${onlyUnclaimed ? ' is-on' : ''}`} aria-pressed={onlyUnclaimed} onClick={() => setOnlyUnclaimed((v) => !v)}>只看未认领</button>
        </div>
        {payments.length === 0 && <div className="crm-card crm-card--empty">近 30 天无到款记录</div>}
        <WeekDayGroups
          items={onlyUnclaimed ? claimablePayments : payments}
          timeOf={(p) => Number(p.pay_time)}
          forceOpen={onlyUnclaimed}
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
              </div>
            ))}
          </div>
        )}
      </section>
      )}

      {reviewTab === 'payments' && (
      <section className="review-sec">
        <div className="review-sec__head">
          <span className="review-sec__t">发票待开</span>
          <em className="logi-stats">{queues.invoices.length} 张</em>
        </div>
        {queues.invoices.map((i) => (
          <div key={i.id} className="crm-card">
            <span>{i.buyer} · 发票号 {i.invoice_no || '-'} · 金额 ¥{Number(i.amount ?? 0).toLocaleString()}
              <em className="crm-card__src">{i.contract_id ? '已关联合同' : '未关联合同'}</em>
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
