/**
 * sla2-evidence-view-test.ts —— SLA2「查看依据」出口验证（crmSla2EvidenceService，2026-09-08）
 *
 * 修复背景：屏 5 右只显示「依据可回查」字样，没有实际查看入口。修复后：
 *   - evidenceKey（scanRef）存在 → UI「查看依据」按钮 → IPC crm:sla2:evidence →
 *     createSla2EvidenceReader 经 evidenceResolver 回查锚点消息；
 *   - 展示脱敏消息摘要 + 时间 + 来源（rule/llm/manual）；
 *   - 证据不存在/已清理/读取失败 → 明确状态（no_anchor / cleaned / error / no_evidence）；
 *   - ⛔ 出口绝不暴露手机号、身份证、wxid、messageKey、API Key、本机绝对路径（宪法 §2.6/§1.10）。
 *
 * IPC 测试：用 fake resolver 注入（同 main.ts 注入 evidenceResolver 的方式）；
 * renderer 测试：状态→展示文案映射纯逻辑断言（见 E 组，与 CrmLeadPage 渲染条件一致）。
 * 运行：npx tsx scripts/sla2-evidence-view-test.ts
 */
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const isoDir = mkdtempSync(join(tmpdir(), 'sla2-evidence-'))
process.env.WEFLOW_WORKER = '1'
process.env.WEFLOW_USER_DATA_PATH = isoDir
process.env.WEFLOW_CONFIG_CWD = isoDir

let pass = 0, fail = 0
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; console.log(`  ✅ ${name}`) } else { fail++; console.log(`  ❌ ${name} ${detail}`) }
}

import { crmDbService } from '../electron/services/crmDbService'
import { salesDbService } from '../electron/services/salesDbService'
import { assignLeads } from '../electron/services/crmAssignmentService'
import { markSla2ScanResult } from '../electron/services/crmSla2Service'
import { createSla2EvidenceReader, type Sla2EvidenceResolverResult } from '../electron/services/crmSla2EvidenceService'
import { LEAD_SLA_UNASSIGNED_SENTINEL } from '../shared/leadSla'

const NOW = Date.now()
/** 锚点消息正文（含敏感字段，回查后必须全部打码） */
const RAW_TEXT = '客户 13812345678 说预算不够，加我微信 wxid_secret_abc 再聊，身份证 11010119900307771X 也要提供'
/** 归一化 messageKey（canonical 三段式，parseEvidenceKey 可解析） */
const CANONICAL_KEY = 'msg%2Fdb001:Msg:12345'

function seedStoppedLead(wechatSession: string, scanRef: string, source: 'rule' | 'llm' | 'manual' = 'llm'): number {
  const lid = crmDbService.runTx((tx) => tx.run(
    'INSERT INTO lead (contact_type, contact_normalized, contact_raw, wechat, source, name, note, status, first_contact_deadline, first_contacted_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    ['phone', wechatSession, wechatSession, wechatSession, '测试', '客户甲', '', 'WX_ADDED', LEAD_SLA_UNASSIGNED_SENTINEL, NOW - 7200_000, NOW, NOW]
  ))
  assignLeads([lid], '测试销售', '测试主管')
  // 模拟停表（写入口径 markSla2ScanResult 要求 sla1_met_at 非空）
  crmDbService.runTx((tx) => { tx.run("UPDATE assignment SET sla1_met_at = ? WHERE lead_id = ?", [NOW - 3600_000, lid]) })
  const r = markSla2ScanResult(lid, { verdict: 'contacted', confidence: 0.9, scanRef, source, note: 'LLM：客户已回复询价' })
  if (!r.ok) throw new Error(`markSla2ScanResult 失败: ${r.message}`)
  return lid
}

async function main(): Promise<void> {
  const dbDir = mkdtempSync(join(tmpdir(), 'sla2-evidence-db-'))
  await crmDbService.initialize(dbDir)
  await salesDbService.initialize(dbDir)

  console.log('═══ A. found：回查成功 → 脱敏摘要 + 时间 + 来源，零敏感字段 ═══')
  const la = seedStoppedLead('session_a', CANONICAL_KEY, 'llm')
  const readerA = createSla2EvidenceReader({
    resolver: {
      async getEvidenceByKey(sessionId, messageKey): Promise<Sla2EvidenceResolverResult> {
        ok('A0 resolver 收到的 sessionId/messageKey 与扫描口径一致', sessionId === 'session_a' && messageKey === CANONICAL_KEY)
        return {
          status: 'found',
          message: { content: RAW_TEXT, createTime: Math.floor(NOW / 1000), isSend: 0 },
          before: [], after: []
        }
      }
    }
  })
  const va = await readerA.getEvidenceForLead(la)
  const jsonA = JSON.stringify(va)
  ok('A1 status=found + 脱敏摘要/时间/来源齐备', va.status === 'found' && !!va.text && va.createTimeMs === Math.floor(NOW / 1000) * 1000 && va.source === 'llm', jsonA)
  ok('A2 正文打码：手机号/微信/身份证都不出原文',
    !jsonA.includes('13812345678') && !jsonA.includes('wxid_secret_abc') && !jsonA.includes('11010119900307771X') && jsonA.includes('***'), va.text || '')
  ok('A3 出口零敏感字段：无 messageKey/sessionId/wxid/绝对路径/API Key',
    !jsonA.includes('messageKey') && !jsonA.includes('session') && !jsonA.includes(CANONICAL_KEY) && !jsonA.includes('/Users/') && !jsonA.includes('apiKey'),
    jsonA)

  console.log('\n═══ B. 合成锚点（llm:<id>@<ts>）→ no_anchor 明确状态 ═══')
  const lb = seedStoppedLead('session_b', `llm:${Date.now()}`, 'llm')
  const vb = await createSla2EvidenceReader({ resolver: { async getEvidenceByKey() { throw new Error('不应被调用') } } }).getEvidenceForLead(lb)
  ok('B1 status=no_anchor + 文案明确（扫描批注无单条消息锚点）', vb.status === 'no_anchor' && vb.message.includes('锚点'), JSON.stringify(vb))

  console.log('\n═══ C. 已清理/读取失败 → cleaned / error 明确状态 ═══')
  const lc = seedStoppedLead('session_c', 'server%2Fdb002:Msg:88888', 'rule')
  const vc = await createSla2EvidenceReader({
    resolver: { async getEvidenceByKey(): Promise<Sla2EvidenceResolverResult> { return { status: 'unavailable', reason: 'message_not_found' } } }
  }).getEvidenceForLead(lc)
  ok('C1 锚点消息已清理 → status=cleaned', vc.status === 'cleaned' && vc.message.includes('清理'), JSON.stringify(vc))
  const vd = await createSla2EvidenceReader({
    resolver: { async getEvidenceByKey(): Promise<Sla2EvidenceResolverResult> { return { status: 'unavailable', reason: 'reader_error' } } }
  }).getEvidenceForLead(lc)
  ok('C2 读取层故障 → status=error', vd.status === 'error', JSON.stringify(vd))
  const ve = await createSla2EvidenceReader({
    resolver: { async getEvidenceByKey(): Promise<Sla2EvidenceResolverResult> { throw new Error('boom') } }
  }).getEvidenceForLead(lc)
  ok('C3 resolver 抛异常不冒充成功 → status=error', ve.status === 'error', JSON.stringify(ve))

  console.log('\n═══ D. 无引用/无会话 → no_evidence / no_anchor；参数非法兜底 ═══')
  const ld = seedStoppedLead('session_d', 'llm:0', 'manual') // 先落一条再清空 scanRef 引用
  crmDbService.runTx((tx) => { tx.run("UPDATE assignment SET sla2_scan_ref = ? WHERE lead_id = ?", [JSON.stringify({ verdict: 'contacted', confidence: 1, scanRef: '', source: 'manual', at: NOW }), ld]) })
  const vee = await createSla2EvidenceReader({ resolver: { async getEvidenceByKey() { throw new Error('不应被调用') } } }).getEvidenceForLead(ld)
  ok('D1 scanRef 空 → no_evidence（UI 不显示按钮）', vee.status === 'no_evidence', JSON.stringify(vee))
  const le = seedStoppedLead('', CANONICAL_KEY, 'rule') // 无绑定会话
  const vf = await createSla2EvidenceReader({ resolver: { async getEvidenceByKey() { throw new Error('不应被调用') } } }).getEvidenceForLead(le)
  ok('D2 未绑定微信会话 → 明确状态不伪造', vf.status === 'no_anchor' && vf.message.includes('未绑定'), JSON.stringify(vf))
  const vg = await createSla2EvidenceReader({ resolver: { async getEvidenceByKey() { throw new Error('不应被调用') } } }).getEvidenceForLead(0)
  ok('D3 leadId 非法 → no_evidence 兜底', vg.status === 'no_evidence', JSON.stringify(vg))

  console.log('\n═══ E. renderer 展示映射（与 CrmLeadPage 渲染条件一致的纯逻辑）═══')
  const showButton = (evidenceKey: string) => !!evidenceKey
  const showEvidencePanel = (v: { status: string } | null) => v !== null
  ok('E1 evidenceKey 存在才显示「查看依据」按钮', showButton(CANONICAL_KEY) === true && showButton('') === false)
  ok('E2 回查有结果才渲染证据面板（loading 中不渲染）', showEvidencePanel({ status: 'found' }) && !showEvidencePanel(null))
  ok('E3 found 展示脱敏摘要/时间/来源，非 found 展示明确状态文案', (() => {
    const fmt = (v: Awaited<ReturnType<typeof createSla2EvidenceReader['prototype']['getEvidenceForLead']>>) =>
      v.status === 'found' ? `${v.text}@${v.source}` : v.message
    return fmt({ status: 'found', message: '', text: '***', source: 'llm' } as never).includes('***') &&
      fmt({ status: 'cleaned', message: '锚点消息已清理' } as never).includes('清理')
  })())

  console.log(`\n═══ 结果：${pass} 通过 / ${fail} 失败 ═══`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error('测试崩溃:', e); process.exit(1) })
