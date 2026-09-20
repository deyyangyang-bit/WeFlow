/**
 * ipcEventSubscription.ts —— preload 事件订阅的纯辅助（零 electron 依赖，可单测）
 *
 * 背景：`removeAllListeners(channel)` 会在一个订阅者清理时删掉同频道的其他订阅者。
 * 本模块按「注册时保存当前订阅对应的 wrapper，清理时 removeListener(channel, wrapper)」
 * 的方式包装订阅：多个订阅者互相独立，清理幂等（重复调用 no-op）。
 * annualReview:progress 订阅使用本辅助；旧 annualReport/dualReport 通道不在本模块范围。
 */

/** ipcRenderer 的窄结构面（测试用假实现注入） */
export interface IpcEventRegistrar {
  on(channel: string, listener: (...args: unknown[]) => void): unknown
  removeListener(channel: string, listener: (...args: unknown[]) => void): unknown
}

/**
 * 订阅一个 IPC 事件（事件载荷 = invoke 回调第二参）。返回幂等清理函数：
 * 只移除本次注册的 wrapper，不影响同频道其他订阅者。
 */
export function subscribeIpcEvent(
  registrar: IpcEventRegistrar,
  channel: string,
  handler: (payload: unknown) => void
): () => void {
  const wrapper = (...args: unknown[]): void => {
    handler(args.length > 1 ? args[1] : undefined)
  }
  registrar.on(channel, wrapper)
  let removed = false
  return () => {
    if (removed) return
    removed = true
    registrar.removeListener(channel, wrapper)
  }
}
