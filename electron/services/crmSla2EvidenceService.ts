/**
 * crmSla2EvidenceService.ts —— SLA2「查看依据」统一读出口（IPC `crm:sla2:evidence`）
 *
 * 链路：leadId → 当前有效分配行的 sla2_scan_ref（{ verdict, scanRef, source, at }）→
 *       sessionId = lead.wechat（停表写入的绑定 wxid，与 SLA2 扫描口径一致）→
 *       evidenceResolver.getEvidenceByKey 回查锚点消息 → 脱敏 + 字段裁剪后返回。
 *
 * ⛔ 出口纪律（宪法 §2.6/§1.10 + 2026-09-08 UI 查看依据需求）：
 *   - 正文/摘要必过 maskPrivateText（手机号/微信号/身份证 → ***）；
 *   - 绝不返回 messageKey / sessionId / wxid / 本机绝对路径 / API Key——UI 无法借此拼出敏感字段；
 *   - 找不到锚点消息绝不伪造：明确状态 returned（no_anchor / cleaned / error）。
 *
 * 状态语义（UI 展示用）：
 *   found       锚点消息回查成功（text=脱敏摘要，createTimeMs/isSend/direction 供展示）
 *   no_anchor   结论引用是合成锚点（llm:<leadId>@<ts> / rule:<sessionId>@<ts>），无原始消息可回查
 *   cleaned     锚点消息已被清理/不存在（message_not_found）
 *   error       读取层故障（reader_error / unparseable）
 *   no_evidence 该结论没有引用（scanRef 空）
 * 依赖注入（仿 evidenceResolver）：resolver 可 mock，纯解析可单测。
 */
import { crmDbService } from './crmDbService'
import { parseSla2ScanRef, maskPrivateText } from './crmSla2Service'
import { parseEvidenceKey } from '../../shared/evidenceKey'

/** 与 evidenceResolver.getEvidenceByKey 的返回形状对齐（避免直接依赖 chatService.Message 类型） */
export interface Sla2EvidenceResolverResult {
  status: 'found' | 'unavailable'
  message?: { content?: string; rawContent?: string; parsedContent?: string; createTime?: number; isSend?: number | null }
  reason?: string
  evidenceText?: string
}

export interface Sla2EvidenceDeps {
  resolver: { getEvidenceByKey(sessionId: string, messageKey: string, evidenceText?: string): Promise<Sla2EvidenceResolverResult> }
  now?(): number
}

export interface Sla2EvidenceView {
  status: 'found' | 'no_anchor' | 'cleaned' | 'error' | 'no_evidence'
  /** 人类可读状态说明（可直接展示） */
  message: string
  /** 脱敏后的结论依据摘要（found 时有值，≤200 字） */
  text?: string
  createTimeMs?: number
  /** true=销售发出，false=客户发出 */
  isSend?: boolean
  /** 结论来源（rule/llm/manual） */
  source?: string
  /** 结论落定时间 */
  concludedAt?: number
}

/** 锚点是否为可回查的真实消息 key（合成锚点 llm:<id>@<ts> / rule:<session>@<ts> 解析不出来） */
function isResolvableKey(scanRef: string): boolean {
  return parseEvidenceKey(scanRef).kind !== 'unparseable'
}

export function createSla2EvidenceReader(deps: Sla2EvidenceDeps) {
  return {
    /** 读某线索第二段结论的证据（IPC crm:sla2:evidence 供数；只读，零副作用） */
    async getEvidenceForLead(leadId: number): Promise<Sla2EvidenceView> {
      const id = Number(leadId)
      if (!Number.isInteger(id) || id <= 0) return { status: 'no_evidence', message: '参数缺 leadId' }
      const row = crmDbService.all(
        "SELECT sla2_scan_ref FROM assignment WHERE lead_id = ? AND deleted = 0 AND status IN ('assigned','claimed') ORDER BY id DESC LIMIT 1",
        [id]
      )[0]
      const ref = parseSla2ScanRef(row?.sla2_scan_ref)
      if (!ref || !String(ref.scanRef || '').trim()) {
        return { status: 'no_evidence', message: '该结论没有留证据引用', source: ref?.source, concludedAt: ref?.at }
      }
      const scanRef = String(ref.scanRef)
      if (!isResolvableKey(scanRef)) {
        return { status: 'no_anchor', message: '该结论为扫描批注（无单条消息锚点），可在跟进状态说明中查看摘要', source: ref.source, concludedAt: ref.at }
      }
      const lead = crmDbService.all('SELECT wechat FROM lead WHERE id = ?', [id])[0]
      const sessionId = String(lead?.wechat || '').trim()
      if (!sessionId) {
        return { status: 'no_anchor', message: '该线索未绑定微信会话，无法回查证据消息', source: ref.source, concludedAt: ref.at }
      }
      try {
        const res = await deps.resolver.getEvidenceByKey(sessionId, scanRef)
        if (res.status === 'found' && res.message) {
          const m = res.message
          const raw = String((m as { parsedContent?: string }).parsedContent || m.content || m.rawContent || '').slice(0, 200)
          const createTimeMs = Number(m.createTime || 0) > 1e12 ? Number(m.createTime) : Number(m.createTime || 0) * 1000
          return {
            status: 'found',
            message: '证据回查成功',
            text: maskPrivateText(raw) || '[非文本消息]',
            createTimeMs,
            isSend: Number(m.isSend) === 1,
            source: ref.source,
            concludedAt: ref.at
          }
        }
        if (res.reason === 'message_not_found') {
          return { status: 'cleaned', message: '锚点消息已清理或不存在（聊天记录可能已过期）', source: ref.source, concludedAt: ref.at }
        }
        return { status: 'error', message: '证据读取失败（读取层故障），请稍后重试', source: ref.source, concludedAt: ref.at }
      } catch {
        return { status: 'error', message: '证据读取失败（读取层故障），请稍后重试', source: ref.source, concludedAt: ref.at }
      }
    }
  }
}

// ─── 主进程单例（main.ts 注入 evidenceResolver；IPC 直接调用）───────────────────
let configuredReader: ReturnType<typeof createSla2EvidenceReader> | null = null

/** main.ts 启动链路注入真实 evidenceResolver（P0-2B 统一读入口） */
export function setSla2EvidenceResolver(resolver: Sla2EvidenceDeps['resolver']): void {
  configuredReader = createSla2EvidenceReader({ resolver })
}

/** IPC 供数入口：resolver 未注入（理论不可达）时返回明确 error 态 */
export async function sla2EvidenceGetForLead(leadId: number): Promise<Sla2EvidenceView> {
  if (!configuredReader) return { status: 'error', message: '证据读取层未就绪' }
  return configuredReader.getEvidenceForLead(leadId)
}
