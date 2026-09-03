/**
 * types.ts —— Phase 0 D4 迁移脚本骨架 · 统一迁移报告结构
 *
 * ⛔ 铁律（每个迁移模块头部同款声明，Phase 1 写执行器时不许删）：
 *   1. 迁移执行必须走应用自身链路（crmDbService / salesDbService 的 create/update 等方法），
 *      禁止直接改库文件——sql.js 是内存库 + 500ms 防抖落盘，外部直改库文件会被内存库覆盖
 *      （HANDOVER §2.40 分库迁移前科：直改必被冲掉）。
 *   2. 跨库顺序铁律：先 crmDb 后 salesDb（宪法 §2.1；SLA 卡先例）。
 *   3. 骨架阶段（Phase 0 D4，只写不跑）：本目录只提供 dryRun() 只读统计，不写执行函数；
 *      执行器 Phase 1 迁移周落地，届时按本报告结构产出「总数/成功/失败/冲突清单」，
 *      失败条目人工处理窗口 1 周（PRD §9）。
 *   4. 幂等是硬要求：每个模块的 dryRun 必须能识别「已迁移」状态（alreadyDone），
 *      执行器重复跑不得产生第二份数据（宪法 §2.2 迁移铁律：无版本表，全靠幂等双路径）。
 */

/** 迁移条目问题（失败/冲突的逐条记录，任务书要求「逐条失败原因」） */
export interface MigrationItemIssue {
  /** 条目定位键（行 id 或归一化身份键，如 `phone:13800138000`） */
  key: string
  /** 一句话原因（人读，迁移报告直接展示） */
  reason: string
  /** 佐证数据（人读摘要或 JSON 字符串，可选） */
  detail?: string
}

/** 迁移摘要计数（dryRun 与执行器共用同一结构；执行器额外有 applied/failed 实绩） */
export interface MigrationSummary {
  /** 扫描候选总数 */
  total: number
  /** 将迁移条数（dryRun 预演；执行器语义 = 本次实际写入） */
  wouldApply: number
  /** 已迁移（幂等跳过，不重复计） */
  alreadyDone: number
  /** 无需处理（规则显式排除） */
  skipped: number
  /** 预检不通过条数（执行阶段的预期失败，须逐条给原因） */
  failed: number
  /** 冲突条数（需人工裁决，如 §2.4 合并提案） */
  conflicts: number
}

/** 统一迁移报告（PRD §9：总数/成功/失败/冲突清单；dryRun 恒真标记防误用） */
export interface MigrationReport {
  /** 模块标识（文件名去扩展名，如 '01-decision-b-cleanup'） */
  module: string
  /** 人读标题 */
  title: string
  /** 试跑时间（epoch ms） */
  ranAt: number
  /** 试跑库标识（副本路径——骨架阶段绝不出现 live 库路径） */
  dbLabel: string
  /** 骨架阶段恒为 true；执行器产出的报告必须为 false */
  dryRun: true
  summary: MigrationSummary
  /** 逐条失败原因（对应 summary.failed） */
  failures: MigrationItemIssue[]
  /** 冲突清单（对应 summary.conflicts，需人工裁决/合并提案） */
  conflicts: MigrationItemIssue[]
  /** 将迁移抽样预览（≤10 条，key + 人读执行计划） */
  samples: Array<{ key: string; plan: string }>
  /** 规则说明与裁决引用（宪法/PRD 条款号，供迁移报告读者核对口径） */
  notes: string[]
}

/** 汇总多模块摘要（试跑入口打印总表用） */
export function mergeSummaries(list: MigrationSummary[]): MigrationSummary {
  return list.reduce((acc, s) => ({
    total: acc.total + s.total,
    wouldApply: acc.wouldApply + s.wouldApply,
    alreadyDone: acc.alreadyDone + s.alreadyDone,
    skipped: acc.skipped + s.skipped,
    failed: acc.failed + s.failed,
    conflicts: acc.conflicts + s.conflicts
  }), { total: 0, wouldApply: 0, alreadyDone: 0, skipped: 0, failed: 0, conflicts: 0 })
}

/** 单行摘要（控制台打印格式） */
export function fmtSummary(s: MigrationSummary): string {
  return `total=${s.total} wouldApply=${s.wouldApply} alreadyDone=${s.alreadyDone} skipped=${s.skipped} failed=${s.failed} conflicts=${s.conflicts}`
}
