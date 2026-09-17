/**
 * hermesAskDataService.ts —— 刀 5 问数据（设计-Hermes-MVP 刀 5，业务库联动）
 *
 * 与刀 3 共用「问一问」输入框：`sales:kb:ask` 先做意图分类（classifyAskIntent，规则关键词起步），
 * 数据类 → 本服务固定查询模板；知识类 → 原刀 3 知识检索链路（hermesAskService）。
 *
 * 铁律（hermes-ask-data-test 静态断言锚点，改本文件先跑测试）：
 *  - 回答里的每个数字必须来自查询结果行：文案模板只做行插值；LLM 只做转述
 *    （system prompt 禁止新增/修改/推算数字），prompt 里只传查询结果，绝不传原始聊天
 *  - 模板清单 = Tool 白名单注册表常量（HERMES_DATA_TEMPLATES），一处定义两处消费
 *    （本文件执行器 + hermes-ask-data-test 断言）；清单外模板不存在 = 调不到
 *  - 销售身份所有模板查询先过 filterByOwner（shared/ownerFilter 唯一语义源；§2.74 页面过滤档），
 *    查不到别人名下的数据
 *  - 查不到/不覆盖 → 诚实说「这个问题我还不会查」（不伪造数字），并给提案入口
 */
import { salesDbService, type FollowUpTask } from './salesDbService'
import { crmDbService } from './crmDbService'
import { morningDigestService } from './morningDigestService'
import { callChatCompletion, getAiModelConfig, isAiConfigured } from './ai/aiApiClient'
import type { ConfigService } from './config'
import { getOwnerIdentity } from './identityService'
import { filterByOwner, isSalesView, type IdentityLike } from '../../shared/ownerFilter'
import { trackProposalEvent, trackDataAskViewed } from './proposalEventTracking'
import { askKeyOf } from './hermesAskService'
import { salesLog } from './salesLogger'

const DAY_MS = 86400_000
/** LLM 转述温度（与刀 3 同档） */
export const ASK_DATA_TEMPERATURE = 0.2

// ─── Tool 白名单注册表（设计稿 §3 形式化：一处定义两处消费——执行器 + 测试断言）────────
// 本批 Hermes 可调用的数据查询工具恰四个；新增模板必须先过 Feature Gate 七问入宪再进清单。

export const HERMES_DATA_TEMPLATES = [
  {
    id: 'today_actions',
    label: '今天要办什么',
    keywords: ['今天', '今日', '要办', '待办', '先跟谁', '晨间', '摘要'],
    description: '今日行动卡（follow_up_task pending）+ 晨间摘要读口'
  },
  {
    id: 'my_opportunities',
    label: '我的商机',
    keywords: ['商机', '快凉', '单子', '沉默', '意向客户'],
    description: 'opportunity 按阶段 + 沉默天数排序（filterByOwner 后）'
  },
  {
    id: 'customer_stage',
    label: '客户到哪步',
    keywords: ['到哪步', '到哪了', '哪一步', '进展'],
    description: '某客户：商机阶段 + 最新合同 + 最近信号（客户名从问句提取）'
  },
  {
    id: 'month_received',
    label: '本月到款',
    keywords: ['到款', '回款', '收款', '打款'],
    description: '本月已确认到款（statsOverview monthPaid 同口径，按 owner 分组过 filterByOwner）'
  }
] as const

export type HermesDataTemplateId = (typeof HERMES_DATA_TEMPLATES)[number]['id']

/**
 * 泛化数据信号（没有命中具体模板时 → 数据类但不覆盖 → 诚实「还不会查」）。
 * ⚠️ 有意不含「多少/谁」：与产品问题（「这车续航多少」「李林辉是谁」）碰撞率过高，
 * 按设计稿「拿不准按知识类（答错知识比查错数据代价小）」让位给知识类。
 */
const GENERIC_DATA_KEYWORDS = ['我的', '哪几个', '到哪了', '本月', '这个月']

export type AskIntent = { kind: 'data'; templateId: HermesDataTemplateId | null } | { kind: 'knowledge'; templateId: null }

/** 意图分类（纯函数，规则关键词起步；LLM 兜底是后续刀，本批规则即最终口径） */
export function classifyAskIntent(question: string): AskIntent {
  const q = String(question || '').trim()
  if (!q) return { kind: 'knowledge', templateId: null }
  for (const t of HERMES_DATA_TEMPLATES) {
    if (t.keywords.some((k) => q.includes(k))) return { kind: 'data', templateId: t.id }
  }
  if (GENERIC_DATA_KEYWORDS.some((k) => q.includes(k))) return { kind: 'data', templateId: null }
  // 拿不准按知识类（答错知识比查错数据代价小）
  return { kind: 'knowledge', templateId: null }
}

/** 「某客户到哪步」客户名提取（纯函数）：剥模板关键词/客套词/标点，剩余即名字候选 */
export function extractCustomerName(question: string): string {
  let s = String(question || '')
  const strips = [
    ...HERMES_DATA_TEMPLATES.flatMap((t) => [...t.keywords]),
    ...GENERIC_DATA_KEYWORDS,
    '请问', '帮我看看', '看看', '现在', '怎么样', '如何', '什么情况', '情况', '谈得', '聊得', '目前'
  ]
  for (const kw of strips) s = s.split(kw).join(' ')
  s = s.replace(/[?？!！。，,、\s]+/g, ' ').trim()
  s = s.replace(/[了吗呢呀]+$/g, '').trim()
  return s
}

// ─── 查询结果行与文案模板 ─────────────────────────────────────────────────────

export interface HermesAskDataResult {
  kind: 'data'
  status: 'answer' | 'unsupported'
  question: string
  askKey: string
  templateId: HermesDataTemplateId | null
  templateLabel?: string
  /** 人话答案（LLM 转述 or 文案模板，数字全部来自 rows） */
  text: string
  /** 结构化查询结果行（前端可展示；LLM prompt 只传这个） */
  rows: Record<string, unknown>
  via: 'llm' | 'template'
  reason?: string
}

/** 单模板执行结果：查询行 + 确定性文案（数字全部来自行） */
interface TemplateOutput {
  rows: Record<string, unknown>
  text: string
}

function fmtAmount(n: number): string {
  return Number(n ?? 0).toLocaleString('zh-CN', { maximumFractionDigits: 0 })
}

function silentDays(lastSignalAt: number, now: number): number | null {
  const t = Number(normalizeSignalMs(lastSignalAt))
  if (!t || t <= 0) return null
  return Math.max(0, Math.floor((now - t) / DAY_MS))
}
/** 容错包装（ WCDB 毫秒/秒混杂防护；opportunity.last_signal_at 统一毫秒） */
function normalizeSignalMs(v: unknown): number {
  const n = Number(v || 0)
  if (!n) return 0
  return n > 1e11 ? n : n * 1000 // 秒 → 毫秒
}

// ─── 四个模板执行器（每个 = 参数化只读 SQL/既有读口 + 文案模板；全部先过 filterByOwner）───

function runTodayActions(identity: IdentityLike, now: number): TemplateOutput {
  // 读口复用：今日行动卡 = follow_up_task pending（getTodayActions 的数据源表，不触发扫描）
  const tasksAll = salesDbService.todoList({ status: 'pending', limit: 100 })
  const tasks = filterByOwner(tasksAll as Array<FollowUpTask & { owner_sales?: string | null }>, identity)
  const dueToday = tasks.filter((t) => t.due_at && Number(t.due_at) < now + DAY_MS)
  const top = [...tasks]
    .sort((a, b) => (Number(a.due_at) || Infinity) - (Number(b.due_at) || Infinity) || (Number(b.priority_score) || 0) - (Number(a.priority_score) || 0))
    .slice(0, 5)
    .map((t) => ({ title: t.title, customer: t.display_name || '', dueAt: Number(t.due_at) || 0, priority: Number(t.priority_score) || 0 }))
  const digest = morningDigestService.getLatestDigest()
  const rows = {
    pendingCount: tasks.length,
    dueTodayCount: dueToday.length,
    top,
    morningDigest: digest ? { date: digest.date, itemCount: digest.items?.length ?? 0, text: String(digest.text || '').slice(0, 300) } : null
  }
  let text = tasks.length > 0
    ? `今天有 ${tasks.length} 条待办行动卡${dueToday.length ? `（其中 ${dueToday.length} 条今天到期）` : ''}。最靠前的：${top.slice(0, 3).map((t) => `「${t.title}」`).join('、')}。`
    : '今天没有待办的行动卡。'
  if (digest) text += ` 晨间摘要（${digest.date}）：${String(digest.text || '').slice(0, 120)}`
  return { rows, text }
}

function runMyOpportunities(identity: IdentityLike, now: number): TemplateOutput {
  const all = crmDbService.opportunityList({ status: 'active' })
  const visible = filterByOwner(all as Array<Record<string, unknown> & { owner_sales?: string | null }>, identity)
  const rowsList = visible
    .map((o) => ({
      customer: String(o.account_name || o.name || ''),
      product: String(o.product || ''),
      stage: String(o.stage || 'initial'),
      amount: Number(o.amount || 0),
      silentDays: silentDays(Number(o.last_signal_at || 0), now),
      lastSignalAt: Number(o.last_signal_at || 0)
    }))
    .sort((a, b) => (b.silentDays ?? -1) - (a.silentDays ?? -1))
  const stageDist: Record<string, number> = {}
  for (const r of rowsList) stageDist[r.stage] = (stageDist[r.stage] || 0) + 1
  const rows = { totalCount: rowsList.length, stageDist, top: rowsList.slice(0, 10) }
  const distText = Object.entries(stageDist).map(([s, c]) => `${s} ${c}`).join(' · ')
  let text = rowsList.length > 0
    ? `你名下可见 ${rowsList.length} 条活跃商机${distText ? `（${distText}）` : ''}。`
    : '目前没有可见的活跃商机。'
  const coldest = rowsList.filter((r) => (r.silentDays ?? 0) >= 7).slice(0, 3)
  if (coldest.length > 0) {
    text += ` 最快凉的：${coldest.map((r) => `${r.customer}（${r.stage}，已沉默 ${r.silentDays} 天）`).join('、')}。`
  }
  return { rows, text }
}

function runCustomerStage(identity: IdentityLike, now: number, question: string): TemplateOutput {
  const name = extractCustomerName(question)
  if (!name) {
    return { rows: { name: '' }, text: '请告诉我客户名字再问，例如「李林辉到哪步了」。「这个问题我还不会查」之外的查询我可以做：今天要办什么 / 我的商机 / 本月到款。' }
  }
  const accounts = filterByOwner(crmDbService.accountSearchByName(name), identity)
  if (accounts.length === 0) {
    // 诚实：销售视角下查不到 = 不存在或不在你名下（不泄露他人客户是否存在）
    return { rows: { name, found: false }, text: `没有找到「${name}」的客户档案（可能不在你的客户范围内）。` }
  }
  const acc = accounts[0]
  const opps = crmDbService.opportunityList({ accountId: Number(acc.id) })
  const activeOpp = opps.find((o) => String(o.status || '') === 'active') || opps[0]
  const contracts = crmDbService.contractsByAccount(Number(acc.id))
  const latestContract = contracts[0]
  const lastSignal = activeOpp ? silentDays(activeOpp.last_signal_at, now) : null
  const rows = {
    name: String(acc.name || name),
    found: true,
    opportunity: activeOpp ? { stage: String(activeOpp.stage || ''), amount: Number(activeOpp.amount || 0), product: String(activeOpp.product || ''), silentDays: lastSignal } : null,
    latestContract: latestContract ? { name: String(latestContract.name || ''), status: String(latestContract.status || ''), amount: Number(latestContract.amount || 0) } : null,
    opportunityCount: opps.length,
    contractCount: contracts.length
  }
  let text = `「${rows.name}」：`
  text += rows.opportunity
    ? `商机在「${rows.opportunity.stage}」阶段${rows.opportunity.amount > 0 ? `（金额 ¥${fmtAmount(rows.opportunity.amount)}）` : ''}${rows.opportunity.silentDays != null ? `，最近信号 ${rows.opportunity.silentDays === 0 ? '就在今天' : `${rows.opportunity.silentDays} 天前`}` : ''}。`
    : '名下没有商机记录。'
  text += rows.latestContract
    ? ` 最新合同「${rows.latestContract.name || '未命名'}」状态 ${rows.latestContract.status}${rows.latestContract.amount > 0 ? `（¥${fmtAmount(rows.latestContract.amount)}）` : ''}。`
    : ' 名下暂无合同。'
  return { rows, text }
}

function runMonthReceived(identity: IdentityLike): TemplateOutput {
  // 与 statsOverview.monthPaid 同口径；按 owner 分组后过 filterByOwner（销售=本人+空归属，管理=全部）
  const grouped = crmDbService.monthPaidByOwner()
  const visible = filterByOwner(grouped, identity)
  const total = visible.reduce((s, r) => s + r.amount, 0)
  const count = visible.reduce((s, r) => s + r.count, 0)
  const now = new Date()
  const rows = { month: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`, total, count, byOwner: grouped }
  const salesView = isSalesView(identity)
  const text = salesView
    ? `本月你名下（含未归属公共）已确认到款 ¥${fmtAmount(total)}，共 ${count} 笔。口径与合同页一致（已认领 + 按到款日归类）。`
    : `本月全店已确认到款 ¥${fmtAmount(total)}，共 ${count} 笔。口径与合同页一致（已认领 + 按到款日归类）。`
  return { rows, text }
}

// ─── LLM 转述（只转述查询结果；prompt 不传原始聊天）────────────────────────────

/** 单一固定 system prompt：数据播报员，数字只能来自查询结果（铁律锚点） */
export const ASK_DATA_SYSTEM_PROMPT =
  '你是销售助手的数据播报员。把【查询结果】转成一句自然的中文回答；' +
  '回答里出现的每一个数字都必须原样来自【查询结果】，绝不新增、修改、推算或估算任何数字；' +
  '查询结果为空就照实说没有数据。不超过 150 字。'

/** user prompt 只含问题 + 查询结果 JSON（静态断言：不传原始聊天） */
export function buildAskDataUserPrompt(question: string, rows: Record<string, unknown>): string {
  return `【问题】${question}\n【查询结果】${JSON.stringify(rows)}\n只转述【查询结果】回答【问题】。`
}

function defaultCompletion(config?: ConfigService): (system: string, user: string) => Promise<string> {
  return (system, user) => {
    const mc = getAiModelConfig(config as ConfigService)
    return callChatCompletion(mc, [{ role: 'system', content: system }, { role: 'user', content: user }], { temperature: ASK_DATA_TEMPERATURE, usageContext: { purpose: 'hermes' } })
  }
}

// ─── 主链路 ─────────────────────────────────────────────────────────────────

export async function askData(
  input: { question: string },
  opts?: {
    config?: ConfigService
    /** 测试注入：覆盖 isAiConfigured（缺省按 config 判定） */
    configured?: boolean
    /** 测试注入：替换 callChatCompletion */
    completion?: (system: string, user: string) => Promise<string>
    /** 测试注入：身份档案（缺省 getOwnerIdentity()，含归属别名） */
    identity?: IdentityLike
    /** 测试注入：当前时间（沉默天数/月起点口径） */
    now?: number
  }
): Promise<HermesAskDataResult> {
  const question = String(input?.question || '').trim()
  const askKey = askKeyOf(question)
  const base: HermesAskDataResult = { kind: 'data', status: 'unsupported', question, askKey, templateId: null, rows: {}, text: '', via: 'template' }
  const intent = classifyAskIntent(question)
  if (intent.kind !== 'data' || !intent.templateId) {
    // 数据类但模板不覆盖 → 诚实「还不会查」（不伪造数字；不记 generated）
    return { ...base, text: '这个问题我还不会查，知识库里也没有。你可以在知识库登记一条知识提案，或联系管理员扩充查询能力。' }
  }
  const template = HERMES_DATA_TEMPLATES.find((t) => t.id === intent.templateId)!
  const identity: IdentityLike = opts?.identity ?? getOwnerIdentity() ?? { name: '', role: '' }
  const now = opts?.now ?? Date.now()

  let out: TemplateOutput
  try {
    switch (template.id) {
      case 'today_actions': out = runTodayActions(identity, now); break
      case 'my_opportunities': out = runMyOpportunities(identity, now); break
      case 'customer_stage': out = runCustomerStage(identity, now, question); break
      case 'month_received': out = runMonthReceived(identity); break
      default: return { ...base, text: '这个问题我还不会查。' } // 白名单外不可达（执行器与清单一一对应）
    }
  } catch (e) {
    salesLog('WARN', `[HermesAskData] ${template.id} 查询失败: ${(e as Error).message}`)
    return { ...base, templateId: template.id, templateLabel: template.label, text: '查询业务数据时出了点问题，请稍后再试。' }
  }

  // LLM 转述（可选）：只转述查询结果；失败/未配置回退文案模板（数字同源，链路不断）
  let text = out.text
  let via: 'llm' | 'template' = 'template'
  const configured = opts?.configured ?? (opts?.config ? isAiConfigured(opts.config) : false)
  if (configured) {
    try {
      const run = opts?.completion ?? defaultCompletion(opts?.config)
      const said = String(await run(ASK_DATA_SYSTEM_PROMPT, buildAskDataUserPrompt(question, out.rows)) || '').trim()
      if (said) { text = said; via = 'llm' }
    } catch (e) {
      salesLog('WARN', `[HermesAskData] 转述失败（回退文案模板）: ${(e as Error).message}`)
    }
  }

  // 埋点：出答案 → knowledge/generated（entity=data_ask，宪法 §3 登记行⑦）
  trackProposalEvent({ event_type: 'knowledge', stage: 'generated', entity_type: 'data_ask', entity_id: askKey, actor: 'system:hermes-ask-data' })
  return { kind: 'data', status: 'answer', question, askKey, templateId: template.id, templateLabel: template.label, text, rows: out.rows, via }
}

/**
 * 问数据 viewed 埋点（用户展开答案卡；同 askKey 只记一次，entity=data_ask）。
 */
export function markDataAskViewed(input: { question?: string; askKey?: string }): { ok: boolean } {
  const key = String(input?.askKey || '').trim() || askKeyOf(String(input?.question || ''))
  if (key === 'ask00000000') return { ok: false }
  trackDataAskViewedSafe(key)
  return { ok: true }
}

function trackDataAskViewedSafe(key: string): void {
  trackDataAskViewed(key) // 内部已吞错（埋点尽力而为）
}
