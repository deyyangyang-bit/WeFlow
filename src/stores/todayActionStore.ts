/**
 * todayActionStore.ts
 * 今日行动清单 Zustand store
 */
import { create } from 'zustand'

export interface ActionItem {
  id: number
  sessionId: string
  displayName: string
  stage: string
  triggerType: string
  title: string
  reason: string
  suggestion: string
  suggestionError?: string
  notConfigured?: boolean
  /** v3 结构化分析字段 */
  whyNow?: string
  opportunity?: string
  riskSignal?: string
  nextMove?: string
  degradationNote?: string
  priority: 'urgent' | 'high' | 'medium' | 'low' | 'info'
  priorityScore: number
  silentDays: number
  createdAt: number
  status: string
}

export interface ActionStats {
  todayPending: number
  overdue: number
  newThisWeek: number
  pipelineTotal: number
  r6Count: number
}

interface TodayActionState {
  items: ActionItem[]
  archiveCandidates: ActionItem[]
  stats: ActionStats | null
  loading: boolean
  error: string | null
  generatedAt: number | null
  _retryTimer: ReturnType<typeof setTimeout> | null

  fetchToday: () => Promise<void>
  completeItem: (taskId: number, action: 'done' | 'skipped') => Promise<void>
  fetchSuggestion: (item: ActionItem) => Promise<void>
}

export const useTodayActionStore = create<TodayActionState>((set, get) => ({
  items: [],
  archiveCandidates: [],
  stats: null,
  loading: false,
  error: null,
  generatedAt: null,
  _retryTimer: null as ReturnType<typeof setTimeout> | null,

  fetchToday: async () => {
    // 清理上一次的延迟重试，防止旧 timer 覆写新数据
    const prev = get()._retryTimer
    if (prev) { clearTimeout(prev); set({ _retryTimer: null }) }

    set({ loading: true, error: null })
    try {
      const result = await (window as any).electronAPI.sales.actionGetToday()
      set({
        items: result.items || [],
        archiveCandidates: result.archiveCandidates || [],
        stats: result.stats || null,
        generatedAt: result.generatedAt || Date.now(),
        loading: false
      })
      // 如果返回空且无错误，可能是启动时序问题，2秒后重试一次
      if ((!result.items || result.items.length === 0) && !result.error) {
        const timer = setTimeout(async () => {
          try {
            const retry = await (window as any).electronAPI.sales.actionGetToday()
            if (retry.items?.length > 0 || retry.archiveCandidates?.length > 0) {
              set({ items: retry.items || [], archiveCandidates: retry.archiveCandidates || [], stats: retry.stats, generatedAt: retry.generatedAt, _retryTimer: null })
            }
          } catch { /* ignore retry errors */ }
        }, 2000)
        set({ _retryTimer: timer })
      }
    } catch (e: any) {
      const msg = e?.message || '加载失败'
      if (msg.includes('未初始化')) {
        set({ loading: false })
        const timer = setTimeout(() => get().fetchToday(), 3000)
        set({ _retryTimer: timer })
      } else {
        set({ error: msg, loading: false })
      }
    }
  },

  completeItem: async (taskId: number, action: 'done' | 'skipped') => {
    try {
      await (window as any).electronAPI.sales.actionComplete(taskId, action)
      // 从主列表和清理候选列表中移除
      set(state => ({
        items: state.items.filter(item => item.id !== taskId),
        archiveCandidates: state.archiveCandidates.filter(item => item.id !== taskId)
      }))
    } catch (e) {
      console.error('完成行动失败:', e)
    }
  },

  fetchSuggestion: async (item: ActionItem) => {
    try {
      const result = await (window as any).electronAPI.sales.actionSuggest(item)
      const analysis = {
        suggestion: result?.script || result?.suggestion || '',
        whyNow: result?.whyNow || '',
        opportunity: result?.opportunity || '',
        riskSignal: result?.riskSignal || '',
        nextMove: result?.nextMove || '',
        suggestionError: result?.error,
        notConfigured: result?.notConfigured,
        degradationNote: result?.degradationNote
      }
      set(state => ({
        items: state.items.map(i =>
          i.id === item.id ? { ...i, ...analysis } : i
        ),
        archiveCandidates: state.archiveCandidates.map(i =>
          i.id === item.id ? { ...i, ...analysis } : i
        )
      }))
    } catch (e: any) {
      const errMsg = e?.message || '请求失败'
      set(state => ({
        items: state.items.map(i =>
          i.id === item.id ? { ...i, suggestionError: errMsg } : i
        ),
        archiveCandidates: state.archiveCandidates.map(i =>
          i.id === item.id ? { ...i, suggestionError: errMsg } : i
        )
      }))
    }
  }
}))
