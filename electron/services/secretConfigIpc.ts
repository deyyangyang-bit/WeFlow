/**
 * secretConfigIpc.ts —— 用户录入秘密的专用 IPC + 账号切换主进程能力（H2）
 *
 * 设计（与 rendererConfigPolicy 配套）：
 *   - **写入**：secret:set* 端点接收新值（''/null = 清除），经 ConfigService 落库
 *     （safe:/lock: 加密在 config.ts 内完成）。
 *   - **读取**：secret:status 只返回 hasValue / maskedValue 等非秘密状态；**已保存的完整秘密
 *     永不回传渲染层**。设置页编辑采用「留空表示不修改 + 显式清除」。
 *   - **wxidConfigs**：整包（含密钥）永不回到渲染层；账号切换由 account:switchTo 在主进程
 *     依已保存配置执行（主进程读密钥 → 写全局键 → 切业务库），自动连接由 account:applySavedKey
 *     判断并落地。删除配置返回内存态 undo token（会话内、有上限与 TTL），撤回不经渲染层保钥。
 * 全部执行体导出为纯函数（config 注入），注册函数只做 ipcMain 布线——测试无需 Electron。
 */
import type { ConfigService } from './config'

// ── 状态 ─────────────────────────────────────────────────────────────────────

export interface SecretStatus {
  hasValue: boolean
  /** 掩码展示（•••• + 末 4 位）；空值时为 '' */
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

/** 掩码：短值全掩，长值保末 4 位；不泄漏长度以外的内容 */
export function maskSecret(value: unknown): string {
  const s = String(value || '')
  if (!s) return ''
  if (s.length <= 8) return '••••••'
  return `••••••${s.slice(-4)}`
}

function statusOf(value: unknown): SecretStatus {
  const has = typeof value === 'string' ? value.length > 0 : value !== 0 && value !== null && value !== undefined
  return { hasValue: has, masked: has ? maskSecret(value) : '' }
}

interface WxidConfigEntry { decryptKey?: string; imageAesKey?: string; imageXorKey?: number; updatedAt?: number }

function wxidStatusOf(cfg: WxidConfigEntry | undefined): WxidSecretStatus {
  return {
    hasDecryptKey: Boolean(cfg?.decryptKey),
    hasImageXorKey: Number(cfg?.imageXorKey ?? 0) > 0,
    hasImageAesKey: Boolean(cfg?.imageAesKey),
    updatedAt: Number(cfg?.updatedAt || 0)
  }
}

export function buildSecretStatusReport(config: ConfigService): SecretStatusReport {
  const wxidRaw = config.get('wxidConfigs') as Record<string, WxidConfigEntry> | undefined
  const wxidConfigs: Record<string, WxidSecretStatus> = {}
  for (const [wxid, cfg] of Object.entries(wxidRaw || {})) {
    wxidConfigs[wxid] = wxidStatusOf(cfg)
  }
  return {
    dbKey: statusOf(config.get('decryptKey')),
    imageXorKey: statusOf(Number(config.get('imageXorKey') || 0)),
    imageAesKey: statusOf(config.get('imageAesKey')),
    httpApiToken: statusOf(config.get('httpApiToken')),
    aiModelApiKey: statusOf(config.get('aiModelApiKey')),
    weiboCookie: statusOf(config.get('aiInsightWeiboCookie')),
    telegramToken: statusOf(config.get('aiInsightTelegramToken')),
    wecomWebhook: statusOf(config.get('aiInsightWecomWebhook')),
    wxidConfigs
  }
}

// ── 写入（专用端点执行体）───────────────────────────────────────────────────

/** 设置/清除数据库解密密钥；'' = 清除。返回非秘密状态 */
export function secretSetDbKey(config: ConfigService, value: string): SecretStatus {
  config.set('decryptKey', String(value ?? ''))
  return statusOf(config.get('decryptKey'))
}

export interface ImageKeysPatch {
  /** 数字或 null（清除）；undefined = 不修改 */
  xorKey?: number | null
  /** 新 AES 密钥；'' 或 null = 清除；undefined = 不修改 */
  aesKey?: string | null
}

export function secretSetImageKeys(config: ConfigService, patch: ImageKeysPatch): { imageXorKey: SecretStatus; imageAesKey: SecretStatus } {
  if (patch.xorKey !== undefined) {
    config.set('imageXorKey', patch.xorKey === null ? 0 : Number(patch.xorKey) || 0)
  }
  if (patch.aesKey !== undefined) {
    config.set('imageAesKey', String(patch.aesKey ?? ''))
  }
  return {
    imageXorKey: statusOf(Number(config.get('imageXorKey') || 0)),
    imageAesKey: statusOf(config.get('imageAesKey'))
  }
}

export function secretSetHttpApiToken(config: ConfigService, value: string): SecretStatus {
  config.set('httpApiToken', String(value ?? ''))
  return statusOf(config.get('httpApiToken'))
}

export function secretSetAiModelApiKey(config: ConfigService, value: string): SecretStatus {
  config.set('aiModelApiKey', String(value ?? ''))
  return statusOf(config.get('aiModelApiKey'))
}

/** 设置/清除 Telegram Bot Token；'' = 清除。只写不回显（P1a） */
export function secretSetTelegramToken(config: ConfigService, value: string): SecretStatus {
  config.set('aiInsightTelegramToken', String(value ?? ''))
  return statusOf(config.get('aiInsightTelegramToken'))
}

/** 设置/清除企业微信 Webhook（内含 key= 密钥）；'' = 清除。只写不回显（P1a） */
export function secretSetWecomWebhook(config: ConfigService, value: string): SecretStatus {
  config.set('aiInsightWecomWebhook', String(value ?? ''))
  return statusOf(config.get('aiInsightWecomWebhook'))
}

// ── 服务地址专用端点（P0）───────────────────────────────────────────────────
// aiModelApiBaseUrl / aiInsightApiBaseUrl / centralSyncBaseUrl / dbPath 不再经通用 config:set；
// 地址变化时主进程**原子清除**对应凭据，旧凭据永不发往变更后的 origin。

export interface ServiceAddressResult {
  changed: boolean
  url: string
  /** 地址变化后对应凭据已被清除（要求重新录入/重新绑定） */
  credentialsCleared: boolean
  apiKey?: SecretStatus
}

/**
 * 服务地址归一与校验：只允许 http/https；生产远端强制 HTTPS；
 * localhost 开发例外与中央客户端规则一致（centralSyncClient：127.0.0.1 / localhost / ::1 允许 http）。
 */
export function normalizeServiceUrl(raw: string, opts: { field: string; allowLocalHttp?: boolean }): string {
  const trimmed = String(raw || '').trim().replace(/\/+$/, '')
  if (!trimmed) return ''
  let parsed: URL
  try { parsed = new URL(trimmed) } catch { throw new Error(`${opts.field} 不是合法 URL`) }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${opts.field} 仅支持 http/https 协议`)
  }
  const isLocal = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(parsed.hostname)
  if (parsed.protocol === 'http:' && !isLocal) {
    throw new Error(`${opts.field} 生产远端必须使用 HTTPS（仅 localhost 开发态允许 HTTP）`)
  }
  if (opts.allowLocalHttp === false && parsed.protocol === 'http:' && isLocal) {
    throw new Error(`${opts.field} 不允许 HTTP（含 localhost）`)
  }
  return trimmed
}

/** AI 通用服务地址变化 → 原子清除 aiModelApiKey 与旧 aiInsightApiKey（迁移种子） */
export function serviceSetAiModelBaseUrl(config: ConfigService, rawUrl: string): ServiceAddressResult {
  const url = normalizeServiceUrl(rawUrl, { field: 'AI 服务地址' })
  const prev = normalizeServiceUrl(String(config.get('aiModelApiBaseUrl') || ''), { field: 'AI 服务地址' })
  const changed = url !== prev
  if (changed) {
    // P1：单次持久化完成「清凭据 + 写新地址」（凭据条目在前，安全顺序语义）
    config.setMany([
      ['aiModelApiKey', ''],
      ['aiInsightApiKey', ''],
      ['aiModelApiBaseUrl', url]
    ])
  } else {
    config.set('aiModelApiBaseUrl', url)
  }
  return { changed, url, credentialsCleared: changed, apiKey: statusOf(config.get('aiModelApiKey')) }
}

/** 旧「AI 见解」独立地址变化 → 原子清除 aiInsightApiKey */
export function serviceSetAiInsightBaseUrl(config: ConfigService, rawUrl: string): ServiceAddressResult {
  const url = normalizeServiceUrl(rawUrl, { field: 'AI 见解服务地址' })
  const prev = normalizeServiceUrl(String(config.get('aiInsightApiBaseUrl') || ''), { field: 'AI 见解服务地址' })
  const changed = url !== prev
  if (changed) {
    config.setMany([
      ['aiInsightApiKey', ''],
      ['aiInsightApiBaseUrl', url]
    ])
  } else {
    config.set('aiInsightApiBaseUrl', url)
  }
  return { changed, url, credentialsCleared: changed }
}

/**
 * 中央服务地址变化 → 原子清除设备令牌与全部绑定身份状态（要求重新绑定）。
 * 清理清单是中央地址切换的**唯一**实现（claim 入口复用，不复制第二套）；
 * `centralSyncEnabled` 一并清除——绑定已随地址失效，调度不得停留在可发送状态。
 */
export function serviceSetCentralSyncBaseUrl(config: ConfigService, rawUrl: string): ServiceAddressResult {
  const url = normalizeServiceUrl(rawUrl, { field: '中央服务地址' })
  const prev = normalizeServiceUrl(String(config.get('centralSyncBaseUrl') || ''), { field: '中央服务地址' })
  const changed = url !== prev
  if (changed) {
    // P1：单次持久化；**凭据条目在前、新地址条目最后**（安全顺序语义）
    config.setMany([
      ['centralSyncDeviceToken', ''],
      ['centralSyncWorkspaceId', ''],
      ['centralSyncEmployeeId', ''],
      ['centralSyncDeviceId', ''],
      ['centralSyncRole', ''],
      ['centralSyncDisplayName', ''],
      ['centralSyncLastError', ''],
      ['centralSyncLastErrorAt', 0],
      ['centralSyncEnabled', false],
      ['centralSyncBaseUrl', url]
    ])
  } else {
    config.set('centralSyncBaseUrl', url)
  }
  return { changed, url, credentialsCleared: changed }
}

/**
 * 通用中央绑定入口（centralsync:claim）携带新 baseUrl 时复用同一份地址切换语义。
 * P0 修复：只要规范化后 `url !== prev` 就触发清理——**prev 为空但绑定字段有残留**
 * （历史脏数据/半次解绑）同样必须清掉旧令牌，否则 claim 失败或并发调度时旧 token
 * 会被发往新 origin。绝不复制第二套清理清单。
 */
export function serviceApplyCentralBaseUrlForClaim(config: ConfigService, rawUrl: string): { url: string; credentialsCleared: boolean } {
  const url = normalizeServiceUrl(rawUrl, { field: '中央服务地址' })
  const prev = normalizeServiceUrl(String(config.get('centralSyncBaseUrl') || ''), { field: '中央服务地址' })
  if (url !== prev) {
    const result = serviceSetCentralSyncBaseUrl(config, url)
    return { url, credentialsCleared: result.credentialsCleared }
  }
  return { url, credentialsCleared: false }
}

// ── dbPath 专用端点（P0）：只接受对话框批准路径或主进程验证过的自动检测路径 ──

export type DialogGrantCheck = (path: string, expect: 'dir' | 'file') => { ok: true } | { ok: false; reason: string }

/** 对话框批准路径 → 写入 dbPath（渲染层传来的路径必须在本会话被原生对话框批准过） */
export function dbPathSetFromDialog(config: ConfigService, path: string, checkGrant: DialogGrantCheck): { ok: boolean; path?: string; reason?: string } {
  const trimmed = String(path || '').trim()
  if (!trimmed) return { ok: false, reason: '路径为空' }
  const grant = checkGrant(trimmed, 'dir')
  if (!grant.ok) return { ok: false, reason: '该目录未经本会话文件对话框批准，请重新选择' }
  config.set('dbPath', trimmed)
  return { ok: true, path: trimmed }
}

/** 主进程自动检测结果 → 写入 dbPath（path 必须与主进程本次检测一致，不接受渲染层任意路径） */
export function dbPathSetVerified(config: ConfigService, path: string, verify: (p: string) => { ok: boolean; reason?: string }): { ok: boolean; path?: string; reason?: string } {
  const trimmed = String(path || '').trim()
  if (!trimmed) return { ok: false, reason: '路径为空' }
  const verdict = verify(trimmed)
  if (!verdict.ok) return { ok: false, reason: verdict.reason || '路径未通过主进程验证' }
  config.set('dbPath', trimmed)
  return { ok: true, path: trimmed }
}

export interface WxidSecretPatch {
  decryptKey?: string | null
  imageAesKey?: string | null
  imageXorKey?: number | null
}

/** 写单个 wxid 配置（undefined = 该字段不修改；null/'' = 清除）；主进程合并后整包加密落库 */
export function secretSetWxidConfig(config: ConfigService, wxid: string, patch: WxidSecretPatch): WxidSecretStatus {
  const key = String(wxid || '').trim()
  if (!key) throw new Error('wxid 不能为空')
  const current = (config.get('wxidConfigs') as Record<string, WxidConfigEntry>) || {}
  const prev: WxidConfigEntry = { ...(current[key] || {}) }
  if (patch.decryptKey !== undefined) prev.decryptKey = String(patch.decryptKey ?? '')
  if (patch.imageAesKey !== undefined) prev.imageAesKey = String(patch.imageAesKey ?? '')
  if (patch.imageXorKey !== undefined) prev.imageXorKey = patch.imageXorKey === null ? 0 : Number(patch.imageXorKey) || 0
  prev.updatedAt = Date.now()
  config.set('wxidConfigs', { ...current, [key]: prev })
  return wxidStatusOf(prev)
}

// ── 账号切换 / 删除 / 撤回（主进程能力）─────────────────────────────────────

export function normalizeWxidKey(value: string): string {
  const trimmed = String(value || '').trim()
  if (!trimmed) return ''
  if (trimmed.toLowerCase().startsWith('wxid_')) {
    const m = trimmed.match(/^(wxid_[^_]+)/i)
    return m ? m[1] : trimmed
  }
  const suffix = trimmed.match(/^(.+)_([a-zA-Z0-9]{4})$/)
  return suffix ? suffix[1] : trimmed
}

function findWxidConfigKey(config: ConfigService, wxid: string): string | null {
  const entries = Object.entries((config.get('wxidConfigs') as Record<string, WxidConfigEntry>) || {})
  const target = normalizeWxidKey(wxid)
  const hit = entries.find(([k]) => k === wxid || (target && normalizeWxidKey(k) === target))
  return hit ? hit[0] : null
}

export interface AccountSwitchDeps {
  /** myWxid 变化后的业务库切换（main.ts 注入；缺省跳过） */
  switchBusinessDbs?: (wxid: string) => Promise<void>
  onAccountChanged?: () => void
}

/**
 * 账号切换：主进程读取该 wxid 的已保存密钥 → 写入全局密钥位 → 切业务库。
 * 密钥值全程不经过渲染层；无该账号配置时返回 ok:false。
 */
export async function accountSwitchTo(config: ConfigService, wxid: string, deps: AccountSwitchDeps = {}): Promise<{ ok: boolean; reason?: string }> {
  const storedKey = findWxidConfigKey(config, String(wxid || ''))
  if (!storedKey) return { ok: false, reason: `账号「${String(wxid || '')}」没有已保存的配置` }
  const entries = (config.get('wxidConfigs') as Record<string, WxidConfigEntry>) || {}
  const cfg = entries[storedKey] || {}
  config.set('decryptKey', String(cfg.decryptKey || ''))
  config.set('imageXorKey', Number(cfg.imageXorKey ?? 0) || 0)
  config.set('imageAesKey', String(cfg.imageAesKey || ''))
  config.set('myWxid', storedKey)
  if (deps.switchBusinessDbs) await deps.switchBusinessDbs(config.getMyWxidCleaned() || '')
  if (deps.onAccountChanged) deps.onAccountChanged()
  return { ok: true }
}

export interface AutoConnectStatus {
  hasDbPath: boolean
  hasKey: boolean
  myWxid: string
  onboardingDone: boolean
  /** 本次调用是否从 wxidConfigs 把已保存密钥应用到了全局密钥位（主进程内完成） */
  appliedSavedKey: boolean
}

/** 自动连接前置：主进程依已保存配置判断并落地（wxidConfigs 的密钥不发给渲染层） */
export function accountApplySavedKey(config: ConfigService): AutoConnectStatus {
  const myWxid = String(config.get('myWxid') || '').trim()
  const dbPath = String(config.get('dbPath') || '').trim()
  const onboardingDone = config.get('onboardingDone') === true
  const storedKey = myWxid ? findWxidConfigKey(config, myWxid) : null
  let appliedSavedKey = false
  if (storedKey) {
    const entries = (config.get('wxidConfigs') as Record<string, WxidConfigEntry>) || {}
    const saved = String(entries[storedKey]?.decryptKey || '')
    if (saved) {
      const globalKey = String(config.get('decryptKey') || '')
      if (globalKey !== saved) {
        config.set('decryptKey', saved)
      }
      appliedSavedKey = true
    }
  }
  return {
    hasDbPath: Boolean(dbPath),
    hasKey: Boolean(String(config.get('decryptKey') || '')),
    myWxid: config.getMyWxidCleaned() || myWxid,
    onboardingDone,
    appliedSavedKey
  }
}

// ── 删除配置 + 会话内撤回（密钥快照只在主进程内存）───────────────────────────

const UNDO_TTL_MS = 30 * 60 * 1000
const UNDO_MAX = 20

interface WxidUndoEntry { entries: Array<[string, WxidConfigEntry]>; createdAt: number }

const wxidUndoStore = new Map<string, WxidUndoEntry>()

export function resetWxidUndoStoreForTest(): void {
  wxidUndoStore.clear()
}

/** 删除某 wxid 的全部配置（精确 + 归一化匹配）；返回撤销 token（主进程内存快照） */
export function accountRemoveWxidConfig(config: ConfigService, wxid: string): { ok: boolean; removed: number; undoToken?: string } {
  const current = (config.get('wxidConfigs') as Record<string, WxidConfigEntry>) || {}
  const target = normalizeWxidKey(wxid)
  const matchedKeys = Object.keys(current).filter((k) => k === wxid || (target && normalizeWxidKey(k) === target))
  if (matchedKeys.length === 0) return { ok: false, removed: 0 }
  const removedEntries: Array<[string, WxidConfigEntry]> = matchedKeys.map((k) => [k, current[k]])
  const next: Record<string, WxidConfigEntry> = {}
  for (const [k, v] of Object.entries(current)) {
    if (!matchedKeys.includes(k)) next[k] = v
  }
  config.set('wxidConfigs', next)
  const token = `wxid-undo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  wxidUndoStore.set(token, { entries: removedEntries, createdAt: Date.now() })
  // 淘汰过期与超量
  for (const [t, e] of wxidUndoStore) {
    if (Date.now() - e.createdAt > UNDO_TTL_MS) wxidUndoStore.delete(t)
  }
  while (wxidUndoStore.size > UNDO_MAX) {
    const oldest = [...wxidUndoStore.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0]
    if (!oldest) break
    wxidUndoStore.delete(oldest[0])
  }
  return { ok: true, removed: matchedKeys.length, undoToken: token }
}

/** 撤回删除：按 token 恢复主进程内存里的配置快照（密钥不经过渲染层往返） */
export function accountUndoRemoveWxidConfig(config: ConfigService, token: string): { ok: boolean; restored: number } {
  const entry = wxidUndoStore.get(String(token || ''))
  if (!entry) return { ok: false, restored: 0 }
  wxidUndoStore.delete(String(token || ''))
  const current = (config.get('wxidConfigs') as Record<string, WxidConfigEntry>) || {}
  const next: Record<string, WxidConfigEntry> = { ...current }
  for (const [k, v] of entry.entries) next[k] = v
  config.set('wxidConfigs', next)
  return { ok: true, restored: entry.entries.length }
}

/** 清空当前账号密钥位（删除当前账号且无其他可用配置时使用） */
export function accountClearCurrentKeys(config: ConfigService): void {
  config.set('decryptKey', '')
  config.set('imageXorKey', 0)
  config.set('imageAesKey', '')
}

// ── IPC 布线 ────────────────────────────────────────────────────────────────

type IpcMainLike = { handle(channel: string, listener: (...args: any[]) => unknown): void }

export interface SecretIpcDeps extends AccountSwitchDeps {
  /** dbPath 对话框批准校验（main.ts 注入 exportPathAuthorizer.check；P0） */
  checkDialogGrant?: DialogGrantCheck
  /** dbPath 主进程验证回调（main.ts 注入：如与 autoDetect 结果一致），防止该端点成为任意路径口子 */
  verifyDbPath?: (p: string) => { ok: boolean; reason?: string }
}

export function registerSecretConfigIpc(
  ipcMain: IpcMainLike,
  config: () => ConfigService,
  deps: SecretIpcDeps = {}
): void {
  ipcMain.handle('secret:status', () => buildSecretStatusReport(config()))
  ipcMain.handle('secret:setDbKey', (_: unknown, value: string) => secretSetDbKey(config(), String(value ?? '')))
  ipcMain.handle('secret:setImageKeys', (_: unknown, patch: ImageKeysPatch) => secretSetImageKeys(config(), patch || {}))
  ipcMain.handle('secret:setHttpApiToken', (_: unknown, value: string) => secretSetHttpApiToken(config(), String(value ?? '')))
  ipcMain.handle('secret:setAiModelApiKey', (_: unknown, value: string) => secretSetAiModelApiKey(config(), String(value ?? '')))
  ipcMain.handle('secret:setTelegramToken', (_: unknown, value: string) => secretSetTelegramToken(config(), String(value ?? '')))
  ipcMain.handle('secret:setWecomWebhook', (_: unknown, value: string) => secretSetWecomWebhook(config(), String(value ?? '')))
  ipcMain.handle('secret:setWxidConfig', (_: unknown, wxid: string, patch: WxidSecretPatch) =>
    secretSetWxidConfig(config(), String(wxid || ''), patch || {}))
  ipcMain.handle('secret:removeWxidConfig', (_: unknown, wxid: string) => accountRemoveWxidConfig(config(), String(wxid || '')))
  ipcMain.handle('secret:undoRemoveWxidConfig', (_: unknown, token: string) => accountUndoRemoveWxidConfig(config(), String(token || '')))
  ipcMain.handle('account:switchTo', async (_: unknown, wxid: string) => accountSwitchTo(config(), String(wxid || ''), deps))
  ipcMain.handle('account:applySavedKey', () => accountApplySavedKey(config()))
  // P0：受限服务地址专用端点（地址变化原子清除对应凭据）
  ipcMain.handle('serviceaddr:setAiModelBaseUrl', (_: unknown, url: string) => {
    try { return { ok: true, ...serviceSetAiModelBaseUrl(config(), String(url ?? '')) } }
    catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) } }
  })
  ipcMain.handle('serviceaddr:setAiInsightBaseUrl', (_: unknown, url: string) => {
    try { return { ok: true, ...serviceSetAiInsightBaseUrl(config(), String(url ?? '')) } }
    catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) } }
  })
  ipcMain.handle('serviceaddr:setCentralSyncBaseUrl', (_: unknown, url: string) => {
    try { return { ok: true, ...serviceSetCentralSyncBaseUrl(config(), String(url ?? '')) } }
    catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) } }
  })
  ipcMain.handle('dbpath:setFromDialog', (_: unknown, path: string) => {
    if (!deps.checkDialogGrant) return { ok: false, reason: '对话框授权校验不可用' }
    return dbPathSetFromDialog(config(), String(path ?? ''), deps.checkDialogGrant)
  })
  ipcMain.handle('dbpath:setVerified', (_: unknown, path: string) => {
    // 主进程验证过的专用路径设置接口：验证回调由 main.ts 注入（如 autoDetect 结果一致性），
    // 本端点自身不做弱校验，防止退化为任意路径写入口。
    if (!deps.verifyDbPath) return { ok: false, reason: '主进程路径验证不可用' }
    return dbPathSetVerified(config(), String(path ?? ''), deps.verifyDbPath)
  })
}
