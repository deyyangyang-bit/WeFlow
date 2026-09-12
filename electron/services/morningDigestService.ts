/** 开工简报事实版：生成是显式命令，读取不扫描、不调用模型。 */
import { getUnifiedSignals, type UnifiedSignal } from './salesActionEngine'
import { salesDbService, type ReportSnapshot } from './salesDbService'
import type { ConfigService } from './config'
import { enqueueSalesTask } from './salesQueue'

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
export interface MorningDigest {
  date: string
  items: DigestItem[]
  text: string
  aiUsed: boolean
  createdAt: number
  coverage?: { state: 'facts_only'; message: string }
}
const PERIOD_TYPE = 'morning_digest'
export function localDateString(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
}
/** 保留历史接口；开工入口不再要求在此时段在线。 */
export function isInDigestWindow(now: Date): boolean { return now.getHours() === 8 && now.getMinutes() >= 5 && now.getMinutes() < 35 }
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
  return { date, items, text: items.length ? `当前 ${items.length} 个业务事项` : '当前暂无已记录的待办；聊天分析覆盖尚未核验。', aiUsed: false, createdAt: 0,
    coverage: { state: 'facts_only', message: '仅当前账号 · 业务事实版；聊天覆盖未核验，不代表已分析全部消息' } }
}
/** 旧接口保留给历史测试/调用；事实版不发送该提示词。 */
export function buildDigestPrompt(signals: UnifiedSignal[]): string { return signals.slice(0, 20).map(s => `${s.sessionId}|${s.sources.map(x => x.reason).join('；')}`).join('\n') }
export function parseAiDigest(_text: string, _signals: UnifiedSignal[], _date: string): MorningDigest | null { return null }

class MorningDigestService {
  private timer: NodeJS.Timeout | null = null
  private pending = new Map<string, Promise<MorningDigest>>()
  setConfig(_config: ConfigService): void { /* 事实版不启用可选 AI 润色 */ }
  getLatestDigest(): MorningDigest | null {
    if (!salesDbService.isInitialized()) throw new Error('业务库尚未就绪，请稍后重试')
    const row = salesDbService.reportLatestByType(PERIOD_TYPE)
    if (!row) return null
    const result = this.rowToDigest(row)
    // 快照正文不改写；投影叠加任务现行状态。
    result.items = result.items.map(item => ({ ...item, status: item.taskId ? salesDbService.getTask(item.taskId)?.status || 'unavailable' : item.status }))
    return result
  }
  async generateTodayDigest(): Promise<MorningDigest> {
    const existing = this.getLatestDigest()
    if (existing?.date === localDateString(new Date()) && existing.coverage?.state === 'facts_only') return existing
    return this.generate(false)
  }
  async regenerateToday(): Promise<MorningDigest> { return this.generate(true) }
  private generate(replace: boolean): Promise<MorningDigest> {
    const scope = salesDbService.captureScope()
    const key = `${scope}:${localDateString(new Date())}`
    const pending = this.pending.get(key)
    if (pending) return pending
    const task = enqueueSalesTask(async () => {
      if (scope !== salesDbService.captureScope() || !salesDbService.isInitialized()) throw new Error('账号已切换或业务库未就绪')
      const today = localDateString(new Date())
      const existing = this.getLatestDigest()
      if (!replace && existing?.date === today && existing.coverage?.state === 'facts_only') return existing
      const result = await getUnifiedSignals()
      if (scope !== salesDbService.captureScope()) throw new Error('账号已切换，已放弃旧简报')
      const digest = buildFallbackDigest(result.signals, today)
      const start = new Date(); start.setHours(0, 0, 0, 0)
      // 只有成功组装后才删除当天旧快照；失败不将空摘要伪装成成功。
      salesDbService.reportDeleteByTypeAndDate(PERIOD_TYPE, today)
      salesDbService.reportCreate({ period_type: PERIOD_TYPE, period_start: start.getTime(), period_end: start.getTime() + 86400000 - 1, stats: JSON.stringify({ items: digest.items, aiUsed: false, coverage: digest.coverage }), ai_summary: digest.text })
      return { ...digest, createdAt: Date.now() }
    }).finally(() => this.pending.delete(key))
    this.pending.set(key, task)
    return task
  }
  private rowToDigest(row: ReportSnapshot): MorningDigest {
    const parsed = JSON.parse(row.stats || '{}')
    return { date: localDateString(new Date(row.period_start)), items: Array.isArray(parsed.items) ? parsed.items : [], text: row.ai_summary || '', aiUsed: !!parsed.aiUsed, createdAt: row.created_at || 0, coverage: parsed.coverage }
  }
  startScheduler(): void {
    if (this.timer) return
    this.timer = setInterval(() => { if (salesDbService.isInitialized()) void this.generateTodayDigest().catch(() => undefined) }, 60_000)
  }
  stopScheduler(): void { if (this.timer) clearInterval(this.timer); this.timer = null }
}
export const morningDigestService = new MorningDigestService()
