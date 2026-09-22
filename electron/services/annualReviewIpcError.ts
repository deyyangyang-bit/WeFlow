/**
 * annualReviewIpcError.ts —— annualReview:* IPC 失败信封的码白名单与固定文案（唯一来源）
 *
 * 为什么存在：`ipcMain.handle` 的 catch 若把 `e.code` 原样返回渲染层，底层异常
 * （sql.js / better-sqlite3 / node:fs / 任意业务异常）的 code 就是一条换字段的透传通道——
 * code 里可以带数据库路径、SQL 片段或 Token 标记。ed1e2cb 基线即如此：message 已固定，
 * code 仍原样透传（`typeof e.code === 'string' ? e.code : 'internal'`）。
 * 本模块按**通道契约**收敛：只放行明确允许的稳定码，其余（含任意字符串、非字符串、
 * 无 code、code getter 抛错）一律 `internal`。
 *
 * 通道契约来源（2026-09-22 核对代码与文档）：
 *   - `annualReview:getAvailableYears`：docs/API-CONTRACT.md §1.17 只承诺一个稳定码
 *     `invalidated`（加载期间失效 → 旧结果不缓存不返回）。服务层其余抛出点（事实加载、
 *     账号上下文）不携带契约码，一律收敛 `internal`。
 *   - `annualReview:export`：本通道失败码 = 载荷校验（`invalid_format` / `invalid_year` /
 *     `future_year`，见 validateAnnualReviewYearInput）+ 报告缓存未命中（`report_not_found`）
 *     + 目录对话框取消（`cancelled`）+ safeTextFileExport 的封闭联合
 *     （`invalid_leaf_name` / `unauthorized` / `too_large` / `exists` / `write_failed`，
 *     见 SafeTextFileResult）。执行器今天以**正常结果**返回这些码（它自己吞掉底层异常），
 *     白名单同样收留它们：语义不随到达方式（返回/抛出）改变，但绝不会因此放行白名单外的码。
 *
 * 边界纪律：message 永远是编译期固定文案，绝不拼接异常正文；本模块只做「码收敛 + 信封」。
 */

export type AnnualReviewFailureChannel = 'annualReview:getAvailableYears' | 'annualReview:export'

/** getAvailableYears 契约码：只有失效语义是稳定对外承诺（API-CONTRACT §1.17） */
const GET_AVAILABLE_YEARS_FAILURE_CODES: readonly string[] = ['invalidated']

/** export 契约码：handler 字面量 + 年份校验器 + 导出执行器封闭联合 */
const EXPORT_FAILURE_CODES: readonly string[] = [
  'invalid_format',
  'invalid_year',
  'future_year',
  'report_not_found',
  'cancelled',
  'invalid_leaf_name',
  'unauthorized',
  'too_large',
  'exists',
  'write_failed'
]

/** 白名单外的任意 code 一律收敛到这里（与既有信封用的通用兜底码一致） */
export const ANNUAL_REVIEW_INTERNAL_CODE = 'internal'

export interface AnnualReviewIpcFailurePolicy {
  /** 本通道契约允许对外返回的稳定码全集 */
  readonly codes: ReadonlySet<string>
  /** 对外固定安全文案（编译期常量，不含路径/SQL/Token/异常正文） */
  readonly message: string
}

export const ANNUAL_REVIEW_IPC_FAILURE: Readonly<Record<AnnualReviewFailureChannel, AnnualReviewIpcFailurePolicy>> = {
  'annualReview:getAvailableYears': {
    codes: new Set(GET_AVAILABLE_YEARS_FAILURE_CODES),
    message: '可用年份查询失败，请稍后重试'
  },
  'annualReview:export': {
    codes: new Set(EXPORT_FAILURE_CODES),
    message: '导出失败，请稍后重试'
  }
}

/** 契约码快照（测试用：断言白名单恰好等于契约集合，防止悄悄放宽） */
export const ANNUAL_REVIEW_FAILURE_CODE_SETS: Readonly<Record<AnnualReviewFailureChannel, readonly string[]>> = {
  'annualReview:getAvailableYears': GET_AVAILABLE_YEARS_FAILURE_CODES,
  'annualReview:export': EXPORT_FAILURE_CODES
}

export interface AnnualReviewIpcFailure {
  readonly success: false
  readonly error: { readonly code: string; readonly message: string }
}

/** 异常 → 稳定码：白名单外（任意字符串、非字符串、无 code、读取 code 抛错）一律 internal */
export function resolveAnnualReviewIpcFailureCode(channel: AnnualReviewFailureChannel, error: unknown): string {
  let code: unknown
  try {
    code = (error as { code?: unknown } | null | undefined)?.code
  } catch {
    // 异常 getter 抛错：错误边界自身绝不能再抛，按未知异常处理
    return ANNUAL_REVIEW_INTERNAL_CODE
  }
  return typeof code === 'string' && ANNUAL_REVIEW_IPC_FAILURE[channel].codes.has(code)
    ? code
    : ANNUAL_REVIEW_INTERNAL_CODE
}

/**
 * 两个 catch 的唯一出口：码经白名单收敛、文案取本通道固定常量。
 * 返回结构即渲染层 d.ts 的 `{ success: false, error: { code, message } }`。
 */
export function annualReviewIpcFailureResponse(
  channel: AnnualReviewFailureChannel,
  error: unknown
): AnnualReviewIpcFailure {
  return {
    success: false,
    error: {
      code: resolveAnnualReviewIpcFailureCode(channel, error),
      message: ANNUAL_REVIEW_IPC_FAILURE[channel].message
    }
  }
}
