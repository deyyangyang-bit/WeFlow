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

    async function load() {
      try {
        const p = await (window as any).electronAPI.sales.customerGet(sessionId)
        if (!cancelled && p) setProfile(p)

        const history = await (window as any).electronAPI.sales.intentHistory(sessionId, 1)
        if (!cancelled && history?.length > 0) setLatestIntent(history[0])

        const v = await (window as any).electronAPI.sales.customerCurrentView(sessionId)
        if (!cancelled && v?.success) setJudgments(v.data?.judgments || null)
      } catch { /* ignore */ }
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
      if (result?.suggestion) setSuggestion(result.suggestion)
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

  // 无数据时不渲染
  if (!profile && !latestIntent) return null

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

  return (
    <div className="sales-context-strip">
      {/* 判断（概念稿 .side-block：侧栏分段；与客户档案同一个 .verdicts 组件） */}
      <div className="side-block">
        <div className="side-head">
          <span className="side-head__t">本机识别</span>
          {/* 阶段 / 沉默天数从旧的整行 top-strip 主 UI 降为栏内紧凑元信息 */}
          <span className="sales-context-strip__meta">
            <span className="pill" style={{ background: `${stageInfo.color}1A`, color: stageInfo.color }}>{stageInfo.label}</span>
            {silentDays > 0 && (
              <span className={`sales-context-strip__silent${silentDays > 7 ? ' is-warn' : ''}`}>{silentDays} 天未联系</span>
            )}
          </span>
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
                  <div className="verdict__meta">
                    {!v && <span className="ahead"><i className="ahead__i" />尚未识别</span>}
                    {v && v.source === 'manual' && <span className="ahead ahead--human"><i className="ahead__i" />人工确认</span>}
                    {v && v.source !== 'manual' && (
                      <span className="ahead ahead--ai" title={v.freshness === 'stale' ? '生成已超 24h，可能过时' : ''}>
                        <i className="ahead__i" />{v.freshness === 'stale' ? 'AI · 可能已过期' : 'AI · 新鲜'}
                      </span>
                    )}
                  </div>
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
              <button className="btn btn--sm btn--primary" onClick={handleCopy}>
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
            {/* profile 未就绪时 suggest 会直接跳过（无客户可定位），按钮如实禁用而不是空点 */}
            <button
              className="btn btn--sm btn--primary"
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
