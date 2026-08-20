/**
 * crm-timeline-test.ts —— Customer 360 统一时间线（accountTimeline）单测
 * 覆盖：8 个 UNION 分支聚合正确 —— activity_log 六实体（account/contract/logistics/quotation/allocation/payment_record）
 *      + lead_activity（线索流转）+ opportunity_event（商机事件），时间升序、跨客户隔离。
 * 运行：npx tsx scripts/crm-timeline-test.ts
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
  const dir = mkdtempSync(join(tmpdir(), 'crm-timeline-'))
  await crmDbService.initialize(dir)

  // ── 客户 A：构造 6 实体业务动作 + 线索流转 + 商机事件 ─────────────────────
  const a = crmDbService.ensureAccount('测试科技有限公司')
  crmDbService.logActivity('account', a, 'created', '客户建档')

  // 合同（挂 account）→ 合同动作
  const cid = crmDbService.create('contract', {
    account_id: a, name: 'A-合同', amount: 100, status: 'pending_sign',
    created_at: Date.now(), updated_at: Date.now()
  })
  crmDbService.logActivity('contract', cid, 'signed', '合同已签约 ¥100')

  // 物流（挂 contract → account）→ 物流动作
  const lid = crmDbService.create('logistics', { tracking_no: 'YT001', contract_id: cid, created_at: Date.now() })
  crmDbService.logActivity('logistics', lid, 'shipped', '已发货 YT001')

  // 报价（挂 contract → account）→ 报价动作
  const qid = crmDbService.create('quotation', { contract_id: cid, total: 100, created_at: Date.now() })
  crmDbService.logActivity('quotation', qid, 'quoted', '已报价 ¥100')

  // 到款 + 归属（均挂 account）→ 到款动作 / 归属动作
  const payId = crmDbService.createPaymentRecord({ payer: '测试科技', amount_net: 100, created_at: Date.now() })
  const allocId = crmDbService.create('allocation', {
    payment_record_id: payId, account_id: a, amount_hint: 100,
    status: 'confirmed', created_at: Date.now()
  })
  crmDbService.logActivity('allocation', allocId, 'confirmed', '归属确认 ¥100')
  crmDbService.logActivity('payment_record', payId, 'approved', '确认到款 ¥100')

  // 线索（挂 account）+ 线索流转动作
  const leadId = crmDbService.create('lead', {
    contact_type: 'phone', contact_normalized: '13800000001', source: '抖音',
    account_id: a, first_contact_deadline: Date.now(), created_at: Date.now()
  })
  crmDbService.create('lead_activity', { lead_id: leadId, action: 'claimed', note: '线索领取', created_at: Date.now() })

  // 商机（挂 account）+ 商机事件
  const oppId = crmDbService.create('opportunity', { account_id: a, name: 'A-采购', stage: '了解', created_at: Date.now() })
  crmDbService.opportunityEventAdd(oppId, 'created', '了解', 'AI 识别采购信号：A 要采购')

  // ── 客户 B：孤立客户（无任何活动），用于跨客户隔离验证 ─────────────────────
  const b = crmDbService.ensureAccount('孤岛贸易公司')

  const tl = crmDbService.accountTimeline(a)
  const texts = tl.map((t) => t.text).join('|')
  ok('1 account 动作进入时间线', tl.some((t) => t.kind === 'crm' && t.text === '客户建档'))
  ok('2 合同动作进入时间线（经 account_id）', texts.includes('合同已签约'))
  ok('3 物流动作进入时间线（经 contract→account）', texts.includes('已发货 YT001'))
  ok('4 报价动作进入时间线（经 contract→account）', texts.includes('已报价 ¥100'))
  ok('5 归属动作进入时间线', texts.includes('归属确认'))
  ok('6 到款动作进入时间线（经 allocation→payment_record）', texts.includes('确认到款'))
  ok('7 线索流转进入时间线（kind=lead）', tl.some((t) => t.kind === 'lead' && t.text === '线索领取'))
  ok('8 商机事件进入时间线（kind=opportunity）', tl.some((t) => t.kind === 'opportunity' && t.text.includes('AI 识别采购信号')))
  ok('9 时间升序返回', tl.every((t, i) => i === 0 || t.at >= tl[i - 1].at))
  ok('10 跨客户隔离：B 的 timeline 为空', crmDbService.accountTimeline(b).length === 0)

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
