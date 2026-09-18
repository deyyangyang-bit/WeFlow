import { useEffect, useState } from 'react'
import { Copy, Minus, Moon, PanelLeftClose, PanelLeftOpen, Search, Square, Sun, X } from 'lucide-react'
import { useThemeStore } from '../stores/themeStore'
import './TitleBar.scss'

interface TitleBarProps {
  title?: string
  sidebarCollapsed?: boolean
  onToggleSidebar?: () => void
  showWindowControls?: boolean
  customControls?: React.ReactNode
  showLogo?: boolean
  /** 主窗口外壳动作：给了才渲染 ⌘K 搜索按钮（独立窗口不传，保持原样） */
  onOpenPalette?: () => void
  /** 主窗口外壳动作：明暗切换图标按钮 */
  showThemeToggle?: boolean
}

const isMacPlatform = navigator.userAgent.toLowerCase().includes('mac')

function TitleBar({
  title,
  sidebarCollapsed = false,
  onToggleSidebar,
  showWindowControls = true,
  customControls,
  showLogo = true,
  onOpenPalette,
  showThemeToggle = false
}: TitleBarProps = {}) {
  const [isMaximized, setIsMaximized] = useState(false)
  const themeMode = useThemeStore((s) => s.themeMode)
  const toggleThemeMode = useThemeStore((s) => s.toggleThemeMode)
  // 跟随系统时图标按「下一步会切到哪边」显示：system 视作浅色起点
  const darkActive = themeMode === 'dark'

  useEffect(() => {
    if (!showWindowControls) return

    void window.electronAPI.window.isMaximized().then(setIsMaximized).catch(() => {
      setIsMaximized(false)
    })

    return window.electronAPI.window.onMaximizeStateChanged((maximized) => {
      setIsMaximized(maximized)
    })
  }, [showWindowControls])

  return (
    <div className="title-bar">
      <div className="title-brand">
        {showLogo && <img src="./logo.png" alt="WeFlow" className="title-logo" />}
        <span className="titles">{title || 'WeFlow'}</span>
        {onToggleSidebar ? (
          <button
            type="button"
            className="title-sidebar-toggle"
            onClick={onToggleSidebar}
            title={sidebarCollapsed ? '展开菜单' : '收起菜单'}
            aria-label={sidebarCollapsed ? '展开菜单' : '收起菜单'}
          >
            {sidebarCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
          </button>
        ) : null}
      </div>
      {customControls ? (
        <div className="title-custom-controls">
          {customControls}
        </div>
      ) : null}
      <div className="title-drag-spacer" aria-hidden="true" />
      {(onOpenPalette || showThemeToggle) ? (
        <div className="titlebar__right">
          {onOpenPalette ? (
            <button type="button" className="kbtn" onClick={onOpenPalette}>
              <Search size={13} strokeWidth={1.6} />
              搜索客户、会话
              <kbd>{isMacPlatform ? '⌘K' : 'Ctrl K'}</kbd>
            </button>
          ) : null}
          {showThemeToggle ? (
            <button
              type="button"
              className="iconbtn"
              onClick={toggleThemeMode}
              title={darkActive ? '切到浅色' : '切到深色'}
              aria-label={darkActive ? '切到浅色' : '切到深色'}
            >
              {darkActive ? <Sun size={16} strokeWidth={1.6} /> : <Moon size={16} strokeWidth={1.6} />}
            </button>
          ) : null}
        </div>
      ) : null}
      {showWindowControls ? (
        <div className="title-window-controls">
          <button
            type="button"
            className="title-window-control-btn"
            aria-label="最小化"
            title="最小化"
            onClick={() => window.electronAPI.window.minimize()}
          >
            <Minus size={14} />
          </button>
          <button
            type="button"
            className="title-window-control-btn"
            aria-label={isMaximized ? '还原' : '最大化'}
            title={isMaximized ? '还原' : '最大化'}
            onClick={() => window.electronAPI.window.maximize()}
          >
            {isMaximized ? <Copy size={12} /> : <Square size={12} />}
          </button>
          <button
            type="button"
            className="title-window-control-btn is-close"
            aria-label="关闭"
            title="关闭"
            onClick={() => window.electronAPI.window.close()}
          >
            <X size={14} />
          </button>
        </div>
      ) : null}
    </div>
  )
}

export default TitleBar
