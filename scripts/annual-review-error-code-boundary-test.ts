/**
 * annual-review-error-code-boundary-test.ts —— 年度经营复盘 IPC 失败码白名单护栏
 *
 * 背景（2026-09-22 二轮收口，基线 ed1e2cb）：上一轮把 `annualReview:getAvailableYears` /
 * `annualReview:export` 两个 catch 的 message 固定成安全文案，但 `code` 仍原样返回**任意
 * 字符串型 e.code**——底层异常（sql.js / better-sqlite3 / node:fs / 任意业务异常）的 code
 * 可以携带数据库路径、SQL 片段或 Token 标记，等于换一个字段继续透传。
 *
 * 覆盖方式（**执行生产逻辑**，不是源码字符串检查）：
 *   ① 直接执行两个 catch 唯一的出口 `annualReviewIpcFailureResponse`（被测生产件），
 *      证明完整 IPC 错误响应只含契约白名单内的码或 internal，且不含任何标记；
 *   ② 用 TypeScript 解析器抽出 main.ts 两个 catch 块，断言它们确实调用同一出口（接线桥，
 *      保证 ① 执行的就是真实 handler 的映射逻辑）且不再出现「原样回传 e.code」表达式；
 *   ③ 合法稳定码回归：`exists` / `unauthorized` / `invalid_leaf_name` / `too_large` /
 *      `write_failed` 由**真实执行 exportTextFile** 产出，`invalid_year` / `future_year`
 *      由真实校验器产出，再喂给同一映射，断言语义保留、文案仍为固定常量；
 *   ④ 反例正控：基线（ed1e2cb）那行「原样回传 e.code」的等价逻辑真实执行后确实会返回
 *      标记 code——证明本测试的标记检测确实能发现旧版透传（基线源码证据见本轮交付报告：
 *      `grep -n 'typeof (e as { code' /tmp/wf-baseline-ed1e2cb/electron/main.ts`）。
 *
 * 运行：npx tsx scripts/annual-review-error-code-boundary-test.ts
 */
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import * as ts from 'typescript'
import { exportTextFile } from '../electron/services/safeTextFileExport'
import { exportPathAuthorizer } from '../electron/services/exportPathAuthorizer'
import { validateAnnualReviewYearInput } from '../electron/services/annualReviewReport'
import {
  ANNUAL_REVIEW_FAILURE_CODE_SETS,
  ANNUAL_REVIEW_IPC_FAILURE,
  ANNUAL_REVIEW_INTERNAL_CODE,
  annualReviewIpcFailureResponse,
  resolveAnnualReviewIpcFailureCode,
  type AnnualReviewFailureChannel
} from '../electron/services/annualReviewIpcError'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MAIN_SOURCE_PATH = join(ROOT, 'electron', 'main.ts')

let pass = 0
let fail = 0
function ok(name: string, cond: boolean, detail?: string): void {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.error(`FAIL ${name}${detail ? `\n  ${detail}` : ''}`) }
}

// ─── 反例标记：数据库路径 + SQL 片段 + Token（假值，仅用于检测透传） ───────────────
const LEAK_PATH = '/Users/yang/Library/Application Support/weflow/weflow-crm-leak.db'
const LEAK_SQL = "SQLITE_ERROR: select * from message where session_id='wxid_leak'"
const LEAK_TOKEN = 'sk-LEAKTEST-abcdefghijklmnop'
const LEAK_MARKERS = `${LEAK_SQL} -- ${LEAK_PATH} (token=${LEAK_TOKEN})`
const MARKER_SCAN = [/SQLITE_ERROR/, /select \* from message/, /\/Users\//, /weflow-crm-leak\.db/, /sk-LEAKTEST/]
const containsLeakMarkers = (s: string): boolean => MARKER_SCAN.some((re) => re.test(s))

/** 基线（ed1e2cb）两个 catch 里那行原样回传 e.code 的表达式——当前实现不得再出现 */
const RELEASED_RAW_CODE_PASSTHROUGH = /typeof \(e as \{ code\?: unknown \}\)\?\.code === 'string' \? \(e as \{ code: string \}\)\.code : 'internal'/

/**
 * 基线那行表达式的等价逻辑（仅作反例正控：证明「返回任意字符串 code」确实会泄露标记）。
 * 语义与基线逐字一致：字符串 code → 原样返回；否则 internal。
 */
function baselineReleasedCodePassthrough(error: unknown): string {
  const code = (error as { code?: unknown } | null | undefined)?.code
  return typeof code === 'string' ? code : ANNUAL_REVIEW_INTERNAL_CODE
}

const CHANNELS: readonly AnnualReviewFailureChannel[] = ['annualReview:getAvailableYears', 'annualReview:export']

// ─── main.ts catch 块的解析式抽取（TypeScript AST，不依赖缩进/正则） ───────────────

/** 抽出 ipcMain.handle(channel, …) 内第一个 try/catch 的 catch 块源码（含花括号） */
function carveCatchBlock(source: string, channel: string): string | null {
  const sf = ts.createSourceFile('main.ts', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS)
  const findTry = (node: ts.Node): ts.TryStatement | null => {
    if (ts.isTryStatement(node) && node.catchClause) return node
    let hit: ts.TryStatement | null = null
    node.forEachChild((child) => { if (hit === null) hit = findTry(child) })
    return hit
  }
  let found: string | null = null
  const visit = (node: ts.Node): void => {
    if (found !== null) return
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        node.expression.getText(sf) === 'ipcMain.handle') {
      const channelArg = node.arguments[0]
      const handler = node.arguments[1]
      if (channelArg !== undefined && ts.isStringLiteralLike(channelArg) && channelArg.text === channel && handler) {
        const tryStmt = findTry(handler)
        if (tryStmt?.catchClause) { found = tryStmt.catchClause.block.getText(sf); return }
      }
    }
    node.forEachChild(visit)
  }
  visit(sf)
  return found
}

// ─── 反例异常载荷 ─────────────────────────────────────────────────────────────

interface MarkedError { readonly label: string; readonly error: unknown }

/** code 本身携带路径／SQL／Token 标记的异常（本轮反例主载荷）+ 真实驱动形态 */
const MARKED_ERRORS: readonly MarkedError[] = [
  { label: 'code=数据库路径', error: Object.assign(new Error('查询失败'), { code: LEAK_PATH }) },
  { label: 'code=SQL 片段', error: Object.assign(new Error('查询失败'), { code: LEAK_SQL }) },
  { label: 'code=Token', error: Object.assign(new Error('查询失败'), { code: LEAK_TOKEN }) },
  { label: 'code=路径+SQL+Token 混合', error: Object.assign(new Error('查询失败'), { code: LEAK_MARKERS }) },
  {
    label: 'node:fs 真实形态（code=ENOENT + path）',
    error: Object.assign(new Error(`ENOENT: no such file or directory, open '${LEAK_PATH}'`), { code: 'ENOENT', path: LEAK_PATH })
  },
  { label: 'sql.js 真实形态（code=SQLITE_ERROR）', error: Object.assign(new Error('SQL logic error'), { code: 'SQLITE_ERROR' }) },
  { label: 'node:fs 真实形态（code=EEXIST，不得被误判为导出器 exists）', error: Object.assign(new Error('EEXIST: file already exists'), { code: 'EEXIST' }) }
]

// ─── 合法稳定码（由生产件真实执行产出） ───────────────────────────────────────────

interface DerivedCode { readonly code: string; readonly via: string }

/** 真实执行 exportTextFile，产出导出器的封闭失败码（不硬编码猜测） */
function deriveExecutorFailureCodes(): DerivedCode[] {
  const dir = mkdtempSync(join(tmpdir(), 'ar-code-boundary-'))
  const out: DerivedCode[] = []
  try {
    // 与 annualReview:export handler 同款前置：目录先经对话框即席授权（这里是临时目录）
    exportPathAuthorizer.grant(dir, 'dir')
    const r1 = exportTextFile({ dir, fileName: 'bad:name.md', content: 'x' })
    if (!r1.ok) out.push({ code: r1.code, via: '叶子名含冒号被拒' })
    const r2 = exportTextFile({ dir, fileName: 'big.md', content: 'x'.repeat(64), maxSizeBytes: 8 })
    if (!r2.ok) out.push({ code: r2.code, via: 'maxSizeBytes 超限' })
    const r3 = exportTextFile({ dir, fileName: 'unauth.md', content: 'x' }, {
      assertAllowed: () => { throw new Error('导出路径未经过本会话授权') }
    })
    if (!r3.ok) out.push({ code: r3.code, via: 'assertAllowed 拒绝' })
    // exists：同一叶子名导两次（首次成功由执行器独占创建，二次命中真实 fs EEXIST）
    const first = exportTextFile({ dir, fileName: 'dup.md', content: 'first' })
    const r4 = exportTextFile({ dir, fileName: 'dup.md', content: 'second' })
    ok('1k 对照组：首次导出成功（失败码只来自失败路径）', first.ok === true,
      `actual: ${JSON.stringify(first)}`)
    if (!r4.ok) out.push({ code: r4.code, via: '真实 fs EEXIST' })
    const r5 = exportTextFile({ dir, fileName: 'stall.md', content: 'x' }, { write: () => 0 })
    if (!r5.ok) out.push({ code: r5.code, via: '写入停滞（注入 write 返回 0）' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  return out
}

/** 真实执行年份校验器，产出 export 通道的校验失败码 */
function deriveValidatorFailureCodes(): DerivedCode[] {
  const now = Date.now()
  const currentYear = new Date(now).getFullYear()
  const out: DerivedCode[] = []
  const v1 = validateAnnualReviewYearInput('2026', now)
  if (!v1.ok) out.push({ code: v1.code, via: '非整型年份' })
  const v2 = validateAnnualReviewYearInput(currentYear + 1, now)
  if (!v2.ok) out.push({ code: v2.code, via: '未来年份' })
  return out
}

// ─── 断言辅助 ────────────────────────────────────────────────────────────────

const codeSet = (channel: AnnualReviewFailureChannel): string[] => [...ANNUAL_REVIEW_IPC_FAILURE[channel].codes].sort()
const contractCodes = (channel: AnnualReviewFailureChannel): string[] => [...ANNUAL_REVIEW_FAILURE_CODE_SETS[channel]].sort()
const fixedMessage = (channel: AnnualReviewFailureChannel): string => ANNUAL_REVIEW_IPC_FAILURE[channel].message
const asError = (code: string): unknown => Object.assign(new Error('底层异常'), { code })

function main(): void {
  const mainSrc = readFileSync(MAIN_SOURCE_PATH, 'utf8')

  // ══ 0 通道契约码全集（白名单精确等于契约，防止悄悄放宽） ══════════════════════
  {
    ok('0a getAvailableYears 契约码 = {invalidated}（API-CONTRACT §1.17）',
      JSON.stringify(codeSet('annualReview:getAvailableYears')) === JSON.stringify(['invalidated']),
      `actual: ${JSON.stringify(codeSet('annualReview:getAvailableYears'))}`)
    const exportExpected = ['cancelled', 'exists', 'future_year', 'invalid_format', 'invalid_leaf_name',
      'invalid_year', 'report_not_found', 'too_large', 'unauthorized', 'write_failed']
    ok('0b export 契约码 = 校验码 + 报告未命中 + 取消 + 执行器封闭联合（不额外放宽）',
      JSON.stringify(codeSet('annualReview:export')) === JSON.stringify(exportExpected),
      `actual: ${JSON.stringify(codeSet('annualReview:export'))}`)
    ok('0c 白名单与契约码集合同源（无第二份定义漂移）',
      CHANNELS.every((c) => JSON.stringify(codeSet(c)) === JSON.stringify(contractCodes(c))))
    ok('0d 固定文案为编译期常量且不含标记',
      CHANNELS.every((c) => fixedMessage(c).length > 0 && !containsLeakMarkers(fixedMessage(c))),
      `actual: ${JSON.stringify(CHANNELS.map((c) => fixedMessage(c)))}`)
  }

  // ══ 1 执行生产映射：code 带路径/SQL/Token 的异常 → 白名单内码 + 无标记响应 ══════
  {
    for (const channel of CHANNELS) {
      for (const { label, error } of MARKED_ERRORS) {
        const r = annualReviewIpcFailureResponse(channel, error)
        ok(`1a ${channel} / ${label}：code 只可能是契约白名单码或 internal（绝不原样回传）`,
          r.error.code === ANNUAL_REVIEW_INTERNAL_CODE || ANNUAL_REVIEW_IPC_FAILURE[channel].codes.has(r.error.code),
          `actual code: ${JSON.stringify(r.error.code)}`)
        ok(`1b ${channel} / ${label}：完整 IPC 错误响应不含标记`,
          r.success === false && !containsLeakMarkers(JSON.stringify(r)),
          `actual response: ${JSON.stringify(r)}`)
        ok(`1c ${channel} / ${label}：message 为固定安全文案（不随异常变化）`,
          r.error.message === fixedMessage(channel),
          `actual message: ${JSON.stringify(r.error.message)}`)
      }
    }
  }

  // ══ 2 接线桥：两个 catch 块确实调用同一出口（1 节执行的就是 handler 的映射） ═══
  {
    for (const channel of CHANNELS) {
      const block = carveCatchBlock(mainSrc, channel)
      ok(`2a main.ts 定位到 ${channel} 的 catch 块`, block !== null, '未在源码中定位到 catch 块')
      if (block === null) continue
      ok(`2b ${channel} catch 调用唯一出口 annualReviewIpcFailureResponse(${channel})`,
        block.includes(`annualReviewIpcFailureResponse('${channel}'`) ||
        block.includes(`annualReviewIpcFailureResponse("${channel}"`),
        `actual block: ${block.replace(/\s+/g, ' ').slice(0, 220)}`)
      ok(`2c ${channel} catch 不再原样回传 e.code`,
        !RELEASED_RAW_CODE_PASSTHROUGH.test(block))
    }

    // ══ 3 反例正控：基线那行逻辑真实执行后确实返回异常 code（检测器有效 + 旧版泄露机制） ══
    for (const { label, error } of MARKED_ERRORS) {
      const payloadCode = (error as { code: string }).code
      const released = baselineReleasedCodePassthrough(error)
      ok(`3a 反例正控 / ${label}：基线逻辑把异常 code 原样返回（等价旧实现逐字透传）`,
        released === payloadCode,
        `actual: ${JSON.stringify(released)}`)
      if (containsLeakMarkers(payloadCode)) {
        ok(`3b 反例正控 / ${label}：该 code 携带路径/SQL/Token 标记（1b 的检测确有意义）`,
          containsLeakMarkers(released),
          `actual: ${JSON.stringify(released)}`)
      }
    }
  }

  // ══ 4 合法稳定码回归（码由生产件真实执行产出，经同一映射后语义保留） ════════════
  {
    // 4a getAvailableYears：唯一契约码 invalidated 必须保留（页面/契约依赖该语义）
    ok('4a getAvailableYears 保留 invalidated（失效语义不被误收敛为 internal）',
      resolveAnnualReviewIpcFailureCode('annualReview:getAvailableYears', asError('invalidated')) === 'invalidated')
    const inv = annualReviewIpcFailureResponse('annualReview:getAvailableYears', asError('invalidated'))
    ok('4a2 invalidated 的完整信封文案仍为固定常量',
      inv.error.code === 'invalidated' && inv.error.message === fixedMessage('annualReview:getAvailableYears'))

    // 4b export：执行器封闭失败码（真实执行产出）逐个保留
    const executorCodes = deriveExecutorFailureCodes()
    ok('4b 执行器失败码取样完备（5 类全部真实取到）',
      JSON.stringify(executorCodes.map((d) => d.code).sort()) ===
      JSON.stringify(['exists', 'invalid_leaf_name', 'too_large', 'unauthorized', 'write_failed']),
      `actual: ${JSON.stringify(executorCodes)}`)
    for (const { code, via } of executorCodes) {
      ok(`4c export 保留执行器码 ${code}（${via}）`,
        resolveAnnualReviewIpcFailureCode('annualReview:export', asError(code)) === code)
    }

    // 4d export：校验码（真实执行产出）逐个保留
    const validatorCodes = deriveValidatorFailureCodes()
    ok('4d 校验器失败码取样完备（invalid_year + future_year）',
      JSON.stringify(validatorCodes.map((d) => d.code).sort()) === JSON.stringify(['future_year', 'invalid_year']),
      `actual: ${JSON.stringify(validatorCodes)}`)
    for (const { code, via } of validatorCodes) {
      ok(`4e export 保留校验码 ${code}（${via}）`,
        resolveAnnualReviewIpcFailureCode('annualReview:export', asError(code)) === code)
    }

    // 4f export：正常结果路径的其余契约码（handler 字面量）保留
    for (const code of ['invalid_format', 'report_not_found', 'cancelled']) {
      ok(`4f export 保留契约码 ${code}`,
        resolveAnnualReviewIpcFailureCode('annualReview:export', asError(code)) === code)
    }

    // 4g 合法码不得跨通道借用：export 的码在 years 通道一律 internal，反之亦然
    ok('4g 契约码不跨通道放行（exists → years = internal；invalidated → export = internal）',
      resolveAnnualReviewIpcFailureCode('annualReview:getAvailableYears', asError('exists')) === ANNUAL_REVIEW_INTERNAL_CODE &&
      resolveAnnualReviewIpcFailureCode('annualReview:export', asError('invalidated')) === ANNUAL_REVIEW_INTERNAL_CODE)
  }

  // ══ 5 普通异常回归：无稳定码 → internal + 固定文案 ══════════════════════════
  {
    const plainCases: ReadonlyArray<{ label: string; error: unknown }> = [
      { label: '普通 Error（无 code）', error: new Error('查询失败') },
      { label: 'TypeError', error: new TypeError('x is not a function') },
      { label: '抛字符串', error: 'boom' },
      { label: '抛 null', error: null },
      { label: '抛 undefined（catch 无参形态）', error: undefined },
      { label: 'code 为数字', error: Object.assign(new Error('x'), { code: 42 }) },
      { label: 'code 为 null', error: Object.assign(new Error('x'), { code: null }) },
      { label: 'code 为对象（toString 冒充合法码）', error: Object.assign(new Error('x'), { code: { toString: () => 'exists' } }) },
      { label: 'code getter 抛错', error: Object.defineProperty(new Error('x'), 'code', { get() { throw new Error(LEAK_MARKERS) } }) },
      { label: 'code 大小写/空白变体（不宽松匹配）', error: Object.assign(new Error('x'), { code: ' INVALIDATED ' }) }
    ]
    for (const channel of CHANNELS) {
      for (const { label, error } of plainCases) {
        const r = annualReviewIpcFailureResponse(channel, error)
        ok(`5 ${channel} / ${label} → internal + 固定文案`,
          r.success === false && r.error.code === ANNUAL_REVIEW_INTERNAL_CODE &&
          r.error.message === fixedMessage(channel) && !containsLeakMarkers(JSON.stringify(r)),
          `actual: ${JSON.stringify(r)}`)
      }
    }
  }

  // ══ 6 汇总：两通道 × 全部载荷的完整响应一律无标记、无白名单外的码 ═══════════════
  {
    const allPayloads: unknown[] = [
      ...MARKED_ERRORS.map((m) => m.error),
      new Error('plain'), 'boom', null, undefined,
      asError('EEXIST'), asError('SQLITE_BUSY'), asError('ENOENT'),
      Object.assign(new Error(LEAK_MARKERS), { code: 'ENOENT', path: LEAK_PATH })
    ]
    const problems: string[] = []
    for (const channel of CHANNELS) {
      for (const payload of allPayloads) {
        const json = JSON.stringify(annualReviewIpcFailureResponse(channel, payload))
        const code = (JSON.parse(json) as { error: { code: string } }).error.code
        if (containsLeakMarkers(json)) problems.push(`${channel} 泄露标记：${json}`)
        if (code !== ANNUAL_REVIEW_INTERNAL_CODE && !ANNUAL_REVIEW_IPC_FAILURE[channel].codes.has(code)) {
          problems.push(`${channel} 出现白名单外的码：${json}`)
        }
      }
    }
    ok('6 全部载荷 × 两通道：响应只含契约码或 internal，且无任何标记', problems.length === 0,
      `problems: ${JSON.stringify(problems)}`)
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  if (fail > 0) process.exitCode = 1
}

main()
