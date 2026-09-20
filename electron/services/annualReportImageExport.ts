/**
 * annualReportImageExport.ts —— 年度报告图片导出执行（annualReport:exportImages 唯一实现）
 *
 * main.ts 的 IPC handler 只调用 exportAnnualReportImages 并包装成功/失败结果；
 * 目标目录 `_2.._1000` 后缀、建目录、授权与写盘流程只存在于这里，路径规则校验在
 * annualReportExportPolicy.ts。文件系统与授权通过窄接口注入：默认实现使用 Node API
 * 与进程级 exportPathAuthorizer 单例（与生产一致），测试可注入替身。
 */
import { existsSync } from 'fs'
import { mkdir, writeFile } from 'fs/promises'
import { resolve } from 'path'
import { validateAnnualReportExportPayload } from './annualReportExportPolicy'
import { exportPathAuthorizer } from './exportPathAuthorizer'

export interface AnnualReportImageExportDeps {
  assertAllowed(targetPath: string, expect: 'dir' | 'file'): void
  exists(targetPath: string): boolean
  mkdir(targetPath: string): Promise<void>
  /** 独占创建写盘：已存在文件/符号链接一律 EEXIST，不覆盖 */
  writeImageFile(filePath: string, data: Buffer): Promise<void>
}

/** 生产依赖：Node API + 授权器单例 */
export const defaultAnnualReportImageExportDeps: AnnualReportImageExportDeps = {
  assertAllowed: (targetPath, expect) => exportPathAuthorizer.assertAllowed(targetPath, expect),
  exists: (targetPath) => existsSync(targetPath),
  mkdir: (targetPath) => mkdir(targetPath).then(() => undefined),
  writeImageFile: (filePath, data) => writeFile(filePath, data, { flag: 'wx', mode: 0o600 })
}

const MAX_DIR_SUFFIX = 1000

/**
 * 完整执行一次年度报告图片导出：载荷两阶段校验 → baseDir 授权 → 确定目标目录
 * （已存在则 `_2.._1000` 后缀）→ 授权 → 建目录 → 建后复验 → 逐张路径授权 →
 * wx/0600 写盘。失败抛错，成功返回最终目录。
 */
export async function exportAnnualReportImages(
  payload: unknown,
  deps: AnnualReportImageExportDeps = defaultAnnualReportImageExportDeps
): Promise<string> {
  const { baseDir, folderName, images } = validateAnnualReportExportPayload(payload)
  deps.assertAllowed(baseDir, 'dir')

  let targetDir = resolve(baseDir, folderName)
  if (deps.exists(targetDir)) {
    let idx = 2
    while (idx <= MAX_DIR_SUFFIX && deps.exists(`${targetDir}_${idx}`)) idx++
    if (idx > MAX_DIR_SUFFIX) throw new Error('同名报告目录过多')
    targetDir = `${targetDir}_${idx}`
  }

  deps.assertAllowed(targetDir, 'dir')
  await deps.mkdir(targetDir)
  deps.assertAllowed(targetDir, 'dir')

  for (const img of images) {
    const filePath = resolve(targetDir, img.name)
    deps.assertAllowed(filePath, 'file')
    await deps.writeImageFile(filePath, img.buffer)
  }

  return targetDir
}
