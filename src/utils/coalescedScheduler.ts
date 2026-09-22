/**
 * coalescedScheduler.ts —— 固定窗口合并调度器（2026-09-20）
 *
 * 语义与主进程 assignmentInvalidationBus 一致：**首个** schedule() 启动 windowMs 窗口；窗口内
 * 后续 schedule() 只做合并（不重置计时）；窗口到期必然触发一次 fire。因此持续事件流的最大
 * 触发间隔 = windowMs —— 不会像尾随 debounce（每次 clearTimeout 重计）那样被间隔小于窗口的
 * 连续事件无限推迟（CrmLeadPage 失效事件 → fetchAll 的节流即用本模块）。
 *
 * 零依赖（不用 React / 第三方定时器库），真实计时器即可测试（scripts/assignment-fairness-notify-test.ts）。
 */
export interface CoalescedScheduler {
  /** 请求一次触发：窗口未开启则启动；已开启则合并（不重置） */
  schedule(): void
  /** 取消未到期的窗口；dispose 后 schedule() 成为空操作（组件卸载防泄漏） */
  dispose(): void
}

export function createCoalescedScheduler(windowMs: number, fire: () => void): CoalescedScheduler {
  let timer: ReturnType<typeof setTimeout> | null = null
  let disposed = false
  return {
    schedule() {
      if (disposed) return // dispose 后空操作（组件卸载防泄漏）
      if (timer !== null) return // 窗口已开启：合并，不重置（固定窗口保证最大延迟）
      timer = setTimeout(() => {
        timer = null
        fire()
      }, windowMs)
    },
    dispose() {
      disposed = true
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
    }
  }
}
