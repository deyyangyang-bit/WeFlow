/** Currency comparison shared by the editor and the transactional audit writer. */
export function isPriceOverride(catalogPrice: unknown, quotedPrice: unknown): boolean {
  if (quotedPrice == null || String(quotedPrice).trim() === '') return false
  const catalog = Number(catalogPrice), quoted = Number(quotedPrice)
  return Number.isFinite(catalog) && Number.isFinite(quoted) && quoted >= 0 && Math.round(catalog * 100) !== Math.round(quoted * 100)
}
export function quoteRowError(row: { qty: unknown; unit_price: unknown }): string | null {
  if (String(row.qty ?? '').trim() === '' || !Number.isSafeInteger(Number(row.qty)) || Number(row.qty) <= 0) return '数量必须是正整数'
  if (String(row.unit_price ?? '').trim() === '' || !Number.isFinite(Number(row.unit_price)) || Number(row.unit_price) < 0) return '单价必须是非负有限数字'
  if (!Number.isSafeInteger(Math.round(Number(row.qty) * Number(row.unit_price) * 100))) return '报价金额超出可用范围'
  return null
}
export interface PriceOverride { product_id: number; model: string; catalog_unit_price: number; quoted_unit_price: number }
