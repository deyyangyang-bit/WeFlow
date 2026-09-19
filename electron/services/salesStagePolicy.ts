/**
 * salesStagePolicy.ts —— 客户阶段推进策略唯一裁决点（H6；语义源 = shared/salesStage.normalizeStage）
 *
 * 背景三处口径漂移：insightService 曾把「比价」错误映射成 negotiating（正确 canonical 是 quoted）、
 * importCustomerFromProfile 对已有 account 无条件覆写 sales_stage（可能把 won/lost 终态回退）、
 * applyManualStageCorrection 只写 salesDb 不同步 account/商机。本模块不建新枚举、不建第二套映射，
 * 只在 normalizeStage 之上写清推进/终态规则，供全部自动写入口共用：
 *
 *   - 终态保护：当前 won/lost 一切自动判定不得改写（更不得回退）；
 *   - 单调前进：new → contacted → quoted → negotiating 只许沿序前进，不许回退；
 *   - 终态写入：won/lost 作为导入信号（成交/流失判定）允许落到非终态客户上（前进语义）；
 *   - 人工路径：won/lost 的人工变更必须走显式人工纠正（applyManualStageCorrection），
 *     本策略不为后台导入提供终态互转。
 */
import { normalizeStage, type StageCanonical } from '../../shared/salesStage'

/** 自动推进序列（won/lost 是终态，不入推进序列；dormant/unknown 非阶段档位） */
const PROGRESSION_RANK: Partial<Record<StageCanonical, number>> = {
  new: 0, contacted: 1, quoted: 2, negotiating: 3
}

export type AutoStageReason =
  | 'same'                // 归一化后与当前一致（幂等）
  | 'terminal-kept'       // 当前是终态 won/lost，自动判定不改写
  | 'regression-blocked'  // 目标阶段不高于当前推进序（回退被拦截）
  | 'terminal-set'        // 成交/流失信号写入非终态客户（前进语义）
  | 'advanced'            // 沿推进序单调前进

export interface AutoStageDecision {
  /** 规范化后允许落入的 canonical 阶段 */
  stage: StageCanonical
  /** 相对当前值是否有变化（false = 调用方不应写库） */
  changed: boolean
  reason: AutoStageReason
}

/** 自动判定（AI 见解/导入/信号）→ 允许写入的阶段；唯一语义源 normalizeStage */
export function nextAutoStage(currentRaw: string | null | undefined, incomingRaw: string | null | undefined): AutoStageDecision {
  const cur = normalizeStage(currentRaw)
  const inc = normalizeStage(incomingRaw)
  if (!inc || inc === 'unknown') return { stage: cur, changed: false, reason: cur === 'unknown' ? 'same' : 'regression-blocked' }
  if (inc === cur) return { stage: cur, changed: false, reason: 'same' }
  if (cur === 'won' || cur === 'lost') return { stage: cur, changed: false, reason: 'terminal-kept' }
  if (inc === 'won' || inc === 'lost') return { stage: inc, changed: true, reason: 'terminal-set' }
  const curRank = PROGRESSION_RANK[cur] ?? -1 // unknown/dormant 当前值 → 任何已知推进档都可落
  const incRank = PROGRESSION_RANK[inc]
  if (incRank !== undefined && incRank > curRank) return { stage: inc, changed: true, reason: 'advanced' }
  return { stage: cur, changed: false, reason: 'regression-blocked' }
}

/**
 * 显式人工纠正 → 允许写入的阶段。人工是矩阵 🔶 格的唯一合法路径（含终态变更/流失复活），
 * 不做推进拦截，只统一归一化；dormant 拒绝由调用方（legalStageWriters.isManualStageValue）负责。
 */
export function nextManualStage(currentRaw: string | null | undefined, incomingRaw: string): { stage: StageCanonical; changed: boolean } {
  const stage = normalizeStage(incomingRaw)
  return { stage, changed: stage !== normalizeStage(currentRaw) }
}
