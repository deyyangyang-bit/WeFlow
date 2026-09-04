/**
 * lanSyncIpcHandlers.ts —— 内网同步 IPC（Phase 1 最小版，设计 §5 刀3）
 * 端点：lansync:status（只读状态：角色/目录/最近同步时间/积压数）/ lansync:run（手动立即跑一轮）。
 * 纪律：run 走 enqueueSalesTask 最外层串行化；status 只读不排队。
 */
import type { IpcMain } from 'electron'
import { enqueueSalesTask } from './salesQueue'
import { lanSyncStatus, runLanSyncOnce } from './lanSyncService'

export function registerLanSyncIpcHandlers(ipcMain: IpcMain): void {
  // 状态查询（设置页「内网同步」区块）
  ipcMain.handle('lansync:status', async () => {
    try {
      return { success: true, status: lanSyncStatus() }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  // 手动立即同步一轮（设置页「立即同步」按钮；未配置时静默返回 role 即可）
  ipcMain.handle('lansync:run', async () => {
    try {
      const result = await enqueueSalesTask(async () => runLanSyncOnce())
      return { success: true, result }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })
}
