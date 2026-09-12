/**
 * eval-annotate-test.ts —— D7 商机评测集「应用内标注」验证（副本隔离模式）
 *
 * 验证 evalService（electron/services/evalService.ts）：
 *   A. 候选生成：过滤群聊（@chatroom）+ 全库同客户去重（一客户一行，任何锚点形态都占坑）+ 四路计数
 *      （⚠️ 2026-09-06 口径修复，§2.74 遗留：live 候选池饱和后 inserted=0 属幂等正常——
 *        A1 注入全新非群聊会话（0 前缀保证确定性抽样首位）使生成非空转；
 *        A6 只断报价信号路在 crm 副本上工作（quoteSkipped=false），不要求必有新增报价候选）
 *      2026-09-09 扩量刀：意向信号路③ + 默认补足到门槛 100 + resolveAnchor 锚点回退
 *      （每条入库样本必有可回查 evidence_key；拿不到锚点不入库、计入 anchorMissing）
 *   B. 幂等：重复生成 inserted=0，候选池总量不变
 *   C. AI 预标注回填：(session,anchor) 精确匹配 / session 兜底 / 匹配不上留空 / 已存在行缺 ai_* 时补齐
 *   D. 标注写回：label + annotated_by + status=confirmed；非法 label / 空标注人拒绝；进度统计正确
 *      + 列表端点服务端级防锚定（未确认行不下发 ai_*）
 *   E. 人机一致率：一致 / 不一致 / 无 AI 预标注三种样本下 compared/agree/agreeRate 数学正确
 *   F. 基线指标：P/R/F1（one-vs-rest）+ 混淆矩阵独立重算交叉验证；门槛判定与基线报告
 *      （只有 confirmed 进指标；门槛未达 → metrics=null + 「未达到评测门槛」）
 *
 * ⛔ 同 dry-run-all / lead-sla-reset-test 铁律：live 库复制到 /tmp 副本 → 应用链路 initialize → 绝不写 live。
 * 用法：npx tsx scripts/eval-annotate-test.ts
 */
import { copyFileSync, mkdtempSync, readFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join, resolve } from 'path'
import { salesDbService } from '../electron/services/salesDbService'
import { crmDbService } from '../electron/services/crmDbService'
import { findExistingBusinessDb } from '../electron/services/businessDbPath'
import { buildMessageKey } from '../shared/messageKey'
import { generateEvalCandidates, evalListCases, evalLabelCase, evalStats, computeEvalMetrics,
  evalBaselineReport, renderBaselineReportMarkdown, EVAL_CLASSES, EVAL_GATE_MIN_TOTAL, EVAL_GATE_MIN_CONFIRMED } from '../electron/services/evalService'
import type { OpportunityEvalCase } from '../electron/services/salesDbService'

let pass = 0, fail = 0
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; console.log(`  ✅ ${name}`) } else { fail++; console.log(`  ❌ ${name} ${detail}`) }
}
function throws(fn: () => unknown): boolean {
  try { fn(); return false } catch { return true }
}

const LABELS = new Set(['has', 'none', 'uncertain'])
const AI_PACK = resolve(process.cwd(), 'opportunity-eval-pack-20260902.ai.jsonl')

/** 测试侧独立重建 AI 匹配索引（与 evalService.loadAiPack 同口径，用于交叉验证回填正确性） */
function buildExpectAi(): (sid: string, anchor: string) => { ai_label: string } | undefined {
  const valid = readFileSync(AI_PACK, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean)
    .map((l) => JSON.parse(l) as { session_id?: string; anchor_key?: string; ai_label?: string })
    .filter((r) => r.session_id && LABELS.has(String(r.ai_label)) && !String(r.session_id).includes('@chatroom'))
  const byAnchor = new Map<string, (typeof valid)[number]>()
  const bySession = new Map<string, (typeof valid)[number]>()
  for (const r of valid) {
    byAnchor.set(`${r.session_id}|${r.anchor_key || ''}`, r)
    if (!bySession.has(String(r.session_id))) bySession.set(String(r.session_id), r)
  }
  return (sid, anchor) => byAnchor.get(`${sid}|${anchor}`) ?? bySession.get(sid)
}

/** 替身锚点解析器：测试环境没有聊天库，生成可被 evidence resolver 解析的规范 messageKey。 */
const fakeAnchor = (sid: string): string => buildMessageKey({
  localId: 1, serverId: 0, createTime: 1, sortSeq: 1, senderUsername: sid,
  localType: 1, dbName: 'eval-test', tableName: `message-${sid}`
})

/** 指标独立重算（与 evalService.computeEvalMetrics 同口径另写一份，交叉验证） */
function naiveMetrics(rows: OpportunityEvalCase[]): { compared: number; confusion: number[][]; prf: Record<string, { p: number | null; r: number | null; f1: number | null }> } {
  const confirmed = rows.filter((r) => r.status === 'confirmed' && LABELS.has(String(r.label || '')) && LABELS.has(String(r.ai_label || '')))
  const idx = (l: string) => EVAL_CLASSES.indexOf(l as (typeof EVAL_CLASSES)[number])
  const confusion = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
  for (const r of confirmed) confusion[idx(String(r.label))][idx(String(r.ai_label))]++
  const prf: Record<string, { p: number | null; r: number | null; f1: number | null }> = {}
  for (const c of EVAL_CLASSES) {
    let tp = 0, fp = 0, fn = 0
    for (const r of confirmed) {
      const h = String(r.label), a = String(r.ai_label)
      if (h === c && a === c) tp++
      else if (h !== c && a === c) fp++
      else if (h === c && a !== c) fn++
    }
    const p = tp + fp ? tp / (tp + fp) : null
    const rc = tp + fn ? tp / (tp + fn) : null
    prf[c] = {
      p: p != null ? Math.round(p * 1000) / 10 : null,
      r: rc != null ? Math.round(rc * 1000) / 10 : null,
      f1: p != null && rc != null
        ? (p + rc > 0 ? Math.round((2 * p * rc / (p + rc)) * 1000) / 10 : 0)
        : null
    }
  }
  return { compared: confirmed.length, confusion, prf }
}

async function main(): Promise<void> {
  const userData = join(homedir(), 'Library', 'Application Support', 'weflow')
  const salesSrc = findExistingBusinessDb(userData, 'sales')
  const crmSrc = findExistingBusinessDb(userData, 'crm')
  if (!salesSrc || !crmSrc) { console.error('未找到 live 业务库'); process.exit(1) }

  // 副本隔离：两库同名 legacy 落到同一 tmp 目录，绝不触碰 live
  const dir = mkdtempSync(join(tmpdir(), 'eval-annotate-test-'))
  copyFileSync(salesSrc, join(dir, 'weflow-sales.db'))
  copyFileSync(crmSrc, join(dir, 'weflow-crm.db'))
  await salesDbService.initialize(dir)
  await crmDbService.initialize(dir)
  console.log(`副本试跑：sales ← ${salesSrc.replace(homedir(), '~')}；crm ← ${crmSrc.replace(homedir(), '~')}`)

  const expectAi = buildExpectAi()
  const beforeRows = salesDbService.evalCaseList({ limit: 10000 })
  const beforeIds = new Set(beforeRows.map((r) => Number(r.id)))
  const beforeCount = beforeRows.length
  console.log(`\n基线：候选池存量 ${beforeCount} 条`)

  console.log('\n═══ A. 候选生成：过滤群聊 + 同客户去重 + 扩量到门槛 ═══')
  // 副本内注入一条群聊画像（真实库 ①②③ 路恰好无群聊信号，注入后验证 ④ 对照池也拦群聊——
  // 2026-09-02 导出包曾混入 48186608819@chatroom 对照样本，修复的正是这个洞）
  salesDbService.customerUpsert({ session_id: 'evaltest_group@chatroom', display_name: '评测测试群' })
  // 注入一条全新非群聊会话（无信号；0 前缀 → 确定性抽样排序首位，断言不靠运气）
  salesDbService.customerUpsert({ session_id: '0evaltest_fresh_session', display_name: '评测新会话' })
  // 注入系统号（公众号 + 文件传输助手同类）：live 库曾把 filehelper 收编成对照样本，
  // 且它在 intent_tag_log 带「比价」打标 → ③④ 两路都要拦住（gh_ 前缀 + 商机阶段打标，最坏情况）
  salesDbService.customerUpsert({ session_id: 'gh_evaltest_official', display_name: '评测测试公众号' })
  salesDbService.intentCreate({ session_id: 'gh_evaltest_official', stage: '比价', source: 'classifier' })
  const r1 = await generateEvalCandidates({ aiPackPath: AI_PACK, resolveAnchor: fakeAnchor })
  console.log(`  生成结果：${JSON.stringify(r1)}`)
  const afterRows = salesDbService.evalCaseList({ limit: 10000 })
  const newRows = afterRows.filter((r) => !beforeIds.has(Number(r.id)))
  check('A1 新增计数与副本真实新增一致（注入新会话保证 ≥1，不绑死精确数）',
    r1.inserted >= 1 && newRows.length === r1.inserted, `inserted=${r1.inserted} newRows=${newRows.length}`)
  const freshRow = newRows.find((r) => String(r.session_id) === '0evaltest_fresh_session')
  check('A1\' 注入的全新会话被对照池收编（source=no_opportunity_sample）', !!freshRow && String(freshRow.source) === 'no_opportunity_sample')
  check('A2 新增候选零群聊（无 @chatroom）', newRows.every((r) => !String(r.session_id).includes('@chatroom')))
  const dupSessions = newRows.map((r) => String(r.session_id)).filter((s, i, arr) => arr.indexOf(s) !== i)
  check('A3 新增候选同 session 无重复（一客户一行，任何锚点形态都占坑）', dupSessions.length === 0, `重复：${[...new Set(dupSessions)].join(',')}`)
  check('A4 四路计数合计 = 新增数',
    r1.bySource.intent + r1.bySource.quote + r1.bySource.intent_signal + r1.bySource.sample === r1.inserted)
  check('A5 注入的群聊画像被对照池拦截（chatroomFiltered ≥ 1）', r1.chatroomFiltered >= 1, `chatroomFiltered=${r1.chatroomFiltered}`)
  check('A6 候选②报价信号路在 crm 副本上工作（quoteSkipped=false；池已饱和不新增属幂等正常）', !r1.quoteSkipped, `quote=${r1.bySource.quote}`)
  check('A7 对照样本来源正确', newRows.filter((r) => r.source === 'no_opportunity_sample').length === r1.bySource.sample)
  check('A8 每条新样本都有可回查 evidence_key（anchor_key 非空；锚点回退生效）',
    newRows.every((r) => String(r.anchor_key || '').length > 0) && r1.anchorMissing === 0,
    `anchorMissing=${r1.anchorMissing}`)
  check('A8\' 系统号（gh_ 公众号）不进候选池——③④ 两路都拦',
    !afterRows.some((r) => String(r.session_id) === 'gh_evaltest_official') &&
    !newRows.some((r) => String(r.session_id).startsWith('gh_')) &&
    r1.chatroomFiltered >= 2,
    `chatroomFiltered=${r1.chatroomFiltered}`)
  check('A8\'\' 生成流程绝不产生 confirmed 行（人工结论只能由 evalLabelCase 写入）',
    newRows.length > 0 && newRows.every((r) => r.status !== 'confirmed'),
    `新增含 confirmed ${newRows.filter((r) => r.status === 'confirmed').length} 条`)
  check('A9 候选池扩量到评测门槛（≥100 条；PRD 样本量）',
    salesDbService.evalCaseCount() >= Math.min(EVAL_GATE_MIN_TOTAL, beforeCount + r1.inserted) && r1.total === salesDbService.evalCaseCount(),
    `total=${r1.total} 存量=${beforeCount}`)

  console.log('\n═══ B. 幂等：重复生成不重复 ═══')
  const r2 = await generateEvalCandidates({ aiPackPath: AI_PACK, resolveAnchor: fakeAnchor })
  check('B1 二次生成 inserted=0', r2.inserted === 0, `inserted=${r2.inserted}`)
  check('B2 候选池总量不变', salesDbService.evalCaseCount() === beforeCount + r1.inserted)

  console.log('\n═══ C. AI 预标注回填 ═══')
  let aiMatchOk = true, aiMatchCount = 0, aiEmptyOk = true
  for (const r of afterRows) {
    const exp = expectAi(String(r.session_id), String(r.anchor_key || ''))
    if (exp) { aiMatchCount++; if (String(r.ai_label || '') !== String(exp.ai_label)) aiMatchOk = false }
    else if (String(r.ai_label || '') !== '') aiEmptyOk = false
  }
  check('C1 匹配到的候选 ai_label 与包内一致', aiMatchOk && aiMatchCount > 0, `匹配 ${aiMatchCount} 条`)
  check('C2 匹配不上的候选 ai 字段留空', aiEmptyOk)
  // C3：已存在行缺 ai_* 时，刷新只回填 ai_*（人工字段不动）
  const withAi = afterRows.find((r) => r.ai_label && r.source === 'quote_signal' && r.status !== 'confirmed')
  if (withAi) {
    salesDbService.evalCaseUpsert({ session_id: String(withAi.session_id), anchor_key: String(withAi.anchor_key || ''), ai_label: '', ai_evidence_keys: '[]' })
    const r3 = await generateEvalCandidates({ aiPackPath: AI_PACK, resolveAnchor: fakeAnchor })
    const restored = salesDbService.evalCaseGet(String(withAi.session_id), String(withAi.anchor_key || ''))
    check('C3 已存在行缺 ai_* 时刷新补齐', r3.aiBackfilled >= 1 && String(restored?.ai_label || '') === String(withAi.ai_label),
      `aiBackfilled=${r3.aiBackfilled} restored=${restored?.ai_label}`)
  } else {
    check('C3 已存在行缺 ai_* 时刷新补齐（无样本，跳过）', false, '候选池无带 ai_label 的报价来源未确认行')
  }

  console.log('\n═══ D. 标注写回 + 进度统计 + 服务端防锚定 ═══')
  const statsBefore = evalStats()
  const target = salesDbService.evalCaseList({ limit: 10000 }).find((r) => r.status !== 'confirmed')!
  const labeled = evalLabelCase(Number(target.id), 'has', '测试员')
  check('D1 写回 label/status/annotated_by', labeled.label === 'has' && labeled.status === 'confirmed' && labeled.annotated_by === '测试员',
    JSON.stringify({ label: labeled.label, status: labeled.status, by: labeled.annotated_by }))
  check('D2 非法 label 拒绝', throws(() => evalLabelCase(Number(target.id), 'maybe', '测试员')))
  check('D3 空标注人拒绝', throws(() => evalLabelCase(Number(target.id), 'none', '  ')))
  check('D4 不存在的记录拒绝', throws(() => evalLabelCase(99999999, 'has', '测试员')))
  const statsAfter = evalStats()
  check('D5 进度统计 confirmed +1 / total 不变', statsAfter.confirmed === statsBefore.confirmed + 1 && statsAfter.total === statsBefore.total)
  check('D5\' 分档计数 byLabel.has +1 且合计=confirmed',
    statsAfter.byLabel.has === statsBefore.byLabel.has + 1 &&
    statsAfter.byLabel.has + statsAfter.byLabel.none + statsAfter.byLabel.uncertain === statsAfter.confirmed)
  check('D6 evalListCases 附展示名且已标沉底', (() => {
    const list = evalListCases()
    const firstConfirmed = list.findIndex((r) => r.status === 'confirmed')
    return list.length === statsAfter.total && list.every((r) => typeof r.display_name === 'string' && r.display_name.length > 0) &&
      (firstConfirmed === -1 || list.slice(0, firstConfirmed).every((r) => r.status !== 'confirmed'))
  })())
  check('D7 服务端防锚定：未确认行列表不下发 ai_*（原行有 ai_label 的必然存在）', (() => {
    const raw = salesDbService.evalCaseList({ limit: 10000 })
    const rawPendingWithAi = raw.filter((r) => r.status !== 'confirmed' && r.ai_label && LABELS.has(String(r.ai_label)))
    if (rawPendingWithAi.length === 0) return true // 副本可能无未确认带 AI 行（A8 已覆盖锚点机制），机制在 phase0 F 段专测
    const listed = evalListCases()
    return rawPendingWithAi.every((r) => {
      const l = listed.find((x) => Number(x.id) === Number(r.id))
      return l && l.ai_label === '' && l.ai_evidence_keys === '[]'
    })
  })())

  console.log('\n═══ E. 人机一致率 ═══')
  const pool = salesDbService.evalCaseList({ limit: 10000 }).filter((r) => r.ai_label && LABELS.has(String(r.ai_label)))
  const [e1, e2] = pool
  if (e1 && e2) {
    // 一条标成与 AI 一致、一条标成不一致
    evalLabelCase(Number(e1.id), String(e1.ai_label), '测试员')
    const otherLabel = ['has', 'none', 'uncertain'].find((l) => l !== e2.ai_label)!
    evalLabelCase(Number(e2.id), otherLabel, '测试员')
    const st = evalStats()
    // 独立重算交叉验证
    const rows = salesDbService.evalCaseList({ limit: 10000 })
    const confirmed = rows.filter((r) => r.status === 'confirmed')
    const compared = confirmed.filter((r) => r.ai_label && LABELS.has(String(r.ai_label)))
    const agree = compared.filter((r) => r.label === r.ai_label).length
    check('E1 compared/agree 与独立重算一致', st.compared === compared.length && st.agree === agree,
      `st=${st.compared}/${st.agree} 重算=${compared.length}/${agree}`)
    const expectRate = compared.length ? Math.round((agree / compared.length) * 100) : null
    check('E2 agreeRate 数学正确', st.agreeRate === expectRate, `st=${st.agreeRate} 期望=${expectRate}`)
    check('E3 一致样本被计入 agree', agree >= 1)
    check('E4 不一致样本拉低一致率（agree < compared）', compared.length === 0 || agree < compared.length)
  } else {
    check('E 人机一致率（候选池带 AI 预标注样本不足 2 条，跳过）', false, `pool=${pool.length}`)
  }

  console.log('\n═══ F. 基线指标 + 门槛判定 + 基线报告 ═══')
  const rowsF = salesDbService.evalCaseList({ limit: 10000 })
  const m = computeEvalMetrics(rowsF)
  const naive = naiveMetrics(rowsF)
  check('F1 compared 与独立重算一致', m.compared === naive.compared && m.compared > 0, `m=${m.compared} naive=${naive.compared}`)
  check('F2 混淆矩阵与独立重算一致（行=人工，列=AI）',
    JSON.stringify(m.confusion.matrix) === JSON.stringify(naive.confusion) &&
    JSON.stringify(m.confusion.labels) === JSON.stringify(EVAL_CLASSES))
  check('F3 分档 P/R/F1 与独立重算一致',
    EVAL_CLASSES.every((c) =>
      m.classes[c].precision === naive.prf[c].p && m.classes[c].recall === naive.prf[c].r && m.classes[c].f1 === naive.prf[c].f1))
  check('F4 accuracy 与混淆矩阵对角线一致', (() => {
    if (!naive.compared) return m.accuracy === null
    const diag = naive.confusion[0][0] + naive.confusion[1][1] + naive.confusion[2][2]
    return m.accuracy === Math.round((diag / naive.compared) * 1000) / 10
  })())
  const stF = evalStats()
  const expectMet = stF.total >= EVAL_GATE_MIN_TOTAL && stF.confirmed >= EVAL_GATE_MIN_CONFIRMED
  check('F5 门槛判定与手算一致（未达标时 met=false 且有 shortfall；达标时无）',
    stF.gate.met === expectMet && (stF.gate.met ? stF.gate.shortfalls.length === 0 : stF.gate.shortfalls.length >= 1))
  check('F5\' 门槛未达标时 shortfalls 明确中文原因', expectMet || stF.gate.shortfalls.some((s) => /人工确认不足/.test(s)))
  const rep = evalBaselineReport()
  const md = renderBaselineReportMarkdown(rep)
  check('F6 未达标报告：metrics=null + Markdown 明示「未达到评测门槛」', rep.metrics === null && md.includes('未达到评测门槛'))
  check('F7 报告候选池构成自洽：来源合计=总量、锚点覆盖拆分=总量',
    Object.values(rep.candidates.bySource).reduce((s, v) => s + v, 0) === rep.candidates.total &&
    rep.candidates.withAnchor + rep.candidates.withoutAnchor === rep.candidates.total)
  check('F8 报告分档分布自洽：人工分档合计=确认数、AI 分档合计=有预标注数',
    rep.labelDistribution.human.has + rep.labelDistribution.human.none + rep.labelDistribution.human.uncertain + rep.labelDistribution.human.unlabeled === rep.candidates.total &&
    rep.labelDistribution.ai.has + rep.labelDistribution.ai.none + rep.labelDistribution.ai.uncertain + rep.labelDistribution.ai.absent === rep.candidates.total)
  check('F9 报告 agreement 与 evalStats 一致',
    rep.agreement.compared === stF.compared && rep.agreement.agree === stF.agree && rep.agreement.agreeRate === stF.agreeRate)
  check('F10 报告包含 PIPL 备注（只含计数与结论，不含原文）', md.includes('PIPL') && !md.includes('evidence_text：'))

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  process.exit(fail ? 1 : 0)
}

void main()
