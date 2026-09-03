/**
 * evalIpcHandlers.ts
 * D7 商机评测集标注 IPC 注册（service→main 注册约定，同 crmIpcHandlers 模式）。
 * 端点：eval:candidates:generate / eval:list / eval:label / eval:stats。
 * 纪律：写库端点（generate / label）一律 enqueueSalesTask 串行化（铁律：enqueue 只加最外层入口）。
 */
import type { IpcMain } from 'electron'
import { app } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { enqueueSalesTask } from './salesQueue'
import { generateEvalCandidates, evalListCases, evalLabelCase, evalStats } from './evalService'

/** GLM 预标注包文件名（仓库根；打包版放应用目录同级） */
const AI_PACK_NAME = 'opportunity-eval-pack-20260902.ai.jsonl'

/** AI 预标注包默认路径解析：应用目录优先，其次 cwd；找不到返回 undefined（候选 ai_* 留空，不报错） */
function resolveAiPackPath(): string | undefined {
  for (const base of [app.getAppPath(), process.cwd()]) {
    const p = join(base, AI_PACK_NAME)
    if (existsSync(p)) return p
  }
  return undefined
}

export function registerEvalIpcHandlers(ipcMain: IpcMain): void {
  // 生成/刷新候选（幂等；过滤群聊 + 按 session 去重 + AI 预标注回填）
  ipcMain.handle('eval:candidates:generate', async (_, opts?: { sample?: number }) =>
    enqueueSalesTask(async () => {
      try {
        return { success: true, result: generateEvalCandidates({ sample: opts?.sample, aiPackPath: resolveAiPackPath() }) }
      } catch (e) {
        return { success: false, error: String(e) }
      }
    }))

  // 候选池列表（含展示名；只读）
  ipcMain.handle('eval:list', async () => {
    try {
      return { success: true, cases: evalListCases() }
    } catch (e) {
      return { success: false, cases: [], error: String(e) }
    }
  })

  // 人工标注写回（label + annotated_by + status=confirmed）
  ipcMain.handle('eval:label', async (_, payload: { id: number; label: string; annotatedBy: string }) =>
    enqueueSalesTask(async () => {
      try {
        const row = evalLabelCase(Number(payload?.id), String(payload?.label || ''), String(payload?.annotatedBy || ''))
        return { success: true, case: row }
      } catch (e) {
        return { success: false, error: String(e) }
      }
    }))

  // 进度 + 人机一致率（只读）
  ipcMain.handle('eval:stats', async () => {
    try {
      return { success: true, stats: evalStats() }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })
}
