/**
 * autoBackupCore.ts —— PRD v3.4 §1.1 加密全量/逻辑增量备份核心。
 * 零 Electron 依赖；负责多业务库发现、AES-256-GCM、链验证、恢复和安全轮转。
 *
 * 网络层写入前有「异密钥预检」（findForeignBackupDirs）：根目录若存在无法用当前主密钥通过
 * manifest HMAC + 结构 + 节点验证的备份，本轮网络层直接失败且网络目录零改动（不回填旧节点、
 * 不建新目录、不写 manifest、不轮转删除）。防的是新机在导入恢复密钥之前就把网络路径指向旧机
 * 共享目录、把本机新密钥的空基线写进去，导致 restoreAutoBackup 整根校验永久失败。
 */
import {
  closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync,
  readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync
} from 'fs'
import { basename, dirname, join } from 'path'
import {
  createCipheriv, createDecipheriv, createHash, createHmac,
  randomBytes, randomUUID, timingSafeEqual
} from 'crypto'
import { discoverBusinessDbs, type BusinessDbKind } from './businessDbPath'

export const AUTO_BACKUP_DIR_PREFIX = 'we-flow-auto-'
export const AUTO_BACKUP_KEEP = 20
export const AUTO_BACKUP_FORMAT_VERSION = 2
const CIPHER_ALGORITHM = 'aes-256-gcm' as const

export type AutoBackupType = 'full' | 'incremental'
export type AutoBackupLayerStatus = 'ok' | 'skipped_not_configured' | 'skipped_unreachable' | 'failed'

export interface AutoBackupLayerResult {
  status: AutoBackupLayerStatus
  dir?: string
  pruned?: string[]
  error?: string
}

export interface AutoBackupFileEntry {
  kind: BusinessDbKind
  /** 兼容旧状态/启动保护读取；等同 originalName。 */
  name: string
  /** 兼容旧状态读取；等同 plaintextLength。 */
  size: number
  logicalName: string
  originalName: string
  originalRelativePath: string
  artifactName: string
  plaintextLength: number
  sha256: string
  algorithm: typeof CIPHER_ALGORITHM
  nonce: string
  tag: string
  accountSafeId: string
}

/** 删除墓碑：本节点确认「该逻辑库在备份时点已不存在」，恢复链必须应用，禁止复活 */
export interface AutoBackupTombstone {
  logicalName: string
  /** 被删除库的原始文件名（恢复阶段用于清理目标目录同名残留） */
  originalName: string
  deletedAt: string
}

export interface AutoBackupManifest {
  formatVersion: number
  app: string
  backupId: string
  backupType: AutoBackupType
  createdAt: string
  trigger: string
  baselineId: string
  previousBackupId: string | null
  chainIndex: number
  files: AutoBackupFileEntry[]
  /**
   * 删除墓碑（增量节点）。
   * ⚠️ 兼容说明：字段在早期 v2 产物中不存在，读侧 HMAC 校验通过后归一化为 []（不得在校验前改写对象）。
   */
  tombstones?: AutoBackupTombstone[]
  missing: BusinessDbKind[]
  layers: { local: AutoBackupLayerResult; network: AutoBackupLayerResult }
  durationMs: number
  manifestAuth: { algorithm: 'hmac-sha256'; digest: string }
}

export interface AutoBackupOptions {
  userData: string
  networkPath?: string
  appVersion: string
  trigger?: string
  keep?: number
  now?: Date
  key: Buffer
  backupType?: AutoBackupType
}

/** 失败阶段（结果/审计/UI 透出：刷盘或备份本体，UI 据此显示具体环节） */
export type AutoBackupFailureStage = 'flush_crm' | 'flush_sales' | 'backup'

export interface AutoBackupResult {
  ok: boolean
  dirName: string
  manifest: AutoBackupManifest
  error?: string
  stage?: AutoBackupFailureStage
  networkError?: string
}

export interface AutoBackupRestoreOptions {
  backupRoot: string
  targetUserData: string
  key: Buffer
  backupId?: string
  validateDatabase: (filePath: string) => void | Promise<void>
  now?: Date
}

export interface AutoBackupRestoreResult {
  ok: boolean
  backupId?: string
  restoredFiles: string[]
  /** 恢复时点仍处于删除状态、从目标目录清理的残留库文件（tombstone 应用结果） */
  removedFiles?: string[]
  error?: string
}

function requireKey(key: Buffer): Buffer {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('备份密钥必须为 32 字节')
  return key
}

function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

function accountSafeId(wxid: string | null): string {
  return wxid ? `wx-${sha256(wxid).slice(0, 16)}` : 'legacy'
}

export function backupDirName(d: Date): string {
  const p = (n: number, width = 2): string => String(n).padStart(width, '0')
  return `${AUTO_BACKUP_DIR_PREFIX}${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`
}

export function autoBackupLocalRoot(userData: string): string {
  return join(userData, 'backups', 'auto')
}

export function listBackupDirs(root: string): string[] {
  try { return readdirSync(root).filter((name) => name.startsWith(AUTO_BACKUP_DIR_PREFIX)).sort() } catch { return [] }
}

function atomicWrite(targetPath: string, data: Buffer, mode?: number): void {
  mkdirSync(dirname(targetPath), { recursive: true })
  const tmp = `${targetPath}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
  try {
    writeFileSync(tmp, data, mode ? { mode } : undefined)
    const fd = openSync(tmp, 'r')
    try { fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(tmp, targetPath)
  } catch (error) {
    try { rmSync(tmp, { force: true }) } catch { /* 原始错误优先 */ }
    throw error
  }
}

function manifestPayload(manifest: AutoBackupManifest): string {
  return JSON.stringify({ ...manifest, manifestAuth: { algorithm: 'hmac-sha256', digest: '' } })
}

function signManifest(manifest: AutoBackupManifest, key: Buffer): void {
  manifest.manifestAuth.digest = createHmac('sha256', requireKey(key)).update(manifestPayload(manifest)).digest('hex')
}

export function verifyBackupManifest(manifest: AutoBackupManifest, key: Buffer): void {
  if (manifest.formatVersion !== AUTO_BACKUP_FORMAT_VERSION) throw new Error('不支持的备份格式')
  if (manifest.manifestAuth?.algorithm !== 'hmac-sha256' || !/^[0-9a-f]{64}$/.test(manifest.manifestAuth.digest || '')) throw new Error('manifest 认证信息缺失')
  const expected = createHmac('sha256', requireKey(key)).update(manifestPayload(manifest)).digest()
  const actual = Buffer.from(manifest.manifestAuth.digest, 'hex')
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('manifest 哈希认证失败')
}

// ─── manifest 结构严格验证（恢复/组链前一律执行；与 HMAC 相互独立的两道门）───

const KINDS: readonly BusinessDbKind[] = ['crm', 'sales']
const LAYER_STATUSES: readonly AutoBackupLayerStatus[] = ['ok', 'skipped_not_configured', 'skipped_unreachable', 'failed']
/** 业务库文件名白名单（与 discoverBusinessDbs 产出一一对应；天然封死路径穿越与任意文件名） */
const ORIGINAL_NAME_RE = /^weflow-(crm|sales)(-[A-Za-z0-9_-]+)?\.db$/
const LOGICAL_NAME_RE = /^(crm|sales):(legacy|wx-[0-9a-f]{16})$/
const ACCOUNT_SAFE_ID_RE = /^(legacy|wx-[0-9a-f]{16})$/
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/

function assertPlainFileName(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`manifest 字段非法：${field} 缺失或非文件名`)
  if (value.includes('/') || value.includes('\\') || value === '.' || value === '..') throw new Error(`manifest 字段非法：${field} 疑似路径穿越`)
  return value
}

function assertBase64OfLength(value: unknown, bytes: number, field: string): void {
  if (typeof value !== 'string' || !B64_RE.test(value)) throw new Error(`manifest 字段非法：${field} 不是合法 base64`)
  if (Buffer.from(value, 'base64').length !== bytes) throw new Error(`manifest 字段非法：${field} 长度应为 ${bytes} 字节`)
}

function isFiniteNonNegative(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0
}

function validateFileEntry(entry: AutoBackupFileEntry, seenLogical: Set<string>): void {
  const label = `文件条目 ${String((entry as unknown as Record<string, unknown>)?.originalName ?? '?')}`
  if (!entry || typeof entry !== 'object') throw new Error(`${label}：非对象`)
  if (!KINDS.includes(entry.kind)) throw new Error(`${label}：kind 非法`)
  if (typeof entry.logicalName !== 'string' || !LOGICAL_NAME_RE.test(entry.logicalName)) throw new Error(`${label}：logicalName 非法`)
  if (seenLogical.has(entry.logicalName)) throw new Error(`manifest 字段非法：logicalName 重复（${entry.logicalName}）`)
  seenLogical.add(entry.logicalName)
  const originalName = assertPlainFileName(entry.originalName, 'originalName')
  const relativePath = assertPlainFileName(entry.originalRelativePath, 'originalRelativePath')
  if (originalName !== relativePath) throw new Error(`${label}：originalName 与 originalRelativePath 不一致`)
  if (!ORIGINAL_NAME_RE.test(originalName)) throw new Error(`manifest 字段非法：originalName 不在业务库白名单（${originalName}）`)
  const artifactName = assertPlainFileName(entry.artifactName, 'artifactName')
  if (artifactName !== `${originalName}.enc`) throw new Error(`${label}：artifactName 与 originalName 不匹配`)
  if (entry.name !== originalName) throw new Error(`${label}：兼容字段 name 与 originalName 不一致`)
  if (!Number.isInteger(entry.plaintextLength) || entry.plaintextLength <= 0) throw new Error(`${label}：plaintextLength 非法`)
  if (entry.size !== entry.plaintextLength) throw new Error(`${label}：兼容字段 size 与 plaintextLength 不一致`)
  if (typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256)) throw new Error(`${label}：sha256 格式非法`)
  if (entry.algorithm !== CIPHER_ALGORITHM) throw new Error(`${label}：algorithm 非法`)
  assertBase64OfLength(entry.nonce, 12, 'nonce')
  assertBase64OfLength(entry.tag, 16, 'tag')
  if (typeof entry.accountSafeId !== 'string' || !ACCOUNT_SAFE_ID_RE.test(entry.accountSafeId)) throw new Error(`${label}：accountSafeId 非法`)
  if (entry.logicalName !== `${entry.kind}:${entry.accountSafeId}`) throw new Error(`${label}：logicalName 与 kind/accountSafeId 不一致`)
}

/**
 * manifest 结构严格验证：schema 完整 / backupType 合法 / logicalName 唯一 / 禁止路径穿越 /
 * 文件条目与墓碑不重名冲突 / nonce·tag·hash·length 格式合法。
 * 基线引用与链条连续性由 chainFor 校验；HMAC 与密文由各自通道校验。
 * 早期 v2 产物没有 tombstones 字段：HMAC 通过后允许缺省（按 [] 处理），新产物一律写出。
 */
export function validateAutoBackupManifestStructure(manifest: AutoBackupManifest): void {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('manifest 结构非法：非对象')
  const missingField = (field: string): Error => new Error(`manifest 字段缺失：${field}`)
  if (typeof manifest.formatVersion !== 'number' || manifest.formatVersion !== AUTO_BACKUP_FORMAT_VERSION) throw new Error('不支持的备份格式')
  if (typeof manifest.app !== 'string' || !manifest.app) throw missingField('app')
  if (typeof manifest.backupId !== 'string' || !manifest.backupId) throw missingField('backupId')
  if (manifest.backupType !== 'full' && manifest.backupType !== 'incremental') throw new Error(`manifest 字段非法：backupType（${String(manifest.backupType)}）`)
  if (typeof manifest.createdAt !== 'string' || !Number.isFinite(Date.parse(manifest.createdAt))) throw missingField('createdAt')
  if (typeof manifest.trigger !== 'string' || !manifest.trigger) throw missingField('trigger')
  if (typeof manifest.baselineId !== 'string' || !manifest.baselineId) throw missingField('baselineId')
  if (manifest.previousBackupId !== null && (typeof manifest.previousBackupId !== 'string' || !manifest.previousBackupId)) throw missingField('previousBackupId')
  if (!Number.isInteger(manifest.chainIndex) || manifest.chainIndex < 0) throw new Error('manifest 字段非法：chainIndex')
  if (manifest.backupType === 'full') {
    if (manifest.baselineId !== manifest.backupId || manifest.previousBackupId !== null || manifest.chainIndex !== 0) throw new Error('全量基线节点自引用字段不一致')
  } else if (!manifest.previousBackupId || manifest.chainIndex < 1) {
    throw new Error('增量节点缺少前序引用或链序号')
  }
  if (!Array.isArray(manifest.files)) throw missingField('files')
  if (manifest.tombstones !== undefined && !Array.isArray(manifest.tombstones)) throw new Error('manifest 字段非法：tombstones')
  const seenLogical = new Set<string>()
  for (const entry of manifest.files) validateFileEntry(entry, seenLogical)
  if (manifest.tombstones) {
    for (const tombstone of manifest.tombstones) {
      if (!tombstone || typeof tombstone !== 'object') throw new Error('tombstone 条目非法：非对象')
      if (typeof tombstone.logicalName !== 'string' || !LOGICAL_NAME_RE.test(tombstone.logicalName)) throw new Error(`tombstone 条目非法：logicalName（${String(tombstone.logicalName)}）`)
      if (seenLogical.has(tombstone.logicalName)) throw new Error(`manifest 字段冲突：logicalName 同时出现在文件条目与删除墓碑（${tombstone.logicalName}）`)
      seenLogical.add(tombstone.logicalName)
      const originalName = assertPlainFileName(tombstone.originalName, 'tombstone.originalName')
      if (!ORIGINAL_NAME_RE.test(originalName)) throw new Error(`tombstone 条目非法：originalName 不在业务库白名单（${originalName}）`)
      if (typeof tombstone.deletedAt !== 'string' || !Number.isFinite(Date.parse(tombstone.deletedAt))) throw new Error('tombstone 条目非法：deletedAt')
    }
  }
  if (!Array.isArray(manifest.missing)) throw missingField('missing')
  for (const kind of manifest.missing) if (!KINDS.includes(kind)) throw new Error(`manifest 字段非法：missing（${String(kind)}）`)
  const layers = manifest.layers
  if (!layers || typeof layers !== 'object') throw missingField('layers')
  for (const layer of ['local', 'network'] as const) {
    const status = layers[layer]?.status
    if (!LAYER_STATUSES.includes(status)) throw new Error(`manifest 字段非法：layers.${layer}.status（${String(status)}）`)
  }
  if (!isFiniteNonNegative(manifest.durationMs)) throw new Error('manifest 字段非法：durationMs')
}

function readVerifiedManifest(dir: string, key: Buffer): AutoBackupManifest {
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as AutoBackupManifest
  verifyBackupManifest(manifest, key)
  validateAutoBackupManifestStructure(manifest)
  // 归一化必须发生在 HMAC 校验之后（缺省字段参与旧件 HMAC 载荷，提前改写会误判篡改）
  manifest.tombstones ??= []
  return manifest
}

export function readLatestManifest(root: string): AutoBackupManifest | null {
  const dirs = listBackupDirs(root)
  for (let i = dirs.length - 1; i >= 0; i--) {
    try { return JSON.parse(readFileSync(join(root, dirs[i], 'manifest.json'), 'utf8')) as AutoBackupManifest } catch { /* 看上一份 */ }
  }
  return null
}

function listVerifiedRecords(root: string, key: Buffer): Array<{ dirName: string; manifest: AutoBackupManifest }> {
  const out: Array<{ dirName: string; manifest: AutoBackupManifest }> = []
  for (const dirName of listBackupDirs(root)) {
    try { out.push({ dirName, manifest: readVerifiedManifest(join(root, dirName), key) }) } catch { /* 旧格式或损坏件不参与新链 */ }
  }
  return out.sort((a, b) => a.manifest.createdAt.localeCompare(b.manifest.createdAt) || a.manifest.backupId.localeCompare(b.manifest.backupId))
}

function isoWeekKey(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  const weekday = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - weekday)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  return `${d.getUTCFullYear()}-${Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7)}`
}

function chainFor(records: Array<{ dirName: string; manifest: AutoBackupManifest }>, target: AutoBackupManifest): Array<{ dirName: string; manifest: AutoBackupManifest }> {
  const byId = new Map(records.map((record) => [record.manifest.backupId, record]))
  const reversed: Array<{ dirName: string; manifest: AutoBackupManifest }> = []
  let current: AutoBackupManifest | undefined = target
  const seen = new Set<string>()
  while (current) {
    if (seen.has(current.backupId)) throw new Error('增量链成环')
    seen.add(current.backupId)
    const record = byId.get(current.backupId)
    if (!record) throw new Error(`增量链缺失：${current.backupId}`)
    reversed.push(record)
    if (current.backupType === 'full') break
    if (!current.previousBackupId) throw new Error('增量缺少前序节点')
    current = byId.get(current.previousBackupId)?.manifest
    if (!current) throw new Error(`增量链缺失：${record.manifest.previousBackupId}`)
  }
  const chain = reversed.reverse()
  const baseline = chain[0]?.manifest
  if (!baseline || baseline.backupType !== 'full' || baseline.backupId !== target.baselineId) throw new Error('缺少有效全量基线')
  for (let i = 0; i < chain.length; i++) {
    const manifest = chain[i].manifest
    if (manifest.baselineId !== baseline.backupId || manifest.chainIndex !== i) throw new Error('增量链序号或基线引用错误')
    if (i > 0 && manifest.previousBackupId !== chain[i - 1].manifest.backupId) throw new Error('增量链断裂')
  }
  return chain
}

/** 链上有效状态：按链序逐节点先应用删除墓碑、再应用文件（后继节点重建可覆盖先前墓碑） */
function effectiveEntries(chain: Array<{ manifest: AutoBackupManifest }>): Map<string, AutoBackupFileEntry> {
  const result = new Map<string, AutoBackupFileEntry>()
  for (const record of chain) {
    for (const tombstone of record.manifest.tombstones ?? []) result.delete(tombstone.logicalName)
    for (const file of record.manifest.files) result.set(file.logicalName, file)
  }
  return result
}

function encryptFile(plain: Buffer, entry: Omit<AutoBackupFileEntry, 'name' | 'size' | 'plaintextLength' | 'sha256' | 'algorithm' | 'nonce' | 'tag'>, key: Buffer): { entry: AutoBackupFileEntry; encrypted: Buffer } {
  const nonce = randomBytes(12)
  const cipher = createCipheriv(CIPHER_ALGORITHM, requireKey(key), nonce)
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()])
  return {
    encrypted,
    entry: { ...entry, name: entry.originalName, size: plain.length, plaintextLength: plain.length, sha256: sha256(plain), algorithm: CIPHER_ALGORITHM, nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64') }
  }
}

function decryptFile(dir: string, entry: AutoBackupFileEntry, key: Buffer): Buffer {
  if (entry.algorithm !== CIPHER_ALGORITHM) throw new Error(`不支持的加密算法：${entry.algorithm}`)
  try {
    const decipher = createDecipheriv(CIPHER_ALGORITHM, requireKey(key), Buffer.from(entry.nonce, 'base64'))
    decipher.setAuthTag(Buffer.from(entry.tag, 'base64'))
    const plain = Buffer.concat([decipher.update(readFileSync(join(dir, entry.artifactName))), decipher.final()])
    if (plain.length !== entry.plaintextLength) throw new Error('明文长度不一致')
    if (sha256(plain) !== entry.sha256) throw new Error('明文 SHA-256 不一致')
    return plain
  } catch (error) {
    throw new Error(`GCM 认证或文件校验失败：${entry.originalName}：${String(error)}`)
  }
}

/** 完整验证一个备份节点：manifest HMAC + 每个密文的 GCM/长度/SHA-256。 */
function verifyBackupDir(dir: string, key: Buffer): AutoBackupManifest {
  const manifest = readVerifiedManifest(dir, key)
  for (const entry of manifest.files) decryptFile(dir, entry, key)
  return manifest
}

function networkReachable(path: string): boolean {
  try { return statSync(path).isDirectory() } catch { return false }
}

/**
 * 网络备份根目录异密钥预检：逐个用当前主密钥完成 manifest HMAC + 结构 + 备份节点（GCM/长度/SHA-256）
 * 验证，返回无法通过的现有节点名。
 *
 * 用途：写入前判定该网络目录是否属于**当前这把**备份密钥。典型场景是新机器在导入恢复密钥之前
 * 就把网络路径指向旧机器的共享目录——若放任本机新生成的密钥把空库基线写进去，旧机器备份根目录里
 * 就会混入一个无法通过旧密钥 HMAC 校验的节点，之后 restoreAutoBackup 的整根校验会整体失败，
 * 且用户只能手动删目录才能恢复。因此在首次写入之前拦下，改为网络层明确失败（本地备份照常成功）。
 * 不删除、不改写、不忽略任何异密钥节点——目录归属只能由用户确认。
 */
function findForeignBackupDirs(root: string, key: Buffer): string[] {
  const foreign: string[] = []
  for (const dirName of listBackupDirs(root)) {
    try { verifyBackupDir(join(root, dirName), key) } catch { foreign.push(dirName) }
  }
  return foreign
}

function copyVerifiedDir(sourceRoot: string, targetRoot: string, dirName: string, key: Buffer): void {
  const sourceDir = join(sourceRoot, dirName)
  const manifest = verifyBackupDir(sourceDir, key)
  const targetDir = join(targetRoot, dirName)
  mkdirSync(targetDir, { recursive: true })
  for (const file of manifest.files) copyFileSync(join(sourceDir, file.artifactName), join(targetDir, file.artifactName))
  copyFileSync(join(sourceDir, 'manifest.json'), join(targetDir, 'manifest.json'))
  verifyBackupDir(targetDir, key)
}

export function pruneBackups(root: string, keep: number, key?: Buffer): string[] {
  const dirs = listBackupDirs(root)
  if (dirs.length <= keep || !key) return []
  const records = listVerifiedRecords(root, key)
  const protectedIds = new Set<string>()
  for (const record of records.slice(-Math.max(1, keep))) {
    try { for (const node of chainFor(records, record.manifest)) protectedIds.add(node.manifest.backupId) } catch { protectedIds.add(record.manifest.backupId) }
  }
  const idByDir = new Map(records.map((record) => [record.dirName, record.manifest.backupId]))
  const removable = dirs.filter((dir, index) => {
    const id = idByDir.get(dir)
    return id ? !protectedIds.has(id) : index < dirs.length - keep
  })
  const removed: string[] = []
  for (const dir of removable) {
    try { rmSync(join(root, dir), { recursive: true, force: true }); removed.push(dir) } catch { /* 保留失败目录 */ }
  }
  return removed
}

export function runAutoBackup(opts: AutoBackupOptions): AutoBackupResult {
  const started = Date.now()
  const now = opts.now ?? new Date()
  const key = requireKey(opts.key)
  const root = autoBackupLocalRoot(opts.userData)
  mkdirSync(root, { recursive: true })
  const records = listVerifiedRecords(root, key)
  const previous = records.at(-1)
  const hasThisWeekBaseline = records.some((record) => record.manifest.backupType === 'full' && isoWeekKey(new Date(record.manifest.createdAt)) === isoWeekKey(now))
  const backupType = opts.backupType ?? (hasThisWeekBaseline ? 'incremental' : 'full')
  if (backupType === 'incremental' && !previous) throw new Error('缺少全量基线，不能创建增量')
  const priorChain = previous ? chainFor(records, previous.manifest) : []
  const priorFiles = effectiveEntries(priorChain)
  const sources = discoverBusinessDbs(opts.userData)
  if (!sources.length) throw new Error('未找到任何业务库文件')
  const backupId = randomUUID()
  const dirName = backupDirName(now)
  const localDir = join(root, dirName)
  if (existsSync(localDir)) throw new Error(`备份目录冲突：${dirName}`)
  mkdirSync(localDir, { recursive: true })
  const kinds = new Set(sources.map((source) => source.kind))
  const missing = (['crm', 'sales'] as BusinessDbKind[]).filter((kind) => !kinds.has(kind))
  // 删除墓碑：全量基线重置为空；增量必须记录「基线里有、现在已消失」的逻辑库，恢复链据此防止复活
  const currentLogicalNames = new Set(sources.map((source) => `${source.kind}:${accountSafeId(source.wxid)}`))
  const tombstones: AutoBackupTombstone[] = backupType === 'incremental'
    ? [...priorFiles.keys()]
        .filter((logicalName) => !currentLogicalNames.has(logicalName))
        .sort()
        .map((logicalName) => ({
          logicalName,
          originalName: priorFiles.get(logicalName)!.originalName,
          deletedAt: now.toISOString()
        }))
    : []
  const files: AutoBackupFileEntry[] = []
  try {
    for (const source of sources) {
      const plain = readFileSync(source.path)
      const safeId = accountSafeId(source.wxid)
      const logicalName = `${source.kind}:${safeId}`
      const digest = sha256(plain)
      if (backupType === 'incremental' && priorFiles.get(logicalName)?.sha256 === digest) continue
      const artifactName = `${source.name}.enc`
      const encrypted = encryptFile(plain, { kind: source.kind, logicalName, originalName: source.name, originalRelativePath: source.name, artifactName, accountSafeId: safeId }, key)
      atomicWrite(join(localDir, artifactName), encrypted.encrypted)
      files.push(encrypted.entry)
    }
    const manifest: AutoBackupManifest = {
      formatVersion: AUTO_BACKUP_FORMAT_VERSION,
      app: opts.appVersion,
      backupId,
      backupType,
      createdAt: now.toISOString(),
      trigger: opts.trigger || 'scheduled',
      baselineId: backupType === 'full' ? backupId : previous!.manifest.baselineId,
      previousBackupId: backupType === 'full' ? null : previous!.manifest.backupId,
      chainIndex: backupType === 'full' ? 0 : previous!.manifest.chainIndex + 1,
      files,
      tombstones,
      missing,
      layers: { local: { status: 'ok', dir: dirName }, network: { status: opts.networkPath ? 'failed' : 'skipped_not_configured' } },
      durationMs: 0,
      manifestAuth: { algorithm: 'hmac-sha256', digest: '' }
    }
    const networkPath = String(opts.networkPath || '').trim()
    let networkError: string | undefined
    if (networkPath) {
      if (!networkReachable(networkPath)) {
        networkError = '网络备份路径不可达'
        manifest.layers.network = { status: 'skipped_unreachable', error: networkError }
      }
      else {
        // 异密钥预检必须发生在**向网络目录写入任何文件之前**（回填旧节点、本轮目录、manifest、
        // 轮转删除都在其后）：一旦目录里有不属于当前密钥的节点，本轮网络层直接失败，
        // 本地备份不受影响，网络目录零改动。
        const foreignDirs = findForeignBackupDirs(networkPath, key)
        if (foreignDirs.length) {
          networkError = `网络备份目录包含不属于当前备份密钥的备份（${foreignDirs.join('、')}），已拒绝写入：`
            + '该目录可能属于其它备份密钥（或节点已损坏）。本机备份已完成，网络层本轮未做任何改动；'
            + '请确认该目录归属，或导入对应恢复密钥后重试'
          manifest.layers.network = { status: 'failed', error: networkError }
        }
        else {
          try {
            for (const node of priorChain) copyVerifiedDir(root, networkPath, node.dirName, key)
            manifest.layers.network = { status: 'ok', dir: dirName }
          } catch (error) {
            networkError = String(error)
            manifest.layers.network = { status: 'failed', error: networkError }
          }
        }
      }
    }
    manifest.durationMs = Date.now() - started
    signManifest(manifest, key)
    atomicWrite(join(localDir, 'manifest.json'), Buffer.from(JSON.stringify(manifest, null, 2)))
    verifyBackupDir(localDir, key)
    if (manifest.layers.network.status === 'ok' && networkPath) {
      try { copyVerifiedDir(root, networkPath, dirName, key) } catch (error) {
        networkError = String(error)
        manifest.layers.network = { status: 'failed', error: networkError }
        signManifest(manifest, key)
        atomicWrite(join(localDir, 'manifest.json'), Buffer.from(JSON.stringify(manifest, null, 2)))
        try { rmSync(join(networkPath, dirName), { recursive: true, force: true }) } catch { /* 网络失败独立返回 */ }
      }
    }
    manifest.layers.local.pruned = pruneBackups(root, opts.keep ?? AUTO_BACKUP_KEEP, key)
    if (manifest.layers.network.status === 'ok' && networkPath) manifest.layers.network.pruned = pruneBackups(networkPath, opts.keep ?? AUTO_BACKUP_KEEP, key)
    signManifest(manifest, key)
    atomicWrite(join(localDir, 'manifest.json'), Buffer.from(JSON.stringify(manifest, null, 2)))
    if (manifest.layers.network.status === 'ok' && networkPath) {
      try {
        atomicWrite(join(networkPath, dirName, 'manifest.json'), Buffer.from(JSON.stringify(manifest, null, 2)))
        verifyBackupDir(join(networkPath, dirName), key)
      } catch (error) {
        networkError = String(error)
        manifest.layers.network = { status: 'failed', error: networkError }
        signManifest(manifest, key)
        atomicWrite(join(localDir, 'manifest.json'), Buffer.from(JSON.stringify(manifest, null, 2)))
        try { rmSync(join(networkPath, dirName), { recursive: true, force: true }) } catch { /* 网络失败不回滚本机 */ }
      }
    }
    return { ok: true, dirName, manifest, networkError }
  } catch (error) {
    try { rmSync(localDir, { recursive: true, force: true }) } catch { /* 原始错误优先 */ }
    throw error
  }
}

export async function restoreAutoBackup(opts: AutoBackupRestoreOptions): Promise<AutoBackupRestoreResult> {
  try {
    const key = requireKey(opts.key)
    const dirs = listBackupDirs(opts.backupRoot)
    if (!dirs.length) return { ok: false, restoredFiles: [], error: '没有可恢复的备份' }
    // 每个节点：manifest HMAC + 结构严格验证（readVerifiedManifest 内）
    const records = dirs.map((dirName) => ({ dirName, manifest: readVerifiedManifest(join(opts.backupRoot, dirName), key) }))
    const target = opts.backupId
      ? records.find((record) => record.manifest.backupId === opts.backupId)
      : records.sort((a, b) => a.manifest.createdAt.localeCompare(b.manifest.createdAt)).at(-1)
    if (!target) throw new Error('指定备份不存在')
    // 基线引用存在且链条连续（chainFor）
    const chain = chainFor(records, target.manifest)
    // 组合链有效状态：先应用墓碑再应用文件 → 已删除库不会从基线复活，删除后重建的库取最新文件
    const restored = new Map<string, { entry: AutoBackupFileEntry; plain: Buffer }>()
    for (const node of chain) {
      const dir = join(opts.backupRoot, node.dirName)
      for (const tombstone of node.manifest.tombstones ?? []) restored.delete(tombstone.logicalName)
      for (const entry of node.manifest.files) restored.set(entry.logicalName, { entry, plain: decryptFile(dir, entry, key) })
    }
    if (!restored.size) throw new Error('备份链不含任何业务库文件')
    // 链末端仍处于删除状态的库：恢复后不应存在，目标目录若有同名残留一并清理（防复活）
    const restoredLogicalNames = new Set(restored.keys())
    const tombstonedOriginalNames = new Set<string>()
    for (const node of chain) {
      for (const tombstone of node.manifest.tombstones ?? []) {
        if (!restoredLogicalNames.has(tombstone.logicalName)) tombstonedOriginalNames.add(tombstone.originalName)
      }
    }
    // 阶段一：全部先恢复到临时目录，所有库逐一验证可打开（任一失败即整体失败，不触碰正式库）
    const tempDir = join(opts.targetUserData, `.auto-restore-${process.pid}-${(opts.now ?? new Date()).getTime()}`)
    mkdirSync(tempDir, { recursive: true })
    // 阶段二前置快照：所有将被替换/删除目标的旧内容先全部留底，之后才开始替换
    const originals = new Map<string, Buffer | null>()
    try {
      for (const { entry, plain } of restored.values()) {
        if (basename(entry.originalRelativePath) !== entry.originalRelativePath || entry.originalName !== entry.originalRelativePath) throw new Error('manifest 原始文件映射非法')
        const tempFile = join(tempDir, entry.originalName)
        atomicWrite(tempFile, plain)
        await opts.validateDatabase(tempFile)
      }
      for (const { entry } of restored.values()) {
        const targetFile = join(opts.targetUserData, entry.originalName)
        originals.set(targetFile, existsSync(targetFile) ? readFileSync(targetFile) : null)
      }
      for (const originalName of tombstonedOriginalNames) {
        const targetFile = join(opts.targetUserData, originalName)
        if (existsSync(targetFile)) originals.set(targetFile, readFileSync(targetFile))
      }
      // 阶段二：全部验证通过后才替换；任一写入失败 → 全部回滚旧内容，不出现新旧混合
      for (const { entry, plain } of restored.values()) atomicWrite(join(opts.targetUserData, entry.originalName), plain)
      for (const originalName of tombstonedOriginalNames) {
        const targetFile = join(opts.targetUserData, originalName)
        if (existsSync(targetFile)) rmSync(targetFile, { force: true })
      }
      rmSync(tempDir, { recursive: true, force: true })
      return {
        ok: true,
        backupId: target.manifest.backupId,
        restoredFiles: [...restored.values()].map((value) => value.entry.originalName).sort(),
        removedFiles: [...tombstonedOriginalNames].filter((name) => originals.has(join(opts.targetUserData, name))).sort()
      }
    } catch (error) {
      // 替换/清理任意一步失败：按快照恢复全部旧文件；回滚本身失败也如实并入错误
      const rollbackFailures: string[] = []
      for (const [path, previous] of originals) {
        try { if (previous) atomicWrite(path, previous); else rmSync(path, { force: true }) } catch (rollbackError) { rollbackFailures.push(`${basename(path)}：${String(rollbackError)}`) }
      }
      try { rmSync(tempDir, { recursive: true, force: true }) } catch { /* ignore */ }
      if (rollbackFailures.length) throw new Error(`${String(error)}；且旧文件回滚失败：${rollbackFailures.join('；')}`)
      throw error
    }
  } catch (error) {
    return { ok: false, restoredFiles: [], error: String(error) }
  }
}
