/**
 * CrmReviewPage.tsx —— 确认中心：归属待确认/物流待链接/到款待审核/发票待开
 */
import { useEffect, useState } from 'react'
import { ClipboardCheck, RefreshCw, Radio } from 'lucide-react'
import { useCrmStore } from '../stores/crmStore'
import './CrmReviewPage.scss'

export default function CrmReviewPage() {
  const { queues, fetchQueues, fetchWorkbench, scanNow, loading, notice, setNotice } = useCrmStore()
  const [contracts, setContracts] = useState<any[]>([])

  useEffect(() => {
    void fetchQueues()
    void window.electronAPI.crm.list('contract', { limit: 200 }).then((rows) => setContracts(rows || []))
  }, [fetchQueues])

  const confirmAlloc = async (a: any) => {
    const r = await window.electronAPI.crm.allocationConfirm(a.id, { sales_name: a.sales_hint || a.sales_name })
    setNotice(r.ok ? '归属已确认' : `失败：${r.reason}`)
    await fetchQueues(); await fetchWorkbench()
  }
  const bindAccount = async (a: any) => {
    const accountId = await window.electronAPI.crm.create('account', { name: a.customer_hint, created_at: Date.now(), updated_at: Date.now() })
    await window.electronAPI.crm.aliasLearn(a.customer_hint, accountId)
    await window.electronAPI.crm.allocationConfirm(a.id, { account_id: accountId, sales_name: a.sales_hint || a.sales_name })
    await fetchQueues(); await fetchWorkbench()
  }
  const linkLogi = async (l: any) => {
    const cands = await window.electronAPI.crm.logisticsCandidates(l.receiver, l.city)
    const pick = cands[0]
    if (!pick) { setNotice('无候选合同，请先在工作台建合同'); return }
    const r = await window.electronAPI.crm.logisticsLink(l.id, pick.id)
    setNotice(r.warning ? `已链接，但${r.warning}` : '物流已链接')
    await fetchQueues()
  }
  const clearReview = async (p: any) => {
    await window.electronAPI.crm.update('payment_record', p.id, { needs_review: 0 })
    await fetchQueues(); await fetchWorkbench()
  }

  return (
    <div className="crm-review-page">
      <div className="crm-header">
        <h2><ClipboardCheck size={18} /> 确认中心</h2>
        <button className="crm-btn" onClick={() => void scanNow()} disabled={loading}><Radio size={14} /> 立即扫描群消息</button>
        <button className="crm-btn" onClick={() => void fetchQueues()}><RefreshCw size={14} /> 刷新</button>
      </div>
      {notice && <div className="crm-notice">{notice}</div>}

      <section>
        <h3>归属待确认（{queues.allocations.length}）</h3>
        {queues.allocations.map((a) => (
          <div key={a.id} className="crm-card">
            <span>{a.customer_hint} · {Number(a.amount_hint).toLocaleString()} · 销售 {a.sales_hint || a.sales_name || '?'}</span>
            <button className="crm-btn primary" onClick={() => void confirmAlloc(a)}>确认</button>
            <button className="crm-btn" onClick={() => void bindAccount(a)}>建新客户并确认</button>
            <button className="crm-btn" onClick={() => { void window.electronAPI.crm.allocationReject(a.id).then(fetchQueues) }}>驳回</button>
          </div>
        ))}
      </section>

      <section>
        <h3>物流待链接（{queues.logistics.length}）</h3>
        {queues.logistics.map((l) => (
          <div key={l.id} className="crm-card">
            <span>{l.tracking_no} · {l.brand} · {l.receiver} {l.city}</span>
            <select defaultValue="" onChange={(e) => { if (e.target.value) void window.electronAPI.crm.logisticsLink(l.id, Number(e.target.value)).then(fetchQueues) }}>
              <option value="">选择合同…</option>
              {contracts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <button className="crm-btn" onClick={() => void linkLogi(l)}>自动匹配</button>
          </div>
        ))}
      </section>

      <section>
        <h3>到款待审核（{queues.payments.length}）</h3>
        {queues.payments.map((p) => (
          <div key={p.id} className="crm-card">
            <span>{p.payer || '(截图/未知)'} · {Number(p.amount_net).toLocaleString()} · {p.source}</span>
            <button className="crm-btn primary" onClick={() => void clearReview(p)}>审核通过</button>
          </div>
        ))}
      </section>

      <section>
        <h3>发票待开（{queues.invoices.length}）</h3>
        {queues.invoices.map((i) => (
          <div key={i.id} className="crm-card">
            <span>{i.buyer} · {Number(i.amount).toLocaleString()}</span>
            <button className="crm-btn" onClick={() => { void window.electronAPI.crm.docGenerate('invoice-info', i.id).then((r) => setNotice(r.ok ? `开票信息单：${r.path}` : '生成失败')) }}>开票信息单</button>
          </div>
        ))}
      </section>
    </div>
  )
}
