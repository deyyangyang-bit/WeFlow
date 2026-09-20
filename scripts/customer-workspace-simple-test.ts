/**
 * customer-workspace-simple-test.ts —— 客户工作台简化改版单测（设计稿-客户工作台简化 屏 1-4）
 * 覆盖：
 *  a. buildActionQueue 行为：三源合并 / follow 与 insight 去重（同客户留 follow）/ info 独立保留 /
 *     reason/suggest 文案 / 排序（follow→info→insight，follow 按 score 降序）/ 键唯一
 *  b. 静态断言：三页签 ViewTab 渲染移除 / 行动队列合并三源 / 抽屉头部按钮=2+AI 工具下拉 /
 *     时间线画像业务默认折叠 / 深链三协议保留 / 零硬编码 hex / AI 深度分析卡面按钮撤除
 * 运行：npx tsx scripts/customer-workspace-simple-test.ts
 */
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; console.log(`  ✅ ${name}`) } else { fail++; console.log(`  ❌ ${name} ${detail}`) }
}

import { buildActionQueue } from '../src/utils/customerActionQueue'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// ─── a. buildActionQueue 行为 ────────────────────────────────────────────────
{
  const customers = [
    { id: 1, session_id: 'wxid_wang', name: '王静', profile_display_name: '王静 · 示例采购', company: '示例采购' },
    { id: 2, session_id: 'wxid_zhang', name: '张开国' },
    { id: 3, session_id: 'wxid_liu', name: '小小刘' },
    { id: 4, session_id: 'wxid_quiet', name: '无信号客户' }
  ]
  const signals = [
    // 王静：task 信号（值得跟进）
    { sessionId: 'wxid_wang', priorityScore: 90, sources: [{ type: 'task', label: '报价跟进', reason: '报价发出 3 天没回复——再不跟就凉了' }] },
    // 小小刘：无 task 源（AI 新发现）
    { sessionId: 'wxid_liu', priorityScore: 60, sources: [{ type: 'alert', label: '重要提醒', reason: '聊天里提到竞品「合力」——可能在比价' }] },
    // 无信号客户：不出卡
    { sessionId: 'wxid_nobody', priorityScore: 99, sources: [] }
  ]
  const infoPending = [
    { account_id: 2, account_name: '张开国', field: 'company', value: '南通开国机械', confidence: 0.82, evidence: '我们开国机械在南通这边……' }
  ]

  const q = buildActionQueue(customers, signals, infoPending)

  ok('a1 三源合并：3 张卡（follow 1 + info 1 + insight 1）', q.length === 3, JSON.stringify(q.map((x) => x.key)))
  ok('a2 follow 卡：reason=task reason / pill=amber 待跟进',
    q[0].kind === 'follow' && q[0].pill === 'amber' && q[0].pillText === '待跟进' && q[0].reason.includes('报价发出 3 天'))
  ok('a3 follow 卡 suggest 回退到建议文案', q[0].suggest.length > 0)
  ok('a4 info 卡：字段中文名 + 置信 + 证据（屏 1 第 2 张卡文案）',
    q[1].kind === 'info' && q[1].reason.includes('公司') && q[1].reason.includes('南通开国机械') && q[1].reason.includes('82%') && q[1].suggest.includes('证据'))
  ok('a5 info 卡 customer 缺行时用 account_name 兜底', q[1].displayName === '张开国' && q[1].accountId === 2)
  ok('a6 insight 卡：pill=blue AI 发现 + reason=信号 reason',
    q[2].kind === 'insight' && q[2].pill === 'blue' && q[2].reason.includes('合力'))
  ok('a7 排序 follow→info→insight', q.map((x) => x.kind).join(',') === 'follow,info,insight')
  ok('a8 键唯一', new Set(q.map((x) => x.key)).size === q.length)
  ok('a9 无信号客户不出卡', !q.some((x) => x.displayName === '无信号客户'))

  // 同客户 follow + insight 并存：只留 follow（insight 是弱信号）
  const dupSignals = [
    { sessionId: 'wxid_wang', priorityScore: 90, sources: [{ type: 'task', label: '报价跟进', reason: '报价 3 天未回' }] },
    { sessionId: 'wxid_wang', priorityScore: 50, sources: [{ type: 'insight', label: '动向', reason: '客户打开过报价单' }] }
  ]
  const q2 = buildActionQueue(customers.slice(0, 1), dupSignals, [])
  ok('a10 同客户 follow+insight 去重留 follow', q2.length === 1 && q2[0].kind === 'follow')

  // follow 多卡按 score 降序
  const multi = buildActionQueue(customers, [
    { sessionId: 'wxid_zhang', priorityScore: 70, sources: [{ type: 'task', label: '新客响应', reason: 'b' }] },
    { sessionId: 'wxid_wang', priorityScore: 90, sources: [{ type: 'task', label: '报价跟进', reason: 'a' }] }
  ], [])
  ok('a11 follow 多卡按 priorityScore 降序', multi[0].displayName.includes('王静') && multi[1].displayName.includes('张开国'))

  // 空输入
  ok('a12 空输入 → 空队列（空态由页面渲染）', buildActionQueue([], [], []).length === 0)
}

// ─── b. 静态断言 ─────────────────────────────────────────────────────────────
{
  const pageSrc = readFileSync(join(ROOT, 'src/pages/CustomerWorkspacePage.tsx'), 'utf-8')
  ok('b1 三页签 ViewTab 渲染移除（类型+tabs 按钮不再出现）',
    !pageSrc.includes("type ViewTab") && !pageSrc.includes('cws-tabs') && !pageSrc.includes("as ViewTab[]"))
  ok('b2 行动队列合并三源（buildActionQueue 接 customers+signals+infoPending）',
    pageSrc.includes('buildActionQueue(customers, signals, queues.infoPending'))
  ok('b3 空态「都处理完了」+ 引导（屏 2）', pageSrc.includes('都处理完了') && pageSrc.includes('今日行动'))
  ok('b4 搜索态：无关键词不渲染全量列表（searchActive 门控）',
    pageSrc.includes('searchActive') && pageSrc.includes('搜客户名 / 公司'))
  ok('b5 抽屉动作行 + AI 工具扁平清单（AI 补全/深度分析/AI 报价/Hermes，动态箭头折叠）',
    pageSrc.includes('AI 工具 {showAiTools') && pageSrc.includes("aria-expanded={showAiTools}")
    && (pageSrc.match(/cws-aitools__item/g) || []).length >= 5
    && pageSrc.includes('AI 报价') && pageSrc.includes('让 Hermes 分析')
    && !pageSrc.includes('onClick={() => void runEnrichOne(selectedCustomer)} disabled={!selectedCustomer.session_id}><Sparkles size={13} /> AI 补全</button>\n              <button'))
  ok('b6 卡面「AI 深度分析」按钮撤除', !pageSrc.includes('AI 深度分析</button>'))
  ok('b7 时间线/画像/业务默认折叠（fold 状态三件套）',
    pageSrc.includes('foldTimeline') && pageSrc.includes('foldProfile') && pageSrc.includes('foldBiz')
    && pageSrc.includes("useState(false)") && pageSrc.includes('cws-fold'))
  ok('b8 深链三协议保留（?id= / ?sid= / ?stage=）',
    pageSrc.includes("searchParams.get('id')") && pageSrc.includes("searchParams.get('sid')") && pageSrc.includes("searchParams.get('stage')"))
  ok('b9 本机判断四格置顶（判断区先于跟进待办出现，共用 .side-block 节奏）',
    pageSrc.includes('本机判断') && pageSrc.includes('className="verdicts"') &&
    pageSrc.indexOf('本机判断') < pageSrc.indexOf('跟进待办'))
  ok('b10 处理成功即从队列移除（乐观移除 dismissed）', pageSrc.includes('dismissed') && pageSrc.includes('handleComplete'))
  ok('b11 主按钮 handler 复用（openChat/handleComplete→completeSignal/handleInfo→applyInfo）',
    pageSrc.includes('openChat(it.customer)') && pageSrc.includes('void handleComplete(it)')
      && pageSrc.includes("handleInfo(it, 'accept')") && pageSrc.includes("applyInfo(it.infoItem, action)"))

  const utilSrc = readFileSync(join(ROOT, 'src/utils/customerActionQueue.ts'), 'utf-8')
  ok('b12 buildActionQueue 抽到可测位置（独立纯函数模块，零 react/electron 依赖）',
    utilSrc.includes('export function buildActionQueue') && !utilSrc.includes('react') && !utilSrc.includes('electron'))

  // 零硬编码 hex：整份 stylesheet 只用 --color-* / --radius-* / --font-* 语义变量族
  const scssSrc = readFileSync(join(ROOT, 'src/pages/CustomerWorkspacePage.scss'), 'utf-8')
  ok('b13 scss 零硬编码 hex（--color-* 语义变量族，全文件）',
    scssSrc.includes('var(--color-') && !/#[0-9a-fA-F]{3,8}\b/.test(scssSrc))
  ok('b14 行内状态标记语义类齐备（follow/insight 发丝边两档；阶段 pill 走共享 main.scss 体系）',
    scssSrc.includes('.cws-q__tag--follow') && scssSrc.includes('.cws-q__tag--insight') &&
    pageSrc.includes('stagePillClass'))

  // owner 过滤（任务四）：HEAD 已含 filterByOwner → 队列与搜索继承（customers 源头过滤）
  ok('b15 队列与搜索继承 owner 过滤（customers 在 fetchAll 已 filterByOwner）',
    pageSrc.includes('setCustomers(filterByOwner(rows, idLike))'))
}

  // ─── c. 搜索结果分页 + follow 卡「完成待办」次级入口（§2.75 前端遗留四项 ①②）────
  {
    const src2 = readFileSync(join(ROOT, 'src/pages/CustomerWorkspacePage.tsx'), 'utf-8')
    ok('c1 搜索态结果为概念稿自绘索引表（cws-ix 表头列 + 行级发丝结构，不再复用 SearchTable）',
      src2.includes('className="thead cws-ix"') && src2.includes('cws-ix--row'))
    ok('c2 索引分页受控（INDEX_PAGE_SIZE 切片 + 上一页/下一页 setSearchPage + 页码摘要）',
      src2.includes('INDEX_PAGE_SIZE') &&
      src2.includes('searchResults.slice((indexPage - 1) * INDEX_PAGE_SIZE, indexPage * INDEX_PAGE_SIZE)') &&
      src2.includes('setSearchPage(indexPage - 1)') && src2.includes('setSearchPage(indexPage + 1)') &&
      src2.includes('第 {indexPage} / {indexTotalPages} 页'))
    ok('c3 搜索/阶段筛选变化回第 1 页', /useEffect\(\(\) => \{ setSearchPage\(1\) \}, \[searchKw, stageFilter\]\)/.test(src2))
    ok('c4 空态文案保留（无匹配客户）', src2.includes('cws-ix__empty') && src2.includes('无匹配客户'))
    ok('c5 结果行可点开档案（行 onClick → openCustomer）', src2.includes('onClick={() => void openCustomer(c)}'))

    ok('c6 follow 卡次级入口「完成待办」（task 源解析 pendingTodoIdOf）',
      src2.includes('pendingTodoIdOf') && src2.includes("s.type === 'task'") && src2.includes('rawTaskId'))
    ok('c7 不可完成时入口不出现（todoId<=0 不渲染按钮）',
      src2.includes('{pendingTodoIdOf(it) > 0 && ('))
    ok('c8 复用现有 todo 完成 handler（sales.todoUpdate status done，零新 IPC）',
      /todoUpdate\(todoId, \{ status: 'done' \}\)/.test(src2))
    ok('c9 完成待办后卡片退出队列（dismissCard + fetchAll）',
      /completeTodoOfCard[\s\S]{0,400}dismissCard\(it\.key\)/.test(src2))
    ok('c10 原有「已处理」保留（completeSignal 闭环不被动）', src2.includes('void handleComplete(it)') && src2.includes('actionCompleteUnified'))
  }

console.log(`\ncustomer-workspace-simple-test: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
