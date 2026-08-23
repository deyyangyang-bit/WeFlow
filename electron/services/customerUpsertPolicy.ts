/**
 * customerUpsertPolicy.ts —— 通用客户 upsert 的写权限策略（P0-2A.5）
 *
 * `sales:customer:upsert` 是通用入口，从它撤销 stage 写权限（双保险）：
 *   ① 运行时剥离（本模块）：即使旧 renderer / 第三方调用带 stage 也不应用，避免绕过写者收敛
 *   ② 类型层删除：preload / electron.d.ts 已移除 stage 字段，renderer 编译期无法表达
 *
 * stage 只由合法写者写入（设计 §3）：classifier（salesStageClassifier）/ intent（salesIntentService）/
 * manual（intentCorrect）/ deal rule（crmParseService）。底层 salesDbService.customerUpsert 本身不动，
 * 合法写者仍直接用它写 stage。
 *
 * 独立成模块：不依赖 Electron，测试（scripts/upsert-stage-ban-test.ts）可直接加载验证剥离逻辑。
 */
export interface CustomerUpsertInput {
  session_id: string
  display_name?: string
  stage?: string
  tags?: string
  notes?: string
  customer_id?: string
  external_source?: string
  last_contact_at?: number
}

/** 剥离 stage 后的可写载荷（其余字段原样保留） */
export type CustomerUpsertWithoutStage = Omit<CustomerUpsertInput, 'stage'>

/**
 * 剥离 stage：通用 upsert 入口只允许写非阶段字段。
 * 返回新对象（不改入参），display_name/tags/notes/customer_id/external_source/last_contact_at 原样保留。
 */
export function stripStageFromUpsert(data: CustomerUpsertInput): CustomerUpsertWithoutStage {
  const { stage: _stage, ...rest } = data
  return rest
}
