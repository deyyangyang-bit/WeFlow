/**
 * wechatId.ts —— 微信账号标识（session_id / 微信号格式）判别
 *
 * 用于「显示名 vs 微信号」的判断：微信备注是客户名真相源，微信号格式的字符串
 * （wxid_ 前缀号 / 自定义微信号 / 群号）不可直接当客户名展示/存储。
 * 覆盖三种形态：
 *  - wxid_ 前缀号：wxid_wen24wq8ojio22_92a6
 *  - 自定义微信号：wan923121735（字母开头，5-20 位字母数字/下划线/中划线）
 *  - 群号：xxx@chatroom
 */
export function isSessionIdLike(text: string | null | undefined): boolean {
  const normalized = String(text || '').trim()
  if (!normalized) return false
  return /^wxid_[a-z0-9_]+$/i.test(normalized)
    || /^[a-z0-9_]+@chatroom$/i.test(normalized)
    || /^[a-zA-Z][a-zA-Z0-9_-]{4,19}$/.test(normalized)
}

/**
 * 原始微信内部账号 ID（无歧义形态）：wxid_ 前缀号 / 群号。
 *
 * 与 isSessionIdLike 的区别：isSessionIdLike 的「自定义微信号」分支（字母开头 5–20 位）
 * 会误伤正常人名（如 Alice/Sales），只适合展示层便利过滤；本函数只认**无歧义**的内部
 * ID 形态，用于公开报告的数据边界——命中者绝不可作为销售身份进入报告/导出/AI 输入，
 * 必须先解析显示名，解析不到则替换为稳定展示标签。判定与掩蔽、运行时校验共用同一谓词
 * （校验不宽于掩蔽，掩蔽不漏于校验）。
 */
export function isRawWechatAccountId(text: string | null | undefined): boolean {
  const normalized = String(text || '').trim()
  if (!normalized) return false
  return /^wxid_[a-z0-9_-]+$/i.test(normalized)
    || /^[a-z0-9_-]+@chatroom$/i.test(normalized)
}
