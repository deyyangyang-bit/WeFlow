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
  type AnnualReviewAiAnalysis,
  type AnnualReviewAiParseFailureCode
} from './annualReviewAiCore'

// ─── 结果类型 ────────────────────────────────────────────────────────────────

export type AnnualReviewAiFailureCode =
  | 'not_configured'
  | 'budget_blocked'
  | 'call_failed'
  | 'invalid_report'
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

/** 默认出口：走 simpleCompletion（→ callChatCompletion，额度闸门与账本在此生效） */
function defaultCompletion(config: ConfigService): AnnualReviewAiCompletion {
  return (request, signal) => simpleCompletion(config, request.systemPrompt, request.userPrompt, buildAnnualReviewAiCallOptions(signal))
}

// ─── 错误信息脱敏 ────────────────────────────────────────────────────────────

/** 错误文案只保留单行、限长：不把响应体/堆栈/路径整段带到日志与 UI */
function safeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw.replace(/\s+/g, ' ').trim().slice(0, 160) || '未知错误'
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
  const year = (report as { year?: unknown } | null | undefined)?.year
  if (typeof year !== 'number' || !Number.isInteger(year) || year < 0) {
    return { ok: false, code: 'invalid_report', message: '报告缺少合法的 year，拒绝生成 AI 分析' }
  }
  const validation = validateAnnualReviewReport(report, year)
  if (!validation.ok) return { ok: false, code: 'invalid_report', message: `报告结构校验未通过：${validation.reason}` }

  // 2) AI 配置：未配置 → 明确失败，绝不降级成模板文案（§8：AI 层整体可选，但不伪造诊断）
  const configured = options.configured ?? isAiConfigured(options.config)
  if (!configured) return { ok: false, code: 'not_configured', message: 'AI 未配置（缺少 API 地址或密钥）' }

  // 注入出口时不去读真实配置（测试用的假 config 无需实现 get），返回自描述的占位模型名
  const model = options.completion
    ? 'injected-completion'
    : getAiModelConfig(options.config).model

  // 3) 投影 + prompt（同一报告必得同一 prompt）
  const input = buildAnnualReviewAiInput(report)
  const prompt = buildAnnualReviewAiPrompt(input)

  let raw: string
  try {
    raw = await (options.completion ?? defaultCompletion(options.config))(
      { systemPrompt: prompt.systemPrompt, userPrompt: prompt.userPrompt, model, promptVersion: ANNUAL_REVIEW_AI_PROMPT_VERSION },
      options.signal
    )
  } catch (error) {
    // 额度阻断必须与模型故障区分：前者调高上限即可，后者要看模型/网络
    if (isBudgetBlockedError(error)) {
      return { ok: false, code: 'budget_blocked', message: safeErrorMessage(error) }
    }
    return { ok: false, code: 'call_failed', message: safeErrorMessage(error) }
  }

  // 4) 严格解析：任何不合约之处整体失败，不做部分采信
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
