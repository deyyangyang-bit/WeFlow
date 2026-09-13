/**
 * opportunityAnalysisService.ts —— 商机阶段分析：**只读组装层**（零模型调用、零落库）
 *
 * 事实投影全部委托 `shared/opportunitySignals.ts`（唯一事实源）；本文件只负责
 * 「从 crmDb / salesDb 取已落库字段 → 装配成纯函数输入」，不含任何排序或文案逻辑。
 *
 * 两个消费方共用同一个 `collectOpportunityAssessments()`：
 *   1. `crm:opportunity:analysis` IPC → 商机页「阶段分析」视图
 *   2. `salesActionEngine.getUnifiedSignals` → 早间简报 / 今日行动 / 客户工作台
 * 两条路径同源，禁止各自再算一套（设计稿：单一聚合链）。
 */

import { crmDbService, type CrmRow } from './crmDbService'
import { salesDbService } from './salesDbService'
import { salesLog } from './salesLogger'
import {
  deriveOppAssessment, rankCandidates, PIPELINE_STAGES,
  type OppAssessment, type OppFactsInput, type OppQuoteSignalFact,
  type OppQuotationFact, type OppRiskFact, type OppTaskFact,
  type OpportunityStageSegment, type OpportunityAnalysisResult
} from '../../shared/opportunitySignals'

// 视图载荷类型定义在 shared（渲染层与主进程共用一份），此处再导出，保持既有 import 路径可用
export type { OpportunityStageSegment, OpportunityAnalysisOverview, OpportunityAnalysisResult } from '../../shared/opportunitySignals'

const DAY_MS = 86400000
/** 「近 30 天成交」窗口 */
export const WON_WINDOW_DAYS = 30

// ─── 单商机事实读取 ──────────────────────────────────────────────────────────

/** 进入当前阶段的时刻。优先取最近一条 stage_change 事件；无事件时回退创建时刻并标记来源，
 *  以便理由文案降级为「进入该阶段至少 X 天」（不假装知道精确入段时刻）。 */
function stageEnteredAt(oppId: number, createdAt: number): { at: number; fromEvent: boolean } {
  const row = crmDbService.all(
    "SELECT created_at FROM opportunity_event WHERE opportunity_id = ? AND event_type = 'stage_change' ORDER BY id DESC LIMIT 1",
    [oppId]
  )[0]
  const at = Number(row?.created_at || 0)
  if (at > 0) return { at, fromEvent: true }
  return { at: Number(createdAt) || 0, fromEvent: false }
}

/** 该客户最新一条报价信号（含已回复的）——是否「未回复」由纯函数按 customer_replied_at 判定。
 *  经 session_id 或 account_id 关联；两者皆无命中视为关联不稳定，返回 null（触发降级文案）。 */
function latestQuoteSignal(sessionId: string, accountId: number): OppQuoteSignalFact | null {
  if (!sessionId && !accountId) return null
  const row = crmDbService.all(
    `SELECT id, quoted_at, customer_replied_at FROM quote_signal
     WHERE quoted_at > 0 AND (session_id = ? OR (account_id IS NOT NULL AND account_id > 0 AND account_id = ?))
     ORDER BY quoted_at DESC LIMIT 1`,
    [String(sessionId || ''), Number(accountId) || 0]
  )[0]
  if (!row) return null
  return {
    id: Number(row.id),
    quotedAt: Number(row.quoted_at) || 0,
    customerRepliedAt: Number(row.customer_replied_at) || 0
  }
}

/** 该客户最新报价单（经 contract.account_id）。**仅**用于无 quote_signal 关联时的降级文案。 */
function latestQuotation(accountId: number): OppQuotationFact | null {
  if (!accountId) return null
  const row = crmDbService.all(
    `SELECT q.id AS id, q.created_at AS created_at FROM quotation q
     JOIN contract c ON c.id = q.contract_id WHERE c.account_id = ?
     ORDER BY q.created_at DESC LIMIT 1`,
    [Number(accountId)]
  )[0]
  if (!row) return null
  return { id: Number(row.id), createdAt: Number(row.created_at) || 0 }
}

/** 该客户未处理的风险行（crm_risk active） */
function activeRisks(accountId: number): OppRiskFact[] {
  if (!accountId) return []
  return crmDbService.all(
    "SELECT id, risk_type, severity, detail, status, created_at FROM crm_risk WHERE account_id = ? AND status = 'active' ORDER BY id DESC",
    [Number(accountId)]
  ).map((r: CrmRow) => ({
    id: Number(r.id),
    riskType: String(r.risk_type || ''),
    severity: String(r.severity || 'medium'),
    detail: String(r.detail || ''),
    status: String(r.status || 'active'),
    createdAt: Number(r.created_at) || 0
  }))
}

/** 该客户最近一条意向记录（历史 AI/规则抽取产物，读取不算新调用）。
 *  仅取有 reason 文本的行——没有可读理由就不产出理由，不编造。 */
function latestIntent(sessionId: string): { createdAt: number; reason: string } | null {
  if (!sessionId) return null
  try {
    const row = salesDbService.intentGetLatest(String(sessionId))
    const reason = String(row?.reason || '').trim()
    if (!reason) return null
    return { createdAt: Number(row?.created_at) || 0, reason }
  } catch { return null }
}

// ─── 全量装配 ────────────────────────────────────────────────────────────────

/** 该客户 pending 待办（按 due_at 升序；无期限的排最后）。due_at 为销售自己承诺的截止。 */
function pendingTasksFor(sessionId: string): OppTaskFact[] {
  if (!sessionId) return []
  try {
    return salesDbService
      .todoList({ status: 'pending', session_id: String(sessionId) })
      .map((t) => ({ id: Number(t.id) || 0, title: String(t.title || ''), dueAt: t.due_at ?? null, status: String(t.status || 'pending') }))
      .sort((a, b) => (Number(a.dueAt || 0) || Number.MAX_SAFE_INTEGER) - (Number(b.dueAt || 0) || Number.MAX_SAFE_INTEGER))
  } catch { return [] }
}

/** 客户档案里的最近联系时刻（秒级 WCDB 口径 → 毫秒；0 = 未知） */
function lastContactMs(sessionId: string): number {
  if (!sessionId) return 0
  try {
    const p = salesDbService.customerGetBySession(String(sessionId))
    return (Number(p?.last_contact_at) || 0) * 1000
  } catch { return 0 }
}

/** 管道金额口径：amount_cny > 0 时取 amount_cny，否则取 amount。
 *  与商机详情既有展示一致（成交登记会同时写两列，active 阶段通常只有 amount）。 */
function pipelineAmount(o: CrmRow): number {
  const cny = Number(o.amount_cny) || 0
  return cny > 0 ? cny : (Number(o.amount) || 0)
}

/**
 * 全部 **active** 商机的确定性信号投影（won/lost 不参与管道与滞留判定）。
 * 只读；任何单个商机装配失败都跳过该行并在日志留痕，不让整页失败。
 */
export function collectOpportunityAssessments(nowMs: number = Date.now()): OppAssessment[] {
  // crmDb 未打开时 all() 返回空数组（服务层自带守卫），无需额外判断
  const rows = crmDbService.all(
    `SELECT o.*, a.name AS account_name, a.session_id AS session_id
     FROM opportunity o LEFT JOIN account a ON a.id = o.account_id
     WHERE o.status = 'active' ORDER BY o.last_signal_at DESC, o.id DESC`,
    []
  )
  const out: OppAssessment[] = []
  for (const o of rows) {
    try {
      const oppId = Number(o.id)
      const accountId = Number(o.account_id) || 0
      const sessionId = String(o.session_id || '')
      const createdAt = Number(o.created_at) || 0
      const entered = stageEnteredAt(oppId, createdAt)
      const input: OppFactsInput = {
        opportunityId: oppId,
        accountId,
        sessionId,
        displayName: String(o.account_name || '未命名客户'),
        stage: String(o.stage || ''),
        amount: pipelineAmount(o),
        intentScore: Number(o.intent_score) || 0,
        createdAt,
        lastContactAt: lastContactMs(sessionId),
        stageEnteredAt: entered.at,
        stageEnteredFromEvent: entered.fromEvent,
        tasks: pendingTasksFor(sessionId),
        quoteSignal: latestQuoteSignal(sessionId, accountId),
        quotation: latestQuotation(accountId),
        risks: activeRisks(accountId),
        intent: latestIntent(sessionId),
        nowMs
      }
      out.push(deriveOppAssessment(input))
    } catch (e) {
      salesLog('WARN', `[OppAnalysis] 商机 #${o.id} 装配失败: ${e}`)
    }
  }
  return out
}

// ─── 阶段分析视图载荷 ────────────────────────────────────────────────────────

/** 近 N 天成交（won）：以 opportunity_event 的 won 事件时刻为准（成交关闭的权威时刻） */
function wonInWindow(days: number, nowMs: number): { count: number; amount: number } {
  const cutoff = nowMs - days * DAY_MS
  const rows = crmDbService.all(
    `SELECT o.amount_cny AS amount_cny, o.amount AS amount FROM opportunity_event e
     JOIN opportunity o ON o.id = e.opportunity_id
     WHERE e.event_type = 'won' AND e.created_at >= ? AND o.status = 'won'`,
    [cutoff]
  )
  let amount = 0
  for (const r of rows) amount += pipelineAmount(r)
  return { count: rows.length, amount }
}

/**
 * 阶段分析视图载荷：管道总览 + 按 stage 分段（仅 active）+ 各段优先处理名单。
 * 「最大卡点」按滞留数与滞留金额双指标同时最大标注，不合成单一分数。
 */
export function buildOpportunityAnalysis(nowMs: number = Date.now()): OpportunityAnalysisResult {
  const all = collectOpportunityAssessments(nowMs)

  const stages: OpportunityStageSegment[] = PIPELINE_STAGES.map((stage) => {
    const inStage = all.filter((a) => a.stage === stage)
    const stuck = inStage.filter((a) => a.stuck)
    return {
      stage,
      count: inStage.length,
      amount: inStage.reduce((s, a) => s + a.amount, 0),
      thresholdDays: inStage[0]?.stageDwellThreshold ?? null,
      stuckCount: stuck.length,
      stuckAmount: stuck.reduce((s, a) => s + a.amount, 0),
      isMaxStuck: false,
      candidates: rankCandidates(inStage)
    }
  })

  // 最大卡点：滞留数与滞留金额**同时**最大才算（防巨单劫持，也不合成综合分）
  const maxStuckCount = Math.max(0, ...stages.map((s) => s.stuckCount))
  const maxStuckAmount = Math.max(0, ...stages.map((s) => s.stuckAmount))
  for (const s of stages) {
    s.isMaxStuck = maxStuckCount > 0 && s.stuckCount === maxStuckCount && s.stuckAmount === maxStuckAmount
  }

  const stuckAll = all.filter((a) => a.stuck)
  const won = wonInWindow(WON_WINDOW_DAYS, nowMs)
  return {
    overview: {
      activeCount: all.length,
      activeAmount: all.reduce((s, a) => s + a.amount, 0),
      stuckCount: stuckAll.length,
      stuckAmount: stuckAll.reduce((s, a) => s + a.amount, 0),
      wonCount30d: won.count,
      wonAmount30d: won.amount
    },
    stages,
    generatedAt: nowMs
  }
}
