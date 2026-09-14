import type { CentralAckRequest, CentralPullResult, CentralSyncEvent } from '../../shared/centralSync.js'

export type EnterpriseRole = 'sales' | 'supervisor' | 'allocator' | 'admin' | 'service'

export interface DevicePrincipal {
  workspaceId: string
  employeeId: string
  deviceId: string
  displayName: string
  role: EnterpriseRole
}

export interface InviteInput {
  workspaceId: string
  employeeCode: string
  displayName: string
  role: EnterpriseRole
  expiresAt: number
}

export interface PushResult {
  accepted: Array<{ eventId: string; centralSeq: number; duplicate: boolean }>
  rejected: Array<{ eventId: string; code: string; message: string }>
}

export interface CentralStore {
  migrate(): Promise<void>
  ping(): Promise<void>
  close(): Promise<void>
  createInvite(input: InviteInput, codeHash: string): Promise<{ inviteId: string }>
  claimInvite(codeHash: string, deviceName: string, tokenHash: string): Promise<DevicePrincipal>
  authenticate(tokenHash: string): Promise<DevicePrincipal | null>
  rotateDeviceToken(principal: DevicePrincipal, tokenHash: string): Promise<void>
  /** 工作区隔离的吊销：workspaceId 为空表示中央 bootstrap-admin（可跨工作区） */
  revokeDevice(workspaceId: string, deviceId: string, actor: string): Promise<boolean>
  /** 设备自助解绑：只能吊销自己，用于「先请求服务端撤销，再清本地凭证」 */
  revokeSelf(principal: DevicePrincipal): Promise<boolean>
  pushEvents(principal: DevicePrincipal, events: CentralSyncEvent[]): Promise<PushResult>
  pullEvents(principal: DevicePrincipal, cursor: number, limit: number): Promise<CentralPullResult>
  ackEvents(principal: DevicePrincipal, acknowledgements: CentralAckRequest['acknowledgements']): Promise<number>
  appendDownEvent(actor: DevicePrincipal, event: CentralSyncEvent): Promise<{ centralSeq: number; duplicate: boolean }>
  /** 下行指令目标必须落在指令发起者所属工作区内 */
  isTargetInWorkspace(workspaceId: string, targetDeviceId?: string, targetEmployeeId?: string): Promise<boolean>
  /** 上行载荷命中禁字段（聊天正文/session_id/WCDB 路径）时的策略违规留痕；只记字段路径，不记值 */
  recordPolicyViolation(principal: DevicePrincipal, event: CentralSyncEvent, fieldPath: string): Promise<void>
}
