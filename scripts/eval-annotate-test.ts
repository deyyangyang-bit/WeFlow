/**
 * eval-annotate-test.ts —— D7 商机评测集「应用内标注」验证（副本隔离模式）
 *
 * 验证 evalService（electron/services/evalService.ts）：
 *   A. 候选生成：过滤群聊（@chatroom）+ 按 session 去重（一客户一行，取最新锚点）+ 三路计数
 *   B. 幂等：重复生成 inserted=0，候选池总量不变
 *   C. AI 预标注回填：(session,anchor) 精确匹配 / session 兜底 / 匹配不上留空 / 已存在行缺 ai_* 时补齐
 *   D. 标注写回：label + annotated_by + status=confirmed；非法 label / 空标注人拒绝；进度统计正确
 *   E. 人机一致率：一致 / 不一致 / 无 AI 预标注三种样本下 compared/agree/agreeRate 数学正确
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
import { generateEvalCandidates, evalListCases, evalLabelCase, evalStats } from '../electron/services/evalService'

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

  console.log('\n═══ A. 候选生成：过滤群聊 + 按 session 去重 ═══')
  // 副本内注入一条群聊画像（真实库 ①② 路恰好无群聊信号，注入后验证 ③ 对照池也拦群聊——
  // 2026-09-02 导出包曾混入 48186608819@chatroom 对照样本，本刀修复的正是这个洞）
  salesDbService.customerUpsert({ session_id: 'evaltest_group@chatroom', display_name: '评测测试群' })
  const r1 = generateEvalCandidates({ sample: 10, aiPackPath: AI_PACK })
  console.log(`  生成结果：${JSON.stringify(r1)}`)
  const afterRows = salesDbService.evalCaseList({ limit: 10000 })
  const newRows = afterRows.filter((r) => !beforeIds.has(Number(r.id)))
  check('A1 有新增候选且数量一致', r1.inserted > 0 && newRows.length === r1.inserted, `inserted=${r1.inserted} newRows=${newRows.length}`)
  check('A2 新增候选零群聊（无 @chatroom）', newRows.every((r) => !String(r.session_id).includes('@chatroom')))
  const dupSessions = newRows.map((r) => String(r.session_id)).filter((s, i, arr) => arr.indexOf(s) !== i)
  check('A3 新增候选同 session 无重复（一客户一行）', dupSessions.length === 0, `重复：${[...new Set(dupSessions)].join(',')}`)
  check('A4 三路计数合计 = 新增数', r1.bySource.intent + r1.bySource.quote + r1.bySource.sample === r1.inserted)
  check('A5 注入的群聊画像被对照池拦截（chatroomFiltered ≥ 1）', r1.chatroomFiltered >= 1, `chatroomFiltered=${r1.chatroomFiltered}`)
  check('A6 候选②报价信号未跳过（crm 副本就绪）', !r1.quoteSkipped && r1.bySource.quote > 0, `quote=${r1.bySource.quote}`)
  check('A7 对照样本来源正确', newRows.filter((r) => r.source === 'no_opportunity_sample').length === r1.bySource.sample)

  console.log('\n═══ B. 幂等：重复生成不重复 ═══')
  const r2 = generateEvalCandidates({ sample: 10, aiPackPath: AI_PACK })
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
    const r3 = generateEvalCandidates({ sample: 10, aiPackPath: AI_PACK })
    const restored = salesDbService.evalCaseGet(String(withAi.session_id), String(withAi.anchor_key || ''))
    check('C3 已存在行缺 ai_* 时刷新补齐', r3.aiBackfilled >= 1 && String(restored?.ai_label || '') === String(withAi.ai_label),
      `aiBackfilled=${r3.aiBackfilled} restored=${restored?.ai_label}`)
  } else {
    check('C3 已存在行缺 ai_* 时刷新补齐（无样本，跳过）', false, '候选池无带 ai_label 的报价来源未确认行')
  }

  console.log('\n═══ D. 标注写回 + 进度统计 ═══')
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
  check('D6 evalListCases 附展示名且已标沉底', (() => {
    const list = evalListCases()
    const firstConfirmed = list.findIndex((r) => r.status === 'confirmed')
    return list.length === statsAfter.total && list.every((r) => typeof r.display_name === 'string' && r.display_name.length > 0) &&
      (firstConfirmed === -1 || list.slice(0, firstConfirmed).every((r) => r.status !== 'confirmed'))
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

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  process.exit(fail ? 1 : 0)
}

void main()
