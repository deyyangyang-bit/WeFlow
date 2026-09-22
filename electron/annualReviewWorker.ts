/**
 * annualReviewWorker.ts —— 年度经营复盘 Worker（S3）
 *
 * 构建与解析约定见 vite.config.ts 独立 entry（产物 dist-electron/annualReviewWorker.js，
 * __dirname 同级解析）。
 *
 * 边界：
 *   - **不打开任何数据库**：主进程已加载窄事实并经 workerData 注入；本文件零 wcdb/salesDb/
 *     crmDb 导入、零密钥/路径。
 *   - 只调用 S1/S2 已验收的纯统计（annualReviewReport.composeAnnualReviewReport）。
 *   - 消息契约：{type:'annualReview:progress', taskId, data} / {type:'annualReview:result', taskId, data}
 *     / {type:'annualReview:error', taskId, error:{code,message}}；错误结构化且非敏感，
 *     不回传堆栈/SQL/数据库路径/原始聊天内容。
 */
import { parentPort, workerData } from 'worker_threads'
import { composeAnnualReviewReport } from './services/annualReviewReport'
import type { AnnualReviewWorkerPayload } from './services/annualReviewService'

const post = (msg: unknown): void => { parentPort?.postMessage(msg) }

function run(): void {
  const payload = workerData as AnnualReviewWorkerPayload | null | undefined
  if (!payload || typeof payload !== 'object' || typeof (payload as { taskId?: unknown }).taskId !== 'string') {
    post({ type: 'annualReview:error', taskId: '', error: { code: 'invalid_payload', message: '年度复盘任务载荷非法' } })
    return
  }
  const taskId = payload.taskId
  try {
    post({ type: 'annualReview:progress', taskId, data: { phase: 'computing', progress: 45, statusText: '计算年度统计' } })
    const report = composeAnnualReviewReport({
      period: payload.period,
      facts: payload.facts,
      sales: payload.sales,
      crm: payload.crm,
      opts: { messageStats: payload.messageStats ?? null, exclusions: payload.exclusions }
    })
    if (!payload.period || payload.reportSchemaVersion !== report.reportSchemaVersion) {
      post({ type: 'annualReview:error', taskId, error: { code: 'invalid_payload', message: '年度复盘任务载荷版本不匹配' } })
      return
    }
    post({ type: 'annualReview:progress', taskId, data: { phase: 'computing', progress: 90, statusText: '组装报告' } })
    post({ type: 'annualReview:result', taskId, data: report })
  } catch {
    // 结构化错误：只回传稳定 code 与固定安全文案，绝不回传堆栈与内部细节。
    // compose 抛出的任何异常（含第三方/原生层的原始异常消息——可能携带数据库路径、
    // SQL 片段或凭据标记）一律不得进入 message；调用方按 code 展示统一文案。
    post({
      type: 'annualReview:error',
      taskId,
      error: { code: 'worker_error', message: '年度复盘统计失败，请稍后重试' }
    })
  }
}

run()
