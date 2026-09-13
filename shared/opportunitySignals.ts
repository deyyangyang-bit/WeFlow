/**
 * opportunitySignals.ts —— 商机确定性信号：**唯一事实源**（纯函数，零 IO、零依赖、零模型调用）
 *
 * 设计依据：`docs/规划` 商机合并 v2.1 设计稿（附页「字段来源与交互规则」）。
 * 本模块只做「已落库字段 → 人话理由 + 排序层」的投影，不新建候选、不落库、不调 AI。
 *
 * 消费方（同一份事实，两个视图，禁止各算一套）：
 *   1. `opportunityAnalysisService` → 阶段分析视图的优先处理名单
 *   2. `salesActionEngine.getUnifiedSignals` → 早间简报 / 今日行动 / 客户工作台卡流
 *
 * 数据语义纪律（违反即为编造）：
 *   - 「报价发出后未获回复」只能由 `quote_signal`（crmDb 报价业务真源）判定：
 *     `quoted_at` 已过 且 `customer_replied_at = 0`。`quotation`/`quote_version` 只证明
 *     报价**记录创建**，不得用于断言「已发送 / 未回复」。
 *   - 关联不稳定（quote_signal 的 session/account 对不上本商机）时，文案必须降级为
 *     「报价记录创建 X 天」，不得保留「未回复」字样。
 *   - `follow_up_task.due_at` 是**销售自己承诺的截止**，不等于客户承诺答复时间。
 *   - 阶段滞留以 `opportunity_event` 的 stage_change 时刻为准；无该事件时回退商机创建时刻，
 *     且文案降级为「进入该阶段至少 X 天」（不假装知道精确入段时刻）。
 */

/** 阶段滞留阈值（天）：了解 7 / 比价 3 / 决策 2。
 *  初值来自设计稿附页，可按真实节奏调整；成交段不适用滞留（won/lost 不进管道）。 */
export const STAGE_DWELL_DAYS: Record<string, number> = { 了解: 7, 比价: 3, 决策: 2 }

/** 管道阶段（active 商机参与漏斗分段）；成交/流失不在此列 */
export const PIPELINE_STAGES = ['了解', '比价', '决策'] as const

const DAY_MS = 86400000

/** 取阶段滞留阈值；未知阶段返回 null（不适用滞留，不参与卡点判定） */
export function dwellThresholdDays(stage: string): number | null {
  const v = STAGE_DWELL_DAYS[String(stage || '')]
  return typeof v === 'number' ? v : null
}

/** 毫秒差 → 整天数（向下取整，负数归零：未来时刻不算「已经过了 N 天」） */
function daysBetween(fromMs: number, nowMs: number): number {
  if (!fromMs || !nowMs) return 0
  return Math.max(0, Math.floor((nowMs - fromMs) / DAY_MS))
}

/** MM-DD（理由里的日期标注，与项目既有 fmtTime 同风格） */
function fmtMd(ms: number): string {
  if (!ms) return '—'
  const d = new Date(Number(ms))
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// ─── 输入事实（调用方从已落库字段装配，本模块不做任何查询）─────────────────────

export interface OppTaskFact {
  id: number
  title: string
  dueAt: number | null
  status: string
}

export interface OppQuoteSignalFact {
  id: number
  quotedAt: number
  customerRepliedAt: number
}

export interface OppQuotationFact {
  id: number
  createdAt: number
}

export interface OppRiskFact {
  id: number
  riskType: string
  severity: string
  detail: string
  status: string
  createdAt: number
}

export interface OppIntentFact {
  createdAt: number
  reason: string
}

export interface OppFactsInput {
  opportunityId: number
  accountId: number
  sessionId: string
  displayName: string
  stage: string
  /** 管道金额口径：amount_cny > 0 时取 amount_cny，否则取 amount（与商机详情既有展示一致） */
  amount: number
  intentScore: number
  createdAt: number
  /** 最近一次真实联系时刻（秒级 WCDB 口径已在调用方换算为毫秒）；0 = 未知 */
  lastContactAt: number
  /** 进入当前阶段的时刻 */
  stageEnteredAt: number
  /** stageEnteredAt 是否来自真实 stage_change 事件（false = 回退到创建时刻，文案需降级） */
  stageEnteredFromEvent: boolean
  /** 该客户 pending 待办（已按 due_at 升序；无则空数组） */
  tasks: OppTaskFact[]
  /** 经 session_id/account_id **稳定关联**到本商机的 quote_signal（关联不上时为 null） */
  quoteSignal: OppQuoteSignalFact | null
  /** 该客户最新报价单（无则 null）——仅用于降级文案「报价记录创建 X 天」 */
  quotation: OppQuotationFact | null
  risks: OppRiskFact[]
  intent: OppIntentFact | null
  nowMs: number
}

// ─── 输出 ────────────────────────────────────────────────────────────────────

export type OppReasonKind =
  | 'task_overdue'
  | 'task_due_today'
  | 'quote_unreplied'
  | 'quotation_created'
  | 'stage_stuck'
  | 'risk'
  | 'intent'

export interface OppReason {
  kind: OppReasonKind
  /** 人话理由（可追溯；不含任何公式或权重） */
  text: string
  /** 来源标注，界面以「来源：…」呈现 */
  source: string
  /** 确定性紧迫信号（界面红字强调） */
  hot: boolean
}

export interface OppAssessment {
  opportunityId: number
  accountId: number
  sessionId: string
  displayName: string
  stage: string
  amount: number
  intentScore: number
  reasons: OppReason[]
  /** 是否超阶段滞留阈值 */
  stuck: boolean
  stageDwellDays: number
  /** 该阶段滞留阈值；null = 该阶段不适用滞留 */
  stageDwellThreshold: number | null
  /** 是否存在到期/逾期待办 */
  hasDueTask: boolean
  /** 该客户 pending 待办条数（界面据此在「查看待办 / 建待办」之间切换；0 = 建待办） */
  pendingTaskCount: number
  overdueDays: number
  /** 确定性紧迫信号条数（决策段/报价未回/竞对/未处理风险） */
  hotSignalCount: number
  /** 沉默时长（天） */
  silentDays: number
  /** 候选资格：销售待办到期/逾期 OR 超阶段滞留阈值 */
  eligible: boolean
}

// ─── 理由构建 ────────────────────────────────────────────────────────────────

/** 待办理由：逾期优先于今日到期；due_at 是销售自己承诺的截止，文案如实表述。
 *  返回理由与逾期天数（逾期天数是排序第一层，故一并产出，避免调用方二次查找）。 */
function taskReason(tasks: OppTaskFact[], nowMs: number): { reason: OppReason; overdueDays: number } | null {
  if (!tasks.length) return null
  const due = (t: OppTaskFact) => Number(t.dueAt || 0)
  const overdue = tasks.filter((t) => due(t) > 0 && due(t) < nowMs)
  if (overdue.length) {
    const t = overdue[0]
    const overdueDays = daysBetween(due(t), nowMs)
    return {
      reason: { kind: 'task_overdue', text: `你的待办「${t.title}」已逾期 ${overdueDays} 天`, source: `待办 #${t.id}`, hot: true },
      overdueDays
    }
  }
  const today = tasks.find((t) => due(t) > 0 && daysBetween(nowMs, due(t)) === 0)
  if (today) {
    return {
      reason: { kind: 'task_due_today', text: `你的待办「${today.title}」今天到期`, source: `待办 #${today.id}`, hot: true },
      overdueDays: 0
    }
  }
  return null
}

/** 报价理由：quote_signal 可断言「未回复」；无稳定关联时降级为「报价记录创建」。
 *  已有稳定关联时**只按 quote_signal 判定**——客户已回复则该维度不产出理由，
 *  不拿 quotation 记录凑数（否则会把「已回复」说成一条待办）。 */
function quoteReason(input: OppFactsInput): OppReason | null {
  const q = input.quoteSignal
  if (q) {
    if (Number(q.customerRepliedAt) > 0) return null
    const quotedAt = Number(q.quotedAt)
    if (!(quotedAt > 0) || quotedAt > input.nowMs) return null
    return {
      kind: 'quote_unreplied',
      text: `报价发出 ${daysBetween(quotedAt, input.nowMs)} 天未获回复`,
      source: `quote_signal（quoted_at ${fmtMd(quotedAt)}，customer_replied_at 空）`,
      hot: true
    }
  }
  const qt = input.quotation
  if (!qt || !(Number(qt.createdAt) > 0)) return null
  return {
    kind: 'quotation_created',
    text: `报价记录创建 ${daysBetween(Number(qt.createdAt), input.nowMs)} 天`,
    source: `报价单 #${qt.id}（无 quote_signal 关联，不断言「未回复」）`,
    hot: false
  }
}

/** 阶段滞留理由；无 stage_change 事件时降级为「至少 X 天」（不假装知道精确入段时刻） */
function stuckReason(a: { stuck: boolean; stage: string; stageDwellDays: number; stageDwellThreshold: number | null; stageEnteredFromEvent: boolean }): OppReason | null {
  if (!a.stuck || a.stageDwellThreshold === null) return null
  const prefix = a.stageEnteredFromEvent ? `滞留${a.stage}段` : `进入${a.stage}段至少`
  return {
    kind: 'stage_stuck',
    text: `${prefix} ${a.stageDwellDays} 天（阈值 ${a.stageDwellThreshold} 天）`,
    source: a.stageEnteredFromEvent ? '阶段记录' : '阶段记录（无变更事件，按创建时刻估算）',
    hot: false
  }
}

/** 风险理由：读 crm_risk 存量 active 行，零新调用 */
function riskReasons(risks: OppRiskFact[]): OppReason[] {
  return risks
    .filter((r) => r.status === 'active')
    .slice(0, 2)
    .map((r) => ({
      kind: 'risk' as const,
      text: `${r.riskType === 'competitor' ? '竞对在跟' : '风险'}：${String(r.detail || '').slice(0, 40)}`,
      source: `风险行 #${r.id}（${fmtMd(Number(r.createdAt))}）`,
      hot: true
    }))
}

/** 意向理由：历史 AI/规则抽取产物，读取不算新调用；无意向记录时不产出（不编造） */
function intentReason(intent: OppIntentFact | null): OppReason[] {
  if (!intent || !String(intent.reason || '').trim()) return []
  return [{
    kind: 'intent',
    text: String(intent.reason).slice(0, 40),
    source: `意向记录 ${fmtMd(Number(intent.createdAt))}`,
    hot: false
  }]
}

// ─── 主投影 ──────────────────────────────────────────────────────────────────

/**
 * 把已落库事实投影为「理由列表 + 排序层 + 候选资格」。
 * 纯函数：同一输入恒等输出，便于测试与两端复用。
 */
export function deriveOppAssessment(input: OppFactsInput): OppAssessment {
  const stage = String(input.stage || '')
  const threshold = dwellThresholdDays(stage)
  const stageEnteredAt = Number(input.stageEnteredAt) || Number(input.createdAt) || 0
  const stageDwellDays = daysBetween(stageEnteredAt, input.nowMs)
  const stuck = threshold !== null && stageDwellDays > threshold

  const task = taskReason(input.tasks, input.nowMs)

  const reasons: OppReason[] = []
  if (task) reasons.push(task.reason)
  const quote = quoteReason(input)
  if (quote) reasons.push(quote)
  const stuckR = stuckReason({ stuck, stage, stageDwellDays, stageDwellThreshold: threshold, stageEnteredFromEvent: input.stageEnteredFromEvent })
  if (stuckR) reasons.push(stuckR)
  reasons.push(...riskReasons(input.risks))
  reasons.push(...intentReason(input.intent))

  const hotSignalCount = reasons.filter((r) => r.hot).length
  return {
    opportunityId: input.opportunityId,
    accountId: input.accountId,
    sessionId: input.sessionId,
    displayName: input.displayName,
    stage,
    amount: Number(input.amount) || 0,
    intentScore: Number(input.intentScore) || 0,
    reasons,
    stuck,
    stageDwellDays,
    stageDwellThreshold: threshold,
    hasDueTask: !!task,
    pendingTaskCount: input.tasks.length,
    overdueDays: task?.overdueDays ?? 0,
    hotSignalCount,
    // 沉默时长 = 距最近一次真实联系；无联系记录时为 0（不拿创建时刻冒充「沉默」）
    silentDays: input.lastContactAt > 0 ? daysBetween(input.lastContactAt, input.nowMs) : 0,
    eligible: !!task || stuck
  }
}

/**
 * 优先层排序（字典序降序），界面不展示公式：
 *   ① 逾期时点（越久越前）→ ② 确定性紧迫信号条数 → ③ 价值与意向 → ④ 沉默时长
 * 并列时按商机 id 升序，保证顺序稳定可复现。
 */
export function compareByUrgency(a: OppAssessment, b: OppAssessment): number {
  if (a.overdueDays !== b.overdueDays) return b.overdueDays - a.overdueDays
  if (a.hotSignalCount !== b.hotSignalCount) return b.hotSignalCount - a.hotSignalCount
  if (a.amount !== b.amount) return b.amount - a.amount
  if (a.intentScore !== b.intentScore) return b.intentScore - a.intentScore
  if (a.silentDays !== b.silentDays) return b.silentDays - a.silentDays
  return a.opportunityId - b.opportunityId
}

/** 排序后的候选名单：只保留有候选资格的商机（待办到期/逾期 或 超阶段滞留阈值） */
export function rankCandidates(list: OppAssessment[]): OppAssessment[] {
  return list.filter((a) => a.eligible).sort(compareByUrgency)
}

// ─── 阶段分析视图载荷（纯数据形状，渲染层与主进程共用同一份定义）──────────────────

export interface OpportunityStageSegment {
  stage: string
  /** 该段 active 商机数 */
  count: number
  /** 该段 active 商机金额合计 */
  amount: number
  /** 阶段滞留阈值（天）；null = 该段不适用滞留 */
  thresholdDays: number | null
  stuckCount: number
  stuckAmount: number
  /** 最大卡点标记：滞留数与滞留金额双指标同时最大时为 true（不输出单一综合分） */
  isMaxStuck: boolean
  /** 该段优先处理名单（已按优先层排序，界面不展示公式） */
  candidates: OppAssessment[]
}

export interface OpportunityAnalysisOverview {
  /** 进行中（active）商机数 / 金额 */
  activeCount: number
  activeAmount: number
  /** 超阶段阈值的滞留商机数 / 金额 */
  stuckCount: number
  stuckAmount: number
  /** 近 30 天成交（won，不计入管道）数 / 金额 */
  wonCount30d: number
  wonAmount30d: number
}

export interface OpportunityAnalysisResult {
  overview: OpportunityAnalysisOverview
  stages: OpportunityStageSegment[]
  generatedAt: number
}
