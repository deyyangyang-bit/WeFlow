/**
 * productImportMapper.ts —— 产品导入映射器（纯函数，可单测）
 * 三种格式自适应：外调9列(含变体行合并) / 新11列 / 旧5列。
 */
export interface MappedProduct {
  model: string
  sku: string
  name: string
  category: string
  subcategory: string
  unit_price: number
  cost_price: number
  reference_price: number
  moq: number
  material: string
  description: string
  specs: string
  variants: string
}

const cell = (v: unknown): string => (v == null ? '' : String(v).trim())
const num = (v: unknown): number => {
  const n = parseFloat(cell(v).replace(/[,，]/g, ''))
  return Number.isFinite(n) ? n : 0
}

/** 富文本价格提取：「2T: ¥11,000」「¥4,600 - ¥4,800」「20AH: ¥9,000」→ 第一个金额；纯数字直取；面议类→0 */
export function parsePriceText(v: unknown): number {
  const t = cell(v)
  if (!t) return 0
  const m = t.match(/¥\s*([\d,]+(?:\.\d+)?)/)
  if (m) return parseFloat(m[1].replace(/,/g, ''))
  if (/^[\d,]+(?:\.\d+)?$/.test(t)) return parseFloat(t.replace(/,/g, ''))
  return 0
}

function findHeader(matrix: unknown[][], keys: string[], scan = 12): number {
  for (let i = 0; i < Math.min(scan, matrix.length); i++) {
    const row = (matrix[i] || []).map(cell).join('|')
    if (keys.every((k) => row.includes(k))) return i
  }
  return -1
}

function colOf(header: unknown[], key: string): number {
  return (header || []).findIndex((h) => cell(h).includes(key))
}

export function mapProductMatrix(matrix: unknown[][]): MappedProduct[] {
  const extHeaderIdx = findHeader(matrix, ['车型名称', '额定载荷'])
  if (extHeaderIdx >= 0) return mapExternal(matrix, extHeaderIdx)
  const newHeaderIdx = findHeader(matrix, ['型号', '名称'])
  if (newHeaderIdx >= 0) {
    const header = matrix[newHeaderIdx].map(cell)
    if (header.some((h) => h.includes('成本')) || header.some((h) => h.includes('SKU'))) {
      return mapNew11(matrix.slice(newHeaderIdx + 1))
    }
    return mapOld5(matrix.slice(newHeaderIdx + 1))
  }
  return mapOld5(matrix)
}

// ─── 外调9列：变体行合并（同 车型名称+额定载荷 为一产品）───────────────────
function mapExternal(matrix: unknown[][], headerIdx: number): MappedProduct[] {
  const header = matrix[headerIdx]
  const iName = colOf(header, '车型名称')
  const iFunc = colOf(header, '主要功能')
  const iLoad = colOf(header, '额定载荷')
  const iSize = colOf(header, '车身尺寸')
  const iLift = colOf(header, '举升高度')
  const iBatt = colOf(header, '电池配置')
  const iMast = colOf(header, '门架')
  const iPrice = colOf(header, '参考价')
  const byKey = new Map<string, MappedProduct>()
  const order: MappedProduct[] = []
  for (const row of matrix.slice(headerIdx + 1)) {
    const name = cell(row[iName])
    if (!name) continue
    const load = cell(row[iLoad])
    const key = `${name}|${load}`
    let p = byKey.get(key)
    const lift = cell(row[iLift])
    const priceRaw = cell(row[iPrice])
    const priceNum = parsePriceText(row[iPrice])
    if (!p) {
      p = {
        model: '', sku: '', name, category: '外调车型', subcategory: '',
        unit_price: 0, cost_price: 0, reference_price: priceNum, moq: 1,
        material: '', description: '',
        specs: JSON.stringify({
          '主要功能': cell(row[iFunc]), '额定载荷': load, '车身尺寸': cell(row[iSize]),
          '电池配置': cell(row[iBatt]), '门架定制': cell(row[iMast])
        }),
        variants: '[]'
      }
      byKey.set(key, p)
      order.push(p)
    }
    if (p.reference_price <= 0 && priceNum > 0) p.reference_price = priceNum
    if (lift || priceRaw) {
      const variants = JSON.parse(p.variants) as Array<{ param: string; price: number; raw: string }>
      variants.push({ param: lift, price: priceNum, raw: priceRaw })
      p.variants = JSON.stringify(variants)
    }
  }
  return order
}

// ─── 新11列 ─────────────────────────────────────────────────────────────────
function mapNew11(rows: unknown[][]): MappedProduct[] {
  return rows
    .filter((r) => cell(r[0]) || cell(r[2]))
    .map((r) => ({
      model: cell(r[0]), sku: cell(r[1]), name: cell(r[2]), category: cell(r[3]) || '未分类',
      subcategory: cell(r[4]), unit_price: num(r[5]), cost_price: num(r[6]),
      reference_price: num(r[7]), moq: num(r[8]) || 1, material: cell(r[9]),
      description: cell(r[10]), specs: '{}', variants: '[]'
    }))
}

// ─── 旧5列 ─────────────────────────────────────────────────────────────────
function mapOld5(rows: unknown[][]): MappedProduct[] {
  return rows
    .filter((r) => cell(r[0]) || cell(r[1]))
    .map((r) => ({
      model: cell(r[0]), sku: '', name: cell(r[1]), category: cell(r[4]) || '未分类',
      subcategory: '', unit_price: num(r[3]), cost_price: 0, reference_price: 0,
      moq: 1, material: cell(r[2]), description: '', specs: '{}', variants: '[]'
    }))
}
