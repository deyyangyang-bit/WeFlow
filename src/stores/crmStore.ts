/**
 * crmStore.ts —— CRM 模块状态管理（Zustand）
 */
import { create } from 'zustand'

interface AutoConfirmHistoryItem {
  id: number
  entity: string
  entity_id: number
  decision: string
  confidence: number
  reason: string
  action: string
  created_at: number
}
interface AutoSummary {
  lastRun: { auto: number; reviewed: number; byEntity: Record<string, { auto: number; reviewed: number }> } | null
  history: AutoConfirmHistoryItem[]
}

interface CrmState {
  workbench: any[]
  queues: { allocations: any[]; logistics: any[]; payments: any[]; invoices: any[]; infoPending: any[] }
  products: any[]
  groups: any[]
  loading: boolean
  notice: string
  autoSummary: AutoSummary

  fetchWorkbench: () => Promise<void>
  fetchQueues: () => Promise<void>
  fetchProducts: () => Promise<void>
  fetchGroups: () => Promise<void>
  setNotice: (s: string) => void
  scanNow: () => Promise<void>
  fetchAutoSummary: () => Promise<void>
  runAutoConfirm: () => Promise<{ auto: number; reviewed: number }>
  undoAutoConfirm: (entity: string, id: number) => Promise<{ ok: boolean; reason?: string }>
}

export const useCrmStore = create<CrmState>((set, get) => ({
  workbench: [],
  queues: { allocations: [], logistics: [], payments: [], invoices: [], infoPending: [] },
  products: [],
  groups: [],
  loading: false,
  notice: '',
  autoSummary: { lastRun: null, history: [] },

  fetchWorkbench: async () => {
    const rows = await window.electronAPI.crm.workbench()
    set({ workbench: rows || [] })
  },
  fetchQueues: async () => {
    const q = await window.electronAPI.crm.reviewQueues()
    if (q) set({ queues: q })
  },
  fetchProducts: async () => {
    const rows = await window.electronAPI.crm.list('product', { limit: 500 })
    set({ products: rows || [] })
  },
  fetchGroups: async () => {
    const rows = await window.electronAPI.crm.groupsList()
    set({ groups: rows || [] })
  },
  setNotice: (s) => set({ notice: s }),
  scanNow: async () => {
    set({ loading: true, notice: '正在扫描群消息…' })
    const r = await window.electronAPI.crm.parseScanNow()
    set({ loading: false, notice: `扫描完成，处理 ${r?.scanned ?? 0} 条新消息` })
    await get().fetchQueues()
    await get().fetchWorkbench()
    await get().fetchAutoSummary()
  },
  fetchAutoSummary: async () => {
    const history = await window.electronAPI.crm.autoConfirmHistory(50)
    set((s) => ({ autoSummary: { ...s.autoSummary, history: history || [] } }))
  },
  runAutoConfirm: async () => {
    const r = await window.electronAPI.crm.autoConfirmRun()
    const summary = r || { auto: 0, reviewed: 0, byEntity: {} }
    set((s) => ({ autoSummary: { ...s.autoSummary, lastRun: summary } }))
    // 自动处理会改队列与工作台，跑完立即刷新
    await get().fetchQueues()
    await get().fetchWorkbench()
    await get().fetchAutoSummary()
    set({ notice: `自动确认完成：处理 ${summary.auto} 条，待人工 ${summary.reviewed} 条` })
    return summary
  },
  undoAutoConfirm: async (entity, id) => {
    const r = await window.electronAPI.crm.autoConfirmUndo(entity, id)
    await get().fetchQueues()
    await get().fetchWorkbench()
    await get().fetchAutoSummary()
    return r || { ok: false, reason: '撤销失败' }
  }
}))
