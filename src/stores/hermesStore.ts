/**
 * hermesStore.ts —— Hermes 只读智能体抽屉 App 级单例状态（zustand，零新依赖）
 *
 * 三入口（侧边栏「Hermes」/ 聊天页会话侧栏 / 客户档案「AI 工具」下拉）统一调 openHermes(context)，
 * 由 App.tsx 挂载的唯一一份 HermesPanel 消费。取代 knowledgeAskStore 的纯布尔开关：
 * 面板升级为带上下文的智能体工作台，入口必须声明上下文（global / chat / customer 三态）。
 *
 * 任务真源在主进程内存（hermesAgent.getTask(taskId)）：本 store 只记 lastTaskId 锚点，
 * 关闭抽屉 / 路由切换都不删任务——重开抽屉时面板按 lastTaskId 恢复视图并重新订阅进度。
 */
import { create } from 'zustand'

/** 三入口上下文：全局（侧边栏）/ 会话（聊天页）/ 客户（客户档案） */
export type HermesContext =
  | { kind: 'global' }
  | { kind: 'chat'; sessionId: string; sessionName: string }
  | { kind: 'customer'; accountId: number; sessionId: string; customerName: string }

interface HermesState {
  isHermesOpen: boolean
  context: HermesContext
  /** 最近一次任务 id（主进程内存真源的锚点；null=本次会话还没有任务） */
  lastTaskId: string | null
  /** ctx 缺省 = 全局入口（侧边栏）；打开不清任务、不重置 lastTaskId */
  openHermes: (ctx?: HermesContext) => void
  closeHermes: () => void
  setLastTaskId: (id: string | null) => void
}

export const useHermesStore = create<HermesState>((set) => ({
  isHermesOpen: false,
  context: { kind: 'global' },
  lastTaskId: null,
  openHermes: (ctx) => set({ isHermesOpen: true, context: ctx ?? { kind: 'global' } }),
  closeHermes: () => set({ isHermesOpen: false }),
  setLastTaskId: (id) => set({ lastTaskId: id })
}))
