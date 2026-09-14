/** Phase 3a 中央 HTTP 同步 IPC。所有写操作只在最外层进入 salesQueue。 */
import type { IpcMain } from 'electron'
import { enqueueSalesTask } from './salesQueue'
import {
  centralSyncStatus, claimCentralBinding, disconnectCentralBinding, runCentralSyncOnce
} from './centralSyncService'

export function registerCentralSyncIpcHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('centralsync:status', async () => {
    try { return { success: true, status: centralSyncStatus() } }
    catch (error) { return { success: false, error: String(error) } }
  })
  ipcMain.handle('centralsync:claim', async (_event, payload: { baseUrl?: string; inviteCode?: string; deviceName?: string }) => {
    try {
      const baseUrl = String(payload?.baseUrl || '').trim()
      const inviteCode = String(payload?.inviteCode || '').trim()
      if (!baseUrl || !inviteCode) return { success: false, error: '中央服务地址和邀请码不能为空' }
      const principal = await enqueueSalesTask(async () => claimCentralBinding(baseUrl, inviteCode, String(payload?.deviceName || '').trim() || undefined))
      return { success: true, principal }
    } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) } }
  })
  // 解绑：先请求服务端自助吊销，成功后才清本机凭证。网络失败且未强制时**不清本地**，
  // 如实返回 revoked=false，避免出现「本机以为解绑、服务端令牌仍有效」的假解绑（PRD §7.1）。
  ipcMain.handle('centralsync:disconnect', async (_event, payload?: { force?: boolean }) => {
    try {
      const result = await enqueueSalesTask(async () => disconnectCentralBinding({ force: Boolean(payload?.force) }))
      return { success: true, ...result }
    } catch (error) { return { success: false, error: String(error) } }
  })
  ipcMain.handle('centralsync:run', async () => {
    try { return { success: true, result: await enqueueSalesTask(async () => runCentralSyncOnce()) } }
    catch (error) { return { success: false, error: String(error) } }
  })
}
