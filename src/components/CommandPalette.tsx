// 命令面板（⌘K）：搜客户、会话、页面与动作四类目标。
// 样式归本组件（./CommandPalette.scss，2026-09-18 从 main.scss 迁出：.overlay/.palette*/.prow 只有本组件用，
// 迁出后不再占用全局命名空间；组件由 App 直接渲染、不走 portal，样式随 import 一起到达）。
// 数据全部来自现有 IPC 与现有 store，不新增口径：客户 = crm.customers()，会话 = chat.getSessions()。
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Bot, Lock, LockOpen, MessageSquare, Moon, Search, Settings, Sun, UserCircle, Users } from 'lucide-react'
import { NAV_FLAT, type NavItemDef } from '../utils/appNav'
import { useAppStore } from '../stores/appStore'
import { useHermesStore } from '../stores/hermesStore'
import { useThemeStore } from '../stores/themeStore'
import './CommandPalette.scss'

interface PaletteItem {
  key: string
  group: '页面' | '动作' | '客户' | '会话'
  label: string
  hint?: string
  icon: ReactNode
  /** 关键词命中范围（label/hint 之外还要参与匹配的字段） */
  keywords?: string
  run: () => void
}

interface CommandPaletteProps {
  open: boolean
  onClose: () => void
}

const GROUP_ORDER: PaletteItem['group'][] = ['页面', '动作', '客户', '会话']
const ASYNC_GROUP_LIMIT = 8
const FETCH_LIMIT = 300
const isMacPlatform = navigator.userAgent.toLowerCase().includes('mac')

function CommandPalette({ open, onClose }: CommandPaletteProps) {
  const navigate = useNavigate()
  const location = useLocation()
  const openHermes = useHermesStore((s) => s.openHermes)
  const setLocked = useAppStore((s) => s.setLocked)
  const themeMode = useThemeStore((s) => s.themeMode)
  const toggleThemeMode = useThemeStore((s) => s.toggleThemeMode)

  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const [authEnabled, setAuthEnabled] = useState(false)
  const [customers, setCustomers] = useState<Array<{ id: number; name: string; hint?: string; sessionId: string }>>([])
  const [sessions, setSessions] = useState<Array<{ username: string; name: string; hint?: string }>>([])
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)

  const close = useCallback(() => {
    setQuery('')
    setSelected(0)
    onClose()
  }, [onClose])

  // 打开时拉取一次数据（客户 / 会话 / 应用锁状态）；关闭即作废，避免慢返回覆盖新状态
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setQuery('')
    setSelected(0)

    window.electronAPI.auth.verifyEnabled().then((enabled) => {
      if (!cancelled) setAuthEnabled(Boolean(enabled))
    }).catch(() => { /* 读不到按未开启应用锁处理 */ })

    void (async () => {
      const [customerRows, sessionResult] = await Promise.allSettled([
        window.electronAPI.crm.customers(),
        window.electronAPI.chat.getSessions()
      ])
      if (cancelled) return
      if (customerRows.status === 'fulfilled') {
        setCustomers((customerRows.value || []).slice(0, FETCH_LIMIT).map((c: any) => ({
          id: Number(c?.id) || 0,
          name: String(c?.profile_display_name || '') || String(c?.name || '') || `客户 #${c?.id ?? ''}`,
          hint: c?.phone ? String(c.phone) : undefined,
          sessionId: String(c?.session_id || '')
        })).filter((c) => c.id > 0))
      }
      if (sessionResult.status === 'fulfilled' && sessionResult.value?.success) {
        setSessions((sessionResult.value.sessions || []).slice(0, FETCH_LIMIT).map((s) => ({
          username: s.username,
          name: s.displayName || s.username,
          hint: s.unreadCount > 0 ? `${s.unreadCount} 条未读` : undefined
        })).filter((s) => Boolean(s.username)))
      }
    })()

    return () => { cancelled = true }
  }, [open])

  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  const items = useMemo<PaletteItem[]>(() => {
    const pages: PaletteItem[] = NAV_FLAT
      .filter((item): item is Extract<NavItemDef, { path: string }> => 'path' in item)
      .map((item, index) => ({
        key: `page:${item.path}`,
        group: '页面',
        label: item.label,
        hint: index < 3 ? `${isMacPlatform ? '⌘' : 'Ctrl '}${index + 1}` : undefined,
        icon: <item.icon size={16} strokeWidth={1.6} />,
        keywords: item.path,
        run: () => { navigate(item.path) }
      }))

    const actions: PaletteItem[] = [
      {
        key: 'action:theme',
        group: '动作',
        label: themeMode === 'dark' ? '切到浅色' : '切到深色',
        icon: themeMode === 'dark' ? <Sun size={16} strokeWidth={1.6} /> : <Moon size={16} strokeWidth={1.6} />,
        keywords: '明暗 主题 dark light',
        run: () => { toggleThemeMode() }
      },
      {
        key: 'action:hermes',
        group: '动作',
        label: '打开 Hermes',
        icon: <Bot size={16} strokeWidth={1.6} />,
        keywords: '智能体 ai',
        run: () => { openHermes(); navigate('/hermes') }
      },
      {
        key: 'action:contacts',
        group: '动作',
        label: '账号管理',
        icon: <UserCircle size={16} strokeWidth={1.6} />,
        keywords: '微信 账号 account',
        run: () => { navigate('/account-management') }
      },
      {
        key: 'action:settings',
        group: '动作',
        label: '打开设置',
        icon: <Settings size={16} strokeWidth={1.6} />,
        keywords: '设置 偏好 settings preferences',
        run: () => { navigate('/settings', { state: { backgroundLocation: location } }) }
      },
      {
        key: 'action:lock',
        group: '动作',
        label: authEnabled ? '锁定应用' : '开启应用锁',
        icon: authEnabled ? <Lock size={16} strokeWidth={1.6} /> : <LockOpen size={16} strokeWidth={1.6} />,
        keywords: '锁 安全 security',
        run: () => {
          if (authEnabled) { setLocked(true); return }
          navigate('/settings', { state: { initialTab: 'security', backgroundLocation: location } })
        }
      }
    ]

    const customerItems: PaletteItem[] = customers.map((c) => ({
      key: `customer:${c.id}`,
      group: '客户',
      label: c.name,
      hint: c.hint,
      icon: <Users size={16} strokeWidth={1.6} />,
      // 有会话的客户直接进聊天（与客户工作台 openChat 同路径），没会话的进档案抽屉
      run: () => {
        if (c.sessionId) navigate(`/chat?sessionId=${encodeURIComponent(c.sessionId)}`)
        else navigate(`/customers?id=${c.id}`)
      }
    }))

    const sessionItems: PaletteItem[] = sessions.map((s) => ({
      key: `session:${s.username}`,
      group: '会话',
      label: s.name,
      hint: s.hint,
      icon: <MessageSquare size={16} strokeWidth={1.6} />,
      keywords: s.username,
      run: () => { navigate(`/chat?sessionId=${encodeURIComponent(s.username)}`) }
    }))

    return [...pages, ...actions, ...customerItems, ...sessionItems]
  }, [authEnabled, customers, location, navigate, openHermes, sessions, setLocked, themeMode, toggleThemeMode])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const matched = q
      ? items.filter((item) => `${item.label} ${item.hint || ''} ${item.keywords || ''}`.toLowerCase().includes(q))
      : items.filter((item) => item.group === '页面' || item.group === '动作')

    const perGroup = new Map<PaletteItem['group'], number>()
    return matched.filter((item) => {
      const used = perGroup.get(item.group) || 0
      if (used >= ASYNC_GROUP_LIMIT && (item.group === '客户' || item.group === '会话')) return false
      perGroup.set(item.group, used + 1)
      return true
    })
  }, [items, query])

  // 选中项跟随过滤结果：结果变短时钳制，避免越界
  useEffect(() => {
    setSelected((prev) => (prev >= filtered.length ? 0 : prev))
  }, [filtered.length])

  useEffect(() => {
    listRef.current?.querySelector('.prow.is-sel')?.scrollIntoView({ block: 'nearest' })
  }, [selected, filtered])

  // Esc 关面板：只在打开时挂，避免与其它浮层抢按键
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      close()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [open, close])

  if (!open) return null

  const runItem = (item: PaletteItem) => {
    close()
    item.run()
  }

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (filtered.length === 0) return
      const delta = event.key === 'ArrowDown' ? 1 : -1
      setSelected((prev) => (prev + delta + filtered.length) % filtered.length)
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      const item = filtered[selected]
      if (item) runItem(item)
    }
  }

  const groups = GROUP_ORDER.filter((g) => filtered.some((item) => item.group === g))

  return (
    <div
      className="overlay"
      onMouseDown={(event) => { if (event.target === event.currentTarget) close() }}
    >
      <div className="palette" role="dialog" aria-modal="true" aria-label="命令面板" onKeyDown={onKeyDown}>
        <div className="palette__field">
          <Search size={16} strokeWidth={1.6} className="icon" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(event) => { setQuery(event.target.value); setSelected(0) }}
            placeholder="搜客户、会话，或输入动作"
            autoComplete="off"
            spellCheck={false}
          />
          <kbd>Esc</kbd>
        </div>
        <div className="palette__list" ref={listRef} role="listbox" aria-label="结果">
          {groups.map((group) => (
            <div key={group}>
              <div className="palette__grp">{group}</div>
              {filtered.map((item, index) => item.group === group ? (
                <button
                  key={item.key}
                  type="button"
                  role="option"
                  aria-selected={index === selected}
                  className={`prow ${index === selected ? 'is-sel' : ''}`}
                  onMouseEnter={() => setSelected(index)}
                  onClick={() => runItem(item)}
                >
                  {item.icon}
                  <span>{item.label}</span>
                  {item.hint ? <span className="prow__hint">{item.hint}</span> : null}
                </button>
              ) : null)}
            </div>
          ))}
          {filtered.length === 0 ? (
            <div className="palette__empty">没有匹配的客户、会话、页面或动作</div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

export default CommandPalette
