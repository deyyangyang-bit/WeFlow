/**
 * hermes-protocol-test.ts —— Hermes Main ↔ UtilityProcess 共享协议测试（任务 2/4）
 * 覆盖：
 *  a. 协议版本与信封：HERMES_PROTOCOL_VERSION=1 / Main→Utility 九类 + Utility→Main 七类消息全部通过
 *     运行时校验（discriminated union 不只靠 TS 类型）/ 非法版本·缺 id·未知 type·非对象拒绝
 *  b. 可序列化硬门禁：函数 / Error 原对象 / 类实例（AbortController·ConfigService·db 实例·Electron
 *     对象同型）/ BigInt / Symbol 一律拒绝；undefined 字段按 JSON 语义等价缺席
 *  c. host.request 能力校验：仅 model.complete / tool.execute 两类；字段缺失 / 未知 capability /
 *     arguments 含函数拒绝
 *  d. HermesUtilityContext 校验：三种 kind；capabilityContextId/label 必填；多带 sessionId 字段
 *     = 携带真实会话标识 → 拒绝（chat 上下文不能含真实 sessionId 的协议硬边界）
 *  e. checkpoint 校验与脱敏：完整 checkpoint 通过 + JSON 往返等价；缺 conversation/evidenceByRef
 *     拒绝；evidence 带 messageKey = 本机路径/发送者标识出宿主 → 硬拒绝
 *  f. 任务快照（协议形态）：findings v2 结构；evidence 带 messageKey 拒绝
 *  g. 边界扫描 findHermesBoundaryIssues：sessionId/session_id/messageKey/apiKey 字段、
 *     wxid_ 前缀号 / @chatroom 群号值报issue；业务名（ModelX/AgreementA）不误伤（a31 教训）
 *  h. 消息 id 生成：非空、唯一、带前缀
 * 运行：npx tsx scripts/hermes-protocol-test.ts
 */

let pass = 0, fail = 0
function ok(name: string, cond: boolean): void {
  if (cond) { pass++ } else { fail++; console.error('FAIL:', name) }
}

import {
  HERMES_PROTOCOL_VERSION,
  createHermesMessageId,
  isHermesSerializable,
  isHermesUtilityContext,
  isHermesHostRequest,
  isHermesProtocolError,
  isHermesProtocolTaskSnapshot,
  isHermesCheckpoint,
  isMainToUtilityMessage,
  isUtilityToMainMessage,
  isHermesProtocolMessage,
  findHermesBoundaryIssues,
  type HermesCheckpoint,
  type HermesProtocolTaskSnapshot,
  type HermesUtilityContext
} from '../shared/hermesProtocol'

// ─── 夹具 ────────────────────────────────────────────────────────────────────

const base = { protocolVersion: HERMES_PROTOCOL_VERSION, id: 'm-1' }

const CTX: HermesUtilityContext = { kind: 'customer', capabilityContextId: 'cap-1', accountId: 5, label: '客户：李林辉' }

const SNAPSHOT: HermesProtocolTaskSnapshot = {
  taskId: 't1',
  status: 'completed',
  goal: '分析李林辉',
  contextLabel: '当前客户',
  steps: [{ label: '调用客户搜索', status: 'done', tool: 'customer.search', publicSummary: '找到 1 个客户。' }],
  evidence: [{ ref: 'e1', label: '客户档案：李林辉', kind: 'customer', entityId: 5 }],
  result: { summary: '李林辉值得跟进', findings: [{ text: '活跃商机在比价阶段', evidenceRefs: ['e1'] }], nextSteps: ['三天内回访'] },
  createdAt: 1_700_000_000_000
}

const CHECKPOINT: HermesCheckpoint = {
  protocolVersion: HERMES_PROTOCOL_VERSION,
  taskId: 't1',
  runId: 1,
  savedAt: 1_700_000_000_000,
  goal: '分析李林辉',
  context: CTX,
  conversation: [
    { role: 'system', content: '你是 Hermes。' },
    { role: 'user', content: '【销售目标】分析李林辉' },
    { role: 'assistant', content: '{"type":"tool_call","tool":"customer.search","arguments":{"query":"李林辉"},"reason":"查客户"}' }
  ],
  evidenceByRef: {
    e1: { label: '客户档案：李林辉', kind: 'customer', entityId: 5 },
    e2: { label: '聊天记录（我发出）', kind: 'chat', excerpt: '价格多少' }
  },
  nextEvidenceSeq: 2,
  okToolCalls: 1
}

const M2U: Record<string, unknown> = {
  init: { ...base, type: 'init', tools: [{ name: 'customer.search', publicLabel: '客户搜索', description: '按名字搜索', argsHint: '{"query":"客户名字"}' }] },
  restore: { ...base, type: 'restore', checkpoint: CHECKPOINT },
  'task.start': { ...base, type: 'task.start', taskId: 't1', runId: 1, goal: '分析李林辉', context: CTX },
  'task.continue': { ...base, type: 'task.continue', taskId: 't1', runId: 2, question: '为什么' },
  'task.cancel': { ...base, type: 'task.cancel', taskId: 't1' },
  'task.get': { ...base, type: 'task.get', taskId: 't1' },
  'host.response': { ...base, type: 'host.response', requestId: 'r1', taskId: 't1', ok: true, text: '{"type":"complete"}' },
  shutdown: { ...base, type: 'shutdown' },
  ping: { ...base, type: 'ping' }
}

const U2M: Record<string, unknown> = {
  ready: { ...base, type: 'ready' },
  'task.response': { ...base, type: 'task.response', taskId: 't1', runId: 1, op: 'get', ok: true, snapshot: SNAPSHOT },
  'task.progress': { ...base, type: 'task.progress', taskId: 't1', runId: 1, snapshot: { ...SNAPSHOT, status: 'running', result: undefined } },
  'task.checkpoint': { ...base, type: 'task.checkpoint', checkpoint: CHECKPOINT },
  'host.request': {
    ...base, type: 'host.request',
    request: { capability: 'tool.execute', requestId: 'r1', taskId: 't1', capabilityContextId: 'cap-1', tool: 'customer.search', arguments: { query: '李林辉' } }
  },
  fatal: { ...base, type: 'fatal', code: 'internal', message: '智能体进程异常退出，请重试。' },
  pong: { ...base, type: 'pong' }
}

const M2U_TYPES = ['init', 'restore', 'task.start', 'task.continue', 'task.cancel', 'task.get', 'host.response', 'shutdown', 'ping']
const U2M_TYPES = ['ready', 'task.response', 'task.progress', 'task.checkpoint', 'host.request', 'fatal', 'pong']

// ─── a. 协议版本与信封 ─────────────────────────────────────────────────────────

ok('a1 协议版本固定为 2（v2 = runId 轮次 + evidenceHandle 收紧）', HERMES_PROTOCOL_VERSION === 2)

for (const type of M2U_TYPES) {
  ok(`a2 Main→Utility ${type} 通过运行时校验`, isMainToUtilityMessage(M2U[type]) === true)
}
for (const type of U2M_TYPES) {
  ok(`a3 Utility→Main ${type} 通过运行时校验`, isUtilityToMainMessage(U2M[type]) === true)
}

{
  const bad = (name: string, msg: Record<string, unknown>, validate: (v: unknown) => boolean): void => {
    ok(name, validate(msg) === false)
  }
  bad('a4a protocolVersion=3 拒绝', { ...base, protocolVersion: 3, type: 'ping' }, isMainToUtilityMessage)
  bad('a4b protocolVersion 缺失拒绝', { id: 'm', type: 'ping' }, isMainToUtilityMessage)
  bad('a4c protocolVersion 非数字拒绝', { ...base, protocolVersion: '1', type: 'ping' }, isMainToUtilityMessage)
  bad('a5a id 缺失拒绝', { protocolVersion: 1, type: 'ping' }, isMainToUtilityMessage)
  bad('a5b id 空串拒绝', { ...base, id: '', type: 'ping' }, isMainToUtilityMessage)
  bad('a5c id 非字符串拒绝', { ...base, id: 123, type: 'ping' }, isMainToUtilityMessage)
  bad('a6a 未知 type 拒绝', { ...base, type: 'task.delete' }, isMainToUtilityMessage)
  bad('a6b 非对象拒绝', 'ping', isMainToUtilityMessage)
  bad('a6c 数组拒绝', [base], isMainToUtilityMessage)
  bad('a6d null 拒绝', null, isMainToUtilityMessage)
  bad('a6e Utility→Main 不收 Main→Utility 消息', M2U['task.start'], isUtilityToMainMessage)
  bad('a6f Main→Utility 不收 Utility→Main 消息', U2M['fatal'], isMainToUtilityMessage)
  ok('a7 isHermesProtocolMessage 双向都收（+ 非法拒绝）',
    isHermesProtocolMessage(M2U['ping']) && isHermesProtocolMessage(U2M['ready']) && !isHermesProtocolMessage({ ...base, type: 'nope' }))
}

// ─── b. 可序列化硬门禁（协议边界：函数/Error/AbortController/Electron 对象禁止）──

{
  class FakeMainObject { secret = 'x' } // 模拟 ConfigService/db 实例/Electron 对象等类实例
  ok('b1 普通可序列化 payload 通过', isHermesSerializable({ a: 'x', b: [1, 2, { c: null }], d: true }))
  ok('b2 函数值拒绝', isHermesSerializable({ run: () => 1 }) === false)
  ok('b3 Error 原对象拒绝', isHermesSerializable({ err: new Error('boom') }) === false)
  ok('b4 类实例（ConfigService/db/AbortController 同型）拒绝', isHermesSerializable({ obj: new FakeMainObject() }) === false)
  ok('b4b AbortController 实例拒绝', isHermesSerializable({ ac: new AbortController() }) === false)
  ok('b5a BigInt 拒绝', isHermesSerializable({ n: BigInt(1) }) === false)
  ok('b5b Symbol 拒绝', isHermesSerializable({ s: Symbol('x') }) === false)
  ok('b6 undefined 字段按 JSON 语义等价缺席（不拒绝）', isHermesSerializable({ a: undefined, b: 1 }))
  {
    const withFn = { ...base, type: 'task.continue', taskId: 't1', question: '为什么', extra: () => 1 }
    ok('b7 消息 payload 含函数 → 整条消息拒绝', isMainToUtilityMessage(withFn) === false)
  }
}

// ─── c. host.request 能力校验（仅两类宿主能力）─────────────────────────────────

{
  const modelReq = {
    capability: 'model.complete' as const,
    requestId: 'r1', taskId: 't1',
    messages: [{ role: 'system' as const, content: '你是 Hermes。' }, { role: 'user' as const, content: 'goal' }],
    timeoutMs: 30_000
  }
  const toolReq = {
    capability: 'tool.execute' as const,
    requestId: 'r2', taskId: 't1', capabilityContextId: 'cap-1',
    tool: 'customer.search', arguments: { query: '李林辉' }
  }
  ok('c1 host.request model.complete 校验通过', isHermesHostRequest(modelReq) === true)
  ok('c2 host.request tool.execute 校验通过', isHermesHostRequest(toolReq) === true)
  ok('c3a 未知 capability 拒绝', isHermesHostRequest({ ...toolReq, capability: 'db.query' }) === false)
  ok('c3b model.complete 缺 messages 拒绝', isHermesHostRequest({ ...modelReq, messages: undefined }) === false)
  ok('c3c model.complete timeoutMs 非法拒绝', isHermesHostRequest({ ...modelReq, timeoutMs: 0 }) === false)
  ok('c3d tool.execute 缺 capabilityContextId 拒绝', isHermesHostRequest({ ...toolReq, capabilityContextId: '' }) === false)
  ok('c3e tool.execute arguments 含函数拒绝', isHermesHostRequest({ ...toolReq, arguments: { q: () => 1 } }) === false)
  ok('c3f tool.execute 空 tool 名拒绝', isHermesHostRequest({ ...toolReq, tool: '' }) === false)
  {
    const msg = { ...base, type: 'host.request' as const, request: modelReq }
    ok('c4 host.request 消息级校验通过（messages 为协议消息形态）', isUtilityToMainMessage(msg) === true)
  }
}

// ─── d. HermesUtilityContext 校验（上下文唯一允许形态）──────────────────────────

{
  ok('d1a global 上下文通过', isHermesUtilityContext({ kind: 'global', capabilityContextId: 'cap-0', label: '全局' }))
  ok('d1b chat 上下文通过（无真实 sessionId）', isHermesUtilityContext({ kind: 'chat', capabilityContextId: 'cap-1', label: '当前会话' }))
  ok('d1c customer 上下文（含 accountId）通过', isHermesUtilityContext(CTX))
  ok('d2a 缺 capabilityContextId 拒绝', !isHermesUtilityContext({ kind: 'chat', label: 'x' }))
  ok('d2b 空 capabilityContextId 拒绝', !isHermesUtilityContext({ kind: 'chat', capabilityContextId: '', label: 'x' }))
  ok('d2c 缺 label 拒绝', !isHermesUtilityContext({ kind: 'chat', capabilityContextId: 'c' }))
  ok('d2d 未知 kind 拒绝', !isHermesUtilityContext({ kind: 'account', capabilityContextId: 'c', label: 'x' }))
  ok('d2e accountId 非数字拒绝', !isHermesUtilityContext({ kind: 'customer', capabilityContextId: 'c', accountId: '5', label: 'x' }))
  ok('d3 上下文多带 sessionId 字段 = 携带真实会话标识 → 拒绝（协议硬边界）',
    !isHermesUtilityContext({ kind: 'chat', capabilityContextId: 'c', label: 'x', sessionId: 'wxid_abc123' }))
}

// ─── e. checkpoint 校验与脱敏 ──────────────────────────────────────────────────

{
  ok('e1a 完整 checkpoint 通过校验', isHermesCheckpoint(CHECKPOINT))
  const round = JSON.parse(JSON.stringify(CHECKPOINT)) as HermesCheckpoint
  ok('e1b checkpoint JSON 往返后校验通过（可序列化落盘/传输）', isHermesCheckpoint(round))
  ok('e2a 缺 conversation 拒绝', !isHermesCheckpoint({ ...CHECKPOINT, conversation: undefined }))
  ok('e2b 缺 evidenceByRef 拒绝', !isHermesCheckpoint({ ...CHECKPOINT, evidenceByRef: undefined }))
  ok('e2c 缺 goal 拒绝', !isHermesCheckpoint({ ...CHECKPOINT, goal: '' }))
  ok('e2d 缺 context 拒绝', !isHermesCheckpoint({ ...CHECKPOINT, context: undefined as unknown as HermesUtilityContext }))
  ok('e2e 错误 protocolVersion 拒绝', !isHermesCheckpoint({ ...CHECKPOINT, protocolVersion: 3 }))
  ok('e3 evidenceByRef 条目带 messageKey（本机路径/发送者标识出宿主）→ 硬拒绝',
    !isHermesCheckpoint({
      ...CHECKPOINT,
      evidenceByRef: { e1: { label: 'x', kind: 'chat', messageKey: 'local:C:\\db\\msg.db:wxid_a:12' } }
    }))
  ok('e4 evidenceByRef 条目 kind 非法拒绝',
    !isHermesCheckpoint({ ...CHECKPOINT, evidenceByRef: { e1: { label: 'x', kind: 'secret' } } }))

  // e5/e6 计数字段（nextEvidenceSeq/okToolCalls）必须是非负安全整数（审查修复：只查 >=0
  // 会放过 Infinity 与小数；序列化门禁拦 Infinity 但拦不住小数，独立校验器语义必须自洽）
  const ckOver = (over: Record<string, unknown>): HermesCheckpoint =>
    ({ ...CHECKPOINT, ...over }) as unknown as HermesCheckpoint
  const BAD_COUNTERS: Array<[string, unknown]> = [
    ['NaN', Number.NaN],
    ['Infinity', Infinity],
    ['-Infinity', -Infinity],
    ['负数', -1],
    ['小数', 1.5],
    ['超安全整数', Number.MAX_SAFE_INTEGER + 1],
    ['非 number（字符串）', '2'],
    ['非 number（null）', null]
  ]
  for (const [name, bad] of BAD_COUNTERS) {
    ok(`e5a nextEvidenceSeq ${name} 拒绝`, isHermesCheckpoint(ckOver({ nextEvidenceSeq: bad })) === false)
    ok(`e5b okToolCalls ${name} 拒绝`, isHermesCheckpoint(ckOver({ okToolCalls: bad })) === false)
  }
  ok('e6a 计数字段合法：0 通过', isHermesCheckpoint(ckOver({ nextEvidenceSeq: 0, okToolCalls: 0 })))
  ok('e6b 计数字段合法：正安全整数（原夹具 2/1）通过', isHermesCheckpoint(CHECKPOINT))
  ok('e6c 计数字段合法：MAX_SAFE_INTEGER 边界值通过',
    isHermesCheckpoint(ckOver({ nextEvidenceSeq: Number.MAX_SAFE_INTEGER, okToolCalls: Number.MAX_SAFE_INTEGER })))
  ok('e6d 消息级：task.checkpoint 携带小数计数字段拒绝',
    !isUtilityToMainMessage({ ...base, type: 'task.checkpoint', checkpoint: ckOver({ okToolCalls: 1.5 }) }))
}

// ─── f. 任务快照（协议形态；findings v2）──────────────────────────────────────

{
  ok('f1 协议任务快照（findings v2 + 证据列表）通过校验', isHermesProtocolTaskSnapshot(SNAPSHOT))
  ok('f2 快照 evidence 带 messageKey → 拒绝（messageKey 绝不出宿主）',
    !isHermesProtocolTaskSnapshot({
      ...SNAPSHOT,
      evidence: [{ ref: 'e1', label: 'x', kind: 'chat', messageKey: 'canonical:/Users/yang/db:wxid_a:1' }]
    }))
  ok('f3 findings 条目缺 evidenceRefs → 拒绝（发现必须可绑证据）',
    !isHermesProtocolTaskSnapshot({ ...SNAPSHOT, result: { summary: 's', findings: [{ text: 'x' }] as never, nextSteps: [] } }))
  ok('f4 非法 status 拒绝', !isHermesProtocolTaskSnapshot({ ...SNAPSHOT, status: 'queued' }))
  ok('f5 task.progress 消息缺 snapshot → 拒绝', !isUtilityToMainMessage({ ...base, type: 'task.progress', taskId: 't1' }))
}

// ─── f2. runId 任务轮次号（v2：start/continue/progress/response/checkpoint 必带）──

{
  ok('f2a task.progress 缺 runId → 拒绝', !isUtilityToMainMessage({ ...base, type: 'task.progress', taskId: 't1', snapshot: SNAPSHOT }))
  ok('f2b task.progress runId=0 → 拒绝（轮次从 1 起）',
    !isUtilityToMainMessage({ ...base, type: 'task.progress', taskId: 't1', runId: 0, snapshot: SNAPSHOT }))
  ok('f2c task.progress runId=1.5 → 拒绝',
    !isUtilityToMainMessage({ ...base, type: 'task.progress', taskId: 't1', runId: 1.5, snapshot: SNAPSHOT }))
  ok('f2d task.progress runId=安全整数上限 → 通过',
    isUtilityToMainMessage({ ...base, type: 'task.progress', taskId: 't1', runId: Number.MAX_SAFE_INTEGER, snapshot: SNAPSHOT }))
  ok('f2e task.start 缺 runId → 拒绝', !isMainToUtilityMessage({ ...base, type: 'task.start', taskId: 't1', goal: 'g', context: CTX }))
  ok('f2f task.continue 缺 runId → 拒绝', !isMainToUtilityMessage({ ...base, type: 'task.continue', taskId: 't1', question: 'q' }))
  ok('f2g task.continue runId=0 → 拒绝', !isMainToUtilityMessage({ ...base, type: 'task.continue', taskId: 't1', runId: 0, question: 'q' }))
  ok('f2h task.response 缺 runId → 拒绝',
    !isUtilityToMainMessage({ ...base, type: 'task.response', taskId: 't1', op: 'get', ok: true, snapshot: SNAPSHOT }))
  ok('f2i checkpoint 缺 runId → 拒绝', !isHermesCheckpoint({ ...CHECKPOINT, runId: undefined }))
  ok('f2j checkpoint runId=0 → 拒绝', !isHermesCheckpoint({ ...CHECKPOINT, runId: 0 }))
  ok('f2k restore 消息携带的 checkpoint 缺 runId → 拒绝',
    !isMainToUtilityMessage({ ...base, type: 'restore', checkpoint: { ...CHECKPOINT, runId: undefined } }))
}

// ─── g. 边界扫描（发送前护栏；不替代发送方脱敏）────────────────────────────────

{
  ok('g1 干净消息零 issue', findHermesBoundaryIssues(U2M['task.progress'] as object).length === 0)
  {
    const issues = findHermesBoundaryIssues({ taskId: 't1', sessionId: 'wxid_abc123def456' })
    ok('g2 sessionId 字段报 issue', issues.some((s) => s.includes('sessionId')))
  }
  {
    const issues = findHermesBoundaryIssues({ row: { session_id: '12345@chatroom' } })
    ok('g3 session_id 字段报 issue', issues.some((s) => s.includes('session_id')))
  }
  {
    const issues = findHermesBoundaryIssues({ note: '联系人 wxid_wen24wq8ojio22_92a6 说' })
    ok('g4 wxid_ 前缀号值报 issue', issues.length > 0)
  }
  {
    const issues = findHermesBoundaryIssues({ gid: '48186608819@chatroom' })
    ok('g5 @chatroom 群号值报 issue', issues.length > 0)
  }
  {
    const issues = findHermesBoundaryIssues({ ev: { messageKey: 'canonical:/Users/yang/db:wxid_a:1' } })
    ok('g6 messageKey 字段报 issue', issues.some((s) => s.includes('messageKey')))
  }
  {
    const issues = findHermesBoundaryIssues({ cfg: { apiKey: 'sk-xxx' } })
    ok('g7 apiKey 字段报 issue', issues.some((s) => s.includes('apiKey')))
  }
  ok('g8 业务名（ModelX/AgreementA）不误伤（a31 教训：自定义微信号形态不可泛化检测）',
    findHermesBoundaryIssues({ product: 'ModelX', contract: 'AgreementA', title: '叉车参数' }).length === 0)
  ok('g9 函数值报 issue', findHermesBoundaryIssues({ fn: () => 1 }).length > 0)
  ok('g10 类实例报 issue', findHermesBoundaryIssues({ ac: new AbortController() }).length > 0)
  {
    // task.progress 快照若带 messageKey：类型校验拒绝 + 扫描器双重捕获
    const leak = {
      ...base, type: 'task.progress', taskId: 't1',
      snapshot: { ...SNAPSHOT, evidence: [{ ref: 'e1', label: 'x', kind: 'chat', messageKey: 'k' }] }
    }
    ok('g11 快照泄漏 messageKey：类型校验 + 边界扫描双重捕获',
      isUtilityToMainMessage(leak) === false && findHermesBoundaryIssues(leak).some((s) => s.includes('messageKey')))
  }
}

// ─── h. 消息 id 生成 ──────────────────────────────────────────────────────────

{
  const ids = new Set(Array.from({ length: 50 }, () => createHermesMessageId()))
  ok('h1 消息 id 非空 + 前缀 hm- + 50 次生成全部唯一',
    ids.size === 50 && [...ids].every((s) => s.startsWith('hm-')))
}

// ─── i. 严格键集与 host.response 互斥语义（审查修复：入口校验硬拒绝，不靠边界扫描）──

{
  ok('i1a ping 顶层携带 messageKey → 拒绝（messageKey 绝不出宿主，入口校验即拦）',
    isMainToUtilityMessage({ ...base, type: 'ping', messageKey: 'canonical:/Users/yang/db:wxid_a:1' }) === false)
  ok('i1b fatal 顶层携带 stack → 拒绝（错误不传堆栈）',
    isUtilityToMainMessage({ ...base, type: 'fatal', code: 'internal', message: 'x', stack: 'Error: x\n at ...' }) === false)
  ok('i1c fatal 顶层携带 cause → 拒绝',
    isUtilityToMainMessage({ ...base, type: 'fatal', code: 'internal', message: 'x', cause: new Error('boom') }) === false)
  ok('i1d ping 顶层携带 apiKey → 拒绝（禁止字段经入口校验拒绝，不依赖边界扫描）',
    isMainToUtilityMessage({ ...base, type: 'ping', apiKey: 'sk-xxx' }) === false)

  ok('i2a model.complete 的 messages 条目多带 sessionId → 拒绝',
    !isUtilityToMainMessage({
      ...base, type: 'host.request',
      request: {
        capability: 'model.complete', requestId: 'r1', taskId: 't1', timeoutMs: 30_000,
        messages: [{ role: 'user', content: 'goal', sessionId: 'wxid_abc123' }]
      }
    }))
  ok('i2b 合法 messages 条目（恰 role+content）通过',
    isUtilityToMainMessage({
      ...base, type: 'host.request',
      request: {
        capability: 'model.complete', requestId: 'r1', taskId: 't1', timeoutMs: 30_000,
        messages: [{ role: 'system', content: '你是 Hermes。' }, { role: 'user', content: 'goal' }]
      }
    }))

  ok('i3a host.response.result 空对象 → 拒绝（必须过 HermesProtocolToolResult 递归校验）',
    !isMainToUtilityMessage({ ...base, type: 'host.response', requestId: 'r1', taskId: 't1', ok: true, result: {} }))
  ok('i3b host.response.result.evidence 条目携带 messageKey → 拒绝',
    !isMainToUtilityMessage({
      ...base, type: 'host.response', requestId: 'r1', taskId: 't1', ok: true,
      result: { ok: true, publicSummary: '查到 1 条', evidence: [{ ref: 'e1', label: 'x', kind: 'chat', messageKey: 'k' }] }
    }))
  ok('i3c 合法 host.response.result（在途证据无 ref，ref 由 Utility 消费时分配）通过递归校验',
    isMainToUtilityMessage({
      ...base, type: 'host.response', requestId: 'r1', taskId: 't1', ok: true,
      result: { ok: true, publicSummary: '查到 1 条', data: { rows: 1 }, evidence: [{ label: '客户档案', kind: 'customer', entityId: 5 }] }
    }))
  ok('i3d host.response.result.evidence 条目携带 ref → 拒绝（ref 是 Utility 侧登记号，不出现在工具结果）',
    !isMainToUtilityMessage({
      ...base, type: 'host.response', requestId: 'r1', taskId: 't1', ok: true,
      result: { ok: true, publicSummary: '查到 1 条', evidence: [{ ref: 'e1', label: '客户档案', kind: 'customer', entityId: 5 }] }
    }))
  ok('i3e host.response.result.evidence 携带不透明 evidenceHandle → 通过（Main 锚点回查句柄）',
    isMainToUtilityMessage({
      ...base, type: 'host.response', requestId: 'r1', taskId: 't1', ok: true,
      result: { ok: true, publicSummary: '查到 1 条', evidence: [{ label: '客户档案', kind: 'customer', entityId: 5, evidenceHandle: 'evh-abc-123' }] }
    }))
  ok('i3f evidenceHandle 为 messageKey 形态（含 ::）→ 拒绝（原始锚点不得借 handle 通道回流）',
    !isMainToUtilityMessage({
      ...base, type: 'host.response', requestId: 'r1', taskId: 't1', ok: true,
      result: { ok: true, publicSummary: '查到 1 条', evidence: [{ label: 'x', kind: 'chat', evidenceHandle: 'LOCAL::C:/db/test.db::wxid_secret001' }] }
    }))
  ok('i3g evidenceHandle 含路径分隔符 → 拒绝',
    !isMainToUtilityMessage({
      ...base, type: 'host.response', requestId: 'r1', taskId: 't1', ok: true,
      result: { ok: true, publicSummary: '查到 1 条', evidence: [{ label: 'x', kind: 'chat', evidenceHandle: 'LOCAL/db/wxid' }] }
    }))
  ok('i3h 快照证据携带 evidenceHandle → 通过（跨进程回传供 Main 恢复原始锚点）',
    isUtilityToMainMessage({
      ...base, type: 'task.progress', taskId: 't1', runId: 1,
      snapshot: { ...SNAPSHOT, evidence: [{ ref: 'e1', label: 'x', kind: 'chat', evidenceHandle: 'evh-abc-123' }] }
    }))
  ok('i3i 快照证据携带 messageKey → 仍拒绝',
    !isUtilityToMainMessage({
      ...base, type: 'task.progress', taskId: 't1',
      snapshot: { ...SNAPSHOT, evidence: [{ ref: 'e1', label: 'x', kind: 'chat', messageKey: 'LOCAL::C:/db::wxid' }] }
    }))
  ok('i3j checkpoint 证据携带 evidenceHandle → 拒绝（checkpoint 永不携带 handle，锚点只存 Main）',
    !isUtilityToMainMessage({
      ...base, type: 'task.checkpoint',
      checkpoint: { ...CHECKPOINT, evidenceByRef: { ...CHECKPOINT.evidenceByRef, e1: { ...CHECKPOINT.evidenceByRef.e1!, evidenceHandle: 'evh-abc-123' } } }
    }))
  ok('i3k evidenceHandle 非 evh- 前缀任意字符串 → 拒绝（v2 格式收紧 /^evh-[a-z0-9-]+$/）',
    !isMainToUtilityMessage({
      ...base, type: 'host.response', requestId: 'r1', taskId: 't1', ok: true,
      result: { ok: true, publicSummary: '查到 1 条', evidence: [{ label: 'x', kind: 'chat', evidenceHandle: 'opaque-handle-123' }] }
    }))
  ok('i3l evidenceHandle 含大写/下划线 → 拒绝',
    !isMainToUtilityMessage({
      ...base, type: 'host.response', requestId: 'r1', taskId: 't1', ok: true,
      result: { ok: true, publicSummary: '查到 1 条', evidence: [{ label: 'x', kind: 'chat', evidenceHandle: 'evh-Abc_123' }] }
    }))

  ok('i4a ok=true 同时携带 text 和 result → 拒绝（恰存在一个）',
    !isMainToUtilityMessage({ ...base, type: 'host.response', requestId: 'r1', taskId: 't1', ok: true, text: '模型输出', result: { ok: true, publicSummary: 'x' } }))
  ok('i4b ok=true 携带 error → 拒绝',
    !isMainToUtilityMessage({ ...base, type: 'host.response', requestId: 'r1', taskId: 't1', ok: true, text: '模型输出', error: { code: 'internal', message: 'x' } }))
  ok('i4c ok=false 仍携带 text → 拒绝',
    !isMainToUtilityMessage({ ...base, type: 'host.response', requestId: 'r1', taskId: 't1', ok: false, text: '模型输出', error: { code: 'internal', message: 'x' } }))
  ok('i4d ok=false 仍携带 result → 拒绝',
    !isMainToUtilityMessage({ ...base, type: 'host.response', requestId: 'r1', taskId: 't1', ok: false, result: { ok: true, publicSummary: 'x' }, error: { code: 'internal', message: 'x' } }))
  ok('i4e ok=false 缺 error → 拒绝',
    !isMainToUtilityMessage({ ...base, type: 'host.response', requestId: 'r1', taskId: 't1', ok: false }))
  ok('i4f ok=false error 携带 stack → 拒绝（错误对象只能 code+message）',
    !isMainToUtilityMessage({ ...base, type: 'host.response', requestId: 'r1', taskId: 't1', ok: false, error: { code: 'internal', message: 'x', stack: 'Error: x' } }))
  ok('i4g ok=false error 携带 cause → 拒绝',
    !isMainToUtilityMessage({ ...base, type: 'host.response', requestId: 'r1', taskId: 't1', ok: false, error: { code: 'internal', message: 'x', cause: 'raw error' } }))

  ok('i5a 合法 host.response 分支一：ok=true + text 通过',
    isMainToUtilityMessage({ ...base, type: 'host.response', requestId: 'r1', taskId: 't1', ok: true, text: '{"type":"complete"}' }))
  ok('i5b 合法 host.response 分支二：ok=true + result 通过',
    isMainToUtilityMessage({ ...base, type: 'host.response', requestId: 'r1', taskId: 't1', ok: true, result: { ok: true, publicSummary: '查到 1 条' } }))
  ok('i5c 合法 host.response 分支三：ok=false + error 通过',
    isMainToUtilityMessage({ ...base, type: 'host.response', requestId: 'r1', taskId: 't1', ok: false, error: { code: 'timeout', message: '这次查询用时太长。' } }))

  ok('i6a HermesProtocolError 恰 code+message 通过',
    isHermesProtocolError({ code: 'internal', message: '暂时无法查询，请重试。' }))
  ok('i6b HermesProtocolError 多余字段（stack）拒绝',
    !isHermesProtocolError({ code: 'internal', message: 'x', stack: 'Error: x' }))
  ok('i6c HermesProtocolError 缺 message 拒绝',
    !isHermesProtocolError({ code: 'internal' }))

  // 全分支锁：16 类消息顶层出现任何未声明字段一律拒绝（含禁止字段形态）
  for (const type of M2U_TYPES) {
    ok(`i7a Main→Utility ${type} 顶层未声明字段拒绝`, isMainToUtilityMessage({ ...M2U[type], probeExtra: 1 }) === false)
  }
  for (const type of U2M_TYPES) {
    ok(`i7b Utility→Main ${type} 顶层未声明字段拒绝`, isUtilityToMainMessage({ ...U2M[type], probeExtra: 1 }) === false)
  }

  ok('i8 业务名（ModelX/AgreementA）不受严格键集影响（只限字段形态，不扫合法业务值）',
    isMainToUtilityMessage({
      ...base, type: 'host.response', requestId: 'r1', taskId: 't1', ok: true,
      result: { ok: true, publicSummary: 'ModelX 报价在 AgreementA 比价阶段' }
    }))
}

// ─── j. isHermesSerializable JSON 等价（审查修复：NaN/Infinity/undefined 位置语义）──

{
  ok('j1a NaN 拒绝（JSON.stringify 变 null）', isHermesSerializable(NaN) === false)
  ok('j1b Infinity 拒绝', isHermesSerializable(Infinity) === false)
  ok('j1c -Infinity 拒绝', isHermesSerializable(-Infinity) === false)
  ok('j1d 有限数字通过（0/负数/小数）', isHermesSerializable(0) && isHermesSerializable(-3.5) && isHermesSerializable(1e9))
  ok('j1e 嵌套对象里的 NaN 拒绝', isHermesSerializable({ a: { b: Number.NaN } }) === false)

  ok('j2a 顶层 undefined 拒绝', isHermesSerializable(undefined) === false)
  ok('j2b 数组元素 undefined 拒绝（JSON 往返变 null）', isHermesSerializable([1, undefined, 'x']) === false)
  ok('j2c 对象字段 undefined 仍按缺席处理（b6 语义不变）',
    isHermesSerializable({ a: undefined, b: { c: undefined, d: 1 } }))
  ok('j2d 数组元素 null 通过（null 是合法 JSON 值）', isHermesSerializable([null, 'x', 0]))

  ok('j3 循环引用拒绝（防栈溢出）', (() => {
    const cyc: Record<string, unknown> = { a: 1 }
    cyc.self = cyc
    return isHermesSerializable(cyc) === false
  })())
  ok('j4 嵌套超深（>32 层）拒绝', (() => {
    let deep: unknown = 1
    for (let i = 0; i < 40; i++) deep = { v: deep }
    return isHermesSerializable(deep) === false
  })())
  ok('j5 函数/Symbol/BigInt/Error/类实例仍拒绝',
    isHermesSerializable({ fn: () => 1 }) === false && isHermesSerializable({ s: Symbol('x') }) === false &&
    isHermesSerializable({ n: BigInt(1) }) === false && isHermesSerializable({ e: new Error('x') }) === false &&
    isHermesSerializable({ o: new AbortController() }) === false)
}

// ─── k. 嵌套协议对象严格键集（审查修复 P1：checkpoint/snapshot/steps/result/findings）──

{
  ok('k1a checkpoint 顶层多 messageKey → 校验器直接拒绝',
    isHermesCheckpoint({ ...CHECKPOINT, messageKey: 'canonical:/Users/yang/db:wxid_a:1' }) === false)
  ok('k1b restore.checkpoint 顶层多 messageKey → 消息入口拒绝',
    isMainToUtilityMessage({ ...base, type: 'restore', checkpoint: { ...CHECKPOINT, messageKey: 'canonical:/Users/yang/db:wxid_a:1' } }) === false)
  ok('k1c task.checkpoint.checkpoint 顶层多 probeExtra → 消息入口拒绝',
    isUtilityToMainMessage({ ...base, type: 'task.checkpoint', checkpoint: { ...CHECKPOINT, probeExtra: 1 } }) === false)

  ok('k2a snapshot 顶层多 messageKey → 校验器直接拒绝',
    isHermesProtocolTaskSnapshot({ ...SNAPSHOT, messageKey: 'canonical:/Users/yang/db:wxid_a:1' }) === false)
  ok('k2b task.progress.snapshot 顶层多 messageKey → 消息入口拒绝',
    !isUtilityToMainMessage({ ...base, type: 'task.progress', taskId: 't1', snapshot: { ...SNAPSHOT, messageKey: 'k' } }))
  ok('k2c task.response.snapshot 顶层多 probeExtra → 消息入口拒绝',
    !isUtilityToMainMessage({ ...base, type: 'task.response', taskId: 't1', op: 'get', ok: true, snapshot: { ...SNAPSHOT, probeExtra: 1 } }))

  ok('k3a steps[] 条目多 sessionId → 校验器直接拒绝',
    isHermesProtocolTaskSnapshot({ ...SNAPSHOT, steps: [{ label: 'x', status: 'done', sessionId: 'wxid_abc123' }] }) === false)
  ok('k3b task.progress.snapshot.steps[] 多 sessionId → 消息入口拒绝',
    !isUtilityToMainMessage({
      ...base, type: 'task.progress', taskId: 't1',
      snapshot: { ...SNAPSHOT, steps: [...SNAPSHOT.steps, { label: 'x', status: 'done', sessionId: 'wxid_abc123' }] }
    }))
  ok('k3c steps[] 条目多 probeExtra → 校验器直接拒绝',
    isHermesProtocolTaskSnapshot({ ...SNAPSHOT, steps: [{ label: 'x', status: 'done', probeExtra: 1 }] }) === false)

  ok('k4a task.response.snapshot.result 多 messageKey → 消息入口拒绝',
    !isUtilityToMainMessage({
      ...base, type: 'task.response', taskId: 't1', op: 'get', ok: true,
      snapshot: { ...SNAPSHOT, result: { ...SNAPSHOT.result!, messageKey: 'k' } }
    }))
  ok('k4b snapshot.result 多 probeExtra → 校验器直接拒绝',
    isHermesProtocolTaskSnapshot({ ...SNAPSHOT, result: { ...SNAPSHOT.result!, probeExtra: 1 } }) === false)

  ok('k5a task.response.snapshot.result.findings[] 多 messageKey → 消息入口拒绝',
    !isUtilityToMainMessage({
      ...base, type: 'task.response', taskId: 't1', op: 'get', ok: true,
      snapshot: { ...SNAPSHOT, result: { ...SNAPSHOT.result!, findings: [{ text: 'x', evidenceRefs: ['e1'], messageKey: 'k' }] } }
    }))
  ok('k5b result.findings[] 多 probeExtra → 校验器直接拒绝',
    isHermesProtocolTaskSnapshot({ ...SNAPSHOT, result: { ...SNAPSHOT.result!, findings: [{ text: 'x', evidenceRefs: ['e1'], probeExtra: 1 }] } }) === false)

  // ── 合法行为锁定（严格键集不得改变可选性与既有语义）─────────────────────────
  ok('k6a 完整合法 checkpoint 仍通过（校验器 + restore / task.checkpoint 消息）',
    isHermesCheckpoint(CHECKPOINT)
    && isMainToUtilityMessage({ ...base, type: 'restore', checkpoint: CHECKPOINT })
    && isUtilityToMainMessage({ ...base, type: 'task.checkpoint', checkpoint: CHECKPOINT }))
  const MIN = { taskId: 't1', goal: '分析李林辉', contextLabel: '全局', steps: [], evidence: [], createdAt: 1_700_000_000_000 }
  for (const st of ['planning', 'running', 'completed', 'failed', 'cancelled'] as const) {
    ok(`k6b 合法 ${st} snapshot 仍通过`, isHermesProtocolTaskSnapshot({ ...MIN, status: st }))
  }
  ok('k6c step 可选字段缺席/存在均合法（tool/publicSummary 可选性不变）',
    isHermesProtocolTaskSnapshot({ ...MIN, status: 'running', steps: [{ label: '执行查询', status: 'error' }] })
    && isHermesProtocolTaskSnapshot({
      ...MIN, status: 'running',
      steps: [{ label: '调用客户搜索', status: 'done', tool: 'customer.search', publicSummary: '找到 1 个客户。' }]
    }))
  ok('k6d result/findings 合法结构仍通过',
    isHermesProtocolTaskSnapshot({
      ...MIN, status: 'completed',
      result: { summary: '结论', findings: [{ text: '发现一', evidenceRefs: [] }], nextSteps: ['建议一'] }
    }))
}

console.log(`\nhermes-protocol-test: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
