/**
 * identityService.ts —— 本地身份档案（PRD §1.2a）
 * 存本地配置（identityName / identityRole / identityOnboardingDismissed），与现有应用锁完全独立。
 * 用途：audit_event / ownership_history 的 actor 署名（宪法 §1.8/§1.12）、分配服务认领身份、审批确认显示操作人。
 * ⚠️ 角色字段仅作署名，绝不作任何访问控制/数据过滤依据（宪法 §1.12 明文）。
 * 零 electron 依赖（config.ts 的 electron 导入为条件 try-catch，tsx 测试可直接跑）。
 */
import { ConfigService } from './config'

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

/** 「稍后再填」：标记跳过，幂等（不再反复弹） */
export function dismissOnboarding(): void {
  ConfigService.getInstance().set('identityOnboardingDismissed', true)
}
