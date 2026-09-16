/**
 * Native Windows Caddy deployment guard (cross-platform configuration checks).
 *
 * SCOPE — read this before trusting a green run:
 *   This guard runs on macOS/Linux. It validates the *configuration semantics*
 *   of `central/windows-caddy/**` by rendering the template with fixture values
 *   and asking the official Linux Caddy binary to parse the result. It does NOT
 *   and cannot validate any Windows behaviour.
 *
 *   VERIFIED HERE (cross-platform configuration verification):
 *     - template semantics: bind, tls internal, admin off, remote_ip, 403, upstream
 *     - the renderer's refusal of missing / empty / wildcard / any-CIDR values
 *     - the PowerShell scripts' command and termination boundaries
 *     - the delivery package and the archive's supply-chain identity
 *
 *   NOT VERIFIED HERE (must be measured on the Windows host):
 *     - caddy.exe execution, Windows listener behaviour, real LAN peer address
 *     - Windows PKI storage path, Windows process accounting and rollback
 *
 * It never starts Central or PostgreSQL and never touches Docker volumes.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const nativeDir = join(root, 'central/windows-caddy')
const scriptsDir = join(nativeDir, 'scripts')
const image = 'caddy:2.11.4-alpine'
const fixtureBind = '192.168.1.57'
const fixtureCidr = '192.168.1.0/24'
const fixtureHostname = 'weflow-central.test'
let pass = 0
let fail = 0

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    pass++
    console.log(`  ✅ ${name}`)
  } else {
    fail++
    console.log(`  ❌ ${name}${detail ? ` ${detail}` : ''}`)
  }
}

function run(command: string, args: string[], cwd = root): string {
  return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

const read = (...segments: string[]): string => readFileSync(join(...segments), 'utf8')

/** All PowerShell sources under scripts/, concatenated for boundary scanning. */
function allScripts(): string {
  return run('bash', ['-lc', `cat "${scriptsDir}"/*.ps1`])
}

/**
 * Render the template exactly the way `New-WeFlowRenderedCaddyfile` does, after
 * applying the same validation order the PowerShell module applies. Returns
 * undefined when a guard value must be rejected, mirroring the real behaviour of
 * `Read-WeFlowNativeEnv` throwing.
 */
function renderNativeCaddyfile(values: Record<string, string>): string | undefined {
  const required = [
    'WEFLOW_NATIVE_BIND_IP',
    'WEFLOW_NATIVE_ALLOWED_CIDR',
    'WEFLOW_NATIVE_HOSTNAME',
    'WEFLOW_NATIVE_LOG_DIR',
    'WEFLOW_NATIVE_PKI_DIR'
  ]
  for (const key of required) {
    if (!values[key] || values[key].trim() === '') return undefined
  }
  const bind = values.WEFLOW_NATIVE_BIND_IP.trim()
  if (['0.0.0.0', '::', '[::]', '*'].includes(bind)) return undefined
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(bind)) return undefined
  if (bind.split('.').some((octet) => Number(octet) > 255)) return undefined
  const cidr = values.WEFLOW_NATIVE_ALLOWED_CIDR.trim()
  if (!/^\d{1,3}(\.\d{1,3}){3}\/(\d{1,2})$/.test(cidr)) return undefined
  const [network, prefixText] = cidr.split('/')
  const prefix = Number(prefixText)
  if (prefix < 8 || prefix > 32) return undefined
  if (network.split('.').some((octet) => Number(octet) > 255)) return undefined
  if (!/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(cidr)) return undefined

  let template = read(nativeDir, 'Caddyfile.template')
  const map: Record<string, string> = {
    '{$WEFLOW_NATIVE_BIND_IP}': bind,
    '{$WEFLOW_NATIVE_ALLOWED_CIDR}': cidr,
    '{$WEFLOW_NATIVE_HOSTNAME}': values.WEFLOW_NATIVE_HOSTNAME,
    '{$WEFLOW_NATIVE_LOG_DIR}': values.WEFLOW_NATIVE_LOG_DIR,
    '{$WEFLOW_NATIVE_PKI_DIR}': values.WEFLOW_NATIVE_PKI_DIR
  }
  for (const [key, value] of Object.entries(map)) template = template.replaceAll(key, value)
  if (/\{\$/.test(template)) return undefined
  return template
}

const goodValues: Record<string, string> = {
  WEFLOW_NATIVE_BIND_IP: fixtureBind,
  WEFLOW_NATIVE_ALLOWED_CIDR: fixtureCidr,
  WEFLOW_NATIVE_HOSTNAME: fixtureHostname,
  WEFLOW_NATIVE_LOG_DIR: 'F:\\WeFlow-Test\\logs',
  WEFLOW_NATIVE_PKI_DIR: 'F:\\WeFlow-Test\\pki'
}

/** Remove PowerShell block comments so docstrings cannot satisfy a code probe. */
function stripBlockComments(source: string): string {
  return source.replace(/<#[\s\S]*?#>/g, '')
}

/**
 * Extract the argument list of every real Compose invocation.
 *
 * The scripts write each invocation as `& docker compose -p ... -f ... <sub>`,
 * with the flags continued onto the next physical line. Joining PowerShell line
 * continuations first lets the guard see the same single command the shell does.
 */
function collectComposeScope(codeOnly: string): string[] {
  const joined = codeOnly.replace(/`\s*\n\s*/g, ' ')
  return joined
    .split('\n')
    .filter((line) => /&\s*docker compose\b/.test(line))
    .map((line) => line.replace(/\s+/g, ' ').trim())
}

/**
 * True when every real Compose invocation pins both compose files.
 *
 * Acceptance is by literal filename, not by variable name: `-f $someOtherFile`
 * must fail, and so must an invocation that hard-codes a different pair. The
 * service file may name the literal directly when it must (the rollback branch
 * does), so both spellings are accepted — but only these two files.
 */
function composeScopePinsBothFiles(codeOnly: string): boolean {
  const invocations = collectComposeScope(codeOnly)
  if (invocations.length === 0) return false
  const base = /-f\s+(\$composeFileBase|docker-compose\.central\.yml)\b/
  const tls = /-f\s+(\$composeFileTls|docker-compose\.central\.tls\.yml)\b/
  return invocations.every((line) => base.test(line) && tls.test(line))
}

/**
 * Concatenated source of the deployment scripts only.
 *
 * `Test-DeploymentContract.ps1` is the Windows-side guard: by design it spells
 * out the constructs it forbids, so including it here would make every
 * "must not appear" probe fail on its own description rather than on real code.
 */
function readDeployScripts(): string {
  const names = [
    'WeFlowNative.Common.ps1',
    'Install-NativeCaddy.ps1',
    'Start-NativeCaddy.ps1',
    'Stop-NativeCaddy.ps1',
    'Test-NativeCaddyEndpoint.ps1'
  ]
  return names.map((name) => read(scriptsDir, name)).join('\n')
}

const fixture = mkdtempSync(join(tmpdir(), 'weflow-native-caddy-'))
try {
  const template = read(nativeDir, 'Caddyfile.template')
  const envExample = read(nativeDir, 'native.env.example')
  const deployDoc = read(nativeDir, '原生部署说明.md')
  const scripts = allScripts()

  console.log('== 交付目录结构 ==')
  for (const name of ['Caddyfile.template', 'native.env.example', '原生部署说明.md']) {
    check(`存在 ${name}`, existsSync(join(nativeDir, name)))
  }
  for (const name of [
    'WeFlowNative.Common.ps1',
    'Install-NativeCaddy.ps1',
    'Start-NativeCaddy.ps1',
    'Stop-NativeCaddy.ps1',
    'Test-NativeCaddyEndpoint.ps1',
    'Test-DeploymentContract.ps1'
  ]) {
    check(`存在 scripts/${name}`, existsSync(join(scriptsDir, name)))
  }
  check('未覆盖现有容器 Caddyfile', existsSync(join(root, 'central/Caddyfile')))
  check(
    '未改动现有容器 Compose 覆盖层',
    read(root, 'docker-compose.central.tls.yml').includes("${WEFLOW_CENTRAL_HTTPS_BIND:?")
  )

  console.log('\n== 模板安全语义 ==')
  check('显式 bind 到占位物理 IPv4', /bind \{\$WEFLOW_NATIVE_BIND_IP\}/.test(template))
  check('不存在通配绑定', !/^\s*bind\s+(0\.0\.0\.0|::|\[::\])\s*$/m.test(template))
  check('使用 tls internal', /\btls\s+internal\b/.test(template))
  check('未配置公网 ACME / 邮箱 / on_demand', !/\bacme_ca\b|\bemail\b|\bon_demand_tls\b/.test(template))
  check('admin off', /^\s*admin\s+off\s*$/m.test(template))
  check('auto_https disable_redirects', /\bauto_https\s+disable_redirects\b/.test(template))
  check('skip_install_trust', /\bskip_install_trust\b/.test(template))
  check('来源限制使用直接 remote_ip', /@allowed_lan\s+remote_ip\s+\{\$WEFLOW_NATIVE_ALLOWED_CIDR\}/.test(template))
  check('未使用 client_ip 兜底', !/\bclient_ip\b/.test(template))
  check('未启用 trusted_proxies', !/\btrusted_proxies\b/.test(template))
  check('未引用任何转发头', !/X-Forwarded-For|X-Real-IP/i.test(template))
  check('上游仅 127.0.0.1:8787', /reverse_proxy\s+127\.0\.0\.1:8787/.test(template))
  check('未把容器名 central:8787 当上游', !/reverse_proxy\s+central:8787/.test(template))
  check('未匹配来源 fail closed 403', /respond\s+"forbidden"\s+403/.test(template))
  check('PKI 使用官方 storage file_system 落到显式目录', /storage\s+file_system\s+"\{\$WEFLOW_NATIVE_PKI_DIR\}"/.test(template))
  check('未使用不存在的环境变量机制（无 CADDY_DATA_DIR）', !/CADDY_DATA_DIR|CADDY_CONFIG_DIR/.test(template + scripts))
  check('日志目录落到显式目录', /output\s+file\s+"\{\$WEFLOW_NATIVE_LOG_DIR\}/.test(template))
  check('日志级别 ERROR（不记请求载荷）', /^\s*level\s+ERROR\s*$/m.test(template))
  check('模板无凭据 / 私钥 / 令牌', !/Authorization|Cookie|BEGIN .*PRIVATE KEY|password/i.test(template))
  check('模板只声明 443 站点（无 :80 站点块）', !/^\s*https?:\/\/.*:80\b/m.test(template) && !/^\s*:80\b/m.test(template))

  console.log('\n== 官方 Caddy 实际解析渲染后的配置（跨平台配置验证） ==')
  const rendered = renderNativeCaddyfile(goodValues)
  check('模板可用示例值完整渲染（无残留占位符）', rendered !== undefined)
  if (rendered !== undefined) {
    check('渲染结果含显式物理 IPv4 绑定', rendered.includes(`bind ${fixtureBind}`))
    check('渲染结果含允许网段匹配器', rendered.includes(`remote_ip ${fixtureCidr}`))
    check('渲染结果含内部 CA', /\btls\s+internal\b/.test(rendered))
    const renderedPath = join(fixture, 'Caddyfile')
    writeFileSync(renderedPath, rendered)
    try {
      run('docker', [
        'run', '--platform', 'linux/amd64', '--rm', '--network', 'none',
        '-v', `${renderedPath}:/etc/caddy/Caddyfile:ro`,
        '--entrypoint', 'caddy', image,
        'validate', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile'
      ])
      check('官方 Caddy 接受渲染后的配置', true)
    } catch (error) {
      check('官方 Caddy 接受渲染后的配置', false, String(error).split('\n')[0])
    }
  }

  console.log('\n== 危险配置必须被拒绝（负例，证明守卫非恒真） ==')
  const negatives: Array<[string, Record<string, string>]> = [
    ['绑定缺失', { ...goodValues, WEFLOW_NATIVE_BIND_IP: '' }],
    ['绑定为空串', { ...goodValues, WEFLOW_NATIVE_BIND_IP: '   ' }],
    ['绑定 0.0.0.0', { ...goodValues, WEFLOW_NATIVE_BIND_IP: '0.0.0.0' }],
    ['绑定 ::', { ...goodValues, WEFLOW_NATIVE_BIND_IP: '::' }],
    ['绑定为主机名而非 IPv4', { ...goodValues, WEFLOW_NATIVE_BIND_IP: 'desktop-cbg37qt' }],
    ['网段缺失', { ...goodValues, WEFLOW_NATIVE_ALLOWED_CIDR: '' }],
    ['网段 0.0.0.0/0', { ...goodValues, WEFLOW_NATIVE_ALLOWED_CIDR: '0.0.0.0/0' }],
    ['网段 ::/0', { ...goodValues, WEFLOW_NATIVE_ALLOWED_CIDR: '::/0' }],
    ['网段为公网段', { ...goodValues, WEFLOW_NATIVE_ALLOWED_CIDR: '8.8.8.0/24' }],
    ['PKI 目录缺失', { ...goodValues, WEFLOW_NATIVE_PKI_DIR: '' }],
    ['域名缺失', { ...goodValues, WEFLOW_NATIVE_HOSTNAME: '' }]
  ]
  for (const [label, values] of negatives) {
    check(`负例：${label} 被拒绝`, renderNativeCaddyfile(values) === undefined)
  }
  check('可复现性：未改动的正例仍然渲染成功', renderNativeCaddyfile(goodValues) !== undefined)

  console.log('\n== 部署脚本安全边界 ==')
  // Only actual invocations count. The string "docker compose" also appears in
  // Write-Host guidance and in <# #> docstrings; those are text, not commands,
  // and treating them as invocations would make the boundary assertions both
  // wrong and unfalsifiable.
  const codeLines = scripts
    .split('\n')
    .map((line) => {
      const comment = line.indexOf('#')
      return comment >= 0 ? line.slice(0, comment) : line
    })
  const codeOnly = stripBlockComments(codeLines.join('\n'))
  const invocations = codeLines.filter((line) => /(^|\s)&\s*docker compose\b/.test(line.replace(/^\s*/, ' ')))
  const composeArgs = collectComposeScope(codeOnly)
  check('脚本中存在真实 Compose 调用', invocations.length > 0, `${invocations.length} 处`)
  check(
    '所有 Compose 调用显式固定 -p weflow-test',
    !/composeArgs/.test(codeOnly) &&
      codeOnly.includes("& docker compose -p $composeProject") &&
      codeOnly.includes("$composeProject  = 'weflow-test'")
  )
  check(
    '所有 Compose 调用固定同一组两个 -f 文件',
    !/composeArgs/.test(codeOnly) &&
      composeScopePinsBothFiles(codeOnly) &&
      codeOnly.includes("$composeFileBase = 'docker-compose.central.yml'") &&
      codeOnly.includes("$composeFileTls  = 'docker-compose.central.tls.yml'")
  )
  check(
    '脚本从不执行 compose down（含 down -v）',
    !composeArgs.some((line) => /(^|\s)down(\s|$)/.test(line)) &&
      !new RegExp('down\\s+' + '-v').test(codeOnly) &&
      // The guard's own PowerShell source names the forbidden forms; excluding
      // that file keeps the assertion about the deploy scripts themselves.
      !new RegExp('down\\s+' + '-v').test(readDeployScripts())
  )
  check('脚本从不删除容器或卷（无 compose rm）', !composeArgs.some((line) => /(^|\s)rm(\s|$)/.test(line)))
  check('脚本只对 caddy 服务操作，不对全部服务 up', composeArgs.every((line) => !/(^|\s)up(\s|$)/.test(line) || /\bcaddy\s*$/.test(line.trim())))
  check('脚本不按映像名宽泛杀进程', !/taskkill\s+\/IM/i.test(codeOnly))
  check('脚本只按记录 PID 结束进程', /Stop-Process -Id/.test(codeOnly))
  check('停止前核对 PID 可执行路径与本轮记录一致', /-ne \$state\.ExecutablePath/.test(codeOnly))
  check('不注册 Windows 服务或计划任务', !/New-Service|Register-ScheduledTask|sc\.exe\s+create|nssm/i.test(codeOnly))
  check('不修改 hosts 文件', !/drivers\\etc\\hosts/i.test(codeOnly))
  check(
    '不导出或读取根私钥',
    !new RegExp('root' + '\\.key').test(readDeployScripts()) &&
      !new RegExp('BEGIN .*PRIVATE' + ' KEY').test(readDeployScripts())
  )
  check('不停用防火墙或改网络配置', !/Set-NetFirewallProfile|netsh\s+advfirewall|New-NetIPAddress/i.test(codeOnly))
  check('启动脚本未授权时以非零码空跑', /exit 2/.test(codeOnly) && /-Authorized/.test(codeOnly))
  check('预检脚本不执行任何停止/删除动作', !/&\s*docker compose/.test(read(scriptsDir, 'Install-NativeCaddy.ps1').replace(/<#[\s\S]*?#>/g, '')))
  check('启动前先落到 staged 文件并 validate 通过后才生效', /Caddyfile\.staged/.test(read(scriptsDir, 'Install-NativeCaddy.ps1')))
  check('诊断脚本强制要求根证书、无跳过校验开关', /Mandatory\)\]\[string\]\$CaCertPath/.test(read(scriptsDir, 'Test-NativeCaddyEndpoint.ps1')) && !/SkipCertificateCheck|-insecure|--insecure/i.test(codeOnly))
  check('未启动长期服务（无 nssm / sc create）', !/nssm|New-Service/i.test(codeOnly))
  check('正向证据：诊断脚本确实带 -CaCertPath 校验参数', /-CaCertPath/.test(read(scriptsDir, 'Test-NativeCaddyEndpoint.ps1')))
  check('正向证据：停止脚本确实核对 PID 路径后才 Stop-Process', /actualPath/.test(read(scriptsDir, 'Stop-NativeCaddy.ps1')))

  console.log('\n== 参数示例取值 ==')
  check('示例绑定为显式物理 IPv4', envExample.includes(`WEFLOW_NATIVE_BIND_IP=${fixtureBind}`))
  check('示例网段为受限私有 CIDR', envExample.includes(`WEFLOW_NATIVE_ALLOWED_CIDR=${fixtureCidr}`))
  check(
    '示例网段不是任意 CIDR（只看赋值行，不看说明文字）',
    !/^WEFLOW_NATIVE_ALLOWED_CIDR=(0\.0\.0\.0\/0|::\/0)\s*$/m.test(envExample)
  )
  check('示例上游固定回环', envExample.includes('WEFLOW_NATIVE_UPSTREAM=127.0.0.1:8787'))
  check(
    '示例程序/配置/日志/PKI 全在 F 盘',
    ['WEFLOW_NATIVE_ROOT', 'WEFLOW_NATIVE_CONFIG_DIR', 'WEFLOW_NATIVE_LOG_DIR', 'WEFLOW_NATIVE_PKI_DIR', 'WEFLOW_NATIVE_BIN_DIR'].every(
      (key) => new RegExp(`^${key}=F:\\\\`, 'm').test(envExample)
    )
  )

  console.log('\n== 交付包与供应链 ==')
  const deliverableDir = process.env.WEFLOW_NATIVE_PACKAGE_DIR
  if (deliverableDir && existsSync(deliverableDir)) {
    const archive = join(deliverableDir, 'caddy_2.11.4_windows_amd64.zip')
    const sums = join(deliverableDir, 'SHA256SUMS.txt')
    check('交付包含官方归档', existsSync(archive))
    check('交付包含 SHA-256 清单', existsSync(sums))
    check('交付包不含证书 / 私钥', archiveSidecarFree(deliverableDir))
    const digest = existsSync(archive)
      ? createHash('sha256').update(readFileSync(archive)).digest('hex')
      : ''
    check('归档 SHA-256 与清单一致', digest !== '' && readFileSync(sums, 'utf8').includes(digest), digest.slice(0, 16))
  } else {
    console.log('  （未设置 WEFLOW_NATIVE_PACKAGE_DIR，跳过交付包检查）')
  }

  console.log('\n== 文档边界声明 ==')
  check('文档说明容器方案 TLS 正常但 LAN 403', /返回 403|403/.test(deployDoc))
  check('文档说明原生方案用于恢复直接来源判断', /remote_ip/.test(deployDoc) && /宿主/.test(deployDoc))
  check('文档要求切换前采样第二台客户端 peer 证据', /192\.168\.1\.53/.test(deployDoc))
  check('文档声明本轮只完成 Mac 侧准备', /只完成 Mac 侧源码与交付准备/.test(deployDoc))
  check('文档声明 Windows 运行 / LAN / 证书信任未验证', /未验证/.test(deployDoc))
  check('文档记录 DHCP / DNS / 时间同步 / 防火墙 / 长期服务待办', /DHCP/.test(deployDoc) && /DNS/.test(deployDoc) && /时间同步/.test(deployDoc) && /防火墙/.test(deployDoc))
  check('文档明确禁止 --insecure', /--insecure/.test(deployDoc))
  check('文档明确不装系统根信任、不改 hosts', /不安装系统根信任/.test(deployDoc) && /不修改客户端 hosts/.test(deployDoc))
  check('文档说明新 CA 与旧容器 CA 不同是预期', /预期行为/.test(deployDoc))
  check('文档说明 Python 默认测试不主张吊销检查', /不主张已完成吊销检查/.test(deployDoc))
  check('文档声明 Phase 3a 未收口', /Phase 3a 代码侧仍未收口/.test(deployDoc))
  check('文档禁止 down -v', /禁止 .*down -v/.test(deployDoc))
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error)
  check('原生 Caddy 配置守卫执行完成', false, detail.split('\n')[0])
} finally {
  rmSync(fixture, { recursive: true, force: true })
}

/** True when no certificate or private key material sits in the delivery dir. */
function archiveSidecarFree(directory: string): boolean {
  const listing = spawnSync('bash', ['-lc', `find "${directory}" -type f \\( -name '*.crt' -o -name '*.key' -o -name '*.p12' -o -name '*.pfx' \\)`], {
    encoding: 'utf8'
  })
  return String(listing.stdout ?? '').trim() === ''
}

console.log(`\ncentral native Caddy guard: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
