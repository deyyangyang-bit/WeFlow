/**
 * CrmWorkbenchPage.tsx —— CRM 工作台：合同列表+全款进度+四子资源+发货卡点+文档生成
 */
import { useEffect, useState } from 'react'
import { Briefcase, FileText, RefreshCw, Truck, Plus, Handshake, X, Sparkles, Trash2, MessageCircle } from 'lucide-react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import ReactECharts from 'echarts-for-react'
import { useCrmStore } from '../stores/crmStore'
import './CrmWorkbenchPage.scss'

interface QuoRow { productId: number; name: string; model?: string; price: number; qty: string }

const STAGE_LABELS: Record<string, string> = {
  contacted: '已沟通', quoted: '已报价', negotiating: '谈判中', won: '已成交', new: '新客', unknown: '未知'
}

export default function CrmWorkbenchPage() {
  const { workbench, fetchWorkbench, notice, setNotice, products, fetchProducts } = useCrmStore()
  const navigate = useNavigate()
  // 打开聊天：跳转到该客户的微信聊天页（需关联了微信会话 session_id）
  const openChat = (c: any) => {
    if (!c.session_id) { setNotice('该客户未关联微信会话，无法打开聊天'); return }
    navigate(`/chat?sessionId=${encodeURIComponent(c.session_id)}`)
  }
  const [tab, setTab] = useState<'contracts' | 'customers'>('contracts')
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
  const [selectedCustomer, setSelectedCustomer] = useState<any>(null)
  const [customerProfile, setCustomerProfile] = useState<any>(null)
  const [profileLoading, setProfileLoading] = useState(false)
  const [deepReport, setDeepReport] = useState('')
  const [deepLoading, setDeepLoading] = useState(false)
  const [stageFilter, setStageFilter] = useState('')

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
  const [accuracyOpen, setAccuracyOpen] = useState(false)
  const fetchAccuracy = async () => {
    try { setAccuracy(await window.electronAPI.crm.statsAiAccuracy(7)) } catch { /* ignore */ }
  }
  useEffect(() => { void fetchAccuracy() }, [])
  const STAGE_LABEL_MAP: Record<string, string> = {
    contacted: '已沟通', quoted: '已报价', negotiating: '谈判中', won: '已成交', new: '新客', unknown: '未分类'
  }
  const CONTRACT_STATUS_MAP: Record<string, string> = { pending_sign: '待签约', signed: '已签约', shipped: '已发货' }
  const paidTrendOption = stats ? {
    tooltip: { trigger: 'axis' as const },
    grid: { left: 48, right: 16, top: 24, bottom: 24 },
    xAxis: { type: 'category' as const, data: stats.paidWeekly.map((w: any) => w.week), axisLabel: { fontSize: 11 } },
    yAxis: { type: 'value' as const, axisLabel: { fontSize: 11 } },
    series: [{ type: 'bar', data: stats.paidWeekly.map((w: any) => w.amount), itemStyle: { color: '#16a34a', borderRadius: [3, 3, 0, 0] }, barMaxWidth: 22 }]
  } : null
  const stageDistOption = stats ? {
    tooltip: { trigger: 'item' as const },
    series: [{
      type: 'pie', radius: ['38%', '68%'], center: ['50%', '52%'],
      label: { fontSize: 11 },
      data: stats.stageDist.map((s: any) => ({ name: STAGE_LABEL_MAP[s.stage] || s.stage, value: s.count }))
    }]
  } : null
  const pipelineOption = stats ? {
    tooltip: { trigger: 'axis' as const, formatter: (ps: any) => { const p = ps[0]; const row = stats.pipeline[p.dataIndex]; return `${p.name}<br/>金额 ¥${Number(p.value).toLocaleString()}<br/>合同 ${row?.count ?? 0} 份` } },
    grid: { left: 56, right: 16, top: 24, bottom: 24 },
    xAxis: { type: 'category' as const, data: stats.pipeline.map((p: any) => CONTRACT_STATUS_MAP[p.status] || p.status), axisLabel: { fontSize: 11 } },
    yAxis: { type: 'value' as const, axisLabel: { fontSize: 11 } },
    series: [{ type: 'bar', data: stats.pipeline.map((p: any) => p.amount), itemStyle: { color: '#2563eb', borderRadius: [3, 3, 0, 0] }, barMaxWidth: 34 }]
  } : null


  const fetchCustomers = async () => {
    const rows = (await window.electronAPI.crm.customers()) || []
    setCustomers(rows)
    return rows
  }

  // 深链协议：/crm?tab=customer&id=<accountId>（灵感信箱/跟单中心/行动卡跳入）
  const [searchParams] = useSearchParams()
  useEffect(() => {
    const t = searchParams.get('tab')
    const id = Number(searchParams.get('id') || 0)
    if (t === 'customer' && id > 0) {
      setTab('customers')
      void fetchCustomers().then((rows) => {
        const hit = rows.find((x: any) => Number(x.id) === id)
        if (hit) void openCustomer(hit)
      })
    }
    // 行动卡深链：/crm?tab=customer&sid=<sessionId>（按微信会话定位客户）
    const sid = searchParams.get('sid')
    if (t === 'customer' && !(id > 0) && sid) {
      setTab('customers')
      void fetchCustomers().then((rows) => {
        const hit = rows.find((x: any) => String(x.session_id || '') === sid)
        if (hit) void openCustomer(hit)
        else setNotice('该客户尚未导入 CRM（AI 判定有意向后会自动导入）')
      })
    }
    // 漏斗下钻深链：/crm?tab=customer&stage=比价（customer_profile.stage 中文漏斗阶段，与漏斗同源）
    const stage = searchParams.get('stage')
    if (t === 'customer' && stage) {
      setTab('customers')
      setStageFilter(stage)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams])

  // 阶段优先取 customer_profile.stage（中文漏斗阶段，与销售漏斗同源），无画像时回退 sales_stage 标签
  const stageLabel = (c: any) => String(c.profile_stage || '') || STAGE_LABELS[String(c.sales_stage ?? '')] || String(c.sales_stage ?? '') || '未分类'
  // 筛选项由当前数据动态生成，未来出现新阶段也能自动出现
  const stageOptions = Array.from(new Set(customers.map(stageLabel))).sort((a, b) => a.localeCompare(b, 'zh'))
  const filteredCustomers = stageFilter ? customers.filter((c) => stageLabel(c) === stageFilter) : customers

  const openCustomer = async (c: any) => {
    setSelectedCustomer(c)
    setCustomerProfile(null)
    if (!c.session_id) return
    setProfileLoading(true)
    try {
      const r = await window.electronAPI.crm.customerProfile(String(c.session_id))
      if (r?.success) setCustomerProfile(r.data)
    } catch { /* ignore */ }
    setProfileLoading(false)
  }


  // ─── 客户 360：AI 填充字段视图 + 手动编辑 + 时间线 ─────────────────────────
  const FIELD_LABELS_WB: Record<string, string> = {
    company: '公司', position: '职位', phone: '电话', industry: '行业', province: '省份', city: '城市',
    needs: '需求', budget: '预算', intent_model: '意向型号', purchase_timeframe: '采购时间',
    competitor: '竞品', price_sensitive: '价格敏感度'
  }
  const ENRICH_FIELD_ORDER = ['company', 'position', 'phone', 'industry', 'province', 'city', 'needs', 'budget', 'intent_model', 'purchase_timeframe', 'competitor', 'price_sensitive']
  const FORMAL_SET = new Set(['company', 'position', 'phone', 'industry', 'province', 'city'])

  const accountFieldView = (acc: any) => {
    let cf: Record<string, any> = {}
    try { cf = JSON.parse(acc?.custom_fields || '{}') } catch { /* ignore */ }
    let meta: any = {}
    try { meta = JSON.parse(acc?.enrich_meta || '{}') } catch { /* ignore */ }
    return ENRICH_FIELD_ORDER.map((f) => {
      const raw = FORMAL_SET.has(f) ? acc?.[f] : cf[f]
      return {
        field: f, label: FIELD_LABELS_WB[f],
        value: raw == null ? '' : String(raw),
        source: meta.fields?.[f]?.source as string | undefined,
        confidence: meta.fields?.[f]?.confidence as number | undefined,
        evidence: meta.fields?.[f]?.evidence as string | undefined,
        locked: Boolean(meta.fields?.[f]?.locked)
      }
    })
  }
  const [editingField, setEditingField] = useState('')
  const [editingValue, setEditingValue] = useState('')
  const saveFieldManual = async (field: string) => {
    const accId = Number(customerProfile?.account?.id || 0)
    if (!accId) return
    const r = await window.electronAPI.crm.manualSet(accId, field, editingValue)
    setNotice(r.ok ? '已保存（该字段已锁定，AI 不再覆盖）' : `保存失败：${r.reason}`)
    setEditingField('')
    if (selectedCustomer) await openCustomer(selectedCustomer)
  }
  const runEnrichOne = async (c: any) => {
    if (!c.session_id) { setNotice('该客户未关联微信会话，无法 AI 补全'); return }
    setNotice(`AI 正在补全 ${c.name}…`)
    const r = await window.electronAPI.crm.enrichRun(String(c.session_id), c.name)
    setNotice(r.ok ? `${c.name}：自动写入 ${(r.updated || []).length} 项${(r.pending || []).length ? `，${(r.pending || []).length} 项待跟单中心裁决` : ''}${r.reason && !(r.updated || []).length ? `（${r.reason}）` : ''}` : `AI 补全失败：${r.reason}`)
    await fetchCustomers()
    if (selectedCustomer?.id === c.id) await openCustomer(c)
  }
  const [backfilling, setBackfilling] = useState(false)
  const runBackfill = async () => {
    setBackfilling(true)
    setNotice('批量 AI 补全进行中（串行执行，可能需要一两分钟）…')
    try {
      const r = await window.electronAPI.crm.enrichBackfill()
      setNotice(`批量 AI 补全完成：处理 ${r.processed} 个客户，有更新 ${r.updated}，失败 ${r.failed}`)
    } catch (e) { setNotice(`批量补全失败：${e}`) }
    setBackfilling(false)
    await fetchCustomers()
  }

  const createContractForCustomer = (c: any) => {
    setSelected(null)
    setTab('contracts')
    setNewAccountId(Number(c.id))
    setNewName(c.name)
    setNewAmount('')
    // 甲方开票信息自动带出（account.custom_fields 已有则回填）
    let cf: Record<string, any> = {}
    try { cf = JSON.parse(c.custom_fields || '{}') } catch { /* ignore */ }
    setNewBuyerAddr(String(cf.buyer_addr || ''))
    setNewBuyerBank(String(cf.buyer_bank || ''))
    setNewBuyerAccount(String(cf.buyer_account || ''))
    setNewBuyerTax(String(cf.tax_no || ''))
    setNewBuyerPhone(String(cf.buyer_phone || c.phone || ''))
    if (!products.length) void fetchProducts()
    setShowNew(true)
  }

  const genDeepAnalysis = async (c: any) => {
    if (!c.session_id) { setNotice('该客户未关联微信会话，无法深度分析'); return }
    setDeepLoading(true)
    setDeepReport('')
    const r = await window.electronAPI.crm.customerDeepAnalysis(String(c.session_id), c.name)
    setDeepLoading(false)
    if (r.ok && r.report) setDeepReport(r.report)
    else setNotice(`深度分析失败：${r.reason}`)
  }

  // 列表行直接触发：先展开档案（让报告有展示位置），再发起深度分析
  const genDeepAnalysisFromList = (c: any) => {
    if (!c.session_id) { setNotice('该客户未关联微信会话，无法深度分析'); return }
    void openCustomer(c).then(() => genDeepAnalysis(c))
  }

  const deleteContract = async (c: any) => {
    const ok = window.confirm(`确定删除合同「${c.name}」？\n将一并删除该合同的报价单、发票、物流、回款归属等子数据。\n（删除前会自动备份数据库）`)
    if (!ok) return
    const r = await window.electronAPI.crm.contractDelete(c.id)
    setNotice(r.ok ? `已删除合同「${c.name}」（含 ${r.removed ?? 0} 条子资源）` : `删除失败：${r.reason}`)
    if (r.ok) { await fetchWorkbench(); void fetchStats(); if (selected?.id === c.id) setSelected(null) }
  }

  const deleteCustomer = async (c: any) => {
    const ok = window.confirm(`确定删除客户「${c.name}」？\n将一并删除该客户的全部合同及其报价单、发票、物流、回款归属等数据。\n（删除前会自动备份数据库）`)
    if (!ok) return
    const r = await window.electronAPI.crm.customerDelete(c.id)
    setNotice(r.ok ? `已删除客户「${c.name}」` : `删除失败：${r.reason}`)
    if (r.ok) { await fetchCustomers(); if (selectedCustomer?.id === c.id) setSelectedCustomer(null) }
  }

  const genAiQuotation = async (c: any) => {
    if (!c.session_id) { setNotice('该客户未关联微信会话，无法 AI 报价'); return }
    setNotice('AI 正在提取需求并选型…')
    const r = await window.electronAPI.crm.quotationAi(String(c.session_id), c.name)
    if (r.ok) {
      setNotice(`AI 报价单已生成（${r.matched?.map((m) => m.productName).join('、') || ''}）`)
      if (selected?.id === c.id) await select(selected)
    } else {
      setNotice(`AI 报价失败：${r.reason}`)
    }
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
        <h2><Briefcase size={18} /> CRM 工作台</h2>
        <div className="crm-tabs">
          <button className={`crm-tab ${tab === 'contracts' ? 'active' : ''}`} onClick={() => setTab('contracts')}>合同 ({workbench.length})</button>
          <button className={`crm-tab ${tab === 'customers' ? 'active' : ''}`} onClick={() => void fetchCustomers().then(() => setTab('customers'))}>客户 ({customers.length})</button>
        </div>
        <button className="crm-btn" onClick={() => { void fetchStats(); void fetchAccuracy(); if (tab === 'contracts') void fetchWorkbench(); else void fetchCustomers() }}><RefreshCw size={14} /> 刷新</button>
        <button className="crm-btn" onClick={() => { setShowNew((v) => !v); if (!products.length) void fetchProducts() }}><Plus size={14} /> 新建合同</button>
      </div>
      {notice && <div className="crm-notice">{notice}</div>}
      {stats && (
        <>
          <div className="crm-stats-row">
            <div className="crm-stat-card"><span className="crm-stat-card__value">{stats.customers}</span><span className="crm-stat-card__label">客户总数</span></div>
            <div className="crm-stat-card"><span className="crm-stat-card__value">¥{Number(stats.activeContractAmount || 0).toLocaleString()}</span><span className="crm-stat-card__label">在途合同（{stats.activeContractCount} 份）</span></div>
            <div className="crm-stat-card"><span className="crm-stat-card__value">¥{Number(stats.monthPaid || 0).toLocaleString()}</span><span className="crm-stat-card__label">本月已确认到款</span></div>
            <div className="crm-stat-card crm-stat-card--alert"><span className="crm-stat-card__value">{stats.pendingReview}</span><span className="crm-stat-card__label">待确认事项</span></div>
          </div>
          <div className="crm-overview-charts">
            <div className="crm-chart-box"><h4>近 8 周到款趋势</h4>{paidTrendOption && <ReactECharts option={paidTrendOption} style={{ height: 190 }} notMerge />}</div>
            <div className="crm-chart-box"><h4>客户阶段分布</h4>{stageDistOption && <ReactECharts option={stageDistOption} style={{ height: 190 }} notMerge />}</div>
            <div className="crm-chart-box"><h4>合同管道（金额）</h4>{pipelineOption && <ReactECharts option={pipelineOption} style={{ height: 190 }} notMerge />}</div>
          </div>
          <div className="crm-accuracy">
            <button className="crm-accuracy__head" onClick={() => setAccuracyOpen((v) => !v)}>
              <span>📊 AI 准确率（近 7 天）</span>
              <span className="crm-accuracy__toggle">{accuracyOpen ? '收起 ▲' : '展开 ▼'}</span>
            </button>
            {accuracyOpen && accuracy && (
              <div className="crm-accuracy__grid">
                <div className="crm-accuracy__item"><span className="crm-accuracy__value">{accuracy.enrichAuto}</span><span className="crm-accuracy__label">AI 自动写入字段</span></div>
                <div className="crm-accuracy__item"><span className="crm-accuracy__value">{accuracy.infoAccept}</span><span className="crm-accuracy__label">待确认采纳</span></div>
                <div className="crm-accuracy__item"><span className="crm-accuracy__value">{accuracy.infoReject}</span><span className="crm-accuracy__label">待确认放弃</span></div>
                <div className="crm-accuracy__item"><span className="crm-accuracy__value">{accuracy.acceptRate == null ? '-' : `${accuracy.acceptRate}%`}</span><span className="crm-accuracy__label">采纳率</span></div>
                <div className="crm-accuracy__item"><span className="crm-accuracy__value">{accuracy.manualEdit}</span><span className="crm-accuracy__label">手动修正字段</span></div>
                <div className="crm-accuracy__item"><span className="crm-accuracy__value">{accuracy.writtenTotal > 0 ? `${accuracy.correctionRate}%` : '-'}</span><span className="crm-accuracy__label">修正率（越低越准）</span></div>
                <div className="crm-accuracy__item"><span className="crm-accuracy__value">{accuracy.quoteTotal}</span><span className="crm-accuracy__label">报价信号</span></div>
                <div className="crm-accuracy__item"><span className="crm-accuracy__value">{accuracy.quoteReplied24}/{accuracy.quoteReplied}</span><span className="crm-accuracy__label">24h 内回复/总回复</span></div>
                <div className="crm-accuracy__item"><span className="crm-accuracy__value">{accuracy.quotePending}</span><span className="crm-accuracy__label">报价待跟进</span></div>
              </div>
            )}
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
            {customers.map((c) => <option key={c.id} value={c.id}>{c.name}{c.company ? ` · ${c.company}` : ''}</option>)}
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
      {tab === 'contracts' && (<table className="crm-table">
        <thead><tr><th>合同</th><th>金额</th><th>已确认回款</th><th>全款进度</th><th>状态</th><th>预警</th><th>操作</th></tr></thead>
        <tbody>
          {workbench.map((c) => (
            <tr key={c.id} className={selected?.id === c.id ? 'active' : ''} onClick={() => void select(c)}>
              <td>{c.name}</td>
              <td>{Number(c.amount ?? 0).toLocaleString()}</td>
              <td>{Number(c.paid ?? 0).toLocaleString()}</td>
              <td><div className="crm-progress"><div style={{ width: `${Math.round((c.paidRatio ?? 0) * 100)}%` }} /></div></td>
              <td>{c.status === 'pending_sign' ? '待签约' : c.status === 'signed' ? '已签约' : '已发货'}</td>
              <td className={c.warning ? 'warn' : ''}>{c.warning ?? ''}</td>
              <td onClick={(e) => e.stopPropagation()}>
                {c.status === 'pending_sign' && <button className="crm-btn" onClick={() => void sign(c)}><Handshake size={13} /> 签约</button>}
                {c.status === 'signed' && <button className="crm-btn" onClick={() => void ship(c)}><Truck size={13} /> 发货</button>}
                <button className="crm-btn" onClick={() => void genDoc('contract', c.id)}><FileText size={13} /> 合同</button>
                <button className="crm-btn danger" onClick={() => void deleteContract(c)}><Trash2 size={13} /> 删除</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>)}

      {tab === 'customers' && (
        <>
          <div className="crm-filter-bar">
            <select className="crm-filter-select" value={stageFilter} onChange={(e) => setStageFilter(e.target.value)}>
              <option value="">全部阶段</option>
              {stageOptions.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <span className="crm-filter-count">共 {filteredCustomers.length} / {customers.length} 个客户</span>
            <button className="crm-btn crm-filter-backfill" onClick={() => void runBackfill()} disabled={backfilling}>
              <Sparkles size={13} /> {backfilling ? 'AI 补全中…' : '批量 AI 补全'}
            </button>
          </div>
          <table className="crm-table">
            <thead><tr><th>客户</th><th>公司</th><th>AI 阶段</th><th>AI 填充度</th><th>合同</th><th>累计回款</th><th>导入时间</th><th>操作</th></tr></thead>
            <tbody>
              {filteredCustomers.map((c) => (
                <tr key={c.id} className={selectedCustomer?.id === c.id ? 'active' : ''} onClick={() => void openCustomer(c)}>
                  <td>{c.name}{c.session_id ? <span className="crm-badge">AI</span> : ''}</td>
                  <td>{c.company || <span className="crm-muted">-</span>}</td>
                  <td>{stageLabel(c)}</td>
                  <td><span className={`crm-fill ${(c.enrich_filled ?? 0) >= 6 ? 'crm-fill--hi' : (c.enrich_filled ?? 0) >= 3 ? 'crm-fill--mid' : 'crm-fill--lo'}`}>{c.enrich_filled ?? 0}/{c.enrich_total ?? 12}</span></td>
                  <td>{c.contract_count}</td>
                  <td>{Number(c.credited_total ?? 0).toLocaleString()}</td>
                  <td>{c.imported_at ? new Date(Number(c.imported_at)).toLocaleDateString('zh-CN') : '-'}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <button className="crm-btn" onClick={() => void openChat(c)} disabled={!c.session_id}><MessageCircle size={13} /> 打开聊天</button>
                    <button className="crm-btn" onClick={() => void runEnrichOne(c)} disabled={!c.session_id}><Sparkles size={13} /> AI 补全</button>
                    <button className="crm-btn" onClick={() => void genDeepAnalysisFromList(c)}><Sparkles size={13} /> 深度分析</button>
                    <button className="crm-btn" onClick={() => void createContractForCustomer(c)}><Plus size={13} /> 建合同</button>
                    <button className="crm-btn danger" onClick={() => void deleteCustomer(c)}><Trash2 size={13} /> 删除</button>
                  </td>
                </tr>
              ))}
              {filteredCustomers.length === 0 && (
                <tr><td colSpan={8} className="crm-empty">
                  {customers.length === 0 ? '暂无客户 —— 在「设置 → AI 画像」生成客户画像后，有意向的客户会自动导入这里' : '该阶段暂无客户'}
                </td></tr>
              )}
            </tbody>
          </table>

          {selectedCustomer && (
            <div className="crm-detail">
              <div className="crm-detail-head">
                <h3>{selectedCustomer.name} · 客户档案</h3>
                <div className="crm-detail-actions">
                  <button className="crm-btn" onClick={() => void openChat(selectedCustomer)} disabled={!selectedCustomer.session_id}><MessageCircle size={14} /> 打开聊天</button>
                  <button className="crm-btn" onClick={() => void runEnrichOne(selectedCustomer)} disabled={!selectedCustomer.session_id}><Sparkles size={13} /> AI 补全</button>
                  <button className="crm-btn" onClick={() => void genDeepAnalysis(selectedCustomer)}><Sparkles size={13} /> {deepLoading ? '分析中…' : '深度分析'}</button>
                  <button className="crm-btn" onClick={() => void genAiQuotation(selectedCustomer)}><Sparkles size={13} /> AI 报价</button>
                  <button className="crm-btn primary" onClick={() => void createContractForCustomer(selectedCustomer)}><Plus size={14} /> 建合同</button>
                </div>
              </div>
              {profileLoading && <div className="crm-insight">加载档案…</div>}
              {!selectedCustomer.session_id && <div className="crm-insight">（未关联微信会话，无 AI 档案）</div>}
              {!profileLoading && selectedCustomer.session_id && customerProfile && (
                <div className="crm-profile">
                  <div className="crm-profile__section">
                    <h4>客户信息 <span className="crm-profile__hint">点击字段可编辑，手改后 AI 不再覆盖</span></h4>
                    <div className="crm-field-grid">
                      {accountFieldView(customerProfile.account).map((f) => (
                        <div key={f.field} className={`crm-field ${f.value ? '' : 'crm-field--empty'}`}>
                          <div className="crm-field__head">
                            <span className="crm-field__label">{f.label}</span>
                            {f.value && f.source === 'ai' && (
                              <span className="crm-field__badge crm-field__badge--ai" title={f.evidence ? `AI 提取 · 证据「${f.evidence}」` : 'AI 提取'}>
                                🤖 {Math.round((f.confidence ?? 0) * 100)}%
                              </span>
                            )}
                            {f.value && f.source === 'manual' && <span className="crm-field__badge crm-field__badge--manual">✍️ 手动</span>}
                          </div>
                          {editingField === f.field ? (
                            <div className="crm-field__edit">
                              <input autoFocus value={editingValue} onChange={(e) => setEditingValue(e.target.value)}
                                onKeyDown={(e) => { if (e.key === 'Enter') void saveFieldManual(f.field); if (e.key === 'Escape') setEditingField('') }} />
                              <button className="crm-btn primary" onClick={() => void saveFieldManual(f.field)}>保存</button>
                              <button className="crm-btn" onClick={() => setEditingField('')}>取消</button>
                            </div>
                          ) : (
                            <div className="crm-field__value" onClick={() => { setEditingField(f.field); setEditingValue(f.value) }}
                              title={f.evidence ? `证据「${f.evidence}」` : '点击编辑'}>
                              {f.value || '未提取'}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                  {(customerProfile.activities?.length > 0 || customerProfile.insights?.length > 0) && (
                    <div className="crm-profile__section">
                      <h4>动态时间线</h4>
                      <div className="crm-timeline">
                        {[
                          ...(customerProfile.activities || []).map((a: any) => ({ at: Number(a.created_at || 0), kind: 'crm', text: `${a.detail || a.action}` })),
                          ...(customerProfile.insights || []).map((i: any) => ({ at: Number(i.createdAt || 0), kind: 'insight', text: String(i.insight || '') }))
                        ].sort((x: any, y: any) => y.at - x.at).slice(0, 30).map((e: any, idx: number) => (
                          <div key={idx} className="crm-timeline__item">
                            <span className="crm-timeline__time">{new Date(e.at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                            <span className={`crm-timeline__tag ${e.kind}`}>{e.kind === 'insight' ? 'AI 见解' : 'CRM'}</span>
                            <span className="crm-timeline__text">{e.text}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {customerProfile.aiProfile && (
                    <div className="crm-profile__section">
                      <h4>AI 画像</h4>
                      <div className="crm-insight">{customerProfile.aiProfile}</div>
                    </div>
                  )}
                  {customerProfile.advice && (customerProfile.advice.nextMove || customerProfile.advice.whyNow) && !customerProfile.advice.notConfigured && (
                    <div className="crm-profile__section">
                      <h4>AI 下一步建议</h4>
                      <div className="crm-insight">
                        {customerProfile.advice.whyNow && <div className="ai-row"><span className="ai-row__label">为什么现在</span><span>{customerProfile.advice.whyNow}</span></div>}
                        {customerProfile.advice.opportunity && <div className="ai-row"><span className="ai-row__label">机会</span><span>{customerProfile.advice.opportunity}</span></div>}
                        {customerProfile.advice.riskSignal && <div className="ai-row"><span className="ai-row__label">风险</span><span>{customerProfile.advice.riskSignal}</span></div>}
                        {customerProfile.advice.script && <div className="ai-row"><span className="ai-row__label">话术</span><span>{customerProfile.advice.script}</span></div>}
                        {customerProfile.advice.nextMove && <div className="ai-row"><span className="ai-row__label">下一步</span><span>{customerProfile.advice.nextMove}</span></div>}
                      </div>
                    </div>
                  )}
                  {customerProfile.insights?.length > 0 && (
                    <div className="crm-profile__section">
                      <h4>最近见解</h4>
                      {customerProfile.insights.map((r: any) => (
                        <div key={r.id} className="crm-row">{new Date(Number(r.createdAt)).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })} · {r.insight}</div>
                      ))}
                    </div>
                  )}
                  {customerProfile.todos?.length > 0 && (
                    <div className="crm-profile__section">
                      <h4>跟进待办（{customerProfile.todos.filter((t: any) => t.status === 'pending' || t.status === 'overdue').length}）</h4>
                      {customerProfile.todos.filter((t: any) => t.status === 'pending' || t.status === 'overdue').map((t: any) => (
                        <div key={t.id} className="crm-row">{t.promise_summary || t.title} [{t.status}]</div>
                      ))}
                    </div>
                  )}
                  <div className="crm-profile__section">
                    <h4>业务</h4>
                    <div className="crm-row">合同 {customerProfile.contracts?.length ?? 0} 份 · 已确认回款 ¥{Number(customerProfile.credited ?? 0).toLocaleString()}</div>
                  </div>
                </div>
              )}
              {deepReport && (
                <div className="crm-profile">
                  <div className="crm-profile__section">
                    <h4>资深销售助理 · 深度分析</h4>
                    <div className="crm-insight crm-deep-report">{deepReport}</div>
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}

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
