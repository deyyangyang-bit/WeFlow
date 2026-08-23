/**
 * messageKey.ts —— 消息 messageKey 的规范构造（P0-2B）
 *
 * canonical messageKey = 证据链唯一标识（intent_tag_log.message_key /
 * follow_up_task.source_message_id 未来唯一写入格式）。
 * 从 chatService 私有方法 + apiMessageMapping 拷贝提取为共享纯函数（单一真源），
 * 消除「两处必须保持一致」的漂移风险，并让所有写者产出格式一致的 key。
 *
 * 纯函数约束（P0-2B 边界）：不依赖 Electron、不依赖 chatService、不读 DB、无副作用。
 *
 * 格式（段 encodeURIComponent 编码，':' 分隔）：
 *   canonical（主）：encoded(dbPath):encoded(tableName):localId
 *   local:    local:encoded(scope):localId:createTime:sortSeq:sender:localType
 *   server:   server:encoded(scope):serverId:createTime:sortSeq:localId:sender:localType
 *   fallback: fallback:encoded(scope):createTime:sortSeq:localId:sender:localType
 * 分支优先级：canonical → local → server → fallback（与 chatService/apiMessageMapping 原实现完全一致，不改格式）。
 *
 * 零依赖说明：原 chatService 私有实现用 Node `path.basename(dbPath, extname(dbPath))` 派生 dbName。
 * 该派生值只在 dbPath 缺省时进入 sourceScope，而派生前提恰恰是 dbPath 非空，故其值永不参与任何输出。
 * 这里用等价纯字符串计算替代（去尾部分隔符 → 取末段 → 去扩展名），行为与原实现一致且不引入 Node 类型。
 */
/** 派生 dbName：取路径末段去扩展名（等价 Node basename(dbPath, extname(dbPath))） */
function deriveDbName(dbPath: string): string {
  const normalized = dbPath.replace(/[\\/]+$/, '')
  const base = normalized.split(/[\\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(0, dot) : base
}

/** buildMessageKey 入参（与 chatService/apiMessageMapping 原私有签名逐字段一致） */
export interface MessageKeyInput {
  localId: number
  serverId: number
  createTime: number
  sortSeq: number
  senderUsername?: string | null
  localType: number
  dbName?: string
  tableName?: string
  dbPath?: string
}

/** 段编码：trim + encodeURIComponent（同原实现） */
export function encodeMessageKeySegment(value: unknown): string {
  const normalized = String(value ?? '').trim()
  return encodeURIComponent(normalized)
}

/** 构造 messageKey。纯函数，输出只由入参决定。 */
export function buildMessageKey(input: MessageKeyInput): string {
  const localId = Number.isFinite(input.localId) ? Math.max(0, Math.floor(input.localId)) : 0
  const serverId = Number.isFinite(input.serverId) ? Math.max(0, Math.floor(input.serverId)) : 0
  const createTime = Number.isFinite(input.createTime) ? Math.max(0, Math.floor(input.createTime)) : 0
  const sortSeq = Number.isFinite(input.sortSeq) ? Math.max(0, Math.floor(input.sortSeq)) : 0
  const localType = Number.isFinite(input.localType) ? Math.floor(input.localType) : 0
  const senderUsername = encodeMessageKeySegment(input.senderUsername || '')
  const dbPath = String(input.dbPath || '').trim()
  const dbName = String(input.dbName || '').trim() || (input.dbPath ? deriveDbName(input.dbPath) : '')
  const tableName = String(input.tableName || '').trim()
  const sourceScope = dbPath || dbName

  if (localId > 0 && sourceScope && tableName) {
    return `${encodeMessageKeySegment(sourceScope)}:${encodeMessageKeySegment(tableName)}:${localId}`
  }

  if (localId > 0 && sourceScope) {
    // 当底层未返回 table_name 时，避免使用 db:_:localId（会误并同库不同表的消息）。
    return `local:${encodeMessageKeySegment(sourceScope)}:${localId}:${createTime}:${sortSeq}:${senderUsername}:${localType}`
  }

  if (serverId > 0) {
    const scopedServer = sourceScope ? `${encodeMessageKeySegment(sourceScope)}:${serverId}` : String(serverId)
    return `server:${scopedServer}:${createTime}:${sortSeq}:${localId}:${senderUsername}:${localType}`
  }

  return `fallback:${encodeMessageKeySegment(sourceScope)}:${createTime}:${sortSeq}:${localId}:${senderUsername}:${localType}`
}
