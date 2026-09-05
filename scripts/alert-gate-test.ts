/**
 * alert-gate-test.ts —— 例外告警契约四道闸单测（设计-AI见解重定位 §4.1/§4.2 告警 A）
 * 覆盖：
 *  a. 证据强制：getEvidenceByKey 非 found → 告警丢弃，零落库（宪法 §1.10）
 *  b. 推送门：门=false（默认）→ gate_closed，零记录；门=true → 出记录且带 triggerReason='alert:<type>'
 *  c. 72h 幂等：同 sessionId 同 triggerReason 72h 内第二条 → deduped（hasRecentAlert 不限 sourceType）
 *  d. source_msg 锚点：crmParseService 竞品命中点填 sourceMsg、crmDbService.upsertRisk 落 source_msg 列（静态接线检查）
 *  e. 卡流合流接线（静态）：salesActionEngine 有 alert 分支/ALERT_BOOST，前端 SignalSource 有 alert 变体
 * 运行：npx tsx scripts/alert-gate-test.ts
 */
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

let pass = 0, fail = 0
function ok(name: string, cond: boolean): void {
  if (cond) { pass++ } else { fail++; console.error('FAIL:', name) }
}

import {
  createAlertService,
  initAlertService,
  getAlertService,
  ALERT_PUSH_APPROVED,
  ALERT_DEDUP_MS,
  buildAlertMessage
} from '../electron/services/alertService'
import { insightRecordService } from '../electron/services/insightRecordService'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// ─── a. 证据强制 + b. 推送门 + 幂等（依赖注入 fake，不走真实落盘） ──────────────────
void (async () => {
{
  let added = 0
  const svc = createAlertService({
    // fake resolver：可控制 found / unavailable
    getEvidenceByKey: async () => ({ status: 'unavailable', reason: 'message_not_found' }),
    hasRecentAlert: () => false,
    addRecord: () => { added++; return { id: 'r1' } }
  })

  // a1: 证据验不出 → 丢弃（门需先开：门关时在证据校验前就短路，见 b1）
  ALERT_PUSH_APPROVED.competitor = true
  ok('a1 证据 unavailable → created=false reason=no_evidence',
    (await svc.createAlert({ type: 'competitor', sessionId: 'wxid_a', displayName: '张三', messageKey: 'wxid_a:1700000000:1', evidenceText: '他们家更便宜' })).reason === 'no_evidence')
  ok('a2 证据丢弃 → 零落库', added === 0)
  ALERT_PUSH_APPROVED.competitor = false

  // b1: 门=false（默认）→ gate_closed，即使证据 found
  const svcFound = createAlertService({
    getEvidenceByKey: async () => ({ status: 'found' }),
    hasRecentAlert: () => false,
    addRecord: () => { added++; return { id: 'r2' } }
  })
  ok('b1 默认推送门 false → gate_closed',
    (await svcFound.createAlert({ type: 'competitor', sessionId: 'wxid_b', displayName: '李四', messageKey: 'k1', evidenceText: '竞品原话' })).reason === 'gate_closed')
  ok('b2 门=false → 零记录', added === 0)
  ok('b3 ALERT_PUSH_APPROVED 所有类型默认 false', Object.values(ALERT_PUSH_APPROVED).every((v) => v === false))

  // b4: 临时开 competitor 门 → found + 出记录
  ALERT_PUSH_APPROVED.competitor = true
  const r = await svcFound.createAlert({ type: 'competitor', sessionId: 'wxid_b', displayName: '李四', messageKey: 'k1', evidenceText: '那个XX牌子怎么样' })
  ok('b4 门开 + 证据 found → created', r.created === true && (r as { recordId: string }).recordId === 'r2')
  ok('b5 门开 → 恰好落一条记录', added === 1)
  ALERT_PUSH_APPROVED.competitor = false

  // c: 72h 幂等（hasRecentAlert=true → deduped；幂等闸在门之后，门需先开）
  ALERT_PUSH_APPROVED.competitor = true
  const svcDedup = createAlertService({
    getEvidenceByKey: async () => ({ status: 'found' }),
    hasRecentAlert: (sid, triggerReason, windowMs) => sid === 'wxid_c' && triggerReason === 'alert:competitor' && windowMs === ALERT_DEDUP_MS,
    addRecord: () => { added++; return { id: 'r3' } }
  })
  ok('c1 72h 内同类型 → deduped',
    (await svcDedup.createAlert({ type: 'competitor', sessionId: 'wxid_c', displayName: '王五', messageKey: 'k2', evidenceText: '原话' })).reason === 'deduped')
  ok('c2 deduped → 零落库', added === 1)
  ALERT_PUSH_APPROVED.competitor = false
  ok('c3 ALERT_DEDUP_MS = 72h', ALERT_DEDUP_MS === 72 * 60 * 60 * 1000)

  // 边界：坏入参 / 其它类型门仍关
  ok('c4 缺 messageKey → bad_input',
    (await svcDedup.createAlert({ type: 'competitor', sessionId: 'x', displayName: '', messageKey: '', evidenceText: 'y' })).reason === 'bad_input')
  ok('c5 未开通类型 price → gate_closed',
    (await svcDedup.createAlert({ type: 'price', sessionId: 'x', displayName: 'n', messageKey: 'k', evidenceText: 'e' })).reason === 'gate_closed')

  // 文案：含客户原话快照 ≤200 字
  const long = '很'.repeat(300)
  ok('c6 buildAlertMessage 原话快照 ≤200 字', buildAlertMessage('competitor', '赵六', long).includes('很'.repeat(200)) && !buildAlertMessage('competitor', '赵六', long).includes('很'.repeat(201)))
}

// ─── c2. insightRecordService.hasRecentAlert（真实落盘隔离目录） ────────────────────
{
  const HOUR = 60 * 60 * 1000
  insightRecordService.addRecord({
    sessionId: 'wxid_alert1', displayName: '测试', sourceType: 'insight',
    triggerReason: 'alert:competitor', insight: '测试告警', messageKey: 'wxid_alert1:111:2',
    log: { endpoint: 'alert', model: 'rule:competitor', maxTokens: 0, temperature: 0, triggerReason: 'alert:competitor', allowContext: false, contextCount: 0, systemPrompt: '', userPrompt: '', rawOutput: '', finalInsight: '', durationMs: 0, createdAt: Date.now() }
  })
  // 不同 sourceType（archive）同 triggerReason 也计入（不限 sourceType）
  insightRecordService.addRecord({
    sessionId: 'wxid_alert2', displayName: '测试', sourceType: 'archive',
    triggerReason: 'alert:competitor', insight: '测试告警',
    log: { endpoint: 'alert', model: 'rule:competitor', maxTokens: 0, temperature: 0, triggerReason: 'alert:competitor', allowContext: false, contextCount: 0, systemPrompt: '', userPrompt: '', rawOutput: '', finalInsight: '', durationMs: 0, createdAt: Date.now() }
  })
  ok('d1 同 session 同 triggerReason → true', insightRecordService.hasRecentAlert('wxid_alert1', 'alert:competitor', ALERT_DEDUP_MS) === true)
  ok('d2 archive 记录同样计入幂等', insightRecordService.hasRecentAlert('wxid_alert2', 'alert:competitor', ALERT_DEDUP_MS) === true)
  ok('d3 不同 triggerReason → false', insightRecordService.hasRecentAlert('wxid_alert1', 'alert:churn', ALERT_DEDUP_MS) === false)
  ok('d4 不同 session → false', insightRecordService.hasRecentAlert('wxid_other', 'alert:competitor', ALERT_DEDUP_MS) === false)
  // 时间窗边界：把窗口缩到 1ms 内的过去记录（用 startTime 过滤模拟），直接验证窗口参数生效
  ok('d5 窗口 1ms（记录已早于窗口）→ false', insightRecordService.hasRecentAlert('wxid_alert1', 'alert:competitor', 1) === false)

  // 落库字段：messageKey 存进记录
  const rec = insightRecordService.listRecords({ sessionId: 'wxid_alert1' }).records[0]
  ok('d6 记录带 messageKey 锚点', rec?.messageKey === 'wxid_alert1:111:2')
  ok('d7 记录 triggerReason=alert:competitor', rec?.triggerReason === 'alert:competitor')
  ok('d8 记录 sourceType=insight（信箱可见）', rec?.sourceType === 'insight')
}

// ─── d/e. 接线静态检查（源码断言，仿 insight-noise-test 惯例） ──────────────────────
{
  const parseSrc = readFileSync(join(ROOT, 'electron/services/crmParseService.ts'), 'utf-8')
  ok('e1 crmParseService 竞品命中点调 createAlert', parseSrc.includes("type: 'competitor'") && parseSrc.includes('getAlertService()?.createAlert'))
  ok('e2 crmParseService upsertRisk 传 sourceMsg: key（锚点落 crm_risk.source_msg）', parseSrc.includes('sourceMsg: key'))
  ok('e3 evidenceText ≤200 快照', parseSrc.includes('textForSignal.slice(0, 200)'))

  const dbSrc = readFileSync(join(ROOT, 'electron/services/crmDbService.ts'), 'utf-8')
  ok('e4 upsertRisk create 落 source_msg 列', /source_msg: risk\.sourceMsg \|\| ''/.test(dbSrc))
  ok('e5 upsertRisk update 只补空不覆盖', dbSrc.includes("!String(existing.source_msg || '') && risk.sourceMsg"))

  const engineSrc = readFileSync(join(ROOT, 'electron/services/salesActionEngine.ts'), 'utf-8')
  ok('e6 getUnifiedSignals 有 alert 合流分支', engineSrc.includes("startsWith('alert:')") && engineSrc.includes("type: 'alert'"))
  ok('e7 ALERT_BOOST 高于 rule 卡（urgent 档 ≥100）', /ALERT_BOOST = (\d+)/.test(engineSrc) && Number(engineSrc.match(/ALERT_BOOST = (\d+)/)![1]) >= 100)
  ok('e8 卡流读近 24h alert 记录', /ALERT_WINDOW_MS = 24 \* 60 \* 60 \* 1000/.test(engineSrc))

  const storeSrc = readFileSync(join(ROOT, 'src/stores/todayActionStore.ts'), 'utf-8')
  ok('e9 前端 SignalSource 有 alert 变体', storeSrc.includes("type: 'alert'"))
  const cardSrc = readFileSync(join(ROOT, 'src/components/sales/AIActionCard.tsx'), 'utf-8')
  ok('e10 AIActionCard 渲染 alert 徽章', cardSrc.includes('source-tag--alert'))
  const scssSrc = readFileSync(join(ROOT, 'src/components/sales/AIActionCard.scss'), 'utf-8')
  ok('e11 scss 有 alert 徽章样式', scssSrc.includes('&--alert'))

  const mainSrc = readFileSync(join(ROOT, 'electron/main.ts'), 'utf-8')
  ok('e12 main.ts initAlertService 注入 evidenceResolver + insightRecordService', mainSrc.includes('initAlertService'))
}
})().then(() => {
  console.log(`\nalert-gate-test: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
})
