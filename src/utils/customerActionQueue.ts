/**
 * customerActionQueue.ts —— 客户工作台行动队列构建（设计稿-客户工作台简化 屏 1，纯函数可 tsx 单测）
 *
 * 三源合并为一列行动卡（都是「AI/系统有件事要你处理」）：
 *   follow  = 值得跟进（unified signals 带 task 源，R0-R8 规则触发）→ 待跟进 amber
 *   info    = 信息待确认（crmStore.queues.infoPending，AI 中置信字段填充）→ AI 发现 blue
 *   insight = AI 新发现（信号无 task 源，24h 未读洞察）→ AI 发现 blue
 * 同客户 follow 与 insight 并存时只留 follow（insight 是弱信号，跟进卡已回答「找 TA」）；
 * info 卡独立保留（动作不同：采纳/放弃，不与聊天动作互斥）。
 * 排序：follow（priorityScore 降序）→ info → insight（score 降序）。
 * 本模块只读输入，绝不改数据；owner 过滤在上游 setCustomers 处已完成（filterByOwner），队列继承其口径。
 */

export type ActionCardKind = 'follow' | 'info' | 'insight'

export interface ActionCardItem {
  /** 唯一键：follow/insight = `sig:<sessionId>`；info = `info:<account_id>:<field>` */
  key: string
  kind: ActionCardKind
  /** pill 语义（设计稿：待跟进=amber / AI 发现=blue） */
  pill: 'amber' | 'blue'
  pillText: string
  /** 客户行（info 卡可能找不到行——未导入 CRM 的 account；此时用 infoItem 兜底展示） */
  customer: any | null
  sessionId: string
  displayName: string
  accountId?: number
  /** 一行「为什么找 TA」 */
  reason: string
  /** 一行「建议做什么 / 证据」 */
  suggest: string
  /** 原始信号（follow/insight 卡完成闭环 completeSignal 用） */
  signal?: any
  /** 原始 info 条目（采纳/放弃 applyInfo 用） */
  infoItem?: any
  /** info 卡字段中文名 */
  fieldLabel?: string
}

export interface QueueFieldMeta { [field: string]: string }

const DEFAULT_FIELD_LABELS: QueueFieldMeta = {
  company: '公司', position: '职位', phone: '电话', industry: '行业', province: '省份', city: '城市',
  needs: '需求', budget: '预算', intent_model: '意向型号', purchase_timeframe: '采购时间',
  competitor: '竞品', price_sensitive: '价格敏感度'
}

const withTask = (s: any): boolean => (s?.sources || []).some((src: any) => src.type === 'task')
const scoreOf = (s: any): number => Number(s?.priorityScore ?? 0)

/** 客户行展示名（与页面 displayNameOf 同口径：画像最新备注优先，account.name 兜底） */
function nameOf(c: any): string {
  return String(c?.profile_display_name || '') || String(c?.name || '')
}

export function buildActionQueue(
  customers: any[],
  signals: any[],
  infoPending: any[],
  fieldLabels: QueueFieldMeta = DEFAULT_FIELD_LABELS
): ActionCardItem[] {
  const bySession = new Map<string, any>()
  for (const s of signals || []) {
    const sid = String(s?.sessionId || '')
    if (!sid) continue
    const prev = bySession.get(sid)
    if (!prev) { bySession.set(sid, s); continue }
    // 防御脏数据：同会话多条信号 → 合并 sources（task 源随合并保留），分数取高
    bySession.set(sid, {
      ...prev,
      sources: [...(prev.sources || []), ...(s.sources || [])],
      priorityScore: Math.max(scoreOf(prev), scoreOf(s)),
      analysis: String(prev.analysis || s.analysis || '')
    })
  }

  const followCards: ActionCardItem[] = []
  const insightCards: ActionCardItem[] = []
  const followSessions = new Set<string>()

  for (const c of customers || []) {
    const sig = bySession.get(String(c.session_id || ''))
    if (!sig) continue
    const sources: any[] = sig.sources || []
    const taskSrc = sources.find((src) => src.type === 'task') || null
    if (taskSrc) {
      followSessions.add(String(c.session_id))
      followCards.push({
        key: `sig:${String(c.session_id)}`,
        kind: 'follow',
        pill: 'amber',
        pillText: '待跟进',
        customer: c,
        sessionId: String(c.session_id || ''),
        displayName: nameOf(c),
        reason: String(taskSrc.reason || sig.analysis || '有跟进信号'),
        suggest: String(sig.analysis || `建议：打开聊天跟进「${taskSrc.label || '待办'}」`),
        signal: sig
      })
    } else {
      const src = sources[0] || null
      const reason = String(src?.reason || src?.insightText || sig.analysis || '')
      if (!reason) continue // 无一句话理由的弱信号不进队列（页面只回答「为什么找 TA」）
      insightCards.push({
        key: `sig:${String(c.session_id)}`,
        kind: 'insight',
        pill: 'blue',
        pillText: 'AI 发现',
        customer: c,
        sessionId: String(c.session_id || ''),
        displayName: nameOf(c),
        reason,
        suggest: '建议：打开聊天看看原话，决定下一步动作',
        signal: sig
      })
    }
  }

  const infoCards: ActionCardItem[] = []
  for (const it of infoPending || []) {
    const field = String(it?.field || '')
    const label = String(fieldLabels[field] || field)
    const conf = Math.round((Number(it?.confidence) || 0) * 100)
    const account = (customers || []).find((c) => Number(c.id) === Number(it?.account_id)) || null
    infoCards.push({
      key: `info:${Number(it?.account_id)}:${field}`,
      kind: 'info',
      pill: 'blue',
      pillText: 'AI 发现',
      customer: account,
      sessionId: String(account?.session_id || ''),
      displayName: account ? nameOf(account) : String(it?.account_name || `客户 #${Number(it?.account_id)}`),
      accountId: Number(it?.account_id) || undefined,
      reason: `AI 从聊天里发现他的${label}：「${String(it?.value || '')}」（置信 ${conf}%）`,
      suggest: String(it?.evidence ? `证据：「${String(it.evidence).slice(0, 40)}」· 采纳就写进档案` : '采纳就写进档案（手改语义，AI 不再覆盖）'),
      infoItem: it,
      fieldLabel: label
    })
  }

  followCards.sort((a, b) => scoreOf(b.signal) - scoreOf(a.signal))
  insightCards.sort((a, b) => scoreOf(b.signal) - scoreOf(a.signal))
  return [...followCards, ...infoCards, ...insightCards]
}
