/**
 * annual-review-error-boundary-test.ts —— 年度经营复盘错误返回边界护栏
 *
 * 背景（2026-09-22 安全收口）：年度复盘错误链上存在原始异常消息透传面——
 *   ① Worker 捕获 compose 异常后把 `e.message` 拼进对外错误（annualReviewWorker.ts catch）；
 *   ② Service 终态收敛把底层异常消息透传进任务快照（annualReviewService runTask catch）；
 *   ③ main.ts 的 `annualReview:getAvailableYears` / `annualReview:export` catch 把
 *      `e.message` 原样返回渲染层。
 * 该通道在生产中承载 sql.js/原生层异常（数据库路径、SQL 片段）以及任意底层
 * Error.message——一旦泄露即把本机路径/SQL/凭据标记暴露给渲染层与页面文案。
 *
 * 反例方式：让 Worker / 假 runner / 源码边界分别携带
 * 「数据库路径 + SQL + Token 标记」的异常消息，证明修复前会透传、修复后只返回
 * 白名单内的固定中文文案。取消（cancelled）、失效（invalidated）、加载失败
 * （fact_load_failed）与正常导出语义不受影响（回归断言保留原固定文案）。
 *
 * 运行：npx tsx scripts/annual-review-error-boundary-test.ts
 */
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { Worker } from 'worker_threads'
import {
  AnnualReviewService,
  type AnnualReviewWorkerPayload,
  type AnnualReviewWorkerRunner,
  type AnnualReviewProgressEvent,
  type AnnualReviewAccountContext
} from '../electron/services/annualReviewService'
import type { AnnualReviewFacts } from '../electron/services/annualReviewStats'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const GEN = new Date(2026, 5, 15, 12, 0, 0).getTime()
const tick = (): Promise<void> => new Promise((r) => setImmediate(r))

let pass = 0
let fail = 0
function ok(name: string, cond: boolean, detail?: string): void {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.error(`FAIL ${name}${detail ? `\n  ${detail}` : ''}`) }
}

/** 反例标记：数据库路径 + SQL + Token（假值，仅用于检测透传） */
const LEAK_MARKERS = "SQLITE_ERROR: select * from message where session_id='wxid_leak' -- /Users/yang/Library/Application Support/weflow/weflow-crm-leak.db (token=sk-LEAKTEST)"
const MARKER_SCAN = [/SQLITE_ERROR/, /select \* from message/, /\/Users\//, /weflow-crm-leak\.db/, /sk-LEAKTEST/]
const containsLeakMarkers = (s: string): boolean => MARKER_SCAN.some((re) => re.test(s))

/** 修复后的对外固定文案（与实现中的常量保持一致） */
const WORKER_FAILURE_COPY = '年度复盘统计失败，请稍后重试'
const GENERIC_FAILURE_COPY = '年度复盘生成失败，请稍后重试'
const INVALIDATED_COPY = '数据已失效（账号/业务库变更或数据写入），本次生成已终止'

const emptyFacts = (): AnnualReviewFacts => ({ accounts: [], contracts: [], allocations: [], shippedEvents: [] })
const emptySales = (): { profiles: []; intentEvents: [] } => ({ profiles: [], intentEvents: [] })
const emptyCrm = (): { opportunities: []; opportunityEvents: [] } => ({ opportunities: [], opportunityEvents: [] })

const fixedCtx = (): AnnualReviewAccountContext => ({
  wxid: 'wx_account_a',
  salesDbName: 'weflow-sales-wx_account_a.db',
  crmDbName: 'weflow-crm-wx_account_a.db',
  exclusions: { manualSessions: [], internalSessions: [] }
})

/** 可手工 reject 的假 runner */
function deferredRunner(): { runner: AnnualReviewWorkerRunner; reject: (e: unknown) => void } {
  let rej: ((e: unknown) => void) | null = null
  const runner: AnnualReviewWorkerRunner = {
    run: () => new Promise((_res, reject) => { rej = reject }),
    cancel: (taskId) => { void taskId; rej?.(Object.assign(new Error('已取消'), { code: 'cancelled' })) }
  }
  return { runner, reject: (e: unknown) => rej?.(e) }
}

async function main(): Promise<void> {
  // ══ 1 真实 Worker 反例：compose 抛出含标记的异常 → 对外 message 不得携带标记 ══
  // 注入点：assertPeriodInputs 对非数字 year 抛 `非法的年份：${String(year)}`，
  // 旧 Worker catch 会把它拼成 `年度复盘统计失败：${e.message}` 原样广播。
  {
    const payload = {
      taskId: 'err-boundary-worker-1',
      reportSchemaVersion: 2,
      period: { year: LEAK_MARKERS, generatedAt: GEN, asOf: GEN, periodStart: null, periodEndExclusive: null },
      facts: emptyFacts(),
      sales: emptySales(),
      crm: emptyCrm(),
      messageStats: { ok: true, sessions: {} },
      exclusions: { manualSessions: [], internalSessions: [] }
    } as unknown as AnnualReviewWorkerPayload
    const posted = await new Promise<{ code?: string; message?: string }>((resolve, reject) => {
      const w = new Worker(join(ROOT, 'electron', 'annualReviewWorker.ts'), {
        workerData: payload,
        execArgv: ['--import', 'tsx']
      })
      w.on('message', (m) => {
        const err = (m as { type?: string; error?: { code?: string; message?: string } }).error
        if ((m as { type?: string }).type === 'annualReview:error' && err) {
          void w.terminate()
          resolve(err)
        }
      })
      w.on('error', reject)
      w.on('exit', (code) => reject(new Error(`worker exit ${code} without error`)))
      setTimeout(() => { void w.terminate(); reject(new Error('worker timeout')) }, 20000)
    })
    ok('1 Worker 统计异常 → 对外固定文案（不透传 e.message）',
      posted.code === 'worker_error' && posted.message === WORKER_FAILURE_COPY,
      `actual: ${JSON.stringify(posted)}`)
    ok('1b Worker 对外消息不含 数据库路径/SQL/Token 标记',
      typeof posted.message === 'string' && !containsLeakMarkers(posted.message),
      `actual: ${JSON.stringify(posted.message)}`)
  }

  // ══ 2 Service 任务状态反例：runner 携带标记的异常 → 快照/进度事件不得携带标记 ══
  {
    const { runner, reject } = deferredRunner()
    const service = new AnnualReviewService({
      loadFacts: async () => emptyFacts(),
      loadSalesSegments: async () => emptySales(),
      loadCrmSegments: async () => emptyCrm(),
      loadMessageStats: async () => ({ ok: true, sessions: {} }),
      getAccountContext: fixedCtx,
      runner
    })
    const events: AnnualReviewProgressEvent[] = []
    service.onProgress((e) => events.push(e))
    const done = service.generate(2026)
    await tick()
    const taskId = service.getTaskState(2026)?.taskId ?? ''
    reject(Object.assign(new Error(LEAK_MARKERS), { code: 'worker_error' }))
    await done
    const status = service.getTaskStatus(taskId)
    ok('2 runner 携带标记异常 → 任务快照错误文案为固定值（不透传）',
      status.success === true && status.found === true && status.task?.error?.code === 'worker_error' &&
      status.task?.error?.message === GENERIC_FAILURE_COPY,
      `actual: ${JSON.stringify(status.task?.error)}`)
    ok('2b getTaskStatus 全量响应不含标记',
      !containsLeakMarkers(JSON.stringify(status)))
    ok('2c progress 事件流不含标记（页面经此渲染失败文案）',
      events.every((e) => !containsLeakMarkers(e.error?.message ?? '')),
      `last error: ${JSON.stringify(events[events.length - 1]?.error)}`)
  }

  // ══ 3 main.ts / Worker / Service 源码反例：边界不得回传 e.message ══
  {
    const mainSrc = readFileSync(join(ROOT, 'electron', 'main.ts'), 'utf8')
    const carve = (channel: string): string => {
      const start = mainSrc.indexOf(`ipcMain.handle('${channel}'`)
      if (start < 0) return ''
      const end = mainSrc.indexOf('ipcMain.handle(', start + 10)
      return mainSrc.slice(start, end)
    }
    const yearsBlock = carve('annualReview:getAvailableYears')
    const exportBlock = carve('annualReview:export')
    const generateBlock = carve('annualReview:generate')
    ok('3 getAvailableYears catch 不回传 e.message（旧实现：message: e instanceof Error ? e.message）',
      yearsBlock.length > 0 && !/e instanceof Error \? e\.message/.test(yearsBlock),
      'block 含 e.message 透传或未找到')
    ok('3b export catch 不回传 e.message',
      exportBlock.length > 0 && !/e instanceof Error \? e\.message/.test(exportBlock),
      'block 含 e.message 透传或未找到')
    // 固定文案 + 码白名单收敛到唯一出口（electron/services/annualReviewIpcError.ts）：
    // 两个 handler 必须经该出口返回，文案常量在同源模块内断言（不再各自内联 code/message）
    const ipcErrorSrc = readFileSync(join(ROOT, 'electron', 'services', 'annualReviewIpcError.ts'), 'utf8')
    ok('3c 两个 catch 都经固定安全文案的唯一出口（文案常量在同源模块内）',
      yearsBlock.includes("annualReviewIpcFailureResponse('annualReview:getAvailableYears'") &&
      exportBlock.includes("annualReviewIpcFailureResponse('annualReview:export'") &&
      ipcErrorSrc.includes('可用年份查询失败，请稍后重试') && ipcErrorSrc.includes('导出失败，请稍后重试'))
    ok('3d generate 对 start() 异常有稳定信封（不使 IPC reject 泄露 Electron 包装消息）',
      generateBlock.includes('生成任务启动失败'))
    // Worker/Service 源码不得再引用 e.message 构造对外文案
    const workerSrc = readFileSync(join(ROOT, 'electron', 'annualReviewWorker.ts'), 'utf8')
    const serviceSrc = readFileSync(join(ROOT, 'electron', 'services', 'annualReviewService.ts'), 'utf8')
    ok('3e Worker 源码不再把 e.message 拼进对外错误',
      !/e\.message/.test(workerSrc))
    ok('3f Service 终态收敛不再透传 e.message（period/invalidated/worker_error 等收敛点）',
      !/failTask\([^)]*e instanceof Error \? e\.message/.test(serviceSrc) &&
      !/message: e instanceof Error \? e\.message/.test(serviceSrc))
  }

  // ══ 4 语义保留回归：cancelled / invalidated / fact_load_failed 原固定文案不变 ══
  {
    // 4a cancelled：固定文案保持
    {
      const { runner } = deferredRunner()
      const service = new AnnualReviewService({
        loadFacts: async () => emptyFacts(),
        loadSalesSegments: async () => emptySales(),
        loadCrmSegments: async () => emptyCrm(),
        loadMessageStats: async () => ({ ok: true, sessions: {} }),
        getAccountContext: fixedCtx,
        runner
      })
      const done = service.generate(2026)
      await tick()
      const taskId = service.getTaskState(2026)?.taskId ?? ''
      service.cancel(taskId)
      await done
      const st = service.getTaskStatus(taskId)
      ok('4a 取消语义保留（cancelled + 固定文案）',
        st.task?.error?.code === 'cancelled' && st.task?.error?.message === '年度复盘生成已取消')
    }
    // 4b invalidated：固定文案保持（失效通道不得借机透传）
    {
      const { runner, reject } = deferredRunner()
      const service = new AnnualReviewService({
        loadFacts: async () => emptyFacts(),
        loadSalesSegments: async () => emptySales(),
        loadCrmSegments: async () => emptyCrm(),
        loadMessageStats: async () => ({ ok: true, sessions: {} }),
        getAccountContext: fixedCtx,
        runner
      })
      const done = service.generate(2026)
      await tick()
      const taskId = service.getTaskState(2026)?.taskId ?? ''
      service.invalidateAll()
      reject(Object.assign(new Error(LEAK_MARKERS), { code: 'invalidated' }))
      await done
      const st = service.getTaskStatus(taskId)
      ok('4b 失效语义保留（invalidated + 固定文案，即使底层异常带标记）',
        st.task?.error?.code === 'invalidated' && st.task?.error?.message === INVALIDATED_COPY &&
        !containsLeakMarkers(JSON.stringify(st)))
    }
    // 4c fact_load_failed：固定文案保持（底层加载异常含标记也不得透传）
    {
      const { runner } = deferredRunner()
      const service = new AnnualReviewService({
        loadFacts: async () => { throw new Error(LEAK_MARKERS) },
        loadSalesSegments: async () => emptySales(),
        loadCrmSegments: async () => emptyCrm(),
        loadMessageStats: async () => ({ ok: true, sessions: {} }),
        getAccountContext: fixedCtx,
        runner
      })
      const done = service.generate(2026)
      await done
      const taskId = service.getTaskState(2026)?.taskId ?? ''
      const st = service.getTaskStatus(taskId)
      ok('4c 加载失败语义保留（fact_load_failed + 固定文案）',
        st.task?.error?.code === 'fact_load_failed' &&
        st.task?.error?.message === '本地业务数据加载失败，无法生成年报复盘' &&
        !containsLeakMarkers(JSON.stringify(st)))
    }
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  if (fail > 0) process.exitCode = 1
}

void main()
