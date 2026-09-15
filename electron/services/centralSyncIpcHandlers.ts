/** Phase 3a 中央 HTTP 同步 IPC。所有写操作只在最外层进入 salesQueue。 */
import type { IpcMain } from 'electron'
import { enqueueSalesTask } from './salesQueue'
import {
  centralSyncStatus, claimCentralBinding, disconnectCentralBinding, listFailedOutbox,
  retryFailedOutbox, runCentralSyncOnce
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
  // 失败项只读清单：字段已在 service 层裁剪（不含 payload 原文），UI 只用于展示与选行
  ipcMain.handle('centralsync:failed', async (_event, payload?: { limit?: number }) => {
    try { return { success: true, items: listFailedOutbox(Number(payload?.limit || 50)) } }
    catch (error) { return { success: false, error: String(error) } }
  })
  // 正式重投入口：只翻转 failed → pending（原子、幂等、追审计），不接受任意 SQL / 任意状态变更。
  // 翻转成功后立刻跑一拍同步，让用户点一次就能看到结果；失败原因由 runCentralSyncOnce 如实回填。
  ipcMain.handle('centralsync:retryFailed', async (_event, payload?: { rowId?: number }) => {
    try {
      const retry = retryFailedOutbox(Number(payload?.rowId || 0))
      if (!retry.ok) return { success: false, ...retry, error: retry.code }
      const result = await enqueueSalesTask(async () => runCentralSyncOnce())
      return { success: true, ...retry, result }
    } catch (error) { return { success: false, error: String(error) } }
  })
}
