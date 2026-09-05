/**
 * crmSla2LlmScanService.ts —— 第二段 SLA「聊了没有」LLM 对话扫描（HANDOVER §2.57 缺口接入，2026-09-05）
 *
 * 范围：已加好友（SLA1 停表 sla1_met_at 非空）且第二段无结论或结论过期（at 超 48h 且有新消息）的
 * 有效分配行（assigned/claimed），拉该客户最近 20 条消息给 LLM 判断「聊了没有/聊到哪了」。
 *
 * ⛔ 三铁律（HANDOVER §2.57 定，违反即打回）：
 *   1. 写入口径单点：结论一律经 crmSla2Service.markSla2ScanResult 落 sla2_scan_ref，
 *      本模块**禁止**出现任何直写 sla2_scan_ref 的 SQL（测试静态断言）；
 *   2. 脱敏前置：送 LLM 的文本必须先过 maskPrivateText（手机号/微信号/身份证打码 ***，宪法 §2.6）；
 *   3. 低置信写 uncertain：confidence < 0.6 或模型自认拿不准 → verdict='uncertain'（低置信·转人工），宁缺毋滥。
 *
 * 幂等与闸：同 lead 24h 内最多扫一次（scan_state `sla2LlmScan:<leadId>`，§2.54 时间纪律：基点=执行时刻）；
 * 无绑定微信/无消息的行跳过且不计费（不调 LLM、不留标记，消息到达后下轮自然重试）；
 * LLM 未配置时整链静默跳过（零调用零写入）。
 * 依赖注入（仿 evidenceResolver）：getRecentMessages / llm 可 mock，纯函数 parse/build 可单测。
 */
import { crmDbService } from './crmDbService'
import { markSla2ScanResult, parseSla2ScanRef, maskPrivateText, type Sla2Verdict } from './crmSla2Service'
import { ConfigService } from './config'
import { isAiConfigured, getAiModelConfig, callChatCompletion } from './ai/aiApiClient'

/** 结论过期阈值：已落结论 at 超过 48h 且有新消息 → 允许重扫（刷新「聊到哪了」） */
const SLA2_LLM_STALE_MS = 48 * 3600_000
/** 同 lead 扫描幂等窗口：24h（§2.54 时间纪律） */
const SLA2_LLM_LEAD_WINDOW_MS = 24 * 3600_000
/** 有效结论的最低置信度：低于此值一律降级 uncertain */
const SLA2_LLM_MIN_CONFIDENCE = 0.6
/** 拉取的最近消息条数 */
const SLA2_LLM_MSG_LIMIT = 20

// ─── 可测纯函数：脱敏 + prompt 构建 + 响应解析 ────────────────────────────────

export interface Sla2LlmMessageLite {
  messageKey: string
  isSend: number | null
  senderName: string
  createTimeMs: number
  text: string
}

/** 消息 → 脱敏编号行（⚠️ 出本机前的最后一道闸：整行过 maskPrivateText——正文与发送者名都不得带出，宪法 §2.6） */
export function maskSla2Messages(msgs: Sla2LlmMessageLite[]): Array<{ line: string; messageKey: string }> {
  return (msgs || []).map((m, i) => {
    const who = Number(m.isSend) === 1 ? '我' : '对方'
    const name = Number(m.isSend) === 1 ? '我' : String(m.senderName || '对方')
    const time = new Date(Number(m.createTimeMs) || 0).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    const text = String(m.text || '').slice(0, 200) || '[非文本消息]'
    // 脱敏前置：整行（含发送者名）打码手机号/微信号/身份证，原文任何形态不出本机
    const line = maskPrivateText(`${i + 1}. [${who}] ${name}（${time}）：${text}`)
    return { line, messageKey: String(m.messageKey || '') }
  })
}

export const SLA2_LLM_SYSTEM = [
  '你是销售助手，根据最近的微信对话判断销售与该客户的跟进状态：聊了没有、聊到哪了。',
  '只输出一个 JSON 对象，不要输出其他任何文字：',
  '{"verdict":"contacted|need_intervention|uncertain","confidence":0到1的小数,"citeIndex":数字,"summary":"一句话结论"}',
  '判定规则：',
  '- 客户有实质回复且话题在推进（询价、约时间、确认细节等）→ verdict="contacted"，confidence≥0.7；',
  '- 客户有回复但卡住了（提出不满、犹豫、比价后沉默、等销售给方案）→ verdict="need_intervention"，confidence≥0.6；',
  '- 对话过短、只有寒暄、或你无法判断 → verdict="uncertain"，confidence≤0.5（拿不准就写 uncertain，宁缺毋滥）；',
  '- citeIndex = 你的判断依据的那条【对方】消息的序号（从 1 起）；没有依据消息填 0；',
  '- 对话里出现的手机号/微信号已脱敏为 ***，不要试图还原，也不要引用完整号码。'
].join('\n')

export function buildSla2LlmUserPrompt(displayName: string, maskedLines: Array<{ line: string }>): string {
  return `客户：${displayName}\n最近对话（已脱敏，新→旧）：\n${(maskedLines || []).map((m) => m.line).join('\n')}\n\n请按系统规则输出 JSON。`
}

export interface Sla2LlmParsed {
  verdict: Sla2Verdict
  confidence: number
  citeIndex: number
  summary: string
}

/**
 * 解析 LLM 响应：从文本中提取首个 JSON 对象；verdict 非法/JSON 不可解析 → null（本轮不计结论，
 * 下轮重试——解析失败≠模型拿不准，不冒充 uncertain）；confidence < 0.6 → verdict 强制降级 uncertain（铁律 3）。
 */
export function parseSla2LlmResponse(raw: string): Sla2LlmParsed | null {
  const text = String(raw || '')
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) return null
  let j: any
  try { j = JSON.parse(m[0]) } catch { return null }
  const verdict = String(j?.verdict || '')
  if (!['contacted', 'need_intervention', 'uncertain'].includes(verdict)) return null
  let confidence = Number(j?.confidence)
  if (!Number.isFinite(confidence)) confidence = 0
  confidence = Math.max(0, Math.min(1, confidence))
  const citeIndex = Math.max(0, Math.floor(Number(j?.citeIndex) || 0))
  const summary = String(j?.summary || '').slice(0, 200)
  // 铁律 3：低置信 → uncertain（宁缺毋滥）
  const finalVerdict: Sla2Verdict = confidence < SLA2_LLM_MIN_CONFIDENCE ? 'uncertain' : (verdict as Sla2Verdict)
  return { verdict: finalVerdict, confidence, citeIndex, summary }
}

// ─── 依赖注入 + 扫描器 ────────────────────────────────────────────────────────

export interface Sla2LlmScanDeps {
  /** 拉某会话最近 N 条消息（新→旧；主进程注入 chatService.getMessages(sessionId, 0, N)） */
  getRecentMessages(sessionId: string, limit: number): Promise<Sla2LlmMessageLite[]>
  /** LLM 出口（主进程注入 callChatCompletion；测试注入 mock） */
  llm(system: string, user: string): Promise<string>
  /** AI 是否已配置（未配置整链静默跳过） */
  isConfigured?(): boolean
  now?(): number
  log?(level: string, message: string): void
}

export interface Sla2LlmScanResult { configured: boolean; scanned: number; marked: number; skipped: number; uncertain: number }

/** lead 行 → 会话解析：① lead.wechat（停表写入口径，与规则扫描一致）② customer_identity（account.customer_id → wxid） */
function resolveSessionId(leadRow: any): string {
  const direct = String(leadRow?.wechat || '').trim()
  if (direct) return direct
  if (!Number(leadRow?.account_id)) return ''
  const hit = crmDbService.all(
    `SELECT ci.identity_value AS sid FROM customer_identity ci
     JOIN account a ON a.customer_id = ci.customer_id
     WHERE a.id = ? AND ci.identity_type = 'wxid' AND ci.deleted = 0
     ORDER BY ci.updated_at DESC LIMIT 1`, [Number(leadRow.account_id)]
  )[0]
  return String(hit?.sid || '').trim()
}

export function createSla2LlmScanner(deps: Sla2LlmScanDeps) {
  const log = deps.log ?? (() => {})
  const now = deps.now ?? (() => Date.now())
  return {
    /** 扫一轮（周期复用 crmSla2ScanIntervalMin；逐行独立，单行失败不阻塞其余） */
    async run(): Promise<Sla2LlmScanResult> {
      const r: Sla2LlmScanResult = { configured: false, scanned: 0, marked: 0, skipped: 0, uncertain: 0 }
      // 闸 1：LLM 未配置 → 整链静默跳过（零调用零写入零标记）
      if (deps.isConfigured && !deps.isConfigured()) return r
      r.configured = true
      const nowMs = now()

      // 候选：有效分配 + 已停表 +（无第二段结论 或 结论 at 超 48h）；同 lead 多行取最新（与 currentAssignment 口径一致）
      const rows = crmDbService.all(
        `SELECT a.* FROM assignment a
         WHERE a.deleted = 0 AND a.status IN ('assigned','claimed') AND a.sla1_met_at IS NOT NULL
         ORDER BY a.id DESC`
      )
      const seen = new Set<number>()
      for (const row of rows) {
        const leadId = Number(row.lead_id)
        if (seen.has(leadId)) continue
        seen.add(leadId)

        // 闸 2：同 lead 24h 内最多扫一次（§2.54 时间纪律：scan_state 基点=执行时刻）
        const marker = `sla2LlmScan:${leadId}`
        if (crmDbService.getScanState(marker) > nowMs - SLA2_LLM_LEAD_WINDOW_MS) { r.skipped++; continue }

        // 闸 3：结论新鲜度——已有结论且 at 未超 48h → 跳过（不拉消息不计费）
        const ref = parseSla2ScanRef(row.sla2_scan_ref)
        const stale = !ref || Number(ref.at || 0) < nowMs - SLA2_LLM_STALE_MS
        if (!stale) { r.skipped++; continue }

        // 会话解析读 lead 行（wechat/account_id 在 lead 表，assignment 行没有这两列）
        const leadRow = crmDbService.all('SELECT wechat, account_id, name FROM lead WHERE id = ?', [leadId])[0]
        const sessionId = resolveSessionId(leadRow)
        if (!sessionId) { r.skipped++; continue } // 无绑定微信：跳过不计费
        let msgs: Sla2LlmMessageLite[] = []
        try { msgs = await deps.getRecentMessages(sessionId, SLA2_LLM_MSG_LIMIT) } catch { r.skipped++; continue }
        const list = (msgs || []).filter((m) => m && String(m.text || '').trim())
        if (!list.length) { r.skipped++; continue } // 无消息：跳过不计费（不留标记，下轮自然重试）

        // 闸 4：结论未过期时，还须「有新消息」才值得重扫（最新客户消息晚于结论 at）
        if (ref) {
          const newestCustomer = Math.max(0, ...list.filter((m) => Number(m.isSend) !== 1).map((m) => Number(m.createTimeMs) || 0))
          if (newestCustomer > 0 && newestCustomer <= Number(ref.at || 0)) { r.skipped++; continue }
        }

        r.scanned++
        // 脱敏前置（铁律 2）→ LLM
        const displayName = String(leadRow?.name || `客户 #${leadId}`)
        const maskedLines = maskSla2Messages(list)
        let parsed: Sla2LlmParsed | null = null
        try {
          const raw = await deps.llm(SLA2_LLM_SYSTEM, buildSla2LlmUserPrompt(displayName, maskedLines))
          parsed = parseSla2LlmResponse(raw)
        } catch (e) {
          log('WARN', `[Sla2Llm] LLM 调用失败 lead=${leadId}: ${e}`)
        }
        // 24h 幂等标记：真实调用后无论成败都落标记（24h 内不重复计费）
        crmDbService.setScanState(marker, nowMs)
        if (!parsed) { r.skipped++; continue } // 解析失败/调用异常：本轮不出结论（不冒充 uncertain）

        // 证据锚点：判断依据的那条消息 messageKey（citeIndex 指向脱敏前编号表）；无依据给合成锚点
        const cited = parsed.citeIndex > 0 ? maskedLines[parsed.citeIndex - 1] : null
        const scanRef = cited?.messageKey || `llm:${leadId}@${nowMs}`
        const note = parsed.summary ? `LLM：${parsed.summary}` : `LLM 扫描（source=llm）`
        const res = markSla2ScanResult(leadId, {
          verdict: parsed.verdict,
          confidence: parsed.confidence,
          scanRef,
          source: 'llm',
          actor: 'system:sla2-llm',
          note
        })
        if (res.ok) {
          if (parsed.verdict === 'uncertain') r.uncertain++
          r.marked++
          log('INFO', `[Sla2Llm] lead=${leadId} verdict=${parsed.verdict} conf=${parsed.confidence}（写点=markSla2ScanResult）`)
        } else {
          r.skipped++
        }
      }
      return r
    }
  }
}

// ─── 主进程单例 + 调度器（周期复用 crmSla2ScanIntervalMin，与规则扫描同款）────────
let configuredScanner: ReturnType<typeof createSla2LlmScanner> | null = null

export function setSla2LlmScanDeps(deps: Sla2LlmScanDeps): void {
  configuredScanner = createSla2LlmScanner(deps)
}

let sla2LlmTimer: ReturnType<typeof setInterval> | null = null

/** 扫描间隔（分钟）：复用 crmSla2ScanIntervalMin 配置（与规则扫描同款，5-1440，默认 30） */
function sla2LlmIntervalMin(): number {
  const n = Number(ConfigService.getInstance().get('crmSla2ScanIntervalMin') ?? 30)
  return Number.isFinite(n) && n >= 5 && n <= 1440 ? n : 30
}

/**
 * 启动 LLM 扫描调度器（main.ts 挂 startSla2ScanScheduler 旁；LLM 未配置时 tick 内静默跳过）。
 * 启动延迟 180s（让规则扫描 120s 先跑：事实判定优先，LLM 只补规则覆盖不到的行）。
 */
export function startSla2LlmScanScheduler(): void {
  if (sla2LlmTimer) return
  const tick = async (): Promise<void> => {
    try {
      if (!configuredScanner) return
      const r = await configuredScanner.run()
      if (r.marked > 0) {
        console.log(`[CRM] SLA2 LLM 扫描：扫 ${r.scanned} 行，落结论 ${r.marked}（其中低置信 uncertain ${r.uncertain}；跳过 ${r.skipped}）`)
      }
    } catch (e) {
      console.warn('[CRM] SLA2 LLM 扫描失败:', e)
    }
  }
  sla2LlmTimer = setInterval(() => { void tick() }, sla2LlmIntervalMin() * 60 * 1000)
  if (sla2LlmTimer.unref) sla2LlmTimer.unref()
}
