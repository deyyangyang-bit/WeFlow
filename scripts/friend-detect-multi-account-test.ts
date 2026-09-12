/**
 * friend-detect-multi-account-test.ts —— 加好友自动检测「多账号分库覆盖」验证（2026-09-08）
 *
 * 修复背景：旧实现只消费当前账号的 chatService.getContacts()，本机其他已配置微信账号分库
 * 里的好友关系完全漏扫。修复后 runFriendDetectScan 接收逐账号联系人快照：
 *   1. 当前账号未命中、第二账号命中 → 命中即停 SLA1（任一账号精确命中即可）；
 *   2. 单个账号分库不可用（contacts=null）→ 跳过该账号，不中止其他账号扫描；
 *   3. 多分库重复联系人 → 标识先到先得归一，重复命中零重复写（幂等）；
 *   4. 无精确命中 → 零副作用（不建 identity、不推状态、不写审计）；
 *   5. 昵称模糊匹配永不自动判定已加好友（宪法 §2.4）；命中账号标识在审计中脱敏留痕。
 *
 * 隔离：WEFLOW_WORKER='1' + /tmp 空库。运行：npx tsx scripts/friend-detect-multi-account-test.ts
 */
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const isoDir = mkdtempSync(join(tmpdir(), 'friend-multi-'))
process.env.WEFLOW_WORKER = '1'
process.env.WEFLOW_USER_DATA_PATH = isoDir
process.env.WEFLOW_CONFIG_CWD = isoDir

let pass = 0, fail = 0
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; console.log(`  ✅ ${name}`) } else { fail++; console.log(`  ❌ ${name} ${detail}`) }
}

import { ConfigService } from '../electron/services/config'
import { crmDbService } from '../electron/services/crmDbService'
import { salesDbService } from '../electron/services/salesDbService'
import { setIdentity } from '../electron/services/identityService'
import { assignLeads } from '../electron/services/crmAssignmentService'
import { runFriendDetectScan, type ContactLite } from '../electron/services/crmFriendDetectService'
import { chatService } from '../electron/services/chatService.ts'
import { wcdbService } from '../electron/services/wcdbService.ts'
import { LEAD_SLA_UNASSIGNED_SENTINEL } from '../shared/leadSla'

const NOW = Date.now()
function seedAssignedLead(phone: string, wechat: string): number {
  const lid = crmDbService.runTx((tx) => tx.run(
    'INSERT INTO lead (contact_type, contact_normalized, contact_raw, wechat, source, name, note, status, first_contact_deadline, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    ['phone', phone, phone, wechat, '测试', `线索${phone}`, '', 'NEW', LEAD_SLA_UNASSIGNED_SENTINEL, NOW, NOW]
  ))
  assignLeads([lid], '测试销售', '测试主管')
  return lid
}
function counts() {
  return {
    identity: Number(crmDbService.all('SELECT COUNT(*) AS c FROM customer_identity')[0].c),
    audit: Number(crmDbService.all("SELECT COUNT(*) AS c FROM audit_event WHERE action = 'identity_bind'")[0].c),
    stopped: Number(crmDbService.all("SELECT COUNT(*) AS c FROM assignment WHERE sla1_met_at IS NOT NULL")[0].c)
  }
}

async function main(): Promise<void> {
  const cfg = ConfigService.getInstance()
  cfg.set('crmSalesList', ['测试销售'])
  const dbDir = mkdtempSync(join(tmpdir(), 'friend-multi-db-'))
  await crmDbService.initialize(dbDir)
  await salesDbService.initialize(dbDir)
  setIdentity('测试主管', '主管')

  console.log('═══ A. 当前账号未命中、第二账号命中（任一账号命中即停 SLA1）═══')
  const la = seedAssignedLead('13911110001', 'wxid_target_01')
  const accMain: ContactLite[] = [{ username: 'wxid_other_a', alias: 'alias_a', remark: '别人A', nickname: '别人A' }]
  const accSecond: ContactLite[] = [
    { username: 'wxid_target_01', alias: 'target_alias', remark: '客户一', nickname: '客户一' }
  ]
  const r1 = runFriendDetectScan([
    { account: 'wxid_main', contacts: accMain },
    { account: 'wxid_second', contacts: accSecond }
  ])
  const c1 = counts()
  ok('A1 第二账号命中：matched=1、新绑定 1', r1.matched === 1 && r1.bound === 1, JSON.stringify(r1))
  ok('A2 四件套落地：identity 1 行 + 停表 1 行 + 审计 1 行', c1.identity === 1 && c1.stopped === 1 && c1.audit === 1, JSON.stringify(c1))
  ok('A3 审计留痕命中账号标识（脱敏形态，不出原文）', (() => {
    const d = JSON.parse(String(crmDbService.all("SELECT detail FROM audit_event WHERE action = 'identity_bind'")[0]?.detail || '{}'))
    return typeof d.friendAccount === 'string' && d.friendAccount.length > 0 && d.friendAccount !== 'wxid_second' && !String(d.friendAccount).includes('wxid_second')
  })(), String(crmDbService.all("SELECT detail FROM audit_event WHERE action = 'identity_bind'")[0]?.detail))

  console.log('\n═══ B. 单个账号分库不可用：跳过该账号，其他账号正常命中 ═══')
  const lb = seedAssignedLead('13911110002', 'wxid_target_02')
  const r2 = runFriendDetectScan([
    { account: 'wxid_main', contacts: null, error: '数据库打开失败' },
    { account: 'wxid_second', contacts: [{ username: 'wxid_target_02', alias: '', remark: '客户二', nickname: '客户二' }] }
  ])
  ok('B1 主库不可用不中止：第二库命中并绑定', r2.matched === 1 && r2.bound === 1, JSON.stringify(r2))
  ok('B2 不可用账号零副作用', counts().identity === c1.identity + 1)
  // 全部不可用 → 本轮零副作用
  const beforeAllBad = counts()
  const r2b = runFriendDetectScan([
    { account: 'wxid_main', contacts: null, error: 'x' },
    { account: 'wxid_second', contacts: null, error: 'y' }
  ])
  ok('B3 全部账号不可用 → 零匹配零写入', r2b.scanned === 0 && r2b.matched === 0 && JSON.stringify(counts()) === JSON.stringify(beforeAllBad), JSON.stringify(r2b))

  console.log('\n═══ C. 多分库重复联系人：归一幂等，零重复写 ═══')
  const lc = seedAssignedLead('13911110003', 'wxid_target_03')
  const dupContact: ContactLite = [{ username: 'wxid_target_03', alias: '', remark: '客户三', nickname: '客户三' }]
  const r3a = runFriendDetectScan([
    { account: 'wxid_main', contacts: dupContact },
    { account: 'wxid_second', contacts: dupContact }
  ])
  const c3a = counts()
  ok('C1 双库同联系人 → 只绑定一次（标识先到先得归一）', r3a.matched === 1 && r3a.bound === 1 && c3a.identity === beforeAllBad.identity + 1 && c3a.audit === beforeAllBad.audit + 1, JSON.stringify({ r: r3a, ...c3a }))
  const r3b = runFriendDetectScan([
    { account: 'wxid_main', contacts: dupContact },
    { account: 'wxid_second', contacts: dupContact }
  ])
  ok('C2 重扫幂等：已停表行不再进扫描范围、零新增行（重复命中零重复写）',
    r3b.bound === 0 && r3b.scanned === 0 && JSON.stringify(counts()) === JSON.stringify(c3a), JSON.stringify({ r: r3b, ...counts() }))

  console.log('\n═══ D. 无精确命中 → 零副作用；昵称模糊匹配不判定 ═══')
  const ld = seedAssignedLead('13911110004', 'wxid_target_04')
  const beforeD = counts()
  const r4 = runFriendDetectScan([
    // lead.wechat = wxid_target_04，联系人只有昵称含该词、username/alias 完全不同 → 绝不命中
    { account: 'wxid_main', contacts: [{ username: 'wxid_unrelated', alias: 'alias_x', remark: '', nickname: 'wxid_target_04 的朋友' }] },
    { account: 'wxid_second', contacts: [{ username: 'wxid_unrelated2', alias: '', remark: 'wxid_target_04（备注模糊）', nickname: '' }] }
  ])
  ok('D1 无精确等值命中：零绑定、零写入（昵称模糊不判定，宪法 §2.4）',
    r4.scanned === 1 && r4.matched === 0 && r4.bound === 0 && JSON.stringify(counts()) === JSON.stringify(beforeD), JSON.stringify({ r: r4, ...counts() }))
  void ld
  // 手机号等值命中（username 恰为 11 位号码）
  const le = seedAssignedLead('13911110005', '')
  const r5 = runFriendDetectScan([{ account: 'wxid_main', contacts: [{ username: '13911110005', alias: '', remark: '手机号即号', nickname: '' }] }])
  ok('D2 手机号精确等值命中（username=11 位号码）', r5.matched === 1 && r5.bound === 1, JSON.stringify(r5))

  console.log('\n═══ E. 跨账号联系人轮换：原子化 readContactsForAccount（2026-09-09 并发修复）═══')
  // chatService.getContactsForAccount 现在只发一次 worker 消息（wcdbService.readContactsForAccount），
  // 轮换编排（快照→开→读→恢复/关闭）全部在 worker 内原子完成，主进程不再多步操控连接。
  const cfgAny = cfg as any
  const dbAny = wcdbService as any
  const originalGetAccountDir = cfgAny.getAccountDir
  const originalReadForAccount = dbAny.readContactsForAccount
  const chatAny = chatService as any
  const originalGetContacts = chatAny.getContacts
  const fastPathReads: number[] = []
  cfg.set('myWxid', 'wxid_main')
  cfg.set('dbPath', '/injected-db')
  cfg.set('wxidConfigs', { wxid_main: { decryptKey: 'main-key' }, wxid_target: { decryptKey: 'target-key' } })
  cfgAny.getAccountDir = (_dbPath: string, wxid: string) => `/injected-db/${wxid}`
  const origConnected = (chatService as any).connected

  // E1 原子读取成功：一次消息、联系人映射、群聊/公众号过滤、type=friend
  dbAny.readContactsForAccount = async (dir: string, key: string) => {
    fastPathReads.push(1)
    if (dir !== '/injected-db/wxid_target' || key !== 'target-key') return { success: false, error: '目录/密钥错误', stage: 'open', connectionState: { connected: false, accountDir: null, wxid: null } }
    return {
      success: true,
      contacts: [
        { username: 'wxid_target_user', nick_name: '目标联系人', remark: '' },
        { username: 'room123@chatroom', nick_name: '群聊不该出现' },
        { username: 'gh_official', nick_name: '公众号不该出现' }
      ],
      connectionState: { connected: true, accountDir: '/injected-db/wxid_main', wxid: 'wxid_main' }
    }
  }
  const e1 = await chatService.getContactsForAccount('wxid_target')
  ok('E1 原子轮换一次调用：目标目录+密钥传入、联系人映射并过滤群聊/公众号',
    e1.success && e1.contacts?.length === 1 && e1.contacts[0].username === 'wxid_target_user' && e1.contacts[0].type === 'friend' &&
    fastPathReads.length === 1, JSON.stringify(e1))

  // E2 打开失败（stage=open）→ 明确错误、不中止调用方
  dbAny.readContactsForAccount = async () => ({ success: false, error: 'readContactsForAccount open 失败（目标账号目录不可打开）', stage: 'open', connectionState: { connected: true, accountDir: '/injected-db/wxid_main', wxid: 'wxid_main' } })
  const e2 = await chatService.getContactsForAccount('wxid_target')
  ok('E2 打开失败返回明确错误（跳过该分库）', !e2.success && e2.error?.includes('open 失败') === true, JSON.stringify(e2))

  // E3 恢复失败（stage=restore）→ 按失败处理 + 断开本层连接标记（防脏数据继续被读）
  dbAny.readContactsForAccount = async () => ({ success: false, error: 'readContactsForAccount restore 失败', stage: 'restore', contacts: [{ username: 'x' }], connectionState: { connected: false, accountDir: null, wxid: null } })
  ;(chatService as any).connected = true
  const e3 = await chatService.getContactsForAccount('wxid_target')
  ok('E3 恢复失败 → 结果失败且 chatService 连接标记断开（待自愈）',
    !e3.success && (chatService as any).connected === false, JSON.stringify({ e3, connected: (chatService as any).connected }))

  // E4 当前账号走快速路径：不发起任何轮换消息
  dbAny.readContactsForAccount = async () => { fastPathReads.push(1); return { success: true, contacts: [], connectionState: { connected: false, accountDir: null, wxid: null } } }
  chatAny.getContacts = async () => ({ success: true, contacts: [] })
  const readsBefore = fastPathReads.length
  const e4 = await chatService.getContactsForAccount('wxid_main')
  ok('E4 当前账号快速路径：零轮换消息（走常规 getContacts）',
    fastPathReads.length === readsBefore && e4.success === true, JSON.stringify({ reads: fastPathReads.length, e4ok: e4.success }))
  ;(chatService as any).connected = origConnected

  dbAny.readContactsForAccount = originalReadForAccount
  chatAny.getContacts = originalGetContacts
  cfgAny.getAccountDir = originalGetAccountDir

  console.log(`\n═══ 结果：${pass} 通过 / ${fail} 失败 ═══`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error('测试崩溃:', e); process.exit(1) })
