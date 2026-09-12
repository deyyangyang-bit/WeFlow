/**
 * autoBackupService.ts —— 自动备份 electron 侧装配（PRD 1.1 双保险定时备份）。
 * 分层：纯逻辑在 autoBackupCore.ts（零 electron，可 tsx 单测）；本文件负责
 *   ① 依赖注入（ConfigService / userData / appVersion，由 main.ts 传入，自身不 import electron）
 *   ② 备份前落盘：crm/sales 是 sql.js 内存库，写操作后 500ms 防抖落盘
 *      （crmDbService.persist / salesDbService.persist）——备份前必须 persistNowStrict/
 *      flushNowStrict 强制刷盘，任一库刷盘失败立即终止本轮备份（不生成成功 manifest、
 *      不更新成功时间、结果带 stage），绝不吞错继续备份
 *   ③ 审计：每次备份写 audit_event（action=auto_backup，成功/失败都写，宪法 §1.12）
 *   ④ 调度：每日 autoBackupTime（默认 14:37）；启动补跑——距上次成功 >20h 且在
 *      工作时段（8:00-19:00）立即补一次（防周末/关机错过）
 *   ⑤ 密钥：主备份密钥经 SecretBox（safeStorage/local-wrap）封装存放（autoBackupKeyVault.ts），
 *      明文主密钥不落盘；恢复密钥导出/导入（口令 scrypt + AES-256-GCM）支撑新机器恢复
 *   ⑥ 恢复窗口门禁：新机器真机顺序是「首次启动补跑先生成密钥与初始备份 → 用户导入旧机器
 *      恢复密钥 → 从网络备份恢复」。若期间让自动调度补跑，本机空库会成为网络层最新基线、
 *      顶掉旧机器的链，之后恢复最新有效链就会恢复出空数据。故：
 *        · 「采用恢复密钥」（新机首次恢复门禁开放 + 用户显式确认）后置位等待恢复标记
 *          （backups/auto-recovery-pending.json），自动调度（每日 tick / 启动补跑）一律拒绝；
 *        · 恢复流程执行期间（采用 / 网络恢复）recoveryRunning 硬门禁，不创建新密钥也不建新备份；
 *        · 成功网络恢复或用户主动「立即备份」清除标记，调度恢复。
 * 串行化铁律：enqueueSalesTask 只加最外层（调度 tick / 启动补跑 / IPC runNow），
 * executeAutoBackup 内部不再 enqueue。
 */
import { crmDbService } from './crmDbService'
import { salesDbService } from './salesDbService'
import { enqueueSalesTask } from './salesQueue'
import type { ConfigService } from './config'
import initSqlJs from 'sql.js'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import {
  AUTO_BACKUP_KEEP,
  autoBackupLocalRoot,
  backupDirName,
  listBackupDirs,
  readLatestManifest,
  restoreAutoBackup,
  runAutoBackup,
  type AutoBackupFailureStage,
  type AutoBackupManifest,
  type AutoBackupRestoreResult,
  type AutoBackupResult
} from './autoBackupCore'
import {
  buildRecoveryKeyExport,
  canAdoptImportedMasterKey,
  importRecoveryKeyExport,
  installImportedMasterKey,
  loadOrCreateAutoBackupKeyCore,
  localWrapSecretBox,
  readWrappedKeyOrigin,
  writeRecoveryKeyExportFile,
  type KeyOrigin,
  type RecoveryAdoptOutcome,
  type SecretBox
} from './autoBackupKeyVault'

export const AUTO_BACKUP_DEFAULT_TIME = '14:37'
/** 启动补跑阈值：距上次成功超过 20h */
const CATCHUP_STALE_MS = 20 * 60 * 60 * 1000
/** 工作时段 8:00-19:00（补跑只在该窗口内触发，深夜开机不跑） */
const WORK_START_HOUR = 8
const WORK_END_HOUR = 19
/** 调度 tick 间隔（同周复盘定时器 30min 先例，缩短到 5min 保证到点及时触发） */
const TICK_MS = 5 * 60 * 1000

export interface AutoBackupDeps {
  config: ConfigService
  userData: string
  appVersion: string
  /** 本机密钥封装设施（Electron main 传 safeStorage 适配器；缺省回退 local-wrap 并在状态中如实展示） */
  secretBox?: SecretBox
}

let deps: AutoBackupDeps | null = null
let tickTimer: NodeJS.Timeout | null = null
let bootTimer: NodeJS.Timeout | null = null
/** 防止 tick 与补跑/手动并发重入（enqueue 串行化之外的双保险） */
let running = false
/**
 * 恢复流程进行中（采用恢复密钥 / 网络恢复）：本窗口内自动调度不得创建新密钥或新备份。
 * 新机恢复顺序是「首次启动补跑生成初始备份 → 导入恢复密钥（采用并隔离）→ 从网络恢复」，
 * 若在采用与恢复之间让调度补跑一次，本机空库会作为新基线推到网络层，把旧机器的链顶掉，
 * 之后「恢复最新有效链」就会恢复出一份空数据——因此恢复期间与待恢复期间都必须暂停调度。
 */
let recoveryRunning = false

const RECOVERY_PENDING_FILENAME = 'auto-recovery-pending.json'

function recoveryPendingPath(userData: string): string {
  return join(userData, 'backups', RECOVERY_PENDING_FILENAME)
}

/** 是否处于「已采用恢复密钥、等待从网络备份恢复」状态（自动备份暂停中） */
export function isAutoBackupRecoveryPending(userData: string): boolean {
  return existsSync(recoveryPendingPath(userData))
}

/** 置位/清除等待恢复标记（成功恢复或用户主动在本机做一次备份后清除） */
function setAutoBackupRecoveryPending(userData: string, pending: boolean): void {
  const file = recoveryPendingPath(userData)
  try {
    if (pending) {
      mkdirSync(join(userData, 'backups'), { recursive: true })
      writeFileSync(file, JSON.stringify({ pendingSince: new Date().toISOString() }, null, 2), { mode: 0o600 })
    } else {
      rmSync(file, { force: true })
    }
  } catch (e) {
    console.warn('[AutoBackup] 等待恢复标记写入失败:', e)
  }
}

/**
 * 备份密钥装载：封装件（safeStorage / local-wrap）优先，旧版明文 auto-backup.key
 * 读取后立即封装迁移并粉碎删除——明文主密钥不再长期落盘。恢复密钥导出/导入见下方专用入口。
 */
export function loadOrCreateAutoBackupKey(userData: string, secretBox?: SecretBox): Buffer {
  return loadOrCreateAutoBackupKeyCore(userData, secretBox ?? localWrapSecretBox(userData))
}

/** 解析 autoBackupTime 'HH:mm'，非法值回退默认 14:37 */
export function parseAutoBackupTime(raw: unknown): { hh: number; mm: number } {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(raw || '').trim())
  if (!m) {
    const d = /^(\d+):(\d+)$/.exec(AUTO_BACKUP_DEFAULT_TIME)!
    return { hh: Number(d[1]), mm: Number(d[2]) }
  }
  return { hh: Number(m[1]), mm: Number(m[2]) }
}

/** 最近一次成功备份时间（本机层最新 manifest 的 createdAt；无备份返回 0） */
export function lastAutoBackupSuccessAt(userData: string): number {
  const m = readLatestManifest(autoBackupLocalRoot(userData))
  const t = m ? Date.parse(m.createdAt) : NaN
  return Number.isFinite(t) ? t : 0
}

/**
 * 执行一次自动备份（同步 core + 落盘 + 审计）。不 enqueue——由最外层入口串行化。
 * 失败也写审计；任何异常收进返回值，不抛出（调度器/IPC 都不该被炸）。
 * 刷盘铁律：任一业务库刷盘失败 → 立即终止本轮备份（不进 core、不生成 manifest、
 * 不更新成功时间），结果带 stage 供 UI 显示具体失败阶段；绝不吞错继续备份。
 */
export function executeAutoBackup(trigger: AutoBackupTrigger): AutoBackupResult {
  if (!deps) return { ok: false, dirName: '', manifest: {} as AutoBackupManifest, error: 'autoBackupService 未初始化' }
  // 恢复窗口硬门禁：此处是唯一会调用 loadOrCreateAutoBackupKey 的备份入口，
  // 挡住即可保证恢复流程进行中/等待恢复期间不会生成新密钥或新备份
  // （不写审计，避免污染恢复期间的审计链）
  const paused = autoBackupPauseReason(trigger)
  if (paused) return { ok: false, dirName: '', manifest: {} as AutoBackupManifest, error: paused }
  const t0 = Date.now()
  // ① 备份前强制落盘（sql.js 内存库 500ms 防抖，见文件头注释）——严格版，失败即终止
  let failedStage: AutoBackupFailureStage | null = null
  let flushError: string | null = null
  try {
    crmDbService.persistNowStrict()
  } catch (e) {
    failedStage = 'flush_crm'
    flushError = String(e)
    console.warn('[AutoBackup] crm 刷盘失败，本轮备份终止:', e)
  }
  if (!failedStage) {
    try {
      salesDbService.flushNowStrict()
    } catch (e) {
      failedStage = 'flush_sales'
      flushError = String(e)
      console.warn('[AutoBackup] sales 刷盘失败，本轮备份终止:', e)
    }
  }

  let result: AutoBackupResult
  if (failedStage) {
    result = {
      ok: false,
      dirName: '',
      manifest: {} as AutoBackupManifest,
      stage: failedStage,
      error: `备份已在刷盘阶段终止（${failedStage === 'flush_crm' ? 'CRM 库' : 'Sales 库'}落盘失败），本轮未生成任何备份：${flushError}`
    }
  } else {
    try {
      result = runAutoBackup({
        userData: deps.userData,
        networkPath: deps.config.get('autoBackupNetworkPath'),
        appVersion: deps.appVersion,
        trigger,
        key: loadOrCreateAutoBackupKey(deps.userData, deps.secretBox)
      })
    } catch (e) {
      result = { ok: false, dirName: '', manifest: {} as AutoBackupManifest, stage: 'backup', error: String(e) }
    }
  }

  // ② 审计留痕（成功/失败都写；审计失败不阻塞备份本体）
  try {
    const m = result.manifest
    crmDbService.create('audit_event', {
      actor: 'system:auto-backup',
      action: 'auto_backup',
      entity_type: 'backup',
      entity_id: 0,
      detail: JSON.stringify({
        trigger,
        ok: result.ok,
        stage: result.stage || undefined,
        dir: result.dirName || undefined,
        local: m?.layers?.local?.status,
        network: m?.layers?.network?.status,
        backupType: m?.backupType,
        baselineId: m?.baselineId,
        chainIndex: m?.chainIndex,
        tombstones: m?.tombstones?.map((t) => t.originalName),
        files: m?.files?.map((f) => `${f.originalName}:${f.plaintextLength}`),
        pruned: { local: m?.layers?.local?.pruned?.length || 0, network: m?.layers?.network?.pruned?.length || 0 },
        durationMs: m?.durationMs,
        error: result.error || m?.layers?.local?.error || undefined
      }),
      created_at: t0
    })
  } catch (e) {
    console.warn('[AutoBackup] 审计写入失败:', e)
  }

  if (result.ok) {
    console.log(`[AutoBackup] ${trigger} 备份完成：${result.dirName}（本机 ${result.manifest.layers.local.status} / 网络 ${result.manifest.layers.network.status}，${result.manifest.durationMs}ms）`)
  } else {
    console.warn(`[AutoBackup] ${trigger} 备份失败:`, result.error || result.manifest?.layers?.local?.error)
  }
  return result
}

const skipped = (error: string): AutoBackupResult => ({ ok: false, dirName: '', manifest: {} as AutoBackupManifest, error })

type AutoBackupTrigger = 'scheduled' | 'startup-catchup' | 'manual'

/**
 * 恢复窗口门禁（runGuarded 与 executeAutoBackup 共用同一判据）：
 * 返回暂停原因，null = 允许执行。manual 是用户显式动作，不受「等待恢复」限制
 * （用户主动备份 = 放弃等待中的跨机恢复，见 runAutoBackupNow）。
 */
function autoBackupPauseReason(trigger: AutoBackupTrigger): string | null {
  if (recoveryRunning) return '恢复流程进行中，本次备份已跳过'
  // 采用恢复密钥到完成网络恢复之间，自动调度不得补跑：本机空库会成为网络层最新基线，
  // 把旧机器的链顶掉，「恢复最新有效链」将恢复出一份空数据
  if (trigger !== 'manual' && deps && isAutoBackupRecoveryPending(deps.userData)) {
    return '等待从网络备份恢复，自动备份已暂停（避免本机空库覆盖旧机器备份链）'
  }
  return null
}

/** 外层入口统一包装：串行化 + 防重入 + 恢复窗口门禁（调度 tick / 启动补跑 / IPC runNow 共用） */
function runGuarded(trigger: AutoBackupTrigger): Promise<AutoBackupResult> {
  const paused = autoBackupPauseReason(trigger)
  if (paused) return Promise.resolve(skipped(paused))
  if (running) return Promise.resolve(skipped('已有备份任务在执行'))
  running = true
  return enqueueSalesTask(async () => executeAutoBackup(trigger))
    .finally(() => { running = false })
}

/**
 * 手动「立即备份」（IPC 最外层入口）。用户主动在本机备份 = 显式放弃等待中的跨机恢复，
 * 成功后退出门禁、恢复正常调度（失败则保持暂停，不误判为已放弃恢复）。
 */
export async function runAutoBackupNow(): Promise<AutoBackupResult> {
  const result = await runGuarded('manual')
  if (result.ok && deps) setAutoBackupRecoveryPending(deps.userData, false)
  return result
}

// ─── 状态查询（IPC backup:auto:status 数据源）─────────────────────────────

export interface AutoBackupStatus {
  configuredTime: string
  networkPath: string
  /** 本机备份密钥封装方式（electron-safeStorage=系统安全设施 / local-wrap-v1=降级封装） */
  keyProtection: string
  /** 最近一次备份（本机层最新 manifest 摘要；从未备份为 null） */
  last: {
    at: string
    trigger: string
    dirName: string
    local: string
    network: string
    files: Array<{ kind: string; name: string; size: number }>
    backupType: string
    baselineId: string
    chainIndex: number
    durationMs: number
  } | null
  /** 下一次计划执行时间（ISO；按 configuredTime 推算） */
  nextPlannedAt: string | null
  /** 新机恢复门禁（跨机器恢复的显式采用流程所需） */
  recovery: AutoBackupRecoveryGate
}

export function getAutoBackupStatus(): AutoBackupStatus {
  if (!deps) {
    return {
      configuredTime: AUTO_BACKUP_DEFAULT_TIME, networkPath: '', keyProtection: '', last: null, nextPlannedAt: null,
      recovery: { canAdoptRecoveryKey: false, keyOrigin: null, pending: false, localBackupDirs: 0 }
    }
  }
  const timeRaw = String(deps.config.get('autoBackupTime') || AUTO_BACKUP_DEFAULT_TIME)
  const { hh, mm } = parseAutoBackupTime(timeRaw)
  const lastManifest = readLatestManifest(autoBackupLocalRoot(deps.userData))

  const now = new Date()
  const next = new Date(now)
  next.setHours(hh, mm, 0, 0)
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1)

  return {
    configuredTime: `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`,
    networkPath: String(deps.config.get('autoBackupNetworkPath') || ''),
    keyProtection: deps.secretBox?.name ?? 'local-wrap-v1',
    last: lastManifest
      ? {
          at: lastManifest.createdAt,
          trigger: lastManifest.trigger,
          dirName: backupDirNameFromManifest(lastManifest),
          local: lastManifest.layers.local.status,
          network: lastManifest.layers.network.status,
          files: lastManifest.files.map((file) => ({ kind: file.kind, name: file.originalName, size: file.plaintextLength })),
          backupType: lastManifest.backupType,
          baselineId: lastManifest.baselineId,
          chainIndex: lastManifest.chainIndex,
          durationMs: lastManifest.durationMs
        }
      : null,
    nextPlannedAt: next.toISOString(),
    recovery: getAutoBackupRecoveryGate()
  }
}

async function validateSqliteFile(filePath: string): Promise<void> {
  const wasmCandidates = [
    join(__dirname, '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
    join(__dirname, '..', '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm')
  ]
  const wasmPath = wasmCandidates.find((path) => existsSync(path)) ?? wasmCandidates[0]
  const SQL = await initSqlJs({ locateFile: () => wasmPath })
  const db = new SQL.Database(readFileSync(filePath))
  try { db.exec('SELECT count(*) FROM sqlite_master') } finally { db.close() }
}

/**
 * 恢复备份链（省略 backupId = 最新链）。source='network' 时从配置的网络备份路径恢复——
 * 新机器场景：先导入恢复密钥（importAutoBackupRecoveryKey），再从 NAS/SMB 网络层恢复。
 * 成功后 IPC 层立即重启应用，避免旧内存库再次覆盖恢复文件。
 */
export async function restoreLatestAutoBackup(backupId?: string, source: 'local' | 'network' = 'local'): Promise<AutoBackupRestoreResult> {
  if (!deps) return { ok: false, restoredFiles: [], error: 'autoBackupService 未初始化' }
  if (recoveryRunning) return { ok: false, restoredFiles: [], error: '已有恢复任务在执行' }
  if (running) return { ok: false, restoredFiles: [], error: '已有备份任务在执行' }
  const backupRoot = source === 'network'
    ? String(deps.config.get('autoBackupNetworkPath') || '').trim()
    : autoBackupLocalRoot(deps.userData)
  if (!backupRoot) return { ok: false, restoredFiles: [], error: source === 'network' ? '未配置网络备份路径，无法从网络层恢复' : '本机备份目录不可用' }
  // 恢复期间暂停调度：既防本机空库被推成网络层新基线，也防旧内存库在替换后再写盘
  recoveryRunning = true
  running = true
  try {
    const result = await enqueueSalesTask(async () => {
      try { crmDbService.persistNow() } catch (e) { console.warn('[AutoBackup] 恢复前 crm 刷盘失败（继续恢复，恢复件以备份为准）:', e) }
      try { salesDbService.flushNow() } catch (e) { console.warn('[AutoBackup] 恢复前 sales 刷盘失败（继续恢复，恢复件以备份为准）:', e) }
      return restoreAutoBackup({
        backupRoot,
        targetUserData: deps!.userData,
        key: loadOrCreateAutoBackupKey(deps!.userData, deps!.secretBox),
        backupId,
        validateDatabase: validateSqliteFile
      })
    })
    // 恢复成功 = 跨机恢复已落地，解除「等待恢复」门禁，自动备份恢复正常
    if (result.ok) setAutoBackupRecoveryPending(deps.userData, false)
    return result
  } catch (error) {
    return { ok: false, restoredFiles: [], error: String(error) }
  } finally {
    running = false
    recoveryRunning = false
  }
}

// ─── 恢复密钥导出/导入（跨机器恢复凭证；口令 scrypt + AES-256-GCM 封装主密钥）───

export interface RecoveryKeyExportOutcome { filePath: string; fingerprint: string }

/** 导出恢复密钥到指定文件（口令加密；文件不含明文主密钥） */
export function exportAutoBackupRecoveryKey(filePath: string, passphrase: string): RecoveryKeyExportOutcome {
  if (!deps) throw new Error('autoBackupService 未初始化')
  if (!filePath) throw new Error('缺少恢复密钥导出路径')
  const masterKey = loadOrCreateAutoBackupKey(deps.userData, deps.secretBox)
  const doc = buildRecoveryKeyExport(masterKey, passphrase)
  writeRecoveryKeyExportFile(filePath, doc)
  return { filePath, fingerprint: doc.keyFingerprint }
}

/**
 * 导入恢复密钥文件：口令错误明确失败且不动本机密钥；本机已有不同密钥默认拒绝覆盖。
 * opts.adopt=true（仅新机首次恢复门禁开放时可用，由用户在 UI 显式确认）→ 采用：
 * 本机旧密钥与本地备份链先整体移入隔离目录（可恢复），再安装导入密钥，并进入「等待恢复」暂停调度。
 * 注：local-wrap 环境下这里的 box 闭包持旧包装密钥，而 auto-backup.wrap 会被采用流程一起隔离——
 * 由 installImportedMasterKey 内部为新环境重建包装密钥，勿在此处改成复用同一个 box。
 */
export function importAutoBackupRecoveryKey(
  filePath: string,
  passphrase: string,
  opts?: { adopt?: boolean }
): RecoveryAdoptOutcome {
  if (!deps) throw new Error('autoBackupService 未初始化')
  const doc = importRecoveryKeyExport(readFileSync(filePath), passphrase)
  recoveryRunning = true
  try {
    const outcome = installImportedMasterKey(
      deps.userData,
      doc.masterKey,
      deps.secretBox ?? localWrapSecretBox(deps.userData),
      { adopt: opts?.adopt === true }
    )
    if (outcome.status === 'adopted') setAutoBackupRecoveryPending(deps.userData, true)
    return outcome
  } finally {
    recoveryRunning = false
  }
}

/** 新机首次恢复门禁状态（UI 据此决定「导入恢复密钥」是否走显式采用确认） */
export interface AutoBackupRecoveryGate {
  /** 门禁开放：本机密钥为首次启动自动生成，允许显式采用恢复密钥（旧密钥与旧备份将被隔离而非删除） */
  canAdoptRecoveryKey: boolean
  /** 本机主密钥来源；null = 无封装件或来源不明（视为门禁关闭） */
  keyOrigin: KeyOrigin | null
  /** 等待从网络备份恢复中（自动备份已暂停） */
  pending: boolean
  /** 本机现有备份目录数（采用恢复密钥时会被整体移入隔离目录） */
  localBackupDirs: number
}

export function getAutoBackupRecoveryGate(): AutoBackupRecoveryGate {
  if (!deps) return { canAdoptRecoveryKey: false, keyOrigin: null, pending: false, localBackupDirs: 0 }
  return {
    canAdoptRecoveryKey: canAdoptImportedMasterKey(deps.userData),
    keyOrigin: readWrappedKeyOrigin(deps.userData),
    pending: isAutoBackupRecoveryPending(deps.userData),
    localBackupDirs: listBackupDirs(autoBackupLocalRoot(deps.userData)).length
  }
}

function backupDirNameFromManifest(m: AutoBackupManifest): string {
  return backupDirName(new Date(m.createdAt))
}

// ─── 调度器 ────────────────────────────────────────────────────────────────

/** 启动补跑：距上次成功 >20h 且当前在工作时段（8:00-19:00）→ 立即补跑一次 */
function maybeCatchUp(): void {
  if (!deps) return
  if (recoveryRunning || isAutoBackupRecoveryPending(deps.userData)) return
  const now = Date.now()
  const hour = new Date(now).getHours()
  const last = lastAutoBackupSuccessAt(deps.userData)
  if (now - last > CATCHUP_STALE_MS && hour >= WORK_START_HOUR && hour < WORK_END_HOUR) {
    console.log(`[AutoBackup] 距上次备份 ${Math.round((now - last) / 3600000)}h，工作时段内补跑`)
    void runGuarded('startup-catchup')
  }
}

/** 每日到点检查：now >= 今日计划时刻 且 上次成功 < 今日计划时刻 → 跑 */
function tick(): void {
  if (!deps) return
  if (recoveryRunning || isAutoBackupRecoveryPending(deps.userData)) return
  const now = new Date()
  const { hh, mm } = parseAutoBackupTime(deps.config.get('autoBackupTime'))
  const scheduled = new Date(now)
  scheduled.setHours(hh, mm, 0, 0)
  if (now.getTime() >= scheduled.getTime() && lastAutoBackupSuccessAt(deps.userData) < scheduled.getTime()) {
    void runGuarded('scheduled')
  }
}

/**
 * 注入依赖（幂等赋值）。main.ts 走 startAutoBackupScheduler（内含本调用）；
 * 测试脚本（scripts/auto-backup-test.ts）只需执行入口、不要定时器时直接调本函数。
 */
export function initAutoBackup(d: AutoBackupDeps): void {
  deps = d
}

/**
 * 启动自动备份调度器（main.ts 启动链路调用，放 SLA 存量处置之后）。
 * 幂等：重复调用直接返回。
 */
export function startAutoBackupScheduler(d: AutoBackupDeps): void {
  if (tickTimer) return
  initAutoBackup(d)
  // 启动补跑延迟 10s：让启动链路（迁移/扫描/落盘）先收尾，避免与预热争抢
  bootTimer = setTimeout(() => { try { maybeCatchUp() } catch (e) { console.warn('[AutoBackup] 启动补跑检查失败:', e) } }, 10 * 1000)
  if (bootTimer.unref) bootTimer.unref()
  tickTimer = setInterval(() => { try { tick() } catch (e) { console.warn('[AutoBackup] 定时检查失败:', e) } }, TICK_MS)
  if (tickTimer.unref) tickTimer.unref()
  console.log(`[AutoBackup] 调度器已启动（每日 ${String(d.config.get('autoBackupTime') || AUTO_BACKUP_DEFAULT_TIME)}，保留 ${AUTO_BACKUP_KEEP} 份）`)
}
