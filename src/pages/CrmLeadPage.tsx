/**
 * CrmLeadPage.tsx —— 线索池（单机线索流转）
 * 导入（Excel/CSV/文本粘贴）→ 线索池列表（状态/来源/标签/归属筛选，默认筛「未分配」）→ 首触 SLA → 转客户。
 * 群资源扫描已下线（2026-09-02 决策 B，宪法 §4.2）：录入只走分配员 Excel/粘贴导入。
 * 线索分配（Phase 1 完整交互）：勾选 NEW 行 → 「分配给…」→ 弹窗选销售（名单存 config crmSalesList，弹窗内维护）；
 * 行内「认领」（本人+assigned 态可见，弹窗可顺手填客户微信号/昵称——填了微信号会走 1.4a 绑定链路停 SLA1 表）/
 * 「绑微信」（PRD 1.4a 手动路：搜本机联系人 → 选 → 确认 → customer_identity + 停表 + WX_ADDED + 审计）/
 * 「调派」「回收」（身份角色≠销售可见）。
 * 归属唯一事实源 = assignment 表（宪法 §1.3），本页只读 assignment 展示归属，绝不写 lead 表归属字段。
 * ⚠️ 销售视角过滤只是展示层便利（宪法 §1.12：角色仅署名，不作访问控制；门禁靠部署形态+应用锁）。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useWxidRefresh } from '../utils/useWxidRefresh'
import { Inbox, Upload, RefreshCw, ClipboardPaste, Phone, MessageCircle, UserPlus, UserCheck, UserX, X, FileSpreadsheet, AlertTriangle, Pencil, ArrowLeftRight, Undo2, Hand, Link2, Sparkles } from 'lucide-react'
import * as XLSX from 'exceljs'
import type { LeadRow, FirstClassifyRoundRow } from '../types/electron'
import type { ContactInfo } from '../types/models'
import { getCrmLeadSourcePreset, getCrmSalesList, setCrmSalesList } from '../services/config'
import { buildOwnerMap, canBindWxid, canClaimLead, canManageAssignment, isSalesView, filterLeadsForView, visibleOwnerChips, leadPageView, distributePreview, suggestReassignOwner, buildMyCards, sla2StatusView, type LeadOwnerInfo, type IdentityLike, type ManagerTab, type AssignMode, type Sla2StatusView } from '../utils/leadAssignmentView'
import { LEAD_SLA_UNASSIGNED_SENTINEL } from '../../shared/leadSla'
import { parseJsonObject, parseJsonArray } from '../../shared/safeJson'
import { getCrmAssignWeights, setCrmAssignWeights } from '../services/config'
import './CrmLeadPage.scss'

const PRESET_SOURCES = ['抖音', '视频号', '小红书']
const STATUS_META: Record<string, { label: string; cls: string }> = {
  NEW: { label: '待首触', cls: 'st-new' },
  CONTACTED: { label: '已首触', cls: 'st-contacted' },
  WX_ADDED: { label: '已加微信', cls: 'st-wx' },
  DEAD: { label: '已失效', cls: 'st-dead' },
  ACCOUNT: { label: '已转客户', cls: 'st-account' }
}
const CHANNELS = ['PHONE', 'WECHAT', 'SMS']
const CHANNEL_META: Record<string, string> = { PHONE: '电话', WECHAT: '微信', SMS: '短信' }
/** AI 首次分类提案展示用标签（PRD 2.4） */
const FC_STAGE_LABEL: Record<string, string> = { new: '新建', contacted: '已接触', quoted: '已报价', negotiating: '议价中', won: '已成交', lost: '已流失', unknown: '未知（证据不足）' }
const FC_TYPE_LABEL: Record<string, string> = { dealer: '疑似经销商', end_user: '疑似终端自用', unknown: '未知（证据不足）' }
const FC_FIELD_LABEL: Record<string, string> = { company: '公司', industry: '行业', intent_model: '需求型号', quantity: '数量', budget: '预算', purchase_timeframe: '采购时间', needs: '需求' }
const FC_GAP_LABEL: Record<string, string> = { customer_type: '客户类型', company_industry: '公司/行业', intent_model: '需求型号', quantity: '数量', budget: '预算', purchase_timeframe: '采购时间' }
const PAGE_SIZE = 50
/** SLA2「查看依据」出口状态（主进程 crmSla2EvidenceService 已脱敏/裁剪，前端只展示） */
type Sla2EvidenceResult = Awaited<ReturnType<typeof window.electronAPI.crm.sla2Evidence>>

interface RawRow { text?: string; phone?: string; wechat?: string; name?: string; tag?: string; note?: string }

function fmtTime(ts?: number): string {
  if (!ts) return '-'
  const d = new Date(Number(ts))
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function fmtOverdue(deadline: number): string {
  const h = Math.max(1, Math.floor((Date.now() - Number(deadline)) / 3600_000))
  return h < 24 ? `${h}小时` : `${Math.floor(h / 24)}天${h % 24}小时`
}

function maskLead(lead: { contact_type: string; contact_normalized: string }): string {
  const v = String(lead.contact_normalized || '')
  if (lead.contact_type === 'phone') return v.length === 11 ? `${v.slice(0, 3)}****${v.slice(-4)}` : v
  return v.length >= 4 ? `${v.slice(0, 2)}***${v.slice(-1)}` : v
}

/** 归属留痕行（ownership_history，宪法 §1.8 append-only） */
interface OwnHistRow {
  id: number
  old_owner: string
  new_owner: string
  reason: string
  actor: string
  created_at: number
}

/** Excel/CSV 矩阵 → 行对象：识别表头（phone/wechat/姓名/标签/备注），其余列并入 text */
function matrixToRows(matrix: unknown[][]): RawRow[] {
  const headers = (matrix[0] || []).map((c) => String(c ?? '').trim().toLowerCase())
  const colOf = (names: string[]) => headers.findIndex((h) => names.includes(h))
  const iPhone = colOf(['phone', '手机号', '手机', '电话', '联系电话', '手机号码'])
  const iWechat = colOf(['wechat', '微信', '微信号', 'vx', 'wx'])
  const iName = colOf(['name', '姓名', '客户', '名字'])
  const iTag = colOf(['tag', '标签', '需求', '意向'])
  const iNote = colOf(['note', '备注', '说明'])
  const hasHeader = iPhone >= 0 || iWechat >= 0 || iName >= 0
  const named = [iPhone, iWechat, iName, iTag, iNote].filter((i) => i >= 0)
  const rows: RawRow[] = []
  for (let r = 0; r < matrix.length; r++) {
    const cells = matrix[r].map((c) => String(c ?? '').trim())
    if (cells.every((c) => !c)) continue
    if (hasHeader && r === 0) continue
    const row: RawRow = {}
    if (iPhone >= 0 && cells[iPhone]) row.phone = cells[iPhone]
    if (iWechat >= 0 && cells[iWechat]) row.wechat = cells[iWechat]
    if (iName >= 0 && cells[iName]) row.name = cells[iName]
    if (iTag >= 0 && cells[iTag]) row.tag = cells[iTag]
    if (iNote >= 0 && cells[iNote]) row.note = cells[iNote]
    const rest = cells.filter((_, i) => !named.includes(i) && cells[i])
    const text = [...(row.phone ? [row.phone] : []), ...(row.wechat ? [`微信${row.wechat}`] : []), ...(row.name ? [row.name] : []), ...rest].join(' ')
    row.text = hasHeader ? text : cells.join(' ')
    if (!row.phone && !row.wechat && !row.name && !text.trim()) continue
    rows.push(row)
  }
  return rows
}

function parsePasteText(text: string): RawRow[] {
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((line) => {
    const cells = line.split(/\t|,/).map((c) => c.trim()).filter(Boolean)
    return { text: cells.join(' ') }
  })
}

export default function CrmLeadPage() {
  // 深链 /leads?leadId=<id>：审计流水「线索名」点击跳转用（见下方 useEffect）
  const [searchParams] = useSearchParams()
  const [leads, setLeads] = useState<LeadRow[]>([])
  const [overview, setOverview] = useState<{ total: number; overdue: number; todayImported: number; todayContacted: number; pendingSla: number; byStatus: Record<string, number>; sources: Array<{ source: string; count: number }> } | null>(null)
  const [search, setSearch] = useState('')
  const [statusChip, setStatusChip] = useState('全部')
  const [sourceChip, setSourceChip] = useState('全部')
  const [tagChip, setTagChip] = useState('全部')
  const [notice, setNotice] = useState('')
  const [showImport, setShowImport] = useState(false)
  const [importTab, setImportTab] = useState<'file' | 'paste'>('paste')
  const [presetSources, setPresetSources] = useState<string[]>(PRESET_SOURCES)
  const [importSource, setImportSource] = useState(PRESET_SOURCES[0])
  const [customSource, setCustomSource] = useState('')
  const [rows, setRows] = useState<RawRow[]>([])
  const [fileName, setFileName] = useState('')
  const [detail, setDetail] = useState<{ lead: LeadRow; activities: Array<{ action: string; note?: string; created_at: number }>; ownHist: OwnHistRow[]; sla2: Sla2StatusView | null } | null>(null)
  const [deadLead, setDeadLead] = useState<LeadRow | null>(null)
  const [deadReason, setDeadReason] = useState('')
  // 已加微信小弹窗：行内💬一键唤起，填客户微信号/昵称（可留空直接确认）
  const [wxTarget, setWxTarget] = useState<LeadRow | null>(null)
  const [wxInput, setWxInput] = useState('')
  // 编辑资料小弹窗：行内✏️任何状态可用，补填/修改姓名与微信号（不动线索状态）
  const [editTarget, setEditTarget] = useState<LeadRow | null>(null)
  const [editName, setEditName] = useState('')
  const [editWechat, setEditWechat] = useState('')
  const [page, setPage] = useState(1)
  const fileRef = useRef<HTMLInputElement>(null)
  // ── 线索分配（Phase 1）：勾选集合 / 归属筛选（默认「未分配」）/ 当前归属映射 / 分配弹窗 ──
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [ownerChip, setOwnerChip] = useState('未分配')
  const [salesList, setSalesList] = useState<string[]>([])
  const [ownerByLead, setOwnerByLead] = useState<Record<number, LeadOwnerInfo>>({})
  const [showAssign, setShowAssign] = useState(false)
  const [assignName, setAssignName] = useState('')
  const [newSales, setNewSales] = useState('')
  const [assignBusy, setAssignBusy] = useState(false)
  // ── 身份档案（认领本人判定 / 销售视角过滤；角色仅署名，不作访问控制，宪法 §1.12）──
  const [identity, setIdentity] = useState<IdentityLike>({ name: '', role: '' })
  // ── 认领弹窗：确认认领 + 可选填客户微信号/昵称（复用行内编辑资料的 leadUpdate 写路径，不写 customer_identity）──
  const [claimTarget, setClaimTarget] = useState<LeadRow | null>(null)
  const [claimWechat, setClaimWechat] = useState('')
  const [claimNick, setClaimNick] = useState('')
  const [claimBusy, setClaimBusy] = useState(false)
  // ── 调派弹窗（非销售角色）：选新销售 + 可选原因 ──
  const [transferTarget, setTransferTarget] = useState<LeadRow | null>(null)
  const [transferTo, setTransferTo] = useState('')
  const [transferReason, setTransferReason] = useState('')
  const [transferBusy, setTransferBusy] = useState(false)
  // ── 回收二次确认（非销售角色）──
  const [recycleTarget, setRecycleTarget] = useState<LeadRow | null>(null)
  const [recycleBusy, setRecycleBusy] = useState(false)
  // ── 离职移交弹窗（PRD §1.9，非销售角色）：离职人 → 接手人，批量走 transfer 循环 + owner 三列直改 ──
  const [showDeparture, setShowDeparture] = useState(false)
  const [departFrom, setDepartFrom] = useState('')
  const [departTo, setDepartTo] = useState('')
  const [departBusy, setDepartBusy] = useState(false)
  // ── 绑定微信弹窗（PRD 1.4a 手动路）：昵称/微信号关键词搜本机联系人 → 下拉选 → 确认 ──
  const [bindTarget, setBindTarget] = useState<LeadRow | null>(null)
  const [bindKw, setBindKw] = useState('')
  const [bindContacts, setBindContacts] = useState<ContactInfo[] | null>(null) // null=未加载/加载中
  const [bindSel, setBindSel] = useState<ContactInfo | null>(null)
  const [bindBusy, setBindBusy] = useState(false)
  const [bindAvatars, setBindAvatars] = useState<Record<string, string>>({})
  // ── AI 首次分类弹窗（PRD 2.4，认领满 24h 触发 + 手动立即分析；B 档 proposed→人工确认/拒绝）──
  const [classifyTarget, setClassifyTarget] = useState<LeadRow | null>(null)
  const [classifyRound, setClassifyRound] = useState<FirstClassifyRoundRow | null>(null)
  const [classifyBusy, setClassifyBusy] = useState(false)
  const [classifyRejectReason, setClassifyRejectReason] = useState('')
  // ── 三视角改版（设计稿屏 2/3/4/6）：管理三页签 + 池分段 + 控制台状态 + 留痕数据 ──
  const view = leadPageView(identity)
  const [managerTab, setManagerTab] = useState<ManagerTab>('pool')
  const [poolSeg, setPoolSeg] = useState<'pool' | 'assigned' | 'active' | 'recycled'>('pool')
  const [salesSeg, setSalesSeg] = useState<'wait' | 'active' | 'recycled'>('wait')
  // assignment 原始行（最新行判 recycled / 在手条数 / 销售卡 sla1 字段）
  const [asgRows, setAsgRows] = useState<Array<Record<string, unknown>>>([])
  // 屏 2 蓝横幅 = 最新一条资源导入审计；屏 3 最近分配记录 = lead_assign_batch 审计；屏 6 左回收原因 = lead_recycle 审计
  const [importAudit, setImportAudit] = useState<Record<string, unknown> | null>(null)
  const [batchRows, setBatchRows] = useState<Array<Record<string, unknown>>>([])
  const [recycleReasons, setRecycleReasons] = useState<Record<number, string>>({})
  // 屏 3 分配控制台
  const [assignMode, setAssignMode] = useState<AssignMode>('weight')
  const [assignWeights, setAssignW] = useState<Record<string, number>>({})
  const [batchCount, setBatchCount] = useState(50)
  const [batchBusy, setBatchBusy] = useState(false)
  // 屏 6 左确认改派
  const [reassignBusy, setReassignBusy] = useState<number | null>(null)
  // ── 主管升级提醒（SLA1 三次超时通知闭环，2026-09-08）：资源分配管理页「回收改派」页签展示 ──
  const [notifies, setNotifies] = useState<Array<Record<string, unknown>>>([])
  const [notifyUnread, setNotifyUnread] = useState(0)
  // ── SLA2「查看依据」（屏 5 右证据回查出口）：详情弹窗内查看脱敏消息摘要 ──
  const [sla2Ev, setSla2Ev] = useState<{ loading: boolean; view: Sla2EvidenceResult | null }>({ loading: false, view: null })
  // ── 导入查重明细（2026-09-08 查重完善）：导入后可复核 + CSV 导出 ──
  const [dedupeDetail, setDedupeDetail] = useState<Array<{ line: number; verdict: string; reason: string; phoneMasked: string; wechatMasked: string; name: string; matchedLeadId?: number; matchedAccountId?: number }> | null>(null)
  const [dedupeBatchId, setDedupeBatchId] = useState(0)

  const fetchAudit = async () => {
    try {
      const [imp, batches, recycles] = await Promise.all([
        window.electronAPI.crm.auditQuery({ action: 'lead_import', pageSize: 1 }).catch(() => null),
        window.electronAPI.crm.auditQuery({ action: 'lead_assign_batch', pageSize: 20 }).catch(() => null),
        window.electronAPI.crm.auditQuery({ action: 'recycle', pageSize: 200 }).catch(() => null)
      ])
      setBatchRows((batches?.data?.rows || []) as Array<Record<string, unknown>>)
      const reasons: Record<number, string> = {}
      for (const r of (recycles?.data?.rows || []) as Array<Record<string, unknown>>) {
        try {
          const d = JSON.parse(String(r.detail || '{}'))
          const lid = Number(r.entity_id)
          if (lid && !reasons[lid] && d.reason && d.reason !== 'converted_skip') reasons[lid] = String(d.reason)
        } catch { /* 非 JSON detail 跳过 */ }
      }
      setRecycleReasons(reasons)
      setImportAudit(((imp?.data?.rows || []) as Array<Record<string, unknown>>)[0] || null)
    } catch { /* 审计查询失败不阻塞列表 */ }
  }

  // 升级提醒（notify_inbox）：随 fetchAll 刷新；只读+已读标记，写者唯一=同步层通知消费
  const fetchNotifies = async () => {
    try {
      const r = await window.electronAPI.crm.notifyList({ limit: 20 })
      setNotifies((r?.data?.rows || []) as Array<Record<string, unknown>>)
      setNotifyUnread(Number(r?.data?.unread || 0))
    } catch { /* 通知查询失败不阻塞列表 */ }
  }
  const markNotifyRead = async (id: number) => {
    try { await window.electronAPI.crm.notifyMarkRead([id]); await fetchNotifies() } catch { /* 已读失败静默 */ }
  }

  const fetchAll = async () => {
    const [ls, ov, sales, asg, idt] = await Promise.all([
      window.electronAPI.crm.leadList({ limit: 10000 }),
      window.electronAPI.crm.leadOverview(),
      getCrmSalesList(),
      window.electronAPI.crm.assignmentList({ pageSize: 100000 }),
      window.electronAPI.identity.get()
    ])
    setLeads(ls || [])
    setOverview(ov || null)
    setSalesList(sales)
    setIdentity({ name: idt?.name || '', role: idt?.role || '' })
    // 当前归属 = 该 lead 最新一条有效分配行（宪法 §1.3）；含 assignmentId 供调派/回收用
    setOwnerByLead(buildOwnerMap(asg?.data?.rows || []))
    setAsgRows((asg?.data?.rows || []) as unknown as Array<Record<string, unknown>>)
    void getCrmAssignWeights().then(setAssignW).catch(() => undefined)
    void fetchAudit()
    void fetchNotifies()
  }
  useEffect(() => { void fetchAll() }, [])
  // 切微信号 = 换库（§2.40）：账号切换后重查
  useWxidRefresh(() => { void fetchAll() })
  // 来源预设与设置页联动
  useEffect(() => {
    void getCrmLeadSourcePreset().then((sources) => {
      if (sources.length) { setPresetSources(sources); setImportSource(sources[0]) }
    })
  }, [])
  useEffect(() => { if (notice) { const t = setTimeout(() => setNotice(''), 5000); return () => clearTimeout(t) } }, [notice])

  // 绑定弹窗打开时惰性拉一次本机联系人（lite 模式有内存缓存；只取好友，群/公众号不参与绑定）
  useEffect(() => {
    if (!bindTarget) { setBindContacts(null); setBindSel(null); setBindKw(''); return }
    let cancelled = false
    void window.electronAPI.chat.getContacts({ lite: true }).then((r) => {
      if (cancelled) return
      setBindContacts(r.success && Array.isArray(r.contacts) ? r.contacts.filter((c) => c.type === 'friend') : [])
    })
    return () => { cancelled = true }
  }, [bindTarget])

  // 关键词过滤（备注/昵称/微信号(username+alias) 模糊搜；匹配仅供选人，绑定写 username 内部 id，改名不失效）
  const bindMatches = useMemo(() => {
    if (!bindContacts) return []
    const kw = bindKw.trim().toLowerCase()
    const pool = kw
      ? bindContacts.filter((c) => [c.remark, c.nickname, c.alias, c.username, c.displayName].some((v) => String(v || '').toLowerCase().includes(kw)))
      : bindContacts
    return pool.slice(0, 20)
  }, [bindContacts, bindKw])

  // 下拉可见条目的头像惰性补齐（getContactAvatar 逐条取，已取过的不重复取）
  useEffect(() => {
    for (const c of bindMatches) {
      if (bindAvatars[c.username] !== undefined) continue
      void window.electronAPI.chat.getContactAvatar(c.username).then((r) => {
        if (r?.avatarUrl) setBindAvatars((m) => (m[c.username] !== undefined ? m : { ...m, [c.username]: r.avatarUrl! }))
        else setBindAvatars((m) => (m[c.username] !== undefined ? m : { ...m, [c.username]: '' }))
      })
    }
  }, [bindMatches, bindAvatars])

  const statusChips = useMemo(() => {
    const n = (s: string) => overview?.byStatus[s] ?? 0
    return [
      { value: '全部', label: '全部', count: overview?.total ?? 0 },
      { value: 'NEW', label: STATUS_META.NEW.label, count: n('NEW') },
      { value: 'CONTACTED', label: STATUS_META.CONTACTED.label, count: n('CONTACTED') },
      { value: 'WX_ADDED', label: STATUS_META.WX_ADDED.label, count: n('WX_ADDED') },
      { value: 'DEAD', label: STATUS_META.DEAD.label, count: n('DEAD') },
      { value: 'ACCOUNT', label: STATUS_META.ACCOUNT.label, count: n('ACCOUNT') }
    ]
  }, [overview])

  const salesView = isSalesView(identity)
  // 可见线索：销售视角只留「当前归属=本人」的（展示层便利过滤，非安全边界，宪法 §1.12）；管理视角全量
  const visibleLeads = useMemo(() => filterLeadsForView(leads, ownerByLead, identity), [leads, ownerByLead, identity])


  // 归属筛选 chips：未分配计数 + 各销售当前归属计数（名单 ∪ 实际归属，防删名后漏统计）
  const ownerChips = useMemo(() => {
    let unassigned = 0
    const counts = new Map<string, number>()
    for (const l of leads) {
      const o = ownerByLead[l.id]?.salesName
      if (o) counts.set(o, (counts.get(o) || 0) + 1)
      else unassigned++
    }
    const names = Array.from(new Set([...salesList, ...counts.keys()]))
    return { unassigned, names: names.map((value) => ({ value, count: counts.get(value) || 0 })) }
  }, [leads, ownerByLead, salesList])
  // 销售视角只留「我的」（未分配资源池不渲染、不混入，宪法 §1.12 展示层便利过滤）
  const ownerChipsVisible = useMemo(() => visibleOwnerChips(identity, ownerChips), [identity, ownerChips])
  // 标签筛选 chips：按 tag 计数倒序（tag=需求标签，Excel 导入语义；归属语义已随决策 B 退役）
  const tagChips = useMemo(() => {
    const counts = new Map<string, number>()
    for (const l of leads) {
      const t = String(l.tag || '').trim()
      if (!t) continue
      counts.set(t, (counts.get(t) || 0) + 1)
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([value, count]) => ({ value, count }))
  }, [leads])
  // ── 三视角改版派生（设计稿屏 2/3/4/6）─────────────────────────────────────
  // 每 lead 最新一条分配行（含 recycled/transferred）——判「已回收」与销售卡 sla1 字段
  const latestAsg = useMemo(() => {
    const m: Record<number, Record<string, unknown>> = {}
    for (const r of asgRows) {
      const lid = Number(r.lead_id)
      if (!m[lid] || Number(r.id) > Number(m[lid].id)) m[lid] = r
    }
    return m
  }, [asgRows])
  // 屏 2 四统计卡口径
  const poolCounts = useMemo(() => {
    let pool = 0, assignedN = 0, activeN = 0, recycledN = 0
    for (const l of leads) {
      const own = ownerByLead[l.id]
      const latest = latestAsg[l.id]
      if (latest && String(latest.status) === 'recycled') { recycledN++; continue }
      if (own?.status === 'assigned' && l.status === 'NEW') { assignedN++; continue }
      if (own?.status === 'claimed' || ['CONTACTED', 'WX_ADDED'].includes(l.status)) { activeN++; continue }
      if (l.status === 'NEW') pool++
    }
    return { pool, assignedN, activeN, recycledN }
  }, [leads, ownerByLead, latestAsg])
  // 屏 2 分段过滤（待分配/已分配/跟进中/已回收）
  const poolLeads = useMemo(() => {
    if (poolSeg === 'pool') return visibleLeads.filter((l) => l.status === 'NEW' && !ownerByLead[l.id] && String(latestAsg[l.id]?.status || '') !== 'recycled')
    if (poolSeg === 'assigned') return visibleLeads.filter((l) => ownerByLead[l.id]?.status === 'assigned' && l.status === 'NEW')
    if (poolSeg === 'active') return visibleLeads.filter((l) => ownerByLead[l.id]?.status === 'claimed' || ['CONTACTED', 'WX_ADDED'].includes(l.status))
    return visibleLeads.filter((l) => String(latestAsg[l.id]?.status || '') === 'recycled')
  }, [visibleLeads, poolSeg, ownerByLead, latestAsg])
  // 在手条数（屏 3 滑杆行 / 屏 6 建议人选）：当前有效归属按销售计数
  const loads = useMemo(() => {
    const m: Record<string, number> = {}
    for (const s of salesList) m[s] = 0
    for (const o of Object.values(ownerByLead)) m[o.salesName] = (m[o.salesName] || 0) + 1
    return m
  }, [salesList, ownerByLead])
  // 屏 2 资源池列表：分段（待分配/已分配/跟进中/已回收）∩ 搜索/来源/标签
  const poolFiltered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return poolLeads.filter((l) => {
      if (sourceChip !== '全部' && String(l.source) !== sourceChip) return false
      if (tagChip !== '全部' && String(l.tag || '').trim() !== tagChip) return false
      if (!q) return true
      return [l.name, l.contact_normalized, l.tag, l.source, l.note].some((v) => String(v || '').toLowerCase().includes(q))
    })
  }, [poolLeads, search, sourceChip, tagChip])
  // 前端分页：筛选后切片，page 越界自动收敛到最后一页
  const totalPages = Math.max(1, Math.ceil(poolFiltered.length / PAGE_SIZE))
  const curPage = Math.min(page, totalPages)
  const pageItems = poolFiltered.slice((curPage - 1) * PAGE_SIZE, curPage * PAGE_SIZE)

  // 屏 3 预览（纯前端，与后端 buildDistribution 同口径）
  const poolAvailable = poolCounts.pool
  const batchPreview = useMemo(() => distributePreview(assignMode, Math.min(batchCount, poolAvailable || batchCount), salesList, assignWeights, loads), [assignMode, batchCount, salesList, assignWeights, loads, poolAvailable])
  // 屏 6 左 待改派列表：最新分配行 recycled 的线索
  const reassignLeads = useMemo(() => leads.filter((l) => String(latestAsg[l.id]?.status || '') === 'recycled'), [leads, latestAsg])
  // 屏 4 销售资源卡三分段（buildMyCards 纯函数）：待跟进/跟进中按当前有效权属，已回收按最新分配行判——
  // 旧实现集合只来自有效 owner，回收行不在其中 → 「已回收」永远为空（2026-09-08 修复）
  const my = useMemo(() => buildMyCards(leads, latestAsg, ownerByLead, identity, Date.now()), [leads, latestAsg, ownerByLead, identity])
  const myWait = my.wait
  const myActive = my.active
  const myRecycled = my.recycled
  // 屏 3 执行分配
  const doAssignBatch = async () => {
    if (batchBusy || batchCount <= 0) return
    setBatchBusy(true)
    try {
      const r = await window.electronAPI.crm.assignmentAssignBatch({ count: batchCount, mode: assignMode, weights: assignWeights })
      if (!r.ok || !r.data) { setNotice(r.message || '批量分配失败'); return }
      const per = Object.entries(r.data.perSales).filter(([, n]) => n > 0).map(([s, n]) => `${s} ${n}`).join(' / ')
      setNotice(`批次 ${r.data.batchNo} 已分配 ${r.data.assigned} 条（${per}）${r.data.skipped.length ? `；跳过 ${r.data.skipped.length} 条` : ''}`)
      await fetchAll()
    } finally { setBatchBusy(false) }
  }
  const changeWeight = async (name: string, v: number) => {
    const next = { ...assignWeights, [name]: v }
    setAssignW(next)
    await setCrmAssignWeights(next)
  }
  // 屏 6 左 确认改派：recycled 行走回池再分配（assignLeads 同事务语义；transfer 仅限 active 行，E201）
  const doReassign = async (leadId: number, toSales: string) => {
    if (reassignBusy !== null || !toSales) return
    setReassignBusy(leadId)
    try {
      const r = await window.electronAPI.crm.assignmentAssign({ leadIds: [leadId], salesName: toSales })
      if (!r.ok) { setNotice(r.message || '改派失败'); return }
      setNotice(`已改派给 ${toSales}`)
      await fetchAll()
    } finally { setReassignBusy(null) }
  }

  const doRefresh = async () => { await window.electronAPI.crm.leadScanSla(); await fetchAll(); setNotice('已检查，超时未首触的线索已加入今日行动提醒') }

  const pickFile = async (file: File) => {
    setFileName(file.name)
    const isCsv = /\.csv$/i.test(file.name)
    if (isCsv) {
      const text = await file.text()
      setRows(parsePasteText(text))
      return
    }
    const buf = await file.arrayBuffer()
    const wb = new XLSX.Workbook()
    await wb.xlsx.load(buf)
    const ws = wb.worksheets[0]
    if (!ws) { setRows([]); return }
    const matrix: unknown[][] = []
    ws.eachRow((row) => { matrix.push(Array.isArray(row.values) ? (row.values as unknown[]).slice(1) : []) })
    setRows(matrixToRows(matrix))
  }

  const doImport = async () => {
    if (!rows.length) { setNotice('请先选择文件或粘贴文本'); return }
    const src = customSource.trim() || importSource
    const res = await window.electronAPI.crm.leadImport(src, fileName || '文本粘贴', rows)
    setShowImport(false); setRows([]); setFileName('')
    setNotice(`导入完成：新增 ${res.valid} 条，同批重复 ${res.dupSameBatch ?? 0} 条、线索池已有 ${res.dupExistingLead ?? 0} 条、正式客户已有 ${res.dupExistingCustomer ?? 0} 条、冲突待人工 ${res.conflicts ?? 0} 条${res.invalid ? `，无效 ${res.invalid} 条（已跳过）` : ''}`)
    // 查重明细（脱敏）拉取展示 + 可导出 CSV 复核
    try {
      const d = await window.electronAPI.crm.importDedupeDetail(res.batchId)
      setDedupeBatchId(res.batchId)
      setDedupeDetail(d?.rows || [])
    } catch { setDedupeDetail(null) }
    await fetchAll()
  }
  // 查重明细导出 CSV（BOM 头保证 Excel 中文不乱码；明细源端已脱敏，导出不出敏感原文）
  const exportDedupeCsv = () => {
    if (!dedupeDetail?.length) return
    const VERDICT: Record<string, string> = { inserted: '新增', duplicate: '同批重复', existing_lead: '线索池已有', existing_customer: '正式客户已有', conflict: '冲突待人工', invalid: '无效' }
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`
    const lines = [
      '行号,结果,原因,手机号(脱敏),微信号(脱敏),姓名,命中线索ID,命中客户ID',
      ...dedupeDetail.map((r) => [r.line, VERDICT[r.verdict] || r.verdict, esc(r.reason), r.phoneMasked, r.wechatMasked, esc(r.name), r.matchedLeadId ?? '', r.matchedAccountId ?? ''].join(','))
    ]
    const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `导入查重明细-批次${dedupeBatchId}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const act = async (id: number, action: 'contacted' | 'wx_added' | 'dead' | 'reopen', opts?: { channel?: string; reason?: string; note?: string; wechat?: string }) => {
    const r = await window.electronAPI.crm.leadStatus(id, action, opts)
    if (!r.ok) { setNotice(r.error || '操作失败'); return }
    await fetchAll()
    if (detail?.lead.id === id) await openDetail(id)
  }
  const openDetail = async (id: number) => {
    setSla2Ev({ loading: false, view: null }) // 换线索时清掉上一条的证据面板
    const d = await window.electronAPI.crm.leadDetail(id)
    // 屏 5 右：第二段 SLA 跟进状态（assignment.sla2_scan_ref 投影，随详情弹窗展示）
    const sla2 = sla2StatusView(latestAsg[id]?.sla2_scan_ref)
    // 归属留痕（设计稿屏 6 右，宪法 §1.8 ownership_history 只读）：随详情弹窗拉取，拉不到不阻塞详情
    let ownHist: OwnHistRow[] = []
    try {
      const h = await window.electronAPI.crm.ownershipHistory({ entityType: 'lead', entityId: id, pageSize: 50 })
      if (h?.ok) ownHist = (h.data?.rows || []) as OwnHistRow[]
    } catch { /* 留痕查询失败仅不显示时间线 */ }
    if (d.lead) setDetail({ lead: d.lead, activities: (d.activities || []) as any, ownHist, sla2 })
  }
  // 深链 /leads?leadId=<id>：从审计流水点「线索名」跳过来时自动打开详情。
  // deepLinkRef 记住已消费的 id，避免 searchParams 引用变化导致重复拉取。
  const deepLinkRef = useRef(0)
  useEffect(() => {
    const id = Number(searchParams.get('leadId') || 0)
    if (id <= 0 || deepLinkRef.current === id) return
    deepLinkRef.current = id
    void openDetail(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams])
  const toAccount = async (id: number) => {
    const r = await window.electronAPI.crm.leadToAccount(id)
    setNotice(r.ok ? (r.existed ? '已关联到已有客户' : `已转为客户 #${r.accountId}`) : r.error || '转客户失败')
    await fetchAll()
  }
  // SLA2「查看依据」：调统一证据读取接口（主进程脱敏出口，见 crmSla2EvidenceService）；失败显示明确状态
  const loadSla2Evidence = async (leadId: number) => {
    setSla2Ev({ loading: true, view: null })
    try {
      const v = await window.electronAPI.crm.sla2Evidence(leadId)
      setSla2Ev({ loading: false, view: v })
    } catch {
      setSla2Ev({ loading: false, view: { status: 'error', message: '证据读取失败（读取层故障），请稍后重试' } })
    }
  }
  const confirmDead = async () => {
    if (!deadLead || !deadReason) return
    await act(deadLead.id, 'dead', { reason: deadReason })
    setDeadLead(null); setDeadReason('')
  }
  // 编辑资料保存：只改姓名/微信号，不动状态；保存后刷新列表与详情
  const saveEdit = async () => {
    if (!editTarget) return
    const r = await window.electronAPI.crm.leadUpdate(editTarget.id, { name: editName.trim(), wechat: editWechat.trim() })
    if (!r.ok) { setNotice(r.error || '保存失败'); return }
    setEditTarget(null)
    await fetchAll()
    if (detail?.lead.id === editTarget.id) await openDetail(editTarget.id)
  }

  // ── 分配动作：勾选（仅 NEW 行可勾）→ 弹窗选销售 → 确认（写 assignment 三表，service 层事务）──
  const toggleSelect = (id: number) => setSelected((prev) => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })
  const toggleSelectPage = () => setSelected((prev) => {
    const pageNew = pageItems.filter((l) => l.status === 'NEW').map((l) => l.id)
    const allIn = pageNew.every((id) => prev.has(id))
    const next = new Set(prev)
    for (const id of pageNew) { if (allIn) next.delete(id); else next.add(id) }
    return next
  })
  // 名单维护（存 config crmSalesList）：现场加名并直接选中；删名不影响已分配记录
  const addSales = async () => {
    const n = newSales.trim()
    if (!n) return
    const next = salesList.includes(n) ? salesList : [...salesList, n]
    await setCrmSalesList(next)
    setSalesList(next)
    setAssignName(n)
    setNewSales('')
  }
  const removeSales = async (n: string) => {
    const next = salesList.filter((s) => s !== n)
    await setCrmSalesList(next)
    setSalesList(next)
    if (assignName === n) setAssignName('')
  }
  const doAssign = async () => {
    if (!assignName || !selected.size || assignBusy) return
    setAssignBusy(true)
    try {
      const r = await window.electronAPI.crm.assignmentAssign({ leadIds: [...selected], salesName: assignName })
      if (!r.ok) { setNotice(r.message || '分配失败'); return }
      const okN = r.data?.assignments.length ?? 0
      const skipN = r.data?.skipped.length ?? 0
      setNotice(skipN ? `已分配 ${okN} 条给 ${assignName}；${skipN} 条已有归属被跳过` : `已分配 ${okN} 条给 ${assignName}`)
      setSelected(new Set())
      setShowAssign(false)
      setAssignName('')
      await fetchAll()
    } finally { setAssignBusy(false) }
  }

  // ── 认领：本人 + assigned 态。确认后调 claim；顺手填的微信号接 1.4a 绑定链路（customer_identity + 停表 + 审计），
  //    绑定失败（如冲突 E204）回退 leadUpdate 仅落资料；昵称仍走 leadUpdate ──
  const doClaim = async () => {
    if (!claimTarget || claimBusy) return
    setClaimBusy(true)
    try {
      // actor 不传：服务端按身份档案姓名判「本人」（actor 姓名===sales_name 或身份档案姓名===sales_name）
      const r = await window.electronAPI.crm.assignmentClaim({ leadId: claimTarget.id })
      if (!r.ok) { setNotice(r.message || '认领失败'); return }
      const wechat = claimWechat.trim()
      const nick = claimNick.trim()
      let bindNote = ''
      if (wechat) {
        const b = await window.electronAPI.crm.identityBind({ leadId: claimTarget.id, wxid: wechat, displayName: nick })
        if (b.ok) bindNote = b.data?.alreadyBound ? '，该微信此前已绑定过' : '，微信已绑定并停表'
        else {
          // 绑定失败（E204 冲突等）：微信号退化为仅落 lead 资料，不进 customer_identity
          const u = await window.electronAPI.crm.leadUpdate(claimTarget.id, { wechat })
          bindNote = u.ok ? `，绑定失败（${b.message || '未知错误'}），微信号已仅作资料保存` : `，绑定失败（${b.message || '未知错误'}）`
        }
      }
      if (nick) {
        const u = await window.electronAPI.crm.leadUpdate(claimTarget.id, { name: nick })
        if (!u.ok) bindNote += `，昵称保存失败：${u.error || '未知错误'}`
      }
      setNotice(`已认领${bindNote}`)
      setClaimTarget(null); setClaimWechat(''); setClaimNick('')
      await fetchAll() // 刷新列表 + 归属 chips 计数
    } finally { setClaimBusy(false) }
  }

  // ── AI 首次分类（PRD 2.4）：认领满 24h 自动触发；本入口 = 手动「立即分析」。
  //    B 档纪律：结果只进 proposed 提案，确认后才落正式字段；失败可重试（failed 态）──
  const refreshClassifyRound = async (leadId: number) => {
    const r = await window.electronAPI.crm.firstClassifyList({ leadId, pageSize: 1 })
    setClassifyRound(r.ok && r.data.rows.length ? r.data.rows[0] : null)
  }
  const openClassify = async (l: LeadRow) => {
    setClassifyTarget(l); setClassifyRound(null); setClassifyRejectReason('')
    await refreshClassifyRound(l.id)
  }
  const doClassifyRun = async () => {
    if (!classifyTarget || classifyBusy) return
    setClassifyBusy(true)
    try {
      const r = await window.electronAPI.crm.firstClassifyRun({ leadId: classifyTarget.id })
      if (!r.ok) { setNotice(r.message || '首次分类失败（可稍后重试）') }
      else if (r.data?.reused) setNotice(`该轮已有结果（${r.data.status}），未重复调用模型`)
      else setNotice('首次分类提案已生成，请核对证据后确认或拒绝')
      await refreshClassifyRound(classifyTarget.id)
    } finally { setClassifyBusy(false) }
  }
  const doClassifyConfirm = async () => {
    if (!classifyRound || classifyBusy) return
    setClassifyBusy(true)
    try {
      const r = await window.electronAPI.crm.firstClassifyConfirm({ roundId: classifyRound.id })
      setNotice(r.ok ? '已确认：提案字段已落正式档案（写审计）' : (r.message || '确认失败'))
      if (classifyTarget) await refreshClassifyRound(classifyTarget.id)
    } finally { setClassifyBusy(false) }
  }
  const doClassifyReject = async () => {
    if (!classifyRound || classifyBusy) return
    setClassifyBusy(true)
    try {
      const r = await window.electronAPI.crm.firstClassifyReject({ roundId: classifyRound.id, reason: classifyRejectReason })
      setNotice(r.ok ? '已拒绝：提案不落入档案（拒绝记录已保留）' : (r.message || '拒绝失败'))
      if (classifyTarget) await refreshClassifyRound(classifyTarget.id)
    } finally { setClassifyBusy(false) }
  }

  // ── 绑定微信（PRD 1.4a 手动路）：选中本机联系人 → identityBind（写 username 内部 id，昵称仅显示用）──
  const doBind = async () => {
    if (!bindTarget || !bindSel || bindBusy) return
    setBindBusy(true)
    try {
      const displayName = String(bindSel.remark || bindSel.nickname || bindSel.alias || bindSel.username)
      const r = await window.electronAPI.crm.identityBind({ leadId: bindTarget.id, wxid: bindSel.username, displayName })
      if (!r.ok) { setNotice(r.message || '绑定失败'); return }
      setNotice(r.data?.alreadyBound
        ? `线索 ${maskLead(bindTarget)} 此前已绑定过该微信（幂等，未重复写入）`
        : `已绑定微信 ${displayName}，SLA1 已停表`)
      setBindTarget(null)
      await fetchAll()
    } finally { setBindBusy(false) }
  }

  // ── 调派（非销售角色）：旧行 transferred + 新行 assigned 重起 SLA1（service 层事务）──
  const doTransfer = async () => {
    const owner = transferTarget ? ownerByLead[transferTarget.id] : undefined
    if (!transferTarget || !owner || !transferTo || transferBusy) return
    setTransferBusy(true)
    try {
      const r = await window.electronAPI.crm.assignmentTransfer({ assignmentId: owner.assignmentId, toSales: transferTo, reason: transferReason.trim() || '人工调派' })
      if (!r.ok) { setNotice(r.message || '调派失败'); return }
      setNotice(`已调派给 ${transferTo}`)
      setTransferTarget(null); setTransferTo(''); setTransferReason('')
      await fetchAll()
    } finally { setTransferBusy(false) }
  }

  // ── 回收（非销售角色，二次确认）：lead 回资源池，可再分配 ──
  const doRecycle = async () => {
    const owner = recycleTarget ? ownerByLead[recycleTarget.id] : undefined
    if (!recycleTarget || !owner || recycleBusy) return
    setRecycleBusy(true)
    try {
      const r = await window.electronAPI.crm.assignmentRecycle({ assignmentId: owner.assignmentId, reason: '人工回收' })
      if (!r.ok) { setNotice(r.message || '回收失败'); return }
      setNotice('已回收，线索回到资源池')
      setRecycleTarget(null)
      await fetchAll()
    } finally { setRecycleBusy(false) }
  }

  // ── 离职移交（PRD §1.9，非销售角色）：actor 不传走服务端身份档案兜底链 ──
  const doDeparture = async () => {
    if (!departFrom || !departTo || departBusy) return
    setDepartBusy(true)
    try {
      const r = await window.electronAPI.crm.ownershipDeparture({ fromSales: departFrom, toSales: departTo })
      if (!r.ok) { setNotice(r.message || '离职移交失败'); return }
      const d = r.data!
      const parts = [`线索 ${d.leadsTransferred} 条`, `客户 ${d.accounts} 个`, `商机 ${d.opportunities} 条`, `物流 ${d.logistics} 单`]
      setNotice(`离职移交完成：${departFrom} → ${departTo}（${parts.join('，')}）${d.leadFailed.length ? `；${d.leadFailed.length} 条线索移交失败` : ''}`)
      setShowDeparture(false); setDepartFrom(''); setDepartTo('')
      await fetchAll()
    } finally { setDepartBusy(false) }
  }
  // 离职人候选 = 销售名单 ∪ 当前在岗归属人（离职者可能已被移出名单）
  const departFromOptions = useMemo(() => {
    const owners = Object.values(ownerByLead).map((o) => o.salesName)
    return Array.from(new Set([...salesList, ...owners])).filter(Boolean)
  }, [salesList, ownerByLead])

  const ov = overview
  // 屏 2 蓝横幅：最新导入批次统计（audit_event action=lead_import）
  const impDetail = parseJsonObject(importAudit?.detail)
  const segDefs: Array<{ id: typeof poolSeg; label: string; count: number }> = [
    { id: 'pool', label: '待分配', count: poolCounts.pool },
    { id: 'assigned', label: '已分配·待认领', count: poolCounts.assignedN },
    { id: 'active', label: '跟进中', count: poolCounts.activeN },
    { id: 'recycled', label: '已回收', count: poolCounts.recycledN }
  ]
  const salesSegDefs: Array<{ id: typeof salesSeg; label: string; count: number }> = [
    { id: 'wait', label: '待认领', count: myWait.length },
    { id: 'active', label: '跟进中', count: myActive.length },
    { id: 'recycled', label: '已回收', count: myRecycled.length }
  ]
  const MODE_LABEL: Record<AssignMode, string> = { weight: '比例权重', round_robin: '轮询', load: '负载均衡' }
  const myCardsShown = salesSeg === 'wait' ? myWait : salesSeg === 'active' ? myActive : myRecycled

  return (
    <div className="crm-lead-page">
      <div className="crm-header">
        <h2><Inbox size={18} /> 线索资源 <span className="count">共 {ov?.total ?? 0} 条</span></h2>
        {!salesView && managerTab === 'pool' && (
          <button className="crm-btn" onClick={doRefresh} title="重新检查线索的首触截止时间，超时未联系的会加入今日行动提醒"><RefreshCw size={14} /> 检查超时</button>
        )}
        {!salesView && selected.size > 0 && managerTab === 'pool' && (
          <button className="crm-btn primary" onClick={() => { setAssignName(''); setNewSales(''); setShowAssign(true) }}><UserCheck size={14} /> 分配给…（{selected.size}）</button>
        )}
        {!salesView && (
          <button className="crm-btn" title="销售离职时，把其名下的线索分配与客户/商机/物流归属批量移交给接手人" onClick={() => { setDepartFrom(''); setDepartTo(''); setShowDeparture(true) }}><UserX size={14} /> 离职移交</button>
        )}
        {!salesView && <button className="crm-btn primary" onClick={() => setShowImport(true)}><Upload size={14} /> 导入线索</button>}
      </div>
      {notice && <div className="crm-notice">{notice}</div>}

      {view === 'sales' ? (
        /* ── 屏 4：销售 · 我的资源卡 ── */
        <div className="lp-sales">
          <div className="lp-seg-wrap">
            <div className="lp-segs">
              {salesSegDefs.map((d) => (
                <button key={d.id} className={`lp-seg ${salesSeg === d.id ? 'on' : ''}`} onClick={() => setSalesSeg(d.id)}>{d.label} {d.count}</button>
              ))}
            </div>
            <span className="lp-hint">第一段 SLA：分配后 24h 内加好友；超时每 24h 复查，第 3 次抄送主管后回收改派</span>
          </div>
          {myCardsShown.map(({ lead: l, cd, recycled, sla2 }) => (
            <div key={l.id} className="lp-card" onClick={() => void openDetail(l.id)}>
              <div className="lp-card__main">
                <div className="lp-card__t1 num">{maskLead(l)} <span className={`pill pill--${cd.pill}`}>{recycled ? '已回收' : cd.pillText}</span></div>
                <div className="lp-card__t2">{String(l.source || '')}{l.tag ? ` · ${l.tag}` : ''}{l.note ? ` · ${l.note}` : ''} · 分配于 {fmtTime(Number(latestAsg[l.id]?.created_at || 0))}</div>
              </div>
              <div className={`lp-card__countdown ${cd.tier === 'wait_claim' ? 'ok' : cd.tier}`}>
                <div className="t num">{cd.text}</div>
                <div className="l">{recycled ? '已回资源池，等待改派' : cd.label}</div>
              </div>
              {!recycled && cd.tier === 'wait_claim' && (
                <button className="crm-btn primary" onClick={(e) => { e.stopPropagation(); setClaimTarget(l); setClaimWechat(''); setClaimNick('') }}><Hand size={13} /> 认领</button>
              )}
              {!recycled && (cd.tier === 'ok' || cd.tier === 'warn' || cd.tier === 'over') && (
                <button className="crm-btn" onClick={(e) => { e.stopPropagation(); setBindTarget(l) }}><Link2 size={13} /> 绑定微信</button>
              )}
              {!recycled && cd.tier !== 'wait_claim' && (
                <button className="crm-btn" title="认领满 24 小时自动触发；也可立即分析。结果为 AI 提案，确认后才写入客户档案" onClick={(e) => { e.stopPropagation(); void openClassify(l) }}><Sparkles size={13} /> AI 首次分类</button>
              )}
              {!recycled && cd.tier === 'done' && (
                <button className="crm-btn ghost" onClick={(e) => { e.stopPropagation(); void openDetail(l.id) }}>查看对话</button>
              )}
              {cd.tier === 'done' && (
                <div className="lp-sla2" onClick={(e) => e.stopPropagation()}>
                  {sla2 ? (
                    <span className={`pill pill--${sla2.pill}`}>{sla2.label}</span>
                  ) : (
                    <span className="pill pill--neutral">待扫描</span>
                  )}
                  <div className="lp-sla2__text">
                    {maskLead(l)} · {sla2 ? sla2.note : '暂无第二段结论，等规则/LLM 扫描或人工标记'}
                    <div className="lp-sla2__hint">{sla2 ? `结论时间 ${fmtTime(sla2.at)}${sla2.evidenceKey ? ' · 证据可回查' : ''}` : '第二段不计时，按对话判断跟进状态'}</div>
                  </div>
                </div>
              )}
            </div>
          ))}
          {myCardsShown.length === 0 && <div className="empty lp-empty">暂无资源卡</div>}
        </div>
      ) : (
        <>
          {/* 管理视角三页签（屏 2 / 屏 3 / 屏 6 左） */}
          <div className="lp-tabs">
            <button className={`lp-tab ${managerTab === 'pool' ? 'on' : ''}`} onClick={() => setManagerTab('pool')}>资源池</button>
            <button className={`lp-tab ${managerTab === 'console' ? 'on' : ''}`} onClick={() => setManagerTab('console')}>分配控制台</button>
            <button className={`lp-tab ${managerTab === 'reassign' ? 'on' : ''}`} onClick={() => setManagerTab('reassign')}>回收改派{poolCounts.recycledN > 0 ? ` (${poolCounts.recycledN})` : ''}{notifyUnread > 0 ? ` · 升级提醒 ${notifyUnread}` : ''}</button>
          </div>

          {managerTab === 'pool' && (
            <>
              <div className="lp-stats">
                {segDefs.map((d) => (
                  <button key={d.id} className={`lp-stat ${poolSeg === d.id ? 'on' : ''}`} onClick={() => { setPoolSeg(d.id); setPage(1) }}>
                    <div className="k">{d.label}</div>
                    <div className="v num">{d.count}{d.id === 'recycled' && d.count > 0 ? <small> 可改派</small> : ''}</div>
                  </button>
                ))}
              </div>
              {importAudit && (
                <div className="lp-banner">
                  ✓ 最近导入批次 #A{String(impDetail.batchId ?? '?')}：{String(impDetail.fileName || '导入')} {String(impDetail.total ?? 0)} 条 → 有效 {String(impDetail.valid ?? 0)} 条 · 查重拦截 {String(impDetail.duplicate ?? 0)} 条 · 无效 {String(impDetail.invalid ?? 0)} 条
                </div>
              )}
              <div className="crm-filterbar">
                <input className="crm-search" placeholder="搜索 手机号 / 微信号 / 备注…" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1) }} />
                {ov && ov.sources.length > 0 && (
                  <div className="crm-chips src">
                    <button className={`chip ${sourceChip === '全部' ? 'active' : ''}`} onClick={() => { setSourceChip('全部'); setPage(1) }}>全部来源</button>
                    {ov.sources.map((sr) => (
                      <button key={sr.source} className={`chip ${sourceChip === sr.source ? 'active' : ''}`} onClick={() => { setSourceChip(sr.source); setPage(1) }}>{sr.source} ({sr.count})</button>
                    ))}
                  </div>
                )}
                {tagChips.length > 0 && (
                  <div className="crm-chips src">
                    <button className={`chip ${tagChip === '全部' ? 'active' : ''}`} onClick={() => { setTagChip('全部'); setPage(1) }}>全部标签</button>
                    {tagChips.map((c) => (
                      <button key={c.value} className={`chip ${tagChip === c.value ? 'active' : ''}`} title="按标签（需求标签）筛选" onClick={() => { setTagChip(c.value); setPage(1) }}>{c.value} ({c.count})</button>
                    ))}
                  </div>
                )}
              </div>

              <table className="crm-table">
                <thead><tr><th className="lc-check"><input type="checkbox" title="全选本页待分配线索" checked={pageItems.length > 0 && pageItems.filter((l) => l.status === 'NEW').length > 0 && pageItems.filter((l) => l.status === 'NEW').every((l) => selected.has(l.id))} onChange={toggleSelectPage} /></th><th>联系方式</th><th>来源</th><th>需求标签</th><th>备注</th><th className="num">入池时间</th><th>入池方式</th><th>操作</th></tr></thead>
                <tbody>
                  {pageItems.map((l) => {
                    const latest = latestAsg[l.id]
                    const recycled = String(latest?.status || '') === 'recycled'
                    // 入池方式（§2.75 遗留精确化）：读真列 import_batch_id（importLeads 回填，宪法 §3）；
                    // NULL（该列上线前的存量导入）回退旧「时间近似判定」——贴最近导入审计 <10 分钟才算批次，不炸存量
                    const inPoolWay = Number(l.import_batch_id || 0) > 0
                      ? `批次 #A${Number(l.import_batch_id)}`
                      : (importAudit && Math.abs(Number(l.created_at || 0) - Number(importAudit.created_at || 0)) < 10 * 60_000
                          ? `批次 #A${String(impDetail.batchId ?? '?')}` : '存量导入')
                    return (
                      <tr key={l.id} onClick={() => void openDetail(l.id)}>
                        <td className="lc-check" onClick={(e) => e.stopPropagation()}>
                          {l.status === 'NEW' && <input type="checkbox" title="勾选后可批量分配" checked={selected.has(l.id)} onChange={() => toggleSelect(l.id)} />}
                        </td>
                        <td>
                          <div className="lc-contact num">{maskLead(l)} {l.wechat && <span className="lc-wechat">微信:{l.wechat}</span>}</div>
                          <div className="psub">{l.contact_type === 'wechat' ? '微信号' : l.contact_type === 'both' ? '手机+微信' : '手机号'}{l.name ? ` · ${l.name}` : ''}</div>
                        </td>
                        <td>{String(l.source || '-')}</td>
                        <td>{String(l.tag || '').trim() ? <span className="pill pill--neutral">{String(l.tag)}</span> : '-'}</td>
                        <td className="lp-note">{String(l.note || '-')}</td>
                        <td className="num">{fmtTime(l.created_at)}{recycled ? '（回池）' : ''}</td>
                        <td>{inPoolWay}</td>
                        <td className="lc-ops" onClick={(e) => e.stopPropagation()}>
                          <button className="crm-btn" title="编辑资料（姓名/微信）" onClick={() => { setEditTarget(l); setEditName(String(l.name || '')); setEditWechat(String(l.wechat || '')) }}><Pencil size={13} /></button>
                          {l.status === 'NEW' && <button className="crm-btn danger" title="标记失效" onClick={() => { setDeadLead(l); setDeadReason('') }}><X size={13} /></button>}
                        </td>
                      </tr>
                    )
                  })}
                  {poolFiltered.length === 0 && <tr><td colSpan={8} className="empty">该分段暂无线索{poolSeg === 'pool' ? '，点击右上角「导入线索」开始' : ''}</td></tr>}
                </tbody>
              </table>

              {poolFiltered.length > PAGE_SIZE && (
                <div className="crm-pager">
                  <button className="crm-btn" disabled={curPage <= 1} onClick={() => setPage(curPage - 1)}>上一页</button>
                  <span className="crm-pager-info">第 {curPage} / {totalPages} 页 · 共 {poolFiltered.length} 条</span>
                  <button className="crm-btn" disabled={curPage >= totalPages} onClick={() => setPage(curPage + 1)}>下一页</button>
                </div>
              )}
            </>
          )}

          {managerTab === 'console' && (
            <>
              <div className="lp-grid2">
                <div className="lp-cardbox">
                  <div className="lp-cardbox__title">分配模式 <span className="lp-hint">默认：比例权重</span></div>
                  <div className="lp-segs lp-segs--modes">
                    {(['weight', 'round_robin', 'load'] as AssignMode[]).map((m) => (
                      <button key={m} className={`lp-seg ${assignMode === m ? 'on' : ''}`} onClick={() => setAssignMode(m)}>{MODE_LABEL[m]}</button>
                    ))}
                  </div>
                  {salesList.map((s) => (
                    <div key={s} className="lp-slider-row">
                      <span className="name">{s}</span>
                      <input type="range" min={0} max={100} step={5} value={Number(assignWeights[s] ?? 0)} disabled={assignMode !== 'weight'}
                        onChange={(e) => void changeWeight(s, Number(e.target.value))} />
                      <span className="pct num">{Number(assignWeights[s] ?? 0)}%</span>
                      <span className="load num">在手 {loads[s] ?? 0} 条</span>
                    </div>
                  ))}
                  {salesList.length === 0 && <div className="empty">还没有销售名单。到「资源池」页签勾选线索后点击「分配给…」，可在弹窗中直接添加销售姓名。</div>}
                  <div className="lp-hint" style={{ marginTop: 10 }}>不调整权重时按人数均分；调整后会自动保存，每次分配都会保留审计记录。</div>
                </div>
                <div className="lp-cardbox">
                  <div className="lp-cardbox__title">本次分配预览</div>
                  <table className="crm-table lp-preview">
                    <thead><tr><th>销售</th><th className="num">分得</th><th>按</th></tr></thead>
                    <tbody>
                      {salesList.map((s) => (
                        <tr key={s}>
                          <td>{s}</td>
                          <td className="num"><b>{batchPreview[s] ?? 0}</b> 条</td>
                          <td className="psub">{assignMode === 'weight' ? `权重 ${Number(assignWeights[s] ?? 0)}%` : assignMode === 'round_robin' ? '轮询均分' : `在手 ${loads[s] ?? 0} 条（负载优先）`}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="lp-batch-row">
                    <span className="lp-hint">从「待分配」取</span>
                    <input type="number" min={1} max={Math.max(1, poolAvailable)} value={batchCount} onChange={(e) => setBatchCount(Math.max(1, Math.floor(Number(e.target.value) || 1)))} className="crm-input lp-count" />
                    <span className="lp-hint">条（池内待分配 {poolAvailable} 条）</span>
                    <span style={{ flex: 1 }} />
                    <button className="crm-btn" onClick={() => { setBatchCount(50); setAssignMode('weight') }}>取消</button>
                    <button className="crm-btn primary" disabled={batchBusy || poolAvailable === 0 || salesList.length === 0} onClick={() => void doAssignBatch()}><UserCheck size={13} /> {batchBusy ? '执行中…' : '执行分配'}</button>
                  </div>
                </div>
              </div>
              <div className="lp-cardbox" style={{ marginTop: 14 }}>
                <div className="lp-cardbox__title">最近分配记录 <span className="lp-hint">每次执行一行，可追溯到操作人（audit_event）</span></div>
                <table className="crm-table">
                  <thead><tr><th className="num">时间</th><th>批次</th><th>模式</th><th className="num">数量</th><th>分给</th><th>操作人</th></tr></thead>
                  <tbody>
                    {batchRows.slice(0, 8).map((r) => {
                      let d: Record<string, unknown> = {}
                      try { d = JSON.parse(String(r.detail || '{}')) } catch { /* 跳过 */ }
                      const per = Object.entries((d.perSales || {}) as Record<string, number>).filter(([, n]) => n > 0).map(([s, n]) => `${s} ${n}`).join(' / ')
                      return (
                        <tr key={String(r.id)}>
                          <td className="num">{fmtTime(Number(r.created_at))}</td>
                          <td className="num">#A{String(r.id)}</td>
                          <td>{MODE_LABEL[(String(d.mode || 'weight')) as AssignMode] || String(d.mode)}</td>
                          <td className="num">{String(d.assigned ?? 0)}</td>
                          <td>{per || '-'}</td>
                          <td>{String(r.actor || '')}</td>
                        </tr>
                      )
                    })}
                    {batchRows.length === 0 && <tr><td colSpan={6} className="empty">暂无批量分配记录</td></tr>}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {managerTab === 'reassign' && (
            <>
          {notifies.length > 0 && (
            <div className="lp-cardbox" style={{ marginBottom: 14 }}>
              <div className="lp-cardbox__title">升级提醒 <span className="pill pill--danger num">{notifyUnread}</span> <span className="lp-hint">SLA1 三次超时自动回收的主管通知（可投递、可确认已读）</span></div>
              <div className="lead-timeline">
                {notifies.map((n) => {
                  let d: Record<string, unknown> = {}
                  try { d = JSON.parse(String(n.detail || '{}')) } catch { /* 非 JSON detail 跳过 */ }
                  const unread = String(n.status) === 'unread'
                  return (
                    <div key={String(n.id)} className="lt-item" style={unread ? { fontWeight: 600 } : undefined}>
                      <span className="lt-time">{fmtTime(Number(n.created_at))}</span>
                      <span className="lt-act">{unread ? '未读' : '已读'}</span>
                      <span className="lt-note">{String(n.title || '')} — {String(n.body || '')}</span>
                      {unread && <button className="crm-btn" style={{ marginLeft: 8 }} onClick={() => void markNotifyRead(Number(n.id))}>标记已读</button>}
                      {Number(d.hubLeadId || 0) > 0 && <button className="crm-btn ghost" style={{ marginLeft: 8 }} onClick={() => { void openDetail(Number(d.hubLeadId)) }}>看线索</button>}
                    </div>
                  )
                })}
              </div>
            </div>
          )}
            <div className="lp-cardbox">
              <div className="lp-cardbox__title">待改派 <span className="pill pill--danger num">{reassignLeads.length}</span> <span className="lp-hint">回收改派优先给其他人，防止同一销售循环占位（设计稿屏 6）</span></div>
              <table className="crm-table">
                <thead><tr><th>线索</th><th>原归属</th><th>回收原因</th><th>建议改派给</th><th></th></tr></thead>
                <tbody>
                  {reassignLeads.map((l) => {
                    const from = String(latestAsg[l.id]?.sales_name || '')
                    const sug = suggestReassignOwner(from, salesList, loads)
                    return (
                      <tr key={l.id}>
                        <td>
                          <div className="lc-contact num">{maskLead(l)}</div>
                          <div className="psub">{String(l.source || '')}{l.note ? ` · ${l.note}` : ''}</div>
                        </td>
                        <td>{from || '-'}</td>
                        <td><span className="pill pill--danger">{recycleReasons[l.id] || '人工回收'}</span></td>
                        <td>
                          {sug ? <span className="pill pill--neutral">{sug}（建议）</span> : <span className="psub">名单无其他人，请先补充销售名单</span>}
                          <div className="psub">{sug ? `在手 ${loads[sug] ?? 0} 条 · 非原归属` : ''}</div>
                        </td>
                        <td>
                          <button className="crm-btn primary" disabled={!sug || reassignBusy === l.id} onClick={() => void doReassign(l.id, sug)}>
                            {reassignBusy === l.id ? '改派中…' : '确认改派'}
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                  {reassignLeads.length === 0 && <tr><td colSpan={5} className="empty">暂无待改派线索</td></tr>}
                </tbody>
              </table>
            </div>
            </>
          )}
        </>
      )}

      {showImport && (
        <div className="crm-modal" onClick={() => setShowImport(false)}>
          <div className="crm-modal-body lead-import" onClick={(e) => e.stopPropagation()}>
            <h3><Upload size={15} /> 导入线索 <button className="crm-btn" onClick={() => setShowImport(false)}><X size={14} /></button></h3>
            <div className="form-grid">
              <label>来源
                <select value={importSource} onChange={(e) => { setImportSource(e.target.value); setCustomSource('') }}>
                  {presetSources.map((s) => <option key={s}>{s}</option>)}
                  <option value="__custom">自定义…</option>
                </select>
              </label>
              {importSource === '__custom' && <label>自定义来源 <input placeholder="如：百度推广 / 线下展会" value={customSource} onChange={(e) => setCustomSource(e.target.value)} /></label>}
              <label>方式
                <select value={importTab} onChange={(e) => setImportTab(e.target.value as 'file' | 'paste')}>
                  <option value="paste">文本粘贴（一行一条）</option>
                  <option value="file">Excel / CSV 文件</option>
                </select>
              </label>
            </div>
            {importTab === 'file' ? (
              <div className="lead-file">
                <button className="crm-btn" onClick={() => fileRef.current?.click()}><FileSpreadsheet size={14} /> 选择文件</button>
                <input ref={fileRef} type="file" accept=".xlsx,.csv" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void pickFile(f); e.target.value = '' }} />
                <span className="lc-filename">{fileName || '支持 .xlsx / .csv，表头可含：手机号 / 微信 / 姓名 / 标签 / 备注'}</span>
              </div>
            ) : (
              <textarea className="lead-paste" rows={6} placeholder={'示例：\n张三 13800138000 微信kevin_x 求2T叉车\n李四 13900139000\n王五 加微信 wangwu_88 询价\n每行一条，手机号/微信号会自动识别'} onChange={(e) => { setRows(parsePasteText(e.target.value)); setFileName('') }} />
            )}
            <div className="lead-preview">已识别 {rows.length} 行{rows.length ? '，点击导入将写入线索池（重复号码自动跳过）' : ''}</div>
            <div className="form-actions">
              <button className="crm-btn primary" disabled={!rows.length} onClick={() => void doImport()}><ClipboardPaste size={14} /> 导入</button>
            </div>
          </div>
        </div>
      )}

      {detail && (
        <div className="crm-modal" onClick={() => setDetail(null)}>
          <div className="crm-modal-body lead-detail" onClick={(e) => e.stopPropagation()}>
            <h3>线索详情 <button className="crm-btn" onClick={() => setDetail(null)}><X size={14} /></button></h3>
            <div className="lead-detail-grid">
              <div><label>联系方式</label><div className="ld-strong">{detail.lead.contact_raw || detail.lead.contact_normalized}</div></div>
              <div><label>类型</label><div>{detail.lead.contact_type === 'wechat' ? '微信号' : detail.lead.contact_type === 'both' ? '手机号 + 微信' : '手机号'}{detail.lead.wechat ? `（微信 ${detail.lead.wechat}）` : ''}</div></div>
              <div><label>姓名</label><div>{detail.lead.name || '未命名'}</div></div>
              <div><label>来源</label><div>{detail.lead.source}</div></div>
              <div><label>标签</label><div>{detail.lead.tag || '-'}</div></div>
              <div><label>状态</label><div>{(STATUS_META[detail.lead.status] || { label: detail.lead.status }).label}{detail.lead.status === 'DEAD' && detail.lead.dead_reason ? `（${detail.lead.dead_reason}）` : ''}</div></div>
              <div><label>归属</label><div>{ownerByLead[detail.lead.id]?.salesName || '未分配'}</div></div>
              <div><label>导入时间</label><div>{fmtTime(detail.lead.created_at)}</div></div>
              <div><label>首触期限</label><div>{Number(detail.lead.first_contact_deadline) >= LEAD_SLA_UNASSIGNED_SENTINEL ? (ownerByLead[detail.lead.id] ? '待首触（分配后开始计时）' : '待分配（分配后开始计时）') : fmtTime(Number(detail.lead.first_contact_deadline))}{detail.lead.first_contacted_at ? `，已首触 ${fmtTime(Number(detail.lead.first_contacted_at))}（${CHANNEL_META[detail.lead.first_contact_channel ?? ''] || detail.lead.first_contact_channel || '电话'}）` : ''}</div></div>
              <div className="ld-note"><label>备注</label><div>{detail.lead.note || '-'}</div></div>
            </div>
            {detail.lead.status === 'NEW' && (
              <div className="lead-actions">
                <label>首触渠道
                  <select defaultValue="PHONE" id="contact-channel">
                    {CHANNELS.map((c) => <option key={c}>{c}</option>)}
                  </select>
                </label>
                <button className="crm-btn" onClick={() => void act(detail.lead.id, 'contacted', { channel: (document.getElementById('contact-channel') as HTMLSelectElement)?.value || 'PHONE' })}><Phone size={14} /> 完成首触</button>
                <input id="lead-wechat" className="crm-input" placeholder="客户微信号 / 昵称（可选）" defaultValue={detail.lead.wechat || ''} style={{ maxWidth: 180 }} />
                <button className="crm-btn" onClick={() => void act(detail.lead.id, 'wx_added', { wechat: (document.getElementById('lead-wechat') as HTMLInputElement)?.value || '' })}><MessageCircle size={14} /> 已加微信</button>
                <button className="crm-btn primary" onClick={() => void toAccount(detail.lead.id)}><UserPlus size={14} /> 转客户</button>
              </div>
            )}
            {detail.sla2 && (
              <>
                <h4>跟进状态 <span className="ld-ownhist-hint">第二段 SLA · 按对话判断，非计时器</span></h4>
                <div className="lp-sla2 lp-sla2--static">
                  <span className={`pill pill--${detail.sla2.pill}`}>{detail.sla2.label}</span>
                  <div className="lp-sla2__text">
                    {detail.sla2.note}
                    <div className="lp-sla2__hint">
                      结论时间 {fmtTime(detail.sla2.at)}
                      {detail.sla2.evidenceKey && (
                        <>
                          {' · '}
                          <button className="crm-btn" onClick={(e) => { e.stopPropagation(); void loadSla2Evidence(detail.lead.id) }} disabled={sla2Ev.loading}>
                            {sla2Ev.loading ? '读取中…' : '查看依据'}
                          </button>
                        </>
                      )}
                    </div>
                    {sla2Ev.view && (
                      <div className="lp-sla2__hint" style={{ marginTop: 6 }}>
                        {sla2Ev.view.status === 'found' ? (
                          <>
                            <div>依据（{sla2Ev.view.source === 'llm' ? 'LLM 判定' : sla2Ev.view.source === 'manual' ? '人工结论' : '规则命中'} · {sla2Ev.view.isSend ? '销售发出' : '客户发出'} · {fmtTime(Number(sla2Ev.view.createTimeMs || 0))}）：</div>
                            <div style={{ marginTop: 4 }}>{sla2Ev.view.text}</div>
                          </>
                        ) : (
                          <div>依据状态：{sla2Ev.view.message}</div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </>
            )}
            {detail.ownHist.length > 0 && (
              <>
                <h4>归属留痕 <span className="ld-ownhist-hint">ownership_history，只增不删</span></h4>
                <div className="lead-timeline">
                  {detail.ownHist.map((h) => {
                    // 动词由归属变化方向推导：空→有 = 分配（资源池）；有→空 = 回收（回资源池）；有→有 = 改派
                    const verb = !h.old_owner && h.new_owner ? '分配' : h.old_owner && !h.new_owner ? '回收' : '改派'
                    const from = h.old_owner || '资源池'
                    const to = h.new_owner || '资源池'
                    return (
                      <div key={h.id} className="lt-item">
                        <span className="lt-time">{fmtTime(h.created_at)}</span>
                        <span className="lt-act">{verb}</span>
                        <span className="lt-note">{from} → {to} · 操作人：{h.actor || '系统'}{h.reason ? ` · 理由：${h.reason}` : ''}</span>
                      </div>
                    )
                  })}
                </div>
              </>
            )}
            <h4>跟进流水</h4>
            <div className="lead-timeline">
              {detail.activities.map((a, i) => (
                <div key={i} className="lt-item"><span className="lt-time">{fmtTime(a.created_at)}</span><span className="lt-act">{a.action}</span><span className="lt-note">{a.note || ''}</span></div>
              ))}
              {detail.activities.length === 0 && <div className="empty">暂无流水</div>}
            </div>
          </div>
        </div>
      )}

      {showAssign && (
        <div className="crm-modal" onClick={() => { if (!assignBusy) setShowAssign(false) }}>
          <div className="crm-modal-body lead-dead" onClick={(e) => e.stopPropagation()}>
            <h3>分配线索（{selected.size} 条） <button className="crm-btn" onClick={() => setShowAssign(false)}><X size={14} /></button></h3>
            <p className="ld-tip">选一位销售；名单里没有就现场输入新名字（会自动记住，下次直接选）。已有归属的线索会自动跳过。</p>
            <div className="lc-sales-list">
              {salesList.map((n) => (
                <div key={n} className={`lc-sales-item ${assignName === n ? 'active' : ''}`} onClick={() => setAssignName(n)}>
                  <span>{n}</span>
                  <button className="crm-btn danger" title="从名单移除（不影响已分配的记录）" onClick={(e) => { e.stopPropagation(); void removeSales(n) }}><X size={12} /></button>
                </div>
              ))}
              {salesList.length === 0 && <div className="empty">还没有销售名单，先在下方添加</div>}
            </div>
            <div className="lc-sales-add">
              <input value={newSales} onChange={(e) => setNewSales(e.target.value)} placeholder="输入新销售姓名" onKeyDown={(e) => { if (e.key === 'Enter') void addSales() }} />
              <button className="crm-btn" disabled={!newSales.trim()} onClick={() => void addSales()}>添加并选中</button>
            </div>
            <div className="form-actions">
              <button className="crm-btn primary" disabled={!assignName || assignBusy} onClick={() => void doAssign()}><UserCheck size={14} /> {assignBusy ? '分配中…' : `确认分配${assignName ? `给 ${assignName}` : ''}`}</button>
            </div>
          </div>
        </div>
      )}

      {wxTarget && (
        <div className="crm-modal" onClick={() => setWxTarget(null)}>
          <div className="crm-modal-body lead-dead" onClick={(e) => e.stopPropagation()}>
            <h3>已加微信 <button className="crm-btn" onClick={() => setWxTarget(null)}><X size={14} /></button></h3>
            <p className="ld-tip">线索 {maskLead(wxTarget)} 标记为已加微信。顺手填上客户微信号/昵称，以后好认人（可留空）。</p>
            <label>客户微信号 / 昵称
              <input autoFocus value={wxInput} onChange={(e) => setWxInput(e.target.value)} placeholder="如：鸿富叉车-老王 / wxid_xxx" onKeyDown={(e) => { if (e.key === 'Enter') { void act(wxTarget.id, 'wx_added', { wechat: wxInput.trim() }); setWxTarget(null) } }} />
            </label>
            <div className="form-actions">
              <button className="crm-btn primary" onClick={() => { void act(wxTarget.id, 'wx_added', { wechat: wxInput.trim() }); setWxTarget(null) }}><MessageCircle size={14} /> 确认（{wxInput.trim() ? '记录微信' : '不填，直接标记'}）</button>
            </div>
          </div>
        </div>
      )}

      {editTarget && (
        <div className="crm-modal" onClick={() => setEditTarget(null)}>
          <div className="crm-modal-body lead-dead" onClick={(e) => e.stopPropagation()}>
            <h3>编辑资料 <button className="crm-btn" onClick={() => setEditTarget(null)}><X size={14} /></button></h3>
            <p className="ld-tip">线索 {maskLead(editTarget)}，只改姓名和微信，不影响线索状态。</p>
            <label>姓名
              <input autoFocus value={editName} onChange={(e) => setEditName(e.target.value)} placeholder="如：鸿富叉车-老王" />
            </label>
            <label>客户微信号 / 昵称
              <input value={editWechat} onChange={(e) => setEditWechat(e.target.value)} placeholder="如：wxid_xxx / 昵称" onKeyDown={(e) => { if (e.key === 'Enter') void saveEdit() }} />
            </label>
            <div className="form-actions">
              <button className="crm-btn primary" onClick={() => void saveEdit()}><Pencil size={14} /> 保存</button>
            </div>
          </div>
        </div>
      )}

      {deadLead && (
        <div className="crm-modal" onClick={() => setDeadLead(null)}>
          <div className="crm-modal-body lead-dead" onClick={(e) => e.stopPropagation()}>
            <h3>标记失效 <button className="crm-btn" onClick={() => setDeadLead(null)}><X size={14} /></button></h3>
            <p className="ld-tip">线索 {maskLead(deadLead)} 将标记为失效，之后仍可「重新跟进」。</p>
            <label>死因 <select value={deadReason} onChange={(e) => setDeadReason(e.target.value)}>
              <option value="">请选择死因</option>
              {['号码无效', '重复留资', '明确不要', '同行', '非目标客户', '已购车', '联系不上', '其他'].map((r) => <option key={r}>{r}</option>)}
            </select></label>
            <div className="form-actions"><button className="crm-btn danger" disabled={!deadReason} onClick={() => void confirmDead()}>确认失效</button></div>
          </div>
        </div>
      )}

      {claimTarget && (
        <div className="crm-modal" onClick={() => { if (!claimBusy) setClaimTarget(null) }}>
          <div className="crm-modal-body lead-dead" onClick={(e) => e.stopPropagation()}>
            <h3>认领线索 <button className="crm-btn" onClick={() => setClaimTarget(null)}><X size={14} /></button></h3>            <p className="ld-tip">确认认领线索 {maskLead(claimTarget)}（归属：{identity.name}）。认领后开始算你的；顺手填客户微信号/昵称，以后好认人（都可留空；填了微信号会同时「绑定微信」停 SLA1 表）。</p>
            <label>客户微信号（可选）
              <input autoFocus value={claimWechat} onChange={(e) => setClaimWechat(e.target.value)} placeholder="如：wxid_xxx" />
            </label>
            <label>客户昵称（可选）
              <input value={claimNick} onChange={(e) => setClaimNick(e.target.value)} placeholder="如：鸿富叉车-老王" onKeyDown={(e) => { if (e.key === 'Enter') void doClaim() }} />
            </label>
            <div className="form-actions">
              <button className="crm-btn primary" disabled={claimBusy} onClick={() => void doClaim()}><Hand size={14} /> {claimBusy ? '认领中…' : '确认认领'}</button>
            </div>
          </div>
        </div>
      )}

      {classifyTarget && (
        <div className="crm-modal" onClick={() => { if (!classifyBusy) setClassifyTarget(null) }}>
          <div className="crm-modal-body lead-dead" onClick={(e) => e.stopPropagation()}>
            <h3>AI 首次分类（PRD 2.4） <button className="crm-btn" onClick={() => setClassifyTarget(null)}><X size={14} /></button></h3>
            <p className="ld-tip">线索 {maskLead(classifyTarget)}。认领满 24 小时自动触发一次；也可手动立即分析。结果是 AI 提案（B 档），确认后才写入客户档案，拒绝则保留记录不落档案。</p>
            {!classifyRound && <div className="empty">暂无分类轮次。认领满 24h 会自动生成，或点下方「立即分析」。</div>}
            {classifyRound && (() => {
              let res: Record<string, any> = {}
              let ev: Record<string, any> = {}
              res = parseJsonObject(classifyRound.result_json)
              ev = parseJsonObject(classifyRound.evidence_json)
              const gaps = parseJsonArray<string>(classifyRound.gaps_json)
              const fields = (res.fields && typeof res.fields === 'object') ? Object.entries(res.fields) as Array<[string, any]> : []
              return (
                <div>
                  <p className="ld-tip">轮次 #{classifyRound.id} · 状态 {classifyRound.status} · 触发 {classifyRound.trigger_source === 'scan' ? '24h 扫描' : '手动'} · {fmtTime(classifyRound.created_at)}{classifyRound.decided_by ? ` · 裁决人 ${classifyRound.decided_by}` : ''}</p>
                  {classifyRound.status === 'failed' && <p className="ld-tip">上次分析失败（可重试）：{classifyRound.error || '未知原因'}</p>}
                  {(classifyRound.status === 'proposed' || classifyRound.status === 'confirmed' || classifyRound.status === 'rejected') && (
                    <div className="ld-tip">
                      <div>阶段初判：{FC_STAGE_LABEL[String(res.stage || 'unknown')] || res.stage}（置信 {Math.round(Number(res.stageConfidence || 0) * 100)}%）</div>
                      <div>客户类型：{FC_TYPE_LABEL[String(res.customerType || 'unknown')] || res.customerType}（置信 {Math.round(Number(res.customerTypeConfidence || 0) * 100)}%）</div>
                      <div>意向评分：{res.intentScore == null ? '证据不足' : res.intentScore}</div>
                      {fields.length > 0 && (
                        <div style={{ marginTop: 6 }}>
                          {fields.map(([k, v]) => (
                            <div key={k}>· {FC_FIELD_LABEL[k] || k}：{String(v?.value || '')}（来源 {String(v?.source || '?')}{v?.evidenceKey ? ' · 证据可回查' : v?.evidenceText ? ` · ${String(v.evidenceText).slice(0, 40)}` : ''}）</div>
                          ))}
                        </div>
                      )}
                      {Array.isArray(ev.droppedNoEvidence) && ev.droppedNoEvidence.length > 0 && (
                        <div className="psub">缺证据已丢弃：{ev.droppedNoEvidence.map((f: string) => FC_FIELD_LABEL[f] || f).join('、')}</div>
                      )}
                      {gaps.length > 0 && <div style={{ marginTop: 6 }}>信息缺口（已生成反问卡，建议下次聊天自然询问）：{gaps.map((g) => FC_GAP_LABEL[g] || g).join('、')}</div>}
                    </div>
                  )}
                </div>
              )
            })()}
            <div className="form-actions">
              {(!classifyRound || classifyRound.status === 'failed') && (
                <button className="crm-btn primary" disabled={classifyBusy} onClick={() => void doClassifyRun()}><Sparkles size={14} /> {classifyBusy ? '分析中…' : '立即分析'}</button>
              )}
              {classifyRound?.status === 'proposed' && (
                <>
                  <input value={classifyRejectReason} onChange={(e) => setClassifyRejectReason(e.target.value)} placeholder="拒绝原因（拒绝时建议填写）" style={{ flex: 1 }} />
                  <button className="crm-btn primary" disabled={classifyBusy} onClick={() => void doClassifyConfirm()}>确认写入档案</button>
                  <button className="crm-btn danger" disabled={classifyBusy} onClick={() => void doClassifyReject()}>拒绝</button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {bindTarget && (
        <div className="crm-modal" onClick={() => { if (!bindBusy) setBindTarget(null) }}>
          <div className="crm-modal-body lead-dead" onClick={(e) => e.stopPropagation()}>
            <h3>绑定微信 <button className="crm-btn" onClick={() => setBindTarget(null)}><X size={14} /></button></h3>
            <p className="ld-tip">线索 {maskLead(bindTarget)}（归属：{ownerByLead[bindTarget.id]?.salesName}）。搜本机微信联系人（备注/昵称/微信号关键词），选中确认即绑定——内部绑的是微信内部 id（改名不失效），命中即停 SLA1 表并留审计。</p>
            <label>搜索联系人
              <input autoFocus value={bindKw} onChange={(e) => { setBindKw(e.target.value); setBindSel(null) }} placeholder="备注 / 昵称 / 微信号关键词" />
            </label>
            <div className="lc-sales-list">
              {bindContacts === null && <div className="empty">正在读取本机联系人…</div>}
              {bindContacts !== null && bindMatches.length === 0 && <div className="empty">{bindKw.trim() ? '没有匹配的联系人' : '本机暂无可绑定的好友联系人'}</div>}
              {bindMatches.map((c) => {
                const shown = String(c.remark || c.nickname || c.alias || c.username)
                return (
                  <div key={c.username} className={`lc-sales-item ${bindSel?.username === c.username ? 'active' : ''}`} onClick={() => setBindSel(c)} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    {bindAvatars[c.username]
                      ? <img src={bindAvatars[c.username]} alt="" style={{ width: 24, height: 24, borderRadius: 4, flex: 'none' }} />
                      : <span style={{ width: 24, height: 24, borderRadius: 4, flex: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-hover, #eee)', fontSize: 12 }}>{shown.slice(0, 1)}</span>}
                    <span style={{ minWidth: 0 }}>
                      <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{shown}{c.remark && c.nickname && c.nickname !== c.remark ? <span className="psub">（昵称：{c.nickname}）</span> : null}</span>
                      <span className="psub" style={{ display: 'block' }}>微信号：{c.alias || c.username}</span>
                    </span>
                  </div>
                )
              })}
            </div>
            <div className="form-actions">
              <button className="crm-btn primary" disabled={!bindSel || bindBusy} onClick={() => void doBind()}><Link2 size={14} /> {bindBusy ? '绑定中…' : `确认绑定${bindSel ? `：${String(bindSel.remark || bindSel.nickname || bindSel.alias || bindSel.username)}` : ''}`}</button>
            </div>
          </div>
        </div>
      )}

      {transferTarget && (
        <div className="crm-modal" onClick={() => { if (!transferBusy) setTransferTarget(null) }}>
          <div className="crm-modal-body lead-dead" onClick={(e) => e.stopPropagation()}>
            <h3>调派线索 <button className="crm-btn" onClick={() => setTransferTarget(null)}><X size={14} /></button></h3>
            <p className="ld-tip">线索 {maskLead(transferTarget)} 当前归属 {ownerByLead[transferTarget.id]?.salesName}，选一位新销售接手（SLA 重新计时）。</p>
            <div className="lc-sales-list">
              {salesList.filter((n) => n !== ownerByLead[transferTarget.id]?.salesName).map((n) => (
                <div key={n} className={`lc-sales-item ${transferTo === n ? 'active' : ''}`} onClick={() => setTransferTo(n)}>
                  <span>{n}</span>
                </div>
              ))}
              {salesList.filter((n) => n !== ownerByLead[transferTarget.id]?.salesName).length === 0 && <div className="empty">名单里没有其他销售，请先在「分配给…」弹窗里加名</div>}
            </div>
            <label>调派原因（可选）
              <input value={transferReason} onChange={(e) => setTransferReason(e.target.value)} placeholder="默认：人工调派" />
            </label>
            <div className="form-actions">
              <button className="crm-btn primary" disabled={!transferTo || transferBusy} onClick={() => void doTransfer()}><ArrowLeftRight size={14} /> {transferBusy ? '调派中…' : `确认调派${transferTo ? `给 ${transferTo}` : ''}`}</button>
            </div>
          </div>
        </div>
      )}

      {recycleTarget && (
        <div className="crm-modal" onClick={() => { if (!recycleBusy) setRecycleTarget(null) }}>
          <div className="crm-modal-body lead-dead" onClick={(e) => e.stopPropagation()}>
            <h3>回收线索 <button className="crm-btn" onClick={() => setRecycleTarget(null)}><X size={14} /></button></h3>
            <p className="ld-tip">确认把线索 {maskLead(recycleTarget)}（当前归属 {ownerByLead[recycleTarget.id]?.salesName}）回收到资源池？回收后该销售不再看到它，可重新分配给其他销售。</p>
            <div className="form-actions">
              <button className="crm-btn" disabled={recycleBusy} onClick={() => setRecycleTarget(null)}>再想想</button>
              <button className="crm-btn danger" disabled={recycleBusy} onClick={() => void doRecycle()}><Undo2 size={14} /> {recycleBusy ? '回收中…' : '确认回收'}</button>
            </div>
          </div>
        </div>
      )}

      {showDeparture && (
        <div className="crm-modal" onClick={() => { if (!departBusy) setShowDeparture(false) }}>
          <div className="crm-modal-body lead-dead" onClick={(e) => e.stopPropagation()}>
            <h3>离职移交 <button className="crm-btn" onClick={() => setShowDeparture(false)}><X size={14} /></button></h3>
            <p className="ld-tip">把离职销售名下的<strong>全部</strong>归属一次性移交给接手人：线索分配（逐条调派，SLA 重新计时）+ 客户/商机/物流的归属人。全程留归属流水与审计，不可撤销。</p>
            <label>离职销售
              <select value={departFrom} onChange={(e) => setDepartFrom(e.target.value)}>
                <option value="">请选择</option>
                {departFromOptions.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
            <label>接手销售
              <select value={departTo} onChange={(e) => setDepartTo(e.target.value)}>
                <option value="">请选择</option>
                {salesList.filter((n) => n !== departFrom).map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
            <div className="form-actions">
              <button className="crm-btn danger" disabled={!departFrom || !departTo || departBusy} onClick={() => void doDeparture()}><UserX size={14} /> {departBusy ? '移交中…' : `确认移交${departFrom && departTo ? `（${departFrom} → ${departTo}）` : ''}`}</button>
            </div>
          </div>
        </div>
      )}
      {dedupeDetail !== null && (
        <div className="crm-modal" onClick={() => setDedupeDetail(null)}>
          <div className="crm-modal-body lead-detail" onClick={(e) => e.stopPropagation()}>
            <h3>导入查重明细（批次 #A{dedupeBatchId}） <button className="crm-btn" onClick={() => setDedupeDetail(null)}><X size={14} /></button></h3>
            <p className="ld-tip">手机号/微信号跨类型分别查重；双标识命中不同联系人 = 冲突待人工确认。明细中的联系方式已脱敏，可安全导出复核。</p>
            <div className="form-actions" style={{ justifyContent: 'flex-start' }}>
              <button className="crm-btn primary" disabled={!dedupeDetail.length} onClick={exportDedupeCsv}><FileSpreadsheet size={13} /> 导出明细 CSV</button>
            </div>
            <table className="crm-table">
              <thead><tr><th className="num">行号</th><th>结果</th><th>原因</th><th>联系方式（脱敏）</th><th>姓名</th></tr></thead>
              <tbody>
                {dedupeDetail.map((r) => (
                  <tr key={r.line}>
                    <td className="num">{r.line}</td>
                    <td><span className={`pill ${r.verdict === 'inserted' ? 'pill--success' : r.verdict === 'conflict' ? 'pill--danger' : 'pill--neutral'}`}>{({ inserted: '新增', duplicate: '同批重复', existing_lead: '线索池已有', existing_customer: '正式客户已有', conflict: '冲突待人工', invalid: '无效' } as Record<string, string>)[r.verdict] || r.verdict}</span></td>
                    <td>{r.reason || '-'}</td>
                    <td className="num">{[r.phoneMasked, r.wechatMasked].filter(Boolean).join(' / ') || '-'}</td>
                    <td>{r.name || '-'}</td>
                  </tr>
                ))}
                {dedupeDetail.length === 0 && <tr><td colSpan={5} className="empty">无明细记录</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
