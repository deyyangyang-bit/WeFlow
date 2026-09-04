import { useState } from 'react'
import LiquidGlass from './LiquidGlass'
import './IdentityOnboardingDialog.scss'

const ROLE_OPTIONS = ['', '销售', '主管', '分配员'] as const
const ROLE_LABELS: Record<string, string> = { '': '暂不选择', '销售': '销售', '主管': '主管', '分配员': '分配员' }

interface IdentityOnboardingDialogProps {
  open: boolean
  onClose: () => void
}

/**
 * 本地身份档案首次启动引导（PRD §1.2a）：
 * 应用锁解除后弹一次；「稍后再填」跳过幂等（主进程落 identityOnboardingDismissed，不再反复弹）。
 * 角色仅作署名用途，不作任何访问控制依据（宪法 §1.12）。
 */
export default function IdentityOnboardingDialog({ open, onClose }: IdentityOnboardingDialogProps) {
  const [name, setName] = useState('')
  const [role, setRole] = useState('')
  const [saving, setSaving] = useState(false)

  if (!open) return null

  const handleSave = async () => {
    const n = name.trim()
    if (!n || saving) return
    setSaving(true)
    try {
      await window.electronAPI.identity.set({ name: n, role })
      onClose()
    } catch (e) {
      console.error('保存身份档案失败:', e)
    } finally {
      setSaving(false)
    }
  }

  const handleSkip = async () => {
    try {
      await window.electronAPI.identity.dismissOnboarding()
    } catch (e) {
      console.error('跳过身份引导失败:', e)
    }
    onClose()
  }

  return (
    <div className="identity-dialog-overlay">
      <LiquidGlass
        className="identity-dialog-glass"
        cornerRadius={20}
        displacementScale={36}
        aberrationIntensity={1.5}
      >
        <div className="identity-dialog">
          <div className="dialog-title">建立本地身份档案</div>
          <p className="dialog-desc">
            用于线索分配与操作审计的署名（如「杨青（销售）」）。角色仅作署名，不影响任何权限；可随时在「设置 → 数据库连接 → 身份档案」修改。
          </p>
          <div className="dialog-form">
            <div className="form-row">
              <label>姓名</label>
              <input
                type="text"
                value={name}
                autoFocus
                placeholder="请输入姓名"
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="form-row">
              <label>角色（可暂不选择）</label>
              <select value={role} onChange={(e) => setRole(e.target.value)}>
                {ROLE_OPTIONS.map((r) => (
                  <option key={r} value={r}>{ROLE_LABELS[r]}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="dialog-actions">
            <button className="btn-cancel" onClick={handleSkip}>稍后再填</button>
            <button className="btn-confirm" disabled={!name.trim() || saving} onClick={handleSave}>
              {saving ? '保存中...' : '保存'}
            </button>
          </div>
        </div>
      </LiquidGlass>
    </div>
  )
}
