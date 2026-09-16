/**
 * Central TLS deployment guard.
 *
 * This exercises the merged Compose model and asks the official Caddy image to
 * parse the real Caddyfile. It does not start Central, PostgreSQL, or an HTTP
 * listener, and all fixture credentials are temporary and discarded.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const image = 'caddy:2.11.4-alpine'
const project = 'weflow-test'
const baseComposeFile = 'docker-compose.central.yml'
const tlsComposeFile = 'docker-compose.central.tls.yml'
const postgresVolumeKey = 'weflow-postgres'
const postgresDataTarget = '/var/lib/postgresql/data'
const bindVariable = 'WEFLOW_CENTRAL_HTTPS_BIND'
const fixtureBindAddress = '192.168.1.57'
const fixture = mkdtempSync(join(tmpdir(), 'weflow-central-tls-'))
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

function run(command: string, args: string[], options: { cwd?: string } = {}): string {
  return execFileSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

/**
 * Render the merged Compose model under an explicit project name.
 *
 * `-p` is required: without it the rendered volume names would depend on the
 * invocation directory and the guard could not assert the real volume name.
 */
function composeConfig(cwd: string, envFile = 'central/proxy.env'): Record<string, any> {
  return JSON.parse(run('docker', [
    'compose', '-p', project,
    '--env-file', envFile,
    '-f', baseComposeFile,
    'config', '--format', 'json'
  ], { cwd })) as Record<string, any>
}

/** Same merge, additionally layering the TLS override. */
function mergedComposeConfig(cwd: string, envFile = 'central/proxy.env'): Record<string, any> {
  return JSON.parse(run('docker', [
    'compose', '-p', project,
    '--env-file', envFile,
    '-f', baseComposeFile,
    '-f', tlsComposeFile,
    'config', '--format', 'json'
  ], { cwd })) as Record<string, any>
}

/** Write central/proxy.env inside the fixture and return nothing. */
function writeProxyEnv(lines: string[]): void {
  writeFileSync(join(fixture, 'central', 'proxy.env'), [...lines, ''].join('\n'))
}

/**
 * Run a Compose render that is expected to fail, returning its exit code and
 * stderr. Never throws: a non-zero exit is the assertion target, not an error.
 */
function composeConfigFailure(lines: string[]): { status: number; stderr: string } {
  writeProxyEnv(lines)
  const result = spawnSync('docker', [
    'compose', '-p', project,
    '--env-file', 'central/proxy.env',
    '-f', baseComposeFile,
    '-f', tlsComposeFile,
    'config', '--format', 'json'
  ], { cwd: fixture, encoding: 'utf8' })
  writeProxyEnv([
    `${bindVariable}=${fixtureBindAddress}`,
    'WEFLOW_CENTRAL_HOSTNAME=weflow-central.test',
    'WEFLOW_CENTRAL_ALLOWED_CIDR=192.168.1.0/24'
  ])
  return { status: result.status ?? -1, stderr: String(result.stderr ?? '') }
}

/** Locate the volume a service actually mounts at `target`. */
function volumeSource(service: Record<string, any>, target: string): string | undefined {
  const mount = targetMount(service, target)
  return typeof mount?.source === 'string' ? mount.source : undefined
}

/**
 * The data-volume guard proper: the definition must exist under the real key
 * (`weflow-postgres`, not the `weflow_postgres` spelling), the service must
 * actually mount it at the PostgreSQL data directory, and `-p weflow-test` must
 * resolve it to `weflow-test_weflow-postgres`. Comparing `undefined` against
 * `undefined` must never be able to satisfy this.
 */
function hasVolumeGuard(volumes: Record<string, any>, postgres: Record<string, any>): boolean {
  return (
    Object.hasOwn(volumes, postgresVolumeKey) &&
    volumeSource(postgres, postgresDataTarget) === postgresVolumeKey &&
    String(asRecord(volumes[postgresVolumeKey]).name ?? '') === `${project}_${postgresVolumeKey}`
  )
}

/** Render the merged model onto a rewritten on-disk copy of the base file. */
function mergedConfigWithBaseEdit(edit: (body: string) => string): Record<string, any> | undefined {
  const overrideDir = mkdtempSync(join(tmpdir(), 'weflow-central-tls-override-'))
  try {
    for (const relativePath of ['docker-compose.central.tls.yml', 'central/Caddyfile']) {
      const target = join(overrideDir, relativePath)
      mkdirSync(dirname(target), { recursive: true })
      copyFileSync(join(fixture, relativePath), target)
    }
    for (const relativePath of ['central/.env', 'central/secrets/postgres_password', 'central/proxy.env']) {
      const target = join(overrideDir, relativePath)
      mkdirSync(dirname(target), { recursive: true })
      copyFileSync(join(fixture, relativePath), target)
    }
    writeFileSync(
      join(overrideDir, baseComposeFile),
      edit(readFileSync(join(fixture, baseComposeFile), 'utf8'))
    )
    try {
      return mergedComposeConfig(overrideDir)
    } catch {
      // A broken volume definition makes Compose reject the project outright.
      // That is exactly what the negative probe is looking for, so absent
      // config is reported as "guard would not hold" rather than an error.
      return undefined
    }
  } finally {
    rmSync(overrideDir, { recursive: true, force: true })
  }
}

function copy(relativePath: string): void {
  const target = join(fixture, relativePath)
  mkdirSync(dirname(target), { recursive: true })
  copyFileSync(join(root, relativePath), target)
}

function asRecord(value: unknown): Record<string, any> {
  return value !== null && typeof value === 'object' ? value as Record<string, any> : {}
}

function asArray(value: unknown): any[] {
  return Array.isArray(value) ? value : []
}

function servicePort(service: Record<string, any>, target: number): Record<string, any> | undefined {
  return asArray(service.ports).find((port) => asRecord(port).target === target)
}

function targetMount(service: Record<string, any>, target: string): Record<string, any> | undefined {
  return asArray(service.volumes).find((volume) => asRecord(volume).target === target)
}

function networkNames(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((network) => {
      if (typeof network === 'string') return network
      return String(asRecord(network).target ?? asRecord(network).name ?? '')
    })
  }
  return Object.keys(asRecord(value))
}

function secretNames(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((secret) => {
      if (typeof secret === 'string') return secret
      const record = asRecord(secret)
      return String(record.source ?? record.name ?? record.target ?? '')
    })
  }
  return Object.keys(asRecord(value))
}

function stableServiceShape(service: Record<string, any>): string {
  return JSON.stringify({
    build: service.build,
    depends_on: service.depends_on,
    env_file: service.env_file,
    environment: service.environment,
    healthcheck: service.healthcheck,
    image: service.image,
    networks: service.networks,
    ports: service.ports,
    restart: service.restart,
    secrets: service.secrets,
    volumes: service.volumes
  })
}

try {
  for (const relativePath of [
    'docker-compose.central.yml',
    'docker-compose.central.tls.yml',
    'central/Caddyfile',
    'central/Dockerfile',
    'central/package.json',
    'central/package-lock.json',
    'central/tsconfig.json'
  ]) copy(relativePath)

  mkdirSync(join(fixture, 'central', 'secrets'), { recursive: true })
  writeFileSync(join(fixture, 'central', '.env'), [
    'WEFLOW_CENTRAL_HOST=0.0.0.0',
    'WEFLOW_CENTRAL_PORT=8787',
    'WEFLOW_CENTRAL_DATABASE_URL=postgres://weflow@postgres:5432/weflow',
    'WEFLOW_CENTRAL_DATABASE_PASSWORD_FILE=/run/secrets/postgres_password',
    'WEFLOW_CENTRAL_ADMIN_TOKEN=test-only-central-admin-token-000000000000',
    'WEFLOW_CENTRAL_TLS_TERMINATED=true',
    'WEFLOW_CENTRAL_LOG_LEVEL=silent',
    ''
  ].join('\n'))
  writeFileSync(join(fixture, 'central', 'secrets', 'postgres_password'), 'test-only-postgres-password\n', { mode: 0o600 })
  writeProxyEnv([
    `${bindVariable}=${fixtureBindAddress}`,
    'WEFLOW_CENTRAL_HOSTNAME=weflow-central.test',
    'WEFLOW_CENTRAL_ALLOWED_CIDR=192.168.1.0/24'
  ])

  const config = mergedComposeConfig(fixture)
  const baseConfig = composeConfig(fixture)
  const services = asRecord(config.services)
  const baseServices = asRecord(baseConfig.services)
  const central = asRecord(services.central)
  const postgres = asRecord(services.postgres)
  const caddy = asRecord(services.caddy)
  const caddyHttps = servicePort(caddy, 443)
  const caddyHttp = servicePort(caddy, 80)
  const caddyAdmin = servicePort(caddy, 2019)
  const centralHttp = servicePort(central, 8787)
  const postgresPort = servicePort(postgres, 5432)
  const caddyfileMount = targetMount(caddy, '/etc/caddy/Caddyfile')
  const dataMount = targetMount(caddy, '/data')
  const configMount = targetMount(caddy, '/config')
  const caddyNetworks = networkNames(caddy.networks)
  const caddyEnvironment = asRecord(caddy.environment)
  const caddySecurity = asArray(caddy.security_opt).map(String)
  const caddyCapDrop = asArray(caddy.cap_drop).map(String)
  const caddyCapAdd = asArray(caddy.cap_add).map(String)
  const caddyLogging = asRecord(caddy.logging)
  const caddyLoggingOptions = asRecord(caddyLogging.options)
  const caddyVolumes = asArray(caddy.volumes)
  const postgresVolumes = asArray(postgres.volumes)
  const centralSecrets = secretNames(central.secrets)
  const postgresSecrets = secretNames(postgres.secrets)
  const baseVolumes = asRecord(baseConfig.volumes)
  const mergedVolumes = asRecord(config.volumes)
  const basePostgresVolume = asRecord(baseVolumes[postgresVolumeKey])
  const mergedPostgresVolume = asRecord(mergedVolumes[postgresVolumeKey])
  const basePostgresVolumeName = String(basePostgresVolume.name ?? '')
  const mergedPostgresVolumeName = String(mergedPostgresVolume.name ?? '')
  const basePostgresDataSource = volumeSource(asRecord(baseServices.postgres), postgresDataTarget)
  const mergedPostgresDataSource = volumeSource(postgres, postgresDataTarget)
  const expectedVolumeName = `${project}_${postgresVolumeKey}`
  const baseHasVolume = Object.hasOwn(baseVolumes, postgresVolumeKey)
  const mergedHasVolume = Object.hasOwn(mergedVolumes, postgresVolumeKey)
  const postgresVolumeGuardHolds =
    hasVolumeGuard(baseVolumes, asRecord(baseServices.postgres)) &&
    hasVolumeGuard(mergedVolumes, postgres) &&
    JSON.stringify(mergedPostgresVolume) === JSON.stringify(basePostgresVolume) &&
    JSON.stringify(mergedPostgresDataSource) === JSON.stringify(basePostgresDataSource)
  const caddyUsesForbiddenRuntime = caddyVolumes.some((volume) => /\.env|secret|postgres_password|docker\.sock/i.test(JSON.stringify(volume)))
  const caddyUsesHostPrivileges = caddy.privileged === true || caddy.network_mode === 'host' || caddyVolumes.some((volume) => /docker\.sock/i.test(JSON.stringify(volume)))

  check('Compose 合并配置可由 Docker 解析', typeof config === 'object')
  check('只新增 caddy 服务，保留 postgres / central', JSON.stringify(Object.keys(services).sort()) === JSON.stringify([...Object.keys(baseServices), 'caddy'].sort()))
  check('TLS override 不改变 Central / PostgreSQL 基线', stableServiceShape(central) === stableServiceShape(asRecord(baseServices.central)) && stableServiceShape(postgres) === stableServiceShape(asRecord(baseServices.postgres)))
  check('基础与合并配置均实际存在 PostgreSQL 数据卷定义', baseHasVolume && mergedHasVolume, `base=${baseHasVolume} merged=${mergedHasVolume}`)
  check('PostgreSQL 数据目录挂载确实引用该卷', basePostgresDataSource === postgresVolumeKey && mergedPostgresDataSource === postgresVolumeKey, `base=${basePostgresDataSource} merged=${mergedPostgresDataSource}`)
  check('使用 -p weflow-test 后数据卷实际名为 weflow-test_weflow-postgres', basePostgresVolumeName === expectedVolumeName && mergedPostgresVolumeName === expectedVolumeName, `base=${basePostgresVolumeName} merged=${mergedPostgresVolumeName}`)
  check('TLS override 不改变 PostgreSQL 数据卷定义与挂载', postgresVolumeGuardHolds)
  check('Central / PostgreSQL 保留既有 secret 边界', centralSecrets.includes('postgres_password') && postgresSecrets.includes('postgres_password'))
  check('Caddy 使用固定官方版本标签', caddy.image === image, String(caddy.image))
  check('Caddy 锁定 linux/amd64 平台', caddy.platform === 'linux/amd64', String(caddy.platform))
  check('Caddy 仅发布 HTTPS 443 且 host_ip 精确等于配置地址', String(caddyHttps?.published) === '443' && caddyHttps?.host_ip === fixtureBindAddress, JSON.stringify(caddyHttps))
  check('Caddy 未发布 HTTP 80', caddyHttp === undefined)
  check('Caddy 未发布 admin 2019', caddyAdmin === undefined)
  check('Central 仍只绑定回环 8787', String(centralHttp?.published) === '8787' && centralHttp?.host_ip === '127.0.0.1', JSON.stringify(centralHttp))
  check('PostgreSQL 未发布宿主端口', postgresPort === undefined)
  check('Caddy 与 Central 共用 weflow-internal 网络', caddyNetworks.includes('weflow-internal'))
  check('Caddy Caddyfile 只读挂载', caddyfileMount?.read_only === true)
  check('Caddy /data 与 /config 有独立持久化挂载', dataMount?.type === 'volume' && configMount?.type === 'volume')
  check('Caddy 使用只读根文件系统', caddy.read_only === true)
  check('Caddy 不使用 privileged / host network / Docker socket', !caddyUsesHostPrivileges)
  check('Caddy 启用 no-new-privileges', caddySecurity.includes('no-new-privileges:true'))
  check('Caddy 仅保留低端口绑定能力', caddyCapDrop.includes('ALL') && caddyCapAdd.includes('NET_BIND_SERVICE'))
  check('Caddy 日志启用大小与文件数限制', caddyLogging.driver === 'json-file' && caddyLoggingOptions['max-size'] === '10m' && caddyLoggingOptions['max-file'] === '3')
  check('Caddy 收到 hostname / CIDR 运行时变量', caddyEnvironment.WEFLOW_CENTRAL_HOSTNAME === 'weflow-central.test' && caddyEnvironment.WEFLOW_CENTRAL_ALLOWED_CIDR === '192.168.1.0/24')
  check('Caddy 不挂载 Central .env、secret 或 Docker socket', !caddyUsesForbiddenRuntime)

  const caddyfile = readFileSync(join(root, 'central/Caddyfile'), 'utf8')
  const proxyExample = readFileSync(join(root, 'central/proxy.env.example'), 'utf8')
  const gitignore = readFileSync(join(root, 'central/.gitignore'), 'utf8')
  const dockerignore = readFileSync(join(root, '.dockerignore'), 'utf8')
  const pkiIgnoreRules = ['*.crt', '*.key', '*.p12', '*.pfx', 'caddy-data/', 'caddy-config/', 'caddy_data/', 'caddy_config/']
  check('Caddyfile 使用内部 CA', /\btls\s+internal\b/.test(caddyfile))
  check('Caddyfile 关闭 admin 与 HTTP 重定向', /\badmin\s+off\b/.test(caddyfile) && /\bauto_https\s+disable_redirects\b/.test(caddyfile))
  check('Caddyfile 代理到 central:8787', /\breverse_proxy\s+central:8787\b/.test(caddyfile))
  check('Caddyfile 对未允许 peer 返回 403', /\brespond\s+"forbidden"\s+403\b/.test(caddyfile))
  check('示例配置锁定临时测试网段', proxyExample.includes('WEFLOW_CENTRAL_ALLOWED_CIDR=192.168.1.0/24') && !proxyExample.includes('0.0.0.0/0'))
  check('proxy.env 被 Git 忽略', /(^|\n)proxy\.env(\n|$)/.test(gitignore))
  check('PKI 与 Caddy 运行目录被 Git 忽略', pkiIgnoreRules.every((rule) => gitignore.includes(rule)))
  check('proxy.env、PKI 与 Caddy 运行目录被 Docker 忽略', dockerignore.includes('**/proxy.env') && ['**/*.crt', '**/*.key', '**/*.p12', '**/*.pfx', '**/caddy-data', '**/caddy-config', '**/caddy_data', '**/caddy_config'].every((rule) => dockerignore.includes(rule)))
  check('仓库未创建真实 proxy.env', !existsSync(join(root, 'central/proxy.env')))

  // --- Deployment doc must carry the same project name and flags as the
  // commands this guard actually exercises, so the written procedure cannot
  // drift back to an unnamed-project, all-services `up`. ---
  const deployDoc = readFileSync(join(root, 'central/TLS-部署说明.md'), 'utf8')
  // Only fenced code blocks carry runnable commands; prose that merely mentions
  // `docker compose config` must not be mistaken for an invocation.
  const rawDocLines = deployDoc.split('\n')
  const deployFences: string[] = []
  let inFence = false
  for (let index = 0; index < rawDocLines.length; index++) {
    const line = rawDocLines[index]
    // Only a line that is nothing but a fence marker toggles state, so prose
    // containing backticks cannot desynchronise the scan.
    if (/^\s*```[\w-]*\s*$/.test(line)) {
      inFence = !inFence
      continue
    }
    if (!inFence) continue
    // Inside a fence, a trailing backtick continues the same command.
    let command = line.trim()
    while (/`$/.test(command) && index + 1 < rawDocLines.length && !/^\s*```/.test(rawDocLines[index + 1])) {
      command = `${command.replace(/`$/, '').trim()} ${rawDocLines[++index].trim()}`.trim()
    }
    deployFences.push(command)
  }
  const deployCommands = deployFences.filter((line) => /^docker compose\b/.test(line))
  const everyCommandNamesProject = deployCommands.length > 0 &&
    deployCommands.every((line) => /docker compose -p weflow-test\b/.test(line))
  const everyCommandPinsBothFiles = deployCommands.length > 0 &&
    deployCommands.every((line) =>
      line.includes('-f docker-compose.central.yml') && line.includes('-f docker-compose.central.tls.yml')
    )
  const upCommands = deployCommands.filter((line) => /(^|\s)up(\s|$)/.test(line))
  const everyUpTargetsCaddyOnly = upCommands.length > 0 && upCommands.every((line) =>
    /\bup -d --no-deps --no-build --pull never caddy\b/.test(line)
  )
  check('部署说明每条 Compose 命令都带 -p weflow-test', everyCommandNamesProject, `${deployCommands.length} 条命令`)
  check('部署说明每条 Compose 命令都带同一组两个 -f 文件', everyCommandPinsBothFiles)
  check(
    '部署说明每个 up 都只启动 caddy 且不构建不拉取不连带依赖',
    everyUpTargetsCaddyOnly,
    `${upCommands.length} 条 up`
  )
  check(
    '部署说明不存在对全部服务执行的 up',
    deployCommands.every((line) => !/(^|\s)up(\s|$)/.test(line) || /\bcaddy\s*$/.test(line.trim()))
  )
  check('部署说明禁止 down -v', /不要执行 `down -v`/.test(deployDoc))

  // --- Real Compose negative / positive cases for the host bind variable ---
  // The guard must prove the guardrail itself works, not only that the happy
  // path renders. A blank bind would silently bind every host interface.
  const missingBind = composeConfigFailure([
    'WEFLOW_CENTRAL_HOSTNAME=weflow-central.test',
    'WEFLOW_CENTRAL_ALLOWED_CIDR=192.168.1.0/24'
  ])
  check(
    '负例：WEFLOW_CENTRAL_HTTPS_BIND 缺失时 config 非零失败',
    missingBind.status !== 0 && missingBind.stderr.includes(bindVariable),
    `status=${missingBind.status}`
  )
  const emptyBind = composeConfigFailure([
    `${bindVariable}=`,
    'WEFLOW_CENTRAL_HOSTNAME=weflow-central.test',
    'WEFLOW_CENTRAL_ALLOWED_CIDR=192.168.1.0/24'
  ])
  check(
    '负例：WEFLOW_CENTRAL_HTTPS_BIND 为空串时 config 非零失败',
    emptyBind.status !== 0 && emptyBind.stderr.includes(bindVariable),
    `status=${emptyBind.status}`
  )
  const restoredConfig = mergedComposeConfig(fixture)
  check(
    '正例：变量存在时 host_ip 精确等于配置地址',
    asRecord(servicePort(asRecord(asRecord(restoredConfig.services).caddy), 443)).host_ip === fixtureBindAddress
  )

  // --- Real negative cases for the PostgreSQL data volume guard ---
  const removedVolume = mergedConfigWithBaseEdit((body) =>
    body.replace(/^volumes:\n {2}weflow-postgres:\n/m, '')
  )
  const renamedVolume = mergedConfigWithBaseEdit((body) =>
    body.replace(/ {2}weflow-postgres:/, '  weflow-postgres-renamed:')
  )
  const swappedMount = mergedConfigWithBaseEdit((body) =>
    body.replace(
      `      - ${postgresVolumeKey}:${postgresDataTarget}`,
      `      - caddy_data:${postgresDataTarget}`
    )
  )
  /** Apply the guard proper to a candidate merged model. */
  const guardHoldsFor = (candidate: Record<string, any> | undefined): boolean =>
    candidate !== undefined &&
    hasVolumeGuard(asRecord(candidate.volumes), asRecord(asRecord(candidate.services).postgres))
  /** Apply the definition-and-mount stability clause to a candidate model. */
  const stabilityHoldsFor = (candidate: Record<string, any> | undefined): boolean =>
    candidate !== undefined &&
    JSON.stringify(asRecord(candidate.volumes)[postgresVolumeKey]) === JSON.stringify(basePostgresVolume) &&
    JSON.stringify(volumeSource(asRecord(asRecord(candidate.services).postgres), postgresDataTarget)) ===
      JSON.stringify(basePostgresDataSource)

  // Reproducibility: an untouched baseline must satisfy both clauses, so the
  // negative cases below cannot pass merely because the predicates are vacuous.
  check('可复现性：未改动基线本身满足数据卷守卫与稳定性', guardHoldsFor(baseConfig) && stabilityHoldsFor(baseConfig))
  check('可复现性：未改动合并模型同样满足数据卷守卫与稳定性', guardHoldsFor(config) && stabilityHoldsFor(config))

  // The probe that must be caught by the stability clause: the data directory
  // still resolves, but to a different volume than the baseline.
  check(
    '负例：PostgreSQL 数据目录改挂其他卷会触发稳定性失败',
    swappedMount !== undefined && !stabilityHoldsFor(swappedMount)
  )
  check(
    '负例：改挂其他卷同时也会触发数据卷守卫失败',
    swappedMount !== undefined && !guardHoldsFor(swappedMount)
  )

  // The probes that never reach the guard: Compose itself refuses to render a
  // project whose service references a volume that no longer exists, so the
  // "deleted" and "renamed" cases are caught one layer earlier. The guard is
  // then fed the model Compose would have produced had it not refused, to pin
  // the guard independently of that refusal.
  check('负例：删除数据卷定义使 Compose 直接拒绝渲染（不发散为 undefined===undefined）', removedVolume === undefined)
  check('负例：替换数据卷名使 Compose 直接拒绝渲染', renamedVolume === undefined)
  check(
    '负例：定义缺失的合并模型无法通过数据卷守卫',
    !guardHoldsFor({ services: { postgres: { volumes: [{ type: 'volume', source: postgresVolumeKey, target: postgresDataTarget }] } }, volumes: {} })
  )
  check(
    '负例：卷名漂移的合并模型无法通过数据卷守卫',
    !guardHoldsFor({ services: { postgres: { volumes: [{ type: 'volume', source: postgresVolumeKey, target: postgresDataTarget }] } }, volumes: { [postgresVolumeKey]: { name: `${project}_renamed` } } })
  )
  check(
    '负例：挂载指向别的卷的合并模型无法通过数据卷守卫',
    !guardHoldsFor({ services: { postgres: { volumes: [{ type: 'volume', source: 'caddy_data', target: postgresDataTarget }] } }, volumes: { [postgresVolumeKey]: { name: expectedVolumeName } } })
  )

  run('docker', [
    'run', '--platform', 'linux/amd64', '--rm', '--network', 'none',
    '--env-file', join(fixture, 'central/proxy.env'),
    '-v', `${join(fixture, 'central/Caddyfile')}:/etc/caddy/Caddyfile:ro`,
    '--entrypoint', 'caddy', image,
    'validate', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile'
  ])
  check('官方 Caddy 实际接受 Caddyfile', true)
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error)
  check('Docker/Caddy 配置守卫执行完成', false, detail.split('\n')[0])
} finally {
  rmSync(fixture, { recursive: true, force: true })
}

console.log(`\ncentral TLS deployment guard: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
