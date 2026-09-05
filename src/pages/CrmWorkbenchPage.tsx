/**
 * CrmWorkbenchPage.tsx —— 合同工作台：合同列表+全款进度+四子资源+发货卡点+文档生成
 * （客户工作台已拆分到 CustomerWorkspacePage /customers，本页专注合同闭环）
 */
import { useEffect, useState } from 'react'
import { useWxidRefresh } from '../utils/useWxidRefresh'
import { Briefcase, FileText, RefreshCw, Truck, Plus, Handshake, X, Trash2, Users, Banknote, AlertTriangle } from 'lucide-react'
import { useSearchParams } from 'react-router-dom'
import ReactECharts from 'echarts-for-react'
import { useCrmStore } from '../stores/crmStore'
import SearchTable, { type SearchTableColumn } from '../components/crm/SearchTable'
// 阶段分布/管道图色板单一真源（红线 3）：Apple 蓝渐变族
import { FUNNEL_STAGE_COLORS, FUNNEL_NEUTRAL } from '../../shared/funnelPalette'
import './CrmWorkbenchPage.scss'

interface QuoRow { productId: number; name: string; model?: string; price: number; qty: string }

export default function CrmWorkbenchPage() {
  const { workbench, fetchWorkbench, notice, setNotice, products, fetchProducts } = useCrmStore()
  const [selected, setSelected] = useState<any>(null)
  const [quotations, setQuotations] = useState<any[]>([])
  const [invoices, setInvoices] = useState<any[]>([])
  const [allocations, setAllocations] = useState<any[]>([])
  const [logistics, setLogistics] = useState<any[]>([])
  const [showNew, setShowNew] = useState(false)
  const [newAccountId, setNewAccountId] = useState(0) // 选中的已有客户（零操作建合同：不再重复建 account）
  const [newName, setNewName] = useState('')
  const [newAmount, setNewAmount] = useState('')
  // 甲方开票信息（新建合同：随合同创建写入 custom_fields）
  const [newBuyerAddr, setNewBuyerAddr] = useState('')
  const [newBuyerBank, setNewBuyerBank] = useState('')
  const [newBuyerAccount, setNewBuyerAccount] = useState('')
  const [newBuyerTax, setNewBuyerTax] = useState('')
  const [newBuyerPhone, setNewBuyerPhone] = useState('')
  // 甲方开票信息（已建合同：详情编辑）
  const [showEditInvoice, setShowEditInvoice] = useState(false)
  const [editAddr, setEditAddr] = useState('')
  const [editBank, setEditBank] = useState('')
  const [editAccount, setEditAccount] = useState('')
  const [editTax, setEditTax] = useState('')
  const [editPhone, setEditPhone] = useState('')
  const [showQuo, setShowQuo] = useState(false)
  const [quoRows, setQuoRows] = useState<QuoRow[]>([])
  const [quoSearch, setQuoSearch] = useState('')
  // 新建合同：勾选的型号行项（创建时自动生成报价单）
  const [newQuoItems, setNewQuoItems] = useState<QuoRow[]>([])
  const [newQuoSearch, setNewQuoSearch] = useState('')
  const [customers, setCustomers] = useState<any[]>([])
  // ── 合同列表骨架（SearchTable）：前端分页 + 状态筛选 + 名称搜索 ──────────────
  const [tablePage, setTablePage] = useState(1) // 合同列表当前页（筛选变化时重置到 1）
  const [statusFilter, setStatusFilter] = useState('') // 状态筛选（''=全部）
  const [keyword, setKeyword] = useState('') // 合同名搜索

  useEffect(() => { void fetchWorkbench() }, [fetchWorkbench])
  useEffect(() => { void fetchCustomers() }, [])

  // ─── P3 可视化：统计概览 + 三图 ────────────────────────────────────────────
  const [stats, setStats] = useState<any>(null)
  const fetchStats = async () => {
    try { setStats(await window.electronAPI.crm.statsOverview()) } catch { /* ignore */ }
  }
  useEffect(() => { void fetchStats() }, [])
  // AI 准确率（近 7 天）：填充/采纳/修正/报价信号转化
  const [accuracy, setAccuracy] = useState<any>(null)
  const [accuracyOpen, setAccuracyOpen] = useState(true)
  const fetchAccuracy = async () => {
    try { setAccuracy(await window.electronAPI.crm.statsAiAccuracy(7)) } catch { /* ignore */ }
  }
  useEffect(() => { void fetchAccuracy() }, [])
  // 切微信号 = 换库（§2.40）：账号切换后四路数据全部重查
  useWxidRefresh(() => { void fetchWorkbench(); void fetchCustomers(); void fetchStats(); void fetchAccuracy() })
  const STAGE_LABEL_MAP: Record<string, string> = {
    contacted: '已沟通', quoted: '已报价', negotiating: '谈判中', won: '已成交', new: '新客', unknown: '未分类'
  }
  const CONTRACT_STATUS_MAP: Record<string, string> = { pending_sign: '待签约', signed: '已签约', shipped: '已发货' }
  // 图表色单一真源（红线 3）：与漏斗同族的 Apple 蓝渐变
  const BAR_ACCENT = {
    type: 'linear' as const, x: 0, y: 0, x2: 0, y2: 1,
    colorStops: [{ offset: 0, color: '#5A9DED' }, { offset: 1, color: '#0071E3' }]
  }
  const paidTrendOption = stats ? {
    tooltip: { trigger: 'axis' as const },
    grid: { left: 48, right: 16, top: 24, bottom: 24 },
    xAxis: { type: 'category' as const, data: stats.paidWeekly.map((w: any) => w.week), axisLabel: { fontSize: 11 } },
    yAxis: { type: 'value' as const, axisLabel: { fontSize: 11 } },
    series: [{ type: 'bar', data: stats.paidWeekly.map((w: any) => w.amount), itemStyle: { color: BAR_ACCENT, borderRadius: [3, 3, 0, 0] }, barMaxWidth: 22 }]
  } : null
  // 阶段 key → 蓝族档位（新客浅蓝 → 成交藏青；未分类中性灰）
  const STAGE_KEY_COLOR: Record<string, string> = {
    new: FUNNEL_STAGE_COLORS[0], contacted: FUNNEL_STAGE_COLORS[1], quoted: FUNNEL_STAGE_COLORS[2],
    negotiating: FUNNEL_STAGE_COLORS[3], won: FUNNEL_STAGE_COLORS[4], unknown: FUNNEL_NEUTRAL
  }
  const stageDistOption = stats ? {
    tooltip: { trigger: 'item' as const, formatter: '{b}: {c} 人（{d}%）' },
    legend: {
      orient: 'vertical' as const, right: 8, top: 'middle' as const,
      icon: 'circle' as const, itemWidth: 9, itemHeight: 9, itemGap: 10,
      textStyle: { fontSize: 12, color: '#6E6E73' }
    },
    title: {
      text: String((stats.stageDist || []).reduce((n: number, s: any) => n + Number(s.count || 0), 0)),
      subtext: '客户', left: '36%', top: '40%', textAlign: 'center',
      textStyle: { fontSize: 24, fontWeight: 700, color: '#1D1D1F' },
      subtextStyle: { fontSize: 11, color: '#86868B' }
    },
    series: [{
      type: 'pie', radius: ['46%', '70%'], center: ['40%', '50%'],
      label: { show: false },
      labelLine: { show: false },
      data: stats.stageDist.map((s: any) => ({ name: STAGE_LABEL_MAP[s.stage] || s.stage, value: s.count, itemStyle: { color: STAGE_KEY_COLOR[s.stage] || FUNNEL_NEUTRAL } }))
    }]
  } : null


  const fetchCustomers = async () => {
    const rows = (await window.electronAPI.crm.customers()) || []
    setCustomers(rows)
    return rows
  }

  // 名称双轨读取侧统一：优先取画像最新微信备注（跟随备注改名），account.name 作兜底（导入时刻冻结）
  // （新建合同「选择已有客户」下拉用）
  const displayNameOf = (c: any) => String(c.profile_display_name || '') || String(c.name || '')

  // 深链协议：/crm?account=<id>&new=1（客户工作台「建合同」跳入：预选客户 + 打开新建合同弹窗 + 带出开票信息）
  const [searchParams] = useSearchParams()
  useEffect(() => {
    const accountId = Number(searchParams.get('account') || 0)
    if (searchParams.get('new') !== '1' || accountId <= 0) return
    setNewAccountId(accountId)
    setShowNew(true)
    void fetchCustomers().then((rows) => {
      const hit = rows.find((x: any) => Number(x.id) === accountId)
      if (hit) {
        setNewName(hit.name)
        let cf: Record<string, any> = {}
        try { cf = JSON.parse(hit.custom_fields || '{}') } catch { /* ignore */ }
        setNewBuyerAddr(String(cf.buyer_addr || ''))
        setNewBuyerBank(String(cf.buyer_bank || ''))
        setNewBuyerAccount(String(cf.buyer_account || ''))
        setNewBuyerTax(String(cf.tax_no || ''))
        setNewBuyerPhone(String(cf.buyer_phone || hit.phone || ''))
      }
      if (!products.length) void fetchProducts()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams])


  // 合同列表筛选（SearchTable 前端过滤）：状态 + 合同名关键字，变化时回到第 1 页
  const filteredContracts = workbench.filter((c: any) =>
    (!statusFilter || c.status === statusFilter) &&
    (!keyword.trim() || String(c.name || '').toLowerCase().includes(keyword.trim().toLowerCase())))
  // 数据收缩（删除/签约后刷新）时页码归位——SearchTable 显示层有钳制，但 state 残留会在数据回升后突然跳回高页码
  useEffect(() => {
    const maxPage = Math.max(1, Math.ceil(filteredContracts.length / 10))
    if (tablePage > maxPage) setTablePage(maxPage)
  }, [filteredContracts.length, tablePage])
  const contractColumns: Array<SearchTableColumn<any>> = [
    { key: 'name', title: '合同' },
    { key: 'amount', title: '金额', className: 'num', render: (c) => Number(c.amount ?? 0).toLocaleString() },
    { key: 'paid', title: '已确认回款', className: 'num', render: (c) => Number(c.paid ?? 0).toLocaleString() },
    { key: 'ratio', title: '全款进度', render: (c) => <div className="crm-progress"><div style={{ width: `${Math.round((c.paidRatio ?? 0) * 100)}%` }} /></div> },
    { key: 'status', title: '状态', render: (c) => <span className={`crm-pill crm-pill--${c.status === 'pending_sign' ? 'acc' : c.status === 'signed' ? 'ok' : 'neu'}`}>{CONTRACT_STATUS_MAP[c.status] || c.status}</span> },
    { key: 'warning', title: '预警', render: (c) => c.warning ? <span className="crm-pill crm-pill--bad">{c.warning}</span> : <span className="crm-pill crm-pill--neu">—</span> },
    { key: 'ops', title: '操作', render: (c) => (
      <span onClick={(e) => e.stopPropagation()}>
        {c.status === 'pending_sign' && <button className="crm-btn crm-btn--ghost" onClick={() => void sign(c)}><Handshake size={13} /> 签约</button>}
        {c.status === 'signed' && <button className="crm-btn crm-btn--ghost" onClick={() => void ship(c)}><Truck size={13} /> 发货</button>}
        <button className="crm-btn crm-btn--ghost" onClick={() => void genDoc('contract', c.id)}><FileText size={13} /> 合同</button>
        <button className="crm-btn crm-btn--ghost danger" onClick={() => void deleteContract(c)}><Trash2 size={13} /> 删除</button>
      </span>
    ) },
  ]

  const deleteContract = async (c: any) => {
    const ok = window.confirm(`确定删除合同「${c.name}」？\n将一并删除该合同的报价单、发票、物流、回款归属等子数据。\n（删除前会自动备份数据库）`)
    if (!ok) return
    const r = await window.electronAPI.crm.contractDelete(c.id)
    setNotice(r.ok ? `已删除合同「${c.name}」（含 ${r.removed ?? 0} 条子资源）` : `删除失败：${r.reason}`)
    if (r.ok) { await fetchWorkbench(); void fetchStats(); if (selected?.id === c.id) setSelected(null) }
  }

  const select = async (c: any) => {
    setSelected(c)
    setQuotations(await window.electronAPI.crm.list('quotation', { contract_id: c.id }))
    setInvoices(await window.electronAPI.crm.list('invoice', { contract_id: c.id }))
    setLogistics(await window.electronAPI.crm.list('logistics', { contract_id: c.id }))
    const allocs = await window.electronAPI.crm.list('allocation', { contract_id: c.id })
    setAllocations(allocs)
    // 甲方开票信息回填到编辑表单
    const cf = (() => { try { return JSON.parse(c.custom_fields || '{}') } catch { return {} } })()
    setEditAddr(cf.buyer_addr ?? '')
    setEditBank(cf.buyer_bank ?? '')
    setEditAccount(cf.buyer_account ?? '')
    setEditTax(cf.tax_no ?? '')
    setEditPhone(cf.buyer_phone ?? '')
  }

  const ship = async (c: any) => {
    const r = await window.electronAPI.crm.contractShip(c.id)
    setNotice(r.ok ? '已发货' : `拒绝发货：${r.reason}${r.gap != null ? `，缺口 ${r.gap}` : ''}`)
    await fetchWorkbench(); void fetchStats()
  }

  const sign = async (c: any) => {
    const r = await window.electronAPI.crm.contractSign(c.id)
    setNotice(r.ok ? '已签约' : `签约失败：${r.reason}`)
    if (r.ok) { await fetchWorkbench(); void fetchStats(); if (selected?.id === c.id) setSelected(null) }
  }

  const openQuotation = () => {
    if (!products.length) void fetchProducts()
    setQuoRows([])
    setQuoSearch('')
    setShowQuo(true)
  }

  const addQuoRow = (p: any) => {
    if (quoRows.some((r) => r.productId === p.id)) return
    setQuoRows((rs) => [...rs, { productId: p.id, name: p.name, price: Number(p.unit_price ?? 0), qty: '1' }])
  }

  const quoTotal = quoRows.reduce((s, r) => s + r.price * (parseFloat(r.qty) || 0), 0)

  // 新建合同：从产品库勾选型号（可多选，同产品去重），创建时自动生成报价单行项
  const addNewQuoRow = (p: any) => {
    if (newQuoItems.some((r) => r.productId === p.id)) return
    setNewQuoItems((rs) => [...rs, { productId: p.id, name: p.name, model: String(p.model || ''), price: Number(p.unit_price ?? 0), qty: '1' }])
  }
  const newQuoTotal = newQuoItems.reduce((s, r) => s + r.price * (parseFloat(r.qty) || 0), 0)

  const createQuotation = async () => {
    if (!selected) return
    const items = quoRows
      .filter((r) => (parseFloat(r.qty) || 0) > 0)
      .map((r) => ({ product_id: r.productId, qty: parseFloat(r.qty) || 0 }))
    if (!items.length) { setNotice('请至少添加一个产品行项'); return }
    const r = await window.electronAPI.crm.quotationCreate({ contract_id: selected.id, items })
    setNotice(r.ok ? '报价单已创建' : `创建失败：${r.reason}`)
    if (r.ok) { setShowQuo(false); await select(selected) }
  }

  const genDoc = async (type: string, id: number) => {
    const r = await window.electronAPI.crm.docGenerate(type, id)
    setNotice(r.ok ? `已生成：${r.path}` : `生成失败：${r.reason}`)
  }

  const createContract = async () => {
    // 手填金额优先；未填则取型号合计（勾选的型号创建时自动生成报价单行项）
    const manualAmount = parseFloat(newAmount)
    const amount = manualAmount > 0 ? manualAmount : newQuoTotal
    if (!newName.trim()) { setNotice('请填写客户名称'); return }
    // 甲方开票信息只写入非空字段（自动确认引擎也会写 tax_no，键一致）
    const custom_fields: Record<string, string> = {}
    if (newBuyerAddr.trim()) custom_fields.buyer_addr = newBuyerAddr.trim()
    if (newBuyerBank.trim()) custom_fields.buyer_bank = newBuyerBank.trim()
    if (newBuyerAccount.trim()) custom_fields.buyer_account = newBuyerAccount.trim()
    if (newBuyerTax.trim()) custom_fields.tax_no = newBuyerTax.trim()
    if (newBuyerPhone.trim()) custom_fields.buyer_phone = newBuyerPhone.trim()
    // 已选客户 → 直接挂到该客户（不重复建 account）；未选 → 新建
    let accountId = newAccountId
    if (!accountId) {
      accountId = await window.electronAPI.crm.create('account', { name: newName.trim(), created_at: Date.now(), updated_at: Date.now() })
    }
    const contractId = await window.electronAPI.crm.create('contract', { account_id: accountId, name: `${newName.trim()}-合同`, amount, status: 'pending_sign', custom_fields: JSON.stringify(custom_fields), created_at: Date.now(), updated_at: Date.now() })
    // 勾选的型号 → 自动生成报价单（行项单价取产品库）
    if (newQuoItems.length > 0) {
      await window.electronAPI.crm.quotationCreate({
        contract_id: contractId,
        items: newQuoItems.map((r) => ({ product_id: r.productId, qty: parseFloat(r.qty) || 1 }))
      })
    }
    setShowNew(false); setNewName(''); setNewAmount(''); setNewAccountId(0)
    setNewBuyerAddr(''); setNewBuyerBank(''); setNewBuyerAccount(''); setNewBuyerTax(''); setNewBuyerPhone('')
    setNewQuoItems([]); setNewQuoSearch('')
    await fetchWorkbench()
  }

  // 已建合同：保存/更新甲方开票信息（覆盖式写入 custom_fields）
  const saveInvoiceInfo = async () => {
    if (!selected) return
    const old = (() => { try { return JSON.parse(selected.custom_fields || '{}') } catch { return {} } })()
    const cf = { ...old, buyer_addr: editAddr.trim(), buyer_bank: editBank.trim(), buyer_account: editAccount.trim(), tax_no: editTax.trim(), buyer_phone: editPhone.trim() }
    await window.electronAPI.crm.update('contract', selected.id, { custom_fields: JSON.stringify(cf) })
    setNotice('甲方开票信息已保存，生成合同/开票申请单将使用新信息')
    setShowEditInvoice(false)
    await fetchWorkbench()
  }

  return (
    <div className="crm-workbench-page">
      <div className="crm-header">
        <h2><Briefcase size={18} /> 合同工作台</h2>
        <span className="crm-header__sub">合同闭环 · 报价 / 发货 / 回款 / 开票 · r7</span>
        <button className="crm-btn crm-btn--ghost" onClick={() => { void fetchStats(); void fetchAccuracy(); void fetchWorkbench() }}><RefreshCw size={14} /> 刷新</button>
        <button className="crm-btn crm-btn--primary" onClick={() => { setShowNew((v) => !v); if (!products.length) void fetchProducts() }}><Plus size={14} /> 新建合同</button>
      </div>
      {notice && <div className="crm-notice">{notice}</div>}
      {stats && (
        <>
          <div className="crm-stats-row">
            <div className="crm-stat-card"><span className="crm-stat-card__ico neu"><Users size={17} /></span><div className="crm-stat-card__body"><span className="crm-stat-card__value">{stats.customers}</span><span className="crm-stat-card__label">客户总数</span></div></div>
            <div className="crm-stat-card"><span className="crm-stat-card__ico"><Briefcase size={17} /></span><div className="crm-stat-card__body"><span className="crm-stat-card__value">¥{Number(stats.activeContractAmount || 0).toLocaleString()}</span><span className="crm-stat-card__label">在途合同（{stats.activeContractCount} 份）</span></div></div>
            <div className="crm-stat-card"><span className="crm-stat-card__ico ok"><Banknote size={17} /></span><div className="crm-stat-card__body"><span className="crm-stat-card__value">¥{Number(stats.monthPaid || 0).toLocaleString()}</span><span className="crm-stat-card__label">本月到账（已认领）</span></div></div>
            <div className="crm-stat-card crm-stat-card--alert"><span className="crm-stat-card__ico alert"><AlertTriangle size={17} /></span><div className="crm-stat-card__body"><span className="crm-stat-card__value">{stats.pendingReview}</span><span className="crm-stat-card__label">待确认事项</span></div></div>
          </div>
          <div className="crm-overview-charts">
            <div className="crm-chart-box"><h4>近 8 周到款趋势 <span className="crm-chart-hint">元 · 按 pay_time</span></h4>{paidTrendOption && <ReactECharts option={paidTrendOption} style={{ height: 190 }} notMerge />}</div>
            <div className="crm-chart-box"><h4>客户阶段分布 <span className="crm-chart-hint">customer_profile.stage</span></h4>{stageDistOption && <ReactECharts option={stageDistOption} style={{ height: 190 }} notMerge />}</div>
            <div className="crm-chart-box crm-accuracy-card">
              <h4>AI 准确率 <span className="crm-chart-hint">近 7 天</span></h4>
              {accuracy && (
                <>
                  <div className="crm-accuracy-card__grid">
                    <div><span className="crm-accuracy-card__num">{accuracy.acceptRate == null ? '-' : `${accuracy.acceptRate}%`}</span><span className="crm-accuracy-card__label">采纳率</span></div>
                    <div><span className="crm-accuracy-card__num">{accuracy.enrichAuto}</span><span className="crm-accuracy-card__label">AI 自动写入</span></div>
                    <div><span className="crm-accuracy-card__num">{accuracy.infoAccept}</span><span className="crm-accuracy-card__label">待确认采纳</span></div>
                    <div><span className="crm-accuracy-card__num">{accuracy.manualEdit}</span><span className="crm-accuracy-card__label">手动修正</span></div>
                  </div>
                  <button className="crm-accuracy-card__toggle" onClick={() => setAccuracyOpen((v) => !v)}>
                    {accuracyOpen ? '收起明细 ▲' : '展开明细 ▼'}
                  </button>
                  {accuracyOpen && (
                    <div className="crm-accuracy__grid">
                      <div className="crm-accuracy__item"><span className="crm-accuracy__value">{accuracy.infoReject}</span><span className="crm-accuracy__label">待确认放弃</span></div>
                      <div className="crm-accuracy__item"><span className="crm-accuracy__value">{accuracy.writtenTotal > 0 ? `${accuracy.correctionRate}%` : '-'}</span><span className="crm-accuracy__label">修正率（越低越准）</span></div>
                      <div className="crm-accuracy__item"><span className="crm-accuracy__value">{accuracy.quoteTotal}</span><span className="crm-accuracy__label">报价信号</span></div>
                      <div className="crm-accuracy__item"><span className="crm-accuracy__value">{accuracy.quoteReplied24}/{accuracy.quoteReplied}</span><span className="crm-accuracy__label">24h 内回复/总回复</span></div>
                      <div className="crm-accuracy__item"><span className="crm-accuracy__value">{accuracy.quotePending}</span><span className="crm-accuracy__label">报价待跟进</span></div>
                    </div>
                  )}
                </>
              )}
              {!accuracy && <div className="crm-chart-empty">近 7 天暂无 AI 写入数据</div>}
            </div>
          </div>
        </>
      )}
      {showNew && (
        <div className="crm-new-form">
          <select value={newAccountId} onChange={(e) => {
            const id = Number(e.target.value)
            setNewAccountId(id)
            const c = customers.find((x) => Number(x.id) === id)
            if (c) {
              setNewName(c.name)
              let cf: Record<string, any> = {}
              try { cf = JSON.parse(c.custom_fields || '{}') } catch { /* ignore */ }
              setNewBuyerAddr(String(cf.buyer_addr || ''))
              setNewBuyerBank(String(cf.buyer_bank || ''))
              setNewBuyerAccount(String(cf.buyer_account || ''))
              setNewBuyerTax(String(cf.tax_no || ''))
              setNewBuyerPhone(String(cf.buyer_phone || c.phone || ''))
            }
          }}>
            <option value={0}>选择已有客户（自动带出名称与开票信息）…</option>
            {customers.map((c) => <option key={c.id} value={c.id}>{displayNameOf(c)}{c.company ? ` · ${c.company}` : ''}</option>)}
          </select>
          <input placeholder="客户名称" value={newName} onChange={(e) => setNewName(e.target.value)} />
          <input placeholder="合同金额（未填则取型号合计）" value={newAmount} onChange={(e) => setNewAmount(e.target.value)} />
          <span className="crm-new-form__divider">型号（从产品库选，可多选；创建即生成报价单）</span>
          <div className="crm-new-form__quotes">
            <input className="crm-new-form__search" placeholder="搜索产品/型号…" value={newQuoSearch} onChange={(e) => setNewQuoSearch(e.target.value)} />
            {products.length === 0 ? (
              <div className="quo-total">产品库为空，请先到「型号库」添加产品</div>
            ) : (
              <div className="quo-list">
                {products
                  .filter((p) => {
                    const q = newQuoSearch.trim().toLowerCase()
                    if (!q) return true
                    return String(p.name || '').toLowerCase().includes(q) || String(p.model || '').toLowerCase().includes(q)
                  })
                  .slice(0, 20)
                  .map((p) => (
                    <div key={p.id} className="quo-item">
                      <span>{p.name}{p.model ? ` · ${p.model}` : ''} · ¥{Number(p.unit_price ?? 0).toLocaleString()}</span>
                      <button className="crm-btn" onClick={() => addNewQuoRow(p)} disabled={newQuoItems.some((r) => r.productId === p.id)}>添加</button>
                    </div>
                  ))}
              </div>
            )}
            {newQuoItems.map((r) => (
              <div key={r.productId} className="quo-item">
                <span>{r.name}{r.model ? ` · ${r.model}` : ''} · ¥{r.price.toLocaleString()}</span>
                <input type="number" min="1" value={r.qty}
                  onChange={(e) => setNewQuoItems((rs) => rs.map((x) => x.productId === r.productId ? { ...x, qty: e.target.value } : x))} />
                <button className="crm-btn" onClick={() => setNewQuoItems((rs) => rs.filter((x) => x.productId !== r.productId))}><X size={12} /></button>
              </div>
            ))}
            {newQuoItems.length > 0 && (
              <div className="crm-new-form__total">型号合计 ¥{newQuoTotal.toLocaleString()}（未填金额时作为合同金额，可改）</div>
            )}
          </div>
          <span className="crm-new-form__divider">甲方开票信息（选填，用于生成合同/开票申请单）</span>
          <input placeholder="单位地址" value={newBuyerAddr} onChange={(e) => setNewBuyerAddr(e.target.value)} />
          <input placeholder="开户银行" value={newBuyerBank} onChange={(e) => setNewBuyerBank(e.target.value)} />
          <input placeholder="银行账号" value={newBuyerAccount} onChange={(e) => setNewBuyerAccount(e.target.value)} />
          <input placeholder="税号" value={newBuyerTax} onChange={(e) => setNewBuyerTax(e.target.value)} />
          <input placeholder="电话" value={newBuyerPhone} onChange={(e) => setNewBuyerPhone(e.target.value)} />
          <button className="crm-btn primary" onClick={() => void createContract()}>创建</button>
        </div>
      )}
      {stats && (
        <div className="crm-pipeline-strip">
          {(stats.pipeline || []).map((p: any) => (
            <span key={p.status} className="crm-pill crm-pill--neu">{CONTRACT_STATUS_MAP[p.status] || p.status} {p.count} 份 · ¥{Number(p.amount || 0).toLocaleString()}</span>
          ))}
        </div>
      )}
      <SearchTable
        columns={contractColumns}
        data={filteredContracts}
        rowKey={(c) => c.id}
        page={tablePage}
        onPageChange={setTablePage}
        filterBar={
          <>
            <select value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setTablePage(1) }}>
              <option value="">全部状态</option>
              <option value="pending_sign">待签约</option>
              <option value="signed">已签约</option>
              <option value="shipped">已发货</option>
            </select>
            <input placeholder="搜索合同名" value={keyword}
              onChange={(e) => { setKeyword(e.target.value); setTablePage(1) }} />
          </>
        }
        onRowClick={(c) => void select(c)}
        rowClassName={(c) => (selected?.id === c.id ? 'active' : '')}
        emptyText="暂无合同（点「新建合同」创建）"
      />

      {selected && (
        <div className="crm-detail">
          <h3>{selected.name} · 子资源</h3>
          <div className="crm-tabs">
            <div><h4>报价单 <button className="crm-btn" onClick={() => void openQuotation()}><Plus size={12} /> 新建</button></h4>{quotations.map((q) => (
              <div key={q.id} className="crm-row">合计 {Number(q.total).toLocaleString()} <button className="crm-btn" onClick={() => void genDoc('quotation', q.id)}>生成</button></div>
            ))}</div>
            <div><h4>发票</h4>{invoices.map((i) => (
              <div key={i.id} className="crm-row">{i.invoice_no ?? '(待开票)'} {i.buyer} {Number(i.amount).toLocaleString()}</div>
            ))}</div>
            <div><h4>回款归属</h4>{allocations.map((a) => (
              <div key={a.id} className="crm-row">{a.customer_hint} {Number(a.credited_amount).toLocaleString()} [{a.status}] {a.sales_name ?? a.sales_hint ?? ''}</div>
            ))}</div>
            <div><h4>物流</h4>{logistics.map((l) => (
              <div key={l.id} className="crm-row">{l.tracking_no} {l.receiver} {l.city} [{l.link_status}]</div>
            ))}</div>
          </div>

          <div className="crm-invoice-edit">
            <button className="crm-btn" onClick={() => setShowEditInvoice((v) => !v)}>
              <FileText size={13} /> {showEditInvoice ? '收起开票信息' : '甲方开票信息'}
            </button>
            {showEditInvoice && (
              <div className="crm-invoice-edit__grid">
                <input placeholder="单位地址" value={editAddr} onChange={(e) => setEditAddr(e.target.value)} />
                <input placeholder="开户银行" value={editBank} onChange={(e) => setEditBank(e.target.value)} />
                <input placeholder="银行账号" value={editAccount} onChange={(e) => setEditAccount(e.target.value)} />
                <input placeholder="税号" value={editTax} onChange={(e) => setEditTax(e.target.value)} />
                <input placeholder="电话" value={editPhone} onChange={(e) => setEditPhone(e.target.value)} />
                <button className="crm-btn primary" onClick={() => void saveInvoiceInfo()}>保存开票信息</button>
              </div>
            )}
          </div>
        </div>
      )}

      {showQuo && selected && (
        <div className="crm-modal">
          <div className="crm-modal-body">
            <h3>新建报价单 · {selected.name} <button className="crm-btn" onClick={() => setShowQuo(false)}><X size={14} /></button></h3>
            <input className="crm-search" placeholder="搜索产品…" value={quoSearch} onChange={(e) => setQuoSearch(e.target.value)} />
            <div className="quo-list">
              {products
                .filter((p) => !quoRows.some((r) => r.productId === p.id))
                .filter((p) => {
                  const q = quoSearch.trim().toLowerCase()
                  if (!q) return true
                  return String(p.name || '').toLowerCase().includes(q) || String(p.model || '').toLowerCase().includes(q)
                })
                .slice(0, 20)
                .map((p) => (
                  <div key={p.id} className="quo-item">
                    <span>{p.name} · ¥{Number(p.unit_price ?? 0).toLocaleString()}</span>
                    <button className="crm-btn" onClick={() => addQuoRow(p)}>添加</button>
                  </div>
                ))}
            </div>
            <div className="quo-rows">
              {quoRows.map((r) => (
                <div key={r.productId} className="quo-item">
                  <span>{r.name} · ¥{r.price.toLocaleString()}</span>
                  <input type="number" min="1" value={r.qty}
                    onChange={(e) => setQuoRows((rs) => rs.map((x) => x.productId === r.productId ? { ...x, qty: e.target.value } : x))} />
                  <button className="crm-btn" onClick={() => setQuoRows((rs) => rs.filter((x) => x.productId !== r.productId))}><X size={12} /></button>
                </div>
              ))}
            </div>
            <div className="form-actions">
              <span className="quo-total">合计 ¥{quoTotal.toLocaleString()}</span>
              <button className="crm-btn primary" onClick={() => void createQuotation()}>创建报价单</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
