/**
 * 构建上下文（.dockerignore）测试。
 *
 * docker-compose.central.yml 的 build.context 是**仓库根**，所以 .dockerignore 必须放在仓库根。
 * 本机 Docker daemon 不可用时无法真跑 `docker build`，因此这里用与 Docker 一致的匹配语义
 * 静态验证两件事：
 *  1. Dockerfile 真正需要的文件没有被忽略（否则镜像构建会缺文件而失败）；
 *  2. node_modules / dist / 日志 / 密钥 / 客户数据库 / 前端与 Electron 源码确实被排除。
 * 真机 `docker build` 与镜像体积核查仍属于部署验收。
 *
 * 用法：cd central && npm run test:context
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; console.log(`  ✅ ${name}`) } else { fail++; console.log(`  ❌ ${name} ${detail}`) }
}

const root = resolve(process.cwd(), '..')
const raw = readFileSync(resolve(root, '.dockerignore'), 'utf8')

/** 单条 dockerignore 模式 → 正则；实现 Docker 的 filepath.Match 语义（含 ** 与 *）。 */
function toRegExp(pattern: string): RegExp {
  let out = ''
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        // `**/` 匹配任意层级（含零层）；行尾 `**` 匹配任意后缀
        if (pattern[i + 2] === '/') { out += '(?:.*/)?'; i += 2 } else { out += '.*'; i += 1 }
      } else { out += '[^/]*' }
    } else if ('\\^$.|?+()[]{}'.includes(char!)) { out += `\\${char}` } else { out += char }
  }
  return new RegExp(`^(?:${out})(?:/.*)?$`)
}

const rules = raw.split('\n')
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#'))
  .map((line) => line.startsWith('!') ? { negate: true, re: toRegExp(line.slice(1)) } : { negate: false, re: toRegExp(line) })

/** 判定某路径是否随构建上下文发送给 Docker（后出现的规则覆盖先出现的）。 */
function included(path: string): boolean {
  let ignored = false
  for (const rule of rules) if (rule.re.test(path)) ignored = !rule.negate
  return !ignored
}

console.log('═══ A. 位置与存在性 ═══')
check('A1 .dockerignore 位于仓库根（build.context 所在处）', rules.length > 0)
check('A2 compose 的 build.context 确为仓库根', readFileSync(resolve(root, 'docker-compose.central.yml'), 'utf8').includes('context: .'))

console.log('═══ B. Dockerfile 必需文件不被忽略 ═══')
const required = [
  'central/package.json', 'central/package-lock.json', 'central/tsconfig.json',
  'central/src/index.ts', 'central/src/app.ts', 'central/src/projections.ts',
  'central/test/app-test.ts', 'central/migrations/001_initial.sql', 'central/migrations/002_central_projections.sql',
  'shared/centralSync.ts'
]
const missing = required.filter((path) => !included(path))
check('B1 源码 / 锁文件 / 迁移 / tsconfig 全部进入构建上下文', missing.length === 0, missing.join(','))

console.log('═══ C. 不该进镜像的东西确实被排除 ═══')
const excluded = [
  'node_modules/fastify/index.js', 'central/node_modules/fastify/index.js',
  'central/dist/central/src/index.js', '.git/config', '.gitignore',
  'central/.env', 'central/secrets/postgres_password', '.env.local',
  'logs/app.log', 'npm-debug.log', 'tmp/scratch.ts', '.DS_Store',
  'weflow-crm.db', 'crm.sqlite3', 'server.pem', 'auth.key',
  'src/main.tsx', 'electron/main.ts', 'scripts/p0-3-closed-gate.ts', 'docs/CURRENT.md',
  'resources/icon.png', 'release/WeFlow.dmg', 'coverage/lcov.info'
]
const leaked = excluded.filter((path) => included(path))
check('C1 node_modules / dist / .git / 密钥 / .env / 日志 / 客户库 / 前端源码全部被排除', leaked.length === 0, leaked.join(','))
check('C2 例外规则可用：.env.example 被显式放行（示例配置随仓库走）', included('central/.env.example'))

console.log('═══ D. 上下文体积红线 ═══')
check('D1 不存在「排除后再整体放行」的兜底否定规则（防止 node_modules 被重新带回）',
  !rules.some((rule) => rule.negate && /node_modules|^dist|\*\*$/.test(rule.re.source)))

console.log(`\ncentral context test: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
