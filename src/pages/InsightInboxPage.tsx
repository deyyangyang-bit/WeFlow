import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { CalendarDays, Code, Copy, MessageSquare, RefreshCw, Search, Sparkles, SlidersHorizontal, X } from 'lucide-react'
import { Avatar } from '../components/Avatar'
import type {
  InsightRecord,
  InsightRecordContactFacet,
  InsightRecordFilters,
  InsightRecordListResult,
  InsightRecordSourceType,
  InsightRecordSummary,
  InsightRecordTriggerReason
} from '../types/electron'
import './InsightInboxPage.scss'

type DateFilterMode = 'all' | 'today' | 'week' | 'custom'
type SourceFilterMode = InsightRecordSourceType | 'all'

function getStartOfDay(date: Date): number {
  const next = new Date(date)
  next.setHours(0, 0, 0, 0)
  return next.getTime()
}

function getEndOfDay(date: Date): number {
  const next = new Date(date)
  next.setHours(23, 59, 59, 999)
  return next.getTime()
}

function formatDateInput(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function parseDateInput(value: string, endOfDay = false): number | undefined {
  if (!value) return undefined
  const date = new Date(`${value}T00:00:00`)
  if (Number.isNaN(date.getTime())) return undefined
  return endOfDay ? getEndOfDay(date) : getStartOfDay(date)
}

function formatRecordTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

function formatGroupDate(timestamp: number): string {
  const date = new Date(timestamp)
  const today = new Date()
  const yesterday = new Date()
  yesterday.setDate(today.getDate() - 1)
  if (getStartOfDay(date) === getStartOfDay(today)) return '今天'
  if (getStartOfDay(date) === getStartOfDay(yesterday)) return '昨天'
  return date.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })
}

function getTriggerLabel(reason: InsightRecordTriggerReason): string {
  if (reason === 'message_analysis') return '深度解析'
  if (reason === 'silence') return '沉默提醒'
  if (reason === 'test') return '测试见解'
  if (reason === 'manual') return '手动触发'
  return '活跃分析'
}

function getSourceLabel(sourceType?: InsightRecordSourceType): string {
  return sourceType === 'message_analysis' ? '深度解析' : 'AI 见解'
}

/** 阶段 tag 的语义档（安静 4px 直角 tag，不加大彩条块） */
function getStageTagClass(stage: string): string {
  if (stage === '决策') return 'tag--danger'
  if (stage === '比价') return 'tag--warning'
  if (stage === '了解') return 'tag--task'
  if (stage === '成交') return 'tag--success'
  return 'tag--neutral'
}

function buildLogText(record: InsightRecord): string {
  const log = record.log
  const lines = [
    `时间：${new Date(record.createdAt).toLocaleString('zh-CN')}`,
    `联系人：${record.displayName} (${record.sessionId})`,
    `来源：${getSourceLabel(record.sourceType)}`,
    `触发类型：${getTriggerLabel(record.triggerReason)}`,
    `接口地址：${log.endpoint}`,
    `模型：${log.model}`,
    `Max Tokens：${log.maxTokens}`,
    `Temperature：${log.temperature}`,
    `耗时：${log.durationMs}ms`,
    '',
    '系统提示词：',
    log.systemPrompt,
    '',
    '用户提示词：',
    log.userPrompt,
    '',
    '模型输出原文：',
    log.rawOutput,
    '',
    '最终见解：',
    log.finalInsight
  ]

  if (record.sourceType === 'message_analysis') {
    lines.splice(8, 0,
      `JSON Mode：${log.responseFormatJson ? '启用' : '未启用'}`,
      `JSON Mode 降级：${log.responseFormatFallback ? '是' : '否'}`,
      `降级原因：${log.responseFormatFallbackReason || '无'}`,
      `上下文：请求 ${log.contextStats?.requested ?? log.contextCount} 条，前 ${log.contextStats?.beforeTarget ?? 0} 条，后 ${log.contextStats?.afterTarget ?? 0} 条`,
      `上下文读取异常：${log.contextStats?.readError || '无'}`
    )
    lines.splice(4, 0,
      `目标消息：${record.messageInsight?.targetSenderName || log.targetMessage?.senderName || ''}：${record.messageInsight?.targetTextPreview || log.targetMessage?.textPreview || ''}`,
      `目标定位：localId=${record.messageInsight?.targetLocalId || log.targetMessage?.localId || 0}, createTime=${record.messageInsight?.targetCreateTime || log.targetMessage?.createTime || 0}, key=${record.messageInsight?.targetMessageKey || log.targetMessage?.messageKey || ''}`
    )
  }

  return lines.join('\n')
}

export default function InsightInboxPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()
  const [records, setRecords] = useState<InsightRecordSummary[]>([])
  // 会话 → CRM 客户映射（已入 CRM 徽章 + 查看档案深链）
  const [crmMap, setCrmMap] = useState<Record<string, { id: number; name: string }>>({})
  const [contacts, setContacts] = useState<InsightRecordContactFacet[]>([])
  const [keyword, setKeyword] = useState('')
  const [contactSearch, setContactSearch] = useState('')
  const [selectedSessionId, setSelectedSessionId] = useState('')
  const [sourceType, setSourceType] = useState<SourceFilterMode>('all')
  const [dateMode, setDateMode] = useState<DateFilterMode>('all')
  const [customStart, setCustomStart] = useState(formatDateInput(new Date()))
  const [customEnd, setCustomEnd] = useState(formatDateInput(new Date()))
  const [stats, setStats] = useState({ total: 0, todayCount: 0, unreadCount: 0 })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [focusedRecordId, setFocusedRecordId] = useState(searchParams.get('recordId') || '')
  const [logRecord, setLogRecord] = useState<InsightRecord | null>(null)
  const [message, setMessage] = useState('')

  const dateRange = useMemo(() => {
    const now = new Date()
    if (dateMode === 'today') {
      return { startTime: getStartOfDay(now), endTime: getEndOfDay(now) }
    }
    if (dateMode === 'week') {
      const start = new Date(now)
      start.setDate(now.getDate() - 6)
      return { startTime: getStartOfDay(start), endTime: getEndOfDay(now) }
    }
    if (dateMode === 'custom') {
      return {
        startTime: parseDateInput(customStart),
        endTime: parseDateInput(customEnd, true)
      }
    }
    return {}
  }, [customEnd, customStart, dateMode])

  const filters = useMemo<InsightRecordFilters>(() => ({
    keyword: keyword.trim() || undefined,
    sessionId: selectedSessionId || undefined,
    sourceType,
    startTime: dateRange.startTime,
    endTime: dateRange.endTime,
    limit: 200,
    offset: 0
  }), [dateRange.endTime, dateRange.startTime, keyword, selectedSessionId, sourceType])

  const loadRecords = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const result: InsightRecordListResult = await window.electronAPI.insight.listRecords(filters)
      if (!result.success) {
        setError(result.error || '加载重要提醒失败')
        return
      }
      setRecords(result.records)
      setContacts(result.contacts)
      // 批量查 CRM 映射（失败不阻断列表渲染）
      try {
        const sids = Array.from(new Set((result.records || []).map((r) => r.sessionId).filter(Boolean)))
        if (sids.length) setCrmMap((await window.electronAPI.crm.accountsBySessions(sids)) || {})
      } catch { /* ignore */ }
      setStats({
        total: result.total,
        todayCount: result.todayCount,
        unreadCount: result.unreadCount
      })
    } catch (err) {
      setError((err as Error).message || '加载重要提醒失败')
    } finally {
      setLoading(false)
    }
  }, [filters])

  useEffect(() => {
    void loadRecords()
  }, [loadRecords])

  useEffect(() => {
    const recordId = searchParams.get('recordId') || ''
    if (!recordId) return
    setFocusedRecordId(recordId)
    window.setTimeout(() => {
      document.getElementById(`insight-record-${recordId}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }, 120)
    void window.electronAPI.insight.markRecordRead(recordId)
  }, [searchParams])

  const groupedRecords = useMemo(() => {
    const groups: Array<{ label: string; records: InsightRecordSummary[] }> = []
    for (const record of records) {
      const label = formatGroupDate(record.createdAt)
      const last = groups[groups.length - 1]
      if (last?.label === label) {
        last.records.push(record)
      } else {
        groups.push({ label, records: [record] })
      }
    }
    return groups
  }, [records])

  const filteredContacts = useMemo(() => {
    const normalized = contactSearch.trim().toLowerCase()
    if (!normalized) return contacts
    return contacts.filter((contact) => {
      const text = `${contact.displayName}\n${contact.sessionId}`.toLowerCase()
      return text.includes(normalized)
    })
  }, [contactSearch, contacts])

  const openChat = (record: InsightRecordSummary) => {
    if (record.sourceType === 'message_analysis' && record.messageInsight) {
      const query = new URLSearchParams({
        sessionId: record.sessionId,
        jumpSource: 'messageAnalysis',
        jumpLocalId: String(record.messageInsight.targetLocalId || 0),
        jumpCreateTime: String(record.messageInsight.targetCreateTime || 0)
      })
      navigate(`/chat?${query.toString()}`)
      return
    }
    navigate(`/chat?sessionId=${encodeURIComponent(record.sessionId)}`)
  }

  const copyText = async (text: string, successText: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setMessage(successText)
      window.setTimeout(() => setMessage(''), 1800)
    } catch {
      setMessage('复制失败')
      window.setTimeout(() => setMessage(''), 1800)
    }
  }

  const openLog = async (recordId: string) => {
    const result = await window.electronAPI.insight.getRecord(recordId)
    if (!result.success || !result.record) {
      setMessage(result.error || '读取请求日志失败')
      window.setTimeout(() => setMessage(''), 1800)
      return
    }
    setLogRecord(result.record)
    void window.electronAPI.insight.markRecordRead(recordId)
    setRecords((prev) => prev.map((record) => record.id === recordId ? { ...record, read: true } : record))
  }

  const clearFocusedRecord = () => {
    setFocusedRecordId('')
    searchParams.delete('recordId')
    setSearchParams(searchParams, { replace: true })
  }

  // 逐条已读闭环（既有 insight:markRecordRead 能力，只读展示不改触发链路）
  const markRead = async (recordId: string) => {
    try {
      const result = await window.electronAPI.insight.markRecordRead(recordId)
      if (result.success) {
        setRecords((prev) => prev.map((record) => record.id === recordId ? { ...record, read: true } : record))
      }
    } catch { /* 已读失败不打断浏览，刷新后以存储为准 */ }
  }

  return (
    <div className="insight-inbox-page">
      <section className="insight-inbox-main">
        {/* 页眉（概念稿 .shead）：hero 用既有 unread / today 统计拼句，无新口径；
            右侧 刷新 / 规则设置（跳既有设置页 AI 见解 tab）均为 quiet 档，不造无接口按钮 */}
        <header className="shead insight-inbox-header">
          <div className="insight-inbox-title-block">
            <p className="eyebrow">AI · 重要提醒</p>
            <h1 className="hero insight-inbox-title-line">
              {stats.unreadCount > 0
                ? <><b>{stats.unreadCount}</b> 条提醒未读 · 今天新增 <b>{stats.todayCount}</b> 条</>
                : '暂无未读提醒'}
            </h1>
            <p className="sub">既有规则触发的留存记录 · 每条都能打开对应会话核对</p>
          </div>
          <div className="shead__actions">
            <button
              className="btn btn--quiet"
              onClick={() => navigate('/settings', { state: { initialTab: 'insight', backgroundLocation: location } })}
              title="在设置 · AI 见解中调整触发范围"
            >
              <SlidersHorizontal size={14} /> 规则设置
            </button>
            <button className="btn btn--quiet" onClick={() => { void loadRecords() }} title="刷新">
              <RefreshCw size={14} className={loading ? 'spinning' : ''} /> 刷新
            </button>
          </div>
        </header>

        {/* 状态数字条（概念稿 .stats 四格）：数字只取 listRecords 既有 summary 字段，不加派生口径。
            total 受筛选影响，today/unread 是当前可见范围——副行写清楚，避免读错 */}
        <div className="stats insight-inbox-stats">
          <div className="stat">
            <div className="stat__n">{stats.unreadCount}</div>
            <div className="stat__l">未读</div>
            <div className="stat__d">打开或查看日志即记已读</div>
          </div>
          <div className="stat">
            <div className="stat__n">{stats.todayCount}</div>
            <div className="stat__l">今天新增</div>
            <div className="stat__d">以今日 0 点为界</div>
          </div>
          <div className="stat">
            <div className="stat__n">{contacts.length}</div>
            <div className="stat__l">涉及联系人</div>
            <div className="stat__d">按提醒条数排序</div>
          </div>
          <div className="stat">
            <div className="stat__n">{stats.total}</div>
            <div className="stat__l">当前筛选</div>
            <div className="stat__d">受关键词 / 日期 / 来源筛选影响</div>
          </div>
        </div>

        {focusedRecordId && (
          <div className="insight-focus-bar">
            <Sparkles size={15} />
            <span>已定位这条重要提醒</span>
            <button type="button" onClick={clearFocusedRecord}>取消定位</button>
          </div>
        )}

        <div className="insight-record-scroll">
          {error && (
            <div className="insight-empty-state">
              <span>{error}</span>
              <button onClick={() => { void loadRecords() }}>重试</button>
            </div>
          )}

          {!error && loading && records.length === 0 && (
            <div className="insight-empty-state">
              <RefreshCw size={18} className="spinning" />
              <span>正在加载重要提醒...</span>
            </div>
          )}

          {!error && !loading && records.length === 0 && (
            <div className="insight-empty-state">
              <Sparkles size={36} />
              <strong>暂无重要提醒</strong>
              <span>发现需要及时关注的客户动态时，会在这里提醒你。日常 AI 分析可在客户档案的时间线中查看。</span>
            </div>
          )}

          {groupedRecords.map((group) => (
            <div className="insight-date-group" key={group.label}>
              <div className="insight-date-label">{group.label}</div>
              {group.records.map((record) => (
                <article
                  id={`insight-record-${record.id}`}
                  key={record.id}
                  className={`insight-card ${record.read ? '' : 'unread'} ${focusedRecordId === record.id ? 'focused' : ''}`}
                >
                  <div className="insight-card-content">
                    {/* 状态行：对象（会话）+ 未读标 + 时间 */}
                    <div className="insight-card-header">
                      <div className="insight-recipient">
                        <Avatar src={record.avatarUrl} name={record.displayName} size={24} shape="rounded" />
                        <div className="insight-recipient-text">
                          <span className="insight-recipient-name">
                            {record.displayName}
                            {!record.read && <span className="tag tag--task insight-unread-tag">未读</span>}
                          </span>
                          <span className="insight-session-id num">{record.sessionId}</span>
                        </div>
                      </div>
                      <span className="insight-time num">{formatRecordTime(record.createdAt)}</span>
                    </div>
                    {record.sourceType === 'message_analysis' && record.messageInsight && (
                      <div className="message-analysis-target">
                        <span className="message-analysis-target-label">目标消息</span>
                        <span className="message-analysis-target-text">
                          {record.messageInsight.targetSenderName}：{record.messageInsight.targetTextPreview}
                        </span>
                      </div>
                    )}
                    {/* 说明/正文 */}
                    <p className="insight-body">{record.insight}</p>
                    {record.sourceType === 'message_analysis' && record.messageInsight && (
                      <div className="message-analysis-tags">
                        <span className="tag tag--neutral">情绪：{record.messageInsight.analysis.emotion}</span>
                        <span className="tag tag--neutral">意图：{record.messageInsight.analysis.intent}</span>
                        <span className="tag tag--neutral">话题：{record.messageInsight.analysis.topic}</span>
                      </div>
                    )}
                    {/* 操作区：来源/触发安静 tag + 动作（每条最多一个轻 primary = 打开会话） */}
                    <div className="insight-card-foot">
                      <div className="insight-card-tags">
                        <span className="tag tag--neutral">{getSourceLabel(record.sourceType)}</span>
                        <span className="tag tag--plain">{getTriggerLabel(record.triggerReason)}</span>
                        {record.salesStage && (
                          <span className={`tag ${getStageTagClass(record.salesStage)}`}>{record.salesStage}</span>
                        )}
                      </div>
                      <div className="insight-card-actions">
                        <button className="btn btn--primary-soft btn--sm" onClick={() => openChat(record)} title="打开对应会话核对">
                          <MessageSquare size={13} /> 打开会话
                        </button>
                        {!record.read && (
                          <button className="btn btn--quiet btn--sm" onClick={() => { void markRead(record.id) }}>
                            标为已读
                          </button>
                        )}
                        {crmMap[record.sessionId] && (
                          <button
                            className="btn btn--quiet btn--sm"
                            onClick={() => navigate(`/customers?id=${crmMap[record.sessionId].id}`)}
                            title={`已在 CRM：${crmMap[record.sessionId].name} · 查看档案`}
                          >
                            查看档案
                          </button>
                        )}
                        <button className="btn btn--quiet btn--sm" onClick={() => { void copyText(record.insight, '提醒内容已复制') }}>
                          <Copy size={13} /> 复制
                        </button>
                        <button className="btn btn--quiet btn--sm" onClick={() => { void openLog(record.id) }}>
                          <Code size={13} /> 请求日志
                        </button>
                      </div>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          ))}
        </div>
      </section>

      <aside className="insight-filter-panel">
        <div className="insight-filter-header">
          <h3>筛选条件</h3>
        </div>

        <div className="insight-filter-widget">
          <div className="insight-widget-title">
            <Search size={14} />
            <span>关键词搜索</span>
          </div>
          <div className="insight-input-wrap">
            <input
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              placeholder="搜索提醒或联系人..."
            />
            {keyword && <button onClick={() => setKeyword('')}><X size={14} /></button>}
          </div>
        </div>

        <div className="insight-filter-widget">
          <div className="insight-widget-title">
            <Sparkles size={14} />
            <span>来源类型</span>
          </div>
          <div className="insight-source-tabs">
            {[
              { value: 'all', label: '全部' },
              { value: 'insight', label: 'AI 见解' },
              { value: 'message_analysis', label: '深度解析' }
            ].map((option) => (
              <button
                key={option.value}
                className={sourceType === option.value ? 'active' : ''}
                onClick={() => setSourceType(option.value as SourceFilterMode)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        <div className="insight-filter-widget">
          <div className="insight-widget-title">
            <CalendarDays size={14} />
            <span>日期范围</span>
          </div>
          <div className="insight-date-tabs">
            {[
              { value: 'all', label: '全部' },
              { value: 'today', label: '今天' },
              { value: 'week', label: '近 7 天' },
              { value: 'custom', label: '自定义' }
            ].map((option) => (
              <button
                key={option.value}
                className={dateMode === option.value ? 'active' : ''}
                onClick={() => setDateMode(option.value as DateFilterMode)}
              >
                {option.label}
              </button>
            ))}
          </div>
          {dateMode === 'custom' && (
            <div className="insight-custom-dates">
              <input type="date" value={customStart} onChange={(event) => setCustomStart(event.target.value)} />
              <input type="date" value={customEnd} onChange={(event) => setCustomEnd(event.target.value)} />
            </div>
          )}
        </div>

        <div className="insight-filter-widget contact-filter">
          <div className="insight-widget-title">
            <MessageSquare size={14} />
            <span>聊天对象</span>
            <span className="insight-widget-count">{contacts.length}</span>
          </div>
          <div className="insight-input-wrap">
            <input
              value={contactSearch}
              onChange={(event) => setContactSearch(event.target.value)}
              placeholder="查找联系人..."
            />
            {contactSearch && <button onClick={() => setContactSearch('')}><X size={14} /></button>}
          </div>
          <button
            className={`insight-contact-row all ${selectedSessionId ? '' : 'active'}`}
            onClick={() => setSelectedSessionId('')}
          >
            <span>全部联系人</span>
            <strong>{contacts.reduce((sum, contact) => sum + contact.count, 0)}</strong>
          </button>
          <div className="insight-contact-list">
            {filteredContacts.map((contact) => (
              <button
                key={contact.sessionId}
                className={`insight-contact-row ${selectedSessionId === contact.sessionId ? 'active' : ''}`}
                onClick={() => setSelectedSessionId(contact.sessionId)}
              >
                <Avatar src={contact.avatarUrl} name={contact.displayName} size={32} shape="rounded" />
                <span>{contact.displayName}</span>
                <strong>{contact.count}</strong>
              </button>
            ))}
          </div>
        </div>
      </aside>

      {logRecord && (
        <div className="insight-modal-overlay" onClick={() => setLogRecord(null)}>
          <div className="insight-log-dialog" onClick={(event) => event.stopPropagation()}>
            <div className="insight-log-header">
              <div>
                <h3>请求日志</h3>
                <span>{logRecord.displayName} · {formatRecordTime(logRecord.createdAt)}</span>
              </div>
              <div className="insight-log-actions">
                <button onClick={() => { void copyText(buildLogText(logRecord), '请求日志已复制') }}>
                  <Copy size={15} />
                  复制
                </button>
                <button className="close" onClick={() => setLogRecord(null)}>
                  <X size={18} />
                </button>
              </div>
            </div>
            <div className="insight-log-body">
              <section>
                <h4>请求参数</h4>
                <pre>{[
                  `Endpoint: ${logRecord.log.endpoint}`,
                  `Model: ${logRecord.log.model}`,
                  `Max Tokens: ${logRecord.log.maxTokens}`,
                  `Temperature: ${logRecord.log.temperature}`,
                  `Duration: ${logRecord.log.durationMs}ms`,
                  `Source: ${getSourceLabel(logRecord.sourceType)}`,
                  `Trigger: ${getTriggerLabel(logRecord.triggerReason)}`,
                  ...(logRecord.sourceType === 'message_analysis'
                    ? [
                        `JSON Mode: ${logRecord.log.responseFormatJson ? 'enabled' : 'disabled'}`,
                        `JSON Fallback: ${logRecord.log.responseFormatFallback ? 'yes' : 'no'}`,
                        `Fallback Reason: ${logRecord.log.responseFormatFallbackReason || 'none'}`
                      ]
                    : [])
                ].join('\n')}</pre>
              </section>
              {logRecord.sourceType === 'message_analysis' && (
                <section>
                  <h4>深度解析目标</h4>
                  <pre>{[
                    `Sender: ${logRecord.messageInsight?.targetSenderName || logRecord.log.targetMessage?.senderName || ''}`,
                    `Preview: ${logRecord.messageInsight?.targetTextPreview || logRecord.log.targetMessage?.textPreview || ''}`,
                    `LocalId: ${logRecord.messageInsight?.targetLocalId || logRecord.log.targetMessage?.localId || 0}`,
                    `CreateTime: ${logRecord.messageInsight?.targetCreateTime || logRecord.log.targetMessage?.createTime || 0}`,
                    `MessageKey: ${logRecord.messageInsight?.targetMessageKey || logRecord.log.targetMessage?.messageKey || ''}`,
                    `Context Requested: ${logRecord.log.contextStats?.requested ?? logRecord.log.contextCount}`,
                    `Context Before: ${logRecord.log.contextStats?.beforeTarget ?? 0}`,
                    `Context After: ${logRecord.log.contextStats?.afterTarget ?? 0}`,
                    `Context Error: ${logRecord.log.contextStats?.readError || 'none'}`
                  ].join('\n')}</pre>
                </section>
              )}
              {logRecord.sourceType === 'message_analysis' && logRecord.log.parsedAnalysis && (
                <section>
                  <h4>解析字段</h4>
                  <pre>{[
                    `explicitText: ${logRecord.log.parsedAnalysis.explicitText}`,
                    `emotion: ${logRecord.log.parsedAnalysis.emotion}`,
                    `intent: ${logRecord.log.parsedAnalysis.intent}`,
                    `topic: ${logRecord.log.parsedAnalysis.topic}`
                  ].join('\n')}</pre>
                </section>
              )}
              <section>
                <h4>System Prompt</h4>
                <pre>{logRecord.log.systemPrompt}</pre>
              </section>
              <section>
                <h4>User Prompt</h4>
                <pre>{logRecord.log.userPrompt}</pre>
              </section>
              <section>
                <h4>模型输出</h4>
                <pre>{logRecord.log.rawOutput}</pre>
              </section>
              <section>
                <h4>最终见解</h4>
                <pre>{logRecord.log.finalInsight}</pre>
              </section>
            </div>
          </div>
        </div>
      )}

      {/* 复制/读取反馈：走全局 .toast（本页只补 z-index，需盖在请求日志弹层之上） */}
      {message && <div className="toast insight-copy-toast" role="status" aria-live="polite">{message}</div>}
    </div>
  )
}
