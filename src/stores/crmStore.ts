/**
 * crmStore.ts —— CRM 模块状态管理（Zustand）
 */
import { create } from 'zustand'

interface CrmState {
  workbench: any[]
  queues: { allocations: any[]; logistics: any[]; payments: any[]; invoices: any[] }
  products: any[]
  groups: any[]
  loading: boolean
  notice: string

  fetchWorkbench: () => Promise<void>
  fetchQueues: () => Promise<void>
  fetchProducts: () => Promise<void>
  fetchGroups: () => Promise<void>
  setNotice: (s: string) => void
  scanNow: () => Promise<void>
}

export const useCrmStore = create<CrmState>((set, get) => ({
  workbench: [],
  queues: { allocations: [], logistics: [], payments: [], invoices: [] },
  products: [],
  groups: [],
  loading: false,
  notice: '',

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
  }
}))
