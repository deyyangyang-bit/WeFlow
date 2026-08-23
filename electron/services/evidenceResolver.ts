/**
 * evidenceResolver.ts —— 证据链统一读入口（P0-2B Evidence Resolver）
 *
 * 定位：把「AI 判断记录 → 证据（原消息 + 上下文）」收敛为单一入口 getEvidenceByKey。
 * 复用现有应用读取层（chatService / wcdbService 既有原语），**不新增 WCDB 读取路径、
 * 不直接碰 wcdbCore、不改 /api/v1/messages**。找不到消息**绝不伪造**——
 * 明确返回 unavailable + 具体 reason；evidenceText 仅作为兜底展示（判断依据句），不冒充回查成功。
 *
 * 可测性：读路径靠 **reader 注入**（createEvidenceResolver(reader)）。默认注入真实
 * chatService（见 main.ts 接线），测试注入 fake reader。本模块不 import Electron，
 * 唯一依赖是共享纯解析器 parseEvidenceKey（shared/evidenceKey.ts）。
 *
 * 失败语义：
 *   unparseable        → 立即 unavailable，reader 零调用
 *   message_not_found  → reader 正常返回但未命中
 *   reader_error       → reader 抛异常（读取层故障）
 *   no_message_key     → 入参为空
 *   上下文失败非致命   → 仍返回 found，before/after 为空
 */
import { parseEvidenceKey } from '../../shared/evidenceKey'
import type { Message } from './chatService'

/** reader 接口：默认注入真实 chatService（其已具备以下三个公开原语），测试注入 fake */
export interface EvidenceMessageReader {
  getMessageById(sessionId: string, localId: number): Promise<{ success: boolean; message?: Message; error?: string }>
  getMessageByServerId(sessionId: string, svrid: string): Promise<{ success: boolean; message?: Message; error?: string }>
  getMessagesAround(
    sessionId: string,
    target: { localId?: number; createTime: number; messageKey?: string },
    count?: number
  ): Promise<{ success: boolean; before: Message[]; after: Message[]; error?: string }>
}

export type EvidenceUnavailableReason = 'unparseable' | 'message_not_found' | 'reader_error' | 'no_message_key'

export type EvidenceResult =
  | { status: 'found'; message: Message; before: Message[]; after: Message[] }
  | { status: 'unavailable'; reason: EvidenceUnavailableReason; evidenceText?: string }

export interface EvidenceResolver {
  getEvidenceByKey(sessionId: string, messageKey: string, evidenceText?: string): Promise<EvidenceResult>
}

export function createEvidenceResolver(reader: EvidenceMessageReader): EvidenceResolver {
  return {
    /**
     * 按 messageKey 定位证据消息（原消息 + before/after 上下文）。
     * @param sessionId 判断记录自带，显式传入；不做 messageKey→session 反猜
     * @param messageKey canonical / server: / 裸数字 均可（历史双格式兼容读取）
     * @param evidenceText 判断依据句，仅 unavailable 时透传兜底展示，不是"回查成功"
     */
    async getEvidenceByKey(sessionId: string, messageKey: string, evidenceText?: string): Promise<EvidenceResult> {
      const key = String(messageKey || '').trim()
      if (!key) return { status: 'unavailable', reason: 'no_message_key', evidenceText }

      const parsed = parseEvidenceKey(key)
      if (parsed.kind === 'unparseable') {
        return { status: 'unavailable', reason: 'unparseable', evidenceText }
      }

      let readResult
      try {
        readResult = parsed.kind === 'localId'
          ? await reader.getMessageById(sessionId, parsed.localId)
          : await reader.getMessageByServerId(sessionId, parsed.serverId)
      } catch (e) {
        return { status: 'unavailable', reason: 'reader_error', evidenceText }
      }

      if (!readResult.success || !readResult.message) {
        return { status: 'unavailable', reason: 'message_not_found', evidenceText }
      }

      const message = readResult.message
      let before: Message[] = []
      let after: Message[] = []
      try {
        const context = await reader.getMessagesAround(
          sessionId,
          { localId: message.localId, createTime: message.createTime, messageKey: key },
          50
        )
        if (context.success) {
          before = context.before || []
          after = context.after || []
        }
      } catch {
        // 上下文失败非致命：仍返回 found，before/after 为空
      }

      return { status: 'found', message, before, after }
    }
  }
}
