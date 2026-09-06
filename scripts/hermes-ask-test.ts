/**
 * hermes-ask-test.ts —— 刀 3 带引用知识问答单测（设计-Hermes-MVP 刀 3）
 * 覆盖：
 *  a. published 过滤（铁律：LLM 只读 published 条目）——检索 SQL 静态断言 + staging/rejected 不出检索口动态断言
 *  b. 无命中分支：status=no_hit、不调模型、不记 generated 埋点
 *  c. 引用格式：《title》（vN）结构化 citations + 面板固定格式 + 引用只含 published 命中
 *  d. 脱敏前置（宪法 §2.6）：送 LLM 的 user prompt 不含原始手机号/wxid，含 ***
 *  e. 未配置模型静默：status=not_configured 不抛错不调用不埋点（isAiConfigured 真实判定）
 *  f. 埋点落行：answer → knowledge/generated（entity=knowledge_ask）；viewed（展开）同 askKey 只记一次
 *  g. 铁律静态断言：答案区无发送类 IPC（AI 碰不到发送键）/ 仅供参考标识 / 两入口接线 / enqueue 最外层
 * 运行：npx tsx scripts/hermes-ask-test.ts
 */
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

let pass = 0, fail = 0
function ok(name: string, cond: boolean): void {
  if (cond) { pass++ } else { fail++; console.error('FAIL:', name) }
}

const isoDir = mkdtempSync(join(tmpdir(), 'hermes-ask-'))
process.env.WEFLOW_USER_DATA_PATH = isoDir
process.env.WEFLOW_CONFIG_CWD = isoDir

import { salesDbService } from '../electron/services/salesDbService'
import { askKnowledge, markAskViewed, askKeyOf, extractKeywords, buildAskUserPrompt, ASK_SYSTEM_PROMPT, ASK_TEMPERATURE } from '../electron/services/hermesAskService'
import { ConfigService } from '../electron/services/config'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

async function main(): Promise<void> {
  const dbDir = mkdtempSync(join(tmpdir(), 'hermes-ask-db-'))
  await salesDbService.initialize(dbDir)

  // ─── a. published 过滤（检索 SQL 静态 + 动态）──────────────────────────────
  const dbSrc = readFileSync(join(ROOT, 'electron/services/salesDbService.ts'), 'utf8')
  ok('a1 静态断言：问答检索 SQL 必带 status = \'published\' 过滤（铁律锚点）',
    /kbSearchPublished[\s\S]{0,600}status = 'published'/.test(dbSrc))

  const stagingHit = salesDbService.kbCreate({ category: 'product', title: '待审续航条目', content: 'staging 续航内容不该被检索' })
  const pubA = salesDbService.kbCreate({ category: 'product', title: 'X系列电动叉车续航说明', content: 'X系列 3 吨电动叉车满电续航约 8 小时，支持快充' })
  salesDbService.kbReview(stagingHit.id!, 'reject', { reason: '未审定', reviewer: '主管甲' })
  const pubRejected = salesDbService.kbCreate({ category: 'product', title: '已拒续航条目', content: 'rejected 续航内容也不该被检索' })
  salesDbService.kbReview(pubRejected.id!, 'reject', { reason: '参数有误', reviewer: '主管甲' })
  salesDbService.kbReview(pubA.id!, 'publish', { reviewer: '主管甲' })
  salesDbService.run('UPDATE knowledge_base SET version = 2 WHERE id = ?', [pubA.id!]) // 引用格式用 v2 断言

  const hits = salesDbService.kbSearchPublished(['续航', '叉车'])
  ok('a2 动态断言：staging/rejected 命中也不出检索口，只回 published', hits.length === 1 && hits[0].id === pubA.id && hits[0].status === 'published')

  // ─── b. 无命中分支 ────────────────────────────────────────────────────────
  const genBefore = salesDbService.proposalEventCount({ event_type: 'knowledge', stage: 'generated' })
  const nohit = await askKnowledge({ question: '京剧脸谱艺术' }, { configured: true })
  ok('b1 无命中 → status=no_hit 且零条目', nohit.status === 'no_hit' && nohit.entries.length === 0)
  ok('b2 无命中不调模型不记 generated（漏斗诚实）',
    salesDbService.proposalEventCount({ event_type: 'knowledge', stage: 'generated' }) === genBefore)

  // ─── c. 引用格式 + 组答案 + generated 埋点 ─────────────────────────────────
  const captured: Array<{ system: string; user: string }> = []
  const fake = async (system: string, user: string): Promise<string> => {
    captured.push({ system, user })
    return 'X 系列 3 吨电动叉车满电续航约 8 小时，支持快充补电。'
  }
  const r = await askKnowledge({ question: 'X系列叉车续航多少' }, { configured: true, completion: fake })
  ok('c1 status=answer 且引用只含 published 命中（staging/rejected 不入引用）',
    r.status === 'answer' && r.citations?.length === 1 && r.citations[0].id === pubA.id)
  ok('c2 引用带条目版本号（vN 落 citations）', r.citations?.[0].version === 2 && r.citations[0].title === 'X系列电动叉车续航说明')
  ok('c3 答案来自查询结果链路（LLM 正文透传，不编造）', r.answer === 'X 系列 3 吨电动叉车满电续航约 8 小时，支持快充补电。')
  ok('c4 单一固定 system prompt + temperature 0.2 出口',
    captured.length === 1 && captured[0].system === ASK_SYSTEM_PROMPT && ASK_TEMPERATURE === 0.2)
  ok('c5 user prompt 含命中条目标题与版号（《title》（vN）格式）',
    captured[0].user.includes('《X系列电动叉车续航说明》（v2）'))
  ok('c6 generated 埋点落行（entity=knowledge_ask，askKey 哈希）',
    salesDbService.proposalEventEntityIds('knowledge', 'generated', 'knowledge_ask').has(r.askKey) && r.askKey === askKeyOf('X系列叉车续航多少'))
  ok('c7 面板固定引用格式「引用自：《title》（vN）」静态断言', (() => {
    const panel = readFileSync(join(ROOT, 'src/components/sales/KnowledgeAskPanel.tsx'), 'utf8')
    return panel.includes('引用自：《') && panel.includes('》（v') && panel.includes("navigate('/knowledge-base'")
  })())

  // ─── d. 脱敏前置（宪法 §2.6）─────────────────────────────────────────────
  const pubMask = salesDbService.kbCreate({ category: 'faq', title: '销售联系话术样例', content: '有问题联系 13800138000 或加 wxid_abc123def，身份证 110101199001011234' })
  salesDbService.kbReview(pubMask.id!, 'publish', { reviewer: '主管甲' })
  let maskUser = ''
  const r2 = await askKnowledge({ question: '销售联系话术样例' }, {
    configured: true,
    completion: async (_s, user) => { maskUser = user; return '样例话术已返回' }
  })
  ok('d1 检索命中脱敏条目', r2.status === 'answer' && r2.citations?.some(c => c.id === pubMask.id))
  ok('d2 送 LLM 的 prompt 不含原始手机号/wxid/身份证（未脱敏原文不出本机）',
    !maskUser.includes('13800138000') && !maskUser.includes('wxid_abc123def') && !maskUser.includes('110101199001011234'))
  ok('d3 脱敏后打码 *** 存在', maskUser.includes('***'))

  // ─── e. 未配置模型静默 ────────────────────────────────────────────────────
  let unconfiguredCalled = 0
  const r3 = await askKnowledge({ question: 'X系列叉车续航多少' }, {
    completion: async () => { unconfiguredCalled++; return '不应被调用' }
  })
  ok('e1 未配置（默认判定）→ not_configured 且模型零调用', r3.status === 'not_configured' && unconfiguredCalled === 0)
  const r3b = await askKnowledge({ question: 'X系列叉车续航多少' }, {
    config: ConfigService.getInstance(),
    completion: async () => { unconfiguredCalled++; return '不应被调用' }
  })
  ok('e2 isAiConfigured 真实判定（隔离环境未配置）→ 静默提示不抛错', r3b.status === 'not_configured' && unconfiguredCalled === 0)
  ok('e3 未配置不记 generated（c/d 两次成功问答各 1 条，e1/e2 零新增）',
    salesDbService.proposalEventCount({ event_type: 'knowledge', stage: 'generated' }) === genBefore + 2)

  // ─── f. 埋点落行：viewed（展开）同 askKey 只记一次 ─────────────────────────
  markAskViewed({ question: 'X系列叉车续航多少' })
  markAskViewed({ question: 'X系列叉车续航多少' })
  ok('f1 viewed 同 askKey 只记一次（防反复展开刷屏）',
    salesDbService.proposalEventCount({ event_type: 'knowledge', stage: 'viewed' }) === 1 &&
    salesDbService.proposalEventEntityIds('knowledge', 'viewed', 'knowledge_ask').has(askKeyOf('X系列叉车续航多少')))
  markAskViewed({ question: 'CPD15 载重参数' })
  ok('f2 不同问题独立 askKey 独立记账',
    salesDbService.proposalEventCount({ event_type: 'knowledge', stage: 'viewed' }) === 2)

  // ─── g. 纯函数 + 铁律静态断言 ─────────────────────────────────────────────
  ok('g1 extractKeywords：2/3-gram 提取 + 短问题整句入列 + 停用字过滤',
    extractKeywords('这车续航多少').includes('续航') && !extractKeywords('这车续航多少').includes('多少') && extractKeywords('叉车').includes('叉车'))
  ok('g2 askKeyOf 确定性（同问同 key，跨次去重依据）', askKeyOf('问题A') === askKeyOf('问题A') && askKeyOf('问题A') !== askKeyOf('问题B'))
  ok('g3 buildAskUserPrompt 结构（客户问题 + 知识库参考 + 只依据约束）',
    buildAskUserPrompt('Q', [{ title: 'T', content: 'C', version: 3 }]).includes('【客户问题】') &&
    buildAskUserPrompt('Q', [{ title: 'T', content: 'C', version: 3 }]).includes('【知识库参考】') &&
    buildAskUserPrompt('Q', [{ title: 'T', content: 'C', version: 3 }]).includes('《T》（v3）'))

  const panelSrc = readFileSync(join(ROOT, 'src/components/sales/KnowledgeAskPanel.tsx'), 'utf8')
  ok('g4 铁律：答案区无发送类 IPC（AI 碰不到发送键，静态断言）',
    !/sendMsg|sendMessage|sendTextMessage|msgSend|chat:send|message:send|sendImage/.test(panelSrc))
  ok('g5 答案固定带「知识答案，仅供参考」标识', panelSrc.includes('知识答案，仅供参考'))
  ok('g6 无命中分支：「知识库里没有答案」+ 生成知识提案按钮（刀 4 前置灰）',
    panelSrc.includes('知识库里没有答案') && panelSrc.includes('生成知识提案') && panelSrc.includes('下一版'))
  ok('g7 入口①：聊天页会话侧栏挂问知识库入口 + 面板',
    readFileSync(join(ROOT, 'src/pages/ChatPage.tsx'), 'utf8').includes('<KnowledgeAskPanel open={askPanelOpen}') &&
    readFileSync(join(ROOT, 'src/pages/ChatPage.tsx'), 'utf8').includes('title="问知识库"'))
  ok('g8 入口②：客户档案「AI 工具」下拉挂问知识库',
    readFileSync(join(ROOT, 'src/pages/CustomerWorkspacePage.tsx'), 'utf8').includes('问知识库') &&
    readFileSync(join(ROOT, 'src/pages/CustomerWorkspacePage.tsx'), 'utf8').includes('<KnowledgeAskPanel open={askPanelOpen}'))

  const mainSrc = readFileSync(join(ROOT, 'electron/main.ts'), 'utf8')
  ok('g9 IPC enqueue 最外层：sales:kb:ask 与 askViewed 均走 enqueueSalesTask（服务内部零 enqueue）',
    /sales:kb:ask[\s\S]{0,200}enqueueSalesTask/.test(mainSrc) && /sales:kb:askViewed[\s\S]{0,200}enqueueSalesTask/.test(mainSrc) &&
    !/enqueueSalesTask/.test(readFileSync(join(ROOT, 'electron/services/hermesAskService.ts'), 'utf8')))
  const trackSrc = readFileSync(join(ROOT, 'electron/services/proposalEventTracking.ts'), 'utf8')
  ok('g10 viewed 去重落在 trackKnowledgeAskViewed（proposalEventEntityIds 单点）',
    trackSrc.includes("proposalEventEntityIds('knowledge', 'viewed', 'knowledge_ask')"))

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail > 0 ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
