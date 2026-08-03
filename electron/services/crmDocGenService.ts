/**
 * crmDocGenService.ts
 * 固定模版文档生成（报价单/合同/开票信息单）：docxtemplater + pizzip（纯 JS）。
 * 模版位于 resources/crm-templates/；缺失时自动生成占位模版。
 * 行项型号必须来自 product 表（createQuotation 已校验）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import PizZip from 'pizzip'
import Docxtemplater from 'docxtemplater'
import { crmDbService, type CrmRow } from './crmDbService'
import { salesLog } from './salesLogger'

const TEMPLATES = ['quotation', 'contract', 'invoice-info'] as const
export type DocType = (typeof TEMPLATES)[number]

function minimalDocxXml(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${body}<w:sectPr/></w:body></w:document>`
}

function para(text: string): string {
  return `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`
}

function buildPlaceholderTemplate(type: DocType): Buffer {
  let body = ''
  if (type === 'quotation') {
    body = para('报价单 NO.{no}') + para('客户：{customer}') + para('日期：{date}') +
      para('{#items}') + para('{model} {name} {spec_summary} 数量{qty} 单价{unit_price} 小计{subtotal}') + para('{/items}') +
      para('合计：{total}')
  } else if (type === 'contract') {
    body = para('购销合同 NO.{no}') + para('甲方客户：{customer}') + para('金额：{amount}') + para('签订日期：{sign_date}') + para('型号明细：{items_text}')
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

export function ensureTemplates(resourcesDir: string): void {
  const dir = join(resourcesDir, 'crm-templates')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  for (const t of TEMPLATES) {
    const f = join(dir, `${t}.docx`)
    if (!existsSync(f)) writeFileSync(f, buildPlaceholderTemplate(t))
  }
}

function templatePath(type: DocType): string {
  // 开发态 resources 在项目根；打包态 process.resourcesPath
  const candidates = [
    join(process.resourcesPath || '', 'crm-templates', `${type}.docx`),
    join(app.getAppPath(), 'resources', 'crm-templates', `${type}.docx`),
    join(__dirname, '..', 'resources', 'crm-templates', `${type}.docx`)
  ]
  for (const c of candidates) if (existsSync(c)) return c
  const fallback = join(app.getPath('userData'), 'crm-templates', `${type}.docx`)
  if (!existsSync(fallback)) {
    mkdirSync(join(app.getPath('userData'), 'crm-templates'), { recursive: true })
    writeFileSync(fallback, buildPlaceholderTemplate(type))
  }
  return fallback
}

function render(type: DocType, data: Record<string, unknown>): Buffer {
  const tpl = readFileSync(templatePath(type))
  const zip = new PizZip(tpl)
  const doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true })
  doc.render(data)
  return doc.getZip().generate({ type: 'nodebuffer' })
}

export function generateDoc(type: string, recordId: number): { ok: boolean; path?: string; reason?: string } {
  if (!(TEMPLATES as readonly string[]).includes(type)) return { ok: false, reason: '未知模版类型' }
  const t = type as DocType
  try {
    let data: Record<string, unknown> = {}
    if (t === 'quotation') {
      const q = crmDbService.getById('quotation', recordId)
      if (!q) return { ok: false, reason: '报价单不存在' }
      const c = crmDbService.getById('contract', Number(q.contract_id))
      const acc = c ? crmDbService.getById('account', Number(c.account_id)) : null
      const items = JSON.parse(String(q.items || '[]')) as CrmRow[]
      data = {
        no: `Q-${recordId}`, customer: acc?.name ?? '', date: new Date().toLocaleDateString('zh-CN'),
        total: q.total, items
      }
    } else if (t === 'contract') {
      const c = crmDbService.getById('contract', recordId)
      if (!c) return { ok: false, reason: '合同不存在' }
      const acc = crmDbService.getById('account', Number(c.account_id))
      const quots = crmDbService.list('quotation', { contract_id: recordId })
      const items = quots.flatMap((q) => JSON.parse(String(q.items || '[]')) as CrmRow[])
      data = {
        no: `C-${recordId}`, customer: acc?.name ?? '', amount: c.amount,
        sign_date: c.sign_date ? new Date(Number(c.sign_date)).toLocaleDateString('zh-CN') : '',
        items_text: items.map((i) => `${i.model}×${i.qty}`).join('；')
      }
    } else {
      const inv = crmDbService.getById('invoice', recordId)
      if (!inv) return { ok: false, reason: '发票记录不存在' }
      const c = inv.contract_id ? crmDbService.getById('contract', Number(inv.contract_id)) : null
      const cf = c ? JSON.parse(String(c.custom_fields || '{}')) : {}
      data = {
        buyer: inv.buyer ?? '', tax_no: cf.tax_no ?? '', bank: cf.bank ?? '',
        bank_account: cf.bank_account ?? '', amount: inv.amount, items_text: cf.items_text ?? ''
      }
    }
    const buf = render(t, data)
    const outDir = join(app.getPath('userData'), 'crm-docs')
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })
    const outPath = join(outDir, `${t}-${recordId}-${Date.now()}.docx`)
    writeFileSync(outPath, buf)
    const entity = t === 'quotation' ? 'quotation' : t === 'contract' ? 'contract' : 'invoice'
    crmDbService.update(entity, recordId, { attachment_path: outPath })
    salesLog('INFO', `[CrmDocGen] generated ${outPath}`)
    return { ok: true, path: outPath }
  } catch (e) {
    salesLog('WARN', `[CrmDocGen] generate failed: ${e}`)
    return { ok: false, reason: String(e) }
  }
}
