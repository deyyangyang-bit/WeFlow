/** Phase 3a 中央 HTTP 同步 IPC。所有写操作只在最外层进入 salesQueue。 */
import type { IpcMain } from 'electron'
import { enqueueSalesTask } from './salesQueue'
import {
  centralSyncStatus, claimCentralBinding, disconnectCentralBinding, listFailedOutbox,
  outboxDeliveryStatusOf, retryFailedOutbox, retryOutcomeOf, runCentralSyncOnce, safeSyncError
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
  // 翻转成功后立刻跑一拍同步，让用户点一次就能看到结果。
  //
  // **关键口径**：「重新排队成功」≠「同步成功」。整轮的 pushed/rejected 是**所有行**的合计，
  // 不能拿来判定用户点的那一行（网络故障时整轮 pushed=0，但该行仍可能是 pending，应显示「等待下一轮」；
  // 未配置中央同步时整轮 enabled=false 且根本没发请求，绝不能显示成功）。所以这里在同步之后
  // **回读该 rowId 的最终状态**，返回 retryOutcome / deliveryStatus 供 UI 直接判定；网络或服务错误
  // 经 safeSyncError 脱敏后单独回传（不含 token、载荷原文、联系方式）。
  ipcMain.handle('centralsync:retryFailed', async (_event, payload?: { rowId?: number }) => {
    try {
      const rowId = Number(payload?.rowId || 0)
      const retry = retryFailedOutbox(rowId)
      if (!retry.ok) return { success: false, ...retry, error: retry.code }
      const result = await enqueueSalesTask(async () => runCentralSyncOnce())
      const syncConfigured = Boolean(result?.enabled)
      const deliveryStatus = outboxDeliveryStatusOf(rowId)
      return {
        success: true, rowId, code: retry.code, retryCode: retry.code, deliveryStatus,
        retryOutcome: retryOutcomeOf(deliveryStatus, syncConfigured), syncConfigured,
        syncError: safeSyncError(result?.error),
        result: {
          enabled: syncConfigured, pushed: Number(result?.pushed || 0),
          rejected: Number(result?.rejected || 0), applied: Number(result?.applied || 0)
        }
      }
    } catch (error) { return { success: false, error: safeSyncError(error) } }
  })
}
