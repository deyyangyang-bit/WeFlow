/**
 * knowledgeAskStore.ts —— Hermes「问一问」App 级全局开关（zustand，零新依赖）
 * 三入口（侧边栏「问一问」/ 聊天页会话侧栏书本图标 / 客户档案「AI 工具」下拉）统一调
 * openKnowledgeAsk()，由 App.tsx 挂载的唯一一份 KnowledgeAskPanel 消费 isKnowledgeAskOpen，
 * 全应用运行时只存在一份面板实例。
 * KnowledgeAskPanel 现仅接收 open/onClose（无 sessionId/客户上下文参数），故状态只有开关布尔；
 * 面板未来若需上下文，在此扩展可选字段即可，入口签名不变。
 */
import { create } from 'zustand'

interface KnowledgeAskState {
  isKnowledgeAskOpen: boolean
  openKnowledgeAsk: () => void
  closeKnowledgeAsk: () => void
}

export const useKnowledgeAskStore = create<KnowledgeAskState>((set) => ({
  isKnowledgeAskOpen: false,
  openKnowledgeAsk: () => set({ isKnowledgeAskOpen: true }),
  closeKnowledgeAsk: () => set({ isKnowledgeAskOpen: false })
}))
