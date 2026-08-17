/**
 * crm-enrich-test.ts —— 客户信息自动填充引擎单测
 * 覆盖：合并规则（手动锁定/AI 覆盖/冲突 pending）、核心解析（校验/置信/幻觉丢弃）、
 *       落库链路（applyEnrichment → infoPendingQueue → applyInfoField）、填充度、批量映射
 * 运行：npx tsx scripts/crm-enrich-test.ts
 */
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  crmDbService, mergeEnrichFields, parseEnrichMeta, ENRICH_FIELDS, ENRICH_FORMAL_COLUMNS,
  type EnrichMeta
} from '../electron/services/crmDbService'
import { validateAndBoost, parseEnrichResult } from '../electron/services/crmEnrichCore'

let pass = 0, fail = 0
function ok(name: string, cond: boolean): void {
  if (cond) { pass++ } else { fail++; console.error('FAIL:', name) }
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'crm-enrich-'))
  await crmDbService.initialize(dir)

  // ── 1 合并规则：空目标直接写入 ─────────────────────────────────────────────
  const now = 1700000000000
  let r = mergeEnrichFields({ company: null }, {}, { company: { value: '上海普绿包装制品有限公司', confidence: 0.92, evidence: '对方户名' } }, { now })
  ok('1a 空目标写入', r.updates.company?.value === '上海普绿包装制品有限公司')
  ok('1b meta source=ai', r.updates.company?.meta.source === 'ai' && r.updates.company.meta.confidence === 0.92)
  ok('1c evidence 落 meta', r.updates.company?.meta.evidence === '对方户名')

  // ── 2 手动/锁定字段永不覆盖 ────────────────────────────────────────────────
  const manualMeta: EnrichMeta = { fields: { phone: { source: 'manual', confidence: 1, at: now } } }
  r = mergeEnrichFields({ phone: '13800000001' }, manualMeta, { phone: { value: '13900000002', confidence: 0.99 } }, { now })
  ok('2a manual 不覆盖', Object.keys(r.updates).length === 0 && r.skipped.includes('phone'))
  const lockedMeta: EnrichMeta = { fields: { city: { source: 'ai', confidence: 0.5, at: now, locked: true } } }
  r = mergeEnrichFields({ city: '无锡' }, lockedMeta, { city: { value: '苏州', confidence: 0.99 } }, { now })
  ok('2b locked 不覆盖', Object.keys(r.updates).length === 0 && r.skipped.includes('city'))

  // ── 3 AI 覆盖：新置信 ≥ 旧置信才赢 ────────────────────────────────────────
  const aiMeta: EnrichMeta = { fields: { needs: { source: 'ai', confidence: 0.8, at: now - 1000 } } }
  r = mergeEnrichFields({ needs: '要 3 吨叉车' }, aiMeta, { needs: { value: '要 5 吨叉车', confidence: 0.9 } }, { now })
  ok('3a 高置信覆盖', r.updates.needs?.value === '要 5 吨叉车')
  r = mergeEnrichFields({ needs: '要 3 吨叉车' }, aiMeta, { needs: { value: '要 5 吨叉车', confidence: 0.7 } }, { now })
  ok('3b 低置信丢弃', r.discarded.includes('needs') && !r.updates.needs)

  // ── 4 相同值：仅刷新 meta（置信取高）──────────────────────────────────────
  r = mergeEnrichFields({ city: '无锡' }, aiMeta, { city: { value: '无锡', confidence: 0.95 } }, { now })
  ok('4a 同值 refreshed', r.refreshed.includes('city') && r.updates.city?.meta.confidence === 0.95)

  // ── 5 历史值无 meta：够置信进 pending，否则丢弃 ────────────────────────────
  r = mergeEnrichFields({ industry: '包装' }, {}, { industry: { value: '包装制品', confidence: 0.75 } }, { threshold: 0.7, now })
  ok('5a 冲突进 pending', r.pending.industry?.value === '包装制品')
  r = mergeEnrichFields({ industry: '包装' }, {}, { industry: { value: '包装制品', confidence: 0.5 } }, { threshold: 0.7, now })
  ok('5b 低置信丢弃', r.discarded.includes('industry') && !r.pending.industry)

  // ── 6 空值/非法输入容忍 ────────────────────────────────────────────────────
  r = mergeEnrichFields({}, {}, { company: { value: '   ', confidence: 0.9 } } as any, { now })
  ok('6a 空白值忽略', Object.keys(r.updates).length === 0)

  // ── 7 parseEnrichMeta 容错 ────────────────────────────────────────────────
  ok('7a 合法 JSON', parseEnrichMeta('{"fields":{"city":{"source":"ai","confidence":0.9,"at":1}}}').fields?.city?.confidence === 0.9)
  ok('7b 非法 JSON → {}', Object.keys(parseEnrichMeta('{oops')).length === 0)
  ok('7c 空 → {}', Object.keys(parseEnrichMeta('')).length === 0)

  // ── 8 validateAndBoost ────────────────────────────────────────────────────
  ok('8a 手机校验+加成', validateAndBoost('phone', '138 0013 8000', 0.85)?.value === '13800138000')
  ok('8b 手机加成 +0.1', Math.abs((validateAndBoost('phone', '13800138000', 0.85)?.confidence ?? 0) - 0.95) < 1e-9)
  ok('8c 座机通过', validateAndBoost('phone', '0510-88886666', 0.8) !== null)
  ok('8d 非法号码丢弃', validateAndBoost('phone', '12345', 0.9) === null)
  ok('8e 敏感度归一', validateAndBoost('price_sensitive', 'HIGH', 0.8)?.value === 'high')
  ok('8f 敏感度非法丢弃', validateAndBoost('price_sensitive', 'maybe', 0.8) === null)
  ok('8g 长值截断 500', (validateAndBoost('needs', 'x'.repeat(800), 0.8)?.value ?? '').length === 500)
  ok('8h 置信钳制 ≤1', (validateAndBoost('city', '无锡', 1.7)?.confidence ?? 0) === 1)

  // ── 9 parseEnrichResult ───────────────────────────────────────────────────
  const aiJson = JSON.stringify({
    company: '上海普绿包装制品有限公司', phone: '13800138000', needs: '采购 2 台 3 吨内燃叉车',
    budget: null, intent_model: '无', competitor: '未知',
    confidence: { company: 0.95, phone: 0.9, needs: 0.88 },
    evidence: { company: '对方户名为上海普绿', phone: '我电话 13800138000', needs: '要两台 3 吨的' },
    hallucinated_field: '不该出现'
  })
  const parsed = parseEnrichResult(aiJson)
  ok('9a 有效字段提取', parsed?.company?.value === '上海普绿包装制品有限公司' && parsed?.needs?.confidence === 0.88)
  ok('9b null/无/未知 跳过', parsed && !('budget' in parsed) && !('intent_model' in parsed) && !('competitor' in parsed))
  ok('9c 幻觉字段丢弃', parsed && !('hallucinated_field' in parsed))
  ok('9d evidence 保留', parsed?.phone?.evidence === '我电话 13800138000')
  ok('9e 非法 JSON → null', parseEnrichResult('这不是 JSON') === null)
  ok('9f 缺 confidence 默认 0.6', parseEnrichResult('{"city":"无锡"}')?.city?.confidence === 0.6)
  const fenced = parseEnrichResult('```json\n{"city":"无锡","confidence":{"city":0.9}}\n```')
  ok('9g 代码围栏内 JSON 可解析', fenced?.city?.value === '无锡')
  ok('9h AI 给的破号码丢弃', (parseEnrichResult('{"phone":"888","confidence":{"phone":0.9}}') ?? {})['phone'] === undefined)

  // ── 10 落库链路：applyEnrichment → 正式列/custom_fields 分流 ──────────────
  const accId = crmDbService.ensureAccount('测试客户张总')
  crmDbService.update('account', accId, { session_id: 'wxid_test_zhang' })
  const applyR = crmDbService.applyEnrichment(accId, {
    company: { value: '无锡测试机械有限公司', meta: { source: 'ai', confidence: 0.93, at: now, evidence: '公司名称' } },
    needs: { value: '要 1 台电动叉车', meta: { source: 'ai', confidence: 0.9, at: now, evidence: '想要电叉' } }
  }, {})
  ok('10a applyEnrichment ok', applyR.ok)
  const acc = crmDbService.getById('account', accId)!
  ok('10b 正式列写入 company', acc.company === '无锡测试机械有限公司')
  const cf = JSON.parse(String(acc.custom_fields || '{}'))
  ok('10c custom_fields 写入 needs', cf.needs === '要 1 台电动叉车')
  const meta10 = parseEnrichMeta(String(acc.enrich_meta || ''))
  ok('10d meta 记录来源', meta10.fields?.company?.source === 'ai' && meta10.fields?.needs?.evidence === '想要电叉')

  // ── 11 pending 队列派生 + 人工裁决 ────────────────────────────────────────
  crmDbService.applyEnrichment(accId, {}, {
    budget: { value: '预算 10 万左右', confidence: 0.75, evidence: '就十万块', at: now }
  })
  let queue = crmDbService.reviewQueues().infoPending
  ok('11a infoPending 派生', queue.length === 1 && queue[0].field === 'budget' && queue[0].account_id === accId)
  const rej = crmDbService.applyInfoField(accId, 'budget', 'reject')
  ok('11b reject ok', rej.ok && crmDbService.reviewQueues().infoPending.length === 0)
  crmDbService.applyEnrichment(accId, {}, { budget: { value: '预算 10 万左右', confidence: 0.75, at: now } })
  const accR = crmDbService.applyInfoField(accId, 'budget', 'accept')
  const cf2 = JSON.parse(String(crmDbService.getById('account', accId)!.custom_fields || '{}'))
  ok('11c accept 写入 custom_fields', accR.ok && cf2.budget === '预算 10 万左右')
  ok('11d accept 后队列清空', crmDbService.reviewQueues().infoPending.length === 0)
  ok('11e 重复裁决幂等拒绝', !crmDbService.applyInfoField(accId, 'budget', 'accept').ok)

  // ── 12 填充度 / 批量映射 / 回填候选 ───────────────────────────────────────
  const customers = crmDbService.customers()
  const zhang = customers.find((c) => Number(c.id) === accId)
  ok('12a 填充度统计', zhang?.enrich_filled === 3 && zhang?.enrich_total === ENRICH_FIELDS.length)
  const accId2 = crmDbService.ensureAccount('测试客户李总')
  crmDbService.update('account', accId2, { session_id: 'wxid_test_li', imported_at: Date.now() })
  const bySessions = crmDbService.accountsBySessions(['wxid_test_zhang', 'wxid_test_li', 'wxid_nobody'])
  ok('12b bySessions 映射', bySessions['wxid_test_zhang']?.id === accId && bySessions['wxid_test_li']?.id === accId2 && !bySessions['wxid_nobody'])
  const candidates = crmDbService.enrichCandidates(10)
  ok('12c 回填候选只含缺失多的客户', candidates.some((c) => Number(c.id) === accId2) && !candidates.some((c) => Number(c.id) === accId))

  // ── 13 statsOverview（P3 可视化数据源）─────────────────────────────────────
  const stats = crmDbService.statsOverview()
  ok('13a 结构完整', typeof stats.customers === 'number' && Array.isArray(stats.paidWeekly) && Array.isArray(stats.stageDist) && Array.isArray(stats.pipeline))
  ok('13b 近 8 周趋势', stats.paidWeekly.length === 8)
  ok('13c 客户数含测试客户', stats.customers >= 2)
  ok('13d pendingReview 非负', Number(stats.pendingReview) >= 0)

  // ── 14 字段定义一致性 ─────────────────────────────────────────────────────
  ok('14a 正式列属于 ENRICH_FIELDS', [...ENRICH_FORMAL_COLUMNS].every((f) => (ENRICH_FIELDS as readonly string[]).includes(f)))
  ok('14b 字段数 12', ENRICH_FIELDS.length === 12)

  console.log(`\nENRICH RESULT: pass=${pass} fail=${fail}`)
  if (fail > 0) process.exit(1)
}

void main().catch((e) => { console.error('FATAL:', e); process.exit(1) })
