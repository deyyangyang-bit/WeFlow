/**
 * identityIpcHandlers.ts —— 本地身份档案 IPC（PRD §1.2a）
 * 端点：identity:get / identity:set / identity:onboarding:dismiss。
 * 只读写本地配置（electron-store），不碰 salesDb/crmDb，无需 enqueueSalesTask。
 * ⚠️ 角色仅署名用途（宪法 §1.12），本文件不出现任何权限判断。
 */
import type { IpcMain } from 'electron'
import { getIdentity, getActorLabel, getBoundEmployeeId, getOwnershipAliases, setIdentity, shouldPromptOnboarding, dismissOnboarding } from './identityService'

export interface IdentityIpcHandlerOptions {
  /** 身份档案写入后通知依赖身份上下文的内存能力失效。 */
  onIdentityChanged?: () => void | Promise<void>
}

export function registerIdentityIpcHandlers(ipcMain: IpcMain, options: IdentityIpcHandlerOptions = {}): void {
  // 读取档案 + 计算好的 actor 署名 + 是否还需弹首次引导 + 归属别名（中央绑定 displayName，解绑即空）
  ipcMain.handle('identity:get', async () => {
    const profile = getIdentity()
    return {
      name: profile?.name || '',
      role: profile?.role || '',
      actorLabel: getActorLabel() || '',
      shouldPromptOnboarding: shouldPromptOnboarding(),
      nameAliases: getOwnershipAliases(),
      /** 绑定的中央员工 id（employeeId 权威归属核对用；未绑定为 ''） */
      employeeId: getBoundEmployeeId()
    }
  })

  // 建档/修改（姓名必填；角色非法归一为空 = 未选）
  ipcMain.handle('identity:set', async (_, payload: { name?: string; role?: string }) => {
    const name = String(payload?.name || '').trim()
    if (!name) return { ok: false, code: 'E101', message: '姓名必填' }
    setIdentity(name, payload?.role)
    await options.onIdentityChanged?.()
    return { ok: true, data: { name, role: getIdentity()?.role || '', actorLabel: getActorLabel() || '', nameAliases: getOwnershipAliases(), employeeId: getBoundEmployeeId() } }
  })

  // 首次引导「稍后再填」（幂等）
  ipcMain.handle('identity:onboarding:dismiss', async () => {
    dismissOnboarding()
    return { ok: true }
  })
}
