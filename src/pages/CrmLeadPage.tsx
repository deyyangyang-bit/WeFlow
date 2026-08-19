/**
 * CrmLeadPage.tsx —— 线索池（单机线索流转）
 * 导入（Excel/CSV/文本粘贴）→ 线索池列表（状态/来源/超时筛选）→ 首触 SLA → 转客户。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Inbox, Upload, RefreshCw, ClipboardPaste, Phone, MessageCircle, UserPlus, X, FileSpreadsheet, AlertTriangle } from 'lucide-react'
import * as XLSX from 'exceljs'
import type { LeadRow } from '../types/electron'
import { getCrmLeadSourcePreset } from '../services/config'
import './CrmLeadPage.scss'

const PRESET_SOURCES = ['抖音', '视频号', '小红书']
const STATUS_META: Record<string, { label: string; cls: string }> = {
  NEW: { label: '待首触', cls: 'st-new' },
  CONTACTED: { label: '已首触', cls: 'st-contacted' },
  WX_ADDED: { label: '已加微信', cls: 'st-wx' },
  DEAD: { label: '已失效', cls: 'st-dead' },
  ACCOUNT: { label: '已转客户', cls: 'st-account' }
}
const CHANNELS = ['PHONE', 'WECHAT', 'SMS']
const CHANNEL_META: Record<string, string> = { PHONE: '电话', WECHAT: '微信', SMS: '短信' }
const PAGE_SIZE = 50

interface RawRow { text?: string; phone?: string; wechat?: string; name?: string; tag?: string; note?: string }

function fmtTime(ts?: number): string {
  if (!ts) return '-'
  const d = new Date(Number(ts))
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function fmtOverdue(deadline: number): string {
  const h = Math.max(1, Math.floor((Date.now() - Number(deadline)) / 3600_000))
  return h < 24 ? `${h}小时` : `${Math.floor(h / 24)}天${h % 24}小时`
}

function maskLead(lead: { contact_type: string; contact_normalized: string }): string {
  const v = String(lead.contact_normalized || '')
  if (lead.contact_type === 'phone') return v.length === 11 ? `${v.slice(0, 3)}****${v.slice(-4)}` : v
  return v.length >= 4 ? `${v.slice(0, 2)}***${v.slice(-1)}` : v
}

/** Excel/CSV 矩阵 → 行对象：识别表头（phone/wechat/姓名/标签/备注），其余列并入 text */
function matrixToRows(matrix: unknown[][]): RawRow[] {
  const headers = (matrix[0] || []).map((c) => String(c ?? '').trim().toLowerCase())
  const colOf = (names: string[]) => headers.findIndex((h) => names.includes(h))
  const iPhone = colOf(['phone', '手机号', '手机', '电话', '联系电话', '手机号码'])
  const iWechat = colOf(['wechat', '微信', '微信号', 'vx', 'wx'])
  const iName = colOf(['name', '姓名', '客户', '名字'])
  const iTag = colOf(['tag', '标签', '需求', '意向'])
  const iNote = colOf(['note', '备注', '说明'])
  const hasHeader = iPhone >= 0 || iWechat >= 0 || iName >= 0
  const named = [iPhone, iWechat, iName, iTag, iNote].filter((i) => i >= 0)
  const rows: RawRow[] = []
  for (let r = 0; r < matrix.length; r++) {
    const cells = matrix[r].map((c) => String(c ?? '').trim())
    if (cells.every((c) => !c)) continue
    if (hasHeader && r === 0) continue
    const row: RawRow = {}
    if (iPhone >= 0 && cells[iPhone]) row.phone = cells[iPhone]
    if (iWechat >= 0 && cells[iWechat]) row.wechat = cells[iWechat]
    if (iName >= 0 && cells[iName]) row.name = cells[iName]
    if (iTag >= 0 && cells[iTag]) row.tag = cells[iTag]
    if (iNote >= 0 && cells[iNote]) row.note = cells[iNote]
    const rest = cells.filter((_, i) => !named.includes(i) && cells[i])
    const text = [...(row.phone ? [row.phone] : []), ...(row.wechat ? [`微信${row.wechat}`] : []), ...(row.name ? [row.name] : []), ...rest].join(' ')
    row.text = hasHeader ? text : cells.join(' ')
    if (!row.phone && !row.wechat && !row.name && !text.trim()) continue
    rows.push(row)
  }
  return rows
}

function parsePasteText(text: string): RawRow[] {
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((line) => {
    const cells = line.split(/\t|,/).map((c) => c.trim()).filter(Boolean)
    return { text: cells.join(' ') }
  })
}

export default function CrmLeadPage() {
  const [leads, setLeads] = useState<LeadRow[]>([])
  const [overview, setOverview] = useState<{ total: number; overdue: number; todayImported: number; todayContacted: number; pendingSla: number; byStatus: Record<string, number>; sources: Array<{ source: string; count: number }> } | null>(null)
  const [search, setSearch] = useState('')
  const [statusChip, setStatusChip] = useState('全部')
  const [sourceChip, setSourceChip] = useState('全部')
  const [notice, setNotice] = useState('')
  const [showImport, setShowImport] = useState(false)
  const [importTab, setImportTab] = useState<'file' | 'paste'>('paste')
  const [presetSources, setPresetSources] = useState<string[]>(PRESET_SOURCES)
  const [importSource, setImportSource] = useState(PRESET_SOURCES[0])
  const [customSource, setCustomSource] = useState('')
  const [rows, setRows] = useState<RawRow[]>([])
  const [fileName, setFileName] = useState('')
  const [detail, setDetail] = useState<{ lead: LeadRow; activities: Array<{ action: string; note?: string; created_at: number }> } | null>(null)
  const [deadLead, setDeadLead] = useState<LeadRow | null>(null)
  const [deadReason, setDeadReason] = useState('')
  const [page, setPage] = useState(1)
  const fileRef = useRef<HTMLInputElement>(null)

  const fetchAll = async () => {
    const [ls, ov] = await Promise.all([window.electronAPI.crm.leadList({ limit: 10000 }), window.electronAPI.crm.leadOverview()])
    setLeads(ls || [])
    setOverview(ov || null)
  }
  useEffect(() => { void fetchAll() }, [])
  // 来源预设与设置页联动
  useEffect(() => {
    void getCrmLeadSourcePreset().then((sources) => {
      if (sources.length) { setPresetSources(sources); setImportSource(sources[0]) }
    })
  }, [])
  useEffect(() => { if (notice) { const t = setTimeout(() => setNotice(''), 5000); return () => clearTimeout(t) } }, [notice])

  const statusChips = useMemo(() => {
    const n = (s: string) => overview?.byStatus[s] ?? 0
    return [
      { value: '全部', label: '全部', count: overview?.total ?? 0 },
      { value: 'NEW', label: STATUS_META.NEW.label, count: n('NEW') },
      { value: 'CONTACTED', label: STATUS_META.CONTACTED.label, count: n('CONTACTED') },
      { value: 'WX_ADDED', label: STATUS_META.WX_ADDED.label, count: n('WX_ADDED') },
      { value: 'DEAD', label: STATUS_META.DEAD.label, count: n('DEAD') },
      { value: 'ACCOUNT', label: STATUS_META.ACCOUNT.label, count: n('ACCOUNT') }
    ]
  }, [overview])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return leads.filter((l) => {
      if (statusChip !== '全部' && l.status !== statusChip) return false
      if (sourceChip !== '全部' && String(l.source) !== sourceChip) return false
      if (!q) return true
      return [l.name, l.contact_normalized, l.tag, l.source].some((v) => String(v || '').toLowerCase().includes(q))
    })
  }, [leads, search, statusChip, sourceChip])
  // 前端分页：筛选后切片，page 越界自动收敛到最后一页
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const curPage = Math.min(page, totalPages)
  const pageItems = filtered.slice((curPage - 1) * PAGE_SIZE, curPage * PAGE_SIZE)

  const doRefresh = async () => { await window.electronAPI.crm.leadScanSla(); await fetchAll(); setNotice('已检查，超时未首触的线索已加入今日行动提醒') }

  const pickFile = async (file: File) => {
    setFileName(file.name)
    const isCsv = /\.csv$/i.test(file.name)
    if (isCsv) {
      const text = await file.text()
      setRows(parsePasteText(text))
      return
    }
    const buf = await file.arrayBuffer()
    const wb = new XLSX.Workbook()
    await wb.xlsx.load(buf)
    const ws = wb.worksheets[0]
    if (!ws) { setRows([]); return }
    const matrix: unknown[][] = []
    ws.eachRow((row) => { matrix.push(Array.isArray(row.values) ? (row.values as unknown[]).slice(1) : []) })
    setRows(matrixToRows(matrix))
  }

  const doImport = async () => {
    if (!rows.length) { setNotice('请先选择文件或粘贴文本'); return }
    const src = customSource.trim() || importSource
    const res = await window.electronAPI.crm.leadImport(src, fileName || '文本粘贴', rows)
    setShowImport(false); setRows([]); setFileName('')
    setNotice(`导入完成：新增 ${res.valid} 条，重复 ${res.duplicate} 条${res.invalid ? `，无效 ${res.invalid} 条（已跳过）` : ''}`)
    await fetchAll()
  }

  const act = async (id: number, action: 'contacted' | 'wx_added' | 'dead' | 'reopen', opts?: { channel?: string; reason?: string; note?: string }) => {
    const r = await window.electronAPI.crm.leadStatus(id, action, opts)
    if (!r.ok) { setNotice(r.error || '操作失败'); return }
    await fetchAll()
    if (detail?.lead.id === id) await openDetail(id)
  }
  const openDetail = async (id: number) => {
    const d = await window.electronAPI.crm.leadDetail(id)
    if (d.lead) setDetail({ lead: d.lead, activities: (d.activities || []) as any })
  }
  const toAccount = async (id: number) => {
    const r = await window.electronAPI.crm.leadToAccount(id)
    setNotice(r.ok ? (r.existed ? '已关联到已有客户' : `已转为客户 #${r.accountId}`) : r.error || '转客户失败')
    await fetchAll()
  }
  const confirmDead = async () => {
    if (!deadLead || !deadReason) return
    await act(deadLead.id, 'dead', { reason: deadReason })
    setDeadLead(null); setDeadReason('')
  }

  const ov = overview
  return (
    <div className="crm-lead-page">
      <div className="crm-header">
        <h2><Inbox size={18} /> 线索池 <span className="count">共 {ov?.total ?? 0} 条</span></h2>
        <button className="crm-btn" onClick={doRefresh} title="重新检查线索的首触截止时间，超时未联系的会加入今日行动提醒"><RefreshCw size={14} /> 检查超时</button>
        <button className="crm-btn primary" onClick={() => setShowImport(true)}><Upload size={14} /> 导入线索</button>
      </div>
      {notice && <div className="crm-notice">{notice}</div>}

      {ov && (
        <div className="lead-cards">
          <div className={`lead-card ${ov.overdue > 0 ? 'warn' : ''}`}><div className="lc-num">{ov.overdue}</div><div className="lc-label">超时未首触</div></div>
          <div className="lead-card"><div className="lc-num">{ov.pendingSla}</div><div className="lc-label">今日待处理</div></div>
          <div className="lead-card"><div className="lc-num">{ov.todayImported}</div><div className="lc-label">今日导入</div></div>
          <div className="lead-card"><div className="lc-num">{ov.todayContacted}</div><div className="lc-label">今日首触</div></div>
        </div>
      )}

      <div className="crm-filterbar">
        <input className="crm-search" placeholder="搜索姓名 / 联系方式 / 标签 / 来源" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1) }} />
        <div className="crm-chips">
          {statusChips.map((c) => (
            <button key={c.value} className={`chip ${statusChip === c.value ? 'active' : ''}`} onClick={() => { setStatusChip(c.value); setPage(1) }}>{c.label} ({c.count})</button>
          ))}
        </div>
        {ov && ov.sources.length > 0 && (
          <div className="crm-chips src">
            <button className={`chip ${sourceChip === '全部' ? 'active' : ''}`} onClick={() => { setSourceChip('全部'); setPage(1) }}>全部来源</button>
            {ov.sources.map((s) => (
              <button key={s.source} className={`chip ${sourceChip === s.source ? 'active' : ''}`} onClick={() => { setSourceChip(s.source); setPage(1) }}>{s.source} ({s.count})</button>
            ))}
          </div>
        )}
      </div>

      <table className="crm-table">
        <thead><tr><th>状态</th><th>联系方式</th><th>姓名 / 标签</th><th>来源</th><th>首触期限</th><th>操作</th></tr></thead>
        <tbody>
          {pageItems.map((l) => {
            const isOverdue = l.status === 'NEW' && Number(l.first_contact_deadline) > 0 && Number(l.first_contact_deadline) < Date.now()
            const meta = STATUS_META[l.status] || { label: l.status, cls: '' }
            return (
              <tr key={l.id} onClick={() => void openDetail(l.id)}>
                <td><span className={`lead-st ${meta.cls}`}>{meta.label}</span></td>
                <td>
                  <div className="lc-contact">{maskLead(l)} {l.wechat && <span className="lc-wechat">微信:{l.wechat}</span>}</div>
                  <div className="psub">{l.contact_type === 'wechat' ? '微信号' : l.contact_type === 'both' ? '手机+微信' : '手机号'}</div>
                </td>
                <td>
                  <div className="pname">{l.name || '未命名'}</div>
                  {l.tag && <div className="psub">{l.tag}</div>}
                </td>
                <td><span className="lc-source">{l.source}</span></td>
                <td onClick={(e) => e.stopPropagation()}>
                  {isOverdue
                    ? <span className="lc-overdue"><AlertTriangle size={12} /> 超时 {fmtOverdue(Number(l.first_contact_deadline))}</span>
                    : <div className="lc-deadline">{fmtTime(Number(l.first_contact_deadline))}{l.status === 'NEW' ? ' 首触' : ''}</div>}
                </td>
                <td className="ops" onClick={(e) => e.stopPropagation()}>
                  {l.status === 'NEW' && (
                    <>
                      <button className="crm-btn" title="已电话首触" onClick={() => void act(l.id, 'contacted', { channel: 'PHONE' })}><Phone size={13} /></button>
                      <button className="crm-btn" title="已加微信" onClick={() => void act(l.id, 'wx_added')}><MessageCircle size={13} /></button>
                      <button className="crm-btn" title="转客户" onClick={() => void toAccount(l.id)}><UserPlus size={13} /></button>
                    </>
                  )}
                  {l.status === 'DEAD' && (
                    <button className="crm-btn" title="重新跟进" onClick={() => void act(l.id, 'reopen')}><RefreshCw size={13} /></button>
                  )}
                  {l.status === 'NEW' && <button className="crm-btn danger" title="标记失效" onClick={() => { setDeadLead(l); setDeadReason('') }}><X size={13} /></button>}
                </td>
              </tr>
            )
          })}
          {filtered.length === 0 && <tr><td colSpan={6} className="empty">暂无线索，点击右上角「导入线索」开始</td></tr>}
        </tbody>
      </table>

      {filtered.length > PAGE_SIZE && (
        <div className="crm-pager">
          <button className="crm-btn" disabled={curPage <= 1} onClick={() => setPage(curPage - 1)}>上一页</button>
          <span className="crm-pager-info">第 {curPage} / {totalPages} 页 · 共 {filtered.length} 条</span>
          <button className="crm-btn" disabled={curPage >= totalPages} onClick={() => setPage(curPage + 1)}>下一页</button>
        </div>
      )}

      {showImport && (
        <div className="crm-modal" onClick={() => setShowImport(false)}>
          <div className="crm-modal-body lead-import" onClick={(e) => e.stopPropagation()}>
            <h3><Upload size={15} /> 导入线索 <button className="crm-btn" onClick={() => setShowImport(false)}><X size={14} /></button></h3>
            <div className="form-grid">
              <label>来源
                <select value={importSource} onChange={(e) => { setImportSource(e.target.value); setCustomSource('') }}>
                  {presetSources.map((s) => <option key={s}>{s}</option>)}
                  <option value="__custom">自定义…</option>
                </select>
              </label>
              {importSource === '__custom' && <label>自定义来源 <input placeholder="如：百度推广 / 线下展会" value={customSource} onChange={(e) => setCustomSource(e.target.value)} /></label>}
              <label>方式
                <select value={importTab} onChange={(e) => setImportTab(e.target.value as 'file' | 'paste')}>
                  <option value="paste">文本粘贴（一行一条）</option>
                  <option value="file">Excel / CSV 文件</option>
                </select>
              </label>
            </div>
            {importTab === 'file' ? (
              <div className="lead-file">
                <button className="crm-btn" onClick={() => fileRef.current?.click()}><FileSpreadsheet size={14} /> 选择文件</button>
                <input ref={fileRef} type="file" accept=".xlsx,.csv" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void pickFile(f); e.target.value = '' }} />
                <span className="lc-filename">{fileName || '支持 .xlsx / .csv，表头可含：手机号 / 微信 / 姓名 / 标签 / 备注'}</span>
              </div>
            ) : (
              <textarea className="lead-paste" rows={6} placeholder={'示例：\n张三 13800138000 微信kevin_x 求2T叉车\n李四 13900139000\n王五 加微信 wangwu_88 询价\n每行一条，手机号/微信号会自动识别'} onChange={(e) => { setRows(parsePasteText(e.target.value)); setFileName('') }} />
            )}
            <div className="lead-preview">已识别 {rows.length} 行{rows.length ? '，点击导入将写入线索池（重复号码自动跳过）' : ''}</div>
            <div className="form-actions">
              <button className="crm-btn primary" disabled={!rows.length} onClick={() => void doImport()}><ClipboardPaste size={14} /> 导入</button>
            </div>
          </div>
        </div>
      )}

      {detail && (
        <div className="crm-modal" onClick={() => setDetail(null)}>
          <div className="crm-modal-body lead-detail" onClick={(e) => e.stopPropagation()}>
            <h3>线索详情 <button className="crm-btn" onClick={() => setDetail(null)}><X size={14} /></button></h3>
            <div className="lead-detail-grid">
              <div><label>联系方式</label><div className="ld-strong">{detail.lead.contact_raw || detail.lead.contact_normalized}</div></div>
              <div><label>类型</label><div>{detail.lead.contact_type === 'wechat' ? '微信号' : detail.lead.contact_type === 'both' ? '手机号 + 微信' : '手机号'}{detail.lead.wechat ? `（微信 ${detail.lead.wechat}）` : ''}</div></div>
              <div><label>姓名</label><div>{detail.lead.name || '未命名'}</div></div>
              <div><label>来源</label><div>{detail.lead.source}</div></div>
              <div><label>标签</label><div>{detail.lead.tag || '-'}</div></div>
              <div><label>状态</label><div>{(STATUS_META[detail.lead.status] || { label: detail.lead.status }).label}{detail.lead.status === 'DEAD' && detail.lead.dead_reason ? `（${detail.lead.dead_reason}）` : ''}</div></div>
              <div><label>导入时间</label><div>{fmtTime(detail.lead.created_at)}</div></div>
              <div><label>首触期限</label><div>{fmtTime(Number(detail.lead.first_contact_deadline))}{detail.lead.first_contacted_at ? `，已首触 ${fmtTime(Number(detail.lead.first_contacted_at))}（${CHANNEL_META[detail.lead.first_contact_channel ?? ''] || detail.lead.first_contact_channel || '电话'}）` : ''}</div></div>
              <div className="ld-note"><label>备注</label><div>{detail.lead.note || '-'}</div></div>
            </div>
            {detail.lead.status === 'NEW' && (
              <div className="lead-actions">
                <label>首触渠道
                  <select defaultValue="PHONE" id="contact-channel">
                    {CHANNELS.map((c) => <option key={c}>{c}</option>)}
                  </select>
                </label>
                <button className="crm-btn" onClick={() => void act(detail.lead.id, 'contacted', { channel: (document.getElementById('contact-channel') as HTMLSelectElement)?.value || 'PHONE' })}><Phone size={14} /> 完成首触</button>
                <button className="crm-btn" onClick={() => void act(detail.lead.id, 'wx_added')}><MessageCircle size={14} /> 已加微信</button>
                <button className="crm-btn primary" onClick={() => void toAccount(detail.lead.id)}><UserPlus size={14} /> 转客户</button>
              </div>
            )}
            <h4>跟进流水</h4>
            <div className="lead-timeline">
              {detail.activities.map((a, i) => (
                <div key={i} className="lt-item"><span className="lt-time">{fmtTime(a.created_at)}</span><span className="lt-act">{a.action}</span><span className="lt-note">{a.note || ''}</span></div>
              ))}
              {detail.activities.length === 0 && <div className="empty">暂无流水</div>}
            </div>
          </div>
        </div>
      )}

      {deadLead && (
        <div className="crm-modal" onClick={() => setDeadLead(null)}>
          <div className="crm-modal-body lead-dead" onClick={(e) => e.stopPropagation()}>
            <h3>标记失效 <button className="crm-btn" onClick={() => setDeadLead(null)}><X size={14} /></button></h3>
            <p className="ld-tip">线索 {maskLead(deadLead)} 将标记为失效，之后仍可「重新跟进」。</p>
            <label>死因 <select value={deadReason} onChange={(e) => setDeadReason(e.target.value)}>
              <option value="">请选择死因</option>
              {['号码无效', '重复留资', '明确不要', '同行', '非目标客户', '已购车', '联系不上', '其他'].map((r) => <option key={r}>{r}</option>)}
            </select></label>
            <div className="form-actions"><button className="crm-btn danger" disabled={!deadReason} onClick={() => void confirmDead()}>确认失效</button></div>
          </div>
        </div>
      )}
    </div>
  )
}
