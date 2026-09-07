/**
 * hermes-utility-child-shim.cjs —— 测试专用（仅动态测试经 --require 预载，生产不加载）
 *
 * 在 node 子进程里用 child_process IPC 通道模拟 Electron UtilityProcess 的 process.parentPort：
 *  - postMessage(msg) → process.send(msg)
 *  - on('message', cb) → cb({ data: msg })（对齐 Electron parentPort 的 MessageEvent 形态）
 *  - on('close', cb) → IPC disconnect（对齐 parentPort close 语义）
 * 生产（Electron）路径下 parentPort 由 Electron 原生注入，本文件不参与。
 */
if (process.env.HERMES_UTILITY_IPC_SHIM === '1' && !process.parentPort) {
  process.parentPort = {
    postMessage: (msg) => { if (process.connected) process.send(msg) },
    on: (event, cb) => {
      if (event === 'message') { process.on('message', (m) => cb({ data: m })); return process }
      if (event === 'close') { process.on('disconnect', () => cb()); return process }
      return process
    },
    start() {},
    close() {}
  }
}
