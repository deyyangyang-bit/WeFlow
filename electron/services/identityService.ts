/**
 * identityService.ts —— 本地身份档案（PRD §1.2a）
 * 存本地配置（identityName / identityRole / identityOnboardingDismissed），与现有应用锁完全独立。
 * 用途：audit_event / ownership_history 的 actor 署名（宪法 §1.8/§1.12）、分配服务认领身份、审批确认显示操作人。
 * ⚠️ 角色字段仅作署名，绝不作任何访问控制/数据过滤依据（宪法 §1.12 明文）。
 * 零 electron 依赖（config.ts 的 electron 导入为条件 try-catch，tsx 测试可直接跑）。
 */
import { ConfigService } from './config'
import type { IdentityLike } from '../../shared/ownerFilter'

export type IdentityRole = '' | '销售' | '主管' | '分配员'
export interface IdentityProfile { name: string; role: IdentityRole }

const ROLES: readonly string[] = ['销售', '主管', '分配员']

/** 角色归一：非法值（含历史脏数据）一律归空串 = 未选角色 */
export function normalizeRole(role: unknown): IdentityRole {
  const r = String(role ?? '').trim()
  return (ROLES.includes(r) ? r : '') as IdentityRole
}

/** 读取身份档案；姓名未填 = 未建档，返回 null */
export function getIdentity(): IdentityProfile | null {
  const cfg = ConfigService.getInstance()
  const name = String(cfg.get('identityName') || '').trim()
  if (!name) return null
  return { name, role: normalizeRole(cfg.get('identityRole')) }
}

/**
 * actor 署名（宪法 §1.8/§1.12 口径）：「姓名（角色）」，如「杨青（销售）」；角色未选只写姓名。
 * 未建档返回 null，由调用方自定兜底（如分配服务兜底「分配员」）。
 */
export function getActorLabel(): string | null {
  const id = getIdentity()
  if (!id) return null
  return id.role ? `${id.name}（${id.role}）` : id.name
}

/** 建档/修改：姓名必填（调用方校验），角色非法归一为空；建档成功即视为引导完成 */
export function setIdentity(name: string, role: unknown): IdentityProfile | null {
  const cfg = ConfigService.getInstance()
  cfg.set('identityName', String(name || '').trim())
  cfg.set('identityRole', normalizeRole(role))
  if (String(name || '').trim()) cfg.set('identityOnboardingDismissed', true)
  return getIdentity()
}

/** 首次启动引导：是否还需要弹（未建档且未跳过） */
export function shouldPromptOnboarding(): boolean {
  const cfg = ConfigService.getInstance()
  return !getIdentity() && !cfg.get('identityOnboardingDismissed')
}

/**
 * 归属别名（2026-09-17「销售看不到中央分配」根因修复）：
 * 本设备绑定的中央身份 displayName 与本地署名指同一人，但下行 assign 落地的
 * assignment.sales_name 用的是中央目录显示名（发送侧口径，宪法 §1.3 归属唯一事实源不动），
 * 销售视图按本地署名过滤就会看不见自己的分配。
 * 口径（不建第二套身份模型，不改 assignment schema）：
 *   - 仅当**中央同步已启用**且持稳定 employeeId 时，把 centralSyncDisplayName 认作归属别名；
 *   - 与本地署名相同（含 trim 后相等）不重复返回；
 *   - 解绑 / 未绑定时返回空（disconnectCentralBinding 已清 centralSync* 配置），别名随之消失；
 *   - 这是「姓名集合」的归属匹配（历史 assignment 只存姓名），**不是** employeeId 匹配，
 *     也绝不把 displayName 当永久唯一标识——它是绑定期间的别名，不改写任何历史数据。
 */
export function getOwnershipAliases(): string[] {
  const cfg = ConfigService.getInstance()
  if (!cfg.get('centralSyncEnabled')) return []
  const employeeId = String(cfg.get('centralSyncEmployeeId') || '').trim()
  const centralName = String(cfg.get('centralSyncDisplayName') || '').trim()
  const local = String(cfg.get('identityName') || '').trim()
  if (!employeeId || !centralName || centralName === local) return []
  return [centralName]
}

/**
 * 销售视角身份视图：本地档案 + 归属别名 + 绑定的中央员工 id（shared/ownerFilter.IdentityLike 消费口径）。
 * 未建档返回 null。employeeId 参与归属核对（行带 owner_employee_id 时为权威依据，同名员工不串线）。
 */
export interface OwnerIdentity extends IdentityLike {
  name: string
  role: IdentityRole
  nameAliases: string[]
  employeeId: string
}
export function getOwnerIdentity(): OwnerIdentity | null {
  const id = getIdentity()
  if (!id) return null
  return { name: id.name, role: id.role, nameAliases: getOwnershipAliases(), employeeId: getBoundEmployeeId() }
}

/** 本机绑定的中央员工 id（仅中央同步启用且持稳定 id 时非空；解绑即空） */
export function getBoundEmployeeId(): string {
  const cfg = ConfigService.getInstance()
  if (!cfg.get('centralSyncEnabled')) return ''
  return String(cfg.get('centralSyncEmployeeId') || '').trim()
}

/** 「稍后再填」：标记跳过，幂等（不再反复弹） */
export function dismissOnboarding(): void {
  ConfigService.getInstance().set('identityOnboardingDismissed', true)
}
