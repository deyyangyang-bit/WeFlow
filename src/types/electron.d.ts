import type { ChatSession, Message, Contact, ContactInfo, ChatRecordItem } from './models'
// 商机阶段分析载荷（与 electron/services/opportunityAnalysisService.ts 同源；纯类型，无运行时代码）
import type { OpportunityAnalysisResult } from '../../shared/opportunitySignals'
// 分配模式的唯一来源（与 electron/services/crmAssignmentService.ts 同源）
import type { AssignmentMode } from '../../shared/centralDownCommand'

/**
 * CRM 分配数据失效事件载荷（'crm:assignment:invalidated'，主进程 → 渲染层只读广播）。
 * 最小载荷纪律：只有 action（assign/claim/recycle/transfer，去抖合并多动作用逗号连接）、
 * 发生归属变化的 leadIds、时刻；绝不携带联系方式、聊天内容或任何客户敏感字段。
 */
export interface CrmAssignmentInvalidation {
  action: string
  leadIds: number[]
  at: number
}

// ─── Hermes 只读智能体任务快照类型（与 electron/services/hermesAgent.ts 状态模型对应）───
export interface HermesEvidenceItem {
  label: string
  kind: 'customer' | 'chat' | 'crm' | 'knowledge' | 'action' | 'result'
  /** 知识库条目 id / account id / 行动卡 id（真实查得） */
  entityId?: number
  /** 聊天证据回查锚点（P0-2B canonical messageKey，真实查得） */
  messageKey?: string
  excerpt?: string
  /** 证据编号（e1..en；任务内唯一，模型只能引用编号） */
  ref?: string
}

export interface HermesTaskStepItem {
  label: string
  status: 'running' | 'done' | 'error'
  tool?: string
  publicSummary?: string
}

export interface HermesTaskSnapshot {
  taskId: string
  status: 'planning' | 'running' | 'completed' | 'failed' | 'cancelled'
  goal: string
  contextLabel: string
  steps: HermesTaskStepItem[]
  evidence: HermesEvidenceItem[]
  result?: {
    summary: string
    /** 每条发现绑定支持它的证据编号（主进程已核验，伪造编号被剔除） */
    findings: Array<{ text: string; evidenceRefs: string[] }>
    nextSteps: string[]
  }
  errorCode?: string
  errorMessage?: string
  createdAt: number
}

export interface HermesTaskStartResult {
  ok: boolean
  task?: HermesTaskSnapshot
  errorCode?: string
}
export interface HermesTaskGetResult {
  ok: boolean
  task?: HermesTaskSnapshot
  errorCode?: string
}
export interface HermesTaskCancelResult {
  ok: boolean
  task?: HermesTaskSnapshot
}
export type HermesTaskContextOption =
  | { kind: 'global' }
  | { kind: 'chat'; sessionId?: string }
  | { kind: 'customer'; accountId?: number; sessionId?: string }

export interface SessionChatWindowOpenOptions {
  source?: 'chat' | 'export'
  initialDisplayName?: string
  initialAvatarUrl?: string
  initialContactType?: ContactInfo['type']
}

export interface SocialValidateWeiboUidResult {
  success: boolean
  uid?: string
  screenName?: string
  error?: string
}

export interface SocialSaveWeiboCookieResult {
  success: boolean
  normalized?: string
  hasCookie?: boolean
  error?: string
}

export type InsightRecordTriggerReason = 'activity' | 'silence' | 'test' | 'manual' | 'message_analysis'
export type InsightRecordSourceType = 'insight' | 'message_analysis'

export interface MessageInsightAnalysis {
  explicitText: string
  emotion: string
  intent: string
  topic: string
}

export interface MessageInsightTarget {
  targetLocalId: number
  targetCreateTime: number
  targetMessageKey: string
  targetSenderName: string
  targetTextPreview: string
  analysis: MessageInsightAnalysis
}

export interface InsightRecordLog {
  endpoint: string
  model: string
  maxTokens: number
  temperature: number
  triggerReason: InsightRecordTriggerReason
  allowContext: boolean
  contextCount: number
  systemPrompt: string
  userPrompt: string
  rawOutput: string
  finalInsight: string
  durationMs: number
  createdAt: number
  responseFormatJson?: boolean
  responseFormatFallback?: boolean
  responseFormatFallbackReason?: string
  targetMessage?: {
    localId: number
    createTime: number
    messageKey: string
    senderName: string
    textPreview: string
  }
  contextStats?: {
    requested: number
    beforeTarget: number
    afterTarget: number
    readError?: string
  }
  parsedAnalysis?: MessageInsightAnalysis
}

export interface InsightRecordSummary {
  id: string
  sourceType: InsightRecordSourceType
  createdAt: number
  sessionId: string
  displayName: string
  avatarUrl?: string
  triggerReason: InsightRecordTriggerReason
  insight: string
  read: boolean
  salesStage?: string
  messageInsight?: MessageInsightTarget
}

export interface InsightRecord extends InsightRecordSummary {
  accountScope: string
  log: InsightRecordLog
}

export interface InsightRecordContactFacet {
  sessionId: string
  displayName: string
  avatarUrl?: string
  count: number
}

export interface InsightRecordFilters {
  keyword?: string
  sessionId?: string
  startTime?: number
  endTime?: number
  sourceType?: InsightRecordSourceType | 'all'
  limit?: number
  offset?: number
}

export interface InsightRecordListResult {
  success: boolean
  records: InsightRecordSummary[]
  total: number
  todayCount: number
  unreadCount: number
  contacts: InsightRecordContactFacet[]
  error?: string
}

export interface InsightRecordResult {
  success: boolean
  record?: InsightRecord
  error?: string
}

export type InsightProfileStatusValue = 'none' | 'ready' | 'running' | 'failed'

export interface InsightProfileStatus {
  sessionId: string
  status: InsightProfileStatusValue
  updatedAt?: number
  error?: string
  phase?: string
  busy?: boolean
}

export interface InsightProfileStatusListResult {
  success: boolean
  statuses: Record<string, InsightProfileStatus>
  activeTask?: {
    sessionId: string
    displayName: string
    phase: string
    startedAt: number
  }
  error?: string
}

export interface InsightProfileGenerateResult {
  success: boolean
  message: string
  cancelled?: boolean
  error?: string
}

export type GroupSummaryTriggerType = 'auto' | 'manual'

export interface GroupSummaryTopic {
  title: string
  participants: string[]
  keyPoints: string[]
  conclusion: string
}

export interface GroupSummaryLog {
  endpoint: string
  model: string
  temperature: number
  triggerType: GroupSummaryTriggerType
  periodStart: number
  periodEnd: number
  messageCount: number
  readableMessageCount: number
  systemPrompt: string
  userPrompt: string
  rawOutput: string
  finalSummary: string
  durationMs: number
  createdAt: number
  responseFormatJson?: boolean
  responseFormatFallback?: boolean
  responseFormatFallbackReason?: string
  parsedTopics?: GroupSummaryTopic[]
}

export interface GroupSummaryRecordSummary {
  id: string
  createdAt: number
  sessionId: string
  displayName: string
  avatarUrl?: string
  triggerType: GroupSummaryTriggerType
  periodStart: number
  periodEnd: number
  messageCount: number
  readableMessageCount: number
  topics: GroupSummaryTopic[]
  summaryText: string
}

export interface GroupSummaryRecord extends GroupSummaryRecordSummary {
  accountScope: string
  rawOutput: string
  log: GroupSummaryLog
}

export interface GroupSummaryRecordFilters {
  sessionId?: string
  startTime?: number
  endTime?: number
  limit?: number
  offset?: number
}

export interface GroupSummaryRecordListResult {
  success: boolean
  records: GroupSummaryRecordSummary[]
  total: number
  error?: string
}

export interface GroupSummaryRecordResult {
  success: boolean
  record?: GroupSummaryRecord
  error?: string
}

export interface BackupProgress {
  phase: 'preparing' | 'scanning' | 'exporting' | 'packing' | 'inspecting' | 'restoring' | 'done' | 'failed'
  message: string
  current?: number
  total?: number
  detail?: string
}

export interface BackupOptions {
  includeImages?: boolean
  includeVideos?: boolean
  includeFiles?: boolean
  includeSalesData?: boolean
}

/** 自动备份状态（backup:auto:status 返回；PRD 1.1 双保险定时备份） */
export interface AutoBackupStatus {
  configuredTime: string
  networkPath: string
  /** 本机备份密钥封装方式（electron-safeStorage=系统安全设施 / local-wrap-v1=降级封装） */
  keyProtection: string
  last: {
    at: string
    trigger: string
    dirName: string
    local: string
    network: string
    files: Array<{ kind: string; name: string; size: number }>
    durationMs: number
  } | null
  nextPlannedAt: string | null
  /** 新机恢复门禁（跨机器恢复的显式采用流程所需） */
  recovery: AutoBackupRecoveryGate
}

/** 新机首次恢复门禁状态（backup:auto:status 内） */
export interface AutoBackupRecoveryGate {
  /** 门禁开放：本机密钥为首次启动自动生成，允许显式采用恢复密钥（旧密钥与旧备份将被隔离而非删除） */
  canAdoptRecoveryKey: boolean
  /** 本机主密钥来源；null = 无封装件或来源不明（视为门禁关闭） */
  keyOrigin: 'generated' | 'legacy-migrated' | 'imported' | null
  /** 等待从网络备份恢复中（自动备份已暂停） */
  pending: boolean
  /** 本机现有备份目录数（采用恢复密钥时会被整体移入隔离目录） */
  localBackupDirs: number
}

/** 恢复密钥导出/导入结果（backup:auto:recoveryKey:export|import 返回） */
export interface RecoveryKeyOutcome {
  success: boolean
  filePath?: string
  /** 主密钥指纹（SHA-256 前 16 hex），用于人工核对两机是否同一密钥 */
  fingerprint?: string
  /** installed=新装为当前密钥 / matched=与本机现有密钥一致 / adopted=采用（本机旧密钥与旧备份已整体隔离） */
  status?: 'installed' | 'matched' | 'adopted'
  /** status='adopted' 时：本机旧密钥与本地备份链移入的隔离目录（可人工恢复） */
  quarantineDir?: string
  /** status='adopted' 时：移入隔离目录的本机备份目录数 */
  quarantinedBackups?: number
  error?: string
}

/** 内网同步状态（lansync:status 返回；Phase 1 最小版，设计 §5 刀3） */
export interface LanSyncStatus {
  enabled: boolean
  role: 'hub' | 'terminal' | ''
  terminalId: string
  sharedDir: string
  /** 以下四个最近时间均为毫秒（Date.now() 写入，见 lanSyncService），0 = 未发生；注意与 WCDB 的秒级口径区分 */
  lastDownEmitAt: number
  lastDownApplyAt: number
  lastUpEmitAt: number
  lastUpApplyAt: number
  backlogPending: number
  backlogIncoming: number
}

/** 失败 outbox 行（只读视图）：payload 原文不下发到渲染进程 */
export interface FailedOutboxItem {
  rowId: number
  /** 登记的 outbox 事件类型 */
  type: string
  eventSeq: number
  /** 最近一次失败审计的动作名（本机稳定标识） */
  failureAction: string
  /** 稳定错误码；审计原因为自由文本时为空串 */
  failureCode: string
  updatedAt: number
}

export interface CentralSyncStatus {
  enabled: boolean
  configured: boolean
  baseUrl: string
  workspaceId: string
  employeeId: string
  deviceId: string
  /** 服务端声明的角色（仅展示，绝不作为本机访问控制依据） */
  role: string
  /** 员工展示名（绑定返回，缺失时回退本地身份档案） */
  displayName: string
  backlogPending: number
  /** 终态失败、可经「重试失败同步项」正式重投的行数 */
  backlogFailed: number
  pullCursor: number
  lastUpAt: number
  lastDownAt: number
  /** 最近一次同步失败原因（脱敏文本）与时刻 */
  lastError: string
  lastErrorAt: number
  running: boolean
  schedulerRunning: boolean
  /** 是否已绑定且调度器会真正发起同步 */
  polling: boolean
  pollIntervalMin: number
}

export interface BackupImageDatMeta {
  version?: number
  aesSize?: number
  aes_size?: number
  xorSize?: number
  xor_size?: number
  rawSize?: number
  raw_size?: number
  flag?: number
}

export interface BackupManifest {
  version: 1
  type: 'weflow-db-snapshots'
  createdAt: string
  appVersion: string
  source: {
    wxid: string
    dbRoot: string
  }
  options?: BackupOptions
  databases: Array<{
    id: string
    kind: 'session' | 'contact' | 'emoticon' | 'message' | 'media' | 'sns' | 'hardlink'
    dbPath: string
    relativePath: string
    tables: Array<{
      name: string
      snapshotPath: string
      rows: number
      columns: number
      schemaSql?: string
    }>
  }>
  resources?: {
    images?: Array<{
      kind: 'image' | 'video' | 'file'
      id: string
      md5?: string
      sessionId?: string
      createTime?: number
      sourceFileName?: string
      archivePath: string
      targetRelativePath: string
      ext?: string
      size?: number
      datMeta?: BackupImageDatMeta
    }>
    videos?: Array<{
      kind: 'image' | 'video' | 'file'
      id: string
      md5?: string
      sourceFileName?: string
      archivePath: string
      targetRelativePath: string
      size?: number
    }>
    files?: Array<{
      kind: 'image' | 'video' | 'file'
      id: string
      sourceFileName?: string
      archivePath: string
      targetRelativePath: string
      size?: number
    }>
  }
}

export type CloseConfirmPayload = {
  canMinimizeToTray: boolean
  restoreMethod?: 'tray' | 'dock'
}

// ─── CRM 记录行结构（Phase 0 D3 成交/交付登记字段，宪法 §1.5/§1.6）────────────
// 时间戳统一 epoch ms；数值缺省 0、文本缺省 '' —— 前端展示层统一「未登记」。

/** 商机行（crm:opportunity:list/get，SELECT o.* JOIN account 带出 account_name/session_id） */
export interface OpportunityRecord {
  id: number
  account_id: number
  account_name?: string
  session_id?: string
  name: string
  product: string
  quantity: number
  amount: number
  stage: string
  status: string
  intent_score?: number
  last_signal_at: number
  expected_close_at?: number
  main_resistance?: string
  competitor?: string
  /** Phase 0 D3 成交登记列（宪法 §1.5） */
  source?: string
  type?: string                  // 整车 / 改装（'' = 未登记）
  amount_cny?: number            // RMB 结算额（业绩/报表统一口径）
  original_currency?: string     // 币种（'' 视同 CNY）
  original_amount?: number       // 原币金额（非 CNY 单）
  rate_note?: string             // 汇率说明/凭证（微信支付订单号、回单截图哈希等）
  main_model?: string            // 主型号（产品库口径）
  order_qty?: number             // 订单量
  shipped_qty?: number           // 实发量（售后补录）
  over_ship_reason?: string      // 超发原因（shipped_qty > order_qty 时必填）
  expected_ship_start?: number   // 预计发运区间起
  expected_ship_end?: number     // 预计发运区间止
  delivery_date?: number         // 交付日期（售后设备提醒起算基准）
  quote_version_id?: number | null // 绑定报价版本（逻辑外键 quotation.id）
  customer_id?: number | null    // 逻辑外键 customer.id
  custom_fields?: string         // JSON（补充型号 supplementary_models 等扩展属性）
  created_at: number
  updated_at: number
}

export interface OpportunityDealRegistration {
  amount_cny: number
  original_currency?: string
  original_amount?: number
  rate_note?: string
  main_model: string
  model_extra?: string
  order_qty: number
  expected_ship_start?: number
  expected_ship_end?: number
  delivery_date?: number
  type?: string
  quote_version_id?: number | null
  note?: string
  actor?: string
}

/** 报价单行（crm:entity:list 'quotation'；版本链 append-only，宪法 §1.6） */
export interface QuotationRecord {
  id: number
  contract_id: number
  total: number
  valid_until: number
  status: string
  items: string                  // JSON 行项 [{ product_id, model, name, qty, unit_price, subtotal }]
  attachment_path?: string       // 报价文件（未生成为空）
  custom_fields?: string
  version?: number               // 版本号（未走版本链时恒 1）
  effective_from?: number        // 生效期起（0 = 未登记）
  effective_to?: number          // 生效期止（0 = 未登记）
  artifact_hash?: string         // 非 PDF 报价产物 SHA-256
  pdf_hash?: string              // 文件哈希（未存证为空）
  created_at: number
}

/** 客户设备档案行（crm:entity:get 'customer'；设备档案 7 字段 + 质保 + 复购等级，宪法 §1.1/§3） */
export interface CustomerEquipmentRecord {
  id: number
  account_id?: number
  name?: string
  brand?: string                 // 设备品牌
  model?: string                 // 设备型号
  vehicle_age?: number           // 车龄（年）
  purchase_date?: number         // 购置日期（epoch ms，与 vehicle_age 二选一为真值）
  modified?: number              // 0/1 是否改装
  modified_date?: number         // 改装日期（epoch ms）
  battery_type?: string          // 电池类型
  last_maintenance_date?: number // 最近保养日期（epoch ms）
  warranty_start_date?: number   // 质保起算日（epoch ms）
  warranty_days?: number         // 质保期限（天）
  repeat_level?: string          // 复购等级（首购/复购老客/高频复购·升A）
  type?: string                  // dealer / end_user
  custom_fields?: string
  deleted?: number
}

/** 存量迁移逐条问题（crmMigrationService.MigrationIssue） */
export interface MigrationReportIssue {
  key: string
  reason: string
  detail?: string
}

/** 存量迁移报告汇总（migration_report.summary JSON，SSOT 快照，latest-wins 幂等 upsert） */
export interface MigrationReportSummary {
  total: number
  applied: number              // 本次实际写入（成功）
  alreadyDone: number          // 幂等跳过（已有/已挂接）
  skipped: number              // 无动作跳过（如成交无报价合同）
  failed: number
  conflicts: number
  customersCreated?: number    // m02 新建 customer 数
  identitiesCreated?: number   // m03 新建 identity 数
  linkedToCustomer?: number    // m03 挂接 customer 数
  pooled?: number              // m03 进线索池数
  wonOppCreated?: number       // m04 新建 won 商机数
  wonOppAlready?: number       // m04 已有 won 商机数（幂等）
  amountBackfilled?: number    // m04 amount_cny 回填数
  chainsNormalized?: number    // m04 版本链规范化数
  noQuoteContracts?: number    // m04 成交但无报价合同数
}

/** 存量迁移报告行（crm:migration:report:list，R 只读，migration_report SSOT） */
export interface MigrationReportRow {
  module: string
  title: string
  summary: MigrationReportSummary
  failures: MigrationReportIssue[]
  conflicts: MigrationReportIssue[]
  ranAt: number
}

/** 迁移失败/冲突项的「确认忽略」记录（migration_dismissal 表） */
export interface MigrationDismissal {
  module: string
  entityKey: string
  dismissedBy: string
  dismissedAt: number
}

/** 知识库条目（knowledge_base 表全列；治理列见宪法 §3 登记行） */
export interface KbEntryRecord {
  id: number
  category: string
  product_line?: string
  title: string
  content: string
  tags: string                   // JSON 数组字符串
  scene?: string
  status?: 'staging' | 'published' | 'rejected' | 'closed'
  authority?: 'official' | 'community'
  version?: number               // 引用展示版号 vN
  logical_id?: string | null      // 跨版本稳定链标识
  ttl_date?: string | null       // 到期日 YYYY-MM-DD（空 = 未设置）
  reviewed_by?: string | null
  reviewed_at?: number | null
  reject_reason?: string | null  // 拒绝必填，沉底留档
  source?: 'manual' | 'proposal' | string
  evidence_key?: string | null   // askKey 哈希 或 messageKey/出处摘要
  created_at: number
  updated_at: number
}

/** P0：服务地址专用端点结果（地址变化时主进程原子清除对应凭据） */
export interface ServiceAddressResult {
  ok?: boolean
  changed: boolean
  url: string
  credentialsCleared: boolean
  apiKey?: SecretStatus
  error?: string
}

/** H2：秘密状态（普通加载只回 hasValue/maskedValue，完整秘密不回传渲染层） */
export interface SecretStatus {
  hasValue: boolean
  masked: string
}

export interface WxidSecretStatus {
  hasDecryptKey: boolean
  hasImageXorKey: boolean
  hasImageAesKey: boolean
  updatedAt: number
}

export interface SecretStatusReport {
  dbKey: SecretStatus
  imageXorKey: SecretStatus
  imageAesKey: SecretStatus
  httpApiToken: SecretStatus
  aiModelApiKey: SecretStatus
  weiboCookie: SecretStatus
  telegramToken: SecretStatus
  wecomWebhook: SecretStatus
  wxidConfigs: Record<string, WxidSecretStatus>
}

export interface ElectronAPI {
  window: {
    minimize: () => void
    maximize: () => void
    isMaximized: () => Promise<boolean>
    onMaximizeStateChanged: (callback: (isMaximized: boolean) => void) => () => void
    close: () => void
    onCloseConfirmRequested: (callback: (payload: CloseConfirmPayload) => void) => () => void
    respondCloseConfirm: (action: 'tray' | 'quit' | 'cancel') => Promise<boolean>
    openAgreementWindow: () => Promise<boolean>
    completeOnboarding: () => Promise<boolean>
    openOnboardingWindow: (options?: { mode?: 'add-account' }) => Promise<boolean>
    openVideoPlayerWindow: (videoPath: string, videoWidth?: number, videoHeight?: number) => Promise<void>
    resizeToFitVideo: (videoWidth: number, videoHeight: number) => Promise<void>
    openImageViewerWindow: (imagePath: string, liveVideoPath?: string) => Promise<void>
    openChatHistoryWindow: (sessionId: string, messageId: number) => Promise<boolean>
    openChatHistoryPayloadWindow: (payload: { sessionId: string; title?: string; recordList: ChatRecordItem[] }) => Promise<boolean>
    getChatHistoryPayload: (payloadId: string) => Promise<{ success: boolean; payload?: { sessionId: string; title?: string; recordList: ChatRecordItem[] }; error?: string }>
    openSessionChatWindow: (sessionId: string, options?: SessionChatWindowOpenOptions) => Promise<boolean>
  }
  config: {
    /** H2：主进程白名单把关——秘密键/主进程托管键/未知键一律拒绝 */
    get: (key: string) => Promise<unknown>
    set: (key: string, value: unknown) => Promise<void>
    clear: () => Promise<boolean>
  }
  /** H2：用户录入秘密的专用通道——读取只回 hasValue/maskedValue，完整秘密永不回传渲染层 */
  secret: {
    getStatus: () => Promise<SecretStatusReport>
    setDbKey: (value: string) => Promise<SecretStatus>
    setImageKeys: (patch: { xorKey?: number | null; aesKey?: string | null }) => Promise<{ imageXorKey: SecretStatus; imageAesKey: SecretStatus }>
    setHttpApiToken: (value: string) => Promise<SecretStatus>
    setAiModelApiKey: (value: string) => Promise<SecretStatus>
    setWxidConfig: (wxid: string, patch: { decryptKey?: string | null; imageAesKey?: string | null; imageXorKey?: number | null }) => Promise<WxidSecretStatus>
    removeWxidConfig: (wxid: string) => Promise<{ ok: boolean; removed: number; undoToken?: string }>
    undoRemoveWxidConfig: (token: string) => Promise<{ ok: boolean; restored: number }>
    setTelegramToken: (value: string) => Promise<SecretStatus>
    setWecomWebhook: (value: string) => Promise<SecretStatus>
  }
  /** H2：账号切换/自动连接由主进程依已保存配置执行（wxidConfigs 密钥不经过渲染层） */
  account: {
    switchTo: (wxid: string) => Promise<{ ok: boolean; reason?: string }>
    applySavedKey: () => Promise<{ hasDbPath: boolean; hasKey: boolean; myWxid: string; onboardingDone: boolean; appliedSavedKey: boolean }>
  }
  /** P0：受限服务地址专用端点——地址变化时主进程原子清除对应凭据 */
  serviceAddr: {
    setAiModelBaseUrl: (url: string) => Promise<ServiceAddressResult>
    setAiInsightBaseUrl: (url: string) => Promise<ServiceAddressResult>
    setCentralSyncBaseUrl: (url: string) => Promise<ServiceAddressResult>
  }
  /** P0：dbPath 专用端点（对话框批准路径 / 主进程验证过的自动检测结果） */
  dbPathGate: {
    setFromDialog: (path: string) => Promise<{ ok: boolean; path?: string; reason?: string }>
    setVerified: (path: string) => Promise<{ ok: boolean; path?: string; reason?: string }>
  }
  /** P1b：导出根目录专用选择（主进程弹对话框 → 授权 + 持久化根 + 更新偏好） */
  exportGate: {
    chooseRoot: () => Promise<{ canceled: boolean; ok?: boolean; path?: string; error?: string }>
  }
  auth: {
    hello: (message?: string) => Promise<{ success: boolean; error?: string }>
    verifyEnabled: () => Promise<boolean>
    unlock: (password: string) => Promise<{ success: boolean; error?: string }>
    enableLock: (password: string) => Promise<{ success: boolean; error?: string }>
    disableLock: (password: string) => Promise<{ success: boolean; error?: string }>
    changePassword: (oldPassword: string, newPassword: string) => Promise<{ success: boolean; error?: string }>
    setHelloSecret: (password: string) => Promise<{ success: boolean }>
    clearHelloSecret: () => Promise<{ success: boolean }>
    isLockMode: () => Promise<boolean>
    /** H2：应用锁密码哈希写点（authPassword 不再经通用 config:set） */
    setPasswordHash: (passwordHash: string) => Promise<{ success: boolean; error?: string }>
    setUseHello: (useHello: boolean) => Promise<{ success: boolean; error?: string }>
  }
  identity: {
    /** nameAliases = 归属别名（绑定中央身份时为该中央 displayName，解绑/未绑定为 []）；
     *  employeeId = 绑定的中央员工 id（owner_employee_id 权威归属核对依据，未绑定为 ''） */
    get: () => Promise<{ name: string; role: string; actorLabel: string; shouldPromptOnboarding: boolean; nameAliases: string[]; employeeId: string }>
    set: (payload: { name: string; role?: string }) => Promise<{ ok: boolean; data?: { name: string; role: string; actorLabel: string; nameAliases: string[]; employeeId: string }; code?: string; message?: string }>
    dismissOnboarding: () => Promise<{ ok: boolean }>
  }
  /** 内网同步（Phase 1 最小版，设计 §5 刀3）：lansync:status / lansync:run */
  lanSync: {
    status: () => Promise<{ success: boolean; status?: LanSyncStatus; error?: string }>
    runNow: () => Promise<{ success: boolean; result?: unknown; error?: string }>
  }
  /** 企业同步（Phase 3a）：中央工作区绑定与 HTTP adapter */
  centralSync: {
    status: () => Promise<{ success: boolean; status?: CentralSyncStatus; error?: string }>
    claim: (payload: { baseUrl: string; inviteCode: string; deviceName?: string }) => Promise<{ success: boolean; principal?: { workspaceId: string; employeeId: string; deviceId: string; displayName: string; role: string }; error?: string }>
    /** 解绑：revoked=服务端是否确认吊销；localCleared=本机凭证是否已清；两者不同时为真即表示解绑未完成 */
    disconnect: (payload?: { force?: boolean }) => Promise<{ success: boolean; revoked?: boolean; localCleared?: boolean; error?: string }>
    runNow: () => Promise<{ success: boolean; result?: { enabled: boolean; pushed: number; rejected: number; applied: number; error?: string }; error?: string }>
    /** 失败项清单（字段已裁剪：无 payload 原文，只有行号/类型/序号/失败分类/稳定码） */
    failed: (payload?: { limit?: number }) => Promise<{ success: boolean; items?: FailedOutboxItem[]; error?: string }>
    /** 正式重投：只把 failed 行原子翻回 pending，随后跑一拍同步；重复点击幂等 */
    /**
     * 失败行重投。`success` 只表示「failed → pending 的翻转被接受」；**是否同步成功必须看 `retryOutcome`**
     * （sent/pending/failed/unconfigured/unknown，由主进程回读该行最终状态得出）。`syncError` 已脱敏。
     */
    retryFailed: (payload: { rowId: number }) => Promise<{
      success: boolean; rowId?: number; code?: string; retryCode?: string
      deliveryStatus?: 'pending' | 'failed' | 'sent' | 'unknown'
      retryOutcome?: 'sent' | 'pending' | 'failed' | 'unconfigured' | 'unknown'
      syncConfigured?: boolean; syncError?: string
      result?: { enabled: boolean; pushed: number; rejected: number; applied: number }
      error?: string
    }>
  }
  dialog: {
    openFile: (options?: Electron.OpenDialogOptions) => Promise<Electron.OpenDialogReturnValue>
    openDirectory: (options?: Electron.OpenDialogOptions) => Promise<Electron.OpenDialogReturnValue>
    saveFile: (options?: Electron.SaveDialogOptions) => Promise<Electron.SaveDialogReturnValue>
  }
  shell: {
    openPath: (path: string) => Promise<string>
    showItemInFolder: (path: string) => Promise<{ ok: boolean; reason?: string }>
    openExternal: (url: string) => Promise<{ success: boolean; error?: string }>
  }
  app: {
    getDownloadsPath: () => Promise<string>
    getVersion: () => Promise<string>
    getLaunchAtStartupStatus: () => Promise<{ enabled: boolean; supported: boolean; reason?: string }>
    setLaunchAtStartup: (enabled: boolean) => Promise<{
      success: boolean
      enabled: boolean
      supported: boolean
      reason?: string
      error?: string
    }>
    checkForUpdates: () => Promise<{ hasUpdate: boolean; version?: string; releaseNotes?: string }>
    downloadAndInstall: () => Promise<void>
    ignoreUpdate: (version: string) => Promise<{ success: boolean }>
    onDownloadProgress: (callback: (progress: number) => void) => () => void
    onUpdateAvailable: (callback: (info: { version: string; releaseNotes: string }) => void) => () => void
  }
  notification: {
    show: (data: { title: string; content: string; avatarUrl?: string; sessionId: string; channel?: string; insightRecordId?: string; targetRoute?: string }) => Promise<{ success?: boolean; error?: string } | void>
    close: () => Promise<void>
    click: (payload: string | { sessionId?: string; channel?: string; insightRecordId?: string; targetRoute?: string }) => void
    ready: () => void
    resize: (width: number, height: number) => void
    glassRect: (payload: {
      card: { x: number; y: number; width: number; height: number }
      bands: Array<{ id: number; x: number; y: number; width: number; height: number }>
      dpr: number
      cornerRadius: number
      blurSigma: number
      displacementScale: number
      aberrationIntensity: number
      saturation: number
    }) => void
    glassHide: () => void
    onLuma: (
      callback: (
        bands: Record<string, { r: number; g: number; b: number; darkTail: number; lightTail: number }>
      ) => void
    ) => () => void
    onShow: (callback: (event: any, data: any) => void) => () => void
    onNavigateToSession: (callback: (sessionId: string) => void) => () => void
    onNavigateToRoute: (callback: (route: string) => void) => () => void
  }
  log: {
    getPath: () => Promise<string>
    read: () => Promise<{ success: boolean; content?: string; error?: string }>
    clear: () => Promise<{ success: boolean; error?: string }>
    debug: (data: any) => void
  }
  diagnostics: {
    recordResourceStats: (payload: unknown) => Promise<{ success: boolean; count?: number }>
    clearResourceStats: () => Promise<{ success: boolean }>
  }
  dbPath: {
    autoDetect: () => Promise<{ success: boolean; path?: string; error?: string }>
    scanWxids: (rootPath: string) => Promise<WxidInfo[]>
    scanWxidCandidates: (rootPath: string) => Promise<WxidInfo[]>
  }
  wcdb: {
    testConnection: (dbPath: string, hexKey: string, wxid: string) => Promise<{ success: boolean; error?: string; sessionCount?: number }>
    open: (dbPath: string, hexKey: string, wxid: string) => Promise<boolean>
    close: () => Promise<boolean>

  }
  backup: {
    create: (payload: { outputPath: string; options?: BackupOptions }) => Promise<{
      success: boolean
      filePath?: string
      manifest?: BackupManifest
      error?: string
    }>
    inspect: (payload: { archivePath: string }) => Promise<{
      success: boolean
      manifest?: BackupManifest
      error?: string
    }>
    restore: (payload: { archivePath: string }) => Promise<{
      success: boolean
      inserted?: number
      ignored?: number
      skipped?: number
      error?: string
    }>
    onProgress: (callback: (progress: BackupProgress) => void) => () => void
    /** 自动备份（PRD 1.1）：手动立即备份（失败 error 含具体失败阶段） */
    autoRunNow: () => Promise<{ success: boolean; result?: unknown; error?: string }>
    /** 自动备份状态：上次时间 / 两层状态 / 下次计划 / 密钥封装方式 */
    autoStatus: () => Promise<{ success: boolean; status?: AutoBackupStatus; error?: string }>
    /** 自动备份恢复：省略 backupId=最新链；source='network' 从配置的网络备份路径恢复（新机器先导入恢复密钥） */
    autoRestore: (payload?: { backupId?: string; source?: 'local' | 'network' }) => Promise<{ success: boolean; result?: unknown; error?: string }>
    /** 导出恢复密钥（口令加密；未带 filePath 弹保存对话框） */
    recoveryKeyExport: (payload: { passphrase: string; filePath?: string }) => Promise<RecoveryKeyOutcome>
    /** 导入恢复密钥（错误口令明确失败不动本机密钥；已有不同密钥默认拒绝覆盖；
     *  adopt=true 仅在新机首次恢复门禁开放且用户显式确认时使用：采用并隔离本机旧密钥与旧备份；
     *  未带 filePath 弹选择对话框） */
    recoveryKeyImport: (payload: { passphrase: string; filePath?: string; adopt?: boolean }) => Promise<RecoveryKeyOutcome>
  }
  key: {
    autoGetDbKey: () => Promise<{ success: boolean; key?: string; error?: string; logs?: string[] }>
    autoGetImageKey: (manualDir?: string, wxid?: string) => Promise<{ success: boolean; xorKey?: number; aesKey?: string; verified?: boolean; error?: string }>
    scanImageKeyFromMemory: (userDir: string) => Promise<{ success: boolean; xorKey?: number; aesKey?: string; error?: string }>
    onDbKeyStatus: (callback: (payload: { message: string; level: number }) => void) => () => void
    onImageKeyStatus: (callback: (payload: { message: string }) => void) => () => void
  }
  chat: {
    connect: () => Promise<{ success: boolean; error?: string }>
    getSessions: () => Promise<{ success: boolean; sessions?: ChatSession[]; error?: string }>
    markAllSessionsRead: () => Promise<{ success: boolean; error?: string }>
    getAntiRevokeSessions: () => Promise<{ success: boolean; sessions?: ChatSession[]; error?: string }>
    getSessionStatuses: (usernames: string[]) => Promise<{
      success: boolean
      map?: Record<string, { isFolded?: boolean; isMuted?: boolean }>
      error?: string
    }>
    getExportTabCounts: () => Promise<{
      success: boolean
      counts?: {
        private: number
        group: number
        official: number
        former_friend: number
        blocked?: number
      }
      error?: string
    }>
    getContactTypeCounts: () => Promise<{
      success: boolean
      counts?: {
        private: number
        group: number
        official: number
        former_friend: number
        blocked?: number
      }
      error?: string
    }>
    getSessionMessageCounts: (sessionIds: string[], options?: { preferHintCache?: boolean; bypassSessionCache?: boolean }) => Promise<{
      success: boolean
      counts?: Record<string, number>
      error?: string
    }>
    enrichSessionsContactInfo: (
      usernames: string[],
      options?: { skipDisplayName?: boolean; onlyMissingAvatar?: boolean }
    ) => Promise<{
      success: boolean
      contacts?: Record<string, { displayName?: string; avatarUrl?: string }>
      error?: string
    }>
    getMessages: (sessionId: string, offset?: number, limit?: number, startTime?: number, endTime?: number, ascending?: boolean) => Promise<{
      success: boolean;
      messages?: Message[];
      hasMore?: boolean;
      nextOffset?: number;
      error?: string
    }>
    getLatestMessages: (sessionId: string, limit?: number) => Promise<{
      success: boolean
      messages?: Message[]
      hasMore?: boolean
      nextOffset?: number
      error?: string
    }>
    getNewMessages: (sessionId: string, minTime: number, limit?: number, cursor?: {
      createTime?: number
      sortSeq?: number
      localId?: number
      serverId?: number | string
      serverIdRaw?: string
    }) => Promise<{
      success: boolean
      messages?: Message[]
      error?: string
    }>
    getCachedMessages: (sessionId: string) => Promise<{
      success: boolean
      messages?: Message[]
      error?: string
    }>
    clearCurrentAccountData: (options: { clearCache?: boolean; clearExports?: boolean }) => Promise<{
      success: boolean
      removedPaths?: string[]
      warning?: string
      error?: string
    }>
    /** §2.40 微信号分库：当前账号业务数据归档（两库改名 .archived-<时间戳>.db 后重开新空库） */
    archiveBusinessData: () => Promise<{
      success: boolean
      archived?: Array<{ from: string; to: string }>
      error?: string
    }>
    getContact: (username: string) => Promise<Contact | null>
    getContactAvatar: (username: string, chatroomId?: string) => Promise<{ avatarUrl?: string; displayName?: string } | null>
    updateMessage: (sessionId: string, localId: number, createTime: number, newContent: string) => Promise<{ success: boolean; error?: string }>
    deleteMessage: (sessionId: string, localId: number, createTime: number, dbPathHint?: string) => Promise<{ success: boolean; error?: string }>
    checkAntiRevokeTriggers: (sessionIds: string[]) => Promise<{
      success: boolean
      rows?: Array<{ sessionId: string; success: boolean; installed?: boolean; error?: string }>
      error?: string
    }>
    installAntiRevokeTriggers: (sessionIds: string[]) => Promise<{
      success: boolean
      rows?: Array<{ sessionId: string; success: boolean; alreadyInstalled?: boolean; error?: string }>
      error?: string
    }>
    uninstallAntiRevokeTriggers: (sessionIds: string[]) => Promise<{
      success: boolean
      rows?: Array<{ sessionId: string; success: boolean; error?: string }>
      error?: string
    }>
    resolveTransferDisplayNames: (chatroomId: string, payerUsername: string, receiverUsername: string) => Promise<{ payerName: string; receiverName: string }>
    getContacts: (options?: { lite?: boolean }) => Promise<{
      success: boolean
      contacts?: ContactInfo[]
      error?: string
    }>
    getMyAvatarUrl: () => Promise<{ success: boolean; avatarUrl?: string; error?: string }>
    downloadEmoji: (cdnUrl: string, md5?: string) => Promise<{ success: boolean; localPath?: string; error?: string }>
    searchMessages: (keyword: string, sessionId?: string, limit?: number, offset?: number, beginTimestamp?: number, endTimestamp?: number) => Promise<{ success: boolean; messages?: Message[]; error?: string }>
    close: () => Promise<boolean>
    getSessionDetail: (sessionId: string) => Promise<{
      success: boolean
      detail?: {
        wxid: string
        displayName: string
        remark?: string
        nickName?: string
        alias?: string
        avatarUrl?: string
        messageCount: number
        firstMessageTime?: number
        latestMessageTime?: number
        messageTables: { dbName: string; tableName: string; count: number }[]
      }
      error?: string
    }>
    getSessionDetailFast: (sessionId: string) => Promise<{
      success: boolean
      detail?: {
        wxid: string
        displayName: string
        remark?: string
        nickName?: string
        alias?: string
        avatarUrl?: string
        messageCount: number
      }
      error?: string
    }>
    getSessionDetailExtra: (sessionId: string) => Promise<{
      success: boolean
      detail?: {
        firstMessageTime?: number
        latestMessageTime?: number
        messageTables: { dbName: string; tableName: string; count: number }[]
      }
      error?: string
    }>
    getExportSessionStats: (
      sessionIds: string[],
      options?: {
        includeRelations?: boolean
        forceRefresh?: boolean
        allowStaleCache?: boolean
        preferAccurateSpecialTypes?: boolean
        cacheOnly?: boolean
        beginTimestamp?: number
        endTimestamp?: number
      }
    ) => Promise<{
      success: boolean
      data?: Record<string, {
        totalMessages: number
        voiceMessages: number
        imageMessages: number
        videoMessages: number
        emojiMessages: number
        /** 文件类消息数量 */
        fileMessages: number
        transferMessages: number
        redPacketMessages: number
        callMessages: number
        firstTimestamp?: number
        lastTimestamp?: number
        privateMutualGroups?: number
        groupMemberCount?: number
        groupMyMessages?: number
        groupActiveSpeakers?: number
        groupMutualFriends?: number
      }>
      cache?: Record<string, {
        updatedAt: number
        stale: boolean
        includeRelations: boolean
        source: 'memory' | 'disk' | 'fresh'
        rangeFiltered?: boolean
      }>
      needsRefresh?: string[]
      error?: string
    }>
    getGroupMyMessageCountHint: (chatroomId: string) => Promise<{
      success: boolean
      count?: number
      updatedAt?: number
      source?: 'memory' | 'disk'
      error?: string
    }>
    getImageData: (sessionId: string, msgId: string) => Promise<{ success: boolean; data?: string; error?: string }>
    getVoiceData: (sessionId: string, msgId: string, createTime?: number, serverId?: string | number) => Promise<{ success: boolean; data?: string; error?: string }>
    getAllVoiceMessages: (sessionId: string) => Promise<{ success: boolean; messages?: Message[]; error?: string }>
    getAllImageMessages: (sessionId: string) => Promise<{
      success: boolean
      images?: { imageMd5?: string; imageDatName?: string; createTime?: number }[]
      error?: string
    }>
    getMessageDates: (sessionId: string) => Promise<{ success: boolean; dates?: string[]; error?: string }>
    getMessageDateCounts: (sessionId: string) => Promise<{ success: boolean; counts?: Record<string, number>; error?: string }>
    getResourceMessages: (options?: {
      sessionId?: string
      types?: Array<'image' | 'video' | 'voice' | 'file'>
      beginTimestamp?: number
      endTimestamp?: number
      limit?: number
      offset?: number
    }) => Promise<{
      success: boolean
      items?: Array<Message & {
        sessionId: string
        sessionDisplayName?: string
        resourceType: 'image' | 'video' | 'voice' | 'file'
      }>
      total?: number
      hasMore?: boolean
      error?: string
    }>
    getMediaStream: (options?: {
      sessionId?: string
      mediaType?: 'image' | 'video' | 'all'
      beginTimestamp?: number
      endTimestamp?: number
      limit?: number
      offset?: number
    }) => Promise<{
      success: boolean
      items?: Array<{
        sessionId: string
        sessionDisplayName?: string
        mediaType: 'image' | 'video'
        localId: number
        serverId?: string
        createTime: number
        localType: number
        senderUsername?: string
        isSend?: number | null
        imageMd5?: string
        imageDatName?: string
        videoMd5?: string
        content?: string
      }>
      hasMore?: boolean
      nextOffset?: number
      streamSource?: 'native' | 'pageCache' | 'inflight'
      pageCacheHit?: boolean
      inflightMerged?: boolean
      nativeLimit?: number
      nativeRows?: number
      elapsedMs?: number
      error?: string
    }>
    resolveVoiceCache: (sessionId: string, msgId: string) => Promise<{ success: boolean; hasCache: boolean; data?: string }>
    getVoiceTranscript: (sessionId: string, msgId: string, createTime?: number, serverId?: string | number) => Promise<{ success: boolean; transcript?: string; error?: string }>
    onVoiceTranscriptPartial: (callback: (payload: { sessionId?: string; msgId: string; createTime?: number; text: string }) => void) => () => void
    getMessage: (sessionId: string, localId: number) => Promise<{ success: boolean; message?: Message; error?: string }>
    getMyFootprintStats: (
      beginTimestamp: number,
      endTimestamp: number,
      options?: {
        myWxid?: string
        privateSessionIds?: string[]
        groupSessionIds?: string[]
        mentionLimit?: number
        privateLimit?: number
        mentionMode?: 'text_at_me' | string
      }
    ) => Promise<{
      success: boolean
      data?: {
        summary: {
          private_inbound_people: number
          private_replied_people: number
          private_outbound_people: number
          private_reply_rate: number
          mention_count: number
          mention_group_count: number
        }
        private_sessions: Array<{
          session_id: string
          incoming_count: number
          outgoing_count: number
          replied: boolean
          first_incoming_ts: number
          first_reply_ts: number
          latest_ts: number
          anchor_local_id: number
          anchor_create_time: number
          displayName?: string
          avatarUrl?: string
        }>
        private_segments: Array<{
          session_id: string
          segment_index: number
          start_ts: number
          end_ts: number
          duration_sec: number
          incoming_count: number
          outgoing_count: number
          message_count: number
          replied: boolean
          first_incoming_ts: number
          first_reply_ts: number
          latest_ts: number
          anchor_local_id: number
          anchor_create_time: number
          displayName?: string
          avatarUrl?: string
        }>
        mentions: Array<{
          session_id: string
          local_id: number
          create_time: number
          sender_username: string
          message_content: string
          source: string
          sessionDisplayName?: string
          senderDisplayName?: string
          senderAvatarUrl?: string
        }>
        mention_groups: Array<{
          session_id: string
          count: number
          latest_ts: number
          displayName?: string
          avatarUrl?: string
        }>
        diagnostics: {
          truncated: boolean
          scanned_dbs: number
          elapsed_ms: number
        }
      }
      error?: string
    }>
    exportMyFootprint: (
      beginTimestamp: number,
      endTimestamp: number,
      format: 'csv' | 'json',
      filePath: string
    ) => Promise<{
      success: boolean
      filePath?: string
      error?: string
    }>
    onWcdbChange: (callback: (event: any, data: { type: string; json: string }) => void) => () => void
  }
  biz: {
    listAccounts: (account?: string) => Promise<any[]>
    listAccountHealth: (account?: string) => Promise<any>
    listMessages: (username: string, account?: string, limit?: number, offset?: number) => Promise<any[]>
    listPayRecords: (account?: string, limit?: number, offset?: number) => Promise<any[]>
  }

  image: {
    decrypt: (payload: {
      sessionId?: string
      imageMd5?: string
      imageDatName?: string
      createTime?: number
      force?: boolean
      preferFilePath?: boolean
      hardlinkOnly?: boolean
      disableUpdateCheck?: boolean
      allowCacheIndex?: boolean
      allowCachePromotion?: boolean
      allowFilesystemScan?: boolean
      suppressEvents?: boolean
    }) => Promise<{ success: boolean; localPath?: string; liveVideoPath?: string; error?: string; failureKind?: 'not_found' | 'decrypt_failed' }>
    resolveCache: (payload: {
      sessionId?: string
      imageMd5?: string
      imageDatName?: string
      createTime?: number
      preferFilePath?: boolean
      hardlinkOnly?: boolean
      disableUpdateCheck?: boolean
      allowCacheIndex?: boolean
      allowCachePromotion?: boolean
      allowFilesystemScan?: boolean
      suppressEvents?: boolean
    }) => Promise<{ success: boolean; localPath?: string; hasUpdate?: boolean; liveVideoPath?: string; error?: string; failureKind?: 'not_found' | 'decrypt_failed' }>
    resolveCacheBatch: (
      payloads: Array<{ sessionId?: string; imageMd5?: string; imageDatName?: string; createTime?: number; preferFilePath?: boolean; hardlinkOnly?: boolean }>,
      options?: { disableUpdateCheck?: boolean; allowCacheIndex?: boolean; allowCachePromotion?: boolean; allowFilesystemScan?: boolean; preferFilePath?: boolean; hardlinkOnly?: boolean; suppressEvents?: boolean }
    ) => Promise<{
      success: boolean
      rows?: Array<{ success: boolean; localPath?: string; hasUpdate?: boolean; error?: string; failureKind?: 'not_found' | 'decrypt_failed' }>
      error?: string
    }>
    preload: (
      payloads: Array<{ sessionId?: string; imageMd5?: string; imageDatName?: string; createTime?: number }>,
      options?: { allowDecrypt?: boolean; allowCacheIndex?: boolean; allowFilesystemScan?: boolean; emitResolved?: boolean; scope?: string; priority?: 'high' | 'normal' | 'low' }
    ) => Promise<{
      success: true
      requested: number
      accepted: number
      mergedQueued: number
      skippedActive: number
      skippedPending: number
      ignoredCanceled: number
      rejectedCapacity: number
      deferred: number
      handledIdentities: string[]
      acceptedIdentities: string[]
      mergedQueuedIdentities: string[]
      skippedActiveIdentities: string[]
      skippedPendingIdentities: string[]
      rejectedIdentities: string[]
      deferredIdentities: string[]
    }>
    cancelPreloadScope: (scope: string) => Promise<boolean>
    getPreloadStats: () => Promise<{
      queued: number
      pending: number
      activeCache: number
      activeDecrypt: number
      queuedIdentities: number
      queuedCache: number
      queuedDecrypt: number
      queuedHigh: number
      queuedNormal: number
      queuedLow: number
      activeIdentities: number
      queuedScopes: number
      activeScopes: number
      canceledScopes: number
      highWater: {
        queued: number
        pending: number
        queuedCache: number
        queuedDecrypt: number
        queuedHigh: number
        queuedNormal: number
        queuedLow: number
        activeCache: number
        activeDecrypt: number
        activeIdentities: number
      }
      totals: {
        accepted: number
        mergedQueued: number
        skippedActive: number
        ignoredCanceled: number
        droppedQueued: number
        canceledQueued: number
        canceledActive: number
        promotedActive: number
        rejectedCapacity: number
        deferredLowPriority: number
        lowPriorityIdleDeferrals: number
        skippedPending: number
        forcedThumbnailRefreshes: number
        forcedThumbnailRefreshFailures: number
        lowPriorityRejected: number
        activeCacheSnapshots: number
        activeCacheSnapshotSkipped: number
        activeCacheSnapshotCanceled: number
        started: number
        completed: number
      }
    }>
    preloadHardlinkMd5s: (md5List: string[], options?: { chunkSize?: number; yieldMs?: number; filesystemFallback?: boolean }) => Promise<boolean>
    onUpdateAvailable: (callback: (payload: { cacheKey: string; sessionId?: string; createTime?: number; imageMd5?: string; imageDatName?: string }) => void) => () => void
    onCacheResolved: (callback: (payload: { cacheKey: string; sessionId?: string; createTime?: number; imageMd5?: string; imageDatName?: string; localPath: string }) => void) => () => void
    onDecryptProgress: (callback: (payload: {
      cacheKey: string
      imageMd5?: string
      imageDatName?: string
      stage: 'queued' | 'locating' | 'decrypting' | 'writing' | 'done' | 'failed'
      progress: number
      status: 'running' | 'done' | 'error'
      message?: string
    }) => void) => () => void
  }
  video: {
    getVideoInfo: (videoMd5: string, options?: { includePoster?: boolean; posterFormat?: 'dataUrl' | 'fileUrl' }) => Promise<{
      success: boolean
      exists: boolean
      videoUrl?: string
      coverUrl?: string
      thumbUrl?: string
      error?: string
    }>
    getVideoInfoBatch: (videoMd5List: string[], options?: { includePoster?: boolean; posterFormat?: 'dataUrl' | 'fileUrl' }) => Promise<{
      success: boolean
      rows?: Array<{
        index: number
        md5: string
        success: boolean
        exists: boolean
        videoUrl?: string
        coverUrl?: string
        thumbUrl?: string
        error?: string
      }>
      error?: string
    }>
    parseVideoMd5: (content: string) => Promise<{
      success: boolean
      md5?: string
      error?: string
    }>
  }
  // ─── Hermes 只读智能体（设计-Hermes-MVP 智能体第一刀）：只读任务四接口 + 进度事件 ──
  // 零发送类通道：AI 碰不到发送键；任务真源在主进程内存（不落盘）
  hermes: {
    startTask: (payload: {
      goal: string
      context?: HermesTaskContextOption
      contextLabel?: string
    }) => Promise<HermesTaskStartResult>
    continueTask: (payload: { taskId: string; question: string }) => Promise<HermesTaskStartResult>
    cancelTask: (taskId: string) => Promise<HermesTaskCancelResult>
    getTask: (taskId: string) => Promise<HermesTaskGetResult>
    /** 进度事件：返回退订函数（只移除本次注册的 listener） */
    onTaskProgress: (callback: (task: HermesTaskSnapshot) => void) => () => void
  }
  analytics: {
    getOverallStatistics: (force?: boolean) => Promise<{
      success: boolean
      data?: {
        totalMessages: number
        textMessages: number
        imageMessages: number
        voiceMessages: number
        videoMessages: number
        emojiMessages: number
        otherMessages: number
        sentMessages: number
        receivedMessages: number
        firstMessageTime: number | null
        lastMessageTime: number | null
        activeDays: number
        messageTypeCounts: Record<number, number>
      }
      error?: string
    }>
    getContactRankings: (limit?: number, beginTimestamp?: number, endTimestamp?: number) => Promise<{
      success: boolean
      data?: Array<{
        username: string
        displayName: string
        avatarUrl?: string
        wechatId?: string
        messageCount: number
        sentCount: number
        receivedCount: number
        lastMessageTime: number | null
      }>
      error?: string
    }>
    getTimeDistribution: () => Promise<{
      success: boolean
      data?: {
        hourlyDistribution: Record<number, number>
        weekdayDistribution: Record<number, number>
        monthlyDistribution: Record<string, number>
      }
      error?: string
    }>
    getSelfSentDailyDistribution: (beginTimestamp?: number, endTimestamp?: number, force?: boolean) => Promise<{
      success: boolean
      data?: {
        unit: 'day'
        dailyDistribution: Record<string, number>
        totalMessages: number
        firstMessageTime: number | null
        lastMessageTime: number | null
        beginTimestamp: number
        endTimestamp: number
      }
      error?: string
    }>
    getExcludedUsernames: () => Promise<{
      success: boolean
      data?: string[]
      error?: string
    }>
    setExcludedUsernames: (usernames: string[]) => Promise<{
      success: boolean
      data?: string[]
      error?: string
    }>
    getExcludeCandidates: () => Promise<{
      success: boolean
      data?: Array<{
        username: string
        displayName: string
        avatarUrl?: string
        wechatId?: string
      }>
      error?: string
    }>
    onProgress: (callback: (payload: { status: string; progress: number }) => void) => () => void
  }
  cache: {
    clearAnalytics: () => Promise<{ success: boolean; error?: string }>
    clearImages: () => Promise<{ success: boolean; error?: string }>
    clearAll: () => Promise<{ success: boolean; error?: string }>
  }
  groupAnalytics: {
    getGroupChats: () => Promise<{
      success: boolean
      data?: Array<{
        username: string
        displayName: string
        memberCount: number
        avatarUrl?: string
      }>
      error?: string
    }>
    getGroupMembers: (chatroomId: string) => Promise<{
      success: boolean
      data?: Array<{
        username: string
        displayName: string
        avatarUrl?: string
        nickname?: string
        alias?: string
        remark?: string
        groupNickname?: string
        isOwner?: boolean
      }>
      error?: string
    }>
    getGroupMembersPanelData: (
      chatroomId: string,
      options?: { forceRefresh?: boolean; includeMessageCounts?: boolean }
    ) => Promise<{
      success: boolean
      data?: Array<{
        username: string
        displayName: string
        avatarUrl?: string
        nickname?: string
        alias?: string
        remark?: string
        groupNickname?: string
        isOwner?: boolean
        isFriend: boolean
        messageCount: number
      }>
      fromCache?: boolean
      updatedAt?: number
      error?: string
    }>
    getGroupMessageRanking: (chatroomId: string, limit?: number, startTime?: number, endTime?: number) => Promise<{
      success: boolean
      data?: Array<{
        member: {
          username: string
          displayName: string
          avatarUrl?: string
        }
        messageCount: number
      }>
      error?: string
    }>
    getGroupActiveHours: (chatroomId: string, startTime?: number, endTime?: number) => Promise<{
      success: boolean
      data?: {
        hourlyDistribution: Record<number, number>
      }
      error?: string
    }>
    getGroupMediaStats: (chatroomId: string, startTime?: number, endTime?: number) => Promise<{
      success: boolean
      data?: {
        typeCounts: Array<{
          type: number
          name: string
          count: number
        }>
        total: number
      }
      error?: string
    }>
    getGroupMemberAnalytics: (chatroomId: string, memberUsername: string, startTime?: number, endTime?: number) => Promise<{
      success: boolean
      data?: {
        statistics: {
          totalMessages: number
          textMessages: number
          imageMessages: number
          voiceMessages: number
          videoMessages: number
          emojiMessages: number
          otherMessages: number
          sentMessages: number
          receivedMessages: number
          firstMessageTime: number | null
          lastMessageTime: number | null
          activeDays: number
          messageTypeCounts: Record<number, number>
        }
        timeDistribution: Record<number, number>
      }
      error?: string
    }>
    getGroupMemberMessages: (
      chatroomId: string,
      memberUsername: string,
      options?: { startTime?: number; endTime?: number; limit?: number; cursor?: number }
    ) => Promise<{
      success: boolean
      data?: {
        messages: Message[]
        hasMore: boolean
        nextCursor: number
      }
      error?: string
    }>
    exportGroupMembers: (chatroomId: string, outputPath: string) => Promise<{
      success: boolean
      count?: number
      error?: string
    }>
    exportGroupMemberMessages: (
      chatroomId: string,
      memberUsername: string,
      outputPath: string,
      startTime?: number,
      endTime?: number
    ) => Promise<{
      success: boolean
      count?: number
      error?: string
    }>
  }
  annualReport: {
    getAvailableYears: () => Promise<{
      success: boolean
      data?: number[]
      error?: string
    }>
    startAvailableYearsLoad: () => Promise<{
      success: boolean
      taskId?: string
      reused?: boolean
      snapshot?: {
        years?: number[]
        done: boolean
        error?: string
        canceled?: boolean
        strategy?: 'cache' | 'native' | 'hybrid'
        phase?: 'cache' | 'native' | 'scan' | 'done'
        statusText?: string
        nativeElapsedMs?: number
        scanElapsedMs?: number
        totalElapsedMs?: number
        switched?: boolean
        nativeTimedOut?: boolean
      }
      error?: string
    }>
    cancelAvailableYearsLoad: (taskId: string) => Promise<{
      success: boolean
      error?: string
    }>
    generateReport: (year: number) => Promise<{
      success: boolean
      data?: {
        year: number
        totalMessages: number
        totalFriends: number
        coreFriends: Array<{
          username: string
          displayName: string
          avatarUrl?: string
          messageCount: number
          sentCount: number
          receivedCount: number
        }>
        monthlyTopFriends: Array<{
          month: number
          displayName: string
          avatarUrl?: string
          messageCount: number
        }>
        peakDay: {
          date: string
          messageCount: number
          topFriend?: string
          topFriendCount?: number
        } | null
        longestStreak: {
          friendName: string
          days: number
          startDate: string
          endDate: string
        } | null
        activityHeatmap: {
          data: number[][]
        }
        midnightKing: {
          displayName: string
          count: number
          percentage: number
        } | null
        selfAvatarUrl?: string
        mutualFriend: {
          displayName: string
          avatarUrl?: string
          sentCount: number
          receivedCount: number
          ratio: number
        } | null
        socialInitiative: {
          initiatedChats: number
          receivedChats: number
          initiativeRate: number
          topInitiatedFriend?: string
          topInitiatedCount?: number
        } | null
        responseSpeed: {
          avgResponseTime: number
          fastestFriend: string
          fastestTime: number
        } | null
        topPhrases: Array<{
          phrase: string
          count: number
        }>
        snsStats?: {
          totalPosts: number
          typeCounts?: Record<string, number>
          topLikers: { username: string; displayName: string; avatarUrl?: string; count: number }[]
          topLiked: { username: string; displayName: string; avatarUrl?: string; count: number }[]
        }
        lostFriend: {
          username: string
          displayName: string
          avatarUrl?: string
          earlyCount: number
          lateCount: number
          periodDesc: string
        } | null
      }
      error?: string
    }>
    exportImages: (payload: { baseDir: string; folderName: string; images: Array<{ name: string; dataUrl: string }> }) => Promise<{
      success: boolean
      dir?: string
      error?: string
    }>
    captureCurrentWindow: () => Promise<{
      success: boolean
      dataUrl?: string
      size?: { width: number; height: number }
      error?: string
    }>
    onAvailableYearsProgress: (callback: (payload: {
      taskId: string
      years?: number[]
      done: boolean
      error?: string
      canceled?: boolean
      strategy?: 'cache' | 'native' | 'hybrid'
      phase?: 'cache' | 'native' | 'scan' | 'done'
      statusText?: string
      nativeElapsedMs?: number
      scanElapsedMs?: number
      totalElapsedMs?: number
      switched?: boolean
      nativeTimedOut?: boolean
    }) => void) => () => void
    onProgress: (callback: (payload: { status: string; progress: number }) => void) => () => void
  }

  /** 年度经营复盘（S3）：确定性统计报告；口径详见 docs/设计-年度经营复盘-规格.md §7.2 */
  annualReview: {
    getAvailableYears: () => Promise<{
      success: boolean
      data?: {
        /** 自然年份升序排列；特殊项 year=0（历史以来）固定放在最后 */
        years: Array<{
          /** 年份；0 = 历史以来（固定排在自然年之后） */
          year: number
          coverage: {
            source: string
            status: 'complete' | 'partial' | 'snapshot_only' | 'unavailable'
            coverageFrom?: number
            coverageTo?: number
            rows: number
            reasonCodes: string[]
          }
        }>
        currentYear: number
        supportsAllTime: boolean
        defaultYear: number
        generatedAt: number
      }
      error?: { code: string; message: string }
    }>
    /** 触发生成并等待完成（进度经 onProgress 并行推送）；同一账号同年份已有任务时合并等待 */
    generate: (year: number) => Promise<{
      success: boolean
      taskId?: string
      /** true = 合并等待了同键已有任务（未重复启动 Worker） */
      reused?: boolean
      error?: { code: string; message: string }
    }>
    /** 查询报告：cache='hit' 携带 report；'miss' 无缓存；'stale' 已过期（>10 分钟） */
    getReport: (year: number) => Promise<{
      success: boolean
      cache: 'hit' | 'miss' | 'stale'
      report?: AnnualReviewReport
      error?: { code: string; message: string }
    }>
    /** 取消：loading/computing 都有效；终态幂等成功；未知 taskId → task_not_found */
    cancel: (taskId: string) => Promise<{
      success: boolean
      error?: { code: string; message: string }
    }>
    /** 导出 Markdown/CSV：弹出目录对话框授权后独占写（不覆盖已有文件） */
    export: (year: number, format: 'markdown' | 'csv') => Promise<{
      success: boolean
      dir?: string
      files?: string[]
      error?: { code: string; message: string }
    }>
    onProgress: (callback: (payload: {
      taskId: string
      year: number
      phase: 'loading' | 'computing' | 'completed' | 'failed'
      /** 0–100，单调不回退 */
      progress: number
      statusText?: string
      done: boolean
      error?: { code: string; message: string }
    }) => void) => () => void
  }
  dualReport: {
    generateReport: (payload: { friendUsername: string; year: number }) => Promise<{
      success: boolean
      data?: {
        year: number
        selfName: string
        selfAvatarUrl?: string
        friendUsername: string
        friendName: string
        friendAvatarUrl?: string
        firstChat: {
          createTime: number
          createTimeStr: string
          content: string
          isSentByMe: boolean
          senderUsername?: string
        } | null
        firstChatMessages?: Array<{
          content: string
          isSentByMe: boolean
          createTime: number
          createTimeStr: string
        }>
        yearFirstChat?: {
          createTime: number
          createTimeStr: string
          content: string
          isSentByMe: boolean
          friendName: string
          firstThreeMessages: Array<{
            content: string
            isSentByMe: boolean
            createTime: number
            createTimeStr: string
          }>
        } | null
        stats: {
          totalMessages: number
          totalWords: number
          imageCount: number
          voiceCount: number
          emojiCount: number
          myTopEmojiMd5?: string
          friendTopEmojiMd5?: string
          myTopEmojiUrl?: string
          friendTopEmojiUrl?: string
          myTopEmojiCount?: number
          friendTopEmojiCount?: number
          topPhrases: Array<{ phrase: string; count: number }>
          myExclusivePhrases: Array<{ phrase: string; count: number }>
          friendExclusivePhrases: Array<{ phrase: string; count: number }>
          heatmap?: number[][]
          initiative?: { initiated: number; received: number }
          response?: { avg: number; fastest: number; slowest?: number; count: number }
          monthly?: Record<string, number>
          streak?: { days: number; startDate: string; endDate: string }
        }
        topPhrases: Array<{ phrase: string; count: number }>
        myExclusivePhrases: Array<{ phrase: string; count: number }>
        friendExclusivePhrases: Array<{ phrase: string; count: number }>
        heatmap?: number[][]
        initiative?: { initiated: number; received: number }
        response?: { avg: number; fastest: number; slowest?: number; count: number }
        monthly?: Record<string, number>
        streak?: { days: number; startDate: string; endDate: string }
      }
      error?: string
    }>
    onProgress: (callback: (payload: { status: string; progress: number }) => void) => () => void
  }
  export: {
    getExportStats: (sessionIds: string[], options: any) => Promise<{
      totalMessages: number
      voiceMessages: number
      cachedVoiceCount: number
      needTranscribeCount: number
      mediaMessages: number
      estimatedSeconds: number
      sessions: Array<{ sessionId: string; displayName: string; totalCount: number; voiceCount: number }>
    }>
    exportSessions: (sessionIds: string[], outputDir: string, options: ExportOptions, controlOptions?: { taskId?: string }) => Promise<{
      success: boolean
      successCount?: number
      failCount?: number
      paused?: boolean
      stopped?: boolean
      pendingSessionIds?: string[]
      successSessionIds?: string[]
      failedSessionIds?: string[]
      failedSessionErrors?: Record<string, string>
      sessionOutputPaths?: Record<string, string>
      error?: string
    }>
    pauseTask: (taskId: string) => Promise<{ success: boolean; error?: string }>
    resumeTask: (taskId: string) => Promise<{ success: boolean; error?: string }>
    cancelTask: (taskId: string) => Promise<{ success: boolean; error?: string }>
    exportContacts: (outputDir: string, options: { format: 'json' | 'csv' | 'vcf'; exportAvatars: boolean; contactTypes: { friends: boolean; groups: boolean; officials: boolean; blocked?: boolean }; selectedUsernames?: string[] }) => Promise<{
      success: boolean
      successCount?: number
      error?: string
    }>
    onProgress: (callback: (payload: ExportProgress) => void) => () => void
  }
  whisper: {
    downloadModel: () => Promise<{ success: boolean; modelPath?: string; tokensPath?: string; error?: string }>
    getModelStatus: () => Promise<{ success: boolean; exists?: boolean; modelPath?: string; tokensPath?: string; sizeBytes?: number; error?: string }>
    onDownloadProgress: (callback: (payload: { modelName: string; downloadedBytes: number; totalBytes?: number; percent?: number }) => void) => () => void
  }
  sns: {
    getTimeline: (limit: number, offset: number, usernames?: string[], keyword?: string, startTime?: number, endTime?: number) => Promise<{
      success: boolean
      timeline?: Array<{
        id: string
        username: string
        nickname: string
        avatarUrl?: string
        createTime: number
        contentDesc: string
        type?: number
        media: Array<{
          url: string
          thumb: string
          md5?: string
          token?: string
          key?: string
          encIdx?: string
          livePhoto?: {
            url: string
            thumb: string
            md5?: string
            token?: string
            key?: string
            encIdx?: string
          }
        }>
        likes: Array<string>
        comments: Array<{ id: string; nickname: string; content: string; refCommentId: string; refNickname?: string; emojis?: Array<{ url: string; md5: string; width: number; height: number; encryptUrl?: string; aesKey?: string }> }>
        location?: {
          latitude?: number
          longitude?: number
          city?: string
          country?: string
          poiName?: string
          poiAddress?: string
          poiAddressName?: string
          label?: string
        }
        rawXml?: string
      }>
      error?: string
    }>
    proxyImage: (payload: { url: string; key?: string | number }) => Promise<{ success: boolean; dataUrl?: string; videoPath?: string; status?: number; error?: string }>
    exportTimeline: (options: {
      outputDir: string
      format: 'json' | 'html' | 'arkmejson' | 'markdown'
      usernames?: string[]
      keyword?: string
      exportImages?: boolean
      exportLivePhotos?: boolean
      exportVideos?: boolean
      startTime?: number
      endTime?: number
      taskId?: string
    }) => Promise<{ success: boolean; filePath?: string; postCount?: number; mediaCount?: number; paused?: boolean; stopped?: boolean; error?: string }>
    onExportProgress: (callback: (payload: { current: number; total: number; status: string }) => void) => () => void
    selectExportDir: () => Promise<{ canceled: boolean; filePath?: string }>
    getSnsUsernames: () => Promise<{ success: boolean; usernames?: string[]; error?: string }>
    getUserPostCounts: (options?: { preferCache?: boolean; forceRefresh?: boolean }) => Promise<{ success: boolean; counts?: Record<string, number>; error?: string }>
    getExportStats: (options?: { allowTimelineFallback?: boolean; preferCache?: boolean; forceRefresh?: boolean }) => Promise<{ success: boolean; data?: { totalPosts: number; totalFriends: number; myPosts: number | null }; error?: string }>
    getUserPostStats: (username: string) => Promise<{ success: boolean; data?: { username: string; totalPosts: number }; error?: string }>
    installBlockDeleteTrigger: () => Promise<{ success: boolean; alreadyInstalled?: boolean; error?: string }>
    uninstallBlockDeleteTrigger: () => Promise<{ success: boolean; error?: string }>
    checkBlockDeleteTrigger: () => Promise<{ success: boolean; installed?: boolean; error?: string }>
    deleteSnsPost: (postId: string) => Promise<{ success: boolean; error?: string }>
    downloadEmoji: (params: { url: string; encryptUrl?: string; aesKey?: string }) => Promise<{ success: boolean; localPath?: string; error?: string }>
    getCacheMigrationStatus: () => Promise<{
      success: boolean
      needed: boolean
      inProgress?: boolean
      totalFiles?: number
      legacyBaseDir?: string
      currentBaseDir?: string
      items?: Array<{ label: string; sourceDir: string; targetDir: string; fileCount: number }>
      error?: string
    }>
    startCacheMigration: () => Promise<{ success: boolean; copied?: number; skipped?: number; totalFiles?: number; message?: string; error?: string }>
    onCacheMigrationProgress: (callback: (payload: {
      status: 'running' | 'done' | 'error'
      phase: 'copying' | 'cleanup' | 'done' | 'error'
      current: number
      total: number
      copied: number
      skipped: number
      remaining: number
      message?: string
      currentItemLabel?: string
    }) => void) => () => void
  }
  http: {
    start: (port?: number, host?: string) => Promise<{ success: boolean; port?: number; error?: string }>
    stop: () => Promise<{ success: boolean }>
    status: () => Promise<{ running: boolean; port: number; mediaExportPath: string }>
  }
  social: {
    saveWeiboCookie: (rawInput: string) => Promise<SocialSaveWeiboCookieResult>
    validateWeiboUid: (uid: string) => Promise<SocialValidateWeiboUidResult>
  }
  insight: {
    testConnection: () => Promise<{ success: boolean; message: string }>
    sendWecomTest: (webhook: string) => Promise<{ success: boolean; message: string }>
    listRecords: (filters?: InsightRecordFilters) => Promise<InsightRecordListResult>
    getRecord: (id: string) => Promise<InsightRecordResult>
    markRecordRead: (id: string) => Promise<{ success: boolean; error?: string }>
    triggerTest: () => Promise<{ success: boolean; message: string }>
    triggerSessionInsight: (payload: {
      sessionId: string
      displayName?: string
      avatarUrl?: string
    }) => Promise<{ success: boolean; message: string; recordId?: string; insight?: string; skipped?: boolean; notificationEnabled?: boolean }>
    listProfileStatuses: (sessionIds: string[]) => Promise<InsightProfileStatusListResult>
    generateProfile: (payload: {
      sessionId: string
      displayName?: string
      avatarUrl?: string
    }) => Promise<InsightProfileGenerateResult>
    cancelProfile: (sessionId?: string) => Promise<{ success: boolean; message: string }>
    generateFootprintInsight: (payload: {
      rangeLabel: string
      summary: {
        private_inbound_people?: number
        private_replied_people?: number
        private_outbound_people?: number
        private_reply_rate?: number
        mention_count?: number
        mention_group_count?: number
      }
      privateSegments?: Array<{ displayName?: string; session_id?: string; incoming_count?: number; outgoing_count?: number; message_count?: number; replied?: boolean }>
      mentionGroups?: Array<{ displayName?: string; session_id?: string; count?: number }>
    }) => Promise<{ success: boolean; message: string; insight?: string }>
    generateMessageInsight: (payload: {
      sessionId: string
      displayName?: string
      avatarUrl?: string
      targetLocalId?: number
      targetCreateTime?: number
      targetMessageKey?: string
      targetText: string
      targetSenderName?: string
      contextCount?: number
      forceRefresh?: boolean
    }) => Promise<{ success: boolean; message: string; cached?: boolean; recordId?: string; data?: MessageInsightAnalysis }>
  }
  groupSummary: {
    listRecords: (filters?: GroupSummaryRecordFilters) => Promise<GroupSummaryRecordListResult>
    getRecord: (id: string) => Promise<GroupSummaryRecordResult>
    triggerManual: (payload: {
      sessionId: string
      displayName?: string
      avatarUrl?: string
      startTime: number
      endTime: number
    }) => Promise<{ success: boolean; message: string; recordId?: string; record?: GroupSummaryRecordSummary; skipped?: boolean; skippedReason?: string }>
    triggerDay: (payload: {
      sessionId: string
      displayName?: string
      avatarUrl?: string
      date: string
    }) => Promise<{ success: boolean; message: string; generated: number; skipped: number; records: GroupSummaryRecordSummary[] }>
  }

  // ─── 销售助手 ─────────────────────────────────────────────────────────────
  crm: {
    list: (entity: string, opts?: unknown) => Promise<any[]>
    get: (entity: string, id: number) => Promise<any>
    create: (entity: string, payload: unknown) => Promise<number>
    update: (entity: string, id: number, patch: unknown) => Promise<void>
    formGet: (entity: string) => Promise<any[]>
    fieldMetaSave: (meta: unknown) => Promise<number>
    reviewQueues: () => Promise<any>
    workbench: () => Promise<any[]>
    statsOverview: () => Promise<any>
    statsAiAccuracy: (days?: number) => Promise<any>
    customers: () => Promise<any[]>
    opportunityList: (opts?: { accountId?: number; status?: string }) => Promise<any[]>
    opportunityGet: (id: number) => Promise<any>
    opportunityEvents: (id: number) => Promise<any[]>
    opportunityStats: () => Promise<{ stageDist: Array<{ stage: string; count: number; amount: number }>; total: number; totalAmount: number }>
    opportunityAnalysis: () => Promise<OpportunityAnalysisResult>
    opportunityStage: (id: number, stage: string) => Promise<boolean>
    opportunityClose: (id: number, status: 'lost', reason: string) => Promise<boolean>
    opportunityRegisterDeal: (id: number, payload: OpportunityDealRegistration) => Promise<{ ok: boolean; reason?: string }>
    opportunityIntentScore: (accountId: number) => Promise<{ score: number; level: string; factors: Array<{ label: string; delta: number; reason: string }> } | null>
    riskList: (opts?: { accountId?: number; status?: string }) => Promise<any[]>
    riskResolve: (id: number) => Promise<boolean>
    enrichRun: (sessionId: string, displayName?: string) => Promise<any>
    manualSet: (accountId: number, field: string, value: string) => Promise<{ ok: boolean; reason?: string }>
    enrichBackfill: () => Promise<{ processed: number; updated: number; failed: number }>
    infoQueueApply: (accountId: number, field: string, action: 'accept' | 'reject') => Promise<{ ok: boolean; reason?: string }>
    accountsBySessions: (sessionIds: string[]) => Promise<Record<string, { id: number; name: string }>>
    customerProfile: (sessionId: string) => Promise<any>
    customerDeepAnalysis: (sessionId: string, displayName: string) => Promise<{ ok: boolean; report?: string; reason?: string }>
    allocationConfirm: (id: number, patch?: unknown) => Promise<{ ok: boolean; reason?: string; linked?: boolean }>
    allocationReject: (id: number) => Promise<void>
    paymentApprove: (id: number) => Promise<{ ok: boolean; reason?: string; allocationCreated?: boolean }>
    paymentsByDay: (days?: number) => Promise<Array<{ id: number; payer: string; amount_net: number; pay_time: number; group_id?: string; source?: string; pay_channel?: string; needs_review: number; allocation_id?: number; alloc_status?: string; account_id?: number; contract_id?: number; sales_name?: string; sales_wxid?: string; account_name?: string; contract_name?: string; invoice_id?: number; invoice_no?: string; invoice_status?: string; invoice_requirement?: 'unknown' | 'required' | 'not_required' | 'info_pending'; reconciliation_status?: 'pending' | 'allocated' | 'legacy_confirmed'; reconciled_at?: number }>>
    paymentClaim: (id: number, patch?: { account_id?: number; contract_id?: number; sales_name?: string; sales_wxid?: string }) => Promise<{ ok: boolean; reason?: string; linked?: boolean }>
    allocationReconcile: (id: number) => Promise<{ ok: boolean; reason?: string }>
    allocationInvoiceRequirement: (id: number, requirement: 'unknown' | 'required' | 'not_required' | 'info_pending') => Promise<{ ok: boolean; reason?: string }>
    currentSalesName: () => Promise<string>
    salesTeam: () => Promise<{ team: Array<{ name: string; orderCount: number; amount: number }>; removed: string[] }>
    salesTeamAdd: (name: string) => Promise<{ ok: boolean; reason?: string }>
    salesTeamRemove: (name: string) => Promise<{ ok: boolean; reason?: string }>
    accountEnsure: (name: string) => Promise<number>
    contractShip: (id: number) => Promise<{ ok: boolean; gap?: number; reason?: string }>
    contractSign: (id: number) => Promise<{ ok: boolean; reason?: string }>
    contractDelete: (id: number) => Promise<{ ok: boolean; reason?: string; removed?: number }>
    customerDelete: (id: number) => Promise<{ ok: boolean; reason?: string; removed?: number }>
    logisticsLink: (id: number, opts?: { accountId?: number; contractId?: number; ownerSales?: string }) => Promise<{ ok: boolean; warning?: string; reason?: string }>
    logisticsCandidates: (receiver: string, city: string) => Promise<any[]>
    logisticsList: (opts?: { filter?: 'unlinked' | 'pending' | 'signed' }) => Promise<any[]>
    logisticsSigned: (id: number) => Promise<{ ok: boolean; reason?: string }>
    productImport: (rows: unknown[]) => Promise<{ imported: number }>
    contractEntryScope: () => Promise<{ accountKey: string; generation: number }>
    contractByCreationRequest: (id: string, scope: { accountKey: string; generation: number }) => Promise<any>
    contractBeginEntry: (input: unknown, scope: { accountKey: string; generation: number }) => Promise<any>
    contractEntryQuotation: (data: unknown, scope: { accountKey: string; generation: number }) => Promise<{ ok: boolean; id?: number; reason?: string }>
    quotationCreate: (data: unknown) => Promise<{ ok: boolean; id?: number; version?: number; reason?: string }>
    quotationCurrent: (contractId: number) => Promise<QuotationRecord | null>
    quotationHistory: (contractId: number) => Promise<QuotationRecord[]>
    quotationAi: (sessionId: string, displayName: string) => Promise<{ ok: boolean; quotationId?: number; contractId?: number; reason?: string; matched?: Array<{ keyword: string; productName: string }> }>
    groupsList: () => Promise<any[]>
    groupsSave: (g: unknown) => Promise<number>
    groupsUpdate: (id: number, patch: unknown) => Promise<void>
    parseScanNow: () => Promise<{ scanned: number }>
    autoConfirmRun: () => Promise<{ auto: number; reviewed: number; byEntity: Record<string, { auto: number; reviewed: number }> }>
    autoConfirmHistory: (limit?: number) => Promise<Array<{ id: number; entity: string; entity_id: number; decision: string; confidence: number; reason: string; action: string; created_at: number }>>
    autoConfirmUndo: (entity: string, id: number) => Promise<{ ok: boolean; reason?: string }>
    docGenerate: (type: string, recordId: number, options?: { reuseExisting?: boolean; scope?: { accountKey: string; generation: number } }) => Promise<{ ok: boolean; path?: string; reason?: string }>
    aliasLearn: (alias: string, accountId: number) => Promise<void>
    aiDesc: (payload: unknown) => Promise<string>
    aiExtract: (template: string[], dataUrl: string) => Promise<Record<string, string>>
    saveImage: (dataUrl: string, fileName: string) => Promise<string>
    readImage: (filePath: string) => Promise<string>

    // 单机线索流转
    leadImport: (source: string, fileName: string, rows: unknown[]) => Promise<{ batchId: number; total: number; valid: number; duplicate: number; invalid: number; invalidIndexes: number[]; dupSameBatch: number; dupExistingLead: number; dupExistingCustomer: number; conflicts: number }>
    leadDupCheck: (input: { phone?: string; wechat?: string }) => Promise<{ duplicate: boolean; detail: { kind: 'lead' | 'customer' | 'conflict'; contactMasked: string; leadId?: number; accountId?: number; status?: string; source?: string; currentOwner?: string; assignments: Array<{ id: number; salesName: string; mode: string; status: string; assignedAt: number; sla1Stopped: boolean }>; message: string } | null }>
    leadCreate: (input: { source?: string; phone?: string; wechat?: string; wxNickname?: string; qrPath?: string; note?: string }) => Promise<{ ok: boolean; data?: { leadId: number }; code?: 'E101' | 'E201'; message: string; duplicate?: { kind: 'lead' | 'customer' | 'conflict'; contactMasked: string; leadId?: number; accountId?: number; status?: string; source?: string; currentOwner?: string; assignments: Array<{ id: number; salesName: string; mode: string; status: string; assignedAt: number; sla1Stopped: boolean }>; message: string } }>
    leadQrSave: (fileName: string, srcPath: string) => Promise<{ ok: boolean; path?: string }>
    leadHistoryImport: (fileName: string, rows: Array<{ contactType?: string; contactValue?: string; sales?: string; assignedAt?: string | number; endState?: string; source?: string; note?: string }>) => Promise<{ total: number; leadsCreated: number; leadsReused: number; assignmentsCreated: number; recycled: number; skipped: Array<{ line: number; contactMasked: string; reason: string }> }>
    dupGroupList: () => Promise<{ groupCount: number; leadMatches: Record<string, { mask: string; others: string[] }>; customerMatches: Record<string, { mask: string; others: string[] }> }>
    leadList: (opts?: { status?: string; source?: string; overdueOnly?: boolean; q?: string; limit?: number; offset?: number }) => Promise<LeadRow[]>
    leadDetail: (id: number) => Promise<{ lead: LeadRow | null; activities: Array<{ id: number; lead_id: number; action: string; note?: string; created_at: number }> }>
    leadOverview: () => Promise<{ total: number; byStatus: Record<string, number>; overdue: number; todayImported: number; todayContacted: number; pendingSla: number; sources: Array<{ source: string; count: number }> }>
    leadStatus: (id: number, action: 'contacted' | 'wx_added' | 'dead' | 'reopen', opts?: { channel?: string; reason?: string; note?: string; wechat?: string }) => Promise<{ ok: boolean; error?: string }>
    leadUpdate: (id: number, fields: { name?: string; wechat?: string }) => Promise<{ ok: boolean; error?: string }>
    leadToAccount: (id: number) => Promise<{ ok: boolean; error?: string; accountId?: number; existed?: boolean }>
    leadScanSla: () => Promise<number>
    leadSlaComplete: (taskId: number) => Promise<boolean>
    leadSlaSkip: (taskId: number) => Promise<boolean>
    leadDeadReasons: () => Promise<string[]>
    // 线索分配（Phase 1 完整版五端点，统一信封 { ok, data } / { ok:false, code, message }，API-CONTRACT §1.14）
    // mode 显式传入时必须是四种合法值之一；非法值在 service 层被拒（E101），IPC 不做 String() 掩盖
    assignmentAssign: (req: { leadIds: number[]; salesName: string; mode?: AssignmentMode; actor?: string }) => Promise<{ ok: boolean; data?: { assignments: Array<{ leadId: number; assignmentId: number }>; skipped: Array<{ leadId: number; code: string; reason: string }> }; code?: string; message?: string }>
    assignmentClaim: (req: { leadId: number; actor?: string }) => Promise<{ ok: boolean; data?: { assignmentId: number }; code?: string; message?: string }>
    assignmentRecycle: (req: { assignmentId: number; reason?: string; actor?: string }) => Promise<{ ok: boolean; data?: { assignmentId: number }; code?: string; message?: string }>
    assignmentTransfer: (req: { assignmentId: number; toSales: string; reason?: string; actor?: string }) => Promise<{ ok: boolean; data?: { assignmentId: number }; code?: string; message?: string }>
    assignmentList: (opts?: { leadId?: number; salesName?: string; status?: string; page?: number; pageSize?: number }) => Promise<{ ok: boolean; data: { rows: AssignmentRow[]; total: number } }>
    // 批量分配（设计稿屏 3 分配控制台）：批次号 = '#A'+批次审计行号
    // 批量分配只接受三种自动模式；显式非法值一律 E101，不再静默回退 weight
    assignmentAssignBatch: (req: { count: number; mode?: Exclude<AssignmentMode, 'manual'>; weights?: Record<string, number>; actor?: string }) => Promise<{ ok: boolean; data?: { batchNo: string; assigned: number; skipped: Array<{ leadId: number; code: string; reason: string }>; perSales: Record<string, number>; mode: string }; code?: string; message?: string }>
    // round_robin 跨批次游标只读查询（最小只读信息 = 下一位销售姓名，空串=名单第一位；无写路径）
    assignmentRoundRobinNext: () => Promise<{ ok: boolean; data?: { next: string } }>
    // 分配数据失效事件（SLA 回收 / LAN、中央下行 / 其他主进程或窗口写入后广播；载荷只含 action + leadIds + at，
    // 不含联系方式/聊天内容等敏感字段）。返回清理函数，组件卸载必须调用以免监听器泄漏。
    onAssignmentInvalidated: (callback: (payload: CrmAssignmentInvalidation) => void) => () => void
    // 加好友判定（PRD 1.4a 手动路，契约 crm:identity:bind）：写 customer_identity + 停 SLA1 表 + lead→WX_ADDED + 审计
    identityBind: (req: { leadId: number; wxid: string; displayName?: string; actor?: string }) => Promise<{ ok: boolean; data?: { identityId: number; customerId: number | null; alreadyBound: boolean; slaStopped: boolean }; code?: string; message?: string }>
    // 两段接力 SLA 第二段「聊了没有」（PRD 1.4）：扫描/人工结论统一写入口径（assignment.sla2_scan_ref + 审计）
    sla2Mark: (req: { leadId: number; verdict: string; confidence: number; scanRef: string; source?: string; note?: string; actor?: string }) => Promise<{ ok: boolean; data?: { assignmentId: number; alreadyMarked: boolean }; code?: string; message?: string }>
    // 客户类型（PRD 1.5，dealer/end_user，'' 清除）：UPDATE customer + 审计
    customerSetType: (req: { customerId: number; type: string; actor?: string }) => Promise<{ ok: boolean; data?: { customerId: number; type: string; unchanged: boolean }; code?: string; message?: string }>
    // 交付售后（2026-09-10）：交付登记 / 设备档案 / 以旧换新 / 复购等级后端单点写入，页面只读后端事实与任务
    deliveryRegister: (oppId: number, payload: { shipped_qty?: number; delivery_date?: number; over_ship_reason?: string; actor?: string }) => Promise<{ ok: boolean; data?: { oppId: number; shipped_qty: number; delivery_date: number; diffTaskCreated: number; diffTaskClosed: number; diffTaskUpdated: number }; code?: string; message?: string }>
    deliverySaveEquipment: (customerId: number, fields: Record<string, unknown>) => Promise<{ ok: boolean; data?: { customerId: number; changedFields: string[] }; code?: string; message?: string }>
    deliveryProposeTradeIn: (customerId: number, basis: { kind: string; evidenceKey: string; reason: string; at?: number }) => Promise<{ ok: boolean; taskId?: number; code?: string; message?: string }>
    deliveryDecideTradeIn: (customerId: number, decision: 'accept' | 'reject') => Promise<{ ok: boolean; taskId?: number; code?: string; message?: string }>
    deliveryScan: () => Promise<{ diffCreated: number; diffClosed: number; diffUpdated: number; warrantyNear: number; warrantyExpired: number; warrantyClosed: number; tradeIn: number }>
    deliveryTasks: () => Promise<{ diff: any[]; warrantyNear: any[]; warrantyExpired: any[]; tradeIn: any[] }>
    deliverySuggestDate: (oppId: number) => Promise<{ date: number; source: string } | null>
    deliveryRecomputeRepeat: () => Promise<number>
    // 认领满 24h AI 首次分类（PRD 2.4，B 档）：run=手动立即分析；list=轮次列表；confirm/reject=人工裁决
    firstClassifyRun: (req: { leadId?: number; assignmentId?: number; actor?: string }) => Promise<{ ok: boolean; data?: { roundId: number; status: string; reused?: boolean; gapsCreated?: number }; code?: string; message?: string }>
    firstClassifyList: (opts?: { status?: string; leadId?: number; page?: number; pageSize?: number }) => Promise<{ ok: boolean; data: { rows: FirstClassifyRoundRow[]; total: number } }>
    firstClassifyConfirm: (req: { roundId: number; actor?: string }) => Promise<{ ok: boolean; data?: { roundId: number; status: string }; code?: string; message?: string }>
    firstClassifyReject: (req: { roundId: number; actor?: string; reason?: string }) => Promise<{ ok: boolean; data?: { roundId: number; status: string }; code?: string; message?: string }>
    // 离职移交（PRD §1.9）：lead 批量调派循环（reason='离职'）+ owner 三列同步改写 + ownership_history/audit_event
    ownershipDeparture: (req: { fromSales: string; toSales: string; actor?: string }) => Promise<{ ok: boolean; data?: { fromSales: string; toSales: string; leadsTransferred: number; leadFailed: Array<{ assignmentId: number; code: string; message: string }>; accounts: number; opportunities: number; logistics: number }; code?: string; message?: string }>
    // 审计流水（宪法 §1.12，R 只读）：keyword 扩展一把搜 actor/detail/entity_type/entity_id
    // labels = 实体显示名（key `<entity_type>:<entity_id>`，人话化设计稿 §04「对象解析」；只含 lead/account/customer，
    // 解析不到由渲染层回落 `#id`）
    auditQuery: (opts?: { entityType?: string; entityId?: number; actor?: string; action?: string; keyword?: string; beginAt?: number; endAt?: number; page?: number; pageSize?: number }) => Promise<{ ok: boolean; data: { rows: Array<{ id: number; actor: string; action: string; entity_type: string; entity_id: number | null; detail: string; created_at: number }>; total: number; labels: Record<string, string> } }>
    // 归属留痕时间线（宪法 §1.8，R 只读，append-only）
    ownershipHistory: (opts: { entityType: string; entityId: number; page?: number; pageSize?: number }) => Promise<{ ok: boolean; data: { rows: Array<{ id: number; entity_type: string; entity_id: number; old_owner: string; new_owner: string; reason: string; actor: string; created_at: number }>; total: number } }>
    // 存量迁移报告（migration_report SSOT，R 只读）：每模块最新快照，与 audit_event 解耦
    migrationReports: () => Promise<{ ok: boolean; data: MigrationReportRow[]; error?: string }>
    // 迁移失败/冲突项人工闭环：确认忽略 / 恢复 / 忽略清单（SSOT = migration_dismissal 表）
    migrationDismissals: () => Promise<{ ok: boolean; data: MigrationDismissal[]; error?: string }>
    migrationDismissFailure: (module: string, entityKey: string, reason?: string) => Promise<{ ok: boolean; error?: string }>
    migrationRestoreFailure: (module: string, entityKey: string) => Promise<{ ok: boolean; error?: string }>
    /** 主管升级提醒（SLA1 三次超时通知闭环，2026-09-08）：列表（含未读数）+ 已读 */
    notifyList: (opts?: { status?: string; limit?: number; offset?: number }) => Promise<{ ok: boolean; data: { rows: Array<{ id: number; notify_type: string; idempotency_key: string; title: string; body: string; lead_id: number | null; detail: string; status: string; created_at: number }>; unread: number } }>
    notifyMarkRead: (ids: number[]) => Promise<{ ok: boolean; updated: number }>
    /** SLA2「查看依据」（屏 5 右证据回查出口；主进程已脱敏，绝不返回 messageKey/wxid/绝对路径） */
    sla2Evidence: (leadId: number) => Promise<{ status: 'found' | 'no_anchor' | 'cleaned' | 'error' | 'no_evidence'; message: string; text?: string; createTimeMs?: number; isSend?: boolean; source?: string; concludedAt?: number }>
    /** 导入查重明细（2026-09-08 查重完善）：按批次取脱敏明细行 */
    importDedupeDetail: (batchId: number) => Promise<{ ok: boolean; rows: Array<{ line: number; verdict: string; reason: string; phoneMasked: string; wechatMasked: string; name: string; matchedLeadId?: number; matchedAccountId?: number }> }>
  }
  sales: {
    // 知识库（status 过滤后端 salesDbService.kbList 原生支持；全量拉取后前端做治理分区）
    kbList: (filters?: { category?: string; product_line?: string; scene?: string; status?: string }) => Promise<{ success: boolean; entries: KbEntryRecord[]; total: number }>
    kbGet: (id: number) => Promise<{ success: boolean; entry?: KbEntryRecord; error?: string }>
    kbCreate: (payload: { category: string; product_line?: string; title: string; content: string; tags?: string[]; scene?: string; ttl_date?: string | null }) => Promise<{ success: boolean; entry?: KbEntryRecord; error?: string }>
    kbUpdate: (id: number, payload: { category?: string; product_line?: string; title?: string; content?: string; tags?: string[]; scene?: string; ttl_date?: string | null }) => Promise<{ success: boolean; entry?: KbEntryRecord; forked?: boolean; error?: string }>
    kbRenewTtl: (id: number, ttlDate: string) => Promise<{ success: boolean; entry?: KbEntryRecord; error?: string }>
    kbDelete: (id: number) => Promise<{ success: boolean; error?: string }>
    kbSearch: (payload: { keyword: string; category?: string; product_line?: string }) => Promise<{ success: boolean; entries: KbEntryRecord[]; total: number }>
    // 刀 1 知识审核（待审核区 发布/拒绝；拒绝必填拒因）+ 刀 2 采纳率只读聚合
    kbReview: (id: number, action: 'publish' | 'reject', payload?: { reason?: string; official?: boolean }) => Promise<{ success: boolean; entry?: KbEntryRecord; error?: string }>
    proposalStats: () => Promise<{ success: boolean; stats?: { generated: number; processed: number; accepted: number; rejected: number; modified: number; rate: number | null }; error?: string }>
    // 刀 3 带引用知识问答（问知识库）+ viewed 埋点
    kbAsk: (payload: { question: string }) => Promise<
      | { kind: 'knowledge'; status: 'empty' | 'not_configured' | 'no_hit' | 'answer' | 'error'; question: string; askKey: string; entries: Array<{ id: number; title: string; version: number }>; answer?: string; citations?: Array<{ id: number; title: string; version: number }>; error?: string }
      | { kind: 'data'; status: 'answer' | 'unsupported'; question: string; askKey: string; templateId: string | null; templateLabel?: string; text: string; rows: Record<string, unknown>; via: 'llm' | 'template'; reason?: string }
    >
    kbAskViewed: (payload: { question?: string; askKey?: string; kind?: 'knowledge' | 'data' }) => Promise<{ ok: boolean }>
    // 刀 4 知识提案写入路（staging 行 source=proposal；evidence_key 硬门必填）
    kbPropose: (payload: { title: string; content: string; category?: string; scene?: string; tags?: string[]; evidence_key: string }) => Promise<{ success: boolean; entry?: KbEntryRecord; error?: string }>
    // 知识库批量导入（CSV；逐行落 staging）
    kbImportCsv: (csvContent: string) => Promise<{ success: boolean; imported: number; skipped: number; error?: string }>

    // 报表
    reportGenerate: (payload: { period_type: string; period_start?: number; period_end?: number }) => Promise<{ success: boolean; report?: any; error?: string }>
    reportList: (limit?: number) => Promise<{ success: boolean; reports: any[]; error?: string }>
    reportGet: (id: number) => Promise<{ success: boolean; report?: any; error?: string }>
    reportDelete: (id: number) => Promise<{ success: boolean; error?: string }>
    reviewGenerate: () => Promise<{ success: boolean; report?: any; error?: string }>

    // 晨间摘要（设计-AI见解重定位 §3.1）
    // notReady：业务库尚未就绪（启动早期/切账号重开库），此时 data 必为 null 且不是空态
    morningDigestGet: () => Promise<{ ok: boolean; data: MorningDigestPayload | null; notReady?: boolean }>
    morningDigestRegenerate: () => Promise<{ ok: boolean; data: MorningDigestPayload }>

    // AI 按需识别（PRD §5.2/§4.7）：单飞作用域全局
    identifyCustomer: (params: { sessionId: string; displayName?: string }) => Promise<{
      success: boolean
      /** true = 调用前判定无新消息，未发起模型调用（账本无记录） */
      noNewContent?: boolean
      newTasks?: number
      latestAt?: number
      /** true = 已有识别在进行中（全局单飞），本次被拒绝 */
      busy?: boolean
      error?: string
    }>
    identifyState: () => Promise<IdentifyActivityPayload>
    onIdentifyActivity: (cb: (state: IdentifyActivityPayload) => void) => () => void

    // AI 用量账本与当日额度快照（PRD §5.5）
    aiUsageGet: () => Promise<AiUsageGetPayload>

    // 客户画像
    customerGet: (sessionId: string) => Promise<{ success: boolean; profile: any; error?: string }>
    customerCurrentView: (sessionId: string) => Promise<{ success: boolean; data?: any; error?: string }>
    customerUpsert: (data: { session_id: string; display_name?: string; tags?: string; notes?: string }) => Promise<{ success: boolean; profile?: any; error?: string }>
    customerList: (filters?: { stage?: string; search?: string; sortBy?: 'updated_at' | 'last_contact_at' | 'stage'; limit?: number }) => Promise<{ success: boolean; customers: any[]; error?: string }>
    customerExport: () => Promise<{ success: boolean; filePath?: string; count?: number; error?: string }>
    // P0-4.2.2/4.3：Action Funnel（Task-level 六段聚合 + 下钻；纯只读不调 LLM；rate null = 分母 0）
    actionFunnelGet: (days?: number | null) => Promise<{ success: boolean; data?: {
      window: { days: number | null; startMs: number | null }
      stages: { created: number; exposed: null; executed: number; responded: number; progressed: number; won: number }
      rates: { exposure: null; execution: number | null; response: number | null; progression: number | null; conversion: number | null }
      sources: { created: string; exposed: string; executed: string; responded: string; progressed: string; won: string }
      supersededCount: number
    }; error?: string }>
    actionFunnelBreakdown: (days?: number | null) => Promise<{ success: boolean; data?: {
      window: { days: number | null; startMs: number | null }
      executed: {
        count: number; unexecuted: number
        eventTypeCounts: { script_copied: number; chat_opened: number; follow_up_done: number }
        samples: Array<{ taskId: number; sessionId: string; title: string; createdAt: number; eventTypes: string[] }>
      }
      responded: {
        count: number; unresponded: number
        eventTypeCounts: { customer_replied: number; quote_asked: number }
        samples: Array<{ taskId: number; sessionId: string; title: string; createdAt: number }>
      }
    }; error?: string }>
    customerDetail: (sessionId: string) => Promise<{
      success: boolean;
      data?: {
        profile: { id: number; session_id: string; display_name?: string; customer_id?: string; stage: string; tags: string; notes?: string; last_contact_at?: number; created_at: number; updated_at: number };
        messageStats: { total: number; firstContactAt: number | null; lastContactAt: number | null };
        aiProfile: string;
        aiProfileMeta: { rangeStart?: number; rangeEnd?: number; updatedAt?: number } | null;
        intentHistory: Array<{ id: number; session_id: string; stage: string; confidence?: number; source: string; reason?: string; created_at: number }>;
        todos: Array<{ id: number; session_id?: string; trigger_type: string; title: string; due_at?: number; status: string; created_at: number }>;
      };
      error?: string;
    }>

    // 意向标签
    intentAnalyze: (sessionId: string) => Promise<{ success: boolean; tag?: any; error?: string }>
    intentCorrect: (payload: { session_id: string; stage: string; reason?: string }) => Promise<{ success: boolean; tag?: any; error?: string }>
    intentHistory: (sessionId: string, limit?: number) => Promise<{ success: boolean; tags: any[]; error?: string }>
    // 证据（P0-2B）：统一读入口，只读；找不到返回 unavailable，不伪造
    evidenceGetByKey: (payload: { session_id: string; message_key: string; evidence_text?: string }) =>
      Promise<
        | { status: 'found'; message: any; before: any[]; after: any[] }
        | { status: 'unavailable'; reason: 'unparseable' | 'message_not_found' | 'reader_error' | 'no_message_key'; evidenceText?: string }
      >

    // 回复建议
    replySuggest: (payload: { session_id: string; context_messages: Array<{ role: string; content: string }> }) => Promise<{ success: boolean; suggestions?: string[]; error?: string }>

    /**
     * 行动建议生成（按需 AI，usageContext.purpose='action'，唯一入口 generateActionAnalysis）。
     * 商机「阶段分析」的「生成跟进建议」复用此通道；传参只需 ActionItem 的语义子集。
     */
    actionSuggest: (item: {
      id: number
      sessionId: string
      displayName: string
      stage: string
      triggerType: string
      title: string
      reason: string
      silentDays: number
      priorityScore: number
      priority: string
      status: string
      suggestion: string
      createdAt: number
    }) => Promise<{
      success: boolean
      whyNow?: string
      opportunity?: string
      riskSignal?: string
      script?: string
      nextMove?: string
      error?: string
      notConfigured?: boolean
    }>

    // 待办
    todoList: (filters?: { status?: string; limit?: number }) => Promise<{ success: boolean; tasks: any[]; error?: string }>
    todoCreate: (payload: { session_id?: string; trigger_type: string; title: string; due_at?: number }) => Promise<{ success: boolean; task?: any; error?: string }>
    todoUpdate: (id: number, updates: { status?: string; title?: string; due_at?: number; priority_score?: number; feedback_log?: string; completed_at?: number }) => Promise<{ success: boolean; task?: any; error?: string }>
    profileBatch: (limit?: number, monthsBack?: number) => Promise<{ success: boolean; processed?: number; error?: string }>
    profileProgress: () => Promise<{ total: number; done: number; running: boolean }>
  }

  // D7 评测集标注（eval:*）
  eval: {
    candidatesGenerate: (opts?: { sample?: number; target?: number }) => Promise<{ success: boolean; result?: EvalGenerateResult; error?: string }>
    list: () => Promise<{ success: boolean; cases: EvalCaseRow[]; error?: string }>
    label: (payload: { id: number; label: string; annotatedBy: string }) => Promise<{ success: boolean; case?: EvalCaseRow; error?: string }>
    stats: () => Promise<{ success: boolean; stats?: EvalStats; error?: string }>
    report: () => Promise<{ success: boolean; report?: EvalBaselineReport; markdown?: string; error?: string }>
    // 告警样本（alert_eval_case，宪法 §3）
    alertList: () => Promise<{ success: boolean; cases: AlertEvalCaseRow[]; error?: string }>
    alertLabel: (payload: { id: number; label: string; annotatedBy: string }) => Promise<{ success: boolean; case?: AlertEvalCaseRow; error?: string }>
    alertStats: () => Promise<{ success: boolean; stats?: AlertEvalStats; error?: string }>
  }
}

/** D7 告警评测样本（alert_eval_case 行 + 展示名；字段语义见 salesDbService.AlertEvalCase，宪法 §3） */
export interface AlertEvalCaseRow {
  id?: number
  session_id: string
  anchor_key?: string
  alert_type?: string
  label?: string
  evidence_message_keys?: string
  evidence_text?: string
  ai_label?: string
  ai_evidence_keys?: string
  annotated_by?: string
  status?: string
  source?: string
  updated_by?: string
  updated_at?: number
  version?: number
  deleted?: number
  created_at?: number
  display_name: string
}

/** 告警评测单类型统计（eval:alert:stats；分母 = 人工已标且非 uncertain 且有 ai_label） */
export interface AlertTypeEvalStat {
  alertType: string
  annotated: number
  total: number
  compared: number
  agree: number
  agreeRate: number | null
}

/** 告警评测进度（按 alert_type 分组，≥85% 开门判定直接读数） */
export interface AlertEvalStats {
  types: AlertTypeEvalStat[]
  total: number
  annotated: number
}

/** D7 商机评测集候选（opportunity_eval_case 行 + 展示名；字段语义见 salesDbService.OpportunityEvalCase） */
export interface EvalCaseRow {
  id?: number
  session_id: string
  anchor_key?: string
  label?: string
  evidence_message_keys?: string
  evidence_text?: string
  ai_label?: string
  ai_evidence_keys?: string
  annotated_by?: string
  status?: string
  source?: string
  updated_by?: string
  updated_at?: number
  version?: number
  deleted?: number
  created_at?: number
  display_name: string
}

/** 候选生成结果（eval:candidates:generate） */
export interface EvalGenerateResult {
  inserted: number
  skippedExisting: number
  aiBackfilled: number
  aiMatched: number
  chatroomFiltered: number
  quoteSkipped: boolean
  bySource: { intent: number; quote: number; intent_signal: number; sample: number }
  /** ③④路因拿不到可回查锚点未入库的会话数（锚点诚实，绝不伪造 evidence_key） */
  anchorMissing: number
  /** 本次扩量目标池规模（默认 = 评测门槛样本数 100） */
  target: number
  total: number
}

/** 评测门槛判定（PRD：候选 ≥100 且人工确认 ≥100） */
export interface EvalGateStatus {
  minTotal: number
  minConfirmed: number
  total: number
  confirmed: number
  met: boolean
  /** 未达标原因（中文；达标时空数组） */
  shortfalls: string[]
}

/** 单档 one-vs-rest 指标（只统计人工确认样本） */
export interface EvalClassMetric {
  label: 'has' | 'none' | 'uncertain'
  tp: number
  fp: number
  fn: number
  support: number
  precision: number | null
  recall: number | null
  f1: number | null
}

/** 基线指标（eval:report；门槛未达时不产出） */
export interface EvalMetrics {
  compared: number
  accuracy: number | null
  macroF1: number | null
  classes: Record<'has' | 'none' | 'uncertain', EvalClassMetric>
  /** 混淆矩阵：行=人工 label，列=AI label */
  confusion: { labels: Array<'has' | 'none' | 'uncertain'>; matrix: number[][] }
}

/** 商机判定评测基线报告（可导出；未达到评测门槛时 metrics=null） */
export interface EvalBaselineReport {
  schema: 'weflow-opportunity-eval-baseline/1'
  generatedAt: string
  gate: EvalGateStatus
  candidates: {
    total: number
    bySource: Record<string, number>
    withAnchor: number
    withoutAnchor: number
  }
  labelDistribution: {
    human: { has: number; none: number; uncertain: number; unlabeled: number }
    ai: { has: number; none: number; uncertain: number; absent: number }
  }
  metrics: EvalMetrics | null
  agreement: { compared: number; agree: number; agreeRate: number | null }
  notes: string[]
}

/** 标注进度 + 人机一致率 + 分档计数 + 门槛判定（eval:stats） */
export interface EvalStats {
  total: number
  confirmed: number
  compared: number
  agree: number
  agreeRate: number | null
  /** 人工确认分档计数 */
  byLabel: { has: number; none: number; uncertain: number }
  gate: EvalGateStatus
}

export interface ExportOptions {
  format: 'chatlab' | 'chatlab-jsonl' | 'json' | 'arkme-json' | 'html' | 'markdown' | 'txt' | 'excel' | 'weclone' | 'sql'
  contentType?: 'text' | 'voice' | 'image' | 'video' | 'emoji' | 'file'
  dateRange?: { start: number; end: number } | null
  senderUsername?: string
  fileNameSuffix?: string
  exportMedia?: boolean
  exportConflictStrategy?: 'incremental' | 'overwrite' | 'rename'
  exportAvatars?: boolean
  exportImages?: boolean
  exportVoices?: boolean
  exportVideos?: boolean
  exportEmojis?: boolean
  exportFiles?: boolean
  maxFileSizeMb?: number
  exportVoiceAsText?: boolean
  exportPathStyle?: 'auto' | 'posix' | 'windows'
  excelCompactColumns?: boolean
  txtColumns?: string[]
  fileNamingMode?: 'classic' | 'date-range'
  sessionLayout?: 'shared' | 'per-session'
  exportWriteLayout?: 'A' | 'B' | 'C'
  sessionNameWithTypePrefix?: boolean
  displayNamePreference?: 'group-nickname' | 'remark' | 'nickname'
  exportConcurrency?: number
}

export interface ExportProgress {
  current: number
  total: number
  currentSession: string
  currentSessionId?: string
  phase: 'preparing' | 'exporting' | 'exporting-media' | 'exporting-voice' | 'writing' | 'complete'
  phaseProgress?: number
  phaseTotal?: number
  phaseLabel?: string
  collectedMessages?: number
  exportedMessages?: number
  estimatedTotalMessages?: number
  writtenFiles?: number
  mediaDoneFiles?: number
  mediaCacheHitFiles?: number
  mediaCacheMissFiles?: number
  mediaCacheFillFiles?: number
  mediaDedupReuseFiles?: number
  mediaBytesWritten?: number
}

export interface WxidInfo {
  wxid: string
  modifiedTime: number
}

/** 线索流转 lead 表行（contact_type=phone/wechat/both；status=NEW/CONTACTED/WX_ADDED/DEAD/ACCOUNT） */
export interface LeadRow {
  id: number
  contact_type: 'phone' | 'wechat' | 'both'
  contact_normalized: string
  contact_raw: string
  wechat?: string
  source: string
  name?: string
  tag?: string
  note?: string
  status: string
  dead_reason?: string
  first_contact_channel?: string
  account_id?: number
  first_contacted_at?: number
  first_contact_deadline?: number
  /** 导入批次回溯（宪法 §3 登记 2026-09-06，→ import_batch.id 逻辑外键）；NULL = 该列上线前的存量导入 */
  import_batch_id?: number | null
  created_at: number
  updated_at: number
}

/** 分配记录 assignment 表行（宪法 §1.3：lead 归属唯一事实源；当前分配 = 该 lead 最新有效行） */
export interface AssignmentRow {
  id: number
  lead_id: number
  sales_name: string
  mode: string
  sla1_deadline?: number | null
  /** PRD 1.4a 停表时刻：NULL=SLA1 计时中；非 NULL=已加好友（手动绑定/自动检测命中），回收器不再扫 */
  sla1_met_at?: number | null
  /** 三次提醒制（设计稿屏 4）：0=未提醒过；第 1/2 次超时只提醒，满第 3 次才回收（宪法 §1.3 修订） */
  sla1_remind_count?: number
  sla2_scan_ref?: string
  status: 'assigned' | 'claimed' | 'recycled' | 'transferred'
  /** 认领时刻（毫秒，宪法 §1.3 修订 2026-09-10）：NULL/0=未认领；认领满 24h 首次分类的计时基准 */
  claimed_at?: number | null
  source: string
  updated_by: string
  updated_at?: number
  version: number
  deleted: number
}

/** PRD 2.4 认领满 24h 首次分类轮次行（first_classification 表投影） */
export interface FirstClassifyRoundRow {
  id: number
  assignment_id: number
  lead_id: number
  status: 'pending' | 'proposed' | 'confirmed' | 'rejected' | 'failed'
  result_json: string
  evidence_json: string
  gaps_json: string
  error: string
  trigger_source: 'scan' | 'manual'
  model: string
  decided_by: string
  decided_at?: number | null
  created_at: number
  updated_at?: number
}

/**
 * AI 识别单飞状态（PRD §4.7：作用域全局）。
 * 任一识别进行中，所有入口按钮（客户 360 的识别按钮、今日行动页的重新生成简报）同时禁用。
 */
export interface IdentifyActivityPayload {
  busy: boolean
  kind: 'identify' | 'digest' | null
  label: string
  startedAt: number
}

/** 简报覆盖信息（PRD §6.1 六态 + W3b 真实游标区间） */
export interface DigestCoveragePayload {
  state: 'empty_account' | 'crm_only' | 'pending_data' | 'all_covered_clear' | 'failed_or_blocked' | 'stale_snapshot'
  message: string
  from: number | null
  to: number | null
  pending: number
  activeSessions: number
  analyzedSessions: number
  failedSessions: number
  source: 'fresh' | 'snapshot'
  reason?: string
  snapshotAt?: number
}

/** 晨间简报（事实版；items/text 保持不变，coverage 为六态载体） */
export interface MorningDigestPayload {
  date: string
  items: Array<{ sessionId: string; displayName: string; reason: string; taskId?: number; status?: string; group?: string }>
  text: string
  aiUsed: boolean
  createdAt: number
  coverage?: DigestCoveragePayload
}

/** 当日用量与额度快照（PRD §5.5）。cost 的单位由 currency 决定；
 *  unpricedCalls > 0 表示有调用使用了未收录刊例价的模型，金额未计入，不得读作 0 花费。 */
export interface AiUsageBudgetSnapshot {
  calls: number
  blockedCalls: number
  cost: number
  currency: 'USD' | 'CNY'
  unpricedCalls: number
  limit: number
  level: 'ok' | 'warn' | 'blocked' | 'off'
  message: string
}

export interface AiUsageGetPayload {
  ok: boolean
  rows: Array<Record<string, unknown>>
  budget: AiUsageBudgetSnapshot | null
  priceTableAsOf: string
  priceTableSource: string
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }

  // Electron 类型声明
  namespace Electron {
    interface OpenDialogOptions {
      title?: string
      defaultPath?: string
      filters?: { name: string; extensions: string[] }[]
      properties?: ('openFile' | 'openDirectory' | 'multiSelections' | 'createDirectory')[]
    }
    interface OpenDialogReturnValue {
      canceled: boolean
      filePaths: string[]
    }
    interface SaveDialogOptions {
      title?: string
      defaultPath?: string
      filters?: { name: string; extensions: string[] }[]
    }
    interface SaveDialogReturnValue {
      canceled: boolean
      filePath?: string
    }
  }
}

// ─── 年度经营复盘（S3）报告类型（与 electron/services/annualReviewReport.ts / S1/S2 统计层同源）───
// 口径语义详见 docs/设计-年度经营复盘-规格.md；UI 只渲染不推断（§7.1）。

export interface AnnualReviewMetricWarning {
  code: string
  message: string
  count?: number
}

export interface AnnualReviewCoverage {
  source: string
  status: 'complete' | 'partial' | 'snapshot_only' | 'unavailable'
  coverageFrom?: number
  coverageTo?: number
  rows?: number
  reasonCodes?: string[]
  exactCoverage?: boolean
  coverageRatio?: number | null
}

export interface AnnualReviewMetric<T> {
  /** unavailable 时为 null；0 是真实零 */
  value: T | null
  state: 'complete' | 'partial' | 'snapshot_only' | 'unavailable'
  warnings: AnnualReviewMetricWarning[]
}

export interface AnnualReviewSummaryMetrics {
  customerTotal: AnnualReviewMetric<number>
  customerNew: AnnualReviewMetric<number>
  customerActive: AnnualReviewMetric<number>
  contractCount: AnnualReviewMetric<number>
  contractAmount: AnnualReviewMetric<number>
  creditedAmount: AnnualReviewMetric<number>
  shippedCount: AnnualReviewMetric<number>
  shippedAmount: AnnualReviewMetric<number>
  dealingCustomers: AnnualReviewMetric<number>
  avgDealSize: AnnualReviewMetric<number>
}

export interface AnnualReviewFunnelBucketCount {
  bucket: '了解' | '比价' | '决策' | '成交' | '流失' | '未知'
  count: number
}

export interface AnnualReviewDistributionBlock {
  kind: 'current_snapshot' | 'historical_reconstruction'
  /** unavailable（覆盖率不足/总体为空声明）时可能为 null 或全零分布，以 coverage.status 为准 */
  distribution: AnnualReviewFunnelBucketCount[] | null
  coverage: AnnualReviewCoverage
  warnings: AnnualReviewMetricWarning[]
}

export interface AnnualReviewStageFlowBlock {
  distribution: AnnualReviewFunnelBucketCount[]
  coverage: AnnualReviewCoverage
  warnings: AnnualReviewMetricWarning[]
}

export interface AnnualReviewStuckBlock {
  value: number | null
  coverage: AnnualReviewCoverage
  warnings: AnnualReviewMetricWarning[]
}

export interface AnnualReviewLostBreakdownBlock {
  kind: 'current_snapshot' | 'historical_reconstruction'
  customerPreviousStage: AnnualReviewFunnelBucketCount[] | null
  opportunityReasons: Array<{ reason: string; count: number }> | null
  coverage: AnnualReviewCoverage
  warnings: AnnualReviewMetricWarning[]
}

export interface AnnualReviewFunnelBlock {
  customerStage: AnnualReviewDistributionBlock
  opportunityStage: AnnualReviewDistributionBlock
  stageFlow: AnnualReviewStageFlowBlock
  stuck: AnnualReviewStuckBlock
  lostBreakdown: AnnualReviewLostBreakdownBlock
}

export interface AnnualReviewListBlock<T> {
  value: T | null
  coverage: AnnualReviewCoverage
  warnings: AnnualReviewMetricWarning[]
}

export interface AnnualReviewCustomersBlock {
  highValue: AnnualReviewListBlock<Array<{ accountId: number; name: string | null; creditedAmount: number; contractAmount: number }>>
  newCustomers: AnnualReviewListBlock<Array<{ accountId: number; name: string | null; createdAt: number; imported: boolean }>>
  dealing: AnnualReviewListBlock<Array<{ accountId: number; name: string | null; contractCount: number; contractAmount: number; firstSignDate: number }>>
  repeat: AnnualReviewListBlock<Array<{ accountId: number; name: string | null; contractCount: number; contractAmount: number }>>
  /** C5–C8 行只引用业务身份（规格 §7.2）；统计层 sessionId 不进入公开报告 */
  active: AnnualReviewListBlock<Array<{ accountId: number | null; name: string | null }>>
  silent: AnnualReviewListBlock<Array<{ accountId: number | null; customerId: string | null; name: string | null; lastContactAtMs: number }>>
  risk: AnnualReviewListBlock<Array<{ accountId: number | null; customerId: string | null; name: string | null; stage: string; lastContactAtMs: number }>>
  priority: AnnualReviewListBlock<Array<{ accountId: number | null; customerId: string | null; name: string | null; lastContactAtMs: number }>>
}

/** 尚未实现区块的显式占位（D/E 组、月度趋势）：UI 按 unavailable 渲染，绝不显示为 0 */
export interface AnnualReviewUnavailableBlock {
  status: 'unavailable'
  reasonCodes: string[]
}

/** 本报告涉及数据源的实际最早/最晚有效事实时间；空数据没有真实范围 → 双 null */
export interface AnnualReviewDataRange {
  from: number | null
  to: number | null
}

/** 完整性区块 id（稳定枚举） */
export type AnnualReviewBlockId = 'summary' | 'funnel' | 'customers' | 'monthly' | 'communication' | 'salesAssignment'

export interface AnnualReviewCompleteness {
  overall: AnnualReviewCoverage['status']
  blocks: Record<AnnualReviewBlockId, AnnualReviewCoverage['status']>
}

/** 全指标 warnings 聚合行：同 code 合并；metricKeys/counts 稳定排序（count 不跨指标相加） */
export interface AnnualReviewAggregatedWarning {
  code: string
  message: string
  metricKeys: string[]
  counts?: Record<string, number>
}

export interface AnnualReviewSourceSummaryRow {
  source: string
  tables: string[]
  rows: number
  note?: string
}

/** D 组沟通质量区块（S5；D7 行已映射业务身份，无 sessionId） */
export interface AnnualReviewCommunicationBlock {
  /** D1 年度客户消息量 */
  volume: { value: number | null; state: AnnualReviewCoverage['status']; warnings: AnnualReviewMetricWarning[] }
  /** D2 有沟通客户数（=A3 同一结果） */
  contacted: { value: number | null; state: AnnualReviewCoverage['status']; warnings: AnnualReviewMetricWarning[] }
  /** D3 主动联系率（0–1）；unavailable（无消息）时为 null */
  outboundRate: { value: number | null; state: AnnualReviewCoverage['status']; warnings: AnnualReviewMetricWarning[] }
  /** D5 月度沟通趋势（本地月 'YYYY-MM' 升序单序列） */
  monthlyTrend: { months: Array<{ month: string; count: number }> | null; state: AnnualReviewCoverage['status']; warnings: AnnualReviewMetricWarning[] }
  /** D7 长期未联系客户（仅 current_year/all_time；历史年度 unavailable） */
  longSilent: { value: Array<{ accountId: number | null; customerId: string | null; name: string | null; lastContactAtMs: number }> | null; state: AnnualReviewCoverage['status']; warnings: AnnualReviewMetricWarning[] }
}

/** E 组销售与分配区块（S5；E1 分项事实不相加，无 E2/E6/E7） */
export interface AnnualReviewSalesAssignmentBlock {
  assignedFacts: {
    /** 初始分配（lead_assign，按 salesName+mode 分组）——不得与移交相加命名 */
    initialAssignments: { total: number; groups: Array<{ salesName: string | null; mode: string | null; count: number }> }
    /** 移入（lead_transfer 按 detail.toSales） */
    transfersIn: { total: number; groups: Array<{ salesName: string | null; count: number }> }
    /** 移出（lead_transfer 按 detail.fromSales） */
    transfersOut: { total: number; groups: Array<{ salesName: string | null; count: number }> }
  }
  /** sync 缺口 → partial + exactCoverage=false + coverageRatio=null */
  coverage: AnnualReviewCoverage
  warnings: AnnualReviewMetricWarning[]
  effectiveFollowup: { value: number | null; state: AnnualReviewCoverage['status']; warnings: AnnualReviewMetricWarning[] }
  contractContribution: { value: Array<{ ownerSales: string | null; contractCount: number; totalAmount: number }> | null; state: AnnualReviewCoverage['status']; warnings: AnnualReviewMetricWarning[] }
  creditedContribution: { value: Array<{ salesName: string | null; totalAmount: number }> | null; state: AnnualReviewCoverage['status']; warnings: AnnualReviewMetricWarning[] }
}

export interface AnnualReviewReport {
  reportSchemaVersion: number
  /** 年份；0 = 历史以来 */
  year: number
  scopeKind: 'current_year' | 'historical_year' | 'all_time'
  periodStart: number | null
  periodEndExclusive: number | null
  /** current_year/all_time = generatedAt；historical_year = periodEndExclusive */
  asOf: number
  /** 永远只表示报告实际生成时间，不兼作历史数据时点 */
  generatedAt: number
  timezoneNote: 'local'
  /** 本次报告实际输入并参与计算的有效事实时间范围（参与窗口并集）；空数据双 null */
  dataRange: AnnualReviewDataRange
  /** 四态完整性（统计层结果聚合；UI 不计算） */
  completeness: AnnualReviewCompleteness
  /** 稳定 metricKey → 覆盖结构（B/C 复用统计层；A 组组装层单一映射） */
  coverage: Record<string, AnnualReviewCoverage>
  /** 全指标 warnings 聚合 */
  warnings: AnnualReviewAggregatedWarning[]
  summary: AnnualReviewSummaryMetrics
  funnel: AnnualReviewFunnelBlock
  customers: AnnualReviewCustomersBlock
  monthly: AnnualReviewUnavailableBlock
  /** D 组沟通质量（S5） */
  communication: AnnualReviewCommunicationBlock
  /** E 组销售与分配（S5） */
  salesAssignment: AnnualReviewSalesAssignmentBlock
  /** 真实输入事实与消息统计来源摘要（行数确定、无敏感内容） */
  sourceSummary: AnnualReviewSourceSummaryRow[]
}

export { }
