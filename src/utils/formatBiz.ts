/**
 * formatBiz.ts —— 业务展示层通用格式化（商机页与 CRM 交付/售后共用）。
 *
 * 空值口径统一为「未登记」：日期 0/undefined、数量 <= 0 均视作未填写。
 * 「未登记」是业务文案常量，改动需同步两端页面回归。
 */

// 日期（YYYY-MM-DD）；0/空 = 未登记（旧数据空字段统一口径）
export function fmtDate(ms: number | undefined): string {
  const n = Number(ms || 0)
  if (!n) return '未登记'
  const d = new Date(n)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// 数量：0 = 未登记
export function fmtQty(n: number | undefined): string {
  return Number(n) > 0 ? `${Number(n)} 台` : '未登记'
}

// 日期输入（type=date）值 ↔ epoch ms
export function toDateInput(ms: number | undefined): string {
  const n = Number(ms || 0)
  if (!n) return ''
  const d = new Date(n)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function fromDateInput(v: string): number {
  if (!v) return 0
  const t = new Date(`${v}T00:00:00`).getTime()
  return Number.isFinite(t) ? t : 0
}
