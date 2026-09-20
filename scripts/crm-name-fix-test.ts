/**
 * crm-name-fix-test.ts —— 客户名称读取侧统一 + 同名不跨会话单测
 * 覆盖：名称双轨读取侧统一（account.name 冻结 vs customer_profile.display_name 刷新）的修复：
 *   matchAccountByName 加 excludeSessionId（同名兜底不跨会话，避免多个「张总」串客户）、
 *   importCustomerFromProfile 不误补已绑定其他 session 的同名客户、无 opts 向后兼容。
 * 运行：npx tsx scripts/crm-name-fix-test.ts
 */
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { crmDbService } from '../electron/services/crmDbService'

let pass = 0, fail = 0
function ok(name: string, cond: boolean): void {
  if (cond) { pass++ } else { fail++; console.error('FAIL:', name) }
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'crm-name-fix-'))
  await crmDbService.initialize(dir)

  const now = Date.now()
  const mk = (name: string, sessionId: string | null) =>
    crmDbService.create('account', { name, session_id: sessionId, created_at: now, updated_at: now })

  // ── A. 同名不跨会话：排除已绑定其他会话的 account ──────────────────────────
  const idB = mk('张总', 'wx_B')    // 其他会话 B 的客户（bySid 未命中当前会话时才走到 name 兜底）
  const idFree = mk('张总', null)   // 未绑定会话的同名客户
  const m1 = crmDbService.matchAccountByName('张总', { excludeSessionId: 'wx_A' })
  ok('A1 排除已绑其他会话后命中未绑定的同名客户', m1 != null && Number(m1.id) === idFree)
  const m2 = crmDbService.matchAccountByName('张总')
  ok('A2 无 opts 向后兼容：仍命中第一个同名客户', m2 != null && Number(m2.id) === idB)

  // ── B. 同名只剩已绑其他会话的 → 兜底返回 null（不跨会话误关联）─────────────
  crmDbService.update('account', idFree, { session_id: 'wx_B' }) // 两个同名都绑了会话
  const m3 = crmDbService.matchAccountByName('张总', { excludeSessionId: 'wx_C' })
  ok('B1 同名都绑定其他会话时，新会话兜底不命中（不串客户）', m3 === null)

  // ── C. importCustomerFromProfile 幂等合并语义不变（跨会话防护仅用于 AI enrich）──
  // 同人多微信号 → 合并到同一 account（如「苏州鼎盛」两个微信号），AI 充实才做跨会话防护
  const idOld = mk('李经理', 'wx_old')
  crmDbService.update('account', idOld, { sales_stage: '谈判中' })
  const r = crmDbService.importCustomerFromProfile({ name: '李经理', sessionId: 'wx_new', stage: '已报价' })
  const oldAcc = crmDbService.getById('account', idOld)
  ok('C1 同名不同 session 仍合并到同一客户（幂等导入语义）', !r.created && r.id === idOld)
  ok('C2 合并时联动列更新不覆盖已有 session_id', oldAcc?.session_id === 'wx_old')
  ok('C2b 阶段单调推进：谈判中收到已报价不回退（effectiveStage 停留 negotiating）',
    r.effectiveStage === 'negotiating' && oldAcc?.sales_stage === '谈判中')
  ok('C2c 返回阶段裁决：stageChanged=false + regression-blocked',
    r.stageChanged === false && r.stageDecisionReason === 'regression-blocked')

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
