/**
 * 商机详情「建议下一步」投影（设计稿 docs/UI设计稿-四页简化.html 屏 1）
 * 纯函数零依赖：内容从现有数据投影——风险预警命中 → 显示风险+建议介入；
 * 否则取意向评分最高权重因素（|delta| 最大）一句；都没有 → 按阶段给默认引导文案。
 * 零 LLM、零新接口（宪法纪律：AI 无 publish 权限，这里只是既有事实的展示层投影）。
 */

export interface NextStepRisk {
  risk_type: string
  severity: string
  detail: string
  status: string
}

export interface NextStepScore {
  score: number
  level: string
  factors: Array<{ label: string; delta: number; reason: string }>
}

// 风险类型/严重度文案（单一真源：原 OpportunityPage 内联表迁入，页面从这里 import）
export const RISK_TYPE_LABEL: Record<string, string> = {
  competitor: '竞品比较', price: '价格异议', service: '服务疑虑'
}
export const RISK_SEVERITY_LABEL: Record<string, string> = {
  high: '高风险', medium: '中风险', low: '低风险'
}

// 阶段默认引导（无风险、无评分时兜底）
const STAGE_GUIDE: Record<string, string> = {
  了解: '客户刚表达采购意向，建议先摸清需求与预算，争取报价机会。',
  比价: '客户正在比价，建议明确我们的差异点与交付优势，给出有期限的成交条件。',
  决策: '客户进入决策阶段，建议确认采购流程与付款方式，推动成交。'
}

export function buildNextStep(input: {
  stage: string
  nextStage?: string
  risks: NextStepRisk[]
  score?: NextStepScore | null
}): string {
  // 1) 有未处理风险 → 显示风险 + 建议介入（严重度最高优先）
  const active = (input.risks || []).filter((r) => r.status === 'active')
  if (active.length > 0) {
    const order: Record<string, number> = { high: 0, medium: 1, low: 2 }
    const r = [...active].sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9))[0]
    const type = RISK_TYPE_LABEL[r.risk_type] || r.risk_type
    const sev = RISK_SEVERITY_LABEL[r.severity] || r.severity
    return `风险预警：${type}（${sev}）——${r.detail}。建议尽快介入沟通，给出应对方案。`
  }
  // 2) 意向评分最高权重因素（|delta| 最大）一句
  const s = input.score
  if (s && s.factors.length > 0) {
    const top = s.factors.reduce((a, b) => (Math.abs(b.delta) > Math.abs(a.delta) ? b : a))
    return `意向评分 ${s.score} 分：关键因素「${top.label}」——${top.reason}。建议趁热跟进${input.nextStage ? `，推进到「${input.nextStage}」` : ''}。`
  }
  // 3) 按阶段给默认引导
  return STAGE_GUIDE[input.stage] || '保持跟进节奏，留意客户群里的新采购信号。'
}
