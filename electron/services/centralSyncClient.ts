import type { CentralAckRequest, CentralPullResult, CentralPushRequest, CentralPushResult, CentralSyncEvent } from '../../shared/centralSync'

export interface CentralPrincipal {
  workspaceId: string
  employeeId: string
  deviceId: string
  displayName: string
  role: 'sales' | 'supervisor' | 'allocator' | 'admin' | 'service'
}

export interface CentralClientOptions {
  baseUrl: string
  token?: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

export class CentralSyncHttpError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message)
    this.name = 'CentralSyncHttpError'
  }
}

function normalizedBaseUrl(input: string): string {
  const url = new URL(String(input || '').trim())
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(url.hostname))) {
    throw new Error('中央服务必须使用 HTTPS；仅 localhost 开发态允许 HTTP')
  }
  return url.toString().replace(/\/$/, '')
}

export class CentralSyncClient {
  private readonly baseUrl: string
  private token: string
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch

  constructor(options: CentralClientOptions) {
    this.baseUrl = normalizedBaseUrl(options.baseUrl)
    this.token = String(options.token || '')
    this.timeoutMs = Math.max(1_000, Math.min(120_000, Number(options.timeoutMs || 15_000)))
    this.fetchImpl = options.fetchImpl || fetch
  }

  setToken(token: string): void { this.token = String(token || '') }

  private async request<T>(path: string, init: RequestInit = {}, authenticated = true): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const headers = new Headers(init.headers)
      headers.set('accept', 'application/json')
      if (init.body) headers.set('content-type', 'application/json')
      if (authenticated) {
        if (!this.token) throw new Error('中央服务设备凭证未配置')
        headers.set('authorization', `Bearer ${this.token}`)
      }
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, headers, signal: controller.signal })
      const payload = await response.json().catch(() => null) as { ok?: boolean; data?: T; code?: string; message?: string } | null
      if (!response.ok || !payload?.ok) {
        throw new CentralSyncHttpError(response.status, String(payload?.code || 'E500'), String(payload?.message || `HTTP ${response.status}`))
      }
      return payload.data as T
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw new CentralSyncHttpError(408, 'E408', '中央服务请求超时')
      throw error
    } finally { clearTimeout(timer) }
  }

  async health(): Promise<{ service: string; protocolVersion: number }> {
    return this.request('/health', {}, false)
  }

  /** 认领邀请码完成绑定；成功后本客户端立即持有设备凭证，后续调用无需再次注入令牌 */
  async claim(inviteCode: string, deviceName: string): Promise<{ deviceToken: string; principal: CentralPrincipal }> {
    const result = await this.request<{ deviceToken: string; principal: CentralPrincipal }>('/api/v1/bindings/claim', {
      method: 'POST', body: JSON.stringify({ inviteCode, deviceName })
    }, false)
    this.token = String(result.deviceToken || '')
    return result
  }

  async rotateToken(): Promise<string> {
    const result = await this.request<{ deviceToken: string }>('/api/v1/devices/rotate', { method: 'POST' })
    this.token = result.deviceToken
    return result.deviceToken
  }

  /**
   * 自助解绑：请求中央吊销本设备凭证。**必须由客户端先调用、成功后才清本地凭证**，
   * 否则会出现「本机以为解绑了、服务端令牌仍然有效」的假解绑（PRD §7.1 权限回收）。
   */
  async revokeSelf(): Promise<boolean> {
    const result = await this.request<{ revoked: boolean }>('/api/v1/devices/revoke-self', { method: 'POST' })
    return Boolean(result?.revoked)
  }

  async push(events: CentralSyncEvent[], batchKey: string): Promise<CentralPushResult> {
    const body: CentralPushRequest = { events }
    return this.request('/api/v1/sync/push', {
      method: 'POST', headers: { 'Idempotency-Key': batchKey }, body: JSON.stringify(body)
    })
  }

  async pull(cursor: number, limit = 100): Promise<CentralPullResult> {
    const params = new URLSearchParams({ cursor: String(Math.max(0, cursor)), limit: String(Math.max(1, Math.min(200, limit))) })
    return this.request(`/api/v1/sync/pull?${params}`)
  }

  async ack(acknowledgements: CentralAckRequest['acknowledgements']): Promise<number> {
    const result = await this.request<{ acknowledged: number }>('/api/v1/sync/ack', {
      method: 'POST', body: JSON.stringify({ acknowledgements } satisfies CentralAckRequest)
    })
    return result.acknowledged
  }
}
