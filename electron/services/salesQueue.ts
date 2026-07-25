/**
 * salesQueue.ts
 * 销售侧串行任务队列。
 * 保证同一时刻只有一个"调 WCDB + AI 的重操作"在执行，其余排队等待而非拒绝。
 * 作用：1) 批量画像与用户点击互不丢数据（排队而非返回"忙"）；
 *       2) 杜绝并发调用原生 WCDB 模块导致段错误。
 * 死锁安全约定：enqueue 只加在"最外层入口"，被排队的函数内部绝不再 enqueue
 * （否则当前任务等待自己排队的子任务，形成死锁）。
 */
let chain: Promise<void> = Promise.resolve()

export function enqueueSalesTask<T>(fn: () => Promise<T>): Promise<T> {
  const task: Promise<T> = chain.then(() => fn(), () => fn())
  // chain 仅用于串行化，吞掉错误以免影响后续排队任务
  chain = task.then(() => undefined, () => undefined)
  return task
}
