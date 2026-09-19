/**
 * secret-config-ipc-test.ts —— H2 回归测试：通用 config IPC 白名单 + 秘密专用端点
 *
 * 验证（用真实 ConfigService，worker 模式 = 无 Electron/safeStorage，落库为明文但语义一致）：
 *   ① 通用 config:get 无法读取任何秘密 key（decryptKey / imageAesKey / imageXorKey / wxidConfigs /
 *      authPassword / authHelloSecret / httpApiToken / aiModelApiKey / aiInsightApiKey /
 *      centralSyncDeviceToken / aiInsightWeiboCookie）；
 *   ② 通用 config:set 无法写入上述秘密 key、主进程托管状态键与未知 key；
 *   ③ 专用 secret 端点只回 hasValue/maskedValue，完整秘密不回显（报告 JSON 不含秘密原文）；
 *   ④ wxidConfigs 只以状态露出；账号切换由主进程 account:switchTo / account:applySavedKey 完成；
 *   ⑤ 删除 wxid 配置 + 主进程内存快照撤回。
 * 运行：npx tsx scripts/secret-config-ipc-test.ts
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs'

import { join } from 'path'
import { readRendererConfig, writeRendererConfig } from '../electron/services/rendererConfigPolicy'
import {
  buildSecretStatusReport, secretSetDbKey, secretSetImageKeys, secretSetHttpApiToken,
  secretSetAiModelApiKey, secretSetWxidConfig, accountSwitchTo, accountApplySavedKey,
  accountRemoveWxidConfig, accountUndoRemoveWxidConfig, resetWxidUndoStoreForTest, maskSecret,
  serviceSetAiModelBaseUrl, serviceSetAiInsightBaseUrl, serviceSetCentralSyncBaseUrl,
  serviceApplyCentralBaseUrlForClaim,
  secretSetTelegramToken, secretSetWecomWebhook, dbPathSetFromDialog, dbPathSetVerified,
  normalizeServiceUrl
} from '../electron/services/secretConfigIpc'
import {
  SECRET_CONFIG_KEYS, MAIN_MANAGED_CONFIG_KEYS, RESTRICTED_WRITE_CONFIG_KEYS,
  RENDERER_READABLE_CONFIG_KEYS, RENDERER_WRITABLE_CONFIG_KEYS,
  classifyRendererRead, classifyRendererWrite
} from '../electron/services/rendererConfigPolicy'
import { ConfigService } from '../electron/services/config'
import { tmpdir } from 'os'

/** electron-store 实例最小形状（store 属性 accessor），供故障注入拦截 */
interface ElectronStoreLike { store: Record<string, unknown> }

let pass = 0, fail = 0
function ok(name: string, cond: boolean): void {
  if (cond) { pass++ } else { fail++; console.error('FAIL:', name) }
}
function throws(fn: () => unknown): boolean {
  try { fn(); return false } catch { return true }
}

process.env.WEFLOW_WORKER = '1'
const dir = mkdtempSync(join(tmpdir(), 'secret-cfg-'))
process.env.WEFLOW_CONFIG_CWD = dir

const SECRET_KEYS = [
  'decryptKey', 'imageAesKey', 'imageXorKey', 'wxidConfigs', 'authPassword', 'authHelloSecret',
  'httpApiToken', 'aiModelApiKey', 'aiInsightApiKey', 'centralSyncDeviceToken', 'aiInsightWeiboCookie'
]
const MAIN_MANAGED = ['centralSyncWorkspaceId', 'centralSyncEmployeeId', 'centralSyncDeviceId', 'centralSyncRole', 'centralSyncDisplayName', 'centralSyncLastError', 'centralSyncLastErrorAt']

async function main(): Promise<void> {
  const config = new ConfigService()
  const DB_KEY = 'a'.repeat(64)
  const TOKEN = 'tok-' + 'x'.repeat(28)
  const AI_KEY = 'sk-' + 'y'.repeat(30)

  // ── ① 通用 config:get 拒绝读取全部秘密 key ──
  secretSetDbKey(config, DB_KEY)
  secretSetHttpApiToken(config, TOKEN)
  secretSetAiModelApiKey(config, AI_KEY)
  secretSetWxidConfig(config, 'wxid_a', { decryptKey: 'k'.repeat(64), imageAesKey: 'aes'.repeat(5), imageXorKey: 164 })
  for (const key of SECRET_KEYS) {
    ok(`1 config:get 拒绝读取秘密 key「${key}」`, throws(() => readRendererConfig(config, key)))
  }
  ok('1z config:get 正常键可读', readRendererConfig(config, 'theme') !== undefined)
  ok('1y config:get 未知键拒绝（undefined + 不抛敏感信息）', readRendererConfig(config, 'no_such_key_xyz') === undefined)

  // ── ② 通用 config:set 拒绝写入秘密 / 主进程托管 / 未知键 ──
  for (const key of SECRET_KEYS) {
    ok(`2 config:set 拒绝写入秘密 key「${key}」`, throws(() => writeRendererConfig(config, key, 'evil')))
  }
  for (const key of MAIN_MANAGED) {
    ok(`2m config:set 拒绝写入主进程托管键「${key}」`, throws(() => writeRendererConfig(config, key, 'evil')))
  }
  ok('2u config:set 拒绝未知键', throws(() => writeRendererConfig(config, 'no_such_key_xyz', 1)))
  // 秘密值未被写入
  ok('2v 尝试写入后 secret 专用值未被通用通道污染', buildSecretStatusReport(config).dbKey.hasValue === true)
  writeRendererConfig(config, 'theme', 'dark')
  ok('2w 正常键写入成功', config.get('theme') === 'dark')

  // ── ③ 专用端点只回状态，不回显完整秘密 ──
  const report = buildSecretStatusReport(config)
  ok('3a dbKey hasValue=true', report.dbKey.hasValue === true)
  ok('3b dbKey masked 非空且不含原文', report.dbKey.masked.length > 0 && !report.dbKey.masked.includes(DB_KEY))
  ok('3c httpApiToken masked 非空且不含原文', report.httpApiToken.masked.length > 0 && !report.httpApiToken.masked.includes(TOKEN))
  ok('3d aiModelApiKey masked 非空且不含原文', report.aiModelApiKey.masked.length > 0 && !report.aiModelApiKey.masked.includes(AI_KEY))
  const reportJson = JSON.stringify(report)
  ok('3e 状态报告整体不含解密密钥原文', !reportJson.includes(DB_KEY))
  ok('3f 状态报告整体不含 httpApiToken 原文', !reportJson.includes(TOKEN))
  ok('3g 状态报告整体不含 aiModelApiKey 原文', !reportJson.includes(AI_KEY))
  ok('3h 状态报告不含 wxid 配置密钥原文', !reportJson.includes('k'.repeat(64)) && !reportJson.includes('aes'.repeat(5)))

  // ── ④ wxidConfigs 状态露出 + 补丁写语义 ──
  ok('4a wxid 状态 hasDecryptKey/hasImageAesKey/hasImageXorKey', (() => {
    const s = report.wxidConfigs['wxid_a']
    return Boolean(s) && s.hasDecryptKey === true && s.hasImageAesKey === true && s.hasImageXorKey === true
  })())
  secretSetWxidConfig(config, 'wxid_a', { imageXorKey: 200 }) // 只改 xor，其他不动
  const rawAfter = (config.get('wxidConfigs') as Record<string, Record<string, unknown>>)['wxid_a']
  ok('4b 补丁只改目标字段（decryptKey 不丢失）', String(rawAfter.decryptKey) === 'k'.repeat(64))
  ok('4c 补丁字段已更新', Number(rawAfter.imageXorKey) === 200)
  secretSetWxidConfig(config, 'wxid_a', { imageAesKey: null }) // null = 清除
  const rawAfterClear = (config.get('wxidConfigs') as Record<string, Record<string, unknown>>)['wxid_a']
  ok('4d null 清除该字段', String(rawAfterClear.imageAesKey || '') === '')
  ok('4e 清除后状态 hasImageAesKey=false', buildSecretStatusReport(config).wxidConfigs['wxid_a'].hasImageAesKey === false)

  // ── ⑤ 自动连接/账号切换由主进程完成，密钥不回渲染层 ──
  config.set('myWxid', 'wxid_a')
  config.set('dbPath', join(dir, 'xwechat_files'))
  config.set('decryptKey', '')
  const auto = accountApplySavedKey(config)
  ok('5a applySavedKey 应用已保存密钥（主进程内）', auto.appliedSavedKey === true)
  ok('5b hasKey=true（全局密钥位已就绪）', auto.hasKey === true)
  ok('5c 全局密钥位 = 已保存值（主进程内部比对）', String(config.get('decryptKey')) === 'k'.repeat(64))
  ok('5d 返回状态不含密钥原文', !JSON.stringify(auto).includes('k'.repeat(64)))

  // 切换到未配置账号 → 拒绝
  ok('5e 无配置账号切换拒绝', (await accountSwitchTo(config, 'wxid_missing')).ok === false)
  // 再写一个账号并切换：密钥在主进程内换位
  secretSetWxidConfig(config, 'wxid_b', { decryptKey: 'b'.repeat(64), imageXorKey: 15 })
  const sw = await accountSwitchTo(config, 'wxid_b', { switchBusinessDbs: async () => { /* 测试桩：真实环境切业务库 */ } })
  ok('5f 切换成功', sw.ok === true)
  ok('5g 切换后全局密钥位 = wxid_b 的密钥', String(config.get('decryptKey')) === 'b'.repeat(64))
  ok('5h 切换后 myWxid = wxid_b', config.get('myWxid') === 'wxid_b')

  // ── ⑥ 删除 wxid 配置 + 主进程内存撤回 ──
  resetWxidUndoStoreForTest()
  const removed = accountRemoveWxidConfig(config, 'wxid_a')
  ok('6a 删除成功且带撤销 token', removed.ok === true && typeof removed.undoToken === 'string')
  ok('6b 删除后状态列表不再含 wxid_a', buildSecretStatusReport(config).wxidConfigs['wxid_a'] === undefined)
  const undo = accountUndoRemoveWxidConfig(config, String(removed.undoToken))
  ok('6c 撤回成功', undo.ok === true && undo.restored >= 1)
  ok('6d 撤回后 wxid_a 配置恢复（状态可见）', buildSecretStatusReport(config).wxidConfigs['wxid_a']?.hasDecryptKey === true)
  ok('6e 无效 token 撤回拒绝', accountUndoRemoveWxidConfig(config, 'bad-token').ok === false)
  ok('6f 二次撤回同一 token 拒绝（一次性）', accountUndoRemoveWxidConfig(config, String(removed.undoToken)).ok === false)

  // ── ⑦ maskSecret 基本性质 ──
  ok('7a 短值全掩', maskSecret('abc') === '••••••')
  ok('7b 长值保末 4 位', maskSecret('abcdefghij') === '••••••ghij')
  ok('7c 空值空串', maskSecret('') === '')

  // ── ⑧ P0：受限服务地址（通用 config:set 拒绝 + 专用端点凭据清除）────────────
  const RESTRICTED = ['aiModelApiBaseUrl', 'aiInsightApiBaseUrl', 'centralSyncBaseUrl', 'dbPath', 'exportPath']
  for (const key of RESTRICTED) {
    ok(`8 通用 config:set 拒绝受限地址「${key}」`, throws(() => writeRendererConfig(config, key, 'https://evil.example.com')))
  }
  ok('8z 受限地址仍可读（设置页展示）', readRendererConfig(config, 'centralSyncBaseUrl') !== undefined)

  // AI 地址变化 → 原子清除旧 Key；不变不清
  const OLD_BASE = 'https://api.old-provider.example.com'
  const NEW_BASE = 'https://api.new-provider.example.com'
  config.set('aiModelApiBaseUrl', OLD_BASE)
  secretSetAiModelApiKey(config, 'old-key-' + 'z'.repeat(20))
  const rSame = serviceSetAiModelBaseUrl(config, OLD_BASE + '/')
  ok('8a 地址不变（尾斜杠归一）不清凭据', rSame.changed === false
    && String(config.get('aiModelApiKey')).startsWith('old-key-'))
  const rChange = serviceSetAiModelBaseUrl(config, NEW_BASE)
  ok('8b 地址变化清除 aiModelApiKey 与旧 aiInsightApiKey', rChange.changed === true
    && rChange.credentialsCleared === true
    && String(config.get('aiModelApiKey') || '') === ''
    && String(config.get('aiInsightApiKey') || '') === '')
  ok('8c 旧 Key 已不存在于配置（不会随请求发往新 origin）',
    String(config.get('aiModelApiKey') || '') === '' && config.get('aiModelApiBaseUrl') === NEW_BASE)

  // 旧见解地址变化清 aiInsightApiKey
  config.set('aiInsightApiKey', 'legacy-' + 'q'.repeat(16))
  const rInsight = serviceSetAiInsightBaseUrl(config, 'https://insight.new.example.com')
  ok('8d 见解地址变化清除 aiInsightApiKey', rInsight.changed === true
    && String(config.get('aiInsightApiKey') || '') === '')

  // 中央地址变化 → 清令牌 + 绑定身份状态
  config.set('centralSyncBaseUrl', 'https://central.old.example.com')
  config.set('centralSyncDeviceToken', 'tok-old-' + 'w'.repeat(24))
  config.set('centralSyncWorkspaceId', 'ws-1')
  config.set('centralSyncEmployeeId', 'emp-1')
  config.set('centralSyncDeviceId', 'dev-1')
  config.set('centralSyncRole', 'sales')
  config.set('centralSyncDisplayName', '旧绑定')
  const rCentralSame = serviceSetCentralSyncBaseUrl(config, 'https://central.old.example.com')
  ok('8e 中央地址不变不清令牌', rCentralSame.changed === false
    && String(config.get('centralSyncDeviceToken')).startsWith('tok-old-'))
  const rCentral = serviceSetCentralSyncBaseUrl(config, 'https://central.new.example.com')
  ok('8f 中央地址变化清除设备令牌与绑定身份状态', rCentral.changed === true && rCentral.credentialsCleared === true
    && String(config.get('centralSyncDeviceToken') || '') === ''
    && String(config.get('centralSyncWorkspaceId') || '') === ''
    && String(config.get('centralSyncEmployeeId') || '') === ''
    && String(config.get('centralSyncDeviceId') || '') === ''
    && String(config.get('centralSyncRole') || '') === ''
    && String(config.get('centralSyncDisplayName') || '') === ''
    && String(config.get('centralSyncLastError') || '') === ''
    && Number(config.get('centralSyncLastErrorAt') || 0) === 0)
  ok('8g 旧设备令牌不会发往新 origin（令牌已清除）',
    String(config.get('centralSyncDeviceToken') || '') === '' && config.get('centralSyncBaseUrl') === 'https://central.new.example.com')

  // 非法协议 / 非 localhost HTTP 拒绝
  ok('8h ftp 协议拒绝', throws(() => serviceSetAiModelBaseUrl(config, 'ftp://x.example.com')))
  ok('8i 生产远端 http 拒绝', throws(() => serviceSetAiModelBaseUrl(config, 'http://api.evil.example.com')))
  ok('8j localhost http 允许（与中央客户端规则一致）',
    serviceSetAiModelBaseUrl(config, 'http://127.0.0.1:9000').changed === true)
  ok('8k normalizeServiceUrl 拒绝保留地址外的 javascript:',
    throws(() => normalizeServiceUrl('javascript:alert(1)', { field: 'x' })))

  // dbPath：非对话框批准路径不能写入
  const realDir = join(dir, 'approved-dir')
  mkdirSync(realDir, { recursive: true })
  const grantOk = (p: string, expect: 'dir' | 'file') =>
    p === realDir ? { ok: true as const } : { ok: false as const, reason: '未批准' }
  ok('8l 非批准路径写 dbPath 拒绝', dbPathSetFromDialog(config, join(dir, 'not-approved'), grantOk).ok === false)
  ok('8m 批准路径写 dbPath 成功', dbPathSetFromDialog(config, realDir, grantOk).ok === true
    && config.get('dbPath') === realDir)
  ok('8n setVerified 主进程验证不通过则拒绝', dbPathSetVerified(config, join(dir, 'anywhere'), () => ({ ok: false, reason: '与自动检测不一致' })).ok === false)

  // ── ⑨ P1a：Telegram/企微凭据专用端点 + 掩码状态 ────────────────────────────
  secretSetTelegramToken(config, 'tg-token-' + 't'.repeat(24))
  secretSetWecomWebhook(config, 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=' + 'k'.repeat(20))
  ok('9a 通用 config:get 拒绝 Telegram Token', throws(() => readRendererConfig(config, 'aiInsightTelegramToken')))
  ok('9b 通用 config:get 拒绝企微 Webhook', throws(() => readRendererConfig(config, 'aiInsightWecomWebhook')))
  ok('9c 通用 config:set 拒绝 Telegram Token', throws(() => writeRendererConfig(config, 'aiInsightTelegramToken', 'evil')))
  ok('9d 通用 config:set 拒绝企微 Webhook', throws(() => writeRendererConfig(config, 'aiInsightWecomWebhook', 'evil')))
  const rep2 = buildSecretStatusReport(config)
  ok('9e 状态只回 hasValue/masked（Telegram）', rep2.telegramToken.hasValue === true && !rep2.telegramToken.masked.includes('tg-token-'))
  ok('9f 状态只回 hasValue/masked（企微）', rep2.wecomWebhook.hasValue === true && !rep2.wecomWebhook.masked.includes('k'.repeat(20)))
  ok('9g 状态报告整体不含两个凭据原文', !JSON.stringify(rep2).includes('tg-token-') && !JSON.stringify(rep2).includes('k'.repeat(20)))
  secretSetTelegramToken(config, '')
  ok('9h 显式清除后 hasValue=false', buildSecretStatusReport(config).telegramToken.hasValue === false)

  // ── ⑩ P1a：动态凭据字段扫描（防新增秘密漏进白名单）─────────────────────────
  // ConfigSchema 全键（defaults 键集）中名称含 key/token/password/secret/cookie/webhook 的
  // 字段必须全部在 SECRET_CONFIG_KEYS 或主进程托管集合中（而非通用可读写白名单）。
  const allKeys = [...(ConfigService.ALL_CONFIG_KEYS || [])]
  ok('10a ConfigSchema 键集非空（动态扫描前提）', allKeys.length >= 100)
  const credPattern = /(key|token|password|secret|cookie|webhook)/i
  const NON_SECRET_NAME_MATCHES = ['aiModelApiMaxTokens'] // 数值上限配置，名字含 token 但非凭据
  const credKeys = allKeys.filter((k) => credPattern.test(k) && !NON_SECRET_NAME_MATCHES.includes(k))
  ok('10b 动态扫描确实发现凭据形态字段（≥11）', credKeys.length >= 11)
  // 例外清单必须真实存在于 schema 且确非秘密——防止例外演变成掩盖真实秘密键的洞
  ok('10c 例外清单字段均在 schema 且不在 SECRET_CONFIG_KEYS',
    NON_SECRET_NAME_MATCHES.every((k) => allKeys.includes(k) && !SECRET_CONFIG_KEYS.has(k)))
  for (const k of credKeys) {
    const inSecret = SECRET_CONFIG_KEYS.has(k)
    const inMainManaged = MAIN_MANAGED_CONFIG_KEYS.has(k)
    const inRestricted = RESTRICTED_WRITE_CONFIG_KEYS.has(k)
    ok(`10 凭据字段「${k}」不在通用可读写白名单`, inSecret || inMainManaged || inRestricted)
    // 正向：被显式归类（secret / 受限地址 / 主进程托管），而非落进「未知键」灰区
    ok(`10d 凭据字段「${k}」classifyRendererRead 非 allowed`, classifyRendererRead(k) !== 'allowed')
    ok(`10e 凭据字段「${k}」classifyRendererWrite 非 allowed`, classifyRendererWrite(k) !== 'allowed')
    // 行为级：通用 config:get 不回传值（秘密抛错；托管/未知键返回 undefined——总之拿不到存储值）
    let readRejected: boolean
    try { readRejected = readRendererConfig(config, k) === undefined } catch { readRejected = true }
    ok(`10f 凭据字段「${k}」通用 config:get 不回传值（抛错或 undefined）`, readRejected)
    // 行为级：通用 config:set 一律抛错拒绝，绝不落库
    ok(`10g 凭据字段「${k}」通用 config:set 抛错拒绝`, throws(() => writeRendererConfig(config, k, 'evil')))
    // 集合级：既不在可写白名单，也不在可读白名单（安全模型：秘密零回传）
    ok(`10h 凭据字段「${k}」不在 RENDERER_WRITABLE_CONFIG_KEYS`, !RENDERER_WRITABLE_CONFIG_KEYS.has(k))
    ok(`10i 凭据字段「${k}」不在 RENDERER_READABLE_CONFIG_KEYS（秘密零回传）`, !RENDERER_READABLE_CONFIG_KEYS.has(k))
  }

  // ── ⑪ P0 二审：claim 空地址 + 残留绑定 → 也必须清除（复用统一清单）──────────
  // 场景：centralSyncBaseUrl 为空，但旧绑定字段齐全（历史脏数据/半次解绑）
  config.set('centralSyncBaseUrl', '')
  config.set('centralSyncDeviceToken', 'stale-token-' + 's'.repeat(20))
  config.set('centralSyncWorkspaceId', 'ws-stale')
  config.set('centralSyncEmployeeId', 'emp-stale')
  config.set('centralSyncDeviceId', 'dev-stale')
  config.set('centralSyncRole', 'sales')
  config.set('centralSyncDisplayName', '残留绑定')
  config.set('centralSyncLastError', '旧错误')
  config.set('centralSyncLastErrorAt', 12345)
  config.set('centralSyncEnabled', true)
  const claimApply = serviceApplyCentralBaseUrlForClaim(config, 'https://central.fresh.example.com')
  ok('11 claim 空地址+残留绑定：应用新地址即触发统一清理', claimApply.credentialsCleared === true
    && config.get('centralSyncBaseUrl') === 'https://central.fresh.example.com')
  ok('11b 旧令牌与全部绑定状态清空（含残留值）',
    String(config.get('centralSyncDeviceToken') || '') === ''
    && String(config.get('centralSyncWorkspaceId') || '') === ''
    && String(config.get('centralSyncEmployeeId') || '') === ''
    && String(config.get('centralSyncDeviceId') || '') === ''
    && String(config.get('centralSyncRole') || '') === ''
    && String(config.get('centralSyncDisplayName') || '') === ''
    && String(config.get('centralSyncLastError') || '') === ''
    && Number(config.get('centralSyncLastErrorAt') || 0) === 0)
  ok('11c claim 失败语义：新地址 + 无旧凭据（旧 token 不会发往新 origin）',
    config.get('centralSyncBaseUrl') === 'https://central.fresh.example.com'
      && String(config.get('centralSyncDeviceToken') || '') === '')
  ok('11d 调度不可发送：centralSyncEnabled 已随地址切换清除',
    config.get('centralSyncEnabled') === false)

  // ── ⑫ P1 二审：地址切换单次持久化 + 故障注入 ────────────────────────────────
  // setMany 应在**一次**持久化中完成凭据清理 + 新地址写入；持久化失败（注入写盘抛错）后，
  // 内存与重载（新实例读盘）两种可观察状态都不得出现「新地址 + 旧凭据」。
  // 隔离：本节独立临时目录作为 WEFLOW_CONFIG_CWD（ConfigService 构造期读取），
  // 不与主场景 dir 共享配置文件；结束（含失败路径）时恢复环境变量并清理目录。
  const cfgDir2 = mkdtempSync(join(tmpdir(), 'secret-cfg-inject-'))
  const prevConfigCwd = process.env.WEFLOW_CONFIG_CWD
  // ConfigService 构造器是单例（已有实例时直接返回旧实例）；本节需要真正的新实例
  // （独立 store + 独立配置目录）来验证「重载读盘」，测试中显式重置单例指针，结束时还原。
  const configCtor = ConfigService as unknown as { instance?: ConfigService }
  const prevSingleton = configCtor.instance
  let originalDescriptor: (PropertyDescriptor & { set: (v: unknown) => void; get: () => unknown }) | null = null
  let holder: object | null = null
  let injectArmed = false
  try {
    process.env.WEFLOW_CONFIG_CWD = cfgDir2
    configCtor.instance = undefined
    const injected = new ConfigService()
    injected.set('centralSyncBaseUrl', 'https://central.before.example.com')
    injected.set('centralSyncDeviceToken', 'before-token-' + 'b'.repeat(20))
    injected.set('centralSyncWorkspaceId', 'ws-before')
    // 注入：下一次对底层 store 的整体赋值（持久化）抛错——沿原型链找到 accessor 定义层
    const underlying = (injected as unknown as { store: Record<string, unknown> }).store as unknown as ElectronStoreLike
    {
      let p: object | null = underlying
      for (let depth = 0; p && depth < 6 && !originalDescriptor; depth++) {
        const d = Object.getOwnPropertyDescriptor(p, 'store')
        if (d && typeof d.set === 'function' && typeof d.get === 'function') {
          originalDescriptor = d as typeof originalDescriptor
          holder = p
        } else {
          p = Object.getPrototypeOf(p)
        }
      }
    }
    if (originalDescriptor && holder) {
      injectArmed = true
      Object.defineProperty(holder, 'store', {
        configurable: true,
        get: function () { return originalDescriptor!.get.call(this) },
        set: function (v: unknown) {
          if (injectArmed) { injectArmed = false; throw new Error('injected persist failure') }
          originalDescriptor!.set.call(this, v)
        }
      })
    }
    let persistThrew = false
    try { serviceSetCentralSyncBaseUrl(injected, 'https://central.after.example.com') } catch { persistThrew = true }
    injectArmed = false // 注入只消费一次；未触发也要解除武装，避免误伤其他实例的持久化
    ok('12a 故障注入真实生效（持久化中途抛错）', Boolean(originalDescriptor) === true && persistThrew === true)
    // 内存可观察状态：不得出现「新地址 + 旧凭据」
    const memState = { url: String(injected.get('centralSyncBaseUrl') || ''), token: String(injected.get('centralSyncDeviceToken') || '') }
    ok('12b 内存状态无「新地址 + 旧凭据」组合',
      !(memState.url === 'https://central.after.example.com' && memState.token.startsWith('before-token-')))
    // 重载状态：真正的新实例（独立 store）从磁盘读——若持久化成功则新地址+空凭据；若失败则旧地址+旧凭据；两者皆安全
    configCtor.instance = undefined
    const reloaded = new ConfigService()
    const diskState = { url: String(reloaded.get('centralSyncBaseUrl') || ''), token: String(reloaded.get('centralSyncDeviceToken') || '') }
    ok('12c 重载状态无「新地址 + 旧凭据」组合',
      !(diskState.url === 'https://central.after.example.com' && diskState.token.startsWith('before-token-')))
    // 重载断言：注入生效 → 磁盘保持「旧地址 + 旧凭据」（安全旧态）；绝不出现新地址+旧凭据
    ok('12d 持久化失败后重载 = 旧地址 + 旧凭据（安全旧态）',
      diskState.url === 'https://central.before.example.com' && diskState.token.startsWith('before-token-'))
  } finally {
    // 恢复实际被覆盖的 holder（实例自身或原型层）上的原始 descriptor——而非 delete：
    // delete 只对实例自身属性生效，落到原型层时补丁会泄漏给所有 electron-store 实例。
    injectArmed = false
    if (holder && originalDescriptor) Object.defineProperty(holder, 'store', originalDescriptor)
    process.env.WEFLOW_CONFIG_CWD = prevConfigCwd
    configCtor.instance = prevSingleton
    rmSync(cfgDir2, { recursive: true, force: true })
  }
  // 恢复核验：holder 上的 get/set 已是原始函数（若只 delete 未恢复或恢复错对象，此处失败）
  const restoredDesc = holder ? Object.getOwnPropertyDescriptor(holder, 'store') : undefined
  ok('12e monkey patch 已恢复为原始 descriptor',
    Boolean(holder) && Boolean(originalDescriptor)
    && restoredDesc?.get === originalDescriptor?.get && restoredDesc?.set === originalDescriptor?.set)

  rmSync(dir, { recursive: true, force: true })
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
