/**
 * KnowledgeAskPanel.tsx —— 刀 3 带引用知识问答面板（设计-Hermes-MVP 刀 3）
 * 入口：聊天页会话侧栏 + 客户档案「AI 工具」下拉。
 *
 * 铁律（hermes-ask-test 静态断言锚点，改本文件先跑测试）：
 *  - 答案区固定带「知识答案，仅供参考」标识
 *  - 引用固定格式 `引用自：《title》（vN）`，点击跳 /knowledge-base 对应条目（深链高亮）
 *  - 本组件无任何发送类 IPC 调用（AI 碰不到发送键，答案永不自动发给客户）
 *  - 无命中 → 「知识库里没有答案」+ 生成知识提案按钮（提案写入属刀 4，本刀置灰提示下一版）
 *  - viewed（展开）埋点：答案卡默认折叠，展开时记一次（同 askKey 只记一次）
 */
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { BookOpen, Search, X, ChevronDown, ChevronUp, AlertCircle, Quote, Plus } from 'lucide-react'
import './KnowledgeAskPanel.scss'

interface AskCitation { id: number; title: string; version: number }
interface AskResult {
  status: 'empty' | 'not_configured' | 'no_hit' | 'answer' | 'error'
  question: string
  askKey: string
  entries: AskCitation[]
  answer?: string
  citations?: AskCitation[]
  error?: string
}

export default function KnowledgeAskPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate()
  const [question, setQuestion] = useState('')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<AskResult | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [askedQuestion, setAskedQuestion] = useState('')

  if (!open) return null

  const handleAsk = async () => {
    const q = question.trim()
    if (!q || loading) return
    setLoading(true)
    setExpanded(false)
    setResult(null)
    try {
      const r = await (window as any).electronAPI.sales.kbAsk({ question: q })
      setResult(r)
      setAskedQuestion(q)
    } catch (e) {
      setResult({ status: 'error', question: q, askKey: '', entries: [], error: String(e) })
      setAskedQuestion(q)
    } finally {
      setLoading(false)
    }
  }

  // viewed（展开）埋点：答案卡默认折叠，展开时记一次（服务端同 askKey 去重）
  const handleExpand = async () => {
    if (!expanded && result?.status === 'answer') {
      try { await (window as any).electronAPI.sales.kbAskViewed({ question: askedQuestion, askKey: result.askKey }) } catch { /* 埋点尽力而为 */ }
    }
    setExpanded(v => !v)
  }

  const openEntry = (id: number) => {
    onClose()
    navigate('/knowledge-base', { state: { focusEntryId: id } })
  }

  return (
    <div className="kask-overlay" onClick={onClose}>
      <div className="kask-dialog" onClick={e => e.stopPropagation()}>
        <div className="kask-header">
          <span className="kask-header-icon"><BookOpen size={16} /></span>
          <h3>问知识库</h3>
          <button className="kask-close" onClick={onClose}><X size={16} /></button>
        </div>

        <div className="kask-body">
          <div className="kask-input-row">
            <input
              type="text"
              value={question}
              onChange={e => setQuestion(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') void handleAsk() }}
              placeholder="问一个产品参数、话术或常见问题…"
              autoFocus
            />
            <button className="kask-ask-btn" onClick={handleAsk} disabled={loading || !question.trim()}>
              <Search size={14} />{loading ? '查证中…' : '提问'}
            </button>
          </div>

          {loading && <div className="kask-hint">正在检索已发布知识并生成答案…</div>}

          {result?.status === 'not_configured' && (
            <div className="kask-hint kask-hint-warn">
              <AlertCircle size={14} />先配置模型：设置 → AI 设置 配置后即可问答
            </div>
          )}

          {result?.status === 'no_hit' && (
            <div className="kask-nohit">
              <BookOpen size={28} />
              <p>知识库里没有答案</p>
              <button className="kask-proposal-btn" disabled title="知识提案功能下一版上线（可先在知识库手动补充并发布）">
                <Plus size={14} />生成知识提案
              </button>
            </div>
          )}

          {result?.status === 'error' && (
            <div className="kask-hint kask-hint-warn"><AlertCircle size={14} />问答失败：{result.error}</div>
          )}

          {result?.status === 'answer' && (
            <div className="kask-answer-card">
              <div className="kask-answer-head" onClick={handleExpand}>
                <span className="kask-answer-q">{askedQuestion}</span>
                <span className="kask-answer-toggle">
                  {expanded ? <><span>收起</span><ChevronUp size={14} /></> : <><span>查看答案</span><ChevronDown size={14} /></>}
                </span>
              </div>
              {expanded && (
                <div className="kask-answer-body">
                  <div className="kask-disclaimer">知识答案，仅供参考</div>
                  <p className="kask-answer-text">{result.answer}</p>
                  {(result.citations?.length ?? 0) > 0 && (
                    <div className="kask-citations">
                      <span className="kask-citations-label"><Quote size={11} />引用</span>
                      {result.citations!.map(c => (
                        <button key={c.id} className="kask-citation" onClick={() => openEntry(c.id)} title="点击查看知识库条目">
                          引用自：《{c.title}》（v{c.version}）
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
