/**
 * crm-lead-entry-test.ts —— 单条录入 + 查重面板 + 历史分配导入 针对性验证（2026-09-19）
 *
 * 覆盖：createLead 成功落库（哨兵 deadline / wx_nickname）/ 查重硬拒收 E201 / 昵称必填 /
 *       格式校验 / both 双联系方式；checkLeadDuplicate 命中与历史分配明细；
 *       importHistoricalAssignments：SLA 哨兵 2100 铁律（历史行永不参与 SLA 计时）、
 *       claimed/recycled 状态、ownership_history、幂等跳过、非法行明细。
 * 运行：npx tsx scripts/crm-lead-entry-test.ts
 */
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { crmDbService } from '../electron/services/crmDbService'
import { salesDbService } from '../electron/services/salesDbService'
import { setIdentity } from '../electron/services/identityService'
import {
  createLead, checkLeadDuplicate, importHistoricalAssignments, scanLeadSla, listLeads,
  type CreateLeadResult
} from '../electron/services/crmLeadService'
import { LEAD_SLA_UNASSIGNED_SENTINEL } from '../shared/leadSla'

let pass = 0
const failed: string[] = []
const check = (name: string, ok: boolean) => {
  if (ok) pass++
  else failed.push(name)
  console.log(`${ok ? '✅' : '❌'} ${name}`)
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'lead-entry-'))
  await crmDbService.initialize(dir)
  await salesDbService.initialize(dir) // scanLeadSla 依赖 salesDb（follow_up_task 自愈），与生产装配同序
  setIdentity('测试分配员', '分配员')

  // ── C. 单条录入 ──────────────────────────────────────────────
  const r1 = createLead({ source: '抖音', phone: '13800138000', wxNickname: '叉车老王', note: '求2T叉车' }) as CreateLeadResult
  check('C1 手机号+昵称创建成功', r1.ok === true)
  const lead1 = Number(r1.ok && r1.data?.leadId) > 0 ? crmDbService.all('SELECT * FROM lead WHERE id = ?', [Number((r1 as { data?: { leadId: number } }).data!.leadId)])[0] : null
  check('C2 入池未分配：first_contact_deadline = 2100 哨兵', !!lead1 && Number(lead1.first_contact_deadline) === LEAD_SLA_UNASSIGNED_SENTINEL)
  check('C3 wx_nickname 落库', !!lead1 && String(lead1.wx_nickname || '') === '叉车老王')
  check('C4 name 为空（表单不含姓名字段）', !!lead1 && String(lead1.name || '') === '')

  // ── D. 查重 ─────────────────────────────────────────────────
  const d1 = checkLeadDuplicate({ phone: '138 0013 8000' })
  check('D1 归一化后查重命中（带空格手机号）', d1.duplicate === true && d1.detail?.kind === 'lead' && d1.detail.leadId === Number(lead1?.id))
  const d0 = checkLeadDuplicate({ phone: '13100131000' })
  check('D0 未命中 → duplicate=false', d0.duplicate === false)

  // ── E. createLead 拒收路径 ──────────────────────────────────
  const r2 = createLead({ source: '抖音', phone: '13800138000', wxNickname: '叉车老王' }) as CreateLeadResult
  check('E1 重复手机号创建 → E201 + 查重明细', !r2.ok && r2.code === 'E201' && !!r2.duplicate)
  const r3 = createLead({ source: '抖音', phone: '13900139000' }) as CreateLeadResult
  check('E2 填手机号未填昵称 → E101（2026-09-19 拍板）', !r3.ok && r3.code === 'E101' && /昵称/.test(r3.message))
  const r4 = createLead({ source: '抖音', phone: '12345', wxNickname: 'x' }) as CreateLeadResult
  check('E3 手机号格式无效 → E101', !r4.ok && r4.code === 'E101')
  const r5 = createLead({ source: '抖音' }) as CreateLeadResult
  check('E4 手机号/微信号都没填 → E101', !r5.ok && r5.code === 'E101')
  const r5b = createLead({ source: '', phone: '13800138001', wxNickname: 'x' }) as CreateLeadResult
  check('E5 渠道来源必填 → E101', !r5b.ok && r5b.code === 'E101')

  // ── F. 微信号 only / both ──────────────────────────────────
  const r6 = createLead({ source: '小红书', wechat: 'kevin_x' }) as CreateLeadResult
  check('F1 仅微信号创建成功（昵称非必填）', r6.ok === true)
  const r7 = createLead({ source: '视频号', phone: '13700137000', wechat: 'wangwu_88', wxNickname: '王五' }) as CreateLeadResult
  const lead7 = r7.ok ? crmDbService.all('SELECT id, contact_type, contact_normalized, wechat FROM lead WHERE id = ?', [Number((r7 as { data?: { leadId: number } }).data!.leadId)])[0] : null
  check('F2 双联系方式 → contact_type = both、normalized=手机号、wechat 列并存',
    !!lead7 && lead7.contact_type === 'both' && String(lead7.contact_normalized) === '13700137000' && String(lead7.wechat) === 'wangwu_88')
  const d2 = checkLeadDuplicate({ wechat: 'wangwu_88' })
  check('F3 both 行微信号可命中', d2.duplicate === true && !!lead7 && d2.detail?.leadId === Number(lead7.id))

  // ── H. 历史分配导入 ────────────────────────────────────────
  const h1 = importHistoricalAssignments('历史.csv', [
    { contactType: 'phone', contactValue: '13600136000', sales: '李四', assignedAt: '2025-06-01', endState: 'active', source: '抖音' },
    { contactType: 'wechat', contactValue: 'zhangsan_wx', sales: '王五', assignedAt: '2025-05-01', endState: 'recycled' },
    { contactType: 'phone', contactValue: '13800138000', sales: '赵六', assignedAt: '2025-04-01', endState: 'active' }
  ])
  check('H1 导入：新建 2 条线索、复用 1 条、写入 3 条分配（1 条已回收）',
    h1.leadsCreated === 2 && h1.leadsReused === 1 && h1.assignmentsCreated === 3 && h1.recycled === 1)

  const aRows = crmDbService.all(
    "SELECT a.status, a.sla1_deadline, a.sales_name, a.claimed_at, l.contact_normalized AS cn FROM assignment a JOIN lead l ON l.id = a.lead_id WHERE a.source = '历史导入'"
  )
  check('H2 历史分配行 sla1_deadline 全部 = 2100 哨兵（铁律）', aRows.length === 3 && aRows.every((r) => Number(r.sla1_deadline) === LEAD_SLA_UNASSIGNED_SENTINEL))
  check('H3 claimed 行归属正确（李四/赵六）', aRows.some((r) => r.status === 'claimed' && r.sales_name === '李四' && String(r.cn) === '13600136000')
    && aRows.some((r) => r.status === 'claimed' && r.sales_name === '赵六' && String(r.cn) === '13800138000'))
  check('H4 recycled 行状态正确（王五）', aRows.some((r) => r.status === 'recycled' && r.sales_name === '王五'))

  const newHistLead = crmDbService.all("SELECT id, first_contact_deadline, created_at, status FROM lead WHERE contact_normalized = '13600136000'")[0]
  check('H5 新建历史线索：哨兵 deadline + created_at = 历史分配时间 + 状态 NEW',
    !!newHistLead && Number(newHistLead.first_contact_deadline) === LEAD_SLA_UNASSIGNED_SENTINEL
    && Number(newHistLead.created_at) === Date.parse('2025/06/01') && String(newHistLead.status) === 'NEW')

  const oh = crmDbService.all("SELECT new_owner FROM ownership_history WHERE reason = '历史导入'")
  check('H6 active 行写 ownership_history（李四/赵六；recycled 不写）', oh.length === 2 && oh.some((r) => r.new_owner === '李四') && oh.some((r) => r.new_owner === '赵六'))

  scanLeadSla()
  const afterScan = crmDbService.all("SELECT DISTINCT status FROM assignment WHERE source = '历史导入'")
  check('H7 SLA 扫描后历史行不被回收（哨兵生效）', afterScan.length === 2 && afterScan.every((r) => r.status === 'claimed' || r.status === 'recycled'))

  const h2 = importHistoricalAssignments('历史.csv', [
    { contactType: 'phone', contactValue: '13600136000', sales: '李四', assignedAt: '2025-06-01', endState: 'active' },
    { contactType: 'wechat', contactValue: 'zhangsan_wx', sales: '王五', assignedAt: '2025-05-01', endState: 'recycled' },
    { contactType: 'phone', contactValue: '13800138000', sales: '赵六', assignedAt: '2025-04-01', endState: 'active' }
  ])
  check('H8 重复导入幂等跳过（已归属/回收行已存在），零新写入', h2.assignmentsCreated === 0 && h2.leadsCreated === 0 && h2.skipped.length === 3)

  const h3 = importHistoricalAssignments('bad.csv', [
    { contactType: 'phone', contactValue: '123', sales: '李四', assignedAt: '2025-06-01' },
    { contactType: 'phone', contactValue: '13500135000', sales: '', assignedAt: '2025-06-01' },
    { contactType: 'phone', contactValue: '13500135000', sales: '李四', assignedAt: 'not-a-date' },
    { contactType: 'phone', contactValue: '13500135000', sales: '李四', assignedAt: '2025-06-01', endState: 'gone' }
  ])
  check('I1 非法行全部跳过且带原因（格式/缺销售/缺时间/坏状态）', h3.skipped.length === 4 && h3.assignmentsCreated === 0)

  // ── D2. 查重面板展示历史归属与分配明细 ─────────────────────
  const d3 = checkLeadDuplicate({ phone: '13800138000' })
  check('D2 查重面板：当前归属赵六 + 分配明细 ≥1 条', d3.duplicate === true && d3.detail?.currentOwner === '赵六' && (d3.detail?.assignments.length || 0) >= 1)

  console.log(`\n═══ crm-lead-entry-test：${pass} passed, ${failed.length} failed ═══`)
  if (failed.length) {
    console.error('失败项：', failed)
    process.exit(1)
  }
}

void main()
