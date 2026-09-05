/**
 * evalIpcHandlers.ts
 * D7 评测集标注 IPC 注册（service→main 注册约定，同 crmIpcHandlers 模式）。
 * 端点：eval:candidates:generate / eval:list / eval:label / eval:stats
 *      + eval:alert:list / eval:alert:label / eval:alert:stats（alert_eval_case 告警样本，宪法 §3）。
 * 纪律：写库端点（generate / label / alert:label）一律 enqueueSalesTask 串行化（铁律：enqueue 只加最外层入口）。
 */
import type { IpcMain } from 'electron'
import { app } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { enqueueSalesTask } from './salesQueue'
import { generateEvalCandidates, evalListCases, evalLabelCase, evalStats,
  alertEvalListCases, alertEvalLabelCase, alertEvalStats } from './evalService'

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

  // ─── 告警样本（alert_eval_case，宪法 §3）：候选由 scripts/alert-eval.ts import 通道产出 ───

  // 告警样本列表（含展示名；待标注在前已标注沉底；只读）
  ipcMain.handle('eval:alert:list', async () => {
    try {
      return { success: true, cases: alertEvalListCases() }
    } catch (e) {
      return { success: false, cases: [], error: String(e) }
    }
  })

  // 告警样本人工标注写回（label 三档 + annotated_by + status=confirmed；幂等 upsert，ai_* 不动）
  ipcMain.handle('eval:alert:label', async (_, payload: { id: number; label: string; annotatedBy: string }) =>
    enqueueSalesTask(async () => {
      try {
        const row = alertEvalLabelCase(Number(payload?.id), String(payload?.label || ''), String(payload?.annotatedBy || ''))
        return { success: true, case: row }
      } catch (e) {
        return { success: false, error: String(e) }
      }
    }))

  // 告警评测进度 + 人机一致率（只读；按 alert_type 分组，≥85% 开门判定直接读数）
  ipcMain.handle('eval:alert:stats', async () => {
    try {
      return { success: true, stats: alertEvalStats() }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })
}
