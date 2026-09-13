/**
 * AuditTrailSection.tsx —— 设置 · 审计流水（人话版，设计稿 §01/§04）
 *
 * **纯展示层**：audit_event 的写入与表结构不动（宪法 §1.12 append-only）。三层改造：
 *   ① 动作词典（shared/auditDict.ts 为唯一事实源）→ 每行渲染人话整句，未收录动作降级原文 + 「未翻译」灰标；
 *   ② 批量合并 —— 同 action + 同 actor + 同一分钟的**连续**行合并为一行，明细可展开，不丢任何行；
 *   ③ 双层视图 —— 默认人话，原文 action/entity/JSON 收进「技术细节」折叠（开发者排查用）。
 *
 * 脱敏口径（本文件是唯一出口）：**人话视图**过 redactPii —— 只打码字符串叶子，
 *   deadline 等数值时间戳原样渲染（旧版先拍平成字符串再跑正则，把 1789954204656 打成了
 *   178****899431，既不可读也无保护意义）；「技术细节」保留原文，供对本机数据排查。
 * 视觉红线：颜色只消费 --color-* 族（light/dark 自动适配）；lucide 图标，不用 emoji。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronRight, Search } from 'lucide-react'
import {
  AUDIT_FILTER_CHIPS, actorDisplay, batchHeadline, batchKeyOf, entryTone, fmtClock, fmtVal,
  maskContact, parseDetail, redactPii, resolveAuditAction,
  type AuditTone, type DetailPart
} from '../../../shared/auditDict'
import './AuditTrailSection.scss'

interface AuditRow {
  id: number
  actor: string
  action: string
  entity_type: string
  entity_id: number | null
  detail: string
  created_at: number
}

interface AuditGroup {
  /** action|actor|分钟 —— 同键且连续的行走一行 */
  key: string
  head: AuditRow
  rows: AuditRow[]
}

const PAGE_SIZE = 20
/** 合并行折叠时预览的条数（与设计稿 §01 一致：预览 2 条 + 「其余 N 条…」） */
const PREVIEW_N = 2

/** pill 色调 → 设置页五语义 class（蓝=信息/绿=正常/琥珀=待办/红=异常/灰=中性） */
const TONE_CLASS: Record<AuditTone, string> = {
  remind: 'warning', assign: 'success', recycle: 'danger',
  config: 'info', bind: 'success', neutral: 'neutral'
}

/**
 * 实体深链：lead → 线索页（?leadId= 深链）、account → 客户工作台（既有 ?id=）。
 * customer 无稳定详情路由，返回 null（只展示名字，不做假跳转）。
 */
function entityHref(entityType: string, id: number): string | null {
  if (entityType === 'lead') return `/leads?leadId=${id}`
  if (entityType === 'account') return `/customers?id=${id}`
  return null
}

/** 按「同 action + 同 actor + 同一分钟」合并**连续**行（列表按时间倒序，非连续不合并） */
function groupRows(rows: AuditRow[]): AuditGroup[] {
  const out: AuditGroup[] = []
  for (const r of rows) {
    const key = batchKeyOf(r)
    const last = out[out.length - 1]
    if (last && last.key === key) last.rows.push(r)
    else out.push({ key, head: r, rows: [r] })
  }
  return out
}

/** 技术细节一行：原文 action / entity / detail 全字段（对象走 fmtVal，不出现 [object Object]） */
function techLine(row: AuditRow): string {
  const bits = [`action=${row.action}`]
  if (row.entity_type) {
    bits.push(`entity=${row.entity_type}${row.entity_id ? ` #${row.entity_id}` : ''}`)
  }
  const d = parseDetail(row.detail)
  const keys = Object.keys(d)
  if (keys.length) for (const k of keys) bits.push(`${k}=${fmtVal(d[k])}`)
  else if (String(row.detail || '').trim()) bits.push(`detail=${String(row.detail)}`)
  return bits.join(' · ')
}

/** 人话整句：text/strong 直出，muted 灰字，entity 解析为「名字」并可点击（解析不到回落原名） */
function Sentence({ parts, labels }: { parts: DetailPart[]; labels: Record<string, string> }) {
  const navigate = useNavigate()
  return (
    <>
      {parts.map((p, i) => {
        if (p.kind === 'text') return <span key={i}>{p.text}</span>
        if (p.kind === 'strong') return <b key={i}>{p.text}</b>
        if (p.kind === 'muted') return <span key={i} className="arow__muted">{p.text}</span>
        const raw = `${p.entityType} #${p.id}`
        const name = labels[`${p.entityType}:${p.id}`]
        const href = entityHref(p.entityType, p.id)
        // 解析不到就显示原名（契约：不留空白）；解析到才包「」
        if (!href) {
          return (
            <span key={i} className="arow__ent arow__ent--plain" title={raw}>
              {name ? `「${maskContact(name)}」` : raw}
            </span>
          )
        }
        return (
          <a
            key={i}
            className="arow__ent"
            href={href}
            title={`${raw} · 点击查看`}
            onClick={(e) => { e.preventDefault(); navigate(href) }}
          >{name ? `「${maskContact(name)}」` : raw}</a>
        )
      })}
    </>
  )
}

/** 单条审计行的人话视图（时间 / 操作人 / 动作 pill / 整句 + 技术细节折叠） */
function RowLine({ row, labels, time }: { row: AuditRow; labels: Record<string, string>; time: string }) {
  const entry = useMemo(() => resolveAuditAction(row.action), [row.action])
  const actor = actorDisplay(row.actor)
  // 人话视图过一遍脱敏（只打码字符串叶子；数值时间戳不受影响）
  const parts = useMemo(
    () => entry.describe(redactPii(parseDetail(row.detail)) as Record<string, unknown>,
      { entityType: row.entity_type, entityId: row.entity_id }),
    [entry, row.detail, row.entity_type, row.entity_id]
  )
  return (
    <div className="arow">
      <span className="arow__time">{time}</span>
      <span className={`arow__actor${actor.system ? ' arow__actor--sys' : ''}`}>{maskContact(actor.text)}</span>
      <span className={`pill pill--${TONE_CLASS[entryTone(entry, row.detail)]}`}>{entry.label}</span>
      {entry.untranslated && <span className="arow__raw">未翻译</span>}
      <span className="arow__text"><Sentence parts={parts} labels={labels} /></span>
      <details className="tech">
        <summary>技术细节</summary>
        <div className="tech__body">{techLine(row)}</div>
      </details>
    </div>
  )
}

export default function AuditTrailSection() {
  const [keyword, setKeyword] = useState('')
  const [actionCat, setActionCat] = useState('')
  const [page, setPage] = useState(1)
  const [rows, setRows] = useState<AuditRow[]>([])
  const [labels, setLabels] = useState<Record<string, string>>({})
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [expanded, setExpanded] = useState(false)
  /** 已展开明细的合并行 key（只影响渲染，不丢行） */
  const [openKeys, setOpenKeys] = useState<string[]>([])

  const fetchRows = useCallback(async (p: number) => {
    setLoading(true)
    try {
      const r = await window.electronAPI.crm.auditQuery({
        keyword: keyword.trim() || undefined,
        action: actionCat || undefined,
        page: p,
        pageSize: PAGE_SIZE
      })
      if (r?.ok) {
        setRows((r.data?.rows || []) as AuditRow[])
        setLabels(r.data?.labels || {})
        setTotal(Number(r.data?.total || 0))
        setPage(p)
        setOpenKeys([])
      }
    } finally {
      setLoading(false)
    }
  }, [keyword, actionCat])

  useEffect(() => {
    if (expanded) void fetchRows(1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, actionCat])

  const groups = useMemo(() => groupRows(rows), [rows])
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const toggle = (k: string) => setOpenKeys((v) => (v.includes(k) ? v.filter((x) => x !== k) : [...v, k]))

  return (
    <div className="audit-trail">
      <div className="audit-trail__head" onClick={() => setExpanded((v) => !v)}>
        <ChevronRight size={14} className={`audit-trail__caret${expanded ? ' on' : ''}`} />
        <h2>审计流水</h2>
        <span className="audit-trail__hint">敏感操作留痕 · 只增不删不改</span>
      </div>
      {expanded && (
        <>
          <div className="audit-trail__toolbar">
            <div className="audit-trail__search">
              <Search size={14} />
              <input
                value={keyword}
                placeholder="搜索 操作人 / 对象…"
                onChange={(e) => setKeyword(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void fetchRows(1) }}
              />
              <button className="audit-trail__btn" onClick={() => void fetchRows(1)} disabled={loading}>搜索</button>
            </div>
            <div className="audit-trail__segs" role="tablist">
              {AUDIT_FILTER_CHIPS.map((s) => (
                <button
                  key={s.id}
                  className={`audit-trail__seg ${actionCat === s.id ? 'on' : ''}`}
                  onClick={() => setActionCat(s.id)}
                >{s.label}</button>
              ))}
            </div>
          </div>
          <div className="audit-trail__list">
            {groups.map((g) => {
              const merged = g.rows.length > 1
              const open = openKeys.includes(g.key)
              const preview = merged && !open ? g.rows.slice(0, PREVIEW_N) : g.rows
              const rest = g.rows.length - preview.length
              return (
                <div key={g.key} className={`agroup${merged ? ' agroup--merged' : ''}`}>
                  {merged && (
                    <div className="arow arow--head">
                      <span className="arow__time">{fmtClock(g.head.created_at)}</span>
                      <span className={`arow__actor${actorDisplay(g.head.actor).system ? ' arow__actor--sys' : ''}`}>
                        {maskContact(actorDisplay(g.head.actor).text)}
                      </span>
                      <span className={`pill pill--${TONE_CLASS[entryTone(resolveAuditAction(g.head.action), g.head.detail)]}`}>
                        {resolveAuditAction(g.head.action).label}
                      </span>
                      <span className="arow__text">
                        <b>{batchHeadline(g.head.action, g.head.detail, g.rows.length)}</b>
                      </span>
                      <button className="arow__expand" onClick={() => toggle(g.key)} aria-expanded={open}>
                        {open ? '收起明细' : '展开明细'}
                        <ChevronRight size={12} className={`arow__caret${open ? ' on' : ''}`} />
                      </button>
                    </div>
                  )}
                  <div className="agroup__items">
                    {preview.map((r) => (
                      <RowLine key={r.id} row={r} labels={labels} time={fmtClock(r.created_at)} />
                    ))}
                    {rest > 0 && (
                      <div className="agroup__rest">· 其余 {rest} 条…（展开明细可逐条查看）</div>
                    )}
                  </div>
                </div>
              )
            })}
            {!loading && rows.length === 0 && <div className="audit-trail__empty">暂无审计记录</div>}
            {loading && <div className="audit-trail__empty">加载中…</div>}
          </div>
          {total > PAGE_SIZE && (
            <div className="audit-trail__pager">
              <button
                className="audit-trail__btn"
                disabled={page <= 1 || loading}
                onClick={() => void fetchRows(page - 1)}
              >上一页</button>
              <span className="audit-trail__pageinfo">{page} / {totalPages} · 共 {total} 条</span>
              <button
                className="audit-trail__btn"
                disabled={page >= totalPages || loading}
                onClick={() => void fetchRows(page + 1)}
              >下一页</button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
