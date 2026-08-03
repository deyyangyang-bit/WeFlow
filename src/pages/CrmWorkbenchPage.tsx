/**
 * CrmWorkbenchPage.tsx —— CRM 工作台：合同列表+全款进度+四子资源+发货卡点+文档生成
 */
import { useEffect, useState } from 'react'
import { Briefcase, FileText, RefreshCw, Truck, Plus } from 'lucide-react'
import { useCrmStore } from '../stores/crmStore'
import './CrmWorkbenchPage.scss'

export default function CrmWorkbenchPage() {
  const { workbench, fetchWorkbench, notice, setNotice } = useCrmStore()
  const [selected, setSelected] = useState<any>(null)
  const [quotations, setQuotations] = useState<any[]>([])
  const [invoices, setInvoices] = useState<any[]>([])
  const [allocations, setAllocations] = useState<any[]>([])
  const [logistics, setLogistics] = useState<any[]>([])
  const [showNew, setShowNew] = useState(false)
  const [newName, setNewName] = useState('')
  const [newAmount, setNewAmount] = useState('')

  useEffect(() => { void fetchWorkbench() }, [fetchWorkbench])

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
        <button className="crm-btn" onClick={() => void fetchWorkbench()}><RefreshCw size={14} /> 刷新</button>
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
      <table className="crm-table">
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
                {c.status === 'signed' && <button className="crm-btn" onClick={() => void ship(c)}><Truck size={13} /> 发货</button>}
                <button className="crm-btn" onClick={() => void genDoc('contract', c.id)}><FileText size={13} /> 合同</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {selected && (
        <div className="crm-detail">
          <h3>{selected.name} · 子资源</h3>
          <div className="crm-tabs">
            <div><h4>报价单</h4>{quotations.map((q) => (
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
    </div>
  )
}
