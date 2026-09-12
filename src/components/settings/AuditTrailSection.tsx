/**
 * AuditTrailSection.tsx —— 设置 · 审计流水（设计稿屏 7，宪法 §1.12 audit_event 只读）
 *
 * UI：顶部搜索框（操作人/对象一把搜，走 keyword 扩展参数）+ action 分段控件
 * （全部/分配/绑定/回收/权重调整）+ 表格（时间/操作人/动作/对象/细节）+ 分页。
 * 联系方式一律脱敏显示（152****5273 形态）——detail 里可能带手机号/微信号，展示层兜底打码。
 * 视觉红线：颜色只消费 --color-* 族（light/dark 自动适配）；pill 五语义。
 */
import { useCallback, useEffect, useState } from 'react'
import { Search } from 'lucide-react'
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

const PAGE_SIZE = 20

/** action 分段控件（设计稿屏 7）；后端按类别映射 lead_assign/identity_bind/lead_recycle 等 */
const ACTION_SEGS: Array<{ id: string; label: string }> = [
  { id: '', label: '全部' },
  { id: 'assign', label: '分配' },
  { id: 'bind', label: '绑定' },
  { id: 'recycle', label: '回收' },
  { id: 'weight', label: '权重调整' }
]

/** 动作展示名（设计稿文案口径） */
const ACTION_LABELS: Record<string, string> = {
  lead_assign: '执行分配',
  lead_claim: '认领',
  lead_transfer: '改派确认',
  lead_recycle: '回收',
  identity_bind: '绑定微信',
  departure_handoff: '离职移交',
  customer_type_set: '客户类型',
  import_batch: '资源录入',
  lead_sla_stock_reset: 'SLA 重置',
  lead_tag_owner_cleanup: '归属清理',
  migration_02_account_to_customer: '存量迁移②',
  migration_03_lead_to_identity: '存量迁移③'
}

/** 动作 pill 语义（五语义：蓝=信息/绿=正常/琥珀=待办/红=异常/灰=中性） */
const ACTION_SEMANTIC: Record<string, 'info' | 'success' | 'warning' | 'danger' | 'neutral'> = {
  lead_assign: 'success',
  lead_claim: 'info',
  lead_transfer: 'info',
  lead_recycle: 'danger',
  identity_bind: 'success',
  departure_handoff: 'warning',
  customer_type_set: 'neutral',
  import_batch: 'info',
  lead_sla_stock_reset: 'neutral',
  lead_tag_owner_cleanup: 'warning',
  migration_02_account_to_customer: 'info',
  migration_03_lead_to_identity: 'info'
}

/** 联系方式脱敏：手机号 152****5273；微信号保留前 3 后 2；其余原样 */
function maskContact(v: string): string {
  const phone = v.replace(/1[3-9]\d{9}/g, (m) => `${m.slice(0, 3)}****${m.slice(-4)}`)
  return phone.replace(/wxid_[A-Za-z0-9_-]{4,}/g, (m) => `${m.slice(0, 7)}****${m.slice(-2)}`)
}

function fmtTime(ms: number): string {
  if (!ms) return '-'
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** detail 是 JSON 时给一句人话摘要，非 JSON 原样（截断防表格撑爆） */
function detailSummary(detail: string): string {
  const raw = String(detail || '')
  try {
    const o = JSON.parse(raw)
    if (o && typeof o === 'object') {
      return Object.entries(o)
        .map(([k, v]) => `${k}:${String(v)}`)
        .join(' · ')
    }
  } catch { /* 非 JSON 原样 */ }
  return raw
}

export default function AuditTrailSection() {
  const [keyword, setKeyword] = useState('')
  const [actionCat, setActionCat] = useState('')
  const [page, setPage] = useState(1)
  const [rows, setRows] = useState<AuditRow[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [expanded, setExpanded] = useState(false)

  const fetchRows = useCallback(async (p: number) => {
    setLoading(true)
    try {
      const r = await (window as any).electronAPI.crm.auditQuery({
        keyword: keyword.trim() || undefined,
        action: actionCat || undefined,
        page: p,
        pageSize: PAGE_SIZE
      })
      if (r?.ok) {
        setRows((r.data?.rows || []) as AuditRow[])
        setTotal(Number(r.data?.total || 0))
        setPage(p)
      }
    } finally {
      setLoading(false)
    }
  }, [keyword, actionCat])

  useEffect(() => {
    if (expanded) void fetchRows(1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, actionCat])

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <div className="audit-trail">
      <div className="audit-trail__head" onClick={() => setExpanded((v) => !v)}>
        <h2>审计流水</h2>
        <span className="audit-trail__hint">audit_event 只增不删不改 · 全系统敏感操作统一留痕</span>
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
              {ACTION_SEGS.map((s) => (
                <button
                  key={s.id}
                  className={`audit-trail__seg ${actionCat === s.id ? 'on' : ''}`}
                  onClick={() => setActionCat(s.id)}
                >{s.label}</button>
              ))}
            </div>
          </div>
          <table className="audit-trail__table">
            <thead>
              <tr><th>时间</th><th>操作人</th><th>动作</th><th>对象</th><th>细节</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const semantic = ACTION_SEMANTIC[r.action] || 'neutral'
                return (
                  <tr key={r.id}>
                    <td className="num">{fmtTime(r.created_at)}</td>
                    <td>{maskContact(r.actor) || '系统'}</td>
                    <td><span className={`pill pill--${semantic}`}>{ACTION_LABELS[r.action] || r.action}</span></td>
                    <td className="num">{r.entity_type === 'lead' && r.entity_id ? `lead #${r.entity_id}` : `${r.entity_type}${r.entity_id ? ` #${r.entity_id}` : ''}`}</td>
                    <td className="audit-trail__detail">{maskContact(detailSummary(r.detail))}</td>
                  </tr>
                )
              })}
              {!loading && rows.length === 0 && (
                <tr><td colSpan={5} className="audit-trail__empty">暂无审计记录</td></tr>
              )}
              {loading && <tr><td colSpan={5} className="audit-trail__empty">加载中…</td></tr>}
            </tbody>
          </table>
          {total > PAGE_SIZE && (
            <div className="audit-trail__pager">
              <button className="audit-trail__btn" disabled={page <= 1 || loading} onClick={() => void fetchRows(page - 1)}>上一页</button>
              <span className="audit-trail__pageinfo">{page} / {totalPages} · 共 {total} 条</span>
              <button className="audit-trail__btn" disabled={page >= totalPages || loading} onClick={() => void fetchRows(page + 1)}>下一页</button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
