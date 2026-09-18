/**
 * SettingsNavShell —— 设置页「傻瓜式」导航壳（设计稿 docs/UI设计稿-设置页简化.html）
 *
 * 本组件是 SettingsPage 的外壳，只收编导航，不改任何 tab 内容：
 *   - 常用页（屏 1，默认）：外观 / 通知 / 安全 / 我是谁 四卡，全部复用原 tab 的
 *     同一配置键与写入函数（useThemeStore.setThemeMode / configService notification 键 /
 *     auth 状态 / identity get·set），不造第二份；
 *   - 高级设置二级页（屏 2）：AI / 数据 / 系统 三组行，点行经 location.state.initialTab
 *     深链进入 SettingsPage 原 tab（原组件原样渲染，一行不改）；
 *   - 深链直达：外部入口（如侧边栏「设置应用锁」initialTab:'security'）原样保留。
 *
 * ⚠️ 审计流水入口指向 security tab（AuditTrailSection 现挂在安全 tab 内，原样保留）；
 *    不按角色显隐——页面过滤档纪律：角色只过滤数据，不做功能门禁。
 * ⚠️ 设计稿安全卡中的「自动锁定」现有代码无此配置键与行为，按铁律不造新键，不放该行。
 */
import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  Bell, BarChart2, Check, ChevronRight, ClipboardList, Database, Download, Globe, HardDrive,
  Info, Mic, Palette, RotateCcw, ShieldCheck, Sparkles, UserRound, X
} from 'lucide-react'
import SettingsPage from './SettingsPage'
import * as configService from '../services/config'
import { useThemeStore } from '../stores/themeStore'
import { navBack, navInitial, navOpenAdvanced, navOpenTab, type SettingsNavFrom, type SettingsNavLocation } from '../utils/settingsNav'
import './SettingsPage.scss'
import './SettingsNavShell.scss'

interface SettingsRouteState {
  backgroundLocation?: { pathname: string; search: string; hash: string }
  initialTab?: string
  navFrom?: SettingsNavFrom
}

/** 高级设置行（12 项设置按 AI / 数据 / 系统分三组；tab id 对应 SettingsPage 的 SettingsTab） */
const ADVANCED_GROUPS: Array<{ group: string; rows: Array<{ tab: string; label: string; desc: string; icon: React.ElementType }> }> = [
  {
    group: 'AI',
    rows: [
      { tab: 'aiCommon', label: 'AI 设置', desc: '模型配置 · 见解 / 足迹 / 群聊总结 / 消息解析（原 5 个子页）', icon: Sparkles },
      { tab: 'api', label: 'API 服务', desc: 'LLM 接口地址与密钥', icon: Globe },
      { tab: 'models', label: '模型管理', desc: '本地语音模型', icon: Mic }
    ]
  },
  {
    group: '数据',
    rows: [
      { tab: 'database', label: '数据库连接', desc: '微信数据库状态 · 业务数据归档', icon: Database },
      { tab: 'security', label: '审计流水', desc: '分配 / 回收 / 绑定 / 权重调整记录（主管用）', icon: ClipboardList },
      { tab: 'cache', label: '缓存', desc: '图片 / 文件缓存清理', icon: HardDrive },
      { tab: 'autoDownload', label: '自动下载', desc: '聊天文件自动保存', icon: Download }
    ]
  },
  {
    group: '系统',
    rows: [
      { tab: 'antiRevoke', label: '防撤回', desc: '对方撤回的消息仍可见', icon: RotateCcw },
      { tab: 'notification', label: '通知细节', desc: '通知位置 / 黑白名单维护 / 免打扰', icon: Bell },
      { tab: 'analytics', label: '分析', desc: '使用统计', icon: BarChart2 },
      { tab: 'about', label: '关于', desc: '版本信息', icon: Info }
    ]
  }
]

// 自动下载仅 win32+x64 展示——与 SettingsPage filteredTabs 的平台门控口径一致
const isAutoDownloadSupported = (): boolean => {
  const proc = (window as any).electronAPI?.process
  return proc?.platform === 'win32' && proc?.arch === 'x64'
}

// 角色选项与 SettingsPage「身份档案」区块的内联枚举保持一致（''/销售/主管/分配员）
const IDENTITY_ROLE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: '暂不选择' },
  { value: '销售', label: '销售' },
  { value: '主管', label: '主管' },
  { value: '分配员', label: '分配员' }
]

interface SettingsNavShellProps {
  onClose?: () => void
}

function SettingsNavShell({ onClose }: SettingsNavShellProps) {
  const location = useLocation()
  const navigate = useNavigate()
  const { themeMode, setThemeMode } = useThemeStore()

  const [nav, setNav] = useState<SettingsNavLocation>(() => {
    const state = (location.state ?? null) as SettingsRouteState | null
    return navInitial(state?.initialTab, state?.navFrom === 'advanced' ? 'advanced' : 'common')
  })
  const [isClosing, setIsClosing] = useState(false)
  const [message, setMessage] = useState<{ text: string; success: boolean } | null>(null)

  // 常用页数据：全部读原 tab 的同一配置键（进常用页时刷新，防从 tab 返回后展示旧值）
  const [notificationEnabled, setNotificationEnabled] = useState(true)
  const [notificationFilterMode, setNotificationFilterMode] = useState<'all' | 'whitelist' | 'blacklist'>('all')
  const [authEnabled, setAuthEnabled] = useState(false)
  const [isLockMode, setIsLockMode] = useState(false)
  const [identity, setIdentity] = useState<{ name: string; role: string } | null>(null)
  const [showIdentityDialog, setShowIdentityDialog] = useState(false)
  const [identityNameDraft, setIdentityNameDraft] = useState('')
  const [identityRoleDraft, setIdentityRoleDraft] = useState('')

  // 关闭设置后回落的背景页（与 App.tsx settingsBackgroundRef 同源：深链自带 backgroundLocation，否则用打开设置那一刻的 location）
  const backgroundRef = useRef<{ pathname: string; search: string; hash: string }>(
    ((location.state ?? null) as SettingsRouteState | null)?.backgroundLocation ?? location
  )

  const showMessage = (text: string, success: boolean) => {
    setMessage({ text, success })
    setTimeout(() => setMessage(null), 3000)
  }

  const handleClose = () => {
    if (!onClose) return
    setIsClosing(true)
    setTimeout(() => {
      onClose()
    }, 200)
  }

  // 深链/外部直达：location.state.initialTab 变化 → 落对应原 tab（SettingsPage 自身也消费同一 state 打开该 tab）
  useEffect(() => {
    const state = (location.state ?? null) as SettingsRouteState | null
    if (!state?.initialTab) return
    setNav(navOpenTab(String(state.initialTab), state.navFrom === 'advanced' ? 'advanced' : 'common'))
  }, [location.state])

  useEffect(() => {
    if (nav.view !== 'common') return
    let cancelled = false
    ;(async () => {
      try {
        const [savedNotifEnabled, savedFilterMode, savedAuthEnabled, savedLockMode] = await Promise.all([
          configService.getNotificationEnabled(),
          configService.getNotificationFilterMode(),
          window.electronAPI.auth.verifyEnabled(),
          window.electronAPI.auth.isLockMode()
        ])
        if (cancelled) return
        setNotificationEnabled(savedNotifEnabled)
        setNotificationFilterMode(savedFilterMode)
        setAuthEnabled(savedAuthEnabled)
        setIsLockMode(savedLockMode)
        try {
          const idProfile = await window.electronAPI.identity.get()
          if (!cancelled) setIdentity({ name: idProfile.name, role: idProfile.role })
        } catch { /* 身份档案读取失败静默，常用页不阻塞 */ }
      } catch { /* 配置读取失败保持默认值，常用页不阻塞 */ }
    })()
    return () => {
      cancelled = true
    }
  }, [nav.view])

  /** 高级页点行 / 常用卡入口 → 进入原 tab。经 location.state.initialTab 深链（SettingsPage 现有机制，零改动） */
  const openTab = (tab: string, from: SettingsNavFrom) => {
    setNav(navOpenTab(tab, from))
    navigate('/settings', {
      state: {
        backgroundLocation: backgroundRef.current,
        initialTab: tab,
        navFrom: from
      } satisfies SettingsRouteState
    })
  }

  // ── 常用页（屏 1）─────────────────────────────────────────────
  const handleNotificationToggle = async (val: boolean) => {
    setNotificationEnabled(val)
    await configService.setNotificationEnabled(val)
    showMessage(val ? '已开启通知' : '已关闭通知', true)
  }

  // 「只收白名单」开关映射到通知 tab 现有的 notificationFilterMode 键（all/whitelist/blacklist 三值枚举）：
  // 开 = whitelist，关 = all；黑名单模式请到高级「通知细节」维护
  const handleWhitelistToggle = async (val: boolean) => {
    const mode = val ? 'whitelist' as const : 'all' as const
    setNotificationFilterMode(mode)
    await configService.setNotificationFilterMode(mode)
    showMessage(val ? '已开启只收白名单（名单在高级「通知细节」维护）' : '已恢复接收所有通知', true)
  }

  const lockStatusText = isLockMode ? '已开启' : authEnabled ? '旧版模式 — 请到安全页重新设置密码' : '未开启'

  const openIdentityDialog = () => {
    setIdentityNameDraft(identity?.name ?? '')
    setIdentityRoleDraft(identity?.role ?? '')
    setShowIdentityDialog(true)
  }

  const handleIdentitySave = async () => {
    const n = identityNameDraft.trim()
    if (!n) {
      showMessage('请填写姓名', false)
      return
    }
    try {
      const res = await window.electronAPI.identity.set({ name: n, role: identityRoleDraft })
      if (res.ok && res.data) {
        setIdentity({ name: res.data.name, role: res.data.role })
        setShowIdentityDialog(false)
        showMessage(`身份已保存，署名：${res.data.actorLabel}`, true)
      } else {
        showMessage(`保存失败：${res.message || '未知错误'}`, false)
      }
    } catch (e) {
      showMessage(`保存失败：${String(e)}`, false)
    }
  }

  const renderCommonView = () => (
    <div className="snav-body snav-body--common">
      {/* 外观卡：主题三段，复用外观 tab 的 useThemeStore.setThemeMode（同一持久化键） */}
      <div className="snav-card">
        <div className="snav-card-title"><Palette size={15} /> 外观</div>
        <div className="snav-row">
          <div className="snav-row-label"><span className="snav-row-title">主题</span></div>
          <div className="snav-seg" role="radiogroup" aria-label="主题模式">
            <button type="button" className={themeMode === 'light' ? 'on' : ''} onClick={() => setThemeMode('light')}>浅色</button>
            <button type="button" className={themeMode === 'dark' ? 'on' : ''} onClick={() => setThemeMode('dark')}>深色</button>
            <button type="button" className={themeMode === 'system' ? 'on' : ''} onClick={() => setThemeMode('system')}>跟随系统</button>
          </div>
        </div>
      </div>

      {/* 通知卡：总开关 + 白名单开关，复用通知 tab 的 notificationEnabled / notificationFilterMode 键与写入函数 */}
      <div className="snav-card">
        <div className="snav-card-title"><Bell size={15} /> 通知</div>
        <div className="snav-row">
          <div className="snav-row-label">
            <span className="snav-row-title">接收通知</span>
            <span className="snav-row-desc">客户消息、重要提醒</span>
          </div>
          <label className="switch" htmlFor="snav-notification-enabled-toggle">
            <input
              id="snav-notification-enabled-toggle"
              className="switch-input"
              type="checkbox"
              checked={notificationEnabled}
              onChange={async (e) => { await handleNotificationToggle(e.target.checked) }}
            />
            <span className="switch-slider" />
          </label>
        </div>
        <div className="snav-row">
          <div className="snav-row-label">
            <span className="snav-row-title">只收白名单</span>
            <span className="snav-row-desc">开启后只提醒白名单会话（名单在高级「通知细节」里维护）</span>
          </div>
          <label className="switch" htmlFor="snav-whitelist-toggle">
            <input
              id="snav-whitelist-toggle"
              className="switch-input"
              type="checkbox"
              checked={notificationFilterMode === 'whitelist'}
              onChange={async (e) => { await handleWhitelistToggle(e.target.checked) }}
            />
            <span className="switch-slider" />
          </label>
        </div>
      </div>

      {/* 安全卡：应用锁状态展示（与安全 tab 同源：auth.verifyEnabled + auth.isLockMode）。
          开启/修改/关闭走密码流程，留在原安全 tab，这里不复制其逻辑 */}
      <div className="snav-card">
        <div className="snav-card-title"><ShieldCheck size={15} /> 安全</div>
        <div className="snav-row">
          <div className="snav-row-label">
            <span className="snav-row-title">应用锁</span>
            <span className="snav-row-desc">打开应用要输密码（当前状态：{lockStatusText}）</span>
          </div>
          <button type="button" className="snav-row-link" onClick={() => openTab('security', 'common')}>
            去设置 <ChevronRight size={13} />
          </button>
        </div>
      </div>

      {/* 我是谁卡：本地身份档案（identity.get / identity.set，与设置页「身份档案」区块同一 API） */}
      <div className="snav-card">
        <div className="snav-card-title"><UserRound size={15} /> 我是谁（身份档案）</div>
        <div className="snav-row">
          <div className="snav-row-label">
            <span className="snav-row-title">当前身份</span>
            <span className="snav-row-desc">你做的操作会署这个名字；销售只能看到自己名下的客户</span>
          </div>
          {identity?.name
            ? <span className="snav-pill">{identity.name} · {identity.role || '未设角色'}</span>
            : <span className="snav-pill snav-pill-muted">未设置</span>}
        </div>
        <div className="snav-row">
          <div className="snav-row-label"><span className="snav-row-title">切换身份</span></div>
          <button type="button" className="snav-row-link" onClick={openIdentityDialog}>
            选择 <ChevronRight size={13} />
          </button>
        </div>
      </div>

      {/* 高级设置入口（屏 1 底部） */}
      <button type="button" className="snav-advanced-entry" onClick={() => setNav(navOpenAdvanced(nav))}>
        ⚙️ 高级设置（数据库、AI 参数、缓存等，一般不用动）<ChevronRight size={13} />
      </button>
    </div>
  )

  // ── 高级设置二级页（屏 2）─────────────────────────────────────
  const renderAdvancedView = () => (
    <div className="snav-body snav-body--advanced">
      <div className="snav-adv-topbar">
        <button type="button" className="snav-back-link" onClick={() => setNav(navBack(nav))}>‹ 返回常用</button>
        <span className="snav-adv-heading">高级设置</span>
      </div>
      {ADVANCED_GROUPS.map((group) => {
        const rows = group.rows.filter((row) => row.tab !== 'autoDownload' || isAutoDownloadSupported())
        return (
          <div key={group.group} className="snav-adv-group">
            <div className="snav-adv-group-label">{group.group}</div>
            <div className="snav-adv-list">
              {rows.map((row) => (
                <button key={row.tab} type="button" className="snav-adv-row" onClick={() => openTab(row.tab, 'advanced')}>
                  <span className="snav-adv-ic"><row.icon size={15} /></span>
                  <span className="snav-adv-label">
                    <span className="snav-adv-title">{row.label}</span>
                    <span className="snav-adv-desc">{row.desc}</span>
                  </span>
                  <ChevronRight size={14} className="snav-adv-go" />
                </button>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )

  // ── 切换身份弹层（最简名单选择：姓名 + 角色四选一，走 identity.set 同一写入 API）──
  const renderIdentityDialog = () => (
    <div className="social-cookie-modal-overlay" onClick={() => setShowIdentityDialog(false)}>
      <div className="settings-inline-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <UserRound size={20} />
          <h3>切换身份</h3>
        </div>
        <div className="modal-body">
          <p className="snav-dialog-hint">你做的操作会署这个名字；角色仅作署名，不作任何权限依据</p>
          <input
            type="text"
            className="snav-input"
            placeholder="姓名"
            value={identityNameDraft}
            onChange={(e) => setIdentityNameDraft(e.target.value)}
          />
          <div className="snav-role-list" role="radiogroup" aria-label="角色">
            {IDENTITY_ROLE_OPTIONS.map((option) => (
              <button
                key={option.value || 'none'}
                type="button"
                role="radio"
                aria-checked={identityRoleDraft === option.value}
                className={`snav-role-option ${identityRoleDraft === option.value ? 'selected' : ''}`}
                onClick={() => setIdentityRoleDraft(option.value)}
              >
                <span>{option.label}</span>
                {identityRoleDraft === option.value && <Check size={14} />}
              </button>
            ))}
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={() => setShowIdentityDialog(false)}>取消</button>
          <button className="btn btn-primary" onClick={() => { void handleIdentitySave() }} disabled={!identityNameDraft.trim()}>
            保存
          </button>
        </div>
      </div>
    </div>
  )

  // tab 视图：SettingsPage 原组件原样渲染（自带全屏 modal 框与关闭按钮，外壳 chrome 让位，避免双层壳）
  if (nav.view === 'tab') {
    return <SettingsPage onClose={onClose} />
  }

  return (
    <div className={`settings-modal-overlay ${isClosing ? 'closing' : ''}`} onClick={handleClose}>
      <div className={`settings-page ${isClosing ? 'closing' : ''}`} onClick={(event) => event.stopPropagation()}>
        {message && <div className={`message-toast ${message.success ? 'success' : 'error'}`}>{message.text}</div>}

        <div className="settings-header">
          <div className="settings-title-block">
            <h1>设置</h1>
          </div>
          <div className="settings-actions">
            {onClose && (
              <button type="button" className="settings-close-btn" onClick={handleClose} aria-label="关闭设置">
                <X size={18} />
              </button>
            )}
          </div>
        </div>

        {nav.view === 'common' && renderCommonView()}
        {nav.view === 'advanced' && renderAdvancedView()}

        {showIdentityDialog && renderIdentityDialog()}
      </div>
    </div>
  )
}

export default SettingsNavShell
