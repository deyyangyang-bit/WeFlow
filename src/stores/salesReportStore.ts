/**
 * salesReportStore.ts
 * 销售报表状态管理（Zustand）
 */

import { create } from 'zustand'

export interface ReportRecord {
  id: number
  period_type: string
  period_start: number
  period_end: number
  stats: string
  ai_summary?: string | null
  created_at: number
}

export interface ReportStats {
  totalMessages: number
  activeContacts: number
  topContacts: Array<{
    sessionId: string
    displayName: string
    avatarUrl?: string
    messageCount: number
  }>
  dailyMessageCounts: Array<{ date: string; count: number }>
  myMessageCount: number
  peerMessageCount: number
}

interface SalesReportState {
  reports: ReportRecord[]
  currentReport: ReportRecord | null
  currentStats: ReportStats | null
  generating: boolean
  error: string | null
  periodType: 'week' | 'month'

  setPeriodType: (type: 'week' | 'month') => void
  generateReport: () => Promise<void>
  fetchReports: () => Promise<void>
  viewReport: (id: number) => void
  deleteReport: (id: number) => Promise<void>
}

export const useSalesReportStore = create<SalesReportState>((set, get) => ({
  reports: [],
  currentReport: null,
  currentStats: null,
  generating: false,
  error: null,
  periodType: 'week',

  setPeriodType: (type) => set({ periodType: type }),

  generateReport: async () => {
    const { periodType } = get()
    set({ generating: true, error: null })
    try {
      const result = await window.electronAPI.sales.reportGenerate({ period_type: periodType })
      if (result.success && result.report) {
        const stats: ReportStats = JSON.parse(result.report.stats)
        set({ currentReport: result.report, currentStats: stats, generating: false })
        await get().fetchReports()
      } else {
        set({ generating: false, error: result.error ?? '生成失败' })
      }
    } catch (e) {
      set({ generating: false, error: String(e) })
    }
  },

  fetchReports: async () => {
    try {
      const result = await window.electronAPI.sales.reportList(20)
      if (result.success) set({ reports: result.reports ?? [] })
    } catch (e) {
      console.error('[SalesReportStore] fetchReports error:', e)
    }
  },

  viewReport: (id) => {
    const { reports } = get()
    const report = reports.find(r => r.id === id)
    if (report) {
      try {
        const stats: ReportStats = JSON.parse(report.stats)
        set({ currentReport: report, currentStats: stats })
      } catch {
        set({ currentReport: report, currentStats: null })
      }
    }
  },

  deleteReport: async (id) => {
    try {
      const result = await window.electronAPI.sales.reportDelete(id)
      if (result.success) {
        set(state => ({
          reports: state.reports.filter(r => r.id !== id),
          currentReport: state.currentReport?.id === id ? null : state.currentReport,
          currentStats: state.currentReport?.id === id ? null : state.currentStats
        }))
      }
    } catch (e) {
      console.error('[SalesReportStore] deleteReport error:', e)
    }
  }
}))
