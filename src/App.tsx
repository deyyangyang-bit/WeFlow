import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { Routes, Route, Navigate, useNavigate, useLocation, type Location } from 'react-router-dom'
import TitleBar from './components/TitleBar'
import Sidebar from './components/Sidebar'
import RouteGuard from './components/RouteGuard'

import { useAppStore } from './stores/appStore'
import { themes, useThemeStore, type ThemeId, type ThemeMode } from './stores/themeStore'
import HermesPanel from './components/hermes/HermesPanel'
import * as configService from './services/config'
import './App.scss'

import UpdateDialog from './components/UpdateDialog'
import UpdateProgressCapsule from './components/UpdateProgressCapsule'
import LockScreen from './components/LockScreen'
import IdentityOnboardingDialog from './components/IdentityOnboardingDialog'
import { GlobalSessionMonitor } from './components/GlobalSessionMonitor'
import WindowCloseDialog from './components/WindowCloseDialog'
import CommandPalette from './components/CommandPalette'
import GlobalToast from './components/GlobalToast'
import { useGlobalShortcuts } from './utils/useGlobalShortcuts'
import { resolveAutomationScopeKey } from './pages/Export/hooks/useAutomation'

// 全部页面懒加载：主窗口首屏只解析 App 壳；
// 常驻的通知窗口等独立窗口路由也因此只加载各自的小 chunk，
// 显著降低每个渲染进程的 JS 堆占用与启动时间
const WelcomePage = lazy(() => import('./pages/WelcomePage'))
const ChatPage = lazy(() => import('./pages/ChatPage'))
const AnalyticsWelcomePage = lazy(() => import('./pages/AnalyticsWelcomePage'))
const ChatAnalyticsHubPage = lazy(() => import('./pages/ChatAnalyticsHubPage'))
const AgreementPage = lazy(() => import('./pages/AgreementPage'))
// 设置页导航壳（常用/高级二级导航 + 原样挂 SettingsPage；设计稿 docs/UI设计稿-设置页简化.html）
const SettingsNavShell = lazy(() => import('./pages/SettingsNavShell'))
const MyFootprintPage = lazy(() => import('./pages/MyFootprintPage'))
const VideoWindow = lazy(() => import('./pages/VideoWindow'))
const ImageWindow = lazy(() => import('./pages/ImageWindow'))
const SnsPage = lazy(() => import('./pages/SnsPage'))
const ContactsPage = lazy(() => import('./pages/ContactsPage'))
const ResourcesPage = lazy(() => import('./pages/ResourcesPage'))
const ChatHistoryPage = lazy(() => import('./pages/ChatHistoryPage'))
const NotificationWindow = lazy(() => import('./pages/NotificationWindow'))
const AccountManagementPage = lazy(() => import('./pages/AccountManagementPage'))
const BackupPage = lazy(() => import('./pages/BackupPage'))
const InsightInboxPage = lazy(() => import('./pages/InsightInboxPage'))
const KnowledgeBasePage = lazy(() => import('./pages/KnowledgeBasePage'))
const EvalAnnotatePage = lazy(() => import('./pages/EvalAnnotatePage'))
const SalesReportPage = lazy(() => import('./pages/SalesReportPage'))
const ActionFunnelPage = lazy(() => import('./pages/ActionFunnelPage'))
const OpportunityPage = lazy(() => import('./pages/OpportunityPage'))
const TodayActionPage = lazy(() => import('./pages/TodayActionPage'))
const CustomerWorkspacePage = lazy(() => import('./pages/CustomerWorkspacePage'))
const CrmWorkbenchPage = lazy(() => import('./pages/CrmWorkbenchPage'))
const CrmReviewPage = lazy(() => import('./pages/CrmReviewPage'))
const CrmProductPage = lazy(() => import('./pages/CrmProductPage'))
const CrmLeadPage = lazy(() => import('./pages/CrmLeadPage'))
const RoleViewPage = lazy(() => import('./pages/RoleViewPage'))
const AnalyticsPage = lazy(() => import('./pages/AnalyticsPage'))
const GroupAnalyticsPage = lazy(() => import('./pages/GroupAnalyticsPage'))
const AnnualReportPage = lazy(() => import('./pages/AnnualReportPage'))
const AnnualReportWindow = lazy(() => import('./pages/AnnualReportWindow'))
const DualReportPage = lazy(() => import('./pages/DualReportPage'))
const DualReportWindow = lazy(() => import('./pages/DualReportWindow'))
const ExportPage = lazy(() => import('./pages/Export/ExportPage'))

function RouteStateRedirect({ to }: { to: string }) {
  const location = useLocation()

  return <Navigate to={to} replace state={location.state} />
}

function App() {
  const navigate = useNavigate()
  const location = useLocation()
  const settingsBackgroundRef = useRef<Location>({
    pathname: '/home',
    search: '',
    hash: '',
    state: null,
    key: 'settings-fallback'
  } as Location)

  const {
    setDbConnected,
    updateInfo,
    setUpdateInfo,
    isDownloading,
    setIsDownloading,
    downloadProgress,
    setDownloadProgress,
    showUpdateDialog,
    setShowUpdateDialog,
    setUpdateError,
    isLocked,
    setLocked
  } = useAppStore()

  const { currentTheme, themeMode, setTheme, setThemeMode } = useThemeStore()
  // Hermes 只读智能体：全屏三栏路由页（/hermes，概念稿屏 8 形态）。三入口经
  // hermesStore.openHermes(context) 注入上下文后 navigate('/hermes')；HermesPanel 组件
  // 内部自消费 store（本文件不取值）。任务真源在主进程内存：离开路由不删任务，
  // 回到 /hermes 按上下文锚点恢复视图并重订阅进度。
  const isAgreementWindow = location.pathname === '/agreement-window'
  const isOnboardingWindow = location.pathname === '/onboarding-window'
  const isVideoPlayerWindow = location.pathname === '/video-player-window'
  const isChatHistoryWindow = location.pathname.startsWith('/chat-history/') || location.pathname.startsWith('/chat-history-inline/')
  const isStandaloneChatWindow = location.pathname === '/chat-window'
  const isNotificationWindow = location.pathname === '/notification-window'
  const isAnnualReportWindow = location.pathname === '/annual-report/view'
  const isDualReportWindow = location.pathname === '/dual-report/view'
  const isSettingsRoute = location.pathname === '/settings'
  const settingsRouteState = location.state as { backgroundLocation?: Location; initialTab?: unknown } | null
  const routeLocation = isSettingsRoute
    ? settingsRouteState?.backgroundLocation ?? settingsBackgroundRef.current
    : location
  const isExportRoute = routeLocation.pathname === '/export'
  // Export 模块按需挂载：首次进入导出页，或存在启用的自动化任务（调度器在导出页内）时才挂载
  const [exportMounted, setExportMounted] = useState(false)
  const [themeHydrated, setThemeHydrated] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [showCloseDialog, setShowCloseDialog] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [canMinimizeToTray, setCanMinimizeToTray] = useState(false)
  const [closeRestoreMethod, setCloseRestoreMethod] = useState<'tray' | 'dock'>('tray')

  // 锁定状态
  // const [isLocked, setIsLocked] = useState(false) // Moved to store
  const [lockAvatar, setLockAvatar] = useState<string | undefined>(
    localStorage.getItem('app_lock_avatar') || undefined
  )
  const [lockUseHello, setLockUseHello] = useState(false)
  // 应用锁检查是否已完成（身份引导必须等锁检查结束，且仅在未锁定态出现）
  const [lockChecked, setLockChecked] = useState(false)
  // 本地身份档案首次引导（PRD §1.2a）：未建档且未跳过时弹一次，不挡应用锁、不卡启动流程
  const [showIdentityOnboarding, setShowIdentityOnboarding] = useState(false)
  const identityCheckedRef = useRef(false)

  useEffect(() => {
    if (location.pathname !== '/settings') {
      settingsBackgroundRef.current = location
    }
  }, [location])

  const isStandaloneWindow =
    isAgreementWindow || isOnboardingWindow || isVideoPlayerWindow || isChatHistoryWindow ||
    isStandaloneChatWindow || isNotificationWindow || isAnnualReportWindow || isDualReportWindow ||
    location.pathname === '/image-viewer-window'

  // 全局快捷键（⌘K 命令面板 / ⌘1-3 切前三屏）：只在主窗口、未锁定时挂
  const togglePalette = useCallback(() => setPaletteOpen((prev) => !prev), [])
  useGlobalShortcuts({
    enabled: !isStandaloneWindow && !isLocked,
    paletteOpen,
    onTogglePalette: togglePalette
  })

  // 锁屏或切到独立窗口路由时收掉面板，避免浮层挂在锁屏之上
  useEffect(() => {
    if (isLocked || isStandaloneWindow) setPaletteOpen(false)
  }, [isLocked, isStandaloneWindow])

  useEffect(() => {
    if (isExportRoute && !exportMounted) setExportMounted(true)
  }, [isExportRoute, exportMounted])

  // 存在启用的自动化导出任务时，即使未访问导出页也需挂载（30s 调度器运行在导出页内）
  useEffect(() => {
    if (exportMounted || isStandaloneWindow) return
    let cancelled = false
    ;(async () => {
      try {
        const scopeKey = await resolveAutomationScopeKey()
        const item = await configService.getExportAutomationTasks(scopeKey)
        if (!cancelled && item?.tasks?.some(task => task.enabled)) setExportMounted(true)
      } catch {
        // 读取失败视为无自动化任务
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exportMounted, isStandaloneWindow])

  useEffect(() => {
    const removeCloseConfirmListener = window.electronAPI.window.onCloseConfirmRequested((payload) => {
      setCanMinimizeToTray(Boolean(payload.canMinimizeToTray))
      setCloseRestoreMethod(payload.restoreMethod === 'dock' ? 'dock' : 'tray')
      setShowCloseDialog(true)
    })

    return () => removeCloseConfirmListener()
  }, [])

  useEffect(() => {
    const root = document.documentElement
    const body = document.body
    const appRoot = document.getElementById('app')

    if (isOnboardingWindow || isNotificationWindow || isAnnualReportWindow || isDualReportWindow) {
      root.style.background = 'transparent'
      body.style.background = 'transparent'
      body.style.overflow = 'hidden'
      if (appRoot) {
        appRoot.style.background = 'transparent'
        appRoot.style.overflow = 'hidden'
      }
    } else {
      root.style.background = 'var(--bg-primary)'
      body.style.background = 'var(--bg-primary)'
      body.style.overflow = ''
      if (appRoot) {
        appRoot.style.background = ''
        appRoot.style.overflow = ''
      }
    }
  }, [isOnboardingWindow, isNotificationWindow, isAnnualReportWindow, isDualReportWindow])

  // 应用主题 (accent color + light/dark mode)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const applyMode = (mode: ThemeMode, systemDark?: boolean) => {
      const effectiveMode = mode === 'system' ? (systemDark ?? mq.matches ? 'dark' : 'light') : mode
      document.documentElement.setAttribute('data-theme', currentTheme)
      document.documentElement.setAttribute('data-mode', effectiveMode)
    }

    applyMode(themeMode)

    // 监听系统主题变化
    const handler = (e: MediaQueryListEvent) => {
      if (useThemeStore.getState().themeMode === 'system') {
        applyMode('system', e.matches)
      }
    }
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [currentTheme, themeMode, isOnboardingWindow, isNotificationWindow, isAnnualReportWindow, isDualReportWindow])

  // 读取已保存的主题设置
  useEffect(() => {
    const loadTheme = async () => {
      try {
        const [savedThemeId, savedThemeMode] = await Promise.all([
          configService.getThemeId(),
          configService.getTheme()
        ])
        if (savedThemeId && themes.some((theme) => theme.id === savedThemeId)) {
          setTheme(savedThemeId as ThemeId)
        }
        if (savedThemeMode === 'light' || savedThemeMode === 'dark' || savedThemeMode === 'system') {
          setThemeMode(savedThemeMode)
        }
      } catch (e) {
        console.error('读取主题配置失败:', e)
      } finally {
        setThemeHydrated(true)
      }
    }
    loadTheme()
  }, [setTheme, setThemeMode])

  // 保存主题设置
  useEffect(() => {
    if (!themeHydrated) return
    const saveTheme = async () => {
      try {
        await Promise.all([
          configService.setThemeId(currentTheme),
          configService.setTheme(themeMode)
        ])
      } catch (e) {
        console.error('保存主题配置失败:', e)
      }
    }
    saveTheme()
  }, [currentTheme, themeMode, themeHydrated])

  // 监听启动时的更新通知
  useEffect(() => {
    if (isNotificationWindow) return // Skip updates in notification window

    const removeUpdateListener = window.electronAPI?.app?.onUpdateAvailable?.((info: any) => {
      // 发现新版本时保存更新信息，锁定状态下不弹窗，解锁后再显示
      if (info) {
        window.electronAPI.app.getVersion().then((currentVersion: string) => {
          const isMandatory = !!(info.minimumVersion && currentVersion &&
            currentVersion.localeCompare(info.minimumVersion, undefined, { numeric: true, sensitivity: 'base' }) <= 0)
          setUpdateInfo({ ...info, hasUpdate: true, isMandatory })
          if (!useAppStore.getState().isLocked) {
            setShowUpdateDialog(true)
          }
        })
      }
    })
    const removeProgressListener = window.electronAPI?.app?.onDownloadProgress?.((progress: any) => {
      setDownloadProgress(progress)
    })
    return () => {
      removeUpdateListener?.()
      removeProgressListener?.()
    }
  }, [setUpdateInfo, setDownloadProgress, setShowUpdateDialog, isNotificationWindow])

  // 监听通知点击导航事件
  useEffect(() => {
    if (isNotificationWindow) return

    const removeListener = window.electronAPI?.notification?.onNavigateToSession?.((sessionId: string) => {
      if (!sessionId) return
      // 导航到聊天页面，通过URL参数让ChatPage接收sessionId
      navigate(`/chat?sessionId=${encodeURIComponent(sessionId)}`, { replace: true })
    })

    return () => {
      removeListener?.()
    }
  }, [navigate, isNotificationWindow])

  useEffect(() => {
    if (isNotificationWindow) return

    const removeListener = window.electronAPI?.notification?.onNavigateToRoute?.((route: string) => {
      if (!route || !route.startsWith('/')) return
      navigate(route, { replace: true })
    })

    return () => {
      removeListener?.()
    }
  }, [navigate, isNotificationWindow])

  // 解锁后显示暂存的更新弹窗
  useEffect(() => {
    if (!isLocked && updateInfo?.hasUpdate && !showUpdateDialog && !isDownloading) {
      setShowUpdateDialog(true)
    }
  }, [isLocked])

  const handleUpdateNow = async () => {
    setShowUpdateDialog(false)
    setIsDownloading(true)
    setDownloadProgress({ percent: 0 })
    try {
      await window.electronAPI.app.downloadAndInstall()
    } catch (e: any) {
      console.error('更新失败:', e)
      setIsDownloading(false)
      // Extract clean error message if possible
      const errorMsg = e.message || String(e)
      setUpdateError(errorMsg.includes('暂时禁用') ? '自动更新已暂时禁用' : errorMsg)
    }
  }

  const handleIgnoreUpdate = async () => {
    if (!updateInfo || !updateInfo.version) return

    try {
      await window.electronAPI.app.ignoreUpdate(updateInfo.version)
      setShowUpdateDialog(false)
      setUpdateInfo(null)
    } catch (e: any) {
      console.error('忽略更新失败:', e)
    }
  }

  const dismissUpdate = () => {
    setUpdateInfo(null)
  }

  const handleWindowCloseAction = async (
    action: 'tray' | 'quit' | 'cancel',
    rememberChoice = false
  ) => {
    setShowCloseDialog(false)
    if (rememberChoice && action !== 'cancel') {
      try {
        await configService.setWindowCloseBehavior(action)
      } catch (error) {
        console.error('保存关闭偏好失败:', error)
      }
    }

    try {
      await window.electronAPI.window.respondCloseConfirm(action)
    } catch (error) {
      console.error('处理关闭确认失败:', error)
    }
  }

  // 启动时自动检查配置并连接数据库
  useEffect(() => {
    if (isAgreementWindow || isOnboardingWindow) return

    const autoConnect = async () => {
      try {
        // H2：自动连接前置判断由主进程执行——wxidConfigs 中该账号的已保存密钥由主进程
        // 应用到全局密钥位，密钥值不返回渲染层；渲染层只拿非秘密状态决定是否连接。
        const savedDbPath = await configService.getDbPath()
        const status = await configService.applySavedKeyForAutoConnect()
        const decryptKeyReady = status.hasKey
        const wxid = status.myWxid
        const onboardingDone = status.onboardingDone

        // 如果配置完整，自动测试连接
        if (status.hasDbPath && decryptKeyReady && wxid) {
          if (!onboardingDone) {
            await configService.setOnboardingDone(true)
          }

          const result = await window.electronAPI.chat.connect()

          if (result.success) {

            setDbConnected(true, savedDbPath || undefined)
            // 如果当前在欢迎页，跳转到首页
            if (window.location.hash === '#/' || window.location.hash === '') {
              navigate('/home')
            }
          } else {

            // 如果错误信息包含 VC++ 或数据服务相关内容，不清除配置，只提示用户
            // 其他错误可能需要重新配置
            const errorMsg = result.error || ''
            if (errorMsg.includes('Visual C++') ||
              errorMsg.includes('DLL') ||
              errorMsg.includes('Worker') ||
              errorMsg.includes('126') ||
              errorMsg.includes('模块')) {
              console.warn('检测到可能的运行时依赖问题:', errorMsg)
              // 不清除配置，让用户安装 VC++ 后重试
            }
          }
        }
      } catch (e) {
        console.error('自动连接出错:', e)
        // 捕获异常但不清除配置，防止循环重新引导
      }
    }

    autoConnect()
  }, [isAgreementWindow, isOnboardingWindow, navigate, setDbConnected])

  // 检查应用锁
  useEffect(() => {
    if (isAgreementWindow || isOnboardingWindow || isVideoPlayerWindow) return

    const checkLock = async () => {
      // 并行获取配置，减少等待
      const [enabled, useHello] = await Promise.all([
        window.electronAPI.auth.verifyEnabled(),
        configService.getAuthUseHello()
      ])

      if (enabled) {
        setLockUseHello(useHello)
        setLocked(true)
        // 尝试获取头像
        try {
          const result = await window.electronAPI.chat.getMyAvatarUrl()
          if (result && result.success && result.avatarUrl) {
            setLockAvatar(result.avatarUrl)
            localStorage.setItem('app_lock_avatar', result.avatarUrl)
          }
        } catch (e) {
          console.error('获取锁屏头像失败', e)
        }
      }
      setLockChecked(true)
    }
    checkLock()
  }, [isAgreementWindow, isOnboardingWindow, isVideoPlayerWindow])

  // 本地身份档案首次引导（PRD §1.2a）：锁检查完成且未锁定后才判断；
  // 每次启动最多弹一次（identityCheckedRef），「稍后再填」由主进程落 identityOnboardingDismissed 保证不再反复弹
  useEffect(() => {
    if (isAgreementWindow || isOnboardingWindow || isVideoPlayerWindow) return
    if (!lockChecked || isLocked || identityCheckedRef.current) return
    identityCheckedRef.current = true
    window.electronAPI.identity.get()
      .then((p) => { if (p?.shouldPromptOnboarding) setShowIdentityOnboarding(true) })
      .catch((e) => console.error('读取身份档案失败:', e))
  }, [isAgreementWindow, isOnboardingWindow, isVideoPlayerWindow, lockChecked, isLocked])



  // 独立协议窗口
  if (isAgreementWindow) {
    return (
      <Suspense fallback={null}>
        <AgreementPage />
      </Suspense>
    )
  }

  if (isOnboardingWindow) {
    return (
      <Suspense fallback={null}>
        <WelcomePage standalone />
      </Suspense>
    )
  }

  // 独立视频播放窗口
  if (isVideoPlayerWindow) {
    return (
      <Suspense fallback={null}>
        <VideoWindow />
      </Suspense>
    )
  }

  // 独立图片查看窗口
  const isImageViewerWindow = location.pathname === '/image-viewer-window'
  if (isImageViewerWindow) {
    return (
      <Suspense fallback={null}>
        <ImageWindow />
      </Suspense>
    )
  }

  // 独立聊天记录窗口
  if (isChatHistoryWindow) {
    return (
      <Suspense fallback={null}>
        <ChatHistoryPage />
      </Suspense>
    )
  }

  // 独立会话聊天窗口（仅显示聊天内容区域）
  if (isStandaloneChatWindow) {
    const params = new URLSearchParams(location.search)
    const sessionId = params.get('sessionId') || ''
    const standaloneSource = params.get('source')
    const standaloneInitialDisplayName = params.get('initialDisplayName')
    const standaloneInitialAvatarUrl = params.get('initialAvatarUrl')
    const standaloneInitialContactType = params.get('initialContactType')
    return (
      <Suspense fallback={null}>
        <ChatPage
          standaloneSessionWindow
          initialSessionId={sessionId}
          standaloneSource={standaloneSource}
          standaloneInitialDisplayName={standaloneInitialDisplayName}
          standaloneInitialAvatarUrl={standaloneInitialAvatarUrl}
          standaloneInitialContactType={standaloneInitialContactType}
        />
      </Suspense>
    )
  }

  // 独立通知窗口
  if (isNotificationWindow) {
    return (
      <Suspense fallback={null}>
        <NotificationWindow />
      </Suspense>
    )
  }

  // 独立年度报告全屏窗口
  if (isAnnualReportWindow) {
    return (
      <Suspense fallback={null}>
        <AnnualReportWindow />
      </Suspense>
    )
  }

  // 独立双人报告全屏窗口
  if (isDualReportWindow) {
    return (
      <Suspense fallback={null}>
        <DualReportWindow />
      </Suspense>
    )
  }

  // 主窗口 - 完整布局
  const handleCloseSettings = () => {
    const backgroundLocation = settingsRouteState?.backgroundLocation ?? settingsBackgroundRef.current
    if (backgroundLocation.pathname === '/settings') {
      navigate('/home', { replace: true })
      return
    }
    navigate(
      {
        pathname: backgroundLocation.pathname,
        search: backgroundLocation.search,
        hash: backgroundLocation.hash
      },
      {
        replace: true,
        state: backgroundLocation.state
      }
    )
  }

  return (
    <div className="app-container">
      <div className="window-drag-region" aria-hidden="true" />
      {isLocked && (
        <LockScreen
          onUnlock={() => setLocked(false)}
          avatar={lockAvatar}
          useHello={lockUseHello}
        />
      )}
      {/* 本地身份档案首次引导（应用锁之后出现，不挡应用锁） */}
      {!isLocked && (
        <IdentityOnboardingDialog
          open={showIdentityOnboarding}
          onClose={() => setShowIdentityOnboarding(false)}
        />
      )}
      <TitleBar
        sidebarCollapsed={sidebarCollapsed}
        onToggleSidebar={() => setSidebarCollapsed((prev) => !prev)}
        onOpenPalette={togglePalette}
        showThemeToggle
      />

      {/* 全局悬浮进度胶囊 (处理：新版本提示、下载进度、错误提示) */}
      <UpdateProgressCapsule />

      {/* 全局会话监听与通知 */}
      <GlobalSessionMonitor />

      {/* 更新提示对话框 */}
      <UpdateDialog
        open={showUpdateDialog}
        updateInfo={updateInfo}
        onClose={() => { if (!(updateInfo as any)?.isMandatory) setShowUpdateDialog(false) }}
        onUpdate={handleUpdateNow}
        onIgnore={handleIgnoreUpdate}
        isDownloading={isDownloading}
        isMandatory={!!(updateInfo as any)?.isMandatory}
        progress={downloadProgress}
      />

      <WindowCloseDialog
        open={showCloseDialog}
        canMinimizeToTray={canMinimizeToTray}
        restoreMethod={closeRestoreMethod}
        onSelect={(action, rememberChoice) => handleWindowCloseAction(action, rememberChoice)}
        onCancel={() => handleWindowCloseAction('cancel')}
      />

      {/* 命令面板（⌘K / 顶栏搜索按钮）与全局提示条：主窗口外壳件 */}
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <GlobalToast />

      <div className="main-layout">
        <Sidebar collapsed={sidebarCollapsed} />
        <main className="content">
          <RouteGuard>
            {/* Export 模块按需挂载（首次访问或有自动化任务时），挂载后 keepalive 保持任务/调度状态 */}
            {exportMounted && (
              <Suspense fallback={null}>
                <div className={`export-keepalive-page ${isExportRoute ? 'active' : 'hidden'}`} aria-hidden={!isExportRoute}>
                  <ExportPage />
                </div>
              </Suspense>
            )}

            <Suspense fallback={null}>
              <Routes location={routeLocation}>
                <Route path="/" element={<TodayActionPage />} />
                <Route path="/home" element={<TodayActionPage />} />
                <Route path="/account-management" element={<AccountManagementPage />} />
                <Route path="/chat" element={<ChatPage />} />

                <Route path="/analytics" element={<ChatAnalyticsHubPage />} />
                <Route path="/analytics/private" element={<AnalyticsWelcomePage />} />
                <Route path="/analytics/private/view" element={<AnalyticsPage />} />
                <Route path="/analytics/group" element={<GroupAnalyticsPage />} />
                <Route path="/analytics/view" element={<RouteStateRedirect to="/analytics/private/view" />} />
                <Route path="/group-analytics" element={<RouteStateRedirect to="/analytics/group" />} />
                <Route path="/annual-report" element={<AnnualReportPage />} />
                <Route path="/annual-report/view" element={<AnnualReportWindow />} />
                <Route path="/dual-report" element={<DualReportPage />} />
                <Route path="/dual-report/view" element={<DualReportWindow />} />
                <Route path="/footprint" element={<MyFootprintPage />} />

                <Route path="/export" element={<div className="export-route-anchor" aria-hidden="true" />} />
                <Route path="/sns" element={<SnsPage />} />
                <Route path="/insight-inbox" element={<InsightInboxPage />} />
                <Route path="/knowledge-base" element={<KnowledgeBasePage />} />
                <Route path="/eval-annotate" element={<EvalAnnotatePage />} />
                <Route path="/hermes" element={<HermesPanel />} />
                <Route path="/sales-report" element={<SalesReportPage />} />
                {/* 「漏斗」已并入商机「阶段分析」视图（2026-09-13）；旧链接/书签不失效 */}
                <Route path="/sales-funnel" element={<RouteStateRedirect to="/opportunities?view=analysis" />} />
                <Route path="/action-funnel" element={<ActionFunnelPage />} />
                <Route path="/opportunities" element={<OpportunityPage />} />
                <Route path="/customers" element={<CustomerWorkspacePage />} />
                <Route path="/crm" element={<CrmWorkbenchPage />} />
                <Route path="/crm-review" element={<CrmReviewPage />} />
                <Route path="/crm-product" element={<CrmProductPage />} />
                <Route path="/leads" element={<CrmLeadPage />} />
                <Route path="/contacts" element={<ContactsPage />} />
                <Route path="/role-view" element={<RoleViewPage />} />
                <Route path="/resources" element={<ResourcesPage />} />
                <Route path="/backup" element={<BackupPage />} />
                <Route path="/chat-history/:sessionId/:messageId" element={<ChatHistoryPage />} />
                <Route path="/chat-history-inline/:payloadId" element={<ChatHistoryPage />} />
                {/* 已删除路由（如 /follow-up）或旧书签 → 回落今日行动，避免空白 */}
                <Route path="*" element={<Navigate to="/home" replace />} />
              </Routes>
            </Suspense>
          </RouteGuard>
        </main>
      </div>

      {isSettingsRoute && (
        <Suspense fallback={null}>
          <SettingsNavShell onClose={handleCloseSettings} />
        </Suspense>
      )}
    </div>
  )
}

export default App
