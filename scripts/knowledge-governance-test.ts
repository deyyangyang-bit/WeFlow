/**
 * knowledge-governance-test.ts —— 刀 1 知识治理底座 + 刀 2 采用率埋点单测（设计-Hermes-MVP 刀 1/刀 2）
 * 覆盖（PRD 铁律：埋点与 Hermes 同天上，不许后补）：
 *  a. 状态机流转：kbCreate 默认 staging/community；publish/reject 合法迁移 + reviewed_by/at 落库；
 *     跨态迁移拒绝（published→rejected / 重复 publish / rejected 上再处置）
 *  b. 存量迁移幂等可重入：治理前置旧行（status NULL）→ staging/community，已审定行不动，重跑零副作用
 *  c. 拒因必填：空拒因拒绝被拒（db 层 + service 层双口径），拒因落 reject_reason 沉底留档不删
 *  d. 三写点落埋点（proposal_event append-only）：applyInfo accept/reject → proposal/accepted|rejected、
 *     知识审核发布/拒绝 → knowledge/accepted|rejected、completeAction(done) → action/accepted；
 *     附 generated/viewed（todoCreate 任务创建点 / 卡流 viewed 只记一次）+ enrich 生成点静态断言
 *  e. 采纳率口径：采纳率 = (accepted+modified)/已处理总数（proposal+knowledge 两类），
 *     分母 0 → rate=null（UI 显示「—」不伪造）；窗口外事件不入；generated 不入比率；action 不入分母
 *  g. 旧库升级（§2.84）：真实构造治理前置旧版 sales DB 文件（knowledge_base 只有旧字段）→
 *     当前 SalesDbService.initialize 打开升级 → 九治理列齐 + 存量保留 + 默认 staging/community +
 *     idx_kb_status 存在 + flush/reopen 幂等 + published 不被迁移踩回
 * 运行：npx tsx scripts/knowledge-governance-test.ts
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import initSqlJs from 'sql.js'

let pass = 0, fail = 0
function ok(name: string, cond: boolean): void {
  if (cond) { pass++ } else { fail++; console.error('FAIL:', name) }
}

const isoDir = mkdtempSync(join(tmpdir(), 'kb-gov-'))
process.env.WEFLOW_USER_DATA_PATH = isoDir
process.env.WEFLOW_CONFIG_CWD = isoDir

import { salesDbService } from '../electron/services/salesDbService'
import { crmDbService } from '../electron/services/crmDbService'
import { salesKnowledgeService } from '../electron/services/salesKnowledgeService'
import { completeAction } from '../electron/services/salesActionEngine'
import { trackActionCardsViewed } from '../electron/services/proposalEventTracking'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

async function main(): Promise<void> {
  // ─── a. 状态机流转 ────────────────────────────────────────────────────────
  const dbDir = mkdtempSync(join(tmpdir(), 'kb-gov-db-'))
  await salesDbService.initialize(dbDir)

  // e0 分母 0（干净库第一时间验证：rate=null，UI 显示「—」不伪造 0%）
  const clean = salesDbService.proposalAdoptionStats(7)
  ok('e0 分母 0 → rate=null（UI 显示「—」不伪造）', clean.processed === 0 && clean.generated === 0 && clean.rate === null)

  const entry = salesDbService.kbCreate({ category: 'product', title: 'X 系列续航', content: 'X 系列 3 吨电动叉车续航 8 小时', tags: '["续航"]' })
  ok('a1 新增默认 staging + community + version 1（AI 永不发布铁律）',
    entry.status === 'staging' && entry.authority === 'community' && entry.version === 1)

  // 拒因必填（db 层）：空拒因拒绝 → 拒绝，状态不变
  const noReason = salesDbService.kbReview(entry.id!, 'reject', { reviewer: '主管甲' })
  ok('a2 拒绝缺拒因被拒（拒因必填）', !noReason.ok && (noReason.error || '').includes('拒因') && salesDbService.kbGet(entry.id!)?.status === 'staging')

  const rej = salesDbService.kbReview(entry.id!, 'reject', { reason: '参数与产品库冲突', reviewer: '主管甲' })
  ok('a3 staging→rejected 合法迁移', rej.ok && rej.entry?.status === 'rejected')
  ok('a4 拒因落 reject_reason + reviewed 署名（沉底留档不删）',
    rej.entry?.reject_reason === '参数与产品库冲突' && rej.entry?.reviewed_by === '主管甲' && !!rej.entry?.reviewed_at && salesDbService.kbGet(entry.id!) !== undefined)

  // rejected 上再发布/再拒绝 → 状态机拒绝（沉底档不翻案、不重复处置）
  const rePublish = salesDbService.kbReview(entry.id!, 'publish', { reviewer: '主管甲' })
  const reReject = salesDbService.kbReview(entry.id!, 'reject', { reason: '再拒', reviewer: '主管甲' })
  ok('a5 rejected 上跨态迁移被拒（发布/拒绝均拒绝）', !rePublish.ok && !reReject.ok && salesDbService.kbGet(entry.id!)?.status === 'rejected')

  const entry2 = salesDbService.kbCreate({ category: 'script', title: '报价异议话术', content: '先谈价值再谈价格……' })
  const pub = salesDbService.kbReview(entry2.id!, 'publish', { reviewer: '主管乙', authority: 'official' })
  ok('a6 staging→published 合法迁移 + official 徽标口径', pub.ok && pub.entry?.status === 'published' && pub.entry?.authority === 'official')
  ok('a7 发布写 reviewed_by/reviewed_at，清 reject_reason', pub.entry?.reviewed_by === '主管乙' && !!pub.entry?.reviewed_at && pub.entry?.reject_reason === null)
  const pubAgain = salesDbService.kbReview(entry2.id!, 'publish', { reviewer: '主管乙' })
  ok('a8 published 上重复发布被拒', !pubAgain.ok)

  // 审核人缺失（actor=当前身份档案姓名，宪法 §1.12 署名口径）
  const noReviewer = salesDbService.kbReview(salesDbService.kbCreate({ category: 'faq', title: 't', content: 'c' }).id!, 'publish', { reviewer: '' })
  ok('a9 审核人缺失被拒（reviewed_by 必须署名）', !noReviewer.ok && (noReviewer.error || '').includes('审核人'))

  // ─── b. 存量迁移（幂等、可重入）───────────────────────────────────────────
  // 模拟治理前置存量：旧行 status/authority 置空串（迁移 WHERE 同时覆盖 NULL 与 ''；
  // ALTER ADD COLUMN 的 DEFAULT 背填是存量迁移主通道，本方法为显式幂等清扫，两者口径一致）；
  // 另留一条已审定行验证不被迁移踩踏
  const legacy1 = salesDbService.kbCreate({ category: 'product', title: '存量产品 1', content: '迁移前老条目' })
  const legacy2 = salesDbService.kbCreate({ category: 'script', title: '存量话术 1', content: '迁移前老话术' })
  salesDbService.run("UPDATE knowledge_base SET status = '', authority = '' WHERE id IN (?, ?)", [legacy1.id, legacy2.id])
  const reviewedBefore = salesDbService.kbGet(entry2.id!)
  const migration1 = salesDbService.migrateKnowledgeGovernance()
  ok('b1 迁移命中 2 条存量', migration1.staged === 2)
  ok('b2 存量置 staging + community + version 1（治理版上线后默认不可被问答引用）',
    salesDbService.kbGet(legacy1.id!)?.status === 'staging' && salesDbService.kbGet(legacy1.id!)?.authority === 'community' &&
    salesDbService.kbGet(legacy2.id!)?.status === 'staging' && salesDbService.kbGet(legacy1.id!)?.version === 1)
  ok('b3 已审定行不被迁移踩踏', (() => {
    const r = salesDbService.kbGet(entry2.id!)
    return r?.status === 'published' && r?.reviewed_by === reviewedBefore?.reviewed_by && r?.authority === 'official'
  })())
  const migration2 = salesDbService.migrateKnowledgeGovernance()
  ok('b4 重跑幂等（staged=0，零副作用，可重入）', migration2.staged === 0 && salesDbService.kbGet(legacy1.id!)?.status === 'staging' && salesDbService.kbGet(entry2.id!)?.reviewed_by === reviewedBefore?.reviewed_by)

  // ─── c. 拒因必填（service 层口径）+ 知识审核写点（刀 2 写点②）────────────────
  const svcEntry = salesDbService.kbCreate({ category: 'faq', title: '保修多久', content: '整机保修 1 年' })
  const svcNoReason = salesKnowledgeService.review(svcEntry.id!, 'reject', {})
  ok('c1 service 层拒因必填拦截', !svcNoReason.success && (svcNoReason.error || '').includes('拒因'))
  const svcReject = salesKnowledgeService.review(svcEntry.id!, 'reject', { reason: '以官网为准，需复核' })
  ok('c2 service 层拒绝成功且拒因落档（未建档 actor 兜底署名不伪造）',
    svcReject.success && svcReject.entry?.reject_reason === '以官网为准，需复核' && !!svcReject.entry?.reviewed_by)

  const beforeKb = salesDbService.proposalEventCount({ event_type: 'knowledge', stage: 'accepted' })
  const svcPub = salesKnowledgeService.review(svcEntry.id!, 'publish', {}) // rejected → publish 被状态机拒
  ok('c3 service 层跨态发布被状态机拒', !svcPub.success)
  const svcEntry2 = salesDbService.kbCreate({ category: 'product', title: 'CPD15 载重', content: 'CPD15 额定载重 1.5 吨' })
  const svcPub2 = salesKnowledgeService.review(svcEntry2.id!, 'publish', {})
  ok('c4 知识审核发布 → knowledge/accepted 埋点（写点②）',
    salesDbService.proposalEventCount({ event_type: 'knowledge', stage: 'accepted' }) === beforeKb + 1)
  ok('c5 埋点指向实体 knowledge:<id>', salesDbService.proposalEventEntityIds('knowledge', 'accepted', 'knowledge').has(String(svcEntry2.id!)))

  // ─── d. 三写点落埋点（append-only）────────────────────────────────────────
  // d1 行动卡：todoCreate 任务创建点 → action/generated；completeAction(done) → action/accepted
  const task = salesDbService.todoCreate({ trigger_type: 'manual', title: '跟进张总', session_id: 'wxid_gov_test', created_by: 'manual' })
  ok('d1 任务创建点落 action/generated', salesDbService.proposalEventEntityIds('action', 'generated', 'follow_up_task').has(String(task.id!)))
  const beforeAccepted = salesDbService.proposalEventCount({ event_type: 'action', stage: 'accepted' })
  completeAction(task.id!, 'done')
  ok('d2 completeSignal(done) → action/accepted（写点③）', salesDbService.proposalEventCount({ event_type: 'action', stage: 'accepted' }) === beforeAccepted + 1)
  completeAction(task.id!, 'done')
  ok('d3 重复完成不再记（幂等：仅真实状态迁移记一次）', salesDbService.proposalEventCount({ event_type: 'action', stage: 'accepted' }) === beforeAccepted + 1)

  // d2 卡流渲染点 viewed：每卡只记一次（防轮询刷屏）
  trackActionCardsViewed([9001, 9002])
  trackActionCardsViewed([9001, 9002, 9003])
  const viewedIds = salesDbService.proposalEventEntityIds('action', 'viewed', 'follow_up_task')
  ok('d4 卡流 viewed 只记一次（9001/9002/9003）', viewedIds.has('9001') && viewedIds.has('9002') && viewedIds.has('9003'))

  // d3 信息待确认：applyInfo accept/reject → proposal/accepted|rejected（写点①，跨库写 salesDb）
  await crmDbService.initialize(mkdtempSync(join(tmpdir(), 'kb-gov-crm-')))
  const accId = crmDbService.ensureAccount('治理测试客户')
  crmDbService.update('account', accId, { session_id: 'wxid_gov_acc' })
  crmDbService.applyEnrichment(accId, {}, {
    budget: { value: '预算 10 万', confidence: 0.75, evidence: '就十万块', at: Date.now() },
    company: { value: '测试机械', confidence: 0.78, evidence: '我们公司', at: Date.now() }
  })
  const accRej = crmDbService.applyInfoField(accId, 'budget', 'reject')
  const accAcc = crmDbService.applyInfoField(accId, 'company', 'accept')
  ok('d5 applyInfo 裁决成功', accRej.ok && accAcc.ok)
  const proposalEntityIds = salesDbService.proposalEventEntityIds('proposal', 'accepted', 'account_info')
  ok('d6 applyInfo accept → proposal/accepted（写点①，entity=<accountId>:<field>）', proposalEntityIds.has(`${accId}:company`))
  ok('d7 applyInfo reject → proposal/rejected（写点①）', salesDbService.proposalEventEntityIds('proposal', 'rejected', 'account_info').has(`${accId}:budget`))
  ok('d8 重复裁决幂等拒绝不再记埋点', !crmDbService.applyInfoField(accId, 'budget', 'reject').ok &&
    salesDbService.proposalEventCount({ event_type: 'proposal', stage: 'rejected' }) === 1)

  // d4 proposal_event 硬门禁：非法 event_type/stage 双拦截（TS 守卫 + DB CHECK）
  let guardRejected = 0
  try { salesDbService.proposalEventAdd({ event_type: 'stage' as any, stage: 'generated', entity_type: 'x', entity_id: '1' }) } catch { guardRejected++ }
  try { salesDbService.proposalEventAdd({ event_type: 'proposal', stage: 'done' as any, entity_type: 'x', entity_id: '1' }) } catch { guardRejected++ }
  try { salesDbService.proposalEventAdd({ event_type: 'proposal', stage: 'accepted', entity_type: '', entity_id: '' }) } catch { guardRejected++ }
  ok('d9 非法 event_type/stage/空实体被 TS 守卫拦截（CHECK 外第一道门）', guardRejected === 3)

  // d5 enrich 提案生成点静态断言（动态跑需 AI 配置，按 closed-gate 先例做 source 级断言）
  const enrichSrc = readFileSync(join(ROOT, 'electron/services/crmEnrichService.ts'), 'utf8')
  ok('d10 enrichCustomer 提案生成点挂 proposal/generated（新 pending 字段逐条落埋点）',
    /trackProposalEvent\(\{ event_type: 'proposal', stage: 'generated'/.test(enrichSrc) &&
    /for \(const field of newPendingFields\)/.test(enrichSrc))
  const engineSrc = readFileSync(join(ROOT, 'electron/services/salesActionEngine.ts'), 'utf8')
  ok('d11 卡流渲染点挂 trackActionCardsViewed + 完成闭环挂 action/accepted',
    /trackActionCardsViewed\(actionItems\.map\(i => i\.id\)\)/.test(engineSrc) &&
    /event_type: 'action', stage: 'accepted'/.test(engineSrc))
  const crmSrc = readFileSync(join(ROOT, 'electron/services/crmDbService.ts'), 'utf8')
  ok('d12 applyInfoField 双分支挂 proposal/accepted|rejected', (crmSrc.match(/event_type: 'proposal', stage: '(accepted|rejected)'/g) || []).length === 2)

  // ─── e. 采纳率口径（含分母 0）─────────────────────────────────────────────
  // 此时（seed 前）埋点台账是确定的：knowledge/accepted×1(c4) + knowledge/rejected×1(a3)
  // + proposal/accepted×1(d6) + proposal/rejected×1(d7)；action 系（generated/accepted/viewed）不入提案口径。
  const base = salesDbService.proposalAdoptionStats(7)
  ok('e1 基线台账：processed=6（accepted3+rejected3），action 系不入分母，rate=50%',
    base.processed === 6 && base.accepted === 3 && base.rejected === 3 && base.modified === 0 && base.rate === 50 && base.generated === 0)

  // 造数：窗口内 accepted×1 + modified×1 + rejected×1 + generated×1；
  //       窗口外 accepted×1（8 天前，不入 7 天窗口）；action/accepted×1（永不入提案口径）
  const now = Date.now()
  const seed = (event_type: 'proposal' | 'knowledge' | 'action', stage: 'generated' | 'viewed' | 'accepted' | 'modified' | 'rejected', entityId: string, createdAt: number) =>
    salesDbService.proposalEventAdd({ event_type, stage, entity_type: 't', entity_id: entityId, actor: '测试', createdAt })
  seed('proposal', 'accepted', 'e-acc', now - 2 * 86400_000)
  seed('knowledge', 'modified', 'e-mod', now - 3 * 86400_000)
  seed('proposal', 'rejected', 'e-rej', now - 1 * 86400_000)
  seed('proposal', 'generated', 'e-gen', now - 1 * 86400_000)
  seed('proposal', 'accepted', 'e-old', now - 8 * 86400_000)
  seed('action', 'accepted', 'e-act', now - 1 * 86400_000)

  const stats = salesDbService.proposalAdoptionStats(7)
  ok('e2 已处理总数 = accepted+rejected+modified = 9（窗口外 accepted 不入）',
    stats.processed === 9 && stats.accepted === 4 && stats.modified === 1 && stats.rejected === 4)
  ok('e3 采纳率 = (accepted+modified)/分母 = 5/9 → 56%（四舍五入口径）', stats.rate === 56)
  ok('e4 generated 只上报不入比率', stats.generated === 1 && stats.rate === 56)
  ok('e5 action 埋点不入提案口径（action/accepted×2 存在但分母仍 9）', stats.processed === 9)
  const statsAll = salesDbService.proposalAdoptionStats(0)
  ok('e6 days=0 全窗口口径（含 8 天前 accepted：processed=10，rate=round(6/10)=60%）',
    statsAll.processed === 10 && statsAll.accepted === 5 && statsAll.rate === 60)

  // e7 append-only：无 UPDATE/DELETE 通道（静态断言 proposal_event 无改删语句）
  const dbSrc = readFileSync(join(ROOT, 'electron/services/salesDbService.ts'), 'utf8')
  ok('e7 proposal_event append-only（无 UPDATE/DELETE proposal_event 语句）',
    !/UPDATE proposal_event/.test(dbSrc) && !/DELETE FROM proposal_event/.test(dbSrc))

  // ─── f. 刀 4 知识提案写入路 + 批量通过 + 只看 diff（设计-Hermes-MVP 刀 4）───
  // f1 propose 落 staging：source=proposal + evidence_key 锚点 + proposal/generated 埋点（写点⑥）
  const propGenBefore = salesDbService.proposalEventCount({ event_type: 'proposal', stage: 'generated' })
  const prop = salesKnowledgeService.propose({
    title: 'X 系列续航多久',
    content: '客户常问：X 系列续航多久？（问答无命中，待补充答案）',
    category: 'faq',
    evidence_key: 'local:msg_0.db:11:1700000000:0:wxid_gov:1'
  })
  ok('f1 提案落 staging：source=proposal + evidence_key 锚点随行',
    prop.success && prop.entry?.status === 'staging' && prop.entry?.source === 'proposal' &&
    prop.entry?.evidence_key === 'local:msg_0.db:11:1700000000:0:wxid_gov:1')
  ok('f2 提案埋点 proposal/generated（entity=knowledge:<id>，刀 2 写点⑥）',
    salesDbService.proposalEventCount({ event_type: 'proposal', stage: 'generated' }) === propGenBefore + 1 &&
    salesDbService.proposalEventEntityIds('proposal', 'generated', 'knowledge').has(String(prop.entry?.id)))

  // f3 硬门（宪法 §1.10）：空锚提案不进审核队列
  const beforeRows = salesDbService.proposalEventCount({ event_type: 'proposal', stage: 'generated' })
  const noAnchor = salesKnowledgeService.propose({ title: '无锚提案', content: '内容', evidence_key: '' })
  ok('f3 evidence_key 硬门：空锚提案被拒且零落库零埋点',
    !noAnchor.success && (noAnchor.error || '').includes('锚点') &&
    salesDbService.proposalEventCount({ event_type: 'proposal', stage: 'generated' }) === beforeRows &&
    salesDbService.kbList({ status: 'staging' }).every(e => e.title !== '无锚提案'))

  // f4 手动新增默认 source=manual（非提案行 evidence_key NULL 合法；存量背填不动）
  const manualRow = salesDbService.kbCreate({ category: 'product', title: '手动新增条目', content: '直接录入' })
  ok('f4 非提案行 source 默认 manual + evidence_key NULL',
    manualRow.source === 'manual' && manualRow.evidence_key === null)

  // f5 批量通过逐条语义 + 失败隔离（不新造批量写路径：逐条走 kbReview 状态机）
  const b1 = salesDbService.kbCreate({ category: 'faq', title: '批量 1', content: 'c1' })
  const b2 = salesDbService.kbCreate({ category: 'faq', title: '批量 2', content: 'c2' })
  const b3 = salesDbService.kbCreate({ category: 'faq', title: '批量 3', content: 'c3' })
  salesDbService.kbReview(b3.id!, 'reject', { reason: '不需要', reviewer: '主管甲' }) // 预置一个跨态失败行
  // 模拟前端 reviewEntries 逐条循环语义（同款 try/catch + 错误收集，含不存在 id）
  const batch: number[] = [b1.id!, b2.id!, b3.id!, 999999]
  let batchPublished = 0
  const batchErrors: string[] = []
  for (const id of batch) {
    try {
      const r = salesKnowledgeService.review(id, 'publish')
      if (r.success) batchPublished++
      else batchErrors.push(`#${id} ${r.error || '未知错误'}`)
    } catch (e) {
      batchErrors.push(`#${id} ${String(e)}`)
    }
  }
  ok('f5 批量逐条语义：成功 2 条过 kbReview 状态机（reviewed_by 身份署名非空）',
    batchPublished === 2 && salesDbService.kbGet(b1.id!)?.status === 'published' &&
    !!salesDbService.kbGet(b1.id!)?.reviewed_by && salesDbService.kbGet(b2.id!)?.status === 'published')
  ok('f6 失败隔离：跨态行与不存在 id 单独报告，不拖垮整批且不污染他行',
    batchErrors.length === 2 && salesDbService.kbGet(b3.id!)?.status === 'rejected' &&
    batchErrors[0].includes('#' + b3.id) && batchErrors[1].includes('#999999') &&
    salesDbService.kbGet(b1.id!)?.status === 'published')

  // f7 提案裁决不双记：发布提案行走写点② knowledge/accepted，proposal/accepted 不虚增（采纳率分母防虚增）
  const propAccBefore = salesDbService.proposalEventCount({ event_type: 'proposal', stage: 'accepted' })
  const knowAccBefore = salesDbService.proposalEventCount({ event_type: 'knowledge', stage: 'accepted' })
  salesKnowledgeService.review(prop.entry!.id!, 'publish')
  ok('f7 提案发布 = knowledge/accepted 单记（不双记 proposal/accepted，聚合分母不虚增）',
    salesDbService.proposalEventCount({ event_type: 'proposal', stage: 'accepted' }) === propAccBefore &&
    salesDbService.proposalEventCount({ event_type: 'knowledge', stage: 'accepted' }) === knowAccBefore + 1)

  // f8 批量/写点静态断言：无新造批量写路径（逐条走既有单条 handler）
  const mainSrc4 = readFileSync(join(ROOT, 'electron/main.ts'), 'utf8')
  const storeSrc = readFileSync(join(ROOT, 'src/stores/knowledgeStore.ts'), 'utf8')
  const cwsSrc = readFileSync(join(ROOT, 'src/pages/CustomerWorkspacePage.tsx'), 'utf8')
  ok('f8 无批量写路径：知识批量逐条 kbReview、客户批量逐条 infoQueueApply（IPC 零新增批量端点）',
    !mainSrc4.includes('sales:kb:batch') && !mainSrc4.includes('infoQueue:applyBatch') &&
    /for \(const id of ids\)[\s\S]{0,300}kbReview\(id, 'publish'\)/.test(storeSrc) &&
    storeSrc.includes("errors.push(`#${id}") &&
    /for \(const it of items\)[\s\S]{0,300}infoQueueApply/.test(cwsSrc))

  // f9 只看 diff 渲染静态断言：区级开关 + 同标题冲突检测 + 并排对照
  const kbSrc = readFileSync(join(ROOT, 'src/pages/KnowledgeBasePage.tsx'), 'utf8')
  ok('f9 只看 diff：区级开关 + 同标题（trim）冲突检测 + 已发布/提案并排对照渲染',
    kbSrc.includes('只看 diff') &&
    /conflictOf[\s\S]{0,200}\(p\.title \|\| ''\)\.trim\(\) === \(e\.title \|\| ''\)\.trim\(\)/.test(kbSrc) &&
    kbSrc.includes("kb-diff-col-head\">已发布：《") && kbSrc.includes('提案（待审核）') &&
    /function diffLines\(/.test(kbSrc))

  // ─── g. 旧库升级（§2.84）：真实构造治理前置旧版 sales DB 文件 → 当前 initialize 打开升级 ───
  // 不用当前 initialize() 新建的新库测——必须验证「磁盘上的旧文件 → 当前代码打开升级」真实路径。
  // 旧库 = 治理前置 schema：knowledge_base 只有 9 旧字段（无 status/authority/version/…），
  // 附带旧版 follow_up_task / customer_profile / intent_tag_log（同为旧字段形态）增强真实性。
  const WASM = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm')
  const SQL = await initSqlJs({ locateFile: () => WASM })
  const legacyDir = mkdtempSync(join(tmpdir(), 'kb-gov-legacy-'))
  const legacyDbFile = join(legacyDir, 'weflow-sales.db') // businessDbPath(legacyDir, undefined, 'sales') legacy 名
  const rawOld = new SQL.Database()
  rawOld.run(`
    CREATE TABLE knowledge_base (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL,
      product_line TEXT,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      tags TEXT DEFAULT '[]',
      scene TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE follow_up_task (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      customer_profile_id INTEGER,
      display_name TEXT,
      action_type TEXT DEFAULT 'reply_customer',
      trigger_type TEXT NOT NULL DEFAULT 'ai_detected',
      title TEXT NOT NULL,
      due_at INTEGER,
      status TEXT DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      completed_at INTEGER
    );
    CREATE TABLE customer_profile (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      display_name TEXT,
      customer_id TEXT,
      external_source TEXT,
      stage TEXT DEFAULT 'unknown',
      tags TEXT DEFAULT '[]',
      notes TEXT,
      last_contact_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE intent_tag_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      stage TEXT NOT NULL,
      confidence REAL,
      source TEXT NOT NULL,
      reason TEXT,
      created_at INTEGER NOT NULL
    );
  `)
  const legacyTs = Date.now()
  rawOld.run(
    'INSERT INTO knowledge_base (category, product_line, title, content, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ['product', 'X系列', '旧库产品条目', 'X 系列续航 8 小时', '[]', legacyTs, legacyTs]
  )
  rawOld.run(
    'INSERT INTO knowledge_base (category, product_line, title, content, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ['script', null, '旧库话术条目', '先谈价值再谈价格', '[]', legacyTs, legacyTs]
  )
  writeFileSync(legacyDbFile, Buffer.from(rawOld.export()))
  rawOld.close()

  // 单例已挂 dbDir（a-f 节），用 reopenForWxid 走 persistNow + detach + initialize 完整升级链
  await salesDbService.reopenForWxid(legacyDir)

  const upRows = salesDbService.kbList()
  const up1 = upRows.find((e) => e.title === '旧库产品条目')
  const up2 = upRows.find((e) => e.title === '旧库话术条目')
  ok('g1 存量两行经旧文件升级后仍在且内容一致',
    upRows.length === 2 && !!up1 && !!up2 &&
    up1.content === 'X 系列续航 8 小时' && up1.category === 'product' && up2.content === '先谈价值再谈价格')
  ok('g2 九个治理字段全部存在（ALTER 补列生效；可空列以 null 存在而非 undefined）',
    !!up1 && [up1.status, up1.authority, up1.version, up1.ttl_date, up1.reviewed_by, up1.reviewed_at,
      up1.reject_reason, up1.source, up1.evidence_key].every((f) => f !== undefined))
  ok('g3 存量默认状态符合设计（staging/community/version 1/source=manual——治理版上线后默认不可被问答引用）',
    up1?.status === 'staging' && up1?.authority === 'community' && up1?.version === 1 && up1?.source === 'manual')

  // 落盘后从磁盘文件校验：九列真实存在于表结构 + idx_kb_status 索引存在
  salesDbService.flushNow()
  const rawUp = new SQL.Database(readFileSync(legacyDbFile))
  const colNames = (rawUp.exec('PRAGMA table_info(knowledge_base)')[0]?.values ?? []).map((r) => String(r[1]))
  const govCols = ['status', 'authority', 'version', 'ttl_date', 'reviewed_by', 'reviewed_at', 'reject_reason', 'source', 'evidence_key']
  ok('g4 磁盘文件 PRAGMA 校验九个治理列真实存在', govCols.every((c) => colNames.includes(c)))
  const idxRows = rawUp.exec("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_kb_status'")
  ok('g5 idx_kb_status 索引已建（补列后创建，非 SCHEMA_SQL 提前建）', (idxRows[0]?.values ?? []).length === 1)
  rawUp.close()

  // published 行不被迁移覆盖：发布一行 → 落盘 → 再次 reopen（第二次 initialize）→ 仍 published
  const pubRow = upRows.find((e) => e.title === '旧库话术条目')!
  const pubLegacy = salesDbService.kbReview(pubRow.id!, 'publish', { reviewer: '主管甲' })
  ok('g6 旧库升级后的存量行可正常走审核状态机发布', pubLegacy.ok && pubLegacy.entry?.status === 'published')
  salesDbService.flushNow()
  await salesDbService.reopenForWxid(legacyDir)
  const afterReopen = salesDbService.kbGet(pubRow.id!)
  const stagingRow = salesDbService.kbList().find((e) => e.title === '旧库产品条目')
  ok('g7 第二次 initialize/reopen 幂等：published 不被迁移踩回 staging（reviewed_by 保留）+ 行数不增',
    afterReopen?.status === 'published' && afterReopen?.reviewed_by === '主管甲' &&
    salesDbService.kbList().length === 2 && stagingRow?.status === 'staging')
  ok('g8 存量清扫可重入（reopen 后显式重跑 staged=0，零副作用）', salesDbService.migrateKnowledgeGovernance().staged === 0)

  // 修复本身防回归：SCHEMA_SQL 不再提前建 idx_kb_status；索引创建位于治理列 ALTER 之后
  const salesDbSrc = readFileSync(join(ROOT, 'electron/services/salesDbService.ts'), 'utf8')
  const schemaBlock = salesDbSrc.match(/const SCHEMA_SQL = `[\s\S]*?^`/m)?.[0] ?? ''
  const alterPos = salesDbSrc.indexOf('ALTER TABLE knowledge_base ADD COLUMN')
  const idxPos = salesDbSrc.indexOf("CREATE INDEX IF NOT EXISTS idx_kb_status ON knowledge_base(status, updated_at)")
  ok('g9 SCHEMA_SQL 不含 idx_kb_status（防 no such column 中断旧库升级回归）',
    schemaBlock.length > 0 && !/CREATE INDEX IF NOT EXISTS idx_kb_status/.test(schemaBlock))
  ok('g10 先补列后建索引顺序锚点 + 迁移后列存在性校验在位',
    alterPos !== -1 && idxPos !== -1 && alterPos < idxPos &&
    salesDbSrc.includes('missingGov.length > 0') && salesDbSrc.includes('isDuplicateColumnError'))

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail > 0 ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
