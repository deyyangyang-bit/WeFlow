/**
 * customerListStore.ts
 * 客户列表页状态。数据来自 weflow-sales.db 的 customer_profile 表。
 */
import { create } from 'zustand'

export interface CustomerRow {
  id: number
  session_id: string
  display_name?: string | null
  stage: string
  tags: string          // JSON 数组字符串
  notes?: string | null
  last_contact_at?: number | null
  updated_at: number
  created_at: number
}

export interface CustomerListFilters {
  stage?: string
  search?: string
  sortBy?: 'updated_at' | 'last_contact_at' | 'stage'
}

interface CustomerListState {
  loading: boolean
  customers: CustomerRow[]
  filters: CustomerListFilters
  error: string | null
  loadCustomers: (filters?: CustomerListFilters) => Promise<void>
  setFilter: (patch: CustomerListFilters) => Promise<void>
}

export const useCustomerListStore = create<CustomerListState>((set, get) => ({
  loading: false,
  customers: [],
  filters: { sortBy: 'updated_at' },
  error: null,
  loadCustomers: async (filters) => {
    const useFilters = filters ?? get().filters
    set({ loading: true, error: null })
    try {
      const result = await window.electronAPI.sales.customerList(useFilters)
      if (result.success) {
        set({ loading: false, customers: (result.customers || []) as CustomerRow[], filters: useFilters })
      } else {
        set({ loading: false, error: result.error || '加载失败' })
      }
    } catch (e) {
      set({ loading: false, error: String(e) })
    }
  },
  setFilter: async (patch) => {
    const next = { ...get().filters, ...patch }
    await get().loadCustomers(next)
  }
}))
