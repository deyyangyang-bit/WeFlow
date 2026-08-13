/**
 * crmAutoConfirmService.ts
 * 确认中心自动确认引擎：只判定「该不该自动、多确信、为什么」，执行复用 crmDbService / crmParseRules。
 * 纯逻辑、无 electron import，可直接被 tsx 脚本单测。
 *
 * 触发点（由调用方装配）：① scanAll 完成钩子 ② 独立 60s 调度器 ③ 前端按钮 crm:autoConfirm:run。
 * 铁律：执行入口一律 enqueueSalesTask（最外层），引擎内部绝不 enqueue（防死锁）。
 * 硬前提：自动确认归属必须挂到 active contract，否则留人工（「钱不消失」强化）。
 * 引擎绝不创建实体（不 ensureAccount / 不建合同），只解析到已存在 account，回滚只需改状态。
 */
import { crmDbService, type CrmRow } from './crmDbService'
import { extractInvoiceAmountFromName, splitAliasHints } from './crmParseRules'
import { salesLog } from './salesLogger'

export type AutoEntity = 'allocation' | 'payment' | 'logistics' | 'invoice'

export interface AutoDecision {
  entity: AutoEntity
  id: number
  decision: 'auto_confirm' | 'needs_review'
  confidence: number // 0..1，needs_review 可为 0
  reason: string // 中文可读
  action?: string // 机器动作标识（confirmAllocation/approvePayment/linkLogistics/linkInvoice）
  payload?: Record<string, unknown>
}

export interface AutoRunOptions {
  threshold?: number // 置信阈值，默认取 config 0.8
  includeDocgen?: boolean // 发票自动开单子开关，默认取 config
}

export interface AutoRunResult {
  auto: number
  reviewed: number
  byEntity: Record<AutoEntity, { auto: number; reviewed: number }>
}

// ─── 可注入依赖（保持引擎无 electron import）────────────────────────────────
let configRef: { get: (k: string) => unknown } | null = null
let docgenRunner: ((type: string, recordId: number) => Promise<{ ok: boolean; path?: string; reason?: string }>) | null = null

/** 注入 ConfigService（同 crmParseService.setCrmParseConfig 模式） */
export function setAutoConfirmConfig(cfg: { get: (k: string) => unknown } | null): void {
  configRef = cfg
}
/** 注入发票开单回调（generateDoc），引擎不直接 import electron 依赖的 docgen */
export function setDocgenRunner(fn: ((type: string, recordId: number) => Promise<{ ok: boolean; path?: string; reason?: string }>) | null): void {
  docgenRunner = fn
}

// ─── 配置读取 ─────────────────────────────────────────────────────────────────
function thresholdOf(opts?: AutoRunOptions): number {
  if (opts && opts.threshold != null) return opts.threshold
  const t = Number(configRef?.get('crmAutoConfirmThreshold') ?? 0.8)
  return Number.isFinite(t) && t > 0 && t <= 1 ? t : 0.8
}
function docgenOf(opts?: AutoRunOptions): boolean {
  if (opts && opts.includeDocgen != null) return opts.includeDocgen
  return Boolean(configRef?.get('crmAutoConfirmInvoiceDocgen'))
}
function isEnabled(): boolean {
  return Boolean(configRef?.get('crmAutoConfirmEnabled') ?? true)
}

function decision(entity: AutoEntity, row: CrmRow, decisionKind: 'auto_confirm' | 'needs_review', confidence: number, reason: string): AutoDecision {
  return { entity, id: Number(row.id), decision: decisionKind, confidence, reason }
}

// ─── 判定（纯函数）────────────────────────────────────────────────────────────
/** 归属判定 A1-A8：父到款待审/无线索/金额守卫 → 客户唯一命中 + 可挂合同 → 自动 */
export function evaluateAllocation(a: CrmRow, opts?: AutoRunOptions): AutoDecision {
  const parent = a.payment_record_id ? crmDbService.getById('payment_record', Number(a.payment_record_id)) : null
  if (parent && Number(parent.needs_review || 0) === 1) {
    return decision('allocation', a, 'needs_review', 0, '父到款待人工审核，先审到款')
  }
  const hint = String(a.customer_hint || '').trim()
  if (!hint) return decision('allocation', a, 'needs_review', 0, '无客户线索')
  const hintAmt = Number(a.amount_hint ?? 0)
  if (hintAmt <= 0) return decision('allocation', a, 'needs_review', 0, '金额缺失')
  // 金额守卫：已确认归属 + 本项不得超过父到款净额
  if (parent) {
    const net = Number(parent.amount_net ?? 0)
    const confirmed = crmDbService.all(
      "SELECT COALESCE(SUM(credited_amount),0) AS s FROM allocation WHERE payment_record_id = ? AND status = 'confirmed' AND id != ?",
      [Number(parent.id), Number(a.id)]
    )
    if (Number(confirmed[0]?.s ?? 0) + hintAmt > net + 0.01) {
      return decision('allocation', a, 'needs_review', 0, `金额不符（已记+本项将超到账 ¥${net}）`)
    }
  }
  const cands = crmDbService.matchAccountCandidates(hint)
  if (cands.length === 0) return decision('allocation', a, 'needs_review', 0, '客户未识别')
  if (cands.length > 1) return decision('allocation', a, 'needs_review', 0, '多候选客户需人工消歧')
  const acc = cands[0]
  const contract = crmDbService.activeContractForAccount(Number(acc.id))
  if (!contract) return decision('allocation', a, 'needs_review', 0, `客户「${acc.name}」无可挂合同`)
  const exact = acc.match_tier === 'exact'
  return {
    ...decision('allocation', a, 'auto_confirm', exact ? 0.95 : 0.85, `客户${exact ? '精确' : '近似唯一'}命中「${acc.name}」+ 可挂合同`),
    action: 'confirmAllocation',
    payload: {
      account_id: Number(acc.id), contract_id: Number(contract.id),
      sales_name: String(a.sales_hint || a.sales_name || ''),
      auto_confirmed_by: 'auto'
    }
  }
}

/** 到款判定 P1-P5：财付通永不自动；截图仅精确命中；bank_text 精确/近似唯一 → 自动（只放行不记账） */
export function evaluatePayment(p: CrmRow, opts?: AutoRunOptions): AutoDecision {
  if (String(p.pay_channel || '') === 'wecom_tenpay') return decision('payment', p, 'needs_review', 0, '财付通扫码到款走认领')
  const source = String(p.source || '')
  const amt = Number(p.amount_net ?? 0)
  if (amt <= 0) return decision('payment', p, 'needs_review', 0, '金额缺失')
  const payer = String(p.payer || '').trim()
  if (!payer) return decision('payment', p, 'needs_review', 0, '无付款方')
  const cands = crmDbService.matchAccountCandidates(payer)
  if (cands.length === 0) return decision('payment', p, 'needs_review', 0, '客户未识别')
  if (cands.length > 1) return decision('payment', p, 'needs_review', 0, '多候选客户需人工消歧')
  const acc = cands[0]
  const exact = acc.match_tier === 'exact'
  if (source === 'screenshot') {
    if (!exact) return decision('payment', p, 'needs_review', 0, '截图 OCR 仅精确命中可自动')
    return { ...decision('payment', p, 'auto_confirm', 0.85, `截图OCR+客户精确命中「${acc.name}」`), action: 'approvePayment', payload: { autoBy: 'auto' } }
  }
  return {
    ...decision('payment', p, 'auto_confirm', exact ? 0.95 : 0.85, `银行文本+客户${exact ? '精确' : '近似唯一'}命中「${acc.name}」`),
    action: 'approvePayment', payload: { autoBy: 'auto' }
  }
}

/** 物流判定 L1-L5：唯一候选 → city 消歧 → receiver 词元消歧；兜底/多候选留人工 */
export function evaluateLogistics(l: CrmRow, opts?: AutoRunOptions): AutoDecision {
  const receiver = String(l.receiver || '').trim()
  if (!receiver) return decision('logistics', l, 'needs_review', 0, '无收件人')
  const city = String(l.city || '').trim()
  const cands = crmDbService.logisticsCandidates(receiver, city)
  if (cands.length === 0) return decision('logistics', l, 'needs_review', 0, '无候选合同')
  if (cands.length === 1) {
    if (String(cands[0].cand_tier || '') === 'fallback') {
      return decision('logistics', l, 'needs_review', 0, '仅兜底候选，无收件人/城市证据')
    }
    return { ...decision('logistics', l, 'auto_confirm', 0.95, `唯一候选合同「${cands[0].name}」`), action: 'linkLogistics', payload: { contract_id: Number(cands[0].id), autoBy: 'auto' } }
  }
  // 城市消歧
  const byCity = city ? cands.filter((c) => String(c.account_city || '') === city) : []
  if (byCity.length === 1) {
    return { ...decision('logistics', l, 'auto_confirm', 0.88, `城市「${city}」消歧唯一 → 合同「${byCity[0].name}」`), action: 'linkLogistics', payload: { contract_id: Number(byCity[0].id), autoBy: 'auto' } }
  }
  // receiver 词元命中 account 名消歧
  const tokens = [receiver, ...splitAliasHints(receiver)]
  const byTok = byCity.length > 1 ? byCity : cands
  const hit = byTok.filter((c) => tokens.some((t) => t && String(c.account_name || '').includes(t)))
  if (hit.length === 1) {
    return { ...decision('logistics', l, 'auto_confirm', 0.82, `收件人词元命中「${hit[0].account_name || hit[0].name}」唯一`), action: 'linkLogistics', payload: { contract_id: Number(hit[0].id), autoBy: 'auto' } }
  }
  return decision('logistics', l, 'needs_review', 0, '多候选/消歧失败，需人工确认')
}

/** 发票判定 I1-I4：买方精确/近似唯一 + 金额已填 + 可挂合同 → 自动；金额缺失/未识别/多候选留人工 */
export function evaluateInvoice(inv: CrmRow, opts?: AutoRunOptions): AutoDecision {
  const buyer = String(inv.buyer || '').trim()
  if (!buyer) return decision('invoice', inv, 'needs_review', 0, '无买方')
  const amt = Number(inv.amount ?? 0)
  if (amt <= 0) {
    const fname = inv.attachment_path ? String(inv.attachment_path).split('/').pop() : ''
    const extracted = fname ? extractInvoiceAmountFromName(fname) : null
    return decision('invoice', inv, 'needs_review', 0, extracted ? `金额缺失（文件名可补 ¥${extracted}，待人工确认）` : '金额缺失待人工填')
  }
  const cands = crmDbService.matchAccountCandidates(buyer)
  if (cands.length === 0) return decision('invoice', inv, 'needs_review', 0, '买方未识别')
  if (cands.length > 1) return decision('invoice', inv, 'needs_review', 0, '多候选买方需人工消歧')
  const acc = cands[0]
  const contract = crmDbService.activeContractForAccount(Number(acc.id))
  if (!contract) return decision('invoice', inv, 'needs_review', 0, `买方「${acc.name}」无可挂合同`)
  const exact = acc.match_tier === 'exact'
  return {
    ...decision('invoice', inv, 'auto_confirm', exact ? 0.95 : 0.85, `买方${exact ? '精确' : '近似唯一'}命中「${acc.name}」+ 可挂合同`),
    action: 'linkInvoice',
    payload: { account_id: Number(acc.id), contract_id: Number(contract.id), auto_updated_by: 'auto' }
  }
}

/** 聚合四队列 → AutoDecision[]，统一按阈值拦截低置信 */
export function evaluateQueues(queues: { allocations: CrmRow[]; logistics: CrmRow[]; payments: CrmRow[]; invoices: CrmRow[] }, opts?: AutoRunOptions): AutoDecision[] {
  const threshold = thresholdOf(opts)
  const out: AutoDecision[] = []
  const push = (d: AutoDecision): void => {
    if (d.decision === 'auto_confirm' && d.confidence < threshold) {
      out.push({ ...d, decision: 'needs_review', reason: `置信 ${d.confidence} 低于阈值 ${threshold}` })
    } else {
      out.push(d)
    }
  }
  for (const a of queues.allocations) push(evaluateAllocation(a, opts))
  for (const p of queues.payments) push(evaluatePayment(p, opts))
  for (const l of queues.logistics) push(evaluateLogistics(l, opts))
  for (const i of queues.invoices) push(evaluateInvoice(i, opts))
  return out
}

// ─── 执行（复用 crmDbService，写审计）────────────────────────────────────────
/** 逐条执行自动确认动作；返回是否成功。needs_review 不执行。 */
export function applyDecision(d: AutoDecision, opts?: AutoRunOptions): { ok: boolean; reason?: string } {
  if (d.decision !== 'auto_confirm') return { ok: false, reason: 'needs_review 不执行' }
  const p = (d.payload || {}) as Record<string, unknown>
  try {
    switch (d.action) {
      case 'confirmAllocation': {
        const allocPatch: { account_id?: number; contract_id?: number; sales_name?: string } = {
          account_id: p.account_id as number | undefined,
          contract_id: p.contract_id as number | undefined,
          sales_name: p.sales_name as string | undefined
        }
        return crmDbService.confirmAllocation(d.id, allocPatch, { autoBy: 'auto', reason: d.reason })
      }
      case 'approvePayment':
        return crmDbService.approvePayment(d.id, { autoBy: 'auto' })
      case 'linkLogistics':
        return crmDbService.linkLogistics(d.id, Number(p.contract_id), { autoBy: 'auto' })
      case 'linkInvoice': {
        crmDbService.update('invoice', d.id, { account_id: p.account_id, contract_id: p.contract_id, auto_updated_by: 'auto' })
        if (docgenOf(opts) && docgenRunner) {
          const c = crmDbService.getById('contract', Number(p.contract_id))
          const cf = (() => { try { return JSON.parse(String(c?.custom_fields || '{}')) } catch { return {} } })() as Record<string, unknown>
          if (cf.tax_no) {
            void docgenRunner('invoice-info', d.id)?.then((r) => {
              if (r?.ok) salesLog('INFO', `[AutoConfirm] 发票#${d.id} 自动生成开票信息单：${r.path || ''}`)
            })
          }
        }
        return { ok: true }
      }
      default:
        return { ok: false, reason: `未知 action ${d.action}` }
    }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

function emptyByEntity(): AutoRunResult['byEntity'] {
  return {
    allocation: { auto: 0, reviewed: 0 }, payment: { auto: 0, reviewed: 0 },
    logistics: { auto: 0, reviewed: 0 }, invoice: { auto: 0, reviewed: 0 }
  }
}

/**
 * 编排：取四队列 → 判定 → 逐条执行 → 汇总。幂等（confirmAllocation 的 pending 守卫天然去重）。
 * 同步执行（sql.js 本地库），调用方负责 enqueue 与批前快照。
 */
export function runAutoConfirm(opts?: AutoRunOptions): AutoRunResult {
  const queues = crmDbService.reviewQueues()
  const decisions = evaluateQueues(queues, opts)
  const result: AutoRunResult = { auto: 0, reviewed: 0, byEntity: emptyByEntity() }
  for (const d of decisions) {
    if (d.decision === 'auto_confirm') {
      const r = applyDecision(d, opts)
      if (r.ok) {
        result.auto += 1
        result.byEntity[d.entity].auto += 1
        crmDbService.logAutoConfirm(d.entity, d.id, 'auto_confirm', d.confidence, d.reason, d.action || '')
        salesLog('INFO', `[AutoConfirm] ${d.entity}#${d.id} 自动${d.action}：${d.reason}`)
      } else {
        result.reviewed += 1
        result.byEntity[d.entity].reviewed += 1
        salesLog('WARN', `[AutoConfirm] ${d.entity}#${d.id} 执行失败: ${r.reason}`)
      }
    } else {
      result.reviewed += 1
      result.byEntity[d.entity].reviewed += 1
    }
  }
  return result
}

// ─── 调度 / 触发（调用点必须 enqueueSalesTask，引擎内部绝不 enqueue）────────
let schedulerTimer: NodeJS.Timeout | null = null
let lastRunAt = 0
const RUN_COOLDOWN_MS = 30_000

/** 独立 60s 兜底调度器；30s 冷却防重；跳过时输出一条 INFO 便于排查 */
export function startAutoConfirmScheduler(): void {
  if (schedulerTimer) return
  schedulerTimer = setInterval(() => {
    if (!isEnabled()) return
    const now = Date.now()
    if (now - lastRunAt < RUN_COOLDOWN_MS) return
    lastRunAt = now
    try {
      crmDbService.exportSnapshot('auto')
      runAutoConfirm()
    } catch (e) {
      salesLog('WARN', `[AutoConfirm] scheduler error: ${e instanceof Error ? e.message : String(e)}`)
    }
  }, 60_000)
}

/** 手动/钩子触发入口：总开关关闭时跳过；批前快照 + 执行（调用方负责 enqueue） */
export function runAutoConfirmNow(opts?: AutoRunOptions): AutoRunResult {
  lastRunAt = Date.now()
  if (!isEnabled()) return { auto: 0, reviewed: 0, byEntity: emptyByEntity() }
  crmDbService.exportSnapshot('auto')
  return runAutoConfirm(opts)
}

/** 增量撤销（仅限自动处理的条目） */
export function undoAutoConfirm(entity: AutoEntity, id: number): { ok: boolean; reason?: string } {
  switch (entity) {
    case 'allocation': return crmDbService.undoAllocation(id)
    case 'payment': return crmDbService.undoPayment(id)
    case 'logistics': return crmDbService.undoLogistics(id)
    case 'invoice': return crmDbService.undoInvoice(id)
    default: return { ok: false, reason: `未知实体 ${entity}` }
  }
}
