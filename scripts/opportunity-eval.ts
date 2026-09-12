/**
 * opportunity-eval.ts —— Phase 0 D7 商机评测集：标注包导出 / 主管确认回写 / 基线报告
 *
 * ⛔ 铁律：业务库读写一律走应用自身链路（salesDbService / crmDbService），禁止直接改库文件
 *    （sql.js 内存库 + 500ms 防抖落盘会覆盖外部直改，HANDOVER §2.40 前科）。
 *    export/report 对 live 库零写：源库复制到 /tmp 副本 → 应用链路 initialize → 只读统计导出
 *    （同 scripts/migration/dry-run-all.ts 隔离试跑模式；initialize 对副本做幂等 DDL，对副本无害）。
 *    import 走 salesDbService.evalCaseUpsert 应用链路落库；⚠️ 导入前必须退出 WeFlow 应用，
 *    否则应用内存库落盘会覆盖导入结果。
 *
 * 用法：
 *   npx tsx scripts/opportunity-eval.ts export [--db <sales库路径>] [--crm-db <crm库路径>] [--no-crm]
 *                                             [--out <jsonl路径>] [--sample <③新增上限，默认30>]
 *   npx tsx scripts/opportunity-eval.ts import <file> [--db <sales库路径>] [--annotated-by <姓名>]
 *   npx tsx scripts/opportunity-eval.ts report [--db <sales库路径>] [--out <报告json路径>]
 *
 * 候选四路（2026-09-09 扩量刀，与 electron/services/evalService.ts 应用内口径一致）：
 *   ① salesDb intent_tag_log 有 message_key 且阶段为商机相关（quoted/negotiating/won/比价/决策/成交）
 *   ② crmDb quote_signal 报价信号（crm 库缺失时跳过并告警）
 *   ③ 意向信号会话（新增）：intent_tag_log 有打标但 ①② 没接住的会话，锚点用打标 message_key（无则不入包）
 *   ④ 无信号会话对照样本（需聊天库真实锚点，只在应用内生成；offline export 不产生空锚行）
 * 数据质量（2026-09-03 修 + 本刀）：所有候选路一律排除 @chatroom 群聊与系统号（filehelper/gh_/@openim）——评测只标私聊客户；
 *   库 opportunity_eval_case 已有的 session 不再导出（候选池 SSOT 在应用内，导出只做增量批）。
 * 应用内标注流（侧边栏「评测标注」页）上线后，export/import 仅作备用通道；
 * 基线指标/门槛判定/混淆矩阵见 evalService（report 子命令直接复用其纯函数）。
 * PIPL：evidence_text 只存客户原话快照 ≤200 字（坑清单 #8），聊天原文不出本机。
 */

import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { createHash } from 'crypto'
import { homedir, tmpdir } from 'os'
import { basename, dirname, join, resolve } from 'path'
import { salesDbService } from '../electron/services/salesDbService'
import { crmDbService } from '../electron/services/crmDbService'
import { findExistingBusinessDb } from '../electron/services/businessDbPath'
import { evalBaselineReport, renderBaselineReportMarkdown, EVAL_GATE_MIN_TOTAL } from '../electron/services/evalService'

const DEFAULT_USER_DATA = join(homedir(), 'Library', 'Application Support', 'weflow')
/** 商机相关阶段（中英混存双轨，shared/salesStage.ts 定标「比价=quoted」） */
const OPP_STAGES = new Set(['quoted', 'negotiating', 'won', '比价', '决策', '成交'])
const LABELS = new Set(['has', 'none', 'uncertain'])
const EVIDENCE_TEXT_MAX = 200

/** 系统会话（非客户）：文件传输助手 / 公众号 / 企业微信客服——与 evalService.isSystemSession 同口径 */
function isSystemSession(sessionId: string): boolean {
  return sessionId === 'filehelper' || sessionId.startsWith('gh_') ||
    sessionId.includes('@openim') || sessionId.includes('@kefu.openim')
}

interface PackRow {
  case_no: number
  candidate_source: 'intent_tag_log' | 'quote_signal' | 'intent_signal' | 'no_opportunity_sample'
  session_id: string
  display_name: string
  anchor_key: string
  evidence_text: string
  context_summary: string
  /** ← 主管填：has / none / uncertain */
  label: string
  /** ← 主管挑的证据 messageKey 列表（默认预填锚点，可增删） */
  evidence_message_keys: string[]
  annotated_by: string
  ai_label: string
  ai_evidence_keys: string[]
}

function argValue(argv: string[], flag: string): string {
  const i = argv.indexOf(flag)
  return i >= 0 ? String(argv[i + 1] || '') : ''
}

/** 从库文件路径反推 initialize 参数（wxid 清洗幂等，suffixed 名可安全回传） */
function dbTargetOf(dbFile: string): { dir: string; wxid?: string } {
  const base = basename(dbFile)
  const m = base.match(/^weflow-sales-(.+)\.db$/)
  return { dir: dirname(dbFile), wxid: m ? m[1] : undefined }
}

function shortDate(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function clip200(text: string): string {
  const t = String(text || '').replace(/\s+/g, ' ').trim()
  return t.length > EVIDENCE_TEXT_MAX ? t.slice(0, EVIDENCE_TEXT_MAX) : t
}

// ─── export ──────────────────────────────────────────────────────────────────

/** 副本隔离准备：sales/crm 源库复制到 /tmp 同名 legacy 库 → 应用链路 initialize。返回是否就绪 crm */
async function prepareCopy(srcSales: string, srcCrm: string): Promise<{ dir: string; salesCopy: string; crmReady: boolean }> {
  const dir = mkdtempSync(join(tmpdir(), 'd7-eval-'))
  const salesCopy = join(dir, 'weflow-sales.db')
  copyFileSync(srcSales, salesCopy)
  await salesDbService.initialize(dir)
  let crmReady = false
  if (srcCrm && existsSync(srcCrm)) {
    copyFileSync(srcCrm, join(dir, 'weflow-crm.db'))
    await crmDbService.initialize(dir)
    crmReady = true
  }
  return { dir, salesCopy, crmReady }
}

async function runExport(argv: string[]): Promise<void> {
  const srcSales = argValue(argv, '--db') || findExistingBusinessDb(DEFAULT_USER_DATA, 'sales') || ''
  if (!srcSales) { console.error('未找到 sales 库（weflow-sales-*.db）；可 --db 显式传路径'); process.exit(1) }
  const srcCrm = argv.includes('--no-crm')
    ? ''
    : argValue(argv, '--crm-db') || findExistingBusinessDb(DEFAULT_USER_DATA, 'crm') || ''
  const sampleN = Math.max(0, Number(argValue(argv, '--sample') || 30) || 0)
  const outPath = argValue(argv, '--out') ||
    resolve(process.cwd(), `opportunity-eval-pack-${shortDate(Date.now()).replace(/-/g, '')}.jsonl`)

  // 副本隔离：复制 → legacy 名（initialize 不带 wxid 落此路径）→ 应用链路初始化 → 只读
  const srcHashBefore = createHash('sha256').update(readFileSync(srcSales)).digest('hex')
  const { salesCopy, crmReady } = await prepareCopy(srcSales, srcCrm)
  if (!crmReady) {
    console.warn(`⚠️ ${argv.includes('--no-crm') ? '--no-crm 指定：' : '未找到 crm 库：'}跳过候选②（quote_signal）`)
  }
  console.log(`export 试跑（live 零写）：源 ${srcSales.replace(homedir(), '~')} → 副本 ${salesCopy}`)

  // 会话显示名映射（customer_profile 优先）
  const profiles = salesDbService.customerAll()
  const nameOf = new Map<string, string>()
  for (const p of profiles) {
    if (p.session_id && p.display_name) nameOf.set(p.session_id, String(p.display_name))
  }

  const rows: PackRow[] = []
  const seen = new Set<string>() // `${session_id}|${anchor_key}` 跨来源去重
  const covered = new Set<string>() // 本包已收编 + 库候选池已有的 session（同客户一行，跨库占坑）
  for (const r of salesDbService.evalCaseList({ limit: 10000 })) covered.add(String(r.session_id)) // 应用内候选池 SSOT：已有 session 不再导出（增量批）
  const signalSessions = new Set<string>(covered)
  let caseNo = 0

  // ① intent_tag_log 商机相关阶段 + message_key 证据
  const intents = salesDbService.intentWithEvidence(500)
  let intentPicked = 0
  for (const it of intents) {
    const sid = String(it.session_id || '')
    if (!sid) continue
    if (sid.includes('@chatroom') || isSystemSession(sid)) continue // 评测只标私聊客户：群聊/系统号一律排除（2026-09-03 数据质量修复）
    const stage = String(it.stage || '')
    if (!OPP_STAGES.has(stage)) continue
    signalSessions.add(sid)
    if (covered.has(sid)) continue // 库内已有（增量导出不重发）
    const anchor = String(it.message_key || '')
    const key = `${sid}|${anchor}`
    if (seen.has(key)) continue
    seen.add(key)
    covered.add(sid)
    const history = salesDbService.intentHistory(sid, 5)
    const trail = history.map((h) => `${String(h.stage)}（${shortDate(Number(h.created_at || 0))}）`).join(' ← ')
    rows.push({
      case_no: ++caseNo,
      candidate_source: 'intent_tag_log',
      session_id: sid,
      display_name: nameOf.get(sid) || sid,
      anchor_key: anchor,
      evidence_text: clip200(String(it.evidence_text || '')),
      context_summary: `阶段轨迹（新→旧）：${trail || '无'}；本条条由：${clip200(String(it.reason || '')) || '（无）'}`,
      label: '',
      evidence_message_keys: anchor ? [anchor] : [],
      annotated_by: '',
      ai_label: '',
      ai_evidence_keys: []
    })
    intentPicked++
  }

  // ② crmDb quote_signal 报价信号
  let quotePicked = 0
  if (crmReady) {
    const quotes = crmDbService.all('SELECT * FROM quote_signal ORDER BY quoted_at DESC LIMIT 500')
    for (const q of quotes) {
      const sessionId = String(q.session_id || '')
      const anchor = String(q.msg_key || '')
      if (!sessionId) continue
      if (sessionId.includes('@chatroom') || isSystemSession(sessionId)) continue // 评测只标私聊客户：群聊/系统号一律排除
      signalSessions.add(sessionId)
      if (covered.has(sessionId)) continue
      const key = `${sessionId}|${anchor}`
      if (seen.has(key)) continue
      seen.add(key)
      covered.add(sessionId)
      const replied = Number(q.customer_replied_at || 0) > 0
      rows.push({
        case_no: ++caseNo,
        candidate_source: 'quote_signal',
        session_id: sessionId,
        display_name: nameOf.get(sessionId) || String(q.display_name || '') || sessionId,
        anchor_key: anchor,
        evidence_text: '', // quote_signal 无原话快照，主管按 anchor_key 回查聊天记录补
        context_summary: `报价信号：${q.amount ? `金额 ${Number(q.amount)} 元` : '金额未知'} / ` +
          `${q.model ? `型号 ${String(q.model)}` : '型号未知'} / ${shortDate(Number(q.quoted_at || 0))}；` +
          `客户${replied ? '已回复' : '至今未回复'}`,
        label: '',
        evidence_message_keys: anchor ? [anchor] : [],
        annotated_by: '',
        ai_label: '',
        ai_evidence_keys: []
      })
      quotePicked++
    }
  }

  // ③新增预算：--sample 是意向信号会话的上限。脚本无聊天库连接，锚点只认信号自带 message_key；
  // 拿不到 key 的会话不入包，需要锚点回退或对照样本的批走应用内「生成/刷新候选」。
  let signalBudget = sampleN

  // ③ 意向信号会话：intent_tag_log 有打标但 ①② 没接住（打标多无 message_key）；每会话取最新一条
  const intentSignals = salesDbService.intentLatestPerSession(1000)
  let signalPicked = 0
  for (const it of intentSignals) {
    const sid = String(it.session_id || '')
    if (!sid) continue
    if (sid.includes('@chatroom') || isSystemSession(sid)) continue
    signalSessions.add(sid) // 有打标 = 有信号：不进④对照池
    if (covered.has(sid) || signalBudget <= 0) continue
    const anchor = String(it.message_key || '')
    if (!anchor) continue // 无锚点不入包（锚点诚实）
    const key = `${sid}|${anchor}`
    if (seen.has(key)) continue
    seen.add(key)
    covered.add(sid)
    signalBudget--
    const stage = String(it.stage || '')
    rows.push({
      case_no: ++caseNo,
      candidate_source: 'intent_signal',
      session_id: sid,
      display_name: nameOf.get(sid) || sid,
      anchor_key: anchor,
      evidence_text: clip200(String(it.evidence_text || '')),
      context_summary: `意向信号（阶段 ${stage}）：条由 ${clip200(String(it.reason || '')) || '（无）'}`,
      label: '',
      evidence_message_keys: [anchor],
      annotated_by: '',
      ai_label: '',
      ai_evidence_keys: []
    })
    signalPicked++
  }

  // ④ 对照样本需要从聊天库取真实 messageKey。离线 export 不连聊天库，不导出空锚行；
  // 这路候选只由应用内「生成/刷新候选」通过 resolveAnchor 生成。
  const pool = profiles.filter((p) => p.session_id && !String(p.session_id).includes('@chatroom') &&
    !isSystemSession(String(p.session_id)) && !signalSessions.has(p.session_id))

  writeFileSync(outPath, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''))
  const poolTotal = salesDbService.evalCaseCount()

  // live 零写核验：源库字节级不变（close/persist 只作用于 /tmp 副本，与源库无关）
  salesDbService.close()
  const srcHashAfter = createHash('sha256').update(readFileSync(srcSales)).digest('hex')
  if (srcHashBefore !== srcHashAfter) {
    console.error('✗ 源库哈希变化——export 疑似写入 live 库，立即排查！')
    process.exit(1)
  }

  console.log(`\n═══ 导出完成 ═══`)
  console.log(`  候选① intent_tag_log（商机相关阶段+证据锚点）：${intentPicked} 条（扫描带锚点打标 ${intents.length} 条）`)
  console.log(`  候选② quote_signal 报价信号：${quotePicked} 条${crmReady ? '' : '（跳过）'}`)
  console.log(`  候选③ intent_signal 意向信号会话：${signalPicked} 条（信号会话 ${intentSignals.length} 个）`)
  console.log(`  候选④ 无信号对照样本：0 条（离线 export 无聊天库锚点；对照池 ${pool.length} 个会话请在应用内生成）`)
  console.log(`  合计：${rows.length} 条 → ${outPath}`)
  console.log(`  库候选池现有 ${poolTotal} 条（门槛 ${EVAL_GATE_MIN_TOTAL} 条；应用内「生成/刷新候选」会自动补足）`)
  console.log(`  live 源库零写核验：通过（sha256 不变）`)
  process.exit(0)
}

// ─── report ──────────────────────────────────────────────────────────────────

/** 基线报告：门槛判定 + 分档 P/R/F1 + 混淆矩阵（只算人工确认样本）；门槛未达明确「未达到评测门槛」 */
async function runReport(argv: string[]): Promise<void> {
  const srcSales = argValue(argv, '--db') || findExistingBusinessDb(DEFAULT_USER_DATA, 'sales') || ''
  if (!srcSales) { console.error('未找到 sales 库（weflow-sales-*.db）；可 --db 显式传路径'); process.exit(1) }
  const outPath = argValue(argv, '--out') ||
    resolve(process.cwd(), `opportunity-eval-baseline-${shortDate(Date.now()).replace(/-/g, '')}.json`)
  await prepareCopy(srcSales, '') // report 只读 sales 库，不需要 crm
  const report = evalBaselineReport()
  const markdown = renderBaselineReportMarkdown(report)
  salesDbService.close()

  writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n')
  writeFileSync(outPath.replace(/\.json$/, '') + '.md', markdown + '\n')

  console.log(markdown)
  console.log(`═══ 报告文件 ═══`)
  console.log(`  JSON：${outPath}`)
  console.log(`  Markdown：${outPath.replace(/\.json$/, '')}.md`)
  console.log(`  live 源库零写（/tmp 副本试跑）`)
  if (!report.gate.met) {
    console.warn('⛔ 未达到评测门槛——本报告不含正式基线指标；请先在应用内补足样本并完成人工标注')
  }
  process.exit(0)
}

// ─── import ──────────────────────────────────────────────────────────────────

async function runImport(argv: string[]): Promise<void> {
  const file = String(argv[0] || '')
  if (!file || file.startsWith('--')) { console.error('用法：import <file> [--db <sales库路径>] [--annotated-by <姓名>]'); process.exit(1) }
  if (!existsSync(file)) { console.error(`文件不存在：${file}`); process.exit(1) }
  const dbArg = argValue(argv, '--db')
  const dbFile = dbArg || findExistingBusinessDb(DEFAULT_USER_DATA, 'sales') || ''
  if (!dbFile) { console.error('未找到 sales 库（weflow-sales-*.db）；可 --db 显式传路径'); process.exit(1) }
  const cliAnnotator = argValue(argv, '--annotated-by')

  const target = dbTargetOf(dbFile)
  await salesDbService.initialize(target.dir, target.wxid)
  console.log(`import 目标库：${dbFile.replace(homedir(), '~')}`)
  console.warn('⚠️ 请确认 WeFlow 应用已退出——应用运行中其内存库落盘会覆盖导入结果')

  let total = 0, inserted = 0, updated = 0, skipped = 0
  const failures: string[] = []
  const existingBySession = new Map(
    salesDbService.evalCaseList({ limit: 10000 }).map((r) => [String(r.session_id), r] as const)
  )
  const lines = readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean)
  for (const [idx, line] of lines.entries()) {
    total++
    const at = `第 ${idx + 1} 行`
    let row: Partial<PackRow> & { source?: string }
    try { row = JSON.parse(line) } catch { failures.push(`${at}：JSON 解析失败`); continue }
    const sessionId = String(row.session_id || '').trim()
    if (!sessionId) { failures.push(`${at}：缺 session_id`); continue }
    const label = String(row.label || '').trim()
    if (!label) { skipped++; continue } // 主管未标注 → 跳过（幂等：下次补标后可重导）
    if (!LABELS.has(label)) { failures.push(`${at}：label='${label}' 非法（仅 has/none/uncertain）`); continue }
    const evidenceText = String(row.evidence_text || '')
    if (evidenceText.length > EVIDENCE_TEXT_MAX) {
      failures.push(`${at}：evidence_text ${evidenceText.length} 字 > ${EVIDENCE_TEXT_MAX}（PIPL 上限）`); continue
    }
    const annotatedBy = String(row.annotated_by || '').trim() || cliAnnotator
    if (!annotatedBy) { failures.push(`${at}：缺 annotated_by（行内字段或 --annotated-by）`); continue }
    const existingSession = existingBySession.get(sessionId)
    const anchorKey = String(row.anchor_key || '').trim()
    // 历史存量可继续回写原空锚行，但禁止 import 新建空锚样本。
    if (!anchorKey && !existingSession) { failures.push(`${at}：缺 anchor_key（证据不可回查）`); continue }
    if (existingSession && String(existingSession.anchor_key || '') !== anchorKey) {
      failures.push(`${at}：session_id='${sessionId}' 已有评测样本（同客户只允许一行）`)
      continue
    }
    const keys = Array.isArray(row.evidence_message_keys)
      ? row.evidence_message_keys.map((k) => String(k)).filter(Boolean)
      : []
    const existed = !!salesDbService.evalCaseGet(sessionId, anchorKey)
    const saved = salesDbService.evalCaseUpsert({
      session_id: sessionId,
      anchor_key: anchorKey,
      label,
      evidence_message_keys: JSON.stringify(keys),
      evidence_text: clip200(evidenceText),
      annotated_by: annotatedBy,
      status: 'confirmed',
      source: String(row.candidate_source || row.source || 'manual'),
      updated_by: annotatedBy
    })
    existingBySession.set(sessionId, saved)
    if (existed) updated++; else inserted++
  }
  salesDbService.flushNow()

  console.log(`\n═══ 回写完成 ═══`)
  console.log(`  总行 ${total} / 新增 ${inserted} / 幂等更新 ${updated} / 跳过（未标注）${skipped} / 失败 ${failures.length}`)
  for (const f of failures) console.log(`  ✗ ${f}`)
  console.log(`  库内 confirmed 总数：${salesDbService.evalCaseCount('confirmed')}（W8 目标 ≥100，其中无商机对照 ≥30%）`)
  process.exit(failures.length ? 1 : 0)
}

// ─── 入口 ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const cmd = argv[0]
  if (cmd === 'export') return runExport(argv.slice(1))
  if (cmd === 'import') return runImport(argv.slice(1))
  if (cmd === 'report') return runReport(argv.slice(1))
  console.error('用法：npx tsx scripts/opportunity-eval.ts export|import|report …（见文件头注释）')
  process.exit(1)
}

void main()
