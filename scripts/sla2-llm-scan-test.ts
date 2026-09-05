/**
 * sla2-llm-scan-test.ts —— SLA2 LLM 对话扫描单测（HANDOVER §2.57 缺口接入，三铁律验证）
 * 覆盖：
 *  a. 三态结论经 markSla2ScanResult 落库正确（contacted/need_intervention/低置信→uncertain）
 *  b. 脱敏前置：送 LLM 的文本无手机号（maskPrivateText 强制前置）
 *  c. 24h 幂等（scan_state 闸）+ 结论新鲜（at 未超 48h）跳过 + 过期且有新消息才重扫
 *  d. 无 LLM 配置零副作用；解析失败不出结论；无绑定微信跳过不计费
 *  e. 写点唯一：扫描器体内无直写 sla2_scan_ref 的 SQL（静态断言）
 * 运行：npx tsx scripts/sla2-llm-scan-test.ts（/tmp 隔离库）
 */
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; console.log(`  ✅ ${name}`) } else { fail++; console.log(`  ❌ ${name} ${detail}`) }
}

const dbDir = mkdtempSync(join(tmpdir(), 'sla2-llm-'))
import { crmDbService } from '../electron/services/crmDbService'
import { createSla2LlmScanner, maskSla2Messages, parseSla2LlmResponse, buildSla2LlmUserPrompt, type Sla2LlmMessageLite } from '../electron/services/crmSla2LlmScanService'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PHONE = '13812345678'

async function main(): Promise<void> {
  await crmDbService.initialize(dbDir)

  const now = Date.now()
  const seedLeadWithAssignment = (tag: string, opts: { wechat?: string; sla2?: string; metAt?: number } = {}): number => {
    const leadId = crmDbService.runTx((tx) => tx.run(
      'INSERT INTO lead (contact_type, contact_normalized, contact_raw, wechat, source, name, status, first_contact_deadline, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      ['phone', `139${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`, tag, opts.wechat ?? 'wxid_test', '测试', tag, 'NEW', 0, now, now]
    ))
    crmDbService.run(
      `INSERT INTO assignment (lead_id, sales_name, mode, sla1_deadline, sla1_met_at, sla2_scan_ref, status, source, updated_by, updated_at, version, deleted)
       VALUES (?,?,?,?,?,?,?,?,?,?,1,0)`,
      [leadId, '测试销售', 'manual', now - 86400_000, opts.metAt ?? now - 7200_000, opts.sla2 ?? '', 'claimed', '测试', '测试', now]
    )
    return leadId
  }
  const refOf = (leadId: number) => crmDbService.all('SELECT sla2_scan_ref AS r FROM assignment WHERE lead_id = ? AND deleted = 0 ORDER BY id DESC LIMIT 1', [leadId])[0]?.r
  const auditCount = (leadId: number) => Number(crmDbService.all("SELECT COUNT(*) AS c FROM audit_event WHERE action = 'sla2_scan_result' AND entity_id = ?", [leadId])[0].c)

  const msgFixture = (): Sla2LlmMessageLite[] => [
    { messageKey: 'mk3', isSend: 1, senderName: '我', createTimeMs: now - 3600_000, text: '合同今天能定吗' },
    { messageKey: 'mk2', isSend: 0, senderName: `客户_${PHONE}`, createTimeMs: now - 7200_000, text: `我手机 ${PHONE}，价格再聊聊，上次说的 2 台` },
    { messageKey: 'mk1', isSend: 0, senderName: `客户_${PHONE}`, createTimeMs: now - 10800_000, text: '在的' }
  ]

  // ─── a. 三态结论经 markSla2ScanResult 单点落库 ─────────────────────────────
  const makeDeps = (over: {
    llmRaw?: string
    configured?: boolean
    msgs?: Sla2LlmMessageLite[] | null
    llmError?: boolean
  } = {}) => {
    const calls: { system: string; user: string }[] = []
    return {
      calls,
      deps: {
        getRecentMessages: async () => (over.msgs === null ? [] : over.msgs ?? msgFixture()),
        llm: async (system: string, user: string) => {
          calls.push({ system, user })
          if (over.llmError) throw new Error('llm down')
          return over.llmRaw ?? ''
        },
        isConfigured: () => over.configured ?? true,
        now: () => now
      }
    }
  }

  // a1 contacted（证据锚点 = citeIndex 指向的对方消息 messageKey）
  {
    const leadId = seedLeadWithAssignment('A-contacted')
    const { deps, calls } = makeDeps({ llmRaw: JSON.stringify({ verdict: 'contacted', confidence: 0.9, citeIndex: 2, summary: '客户在谈价格与数量，话题推进中' }) })
    const r = await createSla2LlmScanner(deps).run()
    ok('a1 LLM 扫描落 1 条结论', r.marked === 1 && r.scanned === 1, JSON.stringify(r))
    const j = JSON.parse(String(refOf(leadId)))
    ok('a2 verdict/confidence/source 落库正确', j.verdict === 'contacted' && j.confidence === 0.9 && j.source === 'llm')
    ok('a3 证据锚点 scanRef = 依据消息 messageKey（mk2）', j.scanRef === 'mk2')
    ok('a4 note 含一句话结论', String(j.note || '').includes('客户在谈价格与数量'))
    ok('a5 审计 sla2_scan_result 落行', auditCount(leadId) === 1)
    ok('a6 prompt 含系统规则与脱敏对话', calls.length === 1 && calls[0].system.includes('uncertain') && calls[0].user.includes('[对方]'))
  }

  // a7 need_intervention
  {
    const leadId = seedLeadWithAssignment('A-intervention')
    const { deps } = makeDeps({ llmRaw: '{"verdict":"need_intervention","confidence":0.75,"citeIndex":2,"summary":"客户犹豫比价"}' })
    await createSla2LlmScanner(deps).run()
    ok('a7 need_intervention 落库', JSON.parse(String(refOf(leadId))).verdict === 'need_intervention')
  }

  // a8 低置信 → uncertain（铁律 3）
  {
    const leadId = seedLeadWithAssignment('A-lowconf')
    const { deps } = makeDeps({ llmRaw: '{"verdict":"contacted","confidence":0.3,"citeIndex":1,"summary":"拿不准"}' })
    const r = await createSla2LlmScanner(deps).run()
    const j = JSON.parse(String(refOf(leadId)))
    ok('a8 低置信 0.3 → verdict 强制 uncertain', r.uncertain === 1 && j.verdict === 'uncertain' && j.confidence === 0.3)
  }

  // a9 uncertain 直传
  {
    const leadId = seedLeadWithAssignment('A-uncertain')
    const { deps } = makeDeps({ llmRaw: '{"verdict":"uncertain","confidence":0.4,"citeIndex":0,"summary":"对话过短"}' })
    await createSla2LlmScanner(deps).run()
    ok('a9 uncertain 直传落库', JSON.parse(String(refOf(leadId))).verdict === 'uncertain')
  }

  // ─── b. 脱敏前置（铁律 2）──────────────────────────────────────────────────
  {
    const leadId = seedLeadWithAssignment('B-mask')
    const { deps, calls } = makeDeps({ llmRaw: '{"verdict":"contacted","confidence":0.9,"citeIndex":2,"summary":"x"}' })
    await createSla2LlmScanner(deps).run()
    const user = calls[0]?.user || ''
    ok('b1 送 LLM 文本无手机号（11 位不出现）', !new RegExp(PHONE).test(user) && !/1[3-9]\d{9}/.test(user))
    ok('b2 手机号已打码 ***', user.includes('***'))
    ok('b3 纯函数 maskSla2Messages 直验', maskSla2Messages(msgFixture()).every((m) => !new RegExp(PHONE).test(m.line)))
    void leadId
  }

  // ─── c. 幂等与新鲜度闸 ─────────────────────────────────────────────────────
  {
    const leadId = seedLeadWithAssignment('C-idempotent')
    const { deps, calls } = makeDeps({ llmRaw: '{"verdict":"contacted","confidence":0.9,"citeIndex":2,"summary":"x"}' })
    const scanner = createSla2LlmScanner(deps)
    await scanner.run()
    const r2 = await scanner.run()
    ok('c1 24h 幂等：第二轮零 LLM 调用（scan_state 闸）', calls.length === 1 && r2.skipped >= 1)
  }
  {
    // 结论新鲜（at=now）→ 不重扫
    const leadId = seedLeadWithAssignment('C-fresh', { sla2: JSON.stringify({ verdict: 'contacted', confidence: 0.9, scanRef: 'old', source: 'rule', at: now }) })
    const { deps, calls } = makeDeps({ llmRaw: '{"verdict":"contacted","confidence":0.9,"citeIndex":1,"summary":"x"}' })
    const r = await createSla2LlmScanner(deps).run()
    ok('c2 结论未过期（48h 内）→ 跳过不计费', calls.length === 0 && r.skipped >= 1 && JSON.parse(String(refOf(leadId))).scanRef === 'old')
  }
  {
    // 结论过期 + 无新消息 → 跳过；有新消息 → 重扫
    const staleAt = now - 49 * 3600_000
    const leadId = seedLeadWithAssignment('C-stale', { sla2: JSON.stringify({ verdict: 'contacted', confidence: 0.9, scanRef: 'old', source: 'rule', at: staleAt }), metAt: staleAt })
    const noNew = makeDeps({ llmRaw: '{"verdict":"contacted","confidence":0.9,"citeIndex":1,"summary":"x"}', msgs: [{ messageKey: 'old-mk', isSend: 0, senderName: '对方', createTimeMs: staleAt - 1000, text: '旧消息' }] })
    await createSla2LlmScanner(noNew.deps).run()
    ok('c3 结论过期但无新消息 → 跳过（旧结论保留）', JSON.parse(String(refOf(leadId))).scanRef === 'old')
    // 上一轮已置 24h 标记，需重置才能验证「有新消息重扫」
    crmDbService.setScanState(`sla2LlmScan:${leadId}`, 0)
    const withNew = makeDeps({ llmRaw: '{"verdict":"need_intervention","confidence":0.8,"citeIndex":1,"summary":"客户有新诉求"}' })
    const r = await createSla2LlmScanner(withNew.deps).run()
    ok('c4 结论过期且有新消息 → 重扫覆盖（结论刷新，citeIndex=1 → 首行 mk3）', r.marked === 1 && JSON.parse(String(refOf(leadId))).scanRef === 'mk3')
  }

  // ─── d. 闸与降级 ───────────────────────────────────────────────────────────
  {
    const leadId = seedLeadWithAssignment('D-noconfig')
    const { deps, calls } = makeDeps({ configured: false, llmRaw: '{"verdict":"contacted","confidence":0.9,"citeIndex":1,"summary":"x"}' })
    const r = await createSla2LlmScanner(deps).run()
    ok('d1 LLM 未配置 → 整链静默（零调用零写入）', r.configured === false && calls.length === 0 && String(refOf(leadId) || '') === '')
  }
  {
    const leadId = seedLeadWithAssignment('D-parsefail')
    const { deps } = makeDeps({ llmRaw: '模型胡言乱语，没有 JSON' })
    const r = await createSla2LlmScanner(deps).run()
    ok('d2 解析失败 → 不出结论（下轮重试，不冒充 uncertain）', r.marked === 0 && String(refOf(leadId) || '') === '')
  }
  {
    const leadId = seedLeadWithAssignment('D-nowechat', { wechat: '' })
    const { deps, calls } = makeDeps({ llmRaw: '{"verdict":"contacted","confidence":0.9,"citeIndex":1,"summary":"x"}' })
    const r = await createSla2LlmScanner(deps).run()
    ok('d3 无绑定微信 → 跳过不计费（零调用）', calls.length === 0 && r.skipped >= 1)
    void leadId
  }
  {
    const leadId = seedLeadWithAssignment('D-nomsg')
    const { deps, calls } = makeDeps({ msgs: null, llmRaw: '{"verdict":"contacted","confidence":0.9,"citeIndex":1,"summary":"x"}' })
    await createSla2LlmScanner(deps).run()
    ok('d4 无消息 → 跳过不计费（零调用零标记）', calls.length === 0 && crmDbService.getScanState(`sla2LlmScan:${leadId}`) === 0)
  }
  {
    const leadId = seedLeadWithAssignment('D-llmerror')
    const { deps } = makeDeps({ llmError: true })
    const r = await createSla2LlmScanner(deps).run()
    ok('d5 LLM 异常 → 不出结论不炸（24h 后重试）', r.marked === 0 && String(refOf(leadId) || '') === '')
    void leadId
  }

  // ─── e. 写点唯一（铁律 1，静态断言）────────────────────────────────────────
  {
    const svcSrc = readFileSync(join(ROOT, 'electron/services/crmSla2LlmScanService.ts'), 'utf-8')
    ok('e1 扫描器体内无直写 sla2_scan_ref 的 SQL', !svcSrc.includes('SET sla2_scan_ref') && !svcSrc.includes('sla2_scan_ref = ?'))
    ok('e2 结论统一走 markSla2ScanResult 单点', svcSrc.includes('markSla2ScanResult(leadId'))
    ok('e3 脱敏前置 maskPrivateText 强制调用', svcSrc.includes('maskPrivateText('))
    ok('e4 parseSla2LlmResponse：JSON 提取 + 低置信降级 + 非法 verdict 回 null',
      parseSla2LlmResponse('前缀{"verdict":"contacted","confidence":0.2,"citeIndex":1}后缀')?.verdict === 'uncertain'
      && parseSla2LlmResponse('{"verdict":"bogus","confidence":1}') === null
      && parseSla2LlmResponse('no json') === null)
    const user = buildSla2LlmUserPrompt('测试', maskSla2Messages(msgFixture()))
    ok('e5 prompt 构建含编号脱敏行', user.includes('1. [') && !new RegExp(PHONE).test(user))
  }

  console.log(`\nsla2-llm-scan-test: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

void main()
