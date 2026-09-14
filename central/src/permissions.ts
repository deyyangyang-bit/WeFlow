/**
 * 中央服务角色权限矩阵（PRD §3 角色与权限总表 / §3.1 认证分层）。
 *
 * 显式表驱动：每个角色能做什么写死在 ROLE_CAPABILITIES 里，端点只查 `can()`，
 * 禁止在路由里散落 role 字符串比较，也禁止用「本地自报角色」当权限依据。
 * 真正的权限来源永远是服务端 employee.role + device 绑定（central/src/postgresStore.ts）。
 */
import type { EnterpriseRole } from './store.js'

export type Capability =
  | 'sync.push'        // 上行推送
  | 'sync.pull'        // 下行拉取
  | 'sync.ack'         // 下行回执
  | 'command.issue'    // 下发中央指令（归属/移交/回收/主管修正/权限变更）
  | 'invite.create'    // 创建一次性绑定邀请码
  | 'device.rotate'    // 轮换本设备令牌
  | 'device.revokeSelf'// 自助解绑本设备
  | 'device.revoke'    // 吊销工作区内任意设备

const BASE_DEVICE_CAPABILITIES: readonly Capability[] = ['sync.push', 'sync.pull', 'sync.ack', 'device.rotate', 'device.revokeSelf']

export const ROLE_CAPABILITIES: Record<EnterpriseRole, readonly Capability[]> = {
  // 销售：本人客户的全部日常同步；无下发指令权、无邀请码、无吊销他人设备
  sales: BASE_DEVICE_CAPABILITIES,
  // 销售主管：PRD §3 团队只读 + 审核/移交审批/仲裁 → 可下发指令
  supervisor: [...BASE_DEVICE_CAPABILITIES, 'command.issue'],
  // 分配员：录入/分配/调比例/回收 → 可下发指令（默认由主管兼任）
  allocator: [...BASE_DEVICE_CAPABILITIES, 'command.issue'],
  // 管理员：PRD §3 账号/角色/密钥 → 额外拥有邀请码与设备吊销
  admin: [...BASE_DEVICE_CAPABILITIES, 'command.issue', 'invite.create', 'device.revoke'],
  // 系统/AI 账号：永不人工登录、永不授予分配权，只按调用者身份只读消费
  service: ['sync.pull']
}

export function capabilitiesOf(role: EnterpriseRole): readonly Capability[] {
  return ROLE_CAPABILITIES[role] || []
}

export function can(role: EnterpriseRole, capability: Capability): boolean {
  return capabilitiesOf(role).includes(capability)
}
