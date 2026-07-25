/**
 * dashboardStore.ts
 * 销售仪表盘状态。纯本地聚合数据，无 WCDB/AI 调用。
 */
import { create } from 'zustand'
import type { DashboardStats } from '../types/electron'

interface DashboardState {
  loading: boolean
  stats: DashboardStats | null
  error: string | null
  loadStats: () => Promise<void>
}

export const useDashboardStore = create<DashboardState>((set) => ({
  loading: false,
  stats: null,
  error: null,
  loadStats: async () => {
    set({ loading: true, error: null })
    try {
      const result = await window.electronAPI.sales.dashboardStats()
      if (result.success && result.stats) {
        set({ loading: false, stats: result.stats })
      } else {
        set({ loading: false, error: result.error || '加载失败' })
      }
    } catch (e) {
      set({ loading: false, error: String(e) })
    }
  }
}))
