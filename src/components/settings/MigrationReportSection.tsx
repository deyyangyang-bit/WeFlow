/**
 * MigrationReportSection.tsx —— 设置 · 存量迁移报告（人话版，设计稿 §02/§04）
 *
 * 数据源：crm:migration:report:list → migration_report 表（每模块 latest-wins 幂等 upsert，
 * 应用启动链路每次扫描后刷新为最新一份；与 append-only audit_event 解耦）。
 * 三层展示改造：
 *   ① 副标题去行话（不再直出 scan_state / migration_report 表名）；
 *   ② 模块名与失败原因人话化（词典在 shared/auditDict.ts，与审计流水同一份事实源）；
 *   ③ 原始 module key / reason code / detail 收进「技术细节」折叠。
 * 2026-09-14 人工闭环：失败/冲突项支持「确认忽略」（SSOT = crmDb migration_dismissal 表）——
 *   界面即时隐藏 + 下次启动迁移扫描不再计入失败；「已确认忽略」分组可恢复；
 *   忽略与恢复都写 audit_event（migration_failure_dismiss / migration_failure_restore）。
 * 视觉红线：颜色只消费 --color-* 族（light/dark 自动适配）；.pill / .tech 样式与
 *   AuditTrailSection.scss 共用（两者同挂设置页安全 tab，见 SettingsPage.tsx）。
 */
import { useEffect, useState } from 'react'
import { Download, RefreshCw, Undo2 } from 'lucide-react'
import type { MigrationReportRow, MigrationReportIssue, MigrationDismissal } from '../../types/electron'
import { migrationIssueKeyLabel, migrationIssueReason, migrationModuleLabel } from '../../../shared/auditDict'
import { buildMigrationCsv } from './migrationReportCsv'
import './MigrationReportSection.scss'

function fmtTime(ms: number): string {
  if (!ms) return '-'
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 单条失败/冲突：人话对象名 + 人话原因 + 原始字段折叠 + 可选「确认忽略」 */
function IssueItem({ iss, onDismiss }: { iss: MigrationReportIssue; onDismiss?: () => void }) {
  const tech = [`${iss.key}`, `reason=${iss.reason}`, iss.detail || ''].filter(Boolean).join(' · ')
  return (
    <div className="migration-report__issue">
      <div className="migration-report__issue-key">{migrationIssueKeyLabel(iss.key)}</div>
      <div className="migration-report__issue-reason">{migrationIssueReason(iss.reason)}</div>
      {onDismiss && (
        <button className="audit-trail__btn migration-report__dismiss" onClick={onDismiss}>
          确认忽略
        </button>
      )}
      <details className="tech">
        <summary>技术细节</summary>
        <div className="tech__body">{tech}</div>
      </details>
    </div>
  )
}

function IssueList({ issues, kind, onDismiss }: {
  issues: MigrationReportIssue[]
  kind: 'failed' | 'conflict'
  onDismiss?: (iss: MigrationReportIssue) => void
}) {
  return (
    <div className="migration-report__issues">
      <div className="migration-report__issues-title">
        {kind === 'failed' ? '失败明细' : '冲突明细'}
        <span className={`pill pill--${kind === 'failed' ? 'danger' : 'warning'}`}>{issues.length}</span>
      </div>
      {issues.length === 0
        ? <div className="migration-report__none">无</div>
        : issues.map((iss, i) => (
          <IssueItem key={`${iss.key}-${i}`} iss={iss}
            onDismiss={onDismiss ? () => onDismiss(iss) : undefined} />))}
    </div>
  )
}

export default function MigrationReportSection() {
  const [expanded, setExpanded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [reports, setReports] = useState<MigrationReportRow[]>([])
  const [dismissals, setDismissals] = useState<MigrationDismissal[]>([])
  const [dismissedOpen, setDismissedOpen] = useState(false)

  const fetchAll = async () => {
    setLoading(true)
    try {
      const [r, d] = await Promise.all([
        window.electronAPI.crm.migrationReports(),
        window.electronAPI.crm.migrationDismissals()
      ])
      if (r?.ok && Array.isArray(r.data)) {
        // 按 module key 稳定排序（02→03→04→05）
        setReports([...r.data].sort((a, b) => a.module.localeCompare(b.module)))
      }
      if (d?.ok && Array.isArray(d.data)) setDismissals(d.data)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (expanded) void fetchAll()
  }, [expanded])

  const dismissedSet = new Set(dismissals.map((d) => `${d.module}::${d.entityKey}`))
  const isDismissed = (module: string, key: string) => dismissedSet.has(`${module}::${key}`)

  /** 确认忽略：写 migration_dismissal + 审计（主进程完成），本地即时隐藏 */
  const dismiss = async (module: string, iss: MigrationReportIssue) => {
    if (!window.confirm(`确认忽略「${migrationIssueKeyLabel(iss.key)}」？\n\n忽略后不再计入迁移失败；下次启动的迁移扫描同样跳过。可在下方「已确认忽略」中恢复。`)) return
    const r = await window.electronAPI.crm.migrationDismissFailure(module, iss.key, iss.reason)
    if (r?.ok) await fetchAll()
  }

  /** 恢复：从忽略清单移除，重新计入失败 */
  const restore = async (d: MigrationDismissal) => {
    const r = await window.electronAPI.crm.migrationRestoreFailure(d.module, d.entityKey)
    if (r?.ok) await fetchAll()
  }

  // CSV 导出：汇总行 + 失败/冲突明细行（组装逻辑在 migrationReportCsv.ts 纯函数，可测试）
  const exportCsv = () => {
    if (!reports.length) return
    const csv = buildMigrationCsv(
      reports.map((row) => ({
        moduleLabel: migrationModuleLabel(row.module),
        time: fmtTime(row.ranAt),
        report: row
      }))
    )
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `存量迁移报告-${fmtTime(Date.now()).replace(/[-: ]/g, '')}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  return (
    <div className="migration-report">
      <div className="migration-report__head" onClick={() => setExpanded((v) => !v)}>
        <h2>存量迁移报告</h2>
        <span className="migration-report__hint">启动时自动执行的存量数据整理结果 · 只读</span>
      </div>
      {expanded && (
        loading ? (
          <div className="migration-report__none">加载中…</div>
        ) : reports.length === 0 ? (
          <div className="migration-report__none">暂无迁移报告（应用启动执行存量迁移后在此留痕）</div>
        ) : (
          <>
            {reports.map((row) => {
              const s = row.summary
              // 已确认忽略的条目不展示在失败明细里；失败计数跟随展示口径（重启后服务端同口径）
              const visibleFailures = (row.failures || []).filter((f) => !isDismissed(row.module, f.key))
              const moduleDismissals = dismissals.filter((d) => d.module === row.module)
              return (
                <div key={row.module} className="migration-report__module">
                  <div className="migration-report__module-head">
                    <b>{migrationModuleLabel(row.module)}</b>
                    <span className="migration-report__time">执行于 {fmtTime(row.ranAt)}</span>
                  </div>
                  <details className="tech">
                    <summary>技术细节</summary>
                    <div className="tech__body">
                      module={row.module}{row.title ? ` · title=${row.title}` : ''} · ran_at={row.ranAt}
                    </div>
                  </details>
                  <div className="migration-report__counts">
                    <span className="pill pill--neutral">总数 <b>{s.total}</b></span>
                    <span className="pill pill--success">成功 <b>{s.applied}</b></span>
                    <span className="pill pill--neutral">跳过 <b>{s.alreadyDone}</b></span>
                    <span className="pill pill--neutral">无动作 <b>{s.skipped}</b></span>
                    <span className="pill pill--danger">失败 <b>{visibleFailures.length}</b></span>
                    <span className="pill pill--warning">冲突 <b>{s.conflicts}</b></span>
                    {Number(s.customersCreated) > 0 && <span className="pill pill--info">新建客户 <b>{s.customersCreated}</b></span>}
                    {Number(s.identitiesCreated) > 0 && <span className="pill pill--info">新建身份 <b>{s.identitiesCreated}</b></span>}
                    {Number(s.linkedToCustomer) > 0 && <span className="pill pill--info">挂接客户 <b>{s.linkedToCustomer}</b></span>}
                    {Number(s.pooled) > 0 && <span className="pill pill--info">进线索池 <b>{s.pooled}</b></span>}
                    {Number(s.wonOppCreated) > 0 && <span className="pill pill--info">新建 won 商机 <b>{s.wonOppCreated}</b></span>}
                    {Number(s.wonOppAlready) > 0 && <span className="pill pill--info">已有 won 商机 <b>{s.wonOppAlready}</b></span>}
                    {Number(s.amountBackfilled) > 0 && <span className="pill pill--info">金额回填 <b>{s.amountBackfilled}</b></span>}
                    {Number(s.chainsNormalized) > 0 && <span className="pill pill--info">版本链归一 <b>{s.chainsNormalized}</b></span>}
                    {Number(s.noQuoteContracts) > 0 && <span className="pill pill--info">成交无报价 <b>{s.noQuoteContracts}</b></span>}
                  </div>
                  <IssueList issues={visibleFailures} kind="failed"
                    onDismiss={(iss) => void dismiss(row.module, iss)} />
                  <IssueList issues={row.conflicts || []} kind="conflict" />
                  {moduleDismissals.length > 0 && (
                    <div className="migration-report__issues">
                      <div className="migration-report__issues-title migration-report__dismissed-head"
                        onClick={() => setDismissedOpen((v) => !v)} role="button" tabIndex={0}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setDismissedOpen((v) => !v) }}>
                        已确认忽略（不再计入失败）
                        <span className="pill pill--neutral">{moduleDismissals.length}</span>
                        <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--color-text-tertiary)' }}>{dismissedOpen ? '收起 ▾' : '展开 ▸'}</span>
                      </div>
                      {dismissedOpen && moduleDismissals.map((d) => (
                        <div key={`${d.module}::${d.entityKey}`} className="migration-report__issue">
                          <div className="migration-report__issue-key">{migrationIssueKeyLabel(d.entityKey)}</div>
                          <div className="migration-report__issue-reason">
                            由 {d.dismissedBy || '操作员'} 忽略于 {fmtTime(d.dismissedAt)}
                          </div>
                          <button className="audit-trail__btn migration-report__dismiss"
                            onClick={() => void restore(d)}>
                            <Undo2 size={12} /> 恢复
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
            <div className="migration-report__ops">
              <button className="audit-trail__btn" onClick={() => void fetchAll()} disabled={loading}>
                <RefreshCw size={13} /> 刷新
              </button>
              <button className="audit-trail__btn" onClick={exportCsv} disabled={!reports.length}>
                <Download size={13} /> 导出 CSV
              </button>
            </div>
          </>
        )
      )}
    </div>
  )
}
