import { randomUUID } from 'node:crypto'
import type { CentralAckRequest, CentralPullResult, CentralSyncEvent } from '../../shared/centralSync.js'
import {
  buildDuplicateGroupDownPayload, duplicateGroupDigest, duplicateGroupEventIdentity,
  duplicateGroupGroupId, mergeDuplicateGroupMembers, type DupMember
} from './duplicateGroup.js'
import { crossDeviceConflict, identityAnchorOf, projectionOf, validateProjectionPayload } from './projections.js'
import type { CentralStore, DevicePrincipal, EmployeeDirectoryEntry, EnterpriseRole, InviteInput, PushResult } from './store.js'

interface InviteRow extends InviteInput { inviteId: string; codeHash: string; used: boolean; employeeId: string }
/** 员工行：与 Postgres 实现同构——员工 id 是稳定 UUID，同一员工的多台设备共用一个 id */
interface EmployeeRow {
  employeeId: string
  workspaceId: string
  employeeCode: string
  displayName: string
  role: EnterpriseRole
}
interface DeviceRow extends DevicePrincipal { tokenHash: string; active: boolean }
interface EventRow { centralSeq: number; workspaceId: string; sourceDeviceId: string; event: CentralSyncEvent }
/** 投影行按 (workspace, entityType, entityId) 保存：内存实现同样拒绝未登记实体与非法载荷。 */
interface ProjectionRow {
  workspaceId: string; entityType: string; entityId: string; aggregateVersion: number
  payload: Record<string, unknown>
  /** 投影归属设备：跨设备改写必须被拒（§二.3），与 postgres 的 source_device_id 同语义 */
  sourceDeviceId: string
}

/** HTTP 契约测试用内存实现；生产只使用 PostgresCentralStore。 */
export class MemoryCentralStore implements CentralStore {
  private invites: InviteRow[] = []
  private devices: DeviceRow[] = []
  private events: EventRow[] = []
  private projections: ProjectionRow[] = []
  private acknowledgements = new Map<string, CentralAckRequest['acknowledgements'][number]['outcome']>()
  private attempts = new Map<string, number>()
  private violations: Array<{ workspaceId: string; deviceId: string; eventId: string; fieldPath: string }> = []
  private conflicts: Array<{ workspaceId: string; deviceId: string; eventId: string; entityType: string; entityId: string; code: string }> = []
  /** 撞客一期（宪法 §3.1 duplicate_group）：身份锚点冲突登记的重复组，与 postgres central_duplicate_group 同构（含单调版本号） */
  private dupGroups: Array<{ workspaceId: string; anchorType: string; anchorHash: string; anchorMasked: string; membersJson: string; memberCount: number; registeredBy: string; aggregateVersion: number }> = []
  private employees: EmployeeRow[] = []
  /**
   * 中央审计流水。`detail` 与 PostgresCentralStore 的 `central_audit_event.detail` 同语义：
   * 只放稳定元数据（eventType / targetEmployeeId …），**不放**邀请码、令牌、联系方式或任何客户数据。
   */
  private audits: Array<{ workspaceId: string; actor: string; action: string; entityType: string; entityId: string; detail: Record<string, unknown> }> = []

  async migrate(): Promise<void> {}
  async ping(): Promise<void> {}
  async close(): Promise<void> {}

  async createInvite(input: InviteInput, codeHash: string, actor: string): Promise<{ inviteId: string }> {
    const inviteId = randomUUID()
    // 与 postgres 同构：员工按 (workspace, employee_code) 唯一，id 稳定跨设备复用
    let employee = this.employees.find((row) => row.workspaceId === input.workspaceId && row.employeeCode === input.employeeCode)
    if (employee) {
      employee.displayName = input.displayName
      employee.role = input.role
    } else {
      employee = { employeeId: randomUUID(), workspaceId: input.workspaceId, employeeCode: input.employeeCode,
        displayName: input.displayName, role: input.role }
      this.employees.push(employee)
    }
    this.invites.push({ ...input, inviteId, codeHash, used: false, employeeId: employee.employeeId })
    // §四：邀请码签发是中央运维动作，必须留痕。审计**只**记 inviteId / employeeId / role——
    // 邀请码明文与哈希都不进审计（审计表不存任何凭据材料）。
    this.audits.push({ workspaceId: input.workspaceId, actor, action: 'invite_create',
      entityType: 'binding_invite', entityId: inviteId, detail: { employeeId: employee.employeeId, role: input.role } })
    return { inviteId }
  }

  async claimInvite(codeHash: string, deviceName: string, tokenHash: string): Promise<DevicePrincipal> {
    const invite = this.invites.find((row) => row.codeHash === codeHash && !row.used && row.expiresAt > Date.now())
    if (!invite) throw new Error('INVITE_INVALID')
    invite.used = true
    const principal: DevicePrincipal = {
      workspaceId: invite.workspaceId,
      employeeId: invite.employeeId,
      deviceId: randomUUID(),
      displayName: invite.displayName,
      role: invite.role
    }
    this.devices.push({ ...principal, tokenHash, active: true })
    return principal
  }

  async deviceBelongsToEmployee(workspaceId: string, deviceId: string, employeeId: string): Promise<boolean> {
    // 已吊销设备不是合法投递目标（与 PostgresCentralStore 的 status='active' 判定保持一致）
    return this.devices.some((device) => device.active && device.workspaceId === workspaceId &&
      device.deviceId === deviceId && device.employeeId === employeeId)
  }

  async listEmployees(workspaceId: string): Promise<EmployeeDirectoryEntry[]> {
    const rows = this.employees.filter((employee) => employee.workspaceId === workspaceId)
    const counts = new Map<string, number>()
    for (const row of rows) counts.set(row.displayName, (counts.get(row.displayName) || 0) + 1)
    return rows
      .slice()
      .sort((a, b) => a.employeeCode.localeCompare(b.employeeCode))
      .map((row) => ({ employeeId: row.employeeId, employeeCode: row.employeeCode, displayName: row.displayName,
        role: row.role, nameUnique: (counts.get(row.displayName) || 0) === 1 }))
  }

  async recordConflict(principal: DevicePrincipal, event: CentralSyncEvent, code: string): Promise<void> {
    this.conflicts.push({ workspaceId: principal.workspaceId, deviceId: principal.deviceId, eventId: event.eventId,
      entityType: event.entityType, entityId: event.entityId, code })
    this.audits.push({ workspaceId: principal.workspaceId, actor: `device:${principal.deviceId}`,
      action: 'sync_entity_conflict', entityType: event.entityType, entityId: event.entityId,
      detail: { code, eventId: event.eventId, eventType: event.eventType } })
  }

  /**
   * 撞客一期（宪法 §3.1 duplicate_group）：身份锚点冲突 → 登记重复组 + 广播下行事件（无 target
   * = pullEvents 对全工作区设备可见）。与 postgres registerDuplicateGroup 同构：
   * H7 收口后成员**累积合并**（central/src/duplicateGroup.ts 唯一实现，第三成员不再覆盖第二成员）、
   * ownerSales 用最新可得值更新但不清空非空旧值、eventId/幂等键/aggregateVersion 基于
   * canonical 成员内容摘要（成员内容不变不重发；成员数相同但内容变化也产生新事件）。
   */
  private registerDuplicateGroup(principal: DevicePrincipal, event: CentralSyncEvent, clash: ProjectionRow): void {
    const anchor = identityAnchorOf(event.payload)
    if (!anchor) return
    const holderRef = String(clash.payload.customerRef || clash.entityId || '')
    const incomingRef = String(event.payload.customerRef || event.entityId || '')
    if (!holderRef || !incomingRef || holderRef === incomingRef) return
    const ownerOf = (ref: string) => {
      const row = this.projections.find((p) => p.workspaceId === principal.workspaceId &&
        p.entityType === 'customer' && (p.entityId === ref || String(p.payload.customerRef || '') === ref))
      return String(row?.payload.ownerSales ?? '')
    }
    const existing = this.dupGroups.find((g) => g.workspaceId === principal.workspaceId &&
      g.anchorType === anchor.identityType && g.anchorHash === anchor.identityHash)
    let prevMembers: DupMember[] = []
    try {
      const parsed = JSON.parse(String(existing?.membersJson || '[]'))
      if (Array.isArray(parsed)) prevMembers = parsed as DupMember[]
    } catch { prevMembers = [] }
    const prevVersion = existing ? Number(existing.aggregateVersion || 0) : 0
    // 全部成员带最新可得 owner 值进入合并（查不到为 ''，merge 空不清空旧非空值）
    const refs = [...new Set([...prevMembers.map((m) => m.customerRef), holderRef, incomingRef])]
    const incoming: DupMember[] = refs.map((customerRef) => ({ customerRef, ownerSales: ownerOf(customerRef) }))
    const members = mergeDuplicateGroupMembers(prevMembers, incoming)
    const digest = duplicateGroupDigest(members)
    // 内容未变化（重复登记同一成员、owner 也无更新）→ 不重发不空转
    if (prevMembers.length > 0 && members.length === prevMembers.length && digest === duplicateGroupDigest(prevMembers)) return
    const anchorMasked = String(event.payload.identityMasked || existing?.anchorMasked || '')
    const identity = duplicateGroupEventIdentity(anchor.identityType, anchor.identityHash, digest, prevVersion)
    const membersJson = JSON.stringify(members)
    if (existing) {
      existing.anchorMasked = anchorMasked
      existing.membersJson = membersJson
      existing.memberCount = members.length
      existing.registeredBy = principal.deviceId
      existing.aggregateVersion = identity.aggregateVersion
    } else {
      this.dupGroups.push({ workspaceId: principal.workspaceId, anchorType: anchor.identityType,
        anchorHash: anchor.identityHash, anchorMasked, membersJson, memberCount: members.length,
        registeredBy: principal.deviceId, aggregateVersion: identity.aggregateVersion })
    }
    const downPayload = buildDuplicateGroupDownPayload({
      anchorType: anchor.identityType, anchorHash: anchor.identityHash, anchorMasked,
      members, deleted: false, registeredByDeviceId: principal.deviceId
    })
    this.events.push({
      centralSeq: this.events.length + 1, workspaceId: principal.workspaceId, sourceDeviceId: principal.deviceId,
      event: { protocolVersion: 1, eventId: identity.eventId,
        eventSeq: members.length, idempotencyKey: identity.idempotencyKey,
        direction: 'down', entityType: 'duplicate_group', entityId: duplicateGroupGroupId(anchor.identityType, anchor.identityHash),
        eventType: 'duplicate_group_sync', aggregateVersion: identity.aggregateVersion,
        payload: downPayload,
        occurredAt: Date.now() }
    })
  }

  /** 测试视图：重复组登记行（与 central_duplicate_group 同构） */
  dupGroupRows(): Array<{ workspaceId: string; anchorType: string; anchorHash: string; anchorMasked: string; membersJson: string; memberCount: number }> {
    return this.dupGroups.map(({ workspaceId, anchorType, anchorHash, anchorMasked, membersJson, memberCount }) =>
      ({ workspaceId, anchorType, anchorHash, anchorMasked, membersJson, memberCount }))
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
    this.audits.push({ workspaceId: row.workspaceId, actor, action: 'device_revoke', entityType: 'device', entityId: deviceId, detail: {} })
    return true
  }

  /**
   * 设备自助解绑。**只写一条审计（device_revoke_self）**：此前委托 revokeDevice 会先写一条
   * device_revoke，同一次动作在中央审计里出现两行「谁吊销了这台设备」，运维与合规排查会误判。
   */
  async revokeSelf(principal: DevicePrincipal): Promise<boolean> {
    const row = this.devices.find((device) => device.deviceId === principal.deviceId && device.active &&
      device.workspaceId === principal.workspaceId)
    if (!row) return false
    row.active = false
    this.audits.push({ workspaceId: row.workspaceId, actor: principal.displayName,
      action: 'device_revoke_self', entityType: 'device', entityId: principal.deviceId, detail: {} })
    return true
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
      // 投影写入与下述两道闸门**只对上行投影**成立；下行指令由 appendDownEvent 单独落库。
      const isUplinkProjection = event.direction === 'up'
      const existingProjection = isUplinkProjection
        ? this.projections.find((row) => row.workspaceId === principal.workspaceId &&
          row.entityType === event.entityType && row.entityId === event.entityId)
        : undefined
      // 归属闸门（§二.3）：既有投影只能被原设备更新，跨设备改写明确拒收，绝不覆盖
      const ownership = isUplinkProjection ? crossDeviceConflict(existingProjection?.sourceDeviceId, principal.deviceId) : null
      if (ownership) {
        await this.recordConflict(principal, event, ownership)
        rejected.push({ eventId: event.eventId, code: ownership, message: '既有投影属于其它设备，跨设备写入被拒' })
        continue
      }
      // 唯一身份锚点闸门（§二.4）：同一身份值只能指向一个客户，冲突留记录并拒收（不自动归并）
      const anchor = isUplinkProjection && event.entityType === 'customer_identity' ? identityAnchorOf(event.payload) : null
      if (anchor) {
        const clash = this.projections.find((row) => row.workspaceId === principal.workspaceId &&
          row.entityType === 'customer_identity' && row.entityId !== event.entityId &&
          String(row.payload.identityType ?? '') === anchor.identityType &&
          String(row.payload.identityHash ?? '') === anchor.identityHash)
        if (clash) {
          await this.recordConflict(principal, event, 'identity_anchor_conflict')
          this.registerDuplicateGroup(principal, event, clash)
          rejected.push({ eventId: event.eventId, code: 'identity_anchor_conflict',
            message: '同一身份锚点已指向其它客户，需人工仲裁后再同步' })
          continue
        }
      }
      const centralSeq = this.events.length + 1
      this.events.push({ centralSeq, workspaceId: principal.workspaceId, sourceDeviceId: principal.deviceId, event })
      if (!isUplinkProjection) {
        accepted.push({ eventId: event.eventId, centralSeq, duplicate: false })
        continue
      }
      if (existingProjection) {
        if (existingProjection.aggregateVersion < event.aggregateVersion) {
          existingProjection.aggregateVersion = event.aggregateVersion
          existingProjection.payload = event.payload
        }
      } else {
        this.projections.push({ workspaceId: principal.workspaceId, entityType: event.entityType, entityId: event.entityId,
          aggregateVersion: event.aggregateVersion, payload: event.payload, sourceDeviceId: principal.deviceId })
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
    // 员工目标只认「员工目录里存在该员工」；此前那句「历史上有人把事件投给他」会让已离职/已删除的
    // 员工仅仅因为收过一条历史指令就继续通过目标校验，工作区隔离形同虚设。
    if (targetEmployeeId && !this.employees.some((employee) => employee.employeeId === targetEmployeeId &&
      employee.workspaceId === workspaceId)) return false
    return true
  }

  async recordPolicyViolation(principal: DevicePrincipal, event: CentralSyncEvent, fieldPath: string): Promise<void> {
    this.violations.push({ workspaceId: principal.workspaceId, deviceId: principal.deviceId, eventId: event.eventId, fieldPath })
    this.audits.push({ workspaceId: principal.workspaceId, actor: `device:${principal.deviceId}`,
      action: 'sync_forbidden_field', entityType: event.entityType, entityId: event.eventId,
      detail: { fieldPath, eventType: event.eventType } })
  }

  /** 仅供测试断言：审计流水（与 postgres 实现同款语义）。 */
  auditActions(): Array<{ workspaceId: string; actor: string; action: string; entityType: string; entityId: string; detail: Record<string, unknown> }> {
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

  /** 仅供测试断言：跨设备/身份锚点冲突记录（只含字段路径与稳定码，不含任何业务值）。 */
  conflictRecords(): Array<{ workspaceId: string; deviceId: string; eventId: string; entityType: string; entityId: string; code: string }> {
    return [...this.conflicts]
  }

  /** 仅供测试断言：投影行（含归属设备），用于验证跨设备写入未被覆盖。 */
  projectionRows(): Array<{ workspaceId: string; entityType: string; entityId: string; aggregateVersion: number; sourceDeviceId: string; payload: Record<string, unknown> }> {
    return this.projections.map((row) => ({ ...row, payload: { ...row.payload } }))
  }

  /**
   * 落一条下行指令。**不写投影表、不走上行归属闸门**：指令的业务合法性由共享校验器
   * （shared/centralDownCommand.ts，路由层调用）判定，投影注册表管的是上行投影形态。
   * 与 PostgresCentralStore.insertEvent 语义保持一致：只判幂等。
   */
  async appendDownEvent(actor: DevicePrincipal, event: CentralSyncEvent): Promise<{ centralSeq: number; duplicate: boolean }> {
    const down = { ...event, direction: 'down' as const }
    const existing = this.events.find((row) => row.workspaceId === actor.workspaceId && row.event.idempotencyKey === event.idempotencyKey)
    if (existing) {
      if (existing.event.eventId !== event.eventId) throw new Error('idempotency_key_conflict')
      return { centralSeq: existing.centralSeq, duplicate: true }
    }
    const centralSeq = this.events.length + 1
    this.events.push({ centralSeq, workspaceId: actor.workspaceId, sourceDeviceId: actor.deviceId, event: down })
    // §四：下行指令首次落库留一条审计（同事务语义：内存实现里两者一起返回）。
    // 幂等重放已在上面提前 return，因此审计不会随重放增长。只记定位元数据，不记载荷。
    this.audits.push({ workspaceId: actor.workspaceId, actor: `device:${actor.deviceId}`, action: 'down_command',
      entityType: event.entityType, entityId: event.entityId,
      detail: { eventId: event.eventId, eventType: event.eventType,
        ...(event.targetEmployeeId ? { targetEmployeeId: event.targetEmployeeId } : {}),
        ...(event.targetDeviceId ? { targetDeviceId: event.targetDeviceId } : {}) } })
    return { centralSeq, duplicate: false }
  }

  /** 测试用：当前落库的下行指令条数（校验失败的指令不得留下任何痕迹） */
  downEventCount(): number {
    return this.events.filter((row) => row.event.direction === 'down').length
  }
}
