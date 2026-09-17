/**
 * DeliveryAftersales.tsx —— 交付售后视图（合同工作台第二视图）
 *
 * 后端单点 = electron/services/crmDeliveryService.ts（宪法 §1.1/§1.5/§3 登记 2026-09-10）。
 * 页面只读后端事实与任务，禁止前端本地计算提醒/任务：
 *   crm.deliveryScan()                幂等同步四类 follow_up_task（差异/质保临期/质保到期/以旧换新）
 *   crm.deliveryTasks()               四类 pending 行动卡（页面提醒唯一来源，非前端推导）
 *   crm.deliverySuggestDate(oppId)    签收日期建议（只读 Suggestion；真实写入必须人工确认）
 *   crm.deliveryRegister(oppId, ...)  交付登记（实发量/交付日期/超发原因 + 审计）
 *   crm.deliverySaveEquipment(...)    设备档案 7 字段 + 质保字段（人工确认后写入 + 审计）
 *   crm.deliveryDecideTradeIn(...)    以旧换新提案 accept/reject（proposal_event + 审计，不改客户事实）
 * 复购等级 = shared/crmRepeat.computeRepeatLevel（前后端单一原语），UI 只投影。
 * 空值口径：日期 0 / 文本 '' → 「未登记」。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  CalendarCheck2, PackageCheck, RefreshCw, Repeat, Recycle, Save, Scale, ShieldAlert, Truck, Wrench
} from 'lucide-react'
import type { CustomerEquipmentRecord, OpportunityRecord } from '../../types/electron'
// 复购归并键/等级（与后端 crmAftersalesService.wonDeals / crmDeliveryService.recomputeRepeatLevel 同口径）
import { computeRepeatLevel, crmCustomerKeyForOpportunity } from '../../utils/crmDealKey'
// 归属过滤档（与父页面 CrmWorkbenchPage 同一语义源；展示层便利过滤，非安全边界 宪法 §1.12）
import { filterByOwner, filterCustomerTasks, buildCustomerOwners, countWonByCustomerKey, type DeliveryAccountOwner } from '../../utils/deliveryAftersalesView'
import { isSalesView, identityLikeFromIpc, type IdentityLike } from '../../utils/leadAssignmentView'
import { fmtDate, fmtQty, toDateInput, fromDateInput } from '../../utils/formatBiz'
import './DeliveryAftersales.scss'

// OpportunityRecord 类型上无 owner_sales 列（归属 SSOT 三表之一，查询已带出）；本地扩展补齐，不改 electron.d.ts
type OppRow = OpportunityRecord & { owner_sales?: string | null }

/** account 行（crm.customers() 返回 account.* 含 customer_id 挂接）：商机 → 客户档案的桥 */
interface AccountRow extends DeliveryAccountOwner {
  id: number
  customer_id?: number
  name?: string
  owner_sales?: string | null
}

/** 后端 follow_up_task 行动卡（crm.deliveryTasks() 返回，页面提醒唯一事实源） */
interface DeliveryTask {
  id: number
  title: string
  source_id: number
  trigger_type: string
  analysis: string
  due_at: number
  display_name: string
}

/** 设备档案表单字段（7 字段 + 质保起算日/期限，白名单对齐后端 EQUIPMENT_COLUMNS） */
const EQUIP_FIELDS: ReadonlyArray<{ key: string; label: string; type: 'text' | 'number' | 'date' | 'check' }> = [
  { key: 'brand', label: '设备品牌', type: 'text' },
  { key: 'model', label: '型号', type: 'text' },
  { key: 'vehicle_age', label: '车龄(年)', type: 'number' },
  { key: 'purchase_date', label: '购置日期', type: 'date' },
  { key: 'modified', label: '改装车', type: 'check' },
  { key: 'modified_date', label: '改装日期', type: 'date' },
  { key: 'battery_type', label: '电池类型', type: 'text' },
  { key: 'last_maintenance_date', label: '最后保养', type: 'date' },
  { key: 'warranty_start_date', label: '质保起算日', type: 'date' },
  { key: 'warranty_days', label: '质保期限(天)', type: 'number' }
]

/** 完整数值转换：非负整数 → number；空串/小数/脏输入 → null（不静默截断取整） */
function parseNonNegInt(raw: string): number | null {
  const t = raw.trim()
  if (t === '') return null
  const n = Number(t)
  return Number.isInteger(n) && n >= 0 ? n : null
}

/** 差异任务 analysis 里的缺口台数（后端出卡时已算好，前端只读投影） */
function diffGap(task: DeliveryTask): number {
  try {
    const a = JSON.parse(String(task.analysis || '{}')) as { gap?: number }
    return Number(a.gap || 0)
  } catch {
    return 0
  }
}

/** 设备档案编辑初始值（按 customer 行投影，日期 0/空串 → 空输入） */
function equipEditInit(record: CustomerEquipmentRecord | null): Record<string, string> {
  return {
    brand: String(record?.brand || ''),
    model: String(record?.model || ''),
    vehicle_age: Number(record?.vehicle_age) > 0 ? String(record?.vehicle_age) : '',
    purchase_date: toDateInput(record?.purchase_date),
    modified: Number(record?.modified) === 1 ? '1' : '0',
    modified_date: toDateInput(record?.modified_date),
    battery_type: String(record?.battery_type || ''),
    last_maintenance_date: toDateInput(record?.last_maintenance_date),
    warranty_start_date: toDateInput(record?.warranty_start_date),
    warranty_days: Number(record?.warranty_days) > 0 ? String(record?.warranty_days) : ''
  }
}

export default function DeliveryAftersales() {
  const [allDeals, setAllDeals] = useState<OppRow[]>([])
  const [deals, setDeals] = useState<OppRow[]>([])
  const [accountsById, setAccountsById] = useState<Map<number, AccountRow>>(new Map())
  const [customersById, setCustomersById] = useState<Map<number, CustomerEquipmentRecord>>(new Map())
  const [tasks, setTasks] = useState<{ diff: DeliveryTask[]; warrantyNear: DeliveryTask[]; warrantyExpired: DeliveryTask[]; tradeIn: DeliveryTask[] }>({
    diff: [], warrantyNear: [], warrantyExpired: [], tradeIn: []
  })
  const [suggestions, setSuggestions] = useState<Record<number, { date: number; source: string } | null>>({})
  const [loading, setLoading] = useState(false)
  const [notice, setNotice] = useState('')
  // 归属过滤档（同父页面 CrmWorkbenchPage 口径）：销售视角只留 owner_sales=本人或未归属的行；展示层便利，非安全边界（宪法 §1.12）
  const [identity, setIdentity] = useState<IdentityLike | null>(null)
  const fetchSeq = useRef(0)
  useEffect(() => {
    let alive = true
    void window.electronAPI.identity.get().then((idt) => {
      if (alive) setIdentity(identityLikeFromIpc(idt))
    }).catch(() => {
      if (alive) setIdentity({ name: '', role: '' })
    })
    return () => { alive = false }
  }, [])

  // 行内编辑态（按 opportunity id 索引；提交后清空回读真实值）
  const [edits, setEdits] = useState<Record<number, { shipped: string; delivery: string; overShip: string }>>({})
  // 设备档案编辑态（按 customer id 索引）
  const [equipEdits, setEquipEdits] = useState<Record<number, Record<string, string>>>({})

  // 身份显式传参（不用闭包 state）：先完成 identity 再首次拉数，结果必然按当时身份过滤，旧请求无从产生
  const fetchAll = async (idt: IdentityLike) => {
    const requestSeq = ++fetchSeq.current
    setLoading(true)
    setNotice('')
    try {
      // ① 幂等同步后端四类任务（差异/质保临期/质保到期/以旧换新，去重唯一 pending 卡）
      await window.electronAPI.crm.deliveryScan().catch(() => null)
      // ② 读成交单 + account 挂接 + 四类任务
      const [opps, accs, taskRes] = await Promise.all([
        window.electronAPI.crm.opportunityList({ status: 'won' }),
        window.electronAPI.crm.customers().catch(() => []),
        window.electronAPI.crm.deliveryTasks().catch(() => ({ diff: [], warrantyNear: [], warrantyExpired: [], tradeIn: [] }))
      ])
      const oppRows = (opps || []) as OppRow[]
      // 归属过滤：销售视角只留本人/未归属成交单（oppRows 保持未过滤全量，留给复购统计与任务归属推导用）
      const dealRows = filterByOwner(oppRows, idt)
      if (requestSeq !== fetchSeq.current) return
      setAllDeals(oppRows)
      setDeals(dealRows)
      const amap = new Map<number, AccountRow>()
      for (const a of (accs || []) as AccountRow[]) amap.set(Number(a.id), a)
      if (requestSeq !== fetchSeq.current) return
      setAccountsById(amap)
      // ③ 客户设备档案：account.customer_id → customer 行（逻辑外键，跨实体读）
      // account/customer 不单独过滤：页面只经成交卡渲染设备档案，dealRows 过滤后他人的客户自然不展示
      const custIds = [...new Set((accs || []).map((a: AccountRow) => Number(a.customer_id || 0)).filter((n) => n > 0))]
      const custRows = await Promise.all(custIds.map((id) =>
        window.electronAPI.crm.get('customer', id).catch(() => null)
      ))
      const cmap = new Map<number, CustomerEquipmentRecord>()
      custRows.forEach((c) => {
        if (c && Number(c.id) > 0) cmap.set(Number(c.id), c as CustomerEquipmentRecord)
      })
      if (requestSeq !== fetchSeq.current) return
      setCustomersById(cmap)
      // 任务卡归属推导（follow_up_task 无 owner 列，按 source 行反查归属）：
      //   差异卡 source_id=opportunity.id → 该商机 owner_sales（用未过滤全量 oppRows 建映射，
      //     避免把别人的卡算成未归属），过 filterByOwner 原语；
      //   质保临期/到期/以旧换新卡 source_id=customer.id → buildCustomerOwners 聚合该客户全部挂接
      //     account 的归属（与返回顺序无关）：任一挂接 account 未归属（owner 空）= 公共资源所有人可见；
      //     本人名在归属集合中 = 我名下可见；否则他人名下，销售视角不可见。管理视角原样返回零变化。
      const oppOwnerById = new Map<number, string>()
      for (const o of oppRows) oppOwnerById.set(Number(o.id), String(o.owner_sales || ''))
      const custOwnersById = buildCustomerOwners((accs || []) as AccountRow[])
      const tr = taskRes as { diff: DeliveryTask[]; warrantyNear: DeliveryTask[]; warrantyExpired: DeliveryTask[]; tradeIn: DeliveryTask[] }
      const filterTasks = (list: DeliveryTask[], ownerOf: (t: DeliveryTask) => string): DeliveryTask[] =>
        filterByOwner(list.map((t) => ({ ...t, owner_sales: ownerOf(t) })), idt)
      const filterCustomerTaskList = (list: DeliveryTask[]): DeliveryTask[] => filterCustomerTasks(list, custOwnersById, idt)
      if (requestSeq !== fetchSeq.current) return
      setTasks({
        diff: filterTasks(tr.diff, (t) => oppOwnerById.get(Number(t.source_id)) || ''),
        warrantyNear: filterCustomerTaskList(tr.warrantyNear),
        warrantyExpired: filterCustomerTaskList(tr.warrantyExpired),
        tradeIn: filterCustomerTaskList(tr.tradeIn)
      })
      // ④ 签收日期建议（只读 Suggestion；真实写入经 deliveryRegister 人工确认）
      const sug: Record<number, { date: number; source: string } | null> = {}
      await Promise.all(dealRows.map(async (o) => {
        sug[o.id] = await window.electronAPI.crm.deliverySuggestDate(o.id).catch(() => null)
      }))
      if (requestSeq !== fetchSeq.current) return
      setSuggestions(sug)
    } catch (e) {
      setNotice(`加载失败：${String(e)}`)
    } finally {
      if (requestSeq === fetchSeq.current) setLoading(false)
    }
  }

  // 先完成 identity，再首次加载；身份变化时重新读取并由 requestSeq 丢弃旧响应
  useEffect(() => { if (identity) void fetchAll(identity) }, [identity])

  const customerIdOf = (o: OppRow): number =>
    Number(accountsById.get(Number(o.account_id || 0))?.customer_id || 0)

  // 复购归并键（单一原语 shared/crmRepeat）：account.customer_id 优先，未挂接退 account_id
  const customerKeyOf = (o: OppRow): string => crmCustomerKeyForOpportunity(accountsById, o)

  // 复购等级统计遍历未过滤全量成交（allDeals）：归属过滤只控制卡片可见性，
  // 不得改变「该客户成交几笔」的事实——同一客户两笔分属甲乙时，甲的页面仍显示「复购」
  const wonCountByKey = useMemo(() => {
    return countWonByCustomerKey(allDeals, customerKeyOf)
    // 依赖 account 映射：account.customer_id 挂接回填后归并键随之变化
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allDeals, accountsById])

  const editOf = (o: OppRow) => {
    const e = edits[o.id]
    if (e) return e
    return {
      shipped: Number(o.shipped_qty) > 0 ? String(o.shipped_qty) : '',
      delivery: toDateInput(o.delivery_date),
      overShip: String(o.over_ship_reason || '')
    }
  }
  const setEdit = (id: number, patch: Partial<{ shipped: string; delivery: string; overShip: string }>) =>
    setEdits((prev) => {
      const deal = deals.find((d) => d.id === id)
      if (!deal) return prev
      return { ...prev, [id]: { ...editOf(deal), ...patch } }
    })

  // 交付登记（专用后端，含审计；签收日期必须人工确认后提交）
  const saveDelivery = async (o: OppRow) => {
    const e = editOf(o)
    const payload: { shipped_qty?: number; delivery_date?: number; over_ship_reason?: string } = {}
    const shippedStr = e.shipped.trim()
    if (shippedStr !== '') {
      // 完整转换 + 校验：'1.5'/'3abc' 等脏输入不静默截断，直接拦截提示
      const n = parseNonNegInt(shippedStr)
      if (n === null) { setNotice('实发量必须是非负整数'); return }
      payload.shipped_qty = n
    }
    if (e.delivery.trim() !== '') payload.delivery_date = fromDateInput(e.delivery)
    payload.over_ship_reason = e.overShip.trim()
    try {
      const res = await window.electronAPI.crm.deliveryRegister(o.id, payload)
      if (!res.ok) { setNotice(res.message || '交付登记失败'); return }
      setNotice(`已登记「${o.account_name || `#${o.id}`}」的实发量与交付日期`)
      setEdits((prev) => { const n = { ...prev }; delete n[o.id]; return n })
      await fetchAll(identity ?? { name: '', role: '' })
    } catch (err) {
      setNotice(`交付登记失败：${String(err)}`)
    }
  }

  const equipEditOf = (customerId: number): Record<string, string> =>
    equipEdits[customerId] ?? equipEditInit(customersById.get(customerId) ?? null)
  const setEquipEdit = (customerId: number, key: string, value: string) =>
    setEquipEdits((prev) => ({
      ...prev,
      [customerId]: { ...(prev[customerId] ?? equipEditInit(customersById.get(customerId) ?? null)), [key]: value }
    }))

  // 保存客户设备档案（7 字段 + 质保字段，人工确认后写入 + 审计）
  const saveEquipment = async (customerId: number) => {
    const e = equipEditOf(customerId)
    const fields: Record<string, unknown> = {}
    for (const f of EQUIP_FIELDS) {
      const raw = String(e[f.key] ?? '')
      if (f.type === 'check') fields[f.key] = raw === '1' ? 1 : 0
      else if (f.type === 'number') {
        // 空串 = 清除字段（写 0）；非空必须完整转换成非负整数，脏输入中止整个保存（不写部分字段）
        if (raw.trim() !== '') {
          const n = parseNonNegInt(raw)
          if (n === null) { setNotice(`${f.label}必须是非负整数`); return }
          fields[f.key] = n
        } else fields[f.key] = 0
      }
      else if (f.type === 'date') fields[f.key] = fromDateInput(raw)
      else fields[f.key] = raw.trim()
    }
    try {
      const res = await window.electronAPI.crm.deliverySaveEquipment(customerId, fields)
      if (!res.ok) { setNotice(res.message || '设备档案保存失败'); return }
      setNotice('客户设备档案已保存')
      setEquipEdits((prev) => { const n = { ...prev }; delete n[customerId]; return n })
      await fetchAll(identity ?? { name: '', role: '' })
    } catch (err) {
      setNotice(`设备档案保存失败：${String(err)}`)
    }
  }

  // 裁决以旧换新提案（accept/reject；后端只写 proposal_event + 审计，不改客户事实）
  const decideTradeIn = async (customerId: number, decision: 'accept' | 'reject') => {
    try {
      const res = await window.electronAPI.crm.deliveryDecideTradeIn(customerId, decision)
      if (!res.ok) { setNotice(res.message || '裁决失败'); return }
      setNotice(`已${decision === 'accept' ? '接受' : '拒绝'}以旧换新提案`)
      await fetchAll(identity ?? { name: '', role: '' })
    } catch (err) {
      setNotice(`裁决失败：${String(err)}`)
    }
  }

  return (
    <div className="da-section">
      <div className="da-header">
        <h3><Truck size={16} /> 交付售后</h3>
        <span className="da-header__sub">成交单交付登记 · 设备档案 · 差异任务 · 质保提醒 · 以旧换新 · 复购等级</span>
        <button className="crm-btn crm-btn--ghost" onClick={() => void fetchAll(identity ?? { name: '', role: '' })} disabled={loading}><RefreshCw size={13} /> 刷新</button>
      </div>
      {/* 归属过滤提示（与父页面同一文案/全局 class）：仅销售视角显示 */}
      {identity && isSalesView(identity) && <div className="owner-filter-hint">仅显示我名下及未归属的数据</div>}
      {notice && <div className="da-notice">{notice}</div>}

      {/* 数量差异任务（后端 follow_up_task，非前端推导）：订单量 > 实发量 */}
      <div className="da-diff">
        <h4><Scale size={14} /> 数量差异任务 <span className="da-diff__count">{tasks.diff.length}</span></h4>
        {tasks.diff.length === 0 ? (
          <div className="da-empty">暂无差异任务（订单量已全部实发或尚未登记订单量）</div>
        ) : (
          <div className="da-diff__list">
            {tasks.diff.map((t) => (
              <div key={t.id} className="da-diff__item">
                <span className="da-diff__who">{t.display_name || '未知客户'}</span>
                <span className="da-diff__nums">{t.title}</span>
                {diffGap(t) > 0 && <span className="da-pill da-pill--bad">差 {diffGap(t)} 台</span>}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 改装质保提醒（后端 follow_up_task，仅真实起算日 + 期限出卡，无真实日期不猜） */}
      {(tasks.warrantyExpired.length > 0 || tasks.warrantyNear.length > 0) && (
        <div className="da-warranty">
          <span className="da-warranty__label"><ShieldAlert size={14} /> 改装质保提醒</span>
          {tasks.warrantyExpired.map((t) => (
            <span key={t.id} className="da-pill da-pill--bad" title={t.title}>{t.title}</span>
          ))}
          {tasks.warrantyNear.map((t) => (
            <span key={t.id} className="da-pill da-pill--acc" title={t.title}>{t.title}</span>
          ))}
        </div>
      )}

      {/* 以旧换新提案（后端 follow_up_task + proposal_event；仅出提案卡，不改客户事实） */}
      {tasks.tradeIn.length > 0 && (
        <div className="da-tradein">
          <span className="da-tradein__label"><Recycle size={14} /> 以旧换新提案</span>
          {tasks.tradeIn.map((t) => (
            <div key={t.id} className="da-tradein__row">
              <span className="da-tradein__item">{t.title}</span>
              <button className="crm-btn crm-btn--primary" onClick={() => void decideTradeIn(Number(t.source_id), 'accept')}>接受</button>
              <button className="crm-btn crm-btn--ghost" onClick={() => void decideTradeIn(Number(t.source_id), 'reject')}>拒绝</button>
            </div>
          ))}
        </div>
      )}

      {/* 成交单卡片：交付登记 + 设备档案 + 复购等级 */}
      {loading && <div className="da-empty">加载中…</div>}
      {!loading && deals.length === 0 && <div className="da-empty">暂无成交单（商机页标记成交后在此登记交付）</div>}
      {deals.map((d) => {
        const edit = editOf(d)
        const customerId = customerIdOf(d)
        const record = customerId > 0 ? customersById.get(customerId) ?? null : null
        const equipEdit = equipEditOf(customerId)
        const suggestion = suggestions[d.id] ?? null
        // 超发判断与 saveDelivery 同一口径：非法输入不算超发（提交时会被 saveDelivery 校验拦下提示）
        const shippedVal = parseNonNegInt(edit.shipped)
        const overShip = shippedVal !== null && shippedVal > Number(d.order_qty)
        const level = computeRepeatLevel(wonCountByKey.get(customerKeyOf(d)) || 1)
        return (
          <div key={d.id} className="da-card">
            <div className="da-card__head">
              <b className="da-card__who">{d.account_name || `商机 #${d.id}`}</b>
              <span className="da-card__model">{d.main_model || d.product || '未登记型号'}</span>
              <span className="da-pill da-pill--neu">{d.type || '未登记'}</span>
              <span className="da-pill da-pill--ok"><Repeat size={10} /> {level}</span>
            </div>

            {/* ① 交付登记：实发量 / 交付日期 + ② 签收日期建议（人工确认后提交） */}
            <div className="da-card__row">
              <PackageCheck size={13} />
              <label>订单量</label>
              <b>{fmtQty(d.order_qty)}</b>
              <label>实发量</label>
              <input type="number" min="0" step="1" value={edit.shipped}
                onChange={(e) => setEdit(d.id, { shipped: e.target.value })} placeholder="未登记" />
              <label>交付日期</label>
              <input type="date" value={edit.delivery}
                onChange={(e) => setEdit(d.id, { delivery: e.target.value })} />
              {!edit.delivery && suggestion && (
                <button className="crm-btn crm-btn--ghost" title={`建议来源：${suggestion.source}`}
                  onClick={() => setEdit(d.id, { delivery: toDateInput(suggestion.date) })}>
                  <CalendarCheck2 size={12} /> 采用建议 {fmtDate(suggestion.date)}
                </button>
              )}
              <button className="crm-btn crm-btn--primary" onClick={() => void saveDelivery(d)}><Save size={12} /> 确认提交</button>
            </div>
            {overShip && (
              <div className="da-card__row da-card__row--equip">
                <label>超发原因（必填）</label>
                <input type="text" value={edit.overShip}
                  onChange={(e) => setEdit(d.id, { overShip: e.target.value })} placeholder="填写超发原因" />
              </div>
            )}
            <div className="da-card__hint">
              {suggestion
                ? <>签收日期建议：<b>{fmtDate(suggestion.date)}</b>（来源：{suggestion.source}）· 确认无误后点「确认提交」回填交付日期</>
                : <>签收日期建议：未登记（无交付日期且无物流签收/轨迹）· 可手动选择日期后提交</>}
            </div>

            {/* ④ 客户设备档案录入与展示（7 字段 + 质保字段） */}
            <div className="da-card__row da-card__row--equip">
              <Wrench size={13} />
              {customerId > 0 ? (
                <>
                  {EQUIP_FIELDS.map((f) => {
                    const val = equipEdit[f.key] ?? ''
                    if (f.type === 'check') {
                      return (
                        <label key={f.key} className="da-check">
                          <input type="checkbox" checked={val === '1'}
                            onChange={(e) => setEquipEdit(customerId, f.key, e.target.checked ? '1' : '0')} />
                          {f.label}
                        </label>
                      )
                    }
                    return (
                      <span key={f.key} className="da-equip-field">
                        <label>{f.label}</label>
                        <input type={f.type} min={f.type === 'number' ? 0 : undefined} step={f.type === 'number' ? 1 : undefined}
                          value={val} onChange={(e) => setEquipEdit(customerId, f.key, e.target.value)} placeholder="未登记" />
                      </span>
                    )
                  })}
                  <button className="crm-btn" onClick={() => void saveEquipment(customerId)}><Save size={12} /> 保存设备档案</button>
                </>
              ) : (
                <span className="da-card__hint">该客户未关联客户档案（customer），设备档案不可录入</span>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
