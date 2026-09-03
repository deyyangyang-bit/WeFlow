/**
 * phase0-d7-eval-test.ts —— Phase 0 D7 商机评测集验证（宪法 §3 特许扩展行 / §1.10 evidence 规范）
 * fresh：全新空库——建表成功且空表 / 通用五列齐 / CHECK 拒非法 label·status·ai_label、全枚举可写 /
 *        UNIQUE (session_id, anchor_key) 幂等 upsert / ai_* 与人工确认字段分存互不覆盖；
 *        export 子命令对副本只读试跑（源库 sha256 零变化 + 三路候选计数正确）；
 *        import 子命令幂等回写（confirmed + annotated_by，二次导入更新不增行）。
 * 运行：npx tsx scripts/phase0-d7-eval-test.ts
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { createHash } from 'crypto'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawnSync } from 'child_process'
import initSqlJs from 'sql.js'
import { salesDbService } from '../electron/services/salesDbService'

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

  // ── B. 造种子数据 → export 子命令副本只读试跑 ──────────────────────────────
  // 种子：1 条商机相关打标（比价+锚点+原话快照）→ 候选①；1 条非商机打标（new）仅占信号位；
  // 3 个无信号会话进对照池（--sample 2 抽 2 条）→ 候选③。无 crm 库（--no-crm）→ 候选②跳过。
  salesDbService.intentCreate({ session_id: 'sess-a', stage: '比价', source: 'classifier', message_key: 'mk-1', evidence_text: '价格多少' })
  salesDbService.intentCreate({ session_id: 'sess-b', stage: 'new', source: 'classifier', message_key: 'mk-2' })
  for (const s of ['sess-a', 'sess-b', 'sess-c', 'sess-d', 'sess-e']) {
    salesDbService.customerUpsert({ session_id: s, display_name: `客户${s}` })
  }
  salesDbService.flushNow()
  const hashBefore = createHash('sha256').update(readFileSync(dbFile)).digest('hex')
  const outFile = join(mkdtempSync(join(tmpdir(), 'd7-eval-out-')), 'pack.jsonl')

  const exp = spawnSync('npx', ['tsx', 'scripts/opportunity-eval.ts', 'export',
    '--db', dbFile, '--no-crm', '--out', outFile, '--sample', '2'],
    { cwd: process.cwd(), encoding: 'utf8', timeout: 120_000 })
  ok('B1 export 子命令退出码 0', exp.status === 0)
  if (exp.status !== 0) console.error(exp.stdout, exp.stderr)
  const hashAfter = createHash('sha256').update(readFileSync(dbFile)).digest('hex')
  ok('B2 export 对源库零写（sha256 不变）', hashBefore === hashAfter)

  const packLines = readFileSync(outFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
  const bySrc = (s: string) => packLines.filter((r) => r.candidate_source === s)
  ok('B3 导出包 3 条：候选①×1 + 对照③×2', packLines.length === 3 && bySrc('intent_tag_log').length === 1 && bySrc('no_opportunity_sample').length === 2)
  const c1 = bySrc('intent_tag_log')[0]
  ok('B4 候选①字段齐：session/anchor/evidence 快照直用 + label 留空待主管填',
    c1?.session_id === 'sess-a' && c1?.anchor_key === 'mk-1' && c1?.evidence_text === '价格多少' &&
    c1?.label === '' && Array.isArray(c1?.evidence_message_keys) && (c1.evidence_message_keys as string[])[0] === 'mk-1')
  ok('B5 对照样本无锚点、无信号（anchor_key=\'\' 且不含 sess-a/sess-b）',
    bySrc('no_opportunity_sample').every((r) => r.anchor_key === '' && !['sess-a', 'sess-b'].includes(String(r.session_id))))

  // ── C. import 子命令幂等回写（子进程写库，raw sql.js 只读核验） ─────────────
  const importFile = join(mkdtempSync(join(tmpdir(), 'd7-eval-in-')), 'confirmed.jsonl')
  writeFileSync(importFile, [
    JSON.stringify({ session_id: 'sess-a', anchor_key: 'mk-1', label: 'has', evidence_message_keys: ['mk-1'], evidence_text: '价格多少', annotated_by: '主管', candidate_source: 'intent_tag_log' }),
    JSON.stringify({ session_id: 'sess-b', anchor_key: '', label: 'maybe', annotated_by: '主管' }), // 非法 label → 失败行
    JSON.stringify({ session_id: 'sess-c', anchor_key: '', label: '', annotated_by: '主管' })          // 未标注 → 跳过
  ].join('\n') + '\n')
  const runImport = () => spawnSync('npx', ['tsx', 'scripts/opportunity-eval.ts', 'import', importFile, '--db', dbFile],
    { cwd: process.cwd(), encoding: 'utf8', timeout: 120_000 })
  const imp1 = runImport()
  ok('C1 import 含失败行时退出码 1（失败清单不静默）', imp1.status === 1)
  ok('C2 import 报告 新增 1 / 跳过 1 / 失败 1',
    /新增 1/.test(imp1.stdout) && /跳过（未标注）1/.test(imp1.stdout) && /失败 1/.test(imp1.stdout))

  const raw2 = new SQL.Database(readFileSync(dbFile))
  const rows2 = raw2.exec("SELECT session_id, anchor_key, label, status, annotated_by, source, version FROM opportunity_eval_case WHERE session_id = 'sess-a'")
  const r0 = rows2.length && rows2[0].values.length ? rows2[0].values[0].map(String) : []
  ok('C3 回写落库：status=confirmed + annotated_by + source 溯源',
    r0.join('|') === 'sess-a|mk-1|has|confirmed|主管|intent_tag_log|1')

  const imp2 = runImport() // 二次导入：幂等更新不增行
  const raw3 = new SQL.Database(readFileSync(dbFile)) // imp2 落盘后重开（raw2 是旧快照）
  const cntRows = raw3.exec("SELECT COUNT(*) FROM opportunity_eval_case WHERE session_id = 'sess-a'")
  const verRows = raw3.exec("SELECT version FROM opportunity_eval_case WHERE session_id = 'sess-a'")
  ok('C4 二次导入幂等：同键更新不增行', imp2.status !== null && /幂等更新 1/.test(imp2.stdout) && Number(cntRows[0]?.values[0]?.[0]) === 1)
  ok('C5 二次导入 version 推进到 2', Number(verRows[0]?.values[0]?.[0]) === 2)
  raw.close()
  raw2.close()
  raw3.close()

  console.log(`\nfresh 模式：${pass} 通过，${fail} 失败`)
  process.exit(fail ? 1 : 0)
}

void main()
