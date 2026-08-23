/**
 * CrmReviewPage.tsx —— 跟单中心：归属待确认/物流待链接+待签收/到款待审核/发票待开
 */
import { useEffect, useState } from 'react'
import { ClipboardCheck, RefreshCw, Radio, Sparkles, Users, X } from 'lucide-react'
import { useCrmStore } from '../stores/crmStore'
import { getCrmLogisticsOverdueHours } from '../services/config'
import './CrmReviewPage.scss'

// 物流区分页：每页 10 条（待认领 / 待签收 / 已签收 三区共用）
const LOGI_PAGE_SIZE = 10
/** 分页控件：总条数 ≤ 每页条数时不渲染 */
function LogiPager(props: { page: number; totalPages: number; total: number; onPage: (p: number) => void }) {
  const { page, totalPages, total, onPage } = props
  if (total <= LOGI_PAGE_SIZE) return null
  return (
    <div className="crm-pager">
      <button className="crm-btn" disabled={page <= 1} onClick={() => onPage(page - 1)}>上一页</button>
      <span className="crm-pager-info">第 {page} / {totalPages} 页 · 共 {total} 条</span>
      <button className="crm-btn" disabled={page >= totalPages} onClick={() => onPage(page + 1)}>下一页</button>
    </div>
  )
}

export default function CrmReviewPage() {
  const { queues, fetchQueues, fetchWorkbench, scanNow, loading, notice, setNotice, autoSummary, fetchAutoSummary, runAutoConfirm, undoAutoConfirm } = useCrmStore()
  const [contracts, setContracts] = useState<any[]>([])
  const [groups, setGroups] = useState<any[]>([])
  const [showPick, setShowPick] = useState(false)
  const [pickSearch, setPickSearch] = useState('')
  const [groupSessions, setGroupSessions] = useState<any[]>([])
  const [pickType, setPickType] = useState<Record<string, string>>({})
  const [allocContract, setAllocContract] = useState<Record<number, string>>({}) // allocationId → 合同 id（下拉选中）
  const [invoiceContract, setInvoiceContract] = useState<Record<number, string>>({})
  const [invoiceAmount, setInvoiceAmount] = useState<Record<number, string>>({}) // invoiceId → 金额输入
  const [running, setRunning] = useState(false) // 运行自动确认中
  const [showHistory, setShowHistory] = useState(false) // 自动确认历史展开
  // ── 物流跟单 ─────────────────────────────────────────────────────────────
  const [logiLinked, setLogiLinked] = useState<any[]>([]) // 已认领待签收
  const [logiSigned, setLogiSigned] = useState<any[]>([]) // 已签收（折叠）
  const [showSignedLogi, setShowSignedLogi] = useState(false)
  const [logiContract, setLogiContract] = useState<Record<number, string>>({}) // logisticsId → 合同 id（认领下拉，可选）
  const [logiAccount, setLogiAccount] = useState<Record<number, string>>({}) // logisticsId → 客户 id（认领下拉，必选其一）
  const [logiNewName, setLogiNewName] = useState<Record<number, string>>({}) // logisticsId → 新客户名（建客户并认领）
  const [logiSales, setLogiSales] = useState<Record<number, string>>({}) // logisticsId → 认领销售
  const [logiOverdueHours, setLogiOverdueHours] = useState(24) // 超期阈值（设置页配置）
  const [logiNotice, setLogiNotice] = useState('') // 物流区行内反馈（认领/签收结果就近显示，避免顶部 notice 被滚动遮挡）
  const [logiPage, setLogiPage] = useState(1) // 待认领分页
  const [pendingPage, setPendingPage] = useState(1) // 已认领待签收分页
  const [signedPage, setSignedPage] = useState(1) // 已签收分页
  const [contractName, setContractName] = useState<Record<number, string>>({}) // contract_id → 名称（跟单视图展示）
  const [accounts, setAccounts] = useState<any[]>([]) // 全部客户（认领下拉 + 待签收/已签收客户名展示）
  const [accountName, setAccountName] = useState<Record<number, string>>({}) // account_id → 客户名
  const displayNameOf = (c: any) => String(c?.profile_display_name || '') || String(c?.name || '')

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

  useEffect(() => {
    void fetchQueues()
    void fetchGroups()
    void fetchAutoSummary()
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
    void fetchLogi(logiOverdueHours)
    void getCrmLogisticsOverdueHours().then((h) => { setLogiOverdueHours(h); void fetchLogi(h) })
  }, [fetchQueues, fetchAutoSummary])

  const confirmAlloc = async (a: any, contractId?: number) => {
    const cid = contractId ? Number(contractId) : undefined
    // 未选合同且客户未确定 → 确认后钱不会计入任何合同，二次确认
    if (!cid && !a.account_id) {
      if (!window.confirm('未选择合同且客户未确定，确认后这笔归属不会计入任何合同回款。仍要确认吗？')) return
    }
    const r = await window.electronAPI.crm.allocationConfirm(a.id, {
      sales_name: a.sales_hint || a.sales_name,
      ...(cid ? { contract_id: cid } : {})
    })
    setNotice(r.ok ? (r.linked ? '归属已确认，已计入合同回款' : '归属已确认（未关联合同，回款未计入）') : `失败：${r.reason}`)
    await fetchQueues(); await fetchWorkbench()
  }
  const bindAccount = async (a: any, contractId?: number) => {
    const hint = String(a.customer_hint || '').trim()
    if (!hint) { setNotice('客户名为空，无法建客户'); return }
    const accountId = await window.electronAPI.crm.accountEnsure(hint) // 去重：同名客户不重复建
    await window.electronAPI.crm.aliasLearn(hint, accountId)
    const r = await window.electronAPI.crm.allocationConfirm(a.id, {
      account_id: accountId, sales_name: a.sales_hint || a.sales_name,
      ...(contractId ? { contract_id: contractId } : {})
    })
    setNotice(r.ok ? (r.linked ? '客户已建立并计入合同回款' : '客户已建立（暂无待签约合同，回款待关联）') : `失败：${r.reason}`)
    await fetchQueues(); await fetchWorkbench()
  }
  // 物流区行内提示（认领/签收操作反馈就近展示，滚动到列表下方时也能看到）
  const logiToast = (msg: string) => { setLogiNotice(msg) }
  // 自动匹配：收件人+城市 → 候选（合同优先）；唯一合同候选 → 认领到合同；无合同但唯一客户候选 → 认领到客户
  const linkLogi = async (l: any) => {
    const cands = await window.electronAPI.crm.logisticsCandidates(l.receiver, l.city)
    const contracts = cands.filter((c: any) => String(c.cand_kind || 'contract') === 'contract')
    const accounts = cands.filter((c: any) => String(c.cand_kind) === 'account')
    if (contracts.length === 1) {
      const r = await window.electronAPI.crm.logisticsLink(l.id, { contractId: Number(contracts[0].id), ownerSales: logiSales[l.id]?.trim() || undefined })
      logiToast(r.ok ? (r.warning ? `已认领，但${r.warning}` : `已认领：物流已关联「${contracts[0].name}」，转入「待签收」`) : `认领失败：${r.reason || '请重试'}`)
      await fetchQueues(); await fetchLogi(logiOverdueHours)
      return
    }
    if (accounts.length === 1) {
      const r = await window.electronAPI.crm.logisticsLink(l.id, { accountId: Number(accounts[0].account_id), ownerSales: logiSales[l.id]?.trim() || undefined })
      logiToast(r.ok ? `已认领：物流已关联客户「${accounts[0].name}」，转入「待签收」` : `认领失败：${r.reason || '请重试'}`)
      await fetchQueues(); await fetchLogi(logiOverdueHours)
      return
    }
    if (!contracts.length && !accounts.length) { logiToast('未找到匹配的客户或合同，请手动选择'); return }
    logiToast(`命中 ${contracts.length + accounts.length} 个候选，请用下拉选择`)
  }
  // 手动认领：客户（必选其一：下拉已有客户 或 新客户名建档） + 合同（可选） + 填销售 → 确认
  const doClaimLogi = async (l: any) => {
    const newName = logiNewName[l.id]?.trim() || ''
    const cid = logiContract[l.id] ? Number(logiContract[l.id]) : undefined
    let accountId: number | undefined = logiAccount[l.id] ? Number(logiAccount[l.id]) : undefined
    if (!accountId && !cid && !newName) { logiToast('请先选择客户（或填写新客户名）'); return }
    if (newName) {
      const created = await window.electronAPI.crm.accountEnsure(newName)
      if (!created) { logiToast('新建客户失败，请重试'); return }
      accountId = Number(created)
    }
    const r = await window.electronAPI.crm.logisticsLink(l.id, { accountId, contractId: cid, ownerSales: logiSales[l.id]?.trim() || undefined })
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
  // ── 物流三区分页切片（每页 10 条，page 越界自动收敛）────────────────────────
  const slicePage = (list: any[], page: number) => {
    const total = list.length
    const totalPages = Math.max(1, Math.ceil(total / LOGI_PAGE_SIZE))
    const cur = Math.min(page, totalPages)
    return { total, totalPages, cur, items: list.slice((cur - 1) * LOGI_PAGE_SIZE, cur * LOGI_PAGE_SIZE) }
  }
  const logiPg = slicePage(queues.logistics, logiPage)
  const pendingPg = slicePage(logiLinked, pendingPage)
  const signedPg = slicePage(logiSigned, signedPage)
  const noAccount = accounts.length === 0 // 无任何客户 → 认领不可行，给引导
  const approvePayment = async (p: any) => {
    const r = await window.electronAPI.crm.paymentApprove(p.id)
    setNotice(r.ok ? (r.allocationCreated ? '已确认到款，已转入「归属待确认」' : '已确认到款（该笔已有归属记录）') : `失败：${r.reason}`)
    await fetchQueues(); await fetchWorkbench()
  }

  // ── 自动确认：手动一键运行 / 历史撤销 ──────────────────────────────────────
  const ENTITY_LABELS: Record<string, string> = { allocation: '归属', payment: '到款', logistics: '物流', invoice: '发票' }
  const doRunAuto = async () => {
    setRunning(true)
    try { await runAutoConfirm() } catch { setNotice('自动确认运行失败') } finally { setRunning(false) }
  }
  const doUndoAuto = async (h: any) => {
    if (!window.confirm(`撤销这条自动${ENTITY_LABELS[String(h.entity)] || h.entity}处理？`)) return
    const r = await undoAutoConfirm(h.entity, h.entity_id)
    setNotice(r.ok ? '已撤销，条目恢复待处理' : `撤销失败：${r.reason}`)
  }

  return (
    <div className="crm-review-page">
      <div className="crm-header">
        <h2><ClipboardCheck size={18} /> 跟单中心</h2>
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

      <section className="crm-auto">
        <h3>
          <Sparkles size={14} /> 自动确认
          {autoSummary.lastRun && (
            <em className="crm-auto__sum">上次自动处理 {autoSummary.lastRun.auto} 条，仍待人工 {autoSummary.lastRun.reviewed} 条</em>
          )}
          <button className="crm-btn primary" onClick={() => void doRunAuto()} disabled={running}>{running ? '运行中…' : '运行自动确认'}</button>
          <button className="crm-btn" onClick={() => setShowHistory(!showHistory)}>历史 {showHistory ? '收起' : `（${autoSummary.history.length}）`}</button>
        </h3>
        {autoSummary.lastRun && (
          <div className="crm-auto__byentity">
            {(['allocation', 'payment', 'logistics', 'invoice'] as const).map((k) => {
              const e = autoSummary.lastRun?.byEntity?.[k]
              if (!e || (e.auto === 0 && e.reviewed === 0)) return null
              return <span key={k}>{ENTITY_LABELS[k]}：自动 {e.auto} / 待审 {e.reviewed}</span>
            })}
          </div>
        )}
        {showHistory && (
          <div className="crm-auto__history">
            {autoSummary.history.length === 0 && <em className="crm-card__src">暂无自动确认记录（扫描新消息或点「运行自动确认」触发）</em>}
            {autoSummary.history.map((h) => (
              <div key={h.id} className="crm-card">
                <span>{ENTITY_LABELS[String(h.entity)] || h.entity} #{h.entity_id} · {h.decision === 'auto_confirm' ? '自动' : h.decision} · 置信 {Math.round(Number(h.confidence ?? 0) * 100)}% · {h.action || '-'}
                  <em className="crm-card__src">{h.reason}{h.created_at ? ` · ${fmtTime(h.created_at)}` : ''}</em>
                </span>
                {h.decision === 'auto_confirm' && (
                  <button className="crm-btn" onClick={() => void doUndoAuto(h)}>撤销</button>
                )}
              </div>
            ))}
          </div>
        )}
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
            <span>{a.customer_hint} · {Number(a.amount_hint).toLocaleString()} · 销售 {a.sales_hint || a.sales_name || '?'}
              {(a.src_group_id || a.src_time) && <em className="crm-card__src">{groupName(a.src_group_id)}{a.src_time ? ` · ${fmtTime(a.src_time)}` : ''}{a.src_raw ? ` · 「${String(a.src_raw).slice(0, 40)}」` : ''}</em>}
            </span>
            <select value={allocContract[a.id] ?? ''} onChange={(e) => setAllocContract((m) => ({ ...m, [a.id]: e.target.value }))}>
              <option value="">关联合同…</option>
              {contracts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <button className="crm-btn primary" onClick={() => void confirmAlloc(a, allocContract[a.id] ? Number(allocContract[a.id]) : undefined)}>确认</button>
            <button className="crm-btn" onClick={() => void bindAccount(a, allocContract[a.id] ? Number(allocContract[a.id]) : undefined)}>建新客户并确认</button>
            <button className="crm-btn" onClick={() => { void window.electronAPI.crm.allocationReject(a.id).then(fetchQueues) }}>驳回</button>
          </div>
        ))}
      </section>

      <section>
        <h3>
          物流跟单
          <em className="logi-stats">
            待认领 {queues.logistics.length} · 待签收 {logiLinked.length}
            <span className={logiOverdueCount > 0 ? 'logi-stats__overdue' : ''}>{logiOverdueCount > 0 ? ` · 超期 ${logiOverdueCount}` : ''}</span>
          </em>
        </h3>
        {logiNotice && <div className="logi-notice">{logiNotice}</div>}
        <div className="logi-queue">
          <h4>待认领（{logiPg.total}）</h4>
          {noAccount && logiPg.total > 0 && (
            <div className="logi-notice logi-notice--warn">
              暂无客户，无法认领物流。请先在「客户工作台」创建客户。
            </div>
          )}
          {logiPg.total === 0 && <div className="crm-card crm-card--empty">暂无待认领物流</div>}
          {logiPg.items.map((l) => {
            const selAcc = logiAccount[l.id] ? Number(logiAccount[l.id]) : undefined
            const accContracts = selAcc ? contracts.filter((c) => Number(c.account_id) === selAcc) : []
            const claimReady = Boolean(logiAccount[l.id] || logiNewName[l.id]?.trim() || logiContract[l.id])
            return (
              <div key={l.id} className="crm-card logi-card">
                <div className="logi-card__main">
                  <span className="logi-card__info">{l.tracking_no} · {l.brand} · {l.receiver} {l.city}</span>
                  <em className="logi-card__time">发货 {fmtTime(l.latest_update_at)}</em>
                </div>
                <div className="logi-card__actions">
                  <input placeholder="认领销售" value={logiSales[l.id] ?? ''}
                    onChange={(e) => setLogiSales((m) => ({ ...m, [l.id]: e.target.value }))} style={{ width: '100px' }} />
                  <select value={logiAccount[l.id] ?? ''} onChange={(e) => setLogiAccount((m) => ({ ...m, [l.id]: e.target.value }))} style={{ width: '150px' }}>
                    <option value="">选择客户…</option>
                    {accounts.map((c) => <option key={c.id} value={c.id}>{displayNameOf(c)}{c.company ? ` · ${c.company}` : ''}</option>)}
                  </select>
                  <select value={logiContract[l.id] ?? ''} onChange={(e) => setLogiContract((m) => ({ ...m, [l.id]: e.target.value }))} style={{ width: '150px' }}>
                    <option value="">关联合同（可选）</option>
                    {accContracts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                  <input placeholder="新客户名（可建）" value={logiNewName[l.id] ?? ''}
                    onChange={(e) => setLogiNewName((m) => ({ ...m, [l.id]: e.target.value }))} style={{ width: '130px' }} />
                  <button className="crm-btn primary" disabled={!claimReady} title={claimReady ? '' : '请先选择客户或填写新客户名'} onClick={() => void doClaimLogi(l)}>确认认领</button>
                  <button className="crm-btn" onClick={() => void linkLogi(l)}>自动匹配</button>
                </div>
              </div>
            )
          })}
          <LogiPager page={logiPg.cur} totalPages={logiPg.totalPages} total={logiPg.total} onPage={setLogiPage} />
        </div>
        <h4 style={{ marginTop: '10px' }}>已认领待签收（{pendingPg.total}）</h4>
        {pendingPg.total === 0 && <div className="crm-card crm-card--empty">暂无待签收物流（发货后 {logiOverdueHours}h 未签收会标红提醒）</div>}
        {pendingPg.items.map((l) => (
          <div key={l.id} className="crm-card logi-card">
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
              <button className="crm-btn primary" onClick={() => void doSignedLogi(l)}>确认签收</button>
            </div>
          </div>
        ))}
        <LogiPager page={pendingPg.cur} totalPages={pendingPg.totalPages} total={pendingPg.total} onPage={setPendingPage} />
        <h4 style={{ marginTop: '10px' }}>
          已签收（{signedPg.total}）
          <button className="crm-btn" style={{ marginLeft: '8px' }} onClick={() => setShowSignedLogi(!showSignedLogi)}>
            {showSignedLogi ? '收起' : '展开'}
          </button>
        </h4>
        {showSignedLogi && (
          signedPg.total === 0
            ? <div className="crm-card crm-card--empty">暂无已签收物流</div>
            : signedPg.items.map((l) => (
                <div key={l.id} className="crm-card logi-card">
                  <div className="logi-card__main">
                    <span className="logi-card__info">{l.tracking_no} · {l.brand} · {l.receiver} {l.city}
                      {l.owner_sales ? ` · ${l.owner_sales}` : ''}
                      {contractName[Number(l.contract_id)] ? ` · ${contractName[Number(l.contract_id)]}` : accountName[Number(l.account_id)] ? ` · ${accountName[Number(l.account_id)]}` : ''}
                    </span>
                    <em className="logi-card__time">发货 {fmtTime(l.latest_update_at)} · 签收 {fmtTime(l.signed_at)}</em>
                  </div>
                </div>
              ))
        )}
        {showSignedLogi && <LogiPager page={signedPg.cur} totalPages={signedPg.totalPages} total={signedPg.total} onPage={setSignedPage} />}
      </section>

      <section>
        <h3>到款待审核（{queues.payments.length}）</h3>
        {queues.payments.map((p) => (
          <div key={p.id} className="crm-card">
            <span>{p.payer || '(截图/未知)'} · {Number(p.amount_net).toLocaleString()} · {p.source}
              {(p.group_id || p.pay_time) && <em className="crm-card__src">{groupName(p.group_id)}{p.pay_time ? ` · ${fmtTime(p.pay_time)}` : ''}{p.raw_content ? ` · 「${String(p.raw_content).slice(0, 40)}」` : ''}</em>}
            </span>
            <button className="crm-btn primary" onClick={() => void approvePayment(p)}>确认到款</button>
          </div>
        ))}
      </section>

      <section>
        <h3>发票待开（{queues.invoices.length}）</h3>
        {queues.invoices.map((i) => (
          <div key={i.id} className="crm-card">
            <span>{i.buyer} · 发票号 {i.invoice_no || '-'} · 金额 ¥{Number(i.amount ?? 0).toLocaleString()}
              <em className="crm-card__src">{i.contract_id ? '已关联合同' : '未关联合同'}</em>
            </span>
            <input className="crm-card__amt" type="number" min="0" placeholder="填写金额" value={invoiceAmount[i.id] ?? ''}
              onChange={(e) => setInvoiceAmount((m) => ({ ...m, [i.id]: e.target.value }))} />
            <button className="crm-btn" onClick={() => {
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
            <button className="crm-btn" onClick={() => { void window.electronAPI.crm.docGenerate('invoice-info', i.id).then((r) => setNotice(r.ok ? `开票信息单：${r.path}` : '生成失败')) }}>开票信息单</button>
            <button className="crm-btn" onClick={() => { void window.electronAPI.crm.docGenerate('invoice-app', i.id).then((r) => setNotice(r.ok ? `开票申请单：${r.path}` : '生成失败')) }}>开票申请</button>
          </div>
        ))}
      </section>
    </div>
  )
}
