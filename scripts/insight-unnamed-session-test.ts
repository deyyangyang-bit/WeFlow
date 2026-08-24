/**
 * insight-unnamed-session-test.ts —— 无名 session 跳过见解链（观察期防污染，2026-08-24）
 *
 * 背景：A1 清理了 3 条无名 session 污染的 customer_event；为防观察期再次污染，
 * 两处门控落地（WeFlow 仓库侧修复，与 crmParseService E3.2 accountId 双写门控配套）：
 *   ① 沉默扫描（silence scan）：salesDb 无客户档案（customerGetBySession 为空）的会话 → continue
 *   ② 活跃分析 blacklist 模式：同上 → continue（whitelist 为用户显式配置，不受影响）
 *
 * 断言（静态护栏，与 customer-event-producer-test A 部分同风格）：
 *   1  沉默扫描存在 !profile 门控（无名 session 跳过）
 *   2  活跃分析 blacklist 存在 hasProfile 门控（无名 session 跳过）
 *   3  两处门控都基于 salesDbService.customerGetBySession（同一"客户档案"判定）
 *   4  profile 变量声明提升到 try 外（try 内赋值，catch 不吞判定）
 *   5  whitelist 模式（用户显式配置）不引入 hasProfile 门控——不改变用户有意选择
 *   6  零 this.isSessionIdLike 调用（isSessionIdLike 是模块函数，this. 前缀运行时 TypeError，
 *      曾致活跃分析整链报错 [ERROR] this.isSessionIdLike is not a function）
 *
 * 运行：npx tsx scripts/insight-unnamed-session-test.ts
 */
import { readFileSync } from 'fs'
import { join } from 'path'

let pass = 0, fail = 0
function ok(name: string, cond: boolean): void {
  if (cond) { pass++ } else { fail++; console.error('FAIL:', name) }
}

const ROOT = join(__dirname, '..')
const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

async function main(): Promise<void> {
  const src = readFileSync(join(ROOT, 'electron/services/insightService.ts'), 'utf8')
  const code = strip(src)

  // ① 沉默扫描：!profile 门控（无名 session 跳过——candidates 不入队）
  ok('1 沉默扫描存在无名 session 门控（if (!profile) continue）', /if \(!profile\) continue/.test(code))
  // ② blacklist 活跃分析：hasProfile 门控（无名 session 跳过——不触发 actionStageClassifier / generateInsightForSession）
  ok('2 活跃分析 blacklist 存在无名 session 门控（hasProfile 判定 + continue）',
    /let hasProfile = false/.test(code) && /if \(!hasProfile\) continue/.test(code))
  // ③ 判定统一走 salesDbService.customerGetBySession（客户档案存在性 = "已识别联系人"）
  ok('3 两处门控均基于 customerGetBySession(sessionId)（≥2 处）',
    (code.match(/salesDbService\.customerGetBySession\(sessionId\)/g) || []).length >= 2)
  // ④ 沉默扫描 profile 变量声明在 try 外（try 抛错后 !profile 判定仍成立 → continue）
  const profileDecl = code.match(/let profile: CustomerProfile \| undefined\n\s*try \{[\s\S]{0,80}?profile = salesDbService\.customerGetBySession\(sessionId\)/)
  ok('4 profile 声明提升到 try 外（catch 不吞无名判定）', !!profileDecl)
  // ⑤ whitelist 模式不引入 hasProfile 门控（用户显式配置的名单不受无名门控影响）
  const whitelistZone = src.slice(src.indexOf("filterMode === 'whitelist' && filterList.length > 0"), src.indexOf('// blacklist 模式'))
  ok('5 whitelist 模式不引入 hasProfile 门控（显式配置不受影响）', !/hasProfile/.test(strip(whitelistZone)))
  // ⑥ isSessionIdLike 是模块级函数（shared/wechatId），零 this. 前缀调用（运行时 TypeError 回归护栏）
  ok('6 零 this.isSessionIdLike 调用（模块函数不走 this）', !/this\.isSessionIdLike/.test(src) && /!isSessionIdLike\(/.test(code))

  console.log(`insight-unnamed-session-test: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

void main()
