/**
 * CrmProductPage.tsx —— 产品库（v8.1）：分类规格模版 + 三档价 + 变体 + AI 提取/描述
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Package, Upload, Plus, RefreshCw, Copy, Sparkles, Pencil, X, Tags, ImagePlus, Trash2 } from 'lucide-react'
import * as XLSX from 'exceljs'
import { useCrmStore } from '../stores/crmStore'
import { mapProductMatrix } from '../utils/productImportMapper'
import './CrmProductPage.scss'

export const SPEC_TEMPLATES: Record<string, string[]> = {
  手动改装套件: ['一体杆型号', '电池', '使用时间', '电机功率', '爬坡能力', '油缸起升行程', '自重', '适配车架'],
  电动整车: ['叉车型号', '货叉宽度', '货叉长度', '电池易换', '电池', '工作时长', '电机功率', '爬坡能力', '自重'],
  外调车型: ['主要功能', '额定载荷', '车身尺寸', '电池配置', '门架定制']
}
const PRESET_CATS = Object.keys(SPEC_TEMPLATES)

interface ProductRow { [k: string]: any }

export default function CrmProductPage() {
  const { products, fetchProducts, notice, setNotice } = useCrmStore()
  const [search, setSearch] = useState('')
  const [chip, setChip] = useState('全部')
  const [editMode, setEditMode] = useState(false)
  const [selected, setSelected] = useState<number[]>([])
  const [showNew, setShowNew] = useState(false)
  const [specsEdit, setSpecsEdit] = useState<ProductRow | null>(null)
  const [specsForm, setSpecsForm] = useState<Record<string, string>>({})
  const [imgCache, setImgCache] = useState<Record<number, string>>({})
  const fileRef = useRef<HTMLInputElement>(null)

  const emptyForm = { category: PRESET_CATS[0], name: '', sku: '', model: '', unit_price: '', cost_price: '', reference_price: '', moq: '1', material: '', image_path: '', specs: {} as Record<string, string> }
  const [form, setForm] = useState(emptyForm)
  const [aiImg, setAiImg] = useState<string>('') // dataUrl for AI extract
  const aiFileRef = useRef<HTMLInputElement>(null)
  const imgFileRef = useRef<HTMLInputElement>(null)
  const imgTargetRef = useRef(0) // 当前要换图的产品 id

  useEffect(() => { void fetchProducts() }, [fetchProducts])

  // 缩略图懒加载
  useEffect(() => {
    for (const p of products) {
      if (p.image_path && !imgCache[p.id]) {
        void window.electronAPI.crm.readImage(String(p.image_path)).then((d) => {
          if (d) setImgCache((c) => ({ ...c, [p.id]: d }))
        })
      }
    }
  }, [products, imgCache])

  const chips = useMemo(() => {
    const counts = new Map<string, number>()
    for (const p of products) counts.set(String(p.category || '未分类'), (counts.get(String(p.category || '未分类')) ?? 0) + 1)
    return [{ name: '全部', count: products.length }, ...[...counts.entries()].map(([name, count]) => ({ name, count }))]
  }, [products])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return products.filter((p) => {
      if (chip !== '全部' && String(p.category || '未分类') !== chip) return false
      if (!q) return true
      return [p.name, p.sku, p.model, p.category, p.subcategory].some((v) => String(v || '').toLowerCase().includes(q))
    })
  }, [products, chip, search])

  const importExcel = async (file: File) => {
    const buf = await file.arrayBuffer()
    const wb = new XLSX.Workbook()
    await wb.xlsx.load(buf)
    const ws = wb.worksheets[0]
    if (!ws) return
    const matrix: unknown[][] = []
    ws.eachRow((row) => { matrix.push(Array.isArray(row.values) ? (row.values as unknown[]).slice(1) : []) })
    const mapped = mapProductMatrix(matrix)
    const r = await window.electronAPI.crm.productImport(mapped)
    setNotice(`导入 ${r.imported} 个产品（变体已合并）`)
    await fetchProducts()
  }

  const saveNew = async () => {
    let imagePath = form.image_path
    if (aiImg && !imagePath) imagePath = await window.electronAPI.crm.saveImage(aiImg, 'product.jpg')
    await window.electronAPI.crm.create('product', {
      category: form.category, name: form.name, sku: form.sku, model: form.model,
      unit_price: parseFloat(form.unit_price || '0') || 0, cost_price: parseFloat(form.cost_price || '0') || 0,
      reference_price: parseFloat(form.reference_price || '0') || 0, moq: parseInt(form.moq || '1', 10) || 1,
      material: form.material, image_path: imagePath, specs: JSON.stringify(form.specs),
      variants: '[]', created_at: Date.now()
    })
    setShowNew(false); setForm(emptyForm); setAiImg('')
    await fetchProducts()
  }

  const aiExtract = async (dataUrl: string) => {
    const tpl = SPEC_TEMPLATES[form.category] ?? []
    try {
      const out = await window.electronAPI.crm.aiExtract(tpl, dataUrl)
      setForm((f) => ({ ...f, specs: { ...f.specs, ...out } }))
      setNotice('AI 已按模版提取参数，请确认后保存')
    } catch {
      setNotice('当前 AI 模型不支持视觉提取，请手动填写模版')
    }
  }

  const aiDescRow = async (p: ProductRow) => {
    try {
      const text = await window.electronAPI.crm.aiDesc({ name: p.name, model: p.model, material: p.material, specs: p.specs })
      await window.electronAPI.crm.update('product', p.id, { description: text })
      await fetchProducts()
    } catch {
      setNotice('AI 描述生成失败（未配置或不支持），请手动填写')
    }
  }
  const aiDescBatch = async () => {
    for (const id of selected) {
      const p = products.find((x) => x.id === id)
      if (p) await aiDescRow(p)
    }
    setNotice(`已为 ${selected.length} 个产品生成描述`)
  }

  const copyRow = (p: ProductRow) => {
    const specs = JSON.parse(String(p.specs || '{}')) as Record<string, unknown>
    // 嵌套对象展开为紧凑文本（避免 [object Object]），超长字段截断
    const fmt = (v: unknown, limit = 8): string => {
      if (v && typeof v === 'object') {
        const entries = Object.entries(v as Record<string, unknown>)
        const parts = entries.slice(0, limit).map(([k, x]) => `${k}:${fmt(x, limit)}`)
        if (entries.length > limit) parts.push(`等${entries.length}项`)
        return parts.join(' ')
      }
      return String(v ?? '')
    }
    const text = [p.name, p.model && `型号:${p.model}`, `单价:¥${p.unit_price}`, p.material && `材质:${p.material}`, ...Object.entries(specs).map(([k, v]) => `${k}:${fmt(v)}`)].filter(Boolean).join(' ')
    void navigator.clipboard.writeText(text)
    setNotice('已复制产品摘要')
  }

  const inlineUpdate = (p: ProductRow, key: string, value: string) => {
    const patch: Record<string, unknown> = {}
    if (key === 'unit_price' || key === 'reference_price' || key === 'cost_price') patch[key] = parseFloat(value || '0') || 0
    else patch[key] = value
    void window.electronAPI.crm.update('product', p.id, patch).then(fetchProducts)
  }

  const changeImage = async (id: number, file: File) => {
    const reader = new FileReader()
    reader.onload = async () => {
      try {
        const dataUrl = String(reader.result || '')
        const path = await window.electronAPI.crm.saveImage(dataUrl, 'product.jpg')
        await window.electronAPI.crm.update('product', id, { image_path: path })
        setImgCache((c) => ({ ...c, [id]: dataUrl }))
        setNotice('图片已更新')
        await fetchProducts()
      } catch {
        setNotice('图片保存失败，请重试')
      }
    }
    reader.readAsDataURL(file)
  }

  const removeImage = async (id: number) => {
    try {
      await window.electronAPI.crm.update('product', id, { image_path: '' })
      await fetchProducts() // 先刷新 products（image_path 已空）再清缓存，避免 useEffect 用旧 image_path 重载图片
      setImgCache((c) => { const n = { ...c }; delete n[id]; return n })
      setNotice('已删除图片')
    } catch {
      setNotice('删图失败，请重试')
    }
  }

  const openSpecs = (p: ProductRow) => {
    const existing = JSON.parse(String(p.specs || '{}')) as Record<string, string>
    const keys = [...new Set([...(SPEC_TEMPLATES[String(p.category)] ?? []), ...Object.keys(existing)])]
    const f: Record<string, string> = {}
    for (const k of keys) f[k] = existing[k] ?? ''
    setSpecsForm(f)
    setSpecsEdit(p)
  }
  const saveSpecs = async () => {
    if (!specsEdit) return
    await window.electronAPI.crm.update('product', specsEdit.id, { specs: JSON.stringify(specsForm) })
    setSpecsEdit(null)
    await fetchProducts()
  }

  const tpl = SPEC_TEMPLATES[form.category] ?? []

  // 规格摘要：specs JSON 取前 3 个「标量」键值对做行内次行（嵌套对象/数组跳过，完整规格在「规格」弹窗；
  // 同 copyRow 的教训：直接插值嵌套对象会渲染出 [object Object]）
  const specSummaryOf = (p: ProductRow): string => {
    let specs: Record<string, unknown> = {}
    try { specs = JSON.parse(String(p.specs || '{}')) } catch { /* 脏数据忽略 */ }
    return Object.entries(specs)
      .filter(([, v]) => v != null && typeof v !== 'object' && String(v).trim())
      .slice(0, 3)
      .map(([k, v]) => {
        const text = String(v).trim()
        return `${k}:${text.length > 24 ? `${text.slice(0, 24)}…` : text}`
      })
      .join(' · ')
  }

  return (
    <div className="crm-product-page">
      {/* 页眉（概念稿 .shead：左标题/说明，右操作区）——标题与「共 N 个产品」口径不变，
          说明只保留本页已有事实（产品总数），不新增业务承诺 */}
      <header className="shead crm-header">
        <div className="crm-header__lead">
          <p className="eyebrow">系统 · 产品库</p>
          <h1 className="hero crm-header__title"><Package size={18} /> 产品库</h1>
          <p className="sub crm-header__sub">共 {products.length} 个产品 · 价格与规格以本机业务库为准</p>
        </div>
        <div className="shead__actions crm-header__actions">
          <button className={`crm-btn ${editMode ? 'active' : ''}`} onClick={() => setEditMode((v) => !v)}><Pencil size={14} /> 编辑模式</button>
          <button className="crm-btn" onClick={() => fileRef.current?.click()}><Upload size={14} /> 批量导入</button>
          <input ref={fileRef} type="file" accept=".xlsx" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void importExcel(f) }} />
          <button className="crm-btn" disabled={!selected.length} onClick={() => void aiDescBatch()}><Sparkles size={14} /> AI描述({selected.length})</button>
          <button className="crm-btn" onClick={() => void fetchProducts()}><RefreshCw size={14} /></button>
          <button className="crm-btn primary" onClick={() => setShowNew((v) => !v)}><Plus size={14} /> 新增产品</button>
        </div>
      </header>
      {notice && <div className="crm-notice">{notice}</div>}

      <div className="crm-filterbar">
        <input className="crm-search" placeholder="搜索产品 / SKU / 类目 / 小分类" value={search} onChange={(e) => setSearch(e.target.value)} />
        <div className="crm-chips">
          {chips.map((c) => (
            <button key={c.name} className={`chip ${chip === c.name ? 'active' : ''}`} onClick={() => setChip(c.name)}>
              {c.name} ({c.count})
            </button>
          ))}
        </div>
      </div>

      {/* 行表换皮（概念稿屏 14 .tbl/.thead/.trow 细线行）：型号 / 类型 / 规格 / 指导价 / MOQ / 操作。
          产品实体没有库存与在售状态字段，概念稿对应两列不画（不造假）；能力全保留：
          勾选批量 AI 描述、编辑模式行内改名/改价、规格/换图/删图/复制入口都在。 */}
      {filtered.length === 0 ? (
        <div className="crm-table-empty">
          {products.length === 0 ? '还没有产品：用「新增产品」或「批量导入」建第一条。' : '没有匹配的产品：换个关键词或清掉类目筛选。'}
        </div>
      ) : (
      <>
      <div className="seclabel crm-ptable-label">
        <span className="seclabel__t">产品行表</span>
        <span className="crm-ptable-hint">指导价 = 报价引擎取数口径 · 成本 / 参考价在次行</span>
      </div>
      <div className="crm-table-wrap">
        <div className="ptable">
          <div className="thead ptable__grid">
            <span aria-hidden />
            <span>型号</span>
            <span>类型</span>
            <span>规格</span>
            <span className="tc-r">指导价</span>
            <span className="tc-r">MOQ</span>
            <span>操作</span>
          </div>
          {filtered.map((p) => {
            const specLine = specSummaryOf(p)
            return (
            <div key={p.id} className={`trow ptable__grid ptable__row${selected.includes(p.id) ? ' is-on' : ''}`} title={p.description || undefined}>
              <span><input type="checkbox" aria-label={`选择 ${p.name}`} checked={selected.includes(p.id)} onChange={(e) => setSelected((s) => e.target.checked ? [...s, p.id] : s.filter((x) => x !== p.id))} /></span>
              <span className="ptable__model">
                {imgCache[p.id]
                  ? <img className="thumb thumb--sm" src={imgCache[p.id]} alt="" />
                  : <span className="thumb thumb--sm thumb--empty"><Tags size={12} /></span>}
                <span className="ptable__modeltext">
                  {editMode
                    ? <input aria-label="产品名称" defaultValue={p.name} onBlur={(e) => inlineUpdate(p, 'name', e.target.value)} />
                    : <span className="tc-n">{p.name}</span>}
                  <span className="psub">{p.model ? `型号 ${p.model} · ` : ''}SKU {p.sku || '—'}</span>
                </span>
              </span>
              <span className="ptable__cat">
                <span>{p.category || '未分类'}</span>
                {p.subcategory && <span className="psub">{p.subcategory}</span>}
              </span>
              <span className="ptable__spec">
                <span>{p.material || '—'}</span>
                {specLine && <span className="psub">{specLine}</span>}
              </span>
              <span className="ptable__price">
                {editMode
                  ? <input aria-label="单价" defaultValue={p.unit_price} onBlur={(e) => inlineUpdate(p, 'unit_price', e.target.value)} />
                  : <span className="p1 num">¥{Number(p.unit_price ?? 0).toLocaleString()}</span>}
                <span className="psub">成本 ¥{Number(p.cost_price ?? 0).toLocaleString()} · 参考 ¥{Number(p.reference_price ?? 0).toLocaleString()}</span>
              </span>
              <span className="ptable__moq num">{p.moq ?? 1}</span>
              <span className="ops">
                <button className="crm-btn" title="复制" onClick={() => copyRow(p)}><Copy size={13} /></button>
                <button className="crm-btn" title="AI描述" onClick={() => void aiDescRow(p)}><Sparkles size={13} /></button>
                <button className="crm-btn" title="规格" onClick={() => openSpecs(p)}><Tags size={13} /></button>
                <button className="crm-btn" title="换图" onClick={() => { imgTargetRef.current = p.id; imgFileRef.current?.click() }}><ImagePlus size={13} /></button>
                {p.image_path && <button className="crm-btn" title="删图" onClick={() => void removeImage(p.id)}><Trash2 size={13} /></button>}
              </span>
            </div>
            )
          })}
        </div>
      </div>
      </>
      )}

      <input ref={imgFileRef} type="file" accept="image/*" hidden onChange={(e) => {
        const f = e.target.files?.[0]
        if (f) void changeImage(imgTargetRef.current, f)
        e.target.value = ''
      }} />

      {showNew && (
        <div className="crm-modal">
          <div className="crm-modal-body">
            <h3>新增产品 <button className="crm-btn" onClick={() => setShowNew(false)}><X size={14} /></button></h3>
            <div className="form-grid">
              <label>类目
                <select value={form.category} onChange={(e) => setForm((f) => ({ ...f, category: e.target.value, specs: {} }))}>
                  {PRESET_CATS.map((c) => <option key={c}>{c}</option>)}
                </select>
              </label>
              <label>名称 <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} /></label>
              <label>SKU <input value={form.sku} onChange={(e) => setForm((f) => ({ ...f, sku: e.target.value }))} /></label>
              <label>型号 <input value={form.model} onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))} /></label>
              <label>单价 <input value={form.unit_price} onChange={(e) => setForm((f) => ({ ...f, unit_price: e.target.value }))} /></label>
              <label>成本 <input value={form.cost_price} onChange={(e) => setForm((f) => ({ ...f, cost_price: e.target.value }))} /></label>
              <label>参考 <input value={form.reference_price} onChange={(e) => setForm((f) => ({ ...f, reference_price: e.target.value }))} /></label>
              <label>MOQ <input value={form.moq} onChange={(e) => setForm((f) => ({ ...f, moq: e.target.value }))} /></label>
              <label>材质 <input value={form.material} onChange={(e) => setForm((f) => ({ ...f, material: e.target.value }))} /></label>
            </div>
            <h4>规格模版（{form.category}）</h4>
            <div className="form-grid">
              {tpl.map((k) => (
                <label key={k}>{k} <input value={form.specs[k] ?? ''} onChange={(e) => setForm((f) => ({ ...f, specs: { ...f.specs, [k]: e.target.value } }))} /></label>
              ))}
            </div>
            <div className="form-actions">
              <input ref={aiFileRef} type="file" accept="image/*" hidden onChange={(e) => {
                const f = e.target.files?.[0]
                if (!f) return
                const reader = new FileReader()
                reader.onload = () => { const d = String(reader.result || ''); setAiImg(d); void aiExtract(d) }
                reader.readAsDataURL(f)
              }} />
              <button className="crm-btn" onClick={() => aiFileRef.current?.click()}><Sparkles size={14} /> 宣传图 AI 填表</button>
              <button className="crm-btn primary" onClick={() => void saveNew()}>保存</button>
            </div>
          </div>
        </div>
      )}

      {specsEdit && (
        <div className="crm-modal">
          <div className="crm-modal-body">
            <h3>规格：{specsEdit.name} <button className="crm-btn" onClick={() => setSpecsEdit(null)}><X size={14} /></button></h3>
            <div className="form-grid">
              {Object.keys(specsForm).map((k) => (
                <label key={k}>{k} <input value={specsForm[k]} onChange={(e) => setSpecsForm((f) => ({ ...f, [k]: e.target.value }))} /></label>
              ))}
            </div>
            <div className="form-actions"><button className="crm-btn primary" onClick={() => void saveSpecs()}>保存规格</button></div>
          </div>
        </div>
      )}
    </div>
  )
}
