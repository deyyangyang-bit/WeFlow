/**
 * crmIpcHandlers.ts
 * CRM 模块 IPC 注册（service→main 注册约定）。无删除端点（合规）。
 */
import type { IpcMain } from 'electron'
import { app } from 'electron'
import { join } from 'path'
import { crmDbService } from './crmDbService'
import { setCrmParseConfig, setPostScanHook, startCrmParseScheduler, scanNow } from './crmParseService'
import { generateDoc, ensureTemplates } from './crmDocGenService'
import { enqueueSalesTask } from './salesQueue'
import { setAutoConfirmConfig, setDocgenRunner, runAutoConfirmNow, startAutoConfirmScheduler, undoAutoConfirm, type AutoEntity } from './crmAutoConfirmService'
import { setEnrichConfig, setEnrichAiConfig, enrichCustomer, backfillEnrich } from './crmEnrichService'
import { simpleCompletion, callChatCompletion, getAiModelConfig } from './ai/aiApiClient'
import { salesDbService } from './salesDbService'
import { insightProfileService } from './insightProfileService'
import { insightRecordService } from './insightRecordService'
import { generateActionAnalysis } from './salesActionEngine'
import { importLeads, listLeads, leadDetail, leadOverview, updateLeadStatus, toAccount, scanLeadSla, completeLeadFirstContact, skipLeadFirstContact, setLeadConfig, DEFAULT_DEAD_REASONS } from './crmLeadService'
import { aiGenerateQuotation } from './crmQuoteService'
import { deepAnalyzeSession } from './crmDeepAnalysisService'
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs'
import type { ConfigService } from './config'

export function registerCrmIpcHandlers(ipcMain: IpcMain, config: ConfigService): void {
  void crmDbService.initialize(app.getPath('userData'))
  ensureTemplates(app.getPath('userData'))
  setCrmParseConfig(config)
  startCrmParseScheduler()
  // ── 确认中心自动确认装配：config 三键 / docgen 回调 / 扫后钩子 / 60s 兜底调度 ──
  setAutoConfirmConfig({
    get: (k) => {
      if (k === 'crmAutoConfirmEnabled') return config.get('crmAutoConfirmEnabled')
      if (k === 'crmAutoConfirmThreshold') return config.get('crmAutoConfirmThreshold')
      if (k === 'crmAutoConfirmInvoiceDocgen') return config.get('crmAutoConfirmInvoiceDocgen')
      return undefined
    }
  })
  setDocgenRunner((type, recordId) => generateDoc(type, recordId))
  // 客户信息自动填充装配：enrich 配置 shim + 完整 config（AI 调用需要 apiBaseUrl/apiKey）
  setEnrichAiConfig(config)
  setEnrichConfig({
    get: (k) => {
      if (k === 'crmEnrichEnabled') return config.get('crmEnrichEnabled')
      if (k === 'crmEnrichThreshold') return config.get('crmEnrichThreshold')
      if (k === 'crmEnrichAutoApply') return config.get('crmEnrichAutoApply')
      if (k === 'crmEnrichBackfillLimit') return config.get('crmEnrichBackfillLimit')
      return undefined
    }
  })
  // 线索流转装配：SLA 小时数从配置读取
  setLeadConfig({ get: (k) => (k === 'crmLeadSlaHours' ? config.get('crmLeadSlaHours') : undefined) })
  // 扫完立刻触发（fire-and-forget；enqueue 串行 + runAutoConfirmNow 内置批前快照）
  setPostScanHook(() => { void enqueueSalesTask(() => runAutoConfirmNow()) })
  startAutoConfirmScheduler()

  ipcMain.handle('crm:entity:list', async (_, entity: string, opts?) => crmDbService.list(entity, opts || {}))
  ipcMain.handle('crm:entity:get', async (_, entity: string, id: number) => crmDbService.getById(entity, id))
  ipcMain.handle('crm:entity:create', async (_, entity: string, payload) => crmDbService.create(entity, payload))
  ipcMain.handle('crm:entity:update', async (_, entity: string, id: number, patch) => crmDbService.update(entity, id, patch))
  ipcMain.handle('crm:form:get', async (_, entity: string) => crmDbService.formDefinition(entity))
  ipcMain.handle('crm:fieldmeta:save', async (_, meta) => crmDbService.saveFieldMeta(meta))
  ipcMain.handle('crm:review:queues', async () => crmDbService.reviewQueues())
  ipcMain.handle('crm:workbench', async () => crmDbService.workbench())
  ipcMain.handle('crm:stats:overview', async () => crmDbService.statsOverview())
  ipcMain.handle('crm:stats:aiAccuracy', async (_, days?: number) => crmDbService.aiAccuracyStats(Number(days) || 7))
  ipcMain.handle('crm:customers', async () => crmDbService.customers())
  // 客户信息自动填充：单客手动补全 / 存量回填（enqueue 串行；引擎内部不 enqueue）
  // 手动编辑客户字段（写入并锁定，AI 不再覆盖）
  ipcMain.handle('crm:enrich:manualSet', async (_, accountId: number, field: string, value: string) =>
    crmDbService.setAccountFieldManual(Number(accountId), String(field || ''), String(value ?? '')))
  ipcMain.handle('crm:enrich:run', async (_, sessionId: string, displayName?: string) =>
    enqueueSalesTask(() => enrichCustomer(String(sessionId || ''), String(displayName || ''), { config })))
  ipcMain.handle('crm:enrich:backfill', async () => enqueueSalesTask(() => backfillEnrich()))
  // 信息待确认队列人工裁决（accept 写入 / reject 清除）
  ipcMain.handle('crm:infoQueue:apply', async (_, accountId: number, field: string, action: 'accept' | 'reject') =>
    crmDbService.applyInfoField(Number(accountId), String(field || ''), action))
  // 批量会话→客户映射（灵感信箱 CRM 状态徽章）
  ipcMain.handle('crm:accounts:bySessions', async (_, sessionIds: string[]) =>
    crmDbService.accountsBySessions(Array.isArray(sessionIds) ? sessionIds : []))
  // 客户档案一屏：销售画像 + 阶段 + 见解 + 待办 + 合同/回款 + AI 下一步建议
  ipcMain.handle('crm:customer:profile', async (_, sessionId: string) => {
    if (!sessionId) return { success: false, error: 'sessionId 不能为空' }
    try {
      let profile: any = null
      let aiProfile = ''
      let todos: any[] = []
      let intentHistory: any[] = []
      try { profile = salesDbService.customerGetBySession(sessionId) } catch { /* ignore */ }
      try {
        const rec = insightProfileService.getProfileRecord(sessionId)
        if (rec?.finalProfile) aiProfile = rec.finalProfile
      } catch { /* ignore */ }
      try { todos = salesDbService.todoList({ session_id: sessionId }) } catch { /* ignore */ }
      try { intentHistory = salesDbService.intentHistory(sessionId, 10) } catch { /* ignore */ }

      let insights: any[] = []
      try {
        const r = insightRecordService.listRecords({ sessionId, limit: 20 })
        insights = r.records || []
      } catch { /* ignore */ }

      const accRows = sessionId ? crmDbService.all('SELECT * FROM account WHERE session_id = ? LIMIT 1', [sessionId]) : []
      const account = accRows.length ? accRows[0] : null
      let contracts: any[] = []
      let credited = 0
      if (account) {
        contracts = crmDbService.list('contract', { account_id: Number(account.id) })
        credited = crmDbService.creditedTotal(Number(account.id))
      }

      // AI 下一步建议（轻量，复用五字段分析）
      let advice: any = null
      const displayName = profile?.display_name || account?.name || sessionId
      try {
        advice = await generateActionAnalysis({
          id: 0, sessionId,
          displayName,
          stage: profile?.stage || account?.sales_stage || 'unknown',
          triggerType: 'customer_profile',
          title: `客户「${displayName}」`,
          reason: '客户档案 AI 建议',
          suggestion: '',
          priority: 'high', priorityScore: 60, silentDays: 0,
          createdAt: Date.now(), status: 'pending'
        } as any)
      } catch { /* ignore */ }

      // CRM 操作时间线（导入/AI 填充/人工采纳/合同动作，倒序 30 条）
      let activities: any[] = []
      try { if (account) activities = crmDbService.activityBy('account', Number(account.id)).slice(-30).reverse() } catch { /* ignore */ }

      return { success: true, data: { profile, aiProfile, todos, intentHistory, insights, account, contracts, credited, advice, activities } }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })
  ipcMain.handle('crm:allocation:confirm', async (_, id: number, patch) => crmDbService.confirmAllocation(id, patch || {}))
  ipcMain.handle('crm:payment:approve', async (_, id: number) => crmDbService.approvePayment(id))
  ipcMain.handle('crm:account:ensure', async (_, name: string) => crmDbService.ensureAccount(String(name || '')))
  ipcMain.handle('crm:allocation:reject', async (_, id: number) => crmDbService.rejectAllocation(id))
  ipcMain.handle('crm:contract:ship', async (_, id: number) => crmDbService.shipContract(id))
  ipcMain.handle('crm:contract:sign', async (_, id: number) => crmDbService.signContract(id))
  ipcMain.handle('crm:contract:delete', async (_, id: number) => crmDbService.deleteContract(id))
  ipcMain.handle('crm:customer:delete', async (_, id: number) => crmDbService.deleteAccount(id))
  ipcMain.handle('crm:logistics:link', async (_, id: number, contractId: number, opts?: { ownerSales?: string }) => crmDbService.linkLogistics(id, contractId, opts))
  ipcMain.handle('crm:logistics:candidates', async (_, receiver: string, city: string) => crmDbService.logisticsCandidates(receiver, city))
  ipcMain.handle('crm:logistics:list', async (_, opts?: { filter?: 'unlinked' | 'pending' | 'signed' }) => crmDbService.logisticsList(opts))
  ipcMain.handle('crm:logistics:signed', async (_, id: number) => crmDbService.markLogisticsSigned(id))
  ipcMain.handle('crm:product:import', async (_, rows: Array<Record<string, unknown>>) => {
    let n = 0
    for (const r of rows) { crmDbService.create('product', { created_at: Date.now(), ...r }); n++ }
    return { imported: n }
  })
  ipcMain.handle('crm:quotation:create', async (_, data) => crmDbService.createQuotation(data))
  // AI 报价辅助：私聊需求 → 产品库选型 → 生成报价单草稿
  ipcMain.handle('crm:quotation:ai', async (_, sessionId: string, displayName: string) => aiGenerateQuotation(sessionId, displayName, config))
  // 资深销售助理深度分析：七板块销售分析报告
  ipcMain.handle('crm:customer:deepAnalysis', async (_, sessionId: string, displayName: string) => deepAnalyzeSession(sessionId, displayName, config))
  ipcMain.handle('crm:groups:list', async () => crmDbService.groups())
  ipcMain.handle('crm:groups:save', async (_, g) => crmDbService.saveGroup(g))
  ipcMain.handle('crm:groups:update', async (_, id: number, patch) => crmDbService.updateGroup(id, patch || {}))
  ipcMain.handle('crm:parse:scanNow', async () => scanNow())
  // 确认中心自动确认：手动一键运行（enqueue 串行，runAutoConfirmNow 内置批前快照+总开关）
  ipcMain.handle('crm:autoConfirm:run', async () => enqueueSalesTask(async () => runAutoConfirmNow()))
  // 自动确认历史（含置信/原因/动作，供前端展示 + 撤销）
  ipcMain.handle('crm:autoConfirm:history', async (_, limit?: number) => crmDbService.autoConfirmHistory(limit ?? 50))
  // 撤销单条自动确认（仅自动处理的条目可撤，非自动返回 reason 说明）
  ipcMain.handle('crm:autoConfirm:undo', async (_, entity: string, id: number) => undoAutoConfirm(entity as AutoEntity, Number(id)))
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

  // ── 单机线索流转：导入 / 列表 / 详情 / 状态流转 / 转客户 / SLA ──────────────
  ipcMain.handle('crm:lead:import', async (_, source: string, fileName: string, rows) => importLeads(String(source || ''), String(fileName || ''), Array.isArray(rows) ? rows : []))
  ipcMain.handle('crm:lead:list', async (_, opts) => listLeads((opts || {}) as any))
  ipcMain.handle('crm:lead:detail', async (_, id: number) => leadDetail(Number(id)))
  ipcMain.handle('crm:lead:overview', async () => leadOverview())
  ipcMain.handle('crm:lead:status', async (_, id: number, action: string, opts) => updateLeadStatus(Number(id), action as any, (opts || {}) as any))
  ipcMain.handle('crm:lead:toAccount', async (_, id: number) => toAccount(Number(id)))
  ipcMain.handle('crm:lead:scanSla', async () => scanLeadSla())
  ipcMain.handle('crm:lead:slaComplete', async (_, taskId: number) => completeLeadFirstContact(Number(taskId)))
  ipcMain.handle('crm:lead:slaSkip', async (_, taskId: number) => skipLeadFirstContact(Number(taskId)))
  ipcMain.handle('crm:lead:deadReasons', async () => DEFAULT_DEAD_REASONS)

  // 启动兜底：存量超时线索生成 SLA 今日行动卡（幂等 + partial unique index，无副作用）
  enqueueSalesTask(() => { try { scanLeadSla() } catch { /* 初始化时序竞争忽略 */ } })
  // 物流跟单启动补扫：物流群每晚 6/7 点更新，可能当天更新不准时 → 启动时回退 last_scan 到昨天 00:00，
  // 调度器（60s scanAll）随后补扫前一天发货；processed_msg 幂等保证已处理消息不重复落库
  enqueueSalesTask(() => {
    try {
      const yest = new Date(); yest.setHours(0, 0, 0, 0)
      const fallback = yest.getTime() - 86400000
      for (const g of crmDbService.groups().filter((gr) => String(gr.group_type) === 'logistics' && Number(gr.enabled) === 1)) {
        crmDbService.updateGroup(Number(g.id), { last_scan: Math.min(Number(g.last_scan || 0), fallback) })
      }
    } catch { /* 初始化时序竞争忽略 */ }
  })
}
