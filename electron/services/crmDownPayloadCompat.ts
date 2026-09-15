/**
 * crmDownPayloadCompat.ts —— 历史下行 outbox 载荷的惰性兼容 / 富化（2026-09-15 升级兼容）
 *
 * 背景（真实缺陷的升级残留）：`transferAssignment()` 一直把 `mode` 与 `sla1_deadline` 写进
 * **新的 assignment 行**，但 7278d61 之前**没有**把它们写进 outbox payload；而共享下行契约已把
 * `mode` / `sla1Deadline` 列为 transfer 的必填。升级后那些**升级前产生的 pending 行**在两条通道上
 * 会以不同方式失败：
 *   - 中央 HTTP：`commandPayloadOf('transfer')` 产出空 mode / null SLA，发送前自检直接判 failed；
 *   - SMB：`emitDownEvents()` 原样展开旧载荷，终端共享校验器拒收并隔离到 `.failed/`。
 *
 * 兼容口径（**惰性富化**，不做全表破坏性 UPDATE、不改幂等键）：
 *   - 只能从本机 `payload.assignmentId` 指向的 assignment 行取值；
 *   - 用的是**当时已经写入那一行的绝对 SLA 值**，绝不按当前时间 / 当前 `crmLeadSlaHours` /
 *     接收端配置重算——重算会让历史移交的期限整体漂移（设备时钟与配置各不相同）；
 *   - 两个字段已经合法时原样放行（幂等：重复富化结果不变）；
 *   - 无法可靠恢复时**不猜值、不发送**：返回稳定错误码，由调用方把该行置终态 failed + 脱敏审计。
 *
 * 两条发射端（`centralSyncService.pushOutboxCommand` 与 `lanSyncService.emitDownEvents`）
 * **共用本模块**，不各写一套兼容逻辑。
 */
import { ASSIGNMENT_MODES, type AssignmentMode } from '../../shared/centralDownCommand'
import { crmDbService } from './crmDbService'

/** 富化结果：ok=true 的 payload 可直接进入既有发送流程；ok=false 时调用方禁止发送 */
export type DownPayloadHeal =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; code: string }

function isConcreteAssignmentId(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

/** 绝对 SLA 截止时间：有限正整数时间戳（毫秒）。NULL / 0 / 字符串数字一律视为不可用。 */
function isAbsoluteDeadline(value: number): boolean {
  return Number.isInteger(value) && value > 0
}

function isKnownMode(value: unknown): value is AssignmentMode {
  return typeof value === 'string' && (ASSIGNMENT_MODES as readonly string[]).includes(value)
}

/**
 * 富化一条历史下行载荷；`ok=false` 表示**不可发送**（调用方置 failed + 脱敏审计）。
 *
 * 只处理 `transfer`：`assign` 的 `mode` 不是必填、`sla1Deadline` 缺失时接收端按既有
 * `sla1 || lead.first_contact_deadline` 兜底，历史 assign 行没有兼容问题，不在此扩张改动面。
 * 返回的 payload 是**新对象**，原 payload 不被就地修改（重复调用结果一致）。
 */
export function healLegacyDownPayload(type: string, payload: Record<string, unknown>): DownPayloadHeal {
  if (type !== 'transfer') return { ok: true, payload }
  const hasMode = isKnownMode(payload.mode)
  const hasDeadline = isAbsoluteDeadline(Number(payload.sla1Deadline ?? NaN))
  if (hasMode && hasDeadline) return { ok: true, payload }
  if (!isConcreteAssignmentId(payload.assignmentId)) return { ok: false, code: 'legacy_transfer_bad_assignment_id' }
  const row = crmDbService.all('SELECT mode, sla1_deadline FROM assignment WHERE id = ?', [payload.assignmentId])[0]
  if (!row) return { ok: false, code: 'legacy_transfer_assignment_missing' }
  const mode = row.mode
  if (!isKnownMode(mode)) return { ok: false, code: 'legacy_transfer_mode_unrecoverable' }
  const sla1Deadline = Number(row.sla1_deadline ?? NaN)
  if (!isAbsoluteDeadline(sla1Deadline)) return { ok: false, code: 'legacy_transfer_sla_unrecoverable' }
  const next: Record<string, unknown> = { ...payload }
  if (!hasMode) next.mode = mode
  if (!hasDeadline) next.sla1Deadline = sla1Deadline
  return { ok: true, payload: next }
}
