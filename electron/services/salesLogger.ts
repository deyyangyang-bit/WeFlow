/**
 * salesLogger.ts
 * 销售助手落盘日志。写到 userData/logs/weflow-sales.log，带单备份轮转（>2MB 翻成 .old）。
 * 目的：打包版用户/排查问题时能看到销售 AI 调用、扫描、预警、错误的记录
 *      （原 insightLog 仅 console，不落盘，打包后不可见）。
 * 安全：日志文件在 userData，不在 git 仓库；不记录任何密钥/聊天原文全文，仅记操作摘要。
 * 健壮：任何 IO 异常都被吞掉，绝不影响业务主流程。
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'fs'
import { join, dirname } from 'path'

const MAX_BYTES = 2 * 1024 * 1024  // 2MB 触发轮转
let cachedPath: string | null | undefined = undefined

function resolvePath(): string | null {
  if (cachedPath !== undefined) return cachedPath
  try {
    // 延迟 require electron，避免在异常加载上下文抛错
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { app } = require('electron')
    const p = join(app.getPath('userData'), 'logs', 'weflow-sales.log')
    cachedPath = p
    return p
  } catch {
    cachedPath = null
    return null
  }
}

function ts(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** 写一行日志到文件（同步、容错）。失败静默。 */
export function salesLog(level: string, message: string): void {
  try {
    const p = resolvePath()
    if (!p) return
    const dir = dirname(p)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    // 轮转：超过上限则把当前日志翻成 .old（覆盖更早的 .old，单备份）
    if (existsSync(p)) {
      try {
        if (statSync(p).size > MAX_BYTES) renameSync(p, p + '.old')
      } catch { /* 轮转失败不影响写入 */ }
    }
    appendFileSync(p, `[${ts()}] [${level}] ${message}\n`, 'utf8')
  } catch {
    /* 日志 IO 异常绝不抛出 */
  }
}

/** 当前日志文件路径（供设置页/调试展示，可能为 null）。 */
export function getSalesLogPath(): string | null {
  return resolvePath()
}
