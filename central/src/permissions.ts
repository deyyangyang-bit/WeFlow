/**
 * 中央服务角色权限矩阵（PRD §3 角色与权限总表 / §3.1 认证分层）。
 *
 * 显式表驱动：每个角色能做什么写死在 ROLE_CAPABILITIES 里，端点只查 `can()`，
 * 禁止在路由里散落 role 字符串比较，也禁止用「本地自报角色」当权限依据。
 * 真正的权限来源永远是服务端 employee.role + device 绑定（central/src/postgresStore.ts）。
 */
import type { CentralCommandCapability } from '../../shared/centralDownCommand.js'
import type { EnterpriseRole } from './store.js'

export type Capability =
  | 'sync.push'        // 上行推送
  | 'sync.pull'        // 下行拉取
  | 'sync.ack'         // 下行回执
  | CentralCommandCapability // 下发中央指令（2026-09-19 拆分四域，见 shared/centralDownCommand.ts）
  | 'invite.create'    // 创建一次性绑定邀请码
  | 'device.rotate'    // 轮换本设备令牌
  | 'device.revokeSelf'// 自助解绑本设备
  | 'device.revoke'    // 吊销工作区内任意设备
  | 'directory.read'   // 读取本工作区员工目录（把本地显示名解析成 stable employeeId 的唯一依据）

const BASE_DEVICE_CAPABILITIES: readonly Capability[] = ['sync.push', 'sync.pull', 'sync.ack', 'device.rotate', 'device.revokeSelf']

export const ROLE_CAPABILITIES: Record<EnterpriseRole, readonly Capability[]> = {
  // 销售：本人客户的全部日常同步；无分配/移交/权限指令权、无邀请码、无吊销他人设备。
  // 但**必须有 directory.read + command.notify**：SLA1 三次超时的升级通知由持有该分配行的
  // 设备产生（sla1_escalate_supervisor 走 notify 域），销售设备要能把「主管」解析成 stable
  // employeeId，否则该通知永远无法投递（§三.6）。目录只回员工身份元数据，不含任何客户数据。
  sales: [...BASE_DEVICE_CAPABILITIES, 'directory.read', 'command.notify'],
  // 销售主管：PRD §3 团队只读 + 审核/移交审批/仲裁 → 分配域 + 移交/主管修正域
  // （下指令前必须能解析目标员工）；权限变更归管理员
  supervisor: [...BASE_DEVICE_CAPABILITIES, 'directory.read', 'command.assign', 'command.transfer', 'command.notify'],
  // 分配员：录入/分配/调比例/回收 → 仅分配域（默认由主管兼任）；移交与权限变更不可越权
  allocator: [...BASE_DEVICE_CAPABILITIES, 'directory.read', 'command.assign', 'command.notify'],
  // 管理员：PRD §3 账号/角色/密钥 → 全部指令域 + 邀请码与设备吊销
  admin: [...BASE_DEVICE_CAPABILITIES, 'directory.read', 'command.assign', 'command.transfer', 'command.permission', 'command.notify', 'invite.create', 'device.revoke'],
  // 系统/AI 账号：永不人工登录、永不授予分配权，只按调用者身份只读消费
  service: ['sync.pull']
}

export function capabilitiesOf(role: EnterpriseRole): readonly Capability[] {
  return ROLE_CAPABILITIES[role] || []
}

export function can(role: EnterpriseRole, capability: Capability): boolean {
  return capabilitiesOf(role).includes(capability)
}
