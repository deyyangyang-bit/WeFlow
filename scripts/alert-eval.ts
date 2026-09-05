/**
 * alert-eval.ts —— 告警评测集（设计-AI见解重定位 §4.3，alert_eval_case）：候选导出 / 主管确认回写
 *
 * ⛔ 铁律：业务库读写一律走应用自身链路（salesDbService），禁止直接改库文件；
 *    export 绝不碰 live 库——聊天输入是「历史聊天副本」的文本形态（--dump 聊天导出 JSONL，只读），
 *    sales 库（可选 --db）复制到 /tmp 副本初始化（仅取显示名），sha256 核验源库零写
 *    （同 scripts/opportunity-eval.ts 隔离模式）。
 *    ⚠️ WCDB（微信聊天库）只能经应用内 native worker 打开，离线脚本读不了——
 *    故聊天语料用聊天导出 JSONL：每行 {session_id, display_name, message_key, is_send, content, create_time}，
 *    message_key 必须是 P0-2B canonical key（应用导出时自带；证据回查同库闭环）。
 *    import 走 salesDbService.alertEvalCaseUpsert 应用链路落库；⚠️ 导入前必须退出 WeFlow 应用。
 *
 * 用法：
 *   npx tsx scripts/alert-eval.ts export --dump <聊天导出JSONL> [--db <sales库路径>] [--out <jsonl路径>]
 *                              [--alert-type loss] [--sample <对照负样本数，默认30>]
 *   npx tsx scripts/alert-eval.ts import <file> [--db <sales库路径>] [--annotated-by <姓名>]
 *
 * 候选两路（alert_type 默认 loss）：
 *   ① loss_signal：dump 中客户消息（is_send=0）命中 parseLossSignal → 正样本候选（ai_label='correct' 预标注）
 *   ② no_loss_sample：未命中消息中确定性抽样（按 message_key 排序等距取 N）→ 负样本候选（ai_label='wrong' 预标注）
 *      ——准确率 = 人工 correct 数 / 已确认数，没有负样本则准确率虚高（全标 correct 也能 100%）。
 * 主管在导出 JSONL 上填 label（correct/wrong/uncertain）→ import 幂等回写（status=confirmed）。
 * PIPL：evidence_text 只存客户原话快照 ≤200 字（坑清单 #8），聊天原文不出本机。
 */

import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { createHash } from 'crypto'
import { homedir, tmpdir } from 'os'
import { basename, dirname, join, resolve } from 'path'
import { salesDbService } from '../electron/services/salesDbService'
import { findExistingBusinessDb } from '../electron/services/businessDbPath'
import { parseLossSignal } from '../electron/services/crmParseRules'

const DEFAULT_USER_DATA = join(homedir(), 'Library', 'Application Support', 'weflow')
const LABELS = new Set(['correct', 'wrong', 'uncertain'])
const EVIDENCE_TEXT_MAX = 200

interface DumpRow {
  session_id?: string
  display_name?: string
  message_key?: string
  is_send?: number
  content?: string
  create_time?: number
}

interface PackRow {
  case_no: number
  candidate_source: 'loss_signal' | 'no_loss_sample'
  alert_type: string
  session_id: string
  display_name: string
  anchor_key: string
  evidence_text: string
  context_summary: string
  /** ← 主管填：correct / wrong / uncertain */
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

async function runExport(argv: string[]): Promise<void> {
  const dumpPath = argValue(argv, '--dump')
  if (!dumpPath || !existsSync(dumpPath)) {
    console.error('未找到聊天导出 JSONL（--dump <路径>）；行结构 {session_id, display_name, message_key, is_send, content, create_time}')
    process.exit(1)
  }
  const alertType = argValue(argv, '--alert-type') || 'loss'
  if (alertType !== 'loss') {
    console.error(`暂只支持 --alert-type loss（竞品走 §4.2 告警 A 已接线，无需评测导出）`)
    process.exit(1)
  }
  const sampleN = Math.max(0, Number(argValue(argv, '--sample') || 30) || 0)
  const outPath = argValue(argv, '--out') ||
    resolve(process.cwd(), `alert-eval-pack-${shortDate(Date.now()).replace(/-/g, '')}.jsonl`)

  // sales 库副本隔离（可选，仅取显示名）：复制 → /tmp → 应用链路初始化 → 只读 → sha256 核验零写
  const srcSales = argValue(argv, '--db') || findExistingBusinessDb(DEFAULT_USER_DATA, 'sales') || ''
  let nameOf = new Map<string, string>()
  let srcHashBefore = ''
  if (srcSales && existsSync(srcSales)) {
    const dir = mkdtempSync(join(tmpdir(), 'alert-eval-export-'))
    copyFileSync(srcSales, join(dir, 'weflow-sales.db'))
    srcHashBefore = createHash('sha256').update(readFileSync(srcSales)).digest('hex')
    const target = dbTargetOf(srcSales)
    await salesDbService.initialize(dir, target.wxid)
    for (const p of salesDbService.customerAll()) {
      if (p.session_id && p.display_name) nameOf.set(p.session_id, String(p.display_name))
    }
    console.log(`export 试跑（live 零写）：源 ${srcSales.replace(homedir(), '~')} → /tmp 副本（仅读显示名）`)
  } else {
    console.warn('⚠️ 未找到 sales 库：display_name 用 dump 自带字段兜底')
  }

  // 读聊天副本（只读），跑 parseLossSignal
  const lines = readFileSync(dumpPath, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean)
  const positives: PackRow[] = []
  const negatives: PackRow[] = []
  let caseNo = 0
  let scanned = 0, customerMsgs = 0, parseErrors = 0
  for (const [idx, line] of lines.entries()) {
    let row: DumpRow
    try { row = JSON.parse(line) } catch { parseErrors++; continue }
    const sessionId = String(row.session_id || '').trim()
    const content = String(row.content || '')
    if (!sessionId || !content) continue
    if (sessionId.includes('@chatroom')) continue // 评测只标私聊（同 D7 口径）
    scanned++
    const isSend = Number(row.is_send ?? 0)
    if (isSend !== 0) continue
    customerMsgs++
    const anchor = String(row.message_key || '').trim()
    if (!anchor) continue // 无锚点 = 证据链不可回查，不进候选（宪法 §1.10）
    const displayName = String(row.display_name || '') || nameOf.get(sessionId) || sessionId
    const at = shortDate(Number(row.create_time || 0) > 1e12 ? Number(row.create_time) : Number(row.create_time || 0) * 1000)
    const hit = parseLossSignal(content, 0)
    if (hit) {
      positives.push({
        case_no: ++caseNo,
        candidate_source: 'loss_signal',
        alert_type: alertType,
        session_id: sessionId,
        display_name: displayName,
        anchor_key: anchor,
        evidence_text: clip200(content),
        context_summary: `命中流失规则（第 ${idx + 1} 行）；时间 ${at}`,
        label: '',
        evidence_message_keys: [anchor],
        annotated_by: '',
        ai_label: 'correct', // 规则命中 = AI/规则预标注「成立」，等人工复核
        ai_evidence_keys: [anchor]
      })
    } else if (sampleN > 0) {
      negatives.push({
        case_no: 0, // 确定性抽样后再编号
        candidate_source: 'no_loss_sample',
        alert_type: alertType,
        session_id: sessionId,
        display_name: displayName,
        anchor_key: anchor,
        evidence_text: clip200(content),
        context_summary: `未命中流失规则的客户消息对照（第 ${idx + 1} 行）；时间 ${at}`,
        label: '',
        evidence_message_keys: [anchor],
        annotated_by: '',
        ai_label: 'wrong',
        ai_evidence_keys: [anchor]
      })
    }
  }

  // 负样本确定性抽样：按 anchor_key 排序等距取 N（幂等——同 dump 同参数每轮同结果，对照 D7 修正①③）
  let sampled: PackRow[] = []
  if (sampleN > 0 && negatives.length > 0) {
    negatives.sort((a, b) => (a.anchor_key < b.anchor_key ? -1 : a.anchor_key > b.anchor_key ? 1 : 0))
    const step = Math.max(1, Math.floor(negatives.length / sampleN))
    sampled = negatives.filter((_, i) => i % step === 0).slice(0, sampleN)
  }
  const rows = [...positives, ...sampled]
  for (const r of rows) r.case_no = rows.indexOf(r) + 1
  writeFileSync(outPath, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''))

  if (srcHashBefore) {
    salesDbService.close()
    const srcHashAfter = createHash('sha256').update(readFileSync(srcSales)).digest('hex')
    if (srcHashBefore !== srcHashAfter) {
      console.error('✗ 源库哈希变化——export 疑似写入 live 库，立即排查！')
      process.exit(1)
    }
  }

  console.log(`\n═══ 导出完成 ═══`)
  console.log(`  dump 总行 ${lines.length} / 解析失败 ${parseErrors} / 私聊客户消息 ${customerMsgs}（扫描 ${scanned}）`)
  console.log(`  候选① loss_signal 命中（ai_label=correct）：${positives.length} 条`)
  console.log(`  候选② no_loss_sample 对照（ai_label=wrong）：${sampled.length} 条（负样本池 ${negatives.length}，--sample ${sampleN}）`)
  console.log(`  合计：${rows.length} 条 → ${outPath}`)
  console.log(`  live 源库零写核验：${srcHashBefore ? '通过（sha256 不变）' : '跳过（未提供 --db）'}`)
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
    let row: Partial<PackRow>
    try { row = JSON.parse(line) } catch { failures.push(`${at}：JSON 解析失败`); continue }
    const sessionId = String(row.session_id || '').trim()
    if (!sessionId) { failures.push(`${at}：缺 session_id`); continue }
    const alertType = String(row.alert_type || '').trim() || 'loss'
    const anchorKey = String(row.anchor_key || '').trim()
    if (!anchorKey) { failures.push(`${at}：缺 anchor_key（告警评测必须带证据锚点，宪法 §1.10）`); continue }
    const label = String(row.label || '').trim()
    if (!label) { skipped++; continue } // 主管未标注 → 跳过（幂等：下次补标后可重导）
    if (!LABELS.has(label)) { failures.push(`${at}：label='${label}' 非法（仅 correct/wrong/uncertain）`); continue }
    const evidenceText = String(row.evidence_text || '')
    if (evidenceText.length > EVIDENCE_TEXT_MAX) {
      failures.push(`${at}：evidence_text ${evidenceText.length} 字 > ${EVIDENCE_TEXT_MAX}（PIPL 上限）`); continue
    }
    const annotatedBy = String(row.annotated_by || '').trim() || cliAnnotator
    if (!annotatedBy) { failures.push(`${at}：缺 annotated_by（行内字段或 --annotated-by）`); continue }
    const keys = Array.isArray(row.evidence_message_keys)
      ? row.evidence_message_keys.map((k) => String(k)).filter(Boolean)
      : []
    const existed = !!salesDbService.alertEvalCaseGet(sessionId, anchorKey, alertType)
    salesDbService.alertEvalCaseUpsert({
      session_id: sessionId,
      anchor_key: anchorKey,
      alert_type: alertType,
      label,
      evidence_message_keys: JSON.stringify(keys.length ? keys : [anchorKey]),
      evidence_text: clip200(evidenceText),
      annotated_by: annotatedBy,
      status: 'confirmed',
      source: String(row.candidate_source || 'manual'),
      updated_by: annotatedBy
    })
    if (existed) updated++; else inserted++
  }
  salesDbService.flushNow()

  // 准确率速览（按 alert_type 分组：correct / 已确认总数——§4.1 第 4 条 ≥85% 才开推送门）
  const byType = new Map<string, { confirmed: number; correct: number }>()
  for (const t of new Set(['loss'])) {
    const confirmed = salesDbService.alertEvalCaseList({ alert_type: t, status: 'confirmed', limit: 2000 })
    const correct = confirmed.filter((c) => c.label === 'correct').length
    byType.set(t, { confirmed: confirmed.length, correct })
  }

  console.log(`\n═══ 回写完成 ═══`)
  console.log(`  总行 ${total} / 新增 ${inserted} / 幂等更新 ${updated} / 跳过（未标注）${skipped} / 失败 ${failures.length}`)
  for (const f of failures) console.log(`  ✗ ${f}`)
  for (const [t, s] of byType) {
    const rate = s.confirmed > 0 ? Math.round((s.correct / s.confirmed) * 1000) / 10 : null
    console.log(`  ${t}：confirmed ${s.confirmed}，准确率 ${rate === null ? '（无已确认样本）' : `${rate}%（推送门 ≥85% 达标：${rate !== null && rate >= 85 ? '✓' : '✗'}）`}`)
  }
  process.exit(failures.length ? 1 : 0)
}

// ─── 入口 ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const cmd = argv[0]
  if (cmd === 'export') return runExport(argv.slice(1))
  if (cmd === 'import') return runImport(argv.slice(1))
  console.error('用法：npx tsx scripts/alert-eval.ts export|import …（见文件头注释）')
  process.exit(1)
}

void main()
