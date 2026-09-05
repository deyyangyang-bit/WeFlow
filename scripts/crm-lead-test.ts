/**
 * crm-lead-test.ts —— 单机线索流转模块单测
 * 覆盖：清洗（手机号/微信号/both/无效）、去重（同批/跨批/互不误伤）、
 *       导入落库（含跨批重复）、SLA 扫描（超时建卡/幂等/自愈）、
 *       首触闭环（卡完成+lead 状态+流水一致）、转客户（查重/新建）、deadline 锁定。
 * 运行：npx tsx scripts/crm-lead-test.ts
 */
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
import { crmDbService } from '../electron/services/crmDbService'
import { salesDbService } from '../electron/services/salesDbService'
import {
  extractCnMobile, extractWechat, normalizeCnMobile, normalizeWechat, classifyLead, dedupeRows, maskContact
} from '../electron/services/crmLeadImportCore'
import {
  importLeads, listLeads, leadDetail, updateLeadStatus, toAccount,
  scanLeadSla, completeLeadFirstContact, setLeadConfig
} from '../electron/services/crmLeadService'

let pass = 0, fail = 0
function ok(name: string, cond: boolean): void {
  if (cond) { pass++ } else { fail++; console.error('FAIL:', name) }
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'crm-lead-'))
  await crmDbService.initialize(dir)
  await salesDbService.initialize(dir)
  setLeadConfig({ get: (k) => (k === 'crmLeadSlaHours' ? 24 : undefined) })

  // ── 1 清洗：手机号 ─────────────────────────────────────────────────────────
  ok('1a 纯文本提取', extractCnMobile('张三 13800138000 求2T叉车') === '13800138000')
  ok('1b 兼容横杠空格', extractCnMobile('138-0013-8000') === '13800138000')
  ok('1c 兼容 86', extractCnMobile('+86 13800138000') === '13800138000')
  ok('1d 无手机号', extractCnMobile('随便聊聊') === '')
  ok('1e normalize 去 86', normalizeCnMobile('8613800138000') === '13800138000')
  ok('1f normalize 非法保留原样', normalizeCnMobile('12345') === '12345')

  // ── 2 清洗：微信号 ─────────────────────────────────────────────────────────
  ok('2a 带标注提取', extractWechat('加我微信 kevin_x_c') === 'kevin_x_c')
  ok('2b VX 标注', extractWechat('VX:abc12345') === 'abc12345')
  ok('2c 裸提取', extractWechat('联系 abcdef_99') === 'abcdef_99')
  ok('2d 无微信号', extractWechat('我电话是13800138000') === '')
  ok('2e normalize 转小写去@', normalizeWechat('@Kevin_XC') === 'kevin_xc')

  // ── 3 清洗：联系方式分类 ───────────────────────────────────────────────────
  let p = classifyLead({ text: '张三 13800138000 微信kevin_x' })
  ok('3a both', p?.contactType === 'both' && p?.contactNormalized === '13800138000' && p?.wechat === 'kevin_x')
  p = classifyLead({ text: '李四 13900139000' })
  ok('3b phone', p?.contactType === 'phone' && p?.contactNormalized === '13900139000' && p?.wechat === '')
  p = classifyLead({ text: '王五 微信 wangwu_88' })
  ok('3c wechat', p?.contactType === 'wechat' && p?.contactNormalized === 'wangwu_88')
  p = classifyLead({ text: '随便聊聊不打算留联系方式' })
  ok('3d 无效', p === null)
  p = classifyLead({ phone: '13800138000', wechat: 'kevin_x', name: '显式列', tag: '求2T' })
  ok('3e 显式列优先', p?.contactType === 'both' && p?.name === '显式列' && p?.tag === '求2T')
  p = classifyLead({ text: '电话 +86 138 0013 8000 也是微信' })
  ok('3f 空格分隔兼容', p?.contactType === 'phone' && p?.contactNormalized === '13800138000')

  // ── 4 同批去重 ────────────────────────────────────────────────────────────
  const a = classifyLead({ text: 'A 13800138000' })
  const b = classifyLead({ text: 'B 13900139000' })
  const c = classifyLead({ text: 'C 13800138000' })
  const d = classifyLead({ text: '无效行' })
  const r = dedupeRows([a, b, c, d])
  ok('4a 同批去重 valid=2', r.valid.length === 2)
  ok('4b duplicate=1', r.duplicateCount === 1)
  ok('4c invalid=1', r.invalidCount === 1 && r.invalidIndexes.includes(3))
  // 手机号与微信号两类去重 key 互不影响（key = type:normalized）
  const phoneL = classifyLead({ text: '13800138000' })
  const wxLike = classifyLead({ text: '微信 kevin_x_88' })
  const r2 = dedupeRows([phoneL, wxLike])
  ok('4d 两类互不误伤', r2.valid.length === 2)
  ok('4e 脱敏', maskContact({ contactType: 'phone', contactNormalized: '13800138000' }) === '138****8000')

  // ── 5 导入落库 + 跨批重复 ──────────────────────────────────────────────────
  const imp1 = importLeads('抖音', 'dianpu.xlsx', [
    { text: '张三 13800138000 微信kevin_x', tag: '求2T' },
    { text: '李四 13900139000' },
    { text: '王五 微信 wangwu_88' },
    { text: '没有联系方式' }
  ])
  ok('5a 首次导入 3 有效 1 无效', imp1.valid === 3 && imp1.invalid === 1 && imp1.duplicate === 0)
  const leads = crmDbService.all('SELECT * FROM lead ORDER BY id')
  ok('5b lead 表 3 条', leads.length === 3)
  const li1 = leads.find((x) => x.contact_normalized === '13800138000')
  ok('5c both 落库（主手机号+wechat 并存）', li1 && li1.contact_type === 'both' && li1.wechat === 'kevin_x' && li1.status === 'NEW')
  ok('5d deadline 已锁定', li1 && Number(li1.first_contact_deadline) === Number(li1.created_at) + 24 * 3600_000)
  const act = crmDbService.all('SELECT * FROM lead_activity WHERE lead_id = ?', [li1!.id])
  ok('5e IMPORTED 流水', act.length === 1 && act[0].action === 'IMPORTED')

  // 同批再导 → 全重复
  const imp2 = importLeads('抖音', 'dianpu.xlsx', [
    { text: '张三 13800138000 微信kevin_x' },
    { text: '李四 13900139000' },
    { text: '王五 微信 wangwu_88' }
  ])
  ok('5f 同批二次导入全重复', imp2.valid === 0 && imp2.duplicate === 3)
  ok('5g lead 数量不变', crmDbService.all('SELECT COUNT(*) AS c FROM lead')[0].c === 3)
  ok('5h import_batch 两条', crmDbService.all('SELECT COUNT(*) AS c FROM import_batch')[0].c === 2)

  // ── 5' import_batch_id 回填（§2.75 遗留入池方式精确化，宪法 §3 登记 2026-09-06）──
  ok("5i 首批 3 行 lead.import_batch_id 全部回填 = imp1.batchId",
    leads.every((x) => Number(x.import_batch_id) === Number(imp1.batchId)))
  const impAudit = crmDbService.all("SELECT detail FROM audit_event WHERE action = 'lead_import' AND detail LIKE ?", [`%"batchId":${Number(imp1.batchId)}%`])[0]
  ok("5j 首批 lead_import 审计指向同批次（valid=3/duplicate=0）",
    !!impAudit && String(impAudit.detail).includes('"valid":3') && String(impAudit.detail).includes('"duplicate":0'))
  crmDbService.run('UPDATE lead SET import_batch_id = NULL WHERE id = ?', [Number(li1!.id)])
  const nullBack = crmDbService.all('SELECT import_batch_id AS b FROM lead WHERE id = ?', [Number(li1!.id)])[0]?.b
  ok('5k 存量 NULL 语义（列上线前导入不回填，展示层回退近似判定）', nullBack === null || nullBack === undefined)
  crmDbService.run('UPDATE lead SET import_batch_id = ? WHERE id = ?', [Number(imp1.batchId), Number(li1!.id)])
  const pageSrc = readFileSync(join(ROOT, 'src/pages/CrmLeadPage.tsx'), 'utf-8')
  ok('5l 线索页入池方式读真列 + NULL 回退近似判定（不炸存量）',
    pageSrc.includes('Number(l.import_batch_id || 0) > 0') && pageSrc.includes("'存量导入'"))

  // ── 6 deadline 锁定：改配置不影响历史 ──────────────────────────────────────
  const beforeDeadline = Number(crmDbService.getById('lead', Number(li1.id))!.first_contact_deadline)
  setLeadConfig({ get: (k) => (k === 'crmLeadSlaHours' ? 8 : undefined) })
  ok('6a 改配置后历史 deadline 不变', Number(crmDbService.getById('lead', Number(li1.id))!.first_contact_deadline) === beforeDeadline)

  // ── 7 SLA 扫描：超时建卡 + 幂等 ────────────────────────────────────────────
  const overdueLeadId = Number(li1.id)
  crmDbService.update('lead', overdueLeadId, { first_contact_deadline: Date.now() - 2 * 3600_000 })
  const n1 = scanLeadSla()
  ok('7a 超时建 1 卡', n1 === 1)
  const n2 = scanLeadSla()
  ok('7b 幂等不重复建卡', n2 === 0)
  const pendingSla = salesDbService.todoList({ status: 'pending' }).filter((t) => t.trigger_type === 'sla_lead')
  ok('7c 只有 1 张 pending SLA 卡', pendingSla.length === 1)

  // ── 8 完成闭环：卡完成 + lead 状态 + 流水 一致 ─────────────────────────────
  const taskId = pendingSla[0].id!
  const done = completeLeadFirstContact(taskId)
  ok('8a 闭环完成', done)
  const afterDone = crmDbService.getById('lead', overdueLeadId)
  ok('8b lead → CONTACTED', afterDone?.status === 'CONTACTED')
  ok('8c first_contacted_at 已写', Number(afterDone?.first_contacted_at) > 0)
  ok('8d 卡已 done', salesDbService.getTask(taskId)?.status === 'done')
  const acts = crmDbService.all('SELECT * FROM lead_activity WHERE lead_id = ? ORDER BY id', [overdueLeadId])
  ok('8e 流水含 CONTACTED', acts.some((x) => x.action === 'CONTACTED'))
  const n3 = scanLeadSla()
  ok('8f 已首触不再建卡/自愈', n3 === 0 && salesDbService.todoList({ status: 'pending' }).filter((t) => t.trigger_type === 'sla_lead').length === 0)

  // ── 9 状态流转：DEAD 必填死因 / REOPEN / 首触渠道 ──────────────────────────
  const wxLead = crmDbService.all("SELECT * FROM lead WHERE contact_type = 'wechat'")[0]
  const wId = Number(wxLead.id)
  let st = updateLeadStatus(wId, 'contacted', { channel: 'WECHAT' })
  ok('9a 首触渠道写入', st.ok && crmDbService.getById('lead', wId)?.first_contact_channel === 'WECHAT')
  st = updateLeadStatus(wId, 'dead', {})
  ok('9b 死因必填拒绝', !st.ok)
  st = updateLeadStatus(wId, 'dead', { reason: '已购车' })
  ok('9c 死因写入', st.ok && crmDbService.getById('lead', wId)?.status === 'DEAD' && crmDbService.getById('lead', wId)?.dead_reason === '已购车')
  st = updateLeadStatus(wId, 'reopen')
  ok('9d REOPEN 回 NEW 清死因', st.ok && crmDbService.getById('lead', wId)?.status === 'NEW' && crmDbService.getById('lead', wId)?.dead_reason === '')

  // ── 10 转客户：手机号查重 + 新建 + 微信查重 ────────────────────────────────
  const phoneLead = crmDbService.all("SELECT * FROM lead WHERE contact_type = 'phone' ORDER BY id DESC")[0]
  const pId = Number(phoneLead.id)
  const t1 = toAccount(pId)
  ok('10a 转客户新建成功', t1.ok && !t1.existed && t1.accountId)
  const acc = crmDbService.getById('account', Number(t1.accountId))
  ok('10b account.phone 写入', acc?.phone === phoneLead.contact_normalized)
  ok('10c lead → ACCOUNT + 关联', crmDbService.getById('lead', pId)?.status === 'ACCOUNT' && crmDbService.getById('lead', pId)?.account_id === t1.accountId)
  const t2 = toAccount(pId)
  ok('10d 已关联幂等', t2.ok && t2.accountId === t1.accountId)
  // 跨批同号被唯一索引拦截，不会产生重复 lead
  const imp3 = importLeads('小红书', 'xhs.txt', [{ text: '又一个 13900139000' }])
  ok('10e 跨批同号被去重拦截', imp3.valid === 0 && imp3.duplicate === 1)
  // 查重对象是历史已有 account：微信线索 → custom_fields.wxid 命中已有客户
  const wxAccId = crmDbService.runTx((tx) => tx.run(
    "INSERT INTO account (name, custom_fields, created_at, updated_at) VALUES (?,?,?,?)",
    ['已有微信客户', JSON.stringify({ wxid: 'wangwu_88' }), Date.now(), Date.now()]
  ))
  const wangwuLead = crmDbService.all("SELECT * FROM lead WHERE contact_normalized = 'wangwu_88'")[0]
  const t3 = toAccount(Number(wangwuLead.id))
  ok('10f 微信查重到已有客户', t3.ok && t3.existed === true && Number(t3.accountId) === Number(wxAccId))

  // ── 11 列表 / 详情 ────────────────────────────────────────────────────────
  ok('11a 列表按来源筛选', listLeads({ source: '抖音' }).length === 3)
  ok('11b 搜索命中', listLeads({ q: '1390' }).length >= 1)
  const detail = leadDetail(pId)
  ok('11c 详情含流水', detail.lead?.id === pId && detail.activities.length >= 1)
  // 排序：新导入在前（id DESC）+ 超时 NEW 置顶
  importLeads('抖音', 'sort.txt', [
    { text: '排序A 13600136000' },
    { text: '排序B 13500135000' }
  ])
  const sorted = listLeads({ limit: 200 })
  ok('11d 新导入在前（id DESC）', sorted[0].contact_normalized === '13500135000' && sorted[1].contact_normalized === '13600136000')
  const overLead = crmDbService.all("SELECT * FROM lead WHERE contact_normalized = '13600136000'")[0]
  crmDbService.update('lead', Number(overLead.id), { status: 'NEW', first_contact_deadline: Date.now() - 3600_000 })
  const sorted2 = listLeads({ limit: 200 })
  ok('11e 超时 NEW 线索置顶', sorted2[0].contact_normalized === '13600136000')

  console.log(`\nLEAD RESULT: pass=${pass} fail=${fail}`)
  if (fail > 0) process.exit(1)
}

void main().catch((e) => { console.error('FATAL:', e); process.exit(1) })
