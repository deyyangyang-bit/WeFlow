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

/** 员工目录条目：中央侧唯一的「本地显示名 → stable 员工」解析依据（PRD §3.1 身份行） */
export interface EmployeeDirectoryEntry {
  employeeId: string
  employeeCode: string
  displayName: string
  role: EnterpriseRole
  /** 本工作区内该显示名是否唯一；false = 下游解析必须显式报错，绝不按名字猜人 */
  nameUnique: boolean
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
  /** 同时指定员工与设备时，二者必须属于同一员工（§七.4） */
  deviceBelongsToEmployee(workspaceId: string, deviceId: string, employeeId: string): Promise<boolean>
  /** 本工作区员工目录（解析契约；按 employee_code 稳定排序） */
  listEmployees(workspaceId: string): Promise<EmployeeDirectoryEntry[]>
  /**
   * 跨设备投影冲突留痕（§二.3/§二.4）：只记字段路径与稳定错误码，绝不记任何客户数据值。
   * 冲突事件照常被拒收，冲突记录用于人工仲裁；本轮**不**自动归并、不建第二套客户真源。
   */
  recordConflict(principal: DevicePrincipal, event: CentralSyncEvent, code: string): Promise<void>
  /** 上行载荷命中禁字段（聊天正文/session_id/WCDB 路径）时的策略违规留痕；只记字段路径，不记值 */
  recordPolicyViolation(principal: DevicePrincipal, event: CentralSyncEvent, fieldPath: string): Promise<void>
}
