/**
 * crmPaymentPromiseService.ts —— 付款承诺登记 + 到期扫描（告警 D「承诺打款日过期」，type='payment_overdue'）
 *
 * 数据宪法 §3 payment_promise（2026-09-05 本刀登记后建表）：客户明确承诺付款时间
 * （「下周打款」「月底付款」），日子过了 payment_record 没有对应到款 → 走链提醒。
 * 沿用告警 A 全部既有机制（设计-AI见解重定位 §4.1 四道闸），不发明新轮子：
 *   1. 识别：crmParseService 私聊扫描挂窄口径候选正则（付款动词+时间词同句）→ 命中才调 LLM
 *      解析承诺日期（temperature 0.2，仿 crmSla2LlmScanService 依赖注入模式）；
 *      置信 < 0.6 或日期解不出 = 不登记（宁缺毋滥）；我方消息 isSend=1 不识别；
 *   2. 证据锚点强制（宪法 §1.10）：promise_text = 客户原话快照 ≤200 字 + evidence_key = messageKey，
 *      验不出原话（key/原话缺任一）整条丢弃，不登记；
 *   3. 脱敏前置（宪法 §2.6）：送 LLM 的文本在 buildPaymentPromiseUserPrompt 内强制过 maskPrivateText；
 *   4. 到期扫描：每日一次（跟随周复盘定时器 20:00-20:30 时段），status='pending' 且 due_date 已过
 *      （due_date < 今日 0 点）→ 查该账户在承诺登记之后有无到款：有 → 置 kept；无 → 置 overdue +
 *      alertService.createAlert({type:'payment_overdue'}) 四道闸（证据强制/72h 幂等/推送门/落记录）。
 *      ALERT_PUSH_APPROVED.payment_overdue 默认 false——评测 ≥85% 前只置状态不推送（门关零副作用）。
 *   5. 明确不做：不做推送文案 UI、不改屏 5 右、不动 payment_record 任何写路径（只读比对）。
 *
 * 写点纪律：payment_promise 的全部写入收敛在本模块（登记/状态流转），并同步 audit_event；
 * 到款比对只读（payment_record/allocation 零写入）。幂等：UNIQUE(account_id, evidence_key)。
 */
import { crmDbService, type CrmRow } from './crmDbService'
import { maskPrivateText } from './crmSla2Service'
import { getAlertService, type AlertService } from './alertService'
import { salesLog } from './salesLogger'

/** 最低登记置信度：低于此值不登记（宁缺毋滥，与 SLA2 LLM 扫描同阈值口径） */
export const PAYMENT_PROMISE_MIN_CONFIDENCE = 0.6
/** due_date 合理上限：承诺日距消息日超过 400 天视为解析异常，不登记 */
export const PAYMENT_PROMISE_MAX_HORIZON_DAYS = 400
/** 扫描幂等标记前缀（scan_state，每日一次：paymentPromiseScan:<YYYYMMDD>） */
export const PAYMENT_SCAN_STATE_PREFIX = 'paymentPromiseScan:'

// ─── 窄口径候选正则（打款/付款/转账/汇款 + 时间词同句；只筛「值得调 LLM」的消息）─────
const PAY_PROMISE_PAY_RE = /打款|付款|转账|汇款|打钱|付钱|结款|付(?:定金|尾款|全款)/
const PAY_PROMISE_TIME_RE = /明天|后天|大后天|今天|今晚|今明|上午|下午|中午|晚上|周末|下周|下星期|下礼拜|本周|这周|月底|月末|月内|年底|年底前|年初|[周星期礼拜][一二三四五六日天末]|\d{1,2}月\d{1,2}[日号]|[一二三四五六七八九十]{1,3}[日号]|\d{1,2}[日号]前?|\d+\s*(?:天|个?[周月])后|过完(?:年|节)|发(?:了)?(?:工资|年终奖)(?:以后|之后|后)?/

/**
 * 付款承诺候选（窄口径）：只看客户消息（isSend=0，parseRiskSignal/parseLossSignal 同型口径），
 * [表情] 清洗后按句切分，同一句内同时出现付款动词 + 时间词才算候选（同句 = 同一个自然句）。
 * 候选 ≠ 承诺——是否真承诺由 LLM 判定；候选只负责省 LLM 调用。
 */
export function isPaymentPromiseCandidate(text: string, isSend: number): boolean {
  if (isSend !== 0) return false // 我方消息不识别
  const clean = String(text || '').replace(/\[[^\]]{1,8}\]/g, ' ').trim()
  if (clean.length < 4) return false
  const sentences = clean.split(/[。！？!?；;\n\r]+/)
  return sentences.some((s) => PAY_PROMISE_PAY_RE.test(s) && PAY_PROMISE_TIME_RE.test(s))
}

// ─── LLM 解析（temperature 0.2；结构化输出 → 本地确定性日期推算）──────────────────
export type PromiseTimeKind = 'tomorrow' | 'days_later' | 'weekday' | 'next_week' | 'month_end' | 'specific_date' | 'none'
export const PROMISE_TIME_KINDS: readonly PromiseTimeKind[] = ['tomorrow', 'days_later', 'weekday', 'next_week', 'month_end', 'specific_date', 'none']

export interface ParsedPromise {
  isPromise: boolean
  confidence: number
  timeKind: PromiseTimeKind
  /** days_later = 天数 N；weekday/next_week = 星期几（1=周一 … 7=周日）；其余 0 */
  weekday: number
  /** specific_date 的 YYYY-MM-DD（LLM 按消息日期推算；本地严格解析校验） */
  dateText: string
}

export const PAYMENT_PROMISE_SYSTEM = [
  '你是付款承诺解析器。判断客户消息是否明确承诺了付款/打款/转账/汇款的时间。',
  '只输出一个 JSON 对象，不要输出其他任何文字：',
  '{"is_promise":true或false,"confidence":0到1的小数,"time_kind":"tomorrow|days_later|weekday|next_week|month_end|specific_date|none","weekday":数字,"date":"YYYY-MM-DD或空"}',
  '判定规则：',
  '- 只有客户明确表达「将要付款/打款/转账/汇款」且给出具体时间才算承诺（is_promise=true）；询问、讨论、抱怨、转述历史一律 is_promise=false；',
  '- 你拿不准 → is_promise=false 且 confidence≤0.5（宁缺毋滥）；',
  '- time_kind 取值：明天=tomorrow；后天/N天后=days_later（weekday 字段填天数 N）；周X/星期X/礼拜X=weekday（weekday 填 1-7，周一=1）；下周X/下星期X/下礼拜X=next_week（weekday 填 1-7）；月底/月末=month_end；具体日期（X月X日、X号、YYYY-MM-DD）=specific_date（date 填按消息日期推算的 YYYY-MM-DD）；没有明确时间=none；',
  '- 消息中出现的手机号/微信号已脱敏为 ***，不要试图还原，也不要引用完整号码。'
].join('\n')

/** 送 LLM 的最后一道闸（宪法 §2.6）：正文强制过 maskPrivateText 后截 200 字，随消息日期一起出 */
export function buildPaymentPromiseUserPrompt(text: string, messageMs: number): string {
  const masked = maskPrivateText(String(text || '')).replace(/\s+/g, ' ').trim().slice(0, 200)
  const when = new Date(Number(messageMs) > 0 ? Number(messageMs) : Date.now())
  const p = (n: number) => String(n).padStart(2, '0')
  const wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][when.getDay()]
  return `消息日期：${when.getFullYear()}-${p(when.getMonth() + 1)}-${p(when.getDate())}（${wd}）\n客户消息：${masked}\n\n请按系统规则输出 JSON。`
}

/**
 * 解析 LLM 响应：提取首个 JSON；JSON 不可解析 / time_kind 非法 → null（本轮不计，不代表「不是承诺」，
 * 只是不登记——宁缺毋滥）；confidence 钳到 0-1。
 */
export function parsePaymentPromiseResponse(raw: string): ParsedPromise | null {
  const m = String(raw || '').match(/\{[\s\S]*\}/)
  if (!m) return null
  let j: any
  try { j = JSON.parse(m[0]) } catch { return null }
  const kindRaw = String(j?.time_kind ?? j?.timeKind ?? '').trim()
  if (!PROMISE_TIME_KINDS.includes(kindRaw as PromiseTimeKind)) return null
  let confidence = Number(j?.confidence)
  if (!Number.isFinite(confidence)) confidence = 0
  confidence = Math.max(0, Math.min(1, confidence))
  return {
    isPromise: j?.is_promise === true || j?.isPromise === true,
    confidence,
    timeKind: kindRaw as PromiseTimeKind,
    weekday: Math.max(0, Math.floor(Number(j?.weekday) || 0)),
    dateText: String(j?.date ?? j?.date_text ?? '')
  }
}

/** 当日 0 点（本地时区）毫秒；due_date 统一存当日 0 点，「已过」= due_date < 今日 0 点 */
function dayStart(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** 本地时区日期串（YYYY-MM-DD）。不用 toISOString——UTC 化会把本地 0 点显示成前一天 */
function dueDateStr(ms: number): string {
  const d = new Date(Number(ms) || 0)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * 结构化承诺 → 承诺日（当日 0 点毫秒）。日期推算全部本地确定性完成（不信任 LLM 算术）；
 * 解不出 / 落在过去（≤ 消息当日 0 点）/ 超 400 天视野 → 0 = 不登记（宁缺毋滥）。
 * - tomorrow：消息次日 0 点
 * - days_later：weekday=N 天后（1-60），消息日 + N 天
 * - weekday：下一个周X（严格晚于今天，1-7 天内）
 * - next_week：下个自然周的周X（下周一 + (X-1) 天）
 * - month_end：消息日所在月最后一天（当天已是月末 → 解不出）
 * - specific_date：dateText 严格 YYYY-MM-DD 校验（含月份/天数合法性回验）
 */
export function resolveDueDate(p: ParsedPromise | null, baseMs: number): number {
  if (!p || !p.isPromise) return 0
  const base = Number(baseMs) || 0
  if (base <= 0) return 0
  const baseDay = dayStart(base)
  const maxDue = baseDay + PAYMENT_PROMISE_MAX_HORIZON_DAYS * 86400_000
  const inRange = (due: number): number => (due > baseDay && due <= maxDue ? due : 0)
  switch (p.timeKind) {
    case 'tomorrow':
      return inRange(baseDay + 86400_000)
    case 'days_later': {
      const n = Math.floor(Number(p.weekday) || 0)
      if (n < 1 || n > 60) return 0
      return inRange(baseDay + n * 86400_000)
    }
    case 'weekday': {
      const wd = Math.floor(Number(p.weekday) || 0)
      if (wd < 1 || wd > 7) return 0
      for (let i = 1; i <= 7; i++) {
        const d = new Date(baseDay + i * 86400_000)
        const jsWd = d.getDay() === 0 ? 7 : d.getDay()
        if (jsWd === wd) return inRange(baseDay + i * 86400_000)
      }
      return 0
    }
    case 'next_week': {
      const wd = Math.floor(Number(p.weekday) || 0)
      if (wd < 1 || wd > 7) return 0
      const baseJsWd = new Date(baseDay).getDay()
      const baseWd = baseJsWd === 0 ? 7 : baseJsWd
      const daysToNextMonday = ((8 - baseWd) % 7) || 7
      return inRange(baseDay + (daysToNextMonday + wd - 1) * 86400_000)
    }
    case 'month_end': {
      const d = new Date(baseDay)
      const due = new Date(d.getFullYear(), d.getMonth() + 1, 0).getTime()
      return inRange(due)
    }
    case 'specific_date': {
      const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(p.dateText || '').trim())
      if (!m) return 0
      const y = Number(m[1]), mo = Number(m[2]), da = Number(m[3])
      const d = new Date(y, mo - 1, da)
      if (d.getFullYear() !== y || d.getMonth() !== mo - 1 || d.getDate() !== da) return 0
      return inRange(d.getTime())
    }
    default:
      return 0
  }
}

// ─── 登记（写点单点：校验 + 幂等 + audit；验不出原话整条丢弃，宪法 §1.10）────────────
export interface PaymentPromiseRegisterInput {
  accountId: number
  /** 承诺原话所在会话（createAlert 四道闸证据回查契约必填） */
  sessionId: string
  leadId?: number
  /** 客户原话快照（入库截 200 字） */
  promiseText: string
  /** 承诺日（当日 0 点毫秒；resolveDueDate 产物） */
  dueDate: number
  /** 承诺依据的客户原话 messageKey（宪法 §1.10 锚点） */
  evidenceKey: string
  source?: string
  actor?: string
  now?: number
}

export type PaymentPromiseRegisterResult =
  | { ok: true; id: number; alreadyRegistered: boolean }
  | { ok: false; reason: 'bad_input' | 'no_evidence' | 'invalid_due_date' | 'no_account' }

/**
 * 登记 payment_promise（幂等键 UNIQUE(account_id, evidence_key)）。
 * 证据锚点强制：evidenceKey / promiseText / sessionId 缺任一 → 整条丢弃（no_evidence / bad_input）。
 * 同 (account_id, evidence_key) 已登记 → alreadyRegistered=true 零写入（消息重扫幂等）。
 */
export function registerPaymentPromise(input: PaymentPromiseRegisterInput): PaymentPromiseRegisterResult {
  const accountId = Number(input?.accountId || 0)
  const sessionId = String(input?.sessionId || '').trim()
  const promiseText = String(input?.promiseText || '').replace(/\s+/g, ' ').trim().slice(0, 200)
  const dueDate = Number(input?.dueDate || 0)
  const evidenceKey = String(input?.evidenceKey || '').trim()
  if (!Number.isInteger(accountId) || accountId <= 0) return { ok: false, reason: 'no_account' }
  if (!sessionId) return { ok: false, reason: 'bad_input' }
  if (!evidenceKey || !promiseText) return { ok: false, reason: 'no_evidence' } // 验不出原话整条丢弃
  if (dueDate <= 0) return { ok: false, reason: 'invalid_due_date' }

  const existing = crmDbService.all(
    'SELECT id FROM payment_promise WHERE account_id = ? AND evidence_key = ? AND deleted = 0 LIMIT 1',
    [accountId, evidenceKey]
  )
  if (existing.length) return { ok: true, id: Number(existing[0].id), alreadyRegistered: true }

  const now = Number(input?.now || 0) || Date.now()
  const actor = String(input?.actor || '').trim() || 'system:payment-promise'
  const id = crmDbService.runTx((tx) => {
    const newId = tx.run(
      `INSERT INTO payment_promise
         (account_id, session_id, lead_id, promise_text, due_date, evidence_key, status, source, updated_by, updated_at, version, deleted, created_at)
       VALUES (?,?,?,?,?,?,'pending',?,?,?,1,0,?)`,
      [accountId, sessionId, input?.leadId != null ? Number(input.leadId) : null,
       promiseText, dueDate, evidenceKey, String(input?.source || 'llm'), actor, now, now]
    )
    tx.run(
      'INSERT INTO audit_event (actor, action, entity_type, entity_id, detail, created_at) VALUES (?,?,?,?,?,?)',
      [actor, 'payment_promise_register', 'payment_promise', newId,
        JSON.stringify({ accountId, evidenceKey, dueDate, sessionId, source: String(input?.source || 'llm') }), now]
    )
    return newId
  })
  return { ok: true, id, alreadyRegistered: false }
}

// ─── 识别全链（候选 → LLM → 解析 → 日期推算 → 登记；依赖注入可测）────────────────
export interface PaymentCandidateInput {
  accountId: number
  sessionId: string
  displayName: string
  leadId?: number
  /** 承诺原话的 canonical messageKey（宪法 §1.10 锚点，复用上游已构造 key，不现场拼） */
  messageKey: string
  /** 客户原话（未脱敏，仅本机内使用；出机前在 buildPaymentPromiseUserPrompt 内强制脱敏） */
  text: string
  /** 消息时间毫秒（相对日期的推算基点） */
  messageMs: number
}

export interface PaymentPromiseLlmDeps {
  /** LLM 出口（主进程注入 simpleCompletion 包装；测试注入 mock） */
  llm(system: string, user: string): Promise<string>
  /** AI 是否已配置（未配置整链静默跳过，零调用零写入） */
  isConfigured?(): boolean
  now?(): number
  log?(level: string, message: string): void
}

export interface PaymentCandidateOutcome { registered: boolean; reason: string; promiseId?: number }

/**
 * 单条消息的付款承诺识别全链。crmParseService 私聊扫描在候选正则命中后调用（fire-in-scan）。
 * 任一环不达标零写入：AI 未配置 / 非候选 / LLM 异常 / JSON 解析失败 / is_promise=false /
 * 置信 <0.6 / 日期解不出 / 登记校验不过（含证据验不出整条丢弃）。
 */
export async function processPaymentCandidate(deps: PaymentPromiseLlmDeps, input: PaymentCandidateInput): Promise<PaymentCandidateOutcome> {
  const log = deps.log ?? ((level, message) => salesLog(level as 'INFO' | 'WARN', message))
  if (deps.isConfigured && !deps.isConfigured()) return { registered: false, reason: 'ai_not_configured' }
  if (!isPaymentPromiseCandidate(input?.text ?? '', 0)) return { registered: false, reason: 'not_candidate' }

  let raw = ''
  try {
    raw = await deps.llm(PAYMENT_PROMISE_SYSTEM, buildPaymentPromiseUserPrompt(input.text, input.messageMs))
  } catch (e) {
    log('WARN', `[PaymentPromise] LLM 调用失败 ${input.displayName || input.sessionId}: ${e}`)
    return { registered: false, reason: 'llm_error' }
  }
  const parsed = parsePaymentPromiseResponse(raw)
  if (!parsed) return { registered: false, reason: 'parse_failed' }
  if (!parsed.isPromise) return { registered: false, reason: 'not_promise' }
  if (parsed.confidence < PAYMENT_PROMISE_MIN_CONFIDENCE) return { registered: false, reason: 'low_confidence' }
  const dueDate = resolveDueDate(parsed, input.messageMs)
  if (!dueDate) return { registered: false, reason: 'due_unresolved' }

  const reg = registerPaymentPromise({
    accountId: input.accountId,
    sessionId: input.sessionId,
    leadId: input.leadId,
    promiseText: input.text,
    dueDate,
    evidenceKey: input.messageKey,
    source: 'llm'
  })
  if (!reg.ok) return { registered: false, reason: reg.reason }
  log('INFO', `[PaymentPromise] 登记承诺「${input.displayName || input.sessionId}」due=${dueDateStr(dueDate)} conf=${parsed.confidence}${reg.alreadyRegistered ? '（幂等命中）' : ''}`)
  return { registered: true, reason: reg.alreadyRegistered ? 'already_registered' : 'registered', promiseId: reg.id }
}

// ─── 到期扫描（每日一次：pending 且 due_date 已过 → 有款 kept / 无款 overdue+告警）──────
export interface PaymentPromiseScanDeps {
  /** 到款比对（注入可测；默认只读查询 allocation/account/alias_map 归因链） */
  hasPaymentArrived?(accountId: number, sinceMs: number): boolean
  /** 告警出口（注入可测；默认 getAlertService() 主进程单例——四道闸在 createAlert 内） */
  alertService?: AlertService | null
  now?(): number
  log?(level: string, message: string): void
}

export interface PaymentPromiseScanResult { scanned: number; kept: number; overdue: number; alerted: number; alertNotCreated: number; errors: number }

/** 到款比对（只读，payment_record/allocation 零写入——宪法铁律「不动 payment_record 写路径」）：
 *  归因链三路任一命中即算该账户有到款：① allocation 挂上该账户 ② 付款方名直配 account.name
 *  ③ 付款方命中该账户别名。时间口径：pay_time 或写入时刻 ≥ 承诺登记时刻。 */
export function defaultHasPaymentArrived(accountId: number, sinceMs: number): boolean {
  if (!Number.isInteger(accountId) || accountId <= 0) return false
  const hit = crmDbService.all(
    `SELECT pr.id FROM payment_record pr
     WHERE (pr.pay_time >= ? OR pr.created_at >= ?)
       AND (
         pr.id IN (SELECT payment_record_id FROM allocation WHERE account_id = ?)
         OR pr.payer IN (SELECT name FROM account WHERE id = ?)
         OR pr.payer IN (SELECT alias FROM alias_map WHERE account_id = ?)
       )
     LIMIT 1`,
    [sinceMs, sinceMs, accountId, accountId, accountId]
  )
  return hit.length > 0
}

/** 状态流转单点：pending → kept/overdue（带 status 守卫防并发双扫），同事务写 audit_event */
function markPromiseStatus(row: CrmRow, status: 'kept' | 'overdue', actor: string, nowMs: number): void {
  crmDbService.runTx((tx) => {
    tx.run(
      "UPDATE payment_promise SET status = ?, updated_by = ?, updated_at = ?, version = version + 1 WHERE id = ? AND status = 'pending' AND deleted = 0",
      [status, actor, nowMs, Number(row.id)]
    )
    tx.run(
      'INSERT INTO audit_event (actor, action, entity_type, entity_id, detail, created_at) VALUES (?,?,?,?,?,?)',
      [actor, 'payment_promise_mark', 'payment_promise', Number(row.id),
        JSON.stringify({ status, evidenceKey: String(row.evidence_key || ''), dueDate: Number(row.due_date || 0) }), nowMs]
    )
  })
}

/**
 * 扫一轮（幂等：状态流转带 pending 守卫，重跑自然零命中）。
 * 扫描范围 = deleted=0 AND status='pending' AND due_date < 今日 0 点（承诺日整天过去才算「已过」，
 * 月底当天全天仍属承诺期内——宁缺毋滥）。
 */
export function runPaymentPromiseScan(deps: PaymentPromiseScanDeps = {}): Promise<PaymentPromiseScanResult> {
  return (async (): Promise<PaymentPromiseScanResult> => {
    const now = deps.now ?? (() => Date.now())
    const log = deps.log ?? ((level, message) => salesLog(level as 'INFO' | 'WARN', message))
    const r: PaymentPromiseScanResult = { scanned: 0, kept: 0, overdue: 0, alerted: 0, alertNotCreated: 0, errors: 0 }
    const nowMs = now()
    const todayStartMs = dayStart(nowMs)

    const rows = crmDbService.all(
      "SELECT * FROM payment_promise WHERE deleted = 0 AND status = 'pending' AND due_date < ? ORDER BY id",
      [todayStartMs]
    )
    for (const row of rows) {
      r.scanned++
      const accountId = Number(row.account_id || 0)
      const sinceMs = Number(row.created_at || 0)
      try {
        const arrived = deps.hasPaymentArrived ? deps.hasPaymentArrived(accountId, sinceMs) : defaultHasPaymentArrived(accountId, sinceMs)
        if (arrived) {
          markPromiseStatus(row, 'kept', 'system:payment-scan', nowMs)
          r.kept++
          continue
        }
        // 到期无款：状态置 overdue（事实判定），告警走四道闸——推送门关时 createAlert 零副作用
        markPromiseStatus(row, 'overdue', 'system:payment-scan', nowMs)
        r.overdue++
        const dueStr = dueDateStr(Number(row.due_date || 0))
        const account = crmDbService.all('SELECT name FROM account WHERE id = ?', [accountId])[0]
        const displayName = String(account?.name || row.session_id || `客户#${accountId}`)
        const message = `【重要提醒】${displayName} 曾承诺 ${dueStr} 前打款，已到期未到账，建议跟进确认。客户原话：「${String(row.promise_text || '').slice(0, 200)}」`
        const alert = deps.alertService !== undefined ? deps.alertService : getAlertService()
        if (!alert) { r.alertNotCreated++; continue }
        const res = await alert.createAlert({
          type: 'payment_overdue',
          sessionId: String(row.session_id || ''),
          displayName,
          messageKey: String(row.evidence_key || ''),
          evidenceText: String(row.promise_text || '').slice(0, 200),
          message
        })
        if (res.created) r.alerted++
        else r.alertNotCreated++
      } catch (e) {
        r.errors++
        log('WARN', `[PaymentPromise] 扫描处理失败 promise#${row.id}: ${e}`)
      }
    }
    if (r.scanned > 0) log('INFO', `[PaymentPromise] 到期扫描：扫 ${r.scanned}，有款 kept=${r.kept}，无款 overdue=${r.overdue}（告警落记录 ${r.alerted} / 未出 ${r.alertNotCreated}）`)
    return r
  })()
}

// ─── 调度器（每日一次，跟随周复盘定时器 20:00-20:30 时段；scan_state 每日标记防重启重扫）──
export function isPaymentScanWindow(d: Date): boolean {
  return d.getHours() === 20 && d.getMinutes() < 30
}

export function paymentScanStateKeyFor(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${PAYMENT_SCAN_STATE_PREFIX}${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
}

let paymentScanTimer: ReturnType<typeof setInterval> | null = null

export function startPaymentPromiseScanScheduler(): void {
  if (paymentScanTimer) return
  const tick = (): void => {
    try {
      const d = new Date()
      if (!isPaymentScanWindow(d)) return
      const key = paymentScanStateKeyFor(d)
      if (crmDbService.getScanState(key) > 0) return // 今日已扫（重启不重复）
      void runPaymentPromiseScan()
        .then((r) => {
          crmDbService.setScanState(key, Date.now())
          if (r.scanned > 0) {
            console.log(`[CRM] 付款承诺到期扫描：扫 ${r.scanned}，kept=${r.kept} overdue=${r.overdue}（告警落记录 ${r.alerted} / 未出 ${r.alertNotCreated}）`)
          }
        })
        .catch((e) => console.warn('[CRM] 付款承诺到期扫描失败:', e))
    } catch (e) {
      console.warn('[CRM] 付款承诺到期扫描调度异常:', e)
    }
  }
  paymentScanTimer = setInterval(tick, 30 * 60 * 1000)
  if (paymentScanTimer.unref) paymentScanTimer.unref()
}
