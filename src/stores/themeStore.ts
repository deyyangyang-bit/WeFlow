import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type ThemeId = 'default' | 'cloud-dancer' | 'corundum-blue' | 'kiwi-green' | 'spicy-red' | 'teal-water' | 'blossom-dream' | 'geist'
export type ThemeMode = 'light' | 'dark' | 'system'

export interface ThemeInfo {
  id: ThemeId
  name: string
  description: string
  primaryColor: string
  bgColor: string
  // 可选副色，用于多彩主题的渐变预览
  accentColor?: string
}

export const themes: ThemeInfo[] = [
  {
    id: 'default',
    name: '默认 · Apple 蓝',
    description: 'WeFlow 品牌色（W1 拍板 #0071E3）',
    primaryColor: '#0071E3',
    bgColor: '#F5F5F7'
  },
  {
    id: 'cloud-dancer',
    name: '云上舞白',
    description: 'Pantone 2026 年度色',
    primaryColor: '#8B7355',
    bgColor: '#F0EEE9'
  },
  {
    id: 'blossom-dream',
    name: '繁花如梦',
    description: '晨曦花境 · 夜阑幽梦',
    primaryColor: '#D4849A',
    bgColor: '#FCF9FB',
    accentColor: '#FFBE98'
  },
  {
    id: 'corundum-blue',
    name: '刚玉蓝',
    description: 'RAL 220 40 10',
    primaryColor: '#4A6670',
    bgColor: '#E8EEF0'
  },
  {
    id: 'kiwi-green',
    name: '冰猕猴桃汁绿',
    description: 'RAL 120 90 20',
    primaryColor: '#7A9A5C',
    bgColor: '#E8F0E4'
  },
  {
    id: 'spicy-red',
    name: '辛辣红',
    description: 'RAL 030 40 40',
    primaryColor: '#8B4049',
    bgColor: '#F0E8E8'
  },
  {
    id: 'teal-water',
    name: '明水鸭色',
    description: 'RAL 180 80 10',
    primaryColor: '#5A8A8A',
    bgColor: '#E4F0F0'
  },
  {
    id: 'geist',
    name: 'Geist',
    description: 'Vercel · 极简黑白',
    primaryColor: '#000000',
    bgColor: '#ffffff'
  }
]

interface ThemeState {
  currentTheme: ThemeId
  themeMode: ThemeMode
  setTheme: (theme: ThemeId) => void
  setThemeMode: (mode: ThemeMode) => void
  toggleThemeMode: () => void
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      currentTheme: 'default',
      themeMode: 'light',
      setTheme: (theme) => set({ currentTheme: theme }),
      setThemeMode: (mode) => set({ themeMode: mode }),
      toggleThemeMode: () => set({ themeMode: get().themeMode === 'light' ? 'dark' : 'light' })
    }),
    {
      name: 'echotrace-theme',
      version: 1,
      // v1：出厂默认从 cloud-dancer（棕金）改为 default（Apple 蓝）——旧持久化一并重置
      migrate: (persisted) => ({ ...(persisted as object), currentTheme: 'default' }) as ThemeState
    }
  )
)

// 获取当前主题信息
export const getThemeInfo = (themeId: ThemeId): ThemeInfo => {
  return themes.find(t => t.id === themeId) || themes[0]
}
