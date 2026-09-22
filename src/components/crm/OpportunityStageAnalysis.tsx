/**
 * OpportunityStageAnalysis.tsx —— 商机「阶段分析」视图（设计稿状态 2 / 状态 3）
 *
 * 数据全部来自 `crm.opportunityAnalysis()`（主进程只读组装 → shared/opportunitySignals 纯投影），
 * **渲染零 AI 调用**：理由分类、排序层、候选资格都是已落库字段的投影。
 * 唯一的模型调用是「生成跟进建议」按钮点下去的那一刻（按需，purpose='action'，
 * 复用既有 `sales.actionSuggest` 受控链路，不新增 purpose）。
 *
 * 口径纪律：本视图只展示 active 商机；成交（won）只出现在「近 30 天成交」独立指标里。
 *
 * 2026-09-18 P2.1b：纯视觉——动作行接共享按钮档位（去跟进 = 轻 primary，其余 quiet），
 * 管道总览三卡改共享 .stats 三列；数据与资格判定不动。
 */
import { useState } from 'react'
import { AlertTriangle, ClipboardList, Loader2, Sparkles, Target } from 'lucide-react'
import type {
  OpportunityAnalysisResult, OpportunityStageSegment, OppAssessment, OppReason
} from '../../../shared/opportunitySignals'

/** 金额：0 = 金额未定（与商机列表同口径，不显示 ¥0 冒充已知金额） */
function fmtAmount(n: number): string {
  return Number(n) > 0 ? `¥${Number(n).toLocaleString()}` : '金额未定'
}

/** 建议生成结果（按需 AI 的返回值投影；失败也如实展示，不静默） */
interface SuggestState {
  loading: boolean
  script: string
  nextMove: string
  error: string
}

const EMPTY_SUGGEST: SuggestState = { loading: false, script: '', nextMove: '', error: '' }

/** 单条理由：确定性紧迫信号用红字强调；来源标注始终可见且可追溯 */
function ReasonLine({ reason }: { reason: OppReason }) {
  return (
    <span className={reason.hot ? 'opp-reason opp-reason--hot' : 'opp-reason'}>
      {reason.text}
      <span className="opp-reason__src">来源：{reason.source}</span>
    </span>
  )
}

/** 优先处理名单里的一行：排名徽标 + 理由 + 三个动作 */
function CandidateRow({ assessment, rank, suggest, onGoFollow, onTodo, onSuggest }: {
  assessment: OppAssessment
  rank: number
  suggest: SuggestState
  onGoFollow: (a: OppAssessment) => void
  onTodo: (a: OppAssessment) => void
  onSuggest: (a: OppAssessment) => void
}) {
  const a = assessment
  // 有 pending 待办 → 「查看待办」；没有 → 「建待办」（设计稿状态 3 的两个分支）
  const hasTodo = a.pendingTaskCount > 0
  // 无关联会话时该建议只能基于商机字段空谈（链路会读到空聊天记录），既失真又白花一次模型调用 → 禁用并说明原因
  const canSuggest = !!a.sessionId
  return (
    <div className="opp-prow">
      <div className={`opp-prow__rank${rank === 1 ? ' is-first' : ''}`}>{rank}</div>
      <div className="opp-prow__ava" aria-hidden>{(String(a.displayName || '').trim()[0]) || '客'}</div>
      <div className="opp-prow__info">
        <div className="opp-prow__name">
          {a.displayName}
          <span className="opp-prow__amt">{fmtAmount(a.amount)}</span>
          {a.intentScore > 0 && <span className="opp-prow__intent">意向 {a.intentScore}</span>}
        </div>
        <div className="opp-prow__reasons">
          {a.reasons.map((r, i) => <ReasonLine key={`${r.kind}-${i}`} reason={r} />)}
        </div>
        {suggest.loading && <div className="opp-prow__ai"><Loader2 size={12} className="spinning" /> 正在生成跟进建议…</div>}
        {!suggest.loading && suggest.error && (
          <div className="opp-prow__ai opp-prow__ai--error">生成失败：{suggest.error}</div>
        )}
        {!suggest.loading && !suggest.error && suggest.script && (
          <div className="opp-prow__ai">
            <span className="opp-prow__ai-tag"><Sparkles size={11} /> 跟进建议</span>
            <p className="opp-prow__ai-script">{suggest.script}</p>
            {suggest.nextMove && <p className="opp-prow__ai-next">下一步：{suggest.nextMove}</p>}
          </div>
        )}
      </div>
      <div className="opp-prow__act">
        <button className="btn btn--sm btn--primary-soft" onClick={() => onGoFollow(a)}>
          <Target size={13} /> 去跟进
        </button>
        <button className="btn btn--sm btn--quiet" onClick={() => onTodo(a)}>
          <ClipboardList size={13} /> {hasTodo ? '查看待办' : '建待办'}
        </button>
        <button
          className="btn btn--sm btn--quiet"
          onClick={() => onSuggest(a)}
          disabled={suggest.loading || !canSuggest}
          title={canSuggest ? undefined : '该商机未关联聊天会话，无法生成基于对话的跟进建议'}
        >
          {suggest.loading ? <Loader2 size={13} className="spinning" /> : <Sparkles size={13} />} 生成跟进建议
        </button>
      </div>
    </div>
  )
}

/** 漏斗分段：条宽按商机数比例；「最大卡点」由主进程按滞留数+滞留金额双指标标注 */
function StageBar({ seg, maxCount, selected, onSelect }: {
  seg: OpportunityStageSegment
  maxCount: number
  selected: boolean
  onSelect: () => void
}) {
  const width = `${Math.max(20, Math.round((seg.count / maxCount) * 100))}%`
  return (
    <div className="opp-fstage">
      <span className="opp-fstage__name">{seg.stage}</span>
      <button
        type="button"
        className={`opp-fstage__bar${selected ? ' is-selected' : ''}`}
        style={{ width }}
        aria-pressed={selected}
        onClick={onSelect}
        title={`${seg.stage}：${seg.count} 个商机 · ${fmtAmount(seg.amount)} · 点击展开优先处理名单`}
      >
        {seg.count} <small>{fmtAmount(seg.amount)}</small>
      </button>
      {seg.isMaxStuck && <span className="opp-fstage__stuck-tag"><AlertTriangle size={11} /> 最大卡点</span>}
      <span className="opp-fstage__meta">
        {seg.thresholdDays === null ? '阈值不适用' : `阈值 ${seg.thresholdDays} 天`}
        {' · '}
        滞留 {seg.stuckCount}
        {seg.stuckCount > 0 && ` / ${fmtAmount(seg.stuckAmount)}`}
      </span>
    </div>
  )
}

export default function OpportunityStageAnalysis({ data, loading, onGoFollow, onTodo, onSuggest }: {
  data: OpportunityAnalysisResult | null
  loading: boolean
  /** 「去跟进」：有会话 → 应用内会话上下文；无会话 → 商机详情 + 降级 toast（由页面判定） */
  onGoFollow: (a: OppAssessment) => void
  /** 「建待办」（无待办时）/「查看待办」（有待办时） */
  onTodo: (a: OppAssessment, action: 'create' | 'view') => void
  /** 「生成跟进建议」：按需 AI，返回纯文本话术与下一步；失败时抛错由本组件如实展示 */
  onSuggest: (a: OppAssessment) => Promise<{ script: string; nextMove: string }>
}) {
  const [selectedStage, setSelectedStage] = useState<string | null>(null)
  const [suggests, setSuggests] = useState<Record<number, SuggestState>>({})

  const runSuggest = async (a: OppAssessment) => {
    setSuggests((s) => ({ ...s, [a.opportunityId]: { ...EMPTY_SUGGEST, loading: true } }))
    try {
      const r = await onSuggest(a)
      setSuggests((s) => ({
        ...s,
        [a.opportunityId]: { loading: false, script: r.script, nextMove: r.nextMove, error: '' }
      }))
    } catch (e: unknown) {
      setSuggests((s) => ({
        ...s,
        [a.opportunityId]: { loading: false, script: '', nextMove: '', error: e instanceof Error ? e.message : String(e) }
      }))
    }
  }

  if (!data) {
    return <div className="opp-empty">{loading ? '正在统计阶段数据…' : '暂无阶段分析数据'}</div>
  }

  const { overview, stages } = data
  const maxCount = Math.max(1, ...stages.map((s) => s.count))
  const selected = stages.find((s) => s.stage === selectedStage) || null
  // 最大卡点段落文案：用该段自身的滞留数与金额，不合成综合分
  const maxStuckSeg = stages.find((s) => s.isMaxStuck) || null

  return (
    <div className="opp-analysis">
      {/* 管道总览：进行中 / 滞留 / 近 30 天成交（成交独立计数，不进管道）。P2.1b 接共享 .stats 三列 */}
      <div className="stats stats--3">
        <div className="stat">
          <div className="stat__n">{overview.activeCount} <small>{fmtAmount(overview.activeAmount)}</small></div>
          <div className="stat__l">进行中商机</div>
          <div className="stat__d">active · 金额合计</div>
        </div>
        <div className="stat">
          <div className="stat__n stat__n--warn">{overview.stuckCount} <small>{fmtAmount(overview.stuckAmount)}</small></div>
          <div className="stat__l">滞留商机</div>
          <div className="stat__d">超阶段阈值</div>
        </div>
        <div className="stat">
          <div className="stat__n stat__n--ok">{overview.wonCount30d} <small>{fmtAmount(overview.wonAmount30d)}</small></div>
          <div className="stat__l">近 30 天成交</div>
          <div className="stat__d">won · 不计入管道</div>
        </div>
      </div>

      <div className="card opp-analysis__card">
        <h4>阶段分布 <span className="opp-list-count">仅统计进行中商机</span></h4>
        {stages.map((seg) => (
          <StageBar
            key={seg.stage}
            seg={seg}
            maxCount={maxCount}
            selected={selectedStage === seg.stage}
            onSelect={() => setSelectedStage(selectedStage === seg.stage ? null : seg.stage)}
          />
        ))}
      </div>

      {maxStuckSeg && (
        <div className="opp-callout">
          <AlertTriangle size={14} />
          <span>
            <b>{maxStuckSeg.stage}段是当前最大卡点</b>
            ：{maxStuckSeg.stuckCount} 条商机滞留、涉及 {fmtAmount(maxStuckSeg.stuckAmount)}。
            点选该段查看优先处理名单。
          </span>
        </div>
      )}

      {selected && (
        <div className="card opp-analysis__card">
          <div className="opp-stuck-head">
            <span className="opp-stuck-head__t">{selected.stage}段 · 优先处理</span>
            <span className="opp-stuck-head__s">
              {selected.candidates.length} 条候选，按行动紧迫度排序
            </span>
          </div>
          {selected.candidates.map((a, i) => (
            <CandidateRow
              key={a.opportunityId}
              assessment={a}
              rank={i + 1}
              suggest={suggests[a.opportunityId] || EMPTY_SUGGEST}
              onGoFollow={onGoFollow}
              onTodo={(x) => onTodo(x, x.pendingTaskCount > 0 ? 'view' : 'create')}
              onSuggest={(x) => void runSuggest(x)}
            />
          ))}
          {!selected.candidates.length && (
            <div className="opp-empty">
              该段 {selected.count} 条商机均未触发候选条件（候选资格 = 待办到期/逾期 或 超阶段滞留阈值）
            </div>
          )}
        </div>
      )}

      {!selected && stages.length > 0 && (
        <div className="opp-analysis__hint">点选上方任一段，展开该段的优先处理名单。</div>
      )}
    </div>
  )
}
