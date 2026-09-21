/**
 * crmSla2Service.ts —— 两段接力 SLA 第二段「聊了没有」（PRD §1.4，宪法 §1.3/§2.6）
 *
 * PRD 口径：第二段**弃用首触 SLA 计时器**，改为扫描对话判断跟进状态
 * （是否已有效触达 / 是否需介入），低置信转人工。第一段「加了没有」无对话可扫，
 * 保留机械计时 + 加好友检测（crmFriendDetectService，HANDOVER §2.56）。
 *
 * 落法（与「加好友检测停 SLA1 表」同构）：
 *   - 标记列 = assignment.sla2_scan_ref（D3 建表已含，JSON 串：
 *     { verdict, confidence, scanRef, source, at }；'' = 第二段尚无扫描结论）；
 *   - 写入口径 = markSla2ScanResult()：规则扫描 / 未来 LLM 扫描 / 人工结论都从这单点写入
 *     （同事务 UPDATE assignment + audit_event action='sla2_scan_result'）；
 *   - 规则骨架 = runSla2RuleScan()：只认「停表后客户有回复」这一**事实**（confidence=1.0），
 *     其余情形不下结论、留空给 LLM 扫描/人工（宁缺毋滥，与加好友自动检测同哲学）；
 *   - 回收器尊重标记：SLA1 回收器只扫 sla1_met_at IS NULL 的行，已停表（=进入第二段）的
 *     分配天然不在其扫描范围，本服务不改回收器。
 *
 * ⚠️ LLM 扫描已接入（crmSla2LlmScanService，HANDOVER §2.57 缺口已闭合）：规则覆盖不到的行由
 *    LLM 扫描补全，三铁律不变：① 结论一律经 markSla2ScanResult 写入（source='llm'）；
 *    ② 发给云端的对话内容必须先过 maskPrivateText 脱敏（宪法 §2.6：手机号/微信号/身份证号
 *    打码 ***，未脱敏原文不出本机）；③ 低置信结论写 verdict='uncertain'（= 转人工的持久化标记）。
 *    「查看依据」UI 出口 = crmSla2EvidenceService（脱敏回查，绝不返回 messageKey/wxid/绝对路径）。
 */
import { crmDbService, type CrmRow } from './crmDbService'
import { getActorLabel } from './identityService'
import { ConfigService } from './config'

/** 当前有效分配状态（与 crmAssignmentService 同口径） */
const ACTIVE_STATUS_SQL = "status IN ('assigned','claimed')"

// ─── 云推理脱敏（宪法 §2.6，2026-09-03 D8 裁决 8）─────────────────────────────
/**
 * 发往云端前的私密字段打码：手机号（11 位）/ 微信号（wxid_ 前缀与自定义微信号形态）/
 * 身份证号（15/18 位）→ ***。规则骨架本刀不出本机，此函数是未来 LLM 扫描 payload 的强制前置过滤器。
 */
export function maskPrivateText(text: string): string {
  let s = String(text ?? '')
  // 身份证号（18 位含校验位 X / 15 位），先长后短防与手机号规则交叠
  s = s.replace(/\b\d{17}[\dXx]\b/g, '***').replace(/\b\d{15}\b/g, '***')
  // 手机号：1 开头 11 位（不带词边界——发送者名等「下划线紧贴号码」形态也曾漏打码，隐私优先过度打码）
  s = s.replace(/1[3-9]\d{9}/g, '***')
  // wxid 内部号
  s = s.replace(/\bwxid_[A-Za-z0-9_]+\b/g, '***')
  return s
}

// ─── 扫描结果写入口径（规则 / LLM / 人工三路共用单点）────────────────────────
export type Sla2Verdict = 'contacted' | 'need_intervention' | 'uncertain'
export const SLA2_VERDICTS: readonly Sla2Verdict[] = ['contacted', 'need_intervention', 'uncertain']

export interface Sla2MarkInput {
  verdict: Sla2Verdict
  /** 0-1；规则命中事实=1.0，LLM 低置信结论应配低分并 verdict='uncertain'（转人工） */
  confidence: number
  /** 结论引用：规则=命中的 messageKey；LLM=扫描批次/结论 id；人工=备注 */
  scanRef: string
  source?: 'rule' | 'llm' | 'manual'
  note?: string
  actor?: string
}
export interface Sla2MarkData {
  assignmentId: number
  /** true = 同 verdict+scanRef+source 的结论已落过，本次零写入（幂等短路） */
  alreadyMarked: boolean
}
export interface Sla2MarkResult { ok: boolean; data?: Sla2MarkData; code?: string; message?: string }

/** 解析 sla2_scan_ref JSON（脏数据/空串回 null） */
export function parseSla2ScanRef(raw: unknown): { verdict: Sla2Verdict; confidence: number; scanRef: string; source: string; at: number; note?: string } | null {
  const s = String(raw || '').trim()
  if (!s) return null
  try {
    const j = JSON.parse(s)
    if (!SLA2_VERDICTS.includes(j?.verdict)) return null
    return j
  } catch { return null }
}

/**
 * 写第二段扫描结论（契约式信封，与分配服务同款）。
 * E101 参数非法（verdict 枚举外 / confidence 出界 / scanRef 空 / leadId 非法）；
 * E301 无当前有效分配行；E201 第二段未开始（sla1_met_at 仍 NULL = 第一段「加了没有」还没过）。
 * 幂等：同 (verdict, scanRef, source) 已落 → alreadyMarked=true 零写入零新审计；
 * 不同结论允许覆盖（最新扫描胜出），每次覆盖都留审计。
 */
export function markSla2ScanResult(leadId: number, input: Sla2MarkInput): Sla2MarkResult {
  const id = Number(leadId)
  const verdict = input?.verdict
  const confidence = Number(input?.confidence)
  const scanRef = String(input?.scanRef || '').trim()
  if (!Number.isInteger(id) || id <= 0) return { ok: false, code: 'E101', message: 'leadId 必填' }
  if (!SLA2_VERDICTS.includes(verdict)) return { ok: false, code: 'E101', message: `verdict 须为 ${SLA2_VERDICTS.join('/')}` }
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return { ok: false, code: 'E101', message: 'confidence 须在 0-1' }
  if (!scanRef) return { ok: false, code: 'E101', message: 'scanRef 必填（扫描结论引用，空串不入库）' }
  const source = input.source === 'llm' || input.source === 'manual' ? input.source : 'rule'
  const by = String(input.actor || '').trim() || (source === 'rule' ? 'system:sla2-scan' : (getActorLabel() || '操作员'))

  const row = crmDbService.all(
    `SELECT * FROM assignment WHERE lead_id = ? AND deleted = 0 AND ${ACTIVE_STATUS_SQL} ORDER BY id DESC LIMIT 1`, [id]
  )[0]
  if (!row) return { ok: false, code: 'E301', message: '该线索无当前有效分配' }
  if (!Number(row.sla1_met_at || 0)) return { ok: false, code: 'E201', message: '第二段未开始：该分配尚未停 SLA1 表（未加好友）' }

  const existing = parseSla2ScanRef(row.sla2_scan_ref)
  if (existing && existing.verdict === verdict && existing.scanRef === scanRef && existing.source === source) {
    return { ok: true, data: { assignmentId: Number(row.id), alreadyMarked: true } }
  }

  const now = Date.now()
  const payload = JSON.stringify({ verdict, confidence, scanRef, source, at: now, ...(input.note ? { note: String(input.note).slice(0, 200) } : {}) })
  crmDbService.runTx((tx) => {
    tx.run('UPDATE assignment SET sla2_scan_ref = ?, updated_by = ?, updated_at = ?, version = version + 1 WHERE id = ?',
      [payload, by, now, Number(row.id)])
    tx.run('INSERT INTO audit_event (actor, action, entity_type, entity_id, detail, created_at) VALUES (?,?,?,?,?,?)',
      [by, 'sla2_scan_result', 'lead', id, JSON.stringify({
        assignmentId: Number(row.id), verdict, confidence, scanRef, source,
        prevVerdict: existing?.verdict || '', overridden: !!existing
      }), now])
  }, { affectsAnnualReview: 'crm:assignment' })
  return { ok: true, data: { assignmentId: Number(row.id), alreadyMarked: false } }
}

// ─── 规则骨架扫描（保守版：只认「停表后客户有回复」这一事实）──────────────────
/** 注入式消息最小字段（生产 = chatService.getMessages 映射；createTimeMs 毫秒） */
export interface Sla2MessageLite { isSend: number | null; createTimeMs: number; messageKey: string }
export interface Sla2RuleScanResult { scanned: number; marked: number; alreadyMarked: number; skipped: number }

/**
 * 扫一轮：assigned/claimed 且已停 SLA1 表（sla1_met_at 非空）且 sla2_scan_ref 为空的分配行，
 * 取其绑定会话（lead.wechat = 停表时写入的 wxid）停表时刻之后的消息：
 * 有客户消息（isSend !== 1）→ verdict='contacted', confidence=1.0, scanRef=该条 messageKey。
 * 其余情形（无会话 / 停表后无客户回复）不下结论、零写入——留给 LLM 扫描或人工。
 * 逐条独立写（markSla2ScanResult 各自单事务），单条失败不阻塞其余。
 */
export function runSla2RuleScan(fetchMessages: (sessionId: string, sinceMs: number) => Promise<Sla2MessageLite[]>): Promise<Sla2RuleScanResult> {
  return (async () => {
    const r: Sla2RuleScanResult = { scanned: 0, marked: 0, alreadyMarked: 0, skipped: 0 }
    const rows = crmDbService.all(
      `SELECT a.id AS assignment_id, a.lead_id, a.sla1_met_at FROM assignment a
       WHERE a.deleted = 0 AND a.status IN ('assigned','claimed')
         AND a.sla1_met_at IS NOT NULL AND (a.sla2_scan_ref IS NULL OR a.sla2_scan_ref = '')
       ORDER BY a.id`
    )
    // 同 lead 多条有效行属脏数据，只处理最新一条（与 currentAssignment 口径一致）
    const seen = new Set<number>()
    const targets: CrmRow[] = []
    for (const row of rows.reverse()) {
      const lid = Number(row.lead_id)
      if (seen.has(lid)) continue
      seen.add(lid)
      targets.push(row)
    }
    for (const row of targets) {
      r.scanned++
      const lid = Number(row.lead_id)
      const sinceMs = Number(row.sla1_met_at || 0)
      const lead = crmDbService.all('SELECT id, wechat FROM lead WHERE id = ?', [lid])[0]
      const sessionId = String(lead?.wechat || '').trim()
      if (!sessionId) { r.skipped++; continue }
      let msgs: Sla2MessageLite[] = []
      try { msgs = await fetchMessages(sessionId, sinceMs) } catch { r.skipped++; continue }
      const hit = (Array.isArray(msgs) ? msgs : [])
        .filter((m) => Number(m?.isSend) !== 1 && Number(m?.createTimeMs || 0) >= sinceMs)
        .sort((a, b) => Number(a.createTimeMs) - Number(b.createTimeMs))[0]
      if (!hit) continue
      const res = markSla2ScanResult(lid, {
        verdict: 'contacted', confidence: 1.0,
        scanRef: String(hit.messageKey || `rule:${sessionId}@${Number(hit.createTimeMs)}`),
        source: 'rule', actor: 'system:sla2-scan',
        note: '规则命中：停表后客户有回复（事实判定）'
      })
      if (res.ok) {
        if (res.data?.alreadyMarked) r.alreadyMarked++
        else r.marked++
      } else {
        r.skipped++
        console.warn(`[CRM] SLA2 规则扫描写入失败 lead=${lid}：${res.code} ${res.message}`)
      }
    }
    return r
  })()
}

/** 规则扫描间隔（分钟）：配置 crmSla2ScanIntervalMin，5-1440，默认 30（与回收器/加好友检测同款） */
function sla2IntervalMin(): number {
  const n = Number(ConfigService.getInstance().get('crmSla2ScanIntervalMin') ?? 30)
  return Number.isFinite(n) && n >= 5 && n <= 1440 ? n : 30
}

let sla2Boot: ReturnType<typeof setTimeout> | null = null
let sla2Timer: ReturnType<typeof setInterval> | null = null

/**
 * 启动 SLA2 规则扫描调度器（main.ts 启动链路调用，挂在加好友检测调度器旁）。
 * fetchMessages 由调用方注入（生产 = chatService.getMessages 应用读取层适配，WCDB 只读；
 * 未连接/异常 → 本轮该条跳过零副作用）。幂等：重复调用直接返回。
 * 启动延迟 120s 首扫（让迁移/补写/回收器/加好友检测先收尾），之后按间隔轮巡。
 */
export function startSla2ScanScheduler(fetchMessages: (sessionId: string, sinceMs: number) => Promise<Sla2MessageLite[]>): void {
  if (sla2Timer) return
  const tick = async (): Promise<void> => {
    try {
      const r = await runSla2RuleScan(fetchMessages)
      if (r.marked > 0) {
        console.log(`[CRM] SLA2 规则扫描：扫 ${r.scanned} 行，标记有效触达 ${r.marked}（跳过 ${r.skipped}，actor=system:sla2-scan）`)
      }
    } catch (e) {
      console.warn('[CRM] SLA2 规则扫描失败:', e)
    }
  }
  sla2Boot = setTimeout(() => { void tick() }, 120 * 1000)
  if (sla2Boot.unref) sla2Boot.unref()
  sla2Timer = setInterval(() => { void tick() }, sla2IntervalMin() * 60 * 1000)
  if (sla2Timer.unref) sla2Timer.unref()
}
