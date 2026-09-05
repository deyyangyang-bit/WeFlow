/**
 * insightNoiseFilter.ts —— AI 见解噪音过滤器（设计-AI见解重定位 §2.1）
 *
 * 解决的问题：外部自动化工具（群发、删好友检测脚本）写入微信库的消息被当成客户行为：
 * - 群发「去看看」→ N 个会话同时出现新消息 → 触发 N 次 AI 扫描（扫描风暴）
 * - 系统消息（type 10000「你已添加了…」）isSend=0 → 在上下文里冒充对方发言
 *
 * 三件套：
 * - classifyInsightMessage：消息三分类（customer / own / system）
 * - scanMessagesForTrigger：触发扫描纯函数——只有「新且是客户发的」消息才值得触发 AI 见解
 * - MassSendDetector：群发模板被动检测（同内容 ≥3 会话 / 72h 内 → 标记 48h）
 *
 * 零 electron / chatService 依赖：消息用结构化最小类型（chatService.Message 结构兼容），
 * 可 tsx 单测（scripts/insight-noise-test.ts）。
 */

/** 消息最小结构（chatService.Message 的结构子集，解耦以便单测） */
export interface InsightNoiseMessageLike {
  localType: number
  isSend: number | null
  createTime: number
  parsedContent?: string
  rawContent?: string
}

export type InsightMessageClass = 'customer' | 'own' | 'system'

/** 微信系统类消息 localType：10000=系统提示（你已添加了…/撤回等），266287972401=拍一拍 */
const SYSTEM_LOCAL_TYPES = new Set<number>([10000, 266287972401])

/**
 * 见解视角的消息三分类：
 * - system：微信/自动化工具产生的系统类消息，不代表任何一方的发言
 * - own：我方发出（含群发）；文本部分供群发模板检测采集
 * - customer：客户发来的实质消息，唯一值得触发 AI 见解的类型
 */
export function classifyInsightMessage(msg: InsightNoiseMessageLike): InsightMessageClass {
  if (SYSTEM_LOCAL_TYPES.has(Number(msg.localType))) return 'system'
  if (msg.isSend === 1) return 'own'
  return 'customer'
}

/** 窗口内我方文本消息（供群发检测器采集） */
export interface OwnTextHit {
  content: string
  createTime: number
}

export interface TriggerScanResult {
  /** 窗口内存在「新且是客户发的」消息 → 才触发 AI 见解 */
  shouldTrigger: boolean
  /** 窗口内最新时间戳（无论是否触发，调用方都应把 lastSeen 推进到该值） */
  latestTs: number
  /** 窗口内新出现的我方文本消息（喂 MassSendDetector） */
  ownTexts: OwnTextHit[]
}

/** 提取消息正文（文本消息 parsedContent/rawContent 即正文；XML 载荷由调用方按需降级） */
function messageTextContent(msg: InsightNoiseMessageLike): string {
  return String(msg.parsedContent || '').trim() || String(msg.rawContent || '').trim()
}

/**
 * 触发扫描（纯函数，不依赖消息顺序）：
 * - 有任一 customer 消息 createTime > lastSeenTs → shouldTrigger
 * - 只有自己的群发/系统消息更新 → 不触发（群发风暴根除）
 * - lastSeenTs 传 0 可采集窗口内全部 own 文本（画像/上下文加载点复用）
 */
export function scanMessagesForTrigger(
  messages: InsightNoiseMessageLike[],
  lastSeenTs: number
): TriggerScanResult {
  let latestTs = Number(lastSeenTs) || 0
  let hasCustomerNew = false
  const ownTexts: OwnTextHit[] = []
  for (const msg of messages || []) {
    const ts = Number(msg.createTime) || 0
    if (ts > latestTs) latestTs = ts
    const cls = classifyInsightMessage(msg)
    if (ts <= lastSeenTs) continue // 旧消息不参与触发判断
    if (cls === 'customer') hasCustomerNew = true
    if (cls === 'own') {
      const content = messageTextContent(msg)
      if (content.length >= 2) ownTexts.push({ content, createTime: ts })
    }
  }
  return { shouldTrigger: hasCustomerNew, latestTs, ownTexts }
}

// ─── MassSendDetector：群发模板被动检测 ──────────────────────────────────────

/** 判定参数（设计 §5：先走常量，不开设置项） */
const MASS_SEND_MIN_SESSIONS = 3
/** 命中累计窗口：距上次命中超过该值视为新一轮触达，会话累计重置 */
const MASS_SEND_WINDOW_MS = 72 * 3600 * 1000
/** 标记维持期：末次命中后多久内该内容仍被视为群发模板 */
const MASS_SEND_MARK_MS = 48 * 3600 * 1000
/** 条目保留期：超期条目在下次记录时顺带清扫（无独立定时器） */
const MASS_SEND_PURGE_MS = 7 * 24 * 3600 * 1000
/** 参与检测的最短文本长度（「去看看」=3 字可命中；单字符规避） */
const MASS_SEND_MIN_TEXT_LEN = 2

interface MassSendEntry {
  sessions: Set<string>
  lastHitAtMs: number
}

/**
 * 群发模板被动检测器。
 * 采集点：analyzeRecentActivity 触发扫描 + generateInsightForSession 上下文加载，
 * 两处把窗口内 own 文本喂进来——零额外 DB 查询。
 * 误判代价可控：标记语义是「疑似」，标错只是多一句护栏提示，不会丢失客户证据。
 */
export class MassSendDetector {
  private entries = new Map<string, MassSendEntry>()

  /** 内容归一化键：压缩空白（直接用归一化文本做键，避免引入 crypto） */
  private static normalizeKey(content: string): string {
    return String(content || '').replace(/\s+/g, ' ').trim()
  }

  /** 微信 createTime 为秒（10 位），Date.now() 为毫秒（13 位），统一到毫秒 */
  private static toMs(ts: number): number {
    const raw = Number(ts) || 0
    return raw >= 1e12 ? raw : raw * 1000
  }

  /** 记录一条我方文本消息的出现（同会话重复记录幂等，只刷新时间） */
  recordOwnText(sessionId: string, content: string, ts: number): void {
    const key = MassSendDetector.normalizeKey(content)
    if (key.length < MASS_SEND_MIN_TEXT_LEN) return
    const now = Date.now()
    this.purge(now)
    let entry = this.entries.get(key)
    // 距上次命中超过累计窗口：视为新一轮触达，重置会话累计（避免隔月两条旧命中凑数）
    if (entry && now - entry.lastHitAtMs > MASS_SEND_WINDOW_MS) entry = undefined
    if (!entry) {
      entry = { sessions: new Set(), lastHitAtMs: 0 }
      this.entries.set(key, entry)
    }
    entry.sessions.add(String(sessionId || ''))
    const hitMs = MassSendDetector.toMs(ts)
    if (hitMs > entry.lastHitAtMs) entry.lastHitAtMs = hitMs
  }

  /** 该内容是否命中群发模板标记（≥3 会话 且 未过标记维持期） */
  isMassSendTemplate(content: string): boolean {
    const key = MassSendDetector.normalizeKey(content)
    if (key.length < MASS_SEND_MIN_TEXT_LEN) return false
    const entry = this.entries.get(key)
    if (!entry) return false
    if (entry.sessions.size < MASS_SEND_MIN_SESSIONS) return false
    return Date.now() - entry.lastHitAtMs <= MASS_SEND_MARK_MS
  }

  /** 清扫超期条目（每次记录时顺带执行） */
  private purge(now: number): void {
    if (this.entries.size === 0) return
    for (const [key, entry] of this.entries) {
      if (now - entry.lastHitAtMs > MASS_SEND_PURGE_MS) this.entries.delete(key)
    }
  }

  /** 测试用：清空内存状态 */
  reset(): void {
    this.entries.clear()
  }
}

/** 全局单例：insightService 各采集点共用同一份群发模板记忆 */
export const massSendDetector = new MassSendDetector()
