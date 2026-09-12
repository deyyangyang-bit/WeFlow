/**
 * autoBackupIpcHandlers.ts
 * 自动备份 IPC 注册（PRD 1.1；service→main 注册约定，同 evalIpcHandlers 模式）。
 * 端点：backup:auto:runNow（手动立即备份）/ backup:auto:status（上次时间+两层状态+下次计划+密钥封装方式+恢复门禁）/
 *       backup:auto:restore（本机或网络层恢复）/ backup:auto:recoveryKey:export|import（恢复密钥，跨机器恢复凭证）。
 * 纪律：runNow 走 runAutoBackupNow（内部已 enqueueSalesTask 最外层串行化）；status 只读不排队；
 *       恢复密钥口令只在内存中出现，不落 config、不写日志。
 * 恢复：restore 成功后由本层 setTimeout 调 app.relaunch() + app.exit(0)，前端不得重复触发重启；
 *       source='network' 省略 backupId = 恢复网络层最新有效链（换新电脑的标准入口）。
 * 导入：recoveryKey:import 的 adopt=true 仅在新机首次恢复门禁开放、且用户已在前端显式确认时使用——
 *       采用恢复密钥会把本机旧密钥与本地备份链整体移入隔离目录（不删除、可人工恢复）。
 */
import { app, dialog, type IpcMain } from 'electron'
import {
  exportAutoBackupRecoveryKey, getAutoBackupStatus, importAutoBackupRecoveryKey,
  restoreLatestAutoBackup, runAutoBackupNow
} from './autoBackupService'

function assertPassphrasePresent(passphrase: string): void {
  if (!passphrase) throw new Error('缺少恢复密钥口令')
}

export function registerAutoBackupIpcHandlers(ipcMain: IpcMain): void {
  // 手动立即备份（设置页「立即备份」按钮）；失败 error 已含具体失败阶段（刷盘/备份）
  ipcMain.handle('backup:auto:runNow', async () => {
    try {
      const result = await runAutoBackupNow()
      return { success: result.ok, result, error: result.ok ? undefined : (result.error || result.manifest?.layers?.local?.error || '备份失败') }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  // 状态查询（上次时间 / 两层状态 / 下次计划 / 密钥封装方式）
  ipcMain.handle('backup:auto:status', async () => {
    try {
      return { success: true, status: getAutoBackupStatus() }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  // 恢复指定节点（省略 backupId = 最新链；source='network' 从配置的网络备份路径恢复）；
  // 成功后立即重启，防止旧 sql.js 内存态覆盖恢复文件。
  ipcMain.handle('backup:auto:restore', async (_, payload?: { backupId?: string; source?: 'local' | 'network' }) => {
    try {
      const source = payload?.source === 'network' ? 'network' : 'local'
      const result = await restoreLatestAutoBackup(payload?.backupId, source)
      if (result.ok) setTimeout(() => { app.relaunch(); app.exit(0) }, 100)
      return { success: result.ok, result, error: result.error }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  // 导出恢复密钥：口令加密后写入用户选择（或指定）的文件；未带路径时弹保存对话框
  ipcMain.handle('backup:auto:recoveryKey:export', async (_, payload?: { passphrase?: string; filePath?: string }) => {
    try {
      const passphrase = String(payload?.passphrase || '')
      assertPassphrasePresent(passphrase)
      let filePath = String(payload?.filePath || '').trim()
      if (!filePath) {
        const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
        const picked = await dialog.showSaveDialog({
          title: '导出恢复密钥',
          defaultPath: `weflow-backup-recovery-key-${stamp}.json`,
          filters: [{ name: '恢复密钥', extensions: ['json'] }]
        })
        if (picked.canceled || !picked.filePath) return { success: false, error: '已取消导出' }
        filePath = picked.filePath
      }
      const outcome = exportAutoBackupRecoveryKey(filePath, passphrase)
      return { success: true, ...outcome }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  // 导入恢复密钥：口令错误明确失败且不动本机密钥；已有不同密钥默认拒绝覆盖；
  // adopt=true（仅新机首次恢复门禁开放时由 UI 显式确认）→ 采用：本机旧密钥与旧备份先移入隔离目录。
  // 未带路径时弹选择对话框。
  ipcMain.handle('backup:auto:recoveryKey:import', async (_, payload?: { passphrase?: string; filePath?: string; adopt?: boolean }) => {
    try {
      const passphrase = String(payload?.passphrase || '')
      assertPassphrasePresent(passphrase)
      let filePath = String(payload?.filePath || '').trim()
      if (!filePath) {
        const picked = await dialog.showOpenDialog({
          title: '导入恢复密钥',
          properties: ['openFile'],
          filters: [{ name: '恢复密钥', extensions: ['json'] }]
        })
        if (picked.canceled || !picked.filePaths[0]) return { success: false, error: '已取消导入' }
        filePath = picked.filePaths[0]
      }
      const outcome = importAutoBackupRecoveryKey(filePath, passphrase, { adopt: payload?.adopt === true })
      return { success: true, ...outcome }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })
}
