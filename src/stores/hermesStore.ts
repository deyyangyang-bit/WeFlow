/**
 * hermesStore.ts —— Hermes 只读智能体路由页（/hermes）的上下文状态（zustand，零新依赖）
 *
 * 三入口（侧边栏「Hermes」/ 聊天页会话侧栏 / 客户档案「AI 工具」下拉 / 命令面板）统一调
 * openHermes(context) 注入上下文后 navigate('/hermes')，由 App.tsx 路由挂载的唯一一份
 * HermesPanel 消费。isHermesOpen 保留为打开标记（hermes-agent-test c4-c9 语义锚点）；
 * 上下文必须由入口声明（global / chat / customer 三态）。
 *
 * 任务真源在主进程内存（hermesAgent.getTask(taskId)）：本 store 只按上下文记任务 id 锚点
 * （lastTaskByContext，key 由 contextKeyOf 生成）——不同客户/会话/全局各记各的任务，
 * 切换入口不会把 A 上下文的任务正文串显到 B 上下文的标题下；离开 /hermes 路由都不删任务，
 * 切回原上下文时页面按该上下文的锚点恢复视图并重新订阅进度。
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

/** 异步收尾写视图门槛（取消竞态判定的唯一真源，HermesPanel.handleCancel 消费）：
 *  发起时捕获上下文 key + taskId，await 返回后只有「当前上下文与发起时一致 且
 *  该上下文的任务锚点仍指向同一任务」才允许 setTask——取消期间切到另一客户/聊天
 *  （key 变了）或另起新任务/清空锚点（锚点变了）都拒绝，绝不串显旧任务响应 */
export function canSettleTaskView(curKey: string, curAnchor: string | null, startedKey: string, taskId: string): boolean {
  return curKey === startedKey && curAnchor === taskId
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
