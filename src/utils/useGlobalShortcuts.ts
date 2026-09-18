// 全局快捷键（概念稿「全局」节）：⌘K 开命令面板、⌘1/⌘2/⌘3 切前三屏。
// Esc 关浮层由各自的浮层组件处理（面板 / 弹窗自己监听），这里不抢按键。
// 只在主窗口挂载；输入框内 ⌘K 仍然生效（这是搜索入口的通用约定），⌘1-3 在面板打开时让位给输入。
import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { NAV_QUICK_ROUTES } from './appNav'

interface UseGlobalShortcutsOptions {
  enabled: boolean
  paletteOpen: boolean
  onTogglePalette: () => void
}

export function useGlobalShortcuts({ enabled, paletteOpen, onTogglePalette }: UseGlobalShortcutsOptions): void {
  const navigate = useNavigate()

  useEffect(() => {
    if (!enabled) return

    const handler = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey
      if (!mod || event.altKey || event.shiftKey) return

      const key = event.key.toLowerCase()
      if (key === 'k') {
        event.preventDefault()
        onTogglePalette()
        return
      }

      // ⌘1/⌘2/⌘3 = 侧栏顺序的前三个可跳转路由（今日行动 / 聊天 / 线索）
      if (paletteOpen || event.repeat) return
      const index = ['1', '2', '3'].indexOf(key)
      const target = index >= 0 ? NAV_QUICK_ROUTES[index] : undefined
      if (target) {
        event.preventDefault()
        navigate(target)
      }
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [enabled, paletteOpen, onTogglePalette, navigate])
}
