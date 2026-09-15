/**
 * crmIpcHandlers.ts
 * CRM 模块 IPC 注册（service→main 注册约定）。无删除端点（合规）。
 */
import type { IpcMain } from 'electron'
import { app } from 'electron'
import { isSessionIdLike } from '../../shared/wechatId'
import { join } from 'path'
import { crmDbService } from './crmDbService'
import { buildOpportunityAnalysis } from './opportunityAnalysisService'
import { setCrmParseConfig, startCrmParseScheduler, scanNow } from './crmParseService'
import { generateDoc } from './crmDocGenService'
import { enqueueSalesTask } from './salesQueue'
import { setDocgenRunner, runAutoConfirmNow, undoAutoConfirm, type AutoEntity } from './crmAutoConfirmService'
import { setEnrichConfig, setEnrichAiConfig, enrichCustomer, backfillEnrich } from './crmEnrichService'
import { simpleCompletion, callChatCompletion, getAiModelConfig } from './ai/aiApiClient'
import { salesDbService } from './salesDbService'
import { wcdbService } from './wcdbService'
import { insightProfileService } from './insightProfileService'
import { insightRecordService } from './insightRecordService'
import { getCustomerCurrentView } from './customerCurrentView'
import { importLeads, listLeads, leadDetail, leadOverview, updateLeadStatus, updateLeadProfile, toAccount, scanLeadSla, completeLeadFirstContact, skipLeadFirstContact, setLeadConfig, DEFAULT_DEAD_REASONS, getImportDedupeDetail } from './crmLeadService'
import { assignLeads, assignBatchLeads, listAssignments, claimLead, recycleAssignment, transferAssignment, queryAuditEvents, listOwnershipHistory } from './crmAssignmentService'
import { bindLeadWxid } from './crmFriendDetectService'
import { markSla2ScanResult } from './crmSla2Service'
import { setCustomerType, getCustomerById } from './crmCustomerService'
import { registerDelivery, saveEquipment, proposeTradeIn, decideTradeIn, runDeliveryScan, listDeliveryTasks, suggestDeliveryDate, recomputeAllRepeatLevels } from './crmDeliveryService'
import { runFirstClassification, listFirstClassifyRounds, confirmFirstClassification, rejectFirstClassification, setFirstClassifyConfig, setFirstClassifyAiConfig } from './crmFirstClassifyService'
import { departureHandoff } from './crmOwnershipService'
import { listNotifyInbox, markNotifyRead } from './crmNotifyService'
import { sla2EvidenceGetForLead } from './crmSla2EvidenceService'
import { aiGenerateQuotation } from './crmQuoteService'
import { deepAnalyzeSession } from './crmDeepAnalysisService'
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs'
import type { ConfigService } from './config'

// 微信备注是客户名真相源：存量 account.name / profile.display_name 若为微信号格式（wan923121735、wxid_xxx），
// 从 WCDB contact 表取真实备注回填。幂等：只处理微信号格式名字；WCDB 未连接 / 无备注则跳过。
let displayNameBackfillRan = false

async function backfillWxidDisplayNames(): Promise<number> {
  const accounts = crmDbService.customers()
  const need = accounts.filter((a) => a.session_id && isSessionIdLike(a.name))
  if (need.length === 0) return 0
  const dn = await wcdbService.getDisplayNames(need.map((a) => String(a.session_id)))
  if (!dn.success || !dn.map) return -1 // WCDB 未连接：调用方不置位，下次打开重试
  let updated = 0
  for (const a of need) {
    const sid = String(a.session_id)
    const real = dn.map[sid]
    if (!real || isSessionIdLike(real) || real === sid) continue
    crmDbService.update('account', Number(a.id), { name: real })
    salesDbService.customerUpsert({ session_id: sid, display_name: real })
    updated++
  }
  return updated
}

export function registerCrmIpcHandlers(ipcMain: IpcMain, config: ConfigService): void {
  // §2.40 微信号分库：按当前账号库初始化（空 wxid 回退 legacy 名）；与 main.ts 启动初始化由 initPromise 去重
  void crmDbService.initialize(app.getPath('userData'), config.getMyWxidCleaned() || undefined)
  setCrmParseConfig(config)
  startCrmParseScheduler()
  // ── 2026-08-24 起停用 AI 自动确认（用户拍板：销售手动认领）——扫后钩子/60s 调度器移除，仅保留 docgen 回调 ──
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
  // 认领满 24h 首次分类装配（PRD 2.4）：配置 shim + 完整 config（AI 调用需要 apiBaseUrl/apiKey）
  setFirstClassifyAiConfig(config)
  setFirstClassifyConfig({
    get: (k) => {
      if (k === 'crmFirstClassifyEnabled') return config.get('crmFirstClassifyEnabled')
      if (k === 'crmFirstClassifyDelayHours') return config.get('crmFirstClassifyDelayHours')
      if (k === 'crmFirstClassifyScanIntervalMin') return config.get('crmFirstClassifyScanIntervalMin')
      return undefined
    }
  })

  ipcMain.handle('crm:contract:entryScope', () => crmDbService.contractEntryScope())
  ipcMain.handle('crm:contract:byCreationRequest', (_, requestId, scope) => {
    crmDbService.assertContractEntryScope(scope)
    return crmDbService.contractByCreationRequest(requestId)
  })
  ipcMain.handle('crm:contract:beginEntry', (_, input, scope) => {
    crmDbService.assertContractEntryScope(scope)
    return crmDbService.beginContractEntry(input)
  })
  ipcMain.handle('crm:contract:entryQuotation', (_, data, scope) => {
    crmDbService.assertContractEntryScope(scope)
    const result = crmDbService.createQuotation(data)
    if (result.ok) crmDbService.persistNowStrict()
    return result
  })
  ipcMain.handle('crm:entity:list', async (_, entity: string, opts?) => crmDbService.list(entity, opts || {}))
  ipcMain.handle('crm:entity:get', async (_, entity: string, id: number) => crmDbService.getById(entity, id))
  // 通用 IPC 边界限制（宪法 §1.5）：商机禁止走通用散写，renderer 只能经 registerOpportunityDeal 成交
  ipcMain.handle('crm:entity:create', async (_, entity: string, payload) => {
    if (entity === 'opportunity') throw new Error('商机创建禁止走通用 IPC：请使用商机业务方法')
    return crmDbService.create(entity, payload)
  })
  // 通用 IPC 边界限制（宪法 §1.5）：商机禁止走通用散写——成交字段只能经 registerOpportunityDeal，
  // 交付字段（shipped_qty/delivery_date/over_ship_reason）只能经 registerDelivery（crm:delivery:register），
  // 通用 update 不保留第二套写入路径（2026-09-10 收口：原 shipped_qty/delivery_date 白名单无调用者，关闭）
  ipcMain.handle('crm:entity:update', async (_, entity: string, id: number, patch) => {
    if (entity === 'opportunity') {
      throw new Error('商机禁止走通用更新：成交登记用 crm:opportunity:registerDeal，交付登记用 crm:delivery:register')
    }
    return crmDbService.update(entity, id, patch)
  })
  ipcMain.handle('crm:form:get', async (_, entity: string) => crmDbService.formDefinition(entity))
  ipcMain.handle('crm:fieldmeta:save', async (_, meta) => crmDbService.saveFieldMeta(meta))
  ipcMain.handle('crm:review:queues', async () => crmDbService.reviewQueues())
  ipcMain.handle('crm:workbench', async () => crmDbService.workbench())
  ipcMain.handle('crm:stats:overview', async () => crmDbService.statsOverview())
  ipcMain.handle('crm:stats:aiAccuracy', async (_, days?: number) => crmDbService.aiAccuracyStats(Number(days) || 7))
  // 客户列表：附带 customer_profile.stage（中文漏斗阶段）+ display_name（微信最新备注），
  // 与销售漏斗同源，深链下钻不空列表；名称双轨读取侧统一：前端展示优先用 profile 名（跟随最新备注）
  ipcMain.handle('crm:customers', async () => {
    // 惰性回填：首次打开客户工作台时，把存量「显示成微信号」的客户名回填为微信真实备注（幂等）
    if (!displayNameBackfillRan) {
      const r = await backfillWxidDisplayNames().catch(() => -1)
      if (r !== -1) displayNameBackfillRan = true // WCDB 未连接（-1）时保留重试
    }
    const rows = crmDbService.customers()
    try {
      const stageBySession = new Map<string, string>()
      const nameBySession = new Map<string, string>()
      for (const p of salesDbService.customerAll()) {
        if (!p.session_id) continue
        const sid = String(p.session_id)
        if (p.stage) stageBySession.set(sid, String(p.stage))
        if (p.display_name) nameBySession.set(sid, String(p.display_name))
      }
      return rows.map((r) => ({
        ...r,
        profile_stage: stageBySession.get(String(r.session_id || '')) || '',
        profile_display_name: nameBySession.get(String(r.session_id || '')) || ''
      }))
    } catch { return rows }
  })
  // 商机模块（P0：AI 从聊天自动识别采购信号 → 商机；列表/详情/事件/漏斗/阶段/关单）
  ipcMain.handle('crm:opportunity:list', async (_, opts?) => crmDbService.opportunityList(opts))
  ipcMain.handle('crm:opportunity:get', async (_, id: number) => crmDbService.opportunityById(Number(id)))
  ipcMain.handle('crm:opportunity:events', async (_, id: number) => crmDbService.opportunityEvents(Number(id)))
  ipcMain.handle('crm:opportunity:stats', async () => crmDbService.opportunityStats())
  // 阶段分析（只读）：管道总览 + 分段（仅 active）+ 各段优先处理名单。
  // 零模型调用、零落库；事实源是 shared/opportunitySignals.ts，排序也由纯函数给出。
  ipcMain.handle('crm:opportunity:analysis', async () => buildOpportunityAnalysis())
  ipcMain.handle('crm:opportunity:stage', async (_, id: number, stage: string) => crmDbService.opportunityUpdateStage(Number(id), String(stage || ''), 'manual'))
  ipcMain.handle('crm:opportunity:close', async (_, id: number, status: 'lost', reason: string) => crmDbService.opportunityClose(Number(id), status, String(reason || '')))
  // 正式成交登记（宪法 §1.5 修订 2026-09-09）：成交字段 + status=won + opportunity_event + audit_event
  // 同一事务，任一步失败整体回滚；丢单仍走 opportunity:close('lost')（只写状态和原因）
  ipcMain.handle('crm:opportunity:registerDeal', async (_, id: number, payload) => crmDbService.registerOpportunityDeal(Number(id), payload || {}))
  // 客户意向评分 0-100（P0）：跨库装配（account → session → salesDb 意向事件 + crmDb 商机）
  ipcMain.handle('crm:opportunity:intentScore', async (_, accountId: number) => {
    const acc = crmDbService.getById('account', Number(accountId))
    if (!acc?.session_id) return null
    const opp = crmDbService.activeOpportunityTotals(Number(accountId))
    try {
      return salesDbService.intentScore(String(acc.session_id), opp)
    } catch { return null }
  })
  // 风险预警（P0）：客户风险列表 / 解决
  ipcMain.handle('crm:risk:list', async (_, opts?) => crmDbService.riskList(opts))
  ipcMain.handle('crm:risk:resolve', async (_, id: number) => crmDbService.resolveRisk(Number(id)))
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
        const r = insightRecordService.listRecords({ sessionId, limit: 20, includeArchive: true })
        insights = r.records || []
      } catch { /* ignore */ }

      const accRows = sessionId ? crmDbService.all('SELECT * FROM account WHERE session_id = ? LIMIT 1', [sessionId]) : []
      const account = accRows.length ? accRows[0] : null
      // PRD §1.5 客户类型：account.customer_id 挂接的 customer 行（type=dealer/end_user）随档案下发
      let customer: any = null
      try { if (account && Number(account.customer_id || 0) > 0) customer = getCustomerById(Number(account.customer_id)) } catch { /* ignore */ }
      let contracts: any[] = []
      let credited = 0
      if (account) {
        contracts = crmDbService.list('contract', { account_id: Number(account.id) })
        credited = crmDbService.creditedTotal(Number(account.id))
      }

      // P0-3.2：客户当前视图（只读投影，不现场调 LLM）。
      // 360 从「现场生成 AI 判断」改为「消费系统已形成的当前视图」：
      // 判断由预热/扫描链路生产（customer_judgment 真源），360 打开档案不再触发 LLM。
      let currentView: any = null
      try { currentView = getCustomerCurrentView(sessionId) } catch { /* ignore */ }

      // 统一时间线（Customer 360）：CRM 业务动作 + 线索流转 + 商机事件，一条流倒序 40 条
      let activities: any[] = []
      try { if (account) activities = crmDbService.accountTimeline(Number(account.id)).reverse().slice(0, 40) } catch { /* ignore */ }

      return { success: true, data: { profile, aiProfile, todos, intentHistory, insights, account, customer, contracts, credited, currentView, activities } }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })
  ipcMain.handle('crm:allocation:confirm', async (_, id: number, patch) => crmDbService.confirmAllocation(id, patch || {}))
  ipcMain.handle('crm:payment:approve', async (_, id: number) => crmDbService.approvePayment(id))
  ipcMain.handle('crm:payments:byDay', async (_, days?: number) => crmDbService.paymentsByDay(days))
  ipcMain.handle('crm:payment:claim', async (_, id: number, patch) => crmDbService.claimPayment(id, patch || {}))
  // 当前登录账户显示名（认领销售默认值，单人团队不用每次手输）：wxid → 微信真实备注/昵称，取不到回退空
  // 当前登录账户显示名（认领销售默认值，单人团队不用每次手输）：wxid → 微信真实备注/昵称，取不到回退空
  const resolveMySalesName = async (): Promise<string> => {
    const myWxid = String(config.get('myWxid') || '').trim()
    if (!myWxid) return ''
    const dn = await wcdbService.getDisplayNames([myWxid])
    if (!dn.success || !dn.map) return ''
    const real = dn.map[myWxid]
    return real && !isSessionIdLike(real) && real !== myWxid ? real : ''
  }
  ipcMain.handle('crm:currentSalesName', async () => resolveMySalesName())
  // 销售团队名单（跟单中心）：历史认领记录非 wxid 人名词条 ∪ 当前登录账户，附每人单数/金额；
  // 显式新增进 salesTeamAdded，离职/移除进 salesTeamRemoved（两名单均持久化，覆盖历史推断）
  ipcMain.handle('crm:sales:team', async () => {
    const rows = crmDbService.all(
      "SELECT sales_name AS n, COUNT(*) AS cnt, COALESCE(SUM(credited_amount),0) AS amt FROM allocation WHERE sales_name IS NOT NULL AND sales_name != '' GROUP BY sales_name")
    const team: Array<{ name: string; orderCount: number; amount: number }> = []
    const seen = new Set<string>()
    for (const r of rows) {
      const n = String(r.n).trim()
      if (!n || isSessionIdLike(n) || seen.has(n)) continue // 裸 wxid 旧数据不进名单
      seen.add(n)
      team.push({ name: n, orderCount: Number(r.cnt), amount: Number(r.amt) })
    }
    const me = await resolveMySalesName()
    if (me && !seen.has(me)) team.push({ name: me, orderCount: 0, amount: 0 })
    const removed = new Set<string>(config.get('salesTeamRemoved') || [])
    const added = new Set<string>(config.get('salesTeamAdded') || [])
    const active = team.filter((m) => added.has(m.name) || !removed.has(m.name))
    for (const a of added) if (!active.some((m) => m.name === a)) active.push({ name: a, orderCount: 0, amount: 0 })
    active.sort((a, b) => b.amount - a.amount)
    return { team: active, removed: [...removed] }
  })
  ipcMain.handle('crm:sales:team:add', (_, name: string) => {
    const n = String(name || '').trim()
    if (!n) return { ok: false, reason: '销售名为空' }
    const added = new Set<string>(config.get('salesTeamAdded') || [])
    added.add(n)
    const removed = new Set<string>(config.get('salesTeamRemoved') || [])
    removed.delete(n) // 重新添加 = 撤销离职
    config.set('salesTeamAdded', [...added])
    config.set('salesTeamRemoved', [...removed])
    return { ok: true }
  })
  ipcMain.handle('crm:sales:team:remove', (_, name: string) => {
    const n = String(name || '').trim()
    if (!n) return { ok: false, reason: '销售名为空' }
    const removed = new Set<string>(config.get('salesTeamRemoved') || [])
    removed.add(n)
    config.set('salesTeamRemoved', [...removed])
    return { ok: true }
  })
  ipcMain.handle('crm:account:ensure', async (_, name: string) => crmDbService.ensureAccount(String(name || '')))
  ipcMain.handle('crm:allocation:reject', async (_, id: number) => crmDbService.rejectAllocation(id))
  ipcMain.handle('crm:contract:ship', async (_, id: number) => crmDbService.shipContract(id))
  ipcMain.handle('crm:contract:sign', async (_, id: number) => crmDbService.signContract(id))
  ipcMain.handle('crm:contract:delete', async (_, id: number) => crmDbService.deleteContract(id))
  ipcMain.handle('crm:customer:delete', async (_, id: number) => crmDbService.deleteAccount(id))
  ipcMain.handle('crm:logistics:link', async (_, id: number, opts?: { accountId?: number; contractId?: number; ownerSales?: string }) => crmDbService.linkLogistics(id, opts))
  ipcMain.handle('crm:logistics:candidates', async (_, receiver: string, city: string) => crmDbService.logisticsCandidates(receiver, city))
  ipcMain.handle('crm:logistics:list', async (_, opts?: { filter?: 'unlinked' | 'pending' | 'signed' }) => crmDbService.logisticsList(opts))
  ipcMain.handle('crm:logistics:signed', async (_, id: number) => crmDbService.markLogisticsSigned(id))
  ipcMain.handle('crm:product:import', async (_, rows: Array<Record<string, unknown>>) => {
    let n = 0
    for (const r of rows) { crmDbService.create('product', { created_at: Date.now(), ...r }); n++ }
    return { imported: n }
  })
  ipcMain.handle('crm:quotation:create', async (_, data) => crmDbService.createQuotation(data))
  // 报价版本链读口（宪法 §1.6 修订 2026-09-09）：当前有效报价 / 报价历史（历史版本只读，update 守卫拒绝改写）
  ipcMain.handle('crm:quotation:current', async (_, contractId: number) => crmDbService.currentQuotationForContract(Number(contractId)))
  ipcMain.handle('crm:quotation:history', async (_, contractId: number) => crmDbService.quotationHistoryForContract(Number(contractId)))
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
  ipcMain.handle('crm:doc:generate', async (_, type: string, recordId: number, options?) => generateDoc(type, recordId, options))
  ipcMain.handle('crm:alias:learn', async (_, alias: string, accountId: number) => crmDbService.aliasLearn(alias, accountId))
  ipcMain.handle('crm:product:aiDesc', async (_, payload) => {
    return simpleCompletion(config, '你是产品文案。根据产品信息生成一段简洁的中文描述，只输出描述文本。', JSON.stringify(payload), { maxTokens: 512, usageContext: { purpose: 'crm_copy' } })
  })
  ipcMain.handle('crm:product:aiExtract', async (_, template: string[], dataUrl: string) => {
    const raw = String(dataUrl || '')
    const b64 = raw.includes(',') ? raw.split(',')[1] : raw
    const out = await callChatCompletion(getAiModelConfig(config), [
      { role: 'system', content: '你是产品参数提取器。按给定字段清单从宣传图提取参数，只输出JSON，键为字段名，提取不到为""。' },
      { role: 'user', content: `字段清单：${JSON.stringify(template)}` }
    ], { responseFormatJson: true, imagesBase64: [{ data: b64, mime: 'image/jpeg' }], maxTokens: 800, usageContext: { purpose: 'crm_meta' } })
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
  ipcMain.handle('crm:lead:update', async (_, id: number, fields) => updateLeadProfile(Number(id), (fields || {}) as any))
  ipcMain.handle('crm:lead:toAccount', async (_, id: number) => toAccount(Number(id)))
  ipcMain.handle('crm:lead:scanSla', async () => scanLeadSla())
  ipcMain.handle('crm:lead:slaComplete', async (_, taskId: number) => completeLeadFirstContact(Number(taskId)))
  ipcMain.handle('crm:lead:slaSkip', async (_, taskId: number) => skipLeadFirstContact(Number(taskId)))
  ipcMain.handle('crm:lead:deadReasons', async () => DEFAULT_DEAD_REASONS)

  // ── 线索分配（Phase 1 完整版，API-CONTRACT §1.14 契约五端点，统一信封）──
  // actor 兜底链：显式 > 身份档案 getActorLabel() > 「分配员」（仅署名，宪法 §1.12）
  // mode 原样透传给 service（`unknown`）：**不在 IPC 层 `String()`**——那会把对象/数组/数字/布尔
  // 洗成「看起来合法」的字符串，服务层的运行时校验就永远看不到真实类型。校验与 E101 都在 service。
  ipcMain.handle('crm:assignment:assign', async (_, req: { leadIds?: number[]; salesName?: string; mode?: unknown; actor?: string }) =>
    assignLeads(Array.isArray(req?.leadIds) ? req.leadIds : [], String(req?.salesName || ''), String(req?.actor || ''), req?.mode))
  ipcMain.handle('crm:assignment:claim', async (_, req: { leadId?: number; actor?: string }) =>
    claimLead(Number(req?.leadId), String(req?.actor || '')))
  ipcMain.handle('crm:assignment:recycle', async (_, req: { assignmentId?: number; reason?: string; actor?: string }) =>
    recycleAssignment(Number(req?.assignmentId), String(req?.reason || ''), String(req?.actor || '')))
  ipcMain.handle('crm:assignment:transfer', async (_, req: { assignmentId?: number; toSales?: string; reason?: string; actor?: string }) =>
    transferAssignment(Number(req?.assignmentId), String(req?.toSales || ''), String(req?.reason || ''), String(req?.actor || '')))
  ipcMain.handle('crm:assignment:list', async (_, opts) => listAssignments((opts || {}) as any))
  // 批量分配（设计稿屏 3 分配控制台）：按模式从待分配池取 N 条分给名单，逐条走 assignLeads 同事务语义
  // 同上：mode 不做 `String()` 掩盖；缺省由 service 按「未设置」处理，显式非法值由 service 返回 E101
  ipcMain.handle('crm:assignment:assignBatch', async (_, req: { count?: number; mode?: unknown; weights?: Record<string, number>; actor?: string }) =>
    assignBatchLeads({ count: Number(req?.count) || 0, mode: req?.mode, weights: req?.weights || {}, actor: String(req?.actor || '') }))

  // ── 加好友判定（PRD 1.4a 手动路，API-CONTRACT §1.14 契约端点）──────────────
  // 绑定微信：写 customer_identity(source='manual', confidence=1.0) + 停 SLA1 表 + lead→WX_ADDED + 审计；
  // actor 兜底链同分配端点（显式 > 身份档案 > 兜底）；幂等：重复绑定 alreadyBound 零重复写
  ipcMain.handle('crm:identity:bind', async (_, req: { leadId?: number; wxid?: string; displayName?: string; actor?: string }) =>
    bindLeadWxid(Number(req?.leadId), String(req?.wxid || ''), { actor: String(req?.actor || ''), displayName: String(req?.displayName || '') }))

  // ── 两段接力 SLA 第二段「聊了没有」（PRD 1.4）+ 客户类型（PRD 1.5）──────────
  // SLA2 扫描结果写入口径：规则骨架/未来 LLM 扫描/人工结论的统一写点（assignment.sla2_scan_ref + 审计）
  ipcMain.handle('crm:sla2:mark', async (_, req: { leadId?: number; verdict?: string; confidence?: number; scanRef?: string; source?: string; note?: string; actor?: string }) =>
    markSla2ScanResult(Number(req?.leadId), {
      verdict: String(req?.verdict || '') as never, confidence: Number(req?.confidence),
      scanRef: String(req?.scanRef || ''), source: req?.source as never,
      note: req?.note, actor: String(req?.actor || '')
    }))
  // 客户类型（dealer/end_user，'' 清除）：单事务 UPDATE customer + 审计；actor 兜底链同分配端点
  ipcMain.handle('crm:customer:setType', async (_, req: { customerId?: number; type?: string; actor?: string }) =>
    setCustomerType(Number(req?.customerId), String(req?.type ?? ''), String(req?.actor || '')))

  // ── 交付售后（PRD 售后生命周期配套，宪法 §1.1/§1.5/§3 登记 2026-09-10）──────────
  // 交付登记 / 设备档案 / 以旧换新 / 复购等级均为后端单点写入（不再走 crm:entity:update 散写）
  ipcMain.handle('crm:delivery:register', async (_, oppId: number, payload) => registerDelivery(Number(oppId), payload || {}))
  ipcMain.handle('crm:delivery:saveEquipment', async (_, customerId: number, fields) => saveEquipment(Number(customerId), fields || {}))
  ipcMain.handle('crm:delivery:proposeTradeIn', async (_, customerId: number, basis) => proposeTradeIn(Number(customerId), basis || {}))
  ipcMain.handle('crm:delivery:decideTradeIn', async (_, customerId: number, decision: string) =>
    decideTradeIn(Number(customerId), String(decision) as 'accept' | 'reject'))
  ipcMain.handle('crm:delivery:scan', async () => runDeliveryScan())
  ipcMain.handle('crm:delivery:tasks', async () => listDeliveryTasks())
  ipcMain.handle('crm:delivery:suggestDate', async (_, oppId: number) => suggestDeliveryDate(Number(oppId)))
  ipcMain.handle('crm:delivery:recomputeRepeat', async () => recomputeAllRepeatLevels())

  // ── 认领满 24h AI 首次分类（PRD 2.4，宪法 §3 first_classification 登记行）──────────
  // B 档：结果只进 proposed 提案行；confirm/reject 人工裁决；模型失败 failed 可重试不写假结果。
  // 手动「立即分析」= run（不受 24h 限制；已有 proposed/confirmed/rejected 轮次时不重复调模型，返回现状）
  ipcMain.handle('crm:firstClassify:run', async (_, req: { leadId?: number; assignmentId?: number; actor?: string }) =>
    enqueueSalesTask(() => runFirstClassification({
      leadId: Number(req?.leadId) || undefined, assignmentId: Number(req?.assignmentId) || undefined,
      trigger: 'manual', actor: String(req?.actor || '')
    })))
  ipcMain.handle('crm:firstClassify:list', async (_, opts) => listFirstClassifyRounds((opts || {}) as any))
  ipcMain.handle('crm:firstClassify:confirm', async (_, req: { roundId?: number; actor?: string }) =>
    enqueueSalesTask(() => confirmFirstClassification(Number(req?.roundId), String(req?.actor || ''))))
  // reject 是同步实现（sql.js runTx 同步落库，同 main.ts 的同步服务调用口径），包 Promise.resolve 维持队列契约
  ipcMain.handle('crm:firstClassify:reject', async (_, req: { roundId?: number; actor?: string; reason?: string }) =>
    enqueueSalesTask(() => Promise.resolve(
      rejectFirstClassification(Number(req?.roundId), String(req?.actor || ''), String(req?.reason || '')))))

  // ── 离职移交（PRD §1.9）：lead 批量走 transferAssignment 循环（reason='离职'）+
  //    owner 三列（account/opportunity/logistics）同事务直改 + ownership_history + audit_event ──
  ipcMain.handle('crm:ownership:departure', async (_, req: { fromSales?: string; toSales?: string; actor?: string }) =>
    departureHandoff(String(req?.fromSales || ''), String(req?.toSales || ''), String(req?.actor || '')))

  // ── 审计流水 + 归属留痕（API-CONTRACT §1.14 契约端点，R 只读，统一信封 {ok,data}）──
  // audit_event / ownership_history 均 append-only（宪法 §1.12/§1.8），无软删列、永不删改
  ipcMain.handle('crm:audit:query', async (_, opts) => queryAuditEvents((opts || {}) as any))
  ipcMain.handle('crm:ownership:history', async (_, opts) => listOwnershipHistory((opts || {}) as any))

  // ── 存量迁移报告（migration_report SSOT，R 只读）——与 audit_event 解耦：
  //    audit_event 只留「实际写入」业务留痕，报告快照每次启动扫描都刷新为最新一份 ──
  ipcMain.handle('crm:migration:report:list', async () => {
    try {
      const parse = (s: unknown): unknown => { try { return JSON.parse(String(s ?? '[]')) } catch { return [] } }
      const rows = crmDbService.listMigrationReports().map((r) => ({
        module: String(r.module || ''),
        title: String(r.title || ''),
        summary: parse(r.summary),
        failures: parse(r.failures),
        conflicts: parse(r.conflicts),
        ranAt: Number(r.ran_at || 0)
      }))
      return { ok: true, data: rows }
    } catch (e) {
      return { ok: false, data: [], error: String((e as Error)?.message || e) }
    }
  })

  // ── 迁移失败/冲突项的人工闭环（确认忽略 / 恢复；SSOT = migration_dismissal 表）──
  //    忽略后：本次界面即时隐藏 + 下次启动迁移扫描不再计入失败；全程 audit 留痕。
  ipcMain.handle('crm:migration:dismissal:list', async () => {
    try {
      const rows = crmDbService.migrationDismissals().map((r) => ({
        module: String(r.module || ''),
        entityKey: String(r.entity_key || ''),
        dismissedBy: String(r.dismissed_by || ''),
        dismissedAt: Number(r.dismissed_at || 0)
      }))
      return { ok: true, data: rows }
    } catch (e) {
      return { ok: false, data: [], error: String((e as Error)?.message || e) }
    }
  })
  ipcMain.handle('crm:migration:failure:dismiss', async (_, module: string, entityKey: string, reason?: string) => {
    try {
      const actor = config.get('identityName') || '操作员'
      crmDbService.migrationDismiss(String(module), String(entityKey), actor)
      crmDbService.auditAppend(actor, 'migration_failure_dismiss', 'migration', null,
        { module: String(module), key: String(entityKey), reason: String(reason || '') })
      return { ok: true }
    } catch (e) {
      return { ok: false, error: String((e as Error)?.message || e) }
    }
  })
  ipcMain.handle('crm:migration:failure:restore', async (_, module: string, entityKey: string) => {
    try {
      const actor = config.get('identityName') || '操作员'
      crmDbService.migrationUndismiss(String(module), String(entityKey))
      crmDbService.auditAppend(actor, 'migration_failure_restore', 'migration', null,
        { module: String(module), key: String(entityKey) })
      return { ok: true }
    } catch (e) {
      return { ok: false, error: String((e as Error)?.message || e) }
    }
  })

  // ── 主管升级提醒（SLA1 三次超时通知闭环的 UI 供数；写者唯一=lanSyncService 通知消费）──
  ipcMain.handle('crm:notify:list', async (_, opts?: { status?: string; limit?: number; offset?: number }) =>
    listNotifyInbox(opts || {}))
  ipcMain.handle('crm:notify:markRead', async (_, req: { ids?: number[] }) =>
    markNotifyRead(Array.isArray(req?.ids) ? req.ids : []))

  // ── SLA2「查看依据」（屏 5 右证据回查出口；脱敏 + 字段裁剪，见 crmSla2EvidenceService）──
  ipcMain.handle('crm:sla2:evidence', async (_, leadId: number) => sla2EvidenceGetForLead(Number(leadId)))

  // ── 导入查重明细（2026-09-08 查重完善：按批次取脱敏明细行，供结果展示与 CSV 导出）──
  ipcMain.handle('crm:import:dedupeDetail', async (_, batchId: number) => getImportDedupeDetail(Number(batchId)))

  // 启动兜底：存量超时线索生成 SLA 今日行动卡（幂等 + partial unique index，无副作用）
  // （两个启动补扫都是「排进队列即返回」的副作用型任务，回调无返回值，用 async 满足队列的 Promise 契约）
  enqueueSalesTask(async () => { try { scanLeadSla() } catch { /* 初始化时序竞争忽略 */ } })
  // 物流跟单启动补扫：物流群每晚 6/7 点更新，可能当天更新不准时 → 启动时回退 last_scan 到昨天 00:00，
  // 调度器（60s scanAll）随后补扫前一天发货；processed_msg 幂等保证已处理消息不重复落库
  enqueueSalesTask(async () => {
    try {
      const yest = new Date(); yest.setHours(0, 0, 0, 0)
      const fallback = yest.getTime() - 86400000
      for (const g of crmDbService.groups().filter((gr) => String(gr.group_type) === 'logistics' && Number(gr.enabled) === 1)) {
        crmDbService.updateGroup(Number(g.id), { last_scan: Math.min(Number(g.last_scan || 0), fallback) })
      }
    } catch { /* 初始化时序竞争忽略 */ }
  })
}
