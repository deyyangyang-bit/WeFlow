import { useEffect, useRef } from 'react'

/**
 * 账号切换刷新：业务库按微信号整库隔离（§2.40，weflow-crm/sales-<wxid>.db），
 * 主进程在 myWxid 变更时已切库；页面必须监听 wxid-changed 重新查询，
 * 否则屏幕上残留上一账号的数据（看起来就像数据没隔离）。
 * ref 转发保证每次触发调用的都是最新的 reload 闭包。
 */
export function useWxidRefresh(reload: () => void): void {
  const ref = useRef(reload)
  ref.current = reload
  useEffect(() => {
    const handler = () => { ref.current() }
    window.addEventListener('wxid-changed', handler)
    return () => window.removeEventListener('wxid-changed', handler)
  }, [])
}
