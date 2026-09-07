import { useState, useEffect, useRef } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { Home, MessageSquare, BarChart3, TrendingDown, Filter, FileText, Settings, Download, Aperture, UserCircle, Lock, LockOpen, ChevronUp, ChevronDown, FolderClosed, Footprints, Users, ArchiveRestore, Sparkles, BookOpen, Clock, Briefcase, ClipboardCheck, ClipboardList, MessageCircleQuestion, Package, Inbox, Target, type LucideIcon } from 'lucide-react'
import { useAppStore } from '../stores/appStore'
import { useKnowledgeAskStore } from '../stores/knowledgeAskStore'
import * as configService from '../services/config'
import { onExportSessionStatus, requestExportSessionStatus } from '../services/exportBridge'

import './Sidebar.scss'

interface SidebarUserProfile {
  wxid: string
  displayName: string
  alias?: string
  avatarUrl?: string
}

// ─── 导航收口：7 个一级模块（今日行动 / 聊天 / CRM / 跟单 / AI·知识 / 报表 / 系统）───
// 多子项模块渲染为可展开分组；collapsed 时全部子项图标平铺，保持原行为
// 导航项两类：路由项（path，NavLink 跳转）与动作项（action，点击执行动作不跳路由）；
// 动作项不参与 active 高亮（active 样式只属于真实路由项）
type NavItemDef =
  | { label: string; path: string; icon: LucideIcon }
  | { label: string; icon: LucideIcon; action: 'openKnowledgeAsk' }
interface NavGroupDef { key: string; label: string; items: NavItemDef[] }

const NAV_GROUPS: NavGroupDef[] = [
  { key: 'home', label: '今日行动', items: [{ label: '今日行动', path: '/home', icon: Home }] },
  { key: 'chat', label: '聊天', items: [{ label: '聊天', path: '/chat', icon: MessageSquare }] },
  { key: 'crm', label: 'CRM', items: [
    { label: '线索', path: '/leads', icon: Inbox },
    { label: '客户', path: '/customers', icon: Users },
    { label: '商机', path: '/opportunities', icon: Target },
    { label: '漏斗', path: '/sales-funnel', icon: TrendingDown },
    { label: '合同', path: '/crm', icon: Briefcase }
  ] },
  { key: 'review', label: '跟单', items: [{ label: '跟单中心', path: '/crm-review', icon: ClipboardCheck }] },
  { key: 'ai', label: 'AI / 知识', items: [
    { label: '问一问', icon: MessageCircleQuestion, action: 'openKnowledgeAsk' },
    { label: '重要提醒', path: '/insight-inbox', icon: Sparkles },
    { label: '知识库', path: '/knowledge-base', icon: BookOpen },
    { label: '评测标注', path: '/eval-annotate', icon: ClipboardList }
  ] },
  { key: 'report', label: '报表', items: [
    { label: '复盘', path: '/sales-report', icon: BarChart3 },
    { label: '行动漏斗', path: '/action-funnel', icon: Filter }
  ] },
  { key: 'system', label: '系统', items: [
    { label: '产品库', path: '/crm-product', icon: Package },
    { label: '通讯录', path: '/contacts', icon: UserCircle }
  ] }
]

const SIDEBAR_USER_PROFILE_CACHE_KEY = 'sidebar_user_profile_cache_v1'
const ACCOUNT_PROFILES_CACHE_KEY = 'account_profiles_cache_v1'
const DEFAULT_DISPLAY_NAME = '微信用户'
const DEFAULT_SUBTITLE = '微信账号'

interface SidebarUserProfileCache extends SidebarUserProfile {
  updatedAt: number
}

interface AccountProfilesCache {
  [wxid: string]: {
    displayName: string
    avatarUrl?: string
    alias?: string
    updatedAt: number
  }
}

const readSidebarUserProfileCache = (): SidebarUserProfile | null => {
  try {
    const raw = window.localStorage.getItem(SIDEBAR_USER_PROFILE_CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as SidebarUserProfileCache
    if (!parsed || typeof parsed !== 'object') return null
    if (!parsed.wxid) return null
    return {
      wxid: parsed.wxid,
      displayName: typeof parsed.displayName === 'string' ? parsed.displayName : '',
      alias: parsed.alias,
      avatarUrl: parsed.avatarUrl
    }
  } catch {
    return null
  }
}

const writeSidebarUserProfileCache = (profile: SidebarUserProfile): void => {
  if (!profile.wxid) return
  try {
    const payload: SidebarUserProfileCache = {
      ...profile,
      updatedAt: Date.now()
    }
    window.localStorage.setItem(SIDEBAR_USER_PROFILE_CACHE_KEY, JSON.stringify(payload))

    // 同时写入账号缓存池
    const accountsCache = readAccountProfilesCache()
    accountsCache[profile.wxid] = {
      displayName: profile.displayName,
      avatarUrl: profile.avatarUrl,
      alias: profile.alias,
      updatedAt: Date.now()
    }
    window.localStorage.setItem(ACCOUNT_PROFILES_CACHE_KEY, JSON.stringify(accountsCache))
  } catch {
    // 忽略本地缓存失败，不影响主流程
  }
}

const readAccountProfilesCache = (): AccountProfilesCache => {
  try {
    const raw = window.localStorage.getItem(ACCOUNT_PROFILES_CACHE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return typeof parsed === 'object' && parsed ? parsed : {}
  } catch {
    return {}
  }
}

const normalizeAccountId = (value?: string | null): string => {
  const trimmed = String(value || '').trim()
  if (!trimmed) return ''
  if (trimmed.toLowerCase().startsWith('wxid_')) {
    const match = trimmed.match(/^(wxid_[^_]+)/i)
    return match?.[1] || trimmed
  }
  const suffixMatch = trimmed.match(/^(.+)_([a-zA-Z0-9]{4})$/)
  return suffixMatch ? suffixMatch[1] : trimmed
}

interface SidebarProps {
  collapsed: boolean
}

function Sidebar({ collapsed }: SidebarProps) {
  const location = useLocation()
  const navigate = useNavigate()
  const [authEnabled, setAuthEnabled] = useState(false)
  const [activeExportTaskCount, setActiveExportTaskCount] = useState(0)
  const [userProfile, setUserProfile] = useState<SidebarUserProfile>({
    wxid: '',
    displayName: DEFAULT_DISPLAY_NAME
  })
  const [isAccountMenuOpen, setIsAccountMenuOpen] = useState(false)
  const accountCardWrapRef = useRef<HTMLDivElement | null>(null)
  const setLocked = useAppStore(state => state.setLocked)

  useEffect(() => {
    window.electronAPI.auth.verifyEnabled().then(setAuthEnabled)
  }, [])

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (!isAccountMenuOpen) return
      const target = event.target as Node | null
      if (accountCardWrapRef.current && target && !accountCardWrapRef.current.contains(target)) {
        setIsAccountMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isAccountMenuOpen])

  useEffect(() => {
    const unsubscribe = onExportSessionStatus((payload) => {
      const countFromPayload = typeof payload?.activeTaskCount === 'number'
        ? payload.activeTaskCount
        : Array.isArray(payload?.inProgressSessionIds)
          ? payload.inProgressSessionIds.length
          : 0
      const normalized = Math.max(0, Math.floor(countFromPayload))
      setActiveExportTaskCount(normalized)
    })

    requestExportSessionStatus()
    const timer = window.setTimeout(() => requestExportSessionStatus(), 120)

    return () => {
      unsubscribe()
      window.clearTimeout(timer)
    }
  }, [])

  useEffect(() => {
    let disposed = false
    let loadSeq = 0

    const loadCurrentUser = async () => {
      const seq = ++loadSeq
      const patchUserProfile = (patch: Partial<SidebarUserProfile>) => {
        if (disposed || seq !== loadSeq) return
        setUserProfile(prev => {
          const next: SidebarUserProfile = {
            ...prev,
            ...patch
          }
          if (typeof next.displayName !== 'string' || next.displayName.length === 0) {
            next.displayName = DEFAULT_DISPLAY_NAME
          }
          writeSidebarUserProfileCache(next)
          return next
        })
      }

      try {
        const wxid = await configService.getMyWxid()
        if (disposed || seq !== loadSeq) return
        const resolvedWxidRaw = String(wxid || '').trim()
        const cleanedWxid = normalizeAccountId(resolvedWxidRaw)
        const resolvedWxid = cleanedWxid || resolvedWxidRaw

        if (!resolvedWxidRaw && !resolvedWxid) {
          window.localStorage.removeItem(SIDEBAR_USER_PROFILE_CACHE_KEY)
          patchUserProfile({
            wxid: '',
            displayName: DEFAULT_DISPLAY_NAME,
            alias: undefined,
            avatarUrl: undefined
          })
          return
        }

        setUserProfile((prev) => {
          if (prev.wxid === resolvedWxid) return prev
          const seeded: SidebarUserProfile = {
            wxid: resolvedWxid,
            displayName: DEFAULT_DISPLAY_NAME,
            alias: undefined,
            avatarUrl: undefined
          }
          writeSidebarUserProfileCache(seeded)
          return seeded
        })

        const wxidCandidates = new Set<string>([
          resolvedWxidRaw.toLowerCase(),
          resolvedWxid.trim().toLowerCase(),
          cleanedWxid.trim().toLowerCase()
        ].filter(Boolean))

        const normalizeName = (value?: string | null): string | undefined => {
          if (typeof value !== 'string') return undefined
          if (value.length === 0) return undefined
          const lowered = value.trim().toLowerCase()
          if (lowered === 'self') return undefined
          if (lowered.startsWith('wxid_')) return undefined
          if (wxidCandidates.has(lowered)) return undefined
          return value
        }

        const pickFirstValidName = (...candidates: Array<string | null | undefined>): string | undefined => {
          for (const candidate of candidates) {
            const normalized = normalizeName(candidate)
            if (normalized) return normalized
          }
          return undefined
        }

        // 并行获取名称和头像
        const [contactResult, avatarResult] = await Promise.allSettled([
          (async () => {
            const candidates = Array.from(new Set([resolvedWxidRaw, resolvedWxid, cleanedWxid].filter(Boolean)))
            for (const candidate of candidates) {
              const contact = await window.electronAPI.chat.getContact(candidate)
              if (contact?.remark || contact?.nickName || contact?.alias) {
                return contact
              }
            }
            return null
          })(),
          window.electronAPI.chat.getMyAvatarUrl()
        ])
        if (disposed || seq !== loadSeq) return

        const myContact = contactResult.status === 'fulfilled' ? contactResult.value : null
        const displayName = pickFirstValidName(
          myContact?.remark,
          myContact?.nickName,
          myContact?.alias
        ) || DEFAULT_DISPLAY_NAME
        const alias = normalizeName(myContact?.alias)

        patchUserProfile({
          wxid: resolvedWxid,
          displayName,
          alias,
          avatarUrl: avatarResult.status === 'fulfilled' && avatarResult.value.success
            ? avatarResult.value.avatarUrl
            : undefined
        })
      } catch (error) {
        console.error('加载侧边栏用户信息失败:', error)
      }
    }

    const cachedProfile = readSidebarUserProfileCache()
    if (cachedProfile) {
      setUserProfile(cachedProfile)
    }

    void loadCurrentUser()
    const onWxidChanged = () => { void loadCurrentUser() }
    const onWindowFocus = () => { void loadCurrentUser() }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void loadCurrentUser()
      }
    }
    window.addEventListener('wxid-changed', onWxidChanged as EventListener)
    window.addEventListener('focus', onWindowFocus)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      disposed = true
      loadSeq += 1
      window.removeEventListener('wxid-changed', onWxidChanged as EventListener)
      window.removeEventListener('focus', onWindowFocus)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [])

  const getAvatarLetter = (name: string): string => {
    if (!name) return '微'
    const visible = name.trim()
    return (visible && [...visible][0]) || '微'
  }

  const openSettingsFromAccountMenu = () => {
    setIsAccountMenuOpen(false)
    navigate('/settings', {
      state: {
        backgroundLocation: location
      }
    })
  }

  const openAccountManagement = () => {
    setIsAccountMenuOpen(false)
    navigate('/account-management')
  }

  const isActive = (path: string) => {
    return location.pathname === path || location.pathname.startsWith(`${path}/`)
  }
  // 分组默认展开：CRM 与 AI/知识（核心工作区），系统默认收起
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({ crm: true, ai: true })
  const openKnowledgeAsk = useKnowledgeAskStore((s) => s.openKnowledgeAsk)
  // 动作项（无 path）不参与分组 active 判定，避免伪造路由高亮
  const groupActive = (items: NavItemDef[]) => items.some((i) => 'path' in i && isActive(i.path))
  const renderNavItem = (item: NavItemDef, child = false) => {
    if ('action' in item) {
      // 动作项：button 原生键盘可操作；不跳路由、不改 openGroups、无 active 样式
      return (
        <button
          key={item.label}
          type="button"
          className={`nav-item ${child ? 'nav-item--child' : ''}`}
          onClick={() => { if (item.action === 'openKnowledgeAsk') openKnowledgeAsk() }}
          title={collapsed ? item.label : undefined}
          aria-label={item.label}
        >
          <span className="nav-icon"><item.icon size={20} /></span>
          <span className="nav-label">{item.label}</span>
        </button>
      )
    }
    return (
      <NavLink
        key={item.path}
        to={item.path}
        className={`nav-item ${child ? 'nav-item--child' : ''} ${isActive(item.path) ? 'active' : ''}`}
        title={collapsed ? item.label : undefined}
      >
        <span className="nav-icon"><item.icon size={20} /></span>
        <span className="nav-label">{item.label}</span>
      </NavLink>
    )
  }
  const exportTaskBadge = activeExportTaskCount > 99 ? '99+' : `${activeExportTaskCount}`
  const lockActionLabel = authEnabled ? '锁定应用' : '开启应用锁'

  return (
    <>
      <aside className={`sidebar ${collapsed ? 'collapsed' : ''}`}>
        <nav className="nav-menu">
          {collapsed
            ? NAV_GROUPS.flatMap((g) => g.items).map((i) => renderNavItem(i))
            : NAV_GROUPS.map((g) => {
                if (g.items.length === 1) return renderNavItem(g.items[0])
                const open = openGroups[g.key] !== false
                return (
                  <div key={g.key} className="nav-group">
                    <button
                      type="button"
                      className={`nav-group-head ${groupActive(g.items) ? 'active' : ''}`}
                      onClick={() => setOpenGroups((s) => ({ ...s, [g.key]: !(s[g.key] !== false) }))}
                      aria-expanded={open}
                    >
                      <span>{g.label}</span>
                      <ChevronDown size={13} className={`nav-group-head__caret ${open ? 'open' : ''}`} />
                    </button>
                    {open && (
                      <div className="nav-group__items">
                        {g.items.map((i) => renderNavItem(i, true))}
                      </div>
                    )}
                  </div>
                )
              })}

          {/* 朋友圈 - PRD v2 隐藏 */}
          {false && <NavLink
            to="/sns"
            className={`nav-item ${isActive('/sns') ? 'active' : ''}`}
            title={collapsed ? '朋友圈' : undefined}
          >
            <span className="nav-icon"><Aperture size={20} /></span>
            <span className="nav-label">朋友圈</span>
          </NavLink>}

          {/* 资源浏览 - PRD v2 隐藏 */}
          {false && <NavLink
            to="/resources"
            className={`nav-item ${isActive('/resources') ? 'active' : ''}`}
            title={collapsed ? '资源浏览' : undefined}
          >
            <span className="nav-icon"><FolderClosed size={20} /></span>
            <span className="nav-label">资源浏览</span>
          </NavLink>}

          {/* 聊天分析 - PRD v2 隐藏 */}
          {false && <NavLink
            to="/analytics"
            className={`nav-item ${isActive('/analytics') ? 'active' : ''}`}
            title={collapsed ? '聊天分析' : undefined}
          >
            <span className="nav-icon"><BarChart3 size={20} /></span>
            <span className="nav-label">聊天分析</span>
          </NavLink>}

          {/* 年度报告 - PRD v2 隐藏 */}
          {false && <NavLink
            to="/annual-report"
            className={`nav-item ${isActive('/annual-report') ? 'active' : ''}`}
            title={collapsed ? '年度报告' : undefined}
          >
            <span className="nav-icon"><FileText size={20} /></span>
            <span className="nav-label">年度报告</span>
          </NavLink>}

          {/* 我的足迹 - PRD v2 隐藏 */}
          {false && <NavLink
            to="/footprint"
            className={`nav-item ${isActive('/footprint') ? 'active' : ''}`}
            title={collapsed ? '我的足迹' : undefined}
          >
            <span className="nav-icon"><Footprints size={20} /></span>
            <span className="nav-label">我的足迹</span>
          </NavLink>}

          {/* 导出 - PRD v2 隐藏 */}
          {false && <NavLink
            to="/export"
            className={`nav-item ${isActive('/export') ? 'active' : ''}`}
            title={collapsed ? '导出' : undefined}
          >
            <span className="nav-icon nav-icon-with-badge">
              <Download size={20} />
              {collapsed && activeExportTaskCount > 0 && (
                <span className="nav-badge icon-badge">{exportTaskBadge}</span>
              )}
            </span>
            <span className="nav-label">导出</span>
            {!collapsed && activeExportTaskCount > 0 && (
              <span className="nav-badge">{exportTaskBadge}</span>
            )}
          </NavLink>}



          {/* 数据库备份 - PRD v2 隐藏 */}
          {false && <NavLink
            to="/backup"
            className={`nav-item ${isActive('/backup') ? 'active' : ''}`}
            title={collapsed ? '数据库备份' : undefined}
          >
            <span className="nav-icon"><ArchiveRestore size={20} /></span>
            <span className="nav-label">数据库备份</span>
          </NavLink>}


        </nav>

        <div className="sidebar-footer">
          <button
            className="nav-item sidebar-lock-action"
            onClick={() => {
              if (authEnabled) {
                setLocked(true)
                return
              }
              navigate('/settings', {
                state: {
                  initialTab: 'security',
                  backgroundLocation: location
                }
              })
            }}
            title={collapsed ? lockActionLabel : undefined}
            aria-label={lockActionLabel}
          >
            <span className="nav-icon">{authEnabled ? <Lock size={20} /> : <LockOpen size={20} />}</span>
            <span className="nav-label">{lockActionLabel}</span>
          </button>

          <div className="sidebar-user-card-wrap" ref={accountCardWrapRef}>
            <div className={`sidebar-user-menu ${isAccountMenuOpen ? 'open' : ''}`} role="menu" aria-label="账号菜单">
              <button
                className="sidebar-user-menu-item"
                onClick={openAccountManagement}
                type="button"
                role="menuitem"
              >
                <Users size={14} />
                <span>账号管理</span>
              </button>
              <button
                className="sidebar-user-menu-item"
                onClick={openSettingsFromAccountMenu}
                type="button"
                role="menuitem"
              >
                <Settings size={14} />
                <span>设置</span>
              </button>
            </div>
            <div
              className={`sidebar-user-card ${isAccountMenuOpen ? 'menu-open' : ''}`}
              title={collapsed ? `${userProfile.displayName}${(userProfile.alias) ? `\n${userProfile.alias}` : ''}` : undefined}
              onClick={() => setIsAccountMenuOpen(prev => !prev)}
              role="button"
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  setIsAccountMenuOpen(prev => !prev)
                }
              }}
            >
              <div className="user-avatar">
                {userProfile.avatarUrl ? <img src={userProfile.avatarUrl} alt="" /> : <span>{getAvatarLetter(userProfile.displayName)}</span>}
              </div>
              <div className="user-meta">
                <div className="user-name">{userProfile.displayName || DEFAULT_DISPLAY_NAME}</div>
                <div className="user-wxid">{userProfile.alias || DEFAULT_SUBTITLE}</div>
              </div>
              {!collapsed && (
                <span className={`user-menu-caret ${isAccountMenuOpen ? 'open' : ''}`}>
                  <ChevronUp size={14} />
                </span>
              )}
            </div>
          </div>
        </div>
      </aside>
    </>
  )
}

export default Sidebar
