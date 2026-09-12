/**
 * evalExport.ts —— 评测标注结果导出（纯函数，主进程与渲染层共用）
 *
 * 用途：把人工已确认（status=confirmed）的商机评测样本导成 CSV，供主管复核与归档。
 * 纯函数约束（同 shared/messageKey.ts）：不依赖 Electron、不读 DB、无副作用。
 *
 * PIPL（宪法 §1.10）：导出只含标注结论与锚点引用，**不含聊天原文**
 * （evidence_text 不出库；需要看原话按 anchor_key 经证据链回查）。
 */

/** 导出所需的最小行形状（OpportunityEvalCase / EvalCaseRow 均满足） */
export interface EvalExportRow {
  session_id: string
  display_name?: string
  source?: string
  status?: string
  label?: string
  annotated_by?: string
  updated_at?: number
  anchor_key?: string
  evidence_message_keys?: string
  ai_label?: string
}

/** 商机三档中文（与 EvalAnnotatePage.LABEL_TEXT 同口径） */
const LABEL_TEXT: Record<string, string> = { has: '有商机', none: '无商机', uncertain: '不确定' }

/** CSV 列头（固定顺序；改列头会破坏下游脚本解析，勿随意调整） */
export const EVAL_EXPORT_COLUMNS = [
  'session_id', 'display_name', 'source', 'label', 'label_text',
  'annotated_by', 'annotated_at', 'anchor_key', 'evidence_message_keys', 'ai_label', 'agree'
] as const

/** CSV 单元格转义：含逗号/引号/换行时整体加引号，内部引号翻倍（RFC 4180） */
function csvCell(value: unknown): string {
  const s = String(value ?? '')
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** 毫秒时间戳 → 本地 `YYYY-MM-DD HH:mm:ss`；无效值返回空串（不写 NaN） */
function formatTime(ms: unknown): string {
  const n = Number(ms)
  if (!Number.isFinite(n) || n <= 0) return ''
  const d = new Date(n)
  const p = (v: number) => String(v).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/**
 * 导出 CSV 文本。
 * @param rows 全量候选行（函数内部只取 status=confirmed 的人工确认行）
 * @returns CSV 文本；无已确认行时只有表头 + 末行换行
 */
export function buildEvalCasesCsv(rows: EvalExportRow[]): string {
  const confirmed = rows.filter((r) => String(r.status || '') === 'confirmed')
  const lines: string[] = [EVAL_EXPORT_COLUMNS.join(',')]
  for (const r of confirmed) {
    const label = String(r.label || '')
    const ai = String(r.ai_label || '')
    lines.push([
      r.session_id,
      r.display_name || '',
      r.source || '',
      label,
      LABEL_TEXT[label] || label,
      r.annotated_by || '',
      formatTime(r.updated_at),
      r.anchor_key || '',
      r.evidence_message_keys || '',
      ai,
      // 比对结论：无 AI 预标注时留空，避免把「没比对」写成「不一致」
      ai ? (label === ai ? '一致' : '不一致') : ''
    ].map(csvCell).join(','))
  }
  return lines.join('\n') + '\n'
}

/** 已确认（可导出）行数——UI 用来决定按钮是否可用与提示数量 */
export function countConfirmed(rows: EvalExportRow[]): number {
  return rows.filter((r) => String(r.status || '') === 'confirmed').length
}
