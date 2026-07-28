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
    } catch (e: any) {
      set({ error: e?.message || '加载失败', loading: false })
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
      if (result?.suggestion) {
        set(state => ({
          items: state.items.map(i =>
            i.id === item.id ? { ...i, suggestion: result.suggestion } : i
          )
        }))
      }
    } catch (e) {
      console.error('获取建议失败:', e)
    }
  }
}))
