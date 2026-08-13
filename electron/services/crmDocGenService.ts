/**
 * crmDocGenService.ts —— 文档生成的 electron 薄壳。
 * 纯逻辑在 crmDocGenCore.ts（数据装配/渲染/Excel，可单测）；本文件只做
 * electron 侧的事：模板路径解析、落盘 userData/crm-docs、写回 attachment_path。
 * 类型：quotation/contract/invoice-info → docx（docxtemplater）；
 *       invoice-app → xlsx（exceljs 开票申请单）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { crmDbService } from './crmDbService'
import { salesLog } from './salesLogger'
import { DOC_TYPES, buildPlaceholderTemplate, generateDocBuffer, type DocType } from './crmDocGenCore'

export { DOC_TYPES }
export type { DocType }

export function ensureTemplates(resourcesDir: string): void {
  const dir = join(resourcesDir, 'crm-templates')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  for (const t of DOC_TYPES) {
    if (t === 'invoice-app') continue // Excel 类型，运行时生成，无 docx 模版
    const f = join(dir, `${t}.docx`)
    if (!existsSync(f)) writeFileSync(f, buildPlaceholderTemplate(t))
  }
}

function templatePath(type: DocType): string {
  // 开发态 resources 在项目根；打包态 process.resourcesPath（extraResources 已含 resources/）
  const candidates = [
    join(process.resourcesPath || '', 'crm-templates', `${type}.docx`),
    join(app.getAppPath(), 'resources', 'crm-templates', `${type}.docx`),
    join(__dirname, '..', 'resources', 'crm-templates', `${type}.docx`),
  ]
  for (const c of candidates) if (existsSync(c)) return c
  const fallback = join(app.getPath('userData'), 'crm-templates', `${type}.docx`)
  if (!existsSync(fallback)) {
    mkdirSync(join(app.getPath('userData'), 'crm-templates'), { recursive: true })
    writeFileSync(fallback, buildPlaceholderTemplate(type))
  }
  return fallback
}

export async function generateDoc(type: string, recordId: number): Promise<{ ok: boolean; path?: string; reason?: string }> {
  try {
    const t = type as DocType
    const tplBuf = t === 'invoice-app' ? undefined : readFileSync(templatePath(t))
    const r = await generateDocBuffer(type, recordId, tplBuf)
    if (!r.ok) return { ok: false, reason: r.reason }
    const outDir = join(app.getPath('userData'), 'crm-docs')
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })
    const outPath = join(outDir, `${t}-${recordId}-${Date.now()}.${r.ext}`)
    writeFileSync(outPath, r.buffer)
    crmDbService.update(r.entity, r.entityId, { attachment_path: outPath })
    salesLog('INFO', `[CrmDocGen] generated ${outPath}`)
    return { ok: true, path: outPath }
  } catch (e) {
    salesLog('WARN', `[CrmDocGen] generate failed: ${e}`)
    return { ok: false, reason: String(e) }
  }
}
