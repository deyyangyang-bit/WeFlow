/**
 * hermesUtilityPath.ts —— Hermes Utility 构建产物路径解析（纯函数，可注入测试）
 *
 * 唯一真源：main.ts 据此计算 utilityProcess.fork 的入口路径。
 *  - 开发态：<项目>/dist-electron/hermesUtility.js（vite build 固定产物名）
 *  - 打包态：process.resourcesPath/hermes/hermesUtility.js
 *    （macOS = WeFlow.app/Contents/Resources/hermes/hermesUtility.js，经 electron-builder
 *     全局 extraResources from dist-electron/hermesUtility.js → to hermes/ 下发；win/linux 同构）
 *
 * 红线：不解析 .ts 源码路径；不落 asar 内部；不依赖 process.cwd()/用户目录；产物缺失时
 * 返回值照样给出（存在性由 Manager entryExists 检查，缺失 → agent_missing fail-closed，
 * 绝不回退旧进程内 Agent）。
 */
import { join } from 'node:path'

export interface HermesUtilityPathInput {
  /** app.isPackaged（测试可注入布尔） */
  isPackaged: boolean
  /** __dirname（= 构建后 main.js 所在目录 dist-electron/） */
  dirname: string
  /** process.resourcesPath（打包态资源目录；测试可注入） */
  resourcesPath: string
}

/** 解析 Utility 构建产物绝对路径（开发态 dist-electron/，打包态 resources/hermes/） */
export function resolveHermesUtilityPath(input: HermesUtilityPathInput): string {
  return input.isPackaged
    ? join(input.resourcesPath, 'hermes', 'hermesUtility.js')
    : join(input.dirname, 'hermesUtility.js')
}

/** 路径日志安全摘要：只记「开发态/打包态」与是否存在，绝不输出完整敏感路径 */
export function describeHermesUtilityPath(isPackaged: boolean, exists: boolean): string {
  return `${isPackaged ? '打包态' : '开发态'} resources=${exists ? '存在' : '缺失'}`
}
