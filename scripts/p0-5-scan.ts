/**
 * P0-5 第一刀：客户全量分类只读扫描（对应 docs/P0-5-Customer-Classification-设计.md）
 *
 * 数据通道：WeFlow 本地 HTTP API（应用读取层的 HTTP 封装，docs/HTTP-API.md）
 *   - 前提：WeFlow 应用已启动且设置页「API 服务」开启（状态自动记忆）
 * 红线遵守：
 *   - 零写库：唯一产物 = reports/p0-5/ 下报告 md + CSV 清单
 *   - 零 AI：全部本地正则规则，0 token 消耗
 *   - 无名 session 不出现在任何名单里
 *
 * 运行：npx tsx scripts/p0-5-scan.ts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import initSqlJs from 'sql.js'
import { parseBuySignal, isDealSignal, parseRiskSignal } from '../electron/services/crmParseRules'

// ─── 配置 ────────────────────────────────────────────────────────────────────

const USER_DATA = join(homedir(), 'Library', 'Application Support', 'weflow')
const CONFIG_JSON = join(USER_DATA, 'WeFlow-config.json')
const CRM_DB = join(USER_DATA, 'weflow-crm.db')
const SALES_DB = join(USER_DATA, 'weflow-sales.db')
const OUT_DIR = join(process.cwd(), 'reports', 'p0-5')

/** 扫描窗口：近 365 天 */
const WINDOW_DAYS = 365
/** 高置信 / 灰区阈值（v0，第二刀校准） */
const HIGH_THRESHOLD = 70
const GRAY_THRESHOLD = 30
/** 分层抽样配比：高置信 60 + 灰区 25 + 待观察 15 */
const SAMPLE_PLAN: Array<[string, number]> = [['high', 60], ['gray', 25], ['observe', 15]]
/** 单次请求消息条数上限（HTTP API limit 上限 10000，1000 已够翻页粒度） */
const PAGE_SIZE = 1000

/** 可复现基线：NOW_MS 在脚本启动时固定一次，报告内所有相对时间以此为锚 */
const NOW_MS = Date.now()
const DAY_MS = 86_400_000

interface SessionEntry {
  sessionId: string
  displayName: string
  priorSource: 'profile' | 'lead_account' | 'lead_wechat' | 'lead_alias' | 'none'
  priorLabel: string
  priorStage?: string
  score: number
  evidenceCount: number
  lastEvidenceAt: number
  lastEvidenceText: string
  lastContactAt: number
  segment: 'prior' | 'high' | 'gray' | 'observe'
  priorBucket?: string
  priceHits: number
  priceLastText: string
  priceLastTime: number
  competitorHits: number
  compLastText: string
}

function assert(cond: boolean, label: string): void {
  if (!cond) throw new Error(`[sanity] ${label} 断言失败`)
}

// ─── CRM 元数据加载（sql.js 只读字节进内存） ─────────────────────────────────

async function loadMetaTables() {
  const SQL = await initSqlJs()
  const rows = (db: any, sql: string): any[] => {
    const stmt = db.prepare(sql)
    const out: any[] = []
    while (stmt.step()) out.push(stmt.getAsObject())
    stmt.free()
    return out
  }
  const crm = new SQL.Database(readFileSync(CRM_DB))
  const sales = new SQL.Database(readFileSync(SALES_DB))
  return {
    leads: rows(crm, `SELECT id, status, source, wechat, account_id FROM lead`),
    accounts: rows(crm, `SELECT id, name, session_id FROM account`),
    aliases: rows(crm, `SELECT alias, account_id FROM alias_map WHERE alias IS NOT NULL AND alias != ''`),
    profiles: rows(sales, `SELECT session_id, stage FROM customer_profile`),
  }
}

function buildAccountIndex(accounts: any[], aliases: any[]) {
  const byId = new Map<number, { name: string; sessionId: string | null }>()
  for (const a of accounts) {
    byId.set(Number(a.id), { name: String(a.name || ''), sessionId: a.session_id ? String(a.session_id) : null })
  }
  const aliasToAccountId = new Map<string, number>()
  for (const al of aliases) aliasToAccountId.set(String(al.alias).trim().toLowerCase(), Number(al.account_id))
  return { byId, aliasToAccountId }
}

/**
 * 来源先验三级匹配（设计稿 §2.2a）：
 * customer_profile.session_id 直连 > account.session_id / lead.account_id 硬链接
 * > lead.wechat 精确 > alias_map 别名兜底。三级都不中返回 none。
 */
function matchPrior(
  sessionId: string,
  displayName: string,
  leads: any[],
  accounts: any[],
  idx: ReturnType<typeof buildAccountIndex>,
  profileStages: Map<string, string>
): { source: SessionEntry['priorSource']; label: string; stage?: string } {
  if (profileStages.has(sessionId)) {
    return { source: 'profile', label: '已建档客户', stage: profileStages.get(sessionId) }
  }
  const accBySession = accounts.find((a) => a.session_id && String(a.session_id) === sessionId)
  if (accBySession) {
    return { source: 'lead_account', label: `CRM 客户(${accBySession.name})` }
  }
  const lowerName = displayName.trim().toLowerCase()
  for (const ld of leads) {
    const acc = idx.byId.get(Number(ld.account_id || 0))
    if (!acc) continue
    if ((acc.sessionId && acc.sessionId === sessionId) ||
      (acc.name && lowerName && acc.name.toLowerCase() === lowerName)) {
      return { source: 'lead_account', label: `留资线索已转(#${ld.id} ${acc.name})` }
    }
  }
  for (const ld of leads) {
    const wx = String(ld.wechat || '').trim().toLowerCase()
    if (wx && (wx === sessionId.toLowerCase() || (lowerName && wx === lowerName))) {
      return { source: 'lead_wechat', label: `留资线索#${ld.id}(status=${ld.status})` }
    }
  }
  const aliasAcc = idx.aliasToAccountId.get(lowerName)
  if (aliasAcc) {
    const acc = idx.byId.get(aliasAcc)
    if (acc && acc.sessionId && acc.sessionId === sessionId) {
      return { source: 'lead_alias', label: `别名匹配(${acc.name})` }
    }
  }
  return { source: 'none', label: '' }
}

// ─── 规则评分（纯本地正则；单条消息取最高一项，跨消息累加） ─────────────────────

const THIRD_PARTY_WORDS = ['我朋友', '朋友问', '帮我问', '帮忙问', '替我问', '帮我看下']

/** 单条消息候选分值（BUY_INTENT_RE 是 parseBuySignal 的前置条件，命中即含意向分） */
function messageCandidateScores(content: string): number[] {
  const scores: number[] = []
  const buy = parseBuySignal(content, 0)
  if (buy) {
    scores.push(30)
    if (buy.quantity > 0) scores.push(30)
    if (buy.product) scores.push(35)
  }
  if (isDealSignal(content, 0)) scores.push(40)
  return scores
}

/** 时间衰减（§2.2）：按证据各自消息时间逐条打折；成交证据放缓、无 ×0.2 档 */
function decayFactor(ageDays: number, isDeal: boolean): number {
  if (isDeal) {
    if (ageDays <= 90) return 1.0
    if (ageDays <= 365) return 0.8
    return 0.5
  }
  if (ageDays <= 7) return 1.0
  if (ageDays <= 30) return 0.8
  if (ageDays <= 90) return 0.5
  return 0.2
}

function toMs(t: unknown): number {
  const n = Number(t || 0)
  return n > 1e12 ? n : n * 1000 // 秒/毫秒自适应
}

function visibleText(msg: any): string {
  // ⚠️ HTTP API 对纯文本消息返回 parsedContent 为空串（非 null），?? 会保留空串——必须用 ||
  const raw = String(msg.parsedContent || msg.content || '')
  const text = raw.replace(/<[^>]+>/g, '').replace(/\[[^\]]{1,8}\]/g, ' ').trim()
  // 微信占位提示不是客户说的话，不能当证据/异议原话
  if (text.startsWith('当前微信版本不支持展示该内容')) return ''
  return text
}

/** 对单条客户消息计分并回填会话条目；我方消息只更新联系时间 */
function applyMessage(entry: SessionEntry, msg: any): void {
  const timeMs = toMs(msg.createTime)
  entry.lastContactAt = Math.max(entry.lastContactAt, timeMs)
  const isSend = Number(msg.isSend ?? (msg.isSender === 1 ? 1 : 0))
  if (isSend !== 0) return
  const text = visibleText(msg)
  if (!text || !timeMs || timeMs < NOW_MS - WINDOW_DAYS * DAY_MS) return

  const cands = messageCandidateScores(text)
  const isDeal = cands.includes(40)
  let best = 0
  for (const c of cands) best = Math.max(best, c)
  if (THIRD_PARTY_WORDS.some((w) => text.includes(w))) best -= 25
  if (best > 0) {
    entry.score += best * decayFactor((NOW_MS - timeMs) / DAY_MS, isDeal)
    entry.evidenceCount += 1
    if (timeMs >= entry.lastEvidenceAt) {
      entry.lastEvidenceAt = timeMs
      entry.lastEvidenceText = text.slice(0, 60)
    }
  }

  const risk = parseRiskSignal(text, 0)
  if (risk?.riskType === 'price') {
    entry.priceHits += 1
    if (timeMs >= entry.priceLastTime) {
      entry.priceLastTime = timeMs
      entry.priceLastText = text.slice(0, 60)
    }
  }
  if (risk?.riskType === 'competitor') {
    entry.competitorHits += 1
    // 竞品提及同样留原话（复核需要；此前只存价格异议原话导致比价者列为空）
    entry.compLastText = text.slice(0, 60)
  }
}

/** 先验人群纯规则分桶（§2.2a，不送 AI）；已建档者直接用 canonical stage 不另算 */
function bucketPriorForScan(e: SessionEntry): string {
  const silenceDays = (NOW_MS - Math.max(e.lastContactAt, 0)) / DAY_MS
  if ((e.priceHits > 0 || e.competitorHits > 0) && silenceDays > 90) return '疑似流失（因价）'
  if (e.evidenceCount > 0) return '有互动存量'
  if (silenceDays <= WINDOW_DAYS) return '未联系存量'
  return '长期未联系'
}

// ─── HTTP API 客户端（应用读取层封装） ───────────────────────────────────────

let API_BASE = ''
let API_TOKEN = ''

async function apiGet<T>(path: string, params: Record<string, string>): Promise<T> {
  const qs = new URLSearchParams({ ...params, access_token: API_TOKEN })
  const res = await fetch(`${API_BASE}${path}?${qs}`)
  assert(res.ok, `GET ${path} -> ${res.status}`)
  return await res.json() as T
}

/**
 * 拉取全部会话。⚠️ 实测 /api/v1/sessions 的 offset 参数不生效（翻页恒返回同一页），
 * 故只能单次 limit 上限拉全量；若 count 触顶说明可能被截断，直接报错而非静默漏扫。
 */
async function fetchAllSessions(): Promise<any[]> {
  const data = await apiGet<{ sessions?: any[] }>('/api/v1/sessions', { limit: '10000' })
  const ss = data.sessions || []
  assert(ss.length > 0, '/api/v1/sessions 返回非空数组')
  assert(ss.length < 10000, '会话数触及 limit=10000 上限且 offset 翻页不可用，结果可能截断')
  // 按 username 去重（防御：接口若重复返回同一条）
  const seen = new Set<string>()
  const out = ss.filter((s) => {
    const id = pickSessionId(s)
    if (!id || seen.has(id)) return false
    seen.add(id)
    return true
  })
  console.log(`[scan] 会话去重后 ${out.length} 条`)
  return out
}

/** 拉取一个会话窗口内全部消息（start/end + offset 分页直到 hasMore=false） */
async function fetchWindow(sessionId: string): Promise<any[]> {
  const start = new Date(NOW_MS - WINDOW_DAYS * DAY_MS).toISOString().slice(0, 10).replace(/-/g, '')
  const end = new Date(NOW_MS).toISOString().slice(0, 10).replace(/-/g, '')
  const out: any[] = []
  let offset = 0
  for (let guard = 0; guard < 100; guard++) {
    const data = await apiGet<{ messages?: any[]; hasMore?: boolean }>('/api/v1/messages', {
      talker: sessionId, start, end,
      limit: String(PAGE_SIZE), offset: String(offset),
    })
    const msgs = data.messages || []
    out.push(...msgs)
    if (!data.hasMore || msgs.length === 0) break
    offset += msgs.length
  }
  return out
}

// ─── 输出产物 ────────────────────────────────────────────────────────────────

function fmtDate(ms: number): string {
  return ms ? new Date(ms).toISOString().slice(0, 10) : '-'
}

function maskName(name: string): string {
  if (!name) return '(无名)'
  return name.length <= 3 ? name[0] + '*' : name.slice(0, 2) + '*'.repeat(Math.max(1, name.length - 2))
}

/** 复现性要求排序稳定：segment 固定优先级 + sessionId 字典序 */
function sortEntries(list: SessionEntry[]): SessionEntry[] {
  const segOrder: Record<string, number> = { prior: 0, high: 1, gray: 2, observe: 3 }
  return [...list].sort((a, b) =>
    (segOrder[a.segment] - segOrder[b.segment]) || a.sessionId.localeCompare(b.sessionId))
}

function pickSessionId(s: any): string {
  return String(s.talker ?? s.sessionId ?? s.username ?? s.userName ?? s.wxid ?? s.id ?? '')
}

function pickDisplayName(s: any): string {
  return String(s.sourceName ?? s.nickName ?? s.nickname ?? s.displayName ?? s.remark ?? s.name ?? '').trim()
}

function buildReport(entries: SessionEntry[], stats: Record<string, number>): string {
  const L: string[] = []
  const date = new Date(NOW_MS).toISOString().slice(0, 10)
  L.push(`# P0-5 第一刀扫描报告（${date}）`)
  L.push('')
  L.push('> 只读扫描 · 走 WeFlow HTTP API 读取层 · 本地规则评分 · 零 AI 零写库。生成于 ' +
    new Date(NOW_MS).toISOString())
  L.push('')
  L.push('## 一、总量真相')
  L.push('')
  L.push('| 指标 | 数量 |')
  L.push('|---|---|')
  L.push(`| WCDB 会话总数 | ${stats.totalSessions} |`)
  L.push(`| 身份过滤剔除（无名 wxid 型且无匹配）| ${stats.identityFiltered} |`)
  L.push(`| 进入评分基数 | ${stats.scoreBase} |`)
  L.push(`| 有窗口内消息可算分的会话 | ${stats.withMessages} |`)
  L.push(`| 来源先验命中合计 | ${stats.priorMatched} |`)
  L.push(`| 　├ 已建档(profile.session_id) | ${stats.bySource_profile} |`)
  L.push(`| 　├ account.session_id 直连 | ${stats.bySource_lead_account} |`)
  L.push(`| 　├ lead.wechat 精确 | ${stats.bySource_lead_wechat} |`)
  L.push(`| 　└ alias 别名兜底 | ${stats.bySource_lead_alias} |`)
  L.push('')
  L.push('**lead↔好友匹配率（核心验收指标）**：见上「来源先验命中」四行——')
  L.push('匹配率低 ⇒ 漏损在「加微」环节；匹配率高但分类差 ⇒ 问题在本引擎规则层。')
  L.push('')
  L.push('## 二、自然好友三段分布')
  L.push('')
  const natural = entries.filter((e) => e.priorSource === 'none')
  for (const [seg, title] of [['high', '高置信潜客'], ['gray', '灰区'], ['observe', '待观察']] as const) {
    L.push(`- **${title}（${seg}）：${natural.filter((e) => e.segment === seg).length} 人**`)
  }
  L.push('')
  L.push('## 三、先验人群阶段分组（纯规则分桶）')
  L.push('')
  const prior = entries.filter((e) => e.priorSource !== 'none')
  const buckets = new Map<string, number>()
  for (const p of prior) buckets.set(p.priorBucket || '?', (buckets.get(p.priorBucket || '?') || 0) + 1)
  for (const [b, n] of [...buckets.entries()].sort((x, y) => y[1] - x[1])) L.push(`- ${b}: ${n} 人`)
  L.push('')
  L.push('## 四、因价流失名单 v0（两条路径都算）')
  L.push('')
  const priceList = entries.filter((e) => e.priceHits > 0 || e.competitorHits > 0)
    .sort((a, b) => b.priceLastTime - a.priceLastTime)
  L.push(`命中价格异议/竞品信号的共 **${priceList.length} 人**（Top 50 见下，完整清单在 CSV）。`)
  L.push('')
  L.push('| 谁 | 最近异议原话 | 时间 | 状态归组 |')
  L.push('|---|---|---|---|')
  for (const p of priceList.slice(0, 50)) {
    const grp = p.priorSource !== 'none' ? p.priorBucket : `自然好友·${p.segment}/${Math.round(p.score)}分`
    L.push(`| ${maskName(p.displayName)} | ${p.competitorHits ? '[比价]' : ''}${p.priceLastText || '(历史命中)'} | ${fmtDate(p.priceLastTime)} | ${grp} |`)
  }
  L.push('')
  L.push('## 五、误判类型统计占位（第二刀人工填写）')
  L.push('')
  L.push('| 类型 | 计数 | 备注 |')
  L.push('|---|---|---|')
  L.push('| 同行冒充 |  |  |')
  L.push('| 转述（代人问） |  |  |')
  L.push('| 老黄历成交（多年前已买） |  |  |')
  L.push('| 其他 |  |  |')
  return L.join('\n')
}

function csvEscape(s: string): string {
  return '"' + s.replace(/"/g, '""') + '"'
}

/** 抽样 CSV：Excel 友好（BOM + CRLF），待观察段样本专测 Recall */
function buildChecklistCsv(entries: SessionEntry[]): string {
  const rows: string[][] = [['segment', 'name_masked', 'score', 'evidence_count',
    'last_evidence_date', 'prior_source', 'manual_judgment', 'mistake_type']]
  for (const [seg, want] of SAMPLE_PLAN) {
    const pool = entries.filter((e) =>
      seg === 'observe' ? e.segment === seg && e.priorSource === 'none' : e.segment === seg)
    pool.sort((a, b) => a.sessionId.localeCompare(b.sessionId)) // 确定性等距抽样
    const step = Math.max(1, Math.floor(pool.length / Math.min(want, pool.length)))
    for (let i = 0; i < pool.length && Math.floor(i / step) < want; i += step) {
      const e = pool[i]
      rows.push([seg, maskName(e.displayName), String(Math.round(e.score)), String(e.evidenceCount),
        fmtDate(e.lastEvidenceAt), e.priorSource, '', ''])
    }
  }
  return '﻿' + rows.map((r) => r.map(csvEscape).join(',')).join('\r\n')
}

function countSegments(entries: SessionEntry[]): Record<string, number> {
  const out: Record<string, number> = { prior: 0, high: 0, gray: 0, observe: 0 }
  for (const e of entries) out[e.segment]++
  return out
}

/**
 * 面向人的归组标签（v0.1 校准版）：
 * - 先验人群沿用纯规则分桶；
 * - 自然好友 high/gray 照旧；其余按「是否议价」+ 联系新鲜度细分——
 *   价格异议者不再与沉默客户混在待观察里（2026-08-27 用户复核反馈）。
 */
function displayGroup(e: SessionEntry): string {
  if (e.priorSource !== 'none') return e.priorBucket || '先验人群'
  if (e.segment === 'high') return '自然好友·高置信潜客'
  if (e.segment === 'gray') return '自然好友·灰区（待AI精判）'
  const silentDays = e.lastContactAt ? Math.floor((NOW_MS - e.lastContactAt) / DAY_MS) : Infinity
  if (e.priceHits > 0 || e.competitorHits > 0) {
    const tag = silentDays <= 30 ? '近期议价' : silentDays <= 180 ? '议价冷却' : '议价沉睡'
    return `自然好友·议价流失风险（${tag}）`
  }
  const bucket = silentDays <= 30 ? '近30天活跃' : silentDays <= 90 ? '近90天有联系'
    : silentDays <= 180 ? '半年内' : '超期沉默'
  return `自然好友·待观察（${bucket}）`
}

/** 全量分类文件：每位联系人一行 */
function buildFullCsv(entries: SessionEntry[]): string {
  const rows: string[][] = [['会话ID', '显示名', '分类归组', '来源先验', '综合评分', '证据数',
    '最近证据日期', '最近证据原话', '最近联系日期', '价格异议次数', '竞品提及次数',
    '最近价格异议原话', '最近竞品提及原话']]
  for (const e of entries) {
    rows.push([e.sessionId, e.displayName || '(无名)', displayGroup(e),
      e.priorSource === 'none' ? '-' : e.priorSource,
      String(Math.round(e.score)), String(e.evidenceCount),
      fmtDate(e.lastEvidenceAt), e.lastEvidenceText, fmtDate(e.lastContactAt),
      String(e.priceHits), String(e.competitorHits), e.priceLastText, e.compLastText])
  }
  return '﻿' + rows.map((r) => r.map(csvEscape).join(',')).join('\r\n')
}

/**
 * 人眼复核聚焦清单：自然好友里值得人工判断的部分——
 * 高置信 + 灰区 + 议价流失风险（即价格异议/竞品命中者），评分降序。第二刀校准的直接输入。
 */
function buildFocusCsv(entries: SessionEntry[]): string {
  const pick = entries.filter((e) => e.priorSource === 'none' &&
    (e.segment !== 'observe' || e.priceHits > 0 || e.competitorHits > 0))
    .sort((a, b) => (Math.round(b.score) - Math.round(a.score)) ||
      a.sessionId.localeCompare(b.sessionId))
  const rows: string[][] = [['显示名', '分类归组', '综合评分', '证据数', '最近证据日期',
    '最近计分证据原话', '最近联系日期', '价格异议次数', '竞品提及次数',
    '最近价格异议原话', '最近竞品提及原话', '人工判断(真客户?)/误判类型']]
  for (const e of pick) {
    rows.push([e.displayName, displayGroup(e), String(Math.round(e.score)), String(e.evidenceCount),
      fmtDate(e.lastEvidenceAt), e.lastEvidenceText, fmtDate(e.lastContactAt),
      String(e.priceHits), String(e.competitorHits), e.priceLastText, e.compLastText, ''])
  }
  return '﻿' + rows.map((r) => r.map(csvEscape).join(',')).join('\r\n')
}

// ─── 主流程 ─────────────────────────────────────────────────────────────────

/**
 * Token 获取顺序：
 * 1) 环境变量 P05_API_TOKEN
 * 2) 命令行第一个参数
 * 3) /tmp/weflow-api-token.txt 文件内容
 * 磁盘配置里的 httpApiToken 是 safe: 前缀的 safeStorage 密文，脚本无法解密，
 * 必须由用户从设置页复制明文（只在本机回环使用）。
 */
function resolveApiToken(cfg: Record<string, unknown>): string {
  const fromEnv = process.env.P05_API_TOKEN?.trim()
  if (fromEnv) return fromEnv
  const fromArgv = process.argv[2]?.trim()
  if (fromArgv) return fromArgv
  const tokenFile = '/tmp/weflow-api-token.txt'
  if (existsSync(tokenFile)) {
    const t = readFileSync(tokenFile, 'utf8').trim()
    if (t) return t
  }
  const diskVal = String(cfg.httpApiToken || '')
  if (diskVal && !diskVal.startsWith('safe:') && !diskVal.startsWith('lock:')) return diskVal
  throw new Error(
    'API Token 是应用内 safeStorage 加密值，脚本无法解密。\n' +
    '请任选其一：① export P05_API_TOKEN=<设置页里的Token>\n' +
    '② npx tsx scripts/p0-5-scan.ts <Token>\n' +
    '③ 把 Token 写入 /tmp/weflow-api-token.txt')
}

async function main(): Promise<void> {
  assert(existsSync(CONFIG_JSON), '配置文件存在')
  const cfg = JSON.parse(readFileSync(CONFIG_JSON, 'utf8'))
  API_BASE = `http://${cfg.httpApiHost || '127.0.0.1'}:${cfg.httpApiPort || 5031}`
  API_TOKEN = resolveApiToken(cfg)
  console.log(`[api] ${API_BASE}（token 来源：${
    process.env.P05_API_TOKEN ? 'env' : process.argv[2] ? 'argv' :
    existsSync('/tmp/weflow-api-token.txt') ? 'file' : 'config 明文' }）`)

  const meta = await loadMetaTables()
  const idx = buildAccountIndex(meta.accounts, meta.aliases)
  const profileStages = new Map<string, string>(
    meta.profiles.map((p: any) => [String(p.session_id), String(p.stage ?? 'unknown')]))

  const sessions = await fetchAllSessions()
  console.log(`[scan] 会话总数=${sessions.length}`)

  const stats: Record<string, number> = {
    totalSessions: sessions.length, identityFiltered: 0, scoreBase: 0, withMessages: 0,
    priorMatched: 0,
    bySource_profile: 0, bySource_lead_account: 0, bySource_lead_wechat: 0, bySource_lead_alias: 0,
  }
  const entries: SessionEntry[] = []
  let progress = 0

  for (const s of sessions) {
    const sessionId = pickSessionId(s)
    const displayName = pickDisplayName(s)
    if (++progress % 20 === 0) console.log(`[scan] 进度 ${progress}/${sessions.length}`)

    // 无名 session 门控：无展示名一律不进任何名单输出（含非 wxid 形态，红线 #4）
    if (!displayName) {
      stats.identityFiltered++
      continue
    }
    // 备注前缀「删除我的人」= 对方已单删用户（2026-08-27 用户确认），非可触达人群，剔除
    if (displayName.startsWith('删除我的人')) {
      stats.identityFiltered++
      continue
    }
    // 工具号/系统会话：机器人、自己的文件传输助手等，非客户人群（⚠️ 物流/供应商/人事等关键词群体
    // 经用户确认为客户为主，严禁按行业词过滤）
    // wxid_5i6hswzounoq22 = 测试号「🎃」（2026-08-27 用户确认其聊天为假数据：自聊粘贴开发文档用），
    // 其消息曾误触发评分/风险词并污染因价名单——按测试账号剔除，与客户无关
    if (/^wxid_5i6hswzounoq22$/i.test(sessionId)) {
      stats.identityFiltered++
      continue
    }
    if (/@weclaw$|^filehelper$|^weixin$|^floatbottle$|^medianote$/i.test(sessionId)) {
      stats.identityFiltered++
      continue
    }
    // 群聊不计客户评分：群消息多人混杂，parseBuySignal 口径只对私聊客户消息成立
    if (sessionId.endsWith('@chatroom')) {
      stats.identityFiltered++
      continue
    }
    // 公众号/服务号：非潜在客户人群
    if (sessionId.startsWith('gh_')) {
      stats.identityFiltered++
      continue
    }

    const prior = matchPrior(sessionId, displayName, meta.leads, meta.accounts, idx, profileStages)
    stats[`bySource_${prior.source}`]++
    const entry: SessionEntry = {
      sessionId, displayName,
      priorSource: prior.source, priorLabel: prior.label, priorStage: prior.stage,
      score: 0, evidenceCount: 0, lastEvidenceAt: 0, lastEvidenceText: '', lastContactAt: 0,
      segment: 'observe', priceHits: 0, priceLastText: '', priceLastTime: 0,
      competitorHits: 0, compLastText: '',
    }
    stats.scoreBase++

    const msgs = await fetchWindow(sessionId)
    if (msgs.length) {
      stats.withMessages++
      for (const m of msgs) applyMessage(entry, m)
    }

    if (prior.source === 'profile') {
      entry.segment = 'prior'
      entry.priorBucket = `已建档·${prior.stage}`
    } else if (prior.source !== 'none') {
      entry.segment = 'prior'
      entry.priorBucket = bucketPriorForScan(entry)
    } else {
      entry.segment = entry.score >= HIGH_THRESHOLD ? 'high'
        : entry.score >= GRAY_THRESHOLD ? 'gray' : 'observe'
    }
    entries.push(entry)
  }
  stats.priorMatched = entries.filter((e) => e.priorSource !== 'none').length

  const sorted = sortEntries(entries)
  mkdirSync(OUT_DIR, { recursive: true })
  const stamp = new Date(NOW_MS).toISOString().slice(0, 10).replace(/-/g, '')
  const reportPath = join(OUT_DIR, `p0-5-scan-report-${stamp}.md`)
  const csvPath = join(OUT_DIR, `p0-5-checklist-${stamp}.csv`)
  writeFileSync(reportPath, buildReport(sorted, stats), 'utf8')
  writeFileSync(csvPath, buildChecklistCsv(sorted), 'utf8')
  const fullPath = join(OUT_DIR, `p0-5-full-${stamp}.csv`)
  writeFileSync(fullPath, buildFullCsv(sorted), 'utf8')
  const focusPath = join(OUT_DIR, `p0-5-review-focus-${stamp}.csv`)
  writeFileSync(focusPath, buildFocusCsv(sorted), 'utf8')
  console.log(`[out] 全量分类: ${fullPath}（${sorted.length} 行）`)
  console.log(`[out] 复核聚焦: ${focusPath}`)

  console.log(`[out] 报告: ${reportPath}`)
  console.log(`[out] 抽验清单: ${csvPath} (${SAMPLE_PLAN.map(([sn, n]) => `${sn}:${n}`).join('/')})`)
  console.log('[done] 分段统计:', JSON.stringify(countSegments(entries)))
}

main().catch((e) => {
  console.error('[fatal]', e)
  process.exit(1)
})
