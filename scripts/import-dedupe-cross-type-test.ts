/**
 * import-dedupe-cross-type-test.ts —— 导入查重跨 contactType 完善验证（2026-09-08）
 *
 * 修复背景：旧查重键 = contactType:contactNormalized，会放过「不同 contactType 下相同
 * 手机号/微信号」的重复数据。修复后契约：
 *   1. 手机号按归一化手机号跨 contactType 查重（phone/both 都参与手机号键）；
 *   2. 微信号按归一化微信号跨 contactType 查重（wechat/both 都参与微信号键）；
 *   3. 同批重复 / 线索池已有 / 正式客户已有 分别统计（ImportResult 四类计数）；
 *   4. 已有客户（account）不能再次进入线索池；
 *   5. 手机号命中甲、微信号命中乙的冲突数据不自动合并 → 冲突待人工（不插入）；
 *   6. 查重明细（脱敏）落 lead_import_dedupe 审计，可按批次读取/导出 CSV。
 *
 * 隔离：WEFLOW_WORKER='1' + /tmp 空库。运行：npx tsx scripts/import-dedupe-cross-type-test.ts
 */
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const isoDir = mkdtempSync(join(tmpdir(), 'import-dedupe-'))
process.env.WEFLOW_WORKER = '1'
process.env.WEFLOW_USER_DATA_PATH = isoDir
process.env.WEFLOW_CONFIG_CWD = isoDir

let pass = 0, fail = 0
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; console.log(`  ✅ ${name}`) } else { fail++; console.log(`  ❌ ${name} ${detail}`) }
}

import { crmDbService } from '../electron/services/crmDbService'
import { salesDbService } from '../electron/services/salesDbService'
import { dedupeRows, classifyLead, identityKeysOf } from '../electron/services/crmLeadImportCore'
import { importLeads, getImportDedupeDetail } from '../electron/services/crmLeadService'

async function main(): Promise<void> {
  const dbDir = mkdtempSync(join(tmpdir(), 'import-dedupe-db-'))
  await crmDbService.initialize(dbDir)
  await salesDbService.initialize(dbDir)

  console.log('═══ A. 纯核心：双标识提取 + 同批跨类型查重 ═══')
  const pBoth = classifyLead({ text: '张三 13800138000 微信kevin_x' })!
  const keys = identityKeysOf(pBoth)
  ok('A1 both 行双标识齐备（手机号键 + 微信号键）', keys.phone === '13800138000' && keys.wechat === 'kevin_x', JSON.stringify(keys))
  const batch = [
    classifyLead({ text: '张三 13800138000 微信kevin_x' }),      // both
    classifyLead({ text: '13800138000' }),                        // phone 同号（旧键 contactType 不同 → 旧实现漏放）
    classifyLead({ text: '微信 kevin_x' }),                       // wechat 同号（旧实现漏放）
    classifyLead({ text: '李四 13900139000 微信li_si99' }),       // 新 both
    classifyLead({ text: '微信 li_si99' })                        // wechat 同微信号
  ]
  const dd = dedupeRows(batch)
  ok('A2 同批跨类型重复全部拦截（phone×1、wechat×2）', dd.duplicateCount === 3 && dd.valid.length === 2, JSON.stringify(dd))
  ok('A3 重复明细带行号与原因', dd.duplicates.map((d) => d.index).join(',') === '1,2,4' && dd.duplicates.every((d) => /重复/.test(d.reason)), JSON.stringify(dd.duplicates))

  console.log('\n═══ B. 库内查重：线索池已有（跨批、跨类型命中）═══')
  const imp1 = importLeads('抖音', 'b1.xlsx', [
    { text: '张三 13800138000 微信kevin_x' },
    { text: '李四 13900139000' }
  ])
  ok('B1 首批 2 条入库', imp1.valid === 2 && imp1.dupSameBatch === 0 && imp1.dupExistingLead === 0 && imp1.dupExistingCustomer === 0 && imp1.conflicts === 0, JSON.stringify(imp1))
  const imp2 = importLeads('抖音', 'b2.xlsx', [
    { text: '13800138000' },               // phone 类型命中首批 both 的手机号 → 线索池已有
    { text: '微信 kevin_x' },              // wechat 类型命中首批 both 的微信号 → 线索池已有
    { text: '13900139000' }                // 同号同类型（唯一索引兜底路径）→ 线索池已有
  ])
  ok('B2 跨批跨类型全部拦截为「线索池已有」', imp2.valid === 0 && imp2.dupExistingLead === 3, JSON.stringify(imp2))
  ok('B3 lead 数量不变（无重复创建）', Number(crmDbService.all('SELECT COUNT(*) AS c FROM lead')[0].c) === 2)

  console.log('\n═══ C. 已有客户不能再次进入线索池 ═══')
  const now = Date.now()
  crmDbService.runTx((tx) => {
    tx.run('INSERT INTO account (name, phone, custom_fields, created_at, updated_at) VALUES (?,?,?,?,?)',
      ['客户甲', '13700137000', JSON.stringify({ wxid: 'cust_wx_01' }), now, now])
  })
  const imp3 = importLeads('抖音', 'b3.xlsx', [
    { text: '13700137000' },               // 手机号命中 account.phone
    { text: '微信 cust_wx_01' }            // 微信号命中 account.custom_fields.wxid
  ])
  ok('C1 双标识分别命中正式客户 → existing_customer=2、零入库', imp3.valid === 0 && imp3.dupExistingCustomer === 2, JSON.stringify(imp3))
  ok('C2 lead 数量仍为 2', Number(crmDbService.all('SELECT COUNT(*) AS c FROM lead')[0].c) === 2)

  console.log('\n═══ D. 双标识冲突：手机号属甲、微信号属乙 → 冲突待人工，不自动合并 ═══')
  // 甲：只有手机号 13600136000；乙：只有微信号 wxid_yi。导入行 both(13600136000, wxid_yi)
  importLeads('抖音', 'b4.xlsx', [{ text: '甲老板 13600136000' }])
  importLeads('抖音', 'b5.xlsx', [{ text: '微信 wxid_yi' }])
  const beforeD = Number(crmDbService.all('SELECT COUNT(*) AS c FROM lead')[0].c)
  const imp4 = importLeads('抖音', 'b6.xlsx', [{ text: '冲突行 13600136000 微信wxid_yi' }])
  ok('D1 冲突行不插入、不自动合并（conflicts=1）', imp4.valid === 0 && imp4.conflicts === 1 && Number(crmDbService.all('SELECT COUNT(*) AS c FROM lead')[0].c) === beforeD, JSON.stringify(imp4))
  ok('D2 甲乙两条线索保持独立（未被错误合并）',
    Number(crmDbService.all("SELECT COUNT(*) AS c FROM lead WHERE contact_normalized = '13600136000'")[0].c) === 1 &&
    Number(crmDbService.all("SELECT COUNT(*) AS c FROM lead WHERE contact_normalized = 'wxid_yi'")[0].c) === 1)

  console.log('\n═══ E. 查重明细：分类计数 + 脱敏明细可读取（CSV 导出源）═══')
  const imp5 = importLeads('抖音', 'b7.xlsx', [
    { text: '新客户 13500135000' },                 // inserted
    { text: '13800138000' },                        // existing_lead
    { text: '13700137000' },                        // existing_customer
    { text: '冲突行 13600136000 微信wxid_yi' },     // conflict
    { text: '没有联系方式' }                        // invalid
  ])
  const det = getImportDedupeDetail(imp5.batchId)
  ok('E1 明细可按批次读取', det.ok && det.rows.length === 5, JSON.stringify(det.rows?.length))
  const byVerdict = (v: string) => det.rows.filter((r) => r.verdict === v).length
  ok('E2 各类判定逐一统计正确', byVerdict('inserted') === 1 && byVerdict('existing_lead') === 1 && byVerdict('existing_customer') === 1 && byVerdict('conflict') === 1 && byVerdict('invalid') === 1, JSON.stringify(det.rows.map((r) => r.verdict)))
  ok('E3 明细脱敏：手机号 138****、微信号不出原文', (() => {
    const joined = det.rows.map((r) => `${r.phoneMasked}|${r.wechatMasked}`).join(';')
    return joined.includes('138****8000') && !joined.includes('13800138000') && !joined.includes('wxid_yi')
  })(), JSON.stringify(det.rows))
  ok('E4 冲突行带可复核原因', det.rows.find((r) => r.verdict === 'conflict')?.reason.includes('冲突') === true, det.rows.find((r) => r.verdict === 'conflict')?.reason)

  console.log('\n═══ F. 连续批次读取：entity_type + entity_id 精确定位，不误匹配 10/11 ═══')
  const extraBatchIds: number[] = []
  for (let n = 8; n <= 11; n++) {
    const extra = importLeads('抖音', `batch-${n}.xlsx`, [{ name: `批次${n}`, phone: `13${String(n).padStart(9, '0')}` }])
    extraBatchIds.push(extra.batchId)
  }
  const detail1 = getImportDedupeDetail(1)
  const detail10 = getImportDedupeDetail(10)
  const detail11 = getImportDedupeDetail(11)
  ok('F1 连续创建批次 8/9/10/11', extraBatchIds.join(',') === '8,9,10,11', JSON.stringify(extraBatchIds))
  ok('F2 批次 1 返回自己的两行明细，不误取批次 10/11',
    detail1.ok && detail1.rows.length === 2 && detail1.rows.some((row) => row.phoneMasked === '138****8000') && detail1.rows.every((row) => !row.name.includes('批次10') && !row.name.includes('批次11')),
    JSON.stringify(detail1.rows))
  ok('F3 批次 10/11 分别返回各自明细',
    detail10.ok && detail11.ok && detail10.rows.length === 1 && detail11.rows.length === 1 &&
    detail10.rows[0].name === '批次10' && detail11.rows[0].name === '批次11',
    JSON.stringify({ b10: detail10.rows, b11: detail11.rows }))

  console.log(`\n═══ 结果：${pass} 通过 / ${fail} 失败 ═══`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error('测试崩溃:', e); process.exit(1) })
