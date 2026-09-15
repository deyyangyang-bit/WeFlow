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
 *   - 只能从本机 `payload.assignmentId` 指向的 assignment 行取值；`assignmentId` 本身必须是
 *     **原始 number 正整数**——不是就一律拒（无论 mode/SLA 是否已完整），绝不交给下游校验器侥幸处理；
 *   - **assignment 行必须存在**（`legacy_transfer_assignment_missing`）：本机 assignment 的生命周期是
 *     「只软删、只改 status」（宪法 §1.3：分配事实 append-only，转派 = 旧行 transferred + 新行 assigned；
 *     重派 = 旧行 recycled；全仓无任何硬删路径，只有测试夹具 DELETE），因此一条**正常产生**的
 *     outbox 行永远能定位到自己的来源行。行不存在 = 库被外部改动（换库 / 手工清理 / 恢复错备份），
 *     此时「载荷是否自足」根本不构成放行理由——契约要求 transfer 的每个身份字段都可核对
 *     （`leadId` 对线索、`toSales` 对目录），`assignmentId` 对来源行是同一组核对里的一项，
 *     缺一项就不能声称这条指令描述的移交事实在本机成立；
 *   - **用恢复行前必须核对身份**：该 assignment 必须是**载荷描述的那一次移交**——`assignment.lead_id`
 *     必须等于 `payload.leadId`、`assignment.sales_name` 必须等于 `payload.toSales`。指向别的线索 /
 *     别的销售的 assignment 行不是本次移交的事实，拿它补齐会把 B 线索的 mode/SLA 贴到 A 线索的指令上；
 *   - 用的是**当时已经写入那一行的绝对 SLA 值**，绝不按当前时间 / 当前 `crmLeadSlaHours` /
 *     接收端配置重算——重算会让历史移交的期限整体漂移（设备时钟与配置各不相同）；
 *   - 两个字段已经合法时原样放行（幂等：重复富化结果不变）；
 *   - 无法可靠恢复时**不猜值、不发送**：返回稳定错误码，由调用方把该行置终态 failed + 脱敏审计。
 *
 * 「已经合法」的判定是**原始类型**判定（2026-09-15 第二轮）：`sla1Deadline` 只有本身是 number
 * 且为有限正整数才算合法。字符串数字（`"123456"`）**不算**——两条通道会各自解读它
 * （中央 `commandPayloadOf` 会 `Number()` 成数字，SMB 原样保留字符串后被 `requiredTimestamps`
 * 拒收），同一行在两条通道上一条通过一条被拒，是必须消除的口径漂移。字符串、小数、NaN、
 * Infinity、0、负数、对象、数组一律按「不可用」处理，能恢复就恢复成 number，恢复不了就拒收。
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

/** 正整数（assignmentId / leadId 的形态判定；两端共用，不各写一遍） */
function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

/**
 * 绝对 SLA 截止时间：**原始类型必须是 number** 且为有限正整数（毫秒）。
 * `Number.isInteger` 已排除 NaN / Infinity / 小数；字符串（含 `"123456"` 这种数字串）一律不算，
 * 否则「已合法」的判定会在中央 HTTP 与 SMB 两条通道上分叉。
 */
function isAbsoluteDeadline(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

function isKnownMode(value: unknown): value is AssignmentMode {
  return typeof value === 'string' && (ASSIGNMENT_MODES as readonly string[]).includes(value)
}

/**
 * 富化一条历史下行载荷；`ok=false` 表示**不可发送**（调用方置 failed + 脱敏审计）。
 *
 * 只处理 `transfer`：`assign` 的 `mode` 不是必填、`sla1Deadline` 缺失时接收端按既有
 * `sla1 || lead.first_contact_deadline` 兜底，历史 assign 行没有兼容问题，不在此扩张改动面。
 * 返回的 payload 是**新对象**（仅当真的补了值），原 payload 不被就地修改。
 *
 * 错误码只描述**字段与一致性结论**，不带客户值、销售姓名或联系方式。
 */
export function healLegacyDownPayload(type: string, payload: Record<string, unknown>): DownPayloadHeal {
  if (type !== 'transfer') return { ok: true, payload }
  const hasMode = isKnownMode(payload.mode)
  const hasDeadline = isAbsoluteDeadline(payload.sla1Deadline)
  const needsRecovery = !hasMode || !hasDeadline
  if (!isPositiveInt(payload.assignmentId)) {
    // 没有可定位的恢复来源：不按线索猜最近一次分配。**无条件拒**——`assignmentId: 0` / `{}` /
    // `"41"` 这类形态无论 mode/SLA 是否已完整都不是一条可核对的移交指令，不能靠下游校验器兜底。
    return { ok: false, code: 'legacy_transfer_bad_assignment_id' }
  }
  const row = crmDbService.all(
    'SELECT lead_id, sales_name, mode, sla1_deadline FROM assignment WHERE id = ?', [payload.assignmentId])[0]
  if (!row) {
    // 行不存在 = 来源无从核对（见文件头：本机 assignment 只软删/只改状态，正常 outbox 行必能定位）。
    // **无条件拒**，不因载荷自足而放行；不猜值、不发送。
    return { ok: false, code: 'legacy_transfer_assignment_missing' }
  }
  // 身份一致性：恢复值只能来自**载荷描述的那一次移交**。行存在却与载荷矛盾 = 指令描述的
  // 本地事实不是它声称的那一条，一律拒（不猜、不发送），无论是否需要恢复。
  const leadId = payload.leadId
  if (!isPositiveInt(leadId) || !isPositiveInt(row.lead_id) || Number(row.lead_id) !== leadId) {
    return { ok: false, code: 'legacy_transfer_lead_mismatch' }
  }
  const toSales = payload.toSales
  if (typeof toSales !== 'string' || toSales.trim() === '' || String(row.sales_name) !== toSales) {
    return { ok: false, code: 'legacy_transfer_target_mismatch' }
  }
  if (!needsRecovery) return { ok: true, payload }
  const mode = row.mode
  if (!isKnownMode(mode)) return { ok: false, code: 'legacy_transfer_mode_unrecoverable' }
  const sla1Deadline = row.sla1_deadline
  if (!isAbsoluteDeadline(sla1Deadline)) return { ok: false, code: 'legacy_transfer_sla_unrecoverable' }
  const next: Record<string, unknown> = { ...payload }
  if (!hasMode) next.mode = mode
  if (!hasDeadline) next.sla1Deadline = sla1Deadline
  return { ok: true, payload: next }
}
