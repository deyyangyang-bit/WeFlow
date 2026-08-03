/**
 * crmIpcHandlers.ts
 * CRM 模块 IPC 注册（service→main 注册约定）。无删除端点（合规）。
 */
import type { IpcMain } from 'electron'
import { app } from 'electron'
import { join } from 'path'
import { crmDbService } from './crmDbService'
import { setCrmParseConfig, startCrmParseScheduler, scanNow } from './crmParseService'
import { generateDoc, ensureTemplates } from './crmDocGenService'
import { simpleCompletion, callChatCompletion, getAiModelConfig } from './ai/aiApiClient'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import type { ConfigService } from './config'

export function registerCrmIpcHandlers(ipcMain: IpcMain, config: ConfigService): void {
  void crmDbService.initialize(app.getPath('userData'))
  ensureTemplates(app.getPath('userData'))
  setCrmParseConfig(config)
  startCrmParseScheduler()

  ipcMain.handle('crm:entity:list', async (_, entity: string, opts?) => crmDbService.list(entity, opts || {}))
  ipcMain.handle('crm:entity:get', async (_, entity: string, id: number) => crmDbService.getById(entity, id))
  ipcMain.handle('crm:entity:create', async (_, entity: string, payload) => crmDbService.create(entity, payload))
  ipcMain.handle('crm:entity:update', async (_, entity: string, id: number, patch) => crmDbService.update(entity, id, patch))
  ipcMain.handle('crm:form:get', async (_, entity: string) => crmDbService.formDefinition(entity))
  ipcMain.handle('crm:fieldmeta:save', async (_, meta) => crmDbService.saveFieldMeta(meta))
  ipcMain.handle('crm:review:queues', async () => crmDbService.reviewQueues())
  ipcMain.handle('crm:workbench', async () => crmDbService.workbench())
  ipcMain.handle('crm:allocation:confirm', async (_, id: number, patch) => crmDbService.confirmAllocation(id, patch || {}))
  ipcMain.handle('crm:allocation:reject', async (_, id: number) => crmDbService.rejectAllocation(id))
  ipcMain.handle('crm:contract:ship', async (_, id: number) => crmDbService.shipContract(id))
  ipcMain.handle('crm:logistics:link', async (_, id: number, contractId: number) => crmDbService.linkLogistics(id, contractId))
  ipcMain.handle('crm:logistics:candidates', async (_, receiver: string, city: string) => crmDbService.logisticsCandidates(receiver, city))
  ipcMain.handle('crm:product:import', async (_, rows: Array<Record<string, unknown>>) => {
    let n = 0
    for (const r of rows) { crmDbService.create('product', { created_at: Date.now(), ...r }); n++ }
    return { imported: n }
  })
  ipcMain.handle('crm:quotation:create', async (_, data) => crmDbService.createQuotation(data))
  ipcMain.handle('crm:groups:list', async () => crmDbService.groups())
  ipcMain.handle('crm:groups:save', async (_, g) => crmDbService.saveGroup(g))
  ipcMain.handle('crm:groups:update', async (_, id: number, patch) => crmDbService.updateGroup(id, patch))
  ipcMain.handle('crm:parse:scanNow', async () => scanNow())
  ipcMain.handle('crm:doc:generate', async (_, type: string, recordId: number) => generateDoc(type, recordId))
  ipcMain.handle('crm:alias:learn', async (_, alias: string, accountId: number) => crmDbService.aliasLearn(alias, accountId))
  ipcMain.handle('crm:product:aiDesc', async (_, payload) => {
    return simpleCompletion(config, '你是产品文案。根据产品信息生成一段简洁的中文描述，只输出描述文本。', JSON.stringify(payload), { maxTokens: 512 })
  })
  ipcMain.handle('crm:product:aiExtract', async (_, template: string[], dataUrl: string) => {
    const raw = String(dataUrl || '')
    const b64 = raw.includes(',') ? raw.split(',')[1] : raw
    const out = await callChatCompletion(getAiModelConfig(config), [
      { role: 'system', content: '你是产品参数提取器。按给定字段清单从宣传图提取参数，只输出JSON，键为字段名，提取不到为""。' },
      { role: 'user', content: `字段清单：${JSON.stringify(template)}` }
    ], { responseFormatJson: true, imagesBase64: [{ data: b64, mime: 'image/jpeg' }], maxTokens: 800 })
    const m = out.match(/\{[\s\S]*\}/)
    return m ? JSON.parse(m[0]) : {}
  })
  ipcMain.handle('crm:file:readImage', async (_, filePath: string) => {
    try {
      if (!filePath || !existsSync(filePath)) return ''
      const buf = readFileSync(filePath)
      const ext = String(filePath).split('.').pop()?.toLowerCase() || 'jpg'
      const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg'
      return `data:${mime};base64,${buf.toString('base64')}`
    } catch { return '' }
  })
  ipcMain.handle('crm:file:saveImage', async (_, dataUrl: string, fileName: string) => {
    const dir = join(app.getPath('userData'), 'crm-images')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const b64 = String(dataUrl || '').includes(',') ? String(dataUrl).split(',')[1] : String(dataUrl)
    const dest = join(dir, `${Date.now()}_${String(fileName || 'img.jpg').replace(/[^\w.\-]/g, '_')}`)
    writeFileSync(dest, Buffer.from(b64, 'base64'))
    return dest
  })
}
