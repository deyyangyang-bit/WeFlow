/**
 * CustomerWorkspacePage.tsx —— AI 客户工作台（Customer Action Workspace）
 *
 * 产品原则：用户不维护 CRM，AI 维护 CRM——用户只做「看清单、打勾」。
 * 页面回答：谁值得看（行动信号）→ 为什么现在看（信号原因）→ 我要做什么（下一步）→ 做完系统怎么办（完成闭环）。
 *
 * 行动队列改版（设计稿-客户工作台简化 屏 1-4，2026-09-05）：
 *  - 默认页 = 行动队列一列卡：值得跟进（task 信号）+ 信息待确认（infoPending）+ AI 新发现（无 task 源信号）三源合并
 *    （buildActionQueue 纯函数构建，src/utils/customerActionQueue.ts）；处理完即消失。
 *  - 全部客户降级为搜索：有关键词（或阶段深链）才渲染结果列表；无关键词不铺全量卡（屏 3）。
 *  - 队列空 = 居中空态「都处理完了」（屏 2）。
 *  - 档案抽屉按「先看什么」重排：AI 当前判断 verdict 置顶 → 待办 → 客户信息 → 时间线/画像/业务折叠（屏 4）。
 *
 * 数据源（全部复用现有 IPC，无新增）：
 *  - 客户主数据：crm.customers()（account + profile_stage/profile_display_name 投影）
 *  - 行动信号：sales.actionGetUnified()（getUnifiedSignals，全量不截断，过滤 todo:/logi:/lead: 虚拟前缀）
 *  - 360 档案：crm.customerProfile(sessionId)
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useWxidRefresh } from '../utils/useWxidRefresh'
import { RefreshCw, Plus, X, Sparkles, Trash2, MessageCircle, Download, CheckCircle2, ClipboardCheck, RotateCw, Bot, Ban, Search, ChevronRight, AlertCircle } from 'lucide-react'
import { useHermesStore } from '../stores/hermesStore'
import { Avatar } from '../components/Avatar'
import { filterByOwner, isSalesView, identityLikeFromIpc, type IdentityLike } from '../utils/leadAssignmentView'
import { buildActionQueue, type ActionCardItem } from '../utils/customerActionQueue'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useCrmStore } from '../stores/crmStore'
import { stageToFunnel } from '../../shared/salesStage'
import * as configService from '../services/config'
import {
  addInsightBlacklistEntry,
  isInsightBlacklisted,
  removeInsightBlacklistEntry,
  type InsightBlacklistEntry
} from '../../shared/insightBlacklist'
import './CrmWorkbenchPage.scss'
import './CustomerWorkspacePage.scss'
// Customer 360 统一时间线：事件来源标签（crm=业务动作 / lead=线索流转 / opportunity=商机 / insight=AI 见解）
const TIMELINE_KIND_LABEL: Record<string, string> = { crm: 'CRM', lead: '线索', opportunity: '商机', insight: 'AI 见解' }
// 同上：来源标签 → 概念稿统一 .tag 语义档（4px 直角，不另起视觉语言）
const TIMELINE_TAG_CLASS: Record<string, string> = { crm: 'tag--neutral', lead: 'tag--warning', opportunity: 'tag--task', insight: 'tag--insight' }
// 客户 360：AI 填充字段视图
const FIELD_LABELS_WB: Record<string, string> = {
  company: '公司', position: '职位', phone: '电话', industry: '行业', province: '省份', city: '城市',
  needs: '需求', budget: '预算', intent_model: '意向型号', purchase_timeframe: '采购时间',
  competitor: '竞品', price_sensitive: '价格敏感度'
}
const ENRICH_FIELD_ORDER = ['company', 'position', 'phone', 'industry', 'province', 'city', 'needs', 'budget', 'intent_model', 'purchase_timeframe', 'competitor', 'price_sensitive']
const FORMAL_SET = new Set(['company', 'position', 'phone', 'industry', 'province', 'city'])

export default function CustomerWorkspacePage() {
  const { notice, setNotice, queues, fetchQueues } = useCrmStore()
  const navigate = useNavigate()

  // ─── 数据 ─────────────────────────────────────────────────────────────────
  const [customers, setCustomers] = useState<any[]>([])
  // 页面过滤档（2026-09-05 拍板）：销售视角只看 owner_sales=本人 或 未归属；展示层便利，非安全边界（宪法 §1.12）
  const [identity, setIdentity] = useState<IdentityLike>({ name: '', role: '' })
  const [signals, setSignals] = useState<any[]>([])
  const [search, setSearch] = useState('')
  const [stageFilter, setStageFilter] = useState('')
  // 处理成功即从队列移除：乐观移除键集（重新拉取后源数据已消失，键集可安全保留）
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())

  // 打开聊天：跳转到该客户的微信聊天页（需关联了微信会话 session_id）
  const openChat = (c: any) => {
    if (!c.session_id) { setNotice('该客户未关联微信会话，无法打开聊天'); return }
    navigate(`/chat?sessionId=${encodeURIComponent(c.session_id)}`)
  }

  // 拉取客户列表 + 行动信号（一次刷新两路数据）
  const fetchAll = async () => {
    const rows = (await window.electronAPI.crm.customers()) || []
    const idt = await window.electronAPI.identity.get().catch(() => ({ name: '', role: '', nameAliases: [] }))
    const idLike = identityLikeFromIpc(idt)
    setIdentity(idLike)
    setCustomers(filterByOwner(rows, idLike))
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
          // 防御旧值：漏斗下钻传中文档位，旧版曾传原始阶段串，统一过 stageToFunnel 归桶（幂等）。
          // 改版后阶段筛选只跟搜索态走：stageFilter 非空即进入搜索态（深链协议不变）
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
  // 最近互动文案（索引行次要列，等宽）
  const silentTextOf = (c: any) => {
    const d = silentDaysOf(c)
    return d == null ? '—' : d === 0 ? '今天有互动' : `${d} 天未互动`
  }
  // 卡片信号徽章：task 信号优先（R0-R8 跟进规则），否则 insight
  const signalOf = (c: any) => signalBySession.get(String(c.session_id || '')) || null

  // ─── 行动队列（屏 1）与搜索态（屏 3）──────────────────────────────────────
  const withTask = (s: any) => (s?.sources || []).some((src: any) => src.type === 'task')
  const sortByScore = (a: any, b: any) => (b.priorityScore ?? 0) - (a.priorityScore ?? 0)

  // 行动队列：三源合并（follow + infoPending + insight），乐观移除已处理键
  const actionQueue = useMemo(
    () => buildActionQueue(customers, signals, queues.infoPending || []).filter((it) => !dismissed.has(it.key)),
    [customers, signals, queues.infoPending, dismissed]
  )
  // 搜索态：关键词或阶段深链任一存在才渲染结果列表（无关键词不铺全量卡，屏 3）
  const searchKw = search.trim()
  const searchActive = !!searchKw || !!stageFilter
  const searchResults = useMemo(() => {
    if (!searchActive) return []
    const q = searchKw.toLowerCase()
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
  }, [customers, searchKw, stageFilter, searchActive, signalBySession]) // eslint-disable-line react-hooks/exhaustive-deps

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

  // 搜索态结果列表（概念稿细线索引 .tbl/.thead/.trow）：每页 10 条 + Pager；筛选变化回第 1 页
  const [searchPage, setSearchPage] = useState(1)
  useEffect(() => { setSearchPage(1) }, [searchKw, stageFilter])
  const INDEX_PAGE_SIZE = 10
  const indexTotalPages = Math.max(1, Math.ceil(searchResults.length / INDEX_PAGE_SIZE))
  const indexPage = Math.min(searchPage, indexTotalPages)
  const indexRows = searchResults.slice((indexPage - 1) * INDEX_PAGE_SIZE, indexPage * INDEX_PAGE_SIZE)
  // 阶段栏计数（概念稿 .rail__n）：口径 = 本页已过滤的客户全集，与 indexRows 同源
  const stageCounts: Record<string, number> = {}
  for (const c of customers) { const st = rowStage(c); stageCounts[st] = (stageCounts[st] || 0) + 1 }
  // 阶段 pill 语义档 → 全局 .pill 族（流失=中性 / 成交=won / 其余=new）
  const stagePillClass = (st: string) => (st === '流失' ? 'pill' : st === '成交' ? 'pill pill--won' : 'pill pill--new')
  // 行动卡 pill（来源语义由 buildActionQueue 给出）→ 全局 .pill 族
  const queuePillClass = (p: string) => (p === 'amber' ? 'pill pill--quote' : 'pill pill--new')

  // ─── 客户 360 档案 ─────────────────────────────────────────────────────────
  const [selectedCustomer, setSelectedCustomer] = useState<any>(null)
  // 档案抽屉（屏 4）：AI 工具下拉 + 折叠行（时间线/画像/业务默认收起，点开才渲染）
  const [showAiTools, setShowAiTools] = useState(false)
  /** AI 见解屏蔽名单（只影响自动/批量触发；本页只做手动加入与解除） */
  const [insightBlacklist, setInsightBlacklist] = useState<InsightBlacklistEntry[]>([])
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const list = await configService.getAiInsightNonCustomerBlacklist()
      if (!cancelled) setInsightBlacklist(list)
    })()
    return () => { cancelled = true }
  }, [])

  /**
   * 屏蔽 / 解除屏蔽所选客户的 AI 见解（决策：入口放客户工作台「…」菜单，带二次确认）。
   * 生效范围只覆盖自动与批量类触发；用户本次的显式操作（AI 识别 / 手动见解）不受影响。
   */
  const toggleInsightBlacklist = async (c: any) => {
    const sessionId = String(c?.session_id || '')
    const name = displayNameOf(c)
    if (!sessionId) { setNotice('该客户未关联微信会话，无法屏蔽 AI 见解'); return }
    const blocked = isInsightBlacklisted(insightBlacklist, sessionId)
    if (!blocked) {
      const ok = window.confirm(
        `屏蔽「${name}」的 AI 见解？\n\n` +
        '屏蔽后：TA 不会被自动或批量触发 AI 见解与分析（例如早间简报）。\n' +
        '你手动点「AI 识别这个客户」或手动触发见解仍会正常执行。\n\n' +
        '可随时在这里或设置页解除。'
      )
      if (!ok) return
      const next = addInsightBlacklistEntry(insightBlacklist, sessionId, 'manual', Date.now())
      setInsightBlacklist(next)
      await configService.setAiInsightNonCustomerBlacklist(next)
      setNotice(`已屏蔽「${name}」的 AI 见解，可在设置页查看名单`)
      return
    }
    const ok = window.confirm(
      `解除对「${name}」的 AI 见解屏蔽？\n\n解除后 TA 会重新参与自动与批量的 AI 见解与分析。`
    )
    if (!ok) return
    const next = removeInsightBlacklistEntry(insightBlacklist, sessionId)
    setInsightBlacklist(next)
    await configService.setAiInsightNonCustomerBlacklist(next)
    setNotice(`已解除对「${name}」的 AI 见解屏蔽`)
  }
  // Hermes 智能体入口（档案「AI 工具」下拉）：App 级单例抽屉，带着当前客户上下文打开
  const openHermes = useHermesStore((s) => s.openHermes)
  const [foldTimeline, setFoldTimeline] = useState(false)
  const [foldProfile, setFoldProfile] = useState(false)
  const [foldBiz, setFoldBiz] = useState(false)
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

  // ─── AI 识别这个客户（PRD §5.2 / §6.2）─────────────────────────────────────
  // 单飞作用域全局（§4.7）：任一识别进行中，本按钮与今日行动页的「重新生成简报」同时禁用
  const [identifyBusy, setIdentifyBusy] = useState(false)
  /** 完成后展示「刚刚更新」；下一次点击前保留 */
  const [identifyDoneAt, setIdentifyDoneAt] = useState<number | null>(null)
  /** 六态中的「无新内容 / 失败 / 额度不足」分别用独立文案，绝不静默 */
  const [identifyNotice, setIdentifyNotice] = useState<{ kind: 'ok' | 'no_new' | 'error' | 'quota'; text: string } | null>(null)

  const runIdentify = useCallback(async () => {
    const sessionId = String(selectedCustomer?.session_id || '').trim()
    if (!sessionId || identifyBusy) return
    setIdentifyBusy(true); setIdentifyNotice(null); setIdentifyDoneAt(null)
    try {
      const res = await (window as any).electronAPI.sales.identifyCustomer({
        sessionId,
        displayName: displayNameOf(selectedCustomer)
      })
      if (res?.success && res.noNewContent) {
        // 调用前判定：未发起模型调用（账本无记录），界面直接说明
        setIdentifyNotice({ kind: 'no_new', text: '距上次识别无新消息' })
      } else if (res?.success) {
        setIdentifyDoneAt(Date.now())
        setIdentifyNotice({
          kind: 'ok',
          text: res.newTasks > 0 ? `刚刚更新，新增 ${res.newTasks} 条待跟进` : '刚刚更新，未发现新的跟进承诺'
        })
        // 识别会新增待办 → 重取信号与客户列表，让产出立刻可见
        void fetchAll()
      } else {
        // 失败/额度不足：明确报错并给出提额入口，不静默
        const text = String(res?.error || '识别失败')
        setIdentifyNotice({ kind: /额度|上限|预算/.test(text) ? 'quota' : 'error', text })
      }
    } catch (e) {
      setIdentifyNotice({ kind: 'error', text: String(e) })
    } finally {
      setIdentifyBusy(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCustomer, identifyBusy])

  // 全局单飞订阅：别人（简报/别的页面）在识别时，本按钮同样要禁用
  useEffect(() => {
    let off: (() => void) | undefined
    try {
      const api = (window as any).electronAPI.sales
      void api.identifyState?.().then((s: any) => setIdentifyBusy(!!s?.busy)).catch(() => undefined)
      off = api.onIdentifyActivity?.((s: any) => setIdentifyBusy(!!s?.busy))
    } catch { /* 订阅失败不阻断页面 */ }
    return () => { if (off) off() }
  }, [])

  const openCustomer = async (c: any) => {
    setSelectedCustomer(c)
    setCustomerProfile(null)
    setDeepReport('')
    deepReqRef.current = Number(c?.id ?? -1) // 使在途的旧客户深度分析请求失效
    setDeepLoading(false)
    setEvidenceKey(null)
    setEvidenceMsg(null)
    setShowAiTools(false)
    setFoldTimeline(false)
    setFoldProfile(false)
    setFoldBiz(false)
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

  // 刀 4 批量通过（确认队列升级，防确认疲劳 PRD 点名）：勾选多张信息待确认卡一次采纳
  const [selectedInfoKeys, setSelectedInfoKeys] = useState<Set<string>>(new Set())
  const [batchInfoBusy, setBatchInfoBusy] = useState(false)
  const toggleInfoSelect = (key: string, checked: boolean) => {
    setSelectedInfoKeys(prev => {
      const next = new Set(prev)
      if (checked) next.add(key); else next.delete(key)
      return next
    })
  }
  const applyInfoBatch = async () => {
    const items = actionQueue.filter((it) => it.kind === 'info' && selectedInfoKeys.has(it.key))
    if (items.length === 0 || batchInfoBusy) return
    setBatchInfoBusy(true)
    let accepted = 0, failed = 0
    for (const it of items) {
      try {
        const r = await window.electronAPI.crm.infoQueueApply(Number(it.infoItem.account_id), String(it.infoItem.field), 'accept')
        if (r.ok) { accepted++; dismissCard(it.key) } else failed++
      } catch { failed++ }
    }
    setBatchInfoBusy(false)
    setSelectedInfoKeys(new Set())
    setNotice(failed > 0 ? `批量采纳完成：成功 ${accepted} 条，失败 ${failed} 条` : `已批量采纳 ${accepted} 条 AI 填充`)
    await fetchQueues()
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
  const ownerFiltered = isSalesView(identity)
  // 页眉（概念稿 CRM 屏）：主张句数字只取现有 state；无数据时只写定性句，不编数字
  const heroLine = customers.length > 0
    ? (ownerFiltered ? `我名下及未归属的 ${customers.length} 位客户` : `本机客户库里的 ${customers.length} 位客户`)
    : '客户档案与行动信号，都在这里'
  const subLine = actionQueue.length > 0
    ? `今天有 ${actionQueue.length} 位客户需要处理 · 处理完即消失 · 档案与信号取本机业务库，不做云端汇总`
    : '队列里没有待处理事项 · 档案与信号取本机业务库，不做云端汇总'
  // 档案抽屉：跟进待办只列待处理/逾期（口径与旧渲染一致）
  const pendingTodos = (customerProfile?.todos || []).filter((t: any) => t.status === 'pending' || t.status === 'overdue')
  // AI 准确率（近 7 天）九格：值与旧渲染逐个一致，只换细线键值语法（.defs/.def）
  const accuracyItems: Array<{ l: string; v: any }> = accuracy ? [
    { l: 'AI 自动写入字段', v: accuracy.enrichAuto },
    { l: '待确认采纳', v: accuracy.infoAccept },
    { l: '待确认放弃', v: accuracy.infoReject },
    { l: '采纳率', v: accuracy.acceptRate == null ? '-' : `${accuracy.acceptRate}%` },
    { l: '手动修正字段', v: accuracy.manualEdit },
    { l: '修正率（越低越准）', v: accuracy.writtenTotal > 0 ? `${accuracy.correctionRate}%` : '-' },
    { l: '报价信号', v: accuracy.quoteTotal },
    { l: '24h 内回复/总回复', v: `${accuracy.quoteReplied24}/${accuracy.quoteReplied}` },
    { l: '报价待跟进', v: accuracy.quotePending },
  ] : []
  // 行动卡处理器（沿用现有闭环 handler；乐观移除 + 重新拉取）
  const dismissCard = (key: string) => setDismissed((prev) => new Set(prev).add(key))
  const handleComplete = async (it: ActionCardItem) => {
    dismissCard(it.key)
    if (it.customer) await completeSignal(it.customer)
    else await fetchAll()
  }

  // follow 卡次级入口「完成待办」（§2.75）：卡上直接完成该客户的 pending 待办——
  // 复用现有 todo 完成 handler（sales.todoUpdate(id,{status:'done'})，与今日行动页 completeTodo 同一 IPC，零新增）；
  // 卡片 task 源解析不出待办 id（不可完成）时入口不出现
  const pendingTodoIdOf = (it: ActionCardItem): number => {
    if (it.kind !== 'follow') return 0
    const taskSrc = (it.signal?.sources || []).find((s: any) => s.type === 'task')
    return Number(taskSrc?.rawTaskId || 0)
  }
  const [completingTodo, setCompletingTodo] = useState(0)
  const completeTodoOfCard = async (it: ActionCardItem, todoId: number) => {
    if (todoId <= 0) return
    setCompletingTodo(todoId)
    try {
      await (window as any).electronAPI.sales.todoUpdate(todoId, { status: 'done' })
      setNotice('已直接完成该待办')
    } catch (e) { setNotice(`完成待办失败：${e}`) }
    setCompletingTodo(0)
    dismissCard(it.key) // 待办已闭环，卡片从队列消失（重拉后源信号自然消失）
    await fetchAll()
  }
  const handleInfo = async (it: ActionCardItem, action: 'accept' | 'reject') => {
    dismissCard(it.key)
    if (it.infoItem) await applyInfo(it.infoItem, action)
  }
  const avatarChar = (n: string) => Array.from(n.trim())[0] || '客'
  return (
    <div className="cws-page">
      {ownerFiltered && <div className="owner-filter-hint">仅显示我名下及未归属的数据</div>}
      {/* 页眉（概念稿 CRM 屏）：.eyebrow 小标 + .hero 主张句 + .sub 说明；右侧动作 .btn */}
      <div className="shead">
        <div>
          <p className="eyebrow">CRM · 客户工作台</p>
          <h1 className="hero">{heroLine}</h1>
          <p className="sub">{subLine}</p>
        </div>
        <div className="shead__actions">
          <button className="btn" onClick={() => { void fetchAll(); void fetchQueues() }}><RefreshCw size={14} /> 刷新</button>
          <div className="cws-more">
            <button className="btn btn--quiet" onClick={() => setShowMore((v) => !v)}><Plus size={14} /> 更多</button>
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
      </div>
      {notice && <div className="notice notice--accent"><AlertCircle className="icon" size={14} /><div>{notice}</div></div>}

      {accuracyOpen && accuracy && (
        <section className="cws-accuracy">
          <button className="cws-accuracy__head" onClick={() => setAccuracyOpen(false)}>
            <span className="seclabel__t">AI 准确率（近 7 天）</span>
            <span className="cws-accuracy__toggle">收起 ▲</span>
          </button>
          <div className="defs cws-accuracy__grid">
            {accuracyItems.map((it) => (
              <div className="def" key={it.l}>
                <div className="def__k">{it.l}</div>
                <div className="def__v num">{it.v}</div>
              </div>
            ))}
          </div>
        </section>
      )}


      {/* 阶段栏（概念稿 .rail）：细线站点 + 等宽计数；点档只改现有的 stageFilter，取值与深链协议不变 */}
      <div className="rail" role="tablist" aria-label="阶段筛选">
        <button type="button" role="tab" aria-selected={!stageFilter} className={`rail__item${!stageFilter ? ' is-on' : ''}`} onClick={() => setStageFilter('')}>
          全部<span className="rail__n">{customers.length}</span>
        </button>
        {stageOptions.map((st) => (
          <button type="button" key={st} role="tab" aria-selected={stageFilter === st} className={`rail__item${stageFilter === st ? ' is-on' : ''}`} onClick={() => setStageFilter(st)}>
            {st}<span className="rail__n">{stageCounts[st] || 0}</span>
          </button>
        ))}
        <span className="rail__sum">显示 <b>{searchActive ? searchResults.length : actionQueue.length}</b> / {customers.length} · 本机业务库</span>
      </div>

      {/* 客户索引 + 当前档案（概念稿 .crm）：宽窗两栏并排，窄窗档案转为浮层；选择/关闭/遮罩行为与旧抽屉一致 */}
      <div className={`cws-cols${selectedCustomer ? ' has-detail' : ''}`}>
      <div className="cws-index">
      <div className="cws-searchrow">
        <label className="field cws-searchfield">
          <Search className="icon" size={14} />
          <input type="search" placeholder="搜客户名 / 公司，找全部客户…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
      </div>

      {searchActive ? (
        /* ── 屏 3：搜索态（关键词/阶段深链任一存在才渲染结果列表）——概念稿细线索引（§2.75：每页 10 条 + Pager，空态文案保留） ── */
        <>
          <div className="tbl tbl--air">
            <div className="thead cws-ix">
              <span>客户</span><span>阶段</span><span className="tc-r">最近互动</span><span />
            </div>
            {indexRows.length === 0 && <div className="cws-ix__empty">无匹配客户</div>}
            {indexRows.map((c: any) => (
              <button
                type="button"
                key={Number(c.id)}
                className={`trow cws-ix cws-ix--row${selectedCustomer && Number(selectedCustomer.id) === Number(c.id) ? ' is-on' : ''}`}
                onClick={() => void openCustomer(c)}
              >
                <span className="cws-ix__who">
                  <Avatar src={(c as any).avatarUrl} name={displayNameOf(c)} size={28} />
                  <span className="cws-ix__main">
                    <span className="tc-n">{displayNameOf(c)}</span>
                    <span className="tc-s">{c.company || '未填公司'}</span>
                  </span>
                </span>
                <span><span className={stagePillClass(rowStage(c))}>{rowStage(c)}</span></span>
                <span className="cws-ix__silent tc-r">{silentTextOf(c)}</span>
                <ChevronRight size={14} className="chev" />
              </button>
            ))}
          </div>
          {indexTotalPages > 1 && (
            <div className="cws-pager">
              <button className="btn btn--sm" disabled={indexPage <= 1} onClick={() => setSearchPage(indexPage - 1)}>上一页</button>
              <span className="cws-pager__info">第 {indexPage} / {indexTotalPages} 页 · 共 {searchResults.length} 条</span>
              <button className="btn btn--sm" disabled={indexPage >= indexTotalPages} onClick={() => setSearchPage(indexPage + 1)}>下一页</button>
            </div>
          )}
        </>
      ) : actionQueue.length === 0 ? (
        /* ── 屏 2：队列清零空态（细线，不落卡） ── */
        <div className="cws-done">
          <div className="cws-done__title">当前没有待处理客户</div>
          <p className="cws-done__sub">这里为空只表示队列里没有事项，不代表客户都跟完了。要找一个具体客户？用上面的搜索框。想看看今天还能干什么？去「今日行动」。</p>
        </div>
      ) : (
        /* ── 屏 1：行动队列（概念稿细线行） ── */
        <>
          {selectedInfoKeys.size > 0 && (
            <div className="cws-batch-bar">
              <span>已选 {selectedInfoKeys.size} 条信息待确认</span>
              <button className="btn btn--sm btn--primary" disabled={batchInfoBusy} onClick={() => void applyInfoBatch()}>
                <CheckCircle2 size={13} /> {batchInfoBusy ? '采纳中…' : '批量采纳'}
              </button>
              <button className="btn btn--sm" onClick={() => setSelectedInfoKeys(new Set())}>取消选择</button>
            </div>
          )}
          <div className="tbl tbl--air cws-queue">
            <div className="thead cws-q">
              <span>客户</span><span>为什么现在看</span><span className="tc-r">操作</span>
            </div>
            {actionQueue.map((it: ActionCardItem) => (
              <div key={it.key} className="trow cws-q__row" onClick={() => it.kind === 'info' && it.accountId ? void openInfoCustomer(it.accountId) : it.customer ? void openCustomer(it.customer) : undefined}>
                <span className="cws-q__who">
                  <Avatar src={(it.customer as any)?.avatarUrl} name={it.displayName} size={28} />
                  <span className="cws-q__name">
                    <span className="tc-n">{it.displayName}</span>
                    <span className={queuePillClass(it.pill)}>{it.pillText}</span>
                  </span>
                </span>
                <span className="cws-q__why">
                  <span className="cws-q__reason">{it.reason}</span>
                  <span className="cws-q__suggest">{it.suggest}</span>
                </span>
                <span className="cws-q__ops tc-a" onClick={(e) => e.stopPropagation()}>
                  {it.kind === 'follow' && (
                    <>
                      <button className="btn btn--sm btn--primary" onClick={() => void openChat(it.customer)} disabled={!it.sessionId}><MessageCircle size={13} /> 去聊天</button>
                      {pendingTodoIdOf(it) > 0 && (
                        <button className="btn btn--sm" disabled={completingTodo === pendingTodoIdOf(it)} onClick={() => void completeTodoOfCard(it, pendingTodoIdOf(it))} title="该客户有待办未完成，点此直接闭环">
                          {completingTodo === pendingTodoIdOf(it) ? <RotateCw size={13} className="spinning" /> : <ClipboardCheck size={13} />} {completingTodo === pendingTodoIdOf(it) ? '完成中…' : '完成待办'}
                        </button>
                      )}
                      <button className="btn btn--sm" disabled={completing === String(it.customer?.id)} onClick={() => void handleComplete(it)}><CheckCircle2 size={13} /> {completing === String(it.customer?.id) ? '处理中…' : '已处理'}</button>
                    </>
                  )}
                  {it.kind === 'info' && (
                    <>
                      <label className="cws-info-check" title="勾选后可批量采纳">
                        <input type="checkbox" checked={selectedInfoKeys.has(it.key)} onChange={(e) => toggleInfoSelect(it.key, e.target.checked)} />
                      </label>
                      <button className="btn btn--sm btn--primary" onClick={() => void handleInfo(it, 'accept')}>✓ 采纳</button>
                      <button className="btn btn--sm" onClick={() => void handleInfo(it, 'reject')}>放弃</button>
                    </>
                  )}
                  {it.kind === 'insight' && (
                    <>
                      <button className="btn btn--sm btn--primary" onClick={() => it.sessionId ? void openChat(it.customer) : void openCustomer(it.customer)} disabled={!it.sessionId}><MessageCircle size={13} /> 看原话</button>
                      <button className="btn btn--sm" disabled={completing === String(it.customer?.id)} onClick={() => void handleComplete(it)}><CheckCircle2 size={13} /> {completing === String(it.customer?.id) ? '处理中…' : '已处理'}</button>
                    </>
                  )}
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      </div>{/* /.cws-index */}

      {/* 当前档案：宽窗为并排列（.cws-side 常规文档流内粘顶），窄窗为浮层抽屉（同旧遮罩行为） */}
      {selectedCustomer && (
        <aside className="cws-side" aria-label="客户档案" onClick={() => setSelectedCustomer(null)}>
          <div className="cws-side__panel" onClick={(e) => e.stopPropagation()}>
          <div className="crm-detail">
          <div className="crm-detail-head">
            <div className="cws-detail__id">
              <div className="cws-detail__name">
                {displayNameOf(selectedCustomer)}
                {rowStage(selectedCustomer) && <span className={stagePillClass(rowStage(selectedCustomer))}>{rowStage(selectedCustomer)}</span>}
              </div>
              {/* 核心客户信息一行（阶段在上面胶囊里）：公司 / 归属 / 最近互动，全部取索引行同源字段，不新增查询 */}
              <div className="cws-detail__sub">
                {[
                  selectedCustomer.company || '未填公司',
                  selectedCustomer.owner_sales ? `归属 ${selectedCustomer.owner_sales}` : '未归属',
                  silentTextOf(selectedCustomer)
                ].join(' · ')}
              </div>
            </div>
            <div className="crm-detail-actions">
              {/* AI 识别这个客户（PRD §5.2）：主按钮。单飞作用域全局——任一识别进行中，所有入口按钮全部禁用 */}
              <button className="btn btn--sm btn--primary" onClick={() => void runIdentify()}
                disabled={identifyBusy || !selectedCustomer.session_id}
                title={!selectedCustomer.session_id ? '未关联微信会话，无法识别' : identifyBusy ? '正在识别中，请稍候' : '读取该客户最近聊天，抽取跟进承诺'}>
                <Sparkles size={14} /> {identifyBusy ? '识别中…' : 'AI 识别这个客户'}
              </button>
              <button className="btn btn--sm" onClick={() => void openChat(selectedCustomer)} disabled={!selectedCustomer.session_id}><MessageCircle size={14} /> 打开聊天</button>
              <button className="btn btn--sm" onClick={() => void createContractForCustomer(selectedCustomer)}><Plus size={14} /> 建合同</button>
              <div className="cws-aitools">
                <button className="btn btn--sm btn--quiet" onClick={() => setShowAiTools((v) => !v)}>AI 工具 ▾</button>
                {showAiTools && (
                  <div className="cws-aitools__menu">
                    <button className="cws-aitools__item" onClick={() => { setShowAiTools(false); void runEnrichOne(selectedCustomer) }} disabled={!selectedCustomer.session_id}><Sparkles size={12} /> AI 补全</button>
                    <button className="cws-aitools__item" onClick={() => { setShowAiTools(false); void genDeepAnalysis(selectedCustomer) }}><Sparkles size={12} /> {deepLoading ? '分析中…' : '深度分析'}</button>
                    <button className="cws-aitools__item" onClick={() => { setShowAiTools(false); void genAiQuotation(selectedCustomer) }} disabled={!selectedCustomer.session_id}><Sparkles size={12} /> AI 报价</button>
                    <button className="cws-aitools__item" onClick={() => { setShowAiTools(false); openHermes({ kind: 'customer', accountId: Number(selectedCustomer.id || 0), sessionId: String(selectedCustomer.session_id || ''), customerName: displayNameOf(selectedCustomer) }) }}><Bot size={12} /> 让 Hermes 分析</button>
                    {/* AI 见解屏蔽名单（2026-09-13 重定义）：手动加入/解除，带二次确认 */}
                    <button
                      className="cws-aitools__item"
                      onClick={() => { setShowAiTools(false); void toggleInsightBlacklist(selectedCustomer) }}
                      disabled={!selectedCustomer.session_id}
                      title={!selectedCustomer.session_id ? '未关联微信会话，无法屏蔽' : '只影响自动/批量触发，不影响你手动发起的识别与见解'}
                    >
                      <Ban size={12} /> {isInsightBlacklisted(insightBlacklist, String(selectedCustomer.session_id || '')) ? '解除 AI 见解屏蔽' : '屏蔽 TA 的 AI 见解'}
                    </button>
                  </div>
                )}
              </div>
              <button className="iconbtn cws-side__close" title="关闭档案（回到客户索引；窄窗下点遮罩同样关闭）" onClick={() => setSelectedCustomer(null)}><X size={15} /></button>
            </div>
          </div>
          {/* 识别结果提示（PRD §6.2 六态）：无新内容 / 成功 / 失败 / 额度不足都必须有明确文案 */}
          {identifyNotice && (
            <div className={`cws-identify-notice cws-identify-notice--${identifyNotice.kind}`} role={identifyNotice.kind === 'error' || identifyNotice.kind === 'quota' ? 'alert' : 'status'}>
              {identifyNotice.text}
              {identifyNotice.kind === 'quota' && <button className="btn btn--sm" onClick={() => navigate('/settings')}>提高当日上限</button>}
              {identifyNotice.kind === 'no_new' && <small>（未发起模型调用，不产生费用）</small>}
              {identifyDoneAt && identifyNotice.kind === 'ok' && <small> · {new Date(identifyDoneAt).toLocaleTimeString()}</small>}
            </div>
          )}
          {profileLoading && <p className="crm-insight">加载档案…</p>}
          {!selectedCustomer.session_id && <p className="crm-insight">（未关联微信会话，无 AI 档案）</p>}
          {!profileLoading && selectedCustomer.session_id && customerProfile && (
            <div className="crm-profile">
              {customerProfile.currentView && (() => {
                // 屏 4 ①：AI 当前判断——概念稿四栏判断 .verdicts（摘要/机会/风险/下一步，字段名同 customerCurrentView 投影）
                const j: any = customerProfile.currentView.judgments || {}
                const rows: Array<[string, any]> = [
                  ['摘要', j.summary], ['机会', j.opportunity], ['风险', j.risk], ['下一步', j.nextAction]
                ]
                if (!rows.some(([, v]) => v)) return null
                return (
                  <div className="cws-sec">
                    <div className="seclabel">
                      <span className="seclabel__t">AI 当前判断</span>
                      <span className="cws-seclabel__h">最近一次识别 · 本机</span>
                    </div>
                    <div className="verdicts">
                      {rows.map(([label, v]) => {
                        const open = !!v && !!v.messageKey && evidenceKey === v.messageKey
                        return (
                          <div key={label} className={`verdict${v ? '' : ' verdict--muted'}`}>
                            <div className="verdict__k">{label}</div>
                            <div>
                              <div className="verdict__v">{v ? String(v.value || '') : '尚未识别'}</div>
                              <div className="verdict__meta">
                                {!v && <span className="ahead"><i className="ahead__i" />点「AI 识别这个客户」生成</span>}
                                {v && v.source === 'manual' && <span className="ahead ahead--human"><i className="ahead__i" />人工确认</span>}
                                {v && v.source !== 'manual' && (
                                  <span className="ahead ahead--ai" title={v.freshness === 'stale' ? '生成已超 24h，可能过时' : ''}>
                                    <i className="ahead__i" />{v.freshness === 'stale' ? 'AI · 可能已过期' : 'AI · 新鲜'}
                                  </span>
                                )}
                                {v && v.evidenceStatus === 'ok' && v.messageKey && (
                                  <button className="ahead ahead--src ahead--btn" onClick={() => void toggleEvidence(v)}>
                                    <i className="ahead__i" />{open ? (evidenceMsg && evidenceMsg.startsWith('正在') ? '回查中…' : '收起') : '依据消息'}
                                  </button>
                                )}
                              </div>
                              {/* 与聊天侧栏同一份证据样式（main.scss .verdict__evi），不再各写一套 */}
                              {open && evidenceMsg && <div className="verdict__evi">{evidenceMsg}</div>}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )
              })()}
              {customerProfile.todos?.length > 0 && (
                <div className="cws-sec">
                  <div className="seclabel">
                    <span className="seclabel__t">跟进待办</span>
                    <span className="cws-seclabel__h">{pendingTodos.length} 条待处理</span>
                  </div>
                  {pendingTodos.map((t: any) => (
                    <div key={t.id} className="todo">
                      <div>
                        <div className="todo__t">{t.promise_summary || t.title}</div>
                        <div className="todo__m">[{t.status}]</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <div className="cws-sec">
                <div className="seclabel">
                  <span className="seclabel__t">客户信息</span>
                  <span className="cws-seclabel__h">点击字段可编辑，手改后 AI 不再覆盖</span>
                </div>
                <div className="cws-typerow">
                  <span className="cws-typerow__k">客户类型</span>
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
                <div className="defs">
                  {accountFieldView(customerProfile.account).map((f) => (
                    <div key={f.field} className={`def cws-def${f.value ? '' : ' cws-def--empty'}`}>
                      <div className="def__k">
                        {f.label}
                        {f.value && f.source === 'ai' && (
                          <span className="ahead ahead--ai cws-def__src" title={f.evidence ? `AI 提取 · 证据「${f.evidence}」` : 'AI 提取'}>
                            <i className="ahead__i" />AI · {Math.round((f.confidence ?? 0) * 100)}%
                          </span>
                        )}
                        {f.value && f.source === 'manual' && <span className="ahead ahead--human cws-def__src"><i className="ahead__i" />人工确认</span>}
                      </div>
                      {editingField === f.field ? (
                        <div className="cws-def__edit">
                          <input autoFocus value={editingValue} onChange={(e) => setEditingValue(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') void saveFieldManual(f.field); if (e.key === 'Escape') setEditingField('') }} />
                          <button className="btn btn--sm btn--primary" onClick={() => void saveFieldManual(f.field)}>保存</button>
                          <button className="btn btn--sm" onClick={() => setEditingField('')}>取消</button>
                        </div>
                      ) : (
                        <div className="def__v" onClick={() => { setEditingField(f.field); setEditingValue(f.value) }}
                          title={f.evidence ? `证据「${f.evidence}」` : '点击编辑'}>
                          {f.value || '未提取'}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
              <div className="cws-sec">
                <button className="cws-fold" onClick={() => setFoldTimeline((v) => !v)}>
                  <span className="seclabel__t">动态时间线</span>
                  <span className="cws-fold__meta">{customerProfile.activities?.length ?? 0} 条 · {foldTimeline ? '收起 ▲' : '展开 ▼'}</span>
                </button>
                {foldTimeline && (customerProfile.activities?.length > 0 || customerProfile.insights?.length > 0) && (
                  <div className="crm-timeline">
                    {[
                      // Customer 360：CRM 业务动作（后端已聚合 6 实体）+ 线索流转 + 商机事件 + AI 见解，一条流混排
                      ...(customerProfile.activities || []).map((a: any) => ({ at: Number(a.at ?? a.created_at ?? 0), kind: String(a.kind || 'crm'), text: String(a.text || a.detail || a.action || '') })),
                      ...(customerProfile.insights || []).map((i: any) => ({ at: Number(i.createdAt || 0), kind: 'insight', text: String(i.insight || '') }))
                    ].sort((x: any, y: any) => y.at - x.at).slice(0, 40).map((e: any, idx: number) => (
                      <div key={idx} className="crm-timeline__item">
                        <span className="crm-timeline__time">{new Date(e.at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                        <span className={`tag ${TIMELINE_TAG_CLASS[e.kind] || 'tag--neutral'}`}>{TIMELINE_KIND_LABEL[e.kind] || 'CRM'}</span>
                        <span className="crm-timeline__text">{e.text}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              {customerProfile.aiProfile && (
                <div className="cws-sec">
                  <button className="cws-fold" onClick={() => setFoldProfile((v) => !v)}>
                    <span className="seclabel__t">AI 画像</span>
                    <span className="cws-fold__meta">{foldProfile ? '收起 ▲' : '展开 ▼'}</span>
                  </button>
                  {foldProfile && <p className="crm-insight">{customerProfile.aiProfile}</p>}
                </div>
              )}
              <div className="cws-sec">
                <button className="cws-fold" onClick={() => setFoldBiz((v) => !v)}>
                  <span className="seclabel__t">业务</span>
                  <span className="cws-fold__meta">合同 {customerProfile.contracts?.length ?? 0} 份 · 回款 ¥{Number(customerProfile.credited ?? 0).toLocaleString()} · {foldBiz ? '收起 ▲' : '展开 ▼'}</span>
                </button>
                {foldBiz && (
                  <div className="cws-sec__acts">
                    <button className="btn btn--sm cws-danger-btn" onClick={() => void deleteCustomer(selectedCustomer)}><Trash2 size={13} /> 删除客户</button>
                  </div>
                )}
              </div>
            </div>
          )}
          {deepReport && (
            <div className="crm-profile">
              <div className="cws-sec">
                <div className="seclabel">
                  <span className="seclabel__t">资深销售助理 · 深度分析</span>
                </div>
                <p className="crm-insight crm-deep-report">{deepReport}</p>
              </div>
            </div>
          )}
          </div>
          </div>
        </aside>
      )}
      </div>{/* /.cws-cols */}
    </div>
  )
}
