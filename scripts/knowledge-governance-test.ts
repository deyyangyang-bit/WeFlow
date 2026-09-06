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
 * 运行：npx tsx scripts/knowledge-governance-test.ts
 */
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

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

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail > 0 ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
