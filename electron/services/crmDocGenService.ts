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
import { DOC_TYPES, generateDocBuffer, type DocType } from './crmDocGenCore'

export { DOC_TYPES }
export type { DocType }

function templatePath(type: DocType): string {
  // 打包态：extraResources 将 resources/ 原样映射到 Contents/Resources/resources/（即 process.resourcesPath/resources/）；
  // 开发态：resources 在项目根（app.getAppPath() 或 __dirname 上两级）
  const candidates = [
    join(process.resourcesPath || '', 'resources', 'crm-templates', `${type}.docx`),
    join(app.getAppPath(), 'resources', 'crm-templates', `${type}.docx`),
    join(__dirname, '..', 'resources', 'crm-templates', `${type}.docx`),
  ]
  for (const c of candidates) if (existsSync(c)) return c
  // 响亮失败：模版缺失必须让调用方/用户看到错误，绝不静默生成占位文档
  throw new Error(`模版缺失: ${type}.docx（已查找: ${candidates.join(' , ')}）`)
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
    try { crmDbService.update(r.entity, r.entityId, { attachment_path: outPath }) } catch { /* 元数据写回失败不影响生成 */ }
    salesLog('INFO', `[CrmDocGen] generated ${outPath}`)
    return { ok: true, path: outPath }
  } catch (e) {
    salesLog('WARN', `[CrmDocGen] generate failed: ${e}`)
    return { ok: false, reason: String(e) }
  }
}
