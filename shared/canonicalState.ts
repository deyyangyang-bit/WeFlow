/**
 * shared/canonicalState.ts —— 客户当前状态读取模型（P0-2A.2）
 *
 * 把现有混乱的 stage 存储（中英混存 + dormant 曾混入 stage + unknown 无归一）
 * 解释为统一状态：
 *   - stage 6 值（new/contacted/quoted/negotiating/won/lost）→ 销售进展语义
 *   - activityState（active/dormant）→ 时间覆盖层，dormant 从 stage 拆出，可叠加任意 stage
 *   - unknown → 数据异常位，不作为正常销售阶段，不进漏斗转化链
 *   - stateMeta → 谁判的 / 置信度 / 何时变 / 证据
 *
 * 纯只读 Read Model / Adapter：不写数据库、不改 schema、不落任何状态。
 * 概念接口：getCanonicalState(customer) → CanonicalState（销售侧适配器见 salesDbService）。
 */
import { normalizeStage } from './salesStage'

/** 销售进展 6 值（dormant 是活动状态非阶段；unknown 是异常位） */
export const CANONICAL_STAGE_6 = ['new', 'contacted', 'quoted', 'negotiating', 'won', 'lost'] as const
export type CanonicalStage6 = (typeof CANONICAL_STAGE_6)[number]
/** stage 取值：6 值 + unknown（数据异常位，进漏斗前必须排除） */
export type CanonicalStage = CanonicalStage6 | 'unknown'
export type ActivityState = 'active' | 'dormant'

/** 沉默阈值（天）：与规则层 R5 dormant_wake（30-90 天）起点一致，低于 30 天为 active */
export const DORMANT_SILENT_DAYS = 30

export interface StateMetaEvidence {
  reason: string | null
  evidenceText: string | null
  messageKey: string | null
}

export interface StateMeta {
  /** 谁判的：intent_tag_log.source（auto_message_trigger / ai / manual） */
  source: string | null
  confidence: number | null
  /** 当前 stage 最近变更时间（毫秒）：last_stage_change_at 优先，回退最近匹配 intent 记录 created_at */
  changedAt: number | null
  evidence: StateMetaEvidence
}

export interface CanonicalState {
  stage: CanonicalStage
  activityState: ActivityState
  stateMeta: StateMeta
}

export interface CanonicalStateInput {
  /** customer_profile.stage 原始值（中英混存） */
  rawStage: string | null | undefined
  /** customer_profile.last_contact_at（秒） */
  lastContactAt: number | null | undefined
  /** customer_profile.last_stage_change_at（毫秒，仅 classifier 覆盖） */
  lastStageChangeAt: number | null | undefined
  /** 当前时间（秒），注入以便单测固定时间；生产传 Date.now()/1000 */
  nowSec: number
  /** intent_tag_log 近期记录（含 stage 原文，内部做归一匹配） */
  recentIntents: Array<{
    stage: string
    source: string | null
    confidence: number | null
    createdAt: number | null
    reason: string | null
    evidenceText: string | null
    messageKey: string | null
  }>
}

const DAY_SEC = 86400

/**
 * 组装客户当前状态（只读）。
 * - stage：normalizeStage 后只取 6 值；legacy dormant 底层销售阶段已被覆盖 → 如实落 unknown；
 *   unknown 原样落异常位。dormant 只作为时间状态出现在 activityState。
 * - activityState：last_contact_at（秒）+ 30 天阈值；last_contact_at 缺失但有 legacy dormant 标记 → 判 dormant。
 * - stateMeta：intent_tag_log 最近「归一化后 == 当前 stage」记录的 source/confidence/created_at/reason/evidence。
 */
export function computeCanonicalState(input: CanonicalStateInput): CanonicalState {
  const c = normalizeStage(input.rawStage)

  // stage：6 值或异常位
  let stage: CanonicalStage
  if (c === 'dormant' || c === 'unknown') stage = 'unknown'
  else stage = c

  // activityState：时间覆盖层，独立于 stage 可叠加
  let activityState: ActivityState = 'active'
  if (input.lastContactAt && input.lastContactAt > 0) {
    const silentDays = (input.nowSec - input.lastContactAt) / DAY_SEC
    if (silentDays >= DORMANT_SILENT_DAYS) activityState = 'dormant'
  } else if (c === 'dormant') {
    // last_contact_at 缺失但有 legacy dormant 标记 → 如实判 dormant
    activityState = 'dormant'
  }

  // stateMeta：最近「归一化后 == 当前 stage」的 intent 记录
  const matched = input.recentIntents.find((r) => normalizeStage(r.stage) === stage)
  const changedAt = input.lastStageChangeAt ?? matched?.createdAt ?? null
  if (!matched) {
    return { stage, activityState, stateMeta: { source: null, confidence: null, changedAt, evidence: { reason: null, evidenceText: null, messageKey: null } } }
  }
  return {
    stage,
    activityState,
    stateMeta: {
      source: matched.source,
      confidence: matched.confidence,
      changedAt,
      evidence: { reason: matched.reason, evidenceText: matched.evidenceText, messageKey: matched.messageKey }
    }
  }
}
