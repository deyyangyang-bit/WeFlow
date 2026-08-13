/**
 * crmDocGenCore.ts —— docgen 纯逻辑核心（零 electron 依赖，可 tsx 单测）。
 * 职责：数据装配（crmDbService）+ docx 渲染（docxtemplater）+ 开票申请 Excel（exceljs）。
 * crmDocGenService.ts 仅做 electron 侧的模板路径解析 / 落盘 / 写回 attachment_path。
 */
import PizZip from 'pizzip'
import Docxtemplater from 'docxtemplater'
import ExcelJS from 'exceljs'
import { crmDbService, type CrmRow } from './crmDbService'
import { amountToChinese } from './moneyCn'

export const DOC_TYPES = ['quotation', 'contract', 'invoice-info', 'invoice-app'] as const
export type DocType = (typeof DOC_TYPES)[number]

export type DocgenResult =
  | { ok: true; buffer: Buffer; ext: 'docx' | 'xlsx'; entity: string; entityId: number }
  | { ok: false; reason: string }

// ── 工具 ────────────────────────────────────────────────────────────────
function parseItems(json?: string | null): CrmRow[] {
  try { return JSON.parse(String(json || '[]')) as CrmRow[] } catch { return [] }
}

function parseFields(json?: string | null): Record<string, string> {
  try { return JSON.parse(String(json || '{}')) as Record<string, string> } catch { return {} }
}

/** 时间戳（秒或毫秒）→ 中文日期，空返回 '' */
function fmtDate(ts: number | string | null | undefined): string {
  if (!ts) return ''
  const n = Number(ts)
  if (!n || !isFinite(n)) return ''
  const ms = n < 1e12 ? n * 1000 : n // 秒 vs 毫秒 兼容
  const d = new Date(ms)
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
}

/** 时间戳 → YYYYMMDD（合同编号用） */
function yyyymmdd(ts: number | string | null | undefined): string {
  if (!ts) return ''
  const n = Number(ts)
  if (!n || !isFinite(n)) return ''
  const ms = n < 1e12 ? n * 1000 : n
  const d = new Date(ms)
  const p = (x: number): string => String(x).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
}

/** 行项展示规格：型号前置 + 参数（复刻真实模版「X1D-LI\n48v10ah」），无型号时只回参数 */
function itemSpec(it: CrmRow): string {
  const spec = String(it.spec_summary || it.spec || '')
  const model = String(it.model || '')
  return model ? [model, spec].filter(Boolean).join('\n') : spec
}

// ── 数据装配（纯 crmDbService，无 electron）──────────────────────────────
function buildQuotationData(recordId: number): CrmRow {
  const q = crmDbService.getById('quotation', recordId)
  if (!q) throw new Error('报价单不存在')
  const c = q.contract_id ? crmDbService.getById('contract', Number(q.contract_id)) : null
  const acc = c ? crmDbService.getById('account', Number(c.account_id)) : null
  const items = parseItems(String(q.items))
  return {
    no: `Q-${recordId}`,
    customer: acc?.name ?? '',
    date: new Date().toLocaleDateString('zh-CN'),
    total: q.total,
    items: items.map((it, i) => ({
      idx: i + 1,
      name: it.name ?? '',
      spec: itemSpec(it),
      qty: it.qty,
      unit_price: it.unit_price,
      subtotal: it.subtotal,
      remark: it.remark ?? '',
    })),
  }
}

function buildContractData(recordId: number): CrmRow {
  const c = crmDbService.getById('contract', recordId)
  if (!c) throw new Error('合同不存在')
  const acc = c.account_id ? crmDbService.getById('account', Number(c.account_id)) : null
  const cf = parseFields(c.custom_fields)
  const quots = crmDbService.list('quotation', { contract_id: recordId })
  const items = quots.flatMap((q) => parseItems(String(q.items)))
  const total = Math.round(items.reduce((s, it) => s + Number(it.subtotal || 0), 0) * 100) / 100
  const dateMs = Number(c.sign_date || c.created_at || Date.now())
  return {
    no: `COOFORK-${yyyymmdd(dateMs)}${String(recordId).padStart(2, '0')}`,
    buyer_name: acc?.name ?? '',
    buyer_addr: cf.buyer_addr ?? '',
    buyer_bank: cf.buyer_bank ?? '',
    buyer_account: cf.buyer_account ?? '',
    buyer_tax: cf.tax_no ?? '',
    buyer_phone: cf.buyer_phone ?? '',
    sign_date: fmtDate(dateMs),
    total,
    amount: c.amount,
    amount_cn: amountToChinese(total),
    items: items.map((it) => ({
      name: it.name ?? '',
      spec: itemSpec(it),
      unit: it.unit ?? '台',
      qty: it.qty,
      unit_price: it.unit_price,
      amount: it.subtotal,
      remark: it.remark ?? '',
    })),
    items_text: items.map((it) => `${it.model}×${it.qty}`).join('；'),
  }
}

function buildInvoiceAppData(recordId: number): CrmRow {
  const inv = crmDbService.getById('invoice', recordId)
  if (!inv) throw new Error('发票记录不存在')
  const c = inv.contract_id ? crmDbService.getById('contract', Number(inv.contract_id)) : null
  const cf = c ? parseFields(c.custom_fields) : {}
  const quots = c ? crmDbService.list('quotation', { contract_id: Number(c.id) }) : []
  const rows = quots.flatMap((q) => parseItems(String(q.items))).map((it) => {
    const p = it.product_id ? crmDbService.getById('product', Number(it.product_id)) : null
    return {
      sku: p?.sku ?? '',
      name: it.name ?? '',
      spec: itemSpec(it),
      unit: it.unit ?? '台',
      qty: it.qty,
      unit_price: it.unit_price,
      amount: it.subtotal,
    }
  })
  const amount = Number(inv.amount || 0)
  return {
    buyer: inv.buyer ?? '',
    tax_no: cf.tax_no ?? '',
    date: fmtDate(inv.invoice_date || inv.created_at),
    amount_cn: amountToChinese(amount),
    amount,
    source: '对公转账',
    items: rows,
  }
}

/** invoice-info 沿用旧字段（买家抬头/税号/开户行/账号/金额/项目） */
function buildInvoiceInfoData(recordId: number): CrmRow {
  const inv = crmDbService.getById('invoice', recordId)
  if (!inv) throw new Error('发票记录不存在')
  const c = inv.contract_id ? crmDbService.getById('contract', Number(inv.contract_id)) : null
  const cf = c ? parseFields(c.custom_fields) : {}
  const quots = c ? crmDbService.list('quotation', { contract_id: Number(c.id) }) : []
  const items = quots.flatMap((q) => parseItems(String(q.items)))
  return {
    buyer: inv.buyer ?? '',
    tax_no: cf.tax_no ?? '',
    bank: cf.buyer_bank ?? cf.bank ?? '',
    bank_account: cf.buyer_account ?? cf.bank_account ?? '',
    amount: inv.amount,
    items_text: items.map((it) => `${it.name ?? it.model}×${it.qty}`).join('；'),
  }
}

// ── docx 渲染 ─────────────────────────────────────────────────────────────
export function renderDocx(templateBuf: Buffer, data: Record<string, unknown>): Buffer {
  const zip = new PizZip(templateBuf)
  const doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true })
  doc.render(data)
  return doc.getZip().generate({ type: 'nodebuffer' })
}

// ── 占位模版（模版缺失时的兜底，简单文本版）──────────────────────────────
function minimalDocxXml(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${body}<w:sectPr/></w:body></w:document>`
}

function para(text: string): string {
  return `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`
}

/** 占位 docx 模版（invoice-app 为 Excel 类型，无需占位） */
export function buildPlaceholderTemplate(type: DocType): Buffer {
  let body = ''
  if (type === 'quotation') {
    body = para('报价单 NO.{no}') + para('客户：{customer}') + para('日期：{date}') +
      para('{#items}') + para('{idx} {name} {spec} 数量{qty} 单价{unit_price} 小计{subtotal} {remark}') + para('{/items}') +
      para('合计：{total}')
  } else if (type === 'contract') {
    body = para('购销合同 NO.{no}') + para('甲方（买方）：{buyer_name}') + para('签订日期：{sign_date}') + para('金额：{amount}') +
      para('甲方信息 地址{buyer_addr} 开户行{buyer_bank} 账号{buyer_account} 税号{buyer_tax} 电话{buyer_phone}') +
      para('{#items}') + para('{name} {spec} {unit} 数量{qty} 单价{unit_price} 金额{amount} {remark}') + para('{/items}') +
      para('合计：{total} 大写：{amount_cn}') + para('项目：{items_text}')
  } else {
    body = para('开票信息单') + para('抬头：{buyer}') + para('税号：{tax_no}') + para('开户行：{bank}') + para('账号：{bank_account}') + para('金额：{amount}') + para('项目：{items_text}')
  }
  const zip = new PizZip()
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`)
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`)
  zip.file('word/document.xml', minimalDocxXml(body))
  return zip.generate({ type: 'nodebuffer' })
}

// ── 开票申请 Excel（复刻「样板」sheet 布局）──────────────────────────────
const FONT = { name: '宋体' }
const THIN = { style: 'thin' } as const
const MEDIUM = { style: 'medium' } as const
type BorderStyle = 'thin' | 'medium'

function cellBorder(left: BorderStyle): Record<string, unknown> {
  return { top: THIN, bottom: THIN, left: { style: left }, right: THIN }
}

export async function buildInvoiceAppWorkbook(data: CrmRow): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('开票申请')
  // 列宽（样板 A=2.9 B=13.4 C=8.9 D=10.8 E=27.5 F=8.8 G=13.1 H=13.4 I=23.9）
  ;[2.9, 13.4, 8.9, 10.8, 27.5, 8.8, 13.1, 13.4, 23.9].forEach((w, i) => { ws.getColumn(i + 1).width = w })

  const items = (data.items as CrmRow[]) || []
  const n = Math.max(5, items.length) // 明细区固定 5 行（样板），超 5 行向下顺延
  const itemStart = 9
  const totalRow = itemStart + n // n=5 → r14，与样板一致
  const lastItemRow = itemStart + n - 1

  // 行高（样板值）
  const heights: Record<number, number> = {
    3: 34, 4: 39, 5: 24.95, 6: 12, 7: 3, 8: 23.1,
    [totalRow]: 27, [totalRow + 1]: 17.1, [totalRow + 2]: 17.1,
    [totalRow + 3]: 23.1, [totalRow + 4]: 18, [totalRow + 5]: 21.95,
  }
  for (const [r, h] of Object.entries(heights)) ws.getRow(Number(r)).height = h
  for (let r = itemStart; r < itemStart + n; r++) ws.getRow(r).height = 23.1

  // 标题 r3
  ws.mergeCells('B3:I3')
  const title = ws.getCell('B3')
  title.value = '无锡库叉搬运设备有限公司开票申请单'
  title.font = { name: '宋体', size: 16, bold: true }
  title.alignment = { horizontal: 'center', vertical: 'center' }
  // 日期 r4
  ws.mergeCells('B4:I4')
  const dateCell = ws.getCell('B4')
  dateCell.value = `日期 ：${data.date}`
  dateCell.font = { name: '宋体', size: 10 }
  dateCell.alignment = { horizontal: 'center', vertical: 'center' }
  // r5 开票单位 + 税号
  ws.getCell('B5').value = '开票单位名称：'
  ws.mergeCells('C5:D5')
  ws.getCell('C5').value = data.buyer
  ws.mergeCells('F5:G5')
  ws.getCell('F5').value = '纳税人识别号：'
  ws.getCell('H5').value = data.tax_no
  for (const addr of ['B5', 'C5', 'F5', 'H5']) {
    ws.getCell(addr).font = { name: '宋体', size: 10 }
    ws.getCell(addr).alignment = { horizontal: 'center', vertical: 'center' }
  }

  // 表头 r8
  ws.getCell('B8').value = '商品编码'
  ws.mergeCells('C8:D8'); ws.getCell('C8').value = '商品名称'
  ws.getCell('E8').value = '规格型号'
  ws.getCell('F8').value = '单位'
  ws.getCell('G8').value = '数量'
  ws.getCell('H8').value = '单价'
  ws.getCell('I8').value = '总额'
  for (const c of ['B8', 'C8', 'E8', 'F8', 'G8', 'H8', 'I8']) {
    ws.getCell(c).font = { name: '宋体', size: 11 }
    ws.getCell(c).alignment = { horizontal: 'center', vertical: 'center' }
  }

  // 明细 r9..，只写用到的行；总额 = 单价×数量 公式
  items.forEach((it, i) => {
    const r = itemStart + i
    ws.mergeCells(`C${r}:D${r}`)
    ws.getCell(`B${r}`).value = it.sku ?? ''
    ws.getCell(`C${r}`).value = it.name ?? ''
    ws.getCell(`E${r}`).value = it.spec ?? ''
    ws.getCell(`F${r}`).value = it.unit ?? '台'
    ws.getCell(`G${r}`).value = it.qty
    ws.getCell(`H${r}`).value = it.unit_price
    ws.getCell(`I${r}`).value = { formula: `H${r}*G${r}` }
    for (const addr of [`B${r}`, `C${r}`, `E${r}`, `F${r}`, `G${r}`, `H${r}`, `I${r}`]) {
      ws.getCell(addr).font = { name: '宋体', size: 11 }
      ws.getCell(addr).alignment = { horizontal: 'center', vertical: 'center' }
    }
  })

  // 合计 r{totalRow}
  ws.getCell(`B${totalRow}`).value = '合计（大写）：'
  ws.mergeCells(`C${totalRow}:E${totalRow}`)
  ws.getCell(`C${totalRow}`).value = data.amount_cn
  ws.getCell(`G${totalRow}`).value = '小写：'
  ws.getCell(`G${totalRow}`).alignment = { horizontal: 'right', vertical: 'center' }
  ws.mergeCells(`H${totalRow}:I${totalRow}`)
  ws.getCell(`H${totalRow}`).value = items.length ? { formula: `SUM(I${itemStart}:I${lastItemRow})` } : ''
  for (const addr of [`B${totalRow}`, `C${totalRow}`, `H${totalRow}`]) {
    ws.getCell(addr).font = { name: '宋体', size: 11 }
  }

  // 货款情况 r{+1}/{+2}
  const rPay = totalRow + 1
  ws.mergeCells(`B${rPay}:B${rPay + 1}`)
  ws.getCell(`B${rPay}`).value = '货款情况'
  ws.getCell(`C${rPay}`).value = '未汇款  '
  ws.getCell(`D${rPay}`).value = ' □'
  ws.getCell(`E${rPay}`).value = '预计日期：'
  ws.mergeCells(`F${rPay}:G${rPay}`)
  ws.getCell(`H${rPay}`).value = '款项来源：'
  ws.getCell(`I${rPay}`).value = data.source || '对公转账'
  ws.getCell(`C${rPay + 1}`).value = '已汇款  '
  ws.getCell(`D${rPay + 1}`).value = ' R'
  ws.getCell(`E${rPay + 1}`).value = '收款日期：'
  ws.mergeCells(`F${rPay + 1}:G${rPay + 1}`)
  ws.getCell(`H${rPay + 1}`).value = '财务确认：'

  // 汇款单位名称 r{+3}
  const rRemitter = rPay + 2
  ws.getCell(`B${rRemitter}`).value = '汇款单位名称'
  ws.mergeCells(`C${rRemitter}:I${rRemitter}`)
  ws.getCell(`C${rRemitter}`).value = data.buyer
  // 备注 r{+4}
  const rNote = rPay + 3
  ws.mergeCells(`B${rNote}:I${rNote}`)
  const note = ws.getCell(`B${rNote}`)
  note.value = '备注：提供给财务的客户开票资料务必清晰无误'
  note.font = { name: '宋体', size: 11, bold: true }
  // 签名 r{+5}
  const rSign = rPay + 4
  ws.getCell(`D${rSign}`).value = '复核：'
  ws.getCell(`H${rSign}`).value = '填表人：'
  ws.getCell(`I${rSign}`).value = '杨青'

  // 边框：全区细边框，B8/B14/B15/B17 左侧 medium（复刻样板）
  for (let r = 3; r <= rSign; r++) {
    for (let c = 2; c <= 9; c++) ws.getCell(r, c).border = cellBorder('thin')
  }
  for (const r of [8, 14, 15, 17]) {
    if (r <= rSign) ws.getCell(r, 2).border = cellBorder('medium')
  }

  const out = await wb.xlsx.writeBuffer()
  return Buffer.from(out)
}

// ── 分发入口（模板 buffer 由 electron 侧解析后传入；invoice-app 无需模板）──
export async function generateDocBuffer(
  type: string,
  recordId: number,
  templateBuf?: Buffer,
): Promise<DocgenResult> {
  if (!(DOC_TYPES as readonly string[]).includes(type)) return { ok: false, reason: '未知模版类型' }
  const t = type as DocType
  try {
    if (t === 'invoice-app') {
      return { ok: true, buffer: await buildInvoiceAppWorkbook(buildInvoiceAppData(recordId)), ext: 'xlsx', entity: 'invoice', entityId: recordId }
    }
    if (!templateBuf) return { ok: false, reason: '缺少模版文件' }
    let data: CrmRow
    if (t === 'quotation') data = buildQuotationData(recordId)
    else if (t === 'contract') data = buildContractData(recordId)
    else data = buildInvoiceInfoData(recordId)
    // attachment_path 写回目标：invoice-info 落 invoice 行（contract 行无该列）
    const entity = t === 'quotation' ? 'quotation' : t === 'invoice-info' ? 'invoice' : 'contract'
    return { ok: true, buffer: renderDocx(templateBuf, data), ext: 'docx', entity, entityId: recordId }
  } catch (e) {
    return { ok: false, reason: String(e) }
  }
}
