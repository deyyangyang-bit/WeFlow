import { isPriceOverride, quoteRowError } from '../../shared/priceOverride'
import GeneratedFileResult, { type GeneratedArtifact } from '../components/crm/GeneratedFileResult'
import { parseBuyerHeader, buyerHeaderOutcome, BUYER_HEADER_FIELD_LABELS, type ComboHit } from '../../shared/buyerHeader'
/**
 * CrmWorkbenchPage.tsx —— 合同工作台：合同列表+全款进度+四子资源+发货卡点+文档生成
 * （客户工作台已拆分到 CustomerWorkspacePage /customers，本页专注合同闭环）
 */
import { useEffect, useRef, useState } from 'react'
import { useWxidRefresh } from '../utils/useWxidRefresh'
import { Briefcase, FileText, RefreshCw, Truck, Plus, Handshake, X, Trash2, Users, Banknote, AlertTriangle } from 'lucide-react'
import { useSearchParams } from 'react-router-dom'
import ReactECharts from 'echarts-for-react'
import { useCrmStore } from '../stores/crmStore'
import { filterByOwner, isSalesView, type IdentityLike } from '../utils/leadAssignmentView'
import SearchTable, { type SearchTableColumn } from '../components/crm/SearchTable'
import DeliveryAftersales from '../components/crm/DeliveryAftersales'
// 阶段分布/管道图色板单一真源（红线 3）：Apple 蓝渐变族
import { FUNNEL_STAGE_COLORS, FUNNEL_NEUTRAL } from '../../shared/funnelPalette'
import { parseJsonObject } from '../../shared/safeJson'
import './CrmWorkbenchPage.scss'

interface QuoRow { productId: number; name: string; model?: string; price: number; unitPrice: string; qty: string }

/** 抬头粘贴解析提示（§7.2.5）：ok=浅蓝成功，warn=浅黄待人工处理，fail=浅红未识别 */
interface HeaderNote { tone: 'ok' | 'warn' | 'fail'; text: string; combos: ComboHit[] }

export default function CrmWorkbenchPage() {
  const { workbench, fetchWorkbench, notice, setNotice, products, fetchProducts } = useCrmStore()
  // 页面过滤档（2026-09-05 拍板）：销售视角只看 owner_sales=本人（经 account JOIN 带出）或未归属；展示层便利，非安全边界（宪法 §1.12）
  const [identity, setIdentity] = useState<IdentityLike>({ name: '', role: '' })
  useEffect(() => { void window.electronAPI.identity.get().then((idt) => setIdentity({ name: String(idt?.name || ''), role: String(idt?.role || '') })).catch(() => undefined) }, [])
  const myWorkbench = filterByOwner(workbench, identity)
  const [selected, setSelected] = useState<any>(null)
  const [quotations, setQuotations] = useState<any[]>([])
  const [invoices, setInvoices] = useState<any[]>([])
  const [allocations, setAllocations] = useState<any[]>([])
  const [logistics, setLogistics] = useState<any[]>([])
  const [showNew, setShowNew] = useState(false)
  const entryScopeRef = useRef<{ accountKey: string; generation: number } | null>(null)
  const entryEpoch = useRef(0)
  const requestRef = useRef('')
  const [headerChoices, setHeaderChoices] = useState<Record<string, boolean> | null>(null)
  const [headerConfirmed, setHeaderConfirmed] = useState(false)
  const draftKey = () => entryScopeRef.current ? `contract-entry:${entryScopeRef.current.accountKey}` : ''
  const persistDraft = (stage: string, items: QuoRow[]) => {
    try { if (draftKey()) localStorage.setItem(draftKey(), JSON.stringify({ creation_request_id: requestRef.current, stage, items })) }
    catch { setNotice('本地恢复入口不可用；刷新后请先查看合同列表确认，不要重复创建') }
  }
  const discardDraft = () => { try { if (draftKey()) localStorage.removeItem(draftKey()) } catch { /* storage disabled */ } }
  const openNew = async () => {
    const epoch = entryEpoch.current
    const scope = await window.electronAPI.crm.contractEntryScope()
    if (epoch !== entryEpoch.current) return
    entryScopeRef.current = scope
    let draft: any = null
    try { draft = JSON.parse(localStorage.getItem(draftKey()) || 'null') } catch { /* no draft */ }
    if (draft?.creation_request_id && Array.isArray(draft.items)) {
      const contract = await window.electronAPI.crm.contractByCreationRequest(draft.creation_request_id, scope)
      if (epoch !== entryEpoch.current) return
      const complete = contract && (draft.items.length === 0 || Number(contract.quote_version_id) > 0) && !['generating_document', 'partial_document_failed', 'creating_with_document'].includes(draft.stage)
      if (!complete) {
        requestRef.current = draft.creation_request_id; setNewQuoItems(draft.items)
        if (contract) {
          const cf = JSON.parse(contract.custom_fields || '{}')
          createdRef.current = { accountId: Number(contract.account_id), contractId: Number(contract.id), quotationId: Number(contract.quote_version_id) || undefined }
          setNewAccountId(Number(contract.account_id)); setNewName(String(contract.name || '').replace(/-合同$/, '')); setNewAmount(String(contract.amount || 0))
          setNewBuyerAddr(cf.buyer_addr || ''); setNewBuyerBank(cf.buyer_bank || ''); setNewBuyerAccount(cf.buyer_account || ''); setNewBuyerTax(cf.tax_no || ''); setNewBuyerPhone(cf.buyer_phone || '')
          const needsDoc = ['generating_document', 'partial_document_failed', 'creating_with_document'].includes(draft.stage)
          setGenerateOnCreate(needsDoc); setCreateStage(needsDoc ? 'partial_document_failed' : 'partial_quotation_failed')
          setCreateError('已恢复未完成流程，请继续最后一步；不会重复创建合同。')
        }
        setShowNew(true); return
      }
      discardDraft()
    }
    requestRef.current = crypto.randomUUID(); setHeaderConfirmed(false); setHeaderChoices(null); setCreateStage('editing'); setCreateError(''); createdRef.current = {}
    setShowNew(true); setSelected(null)
  }
  const creatingRef = useRef(false)
  const quoteCreatingRef = useRef(false)
  const createdRef = useRef<{ accountId?: number; contractId?: number; quotationId?: number }>({})
  const [createStage, setCreateStage] = useState('editing')
  const [createError, setCreateError] = useState('')
  const [quoteBusy, setQuoteBusy] = useState(false)
  const [artifact, setArtifact] = useState<GeneratedArtifact | null>(null)
  const [generatingDoc, setGeneratingDoc] = useState(false)
  const [generateOnCreate, setGenerateOnCreate] = useState(false)
  const formLocked = createStage !== 'editing'
  const resetNew = () => {
    if (creatingRef.current) return
    discardDraft(); requestRef.current = ''; setHeaderChoices(null); setHeaderConfirmed(false)
    createdRef.current = {}; setCreateStage('editing'); setCreateError(''); setShowNew(false)
    setNewAccountId(0); setNewName(''); setNewAmount(''); setNewQuoItems([])
    setNewBuyerAddr(''); setNewBuyerBank(''); setNewBuyerAccount(''); setNewBuyerTax(''); setNewBuyerPhone('')
    setNewHeaderText(''); setNewHeaderNote(null)
  }
  const [newAccountId, setNewAccountId] = useState(0) // 选中的已有客户（零操作建合同：不再重复建 account）
  const [newName, setNewName] = useState('')
  const [newAmount, setNewAmount] = useState('')
  // 甲方开票信息（新建合同：随合同创建写入 custom_fields）
  const [newBuyerAddr, setNewBuyerAddr] = useState('')
  const [newBuyerBank, setNewBuyerBank] = useState('')
  const [newBuyerAccount, setNewBuyerAccount] = useState('')
  const [newBuyerTax, setNewBuyerTax] = useState('')
  const [newBuyerPhone, setNewBuyerPhone] = useState('')
  // 甲方抬头粘贴原文与解析提示（§7.2.5：粘贴即解析，可重新识别/清空原文）
  const [newHeaderText, setNewHeaderText] = useState('')
  const [newHeaderNote, setNewHeaderNote] = useState<HeaderNote | null>(null)
  // 甲方开票信息（已建合同：详情编辑）
  const [showEditInvoice, setShowEditInvoice] = useState(false)
  const [editAddr, setEditAddr] = useState('')
  const [editBank, setEditBank] = useState('')
  const [editAccount, setEditAccount] = useState('')
  const [editTax, setEditTax] = useState('')
  const [editPhone, setEditPhone] = useState('')
  const [editHeaderText, setEditHeaderText] = useState('')
  const [editHeaderNote, setEditHeaderNote] = useState<HeaderNote | null>(null)
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

  // ─── P3 可视化：统计概览 + 三图（设计稿屏 3：收进「数据看板」折叠区，默认收起，展开后原样渲染）───
  const [dashboardOpen, setDashboardOpen] = useState(false)
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
  useWxidRefresh(() => { entryEpoch.current++; creatingRef.current = false; entryScopeRef.current = null; resetNew(); setSelected(null); setShowQuo(false); setArtifact(null); void fetchWorkbench(); void fetchCustomers(); void fetchStats(); void fetchAccuracy() })
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
    void openNew().catch(e => setNotice(String(e)))
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
  const filteredContracts = myWorkbench.filter((c: any) =>
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
    // 子列表同归属口径收敛（§2.74 遗留补齐）：主行已挡（myWorkbench），子表用同一 filterByOwner 补齐——
    // 销售视角只显示归属本人/空归属的子项。logistics 有 owner_sales 列（他人认领的物流可经收货人
    // 自动链接到我的合同，是真实泄漏点）；quotation/invoice 无 owner 列（归属继承主合同，主行已挡），
    // filterByOwner 下自然全过——三列表口径统一，未来加 owner 列即自动生效。
    setQuotations(filterByOwner(await window.electronAPI.crm.list('quotation', { contract_id: c.id }), identity))
    setInvoices(filterByOwner(await window.electronAPI.crm.list('invoice', { contract_id: c.id }), identity))
    setLogistics(filterByOwner(await window.electronAPI.crm.list('logistics', { contract_id: c.id }), identity))
    const allocs = await window.electronAPI.crm.list('allocation', { contract_id: c.id })
    setAllocations(allocs)
    // 甲方开票信息回填到编辑表单
    const cf = parseJsonObject<Record<string, string>>(c.custom_fields)
    setEditAddr(cf.buyer_addr ?? '')
    setEditBank(cf.buyer_bank ?? '')
    setEditAccount(cf.buyer_account ?? '')
    setEditTax(cf.tax_no ?? '')
    setEditPhone(cf.buyer_phone ?? '')
    // 换合同后清掉上一份的粘贴原文与解析提示，避免把旧提示当成本合同的识别结果
    setEditHeaderText('')
    setEditHeaderNote(null)
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
    setQuoRows((rs) => [...rs, { productId: p.id, name: p.name, price: Number(p.unit_price ?? 0), unitPrice: String(p.unit_price ?? 0), qty: '1' }])
  }

  const quoTotal = quoRows.reduce((s, r) => s + Math.round(Number(r.unitPrice) * Number(r.qty) * 100) / 100, 0)

  // 新建合同：从产品库勾选型号（可多选，同产品去重），创建时自动生成报价单行项
  const addNewQuoRow = (p: any) => {
    if (newQuoItems.some((r) => r.productId === p.id)) return
    setNewQuoItems((rs) => [...rs, { productId: p.id, name: p.name, model: String(p.model || ''), price: Number(p.unit_price ?? 0), unitPrice: String(p.unit_price ?? 0), qty: '1' }])
  }
  const newQuoTotal = newQuoItems.reduce((s, r) => s + Math.round(Number(r.unitPrice) * Number(r.qty) * 100) / 100, 0)

  const rowError = (row: QuoRow) => quoteRowError({ qty: row.qty, unit_price: row.unitPrice })
  const rowPayload = (row: QuoRow) => ({ product_id: row.productId, qty: Number(row.qty), unit_price: Number(row.unitPrice) })
  const createQuotation = async () => {
    if (!selected || quoteCreatingRef.current) return
    const error = quoRows.map(rowError).find(Boolean)
    if (!quoRows.length || error) { setNotice(error || '请至少添加一个产品行项'); return }
    quoteCreatingRef.current = true; setQuoteBusy(true)
    try {
      const r = await window.electronAPI.crm.quotationCreate({ contract_id: selected.id, items: quoRows.map(rowPayload) })
      setNotice(r.ok ? '报价单已创建' : `创建失败：${r.reason}`)
      if (r.ok) { setShowQuo(false); await select(selected) }
    } catch (e) { setNotice(String(e)) } finally { quoteCreatingRef.current = false; setQuoteBusy(false) }
  }

  const genDoc = async (type: string, id: number) => {
    if (generatingDoc) return
    setGeneratingDoc(true)
    try {
      const r = await window.electronAPI.crm.docGenerate(type, id)
      if (r.ok && r.path) setArtifact({ label: type === 'contract' ? '合同已生成' : '报价单已生成', path: r.path })
      else setNotice(`生成失败：${r.reason}`)
    } catch (e) { setNotice(String(e)) } finally { setGeneratingDoc(false) }
  }

  const createContract = async (withDocument = generateOnCreate) => {
    if (creatingRef.current) return
    const error = newQuoItems.map(rowError).find(Boolean)
    const amount = newAmount.trim() === '' ? newQuoTotal : Number(newAmount)
    if (!newName.trim()) { setCreateError('请填写客户名称'); return }
    if (error) { setCreateError(error); return }
    if (!Number.isFinite(amount) || amount < 0 || (!newQuoItems.length && amount <= 0)) { setCreateError('请填写有效合同金额，无产品行时金额须大于 0'); return }
    const scope = entryScopeRef.current
    if (!scope || !requestRef.current) { setCreateError('请重新打开新建合同'); return }
    const epoch = entryEpoch.current
    const checkScope = () => { if (epoch !== entryEpoch.current) throw new Error('账号已切换') }
    const custom_fields = { buyer_addr: newBuyerAddr.trim(), buyer_bank: newBuyerBank.trim(), buyer_account: newBuyerAccount.trim(), tax_no: newBuyerTax.trim(), buyer_phone: newBuyerPhone.trim() }
    const existingAccount = customers.find(c => Number(c.id) === newAccountId)
    let accountFields: Record<string, string> = {}
    try { accountFields = JSON.parse(existingAccount?.custom_fields || '{}') } catch { /* no stored header */ }
    const headerKeys = Object.keys(custom_fields) as Array<keyof typeof custom_fields>
    const differences = headerKeys.filter(key => String(accountFields[key] || '') !== custom_fields[key])
    if (!createdRef.current.contractId && newAccountId && !headerConfirmed && headerKeys.some(key => String(accountFields[key] || '').trim()) && differences.length) {
      setHeaderChoices(Object.fromEntries(differences.map(key => [key, true]))); setGenerateOnCreate(withDocument); return
    }
    creatingRef.current = true; setCreateError(''); setGenerateOnCreate(withDocument)
    persistDraft(withDocument ? 'creating_with_document' : 'creating_contract', newQuoItems)
    try {
      setCreateStage('creating_contract')
      const contract = await window.electronAPI.crm.contractBeginEntry({ requestId: requestRef.current, accountId: newAccountId, name: newName, amount, header: custom_fields, updateHeaderKeys: Object.keys(headerChoices || {}).filter(key => headerChoices?.[key]) }, scope)
      checkScope()
      const contractId = Number(contract.id)
      createdRef.current = { ...createdRef.current, accountId: Number(contract.account_id), contractId }
      if (newQuoItems.length && !createdRef.current.quotationId) {
        setCreateStage('creating_quotation')
        const result = await window.electronAPI.crm.contractEntryQuotation({ contract_id: contractId, items: newQuoItems.map(rowPayload), creation_request_id: requestRef.current }, scope)
        checkScope()
        if (!result.ok || !result.id) { setCreateStage('partial_quotation_failed'); setCreateError(`合同已创建，但报价单创建失败：${result.reason || '未返回报价编号'}`); return }
        createdRef.current.quotationId = result.id
      }
      if (withDocument) {
        setCreateStage('generating_document')
        persistDraft('generating_document', newQuoItems)
        const result = await window.electronAPI.crm.docGenerate('contract', contractId, { reuseExisting: true, scope })
        checkScope()
        if (!result.ok || !result.path) { setCreateStage('partial_document_failed'); setCreateError(`合同和报价已保存，但文档生成失败：${result.reason || '未返回文件'}`); return }
        setArtifact({ label: '合同已生成', path: result.path })
      }
      checkScope(); discardDraft(); setCreateStage('complete'); setNotice('合同已创建')
      await fetchWorkbench(); await fetchCustomers()
      const savedContract = await window.electronAPI.crm.get('contract', contractId)
      if (savedContract) await select(savedContract)
      creatingRef.current = false; resetNew()
    } catch (e) {
      if (epoch !== entryEpoch.current) return
      setCreateStage(createdRef.current.contractId ? 'partial_quotation_failed' : 'editing')
      setCreateError(`${createdRef.current.contractId ? '合同已创建，请从失败步骤重试：' : ''}${String(e)}`)
    } finally { if (epoch === entryEpoch.current) creatingRef.current = false }
  }

  // 已建合同：保存/更新甲方开票信息（覆盖式写入 custom_fields）
  const saveInvoiceInfo = async () => {
    if (!selected) return
    const old = parseJsonObject(selected.custom_fields)
    const cf = { ...old, buyer_addr: editAddr.trim(), buyer_bank: editBank.trim(), buyer_account: editAccount.trim(), tax_no: editTax.trim(), buyer_phone: editPhone.trim() }
    await window.electronAPI.crm.update('contract', selected.id, { custom_fields: JSON.stringify(cf) })
    setNotice('甲方开票信息已保存，生成合同/开票申请单将使用新信息')
    setShowEditInvoice(false)
    await fetchWorkbench()
  }

  // 新建合同：粘贴抬头 → 确定性解析 → 立即回填五项（§7.2.5）。不锁定字段，回填结果可继续编辑。
  const applyNewHeader = (text: string) => {
    setNewHeaderText(text)
    if (!text.trim()) { setNewHeaderNote(null); return }
    const result = parseBuyerHeader(text)
    // 失败判定与提示文案由共享层给出（§7.2.4 第 14 条 / §10.1），本页不自行约定
    const outcome = buyerHeaderOutcome(result)
    if (!outcome.ok) { setNewHeaderNote({ tone: 'fail', combos: result.comboHits, text: outcome.message }); return }
    const f = result.fields
    const applied: string[] = []
    if (f.addr) { setNewBuyerAddr(f.addr); applied.push(BUYER_HEADER_FIELD_LABELS.addr) }
    if (f.bank) { setNewBuyerBank(f.bank); applied.push(BUYER_HEADER_FIELD_LABELS.bank) }
    if (f.account) { setNewBuyerAccount(f.account); applied.push(BUYER_HEADER_FIELD_LABELS.account) }
    if (f.taxNo) { setNewBuyerTax(f.taxNo); applied.push(BUYER_HEADER_FIELD_LABELS.taxNo) }
    if (f.phone) { setNewBuyerPhone(f.phone); applied.push(BUYER_HEADER_FIELD_LABELS.phone) }
    // 新建客户时单位名称可回填；已选客户时以档案为准，不覆盖（§7.1.2 / §7.2.5）
    const nameIgnored = newAccountId > 0 && !!f.buyerName
    if (!nameIgnored && f.buyerName) { setNewName(f.buyerName); applied.unshift(BUYER_HEADER_FIELD_LABELS.buyerName) }
    const prefix = nameIgnored ? '已选客户，单位名称以客户档案为准；' : ''
    setNewHeaderNote({ tone: applied.length ? 'ok' : 'warn', combos: result.comboHits,
      text: applied.length
        ? `${prefix}已自动填写 ${applied.join('、')}，请核对后保存。`
        : `${prefix}未解析到其他抬头字段，请手动填写。` })
  }

  // 已建合同：同样粘贴即解析，但只回填合同字段，不触碰客户档案（§7.1.4 / §7.2.5）
  const applyEditHeader = (text: string) => {
    setEditHeaderText(text)
    if (!text.trim()) { setEditHeaderNote(null); return }
    const result = parseBuyerHeader(text)
    const outcome = buyerHeaderOutcome(result)
    if (!outcome.ok) { setEditHeaderNote({ tone: 'fail', combos: result.comboHits, text: outcome.message }); return }
    const f = result.fields
    const applied: string[] = []
    if (f.addr) { setEditAddr(f.addr); applied.push(BUYER_HEADER_FIELD_LABELS.addr) }
    if (f.bank) { setEditBank(f.bank); applied.push(BUYER_HEADER_FIELD_LABELS.bank) }
    if (f.account) { setEditAccount(f.account); applied.push(BUYER_HEADER_FIELD_LABELS.account) }
    if (f.taxNo) { setEditTax(f.taxNo); applied.push(BUYER_HEADER_FIELD_LABELS.taxNo) }
    if (f.phone) { setEditPhone(f.phone); applied.push(BUYER_HEADER_FIELD_LABELS.phone) }
    const prefix = f.buyerName ? '单位名称未修改，仍以客户档案为准。' : ''
    setEditHeaderNote({ tone: applied.length ? 'ok' : 'warn', combos: result.comboHits,
      text: applied.length ? `${prefix}已回填 ${applied.join('、')}，请核对后保存。` : `${prefix}未解析到其他抬头字段，请手动填写。` })
  }

  // 粘贴区（两处共用）：粘贴即解析；“重新识别”对当前原文重跑；“清空原文”只清文本与提示，不动已回填字段
  const headerPaste = (text: string, note: HeaderNote | null, onText: (t: string) => void) => (
    <div className="header-paste">
      <textarea aria-label="粘贴甲方抬头" value={text} onChange={(e) => onText(e.target.value)}
        onPaste={(e) => { const t = e.clipboardData.getData('text'); if (t.trim()) { e.preventDefault(); onText(t) } }}
        placeholder="粘贴甲方开票资料（单位名称／税号／地址／电话／开户银行／银行账号），粘贴后自动识别回填" />
      <div className="header-paste__actions">
        <button type="button" className="crm-btn" disabled={!text.trim()} onClick={() => onText(text)}>重新识别</button>
        <button type="button" className="crm-btn" disabled={!text} onClick={() => onText('')}>清空原文</button>
      </div>
      {note && (
        <div className={`header-paste__hint header-paste__hint--${note.tone}`} role={note.tone === 'fail' ? 'alert' : 'status'}>{note.text}</div>
      )}
      {note?.combos.map((hit) => (
        <div key={hit.raw} className="header-paste__combo">
          检测到合并字段，请手工拆分后确认：{hit.raw}（覆盖 {hit.covers.map((k) => BUYER_HEADER_FIELD_LABELS[k]).join('、')}）
        </div>
      ))}
    </div>
  )

  // 一行小字摘要（设计稿屏 3）：待签/预警取销售视角名单（filterByOwner 后的 myWorkbench），
  // 本月到账沿用 statsOverview 的 monthPaid 口径（不新造口径）
  const pendingSignCount = myWorkbench.filter((c: any) => c.status === 'pending_sign').length
  const warningCount = myWorkbench.filter((c: any) => c.warning).length

  // 视图切换：合同工作台（默认）/ 交付售后（成交单交付登记 + 设备档案 + 售后投影）
  const [view, setView] = useState<'contracts' | 'delivery'>('contracts')

  const ownerFiltered = isSalesView(identity)
  return (
    <div className="crm-workbench-page">
      {ownerFiltered && <div className="owner-filter-hint">仅显示我名下及未归属的数据</div>}
      <div className="crm-header">
        <h2><Briefcase size={18} /> 合同工作台</h2>
        <span className="crm-header__sub">合同闭环 · 报价 / 发货 / 回款 / 开票 · r7</span>
        <div className="crm-view-tabs">
          <button className={`crm-view-tab ${view === 'contracts' ? 'on' : ''}`} onClick={() => setView('contracts')}>合同工作台</button>
          <button className={`crm-view-tab ${view === 'delivery' ? 'on' : ''}`} onClick={() => setView('delivery')}>交付售后</button>
        </div>
        <button className="crm-btn crm-btn--ghost" onClick={() => { void fetchStats(); void fetchAccuracy(); void fetchWorkbench() }}><RefreshCw size={14} /> 刷新</button>
        {view === 'contracts' && (
          <button className="crm-btn crm-btn--primary" disabled={creatingRef.current} onClick={() => { if (showNew) resetNew(); else { void openNew().catch(e => setNotice(String(e))) }; if (!products.length) void fetchProducts() }}><Plus size={14} /> 新建合同</button>
        )}
      </div>
      {view === 'delivery' && <DeliveryAftersales />}
      {view === 'contracts' && (<>
      {notice && <div className="crm-notice">{notice}</div>}
      {artifact && <GeneratedFileResult artifact={artifact} onClose={() => setArtifact(null)} />}
      {stats && (
        <>
          {/* 顶部统计卡收成一行小字（设计稿屏 3：本月到账 / 待签 / 预警，预警非零才红色） */}
          <div className="crm-kpi-line">
            <span>本月到账 <b>¥{Number(stats.monthPaid || 0).toLocaleString()}</b></span>
            <span>待签 <b>{pendingSignCount}</b></span>
            <span>预警 <b className={warningCount > 0 ? 'is-hot' : ''}>{warningCount}</b></span>
          </div>
          {/* 两张图表 + AI 准确率 + 原 4 统计卡收进「数据看板」折叠区（默认收起，展开后原样渲染，零删除） */}
          <button className="crm-fold" onClick={() => setDashboardOpen((v) => !v)}>
            <span>📊 数据看板（到款趋势 / 客户阶段分布 / AI 准确率）</span>
            <span>{dashboardOpen ? '收起 ▲' : '展开 ▼'}</span>
          </button>
          {dashboardOpen && (
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
        </>
      )}
      {showNew && (
        <div className="crm-new-form"><h3>新建合同</h3><fieldset disabled={formLocked}>
          <select value={newAccountId} onChange={(e) => {
            const id = Number(e.target.value)
            setHeaderConfirmed(false); setHeaderChoices(null)
            // 换客户/切新建客户时连粘贴原文与提示一起清掉：抬头字段已被重置，旧提示会撒谎
            setNewHeaderText(''); setNewHeaderNote(null)
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
            } else {
              setNewName(''); setNewBuyerAddr(''); setNewBuyerBank(''); setNewBuyerAccount(''); setNewBuyerTax(''); setNewBuyerPhone('')
            }
          }}>
            <option value={0}>新建客户（或选择下方已有客户）</option>
            {customers.map((c) => <option key={c.id} value={c.id}>{displayNameOf(c)}{c.company ? ` · ${c.company}` : ''}</option>)}
          </select>
          <input placeholder="客户名称" readOnly={newAccountId > 0} value={newName} onChange={(e) => setNewName(e.target.value)} />
          <input placeholder={`合同金额（当前报价合计 ${newQuoTotal.toFixed(2)}）`} value={newAmount} onChange={(e) => setNewAmount(e.target.value)} />
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
                <label>本次单价 <input aria-label="本次单价" type="number" min="0" step="0.01" value={r.unitPrice} onChange={(e) => setNewQuoItems(rs => rs.map(x => x.productId === r.productId ? { ...x, unitPrice: e.target.value } : x))} /></label>
                {isPriceOverride(r.price, r.unitPrice) && <small className="price-override">已改价</small>}
                {rowError(r) && <small className="entry-error">{rowError(r)}</small>}
                <input type="number" min="1" value={r.qty}
                  onChange={(e) => setNewQuoItems((rs) => rs.map((x) => x.productId === r.productId ? { ...x, qty: e.target.value } : x))} />
                <button className="crm-btn" onClick={() => setNewQuoItems((rs) => rs.filter((x) => x.productId !== r.productId))}><X size={12} /></button>
              </div>
            ))}
            {newQuoItems.length > 0 && (
              <div className="crm-new-form__total">型号合计 ¥{newQuoTotal.toLocaleString()}（未填金额时作为合同金额，可改）· {newQuoItems.filter(r => isPriceOverride(r.price, r.unitPrice)).length} 项改价（记录审计）</div>
            )}
          </div>
          <span className="crm-new-form__divider">甲方开票信息（选填，用于生成合同/开票申请单）</span>
          {headerPaste(newHeaderText, newHeaderNote, applyNewHeader)}
          <input placeholder="单位地址" value={newBuyerAddr} onChange={(e) => setNewBuyerAddr(e.target.value)} />
          <input placeholder="开户银行" value={newBuyerBank} onChange={(e) => setNewBuyerBank(e.target.value)} />
          <input placeholder="银行账号" value={newBuyerAccount} onChange={(e) => setNewBuyerAccount(e.target.value)} />
          <input placeholder="税号" value={newBuyerTax} onChange={(e) => setNewBuyerTax(e.target.value)} />
          <input placeholder="电话" value={newBuyerPhone} onChange={(e) => setNewBuyerPhone(e.target.value)} />
          </fieldset>
          {newAmount.trim() && newQuoItems.length > 0 && Number(newAmount) !== newQuoTotal && <div className="crm-notice">合同金额已手工设定；当前报价合计 ¥{newQuoTotal.toFixed(2)} <button className="crm-btn" disabled={formLocked} onClick={() => setNewAmount('')}>同步报价合计</button></div>}
          {headerChoices && !headerConfirmed && <div className="entry-header-confirm" role="dialog" aria-label="更新客户抬头">
            <strong>本合同抬头与客户档案不同，要同步哪些字段？</strong>
            {Object.keys(headerChoices).map(key => { const labels: Record<string,string> = { buyer_addr:'地址', buyer_bank:'开户行', buyer_account:'银行账号', tax_no:'税号', buyer_phone:'电话' }; const values: Record<string,string> = { buyer_addr:newBuyerAddr, buyer_bank:newBuyerBank, buyer_account:newBuyerAccount, tax_no:newBuyerTax, buyer_phone:newBuyerPhone }; let old: any = {}; try { old = JSON.parse(customers.find(c => Number(c.id) === newAccountId)?.custom_fields || '{}') } catch {} return <label key={key}><input type="checkbox" checked={headerChoices[key]} onChange={e => setHeaderChoices(v => ({ ...v, [key]:e.target.checked }))} />{labels[key]}：{old[key] || '空'} → {values[key] || '空'}</label> })}
            <button className="crm-btn" onClick={() => setHeaderConfirmed(true)}>确认勾选项（再点击创建）</button>
            <button className="crm-btn" onClick={() => { setHeaderChoices({}); setHeaderConfirmed(true) }}>不更新客户档案</button>
          </div>}
          {createError && <div role="alert" className="entry-error">{createError}</div>}
          <div className="entry-actions">
            <button className="crm-btn primary" disabled={creatingRef.current || (formLocked && !createError)} onClick={() => void createContract(formLocked ? generateOnCreate : false)}>{creatingRef.current ? '正在保存…' : createStage === 'partial_quotation_failed' ? '重新创建报价单' : createStage === 'partial_document_failed' ? '重新生成合同' : '仅创建'}</button>
            {!formLocked && <button className="crm-btn primary" disabled={creatingRef.current} onClick={() => void createContract(true)}>创建并生成合同</button>}
            {createdRef.current.contractId && <button className="crm-btn" onClick={async () => { const c = await window.electronAPI.crm.get('contract', createdRef.current.contractId!); if (c) await select(c) }}>查看合同详情</button>}
            <button className="crm-btn" disabled={creatingRef.current} onClick={resetNew}>取消</button>
          </div>
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
                {headerPaste(editHeaderText, editHeaderNote, applyEditHeader)}
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
                <label>本次单价 <input aria-label="本次单价" type="number" min="0" step="0.01" value={r.unitPrice} onChange={(e) => setQuoRows(rs => rs.map(x => x.productId === r.productId ? { ...x, unitPrice: e.target.value } : x))} /></label>
                {isPriceOverride(r.price, r.unitPrice) && <small className="price-override">已改价</small>}
                {rowError(r) && <small className="entry-error">{rowError(r)}</small>}
                  <input type="number" min="1" value={r.qty}
                    onChange={(e) => setQuoRows((rs) => rs.map((x) => x.productId === r.productId ? { ...x, qty: e.target.value } : x))} />
                  <button className="crm-btn" onClick={() => setQuoRows((rs) => rs.filter((x) => x.productId !== r.productId))}><X size={12} /></button>
                </div>
              ))}
            </div>
            <div className="form-actions">
              <span className="quo-total">合计 ¥{quoTotal.toLocaleString()} · {quoRows.filter(r => isPriceOverride(r.price, r.unitPrice)).length} 项改价（记录审计）</span>
              <button className="crm-btn primary" disabled={quoteBusy} onClick={() => void createQuotation()}>创建报价单</button>
            </div>
          </div>
        </div>
      )}
      </>)}
    </div>
  )
}
