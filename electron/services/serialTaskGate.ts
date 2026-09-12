/**
 * serialTaskGate.ts —— 通用 FIFO 串行任务门（worker 内账号切换排他的基础设施）
 *
 * 背景：worker_threads 的 message 事件是并发的（async handler 在 await 点交错执行），
 * 「保存原连接 → 打开目标账号 → 读取 → 恢复/关闭」这类多步连接轮换若与其他请求并发，
 * 普通请求可能读到错误账号或撞上已关闭连接。
 *
 * 用法：把每条消息的处理体交给同一个 gate.run()，所有任务严格按提交顺序逐个完成——
 * 前一个完全结束（含清理）才开始下一个。跨账号轮换因此对其他请求是原子的：
 * 轮换前提交的请求先完成，轮换期间/之后提交的请求只能看到恢复后的原连接。
 *
 * 可独立单测（scripts/wcdb-account-swap-test.ts 用 fake core 验证排他语义）。
 */
export interface SerialTaskGate {
  /** 提交一个任务；返回该任务自身的 Promise（失败不吞，由调用方处理） */
  run<T>(fn: () => Promise<T> | T): Promise<T>
  /** 当前是否有任务在执行（测试/诊断用） */
  readonly busy: boolean
}

export function createSerialTaskGate(): SerialTaskGate {
  let chain: Promise<unknown> = Promise.resolve()
  let running = false
  return {
    run<T>(fn: () => Promise<T> | T): Promise<T> {
      const p = chain.then(() => {
        running = true
        return Promise.resolve(fn())
      })
      chain = p.then(
        () => { running = false },
        () => { running = false }
      )
      return p
    },
    get busy(): boolean { return running }
  }
}
