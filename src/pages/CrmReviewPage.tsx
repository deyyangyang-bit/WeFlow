/**
 * CrmReviewPage.tsx —— 确认中心：归属待确认/物流待链接/到款待审核/发票待开
 */
import { useEffect, useState } from 'react'
import { ClipboardCheck, RefreshCw, Radio, Users, X } from 'lucide-react'
import { useCrmStore } from '../stores/crmStore'
import './CrmReviewPage.scss'

export default function CrmReviewPage() {
  const { queues, fetchQueues, fetchWorkbench, scanNow, loading, notice, setNotice } = useCrmStore()
  const [contracts, setContracts] = useState<any[]>([])
  const [groups, setGroups] = useState<any[]>([])
  const [showPick, setShowPick] = useState(false)
  const [pickSearch, setPickSearch] = useState('')
  const [groupSessions, setGroupSessions] = useState<any[]>([])
  const [pickType, setPickType] = useState<Record<string, string>>({})

  const TYPE_LABELS: Record<string, string> = { logistics: '物流发货', payment: '货款认领', order: '订单截图' }

  const fetchGroups = async () => setGroups((await window.electronAPI.crm.groupsList()) || [])
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

  useEffect(() => {
    void fetchQueues()
    void fetchGroups()
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
        <button className="crm-btn" onClick={() => void openPick()}><Users size={14} /> 筛选群聊</button>
      </section>

      {showPick && (
        <div className="crm-modal">
          <div className="crm-modal-body">
            <h3>筛选扫描群聊 <button className="crm-btn" onClick={() => setShowPick(false)}><X size={14} /></button></h3>
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
                    <button className="crm-btn primary" onClick={() => void addGroup(x)}>添加并扫描</button>
                  </div>
                ))}
            </div>
          </div>
        </div>
      )}

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
