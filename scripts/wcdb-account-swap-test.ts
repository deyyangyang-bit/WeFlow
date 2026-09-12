/**
 * wcdb-account-swap-test.ts —— 跨账号 WCDB 原子轮换 + worker 串行门并发回归（2026-09-09）
 *
 * 修复背景：旧 getContactsForAccount 在 ChatService 局部队列里做多步轮换
 * （getConnectionState → open → getContactsCompact → open/close），worker 消息 handler 是
 * 并发 async——普通联系人/会话查询可插入切换窗口，读到目标账号的临时连接或撞上已关闭连接。
 * 修复后：
 *   - wcdbCore.readContactsForAccount：整段轮换在单次调用内原子完成（快照→开→读→恢复/关闭）；
 *   - wcdbWorker：所有消息经 FIFO 串行门执行，轮换期间不可能插入任何其他请求；
 *   - chatService.getContactsForAccount：单次消息调用，保持当前账号快速路径与返回类型。
 *
 * 覆盖：
 *   A. wcdbCore 编排（patch 内部 open/close/getContactsCompact，免 DLL）：恢复/关闭/各失败阶段
 *   B. worker 路由并发回归（fake core + 真实 handleWcdbWorkerMessage + 串行门）：
 *      跨账号轮换与普通查询并发时，普通查询只能看到原账号连接，绝不读目标账号、无连接竞态错误
 *
 * 运行：npx tsx scripts/wcdb-account-swap-test.ts
 */
process.env.WEFLOW_WORKER = '1'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; console.log(`  ✅ ${name}`) } else { fail++; console.log(`  ❌ ${name} ${detail}`) }
}
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

import { WcdbCore } from '../electron/services/wcdbCore'
import { handleWcdbWorkerMessage } from '../electron/wcdbWorker'
import { createSerialTaskGate } from '../electron/services/serialTaskGate'

const ORIG = '/data/orig-account'
const TARGET = '/data/target-account'
const KEY = 'hex-key'

interface SwapLogEntry { step: string; current: string | null }
function makeFakeCore(opts: { openResults?: boolean[]; compactFail?: boolean; closeThrows?: boolean; restoreFails?: boolean } = {}) {
  /** fake 连接状态：open/close 变更，执行记录带当时的 current（供并发断言） */
  const state = { current: ORIG as string | null, connected: true, key: 'orig-key' }
  const log: SwapLogEntry[] = []
  let openCalls = 0
  let closeCalls = 0
  const core: any = { swapInFlight: false,
    // —— 供 readContactsForAccount 编排调用的原语（模拟 wcdbCore 真实语义）——
    getConnectionState: () => ({ connected: state.connected, accountDir: state.current, wxid: state.current === ORIG ? 'orig' : state.current === TARGET ? 'target' : null }),
    async open(dir: string, _key: string) {
      openCalls++
      await delay(15) // 拉宽窗口：若没有串行门，并发请求必然插进此窗口
      if (opts.openResults && opts.openResults[openCalls - 1] === false) return false
      state.current = dir
      state.connected = true
      state.key = `key-${dir}`
      log.push({ step: `open:${dir}`, current: state.current })
      return true
    },
    close() {
      closeCalls++
      if (opts.closeThrows) throw new Error('注入式 close 失败')
      state.current = null
      state.connected = false
      log.push({ step: 'close', current: null })
    },
    async getContactsCompact() {
      const inSwap = core.swapInFlight === true
      log.push({ step: inSwap ? 'compact(swap)' : 'compact', current: state.current })
      await delay(10)
      if (opts.compactFail) return { success: false, error: '注入式读取失败' }
      if (!state.connected || state.current === null) return { success: false, error: 'WCDB 未连接（竞态证据）' }
      return { success: true, contacts: [{ username: `user@${state.current}` }] }
    },
    async getSessions() {
      log.push({ step: 'sessions', current: state.current })
      await delay(5)
      if (!state.connected || state.current === null) return { success: false, error: 'WCDB 未连接（竞态证据）' }
      return { success: true, sessions: [{ current: state.current }] }
    },
    // —— 跨账号原子轮换（与 wcdbCore.readContactsForAccount 同一编排契约）——
    async readContactsForAccount(accountDir: string, hexKey: string) {
      this.swapInFlight = true
      try {
      return await this._readInner(accountDir, hexKey)
      } finally { this.swapInFlight = false }
    },
    async _readInner(accountDir: string, hexKey: string) {
      const previous = this.getConnectionState()
      const hadPrevious = previous.connected === true
      const prevDir = previous.accountDir
      const prevKey = state.key
      const cleanup = async () => {
        if (hadPrevious && prevDir) { try { await this.open(prevDir, prevKey) } catch { /* 如实反映终态 */ } }
        else if (!hadPrevious) { try { this.close() } catch { /* 如实反映终态 */ } }
      }
      let opened: boolean
      try { opened = await this.open(accountDir, hexKey) } catch (e) { return { success: false, error: `open 失败: ${String(e)}`, stage: 'open', connectionState: this.getConnectionState() } }
      if (!opened) {
        if (hadPrevious && prevDir) { try { await this.open(prevDir, prevKey) } catch { /* 如实反映终态 */ } }
        return { success: false, error: 'open 失败（目标账号目录不可打开）', stage: 'open', connectionState: this.getConnectionState() }
      }
      let contacts: any[]
      try {
        const compact = await this.getContactsCompact() // swap 内读取：core.getContactsCompact 打 swap 标签
        if (!compact.success) { await cleanup(); return { success: false, error: `read 失败: ${compact.error || ''}`, stage: 'read', connectionState: this.getConnectionState() } }
        contacts = compact.contacts
      } catch (e) { await cleanup(); return { success: false, error: `read 失败: ${String(e)}`, stage: 'read', connectionState: this.getConnectionState() } }
      if (hadPrevious) {
        if (opts.restoreFails || !prevDir) return { success: false, error: 'restore 失败', stage: 'restore', contacts, connectionState: this.getConnectionState() }
        try {
          const restored = await this.open(prevDir, prevKey)
          if (!restored) return { success: false, error: 'restore 失败（重开返回失败）', stage: 'restore', contacts, connectionState: this.getConnectionState() }
        } catch (e) { return { success: false, error: `restore 失败: ${String(e)}`, stage: 'restore', contacts, connectionState: this.getConnectionState() } }
        return { success: true, contacts, connectionState: this.getConnectionState() }
      }
      try { this.close() } catch (e) { return { success: false, error: `close 失败: ${String(e)}`, stage: 'close', contacts, connectionState: this.getConnectionState() } }
      return { success: true, contacts, connectionState: this.getConnectionState() }
    }
  }
  return { core, state, log, counters: { get openCalls() { return openCalls }, get closeCalls() { return closeCalls } } }
}

async function main(): Promise<void> {
  console.log('═══ A. wcdbCore.readContactsForAccount 编排（patch 内部原语，免 DLL）═══')
  {
    const core: any = new WcdbCore()
    const calls: string[] = []
    // 注入内部原语：不做任何真实 IO
    core.getConnectionState = () => ({ connected: (core as any).__connected === true, accountDir: (core as any).__dir ?? null, wxid: null })
    ;(core as any).__dir = ORIG
    ;(core as any).__connected = true
    ;(core as any).currentKey = 'orig-key'
    core.open = async (dir: string) => { calls.push(`open:${dir}`); (core as any).__dir = dir; (core as any).__connected = true; return true }
    core.close = () => { calls.push('close'); (core as any).__dir = null; (core as any).__connected = false }
    core.getContactsCompact = async () => { calls.push('compact'); return { success: true, contacts: [{ username: 'u1' }] } }

    const r1 = await core.readContactsForAccount(TARGET, KEY)
    ok('A1 有原连接：开目标→读→恢复原账号，联系人返回、终态为原账号',
      r1.success && r1.contacts?.length === 1 && calls.join('|') === `open:${TARGET}|compact|open:${ORIG}` &&
      r1.connectionState.accountDir === ORIG, JSON.stringify({ r1, calls }))

    ;(core as any).__connected = false
    ;(core as any).__dir = null
    calls.length = 0
    const r2 = await core.readContactsForAccount(TARGET, KEY)
    ok('A2 无原连接：开目标→读→关闭临时连接（close 落地）',
      r2.success && calls.join('|') === `open:${TARGET}|compact|close` && r2.connectionState.connected === false, JSON.stringify({ r2, calls }))

    calls.length = 0
    core.open = async (dir: string) => { calls.push(`open:${dir}`); if (dir === TARGET) return false; (core as any).__dir = dir; (core as any).__connected = true; return true }
    ;(core as any).__connected = true
    ;(core as any).__dir = ORIG
    const r3 = await core.readContactsForAccount(TARGET, KEY)
    ok('A3 目标打开失败：返回 stage=open 明确错误，且尽力恢复原账号',
      !r3.success && r3.stage === 'open' && calls.join('|') === `open:${TARGET}|open:${ORIG}` &&
      r3.connectionState.accountDir === ORIG, JSON.stringify({ r3, calls }))

    calls.length = 0
    core.open = async (dir: string) => { calls.push(`open:${dir}`); (core as any).__dir = dir; (core as any).__connected = true; return true }
    core.getContactsCompact = async () => ({ success: false, error: '注入式读取失败' })
    ;(core as any).__connected = true
    ;(core as any).__dir = ORIG
    const r4 = await core.readContactsForAccount(TARGET, KEY)
    ok('A4 读取失败：返回 stage=read 明确错误，仍恢复原账号（能执行的清理必须执行）',
      !r4.success && r4.stage === 'read' && r4.error?.includes('注入式读取失败') === true &&
      calls.filter((c) => c === `open:${ORIG}`).length === 1 && r4.connectionState.accountDir === ORIG, JSON.stringify({ r4, calls }))
    // 恢复 compact 桩（A5/A6 需要读取成功才能走到 restore/close 阶段）
    core.getContactsCompact = async () => { calls.push('compact'); return { success: true, contacts: [{ username: 'u1' }] } }

    ;(core as any).__connected = true
    ;(core as any).__dir = ORIG
    ;(core as any).currentKey = null // 原连接缺密钥快照 → 无法恢复
    const r5 = await core.readContactsForAccount(TARGET, KEY)
    ok('A5 原连接缺密钥快照：stage=restore 明确错误（不冒充完全成功）',
      !r5.success && r5.stage === 'restore' && !!r5.contacts, JSON.stringify({ r5 }))

    ;(core as any).__connected = false
    ;(core as any).__dir = null
    ;(core as any).currentKey = null
    core.close = () => { throw new Error('注入式 close 失败') }
    const r6 = await core.readContactsForAccount(TARGET, KEY)
    ok('A6 关闭临时连接失败：stage=close 明确错误（contacts 保留供排障）',
      !r6.success && r6.stage === 'close' && r6.error?.includes('close 失败') === true && !!r6.contacts, JSON.stringify({ r6 }))

    // 目标 open 已破坏原连接，且恢复原账号也返回 false：必须暴露 restore，而不是仍报 open/read
    core.close = () => { calls.push('close'); (core as any).__dir = null; (core as any).__connected = false }
    ;(core as any).__connected = true
    ;(core as any).__dir = ORIG
    ;(core as any).currentKey = 'orig-key'
    calls.length = 0
    core.open = async (dir: string) => {
      calls.push(`open:${dir}`)
      ;(core as any).__dir = null
      ;(core as any).__connected = false
      return false
    }
    const r7 = await core.readContactsForAccount(TARGET, KEY)
    ok('A7 目标打开失败且恢复也失败：以 stage=restore 暴露真实清理失败与断连终态',
      !r7.success && r7.stage === 'restore' && r7.connectionState.connected === false &&
      calls.join('|') === `open:${TARGET}|open:${ORIG}`, JSON.stringify({ r7, calls }))

    ;(core as any).__connected = true
    ;(core as any).__dir = ORIG
    ;(core as any).currentKey = 'orig-key'
    calls.length = 0
    core.open = async (dir: string) => {
      calls.push(`open:${dir}`)
      if (dir === ORIG) {
        ;(core as any).__dir = null
        ;(core as any).__connected = false
        return false
      }
      ;(core as any).__dir = dir
      ;(core as any).__connected = true
      return true
    }
    core.getContactsCompact = async () => ({ success: false, error: '注入式读取失败' })
    const r8 = await core.readContactsForAccount(TARGET, KEY)
    ok('A8 读取失败且恢复也失败：清理失败优先返回 stage=restore',
      !r8.success && r8.stage === 'restore' && r8.connectionState.connected === false,
      JSON.stringify({ r8, calls }))
  }

  console.log('\n═══ B. worker 路由并发回归（串行门 + 原子轮换消息）═══')
  {
    // 真实 handleWcdbWorkerMessage + fake core：模拟「轮换与普通查询并发」
    const { core, log, state } = makeFakeCore()
    const responses = new Map<number, any>()
    let nextId = 1
    const post = (m: { id: number; result?: unknown; error?: string }) => { responses.set(m.id, (m as any).error ? { error: (m as any).error } : m.result) }
    const send = (type: string, payload: Record<string, unknown> = {}) => {
      const id = nextId++
      handleWcdbWorkerMessage(core, { id, type, payload } as never, post)
      return id
    }

    // 时序：先一条普通查询（轮换前）→ 再提交轮换 + 并发塞入多条普通查询（若无串行门必插窗口）
    const id0 = send('getSessions')
    await delay(5)
    const idSwap = send('readContactsForAccount', { accountDir: TARGET, hexKey: KEY })
    const normalIds = [send('getContactsCompact'), send('getSessions'), send('getContactsCompact')]
    await delay(80) // 等全部消息完成（串行门 FIFO）
    const r0 = responses.get(id0) as any
    const rSwap = responses.get(idSwap) as any
    const normals = normalIds.map((id) => responses.get(id) as any)

    const sessionSteps = log.filter((l) => l.step === 'sessions')
    const compactSteps = log.filter((l) => l.step === 'compact')
    const swapOpenIdx = log.findIndex((l) => l.step === `open:${TARGET}`)
    const restoreIdx = log.findIndex((l) => l.step === `open:${ORIG}` && l !== log[swapOpenIdx] && log.indexOf(l) > swapOpenIdx)
    ok('B1 轮换结果成功：读到目标账号联系人，连接恢复原账号',
      rSwap?.success === true && String(rSwap?.contacts?.[0]?.username).includes('target-account') &&
      rSwap?.connectionState?.accountDir === ORIG, JSON.stringify({ rSwap, log: log.map((l) => l.step) }))
    const swapCompact = log.filter((l) => l.step === 'compact(swap)')
    ok('B2 普通查询只能读取原账号：swap 外的 compact/sessions 恒在原账号连接上（swap 内读取=正向控制，在目标账号）',
      compactSteps.every((l) => l.current === ORIG) && sessionSteps.every((l) => l.current === ORIG) &&
      swapCompact.every((l) => l.current === TARGET),
      JSON.stringify(log))
    ok('B3 普通查询零竞态错误（无「未连接」）',
      normals.every((r) => r && !r.error) && r0 && !r0.error, JSON.stringify(normals))
    ok('B4 串行门时序：普通查询要么在轮换前完成、要么在恢复后执行，绝无窗口内插入',
      restoreIdx > swapOpenIdx && log.slice(swapOpenIdx, restoreIdx + 1).every((l) => l.step.startsWith('open:') || l.step === 'compact' || l.step === 'close' ? !l.step.startsWith('sessions') : true) &&
      log.filter((l) => l.step === 'sessions').every((l) => log.indexOf(l) < swapOpenIdx || log.indexOf(l) > restoreIdx),
      JSON.stringify(log.map((l) => l.step)))
    void state
  }

  console.log('\n═══ C. 串行门单元：FIFO + 异常不堵队 ═══')
  {
    const gate = createSerialTaskGate()
    const order: string[] = []
    const t1 = gate.run(async () => { await delay(30); order.push('a') })
    const t2 = gate.run(async () => { order.push('b'); throw new Error('注入失败') })
    const t3 = gate.run(async () => { order.push('c') })
    await Promise.allSettled([t1, t2, t3])
    ok('C1 FIFO 顺序执行、异常不阻塞后续任务', order.join(',') === 'a,b,c', order.join(','))
    const gate2 = createSerialTaskGate()
    let sawBusy = false
    const p = gate2.run(async () => { await delay(20); sawBusy = gate2.busy })
    await p
    ok('C2 busy 标志在任务执行期为 true', sawBusy === true)
    ok('C3 任务完成后 busy=false', gate2.busy === false)
  }

  console.log(`\n═══ 结果：${pass} 通过 / ${fail} 失败 ═══`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error('测试崩溃:', e); process.exit(1) })
