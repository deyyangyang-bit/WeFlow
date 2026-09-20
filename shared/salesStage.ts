/**
 * shared/salesStage.ts —— 销售阶段唯一语义源（前后端共用，纯模块零依赖）
 *
 * 归一化语义：DB 存机器语义（英文 canonical），UI 存展示语义（中文档位）。
 * customer_profile.stage / intent_tag_log.stage 混存中英文（classifier 写英文、
 * AI 见解/手动纠正写中文），统一经此模块归一化，消除各处各自理解中英文。
 */

/** 全部 canonical 阶段（DB 与规则层的唯一机器语义） */
export const STAGE_CANONICAL = [
  'new', 'contacted', 'quoted', 'negotiating', 'won', 'lost', 'dormant', 'unknown'
] as const
export type StageCanonical = (typeof STAGE_CANONICAL)[number]

/** 漏斗展示档位（历史累计流转用；流失/未知不参与转化链，单独展示） */
export type FunnelStage = '了解' | '比价' | '决策' | '成交' | '流失' | '未知'
export const FUNNEL_ORDER: FunnelStage[] = ['了解', '比价', '决策', '成交', '流失', '未知']

/** 中文展示名 → canonical（覆盖 insightService/AI/手动纠正全部已知中文写法） */
const CN_TO_CANONICAL: Record<string, StageCanonical> = {
  '新客': 'new',
  '了解': 'contacted', '已沟通': 'contacted',
  '比价': 'quoted', '已报价': 'quoted',
  '决策': 'negotiating', '谈判中': 'negotiating',
  '成交': 'won', '已成交': 'won',
  '流失': 'lost',
  '沉默': 'dormant',
  '未知': 'unknown'
}

/** canonical → 中文展示（对齐 salesReportService 原 STAGE_EN_TO_CN） */
export const CANONICAL_TO_CN: Record<StageCanonical, string> = {
  new: '新客', contacted: '了解', quoted: '比价', negotiating: '决策',
  won: '成交', lost: '流失', dormant: '沉默', unknown: '未知'
}

/** canonical → 漏斗档位（new 并入了解、dormant 并入流失；未知单列） */
export const FUNNEL_BUCKET: Record<StageCanonical, FunnelStage> = {
  new: '了解', contacted: '了解', quoted: '比价', negotiating: '决策',
  won: '成交', lost: '流失', dormant: '流失', unknown: '未知'
}

const isCanonical = (s: string): s is StageCanonical =>
  (STAGE_CANONICAL as readonly string[]).includes(s)

/** 归一化：中文或英文 → canonical（幂等；空/未知 → 'unknown'） */
export function normalizeStage(raw: string | null | undefined): StageCanonical {
  const s = (raw || '').trim()
  if (!s) return 'unknown'
  return CN_TO_CANONICAL[s] ?? (isCanonical(s) ? s : 'unknown')
}

/**
 * 「可识别阶段值」判定（历史覆盖率用，2026-09-20 S2 审查补充）：
 *   - canonical 阶段全部 recognized（含 canonical `unknown`）；
 *   - 已登记中文阶段及别名全部 recognized（含「未知」）；
 *   - null / undefined / 空白字符串 / 未登记任意字符串 → false。
 * 覆盖率统计不得把空值/垃圾值当作阶段事实（normalizeStage 会把它们与合法 unknown
 * 混同为 'unknown'，故覆盖率判定必须用本函数）。复用 CN_TO_CANONICAL 与 canonical
 * 集合保证单一事实源；不改变 normalizeStage / stageToFunnel 的既有兼容行为。
 * 注意用 hasOwnProperty 而非成员访问，避免 'constructor' 等原型链键误判 recognized。
 */
export function isRecognizedStage(raw: string | null | undefined): boolean {
  const s = (raw || '').trim()
  if (!s) return false
  return Object.prototype.hasOwnProperty.call(CN_TO_CANONICAL, s) || isCanonical(s)
}

/** canonical → 中文展示名（当前状态卡片 / 报表标签用） */
export function stageLabel(canonical: StageCanonical): string {
  return CANONICAL_TO_CN[canonical] ?? canonical
}

/** canonical → 漏斗档位 */
export function funnelBucket(canonical: StageCanonical): FunnelStage {
  return FUNNEL_BUCKET[canonical] ?? '未知'
}

/** 一行归一化的漏斗档位（下钻过滤统一比较入口：任意原始 stage → 中文档位） */
export function stageToFunnel(raw: string | null | undefined): FunnelStage {
  return funnelBucket(normalizeStage(raw))
}
