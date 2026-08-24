/**
 * CustomerPicker.tsx —— 客户名输入（认领表单）
 * 直接输入客户名：输入即联想已有客户，点候选认领到该客户；不点候选直接认领则按输入名建档（父组件 accountEnsure）。
 * 替代原「选择客户下拉 + 新客户名建档」两个控件。
 */
import { useState, useRef, useEffect } from 'react'

interface Props {
  accounts: any[]
  value: string // 当前客户名文本（受控）
  onChange: (name: string) => void
  placeholder?: string
  displayNameOf: (c: any) => string
}

export default function CustomerPicker({ accounts, value, onChange, placeholder = '输入客户名…', displayNameOf }: Props) {
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)
  const q = value.trim().toLowerCase()
  const list = (q ? accounts.filter((c) => displayNameOf(c).toLowerCase().includes(q)) : []).slice(0, 30)
  const matched = q ? accounts.some((c) => displayNameOf(c).toLowerCase() === q) : false

  // 点击组件外部收起
  useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [open])

  return (
    <div className="customer-picker" ref={boxRef}>
      <input value={value} placeholder={placeholder}
        onChange={(e) => { onChange(e.target.value); setOpen(true) }}
        onFocus={() => setOpen(true)}
        onBlur={() => { if (matched) setOpen(false) }}
        onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false) }} />
      {open && q && (
        <div className="customer-picker__drop">
          <div className="customer-picker__list">
            {list.map((c) => (
              <button type="button" key={c.id} onMouseDown={(e) => e.preventDefault()}
                onClick={() => { onChange(displayNameOf(c)); setOpen(false) }}>
                {displayNameOf(c)}
              </button>
            ))}
            {list.length === 0 && <div className="customer-picker__empty">无匹配客户——直接认领将新建「{value.trim()}」</div>}
            {matched && <div className="customer-picker__matched">将认领到已有客户「{value.trim()}」</div>}
          </div>
        </div>
      )}
    </div>
  )
}
