/**
 * autoBackupKeyVault.ts —— 主备份密钥的静态安全（PRD v3.4 §1.1）。
 * 零 Electron 依赖；本机密钥封装通过 SecretBox 注入：
 *   - Electron main 传 safeStorage 适配器（Windows DPAPI / macOS 钥匙串，autoBackupSecretBox.ts）；
 *   - 无系统安全设施的环境回退 local-wrap（本机随机包装密钥 AES-GCM 封装，降级方案，provider 名如实记录）。
 * 铁律：
 *   - 明文主密钥绝不长期落盘（旧版 auto-backup.key 明文件读取后即封装并粉碎删除）；
 *   - 封装件 / 恢复密钥导出件 / manifest / 日志均不得出现明文主密钥；
 *   - 恢复密钥导出件 = 用户口令 scrypt 派生 KEK + AES-256-GCM(主密钥)，错误口令在 GCM 认证处明确失败。
 */
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync
} from 'fs'
import { basename, dirname, join } from 'path'
import {
  createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual
} from 'crypto'
import { autoBackupLocalRoot } from './autoBackupCore'

export const MASTER_KEY_LENGTH = 32
/** 本机封装件（含 provider 与密文，无明文主密钥） */
export const WRAPPED_KEY_FILENAME = 'auto-backup.key.wrapped'
/** 旧版明文密钥文件（读取即迁移粉碎，不再新建） */
export const LEGACY_KEY_FILENAME = 'auto-backup.key'
/** local-wrap 回退方案的包装密钥文件（0600；与封装件同目录） */
export const LOCAL_WRAP_KEY_FILENAME = 'auto-backup.wrap'
/** local-wrap 回退方案的 provider 名（写入封装件；采用恢复密钥时据此判定是否需要重建包装密钥） */
export const LOCAL_WRAP_PROVIDER = 'local-wrap-v1'
/** 采用恢复密钥时，本机旧密钥与本地备份链的隔离根目录（位于 userData/backups/ 下） */
export const QUARANTINE_DIR_NAME = 'auto-quarantine'
const WRAPPED_KEY_MAGIC = 'weflow-auto-backup-wrapped-key'
export const RECOVERY_KEY_MAGIC = 'weflow-auto-backup-recovery-key'
const WRAPPED_FORMAT_VERSION = 1
export const RECOVERY_FORMAT_VERSION = 1
const CIPHER_ALGORITHM = 'aes-256-gcm' as const
const NONCE_LENGTH = 12
const SALT_LENGTH = 16
const TAG_LENGTH = 16
/** 导出口令最短长度：恢复密钥是唯一的跨机凭证，弱口令直接拒绝导出 */
export const RECOVERY_PASSPHRASE_MIN_LENGTH = 8
/** scrypt 参数（写入导出件，导入按文件参数派生；导入侧限制上界防 DoS） */
export const RECOVERY_SCRYPT_PARAMS = { N: 32768, r: 8, p: 1 } as const
const SCRYPT_MAXMEM = 128 * 1024 * 1024

/** 平台密钥封装设施抽象：Electron safeStorage 适配器或测试等价实现 */
export interface SecretBox {
  /** 封装设施名；写入封装件，加载时 provider 不匹配明确报错（不盲猜解封方式） */
  readonly name: string
  encrypt(plaintext: Buffer): Buffer
  decrypt(blob: Buffer): Buffer
}

/**
 * 本机主密钥来源（写入封装件，供「新机首次恢复门禁」判定）：
 *   - generated       本机首次启动时全新生成（从未导入/采用过恢复密钥）→ 门禁开放；
 *   - legacy-migrated 由旧版明文 auto-backup.key 迁移而来（本机承载真实历史）→ 门禁关闭；
 *   - imported        由恢复密钥导入/采用而来 → 门禁关闭（不重复采用）。
 * 旧封装件缺该字段时读作 null（来源不明），一律按门禁关闭处理（安全默认）。
 */
export type KeyOrigin = 'generated' | 'legacy-migrated' | 'imported'
const KEY_ORIGINS: readonly string[] = ['generated', 'legacy-migrated', 'imported']

interface WrappedKeyEnvelope {
  magic: string
  formatVersion: number
  provider: string
  createdAt: string
  /** base64(SecretBox 密文) */
  data: string
  /** 密钥来源；旧封装件无此字段 */
  origin?: KeyOrigin
}

export interface RecoveryKeyExport {
  magic: string
  formatVersion: number
  cipher: typeof CIPHER_ALGORITHM
  kdf: { name: 'scrypt'; N: number; r: number; p: number; salt: string }
  nonce: string
  tag: string
  /** base64(AES-256-GCM(主密钥) 密文，恒为 32 字节) */
  data: string
  /** 主密钥指纹（SHA-256 前 16 hex，用于人工核对两机是否同一密钥，不泄露密钥本身） */
  keyFingerprint: string
  createdAt: string
}

/** installed=新装为当前密钥 / matched=与本机现有密钥一致 / adopted=采用（本机旧密钥与旧备份已整体隔离） */
export type RecoveryImportStatus = 'installed' | 'matched' | 'adopted'

function assertMasterKey(key: Buffer): Buffer {
  if (!Buffer.isBuffer(key) || key.length !== MASTER_KEY_LENGTH) throw new Error(`主备份密钥必须为 ${MASTER_KEY_LENGTH} 字节`)
  return key
}

function atomicWritePrivate(targetPath: string, data: Buffer, mode: number): void {
  mkdirSync(dirname(targetPath), { recursive: true })
  const tmp = `${targetPath}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
  try {
    writeFileSync(tmp, data, { mode })
    const fd = openSync(tmp, 'r')
    try { fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(tmp, targetPath)
  } catch (error) {
    try { rmSync(tmp, { force: true }) } catch { /* 原始错误优先 */ }
    throw error
  }
}

function parseWrappedEnvelope(raw: string, wrappedPath: string): WrappedKeyEnvelope {
  let env: WrappedKeyEnvelope
  try { env = JSON.parse(raw) as WrappedKeyEnvelope } catch { throw new Error(`本机备份密钥封装件损坏（非 JSON）：${wrappedPath}；请导入恢复密钥恢复`) }
  if (env.magic !== WRAPPED_KEY_MAGIC || env.formatVersion !== WRAPPED_FORMAT_VERSION) throw new Error('本机备份密钥封装件版本不受支持；请导入恢复密钥恢复')
  if (typeof env.provider !== 'string' || !env.provider || typeof env.data !== 'string' || !env.data) throw new Error('本机备份密钥封装件字段缺失；请导入恢复密钥恢复')
  return env
}

function readMasterKeyFromWrapped(userData: string, box: SecretBox): Buffer {
  const wrappedPath = join(userData, WRAPPED_KEY_FILENAME)
  const env = parseWrappedEnvelope(readFileSync(wrappedPath, 'utf8'), wrappedPath)
  if (env.provider !== box.name) {
    throw new Error(`本机备份密钥由「${env.provider}」封装，当前环境为「${box.name}」，无法解封；请在原环境读取，或导入恢复密钥`)
  }
  let plain: Buffer
  try {
    plain = box.decrypt(Buffer.from(env.data, 'base64'))
  } catch (error) {
    throw new Error(`本机备份密钥解封失败（${env.provider}）：${String(error)}；请导入恢复密钥恢复`)
  }
  return assertMasterKey(plain)
}

/**
 * 旧版明文密钥文件清理：覆写与删除分别执行——覆写失败仍必须尝试删除；
 * 结束后终检存在性，明文仍残留 = 装载/迁移明确失败（不静默遗留、不报成功）。
 * 错误信息只含文件名，不含任何密钥内容。
 */
function purgeLegacyKeyFile(path: string): void {
  if (!existsSync(path)) return
  try {
    const size = Math.max(1, statSync(path).size)
    writeFileSync(path, randomBytes(size))
  } catch { /* 覆写失败仍须尝试删除 */ }
  try { rmSync(path, { force: true }) } catch { /* 由存在性终检统一裁决 */ }
  if (existsSync(path)) {
    throw new Error(`旧版明文密钥文件（${basename(path)}）未能删除，密钥装载中止；请手动删除该文件后重试（本机备份密钥与备份文件不受影响）`)
  }
}

function writeWrappedKey(userData: string, masterKey: Buffer, box: SecretBox, origin: KeyOrigin): void {
  const wrappedPath = join(userData, WRAPPED_KEY_FILENAME)
  const blob = box.encrypt(assertMasterKey(masterKey))
  const env: WrappedKeyEnvelope = {
    magic: WRAPPED_KEY_MAGIC,
    formatVersion: WRAPPED_FORMAT_VERSION,
    provider: box.name,
    createdAt: new Date().toISOString(),
    data: blob.toString('base64'),
    origin
  }
  atomicWritePrivate(wrappedPath, Buffer.from(JSON.stringify(env, null, 2)), 0o600)
}

/** 读取本机封装件的密钥来源（只读封装件明文头，不涉及解封）；无封装件或字段缺失返回 null */
export function readWrappedKeyOrigin(userData: string): KeyOrigin | null {
  const wrappedPath = join(userData, WRAPPED_KEY_FILENAME)
  if (!existsSync(wrappedPath)) return null
  try {
    const env = JSON.parse(readFileSync(wrappedPath, 'utf8')) as WrappedKeyEnvelope
    return typeof env.origin === 'string' && KEY_ORIGINS.includes(env.origin) ? (env.origin as KeyOrigin) : null
  } catch {
    return null
  }
}

/**
 * 本机主备份密钥装载（封装件优先 → 旧明文件迁移粉碎 → 全新生成）。
 * 成功返回后磁盘上不存在明文主密钥文件；明文残留清不掉时明确抛错。
 */
export function loadOrCreateAutoBackupKeyCore(userData: string, box: SecretBox): Buffer {
  const wrappedPath = join(userData, WRAPPED_KEY_FILENAME)
  if (existsSync(wrappedPath)) {
    const key = readMasterKeyFromWrapped(userData, box)
    // wrapped 优先也不能跳过残留明文的清场：清不掉 = 明确失败（不留静默隐患）
    purgeLegacyKeyFile(join(userData, LEGACY_KEY_FILENAME))
    return key
  }
  const legacyPath = join(userData, LEGACY_KEY_FILENAME)
  if (existsSync(legacyPath)) {
    const legacy = readFileSync(legacyPath)
    if (legacy.length !== MASTER_KEY_LENGTH) throw new Error('旧版自动备份密钥长度非法；请导入恢复密钥恢复')
    writeWrappedKey(userData, legacy, box, 'legacy-migrated')
    purgeLegacyKeyFile(legacyPath)
    return legacy
  }
  const key = randomBytes(MASTER_KEY_LENGTH)
  writeWrappedKey(userData, key, box, 'generated')
  return key
}

/**
 * 新机首次恢复门禁：本机主密钥为「首次启动时自动生成」（从未导入/采用过恢复密钥）时为真。
 *
 * 语义：门禁开放 = 本机密钥是自生成的，允许用户通过**显式恢复动作**（导入恢复密钥并确认）
 * 采用旧机器密钥——采用时先把本机密钥与本地备份链整体移入隔离目录（可恢复），不覆盖、不删除。
 * 来源不明（旧封装件缺 origin 字段）与 legacy-migrated / imported 一律门禁关闭，保持
 * 「不同密钥默认拒绝覆盖」的原原则。
 */
export function canAdoptImportedMasterKey(userData: string): boolean {
  return readWrappedKeyOrigin(userData) === 'generated'
}

/** 采用恢复密钥的结果（adopted 时携带隔离目录，供 UI 告知用户旧密钥与旧备份的去向） */
export interface RecoveryAdoptOutcome {
  status: RecoveryImportStatus
  fingerprint: string
  /** 隔离目录绝对路径（status='adopted' 时存在；本机旧密钥与本地备份链已整体移入） */
  quarantineDir?: string
  /** 移入隔离目录的本机备份目录数 */
  quarantinedBackups?: number
}

/**
 * 采用恢复密钥：把本机现有密钥文件与本地备份链**整体移动**（rename，非复制非删除）到
 * userData/backups/auto-quarantine/<时间戳>/ 下，再安装导入密钥。
 * 任一步失败即逆序回滚已移动项并抛出——不留半迁移状态，旧密钥与旧备份始终可恢复。
 *
 * ⚠️ local-wrap 环境必须为新环境重建封装设施：传入 box 的闭包里持有的是**旧**包装密钥，
 * 而 auto-backup.wrap 已随本轮移入隔离目录。若继续用它封装导入密钥，新封装件将被旧包装
 * 密钥加密，而根目录已无对应 auto-backup.wrap，重启后必然 GCM 认证失败（密钥永久解不开）。
 * 因此写入前用 localWrapSecretBox(userData) 重新生成一把包装密钥，保证根目录下
 * auto-backup.key.wrapped 与 auto-backup.wrap 成对匹配；隔离目录里的旧 wrapped + 旧 wrap
 * 也是一对（一起被移走），旧环境仍可人工恢复。safeStorage 环境不受影响（密钥材料由系统
 * 设施保管，与 userData 目录无关）。
 */
function adoptImportedMasterKey(userData: string, importedKey: Buffer, box: SecretBox, now: Date): RecoveryAdoptOutcome {
  const stamp = `${now.toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}`
  const quarantineDir = join(userData, 'backups', QUARANTINE_DIR_NAME, stamp)
  const keyDir = join(quarantineDir, 'key')
  const backupsDir = join(quarantineDir, 'local-backups')
  const moves: Array<{ from: string; to: string }> = []
  const move = (from: string, to: string): boolean => {
    if (!existsSync(from)) return false
    renameSync(from, to)
    moves.push({ from, to })
    return true
  }
  const rollback = (): boolean => {
    let allOk = true
    for (let i = moves.length - 1; i >= 0; i--) {
      try { renameSync(moves[i].to, moves[i].from) } catch { allOk = false }
    }
    return allOk
  }

  mkdirSync(keyDir, { recursive: true })
  mkdirSync(backupsDir, { recursive: true })
  let quarantinedBackups = 0
  try {
    // ① 先搬本地备份链，再搬密钥：密钥缺席的中间态不存在（第 ② 步失败会被回滚）
    const localRoot = autoBackupLocalRoot(userData)
    if (existsSync(localRoot)) {
      for (const name of readdirSync(localRoot)) {
        move(join(localRoot, name), join(backupsDir, name))
        quarantinedBackups++
      }
    }
    // ② 本机密钥三件套整体移入隔离目录：明文残留（若有）也一样搬走，不删除
    const movedWrapped = move(join(userData, WRAPPED_KEY_FILENAME), join(keyDir, WRAPPED_KEY_FILENAME))
    move(join(userData, LOCAL_WRAP_KEY_FILENAME), join(keyDir, LOCAL_WRAP_KEY_FILENAME))
    move(join(userData, LEGACY_KEY_FILENAME), join(keyDir, LEGACY_KEY_FILENAME))
    if (!movedWrapped) throw new Error('本机备份密钥封装件消失，采用流程已中止（未做任何变更）')

    // ③ 留档：隔离原因与人工恢复方法（不含任何密钥材料）
    writeFileSync(join(quarantineDir, 'quarantine.json'), JSON.stringify({
      reason: 'adopt-recovery-key',
      createdAt: now.toISOString(),
      adoptedKeyFingerprint: masterKeyFingerprint(importedKey),
      quarantinedBackups,
      keyFiles: [WRAPPED_KEY_FILENAME, LOCAL_WRAP_KEY_FILENAME, LEGACY_KEY_FILENAME]
    }, null, 2), { mode: 0o600 })
    writeFileSync(join(quarantineDir, 'README.txt'), [
      '本目录是「采用恢复密钥」时自动隔离的本机原始备份环境，内容完整、未被删除。',
      '',
      `  key/           本机原备份密钥：封装件 ${WRAPPED_KEY_FILENAME}`,
      `                 （local-wrap 降级方案下还有配套的 ${LOCAL_WRAP_KEY_FILENAME}，两者必须成对使用）`,
      `  local-backups/ 本机原来的本地备份链（共 ${quarantinedBackups} 份）`,
      '',
      '如需回到采用之前的状态：退出应用，先删除应用数据根目录下现有的',
      `${WRAPPED_KEY_FILENAME} 与 ${LOCAL_WRAP_KEY_FILENAME}（采用恢复密钥后新生成的封装件），`,
      '再把 key/ 下的文件移回应用数据根目录（两者要一起移动，不可只移其一），',
      '把 local-backups/ 下的目录移回 backups/auto/，然后重新启动应用。',
      '确认不再需要后，可手动删除本目录。'
    ].join('\n'), { mode: 0o600 })
  } catch (error) {
    if (rollback()) { try { rmSync(quarantineDir, { recursive: true, force: true }) } catch { /* 空目录残留无害 */ } }
    throw error
  }

  const writeBox = box.name === LOCAL_WRAP_PROVIDER ? localWrapSecretBox(userData) : box
  writeWrappedKey(userData, importedKey, writeBox, 'imported')
  return { status: 'adopted', fingerprint: masterKeyFingerprint(importedKey), quarantineDir, quarantinedBackups }
}

/**
 * 导入恢复密钥：口令解出主密钥后与本机现状核对——
 *   本机已有不同密钥 → 默认明确失败且不写任何文件（防覆盖）；
 *   相同 → 确保已封装（补迁移）；本机无密钥 → 安装为当前密钥；
 *   opts.adopt=true 且门禁开放 → 采用（先隔离本机密钥与本地备份链，再安装）。
 */
export function installImportedMasterKey(
  userData: string,
  importedKey: Buffer,
  box: SecretBox,
  opts?: { adopt?: boolean; now?: Date }
): RecoveryAdoptOutcome {
  assertMasterKey(importedKey)
  const wrappedPath = join(userData, WRAPPED_KEY_FILENAME)
  const legacyPath = join(userData, LEGACY_KEY_FILENAME)
  const deny = (): never => {
    throw new Error(canAdoptImportedMasterKey(userData)
      ? '本机已存在不同的备份密钥；为防覆盖已中止导入，现有密钥未变更。如这是新电脑的首次恢复，请在「自动备份」区用「从网络备份恢复」并确认「采用恢复密钥（隔离本机初始备份）」，本机现有密钥与本地备份会先移入隔离目录'
      : '本机已存在不同的备份密钥；为防覆盖已中止导入，现有密钥未变更。如确认要换用导入密钥，请先手动迁移现有备份目录后再导入')
  }
  if (existsSync(wrappedPath)) {
    let current: Buffer | null = null
    let probeError: string | null = null
    try { current = readMasterKeyFromWrapped(userData, box) } catch (e) { probeError = String(e) }
    if (current && timingSafeEqual(current, importedKey)) {
      return { status: 'matched', fingerprint: masterKeyFingerprint(current) }
    }
    if (!opts?.adopt) {
      // 解封失败（provider 不匹配/包装密钥丢失）时原样抛出，其指导性更强
      if (probeError) throw new Error(probeError)
      deny()
    }
    if (!canAdoptImportedMasterKey(userData)) {
      throw new Error('本机备份密钥并非首次启动时自动生成，采用流程不可用（防覆盖现有真实备份历史）；如需换用该恢复密钥，请手动迁移现有备份目录')
    }
    return adoptImportedMasterKey(userData, importedKey, box, opts?.now ?? new Date())
  }
  if (existsSync(legacyPath)) {
    const legacy = readFileSync(legacyPath)
    if (legacy.length === MASTER_KEY_LENGTH && !timingSafeEqual(legacy, importedKey)) deny()
    writeWrappedKey(userData, importedKey, box, 'imported')
    purgeLegacyKeyFile(legacyPath)
    return { status: 'matched', fingerprint: masterKeyFingerprint(importedKey) }
  }
  writeWrappedKey(userData, importedKey, box, 'imported')
  return { status: 'installed', fingerprint: masterKeyFingerprint(importedKey) }
}

// ─── 恢复密钥导出件（口令 scrypt KEK + AES-256-GCM 主密钥）──────────────────

export function masterKeyFingerprint(masterKey: Buffer): string {
  return createHash('sha256').update(assertMasterKey(masterKey)).digest('hex').slice(0, 16)
}

function assertPassphrase(passphrase: string): string {
  if (typeof passphrase !== 'string' || passphrase.length < RECOVERY_PASSPHRASE_MIN_LENGTH) {
    throw new Error(`恢复密钥口令至少 ${RECOVERY_PASSPHRASE_MIN_LENGTH} 位；恢复密钥是跨机器恢复的唯一凭证`)
  }
  return passphrase
}

function deriveKek(passphrase: string, salt: Buffer, params: { N: number; r: number; p: number }): Buffer {
  return scryptSync(passphrase.normalize('NFKC'), salt, MASTER_KEY_LENGTH, {
    N: params.N, r: params.r, p: params.p, maxmem: Math.max(SCRYPT_MAXMEM, 128 * params.N * params.r * 2)
  })
}

/** 生成恢复密钥导出件（JSON，可直接写盘；文件内容不含明文主密钥） */
export function buildRecoveryKeyExport(masterKey: Buffer, passphrase: string, opts?: { now?: Date }): RecoveryKeyExport {
  assertPassphrase(passphrase)
  const salt = randomBytes(SALT_LENGTH)
  const kek = deriveKek(passphrase, salt, RECOVERY_SCRYPT_PARAMS)
  const nonce = randomBytes(NONCE_LENGTH)
  const cipher = createCipheriv(CIPHER_ALGORITHM, kek, nonce)
  const encrypted = Buffer.concat([cipher.update(assertMasterKey(masterKey)), cipher.final()])
  return {
    magic: RECOVERY_KEY_MAGIC,
    formatVersion: RECOVERY_FORMAT_VERSION,
    cipher: CIPHER_ALGORITHM,
    kdf: { name: 'scrypt', N: RECOVERY_SCRYPT_PARAMS.N, r: RECOVERY_SCRYPT_PARAMS.r, p: RECOVERY_SCRYPT_PARAMS.p, salt: salt.toString('base64') },
    nonce: nonce.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: encrypted.toString('base64'),
    keyFingerprint: masterKeyFingerprint(masterKey),
    createdAt: (opts?.now ?? new Date()).toISOString()
  }
}

function assertBase64Length(value: unknown, bytes: number, field: string): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error(`恢复密钥文件字段非法：${field}`)
  const decoded = Buffer.from(value, 'base64')
  if (decoded.length !== bytes) throw new Error(`恢复密钥文件字段长度非法：${field}（应为 ${bytes} 字节）`)
  return decoded
}

/** 解析并解密恢复密钥导出件 → 明文主密钥；错误口令在 GCM 认证处明确失败 */
export function importRecoveryKeyExport(raw: Buffer | string, passphrase: string): RecoveryKeyExport & { masterKey: Buffer } {
  let doc: RecoveryKeyExport
  try { doc = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8')) as RecoveryKeyExport } catch { throw new Error('恢复密钥文件损坏（非 JSON）') }
  if (doc.magic !== RECOVERY_KEY_MAGIC || doc.formatVersion !== RECOVERY_FORMAT_VERSION) throw new Error('恢复密钥文件版本不受支持')
  if (doc.cipher !== CIPHER_ALGORITHM) throw new Error('恢复密钥文件加密算法不受支持')
  const kdf = doc.kdf
  if (!kdf || kdf.name !== 'scrypt') throw new Error('恢复密钥文件 KDF 不受支持（仅支持 scrypt）')
  const { N, r, p } = kdf
  const integer = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v)
  // 导入侧限制参数范围：足够安全的前提下防恶意超大参数耗内存（scrypt 内存 ≈ 128·N·r 字节）
  if (!integer(N) || N < 16384 || N > 2 ** 21 || (N & (N - 1)) !== 0) throw new Error('恢复密钥文件 scrypt N 参数非法')
  if (!integer(r) || r < 8 || r > 64) throw new Error('恢复密钥文件 scrypt r 参数非法')
  if (!integer(p) || p < 1 || p > 8) throw new Error('恢复密钥文件 scrypt p 参数非法')
  assertPassphrase(passphrase)
  const salt = assertBase64Length(kdf.salt, SALT_LENGTH, 'kdf.salt')
  const nonce = assertBase64Length(doc.nonce, NONCE_LENGTH, 'nonce')
  const tag = assertBase64Length(doc.tag, TAG_LENGTH, 'tag')
  const data = assertBase64Length(doc.data, MASTER_KEY_LENGTH, 'data')
  const kek = deriveKek(passphrase, salt, { N, r, p })
  let masterKey: Buffer
  try {
    const decipher = createDecipheriv(CIPHER_ALGORITHM, kek, nonce)
    decipher.setAuthTag(tag)
    masterKey = Buffer.concat([decipher.update(data), decipher.final()])
  } catch {
    throw new Error('恢复密钥口令错误或文件已损坏（AES-GCM 认证失败）；本机密钥未受任何影响')
  }
  return { ...doc, masterKey: assertMasterKey(masterKey) }
}

/** 恢复密钥导出件写盘（0600） */
export function writeRecoveryKeyExportFile(filePath: string, doc: RecoveryKeyExport): void {
  atomicWritePrivate(filePath, Buffer.from(JSON.stringify(doc, null, 2)), 0o600)
}

// ─── local-wrap 回退封装（无系统安全设施时；如实以 provider 名暴露降级状态）──

/**
 * 本机随机包装密钥（首次生成后固定，0600）+ AES-256-GCM 封装主密钥。
 * 注意：包装密钥与封装件同机同目录，仅防「明文主密钥被直接扫描」，
 * 不具备 DPAPI/钥匙串的用户级绑定强度；provider 名如实写 'local-wrap-v1' 供状态展示。
 */
export function localWrapSecretBox(userData: string): SecretBox {
  const wrapKeyPath = join(userData, LOCAL_WRAP_KEY_FILENAME)
  let wrapKey: Buffer
  if (existsSync(wrapKeyPath)) {
    wrapKey = readFileSync(wrapKeyPath)
    if (wrapKey.length !== MASTER_KEY_LENGTH) throw new Error('本机密钥包装文件长度非法')
  } else {
    wrapKey = randomBytes(MASTER_KEY_LENGTH)
    atomicWritePrivate(wrapKeyPath, wrapKey, 0o600)
  }
  return {
    name: LOCAL_WRAP_PROVIDER,
    encrypt(plaintext) {
      const nonce = randomBytes(NONCE_LENGTH)
      const cipher = createCipheriv(CIPHER_ALGORITHM, wrapKey, nonce)
      return Buffer.concat([nonce, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()])
    },
    decrypt(blob) {
      if (blob.length < NONCE_LENGTH + TAG_LENGTH + 1) throw new Error('封装件数据过短')
      const nonce = blob.subarray(0, NONCE_LENGTH)
      const tag = blob.subarray(blob.length - TAG_LENGTH)
      const decipher = createDecipheriv(CIPHER_ALGORITHM, wrapKey, nonce)
      decipher.setAuthTag(tag)
      return Buffer.concat([decipher.update(blob.subarray(NONCE_LENGTH, blob.length - TAG_LENGTH)), decipher.final()])
    }
  }
}
