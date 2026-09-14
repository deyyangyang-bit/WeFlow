/**
 * crm-sla-action-test.ts —— SLA/Action 接通单测（P0-D）
 * 覆盖：SLA 扫描接入 Action 引擎扫描周期 ——
 *   runFullScan（每日 08:00）触发 SLA 扫描、runFullScan 清理不误伤 SLA 卡（created_by='sla' 独立）、
 *   显式 scanLeadSla 幂等、完成卡回写 lead 状态；getUnifiedSignals 为纯读、不触发 SLA 扫描。
 *
 * 行为变更出处（1f/1g2）：F1「消除嵌套排队、拆开读取和扫描」——getUnifiedSignals 改为纯读
 *   （全程无 enqueue、无模型调用、无扫描副作用），SLA 扫描改由 runFullScan / 显式 scanLeadSla 承担。
 *   引入于 c325179（feat(ai): AI 见解、用量账本与今日行动）；设计见
 *   docs/规划/AI见解-CRM-今日行动联合优化方案.md §F1；盘点见
 *   docs/规划/两份优化方案收口计划-20260912.md §1.2（明示「crm-sla-action-test.ts:54-56 断言与新行为矛盾」）。
 *   2026-09-13 归因：原 1f/1g2 断言 getUnifiedSignals 触发 SLA 扫描，与 F1 契约相反，故改写为
 *   「纯读不出卡」+「显式扫描才出卡」——等价强度：第三条到期线索仍被验证能出卡，仅入口由隐式改显式。
 * 运行：npx tsx scripts/crm-sla-action-test.ts
 */
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { crmDbService } from '../electron/services/crmDbService'
import { salesDbService } from '../electron/services/salesDbService'
import { importLeads, scanLeadSla, completeLeadFirstContact } from '../electron/services/crmLeadService'
import { runFullScan, getUnifiedSignals } from '../electron/services/salesActionEngine'

let pass = 0, fail = 0
function ok(name: string, cond: boolean): void {
  if (cond) { pass++ } else { fail++; console.error('FAIL:', name) }
}

function slaCards(): any[] {
  return salesDbService.todoList({ status: 'pending', limit: 50 }).filter((t: any) => t.trigger_type === 'sla_lead')
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'crm-sla-action-'))
  await crmDbService.initialize(dir)
  await salesDbService.initialize(dir)

  // ── 准备：导入 3 条线索，前两条 deadline 改为已超时 ───────────────────────
  importLeads('抖音', 'sla.xlsx', [
    { text: '张三 13800138000' },
    { text: '李四 13900139000' },
    { text: '王五 13700137000' }
  ])
  const leads = crmDbService.all('SELECT * FROM lead ORDER BY id')
  ok('1a 导入 3 条线索', leads.length === 3)
  crmDbService.update('lead', Number(leads[0].id), { first_contact_deadline: Date.now() - 2 * 3600_000 })
  crmDbService.update('lead', Number(leads[1].id), { first_contact_deadline: Date.now() - 2 * 3600_000 })
  ok('1b 扫描前无 SLA 卡（导入时未超时）', slaCards().length === 0)

  // ── 接通点 1：runFullScan（每日 08:00 全量扫描）触发 SLA 扫描 ──────────────
  await runFullScan()
  ok('1c runFullScan 触发 SLA：2 条超时线索出卡', slaCards().length === 2)

  // ── 接通点 2：runFullScan 清理不误伤 SLA 卡（created_by=sla 独立于 action_engine）─
  await runFullScan()
  ok('1d 二次 runFullScan 后 SLA 卡仍 pending（不被 superseded）', slaCards().length === 2)

  // ── 幂等：显式 scanLeadSla 不重复建卡 ──────────────────────────────────────
  ok('1e SLA 扫描幂等', scanLeadSla() === 0 && slaCards().length === 2)

  // ── 接通点 3：getUnifiedSignals（今日行动页主数据源）为纯读，不触发 SLA 扫描 ──
  // F1：getUnifiedSignals 全程无 enqueue / 无模型调用 / 无扫描副作用（出处见文件头）
  crmDbService.update('lead', Number(leads[2].id), { first_contact_deadline: Date.now() - 3600_000 })
  const unified = await getUnifiedSignals()
  ok('1f getUnifiedSignals 纯读：第三条到期线索不出卡（F1 无扫描副作用）', slaCards().length === 2)
  ok('1g 主卡流不含 lead: 首触卡（散任务只在右侧侧栏，避免重影）', !unified.signals.some((s: any) => String(s.sessionId).startsWith('lead:')))
  ok('1g2 显式 scanLeadSla 后第三条出卡（扫描行为本身仍有效，卡留在 todoList 散任务源）', scanLeadSla() === 1 && slaCards().length === 3)

  // ── 闭环：完成 SLA 卡 → lead 置 CONTACTED ──────────────────────────────────
  const card = slaCards().find((c) => Number(c.source_id) === Number(leads[0].id))
  ok('1h 找到线索 1 的 SLA 卡', !!card)
  if (card?.id) {
    completeLeadFirstContact(Number(card.id))
    ok('1i 完成卡后 lead=CONTACTED', crmDbService.getById('lead', Number(leads[0].id))?.status === 'CONTACTED')
    ok('1j 完成卡后卡不再是 pending', slaCards().length === 2)
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
