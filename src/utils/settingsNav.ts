/**
 * 设置页导航状态机（纯函数，零依赖，可单测）
 *
 * 设置页三层视图：
 *   common   —— 默认「常用」页（外观 / 通知 / 安全 / 我是谁 四卡，屏 1）
 *   advanced —— 「高级设置」二级页（AI / 数据 / 系统 三组行，屏 2）
 *   tab      —— 原设置页某个 tab（SettingsPage 原组件原样渲染，内容零改动）
 *
 * 导航链：common → advanced → tab；返回逐级回退。
 * 深链（location.state.initialTab，如侧边栏「设置应用锁」直达安全 tab）
 * 直接落 tab，from='common'，返回回常用页。
 */

/** tab 视图的返回目标：从哪层进来回哪层 */
export type SettingsNavFrom = 'common' | 'advanced'

export type SettingsNavLocation =
  | { view: 'common' }
  | { view: 'advanced' }
  | { view: 'tab'; tab: string; from: SettingsNavFrom }

/**
 * 初始视图：无深链（或深链为空串）→ 常用页；有深链 → 直达该 tab。
 * from 默认 'common'（外部入口如侧边栏「设置应用锁」），高级页行进入时传 'advanced'。
 */
export function navInitial(deepLinkTab?: string | null, from: SettingsNavFrom = 'common'): SettingsNavLocation {
  const tab = typeof deepLinkTab === 'string' ? deepLinkTab.trim() : ''
  if (!tab) return { view: 'common' }
  return { view: 'tab', tab, from }
}

/** 进入「高级设置」二级页（任何视图都可进） */
export function navOpenAdvanced(_current: SettingsNavLocation): SettingsNavLocation {
  return { view: 'advanced' }
}

/** 从某层进入原 tab（from 决定返回目标） */
export function navOpenTab(tab: string, from: SettingsNavFrom): SettingsNavLocation {
  return { view: 'tab', tab, from }
}

/** 返回：tab → 进来那层；advanced → 常用；common 停在原处（无返回按钮） */
export function navBack(current: SettingsNavLocation): SettingsNavLocation {
  if (current.view === 'tab') return { view: current.from }
  if (current.view === 'advanced') return { view: 'common' }
  return current
}
