/**
 * todayActionStore.ts
 * 统一信号流 Zustand store
 */
import { create } from 'zustand'

export type SignalSource =
  | { type: 'task'; ruleCode: string; label: string; reason: string; rawTaskId: number }
  | { type: 'insight'; label: string; reason: string; rawInsightId: string; insightText?: string }

export interface ActionItem {
  sessionId: string
  displayName: string
  stage: string
  silentDays: number
  sources: SignalSource[]
  priorityScore: number
  urgencyTier: 'urgent' | 'high' | 'normal'
  status: string
  // Legacy compat fields (used by AI suggest)
  id: number
  triggerType: string
  title: string
  reason: string
  suggestion: string
  suggestionError?: string
  notConfigured?: boolean
  whyNow?: string
  opportunity?: string
  riskSignal?: string
  nextMove?: string
  degradationNote?: string
  priority: 'urgent' | 'high' | 'medium' | 'low' | 'info'
  createdAt: number
}

export interface ActionStats {
  totalSignals: number
  taskOnly: number
  insightOnly: number
  merged: number
  urgentCount: number
  highPriorityCount: number
  riskCustomerCount: number
  activeDeals: number
  todayPending: number
  // Legacy compat
  overdue: number
  newThisWeek: number
  pipelineTotal: number
  r6Count: number
}

export type SignalFilter = 'all' | 'task' | 'insight' | 'urgent'

interface TodayActionState {
  items: ActionItem[]
  stats: ActionStats | null
  loading: boolean
  error: string | null
  generatedAt: number | null
  filter: SignalFilter
  noticeDismissed: boolean
  _retryTimer: ReturnType<typeof setTimeout> | null

  setFilter: (f: SignalFilter) => void
  dismissNotice: () => void
  fetchToday: () => Promise<void>
  completeItem: (sessionId: string, action: 'done' | 'skipped') => Promise<void>
  fetchSuggestion: (item: ActionItem) => Promise<void>
}

function tierToPriority(tier: string): ActionItem['priority'] {
  if (tier === 'urgent') return 'urgent'
  if (tier === 'high') return 'high'
  return 'info'
}

function mapSignal(sig: any): ActionItem {
  const taskSource = sig.sources?.find((s: any) => s.type === 'task')
  return {
    sessionId: sig.sessionId,
    displayName: sig.displayName || '未知',
    stage: sig.stage || 'unknown',
    silentDays: sig.silentDays ?? 0,
    sources: sig.sources || [],
    priorityScore: sig.priorityScore ?? 0,
    urgencyTier: sig.urgencyTier || 'normal',
    status: sig.status || 'pending',
    // Legacy compat
    id: taskSource?.rawTaskId ?? 0,
    triggerType: taskSource?.ruleCode ?? '',
    title: sig.sources?.[0]?.reason || '',
    reason: sig.sources?.[0]?.reason || '',
    suggestion: '',
    priority: tierToPriority(sig.urgencyTier),
    createdAt: Date.now()
  }
}

export const useTodayActionStore = create<TodayActionState>((set, get) => ({
  items: [],
  stats: null,
  loading: false,
  error: null,
  generatedAt: null,
  filter: 'all',
  noticeDismissed: false,
  _retryTimer: null as ReturnType<typeof setTimeout> | null,

  setFilter: (f) => set({ filter: f }),
  dismissNotice: () => set({ noticeDismissed: true }),

  fetchToday: async () => {
    const prev = get()._retryTimer
    if (prev) { clearTimeout(prev); set({ _retryTimer: null }) }

    set({ loading: true, error: null })
    try {
      const result = await (window as any).electronAPI.sales.actionGetUnified()
      const items = (result.signals || []).map(mapSignal)
      set({
        items,
        stats: result.stats || null,
        generatedAt: result.generatedAt || Date.now(),
        loading: false
      })
      if (items.length === 0 && !result.error) {
        const timer = setTimeout(async () => {
          try {
            const retry = await (window as any).electronAPI.sales.actionGetUnified()
            if (retry.signals?.length > 0) {
              set({ items: (retry.signals || []).map(mapSignal), stats: retry.stats, generatedAt: retry.generatedAt, _retryTimer: null })
            }
          } catch { /* ignore */ }
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

  completeItem: async (sessionId: string, action: 'done' | 'skipped') => {
    try {
      await (window as any).electronAPI.sales.actionCompleteUnified(sessionId, action)
      set(state => ({
        items: state.items.filter(item => item.sessionId !== sessionId)
      }))
    } catch (e) {
      console.error('完成信号失败:', e)
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
          i.sessionId === item.sessionId ? { ...i, ...analysis } : i
        )
      }))
    } catch (e: any) {
      const errMsg = e?.message || '请求失败'
      set(state => ({
        items: state.items.map(i =>
          i.sessionId === item.sessionId ? { ...i, suggestionError: errMsg } : i
        )
      }))
    }
  }
}))
