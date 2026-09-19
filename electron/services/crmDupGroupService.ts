/**
 * crmDupGroupService.ts —— 撞客方案一期：重复组本机侧（宪法 §3.1 duplicate_group 登记行）
 *
 * ① applyDupGroupEvent：中央下行 duplicate_group 广播事件（下行投影白名单唯一成员，
 *    shared/centralSync.DOWN_PROJECTION_ENTITY_TYPES）落本地 crmDb.dup_group。
 *    member_count 单调：晚到的旧事件（成员数更小）不回退小组；重复投递幂等返回 true。
 * ② listDupMatches：线索/客户行徽标匹配。本机联系方式用与上行投影**同一** identityHash
 *    算法（centralProjection.identityHash，归一后 sha256）锚定到重复组；命中只回
 *    「对方归属人姓名」（成员 ownerSales 里过滤掉本机署名）——不回对方任何资料。
 */
import { createHash } from 'crypto'
import { crmDbService, type CrmRow } from './crmDbService'
import { identityHash } from './centralProjection'
import { getIdentity } from './identityService'

export interface DupGroupPayload {
  anchorType?: string
  anchorHash?: string
  anchorMasked?: string
  membersJson?: string
  memberCount?: number
}

interface DupMember { customerRef?: unknown; ownerSales?: unknown }

/** 本地成员规范化：结构校验 + 按 customerRef 去重 + 稳定排序（与 central/src/duplicateGroup.mergeDuplicateGroupMembers 同构语义） */
function canonicalizeMembers(members: DupMember[]): DupMember[] | null {
  const byRef = new Map<string, DupMember>()
  for (const m of members) {
    if (!m || typeof m !== 'object') return null
    if (typeof m.customerRef !== 'string' || !m.customerRef) return null
    if (typeof m.ownerSales !== 'string') return null
    byRef.set(m.customerRef, { customerRef: m.customerRef, ownerSales: m.ownerSales })
  }
  return [...byRef.values()].sort((a, b) => (a.customerRef! < b.customerRef! ? -1 : a.customerRef! > b.customerRef! ? 1 : 0))
}

/** canonical 成员内容摘要（sha256 前 16 hex，输入顺序无关）：与 central/src/duplicateGroup.duplicateGroupDigest 同构 */
function contentDigestOf(members: DupMember[]): string {
  const canonical = JSON.stringify(members)
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16)
}

/**
 * 中央下行重复组事件落地。
 *
 * P1c 版本裁决（不再依赖 member_count——中央按内容摘要广播，三人组 ownerSales 变化也会
 * 产生同 member_count 的新事件，旧「member_count 单调」判断会把它静默丢弃）：
 *   - 事件版本优先取信封 aggregateVersion（centralSyncService 传入）；缺省回退 payload.memberCount（旧事件兼容）；
 *   - 新版本 > 本地版本：覆盖落地（即使 member_count 相同）；
 *   - 相同版本且内容摘要一致：幂等（零写）；
 *   - 相同版本但内容不同：拒绝（invalid/conflict）——绝不静默覆盖；
 *   - 更旧版本：不回退（幂等吞掉，回 applied——晚到旧事件是重复投递不是错误）。
 * members_json 落地前仍做结构校验、去重与稳定排序。
 */
export function applyDupGroupEvent(payload: Record<string, unknown>, aggregateVersion?: number): boolean {
  const anchorType = String(payload?.anchorType || '')
  const anchorHash = String(payload?.anchorHash || '')
  const anchorMasked = String(payload?.anchorMasked || '')
  const membersJson = String(payload?.membersJson || '[]')
  const memberCount = Number(payload?.memberCount || 0)
  if ((anchorType !== 'phone' && anchorType !== 'wechat') || !/^[0-9a-f]{64}$/.test(anchorHash)) return false
  if (!Number.isInteger(memberCount) || memberCount < 2) return false
  let parsed: DupMember[]
  try { parsed = JSON.parse(membersJson) as DupMember[] } catch { return false }
  if (!Array.isArray(parsed) || parsed.length !== memberCount) return false
  const members = canonicalizeMembers(parsed)
  if (!members || members.length !== memberCount) return false
  const canonicalJson = JSON.stringify(members)
  const digest = contentDigestOf(members)
  // 事件版本：信封 aggregateVersion 优先；历史载荷无版本时回退 memberCount（中央旧事件语义）
  const incomingVersion = Number.isFinite(Number(aggregateVersion)) && Number(aggregateVersion) > 0
    ? Math.floor(Number(aggregateVersion))
    : memberCount
  const prev = crmDbService.all(
    'SELECT member_count, aggregate_version, content_digest FROM dup_group WHERE anchor_type = ? AND anchor_hash = ?',
    [anchorType, anchorHash])[0]
  if (prev) {
    const prevVersion = Number(prev.aggregate_version || 0)
    const prevDigest = String(prev.content_digest || '')
    if (incomingVersion < prevVersion) return true // 更旧版本：不回退（晚到/重放）
    if (incomingVersion === prevVersion) {
      if (!prevDigest || prevDigest === digest) return true // 同版本同内容（或存量行无摘要）：幂等
      return false // 同版本不同内容：冲突，拒绝静默覆盖
    }
  }
  const now = Date.now()
  crmDbService.runTx((tx) => {
    if (prev) {
      tx.run(
        `UPDATE dup_group SET anchor_masked = ?, members_json = ?, member_count = ?, aggregate_version = ?, content_digest = ?, updated_at = ?
         WHERE anchor_type = ? AND anchor_hash = ?`,
        [anchorMasked, canonicalJson, members.length, incomingVersion, digest, now, anchorType, anchorHash]
      )
    } else {
      tx.run(
        `INSERT INTO dup_group (anchor_type, anchor_hash, anchor_masked, members_json, member_count, aggregate_version, content_digest, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [anchorType, anchorHash, anchorMasked, canonicalJson, members.length, incomingVersion, digest, now, now]
      )
    }
  })
  return true
}

export interface DupBadgeInfo {
  /** 身份展示掩码（中央下发的 identityMasked，可能为空） */
  mask: string
  /** 对方归属人姓名（成员 ownerSales 过滤掉本机署名；辨识不出时回退「其他同事」） */
  others: string[]
}
export interface DupMatchResult {
  groupCount: number
  /** key = lead.id */
  leadMatches: Record<string, DupBadgeInfo>
  /** key = account.id */
  customerMatches: Record<string, DupBadgeInfo>
}

function matchesForRows(rows: CrmRow[], anchorsOf: (row: CrmRow) => string[], byHash: Map<string, DupBadgeInfo>): Record<string, DupBadgeInfo> {
  const out: Record<string, DupBadgeInfo> = {}
  for (const row of rows) {
    for (const key of anchorsOf(row)) {
      const hit = key ? byHash.get(key) : undefined
      if (hit) { out[String(row.id)] = hit; break }
    }
  }
  return out
}

/** 线索/客户行徽标匹配（每次列表装载调用一次；哈希为同步 sha256，量级数百行无压力） */
export function listDupMatches(): DupMatchResult {
  const groups = crmDbService.all('SELECT anchor_type, anchor_hash, anchor_masked, members_json FROM dup_group')
  const empty: DupMatchResult = { groupCount: groups.length, leadMatches: {}, customerMatches: {} }
  if (!groups.length) return empty
  const myName = String(getIdentity()?.name || '')
  const byHash = new Map<string, DupBadgeInfo>()
  for (const g of groups) {
    let members: DupMember[] = []
    try { members = JSON.parse(String(g.members_json || '[]')) as DupMember[] } catch { members = [] }
    const owners = members.map((m) => String(m?.ownerSales || '')).filter(Boolean)
    const others = [...new Set(owners)].filter((n) => n !== myName)
    byHash.set(`${String(g.anchor_type)}:${String(g.anchor_hash)}`, {
      mask: String(g.anchor_masked || ''),
      others: others.length ? others : (owners.length ? owners : ['其他同事'])
    })
  }
  const leadAnchor = (l: CrmRow): string[] => {
    const type = String(l.contact_type || '')
    const normalized = String(l.contact_normalized || '')
    const wechat = String(l.wechat || '')
    if (type === 'both') return [hashKey('phone', normalized), hashKey('wechat', wechat)]
    if (type === 'wechat') return [hashKey('wechat', normalized)]
    return [hashKey('phone', normalized)]
  }
  const customerAnchor = (a: CrmRow): string[] => {
    // 客户卡片身份锚点：account.phone + custom_fields 内嵌 wxid（与导入查重同读法）
    const wx = /"wxid"\s*:\s*"([^"]+)"/.exec(String(a.custom_fields || ''))?.[1] || ''
    return [hashKey('phone', String(a.phone || '')), hashKey('wechat', wx)]
  }
  return {
    groupCount: groups.length,
    leadMatches: matchesForRows(crmDbService.all('SELECT id, contact_type, contact_normalized, wechat FROM lead'), leadAnchor, byHash),
    customerMatches: matchesForRows(crmDbService.all('SELECT id, phone, custom_fields FROM account'), customerAnchor, byHash)
  }
}

function hashKey(identityType: string, identityValue: string): string {
  if (!identityValue) return ''
  return `${identityType}:${identityHash(identityType, identityValue)}`
}
