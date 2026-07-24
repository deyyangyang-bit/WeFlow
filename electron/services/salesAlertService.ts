/**
 * salesAlertService.ts
 *
 * 高意向实时预警服务。
 * 监听 DB 变更事件，对新消息触发意向判断，
 * 达到"决策"阶段阈值时通过通知窗口弹窗提醒。
 */

import { wcdbService } from './wcdbService'
import { salesDbService } from './salesDbService'
import { salesIntentService } from './salesIntentService'
import { isAiConfigured } from './ai/aiApiClient'
import { ConfigService } from './config'
import { showNotification } from '../windows/notificationWindow'

const DEBOUNCE_MS = 5000          // 5s 防抖（比 insightService 的 2s 更长，避免频繁触发）
const ALERT_STAGE = '决策'        // 触发预警的阶段
const ALERT_CONFIDENCE = 0.7     // 触发预警的置信度阈值
const COOLDOWN_MS = 30 * 60 * 1000  // 同一客户 30 分钟内不重复预警

class SalesAlertService {
  private started = false
  private config: ConfigService | null = null
  private debounceTimer: NodeJS.Timeout | null = null
  private processing = false
  private lastAlertTime = new Map<string, number>()  // sessionId -> last alert timestamp

  setConfig(config: ConfigService): void {
    this.config = config
  }

  start(): void {
    if (this.started) return
    this.started = true
    console.log('[SalesAlert] 高意向预警服务已启动')
  }

  stop(): void {
    this.started = false
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
  }

  /**
   * 接收 DB 变更事件（由 main.ts 调用）
   */
  handleDbMonitorChange(_type: string, _json: string): void {
    if (!this.started) return
    if (!this.config) return
    if (!isAiConfigured(this.config)) return
    if (this.processing) return

    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer)
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      void this.checkHighIntentCustomers()
    }, DEBOUNCE_MS)
  }

  /**
   * 检查高意向客户：
   * 找到 stage 为"比价"或"决策"的客户，检查是否有新消息，触发 AI 分析
   */
  private async checkHighIntentCustomers(): Promise<void> {
    if (this.processing) return
    this.processing = true

    try {
      if (!this.config) return

      // 获取处于"比价"或"决策"阶段的客户
      const customers = salesDbService.customerList({ limit: 50 })
      const candidates = customers.filter(
        (c) => (c.stage === '比价' || c.stage === '决策') && c.session_id
      )

      if (candidates.length === 0) return

      const connected = await wcdbService.isConnected()
      if (!connected) return

      for (const customer of candidates.slice(0, 5)) {  // 每次最多检查 5 个
        const sessionId = customer.session_id

        // 冷却期检查
        const lastAlert = this.lastAlertTime.get(sessionId) || 0
        if (Date.now() - lastAlert < COOLDOWN_MS) continue

        // 检查是否有新消息（在 last_contact_at 之后）
        const lastContact = customer.last_contact_at || 0
        try {
          const msgResult = await wcdbService.getMessages(sessionId, 3, 0)
          if (!msgResult.success || !msgResult.messages || msgResult.messages.length === 0) continue

          const latestMsgTime = (msgResult.messages[0].createTime || 0) * 1000  // 秒→毫秒
          // 如果没有新消息（最新消息时间 <= last_contact_at），跳过
          if (lastContact > 0 && latestMsgTime <= lastContact) continue
          // 只关注对方发来的新消息（非自己发的）
          const hasNewPeerMsg = msgResult.messages.some(
            (m: any) => m.isSend !== 1 && (m.createTime || 0) * 1000 > lastContact
          )
          if (!hasNewPeerMsg && lastContact > 0) continue
        } catch {
          continue
        }

        // 触发 AI 意向分析
        try {
          const result = await salesIntentService.analyzeIntent(sessionId, this.config)
          if (result.success && result.tag) {
            const { stage, confidence } = result.tag
            if (stage === ALERT_STAGE && (confidence ?? 0) >= ALERT_CONFIDENCE) {
              // 触发预警通知
              this.lastAlertTime.set(sessionId, Date.now())
              const displayName = customer.display_name || sessionId
              await showNotification({
                sessionId: `weflow-sales-alert-${sessionId}`,
                channel: 'sales-alert',
                title: '🔥 高意向客户提醒',
                content: `${displayName} 已进入「决策」阶段（置信度 ${Math.round((confidence ?? 0) * 100)}%），建议尽快跟进！`,
                avatarUrl: undefined
              })
              console.log(`[SalesAlert] 预警: ${displayName} → ${stage} (${confidence})`)
            }
          }
        } catch {
          // 单个客户分析失败不影响其他
        }
      }
    } catch (e) {
      console.warn('[SalesAlert] 检查失败:', e)
    } finally {
      this.processing = false
    }
  }
}

export const salesAlertService = new SalesAlertService()
