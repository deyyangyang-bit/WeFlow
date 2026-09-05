/**
 * alertService.ts —— 例外告警契约框架（设计-AI见解重定位 §4.1）
 *
 * 定位：所有主动告警（alert:* ）的唯一出口，四道闸缺一不可：
 *   ① 证据强制：getEvidenceByKey 必须 status='found'，验不出客户原话 → 告警不成立直接丢弃（宪法 §1.10：key 引用不复制正文，evidenceText 仅展示快照 ≤200 字）；
 *   ② 72h 幂等：同 sessionId 同 triggerReason='alert:<type>' 已有记录 → 跳过（insightRecordService.hasRecentAlert，不限 sourceType）；
 *   ③ 推送门：ALERT_PUSH_APPROVED 模块级常量，所有类型默认 false（离线评测准确率 ≥85% 才改 true，设计 §4.1 第 4 条）；false 时连 insightRecord 都不写（竞品告警的档案标注已由 crm_risk 承担）；
 *   ④ 门开：addRecord({sourceType:'insight', triggerReason:'alert:<type>'})，进信箱（重要提醒）+ 今日行动卡流（SignalSource type='alert'）。
 *
 * 可测性：零 electron 依赖，依赖全部注入（仿 main.ts createEvidenceResolver 注入模式），
 * 测试注入 fake deps；主进程经 initAlertService 注入真实实现（main.ts 启动链），crmParseService 经 getAlertService() 取用。
 */

/** 评测准入推送门：所有类型默认 false；离线评测准确率 ≥85% 才获得「主动弹」资格 */
export const ALERT_PUSH_APPROVED: Record<string, boolean> = {
  competitor: false
}

/** 幂等窗口：同客户同告警类型 72h 内不重复（设计 §4.1 第 2 条） */
export const ALERT_DEDUP_MS = 72 * 60 * 60 * 1000

export interface AlertEvidenceChecker {
  getEvidenceByKey(
    sessionId: string,
    messageKey: string,
    evidenceText?: string
  ): Promise<{ status: string }>
}

export interface AlertRecordInput {
  sessionId: string
  displayName: string
  sourceType: 'insight' | 'message_analysis' | 'archive'
  triggerReason: string
  insight: string
  messageKey?: string
  log: Record<string, unknown>
}

export interface AlertDeps {
  getEvidenceByKey: AlertEvidenceChecker['getEvidenceByKey']
  hasRecentAlert(sessionId: string, triggerReason: string, windowMs: number): boolean
  addRecord(input: AlertRecordInput): unknown
  log?(level: string, message: string): void
  now?(): number
}

export interface AlertRequest {
  type: string
  sessionId: string
  displayName: string
  messageKey: string
  /** 客户原话快照（≤200 字，仅展示用，不替代证据回查） */
  evidenceText: string
  /** 告警文案（门开时写入 insight 字段） */
  message?: string
}

export type AlertCreateResult =
  | { created: true; recordId: string }
  | { created: false; reason: 'no_evidence' | 'deduped' | 'gate_closed' | 'not_configured' | 'bad_input' }

export interface AlertService {
  createAlert(req: AlertRequest): Promise<AlertCreateResult>
}

/** 告警文案默认拼装：类型 → 信箱可见的人话（含客户原话快照） */
export function buildAlertMessage(type: string, displayName: string, evidenceText: string): string {
  const snapshot = String(evidenceText || '').trim().slice(0, 200)
  if (type === 'competitor') {
    return `【重要提醒】${displayName || '客户'} 提到了竞品，建议尽快跟进。客户原话：「${snapshot}」`
  }
  return `【重要提醒】${displayName || '客户'}：${snapshot}`
}

export function createAlertService(deps: AlertDeps): AlertService {
  const log = deps.log ?? (() => {})
  const now = deps.now ?? (() => Date.now())
  return {
    async createAlert(req: AlertRequest): Promise<AlertCreateResult> {
      const type = String(req?.type || '').trim()
      const sessionId = String(req?.sessionId || '').trim()
      const messageKey = String(req?.messageKey || '').trim()
      const evidenceText = String(req?.evidenceText || '').trim()
      if (!type || !sessionId || !messageKey || !evidenceText) {
        return { created: false, reason: 'bad_input' }
      }
      const triggerReason = `alert:${type}`

      // ③ 推送门（先于一切查询：门关时连证据校验/去重查询都不做）
      if (ALERT_PUSH_APPROVED[type] !== true) {
        return { created: false, reason: 'gate_closed' }
      }

      // ② 72h 幂等（不限 sourceType）
      if (deps.hasRecentAlert(sessionId, triggerReason, ALERT_DEDUP_MS)) {
        log('INFO', `[Alert] deduped ${triggerReason} ${sessionId}（72h 内已有）`)
        return { created: false, reason: 'deduped' }
      }

      // ① 证据强制：验不出原话 → 告警不成立（宪法 §1.10）
      let evidence: { status: string }
      try {
        evidence = await deps.getEvidenceByKey(sessionId, messageKey, evidenceText)
      } catch (e) {
        log('WARN', `[Alert] evidence check error ${sessionId} ${messageKey}: ${e}`)
        return { created: false, reason: 'no_evidence' }
      }
      if (evidence?.status !== 'found') {
        log('WARN', `[Alert] 证据验不出（status=${evidence?.status || 'unknown'}），告警丢弃 ${type} ${sessionId} ${messageKey}（宪法 §1.10）`)
        return { created: false, reason: 'no_evidence' }
      }

      // ④ 落库：sourceType='insight'（信箱可见）+ triggerReason='alert:<type>'（卡流合流键）
      const insight = req.message?.trim() || buildAlertMessage(type, req.displayName, evidenceText)
      const record = deps.addRecord({
        sessionId,
        displayName: String(req.displayName || ''),
        sourceType: 'insight',
        triggerReason,
        insight,
        messageKey,
        log: {
          endpoint: 'alert',
          model: `rule:${type}`,
          maxTokens: 0,
          temperature: 0,
          triggerReason,
          allowContext: false,
          contextCount: 0,
          systemPrompt: '',
          userPrompt: '',
          rawOutput: insight,
          finalInsight: insight,
          durationMs: 0,
          createdAt: now(),
          messageKey
        }
      }) as { id?: string } | undefined
      log('INFO', `[Alert] created ${triggerReason} ${sessionId}`)
      return { created: true, recordId: String(record?.id || '') }
    }
  }
}

// ─── 主进程单例（依赖注入点；未注入时 getAlertService 返回 null，调用方降级为 no-op） ───
let configured: AlertService | null = null

export function initAlertService(deps: AlertDeps): AlertService {
  configured = createAlertService(deps)
  return configured
}

export function getAlertService(): AlertService | null {
  return configured
}
