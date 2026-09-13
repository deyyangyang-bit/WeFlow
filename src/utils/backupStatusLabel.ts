/**
 * 备份状态人话映射（纯函数、零 IO、无 React）——设置页「自动备份」区块用。
 *
 * 取值口径 = `electron/services/autoBackupCore.ts` 的 `AutoBackupLayerStatus`
 *   （`'ok' | 'skipped_not_configured' | 'skipped_unreachable' | 'failed'`）。
 * 未命中一律回落「未知状态」——**不显示原始英文状态码**，也不假装成功。
 *
 * ⚠️ 与 `shared/auditDict.ts` 的 `BACKUP_LAYER` 是**同一套词汇、两种渲染语境**：
 *   审计流水那边是嵌进一整个句子里（「定时备份成功…（本机 完成）」），故用「完成」；
 *   设置页这边是状态摘要（「本机 ✓ / 网络 未配置共享文件夹」），故用更完整的短句。
 *   `shared/` 不能反向依赖 `src/`，故未强行合并；改词时请两处一起看。
 */

/** 备份层状态 → 人话。未知状态码回落「未知状态」（不泄露原始英文、不留空白） */
const LAYER_LABEL: Record<string, string> = {
  ok: '✓ 完成',
  skipped_not_configured: '未配置共享文件夹，已跳过',
  skipped_unreachable: '共享文件夹连不上，已跳过',
  failed: '失败',
  pending: '进行中'
}

/** 取备份层状态的人话描述 */
export function backupLayerLabel(raw: unknown): string {
  const k = typeof raw === 'string' ? raw : ''
  if (!k) return '未知状态'
  return LAYER_LABEL[k] || '未知状态'
}

/** 密钥封装方式 → 人话（取值口径见 AutoBackupStatus.keyProtection 注释） */
const KEY_PROTECTION_LABEL: Record<string, string> = {
  'electron-safeStorage': '系统安全设施',
  'local-wrap-v1': '本机封装（降级，建议在支持系统安全设施的环境使用）'
}

/** 取密钥封装方式的人话描述 */
export function keyProtectionLabel(raw: unknown): string {
  const k = typeof raw === 'string' ? raw : ''
  if (!k) return '未知状态'
  return KEY_PROTECTION_LABEL[k] || '未知状态'
}
