/**
 * crm-autoconfirm-test.ts —— 确认中心自动确认引擎判定矩阵 + 执行/回滚副作用单测
 * 运行：npx tsx scripts/crm-autoconfirm-test.ts
 *
 * 覆盖：归属/到款/物流/发票四队列判定、applyDecision 副作用、金额文件名提取、
 *       docgen 注入、runAutoConfirmNow 编排、快照、总开关、undo 回滚。
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import initSqlJs from 'sql.js'
import { crmDbService, type CrmRow } from '../electron/services/crmDbService'
import {
  evaluateAllocation, evaluatePayment, evaluateLogistics, evaluateInvoice,
  applyDecision, runAutoConfirmNow, undoAutoConfirm,
  setAutoConfirmConfig, setDocgenRunner
} from '../electron/services/crmAutoConfirmService'
import { extractInvoiceAmountFromName } from '../electron/services/crmParseRules'

let pass = 0, fail = 0
const ok = (name: string, cond: boolean): void => { if (cond) pass++; else { fail++; console.error('FAIL:', name) } }

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'autoconfirm-'))
  await crmDbService.initialize(dir)

  // ─── 数据构造 helper ───────────────────────────────────────────────────────
  const mkAccount = (name: string, extra: CrmRow = {}): number =>
    crmDbService.create('account', { name, created_at: Date.now(), updated_at: Date.now(), ...extra })
  const mkContract = (accountId: number, extra: CrmRow = {}): number =>
    crmDbService.create('contract', { account_id: accountId, name: `合同${accountId}`, amount: 10000, status: 'signed', custom_fields: '{}', created_at: Date.now(), updated_at: Date.now(), ...extra })
  const mkPayment = (payer: string, extra: CrmRow = {}): number =>
    crmDbService.create('payment_record', { payer, amount_net: 7600, source: 'bank_text', pay_channel: 'bank_direct', needs_review: 0, raw_content: '', created_at: Date.now(), ...extra })
  const mkAllocation = (paymentId: number, customerHint: string, extra: CrmRow = {}): number =>
    crmDbService.create('allocation', { payment_record_id: paymentId, customer_hint: customerHint, sales_hint: '', amount_hint: 7600, credited_amount: 7600, status: 'pending', created_at: Date.now(), ...extra })
  const mkLogistics = (receiver: string, city: string, extra: CrmRow = {}): number =>
    crmDbService.create('logistics', { tracking_no: 'SF1234567890', brand: '顺丰', receiver, city, status: 'shipped', link_status: 'unlinked', created_at: Date.now(), ...extra })
  const mkInvoice = (buyer: string, amount: number, extra: CrmRow = {}): number =>
    crmDbService.create('invoice', { buyer, amount, status: 'pre_issue', created_at: Date.now(), ...extra })
  const get = (id: number): CrmRow => crmDbService.getById('allocation', id) ?? {}
  const getAny = (entity: string, id: number): CrmRow => crmDbService.getById(entity, id) ?? {}

  // ─── 归属判定 ──────────────────────────────────────────────────────────────
  {
    const acc = mkAccount('上海普绿包装制品有限公司')
    mkContract(acc)
    const pid = mkPayment('江苏银行转出方')
    const aid = mkAllocation(pid, '上海普绿包装制品有限公司')
    const d = evaluateAllocation(get(aid), {})
    ok('A1 精确命中+有合同 → auto 0.95', d.decision === 'auto_confirm' && d.confidence === 0.95 && d.action === 'confirmAllocation')
    ok('A1 payload 挂客户+合同', d.payload?.account_id === acc && typeof d.payload?.contract_id === 'number')
    const r = applyDecision(d)
    const a = get(aid)
    ok('A1 执行后 confirmed+挂合同', r.ok && a.status === 'confirmed' && a.contract_id === d.payload?.contract_id)
    ok('A1 creditedTotal 正确', crmDbService.creditedTotal(Number(d.payload?.contract_id)) === 7600)
    const acts = crmDbService.all('SELECT * FROM activity_log WHERE entity=? AND entity_id=? AND action=?', ['allocation', aid, 'confirmed'])
    ok('A1 activity operator=auto', acts.length > 0 && String(acts[0].operator) === 'auto')
    ok('A1 幂等（再次执行被 pending 守卫拦截）', applyDecision(d).ok === false)
  }
  {
    const acc = mkAccount('无锡库叉')
    const pid = mkPayment('X')
    const aid = mkAllocation(pid, '无锡库叉')
    const d = evaluateAllocation(get(aid), {})
    ok('A2 精确命中+无合同 → review', d.decision === 'needs_review' && d.reason.includes('无可挂合同'))
    void acc
  }
  {
    const acc = mkAccount('常州中力叉车设备有限公司')
    mkContract(acc)
    const pid = mkPayment('Y')
    const aid = mkAllocation(pid, '常州中力叉车')
    const d = evaluateAllocation(get(aid), {})
    ok('A3 前缀唯一 → auto 0.85', d.decision === 'auto_confirm' && d.confidence === 0.85)
  }
  {
    const acc = mkAccount('深圳市晶恒科技有限公司')
    mkContract(acc)
    crmDbService.aliasLearn('晶恒', acc)
    const pid = mkPayment('Z')
    const aid = mkAllocation(pid, '晶恒')
    const d = evaluateAllocation(get(aid), {})
    ok('A4 别名唯一 → auto', d.decision === 'auto_confirm' && d.confidence === 0.85)
  }
  {
    const acc = mkAccount('杭州临安实业')
    mkContract(acc)
    crmDbService.saveShippingInfo({ account_id: acc, receiver: '宋群雄', phone: '', address: '', city: '杭州市', source_msg_id: 's1', created_at: Date.now() })
    const pid = mkPayment('W')
    const aid = mkAllocation(pid, '宋群雄')
    const d = evaluateAllocation(get(aid), {})
    ok('A5 收货人唯一 → auto', d.decision === 'auto_confirm' && d.confidence === 0.85)
  }
  {
    mkAccount('浙江启航机械有限公司')
    mkAccount('浙江启航液压设备有限公司')
    const pid = mkPayment('V')
    const aid = mkAllocation(pid, '启航')
    const d = evaluateAllocation(get(aid), {})
    ok('A6 多候选 → review', d.decision === 'needs_review' && d.reason.includes('多候选'))
  }
  {
    const pid = mkPayment('P', { needs_review: 1 })
    const aid = mkAllocation(pid, '上海普绿包装制品有限公司')
    const d = evaluateAllocation(get(aid), {})
    ok('A7 父到款待审 → review', d.decision === 'needs_review' && d.reason.includes('到款'))
  }
  {
    const pid = mkPayment('P2', { amount_net: 100 })
    mkAllocation(pid, '上海普绿包装制品有限公司', { amount_hint: 80, credited_amount: 80, status: 'confirmed', confirmed_at: Date.now() })
    const aid = mkAllocation(pid, '上海普绿包装制品有限公司', { amount_hint: 50, credited_amount: 50 })
    const d = evaluateAllocation(get(aid), {})
    ok('A8 金额超付 → review', d.decision === 'needs_review' && d.reason.includes('金额'))
  }
  {
    const pid = mkPayment('P3')
    const aid = mkAllocation(pid, '上海普绿包装制品有限公司', { amount_hint: 0, credited_amount: 0 })
    const d = evaluateAllocation(get(aid), {})
    ok('A9 金额为0 → review', d.decision === 'needs_review')
  }
  {
    const pid = mkPayment('P4')
    const aid = mkAllocation(pid, '')
    const d = evaluateAllocation(get(aid), {})
    ok('A10 无线索 → review', d.decision === 'needs_review')
  }

  // ─── 到款判定 ──────────────────────────────────────────────────────────────
  {
    const pid = mkPayment('上海普绿包装制品有限公司', { source: 'bank_text' })
    const d = evaluatePayment(getAny('payment_record', pid), {})
    ok('P1 bank 精确 → auto 0.95', d.decision === 'auto_confirm' && d.confidence === 0.95 && d.action === 'approvePayment')
  }
  {
    const pid = mkPayment('常州中力叉车', { amount_net: 100 })
    const d = evaluatePayment(getAny('payment_record', pid), {})
    ok('P2 bank 近似唯一 → auto 0.85', d.decision === 'auto_confirm' && d.confidence === 0.85)
  }
  {
    const pid = mkPayment('深圳市晶恒科技有限公司', { source: 'screenshot' })
    const d = evaluatePayment(getAny('payment_record', pid), {})
    ok('P3 截图精确 → auto 0.85', d.decision === 'auto_confirm' && d.confidence === 0.85)
  }
  {
    const pid = mkPayment('启航', { source: 'screenshot' })
    const d = evaluatePayment(getAny('payment_record', pid), {})
    ok('P4 截图多候选 → review', d.decision === 'needs_review')
  }
  {
    const pid = mkPayment('完全未登记的客户XYZ', { source: 'screenshot' })
    const d = evaluatePayment(getAny('payment_record', pid), {})
    ok('P5 截图未命中 → review', d.decision === 'needs_review')
  }
  {
    const pid = mkPayment('财付通支付科技有限公司', { pay_channel: 'wecom_tenpay', source: 'screenshot' })
    const d = evaluatePayment(getAny('payment_record', pid), {})
    ok('P6 财付通 → review', d.decision === 'needs_review' && d.reason.includes('财付通'))
  }
  {
    const pid = mkPayment('上海普绿包装制品有限公司', { amount_net: 0 })
    const d = evaluatePayment(getAny('payment_record', pid), {})
    ok('P7 金额≤0 → review', d.decision === 'needs_review')
  }
  {
    const pid = mkPayment('上海普绿包装制品有限公司', { source: 'bank_text' })
    const d = evaluatePayment(getAny('payment_record', pid), {})
    const r = applyDecision(d)
    const p = getAny('payment_record', pid)
    ok('P8 执行后 needs_review=0 + auto_approved_by', r.ok && p.needs_review === 0 && p.auto_approved_by === 'auto')
    const allocs = crmDbService.all('SELECT * FROM allocation WHERE payment_record_id=?', [pid])
    ok('P8 自动建 pending 归属', allocs.length === 1 && allocs[0].status === 'pending')
    const dAlloc = evaluateAllocation(allocs[0], {})
    ok('P8 新建归属可继续自动确认', dAlloc.decision === 'auto_confirm')
  }

  // ─── 物流判定 ──────────────────────────────────────────────────────────────
  let lid21 = 0, cid21 = 0
  {
    const acc = mkAccount('无锡库叉搬运设备有限公司', { city: '无锡市' })
    cid21 = mkContract(acc)
    lid21 = mkLogistics('无锡库叉搬运设备有限公司', '无锡市')
    const d = evaluateLogistics(getAny('logistics', lid21), {})
    ok('L1 唯一候选 → auto 0.95', d.decision === 'auto_confirm' && d.confidence === 0.95 && d.action === 'linkLogistics')
    const r = applyDecision(d)
    const l = getAny('logistics', lid21)
    ok('L1 执行后 linked+auto_linked_by', r.ok && l.link_status === 'linked' && l.contract_id === cid21 && l.auto_linked_by === 'auto')
  }
  {
    const acc2 = mkAccount('无锡库叉液压设备有限公司', { city: '常州市' })
    mkContract(acc2)
    const lid = mkLogistics('无锡库叉', '无锡市')
    const d = evaluateLogistics(getAny('logistics', lid), {})
    ok('L2 城市消歧唯一 → auto 0.88', d.decision === 'auto_confirm' && d.confidence === 0.88)
  }
  {
    const acc = mkAccount('无锡液压设备有限公司', { city: '无锡市' })
    mkContract(acc)
    const lid = mkLogistics('无锡库叉搬运', '无锡市')
    const d = evaluateLogistics(getAny('logistics', lid), {})
    ok('L3 receiver 词元消歧唯一 → auto 0.82', d.decision === 'auto_confirm' && d.confidence === 0.82)
  }
  {
    const lid = mkLogistics('无锡库叉液压', '无锡市')
    const d = evaluateLogistics(getAny('logistics', lid), {})
    ok('L4 消歧后仍多候选 → review', d.decision === 'needs_review')
  }
  {
    const lid = mkLogistics('未知收件人XYZ', '未知市')
    const d = evaluateLogistics(getAny('logistics', lid), {})
    ok('L5 兜底候选 → review', d.decision === 'needs_review')
  }
  {
    const lid = mkLogistics('', '无锡市')
    const d = evaluateLogistics(getAny('logistics', lid), {})
    ok('L6 无收件人 → review', d.decision === 'needs_review')
  }
  {
    // 无合同客户（独立城市，避开 byAccount 城市匹配）：候选只有账户级 → 铁律不自动认领，留人工
    const accNoC = mkAccount('舟山无合同客户', { city: '舟山市' })
    crmDbService.saveShippingInfo({ account_id: accNoC, receiver: '周七', phone: '', address: '舟山', city: '舟山市', source_msg_id: 'ship_auto_l7', created_at: Date.now() })
    const lid = mkLogistics('周七', '舟山市')
    const d = evaluateLogistics(getAny('logistics', lid), {})
    ok('L7 无合同仅账户级候选 → review（无候选合同）', d.decision === 'needs_review' && d.reason.includes('无候选合同'))
    ok('L7 候选确实含账户级', crmDbService.logisticsCandidates('周七', '舟山市').some((c) => String(c.cand_kind) === 'account'))
  }

  // ─── 发票判定 ──────────────────────────────────────────────────────────────
  let iid28 = 0
  {
    const acc = mkAccount('发票A客户')
    const cid = mkContract(acc)
    iid28 = mkInvoice('发票A客户', 5000)
    const d = evaluateInvoice(getAny('invoice', iid28), {})
    ok('I1 买方精确+金额 → auto 0.95', d.decision === 'auto_confirm' && d.confidence === 0.95)
    const r = applyDecision(d)
    const inv = getAny('invoice', iid28)
    ok('I1 执行后挂 account+contract', r.ok && inv.account_id === acc && inv.contract_id === cid && inv.auto_updated_by === 'auto')
  }
  {
    const iid = mkInvoice('常州中力叉车', 2000)
    const d = evaluateInvoice(getAny('invoice', iid), {})
    ok('I2 买方近似唯一 → auto 0.85', d.decision === 'auto_confirm' && d.confidence === 0.85)
  }
  {
    const iid = mkInvoice('上海普绿包装制品有限公司', 0)
    const d = evaluateInvoice(getAny('invoice', iid), {})
    ok('I3 金额缺失 → review', d.decision === 'needs_review' && d.reason.includes('金额'))
  }
  {
    const iid = mkInvoice('完全未登记的客户XYZ', 100)
    const d = evaluateInvoice(getAny('invoice', iid), {})
    ok('I4 买方未命中 → review', d.decision === 'needs_review')
  }
  {
    const iid = mkInvoice('启航', 100)
    const d = evaluateInvoice(getAny('invoice', iid), {})
    ok('I5 买方多候选 → review', d.decision === 'needs_review')
  }

  // ─── 金额提取正反例 ────────────────────────────────────────────────────────
  ok('F1 金额标记提取', extractInvoiceAmountFromName('dzfp_xxx_金额5000元.pdf') === 5000)
  ok('F2 ¥ 提取', extractInvoiceAmountFromName('dzfp_xxx_¥1200.pdf') === 1200)
  ok('F3 尾号不误读', extractInvoiceAmountFromName('dzfp_12345678901234567890_深圳晶恒李…2959.pdf') === null)
  ok('F4 无标记不识别', extractInvoiceAmountFromName('dzfp_12345678901234567890.pdf') === null)

  // ─── docgen 注入 ───────────────────────────────────────────────────────────
  {
    let docgenCalled = 0
    setDocgenRunner(() => { docgenCalled += 1; return { ok: true, path: '/tmp/x.docx' } })
    const acc = mkAccount('开票客户A')
    mkContract(acc, { custom_fields: JSON.stringify({ tax_no: '91310000XXX' }) })
    const iid = mkInvoice('开票客户A', 5000)
    const d = evaluateInvoice(getAny('invoice', iid), { includeDocgen: true })
    applyDecision(d, { includeDocgen: true })
    ok('G1 有 tax_no + docgen 开关 → 自动开单', docgenCalled === 1)
    const acc2 = mkAccount('开票客户B')
    mkContract(acc2, { custom_fields: '{}' })
    const iid2 = mkInvoice('开票客户B', 3000)
    const d2 = evaluateInvoice(getAny('invoice', iid2), { includeDocgen: true })
    applyDecision(d2, { includeDocgen: true })
    ok('G2 无 tax_no → 不开单', docgenCalled === 1)
    setDocgenRunner(null)
  }

  // ─── 引擎编排 / 审计 / 快照 / 总开关 ───────────────────────────────────────
  {
    const acc = mkAccount('引擎客户A')
    mkContract(acc)
    mkAllocation(mkPayment('引擎到款方'), '引擎客户A')
    setAutoConfirmConfig({
      get: (k) => k === 'crmAutoConfirmEnabled' ? true : k === 'crmAutoConfirmThreshold' ? 0.8 : k === 'crmAutoConfirmInvoiceDocgen' ? false : undefined
    })
    const res = runAutoConfirmNow({ threshold: 0.8 })
    ok('E1 run 汇总 auto>0', res.auto > 0 && res.reviewed >= 0)
    ok('E1 byEntity 有归属', res.byEntity.allocation.auto >= 1)
    const logs = crmDbService.all("SELECT * FROM auto_confirm_log WHERE decision='auto_confirm'")
    ok('E2 auto_confirm_log 落条', logs.length >= 1 && String(logs[0].entity) === 'allocation')
    const snapDir = join(dir, 'crm-backups')
    const snaps = existsSync(snapDir) ? readdirSync(snapDir).filter((f) => f.includes('auto')) : []
    ok('E3 批前快照生成', snaps.length >= 1)
    if (snaps.length) {
      const SQL = await initSqlJs({ locateFile: () => join(process.cwd(), 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm') })
      const buf = readFileSync(join(snapDir, snaps[0]))
      const db2 = new SQL.Database(buf)
      const n = db2.exec('SELECT COUNT(*) AS n FROM auto_confirm_log')
      ok('E4 快照可被 sql.js 打开且为批前状态', n.length === 1 && Number(n[0].values[0][0]) === 0)
      db2.close()
    }
    // 总开关关闭时跳过
    setAutoConfirmConfig({ get: (k) => k === 'crmAutoConfirmEnabled' ? false : undefined })
    const off = runAutoConfirmNow({ threshold: 0.8 })
    ok('E5 总开关关闭 → 跳过', off.auto === 0 && off.reviewed === 0)
  }

  // ─── undo 回滚 ─────────────────────────────────────────────────────────────
  {
    const allocs = crmDbService.all("SELECT * FROM allocation WHERE auto_confirmed_by='auto' ORDER BY id DESC")
    if (allocs.length) {
      const target = allocs[0]
      const cid = Number(target.contract_id)
      const ua = undoAutoConfirm('allocation', Number(target.id))
      const a = getAny('allocation', Number(target.id))
      ok('U1 undoAllocation → pending 且清空', ua.ok && a.status === 'pending' && a.account_id === null && a.contract_id === null)
      ok('U2 creditedTotal 回退', crmDbService.creditedTotal(cid) === 0)
      const manualId = mkAllocation(mkPayment('手工到款'), '引擎客户A', { status: 'confirmed', account_id: null, contract_id: null, confirmed_at: Date.now() })
      const ua2 = undoAutoConfirm('allocation', manualId)
      ok('U3 非自动不可撤销', ua2.ok === false)
    } else {
      ok('U1 无自动归属可测', false)
    }
  }
  {
    const p = crmDbService.all("SELECT * FROM payment_record WHERE auto_approved_by='auto' ORDER BY id DESC")
    if (p.length) {
      const up = undoAutoConfirm('payment', Number(p[0].id))
      ok('U4 undoPayment → needs_review=1', up.ok && getAny('payment_record', Number(p[0].id)).needs_review === 1)
    } else {
      ok('U4 无自动到款可测', false)
    }
  }
  {
    if (lid21) {
      const ul = undoAutoConfirm('logistics', lid21)
      ok('U5 undoLogistics → unlinked', ul.ok && getAny('logistics', lid21).link_status === 'unlinked')
    } else { ok('U5 无自动物流可测', false) }
  }
  {
    if (iid28) {
      const ui = undoAutoConfirm('invoice', iid28)
      const inv = getAny('invoice', iid28)
      ok('U6 undoInvoice → 清空', ui.ok && inv.account_id === null && inv.contract_id === null && inv.amount === 0)
    } else { ok('U6 无自动发票可测', false) }
  }

  console.log(`AUTOCONFIRM RESULT: pass=${pass} fail=${fail}`)
  if (fail > 0) process.exit(1)
}

void main()
