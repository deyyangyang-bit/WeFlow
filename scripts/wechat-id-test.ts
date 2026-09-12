/**
 * wechat-id-test.ts —— 微信号格式识别（shared/wechatId.ts）单元测试
 *
 * 覆盖 isSessionIdLike 三类微信号形态（wxid_ 前缀号 / 自定义微信号 / 群号）的命中，
 * 以及真实客户名（中文、日期前缀、含电话）与边界输入（空/数字开头/超短）的不命中。
 * 这是「客户名回填」与「显示名解析」的判别基础：微信备注是名字真相源，
 * 微信号格式的字符串不可直接当客户名展示/存储。
 *
 * 运行：npx tsx scripts/wechat-id-test.ts
 */
import { isSessionIdLike } from '../shared/wechatId'

let pass = 0, fail = 0
function ok(name: string, cond: boolean): void {
  if (cond) { pass++ } else { fail++; console.error('FAIL:', name) }
}

// ── 命中：三种微信号形态 ──────────────────────────────────────────────
ok('should detect wxid_ prefix session id', isSessionIdLike('wxid_wen24wq8ojio22_92a6'))
ok('should detect wxid_ prefix (uppercase)', isSessionIdLike('WXID_ABC123'))
ok('should detect custom wxid (wan923121735)', isSessionIdLike('wan923121735'))
ok('should detect custom wxid (Q63830822Q)', isSessionIdLike('Q63830822Q'))
ok('should detect custom wxid (liangyuzai002)', isSessionIdLike('liangyuzai002'))
ok('should detect custom wxid (a1140843176)', isSessionIdLike('a1140843176'))
ok('should detect chatroom id', isSessionIdLike('xxx@chatroom'))

// ── 不命中：真实客户名与边界 ──────────────────────────────────────────
ok('should not treat date-prefixed customer name as session id', !isSessionIdLike('26.8.20 何仙斌'))
ok('should not treat plain chinese name as session id', !isSessionIdLike('何仙斌'))
ok('should not treat name with phone as session id', !isSessionIdLike('莒县示例塑料厂13900000015'))
ok('should not treat chinese+english mixed remark as session id', !isSessionIdLike('26.7.20 @果思园示例食品 王示例坤13900000016'))
ok('should not treat name with underscore-space as session id', !isSessionIdLike('高俊示例 金福祥示例机电 19500000017'))
ok('should not treat digit-leading as session id', !isSessionIdLike('123abc'))
ok('should not treat short pure-alpha as session id', !isSessionIdLike('abc'))
ok('should not treat empty string as session id', !isSessionIdLike(''))
ok('should not treat null/undefined as session id', !isSessionIdLike(null) && !isSessionIdLike(undefined))
ok('should not treat wechat remark of 🎃 as session id', !isSessionIdLike('🎃'))
// 中文备注 + 英文混合但含中文 → 不是微信号
ok('should not treat chinese-emoji name as session id', !isSessionIdLike('26.7.28ベ随意、👦'))

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)
