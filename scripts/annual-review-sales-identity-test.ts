/**
 * annual-review-sales-identity-test.ts —— 年度经营复盘 公开报告销售身份数据边界护栏
 *
 * 背景（UI 验收 P1）：allocation 表认领销售列、审计 detail 销售署名、account 归属销售
 * 等销售身份字段可能是 wxid_* 原文，曾直接写入公开报告 → 页面、Markdown、CSV、AI 输入
 * 全部泄漏。修复 = 主进程在报告进入缓存/IPC 之前统一掩蔽（复用既有 wcdb 显示名映射，
 * 失败回退稳定展示标签），运行时 validator 用同一谓词拒绝残留原文。
 *
 * 覆盖：
 *  0  夹具有效性：五类字段的原文确实进入组装报告（修复前的泄漏形态）
 *  1  五类销售身份字段分别注入真实形态 wxid_*（互不相同，非单一探针）→ 掩蔽后递归扫描
 *     五个公开面（报告对象 / 页面视图渲染串 / Markdown / CSV / AI 输入与 prompt）均不含
 *     任何原值；真实姓名原样保留；显示名解析可用 → 用显示名；解析结果自身是 ID 形态 →
 *     按未解析处理；回退标签稳定、不同销售绝不合并
 *  2  计数口径与结构不受掩蔽影响；同输入同输出；不修改输入对象
 *  3  回退标签避让真实姓名（恰名「销售 1」时跳号）
 *  4  validator：掩蔽后通过；未掩蔽拒绝；逐字段类注入残留原文 → 一律 fail closed
 *  5  服务层端到端：Worker 结果带原文 → 掩蔽后才入缓存；解析 dep 抛错 → 仍掩蔽；
 *     未注入解析 dep → 回退标签
 *  6  main.ts 接线守卫（resolveSalesDisplayNames 复用 wcdb 显示名映射）
 *  C  同名昵称碰撞与消歧：不同 wxid 同昵称 → 稳定后缀可区分；撞真实名 → 真实名不变
 *     ID 加后缀；「销售 1」昵称与真实名/回退形态不混淆；顺序无关；五类字段可区分、
 *     计数金额不变；MD/CSV 可区分且无原文；页面 React key 防重复
 * 运行：npx tsx scripts/annual-review-sales-identity-test.ts
 */
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import {
  resolveAnnualReviewPeriod,
  type AnnualReviewFacts,
  type AnnualReviewMessageStats
} from '../electron/services/annualReviewStats'
import type { AnnualReviewSalesSegmentsFacts, AnnualReviewCrmSegmentsFacts } from '../electron/services/annualReviewSegments'
import {
  applyAnnualReviewSalesIdentityLabels,
  buildAnnualReviewSalesIdentityLabels,
  collectAnnualReviewSalesIdentityValues,
  composeAnnualReviewReport,
  validateAnnualReviewReport,
  type AnnualReviewReport
} from '../electron/services/annualReviewReport'
import {
  AnnualReviewService,
  type AnnualReviewAccountContext,
  type AnnualReviewWorkerPayload,
  type AnnualReviewWorkerRunner
} from '../electron/services/annualReviewService'
import { buildAnnualReviewMarkdown, buildAnnualReviewCsv } from '../electron/services/annualReviewExportContent'
import { buildAnnualReviewAiInput, buildAnnualReviewAiPrompt } from '../electron/services/annualReviewAiCore'
import { isRawWechatAccountId } from '../shared/wechatId'

let pass = 0, fail = 0
function ok(name: string, cond: boolean): void {
  if (cond) { pass++ } else { fail++; console.error('FAIL:', name) }
}
const tick = (): Promise<void> => new Promise((r) => setImmediate(r))

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const T = (y: number, m: number, d: number, hh = 0, mm = 0, ss = 0, ms = 0): number =>
  new Date(y, m - 1, d, hh, mm, ss, ms).getTime()
const GEN = T(2026, 6, 15, 12, 0, 0)
const YEAR = 2025

// ── 注入夹具：五类销售身份字段各用互不相同的真实形态 wxid_*（不是单一探针） ──
const WX_ASSIGN = 'wxid_wen24wq8ojio22_92a6' // E1 初始分配（审计 detail 销售署名）
const WX_TO = 'wxid_1lbiz4e2fzwwl'           // E1 移交转入（detail.toSales）
const WX_FROM = 'wxid_14zh58a1akgt75'        // E1 移交转出（detail.fromSales）
const WX_OWNER = 'wxid_own9k8j7h6g5f4d3'     // E4 合同贡献（account 归属销售）
const WX_CLAIM = 'wxid_cl4im9z8y7x6w5e'      // E5 核销贡献（allocation 认领销售）
const NAME_REAL = '王五'                      // 真实姓名：不得被掩蔽
const RAW_IDS = [WX_ASSIGN, WX_TO, WX_FROM, WX_OWNER, WX_CLAIM]

const sales: AnnualReviewSalesSegmentsFacts = { profiles: [], intentEvents: [] }
const crm: AnnualReviewCrmSegmentsFacts = { opportunities: [], opportunityEvents: [] }

const facts: AnnualReviewFacts = {
  accounts: [
    { id: 1, name: '客户A', createdAt: T(2025, 2, 1), importedAt: null, sessionId: 'wxid_cust_aaa', lastContactAtSec: null, ownerSales: WX_OWNER },
    { id: 2, name: '客户B', createdAt: T(2025, 3, 1), importedAt: null, sessionId: 'wxid_cust_bbb', lastContactAtSec: null, ownerSales: NAME_REAL }
  ],
  contracts: [
    { id: 1, accountId: 1, amount: 1200, status: 'signed', signDate: T(2025, 5, 1), createdAt: T(2024, 1, 1) },
    { id: 2, accountId: 2, amount: 500, status: 'signed', signDate: T(2025, 6, 1), createdAt: T(2024, 1, 1) }
  ],
  allocations: [
    { id: 1, accountId: 1, creditedAmount: 800, reconciledAt: T(2025, 7, 1), status: 'confirmed', reconciliationStatus: 'allocated', confirmedAt: null, contractId: 1, salesName: WX_CLAIM },
    { id: 2, accountId: 2, creditedAmount: 300, reconciledAt: T(2025, 8, 1), status: 'confirmed', reconciliationStatus: 'allocated', confirmedAt: null, contractId: 2, salesName: NAME_REAL }
  ],
  shippedEvents: [],
  assignments: [],
  leads: [],
  auditEvents: [
    { id: 1, action: 'lead_assign', createdAt: T(2025, 4, 1), detailType: null, salesName: WX_ASSIGN, toSales: null, fromSales: null, mode: 'manual', assignmentId: 1 },
    { id: 2, action: 'lead_assign', createdAt: T(2025, 4, 2), detailType: null, salesName: NAME_REAL, toSales: null, fromSales: null, mode: 'round_robin', assignmentId: 2 },
    { id: 3, action: 'lead_transfer', createdAt: T(2025, 4, 3), detailType: null, salesName: null, toSales: WX_TO, fromSales: null, mode: null, assignmentId: 3 },
    { id: 4, action: 'lead_transfer', createdAt: T(2025, 4, 4), detailType: null, salesName: null, toSales: null, fromSales: WX_FROM, mode: null, assignmentId: 4 }
  ]
}

function composeRaw(): AnnualReviewReport {
  return composeAnnualReviewReport({ period: resolveAnnualReviewPeriod(YEAR, GEN), facts, sales, crm })
}

/** 递归扫描：整棵对象树文本化后逐个原值检查（五个互不相同的真实形态，非单一探针） */
function containsNone(text: string, label: string): void {
  for (const raw of RAW_IDS) ok(`${label} 不含原值 ${raw}`, !text.includes(raw))
}

async function main(): Promise<void> {
  const rawReport = composeRaw()

  // ── 0 夹具有效性 ──
  const collected = collectAnnualReviewSalesIdentityValues(rawReport)
  for (const raw of RAW_IDS) ok(`0 夹具原文进入报告 ${raw}`, collected.includes(raw))
  ok('0b 收集去重（真实姓名跨字段只出现一次）', collected.filter((v) => v === NAME_REAL).length === 1)
  ok('0c 收集含真实姓名（其不属于掩蔽对象）', collected.includes(NAME_REAL))

  // ── 1 掩蔽主链路 ──
  const resolved = new Map<string, string | null>([
    [WX_CLAIM, '钱七'],
    [WX_OWNER, 'wxid_fake_resolved'] // 解析结果自身是 ID 形态 → 必须按未解析处理
  ])
  const labels = buildAnnualReviewSalesIdentityLabels(collected, resolved)
  ok('1a 解析到显示名 → 用显示名', labels.get(WX_CLAIM) === '钱七')
  ok('1b 解析结果是 ID 形态 → 按未解析回退（不把 ID 换成另一个 ID）',
    labels.get(WX_OWNER) !== 'wxid_fake_resolved' && !isRawWechatAccountId(labels.get(WX_OWNER)))
  ok('1c 真实姓名原样保留', labels.get(NAME_REAL) === NAME_REAL)
  const fallbackLabels = RAW_IDS.filter((raw) => raw !== WX_CLAIM).map((raw) => labels.get(raw) ?? '')
  ok('1d 回退标签均为稳定「销售 N」形态', fallbackLabels.every((v) => /^销售 [0-9]+$/.test(v)))
  ok('1e 不同销售绝不合并（回退标签两两不同）', new Set(fallbackLabels).size === fallbackLabels.length)
  ok('1f 显示名与回退标签不冲突', new Set([...fallbackLabels, labels.get(WX_CLAIM) ?? '']).size === fallbackLabels.length + 1)

  const before = JSON.stringify(rawReport)
  const masked = applyAnnualReviewSalesIdentityLabels(rawReport, labels)
  ok('1g 不修改输入对象', JSON.stringify(rawReport) === before)

  // ── 2 五个公开面递归扫描：报告对象 / 页面视图 / Markdown / CSV / AI 输入 ──
  containsNone(JSON.stringify(masked), '2 报告对象')

  // 页面视图：与 AnnualReviewPage「销售与分配」区块同构的渲染串（含页面兜底文案）
  const pageView = [
    masked.salesAssignment.assignedFacts.initialAssignments.groups.map(({ salesName }) => salesName ?? '未署名').join('，'),
    masked.salesAssignment.assignedFacts.transfersIn.groups.map(({ salesName }) => salesName ?? '未署名').join('，'),
    masked.salesAssignment.assignedFacts.transfersOut.groups.map(({ salesName }) => salesName ?? '未署名').join('，'),
    (masked.salesAssignment.contractContribution.value ?? []).map(({ ownerSales }) => ownerSales ?? '未归属').join('，'),
    (masked.salesAssignment.creditedContribution.value ?? []).map(({ salesName }) => salesName ?? '未认领').join('，')
  ].join('，')
  containsNone(pageView, '2b 页面视图')
  ok('2b1 页面视图保留真实姓名与显示名', pageView.includes(NAME_REAL) && pageView.includes('钱七'))

  const markdown = buildAnnualReviewMarkdown(masked)
  containsNone(markdown, '2c Markdown')
  const csv = buildAnnualReviewCsv(masked)
  containsNone(csv, '2d CSV')

  const aiInput = buildAnnualReviewAiInput(masked)
  ok('2e 掩蔽后报告通过 AI 输入契约校验', aiInput.ok === true)
  if (aiInput.ok) {
    containsNone(JSON.stringify(aiInput.input), '2e1 AI 输入')
    containsNone(buildAnnualReviewAiPrompt(aiInput.input).userPrompt, '2e2 AI prompt')
  }

  // ── 3 计数口径与结构不受掩蔽影响 ──
  ok('3 分组数与 total 不变', masked.salesAssignment.assignedFacts.initialAssignments.total === rawReport.salesAssignment.assignedFacts.initialAssignments.total &&
    masked.salesAssignment.assignedFacts.transfersIn.groups.length === rawReport.salesAssignment.assignedFacts.transfersIn.groups.length &&
    masked.salesAssignment.assignedFacts.transfersOut.groups.length === rawReport.salesAssignment.assignedFacts.transfersOut.groups.length)
  const creditedSeven = (masked.salesAssignment.creditedContribution.value ?? []).find(({ salesName }) => salesName === '钱七')
  const creditedReal = (masked.salesAssignment.creditedContribution.value ?? []).find(({ salesName }) => salesName === NAME_REAL)
  ok('3b 贡献金额随身份保留（钱七=800 / 王五=300）', creditedSeven?.totalAmount === 800 && creditedReal?.totalAmount === 300)

  // ── 4 确定性：同输入同输出 ──
  const labelsAgain = buildAnnualReviewSalesIdentityLabels(collectAnnualReviewSalesIdentityValues(rawReport), resolved)
  const maskedAgain = applyAnnualReviewSalesIdentityLabels(rawReport, labelsAgain)
  ok('4 同输入同输出', JSON.stringify(maskedAgain) === JSON.stringify(masked))

  // ── 5 回退标签避让真实姓名（真实销售恰名「销售 1」「销售 2」时不合并） ──
  const colliding = buildAnnualReviewSalesIdentityLabels([WX_ASSIGN, '销售 1', '销售 2'], new Map())
  ok('5 回退标签跳过已占用标签（分配到「销售 3」）', colliding.get(WX_ASSIGN) === '销售 3' &&
    colliding.get('销售 1') === '销售 1' && colliding.get('销售 2') === '销售 2')

  // ── 6 validator：掩蔽后通过；残留原文（逐字段类注入）一律拒绝 ──
  ok('6a 掩蔽后报告通过运行时校验', validateAnnualReviewReport(masked, YEAR).ok === true)
  ok('6b 未掩蔽报告被运行时校验拒绝（修复前泄漏形态 fail closed）',
    validateAnnualReviewReport(rawReport, YEAR).ok === false)
  const clone = (r: AnnualReviewReport): AnnualReviewReport => JSON.parse(JSON.stringify(r)) as AnnualReviewReport
  const injectOne = (name: string, inject: (r: AnnualReviewReport) => void): void => {
    const bad = clone(masked)
    inject(bad)
    ok(`6c 残留原文拒绝：${name}`, validateAnnualReviewReport(bad, YEAR).ok === false)
  }
  injectOne('初始分配', (r) => {
    const row = r.salesAssignment.assignedFacts.initialAssignments.groups.find(({ mode }) => mode === 'manual')
    if (row) row.salesName = WX_ASSIGN
  })
  injectOne('移交转入', (r) => {
    const row = r.salesAssignment.assignedFacts.transfersIn.groups[0]
    if (row) row.salesName = WX_TO
  })
  injectOne('移交转出', (r) => {
    const row = r.salesAssignment.assignedFacts.transfersOut.groups[0]
    if (row) row.salesName = WX_FROM
  })
  injectOne('合同贡献', (r) => {
    const row = (r.salesAssignment.contractContribution.value ?? []).find(({ ownerSales }) => ownerSales !== NAME_REAL)
    if (row) row.ownerSales = WX_OWNER
  })
  injectOne('核销贡献', (r) => {
    const row = (r.salesAssignment.creditedContribution.value ?? []).find(({ salesName }) => salesName !== NAME_REAL)
    if (row) row.salesName = WX_CLAIM
  })

  // ── 7 服务层端到端：Worker 结果带原文 → 掩蔽后才入缓存 ──
  const baseCtx: AnnualReviewAccountContext = {
    wxid: 'wx_account_a',
    salesDbName: 'weflow-sales-wx_account_a.db',
    crmDbName: 'weflow-crm-wx_account_a.db',
    exclusions: {}
  }
  const runService = async (resolver?: (rawValues: string[]) => Promise<Map<string, string | null>>):
    Promise<{ success: boolean; got: ReturnType<AnnualReviewService['getReport']> }> => {
    const raw = composeRaw()
    const calls: Array<{ payload: AnnualReviewWorkerPayload; resolve: (r: AnnualReviewReport) => void }> = []
    const runner: AnnualReviewWorkerRunner = {
      run(payload) {
        return new Promise<AnnualReviewReport>((resolve) => {
          calls.push({ payload, resolve })
        })
      }
    }
    const service = new AnnualReviewService({
      loadFacts: async () => facts,
      loadSalesSegments: async () => sales,
      loadCrmSegments: async () => crm,
      loadMessageStats: async (): Promise<AnnualReviewMessageStats> => ({ ok: false, sessions: {} }),
      getAccountContext: () => baseCtx,
      runner,
      ...(resolver ? { resolveSalesDisplayNames: resolver } : {})
    })
    const gen = service.generate(YEAR)
    await tick()
    calls[0].resolve(raw)
    const result = await gen
    return { success: result.success, got: service.getReport(YEAR) }
  }

  const seenResolverArgs: string[][] = []
  const r1 = await runService(async (rawValues) => {
    seenResolverArgs.push([...rawValues])
    return new Map<string, string | null>([[WX_CLAIM, '钱七']])
  })
  ok('7 生成成功且缓存命中（掩蔽后通过 validator 才能入缓存）', r1.success && r1.got.cache === 'hit')
  if (r1.got.report) {
    containsNone(JSON.stringify(r1.got.report), '7b 缓存报告')
    ok('7c 解析dep 收到全部身份原文（含真实姓名）',
      RAW_IDS.every((raw) => seenResolverArgs[0].includes(raw)) && seenResolverArgs[0].includes(NAME_REAL))
    ok('7d 显示名进入缓存报告', JSON.stringify(r1.got.report).includes('钱七'))
  }
  const r2 = await runService(async () => { throw new Error('wcdb down') })
  containsNone(r2.got.report ? JSON.stringify(r2.got.report) : '', '7e 解析dep 抛错 → 仍全量掩蔽')
  ok('7e1 抛错路径下报告仍正常入缓存', r2.success && r2.got.cache === 'hit' && r2.got.report !== undefined)
  const r3 = await runService()
  const r3FirstClaim = (r3.got.report?.salesAssignment.creditedContribution.value ?? [])[0]
  ok('7f 未注入解析 dep → 回退稳定标签', r3.got.report !== undefined && /^销售 [0-9]+$/.test(r3FirstClaim?.salesName ?? ''))

  // ── 8 main.ts 接线守卫 ──
  const mainSrc = readFileSync(join(ROOT, 'electron', 'main.ts'), 'utf8')
  ok('8 main.ts 注入 resolveSalesDisplayNames（复用 wcdb 显示名映射）',
    mainSrc.includes('resolveSalesDisplayNames') && mainSrc.includes('getDisplayNames') &&
    mainSrc.includes('isRawWechatAccountId') && mainSrc.includes('isSessionIdLike(real)'))

  // ══ C 同名昵称碰撞与消歧（0fe4447 上为失败反例） ══════════════════════════
  {
    const WX_NA = 'wxid_na10a9b8c7d6e5'
    const WX_NB = 'wxid_nb20f9e8d7c6b5'
    const WX_NC = 'wxid_nc30a1b2c3d4e5'
    const WX_NF = 'wxid_nf40z9y8x7w6v5'
    const collideResolved = new Map<string, string | null>([[WX_NA, '小王'], [WX_NB, '小王']])

    // C1 两个不同 wxid 解析出相同昵称 → 稳定消歧为可区分标签
    const l1 = buildAnnualReviewSalesIdentityLabels([WX_NA, WX_NB], collideResolved)
    ok('C1 同名昵称消歧为带序号的可区分标签',
      l1.get(WX_NA) === '小王（销售 1）' && l1.get(WX_NB) === '小王（销售 2）')
    ok('C1b 消歧标签不含原文且不合并',
      !(l1.get(WX_NA) ?? '').includes(WX_NA) && !(l1.get(WX_NB) ?? '').includes(WX_NB) &&
      l1.get(WX_NA) !== l1.get(WX_NB))

    // C2 解析昵称与已有真实销售名相同：真实名保持原文，ID 标签加稳定后缀
    const l2 = buildAnnualReviewSalesIdentityLabels([WX_NC, NAME_REAL], new Map<string, string | null>([[WX_NC, NAME_REAL]]))
    ok('C2 真实销售名保持原文不被改写', l2.get(NAME_REAL) === NAME_REAL)
    ok('C2b 撞真实名的 ID 标签加稳定后缀（不与真实名同名）',
      l2.get(WX_NC) !== NAME_REAL && l2.get(WX_NC) === NAME_REAL + '（销售 1）')

    // C3 解析昵称恰好为「销售 1」且真实销售名也叫「销售 1」：两者可区分
    const l3 = buildAnnualReviewSalesIdentityLabels([WX_NF, '销售 1'], new Map<string, string | null>([[WX_NF, '销售 1']]))
    ok('C3 真实名「销售 1」原文保留', l3.get('销售 1') === '销售 1')
    ok('C3b ID 的「销售 1」昵称不与真实名/回退形态混淆',
      l3.get(WX_NF) !== '销售 1' && (l3.get(WX_NF) ?? '').startsWith('销售 1（销售'))

    // C4 输入顺序颠倒（未排序输入）后映射结果完全一致
    const fwd = buildAnnualReviewSalesIdentityLabels([WX_NA, WX_NB], collideResolved)
    const rev = buildAnnualReviewSalesIdentityLabels([WX_NB, WX_NA], collideResolved)
    ok('C4 输入顺序颠倒后映射完全一致（按 raw ID 稳定排序）',
      JSON.stringify([...fwd.entries()].sort()) === JSON.stringify([...rev.entries()].sort()))

    // C5 端到端：两个同名 wxid 各有核销贡献与初始分配 → 五类字段仍可区分、计数金额不变
    const collideFacts: AnnualReviewFacts = {
      accounts: [
        { id: 21, name: '碰撞客户A', createdAt: T(2025, 2, 1), importedAt: null, sessionId: 'wxid_collide_aaa', lastContactAtSec: null },
        { id: 22, name: '碰撞客户B', createdAt: T(2025, 3, 1), importedAt: null, sessionId: 'wxid_collide_bbb', lastContactAtSec: null }
      ],
      contracts: [],
      allocations: [
        { id: 21, accountId: 21, creditedAmount: 800, reconciledAt: T(2025, 7, 1), status: 'confirmed', reconciliationStatus: 'allocated', confirmedAt: null, contractId: null, salesName: WX_NA },
        { id: 22, accountId: 22, creditedAmount: 300, reconciledAt: T(2025, 8, 1), status: 'confirmed', reconciliationStatus: 'allocated', confirmedAt: null, contractId: null, salesName: WX_NB }
      ],
      shippedEvents: [],
      assignments: [],
      leads: [],
      auditEvents: [
        { id: 21, action: 'lead_assign', createdAt: T(2025, 4, 1), detailType: null, salesName: WX_NA, toSales: null, fromSales: null, mode: 'manual', assignmentId: 21 },
        { id: 22, action: 'lead_assign', createdAt: T(2025, 4, 2), detailType: null, salesName: WX_NB, toSales: null, fromSales: null, mode: 'manual', assignmentId: 22 }
      ]
    }
    const raw2 = composeAnnualReviewReport({ period: resolveAnnualReviewPeriod(2025, GEN), facts: collideFacts, sales, crm })
    const values2 = collectAnnualReviewSalesIdentityValues(raw2)
    const labels2 = buildAnnualReviewSalesIdentityLabels(values2, collideResolved)
    const masked2 = applyAnnualReviewSalesIdentityLabels(raw2, labels2)
    const creditedRows = masked2.salesAssignment.creditedContribution.value ?? []
    const tag800 = (creditedRows.find(({ totalAmount }) => totalAmount === 800) ?? { salesName: null }).salesName ?? ''
    const tag300 = (creditedRows.find(({ totalAmount }) => totalAmount === 300) ?? { salesName: null }).salesName ?? ''
    ok('C5 两个同名销售的贡献行标签可区分（金额不合并）',
      tag800 === '小王（销售 1）' && tag300 === '小王（销售 2）' && tag800 !== tag300)
    const iaTags = masked2.salesAssignment.assignedFacts.initialAssignments.groups.map(({ salesName }) => salesName ?? '')
    ok('C5b 同一 raw ID 在初始分配与核销贡献中同标签（跨字段一致）',
      iaTags.includes(labels2.get(WX_NA) ?? '') && iaTags.includes(labels2.get(WX_NB) ?? '') &&
      labels2.get(WX_NA) === tag800 && labels2.get(WX_NB) === tag300)
    ok('C5c 分组数与 total 不变',
      masked2.salesAssignment.assignedFacts.initialAssignments.total === raw2.salesAssignment.assignedFacts.initialAssignments.total &&
      masked2.salesAssignment.assignedFacts.initialAssignments.groups.length === 2 && creditedRows.length === 2)
    ok('C5d 贡献金额总和不变', creditedRows.reduce((acc, { totalAmount }) => acc + totalAmount, 0) === 1100)
    containsNone(JSON.stringify(masked2), 'C5e 碰撞掩蔽报告')

    // C6 页面导出面：Markdown/CSV 中两个标签可区分且无原文
    const md2 = buildAnnualReviewMarkdown(masked2)
    const csv2 = buildAnnualReviewCsv(masked2)
    ok('C6 Markdown 两个消歧标签均可区分出现',
      md2.includes('小王（销售 1）') && md2.includes('小王（销售 2）'))
    ok('C6b CSV 同样可区分', csv2.includes('小王（销售 1）') && csv2.includes('小王（销售 2）'))
    ok('C6c MD/CSV 均不含原始 wxid',
      !md2.includes(WX_NA) && !md2.includes(WX_NB) && !csv2.includes(WX_NA) && !csv2.includes(WX_NB))

    // C7 页面销售区块 React key 不再仅依赖可能重复的显示名（源码守卫）
    const pageSrc = readFileSync(join(ROOT, 'src', 'pages', 'AnnualReviewPage.tsx'), 'utf8')
    ok('C7 页面三处销售列表 map 携带 index（key 防重复）',
      pageSrc.includes('initialAssignments.groups.map((g, i)') &&
      pageSrc.includes('contractContribution.value.map((row, i)') &&
      pageSrc.includes('creditedContribution.value.map((row, i)') &&
      pageSrc.includes('`cc-${i}-') && pageSrc.includes('`kc-${i}-') &&
      pageSrc.includes("-${g.mode ?? ''}-${i}"))
  }
}

main().then(() => {
  console.log(`结果：${pass} 通过 / ${fail} 失败`)
  process.exit(fail > 0 ? 1 : 0)
}).catch((e) => {
  console.error('FATAL:', e)
  process.exit(1)
})
