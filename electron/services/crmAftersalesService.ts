/**
 * crmAftersalesService.ts —— 售后规则（PRD §1.6 售后生命周期 / §1.7 R9-R11 / §1.7a 设备级周期提醒 / §1.7b R12）
 *
 * 落法与线索 SLA / R7 / R8 同构：规则扫描（事实驱动，非 LLM，A 档）→ follow_up_task 行动卡
 * （created_by='aftersales'，独立于 action_engine 每日重扫清理，沿 scanLeadSla 的 'sla' 先例）
 * → 今日行动统一信号流展示。去重 = idx_ft_sla_once（trigger_type+source_id  pending 唯一）
 * + 应用层 pendingTaskBySource / hasAnyTaskBySource。
 *
 * 规则明细（PRD 原文口径）：
 *   §1.6  售后生命周期（每笔成交独立走）：成交 → 已交付 → 待回访 → 复购/老客。
 *         纯推导函数 dealAftersalesStage（不建列不建表，宪法不新增事实源）；
 *         复购客户（≥2 笔成交）叠加客户级关系维护 = R10 回访加频（多 60 天档）。
 *   §1.7  R9 经销商拿货：签收第 10 天预警卡，第 15 天 deadline（pending 卡到期升级标题/提分）。
 *   §1.7  R10 回访：成交后 15/30/90 天各一张回访卡（一次性，发过不再发）；
 *         与 R5 沉默唤醒互斥 = 已成交客户不走 R5（salesActionEngine 既有守卫：won/lost 跳过，不动）。
 *   §1.7  R11 阶段停滞：比价(quoted)>14 天 / 决策(negotiating)>21 天 → 停滞卡
 *         （以 customer_profile.last_stage_change_at 为阶段进入时刻；pending 去重 = 统一去重压制）。
 *   §1.7a 设备级周期提醒（按交付日期 delivery_date 起算）：轮子磨损 180 天 / 液压起升系统检查 365 天 /
 *         电池健康 1095 天（锂电 3-5 年取下限）——一次性提醒。本产品为非特种设备，无年检类提醒。
 *   §1.7b R12 经销商拿货周期预警（简单版）：经销商 60 天未拿货 → 主动联系提醒卡。
 *
 * ⚠️ 缺口注记（不新造数据，后续刀）：
 *   1. opportunity.delivery_date 尚无录入入口（D3 只建了列）——设备提醒与「已交付」判定暂靠
 *      物流签收（logistics.signed_at）推断；录入入口上线后自动生效。
 *   2. 改装件质保到期：无质保到期字段，未实现；以旧换新信号：依赖 customer 设备档案
 *      （brand/vehicle_age/modified）实数据，未实现。
 *   3. 「升 A 级」：现无客户分级字段，复购识别只用于 R10 加频，不写任何分级。
 *   4. R12 学习版（按历史拿货间隔个性化阈值）= Phase 4，本刀固定 60 天。
 *   5. 阈值全部为常量（PRD 定格 10/15/15-30-90/14/21/60），未做配置项。
 */
import { crmDbService, type CrmRow } from './crmDbService'
import { salesDbService } from './salesDbService'
import { normalizeStage } from '../../shared/salesStage'

const DAY_MS = 86400_000

// ─── 阈值常量（PRD §1.7/§1.7a/§1.7b 定格）────────────────────────────────────
export const R9_WARN_DAYS = 10
export const R9_DEADLINE_DAYS = 15
export const R10_MILESTONES = [15, 30, 90] as const
/** 复购/老客（≥2 笔成交）回访频率提高：叠加 60 天档（§1.6 客户级关系维护） */
export const R10_REPEAT_EXTRA_MILESTONE = 60
export const R11_QUOTED_STALL_DAYS = 14
export const R11_NEGOTIATING_STALL_DAYS = 21
export const DEVICE_RULES = [
  { kind: 'wheel', trigger: 'rule_dev_wheel', days: 180, label: '轮子磨损检查（PU/尼龙轮 6-12 个月）' },
  { kind: 'hydraulic', trigger: 'rule_dev_hydraulic', days: 365, label: '液压起升系统检查（PRD 未定周期，取 12 个月）' },
  { kind: 'battery', trigger: 'rule_dev_battery', days: 1095, label: '电池健康/更换评估（锂电 3-5 年取下限）' }
] as const
export const R12_REORDER_DAYS = 60

// ─── §1.6 售后生命周期（纯推导，不建列）─────────────────────────────────────
export type DealAftersalesStage = '成交' | '已交付' | '待回访' | '复购老客'

/**
 * 每笔成交独立走：成交 → 已交付（有交付时间）→ 待回访（交付满 15 天）→ 复购/老客（≥2 笔成交）。
 * deliveredAt = opportunity.delivery_date，缺省时由调用方用物流签收时间推断（0 = 未交付）。
 */
export function dealAftersalesStage(d: { wonAt: number; deliveredAt: number; repeat: boolean }, now = Date.now()): DealAftersalesStage | '' {
  if (!d.wonAt) return ''
  if (d.repeat) return '复购老客'
  if (!d.deliveredAt) return '成交'
  return now - d.deliveredAt >= R10_MILESTONES[0] * DAY_MS ? '待回访' : '已交付'
}

// ─── 共用：成交商机查询 + 交付时间推断 ───────────────────────────────────────
interface WonDeal {
  id: number
  account_id: number
  customer_id: number
  name: string
  account_name: string
  session_id: string
  main_model: string
  product: string
  delivery_date: number
  wonAt: number
  deliveredAt: number
  repeat: boolean
}

function wonDeals(): WonDeal[] {
  const rows = crmDbService.all(
    `SELECT o.id, o.account_id, o.main_model, o.product, o.delivery_date, o.updated_at,
            COALESCE(a.customer_id, 0) AS customer_id,
            COALESCE(a.name, '') AS account_name, COALESCE(a.session_id, '') AS session_id
     FROM opportunity o LEFT JOIN account a ON a.id = o.account_id
     WHERE o.status = 'won' ORDER BY o.id`
  )
  // 成交时刻 = opportunity_event 'won' 事件时间，兜底 opportunity.updated_at
  const deals = rows.map((r) => {
    const ev = crmDbService.all(
      "SELECT MAX(created_at) AS t FROM opportunity_event WHERE opportunity_id = ? AND event_type = 'won'",
      [Number(r.id)]
    )[0]
    return {
      id: Number(r.id), account_id: Number(r.account_id || 0), customer_id: Number(r.customer_id || 0),
      name: String(r.name || ''), account_name: String(r.account_name || ''), session_id: String(r.session_id || ''),
      main_model: String(r.main_model || ''), product: String(r.product || ''),
      delivery_date: Number(r.delivery_date || 0),
      wonAt: Number(ev?.t || 0) || Number(r.updated_at || 0),
      deliveredAt: 0, repeat: false
    } as WonDeal
  })
  // 复购判定：同 customer（无挂接退同 account）≥2 笔成交
  const countByKey = new Map<string, number>()
  for (const d of deals) {
    const key = d.customer_id > 0 ? `c:${d.customer_id}` : `a:${d.account_id}`
    countByKey.set(key, (countByKey.get(key) || 0) + 1)
  }
  for (const d of deals) {
    const key = d.customer_id > 0 ? `c:${d.customer_id}` : `a:${d.account_id}`
    d.repeat = (countByKey.get(key) || 0) >= 2
    // 交付时间：delivery_date 优先，缺省用该 account 最近签收物流推断（缺口注记 1）
    if (d.delivery_date > 0) d.deliveredAt = d.delivery_date
    else if (d.account_id > 0) {
      const lg = crmDbService.all(
        "SELECT MAX(signed_at) AS t FROM logistics WHERE account_id = ? AND status = 'signed' AND signed_at > 0",
        [d.account_id]
      )[0]
      d.deliveredAt = Number(lg?.t || 0)
    }
  }
  return deals
}

/** 建卡（去重后）：返回 true = 新建成 */
function createCard(opts: {
  trigger: string; sourceId: number; sessionId: string; displayName: string
  title: string; score: number; dueAt?: number
}): boolean {
  salesDbService.todoCreate({
    session_id: opts.sessionId || null,
    display_name: opts.displayName || null,
    trigger_type: opts.trigger,
    title: opts.title,
    source_id: opts.sourceId,
    status: 'pending',
    priority_score: opts.score,
    due_at: opts.dueAt ?? null,
    created_by: 'aftersales'
  })
  return true
}

// ─── §1.7 R9 经销商拿货预警（签收第 10 天预警，15 天 deadline）────────────────
export function runR9DealerRestockScan(now = Date.now()): { warned: number; escalated: number } {
  const rows = crmDbService.all(
    `SELECT l.id, l.tracking_no, l.brand, l.signed_at,
            COALESCE(a.name, '') AS account_name, COALESCE(a.session_id, '') AS session_id
     FROM logistics l
     LEFT JOIN contract c ON c.id = l.contract_id
     JOIN account a ON a.id = COALESCE(c.account_id, l.account_id)
     JOIN customer cu ON cu.id = a.customer_id AND cu.deleted = 0
     WHERE l.status = 'signed' AND l.signed_at > 0 AND cu.type = 'dealer'
     ORDER BY l.signed_at`
  )
  let warned = 0, escalated = 0
  for (const r of rows) {
    const days = (now - Number(r.signed_at)) / DAY_MS
    if (days < R9_WARN_DAYS) continue
    const logiId = Number(r.id)
    const name = String(r.account_name || '未知')
    const sid = String(r.session_id || '') || `logi:${logiId}`
    const existing = salesDbService.pendingTaskBySource('rule_r9_dealer_restock', logiId)
    if (!existing) {
      createCard({
        trigger: 'rule_r9_dealer_restock', sourceId: logiId, sessionId: sid, displayName: name,
        title: `经销商拿货回访：${name}，签收第 ${Math.floor(days)} 天（${String(r.brand || '')} 单号 ${String(r.tracking_no || '')}），主动问使用/分销情况`,
        score: 80 + Math.min(Math.floor(days), 15),
        dueAt: Number(r.signed_at) + R9_DEADLINE_DAYS * DAY_MS
      })
      warned++
    } else if (days >= R9_DEADLINE_DAYS && Number(existing.priority_score || 0) < 100) {
      // 15 天 deadline 已过仍未处理 → 升级标题 + 提 urgent 分（不新建卡，避免重复骚扰）
      salesDbService.todoUpdate(Number(existing.id), {
        title: `经销商拿货超期：${name}，签收已 ${Math.floor(days)} 天（超 ${R9_DEADLINE_DAYS} 天 deadline），必须今天联系`,
        priority_score: 100 + Math.min(Math.floor(days - R9_DEADLINE_DAYS), 20)
      })
      escalated++
    }
  }
  return { warned, escalated }
}

// ─── §1.7 R10 成交回访（15/30/90 天，一次性；复购老客加 60 天档）─────────────
export function runR10RevisitScan(now = Date.now()): { created: number } {
  let created = 0
  for (const d of wonDeals()) {
    if (!d.wonAt) continue
    const milestones: number[] = [...R10_MILESTONES]
    if (d.repeat) milestones.push(R10_REPEAT_EXTRA_MILESTONE)
    const lifecycle = dealAftersalesStage(d, now)
    // 每单每次扫描只出「最近一个到期且未发过」的里程碑卡（后发先补：31 天首扫只出 30 天档，
    // 不一次性补 15+30 两张骚扰卡；15 天档视为已过期跳过）
    const due = milestones.filter((m) => now >= d.wonAt + m * DAY_MS && !salesDbService.hasAnyTaskBySource(`rule_r10_revisit_${m}`, d.id))
    const m = due.length ? Math.max(...due) : 0
    if (!m) continue
    const name = d.account_name || '未知'
    createCard({
      trigger: `rule_r10_revisit_${m}`, sourceId: d.id,
      sessionId: d.session_id || `deal:${d.id}`, displayName: name,
      title: `成交回访：${name}，成交满 ${m} 天（${d.main_model || d.product || d.name || '设备'}，${lifecycle}），回访使用体验${d.repeat && m === R10_REPEAT_EXTRA_MILESTONE ? '（老客加频档）' : ''}`,
      score: 60 + (m <= 30 ? 10 : 0)
    })
    created++
  }
  return { created }
}

// ─── §1.7 R11 阶段停滞（比价>14 天 / 决策>21 天，pending 去重压制）────────────
export function runR11StallScan(now = Date.now()): { created: number } {
  let created = 0
  for (const p of salesDbService.customerAll()) {
    const stage = normalizeStage(String(p.stage || ''))
    const threshold = stage === 'quoted' ? R11_QUOTED_STALL_DAYS : stage === 'negotiating' ? R11_NEGOTIATING_STALL_DAYS : 0
    if (!threshold) continue
    const changedAt = Number((p as CrmRow).last_stage_change_at || 0)
    if (!changedAt) continue // 无阶段进入时刻 = 数据缺失合法态，不猜
    const days = (now - changedAt) / DAY_MS
    if (days < threshold) continue
    const trigger = stage === 'quoted' ? 'rule_r11_quoted_stall' : 'rule_r11_negotiating_stall'
    const pid = Number((p as CrmRow).id || 0)
    if (!pid || salesDbService.pendingTaskBySource(trigger, pid)) continue // 统一去重压制
    const name = String(p.display_name || '未知')
    createCard({
      trigger, sourceId: pid, sessionId: String(p.session_id || ''), displayName: name,
      title: `阶段停滞：${name}，「${stage === 'quoted' ? '比价' : '决策'}」阶段已停滞 ${Math.floor(days)} 天（阈值 ${threshold} 天），需要推进或降级`,
      score: 60 + Math.min(Math.floor(days - threshold), 20)
    })
    created++
  }
  return { created }
}

// ─── §1.7a 设备级周期提醒（按交付日期起算，一次性）───────────────────────────
export function runDeviceReminderScan(now = Date.now()): { created: number } {
  let created = 0
  for (const d of wonDeals()) {
    if (!d.deliveredAt) continue
    for (const rule of DEVICE_RULES) {
      if (now < d.deliveredAt + rule.days * DAY_MS) continue
      if (salesDbService.hasAnyTaskBySource(rule.trigger, d.id)) continue // 一次性
      const name = d.account_name || '未知'
      createCard({
        trigger: rule.trigger, sourceId: d.id,
        sessionId: d.session_id || `deal:${d.id}`, displayName: name,
        title: `设备保养：${name} 的${d.main_model || d.product || '设备'}交付满 ${rule.days} 天——${rule.label}`,
        score: 40
      })
      created++
    }
  }
  return { created }
}

// ─── §1.7b R12 经销商拿货周期预警（简单版：60 天未拿货 → 提醒）───────────────
export function runR12DealerReorderScan(now = Date.now()): { created: number } {
  let created = 0
  const dealers = crmDbService.all("SELECT id, name FROM customer WHERE type = 'dealer' AND deleted = 0")
  for (const cu of dealers) {
    const cid = Number(cu.id)
    // 最近拿货 = max（成交商机时间，发货物流时间）（该 customer 挂接的 account 范围）
    const won = crmDbService.all(
      `SELECT MAX(o.updated_at) AS t FROM opportunity o JOIN account a ON a.id = o.account_id
       WHERE a.customer_id = ? AND o.status = 'won'`, [cid]
    )[0]
    const shipped = crmDbService.all(
      `SELECT MAX(l.created_at) AS t FROM logistics l
       LEFT JOIN contract c ON c.id = l.contract_id
       JOIN account a ON a.id = COALESCE(c.account_id, l.account_id)
       WHERE a.customer_id = ?`, [cid]
    )[0]
    const lastTs = Math.max(Number(won?.t || 0), Number(shipped?.t || 0))
    if (!lastTs) continue // 从未拿货 = 无基线，不提醒
    const days = (now - lastTs) / DAY_MS
    if (days < R12_REORDER_DAYS) continue
    if (salesDbService.pendingTaskBySource('rule_r12_dealer_reorder', cid)) continue
    const acc = crmDbService.all(
      "SELECT session_id FROM account WHERE customer_id = ? AND session_id IS NOT NULL AND session_id != '' LIMIT 1", [cid]
    )[0]
    const name = String(cu.name || '未知')
    createCard({
      trigger: 'rule_r12_dealer_reorder', sourceId: cid,
      sessionId: String(acc?.session_id || '') || `cust:${cid}`, displayName: name,
      title: `经销商回购：${name} 已 ${Math.floor(days)} 天未拿货（阈值 ${R12_REORDER_DAYS} 天），主动联系补货意向`,
      score: 60 + Math.min(Math.floor(days - R12_REORDER_DAYS), 20)
    })
    created++
  }
  return { created }
}

// ─── 统一入口（挂 runFullScan，与 scanLeadSla 并列）──────────────────────────
export interface AftersalesScanResult { r9: number; r9Escalated: number; r10: number; r11: number; device: number; r12: number }

export function runAftersalesScan(now = Date.now()): AftersalesScanResult {
  const r: AftersalesScanResult = { r9: 0, r9Escalated: 0, r10: 0, r11: 0, device: 0, r12: 0 }
  try { const x = runR9DealerRestockScan(now); r.r9 = x.warned; r.r9Escalated = x.escalated } catch (e) { console.warn('[售后] R9 扫描失败:', e) }
  try { r.r10 = runR10RevisitScan(now).created } catch (e) { console.warn('[售后] R10 扫描失败:', e) }
  try { r.r11 = runR11StallScan(now).created } catch (e) { console.warn('[售后] R11 扫描失败:', e) }
  try { r.device = runDeviceReminderScan(now).created } catch (e) { console.warn('[售后] 设备提醒扫描失败:', e) }
  try { r.r12 = runR12DealerReorderScan(now).created } catch (e) { console.warn('[售后] R12 扫描失败:', e) }
  const total = r.r9 + r.r10 + r.r11 + r.device + r.r12
  if (total > 0 || r.r9Escalated > 0) console.log(`[售后] 规则扫描：R9 预警 ${r.r9}/升级 ${r.r9Escalated}，R10 回访 ${r.r10}，R11 停滞 ${r.r11}，设备 ${r.device}，R12 回购 ${r.r12}`)
  return r
}
