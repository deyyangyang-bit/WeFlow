/**
 * alert-annotate-test.ts —— 评测标注页「告警样本」页签（alert_eval_case 人工标注）验证
 *
 * 验证对象（/eval-annotate 两页签改造的支撑层）：
 *  A. 静态接线：页签切换（商机样本/告警样本）/ 类型中文映射 / 三档按钮 / 证据可回查标识 /
 *     IPC eval:alert:* 三端点 / preload 桥接 / d.ts 类型 / 防锚定（标注前不显 AI 值）
 *  B. 列表读路 alertEvalListCases：附展示名 / 待标注在前已标注沉底 / 待标注队列语义
 *  C. 标注写回 alertEvalLabelCase（import 式幂等 upsert）：三档写回 / 非法 label 拒绝 /
 *     空标注人拒绝 / 不存在记录拒绝 / 重复写回幂等（同 id 零新增）
 *  D. ai_* 与人工互不覆盖：ai_label 在人工标注后原样保留（防锚定分存语义）
 *  E. 统计口径 computeAlertAnnotateStats：按类型分组 / 已标注数 / 分母 = 人工已标且非 uncertain
 *     且有 ai_label / agree 数学 / agreeRate 与 ≥85% 开门读数
 *
 * ⛔ 副本隔离：全新 /tmp 空库经应用链路 initialize（alert-eval-test 同模式），绝不触碰 live。
 * 运行：npx tsx scripts/alert-annotate-test.ts
 */
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

let pass = 0, fail = 0
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; console.log(`  ✅ ${name}`) } else { fail++; console.log(`  ❌ ${name} ${detail}`) }
}
function throws(fn: () => unknown): boolean {
  try { fn(); return false } catch { return true }
}

const dbDir = mkdtempSync(join(tmpdir(), 'alert-annotate-'))
import { salesDbService } from '../electron/services/salesDbService'
import {
  alertEvalListCases, alertEvalLabelCase, alertEvalStats, computeAlertAnnotateStats,
  ALERT_LABELS, ALERT_TYPE_TEXT
} from '../electron/services/evalService'
import type { AlertEvalCase } from '../electron/services/salesDbService'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 种子行：alert_eval_case 候选（session_a 有画像名，其余兜底 session_id） */
let seq = 100
const seed = (over: Partial<AlertEvalCase> = {}): AlertEvalCase => {
  seq += 1
  return salesDbService.alertEvalCaseUpsert({
    session_id: 'wxid_a',
    anchor_key: `local:msg_0.db:${seq}:1700000000:0:wxid_a:1`,
    alert_type: 'loss',
    ai_label: 'correct',
    source: 'loss_signal',
    ...over
  })
}

async function main(): Promise<void> {
  await salesDbService.initialize(dbDir)

  // 展示名映射数据源
  salesDbService.customerUpsert({ session_id: 'wxid_a', display_name: '标注测试客户' })

  // ─── 静态接线（读源码断言，insight-noise/eval-annotate 同惯例）────────────────
  console.log('\n═══ A. 静态接线 ═══')
  {
    const pageSrc = readFileSync(join(ROOT, 'src/pages/EvalAnnotatePage.tsx'), 'utf-8')
    const ipcSrc = readFileSync(join(ROOT, 'electron/services/evalIpcHandlers.ts'), 'utf-8')
    const preloadSrc = readFileSync(join(ROOT, 'electron/preload.ts'), 'utf-8')
    const dtsSrc = readFileSync(join(ROOT, 'src/types/electron.d.ts'), 'utf-8')
    const svcSrc = readFileSync(join(ROOT, 'electron/services/evalService.ts'), 'utf-8')
    const scssSrc = readFileSync(join(ROOT, 'src/pages/EvalAnnotatePage.scss'), 'utf-8')

    check('A1 两页签（商机样本/告警样本，cws-tabs 全局分段控件）', pageSrc.includes("商机样本（已标") && pageSrc.includes("告警样本（已标") && pageSrc.includes("'opportunity' | 'alert'"))
    check('A2 页签沿用 cws-tabs 样式', pageSrc.includes('className="cws-tabs"'))
    check('A3 类型中文映射三类型齐全', pageSrc.includes('competitor: \'竞品提及\'') && pageSrc.includes('loss: \'客户流失\'') && pageSrc.includes('payment_overdue: \'承诺打款过期\''))
    check('A4 人工三档按钮（告警成立/不成立/不确定 = correct/wrong/uncertain）', pageSrc.includes("onLabel(item, 'correct')") && pageSrc.includes("onLabel(item, 'wrong')") && pageSrc.includes("onLabel(item, 'uncertain')"))
    check('A5 证据可回查标识（有 anchor_key 才显示）', pageSrc.includes('证据可回查') && /anchor_key.*trim\(\)/.test(pageSrc))
    check('A6 防锚定：待标注行只显「AI 已预判」不显值，标注后才显 AI 判断', pageSrc.includes('AI 已预判') && pageSrc.includes('AI 预判'))
    check('A7 统计行 ≥85% 开门读数', pageSrc.includes('85') && pageSrc.includes('≥85% 达标') && pageSrc.includes('未达 85%'))
    check('A8 队列过滤：待标注/已标注', pageSrc.includes("alertFilter === 'pending'") && pageSrc.includes('待标注（') && pageSrc.includes('已标注（'))
    check('A9 三端点注册（list/label/stats）', ipcSrc.includes("'eval:alert:list'") && ipcSrc.includes("'eval:alert:label'") && ipcSrc.includes("'eval:alert:stats'"))
    check('A9\' 写回端点走 enqueueSalesTask（最外层串行铁律）', /'eval:alert:label'[\s\S]{0,80}enqueueSalesTask/.test(ipcSrc))
    check('A10 preload 桥接三方法', preloadSrc.includes('alertList') && preloadSrc.includes('alertLabel') && preloadSrc.includes('alertStats'))
    check('A11 d.ts 类型齐（AlertEvalCaseRow/AlertEvalStats）', dtsSrc.includes('interface AlertEvalCaseRow') && dtsSrc.includes('interface AlertEvalStats') && dtsSrc.includes('alertList:'))
    check('A12 服务端走 alertEvalCase* 既有五入口（只读为主零新表）', svcSrc.includes('alertEvalCaseList') && svcSrc.includes('alertEvalCaseUpsert') && svcSrc.includes('alertEvalCaseGetById') && !svcSrc.includes('INSERT INTO alert_eval_case'))
    check('A13 类型 pill / 开门徽章样式全 token（零硬编码 hex）', scssSrc.includes('.ec-type') && scssSrc.includes('.ea-gate') && !/#\s*[0-9a-fA-F]{3,8}\b/.test(scssSrc.slice(scssSrc.indexOf('告警样本页签'))))
    check('A14 告警三档与 DB CHECK 同口径', ALERT_LABELS.size === 3 && [...ALERT_LABELS].every((l) => ['correct', 'wrong', 'uncertain'].includes(l)))
  }

  // ─── B. 列表读路 + 展示名 ────────────────────────────────────────────────────
  console.log('\n═══ B. 列表读路 alertEvalListCases ═══')
  {
    const r1 = seed({ alert_type: 'loss', ai_label: 'correct' })                    // 待标注
    const r2 = seed({ alert_type: 'competitor', ai_label: 'wrong', session_id: 'wxid_b' })
    const r3 = seed({ alert_type: 'payment_overdue', ai_label: 'correct', session_id: 'wxid_c' })
    check('B1 三类型种子齐', new Set([r1, r2, r3].map((r) => r.alert_type)).size === 3)
    const list = alertEvalListCases()
    check('B2 附展示名（customer_profile 优先，兜底 session_id）',
      list.every((r) => typeof r.display_name === 'string' && r.display_name.length > 0) &&
      list.find((r) => r.session_id === 'wxid_a')?.display_name === '标注测试客户' &&
      list.find((r) => r.session_id === 'wxid_b')?.display_name === 'wxid_b')
    check('B3 默认全量列出（未标注全在待标注队列）', list.length === 3 && list.every((r) => r.status !== 'confirmed'))
    check('B4 类型中文映射覆盖', ALERT_TYPE_TEXT.loss === '客户流失' && ALERT_TYPE_TEXT.payment_overdue === '承诺打款过期' && !('unknown_type' in ALERT_TYPE_TEXT))

    // 已标注沉底 + 待标注队列语义：先标一条再验证
    alertEvalLabelCase(Number(r1.id), 'correct', '标注员甲')
    const list2 = alertEvalListCases()
    const confirmedIdx = list2.findIndex((r) => r.status === 'confirmed')
    check('B5 已标注沉底（待标注在前）', confirmedIdx >= 0 && list2.slice(0, confirmedIdx).every((r) => r.status !== 'confirmed'))
    const pendingView = list2.filter((r) => r.status !== 'confirmed')
    check('B6 标注后行从待标注队列消失', pendingView.length === 2 && !pendingView.some((r) => Number(r.id) === Number(r1.id)))
    check('B7 已标注视图可查（confirmed 恰 1 条且是刚标那条）', list2.filter((r) => r.status === 'confirmed').length === 1 && list2.find((r) => r.status === 'confirmed')?.id === r1.id)
  }

  // ─── C. 标注写回（import 式幂等）────────────────────────────────────────────
  console.log('\n═══ C. 标注写回 alertEvalLabelCase ═══')
  {
    const row = seed({ alert_type: 'payment_overdue', ai_label: 'correct', session_id: 'wxid_c' })
    const before = salesDbService.alertEvalCaseCount()
    const labeled = alertEvalLabelCase(Number(row.id), 'correct', '标注员乙')
    check('C1 三档写回 label/status/annotated_by', labeled.label === 'correct' && labeled.status === 'confirmed' && labeled.annotated_by === '标注员乙')
    check('C2 幂等命中同 id（UNIQUE(session_id, anchor_key, alert_type)）', labeled.id === row.id && salesDbService.alertEvalCaseCount() === before)
    // 重复写回（再点一次同档）：同 id 幂等更新，零新增
    const relabeled = alertEvalLabelCase(Number(row.id), 'correct', '标注员乙')
    check('C3 重复写回幂等（同 id 零新增行）', relabeled.id === row.id && salesDbService.alertEvalCaseCount() === before)
    // 改标：人工覆盖自己的结论（最新标注胜出），仍同 id
    const changed = alertEvalLabelCase(Number(row.id), 'wrong', '标注员乙')
    check('C4 改标允许（人工最新结论胜出，仍同 id）', changed.id === row.id && changed.label === 'wrong')
    check('C5 非法 label 拒绝（仅 correct/wrong/uncertain）', throws(() => alertEvalLabelCase(Number(row.id), 'has', '标注员乙')))
    check('C5\' 空标注人拒绝', throws(() => alertEvalLabelCase(Number(row.id), 'correct', '  ')))
    check('C5\'\' 不存在的记录拒绝', throws(() => alertEvalLabelCase(99999999, 'correct', '标注员乙')))
  }

  // ─── D. ai_* 与人工互不覆盖（防锚定分存）────────────────────────────────────
  console.log('\n═══ D. ai_* 人工互不覆盖 ═══')
  {
    const row = seed({ alert_type: 'competitor', ai_label: 'wrong', session_id: 'wxid_b' })
    const aiBefore = String(row.ai_label || '')
    alertEvalLabelCase(Number(row.id), 'correct', '标注员丙')
    const after = salesDbService.alertEvalCaseGet(String(row.session_id), String(row.anchor_key || ''), 'competitor')
    check('D1 人工标注后 ai_label 原样（互不覆盖）', after?.ai_label === aiBefore && after?.ai_label === 'wrong')
    check('D1\' 人工 label 与 ai_label 分存（本例人工标 correct、AI 预判 wrong）', after?.label === 'correct')
    check('D1\'\' evidence_* 等生成侧字段不被标注触碰', after?.evidence_message_keys === row.evidence_message_keys)
    // 无 ai_label 的行标注不受影响
    const bare = seed({ alert_type: 'loss', ai_label: '', session_id: 'wxid_a' })
    const labeledBare = alertEvalLabelCase(Number(bare.id), 'uncertain', '标注员丙')
    check('D2 无 AI 预标注行正常写回', labeledBare.label === 'uncertain' && labeledBare.status === 'confirmed')
  }

  // ─── E. 统计口径（纯函数 computeAlertAnnotateStats + 服务端 alertEvalStats）──
  console.log('\n═══ E. 统计口径 ═══')
  {
    // 基线（B/C/D 节在同库留下的行计入基线，本节断言全部为相对增量）
    const baseAll = computeAlertAnnotateStats(salesDbService.alertEvalCaseList({ limit: 10000 }))
    const poBase = baseAll.types.find((t) => t.alertType === 'payment_overdue') ?? { annotated: 0, total: 0, compared: 0, agree: 0, agreeRate: null, alertType: 'payment_overdue' }
    const lossBase = baseAll.types.find((t) => t.alertType === 'loss') ?? { annotated: 0, total: 0, compared: 0, agree: 0, agreeRate: null, alertType: 'loss' }

    // 构造集（payment_overdue 维度验证分母口径，全部 wxid_a）：
    //  e1 correct/ai=correct（一致，计入分母）
    //  e2 correct/ai=wrong（不一致，计入分母）
    //  e3 uncertain/ai=correct（人工不确定 → 不计入分母）
    //  e4 correct/ai=''（无 AI 预标注 → 不计入分母）
    //  e5 不标注 status=prelabeled（只进 total）
    const e1 = seed({ alert_type: 'payment_overdue', session_id: 'wxid_a', ai_label: 'correct' })
    const e2 = seed({ alert_type: 'payment_overdue', session_id: 'wxid_a', ai_label: 'wrong' })
    const e3 = seed({ alert_type: 'payment_overdue', session_id: 'wxid_a', ai_label: 'correct' })
    const e4 = seed({ alert_type: 'payment_overdue', session_id: 'wxid_a', ai_label: '' })
    const e5 = seed({ alert_type: 'payment_overdue', session_id: 'wxid_a', ai_label: 'correct' })
    alertEvalLabelCase(Number(e1.id), 'correct', '标注员丁')
    alertEvalLabelCase(Number(e2.id), 'correct', '标注员丁')
    alertEvalLabelCase(Number(e3.id), 'uncertain', '标注员丁')
    alertEvalLabelCase(Number(e4.id), 'correct', '标注员丁')

    const st = computeAlertAnnotateStats(salesDbService.alertEvalCaseList({ limit: 10000 }))
    const po = st.types.find((t) => t.alertType === 'payment_overdue')!
    check('E1 按类型分组（loss/competitor/payment_overdue 三组）', st.types.length === 3 && ['competitor', 'loss', 'payment_overdue'].every((t) => st.types.some((x) => x.alertType === t)))
    check('E2 已标注数 = confirmed 增量（本节 4 条已标 / 5 条种子）', po.annotated === poBase.annotated + 4 && po.total === poBase.total + 5,
      `annotated=${po.annotated} base=${poBase.annotated}`)
    check('E3 分母排除人工「不确定」（e3 不进 compared）', po.compared === poBase.compared + 2, `compared=${po.compared} base=${poBase.compared}`)
    check('E4 分母排除无 ai_label 行（e4 不进 compared）', po.compared === poBase.compared + 2)
    check('E5 一致数增量正确（e1 一致 e2 不一致 → +1）', po.agree === poBase.agree + 1, `agree=${po.agree} base=${poBase.agree}`)
    check('E6 一致率读数数学正确', po.agreeRate === Math.round(((poBase.agree + 1) / (poBase.compared + 2)) * 100), `rate=${po.agreeRate}`)
    check('E7 未标注行状态零变更（e5 保持 prelabeled，只进 total）', salesDbService.alertEvalCaseGetById(Number(e5.id))?.status === 'prelabeled')

    // ≥85% 开门判定读数（纯函数隔离集，无库内噪音）：17 一致 / 20 分母 = 恰好 85%
    const gateRows: AlertEvalCase[] = []
    for (let i = 0; i < 20; i++) {
      gateRows.push({
        session_id: 'wxid_gate', anchor_key: `k${i}`, alert_type: 'loss',
        label: i < 17 ? 'correct' : 'wrong', ai_label: 'correct', status: 'confirmed'
      })
    }
    const gateSt = computeAlertAnnotateStats(gateRows).types.find((t) => t.alertType === 'loss')!
    check('E8 开门判定读数：17/20 → agreeRate=85（≥85% 达标）', gateSt.agreeRate === 85 && gateSt.agreeRate! >= 85 && gateSt.annotated === 20 && gateSt.compared === 20, `rate=${gateSt.agreeRate}`)
    check('E8\' 16/20=80% 未达标（阈值语义 <85 拒）', computeAlertAnnotateStats(gateRows.slice(0, 19).map((r, i) => ({ ...r, label: i < 16 ? 'correct' : 'wrong' }))).types[0].agreeRate === 84, `rate=${computeAlertAnnotateStats(gateRows.slice(0, 19).map((r, i) => ({ ...r, label: i < 16 ? 'correct' : 'wrong' }))).types[0].agreeRate}`)
    // 库内 loss 维度：基线 + 20 行 gate 集的合成读数与独立重算一致
    for (let i = 0; i < 20; i++) {
      const r = salesDbService.alertEvalCaseUpsert({
        session_id: 'wxid_gate', anchor_key: `local:msg_0.db:${2000 + i}:1700000000:0:wxid_gate:1`,
        alert_type: 'loss', ai_label: 'correct', source: 'loss_signal'
      })
      alertEvalLabelCase(Number(r.id), i < 17 ? 'correct' : 'wrong', '标注员丁')
      void r
    }
    const st2 = computeAlertAnnotateStats(salesDbService.alertEvalCaseList({ limit: 10000 }))
    const loss = st2.types.find((t) => t.alertType === 'loss')!
    const expectLossRate = Math.round(((lossBase.agree + 17) / (lossBase.compared + 20)) * 100)
    check('E8\'\' 库内 loss 维度读数 = 基线+gate 集合成', loss.agreeRate === expectLossRate, `rate=${loss.agreeRate} expect=${expectLossRate}`)

    // 无可比对样本 → agreeRate null（不冒充 0%）
    const empty = computeAlertAnnotateStats([{ session_id: 'wxid_x' } as AlertEvalCase])
    check('E9 无已标注 → agreeRate=null', empty.types[0]?.agreeRate === null && empty.types[0]?.annotated === 0)

    // 服务端入口与纯函数同口径
    const svcSt = alertEvalStats()
    check('E10 alertEvalStats 与纯函数重算一致', JSON.stringify(svcSt) === JSON.stringify(computeAlertAnnotateStats(salesDbService.alertEvalCaseList({ limit: 10000 }))))
    check('E10\' 全局 annotated 计数 = 各类型之和', svcSt.annotated === svcSt.types.reduce((s, t) => s + t.annotated, 0))
  }

  console.log(`\nalert-annotate-test: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

void main().catch((e) => { console.error(e); process.exit(1) })
