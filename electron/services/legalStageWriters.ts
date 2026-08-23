/**
 * legalStageWriters.ts —— 合法 stage 写者的元数据收口（P0-2A.6）
 *
 * 设计 §3/§5 给两个保留合法写者补齐元数据契约：
 *   ① manual correct（sales:intent:correct）：
 *       校验值合法性（拒绝非枚举值 + dormant——dormant 是活动状态非阶段）
 *       + 阶段变更时写 last_stage_change_at
 *   ② deal rule（crmParseService 私聊成交正则）：
 *       补写 intent_tag_log（source=deal_rule）
 *       + 阶段变更时写 last_stage_change_at
 *
 * changedAt 语义 = 当前 stage 最近变更时间：仅当归一化后阶段真正变化时才更新
 * （对齐 classifier 标杆 persistClassification 的幂等拦截），避免重复确认把变更时间刷成"刚刚"。
 * 判断记录（intent_tag_log）始终写入，保留人工确认 / 重复成交信号的历史痕迹。
 *
 * 独立成模块：不依赖 Electron，测试（scripts/legal-stage-writers-test.ts）可加载验证写路径。
 */
import { salesDbService, type IntentTagLog } from './salesDbService'
import { normalizeStage } from '../../shared/salesStage'

/**
 * manual 阶段编辑的合法值判断：已知中文档位或 canonical 英文（normalizeStage 能归一且非 unknown），
 * 或显式的 unknown/未知；拒绝 dormant/沉默（dormant 是时间覆盖层 activityState，不是可手动选择的阶段）。
 * 依赖 normalizeStage 的回退语义：未知输入归一为 'unknown'，因此「归一结果非 unknown」即合法已知档位。
 */
function isManualStageValue(stage: string): boolean {
  const trimmed = (stage || '').trim()
  if (!trimmed) return false
  const canonical = normalizeStage(trimmed)
  if (canonical === 'dormant') return false
  return canonical !== 'unknown' || trimmed === 'unknown' || trimmed === '未知'
}

/**
 * manual 写者：校验 + 写 intent_tag_log(source=manual) + 同步 stage + 阶段变更时写 last_stage_change_at。
 * @returns 校验失败返回 { success:false, error }；成功返回 { success:true, tag }
 */
export function applyManualStageCorrection(
  sessionId: string,
  stage: string,
  reason?: string
): { success: boolean; tag?: IntentTagLog; error?: string } {
  if (!sessionId) return { success: false, error: '缺少 sessionId' }
  if (!isManualStageValue(stage)) return { success: false, error: `非法阶段值：${stage}` }
  const existing = salesDbService.customerGetBySession(sessionId)
  const changed = normalizeStage(existing?.stage) !== normalizeStage(stage)
  const tag = salesDbService.intentCreate({ session_id: sessionId, stage, source: 'manual', reason })
  salesDbService.customerUpsert({ session_id: sessionId, stage })
  // changedAt 语义 = 当前阶段最近变更时间：仅阶段真正变化时更新（幂等拦截，对齐 classifier 标杆）
  if (changed) salesDbService.updateStageChangeTime(sessionId, Date.now())
  return { success: true, tag }
}

/**
 * deal rule 写者：stage=won + 补写 intent_tag_log(source=deal_rule) + 阶段变更时写 last_stage_change_at。
 * 重复成交信号仍写判断记录（保留历史），但不刷新 changedAt。
 */
export function applyDealStageWon(sessionId: string, displayName: string): void {
  const existing = salesDbService.customerGetBySession(sessionId)
  const changed = normalizeStage(existing?.stage) !== 'won'
  salesDbService.customerUpsert({ session_id: sessionId, display_name: displayName, stage: 'won' })
  if (changed) salesDbService.updateStageChangeTime(sessionId, Date.now())
  salesDbService.intentCreate({ session_id: sessionId, stage: 'won', source: 'deal_rule', reason: '私聊成交信号' })
}
