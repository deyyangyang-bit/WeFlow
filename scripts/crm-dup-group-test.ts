/**
 * crm-dup-group-test.ts —— 撞客方案一期客户端侧 针对性验证（2026-09-19）
 *
 * 覆盖：applyDupGroupEvent 落地（crmDb.dup_group）/ 载荷校验（坏哈希、成员数不符 → false）/
 *       member_count 单调（晚到旧事件不回退）/ listDupMatches：lead 行 + customer 卡匹配、
 *       对方归属人过滤本机署名、只回姓名不回对方资料。
 * 运行：npx tsx scripts/crm-dup-group-test.ts
 */
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { crmDbService } from '../electron/services/crmDbService'
import { salesDbService } from '../electron/services/salesDbService'
import { setIdentity } from '../electron/services/identityService'
import { applyDupGroupEvent, listDupMatches } from '../electron/services/crmDupGroupService'
import { identityHash } from '../electron/services/centralProjection'
import { LEAD_SLA_UNASSIGNED_SENTINEL } from '../shared/leadSla'

let pass = 0
const failed: string[] = []
const check = (name: string, ok: boolean) => {
  if (ok) pass++
  else failed.push(name)
  console.log(`${ok ? '✅' : '❌'} ${name}`)
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'dup-group-'))
  await crmDbService.initialize(dir)
  await salesDbService.initialize(dir)
  setIdentity('张三', '销售')

  // 夹具：本机一条手机号线索（真实写路径语义：入池哨兵 deadline）+ 一条同号客户卡
  const now = Date.now()
  const leadId = crmDbService.runTx((tx) => tx.run(
    "INSERT INTO lead (contact_type, contact_normalized, contact_raw, wechat, source, name, status, first_contact_deadline, created_at, updated_at) VALUES ('phone','13800138000','13800138000','','测试','','NEW',?,?,?)",
    [LEAD_SLA_UNASSIGNED_SENTINEL, now, now]
  ))
  const accountId = crmDbService.runTx((tx) => tx.run(
    "INSERT INTO account (name, phone, custom_fields, created_at, updated_at) VALUES ('叉车老王客户','13800138000','{\"wxid\":\"wangwu_88\"}',?,?)",
    [now, now]
  ))

  // 中央下发的重复组载荷（成员 = 双方客户引用 + 归属销售；本机是张三侧，对方 = 李四）
  const anchorHash = identityHash('phone', '13800138000')
  const payload = (count: number, members: Array<{ customerRef: string; ownerSales: string }>) => ({
    anchorType: 'phone', anchorHash, anchorMasked: '138****8000',
    membersJson: JSON.stringify(members), memberCount: count
  })
  const members2 = [
    { customerRef: 'devA/identity:1', ownerSales: '张三' },
    { customerRef: 'devB/customer:9', ownerSales: '李四' }
  ]

  check('G1 合法载荷落地 → true', applyDupGroupEvent(payload(2, members2)) === true)
  const row = crmDbService.all('SELECT * FROM dup_group')[0]
  check('G2 dup_group 落库：锚点哈希/掩码/成员数', !!row && String(row.anchor_hash) === anchorHash
    && String(row.anchor_masked) === '138****8000' && Number(row.member_count) === 2)

  const m1 = listDupMatches()
  check('G3 lead 行命中重复组', !!m1.leadMatches[String(leadId)])
  check('G4 客户卡命中重复组', !!m1.customerMatches[String(accountId)])
  check('G5 只显示对方归属人（本机署名「张三」被过滤，只剩「李四」）',
    m1.leadMatches[String(leadId)]?.others.join() === '李四' && m1.customerMatches[String(accountId)]?.others.join() === '李四')
  check('G6 徽标数据不含对方资料（成员里没有昵称/消息字段）',
    !String(row.members_json).includes('nickname') && !String(row.members_json).includes('message')
      && !String(row.members_json).includes('session'))

  // 晚到旧事件（成员数更小）不回退小组；同成员数重复投递幂等
  check('G7 同成员数重复投递幂等 → true 且零回退', applyDupGroupEvent(payload(2, members2)) === true
    && Number(crmDbService.all('SELECT member_count FROM dup_group')[0].member_count) === 2)
  const members3 = [...members2, { customerRef: 'devC/customer:77', ownerSales: '王五' }]
  check('G8 第三位成员 → 新成员数落地', applyDupGroupEvent(payload(3, members3)) === true
    && Number(crmDbService.all('SELECT member_count FROM dup_group')[0].member_count) === 3)
  check('G9 晚到的旧事件（成员数 2）不回退小组', applyDupGroupEvent(payload(2, members2)) === true
    && Number(crmDbService.all('SELECT member_count FROM dup_group')[0].member_count) === 3)
  const m2 = listDupMatches()
  check('G10 三方组成员去重后展示（李四、王五）', m2.leadMatches[String(leadId)]?.others.join(',') === '李四,王五')

  // 非法载荷
  check('G11 坏哈希 → false', applyDupGroupEvent({ ...payload(2, members2), anchorHash: 'not-hash' }) === false)
  check('G12 成员数与成员列表不符 → false',
    applyDupGroupEvent({ anchorType: 'phone', anchorHash, anchorMasked: '', membersJson: JSON.stringify(members2), memberCount: 3 }) === false)
  check('G13 非法锚点类型 → false', applyDupGroupEvent({ ...payload(2, members2), anchorType: 'wechat2' }) === false)

  // 微信号锚点也能匹配（wechat 组）
  const wxHash = identityHash('wechat', 'wangwu_88')
  check('G14 wechat 锚点组落地并匹配客户卡内嵌 wxid',
    applyDupGroupEvent({ anchorType: 'wechat', anchorHash: wxHash, anchorMasked: 'wx***',
      membersJson: JSON.stringify([{ customerRef: 'devA/customer:2', ownerSales: '张三' }, { customerRef: 'devB/customer:8', ownerSales: '孙七' }]),
      memberCount: 2 }) === true
    && !!listDupMatches().customerMatches[String(accountId)])

  // ── P1c：aggregate_version 裁决（成员数相同内容变化必须落地）─────────────────
  const members3b = members3.map((m) => (m.customerRef === 'devB/customer:9' ? { ...m, ownerSales: '李四二' } : m))
  // 先给当前组一个已知版本基线：v4（成员数仍 3，ownerSales 更新）
  check('V1 三成员组 ownerSales 变化（member_count 仍 3，v4）→ 新版本落地',
    applyDupGroupEvent(payload(3, members3b), 4) === true
      && Number(crmDbService.all('SELECT aggregate_version FROM dup_group WHERE anchor_type=? AND anchor_hash=?', ['phone', anchorHash])[0].aggregate_version) === 4)
  const badge1 = listDupMatches().leadMatches[String(leadId)]?.others.join(',')
  check('V2 客户徽标展示最新 owner（李四二）', badge1 === '李四二,王五')
  // 同版本同内容 → 幂等（零写、true）
  check('V3 同版本同内容幂等 → true', applyDupGroupEvent(payload(3, members3b), 4) === true
    && Number(crmDbService.all('SELECT aggregate_version FROM dup_group WHERE anchor_type=? AND anchor_hash=?', ['phone', anchorHash])[0].aggregate_version) === 4)
  // 更旧版本 → 不回退
  const membersOld = [...members2, { customerRef: 'devC/customer:77', ownerSales: '王五' }]
  check('V4 更旧版本（v3）不得回退 → true 且内容保持 v4',
    applyDupGroupEvent(payload(3, membersOld), 3) === true
      && Number(crmDbService.all('SELECT aggregate_version FROM dup_group WHERE anchor_type=? AND anchor_hash=?', ['phone', anchorHash])[0].aggregate_version) === 4
      && String(crmDbService.all('SELECT members_json FROM dup_group WHERE anchor_type=? AND anchor_hash=?', ['phone', anchorHash])[0].members_json).includes('李四二'))
  // 同版本（v4）但内容不同 → 拒绝（不静默覆盖）
  const membersConflict = members3b.map((m) => (m.customerRef === 'devC/customer:77' ? { ...m, ownerSales: '假王五' } : m))
  check('V5 同版本不同内容 → 拒绝为 invalid（false）且内容不被覆盖',
    applyDupGroupEvent(payload(3, membersConflict), 4) === false
      && !String(crmDbService.all('SELECT members_json FROM dup_group WHERE anchor_type=? AND anchor_hash=?', ['phone', anchorHash])[0].members_json).includes('假王五'))
  // 新版本（v5）成员数不变但内容再变化 → 落地
  const members3c = members3b.map((m) => (m.customerRef === 'devC/customer:77' ? { ...m, ownerSales: '王五新' } : m))
  check('V6 新版本（v5）成员数不变内容变化 → 落地',
    applyDupGroupEvent(payload(3, members3c), 5) === true
      && Number(crmDbService.all('SELECT aggregate_version FROM dup_group WHERE anchor_type=? AND anchor_hash=?', ['phone', anchorHash])[0].aggregate_version) === 5)
  // 本地 members_json 规范化：乱序输入（同集合 v6）→ 落库与 v5 内容一致（去重 + 稳定排序）
  const messy = [members3c[2], members3c[0], members3c[1]]
  check('V7 乱序输入被规范化（同集合新版本落地后内容与排序一致）',
    applyDupGroupEvent({ anchorType: 'phone', anchorHash, anchorMasked: '138****8000', membersJson: JSON.stringify(messy), memberCount: 3 }, 6) === true
      && Number(crmDbService.all('SELECT aggregate_version FROM dup_group WHERE anchor_type=? AND anchor_hash=?', ['phone', anchorHash])[0].aggregate_version) === 6
      && JSON.parse(String(crmDbService.all('SELECT members_json FROM dup_group WHERE anchor_type=? AND anchor_hash=?', ['phone', anchorHash])[0].members_json))[0].customerRef < JSON.parse(String(crmDbService.all('SELECT members_json FROM dup_group WHERE anchor_type=? AND anchor_hash=?', ['phone', anchorHash])[0].members_json))[2].customerRef)

  console.log(`\n═══ crm-dup-group-test：${pass} passed, ${failed.length} failed ═══`)
  if (failed.length) {
    console.error('失败项：', failed)
    process.exit(1)
  }
}

void main()
