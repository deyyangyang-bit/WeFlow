/**
 * HermesPanel.tsx —— Hermes 只读智能体全屏三栏页（概念稿屏 8 形态；/hermes 路由）
 *
 * 三入口（Sidebar / ChatPage / CustomerWorkspacePage / 命令面板）经 hermesStore.openHermes(context)
 * 注入上下文后 navigate('/hermes')；本组件作为路由页消费 store 上下文。App.tsx 恰挂载一份
 * <HermesPanel />（hermes-agent-test d7 护栏）。任务真源在主进程内存：离开路由不删任务，
 * 回到 /hermes 按该上下文锚点（lastTaskByContext）恢复视图并重订阅进度。
 *
 * 三栏（概念稿 .chat--ai 语法，数据零造假收编）：
 *   左栏 216px —— 概念稿是会话列表，真实 Hermes 无会话史，按真实口径画「上下文 + 任务锚点」：
 *   当前上下文卡（global/chat/customer 三态）+ 该上下文最近任务状态 + 记忆规则说明。
 *   中栏 —— 问答流：提问右侧 accent 弱底气泡（msg--out），回答左侧 inset 气泡（msg--in），
 *   完成态挂依据条（cite）与结论/发现/建议；运行中只出 slim 占位（绝不伪造步骤）。
 *   右栏 304px —— 「本次调用的工具」真实步骤轨迹（主进程推送，label 零内部工具 ID）+「边界」只读声明。
 *
 * 铁律（hermes-agent-test 静态断言锚点，改本文件先跑 scripts/hermes-agent-test.ts）：
 *  - 五态：空闲（推荐目标）/ 运行（只渲染主进程推送的真实步骤，绝不伪造）/ 完成（结论 +
 *    发现 + 建议 + 证据）/ 失败（人话文案，绝不出现 SQL/IPC/堆栈/路径）/ 多轮追问
 *  - 本组件零发送类 IPC 调用（AI 碰不到发送键，结论永不自动发给客户）
 *  - AI 结论仅展示（不写 stage / judgment / 待办——写路在本组件不存在）
 *  - 证据列表只展示主进程核验过的 evidence（ref 编号），不展示模型原始输出
 *  - 依据条跳转只走只读导航（/chat?sessionId=…）；sessionId 取自当前上下文，
 *    全局上下文的任务定位不到会话，依据条降级为不可点展示，绝不臆造锚点
 *  - 步骤轨迹不透出内部工具 ID（与 hermesAgentCore「用户可见标签零内部工具 ID」同口径）
 *  - 样式零硬编码 hex（--color-* 族 token，light/dark 两套自适应）
 */
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Bot, Sparkles, CheckCircle2, CircleDot, AlertCircle, Loader2, Wrench } from 'lucide-react'
import { useHermesStore, canSettleTaskView, contextKeyOf, type HermesContext } from '../../stores/hermesStore'
import type { HermesTaskSnapshot, HermesEvidenceItem } from '../../types/electron'
import { getHermesErrorMessage } from '../../../shared/hermesErrorMessages'
import './HermesPanel.scss'

/** 任务收尾状态（completed/failed/cancelled） */
const isSettled = (t: HermesTaskSnapshot | null): boolean =>
  !!t && (t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled')

/** 问答流的一轮：question = 用户原话；task = 该轮的最新任务快照（主进程不存轮次史，仅本组件内存） */
interface HermesTurn {
  question: string
  task: HermesTaskSnapshot
}

/** 任务状态 → 左栏锚点行的人话（快照无时间戳，不画时间） */
const TASK_STATUS_TEXT: Record<string, string> = {
  planning: '运行中',
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消'
}

/** 各入口上下文的推荐目标（空闲态 chips；只是起点，用户可自由输入） */
function suggestGoalsFor(ctx: HermesContext): string[] {
  if (ctx.kind === 'customer') {
    return [
      '这个客户现在处于什么阶段，下一步该怎么跟进？',
      '这个客户名下有哪些商机和合同？',
      '这个客户最近的聊天里提到了什么需求？'
    ]
  }
  if (ctx.kind === 'chat') {
    return [
      '这个会话的客户聊到哪一步了？',
      '这个客户最近在关心什么？',
      '接下来应该重点跟进什么？'
    ]
  }
  return [
    '今天有哪些待办行动卡，先办哪件？',
    '我名下有哪些快凉的商机需要干预？',
    '本月到款情况怎么样？'
  ]
}

/** 上下文人话标签（左栏上下文卡 / 中栏题头） */
function contextTitle(ctx: HermesContext): string {
  if (ctx.kind === 'customer') return `客户：${ctx.customerName}`
  if (ctx.kind === 'chat') return `会话：${ctx.sessionName}`
  return '全局'
}

/** 上下文类型副标（等宽小字） */
function contextKindLabel(ctx: HermesContext): string {
  if (ctx.kind === 'customer') return '客户档案'
  if (ctx.kind === 'chat') return '聊天会话'
  return '全局入口'
}

export default function HermesPanel() {
  const context = useHermesStore((s) => s.context)
  // 按当前上下文取任务锚点（各客户/会话/全局独立记忆，切换入口不串显别的上下文的任务）
  const lastTaskId = useHermesStore((s) => s.lastTaskByContext[contextKeyOf(s.context)] ?? null)
  const setLastTaskId = useHermesStore((s) => s.setLastTaskId)
  const navigate = useNavigate()

  const [task, setTask] = useState<HermesTaskSnapshot | null>(null)
  // 问答流轮次（纯视图态）：提问气泡 + 该轮快照；上下文切换/新任务即清空重记
  const [turns, setTurns] = useState<HermesTurn[]>([])
  const [goal, setGoal] = useState('')
  const [starting, setStarting] = useState(false)
  const [followUp, setFollowUp] = useState('')
  const [continuing, setContinuing] = useState(false)
  const [startError, setStartError] = useState('')
  const [continueError, setContinueError] = useState('')
  const taskRef = useRef<HermesTaskSnapshot | null>(null)
  taskRef.current = task

  // 只补最新一轮的快照（进度推送 / 取消落库共用；轮次史本身不回改）
  const patchLastTurn = (t: HermesTaskSnapshot) => {
    setTurns((prev) => (prev.length === 0 ? prev : [...prev.slice(0, -1), { ...prev[prev.length - 1], task: t }]))
  }

  // 挂载/切换上下文：先清空本地视图（新上下文无任务时绝不残留上一上下文的正文），
  // 再按当前上下文锚点恢复；恢复返回时上下文又已切换则放弃（锚点仍在，切回可恢复）。
  // 离开 /hermes 组件卸载即停止订阅——任务在主进程继续跑，回来时按锚点恢复最新快照。
  useEffect(() => {
    setTask(null)
    setTurns([])
    if (!lastTaskId) return
    let disposed = false
    void window.electronAPI.hermes.getTask(lastTaskId).then((r) => {
      const cur = useHermesStore.getState()
      if (disposed || !r.ok || !r.task) return
      if (contextKeyOf(cur.context) !== contextKeyOf(context)) return
      setTask(r.task)
      // 快照只有原始 goal + 最新结果：恢复视图如实呈现「一条提问 + 最新回答」，
      // 追问轮次的问答历史主进程不保留，这里绝不补造
      setTurns([{ question: r.task!.goal, task: r.task! }])
    })
    return () => { disposed = true }
  }, [lastTaskId, context])

  // 进度订阅：挂载期订阅，卸载退订。只接受「当前上下文锚点任务」的推送——
  // 本上下文没有锚点时一律丢弃，其他上下文的后台任务进度绝不会灌进当前视图
  useEffect(() => {
    return window.electronAPI.hermes.onTaskProgress((t) => {
      const cur = useHermesStore.getState()
      const expected = cur.lastTaskByContext[contextKeyOf(cur.context)] ?? null
      if (!expected || t.taskId !== expected) return
      setTask(t)
      patchLastTurn(t)
    })
  }, [])

  const handleStart = async (text?: string) => {
    const g = String(text ?? goal).trim()
    if (!g || starting) return
    const startedKey = contextKeyOf(context) // 发起时上下文（await 期间用户可能切走）
    setStarting(true)
    setStartError('')
    setContinueError('')
    setTask(null)
    setTurns([])
    try {
      const payload = {
        goal: g,
        context: context.kind === 'customer'
          ? { kind: 'customer' as const, accountId: context.accountId, sessionId: context.sessionId }
          : context.kind === 'chat'
            ? { kind: 'chat' as const, sessionId: context.sessionId }
            : { kind: 'global' as const },
        contextLabel: contextTitle(context) === '全局' ? undefined : contextTitle(context)
      }
      const r = await window.electronAPI.hermes.startTask(payload)
      if (r.ok && r.task) {
        // 锚点永远写回发起时的上下文（切走也能切回恢复）；
        // 但正文只显示在发起时的上下文还成立时——绝不把任务挂到新切换的标题下
        setLastTaskId(r.task.taskId, startedKey)
        if (contextKeyOf(useHermesStore.getState().context) !== startedKey) return
        setTask(r.task)
        setTurns([{ question: g, task: r.task }])
        setGoal('')
      } else if (contextKeyOf(useHermesStore.getState().context) === startedKey) {
        setStartError(getHermesErrorMessage(r.errorCode))
      }
    } catch {
      if (contextKeyOf(useHermesStore.getState().context) === startedKey) {
        setStartError(getHermesErrorMessage('internal'))
      }
    } finally {
      setStarting(false)
    }
  }

  const handleContinue = async (text?: string) => {
    const q = String(text ?? followUp).trim()
    const tid = taskRef.current?.taskId
    if (!q || !tid || continuing) return
    const startedKey = contextKeyOf(context)
    setContinuing(true)
    setContinueError('')
    try {
      const r = await window.electronAPI.hermes.continueTask({ taskId: tid, question: q })
      if (r.ok && r.task) {
        setLastTaskId(r.task.taskId, startedKey)
        if (contextKeyOf(useHermesStore.getState().context) !== startedKey) return
        setTask(r.task)
        // 新一轮问答入流（上一轮的回答已留在前一个气泡里，纯本组件视图态）
        setTurns((prev) => [...prev, { question: q, task: r.task! }])
        setFollowUp('')
      } else if (contextKeyOf(useHermesStore.getState().context) === startedKey) {
        // 追问失败保留上一轮结论，但必须显示同一套人话错误文案。
        setContinueError(getHermesErrorMessage(r.errorCode))
      }
    } catch {
      if (contextKeyOf(useHermesStore.getState().context) === startedKey) {
        setContinueError(getHermesErrorMessage('internal'))
      }
    } finally {
      setContinuing(false)
    }
  }

  const handleCancel = async () => {
    const tid = taskRef.current?.taskId
    if (!tid) return
    const cancelKey = contextKeyOf(context) // 取消发起时的上下文（await 期间用户可能切走）
    try {
      const r = await window.electronAPI.hermes.cancelTask(tid)
      // await 返回后当前上下文/锚点仍匹配发起时才写视图：
      // 取消期间切换到另一客户/聊天或另起新任务，绝不把旧任务响应串显到新标题下
      const cur = useHermesStore.getState()
      const anchor = cur.lastTaskByContext[contextKeyOf(cur.context)] ?? null
      if (r.ok && r.task && canSettleTaskView(contextKeyOf(cur.context), anchor, cancelKey, tid)) {
        setTask(r.task)
        patchLastTurn(r.task)
      }
    } catch { /* 取消尽力而为；状态以后续进度事件为准 */ }
  }

  /** 新目标（概念稿 head「新会话」位）：清空问答流回到空闲态；任务锚点保留（切回可恢复） */
  const resetToIdle = () => {
    setTask(null)
    setTurns([])
    setStartError('')
    setContinueError('')
  }

  // 依据条跳转：chat 类证据 + 当前上下文自带会话（chat/customer 入口）才能真实定位；
  // 全局上下文证据锚点（messageKey）不含会话 id，降级为纯展示，绝不臆造跳转
  const chatJumpSessionId = context.kind === 'chat' || context.kind === 'customer' ? context.sessionId : ''
  const jumpToChat = () => {
    if (!chatJumpSessionId) return
    navigate(`/chat?sessionId=${encodeURIComponent(chatJumpSessionId)}`)
  }

  const isRunning = !!task && (task.status === 'running' || task.status === 'planning')
  const suggestions = suggestGoalsFor(context)
  const settled = isSettled(task)

  /** 一轮回答：运行中只出 slim 占位（详细轨迹在右栏，绝不伪造步骤）；完成出结论气泡（含依据条）；失败出人话错误气泡 */
  const renderAnswer = (t: HermesTaskSnapshot) => {
    if (t.status === 'running' || t.status === 'planning') {
      return (
        <div className="hermes-msg hermes-msg--in hermes-msg--broad">
          <div className="hermes-run">
            <Loader2 size={14} className="spin" />
            <span>正在规划查询步骤…</span>
          </div>
          {t.steps.length > 0 && <div className="hermes-run__n">已执行 {t.steps.length} 步 · 轨迹见右侧</div>}
        </div>
      )
    }
    if (t.status === 'completed' && t.result) {
      return (
        <div className="hermes-msg hermes-msg--in hermes-msg--broad">
          <div className="hermes-msg__tag">结论</div>
          <p className="hermes-msg__text">{t.result.summary}</p>
          {t.result.findings.length > 0 && (
            <div className="hermes-msg__block">
              <div className="hermes-msg__label">发现</div>
              <ul className="hermes-list">
                {t.result.findings.map((f, i) => (
                  <li key={i}>
                    {f.text}
                    {f.evidenceRefs.length > 0 && (
                      <span className="hermes-finding__refs">{f.evidenceRefs.join('、')}</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {t.result.nextSteps.length > 0 && (
            <div className="hermes-msg__block">
              <div className="hermes-msg__label">建议下一步</div>
              <ul className="hermes-list">
                {t.result.nextSteps.map((n, i) => <li key={i}>{n}</li>)}
              </ul>
            </div>
          )}
          {renderCites(t)}
        </div>
      )
    }
    if (t.status === 'failed' || t.status === 'cancelled') {
      return (
        <div className="hermes-msg hermes-msg--in hermes-msg--broad hermes-msg--error">
          <AlertCircle size={14} />
          <p>{getHermesErrorMessage(t.errorCode) || t.errorMessage}</p>
        </div>
      )
    }
    return null
  }

  /** 依据条：ref 编号 + label；可定位会话的 chat 证据可点跳转，其余纯展示 */
  const renderCites = (t: HermesTaskSnapshot) => {
    if (t.evidence.length === 0) return null
    return (
      <div className="hermes-cites">
        {t.evidence.map((ev: HermesEvidenceItem) => {
          const canJump = ev.kind === 'chat' && !!chatJumpSessionId
          const body = (
            <>
              {ev.kind === 'chat' ? <CircleDot size={10} /> : <Wrench size={10} />}
              <span className="hermes-cite__label">{ev.label}</span>
            </>
          )
          return canJump ? (
            <button key={ev.ref} type="button" className="hermes-cite" onClick={jumpToChat}
              title={ev.excerpt ? `跳到对应会话 · ${ev.excerpt}` : '跳到对应会话'}>
              {body}
            </button>
          ) : (
            <span key={ev.ref} className="hermes-cite" title={ev.excerpt || undefined}>{body}</span>
          )
        })}
      </div>
    )
  }

  /** 步骤状态图标（只渲染主进程推送的真实状态） */
  const renderStepIcon = (status: 'running' | 'done' | 'error') => {
    if (status === 'done') return <CheckCircle2 size={13} className="hermes-step__icon hermes-step__icon--done" />
    if (status === 'error') return <AlertCircle size={13} className="hermes-step__icon hermes-step__icon--error" />
    return <Loader2 size={13} className="hermes-step__icon hermes-step__icon--running spin" />
  }

  const avatarChar = context.kind === 'global' ? null : contextTitle(context).replace(/^[^：:]*[：:]/, '').slice(0, 1)

  return (
    <div className="hermes-page">
      {/* 左栏：上下文 + 任务锚点（概念稿会话列表位按真实口径收编——真实 Hermes 无会话史，
          只画当前上下文与该上下文最近任务，绝不臆造会话行） */}
      <aside className="hermes-col hermes-col--nav" aria-label="Hermes 上下文与任务">
        <div className="hermes-col__g">上下文</div>
        <div className="hermes-ctx is-on">
          <span className="hermes-ctx__avatar">
            {avatarChar ?? <Bot size={13} />}
          </span>
          <span className="hermes-ctx__main">
            <span className="hermes-ctx__n">{contextTitle(context)}</span>
            <span className="hermes-ctx__s">{contextKindLabel(context)}</span>
          </span>
        </div>

        <div className="hermes-col__g">任务</div>
        {task ? (
          <div className="hermes-ctx">
            <span className="hermes-ctx__avatar hermes-ctx__avatar--task">
              {isRunning ? <Loader2 size={12} className="spin" /> : <Sparkles size={12} />}
            </span>
            <span className="hermes-ctx__main">
              <span className="hermes-ctx__n" title={task.goal}>{task.goal}</span>
              <span className="hermes-ctx__s">{TASK_STATUS_TEXT[task.status] || task.status}</span>
            </span>
          </div>
        ) : (
          <div className="hermes-col__empty">{lastTaskId ? '任务视图已重置' : '本上下文还没有任务'}</div>
        )}

        <div className="hermes-col__hint">
          任务按上下文独立记忆；离开本页再回来，按锚点恢复最新进度。Hermes 只读分析，不写任何业务数据。
        </div>
      </aside>

      {/* 中栏：问答流（概念稿 .thread 语法） */}
      <section className="hermes-thread">
        <div className="hermes-thread__head">
          <div className="hermes-thread__title">
            <div className="hermes-thread__t" title={task?.goal}>{task ? task.goal : 'Hermes'}</div>
            <div className="hermes-thread__s">Hermes · 只读分析 · 不替你操作</div>
          </div>
          <div className="hermes-thread__acts">
            {settled && (
              <button className="btn btn--sm" onClick={resetToIdle}>新目标</button>
            )}
          </div>
        </div>

        <div className="hermes-thread__body">
          {/* 空闲态：目标输入提示 + 推荐目标 chips（细线行） */}
          {!task && !starting && (
            <div className="hermes-idle">
              <div className="hermes-run hermes-run--idle">
                <Sparkles size={14} />
                <span>说出你的销售目标，Hermes 会查本机数据、核对证据后给出建议。</span>
              </div>
              <div className="hermes-idle__label">推荐目标</div>
              <div className="hermes-idle__chips">
                {suggestions.map((s) => (
                  <button key={s} className="hermes-chip" onClick={() => void handleStart(s)}>{s}</button>
                ))}
              </div>
            </div>
          )}

          {/* 问答流：提问右气泡 + 回答左气泡（轮次视图只在切换上下文/新任务时重建） */}
          {turns.map((turn, i) => (
            <div key={i} className="hermes-turn">
              <div className="hermes-msg hermes-msg--out">
                <div className="hermes-msg__b">{turn.question}</div>
              </div>
              {renderAnswer(turn.task)}
              {turn.task.status === 'completed' && turn.task.result && (
                <div className="hermes-panel__disclaimer">AI 结论仅供参考，请结合实际情况判断</div>
              )}
            </div>
          ))}

          {/* 发起失败提示（空闲态下的错误条） */}
          {!task && startError && (
            <div className="hermes-panel__failed hermes-panel__failed--inline">
              <AlertCircle size={16} />
              <p>{startError}</p>
            </div>
          )}
        </div>

        {/* 底部操作区：与答案区分离常驻。运行中只留「停止」（隐藏输入防重复提交）；
            完成态为追问输入；空闲态为目标输入。 */}
        {isRunning && (
          <div className="hermes-thread__foot hermes-thread__foot--acting">
            <span className="hermes-foot__note">正在执行，完成后可继续追问</span>
            <button className="btn btn--plain btn--sm" onClick={() => void handleCancel()}>停止</button>
          </div>
        )}

        {!isRunning && !(task && task.status === 'completed') && (
          <div className="hermes-thread__foot">
            <div className="hermes-input-row">
              <input
                type="text"
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void handleStart() }}
                placeholder="例如：帮我分析这个客户下一步该怎么谈…"
                disabled={starting}
              />
              <button className="btn btn--primary-soft" onClick={() => void handleStart()} disabled={starting || !goal.trim()}>
                {starting ? <Loader2 size={14} className="spin" /> : '让 Hermes 分析'}
              </button>
            </div>
          </div>
        )}

        {/* completed 态底部：追问输入沿用本任务上下文 */}
        {task && task.status === 'completed' && (
          <div className="hermes-thread__foot">
            {continueError && (
              <div className="hermes-panel__failed hermes-panel__failed--inline">
                <AlertCircle size={16} />
                <p>{continueError}</p>
              </div>
            )}
            <div className="hermes-input-row">
              <input
                type="text"
                value={followUp}
                onChange={(e) => setFollowUp(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void handleContinue() }}
                placeholder="继续追问…"
                disabled={continuing}
              />
              <button className="btn btn--primary-soft" onClick={() => void handleContinue()} disabled={continuing || !followUp.trim()}>
                {continuing ? <Loader2 size={14} className="spin" /> : '让 Hermes 分析'}
              </button>
            </div>
            <div className="hermes-foot__acts">
              <span className="hermes-foot__note">追问沿用本任务上下文</span>
            </div>
          </div>
        )}
      </section>

      {/* 右栏：本次调用的工具（真实步骤轨迹）+ 边界（概念稿 aiSide 语法） */}
      <aside className="hermes-col hermes-col--side" aria-label="Hermes 调用记录">
        <div className="hermes-side-block">
          <div className="hermes-side-head">
            <span className="hermes-side-head__t">本次调用的工具</span>
            {task && <span className="num hermes-side-head__n">{task.steps.length} 步</span>}
          </div>
          {task && task.steps.length > 0 ? (
            <ul className="hermes-steps">
              {task.steps.map((s, i) => (
                <li key={i} className={`hermes-step hermes-step--${s.status}`}>
                  {renderStepIcon(s.status)}
                  <div className="hermes-step__body">
                    <span className="hermes-step__label">{s.label}</span>
                    {s.publicSummary && <span className="hermes-step__summary">{s.publicSummary}</span>}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <div className="hermes-side__empty">{isRunning ? '正在规划查询步骤…' : '尚未调用'}</div>
          )}
        </div>

        <div className="hermes-side-block">
          <div className="hermes-side-head">
            <span className="hermes-side-head__t">边界</span>
          </div>
          <p className="sub hermes-side__text">
            Hermes 只读会话、客户、产品与业务库；写待办、改归属、发消息这类动作一律先给你确认，不会自己执行。
          </p>
        </div>
      </aside>
    </div>
  )
}
