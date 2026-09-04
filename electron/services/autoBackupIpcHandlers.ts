/**
 * autoBackupIpcHandlers.ts
 * 自动备份 IPC 注册（PRD 1.1；service→main 注册约定，同 evalIpcHandlers 模式）。
 * 端点：backup:auto:runNow（手动立即备份）/ backup:auto:status（上次时间+两层状态+下次计划）。
 * 纪律：runNow 走 runAutoBackupNow（内部已 enqueueSalesTask 最外层串行化）；status 只读不排队。
 */
import type { IpcMain } from 'electron'
import { getAutoBackupStatus, runAutoBackupNow } from './autoBackupService'

export function registerAutoBackupIpcHandlers(ipcMain: IpcMain): void {
  // 手动立即备份（设置页「立即备份」按钮）
  ipcMain.handle('backup:auto:runNow', async () => {
    try {
      const result = await runAutoBackupNow()
      return { success: result.ok, result, error: result.ok ? undefined : (result.error || result.manifest?.layers?.local?.error || '备份失败') }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  // 状态查询（上次时间 / 两层状态 / 下次计划）
  ipcMain.handle('backup:auto:status', async () => {
    try {
      return { success: true, status: getAutoBackupStatus() }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })
}
