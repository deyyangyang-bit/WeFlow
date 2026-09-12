/**
 * phase0-d7-eval-test.ts —— Phase 0 D7 商机评测集验证（宪法 §3 特许扩展行 / §1.10 evidence 规范）
 * fresh：全新空库——建表成功且空表 / 通用五列齐 / CHECK 拒非法 label·status·ai_label、全枚举可写 /
 *        UNIQUE (session_id, anchor_key) 幂等 upsert / ai_* 与人工确认字段分存互不覆盖 /
 *        未确认行 ai_* 不下发（evalListCases 服务端级防锚定）；
 *        export 子命令对副本只读试跑（源库 sha256 零变化 + 空锚对照不导出 + 库内已覆盖 session 不重发）；
 *        import 子命令幂等回写（confirmed + annotated_by，二次导入更新不增行）；
 *        候选生成扩量（target 补足 + 锚点回退 + anchorMissing）/ 基线指标 P/R/F1·混淆矩阵 / 门槛判定与基线报告 /
 *        标注结果导出（shared/evalExport 纯函数：只导 confirmed 行、CSV 转义、不比对时留空、不含聊天原文）。
 * 运行：npx tsx scripts/phase0-d7-eval-test.ts
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { createHash } from 'crypto'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawnSync } from 'child_process'
import initSqlJs from 'sql.js'
import { salesDbService } from '../electron/services/salesDbService'
import { generateEvalCandidates, evalListCases, evalLabelCase, computeEvalMetrics, evalGateStatus,
  evalBaselineReport, renderBaselineReportMarkdown, EVAL_CLASSES, EVAL_GATE_MIN_TOTAL, EVAL_GATE_MIN_CONFIRMED } from '../electron/services/evalService'
import { buildMessageKey } from '../shared/messageKey'
import { buildEvalCasesCsv, countConfirmed, EVAL_EXPORT_COLUMNS } from '../shared/evalExport'

let pass = 0, fail = 0
function ok(name: string, cond: boolean): void {
  if (cond) { pass++ } else { fail++; console.error('FAIL:', name) }
}
/** 断言抛错（CHECK 约束违规时 sql.js 会 throw） */
function throws(fn: () => unknown): boolean {
  try { fn(); return false } catch { return true }
}

const COMMON5 = ['source', 'updated_by', 'updated_at', 'version', 'deleted']
const SPEC_COLS = ['id', 'session_id', 'anchor_key', 'label', 'evidence_message_keys', 'evidence_text',
  'ai_label', 'ai_evidence_keys', 'annotated_by', 'status', 'created_at']

async function main(): Promise<void> {
  // ── A. 全新空库：schema + 行为断言（走 salesDbService 应用链路） ─────────────
  const dir = mkdtempSync(join(tmpdir(), 'd7-eval-fresh-'))
  await salesDbService.initialize(dir)
  const dbFile = join(dir, 'weflow-sales.db')

  ok('A1 opportunity_eval_case 建表成功且空表', salesDbService.evalCaseCount() === 0)

  // 列级断言：flush 后用 raw sql.js 只读副本文件
  salesDbService.flushNow()
  const SQL = await initSqlJs()
  const raw = new SQL.Database(readFileSync(dbFile))
  const tinfo = raw.exec('PRAGMA table_info(opportunity_eval_case)')
  const colNames = tinfo.length ? tinfo[0].values.map((v) => String(v[1])) : []
  ok('A2 通用五列齐（source/updated_by/updated_at/version/deleted）', COMMON5.every((c) => colNames.includes(c)))
  ok('A3 规格列齐（含 created_at / ai_* 分存列）', SPEC_COLS.every((c) => colNames.includes(c)))

  // CHECK 硬门禁：非法 label / status / ai_label 一律拒
  ok('A4 CHECK 拒非法 label', throws(() => salesDbService.evalCaseUpsert({ session_id: 's-bad1', label: 'maybe' })))
  ok('A5 CHECK 拒非法 status', throws(() => salesDbService.evalCaseUpsert({ session_id: 's-bad2', status: 'done' })))
  ok('A6 CHECK 拒非法 ai_label', throws(() => salesDbService.evalCaseUpsert({ session_id: 's-bad3', ai_label: 'yes' })))
  ok('A7 非法写入全被拒后仍空表', salesDbService.evalCaseCount() === 0)

  // 全枚举可写（label ''/has/none/uncertain × status pending/prelabeled/confirmed）
  let enumOk = true
  const labels = ['', 'has', 'none', 'uncertain'] as const
  for (const l of labels) {
    try { salesDbService.evalCaseUpsert({ session_id: `s-enum-${l || 'empty'}`, label: l }) } catch { enumOk = false }
  }
  for (const s of ['pending', 'prelabeled', 'confirmed']) {
    try { salesDbService.evalCaseUpsert({ session_id: `s-st-${s}`, anchor_key: 'k', status: s }) } catch { enumOk = false }
  }
  ok('A8 label/status 全枚举可写', enumOk)

  // 插入默认 status 推导：仅 ai_label → prelabeled；带人工 label → confirmed；皆无 → pending
  const aiOnly = salesDbService.evalCaseUpsert({ session_id: 's-ai', anchor_key: 'k1', ai_label: 'has', ai_evidence_keys: '["k1"]' })
  ok('A9 仅 AI 预标注插入 → status=prelabeled', aiOnly.status === 'prelabeled')
  const human = salesDbService.evalCaseUpsert({ session_id: 's-human', anchor_key: 'k2', label: 'none' })
  ok('A10 带人工结论插入 → status=confirmed', human.status === 'confirmed')
  const plain = salesDbService.evalCaseUpsert({ session_id: 's-plain' })
  ok('A11 无内容插入 → status=pending', plain.status === 'pending')

  // UNIQUE (session_id, anchor_key) 幂等 upsert：同键更新不增行，version 推进
  const first = salesDbService.evalCaseUpsert({ session_id: 's-idem', anchor_key: 'k9', label: 'has' })
  const second = salesDbService.evalCaseUpsert({ session_id: 's-idem', anchor_key: 'k9', label: 'uncertain', annotated_by: '主管' })
  ok('A12 幂等 upsert：同键不增行', salesDbService.evalCaseList().filter((r) => r.session_id === 's-idem').length === 1)
  ok('A13 幂等 upsert：同 id 复用 + version 推进 + 字段更新',
    second.id === first.id && Number(second.version) === 2 && second.label === 'uncertain' && second.annotated_by === '主管')

  // ai_* 与人工确认字段分存互不覆盖（防锚定偏差）
  const aiRow = salesDbService.evalCaseUpsert({ session_id: 's-sep', anchor_key: 'k5', ai_label: 'has', ai_evidence_keys: '["k5"]' })
  const confirmed = salesDbService.evalCaseUpsert({ session_id: 's-sep', anchor_key: 'k5', label: 'none', evidence_text: '暂时不买', annotated_by: '主管', status: 'confirmed' })
  ok('A14 人工确认不覆盖 ai_*', confirmed.ai_label === 'has' && confirmed.ai_evidence_keys === '["k5"]' && confirmed.label === 'none')
  const reAi = salesDbService.evalCaseUpsert({ session_id: 's-sep', anchor_key: 'k5', ai_label: 'uncertain' })
  ok('A15 AI 重预标注不覆盖人工确认（label/status/annotated_by 不变）',
    reAi.ai_label === 'uncertain' && reAi.label === 'none' && reAi.status === 'confirmed' && reAi.annotated_by === '主管')
  void aiRow

  // 防锚定（服务端级）：未确认行 ai_* 不下发到列表端点，确认行照常（人工标注前不显示 AI 结果）
  const pend = salesDbService.evalCaseUpsert({ session_id: 's-redact', anchor_key: 'k8', ai_label: 'none', ai_evidence_keys: '["k8"]' })
  ok('A16 仅 AI 预标注行 status=prelabeled', pend.status === 'prelabeled')
  const listedPend = evalListCases().find((r) => r.session_id === 's-redact')
  ok('A17 未确认行列表不下发 ai_*（服务端级防锚定）', !!listedPend && listedPend.ai_label === '' && listedPend.ai_evidence_keys === '[]')
  evalLabelCase(Number(pend.id), 'has', '主管')
  const listedDone = evalListCases().find((r) => r.session_id === 's-redact')
  ok('A18 确认行列表照常下发 ai_*（标完可比对）', !!listedDone && listedDone.ai_label === 'none')

  // ── B. 造种子数据 → export 子命令副本只读试跑 ──────────────────────────────
  // 种子：1 条商机相关打标（比价+锚点+原话快照）→ 候选①；1 条非商机打标（new，带锚点）→ 候选③意向信号；
  // 无信号会话因离线 export 不连聊天库无法取真实锚点，必须不导出；sess-c 已在库候选池 → 增量导出不重发。
  salesDbService.intentCreate({ session_id: 'sess-a', stage: '比价', source: 'classifier', message_key: 'mk-1', evidence_text: '价格多少' })
  salesDbService.intentCreate({ session_id: 'sess-b', stage: 'new', source: 'classifier', message_key: 'mk-2' })
  for (const s of ['sess-a', 'sess-b', 'sess-c', 'sess-d', 'sess-e']) {
    salesDbService.customerUpsert({ session_id: s, display_name: `客户${s}` })
  }
  // 库候选池 SSOT：sess-c 已有一行（异锚点）→ export 只做增量批，不再导出该 session
  salesDbService.evalCaseUpsert({ session_id: 'sess-c', anchor_key: 'db-existing-anchor', source: 'no_opportunity_sample' })
  salesDbService.flushNow()
  const hashBefore = createHash('sha256').update(readFileSync(dbFile)).digest('hex')
  const outFile = join(mkdtempSync(join(tmpdir(), 'd7-eval-out-')), 'pack.jsonl')

  const exp = spawnSync('npx', ['tsx', 'scripts/opportunity-eval.ts', 'export',
    '--db', dbFile, '--no-crm', '--out', outFile, '--sample', '3'],
    { cwd: process.cwd(), encoding: 'utf8', timeout: 120_000 })
  ok('B1 export 子命令退出码 0', exp.status === 0)
  if (exp.status !== 0) console.error(exp.stdout, exp.stderr)
  const hashAfter = createHash('sha256').update(readFileSync(dbFile)).digest('hex')
  ok('B2 export 对源库零写（sha256 不变）', hashBefore === hashAfter)

  const packLines = readFileSync(outFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
  const bySrc = (s: string) => packLines.filter((r) => r.candidate_source === s)
  ok('B3 导出包 2 条：候选①×1 + 意向信号③×1；离线不导出空锚对照',
    packLines.length === 2 && bySrc('intent_tag_log').length === 1 && bySrc('intent_signal').length === 1 && bySrc('no_opportunity_sample').length === 0)
  const c1 = bySrc('intent_tag_log')[0]
  ok('B4 候选①字段齐：session/anchor/evidence 快照直用 + label 留空待主管填',
    c1?.session_id === 'sess-a' && c1?.anchor_key === 'mk-1' && c1?.evidence_text === '价格多少' &&
    c1?.label === '' && Array.isArray(c1?.evidence_message_keys) && (c1.evidence_message_keys as string[])[0] === 'mk-1')
  const c3 = bySrc('intent_signal')[0]
  ok('B5 候选③意向信号：非商机阶段打标 + 打标锚点可回查',
    c3?.session_id === 'sess-b' && c3?.anchor_key === 'mk-2' && (c3?.evidence_message_keys as string[])[0] === 'mk-2')
  ok('B6 离线 export 不产生空 anchor_key 的对照样本',
    packLines.every((r) => String(r.anchor_key || '').length > 0))
  ok('B7 库内已覆盖 session 不重发（增量批，无 sess-c）', packLines.every((r) => String(r.session_id) !== 'sess-c'))
  ok('B8 导出样本每条都有非空锚点（evidence_key 可回查）',
    packLines.every((r) => String(r.anchor_key || '').length > 0))

  // ── C. import 子命令幂等回写（子进程写库，raw sql.js 只读核验） ─────────────
  const importFile = join(mkdtempSync(join(tmpdir(), 'd7-eval-in-')), 'confirmed.jsonl')
  writeFileSync(importFile, [
    JSON.stringify({ session_id: 'sess-a', anchor_key: 'mk-1', label: 'has', evidence_message_keys: ['mk-1'], evidence_text: '价格多少', annotated_by: '主管', candidate_source: 'intent_tag_log' }),
    JSON.stringify({ session_id: 'sess-a', anchor_key: 'mk-other', label: 'none', annotated_by: '主管' }), // 同 session 异锚点 → 失败
    JSON.stringify({ session_id: 'sess-b', anchor_key: '', label: 'has', annotated_by: '主管' }),          // 空锚点 → 失败
    JSON.stringify({ session_id: 'sess-b', anchor_key: 'mk-2', label: 'maybe', annotated_by: '主管' }),    // 非法 label → 失败
    JSON.stringify({ session_id: 's-plain', anchor_key: '', label: 'none', annotated_by: '主管' }),         // 历史存量空锚行允许原键回写
    JSON.stringify({ session_id: 'sess-c', anchor_key: '', label: '', annotated_by: '主管' })              // 未标注 → 跳过
  ].join('\n') + '\n')
  const runImport = () => spawnSync('npx', ['tsx', 'scripts/opportunity-eval.ts', 'import', importFile, '--db', dbFile],
    { cwd: process.cwd(), encoding: 'utf8', timeout: 120_000 })
  const imp1 = runImport()
  ok('C1 import 含失败行时退出码 1（失败清单不静默）', imp1.status === 1)
  ok('C2 import 报告 新增 1 / 更新 1 / 跳过 1 / 失败 3（异锚重复+新空锚+非法标签）',
    /新增 1/.test(imp1.stdout) && /幂等更新 1/.test(imp1.stdout) &&
    /跳过（未标注）1/.test(imp1.stdout) && /失败 3/.test(imp1.stdout))

  const raw2 = new SQL.Database(readFileSync(dbFile))
  const rows2 = raw2.exec("SELECT session_id, anchor_key, label, status, annotated_by, source, version FROM opportunity_eval_case WHERE session_id = 'sess-a'")
  const r0 = rows2.length && rows2[0].values.length ? rows2[0].values[0].map(String) : []
  ok('C3 回写落库：status=confirmed + annotated_by + source 溯源',
    r0.join('|') === 'sess-a|mk-1|has|confirmed|主管|intent_tag_log|1')
  const invalidImportRows = raw2.exec("SELECT COUNT(*) FROM opportunity_eval_case WHERE (session_id = 'sess-a' AND anchor_key = 'mk-other') OR (session_id = 'sess-b' AND anchor_key = '')")
  ok('C3\' import 拒绝同客户异锚点重行和空锚点行', Number(invalidImportRows[0]?.values[0]?.[0]) === 0)

  const imp2 = runImport() // 二次导入：幂等更新不增行
  const raw3 = new SQL.Database(readFileSync(dbFile)) // imp2 落盘后重开（raw2 是旧快照）
  const cntRows = raw3.exec("SELECT COUNT(*) FROM opportunity_eval_case WHERE session_id = 'sess-a'")
  const verRows = raw3.exec("SELECT version FROM opportunity_eval_case WHERE session_id = 'sess-a'")
  ok('C4 二次导入幂等：同键更新不增行', imp2.status !== null && /幂等更新 2/.test(imp2.stdout) && Number(cntRows[0]?.values[0]?.[0]) === 1)
  ok('C5 二次导入 version 推进到 2', Number(verRows[0]?.values[0]?.[0]) === 2)
  raw.close()
  raw2.close()
  raw3.close()

  // ── F. 候选扩量 + 基线指标 + 门槛判定 + 基线报告（应用链路，副本库） ──────────
  // 造 9 个无信号会话 + 2 个无锚点意向信号会话 → resolveAnchor 替身提供「会话最新消息 key」；
  // target=20：现有 14 行 → 预算 6（①sess-a 重插 + ③sess-b/f-sig 意向信号 + ④对照补足），全部带可回查锚点。
  // （sess-a 的 confirmed 行是 C 段子进程写入文件的，父进程内存库看不到 → ①路按幂等键重插属预期）
  const fakeAnchor = (sid: string): string => buildMessageKey({
    localId: 1, serverId: 0, createTime: 1, sortSeq: 1, senderUsername: sid,
    localType: 1, dbName: 'eval-test', tableName: `message-${sid}`
  })
  for (const s of ['f-01', 'f-02', 'f-03', 'f-04', 'f-05', 'f-06', 'f-07', 'f-08', 'f-09']) {
    salesDbService.customerUpsert({ session_id: s, display_name: `客户${s}` })
  }
  salesDbService.intentCreate({ session_id: 'f-sig-1', stage: '了解', source: 'classifier' }) // 无 message_key → 靠 resolver 回退
  salesDbService.intentCreate({ session_id: 'f-sig-2', stage: '流失', source: 'classifier' })
  const beforeF = salesDbService.evalCaseCount()
  const fNewSessions = ['sess-a', 'sess-b', 'f-sig-1', 'f-sig-2',
    'f-01', 'f-02', 'f-03', 'f-04', 'f-05', 'f-06', 'f-07', 'f-08', 'f-09']
  const g1 = await generateEvalCandidates({ target: 20, resolveAnchor: fakeAnchor })
  const afterRowsF = salesDbService.evalCaseList({ limit: 10000 })
  const fNewRows = afterRowsF.filter((r) => fNewSessions.includes(String(r.session_id)))
  ok('F1 扩量生成：新增 = 预算数且池子达到 target',
    g1.inserted === fNewRows.length && salesDbService.evalCaseCount() === beforeF + g1.inserted && salesDbService.evalCaseCount() >= 20,
    `inserted=${g1.inserted} before=${beforeF}`)
  ok('F2 意向信号路③工作（无 message_key 打标也收编，source=intent_signal）',
    g1.bySource.intent_signal >= 2 && ['f-sig-1', 'f-sig-2'].every((s) =>
      fNewRows.filter((r) => String(r.session_id) === s).every((r) => String(r.source) === 'intent_signal')))
  ok('F3 每条新样本都有可回查 evidence_key（anchor_key 非空）',
    fNewRows.every((r) => String(r.anchor_key || '').length > 0) && g1.anchorMissing === 0,
    `anchorMissing=${g1.anchorMissing}`)
  ok('F4 三路计数合计=新增 且 对照路④确定性抽 f-01 起',
    g1.bySource.intent + g1.bySource.quote + g1.bySource.intent_signal + g1.bySource.sample === g1.inserted &&
    fNewRows.filter((r) => String(r.source) === 'no_opportunity_sample').every((r) => ['f-01', 'f-02', 'f-03', 'f-04', 'f-05', 'f-06', 'f-07', 'f-08', 'f-09'].includes(String(r.session_id))))
  const g2 = await generateEvalCandidates({ target: 20, resolveAnchor: fakeAnchor })
  ok('F5 二次生成幂等：inserted=0 池子不变', g2.inserted === 0 && salesDbService.evalCaseCount() === beforeF + g1.inserted)
  const g3 = await generateEvalCandidates({ target: 22 }) // 无 resolver：对照候选拿不到锚点 → 不入库（锚点诚实）
  ok('F6 拿不到锚点的会话不入库、计入 anchorMissing', g3.inserted === 0 && g3.anchorMissing >= 2 && salesDbService.evalCaseCount() === beforeF + g1.inserted,
    `anchorMissing=${g3.anchorMissing}`)

  // 基线指标：人工 6 条已知答案（g-1..g-6）× AI 预标注 → 手算 P/R/F1/混淆矩阵交叉验证。
  // （s-redact 是 A 段防锚定 fixture：confirmed + 有效 ai_label，会进指标——这里剔除后再验证手算数）
  const mk = (sid: string, label: string, ai: string) => salesDbService.evalCaseUpsert({
    session_id: sid, anchor_key: `gk-${sid}`, label, ai_label: ai, annotated_by: '主管', status: 'confirmed'
  })
  mk('g-1', 'has', 'has')        // TP(has)
  mk('g-2', 'has', 'none')       // FN(has) FP(none)
  mk('g-3', 'none', 'none')      // TP(none)
  mk('g-4', 'none', 'has')       // FP(has) FN(none)
  mk('g-5', 'uncertain', 'uncertain') // TP(uncertain)
  mk('g-6', 'uncertain', 'has')  // FN(uncertain) FP(has)
  // 指标手算验证只喂受控 g 行（库里另有 A 段 fixture 的 confirmed+ai 行，属合法指标输入但不进手算）
  const gRows = ['g-1', 'g-2', 'g-3', 'g-4', 'g-5', 'g-6']
    .map((sid) => salesDbService.evalCaseGet(sid, `gk-${sid}`)!)
  const allRows = salesDbService.evalCaseList({ limit: 10000 })
  const m = computeEvalMetrics(gRows)
  ok('F7 指标只算人工确认且有 AI 预标注的样本', m.compared === 6)
  ok('F8 has 档 P/R/F1 手算一致（P=1/3, R=1/2, F1=0.4）',
    m.classes.has.tp === 1 && m.classes.has.fp === 2 && m.classes.has.fn === 1 &&
    m.classes.has.precision === 33.3 && m.classes.has.recall === 50 && m.classes.has.f1 === 40)
  ok('F9 none 档 P=R=F1=50%', m.classes.none.precision === 50 && m.classes.none.recall === 50 && m.classes.none.f1 === 50)
  ok('F10 uncertain 档 P=100 R=50 F1=66.7',
    m.classes.uncertain.precision === 100 && m.classes.uncertain.recall === 50 && m.classes.uncertain.f1 === 66.7)
  ok('F11 accuracy=50% / macroF1=52.2%', m.accuracy === 50 && m.macroF1 === 52.2)
  const zeroF1 = computeEvalMetrics([
    { ...gRows[0], label: 'has', ai_label: 'none' },
    { ...gRows[1], label: 'none', ai_label: 'has' },
    { ...gRows[2], label: 'uncertain', ai_label: 'uncertain' }
  ])
  ok('F11\' 某档 P=R=0 时 F1=0 且纳入 macroF1（不得排除后虚高）',
    zeroF1.classes.has.f1 === 0 && zeroF1.classes.none.f1 === 0 && zeroF1.macroF1 === 33.3)
  ok('F12 混淆矩阵 3×3 行=人工列=AI 且计数正确',
    JSON.stringify(m.confusion.labels) === JSON.stringify(EVAL_CLASSES) &&
    JSON.stringify(m.confusion.matrix) === JSON.stringify([[1, 1, 0], [1, 1, 0], [1, 0, 1]]))
  const stF = evalGateStatus(allRows)
  ok('F13 门槛未达标（样本<100 且确认<100）：shortfalls 双列且 met=false',
    !stF.met && stF.shortfalls.length === 2 && /候选样本不足/.test(stF.shortfalls[0]) && /人工确认不足/.test(stF.shortfalls[1]))
  const repUnmet = evalBaselineReport()
  const mdUnmet = renderBaselineReportMarkdown(repUnmet)
  ok('F14 未达标报告：metrics=null 且 Markdown 明确「未达到评测门槛」、无基线指标段',
    repUnmet.metrics === null && mdUnmet.includes('未达到评测门槛') && !mdUnmet.includes('## 基线指标'))

  // 补足到门槛（全部确认）→ 达标：报告产出正式指标
  const gsNow = evalGateStatus()
  let extra = 0
  while (gsNow.confirmed + extra < EVAL_GATE_MIN_CONFIRMED) {
    extra++
    salesDbService.evalCaseUpsert({ session_id: `h-${String(extra).padStart(3, '0')}`, anchor_key: `hk-${extra}`, label: 'none', annotated_by: '主管', status: 'confirmed' })
  }
  const repMet = evalBaselineReport()
  const mdMet = renderBaselineReportMarkdown(repMet)
  ok('F15 样本与确认都补足后门槛达标（≥100/≥100）',
    repMet.gate.met && repMet.gate.total >= EVAL_GATE_MIN_TOTAL && repMet.gate.confirmed >= EVAL_GATE_MIN_CONFIRMED)
  ok('F16 达标报告：metrics 产出且 Markdown 含混淆矩阵与达标结论',
    repMet.metrics !== null && repMet.metrics!.compared >= 7 && mdMet.includes('混淆矩阵') && mdMet.includes('已达到评测门槛'))

  // 对照池前几个会话缺锚时必须继续扫后续会话，不能先 slice 后因缺锚少补。
  salesDbService.close()
  const scanDir = mkdtempSync(join(tmpdir(), 'd7-eval-anchor-scan-'))
  await salesDbService.initialize(scanDir)
  for (let i = 1; i <= 10; i++) salesDbService.customerUpsert({ session_id: `scan-${String(i).padStart(2, '0')}` })
  const scanResult = await generateEvalCandidates({
    target: 5,
    resolveAnchor: (sid) => (sid === 'scan-01' || sid === 'scan-02' ? null : fakeAnchor(sid))
  })
  ok('F17 对照池遇缺锚继续扫描，后续有效会话可补满 target',
    scanResult.anchorMissing === 2 && scanResult.inserted === 5 && scanResult.total === 5)

  // ── G. 标注结果导出（shared/evalExport 纯函数：只导人工确认行 + CSV 转义 + 不泄露原文） ──
  const expRows = [
    { session_id: 'c-1', display_name: '客户甲', source: 'quote_signal', status: 'confirmed',
      label: 'has', annotated_by: '主管', updated_at: Date.UTC(2026, 8, 10, 3, 4, 5),
      anchor_key: 'k:1:2', evidence_message_keys: '["k:1:2"]', ai_label: 'has' },
    { session_id: 'c-2', display_name: '客户,乙"（带逗号引号）', source: 'no_opportunity_sample',
      status: 'confirmed', label: 'none', annotated_by: '主管', updated_at: Date.UTC(2026, 8, 10, 3, 4, 5),
      anchor_key: '', ai_label: '' },
    { session_id: 'c-3', display_name: '未标注', status: 'pending', label: '', source: 'intent_signal' }
  ]
  const csv = buildEvalCasesCsv(expRows)
  const csvLines = csv.split('\n')
  ok('G1 CSV 含固定表头且只导 confirmed 行（pending 行不出现）',
    csvLines[0] === EVAL_EXPORT_COLUMNS.join(',') &&
    csvLines.filter(Boolean).length === 3 &&
    !csv.includes('c-3'))
  ok('G2 CSV 转义：含逗号/引号字段整体加引号且内部引号翻倍',
    csv.includes('"客户,乙""（带逗号引号）"'))
  ok('G3 CSV 三档中文 + 标注人 + 本地时间戳（非空）',
    csv.includes(',has,有商机,主管,') && /,\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},/.test(csv))
  ok('G4 CSV 无 AI 预标注时比对列留空（不把「没比对」写成「不一致」）',
    csvLines[2].endsWith(',') && !csvLines[2].includes('不一致'))
  ok('G5 CSV 含 AI 预标注时给出一致/不一致结论', csvLines[1].endsWith(',一致'))
  ok('G6 导出不含聊天原文（PIPL：evidence_text 不落导出件）',
    !csv.includes('evidence_text') && !csv.includes('信号原文'))
  ok('G7 countConfirmed 与导出行数一致', countConfirmed(expRows) === 2)

  console.log(`\nfresh 模式：${pass} 通过，${fail} 失败`)
  process.exit(fail ? 1 : 0)
}

void main()
