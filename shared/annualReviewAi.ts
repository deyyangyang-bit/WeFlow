/**
 * annualReviewAi.ts —— 年度经营复盘 · AI 分析共享契约（S7.1 输出契约 + S7.2 IPC 契约）
 *
 * 为什么放 shared/：本文件被**主进程**（annualReviewAiCore 的输出契约与枚举、
 * annualReviewAiService 的失败码、annualReviewAiCoordinator 的 IPC 信封）与**渲染层**
 * （src/utils/annualReviewView 的页面文案映射、src/types/electron.d.ts 的 preload 类型）
 * 同时引用；tsconfig 里只有 shared/** 同时进入两个编译单元（根 tsconfig 只含 src+shared，
 * tsconfig.node.json 只含 electron+shared）。把契约放在这里而不是两侧各写一份镜像，
 * 是为了让「模型输出结构 / 失败码词表」只有一个定义：渲染层漏掉某个失败码的文案时
 * 类型检查直接失败，而不是上线后出现一个没有任何解释的错误卡片。
 *
 * 本文件零依赖、零 IO、零时钟、无副作用；只有类型与常量。
 */

// ─── 输出枚举（稳定值；非法值一律拒绝，不做大小写/同义词归一） ────────────────

export const ANNUAL_REVIEW_AI_CONFIDENCE = ['high', 'medium', 'low'] as const
/** 1 = 最高优先级；只接受整数 1|2|3 */
export const ANNUAL_REVIEW_AI_PRIORITIES = [1, 2, 3] as const
/** 行动计划时间跨度；'next_year' 表示贯穿下一年度 */
export const ANNUAL_REVIEW_AI_HORIZONS = ['next_quarter', 'next_half', 'next_year'] as const

export type AnnualReviewAiConfidence = (typeof ANNUAL_REVIEW_AI_CONFIDENCE)[number]
export type AnnualReviewAiPriority = (typeof ANNUAL_REVIEW_AI_PRIORITIES)[number]
export type AnnualReviewAiHorizon = (typeof ANNUAL_REVIEW_AI_HORIZONS)[number]

// ─── 输出结构（规格 §8.2；严格 JSON，字段不可增删） ──────────────────────────

export interface AnnualReviewAiDiagnosis {
  title: string
  observation: string
  hypothesis: string
  metricKeys: string[]
  confidence: AnnualReviewAiConfidence
}

export interface AnnualReviewAiAction {
  /** 1 = 最高优先级 */
  priority: AnnualReviewAiPriority
  action: string
  rationale: string
  metricKeys: string[]
  horizon: AnnualReviewAiHorizon
}

export interface AnnualReviewAiRisk {
  risk: string
  metricKeys: string[]
}

/** 一次 AI 分析的全部内容（四个区块；三个数组允许为空，但不允许缺失） */
export interface AnnualReviewAiAnalysis {
  executiveSummary: string
  diagnoses: AnnualReviewAiDiagnosis[]
  actions: AnnualReviewAiAction[]
  risks: AnnualReviewAiRisk[]
}

// ─── 失败码词表（规格 §8.3 + S7.2 IPC 层） ───────────────────────────────────
//
// 分三层，互不混用：
//   parse  — 模型输出解析阶段的失败（AI 层内部细分，规格 §8.2）
//   core   — AI 服务层对外暴露的失败码（规格 §8.3 全量保留，API 契约逐字对应）
//   ipc    — S7.2 接线新增的「报告定位/并发/失效」层失败码（不是模型错误，属于任务与
//            数据边界；与 core 码同处一个信封，页面按同一张表渲染）

/** 模型输出解析失败码（annualReviewAiCore.parseAnnualReviewAiOutput） */
export const ANNUAL_REVIEW_AI_PARSE_FAILURE_CODES = ['empty_output', 'invalid_json', 'invalid_shape', 'numeric_claim'] as const
export type AnnualReviewAiParseFailureCode = (typeof ANNUAL_REVIEW_AI_PARSE_FAILURE_CODES)[number]

/**
 * AI 服务层失败码全集（规格 §8.3 表格逐条对应；**不得删改**——失败码是调用方契约）。
 * 顺序 = 判定顺序：报告结构 → AI 输入契约 → 配置 → 调用 → 解析。
 */
export const ANNUAL_REVIEW_AI_CORE_FAILURE_CODES = [
  'invalid_report',
  'unsupported_report_contract',
  'not_configured',
  'budget_blocked',
  'call_failed',
  ...ANNUAL_REVIEW_AI_PARSE_FAILURE_CODES
] as const
export type AnnualReviewAiCoreFailureCode = (typeof ANNUAL_REVIEW_AI_CORE_FAILURE_CODES)[number]

/**
 * S7.2 IPC 层失败码：与模型调用无关，全部在**调用之前**或**结果返回之前**判定。
 *   - invalid_task_id        载荷 taskId 非法（空/超长/含 NUL）
 *   - task_not_found         任务不存在、已被有界清理淘汰，或属于其他账号作用域（fail closed，
 *                            不泄漏「存在但不可访问」）
 *   - task_not_completed     任务仍在运行，或已 failed（含 cancelled/invalidated）
 *   - report_not_available   任务已完成，但报告缓存已过期/被新报告取代/与任务身份不一致
 *   - analysis_in_progress   同一 {账号作用域, taskId, promptVersion} 已有分析在跑（不重复计费）
 *   - invalidated            分析期间账号或业务库发生变更，结果作废（绝不跨账号返回或缓存）
 *   - internal               未归类的内部异常（固定文案，不透传异常正文）
 */
export const ANNUAL_REVIEW_AI_IPC_FAILURE_CODES = [
  'invalid_task_id',
  'task_not_found',
  'task_not_completed',
  'report_not_available',
  'analysis_in_progress',
  'invalidated',
  'internal'
] as const
export type AnnualReviewAiIpcFailureCode = (typeof ANNUAL_REVIEW_AI_IPC_FAILURE_CODES)[number]

/** 页面需要处理的失败码全集（core + ipc）；渲染层映射表按此类型穷举 */
export const ANNUAL_REVIEW_AI_ANALYSIS_FAILURE_CODES = [
  ...ANNUAL_REVIEW_AI_CORE_FAILURE_CODES,
  ...ANNUAL_REVIEW_AI_IPC_FAILURE_CODES
] as const
export type AnnualReviewAiAnalysisFailureCode = (typeof ANNUAL_REVIEW_AI_ANALYSIS_FAILURE_CODES)[number]

// ─── IPC 请求/响应信封（annualReview:aiAnalysis / annualReview:aiAnalysisCancel） ──

/**
 * 请求**只带 taskId**：渲染层不上传报告、不上传 prompt、不上传模型参数。
 * 主进程按 taskId 在当前账号作用域内定位「已完成且仍有效」的报告（见
 * AnnualReviewService.getTaskReport），因此伪造报告、改口径、注入自由文本都没有入口。
 */
export interface AnnualReviewAiAnalysisRequest {
  taskId: string
}

/** 成功响应：analysis + 可追溯元信息（模型 / promptVersion / 生成时刻） */
export interface AnnualReviewAiAnalysisSuccess {
  success: true
  analysis: AnnualReviewAiAnalysis
  /** 实际使用的模型名（PRD §23 可追溯） */
  model: string
  promptVersion: string
  /** 本次分析生成时刻（命中缓存时为原生成时刻） */
  generatedAt: number
  /** true = 命中主进程内存缓存，未产生新的模型调用 */
  cached: boolean
}

/** 失败响应：固定文案（编译期常量），绝不携带异常 / 模型原文 / URL / 路径 / Token */
export interface AnnualReviewAiAnalysisFailure {
  success: false
  error: { code: AnnualReviewAiAnalysisFailureCode; message: string }
}

export type AnnualReviewAiAnalysisResponse = AnnualReviewAiAnalysisSuccess | AnnualReviewAiAnalysisFailure

/** 取消请求/响应（与 annualReview:aiAnalysis 同一命名空间） */
export interface AnnualReviewAiCancelResponse {
  success: boolean
  error?: { code: string; message: string }
}

/** 对外类型别名（保持既有命名习惯） */
export type { AnnualReviewAiAnalysisFailureCode as AnnualReviewAiFailureCode }
