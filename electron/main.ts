import './preload-env'
import { app, BrowserWindow, ipcMain, nativeTheme, session, Tray, Menu, nativeImage } from 'electron'
import { Worker } from 'worker_threads'
import { randomUUID } from 'crypto'
import { join, dirname } from 'path'
import { autoUpdater } from 'electron-updater'
import { readFile, writeFile, mkdir, rm, readdir, copyFile } from 'fs/promises'
import { existsSync } from 'fs'
import { ConfigService } from './services/config'
import { dbPathService } from './services/dbPathService'
import { wcdbService } from './services/wcdbService'
import { chatService } from './services/chatService'
import { imageDecryptService } from './services/imageDecryptService'
import { imagePreloadService } from './services/imagePreloadService'
import { analyticsService } from './services/analyticsService'
import { groupAnalyticsService } from './services/groupAnalyticsService'
import { annualReportService } from './services/annualReportService'
import { exportService, ExportOptions, ExportProgress } from './services/export'
import { exportTaskControlService } from './services/exportTaskControlService'
import { KeyService } from './services/keyService'
import { KeyServiceLinux } from './services/keyServiceLinux'
import { KeyServiceMac } from './services/keyServiceMac'
import { voiceTranscribeService } from './services/voiceTranscribeService'
import { videoService } from './services/videoService'
import { snsService, isVideoUrl } from './services/snsService'
import { windowsHelloService } from './services/windowsHelloService'
import { exportCardDiagnosticsService } from './services/exportCardDiagnosticsService'


// ─── 销售助手模块 ─────────────────────────────────────────────────────────────
import { salesDbService } from './services/salesDbService'
import { getActionFunnel, getActionFunnelBreakdown } from './services/actionFunnel'
import { stripStageFromUpsert, type CustomerUpsertInput } from './services/customerUpsertPolicy'
import { applyManualStageCorrection } from './services/legalStageWriters'
import { createEvidenceResolver } from './services/evidenceResolver'
import { salesKnowledgeService } from './services/salesKnowledgeService'
import { salesReportService } from './services/salesReportService'
import { salesIntentService } from './services/salesIntentService'
import { salesReplyService } from './services/salesReplyService'
import { salesFollowUpService } from './services/salesFollowUpService'
import { salesLog } from './services/salesLogger'
import { setActionEngineConfig, startActionEngineScheduler, getTodayActions, completeAction, generateSuggestion, generateActionAnalysis, onNewMessage as actionOnNewMessage, getUnifiedSignals, completeUnifiedSignal, recordUserActionEvent } from './services/salesActionEngine'
import { persistActionAnalysisJudgments } from './services/salesActionAnalysisJudgment'
import { getCustomerCurrentView } from './services/customerCurrentView'
import { registerCrmIpcHandlers } from './services/crmIpcHandlers'
import { registerEvalIpcHandlers } from './services/evalIpcHandlers'
import { registerIdentityIpcHandlers } from './services/identityIpcHandlers'
import { registerLanSyncIpcHandlers } from './services/lanSyncIpcHandlers'
import { startLanSyncScheduler, getLanSyncConfig } from './services/lanSyncService'
import { startWeeklyReviewScheduler } from './services/salesReportService'
import { morningDigestService } from './services/morningDigestService'
import { destroyNotificationWindow, registerNotificationHandlers, showNotification, setNotificationNavigateHandler } from './windows/notificationWindow'
import { httpService } from './services/httpService'
import { messagePushService } from './services/messagePushService'
import { insightService } from './services/insightService'
import { insightRecordService } from './services/insightRecordService'
import { insightProfileService } from './services/insightProfileService'
import { judgeAndImportCrmCustomer, backfillImportFromInsightRecords, collectInternalGroupMembers } from './services/crmImportService'
import { enrichCustomer } from './services/crmEnrichService'
import { enqueueSalesTask } from './services/salesQueue'
import { crmDbService } from './services/crmDbService'
import { migrateLegacyBusinessDbs } from './services/businessDbPath'
import { resetLegacyGroupScanSla, cleanupLegacyGroupScanTags } from './services/crmLeadService'
import { restoreLegacyGroupScanAssignments, backfillAssignmentSla1, correctSla1Misrecycle, syncLeadDeadlineFromAssignment, startSlaRecycleScheduler } from './services/crmAssignmentService'
import { startFriendDetectScheduler, type ContactLite } from './services/crmFriendDetectService'
import { startSla2ScanScheduler, type Sla2MessageLite } from './services/crmSla2Service'
import { startSla2LlmScanScheduler, setSla2LlmScanDeps } from './services/crmSla2LlmScanService'
import { startPaymentPromiseScanScheduler } from './services/crmPaymentPromiseService'
import { getAiModelConfig, callChatCompletion, isAiConfigured } from './services/ai/aiApiClient'
import { runStockDataMigration } from './services/crmMigrationService'
import { registerAutoBackupIpcHandlers } from './services/autoBackupIpcHandlers'
import { startAutoBackupScheduler } from './services/autoBackupService'
import { groupSummaryService } from './services/groupSummaryService'
import { normalizeWeiboCookieInput, weiboService } from './services/social/weiboService'
import { bizService } from './services/bizService'
import { backupService } from './services/backupService'
import { imageDownloadService } from './services/imageDownloadService'
import { initAlertService } from './services/alertService'

// P0-2B：证据链统一读入口。注入真实 chatService（其已具备 getMessageById /
// getMessageByServerId / getMessagesAround 三个公开原语），仅由 sales:evidence:getByKey 调用。
const evidenceResolver = createEvidenceResolver({
  getMessageById: (sessionId, localId) => chatService.getMessageById(sessionId, localId),
  getMessageByServerId: (sessionId, svrid) => chatService.getMessageByServerId(sessionId, svrid),
  getMessagesAround: (sessionId, target, count) => chatService.getMessagesAround(sessionId, target, count)
})

// 阶段三例外告警（设计-AI见解重定位 §4.1）：注入真实依赖（证据回查复用 evidenceResolver；
// 幂等/落库走 insightRecordService），crmParseService 竞品命中点经 getAlertService() 取用
initAlertService({
  getEvidenceByKey: (sessionId, messageKey, evidenceText) => evidenceResolver.getEvidenceByKey(sessionId, messageKey, evidenceText),
  hasRecentAlert: (sessionId, triggerReason, windowMs) => insightRecordService.hasRecentAlert(sessionId, triggerReason, windowMs),
  addRecord: (input) => insightRecordService.addRecord(input as unknown as Parameters<typeof insightRecordService.addRecord>[0]),
  log: (level, message) => salesLog(level as 'INFO' | 'WARN', message)
})

// 屏幕采集去节流（仅影响通知玻璃的 Chromium 流回退管线；Windows 主路径为
// 原生面板渲染，不经过 Chromium 采集）：默认桌面采集 CPU 预算限制在 50%，
// 会自适应压低采集帧率、显著增加回退路径下折射的跟随延迟。
// 回退采集只在通知展示的数秒内运行且分辨率已降为逻辑尺寸，放开预算不影响常态性能
app.commandLine.appendSwitch('webrtc-max-cpu-consumption-percentage', '100')

// 配置自动更新
autoUpdater.autoDownload = false
autoUpdater.autoInstallOnAppQuit = true
autoUpdater.disableDifferentialDownload = true  // 禁用差分更新，强制全量下载
// 更新通道策略：
// - 稳定版（如 4.3.0）默认走 latest
// - 预览版（如 0.26.2）默认走 preview（0.年.当年发布序号）
// - 开发版（如 26.4.5）默认走 dev（年.月.日）
// - 用户可在设置页切换稳定/预览/开发，切换后即时生效
// 同时区分 Windows x64 / arm64，避免更新清单互相覆盖。
const appVersion = app.getVersion()
const inferUpdateTrackFromVersion = (version: string): 'stable' | 'preview' | 'dev' => {
  const normalized = String(version || '').trim().replace(/^v/i, '')
  if (/^0\.\d{2}\.\d+$/i.test(normalized)) return 'preview'
  if (/^\d{2}\.\d{1,2}\.\d{1,2}$/i.test(normalized)) return 'dev'
  // 兼容旧版命名（如 4.3.0-preview.26.1 / 4.3.0-dev.26.3.4）
  if (/-preview\.\d+\.\d+$/i.test(normalized)) return 'preview'
  if (/-dev\.\d+\.\d+\.\d+$/i.test(normalized)) return 'dev'
  // 兼容 alpha/beta/rc 预发布
  if (/(alpha|beta|rc)/i.test(normalized)) return 'dev'
  return 'stable'
}

const defaultUpdateTrack: 'stable' | 'preview' | 'dev' = (() => {
  const inferred = inferUpdateTrackFromVersion(appVersion)
  if (inferred === 'preview' || inferred === 'dev') return inferred
  return 'stable'
})()
let configService: ConfigService | null = null
const activeExportWorkers = new Map<string, Worker>()
const activeExportTasks = new Set<string>()

type ResourceDiagnosticsEntry = {
  ts: number
  payload: Record<string, unknown>
}

const resourceDiagnosticsEntries: ResourceDiagnosticsEntry[] = []
const maxResourceDiagnosticsEntries = 240
let resourceDiagnosticsPreloadTotalsBaseline: Record<string, number> | null = null

const sanitizeResourceDiagnosticsPayload = (payload: unknown): Record<string, unknown> => {
  if (!payload || typeof payload !== 'object') return {}
  try {
    const serialized = JSON.stringify(payload)
    if (serialized.length > 24_000) {
      return {
        truncated: true,
        size: serialized.length
      }
    }
    return JSON.parse(serialized)
  } catch {
    return { unserializable: true }
  }
}

const getRecordValue = (value: unknown, key: string): unknown => {
  if (!value || typeof value !== 'object') return undefined
  return (value as Record<string, unknown>)[key]
}

const getNumericRecordValue = (value: unknown, path: string[]): number => {
  let current: unknown = value
  for (const key of path) {
    current = getRecordValue(current, key)
  }
  const numeric = Number(current)
  return Number.isFinite(numeric) ? numeric : 0
}

const summarizeResourceDiagnostics = (
  entries: ResourceDiagnosticsEntry[],
  preloadTotalsBaseline: Record<string, number> | null = resourceDiagnosticsPreloadTotalsBaseline
): Record<string, unknown> => {
  const counterDeltas: Record<string, number> = {}
  const preloadTotalDeltas: Record<string, number> = {}
  let longFrames = 0
  let maxRecentFrameMs = 0
  let maxQueued = 0
  let maxQueuedCache = 0
  let maxQueuedDecrypt = 0
  let maxQueuedHigh = 0
  let maxQueuedNormal = 0
  let maxQueuedLow = 0
  let maxActiveCache = 0
  let maxActiveDecrypt = 0
  let maxPending = 0
  let maxHighWaterQueued = 0
  let maxHighWaterQueuedDecrypt = 0
  let maxHighWaterQueuedLow = 0
  let maxHighWaterActiveDecrypt = 0
  let mediaStreamMaxLoadMs = 0

  for (const entry of entries) {
    const payload = entry.payload
    longFrames += getNumericRecordValue(payload, ['frameDelta', 'longFrames'])
    maxRecentFrameMs = Math.max(maxRecentFrameMs, getNumericRecordValue(payload, ['frameDelta', 'recentMaxFrameMs']))
    maxQueued = Math.max(maxQueued, getNumericRecordValue(payload, ['preloadStats', 'queued']))
    maxQueuedCache = Math.max(maxQueuedCache, getNumericRecordValue(payload, ['preloadStats', 'queuedCache']))
    maxQueuedDecrypt = Math.max(maxQueuedDecrypt, getNumericRecordValue(payload, ['preloadStats', 'queuedDecrypt']))
    maxQueuedHigh = Math.max(maxQueuedHigh, getNumericRecordValue(payload, ['preloadStats', 'queuedHigh']))
    maxQueuedNormal = Math.max(maxQueuedNormal, getNumericRecordValue(payload, ['preloadStats', 'queuedNormal']))
    maxQueuedLow = Math.max(maxQueuedLow, getNumericRecordValue(payload, ['preloadStats', 'queuedLow']))
    maxActiveCache = Math.max(maxActiveCache, getNumericRecordValue(payload, ['preloadStats', 'activeCache']))
    maxActiveDecrypt = Math.max(maxActiveDecrypt, getNumericRecordValue(payload, ['preloadStats', 'activeDecrypt']))
    maxPending = Math.max(maxPending, getNumericRecordValue(payload, ['preloadStats', 'pending']))
    maxHighWaterQueued = Math.max(maxHighWaterQueued, getNumericRecordValue(payload, ['preloadStats', 'highWater', 'queued']))
    maxHighWaterQueuedDecrypt = Math.max(maxHighWaterQueuedDecrypt, getNumericRecordValue(payload, ['preloadStats', 'highWater', 'queuedDecrypt']))
    maxHighWaterQueuedLow = Math.max(maxHighWaterQueuedLow, getNumericRecordValue(payload, ['preloadStats', 'highWater', 'queuedLow']))
    maxHighWaterActiveDecrypt = Math.max(maxHighWaterActiveDecrypt, getNumericRecordValue(payload, ['preloadStats', 'highWater', 'activeDecrypt']))
    mediaStreamMaxLoadMs = Math.max(
      mediaStreamMaxLoadMs,
      getNumericRecordValue(payload, ['counters', 'mediaStreamMaxLoadMs']),
      getNumericRecordValue(payload, ['delta', 'mediaStreamMaxLoadMs'])
    )

    const delta = getRecordValue(payload, 'delta')
    if (delta && typeof delta === 'object') {
      for (const [key, value] of Object.entries(delta as Record<string, unknown>)) {
        const numeric = Number(value)
        if (!Number.isFinite(numeric)) continue
        counterDeltas[key] = (counterDeltas[key] || 0) + numeric
      }
    }
  }

  const lastTotals = getRecordValue(getRecordValue(entries[entries.length - 1]?.payload, 'preloadStats'), 'totals')
  const firstTotals = preloadTotalsBaseline || getRecordValue(getRecordValue(entries[0]?.payload, 'preloadStats'), 'totals')
  if (firstTotals && typeof firstTotals === 'object' && lastTotals && typeof lastTotals === 'object') {
    const keys = new Set([
      ...Object.keys(firstTotals as Record<string, unknown>),
      ...Object.keys(lastTotals as Record<string, unknown>)
    ])
    for (const key of keys) {
      const first = Number((firstTotals as Record<string, unknown>)[key])
      const last = Number((lastTotals as Record<string, unknown>)[key])
      if (!Number.isFinite(first) || !Number.isFinite(last)) continue
      preloadTotalDeltas[key] = last - first
    }
  }

  const mediaStreamLoadSamples = counterDeltas.mediaStreamLoadSamples || 0
  const mediaStreamLoadMsTotal = counterDeltas.mediaStreamLoadMsTotal || 0
  const mediaStreamPageCacheHits = counterDeltas.mediaStreamPageCacheHits || 0
  const mediaStreamInflightMerges = counterDeltas.mediaStreamInflightMerges || 0
  const mediaStreamAvoidedNativeLoads = mediaStreamPageCacheHits + mediaStreamInflightMerges
  const mediaStreamNativeLoads = counterDeltas.mediaStreamNativeLoads || 0
  const mediaStreamRowsLoaded = counterDeltas.mediaStreamRowsLoaded || 0
  const mediaStreamDuplicateRows = counterDeltas.mediaStreamDuplicateRows || 0
  const mediaStreamNoProgressStops = counterDeltas.mediaStreamNoProgressStops || 0
  const preloadAccepted = preloadTotalDeltas.accepted || 0
  const preloadMergedQueued = preloadTotalDeltas.mergedQueued || 0
  const preloadSkippedActive = preloadTotalDeltas.skippedActive || 0
  const preloadSkippedPending = preloadTotalDeltas.skippedPending || 0
  const preloadDeduped = preloadMergedQueued + preloadSkippedActive + preloadSkippedPending
  const preloadHandled = preloadAccepted + preloadDeduped
  const preloadCanceledActive = preloadTotalDeltas.canceledActive || 0
  const preloadDroppedQueued = preloadTotalDeltas.droppedQueued || 0
  const preloadDeferredLowPriority = preloadTotalDeltas.deferredLowPriority || 0
  const preloadLowPriorityIdleDeferrals = preloadTotalDeltas.lowPriorityIdleDeferrals || 0
  const preloadActiveCacheSnapshots = preloadTotalDeltas.activeCacheSnapshots || 0
  const preloadActiveCacheSnapshotSkipped = preloadTotalDeltas.activeCacheSnapshotSkipped || 0
  const preloadActiveCacheSnapshotCanceled = preloadTotalDeltas.activeCacheSnapshotCanceled || 0
  const preloadLowPriorityRejected = preloadTotalDeltas.lowPriorityRejected || 0
  const imagePreloadRejectedCapacity = counterDeltas.imagePreloadRejectedCapacity || 0
  const imagePredecryptRequests = counterDeltas.imagePredecryptRequests || 0
  const imagePredecryptBackpressureSkips = counterDeltas.imagePredecryptBackpressureSkips || 0
  const imagePredecryptRejectedCapacity = counterDeltas.imagePredecryptRejectedCapacity || 0
  const imagePredecryptDeferred = counterDeltas.imagePredecryptDeferred || 0
  const imagePredecryptPreviewUpgrades = counterDeltas.imagePredecryptPreviewUpgrades || 0
  const predecryptHiddenSkips = counterDeltas.predecryptHiddenSkips || 0
  const rangeHiddenSkips = counterDeltas.rangeHiddenSkips || 0
  const rangeDuplicateSkips = counterDeltas.rangeDuplicateSkips || 0
  const rangeVisibilityReschedules = counterDeltas.rangeVisibilityReschedules || 0
  const transientStatePruneRuns = counterDeltas.transientStatePruneRuns || 0

  return {
    samples: entries.length,
    longFrames,
    maxRecentFrameMs,
    maxQueued,
    maxQueuedCache,
    maxQueuedDecrypt,
    maxQueuedHigh,
    maxQueuedNormal,
    maxQueuedLow,
    maxPending,
    maxActiveCache,
    maxActiveDecrypt,
    maxHighWaterQueued,
    maxHighWaterQueuedDecrypt,
    maxHighWaterQueuedLow,
    maxHighWaterActiveDecrypt,
    mediaStreamLoadSamples,
    mediaStreamAvgLoadMs: mediaStreamLoadSamples > 0 ? mediaStreamLoadMsTotal / mediaStreamLoadSamples : 0,
    mediaStreamMaxLoadMs,
    mediaStreamNativeLoads,
    mediaStreamPageCacheHits,
    mediaStreamInflightMerges,
    mediaStreamAvoidedNativeLoads,
    mediaStreamAvoidedNativeRate: mediaStreamLoadSamples > 0 ? mediaStreamAvoidedNativeLoads / mediaStreamLoadSamples : 0,
    mediaStreamPageCacheHitRate: mediaStreamLoadSamples > 0 ? mediaStreamPageCacheHits / mediaStreamLoadSamples : 0,
    mediaStreamRowsLoaded,
    mediaStreamDuplicateRows,
    mediaStreamDuplicateRate: mediaStreamRowsLoaded > 0 ? mediaStreamDuplicateRows / mediaStreamRowsLoaded : 0,
    mediaStreamNoProgressStops,
    preloadAccepted,
    preloadDeduped,
    preloadHandled,
    preloadDedupRate: preloadHandled > 0 ? preloadDeduped / preloadHandled : 0,
    preloadCanceledActive,
    preloadDroppedQueued,
    preloadDeferredLowPriority,
    preloadLowPriorityIdleDeferrals,
    preloadActiveCacheSnapshots,
    preloadActiveCacheSnapshotSkipped,
    preloadActiveCacheSnapshotCanceled,
    preloadLowPriorityRejected,
    imagePreloadRejectedCapacity,
    imagePredecryptRequests,
    imagePredecryptBackpressureSkips,
    imagePredecryptRejectedCapacity,
    imagePredecryptDeferred,
    imagePredecryptPreviewUpgrades,
    imagePredecryptRejectRate: imagePredecryptRequests > 0 ? imagePredecryptRejectedCapacity / imagePredecryptRequests : 0,
    imagePredecryptBackpressureRate: imagePredecryptRequests > 0 ? imagePredecryptBackpressureSkips / imagePredecryptRequests : 0,
    predecryptHiddenSkips,
    rangeHiddenSkips,
    rangeDuplicateSkips,
    rangeVisibilityReschedules,
    transientStatePruneRuns,
    preloadTotalsBaselineCaptured: Boolean(preloadTotalsBaseline),
    counterDeltas,
    preloadTotalDeltas
  }
}

const normalizeExportTaskId = (taskId: unknown): string => String(taskId || '').trim()
const ALLOWED_EXTERNAL_URL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

const normalizeAllowedExternalUrl = (rawUrl: unknown): string | null => {
  const value = String(rawUrl || '').trim()
  if (!value) return null
  try {
    const parsed = new URL(value)
    if (!ALLOWED_EXTERNAL_URL_PROTOCOLS.has(parsed.protocol.toLowerCase())) {
      return null
    }
    return parsed.toString()
  } catch {
    return null
  }
}

const postExportWorkerControl = (taskId: string, action: 'pause' | 'resume' | 'cancel') => {
  const worker = activeExportWorkers.get(taskId)
  if (!worker) return
  try {
    worker.postMessage({ type: `export:${action}` })
  } catch (error) {
    console.warn(`[export-task-control] failed to post ${action} to worker:`, error)
  }
}

const finalizeExportTaskControlResult = async (taskId: string, result: any) => {
  if (!taskId) return result
  if (result?.stopped) {
    const cleanup = await exportTaskControlService.cleanupTask(taskId)
    if (!cleanup.success) {
      return {
        ...result,
        success: false,
        error: `导出已停止，但清理已导出文件失败：${cleanup.error || '未知错误'}`
      }
    }
    return {
      ...result,
      cleanup
    }
  }
  if (!result?.paused) {
    exportTaskControlService.releaseTask(taskId)
  }
  return result
}

const normalizeUpdateTrack = (raw: unknown): 'stable' | 'preview' | 'dev' | null => {
  if (raw === 'stable' || raw === 'preview' || raw === 'dev') return raw
  return null
}

const getEffectiveUpdateTrack = (): 'stable' | 'preview' | 'dev' => {
  const configuredTrack = normalizeUpdateTrack(configService?.get('updateChannel'))
  return configuredTrack || defaultUpdateTrack
}

const isRemoteVersionNewer = (latestVersion: string, currentVersion: string): boolean => {
  const latest = String(latestVersion || '').trim()
  const current = String(currentVersion || '').trim()
  if (!latest || !current) return false

  const parseVersion = (version: string) => {
    const normalized = version.replace(/^v/i, '')
    const [main, pre = ''] = normalized.split('-', 2)
    const core = main.split('.').map((segment) => Number.parseInt(segment, 10) || 0)
    const prerelease = pre ? pre.split('.').map((segment) => /^\d+$/.test(segment) ? Number.parseInt(segment, 10) : segment) : []
    return { core, prerelease }
  }

  const compareParsedVersion = (a: ReturnType<typeof parseVersion>, b: ReturnType<typeof parseVersion>): number => {
    const maxLen = Math.max(a.core.length, b.core.length)
    for (let i = 0; i < maxLen; i += 1) {
      const left = a.core[i] || 0
      const right = b.core[i] || 0
      if (left > right) return 1
      if (left < right) return -1
    }

    const aPre = a.prerelease
    const bPre = b.prerelease
    if (aPre.length === 0 && bPre.length === 0) return 0
    if (aPre.length === 0) return 1
    if (bPre.length === 0) return -1

    const preMaxLen = Math.max(aPre.length, bPre.length)
    for (let i = 0; i < preMaxLen; i += 1) {
      const left = aPre[i]
      const right = bPre[i]
      if (left === undefined) return -1
      if (right === undefined) return 1
      if (left === right) continue

      const leftNum = typeof left === 'number'
      const rightNum = typeof right === 'number'
      if (leftNum && rightNum) return left > right ? 1 : -1
      if (leftNum) return -1
      if (rightNum) return 1
      return String(left) > String(right) ? 1 : -1
    }

    return 0
  }

  try {
    return autoUpdater.currentVersion.compare(latest) < 0
  } catch {
    return compareParsedVersion(parseVersion(latest), parseVersion(current)) > 0
  }
}

const shouldOfferUpdateForTrack = (latestVersion: string, currentVersion: string): boolean => {
  if (isRemoteVersionNewer(latestVersion, currentVersion)) return true
  const effectiveTrack = getEffectiveUpdateTrack()
  const currentTrack = inferUpdateTrackFromVersion(currentVersion)
  // 切换通道后，目标通道最新版本与当前版本不同即提示更新（即使是降级）
  if (effectiveTrack !== currentTrack && latestVersion !== currentVersion) return true
  return false
}

let lastAppliedUpdaterChannel: string | null = null
let lastAppliedUpdaterFeedUrl: string | null = null
const resetUpdaterProviderCache = () => {
  const updater = autoUpdater as any
  // electron-updater 会缓存 provider；切换 channel 后需清理缓存，避免仍请求旧通道
  for (const key of ['clientPromise', '_clientPromise', 'updateInfoAndProvider']) {
    if (Object.prototype.hasOwnProperty.call(updater, key)) {
      updater[key] = null
    }
  }
}

const getUpdaterFeedUrlByTrack = (track: 'stable' | 'preview' | 'dev'): string => {
  const repoBase = 'https://github.com/hicccc77/WeFlow/releases'
  if (track === 'stable') return `${repoBase}/latest/download`
  if (track === 'preview') return `${repoBase}/download/nightly-preview`
  return `${repoBase}/download/nightly-dev`
}

const applyAutoUpdateChannel = (reason: 'startup' | 'settings' = 'startup') => {
  const track = getEffectiveUpdateTrack()
  const currentTrack = inferUpdateTrackFromVersion(appVersion)
  const baseUpdateChannel = track === 'stable' ? 'latest' : track
  const nextFeedUrl = getUpdaterFeedUrlByTrack(track)
  const nextUpdaterChannel =
    process.platform === 'win32' && process.arch === 'arm64'
      ? `${baseUpdateChannel}-arm64`
      : baseUpdateChannel
  if (
    (lastAppliedUpdaterChannel && lastAppliedUpdaterChannel !== nextUpdaterChannel) ||
    (lastAppliedUpdaterFeedUrl && lastAppliedUpdaterFeedUrl !== nextFeedUrl)
  ) {
    resetUpdaterProviderCache()
  }
  autoUpdater.allowPrerelease = track !== 'stable'
  // 只要用户当前选择的目标通道与当前安装版本所属通道不同，就允许跨通道更新（含降级）
  autoUpdater.allowDowngrade = track !== currentTrack
  // 统一走 generic feed，确保 preview/dev 命中各自固定发布页，不受 GitHub provider 的 prerelease 选择影响。
  autoUpdater.setFeedURL({
    provider: 'generic',
    url: nextFeedUrl,
    channel: nextUpdaterChannel
  })
  autoUpdater.channel = nextUpdaterChannel
  lastAppliedUpdaterChannel = nextUpdaterChannel
  lastAppliedUpdaterFeedUrl = nextFeedUrl
}

applyAutoUpdateChannel('startup')
// 二创私人工具：恒禁用自动更新。原 feed 指向上游 hicccc77/WeFlow/releases，
// 启动时会偷偷连上游，点更新会用上游原版覆盖二创（功能性自毁）。
// 此常量是 checkForUpdatesOnStartup / app:checkForUpdates / 下载 IPC 的共同守卫，置 false 后全部早返回。
const AUTO_UPDATE_ENABLED = false

const getLaunchAtStartupUnsupportedReason = (): string | null => {
  if (process.platform !== 'win32' && process.platform !== 'darwin') {
    return '当前平台暂不支持开机自启动'
  }
  if (!app.isPackaged) {
    return '仅安装后的 Windows / macOS 版本支持开机自启动'
  }
  return null
}

const isLaunchAtStartupSupported = (): boolean => getLaunchAtStartupUnsupportedReason() == null

const getStoredLaunchAtStartupPreference = (): boolean | undefined => {
  const value = configService?.get('launchAtStartup')
  return typeof value === 'boolean' ? value : undefined
}

const getSystemLaunchAtStartup = (): boolean => {
  if (!isLaunchAtStartupSupported()) return false
  try {
    return app.getLoginItemSettings().openAtLogin === true
  } catch (error) {
    console.error('[WeFlow] 读取开机自启动状态失败:', error)
    return false
  }
}

const buildLaunchAtStartupSettings = (enabled: boolean): Parameters<typeof app.setLoginItemSettings>[0] =>
  process.platform === 'win32'
    ? { openAtLogin: enabled, path: process.execPath }
    : { openAtLogin: enabled }

const setSystemLaunchAtStartup = (enabled: boolean): { success: boolean; enabled: boolean; error?: string } => {
  try {
    app.setLoginItemSettings(buildLaunchAtStartupSettings(enabled))
    const effectiveEnabled = app.getLoginItemSettings().openAtLogin === true
    if (effectiveEnabled !== enabled) {
      return {
        success: false,
        enabled: effectiveEnabled,
        error: '系统未接受该开机自启动设置'
      }
    }
    return { success: true, enabled: effectiveEnabled }
  } catch (error) {
    return {
      success: false,
      enabled: getSystemLaunchAtStartup(),
      error: `设置开机自启动失败: ${String((error as Error)?.message || error)}`
    }
  }
}

const getLaunchAtStartupStatus = (): { enabled: boolean; supported: boolean; reason?: string } => {
  const unsupportedReason = getLaunchAtStartupUnsupportedReason()
  if (unsupportedReason) {
    return {
      enabled: getStoredLaunchAtStartupPreference() === true,
      supported: false,
      reason: unsupportedReason
    }
  }
  return {
    enabled: getSystemLaunchAtStartup(),
    supported: true
  }
}

const applyLaunchAtStartupPreference = (
  enabled: boolean
): { success: boolean; enabled: boolean; supported: boolean; reason?: string; error?: string } => {
  const unsupportedReason = getLaunchAtStartupUnsupportedReason()
  if (unsupportedReason) {
    return {
      success: false,
      enabled: getStoredLaunchAtStartupPreference() === true,
      supported: false,
      reason: unsupportedReason
    }
  }

  const result = setSystemLaunchAtStartup(enabled)
  configService?.set('launchAtStartup', result.enabled)
  return {
    ...result,
    supported: true
  }
}

const syncLaunchAtStartupPreference = () => {
  if (!configService) return

  const unsupportedReason = getLaunchAtStartupUnsupportedReason()
  if (unsupportedReason) return

  const storedPreference = getStoredLaunchAtStartupPreference()
  const systemEnabled = getSystemLaunchAtStartup()

  if (typeof storedPreference !== 'boolean') {
    configService.set('launchAtStartup', systemEnabled)
    return
  }

  if (storedPreference === systemEnabled) return

  const result = setSystemLaunchAtStartup(storedPreference)
  configService.set('launchAtStartup', result.enabled)
  if (!result.success && result.error) {
    console.error('[WeFlow] 同步开机自启动设置失败:', result.error)
  }
}

// 使用白名单过滤 PATH，避免被第三方目录中的旧版 VC++ 运行库劫持。
// 仅保留系统目录（Windows/System32/SysWOW64）和应用自身目录（可执行目录、resources）。
function sanitizePathEnv() {
  // 开发模式不做裁剪，避免影响本地工具链
  if (process.env.VITE_DEV_SERVER_URL) return

  const rawPath = process.env.PATH || process.env.Path
  if (!rawPath) return

  const sep = process.platform === 'win32' ? ';' : ':'
  const parts = rawPath.split(sep).filter(Boolean)

  const systemRoot = process.env.SystemRoot || process.env.WINDIR || ''
  const safePrefixes = [
    systemRoot,
    systemRoot ? join(systemRoot, 'System32') : '',
    systemRoot ? join(systemRoot, 'SysWOW64') : '',
    dirname(process.execPath),
    process.resourcesPath,
    join(process.resourcesPath || '', 'resources')
  ].filter(Boolean)

  const normalize = (p: string) => p.replace(/\\/g, '/').toLowerCase()
  const isSafe = (p: string) => {
    const np = normalize(p)
    return safePrefixes.some((prefix) => np.startsWith(normalize(prefix)))
  }

  const filtered = parts.filter(isSafe)
  if (filtered.length !== parts.length) {
    const removed = parts.filter((p) => !isSafe(p))
    console.warn('[WeFlow] 使用白名单裁剪 PATH，移除目录:', removed)
    const nextPath = filtered.join(sep)
    process.env.PATH = nextPath
    process.env.Path = nextPath
  }
}

// 启动时立即清理 PATH，后续创建的 worker 也能继承安全的环境
sanitizePathEnv()

// 单例服务

// 协议窗口实例
let agreementWindow: BrowserWindow | null = null
let onboardingWindow: BrowserWindow | null = null
// Splash 启动窗口
let splashWindow: BrowserWindow | null = null
const sessionChatWindows = new Map<string, BrowserWindow>()
const sessionChatWindowSources = new Map<string, 'chat' | 'export'>()

let keyService: any
if (process.platform === 'darwin') {
  keyService = new KeyServiceMac()
} else if (process.platform === 'linux') {
  keyService = new KeyServiceLinux()
} else {
  keyService = new KeyService()
}

let mainWindowReady = false
let shouldShowMain = true
let isAppQuitting = false
let shutdownPromise: Promise<void> | null = null
let tray: Tray | null = null
let isClosePromptVisible = false

interface ChatHistoryPayloadEntry {
  sessionId: string
  title?: string
  recordList: any[]
  createdAt: number
  lastAccessedAt: number
}

const chatHistoryPayloadStore = new Map<string, ChatHistoryPayloadEntry>()
const chatHistoryPayloadTtlMs = 10 * 60 * 1000
const chatHistoryPayloadMaxEntries = 20

const pruneChatHistoryPayloadStore = (): void => {
  const now = Date.now()

  for (const [payloadId, payload] of chatHistoryPayloadStore.entries()) {
    if (now - payload.createdAt > chatHistoryPayloadTtlMs) {
      chatHistoryPayloadStore.delete(payloadId)
    }
  }

  while (chatHistoryPayloadStore.size > chatHistoryPayloadMaxEntries) {
    const oldestPayloadId = chatHistoryPayloadStore.keys().next().value as string | undefined
    if (!oldestPayloadId) break
    chatHistoryPayloadStore.delete(oldestPayloadId)
  }
}

type WindowCloseBehavior = 'ask' | 'tray' | 'quit'
type CloseRestoreMethod = 'tray' | 'dock'

// 更新下载状态管理（Issue #294 修复）
let isDownloadInProgress = false
let downloadProgressHandler: ((progress: any) => void) | null = null
let downloadedHandler: (() => void) | null = null

const normalizeReleaseNotes = (rawReleaseNotes: unknown): string => {
  const merged = (() => {
    if (typeof rawReleaseNotes === 'string') {
      return rawReleaseNotes
    }
    if (Array.isArray(rawReleaseNotes)) {
      return rawReleaseNotes
        .map((item) => {
          if (!item || typeof item !== 'object') return ''
          const note = (item as { note?: unknown }).note
          return typeof note === 'string' ? note : ''
        })
        .filter(Boolean)
        .join('\n\n')
    }
    return ''
  })()

  if (!merged.trim()) return ''

  const normalizeHeadingText = (raw: string): string => {
    return raw
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, '\'')
      .replace(/&#x27;/gi, '\'')
      .toLowerCase()
      .replace(/[：:]/g, '')
      .replace(/\s+/g, '')
      .trim()
  }

  const shouldStripReleaseSection = (headingRaw: string): boolean => {
    const heading = normalizeHeadingText(headingRaw)
    if (!heading) return false
    if (heading.startsWith('下载') || heading.startsWith('download')) return true

    if ((heading.includes('macos') || heading.startsWith('mac')) && heading.includes('安装提示')) return true
    return false
  }

  // 兼容 electron-updater 直接返回 HTML 的场景（含 dir/anchor 等标签嵌套）
  const removeDownloadSectionFromHtml = (input: string): string => {
    const headingPattern = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi
    const headings: Array<{ start: number; end: number; headingText: string }> = []
    let match: RegExpExecArray | null

    while ((match = headingPattern.exec(input)) !== null) {
      const full = match[0]
      headings.push({
        start: match.index,
        end: match.index + full.length,
        headingText: match[2] || ''
      })
    }

    if (headings.length === 0) return input

    const rangesToRemove: Array<{ start: number; end: number }> = []
    for (let i = 0; i < headings.length; i += 1) {
      const current = headings[i]
      if (!shouldStripReleaseSection(current.headingText)) continue

      const nextStart = i + 1 < headings.length ? headings[i + 1].start : input.length
      rangesToRemove.push({ start: current.start, end: nextStart })
    }

    if (rangesToRemove.length === 0) return input

    let output = ''
    let cursor = 0
    for (const range of rangesToRemove) {
      output += input.slice(cursor, range.start)
      cursor = range.end
    }
    output += input.slice(cursor)
    return output
  }

  // 兼容 Markdown 场景（Action 最终 release note 模板）
  const removeDownloadSectionFromMarkdown = (input: string): string => {
    const lines = input.split(/\r?\n/)
    const output: string[] = []
    let skipSection = false

    for (const line of lines) {
      const headingMatch = line.match(/^\s*#{1,6}\s*(.+?)\s*$/)
      if (headingMatch) {
        if (shouldStripReleaseSection(headingMatch[1])) {
          skipSection = true
          continue
        }
        if (skipSection) {
          skipSection = false
        }
      }
      if (!skipSection) {
        output.push(line)
      }
    }

    return output.join('\n')
  }

  const cleaned = removeDownloadSectionFromMarkdown(removeDownloadSectionFromHtml(merged))
    // 兜底：即使没有匹配到标题，也不在弹窗展示 macOS 隔离标记清理命令
    .replace(/^[ \t>*-]*`?\s*xattr\s+-[a-z]*d[a-z]*\s+com\.apple\.quarantine[^\n]*`?\s*$/gim, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return cleaned
}

const getDialogReleaseNotes = (rawReleaseNotes: unknown): string => {
  const track = getEffectiveUpdateTrack()
  if (track !== 'stable') {
    return '修复了一些已知问题'
  }
  return normalizeReleaseNotes(rawReleaseNotes)
}

type AnnualReportYearsLoadStrategy = 'cache' | 'native' | 'hybrid'
type AnnualReportYearsLoadPhase = 'cache' | 'native' | 'scan' | 'done'

interface AnnualReportYearsProgressPayload {
  years?: number[]
  done: boolean
  error?: string
  canceled?: boolean
  strategy?: AnnualReportYearsLoadStrategy
  phase?: AnnualReportYearsLoadPhase
  statusText?: string
  nativeElapsedMs?: number
  scanElapsedMs?: number
  totalElapsedMs?: number
  switched?: boolean
  nativeTimedOut?: boolean
}

interface AnnualReportYearsTaskState {
  cacheKey: string
  canceled: boolean
  done: boolean
  snapshot: AnnualReportYearsProgressPayload
  updatedAt: number
}

interface OpenSessionChatWindowOptions {
  source?: 'chat' | 'export'
  initialDisplayName?: string
  initialAvatarUrl?: string
  initialContactType?: 'friend' | 'group' | 'official' | 'former_friend' | 'blocked' | 'other'
}

const normalizeSessionChatWindowSource = (source: unknown): 'chat' | 'export' => {
  return String(source || '').trim().toLowerCase() === 'export' ? 'export' : 'chat'
}

const normalizeSessionChatWindowOptionString = (value: unknown): string => {
  return String(value || '').trim()
}

const loadSessionChatWindowContent = (
  win: BrowserWindow,
  sessionId: string,
  source: 'chat' | 'export',
  options?: OpenSessionChatWindowOptions
) => {
  const queryParams = new URLSearchParams({
    sessionId,
    source
  })
  const initialDisplayName = normalizeSessionChatWindowOptionString(options?.initialDisplayName)
  const initialAvatarUrl = normalizeSessionChatWindowOptionString(options?.initialAvatarUrl)
  const initialContactType = normalizeSessionChatWindowOptionString(options?.initialContactType)
  if (initialDisplayName) queryParams.set('initialDisplayName', initialDisplayName)
  if (initialAvatarUrl) queryParams.set('initialAvatarUrl', initialAvatarUrl)
  if (initialContactType) queryParams.set('initialContactType', initialContactType)
  const query = queryParams.toString()
  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(`${process.env.VITE_DEV_SERVER_URL}#/chat-window?${query}`)
    return
  }
  win.loadFile(join(__dirname, '../dist/index.html'), {
    hash: `/chat-window?${query}`
  })
}

const annualReportYearsLoadTasks = new Map<string, AnnualReportYearsTaskState>()
const annualReportYearsTaskByCacheKey = new Map<string, string>()
const annualReportYearsSnapshotCache = new Map<string, { snapshot: AnnualReportYearsProgressPayload; updatedAt: number; taskId: string }>()
const annualReportYearsSnapshotTtlMs = 10 * 60 * 1000

const normalizeAnnualReportYearsSnapshot = (snapshot: AnnualReportYearsProgressPayload): AnnualReportYearsProgressPayload => {
  const years = Array.isArray(snapshot.years) ? [...snapshot.years] : []
  return { ...snapshot, years }
}

const buildAnnualReportYearsCacheKey = (dbPath: string, wxid: string): string => {
  return `${String(dbPath || '').trim()}\u0001${String(wxid || '').trim()}`
}

const pruneAnnualReportYearsSnapshotCache = (): void => {
  const now = Date.now()
  for (const [cacheKey, entry] of annualReportYearsSnapshotCache.entries()) {
    if (now - entry.updatedAt > annualReportYearsSnapshotTtlMs) {
      annualReportYearsSnapshotCache.delete(cacheKey)
    }
  }
}

const persistAnnualReportYearsSnapshot = (
  cacheKey: string,
  taskId: string,
  snapshot: AnnualReportYearsProgressPayload
): void => {
  annualReportYearsSnapshotCache.set(cacheKey, {
    taskId,
    snapshot: normalizeAnnualReportYearsSnapshot(snapshot),
    updatedAt: Date.now()
  })
  pruneAnnualReportYearsSnapshotCache()
}

const getAnnualReportYearsSnapshot = (
  cacheKey: string
): { taskId: string; snapshot: AnnualReportYearsProgressPayload } | null => {
  pruneAnnualReportYearsSnapshotCache()
  const entry = annualReportYearsSnapshotCache.get(cacheKey)
  if (!entry) return null
  return {
    taskId: entry.taskId,
    snapshot: normalizeAnnualReportYearsSnapshot(entry.snapshot)
  }
}

const broadcastAnnualReportYearsProgress = (
  taskId: string,
  payload: AnnualReportYearsProgressPayload
): void => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    win.webContents.send('annualReport:availableYearsProgress', {
      taskId,
      ...payload
    })
  }
}

const isYearsLoadCanceled = (taskId: string): boolean => {
  const task = annualReportYearsLoadTasks.get(taskId)
  return task?.canceled === true
}

const setupCustomTitleBarWindow = (win: BrowserWindow): void => {
  if (process.platform === 'darwin') {
    win.setWindowButtonVisibility(false)
  }

  const emitMaximizeState = () => {
    if (win.isDestroyed()) return
    win.webContents.send('window:maximizeStateChanged', win.isMaximized() || win.isFullScreen())
  }

  win.on('maximize', emitMaximizeState)
  win.on('unmaximize', emitMaximizeState)
  win.on('enter-full-screen', emitMaximizeState)
  win.on('leave-full-screen', emitMaximizeState)
  win.webContents.on('did-finish-load', emitMaximizeState)
}

let notificationNavigateHandlerRegistered = false
const focusMainWindowAndNavigate = (sessionId: string): void => {
  const targetWindow = mainWindow
  if (!targetWindow || targetWindow.isDestroyed()) return
  if (targetWindow.isMinimized()) targetWindow.restore()
  targetWindow.show()
  targetWindow.focus()
  targetWindow.webContents.send('navigate-to-session', sessionId)
}

const focusMainWindowAndNavigateRoute = (route: string): void => {
  const targetWindow = mainWindow
  if (!targetWindow || targetWindow.isDestroyed()) return
  if (targetWindow.isMinimized()) targetWindow.restore()
  targetWindow.show()
  targetWindow.focus()
  targetWindow.webContents.send('navigate-to-route', route)
}

const handleNotificationClickNavigation = (payload: unknown): void => {
  if (payload && typeof payload === 'object') {
    const data = payload as { sessionId?: string; channel?: string; insightRecordId?: string; targetRoute?: string }
    const targetRoute = String(data.targetRoute || '').trim()
    if (targetRoute.startsWith('/')) {
      focusMainWindowAndNavigateRoute(targetRoute)
      return
    }
    if (data.channel === 'ai-insight' && data.insightRecordId) {
      focusMainWindowAndNavigateRoute(`/insight-inbox?recordId=${encodeURIComponent(String(data.insightRecordId))}`)
      return
    }
    focusMainWindowAndNavigate(String(data.sessionId || ''))
    return
  }
  focusMainWindowAndNavigate(String(payload || ''))
}

const ensureNotificationNavigateHandlerRegistered = (): void => {
  if (notificationNavigateHandlerRegistered) return
  notificationNavigateHandlerRegistered = true
  ipcMain.on('notification-clicked', (_event, payload) => {
    handleNotificationClickNavigation(payload)
  })
  setNotificationNavigateHandler((payload: unknown) => {
    handleNotificationClickNavigation(payload)
  })
}

let wechatRequestHeaderInterceptorRegistered = false
const ensureWeChatRequestHeaderInterceptor = (): void => {
  if (wechatRequestHeaderInterceptorRegistered) return
  wechatRequestHeaderInterceptorRegistered = true

  session.defaultSession.webRequest.onBeforeSendHeaders(
    {
      urls: [
        '*://*.qpic.cn/*',
        '*://*.qlogo.cn/*',
        '*://*.wechat.com/*',
        '*://*.weixin.qq.com/*',
        '*://*.wx.qq.com/*'
      ]
    },
    (details, callback) => {
      details.requestHeaders['User-Agent'] = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/107.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) WindowsWechat(0x63090719) XWEB/8351"
      details.requestHeaders['Accept'] = "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"
      details.requestHeaders['Accept-Encoding'] = "gzip, deflate, br"
      details.requestHeaders['Accept-Language'] = "zh-CN,zh;q=0.9"
      details.requestHeaders['Connection'] = "keep-alive"
      details.requestHeaders['Range'] = "bytes=0-"

      let host = ''
      try {
        host = new URL(details.url).hostname.toLowerCase()
      } catch {}
      const isWxQQ = host === 'wx.qq.com' || host.endsWith('.wx.qq.com')
      details.requestHeaders['Referer'] = isWxQQ ? 'https://wx.qq.com/' : 'https://servicewechat.com/'

      callback({ cancel: false, requestHeaders: details.requestHeaders })
    }
  )
}

const getWindowCloseBehavior = (): WindowCloseBehavior => {
  const behavior = configService?.get('windowCloseBehavior')
  return behavior === 'tray' || behavior === 'quit' ? behavior : 'ask'
}

const isSilentStartupEnabled = (): boolean => {
  return configService?.get('silentStartup') === true
}

const getCloseRestoreMethod = (): CloseRestoreMethod | null => {
  if (tray) return 'tray'
  if (process.platform === 'darwin') return 'dock'
  return null
}

const canKeepMainWindowInBackground = (): boolean => {
  return getCloseRestoreMethod() !== null
}

const getPlatformIconName = (): string => {
  if (process.platform === 'linux') return 'icon.png'
  if (process.platform === 'darwin') return 'icon.icns'
  return 'icon.ico'
}

const resolveAppIconPath = (): string => {
  const iconName = getPlatformIconName()
  if (!process.env.VITE_DEV_SERVER_URL) {
    return join(process.resourcesPath, iconName)
  }
  if (process.platform === 'darwin') {
    return join(__dirname, '../resources/icons/macos/icon.icns')
  }
  return join(__dirname, `../public/${iconName}`)
}

const requestMainWindowCloseConfirmation = (win: BrowserWindow): void => {
  if (isClosePromptVisible) return
  isClosePromptVisible = true
  const restoreMethod = getCloseRestoreMethod()
  win.webContents.send('window:confirmCloseRequested', {
    canMinimizeToTray: restoreMethod !== null,
    restoreMethod: restoreMethod ?? undefined
  })
}

function createWindow(options: { autoShow?: boolean } = {}) {
  // 获取图标路径 - 打包后在 resources 目录
  const { autoShow = true } = options
  const iconPath = resolveAppIconPath()

  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    icon: iconPath,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false // Allow loading local files (video playback)
    },
    frame: false,
    show: false
  })
  setupCustomTitleBarWindow(win)

  // 窗口准备好后显示
  // Splash 模式下不在这里 show，由启动流程统一控制
  win.once('ready-to-show', () => {
    mainWindowReady = true
    if (autoShow && !splashWindow) {
      win.show()
    }
  })

  // 开发环境加载 vite 服务器
  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL)

    // 开发环境下按 F12 或 Ctrl+Shift+I 打开开发者工具
    win.webContents.on('before-input-event', (event, input) => {
      if (input.key === 'F12' || (input.control && input.shift && input.key === 'I')) {
        if (win.webContents.isDevToolsOpened()) {
          win.webContents.closeDevTools()
        } else {
          win.webContents.openDevTools()
        }
        event.preventDefault()
      }
    })
  } else {
    win.loadFile(join(__dirname, '../dist/index.html'))
  }

  // 忽略微信 CDN 域名的证书错误（部分节点证书配置不正确）
  win.webContents.on('certificate-error', (event, url, _error, _cert, callback) => {
    const trusted = ['.qq.com', '.qpic.cn', '.weixin.qq.com', '.wechat.com']
    try {
      const host = new URL(url).hostname
      if (trusted.some(d => host.endsWith(d))) {
        event.preventDefault()
        callback(true)
        return
      }
    } catch {}
    callback(false)
  })

  win.on('close', (e) => {
    if (isAppQuitting || win !== mainWindow) return
    e.preventDefault()
    const closeBehavior = getWindowCloseBehavior()

    if (closeBehavior === 'quit') {
      isAppQuitting = true
      app.quit()
      return
    }

    if (closeBehavior === 'tray' && canKeepMainWindowInBackground()) {
      win.hide()
      return
    }

    requestMainWindowCloseConfirmation(win)
  })

  win.on('closed', () => {
    if (mainWindow !== win) return

    mainWindow = null
    mainWindowReady = false
    isClosePromptVisible = false

    if (process.platform !== 'darwin' && !isAppQuitting) {
      destroyNotificationWindow()
      if (BrowserWindow.getAllWindows().length === 0) {
        app.quit()
      }
    }
  })

  return win
}

/**
 * 创建用户协议窗口
 */
function createAgreementWindow() {
  // 如果已存在，聚焦
  if (agreementWindow && !agreementWindow.isDestroyed()) {
    agreementWindow.focus()
    return agreementWindow
  }

  const isDev = !!process.env.VITE_DEV_SERVER_URL
  const iconPath = isDev
    ? join(__dirname, '../public/icon.ico')
    : (process.platform === 'darwin' 
        ? join(process.resourcesPath, 'icon.icns')
        : join(process.resourcesPath, 'icon.ico'))

  const isDark = nativeTheme.shouldUseDarkColors

  agreementWindow = new BrowserWindow({
    width: 700,
    height: 600,
    minWidth: 500,
    minHeight: 400,
    icon: iconPath,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#00000000',
      symbolColor: isDark ? '#FFFFFF' : '#333333',
      height: 32
    },
    show: false,
    backgroundColor: isDark ? '#1A1A1A' : '#FFFFFF'
  })

  agreementWindow.once('ready-to-show', () => {
    agreementWindow?.show()
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    agreementWindow.loadURL(`${process.env.VITE_DEV_SERVER_URL}#/agreement-window`)
  } else {
    agreementWindow.loadFile(join(__dirname, '../dist/index.html'), { hash: '/agreement-window' })
  }

  agreementWindow.on('closed', () => {
    agreementWindow = null
  })

  return agreementWindow
}

/**
 * 创建 Splash 启动窗口
 * 使用纯 HTML 页面，不依赖 React，确保极速显示
 */
function createSplashWindow(): BrowserWindow {
  const isDev = !!process.env.VITE_DEV_SERVER_URL
  const splashThemeId = configService?.get('themeId') || 'cloud-dancer'
  const splashThemeMode = configService?.get('theme') || 'system'
  const iconPath = isDev
    ? join(__dirname, '../public/icon.ico')
    : (process.platform === 'darwin' 
        ? join(process.resourcesPath, 'icon.icns')
        : join(process.resourcesPath, 'icon.ico'))

  splashWindow = new BrowserWindow({
    width: 800,
    height: 500,
    resizable: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    center: true,
    skipTaskbar: false,
    icon: iconPath,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
      // 不需要 preload —— 通过 executeJavaScript 单向推送进度
    },
    show: false
  })

  if (isDev) {
    const splashUrl = new URL('splash.html', process.env.VITE_DEV_SERVER_URL)
    splashUrl.searchParams.set('themeId', splashThemeId)
    splashUrl.searchParams.set('themeMode', splashThemeMode)
    splashUrl.searchParams.set('version', app.getVersion())
    splashWindow.loadURL(splashUrl.toString())
  } else {
    splashWindow.loadFile(join(__dirname, '../dist/splash.html'), {
      query: {
        themeId: splashThemeId,
        themeMode: splashThemeMode,
        version: app.getVersion()
      }
    })
  }

  splashWindow.once('ready-to-show', () => {
    splashWindow?.show()
  })

  splashWindow.on('closed', () => {
    splashWindow = null
  })

  return splashWindow
}

/**
 * 向 Splash 窗口发送进度更新
 */
function updateSplashProgress(percent: number, text: string, indeterminate = false) {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.webContents
      .executeJavaScript(`updateProgress(${percent}, ${JSON.stringify(text)}, ${indeterminate})`)
      .catch(() => {})
  }
}

/**
 * 关闭 Splash 窗口
 */
function closeSplash() {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.close()
    splashWindow = null
  }
}

/**
 * 创建首次引导窗口
 */
function createOnboardingWindow(mode: 'default' | 'add-account' = 'default') {
  const onboardingHash = mode === 'add-account'
    ? '/onboarding-window?mode=add-account'
    : '/onboarding-window'

  if (onboardingWindow && !onboardingWindow.isDestroyed()) {
    if (process.env.VITE_DEV_SERVER_URL) {
      onboardingWindow.loadURL(`${process.env.VITE_DEV_SERVER_URL}#${onboardingHash}`)
    } else {
      onboardingWindow.loadFile(join(__dirname, '../dist/index.html'), { hash: onboardingHash })
    }
    onboardingWindow.focus()
    return onboardingWindow
  }

  const isDev = !!process.env.VITE_DEV_SERVER_URL
  const iconPath = isDev
    ? join(__dirname, '../public/icon.ico')
    : (process.platform === 'darwin' 
        ? join(process.resourcesPath, 'icon.icns')
        : join(process.resourcesPath, 'icon.ico'))

  onboardingWindow = new BrowserWindow({
    width: 960,
    height: 680,
    minWidth: 900,
    minHeight: 620,
    resizable: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    icon: iconPath,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    show: false
  })

  onboardingWindow.once('ready-to-show', () => {
    onboardingWindow?.show()
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    onboardingWindow.loadURL(`${process.env.VITE_DEV_SERVER_URL}#${onboardingHash}`)
  } else {
    onboardingWindow.loadFile(join(__dirname, '../dist/index.html'), { hash: onboardingHash })
  }

  onboardingWindow.on('closed', () => {
    onboardingWindow = null
  })

  return onboardingWindow
}

/**
 * 创建独立的视频播放窗口
 * 窗口大小会根据视频比例自动调整
 */
function createVideoPlayerWindow(videoPath: string, videoWidth?: number, videoHeight?: number) {
  const isDev = !!process.env.VITE_DEV_SERVER_URL
  const iconPath = isDev
    ? join(__dirname, '../public/icon.ico')
    : (process.platform === 'darwin' 
        ? join(process.resourcesPath, 'icon.icns')
        : join(process.resourcesPath, 'icon.ico'))

  // 获取屏幕尺寸
  const { screen } = require('electron')
  const primaryDisplay = screen.getPrimaryDisplay()
  const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize

  // 计算窗口尺寸，只有标题栏 40px，控制栏悬浮
  let winWidth = 854
  let winHeight = 520
  const titleBarHeight = 40

  if (videoWidth && videoHeight && videoWidth > 0 && videoHeight > 0) {
    const aspectRatio = videoWidth / videoHeight

    const maxWidth = Math.floor(screenWidth * 0.85)
    const maxHeight = Math.floor(screenHeight * 0.85)

    if (aspectRatio >= 1) {
      // 横向视频
      winWidth = Math.min(videoWidth, maxWidth)
      winHeight = Math.floor(winWidth / aspectRatio) + titleBarHeight

      if (winHeight > maxHeight) {
        winHeight = maxHeight
        winWidth = Math.floor((winHeight - titleBarHeight) * aspectRatio)
      }
    } else {
      // 竖向视频
      const videoDisplayHeight = Math.min(videoHeight, maxHeight - titleBarHeight)
      winHeight = videoDisplayHeight + titleBarHeight
      winWidth = Math.floor(videoDisplayHeight * aspectRatio)

      if (winWidth < 300) {
        winWidth = 300
        winHeight = Math.floor(winWidth / aspectRatio) + titleBarHeight
      }
    }

    winWidth = Math.max(winWidth, 360)
    winHeight = Math.max(winHeight, 280)
  }

  const win = new BrowserWindow({
    width: winWidth,
    height: winHeight,
    minWidth: 360,
    minHeight: 280,
    icon: iconPath,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false
    },
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#1a1a1a',
      symbolColor: '#ffffff',
      height: 40
    },
    show: false,
    backgroundColor: '#000000',
    autoHideMenuBar: true
  })

  win.once('ready-to-show', () => {
    win.show()
  })

  const videoParam = `videoPath=${encodeURIComponent(videoPath)}`
  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(`${process.env.VITE_DEV_SERVER_URL}#/video-player-window?${videoParam}`)

    win.webContents.on('before-input-event', (event, input) => {
      if (input.key === 'F12' || (input.control && input.shift && input.key === 'I')) {
        if (win.webContents.isDevToolsOpened()) {
          win.webContents.closeDevTools()
        } else {
          win.webContents.openDevTools()
        }
        event.preventDefault()
      }
    })
  } else {
    win.loadFile(join(__dirname, '../dist/index.html'), {
      hash: `/video-player-window?${videoParam}`
    })
  }
}

/**
 * 创建独立的图片查看窗口
 */
function createImageViewerWindow(imagePath: string, liveVideoPath?: string) {
  const isDev = !!process.env.VITE_DEV_SERVER_URL
  const iconPath = isDev
    ? join(__dirname, '../public/icon.ico')
    : (process.platform === 'darwin' 
        ? join(process.resourcesPath, 'icon.icns')
        : join(process.resourcesPath, 'icon.ico'))

  const win = new BrowserWindow({
    width: 900,
    height: 700,
    minWidth: 400,
    minHeight: 300,
    icon: iconPath,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false // 允许加载本地文件
    },
    frame: false,
    show: false,
    backgroundColor: '#000000',
    autoHideMenuBar: true
  })

  setupCustomTitleBarWindow(win)

  win.once('ready-to-show', () => {
    win.show()
  })

  let imageParam = `imagePath=${encodeURIComponent(imagePath)}`
  if (liveVideoPath) imageParam += `&liveVideoPath=${encodeURIComponent(liveVideoPath)}`

  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(`${process.env.VITE_DEV_SERVER_URL}#/image-viewer-window?${imageParam}`)

    win.webContents.on('before-input-event', (event, input) => {
      if (input.key === 'F12' || (input.control && input.shift && input.key === 'I')) {
        if (win.webContents.isDevToolsOpened()) {
          win.webContents.closeDevTools()
        } else {
          win.webContents.openDevTools()
        }
        event.preventDefault()
      }
    })
  } else {
    win.loadFile(join(__dirname, '../dist/index.html'), {
      hash: `/image-viewer-window?${imageParam}`
    })
  }

  return win
}

/**
 * 创建独立的聊天记录窗口
 */
function createChatHistoryWindow(sessionId: string, messageId: number) {
  return createChatHistoryRouteWindow(`/chat-history/${sessionId}/${messageId}`)
}

function createChatHistoryPayloadWindow(payloadId: string) {
  const win = createChatHistoryRouteWindow(`/chat-history-inline/${payloadId}`)
  win.on('closed', () => {
    chatHistoryPayloadStore.delete(payloadId)
  })
  return win
}

function createChatHistoryRouteWindow(route: string) {
  const isDev = !!process.env.VITE_DEV_SERVER_URL
  const iconPath = isDev
    ? join(__dirname, '../public/icon.ico')
    : (process.platform === 'darwin' 
        ? join(process.resourcesPath, 'icon.icns')
        : join(process.resourcesPath, 'icon.ico'))

  const win = new BrowserWindow({
    width: 600,
    height: 800,
    minWidth: 400,
    minHeight: 500,
    icon: iconPath,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    frame: false,
    show: false,
    backgroundColor: '#FFFFFF',
    autoHideMenuBar: true
  })
  setupCustomTitleBarWindow(win)

  let hasShown = false
  let isReadyToShow = false
  let hasLoadedRoute = false
  const showChatHistoryWindow = () => {
    if (hasShown || !isReadyToShow || !hasLoadedRoute || win.isDestroyed()) return
    hasShown = true
    win.show()
  }

  win.webContents.once('did-finish-load', () => {
    hasLoadedRoute = true
    setTimeout(showChatHistoryWindow, 30)
  })
  win.webContents.once('did-fail-load', () => {
    hasLoadedRoute = true
    showChatHistoryWindow()
  })
  win.once('ready-to-show', () => {
    isReadyToShow = true
    showChatHistoryWindow()
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(`${process.env.VITE_DEV_SERVER_URL}#${route}`)

    win.webContents.on('before-input-event', (event, input) => {
      if (input.key === 'F12' || (input.control && input.shift && input.key === 'I')) {
        if (win.webContents.isDevToolsOpened()) {
          win.webContents.closeDevTools()
        } else {
          win.webContents.openDevTools()
        }
        event.preventDefault()
      }
    })
  } else {
    win.loadFile(join(__dirname, '../dist/index.html'), {
      hash: route
    })
  }

  return win
}

/**
 * 创建独立的会话聊天窗口（单会话，复用聊天页右侧消息区域）
 */
function createSessionChatWindow(sessionId: string, options?: OpenSessionChatWindowOptions) {
  const normalizedSessionId = String(sessionId || '').trim()
  if (!normalizedSessionId) return null
  const normalizedSource = normalizeSessionChatWindowSource(options?.source)

  const existing = sessionChatWindows.get(normalizedSessionId)
  if (existing && !existing.isDestroyed()) {
    const trackedSource = sessionChatWindowSources.get(normalizedSessionId) || 'chat'
    if (trackedSource !== normalizedSource) {
      loadSessionChatWindowContent(existing, normalizedSessionId, normalizedSource, options)
      sessionChatWindowSources.set(normalizedSessionId, normalizedSource)
    }
    if (existing.isMinimized()) {
      existing.restore()
    }
    existing.focus()
    return existing
  }

  const isDev = !!process.env.VITE_DEV_SERVER_URL
  const iconPath = isDev
    ? join(__dirname, '../public/icon.ico')
    : (process.platform === 'darwin' 
        ? join(process.resourcesPath, 'icon.icns')
        : join(process.resourcesPath, 'icon.ico'))

  const isDark = nativeTheme.shouldUseDarkColors

  const win = new BrowserWindow({
    width: 600,
    height: 820,
    minWidth: 420,
    minHeight: 560,
    icon: iconPath,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#00000000',
      symbolColor: isDark ? '#ffffff' : '#1a1a1a',
      height: 40
    },
    show: false,
    backgroundColor: isDark ? '#1A1A1A' : '#F0F0F0',
    autoHideMenuBar: true
  })

  loadSessionChatWindowContent(win, normalizedSessionId, normalizedSource, options)

  if (process.env.VITE_DEV_SERVER_URL) {
    win.webContents.on('before-input-event', (event, input) => {
      if (input.key === 'F12' || (input.control && input.shift && input.key === 'I')) {
        if (win.webContents.isDevToolsOpened()) {
          win.webContents.closeDevTools()
        } else {
          win.webContents.openDevTools()
        }
        event.preventDefault()
      }
    })
  }

  win.once('ready-to-show', () => {
    win.show()
    win.focus()
  })

  win.on('closed', () => {
    const tracked = sessionChatWindows.get(normalizedSessionId)
    if (tracked === win) {
      sessionChatWindows.delete(normalizedSessionId)
      sessionChatWindowSources.delete(normalizedSessionId)
    }
  })

  sessionChatWindows.set(normalizedSessionId, win)
  sessionChatWindowSources.set(normalizedSessionId, normalizedSource)
  return win
}

function showMainWindow() {
  shouldShowMain = true
  if (mainWindowReady) {
    mainWindow?.show()
  }
}

const normalizeAccountId = (value: string): string => {
  const trimmed = String(value || '').trim()
  if (!trimmed) return ''
  if (trimmed.toLowerCase().startsWith('wxid_')) {
    const match = trimmed.match(/^(wxid_[^_]+)/i)
    return match?.[1] || trimmed
  }
  const suffixMatch = trimmed.match(/^(.+)_([a-zA-Z0-9]{4})$/)
  return suffixMatch ? suffixMatch[1] : trimmed
}

const buildAccountNameMatcher = (wxidCandidates: string[]) => {
  const loweredCandidates = wxidCandidates
    .map((item) => String(item || '').trim().toLowerCase())
    .filter(Boolean)
  return (name: string): boolean => {
    const loweredName = String(name || '').trim().toLowerCase()
    if (!loweredName) return false
    return loweredCandidates.some((candidate) => (
      loweredName === candidate ||
      loweredName.startsWith(`${candidate}_`) ||
      loweredName.includes(candidate)
    ))
  }
}

const removePathIfExists = async (
  targetPath: string,
  removedPaths: string[],
  warnings: string[]
): Promise<void> => {
  if (!targetPath || !existsSync(targetPath)) return
  try {
    await rm(targetPath, { recursive: true, force: true })
    removedPaths.push(targetPath)
  } catch (error) {
    warnings.push(`${targetPath}: ${String(error)}`)
  }
}

const removeMatchedEntriesInDir = async (
  rootDir: string,
  shouldRemove: (name: string) => boolean,
  removedPaths: string[],
  warnings: string[]
): Promise<void> => {
  if (!rootDir || !existsSync(rootDir)) return
  try {
    const entries = await readdir(rootDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!shouldRemove(entry.name)) continue
      const targetPath = join(rootDir, entry.name)
      await removePathIfExists(targetPath, removedPaths, warnings)
    }
  } catch (error) {
    warnings.push(`${rootDir}: ${String(error)}`)
  }
}

const normalizeFsPathForCompare = (value: string): string => {
  const normalized = String(value || '').replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

type SnsCacheMigrationCandidate = {
  label: string
  sourceDir: string
  targetDir: string
  fileCount: number
}

type SnsCacheMigrationPlan = {
  legacyBaseDir: string
  currentBaseDir: string
  candidates: SnsCacheMigrationCandidate[]
  totalFiles: number
}

type SnsCacheMigrationProgressPayload = {
  status: 'running' | 'done' | 'error'
  phase: 'copying' | 'cleanup' | 'done' | 'error'
  current: number
  total: number
  copied: number
  skipped: number
  remaining: number
  message?: string
  currentItemLabel?: string
}

let snsCacheMigrationInProgress = false

const countFilesInDir = async (dirPath: string): Promise<number> => {
  if (!dirPath || !existsSync(dirPath)) return 0
  try {
    const entries = await readdir(dirPath, { withFileTypes: true })
    let count = 0
    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name)
      if (entry.isDirectory()) {
        count += await countFilesInDir(fullPath)
        continue
      }
      if (entry.isFile()) count += 1
    }
    return count
  } catch {
    return 0
  }
}

const migrateDirectoryPreserveNewFiles = async (
  sourceDir: string,
  targetDir: string,
  onFileProcessed?: (payload: { copied: boolean }) => void
): Promise<{ copied: number; skipped: number; processed: number }> => {
  let copied = 0
  let skipped = 0
  let processed = 0

  if (!existsSync(sourceDir)) return { copied, skipped, processed }
  await mkdir(targetDir, { recursive: true })

  const entries = await readdir(sourceDir, { withFileTypes: true })
  for (const entry of entries) {
    const sourcePath = join(sourceDir, entry.name)
    const targetPath = join(targetDir, entry.name)

    if (entry.isDirectory()) {
      const nested = await migrateDirectoryPreserveNewFiles(sourcePath, targetPath, onFileProcessed)
      copied += nested.copied
      skipped += nested.skipped
      processed += nested.processed
      continue
    }

    if (!entry.isFile()) continue

    if (existsSync(targetPath)) {
      skipped += 1
      processed += 1
      onFileProcessed?.({ copied: false })
      continue
    }

    await mkdir(dirname(targetPath), { recursive: true })
    await copyFile(sourcePath, targetPath)
    copied += 1
    processed += 1
    onFileProcessed?.({ copied: true })
  }

  return { copied, skipped, processed }
}

const collectLegacySnsCacheMigrationPlan = async (): Promise<SnsCacheMigrationPlan | null> => {
  if (!configService) return null

  const legacyBaseDir = configService.getCacheBasePath()
  const configuredCachePath = String(configService.get('cachePath') || '').trim()
  const currentBaseDir = configuredCachePath || join(app.getPath('documents'), 'WeFlow')

  if (!legacyBaseDir || !currentBaseDir) return null

  const candidates = [
    {
      label: '朋友圈媒体缓存',
      sourceDir: join(legacyBaseDir, 'sns_cache'),
      targetDir: join(currentBaseDir, 'sns_cache')
    },
    {
      label: '朋友圈表情缓存（合并到 Emojis）',
      sourceDir: join(legacyBaseDir, 'sns_emoji_cache'),
      targetDir: join(currentBaseDir, 'Emojis')
    },
    {
      label: '朋友圈表情缓存（当前目录残留）',
      sourceDir: join(currentBaseDir, 'sns_emoji_cache'),
      targetDir: join(currentBaseDir, 'Emojis')
    }
  ]

  const pendingKeys = new Set<string>()
  const pending: SnsCacheMigrationCandidate[] = []
  for (const item of candidates) {
    const sourceKey = normalizeFsPathForCompare(item.sourceDir)
    const targetKey = normalizeFsPathForCompare(item.targetDir)
    if (!sourceKey || sourceKey === targetKey) continue
    const dedupeKey = `${sourceKey}=>${targetKey}`
    if (pendingKeys.has(dedupeKey)) continue
    const fileCount = await countFilesInDir(item.sourceDir)
    if (fileCount <= 0) continue
    pendingKeys.add(dedupeKey)
    pending.push({ ...item, fileCount })
  }
  if (pending.length === 0) return null

  const totalFiles = pending.reduce((sum, item) => sum + item.fileCount, 0)
  return {
    legacyBaseDir,
    currentBaseDir,
    candidates: pending,
    totalFiles
  }
}

const runLegacySnsCacheMigration = async (
  plan: SnsCacheMigrationPlan,
  onProgress: (payload: SnsCacheMigrationProgressPayload) => void
): Promise<{ copied: number; skipped: number; totalFiles: number }> => {
  let processed = 0
  let copied = 0
  let skipped = 0
  const total = plan.totalFiles

  const emitProgress = (patch?: Partial<SnsCacheMigrationProgressPayload>) => {
    onProgress({
      status: 'running',
      phase: 'copying',
      current: processed,
      total,
      copied,
      skipped,
      remaining: Math.max(0, total - processed),
      ...patch
    })
  }

  emitProgress({ message: '准备迁移缓存...' })

  for (const item of plan.candidates) {
    emitProgress({ currentItemLabel: item.label, message: `正在迁移：${item.label}` })
    const result = await migrateDirectoryPreserveNewFiles(item.sourceDir, item.targetDir, ({ copied: copiedThisFile }) => {
      processed += 1
      if (copiedThisFile) copied += 1
      else skipped += 1
      emitProgress({ currentItemLabel: item.label })
    })
    // 兜底对齐计数，防止回调未触发造成偏差
    const expectedProcessed = copied + skipped
    if (processed !== expectedProcessed) {
      processed = expectedProcessed
      copied = Math.max(copied, result.copied)
      skipped = Math.max(skipped, result.skipped)
      emitProgress({ currentItemLabel: item.label })
    }
  }

  emitProgress({ phase: 'cleanup', message: '正在清理旧目录...' })
  for (const item of plan.candidates) {
    await rm(item.sourceDir, { recursive: true, force: true })
  }

  if (existsSync(plan.legacyBaseDir)) {
    try {
      const remaining = await readdir(plan.legacyBaseDir)
      if (remaining.length === 0) {
        await rm(plan.legacyBaseDir, { recursive: true, force: true })
      }
    } catch {
      // 忽略旧目录清理失败，不影响迁移结果
    }
  }

  onProgress({
    status: 'done',
    phase: 'done',
    current: processed,
    total,
    copied,
    skipped,
    remaining: Math.max(0, total - processed),
    message: '迁移完成'
  })

  return { copied, skipped, totalFiles: total }
}

// 注册 IPC 处理器
function registerIpcHandlers() {
  registerNotificationHandlers()
  ensureNotificationNavigateHandlerRegistered()
  bizService.registerHandlers()
  // 配置相关
  ipcMain.handle('config:get', async (_, key: string) => {
    return configService?.get(key as any)
  })

  // §2.40 微信号分库：业务库归属 wxid（清洗后；空 = 未完成引导，回退 legacy 名）
  const currentBusinessWxid = (): string => (configService ? configService.getMyWxidCleaned() : '').trim()

  // §2.40 微信号分库切换：迁移 legacy 库 + 重开两业务库。
  // 走 enqueueSalesTask 串行，防扫描中途换库；切账号必经 setMyWxid → config:set，渲染层零改动。
  const switchBusinessDbsForWxid = async (wxid: string): Promise<void> => {
    const userData = app.getPath('userData')
    await enqueueSalesTask(async () => {
      const moved = migrateLegacyBusinessDbs(userData, wxid)
      if (moved.length > 0) {
        console.log('[Sales] legacy 业务库已迁移到按账号命名:', moved.map((m) => `${m.kind} → ${m.to}`).join(', '))
      }
      await crmDbService.reopenForWxid(userData, wxid)
      await salesDbService.reopenForWxid(userData, wxid)
      console.log(`[Sales] 业务库已切换到账号 ${wxid || '(未设置)'}`)
    })
  }

  ipcMain.handle('config:set', async (_, key: string, value: any) => {
    let result: unknown
    const previousMyWxid = key === 'myWxid' ? String(configService?.get('myWxid') ?? '') : ''
    if (key === 'launchAtStartup') {
      result = applyLaunchAtStartupPreference(value === true)
    } else {
      result = configService?.set(key as any, value)
    }
    if (key === 'updateChannel') {
      applyAutoUpdateChannel('settings')
    }
    // §2.40 微信号分库：myWxid 实际变化 → 迁移 + 重开两业务库（失败不阻塞配置写入）
    if (key === 'myWxid' && configService && String(value ?? '') !== previousMyWxid) {
      try {
        await switchBusinessDbsForWxid(currentBusinessWxid())
      } catch (e) {
        console.error('[Sales] myWxid 变更后切换业务库失败:', e)
      }
    }
    void messagePushService.handleConfigChanged(key)
    void insightService.handleConfigChanged(key)
    void groupSummaryService.handleConfigChanged(key)
    return result
  })

  // 本地身份档案（PRD §1.2a；identity:* 三端点，只读写本地配置，见 identityIpcHandlers.ts）
  registerIdentityIpcHandlers(ipcMain)

  // AI 见解
  ipcMain.handle('insight:testConnection', async () => {
    return insightService.testConnection()
  })

  ipcMain.handle('insight:getTodayStats', async () => {
    return insightService.getTodayStats()
  })

  ipcMain.handle('insight:listRecords', async (_, filters?: {
    keyword?: string
    sessionId?: string
    startTime?: number
    endTime?: number
    sourceType?: 'insight' | 'message_analysis' | 'all'
    limit?: number
    offset?: number
  }) => {
    return insightRecordService.listRecords(filters || {})
  })

  ipcMain.handle('insight:getRecord', async (_, id: string) => {
    return insightRecordService.getRecord(id)
  })

  ipcMain.handle('insight:markRecordRead', async (_, id: string) => {
    return insightRecordService.markRecordRead(id)
  })

  ipcMain.handle('insight:clearRecords', async (_, filters?: {
    sessionId?: string
    startTime?: number
    endTime?: number
  }) => {
    return insightRecordService.clearRecords(filters || {})
  })

  ipcMain.handle('insight:triggerTest', async () => {
    return insightService.triggerTest()
  })

  ipcMain.handle('insight:triggerSessionInsight', async (_, payload: {
    sessionId: string
    displayName?: string
    avatarUrl?: string
  }) => {
    return insightService.triggerSessionInsight(payload)
  })

  ipcMain.handle('insight:listProfileStatuses', async (_, sessionIds: string[]) => {
    return insightProfileService.listProfileStatuses(Array.isArray(sessionIds) ? sessionIds : [])
  })

  ipcMain.handle('insight:generateProfile', async (_, payload: {
    sessionId: string
    displayName?: string
    avatarUrl?: string
  }) => {
    const result = await insightProfileService.generateProfile(payload)
    // AI 画像完成后：判定销售意向，有意向则自动导入 CRM
    if (result.success && payload.sessionId) {
      try {
        const record = insightProfileService.getProfileRecord(payload.sessionId)
        if (record) {
          const judge = await judgeAndImportCrmCustomer(record, configService)
          if (judge.imported) {
            result.message = `${result.message || 'AI 画像已生成'}。已自动导入 CRM 客户（${judge.stage ? judge.stage + '，' : ''}${judge.reason || '有意向'}）`
            // 导入成功 → AI 自动填充客户信息（enqueue 串行）
            void enqueueSalesTask(() => enrichCustomer(payload.sessionId, record.displayName).then(() => undefined))
          }
        }
      } catch (e) {
        salesLog('WARN', `[CrmImport] 画像后导入失败 ${payload.sessionId}: ${e}`)
      }
    }
    return result
  })

  ipcMain.handle('insight:cancelProfile', async (_, sessionId?: string) => {
    return insightProfileService.cancelProfile(sessionId)
  })

  ipcMain.handle('insight:generateFootprintInsight', async (_, payload: {
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
  }) => {
    return insightService.generateFootprintInsight(payload)
  })

  ipcMain.handle('insight:generateMessageInsight', async (_, payload: {
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
  }) => {
    return insightService.generateMessageInsight(payload)
  })

  ipcMain.handle('groupSummary:listRecords', async (_, filters?: {
    sessionId?: string
    startTime?: number
    endTime?: number
    limit?: number
    offset?: number
  }) => {
    return groupSummaryService.listRecords(filters || {})
  })

  ipcMain.handle('groupSummary:getRecord', async (_, id: string) => {
    return groupSummaryService.getRecord(id)
  })

  ipcMain.handle('groupSummary:triggerManual', async (_, payload: {
    sessionId: string
    displayName?: string
    avatarUrl?: string
    startTime: number
    endTime: number
  }) => {
    return groupSummaryService.triggerManual(payload)
  })

  ipcMain.handle('groupSummary:triggerDay', async (_, payload: {
    sessionId: string
    displayName?: string
    avatarUrl?: string
    date: string
  }) => {
    return groupSummaryService.triggerDay(payload)
  })

  ipcMain.handle('social:saveWeiboCookie', async (_, rawInput: string) => {
    try {
      if (!configService) {
        return { success: false, error: 'Config service is not initialized' }
      }
      const normalized = normalizeWeiboCookieInput(rawInput)
      configService.set('aiInsightWeiboCookie' as any, normalized as any)
      weiboService.clearCache()
      return { success: true, normalized, hasCookie: Boolean(normalized) }
    } catch (error) {
      return { success: false, error: (error as Error).message || 'Failed to save Weibo cookie' }
    }
  })

  ipcMain.handle('social:validateWeiboUid', async (_, uid: string) => {
    try {
      if (!configService) {
        return { success: false, error: 'Config service is not initialized' }
      }
      const cookie = String(configService.get('aiInsightWeiboCookie' as any) || '')
      return await weiboService.validateUid(uid, cookie)
    } catch (error) {
      return { success: false, error: (error as Error).message || 'Failed to validate Weibo UID' }
    }
  })

  ipcMain.handle('config:clear', async () => {
    if (isLaunchAtStartupSupported() && getSystemLaunchAtStartup()) {
      const result = setSystemLaunchAtStartup(false)
      if (!result.success && result.error) {
        console.error('[WeFlow] 清空配置时关闭开机自启动失败:', result.error)
      }
    }
    configService?.clear()
    messagePushService.handleConfigCleared()
    insightService.handleConfigCleared()
    groupSummaryService.handleConfigCleared()
    return true
  })

  // 文件对话框
  ipcMain.handle('dialog:openFile', async (_, options) => {
    const { dialog } = await import('electron')
    return dialog.showOpenDialog(options)
  })

  ipcMain.handle('dialog:openDirectory', async (_, options) => {
    const { dialog } = await import('electron')
    return dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      ...options
    })
  })

  ipcMain.handle('dialog:saveFile', async (_, options) => {
    const { dialog } = await import('electron')
    return dialog.showSaveDialog(options)
  })

  ipcMain.handle('shell:openPath', async (_, path: string) => {
    const { shell } = await import('electron')
    return shell.openPath(path)
  })

  ipcMain.handle('shell:openExternal', async (_, url: string) => {
    const { shell } = await import('electron')
    const safeUrl = normalizeAllowedExternalUrl(url)
    if (!safeUrl) {
      return { success: false, error: '不允许打开该外部链接协议' }
    }
    await shell.openExternal(safeUrl)
    return { success: true }
  })

  ipcMain.handle('app:getDownloadsPath', async () => {
    return app.getPath('downloads')
  })

  ipcMain.handle('app:getVersion', async () => {
    return app.getVersion()
  })

  ipcMain.handle('app:getLaunchAtStartupStatus', async () => {
    return getLaunchAtStartupStatus()
  })

  ipcMain.handle('app:setLaunchAtStartup', async (_, enabled: boolean) => {
    return applyLaunchAtStartupPreference(enabled === true)
  })

  ipcMain.handle('log:getPath', async () => {
    return join(app.getPath('userData'), 'logs', 'wcdb.log')
  })

  ipcMain.handle('log:read', async () => {
    try {
      const logPath = join(app.getPath('userData'), 'logs', 'wcdb.log')
      const content = await readFile(logPath, 'utf8')
      return { success: true, content }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('log:clear', async () => {
    try {
      const logPath = join(app.getPath('userData'), 'logs', 'wcdb.log')
      await mkdir(dirname(logPath), { recursive: true })
      await writeFile(logPath, '', 'utf8')
      return { success: true }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  // 前端诊断日志 → weflow-sales.log（chrome console 替代）
  ipcMain.on('log:debug', (_, msg: string) => {
    salesLog('DEBUG', `[Renderer] ${msg}`)
  })

  ipcMain.handle('diagnostics:getExportCardLogs', async (_, options?: { limit?: number }) => {
    return exportCardDiagnosticsService.snapshot(options?.limit)
  })

  ipcMain.handle('diagnostics:clearExportCardLogs', async () => {
    exportCardDiagnosticsService.clear()
    return { success: true }
  })

  ipcMain.handle('diagnostics:recordResourceStats', async (_, payload?: unknown) => {
    resourceDiagnosticsEntries.push({
      ts: Date.now(),
      payload: sanitizeResourceDiagnosticsPayload(payload)
    })
    while (resourceDiagnosticsEntries.length > maxResourceDiagnosticsEntries) {
      resourceDiagnosticsEntries.shift()
    }
    return { success: true, count: resourceDiagnosticsEntries.length }
  })

  ipcMain.handle('diagnostics:getResourceStats', async (_, options?: { limit?: number }) => {
    const limit = Math.max(1, Math.min(500, Number(options?.limit || maxResourceDiagnosticsEntries)))
    const entries = resourceDiagnosticsEntries.slice(-limit)
    return {
      entries,
      summary: {
        count: resourceDiagnosticsEntries.length,
        firstTs: resourceDiagnosticsEntries[0]?.ts || 0,
        lastTs: resourceDiagnosticsEntries[resourceDiagnosticsEntries.length - 1]?.ts || 0,
        ...summarizeResourceDiagnostics(entries, resourceDiagnosticsPreloadTotalsBaseline)
      }
    }
  })

  ipcMain.handle('diagnostics:clearResourceStats', async () => {
    resourceDiagnosticsEntries.length = 0
    try {
      const stats = imagePreloadService.getStats()
      const totals = stats?.totals || {}
      resourceDiagnosticsPreloadTotalsBaseline = Object.fromEntries(
        Object.entries(totals)
          .map(([key, value]) => [key, Number(value)])
          .filter(([, value]) => Number.isFinite(value))
      )
    } catch {
      resourceDiagnosticsPreloadTotalsBaseline = null
    }
    return { success: true }
  })

  ipcMain.handle('diagnostics:exportExportCardLogs', async (_, payload?: {
    filePath?: string
    frontendLogs?: unknown[]
  }) => {
    const filePath = typeof payload?.filePath === 'string' ? payload.filePath.trim() : ''
    if (!filePath) {
      return { success: false, error: '导出路径不能为空' }
    }
    return exportCardDiagnosticsService.exportCombinedLogs(filePath, payload?.frontendLogs || [])
  })

  ipcMain.handle('app:checkForUpdates', async () => {
    if (!AUTO_UPDATE_ENABLED) {
      return { hasUpdate: false }
    }
    // 每次主动检查前重新应用一次通道配置，确保使用最新选择的更新通道。
    applyAutoUpdateChannel('settings')
    try {
      const result = await autoUpdater.checkForUpdates()
      if (result && result.updateInfo) {
        const currentVersion = app.getVersion()
        const latestVersion = result.updateInfo.version
        if (shouldOfferUpdateForTrack(latestVersion, currentVersion)) {
          return {
            hasUpdate: true,
            version: latestVersion,
            releaseNotes: getDialogReleaseNotes(result.updateInfo.releaseNotes),
            minimumVersion: (result.updateInfo as any).minimumVersion
          }
        }
      }
      return { hasUpdate: false }
    } catch (error) {
      console.error('检查更新失败:', error)
      return { hasUpdate: false }
    }
  })

  ipcMain.handle('app:downloadAndInstall', async (event) => {
    if (!AUTO_UPDATE_ENABLED) {
      throw new Error('自动更新已暂时禁用')
    }

    // 防止重复下载（Issue #294 修复）
    if (isDownloadInProgress) {
      throw new Error('更新正在下载中，请稍候')
    }

    isDownloadInProgress = true
    const win = BrowserWindow.fromWebContents(event.sender)

    // 清理旧的监听器（Issue #294 修复：防止监听器泄漏）
    if (downloadProgressHandler) {
      autoUpdater.removeListener('download-progress', downloadProgressHandler)
      downloadProgressHandler = null
    }
    if (downloadedHandler) {
      autoUpdater.removeListener('update-downloaded', downloadedHandler)
      downloadedHandler = null
    }

    // 创建新的监听器并保存引用
    downloadProgressHandler = (progress) => {
      if (win && !win.isDestroyed()) {
        win.webContents.send('app:downloadProgress', progress)
      }
    }

    downloadedHandler = () => {
      console.log('[Update] 更新下载完成，准备安装')
      if (downloadProgressHandler) {
        autoUpdater.removeListener('download-progress', downloadProgressHandler)
        downloadProgressHandler = null
      }
      downloadedHandler = null
      isDownloadInProgress = false
      autoUpdater.quitAndInstall(false, true)
    }

    autoUpdater.on('download-progress', downloadProgressHandler)
    autoUpdater.once('update-downloaded', downloadedHandler)

    try {
      console.log('[Update] 开始下载更新...')
      await autoUpdater.downloadUpdate()
    } catch (error: any) {
      console.error('[Update] 下载更新失败:', error)
      // 失败时清理状态和监听器
      isDownloadInProgress = false
      if (downloadProgressHandler) {
        autoUpdater.removeListener('download-progress', downloadProgressHandler)
        downloadProgressHandler = null
      }
      if (downloadedHandler) {
        autoUpdater.removeListener('update-downloaded', downloadedHandler)
        downloadedHandler = null
      }
      
      const errorCode = typeof error?.code === 'string' ? error.code : ''
      const rawErrorMessage =
        typeof error?.message === 'string'
          ? error.message
          : (typeof error === 'string' ? error : JSON.stringify(error))

      if (errorCode === 'ERR_UPDATER_ZIP_FILE_NOT_FOUND' || /ZIP file not provided/i.test(rawErrorMessage)) {
        throw new Error('当前发布版本缺少 macOS 自动更新所需的 ZIP 包，请联系开发者重新发布该版本')
      }

      throw new Error(rawErrorMessage || '下载更新失败，请稍后重试')
    }
  })

  ipcMain.handle('app:ignoreUpdate', async (_, version: string) => {
    configService?.set('ignoredUpdateVersion', version)
    return { success: true }
  })

  // 窗口控制
  ipcMain.on('window:minimize', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize()
  })

  ipcMain.on('window:maximize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win?.isMaximized()) {
      win.unmaximize()
    } else {
      win?.maximize()
    }
  })

  ipcMain.handle('window:isMaximized', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return Boolean(win?.isMaximized() || win?.isFullScreen())
  })

  ipcMain.on('window:close', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close()
  })

  ipcMain.handle('window:respondCloseConfirm', async (_event, action: 'tray' | 'quit' | 'cancel') => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      isClosePromptVisible = false
      return false
    }

    try {
      if (action === 'tray') {
        if (canKeepMainWindowInBackground()) {
          mainWindow.hide()
          return true
        }
        return false
      }

      if (action === 'quit') {
        isAppQuitting = true
        app.quit()
        return true
      }

      return true
    } finally {
      isClosePromptVisible = false
    }
  })

  // 更新窗口控件主题色
  ipcMain.on('window:setTitleBarOverlay', (event, options: { symbolColor: string }) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) {
      try {
        win.setTitleBarOverlay({
          color: '#00000000',
          symbolColor: options.symbolColor,
          height: 40
        })
      } catch (error) {
        console.warn('TitleBarOverlay not enabled for this window:', error)
      }
    }
  })

  // 打开视频播放窗口
  ipcMain.handle('window:openVideoPlayerWindow', (_, videoPath: string, videoWidth?: number, videoHeight?: number) => {
    createVideoPlayerWindow(videoPath, videoWidth, videoHeight)
  })

  // 打开聊天记录窗口
  ipcMain.handle('window:openChatHistoryWindow', (_, sessionId: string, messageId: number) => {
    createChatHistoryWindow(sessionId, messageId)
    return true
  })

  ipcMain.handle('window:openChatHistoryPayloadWindow', (_, payload: { sessionId: string; title?: string; recordList: any[] }) => {
    const payloadId = randomUUID()
    pruneChatHistoryPayloadStore()
    const now = Date.now()
    chatHistoryPayloadStore.set(payloadId, {
      sessionId: String(payload?.sessionId || '').trim(),
      title: String(payload?.title || '').trim() || '聊天记录',
      recordList: Array.isArray(payload?.recordList) ? payload.recordList : [],
      createdAt: now,
      lastAccessedAt: now
    })
    pruneChatHistoryPayloadStore()
    createChatHistoryPayloadWindow(payloadId)
    return true
  })

  ipcMain.handle('window:getChatHistoryPayload', (_, payloadId: string) => {
    pruneChatHistoryPayloadStore()
    const normalizedPayloadId = String(payloadId || '').trim()
    const payload = chatHistoryPayloadStore.get(normalizedPayloadId)
    if (!payload) return { success: false, error: '聊天记录载荷不存在或已失效' }
    const nextPayload: ChatHistoryPayloadEntry = {
      ...payload,
      lastAccessedAt: Date.now()
    }
    chatHistoryPayloadStore.set(normalizedPayloadId, nextPayload)
    return {
      success: true,
      payload: {
        sessionId: nextPayload.sessionId,
        title: nextPayload.title,
        recordList: nextPayload.recordList
      }
    }
  })

  // 打开会话聊天窗口（同会话仅保留一个窗口并聚焦）
  ipcMain.handle('window:openSessionChatWindow', (_, sessionId: string, options?: OpenSessionChatWindowOptions) => {
    const win = createSessionChatWindow(sessionId, options)
    return Boolean(win)
  })

  // 根据视频尺寸调整窗口大小
  ipcMain.handle('window:resizeToFitVideo', (event, videoWidth: number, videoHeight: number) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || !videoWidth || !videoHeight) return

    const { screen } = require('electron')
    const primaryDisplay = screen.getPrimaryDisplay()
    const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize

    // 只有标题栏 40px，控制栏悬浮在视频上
    const titleBarHeight = 40
    const aspectRatio = videoWidth / videoHeight

    const maxWidth = Math.floor(screenWidth * 0.85)
    const maxHeight = Math.floor(screenHeight * 0.85)

    let winWidth: number
    let winHeight: number

    if (aspectRatio >= 1) {
      // 横向视频 - 以宽度为基准
      winWidth = Math.min(videoWidth, maxWidth)
      winHeight = Math.floor(winWidth / aspectRatio) + titleBarHeight

      if (winHeight > maxHeight) {
        winHeight = maxHeight
        winWidth = Math.floor((winHeight - titleBarHeight) * aspectRatio)
      }
    } else {
      // 竖向视频 - 以高度为基准
      const videoDisplayHeight = Math.min(videoHeight, maxHeight - titleBarHeight)
      winHeight = videoDisplayHeight + titleBarHeight
      winWidth = Math.floor(videoDisplayHeight * aspectRatio)

      // 确保宽度不会太窄
      if (winWidth < 300) {
        winWidth = 300
        winHeight = Math.floor(winWidth / aspectRatio) + titleBarHeight
      }
    }

    winWidth = Math.max(winWidth, 360)
    winHeight = Math.max(winHeight, 280)

    // 调整窗口大小并居中
    win.setSize(winWidth, winHeight)
    win.center()
  })

  // 视频相关
  ipcMain.handle('video:getVideoInfo', async (_, videoMd5: string, options?: { includePoster?: boolean; posterFormat?: 'dataUrl' | 'fileUrl' }) => {
    try {
      const result = await videoService.getVideoInfo(videoMd5, options)
      return { success: true, ...result }
    } catch (e) {
      return { success: false, error: String(e), exists: false }
    }
  })

  ipcMain.handle('video:getVideoInfoBatch', async (_, videoMd5List?: string[], options?: { includePoster?: boolean; posterFormat?: 'dataUrl' | 'fileUrl' }) => {
    try {
      const rows = await videoService.getVideoInfoBatch(Array.isArray(videoMd5List) ? videoMd5List : [], options)
      return {
        success: true,
        rows: rows.map((row) => ({
          index: row.index,
          md5: row.md5,
          success: true,
          ...row.info
        }))
      }
    } catch (e) {
      return { success: false, rows: [], error: String(e) }
    }
  })

  ipcMain.handle('video:parseVideoMd5', async (_, content: string) => {
    try {
      const md5 = videoService.parseVideoMd5(content)
      return { success: true, md5 }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  // 数据库路径相关
  ipcMain.handle('dbpath:autoDetect', async () => {
    return dbPathService.autoDetect()
  })

  ipcMain.handle('dbpath:scanWxids', async (_, rootPath: string) => {
    return dbPathService.scanWxids(rootPath)
  })

  ipcMain.handle('dbpath:scanWxidCandidates', async (_, rootPath: string) => {
    return dbPathService.scanWxidCandidates(rootPath)
  })

  ipcMain.handle('dbpath:getDefault', async () => {
    return dbPathService.getDefaultPath()
  })

  // WCDB 数据库相关
  ipcMain.handle('wcdb:testConnection', async (_, dbPath: string, hexKey: string, wxid: string) => {
    const cfg = configService || new ConfigService()
    const accountDir = cfg.getAccountDir(dbPath, wxid)
    if (!accountDir) {
      return { success: false, error: '未找到账号目录' }
    }
    return wcdbService.testConnection(accountDir, hexKey)
  })

  ipcMain.handle('wcdb:open', async (_, dbPath: string, hexKey: string, wxid: string) => {
    const cfg = configService || new ConfigService()
    const accountDir = cfg.getAccountDir(dbPath, wxid)
    if (!accountDir) {
      return false
    }
    return wcdbService.open(accountDir, hexKey)
  })

  ipcMain.handle('wcdb:close', async () => {
    wcdbService.close()
    return true
  })

  ipcMain.handle('backup:create', async (_, payload: { outputPath: string; options?: { includeImages?: boolean; includeVideos?: boolean; includeFiles?: boolean } }) => {
    return backupService.createBackup(payload.outputPath, payload.options)
  })

  ipcMain.handle('backup:inspect', async (_, payload: { archivePath: string }) => {
    return backupService.inspectBackup(payload.archivePath)
  })

  ipcMain.handle('backup:restore', async (_, payload: { archivePath: string }) => {
    return backupService.restoreBackup(payload.archivePath)
  })



  // 聊天相关
  ipcMain.handle('chat:connect', async () => {
    return chatService.connect()
  })

  ipcMain.handle('chat:getSessions', async () => {
    return chatService.getSessions()
  })

  ipcMain.handle('chat:markAllSessionsRead', async () => {
    return chatService.markAllSessionsRead()
  })

  ipcMain.handle('chat:getSessionStatuses', async (_, usernames: string[]) => {
    return chatService.getSessionStatuses(usernames)
  })

  ipcMain.handle('chat:getExportTabCounts', async () => {
    return chatService.getExportTabCounts()
  })

  ipcMain.handle('chat:getContactTypeCounts', async () => {
    return chatService.getContactTypeCounts()
  })

  ipcMain.handle('chat:getSessionMessageCounts', async (_, sessionIds: string[], options?: { preferHintCache?: boolean; bypassSessionCache?: boolean }) => {
    return chatService.getSessionMessageCounts(sessionIds, options)
  })

  ipcMain.handle('chat:enrichSessionsContactInfo', async (_, usernames: string[], options?: {
    skipDisplayName?: boolean
    onlyMissingAvatar?: boolean
  }) => {
    return chatService.enrichSessionsContactInfo(usernames, options)
  })

  ipcMain.handle('chat:getMessages', async (_, sessionId: string, offset?: number, limit?: number, startTime?: number, endTime?: number, ascending?: boolean) => {
    return chatService.getMessages(sessionId, offset, limit, startTime, endTime, ascending)
  })

  ipcMain.handle('chat:getLatestMessages', async (_, sessionId: string, limit?: number) => {
    return chatService.getLatestMessages(sessionId, limit)
  })

  ipcMain.handle('chat:getNewMessages', async (_, sessionId: string, minTime: number, limit?: number, cursor?: {
    createTime?: number
    sortSeq?: number
    localId?: number
    serverId?: number | string
    serverIdRaw?: string
  }) => {
    return chatService.getNewMessages(sessionId, minTime, limit, cursor)
  })

  ipcMain.handle('chat:getAntiRevokeSessions', async () => {
    return chatService.getAntiRevokeSessions()
  })

  ipcMain.handle('chat:updateMessage', async (_, sessionId: string, localId: number, createTime: number, newContent: string) => {
    return chatService.updateMessage(sessionId, localId, createTime, newContent)
  })

  ipcMain.handle('chat:deleteMessage', async (_, sessionId: string, localId: number, createTime: number, dbPathHint?: string) => {
    return chatService.deleteMessage(sessionId, localId, createTime, dbPathHint)
  })

  ipcMain.handle('chat:checkAntiRevokeTriggers', async (_, sessionIds: string[]) => {
    return chatService.checkAntiRevokeTriggers(sessionIds)
  })

  ipcMain.handle('chat:installAntiRevokeTriggers', async (_, sessionIds: string[]) => {
    return chatService.installAntiRevokeTriggers(sessionIds)
  })

  ipcMain.handle('chat:uninstallAntiRevokeTriggers', async (_, sessionIds: string[]) => {
    return chatService.uninstallAntiRevokeTriggers(sessionIds)
  })

  ipcMain.handle('chat:getContact', async (_, username: string) => {
    return await chatService.getContact(username)
  })


  ipcMain.handle('chat:getContactAvatar', async (_, username: string, chatroomId?: string) => {
    return await chatService.getContactAvatar(username, chatroomId)
  })

  ipcMain.handle('chat:resolveTransferDisplayNames', async (_, chatroomId: string, payerUsername: string, receiverUsername: string) => {
    return await chatService.resolveTransferDisplayNames(chatroomId, payerUsername, receiverUsername)
  })

  ipcMain.handle('chat:getContacts', async (_, options?: { lite?: boolean }) => {
    return await chatService.getContacts(options)
  })

  ipcMain.handle('chat:getCachedMessages', async (_, sessionId: string) => {
    return chatService.getCachedSessionMessages(sessionId)
  })

  ipcMain.handle('chat:getMyAvatarUrl', async () => {
    return chatService.getMyAvatarUrl()
  })

  ipcMain.handle('chat:downloadEmoji', async (_, cdnUrl: string, md5?: string) => {
    return chatService.downloadEmoji(cdnUrl, md5)
  })

  ipcMain.handle('chat:close', async () => {
    chatService.close()
    return true
  })

  ipcMain.handle('chat:clearCurrentAccountData', async (_, options?: { clearCache?: boolean; clearExports?: boolean }) => {
    const cfg = configService
    if (!cfg) return { success: false, error: '配置服务未初始化' }

    const clearCache = options?.clearCache === true
    const clearExports = options?.clearExports === true
    if (!clearCache && !clearExports) {
      return { success: false, error: '请至少选择一项清理范围' }
    }

    const rawWxid = String(cfg.getMyWxidCleaned() || '').trim()
    if (!rawWxid) {
      return { success: false, error: '当前账号未登录或未识别，无法清理' }
    }
    const normalizedWxid = normalizeAccountId(rawWxid)
    const wxidCandidates = Array.from(new Set([rawWxid, normalizedWxid].filter(Boolean)))
    const isMatchedAccountName = buildAccountNameMatcher(wxidCandidates)
    const removedPaths: string[] = []
    const warnings: string[] = []

    try {
      wcdbService.close()
      chatService.close()
    } catch (error) {
      warnings.push(`关闭数据库连接失败: ${String(error)}`)
    }

    if (clearCache) {
      const [analyticsResult, imageResult] = await Promise.all([
        analyticsService.clearCache(),
        imageDecryptService.clearCache()
      ])
      const chatResult = chatService.clearCaches()
      const cleanupResults = [analyticsResult, imageResult, chatResult]
      for (const result of cleanupResults) {
        if (!result.success && result.error) warnings.push(result.error)
      }

      const configuredCachePath = String(cfg.get('cachePath') || '').trim()
      const documentsWeFlowDir = join(app.getPath('documents'), 'WeFlow')
      const userDataCacheDir = join(app.getPath('userData'), 'cache')
      const cacheRootCandidates = [
        configuredCachePath,
        join(documentsWeFlowDir, 'Images'),
        join(documentsWeFlowDir, 'Voices'),
        join(documentsWeFlowDir, 'Emojis'),
        userDataCacheDir
      ].filter(Boolean)

      for (const wxid of wxidCandidates) {
        if (configuredCachePath) {
          await removePathIfExists(join(configuredCachePath, wxid), removedPaths, warnings)
          await removePathIfExists(join(configuredCachePath, 'Images', wxid), removedPaths, warnings)
          await removePathIfExists(join(configuredCachePath, 'Voices', wxid), removedPaths, warnings)
          await removePathIfExists(join(configuredCachePath, 'Emojis', wxid), removedPaths, warnings)
        }
        await removePathIfExists(join(documentsWeFlowDir, 'Images', wxid), removedPaths, warnings)
        await removePathIfExists(join(documentsWeFlowDir, 'Voices', wxid), removedPaths, warnings)
        await removePathIfExists(join(documentsWeFlowDir, 'Emojis', wxid), removedPaths, warnings)
        await removePathIfExists(join(userDataCacheDir, wxid), removedPaths, warnings)
      }

      for (const cacheRoot of cacheRootCandidates) {
        await removeMatchedEntriesInDir(cacheRoot, isMatchedAccountName, removedPaths, warnings)
      }
    }

    if (clearExports) {
      const configuredExportPath = String(cfg.get('exportPath') || '').trim()
      const documentsWeFlowDir = join(app.getPath('documents'), 'WeFlow')
      const exportRootCandidates = [
        configuredExportPath,
        join(documentsWeFlowDir, 'exports'),
        join(documentsWeFlowDir, 'Exports')
      ].filter(Boolean)

      for (const exportRoot of exportRootCandidates) {
        await removeMatchedEntriesInDir(exportRoot, isMatchedAccountName, removedPaths, warnings)
      }

      const resetConfigKeys = [
        'exportSessionRecordMap',
        'exportLastSessionRunMap',
        'exportLastContentRunMap',
        'exportSessionMessageCountCacheMap',
        'exportSessionContentMetricCacheMap',
        'exportSnsStatsCacheMap',
        'snsPageCacheMap',
        'contactsListCacheMap',
        'contactsAvatarCacheMap',
        'lastSession'
      ]
      for (const key of resetConfigKeys) {
        const defaultValue = key === 'lastSession' ? '' : {}
        cfg.set(key as any, defaultValue as any)
      }

      try {
        const dbPath = String(cfg.get('dbPath') || '').trim()
        const automationMapRaw = cfg.get('exportAutomationTaskMap') as Record<string, unknown> | undefined
        if (automationMapRaw && typeof automationMapRaw === 'object') {
          const nextAutomationMap: Record<string, unknown> = { ...automationMapRaw }
          let changed = false
          for (const scopeKey of Object.keys(automationMapRaw)) {
            const normalizedScopeKey = String(scopeKey || '').trim()
            if (!normalizedScopeKey) continue
            const separatorIndex = normalizedScopeKey.lastIndexOf('::')
            const scopedDbPath = separatorIndex >= 0
              ? normalizedScopeKey.slice(0, separatorIndex)
              : ''
            const scopedWxidRaw = separatorIndex >= 0
              ? normalizedScopeKey.slice(separatorIndex + 2)
              : normalizedScopeKey
            const scopedWxid = normalizeAccountId(scopedWxidRaw)
            const wxidMatched = wxidCandidates.includes(scopedWxidRaw) || scopedWxid === normalizedWxid
            const dbPathMatched = !dbPath || !scopedDbPath || scopedDbPath === dbPath
            if (!wxidMatched || !dbPathMatched) continue
            delete nextAutomationMap[scopeKey]
            changed = true
          }
          if (changed) {
            cfg.set('exportAutomationTaskMap' as any, nextAutomationMap as any)
          } else if (!Object.keys(automationMapRaw).length) {
            cfg.set('exportAutomationTaskMap' as any, {} as any)
          }
        }
      } catch (error) {
        warnings.push(`清理自动化导出任务失败: ${String(error)}`)
      }
    }

    if (clearCache) {
      try {
        const wxidConfigsRaw = cfg.get('wxidConfigs') as Record<string, any> | undefined
        if (wxidConfigsRaw && typeof wxidConfigsRaw === 'object') {
          const nextConfigs: Record<string, any> = { ...wxidConfigsRaw }
          for (const key of Object.keys(nextConfigs)) {
            if (isMatchedAccountName(key) || normalizeAccountId(key) === normalizedWxid) {
              delete nextConfigs[key]
            }
          }
          cfg.set('wxidConfigs' as any, nextConfigs as any)
        }
        cfg.set('myWxid' as any, '')
        cfg.set('decryptKey' as any, '')
        cfg.set('imageXorKey' as any, 0)
        cfg.set('imageAesKey' as any, '')
        cfg.set('dbPath' as any, '')
        cfg.set('lastOpenedDb' as any, '')
        cfg.set('onboardingDone' as any, false)
        cfg.set('lastSession' as any, '')
      } catch (error) {
        warnings.push(`清理账号配置失败: ${String(error)}`)
      }
    }

    return {
      success: true,
      removedPaths,
      warning: warnings.length > 0 ? warnings.join('; ') : undefined
    }
  })

  // §2.40 归档逃生舱：当前账号两业务库整文件改名 .archived-<时间戳>.db → 原账号重开新空库。
  // 用途：升级后历史库被归到错误账号名下（如 Windows 已先切号），点一次归档即得干净新库；
  // .archived 备份不删，需回看可手动把文件名改回去。
  ipcMain.handle('chat:archiveBusinessData', async () => {
    if (!configService) return { success: false, error: '配置服务未初始化' }
    const userData = app.getPath('userData')
    const wxid = (configService.getMyWxidCleaned() || '').trim()
    try {
      return await enqueueSalesTask(async () => {
        const archived: Array<{ from: string; to: string }> = []
        for (const svc of [crmDbService, salesDbService]) {
          const from = svc.currentDbPath()
          const to = svc.archiveCurrentDb()
          if (from && to) archived.push({ from, to })
        }
        await crmDbService.reopenForWxid(userData, wxid)
        await salesDbService.reopenForWxid(userData, wxid)
        console.log(`[Sales] 业务数据已归档（账号 ${wxid || '(未设置)'}）：${archived.map((a) => a.to).join(', ') || '无库文件'}`)
        return { success: true, archived }
      })
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      console.error('[Sales] 业务数据归档失败:', e)
      return { success: false, error }
    }
  })

  ipcMain.handle('chat:getSessionDetail', async (_, sessionId: string) => {
    return chatService.getSessionDetail(sessionId)
  })

  ipcMain.handle('chat:getSessionDetailFast', async (_, sessionId: string) => {
    return chatService.getSessionDetailFast(sessionId)
  })

  ipcMain.handle('chat:getSessionDetailExtra', async (_, sessionId: string) => {
    return chatService.getSessionDetailExtra(sessionId)
  })

  ipcMain.handle('chat:getExportSessionStats', async (_, sessionIds: string[], options?: {
    includeRelations?: boolean
    forceRefresh?: boolean
    allowStaleCache?: boolean
    preferAccurateSpecialTypes?: boolean
    cacheOnly?: boolean
    beginTimestamp?: number
    endTimestamp?: number
  }) => {
    return chatService.getExportSessionStats(sessionIds, options)
  })

  ipcMain.handle('chat:getGroupMyMessageCountHint', async (_, chatroomId: string) => {
    return chatService.getGroupMyMessageCountHint(chatroomId)
  })

  ipcMain.handle('chat:getImageData', async (_, sessionId: string, msgId: string) => {
    return chatService.getImageData(sessionId, msgId)
  })

  ipcMain.handle('chat:getVoiceData', async (_, sessionId: string, msgId: string, createTime?: number, serverId?: string | number) => {
    return chatService.getVoiceData(sessionId, msgId, createTime, serverId)
  })
  ipcMain.handle('chat:getAllVoiceMessages', async (_, sessionId: string) => {
    return chatService.getAllVoiceMessages(sessionId)
  })
  ipcMain.handle('chat:getAllImageMessages', async (_, sessionId: string) => {
    return chatService.getAllImageMessages(sessionId)
  })
  ipcMain.handle('chat:getMessageDates', async (_, sessionId: string) => {
    return chatService.getMessageDates(sessionId)
  })
  ipcMain.handle('chat:getMessageDateCounts', async (_, sessionId: string) => {
    return chatService.getMessageDateCounts(sessionId)
  })

  ipcMain.handle('chat:getResourceMessages', async (_, options?: {
    sessionId?: string
    types?: Array<'image' | 'video' | 'voice' | 'file'>
    beginTimestamp?: number
    endTimestamp?: number
    limit?: number
    offset?: number
  }) => {
    return chatService.getResourceMessages(options)
  })

  ipcMain.handle('chat:getMediaStream', async (_, options?: {
    sessionId?: string
    mediaType?: 'image' | 'video' | 'all'
    beginTimestamp?: number
    endTimestamp?: number
    limit?: number
    offset?: number
  }) => {
    return wcdbService.getMediaStream(options)
  })
  ipcMain.handle('chat:resolveVoiceCache', async (_, sessionId: string, msgId: string) => {
    return chatService.resolveVoiceCache(sessionId, msgId)
  })

  ipcMain.handle('chat:getVoiceTranscript', async (event, sessionId: string, msgId: string, createTime?: number, serverId?: string | number) => {
    return chatService.getVoiceTranscript(sessionId, msgId, createTime, (text) => {
      event.sender.send('chat:voiceTranscriptPartial', { sessionId, msgId, createTime, text })
    }, undefined, serverId)
  })

  ipcMain.handle('chat:getMessage', async (_, sessionId: string, localId: number) => {
    return chatService.getMessageById(sessionId, localId)
  })

  ipcMain.handle('chat:searchMessages', async (_, keyword: string, sessionId?: string, limit?: number, offset?: number, beginTimestamp?: number, endTimestamp?: number) => {
    return chatService.searchMessages(keyword, sessionId, limit, offset, beginTimestamp, endTimestamp)
  })

  ipcMain.handle('chat:getMyFootprintStats', async (_, beginTimestamp: number, endTimestamp: number, options?: {
    myWxid?: string
    privateSessionIds?: string[]
    groupSessionIds?: string[]
    mentionLimit?: number
    privateLimit?: number
    mentionMode?: 'text_at_me' | string
  }) => {
    return chatService.getMyFootprintStats(beginTimestamp, endTimestamp, options)
  })

  ipcMain.handle('chat:exportMyFootprint', async (_, beginTimestamp: number, endTimestamp: number, format: 'csv' | 'json', filePath: string) => {
    return chatService.exportMyFootprint(beginTimestamp, endTimestamp, format, filePath)
  })

  ipcMain.handle('sns:getTimeline', async (_, limit: number, offset: number, usernames?: string[], keyword?: string, startTime?: number, endTime?: number) => {
    return snsService.getTimeline(limit, offset, usernames, keyword, startTime, endTime)
  })

  ipcMain.handle('sns:getSnsUsernames', async () => {
    return snsService.getSnsUsernames()
  })

  ipcMain.handle('sns:getUserPostCounts', async (_, options?: { preferCache?: boolean; forceRefresh?: boolean }) => {
    return snsService.getUserPostCounts(options)
  })

  ipcMain.handle('sns:getExportStats', async (_, options?: { allowTimelineFallback?: boolean; preferCache?: boolean; forceRefresh?: boolean }) => {
    return snsService.getExportStats(options)
  })

  ipcMain.handle('sns:getExportStatsFast', async () => {
    return snsService.getExportStatsFast()
  })

  ipcMain.handle('sns:getUserPostStats', async (_, username: string) => {
    return snsService.getUserPostStats(username)
  })

  ipcMain.handle('sns:debugResource', async (_, url: string) => {
    return snsService.debugResource(url)
  })

  ipcMain.handle('sns:proxyImage', async (_, payload: string | { url: string; key?: string | number }) => {
    const url = typeof payload === 'string' ? payload : payload?.url
    const key = typeof payload === 'string' ? undefined : payload?.key
    return snsService.proxyImage(url, key)
  })

  ipcMain.handle('sns:downloadImage', async (_, payload: { url: string; key?: string | number }) => {
    try {
      const { url, key } = payload
      const result = await snsService.downloadImage(url, key)

      if (!result.success || !result.data) {
        return { success: false, error: result.error || '下载图片失败' }
      }

      const { dialog } = await import('electron')
      const ext = (result.contentType || '').split('/')[1] || 'jpg'
      const defaultPath = `SNS_${Date.now()}.${ext}`


      const filters = isVideoUrl(url)
        ? [{ name: 'Videos', extensions: ['mp4', 'mov', 'avi', 'mkv'] }]
        : [{ name: 'Images', extensions: [ext, 'jpg', 'jpeg', 'png', 'webp', 'gif'] }]

      const { filePath, canceled } = await dialog.showSaveDialog({
        defaultPath,
        filters
      })

      if (canceled || !filePath) {
        return { success: false, error: '用户已取消' }
      }

      const fs = await import('fs/promises')
      await fs.writeFile(filePath, result.data)

      return { success: true, filePath }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('sns:exportTimeline', async (event, options: any) => {
    const exportOptions = { ...(options || {}) }
    const taskId = normalizeExportTaskId(exportOptions.taskId)
    delete exportOptions.taskId
    const taskControl = taskId ? exportTaskControlService.createControl(taskId, String(exportOptions.outputDir || '')) : undefined
    if (taskId) activeExportTasks.add(taskId)

    try {
      const result = await snsService.exportTimeline(
        exportOptions,
        (progress) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send('sns:exportProgress', progress)
          }
        },
        taskControl
      )
      return finalizeExportTaskControlResult(taskId, result)
    } finally {
      if (taskId) activeExportTasks.delete(taskId)
    }
  })

  ipcMain.handle('sns:selectExportDir', async () => {
    const { dialog } = await import('electron')
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: '选择导出目录'
    })
    if (result.canceled || !result.filePaths?.[0]) {
      return { canceled: true }
    }
    return { canceled: false, filePath: result.filePaths[0] }
  })

  ipcMain.handle('sns:installBlockDeleteTrigger', async () => {
    return snsService.installSnsBlockDeleteTrigger()
  })

  ipcMain.handle('sns:uninstallBlockDeleteTrigger', async () => {
    return snsService.uninstallSnsBlockDeleteTrigger()
  })

  ipcMain.handle('sns:checkBlockDeleteTrigger', async () => {
    return snsService.checkSnsBlockDeleteTrigger()
  })

  ipcMain.handle('sns:deleteSnsPost', async (_, postId: string) => {
    return snsService.deleteSnsPost(postId)
  })

  ipcMain.handle('sns:downloadEmoji', async (_, params: { url: string; encryptUrl?: string; aesKey?: string }) => {
    return snsService.downloadSnsEmoji(params.url, params.encryptUrl, params.aesKey)
  })

  ipcMain.handle('sns:getCacheMigrationStatus', async () => {
    try {
      const plan = await collectLegacySnsCacheMigrationPlan()
      if (!plan) {
        return {
          success: true,
          needed: false,
          inProgress: snsCacheMigrationInProgress,
          totalFiles: 0,
          items: []
        }
      }
      return {
        success: true,
        needed: true,
        inProgress: snsCacheMigrationInProgress,
        totalFiles: plan.totalFiles,
        legacyBaseDir: plan.legacyBaseDir,
        currentBaseDir: plan.currentBaseDir,
        items: plan.candidates
      }
    } catch (error) {
      return { success: false, needed: false, error: String((error as Error)?.message || error || '') }
    }
  })

  ipcMain.handle('sns:startCacheMigration', async (event) => {
    if (snsCacheMigrationInProgress) {
      return { success: false, error: '迁移任务正在进行中' }
    }

    const sender = event.sender
    let lastProgress: SnsCacheMigrationProgressPayload = {
      status: 'running',
      phase: 'copying',
      current: 0,
      total: 0,
      copied: 0,
      skipped: 0,
      remaining: 0
    }
    const emitProgress = (payload: SnsCacheMigrationProgressPayload) => {
      lastProgress = payload
      if (!sender.isDestroyed()) {
        sender.send('sns:cacheMigrationProgress', payload)
      }
    }

    try {
      const plan = await collectLegacySnsCacheMigrationPlan()
      if (!plan) {
        emitProgress({
          status: 'done',
          phase: 'done',
          current: 0,
          total: 0,
          copied: 0,
          skipped: 0,
          remaining: 0,
          message: '无需迁移'
        })
        return { success: true, copied: 0, skipped: 0, totalFiles: 0, message: '无需迁移' }
      }

      snsCacheMigrationInProgress = true
      const result = await runLegacySnsCacheMigration(plan, emitProgress)
      return { success: true, ...result }
    } catch (error) {
      const message = String((error as Error)?.message || error || '')
      emitProgress({
        ...lastProgress,
        status: 'error',
        phase: 'error',
        message
      })
      return { success: false, error: message }
    } finally {
      snsCacheMigrationInProgress = false
    }
  })

  // 私聊克隆


  ipcMain.handle('image:decrypt', async (_, payload: {
    sessionId?: string
    imageMd5?: string
    imageDatName?: string
    createTime?: number
    force?: boolean
    preferFilePath?: boolean
    hardlinkOnly?: boolean
    disableUpdateCheck?: boolean
    allowCacheIndex?: boolean
    suppressEvents?: boolean
  }) => {
    return imageDecryptService.decryptImage(payload)
  })
  ipcMain.handle('image:resolveCache', async (_, payload: {
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
  }) => {
    return imageDecryptService.resolveCachedImage(payload)
  })
  ipcMain.handle(
    'image:resolveCacheBatch',
    async (
      _,
      payloads: Array<{
        sessionId?: string
        imageMd5?: string
        imageDatName?: string
        createTime?: number
        preferFilePath?: boolean
        hardlinkOnly?: boolean
        suppressEvents?: boolean
      }>,
      options?: { disableUpdateCheck?: boolean; allowCacheIndex?: boolean; allowCachePromotion?: boolean; allowFilesystemScan?: boolean; preferFilePath?: boolean; hardlinkOnly?: boolean; suppressEvents?: boolean }
    ) => {
      const list = Array.isArray(payloads) ? payloads : []
      if (list.length === 0) return { success: true, rows: [] }
      if (options?.hardlinkOnly === true && options?.allowFilesystemScan === false) {
        const hardlinkMd5s = new Set<string>()
        for (const payload of list) {
          const imageMd5 = String(payload?.imageMd5 || '').trim().toLowerCase()
          if (/^[a-f0-9]{32}$/i.test(imageMd5)) {
            hardlinkMd5s.add(imageMd5)
            continue
          }
          const imageDatName = String(payload?.imageDatName || '').trim().toLowerCase()
          const datBase = imageDatName.endsWith('.dat') ? imageDatName.slice(0, -4) : imageDatName
          if (/^[a-f0-9]{32}$/i.test(datBase)) {
            hardlinkMd5s.add(datBase)
          }
        }
        if (hardlinkMd5s.size > 0) {
          await imageDecryptService.preloadImageHardlinkMd5s(Array.from(hardlinkMd5s), {
            chunkSize: 64,
            yieldMs: 0,
            filesystemFallback: false
          })
        }
      }

      const maxConcurrentRaw = Number(process.env.WEFLOW_IMAGE_RESOLVE_BATCH_CONCURRENCY || 3)
      const maxConcurrent = Number.isFinite(maxConcurrentRaw)
        ? Math.max(1, Math.min(Math.floor(maxConcurrentRaw), 12))
        : 3
      const workerCount = Math.min(maxConcurrent, list.length)

      const rows: Array<{ success: boolean; localPath?: string; hasUpdate?: boolean; error?: string }> = new Array(list.length)
      let cursor = 0
      const dedupe = new Map<string, Promise<{ success: boolean; localPath?: string; hasUpdate?: boolean; error?: string }>>()

      const makeDedupeKey = (payload: typeof list[number]): string => {
        const sessionId = String(payload.sessionId || '').trim().toLowerCase()
        const imageMd5 = String(payload.imageMd5 || '').trim().toLowerCase()
        const imageDatName = String(payload.imageDatName || '').trim().toLowerCase()
        const createTime = Number(payload.createTime || 0) || 0
        const preferFilePath = payload.preferFilePath ?? options?.preferFilePath === true
        const hardlinkOnly = payload.hardlinkOnly ?? options?.hardlinkOnly === true
        const allowCacheIndex = options?.allowCacheIndex !== false
        const allowCachePromotion = options?.allowCachePromotion !== false
        const allowFilesystemScan = options?.allowFilesystemScan !== false
        const disableUpdateCheck = options?.disableUpdateCheck === true
        return [
          sessionId,
          imageMd5,
          imageDatName,
          String(createTime),
          preferFilePath ? 'pf1' : 'pf0',
          hardlinkOnly ? 'hl1' : 'hl0',
          allowCacheIndex ? 'ci1' : 'ci0',
          allowCachePromotion ? 'cp1' : 'cp0',
          allowFilesystemScan ? 'fs1' : 'fs0',
          disableUpdateCheck ? 'du1' : 'du0'
        ].join('|')
      }

      const resolveOne = (payload: typeof list[number]) => imageDecryptService.resolveCachedImage({
        ...payload,
        preferFilePath: payload.preferFilePath ?? options?.preferFilePath === true,
        hardlinkOnly: payload.hardlinkOnly ?? options?.hardlinkOnly === true,
        disableUpdateCheck: options?.disableUpdateCheck === true,
        allowCacheIndex: options?.allowCacheIndex !== false,
        allowCachePromotion: options?.allowCachePromotion !== false,
        allowFilesystemScan: options?.allowFilesystemScan !== false,
        suppressEvents: payload.suppressEvents ?? options?.suppressEvents === true
      })

      const worker = async () => {
        while (true) {
          const index = cursor
          cursor += 1
          if (index >= list.length) return
          const payload = list[index]
          const key = makeDedupeKey(payload)
          const existing = dedupe.get(key)
          if (existing) {
            rows[index] = await existing
            continue
          }
          const task = resolveOne(payload).catch((error) => ({
            success: false,
            error: String(error)
          }))
          dedupe.set(key, task)
          rows[index] = await task
        }
      }

      await Promise.all(Array.from({ length: workerCount }, () => worker()))
      return { success: true, rows }
    }
  )
  ipcMain.handle(
    'image:preload',
    async (
      _,
      payloads: Array<{ sessionId?: string; imageMd5?: string; imageDatName?: string; createTime?: number }>,
      options?: { allowDecrypt?: boolean; allowCacheIndex?: boolean; allowFilesystemScan?: boolean; emitResolved?: boolean; scope?: string; priority?: 'high' | 'normal' | 'low' }
    ) => {
      return imagePreloadService.enqueue(payloads || [], options)
    })
  ipcMain.handle(
    'image:cancelPreloadScope',
    async (_, scope?: string) => {
      imagePreloadService.cancelScope(String(scope || ''))
      return true
    }
  )
  ipcMain.handle(
    'image:getPreloadStats',
    async () => imagePreloadService.getStats()
  )
  ipcMain.handle(
    'image:preloadHardlinkMd5s',
    async (_, md5List?: string[], options?: { chunkSize?: number; yieldMs?: number; filesystemFallback?: boolean }) => {
      await imageDecryptService.preloadImageHardlinkMd5s(Array.isArray(md5List) ? md5List : [], options)
      return true
    }
  )

  // Windows Hello
  ipcMain.handle('auth:hello', async (event, message?: string) => {
    // 无论哪个窗口调用，都尝试强制附着到主窗口，确保体验一致
    // 如果主窗口不存在（极其罕见），则回退到调用者窗口
    const targetWin = (mainWindow && !mainWindow.isDestroyed())
      ? mainWindow
      : (BrowserWindow.fromWebContents(event.sender) || undefined)

    const result = await windowsHelloService.verify(message, targetWin)

    // Hello 验证成功后，自动用 authHelloSecret 中的密码解锁密钥
    if (result && configService) {
      const secret = configService.getHelloSecret()
      if (secret && configService.isLockMode()) {
        configService.unlock(secret)
      }
    }

    return result
  })

  // 验证应用锁状态（检测 lock: 前缀，防篡改）
  ipcMain.handle('auth:verifyEnabled', async () => {
    return configService?.verifyAuthEnabled() ?? false
  })

  // 密码解锁（验证 + 解密密钥到内存）
  ipcMain.handle('auth:unlock', async (_event, password: string) => {
    if (!configService) return { success: false, error: '配置服务未初始化' }
    return configService.unlock(password)
  })

  // 开启应用锁
  ipcMain.handle('auth:enableLock', async (_event, password: string) => {
    if (!configService) return { success: false, error: '配置服务未初始化' }
    return configService.enableLock(password)
  })

  // 关闭应用锁
  ipcMain.handle('auth:disableLock', async (_event, password: string) => {
    if (!configService) return { success: false, error: '配置服务未初始化' }
    return configService.disableLock(password)
  })

  // 修改密码
  ipcMain.handle('auth:changePassword', async (_event, oldPassword: string, newPassword: string) => {
    if (!configService) return { success: false, error: '配置服务未初始化' }
    return configService.changePassword(oldPassword, newPassword)
  })

  // 设置 Hello Secret
  ipcMain.handle('auth:setHelloSecret', async (_event, password: string) => {
    if (!configService) return { success: false }
    configService.setHelloSecret(password)
    return { success: true }
  })

  // 清除 Hello Secret
  ipcMain.handle('auth:clearHelloSecret', async () => {
    if (!configService) return { success: false }
    configService.clearHelloSecret()
    return { success: true }
  })

  // 检查是否处于 lock: 模式
  ipcMain.handle('auth:isLockMode', async () => {
    return configService?.isLockMode() ?? false
  })

  // 导出相关
  ipcMain.handle('export:getExportStats', async (_, sessionIds: string[], options: any) => {
    return exportService.getExportStats(sessionIds, options)
  })

  ipcMain.handle('export:pauseTask', async (_, taskId: string) => {
    const normalizedTaskId = normalizeExportTaskId(taskId)
    if (!normalizedTaskId) return { success: false, error: '缺少导出任务 ID' }
    const success = exportTaskControlService.pauseTask(normalizedTaskId)
    if (success) postExportWorkerControl(normalizedTaskId, 'pause')
    return { success }
  })

  ipcMain.handle('export:resumeTask', async (_, taskId: string) => {
    const normalizedTaskId = normalizeExportTaskId(taskId)
    if (!normalizedTaskId) return { success: false, error: '缺少导出任务 ID' }
    const success = exportTaskControlService.resumeTask(normalizedTaskId)
    if (success) postExportWorkerControl(normalizedTaskId, 'resume')
    return { success }
  })

  ipcMain.handle('export:cancelTask', async (_, taskId: string) => {
    const normalizedTaskId = normalizeExportTaskId(taskId)
    if (!normalizedTaskId) return { success: false, error: '缺少导出任务 ID' }
    const success = exportTaskControlService.cancelTask(normalizedTaskId)
    if (success) postExportWorkerControl(normalizedTaskId, 'cancel')
    if (success && !activeExportTasks.has(normalizedTaskId)) {
      const cleanup = await exportTaskControlService.cleanupTask(normalizedTaskId)
      return cleanup.success
        ? { success: true, cleanup }
        : { success: false, error: cleanup.error || '清理已导出文件失败' }
    }
    return { success }
  })

  ipcMain.handle('export:exportSessions', async (event, sessionIds: string[], outputDir: string, options: ExportOptions, controlOptions?: { taskId?: string }) => {
    const taskId = normalizeExportTaskId(controlOptions?.taskId)
    if (taskId) exportTaskControlService.createControl(taskId, outputDir)
    if (taskId) activeExportTasks.add(taskId)
    const PROGRESS_FORWARD_INTERVAL_MS = 180
    let pendingProgress: ExportProgress | null = null
    let progressTimer: NodeJS.Timeout | null = null
    let lastProgressSentAt = 0

    const flushProgress = () => {
      if (!pendingProgress) return
      if (progressTimer) {
        clearTimeout(progressTimer)
        progressTimer = null
      }
      if (!event.sender.isDestroyed()) {
        event.sender.send('export:progress', pendingProgress)
      }
      pendingProgress = null
      lastProgressSentAt = Date.now()
    }

    const queueProgress = (progress: ExportProgress) => {
      pendingProgress = progress
      const force = progress.phase === 'complete'
      if (force) {
        flushProgress()
        return
      }

      const now = Date.now()
      const elapsed = now - lastProgressSentAt
      if (elapsed >= PROGRESS_FORWARD_INTERVAL_MS) {
        flushProgress()
        return
      }

      if (progressTimer) return
      progressTimer = setTimeout(() => {
        flushProgress()
      }, PROGRESS_FORWARD_INTERVAL_MS - elapsed)
    }

    const onProgress = (progress: ExportProgress) => {
      queueProgress(progress)
    }

    const cfg = configService || new ConfigService()
    configService = cfg
    const logEnabled = cfg.get('logEnabled')
    const dbPath = String(cfg.get('dbPath') || '').trim()
    const decryptKey = String(cfg.get('decryptKey') || '').trim()
    const myWxid = String(cfg.getMyWxidCleaned() || '').trim()
    const imageKeys = cfg.getImageKeysForCurrentWxid()
    const accountDir = cfg.getAccountDir(dbPath, String(cfg.get('myWxid') || '').trim()) || undefined
    const resourcesPath = app.isPackaged
      ? join(process.resourcesPath, 'resources')
      : join(app.getAppPath(), 'resources')
    const userDataPath = app.getPath('userData')
    const cachePath = String(cfg.get('cachePath') || '').trim()
    const emojiCacheDir = cachePath ? join(cachePath, 'Emojis') : join(app.getPath('documents'), 'WeFlow', 'Emojis')
    const workerPath = join(__dirname, 'exportWorker.js')

    const runWorker = async () => {
      return await new Promise<any>((resolve, reject) => {
        const worker = new Worker(workerPath, {
          workerData: {
            sessionIds,
            outputDir,
            options,
            taskId,
            dbPath,
            decryptKey,
            myWxid,
            accountDir,
            imageXorKey: imageKeys.xorKey,
            imageAesKey: imageKeys.aesKey,
            resourcesPath,
            userDataPath,
            cachePath,
            emojiCacheDir,
            logEnabled,
            isPackaged: app.isPackaged
          }
        })

        let settled = false
        if (taskId) {
          activeExportWorkers.set(taskId, worker)
        }
        const finalizeResolve = (value: any) => {
          if (settled) return
          settled = true
          if (taskId && activeExportWorkers.get(taskId) === worker) {
            activeExportWorkers.delete(taskId)
          }
          worker.removeAllListeners()
          void worker.terminate()
          resolve(value)
        }
        const finalizeReject = (error: Error) => {
          if (settled) return
          settled = true
          if (taskId && activeExportWorkers.get(taskId) === worker) {
            activeExportWorkers.delete(taskId)
          }
          worker.removeAllListeners()
          void worker.terminate()
          reject(error)
        }

        worker.on('message', (msg: any) => {
          if (msg && msg.type === 'export:progress') {
            onProgress(msg.data as ExportProgress)
            return
          }
          if (msg && msg.type === 'export:createdFiles' && taskId) {
            const filePaths = Array.isArray(msg.filePaths) ? msg.filePaths : []
            for (const filePath of filePaths) {
              exportTaskControlService.recordCreatedFile(taskId, String(filePath || ''))
            }
            return
          }
          if (msg && msg.type === 'export:createdDirs' && taskId) {
            const dirPaths = Array.isArray(msg.dirPaths) ? msg.dirPaths : []
            for (const dirPath of dirPaths) {
              exportTaskControlService.recordCreatedDir(taskId, String(dirPath || ''))
            }
            return
          }
          if (msg && msg.type === 'export:createdFile' && taskId) {
            exportTaskControlService.recordCreatedFile(taskId, String(msg.filePath || ''))
            return
          }
          if (msg && msg.type === 'export:createdDir' && taskId) {
            exportTaskControlService.recordCreatedDir(taskId, String(msg.dirPath || ''))
            return
          }
          if (msg && msg.type === 'export:result') {
            finalizeResolve(msg.data)
            return
          }
          if (msg && msg.type === 'export:error') {
            finalizeReject(new Error(String(msg.error || '导出 Worker 执行失败')))
          }
        })

        worker.on('error', (error) => {
          finalizeReject(error instanceof Error ? error : new Error(String(error)))
        })

        worker.on('exit', (code) => {
          if (settled) return
          if (code === 0) {
            finalizeResolve({ success: false, successCount: 0, failCount: 0, error: '导出 Worker 未返回结果' })
          } else {
            finalizeReject(new Error(`导出 Worker 异常退出: ${code}`))
          }
        })
      })
    }

    try {
      const result = await runWorker()
      return await finalizeExportTaskControlResult(taskId, result)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      console.error(`[export-worker] ${errorMessage}`)
      const normalizedSessionIds = Array.isArray(sessionIds) ? sessionIds : []
      const failedSessionErrors: Record<string, string> = {}
      for (const sessionId of normalizedSessionIds) {
        failedSessionErrors[sessionId] = errorMessage
      }
      const result = {
        success: false,
        successCount: 0,
        failCount: normalizedSessionIds.length,
        failedSessionIds: normalizedSessionIds,
        failedSessionErrors,
        error: `导出 Worker 执行失败: ${errorMessage}`
      }
      return await finalizeExportTaskControlResult(taskId, result)
    } finally {
      if (taskId) activeExportTasks.delete(taskId)
      flushProgress()
      if (progressTimer) {
        clearTimeout(progressTimer)
        progressTimer = null
      }
    }
  })

  ipcMain.handle('export:exportSession', async (event, sessionId: string, outputPath: string, options: ExportOptions) => {
    const cfg = configService || new ConfigService()
    configService = cfg
    const imageKeys = cfg.getImageKeysForCurrentWxid()
    const singleDbPath = String(cfg.get('dbPath') || '').trim()
    const singleMyWxid = String(cfg.getMyWxidCleaned() || '').trim()
    const singleAccountDir = cfg.getAccountDir(singleDbPath, String(cfg.get('myWxid') || '').trim()) || undefined
    const singleCachePath = String(cfg.get('cachePath') || '').trim()
    const singleEmojiCacheDir = singleCachePath ? join(singleCachePath, 'Emojis') : join(app.getPath('documents'), 'WeFlow', 'Emojis')
    const workerPath = join(__dirname, 'exportWorker.js')

    try {
      return await new Promise<any>((resolve) => {
        const worker = new Worker(workerPath, {
          workerData: {
            mode: 'single',
            sessionId,
            outputPath,
            options,
            dbPath: singleDbPath,
            decryptKey: String(cfg.get('decryptKey') || '').trim(),
            myWxid: singleMyWxid,
            accountDir: singleAccountDir,
            imageXorKey: imageKeys.xorKey,
            imageAesKey: imageKeys.aesKey,
            resourcesPath: app.isPackaged ? join(process.resourcesPath, 'resources') : join(app.getAppPath(), 'resources'),
            userDataPath: app.getPath('userData'),
            cachePath: singleCachePath,
            emojiCacheDir: singleEmojiCacheDir,
            logEnabled: cfg.get('logEnabled'),
            isPackaged: app.isPackaged
          }
        })

        let settled = false
        const finalize = (value: any) => {
          if (settled) return
          settled = true
          worker.removeAllListeners()
          void worker.terminate()
          resolve(value)
        }
        const fail = (error: unknown) => {
          const errorMessage = error instanceof Error ? error.message : String(error)
          console.error(`[export-worker-single] ${errorMessage}`)
          finalize({ success: false, error: `导出 Worker 执行失败: ${errorMessage}` })
        }

        worker.on('message', (msg: any) => {
          if (msg && msg.type === 'export:progress') {
            if (!event.sender.isDestroyed()) {
              event.sender.send('export:progress', msg.data)
            }
            return
          }
          if (msg && msg.type === 'export:result') {
            finalize(msg.data)
            return
          }
          if (msg && msg.type === 'export:error') {
            fail(String(msg.error || '导出 Worker 执行失败'))
          }
        })
        worker.on('error', fail)
        worker.on('exit', (code) => {
          if (settled) return
          if (code === 0) {
            finalize({ success: false, error: '导出 Worker 未返回结果' })
          } else {
            fail(`导出 Worker 异常退出: ${code}`)
          }
        })
      })
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      console.error(`[export-worker-single] ${errorMessage}`)
      return { success: false, error: `导出 Worker 启动失败: ${errorMessage}` }
    }
  })

  ipcMain.handle('export:exportContacts', async (_, outputDir: string, options: any) => {
    const cfg = configService || new ConfigService()
    configService = cfg
    const workerPath = join(__dirname, 'exportWorker.js')

    try {
      return await new Promise<any>((resolve) => {
        const worker = new Worker(workerPath, {
          workerData: {
            mode: 'contacts',
            outputDir,
            options,
            dbPath: String(cfg.get('dbPath') || '').trim(),
            decryptKey: String(cfg.get('decryptKey') || '').trim(),
            myWxid: String(cfg.getMyWxidCleaned() || '').trim(),
            resourcesPath: app.isPackaged ? join(process.resourcesPath, 'resources') : join(app.getAppPath(), 'resources'),
            userDataPath: app.getPath('userData'),
            logEnabled: cfg.get('logEnabled'),
            isPackaged: app.isPackaged
          }
        })

        let settled = false
        const finalize = (value: any) => {
          if (settled) return
          settled = true
          worker.removeAllListeners()
          void worker.terminate()
          resolve(value)
        }
        const fail = (error: unknown) => {
          const errorMessage = error instanceof Error ? error.message : String(error)
          console.error(`[export-worker-contacts] ${errorMessage}`)
          finalize({ success: false, error: `导出 Worker 执行失败: ${errorMessage}` })
        }

        worker.on('message', (msg: any) => {
          if (msg && msg.type === 'export:result') {
            finalize(msg.data)
            return
          }
          if (msg && msg.type === 'export:error') {
            fail(String(msg.error || '导出 Worker 执行失败'))
          }
        })
        worker.on('error', fail)
        worker.on('exit', (code) => {
          if (settled) return
          if (code === 0) {
            finalize({ success: false, error: '导出 Worker 未返回结果' })
          } else {
            fail(`导出 Worker 异常退出: ${code}`)
          }
        })
      })
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      console.error(`[export-worker-contacts] ${errorMessage}`)
      return { success: false, error: `导出 Worker 启动失败: ${errorMessage}` }
    }
  })

  // 数据分析相关
  ipcMain.handle('analytics:getOverallStatistics', async (_, force?: boolean) => {
    return analyticsService.getOverallStatistics(force)
  })

  ipcMain.handle('analytics:getContactRankings', async (_, limit?: number, beginTimestamp?: number, endTimestamp?: number) => {
    return analyticsService.getContactRankings(limit, beginTimestamp, endTimestamp)
  })

  ipcMain.handle('analytics:getTimeDistribution', async () => {
    return analyticsService.getTimeDistribution()
  })

  ipcMain.handle('analytics:getSelfSentDailyDistribution', async (_, beginTimestamp?: number, endTimestamp?: number, force?: boolean) => {
    return analyticsService.getSelfSentDailyDistribution(beginTimestamp, endTimestamp, force)
  })

  ipcMain.handle('analytics:getExcludedUsernames', async () => {
    return analyticsService.getExcludedUsernames()
  })

  ipcMain.handle('analytics:setExcludedUsernames', async (_, usernames: string[]) => {
    return analyticsService.setExcludedUsernames(usernames)
  })

  ipcMain.handle('analytics:getExcludeCandidates', async () => {
    return analyticsService.getExcludeCandidates()
  })

  // 缓存管理
  ipcMain.handle('cache:clearAnalytics', async () => {
    return analyticsService.clearCache()
  })

  ipcMain.handle('cache:clearImages', async () => {
    const imageResult = await imageDecryptService.clearCache()
    const emojiResult = chatService.clearCaches({ includeMessages: false, includeContacts: false, includeEmojis: true })
    snsService.clearMemoryCache()
    const errors = [imageResult, emojiResult]
      .filter((result) => !result.success)
      .map((result) => result.error)
      .filter(Boolean) as string[]
    if (errors.length > 0) {
      return { success: false, error: errors.join('; ') }
    }
    return { success: true }
  })

  ipcMain.handle('cache:clearAll', async () => {
    const [analyticsResult, imageResult] = await Promise.all([
      analyticsService.clearCache(),
      imageDecryptService.clearCache()
    ])
    const chatResult = chatService.clearCaches()
    snsService.clearMemoryCache()
    const errors = [analyticsResult, imageResult, chatResult]
      .filter((result) => !result.success)
      .map((result) => result.error)
      .filter(Boolean) as string[]
    if (errors.length > 0) {
      return { success: false, error: errors.join('; ') }
    }
    return { success: true }
  })

  ipcMain.handle('whisper:downloadModel', async (event) => {
    return voiceTranscribeService.downloadModel((progress) => {
      event.sender.send('whisper:downloadProgress', progress)
    })
  })

  ipcMain.handle('whisper:getModelStatus', async () => {
    return voiceTranscribeService.getModelStatus()
  })

  // 群聊分析相关
  ipcMain.handle('groupAnalytics:getGroupChats', async () => {
    return groupAnalyticsService.getGroupChats()
  })

  ipcMain.handle('groupAnalytics:getGroupMembers', async (_, chatroomId: string) => {
    return groupAnalyticsService.getGroupMembers(chatroomId)
  })

  ipcMain.handle(
    'groupAnalytics:getGroupMembersPanelData',
    async (_, chatroomId: string, options?: { forceRefresh?: boolean; includeMessageCounts?: boolean } | boolean) => {
      const normalizedOptions = typeof options === 'boolean'
        ? { forceRefresh: options }
        : options
      return groupAnalyticsService.getGroupMembersPanelData(chatroomId, normalizedOptions)
    }
  )

  ipcMain.handle('groupAnalytics:getGroupMessageRanking', async (_, chatroomId: string, limit?: number, startTime?: number, endTime?: number) => {
    return groupAnalyticsService.getGroupMessageRanking(chatroomId, limit, startTime, endTime)
  })

  ipcMain.handle('groupAnalytics:getGroupActiveHours', async (_, chatroomId: string, startTime?: number, endTime?: number) => {
    return groupAnalyticsService.getGroupActiveHours(chatroomId, startTime, endTime)
  })

  ipcMain.handle('groupAnalytics:getGroupMediaStats', async (_, chatroomId: string, startTime?: number, endTime?: number) => {
    return groupAnalyticsService.getGroupMediaStats(chatroomId, startTime, endTime)
  })

  ipcMain.handle(
    'groupAnalytics:getGroupMemberAnalytics',
    async (_, chatroomId: string, memberUsername: string, startTime?: number, endTime?: number) => {
      return groupAnalyticsService.getGroupMemberAnalytics(chatroomId, memberUsername, startTime, endTime)
    }
  )

  ipcMain.handle(
    'groupAnalytics:getGroupMemberMessages',
    async (
      _,
      chatroomId: string,
      memberUsername: string,
      options?: { startTime?: number; endTime?: number; limit?: number; cursor?: number }
    ) => {
      return groupAnalyticsService.getGroupMemberMessages(chatroomId, memberUsername, options)
    }
  )

  ipcMain.handle('groupAnalytics:exportGroupMembers', async (_, chatroomId: string, outputPath: string) => {
    return groupAnalyticsService.exportGroupMembers(chatroomId, outputPath)
  })

  ipcMain.handle(
    'groupAnalytics:exportGroupMemberMessages',
    async (_, chatroomId: string, memberUsername: string, outputPath: string, startTime?: number, endTime?: number) => {
      return groupAnalyticsService.exportGroupMemberMessages(chatroomId, memberUsername, outputPath, startTime, endTime)
    }
  )

  // 打开协议窗口
  ipcMain.handle('window:openAgreementWindow', async () => {
    createAgreementWindow()
    return true
  })

  // 打开图片查看窗口
  ipcMain.handle('window:openImageViewerWindow', async (_, imagePath: string, liveVideoPath?: string) => {
    // 如果是 dataUrl，写入临时文件
    if (imagePath.startsWith('data:')) {
      const commaIdx = imagePath.indexOf(',')
      const meta = imagePath.slice(5, commaIdx) // e.g. "image/jpeg;base64"
      const ext = meta.split('/')[1]?.split(';')[0] || 'jpg'
      const tmpPath = join(app.getPath('temp'), `weflow_preview_${Date.now()}.${ext}`)
      await writeFile(tmpPath, Buffer.from(imagePath.slice(commaIdx + 1), 'base64'))
      createImageViewerWindow(`file://${tmpPath.replace(/\\/g, '/')}`, liveVideoPath)
    } else {
      createImageViewerWindow(imagePath, liveVideoPath)
    }
  })

  // 完成引导，关闭引导窗口并显示主窗口
  ipcMain.handle('window:completeOnboarding', async () => {
    try {
      configService?.set('onboardingDone', true)
    } catch (e) {
      console.error('保存引导完成状态失败:', e)
    }

    if (onboardingWindow && !onboardingWindow.isDestroyed()) {
      onboardingWindow.close()
    }
    showMainWindow()
    return true
  })

  // 重新打开首次引导窗口，并隐藏主窗口
  ipcMain.handle('window:openOnboardingWindow', async (_, options?: { mode?: 'add-account' }) => {
    shouldShowMain = false
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.hide()
    }
    const mode = options?.mode === 'add-account' ? 'add-account' : 'default'
    createOnboardingWindow(mode)
    return true
  })

  // 年度报告相关
  ipcMain.handle('annualReport:getAvailableYears', async () => {
    const cfg = configService || new ConfigService()
    configService = cfg
    return annualReportService.getAvailableYears({
      dbPath: cfg.get('dbPath'),
      decryptKey: cfg.get('decryptKey'),
      wxid: cfg.getMyWxidCleaned()
    })
  })

  ipcMain.handle('annualReport:startAvailableYearsLoad', async (event) => {
    const cfg = configService || new ConfigService()
    configService = cfg

    const dbPath = cfg.get('dbPath')
    const decryptKey = cfg.get('decryptKey')
    const wxid = cfg.get('myWxid')
    const cacheKey = buildAnnualReportYearsCacheKey(dbPath, wxid)

    const runningTaskId = annualReportYearsTaskByCacheKey.get(cacheKey)
    if (runningTaskId) {
      const runningTask = annualReportYearsLoadTasks.get(runningTaskId)
      if (runningTask && !runningTask.done) {
        return {
          success: true,
          taskId: runningTaskId,
          reused: true,
          snapshot: normalizeAnnualReportYearsSnapshot(runningTask.snapshot)
        }
      }
      annualReportYearsTaskByCacheKey.delete(cacheKey)
    }

    const cachedSnapshot = getAnnualReportYearsSnapshot(cacheKey)
    if (cachedSnapshot && cachedSnapshot.snapshot.done) {
      return {
        success: true,
        taskId: cachedSnapshot.taskId,
        reused: true,
        snapshot: normalizeAnnualReportYearsSnapshot(cachedSnapshot.snapshot)
      }
    }

    const taskId = `years_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const initialSnapshot: AnnualReportYearsProgressPayload = cachedSnapshot?.snapshot && !cachedSnapshot.snapshot.done
      ? {
        ...normalizeAnnualReportYearsSnapshot(cachedSnapshot.snapshot),
        done: false,
        canceled: false,
        error: undefined
      }
      : {
        years: [],
        done: false,
        strategy: 'native',
        phase: 'native',
        statusText: '准备使用原生快速模式加载年份...',
        nativeElapsedMs: 0,
        scanElapsedMs: 0,
        totalElapsedMs: 0,
        switched: false,
        nativeTimedOut: false
      }

    const updateTaskSnapshot = (payload: AnnualReportYearsProgressPayload): AnnualReportYearsProgressPayload | null => {
      const task = annualReportYearsLoadTasks.get(taskId)
      if (!task) return null

      const hasPayloadYears = Array.isArray(payload.years)
      const nextYears = (hasPayloadYears && (payload.done || (payload.years || []).length > 0))
        ? [...(payload.years || [])]
        : Array.isArray(task.snapshot.years) ? [...task.snapshot.years] : []

      const nextSnapshot: AnnualReportYearsProgressPayload = normalizeAnnualReportYearsSnapshot({
        ...task.snapshot,
        ...payload,
        years: nextYears
      })
      task.snapshot = nextSnapshot
      task.done = nextSnapshot.done === true
      task.updatedAt = Date.now()
      annualReportYearsLoadTasks.set(taskId, task)
      persistAnnualReportYearsSnapshot(task.cacheKey, taskId, nextSnapshot)
      return nextSnapshot
    }

    annualReportYearsLoadTasks.set(taskId, {
      cacheKey,
      canceled: false,
      done: false,
      snapshot: normalizeAnnualReportYearsSnapshot(initialSnapshot),
      updatedAt: Date.now()
    })
    annualReportYearsTaskByCacheKey.set(cacheKey, taskId)
    persistAnnualReportYearsSnapshot(cacheKey, taskId, initialSnapshot)

    void (async () => {
      try {
        const result = await annualReportService.getAvailableYears({
          dbPath,
          decryptKey,
          wxid,
          onProgress: (progress) => {
            if (isYearsLoadCanceled(taskId)) return
            const snapshot = updateTaskSnapshot({
              ...progress,
              done: false
            })
            if (!snapshot) return
            broadcastAnnualReportYearsProgress(taskId, snapshot)
          },
          shouldCancel: () => isYearsLoadCanceled(taskId)
        })

        const canceled = isYearsLoadCanceled(taskId)
        if (canceled) {
          const snapshot = updateTaskSnapshot({
            done: true,
            canceled: true,
            phase: 'done',
            statusText: '已取消年份加载'
          })
          if (snapshot) {
            broadcastAnnualReportYearsProgress(taskId, snapshot)
          }
          return
        }

        const completionPayload: AnnualReportYearsProgressPayload = result.success
          ? {
            years: result.data || [],
            done: true,
            strategy: result.meta?.strategy,
            phase: 'done',
            statusText: result.meta?.statusText || '年份数据加载完成',
            nativeElapsedMs: result.meta?.nativeElapsedMs,
            scanElapsedMs: result.meta?.scanElapsedMs,
            totalElapsedMs: result.meta?.totalElapsedMs,
            switched: result.meta?.switched,
            nativeTimedOut: result.meta?.nativeTimedOut
          }
          : {
            years: result.data || [],
            done: true,
            error: result.error || '加载年度数据失败',
            strategy: result.meta?.strategy,
            phase: 'done',
            statusText: result.meta?.statusText || '年份数据加载失败',
            nativeElapsedMs: result.meta?.nativeElapsedMs,
            scanElapsedMs: result.meta?.scanElapsedMs,
            totalElapsedMs: result.meta?.totalElapsedMs,
            switched: result.meta?.switched,
            nativeTimedOut: result.meta?.nativeTimedOut
          }

        const snapshot = updateTaskSnapshot(completionPayload)
        if (snapshot) {
          broadcastAnnualReportYearsProgress(taskId, snapshot)
        }
      } catch (e) {
        const snapshot = updateTaskSnapshot({
          done: true,
          error: String(e),
          phase: 'done',
          statusText: '年份数据加载失败',
          strategy: 'hybrid'
        })
        if (snapshot) {
          broadcastAnnualReportYearsProgress(taskId, snapshot)
        }
      } finally {
        const task = annualReportYearsLoadTasks.get(taskId)
        if (task) {
          annualReportYearsTaskByCacheKey.delete(task.cacheKey)
        }
        annualReportYearsLoadTasks.delete(taskId)
      }
    })()

    return {
      success: true,
      taskId,
      reused: false,
      snapshot: normalizeAnnualReportYearsSnapshot(initialSnapshot)
    }
  })

  ipcMain.handle('annualReport:cancelAvailableYearsLoad', async (_, taskId: string) => {
    const key = String(taskId || '').trim()
    if (!key) return { success: false, error: '任务ID不能为空' }
    const task = annualReportYearsLoadTasks.get(key)
    if (!task) return { success: true }
    task.canceled = true
    annualReportYearsLoadTasks.set(key, task)
    return { success: true }
  })

  ipcMain.handle('annualReport:generateReport', async (_, year: number) => {
    const cfg = configService || new ConfigService()
    configService = cfg

    const dbPath = cfg.get('dbPath')
    const decryptKey = cfg.get('decryptKey')
    const wxid = cfg.getMyWxidCleaned()
    const logEnabled = cfg.get('logEnabled')

    const resourcesPath = app.isPackaged
      ? join(process.resourcesPath, 'resources')
      : join(app.getAppPath(), 'resources')
    const userDataPath = app.getPath('userData')

    const workerPath = join(__dirname, 'annualReportWorker.js')

    return await new Promise((resolve) => {
      const worker = new Worker(workerPath, {
        workerData: { year, dbPath, decryptKey, myWxid: wxid, resourcesPath, userDataPath, logEnabled }
      })

      const cleanup = () => {
        worker.removeAllListeners()
      }

      worker.on('message', (msg: any) => {
        if (msg && msg.type === 'annualReport:progress') {
          for (const win of BrowserWindow.getAllWindows()) {
            if (!win.isDestroyed()) {
              win.webContents.send('annualReport:progress', msg.data)
            }
          }
          return
        }
        if (msg && (msg.type === 'annualReport:result' || msg.type === 'done')) {
          cleanup()
          void worker.terminate()
          resolve(msg.data ?? msg.result)
          return
        }
        if (msg && (msg.type === 'annualReport:error' || msg.type === 'error')) {
          cleanup()
          void worker.terminate()
          resolve({ success: false, error: msg.error || '年度报告生成失败' })
        }
      })

      worker.on('error', (err) => {
        cleanup()
        resolve({ success: false, error: String(err) })
      })

      worker.on('exit', (code) => {
        if (code !== 0) {
          cleanup()
          resolve({ success: false, error: `年度报告线程异常退出: ${code}` })
        }
      })
    })
  })

  ipcMain.handle('dualReport:generateReport', async (_, payload: { friendUsername: string; year: number }) => {
    const cfg = configService || new ConfigService()
    configService = cfg

    const dbPath = cfg.get('dbPath')
    const decryptKey = cfg.get('decryptKey')
    const wxid = cfg.getMyWxidCleaned()
    const logEnabled = cfg.get('logEnabled')
    const friendUsername = payload?.friendUsername
    const year = payload?.year ?? 0
    const excludeWords = cfg.get('wordCloudExcludeWords') || []

    if (!friendUsername) {
      return { success: false, error: '缺少好友用户名' }
    }

    const resourcesPath = app.isPackaged
      ? join(process.resourcesPath, 'resources')
      : join(app.getAppPath(), 'resources')
    const userDataPath = app.getPath('userData')

    const workerPath = join(__dirname, 'dualReportWorker.js')

    return await new Promise((resolve) => {
      const worker = new Worker(workerPath, {
        workerData: { year, friendUsername, dbPath, decryptKey, myWxid: wxid, resourcesPath, userDataPath, logEnabled, excludeWords }
      })

      const cleanup = () => {
        worker.removeAllListeners()
      }

      worker.on('message', (msg: any) => {
        if (msg && msg.type === 'dualReport:progress') {
          for (const win of BrowserWindow.getAllWindows()) {
            if (!win.isDestroyed()) {
              win.webContents.send('dualReport:progress', msg.data)
            }
          }
          return
        }
        if (msg && (msg.type === 'dualReport:result' || msg.type === 'done')) {
          cleanup()
          void worker.terminate()
          resolve(msg.data ?? msg.result)
          return
        }
        if (msg && (msg.type === 'dualReport:error' || msg.type === 'error')) {
          cleanup()
          void worker.terminate()
          resolve({ success: false, error: msg.error || '双人报告生成失败' })
        }
      })

      worker.on('error', (err) => {
        cleanup()
        resolve({ success: false, error: String(err) })
      })

      worker.on('exit', (code) => {
        if (code !== 0) {
          cleanup()
          resolve({ success: false, error: `双人报告线程异常退出: ${code}` })
        }
      })
    })
  })

  ipcMain.handle('annualReport:exportImages', async (_, payload: { baseDir: string; folderName: string; images: Array<{ name: string; dataUrl: string }> }) => {
    try {
      const { baseDir, folderName, images } = payload
      if (!baseDir || !folderName || !Array.isArray(images) || images.length === 0) {
        return { success: false, error: '导出参数无效' }
      }

      let targetDir = join(baseDir, folderName)
      if (existsSync(targetDir)) {
        let idx = 2
        while (existsSync(`${targetDir}_${idx}`)) idx++
        targetDir = `${targetDir}_${idx}`
      }

      await mkdir(targetDir, { recursive: true })

      for (const img of images) {
        const dataUrl = img.dataUrl || ''
        const commaIndex = dataUrl.indexOf(',')
        if (commaIndex <= 0) continue
        const base64 = dataUrl.slice(commaIndex + 1)
        const buffer = Buffer.from(base64, 'base64')
        const filePath = join(targetDir, img.name)
        await writeFile(filePath, buffer)
      }

      return { success: true, dir: targetDir }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('annualReport:captureCurrentWindow', async (event) => {
    try {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win || win.isDestroyed()) {
        return { success: false, error: '窗口不可用' }
      }

      const image = await win.webContents.capturePage()
      return {
        success: true,
        dataUrl: image.toDataURL(),
        size: image.getSize()
      }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  // 密钥获取
  ipcMain.handle('key:autoGetDbKey', async (event) => {
    return keyService.autoGetDbKey(180_000, (message: string, level: number) => {
      event.sender.send('key:dbKeyStatus', { message, level })
    })
  })

  ipcMain.handle('key:autoGetImageKey', async (event, manualDir?: string, wxid?: string) => {
    return keyService.autoGetImageKey(manualDir, (message: string) => {
      event.sender.send('key:imageKeyStatus', { message })
    }, wxid)
  })

  ipcMain.handle('key:scanImageKeyFromMemory', async (event, userDir: string) => {
    return keyService.autoGetImageKeyByMemoryScan(userDir, (message: string) => {
      event.sender.send('key:imageKeyStatus', { message })
    })
  })

  // HTTP API 服务
  ipcMain.handle('http:start', async (_, port?: number, host?: string) => {
    const bindHost = typeof host === 'string' && host.trim() ? host.trim() : '127.0.0.1'
    return httpService.start(port || 5031, bindHost)
  })

  ipcMain.handle('http:stop', async () => {
    await httpService.stop()
    return { success: true }
  })

  ipcMain.handle('http:status', async () => {
    return {
      running: httpService.isRunning(),
      port: httpService.getPort(),
      mediaExportPath: httpService.getDefaultMediaExportPath()
    }
  })

  // 自动下载原图
  ipcMain.handle('image:startAutoDownload', async (_, whitelist?: string[]) => {
    return await imageDownloadService.startAutoDownload(whitelist || [])
  })

  ipcMain.handle('image:stopAutoDownload', async () => {
    await imageDownloadService.stopAutoDownload()
    return { success: true }
  })

  ipcMain.handle('image:getAutoDownloadStatus', async () => {
    return await imageDownloadService.getStatus()
  })

  // ─── 销售助手 IPC Handlers ──────────────────────────────────────────────────

  // 知识库
  ipcMain.handle('sales:kb:list', async (_, filters?) => {
    return salesKnowledgeService.list(filters)
  })

  ipcMain.handle('sales:kb:get', async (_, id: number) => {
    return salesKnowledgeService.get(id)
  })

  ipcMain.handle('sales:kb:create', async (_, payload) => {
    return salesKnowledgeService.create(payload)
  })

  ipcMain.handle('sales:kb:update', async (_, id: number, payload) => {
    return salesKnowledgeService.update(id, payload)
  })

  ipcMain.handle('sales:kb:delete', async (_, id: number) => {
    return salesKnowledgeService.delete(id)
  })

  ipcMain.handle('sales:kb:search', async (_, payload) => {
    return salesKnowledgeService.search(payload)
  })

  // 报表
  ipcMain.handle('sales:report:generate', async (_, payload) => {
    return salesReportService.generate(payload)
  })

  ipcMain.handle('sales:report:list', async (_, limit?: number) => {
    try {
      return { success: true, reports: salesDbService.reportList(limit ?? 20) }
    } catch (e) {
      return { success: false, reports: [], error: String(e) }
    }
  })

  ipcMain.handle('sales:report:get', async (_, id: number) => {
    try {
      const report = salesDbService.reportGet(id)
      if (!report) return { success: false, error: '报表不存在' }
      return { success: true, report }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('sales:report:delete', async (_, id: number) => {
    try {
      const deleted = salesDbService.reportDelete(id)
      return { success: deleted }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  // 客户画像
  ipcMain.handle('sales:customer:get', async (_, sessionId: string) => {
    try {
      const profile = salesDbService.customerGetBySession(sessionId)
      return { success: true, profile: profile ?? null }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  // P0-3 第一刀：客户当前视图（只读组装层，纯投影不推理；UI 未消费，先验证）
  ipcMain.handle('sales:customer:currentView', async (_, sessionId: string) => {
    try {
      const view = getCustomerCurrentView(String(sessionId || '').trim())
      if (!view) return { success: false, error: '客户不存在' }
      return { success: true, data: view }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('sales:customer:upsert', async (_, data) => {
    try {
      // P0-2A.5：通用 upsert 撤销 stage 写权限 —— 运行时剥离（防御式，即使旧调用带 stage 也不应用）。
      // stage 只由合法写者写入（classifier/intent/manual/deal）；底层 customerUpsert 不动，合法写者仍直接使用。
      const payload = stripStageFromUpsert(data as CustomerUpsertInput)
      const profile = salesDbService.customerUpsert(payload)
      return { success: true, profile }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('sales:customer:list', async (_, filters?) => {
    try {
      return { success: true, customers: salesDbService.customerList(filters) }
    } catch (e) {
      return { success: false, customers: [], error: String(e) }
    }
  })

  // 仪表盘聚合统计
  ipcMain.handle('sales:dashboard:stats', async () => {
    try {
      return { success: true, stats: salesDbService.getDashboardStats() }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  // 销售漏斗（历史累计流转；days=0 全部历史，默认 30 天）
  ipcMain.handle('sales:funnel:stats', async (_e, days?: number) => {
    try {
      return { success: true, data: salesDbService.funnelStats(Number(days) || 0) }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  // P0-4.2.2 Action Funnel 聚合视图（Task-level 六段；days=null 全量；纯只读不调 LLM）
  ipcMain.handle('sales:actionFunnel:get', async (_e, days?: number | null) => {
    try {
      return { success: true, data: getActionFunnel(typeof days === 'number' && days > 0 ? days : null) }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  // P0-4.3 Action Funnel 下钻（KPI 点击 → 事件类型计数 + 任务样本；与聚合共享判定行）
  ipcMain.handle('sales:actionFunnel:breakdown', async (_e, days?: number | null) => {
    try {
      return { success: true, data: getActionFunnelBreakdown(typeof days === 'number' && days > 0 ? days : null) }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  // 客户数据导出 Excel（exceljs 运行时加载，弹保存对话框）
  ipcMain.handle('sales:customer:export', async () => {
    try {
      const { dialog } = await import('electron')
      const dlg = await dialog.showSaveDialog({
        defaultPath: `客户数据_${new Date().toISOString().slice(0, 10)}.xlsx`,
        filters: [{ name: 'Excel 工作簿', extensions: ['xlsx'] }]
      })
      if (dlg.canceled || !dlg.filePath) return { success: false, error: '已取消' }

      const customers = salesDbService.customerList()
      const ExcelJSMod = await import('exceljs')
      const ExcelJS = (ExcelJSMod as any).default || ExcelJSMod
      const wb = new ExcelJS.Workbook()
      wb.creator = 'WeFlow AI 销售助手'
      const ws = wb.addWorksheet('客户数据')
      ws.columns = [
        { header: '客户名', key: 'name', width: 26 },
        { header: '阶段', key: 'stage', width: 10 },
        { header: '沉默天数', key: 'silence', width: 10 },
        { header: '待跟进待办', key: 'todos', width: 12 },
        { header: '标签', key: 'tags', width: 22 },
        { header: '备注', key: 'notes', width: 32 },
        { header: 'AI 画像摘要', key: 'profile', width: 60 },
        { header: '最后联系', key: 'last', width: 18 }
      ]
      ws.getRow(1).font = { bold: true }

      const now = Date.now()
      for (const cu of customers) {
        const silence = cu.last_contact_at ? Math.floor((now - cu.last_contact_at) / 86400000) : ''
        let todoCount = 0
        try {
          todoCount = salesDbService.todoList({ session_id: cu.session_id })
            .filter((t: any) => t.status === 'pending' || t.status === 'suspected' || t.status === 'overdue').length
        } catch { /* ignore */ }
        let tagsStr = ''
        try { const arr = JSON.parse(cu.tags || '[]'); tagsStr = Array.isArray(arr) ? arr.join(', ') : '' } catch { /* ignore */ }
        let profileSummary = ''
        try {
          const rec = insightProfileService.getProfileRecord(cu.session_id)
          if (rec?.finalProfile) profileSummary = rec.finalProfile.slice(0, 200)
        } catch { /* ignore */ }
        ws.addRow({
          name: cu.display_name || cu.session_id,
          stage: cu.stage === 'unknown' ? '未知' : (cu.stage || ''),
          silence,
          todos: todoCount,
          tags: tagsStr,
          notes: (cu.notes || '').slice(0, 200),
          profile: profileSummary,
          last: cu.last_contact_at ? new Date(cu.last_contact_at).toLocaleString('zh-CN') : ''
        })
      }

      await wb.xlsx.writeFile(dlg.filePath)
      return { success: true, filePath: dlg.filePath, count: customers.length }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  // 客户画像聚合接口
  ipcMain.handle('sales:customer:detail', async (_, sessionId: string) => {
    try {
      if (!sessionId) return { success: false, error: 'sessionId 不能为空' }

      // 1. 获取或自动创建 customer_profile
      let profile = salesDbService.customerGetBySession(sessionId)
      if (!profile) {
        // 尝试从 wcdb 获取 display_name
        let displayName = sessionId
        try {
          const sessions = await wcdbService.getSessions()
          if (sessions.success && sessions.sessions) {
            const found = sessions.sessions.find((s: any) => s.sessionId === sessionId || s.userName === sessionId)
            if (found) displayName = found.remark || found.nickName || found.displayName || sessionId
          }
        } catch { /* ignore */ }
        profile = salesDbService.customerUpsert({ session_id: sessionId, display_name: displayName })
      }

      // 2. 消息统计
      let messageStats: { total: number; firstContactAt: number | null; lastContactAt: number | null } = { total: 0, firstContactAt: null, lastContactAt: null }
      try {
        const countResult = await wcdbService.getMessageCount(sessionId)
        if (countResult.success && countResult.count) {
          messageStats.total = countResult.count
          // 取最新一条
          const latest = await wcdbService.getMessages(sessionId, 1, 0)
          if (latest.success && latest.messages && latest.messages.length > 0) {
            messageStats.lastContactAt = latest.messages[0].createTime ?? null
          }
          // 取最早一条
          if (countResult.count > 1) {
            const earliest = await wcdbService.getMessages(sessionId, 1, countResult.count - 1)
            if (earliest.success && earliest.messages && earliest.messages.length > 0) {
              messageStats.firstContactAt = earliest.messages[0].createTime ?? null
            }
          } else if (countResult.count === 1) {
            messageStats.firstContactAt = messageStats.lastContactAt
          }
        }
      } catch { /* wcdb 未打开时忽略 */ }

      // 3. AI 画像文本
      let aiProfile = ''
      let aiProfileMeta: { rangeStart?: number; rangeEnd?: number; updatedAt?: number } | null = null
      try {
        const record = insightProfileService.getProfileRecord(sessionId)
        if (record?.finalProfile) {
          aiProfile = record.finalProfile
          aiProfileMeta = { rangeStart: record.rangeStart, rangeEnd: record.rangeEnd, updatedAt: record.updatedAt }
        }
      } catch { /* ignore */ }

      // 4. 意向变更记录
      let intentHistory: any[] = []
      try {
        intentHistory = salesDbService.intentHistory(sessionId, 10)
      } catch { /* ignore */ }

      // 5. 跟进待办
      let todos: any[] = []
      try {
        todos = salesDbService.todoList({ session_id: sessionId })
      } catch { /* ignore */ }

      // 6. 回填 last_contact_at（供客户列表沉默天数使用）
      if (messageStats.lastContactAt) {
        try {
          salesDbService.customerUpsert({ session_id: sessionId, last_contact_at: messageStats.lastContactAt })
        } catch { /* ignore */ }
      }

      return {
        success: true,
        data: { profile, messageStats, aiProfile, aiProfileMeta, intentHistory, todos }
      }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  // 意向标签
  ipcMain.handle('sales:intent:analyze', async (_, sessionId: string) => {
    try {
      return await salesIntentService.analyzeIntent(sessionId, configService)
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('sales:intent:correct', async (_, payload: { session_id: string; stage: string; reason?: string }) => {
    try {
      // P0-2A.6：manual 写者元数据收口 —— 校验值合法性（拒绝非枚举值 + dormant）+ 阶段变更时写 last_stage_change_at
      return applyManualStageCorrection(payload.session_id, payload.stage, payload.reason)
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('sales:evidence:getByKey', async (_, payload: { session_id: string; message_key: string; evidence_text?: string }) => {
    try {
      // P0-2B：证据链统一读入口 —— 只读，不写任何业务数据；找不到返回 unavailable，不伪造。
      return await evidenceResolver.getEvidenceByKey(payload.session_id, payload.message_key, payload.evidence_text)
    } catch (e) {
      return { status: 'unavailable', reason: 'reader_error', evidenceText: payload.evidence_text, error: String(e) }
    }
  })

  ipcMain.handle('sales:intent:history', async (_, sessionId: string, limit?: number) => {
    try {
      return { success: true, tags: salesDbService.intentHistory(sessionId, limit ?? 20) }
    } catch (e) {
      return { success: false, tags: [], error: String(e) }
    }
  })

  // 回复建议
  ipcMain.handle('sales:reply:suggest', async (_, payload) => {
    try {
      return await salesReplyService.suggestReplies(payload.session_id, configService, payload.context_messages)
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  // 待办
  ipcMain.handle('sales:todo:list', async (_, filters?) => {
    try {
      return { success: true, tasks: salesDbService.todoList(filters) }
    } catch (e) {
      return { success: false, tasks: [], error: String(e) }
    }
  })

  ipcMain.handle('sales:todo:create', async (_, payload) => {
    try {
      const task = salesDbService.todoCreate(payload)
      return { success: true, task }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('sales:todo:update', async (_, id: number, updates) => {
    try {
      const task = salesDbService.todoUpdate(id, updates)
      if (!task) return { success: false, error: '待办不存在' }
      return { success: true, task }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('sales:todo:scan', async (_, period?: string) => {
    try {
      return await salesFollowUpService.scan(configService, period || 'week')
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('sales:profile:batch', async (_, limit?: number, monthsBack?: number) => {
    try {
      return await insightService.batchProfile(limit || 50, monthsBack || 6)
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('sales:profile:progress', async () => {
    return insightService.getBatchProgress()
  })

  // ─── 今日行动引擎 IPC ───────────────────────────────────────────────────────
  ipcMain.handle('sales:action:getToday', async () => {
    return getTodayActions()
  })

  ipcMain.handle('sales:action:complete', async (_, taskId: number, action: 'done' | 'skipped') => {
    completeAction(taskId, action)
    return { success: true }
  })

  ipcMain.handle('sales:action:getUnified', async () => {
    return getUnifiedSignals()
  })

  ipcMain.handle('sales:action:completeUnified', async (_, sessionId: string, action: 'done' | 'skipped') => {
    completeUnifiedSignal(sessionId, action)
    return { ok: true }
  })

  // P0-3 E3.3：销售行动事件上报（script_copied / chat_opened 由前端动作成功点提交；
  // follow_up_done 不经此通道——由 completeAction 状态转换自动触发，防双写/不可控）
  // P0-4.2.1：透传 taskId（前端卡片 sources[].rawTaskId，无任务上下文 NULL——correlation key，非合法性前置）
  ipcMain.handle('sales:action:recordEvent', async (_, p: { sessionId?: string; eventType?: string; messageKey?: string | null; taskId?: number | null }) => {
    if (!p || typeof p !== 'object') return { ok: false }
    recordUserActionEvent(String(p.sessionId || ''), p.eventType as any, p.messageKey || null, typeof p.taskId === 'number' ? p.taskId : null)
    return { ok: true }
  })

  ipcMain.handle('sales:action:suggest', async (_, item: any) => {
    const r = await generateActionAnalysis(item)
    // P0-2C.3：suggest 为手动通道 → 三判断（机会/风险/下一步）落 customer_judgment
    // （source=manual，跳过去重窗口保留覆盖权利）；失败不阻断建议返回。
    if (r && !r.notConfigured && !r.error) {
      try {
        await persistActionAnalysisJudgments({
          item,
          analysis: r,
          channel: 'suggest',
          model: String(configService?.get('aiModelApiModel') || '').trim() || undefined
        })
      } catch (e) {
        salesLog('WARN', `[ActionJudgment] suggest 落库失败（不阻断建议）: ${(e as Error).message}`)
      }
    }
    return { success: true, ...r }
  })

  // ─── 周复盘 IPC ─────────────────────────────────────────────────────────────
  ipcMain.handle('sales:review:generate', async () => {
    return salesReportService.generateWeeklyReview()
  })

  // ─── 晨间摘要 IPC（设计-AI见解重定位 §3.1）─────────────────────────────────
  ipcMain.handle('sales:morningDigest:get', async () => {
    return { ok: true, data: morningDigestService.getLatestDigest() }
  })
  ipcMain.handle('sales:morningDigest:regenerate', async () => {
    const data = await enqueueSalesTask(() => morningDigestService.regenerateToday())
    return { ok: true, data }
  })

  // ─── 知识库批量导入 IPC ─────────────────────────────────────────────────────
  ipcMain.handle('sales:kb:importCsv', async (_, csvContent: string) => {
    return salesKnowledgeService.importFromCsv(csvContent)
  })

  // ─── 话术提炼 IPC ──────────────────────────────────────────────────────────
  ipcMain.handle('sales:kb:extractScripts', async (_, sessionId: string, opts?: { beginDate?: string; endDate?: string }) => {
    return salesKnowledgeService.extractScriptsFromChat(sessionId, configService, opts?.beginDate || opts?.endDate ? 300 : 100, opts?.beginDate, opts?.endDate)
  })

  // ─── 扫描提炼候选 IPC（纯本地，不调 AI）──────────────────────────────────
  ipcMain.handle('sales:kb:scanExtractCandidates', async (_, options?: { minMessages?: number; maxDaysAgo?: number; beginDate?: string; endDate?: string }) => {
    const start = Date.now()
    const minMessages = options?.minMessages ?? 10
    const maxDaysAgo = options?.maxDaysAgo ?? 365
    const beginDate = options?.beginDate
    const endDate = options?.endDate

    // 日期区间 → 绝对秒级时间戳；无日期区间 → 用 maxDaysAgo 算相对下限
    const beginSec = beginDate ? Math.floor(new Date(beginDate + 'T00:00:00+08:00').getTime() / 1000) : 0
    const endSec = endDate ? Math.floor(new Date(endDate + 'T23:59:59+08:00').getTime() / 1000) : 0
    const hasDateRange = !!(beginDate || endDate)

    try {
      const sessionsResult = await chatService.getSessions()
      if (!sessionsResult?.success || !sessionsResult.sessions?.length) {
        return { success: false, error: '无法获取会话列表' }
      }
      const sessions = sessionsResult.sessions

      const nowSec = Math.floor(Date.now() / 1000)
      const cutoffSec = (!hasDateRange && maxDaysAgo > 0) ? nowSec - maxDaysAgo * 86400 : 0

      // Phase 1: 硬性排除
      const rawCandidates: Array<{
        sessionId: string; nickname: string; messageCount: number;
        lastContactAt: number; isKnownCustomer: boolean; score: number
      }> = []

      for (const s of sessions) {
        if (!s.displayName) continue
        const u = (s.username || '').toLowerCase()
        if (!u || u.includes('@chatroom') || u.startsWith('gh_')) continue
        if (u === 'weixin' || u === 'newsapp' || u.startsWith('qmessage')) continue

        const msgCount = s.messageCountHint || 0
        if (msgCount < minMessages) continue

        const lastTs = s.lastTimestamp || s.sortTimestamp || 0
        // 日期区间：过滤 lastTs 不在区间内的联系人
        if (hasDateRange) {
          if (beginSec > 0 && lastTs < beginSec) continue
          if (endSec > 0 && lastTs > endSec) continue
        } else if (lastTs > 0 && lastTs < cutoffSec) {
          continue
        }

        rawCandidates.push({
          sessionId: s.username,
          nickname: s.displayName || s.username,
          messageCount: msgCount,
          lastContactAt: lastTs,
          isKnownCustomer: false,
          score: 0
        })
      }

      if (rawCandidates.length === 0) {
        return { success: true, totalScanned: sessions.length, candidates: [], scanDurationMs: Date.now() - start }
      }

      // Phase 2: 批量查 customer_profile（标记已知客户）
      const allProfiles = salesDbService.customerAll()
      const knownSessionIds = new Set(allProfiles.map(p => p.session_id))
      for (const c of rawCandidates) {
        c.isKnownCustomer = knownSessionIds.has(c.sessionId)
      }

      // Phase 3: 加权排序
      const maxMsgs = Math.max(1, ...rawCandidates.map(c => c.messageCount))
      const nowForDays = nowSec

      for (const c of rawCandidates) {
        const daysAgo = Math.max(1, (nowForDays - c.lastContactAt) / 86400)
        const normMsgs = c.messageCount / maxMsgs
        const normRecency = Math.min(1, 30 / daysAgo) // 30天以内权重高
        const normCustomer = c.isKnownCustomer ? 1 : 0
        c.score = 0.3 * normMsgs + 0.3 * normRecency + 0.4 * normCustomer
      }

      rawCandidates.sort((a, b) => b.score - a.score)

      return {
        success: true,
        totalScanned: sessions.length,
        candidates: rawCandidates.slice(0, 200), // 上限 200，超出提示用户缩小范围
        scanDurationMs: Date.now() - start
      }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  // ─── 一键提炼全部私聊 IPC（接收扫描后的 {sessionId,nickname}[] + 可选日期）─
  ipcMain.handle('sales:kb:extractScriptsAll', async (_, contacts?: Array<{ sessionId: string; nickname: string }>, opts?: { beginDate?: string; endDate?: string }) => {
    try {
      let targets: Array<{ username: string; displayName: string }> = []

      if (contacts && contacts.length > 0) {
        // 直接使用前端传入的 sessionId+nickname，不再重查全部会话
        targets = contacts.map(c => ({ username: c.sessionId, displayName: c.nickname }))
      } else {
        // 回退：自己扫描（兼容直接调用 extractScriptsAll 的旧代码路径）
        const sessionsResult = await chatService.getSessions()
        if (!sessionsResult?.success || !sessionsResult.sessions?.length) {
          return { success: false, error: '无法获取会话列表' }
        }
        targets = sessionsResult.sessions
          .filter((s: any) => {
            if (!s.displayName) return false
            const u = (s.username || '').toLowerCase()
            if (!u || u.includes('@chatroom') || u.startsWith('gh_')) return false
            return true
          })
          .sort((a: any, b: any) => (b.messageCountHint || 0) - (a.messageCountHint || 0))
          .slice(0, 50)
          .map((s: any) => ({ username: s.username, displayName: s.displayName || s.username }))
      }

      if (targets.length === 0) {
        return { success: true, candidates: [], stats: { total: 0, processed: 0, skipped: 0 } }
      }
      const allCandidates: any[] = []
      let processed = 0
      let skipped = 0

      for (let i = 0; i < targets.length; i++) {
        const t = targets[i]

        // 发送进度到渲染进程
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('sales:kb:extractProgress', {
            current: i + 1,
            total: targets.length,
            contactName: t.displayName,
            foundSoFar: allCandidates.length
          })
        }

        try {
          const result = await salesKnowledgeService.extractScriptsFromChat(
            t.username,
            configService,
            (opts?.beginDate || opts?.endDate) ? 300 : 80,
            opts?.beginDate,
            opts?.endDate
          )
          processed++

          if (result.success && result.candidates?.length) {
            for (const c of result.candidates) {
              allCandidates.push({
                ...c,
                sourceContact: t.displayName
              })
            }
          } else if (result.success) {
            // AI 返回了空数组（没找到可提炼的话术），记录但不计为失败
            salesLog('INFO', `[ExtractAll] ${t.displayName}: 0 scripts (AI returned empty)`)
          } else {
            salesLog('WARN', `[ExtractAll] ${t.displayName}: FAILED — ${result.error}`)
            skipped++
          }
        } catch (e: any) {
          salesLog('WARN', `[ExtractAll] ${t.displayName}: CRASH — ${e?.message || e}`)
          skipped++
        }
      }

      // 去重：跨联系人合并，标题+内容相似度 >60% 的只保留一条
      const deduped = dedupeAcrossContacts(allCandidates)

      return {
        success: true,
        candidates: deduped,
        stats: { total: targets.length, processed, skipped }
      }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })
}

// ─── 跨联系人去重 ─────────────────────────────────────────────────────────────

function dedupeAcrossContacts(candidates: any[]): any[] {
  if (candidates.length <= 1) return candidates

  const result: any[] = []
  for (const c of candidates) {
    const content = (c.content || '').slice(0, 80)
    const isDup = result.some(r => {
      const rContent = (r.content || '').slice(0, 80)
      return similarity(content, rContent) > 0.65
    })
    if (!isDup) result.push(c)
  }
  return result
}

function similarity(a: string, b: string): number {
  if (!a || !b) return 0
  const aGrams = new Set<string>()
  const bGrams = new Set<string>()
  for (let i = 0; i < a.length - 1; i++) aGrams.add(a.slice(i, i + 2))
  for (let i = 0; i < b.length - 1; i++) bGrams.add(b.slice(i, i + 2))
  if (aGrams.size === 0 || bGrams.size === 0) return 0
  let hits = 0
  for (const g of aGrams) { if (bGrams.has(g)) hits++ }
  return hits / Math.max(aGrams.size, bGrams.size)
}

// 主窗口引用
let mainWindow: BrowserWindow | null = null

// 启动时自动检测更新
function checkForUpdatesOnStartup() {
  if (!AUTO_UPDATE_ENABLED) return
  // 开发环境不检测更新
  if (process.env.VITE_DEV_SERVER_URL) return

  // 延迟3秒检测，等待窗口完全加载
  setTimeout(async () => {
    try {
      const result = await autoUpdater.checkForUpdates()
      if (result && result.updateInfo) {
        const currentVersion = app.getVersion()
        const latestVersion = result.updateInfo.version

        // 检查是否有新版本
        if (shouldOfferUpdateForTrack(latestVersion, currentVersion) && mainWindow) {
          // 检查该版本是否被用户忽略
          const ignoredVersion = configService?.get('ignoredUpdateVersion')
          if (ignoredVersion === latestVersion) {

            return
          }

          // 通知渲染进程有新版本
          mainWindow.webContents.send('app:updateAvailable', {
            version: latestVersion,
            releaseNotes: getDialogReleaseNotes(result.updateInfo.releaseNotes),
            minimumVersion: (result.updateInfo as any).minimumVersion
          })
        }
      }
    } catch (error) {
      console.error('启动时检查更新失败:', error)
    }
  }, 3000)
}


app.whenReady().then(async () => {
  // 先初始化配置，以便在启动早期判定是否需要静默启动
  configService = new ConfigService()
  applyAutoUpdateChannel('startup')
  syncLaunchAtStartupPreference()
  const onboardingDone = configService.get('onboardingDone') === true
  const startInBackground = onboardingDone && isSilentStartupEnabled()
  shouldShowMain = onboardingDone

  if (!startInBackground) {
    // 非静默模式下显示 Splash，提供启动反馈（主题/版本号通过 URL 参数传入）
    createSplashWindow()

    // 等待 Splash 页面加载完成，确保后续 executeJavaScript 推送的进度可靠送达
    if (splashWindow) {
      await new Promise<void>((resolve) => {
        if (splashWindow!.webContents.isLoading()) {
          splashWindow!.webContents.once('did-finish-load', () => resolve())
        } else {
          resolve()
        }
      })
    }
  }

  const withTimeout = <T>(task: () => Promise<T>, timeoutMs: number): Promise<{ timedOut: boolean; value?: T; error?: string }> => {
    return new Promise((resolve) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        resolve({ timedOut: true, error: `timeout(${timeoutMs}ms)` })
      }, timeoutMs)

      task()
        .then((value) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve({ timedOut: false, value })
        })
        .catch((error) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve({ timedOut: false, error: String(error) })
        })
    })
  }

  // 基础初始化均为毫秒级操作，直接顺序执行
  updateSplashProgress(10, '正在初始化...')
  const candidateResources = app.isPackaged
    ? join(process.resourcesPath, 'resources')
    : join(app.getAppPath(), 'resources')
  const fallbackResources = join(process.cwd(), 'resources')
  const resourcesPath = existsSync(candidateResources) ? candidateResources : fallbackResources
  const userDataPath = app.getPath('userData')
  wcdbService.setPaths(resourcesPath, userDataPath)
  wcdbService.setLogEnabled(configService.get('logEnabled') === true)
  registerIpcHandlers()
  chatService.addDbMonitorListener((type, json) => {
    messagePushService.handleDbMonitorChange(type, json)
    insightService.handleDbMonitorChange(type, json)
  })

  // 提前创建主窗口（隐藏），让渲染进程加载与数据库预热并行进行
  updateSplashProgress(20, '正在准备主窗口...')
  ensureWeChatRequestHeaderInterceptor()
  mainWindow = createWindow({ autoShow: false })

  const resolvedTrayIcon = resolveAppIconPath()

  try {
    tray = new Tray(resolvedTrayIcon)
    tray.setToolTip('WeFlow')
    const contextMenu = Menu.buildFromTemplate([
      {
        label: '显示主窗口',
        click: () => {
          if (mainWindow) {
            mainWindow.show()
            mainWindow.focus()
          }
        }
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          isAppQuitting = true
          app.quit()
        }
      }
    ])
    tray.setContextMenu(contextMenu)
    tray.on('click', () => {
      if (mainWindow) {
        if (mainWindow.isVisible()) {
          mainWindow.focus()
        } else {
          mainWindow.show()
          mainWindow.focus()
        }
      }
    })
    tray.on('double-click', () => {
      if (mainWindow) {
        mainWindow.show()
        mainWindow.focus()
      }
    })
  } catch (e) {
    console.warn('[Tray] Failed to create tray icon:', e)
  }

  // 已完成引导时，与渲染进程加载并行预热会话列表和联系人名字/头像缓存
  if (onboardingDone) {
    updateSplashProgress(35, '正在连接数据库...')
    const connectWarmup = await withTimeout(() => chatService.connect(), 12000)
    const connected = !connectWarmup.timedOut && connectWarmup.value?.success === true

    if (!connected) {
      const reason = connectWarmup.timedOut
        ? connectWarmup.error
        : (connectWarmup.value?.error || connectWarmup.error || 'unknown')
      console.warn('[StartupWarmup] 跳过预热，数据库连接失败:', reason)
    } else {
      updateSplashProgress(55, '正在预加载会话...')
      const preloadUsernames = new Set<string>()
      const sessionsWarmup = await withTimeout(() => chatService.getSessions(), 12000)
      if (!sessionsWarmup.timedOut && sessionsWarmup.value?.success && Array.isArray(sessionsWarmup.value.sessions)) {
        for (const session of sessionsWarmup.value.sessions) {
          const username = String((session as any)?.username || '').trim()
          if (username) preloadUsernames.add(username)
        }
      }

      updateSplashProgress(75, '正在缓存联系人头像...')
      // 只预热前 600 个会话的头像：覆盖首屏与常用会话，其余由 ChatPage
      // 的渐进式补齐队列按需加载，降低启动耗时与常驻内存
      const avatarWarmupUsernames = Array.from(preloadUsernames).slice(0, 600)
      if (avatarWarmupUsernames.length > 0) {
        await withTimeout(() => chatService.enrichSessionsContactInfo(avatarWarmupUsernames), 15000)
      }
    }
  }

  // 等待主窗口加载完成（进度条末端呼吸光点）
  updateSplashProgress(90, '正在准备主窗口...', true)
  await new Promise<void>((resolve) => {
    if (mainWindowReady) {
      resolve()
    } else {
      mainWindow!.once('ready-to-show', () => {
        mainWindowReady = true
        resolve()
      })
    }
  })

  // 加载完成，收尾
  updateSplashProgress(100, '启动完成')
  closeSplash()

  if (!onboardingDone) {
    createOnboardingWindow()
  } else if (startInBackground && tray) {
    mainWindow?.hide()
  } else {
    mainWindow?.show()
  }

  // 依赖数据库的后台服务在窗口显示后再启动，避免与启动预热争抢数据库 worker
  messagePushService.start()

  // 初始化销售助手数据库
  try {
    // §2.40 微信号分库：升级后首次启动把 legacy 单库改名到当前账号 suffixed 库（幂等，两者共存不动）
    const startupWxid = (configService ? configService.getMyWxidCleaned() : '').trim()
    const movedDbs = migrateLegacyBusinessDbs(app.getPath('userData'), startupWxid)
    if (movedDbs.length > 0) {
      console.log('[Sales] legacy 业务库已迁移到按账号命名:', movedDbs.map((m) => `${m.kind} → ${m.to}`).join(', '))
    }
    await salesDbService.initialize(app.getPath('userData'), startupWxid)
    console.log('[Sales] 数据库初始化成功')
    salesReportService.setConfig(configService)
    morningDigestService.setConfig(configService)
    // 启动今日行动引擎
    setActionEngineConfig(configService)
    registerCrmIpcHandlers(ipcMain, configService)
    // D7 商机评测集标注（eval:* 四端点，见 evalIpcHandlers.ts）
    registerEvalIpcHandlers(ipcMain)
    // 内部人员名单（同事）：手动名单 + 内部群成员，CRM 导入自动跳过
    await crmDbService.initialize(app.getPath('userData'), startupWxid)
    try {
      const manualList = Array.from(configService.get('crmInternalList') || [])
      const groupMembers = await collectInternalGroupMembers(configService.get('crmInternalGroups'))
      const internalList = Array.from(new Set([...manualList, ...groupMembers]))
      crmDbService.setInternalList(internalList)
      console.log(`[Sales] 内部名单共 ${internalList.length} 条：${internalList.slice(0, 25).map((n) => String(n).slice(0, 20)).join(' | ')}`)
      const removed = crmDbService.removeInternalAccounts()
      if (removed > 0) console.log(`[Sales] 已清理内部人员（同事）${removed} 个 CRM 客户`)
      if (groupMembers.length > 0) console.log(`[Sales] 内部群成员 ${groupMembers.length} 个已加入排除名单`)
    } catch (e) {
      console.warn('[Sales] 内部人员名单初始化失败:', e)
    }
    // 回填导入：把往期灵感信箱里判定出销售意向的记录补导入 CRM（幂等）
    // 必须先 await crmDbService.initialize（registerCrmIpcHandlers 内是异步不等待的），否则 db 未就绪全部静默失败
    try {
      await crmDbService.initialize(app.getPath('userData'), startupWxid)
      const backfill = backfillImportFromInsightRecords(insightRecordService.getAllRecordsForBackfill())
      if (backfill.imported > 0 || backfill.existing > 0) {
        console.log(`[Sales] 灵感信箱回填导入 CRM：新建 ${backfill.imported}，已存在 ${backfill.existing}`)
      }
    } catch (e) {
      console.warn('[Sales] 灵感信箱回填导入失败:', e)
    }
    // 决策B存量处置（2026-09-03 拍板「存量重置」）：群扫线索首触期限清零 + 存量 SLA 卡关单
    // 幂等（二次执行命中 0 行）；必须在 startActionEngineScheduler 之前，防新一轮 SLA 扫描再建卡
    try {
      const reset = resetLegacyGroupScanSla()
      if (reset.leads > 0) console.log(`[Sales] 群扫存量 SLA 重置完成：${reset.leads} 条线索、${reset.cards} 张卡`)
    } catch (e) {
      console.warn('[Sales] 群扫存量 SLA 重置失败:', e)
    }
    // 宪法 §4.2 决策B 配套（2026-09-03 用户当面拍板执行）：群扫 tag 归属残留清理
    // 幂等（二次执行命中 0 行）；tag='未分配' 直接清空，其余挪 note 留痕
    try {
      const tagCleanup = cleanupLegacyGroupScanTags()
      if (tagCleanup.cleared > 0) console.log(`[Sales] 群扫存量 tag 归属清理完成：${tagCleanup.cleared} 条（${tagCleanup.noted} 条留痕）`)
    } catch (e) {
      console.warn('[Sales] 群扫存量 tag 归属清理失败:', e)
    }
    // 决策B 配套②（2026-09-03 用户拍板「恢复成正式分配」）：旧 tag 归属 → assignment
    // 杨青/李林辉 直挂，秒变→许丽娟（外号），静候=丁帅已离职留资源池；复用 assignLeads 幂等
    try {
      const restored = restoreLegacyGroupScanAssignments()
      const restoredTotal = Object.values(restored.restored).reduce((a, b) => a + b, 0)
      if (restoredTotal > 0) console.log(`[Sales] 群扫旧归属恢复完成：${JSON.stringify(restored.restored)}，留资源池 ${restored.pooled} 条`)
    } catch (e) {
      console.warn('[Sales] 群扫旧归属恢复失败:', e)
    }
    // 分配起计时上线配套（2026-09-04）：存量已分配但 sla1_deadline=NULL 的行补写 = 执行时刻 + crmLeadSlaHours
    // （⚠️ 绝不能用分配时刻当基点——在过去会立即过期，§2.54 事故）；幂等（只补 NULL 行）；
    // 必须在 startSlaRecycleScheduler 之前，防回收器一上来把存量全回收
    try {
      const filled = backfillAssignmentSla1()
      if (filled > 0) console.log(`[Sales] 存量分配行 sla1_deadline 补写完成：${filled} 条`)
    } catch (e) {
      console.warn('[Sales] 存量分配行 sla1 补写失败:', e)
    }
    // §2.54 事故纠正（一次性迁移块）：SLA1 误扫回收（actor=system:sla 的 recycled 行）补偿性再分配给原销售
    // 幂等双保险（scan_state 标记 + 数据级判重）；append-only 铁律：不改历史流水，只补补偿流水
    try {
      const corr = correctSla1Misrecycle()
      if (!corr.skippedByMarker && corr.corrected > 0) {
        console.log(`[Sales] SLA1 误扫纠正完成：补偿再分配 ${corr.corrected}/${corr.total} 条（已有有效分配跳过 ${corr.alreadyAssigned}）`)
      }
    } catch (e) {
      console.warn('[Sales] SLA1 误扫纠正失败:', e)
    }
    // 存量修复（2026-09-04）：resetLegacyGroupScanSla 旧版曾把已分配群扫 lead 期限打回哨兵
    // （已修为排除有效分配）；此处把 live 残留的不一致行对齐回当前分配行 sla1。幂等（只改不一致行）。
    try {
      syncLeadDeadlineFromAssignment()
    } catch (e) {
      console.warn('[Sales] lead 首触期限对齐失败:', e)
    }
    // Phase 1 存量迁移（PRD §9 / 宪法 §2.4）：② account→customer 挂接 + ③ lead→customer_identity 归并
    // 幂等双保险（scan_state 一次性标记 + 数据级判重）；冲突不静默（进迁移报告+audit_event，不动数据）
    // ⛔ 前置条件：live 生效前先确认自动备份有一次成功记录（autoBackupService）
    try {
      const mig = runStockDataMigration()
      const m02 = mig.m02, m03 = mig.m03
      if (!m02.skippedByMarker && (m02.applied > 0 || m02.failed > 0 || m02.conflicts > 0)) {
        console.log(`[Sales] 存量迁移②完成：挂接 ${m02.applied} account → 新建 customer ${m02.customersCreated}，失败 ${m02.failed}，冲突 ${m02.conflicts}`)
      }
      if (!m03.skippedByMarker && (m03.applied > 0 || m03.failed > 0 || m03.conflicts > 0)) {
        console.log(`[Sales] 存量迁移③完成：登记 identity ${m03.applied}，失败 ${m03.failed}，冲突 ${m03.conflicts}`)
      }
    } catch (e) {
      console.warn('[Sales] 存量迁移失败:', e)
    }
    // 自动备份（PRD 1.1 双保险定时备份）：本机 userData/backups/auto/ + 网络共享层
    // （autoBackupNetworkPath，空/不可达跳过不惊扰）；启动补跑（距上次成功 >20h 且工作时段）
    registerAutoBackupIpcHandlers(ipcMain)
    startAutoBackupScheduler({ config: configService, userData: app.getPath('userData'), appVersion: app.getVersion() })
    startActionEngineScheduler()
    // 晨间摘要（设计-AI见解重定位 §3.1）：每日 08:05-08:35 窗口生成一条「今天先跟谁」，
    // 错开 08:00 全量扫描；「今日已生成」以 report_snapshot 落库行为准，重启不重复
    morningDigestService.startScheduler()
    // SLA1 回收器（PRD 1.4 第一段「加了没有」机械计时）：status=assigned 且 sla1_deadline 过期 → 自动回收
    // （A 档引擎动作，reason='SLA超时回收'，actor='system:sla'；间隔 crmSlaRecycleIntervalMin 分钟，默认 30）
    // 角色差异（内网同步设计 §5）：回收是中枢权威动作——配置为终端（terminal）的机器不跑回收器，
    // 其分配生命周期由中枢下行 recycle 事件驱动。
    if (getLanSyncConfig().role !== 'terminal') {
      startSlaRecycleScheduler()
    } else {
      console.log('[Sales] 内网同步角色=终端：SLA1 回收器不启动（回收由中枢下行事件驱动）')
    }
    // 加好友自动检测（PRD 1.4a 自动路，保守版）：扫 assigned/claimed 未停表行，lead 的 wxid/手机号
    // 与本机 WCDB 联系人（应用读取层 chatService.getContacts，只读）精确等值匹配，命中即停表+推状态+审计；
    // WCDB 未连接/空联系人 → 本轮零副作用；间隔 crmFriendDetectIntervalMin 分钟，默认 30
    startFriendDetectScheduler(async (): Promise<ContactLite[]> => {
      const r = await chatService.getContacts({ lite: true })
      if (!r.success || !Array.isArray(r.contacts)) return []
      return r.contacts.map((c) => ({ username: String(c.username || ''), alias: c.alias, remark: c.remark, nickname: c.nickname }))
    })
    // SLA2 规则骨架扫描（PRD 1.4 第二段「聊了没有」，规则占位版）：已停表（已加好友）且 sla2_scan_ref 为空的
    // 分配行，绑定的会话在停表后若有客户回复 → 写 sla2_scan_ref（verdict='contacted'，事实判定 confidence=1.0）；
    // 真实 LLM 跟进状态判定是后续刀（结论统一走 markSla2ScanResult，出机内容先过 maskPrivateText，宪法 §2.6）。
    // 间隔 crmSla2ScanIntervalMin 分钟，默认 30；WCDB 未连接 → 该条跳过零副作用
    startSla2ScanScheduler(async (sessionId, sinceMs): Promise<Sla2MessageLite[]> => {
      // getMessages 的 startTime 自动兼容毫秒（内部 >1e10 转秒）；返回会被升序重排，规则扫描自行排序
      const r = await chatService.getMessages(sessionId, 0, 200, sinceMs)
      if (!r.success || !Array.isArray(r.messages)) return []
      // WCDB createTime 是秒 → 毫秒；归一化最小字段
      return r.messages.map((m) => ({ isSend: m.isSend, createTimeMs: Number(m.createTime || 0) * 1000, messageKey: String(m.messageKey || '') }))
    })
    // SLA2 LLM 对话扫描（屏 5 右供数补全，HANDOVER §2.57 缺口接入）：结论仍走 markSla2ScanResult 单点；
    // 出机文本已过 maskPrivateText（铁律 2）；LLM 未配置整链静默跳过。依赖注入与 chatService 解耦（可测）
    setSla2LlmScanDeps({
      getRecentMessages: async (sessionId, limit) => {
        // getMessages 默认倒序（新→旧），取最近 N 条；createTime 秒 → 毫秒归一
        const r = await chatService.getMessages(sessionId, 0, limit)
        if (!r.success || !Array.isArray(r.messages)) return []
        return r.messages.map((m) => ({
          messageKey: String(m.messageKey || ''),
          isSend: m.isSend,
          senderName: '对方',
          createTimeMs: Number(m.createTime || 0) > 1e12 ? Number(m.createTime) : Number(m.createTime || 0) * 1000,
          text: String((m as any).parsedContent || m.content || m.rawContent || '')
        }))
      },
      llm: async (system, user) => {
        // ConfigService.getInstance()（与 crmSla2Service 同款）：调度器闭包晚于模块初始化，避免空引用
        const mc = getAiModelConfig(ConfigService.getInstance())
        return callChatCompletion(mc, [{ role: 'system', content: system }, { role: 'user', content: user }], { temperature: 0.2 })
      },
      isConfigured: () => isAiConfigured(ConfigService.getInstance()),
      log: (level, message) => salesLog(level as 'INFO' | 'WARN', message)
    })
    startSla2LlmScanScheduler()
    // 付款承诺到期扫描（告警 D「承诺打款日过期」，宪法 §3 payment_promise）：每日一次，
    // 跟随周复盘定时器时段（20:00-20:30 窗口 + scan_state 每日标记防重启重扫）；到期无款
    // 经 alertService.createAlert({type:'payment_overdue'}) 四道闸（推送门默认 false 零副作用）
    startPaymentPromiseScanScheduler()
    // 启动周复盘定时器（每周日 20:00）
    startWeeklyReviewScheduler(configService)
    // 内网同步（Phase 1 最小版，设计 docs/规划/Phase1-内网同步最小版-设计.md）：
    // 未配置共享目录/角色 → 同步关闭静默跳过；中枢=下行产出+上行消费，终端=下行消费+上行产出。
    // 轮巡间隔 lanSyncPollIntervalMin 分钟（默认 1），首巡延迟 150s
    registerLanSyncIpcHandlers(ipcMain)
    startLanSyncScheduler()
    console.log('[Sales] 今日行动引擎 + 周复盘定时器已启动')
  } catch (e) {
    console.error('[Sales] 数据库初始化失败:', e)
  }

  insightService.start()
  groupSummaryService.start()
  if (configService.get('autoDownloadHighRes')) {
    const whitelistArr = configService.get('autoDownloadWhitelist') || []
    const whitelistStr = (Array.isArray(whitelistArr) && whitelistArr.length > 0)
      ? (whitelistArr.join('\0') + '\0\0')
      : ''
    imageDownloadService.startAutoDownload(whitelistStr)
  }

  // 启动时检测更新（不阻塞启动）
  checkForUpdatesOnStartup()

  await httpService.autoStart()

  app.on('activate', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (!mainWindow.isVisible()) {
        mainWindow.show()
      }
      mainWindow.focus()
      return
    }

    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow()
    }
  })
})

const shutdownAppServices = async (): Promise<void> => {
  if (shutdownPromise) return shutdownPromise
  shutdownPromise = (async () => {
    isAppQuitting = true
    // 销毁 tray 图标
    if (tray) { try { tray.destroy() } catch {} tray = null }
    // 通知窗使用 hide 而非 close，退出时主动销毁，避免残留窗口阻塞进程退出。
    destroyNotificationWindow()
    messagePushService.stop()
    insightService.stop()
    groupSummaryService.stop()
    // 兜底：5秒后强制退出，防止某个异步任务卡住导致进程残留
    const forceExitTimer = setTimeout(() => {
      console.warn('[App] Force exit after timeout')
      app.exit(0)
    }, 5000)
    forceExitTimer.unref()
    // cloudControlService removed (PRD v2)
    // 停止自动下载服务
    try { await imageDownloadService.stopAutoDownload() } catch {}
    // 停止 chatService（内部会关闭 cursor 与 DB），避免退出阶段仍触发监控回调
    try { chatService.close() } catch {}
    // 停止 HTTP 服务器，释放 TCP 端口占用，避免进程无法退出
    try { await httpService.stop() } catch {}
    // 终止 wcdb Worker 线程，避免线程阻止进程退出
    // 关闭销售助手数据库
    try { salesDbService.close() } catch {}
    try { await wcdbService.shutdown() } catch {}
  })()
  return shutdownPromise
}

app.on('before-quit', () => {
  void shutdownAppServices()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
