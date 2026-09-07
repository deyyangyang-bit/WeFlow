/**
 * hermesToolRegistry.ts —— Hermes 只读智能体工具白名单（设计-Hermes-MVP 智能体第一刀）
 *
 * 铁律（hermes-agent-test 静态/动态断言锚点，改本文件先跑测试）：
 *  - 白名单常量 HERMES_TOOLS 一处定义两处消费（本文件执行器 + hermesAgent 校验 + 测试断言）；
 *    清单外工具名不存在 = 模型调不到（hermesAgent 拒绝执行）
 *  - 全部只读：零写库、零发送类 IPC、零文件系统访问；AI 结论永不落库（不写 stage/judgment）
 *  - 销售身份客户类工具先过 filterByOwner（shared/ownerFilter 唯一语义源，本文件不建第二套）；
 *    查不到/不可见一律返回 ok:false + 'not_found'（可见性话术，不泄露行是否存在）
 *  - ⚠️ filterByOwner 是展示层可见性过滤（ownerFilter.ts 头注释明示：非安全边界，
 *    身份为本机自我声明）——Hermes 不宣称访问控制保证；真正门禁待可信设备/账号绑定后
 *    由服务端或可信本机凭证校验。本文档与测试一律称「可见性过滤」，不得称「权限」。
 *  - 归属过滤必须在候选集合上先全量、后过滤、再 slice——禁止先 LIMIT 后过滤
 *    （否则本人可见行会被排前的他人行挤出结果）
 *  - 聊天内容进模型前强制 maskPrivateText 脱敏（宪法 §2.6）+ 逐条截断；sender 等
 *    结构化标识字段走 maskStructuredId（isSessionIdLike 命中微信号三形态一律 ***）
 *  - 模型可见摘要零会话标识：accountBrief 等不携带 sessionId；customer.by_session
 *    只认宿主持有的当前 chat context（ctx.contextKind），模型提供的 sessionId 一律
 *    不读取不采信；非 chat 上下文 → context_required，不存在/越权统一 not_found 不泄露
 *  - evidence 只来自本轮真实工具返回行（id/messageKey 均为查得值，绝不由模型填）
 *  - 工具输出统一 {ok, data?, evidence?, publicSummary, errorCode?}（publicSummary 面向用户可展示；
 *    用户可见的步骤/兜底证据 label 用 publicLabel 人话名称，绝不显示内部工具 ID）
 */
import { crmDbService, type CrmRow } from './crmDbService'
import { salesDbService } from './salesDbService'
import { chatService, type Message } from './chatService'
import { getCustomerCurrentView } from './customerCurrentView'
import { extractKeywords } from './hermesAskService'
import { maskPrivateText } from './crmSla2Service'
import { isSessionIdLike } from '../../shared/wechatId'
import { filterByOwner, type IdentityLike } from '../../shared/ownerFilter'

/** 单条证据：label 面向用户；锚点（entityId/messageKey）只允许来自真实查询行。
 *  kind='result' 是工具结果级证据（查询无结果/未成功时由 agent 兜底登记，结论「查不到」可引用） */
export interface HermesEvidence {
  label: string
  kind: 'customer' | 'chat' | 'crm' | 'knowledge' | 'action' | 'result'
  /** 知识库条目 id / account id（真实查得） */
  entityId?: number
  /** 聊天证据回查锚点（P0-2B canonical key，真实查得） */
  messageKey?: string
  /** 脱敏后的摘句 */
  excerpt?: string
  /** 不透明回查句柄：只由 Main 桥在跨进程时分配（Main 按 taskId+handle 保留原始
   *  messageKey 锚点），工具实现与进程内模式永不设置 */
  evidenceHandle?: string
}

/** 统一工具输出（任务书 §7 契约） */
export interface HermesToolResult {
  ok: boolean
  data?: unknown
  evidence?: HermesEvidence[]
  publicSummary: string
  errorCode?: string
}

/** 工具执行上下文：身份 + 入口注入的任务上下文（agent 构造，工具不自取） */
export interface HermesToolContext {
  identity: IdentityLike
  /** 任务上下文里的客户（customer 入口注入；chat 入口为 null） */
  accountId?: number
  /** 宿主持有的会话锚点（chat/customer 入口注入；只是提示锚点绝非授权凭据） */
  sessionId?: string
  /** 任务入口上下文类型（agent 定格；customer.by_session 只认 chat 上下文） */
  contextKind?: 'global' | 'chat' | 'customer'
}

/** 工具定义（name 即白名单键） */
export interface HermesToolDef {
  name: string
  /** 人话名称（用户可见：步骤 label / 兜底证据 label 统一用它，绝不显示内部工具 ID） */
  publicLabel: string
  description: string
  /** 给模型看的参数说明（JSON 对象字段的中文描述） */
  argsHint: string
  run(args: Record<string, unknown>, ctx: HermesToolContext): Promise<HermesToolResult>
}

// ─── 参数规整（模型参数不可信：全部强制转换 + 收紧上限）────────────────────────

function strArg(v: unknown): string {
  return String(v ?? '').trim()
}

function numArg(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function fmtAmount(n: number): string {
  return Number(n || 0).toLocaleString('zh-CN', { maximumFractionDigits: 0 })
}

/** 结构化标识脱敏（只用于 sender 等结构化字段，绝不用于自由正文防误伤）：
 *  微信号三形态（wxid_ 前缀号 / 自定义微信号 / 群号）命中 isSessionIdLike 一律 ***；
 *  未命中仍走 maskPrivateText（保留手机号/身份证/wxid_* 文本脱敏） */
export function maskStructuredId(v: string): string {
  return isSessionIdLike(v) ? '***' : maskPrivateText(v)
}

/** account 行 → 对模型/用户可见的安全字段（不外带手机号等敏感列；
 *  模型可见摘要一律不含 sessionId——会话标识不出宿主，识别会话走 customer.by_session 宿主上下文） */
function accountBrief(a: CrmRow): Record<string, unknown> {
  return {
    accountId: Number(a.id),
    name: String(a.name || ''),
    stage: String(a.sales_stage || a.stage || ''),
    company: String(a.company || '')
  }
}

/** 客户类工具的统一可见性校验：取 account 行 → filterByOwner；不可见/不存在统一 not_found（可见性话术，不泄露行是否存在） */
function resolveAccountOwned(args: Record<string, unknown>, ctx: HermesToolContext): { account: CrmRow } | { err: HermesToolResult } {
  const accountId = numArg(args.accountId)
  if (!accountId) {
    return { err: { ok: false, publicSummary: '缺少客户 id。可先用 customer.search 按名字找到客户。', errorCode: 'bad_arguments' } }
  }
  const acc = crmDbService.getById('account', accountId)
  const visible = acc ? filterByOwner([acc], ctx.identity) : []
  if (!acc || visible.length === 0) {
    return { err: { ok: false, publicSummary: '没有找到这个客户（可能不在你的客户范围内）。', errorCode: 'not_found' } }
  }
  return { account: visible[0] }
}

// ─── 九个只读工具（全部复用既有读口；执行器与白名单一一对应）────────────────────

/** customer.search：按名字模糊搜索（复用刀 5 accountSearchByName 读口 + owner 过滤） */
const customerSearch: HermesToolDef = {
  name: 'customer.search',
  publicLabel: '客户搜索',
  description: '按客户名字模糊搜索客户档案，返回客户 id、名称、阶段、公司。',
  argsHint: '{"query": "客户名字（必填）", "limit": "最多返回几条，默认 5，上限 10"}',
  run: async (args, ctx) => {
    const query = strArg(args.query)
    if (!query) return { ok: false, publicSummary: '请提供要搜索的客户名字。', errorCode: 'bad_arguments' }
    const limit = Math.min(Math.max(Math.floor(numArg(args.limit) || 5), 1), 10)
    // 先取完整名称匹配集合（limit=0 = SQL 无 LIMIT）→ 归属过滤 → 再 slice。
    // 禁止先 LIMIT 后过滤：任何有限候选都会被足够多的他人记录挤掉本人可见行。
    const candidates = crmDbService.accountSearchByName(query, 0)
    const rows = filterByOwner(candidates, ctx.identity).slice(0, limit)
    if (rows.length === 0) {
      // 诚实且不泄露：销售视角下空 = 不存在或不在你名下，统一话术
      return { ok: true, data: { customers: [], total: 0 }, publicSummary: `没有找到名字含「${query}」的客户。` }
    }
    return {
      ok: true,
      data: { customers: rows.map(accountBrief), total: rows.length },
      evidence: rows.map((r) => ({
        label: `客户档案：${String(r.name || '')}`,
        kind: 'customer' as const,
        entityId: Number(r.id)
      })),
      publicSummary: `找到 ${rows.length} 个客户：${rows.map((r) => String(r.name || '')).join('、')}。`
    }
  }
}

/** customer.by_session：把当前任务绑定的微信会话解析为客户档案（聊天入口的桥梁工具）。
 *  信任边界：只认宿主持有的当前 chat context——模型提供的任何 sessionId 一律不读取、
 *  不采信；非 chat 上下文 → context_required 人话提示；不存在/越权统一 not_found 不泄露 */
const customerBySession: HermesToolDef = {
  name: 'customer.by_session',
  publicLabel: '会话客户识别',
  description: '把当前任务绑定的微信会话解析为客户档案，返回客户 id、名称、阶段（聊天入口分析客户的第一步；无需提供会话 id）。',
  argsHint: '{}（会话由当前聊天上下文持有，不接受也不需要提供）',
  run: async (_args, ctx) => {
    if (ctx.contextKind !== 'chat' || !ctx.sessionId) {
      return { ok: false, publicSummary: '当前任务没有绑定聊天上下文，无法识别会话对应的客户。请改用 customer.search 按名字查找。', errorCode: 'context_required' }
    }
    const acc = crmDbService.accountBySession(ctx.sessionId)
    const visible = acc ? filterByOwner([acc], ctx.identity) : []
    if (!acc || visible.length === 0) {
      // 可见性话术与 customer.search 同口径：不存在/不可见统一 not_found
      return { ok: false, publicSummary: '没有找到这个会话对应的客户档案（可能不在你的客户范围内）。', errorCode: 'not_found' }
    }
    const row = visible[0]
    return {
      ok: true,
      data: accountBrief(row),
      evidence: [{ label: `客户档案：${String(row.name || '')}`, kind: 'customer', entityId: Number(row.id) }],
      publicSummary: `该会话对应客户「${String(row.name || '')}」（当前阶段 ${String(row.sales_stage || row.stage || '未知')}），可用 accountId=${Number(row.id)} 继续查询。`
    }
  }
}

/** customer.current_view：客户当前视图（State + 四类判断投影；复用 P0-3 getCustomerCurrentView） */
const customerCurrentViewTool: HermesToolDef = {
  name: 'customer.current_view',
  publicLabel: '客户当前视图',
  description: '查看某客户的当前视图：阶段状态与 AI 判断（小结/机会/风险/下一步），不展开证据正文。',
  argsHint: '{"accountId": "客户 id（必填，先用 customer.search 找到）"}',
  run: async (args, ctx) => {
    const r = resolveAccountOwned(args, ctx)
    if ('err' in r) return r.err
    const view = getCustomerCurrentView(String(r.account.session_id || ''))
    if (!view) {
      return { ok: true, data: { found: false }, publicSummary: `「${String(r.account.name || '')}」暂无档案视图。` }
    }
    const judgments: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(view.judgments)) {
      judgments[k] = v
        ? { value: String(v.value || '').slice(0, 160), source: v.source, freshness: v.freshness, evidenceStatus: v.evidenceStatus }
        : null
    }
    const summaryText = view.judgments.summary?.value
      ? `AI 小结：${view.judgments.summary.value.slice(0, 120)}`
      : '暂无 AI 判断。'
    return {
      ok: true,
      data: { name: String(r.account.name || ''), stage: String(view.state.stage || ''), judgments },
      evidence: [{ label: `客户视图：${String(r.account.name || '')}`, kind: 'customer', entityId: Number(r.account.id) }],
      publicSummary: `「${String(r.account.name || '')}」当前视图已取得。${summaryText}`
    }
  }
}

/** chat.recent：最近聊天记录（归属校验 → WCDB 读口 → maskPrivateText 脱敏 + 截断） */
const chatRecent: HermesToolDef = {
  name: 'chat.recent',
  publicLabel: '聊天记录查询',
  description: '查看某客户微信会话的最近聊天记录（已自动脱敏手机号/微信号/身份证号），每条带 messageKey 证据锚点。',
  argsHint: '{"accountId": "客户 id（必填，先用 customer.search 找到）", "limit": "条数，默认 10，上限 20"}',
  run: async (args, ctx) => {
    const r = resolveAccountOwned(args, ctx)
    if ('err' in r) return r.err
    const sessionId = String(r.account.session_id || '')
    if (!sessionId) return { ok: true, data: { messages: [], total: 0 }, publicSummary: '该客户未关联微信会话，没有聊天记录。' }
    const limit = Math.min(Math.max(Math.floor(numArg(args.limit) || 10), 1), 20)
    const res = await chatService.getMessages(sessionId, 0, limit, 0, 0, false)
    if (!res.success || !res.messages) {
      return { ok: false, publicSummary: '暂时无法读取聊天记录（微信数据库未连接或会话不可用）。', errorCode: 'chat_unavailable' }
    }
    const messages = res.messages.map((m: Message) => ({
      // isSend: 1=我发出 / 0=对方发出；脱敏 + 截断在进模型前完成（宪法 §2.6）。
      // sender 是结构化标识字段：微信号三形态（含自定义微信号）命中 isSessionIdLike 一律 ***
      direction: Number(m.isSend) === 1 ? 'sent' : 'received',
      sender: maskStructuredId(String(m.senderUsername || '')).slice(0, 30),
      text: maskPrivateText(String(m.parsedContent || '')).slice(0, 200),
      time: Number(m.createTime) || 0,
      messageKey: String(m.messageKey || '')
    }))
    const excerpts = messages.slice(0, 3).map((m) => `${m.direction === 'sent' ? '我' : '对方'}：${m.text}`)
    return {
      ok: true,
      data: { customer: String(r.account.name || ''), messages, total: messages.length },
      evidence: messages
        .filter((m) => m.text)
        .slice(0, 5)
        .map((m) => ({
          label: `聊天记录（${m.direction === 'sent' ? '我发出' : '对方'}）`,
          kind: 'chat' as const,
          messageKey: m.messageKey,
          excerpt: m.text
        })),
      publicSummary: `已读取「${String(r.account.name || '')}」最近 ${messages.length} 条消息。${excerpts.length ? `如：${excerpts[0].slice(0, 60)}` : ''}`
    }
  }
}

/** crm.customer_business：某客户商机 + 合同（复用刀 5 读口组合；contract 归属经 account 校验） */
const crmCustomerBusiness: HermesToolDef = {
  name: 'crm.customer_business',
  publicLabel: '客户商机与合同查询',
  description: '查看某客户名下的商机（阶段/金额/产品/沉默天数）与合同（状态/金额）。',
  argsHint: '{"accountId": "客户 id（必填，先用 customer.search 找到）"}',
  run: async (args, ctx) => {
    const r = resolveAccountOwned(args, ctx)
    if ('err' in r) return r.err
    const accountId = Number(r.account.id)
    const now = Date.now()
    const opps = crmDbService.opportunityList({ accountId })
    const contracts = crmDbService.contractsByAccount(accountId)
    const oppRows = opps.map((o) => {
      const last = Number(o.last_signal_at || 0)
      const silent = last > 0 ? Math.max(0, Math.floor((now - (last > 1e11 ? last : last * 1000)) / 86400000)) : null
      return {
        id: Number(o.id),
        product: String(o.product || ''),
        stage: String(o.stage || ''),
        status: String(o.status || ''),
        amount: Number(o.amount || 0),
        silentDays: silent
      }
    })
    const contractRows = contracts.map((c) => ({
      id: Number(c.id),
      name: String(c.name || ''),
      status: String(c.status || ''),
      amount: Number(c.amount || 0)
    }))
    const activeOpp = oppRows.find((o) => o.status === 'active')
    const parts = [`「${String(r.account.name || '')}」`]
    parts.push(activeOpp
      ? `活跃商机在「${activeOpp.stage || '未知'}」阶段${activeOpp.amount > 0 ? `（¥${fmtAmount(activeOpp.amount)}）` : ''}${activeOpp.silentDays != null ? `，最近信号 ${activeOpp.silentDays === 0 ? '就在今天' : `${activeOpp.silentDays} 天前`}` : ''}。`
      : '名下没有活跃商机。')
    parts.push(contractRows.length > 0
      ? `共 ${contractRows.length} 份合同，最新「${contractRows[0].name || '未命名'}」状态 ${contractRows[0].status}。`
      : '名下暂无合同。')
    const evidence: HermesEvidence[] = []
    if (activeOpp) evidence.push({ label: `商机：${activeOpp.product || r.account.name}（${activeOpp.stage}）`, kind: 'crm', entityId: activeOpp.id })
    if (contractRows[0]) evidence.push({ label: `合同：${contractRows[0].name || '未命名'}（${contractRows[0].status}）`, kind: 'crm', entityId: contractRows[0].id })
    return {
      ok: true,
      data: { name: String(r.account.name || ''), opportunities: oppRows, contracts: contractRows },
      evidence,
      publicSummary: parts.join('')
    }
  }
}

/** opportunity.my_list：全局活跃商机列表（复用刀 5 runMyOpportunities 同款读口组合，沉默倒序） */
const opportunityMyList: HermesToolDef = {
  name: 'opportunity.my_list',
  publicLabel: '活跃商机盘点',
  description: '查看当前可见的全部活跃商机（客户/产品/阶段/金额/沉默天数，按沉默最久倒序），用于全局盘点与找快凉商机。',
  argsHint: '{"limit": "条数，默认 15，上限 30"}',
  run: async (args, ctx) => {
    const limit = Math.min(Math.max(Math.floor(numArg(args.limit) || 15), 1), 30)
    const all = crmDbService.opportunityList({ status: 'active' })
    const visible = filterByOwner(
      all as unknown as Array<Record<string, unknown> & { owner_sales?: string | null }>,
      ctx.identity
    )
    const now = Date.now()
    const rows = visible
      .map((o) => {
        const last = Number(o.last_signal_at || 0)
        const silent = last > 0 ? Math.max(0, Math.floor((now - (last > 1e11 ? last : last * 1000)) / 86400000)) : null
        return {
          id: Number(o.id),
          customer: String(o.account_name || o.name || ''),
          product: String(o.product || ''),
          stage: String(o.stage || ''),
          amount: Number(o.amount || 0),
          silentDays: silent
        }
      })
      .sort((a, b) => (b.silentDays ?? -1) - (a.silentDays ?? -1))
      .slice(0, limit)
    if (rows.length === 0) {
      return { ok: true, data: { opportunities: [], total: 0 }, publicSummary: '当前没有可见的活跃商机。' }
    }
    const coldest = rows[0]
    return {
      ok: true,
      data: { opportunities: rows, total: rows.length },
      evidence: rows.slice(0, 5).map((o) => ({
        label: `商机：${o.product || o.customer}（${o.stage}${o.silentDays != null ? `，沉默 ${o.silentDays} 天` : ''}）`,
        kind: 'crm' as const,
        entityId: o.id
      })),
      publicSummary: `可见活跃商机 ${rows.length} 条。最快凉：${coldest.customer}（${coldest.stage}${coldest.silentDays != null ? `，已沉默 ${coldest.silentDays} 天` : ''}）。`
    }
  }
}

/** payment.month_paid：本月已确认到款汇总（复用刀 5 monthPaidByOwner 读口，owner 过滤由本工具统一执行） */
const paymentMonthPaid: HermesToolDef = {
  name: 'payment.month_paid',
  publicLabel: '本月到款汇总',
  description: '查看本月已确认到款汇总（金额与笔数；管理视角含分组明细）。',
  argsHint: '{}',
  run: async (_args, ctx) => {
    const groups = filterByOwner(
      crmDbService.monthPaidByOwner() as unknown as Array<Record<string, unknown> & { owner_sales?: string | null }>,
      ctx.identity
    )
    const totalAmount = groups.reduce((s, g) => s + Number(g.amount || 0), 0)
    const totalCount = groups.reduce((s, g) => s + Number(g.count || 0), 0)
    if (totalCount === 0) {
      return { ok: true, data: { amount: 0, count: 0, groups: [] }, publicSummary: '本月还没有已确认的到款记录。' }
    }
    const detail = groups
      .map((g) => `${String(g.owner_sales || '').trim() || '公共未归属'} ¥${fmtAmount(Number(g.amount || 0))}（${Number(g.count || 0)} 笔）`)
      .join('，')
    return {
      ok: true,
      data: {
        amount: totalAmount,
        count: totalCount,
        groups: groups.map((g) => ({ owner: String(g.owner_sales || '').trim(), amount: Number(g.amount || 0), count: Number(g.count || 0) }))
      },
      evidence: [{ label: `本月已确认到款 ¥${fmtAmount(totalAmount)}（${totalCount} 笔）`, kind: 'crm' }],
      publicSummary: `本月已确认到款 ¥${fmtAmount(totalAmount)}，共 ${totalCount} 笔${groups.length > 1 ? `。分组：${detail}` : '。'}`
    }
  }
}

/** action.pending：待办行动卡（复用刀 5 todoList 读口 + owner 过滤，同 runTodayActions 口径） */
const actionPending: HermesToolDef = {
  name: 'action.pending',
  publicLabel: '待办行动卡查询',
  description: '查看当前待办的行动卡（标题/客户/到期时间/优先级）。',
  argsHint: '{"limit": "条数，默认 10，上限 20"}',
  run: async (args, ctx) => {
    const limit = Math.min(Math.max(Math.floor(numArg(args.limit) || 10), 1), 20)
    // 先全量候选 → 归属过滤 → 再 slice（todoList 不传 limit 取全量；本机行动卡量级有限）
    const rows = filterByOwner(
      salesDbService.todoList({ status: 'pending' }) as unknown as Array<Record<string, unknown> & { owner_sales?: string | null }>,
      ctx.identity
    ).slice(0, limit)
    const tasks = rows.map((t) => ({
      id: Number(t.id || 0),
      title: String(t.title || ''),
      customer: String(t.display_name || ''),
      dueAt: Number(t.due_at || 0),
      priority: Number(t.priority_score || 0)
    }))
    return {
      ok: true,
      data: { tasks, total: tasks.length },
      evidence: tasks.slice(0, 5).map((t) => ({
        label: `行动卡：${t.title}`,
        kind: 'action' as const,
        entityId: t.id || undefined
      })),
      publicSummary: tasks.length > 0
        ? `有 ${tasks.length} 条待办行动卡，最靠前：「${tasks[0].title}」。`
        : '当前没有待办的行动卡。'
    }
  }
}

/** knowledge.search：知识库检索（复用刀 3 extractKeywords + kbSearchPublished，SQL 级只查 published） */
const knowledgeSearch: HermesToolDef = {
  name: 'knowledge.search',
  publicLabel: '知识库检索',
  description: '在知识库（已发布条目）里按问题检索，返回条目标题/类目/摘句与条目 id。',
  argsHint: '{"query": "要检索的问题或关键词（必填）"}',
  run: async (args) => {
    const query = strArg(args.query)
    if (!query) return { ok: false, publicSummary: '请提供要检索的问题。', errorCode: 'bad_arguments' }
    const entries = salesDbService.kbSearchPublished(extractKeywords(query), 5)
    if (entries.length === 0) {
      return { ok: true, data: { entries: [], total: 0 }, publicSummary: '知识库里没有检索到相关内容。' }
    }
    return {
      ok: true,
      data: {
        entries: entries.map((e) => ({
          id: Number(e.id),
          title: String(e.title || ''),
          category: String(e.category || ''),
          version: Number(e.version || 1),
          excerpt: maskPrivateText(String(e.content || '')).slice(0, 150)
        })),
        total: entries.length
      },
      evidence: entries.map((e) => ({
        label: `知识库：《${String(e.title || '')}》（v${Number(e.version || 1)}）`,
        kind: 'knowledge' as const,
        entityId: Number(e.id)
      })),
      publicSummary: `在知识库找到 ${entries.length} 条相关内容，如《${String(entries[0].title || '')}》。`
    }
  }
}

/**
 * 白名单（唯一事实源）：注册顺序即给模型看的能力清单顺序。
 * 新工具必须先过 Feature Gate 七问入宪再进清单；执行器与本表一一对应（switch 拒绝清单外调用）。
 */
export const HERMES_TOOLS: readonly HermesToolDef[] = [
  customerSearch,
  customerBySession,
  customerCurrentViewTool,
  chatRecent,
  crmCustomerBusiness,
  opportunityMyList,
  paymentMonthPaid,
  actionPending,
  knowledgeSearch
]

/** 白名单外的工具名一律拒绝（hermesAgent 调用前校验 + 动态测试断言） */
export function findHermesTool(name: string): HermesToolDef | undefined {
  return HERMES_TOOLS.find((t) => t.name === name)
}