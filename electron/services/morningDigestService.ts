/**
 * 开工简报事实版：生成是显式命令，读取不扫描、不调用模型。
 *
 * 定位修正（2026-09-12，实施契约 `docs/规划/AI简报与按需识别-PRD-v1.0.md` §5.1/§6.1）：
 *  · 六态齐备，任何失败/额度阻断都不得显示为「无风险/无需跟进/全部跟完」；
 *  · coverage 从静态文案改为真实游标区间（W3b），由 `ai_scan_cursor` 派生，不猜；
 *  · 两阶段落盘保证首屏时间预算：阶段一本地事实先落盘（不调模型），阶段二批量扫描后合并；
 *  · 每天第一次打开生成一轮，按「自然日 + 账号」双键幂等；失败的快照不占幂等位（允许重试）；
 *  · 「可选 AI 整理」默认关闭 —— `parseAiDigest` 不发起任何调用。
 */
import { getUnifiedSignals, type UnifiedSignal } from './salesActionEngine'
import { salesDbService, type ReportSnapshot } from './salesDbService'
import { enqueueSalesTask } from './salesQueue'
import { identifyCoordinator, salesFollowUpService, type DigestScanOutcome } from './salesFollowUpService'
import { isAiConfigured } from './ai/aiApiClient'
import type { ConfigService } from './config'

export interface DigestItem {
  itemKey?: string
  taskId?: number
  sessionId: string
  displayName: string
  reason: string
  group?: 'must' | 'suggested' | 'update'
  dueAt?: number | null
  status?: string
  channel?: string
}

/** 简报六态（PRD §6.1） */
export type DigestState =
  /** 新账号，无聊天也无任务 */
  | 'empty_account'
  /** 无聊天但有 CRM 事项（标注无聊天依据） */
  | 'crm_only'
  /** 有待处理数据 */
  | 'pending_data'
  /** 全部覆盖且无有效待办 */
  | 'all_covered_clear'
  /** 分析失败或额度阻断 */
  | 'failed_or_blocked'
  /** 只有旧快照（禁止冒充今日最新结论） */
  | 'stale_snapshot'

export interface DigestCoverage {
  state: DigestState
  /** 展示文案；不得出现「无风险/无需跟进/全部跟完」等错误结论 */
  message: string
  /** 覆盖区间起点（秒，WCDB 口径）；未知为 null */
  from: number | null
  /** 覆盖区间终点（秒）；未知为 null */
  to: number | null
  /** 未处理会话数（截断或额度阻断造成） */
  pending: number
  /** 本账号私聊会话总数 */
  activeSessions: number
  /** 本轮实际调用模型的会话数 */
  analyzedSessions: number
  /** 本轮失败会话数 */
  failedSessions: number
  /** 数据来源：fresh=本次生成 / snapshot=复用当日已有快照 */
  source: 'fresh' | 'snapshot'
  /** 失败/阻断原因（state='failed_or_blocked' 时必有） */
  reason?: string
  /** 快照生成时间（state='stale_snapshot' 时展示原生成时间） */
  snapshotAt?: number
}

export interface MorningDigest {
  date: string
  items: DigestItem[]
  text: string
  aiUsed: boolean
  createdAt: number
  coverage?: DigestCoverage
}

const PERIOD_TYPE = 'morning_digest'
/** 单轮最多处理的会话数（PRD §5.1「每轮最多处理 20 个会话」） */
const ROUND_SESSION_LIMIT = 20
/** 首启最多回看天数（PRD §5.1「首轮截断：首启最多回看 7 天」） */
const FIRST_RUN_LOOKBACK_DAYS = 7
/** 「重新生成简报」最多循环的轮数：轮数是 ⌈活跃会话数/20⌉，此处设上限防长尾空转 */
const MAX_MANUAL_ROUNDS = 5

export function localDateString(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
}

/** 保留历史接口；开工入口不再要求在此时段在线。 */
export function isInDigestWindow(now: Date): boolean { return now.getHours() === 8 && now.getMinutes() >= 5 && now.getMinutes() < 35 }

/** 事实版正文：只罗列业务事实，不做「有没有风险」的结论。 */
export function buildFallbackDigest(signals: UnifiedSignal[], date: string): MorningDigest {
  const end = new Date(`${date}T23:59:59`).getTime()
  const items: DigestItem[] = signals.map(s => {
    const task = s.sources.find(source => source.type === 'task')
    return {
      itemKey: s.itemKey || `task:${task?.rawTaskId || s.sessionId}`, taskId: task?.rawTaskId,
      sessionId: s.sessionId, displayName: s.displayName,
      reason: s.sources.map(source => source.reason || source.label).filter(Boolean).join('；') || '查看业务事项',
      group: (s.dueAt && s.dueAt <= end) || s.urgencyTier === 'urgent' ? 'must' as const : 'suggested' as const,
      dueAt: s.dueAt, status: s.status, channel: '查看事项后选择沟通方式'
    }
  }).sort((a, b) => Number(b.group === 'must') - Number(a.group === 'must'))
  return {
    date, items, aiUsed: false, createdAt: 0,
    text: items.length ? `当前 ${items.length} 个业务事项` : '当前暂无已记录的待办；聊天分析覆盖尚未核验。'
  }
}

/** 旧接口保留给历史测试/调用；事实版不发送该提示词。 */
export function buildDigestPrompt(signals: UnifiedSignal[]): string { return signals.slice(0, 20).map(s => `${s.sessionId}|${s.sources.map(x => x.reason).join('；')}`).join('\n') }

/** 「可选 AI 整理」默认关闭：不发起调用，恒返回 null（调用方走事实版）。 */
export function parseAiDigest(_text: string, _signals: UnifiedSignal[], _date: string): MorningDigest | null { return null }

/** 秒级时间戳 → 「M月D日 HH:mm」；0/非法值返回空串（不伪造时间） */
function fmtSec(sec: number | null): string {
  if (!sec || !Number.isFinite(sec) || sec <= 0) return ''
  const d = new Date(sec * 1000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 覆盖区间展示文案；区间未知时明确说「未知」而不是省略 */
/**
 * `crm_only` 文案：**「没有聊天数据」与「未配置 AI、聊天没分析」是两件不同的事**。
 * decideState 的 `!aiConfigured && itemCount>0` 分支不看 hasChat（竞态下可能仍有聊天），
 * 若一律说「本账号暂无聊天数据」就是在陈述与事实相反的内容，故按 activeSessions 分流。
 */
export function crmOnlyMessage(activeSessions: number): string {
  return activeSessions > 0
    ? '未配置 AI 模型，聊天未分析；以下仅为已记录的业务事实待办（无聊天依据）'
    : '本账号暂无聊天数据，以下仅为已记录的业务事实待办（无聊天依据）'
}

function rangeText(from: number | null, to: number | null): string {
  const a = fmtSec(from), b = fmtSec(to)
  if (!a && !b) return '覆盖区间未知'
  return `覆盖 ${a || '未知'}—${b || '未知'}`
}

/**
 * 六态裁决（PRD §6.1）。顺序即优先级：失败/阻断永远压过「看起来没事」。
 * 关键纪律：**没看**（未配置、被截断、被阻断）绝不能裁决为「没有待跟进事项」。
 */
function decideState(input: {
  aiConfigured: boolean
  scanFailed: boolean
  blocked: boolean
  hasChat: boolean
  itemCount: number
  partial: boolean
}): DigestState {
  if (input.blocked || input.scanFailed) return 'failed_or_blocked'
  if (!input.aiConfigured) {
    if (input.itemCount > 0) return 'crm_only'
    if (input.hasChat) return 'failed_or_blocked'
    return 'empty_account'
  }
  if (!input.hasChat && input.itemCount > 0) return 'crm_only'
  if (!input.hasChat) return 'empty_account'
  if (input.itemCount > 0) return 'pending_data'
  // 无事项但覆盖不全（截断/失败）→ 不许说「当前没有待跟进事项」
  if (input.partial) return 'failed_or_blocked'
  return 'all_covered_clear'
}

class MorningDigestService {
  /** 依赖注入（main.ts 装配）；未注入时按「未配置 AI」处理，绝不假装分析过 */
  private config: ConfigService | null = null
  private pending = new Map<string, Promise<MorningDigest>>()

  setConfig(config: ConfigService): void { this.config = config }

  /** 读最近快照；跨天或降级状态在此叠加展示口径（读取不扫描、不调用模型） */
  getLatestDigest(): MorningDigest | null {
    if (!salesDbService.isInitialized()) throw new Error('业务库尚未就绪，请稍后重试')
    const row = salesDbService.reportLatestByType(PERIOD_TYPE)
    if (!row) return null
    const result = this.rowToDigest(row)
    // 快照正文不改写；投影叠加任务现行状态。
    result.items = result.items.map(item => ({ ...item, status: item.taskId ? salesDbService.getTask(item.taskId)?.status || 'unavailable' : item.status }))
    // 只有旧快照：显式降级，禁止冒充今日最新结论
    const today = localDateString(new Date())
    if (result.date !== today) {
      result.coverage = {
        from: null, to: null, pending: 0, activeSessions: 0, analyzedSessions: 0, failedSessions: 0,
        source: 'snapshot', snapshotAt: result.createdAt,
        state: 'stale_snapshot',
        message: `${result.date} 的快照（生成于 ${fmtSec(Math.floor(result.createdAt / 1000)) || '未知时间'}），正在核对今日情况`
      }
    }
    return result
  }

  /** 每天第一次打开今日行动页触发；同日幂等，失败的快照不占幂等位（允许重试） */
  async generateTodayDigest(): Promise<MorningDigest> {
    const existing = this.getLatestDigest()
    const today = localDateString(new Date())
    if (existing?.date === today && existing.coverage?.state !== 'failed_or_blocked' && existing.coverage?.state !== 'stale_snapshot') {
      return existing
    }
    return this.generate(false, 1)
  }

  /**
   * 「重新生成简报」全局入口（PRD §5.3）：与早间简报同一管线、同一六态。
   * 轮数上限按 ⌈活跃会话数/20⌉，但设硬上限防长尾空转；中断时保留已有结果并报「部分未完成」。
   */
  async regenerateToday(): Promise<MorningDigest> { return this.generate(true, MAX_MANUAL_ROUNDS) }

  private generate(replace: boolean, maxRounds: number): Promise<MorningDigest> {
    const scope = salesDbService.captureScope()
    const key = `${scope}:${localDateString(new Date())}`
    const inflight = this.pending.get(key)
    if (inflight) return inflight

    const task = enqueueSalesTask(async () => {
      if (scope !== salesDbService.captureScope() || !salesDbService.isInitialized()) throw new Error('账号已切换或业务库未就绪')
      const today = localDateString(new Date())
      const existing = this.getLatestDigest()
      if (!replace && existing?.date === today && existing.coverage?.state !== 'failed_or_blocked') return existing

      // 单飞（PRD §4.7 全局作用域）：别的识别在跑就不抢，直接给本地事实 + 明确说明，不排队堆积
      const release = identifyCoordinator.acquire('digest', '早间简报')
      if (!release) {
        const local = await this.buildLocalOnly(today, scope, '正在识别客户，简报稍后自动更新')
        return local
      }
      try {
        return await this.buildDigest(today, scope, maxRounds)
      } finally {
        release()
      }
    }).finally(() => this.pending.delete(key))
    this.pending.set(key, task)
    return task
  }

  /** 阶段一：只读本地事实（零模型调用）。单飞被占用时也走这里，保证首屏有话可说。 */
  private async buildLocalOnly(today: string, scope: string, reason: string): Promise<MorningDigest> {
    const result = await getUnifiedSignals()
    if (scope !== salesDbService.captureScope()) throw new Error('账号已切换，已放弃旧简报')
    const digest = buildFallbackDigest(result.signals, today)
    return { ...digest, createdAt: Date.now(), coverage: this.degradedCoverage(reason) }
  }

  /** 已知降级（单飞被占用 / 库未连接）的 coverage 装配 */
  private degradedCoverage(reason: string): DigestCoverage {
    return {
      state: 'failed_or_blocked', from: null, to: null, pending: 0, activeSessions: 0, analyzedSessions: 0,
      failedSessions: 0, source: 'fresh', reason, message: `${reason}；已展示已有业务事实，聊天分析未完成`
    }
  }

  private async buildDigest(today: string, scope: string, maxRounds: number): Promise<MorningDigest> {
    // ── 阶段一：本地事实先落盘 —— 保证 2s 内首屏有内容，且此后不会因阶段二失败而变空
    const facts = await getUnifiedSignals()
    if (scope !== salesDbService.captureScope()) throw new Error('账号已切换，已放弃旧简报')
    const firstPass = buildFallbackDigest(facts.signals, today)
    this.persist(today, firstPass)

    // ── 阶段二：批量扫描（AI），最多 maxRounds 轮，每轮 ROUND_SESSION_LIMIT 个会话
    if (!this.config || !isAiConfigured(this.config)) {
      // 未配置 AI：有事实 → 事实版（标注无聊天依据）；无事实 → 新账号空态。两种都不调 AI 凑摘要。
      const crmOnly = firstPass.items.length > 0
      const digest: MorningDigest = {
        ...firstPass, createdAt: Date.now(),
        coverage: {
          state: crmOnly ? 'crm_only' : 'empty_account',
          from: null, to: null, pending: 0, activeSessions: 0,
          analyzedSessions: 0, failedSessions: 0, source: 'fresh',
          reason: '未配置 AI 模型',
          message: crmOnly ? '未配置 AI 模型，聊天未分析；以下仅为已记录的业务事实' : '暂无客户沟通和待办'
        }
      }
      this.persist(today, digest)
      return digest
    }

    let scanned: DigestScanOutcome = {
      aiConfigured: true, processed: 0, newTasks: 0, skipped: 0, failed: 0, pending: 0, activeSessions: 0, fromSec: 0, toSec: 0
    }
    let rounds = 0
    let scanError = ''
    while (rounds < Math.max(1, maxRounds)) {
      const round = await salesFollowUpService.scanSessionsForDigest(this.config, {
        maxSessions: ROUND_SESSION_LIMIT,
        lookbackDays: FIRST_RUN_LOOKBACK_DAYS
      })
      rounds++
      scanned = {
        ...scanned,
        aiConfigured: round.aiConfigured,
        processed: scanned.processed + round.processed,
        newTasks: scanned.newTasks + round.newTasks,
        skipped: scanned.skipped + round.skipped,
        failed: scanned.failed + round.failed,
        pending: round.pending,
        activeSessions: round.activeSessions || scanned.activeSessions,
        fromSec: scanned.fromSec === 0 ? round.fromSec : (round.fromSec === 0 ? scanned.fromSec : Math.min(scanned.fromSec, round.fromSec)),
        toSec: Math.max(scanned.toSec, round.toSec)
      }
      if (round.error) scanError = round.error
      // 无新增可处理的（pending=0）就停：不要空转烧钱
      if (round.pending <= 0) break
      if (round.error) break
    }

    if (scope !== salesDbService.captureScope()) throw new Error('账号已切换，已放弃旧简报')

    // 扫描后重取事实：新产出的待办要出现在简报里
    const enrichedFacts = await getUnifiedSignals()
    if (scope !== salesDbService.captureScope()) throw new Error('账号已切换，已放弃旧简报')
    const digest = buildFallbackDigest(enrichedFacts.signals, today)

    const partial = scanned.pending > 0 || scanned.failed > 0
    const scanFailed = !scanned.aiConfigured || (scanned.failed > 0 && scanned.processed === 0) || (!!scanError && scanned.processed === 0)
    // 额度阻断优先于普通失败：它必须显示为「被阻断」，不得被说成「无风险/全部跟完」
    const blocked = !!scanned.blockedReason
    const state = decideState({
      aiConfigured: scanned.aiConfigured,
      scanFailed,
      blocked,
      hasChat: scanned.activeSessions > 0,
      itemCount: digest.items.length,
      partial
    })

    const reason = blocked ? scanned.blockedReason : (scanFailed ? (scanError || '聊天分析未完成') : undefined)
    digest.coverage = this.assembleCoverage(state, scanned, reason, digest.items.length, partial)
    digest.createdAt = Date.now()
    this.persist(today, digest)
    return digest
  }

  /** 按六态装配展示文案（文案纪律：不得出现「无风险/无需跟进/全部跟完」） */
  private assembleCoverage(
    state: DigestState, scanned: DigestScanOutcome, reason: string | undefined, itemCount: number, partial: boolean
  ): DigestCoverage {
    const base = {
      from: scanned.fromSec > 0 ? scanned.fromSec : null,
      to: scanned.toSec > 0 ? scanned.toSec : null,
      pending: scanned.pending,
      activeSessions: scanned.activeSessions,
      analyzedSessions: scanned.processed,
      failedSessions: scanned.failed,
      source: 'fresh' as const,
      reason
    }
    switch (state) {
      case 'empty_account':
        return { ...base, state, message: '暂无客户沟通和待办' }
      case 'crm_only':
        return { ...base, state, message: crmOnlyMessage(scanned.activeSessions) }
      case 'all_covered_clear':
        return { ...base, state, message: `已核对 ${rangeText(base.from, base.to)}，当前没有待跟进事项` }
      case 'failed_or_blocked': {
        const gap = scanned.pending > 0 ? `，另有 ${scanned.pending} 个会话未处理` : ''
        const kept = itemCount > 0 ? '；已展示已有事实' : ''
        return { ...base, state, message: `${reason || '聊天分析未完成'}${gap}${kept}` }
      }
      case 'pending_data':
      default: {
        const gap = scanned.pending > 0 ? ` · 另有 ${scanned.pending} 个会话未处理` : ''
        const slow = partial ? ' · 部分未完成' : ''
        return { ...base, state, message: `已梳理 ${scanned.processed}/${scanned.activeSessions} 个会话 · ${rangeText(base.from, base.to)}${gap}${slow}` }
      }
    }
  }

  /** 落盘：同日单行，覆盖旧行；失败抛错由调用方处理（不把空摘要伪装成成功） */
  private persist(today: string, digest: MorningDigest): void {
    const start = new Date(); start.setHours(0, 0, 0, 0)
    salesDbService.reportDeleteByTypeAndDate(PERIOD_TYPE, today)
    salesDbService.reportCreate({
      period_type: PERIOD_TYPE,
      period_start: start.getTime(),
      period_end: start.getTime() + 86400000 - 1,
      stats: JSON.stringify({ items: digest.items, aiUsed: digest.aiUsed, coverage: digest.coverage }),
      ai_summary: digest.text
    })
  }

  private rowToDigest(row: ReportSnapshot): MorningDigest {
    const parsed = JSON.parse(row.stats || '{}')
    return { date: localDateString(new Date(row.period_start)), items: Array.isArray(parsed.items) ? parsed.items : [], text: row.ai_summary || '', aiUsed: !!parsed.aiUsed, createdAt: row.created_at || 0, coverage: parsed.coverage }
  }
}

export const morningDigestService = new MorningDigestService()

/** 测试出口：纯函数，便于对六态/区间文案做穷举断言（不暴露任何状态） */
export const __testing = { decideState, crmOnlyMessage, rangeText, localDateString, ROUND_SESSION_LIMIT, FIRST_RUN_LOOKBACK_DAYS, MAX_MANUAL_ROUNDS }
