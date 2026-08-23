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
