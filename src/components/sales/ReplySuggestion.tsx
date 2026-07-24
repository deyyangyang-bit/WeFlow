/**
 * ReplySuggestion.tsx
 *
 * 智能回复建议浮动面板。
 * 在聊天消息区域右下角显示一个按钮，点击后调用 AI 生成回复建议。
 * 用户可一键复制到剪贴板。
 */

import React, { useState, useCallback } from 'react'
import { MessageSquareText, X, Copy, Check, Loader2, RefreshCw } from 'lucide-react'
import './ReplySuggestion.scss'

interface ReplySuggestionProps {
  sessionId: string
}

export default function ReplySuggestion({ sessionId }: ReplySuggestionProps) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null)

  const fetchSuggestions = useCallback(async () => {
    setLoading(true)
    setError(null)
    setSuggestions([])
    try {
      const result = await window.electronAPI.sales.replySuggest({
        session_id: sessionId,
        context_messages: []
      })
      if (result.success && result.suggestions) {
        setSuggestions(result.suggestions)
      } else {
        setError(result.error || '生成失败')
      }
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [sessionId])

  const handleCopy = useCallback(async (text: string, index: number) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedIndex(index)
      setTimeout(() => setCopiedIndex(null), 2000)
    } catch {
      // fallback
      const textarea = document.createElement('textarea')
      textarea.value = text
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand('copy')
      document.body.removeChild(textarea)
      setCopiedIndex(index)
      setTimeout(() => setCopiedIndex(null), 2000)
    }
  }, [])

  const handleToggle = useCallback(() => {
    if (!open) {
      setOpen(true)
      if (suggestions.length === 0 && !loading) {
        fetchSuggestions()
      }
    } else {
      setOpen(false)
    }
  }, [open, suggestions.length, loading, fetchSuggestions])

  return (
    <div className="reply-suggestion">
      {/* 浮动按钮 */}
      <button
        className={`rs-fab ${open ? 'active' : ''}`}
        onClick={handleToggle}
        title="AI 回复建议"
      >
        <MessageSquareText size={18} />
      </button>

      {/* 面板 */}
      {open && (
        <div className="rs-panel">
          <div className="rs-panel-header">
            <span className="rs-panel-title">AI 回复建议</span>
            <div className="rs-panel-actions">
              <button
                className="rs-refresh-btn"
                onClick={fetchSuggestions}
                disabled={loading}
                title="重新生成"
              >
                <RefreshCw size={13} className={loading ? 'spin' : ''} />
              </button>
              <button className="rs-close-btn" onClick={() => setOpen(false)}>
                <X size={14} />
              </button>
            </div>
          </div>

          <div className="rs-panel-body">
            {loading && (
              <div className="rs-loading">
                <Loader2 size={16} className="spin" />
                <span>正在生成回复建议...</span>
              </div>
            )}

            {error && !loading && (
              <div className="rs-error">{error}</div>
            )}

            {!loading && !error && suggestions.length > 0 && (
              <div className="rs-list">
                {suggestions.map((text, i) => (
                  <div key={i} className="rs-item">
                    <div className="rs-item-text">{text}</div>
                    <button
                      className="rs-copy-btn"
                      onClick={() => handleCopy(text, i)}
                      title="复制"
                    >
                      {copiedIndex === i ? <Check size={12} /> : <Copy size={12} />}
                      {copiedIndex === i ? '已复制' : '复制'}
                    </button>
                  </div>
                ))}
              </div>
            )}

            {!loading && !error && suggestions.length === 0 && (
              <div className="rs-empty">暂无建议</div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
