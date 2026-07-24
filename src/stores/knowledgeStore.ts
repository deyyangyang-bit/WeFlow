/**
 * knowledgeStore.ts
 * 知识库状态管理（Zustand）
 */

import { create } from 'zustand'

// ─── 类型 ────────────────────────────────────────────────────────────────────

export interface KnowledgeEntry {
  id: number
  category: string
  product_line?: string
  title: string
  content: string
  tags: string        // JSON 数组字符串
  scene?: string
  created_at: number
  updated_at: number
}

interface KnowledgeState {
  entries: KnowledgeEntry[]
  total: number
  loading: boolean
  searchKeyword: string
  filterCategory: string    // '' 表示全部
  filterProductLine: string
  editingEntry: KnowledgeEntry | null
  showForm: boolean

  // Actions
  fetchList: (filters?: { category?: string; product_line?: string }) => Promise<void>
  search: (keyword: string) => Promise<void>
  createEntry: (payload: { category: string; product_line?: string; title: string; content: string; tags?: string[]; scene?: string }) => Promise<boolean>
  updateEntry: (id: number, payload: { category?: string; product_line?: string; title?: string; content?: string; tags?: string[]; scene?: string }) => Promise<boolean>
  deleteEntry: (id: number) => Promise<boolean>
  setSearchKeyword: (keyword: string) => void
  setFilterCategory: (category: string) => void
  setFilterProductLine: (productLine: string) => void
  openForm: (entry?: KnowledgeEntry | null) => void
  closeForm: () => void
}

// ─── Store ───────────────────────────────────────────────────────────────────

export const useKnowledgeStore = create<KnowledgeState>((set, get) => ({
  entries: [],
  total: 0,
  loading: false,
  searchKeyword: '',
  filterCategory: '',
  filterProductLine: '',
  editingEntry: null,
  showForm: false,

  fetchList: async (filters) => {
    set({ loading: true })
    try {
      const result = await window.electronAPI.sales.kbList(filters)
      if (result.success) {
        set({ entries: result.entries, total: result.total })
      }
    } catch (e) {
      console.error('[KnowledgeStore] fetchList error:', e)
    } finally {
      set({ loading: false })
    }
  },

  search: async (keyword) => {
    set({ loading: true, searchKeyword: keyword })
    try {
      const { filterCategory, filterProductLine } = get()
      const result = await window.electronAPI.sales.kbSearch({
        keyword,
        category: filterCategory || undefined,
        product_line: filterProductLine || undefined
      })
      if (result.success) {
        set({ entries: result.entries, total: result.total })
      }
    } catch (e) {
      console.error('[KnowledgeStore] search error:', e)
    } finally {
      set({ loading: false })
    }
  },

  createEntry: async (payload) => {
    try {
      const result = await window.electronAPI.sales.kbCreate(payload)
      if (result.success) {
        const { searchKeyword, filterCategory, filterProductLine } = get()
        if (searchKeyword) {
          await get().search(searchKeyword)
        } else {
          await get().fetchList({
            category: filterCategory || undefined,
            product_line: filterProductLine || undefined
          })
        }
        return true
      }
      return false
    } catch {
      return false
    }
  },

  updateEntry: async (id, payload) => {
    try {
      const result = await window.electronAPI.sales.kbUpdate(id, payload)
      if (result.success) {
        const { searchKeyword, filterCategory, filterProductLine } = get()
        if (searchKeyword) {
          await get().search(searchKeyword)
        } else {
          await get().fetchList({
            category: filterCategory || undefined,
            product_line: filterProductLine || undefined
          })
        }
        return true
      }
      return false
    } catch {
      return false
    }
  },

  deleteEntry: async (id) => {
    try {
      const result = await window.electronAPI.sales.kbDelete(id)
      if (result.success) {
        set(state => ({
          entries: state.entries.filter(e => e.id !== id),
          total: state.total - 1
        }))
        return true
      }
      return false
    } catch {
      return false
    }
  },

  setSearchKeyword: (keyword) => set({ searchKeyword: keyword }),
  setFilterCategory: (category) => set({ filterCategory: category }),
  setFilterProductLine: (productLine) => set({ filterProductLine: productLine }),

  openForm: (entry = null) => set({ showForm: true, editingEntry: entry }),
  closeForm: () => set({ showForm: false, editingEntry: null })
}))
