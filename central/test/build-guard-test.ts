/**
 * 构建产物守卫的回归测试。
 *
 * 它不把「脚本存在」当成通过：先用临时 ESM 产物证明真实动态 import 能通过，
 * 再逐一移除关键导出，确认守卫真的会以非零状态失败。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

let pass = 0
let fail = 0
function check(name: string, condition: boolean, detail = ''): void {
  if (condition) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}${detail ? ` ${detail}` : ''}`) }
}

const centralRoot = resolve(process.cwd())
const guardPath = join(centralRoot, 'verify-dist.mjs')
const guardSource = readFileSync(guardPath, 'utf8')
const tempRoot = mkdtempSync(join(tmpdir(), 'weflow-central-dist-'))
const guardImportPath = '../verify-dist.mjs' as string
const { verifyCentralDist } = await import(guardImportPath)

function writeFixture(name: string, appSource: string, syncSource: string, downSource: string): string {
  const distRoot = join(tempRoot, name, 'dist')
  const appPath = join(distRoot, 'central', 'src', 'app.js')
  const syncPath = join(distRoot, 'shared', 'centralSync.js')
  const downPath = join(distRoot, 'shared', 'centralDownCommand.js')
  mkdirSync(join(distRoot, 'central', 'src'), { recursive: true })
  mkdirSync(join(distRoot, 'shared'), { recursive: true })
  writeFileSync(join(distRoot, 'package.json'), '{"type":"module"}\n')
  writeFileSync(appPath, appSource)
  writeFileSync(syncPath, syncSource)
  writeFileSync(downPath, downSource)
  return distRoot
}

async function runGuard(distRoot: string): Promise<string | null> {
  try {
    await verifyCentralDist(distRoot)
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

try {
  check('守卫源码使用真实动态 import', /\bimport\s*\(/.test(guardSource))
  check('守卫源码检查 buildCentralApp', guardSource.includes('buildCentralApp'))
  check('守卫源码检查 CENTRAL_ENTITY_TYPES', guardSource.includes('CENTRAL_ENTITY_TYPES'))
  check('守卫源码检查 validateDownCommand', guardSource.includes('validateDownCommand'))

  const validDist = writeFixture('valid',
    'export function buildCentralApp() {}\n',
    'export const CENTRAL_ENTITY_TYPES = [\'customer\']\n',
    'export function validateDownCommand() {}\n'
  )
  const validError = await runGuard(validDist)
  check('完整 ESM 夹具通过真实动态 import', validError === null, validError ?? '')

  const missingAppError = await runGuard(writeFixture('missing-app',
    'export const notTheApp = true\n',
    'export const CENTRAL_ENTITY_TYPES = [\'customer\']\n',
    'export function validateDownCommand() {}\n'
  ))
  check('缺少 buildCentralApp 时守卫非零失败', missingAppError?.includes('buildCentralApp') === true)

  const missingSyncError = await runGuard(writeFixture('missing-sync',
    'export function buildCentralApp() {}\n',
    'export const notTheSync = []\n',
    'export function validateDownCommand() {}\n'
  ))
  check('缺少 CENTRAL_ENTITY_TYPES 时守卫非零失败', missingSyncError?.includes('CENTRAL_ENTITY_TYPES') === true)

  const missingDownError = await runGuard(writeFixture('missing-down',
    'export function buildCentralApp() {}\n',
    'export const CENTRAL_ENTITY_TYPES = [\'customer\']\n',
    'export const notTheDown = true\n'
  ))
  check('缺少 validateDownCommand 时守卫非零失败', missingDownError?.includes('validateDownCommand') === true)
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

console.log(`\ncentral build guard test: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
