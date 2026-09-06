/**
 * proposalEventTracking.ts —— 刀 2 采用率埋点写点帮助层（设计-Hermes-MVP 刀 2）
 *
 * 纪律：
 *  - 埋点尽力而为：写失败只 WARN 不抛，绝不影响业务主语义（同 recordUserActionEvent 先例）
 *  - 裁决态（accepted/rejected/modified）只由人工动作写点调用；generated/viewed 挂系统/渲染点
 *  - viewed 每实体只记一次（proposalEventEntityIds 去重），防卡流轮询刷屏
 *  - actor 署名口径 = 宪法 §1.12：人工动作用身份档案 actorLabel；未建档诚实写「未署名」
 */
import { salesDbService } from './salesDbService'
import { getActorLabel } from './identityService'
import { salesLog } from './salesLogger'
import type { ProposalEventType, ProposalEventStage } from '../../shared/proposalEvent'

/** 当前身份档案署名（宪法 §1.12/§1.2a；未建档=「未署名」，不伪造姓名） */
export function currentActor(): string {
  return getActorLabel() || '未署名'
}

/** 追加一条提案埋点（吞错：埋点尽力而为，绝不阻塞业务动作） */
export function trackProposalEvent(input: {
  event_type: ProposalEventType
  stage: ProposalEventStage
  entity_type: string
  entity_id: string | number
  actor?: string
  createdAt?: number
}): void {
  try {
    salesDbService.proposalEventAdd({
      event_type: input.event_type,
      stage: input.stage,
      entity_type: input.entity_type,
      entity_id: String(input.entity_id),
      actor: input.actor ?? '',
      createdAt: input.createdAt
    })
  } catch (e) {
    salesLog('WARN', `[ProposalEvent] ${input.event_type}/${input.stage} ${input.entity_type}:${input.entity_id} 写入失败: ${(e as Error).message}`)
  }
}

/**
 * 卡流渲染点 viewed 埋点：每实体只记一次（首见即记，重复渲染零写入）。
 * 一次批量去重查询 + 只补缺失行，今日行动页轮询零增量成本。
 */
export function trackActionCardsViewed(taskIds: Array<number | string>, actor?: string): void {
  try {
    const ids = [...new Set(taskIds.map((id) => String(id)).filter(Boolean))]
    if (ids.length === 0 || !salesDbService.isInitialized()) return
    const seen = salesDbService.proposalEventEntityIds('action', 'viewed', 'follow_up_task')
    for (const id of ids) {
      if (seen.has(id)) continue
      salesDbService.proposalEventAdd({
        event_type: 'action', stage: 'viewed',
        entity_type: 'follow_up_task', entity_id: id,
        actor: actor ?? currentActor()
      })
    }
  } catch (e) {
    salesLog('WARN', `[ProposalEvent] action/viewed 批量写入失败: ${(e as Error).message}`)
  }
}

/**
 * 刀 5 问数据 viewed 埋点（设计-Hermes-MVP 刀 5「viewed 照记」）：用户展开数据答案卡时记一次。
 * 同 askKey 只记一次；entity=data_ask（宪法 §3 proposal_event 登记行⑦）。
 */
export function trackDataAskViewed(askKey: string, actor?: string): void {
  try {
    const key = String(askKey || '').trim()
    if (!key || !salesDbService.isInitialized()) return
    if (salesDbService.proposalEventEntityIds('knowledge', 'viewed', 'data_ask').has(key)) return
    salesDbService.proposalEventAdd({
      event_type: 'knowledge', stage: 'viewed',
      entity_type: 'data_ask', entity_id: key,
      actor: actor ?? currentActor()
    })
  } catch (e) {
    salesLog('WARN', `[ProposalEvent] data_ask/viewed ${askKey} 写入失败: ${(e as Error).message}`)
  }
}

/**
 * 刀 3 问答 viewed 埋点（设计-Hermes-MVP 刀 3.5「viewed（展开）」）：用户展开答案卡时记一次。
 * 同一问题哈希（askKey）只记一次，防反复展开刷屏；宪法 §3 proposal_event 登记行 knowledge_ask 口径。
 */
export function trackKnowledgeAskViewed(askKey: string, actor?: string): void {
  try {
    const key = String(askKey || '').trim()
    if (!key || !salesDbService.isInitialized()) return
    if (salesDbService.proposalEventEntityIds('knowledge', 'viewed', 'knowledge_ask').has(key)) return
    salesDbService.proposalEventAdd({
      event_type: 'knowledge', stage: 'viewed',
      entity_type: 'knowledge_ask', entity_id: key,
      actor: actor ?? currentActor()
    })
  } catch (e) {
    salesLog('WARN', `[ProposalEvent] knowledge_ask/viewed ${askKey} 写入失败: ${(e as Error).message}`)
  }
}
