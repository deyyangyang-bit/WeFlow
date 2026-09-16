/**
 * Central TLS deployment guard.
 *
 * This exercises the merged Compose model and asks the official Caddy image to
 * parse the real Caddyfile. It does not start Central, PostgreSQL, or an HTTP
 * listener, and all fixture credentials are temporary and discarded.
 */
import { execFileSync } from 'node:child_process'
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
  writeFileSync(join(fixture, 'central', 'proxy.env'), [
    'WEFLOW_CENTRAL_HTTPS_BIND=192.168.1.57',
    'WEFLOW_CENTRAL_HOSTNAME=weflow-central.test',
    'WEFLOW_CENTRAL_ALLOWED_CIDR=192.168.1.0/24',
    ''
  ].join('\n'))

  const config = JSON.parse(run('docker', [
    'compose',
    '--env-file', 'central/proxy.env',
    '-f', 'docker-compose.central.yml',
    '-f', 'docker-compose.central.tls.yml',
    'config', '--format', 'json'
  ], { cwd: fixture })) as Record<string, any>
  const baseConfig = JSON.parse(run('docker', [
    'compose',
    '--env-file', 'central/proxy.env',
    '-f', 'docker-compose.central.yml',
    'config', '--format', 'json'
  ], { cwd: fixture })) as Record<string, any>
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
  const caddyUsesForbiddenRuntime = caddyVolumes.some((volume) => /\.env|secret|postgres_password|docker\.sock/i.test(JSON.stringify(volume)))
  const caddyUsesHostPrivileges = caddy.privileged === true || caddy.network_mode === 'host' || caddyVolumes.some((volume) => /docker\.sock/i.test(JSON.stringify(volume)))

  check('Compose 合并配置可由 Docker 解析', typeof config === 'object')
  check('只新增 caddy 服务，保留 postgres / central', JSON.stringify(Object.keys(services).sort()) === JSON.stringify([...Object.keys(baseServices), 'caddy'].sort()))
  check('TLS override 不改变 Central / PostgreSQL 基线', stableServiceShape(central) === stableServiceShape(asRecord(baseServices.central)) && stableServiceShape(postgres) === stableServiceShape(asRecord(baseServices.postgres)))
  check('TLS override 保留 PostgreSQL 数据卷定义', JSON.stringify(asRecord(config.volumes).weflow_postgres) === JSON.stringify(asRecord(baseConfig.volumes).weflow_postgres))
  check('Central / PostgreSQL 保留既有 secret 边界', centralSecrets.includes('postgres_password') && postgresSecrets.includes('postgres_password'))
  check('Caddy 使用固定官方版本标签', caddy.image === image, String(caddy.image))
  check('Caddy 锁定 linux/amd64 平台', caddy.platform === 'linux/amd64', String(caddy.platform))
  check('Caddy 仅发布 HTTPS 443', String(caddyHttps?.published) === '443' && caddyHttps?.host_ip === '192.168.1.57', JSON.stringify(caddyHttps))
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
