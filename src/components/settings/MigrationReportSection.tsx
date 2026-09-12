/**
 * MigrationReportSection.tsx —— 设置 · 存量迁移报告（migration_report SSOT 只读投影）
 *
 * 数据源：crm:migration:report:list → migration_report 表（每模块 latest-wins 幂等 upsert，
 * 应用启动链路每次扫描后刷新为最新一份；与 append-only audit_event 解耦，
 * audit_event 只留「实际写入>0」的业务留痕，不再是唯一查看方式）。
 * 展示：总数/成功(applied)/跳过(alreadyDone)/无动作(skipped)/失败/冲突 计数 + 逐条失败/冲突原因 + CSV 导出。
 * 无手动重跑通道（重跑在下次启动时按 scan_state 幂等执行），本区只读。
 * 视觉红线：颜色只消费 --color-* 族（light/dark 自动适配）；pill 语义。
 */
import { useEffect, useState } from 'react'
import { Download, RefreshCw } from 'lucide-react'
import type { MigrationReportRow, MigrationReportIssue } from '../../types/electron'
import { buildMigrationCsv } from './migrationReportCsv'
import './MigrationReportSection.scss'

const MODULE_LABELS: Record<string, string> = {
  '02-account-to-customer': '模块② account → customer 归并',
  '03-lead-to-identity': '模块③ lead → identity 建档',
  '04-history-deal-opportunity': '模块④ 历史成交 → won 商机 + 报价首版本',
  '05-customer-profile-align': '模块⑤ salesDb 客户档案对齐'
}

function fmtTime(ms: number): string {
  if (!ms) return '-'
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function IssueTable({ issues, kind }: { issues: MigrationReportIssue[]; kind: 'failed' | 'conflict' }) {
  return (
    <div className="migration-report__issues">
      <div className="migration-report__issues-title">
        {kind === 'failed' ? '失败明细' : '冲突明细'}
        <span className={`pill pill--${kind === 'failed' ? 'danger' : 'warning'}`}>{issues.length}</span>
      </div>
      {issues.length === 0 ? (
        <div className="migration-report__none">无</div>
      ) : (
        <table className="migration-report__table">
          <thead>
            <tr><th>对象</th><th>原因</th><th>明细</th></tr>
          </thead>
          <tbody>
            {issues.map((iss, i) => (
              <tr key={`${iss.key}-${i}`}>
                <td className="num">{iss.key}</td>
                <td>{iss.reason}</td>
                <td className="migration-report__detail">{iss.detail || '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

export default function MigrationReportSection() {
  const [expanded, setExpanded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [reports, setReports] = useState<MigrationReportRow[]>([])

  const fetchReports = async () => {
    setLoading(true)
    try {
      const r = await window.electronAPI.crm.migrationReports()
      if (r?.ok && Array.isArray(r.data)) {
        // 按 module key 稳定排序（02→03→04→05）
        setReports(
          [...r.data].sort((a, b) => a.module.localeCompare(b.module))
        )
      }
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (expanded) void fetchReports()
  }, [expanded])

  // CSV 导出：汇总行 + 失败/冲突明细行（组装逻辑在 migrationReportCsv.ts 纯函数，可测试）
  const exportCsv = () => {
    if (!reports.length) return
    const csv = buildMigrationCsv(
      reports.map((row) => ({
        moduleLabel: MODULE_LABELS[row.module] || row.module,
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
        <span className="migration-report__hint">应用启动时幂等执行（scan_state 仅记游标）· 结果落 migration_report · 只读</span>
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
              return (
                <div key={row.module} className="migration-report__module">
                  <div className="migration-report__module-head">
                    <b>{MODULE_LABELS[row.module] || row.module}</b>
                    <span className="migration-report__time">执行于 {fmtTime(row.ranAt)}</span>
                  </div>
                  <div className="migration-report__counts">
                    <span className="pill pill--neutral">总数 <b>{s.total}</b></span>
                    <span className="pill pill--success">成功 <b>{s.applied}</b></span>
                    <span className="pill pill--neutral">跳过 <b>{s.alreadyDone}</b></span>
                    <span className="pill pill--neutral">无动作 <b>{s.skipped}</b></span>
                    <span className="pill pill--danger">失败 <b>{s.failed}</b></span>
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
                  <IssueTable issues={row.failures || []} kind="failed" />
                  <IssueTable issues={row.conflicts || []} kind="conflict" />
                </div>
              )
            })}
            <div className="migration-report__ops">
              <button className="audit-trail__btn" onClick={() => void fetchReports()} disabled={loading}>
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
