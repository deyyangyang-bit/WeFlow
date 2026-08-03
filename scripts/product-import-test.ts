/**
 * product-import-test.ts —— 真实外调 xlsx 导入映射测试
 * 运行：npx tsx scripts/product-import-test.ts
 */
import * as ExcelJS from 'exceljs'
import { mapProductMatrix } from '../src/utils/productImportMapper'

const XLSX_PATH = '/Users/yang/Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files/wxid_wen24wq8ojio22_92a6/temp/RWTemp/2026-03/7e57fd7c9892bd2c65d5ef67d5c1e9b0/外调车型报价单-工业车辆系列(1).xlsx'

async function main(): Promise<void> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(XLSX_PATH)
  const ws = wb.worksheets[0]
  const matrix: unknown[][] = []
  ws.eachRow((row) => {
    matrix.push(Array.isArray(row.values) ? (row.values as unknown[]).slice(1) : [])
  })

  const products = mapProductMatrix(matrix)
  let pass = 0, fail = 0
  const ok = (name: string, cond: boolean): void => { if (cond) pass++; else { fail++; console.error('FAIL:', name) } }

  ok('merged < raw rows', products.length > 5 && products.length < 40)
  ok('category=外调车型', products.every((p) => p.category === '外调车型'))
  ok('仅面议车型允许0价', products.filter((p) => p.reference_price <= 0).length <= 1)
  ok('首组4950', products[0].reference_price === 4950)
  const manual = products.find((p) => p.name.includes('手动搬运车'))
  ok('富文本价格2T:¥620→620', !!manual && manual.reference_price === 620)
  const custom = products.find((p) => p.name.includes('3T定制'))
  ok('区间价¥4,600-4,800→4600', !!custom && custom.reference_price === 4600)
  const cbd = products.find((p) => p.name.includes('CBD'))
  ok('CBD variants>=2', !!cbd && (JSON.parse(cbd.variants) as Array<{ param: string }>).length >= 2)
  const specs = cbd ? JSON.parse(cbd.specs) as Record<string, string> : {}
  ok('specs 电池配置', Object.keys(specs).includes('电池配置'))
  // 新11列 / 旧5列 合成样本
  const n11 = mapProductMatrix([['型号','SKU','名称','类目','小分类','单价','成本','参考','起订量','材质','描述'], ['T02C','S1','电动一体杆2吨','手动改装套件','','8000','5000','9000','1','合金','测试']])
  ok('11col map', n11.length === 1 && n11[0].cost_price === 5000 && n11[0].category === '手动改装套件')
  const o5 = mapProductMatrix([['T02C','电动一体杆','41kg','8000','套件']])
  ok('5col map', o5.length === 1 && o5[0].material === '41kg' && o5[0].category === '套件')

  console.log(`IMPORT RESULT: products=${products.length} pass=${pass} fail=${fail}`)
  if (fail > 0) process.exit(1)
}
void main()
