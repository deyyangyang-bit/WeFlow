/**
 * crm-docgen-test.ts —— 文档生成核心单测
 * 运行：npx tsx scripts/crm-docgen-test.ts
 *
 * 覆盖：金额大写、docx 模版渲染（真实 resources/crm-templates 模版）、
 *       quotation/contract/invoice-app 数据装配 + 输出校验（合并单元格/公式/大写）。
 */
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHash } from 'crypto'
import PizZip from 'pizzip'
import ExcelJS from 'exceljs'
import { crmDbService } from '../electron/services/crmDbService'
import { amountToChinese } from '../electron/services/moneyCn'
import { renderDocx, generateDocBuffer, buildPlaceholderTemplate, quotationHashPatch } from '../electron/services/crmDocGenCore'

let pass = 0, fail = 0
const ok = (name: string, cond: boolean): void => { if (cond) pass++; else { fail++; console.error('FAIL:', name) } }

/** 解 docx → 纯文本（去 XML 标签），校验替换结果 */
function docxText(buf: Buffer): string {
  const zip = new PizZip(buf)
  return zip.file('word/document.xml')?.asText().replace(/<[^>]+>/g, '') ?? ''
}

/** 检查某地址是否在合并区域内（ws.model.merges 是 "B3:I3" 范围字符串数组） */
function isMerged(ws: ExcelJS.Worksheet, row: number, col: number): boolean {
  const merges = (ws.model.merges || []) as string[]
  const toRC = (s: string): [number, number] => {
    const m = /^([A-Z]+)(\d+)$/.exec(s) as RegExpExecArray
    let c = 0
    for (const ch of m[1]) c = c * 26 + (ch.charCodeAt(0) - 64)
    return [Number(m[2]), c]
  }
  return merges.some((range) => {
    const [a, b] = range.split(':')
    const [r1, c1] = toRC(a)
    const [r2, c2] = toRC(b)
    return row >= r1 && row <= r2 && col >= c1 && col <= c2
  })
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'docgen-'))
  await crmDbService.initialize(dir)

  // ─── 金额大写 ───────────────────────────────────────────────────────────
  const moneyCases: Array<[number, string]> = [
    [0, '零元整'], [1, '壹元整'], [10, '壹拾元整'], [100, '壹佰元整'], [1001, '壹仟零壹元整'],
    [3500, '叁仟伍佰元整'], [1050, '壹仟零伍拾元整'], [10005, '壹万零伍元整'],
    [12345, '壹万贰仟叁佰肆拾伍元整'], [100000000, '壹亿元整'], [100050000, '壹亿零伍万元整'],
    [100005, '壹拾万零伍元整'],
    [12345.67, '壹万贰仟叁佰肆拾伍元陆角柒分'], [12345.60, '壹万贰仟叁佰肆拾伍元陆角'],
    [12345.06, '壹万贰仟叁佰肆拾伍元零陆分'], [10000.5, '壹万元伍角'], [0.06, '零元零陆分'],
    [-3500, '负叁仟伍佰元整'],
  ]
  for (const [n, expect] of moneyCases) {
    ok(`money ${n}`, amountToChinese(n) === expect)
  }
  ok('money 非法输入', amountToChinese(NaN) === '' && amountToChinese(Infinity) === '')

  // ─── 模版路径 ───────────────────────────────────────────────────────────
  const TEMPLATE_DIR = join(__dirname, '..', 'resources', 'crm-templates')
  const quotationTpl = readFileSync(join(TEMPLATE_DIR, 'quotation.docx'))
  const contractTpl = readFileSync(join(TEMPLATE_DIR, 'contract.docx'))
  ok('tpl quotation exists', quotationTpl.length > 1000)
  ok('tpl contract exists', contractTpl.length > 1000)

  // ─── 纯渲染：报价单 循环展开 + 合计 ────────────────────────────────────
  {
    const buf = renderDocx(quotationTpl, {
      no: 'Q-1', customer: '测试客户A', date: '2026/8/13', total: 6600, footer_remark: '',
      items: [
        { idx: 1, name: '搬运车A', spec: '1吨', qty: 1, unit_price: 3300, subtotal: 3300, remark: '' },
        { idx: 2, name: '搬运车B', spec: '2吨', qty: 1, unit_price: 3300, subtotal: 3300, remark: '' },
      ],
    })
    const text = docxText(buf)
    ok('quotation 无残留标签', !text.includes('{#items}') && !text.includes('{name}') && !text.includes('{total}'))
    ok('quotation 循环展开 2 行', (text.match(/搬运车/g) || []).length === 2)
    ok('quotation 合计', text.includes('6600'))
    ok('quotation 客户', text.includes('测试客户A'))
  }

  // ─── 纯渲染：合同 编号/大写/甲方信息 ───────────────────────────────────
  {
    const buf = renderDocx(contractTpl, {
      no: 'COOFORK-2026081301', buyer_name: '测试客户B',
      buyer_addr: '常州市新北区示例路20号', buyer_bank: '农行常州示例支行',
      buyer_account: '10600000000000001', buyer_tax: '91320411MA1TEST001', buyer_phone: '051988888888',
      sign_date: '2026年8月13日', total: 3500, amount_cn: '叁仟伍佰元整',
      items: [{ name: '步行式电动搬运车', spec: '1吨', unit: '台', qty: 1, unit_price: 3500, amount: 3500, remark: '' }],
    })
    const text = docxText(buf)
    ok('contract 无残留标签', !text.includes('{no}') && !text.includes('{amount_cn}') && !text.includes('{#items}'))
    ok('contract 编号', text.includes('COOFORK-2026081301'))
    ok('contract 大写', text.includes('叁仟伍佰元整'))
    ok('contract 甲方地址', text.includes('示例路20号'))
    ok('contract 甲方税号', text.includes('91320411MA1TEST001'))
    ok('contract 行项', text.includes('步行式电动搬运车'))
    ok('contract 乙方固定', text.includes('无锡库叉搬运设备有限公司'))
  }

  // ─── 端到端：数据库装配 + 生成（quotation/contract/invoice-app）─────────
  {
    const pid = crmDbService.create('product', {
      model: 'X1c-Li', name: '步行式电动搬运车', spec: '', material: '2吨',
      specs: '{"颜色":"黑黄","电压":"48V"}', sku: '005.050', unit_price: 3500, created_at: Date.now(),
    })
    const aid = crmDbService.create('account', { name: '常州示例链轮有限公司', created_at: Date.now(), updated_at: Date.now() })
    const cid = crmDbService.create('contract', {
      account_id: aid, name: '常州示例链轮有限公司-合同', amount: 3500, status: 'signed',
      sign_date: Date.now(),
      custom_fields: JSON.stringify({
        buyer_addr: '常州市新北区示例路20号', buyer_bank: '农行常州示例支行',
        buyer_account: '10600000000000001', tax_no: '91320411MA1TEST001', buyer_phone: '051988888888',
      }),
      created_at: Date.now(), updated_at: Date.now(),
    })
    const qr = crmDbService.createQuotation({ contract_id: cid, items: [{ product_id: pid, qty: 1 }] })
    ok('seed quotation', qr.ok && typeof qr.id === 'number')
    const qid = qr.id as number
    const iid = crmDbService.create('invoice', {
      contract_id: cid, account_id: aid, buyer: '常州示例链轮有限公司',
      amount: 3500, status: 'pre_issue', invoice_date: Date.now(), created_at: Date.now(),
    })

    // quotation
    const qRes = await generateDocBuffer('quotation', qid, quotationTpl)
    ok('generate quotation ok/docx', qRes.ok && qRes.ext === 'docx' && qRes.entity === 'quotation')
    if (qRes.ok) {
      const text = docxText(qRes.buffer)
      ok('quo 客户名', text.includes('常州示例链轮有限公司'))
      ok('quo 规格拼装', text.includes('颜色:黑黄'))
      ok('quo 型号', text.includes('X1c-Li'))
      ok('quo 无标签', !text.includes('{'))
    }

    // contract
    const cRes = await generateDocBuffer('contract', cid, contractTpl)
    ok('generate contract ok/docx', cRes.ok && cRes.ext === 'docx' && cRes.entity === 'contract')
    if (cRes.ok) {
      const text = docxText(cRes.buffer)
      ok('contract COOFORK 编号', /COOFORK-\d{8}\d{2}/.test(text))
      ok('contract 大写', text.includes('叁仟伍佰元整'))
      ok('contract 甲方税号', text.includes('91320411MA1TEST001'))
      ok('contract 甲方电话', text.includes('051988888888'))
      ok('contract 型号', text.includes('X1c-Li'))
      ok('contract 无标签', !text.includes('{'))
    }

    // invoice-info：attachment_path 应落 invoice 行（entity=invoice），不是 contract
    {
      const r = await generateDocBuffer('invoice-info', iid, buildPlaceholderTemplate('invoice-info'))
      ok('generate invoice-info ok/entity=invoice', r.ok && r.entity === 'invoice' && r.ext === 'docx')
    }

    // invoice-app（Excel）
    const iRes = await generateDocBuffer('invoice-app', iid)
    ok('generate invoice-app ok/xlsx', iRes.ok && iRes.ext === 'xlsx' && iRes.entity === 'invoice')
    if (iRes.ok) {
      const wb = new ExcelJS.Workbook()
      await wb.xlsx.load(iRes.buffer as never)
      const ws = wb.getWorksheet('开票申请')
      if (ws) {
        ok('xlsx 标题', ws.getCell('B3').value === '无锡库叉搬运设备有限公司开票申请单')
        ok('xlsx 开票单位', ws.getCell('C5').value === '常州示例链轮有限公司')
        ok('xlsx 税号', ws.getCell('H5').value === '91320411MA1TEST001')
        ok('xlsx 合计大写', ws.getCell('C14').value === '叁仟伍佰元整')
        ok('xlsx 总额公式', JSON.stringify(ws.getCell('I9').value).includes('H9*G9'))
        ok('xlsx 小写合计公式', JSON.stringify(ws.getCell('H14').value).includes('SUM'))
        ok('xlsx 商品编码', ws.getCell('B9').value === '005.050')
        ok('xlsx 商品名称', ws.getCell('C9').value === '步行式电动搬运车')
        ok('xlsx 规格', String(ws.getCell('E9').value).includes('颜色:黑黄'))
        ok('xlsx 单位台', ws.getCell('F9').value === '台')
        ok('xlsx 数量', ws.getCell('G9').value === 1)
        ok('xlsx 单价', ws.getCell('H9').value === 3500)
        ok('xlsx 标题合并 B3:I3', isMerged(ws, 3, 2) && isMerged(ws, 3, 9))
        ok('xlsx 名称合并 C:D', isMerged(ws, 9, 3) && isMerged(ws, 9, 4) && !isMerged(ws, 9, 5))
        ok('xlsx 大写合并 C14:E14', isMerged(ws, 14, 3) && isMerged(ws, 14, 5))
        ok('xlsx 小写合并 H14:I14', isMerged(ws, 14, 8) && isMerged(ws, 14, 9))
        ok('xlsx 汇款单位名称', ws.getCell('B17').value === '汇款单位名称' && ws.getCell('C17').value === '常州示例链轮有限公司')
        ok('xlsx 备注', String(ws.getCell('B18').value).includes('务必清晰无误'))
        ok('xlsx 填表人', ws.getCell('I19').value === '杨青')
        ok('xlsx 款项来源', ws.getCell('I15').value === '对公转账')
      } else {
        ok('xlsx sheet 存在', false)
      }
    }
  }

  // ─── 报价产物存证（宪法 §1.6 修订 2026-09-09）：SHA-256 + artifact_hash/pdf_hash 映射 ───
  {
    const hid = crmDbService.create('product', { model: 'HASH-1', name: '存证测试车', unit_price: 1000, specs: '{}', variants: '[]', created_at: Date.now() })
    const hAcc = crmDbService.create('account', { name: '存证测试公司', created_at: Date.now(), updated_at: Date.now() })
    const hCid = crmDbService.create('contract', { account_id: hAcc, name: '存证测试-合同', amount: 1000, status: 'pending_sign', created_at: Date.now(), updated_at: Date.now() })
    const hq1 = crmDbService.createQuotation({ contract_id: hCid, items: [{ product_id: hid, qty: 1 }] })
    ok('chain v1 创建', hq1.ok)
    // 同合同连续创建第二个报价 → 版本链递增（append-only）
    const hq2 = crmDbService.createQuotation({ contract_id: hCid, items: [{ product_id: hid, qty: 2 }] })
    ok('chain v2 递增', hq2.ok && Number(crmDbService.getById('quotation', hq2.id as number)?.version) === 2)
    ok('chain v1 已被关闭', Number(crmDbService.getById('quotation', hq1.id as number)?.effective_to) > 0)
    // 历史版本渲染仍是只读操作（生成不落库，写回哈希才会被 update 守卫拦截）
    const rHist = await generateDocBuffer('quotation', hq1.id as number, quotationTpl)
    ok('历史版本渲染不受限（写回层负责只读守卫）', rHist.ok)
    const rCur = await generateDocBuffer('quotation', hq2.id as number, quotationTpl)
    ok('generate quotation v2 ok', rCur.ok)
    if (rCur.ok) {
      ok('docgen 产物带 SHA-256（64 位 hex）', typeof rCur.sha256 === 'string' && /^[0-9a-f]{64}$/.test(rCur.sha256))
      ok('docgen SHA-256 与 buffer 重算一致', rCur.sha256 === createHash('sha256').update(rCur.buffer).digest('hex'))
    }
    ok('DOCX 产物 → artifact_hash', JSON.stringify(quotationHashPatch('docx', 'h1')) === JSON.stringify({ artifact_hash: 'h1' }))
    ok('真实 PDF → pdf_hash', JSON.stringify(quotationHashPatch('pdf', 'h2')) === JSON.stringify({ pdf_hash: 'h2' }))
    ok('xlsx 等非 PDF 产物归 artifact_hash', JSON.stringify(quotationHashPatch('xlsx', 'h3')) === JSON.stringify({ artifact_hash: 'h3' }))
  }

  // ─── 未知类型 ───────────────────────────────────────────────────────────
  {
    const r = await generateDocBuffer('bogus', 1)
    ok('未知类型拒绝', !r.ok)
  }

  console.log(`\nPASS ${pass} / ${fail} FAILED`)
  process.exit(fail ? 1 : 0)
}

void main()
