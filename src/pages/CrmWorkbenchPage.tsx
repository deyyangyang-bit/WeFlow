/**
 * CrmWorkbenchPage.tsx —— CRM 工作台：合同列表+全款进度+四子资源+发货卡点+文档生成
 */
import { useEffect, useState } from 'react'
import { Briefcase, FileText, RefreshCw, Truck, Plus, Handshake, X, Sparkles, Trash2 } from 'lucide-react'
import { useCrmStore } from '../stores/crmStore'
import './CrmWorkbenchPage.scss'

interface QuoRow { productId: number; name: string; price: number; qty: string }

const STAGE_LABELS: Record<string, string> = {
  contacted: '已沟通', quoted: '已报价', negotiating: '谈判中', won: '已成交', new: '新客', unknown: '未知'
}

export default function CrmWorkbenchPage() {
  const { workbench, fetchWorkbench, notice, setNotice, products, fetchProducts } = useCrmStore()
  const [tab, setTab] = useState<'contracts' | 'customers'>('contracts')
  const [selected, setSelected] = useState<any>(null)
  const [quotations, setQuotations] = useState<any[]>([])
  const [invoices, setInvoices] = useState<any[]>([])
  const [allocations, setAllocations] = useState<any[]>([])
  const [logistics, setLogistics] = useState<any[]>([])
  const [showNew, setShowNew] = useState(false)
  const [newName, setNewName] = useState('')
  const [newAmount, setNewAmount] = useState('')
  const [showQuo, setShowQuo] = useState(false)
  const [quoRows, setQuoRows] = useState<QuoRow[]>([])
  const [quoSearch, setQuoSearch] = useState('')
  const [customers, setCustomers] = useState<any[]>([])
  const [selectedCustomer, setSelectedCustomer] = useState<any>(null)
  const [customerProfile, setCustomerProfile] = useState<any>(null)
  const [profileLoading, setProfileLoading] = useState(false)
  const [deepReport, setDeepReport] = useState('')
  const [deepLoading, setDeepLoading] = useState(false)
  const [stageFilter, setStageFilter] = useState('')

  useEffect(() => { void fetchWorkbench() }, [fetchWorkbench])
  useEffect(() => { void fetchCustomers() }, [])

  const fetchCustomers = async () => {
    setCustomers((await window.electronAPI.crm.customers()) || [])
  }

  // 阶段归一化为中文标签（与表格展示一致，未知阶段保留原始值）
  const stageLabel = (c: any) => STAGE_LABELS[String(c.sales_stage ?? '')] || String(c.sales_stage ?? '') || '未分类'
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

  const createContractForCustomer = (c: any) => {
    setSelected(null)
    setTab('contracts')
    setNewName(c.name)
    setNewAmount('')
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
    if (r.ok) { await fetchWorkbench(); if (selected?.id === c.id) setSelected(null) }
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
  }

  const ship = async (c: any) => {
    const r = await window.electronAPI.crm.contractShip(c.id)
    setNotice(r.ok ? '已发货' : `拒绝发货：${r.reason}${r.gap != null ? `，缺口 ${r.gap}` : ''}`)
    await fetchWorkbench()
  }

  const sign = async (c: any) => {
    const r = await window.electronAPI.crm.contractSign(c.id)
    setNotice(r.ok ? '已签约' : `签约失败：${r.reason}`)
    if (r.ok) { await fetchWorkbench(); if (selected?.id === c.id) setSelected(null) }
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
    const amount = parseFloat(newAmount || '0')
    const accountId = await window.electronAPI.crm.create('account', { name: newName, created_at: Date.now(), updated_at: Date.now() })
    await window.electronAPI.crm.create('contract', { account_id: accountId, name: `${newName}-合同`, amount, status: 'pending_sign', created_at: Date.now(), updated_at: Date.now() })
    setShowNew(false); setNewName(''); setNewAmount('')
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
        <button className="crm-btn" onClick={() => (tab === 'contracts' ? void fetchWorkbench() : void fetchCustomers())}><RefreshCw size={14} /> 刷新</button>
        <button className="crm-btn" onClick={() => setShowNew((v) => !v)}><Plus size={14} /> 新建合同</button>
      </div>
      {notice && <div className="crm-notice">{notice}</div>}
      {showNew && (
        <div className="crm-new-form">
          <input placeholder="客户名称" value={newName} onChange={(e) => setNewName(e.target.value)} />
          <input placeholder="合同金额" value={newAmount} onChange={(e) => setNewAmount(e.target.value)} />
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
          </div>
          <table className="crm-table">
            <thead><tr><th>客户</th><th>AI 阶段</th><th>合同</th><th>累计回款</th><th>导入时间</th><th>操作</th></tr></thead>
            <tbody>
              {filteredCustomers.map((c) => (
                <tr key={c.id} className={selectedCustomer?.id === c.id ? 'active' : ''} onClick={() => void openCustomer(c)}>
                  <td>{c.name}{c.session_id ? <span className="crm-badge">AI</span> : ''}</td>
                  <td>{stageLabel(c)}</td>
                  <td>{c.contract_count}</td>
                  <td>{Number(c.credited_total ?? 0).toLocaleString()}</td>
                  <td>{c.imported_at ? new Date(Number(c.imported_at)).toLocaleDateString('zh-CN') : '-'}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <button className="crm-btn" onClick={() => void genDeepAnalysisFromList(c)}><Sparkles size={13} /> 深度分析</button>
                    <button className="crm-btn" onClick={() => void createContractForCustomer(c)}><Plus size={13} /> 建合同</button>
                    <button className="crm-btn danger" onClick={() => void deleteCustomer(c)}><Trash2 size={13} /> 删除</button>
                  </td>
                </tr>
              ))}
              {filteredCustomers.length === 0 && (
                <tr><td colSpan={6} className="crm-empty">
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
                  <button className="crm-btn" onClick={() => void genDeepAnalysis(selectedCustomer)}><Sparkles size={13} /> {deepLoading ? '分析中…' : '深度分析'}</button>
                  <button className="crm-btn" onClick={() => void genAiQuotation(selectedCustomer)}><Sparkles size={13} /> AI 报价</button>
                  <button className="crm-btn primary" onClick={() => void createContractForCustomer(selectedCustomer)}><Plus size={14} /> 建合同</button>
                </div>
              </div>
              {profileLoading && <div className="crm-insight">加载档案…</div>}
              {!selectedCustomer.session_id && <div className="crm-insight">（未关联微信会话，无 AI 档案）</div>}
              {!profileLoading && selectedCustomer.session_id && customerProfile && (
                <div className="crm-profile">
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
