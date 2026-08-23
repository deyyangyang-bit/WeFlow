/**
 * customer-judgment-test.ts —— P0-2C.1 验收：customer_judgment 基础设施
 *
 * 验收（docs/P0-2C-AI-Judgment-Persistence-盘点.md §8 刀 1）：
 *   1  建表：customer_judgment 存在且含契约列（value/confidence/model/reason/message_key/evidence_text/basis/generated_at）
 *   2  表 SQL 含 CHECK 硬约束（禁 stage，DB 层双真源防线）
 *   3  judgmentCreate 追加一行，返回 id + created_at
 *   4  append-only：同 session 同类型两条 → 历史两条，projection=最新
 *   5  projection 取最新（created_at 排序）+ 同毫秒 id 兜底
 *   6  无记录 → judgmentCurrent 返回 undefined
 *   7  judgmentCurrentAll 四类型各自最新，跨 session 隔离
 *   8  judgmentHistory 倒序 / limit / 按类型过滤
 *   9  hasRecentJudgment 窗口内 true / 窗口外 false / 异类型 false
 *   10 证据字段全量 round-trip（message_key/evidence_text/basis/model 原样落库）
 *   11 证据诚实：无 message_key → judgmentEvidenceStatus='unavailable'；有 → 'ok'
 *   12 TS 守卫：judgment_type='stage' 抛错（P0-2C 硬门禁）
 *   13 跨 session：判断不互相污染
 *
 * 运行：npx tsx scripts/customer-judgment-test.ts
 */
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { salesDbService } from '../electron/services/salesDbService'
import {
  CUSTOMER_JUDGMENT_TYPES,
  isCustomerJudgmentType,
  judgmentEvidenceStatus
} from '../shared/customerJudgment'

let pass = 0, fail = 0
function ok(name: string, cond: boolean): void {
  if (cond) { pass++ } else { fail++; console.error('FAIL:', name) }
}

const NOW = Date.now()

function makeDb(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'cj-'))
  return salesDbService.initialize(dir).then(() => dir)
}

async function runScenario(): Promise<void> {
  // ── 1. 建表 + 契约列 ─────────────────────────────────────────────────────
  const cols = salesDbService.judgmentHistory('wx_nonexist') // 触发表创建（init 时已建）
  ok('1a 空 session 历史返回空数组', Array.isArray(cols) && cols.length === 0)
  const info = (salesDbService as any).all('PRAGMA table_info(customer_judgment)') as Array<{ name: string }>
  const colNames = info.map((c) => c.name)
  ok('1b 表存在且含 judgment_type', colNames.includes('judgment_type'))
  ok('1c 表含 value', colNames.includes('value'))
  ok('1d 表含 confidence', colNames.includes('confidence'))
  ok('1e 表含 source/model/reason', ['source', 'model', 'reason'].every((c) => colNames.includes(c)))
  ok('1f 表含证据列 message_key/evidence_text', ['message_key', 'evidence_text'].every((c) => colNames.includes(c)))
  ok('1g 表含 basis/generated_at/created_at', ['basis', 'generated_at', 'created_at'].every((c) => colNames.includes(c)))

  // ── 2. DB CHECK 硬约束 ────────────────────────────────────────────────────
  const ddl = (salesDbService as any).get('SELECT sql FROM sqlite_master WHERE name = ?', ['customer_judgment']) as { sql: string }
  ok('2a 表 DDL 含 CHECK', String(ddl?.sql || '').toUpperCase().includes('CHECK'))
  ok('2b DDL 的 CHECK 不含 stage', !/CHECK[^)]*stage/i.test(String(ddl?.sql || '')))

  // ── 3. judgmentCreate 追加 ────────────────────────────────────────────────
  const rec1 = salesDbService.judgmentCreate({
    session_id: 'wx_a', judgment_type: 'summary', value: '客户近期关注报价，需求明确',
    source: 'ai', model: 'test-model', confidence: 0.8,
    message_key: 'local:msg_0.db:101:1700000000:0:wxid_a:1',
    evidence_text: '你们叉车多少钱一台',
    basis: JSON.stringify({ start: 1690000000, end: 1700000000, count: 40 })
  })
  ok('3a 返回 id', typeof rec1.id === 'number' && (rec1.id ?? 0) > 0)
  ok('3b 返回 created_at', typeof rec1.created_at === 'number')

  // ── 4. append-only：同 session 同类型两条 ────────────────────────────────
  salesDbService.judgmentCreate({
    session_id: 'wx_a', judgment_type: 'summary', value: '旧摘要',
    source: 'ai', createdAt: NOW - 5000
  })
  const histA = salesDbService.judgmentHistory('wx_a', 'summary')
  ok('4a 历史含两条', histA.length === 2)
  const curA = salesDbService.judgmentCurrent('wx_a', 'summary')
  ok('4b projection=最新一条（value 新摘要）', curA?.value === '客户近期关注报价，需求明确')

  // ── 5. 同毫秒 id 兜底 ─────────────────────────────────────────────────────
  salesDbService.judgmentCreate({ session_id: 'wx_b', judgment_type: 'risk', value: 'r1', source: 'ai', createdAt: 1700000000 })
  salesDbService.judgmentCreate({ session_id: 'wx_b', judgment_type: 'risk', value: 'r2', source: 'ai', createdAt: 1700000000 })
  const curB = salesDbService.judgmentCurrent('wx_b', 'risk')
  ok('5a 同毫秒两条 → projection 取后插入（id 兜底）', curB?.value === 'r2')

  // ── 6. 无记录 → undefined ────────────────────────────────────────────────
  const none = salesDbService.judgmentCurrent('wx_nonexist', 'summary')
  ok('6a 无记录返回 undefined', none === undefined)

  // ── 7. judgmentCurrentAll 四类型 + 跨 session ────────────────────────────
  salesDbService.judgmentCreate({ session_id: 'wx_c', judgment_type: 'summary', value: 's-c', source: 'ai' })
  salesDbService.judgmentCreate({ session_id: 'wx_c', judgment_type: 'opportunity', value: 'o-c1', source: 'ai' })
  salesDbService.judgmentCreate({ session_id: 'wx_c', judgment_type: 'opportunity', value: 'o-c2', source: 'ai' })
  salesDbService.judgmentCreate({ session_id: 'wx_c', judgment_type: 'risk', value: 'risk-c', source: 'ai' })
  salesDbService.judgmentCreate({ session_id: 'wx_c', judgment_type: 'next_action', value: 'na-c', source: 'ai' })
  salesDbService.judgmentCreate({ session_id: 'wx_d', judgment_type: 'summary', value: 's-d', source: 'ai' })
  const allC = salesDbService.judgmentCurrentAll('wx_c')
  ok('7a summary 正确', allC.summary?.value === 's-c')
  ok('7b opportunity 取最新（o-c2）', allC.opportunity?.value === 'o-c2')
  ok('7c risk 正确', allC.risk?.value === 'risk-c')
  ok('7d next_action 正确', allC.next_action?.value === 'na-c')
  const allD = salesDbService.judgmentCurrentAll('wx_d')
  ok('7e 跨 session：wx_d 只有 summary，其余 undefined', allD.summary?.value === 's-d' && allD.opportunity === undefined && allD.risk === undefined && allD.next_action === undefined)

  // ── 8. judgmentHistory 倒序 / limit / 按类型过滤 ─────────────────────────
  for (let i = 1; i <= 5; i++) {
    salesDbService.judgmentCreate({ session_id: 'wx_e', judgment_type: 'next_action', value: `na${i}`, source: 'ai', createdAt: 1700000000 + i })
  }
  const histE = salesDbService.judgmentHistory('wx_e', 'next_action', 3)
  ok('8a limit=3', histE.length === 3)
  ok('8b 倒序（最新在前）', histE[0]?.value === 'na5' && histE[2]?.value === 'na3')
  const histEAll = salesDbService.judgmentHistory('wx_e')
  ok('8c 无类型过滤 → 全量 5 条', histEAll.length === 5)
  ok('8d 无该类型记录 → 空数组', salesDbService.judgmentHistory('wx_e', 'summary').length === 0)

  // ── 9. hasRecentJudgment 去重窗口 ────────────────────────────────────────
  ok('9a 刚写入（窗口内）→ true', salesDbService.hasRecentJudgment('wx_c', 'summary', 60_000))
  ok('9b 未写过该类型 → false', !salesDbService.hasRecentJudgment('wx_h', 'next_action', 60_000))
  salesDbService.judgmentCreate({ session_id: 'wx_h', judgment_type: 'next_action', value: 'na-old', source: 'ai', createdAt: 1700000000 })
  ok('9c 历史记录（created_at 远早于窗口）→ false', !salesDbService.hasRecentJudgment('wx_h', 'next_action', 60_000))

  // ── 10. 证据字段 round-trip ──────────────────────────────────────────────
  const evidenceRow = salesDbService.judgmentCurrent('wx_a', 'summary')
  ok('10a message_key 原样落库', evidenceRow?.message_key === 'local:msg_0.db:101:1700000000:0:wxid_a:1')
  ok('10b evidence_text 原样落库', evidenceRow?.evidence_text === '你们叉车多少钱一台')
  ok('10c model 原样落库', evidenceRow?.model === 'test-model')
  ok('10d confidence 原样落库', evidenceRow?.confidence === 0.8)
  ok('10e basis 原样落库（含输入时间范围）', typeof evidenceRow?.basis === 'string' && evidenceRow.basis.includes('"count":40'))

  // ── 11. 证据诚实（judgmentEvidenceStatus 派生，非存储）───────────────────
  ok('11a 有 message_key → ok', judgmentEvidenceStatus(evidenceRow as any) === 'ok')
  const noKey = salesDbService.judgmentCreate({ session_id: 'wx_f', judgment_type: 'risk', value: '无锚点风险', source: 'ai' })
  ok('11b 无 message_key → unavailable（绝不伪造）', judgmentEvidenceStatus(noKey) === 'unavailable')
  ok('11c 空串 message_key → unavailable', judgmentEvidenceStatus({ message_key: '   ' }) === 'unavailable')

  // ── 12. TS 守卫：禁 stage 硬门禁 ─────────────────────────────────────────
  let threwStage = false
  try {
    (salesDbService.judgmentCreate as any)({ session_id: 'wx_g', judgment_type: 'stage', value: '决策', source: 'ai' })
  } catch { threwStage = true }
  ok('12a judgment_type=stage 抛错（P0-2C 硬门禁）', threwStage)
  let threwUnknown = false
  try {
    (salesDbService.judgmentCreate as any)({ session_id: 'wx_g', judgment_type: 'intent_score', value: '80', source: 'ai' })
  } catch { threwUnknown = true }
  ok('12b 未知类型抛错', threwUnknown)
  ok('12c 类型常量与守卫一致', CUSTOMER_JUDGMENT_TYPES.every((t) => isCustomerJudgmentType(t)) && !isCustomerJudgmentType('stage'))

  // ── 13. 跨 session 不污染 ────────────────────────────────────────────────
  ok('13a wx_a 历史无 wx_e 记录', salesDbService.judgmentHistory('wx_a').every((r) => r.session_id === 'wx_a'))
  ok('13b wx_e next_action 不受 wx_b risk 影响', salesDbService.judgmentCurrent('wx_e', 'risk') === undefined)
}

async function main(): Promise<void> {
  await makeDb()
  await runScenario()
  console.log(`customer-judgment-test: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main()
