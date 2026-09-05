/**
 * morningDigestService.ts —— 晨间摘要（设计-AI见解重定位 §3.1，阶段二 a）
 * 每日一条「今天先跟谁」：getUnifiedSignals top 10 → 单次 LLM 生成 3 条人话理由；
 * AI 未配置/失败 → 降级为 priorityScore top 3 规则拼接（摘要永远有，AI 只负责更好读）。
 * 落库复用 report_snapshot（period_type='morning_digest'，现存唯一「周期级 AI 文本」容器，不建新表）：
 *   stats = JSON { items: DigestItem[], aiUsed: boolean }，ai_summary = 人话正文。
 * 同日幂等：当天已有摘要则 generate 直接返回；regenerate 删当天旧行重建。
 * 纯函数（buildFallbackDigest/parseAiDigest/isInDigestWindow）零依赖可单测。
 */
import { getUnifiedSignals, type UnifiedSignal } from './salesActionEngine'
import { salesDbService, type ReportSnapshot } from './salesDbService'
import { isAiConfigured, simpleCompletion } from './ai/aiApiClient'
import type { ConfigService } from './config'
import { enqueueSalesTask } from './salesQueue'

export interface DigestItem {
  sessionId: string
  displayName: string
  reason: string
}

export interface MorningDigest {
  date: string // YYYY-MM-DD（本地时区）
  items: DigestItem[]
  text: string // 人话正文（降级路径也有）
  aiUsed: boolean
  createdAt: number
}

const PERIOD_TYPE = 'morning_digest'
const DIGEST_TOP_N = 3
const DIGEST_POOL_N = 10

// ─── 纯函数（零依赖，可单测）─────────────────────────────────────────────────

/** 08:05-08:35 生成窗口（仿 startActionEngineScheduler 时间窗语义，错开 08:00 全量扫描） */
export function isInDigestWindow(now: Date): boolean {
  return now.getHours() === 8 && now.getMinutes() >= 5 && now.getMinutes() < 35
}

export function localDateString(now: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
}

function signalLine(s: UnifiedSignal): string {
  const reasons = s.sources.map((src) => src.reason || src.label).filter(Boolean).join('；')
  return `${s.displayName}（阶段:${s.stage || '未知'}，沉默${Math.floor(s.silentDays)}天）：${reasons || '待跟进'}`
}

/** 降级路径：priorityScore top 3 + 规则理由拼接，零 AI */
export function buildFallbackDigest(signals: UnifiedSignal[], date: string): MorningDigest {
  const top = signals.slice(0, DIGEST_TOP_N)
  const items: DigestItem[] = top.map((s) => ({
    sessionId: s.sessionId,
    displayName: s.displayName,
    reason: s.sources.map((src) => src.reason || src.label).filter(Boolean).join('；') || '优先跟进'
  }))
  const text = items.length === 0
    ? '今日无待跟进信号。'
    : `今天建议优先跟进 ${items.length} 位客户：\n` + items.map((it, i) => `${i + 1}. ${it.displayName}——${it.reason}`).join('\n')
  return { date, items, text, aiUsed: false, createdAt: 0 }
}

/** 构造 LLM user prompt（卡片清单，不含聊天原文——原文不出本机铁律） */
export function buildDigestPrompt(signals: UnifiedSignal[]): string {
  const lines = signals.slice(0, DIGEST_POOL_N).map((s) => `- sessionId=${s.sessionId}｜${signalLine(s)}｜优先级分=${s.priorityScore}`)
  return `以下是今日待跟进客户卡片（按优先级排序）：\n${lines.join('\n')}\n\n请挑出最值得今天先动的 ${DIGEST_TOP_N} 个，每个给一句不超过 40 字的人话理由（说清"为什么是今天"）。严格按如下格式输出，每行一条，不要任何额外文字：\nsessionId|理由`
}

const DIGEST_SYSTEM_PROMPT = '你是 B2B 销售晨间规划助手。只根据给定卡片清单挑选今天最优先跟进的客户并给出简短理由，严格按指定格式输出，不编造清单外的客户。'

/** 解析 AI 输出（sessionId|理由 行）；只保留输入清单内的 sessionId（防幻觉），全不匹配返回 null → 走降级 */
export function parseAiDigest(aiText: string, signals: UnifiedSignal[], date: string): MorningDigest | null {
  const known = new Map(signals.map((s) => [s.sessionId, s]))
  const items: DigestItem[] = []
  for (const rawLine of aiText.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    const sep = line.indexOf('|')
    if (sep <= 0) continue
    const sessionId = line.slice(0, sep).trim()
    const reason = line.slice(sep + 1).trim().slice(0, 80)
    const sig = known.get(sessionId)
    if (!sig || !reason) continue
    items.push({ sessionId, displayName: sig.displayName, reason })
    if (items.length >= DIGEST_TOP_N) break
  }
  if (items.length === 0) return null
  const text = `今天建议优先跟进 ${items.length} 位客户：\n` + items.map((it, i) => `${i + 1}. ${it.displayName}——${it.reason}`).join('\n')
  return { date, items, text, aiUsed: true, createdAt: 0 }
}

// ─── 服务壳 ──────────────────────────────────────────────────────────────────

class MorningDigestService {
  private config: ConfigService | null = null
  private timer: NodeJS.Timeout | null = null

  setConfig(config: ConfigService): void {
    this.config = config
  }

  /** 读取最近一次摘要（优先当天；无当天则最近历史），无记录返回 null */
  getLatestDigest(): MorningDigest | null {
    if (!salesDbService.isInitialized()) return null
    const row = salesDbService.reportLatestByType(PERIOD_TYPE)
    if (!row) return null
    return this.rowToDigest(row)
  }

  /** 获取今日摘要：当天已有直接返回（幂等），没有则生成 */
  async generateTodayDigest(): Promise<MorningDigest> {
    const today = localDateString(new Date())
    const existing = this.getLatestDigest()
    if (existing && existing.date === today) return existing
    return this.buildAndPersist(today)
  }

  /** 手动重新生成（覆盖当天旧行；用户测试入口，不必等早上 8 点） */
  async regenerateToday(): Promise<MorningDigest> {
    const today = localDateString(new Date())
    salesDbService.reportDeleteByTypeAndDate(PERIOD_TYPE, today)
    return this.buildAndPersist(today)
  }

  private async buildAndPersist(today: string): Promise<MorningDigest> {
    let signals: UnifiedSignal[] = []
    try {
      const result = await getUnifiedSignals()
      signals = result.signals
    } catch (e) {
      console.warn('[MorningDigest] 信号流获取失败，按空信号降级:', e)
    }

    let digest: MorningDigest | null = null
    if (signals.length > 0 && this.config && isAiConfigured(this.config)) {
      try {
        const aiText = await simpleCompletion(this.config, DIGEST_SYSTEM_PROMPT, buildDigestPrompt(signals))
        digest = parseAiDigest(aiText, signals, today)
      } catch (e) {
        console.warn('[MorningDigest] AI 摘要生成失败，走降级:', e)
      }
    }
    if (!digest) digest = buildFallbackDigest(signals, today)

    const now = Date.now()
    const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0)
    salesDbService.reportCreate({
      period_type: PERIOD_TYPE,
      period_start: dayStart.getTime(),
      period_end: dayStart.getTime() + 86400000 - 1,
      stats: JSON.stringify({ items: digest.items, aiUsed: digest.aiUsed }),
      ai_summary: digest.text
    })
    console.log(`[MorningDigest] ${today} 摘要已生成：${digest.items.length} 条（aiUsed=${digest.aiUsed}）`)
    return { ...digest, createdAt: now }
  }

  private rowToDigest(row: ReportSnapshot): MorningDigest {
    let items: DigestItem[] = []
    let aiUsed = false
    try {
      const parsed = JSON.parse(row.stats || '{}') as { items?: DigestItem[]; aiUsed?: boolean }
      items = Array.isArray(parsed.items) ? parsed.items : []
      aiUsed = !!parsed.aiUsed
    } catch { /* 老行/坏 JSON 按空条目处理 */ }
    return {
      date: localDateString(new Date(row.period_start)),
      items,
      text: row.ai_summary || '',
      aiUsed,
      createdAt: row.created_at ?? 0
    }
  }

  /** 每日 08:05-08:35 窗口调度（仿 startActionEngineScheduler）；「今日已生成」以 report_snapshot 落库行为准，重启不重复 */
  startScheduler(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      const now = new Date()
      if (!isInDigestWindow(now)) return
      const existing = this.getLatestDigest()
      if (existing && existing.date === localDateString(now)) return
      enqueueSalesTask(() => this.generateTodayDigest()).catch((e) => {
        console.error('[MorningDigest] 定时生成失败:', e)
      })
    }, 30 * 60 * 1000)
  }

  stopScheduler(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
  }
}

export const morningDigestService = new MorningDigestService()
