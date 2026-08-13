/**
 * crmImportService.ts
 * AI 意向客户导入：AI 画像（finalProfile）生成后，判定该客户是否有销售意向，
 * 有意向则自动导入 CRM（幂等）。
 * 职责：AI 判定 + 调用 crmDbService.importCustomerFromProfile，由 main.ts 在画像成功后触发。
 */
import { simpleCompletion, isAiConfigured } from './ai/aiApiClient'
import { crmDbService } from './crmDbService'
import { chatService } from './chatService'
import { wcdbService } from './wcdbService'
import { salesLog } from './salesLogger'
import type { ConfigService } from './config'
import type { InsightProfileRecord } from './insightProfileService'

// 判定 prompt：基于 AI 画像判断 B2B 工业设备销售意向
const INTENT_JUDGE_PROMPT = `你是 B2B 工业设备（叉车/仓储搬运设备）销售意向判定器。
基于客户的 AI 画像判断他是否有销售意向/需求（是否值得导入 CRM 跟进）。

只输出 JSON：{"hasIntent": true/false, "stage": "阶段", "reason": "20字内依据"}

阶段取值（有意向时必填）：contacted(有实质沟通) / quoted(已报价或询价) / negotiating(在谈价格交期等) / won(已成交)
判定标准：
- hasIntent=true：画像中出现询价、比价、采购计划、设备需求、安装/改造/维护需求、预算、正在使用竞品但想换等
- hasIntent=false：纯熟人寒暄、无设备需求迹象、仅事务性沟通
- 拿不准时 hasIntent=false（宁缺勿滥，避免污染 CRM）`

export interface IntentJudgeResult {
  hasIntent: boolean
  stage?: string
  reason?: string
}

/**
 * 收集内部群成员（同事）作为排除名单：按群名匹配会话 → 读群成员（wxid + 显示名）。
 * 返回名字/wxid 去重列表，供 CRM 导入时跳过。
 */
export async function collectInternalGroupMembers(groupNames: string[]): Promise<string[]> {
  const names: string[] = []
  const validNames = (groupNames || []).filter(Boolean)
  if (validNames.length === 0) return names
  try {
    const sessResult = await chatService.getSessions()
    const sessions: Array<{ username?: string; displayName?: string }> = sessResult?.sessions ?? []
    const groupSessions = sessions.filter((s) => String(s.username || '').endsWith('@chatroom'))
    console.log(`[CrmImport] 会话 ${sessions.length} 个，其中群 ${groupSessions.length} 个；群名样本：${groupSessions.slice(0, 8).map((s) => JSON.stringify(s.displayName)).join(' | ')}`)
    const matched = groupSessions.filter((s) =>
      validNames.some((g) => g && String(s.displayName || '').includes(g))
    )
    if (matched.length === 0) {
      console.log(`[CrmImport] 未找到内部群（${validNames.join('、')}），请检查群名`)
      return names
    }
    for (const g of matched) {
      const res = await wcdbService.getGroupMembers(String(g.username))
      if (!res?.success || !res.members?.length) continue
      const usernames = res.members.map((m) => m.username).filter(Boolean)
      names.push(...usernames)
      try {
        const dn = await wcdbService.getDisplayNames(usernames)
        if (dn?.success && dn.map) names.push(...Object.values(dn.map))
      } catch { /* 名字获取失败不阻断 */ }
      console.log(`[CrmImport] 内部群「${String(g.displayName)}」成员 ${usernames.length} 人`)
    }
  } catch (e) {
    salesLog('WARN', `[CrmImport] 收集内部群成员失败: ${e}`)
  }
  return Array.from(new Set(names.filter(Boolean)))
}

// 往期灵感信箱记录回填导入：按 salesStage 中文标签直接判定，不再调 AI（幂等）
const BACKFILL_STAGE_TO_CRM: Record<string, string> = {
  了解: 'contacted', 比价: 'negotiating', 决策: 'negotiating', 成交: 'won'
}

export function backfillImportFromInsightRecords(
  records: Array<{ sessionId: string; displayName: string; salesStage?: string; createdAt: number }>
): { imported: number; existing: number } {
  let imported = 0
  let existing = 0
  const seen = new Set<string>()
  // 按时间正序，每客户只导入一次（首次有意向记录为准）
  const sorted = [...records].sort((a, b) => a.createdAt - b.createdAt)
  for (const r of sorted) {
    if (!r.sessionId || seen.has(r.sessionId)) continue
    const crmStage = BACKFILL_STAGE_TO_CRM[String(r.salesStage || '')]
    if (!crmStage) continue
    seen.add(r.sessionId)
    try {
      const res = crmDbService.importCustomerFromProfile({
        name: r.displayName,
        sessionId: r.sessionId,
        stage: crmStage,
        reason: `往期灵感信箱回填（${r.salesStage}）`
      })
      if (res.created) imported++
      else existing++
    } catch (e) {
      salesLog('WARN', `[CrmImport] 回填导入失败 ${r.displayName}: ${e}`)
    }
  }
  if (imported + existing > 0) {
    salesLog('INFO', `[CrmImport] 灵感信箱回填导入完成：新建 ${imported}，已存在 ${existing}`)
  }
  return { imported, existing }
}

function parseJudgeResult(text: string): IntentJudgeResult | null {
  try {
    const m = String(text || '').match(/\{[\s\S]*\}/)
    if (!m) return null
    const o = JSON.parse(m[0]) as { hasIntent?: boolean; stage?: string; reason?: string }
    if (typeof o.hasIntent !== 'boolean') return null
    return {
      hasIntent: o.hasIntent,
      stage: ['contacted', 'quoted', 'negotiating', 'won'].includes(String(o.stage || '')) ? String(o.stage) : undefined,
      reason: String(o.reason || '').slice(0, 30)
    }
  } catch { return null }
}

/**
 * AI 画像完成后判定并自动导入 CRM。
 * @returns { imported: 是否导入（含已存在补联动）; hasIntent; reason; skipped: 未判定/未配置时 true }
 */
export async function judgeAndImportCrmCustomer(
  record: InsightProfileRecord,
  config: ConfigService
): Promise<{ imported: boolean; hasIntent: boolean; reason: string; stage?: string; skipped: boolean }> {
  if (!record?.finalProfile) return { imported: false, hasIntent: false, reason: '', skipped: true }
  if (!isAiConfigured(config)) return { imported: false, hasIntent: false, reason: '', skipped: true }
  if (!record.sessionId || record.sessionId.endsWith('@chatroom')) return { imported: false, hasIntent: false, reason: '', skipped: true }

  try {
    const out = await simpleCompletion(
      config,
      INTENT_JUDGE_PROMPT,
      `客户：${record.displayName}\nAI 画像：\n${record.finalProfile.slice(0, 2000)}`,
      { responseFormatJson: true, temperature: 0.2, maxTokens: 200 }
    )
    const judge = parseJudgeResult(out)
    if (!judge || !judge.hasIntent) {
      salesLog('INFO', `[CrmImport] ${record.displayName} 无销售意向，不导入 CRM${judge?.reason ? `（${judge.reason}）` : ''}`)
      return { imported: false, hasIntent: false, reason: judge?.reason || '', skipped: false }
    }
    const res = crmDbService.importCustomerFromProfile({
      name: record.displayName,
      sessionId: record.sessionId,
      stage: judge.stage || 'contacted',
      reason: judge.reason
    })
    salesLog('INFO', `[CrmImport] ${record.displayName} 有意向${judge.stage ? `（${judge.stage}）` : ''}，已导入 CRM（${res.created ? '新建' : '已存在'}）`)
    return { imported: true, hasIntent: true, reason: judge.reason || '', stage: judge.stage, skipped: false }
  } catch (e) {
    salesLog('WARN', `[CrmImport] 意向判定失败 ${record.displayName}: ${e}`)
    return { imported: false, hasIntent: false, reason: '', skipped: true }
  }
}
