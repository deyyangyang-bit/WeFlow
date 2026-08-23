/**
 * evidenceKey.ts —— messageKey 的纯解析（P0-2B Evidence Resolver 解析侧）
 *
 * 与 shared/messageKey.ts（构造侧）配对：构造侧产出 4 种格式 + 历史裸数字，
 * 解析侧按同一规则分类并取定位字段。纯函数约束（P0-2B 边界）：
 * 不依赖 Electron、不读 DB、无副作用；serverId 保留字符串（16+ 位超出 Number 精度）。
 *
 * 格式（段 encodeURIComponent 编码，':' 分隔）：
 *   canonical（主）：encoded(dbPath):encoded(tableName):localId
 *   local:    local:encoded(scope):localId:createTime:sortSeq:sender:localType
 *   server:   server:encoded(scope):serverId:createTime:sortSeq:localId:sender:localType
 *   fallback: fallback:encoded(scope):createTime:sortSeq:localId:sender:localType
 *   裸数字（历史）：7624353663315474928
 *
 * 分类规则（与 docs/P0-2B 设计 §2 一致）：
 *   trim 后为空                                   → unparseable
 *   /^\d+$/（纯数字）                              → { kind:'serverId', serverId: 原样字符串 }
 *   parts[0]==='local'     且 parts[2] 为数字      → { kind:'localId', localId }
 *   parts[0]==='server'    且 parts[2] 为数字      → { kind:'serverId', serverId: parts[2] }
 *   parts[0]==='fallback'  且 parts[4] 为数字      → { kind:'localId', localId }
 *   默认（canonical，3 段）且末段为数字            → { kind:'localId', localId: 末段 }
 *   其余                                              → unparseable
 */

export type EvidenceKeyParsed =
  | { kind: 'localId'; localId: number; dbPath?: string; tableName?: string }
  | { kind: 'serverId'; serverId: string; dbPath?: string }
  | { kind: 'unparseable' }

/** 安全 decode 单段：非法 percent-encoding 原样返回，不抛错 */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

/** 非负安全整数解析（localId 用；serverId 不走此函数，原样保留字符串） */
function parseSafeLocalId(segment: string | undefined): number | null {
  if (segment === undefined) return null
  if (!/^\d+$/.test(segment)) return null
  const n = Number(segment)
  if (!Number.isSafeInteger(n) || n < 0) return null
  return n
}

export function parseEvidenceKey(messageKey: string): EvidenceKeyParsed {
  const trimmed = String(messageKey || '').trim()
  if (!trimmed) return { kind: 'unparseable' }

  // 裸数字：历史 serverId，原样保留字符串（精度无损）
  if (/^\d+$/.test(trimmed)) return { kind: 'serverId', serverId: trimmed }

  const parts = trimmed.split(':')
  const head = parts[0]

  if (head === 'local') {
    const localId = parseSafeLocalId(parts[2])
    if (localId === null) return { kind: 'unparseable' }
    return { kind: 'localId', localId, dbPath: parts[1] !== undefined ? decodeSegment(parts[1]) : undefined }
  }

  if (head === 'server') {
    const serverId = parts[2]
    if (serverId === undefined || !/^\d+$/.test(serverId)) return { kind: 'unparseable' }
    return { kind: 'serverId', serverId, dbPath: parts[1] !== undefined ? decodeSegment(parts[1]) : undefined }
  }

  if (head === 'fallback') {
    const localId = parseSafeLocalId(parts[4])
    if (localId === null) return { kind: 'unparseable' }
    return { kind: 'localId', localId, dbPath: parts[1] !== undefined ? decodeSegment(parts[1]) : undefined }
  }

  // 默认 canonical：3 段且末段为数字
  if (parts.length === 3) {
    const localId = parseSafeLocalId(parts[2])
    if (localId !== null) {
      return {
        kind: 'localId',
        localId,
        dbPath: parts[0] !== undefined ? decodeSegment(parts[0]) : undefined,
        tableName: parts[1] !== undefined ? decodeSegment(parts[1]) : undefined
      }
    }
  }

  return { kind: 'unparseable' }
}
