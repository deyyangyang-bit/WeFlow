/**
 * salesInsightWrite.ts —— AI 见解阶段判断的写路径（P0-2A.4）
 *
 * insightService 解析出「【阶段：X】」后，对客户画像的写行为只允许：
 *   ① customer_profile 建档/改名（display_name）—— 不再写 stage
 *   ② intent_tag_log 写入 AI 判断记录（source='ai'，confidence=0.7）—— 作为 signal 保留
 *
 * stage 当前值由合法写者维护（classifier / 人工纠正 / deal rule / 建档默认 unknown）。
 *
 * 独立成模块的原因：不依赖 Electron，测试（scripts/insight-stage-ban-test.ts）
 * 可在 node/tsx 下直接加载并验证写路径；任何重新引入 stage 写入都会导致测试失败。
 */
import { salesDbService } from './salesDbService'

/**
 * 应用 AI 解析出的阶段判断：只建档/改名 + 写 signal，禁止覆盖 customer_profile.stage。
 * @param sessionId 客户会话 ID
 * @param displayName 客户显示名（建档/改名用）
 * @param parsedStage AI 解析出的阶段（仅写入 intent_tag_log，不写 customer_profile.stage）
 */
export function applyParsedStageSignal(sessionId: string, displayName: string, parsedStage: string): void {
  try {
    // 省略 stage 字段：已有客户保留原阶段，新客户建档为 unknown（绝不落 AI 解析的阶段）
    salesDbService.customerUpsert({ session_id: sessionId, display_name: displayName })
    // AI signal 保留：阶段判断记录仍写 intent_tag_log，供 read model stateMeta / 历史追踪使用
    salesDbService.intentCreate({ session_id: sessionId, stage: parsedStage, source: 'ai', confidence: 0.7, reason: '见解扫描自动识别' })
  } catch { /* salesDb 未初始化时忽略 */ }
}
