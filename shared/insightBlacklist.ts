/**
 * insightBlacklist.ts —— 「AI 见解屏蔽名单」条目的唯一归一化实现（SSOT）。
 *
 * 语义（P0-5 拍板边界）：不触发 AI 见解 ≠ 非客户。该名单是**见解链专用**的屏蔽表，
 * 由用户手动管理，不再有「AI 自动判定」写入链路（该链路已随 AI 简报改造删除）。
 *
 * 存储形态演进：旧版为 `string[]`（sessionId 列表，由已下线的自动判定写入），
 * 新版为 `{sessionId, addedAt, source}[]`。主进程与渲染层都必须经由本文件读写，
 * 不得各自实现第二套归一化。
 *
 * 向后兼容读：旧 `string[]` 归一为 `{addedAt: null, source: 'legacy_auto'}`。
 * `addedAt: null` 表示「时间无记录」，调用方**不得伪造日期**。
 */

/** 条目来源：legacy_auto = 已下线的自动判定写入；manual = 用户显式加入 */
export type InsightBlacklistSource = 'legacy_auto' | 'manual'

export interface InsightBlacklistEntry {
  sessionId: string
  /** 加入时间（epoch 毫秒，与 JS 侧一致）；null = 旧格式无记录，不得伪造 */
  addedAt: number | null
  source: InsightBlacklistSource
}

const SOURCES: readonly string[] = ['legacy_auto', 'manual']

/** 非法/缺失来源一律回落 legacy_auto：只有用户显式操作才配记为 manual */
function normalizeSource(value: unknown): InsightBlacklistSource {
  const raw = String(value ?? '').trim()
  return SOURCES.includes(raw) ? (raw as InsightBlacklistSource) : 'legacy_auto'
}

/** 时间归一：非有限正数（含 null/undefined/''）一律视为「无记录」 */
function normalizeAddedAt(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

function normalizeEntry(item: unknown): InsightBlacklistEntry | null {
  // 旧格式：裸 sessionId 字符串 → legacy_auto、时间无记录
  if (typeof item === 'string') {
    const sessionId = item.trim()
    return sessionId ? { sessionId, addedAt: null, source: 'legacy_auto' } : null
  }
  if (!item || typeof item !== 'object') return null
  const raw = item as Record<string, unknown>
  const sessionId = String(raw.sessionId ?? '').trim()
  if (!sessionId) return null
  return { sessionId, addedAt: normalizeAddedAt(raw.addedAt), source: normalizeSource(raw.source) }
}

/**
 * 归一化名单，兼容旧 `string[]` 与新对象数组。
 * 逐项 trim、去空、按 sessionId 去重（保序，首次出现者胜）。
 */
export function normalizeInsightBlacklist(value: unknown): InsightBlacklistEntry[] {
  if (!Array.isArray(value)) return []
  const out: InsightBlacklistEntry[] = []
  const seen = new Set<string>()
  for (const item of value) {
    const entry = normalizeEntry(item)
    if (!entry || seen.has(entry.sessionId)) continue
    seen.add(entry.sessionId)
    out.push(entry)
  }
  return out
}

/** 是否命中屏蔽（比较前 trim，避免旧数据带空格导致漏判） */
export function isInsightBlacklisted(value: unknown, sessionId: string): boolean {
  const target = String(sessionId ?? '').trim()
  if (!target) return false
  return normalizeInsightBlacklist(value).some((entry) => entry.sessionId === target)
}

/**
 * 加入名单。已存在则原样返回——不覆盖既有来源与时间，
 * 避免把 legacy_auto 的存量条目洗成 manual。
 */
export function addInsightBlacklistEntry(
  value: unknown,
  sessionId: string,
  source: InsightBlacklistSource,
  addedAt: number
): InsightBlacklistEntry[] {
  const list = normalizeInsightBlacklist(value)
  const target = String(sessionId ?? '').trim()
  if (!target || list.some((entry) => entry.sessionId === target)) return list
  return [...list, { sessionId: target, addedAt: normalizeAddedAt(addedAt), source: normalizeSource(source) }]
}

/** 解除屏蔽；不在名单中则原样返回 */
export function removeInsightBlacklistEntry(value: unknown, sessionId: string): InsightBlacklistEntry[] {
  const list = normalizeInsightBlacklist(value)
  const target = String(sessionId ?? '').trim()
  if (!target) return list
  return list.filter((entry) => entry.sessionId !== target)
}
