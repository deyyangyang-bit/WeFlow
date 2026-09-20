/**
 * annual-review-stats-test.ts —— 年度经营复盘 A1–A9 确定性统计护栏（S1）
 *
 * 覆盖（docs/设计-年度经营复盘-规格.md §3/§5.1 + S1 任务验收）：
 *   A 时间契约：当前年度 / 历史年度 / 历史以来 / 本地时区 / 非法年份 / 未来年份 /
 *     非法 generatedAt / 下一年零点只进下一年度 / asOf 时刻本身不计入 / WCDB 秒区间离散边界（ceil）
 *   B A1/A2：created_at 边界、历史 tombstone_gap、imported_at 恰好 50% 不降级、>50% 降级
 *   C A3：CRM session 去重、非 CRM 好友不计、群聊/公众号/系统账号/排除名单/内部人员不计、
 *     sent/received 任一>0 即活跃、WCDB 正常 / 失败回退 last_contact_at 秒→毫秒
 *     （仅 current_year/all_time，按 session 去重取最大值）、历史年度一律 unavailable（回归）、
 *     主口径与回退均不可用 → unavailable（查询失败不返回假 0）
 *   D A4/A5/A8/A9：sign_date 左右边界、created_at 在范围内但 sign_date 空不计、
 *     signed/shipped 缺 sign_date 告警数量、多合同同客户只计一个、account_id 空、
 *     分母 0、partial 传播（A9 继承 A5/A8）
 *   E A6：pending 认领不计、confirmed+pending 不计、allocated/legacy_confirmed 计入、
 *     legacy confirmed_at 回退、allocated 缺 reconciled_at 不伪造时间、conflict/撤销不计、
 *     时间边界、小数金额不提前舍入
 *   F A7：shipped 首次事件、重复不双计、首条范围外+重复范围内仍不计、无法关联合同、count/amount 同源
 *   G 健壮性：空输入、非法数字、输入不可变、warnings 去重、确定性
 *   H 数据访问层：loadAnnualReviewFacts 静态 SQL + 规范化 + 预过滤（内存 sql.js 夹具，零落盘）
 *
 * 运行：npx tsx scripts/annual-review-stats-test.ts
 */
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import initSqlJs from 'sql.js'
import {
  AnnualReviewPeriodError,
  annualReviewWcdbSeconds,
  computeAnnualReviewSummary,
  loadAnnualReviewFacts,
  resolveAnnualReviewPeriod,
  sqlJsQueryRunner,
  type AnnualReviewExclusions,
  type AnnualReviewFacts,
  type AnnualReviewMessageStats,
  type AnnualReviewPeriod,
  type AnnualReviewSummary
} from '../electron/services/annualReviewStats'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

let pass = 0, fail = 0
function ok(name: string, cond: boolean): void {
  if (cond) { pass++ } else { fail++; console.error('FAIL:', name) }
}
function throws(name: string, fn: () => unknown, code?: string): void {
  try {
    fn()
    fail++
    console.error('FAIL(未抛错):', name)
  } catch (e) {
    if (e instanceof AnnualReviewPeriodError) {
      if (code === undefined || e.code === code) pass++
      else { fail++; console.error(`FAIL(code=${e.code} 期望 ${code}):`, name) }
    } else {
      fail++
      console.error('FAIL(错误类型不对):', name, e)
    }
  }
}

function freezeDeep<T>(v: T): T {
  if (v && typeof v === 'object') {
    for (const k of Object.keys(v as object)) freezeDeep((v as Record<string, unknown>)[k])
    Object.freeze(v)
  }
  return v
}

function warnCodes(m: { warnings: Array<{ code: string }> }): string[] {
  return m.warnings.map((w) => w.code)
}
function warnOf(m: { warnings: Array<{ code: string; count?: number }> }, code: string): { code: string; count?: number } | undefined {
  return m.warnings.find((w) => w.code === code)
}

// ── 基准时刻（本地时区固定钟点，全部为整秒毫秒） ─────────────────────────────
const T = (y: number, m: number, d: number, hh = 0, mm = 0, ss = 0, ms = 0): number =>
  new Date(y, m - 1, d, hh, mm, ss, ms).getTime()
/** 生成时间：2026-06-15 12:00 本地 → 2026 是当前年 */
const GEN = T(2026, 6, 15, 12, 0, 0)
const J2025 = T(2025, 1, 1)
const J2026 = T(2026, 1, 1)
const J2027 = T(2027, 1, 1)
const P2026 = resolveAnnualReviewPeriod(2026, GEN) // current_year
const P2025 = resolveAnnualReviewPeriod(2025, GEN) // historical_year
const PALL = resolveAnnualReviewPeriod(0, GEN)     // all_time

const emptyFacts = (): AnnualReviewFacts => ({ accounts: [], contracts: [], allocations: [], shippedEvents: [] })

function summary(period: AnnualReviewPeriod, facts: AnnualReviewFacts, opts?: {
  messageStats?: AnnualReviewMessageStats | null
  exclusions?: AnnualReviewExclusions
}): AnnualReviewSummary {
  return computeAnnualReviewSummary(period, facts, opts)
}

function main(): void {
  // ══ A 时间契约 ═══════════════════════════════════════════════════════════
  ok('A1 当前年度 scopeKind=current_year', P2026.scopeKind === 'current_year')
  ok('A1b 当前年度 periodStart=本地 2026-01-01', P2026.periodStart === J2026)
  ok('A1c 当前年度 periodEndExclusive=本地 2027-01-01（名义自然年边界）', P2026.periodEndExclusive === J2027)
  ok('A1d 当前年度 asOf=generatedAt', P2026.asOf === GEN && P2026.generatedAt === GEN)

  ok('A2 历史年度 asOf=periodEndExclusive', P2025.scopeKind === 'historical_year' && P2025.asOf === J2026)
  ok('A2b 历史年度 generatedAt 仍是生成时间', P2025.generatedAt === GEN)
  ok('A3 历史以来 periodStart/periodEndExclusive 为 null', PALL.scopeKind === 'all_time' && PALL.periodStart === null && PALL.periodEndExclusive === null)
  ok('A3b 历史以来 asOf=generatedAt、year=0', PALL.asOf === GEN && PALL.year === 0)

  // 本地时区：本地钟点 = UTC 钟点 + getTimezoneOffset()（东八区为负 → 早于 UTC 纪元值）
  const tzOffsetMs = new Date(2026, 0, 1).getTimezoneOffset() * 60000
  ok('A4 本地时区 1 月 1 日（非 UTC 构造）', P2026.periodStart === Date.UTC(2026, 0, 1) + tzOffsetMs)
  ok('A4b 下一年边界同为本地时区', P2026.periodEndExclusive === Date.UTC(2027, 0, 1) + new Date(2027, 0, 1).getTimezoneOffset() * 60000)

  throws('A5 非法年份：负数', () => resolveAnnualReviewPeriod(-1, GEN), 'invalid_year')
  throws('A5 非法年份：小数', () => resolveAnnualReviewPeriod(2026.5, GEN), 'invalid_year')
  throws('A5 非法年份：NaN', () => resolveAnnualReviewPeriod(Number.NaN, GEN), 'invalid_year')
  throws('A5 非法年份：Infinity', () => resolveAnnualReviewPeriod(Number.POSITIVE_INFINITY, GEN), 'invalid_year')
  throws('A5 非法年份：10000', () => resolveAnnualReviewPeriod(10000, GEN), 'invalid_year')
  throws('A5 非法年份：字符串（运行时注入）', () => resolveAnnualReviewPeriod('2026' as unknown as number, GEN), 'invalid_year')
  throws('A6 未来年份被拒绝', () => resolveAnnualReviewPeriod(2027, GEN), 'future_year')
  throws('A6 未来年份（远期）被拒绝', () => resolveAnnualReviewPeriod(3000, GEN), 'future_year')
  throws('A7 非法 generatedAt：NaN', () => resolveAnnualReviewPeriod(2026, Number.NaN), 'invalid_generated_at')
  throws('A7 非法 generatedAt：0', () => resolveAnnualReviewPeriod(2026, 0), 'invalid_generated_at')
  throws('A7 非法 generatedAt：负数', () => resolveAnnualReviewPeriod(2026, -1), 'invalid_generated_at')
  throws('A7b 非法 period 直接进 compute 也被拒绝（asOf=NaN）',
    () => computeAnnualReviewSummary({ ...P2026, asOf: Number.NaN }, emptyFacts()), 'invalid_generated_at')

  // 下一年零点只进入下一年度；asOf 时刻本身不计入
  {
    const facts: AnnualReviewFacts = {
      ...emptyFacts(),
      contracts: [{ id: 1, accountId: 1, amount: 100, status: 'signed', signDate: J2026 }]
    }
    ok('A8 下一年零点不在历史年度（右开）', summary(P2025, facts).contractCount.value === 0)
    ok('A8b 下一年零点进入下一年度（左闭）', summary(P2026, facts).contractCount.value === 1)
    ok('A8c 历史以来（asOf=GEN > J2026）计入', summary(PALL, facts).contractCount.value === 1)
  }
  {
    const acc = (createdAt: number): AnnualReviewFacts['accounts'][number] =>
      ({ id: 1, createdAt, importedAt: null, sessionId: null, lastContactAtSec: null })
    ok('A9 asOf 时刻本身不计入（当前年度）', summary(P2026, { ...emptyFacts(), accounts: [acc(GEN)] }).customerTotal.value === 0)
    ok('A9b asOf 时刻本身不计入（历史以来）', summary(PALL, { ...emptyFacts(), accounts: [acc(GEN)] }).customerTotal.value === 0)
    ok('A9c asOf-1ms 计入', summary(P2026, { ...emptyFacts(), accounts: [acc(GEN - 1)] }).customerTotal.value === 1)
  }
  {
    // WCDB 秒区间换算：毫秒 → 秒（ceil，见 A11）；all_time 下界 0。GEN 为整秒 → floor/ceil 同值
    const wc2026 = annualReviewWcdbSeconds(P2026)
    ok('A10 WCDB 秒区间 = [periodStart/1000, asOf/1000)', wc2026.beginSec === Math.floor(J2026 / 1000) && wc2026.endSec === Math.floor(GEN / 1000))
    const wcAll = annualReviewWcdbSeconds(PALL)
    ok('A10b all_time beginSec=0', wcAll.beginSec === 0 && wcAll.endSec === Math.floor(GEN / 1000))
  }
  {
    // ── A11 毫秒→秒离散边界（ceil）：秒级时间戳 S 代表 [S.000, S+1.000)，floor 会漏掉含 asOf 的那一秒 ──
    const GENs = T(2026, 6, 15, 12, 0, 0)
    ok('A11 asOf 恰好整秒：endSec 不增加', annualReviewWcdbSeconds(resolveAnnualReviewPeriod(2026, GENs)).endSec === GENs / 1000)
    ok('A11b asOf = 整秒+1ms：endSec 进位', annualReviewWcdbSeconds(resolveAnnualReviewPeriod(2026, GENs + 1)).endSec === GENs / 1000 + 1)
    ok('A11c asOf = 整秒+500ms：endSec 进位（该秒早于 asOf，不得漏算）', annualReviewWcdbSeconds(resolveAnnualReviewPeriod(2026, GENs + 500)).endSec === GENs / 1000 + 1)
    // 非整秒下界（手工 period 防御性测试）
    const oddStart = { ...P2026, periodStart: J2026 + 500 }
    ok('A11d 非整秒 periodStart：beginSec = ceil(startMs/1000)', annualReviewWcdbSeconds(oddStart).beginSec === J2026 / 1000 + 1)
    ok('A11e all_time 下界仍为 0（纪元）', annualReviewWcdbSeconds(PALL).beginSec === 0 && annualReviewWcdbSeconds(PALL).endSec === Math.ceil(GEN / 1000))
    throws('A11f 手工构造 NaN asOf 明确拒绝（不得转换成 NaN）', () => annualReviewWcdbSeconds({ ...P2026, asOf: Number.NaN }), 'invalid_generated_at')
  }

  // ══ B A1/A2 ══════════════════════════════════════════════════════════════
  {
    const acc = (id: number, createdAt: number | null, importedAt: number | null = null): AnnualReviewFacts['accounts'][number] =>
      ({ id, name: null, createdAt, importedAt, sessionId: null, lastContactAtSec: null })
    // 2025 年度：边界 created_at ∈ [J2025, J2026)
    const facts: AnnualReviewFacts = {
      ...emptyFacts(),
      accounts: [
        acc(1, J2025),             // 左边界 → 新增计入
        acc(2, J2026 - 1),         // 年内最后 1ms → 计入
        acc(3, J2026),             // 右边界 → 不计入新增；总量 < asOf 也不计
        acc(4, T(2024, 12, 31)),   // 往年建档 → 只进总量
        acc(5, null)               // 缺 created_at → 排除 + 告警
      ]
    }
    const r2025 = summary(P2025, facts)
    ok('B1 A2 新增左右边界（start 计入、endExclusive-1 计入、endExclusive 不计）', r2025.customerNew.value === 2)
    ok('B1b A2 缺 created_at 排除并告警', warnCodes(r2025.customerNew).includes('account_created_at_missing') && warnOf(r2025.customerNew, 'account_created_at_missing')?.count === 1)
    ok('B1c A2 缺 created_at → partial', r2025.customerNew.state === 'partial')
    ok('B2 A1 历史年度总量 = created_at < asOf（含往年建档、不含 asOf 整点）', r2025.customerTotal.value === 3)
    ok('B2b A1 历史年度必须 partial + tombstone_gap', r2025.customerTotal.state === 'partial' && warnCodes(r2025.customerTotal).includes('tombstone_gap'))
    const r2026 = summary(P2026, facts)
    ok('B3 A1 当前年度存量含往年建档（无 tombstone_gap；partial 仅因缺 created_at）', r2026.customerTotal.value === 4 && !warnCodes(r2026.customerTotal).includes('tombstone_gap'))
    // 干净档案（无缺 created_at）：当前年度 complete
    const clean = summary(P2026, { ...emptyFacts(), accounts: [acc(1, J2025), acc(2, T(2025, 5, 1))] })
    ok('B3b A1 当前年度 complete（干净档案）', clean.customerTotal.state === 'complete' && clean.customerTotal.warnings.length === 0 && clean.customerTotal.value === 2)
    const rAll = summary(PALL, facts)
    ok('B3b A1 历史以来无 tombstone_gap', !warnCodes(rAll.customerTotal).includes('tombstone_gap'))

    // imported_at 占比：恰好 50% 不降级、>50% 降级
    const four = (importedCount: number): AnnualReviewFacts => ({
      ...emptyFacts(),
      accounts: [0, 1, 2, 3].map((i) => acc(i + 1, T(2025, 3, 1), i < importedCount ? T(2025, 3, 2) : null))
    })
    const half = summary(P2025, four(2))
    ok('B4 imported_at 恰好 50% 不降级', half.customerNew.value === 4 && half.customerNew.state === 'complete' && !warnCodes(half.customerNew).includes('bulk_import_dominant'))
    const over = summary(P2025, four(3))
    ok('B5 imported_at >50% 降级 + 告警数量', over.customerNew.state === 'partial' && warnOf(over.customerNew, 'bulk_import_dominant')?.count === 3)
    ok('B5b A1 不受导入占比影响（口径独立）', over.customerTotal.value === 4 && !warnCodes(over.customerTotal).includes('bulk_import_dominant'))
    const emptyNew = summary(P2025, emptyFacts())
    ok('B6 空输入 A1=0/A2=0（真实零，非 unavailable）', emptyNew.customerTotal.value === 0 && emptyNew.customerNew.value === 0 && emptyNew.customerNew.state === 'complete')
  }

  // ══ C A3 ═════════════════════════════════════════════════════════════════
  {
    const account = (id: number, sessionId: string | null, lastContactAtSec: number | null = null): AnnualReviewFacts['accounts'][number] =>
      ({ id, name: null, createdAt: T(2024, 1, 1), importedAt: null, sessionId, lastContactAtSec })
    const facts: AnnualReviewFacts = {
      ...emptyFacts(),
      accounts: [
        account(1, 'wx_a'),
        account(2, 'wx_a'),              // 与 1 同会话 → 去重
        account(3, 'wx_b'),
        account(4, 'wx_c'),              // 无消息 → 不活跃
        account(5, 'wx_room@chatroom'),  // 群聊（结构性排除）
        account(6, 'gh_official'),       // 公众号
        account(7, 'filehelper'),        // 系统账号
        account(8, 'wx_manual'),         // 手动排除名单
        account(9, 'wx_internal'),       // 内部人员
        account(10, null)                // 未绑定会话
      ]
    }
    const messageStats: AnnualReviewMessageStats = {
      ok: true,
      sessions: {
        wx_a: { sent: 3, received: 5 },
        wx_b: { sent: 2, received: 0 },
        'wx_room@chatroom': { sent: 9, received: 9 },
        wx_manual: { sent: 5, received: 5 },
        wx_internal: { sent: 5, received: 5 },
        wx_friend: { sent: 99, received: 99 } // 非 CRM 好友 → 不计
      }
    }
    const exclusions: AnnualReviewExclusions = { manualSessions: [' wx_manual '], internalSessions: ['wx_internal'] }
    const r = summary(P2025, facts, { messageStats, exclusions })
    ok('C1 A3 主口径：CRM session 去重 + 结构性/名单排除 + 非 CRM 好友不计', r.customerActive.value === 2)
    ok('C1b 主口径成功 → complete（历史年度消息是事件事实，同样可用）', r.customerActive.state === 'complete' && r.customerActive.warnings.length === 0)

    const recvOnly = summary(P2025, { ...emptyFacts(), accounts: [account(1, 'wx_d')] }, { messageStats: { ok: true, sessions: { wx_d: { sent: 0, received: 7 } } } })
    ok('C2 仅接收 >0 → 活跃', recvOnly.customerActive.value === 1)
    const zeroMsg = summary(P2025, { ...emptyFacts(), accounts: [account(1, 'wx_e')] }, { messageStats: { ok: true, sessions: { wx_e: { sent: 0, received: 0 } } } })
    ok('C2b 收发均为 0 → 不活跃（真实 0，complete）', zeroMsg.customerActive.value === 0 && zeroMsg.customerActive.state === 'complete')

    // WCDB 失败 → last_contact_at 秒→毫秒回退（仅 current_year / all_time 允许，见 C7）
    const fbFacts: AnnualReviewFacts = {
      ...emptyFacts(),
      accounts: [
        account(1, 'wx_a', Math.floor(T(2026, 3, 1, 8) / 1000)),   // 当前年内 → 活跃
        account(2, 'wx_b', Math.floor(J2026 / 1000)),              // 左边界（秒整）→ 活跃
        account(3, 'wx_c', Math.floor(GEN / 1000) - 1),            // asOf 前最后 1 秒 → 活跃
        account(4, 'wx_d', Math.floor(GEN / 1000)),                // asOf 整秒 → 不计
        account(5, 'wx_e', Math.floor(T(2025, 6, 1) / 1000)),      // 往年 → 不计
        account(6, 'wx_manual', Math.floor(T(2026, 3, 1) / 1000)), // 排除名单 → 不计
        account(7, 'wx_f', null)                                   // 无回填 → 不计
      ]
    }
    const fb = summary(P2026, fbFacts, { messageStats: { ok: false, sessions: {} }, exclusions: { manualSessions: ['wx_manual'] } })
    ok('C3 回退：秒→毫秒比较 + 边界 + 排除名单', fb.customerActive.value === 3)
    ok('C3b 回退 → partial + last_contact_fallback', fb.customerActive.state === 'partial' && warnCodes(fb.customerActive).includes('last_contact_fallback'))
    ok('C3c 查询失败不返回假 0（value>0）', (fb.customerActive.value ?? 0) > 0)

    const fbNull = summary(P2026, fbFacts, { messageStats: null, exclusions: { manualSessions: ['wx_manual'] } })
    ok('C3d messageStats=null 同样触发回退', fbNull.customerActive.value === 3 && fbNull.customerActive.state === 'partial')

    // 主口径与回退均不可用 → unavailable / value=null
    const dead = summary(P2026, { ...emptyFacts(), accounts: [account(1, 'wx_a', null)] }, { messageStats: { ok: false, sessions: {} } })
    ok('C4 双不可用 → unavailable + value=null（不显示假 0）', dead.customerActive.value === null && dead.customerActive.state === 'unavailable' && warnCodes(dead.customerActive).includes('customer_active_unavailable'))
    ok('C4b 空客户档案 + WCDB 失败 → 0（partial 保守态）', summary(P2026, emptyFacts(), { messageStats: { ok: false, sessions: {} } }).customerActive.value === 0)

    // ── C6/C7 历史年度禁止回退当前 last_contact_at（回归：旧实现会用当前投影冒充历史事实） ──
    const histFacts: AnnualReviewFacts = {
      ...emptyFacts(),
      accounts: [
        account(1, 'wx_a', Math.floor(T(2025, 3, 1) / 1000)),   // last_contact_at 落在历史年度内
        account(2, 'wx_b', Math.floor(T(2025, 6, 1) / 1000))
      ]
    }
    const histOk = summary(P2025, histFacts, { messageStats: { ok: true, sessions: { wx_a: { sent: 2, received: 0 } } } })
    ok('C6 历史年度 + WCDB 成功：按 sessions 统计，不受 last_contact_at 当前值影响', histOk.customerActive.value === 1 && histOk.customerActive.state === 'complete')
    const histFail = summary(P2025, histFacts, { messageStats: { ok: false, sessions: {} } })
    ok('C7 历史年度 + WCDB 失败 → unavailable/null（即使 last_contact_at 落在年度内也不回退）', histFail.customerActive.value === null && histFail.customerActive.state === 'unavailable')
    ok('C7b 历史年度失败用 historical_contact_unavailable，不出现 last_contact_fallback', warnCodes(histFail.customerActive).includes('historical_contact_unavailable') && !warnCodes(histFail.customerActive).includes('last_contact_fallback'))

    // ── C8 all_time 回退：允许使用 last_contact_at，且同样按 session 去重 ──
    const allFb = summary(PALL, {
      ...emptyFacts(),
      accounts: [
        account(1, 'wx_a', Math.floor(T(2025, 3, 1) / 1000)),
        account(2, 'wx_a', Math.floor(T(2024, 1, 1) / 1000)),      // 同会话重复 account → 去重
        account(3, 'wx_b', Math.floor(T(2025, 8, 1) / 1000))
      ]
    }, { messageStats: { ok: false, sessions: {} } })
    ok('C8 all_time 回退按 session 去重 + partial', allFb.customerActive.value === 2 && allFb.customerActive.state === 'partial' && warnCodes(allFb.customerActive).includes('last_contact_fallback'))

    // ── C9 current_year 回退与主口径同一统计对象（回归：旧实现逐 account 累加） ──
    const dedupFacts: AnnualReviewFacts = {
      ...emptyFacts(),
      accounts: [
        account(1, 'wx_dup', Math.floor(T(2026, 2, 1) / 1000)),
        account(2, 'wx_dup', Math.floor(T(2026, 5, 1) / 1000)),   // 同会话两条 → 只计 1
        account(3, null, Math.floor(T(2026, 2, 1) / 1000)),       // 未绑定 session → 不计（有残留 last_contact_at 也不计）
        account(4, 'wx_room@chatroom', Math.floor(T(2026, 2, 1) / 1000)),
        account(5, 'gh_official', Math.floor(T(2026, 2, 1) / 1000)),
        account(6, 'filehelper', Math.floor(T(2026, 2, 1) / 1000)),
        account(7, 'wx_manual', Math.floor(T(2026, 2, 1) / 1000)),
        account(8, 'wx_internal', Math.floor(T(2026, 2, 1) / 1000))
      ]
    }
    const dedup = summary(P2026, dedupFacts, { messageStats: { ok: false, sessions: {} }, exclusions: { manualSessions: ['wx_manual'], internalSessions: ['wx_internal'] } })
    ok('C9 回退按 session 去重 + 群聊/公众号/系统账号/手动/内部/未绑定不计', dedup.customerActive.value === 1 && dedup.customerActive.state === 'partial')
    // 同会话取最大 last_contact_at：最大值在区间外时，不得因较早的区间内值而误计
    const maxOut: AnnualReviewFacts = {
      ...emptyFacts(),
      accounts: [
        account(1, 'wx_m', Math.floor(T(2026, 2, 1) / 1000)),                 // 较早、区间内
        account(2, 'wx_m', Math.floor(GEN / 1000) + 3600)                     // 同会话最大值在 asOf 之后
      ]
    }
    const maxOutR = summary(P2026, maxOut, { messageStats: { ok: false, sessions: {} } })
    ok('C9b 同会话取最大 last_contact_at：最大值在区间外则整会话不计', maxOutR.customerActive.value === 0 && maxOutR.customerActive.state === 'partial')
    // 合法绑定会话全部无 last_contact_at → unavailable/null
    const noContact = summary(P2026, { ...emptyFacts(), accounts: [account(1, 'wx_a', null), account(2, 'wx_b', null)] }, { messageStats: { ok: false, sessions: {} } })
    ok('C9c 合法会话无任何 last_contact_at → unavailable/null', noContact.customerActive.value === null && noContact.customerActive.state === 'unavailable' && warnCodes(noContact.customerActive).includes('customer_active_unavailable'))
    // 没有任何合法绑定会话 → 0/partial
    const noBound = summary(P2026, {
      ...emptyFacts(),
      accounts: [account(1, null, Math.floor(T(2026, 2, 1) / 1000)), account(2, 'wx_manual', Math.floor(T(2026, 2, 1) / 1000))]
    }, { messageStats: { ok: false, sessions: {} }, exclusions: { manualSessions: ['wx_manual'] } })
    ok('C9d 没有任何合法绑定会话 → 0/partial + last_contact_fallback', noBound.customerActive.value === 0 && noBound.customerActive.state === 'partial' && warnCodes(noBound.customerActive).includes('last_contact_fallback'))

    // 非法消息数值 → 按 0 处理 + 告警降级
    const bad = summary(P2025, { ...emptyFacts(), accounts: [account(1, 'wx_a')] }, { messageStats: { ok: true, sessions: { wx_a: { sent: Number.NaN, received: 4 } } } })
    ok('C5 非法消息数值 → 告警降级且不崩溃', bad.customerActive.value === 1 && bad.customerActive.state === 'partial' && warnCodes(bad.customerActive).includes('message_stats_invalid'))
  }

  // ══ D A4/A5/A8/A9 ════════════════════════════════════════════════════════
  {
    const contract = (id: number, signDate: number | null, amount: number | null, status: string, accountId: number | null, createdAt = T(2024, 1, 1)): AnnualReviewFacts['contracts'][number] =>
      ({ id, signDate, amount, status, accountId, createdAt })
    const facts: AnnualReviewFacts = {
      ...emptyFacts(),
      contracts: [
        contract(1, J2025, 1000, 'signed', 1),                              // 左边界
        contract(2, T(2025, 12, 31, 23, 59, 59, 999), 2000.5, 'signed', 2), // 年内最后 1ms
        contract(3, J2026, 999, 'signed', 3),                               // 右边界外
        contract(4, T(2025, 6, 1), null, 'signed', 4),                      // 金额非法
        contract(5, null, 500, 'signed', 5, T(2025, 3, 1)),                 // signed 缺 sign_date（created_at 在范围内也不计）
        contract(6, null, 500, 'shipped', 6),                               // shipped 缺 sign_date
        contract(7, null, 500, 'pending_sign', 7),                          // 未签约缺 sign_date：静默合法
        contract(8, T(2025, 7, 1), 100, 'signed', null),                    // account_id 缺失
        contract(9, T(2025, 8, 1), 300, 'signed', 7),                       // 同客户 7
        contract(10, T(2025, 8, 2), 400, 'signed', 7),                      // 同客户 7
        contract(11, Number.NaN, 500, 'signed', 8)                          // 非法 sign_date = 缺失
      ]
    }
    const r = summary(P2025, facts)
    ok('D1 A4 sign_date 左右边界 + 缺失不计', r.contractCount.value === 6) // 1,2,4,8,9,10
    ok('D1b A4 signed/shipped 缺 sign_date 告警数量（含 NaN）', warnOf(r.contractCount, 'sign_date_missing')?.count === 3) // 5,6,11
    ok('D1c A4 partial', r.contractCount.state === 'partial')
    ok('D2 A5 金额 = 有效合同原始求和（无中间舍入）', r.contractAmount.value === 1000 + 2000.5 + 100 + 300 + 400)
    ok('D2b A5 非法金额告警', warnOf(r.contractAmount, 'contract_amount_invalid')?.count === 1)
    ok('D2c A5 继承 sign_date_missing', warnCodes(r.contractAmount).includes('sign_date_missing') && r.contractAmount.state === 'partial')
    ok('D3 A8 多合同同客户只计一个 + account_id 缺失告警', r.dealingCustomers.value === 4 && warnOf(r.dealingCustomers, 'contract_account_missing')?.count === 1)
    ok('D3b A8 同源 partial', r.dealingCustomers.state === 'partial')
    ok('D4 A9 = A5/A8 不舍入', r.avgDealSize.value === (1000 + 2000.5 + 100 + 300 + 400) / 4)
    ok('D4b A9 继承 partial 与 warnings', r.avgDealSize.state === 'partial' && warnCodes(r.avgDealSize).includes('sign_date_missing') && warnCodes(r.avgDealSize).includes('contract_amount_invalid') && warnCodes(r.avgDealSize).includes('contract_account_missing'))

    // 分母 0 → unavailable
    const noDeal = summary(P2025, {
      ...emptyFacts(),
      contracts: [contract(1, T(2024, 1, 1), 500, 'signed', 1)] // 只在范围外
    })
    ok('D5 分母 0 → A9 unavailable / null（不显示 ¥0）', noDeal.avgDealSize.value === null && noDeal.avgDealSize.state === 'unavailable')
    ok('D5b 分母 0 时 A4/A5/A8 仍为真实零', noDeal.contractCount.value === 0 && noDeal.contractAmount.value === 0 && noDeal.dealingCustomers.value === 0)
    // created_at 在范围内但未签约 → 不计且不告警
    const pending = summary(P2025, { ...emptyFacts(), contracts: [contract(1, null, 500, 'pending_sign', 1, T(2025, 3, 1))] })
    ok('D6 pending_sign 缺 sign_date 静默合法', pending.contractCount.value === 0 && pending.contractCount.warnings.length === 0 && pending.contractCount.state === 'complete')
    // 当前年度同样口径（范围 = [J2026, GEN)）：只有合同 3（sign=J2026 左边界）在范围内
    const r2026 = summary(P2026, facts)
    ok('D7 当前年度 A4 同口径（范围内 = 合同 3）', r2026.contractCount.value === 1)
    ok('D7b all_time A4 = sign_date < asOf', summary(PALL, facts).contractCount.value === 7) // 1,2,3,4,8,9,10
  }

  // ══ E A6 ═════════════════════════════════════════════════════════════════
  {
    const alloc = (id: number, status: string, rec: string | null, reconciledAt: number | null, confirmedAt: number | null, creditedAmount: number | null): AnnualReviewFacts['allocations'][number] =>
      ({ id, status, reconciliationStatus: rec, reconciledAt, confirmedAt, creditedAmount, contractId: 1, accountId: 1 })
    const facts: AnnualReviewFacts = {
      ...emptyFacts(),
      allocations: [
        alloc(1, 'confirmed', 'allocated', T(2025, 3, 1), null, 100.5),      // 正常计入
        alloc(2, 'confirmed', 'allocated', J2026, null, 500),                // asOf 整点 → 不计
        alloc(3, 'confirmed', 'pending', T(2025, 3, 1), T(2025, 3, 1), 500), // 认领（confirmed+pending）不计
        alloc(4, 'pending', 'allocated', T(2025, 3, 1), null, 500),          // 撤销回 pending 不计
        alloc(5, 'conflict', 'pending', T(2025, 3, 1), null, 500),           // conflict 不计
        alloc(6, 'confirmed', 'legacy_confirmed', null, T(2025, 4, 1), 200), // legacy 回退 confirmed_at → 计入 + 告警
        alloc(7, 'confirmed', 'legacy_confirmed', T(2025, 5, 1), T(2025, 4, 1), 300), // legacy 有 reconciled_at → 优先，不告警
        alloc(8, 'confirmed', 'allocated', null, T(2025, 6, 1), 500),        // allocated 缺 reconciled_at → 排除，不伪造时间
        alloc(9, 'confirmed', 'legacy_confirmed', null, null, 500),          // legacy 双缺 → 排除
        alloc(10, 'confirmed', 'allocated', T(2025, 7, 1), null, Number.NaN),// 金额非法
        alloc(11, 'confirmed', 'allocated', J2025, null, 10.25),             // 左边界计入
        alloc(12, 'confirmed', 'legacy_confirmed', null, J2026 - 1, 0.1),    // asOf 前 1ms（回退时间）计入
        alloc(13, 'confirmed', 'allocated', T(2025, 9, 1), null, 0.2)        // 小数
      ]
    }
    const r = summary(P2025, facts)
    // 求和 oracle：与统计层同序（升序累加）的独立实现，逐位相等 → 无中间舍入
    const amountsIn = [100.5, 200, 300, 10.25, 0.1, 0.2]
    const oracle = [...amountsIn].sort((a, b) => a - b).reduce((s, v) => s + v, 0)
    ok('E1 A6 口径求和（原始金额，oracle 逐位相等）', r.creditedAmount.value === oracle)
    ok('E1g 小数金额不提前舍入（0.1+0.2 保留全精度，不等于 0.3）',
      summary(P2025, {
        ...emptyFacts(),
        allocations: [alloc(21, 'confirmed', 'allocated', T(2025, 3, 1), null, 0.1), alloc(22, 'confirmed', 'allocated', T(2025, 3, 2), null, 0.2)]
      }).creditedAmount.value === 0.1 + 0.2)
    ok('E1b legacy 回退告警数量（仅范围内回退行 6,12）', warnOf(r.creditedAmount, 'legacy_time_fallback')?.count === 2)
    ok('E1c allocated 缺 reconciled_at → 数据异常告警且不计入', warnOf(r.creditedAmount, 'allocated_reconciled_at_missing')?.count === 1)
    ok('E1d legacy 双缺时间告警', warnOf(r.creditedAmount, 'legacy_time_missing')?.count === 1)
    ok('E1e 非法核销金额告警', warnOf(r.creditedAmount, 'credited_amount_invalid')?.count === 1)
    ok('E1f legacy 回退 → partial', r.creditedAmount.state === 'partial')
    ok('E2 认领/pending/conflict 行静默合法（不产生额外告警码）', r.creditedAmount.warnings.every((w) => ['legacy_time_fallback', 'allocated_reconciled_at_missing', 'legacy_time_missing', 'credited_amount_invalid'].includes(w.code)))

    // 边界：start-1 不计入；零核销为真实零
    const rStart = summary(P2025, { ...emptyFacts(), allocations: [alloc(1, 'confirmed', 'allocated', J2025 - 1, null, 500)] })
    ok('E3 核销时间早于 periodStart 不计入', rStart.creditedAmount.value === 0 && rStart.creditedAmount.state === 'complete' && rStart.creditedAmount.warnings.length === 0)
    const rAll = summary(PALL, { ...emptyFacts(), allocations: [alloc(1, 'confirmed', 'allocated', T(2020, 1, 1), null, 7), alloc(2, 'confirmed', 'legacy_confirmed', null, T(2021, 1, 1), 3)] })
    ok('E3b all_time 无下界计入 + legacy 回退', rAll.creditedAmount.value === 10 && warnCodes(rAll.creditedAmount).includes('legacy_time_fallback'))
  }

  // ══ F A7 ═════════════════════════════════════════════════════════════════
  {
    const contract = (id: number, amount: number | null): AnnualReviewFacts['contracts'][number] =>
      ({ id, signDate: T(2024, 1, 1), amount, status: 'shipped', accountId: 1 })
    const ev = (id: number, contractId: number | null, createdAt: number | null): AnnualReviewFacts['shippedEvents'][number] =>
      ({ id, contractId, toStatus: 'shipped', createdAt })
    const facts: AnnualReviewFacts = {
      ...emptyFacts(),
      contracts: [
        contract(11, 500),
        contract(12, 999),  // 首次发货 2024（范围外）
        contract(15, null), // 金额非法但计数
        contract(17, 888),  // 首次发货恰在下一年零点
        contract(18, 42)
      ],
      shippedEvents: [
        ev(1, 11, T(2025, 2, 1)),                    // 首条，计入
        ev(2, 11, T(2025, 3, 1)),                    // 重复 shipped → 不双计
        ev(3, 12, T(2024, 6, 1)),                    // 首条在范围外
        ev(4, 12, T(2025, 3, 1)),                    // 范围内重复事件 → 仍不计
        ev(5, null, T(2025, 3, 1)),                  // 无法关联合同
        ev(6, 14, T(2025, 4, 1)),                    // 合同不存在（已删除）
        ev(7, 15, T(2025, 5, 1)),                    // 计数但不进金额
        ev(8, 16, null),                             // 缺时间
        ev(9, 17, J2026),                            // 下一年零点 → 2025 不计
        ev(10, 18, T(2025, 12, 31, 23, 59, 59, 999)) // 年内最后 1ms → 计入
      ]
    }
    const r = summary(P2025, facts)
    ok('F1 A7 首次事件计数（重复不双计、范围外首条+范围内重复仍不计）', r.shippedCount.value === 3) // 11, 15, 18
    ok('F1b A7 金额与 count 同一集合（非法金额只影响金额）', r.shippedAmount.value === 500 + 42)
    ok('F1c 无法关联合同告警（contractId 空 + 合同不存在）', warnOf(r.shippedCount, 'shipped_contract_unlinked')?.count === 2)
    ok('F1d 缺时间告警', warnOf(r.shippedCount, 'shipped_time_missing')?.count === 1)
    ok('F1e 非法合同金额告警', warnOf(r.shippedAmount, 'contract_amount_invalid')?.count === 1)
    ok('F1f partial 传播', r.shippedCount.state === 'partial' && r.shippedAmount.state === 'partial')
    ok('F2 下一年零点进入下一年度（count/amount 同源）', summary(P2026, facts).shippedCount.value === 1 && summary(P2026, facts).shippedAmount.value === 888)
    // to_status 过滤：非 shipped 事件不参与
    const rSigned = summary(P2025, { ...facts, shippedEvents: [...facts.shippedEvents, { id: 99, contractId: 11, toStatus: 'signed', createdAt: T(2025, 9, 9) }] })
    ok('F3 非 shipped 事件不参与 A7', rSigned.shippedCount.value === r.shippedCount.value && rSigned.shippedAmount.value === r.shippedAmount.value)
  }

  // ══ G 健壮性 ═════════════════════════════════════════════════════════════
  {
    // 空输入 × 三 scope
    for (const [label, p] of [['当前年度', P2026], ['历史年度', P2025], ['历史以来', PALL]] as Array<[string, AnnualReviewPeriod]>) {
      const r = summary(p, emptyFacts())
      ok(`G1 空输入 ${label}：全部数值 0/null 且不崩溃`,
        r.customerTotal.value === 0 && r.customerNew.value === 0 && r.contractCount.value === 0 &&
        r.contractAmount.value === 0 && r.creditedAmount.value === 0 && r.shippedCount.value === 0 &&
        r.shippedAmount.value === 0 && r.dealingCustomers.value === 0 && r.avgDealSize.value === null)
    }
    // 输入不可变：深度冻结 + 快照比对
    const facts: AnnualReviewFacts = freezeDeep({
      accounts: [{ id: 1, name: '甲', createdAt: T(2025, 2, 1), importedAt: T(2025, 2, 2), sessionId: 'wx_a', lastContactAtSec: 1000 }],
      contracts: [{ id: 1, accountId: 1, amount: 1.5, status: 'signed', signDate: T(2025, 3, 1) }],
      allocations: [{ id: 1, contractId: 1, accountId: 1, creditedAmount: 0.3, status: 'confirmed', reconciliationStatus: 'allocated', reconciledAt: T(2025, 4, 1), confirmedAt: null }],
      shippedEvents: [{ id: 1, contractId: 1, toStatus: 'shipped', createdAt: T(2025, 5, 1) }]
    }) as AnnualReviewFacts
    const snapshot = JSON.stringify(facts)
    const opts = freezeDeep({ messageStats: { ok: true, sessions: { wx_a: { sent: 1, received: 2 } } }, exclusions: { manualSessions: ['x'] } }) as { messageStats: AnnualReviewMessageStats; exclusions: AnnualReviewExclusions }
    let r1: AnnualReviewSummary
    try {
      r1 = summary(P2025, facts, opts)
      ok('G2 深度冻结输入不抛错（无原地修改）', true)
    } catch {
      r1 = summary(P2025, { ...emptyFacts() })
      ok('G2 深度冻结输入不抛错（无原地修改）', false)
    }
    ok('G2b 输入快照不变', JSON.stringify(facts) === snapshot)
    const r1b = summary(P2025, facts, opts)
    ok('G3 确定性：同输入同输出', JSON.stringify(r1b) === JSON.stringify(r1))
    // 行序无关（金额求和排序副本）
    const reversed: AnnualReviewFacts = {
      accounts: [...facts.accounts],
      contracts: [...facts.contracts],
      allocations: [...facts.allocations],
      shippedEvents: [...facts.shippedEvents]
    }
    ok('G3b 行序无关（求和确定性）', JSON.stringify(summary(P2025, reversed, opts)) === JSON.stringify(r1))
    // warnings 去重：同 code 多行只保留一条（count 聚合）
    const dup: AnnualReviewFacts = {
      ...emptyFacts(),
      contracts: [
        { id: 1, accountId: 1, amount: null, status: 'signed', signDate: null },
        { id: 2, accountId: 2, amount: null, status: 'signed', signDate: null }
      ]
    }
    const rd = summary(P2025, dup)
    const sdm = rd.contractAmount.warnings.filter((w) => w.code === 'sign_date_missing')
    ok('G4 warnings 按 code 去重 + count 聚合', sdm.length === 1 && sdm[0].count === 2)
    // 非法金额不进入结果
    const badAmounts: AnnualReviewFacts = {
      ...emptyFacts(),
      contracts: [
        { id: 1, accountId: 1, amount: Number.NaN, status: 'signed', signDate: T(2025, 1, 1) },
        { id: 2, accountId: 1, amount: Number.POSITIVE_INFINITY, status: 'signed', signDate: T(2025, 1, 2) }
      ],
      allocations: [
        { id: 1, contractId: 1, accountId: 1, creditedAmount: Number.NEGATIVE_INFINITY, status: 'confirmed', reconciliationStatus: 'allocated', reconciledAt: T(2025, 1, 3), confirmedAt: null }
      ]
    }
    const rb = summary(P2025, badAmounts)
    ok('G5 NaN/Infinity 金额排除并告警（不进入结果）', rb.contractAmount.value === 0 && rb.creditedAmount.value === 0 &&
      warnOf(rb.contractAmount, 'contract_amount_invalid')?.count === 2 && warnOf(rb.creditedAmount, 'credited_amount_invalid')?.count === 1)
    // 状态取值 ∈ 四态枚举（snapshot_only 属于联合类型，S1 不产出）
    ok('G6 状态取值 ∈ 四态枚举', Object.values(r1b).every((m) => ['complete', 'partial', 'snapshot_only', 'unavailable'].includes(m.state)))
  }

  // ══ H 数据访问层（内存 sql.js 夹具，零落盘） ═════════════════════════════
  void (async () => {
    const wasmPath = join(ROOT, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm')
    const SQL = await initSqlJs({ locateFile: () => wasmPath })
    const db = new SQL.Database()
    // 与 crmDb SCHEMA_SQL 同列名子集（仅夹具用途，非第二套语义）
    db.run(`
      CREATE TABLE account (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, created_at INTEGER, updated_at INTEGER,
        session_id TEXT, sales_stage TEXT, last_contact_at INTEGER, imported_at INTEGER, customer_id INTEGER);
      CREATE TABLE contract (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER, name TEXT, amount REAL,
        status TEXT DEFAULT 'pending_sign', sign_date INTEGER, created_at INTEGER, updated_at INTEGER);
      CREATE TABLE allocation (id INTEGER PRIMARY KEY AUTOINCREMENT, payment_record_id INTEGER, credited_amount REAL,
        account_id INTEGER, contract_id INTEGER, status TEXT DEFAULT 'pending', created_at INTEGER, confirmed_at INTEGER,
        reconciliation_status TEXT DEFAULT 'pending', reconciled_at INTEGER);
      CREATE TABLE contract_status_history (id INTEGER PRIMARY KEY AUTOINCREMENT, contract_id INTEGER,
        from_status TEXT, to_status TEXT, operator TEXT, created_at INTEGER);
    `)
    const ins = (sql: string, params: ReadonlyArray<unknown>): void => db.run(sql, params as never)
    ins('INSERT INTO account (id, name, created_at, session_id, last_contact_at, imported_at) VALUES (?,?,?,?,?,?)',
      [1, '甲', T(2024, 5, 1), 'wx_a', Math.floor(T(2025, 2, 1) / 1000), null])
    ins('INSERT INTO account (id, name, created_at, session_id, last_contact_at, imported_at) VALUES (?,?,?,?,?,?)',
      [2, '乙', null, null, null, T(2025, 2, 2)])
    ins('INSERT INTO contract (id, account_id, name, amount, status, sign_date) VALUES (?,?,?,?,?,?)', [1, 1, 'c1', 1200, 'signed', T(2025, 3, 1)])
    ins('INSERT INTO contract (id, account_id, name, amount, status, sign_date) VALUES (?,?,?,?,?,?)', [2, 1, 'c2', null, 'signed', null])
    ins('INSERT INTO contract (id, account_id, name, amount, status, sign_date) VALUES (?,?,?,?,?,?)', [3, null, 'c3', 10, 'pending_sign', null])
    ins('INSERT INTO allocation (id, contract_id, account_id, credited_amount, status, reconciliation_status, reconciled_at, confirmed_at) VALUES (?,?,?,?,?,?,?,?)',
      [1, 1, 1, 800.5, 'confirmed', 'allocated', T(2025, 4, 1), null])
    ins('INSERT INTO allocation (id, contract_id, account_id, credited_amount, status, reconciliation_status, reconciled_at, confirmed_at) VALUES (?,?,?,?,?,?,?,?)',
      [2, null, 1, 77, 'confirmed', 'pending', null, T(2025, 4, 2)])            // 认领行 → SQL 预过滤剔除
    ins('INSERT INTO allocation (id, contract_id, account_id, credited_amount, status, reconciliation_status, reconciled_at, confirmed_at) VALUES (?,?,?,?,?,?,?,?)',
      [3, 1, 1, 50, 'confirmed', 'legacy_confirmed', null, T(2025, 4, 3)])
    ins('INSERT INTO contract_status_history (id, contract_id, from_status, to_status, created_at) VALUES (?,?,?,?,?)', [1, 1, 'signed', 'shipped', T(2025, 5, 1)])
    ins('INSERT INTO contract_status_history (id, contract_id, from_status, to_status, created_at) VALUES (?,?,?,?,?)', [2, 1, 'shipped', 'shipped', T(2025, 5, 2)])
    ins('INSERT INTO contract_status_history (id, contract_id, from_status, to_status, created_at) VALUES (?,?,?,?,?)', [3, 1, 'shipped', 'signed', T(2025, 5, 3)]) // 非 shipped → 剔除

    const facts = loadAnnualReviewFacts(sqlJsQueryRunner(db))
    ok('H1 account 规范化（null/数字/秒字段原样 + name）', facts.accounts.length === 2 && facts.accounts[0].lastContactAtSec === Math.floor(T(2025, 2, 1) / 1000) && facts.accounts[1].createdAt === null && facts.accounts[1].importedAt === T(2025, 2, 2) && facts.accounts[0].name === '甲' && facts.accounts[1].name === '乙')
    ok('H2 contract 规范化（amount null → null）', facts.contracts.length === 3 && facts.contracts[1].amount === null && facts.contracts[2].status === 'pending_sign')
    ok('H3 allocation 预过滤 = creditedTotal 同款 WHERE（剔除 confirmed+pending）', facts.allocations.length === 2 && facts.allocations[0].reconciliationStatus === 'allocated' && facts.allocations[1].reconciliationStatus === 'legacy_confirmed')
    ok('H4 shipped 事件预过滤 to_status=shipped（非 shipped 剔除）', facts.shippedEvents.length === 2)
    // 端到端：loader → compute 与直接注入事实一致
    const r = summary(P2025, facts, { messageStats: { ok: true, sessions: { wx_a: { sent: 1, received: 0 } } } })
    ok('H5 端到端（loader→compute）A1/A3/A4/A5/A6/A7', r.customerTotal.value === 1 && r.customerActive.value === 1 && r.contractCount.value === 1 && r.contractAmount.value === 1200 && r.creditedAmount.value === 850.5 && r.shippedCount.value === 1 && r.shippedAmount.value === 1200)
    ok('H5b 端到端 legacy 回退告警', warnCodes(r.creditedAmount).includes('legacy_time_fallback'))
    // 参数绑定路径可用（runner 语义）
    const bound = sqlJsQueryRunner(db).all<Record<string, unknown>>('SELECT id FROM account WHERE id = ?', [1])
    ok('H6 runner 参数绑定查询可用', bound.length === 1 && Number(bound[0].id) === 1)

    console.log(`结果：${pass} 通过 / ${fail} 失败`)
    process.exit(fail > 0 ? 1 : 0)
  })()
}

main()
