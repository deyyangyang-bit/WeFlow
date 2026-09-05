/**
 * CustomerWorkspacePage.tsx —— AI 客户工作台（Customer Action Workspace）
 *
 * 产品原则：用户不维护 CRM，AI 维护 CRM——用户只做「看清单、打勾」。
 * 页面回答：谁值得看（行动信号）→ 为什么现在看（信号原因）→ 我要做什么（下一步）→ 做完系统怎么办（完成闭环）。
 *
 * 三个视图：
 *  - 值得跟进：有 task 信号的客户（R0-R8 跟进规则触发），按 priorityScore 降序
 *  - AI 新发现：仅 24h 未读洞察的信号客户，按 priorityScore 降序
 *  - 全部客户：account 全量卡片流，有信号的置顶，无信号的按最近联系降序（次级视图）
 *
 * 数据源（全部复用现有 IPC，无新增）：
 *  - 客户主数据：crm.customers()（account + profile_stage/profile_display_name 投影）
 *  - 行动信号：sales.actionGetUnified()（getUnifiedSignals，全量不截断，过滤 todo:/logi:/lead: 虚拟前缀）
 *  - 360 档案：crm.customerProfile(sessionId)
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useWxidRefresh } from '../utils/useWxidRefresh'
import { Users, RefreshCw, Plus, X, Sparkles, Trash2, MessageCircle, Download, CheckCircle2, Clock } from 'lucide-react'
import { Avatar } from '../components/Avatar'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useCrmStore } from '../stores/crmStore'
import { stageToFunnel } from '../../shared/salesStage'
import './CrmWorkbenchPage.scss'
import './CustomerWorkspacePage.scss'
// Customer 360 统一时间线：事件来源标签（crm=业务动作 / lead=线索流转 / opportunity=商机 / insight=AI 见解）
const TIMELINE_KIND_LABEL: Record<string, string> = { crm: 'CRM', lead: '线索', opportunity: '商机', insight: 'AI 见解' }
// 客户 360：AI 填充字段视图
const FIELD_LABELS_WB: Record<string, string> = {
  company: '公司', position: '职位', phone: '电话', industry: '行业', province: '省份', city: '城市',
  needs: '需求', budget: '预算', intent_model: '意向型号', purchase_timeframe: '采购时间',
  competitor: '竞品', price_sensitive: '价格敏感度'
}
const ENRICH_FIELD_ORDER = ['company', 'position', 'phone', 'industry', 'province', 'city', 'needs', 'budget', 'intent_model', 'purchase_timeframe', 'competitor', 'price_sensitive']
const FORMAL_SET = new Set(['company', 'position', 'phone', 'industry', 'province', 'city'])

type ViewTab = 'follow' | 'insight' | 'all'

export default function CustomerWorkspacePage() {
  const { notice, setNotice, queues, fetchQueues } = useCrmStore()
  const navigate = useNavigate()

  // ─── 数据 ─────────────────────────────────────────────────────────────────
  const [customers, setCustomers] = useState<any[]>([])
  const [signals, setSignals] = useState<any[]>([])
  const [tab, setTab] = useState<ViewTab>('follow')
  const [search, setSearch] = useState('')
  const [stageFilter, setStageFilter] = useState('')

  // 打开聊天：跳转到该客户的微信聊天页（需关联了微信会话 session_id）
  const openChat = (c: any) => {
    if (!c.session_id) { setNotice('该客户未关联微信会话，无法打开聊天'); return }
    navigate(`/chat?sessionId=${encodeURIComponent(c.session_id)}`)
  }

  // 拉取客户列表 + 行动信号（一次刷新两路数据）
  const fetchAll = async () => {
    const rows = (await window.electronAPI.crm.customers()) || []
    setCustomers(rows)
    try {
      const r = await (window as any).electronAPI.sales.actionGetUnified()
      // 过滤虚拟前缀（todo:<id> 手动待办 / logi:<id> 物流超期 / lead:<id> SLA 线索），只留真实会话客户信号
      const sigs = (r?.signals || []).filter((s: any) => {
        const sid = String(s.sessionId || '')
        return !sid.startsWith('todo:') && !sid.startsWith('logi:') && !sid.startsWith('lead:')
      })
      setSignals(sigs)
    } catch { /* 信号失败不影响客户列表 */ }
    return rows
  }
  useEffect(() => { void fetchAll() }, [])
  // 信息待确认队列（AI 填充待裁决）
  useEffect(() => { void fetchQueues() }, [fetchQueues])
  // 切微信号 = 换库（§2.40）：账号切换后重查，防残留上一账号数据
  useWxidRefresh(() => { void fetchAll(); void fetchQueues() })

  // ─── 深链协议：/customers?id=<accountId>（灵感信箱）| ?sid=<sessionId>（行动卡）| ?stage=中文（漏斗下钻）───
  const [searchParams] = useSearchParams()
  useEffect(() => {
    const id = Number(searchParams.get('id') || 0)
    const sid = searchParams.get('sid')
    const stage = searchParams.get('stage')
    if (id > 0 || sid || stage) {
      void fetchAll().then((rows) => {
        if (id > 0) {
          const hit = rows.find((x: any) => Number(x.id) === id)
          if (hit) void openCustomer(hit)
        } else if (sid) {
          const hit = rows.find((x: any) => String(x.session_id || '') === sid)
          if (hit) void openCustomer(hit)
          else setNotice('该客户尚未导入 CRM（AI 判定有意向后会自动导入）')
        } else if (stage) {
          setTab('all')
          // 防御旧值：漏斗下钻传中文档位，旧版曾传原始阶段串，统一过 stageToFunnel 归桶（幂等）
          setStageFilter(stageToFunnel(stage))
        }
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams])

  // ─── 展示 helper ──────────────────────────────────────────────────────────
  // 名称双轨读取侧统一：优先取画像最新微信备注（跟随备注改名），account.name 作兜底（导入时刻冻结）
  const displayNameOf = (c: any) => String(c.profile_display_name || '') || String(c.name || '')
  // 阶段统一走漏斗档位语义层（与销售漏斗同源）：profile_stage 或回退 sales_stage，过 stageToFunnel 归桶
  // 历史漏斗计「窗口内曾进入」，下钻列表是「当前阶段为该档位」——穿过该档位但现已流失/删除的客户不在列表，属正常
  const rowStage = (c: any) => stageToFunnel(String(c.profile_stage || '') || String(c.sales_stage ?? ''))
  // 信号按 sessionId 映射（join account）
  const signalBySession = useMemo(() => {
    const m = new Map<string, any>()
    for (const s of signals) if (s.sessionId) m.set(String(s.sessionId), s)
    return m
  }, [signals])
  // 卡片沉默天数：优先取信号卡（引擎已算），回退 account.last_contact_at
  const silentDaysOf = (c: any) => {
    const sig = signalBySession.get(String(c.session_id || ''))
    if (sig && sig.silentDays > 0) return sig.silentDays
    const lc = Number(c.last_contact_at || 0)
    if (!lc) return null
    return Math.max(0, Math.floor((Date.now() / 1000 - lc) / 86400))
  }
  // 卡片信号徽章：task 信号优先（R0-R8 跟进规则），否则 insight
  const signalOf = (c: any) => signalBySession.get(String(c.session_id || '')) || null

  // ─── 三个视图列表 ─────────────────────────────────────────────────────────
  const withTask = (s: any) => (s?.sources || []).some((src: any) => src.type === 'task')
  const sortByScore = (a: any, b: any) => (b.priorityScore ?? 0) - (a.priorityScore ?? 0)

  const followList = useMemo(() => {
    return customers
      .filter((c) => { const s = signalOf(c); return s && withTask(s) })
      .sort((a: any, b: any) => sortByScore(signalOf(b), signalOf(a)))
  }, [customers, signalBySession]) // eslint-disable-line react-hooks/exhaustive-deps
  const insightList = useMemo(() => {
    return customers
      .filter((c) => { const s = signalOf(c); return s && !withTask(s) })
      .sort((a: any, b: any) => sortByScore(signalOf(b), signalOf(a)))
  }, [customers, signalBySession]) // eslint-disable-line react-hooks/exhaustive-deps
  const allList = useMemo(() => {
    const q = search.trim().toLowerCase()
    const rows = customers.filter((c) => {
      if (stageFilter && rowStage(c) !== stageFilter) return false
      if (!q) return true
      return String(displayNameOf(c)).toLowerCase().includes(q) || String(c.company || '').toLowerCase().includes(q)
    })
    // 有信号的置顶（按分），无信号的按最近联系降序
    return [...rows].sort((a: any, b: any) => {
      const sa = signalOf(a); const sb = signalOf(b)
      if (sa && sb) return sortByScore(sb, sa)
      if (sa) return -1
      if (sb) return 1
      return (Number(b.last_contact_at || b.created_at || 0)) - (Number(a.last_contact_at || a.created_at || 0))
    })
  }, [customers, search, stageFilter, signalBySession]) // eslint-disable-line react-hooks/exhaustive-deps

  // 下拉只显示中文档位（与漏斗同桶），不再中英混排
  const stageOptions = Array.from(new Set(customers.map(rowStage))).sort((a, b) => a.localeCompare(b, 'zh'))

  // ─── 完成行动（今日行动→执行→回写闭环）────────────────────────────────────
  const [completing, setCompleting] = useState('')
  const completeSignal = async (c: any) => {
    if (!c.session_id) return
    setCompleting(String(c.id))
    try {
      await (window as any).electronAPI.sales.actionCompleteUnified(String(c.session_id), 'done')
      setNotice(`已完成「${displayNameOf(c)}」的跟进`)
    } catch (e) { setNotice(`完成失败：${e}`) }
    setCompleting('')
    await fetchAll()
  }

  // ─── 客户 360 档案 ─────────────────────────────────────────────────────────
  const [selectedCustomer, setSelectedCustomer] = useState<any>(null)
  const [customerProfile, setCustomerProfile] = useState<any>(null)
  const [profileLoading, setProfileLoading] = useState(false)
  const [editingField, setEditingField] = useState('')
  const [editingValue, setEditingValue] = useState('')
  const [deepReport, setDeepReport] = useState('')
  const [deepLoading, setDeepLoading] = useState(false)
  const deepReqRef = useRef(-1) // 最近一次深度分析的目标客户 id：切换客户后旧请求作废，防止报告写错抽屉
  // P0-3.2 证据回查（AI 当前判断卡「有据可查」）：视图只带 messageKey 锚点，点击才走 P0-2B 拉原话
  const [evidenceKey, setEvidenceKey] = useState<string | null>(null)
  const [evidenceMsg, setEvidenceMsg] = useState<string | null>(null)

  const openCustomer = async (c: any) => {
    setSelectedCustomer(c)
    setCustomerProfile(null)
    setDeepReport('')
    deepReqRef.current = Number(c?.id ?? -1) // 使在途的旧客户深度分析请求失效
    setDeepLoading(false)
    setEvidenceKey(null)
    setEvidenceMsg(null)
    if (!c.session_id) return
    setProfileLoading(true)
    try {
      const r = await window.electronAPI.crm.customerProfile(String(c.session_id))
      if (r?.success) setCustomerProfile(r.data)
    } catch { /* ignore */ }
    setProfileLoading(false)
  }

  // 判断卡证据回查：messageKey → sales:evidence:getByKey（原话+时间）；再点收起
  const toggleEvidence = async (j: any) => {
    if (!j?.messageKey || !selectedCustomer?.session_id) return
    if (evidenceKey === j.messageKey) { setEvidenceKey(null); setEvidenceMsg(null); return }
    setEvidenceKey(j.messageKey)
    setEvidenceMsg('正在回查原话…')
    try {
      const r = await window.electronAPI.sales.evidenceGetByKey({
        session_id: String(selectedCustomer.session_id),
        message_key: j.messageKey,
        evidence_text: j.value ? `判断：${j.value}` : undefined
      })
      if (r?.status === 'found') {
        const m = r.message
        const text = String(m?.parsedContent || m?.content || m?.rawContent || '')
        const t = Number(m?.createTime || 0)
        const time = t ? new Date(t).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''
        setEvidenceMsg(`原话（${time}）：${text}`)
      } else {
        setEvidenceMsg(`未找到原话（${r?.reason || 'unavailable'}）；判断依据句：${j.value}`)
      }
    } catch (e) {
      setEvidenceMsg(`回查失败：${String(e)}`)
    }
  }

  // 客户信息字段视图（account + custom_fields + enrich_meta 装配）
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
  const saveFieldManual = async (field: string) => {
    const accId = Number(customerProfile?.account?.id || 0)
    if (!accId) return
    const r = await window.electronAPI.crm.manualSet(accId, field, editingValue)
    setNotice(r.ok ? '已保存（该字段已锁定，AI 不再覆盖）' : `保存失败：${r.reason}`)
    setEditingField('')
    if (selectedCustomer) await openCustomer(selectedCustomer)
  }

  // 客户类型（PRD §1.5 dealer/end_user，R9/R10 前置）：人工选择写 customer.type + 审计（crm:customer:setType）
  const CUSTOMER_TYPE_LABEL: Record<string, string> = { dealer: '经销商', end_user: '终端客户' }
  const saveCustomerType = async (type: string) => {
    const cid = Number(customerProfile?.customer?.id || 0)
    if (!cid) return
    const r = await window.electronAPI.crm.customerSetType({ customerId: cid, type })
    setNotice(r.ok ? `客户类型已更新：${CUSTOMER_TYPE_LABEL[type] || '未设置'}` : `保存失败：${r.message || r.code}`)
    if (r.ok && selectedCustomer) await openCustomer(selectedCustomer)
  }

  // 信息待确认裁决（页面顶部）：采纳=写入档案并锁定，放弃=丢弃该条 AI 填充
  const applyInfo = async (it: any, action: 'accept' | 'reject') => {
    const r = await window.electronAPI.crm.infoQueueApply(Number(it.account_id), String(it.field), action)
    setNotice(r.ok ? (action === 'accept' ? `已采纳「${FIELD_LABELS_WB[it.field] || it.field}」` : '已放弃该条 AI 填充') : `失败：${r.reason}`)
    await fetchQueues()
  }
  const openInfoCustomer = async (accountId: number) => {
    const rows = await fetchAll()
    const hit = rows.find((x: any) => Number(x.id) === accountId)
    if (hit) await openCustomer(hit)
  }

  // ─── 管理动作（收入档案区 / 更多菜单，不做表格行按钮）──────────────────────
  const runEnrichOne = async (c: any) => {
    if (!c.session_id) { setNotice('该客户未关联微信会话，无法 AI 补全'); return }
    setNotice(`AI 正在补全 ${c.name}…`)
    const r = await window.electronAPI.crm.enrichRun(String(c.session_id), c.name)
    setNotice(r.ok ? `${c.name}：自动写入 ${(r.updated || []).length} 项${(r.pending || []).length ? `，${(r.pending || []).length} 项待确认（页面顶部处理）` : ''}${r.reason && !(r.updated || []).length ? `（${r.reason}）` : ''}` : `AI 补全失败：${r.reason}`)
    await fetchAll()
    if (selectedCustomer?.id === c.id) await openCustomer(c)
  }
  const genDeepAnalysis = async (c: any) => {
    if (!c.session_id) { setNotice('该客户未关联微信会话，无法深度分析'); return }
    deepReqRef.current = Number(c.id)
    setDeepLoading(true)
    setDeepReport('')
    const r = await window.electronAPI.crm.customerDeepAnalysis(String(c.session_id), c.name)
    if (deepReqRef.current !== Number(c.id)) return // 期间已切换客户：丢弃过期报告（loading 已由 openCustomer 复位）
    setDeepLoading(false)
    if (r.ok && r.report) setDeepReport(r.report)
    else setNotice(`深度分析失败：${r.reason}`)
  }
  const genAiQuotation = async (c: any) => {
    if (!c.session_id) { setNotice('该客户未关联微信会话，无法 AI 报价'); return }
    setNotice('AI 正在提取需求并选型…')
    const r = await window.electronAPI.crm.quotationAi(String(c.session_id), c.name)
    if (r.ok) setNotice(`AI 报价单已生成（${r.matched?.map((m) => m.productName).join('、') || ''}）`)
    else setNotice(`AI 报价失败：${r.reason}`)
  }
  // 建合同跨页：跳转合同页并预选客户（/crm?account=<id>&new=1）
  const createContractForCustomer = (c: any) => {
    navigate(`/crm?account=${Number(c.id)}&new=1`)
  }
  const deleteCustomer = async (c: any) => {
    const ok = window.confirm(`确定删除客户「${c.name}」？\n将一并删除该客户的全部合同及其报价单、发票、物流、回款归属等数据。\n（删除前会自动备份数据库）`)
    if (!ok) return
    const r = await window.electronAPI.crm.customerDelete(c.id)
    setNotice(r.ok ? `已删除客户「${c.name}」` : `删除失败：${r.reason}`)
    if (r.ok) { await fetchAll(); if (selectedCustomer?.id === c.id) setSelectedCustomer(null) }
  }

  // ─── 更多菜单：批量补全 / 导出 / AI 准确率 ─────────────────────────────────
  const [showMore, setShowMore] = useState(false)
  const [showInfoPending, setShowInfoPending] = useState(true) // 页面顶部「信息待确认」折叠
  const [backfilling, setBackfilling] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [accuracy, setAccuracy] = useState<any>(null)
  const [accuracyOpen, setAccuracyOpen] = useState(false)
  const runBackfill = async () => {
    setBackfilling(true)
    setNotice('批量 AI 补全进行中（串行执行，可能需要一两分钟）…')
    try {
      const r = await window.electronAPI.crm.enrichBackfill()
      setNotice(`批量 AI 补全完成：处理 ${r.processed} 个客户，有更新 ${r.updated}，失败 ${r.failed}`)
    } catch (e) { setNotice(`批量补全失败：${e}`) }
    setBackfilling(false)
    await fetchAll()
  }
  const doExport = async () => {
    setExporting(true)
    try {
      const r = await (window as any).electronAPI.sales.customerExport()
      setNotice(r?.success && r?.filePath ? `已导出 ${r.count ?? 0} 个客户：${r.filePath}` : `导出失败：${r?.error || '未知错误'}`)
    } catch (e) { setNotice(`导出失败：${e}`) }
    setExporting(false)
  }
  const toggleAccuracy = async () => {
    const next = !accuracyOpen
    setAccuracyOpen(next)
    if (next && !accuracy) {
      try { setAccuracy(await window.electronAPI.crm.statsAiAccuracy(7)) } catch { /* ignore */ }
    }
  }

  // ─── 渲染 ─────────────────────────────────────────────────────────────────
  const viewList: Record<ViewTab, any[]> = { follow: followList, insight: insightList, all: allList }
  const list = viewList[tab]
  const countBadge = (t: ViewTab) => (t === 'follow' ? followList.length : t === 'insight' ? insightList.length : customers.length)

  return (
    <div className="cws-page">
      <div className="crm-header">
        <h2><Users size={18} /> 客户工作台</h2>
        <button className="crm-btn crm-btn--ghost" onClick={() => { void fetchAll(); void fetchQueues() }}><RefreshCw size={14} /> 刷新</button>
        <div className="cws-more">
          <button className="crm-btn" onClick={() => setShowMore((v) => !v)}><Plus size={14} /> 更多</button>
          {showMore && (
            <div className="cws-menu">
              <button className="cws-menu__item" onClick={() => { setShowMore(false); void runBackfill() }} disabled={backfilling}>
                <Sparkles size={13} /> {backfilling ? 'AI 补全中…' : '批量 AI 补全'}
              </button>
              <button className="cws-menu__item" onClick={() => { setShowMore(false); void doExport() }} disabled={exporting}>
                <Download size={13} /> {exporting ? '导出中…' : '导出全部客户 Excel'}
              </button>
              <button className="cws-menu__item" onClick={() => { setShowMore(false); void toggleAccuracy() }}>
                📊 AI 准确率（近 7 天）
              </button>
            </div>
          )}
        </div>
      </div>
      {notice && <div className="crm-notice">{notice}</div>}

      {accuracyOpen && accuracy && (
        <div className="crm-accuracy">
          <button className="crm-accuracy__head" onClick={() => setAccuracyOpen(false)}>
            <span>📊 AI 准确率（近 7 天）</span>
            <span className="crm-accuracy__toggle">收起 ▲</span>
          </button>
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
        </div>
      )}


      <div className="cws-tabs">
        {(['follow', 'insight', 'all'] as ViewTab[]).map((t) => (
          <button key={t} className={`cws-tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
            {t === 'follow' ? '⚡ 值得跟进' : t === 'insight' ? '✨ AI 新发现' : '👥 全部客户'} ({countBadge(t)})
          </button>
        ))}
        {tab === 'all' && (
          <div className="crm-filter-bar cws-toolbar">
            <input className="cws-search" placeholder="搜索客户名/公司…" value={search} onChange={(e) => setSearch(e.target.value)} />
            <select className="crm-filter-select" value={stageFilter} onChange={(e) => setStageFilter(e.target.value)}>
              <option value="">全部阶段</option>
              {stageOptions.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        )}
      </div>

      {queues.infoPending.length > 0 && (
        <div className="crm-info-pending">
          <button className="crm-info-pending__head" onClick={() => setShowInfoPending((v) => !v)}>
            <span>⚡ 信息待确认 {queues.infoPending.length} 条 · AI 中置信发现，采纳后写入档案</span>
            <span className="crm-info-pending__toggle">{showInfoPending ? '收起 ▲' : '展开 ▼'}</span>
          </button>
          {showInfoPending && (
            <div className="crm-info-pending__list">
              {queues.infoPending.map((it: any) => (
                <div key={`${it.account_id}-${it.field}`} className="crm-info-pending__item">
                  <div className="crm-info-pending__main">
                    <div className="crm-info-pending__title">
                      <strong>{it.account_name}</strong> · {FIELD_LABELS_WB[it.field] || it.field} → {it.value}
                      <span className="crm-pill crm-pill--warn">待确认</span>
                      <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>置信 {Math.round((it.confidence || 0) * 100)}%</span>
                    </div>
                    {it.evidence && <div className="crm-info-pending__evi">证据 ·「{String(it.evidence).slice(0, 40)}」</div>}
                  </div>
                  <div className="crm-info-pending__ops">
                    <button className="crm-btn primary" onClick={() => void applyInfo(it, 'accept')}>采纳</button>
                    <button className="crm-btn" onClick={() => void applyInfo(it, 'reject')}>放弃</button>
                    <button className="crm-btn" onClick={() => void openInfoCustomer(Number(it.account_id))}>查看档案</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}


      <div className="cws-grid">
        {list.map((c: any) => {
          const sig = signalOf(c)
          const sigSource = sig ? (withTask(sig) ? (sig.sources || []).find((src: any) => src.type === 'task') : sig.sources?.[0]) : null
          const nextMove = sig?.analysis || sigSource?.reason || ''
          const silent = silentDaysOf(c)
          const active = selectedCustomer?.id === c.id
          return (
            <div key={c.id} className={`cws-card ${active ? 'active' : ''}`} onClick={() => void openCustomer(c)}>
              <div className="cws-card__head">
                <Avatar src={(c as any).avatarUrl} name={displayNameOf(c)} size={32} />
                <span className="cws-card__name" title="查看客户 360 档案">{displayNameOf(c)}{c.session_id ? <span className="crm-badge">AI</span> : ''}</span>
                <span className="crm-badge cws-card__stage">{rowStage(c)}</span>
              </div>
              <div className="cws-card__company">{c.company || <span className="crm-muted">未填公司</span>}</div>
              {silent != null && (
                <div className="cws-card__silence"><Clock size={12} /> {silent} 天未互动</div>
              )}
              {sigSource && (
                <div className="cws-card__signal">
                  <span className="cws-card__signal-tag">{sigSource.label || '信号'}</span>
                  <span className="cws-card__signal-text">{sigSource.reason || nextMove || sigSource.insightText || ''}</span>
                </div>
              )}
              <div className="cws-card__actions" onClick={(e) => e.stopPropagation()}>
                {sig && (
                  <button className="crm-btn primary cws-card__complete" disabled={completing === String(c.id)} onClick={() => void completeSignal(c)}>
                    <CheckCircle2 size={13} /> {completing === String(c.id) ? '完成中…' : '完成'}
                  </button>
                )}
                <button className="crm-btn" onClick={() => void openChat(c)} disabled={!c.session_id}><MessageCircle size={13} /> 打开聊天</button>
                <button className="crm-btn" onClick={() => { void openCustomer(c); void genDeepAnalysis(c) }}><Sparkles size={13} /> AI 深度分析</button>
              </div>
            </div>
          )
        })}
        {list.length === 0 && (
          <div className="crm-empty">
            {customers.length === 0
              ? '暂无客户 —— 在「设置 → AI 画像」生成客户画像后，有意向的客户会自动导入这里'
              : tab === 'follow' ? '暂无需要跟进的客户，去看看全部客户' : tab === 'insight' ? '暂无新的 AI 洞察' : '该阶段/搜索无客户'}
          </div>
        )}
      </div>

      {selectedCustomer && (
        <div className="cws-drawer" onClick={() => setSelectedCustomer(null)}>
          <div className="cws-drawer__panel" onClick={(e) => e.stopPropagation()}>
          <div className="crm-detail">
          <div className="crm-detail-head">
            <h3>{displayNameOf(selectedCustomer)} · 客户档案</h3>
            <div className="crm-detail-actions">
              <button className="crm-btn" onClick={() => void openChat(selectedCustomer)} disabled={!selectedCustomer.session_id}><MessageCircle size={14} /> 打开聊天</button>
              <button className="crm-btn" onClick={() => void runEnrichOne(selectedCustomer)} disabled={!selectedCustomer.session_id}><Sparkles size={13} /> AI 补全</button>
              <button className="crm-btn" onClick={() => void genDeepAnalysis(selectedCustomer)}><Sparkles size={13} /> {deepLoading ? '分析中…' : '深度分析'}</button>
              <button className="crm-btn" onClick={() => void genAiQuotation(selectedCustomer)}><Sparkles size={13} /> AI 报价</button>
              <button className="crm-btn primary" onClick={() => void createContractForCustomer(selectedCustomer)}><Plus size={14} /> 建合同</button>
              <button className="crm-btn crm-btn--ghost cws-drawer__close" title="关闭档案（点击遮罩也可关闭）" onClick={() => setSelectedCustomer(null)}><X size={15} /></button>
            </div>
          </div>
          {profileLoading && <div className="crm-insight">加载档案…</div>}
          {!selectedCustomer.session_id && <div className="crm-insight">（未关联微信会话，无 AI 档案）</div>}
          {!profileLoading && selectedCustomer.session_id && customerProfile && (
            <div className="crm-profile">
              <div className="crm-profile__section">
                <h4>客户信息 <span className="crm-profile__hint">点击字段可编辑，手改后 AI 不再覆盖</span></h4>
                <div className="crm-row" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span>客户类型</span>
                  {customerProfile.customer ? (
                    <select
                      className="crm-filter-select"
                      value={String(customerProfile.customer.type || '')}
                      onChange={(e) => void saveCustomerType(e.target.value)}
                    >
                      <option value="">未设置</option>
                      <option value="dealer">经销商</option>
                      <option value="end_user">终端客户</option>
                    </select>
                  ) : (
                    <span className="crm-muted">未建档（account 未挂接 customer，存量迁移后可用）</span>
                  )}
                </div>
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
                      // Customer 360：CRM 业务动作（后端已聚合 6 实体）+ 线索流转 + 商机事件 + AI 见解，一条流混排
                      ...(customerProfile.activities || []).map((a: any) => ({ at: Number(a.at ?? a.created_at ?? 0), kind: String(a.kind || 'crm'), text: String(a.text || a.detail || a.action || '') })),
                      ...(customerProfile.insights || []).map((i: any) => ({ at: Number(i.createdAt || 0), kind: 'insight', text: String(i.insight || '') }))
                    ].sort((x: any, y: any) => y.at - x.at).slice(0, 40).map((e: any, idx: number) => (
                      <div key={idx} className="crm-timeline__item">
                        <span className="crm-timeline__time">{new Date(e.at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                        <span className={`crm-timeline__tag ${e.kind}`}>{TIMELINE_KIND_LABEL[e.kind] || 'CRM'}</span>
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
              {customerProfile.currentView && (
                <div className="crm-profile__section">
                  <h4>AI 当前判断</h4>
                  <div className="crm-insight">
                    {(() => {
                      const j: any = customerProfile.currentView.judgments || {}
                      const cards = [
                        { label: '总结', v: j.summary },
                        { label: '机会', v: j.opportunity },
                        { label: '风险', v: j.risk },
                        { label: '下一步', v: j.nextAction }
                      ]
                      const present = cards.filter((c) => c.v)
                      if (!present.length) {
                        return <div className="ai-row"><span className="cws-j-empty">暂无 AI 判断（系统扫描/预热时生成，打开档案不现场生成）</span></div>
                      }
                      return present.map((c) => (
                        <div key={c.label} className="ai-row">
                          <span className="ai-row__label">{c.label}</span>
                          <span className="ai-row__value">
                            {String(c.v.value || '')}
                            {c.v.freshness === 'stale' && <span className="cws-j-badge cws-j-badge--stale" title="生成已超 24h，可能过时">较旧</span>}
                            {c.v.source === 'manual' && <span className="cws-j-badge cws-j-badge--manual">人工</span>}
                            {c.v.evidenceStatus === 'ok' && c.v.messageKey && (
                              <button className="cws-j-evidence" onClick={() => void toggleEvidence(c.v)}>
                                {evidenceKey === c.v.messageKey ? (evidenceMsg && !evidenceMsg.startsWith('正在') ? '收起' : '回查中…') : '有据可查'}
                              </button>
                            )}
                          </span>
                          {evidenceKey === c.v.messageKey && evidenceMsg && (
                            <div className="cws-j-evidence-text">{evidenceMsg}</div>
                          )}
                        </div>
                      ))
                    })()}
                  </div>
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
                <div className="crm-row">
                  <button className="crm-btn danger" onClick={() => void deleteCustomer(selectedCustomer)}><Trash2 size={13} /> 删除客户</button>
                </div>
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
          </div>
        </div>
      )}
    </div>
  )
}
