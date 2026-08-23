/**
 * canonical-state-test.ts —— 客户当前状态读取模型单测（P0-2A.2）
 * 覆盖验收断言：
 *   ① 8 值 → 6 stage + activityState 映射正确（中英归一）
 *   ② unknown 不误入漏斗
 *   ③ dormant 不污染 stage（legacy dormant 落 activityState，底层阶段如实 unknown）
 *   ④ 时间 dormant：quoted + 40 天沉默 → stage 仍 quoted + activityState dormant
 *   ⑤ stateMeta 找到「最近归一化后 == 当前 stage」的对应 intent 记录
 *   ⑥ changedAt：last_stage_change_at 优先，回退 intent 记录 created_at
 * 运行：npx tsx scripts/canonical-state-test.ts
 */
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { computeCanonicalState, DORMANT_SILENT_DAYS, type CanonicalState } from '../shared/canonicalState'
import { funnelBucket } from '../shared/salesStage'
import { salesDbService } from '../electron/services/salesDbService'

let pass = 0, fail = 0
function ok(name: string, cond: boolean): void {
  if (cond) { pass++ } else { fail++; console.error('FAIL:', name) }
}

const NOW_SEC = 1_700_000_000 // 固定参考时间（秒），保证确定性
const DAY_SEC = 86400

/** 纯函数直接调：只指定 rawStage 与其他输入 */
function cs(rawStage: string | null | undefined, overrides: Partial<Parameters<typeof computeCanonicalState>[0]> = {}): CanonicalState {
  return computeCanonicalState({ rawStage, lastContactAt: 0, lastStageChangeAt: null, nowSec: NOW_SEC, recentIntents: [], ...overrides })
}

async function main(): Promise<void> {
  // ── ① 8 值 → 6 stage 映射（中英归一）────────────────────────────────────
  ok('1a 英文 quoted → quoted', cs('quoted').stage === 'quoted')
  ok('1b 中文 比价 → quoted', cs('比价').stage === 'quoted')
  ok('1c 英文 contacted → contacted', cs('contacted').stage === 'contacted')
  ok('1d 中文 了解/已沟通 → contacted', cs('了解').stage === 'contacted' && cs('已沟通').stage === 'contacted')
  ok('1e 英文 negotiating → negotiating', cs('negotiating').stage === 'negotiating')
  ok('1f 中文 决策/谈判中 → negotiating', cs('决策').stage === 'negotiating' && cs('谈判中').stage === 'negotiating')
  ok('1g 英文 won → won', cs('won').stage === 'won')
  ok('1h 中文 成交/已成交 → won', cs('成交').stage === 'won' && cs('已成交').stage === 'won')
  ok('1i 英文 lost → lost', cs('lost').stage === 'lost')
  ok('1j 中文 流失 → lost', cs('流失').stage === 'lost')
  ok('1k 英文 new → new', cs('new').stage === 'new')
  ok('1l 中文 新客 → new', cs('新客').stage === 'new')
  ok('1m 中英映射等价', cs('比价').stage === cs('quoted').stage && cs('决策').stage === cs('negotiating').stage)

  // ── ② unknown 不误入漏斗 ────────────────────────────────────────────────
  ok('2a 未知/unknown → 异常位', cs('未知').stage === 'unknown' && cs('unknown').stage === 'unknown')
  ok('2b unknown 不进漏斗转化链（桶=未知）', funnelBucket('unknown') === '未知' && funnelBucket(cs('未知').stage) === '未知')

  // ── ③ dormant 不污染 stage（legacy 8 值拆开）────────────────────────────
  const d1 = cs('dormant')
  const d2 = cs('沉默')
  ok('3a legacy dormant → stage 异常位 unknown', d1.stage === 'unknown' && d2.stage === 'unknown')
  ok('3b legacy dormant → activityState dormant', d1.activityState === 'dormant' && d2.activityState === 'dormant')
  ok('3c dormant 不进正常漏斗（桶=未知）', funnelBucket(d1.stage) === '未知')

  // ── ④ 时间 dormant：stage 与 activityState 解耦 ─────────────────────────
  const t40 = cs('quoted', { lastContactAt: NOW_SEC - 40 * DAY_SEC })
  ok('4a quoted + 40 天沉默 → stage 仍 quoted', t40.stage === 'quoted')
  ok('4b quoted + 40 天沉默 → activityState dormant', t40.activityState === 'dormant')
  const t5 = cs('quoted', { lastContactAt: NOW_SEC - 5 * DAY_SEC })
  ok('4c quoted + 5 天 → activityState active', t5.activityState === 'active')
  ok('4d 阈值即 DORMANT_SILENT_DAYS=30（与 R5 一致）', DORMANT_SILENT_DAYS === 30)
  const t30 = cs('won', { lastContactAt: NOW_SEC - 30 * DAY_SEC })
  ok('4e won + 30 天（临界）→ dormant', t30.activityState === 'dormant')
  const t29 = cs('won', { lastContactAt: NOW_SEC - 29 * DAY_SEC })
  ok('4f won + 29 天（临界）→ active', t29.activityState === 'active')
  ok('4g last_contact_at 为 0/空 → active', cs('quoted', { lastContactAt: 0 }).activityState === 'active' && cs('quoted', { lastContactAt: null }).activityState === 'active')

  // ── ⑤ stateMeta 找到「最近归一化后 == 当前 stage」的记录 ─────────────────
  const meta = cs('quoted', {
    recentIntents: [
      { stage: '决策', source: 'manual', confidence: null, createdAt: NOW_SEC * 1000 - 86400_000, reason: '最近决策', evidenceText: null, messageKey: null },
      { stage: '比价', source: 'ai', confidence: 0.7, createdAt: NOW_SEC * 1000 - 2 * 86400_000, reason: '报价后追问', evidenceText: '这款能便宜吗', messageKey: 'msg1' }
    ]
  })
  ok('5a 找到最近匹配 quoted 的记录（比价，非最新的决策）', meta.stateMeta.source === 'ai')
  ok('5b 证据取自匹配记录', meta.stateMeta.evidence.evidenceText === '这款能便宜吗' && meta.stateMeta.evidence.messageKey === 'msg1')
  ok('5c confidence 取自匹配记录', meta.stateMeta.confidence === 0.7)
  ok('5d changedAt 无 last_stage_change_at → 回退记录 created_at', meta.stateMeta.changedAt === NOW_SEC * 1000 - 2 * 86400_000)
  ok('5e 无匹配记录 → stateMeta 全空', cs('quoted', { recentIntents: [{ stage: '决策', source: 'ai', confidence: null, createdAt: null, reason: null, evidenceText: null, messageKey: null }] }).stateMeta.source === null)

  // ── ⑥ changedAt：last_stage_change_at 优先 ──────────────────────────────
  const changed = cs('quoted', {
    lastStageChangeAt: NOW_SEC * 1000 - 3600_000,
    recentIntents: [
      { stage: '比价', source: 'ai', confidence: null, createdAt: NOW_SEC * 1000 - 2 * 86400_000, reason: null, evidenceText: null, messageKey: null }
    ]
  })
  ok('6a last_stage_change_at 优先于记录 created_at', changed.stateMeta.changedAt === NOW_SEC * 1000 - 3600_000)

  // ── 集成：salesDbService.getCanonicalState（真实装配）────────────────────
  const dir = mkdtempSync(join(tmpdir(), 'canonical-state-'))
  await salesDbService.initialize(dir)
  salesDbService.customerUpsert({ session_id: 'wx_int', display_name: '集成客户', stage: '比价' })
  salesDbService.intentCreate({ session_id: 'wx_int', stage: '决策', source: 'manual', reason: '最近决策', createdAt: NOW_SEC * 1000 - 86400_000 })
  salesDbService.intentCreate({ session_id: 'wx_int', stage: '比价', source: 'ai', confidence: 0.7, reason: '报价后追问', message_key: 'msg1', evidence_text: '这款能便宜吗', createdAt: NOW_SEC * 1000 - 2 * 86400_000 })
  const integ = salesDbService.getCanonicalState('wx_int', NOW_SEC)
  ok('7a 集成：比价 → quoted', !!integ && integ.stage === 'quoted')
  ok('7b 集成：stateMeta 匹配到比价记录（非最新决策）', !!integ && integ.stateMeta.source === 'ai' && integ.stateMeta.evidence.messageKey === 'msg1')
  ok('7c 集成：无 last_contact_at → active', !!integ && integ.activityState === 'active')
  ok('7d 集成：无 last_stage_change_at → changedAt 回退记录 created_at', !!integ && integ.stateMeta.changedAt === NOW_SEC * 1000 - 2 * 86400_000)
  ok('7e 集成：无客户 → null', salesDbService.getCanonicalState('wx_none', NOW_SEC) === null)

  // 时间 dormant 走集成路径（last_contact_at 秒）
  salesDbService.customerUpsert({ session_id: 'wx_d', display_name: '沉默客户', stage: 'quoted', last_contact_at: NOW_SEC - 40 * DAY_SEC })
  const intD = salesDbService.getCanonicalState('wx_d', NOW_SEC)
  ok('7f 集成：quoted + 40 天（秒）→ dormant，stage 不丢', !!intD && intD.stage === 'quoted' && intD.activityState === 'dormant')

  console.log(`\ncanonical-state-test: ${pass}/${pass + fail} 通过`)
  process.exit(fail > 0 ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
