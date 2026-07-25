/**
 * followUpStore.ts
 *
 * 跟进待办 Zustand Store。
 */

import { create } from 'zustand'

export interface FollowUpTask {
  id: number
  session_id?: string
  customer_profile_id?: number
  display_name?: string
  source_message_id?: string
  promise_summary?: string
  action_type?: string
  trigger_type: string
  title: string
  due_at?: number
  status: string
  priority_score?: number
  created_by?: string
  confidence?: number
  feedback_log?: string
  created_at: number
  completed_at?: number
}

interface FollowUpState {
  loading: boolean
  tasks: FollowUpTask[]
  error: string | null

  loadTasks: (filters?: { status?: string }) => Promise<void>
  createTask: (payload: { session_id?: string; trigger_type: string; title: string; due_at?: number }) => Promise<void>
  updateTask: (id: number, updates: { status?: string; title?: string; due_at?: number }) => Promise<void>
  reset: () => void
}

export const useFollowUpStore = create<FollowUpState>((set, get) => ({
  loading: false,
  tasks: [],
  error: null,

  loadTasks: async (filters?) => {
    set({ loading: true, error: null })
    try {
      const result = await window.electronAPI.sales.todoList(filters)
      if (result.success) {
        set({ loading: false, tasks: result.tasks })
      } else {
        set({ loading: false, error: result.error || '加载失败' })
      }
    } catch (e) {
      set({ loading: false, error: String(e) })
    }
  },

  createTask: async (payload) => {
    try {
      const result = await window.electronAPI.sales.todoCreate(payload)
      if (result.success) {
        // 刷新列表
        await get().loadTasks()
      } else {
        set({ error: result.error || '创建失败' })
      }
    } catch (e) {
      set({ error: String(e) })
    }
  },

  updateTask: async (id, updates) => {
    try {
      const result = await window.electronAPI.sales.todoUpdate(id, updates)
      if (result.success) {
        set({
          tasks: get().tasks.map((t) => (t.id === id ? { ...t, ...updates } : t))
        })
      } else {
        set({ error: result.error || '更新失败' })
      }
    } catch (e) {
      set({ error: String(e) })
    }
  },

  reset: () => {
    set({ loading: false, tasks: [], error: null })
  }
}))
