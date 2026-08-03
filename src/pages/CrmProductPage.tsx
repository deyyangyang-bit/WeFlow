/**
 * CrmProductPage.tsx —— 型号库：CRUD + Excel 导入（exceljs）
 */
import { useEffect, useRef, useState } from 'react'
import { Package, Upload, Plus, RefreshCw } from 'lucide-react'
import * as XLSX from 'exceljs'
import { useCrmStore } from '../stores/crmStore'
import './CrmProductPage.scss'

export default function CrmProductPage() {
  const { products, fetchProducts, notice, setNotice } = useCrmStore()
  const fileRef = useRef<HTMLInputElement>(null)
  const [model, setModel] = useState('')
  const [name, setName] = useState('')
  const [price, setPrice] = useState('')

  useEffect(() => { void fetchProducts() }, [fetchProducts])

  const addOne = async () => {
    await window.electronAPI.crm.create('product', { model, name, unit_price: parseFloat(price || '0'), created_at: Date.now() })
    setModel(''); setName(''); setPrice('')
    await fetchProducts()
  }

  const importExcel = async (file: File) => {
    const buf = await file.arrayBuffer()
    const wb = new XLSX.Workbook()
    await wb.xlsx.load(buf)
    const ws = wb.worksheets[0]
    if (!ws) return
    const rows: Array<Record<string, unknown>> = []
    ws.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return
      const vals: unknown[] = Array.isArray(row.values) ? (row.values as unknown[]).slice(1) : []
      const [m, n, spec, p, line] = vals
      if (!m) return
      rows.push({ model: String(m ?? ''), name: String(n ?? ''), spec: String(spec ?? ''), unit_price: parseFloat(String(p ?? '0')) || 0, product_line: String(line ?? '') })
    })
    const r = await window.electronAPI.crm.productImport(rows)
    setNotice(`导入 ${r.imported} 条型号`)
    await fetchProducts()
  }

  return (
    <div className="crm-product-page">
      <div className="crm-header">
        <h2><Package size={18} /> 型号库（{products.length}）</h2>
        <button className="crm-btn" onClick={() => fileRef.current?.click()}><Upload size={14} /> 导入 Excel</button>
        <input ref={fileRef} type="file" accept=".xlsx" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void importExcel(f) }} />
        <button className="crm-btn" onClick={() => void fetchProducts()}><RefreshCw size={14} /> 刷新</button>
      </div>
      {notice && <div className="crm-notice">{notice}</div>}
      <div className="crm-new-form">
        <input placeholder="型号" value={model} onChange={(e) => setModel(e.target.value)} />
        <input placeholder="名称" value={name} onChange={(e) => setName(e.target.value)} />
        <input placeholder="标准价" value={price} onChange={(e) => setPrice(e.target.value)} />
        <button className="crm-btn primary" onClick={() => void addOne()}><Plus size={14} /> 添加</button>
      </div>
      <table className="crm-table">
        <thead><tr><th>型号</th><th>名称</th><th>规格</th><th>标准价</th><th>产品线</th></tr></thead>
        <tbody>
          {products.map((p) => (
            <tr key={p.id}><td>{p.model}</td><td>{p.name}</td><td>{p.spec}</td><td>{Number(p.unit_price ?? 0).toLocaleString()}</td><td>{p.product_line}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
