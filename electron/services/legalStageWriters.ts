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
import { crmDbService } from './crmDbService'
import { normalizeStage, CANONICAL_TO_CN, type StageCanonical } from '../../shared/salesStage'

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

/** 人工纠正成功后向 crmDb 的同步结果（H6）：account 侧同步失败不推翻 salesDb 操作成功 */
export interface ManualStageSyncResult {
  accountUpdated: boolean
  accountId?: number
  /** 经 syncOpportunityStageByAccount 实际推进的 active 商机数 */
  opportunitiesChanged: number
  /** 未同步原因（account 未建档 / crmDb 未就绪或异常） */
  note?: string
}

/**
 * 人工阶段纠正向 crmDb 的同步（H6）：写 account.sales_stage（canonical）+ 调既有
 * syncOpportunityStageByAccount 推进 active 商机。人工是矩阵 🔶 格的唯一合法路径，
 * 这里不设推进拦截；找不到 account 时 salesDb 操作仍成功，返回带 note 的未同步结果。
 */
function syncManualStageToCrm(sessionId: string, canonical: StageCanonical): ManualStageSyncResult {
  try {
    const rows = crmDbService.all('SELECT id FROM account WHERE session_id = ? LIMIT 1', [sessionId])
    if (!rows.length || !crmDbService.currentDbPath()) {
      return { accountUpdated: false, opportunitiesChanged: 0, note: 'account 未建档，仅更新 salesDb' }
    }
    const accountId = Number(rows[0].id)
    crmDbService.update('account', accountId, { sales_stage: canonical, updated_at: Date.now() })
    const opportunitiesChanged = crmDbService.syncOpportunityStageByAccount(accountId, CANONICAL_TO_CN[canonical] || canonical)
    return { accountUpdated: true, accountId, opportunitiesChanged }
  } catch (e) {
    return { accountUpdated: false, opportunitiesChanged: 0, note: `crmDb 同步失败：${String(e)}` }
  }
}

/**
 * manual 写者：校验 + 写 intent_tag_log(source=manual) + 同步 stage + 阶段变更时写 last_stage_change_at。
 * H6：成功后同步 account.sales_stage 与可推进的 active 商机（sync 字段携带同步结果，失败不影响主操作）。
 * @returns 校验失败返回 { success:false, error }；成功返回 { success:true, tag, sync }
 */
export function applyManualStageCorrection(
  sessionId: string,
  stage: string,
  reason?: string
): { success: boolean; tag?: IntentTagLog; error?: string; sync?: ManualStageSyncResult } {
  if (!sessionId) return { success: false, error: '缺少 sessionId' }
  if (!isManualStageValue(stage)) return { success: false, error: `非法阶段值：${stage}` }
  const existing = salesDbService.customerGetBySession(sessionId)
  const changed = normalizeStage(existing?.stage) !== normalizeStage(stage)
  const tag = salesDbService.intentCreate({ session_id: sessionId, stage, source: 'manual', reason })
  salesDbService.customerUpsert({ session_id: sessionId, stage })
  // changedAt 语义 = 当前阶段最近变更时间：仅阶段真正变化时更新（幂等拦截，对齐 classifier 标杆）
  if (changed) salesDbService.updateStageChangeTime(sessionId, Date.now())
  const sync = syncManualStageToCrm(sessionId, normalizeStage(stage))
  return { success: true, tag, sync }
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
