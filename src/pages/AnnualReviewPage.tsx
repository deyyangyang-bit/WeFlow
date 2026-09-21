/**
 * AnnualReviewPage.tsx —— 年度经营复盘（S4；S7.2 增补 AI 分析区块）
 *
 * 规格 docs/设计-年度经营复盘-规格.md §6 / §8：
 *   - 页头：年份选择（来自 annualReview:getAvailableYears，UI 不推断）、scopeKind 区间、
 *     generatedAt、dataRange、overall 完整性徽标、生成/取消/重新生成。
 *   - 区块：年度经营摘要（A1–A9）→ 漏斗与阶段（B1/B2/B3/B6/B7）→ 客户经营（C1–C8）；
 *     月度趋势/沟通质量/销售与分配当前版本未实现 → 显式 unavailable 占位（不伪造 0）。
 *   - 每项依据 state/coverage.status 渲染四态；unavailable 禁止显示为 0；
 *     当前快照与历史年末重建使用明确不同文案。
 *   - 状态机/订阅/隔离逻辑全部在 src/utils/annualReviewView.ts（纯模块，可单测）；
 *     本组件只做状态 → 视图映射，不含第二套业务逻辑。
 *   - **AI 分析区块（S7.2）**：请求只带报告身份（taskId），报告与模型调用都在主进程；
 *     页面只渲染结构化结果——AI 文本一律作为纯文本渲染（React 转义，绝不注入 HTML），
 *     AI 引用的 metricKeys 只用来回查**原报告**的确定性数字，页面不从 AI 文本提取数字、
 *     不做二次计算。AI 失败只影响本区块，确定性报告的查看/导出/重新生成不受影响。
 *   - 不触碰旧年度报告页面。
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { AlertCircle, Ban, CalendarClock, Download, Loader2, RefreshCw, Settings, ShieldAlert, Sparkles, XCircle } from 'lucide-react'
import {
  createAnnualReviewController, createIpcAnnualReviewApi,
  aiConfidenceLabel, aiFailureView, aiHorizonLabel, aiPriorityLabel, buildAiMetricCells, buildSummaryCells,
  customerDetailHref, dataRangeLabel, funnelKindLabel, identityLabelSafe, scopeRangeLabel, yearLabel,
  METRIC_STATE_LABELS,
  type AnnualReviewAiAnalysis, type AnnualReviewAiMetricCell, type AnnualReviewAiState,
  type AnnualReviewReport
} from '../utils/annualReviewView'
import { salesStageColor } from '../../shared/funnelPalette'
import './AnnualReviewPage.scss'

/** distribution 六桶条 */
function DistributionBars({ rows, kind, coverageRatio }: {
  rows: Array<{ bucket: string; count: number }> | null
  kind?: string
  coverageRatio?: number | null
}) {
  if (!rows) {
    return <div className="ar-unavailable-mini">暂无可靠数据</div>
  }
  const max = Math.max(1, ...rows.map((r) => r.count))
  return (
    <div className="ar-dist">
      {rows.map((row) => (
        <div key={row.bucket} className="ar-dist__row">
          <span className="ar-dist__label">{row.bucket}</span>
          <div className="ar-dist__track">
            <div className="ar-dist__bar" style={{ width: `${(row.count / max) * 100}%`, background: salesStageColor(row.bucket) }} />
          </div>
          <span className="ar-dist__count num">{row.count}</span>
        </div>
      ))}
      {kind && <p className="ar-kind-note">{funnelKindLabel(kind, coverageRatio)}</p>}
    </div>
  )
}

/** 区块级 unavailable 卡（折叠语义：整卡「暂无可靠数据」，绝不显示 0） */
function UnavailableCard({ label, reasonCodes }: { label: string; reasonCodes?: string[] }) {
  return (
    <div className="ar-unavailable-card">
      <Ban size={14} />
      <div>
        <p className="ar-unavailable-card__t">{label}：暂无可靠数据</p>
        {reasonCodes && reasonCodes.length > 0 && (
          <p className="ar-unavailable-card__c">{reasonCodes.join(' · ')}</p>
        )}
      </div>
    </div>
  )
}

function fmtDate(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 数值指标单元（D/E 组共用；unavailable 显示「暂无可靠数据」，绝不显示 0） */
function MetricValueCell({ label, metric, format }: {
  label: string
  metric: { value: number | null; state: string; warnings: Array<{ code: string; message: string; count?: number }> }
  format: (v: number) => string
}) {
  const unavailable = metric.state === 'unavailable' || metric.value === null
  return (
    <div className={`ar-metric ar-metric--${metric.state}`} title={metric.warnings.map((w) => w.message).join('；') || undefined}>
      <div className="ar-metric__top">
        <span className="ar-metric__label">{label}</span>
        <span className={`ar-dot ar-dot--${metric.state}`} aria-hidden="true" />
      </div>
      <div className="ar-metric__value num">
        {unavailable ? <span className="ar-metric__na">暂无可靠数据</span> : format(metric.value as number)}
      </div>
      {(metric.state === 'partial' || metric.state === 'snapshot_only') && (
        <div className="ar-metric__note">{METRIC_STATE_LABELS[metric.state]}</div>
      )}
    </div>
  )
}

/** 月度序列面板：单序列单量纲（不同量纲绝不共用坐标轴）；unavailable 显示原因 */
function MonthlySeriesPanel({ title, series, format }: {
  title: string
  series: { months: Array<{ month: string; count?: number; amount?: number }> | null; state: string; warnings: Array<{ code: string; message: string; count?: number }> }
  format: (v: number) => string
}) {
  if (series.state === 'unavailable' || series.months === null) {
    return (
      <div className="ar-panel">
        <div className="ar-panel__h">
          <span>{title}</span>
          <span className="ar-chip ar-chip--unavailable">{METRIC_STATE_LABELS.unavailable}</span>
        </div>
        <UnavailableCard label={title} reasonCodes={series.warnings.map((w) => w.message)} />
      </div>
    )
  }
  const max = Math.max(1, ...series.months.map((m) => (m.amount ?? m.count ?? 0)))
  return (
    <div className={`ar-panel${series.months.length > 12 ? ' ar-panel--wide' : ''}`}>
      <div className="ar-panel__h">
        <span>{title}</span>
        <span className={`ar-chip ar-chip--${series.state}`}>{METRIC_STATE_LABELS[series.state]}</span>
      </div>
      <div className="ar-dist">
        {series.months.map((m) => {
          const value = m.amount ?? m.count ?? 0
          return (
            <div key={m.month} className="ar-dist__row">
              <span className="ar-dist__label ar-dist__label--month">{m.month}</span>
              <div className="ar-dist__track">
                <div className="ar-dist__bar" style={{ width: `${(value / max) * 100}%`, background: 'var(--color-accent)' }} />
              </div>
              <span className="ar-dist__count num">{format(value)}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default function AnnualReviewPage() {
  const apiRef = useRef<ReturnType<typeof createIpcAnnualReviewApi> | null>(null)
  if (apiRef.current === null) apiRef.current = createIpcAnnualReviewApi()
  const controllerRef = useRef<ReturnType<typeof createAnnualReviewController> | null>(null)
  if (controllerRef.current === null) controllerRef.current = createAnnualReviewController(apiRef.current)
  const controller = controllerRef.current

  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState)

  // 卸载：dispose（精确卸载进度订阅 + 清理仍在运行的生成任务）；加载年份列表
  useEffect(() => {
    void controller.loadYears()
    return () => controller.dispose()
  }, [controller])

  const { years, selectedYear, generation, phase } = state

  // 导出（S6）：经安全 IPC → 主进程弹出目录对话框授权 → 独占写（不覆盖已有文件）
  const [exportError, setExportError] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const onExport = useCallback(async (format: 'markdown' | 'csv') => {
    if (selectedYear === null) return
    setExporting(true)
    setExportError(null)
    try {
      const result = await window.electronAPI.annualReview.export(selectedYear, format)
      if (!result.success) setExportError(result.error?.message ?? '导出失败')
    } catch {
      setExportError('导出失败')
    } finally {
      setExporting(false)
    }
  }, [selectedYear])

  const onYearChange = (year: number): void => { controller.selectYear(year) }

  return (
    <div className="ar-page">
      {/* ── 页头：年份选择 + scopeKind 区间 + generatedAt + dataRange + overall 徽标 ── */}
      <div className="shead ar-shead">
        <div>
          <p className="eyebrow">报表 · 年度经营复盘</p>
          <h1 className="hero">
            {selectedYear === null ? '年度经营复盘' : yearLabel(selectedYear)}
            {phase === 'done' && state.report && (
              <span className={`ar-badge ar-badge--${state.overallBadge}`}>
                {state.overallBadge === 'complete' ? '数据完整' : state.overallBadge === 'partial' ? '数据部分完整' : '整体暂无可靠数据'}
              </span>
            )}
          </h1>
          <p className="sub">
            {phase === 'done' && state.report ? (
              <>
                {scopeRangeLabel(state.report)} · {dataRangeLabel(state.report)} · 生成于{' '}
                {new Date(state.report.generatedAt).toLocaleString('zh-CN')}
              </>
            ) : (
              '本机数据视角的年度经营结果：经营结果、漏斗与客户结构'
            )}
          </p>
        </div>
        <div className="shead__actions">
          <select
            className="ar-year-select"
            aria-label="选择年份"
            value={selectedYear ?? ''}
            onChange={(e) => onYearChange(Number(e.target.value))}
            disabled={years.loading || years.years.length === 0}
          >
            {years.years.length === 0 && <option value="">暂无数据</option>}
            {years.years.map((y) => (
              <option key={y.year} value={y.year}>{yearLabel(y.year)}</option>
            ))}
          </select>
          {phase === 'generating' ? (
            <button className="btn btn--secondary" onClick={() => controller.cancelGeneration()} disabled={generation.taskId === null}>
              <XCircle size={14} /> 取消生成
            </button>
          ) : (
            <button
              className="btn btn--primary"
              onClick={() => controller.startGenerate()}
              disabled={selectedYear === null || phase === 'loading'}
            >
              <RefreshCw size={14} /> {phase === 'failed' || phase === 'cancelled' ? '重新生成' : '生成报告'}
            </button>
          )}
          {phase === 'done' && state.report && (
            <>
              <button className="btn btn--secondary" onClick={() => void onExport('markdown')} disabled={exporting}>
                <Download size={14} /> 导出 Markdown
              </button>
              <button className="btn btn--secondary" onClick={() => void onExport('csv')} disabled={exporting}>
                <Download size={14} /> 导出 CSV
              </button>
            </>
          )}
        </div>
      </div>

      {exportError && (
        <div className="ar-sync-note" role="alert">{exportError}</div>
      )}

      {/* ── 阶段屏 ── */}
      {phase === 'loading' && (
        <div className="ar-skeleton" role="status" aria-label="加载中">
          <p className="ar-skeleton__hint">加载年度数据…</p>
          {years.loading && <p className="ar-skeleton__hint ar-skeleton__hint--sub">正在读取可用年份</p>}
        </div>
      )}

      {phase === 'generating' && (
        <div className="ar-generating" role="status">
          <p className="ar-generating__t">{generation.statusText ?? '生成中'}</p>
          <div className="ar-progress"><div className="ar-progress__bar" style={{ width: `${generation.progress}%` }} /></div>
          <p className="ar-generating__p num">{Math.round(generation.progress)}%</p>
          <p className="ar-generating__hint">统计全量本地事实，通常几秒内完成</p>
        </div>
      )}

      {phase === 'cancelled' && (
        <div className="ar-state-card">
          <CalendarClock size={18} />
          <div>
            <p className="ar-state-card__t">已取消生成</p>
            <p className="ar-state-card__d">本次生成已取消，未写入任何缓存；可随时重新生成。</p>
          </div>
          <button className="btn btn--secondary" onClick={() => controller.startGenerate()}>重新生成</button>
        </div>
      )}

      {phase === 'failed' && (
        <div className="ar-state-card ar-state-card--error">
          <AlertCircle size={18} />
          <div>
            <p className="ar-state-card__t">生成失败</p>
            <p className="ar-state-card__d">{state.error?.message ?? '年度复盘生成失败，请重试'}</p>
          </div>
          <button className="btn btn--secondary" onClick={() => controller.startGenerate()}>重试</button>
        </div>
      )}

      {phase === 'idle' && (
        <div className="ar-state-card">
          <CalendarClock size={18} />
          <div>
            <p className="ar-state-card__t">{selectedYear === null ? '暂无可用年份' : `${yearLabel(selectedYear)}尚未生成`}</p>
            <p className="ar-state-card__d">
              {years.error ?? (selectedYear === null
                ? '本机暂无符合条件的经营数据'
                : '点击「生成报告」统计该年度的经营结果、漏斗与客户结构')}
            </p>
          </div>
          {selectedYear !== null && (
            <button className="btn btn--primary" onClick={() => controller.startGenerate()}>生成报告</button>
          )}
        </div>
      )}

      {/* ── 报告（done；overall complete/partial/unavailable 均渲染，徽标区分档位） ── */}
      {phase === 'done' && state.report && (
        <ReportBody
          report={state.report}
          ai={state.ai}
          aiTaskId={state.reportTaskId}
          onRunAi={() => controller.runAiAnalysis()}
          onCancelAi={() => void controller.cancelAiAnalysis()}
          onRegenerate={() => controller.startGenerate()}
        />
      )}
    </div>
  )
}

// ─── AI 分析区块（S7.2） ─────────────────────────────────────────────────────

/** 确定性指标小卡组：只展示**原报告**里的值（AI 文本里的数字一律不采信、不解析） */
function AiMetricChips({ report, metricKeys }: { report: AnnualReviewReport; metricKeys: string[] }) {
  const cells: AnnualReviewAiMetricCell[] = buildAiMetricCells(report, metricKeys)
  if (cells.length === 0) return null
  return (
    <div className="ar-ai-metrics">
      {cells.map((cell) => (
        <span
          key={cell.key}
          className={`ar-ai-metric ar-ai-metric--${cell.state}`}
          title={cell.valueHint ?? undefined}
        >
          <span className="ar-ai-metric__l">{cell.label}</span>
          <span className="ar-ai-metric__v num">{cell.displayValue ?? cell.stateLabel}</span>
          {cell.displayValue !== null && (cell.state === 'partial' || cell.state === 'snapshot_only') && (
            <span className="ar-ai-metric__s">{cell.stateLabel}</span>
          )}
        </span>
      ))}
    </div>
  )
}

function AiListItem({ head, children, report, metricKeys }: {
  head: React.ReactNode
  children: React.ReactNode
  report: AnnualReviewReport
  metricKeys: string[]
}) {
  return (
    <div className="ar-ai-item">
      <div className="ar-ai-item__head">{head}</div>
      {children}
      <AiMetricChips report={report} metricKeys={metricKeys} />
    </div>
  )
}

function AiAnalysisSection({ report, ai, aiTaskId, onRun, onCancel, onRegenerate }: {
  report: AnnualReviewReport
  ai: AnnualReviewAiState
  aiTaskId: string | null
  onRun: () => void
  onCancel: () => void
  /** 报告定位类失败（过期/被取代/未完成）→ 重新生成报告，而不是对同一份报告反复重试 */
  onRegenerate: () => void
}) {
  const navigate = useNavigate()
  const location = useLocation()
  const [tick, setTick] = useState(0)

  // 运行中每秒刷新用时（仅展示用途；不参与任何业务判断）
  useEffect(() => {
    if (ai.phase !== 'running' || ai.startedAt === null) return
    const timer = setInterval(() => setTick(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [ai.phase, ai.startedAt])

  const goSettings = useCallback(() => {
    navigate('/settings', { state: { backgroundLocation: location } })
  }, [navigate, location])

  const elapsedSec = ai.phase === 'running' && ai.startedAt !== null
    ? Math.max(0, Math.round(((tick || Date.now()) - ai.startedAt) / 1000))
    : 0

  const analysis: AnnualReviewAiAnalysis | null = ai.phase === 'done' ? ai.analysis : null
  const failure = ai.phase === 'failed' ? aiFailureView(ai.error?.code ?? 'internal') : null

  return (
    <section className="ar-section ar-ai">
      <div className="seclabel">
        <span className="seclabel__t">AI 经营诊断</span>
        <span className="ar-ai-disclaimer">
          <ShieldAlert size={12} /> AI 内容为建议，确定性数字以本报告为准
        </span>
      </div>

      {aiTaskId === null ? (
        <div className="ar-state-card">
          <Sparkles size={18} />
          <div>
            <p className="ar-state-card__t">暂不能生成 AI 诊断</p>
            <p className="ar-state-card__d">当前报告缺少生成任务标识（可能由旧版本生成），请重新生成报告后再试。</p>
          </div>
          {/* 报告身份缺失（旧版本产出的缓存）时不给入口：请求必须带 taskId，绝不退化成上传报告 */}
          <button className="btn btn--secondary" disabled>生成 AI 诊断</button>
        </div>
      ) : (
        <>
          {ai.phase === 'idle' && (
            <div className="ar-ai-idle">
              <p className="ar-ai-idle__t">用 AI 解释这一年的经营结果，并给出下一年度行动计划。</p>
              <p className="ar-ai-idle__d">
                AI 只读取本报告的聚合指标（不含客户明细、聊天内容与联系方式），只做定性解释；
                金额、比例等确定性数字一律来自本报告，AI 不得给出具体数值。未配置 AI 或额度不足时，
                本报告仍可正常查看与导出。
              </p>
              <button className="btn btn--primary" onClick={onRun}>
                <Sparkles size={14} /> 生成 AI 诊断
              </button>
            </div>
          )}

          {ai.phase === 'running' && (
            <div className="ar-ai-running" role="status">
              <p className="ar-ai-running__t"><Loader2 size={14} className="ar-spin" /> 正在生成 AI 诊断…</p>
              <div className="ar-progress ar-progress--indeterminate"><div className="ar-progress__bar" /></div>
              <p className="ar-ai-running__p">已用时 {elapsedSec} 秒 · 通常需要十几秒（最长 60 秒）</p>
              <div className="ar-ai-running__actions">
                {/* 生成按钮在运行中保持可见但禁用（防止重复点击产生第二次调用） */}
                <button className="btn btn--primary" disabled>
                  <Sparkles size={14} /> 生成中…
                </button>
                <button className="btn btn--secondary" onClick={onCancel}>
                  <XCircle size={14} /> 取消
                </button>
              </div>
            </div>
          )}

          {ai.phase === 'cancelled' && (
            <div className="ar-state-card">
              <CalendarClock size={18} />
              <div>
                <p className="ar-state-card__t">已取消 AI 诊断</p>
                <p className="ar-state-card__d">本次分析已取消，未生成本次结果；报告本身不受影响，可随时重新生成。</p>
              </div>
              <button className="btn btn--secondary" onClick={onRun}>重新生成 AI 诊断</button>
            </div>
          )}

          {ai.phase === 'failed' && failure && (
            <div className="ar-state-card ar-state-card--error">
              <AlertCircle size={18} />
              <div>
                <p className="ar-state-card__t">{failure.title}</p>
                <p className="ar-state-card__d">{ai.error?.message ?? failure.fallbackDetail}</p>
                <p className="ar-state-card__d ar-state-card__d--sub">AI 分析失败不影响本报告的查看与导出。</p>
              </div>
              {failure.action === 'retry' && (
                <button className="btn btn--secondary" onClick={onRun}>{failure.actionLabel ?? '重试'}</button>
              )}
              {failure.action === 'settings' && (
                <button className="btn btn--secondary" onClick={goSettings}>
                  <Settings size={14} /> {failure.actionLabel ?? '前往设置'}
                </button>
              )}
              {failure.action === 'regenerate' && (
                <button className="btn btn--secondary" onClick={onRegenerate}>{failure.actionLabel ?? '重新生成报告'}</button>
              )}
            </div>
          )}

          {ai.phase === 'done' && analysis && (
            <div className="ar-ai-result">
              <p className="ar-ai-meta">
                模型 {ai.model ?? '未知'} · promptVersion {ai.promptVersion ?? '未知'}
                {ai.generatedAt !== null ? ` · 生成于 ${new Date(ai.generatedAt).toLocaleString('zh-CN')}` : ''}
                {ai.cached ? ' · 本次命中主进程缓存' : ''}
              </p>
              {/* 以下全部为纯文本渲染（React 默认转义）：不使用 dangerouslySetInnerHTML */}
              <p className="ar-ai-summary">{analysis.executiveSummary}</p>

              {analysis.diagnoses.length > 0 && (
                <div className="ar-ai-block">
                  <h4 className="ar-ai-block__t">诊断</h4>
                  {analysis.diagnoses.map((item, i) => (
                    <AiListItem
                      key={`d${i}`}
                      report={report}
                      metricKeys={item.metricKeys}
                      head={<>
                        <span className="ar-ai-item__title">{item.title}</span>
                        <span className="ar-ai-chip">{aiConfidenceLabel(item.confidence)}</span>
                      </>}
                    >
                      <p className="ar-ai-item__text">{item.observation}</p>
                      <p className="ar-ai-item__text ar-ai-item__text--hypo">原因假设：{item.hypothesis}</p>
                    </AiListItem>
                  ))}
                </div>
              )}

              {analysis.actions.length > 0 && (
                <div className="ar-ai-block">
                  <h4 className="ar-ai-block__t">下一年度行动计划</h4>
                  {analysis.actions.map((item, i) => (
                    <AiListItem
                      key={`a${i}`}
                      report={report}
                      metricKeys={item.metricKeys}
                      head={<>
                        <span className="ar-ai-chip ar-ai-chip--priority">{aiPriorityLabel(item.priority)}</span>
                        <span className="ar-ai-item__title">{item.action}</span>
                        <span className="ar-ai-chip">{aiHorizonLabel(item.horizon)}</span>
                      </>}
                    >
                      <p className="ar-ai-item__text">{item.rationale}</p>
                    </AiListItem>
                  ))}
                </div>
              )}

              {analysis.risks.length > 0 && (
                <div className="ar-ai-block">
                  <h4 className="ar-ai-block__t">风险与数据缺口</h4>
                  {analysis.risks.map((item, i) => (
                    <AiListItem key={`r${i}`} report={report} metricKeys={item.metricKeys} head={null}>
                      <p className="ar-ai-item__text">{item.risk}</p>
                    </AiListItem>
                  ))}
                </div>
              )}

              <button className="btn btn--secondary ar-ai-rerun" onClick={onRun}>
                <RefreshCw size={14} /> 重新生成 AI 诊断
              </button>
            </div>
          )}
        </>
      )}
    </section>
  )
}

function ReportBody({ report, ai, aiTaskId, onRunAi, onCancelAi, onRegenerate }: {
  report: AnnualReviewReport
  ai: AnnualReviewAiState
  aiTaskId: string | null
  onRunAi: () => void
  onCancelAi: () => void
  onRegenerate: () => void
}) {
  const navigate = useNavigate()
  const summaryCells = buildSummaryCells(report)
  const f = report.funnel
  const c = report.customers

  return (
    <div className="ar-body">
      {/* ── 年度经营摘要（A1–A9）── */}
      <section className="ar-section">
        <div className="seclabel"><span className="seclabel__t">年度经营摘要</span></div>
        <div className="ar-metric-grid">
          {summaryCells.map((cell) => (
            <div key={cell.key} className={`ar-metric ar-metric--${cell.state}`} title={cell.warnings.map((w) => w.message).join('；') || undefined}>
              <div className="ar-metric__top">
                <span className="ar-metric__label">{cell.label}</span>
                <span className={`ar-dot ar-dot--${cell.state}`} aria-hidden="true" />
              </div>
              <div className="ar-metric__value num">
                {cell.displayValue ?? <span className="ar-metric__na">{cell.stateLabel}</span>}
              </div>
              {(cell.state === 'partial' || cell.state === 'snapshot_only') && (
                <div className="ar-metric__note">{cell.stateLabel}</div>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* ── 漏斗与阶段（B1/B2/B3/B6/B7）── */}
      <section className="ar-section">
        <div className="seclabel"><span className="seclabel__t">漏斗与阶段</span></div>
        <div className="ar-two-col">
          <div className="ar-panel">
            <div className="ar-panel__h">
              <span>客户阶段分布</span>
              <span className={`ar-chip ar-chip--${f.customerStage.coverage.status}`}>{METRIC_STATE_LABELS[f.customerStage.coverage.status]}</span>
            </div>
            {f.customerStage.coverage.status === 'unavailable' ? (
              <UnavailableCard label="客户阶段分布" reasonCodes={f.customerStage.coverage.reasonCodes} />
            ) : (
              <DistributionBars rows={f.customerStage.distribution} kind={f.customerStage.kind} coverageRatio={f.customerStage.coverage.coverageRatio} />
            )}
          </div>
          <div className="ar-panel">
            <div className="ar-panel__h">
              <span>商机阶段分布</span>
              <span className={`ar-chip ar-chip--${f.opportunityStage.coverage.status}`}>{METRIC_STATE_LABELS[f.opportunityStage.coverage.status]}</span>
            </div>
            {f.opportunityStage.coverage.status === 'unavailable' ? (
              <UnavailableCard label="商机阶段分布" reasonCodes={f.opportunityStage.coverage.reasonCodes} />
            ) : (
              <DistributionBars rows={f.opportunityStage.distribution} kind={f.opportunityStage.kind} coverageRatio={f.opportunityStage.coverage.coverageRatio} />
            )}
          </div>
          <div className="ar-panel">
            <div className="ar-panel__h">
              <span>年内阶段流转</span>
              <span className={`ar-chip ar-chip--${f.stageFlow.coverage.status}`}>{METRIC_STATE_LABELS[f.stageFlow.coverage.status]}</span>
            </div>
            {typeof f.stageFlow.coverage.coverageRatio === 'number' && (
              <p className="ar-kind-note">覆盖率 {Math.round(f.stageFlow.coverage.coverageRatio * 100)}% · 覆盖受限的流量参考，不是转化率</p>
            )}
            <DistributionBars rows={f.stageFlow.distribution} />
          </div>
          <div className="ar-panel">
            <div className="ar-panel__h">
              <span>停滞客户</span>
              <span className={`ar-chip ar-chip--${f.stuck.coverage.status}`}>{METRIC_STATE_LABELS[f.stuck.coverage.status]}</span>
            </div>
            {f.stuck.coverage.status === 'unavailable' || f.stuck.value === null ? (
              <UnavailableCard label="停滞客户" reasonCodes={f.stuck.coverage.reasonCodes} />
            ) : (
              <p className="ar-big-num num">{f.stuck.value}</p>
            )}
          </div>
          <div className="ar-panel">
            <div className="ar-panel__h">
              <span>流失归因</span>
              <span className={`ar-chip ar-chip--${f.lostBreakdown.coverage.status}`}>{METRIC_STATE_LABELS[f.lostBreakdown.coverage.status]}</span>
            </div>
            {f.lostBreakdown.coverage.status === 'unavailable' ? (
              <UnavailableCard label="流失归因" reasonCodes={f.lostBreakdown.coverage.reasonCodes} />
            ) : (
              <>
                <DistributionBars rows={f.lostBreakdown.customerPreviousStage} kind={f.lostBreakdown.kind} />
                <div className="ar-reasons">
                  {(f.lostBreakdown.opportunityReasons ?? []).map((r) => (
                    <div key={r.reason} className="ar-reasons__row">
                      <span>{r.reason}</span><span className="num">{r.count}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      </section>

      {/* ── 客户经营（C1–C8）── */}
      <section className="ar-section">
        <div className="seclabel"><span className="seclabel__t">客户经营</span></div>
        <div className="ar-lists">
          {c.highValue.coverage.status === 'unavailable' || c.highValue.value === null ? (
            <UnavailableCard label="高价值客户" reasonCodes={c.highValue.coverage.reasonCodes} />
          ) : (
            <CustomerList title="高价值客户" chip={c.highValue.coverage.status}
              rows={c.highValue.value.map((r) => ({ id: `hv${r.accountId}`, href: customerDetailHref(r), main: identityLabelSafe(r), sub: `核销 ${r.creditedAmount.toLocaleString('zh-CN')} 元 · 签约 ${r.contractAmount.toLocaleString('zh-CN')} 元` }))} />
          )}
          {c.newCustomers.coverage.status === 'unavailable' || c.newCustomers.value === null ? (
            <UnavailableCard label="新增客户" reasonCodes={c.newCustomers.coverage.reasonCodes} />
          ) : (
            <CustomerList title="新增客户" chip={c.newCustomers.coverage.status}
              rows={c.newCustomers.value.map((r) => ({ id: `nw${r.accountId}`, href: customerDetailHref(r), main: identityLabelSafe(r), sub: `${fmtDate(r.createdAt)}${r.imported ? ' · 导入建档' : ''}` }))} />
          )}
          {c.dealing.coverage.status === 'unavailable' || c.dealing.value === null ? (
            <UnavailableCard label="成交客户" reasonCodes={c.dealing.coverage.reasonCodes} />
          ) : (
            <CustomerList title="成交客户" chip={c.dealing.coverage.status}
              rows={c.dealing.value.map((r) => ({ id: `dl${r.accountId}`, href: customerDetailHref(r), main: identityLabelSafe(r), sub: `${r.contractCount} 份合同 · ${r.contractAmount.toLocaleString('zh-CN')} 元 · 首签 ${fmtDate(r.firstSignDate)}` }))} />
          )}
          {c.repeat.coverage.status === 'unavailable' || c.repeat.value === null ? (
            <UnavailableCard label="复购客户" reasonCodes={c.repeat.coverage.reasonCodes} />
          ) : (
            <CustomerList title="复购客户" chip={c.repeat.coverage.status}
              rows={c.repeat.value.map((r) => ({ id: `rp${r.accountId}`, href: customerDetailHref(r), main: identityLabelSafe(r), sub: `${r.contractCount} 份合同 · ${r.contractAmount.toLocaleString('zh-CN')} 元` }))} />
          )}
          {c.active.coverage.status === 'unavailable' || c.active.value === null ? (
            <UnavailableCard label="活跃客户" reasonCodes={c.active.coverage.reasonCodes} />
          ) : (
            <CustomerList title="活跃客户" chip={c.active.coverage.status}
              rows={c.active.value.map((r, i) => ({ id: `ac${r.accountId ?? i}`, href: customerDetailHref(r), main: identityLabelSafe(r) }))} />
          )}
          {c.silent.coverage.status === 'unavailable' || c.silent.value === null ? (
            <UnavailableCard label="沉默客户" reasonCodes={c.silent.coverage.reasonCodes} />
          ) : (
            <CustomerList title="沉默客户" chip={c.silent.coverage.status}
              rows={c.silent.value.map((r, i) => ({ id: `si${r.accountId ?? r.customerId ?? i}`, href: customerDetailHref(r), main: identityLabelSafe(r), sub: `最近联系 ${fmtDate(r.lastContactAtMs)}` }))} />
          )}
          {c.risk.coverage.status === 'unavailable' || c.risk.value === null ? (
            <UnavailableCard label="流失风险客户" reasonCodes={c.risk.coverage.reasonCodes} />
          ) : (
            <CustomerList title="流失风险客户" chip={c.risk.coverage.status}
              rows={c.risk.value.map((r, i) => ({ id: `rk${r.accountId ?? r.customerId ?? i}`, href: customerDetailHref(r), main: identityLabelSafe(r), sub: `${r.stage} · 最近联系 ${fmtDate(r.lastContactAtMs)}` }))} />
          )}
          {c.priority.coverage.status === 'unavailable' || c.priority.value === null ? (
            <UnavailableCard label="当前重点推进客户" reasonCodes={c.priority.coverage.reasonCodes} />
          ) : (
            <CustomerList title="当前重点推进客户" chip={c.priority.coverage.status}
              rows={c.priority.value.map((r, i) => ({ id: `pr${r.accountId ?? r.customerId ?? i}`, href: customerDetailHref(r), main: identityLabelSafe(r), sub: `最近联系 ${fmtDate(r.lastContactAtMs)}` }))} />
          )}
        </div>
      </section>

      {/* ── 沟通质量（D1/D2/D3/D5/D7）── */}
      <section className="ar-section">
        <div className="seclabel"><span className="seclabel__t">沟通质量</span></div>
        <div className="ar-metric-grid ar-metric-grid--3">
          <MetricValueCell label="年度客户消息量" metric={report.communication.volume} format={(v) => String(v)} />
          <MetricValueCell label="有沟通客户数" metric={report.communication.contacted} format={(v) => String(v)} />
          <MetricValueCell label="主动联系率" metric={report.communication.outboundRate} format={(v) => `${Math.round(v * 100)}%`} />
        </div>
        <div className="ar-two-col">
          <div className="ar-panel">
            <div className="ar-panel__h">
              <span>月度沟通趋势</span>
              <span className={`ar-chip ar-chip--${report.communication.monthlyTrend.state}`}>{METRIC_STATE_LABELS[report.communication.monthlyTrend.state]}</span>
            </div>
            {report.communication.monthlyTrend.months === null ? (
              <UnavailableCard label="月度沟通趋势" reasonCodes={['日消息统计缺失']} />
            ) : (
              <DistributionBars rows={report.communication.monthlyTrend.months.map((m) => ({ bucket: m.month, count: m.count }))} />
            )}
          </div>
          <div className="ar-panel">
            <div className="ar-panel__h">
              <span>长期未联系客户</span>
              <span className={`ar-chip ar-chip--${report.communication.longSilent.state}`}>{METRIC_STATE_LABELS[report.communication.longSilent.state]}</span>
            </div>
            {report.communication.longSilent.value === null ? (
              <UnavailableCard label="长期未联系客户" reasonCodes={[]} />
            ) : report.communication.longSilent.value.length === 0 ? (
              <p className="ar-empty-list">该年度没有符合条件的事实（真实零）</p>
            ) : (
              <ul className="ar-customer-list">
                {report.communication.longSilent.value.map((r, i) => (
                  <li key={`ls${r.accountId ?? r.customerId ?? i}`}>
                    {customerDetailHref(r) ? (
                      <button type="button" className="ar-customer-link" onClick={() => navigate(customerDetailHref(r) as string)} title="打开客户详情">{identityLabelSafe(r)}</button>
                    ) : (
                      <span className="ar-customer-list__main">{identityLabelSafe(r)}</span>
                    )}
                    <span className="ar-customer-list__sub">最近联系 {fmtDate(r.lastContactAtMs)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </section>

      {/* ── 销售与分配（E1/E3/E4/E5；本机记录视角，无 E2/E6/E7）── */}
      <section className="ar-section">
        <div className="seclabel"><span className="seclabel__t">销售与分配</span></div>
        <div className="ar-facts">
          <div className="ar-facts__item">
            <div className="ar-facts__n num">{report.salesAssignment.assignedFacts.initialAssignments.total}</div>
            <div className="ar-facts__l">初始分配</div>
          </div>
          <div className="ar-facts__item">
            <div className="ar-facts__n num">{report.salesAssignment.assignedFacts.transfersIn.total}</div>
            <div className="ar-facts__l">移交转入</div>
          </div>
          <div className="ar-facts__item">
            <div className="ar-facts__n num">{report.salesAssignment.assignedFacts.transfersOut.total}</div>
            <div className="ar-facts__l">移交转出</div>
          </div>
        </div>
        <p className="ar-kind-note">分配事实来自本机操作审计（append-only），初始分配与移交分项展示、不相加；转移经手人明细见下。</p>
        {report.salesAssignment.coverage.status === 'partial' && (
          <div className="ar-sync-note">
            检测到中枢下发的分配/移交记录；当前统计只覆盖本机审计事件，实际总量可能更高（不显示覆盖率）
          </div>
        )}
        <div className="ar-two-col">
          <div className="ar-panel">
            <div className="ar-panel__h">
              <span>初始分配明细（按销售）</span>
              <span className={`ar-chip ar-chip--${report.salesAssignment.coverage.status}`}>{METRIC_STATE_LABELS[report.salesAssignment.coverage.status]}</span>
            </div>
            {report.salesAssignment.assignedFacts.initialAssignments.groups.length === 0 ? (
              <p className="ar-empty-list">本机审计中无分配事实（真实零）</p>
            ) : (
              <div className="ar-reasons">
                {report.salesAssignment.assignedFacts.initialAssignments.groups.map((g) => (
                  <div key={`${g.salesName ?? ''}-${g.mode ?? ''}`} className="ar-reasons__row">
                    <span>{g.salesName ?? '未署名'}{g.mode ? ` · ${g.mode}` : ''}</span><span className="num">{g.count}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="ar-panel">
            <div className="ar-panel__h">
              <span>有效跟进客户（认领且已首触）</span>
              <span className={`ar-chip ar-chip--${report.salesAssignment.effectiveFollowup.state}`}>{METRIC_STATE_LABELS[report.salesAssignment.effectiveFollowup.state]}</span>
            </div>
            {report.salesAssignment.effectiveFollowup.value === null ? (
              <UnavailableCard label="有效跟进客户" reasonCodes={[]} />
            ) : (
              <p className="ar-big-num num">{report.salesAssignment.effectiveFollowup.value}</p>
            )}
          </div>
          <div className="ar-panel">
            <div className="ar-panel__h">
              <span>合同贡献（按当前归属销售）</span>
              <span className={`ar-chip ar-chip--${report.salesAssignment.contractContribution.state}`}>{METRIC_STATE_LABELS[report.salesAssignment.contractContribution.state]}</span>
            </div>
            {report.salesAssignment.contractContribution.value === null || report.salesAssignment.contractContribution.value.length === 0 ? (
              <p className="ar-empty-list">该年度没有符合条件的事实（真实零）</p>
            ) : (
              <div className="ar-reasons">
                {report.salesAssignment.contractContribution.value.map((row) => (
                  <div key={`cc${row.ownerSales ?? ''}`} className="ar-reasons__row">
                    <span>{row.ownerSales ?? '未归属'} · {row.contractCount} 份</span>
                    <span className="num">{row.totalAmount.toLocaleString('zh-CN')} 元</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="ar-panel">
            <div className="ar-panel__h">
              <span>核销回款贡献（按认领销售）</span>
              <span className={`ar-chip ar-chip--${report.salesAssignment.creditedContribution.state}`}>{METRIC_STATE_LABELS[report.salesAssignment.creditedContribution.state]}</span>
            </div>
            {report.salesAssignment.creditedContribution.value === null || report.salesAssignment.creditedContribution.value.length === 0 ? (
              <p className="ar-empty-list">该年度没有符合条件的事实（真实零）</p>
            ) : (
              <div className="ar-reasons">
                {report.salesAssignment.creditedContribution.value.map((row) => (
                  <div key={`kc${row.salesName ?? ''}`} className="ar-reasons__row">
                    <span>{row.salesName ?? '未认领'}</span>
                    <span className="num">{row.totalAmount.toLocaleString('zh-CN')} 元</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </section>

      {/* ── 月度趋势（三序列独立量纲） ── */}
      <section className="ar-section">
        <div className="seclabel"><span className="seclabel__t">月度趋势</span></div>
        <div className="ar-two-col">
          <MonthlySeriesPanel title="签约金额（元/月）" series={report.monthly.contractSign} format={(v) => v.toLocaleString('zh-CN')} />
          <MonthlySeriesPanel title="已核销回款（元/月）" series={report.monthly.credited} format={(v) => v.toLocaleString('zh-CN')} />
        </div>
        <MonthlySeriesPanel title="客户消息量（条/月）" series={report.monthly.messageVolume} format={(v) => String(v)} />
      </section>

      {/* ── AI 经营诊断（S7.2；失败/未配置/额度不足均不影响上方确定性报告） ── */}
      <AiAnalysisSection
        report={report}
        ai={ai}
        aiTaskId={aiTaskId}
        onRun={onRunAi}
        onCancel={onCancelAi}
        onRegenerate={onRegenerate}
      />

      {/* ── 数据说明：warnings 全文 + 口径声明 + sourceSummary ── */}
      <section className="ar-section">
        <div className="seclabel"><span className="seclabel__t">数据说明</span></div>
        <div className="ar-notes">
          {report.warnings.length === 0 ? (
            <p className="ar-notes__item">本报告无降级告警。</p>
          ) : (
            report.warnings.map((w) => (
              <p key={w.code} className="ar-notes__item">
                {w.message}
                {w.counts && Object.values(w.counts).some((n) => n > 0) ? `（涉及 ${Object.values(w.counts).reduce((a, b) => Math.max(a, b), 0)} 条）` : ''}
              </p>
            ))
          )}
          <p className="ar-notes__item">本报告为本机数据视角；「当前快照」为截至生成时间的投影，「历史年末重建」为事件流重放结果。</p>
          <p className="ar-notes__item">「暂无可靠数据」表示当前数据无法可靠统计（不显示为 0）；「部分完整」附有降级原因。</p>
          <p className="ar-notes__item">统计口径：本地时区；金额单位为元；历史年度联系时间类指标不可重建。</p>
          <p className="ar-notes__item">分配统计说明（固定口径，非公平性结论）：</p>
          <p className="ar-notes__item">① 全部失败批次不留批次审计（assigned=0 不落行）。</p>
          <p className="ar-notes__item">② 部分失败批次的 skipped 只存在于幸存批次的 audit detail 中。</p>
          <p className="ar-notes__item">③ round_robin 游标写盘失败属于辅助降级，可能造成不超过一批的份额漂移并长期自愈；weight/load 不读写游标。</p>
          <div className="ar-sources">
            {report.sourceSummary.map((s) => (
              <div key={`${s.source}-${s.tables.join(',')}`} className="ar-sources__row">
                <span className="ar-sources__src">{s.source}</span>
                <span className="ar-sources__tables">{s.tables.join(' / ')}</span>
                <span className="num">{s.rows} 行</span>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  )
}

function CustomerList({ title, rows, chip }: {
  title: string
  chip: string
  rows: Array<{ id: string; main: string; sub?: string; href?: string | null }>
}) {
  const navigate = useNavigate()
  return (
    <div className="ar-panel">
      <div className="ar-panel__h">
        <span>{title}</span>
        <span className={`ar-chip ar-chip--${chip}`}>{METRIC_STATE_LABELS[chip]}{rows.length > 0 ? ` · ${rows.length}` : ''}</span>
      </div>
      {rows.length === 0 ? (
        <p className="ar-empty-list">该年度没有符合条件的事实（真实零）</p>
      ) : (
        <ul className="ar-customer-list">
          {rows.map((r) => (
            <li key={r.id}>
              {r.href ? (
                <button
                  type="button"
                  className="ar-customer-link"
                  onClick={() => navigate(r.href as string)}
                  title="打开客户详情"
                >{r.main}</button>
              ) : (
                <span className="ar-customer-list__main">{r.main}</span>
              )}
              {r.sub && <span className="ar-customer-list__sub">{r.sub}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
