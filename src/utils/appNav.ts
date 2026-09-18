// 应用导航单一真源：侧栏渲染、命令面板页面索引、⌘1/⌘2/⌘3 跳转共用同一份定义。
// 收口 7 个一级模块（今日行动 / 聊天 / CRM / 跟单 / AI·知识 / 报表 / 系统）。
// 导航项两类：路由项（path，跳转）与动作项（action，执行外壳动作不跳路由）；
// 动作项不参与 active 高亮（active 样式只属于真实路由项）。
import {
  BarChart3, BookOpen, Bot, Briefcase, ClipboardCheck, ClipboardList, Eye, Filter,
  Home, Inbox, MessageSquare, Package, Settings, Sparkles, Target, UserCircle, Users,
  type LucideIcon
} from 'lucide-react'

export type NavItemAction = 'openHermes' | 'openSettings'

export type NavItemDef =
  | { label: string; path: string; icon: LucideIcon }
  | { label: string; icon: LucideIcon; action: NavItemAction }

export interface NavGroupDef { key: string; label: string; items: NavItemDef[] }

export const NAV_GROUPS: NavGroupDef[] = [
  { key: 'home', label: '今日行动', items: [{ label: '今日行动', path: '/home', icon: Home }] },
  { key: 'chat', label: '聊天', items: [{ label: '聊天', path: '/chat', icon: MessageSquare }] },
  { key: 'crm', label: 'CRM', items: [
    { label: '线索', path: '/leads', icon: Inbox },
    { label: '客户', path: '/customers', icon: Users },
    { label: '商机', path: '/opportunities', icon: Target },
    { label: '合同', path: '/crm', icon: Briefcase }
  ] },
  { key: 'review', label: '跟单', items: [{ label: '跟单中心', path: '/crm-review', icon: ClipboardCheck }] },
  { key: 'ai', label: 'AI / 知识', items: [
    { label: 'Hermes', icon: Bot, action: 'openHermes' },
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
    { label: '通讯录', path: '/contacts', icon: UserCircle },
    { label: '角色视角', path: '/role-view', icon: Eye },
    { label: '设置', icon: Settings, action: 'openSettings' }
  ] }
]

/** 扁平顺序 = 侧栏从上到下的实际顺序（命令面板与 ⌘1/⌘2/⌘3 都按它取） */
export const NAV_FLAT: NavItemDef[] = NAV_GROUPS.flatMap((g) => g.items)

/** 前三个可跳转路由项：⌘1/⌘2/⌘3 的目标（动作项不参与数字跳转） */
export const NAV_QUICK_ROUTES: string[] = NAV_FLAT
  .filter((i): i is Extract<NavItemDef, { path: string }> => 'path' in i)
  .slice(0, 3)
  .map((i) => i.path)
