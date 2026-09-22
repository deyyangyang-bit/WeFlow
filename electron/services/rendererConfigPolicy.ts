/**
 * rendererConfigPolicy.ts —— 渲染层 config:get/set 白名单策略（H2，可单测纯模块，零 Electron 依赖）
 *
 * 背景：config:get/config:set 此前接受任意 key，渲染层可读出 decryptKey、wxidConfigs 内密钥、
 * httpApiToken、aiModelApiKey，甚至 authPassword / centralSyncDeviceToken 等全部秘密。
 * 本模块建立两条硬边界：
 *   ① **秘密键（SECRET_CONFIG_KEYS）永远不经过通用 config:get / config:set**——它们要么是
 *      主进程专用（centralSyncDeviceToken / authPassword / authHelloSecret / aiInsightWeiboCookie），
 *      要么只经 secretConfigIpc 的专用端点写入、以 hasValue/maskedValue 状态读出
 *      （decryptKey / imageAesKey / imageXorKey / wxidConfigs / httpApiToken / aiModelApiKey，
 *      含旧键 aiInsightApiKey）。注意：这不是「白名单里仍带秘密键」的白名单——秘密键在
 *      白名单之外，专用端点也只写不回显。
 *   ② **未知 key 一律拒绝**：读取返回 undefined（记警告），写入直接抛错。
 * 可读 / 可写清单 = 渲染层 CONFIG_KEYS 全集 - 秘密键 - 主进程托管状态键（centralSync 绑定回填
 * 的 workspace/device/employee/role/displayName/lastError 等，只能由 main 写）；
 * 另放行 *CacheMap 后缀的大体积 UI 缓存键（ConfigService 有独立旁路存储）。
 */

/** 秘密键：通用 config:get/set 一律拒绝；读取/写入走 secretConfigIpc 专用端点或主进程内部 */
export const SECRET_CONFIG_KEYS: ReadonlySet<string> = new Set([
  'decryptKey',
  'imageAesKey',
  'imageXorKey',
  'wxidConfigs',
  'authPassword',
  'authHelloSecret',
  'httpApiToken',
  'aiModelApiKey',
  'aiInsightApiKey', // 旧「AI 见解 Key」：migrateAiConfig 已并入 aiModelApiKey，同属秘密
  'centralSyncDeviceToken',
  'aiInsightWeiboCookie',
  'aiInsightTelegramToken',
  'aiInsightWecomWebhook'
])

/**
 * 受限地址键（P0）：**可读但不得由通用 config:set 写入**。
 * 这些配置决定主进程把凭据/业务上下文发到哪里——被攻破的渲染层改写地址即可
 * 间接窃取 aiModelApiKey / centralSyncDeviceToken / 数据库文件位置。写入只经
 * 用途明确的专用主进程 IPC（serviceaddr:* / dbpath:* / export:*），且地址变化时
 * 主进程原子清除对应凭据。
 */
export const RESTRICTED_WRITE_CONFIG_KEYS: ReadonlySet<string> = new Set([
  'aiModelApiBaseUrl',
  'aiInsightApiBaseUrl',
  'centralSyncBaseUrl',
  'dbPath',
  'exportPath'
])

/** 主进程托管状态键：可读（设置页展示），但渲染层不得写——写者只有绑定/同步主流程 */
export const MAIN_MANAGED_CONFIG_KEYS: ReadonlySet<string> = new Set([
  'centralSyncWorkspaceId',
  'centralSyncEmployeeId',
  'centralSyncDeviceId',
  'centralSyncRole',
  'centralSyncDisplayName',
  'centralSyncLastError',
  'centralSyncLastErrorAt',
  /** P1b：导出授权根（主进程持久化，经原生对话框批准），渲染层零读写 */
  'exportAuthorizedRoots'
])

/** 渲染层可读白名单（另放行 *CacheMap 后缀） */
export const RENDERER_READABLE_CONFIG_KEYS: ReadonlySet<string> = new Set([
  'dbPath', 'myWxid', 'theme', 'themeId',
  'lastSession', 'windowBounds', 'cachePath', 'launchAtStartup',
  'silentStartup', 'exportPath', 'agreementAccepted', 'logEnabled',
  'onboardingDone', 'llmModelPath', 'whisperModelName', 'whisperModelDir',
  'whisperDownloadSource', 'autoTranscribeVoice', 'transcribeLanguages', 'exportDefaultFormat',
  'exportDefaultAvatars', 'exportDefaultDateRange', 'exportDefaultFileNamingMode', 'exportDefaultMedia',
  'exportDefaultVoiceAsText', 'exportDefaultPathStyle', 'exportDefaultExcelCompactColumns', 'exportDefaultTxtColumns',
  'exportDefaultConcurrency', 'exportDefaultDisplayNamePreference', 'exportWriteLayout', 'exportSessionNamePrefixEnabled',
  'exportLastSessionRunMap', 'exportLastContentRunMap', 'exportSessionRecordMap', 'exportLastSnsPostCount',
  'exportSessionMessageCountCacheMap', 'exportSessionContentMetricCacheMap', 'exportSnsStatsCacheMap', 'exportSnsUserPostCountsCacheMap',
  'exportSessionMutualFriendsCacheMap', 'exportAutomationTaskMap', 'snsPageCacheMap', 'contactsLoadTimeoutMs',
  'contactsListCacheMap', 'contactsAvatarCacheMap', 'authEnabled', 'authUseHello',
  'ignoredUpdateVersion', 'updateChannel', 'notificationEnabled', 'aiInsightNotificationEnabled',
  'notificationPosition', 'notificationFilterMode', 'notificationFilterList', 'httpApiEnabled',
  'httpApiPort', 'httpApiHost', 'messagePushEnabled', 'messagePushFilterMode',
  'messagePushFilterList', 'windowCloseBehavior', 'quoteLayout', 'wordCloudExcludeWords',
  'crmAutoConfirmEnabled', 'crmAutoConfirmThreshold', 'crmAutoConfirmInvoiceDocgen', 'crmEnrichEnabled',
  'crmEnrichThreshold', 'crmEnrichAutoApply', 'crmEnrichBackfillLimit', 'crmLeadSlaHours',
  'crmLeadSourcePreset', 'crmSalesList', 'crmAssignWeights', 'crmLogisticsOverdueHours',
  'autoBackupNetworkPath', 'autoBackupTime', 'lanSyncSharedDir', 'lanSyncRole',
  'centralSyncEnabled', 'centralSyncBaseUrl', 'centralSyncPollIntervalMin', 'aiModelApiBaseUrl',
  'aiModelApiModel', 'aiModelApiMaxTokens', 'aiDailyCallLimitEnabled', 'aiDailyCallLimit',
  'aiInsightEnabled', 'aiInsightApiBaseUrl', 'aiInsightApiModel', 'aiInsightAllowContext',
  'aiInsightAllowMomentsContext', 'aiInsightMomentsContextCount', 'aiInsightMomentsBindings', 'aiInsightAllowSocialContext',
  'aiInsightFilterMode', 'aiInsightFilterList', 'aiInsightNonCustomerBlacklist', 'reportExcludedSessions',
  'aiInsightWhitelistEnabled', 'aiInsightWhitelist', 'aiInsightContextCount', 'aiInsightSocialContextCount',
  'aiInsightSystemPrompt', 'aiInsightTelegramEnabled', 'aiInsightTelegramChatIds',
  'aiInsightWecomEnabled', 'aiInsightWeiboBindings', 'aiFootprintEnabled',
  'aiFootprintSystemPrompt', 'aiGroupSummaryEnabled', 'aiGroupSummaryIntervalHours', 'aiGroupSummarySystemPrompt',
  'aiGroupSummaryFilterMode', 'aiGroupSummaryFilterList', 'aiMessageInsightEnabled', 'aiMessageInsightContextCount',
  'aiMessageInsightSystemPrompt', 'aiInsightDebugLogEnabled', 'autoDownloadHighRes', 'autoDownloadWhitelist',
  // schema 内非秘密补充键（渲染层/身份档案/CRM 调度等按需读取）
  'language', 'identityName', 'identityRole', 'identityOnboardingDismissed',
  'crmInternalList', 'crmInternalGroups', 'salesTeamAdded', 'salesTeamRemoved',
  'crmSlaRecycleIntervalMin', 'crmFriendDetectIntervalMin', 'crmSla2ScanIntervalMin',
  'centralSyncEmployeeAlias', 'centralSyncSupervisorCode', 'lastOpenedDb'
])

/** 渲染层可写白名单 = 可读集合 - 主进程托管键（CacheMap 键可写） */
export const RENDERER_WRITABLE_CONFIG_KEYS: ReadonlySet<string> = new Set(
  [...RENDERER_READABLE_CONFIG_KEYS].filter((k) => !MAIN_MANAGED_CONFIG_KEYS.has(k))
)

export const isCacheMapKey = (key: string): boolean => key.endsWith('CacheMap')

/** 读边界：秘密键抛错（显式拒绝）；白名单外未知键返回 false 由调用方给 undefined */
export function classifyRendererRead(key: string): 'allowed' | 'secret' | 'unknown' {
  const k = String(key || '')
  if (SECRET_CONFIG_KEYS.has(k)) return 'secret'
  if (RENDERER_READABLE_CONFIG_KEYS.has(k) || isCacheMapKey(k)) return 'allowed'
  return 'unknown'
}

export function classifyRendererWrite(key: string): 'allowed' | 'secret' | 'restricted-address' | 'main-managed' | 'unknown' {
  const k = String(key || '')
  if (SECRET_CONFIG_KEYS.has(k)) return 'secret'
  if (RESTRICTED_WRITE_CONFIG_KEYS.has(k)) return 'restricted-address'
  if (MAIN_MANAGED_CONFIG_KEYS.has(k)) return 'main-managed'
  if (RENDERER_WRITABLE_CONFIG_KEYS.has(k) || isCacheMapKey(k)) return 'allowed'
  return 'unknown'
}

/** 通用 config:get 的执行体（main.ts 与测试共用）：拒绝时抛错/返回 undefined，不泄漏存在性 */
export function readRendererConfig(config: { get(key: string): unknown }, key: string): unknown {
  const kind = classifyRendererRead(key)
  if (kind === 'allowed') return config.get(String(key))
  if (kind === 'secret') {
    throw new Error(`config:get 拒绝读取敏感配置「${String(key)}」：请使用对应的专用端点`)
  }
  console.warn(`[ConfigPolicy] config:get 未知 key 被拒绝: ${String(key)}`)
  return undefined
}

/** 通用 config:set 的执行体：秘密/托管/未知 key 一律抛错，绝不落库 */
export function writeRendererConfig(config: { set(key: string, value: unknown): void }, key: string, value: unknown): void {
  const kind = classifyRendererWrite(key)
  if (kind === 'allowed') {
    config.set(String(key), value)
    return
  }
  if (kind === 'secret') {
    throw new Error(`config:set 拒绝写入敏感配置「${String(key)}」：请使用对应的专用端点`)
  }
  if (kind === 'restricted-address') {
    throw new Error(`config:set 拒绝写入受限服务地址「${String(key)}」：地址变更须经专用端点并清除旧凭据`)
  }
  if (kind === 'main-managed') {
    throw new Error(`config:set 拒绝写入主进程托管状态「${String(key)}」`)
  }
  throw new Error(`config:set 拒绝未知配置键「${String(key)}」`)
}
