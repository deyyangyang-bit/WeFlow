import { useState } from 'react'
import './GeneratedFileResult.scss'
export interface GeneratedArtifact { label: string; path: string }
export default function GeneratedFileResult({ artifact, onClose }: { artifact: GeneratedArtifact; onClose?: () => void }) {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const open = async (folder: boolean) => {
    if (!artifact.path || busy) return
    setBusy(true); setError('')
    try {
      if (folder) {
        const result = await window.electronAPI.shell.showItemInFolder(artifact.path)
        if (!result.ok) setError(result.reason || '无法定位文件')
      } else {
        const reason = await window.electronAPI.shell.openPath(artifact.path)
        if (reason) setError(reason)
      }
    } catch (e) { setError(String(e)) } finally { setBusy(false) }
  }
  return <div className="generated-file-result" role="status">
    <strong>{artifact.label}</strong><span className="generated-file-result__path" title={artifact.path}>{artifact.path}</span>
    <button className="crm-btn" disabled={busy || !artifact.path} onClick={() => void open(false)}>打开</button>
    <button className="crm-btn" disabled={busy || !artifact.path} onClick={() => void open(true)}>打开所在文件夹</button>
    {onClose && <button className="crm-btn" aria-label="关闭生成结果" onClick={onClose}>关闭</button>}
    {error && <span className="generated-file-result__error">{error}</span>}
  </div>
}
