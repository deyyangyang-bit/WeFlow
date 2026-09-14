import { randomUUID } from 'node:crypto'
import type { CentralAckRequest, CentralPullResult, CentralSyncEvent } from '../../shared/centralSync.js'
import { projectionOf, validateProjectionPayload } from './projections.js'
import type { CentralStore, DevicePrincipal, InviteInput, PushResult } from './store.js'

interface InviteRow extends InviteInput { inviteId: string; codeHash: string; used: boolean }
interface DeviceRow extends DevicePrincipal { tokenHash: string; active: boolean }
interface EventRow { centralSeq: number; workspaceId: string; sourceDeviceId: string; event: CentralSyncEvent }
/** 投影行按 (workspace, entityType, entityId) 保存：内存实现同样拒绝未登记实体与非法载荷。 */
interface ProjectionRow { workspaceId: string; entityType: string; entityId: string; aggregateVersion: number; payload: Record<string, unknown> }

/** HTTP 契约测试用内存实现；生产只使用 PostgresCentralStore。 */
export class MemoryCentralStore implements CentralStore {
  private invites: InviteRow[] = []
  private devices: DeviceRow[] = []
  private events: EventRow[] = []
  private projections: ProjectionRow[] = []
  private acknowledgements = new Map<string, CentralAckRequest['acknowledgements'][number]['outcome']>()
  private attempts = new Map<string, number>()
  private violations: Array<{ workspaceId: string; deviceId: string; eventId: string; fieldPath: string }> = []
  private audits: Array<{ workspaceId: string; actor: string; action: string; entityType: string; entityId: string }> = []

  async migrate(): Promise<void> {}
  async ping(): Promise<void> {}
  async close(): Promise<void> {}

  async createInvite(input: InviteInput, codeHash: string): Promise<{ inviteId: string }> {
    const inviteId = randomUUID()
    this.invites.push({ ...input, inviteId, codeHash, used: false })
    return { inviteId }
  }

  async claimInvite(codeHash: string, deviceName: string, tokenHash: string): Promise<DevicePrincipal> {
    const invite = this.invites.find((row) => row.codeHash === codeHash && !row.used && row.expiresAt > Date.now())
    if (!invite) throw new Error('INVITE_INVALID')
    invite.used = true
    const principal: DevicePrincipal = {
      workspaceId: invite.workspaceId,
      employeeId: `employee:${invite.employeeCode}`,
      deviceId: randomUUID(),
      displayName: invite.displayName,
      role: invite.role
    }
    this.devices.push({ ...principal, tokenHash, active: true })
    return principal
  }

  async authenticate(tokenHash: string): Promise<DevicePrincipal | null> {
    const row = this.devices.find((device) => device.tokenHash === tokenHash && device.active)
    if (!row) return null
    const { tokenHash: _tokenHash, active: _active, ...principal } = row
    return principal
  }

  async rotateDeviceToken(principal: DevicePrincipal, tokenHash: string): Promise<void> {
    const row = this.devices.find((device) => device.deviceId === principal.deviceId && device.active)
    if (!row) throw new Error('DEVICE_NOT_FOUND')
    row.tokenHash = tokenHash
  }

  async revokeDevice(workspaceId: string, deviceId: string, actor: string): Promise<boolean> {
    const row = this.devices.find((device) => device.deviceId === deviceId && device.active &&
      (!workspaceId || device.workspaceId === workspaceId))
    if (!row) return false
    row.active = false
    this.audits.push({ workspaceId: row.workspaceId, actor, action: 'device_revoke', entityType: 'device', entityId: deviceId })
    return true
  }

  async revokeSelf(principal: DevicePrincipal): Promise<boolean> {
    const revoked = await this.revokeDevice(principal.workspaceId, principal.deviceId, principal.displayName)
    if (revoked) {
      this.audits.push({ workspaceId: principal.workspaceId, actor: principal.displayName,
        action: 'device_revoke_self', entityType: 'device', entityId: principal.deviceId })
    }
    return revoked
  }

  async pushEvents(principal: DevicePrincipal, events: CentralSyncEvent[]): Promise<PushResult> {
    const accepted: PushResult['accepted'] = []
    const rejected: PushResult['rejected'] = []
    for (const event of events) {
      const byKey = this.events.find((row) => row.workspaceId === principal.workspaceId && row.event.idempotencyKey === event.idempotencyKey)
      if (byKey) {
        if (byKey.event.eventId !== event.eventId) {
          rejected.push({ eventId: event.eventId, code: 'event_rejected', message: 'idempotency_key_conflict' })
        } else {
          accepted.push({ eventId: event.eventId, centralSeq: byKey.centralSeq, duplicate: true })
        }
        continue
      }
      // 载荷先过注册表校验：未登记实体 / 缺必填字段 / 命中禁字段 → 只拒这一条，同批其它照收
      let projection
      try { projection = projectionOf(event.entityType) } catch (error) {
        rejected.push({ eventId: event.eventId, code: 'event_rejected', message: error instanceof Error ? error.message : String(error) })
        continue
      }
      const invalid = validateProjectionPayload(projection, event.payload)
      if (invalid) {
        rejected.push({ eventId: event.eventId, code: 'event_rejected', message: invalid })
        continue
      }
      const centralSeq = this.events.length + 1
      this.events.push({ centralSeq, workspaceId: principal.workspaceId, sourceDeviceId: principal.deviceId, event })
      const existingProjection = this.projections.find((row) => row.workspaceId === principal.workspaceId &&
        row.entityType === event.entityType && row.entityId === event.entityId)
      if (existingProjection) {
        if (existingProjection.aggregateVersion < event.aggregateVersion) {
          existingProjection.aggregateVersion = event.aggregateVersion
          existingProjection.payload = event.payload
        }
      } else {
        this.projections.push({ workspaceId: principal.workspaceId, entityType: event.entityType, entityId: event.entityId,
          aggregateVersion: event.aggregateVersion, payload: event.payload })
      }
      accepted.push({ eventId: event.eventId, centralSeq, duplicate: false })
    }
    return { accepted, rejected }
  }

  async pullEvents(principal: DevicePrincipal, cursor: number, limit: number): Promise<CentralPullResult> {
    const candidates = this.events.filter((row) => row.workspaceId === principal.workspaceId && row.centralSeq > cursor &&
      row.event.direction === 'down' && (!row.event.targetDeviceId || row.event.targetDeviceId === principal.deviceId) &&
      (!row.event.targetEmployeeId || row.event.targetEmployeeId === principal.employeeId) &&
      (!this.acknowledgements.has(`${principal.deviceId}:${row.centralSeq}`) || this.acknowledgements.get(`${principal.deviceId}:${row.centralSeq}`) === 'retry'))
    const hasMore = candidates.length > limit
    const events = candidates.slice(0, limit).map((row) => ({ ...row.event, centralSeq: row.centralSeq }))
    return { events, nextCursor: events.at(-1)?.centralSeq ?? cursor, hasMore }
  }

  async ackEvents(principal: DevicePrincipal, acknowledgements: CentralAckRequest['acknowledgements']): Promise<number> {
    let count = 0
    for (const ack of acknowledgements) {
      const event = this.events.find((row) => row.workspaceId === principal.workspaceId && row.centralSeq === ack.centralSeq &&
        row.event.eventId === ack.eventId && row.event.direction === 'down')
      const key = `${principal.deviceId}:${ack.centralSeq}`
      if (event) {
        if (ack.outcome === 'retry') this.attempts.set(key, (this.attempts.get(key) || 0) + 1)
        this.acknowledgements.set(key, ack.outcome)
        count++
      }
    }
    return count
  }

  /** 仅供测试断言：读取当前投影行。 */
  projectionRow(entityType: string, entityId: string): ProjectionRow | undefined {
    return this.projections.find((row) => row.entityType === entityType && row.entityId === entityId)
  }

  /** 仅供测试断言：读取某设备的某条下行事件累计重试次数。 */
  attemptsFor(deviceId: string, centralSeq: number): number {
    return this.attempts.get(`${deviceId}:${centralSeq}`) || 0
  }

  async isTargetInWorkspace(workspaceId: string, targetDeviceId?: string, targetEmployeeId?: string): Promise<boolean> {
    if (targetDeviceId && !this.devices.some((device) => device.deviceId === targetDeviceId && device.workspaceId === workspaceId)) return false
    if (targetEmployeeId && !this.events.some((row) => row.workspaceId === workspaceId && row.event.targetEmployeeId === targetEmployeeId) &&
        !this.devices.some((device) => device.employeeId === targetEmployeeId && device.workspaceId === workspaceId)) return false
    return true
  }

  async recordPolicyViolation(principal: DevicePrincipal, event: CentralSyncEvent, fieldPath: string): Promise<void> {
    this.violations.push({ workspaceId: principal.workspaceId, deviceId: principal.deviceId, eventId: event.eventId, fieldPath })
    this.audits.push({ workspaceId: principal.workspaceId, actor: `device:${principal.deviceId}`,
      action: 'sync_forbidden_field', entityType: event.entityType, entityId: event.eventId })
  }

  /** 仅供测试断言：审计流水（与 postgres 实现同款语义）。 */
  auditActions(): Array<{ workspaceId: string; actor: string; action: string; entityType: string; entityId: string }> {
    return [...this.audits]
  }

  /** 仅供测试断言：设备令牌只以哈希形式留存（用于「令牌只存哈希」验证）。 */
  deviceTokenHash(deviceId: string): string | undefined {
    return this.devices.find((device) => device.deviceId === deviceId)?.tokenHash
  }

  /** 仅供测试断言：把内部状态整体序列化，用于断言明文令牌从未落库。 */
  dumpForLeakCheck(): string {
    return JSON.stringify({ devices: this.devices, invites: this.invites, events: this.events, projections: this.projections })
  }

  /** 仅供测试断言：策略违规留痕。 */
  policyViolations(): Array<{ workspaceId: string; deviceId: string; eventId: string; fieldPath: string }> {
    return [...this.violations]
  }

  async appendDownEvent(actor: DevicePrincipal, event: CentralSyncEvent): Promise<{ centralSeq: number; duplicate: boolean }> {
    const result = await this.pushEvents(actor, [{ ...event, direction: 'down' }])
    if (result.rejected[0]) throw new Error(result.rejected[0].message)
    const row = result.accepted[0]
    if (!row) throw new Error('EVENT_NOT_INSERTED')
    return { centralSeq: row.centralSeq, duplicate: row.duplicate }
  }
}
