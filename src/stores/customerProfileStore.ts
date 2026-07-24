/**
 * customerProfileStore.ts
 *
 * 客户画像卡片 Zustand Store。
 * 聚合展示单客户的消息统计、意向阶段、标签备注、AI 画像、意向历史和跟进待办。
 */

import { create } from 'zustand'

// ─── 类型 ────────────────────────────────────────────────────────────────────

export interface CustomerProfileData {
  id: number
  session_id: string
  display_name?: string
  customer_id?: string
  stage: string
  tags: string
  notes?: string
  last_contact_at?: number
  created_at: number
  updated_at: number
}

export interface MessageStats {
  total: number
  firstContactAt: number | null
  lastContactAt: number | null
}

export interface IntentTagRecord {
  id: number
  session_id: string
  stage: string
  confidence?: number
  source: string
  reason?: string
  created_at: number
}

export interface TodoRecord {
  id: number
  session_id?: string
  trigger_type: string
  title: string
  due_at?: number
  status: string
  created_at: number
}

interface CustomerProfileState {
  loading: boolean
  sessionId: string | null
  profile: CustomerProfileData | null
  messageStats: MessageStats | null
  aiProfile: string
  aiProfileMeta: { rangeStart?: number; rangeEnd?: number; updatedAt?: number } | null
  intentHistory: IntentTagRecord[]
  todos: TodoRecord[]
  error: string | null

  // actions
  loadDetail: (sessionId: string) => Promise<void>
  updateStage: (sessionId: string, stage: string) => Promise<void>
  updateTags: (sessionId: string, tags: string[]) => Promise<void>
  updateNotes: (sessionId: string, notes: string) => Promise<void>
  toggleTodo: (id: number, currentStatus: string) => Promise<void>
  reset: () => void
}

// ─── Store ───────────────────────────────────────────────────────────────────

export const useCustomerProfileStore = create<CustomerProfileState>((set, get) => ({
  loading: false,
  sessionId: null,
  profile: null,
  messageStats: null,
  aiProfile: '',
  aiProfileMeta: null,
  intentHistory: [],
  todos: [],
  error: null,

  loadDetail: async (sessionId: string) => {
    const current = get().sessionId
    if (current === sessionId && get().profile) return // 已加载

    set({ loading: true, sessionId, error: null })
    try {
      const result = await window.electronAPI.sales.customerDetail(sessionId)
      if (result.success && result.data) {
        set({
          loading: false,
          profile: result.data.profile,
          messageStats: result.data.messageStats,
          aiProfile: result.data.aiProfile,
          aiProfileMeta: result.data.aiProfileMeta,
          intentHistory: result.data.intentHistory,
          todos: result.data.todos
        })
      } else {
        set({ loading: false, error: result.error || '加载失败' })
      }
    } catch (e) {
      set({ loading: false, error: String(e) })
    }
  },

  updateStage: async (sessionId: string, stage: string) => {
    try {
      // 更新 customer_profile 的 stage
      await window.electronAPI.sales.customerUpsert({ session_id: sessionId, stage })
      // 记录意向变更日志
      await window.electronAPI.sales.intentCorrect({ session_id: sessionId, stage, reason: '手动切换阶段' })
      // 刷新数据
      set({ sessionId: null }) // 强制重新加载
      await get().loadDetail(sessionId)
    } catch (e) {
      set({ error: String(e) })
    }
  },

  updateTags: async (sessionId: string, tags: string[]) => {
    try {
      await window.electronAPI.sales.customerUpsert({ session_id: sessionId, tags: JSON.stringify(tags) })
      const profile = get().profile
      if (profile) {
        set({ profile: { ...profile, tags: JSON.stringify(tags) } })
      }
    } catch (e) {
      set({ error: String(e) })
    }
  },

  updateNotes: async (sessionId: string, notes: string) => {
    try {
      await window.electronAPI.sales.customerUpsert({ session_id: sessionId, notes })
      const profile = get().profile
      if (profile) {
        set({ profile: { ...profile, notes } })
      }
    } catch (e) {
      set({ error: String(e) })
    }
  },

  toggleTodo: async (id: number, currentStatus: string) => {
    try {
      const newStatus = currentStatus === 'done' ? 'pending' : 'done'
      await window.electronAPI.sales.todoUpdate(id, { status: newStatus })
      set({
        todos: get().todos.map((t) => (t.id === id ? { ...t, status: newStatus } : t))
      })
    } catch (e) {
      set({ error: String(e) })
    }
  },

  reset: () => {
    set({
      loading: false,
      sessionId: null,
      profile: null,
      messageStats: null,
      aiProfile: '',
      aiProfileMeta: null,
      intentHistory: [],
      todos: [],
      error: null
    })
  }
}))
