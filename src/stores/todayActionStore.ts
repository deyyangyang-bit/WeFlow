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
}

interface TodayActionState {
  items: ActionItem[]
  stats: ActionStats | null
  loading: boolean
  error: string | null
  generatedAt: number | null

  fetchToday: () => Promise<void>
  completeItem: (taskId: number, action: 'done' | 'skipped') => Promise<void>
  fetchSuggestion: (item: ActionItem) => Promise<void>
}

export const useTodayActionStore = create<TodayActionState>((set, get) => ({
  items: [],
  stats: null,
  loading: false,
  error: null,
  generatedAt: null,

  fetchToday: async () => {
    set({ loading: true, error: null })
    try {
      const result = await (window as any).electronAPI.sales.actionGetToday()
      set({
        items: result.items || [],
        stats: result.stats || null,
        generatedAt: result.generatedAt || Date.now(),
        loading: false
      })
      // 如果返回空且无错误，可能是启动时序问题，2秒后重试一次
      if ((!result.items || result.items.length === 0) && !result.error) {
        setTimeout(async () => {
          try {
            const retry = await (window as any).electronAPI.sales.actionGetToday()
            if (retry.items?.length > 0) {
              set({ items: retry.items, stats: retry.stats, generatedAt: retry.generatedAt })
            }
          } catch { /* ignore retry errors */ }
        }, 2000)
      }
    } catch (e: any) {
      // 启动时序竞争：SalesDbService 未初始化，3秒后重试
      const msg = e?.message || '加载失败'
      if (msg.includes('未初始化')) {
        set({ loading: false })
        setTimeout(() => get().fetchToday(), 3000)
      } else {
        set({ error: msg, loading: false })
      }
    }
  },

  completeItem: async (taskId: number, action: 'done' | 'skipped') => {
    try {
      await (window as any).electronAPI.sales.actionComplete(taskId, action)
      // 从列表中移除
      set(state => ({
        items: state.items.filter(item => item.id !== taskId)
      }))
    } catch (e) {
      console.error('完成行动失败:', e)
    }
  },

  fetchSuggestion: async (item: ActionItem) => {
    try {
      const result = await (window as any).electronAPI.sales.actionSuggest(item)
      set(state => ({
        items: state.items.map(i =>
          i.id === item.id
            ? { ...i, suggestion: result?.suggestion || '', suggestionError: result?.error, notConfigured: result?.notConfigured }
            : i
        )
      }))
    } catch (e: any) {
      set(state => ({
        items: state.items.map(i =>
          i.id === item.id ? { ...i, suggestionError: e?.message || '请求失败' } : i
        )
      }))
    }
  }
}))
