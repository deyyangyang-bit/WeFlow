/**
 * leadRoundRobin.ts —— round_robin 跨批次公平的共享纯函数（2026-09-20）
 *
 * 背景：批量分配的轮询模式此前每批都从 crmSalesList[0] 开始，余数份额永远落在名单前部
 * （3 人 × 每批 5 条长期 2/2/1）。改进 = 持久化「下一位销售」游标，本批从该成员开始构造
 * 循环序列，使额外份额在多次批量之间轮转。
 *
 * 本模块是**唯一**的轮询实现：后端 crmAssignmentService.buildDistribution 与前端
 * leadAssignmentView.distributePreview 都委托这里，禁止任何一侧复制第二套轮询算法
 * （口径漂移由 scripts 测试断言两侧一致）。零 I/O、零 Electron 依赖，输入输出都是纯值。
 *
 * 游标状态模型（持久层 = config 键 crmRoundRobinCursor，存「下一位销售姓名」）：
 *   - 本批起点 = 游标姓名在当前名单中的下标；名单里找不到（增删/重排/脏值）→ 安全重置 0；
 *   - 后端实际执行 = 成功驱动的逐条状态机（crmAssignmentService）：从起点销售起逐条尝试，
 *     **成功才把指针移到下一位**；失败 / E201/E301 跳过指针不动、下一条仍由同一销售尝试；
 *   - 批次结束后持久化批末真实指针所指成员；整批无成功 → 不写游标（保持旧值）；
 *   - roundRobinPlan = 「假设全部成功」的份额纯函数：前端预览与后端 buildDistribution 同源，
 *     全部成功时与状态机逐条一致；出现失败时预览只是理想分布，实际结果如实反映、不强行匹配。
 * 未来 employeeId 化边界：当前 crmSalesList 是姓名数组，游标暂以规范化姓名（trim 后精确匹配）
 * 记录，不新建第二份员工名单；名单切换为员工 ID 权威时，应把游标键同步迁移为 employeeId
 * 并在迁移处保留一次「姓名 → employeeId」换算，本模块函数签名换成 ID 语义即可，算法不变。
 */

/** 游标姓名在当前名单中的下标；找不到（含空串/脏值）→ 0（安全重置到名单第一位） */
export function roundRobinStartIndex(sales: string[], nextName: string): number {
  const idx = sales.indexOf(String(nextName || '').trim())
  return idx >= 0 ? idx : 0
}

/**
 * round_robin 份额：从 startIndex 起逐位循环计数（余数给起点后的连续成员）。
 * startIndex 越界/负数按模运算归一（防御脏入参）；count ≤ 0 或名单为空返回全 0。
 */
export function roundRobinPlan(count: number, sales: string[], startIndex: number): Record<string, number> {
  const plan: Record<string, number> = {}
  for (const s of sales) plan[s] = 0
  const n = sales.length
  if (!Number.isFinite(count) || count <= 0 || !n) return plan
  const start = ((Math.floor(startIndex) % n) + n) % n
  for (let i = 0; i < Math.floor(count); i++) plan[sales[(start + i) % n]]++
  return plan
}

/** 从 startIndex 起的旋转名单副本（本批逐组分块的迭代顺序；不修改原数组） */
export function rotateSalesFrom(sales: string[], startIndex: number): string[] {
  const n = sales.length
  if (!n) return []
  const start = ((Math.floor(startIndex) % n) + n) % n
  return [...sales.slice(start), ...sales.slice(0, start)]
}
