/**
 * annualReviewAiService.ts —— 年度经营复盘 · AI 分析调用接口（S7.1）
 *
 * 职责（规格 §8 + S7.1）：
 *   - generateAnnualReviewAiAnalysis：**只读**接收一份已算好的 AnnualReviewReport，
 *     经 annualReviewAiCore 投影 → 构造 prompt → 调用模型 → 严格解析，返回结构化结果。
 *   - 失败一律返回结构化状态（not_configured / budget_blocked / call_failed /
 *     empty_output / invalid_json / invalid_shape / invalid_report），**不伪造诊断**：
 *     模型不可用时调用方拿到的是一条明确的失败码，而不是一段编造的文案。
 *   - 对确定性报告零副作用：不写缓存、不持久化、不改动入参；AI 失败不影响报告读取与导出。
 *
 * 复用现有 AI 基础设施（不新增依赖、不建第二套客户端）：
 *   出口固定为 aiApiClient.simpleCompletion → callChatCompletion，因此额度闸门
 *   （日上限，HTTP 之前阻断且记 blocked 账本行）与用量账本自动生效；
 *   账本 purpose 使用稳定值 `annual_review_ai`，参数见 buildAnnualReviewAiCallOptions
 *   （低温度 0.2、response_format=json_object、maxTokens 2400、超时 60s、关闭思考）。
 *
 * 窄依赖注入（测试纪律）：唯一的模型出口经 AnnualReviewAiRunOptions.completion 注入。
 * 测试必须注入该函数——注入后本模块**不会**触碰 aiApiClient，绝不可能发出真实请求。
 */
import { getAiModelConfig, isAiConfigured, simpleCompletion, type CallOptions } from './ai/aiApiClient'
import { isBudgetBlockedError } from './ai/aiBudget'
import type { ConfigService } from './config'
import { validateAnnualReviewReport, type AnnualReviewReport } from './annualReviewReport'
import {
  ANNUAL_REVIEW_AI_MAX_TOKENS,
  ANNUAL_REVIEW_AI_PROMPT_VERSION,
  ANNUAL_REVIEW_AI_PURPOSE,
  ANNUAL_REVIEW_AI_TEMPERATURE,
  ANNUAL_REVIEW_AI_TIMEOUT_MS,
  annualReviewAiMetricKeys,
  buildAnnualReviewAiInput,
  buildAnnualReviewAiPrompt,
  parseAnnualReviewAiOutput,
  validateAnnualReviewAiInputContract,
  type AnnualReviewAiAnalysis,
  type AnnualReviewAiParseFailureCode
} from './annualReviewAiCore'

// ─── 结果类型 ────────────────────────────────────────────────────────────────

export type AnnualReviewAiFailureCode =
  | 'not_configured'
  | 'budget_blocked'
  | 'call_failed'
  | 'invalid_report'
  | 'unsupported_report_contract'
  | AnnualReviewAiParseFailureCode

export type AnnualReviewAiRunResult =
  | {
      ok: true
      analysis: AnnualReviewAiAnalysis
      /** 实际使用的模型名（PRD §23 可追溯） */
      model: string
      promptVersion: string
      /** 本模块不落库，生成时刻由调用方决定是否持久化 */
      generatedAt: number
    }
  | { ok: false; code: AnnualReviewAiFailureCode; message: string }

/** 模型出口请求（窄接口：只暴露本链路真正需要的信息） */
export interface AnnualReviewAiCompletionRequest {
  systemPrompt: string
  userPrompt: string
  /** 解析后注入的模型名（默认链路下与 getAiModelConfig 一致） */
  model: string
  promptVersion: string
}

export type AnnualReviewAiCompletion = (
  request: AnnualReviewAiCompletionRequest,
  signal?: AbortSignal
) => Promise<string>

export interface AnnualReviewAiRunOptions {
  config: ConfigService
  /**
   * 窄依赖注入：唯一模型出口。缺省 = simpleCompletion 真实链路；
   * 测试必须注入，注入后本模块不接触 aiApiClient。
   */
  completion?: AnnualReviewAiCompletion
  /** 注入：AI 配置可用性（缺省按 config 判定）。注入后同样不读真实配置。 */
  configured?: boolean
  /** 注入：当前时刻（成功结果的 generatedAt） */
  now?: () => number
  signal?: AbortSignal
}

// ─── 调用参数（稳定契约，可单独断言） ────────────────────────────────────────

/**
 * 模型调用参数。temperature 低（解释既有结论，不需创作）、强制 JSON object、
 * token 上限受控；usageContext.purpose 为稳定值 `annual_review_ai`——
 * 改这里等于改账本口径，须同步规格文档。
 */
export function buildAnnualReviewAiCallOptions(signal?: AbortSignal): CallOptions {
  return {
    temperature: ANNUAL_REVIEW_AI_TEMPERATURE,
    maxTokens: ANNUAL_REVIEW_AI_MAX_TOKENS,
    timeoutMs: ANNUAL_REVIEW_AI_TIMEOUT_MS,
    responseFormatJson: true,
    // 长结构化输出若被思考 token 挤占，会先耗尽 max_tokens 再报「输出被截断」，得不偿失
    disableThinking: true,
    usageContext: {
      purpose: ANNUAL_REVIEW_AI_PURPOSE,
      trigger: 'annual_review',
      promptVersion: ANNUAL_REVIEW_AI_PROMPT_VERSION
    },
    signal
  }
}

// ─── 失败文案（全部为编译期常量，绝不拼接原始异常） ──────────────────────────

/**
 * 固定安全文案。调用方（未来的 IPC/UI）拿到的是**常量**，不是异常的投影：
 * 底层 error.message 常带 API URL、Bearer Token、供应商响应正文、数据库路径或堆栈，
 * 一旦透传就会随错误提示、日志、崩溃报告扩散出去。因此这里逐类映射固定文案，
 * 原始错误既不返回也不记录（本轮不新增日志）。
 */
export const ANNUAL_REVIEW_AI_FAILURE_MESSAGES = {
  not_configured: 'AI 未配置（缺少 API 地址或密钥）',
  budget_blocked: '今日 AI 调用已达上限，本次分析未生成；可在设置中提高 AI 每日调用上限后重试',
  timeout: 'AI 调用超时，本次分析未生成',
  cancelled: 'AI 调用已取消，本次分析未生成',
  call_failed: 'AI 调用失败，本次分析未生成',
  invalid_report: '报告未通过结构校验，拒绝生成 AI 分析',
  unsupported_report_contract: '报告含 AI 分析不支持的契约取值，本次分析未生成（该报告仍可正常查看与导出）'
} as const

/** 默认出口：走 simpleCompletion（→ callChatCompletion，额度闸门与账本在此生效） */
function defaultCompletion(config: ConfigService): AnnualReviewAiCompletion {
  return (request, signal) => simpleCompletion(config, request.systemPrompt, request.userPrompt, buildAnnualReviewAiCallOptions(signal))
}

/** 调用期失败归类（只会是这四个之一；配置/报告类失败在调用之前就已返回） */
type AnnualReviewAiCallFailure = 'budget_blocked' | 'cancelled' | 'timeout' | 'call_failed'

/**
 * 失败归类：只产出「哪一类失败」，不产出任何原始错误内容。
 * - 额度阻断：结构化判定（isBudgetBlockedError），与模型/网络故障区分；
 * - 取消：AbortSignal 状态，结构化且可靠；
 * - 超时：无结构化标记可用，只能对异常文案做**分类判断**（该文案本身绝不外泄）。
 */
function classifyCallFailure(error: unknown, signal?: AbortSignal): AnnualReviewAiCallFailure {
  if (isBudgetBlockedError(error)) return 'budget_blocked'
  if (signal?.aborted) return 'cancelled'
  const raw = error instanceof Error ? error.message : ''
  return /超时|timeout|timed out/i.test(raw) ? 'timeout' : 'call_failed'
}

// ─── 主链路 ──────────────────────────────────────────────────────────────────

/**
 * 生成年度经营复盘 AI 分析。纯读取：报告不被修改，AI 失败时调用方仍持有一份完整的
 * 确定性报告（§8「AI 不可用/未配置时确定性报告完整可用」）。
 *
 * 顺序保证：报告结构校验 → AI 配置 → 投影/prompt → 调用（额度闸门在 HTTP 之前）
 * → 解析校验。校验在调用**之前**，避免为一份不合约的报告付费调用。
 */
export async function generateAnnualReviewAiAnalysis(
  report: AnnualReviewReport,
  options: AnnualReviewAiRunOptions
): Promise<AnnualReviewAiRunResult> {
  // 1) 报告必须是已验收契约的报告：未通过校验的一律不进入 prompt（不把脏数据送给第三方模型）
  //    校验原因可能嵌带报告内的键名，不属于「AI 调用错误」范畴，但同样不外传：
  //    调用方若需定位问题可直接调用 validateAnnualReviewReport。
  const year = (report as { year?: unknown } | null | undefined)?.year
  if (typeof year !== 'number' || !Number.isInteger(year) || year < 0) {
    return { ok: false, code: 'invalid_report', message: ANNUAL_REVIEW_AI_FAILURE_MESSAGES.invalid_report }
  }
  const validation = validateAnnualReviewReport(report, year)
  if (!validation.ok) {
    return { ok: false, code: 'invalid_report', message: ANNUAL_REVIEW_AI_FAILURE_MESSAGES.invalid_report }
  }

  // 2) AI 投影契约（fail closed）：报告 validator 只保证 source/code/bucket/kind 是
  //    非空字符串，不保证取值在 AI 白名单内。未知契约值不得静默删除后继续——那会把数据
  //    质量缺口藏在一份看起来正常的诊断背后。此处在**模型调用之前**整体拒绝。
  const contract = validateAnnualReviewAiInputContract(report)
  if (!contract.ok) {
    return { ok: false, code: 'unsupported_report_contract', message: ANNUAL_REVIEW_AI_FAILURE_MESSAGES.unsupported_report_contract }
  }

  // 3) AI 配置：未配置 → 明确失败，绝不降级成模板文案（§8：AI 层整体可选，但不伪造诊断）
  const configured = options.configured ?? isAiConfigured(options.config)
  if (!configured) {
    return { ok: false, code: 'not_configured', message: ANNUAL_REVIEW_AI_FAILURE_MESSAGES.not_configured }
  }

  // 注入出口时不去读真实配置（测试用的假 config 无需实现 get），返回自描述的占位模型名
  const model = options.completion
    ? 'injected-completion'
    : getAiModelConfig(options.config).model

  // 4) 投影 + prompt（同一报告必得同一 prompt）。投影自身也持契约，调用方漏检时同样不会
  //    产出「美化过的」输入——这是同一校验的防御分支，正常路径不可达。
  const built = buildAnnualReviewAiInput(report)
  if (!built.ok) {
    return { ok: false, code: 'unsupported_report_contract', message: ANNUAL_REVIEW_AI_FAILURE_MESSAGES.unsupported_report_contract }
  }
  const prompt = buildAnnualReviewAiPrompt(built.input)

  let raw: string
  try {
    raw = await (options.completion ?? defaultCompletion(options.config))(
      { systemPrompt: prompt.systemPrompt, userPrompt: prompt.userPrompt, model, promptVersion: ANNUAL_REVIEW_AI_PROMPT_VERSION },
      options.signal
    )
  } catch (error) {
    const kind = classifyCallFailure(error, options.signal)
    // 额度阻断有自己的 code；超时/取消/其余统一 call_failed，仅文案不同
    const code: AnnualReviewAiFailureCode = kind === 'budget_blocked' ? 'budget_blocked' : 'call_failed'
    return { ok: false, code, message: ANNUAL_REVIEW_AI_FAILURE_MESSAGES[kind] }
  }

  // 5) 严格解析：任何不合约之处整体失败，不做部分采信
  const parsed = parseAnnualReviewAiOutput(raw, annualReviewAiMetricKeys(report))
  if (!parsed.ok) return { ok: false, code: parsed.code, message: parsed.message }

  return {
    ok: true,
    analysis: parsed.analysis,
    model,
    promptVersion: ANNUAL_REVIEW_AI_PROMPT_VERSION,
    generatedAt: options.now ? options.now() : Date.now()
  }
}
