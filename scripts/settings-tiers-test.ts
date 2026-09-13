/**
 * settings-tiers-test.ts —— 设置页人话化档位映射单测（设计稿《设置页人话化》）
 *
 * 覆盖：
 *  a. 三档映射常量（含**核心断言**：标准档 == 现状落库默认值 0.85/0.70/0.80）
 *  b. 由三个既有值反推档位（tierOf）与未选择态
 *  c. 交叉校验：待确认下限不得高于直接写入阈值（clamp）
 *  d. SettingsPage 接线静态断言（配置键名/默认值未漂移、旧滑杆已迁入折叠、tax_no 不再直出）
 *  e. P2 AI 接入档位：服务商预设 / 回答长度三档（含**核心断言**：标准档 == 现状默认 1024）
 *  f. P3 术语清扫与折叠：提示词折叠、故障自检、实验性标注、术语去行话
 *
 * 运行：npx tsx scripts/settings-tiers-test.ts
 */
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import {
  AUTO_TIERS, clampEnrichThreshold, isClamped, tierOf, valuesOfTier
} from '../src/utils/settingsTiers'
import {
  AI_SERVICE_PRESETS, MAX_TOKENS_TIERS, maxTokensTierOf, normalizeBaseUrl,
  presetOfBaseUrl, tokensOfTier
} from '../src/utils/aiServicePresets'

let pass = 0, fail = 0
function ok(name: string, cond: boolean): void {
  if (cond) { pass++ } else { fail++; console.error('FAIL:', name) }
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const settingsSrc = readFileSync(join(ROOT, 'src/pages/SettingsPage.tsx'), 'utf-8')
const settingsScss = readFileSync(join(ROOT, 'src/pages/SettingsPage.scss'), 'utf-8')
const tierSrc = readFileSync(join(ROOT, 'src/utils/settingsTiers.ts'), 'utf-8')

const byTier = (v: string) => AUTO_TIERS.find((t) => t.value === v)!

// ─── a. 映射常量 ─────────────────────────────────────────────────────────────
ok('a1 恰好三档，顺序 = 保守 / 标准 / 积极',
  AUTO_TIERS.length === 3 && AUTO_TIERS.map((t) => t.value).join(',') === 'conservative,standard,aggressive')
ok('a2 三档中文标签齐备且非空', AUTO_TIERS.every((t) => t.label.trim().length > 0))

// ★ 核心断言：标准档必须逐字等于落库默认值。若有人改了 useState 初值而没改这里（或反之），
//   升级用户会在**未做任何操作**的情况下被静默改掉三个阈值——这条断言就是防那件事的。
ok('a3 标准档 == 现状默认值 0.85 / 0.70 / 0.80',
  byTier('standard').values.autoApply === 0.85 &&
  byTier('standard').values.enrichThreshold === 0.70 &&
  byTier('standard').values.confirmThreshold === 0.80)
ok('a4 保守档 == 0.90 / 0.80 / 0.85',
  byTier('conservative').values.autoApply === 0.90 &&
  byTier('conservative').values.enrichThreshold === 0.80 &&
  byTier('conservative').values.confirmThreshold === 0.85)
ok('a5 积极档 == 0.75 / 0.60 / 0.70',
  byTier('aggressive').values.autoApply === 0.75 &&
  byTier('aggressive').values.enrichThreshold === 0.60 &&
  byTier('aggressive').values.confirmThreshold === 0.70)

// 交叉校验不变量：档位内部不得自相矛盾（待确认下限高于直接写入阈值 = 区间为空但规则打架）
ok('a6 三档均满足 待确认下限 ≤ 直接写入阈值',
  AUTO_TIERS.every((t) => t.values.enrichThreshold <= t.values.autoApply))
// 档位单调递增：越积极 → 阈值越低（自动越多）；否则「积极」可能反而更保守
ok('a7 三档单调：保守 > 标准 > 积极（直接写入阈值）',
  byTier('conservative').values.autoApply > byTier('standard').values.autoApply &&
  byTier('standard').values.autoApply > byTier('aggressive').values.autoApply)
// 量程：三个数字滑杆是 min=0.5 max=1 step=0.05，档位值必须落在同一栅格上，否则滑杆显示不出该值
ok('a8 所有档位值落在滑杆量程 [0.5,1] 且为 0.05 整数倍',
  AUTO_TIERS.every((t) => Object.values(t.values).every((v) =>
    v >= 0.5 && v <= 1 && Math.abs(Math.round(v / 0.05) * 0.05 - v) < 1e-9)))

// ─── b. 反推档位 ─────────────────────────────────────────────────────────────
for (const t of AUTO_TIERS) {
  ok(`b1 档位自反推：${t.value} 的三个值 → tierOf 命中自身`, tierOf(t.values) === t.value)
}
ok('b2 浮点噪声容忍（0.85 + 1e-9 仍判为标准档）',
  tierOf({ autoApply: 0.85 + 1e-9, enrichThreshold: 0.7, confirmThreshold: 0.8 }) === 'standard')
// 关键：手动微调过的值不得被假装归入某一档（否则 UI 会高亮一个并不成立的档位）
ok('b3 手动微调值（0.87 / 0.70 / 0.80）→ 未选择态（空串）',
  tierOf({ autoApply: 0.87, enrichThreshold: 0.7, confirmThreshold: 0.8 }) === '')
ok('b4 只有一项偏离也不命中（0.85 / 0.70 / 0.75）',
  tierOf({ autoApply: 0.85, enrichThreshold: 0.7, confirmThreshold: 0.75 }) === '')
ok('b5 valuesOfTier 返回副本（改动不回写 AUTO_TIERS 常量）',
  (() => { const v = valuesOfTier('standard')!; v.autoApply = 0.1; return byTier('standard').values.autoApply === 0.85 })())
ok('b6 valuesOfTier 未知档位 → null（调用方据此跳过写入，不猜）', valuesOfTier('nope') === null)

// ─── c. 交叉校验 clamp ───────────────────────────────────────────────────────
ok('c1 待确认下限高于直接写入阈值 → 压回阈值', clampEnrichThreshold(0.9, 0.85) === 0.85)
ok('c2 待确认下限低于直接写入阈值 → 原样保留', clampEnrichThreshold(0.7, 0.85) === 0.7)
ok('c3 相等 → 原样保留', clampEnrichThreshold(0.85, 0.85) === 0.85)
ok('c4 isClamped：高于为 true', isClamped(0.9, 0.85) === true)
ok('c5 isClamped：不高于为 false', isClamped(0.7, 0.85) === false)
ok('c6 isClamped 对浮点噪声不误报（0.85+1e-9 不算被 clamp）', isClamped(0.85 + 1e-9, 0.85) === false)

// ─── d. SettingsPage 接线（静态源码断言） ────────────────────────────────────
ok('d1 设置页导入档位模块（单一事实源，不在页面内另写一套映射）',
  settingsSrc.includes("from '../utils/settingsTiers'") &&
  settingsSrc.includes('AUTO_TIERS') && settingsSrc.includes('valuesOfTier'))

// 配置键名与写入时机不得变：档位只是展示层映射，写入的仍是既有三个键
for (const key of ['crmEnrichAutoApply', 'crmEnrichThreshold', 'crmAutoConfirmThreshold']) {
  ok(`d2 配置键 ${key} 仍在（键名未换）`,
    settingsSrc.includes(`configService.set${key[0].toUpperCase()}${key.slice(1)}(`))
}
ok('d3 选中档位一次性写回三个既有键',
  /const applyAutoTier[\s\S]{0,900}setCrmEnrichAutoApply\(v\.autoApply\)[\s\S]{0,400}setCrmEnrichThreshold\(v\.enrichThreshold\)[\s\S]{0,400}setCrmAutoConfirmThreshold\(v\.confirmThreshold\)/.test(settingsSrc) &&
  /const applyAutoTier[\s\S]{0,1400}setCrmEnrichAutoApply\(v\.autoApply\)[\s\S]{0,600}setCrmEnrichThreshold\(v\.enrichThreshold\)[\s\S]{0,600}setCrmAutoConfirmThreshold\(v\.confirmThreshold\)/.test(settingsSrc))

// ★ 默认值防漂移：页面 useState 初值必须与标准档逐字一致
const defOf = (name: string): number => {
  const m = new RegExp(`const \\[${name}, set\\w+\\] = useState\\(([\\d.]+)\\)`).exec(settingsSrc)
  return m ? parseFloat(m[1]) : NaN
}
ok('d4 useState 初值 == 标准档（0.85 / 0.70 / 0.80）',
  defOf('crmEnrichAutoApply') === byTier('standard').values.autoApply &&
  defOf('crmEnrichThreshold') === byTier('standard').values.enrichThreshold &&
  defOf('crmAutoConfirmThreshold') === byTier('standard').values.confirmThreshold)

ok('d5 档位选择器复用既有 SegmentedControl 且 ariaLabel 可定位',
  settingsSrc.includes('ariaLabel="自动化程度"') && settingsSrc.includes('function SegmentedControl'))
ok('d6 高级微调走交叉校验函数（clamp 生效，不是各改各的）',
  /const applyEnrichThreshold[\s\S]{0,700}clampEnrichThreshold\(raw, crmEnrichAutoApply\)/.test(settingsSrc))
ok('d7 clamp 触发时给即时提示（不静默改值）',
  /const applyEnrichThreshold[\s\S]{0,900}isClamped\(raw, crmEnrichAutoApply\)[\s\S]{0,300}已自动调整为/.test(settingsSrc))

// 原三个滑杆已迁入「高级 · 微调」折叠：折叠存在 + 三个滑杆带 aria-label
ok('d8 「高级 · 微调」折叠存在且默认收起（原生 details 无 open 属性）',
  settingsSrc.includes('<AdvancedFold title="高级 · 微调"') && settingsSrc.includes('<details className="s-adv">'))
ok('d9 三个滑杆均带 aria-label（迁入折叠后仍可被定位与无障碍读出）',
  ['直接写入阈值', '待确认下限', '置信阈值'].every((l) => settingsSrc.includes(`aria-label="${l}"`)))
// 旧位置不得残留：把每个 `<h2>` 区块切出来，逐个断言正文内无数字滑杆。
// 三个滑杆原先分别住在「CRM 客户信息自动填充」「跟单中心自动确认」两区块里，现已全部迁入
// 「自动化程度」区块的「高级 · 微调」折叠。
const sectionOf = (title: string): string => {
  const from = settingsSrc.indexOf(`<h2>${title}</h2>`)
  if (from < 0) return ''
  const next = settingsSrc.indexOf('<h2>', from + 1)
  return settingsSrc.slice(from, next < 0 ? undefined : next)
}
ok('d10a 「CRM 客户信息自动填充」区块内已无数字滑杆（两杆已迁出）',
  sectionOf('CRM 客户信息自动填充').length > 0 && !sectionOf('CRM 客户信息自动填充').includes('type="range"'))
// 注意：该区块内**另有**「物流超期阈值」滑杆，属既有控件、本刀未动，
// 故此处只断言被迁走的「置信阈值」杆不再出现，而不是笼统地禁止 range。
ok('d10b 「跟单中心自动确认」区块内的置信阈值滑杆已迁出（物流超期阈值等既有滑杆不动）',
  sectionOf('跟单中心自动确认').length > 0 &&
  !sectionOf('跟单中心自动确认').includes('aria-label="置信阈值"') &&
  sectionOf('跟单中心自动确认').includes('crmLogisticsOverdueHours'))
// 「自动化程度」是卡片（<label> 标题），不是 <h2> 区块，故以折叠为锚点取正文
const foldBody = (() => {
  const from = settingsSrc.indexOf('<AdvancedFold title="高级 · 微调"')
  const to = settingsSrc.indexOf('</AdvancedFold>', from)
  return from < 0 || to < 0 ? '' : settingsSrc.slice(from, to)
})()
ok('d10c「高级 · 微调」折叠内确有被迁入的三个滑杆（迁入而非删除）',
  (foldBody.match(/type="range"/g) || []).length === 3)
ok('d10d 跟单中心区块留了指向档位的说明且带当前真实值',
  /自动化程度[\s\S]{0,120}crmAutoConfirmThreshold\.toFixed\(2\)/.test(sectionOf('跟单中心自动确认')))

ok('d11 tax_no 字段名不再直出给用户',
  !settingsSrc.includes('税号（tax_no）') && !settingsSrc.includes('contract 含税号'))
ok('d12 新折叠样式只消费 --color-* / --radius-* 族且无硬编码 hex',
  /\.s-adv \{[\s\S]*?\n  \}/.test(settingsScss) &&
  !/#[0-9a-fA-F]{3,8}\b/.test(/\.s-adv \{[\s\S]*?\n  \}/.exec(settingsScss)?.[0] || '') &&
  tierSrc.length > 0)

// ─── e. P2 AI 接入档位 ───────────────────────────────────────────────────────
ok('e1 三个服务商预设且顺序 = DeepSeek / OpenAI 兼容 / 自定义',
  AI_SERVICE_PRESETS.length === 3 &&
  AI_SERVICE_PRESETS.map((p) => p.value).join(',') === 'deepseek,openai,custom')
ok('e2 预设地址均不带尾斜杠（后端拼接不再需要「末尾不要加斜杠」这条提示）',
  AI_SERVICE_PRESETS.every((p) => p.url === normalizeBaseUrl(p.url)))
ok('e3 自定义项不携带地址（选中时不覆盖用户已填内容）',
  AI_SERVICE_PRESETS.find((p) => p.value === 'custom')?.url === '')
ok('e4 反推命中所选预设（deepseek / openai）',
  presetOfBaseUrl('https://api.deepseek.com/v1') === 'deepseek' &&
  presetOfBaseUrl('https://api.openai.com/v1') === 'openai')
ok('e5 归一化后仍能命中（用户手填带尾斜杠的同一地址）',
  presetOfBaseUrl('https://api.deepseek.com/v1/') === 'deepseek')
ok('e6 陌生地址 / 空值 → 自定义（保证首次使用不假装选中某服务商）',
  presetOfBaseUrl('https://api.ohmygpt.com/v1') === 'custom' && presetOfBaseUrl('') === 'custom')

ok('e7 长度恰好三档且顺序 = 短 / 标准 / 长',
  MAX_TOKENS_TIERS.length === 3 && MAX_TOKENS_TIERS.map((t) => t.value).join(',') === 'short,standard,long')
// ★ 核心断言：标准档必须逐字等于落库默认值，否则升级用户在**未做任何操作**时被静默改掉长度上限
ok('e8 标准档 == 现状默认 1024 且三档为 512 / 1024 / 2048',
  MAX_TOKENS_TIERS.find((t) => t.value === 'standard')?.tokens === 1024 &&
  tokensOfTier('short') === 512 && tokensOfTier('long') === 2048)
ok('e9 三档单调递增（短 < 标准 < 长）',
  tokensOfTier('short')! < tokensOfTier('standard')! && tokensOfTier('standard')! < tokensOfTier('long')!)
ok('e10 反推档位与未选择态（手填 3000 不假装属于某一档）',
  maxTokensTierOf(1024) === 'standard' && maxTokensTierOf(512) === 'short' && maxTokensTierOf(3000) === '')
ok('e11 tokensOfTier 未知档位 → null（调用方据此跳过写入，不猜）', tokensOfTier('nope') === null)

ok('e12 设置页导入 AI 档位模块与两个既有配置键',
  settingsSrc.includes("from '../utils/aiServicePresets'") &&
  settingsSrc.includes('configService.setAiModelApiBaseUrl(') &&
  settingsSrc.includes('configService.setAiModelApiMaxTokens('))
// ★ 默认值防漂移：页面 useState 初值必须与标准档逐字一致
const maxTokensDefault = (() => {
  const m = /const \[aiModelApiMaxTokens, set\w+\] = useState\((\d+)\)/.exec(settingsSrc)
  return m ? parseInt(m[1], 10) : NaN
})()
ok('e13 aiModelApiMaxTokens 的 useState 初值 == 标准档 1024',
  maxTokensDefault === MAX_TOKENS_TIERS.find((t) => t.value === 'standard')?.tokens)
ok('e14 「AI 服务地址」用 SegmentedControl 且 ariaLabel 可定位',
  settingsSrc.includes('ariaLabel="AI 服务地址"') && settingsSrc.includes('AI_SERVICE_PRESETS.map'))
ok('e15 「单次回答长度上限」用 SegmentedControl 且 ariaLabel 可定位',
  settingsSrc.includes('ariaLabel="单次回答长度上限"') && settingsSrc.includes('MAX_TOKENS_TIERS.map'))
ok('e16 实现细节已从界面删除（不再教用户「末尾不要加斜杠 / 自动拼接 /chat/completions」）',
  !settingsSrc.includes('末尾<strong>不要加斜杠</strong>') && !settingsSrc.includes('程序会自动拼接'))
ok('e17 数字输入收进「高级 · 自定义长度」折叠，滑杆/输入仍在（收进去而非删掉）',
  settingsSrc.includes('<AdvancedFold title="高级 · 自定义长度"') && settingsSrc.includes('aria-label="回答长度上限（token）"'))
// 用户决策（2026-09-13）：API 服务 tab 直出不折叠，恢复与旧版一致——普通用户也不需要多一步展开
ok('e18 API 服务 tab 内容直出、不再包「高级 / 开发者」折叠（用户拍板还原）',
  !settingsSrc.includes('<AdvancedFold title="高级 / 开发者"') && settingsSrc.includes("activeTab === 'api' && renderApiTab()"))
// ★ 两个确认弹窗保持随 tab 直出渲染（折叠已移除，弹窗本就必须在折叠外，此断言防回退）
const apiTab = (() => {
  const from = settingsSrc.indexOf('const renderApiTab')
  const to = settingsSrc.indexOf('const renderAnalyticsTab', from)
  return from < 0 || to < 0 ? '' : settingsSrc.slice(from, to)
})()
ok('e19 API tab 的两个确认弹窗仍在渲染树上（showApiWarning / adoptKeyConfirmOpen）',
  apiTab.includes('showApiWarning &&') && apiTab.includes('adoptKeyConfirmOpen &&'))

// ─── f. P3 术语清扫与折叠 ────────────────────────────────────────────────────
// 四个提示词输入框全部迁入「高级 · 自定义提示词」折叠（任务单列了三个，实际有四个，见实施记录）
ok('f1 提示词折叠出现 4 处（AI 见解 / 足迹总结 / 群聊总结 / 消息解析）',
  (settingsSrc.match(/<AdvancedFold title="高级 · 自定义提示词"/g) || []).length === 4)
ok('f2 四个提示词输入框均带 aria-label（迁入折叠后仍可被定位与无障碍读出）',
  ['AI 见解提示词', '足迹总结提示词', '群聊总结提示词', '消息解析提示词']
    .every((l) => settingsSrc.includes(`aria-label="${l}"`)))
ok('f3 提示词折叠默认收起（原生 details 无 open 属性）',
  settingsSrc.includes('<details className="s-adv">') && !settingsSrc.includes('<details className="s-adv" open>'))

ok('f4 「调试工具」已改名「故障自检」且收进折叠',
  !settingsSrc.includes('<label>调试工具</label>') &&
  settingsSrc.includes('<AdvancedFold title="高级 · 故障自检"'))

// 微博：实验性标注 + 配置整体折叠（UID 列表是表格的一列，无法折叠，见实施记录遗留项）
ok('f5 微博入口已标注实验性且整体折叠',
  settingsSrc.includes('<AdvancedFold title="高级 · 微博公开内容（实验性）"') &&
  settingsSrc.includes('社交平台（微博 · 实验）'))
ok('f6 微博 Cookie 弹窗保留原有实验性标注（未回退）',
  settingsSrc.includes('微博 Cookie（实验性）'))

ok('f7 语音识别模型名称不再直出 Whisper（实际用的是 SenseVoiceSmall）',
  !settingsSrc.includes('语音识别模型 (Whisper)') && settingsSrc.includes('<label>语音识别模型</label>'))
ok('f8 「首触 SLA（小时）」已改为「新线索跟进时限（小时）」且提示同步',
  !settingsSrc.includes('首触 SLA') && settingsSrc.includes('新线索跟进时限（小时）'))

// 展开态必须写字面 `.s-adv__caret`：一行里出现两个 `&` 时后一个会重展开完整祖先链
// （`&[open] &__caret` → `.settings-page .s-adv[open] .settings-page .s-adv__caret`，永不匹配）。
// 故断言「有 `[open] .s-adv__caret`」且「没有 `[open] &__caret`」。
ok('f9 新折叠样式含 details 展开态选择器（箭头旋转生效，且未踩 `&` 二次展开的坑）',
  /[&.]\[open\] \.s-adv__caret/.test(settingsScss) && !/\[open\] &__caret/.test(settingsScss))
ok('f10 折叠块无硬编码浅色值（深色主题安全）',
  !/#[0-9a-fA-F]{3,8}\b/.test(/\.s-adv \{[\s\S]*?\n  \}/.exec(settingsScss)?.[0] || ''))

console.log(`\nsettings-tiers-test: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
