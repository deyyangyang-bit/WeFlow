/**
 * opportunity-eval.ts —— Phase 0 D7 商机评测集：标注包导出 / 主管确认回写
 *
 * ⛔ 铁律：业务库读写一律走应用自身链路（salesDbService / crmDbService），禁止直接改库文件
 *    （sql.js 内存库 + 500ms 防抖落盘会覆盖外部直改，HANDOVER §2.40 前科）。
 *    export 对 live 库零写：源库复制到 /tmp 副本 → 应用链路 initialize → 只读统计导出
 *    （同 scripts/migration/dry-run-all.ts 隔离试跑模式；initialize 对副本做幂等 DDL，对副本无害）。
 *    import 走 salesDbService.evalCaseUpsert 应用链路落库；⚠️ 导入前必须退出 WeFlow 应用，
 *    否则应用内存库落盘会覆盖导入结果。
 *
 * 用法：
 *   npx tsx scripts/opportunity-eval.ts export [--db <sales库路径>] [--crm-db <crm库路径>] [--no-crm]
 *                                             [--out <jsonl路径>] [--sample <对照样本数，默认30>]
 *   npx tsx scripts/opportunity-eval.ts import <file> [--db <sales库路径>] [--annotated-by <姓名>]
 *
 * 候选三路（D7 任务定义）：
 *   ① salesDb intent_tag_log 有 message_key 且阶段为商机相关（quoted/negotiating/won/比价/决策/成交）
 *   ② crmDb quote_signal 报价信号（crm 库缺失时跳过并告警）
 *   ③ 随机抽无信号会话作对照样本（no_opportunity 候选，--sample 控制数量）
 * 数据质量（2026-09-03 修）：三路一律排除 @chatroom 群聊——评测只标私聊（对照池曾混入群聊，已修）。
 * 应用内标注流（侧边栏「评测标注」页）上线后，本脚本仅作一次性导出/回写备用通道；
 * 应用内候选生成逻辑见 electron/services/evalService.ts（另加按 session 去重 + 对照样本确定性抽样保幂等）。
 * PIPL：evidence_text 只存客户原话快照 ≤200 字（坑清单 #8），聊天原文不出本机。
 */

import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { createHash } from 'crypto'
import { homedir, tmpdir } from 'os'
import { basename, dirname, join, resolve } from 'path'
import { salesDbService } from '../electron/services/salesDbService'
import { crmDbService } from '../electron/services/crmDbService'
import { findExistingBusinessDb } from '../electron/services/businessDbPath'

const DEFAULT_USER_DATA = join(homedir(), 'Library', 'Application Support', 'weflow')
/** 商机相关阶段（中英混存双轨，shared/salesStage.ts 定标「比价=quoted」） */
const OPP_STAGES = new Set(['quoted', 'negotiating', 'won', '比价', '决策', '成交'])
const LABELS = new Set(['has', 'none', 'uncertain'])
const EVIDENCE_TEXT_MAX = 200

interface PackRow {
  case_no: number
  candidate_source: 'intent_tag_log' | 'quote_signal' | 'no_opportunity_sample'
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

/** Fisher-Yates 洗牌（对照样本随机抽取用） */
function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice()
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

// ─── export ──────────────────────────────────────────────────────────────────

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
  const dir = mkdtempSync(join(tmpdir(), 'd7-eval-export-'))
  const salesCopy = join(dir, 'weflow-sales.db')
  copyFileSync(srcSales, salesCopy)
  const srcHashBefore = createHash('sha256').update(readFileSync(srcSales)).digest('hex')

  await salesDbService.initialize(dir)
  let crmReady = false
  if (srcCrm && existsSync(srcCrm)) {
    copyFileSync(srcCrm, join(dir, 'weflow-crm.db'))
    await crmDbService.initialize(dir)
    crmReady = true
  } else {
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
  const signalSessions = new Set<string>()
  let caseNo = 0

  // ① intent_tag_log 商机相关阶段 + message_key 证据
  const intents = salesDbService.intentWithEvidence(500)
  let intentPicked = 0
  for (const it of intents) {
    if (String(it.session_id).includes('@chatroom')) continue // 评测只标私聊，群聊一律排除（2026-09-03 数据质量修复）
    const stage = String(it.stage || '')
    if (!OPP_STAGES.has(stage)) continue
    const anchor = String(it.message_key || '')
    const key = `${it.session_id}|${anchor}`
    if (seen.has(key)) continue
    seen.add(key)
    signalSessions.add(it.session_id)
    const history = salesDbService.intentHistory(it.session_id, 5)
    const trail = history.map((h) => `${String(h.stage)}（${shortDate(Number(h.created_at || 0))}）`).join(' ← ')
    rows.push({
      case_no: ++caseNo,
      candidate_source: 'intent_tag_log',
      session_id: it.session_id,
      display_name: nameOf.get(it.session_id) || it.session_id,
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
  // 其余有 message_key 的打标也算「有信号」，不进对照池
  for (const it of intents) signalSessions.add(it.session_id)

  // ② crmDb quote_signal 报价信号
  let quotePicked = 0
  if (crmReady) {
    const quotes = crmDbService.all('SELECT * FROM quote_signal ORDER BY quoted_at DESC LIMIT 500')
    for (const q of quotes) {
      const sessionId = String(q.session_id || '')
      const anchor = String(q.msg_key || '')
      if (!sessionId) continue
      if (sessionId.includes('@chatroom')) continue // 评测只标私聊，群聊一律排除
      const key = `${sessionId}|${anchor}`
      if (seen.has(key)) continue
      seen.add(key)
      signalSessions.add(sessionId)
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

  // ③ 随机无信号会话对照样本（no_opportunity 候选；群聊排除——对照池也曾混入 @chatroom，本刀同修）
  const pool = profiles.filter((p) => p.session_id && !String(p.session_id).includes('@chatroom') && !signalSessions.has(p.session_id))
  const sampled = shuffle(pool).slice(0, sampleN)
  for (const p of sampled) {
    rows.push({
      case_no: ++caseNo,
      candidate_source: 'no_opportunity_sample',
      session_id: p.session_id,
      display_name: nameOf.get(p.session_id) || p.session_id,
      anchor_key: '',
      evidence_text: '',
      context_summary: `对照样本：该会话无商机类打标、无报价信号；当前阶段 ${String(p.stage || 'unknown')}` +
        (p.last_contact_at ? `；最近联系 ${shortDate(Number(p.last_contact_at) * 1000)}` : ''),
      label: '',
      evidence_message_keys: [],
      annotated_by: '',
      ai_label: '',
      ai_evidence_keys: []
    })
  }

  writeFileSync(outPath, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''))

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
  console.log(`  候选③ 无信号对照样本：${sampled.length} 条（对照池 ${pool.length} 个会话）`)
  console.log(`  合计：${rows.length} 条 → ${outPath}`)
  console.log(`  live 源库零写核验：通过（sha256 不变）`)
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
    const anchorKey = String(row.anchor_key || '')
    const keys = Array.isArray(row.evidence_message_keys)
      ? row.evidence_message_keys.map((k) => String(k)).filter(Boolean)
      : []
    const existed = !!salesDbService.evalCaseGet(sessionId, anchorKey)
    salesDbService.evalCaseUpsert({
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
  console.error('用法：npx tsx scripts/opportunity-eval.ts export|import …（见文件头注释）')
  process.exit(1)
}

void main()
