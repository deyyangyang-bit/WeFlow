/**
 * TodayActionPage.tsx — 统一信号流首页(v4 布局)
 *
 * 结构：header(标题 + 销售复盘 / 重算 / 新建待办) → 开工简报(.notice--brief：这份判断基于什么)
 *       → KPI 单行条(.stats) → 主主张(.lead-card)
 *       → 主两栏(左:筛选chips+信号卡流 | 右:待办侧栏)
 *       → 可折叠「数据概览」(来源/紧急度/阶段)
 *
 * 2026-09-18 P1.6（观感细修，纯视觉）：顶栏动作全降次要档（复盘/重算 quiet、新建描边）；
 * 信号行动作行降文字链档（AIActionCard），右栏待办对齐 Chat/客户 side-head 节奏；
 * 简报覆盖 tag / meta 数值再安静一档（本页 scss 作用域）。骨架、口径、逻辑均不变。
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useWxidRefresh } from '../utils/useWxidRefresh'
import { useNavigate } from 'react-router-dom'
import {
  Activity, BarChart3, ChevronDown, ChevronLeft, ChevronRight, ChevronUp,
  ListTodo, Plus, RefreshCw, Sunrise, X,
} from 'lucide-react'
import AIActionCard from '../components/sales/AIActionCard'
import TodoSidebar from '../components/sales/TodoSidebar'
import { useTodayActionStore, type SignalFilter } from '../stores/todayActionStore'
import './TodayActionPage.scss'

const CHIPS: { key: SignalFilter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'task', label: '该联系' },
  { key: 'urgent', label: '紧急' },
]

const STAGE_LABELS: Record<string, string> = {
  contacted: '沟通', quoted: '报价', negotiating: '谈判',
  unknown: '未知', new: '新客', dormant: '沉默',
}
const STAGE_COLORS: Record<string, string> = {
  contacted: '#8b5cf6', quoted: '#f59e0b', negotiating: '#ef4444',
  unknown: '#9ca3af', new: '#3b82f6', dormant: '#6b7280',
}

/** 简报六态（PRD §6.1）——键必须覆盖 coverage.state 的全部取值，避免漏态回退到错误结论 */
type DigestStateKey = 'empty_account' | 'crm_only' | 'pending_data' | 'all_covered_clear' | 'failed_or_blocked' | 'stale_snapshot'

/** 六态 → 左侧 2px 色条的轻重（概念稿：核验通过 accent / 覆盖不全与旧快照 warn / 失败与阻断 stop）。
 *  此前六态共用一条蓝，失败态看起来和成功态一样 —— 轻重必须由色条承担，态名另用文字标出。
 *  注意 pending_data 是「有事项」的常态（覆盖完整也走这一态），只有真的漏了或失败了会话才降级为 warn；
 *  判定口径与 coverage.message 里那句「另有 N 个会话未处理 · 部分未完成」一致，不把正常态一律标黄。 */
function digestTone(state: string | undefined, coverage: any): string {
  if (state === 'failed_or_blocked') return 'notice--stop'
  if (state === 'crm_only' || state === 'stale_snapshot') return 'notice--warn'
  if (state === 'pending_data' && ((coverage?.pending || 0) > 0 || (coverage?.failedSessions || 0) > 0)) return 'notice--warn'
  return 'notice--accent'
}

/** 覆盖态 tag（概念稿 .notice__row 里的 .tag）：与 digestTone 同一套分档 —— 色条与态名不许说两件事。
 *  无 coverage（未核验）也必须有态名，否则「没看」会看起来像「看过了」 */
function digestTagLabel(state: string | undefined, coverage: any): string {
  switch (state) {
    case 'empty_account': return '本账号暂无沟通数据'
    case 'crm_only': return '仅业务事实'
    case 'all_covered_clear': return '已核对完成'
    case 'failed_or_blocked': return '分析未完成'
    case 'stale_snapshot': return '仅旧快照'
    case 'pending_data':
      return (coverage?.pending || 0) > 0 || (coverage?.failedSessions || 0) > 0 ? '覆盖不全' : '覆盖完整'
    default: return '覆盖未核验'
  }
}

/** 简报坐标时间（概念稿 .brief__meta）：区间到分钟、生成时刻到秒；无效值返回空串 —— 不伪造时间 */
function fmtBriefTime(ms: number, withSeconds = false): string {
  if (!ms || !Number.isFinite(ms)) return ''
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${withSeconds ? `${hm}:${p(d.getSeconds())}` : hm}`
}

export default function TodayActionPage() {
  const { items, stats, loading, error, filter, fetchToday, setFilter, createTodo } = useTodayActionStore()
  const [refreshing, setRefreshing] = useState(false)
  const [overviewOpen, setOverviewOpen] = useState(false)
  const [page, setPage] = useState(1)
  const navigate = useNavigate()

  // 新建待办弹窗
  const [showTodoModal, setShowTodoModal] = useState(false)
  const [todoTitle, setTodoTitle] = useState('')
  const [todoDue, setTodoDue] = useState('')
  const [todoError, setTodoError] = useState<string | null>(null)
  const [todoSubmitting, setTodoSubmitting] = useState(false)
  const [customers, setCustomers] = useState<Array<{ session_id: string; name?: string }>>([])
  const [customerSearch, setCustomerSearch] = useState('')
  const [customerOpen, setCustomerOpen] = useState(false)
  const [selectedCustomer, setSelectedCustomer] = useState<{ session_id: string; name?: string } | null>(null)

  // 晨间摘要（设计-AI见解重定位 §3.1）：每日一条「今天先跟谁」，取代高意向提示条
  // 六态（PRD §6.1）由 coverage.state 驱动；首屏时间预算 300ms/2s/>2s/10s 见下方 timers
  const [digest, setDigest] = useState<any>(null)
  const [digestDismissed, setDigestDismissed] = useState(false)
  const [digestRegenerating, setDigestRegenerating] = useState(false)
  const [digestError, setDigestError] = useState('')
  /** 业务库尚未就绪（启动早期/切账号重开库）：加载态的一种，不是错误、也不是空态 */
  const [digestNotReady, setDigestNotReady] = useState(false)
  /** 首屏阶段：frame(≤300ms 骨架) → local(≤2s 本地事项) → slow(>2s 明确加载态) → timeout(10s 报错+重试) */
  const [digestPhase, setDigestPhase] = useState<'frame' | 'local' | 'slow' | 'timeout' | 'ready'>('frame')
  /** 单飞（PRD §4.7 全局作用域）：任一识别进行中，识别与重生成两个入口同时禁用 */
  const [identifyBusy, setIdentifyBusy] = useState(false)
  const digestEpoch = useRef(0)
  const fetchDigest = useCallback(async () => {
    const epoch = digestEpoch.current
    try {
      const res = await (window as any).electronAPI.sales.morningDigestGet()
      if (epoch !== digestEpoch.current) return
      // 业务库尚未就绪（启动早期/切账号重开库）：保持加载态，交回时间预算状态机推进，不报错也不装作空
      if (res?.notReady) { setDigestNotReady(true); setDigestError(''); return }
      setDigestNotReady(false)
      setDigest(res?.ok ? res.data : null); setDigestError('')
      if (res?.ok && res.data) setDigestPhase('ready')
    } catch (e) { if (epoch === digestEpoch.current) setDigestError(String(e)) }
  }, [])
  const regenerateDigest = useCallback(async () => {
    const epoch = digestEpoch.current
    setDigestRegenerating(true); setDigestError('')
    try { await (window as any).electronAPI.sales.morningDigestRegenerate() }
    catch (e) { if (epoch === digestEpoch.current) setDigestError(String(e)) }
    if (epoch === digestEpoch.current) { await fetchDigest(); setDigestRegenerating(false) }
  }, [fetchDigest])
  // 打开弹窗时拉取客户列表（可选关联），重置表单
  const openTodoModal = useCallback(async () => {
    setShowTodoModal(true)
    setTodoTitle('')
    setTodoDue('')
    setTodoError(null)
    setCustomerSearch('')
    setSelectedCustomer(null)
    setCustomerOpen(false)
    try {
      const rows = await (window as any).electronAPI.crm.customers()
      setCustomers(Array.isArray(rows) ? rows : [])
    } catch { setCustomers([]) }
  }, [])

  const filteredCustomers = useMemo(() => {
    const kw = customerSearch.trim().toLowerCase()
    return kw
      ? customers.filter(c => String(c.name || '').toLowerCase().includes(kw) || String(c.session_id || '').toLowerCase().includes(kw)).slice(0, 20)
      : customers.slice(0, 20)
  }, [customers, customerSearch])

  const submitTodo = useCallback(async () => {
    const title = todoTitle.trim()
    if (!title || todoSubmitting) return
    setTodoSubmitting(true)
    setTodoError(null)
    const res = await createTodo({
      title,
      session_id: selectedCustomer?.session_id || undefined,
      due_at: todoDue ? new Date(todoDue).getTime() : undefined
    })
    setTodoSubmitting(false)
    if (res.ok) setShowTodoModal(false)
    else setTodoError(res.error || '创建失败')
  }, [todoTitle, todoDue, selectedCustomer, todoSubmitting, createTodo])

  // 卡片流分页：每页条数（信号卡较高，10 条一页避免页面过长）
  const PAGE_SIZE = 10

  useEffect(() => { fetchToday() }, [fetchToday])
  useEffect(() => {
    // 首屏时间预算（PRD §5.1）：不阻塞、不伪装为空——超时明确报错并给重试
    setDigestPhase('frame')
    const t300 = setTimeout(() => setDigestPhase(p => (p === 'frame' ? 'local' : p)), 300)
    const t2000 = setTimeout(() => setDigestPhase(p => (p === 'ready' ? p : 'slow')), 2_000)
    const t10000 = setTimeout(() => setDigestPhase(p => (p === 'ready' ? p : 'timeout')), 10_000)
    void fetchDigest()
    // 「每天第一次打开」是唯一自动触发点（PRD §4.1）；同日幂等由主进程保证
    void (window as any).electronAPI.sales.morningDigestGenerate()
    const timer = setInterval(() => { void fetchDigest() }, 5_000)
    // 单飞状态订阅：任一识别起止都同步（全局作用域）
    let off: (() => void) | undefined
    try {
      const api = (window as any).electronAPI.sales
      void api.identifyState?.().then((s: any) => setIdentifyBusy(!!s?.busy)).catch(() => undefined)
      off = api.onIdentifyActivity?.((s: any) => {
        setIdentifyBusy(!!s?.busy)
        // 识别结束 → 简报可能刚被解锁，补一次生成与读取
        if (!s?.busy) { void (window as any).electronAPI.sales.morningDigestGenerate(); void fetchDigest() }
      })
    } catch { /* 单飞订阅失败不阻断页面 */ }
    return () => {
      clearTimeout(t300); clearTimeout(t2000); clearTimeout(t10000)
      clearInterval(timer); digestEpoch.current++; if (off) off()
    }
  }, [fetchDigest])
  // 首屏阶段到达 10s 且仍无简报 → 明确报错（不是空态）
  const digestTimedOut = digestPhase === 'timeout' && !digest
  // 切微信号 = 换库（§2.40）：账号切换后重查
  useWxidRefresh(() => {
    digestEpoch.current++; setDigest(null); setDigestError(''); setDigestNotReady(false); setDigestDismissed(false); setDigestRegenerating(false)
    void fetchToday(); void fetchDigest(); void (window as any).electronAPI.sales.morningDigestGenerate()
  })

  const handleRefresh = useCallback(async () => {
    setRefreshing(true)
    void (window as any).electronAPI.sales.actionRefresh()
    await fetchToday()
    setRefreshing(false)
  }, [fetchToday])

  // 筛选
  const filtered = useMemo(() => {
    if (filter === 'all') return items
    // 「该联系」= 含待办来源的卡。用 some 而非 every：商机信号会并入同客户卡，
    // 若按 every 判定，被并入了报价/风险理由的卡会从本筛选中静默消失（与 customerActionQueue 的 withTask 同口径）
    if (filter === 'task') return items.filter(i => i.sources.some(s => s.type === 'task'))
    if (filter === 'urgent') return items.filter(i => i.urgencyTier === 'urgent')
    return items
  }, [items, filter])

  // 切筛选时回到第一页
  useEffect(() => { setPage(1) }, [filter])

  // 主主张（概念稿 .lead-card）：排序首位浮在信号列表上方，其余仍走细线索引。
  // 同一批线索不在屏幕上出现两遍 —— 提升的那条不再重复进列表。
  const leadItem = filtered.length > 0 ? filtered[0] : null
  const restItems = useMemo(() => (filtered.length > 1 ? filtered.slice(1) : []), [filtered])

  // 分页切片（page 超出范围时钳制到最后一页，避免刷新后空页）
  const pageCount = Math.max(1, Math.ceil(restItems.length / PAGE_SIZE))
  const curPage = Math.min(Math.max(1, page), pageCount)
  const pageItems = useMemo(
    () => restItems.slice((curPage - 1) * PAGE_SIZE, curPage * PAGE_SIZE),
    [restItems, curPage],
  )

  // 简报只报数量，不报标题：事项本身交给下方信号列表与右侧待办，同屏出现两遍等于把列表读两次
  const digestItemCount = digest?.items?.length || 0
  const digestToneClass = digestTone(digest?.coverage?.state, digest?.coverage)
  // 覆盖态 tag：色条说轻重，文字说态名（概念稿「态名另用文字标出」）
  const digestTag = digestTagLabel(digest?.coverage?.state, digest?.coverage)
  // 简报坐标（概念稿 .brief__meta）：只填真取到的字段，缺哪段略哪段 —— 不补默认值、不假造区间
  const briefMeta = useMemo(() => {
    if (!digest) return [] as ReactNode[]
    const cov = digest.coverage
    const parts: ReactNode[] = []
    if (cov?.activeSessions > 0) parts.push(<>已核对 <b>{cov.analyzedSessions}</b> / <b>{cov.activeSessions}</b> 段会话</>)
    const from = fmtBriefTime(Number(cov?.from || 0) * 1000)
    const to = fmtBriefTime(Number(cov?.to || 0) * 1000)
    if (from && to) parts.push(<>区间 <b>{from}</b> – <b>{to}</b></>)
    const generatedAt = fmtBriefTime(Number(digest.createdAt || 0), true)
    if (generatedAt) parts.push(<>生成于 <b>{generatedAt}</b></>)
    return parts
  }, [digest])
  // 覆盖缺口与失败原因（概念稿块外的补充行）：accent 常态下与 .brief__meta 同源重复，只在 warn·stop 与未核验时出现
  const briefNote = digest
    ? (digestToneClass === 'notice--accent' && digest.coverage
      ? ''
      : String(digest.coverage?.message || '聊天分析覆盖尚未核验，不代表已分析全部消息'))
    : ''
  // 收起后的入口文案：把「不可当作已核对」的口径带在入口上，收起不等于结论已成立
  const reopenNote = digest?.coverage?.pending > 0
    ? `仍有 ${digest.coverage.pending} 段会话未核对，不代表「无需跟进」`
    : digest?.coverage?.state === 'failed_or_blocked' ? '有未完成分析'
      : digest?.coverage?.state === 'stale_snapshot' ? '仅旧快照' : ''
  /** 未核对的会话数（未处理 + 失败）：只用于把「查看未核对会话」的去向说清，不做第二份列表 */
  const unverifiedSessions = (digest?.coverage?.pending || 0) + (digest?.coverage?.failedSessions || 0)
  // 简报上的两个入口（查看未核对会话 / 事项计数）都落到同一处：下方信号与右侧待办。
  // 覆盖暂无「未核对会话」的逐条列表或深链，按既有 UI 就地滚过去 —— 不新造后端，也不假造一份列表。
  const revealSignals = useCallback(() => {
    document.querySelector('.today-action-page__main')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])

  // chips 计数
  const chipCounts = useMemo(() => ({
    all: items.length,
    task: items.filter(i => i.sources.some(s => s.type === 'task')).length,
    urgent: items.filter(i => i.urgencyTier === 'urgent').length,
  }), [items])

  // 概览:阶段分布
  const stageCounts = useMemo(() => {
    const m: Record<string, number> = {}
    for (const item of items) {
      const s = item.stage || 'unknown'
      m[s] = (m[s] || 0) + 1
    }
    return Object.entries(m).sort((a, b) => b[1] - a[1])
  }, [items])
  const maxStageCount = Math.max(1, ...stageCounts.map(([, c]) => c))

  return (
    <div className="today-action-page">
      {/* 页眉（概念稿 .shead）：小标 → 一句主张 → 真实计数说明；右侧动作 */}
      <div className="shead">
        <div>
          <p className="eyebrow">{new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })}</p>
          <h1 className="hero">今天先跟谁</h1>
          <p className="sub">
            共 {filtered.length} 条信号{chipCounts.urgent > 0 ? ` · 其中紧急 ${chipCounts.urgent} 条` : ''}
            {stats ? ` · 高优行动 ${stats.highPriorityCount} 条` : ''}
          </p>
        </div>
        <div className="shead__actions">
          {/* P1.6：顶栏动作全部降为次要档（复盘/重算 quiet、新建描边），页头不放实心主色 ——
              今日页的主张是信号本身，动作不抢（新建待办在弹窗内仍走主按钮档） */}
          <button className="btn btn--quiet" onClick={() => navigate('/sales-report')}>
            <BarChart3 size={14} strokeWidth={1.6} /> 销售复盘
          </button>
          <button className="btn btn--quiet" onClick={() => void handleRefresh()} disabled={refreshing}>
            <RefreshCw size={14} className={refreshing ? 'spinning' : ''} strokeWidth={1.6} /> 重算今日信号
          </button>
          <button className="btn btn--plain" onClick={() => void openTodoModal()}>
            <Plus size={14} strokeWidth={1.6} /> 新建待办
          </button>
        </div>
      </div>

      {/* 晨间摘要（设计-AI见解重定位 §3.1；§3.2 起原「高意向动向」提示条已随 insight 卡流一并移除）
          PRD §6.1 六态 + §6.2 单飞：任何失败/额度阻断都不得显示为「无风险/无需跟进/全部跟完」 */}
      {/* 收起后的重开入口（概念稿 .brief-reopen）：前提跟着入口走，收起不等于结论已成立 */}
      {digestDismissed && (
        <button className="brief-reopen" onClick={() => setDigestDismissed(false)}>
          <Sunrise size={14} strokeWidth={1.6} /> 展开开工简报{reopenNote ? ` · ${reopenNote}` : ''}
        </button>
      )}
      {/* 开工简报（概念稿 .notice--accent.notice--brief / #digestBox）：整屏的前提，不是又一份列表 ——
          六态口径 + 覆盖区间 + 生成时间 + 事项计数；事项本身交给下方「信号」与右侧「今日待办」，
          那是同一批线索 ID，不该在同一屏出现两遍。 */}
      {!digestDismissed && <section className={`notice ${digestToneClass} notice--brief`} aria-label="当前账号开工简报">
        <Sunrise size={16} strokeWidth={1.6} />
        <div className="brief__body">
          {/* 标题行 + 动作（概念稿 .notice__row）：态名跟在标题后，动作与标题同排 */}
          <div className="notice__row">
            <span className="notice__h">
              开工简报 · 仅当前账号
              <span className="tag tag--plain" style={{ marginLeft: 6 }}>{digestTag}</span>
            </span>
            <span className="notice__acts">
              <button className="btn btn--sm btn--quiet" onClick={revealSignals}
                title={unverifiedSessions > 0
                  ? `另有 ${unverifiedSessions} 段会话未核对，先看下方信号与待办`
                  : '本次覆盖已核对完成，下方为已记录的事项'}>
                查看未核对会话
              </button>
              {/* §5.3 全局「重新生成简报」：命名即定位——它是简报的手动版，不叫「重新梳理」 */}
              <button className="btn btn--sm btn--quiet" disabled={digestRegenerating || identifyBusy}
                title={identifyBusy ? '正在识别中，请稍候' : undefined}
                onClick={() => void regenerateDigest()}>
                {digestRegenerating ? '正在生成…' : identifyBusy ? '识别中…' : '重新生成简报'}
              </button>
              <button className="btn btn--sm btn--quiet" onClick={() => setDigestDismissed(true)}>收起</button>
            </span>
          </div>
          {/* 一行能拿去核对的等宽坐标：已核对 a/b · 区间 · 生成于；缺字段略该段（不假造） */}
          {briefMeta.length > 0 && (
            <p className="brief__meta">
              {briefMeta.map((part, i) => <Fragment key={i}>{i > 0 && ' · '}{part}</Fragment>)}
            </p>
          )}
          {/* 态一/二/三/四/五/六：coverage 决定展示口径；无 coverage 时按「未核验」处理 */}
          {briefNote && <p className="brief__note">{briefNote}</p>}
          {/* 首屏时间预算：>2s 明确加载态，10s 明确报错 —— 都不伪装成空 */}
          {!digest && !digestTimedOut && (
            <p>{digestPhase === 'frame' ? '正在打开开工简报…'
              : digestPhase === 'local' ? `本地事项 ${items.length} 条；正在梳理近期会话…`
                : '本地事项已就绪，仍在梳理近期会话（分析进行中，可先处理下方事项）'}</p>
          )}
          {digestTimedOut && (
            <p role="alert">{digestNotReady
              ? '业务库尚未就绪（正在打开当前账号数据），暂无简报。'
              : '简报生成超时（10s 未返回）。'}未完成的聊天分析不会被当作「无需跟进」。
              <button className="btn btn--sm btn--quiet" onClick={() => { setDigestPhase('frame'); void (window as any).electronAPI.sales.morningDigestGenerate(); void fetchDigest() }}>重试</button>
            </p>
          )}
          {digestError && <p role="alert">{digestError} <button className="btn btn--sm btn--quiet" onClick={() => void fetchDigest()}>重试</button></p>}
          {/* 简报只讲前提：计数一行说清有几条，标题不在块里再列一遍（概念稿 .brief__count） */}
          {digest && digestItemCount > 0 && (
            <p className="brief__count">
              <button type="button" className="brief__count-link" onClick={revealSignals}>
                简报共 <b>{digestItemCount}</b> 条事项 · 全部列在下方信号列表
              </button>
            </p>
          )}
          {digest && digestItemCount === 0 && (() => {
            const st = digest.coverage?.state as DigestStateKey | undefined
            return <>
              {/* 态四：全部覆盖且无有效待办；态一：新账号空态（提供建客户/建待办入口，不调 AI 凑摘要） */}
              {st === 'all_covered_clear' && <p>已完成全量覆盖核对，当前没有待跟进事项。</p>}
              {st === 'empty_account' && <p>还没有客户沟通记录，也没有待办。
                <button className="btn btn--sm btn--quiet" onClick={() => navigate('/customers')}>去绑定客户</button>
                <button className="btn btn--sm btn--quiet" onClick={() => void openTodoModal()}>新建待办</button>
              </p>}
              {(st === 'failed_or_blocked' || st === 'crm_only' || st === 'stale_snapshot') && (
                <p>暂无已记录的事项。注意：{digest.coverage?.reason || '聊天分析未完成'}，
                  这不代表「无需跟进」。</p>
              )}
              {!st && <p>当前暂无已记录的待办；聊天分析覆盖尚未核验，不代表「无需跟进」。</p>}
            </>
          })()}
        </div>
      </section>}

      {/* 四格数字条（概念稿 .stats/.stat）：整屏前提（简报）之后才是数字与列表 */}
      {stats && (
        <div className="stats">
          <div className="stat">
            <div className="stat__n">{stats.highPriorityCount}</div>
            <div className="stat__l">高优行动</div>
          </div>
          <div className="stat">
            <div className="stat__n">{stats.riskCustomerCount}</div>
            <div className="stat__l">沉默风险</div>
          </div>
          <div className="stat">
            <div className="stat__n">{stats.activeDeals}</div>
            <div className="stat__l">活跃商机</div>
          </div>
          <div className="stat">
            <div className="stat__n">{stats.totalSignals}</div>
            <div className="stat__l">待处理</div>
          </div>
        </div>
      )}

      {/* 主主张（概念稿 .lead-card 挂载点）：整幅浮在索引上方，四栏判断直接摊开。
          完整判断只留给被主张的这一位；其余信号仍是细线行，同一批线索不在同一屏出现两遍。 */}
      {leadItem && <AIActionCard key={leadItem.itemKey} item={leadItem} lead />}

      {/* 主两栏（概念稿 .cols：左索引 / 右待办细线栏） */}
      <div className="cols today-action-page__main">
        <div className="today-action-page__left">
          {/* 分段标题 + 筛选（概念稿 chipbar） */}
          <div className="seclabel">
            <span className="seclabel__t">信号</span>
            <span className="chipbar" role="tablist" aria-label="信号筛选">
              {CHIPS.map(c => (
                <button
                  key={c.key}
                  type="button"
                  role="tab"
                  aria-selected={filter === c.key}
                  className={`chip ${filter === c.key ? 'is-on' : ''}`}
                  onClick={() => setFilter(c.key)}
                >
                  {c.label}
                  <span className="chip__n">{chipCounts[c.key]}</span>
                </button>
              ))}
            </span>
          </div>

          {/* 错误 */}
          {error && (
            <div className="today-action-page__error">
              {error}
              <button onClick={fetchToday}>重试</button>
            </div>
          )}

          {/* 加载 */}
          {loading && items.length === 0 && (
            <div className="today-action-page__loading">
              <RefreshCw size={24} className="spinning" />
              <p>正在分析客户数据...</p>
            </div>
          )}

          {/* 空状态：不得宣称「全部跟完」——只有在覆盖已核对完成时才给出「无待跟进」结论 */}
          {!loading && filtered.length === 0 && !error && (
            <div className="signal-empty">
              {items.length > 0
                ? '这个筛选下暂无信号'
                : digest?.coverage?.state === 'all_covered_clear'
                  ? '已完成全量覆盖核对，当前没有待跟进事项'
                  : digest?.coverage?.state === 'empty_account'
                    ? '还没有客户沟通记录和待办'
                    : '当前没有已记录的事项；聊天分析覆盖尚未核验完成，不代表已经跟完'}
            </div>
          )}

          {/* 信号细线索引（主主张已在上方 .lead-card，不在列表里重复出现） */}
          {restItems.length > 0 && (
            <>
              <div className="siglist">
                {pageItems.map(item => (
                  <AIActionCard key={item.itemKey} item={item} />
                ))}
              </div>
              <p className="sub siglist__note">优先级分来自本机排序引擎，不对外暴露；点客户名进客户档案，点整行展开判断。</p>

              {/* 分页（计数全部取真实值） */}
              {pageCount > 1 && (
                <div className="signal-pagination">
                  <button
                    className="btn btn--sm signal-pagination__btn"
                    disabled={curPage === 1}
                    onClick={() => setPage(curPage - 1)}
                  >
                    <ChevronLeft size={14} strokeWidth={1.6} /> 上一页
                  </button>
                  <span className="num signal-pagination__info">
                    {curPage} / {pageCount} 页 · 共 {restItems.length} 条
                  </span>
                  <button
                    className="btn btn--sm signal-pagination__btn"
                    disabled={curPage === pageCount}
                    onClick={() => setPage(curPage + 1)}
                  >
                    下一页 <ChevronRight size={14} strokeWidth={1.6} />
                  </button>
                </div>
              )}
            </>
          )}
        </div>

        {/* 右栏:待办侧栏 */}
        <div className="today-action-page__right">
          <TodoSidebar />
        </div>
      </div>

      {/* 可折叠数据概览 */}
      <div className="overview-card">
        <button className="overview-card__toggle" onClick={() => setOverviewOpen(!overviewOpen)}>
          <span className="overview-card__title">
            <Activity size={14} /> 数据概览 · 来源 / 紧急度 / 阶段
          </span>
          {overviewOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </button>

        {overviewOpen && stats && stats.totalSignals > 0 && (
          <div className="overview-grid">
            {/* 来源分布 */}
            <div className="overview-section">
              <span className="overview-section__title">信号来源</span>
              <div className="overview-section__bar">
                {stats.taskOnly > 0 && (
                  <div className="overview-section__seg overview-section__seg--task" style={{ flex: stats.taskOnly }} title={`该联系 ${stats.taskOnly}`} />
                )}
                {stats.merged > 0 && (
                  <div className="overview-section__seg overview-section__seg--merged" style={{ flex: stats.merged }} title={`双重信号 ${stats.merged}`} />
                )}
                {stats.insightOnly > 0 && (
                  <div className="overview-section__seg overview-section__seg--insight" style={{ flex: stats.insightOnly }} title={`有动向 ${stats.insightOnly}`} />
                )}
              </div>
              <div className="overview-section__legend">
                {stats.taskOnly > 0 && <><span className="overview-section__dot overview-section__dot--task" /> 该联系 {stats.taskOnly}</>}
                {stats.merged > 0 && <><span className="overview-section__dot overview-section__dot--merged" /> 双重 {stats.merged}</>}
                {stats.insightOnly > 0 && <><span className="overview-section__dot overview-section__dot--insight" /> 有动向 {stats.insightOnly}</>}
              </div>
            </div>

            {/* 紧急度分布 */}
            <div className="overview-section">
              <span className="overview-section__title">紧急度</span>
              <div className="overview-section__urgency">
                {(['urgent', 'high', 'normal'] as const).map(tier => (
                  <div key={tier} className="overview-section__urgency-item">
                    <span className={`overview-section__urgency-dot overview-section__urgency-dot--${tier}`} />
                    <span className="overview-section__urgency-num">{items.filter(i => i.urgencyTier === tier).length}</span>
                    <span className="overview-section__urgency-label">{tier === 'urgent' ? '紧急' : tier === 'high' ? '高' : '常规'}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* 阶段分布 */}
            <div className="overview-section overview-section--wide">
              <span className="overview-section__title">客户阶段</span>
              <div className="overview-section__stages">
                {stageCounts.map(([stage, count]) => (
                  <div key={stage} className="overview-section__stage-bar">
                    <span className="overview-section__stage-label">{STAGE_LABELS[stage] || stage}</span>
                    <div className="overview-section__stage-track">
                      <div
                        className="overview-section__stage-fill"
                        style={{ width: `${(count / maxStageCount) * 100}%`, background: STAGE_COLORS[stage] || '#9ca3af' }}
                      />
                    </div>
                    <span className="overview-section__stage-count">{count}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 新建待办弹窗 */}
      {showTodoModal && (
        <div className="ta-modal-overlay" onClick={() => setShowTodoModal(false)}>
          <div className="ta-modal" onClick={(e) => e.stopPropagation()}>
            <div className="ta-modal__header">
              <h3 className="ta-modal__title"><ListTodo size={16} /> 新建待办</h3>
              <button className="ta-modal__close" onClick={() => setShowTodoModal(false)} aria-label="关闭">
                <X size={16} />
              </button>
            </div>

            <input
              className="ta-modal__input"
              placeholder="待办内容（如：下午联系王总确认合同）"
              value={todoTitle}
              onChange={(e) => setTodoTitle(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void submitTodo() }}
              autoFocus
            />

            {/* 关联客户（可选，搜索下拉） */}
            <div className="ta-customer-picker">
              <input
                className="ta-modal__input"
                placeholder="关联客户（可选，输入搜索）"
                value={selectedCustomer ? String(selectedCustomer.name || selectedCustomer.session_id) : customerSearch}
                onChange={(e) => { setSelectedCustomer(null); setCustomerSearch(e.target.value) }}
                onFocus={() => setCustomerOpen(true)}
                onBlur={() => setTimeout(() => setCustomerOpen(false), 150)}
              />
              {customerOpen && filteredCustomers.length > 0 && (
                <div className="ta-customer-list">
                  {filteredCustomers.map((c) => (
                    <button
                      key={String(c.session_id)}
                      className="ta-customer-item"
                      onMouseDown={() => { setSelectedCustomer(c); setCustomerSearch(''); setCustomerOpen(false) }}
                    >
                      <span className="ta-customer-item__name">{c.name || '未命名客户'}</span>
                      <span className="ta-customer-item__sid">{String(c.session_id).slice(0, 18)}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <input
              className="ta-modal__input"
              type="datetime-local"
              value={todoDue}
              onChange={(e) => setTodoDue(e.target.value)}
            />

            {todoError && <div className="ta-modal__error">{todoError}</div>}

            <div className="ta-modal__actions">
              <button className="ta-modal__cancel" onClick={() => setShowTodoModal(false)}>取消</button>
              <button className="ta-modal__submit" onClick={() => void submitTodo()} disabled={!todoTitle.trim() || todoSubmitting}>
                {todoSubmitting ? '添加中...' : '添加待办'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
