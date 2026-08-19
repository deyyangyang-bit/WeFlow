/**
 * salesReportStore.ts
 * 销售报表状态管理（Zustand）
 * 三类报告：周报 / 月报（统计口径 ReportStats）/ 周复盘（经营口径 WeeklyReviewStats）
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

export interface WeeklyReviewStats {
  pipelineTotal: number
  stageCounts: Record<string, number>
  activeCount: number
  hotCount: number
  coldCount: number
  dropCount: number
  activeCustomers: string[]
  hotCustomers: string[]
  coldCustomers: string[]
  dropCandidates: string[]
  stageLabel: Record<string, string>
}

interface SalesReportState {
  reports: ReportRecord[]
  currentReport: ReportRecord | null
  currentStats: ReportStats | null
  currentReviewStats: WeeklyReviewStats | null
  generating: boolean
  error: string | null
  periodType: 'week' | 'month'

  setPeriodType: (type: 'week' | 'month') => void
  generateReport: () => Promise<void>
  generateReview: () => Promise<void>
  fetchReports: () => Promise<void>
  viewReport: (id: number) => void
  deleteReport: (id: number) => Promise<void>
}

export const useSalesReportStore = create<SalesReportState>((set, get) => ({
  reports: [],
  currentReport: null,
  currentStats: null,
  currentReviewStats: null,
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
        set({ currentReport: result.report, currentStats: stats, currentReviewStats: null, generating: false })
        await get().fetchReports()
      } else {
        set({ generating: false, error: result.error ?? '生成失败' })
      }
    } catch (e) {
      set({ generating: false, error: String(e) })
    }
  },

  generateReview: async () => {
    set({ generating: true, error: null })
    try {
      const result = await window.electronAPI.sales.reviewGenerate()
      if (result.success && result.report) {
        const stats: WeeklyReviewStats = JSON.parse(result.report.stats)
        set({ currentReport: result.report, currentReviewStats: stats, currentStats: null, generating: false })
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
    if (!report) return
    let parsed: unknown
    try { parsed = JSON.parse(report.stats) } catch { /* 脏 stats 走兜底 */ }

    // 周复盘：校验结构（关键字段存在才渲染统计，历史脏数据仅保留报告头，防止页面崩溃）
    if (report.period_type === 'weekly_review') {
      const r = parsed as Partial<WeeklyReviewStats>
      const isReview = !!r && typeof r === 'object'
        && Array.isArray(r.hotCustomers) && Array.isArray(r.coldCustomers)
        && Array.isArray(r.dropCandidates) && typeof r.pipelineTotal === 'number'
      set({
        currentReport: report,
        currentReviewStats: isReview ? (r as WeeklyReviewStats) : null,
        currentStats: null
      })
      return
    }

    // 周报/月报：校验 dailyMessageCounts 数组（避免访问 undefined.length 崩溃）
    const stats = parsed as Partial<ReportStats>
    const isStats = !!stats && typeof stats === 'object' && Array.isArray(stats.dailyMessageCounts)
    set({
      currentReport: report,
      currentStats: isStats ? (stats as ReportStats) : null,
      currentReviewStats: null
    })
  },

  deleteReport: async (id) => {
    try {
      const result = await window.electronAPI.sales.reportDelete(id)
      if (result.success) {
        set(state => ({
          reports: state.reports.filter(r => r.id !== id),
          currentReport: state.currentReport?.id === id ? null : state.currentReport,
          currentStats: state.currentReport?.id === id ? null : state.currentStats,
          currentReviewStats: state.currentReport?.id === id ? null : state.currentReviewStats
        }))
      }
    } catch (e) {
      console.error('[SalesReportStore] deleteReport error:', e)
    }
  }
}))
