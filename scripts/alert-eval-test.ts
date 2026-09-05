/**
 * alert-eval-test.ts —— 告警评测基建 + 告警 B 识别规则单测（设计-AI见解重定位 §4.3/§4.2 B）
 * 覆盖：
 *  a. alert_eval_case 建表（CHECK 硬门禁）/ UNIQUE(session_id, anchor_key, alert_type) / 幂等 upsert（ai_* 与人工字段分存）
 *  b. 四方法：alertEvalCaseUpsert / Get / List（alert_type/status 过滤）/ Count（按类型分组口径）
 *  c. parseLossSignal：命中（不买了/找别家/已经买了…）/ 排除（我方消息、<4 字、正常询价不误判）
 *  d. 接线守卫：parseLossSignal 未接 crmParseService 告警链（§4.1 第 4 条：评测 ≥85% 前禁止接线）
 *  e. export 脚本：/tmp 副本零写（源库 sha256 不变静态核验）+ 输出包结构
 * 运行：npx tsx scripts/alert-eval-test.ts
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

let pass = 0, fail = 0
function ok(name: string, cond: boolean): void {
  if (cond) { pass++ } else { fail++; console.error('FAIL:', name) }
}

const isoDir = mkdtempSync(join(tmpdir(), 'alert-eval-'))
process.env.WEFLOW_USER_DATA_PATH = isoDir
process.env.WEFLOW_CONFIG_CWD = isoDir

import { salesDbService } from '../electron/services/salesDbService'
import { parseLossSignal } from '../electron/services/crmParseRules'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

async function main(): Promise<void> {
  // ─── a. 建表 + CHECK + UNIQUE + 幂等 upsert ────────────────────────────────
  const dbDir = mkdtempSync(join(tmpdir(), 'alert-eval-db-'))
  await salesDbService.initialize(dbDir)

  const first = salesDbService.alertEvalCaseUpsert({
    session_id: 'wxid_a', anchor_key: 'local:msg_0.db:11:1700000000:0:wxid_a:1', alert_type: 'loss',
    ai_label: 'correct', evidence_text: '不买了，找别家了', source: 'loss_signal'
  })
  ok('a1 插入成功且默认 status=prelabeled（仅 AI 预标注）', first.id !== undefined && first.status === 'prelabeled')

  // CHECK 硬门禁：非法 label / status 拒绝
  let checkRejected = 0
  try { salesDbService.alertEvalCaseUpsert({ session_id: 'x', anchor_key: 'k', alert_type: 'loss', label: 'has' }) } catch { checkRejected++ }
  try { salesDbService.alertEvalCaseUpsert({ session_id: 'x', anchor_key: 'k', alert_type: 'loss', status: 'done' }) } catch { checkRejected++ }
  ok('a2 CHECK 拦截非法 label/status（ai_label 同口径）', checkRejected === 2)

  // 幂等 upsert：同 (session_id, anchor_key, alert_type) 命中更新；ai_* 与人工字段分存互不覆盖
  const upd = salesDbService.alertEvalCaseUpsert({
    session_id: 'wxid_a', anchor_key: 'local:msg_0.db:11:1700000000:0:wxid_a:1', alert_type: 'loss',
    label: 'correct', annotated_by: '主管甲', status: 'confirmed', updated_by: '主管甲'
  })
  ok('a3 幂等命中同一行', upd.id === first.id)
  ok('a4 人工确认落库 status=confirmed', upd.label === 'correct' && upd.status === 'confirmed' && upd.annotated_by === '主管甲')
  ok('a5 ai_* 未被人工字段覆盖', upd.ai_label === 'correct')

  // UNIQUE 三维键：同 session 同 anchor 不同 alert_type 是两行
  salesDbService.alertEvalCaseUpsert({ session_id: 'wxid_a', anchor_key: 'local:msg_0.db:11:1700000000:0:wxid_a:1', alert_type: 'competitor' })
  ok('a6 alert_type 维度独立成行（per-type 评测）', salesDbService.alertEvalCaseCount() === 2)

  // ─── b. Get / List / Count ────────────────────────────────────────────────
  ok('b1 alertEvalCaseGet 按幂等键命中',
    salesDbService.alertEvalCaseGet('wxid_a', 'local:msg_0.db:11:1700000000:0:wxid_a:1', 'loss')?.id === first.id)
  ok('b2 alertEvalCaseGet 键不匹配 → undefined',
    salesDbService.alertEvalCaseGet('wxid_a', 'local:msg_0.db:11:1700000000:0:wxid_a:1', 'price') === undefined)
  ok('b3 alertEvalCaseGetById 命中', salesDbService.alertEvalCaseGetById(first.id!)?.label === 'correct')
  const lossList = salesDbService.alertEvalCaseList({ alert_type: 'loss', status: 'confirmed' })
  ok('b4 List 按 alert_type+status 过滤', lossList.length === 1 && lossList[0].alert_type === 'loss')
  ok('b5 Count 分组口径（loss confirmed=1，competitor 全量=1）',
    salesDbService.alertEvalCaseCount('loss', 'confirmed') === 1 && salesDbService.alertEvalCaseCount('competitor') === 1)

  // ─── c. parseLossSignal ───────────────────────────────────────────────────
  // 命中：明示拒绝
  for (const [i, t] of ['这台不买了', '不用了谢谢', '不需要了', '已经买了别家的', '找别家了', '在别家订了一台', '我已经订了', '别家买更便宜'].entries()) {
    ok(`c1.${i + 1} 命中流失：「${t}」`, parseLossSignal(t, 0)?.type === 'loss')
  }
  // 排除：我方消息不触发
  ok('c2 我方消息（isSend=1）不触发', parseLossSignal('不买了', 1) === null)
  ok('c3 我方消息（isSend=2）不触发', parseLossSignal('不买了', 2) === null)
  // 排除：<4 字跳过（parseRiskSignal 同型口径）
  ok('c4 <4 字跳过', parseLossSignal('不买了', 0) === null && parseLossSignal('不用了', 0) === null)
  // 排除：正常询价/噪音不误判
  const noise = ['这台多少钱', '有什么优惠', '载重多少吨', '保修几年啊', '能发个配置单吗', '明天方便看车吗', '价格能不能再商量']
  for (const [i, t] of noise.entries()) {
    ok(`c5.${i + 1} 不误判：「${t}」`, parseLossSignal(t, 0) === null)
  }
  // detail = 原话快照 ≤100 字
  ok('c6 detail 快照 ≤100 字', (parseLossSignal('很'.repeat(120) + '不买了', 0)?.detail.length ?? 0) <= 100)
  // 表情 bracket 清洗同 risk 口径（清洗后仍需 ≥4 字，与 parseRiskSignal 口径一致）
  ok('c7 [表情] 清洗后仍命中', parseLossSignal('[微笑]这个不买了', 0)?.type === 'loss')

  // ─── d. 接线守卫：B 未接告警链（评测达标前禁止） ─────────────────────────────
  const parseSrc = readFileSync(join(ROOT, 'electron/services/crmParseService.ts'), 'utf-8')
  ok('d1 parseLossSignal 未在 crmParseService 接线', !parseSrc.includes('parseLossSignal'))
  ok('d2 parseLossSignal 导出自 crmParseRules', readFileSync(join(ROOT, 'electron/services/crmParseRules.ts'), 'utf-8').includes('export function parseLossSignal'))
  // competitor 仍接线（告警 A 已上线）
  ok('d3 competitor 告警链保持接线', parseSrc.includes("type: 'competitor'"))

  // ─── e. export 脚本：零写核验 + 包结构 ─────────────────────────────────────
  const evalSrc = readFileSync(join(ROOT, 'scripts/alert-eval.ts'), 'utf-8')
  ok('e1 export 有 sha256 零写核验', evalSrc.includes('sha256') && evalSrc.includes('源库哈希变化'))
  ok('e2 export 副本隔离（/tmp mkdtemp）', evalSrc.includes('mkdtempSync'))
  ok('e3 负样本对照存在（准确率需要）', evalSrc.includes('no_loss_sample'))
  ok('e4 import 幂等 upsert + 非法进失败清单', evalSrc.includes('alertEvalCaseUpsert') && evalSrc.includes('failures.push'))
  ok('e5 群聊排除（D7 口径）', evalSrc.includes('@chatroom'))
  ok('e6 证据 ≤200 字快照', evalSrc.includes('EVIDENCE_TEXT_MAX = 200'))
  ok('e7 import 推送门准确率 ≥85% 判定输出', evalSrc.includes('85'))
  // dump → parseLossSignal 端到端小样本（直接调函数模拟 export 内循环口径）
  const dumpRow = { session_id: 'wxid_b', message_key: 'local:msg_0.db:99:1700000001:0:wxid_b:1', is_send: 0, content: '不需要了，你们太贵了' }
  ok('e8 dump 行端到端命中', parseLossSignal(String(dumpRow.content), Number(dumpRow.is_send))?.type === 'loss')

  salesDbService.close()

  console.log(`\nalert-eval-test: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

void main()
