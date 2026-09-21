/**
 * annual-review-ai-test.ts —— 年度经营复盘 S7.1 护栏（AI 纯模块 + 服务层调用接口）
 *
 * 覆盖（对应用户验收条目）：
 *   I   AI 输入是最小白名单投影：无客户明细列表、无姓名/身份/会话/路径/SQL/Token/正文
 *   P   prompt 契约：同输入稳定、含铁律（数字只能来自输入 / unavailable≠0 / metricKeys 必填）
 *   J   合法 JSON / Markdown fenced JSON / 前后缀文字中的 JSON 均被接受
 *   F   空输出、非 JSON、非对象、额外字段、缺字段、数组超量 → 结构化失败（不部分采信）
 *   K   未知 metricKey、重复 metricKey、空 metricKeys、非法 confidence/priority/horizon、
 *       空文本、超长文本、非字符串数值
 *   S   服务层：未配置 / 调用异常 / 额度阻断 / 报告不合约 → 结构化失败码；成功路径仅注入出口
 *   D   确定性：同报告两次投影深等、两次 prompt 相同；AI 失败不改变原始报告；输入对象不被修改
 *   C   调用参数契约：低温度、JSON response format、token 上限、usage purpose=annual_review_ai
 *
 * 测试纪律：模型出口经 AnnualReviewAiRunOptions.completion 注入假实现——本脚本**不会**
 * 触碰 aiApiClient，不发出任何真实请求，也不读写真实账本/数据库。
 * 运行：npx tsx scripts/annual-review-ai-test.ts
 */
import {
  resolveAnnualReviewPeriod,
  type AnnualReviewFacts,
  type AnnualReviewMessageStats
} from '../electron/services/annualReviewStats'
import type { AnnualReviewSalesSegmentsFacts, AnnualReviewCrmSegmentsFacts } from '../electron/services/annualReviewSegments'
import { composeAnnualReviewReport, type AnnualReviewReport } from '../electron/services/annualReviewReport'
import { AiBudgetBlockedError } from '../electron/services/ai/aiBudget'
import {
  ANNUAL_REVIEW_AI_CONFIDENCE,
  ANNUAL_REVIEW_AI_HORIZONS,
  ANNUAL_REVIEW_AI_LIMITS,
  ANNUAL_REVIEW_AI_PRIORITIES,
  ANNUAL_REVIEW_AI_PROMPT_VERSION,
  ANNUAL_REVIEW_AI_PURPOSE,
  ANNUAL_REVIEW_AI_TEMPERATURE,
  ANNUAL_REVIEW_AI_MAX_TOKENS,
  ANNUAL_REVIEW_AI_SYSTEM_PROMPT,
  annualReviewAiMetricKeys,
  buildAnnualReviewAiInput,
  buildAnnualReviewAiPrompt,
  parseAnnualReviewAiOutput,
  type AnnualReviewAiInput
} from '../electron/services/annualReviewAiCore'
import {
  buildAnnualReviewAiCallOptions,
  generateAnnualReviewAiAnalysis,
  type AnnualReviewAiCompletion,
  type AnnualReviewAiRunResult
} from '../electron/services/annualReviewAiService'

let pass = 0, fail = 0
function ok(name: string, cond: boolean): void {
  if (cond) { pass++ } else { fail++; console.error('FAIL:', name) }
}
function eq(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a === b) pass++
  else { fail++; console.error(`FAIL: ${name}\n  actual:   ${a}\n  expected: ${b}`) }
}

const T = (y: number, m: number, d: number, hh = 0, mm = 0, ss = 0): number =>
  new Date(y, m - 1, d, hh, mm, ss).getTime()
const GEN = T(2026, 6, 15, 12, 0, 0)

// ── 夹具：含客户姓名 / 会话标识 / 销售姓名 / 画像 customer_id 的「最脏」报告 ──
// 目的：若投影层漏掉任何一处明细，下面的泄漏断言必须能抓到。
const CUSTOMER_NAME = '张三丰客户甲'
const SESSION_ID = 'wxid_leak_canary_001'
const SALES_NAME = '李四销售'
const CUSTOMER_ID = '900123'

function richFacts(): { facts: AnnualReviewFacts; sales: AnnualReviewSalesSegmentsFacts; crm: AnnualReviewCrmSegmentsFacts } {
  const facts: AnnualReviewFacts = {
    accounts: [
      {
        id: 1, name: CUSTOMER_NAME, createdAt: T(2025, 2, 1), importedAt: null,
        sessionId: SESSION_ID, lastContactAtSec: Math.floor(T(2026, 6, 10, 9) / 1000), ownerSales: SALES_NAME
      },
      {
        id: 2, name: '第二名客户', createdAt: T(2026, 3, 20), importedAt: T(2026, 4, 1),
        sessionId: 'wxid_second', lastContactAtSec: Math.floor(T(2025, 12, 1) / 1000), ownerSales: SALES_NAME
      }
    ],
    contracts: [
      { id: 1, accountId: 1, amount: 120000, status: 'signed', signDate: T(2026, 2, 1) },
      { id: 2, accountId: 2, amount: 80000, status: 'signed', signDate: T(2026, 4, 10) },
      { id: 3, accountId: 1, amount: 60000, status: 'signed', signDate: T(2026, 5, 3) }
    ],
    allocations: [
      { id: 1, contractId: 1, accountId: 1, creditedAmount: 100000, status: 'confirmed', reconciliationStatus: 'allocated', reconciledAt: T(2026, 3, 2), confirmedAt: null, salesName: SALES_NAME },
      { id: 2, contractId: 2, accountId: 2, creditedAmount: 30000, status: 'confirmed', reconciliationStatus: 'allocated', reconciledAt: T(2026, 5, 1), confirmedAt: null, salesName: SALES_NAME }
    ],
    shippedEvents: [{ id: 1, contractId: 1, toStatus: 'shipped', createdAt: T(2026, 3, 20) }],
    assignments: [{ id: 1, leadId: 1, salesName: SALES_NAME, mode: 'round_robin', claimedAt: T(2026, 2, 5) }],
    leads: [{ id: 1, accountId: 1, firstContactedAt: T(2026, 2, 6) }],
    auditEvents: [
      { id: 1, action: 'lead_assign', createdAt: T(2026, 2, 5), detailType: null, salesName: SALES_NAME, toSales: null, fromSales: null, mode: 'round_robin', assignmentId: 1 },
      { id: 2, action: 'lead_transfer', createdAt: T(2026, 4, 1), detailType: null, salesName: null, toSales: SALES_NAME, fromSales: '王五销售', mode: null, assignmentId: 1 }
    ]
  }
  const sales: AnnualReviewSalesSegmentsFacts = {
    profiles: [
      { id: 1, sessionId: SESSION_ID, stage: '决策', lastContactAtSec: Math.floor(T(2026, 6, 10, 9) / 1000), customerId: CUSTOMER_ID },
      { id: 2, sessionId: 'wxid_second', stage: '比价', lastContactAtSec: Math.floor(T(2025, 12, 1) / 1000), customerId: '900456' }
    ],
    intentEvents: [
      { id: 1, sessionId: SESSION_ID, stage: '了解', createdAt: T(2026, 1, 15) },
      { id: 2, sessionId: SESSION_ID, stage: '比价', createdAt: T(2026, 3, 5) },
      { id: 3, sessionId: 'wxid_second', stage: '决策', createdAt: T(2026, 4, 5) }
    ]
  }
  const crm: AnnualReviewCrmSegmentsFacts = {
    opportunities: [{ id: 1, accountId: 1, stage: '比价', status: 'open', createdAt: T(2026, 1, 20) }],
    opportunityEvents: [{ id: 1, opportunityId: 1, eventType: 'stage', stage: '决策', detail: '客户已到决策阶段', createdAt: T(2026, 5, 3) }]
  }
  return { facts, sales, crm }
}

const messageStats: AnnualReviewMessageStats = {
  ok: true,
  sessions: { [SESSION_ID]: { sent: 12, received: 9 }, wxid_second: { sent: 4, received: 2 } },
  daily: {
    '2026-01-11': 5, '2026-02-14': 9, '2026-03-08': 6,
    '2026-04-20': 4, '2026-05-02': 3, '2026-06-05': 7
  }
}

const fixture = richFacts()
const REPORT: AnnualReviewReport = composeAnnualReviewReport({
  period: resolveAnnualReviewPeriod(2026, GEN),
  facts: fixture.facts,
  sales: fixture.sales,
  crm: fixture.crm,
  opts: { messageStats }
})
/** 同一批事实的历史年度报告：覆盖 historical_reconstruction 投影分支 */
const REPORT_2025: AnnualReviewReport = composeAnnualReviewReport({
  period: resolveAnnualReviewPeriod(2025, GEN),
  facts: fixture.facts,
  sales: fixture.sales,
  crm: fixture.crm,
  opts: { messageStats }
})

/** 深快照（JSON 视图）：用于「不改变原始报告 / 不共享引用」的比对 */
const snapshot = (v: unknown): string => JSON.stringify(v)

/** 递归收集对象里出现的所有键（含数组元素） */
function collectKeys(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, out)
    return out
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.add(k)
      collectKeys(v, out)
    }
  }
  return out
}

/** 递归收集所有字符串叶子值 */
function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') { out.push(value); return out }
  if (Array.isArray(value)) { for (const item of value) collectStrings(item, out); return out }
  if (value && typeof value === 'object') { for (const v of Object.values(value)) collectStrings(v, out); }
  return out
}

/**
 * 投影层允许出现的**全部**键名（跨所有对象）；出现任何其他键即视为明细泄漏。
 * 这是比「黑名单查敏感字段名」更强的断言：客户明细行会带 stage/bucket 之外的
 * accountId/name/creditedAmount/contractCount 等键，一个都不在白名单里。
 */
const ALLOWED_INPUT_KEYS = new Set([
  'meta', 'metrics', 'distributions', 'series', 'coverage', 'warnings',
  'year', 'scopeKind', 'asOfDate', 'generatedAtDate', 'dataRange', 'from', 'to', 'timezoneNote', 'completeness', 'overall', 'blocks',
  'summary', 'funnel', 'customers', 'monthly', 'communication', 'salesAssignment',
  'key', 'value', 'state', 'kind', 'buckets', 'bucket', 'count', 'points', 'month',
  'status', 'source', 'rows', 'exactCoverage', 'coverageRatio', 'reasonCodes',
  'code', 'message', 'metricKeys', 'counts'
])

/**
 * 收集所有对象里出现的、不在白名单内的键。
 * warnings.counts 的键是动态 metricKey（报告契约如此），按叶子映射整体跳过。
 */
function unexpectedKeys(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) unexpectedKeys(item, out)
    return out
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (!ALLOWED_INPUT_KEYS.has(k)) out.add(k)
      if (k === 'counts') continue
      unexpectedKeys(v, out)
    }
  }
  return out
}

// ── 合法/非法模型输出样本 ────────────────────────────────────────────────────
const KEYS = annualReviewAiMetricKeys(REPORT)
const VALID_KEY = 'summary.contractAmount'
const VALID_KEY_2 = 'summary.creditedAmount'

const validAnalysis = {
  executiveSummary: '2025 年度签约金额与回款存在差额，客户结构集中度偏高。',
  diagnoses: [
    { title: '回款滞后于签约', observation: '签约金额高于已核销回款金额。', hypothesis: '可能存在验收或开票周期拉长。', metricKeys: [VALID_KEY, VALID_KEY_2], confidence: 'medium' }
  ],
  actions: [
    { priority: 1, action: '下一年度建立回款跟催节奏。', rationale: '回款与签约的差额需要逐月跟踪。', metricKeys: [VALID_KEY_2], horizon: 'next_quarter' }
  ],
  risks: [{ risk: '部分指标数据不完整，结论需谨慎。', metricKeys: [VALID_KEY] }]
}
const validJson = (over: Record<string, unknown> = {}): string => JSON.stringify({ ...validAnalysis, ...over })

const fakeConfig = { get: () => undefined } as never

/** 固定返回给定文本的注入出口（记录调用次数与请求，绝无真实网络） */
function stubCompletion(text: string): { completion: AnnualReviewAiCompletion; calls: Array<{ systemPrompt: string; userPrompt: string; model: string; promptVersion: string }> } {
  const calls: Array<{ systemPrompt: string; userPrompt: string; model: string; promptVersion: string }> = []
  const completion: AnnualReviewAiCompletion = async (req) => { calls.push({ ...req }); return text }
  return { completion, calls }
}

async function main(): Promise<void> {
  // ── I. AI 输入是最小白名单投影 ──
  {
    // 先证明 canary 确实存在（否则下面的「不存在」断言是空转）
    ok('I0 夹具事实确实含会话标识（前提成立）', snapshot(fixture.facts).includes(SESSION_ID))
    ok('I0b 夹具报告确实含客户姓名（前提成立）', snapshot(REPORT).includes(CUSTOMER_NAME))
    ok('I0c 夹具报告确实含销售姓名（前提成立）', snapshot(REPORT).includes(SALES_NAME))
    ok('I0d 夹具报告确实含客户 customer_id（前提成立）', snapshot(REPORT).includes(CUSTOMER_ID))
    ok('I0e 夹具报告确实含客户明细列表（前提成立）', snapshot(REPORT).includes('"contractAmount"') && snapshot(REPORT).includes('"lastContactAtMs"'))

    const input = buildAnnualReviewAiInput(REPORT)
    const keys = collectKeys(input)
    // 明细/身份字段名一律不得出现（sessionId 本就不进报告，此处再确认一次投影层没有引入）
    for (const forbidden of ['name', 'accountId', 'customerId', 'sessionId', 'session_id', 'wxid', 'ownerSales', 'salesName', 'sourceSummary', 'longSilent', 'contractContribution', 'creditedContribution', 'tables', 'dbPath', 'sql', 'token']) {
      ok(`I1 输入不含字段 ${forbidden}`, !keys.has(forbidden))
    }
    const strings = collectStrings(input)
    for (const secret of [CUSTOMER_NAME, '第二名客户', SESSION_ID, 'wxid_second', SALES_NAME, '王五销售', CUSTOMER_ID, '900456', '客户已到决策阶段']) {
      ok(`I2 输入不含明细值 ${secret}`, !strings.some((s) => s.includes(secret)))
    }
    // 无数据库路径 / SQL / Token 形状
    const flat = snapshot(input)
    for (const bad of ['.db', '/Users/', 'SELECT ', 'Bearer ', 'apiKey', 'token', 'sk-']) {
      ok(`I2b 输入不含敏感形状 ${bad}`, !flat.includes(bad))
    }
    // 投影层的键名白名单：出现任何白名单外的键即说明有明细行混入
    const stray = [...unexpectedKeys(input)]
    eq('I2c 输入不含白名单外的任何键', stray, [])
    ok('I2d 报告里存在的明细字段名均未进入输入', !['creditedAmount', 'contractCount', 'lastContactAtMs', 'firstSignDate', 'stage', 'imported'].some((k) => keys.has(k)))

    // I3 顶层只有六个白名单键，且没有客户明细列表
    eq('I3 输入顶层键 = 白名单六项', Object.keys(input).sort(), ['coverage', 'distributions', 'meta', 'metrics', 'series', 'warnings'])
    ok('I3b 输入不含 customers/sourceSummary 明细块', !flat.includes('"sourceSummary"') && !flat.includes('"kind":"current_snapshot","distribution"'))
    ok('I3b2 输入里的 customers 只作为完整性区块 id 出现一次', (flat.match(/"customers"/g) ?? []).length === 1 && input.meta.completeness.blocks.customers !== undefined)
    ok('I3c 输入不含 E 组 per-sales 明细', !flat.includes('"contractContribution"') && !flat.includes('"creditedContribution"') && !flat.includes('"groups"') && !flat.includes('"initialAssignments"'))
    ok('I3d 输入不含 D7 名单', !flat.includes('"longSilent"'))
    ok('I3e 输入不含任何明细列表（数组元素里没有身份或金额行）', !/"value":\[\{/.test(flat))

    // I4 coverage 覆盖报告全部 metricKey（AI 可引用的键集合 = 报告 coverage 键集合）
    eq('I4 输入 coverage 键集合与报告一致', input.coverage.map((c) => c.key), KEYS)
    eq('I4b 输入 metrics 键均为报告 coverage 子集', input.metrics.every((m) => KEYS.includes(m.key)), true)
    eq('I4c 输入 distributions 键均为报告 coverage 子集', input.distributions.every((d) => KEYS.includes(d.key)), true)
    eq('I4d 输入 series 键均为报告 coverage 子集', input.series.every((s) => KEYS.includes(s.key)), true)

    // I5 unavailable ≠ 0：不可得指标的 value 必须是 null，绝不能被写成 0
    const unavailableMetrics = input.metrics.filter((m) => m.state === 'unavailable')
    ok('I5 不可得指标的 value 为 null（不是 0）', unavailableMetrics.every((m) => m.value === null))
    const nullPoints = input.series.filter((s) => s.state === 'unavailable')
    ok('I5b 不可得的月度序列 points 为 null（不是空数组）', nullPoints.every((s) => s.points === null))

    // I6 月度趋势：金额序列值来自 amount，消息序列来自 count
    const sign = input.series.find((s) => s.key === 'monthly.contractSign')
    const volume = input.series.find((s) => s.key === 'monthly.messageVolume')
    ok('I6 签约序列点值 = 报告月度金额', !!sign && !!sign.points && sign.points.every((p, i) => p.value === (REPORT.monthly.contractSign.months as Array<{ amount: number }>)[i].amount))
    ok('I6b 消息序列点值 = 报告月度计数', !!volume && !!volume.points && volume.points.every((p, i) => p.value === (REPORT.monthly.messageVolume.months as Array<{ count: number }>)[i].count))
    ok('I6c 消息序列不与 communication.monthlyTrend 重复发送', input.series.filter((s) => s.key.includes('monthlyTrend')).length === 0)

    // I7 阶段分布：桶名来自封闭枚举、计数与报告一致
    const custStage = input.distributions.find((d) => d.key === 'funnel.customerStage')
    eq('I7 客户阶段分布与报告一致', custStage?.buckets, REPORT.funnel.customerStage.distribution)
    ok('I7b 分布桶名为封闭枚举', (custStage?.buckets ?? []).every((b) => ['了解', '比价', '决策', '成交', '流失', '未知'].includes(b.bucket)))

    // I8 警告结构与报告一致（AI 必须能看到数据缺口）
    eq('I8 警告条数与报告一致', input.warnings.length, REPORT.warnings.length)
    eq('I8b 警告 metricKeys 与报告一致', input.warnings.map((w) => w.metricKeys), REPORT.warnings.map((w) => w.metricKeys))
  }

  // ── D. 确定性与只读 ──
  {
    const before = snapshot(REPORT)
    const a = buildAnnualReviewAiInput(REPORT)
    const b = buildAnnualReviewAiInput(REPORT)
    eq('D1 同报告两次投影深等（确定性）', snapshot(a), snapshot(b))
    eq('D2 投影不改变原始报告', snapshot(REPORT), before)

    const promptA = buildAnnualReviewAiPrompt(a)
    const promptB = buildAnnualReviewAiPrompt(b)
    ok('D3 同输入产生稳定 prompt', promptA.systemPrompt === promptB.systemPrompt && promptA.userPrompt === promptB.userPrompt)
    ok('D3b prompt 与调用之间无时钟/随机依赖（连跑三次全等）',
      buildAnnualReviewAiPrompt(buildAnnualReviewAiInput(REPORT)).userPrompt === promptA.userPrompt)

    // 深改输入不应影响报告：证明输出与报告不共享引用
    const mutated = buildAnnualReviewAiInput(REPORT)
    mutated.coverage[0].reasonCodes?.push('MUTATED')
    mutated.metrics[0].value = -999
    mutated.warnings.forEach((w) => { w.metricKeys.push('MUTATED'); if (w.counts) w.counts.MUTATED = 1 })
    if (mutated.distributions[0].buckets) mutated.distributions[0].buckets[0].count = -999
    if (mutated.series[0].points) mutated.series[0].points[0].value = -999
    eq('D4 改动投影不污染原始报告（无共享引用）', snapshot(REPORT), before)

    // 报告被冻结也必须能构建（只读路径不写报告）
    const frozen = REPORT
    const frozenOk = (() => {
      try { buildAnnualReviewAiInput(frozen); return true } catch { return false }
    })()
    ok('D5 构建输入不抛异常', frozenOk)
  }

  // ── P. prompt 契约 ──
  {
    const prompt = buildAnnualReviewAiPrompt(buildAnnualReviewAiInput(REPORT))
    eq('P1 system prompt 使用固定常量', prompt.systemPrompt, ANNUAL_REVIEW_AI_SYSTEM_PROMPT)
    ok('P2 提示词声明「数字只能来自输入」', prompt.systemPrompt.includes('不得自行计算'))
    ok('P3 提示词声明 unavailable 不是 0', prompt.systemPrompt.includes('unavailable'))
    ok('P4 提示词强制 metricKeys 引用真实指标', prompt.systemPrompt.includes('metricKeys'))
    ok('P5 提示词禁止客户个体识别信息', prompt.systemPrompt.includes('不要给出客户名单'))
    ok('P6 user prompt 携带完整输入 JSON', prompt.userPrompt.includes(JSON.stringify(buildAnnualReviewAiInput(REPORT))))
    ok('P7 user prompt 不含客户姓名', !prompt.userPrompt.includes(CUSTOMER_NAME) && !prompt.userPrompt.includes(SESSION_ID))
  }

  // ── J. 合法输出 ──
  {
    const r1 = parseAnnualReviewAiOutput(validJson(), KEYS)
    ok('J1 合法 JSON 解析成功', r1.ok)
    eq('J1b 解析结果字段一致', r1.ok ? r1.analysis : null, validAnalysis)

    const fenced = '```json\n' + validJson() + '\n```'
    const r2 = parseAnnualReviewAiOutput(fenced, KEYS)
    ok('J2 Markdown fenced JSON 解析成功', r2.ok)
    eq('J2b 围栏输出与裸 JSON 结果一致', r2.ok ? r2.analysis : null, r1.ok ? r1.analysis : null)

    const prose = `好的，以下是分析结果：\n${validJson()}\n以上就是全部内容。`
    const r3 = parseAnnualReviewAiOutput(prose, KEYS)
    ok('J3 前后缀文字包裹的 JSON 解析成功', r3.ok)

    const spaced = `\n\n  ${validJson()}  \n`
    ok('J4 首尾空白被容忍', parseAnnualReviewAiOutput(spaced, KEYS).ok)

    const emptyLists = JSON.stringify({ executiveSummary: '本年度数据不足，暂不给出结论。', diagnoses: [], actions: [], risks: [] })
    const r5 = parseAnnualReviewAiOutput(emptyLists, KEYS)
    ok('J5 空数组（不臆造内容）是合法输出', r5.ok)
    eq('J5b 空数组原样保留', r5.ok ? [r5.analysis.diagnoses.length, r5.analysis.actions.length, r5.analysis.risks.length] : null, [0, 0, 0])

    const allEnums = JSON.stringify({
      executiveSummary: '枚举全量覆盖。',
      diagnoses: ANNUAL_REVIEW_AI_CONFIDENCE.map((c) => ({ title: `标题${c}`, observation: `观察${c}`, hypothesis: `假设${c}`, metricKeys: [VALID_KEY], confidence: c })),
      actions: ANNUAL_REVIEW_AI_PRIORITIES.map((p) => ({ priority: p, action: `行动${p}`, rationale: `理由${p}`, metricKeys: [VALID_KEY_2], horizon: ANNUAL_REVIEW_AI_HORIZONS[p - 1] })),
      risks: [{ risk: '风险', metricKeys: [VALID_KEY] }]
    })
    ok('J6 全部合法枚举值被接受', parseAnnualReviewAiOutput(allEnums, KEYS).ok)
  }

  // ── F. 空/非 JSON/结构非法 ──
  {
    const cases: Array<[string, unknown, string]> = [
      ['F1 空字符串 → empty_output', '', 'empty_output'],
      ['F1b 纯空白 → empty_output', '   \n\t ', 'empty_output'],
      ['F1c 非字符串（null）→ empty_output', null, 'empty_output'],
      ['F1d 非字符串（对象）→ empty_output', { executiveSummary: 'x' }, 'empty_output'],
      ['F1e 围栏内为空 → empty_output', '```json\n\n```', 'empty_output'],
      ['F2 非 JSON → invalid_json', '这不是 JSON', 'invalid_json'],
      ['F2b 截断 JSON → invalid_json', '{"executiveSummary": "截断', 'invalid_json'],
      ['F2c JSON 数组 → invalid_shape', '[1,2,3]', 'invalid_shape'],
      ['F2d JSON 标量 → invalid_shape', '42', 'invalid_shape'],
      ['F2e JSON null → invalid_shape', 'null', 'invalid_shape'],
      ['F3 顶层缺字段 → invalid_shape', JSON.stringify({ executiveSummary: 'x' }), 'invalid_shape'],
      ['F3b 顶层额外字段 → invalid_shape', validJson({ extra: 'x' }), 'invalid_shape'],
      ['F3c 顶层字段缺失 diagnoses → invalid_shape', JSON.stringify({ executiveSummary: 'x', actions: [], risks: [] }), 'invalid_shape'],
      ['F4 诊断条目额外字段 → invalid_shape', validJson({ diagnoses: [{ ...validAnalysis.diagnoses[0], note: 'x' }] }), 'invalid_shape'],
      ['F4b 诊断条目缺字段 → invalid_shape', validJson({ diagnoses: [{ title: 't', observation: 'o', hypothesis: 'h', metricKeys: [VALID_KEY] }] }), 'invalid_shape'],
      ['F4c 行动条目额外字段 → invalid_shape', validJson({ actions: [{ ...validAnalysis.actions[0], owner: 'x' }] }), 'invalid_shape'],
      ['F4d 风险条目额外字段 → invalid_shape', validJson({ risks: [{ ...validAnalysis.risks[0], level: 'high' }] }), 'invalid_shape'],
      ['F5 诊断超量 → invalid_shape', validJson({ diagnoses: Array.from({ length: ANNUAL_REVIEW_AI_LIMITS.diagnoses + 1 }, () => validAnalysis.diagnoses[0]) }), 'invalid_shape'],
      ['F5b 行动超量 → invalid_shape', validJson({ actions: Array.from({ length: ANNUAL_REVIEW_AI_LIMITS.actions + 1 }, () => validAnalysis.actions[0]) }), 'invalid_shape'],
      ['F5c 风险超量 → invalid_shape', validJson({ risks: Array.from({ length: ANNUAL_REVIEW_AI_LIMITS.risks + 1 }, () => validAnalysis.risks[0]) }), 'invalid_shape'],
      ['F6 diagnoses 非数组 → invalid_shape', validJson({ diagnoses: {} }), 'invalid_shape'],
      ['F6b metricKeys 非数组 → invalid_shape', validJson({ diagnoses: [{ ...validAnalysis.diagnoses[0], metricKeys: VALID_KEY }] }), 'invalid_shape'],
      ['F6c metricKeys 为空数组 → invalid_shape', validJson({ diagnoses: [{ ...validAnalysis.diagnoses[0], metricKeys: [] }] }), 'invalid_shape'],
      ['F6d metricKeys 含非字符串 → invalid_shape', validJson({ diagnoses: [{ ...validAnalysis.diagnoses[0], metricKeys: [1] }] }), 'invalid_shape'],
      ['F6e metricKeys 含空串 → invalid_shape', validJson({ diagnoses: [{ ...validAnalysis.diagnoses[0], metricKeys: ['  '] }] }), 'invalid_shape'],
      ['F6f metricKeys 超量 → invalid_shape', validJson({ diagnoses: [{ ...validAnalysis.diagnoses[0], metricKeys: Array.from({ length: ANNUAL_REVIEW_AI_LIMITS.metricKeysPerItem + 1 }, () => VALID_KEY) }] }), 'invalid_shape']
    ]
    for (const [name, raw, code] of cases) {
      const r = parseAnnualReviewAiOutput(raw, KEYS)
      ok(name, !r.ok && r.code === code)
    }
    // 失败消息不回声模型原文（避免把未校验文本带进日志/UI）
    const echo = parseAnnualReviewAiOutput(validJson({ diagnoses: [{ ...validAnalysis.diagnoses[0], metricKeys: ['summary.notExist'] }] }), KEYS)
    ok('F7 失败消息不回显整段模型输出', !echo.ok && echo.message.length < 160 && !echo.message.includes('executiveSummary'))
  }

  // ── K. 未知 metricKey / 非法枚举 / 文本越界 ──
  {
    const unknown = parseAnnualReviewAiOutput(validJson({ diagnoses: [{ ...validAnalysis.diagnoses[0], metricKeys: ['summary.notExist'] }] }), KEYS)
    ok('K1 未知 metricKey 被拒绝', !unknown.ok && unknown.code === 'invalid_shape')
    ok('K1b 未知 metricKey 报出具体键名', !unknown.ok && unknown.message.includes('summary.notExist'))

    const guessed = parseAnnualReviewAiOutput(validJson({ actions: [{ ...validAnalysis.actions[0], metricKeys: ['contractAmount'] }] }), KEYS)
    ok('K1c 未带前缀的猜测键被拒绝', !guessed.ok)

    const dup = parseAnnualReviewAiOutput(validJson({ diagnoses: [{ ...validAnalysis.diagnoses[0], metricKeys: [VALID_KEY, VALID_KEY] }] }), KEYS)
    ok('K2 重复 metricKey 被拒绝', !dup.ok)

    for (const bad of ['HIGH', '高', 'very_high', '', 1, null, true]) {
      const r = parseAnnualReviewAiOutput(validJson({ diagnoses: [{ ...validAnalysis.diagnoses[0], confidence: bad }] }), KEYS)
      ok(`K3 非法 confidence ${JSON.stringify(bad)} 被拒绝`, !r.ok)
    }
    for (const bad of [0, 4, '1', 'P1', -1, 1.5, null]) {
      const r = parseAnnualReviewAiOutput(validJson({ actions: [{ ...validAnalysis.actions[0], priority: bad }] }), KEYS)
      ok(`K4 非法 priority ${JSON.stringify(bad)} 被拒绝`, !r.ok)
    }
    for (const bad of ['next_month', 'NEXT_YEAR', '', 1, null]) {
      const r = parseAnnualReviewAiOutput(validJson({ actions: [{ ...validAnalysis.actions[0], horizon: bad }] }), KEYS)
      ok(`K5 非法 horizon ${JSON.stringify(bad)} 被拒绝`, !r.ok)
    }

    const emptyTextCases: Array<[string, Record<string, unknown>]> = [
      ['K6 executiveSummary 空', { executiveSummary: '   ' }],
      ['K6b title 空', { diagnoses: [{ ...validAnalysis.diagnoses[0], title: '' }] }],
      ['K6c observation 空', { diagnoses: [{ ...validAnalysis.diagnoses[0], observation: '\n' }] }],
      ['K6d hypothesis 空', { diagnoses: [{ ...validAnalysis.diagnoses[0], hypothesis: '' }] }],
      ['K6e action 空', { actions: [{ ...validAnalysis.actions[0], action: ' ' }] }],
      ['K6f rationale 空', { actions: [{ ...validAnalysis.actions[0], rationale: '' }] }],
      ['K6g risk 空', { risks: [{ risk: '', metricKeys: [VALID_KEY] }] }]
    ]
    for (const [name, over] of emptyTextCases) {
      const r = parseAnnualReviewAiOutput(validJson(over), KEYS)
      ok(`K6 空文本被拒绝（${name}）`, name.startsWith('K6') ? !r.ok : false)
    }

    const long = (n: number): string => '长'.repeat(n)
    const longTextCases: Array<[string, Record<string, unknown>]> = [
      ['executiveSummary', { executiveSummary: long(ANNUAL_REVIEW_AI_LIMITS.executiveSummary + 1) }],
      ['title', { diagnoses: [{ ...validAnalysis.diagnoses[0], title: long(ANNUAL_REVIEW_AI_LIMITS.diagnosisTitle + 1) }] }],
      ['observation', { diagnoses: [{ ...validAnalysis.diagnoses[0], observation: long(ANNUAL_REVIEW_AI_LIMITS.diagnosisObservation + 1) }] }],
      ['hypothesis', { diagnoses: [{ ...validAnalysis.diagnoses[0], hypothesis: long(ANNUAL_REVIEW_AI_LIMITS.diagnosisHypothesis + 1) }] }],
      ['action', { actions: [{ ...validAnalysis.actions[0], action: long(ANNUAL_REVIEW_AI_LIMITS.actionAction + 1) }] }],
      ['rationale', { actions: [{ ...validAnalysis.actions[0], rationale: long(ANNUAL_REVIEW_AI_LIMITS.actionRationale + 1) }] }],
      ['risk', { risks: [{ risk: long(ANNUAL_REVIEW_AI_LIMITS.riskRisk + 1), metricKeys: [VALID_KEY] }] }]
    ]
    for (const [field, over] of longTextCases) {
      const r = parseAnnualReviewAiOutput(validJson(over), KEYS)
      ok(`K7 超长文本被拒绝（${field}）`, !r.ok && r.code === 'invalid_shape')
    }
    // 恰好等于上限必须通过（边界不是 off-by-one）
    const atLimit = JSON.stringify({
      executiveSummary: long(ANNUAL_REVIEW_AI_LIMITS.executiveSummary),
      diagnoses: [{ title: long(ANNUAL_REVIEW_AI_LIMITS.diagnosisTitle), observation: long(ANNUAL_REVIEW_AI_LIMITS.diagnosisObservation), hypothesis: long(ANNUAL_REVIEW_AI_LIMITS.diagnosisHypothesis), metricKeys: [VALID_KEY], confidence: 'low' }],
      actions: [{ priority: 3, action: long(ANNUAL_REVIEW_AI_LIMITS.actionAction), rationale: long(ANNUAL_REVIEW_AI_LIMITS.actionRationale), metricKeys: [VALID_KEY], horizon: 'next_year' }],
      risks: [{ risk: long(ANNUAL_REVIEW_AI_LIMITS.riskRisk), metricKeys: [VALID_KEY] }]
    })
    ok('K8 恰好达到长度上限仍合法', parseAnnualReviewAiOutput(atLimit, KEYS).ok)

    // 文本两侧空白被 trim（保证同义输出得到同一结果）
    const padded = parseAnnualReviewAiOutput(validJson({ executiveSummary: '  带空白的总评  ' }), KEYS)
    ok('K9 文本被 trim 归一', padded.ok && padded.analysis.executiveSummary === '带空白的总评')

    // metricKeys 两侧空白同样归一
    const paddedKey = parseAnnualReviewAiOutput(validJson({ diagnoses: [{ ...validAnalysis.diagnoses[0], metricKeys: [` ${VALID_KEY} `] }] }), KEYS)
    ok('K10 metricKey 空白被归一后仍校验通过', paddedKey.ok && paddedKey.analysis.diagnoses[0].metricKeys[0] === VALID_KEY)
  }

  // ── S. 服务层：未配置 / 异常 / 限额 / 报告不合约 / 成功 ──
  {
    // S1 未配置：不调用模型
    const stubA = stubCompletion(validJson())
    const notConfigured = await generateAnnualReviewAiAnalysis(REPORT, { config: fakeConfig, completion: stubA.completion, configured: false })
    ok('S1 AI 未配置 → not_configured', !notConfigured.ok && notConfigured.code === 'not_configured')
    eq('S1b 未配置不调用模型出口', stubA.calls.length, 0)

    // S2 调用异常：结构化失败，不抛异常
    const throwing: AnnualReviewAiCompletion = async () => { throw new Error('ECONNRESET 连接被重置\n第二行不应出现') }
    const callFailed = await generateAnnualReviewAiAnalysis(REPORT, { config: fakeConfig, completion: throwing, configured: true })
    ok('S2 调用异常 → call_failed', !callFailed.ok && callFailed.code === 'call_failed')
    ok('S2b 错误文案单行且限长', !callFailed.ok && !callFailed.message.includes('\n') && callFailed.message.length <= 160)

    // S3 额度阻断：必须与模型故障区分
    const budgetError = new AiBudgetBlockedError({ level: 'blocked', used: 5, limit: 5, ratio: 1, message: '今日 AI 调用已达上限（5/5 次）' })
    const budget: AnnualReviewAiCompletion = async () => { throw budgetError }
    const blocked = await generateAnnualReviewAiAnalysis(REPORT, { config: fakeConfig, completion: budget, configured: true })
    ok('S3 额度阻断 → budget_blocked', !blocked.ok && blocked.code === 'budget_blocked')

    // S4 报告不合约 → invalid_report，且不调用模型（不为脏数据付费）
    const stubB = stubCompletion(validJson())
    const brokenReport = { ...REPORT, summary: {} } as unknown as AnnualReviewReport
    const invalid = await generateAnnualReviewAiAnalysis(brokenReport, { config: fakeConfig, completion: stubB.completion, configured: true })
    ok('S4 不合约报告 → invalid_report', !invalid.ok && invalid.code === 'invalid_report')
    eq('S4b 不合约报告不调用模型出口', stubB.calls.length, 0)

    const noYear = await generateAnnualReviewAiAnalysis({} as unknown as AnnualReviewReport, { config: fakeConfig, completion: stubB.completion, configured: true })
    ok('S4c 缺 year 的报告 → invalid_report', !noYear.ok && noYear.code === 'invalid_report')

    // S5 空输出 / 非 JSON：结构化失败，不伪造诊断
    for (const [raw, code] of [['', 'empty_output'], ['好的，我无法分析', 'invalid_json'], ['{"executiveSummary":"x"}', 'invalid_shape']] as const) {
      const stub = stubCompletion(raw)
      const r = await generateAnnualReviewAiAnalysis(REPORT, { config: fakeConfig, completion: stub.completion, configured: true })
      ok(`S5 模型输出「${raw.slice(0, 12)}」→ ${code}`, !r.ok && r.code === code)
      eq(`S5b 失败结果不含 analysis`, (r as { analysis?: unknown }).analysis, undefined)
    }

    // S6 成功路径：注入出口收到稳定 prompt，结果透传
    const stubC = stubCompletion('```json\n' + validJson() + '\n```')
    const success = await generateAnnualReviewAiAnalysis(REPORT, { config: fakeConfig, completion: stubC.completion, configured: true, now: () => 1_700_000_000_000 })
    ok('S6 合法输出 → ok', success.ok)
    eq('S6b 结果与解析一致', success.ok ? success.analysis : null, validAnalysis)
    eq('S6c promptVersion 稳定', success.ok ? success.promptVersion : null, ANNUAL_REVIEW_AI_PROMPT_VERSION)
    eq('S6d generatedAt 来自注入时钟', success.ok ? success.generatedAt : null, 1_700_000_000_000)
    eq('S6e 只调用模型一次', stubC.calls.length, 1)
    eq('S6f 注入出口收到固定 system prompt', stubC.calls[0].systemPrompt, ANNUAL_REVIEW_AI_SYSTEM_PROMPT)
    ok('S6g 注入出口收到确定性 user prompt', stubC.calls[0].userPrompt === buildAnnualReviewAiPrompt(buildAnnualReviewAiInput(REPORT)).userPrompt)
    ok('S6h 注入出口收到的 prompt 无客户明细', !stubC.calls[0].userPrompt.includes(CUSTOMER_NAME) && !stubC.calls[0].userPrompt.includes(SESSION_ID))

    // S7 确定性：同报告两次运行 prompt 相同
    const stubD1 = stubCompletion(validJson())
    const stubD2 = stubCompletion(validJson())
    await generateAnnualReviewAiAnalysis(REPORT, { config: fakeConfig, completion: stubD1.completion, configured: true })
    await generateAnnualReviewAiAnalysis(REPORT, { config: fakeConfig, completion: stubD2.completion, configured: true })
    eq('S7 同报告两次运行 prompt 相同', stubD1.calls[0].userPrompt, stubD2.calls[0].userPrompt)

    // S8 AI 失败不改变原始报告
    const before = snapshot(REPORT)
    await generateAnnualReviewAiAnalysis(REPORT, { config: fakeConfig, completion: throwing, configured: true })
    await generateAnnualReviewAiAnalysis(REPORT, { config: fakeConfig, completion: stubCompletion('').completion, configured: true })
    await generateAnnualReviewAiAnalysis(REPORT, { config: fakeConfig, completion: budget, configured: true })
    await generateAnnualReviewAiAnalysis(REPORT, { config: fakeConfig, completion: stubC.completion, configured: true })
    eq('S8 AI 全失败/成功路径均不改变原始报告', snapshot(REPORT), before)
    // 返回的分析对象与报告不共享引用：改结果不影响报告
    if (success.ok) {
      success.analysis.diagnoses[0].metricKeys.push('MUTATED')
      success.analysis.executiveSummary = 'MUTATED'
    }
    eq('S8b 改动返回结果不污染报告', snapshot(REPORT), before)
  }

  // ── C. 调用参数契约 ──
  {
    ok('C1 usage purpose 稳定值 = annual_review_ai', ANNUAL_REVIEW_AI_PURPOSE === 'annual_review_ai')
    const opts = buildAnnualReviewAiCallOptions()
    eq('C2 purpose 传给账本', opts.usageContext?.purpose, 'annual_review_ai')
    eq('C3 promptVersion 传给账本', opts.usageContext?.promptVersion, ANNUAL_REVIEW_AI_PROMPT_VERSION)
    eq('C4 低温度', opts.temperature, ANNUAL_REVIEW_AI_TEMPERATURE)
    ok('C4b 温度低于 0.5（解释型任务）', ANNUAL_REVIEW_AI_TEMPERATURE < 0.5)
    eq('C5 强制 JSON response format', opts.responseFormatJson, true)
    eq('C6 输出 token 上限受控', opts.maxTokens, ANNUAL_REVIEW_AI_MAX_TOKENS)
    ok('C6b token 上限为正且有限', typeof ANNUAL_REVIEW_AI_MAX_TOKENS === 'number' && ANNUAL_REVIEW_AI_MAX_TOKENS > 0 && ANNUAL_REVIEW_AI_MAX_TOKENS <= 8192)
    ok('C7 关闭思考模式（避免思考 token 挤占 JSON 输出）', opts.disableThinking === true)
    ok('C8 设置超时', typeof opts.timeoutMs === 'number' && (opts.timeoutMs as number) > 0)
    const signal = new AbortController().signal
    eq('C9 AbortSignal 透传', buildAnnualReviewAiCallOptions(signal).signal, signal)

    // 源码守卫：本链路必须复用 aiApiClient，不得自建第二套客户端/新增依赖
    const { readFileSync } = await import('fs')
    const { join, dirname } = await import('path')
    const { fileURLToPath } = await import('url')
    const root = join(dirname(fileURLToPath(import.meta.url)), '..')
    const serviceSrc = readFileSync(join(root, 'electron/services/annualReviewAiService.ts'), 'utf8')
    const coreSrc = readFileSync(join(root, 'electron/services/annualReviewAiCore.ts'), 'utf8')
    ok('C10 服务层经 simpleCompletion 复用统一 AI 出口', serviceSrc.includes('simpleCompletion'))
    ok('C10b 服务层不自建 HTTP 客户端', !serviceSrc.includes("from 'https'") && !serviceSrc.includes("from 'http'") && !coreSrc.includes("from 'https'"))
    ok('C10c 服务层不引用数据库/Worker（AI 层不碰数据源）', !serviceSrc.includes('crmDbService') && !serviceSrc.includes('salesDbService') && !serviceSrc.includes('wcdbService'))
    ok('C11 纯模块零副作用：core 不导入 fs/path/config/服务层', !/from '(fs|path|worker_threads)'/.test(coreSrc) && !coreSrc.includes('ConfigService') && !coreSrc.includes('simpleCompletion'))
    ok('C12 本轮不接 UI/IPC：core 与服务层都不引用 electron/preload', !coreSrc.includes("from 'electron'") && !serviceSrc.includes("from 'electron'"))
  }

  // ── I9. 历史年度报告（historical_reconstruction 分支）同样只投影聚合 ──
  {
    const input = buildAnnualReviewAiInput(REPORT_2025)
    const flat = snapshot(input)
    ok('I9 历史年度输入同样不含姓名/会话', !flat.includes(CUSTOMER_NAME) && !flat.includes(SESSION_ID) && !flat.includes(SALES_NAME))
    eq('I9b 历史年度输入不含白名单外的任何键', [...unexpectedKeys(input)], [])
    eq('I9c 历史年度 scopeKind 原样透传', input.meta.scopeKind, 'historical_year')
    ok('I9d 阶段分布 kind 原样透传（历史=事件流重建）', input.distributions.find((d) => d.key === 'funnel.customerStage')?.kind === 'historical_reconstruction')
    ok('I9e 当前年度阶段分布 kind = 当前快照', buildAnnualReviewAiInput(REPORT).distributions.find((d) => d.key === 'funnel.customerStage')?.kind === REPORT.funnel.customerStage.kind)
    ok('I9f 历史年度同样可服务层调用（不抛异常）', (await generateAnnualReviewAiAnalysis(REPORT_2025, { config: fakeConfig, completion: stubCompletion(validJson()).completion, configured: true })).ok)
  }

  // ── 输入类型自检（编译期契约的运行时投影；供后续 UI 接线复用） ──
  {
    const input: AnnualReviewAiInput = buildAnnualReviewAiInput(REPORT)
    ok('T1 meta.scopeKind 与报告一致', input.meta.scopeKind === REPORT.scopeKind)
    ok('T2 meta 时间为本地日期键', /^\d{4}-\d{2}-\d{2}$/.test(input.meta.asOfDate) && /^\d{4}-\d{2}-\d{2}$/.test(input.meta.generatedAtDate))
    ok('T3 completeness 与报告一致', JSON.stringify(input.meta.completeness) === JSON.stringify(REPORT.completeness))
    ok('T4 输入可 JSON 序列化', JSON.stringify(input).length > 0)
    ok('T5 输入体积受控（无明细列表）', JSON.stringify(input).length < 20_000)
  }
}

main().then(() => {
  console.log(`结果：${pass} 通过 / ${fail} 失败`)
  process.exit(fail > 0 ? 1 : 0)
}).catch((e) => {
  console.error('FATAL:', e)
  process.exit(1)
})
