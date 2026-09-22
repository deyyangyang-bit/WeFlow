/**
 * SalesContextStrip.tsx
 *
 * 聊天页右栏「销售上下文」（PRD v2 P2）。
 * 挂在 aside.chat-rail 里，按概念稿 .side-block 分三段：本机识别 / 依据消息 / 回复建议；
 * 三段都用概念稿基础件（.verdicts / .evidence+.ev / .draft+.draft__acts，定义在 src/styles/main.scss），
 * 组件自己不再带一层皮肤。常驻展开，不再是顶部一条折叠条 —— 右栏本身已是专属栏位，没有可折叠的必要。
 * 数据全部来自本组件自身的读取，不补默认值；没识别过就如实显示「尚未识别」。
 *
 * 判断段与客户档案（CustomerWorkspacePage）同一套 .verdicts / .verdict / .ahead 标记，
 * 字段名同 customerCurrentView.judgments 投影（summary / opportunity / risk / nextAction）。
 * 依据段只列判断里带 messageKey 的锚点，点击才走 P0-2B 拉原话（与 360 同语义）；
 * 当前会话的消息高亮（flashNewMessages）只存在于 ChatPage 内部，未做跨组件接线，
 * 因此保留内联证据文案这条既有路径。
 *
 * 2026-09-18 P1.2（真机补差）：
 *   · 「本机识别」标题行右侧补识别时间戳记（概念稿 .side-head 右侧 .num）：只用判断投影里真实的
 *     generatedAt，取不到就整条不显示；覆盖条数在本机没有真实来源，故不写（不造假）。
 *   · 回复建议的 .draft 壳修好渲染路径：suggest 回的是 ActionAnalysisResult.script，
 *     旧代码读不存在的 result.suggestion，导致真机上「有建议」也只剩一个按钮。
 * 2026-09-18 P1.5（观感对齐）：
 *   · 栏头右侧收敛为概念稿同款单一 .num 戳记（10.5px 等宽 tertiary）：阶段 / 沉默天数 /
 *     识别时间拼成一句安静小字，去掉旧的内联色 .pill 徽章 —— 右栏第一视觉留给判断本身，
 *     与客户右栏 .cws-side__meta 同一档。阶段「未知」不进戳记（没有信息量）。
 *   · 判断行空格的「尚未识别」只保留取值文字，去掉重复的 ahead 标记（原先是同一句话出现两遍）。
 * 2026-09-18 P1.5 细修（动作降档，纯视觉）：
 *   · 无草稿时「AI 跟进建议」从实心 primary 降为次要档（.btn 默认档，与客户右栏动作同级）。
 *   · 有草稿时保持 .draft + .draft__acts（复制/换一版）；「复制建议」改轻 primary
 *     （.btn--primary-soft，浅 accent 底），动作行最多一档主色。
 *   · suggest API、草稿数据路径不动，不造假草稿。
 * 2026-09-19 UI 改版第一批：
 *   · 未识别会话不再整栏消失：首轮读取完成后仍无画像/意向 → 显示「尚未识别」空态段
 *     （概念稿未识别会话语义：不假装有结论）；加载中先不出栏，防闪空态。
 *   · 换会话时清掉上一会话的画像/判断/草稿（旧数据不再闪现半秒）。
 */
import { useCallback, useEffect, useState } from 'react'
import { Copy, Check, Sparkles } from 'lucide-react'
import './SalesContextStrip.scss'

const STAGE_MAP: Record<string, { label: string; color: string }> = {
  new: { label: '新客', color: '#3b82f6' },
  contacted: { label: '已沟通', color: '#8b5cf6' },
  quoted: { label: '已报价', color: '#f59e0b' },
  negotiating: { label: '谈判中', color: '#ef4444' },
  won: { label: '成交', color: '#10b981' },
  lost: { label: '流失', color: '#6b7280' },
  dormant: { label: '沉默', color: '#9ca3af' },
  unknown: { label: '未知', color: '#6b7280' },
  '了解': { label: '了解', color: '#4a9eff' },
  '比价': { label: '比价', color: '#f5a623' },
  '决策': { label: '决策', color: '#e74c3c' },
  '成交': { label: '成交', color: '#27ae60' },
  '流失': { label: '流失', color: '#95a5a6' }
}

interface ProfileData {
  stage: string
  display_name: string | null
  last_contact_at: number | null
  notes: string | null
}

interface IntentData {
  stage: string
  confidence: number | null
  reason: string | null
  created_at: number
}

/**
 * 「本机识别」行的戳记时间（概念稿 .side-head 右侧 .num）：同日内只给时刻，昨天与更早补日期。
 * 无效时间返回空串 —— 不伪造时间，也不显示「刚刚」这类没有依据的说法。
 */
function fmtStampTime(ms: number): string {
  if (!ms || !Number.isFinite(ms)) return ''
  const d = new Date(ms)
  if (!Number.isFinite(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`
  const now = new Date()
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  if (sameDay(d, now)) return hm
  if (sameDay(d, new Date(now.getTime() - 86400_000))) return `昨天 ${hm}`
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${hm}`
}

interface Props {
  sessionId: string
}

export default function SalesContextStrip({ sessionId }: Props) {
  const [profile, setProfile] = useState<ProfileData | null>(null)
  const [latestIntent, setLatestIntent] = useState<IntentData | null>(null)
  const [judgments, setJudgments] = useState<any>(null)
  const [suggestion, setSuggestion] = useState('')
  const [loadingSuggestion, setLoadingSuggestion] = useState(false)
  const [copied, setCopied] = useState(false)
  // P0-3.3 证据回查：视图只带 messageKey 锚点，点击才走 P0-2B 拉原话（与 360 同语义）
  const [evidenceKey, setEvidenceKey] = useState<string | null>(null)
  const [evidenceMsg, setEvidenceMsg] = useState<string | null>(null)
  // 本轮会话的首轮读取是否完成：完成仍无画像/意向 = 未识别会话（走「尚未识别」空态），避免加载中闪空态
  const [loaded, setLoaded] = useState(false)

  // P0-3.3 判断证据回查（与 Customer 360 判断卡同语义）
  const toggleEvidence = async (j: any) => {
    if (!j?.messageKey || !sessionId) return
    if (evidenceKey === j.messageKey) { setEvidenceKey(null); setEvidenceMsg(null); return }
    setEvidenceKey(j.messageKey)
    setEvidenceMsg('正在回查原话…')
    try {
      const r = await (window as any).electronAPI.sales.evidenceGetByKey({
        session_id: sessionId,
        message_key: j.messageKey,
        evidence_text: j.value ? `判断：${j.value}` : undefined
      })
      if (r?.status === 'found') {
        const m = r.message
        const text = String(m?.parsedContent || m?.content || m?.rawContent || '')
        const t = Number(m?.createTime || 0)
        const time = t ? new Date(t).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''
        setEvidenceMsg(`原话（${time}）：${text}`)
      } else {
        setEvidenceMsg(`未找到原话（${r?.reason || 'unavailable'}）；判断依据句：${j.value}`)
      }
    } catch (e) {
      setEvidenceMsg(`回查失败：${String(e)}`)
    }
  }

  // 加载客户画像 + 意图 + 当前视图（P0-3.3：判断只消费 currentView，不自拼真源）
  useEffect(() => {
    if (!sessionId) return
    let cancelled = false
    // 组件不随会话卸载：换会话先清掉上一会话的画像/判断/草稿与展开的证据，
    // 避免别的客户的正文留在栏里（30 秒轮询走 load()，不触发这段，只刷新数据）
    setProfile(null)
    setLatestIntent(null)
    setJudgments(null)
    setSuggestion('')
    setEvidenceKey(null)
    setEvidenceMsg(null)
    setLoaded(false)

    async function load() {
      try {
        const p = await (window as any).electronAPI.sales.customerGet(sessionId)
        if (!cancelled && p) setProfile(p)

        const history = await (window as any).electronAPI.sales.intentHistory(sessionId, 1)
        if (!cancelled && history?.length > 0) setLatestIntent(history[0])

        const v = await (window as any).electronAPI.sales.customerCurrentView(sessionId)
        if (!cancelled && v?.success) setJudgments(v.data?.judgments || null)
      } catch { /* ignore */ } finally {
        if (!cancelled) setLoaded(true)
      }
    }
    load()

    // 每 30 秒刷新一次（阶段/判断可能被后台自动更新）
    const timer = setInterval(load, 30_000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [sessionId])

  const handleSuggest = useCallback(async () => {
    if (!profile) return
    setLoadingSuggestion(true)
    try {
      const nowSec = Math.floor(Date.now() / 1000)
      const lastContact = profile.last_contact_at ?? 0
      const silentDays = Math.max(0, Math.floor((nowSec - lastContact) / 86400))

      const result = await (window as any).electronAPI.sales.actionSuggest({
        sessionId, // P0-3.3：补 sessionId——suggest 落库（channel=suggest/manual）依赖它定位客户，缺失会 invalid_input 跳过
        displayName: profile.display_name || sessionId,
        stage: profile.stage || 'unknown',
        silentDays,
        title: `跟进客户 ${profile.display_name || sessionId}`
      })
      // sales:action:suggest 回的是 ActionAnalysisResult（script = 可直接发送的回复话术）。
      // 旧代码读 result.suggestion —— actionSuggest 从不回这个字段，于是「有建议」也进不了 .draft 分支，
      // 真机上只剩一个按钮（P1.2 修的就是这条渲染路径）。失败/未配置时不覆盖已有草稿，如实留空。
      const draft = String(result?.script || result?.suggestion || '').trim()
      if (draft) setSuggestion(draft)
      // P0-3.3 验证闭环：生成成功 → customer_judgment append → 立即重读 currentView → UI 显示新判断
      const v = await (window as any).electronAPI.sales.customerCurrentView(sessionId)
      if (v?.success) setJudgments(v.data?.judgments || null)
    } catch { /* ignore */ }
    setLoadingSuggestion(false)
  }, [profile, sessionId])

  const handleCopy = useCallback(async () => {
    if (!suggestion) return
    try {
      await navigator.clipboard.writeText(suggestion)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch { /* ignore */ }
  }, [suggestion])

  // 未识别会话（读取完成仍无画像与意向）：栏保留，如实显示「尚未识别」空态 ——
  // 概念稿语义：不假装有结论，也不整栏消失让人误以为右栏坏了（2026-09-19 UI 第一批）。
  // 依据/回复建议两段随判断一起不出现（没有判断就没有依据，没有画像就生成不了草稿）。
  if (!profile && !latestIntent) {
    if (!loaded) return null
    return (
      <div className="sales-context-strip">
        <div className="side-block">
          <div className="side-head">
            <span className="side-head__t">本机识别</span>
            <span className="num sales-context-strip__stamp">尚未识别</span>
          </div>
          <p className="coverage">
            本次会话尚未识别，暂无判断与建议；这不代表「无需跟进」。识别只在本机运行，聊天内容不会上传。
          </p>
        </div>
      </div>
    )
  }

  const stage = profile?.stage || latestIntent?.stage || 'unknown'
  const stageInfo = STAGE_MAP[stage] || STAGE_MAP.unknown
  const nowSec = Math.floor(Date.now() / 1000)
  const lastContact = profile?.last_contact_at ?? 0
  const silentDays = lastContact > 0 ? Math.max(0, Math.floor((nowSec - lastContact) / 86400)) : 0

  // 四栏判断（与客户档案同一投影）：缺哪栏就如实标「尚未识别」，不用空字符串占位
  const rows: Array<[string, any]> = [
    ['摘要', judgments?.summary],
    ['机会', judgments?.opportunity],
    ['风险', judgments?.risk],
    ['下一步', judgments?.nextAction]
  ]
  const hasAnyJudgment = rows.some(([, v]) => v)
  // 依据锚点：只有带 messageKey 的判断才有原话可回查，没有就不编一条出来
  const anchors = rows.filter(([, v]) => v && v.evidenceStatus === 'ok' && v.messageKey)

  // 本机识别戳记（概念稿 .side-head 右侧 .num）：字段只用识别结果里真有的「判断生成时间」。
  // 概念稿那句「覆盖 214 条」在本机没有真实来源（识别按窗口读消息、结果里不落每会话覆盖条数），
  // 拿会话总条数顶上会把「读了一个窗口」说成「覆盖全部」—— 宁缺不假，没有生成时间就整条不显示。
  // 位置在上面的 early return 之后，这里不能再调 hook（纯计算足够，四个字段取最大值）。
  const stampTimes = ([judgments?.summary, judgments?.opportunity, judgments?.risk, judgments?.nextAction] as
    Array<{ generatedAt?: number } | null | undefined>)
    .map((v) => Number(v?.generatedAt || 0))
    .filter((t) => t > 0)
  const identifyStampMs = stampTimes.length ? Math.max(...stampTimes) : 0
  const identifyStamp = fmtStampTime(identifyStampMs)
  // P1.5 栏头戳记（概念稿 .side-head 右侧 .num「09:41 · 覆盖 214 条」同位）：
  // 阶段（未知不出现）/ 沉默天数 / 识别时间拼成一句安静小字；全空则整条不出。
  const contextStamp = [
    stage !== 'unknown' ? stageInfo.label : '',
    silentDays > 0 ? `${silentDays} 天未联系` : '',
    identifyStamp
  ].filter(Boolean).join(' · ')

  return (
    <div className="sales-context-strip">
      {/* 判断（概念稿 .side-block：侧栏分段；与客户档案同一个 .verdicts 组件） */}
      <div className="side-block">
        <div className="side-head">
          <span className="side-head__t">本机识别</span>
          {/* 阶段 / 沉默天数 / 识别时间：P1.5 起收敛为概念稿同款单一 .num 戳记（安静小字），
              阶段「未知」与缺失项不进串；什么都没有就整条不显示，不造空节点 */}
          {contextStamp && (
            <span
              className="num sales-context-strip__stamp"
              title={identifyStamp ? `本机识别时间：${new Date(identifyStampMs).toLocaleString('zh-CN')}` : undefined}
            >{contextStamp}</span>
          )}
        </div>

        {/* 最近意向与备注都是前提（这份判断基于什么），压在栏内紧凑行里，不另起分段 */}
        {latestIntent?.reason && <p className="sales-context-strip__reason">最近意向 · {latestIntent.reason}</p>}
        {profile?.notes && <p className="sales-context-strip__reason sales-context-strip__notes">备注 · {profile.notes}</p>}

        {judgments && hasAnyJudgment ? (
          <div className="verdicts">
            {rows.map(([label, v]) => (
              <div key={label} className={`verdict${v ? '' : ' verdict--muted'}`}>
                <div className="verdict__k">{label}</div>
                <div>
                  <div className="verdict__v">{v ? String(v.value || '') : '尚未识别'}</div>
                  {/* P1.5：出处标记只跟着有值的格子走（空格的「尚未识别」由取值文字承担），
                      出处行整行不渲染，避免空 meta 撑出一段无内容的缝 */}
                  {v && (
                    <div className="verdict__meta">
                      {v.source === 'manual' && <span className="ahead ahead--human"><i className="ahead__i" />人工确认</span>}
                      {v.source !== 'manual' && (
                        <span className="ahead ahead--ai" title={v.freshness === 'stale' ? '生成已超 24h，可能过时' : ''}>
                          <i className="ahead__i" />{v.freshness === 'stale' ? 'AI · 可能已过期' : 'AI · 新鲜'}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="coverage">
            {judgments
              ? '暂无 AI 判断（可点下方「AI 跟进建议」主动生成）。'
              : '本次会话尚未识别。识别只在本机运行，聊天内容不会上传。'}
          </p>
        )}
      </div>

      {/* 依据（概念稿 .evidence：细线行，点一行回查一行原话） */}
      {anchors.length > 0 && (
        <div className="side-block">
          <div className="side-head">
            <span className="side-head__t">依据消息</span>
            <span className="num sales-context-strip__count">{anchors.length} 条</span>
          </div>
          <div className="evidence">
            {anchors.map(([label, v]) => {
              const open = evidenceKey === v.messageKey
              return (
                <button
                  key={`${label}:${v.messageKey}`}
                  type="button"
                  className={`ev${open ? ' is-open' : ''}`}
                  title={open ? '收起原话' : '点击回查这一栏的原话'}
                  onClick={() => void toggleEvidence(v)}
                >
                  <span className="ev__t">{label}</span>
                  <span className="ev__q">{open && evidenceMsg ? evidenceMsg : String(v.value || '')}</span>
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* 回复建议（概念稿 .draft）：正文 + 复制；无建议时保留生成按钮 */}
      <div className="side-block">
        <div className="side-head">
          <span className="side-head__t">回复建议</span>
        </div>
        {suggestion ? (
          <>
            <div className="draft">{suggestion}</div>
            <div className="draft__acts">
              {/* P1.5 细修：复制是草稿态唯一的主操作，用「轻 primary」（浅 accent 底），
                  不再上实心主色；换一版保持 quiet —— 动作行最多一档主色 */}
              <button className="btn btn--sm btn--primary-soft" onClick={handleCopy}>
                {copied ? <Check size={13} strokeWidth={1.6} /> : <Copy size={13} strokeWidth={1.6} />}
                {copied ? '已复制' : '复制建议'}
              </button>
              <button className="btn btn--sm btn--quiet" onClick={() => void handleSuggest()} disabled={loadingSuggestion}>
                {loadingSuggestion ? '生成中…' : '换一版'}
              </button>
            </div>
          </>
        ) : (
          <div className="draft__acts">
            {/* profile 未就绪时 suggest 会直接跳过（无客户可定位），按钮如实禁用而不是空点。
                P1.5 细修：生成是常规动作不是「今天必须做的这一件」，降为与客户右栏动作
                同级的次要档（.btn 默认档，无实心主色）——右栏第一视觉留给判断本身。 */}
            <button
              className="btn btn--sm"
              onClick={() => void handleSuggest()}
              disabled={loadingSuggestion || !profile}
            >
              <Sparkles size={13} strokeWidth={1.6} />
              {loadingSuggestion ? '生成中…' : 'AI 跟进建议'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
