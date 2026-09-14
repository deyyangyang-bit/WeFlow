import { readFileSync } from 'node:fs'

export interface CentralConfig {
  host: string
  port: number
  databaseUrl: string
  adminToken: string
  tlsTerminated: boolean
  logLevel: string
}

function required(name: string): string {
  const value = String(process.env[name] || '').trim()
  if (!value) throw new Error(`缺少环境变量 ${name}`)
  return value
}

export function loadCentralConfig(): CentralConfig {
  const port = Number(process.env.WEFLOW_CENTRAL_PORT || 8787)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('WEFLOW_CENTRAL_PORT 非法')
  const adminToken = required('WEFLOW_CENTRAL_ADMIN_TOKEN')
  if (adminToken.length < 32) throw new Error('WEFLOW_CENTRAL_ADMIN_TOKEN 至少 32 字符')
  const databaseUrl = new URL(required('WEFLOW_CENTRAL_DATABASE_URL'))
  const passwordFile = String(process.env.WEFLOW_CENTRAL_DATABASE_PASSWORD_FILE || '').trim()
  if (passwordFile) databaseUrl.password = readFileSync(passwordFile, 'utf8').trim()
  return {
    host: String(process.env.WEFLOW_CENTRAL_HOST || '127.0.0.1'),
    port,
    databaseUrl: databaseUrl.toString(),
    adminToken,
    tlsTerminated: String(process.env.WEFLOW_CENTRAL_TLS_TERMINATED || '') === 'true',
    logLevel: String(process.env.WEFLOW_CENTRAL_LOG_LEVEL || 'info')
  }
}
