/**
 * identity-test.ts —— 本地身份档案（PRD §1.2a）副本隔离验证
 *
 * 覆盖：
 *   A. config 读写：identityName / identityRole / identityOnboardingDismissed 三键默认值与读写
 *   B. actor 署名格式（宪法 §1.8/§1.12）：姓名+角色 →「姓名（角色）」；仅姓名 →「姓名」；未建档 → null
 *   C. 角色归一：非法角色值（含脏数据）归空串 = 未选角色
 *   D. 分配服务 actor 兜底链：显式 actor > 身份档案 > 未建档兜底「分配员」（crmAssignmentService）
 *   E. 跳过引导幂等：dismissOnboarding 后 shouldPromptOnboarding=false 且重复 dismiss 不反复弹；
 *      建档后（setIdentity 自动置 dismissed）也不再弹
 *
 * 隔离：WEFLOW_WORKER='1' + WEFLOW_USER_DATA_PATH / WEFLOW_CONFIG_CWD 指向 /tmp 临时目录，
 *       crmDb 用全新空库（fresh），绝不碰 live 库与真实配置。
 *       ⚠️ WEFLOW_WORKER 必须设：config.ts 仅在 worker 模式才把 store cwd 指向 WEFLOW_CONFIG_CWD
 *       （config.ts:358-364），否则 electron-store 落到 ~/Library/Preferences/WeFlow-nodejs/ 共享文件，
 *       多轮测试残留互相污染（默认值断言会被上一轮写入击穿）。
 * 运行：npx tsx scripts/identity-test.ts
 */
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// 隔离 config 落盘路径（必须在 import 前设置）
const isoDir = mkdtempSync(join(tmpdir(), 'identity-test-'))
process.env.WEFLOW_WORKER = '1'
process.env.WEFLOW_USER_DATA_PATH = isoDir
process.env.WEFLOW_CONFIG_CWD = isoDir

let pass = 0, fail = 0
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; console.log(`  ✅ ${name}`) } else { fail++; console.log(`  ❌ ${name} ${detail}`) }
}

import { ConfigService } from '../electron/services/config'
import { crmDbService } from '../electron/services/crmDbService'
import {
  getIdentity, getActorLabel, setIdentity, normalizeRole,
  shouldPromptOnboarding, dismissOnboarding
} from '../electron/services/identityService'
import { assignLeads } from '../electron/services/crmAssignmentService'

const SALES = '测试销售甲'

/** 建 N 条 NEW 线索，返回 id 列表（fresh 库，lead 表空） */
function seedLeads(n: number): number[] {
  const now = Date.now()
  const ids: number[] = []
  crmDbService.runTx((tx) => {
    for (let i = 0; i < n; i++) {
      const id = tx.run(
        'INSERT INTO lead (contact_type, contact_normalized, contact_raw, wechat, source, name, status, first_contact_deadline, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
        ['phone', `1390000${String(i).padStart(4, '0')}`, `1390000${String(i).padStart(4, '0')}`, '', '测试', `线索${i}`, 'NEW', now + 86400000, now, now]
      )
      ids.push(id)
    }
  })
  return ids
}

function auditActor(leadId: number): string {
  const rows = crmDbService.all(
    "SELECT actor FROM audit_event WHERE action = 'lead_assign' AND entity_type = 'lead' AND entity_id = ? ORDER BY id DESC LIMIT 1",
    [leadId]
  )
  return String(rows[0]?.actor || '')
}

async function main(): Promise<void> {
  const cfg = ConfigService.getInstance()
  // fresh crmDb（分配兜底链验证需要 lead/assignment 等表）
  const dbDir = mkdtempSync(join(tmpdir(), 'identity-test-db-'))
  await crmDbService.initialize(dbDir)

  console.log('═══ A. config 三键默认值与读写 ═══')
  ok('A1 identityName 默认空串', cfg.get('identityName') === '')
  ok('A2 identityRole 默认空串', cfg.get('identityRole') === '')
  ok('A3 identityOnboardingDismissed 默认 false', cfg.get('identityOnboardingDismissed') === false)
  cfg.set('identityName', ' 杨青 ')
  cfg.set('identityRole', '销售')
  ok('A4 写入后读回', String(cfg.get('identityName')).trim() === '杨青' && cfg.get('identityRole') === '销售')
  cfg.set('identityName', '')
  cfg.set('identityRole', '')
  ok('A5 清空复位', cfg.get('identityName') === '' && cfg.get('identityRole') === '')

  console.log('\n═══ B. actor 署名格式（姓名+角色 / 仅姓名 / 未建档）═══')
  ok('B1 未建档 getIdentity=null', getIdentity() === null)
  ok('B2 未建档 getActorLabel=null', getActorLabel() === null)
  setIdentity('杨青', '销售')
  ok('B3 姓名+角色 → 「杨青（销售）」', getActorLabel() === '杨青（销售）', String(getActorLabel()))
  setIdentity('杨青', '')
  ok('B4 仅姓名（角色未选）→ 「杨青」', getActorLabel() === '杨青', String(getActorLabel()))
  setIdentity('李林辉', '分配员')
  ok('B5 分配员角色 → 「李林辉（分配员）」', getActorLabel() === '李林辉（分配员）')
  setIdentity('丁帅', '主管')
  ok('B6 主管角色 → 「丁帅（主管）」', getActorLabel() === '丁帅（主管）')

  console.log('\n═══ C. 角色归一（非法值/脏数据 → 空串）═══')
  ok('C1 非法角色归空', normalizeRole('管理员') === '' && normalizeRole('boss') === '')
  ok('C2 空/null/undefined 归空', normalizeRole('') === '' && normalizeRole(null) === '' && normalizeRole(undefined) === '')
  ok('C3 合法三角色原样保留', normalizeRole('销售') === '销售' && normalizeRole('主管') === '主管' && normalizeRole('分配员') === '分配员')
  // 脏数据直写配置（绕过 setIdentity），读取侧也必须归一
  cfg.set('identityRole', '总监')
  ok('C4 脏角色直写配置后 getActorLabel 只写姓名', getActorLabel() === '丁帅', String(getActorLabel()))
  cfg.set('identityRole', '')

  console.log('\n═══ D. 分配服务 actor 兜底链（显式 > 身份档案 > 「分配员」）═══')
  const ids = seedLeads(4)
  // D1 未建档（清空姓名）→ 兜底「分配员」
  cfg.set('identityName', '')
  const r1 = assignLeads([ids[0]], SALES, '')
  ok('D1 未建档 + 未传 actor → 兜底「分配员」', r1.ok === true && auditActor(ids[0]) === '分配员', auditActor(ids[0]))
  // D2 建档（姓名+角色）→ 身份档案署名
  setIdentity('杨青', '销售')
  const r2 = assignLeads([ids[1]], SALES, '')
  ok('D2 建档后未传 actor → 「杨青（销售）」', r2.ok === true && auditActor(ids[1]) === '杨青（销售）', auditActor(ids[1]))
  // D3 建档（仅姓名）→ 只写姓名
  setIdentity('杨青', '')
  const r3 = assignLeads([ids[2]], SALES, '')
  ok('D3 角色未选 → 「杨青」', r3.ok === true && auditActor(ids[2]) === '杨青', auditActor(ids[2]))
  // D4 显式 actor 仍优先于身份档案（如 system:migration）
  const r4 = assignLeads([ids[3]], SALES, 'system:migration')
  ok('D4 显式 actor 优先于身份档案', r4.ok === true && auditActor(ids[3]) === 'system:migration', auditActor(ids[3]))
  const hRow = crmDbService.all("SELECT actor FROM ownership_history WHERE entity_type = 'lead' AND entity_id = ?", [ids[1]])
  ok('D5 ownership_history 同步署名「杨青（销售）」', String(hRow[0]?.actor || '') === '杨青（销售）', String(hRow[0]?.actor || ''))

  console.log('\n═══ E. 首次引导与跳过幂等 ═══')
  // 复位为未建档
  cfg.set('identityName', '')
  cfg.set('identityRole', '')
  cfg.set('identityOnboardingDismissed', false)
  ok('E1 未建档且未跳过 → 需要引导', shouldPromptOnboarding() === true)
  dismissOnboarding()
  ok('E2 「稍后再填」后不再弹', shouldPromptOnboarding() === false)
  dismissOnboarding()
  dismissOnboarding()
  ok('E3 重复 dismiss 幂等（仍 false，不反复弹）', shouldPromptOnboarding() === false && cfg.get('identityOnboardingDismissed') === true)
  // 建档后无论 dismissed 标志如何都不再弹
  cfg.set('identityOnboardingDismissed', false)
  setIdentity('杨青', '销售')
  ok('E4 建档后不再弹（且自动置 dismissed）', shouldPromptOnboarding() === false && cfg.get('identityOnboardingDismissed') === true)
  ok('E5 已建档状态 getIdentity 完整', getIdentity()?.name === '杨青' && getIdentity()?.role === '销售')

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
