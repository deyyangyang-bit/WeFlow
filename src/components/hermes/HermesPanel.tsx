/**
 * HermesPanel.tsx —— Hermes 只读智能体抽屉（设计-Hermes-MVP 智能体第一刀）
 *
 * App 级唯一实例（App.tsx 挂载一份）：右侧抽屉 + 半透明遮罩（不过暗，可点关闭）。
 * 三入口（Sidebar / ChatPage / CustomerWorkspacePage）经 hermesStore.openHermes(context) 打开，
 * 上下文（global / chat / customer）随入口注入；任务锚点按上下文独立记忆（lastTaskByContext），
 * 切换入口不串显别的上下文的任务；关闭抽屉 / 路由切换不删任务——任务真源在主进程内存，
 * 切回原上下文时按该上下文锚点经 hermes.task.get 恢复视图并重订阅进度。
 *
 * 铁律（hermes-agent-test 静态断言锚点，改本文件先跑测试）：
 *  - 五态：空闲（推荐目标）/ 运行（只渲染主进程推送的真实步骤，绝不伪造）/ 完成（结论 +
 *    发现 + 建议 + 证据）/ 失败（人话文案，绝不出现 SQL/IPC/堆栈/路径）/ 多轮追问
 *  - 本组件零发送类 IPC 调用（AI 碰不到发送键，结论永不自动发给客户）
 *  - AI 结论仅展示（不写 stage / judgment / 待办——写路在本组件不存在）
 *  - 证据列表只展示主进程核验过的 evidence（ref 编号），不展示模型原始输出
 *  - 样式零硬编码 hex（--color-* 族 token，light/dark 两套自适应）
 */
import { useEffect, useRef, useState } from 'react'
import { Bot, X, Sparkles, CheckCircle2, CircleDot, AlertCircle, Loader2, Undo2 } from 'lucide-react'
import { useHermesStore, canSettleTaskView, contextKeyOf, type HermesContext } from '../../stores/hermesStore'
import type { HermesTaskSnapshot } from '../../types/electron'
import { getHermesErrorMessage } from '../../../shared/hermesErrorMessages'
import './HermesPanel.scss'

/** 任务收尾状态（completed/failed/cancelled） */
const isSettled = (t: HermesTaskSnapshot | null): boolean =>
  !!t && (t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled')

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

/** 上下文人话标签（抽屉头副标题） */
function contextTitle(ctx: HermesContext): string {
  if (ctx.kind === 'customer') return `客户：${ctx.customerName}`
  if (ctx.kind === 'chat') return `会话：${ctx.sessionName}`
  return '全局'
}

/** 步骤状态图标（只渲染主进程推送的真实状态） */
function StepIcon({ status }: { status: 'running' | 'done' | 'error' }) {
  if (status === 'done') return <CheckCircle2 size={13} className="hermes-step__icon hermes-step__icon--done" />
  if (status === 'error') return <AlertCircle size={13} className="hermes-step__icon hermes-step__icon--error" />
  return <Loader2 size={13} className="hermes-step__icon hermes-step__icon--running spin" />
}

export default function HermesPanel() {
  const isOpen = useHermesStore((s) => s.isHermesOpen)
  const context = useHermesStore((s) => s.context)
  // 按当前上下文取任务锚点（各客户/会话/全局独立记忆，切换入口不串显别的上下文的任务）
  const lastTaskId = useHermesStore((s) => s.lastTaskByContext[contextKeyOf(s.context)] ?? null)
  const setLastTaskId = useHermesStore((s) => s.setLastTaskId)
  const closeHermes = useHermesStore((s) => s.closeHermes)

  const [task, setTask] = useState<HermesTaskSnapshot | null>(null)
  const [goal, setGoal] = useState('')
  const [starting, setStarting] = useState(false)
  const [followUp, setFollowUp] = useState('')
  const [continuing, setContinuing] = useState(false)
  const [startError, setStartError] = useState('')
  const [continueError, setContinueError] = useState('')
  const taskRef = useRef<HermesTaskSnapshot | null>(null)
  taskRef.current = task

  // 打开/切换上下文：先清空本地视图（新上下文无任务时绝不残留上一上下文的正文），
  // 再按当前上下文锚点恢复；恢复返回时上下文又已切换则放弃（锚点仍在，切回可恢复）
  useEffect(() => {
    if (!isOpen) return
    setTask(null)
    if (!lastTaskId) return
    let disposed = false
    void window.electronAPI.hermes.getTask(lastTaskId).then((r) => {
      const cur = useHermesStore.getState()
      if (disposed || !r.ok || !r.task) return
      if (contextKeyOf(cur.context) !== contextKeyOf(context)) return
      setTask(r.task)
    })
    return () => { disposed = true }
  }, [isOpen, lastTaskId, context])

  // 进度订阅：全程挂载期订阅（面板 hidden 不退订，路由切换不丢推送）。
  // 只接受「当前上下文锚点任务」的推送——本上下文没有锚点时一律丢弃，
  // 其他上下文的后台任务进度绝不会灌进当前视图（taskRef 为空也不再放行）。
  useEffect(() => {
    return window.electronAPI.hermes.onTaskProgress((t) => {
      const cur = useHermesStore.getState()
      const expected = cur.lastTaskByContext[contextKeyOf(cur.context)] ?? null
      if (!expected || t.taskId !== expected) return
      setTask(t)
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
      if (r.ok && r.task && canSettleTaskView(contextKeyOf(cur.context), anchor, cancelKey, tid)) setTask(r.task)
    } catch { /* 取消尽力而为；状态以后续进度事件为准 */ }
  }

  const isRunning = !!task && (task.status === 'running' || task.status === 'planning')
  const settled = isSettled(task)
  const suggestions = suggestGoalsFor(context)

  return (
    <div className={`hermes-panel ${isOpen ? 'open' : ''}`} aria-hidden={!isOpen}>
      <div className="hermes-panel__mask" onClick={closeHermes} />
      <div className="hermes-panel__drawer" role="dialog" aria-label="Hermes 智能体">
        <div className="hermes-panel__head">
          <span className="hermes-panel__head-icon"><Bot size={16} /></span>
          <div className="hermes-panel__head-meta">
            <h3>Hermes</h3>
            <span className="hermes-panel__head-sub">{contextTitle(context)} · 只读分析，不替你操作</span>
          </div>
          <button className="hermes-panel__close" onClick={closeHermes} aria-label="关闭"><X size={16} /></button>
        </div>

        <div className="hermes-panel__body">
          {/* 空闲态：目标输入 + 推荐目标 chips */}
          {!task && !starting && (
            <div className="hermes-panel__idle">
              <div className="hermes-panel__hint">
                <Sparkles size={14} />
                <span>说出你的销售目标，Hermes 会查本机数据、核对证据后给出建议。</span>
              </div>
              <div className="hermes-panel__chips">
                {suggestions.map((s) => (
                  <button key={s} className="hermes-chip" onClick={() => void handleStart(s)}>{s}</button>
                ))}
              </div>
            </div>
          )}

          {/* 运行态：只渲染主进程推送的真实步骤（无步骤时显示规划中，不伪造动画） */}
          {isRunning && (
            <div className="hermes-panel__running">
              <div className="hermes-panel__goal-line">目标：{task!.goal}</div>
              <section className="hermes-section">
                <div className="hermes-section__head">
                  <span className="hermes-section__t">执行步骤</span>
                  {task!.steps.length > 0 && <span className="hermes-section__n num">{task!.steps.length}</span>}
                </div>
                {task!.steps.length === 0 && <div className="hermes-panel__hint"><Loader2 size={14} className="spin" /><span>正在规划查询步骤…</span></div>}
                <ul className="hermes-steps">
                  {task!.steps.map((s, i) => (
                    <li key={i} className={`hermes-step hermes-step--${s.status}`}>
                      <StepIcon status={s.status} />
                      <div className="hermes-step__body">
                        <span className="hermes-step__label">{s.label}</span>
                        {s.publicSummary && <span className="hermes-step__summary">{s.publicSummary}</span>}
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            </div>
          )}

          {/* 完成态：结论 + 发现 + 建议 + 证据（全部来自主进程核验的快照） */}
          {settled && task!.status === 'completed' && task!.result && (
            <div className="hermes-panel__result">
              <div className="hermes-panel__goal-line">目标：{task!.goal}</div>
              <div className="hermes-card hermes-card--summary">
                <div className="hermes-card__tag">结论</div>
                <p className="hermes-card__text">{task!.result.summary}</p>
              </div>
              {task!.result.findings.length > 0 && (
                <div className="hermes-card">
                  <div className="hermes-card__tag">发现</div>
                  <ul className="hermes-list">
                    {task!.result.findings.map((f, i) => (
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
              {task!.result.nextSteps.length > 0 && (
                <div className="hermes-card">
                  <div className="hermes-card__tag">建议下一步</div>
                  <ul className="hermes-list">
                    {task!.result.nextSteps.map((n, i) => <li key={i}>{n}</li>)}
                  </ul>
                </div>
              )}
              {task!.evidence.length > 0 && (
                <div className="hermes-card">
                  <div className="hermes-card__tag">证据 · {task!.evidence.length} 条</div>
                  <ul className="hermes-evidence">
                    {task!.evidence.map((ev) => (
                      <li key={ev.ref}>
                        <CircleDot size={11} />
                        <span className="hermes-evidence__label">{ev.label}</span>
                        {ev.excerpt && <span className="hermes-evidence__excerpt">{ev.excerpt}</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="hermes-panel__disclaimer">AI 结论仅供参考，请结合实际情况判断</div>
            </div>
          )}

          {/* 失败 / 取消态：人话文案（errorMessage 由主进程统一生成，绝不含技术细节） */}
          {task && (task.status === 'failed' || task.status === 'cancelled') && (
            <div className="hermes-panel__failed">
              <AlertCircle size={22} />
              <p>{getHermesErrorMessage(task.errorCode) || task.errorMessage}</p>
            </div>
          )}

          {/* 发起失败提示（空闲态下的错误条） */}
          {!task && startError && (
            <div className="hermes-panel__failed hermes-panel__failed--inline">
              <AlertCircle size={16} />
              <p>{startError}</p>
            </div>
          )}
        </div>

        {/* 底部操作区：与答案区分离常驻，长回答滚动时输入框仍在原位。
            运行中只留「停止」（隐藏输入防重复提交）；完成态为追问输入 + 换目标。 */}
        {isRunning && (
          <div className="hermes-panel__footer hermes-panel__footer--acting">
            <span className="hermes-panel__footer-note">正在执行，完成后可继续追问</span>
            <button className="hermes-panel__cancel" onClick={() => void handleCancel()}>停止</button>
          </div>
        )}

        {!isRunning && !(task && task.status === 'completed') && (
          <div className="hermes-panel__footer">
            <div className="hermes-panel__input-row">
              <input
                type="text"
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void handleStart() }}
                placeholder="例如：帮我分析这个客户下一步该怎么谈…"
                disabled={starting}
              />
              <button className="hermes-panel__go" onClick={() => void handleStart()} disabled={starting || !goal.trim()}>
                {starting ? <Loader2 size={14} className="spin" /> : '让 Hermes 分析'}
              </button>
            </div>
          </div>
        )}

        {/* completed 态底部：追问输入沿用本任务上下文；「换个目标」另起新任务 */}
        {task && task.status === 'completed' && (
          <div className="hermes-panel__footer">
            {continueError && (
              <div className="hermes-panel__failed hermes-panel__failed--inline">
                <AlertCircle size={16} />
                <p>{continueError}</p>
              </div>
            )}
            <div className="hermes-panel__input-row">
              <input
                type="text"
                value={followUp}
                onChange={(e) => setFollowUp(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void handleContinue() }}
                placeholder="继续追问…"
                disabled={continuing}
              />
              <button className="hermes-panel__go" onClick={() => void handleContinue()} disabled={continuing || !followUp.trim()}>
                {continuing ? <Loader2 size={14} className="spin" /> : '让 Hermes 分析'}
              </button>
            </div>
            <div className="hermes-panel__footer-acts">
              <span className="hermes-panel__footer-note">追问沿用本任务上下文</span>
              <button className="hermes-panel__new" onClick={() => { setTask(null); setStartError(''); setContinueError('') }}>
                <Undo2 size={13} />换个目标
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
