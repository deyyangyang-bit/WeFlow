/**
 * crm-cleanup-orphans.ts —— 清理孤立客户（无微信会话关联且无合同、无归属项）
 * 运行：npx tsx scripts/crm-cleanup-orphans.ts
 * 先备份 weflow-crm.db 再删除，删除前可终止。
 */
import { copyFileSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { crmDbService } from '../electron/services/crmDbService'

async function main(): Promise<void> {
  const userData = join(homedir(), 'Library', 'Application Support', 'weflow')
  const dbPath = join(userData, 'weflow-crm.db')
  if (!existsSync(dbPath)) {
    console.error('未找到 CRM 数据库:', dbPath)
    process.exit(1)
  }
  const backupPath = `${dbPath}.bak-${Date.now()}`
  copyFileSync(dbPath, backupPath)
  console.log('已备份:', backupPath)

  await crmDbService.initialize(userData)
  const before = Number((crmDbService.all('SELECT COUNT(*) AS c FROM account')[0] || {}).c ?? 0)
  const deleted = crmDbService.cleanupOrphanAccounts()
  const after = Number((crmDbService.all('SELECT COUNT(*) AS c FROM account')[0] || {}).c ?? 0)
  console.log(`删除孤立客户: ${deleted} 个（${before} → ${after}）`)
  if (deleted > 0) {
    console.log('可回滚：恢复备份文件即可（先退出应用再恢复）')
  }
}

void main()
