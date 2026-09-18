// 全局提示条挂载点：主窗口挂一次，任何页面调 showToast() 都能弹。
// 样式 = src/styles/main.scss 的 .toast（tooltip 底色 + shadow-menu + 底部居中）。
import { useEffect } from 'react'
import { useToastStore } from '../stores/toastStore'

const TOAST_DURATION_MS = 2600

function GlobalToast() {
  const toast = useToastStore((state) => state.toast)
  const dismissToast = useToastStore((state) => state.dismissToast)

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(dismissToast, TOAST_DURATION_MS)
    return () => window.clearTimeout(timer)
  }, [toast, dismissToast])

  if (!toast) return null

  return (
    <div className="toast" role="status" aria-live="polite">
      {toast.message}
    </div>
  )
}

export default GlobalToast
