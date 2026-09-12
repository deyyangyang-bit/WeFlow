/** Hermes 任务/宿主错误的人话文案唯一真源（Main 与 Renderer 共用）。 */
export const HERMES_ERROR_MESSAGES: Record<string, string> = {
  agent_starting: 'Hermes 正在启动，请稍后再试。',
  agent_unavailable: 'Hermes 暂时不可用，请重启应用后再试。',
  agent_missing: 'Hermes 暂时不可用，请重新安装或升级应用。',
  protocol_mismatch: 'Hermes 组件版本不一致，请重新安装或升级应用。',
  timeout: '本次分析超时，请稍后重试。',
  not_configured: '还没有配置 AI 模型：请到 设置 → AI 设置 完成配置后再试。',
  context_expired: '当前账号或身份已经变化，请重新发起 Hermes 任务。',
  boundary_violation: '本次查询未能安全处理，请重新发起任务。',
  cancelled: '任务已取消。',
  too_many_steps: '这个问题需要太多查询步骤，已停止。请把目标拆得更具体一些。',
  ai_invalid_output: '暂时无法查询，请重试。若问题持续，请重启 WeFlow 或联系管理员。',
  ai_error: '暂时无法查询，请重试。若问题持续，请重启 WeFlow 或联系管理员。',
  internal: '暂时无法查询，请重试。若问题持续，请重启 WeFlow 或联系管理员。'
}

const GENERIC_HERMES_ERROR = '暂时无法查询，请重试。若问题持续，请重启 WeFlow 或联系管理员。'

export function getHermesErrorMessage(errorCode?: string | null): string {
  return HERMES_ERROR_MESSAGES[String(errorCode || '')] || GENERIC_HERMES_ERROR
}
