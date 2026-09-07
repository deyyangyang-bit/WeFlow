/**
 * hermesStore.ts —— Hermes 只读智能体抽屉 App 级单例状态（zustand，零新依赖）
 *
 * 三入口（侧边栏「Hermes」/ 聊天页会话侧栏 / 客户档案「AI 工具」下拉）统一调 openHermes(context)，
 * 由 App.tsx 挂载的唯一一份 HermesPanel 消费。取代 knowledgeAskStore 的纯布尔开关：
 * 面板升级为带上下文的智能体工作台，入口必须声明上下文（global / chat / customer 三态）。
 *
 * 任务真源在主进程内存（hermesAgent.getTask(taskId)）：本 store 只按上下文记任务 id 锚点
 * （lastTaskByContext，key 由 contextKeyOf 生成）——不同客户/会话/全局各记各的任务，
 * 切换入口不会把 A 上下文的任务正文串显到 B 上下文的标题下；关闭抽屉 / 路由切换都不删任务，
 * 切回原上下文时面板按该上下文的锚点恢复视图并重新订阅进度。
 */
import { create } from 'zustand'

/** 三入口上下文：全局（侧边栏）/ 会话（聊天页）/ 客户（客户档案） */
export type HermesContext =
  | { kind: 'global' }
  | { kind: 'chat'; sessionId: string; sessionName: string }
  | { kind: 'customer'; accountId: number; sessionId: string; customerName: string }

/** 上下文 → 任务锚点 key（每个上下文独立记忆任务；同客户/同会话切回可恢复） */
export function contextKeyOf(ctx: HermesContext): string {
  if (ctx.kind === 'customer') return `customer:${ctx.accountId}`
  if (ctx.kind === 'chat') return `chat:${ctx.sessionId}`
  return 'global'
}

interface HermesState {
  isHermesOpen: boolean
  context: HermesContext
  /** 各上下文最近一次任务 id（主进程内存真源的锚点；无记录 = 该上下文还没有任务） */
  lastTaskByContext: Record<string, string>
  /** ctx 缺省 = 全局入口（侧边栏）；打开只切上下文，不碰任何任务锚点 */
  openHermes: (ctx?: HermesContext) => void
  closeHermes: () => void
  /** 记录任务锚点：key 显式传入则写到该上下文（startTask 返回前用户切走上下文时仍写回发起方），
   *  缺省写「当前上下文」；id=null 删除该锚点 */
  setLastTaskId: (id: string | null, key?: string) => void
}

export const useHermesStore = create<HermesState>((set, get) => ({
  isHermesOpen: false,
  context: { kind: 'global' },
  lastTaskByContext: {},
  openHermes: (ctx) => set({ isHermesOpen: true, context: ctx ?? { kind: 'global' } }),
  closeHermes: () => set({ isHermesOpen: false }),
  setLastTaskId: (id, key) => {
    const k = key ?? contextKeyOf(get().context)
    set((s) => {
      const next = { ...s.lastTaskByContext }
      if (id) next[k] = id
      else delete next[k]
      return { lastTaskByContext: next }
    })
  }
}))
