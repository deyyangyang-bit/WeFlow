// 应用内统一提示条（toast）状态：给外壳与后续页面提供一个公共出口。
// 2026-09-17 W2 Chrome：本波只建立能力与挂载点，既有页面私有 toast（.opp-toast / .insight-copy-toast /
// .kb-import-toast …）调用一律不动，按页波次再迁移。
import { create } from 'zustand'

export interface ToastEntry {
  /** 自增 id：同文案连发时也要重置计时器 */
  id: number
  message: string
}

interface ToastState {
  toast: ToastEntry | null
  showToast: (message: string) => void
  dismissToast: () => void
}

let toastSeq = 0

export const useToastStore = create<ToastState>((set) => ({
  toast: null,
  showToast: (message: string) => {
    const text = String(message ?? '').trim()
    if (!text) return
    toastSeq += 1
    set({ toast: { id: toastSeq, message: text } })
  },
  dismissToast: () => set({ toast: null })
}))

/** 组件外调用入口（service / 事件回调里用） */
export const showToast = (message: string): void => {
  useToastStore.getState().showToast(message)
}
