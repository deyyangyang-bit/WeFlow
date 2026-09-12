/** PRD v3.4 §1.1 自动备份闭环测试。仅操作 /tmp 合成库，不接触真实业务库。 */
import {
  existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync,
  renameSync, rmSync, statSync, writeFileSync
} from 'fs'
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'crypto'
import { tmpdir } from 'os'
import { join } from 'path'
import initSqlJs from 'sql.js'
import { discoverBusinessDbs } from '../electron/services/businessDbPath'
import {
  autoBackupLocalRoot, backupDirName, listBackupDirs, restoreAutoBackup,
  runAutoBackup, validateAutoBackupManifestStructure, verifyBackupManifest, type AutoBackupManifest
} from '../electron/services/autoBackupCore'
import {
  buildRecoveryKeyExport, canAdoptImportedMasterKey, importRecoveryKeyExport, installImportedMasterKey,
  localWrapSecretBox, readWrappedKeyOrigin, RECOVERY_KEY_MAGIC, RECOVERY_SCRYPT_PARAMS, type SecretBox
} from '../electron/services/autoBackupKeyVault'
import {
  executeAutoBackup, exportAutoBackupRecoveryKey, getAutoBackupRecoveryGate, getAutoBackupStatus,
  importAutoBackupRecoveryKey, initAutoBackup, isAutoBackupRecoveryPending, lastAutoBackupSuccessAt,
  loadOrCreateAutoBackupKey, restoreLatestAutoBackup
} from '../electron/services/autoBackupService'
import { crmDbService } from '../electron/services/crmDbService'
import { salesDbService } from '../electron/services/salesDbService'

let passed = 0
let failed = 0
function check(name: string, condition: boolean, detail = ''): void {
  if (condition) { passed++; console.log(`  ✅ ${name}`) }
  else { failed++; console.log(`  ❌ ${name}${detail ? `：${detail}` : ''}`) }
}

const scratch: string[] = []
function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  scratch.push(dir)
  return dir
}

function manifestPath(root: string, dirName: string): string {
  return join(root, dirName, 'manifest.json')
}

function loadManifest(root: string, dirName: string): AutoBackupManifest {
  return JSON.parse(readFileSync(manifestPath(root, dirName), 'utf8')) as AutoBackupManifest
}

/** 目录树快照（相对路径 + 文件内容 SHA-256），用于断言「网络目录零改动」 */
function snapshotTree(root: string): string {
  const lines: string[] = []
  const walk = (dir: string, rel: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name)
      const relPath = rel ? `${rel}/${name}` : name
      if (statSync(abs).isDirectory()) { lines.push(`D ${relPath}`); walk(abs, relPath) }
      else lines.push(`F ${relPath} ${createHash('sha256').update(readFileSync(abs)).digest('hex')}`)
    }
  }
  if (existsSync(root)) walk(root, '')
  return lines.join('\n')
}

function signForTest(manifest: AutoBackupManifest, key: Buffer): void {
  const payload = JSON.stringify({ ...manifest, manifestAuth: { algorithm: 'hmac-sha256', digest: '' } })
  manifest.manifestAuth.digest = createHmac('sha256', key).update(payload).digest('hex')
}

/** 测试用 SecretBox（等价 safeStorage 适配：AES-256-GCM 封装，包装密钥只在内存） */
function makeTestBox(name: string): SecretBox {
  const wrapKey = randomBytes(32)
  return {
    name,
    encrypt(plain: Buffer): Buffer {
      const nonce = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', wrapKey, nonce)
      return Buffer.concat([nonce, cipher.update(plain), cipher.final(), cipher.getAuthTag()])
    },
    decrypt(blob: Buffer): Buffer {
      const decipher = createDecipheriv('aes-256-gcm', wrapKey, blob.subarray(0, 12))
      decipher.setAuthTag(blob.subarray(blob.length - 16))
      return Buffer.concat([decipher.update(blob.subarray(12, blob.length - 16)), decipher.final()])
    }
  }
}

async function main(): Promise<void> {
  const SQL = await initSqlJs({ locateFile: () => join(__dirname, '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm') })
  const makeDb = (marker: string): Buffer => {
    const db = new SQL.Database()
    db.run('CREATE TABLE marker (value TEXT NOT NULL)')
    db.run('INSERT INTO marker(value) VALUES (?)', [marker])
    const bytes = Buffer.from(db.export())
    db.close()
    return bytes
  }
  const readMarker = (file: string): string => {
    const db = new SQL.Database(readFileSync(file))
    try { return String(db.exec('SELECT value FROM marker')[0]?.values[0]?.[0] ?? '') } finally { db.close() }
  }
  const validateDb = (file: string): void => { void readMarker(file) }

  const data = temp('weflow-auto-data-')
  const network = temp('weflow-auto-network-')
  const key = randomBytes(32)
  const names = [
    'weflow-crm.db', 'weflow-sales.db',
    'weflow-crm-wxid_alpha.db', 'weflow-sales-wxid_alpha.db',
    'weflow-crm-wxid-beta.db', 'weflow-sales-wxid-beta.db'
  ]
  for (const name of names) writeFileSync(join(data, name), makeDb(`v1:${name}`))
  writeFileSync(join(data, 'weflow-crm-wxid_alpha.db.archived-20260901.db'), makeDb('archive'))
  writeFileSync(join(data, 'weflow-sales-wxid_alpha.db.tmp'), makeDb('temp'))

  console.log('\n═══ A. 全量发现、加密与双层同件 ═══')
  const discovered = discoverBusinessDbs(data)
  check('发现 legacy 双库及全部 wxid 分库', discovered.length === 6, discovered.map((x) => x.name).join(','))
  check('排除归档及临时文件', discovered.every((x) => names.includes(x.name)))

  const t0 = new Date('2026-09-07T02:00:00.000Z')
  const full = runAutoBackup({ userData: data, networkPath: network, appVersion: 'test', key, now: t0 })
  const localRoot = autoBackupLocalRoot(data)
  const fullDir = join(localRoot, full.dirName)
  check('首份为每周全量基线', full.ok && full.manifest.backupType === 'full' && full.manifest.chainIndex === 0 && full.manifest.baselineId === full.manifest.backupId)
  check('全量包含 6 个逻辑文件', full.manifest.files.length === 6)
  check('全量基线墓碑为空数组', Array.isArray(full.manifest.tombstones) && full.manifest.tombstones.length === 0)
  check('每个文件都有完整加密/映射元数据', full.manifest.files.every((f) =>
    f.logicalName.length > 0 && f.originalName === f.originalRelativePath && f.plaintextLength > 0 &&
    f.size === f.plaintextLength && f.name === f.originalName && /^[0-9a-f]{64}$/.test(f.sha256) &&
    f.algorithm === 'aes-256-gcm' && Buffer.from(f.nonce, 'base64').length === 12 &&
    Buffer.from(f.tag, 'base64').length === 16 && (f.accountSafeId === 'legacy' || f.accountSafeId.startsWith('wx-'))
  ))
  check('每个文件 nonce 独立', new Set(full.manifest.files.map((f) => f.nonce)).size === 6)
  check('manifest 不含密钥', !readFileSync(join(fullDir, 'manifest.json'), 'utf8').includes(key.toString('hex')) && !('key' in (full.manifest as unknown as Record<string, unknown>)))
  check('产物是密文而非 SQLite 明文', full.manifest.files.every((f) => readFileSync(join(fullDir, f.artifactName)).subarray(0, 16).toString() !== 'SQLite format 3\u0000'))
  check('manifest HMAC 可验证', (() => { try { verifyBackupManifest(full.manifest, key); return true } catch { return false } })())
  check('网络层成功且不影响本机结果', full.manifest.layers.local.status === 'ok' && full.manifest.layers.network.status === 'ok')
  check('本机与网络复制完全相同的已验证产物', readdirSync(fullDir).every((name) =>
    readFileSync(join(fullDir, name)).equals(readFileSync(join(network, full.dirName, name)))
  ))

  console.log('\n═══ B. 每日逻辑增量与每周新基线 ═══')
  writeFileSync(join(data, 'weflow-crm-wxid_alpha.db'), makeDb('v2:alpha-crm'))
  const inc1 = runAutoBackup({ userData: data, networkPath: network, appVersion: 'test', key, now: new Date(t0.getTime() + 86400000) })
  check('次日生成逻辑增量', inc1.manifest.backupType === 'incremental' && inc1.manifest.files.length === 1)
  check('增量引用基线及前序', inc1.manifest.baselineId === full.manifest.backupId && inc1.manifest.previousBackupId === full.manifest.backupId && inc1.manifest.chainIndex === 1)
  writeFileSync(join(data, 'weflow-sales-wxid-beta.db'), makeDb('v2:beta-sales'))
  const inc2 = runAutoBackup({ userData: data, appVersion: 'test', key, now: new Date(t0.getTime() + 2 * 86400000) })
  check('第二增量只保存再次变化文件', inc2.manifest.backupType === 'incremental' && inc2.manifest.files.length === 1 && inc2.manifest.previousBackupId === inc1.manifest.backupId)
  const weekly = runAutoBackup({ userData: data, appVersion: 'test', key, now: new Date(t0.getTime() + 7 * 86400000) })
  check('跨周自动创建新全量基线', weekly.manifest.backupType === 'full' && weekly.manifest.files.length === 6 && weekly.manifest.previousBackupId === null)

  console.log('\n═══ C. 全链恢复与错误密钥 ═══')
  const target = temp('weflow-auto-restore-')
  const restored = await restoreAutoBackup({ backupRoot: localRoot, targetUserData: target, key, backupId: inc2.manifest.backupId, validateDatabase: validateDb })
  check('自动组合全量与后续增量并完整恢复', restored.ok && restored.restoredFiles.length === 6)
  check('恢复内容包含两次增量结果', readMarker(join(target, 'weflow-crm-wxid_alpha.db')) === 'v2:alpha-crm' && readMarker(join(target, 'weflow-sales-wxid-beta.db')) === 'v2:beta-sales')
  writeFileSync(join(target, 'weflow-crm.db'), makeDb('formal-unchanged'))
  const wrongKey = await restoreAutoBackup({ backupRoot: localRoot, targetUserData: target, key: randomBytes(32), backupId: inc2.manifest.backupId, validateDatabase: validateDb })
  check('错误密钥拒绝恢复', !wrongKey.ok)
  check('错误密钥后正式库不变', readMarker(join(target, 'weflow-crm.db')) === 'formal-unchanged')
  const invalidDb = await restoreAutoBackup({
    backupRoot: localRoot,
    targetUserData: target,
    key,
    backupId: inc2.manifest.backupId,
    validateDatabase: () => { throw new Error('模拟数据库无法打开') }
  })
  check('数据库打开验证失败时拒绝替换', !invalidDb.ok)
  check('数据库打开验证失败后正式库不变', readMarker(join(target, 'weflow-crm.db')) === 'formal-unchanged')

  console.log('\n═══ D. 篡改、缺链与失败原子性 ═══')
  const assertFailedUnchanged = async (name: string, backupId: string): Promise<void> => {
    writeFileSync(join(target, 'weflow-crm.db'), makeDb('formal-unchanged'))
    const result = await restoreAutoBackup({ backupRoot: localRoot, targetUserData: target, key, backupId, validateDatabase: validateDb })
    check(`${name}拒绝恢复`, !result.ok, result.error || '')
    check(`${name}后正式库不变`, readMarker(join(target, 'weflow-crm.db')) === 'formal-unchanged')
  }

  const fullManifestFile = manifestPath(localRoot, full.dirName)
  const originalManifest = readFileSync(fullManifestFile)
  const altered = loadManifest(localRoot, full.dirName)
  altered.trigger = 'tampered'
  writeFileSync(fullManifestFile, JSON.stringify(altered))
  await assertFailedUnchanged('manifest 篡改', inc2.manifest.backupId)
  writeFileSync(fullManifestFile, originalManifest)

  const cipherEntry = full.manifest.files[0]
  const cipherPath = join(fullDir, cipherEntry.artifactName)
  const originalCipher = readFileSync(cipherPath)
  const changedCipher = Buffer.from(originalCipher)
  changedCipher[0] ^= 0xff
  writeFileSync(cipherPath, changedCipher)
  await assertFailedUnchanged('密文/GCM 篡改', inc2.manifest.backupId)
  writeFileSync(cipherPath, originalCipher)

  const shaManifest = loadManifest(localRoot, full.dirName)
  shaManifest.files[0].sha256 = '0'.repeat(64)
  signForTest(shaManifest, key)
  writeFileSync(fullManifestFile, JSON.stringify(shaManifest))
  await assertFailedUnchanged('明文哈希错误', inc2.manifest.backupId)
  writeFileSync(fullManifestFile, originalManifest)

  const hiddenInc1 = join(localRoot, `hidden-${inc1.dirName}`)
  renameSync(join(localRoot, inc1.dirName), hiddenInc1)
  await assertFailedUnchanged('增量链缺失', inc2.manifest.backupId)
  renameSync(hiddenInc1, join(localRoot, inc1.dirName))

  const hiddenFull = join(localRoot, `hidden-${full.dirName}`)
  renameSync(join(localRoot, full.dirName), hiddenFull)
  await assertFailedUnchanged('全量基线缺失', inc2.manifest.backupId)
  renameSync(hiddenFull, join(localRoot, full.dirName))

  console.log('\n═══ E. 网络失败隔离与引用安全轮转 ═══')
  const unreachable = join(temp('weflow-auto-parent-'), 'not-mounted')
  const netFail = runAutoBackup({ userData: data, networkPath: unreachable, appVersion: 'test', key, now: new Date(t0.getTime() + 8 * 86400000) })
  check('网络不可达不影响本地备份成功', netFail.ok && netFail.manifest.layers.local.status === 'ok' && netFail.manifest.layers.network.status === 'skipped_unreachable')
  check('网络错误与本地结果分别返回', netFail.networkError === '网络备份路径不可达' && !existsSync(unreachable) && existsSync(join(localRoot, netFail.dirName, 'manifest.json')))

  const rotationData = temp('weflow-auto-rotation-')
  writeFileSync(join(rotationData, 'weflow-crm.db'), makeDb('r1'))
  writeFileSync(join(rotationData, 'weflow-sales.db'), makeDb('r1'))
  const rotationKey = randomBytes(32)
  const rb = runAutoBackup({ userData: rotationData, appVersion: 'test', key: rotationKey, keep: 1, now: t0 })
  writeFileSync(join(rotationData, 'weflow-crm.db'), makeDb('r2'))
  const ri = runAutoBackup({ userData: rotationData, appVersion: 'test', key: rotationKey, keep: 1, now: new Date(t0.getTime() + 86400000) })
  check('轮转不删除仍被增量引用的基线', listBackupDirs(autoBackupLocalRoot(rotationData)).includes(rb.dirName) && listBackupDirs(autoBackupLocalRoot(rotationData)).includes(ri.dirName))

  // ─── 密钥安全（autoBackupKeyVault）：F service 装配 / G 封装迁移 / H 恢复密钥导出导入 ───

  console.log('\n═══ F. Service 落盘门禁与封装密钥文件 ═══')
  const serviceData = temp('weflow-auto-service-')
  writeFileSync(join(serviceData, 'weflow-crm.db'), makeDb('service-crm'))
  writeFileSync(join(serviceData, 'weflow-sales.db'), makeDb('service-sales'))
  const key1 = loadOrCreateAutoBackupKey(serviceData)
  const key2 = loadOrCreateAutoBackupKey(serviceData)
  check('密钥固定 256 bit 且多次装载一致', key1.length === 32 && key1.equals(key2))
  check('不再长期保存明文主密钥（auto-backup.key 不存在）', !existsSync(join(serviceData, 'auto-backup.key')))
  const wrappedRaw = readFileSync(join(serviceData, 'auto-backup.key.wrapped'), 'utf8')
  check('密钥以封装件存放且不含明文密钥材料', existsSync(join(serviceData, 'auto-backup.key.wrapped')) &&
    !wrappedRaw.includes(key1.toString('hex')) && !wrappedRaw.includes(key1.toString('base64')))

  const originalCrmPersistStrict = crmDbService.persistNowStrict
  const originalSalesFlushStrict = salesDbService.flushNowStrict
  const originalAuditCreate = crmDbService.create
  let crmPersisted = 0
  let salesFlushed = 0
  let auditDetail = ''
  try {
    ;(crmDbService as any).persistNowStrict = () => { crmPersisted++ }
    ;(salesDbService as any).flushNowStrict = () => { salesFlushed++ }
    ;(crmDbService as any).create = (_entity: string, row: { detail?: string }) => { auditDetail = row.detail || ''; return { id: 1 } }
    initAutoBackup({
      userData: serviceData,
      appVersion: 'test',
      config: { get: (name: string) => name === 'autoBackupNetworkPath' ? '' : undefined } as any
    })
    const serviceResult = executeAutoBackup('manual')
    check('备份前执行 CRM persistNowStrict 与 Sales flushNowStrict', serviceResult.ok && crmPersisted === 1 && salesFlushed === 1)

    // Service 级恢复密钥导出/导入（同一台机器：正确口令 matched；错误口令明确失败）
    const exportPath = join(temp('weflow-auto-recovery-'), 'recovery.json')
    const exported = exportAutoBackupRecoveryKey(exportPath, 'service-passphrase-1')
    const exportJson = readFileSync(exportPath, 'utf8')
    const exportDoc = JSON.parse(exportJson) as Record<string, unknown>
    const exportKdf = exportDoc.kdf as Record<string, unknown>
    check('Service 导出恢复密钥文件（含指纹）', exported.filePath === exportPath && exported.fingerprint.length === 16)
    check('导出件含 magic/版本/KDF 参数/salt/nonce/tag/data', exportDoc.magic === RECOVERY_KEY_MAGIC && exportDoc.formatVersion === 1 &&
      exportKdf.name === 'scrypt' && exportKdf.N === RECOVERY_SCRYPT_PARAMS.N && typeof exportKdf.salt === 'string' &&
      typeof exportDoc.nonce === 'string' && typeof exportDoc.tag === 'string' && typeof exportDoc.data === 'string')
    check('导出件不含明文主密钥', !exportJson.includes(key1.toString('hex')) && !exportJson.includes(key1.toString('base64')))
    let wrongPassError = ''
    try { importAutoBackupRecoveryKey(exportPath, 'wrong-passphrase!') } catch (e) { wrongPassError = String(e) }
    check('Service 导入错误口令明确失败', wrongPassError.includes('口令错误') && wrongPassError.includes('本机密钥未受任何影响'), wrongPassError)
    const reimported = importAutoBackupRecoveryKey(exportPath, 'service-passphrase-1')
    check('Service 导入正确口令与本机密钥一致（matched）', reimported.status === 'matched' && reimported.fingerprint === exported.fingerprint)
  } finally {
    ;(crmDbService as any).persistNowStrict = originalCrmPersistStrict
    ;(salesDbService as any).flushNowStrict = originalSalesFlushStrict
    ;(crmDbService as any).create = originalAuditCreate
  }
  check('审计记录带备份类型与墓碑字段', auditDetail.includes('"ok":true') && auditDetail.includes('tombstones'))
  const status = getAutoBackupStatus()
  check('状态含密钥封装方式', status.keyProtection === 'local-wrap-v1')

  console.log('\n═══ G. 本机密钥封装、旧明文件迁移与错误封装拒绝 ═══')
  const boxA = makeTestBox('test-box-A')
  const vaultData = temp('weflow-auto-vault-')
  const vaultKey1 = loadOrCreateAutoBackupKey(vaultData, boxA)
  const vaultKey2 = loadOrCreateAutoBackupKey(vaultData, boxA)
  check('封装件生成且密钥稳定', vaultKey1.length === 32 && vaultKey1.equals(vaultKey2) && existsSync(join(vaultData, 'auto-backup.key.wrapped')))
  check('封装路径不产生明文主密钥文件', !existsSync(join(vaultData, 'auto-backup.key')))

  const legacyData = temp('weflow-auto-vault-legacy-')
  const legacyKey = randomBytes(32)
  writeFileSync(join(legacyData, 'auto-backup.key'), legacyKey, { mode: 0o600 })
  const migratedKey = loadOrCreateAutoBackupKey(legacyData, boxA)
  check('旧明文密钥读取即迁移且值不变', migratedKey.equals(legacyKey) && existsSync(join(legacyData, 'auto-backup.key.wrapped')))
  check('旧明文密钥文件已删除（不再长期保存）', !existsSync(join(legacyData, 'auto-backup.key')))

  const boxASubstitute = makeTestBox('test-box-A')
  let substituteError = ''
  try { loadOrCreateAutoBackupKey(vaultData, boxASubstitute) } catch (e) { substituteError = String(e) }
  check('错误包装密钥解封明确失败', substituteError.includes('解封失败'), substituteError)
  const boxOther = makeTestBox('test-box-B')
  let providerError = ''
  try { loadOrCreateAutoBackupKey(vaultData, boxOther) } catch (e) { providerError = String(e) }
  check('封装设施不匹配明确报错（不盲猜）', providerError.includes('无法解封') && providerError.includes('导入恢复密钥'), providerError)

  console.log('\n═══ H. 恢复密钥导出/导入：口令、篡改与防覆盖 ═══')
  const exportKey = randomBytes(32)
  const exportDocCore = buildRecoveryKeyExport(exportKey, 'correct-horse-passphrase')
  check('导出件版本与 KDF 参数完整', exportDocCore.magic === RECOVERY_KEY_MAGIC && exportDocCore.formatVersion === 1 &&
    exportDocCore.kdf.name === 'scrypt' && exportDocCore.kdf.N === RECOVERY_SCRYPT_PARAMS.N && exportDocCore.kdf.r === 8 && exportDocCore.kdf.p === 1)
  check('导出件 salt/nonce/tag/data 长度合法', Buffer.from(exportDocCore.kdf.salt, 'base64').length === 16 &&
    Buffer.from(exportDocCore.nonce, 'base64').length === 12 && Buffer.from(exportDocCore.tag, 'base64').length === 16 &&
    Buffer.from(exportDocCore.data, 'base64').length === 32)
  const exportJsonCore = JSON.stringify(exportDocCore)
  check('导出件不含明文主密钥', !exportJsonCore.includes(exportKey.toString('hex')) && !exportJsonCore.includes(exportKey.toString('base64')))

  const importedOk = importRecoveryKeyExport(exportJsonCore, 'correct-horse-passphrase')
  check('正确口令解出同一主密钥', importedOk.masterKey.equals(exportKey))
  let wrongPass = ''
  try { importRecoveryKeyExport(exportJsonCore, 'wrong-passphrase!!') } catch (e) { wrongPass = String(e) }
  check('错误口令明确失败（GCM 认证）', wrongPass.includes('口令错误'), wrongPass)
  const tamperedDoc = { ...exportDocCore, data: Buffer.from(exportDocCore.data, 'base64') }
  tamperedDoc.data[0] ^= 0xff
  let tamperError = ''
  try { importRecoveryKeyExport(JSON.stringify({ ...exportDocCore, data: tamperedDoc.data.toString('base64') }), 'correct-horse-passphrase') } catch (e) { tamperError = String(e) }
  check('导出件被篡改明确失败', tamperError.includes('口令错误'), tamperError)
  let shortPass = ''
  try { buildRecoveryKeyExport(exportKey, 'short') } catch (e) { shortPass = String(e) }
  check('弱口令拒绝导出', shortPass.includes('至少 8 位'), shortPass)

  const hostData = temp('weflow-auto-vault-host-')
  const hostOwnKey = randomBytes(32)
  installImportedMasterKey(hostData, hostOwnKey, boxA)
  const wrappedBefore = readFileSync(join(hostData, 'auto-backup.key.wrapped'))
  let overwriteError = ''
  try { installImportedMasterKey(hostData, exportKey, boxA) } catch (e) { overwriteError = String(e) }
  check('导入不同主密钥拒绝覆盖现有密钥', overwriteError.includes('已中止导入') && overwriteError.includes('未变更'), overwriteError)
  check('拒绝覆盖后封装件零变更', readFileSync(join(hostData, 'auto-backup.key.wrapped')).equals(wrappedBefore))
  const matched = installImportedMasterKey(hostData, hostOwnKey, boxA)
  check('导入相同主密钥幂等（matched）', matched.status === 'matched')

  const freshMachine = temp('weflow-auto-vault-fresh-')
  const freshImport = installImportedMasterKey(freshMachine, exportKey, boxA)
  const freshLoaded = loadOrCreateAutoBackupKey(freshMachine, boxA)
  check('全新机器导入安装为主密钥', freshImport.status === 'installed' && freshLoaded.equals(exportKey))

  console.log('\n═══ I. 新机器导入恢复密钥后恢复网络备份 / 错误主密钥 ═══')
  const machineA = temp('weflow-auto-machineA-')
  const networkI = temp('weflow-auto-networkI-')
  const keyI = randomBytes(32)
  const machineANames = [
    'weflow-crm.db', 'weflow-sales.db',
    'weflow-crm-wxid_alpha.db', 'weflow-sales-wxid_alpha.db',
    'weflow-crm-wxid_beta.db', 'weflow-sales-wxid_beta.db'
  ]
  for (const name of machineANames) writeFileSync(join(machineA, name), makeDb(`v1:${name}`))
  const fullI = runAutoBackup({ userData: machineA, networkPath: networkI, appVersion: 'test', key: keyI, now: t0 })
  writeFileSync(join(machineA, 'weflow-crm-wxid_alpha.db'), makeDb('v2:alpha-crm-newmachine'))
  const incI = runAutoBackup({ userData: machineA, networkPath: networkI, appVersion: 'test', key: keyI, now: new Date(t0.getTime() + 86400000) })
  check('旧机器双备份均已复制到网络层', listBackupDirs(networkI).includes(fullI.dirName) && listBackupDirs(networkI).includes(incI.dirName))

  const machineB = temp('weflow-auto-machineB-')
  const recoveryDoc = buildRecoveryKeyExport(keyI, 'cross-machine-passphrase')
  const importedB = installImportedMasterKey(machineB, importRecoveryKeyExport(JSON.stringify(recoveryDoc), 'cross-machine-passphrase').masterKey, boxA)
  const keyB = loadOrCreateAutoBackupKey(machineB, boxA)
  const restoredB = await restoreAutoBackup({ backupRoot: networkI, targetUserData: machineB, key: keyB, backupId: incI.manifest.backupId, validateDatabase: validateDb })
  check('新机器导入恢复密钥后从网络层完整恢复', importedB.status === 'installed' && keyB.equals(keyI) && restoredB.ok && restoredB.restoredFiles.length === 6, restoredB.error || '')
  check('新机器恢复内容为链末端状态（含增量结果）',
    readMarker(join(machineB, 'weflow-crm-wxid_alpha.db')) === 'v2:alpha-crm-newmachine' &&
    readMarker(join(machineB, 'weflow-sales.db')) === 'v1:weflow-sales.db' &&
    readMarker(join(machineB, 'weflow-crm-wxid_beta.db')) === 'v1:weflow-crm-wxid_beta.db')

  const machineC = temp('weflow-auto-machineC-')
  const keyC = loadOrCreateAutoBackupKey(machineC, makeTestBox('test-box-C'))
  writeFileSync(join(machineC, 'weflow-crm.db'), makeDb('canary'))
  const restoredC = await restoreAutoBackup({ backupRoot: networkI, targetUserData: machineC, key: keyC, validateDatabase: validateDb })
  check('错误主密钥拒绝恢复他人网络备份', !restoredC.ok)
  check('错误主密钥恢复失败后本机文件不变', readMarker(join(machineC, 'weflow-crm.db')) === 'canary')

  console.log('\n═══ J. 刷盘失败立即终止本轮备份（不生成成功 manifest / 不更新成功时间）═══')
  const flushData = temp('weflow-auto-flush-')
  writeFileSync(join(flushData, 'weflow-crm.db'), makeDb('flush-crm'))
  writeFileSync(join(flushData, 'weflow-sales.db'), makeDb('flush-sales'))
  const flushRoot = autoBackupLocalRoot(flushData)
  initAutoBackup({
    userData: flushData,
    appVersion: 'test',
    config: { get: (name: string) => name === 'autoBackupNetworkPath' ? '' : undefined } as any
  })
  const dirsBeforeFlushTest = listBackupDirs(flushRoot).length
  const successAt1 = lastAutoBackupSuccessAt(flushData)

  const originalCrmStrict2 = crmDbService.persistNowStrict
  const originalSalesStrict2 = salesDbService.flushNowStrict
  const originalAuditCreate2 = crmDbService.create
  const auditRows: Array<{ ok?: boolean; stage?: string; error?: string }> = []
  let jSalesFlushed = 0
  try {
    ;(crmDbService as any).persistNowStrict = () => { throw new Error('模拟 CRM 落盘失败') }
    ;(salesDbService as any).flushNowStrict = () => { jSalesFlushed++ }
    ;(crmDbService as any).create = (_entity: string, row: { detail?: string }) => { auditRows.push(JSON.parse(row.detail || '{}')); return { id: 1 } }
    const flushFail = executeAutoBackup('manual')
    check('CRM 刷盘失败：本轮备份失败并带阶段', !flushFail.ok && flushFail.stage === 'flush_crm', flushFail.error || '')
    check('失败原因含具体库与终止语义', (flushFail.error || '').includes('CRM') && (flushFail.error || '').includes('未生成任何备份'))
    check('sales 刷盘未执行（短路）', jSalesFlushed === 0)
    check('本轮未生成任何备份目录', listBackupDirs(flushRoot).length === dirsBeforeFlushTest)
    check('成功时间未被更新', lastAutoBackupSuccessAt(flushData) === successAt1)

    ;(crmDbService as any).persistNowStrict = originalCrmStrict2
    ;(salesDbService as any).flushNowStrict = () => { throw new Error('模拟 Sales 落盘失败') }
    const salesFail = executeAutoBackup('manual')
    check('Sales 刷盘失败：本轮备份失败并带阶段', !salesFail.ok && salesFail.stage === 'flush_sales', salesFail.error || '')
    check('Sales 刷盘失败同样不产生备份目录', listBackupDirs(flushRoot).length === dirsBeforeFlushTest)
    check('刷盘失败审计带阶段与错误', auditRows.length >= 2 && auditRows.every((r) => r.ok === false && (r.stage === 'flush_crm' || r.stage === 'flush_sales')))
  } finally {
    ;(crmDbService as any).persistNowStrict = originalCrmStrict2
    ;(salesDbService as any).flushNowStrict = originalSalesStrict2
    ;(crmDbService as any).create = originalAuditCreate2
  }
  const recovered = executeAutoBackup('manual')
  check('刷盘恢复后备份照常成功且成功时间推进', recovered.ok && lastAutoBackupSuccessAt(flushData) > successAt1)

  console.log('\n═══ K. 增量删除墓碑：记录 / 不复活 / 重建恢复 ═══')
  const tombData = temp('weflow-auto-tomb-')
  writeFileSync(join(tombData, 'weflow-crm.db'), makeDb('t-crm'))
  writeFileSync(join(tombData, 'weflow-sales.db'), makeDb('t-sales'))
  writeFileSync(join(tombData, 'weflow-crm-wxid_beta.db'), makeDb('t-beta'))
  const tombKey = randomBytes(32)
  const tombFull = runAutoBackup({ userData: tombData, appVersion: 'test', key: tombKey, now: t0 })
  const betaLogical = `crm:wx-${createHash('sha256').update('wxid_beta').digest('hex').slice(0, 16)}`
  rmSync(join(tombData, 'weflow-crm-wxid_beta.db'))
  const tombInc = runAutoBackup({ userData: tombData, appVersion: 'test', key: tombKey, now: new Date(t0.getTime() + 86400000) })
  check('基线中被删除的库记录为增量墓碑', tombInc.manifest.backupType === 'incremental' && tombInc.manifest.files.length === 0 &&
    tombInc.manifest.tombstones?.length === 1 && tombInc.manifest.tombstones[0].logicalName === betaLogical &&
    tombInc.manifest.tombstones[0].originalName === 'weflow-crm-wxid_beta.db')
  const tombTarget = temp('weflow-auto-tomb-restore-')
  writeFileSync(join(tombTarget, 'weflow-crm-wxid_beta.db'), makeDb('stale-residue'))
  const tombRestored = await restoreAutoBackup({ backupRoot: autoBackupLocalRoot(tombData), targetUserData: tombTarget, key: tombKey, backupId: tombInc.manifest.backupId, validateDatabase: validateDb })
  check('恢复组合链时应用墓碑：已删除库不复活', tombRestored.ok && !existsSync(join(tombTarget, 'weflow-crm-wxid_beta.db')) &&
    readMarker(join(tombTarget, 'weflow-crm.db')) === 't-crm' && readMarker(join(tombTarget, 'weflow-sales.db')) === 't-sales')
  check('目标目录残留的同名旧库被清理（防复活）', tombRestored.removedFiles?.includes('weflow-crm-wxid_beta.db') === true)
  const baselineTarget = temp('weflow-auto-tomb-base-')
  const baselineRestored = await restoreAutoBackup({ backupRoot: autoBackupLocalRoot(tombData), targetUserData: baselineTarget, key: tombKey, backupId: tombFull.manifest.backupId, validateDatabase: validateDb })
  check('按基线时点恢复仍含当时存在的库（墓碑自墓碑节点起生效）', baselineRestored.ok && existsSync(join(baselineTarget, 'weflow-crm-wxid_beta.db')))
  const betaV2 = makeDb('t-beta-v2')
  writeFileSync(join(tombData, 'weflow-crm-wxid_beta.db'), betaV2)
  const tombInc3 = runAutoBackup({ userData: tombData, appVersion: 'test', key: tombKey, now: new Date(t0.getTime() + 2 * 86400000) })
  check('删除后重建：后续增量恢复新文件且墓碑清空', tombInc3.manifest.files.length === 1 && tombInc3.manifest.files[0].logicalName === betaLogical &&
    tombInc3.manifest.files[0].plaintextLength === betaV2.length && (tombInc3.manifest.tombstones?.length ?? 0) === 0)
  const rebuildTarget = temp('weflow-auto-tomb-rebuild-')
  const rebuildRestored = await restoreAutoBackup({ backupRoot: autoBackupLocalRoot(tombData), targetUserData: rebuildTarget, key: tombKey, backupId: tombInc3.manifest.backupId, validateDatabase: validateDb })
  check('重建后的库随链恢复为新内容', rebuildRestored.ok && readMarker(join(rebuildTarget, 'weflow-crm-wxid_beta.db')) === 't-beta-v2')

  console.log('\n═══ L. manifest 结构严格验证（恢复前）═══')
  const strictData = temp('weflow-auto-strict-')
  writeFileSync(join(strictData, 'weflow-crm.db'), makeDb('s-crm'))
  writeFileSync(join(strictData, 'weflow-sales.db'), makeDb('s-sales'))
  const strictKey = randomBytes(32)
  runAutoBackup({ userData: strictData, appVersion: 'test', key: strictKey, now: t0 })
  const strictRoot = autoBackupLocalRoot(strictData)
  const strictDirName = listBackupDirs(strictRoot)[0]
  const strictManifestFile = manifestPath(strictRoot, strictDirName)
  const strictOriginal = readFileSync(strictManifestFile)
  const strictTarget = temp('weflow-auto-strict-restore-')
  const expectStrictReject = async (label: string, mutate: (m: AutoBackupManifest) => void): Promise<void> => {
    writeFileSync(join(strictTarget, 'weflow-crm.db'), makeDb('formal-unchanged'))
    const manifest = loadManifest(strictRoot, strictDirName)
    mutate(manifest)
    signForTest(manifest, strictKey)
    writeFileSync(strictManifestFile, JSON.stringify(manifest))
    const result = await restoreAutoBackup({ backupRoot: strictRoot, targetUserData: strictTarget, key: strictKey, validateDatabase: validateDb })
    check(`${label} 拒绝恢复`, !result.ok, result.error || '')
    check(`${label} 后正式库不变`, readMarker(join(strictTarget, 'weflow-crm.db')) === 'formal-unchanged')
    writeFileSync(strictManifestFile, strictOriginal)
  }
  await expectStrictReject('重复 logicalName', (m) => { m.files.push({ ...m.files[0] }) })
  await expectStrictReject('originalName 路径穿越', (m) => { m.files[0].originalName = '../../evil.db'; m.files[0].name = m.files[0].originalName; m.files[0].originalRelativePath = m.files[0].originalName })
  await expectStrictReject('artifactName 与 originalName 不匹配（疑似穿越）', (m) => { m.files[0].artifactName = '../weflow-sales.db.enc' })
  await expectStrictReject('backupType 非法', (m) => { m.backupType = 'differential' as never })
  await expectStrictReject('文件条目与墓碑重名冲突', (m) => { m.tombstones = [{ logicalName: m.files[0].logicalName, originalName: m.files[0].originalName, deletedAt: new Date().toISOString() }] })
  await expectStrictReject('nonce 长度非法', (m) => { m.files[0].nonce = Buffer.from('0123456789').toString('base64') })
  await expectStrictReject('tag 长度非法', (m) => { m.files[0].tag = Buffer.alloc(15).toString('base64') })
  await expectStrictReject('plaintextLength 非法', (m) => { m.files[0].plaintextLength = 0; m.files[0].size = 0 })
  let structureError = ''
  try {
    const m = loadManifest(strictRoot, strictDirName)
    delete (m as Partial<AutoBackupManifest>).chainIndex
    validateAutoBackupManifestStructure(m)
  } catch (e) { structureError = String(e) }
  check('字段缺失（chainIndex）被结构验证拒绝', structureError.includes('chainIndex'), structureError)
  structureError = ''
  try {
    const m = loadManifest(strictRoot, strictDirName)
    m.formatVersion = 99
    validateAutoBackupManifestStructure(m)
  } catch (e) { structureError = String(e) }
  check('版本不受支持被结构验证拒绝', structureError.includes('备份格式'), structureError)
  check('未篡改的合法 manifest 通过结构验证', (() => {
    try { validateAutoBackupManifestStructure(loadManifest(strictRoot, strictDirName)); return true } catch { return false }
  })())

  console.log('\n═══ M. 增量链断裂（前序指针指错）═══')
  const brokenIncFile = manifestPath(localRoot, inc2.dirName)
  const brokenIncOriginal = readFileSync(brokenIncFile)
  const brokenInc = loadManifest(localRoot, inc2.dirName)
  brokenInc.previousBackupId = randomUuidLike()
  signForTest(brokenInc, key)
  writeFileSync(brokenIncFile, JSON.stringify(brokenInc))
  await assertFailedUnchanged('增量链前序指针失效（断裂）', inc2.manifest.backupId)
  writeFileSync(brokenIncFile, brokenIncOriginal)

  console.log('\n═══ N. 多文件替换中途失败全部回滚 ═══')
  const rollData = temp('weflow-auto-roll-src-')
  writeFileSync(join(rollData, 'weflow-crm.db'), makeDb('roll-v1-crm'))
  writeFileSync(join(rollData, 'weflow-crm-wxid_beta.db'), makeDb('roll-v1-beta'))
  writeFileSync(join(rollData, 'weflow-sales.db'), makeDb('roll-v1-sales'))
  const rollKey = randomBytes(32)
  const rollBackup = runAutoBackup({ userData: rollData, appVersion: 'test', key: rollKey, now: t0 })
  const rollTarget = temp('weflow-auto-roll-target-')
  const v0 = { crm: makeDb('roll-v0-crm'), beta: makeDb('roll-v0-beta'), sales: makeDb('roll-v0-sales') }
  writeFileSync(join(rollTarget, 'weflow-crm.db'), v0.crm)
  writeFileSync(join(rollTarget, 'weflow-crm-wxid_beta.db'), v0.beta)
  writeFileSync(join(rollTarget, 'weflow-sales.db'), v0.sales)

  // 注入：第三次 rename（weflow-sales.db 替换）失败，验证前两次已替换的文件全部回滚。
  // 注意 patch 原始 CJS 模块对象（esbuild __toESM 快照会让 namespace 改写失联）
  const fsModule = require('fs') as { renameSync: (src: string, dest: string) => void }
  const originalRename = fsModule.renameSync
  let salesRenameFailed = false
  fsModule.renameSync = (src: string, dest: string) => {
    if (!salesRenameFailed && String(dest).endsWith('weflow-sales.db') && !String(dest).includes('.auto-restore-')) {
      salesRenameFailed = true
      throw new Error('模拟替换中途失败')
    }
    return originalRename(src, dest)
  }
  try {
    const rolled = await restoreAutoBackup({ backupRoot: autoBackupLocalRoot(rollData), targetUserData: rollTarget, key: rollKey, backupId: rollBackup.manifest.backupId, validateDatabase: validateDb })
    check('替换中途失败时整体恢复失败', !rolled.ok, rolled.error || '')
    check('已替换文件全部回滚为旧内容（不出现新旧混合）',
      readMarker(join(rollTarget, 'weflow-crm.db')) === 'roll-v0-crm' && readMarker(join(rollTarget, 'weflow-crm-wxid_beta.db')) === 'roll-v0-beta')
    check('未替换文件保持旧内容', readMarker(join(rollTarget, 'weflow-sales.db')) === 'roll-v0-sales')
    check('不留临时恢复目录', !readdirSync(rollTarget).some((name) => name.startsWith('.auto-restore-')))
  } finally {
    fsModule.renameSync = originalRename
  }

  const dirTarget = temp('weflow-auto-dirblock-')
  writeFileSync(join(dirTarget, 'weflow-crm.db'), makeDb('dir-v0-crm'))
  writeFileSync(join(dirTarget, 'weflow-sales.db'), makeDb('dir-v0-sales'))
  mkdirSync(join(dirTarget, 'weflow-crm-wxid_beta.db'))
  const dirBlocked = await restoreAutoBackup({ backupRoot: autoBackupLocalRoot(rollData), targetUserData: dirTarget, key: rollKey, backupId: rollBackup.manifest.backupId, validateDatabase: validateDb })
  check('替换目标被目录占用：替换开始前整体失败', !dirBlocked.ok)
  check('目录占用场景零替换（其余库保持旧内容）', readMarker(join(dirTarget, 'weflow-crm.db')) === 'dir-v0-crm' && readMarker(join(dirTarget, 'weflow-sales.db')) === 'dir-v0-sales')

  check('同毫秒目录名确定且含毫秒', backupDirName(t0) === 'we-flow-auto-20260907-100000-000')

  console.log('\n═══ O. 新机器真实启动顺序：补跑抢先生成密钥后仍能完成跨机恢复 ═══')
  // 旧机器 A：有真实备份并推到网络层
  const oldMachine = temp('weflow-auto-oldmachine-')
  const oldNetwork = temp('weflow-auto-oldnetwork-')
  const oldKey = randomBytes(32)
  writeFileSync(join(oldMachine, 'weflow-crm.db'), makeDb('old:crm-v1'))
  writeFileSync(join(oldMachine, 'weflow-sales.db'), makeDb('old:sales-v1'))
  runAutoBackup({ userData: oldMachine, networkPath: oldNetwork, appVersion: 'test', key: oldKey, now: t0 })
  writeFileSync(join(oldMachine, 'weflow-crm.db'), makeDb('old:crm-v2'))
  runAutoBackup({ userData: oldMachine, networkPath: oldNetwork, appVersion: 'test', key: oldKey, now: new Date(t0.getTime() + 86400000) })
  const oldNetworkDirs = listBackupDirs(oldNetwork).length
  const recoveryFile = join(temp('weflow-auto-oldkey-'), 'recovery.json')
  writeFileSync(recoveryFile, JSON.stringify(buildRecoveryKeyExport(oldKey, 'old-machine-passphrase')))

  // 新机器 B：首次启动 → 10 秒后启动补跑抢先自动生成密钥并生成本机初始备份（正是真实顺序）
  const newMachine = temp('weflow-auto-newmachine-')
  writeFileSync(join(newMachine, 'weflow-crm.db'), makeDb('fresh:crm'))
  writeFileSync(join(newMachine, 'weflow-sales.db'), makeDb('fresh:sales'))
  const originalCrmStrictO = crmDbService.persistNowStrict
  const originalSalesStrictO = salesDbService.flushNowStrict
  const originalCrmPersistO = crmDbService.persistNow
  const originalSalesFlushO = salesDbService.flushNow
  const originalAuditCreateO = crmDbService.create
  try {
    // 本段不接触真实业务库：刷盘与审计全部打桩
    ;(crmDbService as any).persistNowStrict = () => { /* 打桩 */ }
    ;(salesDbService as any).flushNowStrict = () => { /* 打桩 */ }
    ;(crmDbService as any).persistNow = () => { /* 打桩 */ }
    ;(salesDbService as any).flushNow = () => { /* 打桩 */ }
    ;(crmDbService as any).create = () => ({ id: 1 })
    // 新机器首次启动时网络备份路径尚未配置（用户是在做换机恢复时才填的）
    let newMachineNetworkPath = ''
    initAutoBackup({
      userData: newMachine,
      appVersion: 'test',
      secretBox: boxA,
      config: { get: (name: string) => name === 'autoBackupNetworkPath' ? newMachineNetworkPath : undefined } as any
    })
    const bootCatchup = executeAutoBackup('startup-catchup')
    const newKeyBeforeImport = loadOrCreateAutoBackupKey(newMachine, boxA)
    check('新机器启动补跑成功并生成本机初始备份', bootCatchup.ok && listBackupDirs(autoBackupLocalRoot(newMachine)).length === 1, bootCatchup.error || '')
    check('补跑抢先自动生成的密钥与旧机器不同', !newKeyBeforeImport.equals(oldKey))
    check('门禁开放（密钥来源为本机自动生成）', canAdoptImportedMasterKey(newMachine) && readWrappedKeyOrigin(newMachine) === 'generated')

    // 默认导入必须仍然拒绝覆盖（保留「不同密钥默认拒绝」原则，不静默覆盖）
    let blockedError = ''
    try { importAutoBackupRecoveryKey(recoveryFile, 'old-machine-passphrase') } catch (e) { blockedError = String(e) }
    check('默认导入仍拒绝覆盖本机既有密钥', blockedError.includes('已中止导入') && blockedError.includes('从网络备份恢复'), blockedError)
    check('拒绝后本机密钥零变更', loadOrCreateAutoBackupKey(newMachine, boxA).equals(newKeyBeforeImport))

    // 显式恢复动作：采用恢复密钥（本机旧密钥与本地备份链先隔离）
    const adopted = importAutoBackupRecoveryKey(recoveryFile, 'old-machine-passphrase', { adopt: true })
    check('显式采用恢复密钥成功且切换为旧机器密钥', adopted.status === 'adopted' && loadOrCreateAutoBackupKey(newMachine, boxA).equals(oldKey))
    check('采用后门禁关闭（不重复采用）', !canAdoptImportedMasterKey(newMachine) && readWrappedKeyOrigin(newMachine) === 'imported')
    const quarantineDir = adopted.quarantineDir || ''
    check('隔离目录已生成', quarantineDir.length > 0 && existsSync(quarantineDir))
    check('本机旧密钥整体移入隔离目录（未删除）', existsSync(join(quarantineDir, 'key', 'auto-backup.key.wrapped')))
    check('本机初始备份链整体移入隔离目录', adopted.quarantinedBackups === 1 && readdirSync(join(quarantineDir, 'local-backups')).length === 1)
    check('隔离目录留档说明与清单', existsSync(join(quarantineDir, 'README.txt')) && existsSync(join(quarantineDir, 'quarantine.json')))
    check('隔离的本机旧密钥仍可解出（可人工恢复）', (() => {
      try {
        const env = JSON.parse(readFileSync(join(quarantineDir, 'key', 'auto-backup.key.wrapped'), 'utf8')) as { data: string }
        return boxA.decrypt(Buffer.from(env.data, 'base64')).equals(newKeyBeforeImport)
      } catch { return false }
    })())
    check('隔离清单不含密钥材料', !readFileSync(join(quarantineDir, 'quarantine.json'), 'utf8').includes(newKeyBeforeImport.toString('hex')) &&
      !readFileSync(join(quarantineDir, 'README.txt'), 'utf8').includes(newKeyBeforeImport.toString('hex')))

    // 采用后进入「等待从网络备份恢复」：自动调度不得创建新密钥或新备份
    const dirsAfterAdopt = listBackupDirs(autoBackupLocalRoot(newMachine)).length
    check('采用后进入等待恢复状态', isAutoBackupRecoveryPending(newMachine) && getAutoBackupRecoveryGate().pending)
    const scheduledWhilePending = executeAutoBackup('scheduled')
    const catchupWhilePending = executeAutoBackup('startup-catchup')
    check('等待恢复期间「每日调度」拒绝备份', !scheduledWhilePending.ok && (scheduledWhilePending.error || '').includes('等待从网络备份恢复'))
    check('等待恢复期间「启动补跑」同样拒绝备份', !catchupWhilePending.ok)
    check('等待恢复期间未生成新备份目录', listBackupDirs(autoBackupLocalRoot(newMachine)).length === dirsAfterAdopt)
    check('等待恢复期间未重新生成密钥', loadOrCreateAutoBackupKey(newMachine, boxA).equals(oldKey))
    check('状态暴露门禁信息供设置页决策', getAutoBackupStatus().recovery.pending === true && getAutoBackupStatus().recovery.canAdoptRecoveryKey === false)
    // 即使用户此时已把网络路径指向旧机器的共享目录，暂停中的调度也不会把本机空库推上去
    newMachineNetworkPath = oldNetwork
    const scheduledAfterNetworkConfigured = executeAutoBackup('startup-catchup')
    check('配置网络路径后调度仍拒绝备份（不推出空基线）', !scheduledAfterNetworkConfigured.ok && listBackupDirs(oldNetwork).length === oldNetworkDirs)

    // 换机恢复：用户在设置页填好网络备份路径后，直接点「从网络备份恢复」（省略 backupId = 最新有效链）
    newMachineNetworkPath = oldNetwork
    const restoredNew = await restoreLatestAutoBackup(undefined, 'network')
    check('新机器从网络层恢复最新有效链成功', restoredNew.ok && restoredNew.restoredFiles.length === 2, restoredNew.error || '')
    check('恢复内容为旧机器链末端状态', readMarker(join(newMachine, 'weflow-crm.db')) === 'old:crm-v2' && readMarker(join(newMachine, 'weflow-sales.db')) === 'old:sales-v1')
    check('恢复成功解除等待恢复门禁', !isAutoBackupRecoveryPending(newMachine) && getAutoBackupRecoveryGate().pending === false)
    check('新机器空库未顶掉旧机器网络备份链', listBackupDirs(oldNetwork).length === oldNetworkDirs)
  } finally {
    ;(crmDbService as any).persistNowStrict = originalCrmStrictO
    ;(salesDbService as any).flushNowStrict = originalSalesStrictO
    ;(crmDbService as any).persistNow = originalCrmPersistO
    ;(salesDbService as any).flushNow = originalSalesFlushO
    ;(crmDbService as any).create = originalAuditCreateO
  }

  console.log('\n═══ P. 旧版明文密钥清理：失败注入与残留必须明确失败 ═══')
  // patch 原始 CJS 模块对象（esbuild __toESM 快照会让 namespace 改写失联）
  const fsModuleP = require('fs') as { writeFileSync: typeof writeFileSync; rmSync: typeof rmSync }
  const originalWriteSync = fsModuleP.writeFileSync
  const originalRemoveSync = fsModuleP.rmSync
  const legacyPath = (dir: string): string => join(dir, 'auto-backup.key')

  // P1：覆写失败，但删除必须照常执行 → 明文不残留，装载成功
  const p1 = temp('weflow-auto-purge-p1-')
  const p1Key = randomBytes(32)
  writeFileSync(legacyPath(p1), p1Key, { mode: 0o600 })
  let p1Loaded: Buffer | null = null
  let p1Error = ''
  fsModuleP.writeFileSync = ((path: unknown, ...rest: unknown[]) => {
    if (String(path).endsWith('auto-backup.key')) throw new Error('模拟覆写失败')
    return (originalWriteSync as (...a: unknown[]) => unknown)(path, ...rest)
  }) as typeof writeFileSync
  try { p1Loaded = loadOrCreateAutoBackupKey(p1, boxA) } catch (e) { p1Error = String(e) } finally { fsModuleP.writeFileSync = originalWriteSync }
  check('覆写失败后仍继续执行删除', p1Error === '' && p1Loaded !== null && (p1Loaded as Buffer).equals(p1Key), p1Error)
  check('覆写失败场景下明文密钥未残留', !existsSync(legacyPath(p1)))

  // P2：删除失败且明文仍存在 → 密钥装载必须明确失败，不报成功
  const p2 = temp('weflow-auto-purge-p2-')
  const p2Key = randomBytes(32)
  writeFileSync(legacyPath(p2), p2Key, { mode: 0o600 })
  let p2Error = ''
  fsModuleP.rmSync = ((path: unknown, ...rest: unknown[]) => {
    if (String(path).endsWith('auto-backup.key')) throw new Error('模拟删除失败')
    return (originalRemoveSync as (...a: unknown[]) => unknown)(path, ...rest)
  }) as typeof rmSync
  try { loadOrCreateAutoBackupKey(p2, boxA) } catch (e) { p2Error = String(e) } finally { fsModuleP.rmSync = originalRemoveSync }
  check('删除失败且明文仍存在时密钥装载明确失败', p2Error.includes('未能删除') && p2Error.includes('auto-backup.key'), p2Error)
  check('失败信息不含任何密钥材料', !p2Error.includes(p2Key.toString('hex')) && !p2Error.includes(p2Key.toString('base64')))
  check('明文确实仍在（不谎报成功）', existsSync(legacyPath(p2)))
  const p2Retry = loadOrCreateAutoBackupKey(p2, boxA)
  check('故障解除后重试：明文被清除且密钥不变', p2Retry.equals(p2Key) && !existsSync(legacyPath(p2)))

  // P3：wrapped 与 legacy 同时存在 → wrapped 优先但不得跳过残留明文清理
  const p3 = temp('weflow-auto-purge-p3-')
  const p3Key = loadOrCreateAutoBackupKey(p3, boxA)
  writeFileSync(legacyPath(p3), p3Key, { mode: 0o600 })
  const p3Loaded = loadOrCreateAutoBackupKey(p3, boxA)
  check('wrapped 与 legacy 并存时加载成功后继续清理明文', p3Loaded.equals(p3Key) && !existsSync(legacyPath(p3)))
  const p3b = temp('weflow-auto-purge-p3b-')
  const p3bKey = loadOrCreateAutoBackupKey(p3b, boxA)
  writeFileSync(legacyPath(p3b), randomBytes(32), { mode: 0o600 })
  let p3bError = ''
  fsModuleP.rmSync = ((path: unknown, ...rest: unknown[]) => {
    if (String(path).endsWith('auto-backup.key')) throw new Error('模拟删除失败')
    return (originalRemoveSync as (...a: unknown[]) => unknown)(path, ...rest)
  }) as typeof rmSync
  try { loadOrCreateAutoBackupKey(p3b, boxA) } catch (e) { p3bError = String(e) } finally { fsModuleP.rmSync = originalRemoveSync }
  check('wrapped 优先但明文清不掉时明确失败（不因 wrapped 命中而跳过）', p3bError.includes('未能删除'), p3bError)
  check('wrapped 命中场景下本机密钥不受影响', loadOrCreateAutoBackupKey(p3b, boxA).equals(p3bKey))

  console.log('\n═══ Q. 设置页网络恢复入口（静态断言，防止前端未接线）═══')
  const settingsSource = readFileSync(join(__dirname, '..', 'src', 'pages', 'SettingsPage.tsx'), 'utf8')
  check('设置页确实调用 autoRestore({ source: "network" })', /autoRestore\(\{\s*source:\s*'network'\s*\}\)/.test(settingsSource))
  check('网络恢复不带 backupId（恢复最新有效链）', !/autoRestore\(\{[^}]*backupId/.test(settingsSource))
  check('重启交由主进程 IPC，前端不重复触发', !/relaunch/i.test(settingsSource))
  check('设置页导入恢复密钥带显式 adopt 开关', /recoveryKeyImport\(\{[^}]*adopt[^}]*\}\)/.test(settingsSource))
  check('设置页完整展示恢复失败信息', settingsSource.includes('networkRestoreError'))

  console.log('\n═══ R. local-wrap 采用恢复密钥：新旧 wrapped/wrap 各自配对，重启后仍可解封 ═══')
  // 本机走真实 local-wrap 回退（不传 secretBox = 无系统安全设施的环境）
  const wrapData = temp('weflow-auto-wrap-adopt-')
  const wrapPath = (name: string): string => join(wrapData, name)
  writeFileSync(join(wrapData, 'weflow-crm.db'), makeDb('wrap:crm'))
  writeFileSync(join(wrapData, 'weflow-sales.db'), makeDb('wrap:sales'))
  const wrapOwnKey = loadOrCreateAutoBackupKey(wrapData)
  check('local-wrap 回退：本机密钥与包装密钥成对生成',
    existsSync(wrapPath('auto-backup.key.wrapped')) && existsSync(wrapPath('auto-backup.wrap')))
  runAutoBackup({ userData: wrapData, appVersion: 'test', key: wrapOwnKey, now: t0 })
  check('local-wrap 回退：本机初始备份已生成', listBackupDirs(autoBackupLocalRoot(wrapData)).length === 1)
  // 采用前留一把绑定「旧包装密钥」的 SecretBox：等价于应用当前进程里那个闭包对象
  const oldWrapBox = localWrapSecretBox(wrapData)
  const oldWrapKeyBytes = readFileSync(wrapPath('auto-backup.wrap'))
  const wrapImportedKey = randomBytes(32)
  const wrapRecoveryFile = join(temp('weflow-auto-wrap-recovery-'), 'recovery.json')
  writeFileSync(wrapRecoveryFile, JSON.stringify(buildRecoveryKeyExport(wrapImportedKey, 'wrap-adopt-passphrase')))
  initAutoBackup({ userData: wrapData, appVersion: 'test', secretBox: undefined, config: { get: () => undefined } as any })
  const wrapAdopted = importAutoBackupRecoveryKey(wrapRecoveryFile, 'wrap-adopt-passphrase', { adopt: true })
  check('local-wrap 回退下显式采用恢复密钥成功', wrapAdopted.status === 'adopted', JSON.stringify(wrapAdopted))
  const wrapQuarantine = wrapAdopted.quarantineDir || ''
  check('隔离目录同时保留旧封装件与旧包装密钥（成对，可人工恢复）',
    existsSync(join(wrapQuarantine, 'key', 'auto-backup.key.wrapped')) && existsSync(join(wrapQuarantine, 'key', 'auto-backup.wrap')))
  check('采用后根目录重新生成配对的 wrapped 与 wrap',
    existsSync(wrapPath('auto-backup.key.wrapped')) && existsSync(wrapPath('auto-backup.wrap')))
  check('根目录包装密钥已换新（不再是被搬走的旧包装密钥）', (() => {
    try { return !readFileSync(wrapPath('auto-backup.wrap')).equals(oldWrapKeyBytes) } catch { return false }
  })())
  check('隔离的旧 wrapped 仍由旧包装密钥解出原密钥', (() => {
    try {
      const env = JSON.parse(readFileSync(join(wrapQuarantine, 'key', 'auto-backup.key.wrapped'), 'utf8')) as { data: string }
      return oldWrapBox.decrypt(Buffer.from(env.data, 'base64')).equals(wrapOwnKey)
    } catch { return false }
  })())
  check('旧闭包对象已解不开根目录新封装件（证明旧包装密钥确实失效）', (() => {
    try {
      const env = JSON.parse(readFileSync(wrapPath('auto-backup.key.wrapped'), 'utf8')) as { data: string }
      oldWrapBox.decrypt(Buffer.from(env.data, 'base64'))
      return false
    } catch { return true }
  })())
  // 模拟真实重启：丢弃旧 SecretBox 对象，重新从磁盘构造包装密钥
  let restartedKey: Buffer | null = null
  let restartedError = ''
  try { restartedKey = loadOrCreateAutoBackupKey(wrapData, localWrapSecretBox(wrapData)) } catch (e) { restartedError = String(e) }
  check('重启后重新解封成功且等于导入的恢复密钥', restartedKey !== null && (restartedKey as Buffer).equals(wrapImportedKey), restartedError)
  check('重启后（不传 box 的应用真实路径）同样解出导入密钥', loadOrCreateAutoBackupKey(wrapData).equals(wrapImportedKey))
  check('重启后密钥来源保持 imported（门禁不重复开放）', readWrappedKeyOrigin(wrapData) === 'imported')
  check('隔离说明与最终文件结构一致（写明两件必须一起移回）', (() => {
    const readme = readFileSync(join(wrapQuarantine, 'README.txt'), 'utf8')
    return readme.includes('auto-backup.key.wrapped') && readme.includes('auto-backup.wrap') && readme.includes('两者要一起移动')
  })())

  console.log('\n═══ S. 新机先配置网络路径：异密钥预检拒绝写入，采用密钥后无需删目录即可恢复 ═══')
  // 老机器：oldKey 在共享目录建立「全量 + 增量」链
  const sOldMachine = temp('weflow-auto-share-old-')
  const sNetworkRoot = temp('weflow-auto-share-network-')
  const sOldKey = randomBytes(32)
  writeFileSync(join(sOldMachine, 'weflow-crm.db'), makeDb('share:crm-v1'))
  writeFileSync(join(sOldMachine, 'weflow-sales.db'), makeDb('share:sales-v1'))
  runAutoBackup({ userData: sOldMachine, networkPath: sNetworkRoot, appVersion: 'test', key: sOldKey, now: t0 })
  writeFileSync(join(sOldMachine, 'weflow-crm.db'), makeDb('share:crm-v2'))
  runAutoBackup({ userData: sOldMachine, networkPath: sNetworkRoot, appVersion: 'test', key: sOldKey, now: new Date(t0.getTime() + 86400000) })
  const sNetworkDirs = listBackupDirs(sNetworkRoot)
  const sNetworkBefore = snapshotTree(sNetworkRoot)
  check('老机器已在共享目录建立全量+增量链', sNetworkDirs.length === 2)
  check('共享目录快照非空（确保零改动断言不是空对空）', sNetworkBefore.includes('F ') && sNetworkBefore.includes('manifest.json'))

  // 新机器：首次启动前就已把网络路径配成旧机器的共享目录（错误顺序，也是用户实际最容易做的）
  const sNewMachine = temp('weflow-auto-share-new-')
  writeFileSync(join(sNewMachine, 'weflow-crm.db'), makeDb('share:new-crm'))
  writeFileSync(join(sNewMachine, 'weflow-sales.db'), makeDb('share:new-sales'))
  const sRecoveryFile = join(temp('weflow-auto-share-key-'), 'recovery.json')
  writeFileSync(sRecoveryFile, JSON.stringify(buildRecoveryKeyExport(sOldKey, 'share-passphrase')))
  const origCrmStrictS = crmDbService.persistNowStrict
  const origSalesStrictS = salesDbService.flushNowStrict
  const origCrmPersistS = crmDbService.persistNow
  const origSalesFlushS = salesDbService.flushNow
  const origAuditCreateS = crmDbService.create
  try {
    // 本段不接触真实业务库：刷盘与审计全部打桩
    ;(crmDbService as any).persistNowStrict = () => { /* 打桩 */ }
    ;(salesDbService as any).flushNowStrict = () => { /* 打桩 */ }
    ;(crmDbService as any).persistNow = () => { /* 打桩 */ }
    ;(salesDbService as any).flushNow = () => { /* 打桩 */ }
    ;(crmDbService as any).create = () => ({ id: 1 })
    initAutoBackup({
      userData: sNewMachine,
      appVersion: 'test',
      secretBox: boxA,
      config: { get: (name: string) => name === 'autoBackupNetworkPath' ? sNetworkRoot : undefined } as any
    })
    const sBoot = executeAutoBackup('startup-catchup')
    check('新机启动补跑：本机层备份照常成功', sBoot.ok && listBackupDirs(autoBackupLocalRoot(sNewMachine)).length === 1, sBoot.error || '')
    check('网络层明确失败（拒绝向异密钥目录写入）', sBoot.manifest.layers.network.status === 'failed')
    check('失败原因说明目录不属于当前备份密钥且已拒绝写入', (() => {
      const message = sBoot.manifest.layers.network.error || ''
      return message.includes('不属于当前备份密钥') && message.includes('已拒绝写入')
    })(), sBoot.manifest.layers.network.error || '')
    check('共享目录目录集合与全部文件内容零改动', snapshotTree(sNetworkRoot) === sNetworkBefore)
    check('共享目录未新增新机器备份目录', listBackupDirs(sNetworkRoot).length === sNetworkDirs.length)
    check('新机本轮目录未出现在共享目录中', !existsSync(join(sNetworkRoot, sBoot.dirName)))
    check('新机未因网络失败而回滚本机备份', listBackupDirs(autoBackupLocalRoot(sNewMachine)).length === 1)

    // 新机显式采用旧机器恢复密钥（无需手动删除共享目录里任何东西）
    const sAdopted = importAutoBackupRecoveryKey(sRecoveryFile, 'share-passphrase', { adopt: true })
    check('新机显式采用旧机器恢复密钥成功', sAdopted.status === 'adopted' && loadOrCreateAutoBackupKey(sNewMachine, boxA).equals(sOldKey), JSON.stringify(sAdopted))
    check('采用后门禁关闭（不重复采用）', !canAdoptImportedMasterKey(sNewMachine) && readWrappedKeyOrigin(sNewMachine) === 'imported')

    // 同密钥后预检放行：直接恢复共享目录最新链，全程无需手动删除目录
    const sRestored = await restoreLatestAutoBackup(undefined, 'network')
    check('采用密钥后从共享目录恢复最新链成功（无需删目录）', sRestored.ok && sRestored.restoredFiles.length === 2, sRestored.error || '')
    check('恢复内容为老机器链末端状态', readMarker(join(sNewMachine, 'weflow-crm.db')) === 'share:crm-v2' && readMarker(join(sNewMachine, 'weflow-sales.db')) === 'share:sales-v1')
    check('恢复全程结束后共享目录仍零改动', snapshotTree(sNetworkRoot) === sNetworkBefore)
  } finally {
    ;(crmDbService as any).persistNowStrict = origCrmStrictS
    ;(salesDbService as any).flushNowStrict = origSalesStrictS
    ;(crmDbService as any).persistNow = origCrmPersistS
    ;(salesDbService as any).flushNow = origSalesFlushS
    ;(crmDbService as any).create = origAuditCreateS
  }

  console.log(`\n═══ 结果：${passed} 通过 / ${failed} 失败 ═══`)
  for (const dir of scratch) { try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ } }
  process.exit(failed ? 1 : 0)
}

function randomUuidLike(): string {
  return createHash('sha256').update(String(Math.random())).digest('hex').slice(0, 36)
}

main().catch((error) => {
  console.error(error)
  for (const dir of scratch) { try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ } }
  process.exit(1)
})
