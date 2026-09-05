/**
 * alert-payment-test.ts —— 告警 D「承诺打款日过期」（type='payment_overdue'）全套单测
 * 覆盖（任务书 6 项）：
 *  a. 宪法登记先于建表（静态断言：DATA-CONSTITUTION §3 登记行 + crmDbService DDL/白名单一致）
 *  b. payment_promise 建表 CHECK / UNIQUE(account_id, evidence_key) / 登记幂等
 *  c. 候选正则：命中（打款/付款/转账/汇款+时间词同句）/ 我方消息排除 / 噪音不误判
 *  d. LLM 解析链：解析失败不登记 / 异常不登记 / 低置信不登记 / 日期解不出不登记 / AI 未配置零调用 / 成功登记
 *  e. due_date 解析性（明天/下周X/周X/月底/具体日期/N天后/非法与超视野全解不出）
 *  f. 脱敏前置（宪法 §2.6）：送 LLM 文本强制过 maskPrivateText
 *  g. 证据锚点强制（宪法 §1.10）：验不出原话（key/原话缺）整条丢弃
 *  h. 到期扫描：到期无款→overdue+走链（门关零副作用）/ 门开落记录 / 有款→kept / 登记前到款不算 /
 *     未到期不动 / 重扫幂等 / 72h 幂等 / 证据验不出不出告警 / 别名与付款方名归因 / audit 留痕
 *  i. 接线静态检查：crmParseService 挂钩+isSend 门 / 推送门默认 false / main.ts 调度 / 写点单点 /
 *     payment_record 零写 / alert-eval 评测通道 / 调度窗口
 * 运行：npx tsx scripts/alert-payment-test.ts（/tmp 隔离库）
 */
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; console.log(`  ✅ ${name}`) } else { fail++; console.log(`  ❌ ${name} ${detail}`) }
}

const dbDir = mkdtempSync(join(tmpdir(), 'alert-payment-'))
import { crmDbService } from '../electron/services/crmDbService'
import {
  isPaymentPromiseCandidate, buildPaymentPromiseUserPrompt, parsePaymentPromiseResponse,
  resolveDueDate, registerPaymentPromise, processPaymentCandidate, runPaymentPromiseScan,
  isPaymentScanWindow, paymentScanStateKeyFor,
  PAYMENT_PROMISE_MIN_CONFIDENCE, type PaymentPromiseLlmDeps, type ParsedPromise
} from '../electron/services/crmPaymentPromiseService'
import { createAlertService, ALERT_PUSH_APPROVED, ALERT_DEDUP_MS, type AlertDeps } from '../electron/services/alertService'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// 时间基点：2026-09-01（周二）10:00 本地；「明天」承诺 = 2026-09-02 00:00
const T0 = new Date(2026, 8, 1, 10, 0, 0).getTime()
const dayMs = 86400_000
const dayStartOf = (y: number, m: number, d: number): number => new Date(y, m, d, 0, 0, 0, 0).getTime()

function promiseRow(evidenceKey: string) {
  return crmDbService.all('SELECT * FROM payment_promise WHERE evidence_key = ? AND deleted = 0', [evidenceKey])[0] || null
}
const promiseCount = (): number => crmDbService.all('SELECT COUNT(*) AS c FROM payment_promise').reduce((s, r) => s + Number(r.c), 0)

/** 测试用 LLM deps：mock 输出可配，记录调用 */
function makeLlmDeps(over: { raw?: string; error?: boolean; configured?: boolean; calls?: { system: string; user: string }[] } = {}): PaymentPromiseLlmDeps {
  const calls = over.calls ?? []
  return {
    llm: async (system: string, user: string) => {
      calls.push({ system, user })
      if (over.error) throw new Error('llm down')
      return over.raw ?? ''
    },
    isConfigured: () => over.configured ?? true,
    now: () => T0,
    log: () => {}
  }
}

/** 构造一个真实四道闸 createAlertService（deps 全 fake 可观测），供扫描走链测试 */
function makeRealAlertService(over: { evidenceFound?: boolean; hasRecent?: boolean } = {}) {
  const state = { records: 0, lastRecord: null as Record<string, unknown> | null, evidenceChecks: 0 }
  const deps: AlertDeps = {
    getEvidenceByKey: async () => {
      state.evidenceChecks++
      return { status: over.evidenceFound === false ? 'unavailable' : 'found' } as { status: string }
    },
    hasRecentAlert: () => over.hasRecent ?? false,
    addRecord: (input) => {
      state.records++
      state.lastRecord = input as unknown as Record<string, unknown>
      return { id: `r${state.records}` }
    },
    log: () => {}
  }
  return { svc: createAlertService(deps), state }
}

const CANDIDATE_INPUT = {
  accountId: 0, // 各节覆写
  sessionId: 'wxid_pay1',
  displayName: '承诺测试客户',
  messageKey: 'wxid_pay1:1780000000:11',
  text: '好的，明天就给你们打款',
  messageMs: T0
}

async function main(): Promise<void> {
  await crmDbService.initialize(dbDir)

  // ─── a. 宪法登记先于建表（静态断言）────────────────────────────────────────
  {
    const constitution = readFileSync(join(ROOT, 'docs/DATA-CONSTITUTION.md'), 'utf-8')
    const section3 = constitution.slice(constitution.indexOf('## 3.'))
    ok('a1 宪法 §3 已登记 payment_promise', section3.includes('payment_promise'))
    ok('a2 登记行含幂等键与状态枚举', section3.includes('UNIQUE(account_id, evidence_key)') && section3.includes("'pending','kept','overdue','cancelled'"))
    ok('a3 登记行含字段/写者/删除规则三要素', section3.includes('写入者') && section3.includes('删除规则') && section3.includes('软删') && section3.includes('due_date') && section3.includes('evidence_key'))
    ok('a4 登记行含双 actor 与告警出口', section3.includes('system:payment-promise') && section3.includes('system:payment-scan') && section3.includes('payment_overdue'))

    const dbSrc = readFileSync(join(ROOT, 'electron/services/crmDbService.ts'), 'utf-8')
    ok('a5 DDL 已建表且含通用五列', dbSrc.includes('CREATE TABLE IF NOT EXISTS payment_promise') &&
      /payment_promise[\s\S]*updated_by[\s\S]*version[\s\S]*deleted[\s\S]*created_at[\s\S]*\);/.test(dbSrc))
    ok('a6 DDL status CHECK 硬门禁 + UNIQUE(account_id, evidence_key)', dbSrc.includes("CHECK (status IN ('pending', 'kept', 'overdue', 'cancelled'))") &&
      dbSrc.includes('CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_promise_evidence ON payment_promise(account_id, evidence_key)'))
    ok('a7 ENTITIES 白名单已注册（漏注册静默失败前科）', dbSrc.includes("'payment_promise'"))
    ok('a8 DDL 注释指回宪法（登记先于建表）', /payment_promise（宪法 §3/.test(dbSrc))
  }

  // ─── b. 建表 + CHECK + 唯一约束 + 登记幂等 ─────────────────────────────────
  {
    const accId = crmDbService.ensureAccount('承诺测试客户')
    crmDbService.update('account', accId, { session_id: 'wxid_pay1' })
    CANDIDATE_INPUT.accountId = accId

    let checkRejected = 0
    try { crmDbService.all("INSERT INTO payment_promise (account_id, due_date, evidence_key, status, created_at) VALUES (1, 1, 'x', 'done', 1)") } catch { checkRejected++ }
    ok('b1 CHECK 拦截非法 status', checkRejected === 1)
    let uniqueRejected = 0
    try {
      for (let i = 0; i < 2; i++) {
        crmDbService.all("INSERT INTO payment_promise (account_id, due_date, evidence_key, status, created_at) VALUES (1, 1, 'dup_key', 'pending', 1)")
      }
    } catch { uniqueRejected++ }
    ok('b2 UNIQUE(account_id, evidence_key) 拦截重复', uniqueRejected === 1)
    crmDbService.all('DELETE FROM payment_promise WHERE evidence_key = ?', ['dup_key'])

    const reg1 = registerPaymentPromise({
      accountId: accId, sessionId: 'wxid_pay1', promiseText: '明天就给你们打款', dueDate: dayStartOf(2026, 8, 2),
      evidenceKey: 'wxid_pay1:1780000000:11', now: T0
    })
    ok('b3 首次登记成功 status=pending source=llm', reg1.ok && !reg1.alreadyRegistered && promiseRow('wxid_pay1:1780000000:11')?.status === 'pending')
    const reg2 = registerPaymentPromise({
      accountId: accId, sessionId: 'wxid_pay1', promiseText: '明天就给你们打款', dueDate: dayStartOf(2026, 8, 2),
      evidenceKey: 'wxid_pay1:1780000000:11', now: T0 + 1000
    })
    ok('b4 同 (account_id, evidence_key) 重放 → alreadyRegistered 零新行', reg2.ok && reg2.alreadyRegistered && promiseCount() === 1)
    ok('b5 登记写 audit_event', Number(crmDbService.all("SELECT COUNT(*) AS c FROM audit_event WHERE action = 'payment_promise_register'")[0].c) === 1)
    ok('b6 通用五列在位', (() => { const r = promiseRow('wxid_pay1:1780000000:11'); return !!r && r.source === 'llm' && Number(r.version) === 1 && Number(r.deleted) === 0 && Number(r.created_at) === T0 })())
  }

  // ─── c. 候选正则（打款/付款/转账/汇款 + 时间词同句）──────────────────────────
  {
    const hits = ['下周打款给你', '月底付款', '明天我转账给你', '周五之前汇款给你', '发了工资就打款', '好的，明天就给你们打款',
      '[微笑]明天打款给你', '这周末付款可以吗', '10月1号以后打款给你', '过完年就付款']
    hits.forEach((t, i) => ok(`c1.${i + 1} 命中候选：「${t}」`, isPaymentPromiseCandidate(t, 0)))
    ok('c2 我方消息（isSend=1）不识别', isPaymentPromiseCandidate('明天就打款', 1) === false)
    ok('c2\' 我方消息（isSend=2）不识别', isPaymentPromiseCandidate('明天就打款', 2) === false)
    const misses = ['多少钱啊这台', '明天见', '你们付款方式有哪些', '货到付款吗', '上次说好的打款呢', '今天天气不错',
      '你们银行转账要手续费吗', '打款', '好的好的']
    misses.forEach((t, i) => ok(`c3.${i + 1} 不误判：「${t}」`, isPaymentPromiseCandidate(t, 0) === false))
    ok('c4 <4 字跳过', isPaymentPromiseCandidate('打款', 0) === false)
  }

  // ─── d. LLM 解析链（解析失败不登记 / 低置信不登记 / 成功登记）────────────────
  {
    ok('d0 阈值 0.6', PAYMENT_PROMISE_MIN_CONFIDENCE === 0.6)
    // d1 解析失败（无 JSON）
    let calls: { system: string; user: string }[] = []
    let r = await processPaymentCandidate(makeLlmDeps({ raw: '抱歉我不知道', calls }), CANDIDATE_INPUT)
    ok('d1 JSON 解析失败 → parse_failed 零登记', !r.registered && r.reason === 'parse_failed' && promiseCount() === 1)
    // d2 LLM 异常
    r = await processPaymentCandidate(makeLlmDeps({ error: true }), CANDIDATE_INPUT)
    ok('d2 LLM 调用失败 → llm_error 零登记', !r.registered && r.reason === 'llm_error')
    // d3 模型自认不是承诺
    r = await processPaymentCandidate(makeLlmDeps({ raw: JSON.stringify({ is_promise: false, confidence: 0.9, time_kind: 'none' }) }), CANDIDATE_INPUT)
    ok('d3 is_promise=false → not_promise 零登记', !r.registered && r.reason === 'not_promise')
    // d4 低置信
    r = await processPaymentCandidate(makeLlmDeps({ raw: JSON.stringify({ is_promise: true, confidence: 0.55, time_kind: 'tomorrow' }) }), CANDIDATE_INPUT)
    ok('d4 置信 0.55 < 0.6 → low_confidence 零登记', !r.registered && r.reason === 'low_confidence')
    // d5 日期解不出
    r = await processPaymentCandidate(makeLlmDeps({ raw: JSON.stringify({ is_promise: true, confidence: 0.9, time_kind: 'none' }) }), CANDIDATE_INPUT)
    ok('d5 日期解不出 → due_unresolved 零登记', !r.registered && r.reason === 'due_unresolved')
    // d6 AI 未配置零调用
    const cfgCalls: { system: string; user: string }[] = []
    r = await processPaymentCandidate(makeLlmDeps({ configured: false, calls: cfgCalls }), CANDIDATE_INPUT)
    ok('d6 AI 未配置 → 整链跳过零调用', !r.registered && r.reason === 'ai_not_configured' && cfgCalls.length === 0)
    // d7 非候选零调用
    r = await processPaymentCandidate(makeLlmDeps({ raw: '{}', calls: cfgCalls }), { ...CANDIDATE_INPUT, text: '多少钱啊这台' })
    ok('d7 非候选 → not_candidate 零调用', !r.registered && r.reason === 'not_candidate' && cfgCalls.length === 0)
    // d8 成功登记：置信 0.85 + 明天 → due = T0 次日 0 点（新证据键，与 b3 不冲突）
    calls = []
    const dInput = { ...CANDIDATE_INPUT, messageKey: 'wxid_pay1:1780000000:12' }
    r = await processPaymentCandidate(makeLlmDeps({ raw: JSON.stringify({ is_promise: true, confidence: 0.85, time_kind: 'tomorrow', weekday: 0, date: '' }), calls }), dInput)
    ok('d8 候选命中→LLM→登记成功', r.registered && r.reason === 'registered')
    const due = promiseRow('wxid_pay1:1780000000:12')?.due_date
    ok('d8\' due_date = 消息次日 0 点', Number(due) === dayStartOf(2026, 8, 2))
    ok('d8\'\' LLM 恰好调用一次且 user 已脱敏走 buildPaymentPromiseUserPrompt', calls.length === 1 && calls[0].system.length > 0 && calls[0].user.includes('消息日期'))
    // d9 幂等：同 messageKey 重放（LLM 再次判定同一条原话）→ already_registered 零新行
    r = await processPaymentCandidate(makeLlmDeps({ raw: JSON.stringify({ is_promise: true, confidence: 0.9, time_kind: 'tomorrow' }) }), dInput)
    ok('d9 同证据键重放幂等（唯一约束兜底）', r.registered && r.reason === 'already_registered' && promiseCount() === 2)
  }

  // ─── e. due_date 解析性（resolveDueDate 纯函数）─────────────────────────────
  {
    const base = T0 // 2026-09-01 周二
    const p = (over: Partial<ParsedPromise>): ParsedPromise =>
      ({ isPromise: true, confidence: 0.9, timeKind: 'none', weekday: 0, dateText: '', ...over })
    ok('e1 明天 → 次日 0 点', resolveDueDate(p({ timeKind: 'tomorrow' }), base) === dayStartOf(2026, 8, 2))
    ok('e2 下周三 → 下个自然周周三', resolveDueDate(p({ timeKind: 'next_week', weekday: 3 }), base) === dayStartOf(2026, 8, 9))
    ok('e3 周一 → 本周 upcoming 周一', resolveDueDate(p({ timeKind: 'weekday', weekday: 1 }), base) === dayStartOf(2026, 8, 7))
    ok('e3\' 周日 → 1-7 天窗内最近周日', resolveDueDate(p({ timeKind: 'weekday', weekday: 7 }), base) === dayStartOf(2026, 8, 6))
    ok('e4 月底 → 当月最后一天', resolveDueDate(p({ timeKind: 'month_end' }), base) === dayStartOf(2026, 8, 30))
    ok('e5 具体日期 → 严格解析', resolveDueDate(p({ timeKind: 'specific_date', dateText: '2026-10-15' }), base) === dayStartOf(2026, 9, 15))
    ok('e5\' X月X日两位份月尾非法日期 → 解不出', resolveDueDate(p({ timeKind: 'specific_date', dateText: '2026-02-30' }), base) === 0)
    ok('e6 N天后 → base+N', resolveDueDate(p({ timeKind: 'days_later', weekday: 3 }), base) === dayStartOf(2026, 8, 4))
    ok('e7 过去日期 → 解不出（宁缺毋滥）', resolveDueDate(p({ timeKind: 'specific_date', dateText: '2026-08-31' }), base) === 0)
    ok('e7\' weekday=8 / days_later=0 / 越界 → 解不出', resolveDueDate(p({ timeKind: 'weekday', weekday: 8 }), base) === 0 && resolveDueDate(p({ timeKind: 'days_later', weekday: 0 }), base) === 0)
    ok('e7\'\' 超 400 天视野 → 解不出', resolveDueDate(p({ timeKind: 'specific_date', dateText: '2030-01-01' }), base) === 0)
    ok('e7\'\'\' isPromise=false / base=0 → 解不出', resolveDueDate(p({ isPromise: false, timeKind: 'tomorrow' }), base) === 0 && resolveDueDate(p({ timeKind: 'tomorrow' }), 0) === 0)
    ok('e8 parse 非法 time_kind → null', parsePaymentPromiseResponse('{"is_promise":true,"confidence":0.9,"time_kind":"someday"}') === null)
    ok('e8\' parse 无 JSON / 坏 JSON → null', parsePaymentPromiseResponse('嗯') === null && parsePaymentPromiseResponse('{bad') === null)
    ok('e8\'\' parse 钳置信 + camel 兼容', (() => {
      const j = parsePaymentPromiseResponse('{"isPromise":true,"confidence":5,"timeKind":"tomorrow"}')
      return !!j && j.confidence === 1 && j.isPromise && j.timeKind === 'tomorrow'
    })())
  }

  // ─── f. 脱敏前置（铁律 4：送 LLM 文本先过 maskPrivateText）──────────────────
  {
    const out = buildPaymentPromiseUserPrompt('我手机 13812345678，微信号 wxid_abc123，明天打款', T0)
    ok('f1 手机号已打码', !out.includes('13812345678') && out.includes('***'))
    ok('f2 wxid 已打码', !out.includes('wxid_abc123'))
    ok('f3 正文保留（脱敏非删除）+ 消息日期行', out.includes('明天打款') && out.includes('2026-09-01'))
  }

  // ─── g. 证据锚点强制（验不出原话整条丢弃，宪法 §1.10）───────────────────────
  {
    const accId = CANDIDATE_INPUT.accountId
    ok('g1 缺 evidence_key → no_evidence 整条丢弃', registerPaymentPromise({ accountId: accId, sessionId: 's', promiseText: '明天打款', dueDate: 1, evidenceKey: '' }).reason === 'no_evidence')
    ok('g2 缺 promise_text → no_evidence 整条丢弃', registerPaymentPromise({ accountId: accId, sessionId: 's', promiseText: '', dueDate: 1, evidenceKey: 'k' }).reason === 'no_evidence')
    ok('g3 缺 sessionId → bad_input（证据回查契约必填）', registerPaymentPromise({ accountId: accId, sessionId: '', promiseText: '明天打款', dueDate: 1, evidenceKey: 'k' }).reason === 'bad_input')
    ok('g4 accountId=0 → no_account', registerPaymentPromise({ accountId: 0, sessionId: 's', promiseText: '明天打款', dueDate: 1, evidenceKey: 'k' }).reason === 'no_account')
    ok('g5 dueDate=0 → invalid_due_date', registerPaymentPromise({ accountId: accId, sessionId: 's', promiseText: '明天打款', dueDate: 0, evidenceKey: 'k' }).reason === 'invalid_due_date')
    ok('g5\' 以上全部零登记', promiseCount() === 2)
  }

  // ─── h. 到期扫描（核心链路；前序节遗留行清场，扫描计数按本节种子行断言）──────────
  {
    const accId = CANDIDATE_INPUT.accountId
    // h4 专用独立账户：同账户「登记后到款」会抵掉该账户任何在先承诺（按账户到款口径），
    // 「登记前到款不算」必须用零到款噪音的独立账户验证
    const accB = crmDbService.ensureAccount('承诺测试客户乙')
    crmDbService.update('account', accB, { session_id: 'wxid_pay2' })
    const scanNow = dayStartOf(2026, 8, 6) + 20 * 3600_000 // 2026-09-06 20:00（窗口内）
    crmDbService.all('DELETE FROM payment_promise') // 清场：b/d 节登记行已履行完断言职责
    const seed = (evidenceKey: string, over: { dueDate?: number; now?: number; accountId?: number; sessionId?: string } = {}): void => {
      const res = registerPaymentPromise({
        accountId: over.accountId ?? accId, sessionId: over.sessionId ?? 'wxid_pay1',
        promiseText: `原话·${evidenceKey}`,
        dueDate: over.dueDate ?? dayStartOf(2026, 8, 2), evidenceKey, now: over.now ?? T0
      })
      if (!res.ok) throw new Error(`seed 失败 ${evidenceKey}: ${JSON.stringify(res)}`)
    }
    const auditOf = (action: string, entityId: number): number =>
      Number(crmDbService.all('SELECT COUNT(*) AS c FROM audit_event WHERE action = ? AND entity_id = ?', [action, entityId])[0].c)

    // h1 到期无款 + 推送门关（默认）→ overdue 置位，四道闸零副作用（证据/去重零查询、零落记录）
    seed('scan:no_pay_no_gate', { accountId: accB, sessionId: 'wxid_pay2' })
    const { svc: gateSvc, state: gateState } = makeRealAlertService({ evidenceFound: true })
    const r1 = await runPaymentPromiseScan({ alertService: gateSvc, now: () => scanNow, log: () => {} })
    const row1 = promiseRow('scan:no_pay_no_gate')
    ok('h1 到期无款 + 门关 → 状态 overdue', row1?.status === 'overdue')
    ok('h1\' 门关零副作用：证据回查/落记录零次', gateState.evidenceChecks === 0 && gateState.records === 0)
    ok('h1\'\' 扫描计数 overdue=1 alerted=0', r1.overdue === 1 && r1.alerted === 0 && r1.alertNotCreated === 1)
    ok('h1\'\'\' 流转写 audit_event', auditOf('payment_promise_mark', Number(row1?.id)) === 1)

    // h2 门开 + 证据 found → 落记录（走真实四道闸全链）
    ALERT_PUSH_APPROVED.payment_overdue = true
    try {
      seed('scan:gate_open', { accountId: accB, sessionId: 'wxid_pay2' })
      const { svc: openSvc, state: openState } = makeRealAlertService({ evidenceFound: true })
      const r2 = await runPaymentPromiseScan({ alertService: openSvc, now: () => scanNow, log: () => {} })
      ok('h2 门开 → created 告警恰好一条', r2.alerted === 1 && openState.records === 1)
      const rec = openState.lastRecord as { triggerReason?: string; messageKey?: string; insight?: string; sourceType?: string; sessionId?: string } | null
      ok('h2\' 记录 triggerReason=alert:payment_overdue + 锚点原样', rec?.triggerReason === 'alert:payment_overdue' && rec?.messageKey === 'scan:gate_open')
      ok('h2\'\' 文案含原话快照与到期日', String(rec?.insight || '').includes('原话·scan:gate_open') && String(rec?.insight || '').includes('2026-09-02'))
      ok('h2\'\'\' sourceType=insight（信箱可见）', rec?.sourceType === 'insight' && rec?.sessionId === 'wxid_pay2')
    } finally {
      ALERT_PUSH_APPROVED.payment_overdue = false
    }

    // h3 登记之后有到款 → kept（allocation 归因链）
    seed('scan:kept_alloc')
    const payId1 = crmDbService.createPaymentRecord({ payer: '路人甲', amount_net: 5000, pay_time: T0 + dayMs, source: 'bank_text', pay_channel: 'bank_direct', created_at: T0 + dayMs })
    crmDbService.create('allocation', { payment_record_id: payId1, customer_hint: '承诺测试客户', amount_hint: 5000, credited_amount: 5000, account_id: accId, status: 'pending', created_at: T0 + dayMs })
    const r3 = await runPaymentPromiseScan({ alertService: gateSvc, now: () => scanNow, log: () => {} })
    ok('h3 登记后有到款 → kept 且零告警', promiseRow('scan:kept_alloc')?.status === 'kept' && r3.kept === 1 && r3.overdue === 0)

    // h4 登记之前的到款不算（时间口径：pay_time/created_at ≥ 登记时刻；独立账户乙，唯一一笔在登记前）
    seed('scan:old_payment', { accountId: accB, sessionId: 'wxid_pay2' })
    const payId2 = crmDbService.createPaymentRecord({ payer: '路人乙', amount_net: 8000, pay_time: T0 - dayMs, source: 'bank_text', pay_channel: 'bank_direct', created_at: T0 - dayMs })
    crmDbService.create('allocation', { payment_record_id: payId2, customer_hint: '承诺测试客户乙', amount_hint: 8000, credited_amount: 8000, account_id: accB, status: 'pending', created_at: T0 - dayMs })
    const r4 = await runPaymentPromiseScan({ alertService: gateSvc, now: () => scanNow, log: () => {} })
    ok('h4 登记前的到款不抵承诺 → overdue', promiseRow('scan:old_payment')?.status === 'overdue' && r4.overdue === 1)

    // h5 付款方名/别名归因（allocation 未挂上时仍算 kept——名字直配 account / alias_map）
    seed('scan:kept_payer_name')
    crmDbService.createPaymentRecord({ payer: '承诺测试客户', amount_net: 3000, pay_time: T0 + dayMs, source: 'bank_text', pay_channel: 'bank_direct', created_at: T0 + dayMs })
    crmDbService.create('alias_map', { alias: '老王叉车', account_id: accId, hit_count: 0, created_at: T0 })
    seed('scan:kept_payer_alias')
    crmDbService.createPaymentRecord({ payer: '老王叉车', amount_net: 2000, pay_time: T0 + dayMs, source: 'bank_text', pay_channel: 'bank_direct', created_at: T0 + dayMs })
    await runPaymentPromiseScan({ alertService: gateSvc, now: () => scanNow, log: () => {} })
    ok('h5 付款方名直配 account → kept', promiseRow('scan:kept_payer_name')?.status === 'kept')
    ok('h5\' 付款方命中别名 → kept', promiseRow('scan:kept_payer_alias')?.status === 'kept')

    // h6 未到期不动（承诺日还没过：明天到期，今天 20:00 扫）
    seed('scan:not_due', { dueDate: dayStartOf(2026, 8, 7) })
    const r6 = await runPaymentPromiseScan({ alertService: gateSvc, now: () => scanNow, log: () => {} })
    ok('h6 未到期 pending 原样（due_date < 今日0点 才算已过）', promiseRow('scan:not_due')?.status === 'pending' && r6.scanned === 0)

    // h7 重扫幂等：pending 守卫——已流转行不再进扫描
    const r7 = await runPaymentPromiseScan({ alertService: gateSvc, now: () => scanNow, log: () => {} })
    ok('h7 重扫零命中（状态流转幂等）', r7.scanned === 0 && r7.kept === 0 && r7.overdue === 0)

    // h8 72h 幂等（走链）：同 session 同 triggerReason 已有记录 → deduped，零落库
    ALERT_PUSH_APPROVED.payment_overdue = true
    try {
      seed('scan:dedup', { accountId: accB, sessionId: 'wxid_pay2' })
      const { svc: dedupSvc, state: dedupState } = makeRealAlertService({ evidenceFound: true, hasRecent: true })
      const r8 = await runPaymentPromiseScan({ alertService: dedupSvc, now: () => scanNow, log: () => {} })
      ok('h8 72h 幂等 → deduped 零落库（幂等窗 72h）', r8.overdue === 1 && r8.alerted === 0 && dedupState.records === 0 && ALERT_DEDUP_MS === 72 * 3600_000)
      // h9 证据验不出 → no_evidence 零落库（宪法 §1.10）
      seed('scan:no_evidence', { accountId: accB, sessionId: 'wxid_pay2' })
      const { svc: noEvSvc, state: noEvState } = makeRealAlertService({ evidenceFound: false })
      const r9 = await runPaymentPromiseScan({ alertService: noEvSvc, now: () => scanNow, log: () => {} })
      ok('h9 证据验不出 → 告警丢弃零落库，状态仍 overdue（事实判定）', r9.alerted === 0 && noEvState.records === 0 && noEvState.evidenceChecks > 0 && promiseRow('scan:no_evidence')?.status === 'overdue')
    } finally {
      ALERT_PUSH_APPROVED.payment_overdue = false
    }
    ok('h9\' 推送门恢复默认 false', ALERT_PUSH_APPROVED.payment_overdue === false)
  }

  // ─── i. 接线静态检查 ────────────────────────────────────────────────────────
  {
    const parseSrc = readFileSync(join(ROOT, 'electron/services/crmParseService.ts'), 'utf-8')
    ok('i1 crmParseService 挂候选正则 + 调识别链', parseSrc.includes('isPaymentPromiseCandidate') && parseSrc.includes('processPaymentCandidate'))
    ok('i2 我方消息不识别（isSend=0 且 accountId 门控）', parseSrc.includes('isSend === 0 && accountId && isPaymentPromiseCandidate'))
    ok('i3 锚点与原话传全（canonical key 复用 + 原话快照）', /messageKey: key,/.test(parseSrc) && parseSrc.includes('text: textForSignal'))
    ok('i4 B 流失规则仍未接线（alert-eval-test d1 守卫不破）', !parseSrc.includes('parseLossSignal'))
    ok('i5 crmParseService 无 payment_promise 直写 SQL（写点单点）', !parseSrc.includes('INSERT INTO payment_promise'))

    const svcSrc = readFileSync(join(ROOT, 'electron/services/crmPaymentPromiseService.ts'), 'utf-8')
    ok('i6 到期扫描走 createAlert 单点 + type 正确', svcSrc.includes("type: 'payment_overdue'") && svcSrc.includes('createAlert'))
    ok('i7 LLM 出口唯一且 user 强制脱敏', /llm\(PAYMENT_PROMISE_SYSTEM,\s*buildPaymentPromiseUserPrompt\(/.test(svcSrc) && svcSrc.includes('maskPrivateText'))
    ok('i8 payment_record 零写（只读比对）', !/INSERT INTO payment_record|UPDATE payment_record|createPaymentRecord/.test(svcSrc))
    ok('i9 调度窗口跟随复盘定时器时段（20:00-20:30 每日）', svcSrc.includes('getHours() === 20') && svcSrc.includes('getMinutes() < 30'))
    ok('i9\' scan_state 每日标记防重启重扫', svcSrc.includes('PAYMENT_SCAN_STATE_PREFIX') && svcSrc.includes('getScanState'))

    const mainSrc = readFileSync(join(ROOT, 'electron/main.ts'), 'utf-8')
    ok('i10 main.ts 启动链挂 startPaymentPromiseScanScheduler', mainSrc.includes('startPaymentPromiseScanScheduler()'))

    const evalSrc = readFileSync(join(ROOT, 'scripts/alert-eval.ts'), 'utf-8')
    ok('i11 alert-eval.ts 评测通道支持 payment_overdue', evalSrc.includes("'payment_overdue'") && evalSrc.includes('isPaymentPromiseCandidate') && evalSrc.includes('no_promise_sample'))

    // 运行时窗口函数
    ok('i12 isPaymentScanWindow：20:00-20:30 内 true / 外 false', isPaymentScanWindow(new Date(2026, 8, 6, 20, 10)) === true && isPaymentScanWindow(new Date(2026, 8, 6, 20, 30)) === false && isPaymentScanWindow(new Date(2026, 8, 6, 19, 59)) === false)
    ok('i12\' scan_state 键按天区分', paymentScanStateKeyFor(new Date(2026, 8, 6)) !== paymentScanStateKeyFor(new Date(2026, 8, 7)) && paymentScanStateKeyFor(new Date(2026, 8, 6)).includes('paymentPromiseScan:'))
  }

  console.log(`\nalert-payment-test: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

void main().catch((e) => { console.error(e); process.exit(1) })
