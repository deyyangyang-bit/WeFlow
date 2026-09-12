/** 知识库“当前版本”读取语义：同一 logical_id 链取版号最大的 published 行。 */

export interface KnowledgeVersionRow {
  id: number
  title: string
  logical_id?: string | null
  version?: number | null
  status?: string | null
  updated_at?: number | null
}

export function knowledgeChainKey(row: KnowledgeVersionRow): string {
  return String(row.logical_id || '').trim() || `title:${String(row.title || '').trim()}`
}

function isNewer(a: KnowledgeVersionRow, b: KnowledgeVersionRow): boolean {
  const versionDiff = Number(a.version || 0) - Number(b.version || 0)
  if (versionDiff !== 0) return versionDiff > 0
  const updatedDiff = Number(a.updated_at || 0) - Number(b.updated_at || 0)
  return updatedDiff !== 0 ? updatedDiff > 0 : Number(a.id) > Number(b.id)
}

export function currentPublishedEntries<T extends KnowledgeVersionRow>(rows: T[]): T[] {
  const latest = new Map<string, T>()
  for (const row of rows) {
    if (row.status !== 'published') continue
    const key = knowledgeChainKey(row)
    const previous = latest.get(key)
    if (!previous || isNewer(row, previous)) latest.set(key, row)
  }
  return rows.filter((row) => row.status === 'published' && latest.get(knowledgeChainKey(row)) === row)
}

export function currentPublishedOfChain<T extends KnowledgeVersionRow>(chain: T[]): T | undefined {
  return currentPublishedEntries(chain)[0]
}

/**
 * 搜索或分类结果只能决定候选范围；“是否当前版本”始终由全量版本事实决定。
 * 因此只命中历史正文或旧分类时，历史 published 不会重新出现在主列表。
 */
export function visibleCurrentPublishedEntries<T extends KnowledgeVersionRow>(candidates: T[], allRows: T[]): T[] {
  const currentIds = new Set(currentPublishedEntries(allRows).map((row) => row.id))
  return candidates.filter((row) => row.status === 'published' && currentIds.has(row.id))
}
