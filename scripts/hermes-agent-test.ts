/**
 * hermes-agent-test.ts —— Hermes 只读智能体第一刀测试（设计-Hermes-MVP 智能体刀 6）
 * 覆盖：
 *  a. Agent Loop 动态（fake AI adapter + fake tool registry 注入）：真实多步骤循环 / 严格 JSON 协议 /
 *     非法输出纠正重试至多 1 次 / 白名单外拒绝 / 零工具查询拒绝 complete（结论必须来自真实查询）/
 *     findings 逐条绑证据 / 伪造编号丢弃 / 步数与重复限制 / 取消丢弃在途（含工具执行期间取消）/
 *     多轮继续 / 任务不落盘不丢失 / prompt 零 sessionId（a22）/ 失败工具零证据（a23/a24）/
 *     每轮 continue 重置 dataRetries（a25）/ 空结果兜底证据人话标签（a18）
 *  a2. 信任边界：accountBrief/prompt 零会话标识（b20/a22）/ by_session 只认宿主 chat 上下文
 *     （b12/b12a/b12b/b12c/c10）/ 结构化标识脱敏（b21）
 *  b. 可见性过滤动态（真实 HERMES_TOOLS + /tmp 副本库；展示层过滤非安全边界）：销售只查本人+公共未归属 /
 *     不可见客户不泄露存在性 / 知识检索只回 published / 白名单无写工具 / 先过滤后 slice 不漏本人数据
 *  c. 上下文动态：customer/chat/global 三态上下文进 toolContext；hermesStore 三入口语义（打开全局=global、
 *     任务按上下文独立记忆，切换入口不串显）
 *  d. UI 静态护栏：HermesPanel 零发送类 IPC / 五态文案人话 / scss 零硬编码 hex / preload+d.ts 接线 /
 *     旧面板摘除 / 主进程零写路径 / 可见性措辞诚实
 *  e. 旧库迁移：在 knowledge-governance-test g 节覆盖（本文件不重复）。
 * 运行：npx tsx scripts/hermes-agent-test.ts
 */
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

let pass = 0, fail = 0
function ok(name: string, cond: boolean): void {
  if (cond) { pass++ } else { fail++; console.error('FAIL:', name) }
}

const isoDir = mkdtempSync(join(tmpdir(), 'hermes-agent-'))
process.env.WEFLOW_USER_DATA_PATH = isoDir
process.env.WEFLOW_CONFIG_CWD = isoDir

import { salesDbService } from '../electron/services/salesDbService'
import { crmDbService } from '../electron/services/crmDbService'
import {
  hermesAgentService,
  type HermesTask,
  type HermesCompletion,
  type HermesAgentDeps
} from '../electron/services/hermesAgent'
import { HERMES_TOOLS, maskStructuredId, type HermesToolDef, type HermesToolContext } from '../electron/services/hermesToolRegistry'
import { useHermesStore, canSettleTaskView, contextKeyOf } from '../src/stores/hermesStore'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ME: Identity = { name: '杨青', role: '销售' }
const BOSS: Identity = { name: '', role: '' }

interface Identity { name: string; role: string }

/** 等任务收尾（completed/failed/cancelled）；超时返回当前快照 */
async function waitTask(taskId: string, timeoutMs = 4000): Promise<HermesTask | null> {
  const start = Date.now()
  for (;;) {
    const t = hermesAgentService.getTask(taskId)
    if (t && (t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled')) return t
    if (Date.now() - start > timeoutMs) return t
    await new Promise((r) => setTimeout(r, 10))
  }
}

/** fake AI：按脚本逐轮返回（脚本项 = 字符串或 (轮次) => 字符串）；
 *  captured() 汇总历轮发往模型的全部消息内容（出站脱敏断言用） */
function scriptCompletion(script: Array<string>, opts?: { firstDelayMs?: number }): { deps: HermesAgentDeps; count: () => number; captured: () => string } {
  let i = 0
  let seen = ''
  const completion: HermesCompletion = async (messages, _timeoutMs, _signal) => {
    seen += messages.map((m) => m.content).join('\n') + '\n'
    const idx = i++
    if (idx === 0 && opts?.firstDelayMs) await new Promise((r) => setTimeout(r, opts.firstDelayMs!))
    return script[Math.min(idx, script.length - 1)]
  }
  return { deps: { configured: () => true, completion }, count: () => i, captured: () => seen }
}

/** fake 工具（记录调用；可带证据返回；ok=false 模拟执行失败） */
interface FakeToolSpec { name: string; ok?: boolean; publicLabel?: string; evidence?: Array<{ label: string; kind: 'customer' | 'crm' | 'chat' | 'knowledge' | 'action'; entityId?: number }>; summary?: string }
function makeFakeTools(specs: FakeToolSpec[]): { tools: HermesToolDef[]; calls: Array<{ tool: string; args: Record<string, unknown>; ctx: HermesToolContext }> } {
  const calls: Array<{ tool: string; args: Record<string, unknown>; ctx: HermesToolContext }> = []
  const tools = specs.map((s): HermesToolDef => ({
    name: s.name,
    publicLabel: s.publicLabel || '测试查询',
    description: 'fake',
    argsHint: '{}',
    run: async (args, ctx) => {
      calls.push({ tool: s.name, args, ctx })
      if (s.ok === false) return { ok: false, publicSummary: s.summary || '查询失败', errorCode: 'internal' }
      return { ok: true, data: { fake: true }, evidence: s.evidence, publicSummary: s.summary || `${s.name} 完成` }
    }
  }))
  return { tools, calls }
}

const TOOL_CALL = (tool: string, args: Record<string, unknown> = {}, reason = '查一下'): string =>
  JSON.stringify({ type: 'tool_call', tool, arguments: args, reason })
/** 协议 v2：findings 逐条对象 {text, evidenceRefs}（字符串数组旧格式 = 非法协议）。
 *  refs 缺省 ['e1']：先 TOOL_CALL 的用例必有 e1（有行证据用行证据，空结果用 result 级兜底证据） */
const COMPLETE = (summary: string, refs: string[] = ['e1']): string =>
  JSON.stringify({ type: 'complete', summary, findings: [{ text: '发现一', evidenceRefs: refs }], nextSteps: ['建议一'], evidenceRefs: refs })

async function main(): Promise<void> {
  await salesDbService.initialize(mkdtempSync(join(tmpdir(), 'hermes-agent-sales-')))
  await crmDbService.initialize(mkdtempSync(join(tmpdir(), 'hermes-agent-crm-')))

  // ─── a. Agent Loop 动态（fake AI + fake tools）────────────────────────────

  // a1 真实多步骤循环：tool_call → 结果回喂 → complete；步骤与证据来自真实执行
  {
    const ft = makeFakeTools([{ name: 'customer.search', evidence: [{ label: '客户档案：李林辉', kind: 'customer', entityId: 1 }] }])
    const sc = scriptCompletion([TOOL_CALL('customer.search', { query: '李林辉' }), COMPLETE('李林辉值得跟进', ['e1'])])
    const start = await hermesAgentService.startTask({ goal: '分析李林辉' }, { ...sc.deps, tools: ft.tools })
    const t = await waitTask(start.task!.taskId)
    ok('a1 多步骤循环：工具真实执行+步骤落账+完成结论',
      t?.status === 'completed' && t.steps.length === 1 && t.steps[0].tool === 'customer.search' &&
      t.steps[0].status === 'done' && t.result?.summary === '李林辉值得跟进' &&
      ft.calls.length === 1 && ft.calls[0].args.query === '李林辉')
    ok('a2 证据登记：complete 引用 e1 → evidence 恰 1 条（ref=e1，来自工具返回非模型编造）',
      t?.evidence.length === 1 && t.evidence[0].ref === 'e1' && t.evidence[0].label === '客户档案：李林辉')
  }

  // a3 严格 JSON 容忍围栏（内容仍必须严格匹配协议字段）
  {
    const ft = makeFakeTools([{ name: 'customer.search' }])
    const sc = scriptCompletion([TOOL_CALL('customer.search'), '```json\n' + COMPLETE('围栏结论') + '\n```'])
    const start = await hermesAgentService.startTask({ goal: 'g' }, { ...sc.deps, tools: ft.tools })
    const t = await waitTask(start.task!.taskId)
    ok('a3 JSON 围栏内合法协议可解析（complete 成功）', t?.status === 'completed' && t.result?.summary === '围栏结论')
  }

  // a4 非法输出纠正重试至多 1 次
  {
    const ft = makeFakeTools([{ name: 'customer.search' }])
    const sc = scriptCompletion(['这是自然语言不是 JSON', TOOL_CALL('customer.search'), COMPLETE('重试后完成')])
    const start = await hermesAgentService.startTask({ goal: 'g' }, { ...sc.deps, tools: ft.tools })
    const t = await waitTask(start.task!.taskId)
    ok('a4 非法 JSON 重试 1 次后恢复（completion 共 3 轮、任务完成）',
      t?.status === 'completed' && sc.count() === 3)
  }

  // a5 非法输出连续 2 次 → failed（人话文案，不含协议词/技术细节）
  {
    const ft = makeFakeTools([{ name: 'customer.search' }])
    const sc = scriptCompletion(['乱说一通', '还是不对', COMPLETE('不应到达')])
    const start = await hermesAgentService.startTask({ goal: 'g' }, { ...sc.deps, tools: ft.tools })
    const t = await waitTask(start.task!.taskId)
    ok('a5 连续非法输出 → failed ai_invalid_output + 人话文案（不出现 JSON/协议/堆栈）',
      t?.status === 'failed' && t.errorCode === 'ai_invalid_output' &&
      t.errorMessage!.includes('暂时无法查询') && !/JSON|protocol|stack/i.test(t.errorMessage!))
  }

  // a6 白名单外工具拒绝：不执行、回喂错误；模型改道用白名单工具后才可完成
  {
    const ft = makeFakeTools([{ name: 'customer.search' }])
    const sc = scriptCompletion([
      TOOL_CALL('db.execute', { sql: 'SELECT 1' }),
      TOOL_CALL('customer.search', { query: '改道查询' }),
      COMPLETE('改道完成')
    ])
    const start = await hermesAgentService.startTask({ goal: 'g' }, { ...sc.deps, tools: ft.tools })
    const t = await waitTask(start.task!.taskId)
    ok('a6 白名单外工具被拒（零执行、步骤 error、标签用通用「执行查询」不透出模型伪造工具名），改道白名单工具后任务完成',
      t?.status === 'completed' && t.steps[0].status === 'error' && t.steps[0].tool === 'db.execute' &&
      t.steps[0].label === '执行查询' &&
      ft.calls.length === 1 && ft.calls[0].tool === 'customer.search')
  }

  // a7 零工具查询的 complete 一律拒绝（数据型结论必须来自真实工具执行）
  {
    const ft = makeFakeTools([{ name: 'customer.search' }])
    const sc = scriptCompletion([COMPLETE('没查数据就下结论')])
    const start = await hermesAgentService.startTask({ goal: 'g' }, { ...sc.deps, tools: ft.tools })
    const t = await waitTask(start.task!.taskId)
    ok('a7a 零工具 complete 被拒（纠偏 1 次仍坚持 → failed，绝不标记完成）',
      t?.status === 'failed' && t.errorCode === 'ai_invalid_output' && ft.calls.length === 0 && !t.result)
  }
  {
    const ft = makeFakeTools([{ name: 'customer.search' }])
    const sc = scriptCompletion([COMPLETE('抢答'), TOOL_CALL('customer.search', { query: '补查' }), COMPLETE('查完再答', ['e1'])])
    const start = await hermesAgentService.startTask({ goal: 'g' }, { ...sc.deps, tools: ft.tools })
    const t = await waitTask(start.task!.taskId)
    ok('a7b 零工具 complete 纠偏后模型先调工具 → 结论被接受（任务完成）',
      t?.status === 'completed' && ft.calls.length === 1 && t.result?.summary === '查完再答')
  }
  {
    const ft = makeFakeTools([{ name: 'customer.search', evidence: [{ label: '客户档案：李林辉', kind: 'customer', entityId: 1 }] }])
    const sc = scriptCompletion([TOOL_CALL('customer.search'), COMPLETE('编造证据', ['e99', 'e100'])])
    const start = await hermesAgentService.startTask({ goal: 'g' }, { ...sc.deps, tools: ft.tools })
    const t = await waitTask(start.task!.taskId)
    ok('a7c 结论全部引用伪造编号 → 拒绝完成（纠偏后仍无有效引用 → failed，绝不 completed）',
      t?.status === 'failed' && t.errorCode === 'ai_invalid_output' && !t.result)
  }

  // a18 「查询无结果」也是可引用证据：空结果兜底登记 result 级 ref，结论「查不到」可绑定；
  // 证据 label 用工具人话名称，绝不向用户泄露 customer.search 等内部工具 ID
  {
    const ft = makeFakeTools([{ name: 'customer.search', publicLabel: '客户搜索' }]) // ok 但零行证据 → 兜底 result 证据
    const sc = scriptCompletion([TOOL_CALL('customer.search', { query: '不存在的人' }), COMPLETE('没有找到该客户', ['e1'])])
    const start = await hermesAgentService.startTask({ goal: 'g' }, { ...sc.deps, tools: ft.tools })
    const t = await waitTask(start.task!.taskId)
    ok('a18 空结果兜底 ref 可引用（kind=result、label 人话标注「无匹配结果」且不含内部工具 ID）',
      t?.status === 'completed' && t.evidence.length === 1 && t.evidence[0].kind === 'result' &&
      t.evidence[0].label.includes('无匹配结果') && t.evidence[0].label.includes('客户搜索') &&
      !t.evidence[0].label.includes('customer.search') && t.result!.findings[0].evidenceRefs[0] === 'e1')
  }

  // a22 prompt 零会话标识：聊天入口的 user prompt 是语义描述，真实 sessionId 绝不进模型上下文
  {
    const SECRET = 'wxid_prompt_secret_99'
    const ft = makeFakeTools([{ name: 'customer.search', evidence: [{ label: '客户档案：李林辉', kind: 'customer', entityId: 1 }] }])
    let captured = ''
    const completion: HermesCompletion = async (messages) => {
      captured = messages.map((m) => m.content).join('\n')
      return captured.includes('tool_result') ? COMPLETE('聊天入口结论') : TOOL_CALL('customer.search', { query: 'x' })
    }
    const start = await hermesAgentService.startTask(
      { goal: '这个会话的客户聊到哪一步了', context: { kind: 'chat', sessionId: SECRET } },
      { configured: () => true, completion, tools: ft.tools })
    const t = await waitTask(start.task!.taskId)
    ok('a22 prompt 不含真实 sessionId（聊天提示改语义描述「已绑定聊天上下文 / 无需提供会话 ID」）',
      t?.status === 'completed' && captured.includes('当前任务已绑定聊天上下文') &&
      captured.includes('无需提供会话 ID') && !captured.includes(SECRET))
  }

  // a23 失败工具零证据：执行失败只产生 error step，不登记任何可引用 evidence → 结论被拒
  {
    const ft = makeFakeTools([{ name: 'customer.search', ok: false, summary: '查询失败：数据源忙' }])
    const sc = scriptCompletion([TOOL_CALL('customer.search', { query: '失败查询' }), COMPLETE('查到了', ['e1'])])
    const start = await hermesAgentService.startTask({ goal: 'g' }, { ...sc.deps, tools: ft.tools })
    const t = await waitTask(start.task!.taskId)
    ok('a23 失败工具不登记证据（evidence 恒空、步骤 error、无据 complete 坚持 → failed）',
      t?.status === 'failed' && t.errorCode === 'ai_invalid_output' && t.evidence.length === 0 &&
      !t.result && t.steps[0].status === 'error' && ft.calls.length === 1)
  }

  // a24 失败查询零证据：引用「失败查询的编号」→ 无效被拒（坚持 → failed）；成功查询的 e1 不受影响
  {
    const ft = makeFakeTools([
      { name: 'customer.search', evidence: [{ label: '客户档案：李林辉', kind: 'customer', entityId: 1 }] },
      { name: 'chat.recent', ok: false, summary: '聊天记录读取失败' }
    ])
    const sc = scriptCompletion([TOOL_CALL('customer.search'), TOOL_CALL('chat.recent'), COMPLETE('失败查询的结论', ['e2'])])
    const start = await hermesAgentService.startTask({ goal: 'g' }, { ...sc.deps, tools: ft.tools })
    const t = await waitTask(start.task!.taskId)
    ok('a24 失败查询不产生可引用编号（引用 e2 被拒 → failed；e1 仍在、失败步骤 error）',
      t?.status === 'failed' && t.errorCode === 'ai_invalid_output' && t.steps[1].status === 'error' &&
      t.evidence.length === 1 && t.evidence[0].ref === 'e1')
  }

  // a25 每轮 continue 重置 dataRetries：第一轮烧掉的纠偏次数不带入追问轮
  {
    const ft = makeFakeTools([{ name: 'customer.search', evidence: [{ label: '客户档案：李林辉', kind: 'customer', entityId: 1 }] }])
    const sc = scriptCompletion([COMPLETE('第一轮抢答'), TOOL_CALL('customer.search'), COMPLETE('第一轮结论', ['e1'])])
    const start = await hermesAgentService.startTask({ goal: 'g' }, { ...sc.deps, tools: ft.tools })
    await waitTask(start.task!.taskId)
    const sc2 = scriptCompletion([COMPLETE('追问轮抢答', ['e99']), TOOL_CALL('customer.search', { query: '追问补查' }), COMPLETE('追问结论OK', ['e2'])])
    const cont = await hermesAgentService.continueTask(start.task!.taskId, '那下一步呢', { ...sc2.deps, tools: ft.tools })
    const t = await waitTask(cont.task!.taskId)
    ok('a25 continue 重置 dataRetries：追问轮无据抢答被纠偏（而非直接 failed）后正常完成',
      t?.status === 'completed' && t.result?.summary === '追问结论OK' && t.evidence.some((e) => e.ref === 'e2'))
  }

  // a26 失败查询闭锁：任何工具失败后 unresolvedToolFailure=true，后续成功查询才解除；
  // 闭锁未解除时借旧证据（e1）输出 complete 一律拒绝，补做一次成功查询后才可完成
  {
    const ft = makeFakeTools([
      { name: 'customer.search', evidence: [{ label: '客户档案：李林辉', kind: 'customer', entityId: 1 }] },
      { name: 'chat.recent', ok: false, summary: '聊天记录读取失败' }
    ])
    const sc = scriptCompletion([
      TOOL_CALL('customer.search'),
      TOOL_CALL('chat.recent'),
      COMPLETE('借旧证据下结论', ['e1']),
      TOOL_CALL('customer.search', { query: '重试补查' }),
      COMPLETE('补查后结论', ['e1', 'e2'])
    ])
    const start = await hermesAgentService.startTask({ goal: 'g' }, { ...sc.deps, tools: ft.tools })
    const t = await waitTask(start.task!.taskId)
    ok('a26 失败查询未澄清 → 借旧证据 complete 被拒（补一次成功查询解除闭锁后才完成）',
      t?.status === 'completed' && t.result?.summary === '补查后结论' && sc.count() === 5 && t.evidence.length === 2)
  }

  // a26b 闭锁语义两翼：第一轮闭锁未解除坚持 complete → failed（旧证据替不了失败的新查询）；
  // continueTask 开新一轮清零闭锁，追问轮引用既有证据（无新查询）重新允许（与 a13b 同口径）
  {
    const ft = makeFakeTools([
      { name: 'customer.search', evidence: [{ label: '客户档案：李林辉', kind: 'customer', entityId: 1 }] },
      { name: 'chat.recent', ok: false, summary: '聊天记录读取失败' }
    ])
    const sc = scriptCompletion([TOOL_CALL('customer.search'), TOOL_CALL('chat.recent'), COMPLETE('第一轮借旧证据', ['e1'])])
    const start = await hermesAgentService.startTask({ goal: 'g' }, { ...sc.deps, tools: ft.tools })
    const t1 = await waitTask(start.task!.taskId)
    ok('a26b-1 闭锁下坚持 complete → failed（失败查询零证据 + 旧证据不可替）',
      t1?.status === 'failed' && t1.errorCode === 'ai_invalid_output' && !t1.result)
    const sc2 = scriptCompletion([COMPLETE('追问轮引用既有证据', ['e1'])])
    const cont = await hermesAgentService.continueTask(start.task!.taskId, '那现在呢', { ...sc2.deps, tools: ft.tools })
    const t = await waitTask(cont.task!.taskId)
    ok('a26b-2 continueTask 清零失败闭锁：追问轮引用既有证据可完成',
      t?.status === 'completed' && t.result?.summary === '追问轮引用既有证据')
  }

  // a27 出站脱敏（goal）：目标文本里的当前 sessionId（自定义微信号形态）/wxid/手机号
  // 不出现在任何模型消息——sessionId 走精确替换，wxid/手机号走 maskPrivateText
  {
    const SID = 'wang9231217'
    const ft = makeFakeTools([{ name: 'customer.search', evidence: [{ label: '客户档案：李林辉', kind: 'customer', entityId: 1 }] }])
    const sc = scriptCompletion([TOOL_CALL('customer.search', { query: 'x' }), COMPLETE('会话目标结论', ['e1'])])
    const start = await hermesAgentService.startTask(
      { goal: `客户 wxid_secret_88 手机 13800138000 会话 ${SID} 想买叉车`, context: { kind: 'chat', sessionId: SID } },
      { ...sc.deps, tools: ft.tools })
    const t = await waitTask(start.task!.taskId)
    ok('a27 出站脱敏：goal 中的当前 sessionId/wxid/手机号零出现在模型消息（只改发往模型的副本）',
      t?.status === 'completed' && !sc.captured().includes(SID) &&
      !sc.captured().includes('wxid_secret_88') && !sc.captured().includes('13800138000'))
  }

  // a28 出站脱敏（工具结果端到端，真实白名单 + 脏客户名）：客户 name 是自定义微信号（存量脏数据）→
  // 模型消息里的 data 字段与证据 label 零原值；本机库原值与任务证据表保持原文（只脱发往模型的副本）
  {
    const dirty = 'zhang923121'
    const now2 = Date.now()
    crmDbService.create('account', { name: dirty, owner_sales: '杨青', session_id: 'wxid_dirty_row', created_at: now2, updated_at: now2 })
    const sc = scriptCompletion([TOOL_CALL('customer.search', { query: dirty }), COMPLETE('脏名客户结论', ['e1'])])
    const start = await hermesAgentService.startTask({ goal: '帮我看看这个客户' }, { ...sc.deps })
    const t = await waitTask(start.task!.taskId)
    const byId = hermesAgentService.getTask(start.task!.taskId)
    ok('a28 出站脱敏：客户名为自定义微信号 → 模型消息（data/证据 label）零原值；库原值与本地证据表不动',
      t?.status === 'completed' && !sc.captured().includes(dirty) && sc.captured().includes('***') &&
      (byId?.evidence ?? []).some((e) => e.label.includes(dirty)) &&
      crmDbService.accountSearchByName(dirty, 0).length === 1)
  }

  // a29 步骤标签固定人话：已知工具 label 固定 publicLabel（模型 reason 绝不上标签），
  // reason 显式含内部工具 ID 时，快照展示字段（label/summary/证据/结论/错误文案）零内部 ID（step.tool 内部字段保留）
  {
    const ft = makeFakeTools([{ name: 'customer.search', publicLabel: '客户搜索', summary: '查询完成' }])
    const sc = scriptCompletion([TOOL_CALL('customer.search', { query: 'x' }, 'customer.search 查一下'), COMPLETE('标签结论')])
    const start = await hermesAgentService.startTask({ goal: 'g' }, { ...sc.deps, tools: ft.tools })
    const t = await waitTask(start.task!.taskId)
    const visible = JSON.stringify({
      steps: t?.steps.map(({ tool, ...rest }) => rest),
      evidence: t?.evidence,
      result: t?.result,
      errorMessage: t?.errorMessage
    })
    ok('a29 步骤 label 固定 publicLabel：reason 含内部工具 ID 也不出现在用户可见快照（内部字段 step.tool 保留）',
      t?.status === 'completed' && t.steps[0].label === '调用客户搜索' && !visible.includes('customer.search'))
  }

  // a19 逐条 finding 都必须有有效引用：一条绑定伪造编号 → 拒绝纠偏，补齐后才接受
  {
    const ft = makeFakeTools([{ name: 'customer.search', evidence: [{ label: '客户档案：李林辉', kind: 'customer', entityId: 1 }] }])
    const mix = JSON.stringify({ type: 'complete', summary: '两条发现', findings: [
      { text: '有据发现', evidenceRefs: ['e1'] }, { text: '无据发现', evidenceRefs: ['e99'] }
    ], nextSteps: [], evidenceRefs: ['e1'] })
    const fixed = JSON.stringify({ type: 'complete', summary: '补齐后', findings: [{ text: '有据发现', evidenceRefs: ['e1'] }], nextSteps: [], evidenceRefs: ['e1'] })
    const sc = scriptCompletion([TOOL_CALL('customer.search'), mix, fixed])
    const start = await hermesAgentService.startTask({ goal: 'g' }, { ...sc.deps, tools: ft.tools })
    const t = await waitTask(start.task!.taskId)
    ok('a19 findings 单条缺有效引用 → 纠偏后补齐才完成（result.findings 只剩有效条目）',
      t?.status === 'completed' && t.result!.summary === '补齐后' &&
      t.result!.findings.length === 1 && t.result!.findings[0].text === '有据发现')
  }

  // a20 展示证据 = 顶层 refs ∪ findings refs 并集（模型顶层漏写时徽标不悬空）
  {
    const ft = makeFakeTools([{ name: 'customer.search', evidence: [{ label: '客户档案：李林辉', kind: 'customer', entityId: 1 }] }])
    const onlyFinding = JSON.stringify({ type: 'complete', summary: '结论', findings: [{ text: '发现一', evidenceRefs: ['e1'] }], nextSteps: [], evidenceRefs: [] })
    const sc = scriptCompletion([TOOL_CALL('customer.search'), onlyFinding])
    const start = await hermesAgentService.startTask({ goal: 'g' }, { ...sc.deps, tools: ft.tools })
    const t = await waitTask(start.task!.taskId)
    ok('a20 顶层漏写但 finding 引用有效 → 证据列表按并集重建（e1 徽标有对应证据）',
      t?.status === 'completed' && t.evidence.length === 1 && t.evidence[0].ref === 'e1')
  }

  // a21 多轮追问重新引用先前被裁掉的编号 → 从 evidenceByRef 真源恢复
  {
    const ft = makeFakeTools([
      { name: 'customer.search', evidence: [{ label: '客户档案：李林辉', kind: 'customer', entityId: 1 }] },
      { name: 'chat.recent', evidence: [{ label: '聊天记录（对方）', kind: 'chat', messageKey: 'mk-1' }] }
    ])
    const sc = scriptCompletion([TOOL_CALL('customer.search'), TOOL_CALL('chat.recent'), COMPLETE('第一轮只用 e2', ['e2'])])
    const start = await hermesAgentService.startTask({ goal: 'g' }, { ...sc.deps, tools: ft.tools })
    const t1 = await waitTask(start.task!.taskId)
    const sc2 = scriptCompletion([COMPLETE('追问轮重新引用 e1', ['e1'])])
    const cont = await hermesAgentService.continueTask(start.task!.taskId, '说说客户档案那条', { ...sc2.deps, tools: ft.tools })
    const t = await waitTask(cont.task!.taskId)
    ok('a21 多轮重引旧编号 → 展示证据从 evidenceByRef 重建恢复（e1 徽标不悬空）',
      t1?.status === 'completed' && t?.status === 'completed' &&
      t.evidence.length === 1 && t.evidence[0].ref === 'e1' && t.evidence[0].label.includes('客户档案'))
  }

  // a8 步数上限：6 次工具调用后第 7 次 → too_many_steps
  {
    const ft = makeFakeTools([{ name: 'customer.search' }])
    const script: string[] = []
    for (let i = 0; i < 7; i++) script.push(TOOL_CALL('customer.search', { query: `q${i}` }))
    script.push(COMPLETE('不应到达'))
    const sc = scriptCompletion(script)
    const start = await hermesAgentService.startTask({ goal: 'g' }, { ...sc.deps, tools: ft.tools })
    const t = await waitTask(start.task!.taskId)
    ok('a8 超过 6 次工具调用 → failed too_many_steps', t?.status === 'failed' && t.errorCode === 'too_many_steps' && ft.calls.length === 6)
  }

  // a9 重复同工具同参数：不重复执行，回喂提示
  {
    const ft = makeFakeTools([{ name: 'customer.search' }])
    const sc = scriptCompletion([TOOL_CALL('customer.search', { query: '同一参数' }), TOOL_CALL('customer.search', { query: '同一参数' }), COMPLETE('换了思路完成')])
    const start = await hermesAgentService.startTask({ goal: 'g' }, { ...sc.deps, tools: ft.tools })
    const t = await waitTask(start.task!.taskId)
    ok('a9 重复调用检测：第二次不执行（fake 工具仅 1 次调用）+ 任务完成',
      t?.status === 'completed' && ft.calls.length === 1 && t.steps[1].status === 'error')
  }

  // a10 取消：在途结果被丢弃（completion 返回 complete 也不采纳）
  {
    const ft = makeFakeTools([{ name: 'customer.search' }])
    const sc = scriptCompletion([COMPLETE('取消前已生成（应被丢弃）')], { firstDelayMs: 80 })
    const start = await hermesAgentService.startTask({ goal: 'g' }, { ...sc.deps, tools: ft.tools })
    hermesAgentService.cancelTask(start.task!.taskId)
    await new Promise((r) => setTimeout(r, 200))
    const t = hermesAgentService.getTask(start.task!.taskId)
    ok('a10 取消后丢弃在途结果（状态定格 cancelled、无 result、工具零执行）',
      t?.status === 'cancelled' && !t.result && ft.calls.length === 0)
  }

  // a11 步数/时长上限内藏（深模块常量，静态断言源码在位）
  {
    const agentSrc = readFileSync(join(ROOT, 'electron/services/hermesAgent.ts'), 'utf8')
    ok('a11 限制常量在位：MAX_TOOL_CALLS = 6 / TASK_DEADLINE_MS = 90_000',
      agentSrc.includes('MAX_TOOL_CALLS = 6') && agentSrc.includes('TASK_DEADLINE_MS = 90_000'))
  }

  // a12 getTask 返回快照拷贝（外部改快照不影响内部真源）
  {
    const ft = makeFakeTools([{ name: 'customer.search' }])
    const sc = scriptCompletion([TOOL_CALL('customer.search'), COMPLETE('快照测试')])
    const start = await hermesAgentService.startTask({ goal: 'g' }, { ...sc.deps, tools: ft.tools })
    await waitTask(start.task!.taskId)
    const s1 = hermesAgentService.getTask(start.task!.taskId)
    s1!.steps.push({ label: '注入的假步骤', status: 'running' })
    const s2 = hermesAgentService.getTask(start.task!.taskId)
    ok('a12 getTask 快照隔离（改快照不污染真源）', s2!.steps.every((st) => st.label !== '注入的假步骤'))
  }

  // a13 多轮继续：completed 任务 continueTask 带摘要窗口续跑成功
  {
    const ft = makeFakeTools([{ name: 'customer.search', evidence: [{ label: '客户档案：李林辉', kind: 'customer', entityId: 1 }] }])
    const sc = scriptCompletion([TOOL_CALL('customer.search'), COMPLETE('第一轮结论', ['e1'])])
    const start = await hermesAgentService.startTask({ goal: 'g' }, { ...sc.deps, tools: ft.tools })
    await waitTask(start.task!.taskId)
    const sc2 = scriptCompletion([TOOL_CALL('customer.search', { query: '追问后的新查询' }), COMPLETE('追问结论XYZ', ['e2'])])
    const cont = await hermesAgentService.continueTask(start.task!.taskId, '那下一步呢', { ...sc2.deps, tools: ft.tools })
    const t = await waitTask(cont.task!.taskId)
    ok('a13 多轮继续：同一 taskId 续跑成功、跨轮累计工具执行、追问轮结论引用新证据',
      t?.status === 'completed' && t.taskId === start.task!.taskId && t.result?.summary === '追问结论XYZ' &&
      ft.calls.length === 2 && t.evidence.some((e) => e.ref === 'e2'))
  }

  // a13b 追问轮零新查询、引用上一轮已有证据 → 允许（任务级已有真实工具执行）
  {
    const ft = makeFakeTools([{ name: 'customer.search', evidence: [{ label: '客户档案：李林辉', kind: 'customer', entityId: 1 }] }])
    const sc = scriptCompletion([TOOL_CALL('customer.search'), COMPLETE('第一轮结论', ['e1'])])
    const start = await hermesAgentService.startTask({ goal: 'g' }, { ...sc.deps, tools: ft.tools })
    await waitTask(start.task!.taskId)
    const sc2 = scriptCompletion([COMPLETE('引用既有证据的追问结论', ['e1'])])
    const cont = await hermesAgentService.continueTask(start.task!.taskId, '为什么这么说', { ...sc2.deps, tools: ft.tools })
    const t = await waitTask(cont.task!.taskId)
    ok('a13b 追问轮零新查询但引用上一轮真实证据 → 接受（e1 仍在核验表中）',
      t?.status === 'completed' && t.result?.summary === '引用既有证据的追问结论' && t.evidence.length === 1)
  }

  // a17 取消发生在工具执行期间：返回后立即丢弃（不更新步骤/不登记证据/不回喂）
  {
    const ft = makeFakeTools([{ name: 'customer.search', evidence: [{ label: '取消期间的证据', kind: 'crm', entityId: 9 }] }])
    const taskIdBox: { id: string } = { id: '' }
    const tools = ft.tools.map((t) => ({
      ...t,
      run: async (args: Record<string, unknown>, ctx: HermesToolContext) => {
        hermesAgentService.cancelTask(taskIdBox.id) // 工具执行中途取消
        return t.run(args, ctx)
      }
    }))
    const sc = scriptCompletion([TOOL_CALL('customer.search', { query: '取消期间' }), COMPLETE('不应被采纳', ['e1'])])
    const start = await hermesAgentService.startTask({ goal: 'g' }, { ...sc.deps, tools })
    taskIdBox.id = start.task!.taskId
    await new Promise((r) => setTimeout(r, 250))
    const t = hermesAgentService.getTask(start.task!.taskId)
    ok('a17 工具执行期间取消 → 在途结果被丢弃（cancelled、零证据登记、步骤未标 done）',
      t?.status === 'cancelled' && t.evidence.length === 0 && !t.steps.some((s) => s.status === 'done'))
  }

  // a14 运行中继续 → busy（不并行双 Loop）
  {
    const ft = makeFakeTools([{ name: 'customer.search' }])
    const sc = scriptCompletion([COMPLETE('慢响应')], { firstDelayMs: 120 })
    const start = await hermesAgentService.startTask({ goal: 'g' }, { ...sc.deps, tools: ft.tools })
    const cont = await hermesAgentService.continueTask(start.task!.taskId, '插队追问', { configured: () => true })
    await waitTask(start.task!.taskId)
    ok('a14 运行中 continueTask 被拒（busy）', cont.ok === false && cont.errorCode === 'busy')
  }

  // a15/a16 基础契约：空 goal 拒绝；任务完成后保留内存（不丢、可复查）
  {
    const r = await hermesAgentService.startTask({ goal: '' }, { configured: () => true })
    ok('a15 空 goal → bad_request', r.ok === false && r.errorCode === 'bad_request')
  }
  {
    const ft = makeFakeTools([{ name: 'customer.search' }])
    const sc = scriptCompletion([TOOL_CALL('customer.search'), COMPLETE('留存结论')])
    const start = await hermesAgentService.startTask({ goal: 'g' }, { ...sc.deps, tools: ft.tools })
    await waitTask(start.task!.taskId)
    const t1 = hermesAgentService.getTask(start.task!.taskId)
    const t2 = hermesAgentService.getTask(start.task!.taskId)
    ok('a16 任务收尾后仍可 getTask（主进程内存保留，不落盘也不丢）',
      !!t1 && !!t2 && t1.result?.summary === '留存结论' && t2.result?.summary === '留存结论')
  }

  // ─── b. 权限动态（真实 HERMES_TOOLS + /tmp 副本库）─────────────────────────
  const now = Date.now()
  const accMe = crmDbService.create('account', { name: '杨青的客户', owner_sales: '杨青', session_id: 'wxid_me', created_at: now, updated_at: now })
  const accPeer = crmDbService.create('account', { name: '王五的客户', owner_sales: '王五', session_id: 'wxid_peer', created_at: now, updated_at: now })
  const accPublic = crmDbService.create('account', { name: '公共未归属客户', owner_sales: '', session_id: 'wxid_pub', created_at: now, updated_at: now })
  void accMe; void accPeer; void accPublic
  const kbPub = salesDbService.kbCreate({ category: 'faq', title: '叉车保养周期是多久', content: '叉车每 200 小时保养一次，需更换机油。' })
  salesDbService.kbReview(kbPub.id!, 'publish', { reviewer: '主管甲' })
  salesDbService.kbCreate({ category: 'faq', title: '内部底价秘密条目', content: '内部底价信息不应外泄。' })

  const toolByName = (name: string): HermesToolDef => HERMES_TOOLS.find((t) => t.name === name)!
  const ctxOf = (identity: Identity): HermesToolContext => ({ identity })

  // b1-b3 customer.search owner 三态
  {
    const r1 = await toolByName('customer.search').run({ query: '王五的客户' }, ctxOf(ME))
    ok('b1 销售查他人客户 → 可见性过滤后空结果（诚实「没有找到」，不泄露行是否存在）',
      r1.ok === true && (r1.data as { customers: unknown[] }).customers.length === 0 && r1.publicSummary.includes('没有找到'))
    const r2 = await toolByName('customer.search').run({ query: '杨青的客户' }, ctxOf(ME))
    ok('b2 销售查本人客户 → 命中并产出证据',
      r2.ok === true && (r2.data as { customers: Array<{ name: string }> }).customers.length === 1 &&
      r2.evidence?.[0]?.entityId === Number(accMe))
    const r3 = await toolByName('customer.search').run({ query: '公共未归属' }, ctxOf(ME))
    ok('b3 空归属=公共资源，销售可见', r3.ok === true && (r3.data as { total: number }).total === 1)
  }

  // b4 管理视角全见
  {
    const r = await toolByName('customer.search').run({ query: '王五的客户' }, ctxOf(BOSS))
    ok('b4 空身份=管理视角全见', r.ok === true && (r.data as { total: number }).total === 1)
  }

  // b5-b7 current_view / chat.recent 可见性校验（不可见 → not_found，不触读取层）
  {
    const r1 = await toolByName('customer.current_view').run({ accountId: Number(accPeer) }, ctxOf(ME))
    ok('b5 不可见 accountId → current_view 返回 not_found（不泄露行是否存在）',
      r1.ok === false && r1.errorCode === 'not_found' && r1.publicSummary.includes('没有找到'))
    const r2 = await toolByName('customer.current_view').run({ accountId: Number(accMe) }, ctxOf(ME))
    ok('b6 本人 accountId → current_view 可查（无档案视图也诚实返回）',
      r2.ok === true && (r2.data as { found: boolean }).found === false)
    const r3 = await toolByName('chat.recent').run({ accountId: Number(accPeer) }, ctxOf(ME))
    ok('b7 不可见 accountId → chat.recent 返回 not_found（聊天读取前先过可见性校验）',
      r3.ok === false && r3.errorCode === 'not_found')
  }

  // b8 knowledge.search 只回 published
  {
    const r1 = await toolByName('knowledge.search').run({ query: '叉车保养' }, ctxOf(ME))
    ok('b8 published 条目可检索（标题/版本/证据齐）',
      r1.ok === true && (r1.data as { entries: Array<{ title: string }> }).entries.some((e) => e.title.includes('叉车保养')))
    const r2 = await toolByName('knowledge.search').run({ query: '内部底价秘密' }, ctxOf(ME))
    ok('b9 staging 条目绝不出现（SQL 级只查 published）',
      r2.ok === true && (r2.data as { entries: unknown[] }).entries.length === 0)
  }

  // b10 白名单静态：恰 9 个、必备工具在列、零写语义工具名
  {
    const names = HERMES_TOOLS.map((t) => t.name)
    ok('b10 工具白名单恰 9 个且必备工具在列（search/by_session/current_view/chat.recent/customer_business/my_list/month_paid/action.pending/knowledge.search）',
      names.length === 9 &&
      ['customer.search', 'customer.by_session', 'customer.current_view', 'chat.recent',
        'crm.customer_business', 'opportunity.my_list', 'payment.month_paid',
        'action.pending', 'knowledge.search'].every((n) => names.includes(n)))
    ok('b11 白名单无写语义工具（零 create/update/delete/send/publish）',
      names.every((n) => !/create|update|delete|send|publish|write/i.test(n)))
  }

  // b12-b13 customer.by_session 收紧：只认宿主持有的 chat context，模型提供的 sessionId 一律不采信
  {
    const r1 = await toolByName('customer.by_session').run({}, { identity: ME, contextKind: 'chat', sessionId: 'wxid_peer' })
    ok('b12 他人会话（宿主 chat 上下文）解析 → not_found（可见性话术，不泄露档案是否存在）',
      r1.ok === false && r1.errorCode === 'not_found' && r1.publicSummary.includes('没有找到'))
    const rForge = await toolByName('customer.by_session').run(
      { sessionId: 'wxid_peer' }, { identity: ME, contextKind: 'chat', sessionId: 'wxid_me' })
    ok('b12a 模型伪造他人 sessionId → 被忽略，按宿主会话解析出本人客户（不越权、不泄露他人档案）',
      rForge.ok === true && (rForge.data as { name: string }).name === '杨青的客户' &&
      rForge.evidence?.[0]?.entityId === Number(accMe))
    const rG = await toolByName('customer.by_session').run({ sessionId: 'wxid_me' }, ctxOf(ME))
    ok('b12b 非聊天上下文调用 → context_required + 人话提示（不接受模型提供 sessionId）',
      rG.ok === false && rG.errorCode === 'context_required' && rG.publicSummary.includes('没有绑定聊天上下文'))
    const rNoSid = await toolByName('customer.by_session').run({}, { identity: ME, contextKind: 'chat' })
    ok('b12c chat 上下文但宿主未持有会话 → context_required（不猜、不解析）',
      rNoSid.ok === false && rNoSid.errorCode === 'context_required')
    const r2 = await toolByName('customer.by_session').run({}, { identity: ME, contextKind: 'chat', sessionId: 'wxid_me' })
    ok('b13 本人会话解析 → 命中客户名与 accountId 证据（模型可见摘要不含 sessionId）',
      r2.ok === true && (r2.data as { name: string }).name === '杨青的客户' &&
      r2.evidence?.[0]?.entityId === Number(accMe) && !('sessionId' in (r2.data as Record<string, unknown>)))
  }

  // b14 opportunity.my_list：全局活跃商机（可见性过滤后按沉默倒序）
  {
    const oppMe = crmDbService.create('opportunity', { account_id: Number(accMe), product: 'X系列叉车', stage: 'negotiation', status: 'active', amount: 50000, owner_sales: '杨青', last_signal_at: now - 3 * 86400000, created_at: now, updated_at: now })
    const oppPeer = crmDbService.create('opportunity', { account_id: Number(accPeer), product: '内部商机', stage: 'initial', status: 'active', amount: 999999, owner_sales: '王五', last_signal_at: now - 30 * 86400000, created_at: now, updated_at: now })
    void oppPeer
    const r1 = await toolByName('opportunity.my_list').run({}, ctxOf(ME))
    const rows = (r1.data as { opportunities: Array<{ customer: string; product: string }> }).opportunities
    ok('b14 全局商机列表：销售只见本人/公共商机（他人的不可见），客户名带出',
      r1.ok === true && rows.length === 1 && rows[0].customer === '杨青的客户' && rows[0].product === 'X系列叉车')
    const r2 = await toolByName('opportunity.my_list').run({}, ctxOf(BOSS))
    ok('b15 管理视角全见（含他人商机）', r2.ok === true && (r2.data as { total: number }).total === 2)
    void oppMe
  }

  // b16 payment.month_paid：空库诚实返回（真实执行 monthPaidByOwner SQL 链路）
  {
    const r = await toolByName('payment.month_paid').run({}, ctxOf(ME))
    ok('b16 本月到款工具：空数据诚实返回「没有已确认的到款」（不编造数字）',
      r.ok === true && (r.data as { count: number }).count === 0 && r.publicSummary.includes('没有已确认的到款'))
  }

  // b17 先过滤后 slice（P2 回归）：55 条他人同名客户（超过任何有限候选窗口）霸占
  // updated_at 倒序前列，本人匹配项仍不被挤出——验证「完整匹配集合后过滤」而非有限候选
  {
    for (let i = 0; i < 55; i++) {
      crmDbService.create('account', {
        name: `压榜同名客户${i}`, owner_sales: '王五', session_id: `wxid_flood_${i}`,
        created_at: now + i, updated_at: now + i // updated_at 递增 → 搜索排序时排在最前
      })
    }
    const accLate = crmDbService.create('account', { name: '压榜同名客户本人', owner_sales: '杨青', session_id: 'wxid_late', created_at: now, updated_at: now })
    const r = await toolByName('customer.search').run({ query: '压榜同名' }, ctxOf(ME))
    const names = (r.data as { customers: Array<{ name: string }> }).customers.map((c) => c.name)
    ok('b17 完整匹配集合过滤后再 slice：55 条他人记录也不挤出本人客户（无 SQL LIMIT 短板）',
      r.ok === true && names.length === 1 && names[0] === '压榜同名客户本人' &&
      r.evidence?.[0]?.entityId === Number(accLate))
  }

  // b18 action.pending 同口径：全量候选过滤后再 slice（动态走真实 todoList SQL 链路）
  {
    const r = await toolByName('action.pending').run({ limit: 5 }, ctxOf(ME))
    ok('b18 待办工具真实执行（空库返回 0 条、结构完整）',
      r.ok === true && (r.data as { tasks: unknown[] }).tasks.length === 0 && r.publicSummary.includes('没有待办'))
  }

  // b20 模型可见客户摘要零会话标识：accountBrief 字段收紧后整个工具输出不含任何 wxid
  {
    const r = await toolByName('customer.search').run({ query: '杨青的客户' }, ctxOf(ME))
    const c0 = (r.data as { customers: Array<Record<string, unknown>> }).customers[0]
    ok('b20 accountBrief 不含 sessionId（整个工具输出 JSON 不出现 wxid 会话标识）',
      r.ok === true && !!c0 && !('sessionId' in c0) && !JSON.stringify(r).includes('wxid_me'))
  }

  // b21 结构化标识脱敏（纯函数动态）：微信号三形态命中 isSessionIdLike 一律 ***，手机号仍走文本脱敏，中文昵称不误伤
  {
    ok('b21 结构化标识脱敏：自定义微信号/群号/wxid 一律 ***，手机号走 maskPrivateText，昵称保留',
      maskStructuredId('wan923121735') === '***' && maskStructuredId('wxid_abc123') === '***' &&
      maskStructuredId('88886666@chatroom') === '***' && maskStructuredId('13812345678') === '***' &&
      maskStructuredId('张师傅') === '张师傅')
  }

  // ─── c. 上下文动态 ────────────────────────────────────────────────────────
  {
    // c1 customer 上下文：accountId/sessionId 进 toolContext（fake 工具记录）
    const ft = makeFakeTools([{ name: 'customer.search' }])
    const sc = scriptCompletion([TOOL_CALL('customer.search'), COMPLETE('ok')])
    const start = await hermesAgentService.startTask(
      { goal: 'g', context: { kind: 'customer', accountId: 123, sessionId: 'wxid_x' }, contextLabel: '客户：李林辉' },
      { ...sc.deps, tools: ft.tools })
    await waitTask(start.task!.taskId)
    ok('c1 customer 上下文注入 toolContext（accountId/sessionId/身份；contextLabel 人话透传）',
      ft.calls.length === 1 && ft.calls[0].ctx.accountId === 123 && ft.calls[0].ctx.sessionId === 'wxid_x' &&
      start.task!.contextLabel === '客户：李林辉')
  }
  {
    const ft = makeFakeTools([{ name: 'customer.search' }])
    const sc = scriptCompletion([TOOL_CALL('customer.search'), COMPLETE('ok')])
    const start = await hermesAgentService.startTask({ goal: 'g', context: { kind: 'chat', sessionId: 'sess-abc' } }, { ...sc.deps, tools: ft.tools })
    await waitTask(start.task!.taskId)
    ok('c2 chat 上下文注入 sessionId、无 accountId',
      ft.calls[0].ctx.sessionId === 'sess-abc' && ft.calls[0].ctx.accountId === undefined)
  }
  {
    const ft = makeFakeTools([{ name: 'customer.search' }])
    const sc = scriptCompletion([TOOL_CALL('customer.search'), COMPLETE('ok')])
    const start = await hermesAgentService.startTask({ goal: 'g' }, { ...sc.deps, tools: ft.tools })
    await waitTask(start.task!.taskId)
    ok('c3 global 上下文（缺省）：toolContext 无客户锚点',
      ft.calls[0].ctx.accountId === undefined && ft.calls[0].ctx.sessionId === undefined && start.task!.contextLabel === '全局')
  }
  // c10 聊天入口端到端（真实 HERMES_TOOLS + 真实库）：模型伪造 sessionId 被忽略，
  // by_session 只按宿主持有的 chat 上下文解析，伪造他人会话 id 不越权也不入任务快照
  {
    const sc = scriptCompletion([TOOL_CALL('customer.by_session', { sessionId: 'wxid_peer' }), COMPLETE('会话客户结论', ['e1'])])
    const start = await hermesAgentService.startTask(
      { goal: '这个会话的客户聊到哪一步了', context: { kind: 'chat', sessionId: 'wxid_me' } },
      { ...sc.deps }) // 不注入 tools → 走真实白名单注册表
    const t = await waitTask(start.task!.taskId)
    ok('c10 聊天入口端到端：伪造 sessionId 无效，真实 by_session 按宿主上下文解析本人客户',
      t?.status === 'completed' && JSON.stringify(t.evidence).includes('杨青的客户') &&
      !JSON.stringify(t).includes('wxid_peer') && !JSON.stringify(t).includes('wxid_me'))
  }

  // c4-c9 hermesStore 三入口语义（zustand 纯前端 store，node 环境可直接驱动）
  // 任务锚点按上下文独立记忆：切到别的客户/全局不会把旧上下文的任务串显到新标题下
  {
    const s = useHermesStore
    const anchorOf = (): string | null => {
      const st = s.getState()
      return st.lastTaskByContext[contextKeyOf(st.context)] ?? null
    }
    s.getState().openHermes() // 侧边栏全局入口：无参 → global
    ok('c4 全局入口打开 → context 变 global 且 isOpen', s.getState().context.kind === 'global' && s.getState().isHermesOpen)
    s.getState().setLastTaskId('task-global')
    s.getState().openHermes({ kind: 'customer', accountId: 9, sessionId: 'wxid_c', customerName: '客户甲' })
    ok('c5 客户甲入口 → customer 上下文注入，且该上下文无任务锚点（全局任务不串显）',
      s.getState().context.kind === 'customer' && s.getState().context.accountId === 9 && anchorOf() === null)
    s.getState().setLastTaskId('task-cust-a')
    s.getState().openHermes({ kind: 'customer', accountId: 10, sessionId: 'wxid_d', customerName: '客户乙' })
    ok('c6 切到客户乙 → 标题上下文是乙、正文锚点是乙自己的（甲的任务不跟随）',
      s.getState().context.accountId === 10 && anchorOf() === null)
    s.getState().setLastTaskId('task-cust-b')
    s.getState().openHermes({ kind: 'customer', accountId: 9, sessionId: 'wxid_c', customerName: '客户甲' })
    ok('c7 切回客户甲 → 恢复甲自己的任务锚点（各上下文互不覆盖）',
      anchorOf() === 'task-cust-a')
    s.getState().openHermes() // 全局入口
    ok('c8 切回全局 → 恢复全局任务锚点（closeHermes/切入口都不删任务）',
      s.getState().context.kind === 'global' && anchorOf() === 'task-global')
    s.getState().closeHermes()
    ok('c9 关闭抽屉不删任务（任务真源在主进程，锚点仍在）',
      s.getState().isHermesOpen === false && (s.getState().lastTaskByContext['global'] === 'task-global' &&
        s.getState().lastTaskByContext['customer:9'] === 'task-cust-a' &&
        s.getState().lastTaskByContext['customer:10'] === 'task-cust-b'))
  }

  // c11 取消收尾门槛（纯判定动态）：取消发起时捕获上下文 key + taskId，
  // await 返回后只有「当前上下文一致 且 该上下文锚点仍指向同一任务」才允许写视图
  {
    ok('c11 取消期间切上下文不串显：同上下文同锚点才放行（切客户/切聊天/另起新任务/锚点被清一律拒绝）',
      canSettleTaskView('customer:9', 't1', 'customer:9', 't1') &&
      !canSettleTaskView('customer:10', null, 'customer:9', 't1') &&
      !canSettleTaskView('chat:s2', 't2', 'chat:s1', 't1') &&
      !canSettleTaskView('global', null, 'customer:9', 't1') &&
      !canSettleTaskView('customer:9', 't9', 'customer:9', 't1'))
  }

  // ─── d. UI 静态护栏 ───────────────────────────────────────────────────────
  const panelSrc = readFileSync(join(ROOT, 'src/components/hermes/HermesPanel.tsx'), 'utf8')
  const panelScss = readFileSync(join(ROOT, 'src/components/hermes/HermesPanel.scss'), 'utf8')
  const agentSrc = readFileSync(join(ROOT, 'electron/services/hermesAgent.ts'), 'utf8')
  const registrySrc = readFileSync(join(ROOT, 'electron/services/hermesToolRegistry.ts'), 'utf8')
  const preloadSrc = readFileSync(join(ROOT, 'electron/preload.ts'), 'utf8')
  const dtsSrc = readFileSync(join(ROOT, 'src/types/electron.d.ts'), 'utf8')
  const appSrc = readFileSync(join(ROOT, 'src/App.tsx'), 'utf8')
  const sidebarSrc = readFileSync(join(ROOT, 'src/components/Sidebar.tsx'), 'utf8')
  const chatSrc = readFileSync(join(ROOT, 'src/pages/ChatPage.tsx'), 'utf8')
  const cwsSrc = readFileSync(join(ROOT, 'src/pages/CustomerWorkspacePage.tsx'), 'utf8')

  // d1 面板零发送类 IPC（AI 碰不到发送键）
  ok('d1 HermesPanel 零发送类 IPC', !/sendMsg|sendMessage|sendTextMessage|msgSend|chat:send|message:send|sendImage|\.send\(/.test(panelSrc))

  // d2 五态文案（空闲/运行/完成/失败/追问）+ 失败人话
  ok('d2 五态文案在位：空闲目标输入/运行真实步骤/完成结论/失败人话/追问',
    panelSrc.includes('说出你的销售目标') && panelSrc.includes('正在规划查询步骤') &&
    panelSrc.includes('结论') && panelSrc.includes('暂时无法查询，请重试') &&
    panelSrc.includes('继续追问') && panelSrc.includes('AI 结论仅供参考'))

  // d3 scss 零硬编码 hex（token 化 --color-* 族）
  ok('d3 HermesPanel.scss 零硬编码 hex（--color-* 族自适应 light/dark）', !/#[0-9a-fA-F]{3,8}\b/.test(panelScss))

  // d4 preload hermes 段：四接口 + 进度事件退订 + 零 send
  {
    const seg = preloadSrc.slice(preloadSrc.indexOf('hermes: {'), preloadSrc.indexOf('analytics: {'))
    ok('d4 preload hermes 段四接口+进度事件（可退订）且零 send 类通道',
      seg.includes("invoke('hermes:task:start'") && seg.includes("invoke('hermes:task:continue'") &&
      seg.includes("invoke('hermes:task:cancel'") && seg.includes("invoke('hermes:task:get'") &&
      seg.includes("on('hermes:task:progress'") && seg.includes('removeListener') && !/ipcRenderer\.send\(/.test(seg))
  }

  // d5 d.ts 类型同步
  ok('d5 electron.d.ts hermes 类型同步（四接口+HermesTaskSnapshot+退订签名）',
    dtsSrc.includes('startTask: (payload: {') && dtsSrc.includes('HermesTaskSnapshot') &&
    dtsSrc.includes('onTaskProgress: (callback: (task: HermesTaskSnapshot) => void) => () => void'))

  // d6 三入口语义（Sidebar 动作项 / ChatPage 会话上下文 / CustomerWorkspace 客户上下文）
  ok('d6 Sidebar「Hermes」为动作项（Bot 图标、action: openHermes、无 path）',
    /label: 'Hermes', icon: Bot, action: 'openHermes' \}/.test(sidebarSrc) && !/Hermes.*path:/.test(sidebarSrc))

  // d7 旧面板摘除：App 不再挂 KnowledgeAskPanel；旧「问知识库」文案从两个页面消失
  ok('d7 App.tsx 恰一个 HermesPanel、零 KnowledgeAskPanel', (appSrc.match(/<HermesPanel \/>/g) || []).length === 1 && !appSrc.includes('KnowledgeAskPanel'))
  ok('d8 ChatPage / CustomerWorkspacePage 旧「问知识库」文案摘除',
    !chatSrc.includes('问知识库') && !cwsSrc.includes('问知识库'))

  // d9 主进程零写路径（agent 与 registry 均只读；无 INSERT/UPDATE/写方法调用）
  ok('d9 hermesAgent + hermesToolRegistry 零写路径（无 INSERT/UPDATE/DELETE、零写方法调用）',
    !/INSERT INTO|DELETE FROM|\.update\(|kbCreate|kbReview|kbUpdate|kbDelete|todoCreate|customerUpsert|opportunityUpsert|opportunityEventAdd/.test(agentSrc) &&
    !/INSERT INTO|DELETE FROM|kbCreate|kbReview|kbUpdate|kbDelete|todoCreate|customerUpsert|opportunityUpsert|opportunityEventAdd/.test(registrySrc))

  // d10 失败文案映射全部人话（不出现 SQL/IPC/堆栈字样）
  ok('d10 FRIENDLY_ERROR 全员人话（无 SQL/ipc/stack/路径字样）',
    !/SQL|ipcRenderer|stack|\.db\b|SELECT /i.test(agentSrc.slice(agentSrc.indexOf('FRIENDLY_ERROR'), agentSrc.indexOf('// ─── 内部结构'))))

  // d11 审查修复固化（静态）：证据约束闭环 / 工具期间取消丢弃 / 可见性措辞诚实 / 锚点驱动
  ok('d11a 证据约束闭环在源码固化（validateCompletion：零查询拒绝 + 并集非空 + 逐条有效引用 + result 兜底）',
    agentSrc.includes('validateCompletion') && /rt\.okToolCalls <= 0/.test(agentSrc) &&
    /MAX_DATA_RETRIES/.test(agentSrc) && /你还没有通过工具查询到任何真实数据/.test(agentSrc) &&
    /没有绑定任何有效证据编号/.test(agentSrc) && /无匹配结果/.test(agentSrc))
  ok('d11b 展示证据按并集从 evidenceByRef 重建（顶层+findings refs、多轮重引可恢复）',
    agentSrc.includes('flatMap((f) => f.evidenceRefs)') && agentSrc.includes('evidenceByRef.get(ref)'))
  ok('d11c 工具执行期间取消：返回后立即丢弃（tool.run 两条出口后均有 cancelRequested 检查）',
    (agentSrc.match(/if \(rt\.cancelRequested\) \{ this\.discardInFlight\(rt\); return \}/g) || []).length >= 4)
  ok('d11d 可见性措辞诚实（registry 明示 filterByOwner 非安全边界、不称权限）',
    registrySrc.includes('非安全边界') && registrySrc.includes('可见性过滤') &&
    !/无权/.test(registrySrc))
  ok('d11e 推荐目标与工具能力对齐（快凉商机/本月到款均有全局工具支撑）',
    registrySrc.includes("'opportunity.my_list'") && registrySrc.includes("'payment.month_paid'") &&
    panelSrc.includes('快凉的商机') && panelSrc.includes('本月到款'))
  ok('d11f findings 逐条绑证据（d.ts 与面板徽标接线同步）',
    dtsSrc.includes('evidenceRefs: string[]') && panelSrc.includes('hermes-finding__refs') &&
    panelScss.includes('hermes-finding__refs'))
  ok('d11g 面板锚点驱动（切换清空/进度按锚点过滤/锚点写回发起方上下文）',
    panelSrc.includes('setTask(null)') && panelSrc.includes('!== startedKey') &&
    panelSrc.includes("cur.lastTaskByContext[contextKeyOf(cur.context)]") &&
    !/if \(taskRef\.current && t\.taskId !== taskRef\.current\.taskId\)/.test(panelSrc))
  ok('d11h 客户搜索完整匹配集合（accountSearchByName limit=0 无 SQL LIMIT，先过滤后 slice）',
    registrySrc.includes('accountSearchByName(query, 0)') &&
    /limit <= 0/.test(readFileSync(join(ROOT, 'electron/services/crmDbService.ts'), 'utf8')))

  // d12 取消竞态门槛接线（handleCancel 捕获发起时上下文 key，await 返回后过 canSettleTaskView 才 setTask）
  ok('d12 取消收尾走 canSettleTaskView 门槛（捕获 cancelKey + taskId，切上下文/换锚点不写视图）',
    panelSrc.includes('canSettleTaskView') && /const cancelKey = contextKeyOf\(context\)/.test(panelSrc) &&
    /canSettleTaskView\(contextKeyOf\(cur\.context\), anchor, cancelKey, tid\)/.test(panelSrc))

  // d13 结构化标识脱敏接线（chat.recent sender 走 maskStructuredId；accountBrief 不再有 sessionId 字段）
  ok('d13 结构化标识脱敏接线（sender: maskStructuredId + isSessionIdLike；accountBrief 零 sessionId）',
    registrySrc.includes('sender: maskStructuredId(') && registrySrc.includes('isSessionIdLike') &&
    !/sessionId: String\(a\.session_id/.test(registrySrc))

  // e. 旧库迁移：knowledge-governance-test g 节已覆盖（g1-g10 真实旧库文件升级），此处不重复。
  console.log('（e 节：旧库迁移由 knowledge-governance-test g1-g10 覆盖）')

  console.log(`\nhermes-agent-test: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
