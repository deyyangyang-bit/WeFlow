/**
 * insight-noise-test.ts —— AI 见解噪音过滤单测（设计-AI见解重定位 §2.6）
 * 覆盖：
 *  a. 消息三分类：customer / own / system（含拍一拍、isSend=null 边界）
 *  b. 群发检测：3 会话标记 / 2 会话不标 / 48h 过期 / 72h 窗口重置 / 归一化 / 短文本忽略
 *  c. 触发扫描：群发/系统消息不触发、埋在窗口内的客户回复仍触发、lastSeen 推进
 *  d. 静态护栏：insightService 两路径接线、分类器闸门顺序、上下文标注、prompt 护栏、原子写，
 *     以及「新消息 → AI 阶段分类」自动分派入口不得复活（d10-d12，2026-09-12 复核修复）
 *     与「AI 见解屏蔽名单」不得重新引入 AI 自动写入、闸门须按触发方式裁决（d13-d16，2026-09-13）
 * 运行：npx tsx scripts/insight-noise-test.ts
 */
import { readFileSync } from 'fs'
import { join } from 'path'

let pass = 0, fail = 0
function ok(name: string, cond: boolean): void {
  if (cond) { pass++ } else { fail++; console.error('FAIL:', name) }
}

import {
  classifyInsightMessage,
  scanMessagesForTrigger,
  MassSendDetector
} from '../electron/services/insightNoiseFilter'

// ─── a. 消息三分类 ───────────────────────────────────────────────────────────
{
  ok('a1 客户文本消息 → customer', classifyInsightMessage({ localType: 1, isSend: 0, createTime: 100 }) === 'customer')
  ok('a2 我方消息 → own', classifyInsightMessage({ localType: 1, isSend: 1, createTime: 100 }) === 'own')
  ok('a3 系统消息(10000, isSend=0) → system（不冒充对方）', classifyInsightMessage({ localType: 10000, isSend: 0, createTime: 100 }) === 'system')
  ok('a4 系统消息(10000, isSend=1) → system（系统优先于 own）', classifyInsightMessage({ localType: 10000, isSend: 1, createTime: 100 }) === 'system')
  ok('a5 拍一拍(266287972401) → system', classifyInsightMessage({ localType: 266287972401, isSend: 0, createTime: 100 }) === 'system')
  ok('a6 isSend=null 非系统 → customer（私聊对方消息缺 isSend 场景）', classifyInsightMessage({ localType: 1, isSend: null, createTime: 100 }) === 'customer')
  ok('a7 语音(34) → customer', classifyInsightMessage({ localType: 34, isSend: 0, createTime: 100 }) === 'customer')
}

// ─── b. 群发检测 ─────────────────────────────────────────────────────────────
{
  const HOUR = 3600 * 1000
  const now = Date.now()
  const secAgo = (h: number): number => Math.floor((now - h * HOUR) / 1000) // 微信 createTime 为秒

  // b1: 2 会话命中 → 不标
  const d1 = new MassSendDetector()
  d1.recordOwnText('wxid_a', '去看看', secAgo(1))
  d1.recordOwnText('wxid_b', '去看看', secAgo(1))
  ok('b1 2 会话命中不标记', d1.isMassSendTemplate('去看看') === false)

  // b2: 3 会话命中 → 标记
  d1.recordOwnText('wxid_c', '去看看', secAgo(1))
  ok('b2 3 会话命中标记为群发', d1.isMassSendTemplate('去看看') === true)

  // b3: 归一化——空白差异同键命中
  ok('b3 内容空白归一化后同键', d1.isMassSendTemplate('去看  看看') === false && d1.isMassSendTemplate(' 去看看 ') === true)

  // b4: 48h 过期——3 会话但末次命中在 49h 前
  const d2 = new MassSendDetector()
  d2.recordOwnText('wxid_a', '最近怎么样', secAgo(49))
  d2.recordOwnText('wxid_b', '最近怎么样', secAgo(49))
  d2.recordOwnText('wxid_c', '最近怎么样', secAgo(49))
  ok('b4 末次命中超 48h 标记过期', d2.isMassSendTemplate('最近怎么样') === false)

  // b5: 72h 窗口重置——旧 campaign 2 会话(80h 前) + 新 1 会话(现在) → 重置后不凑数
  const d3 = new MassSendDetector()
  d3.recordOwnText('wxid_a', '在忙吗', secAgo(80))
  d3.recordOwnText('wxid_b', '在忙吗', secAgo(80))
  d3.recordOwnText('wxid_c', '在忙吗', secAgo(0))
  ok('b5 跨窗口旧命中不凑数', d3.isMassSendTemplate('在忙吗') === false)
  d3.recordOwnText('wxid_d', '在忙吗', secAgo(0))
  d3.recordOwnText('wxid_e', '在忙吗', secAgo(0))
  ok('b5b 新窗口累计 3 会话后标记', d3.isMassSendTemplate('在忙吗') === true)

  // b6: 短文本（<2 字）忽略
  const d4 = new MassSendDetector()
  d4.recordOwnText('wxid_a', '好', secAgo(0))
  d4.recordOwnText('wxid_b', '好', secAgo(0))
  d4.recordOwnText('wxid_c', '好', secAgo(0))
  ok('b6 单字符永不标记', d4.isMassSendTemplate('好') === false)

  // b7: 同会话重复记录幂等（不虚增会话数）
  const d5 = new MassSendDetector()
  d5.recordOwnText('wxid_a', '周末有空吗', secAgo(2))
  d5.recordOwnText('wxid_a', '周末有空吗', secAgo(1))
  d5.recordOwnText('wxid_a', '周末有空吗', secAgo(0))
  ok('b7 同会话重复记录不虚增', d5.isMassSendTemplate('周末有空吗') === false)
}

// ─── c. 触发扫描 ─────────────────────────────────────────────────────────────
{
  const lastSeen = 1700000000

  // c1: 最新为自己群发 → 不触发，lastSeen 推进，ownTexts 采集
  const r1 = scanMessagesForTrigger([
    { localType: 1, isSend: 0, createTime: lastSeen - 100, parsedContent: '之前聊的考虑得怎样' },
    { localType: 1, isSend: 1, createTime: lastSeen + 100, parsedContent: '去看看' }
  ], lastSeen)
  ok('c1 仅群发更新不触发', r1.shouldTrigger === false)
  ok('c1b lastSeen 推进到群发时间', r1.latestTs === lastSeen + 100)
  ok('c1c 群发文本进采集', r1.ownTexts.length === 1 && r1.ownTexts[0].content === '去看看')

  // c2: 客户回复被自己后发消息盖住（窗口内）→ 仍触发
  const r2 = scanMessagesForTrigger([
    { localType: 1, isSend: 0, createTime: lastSeen + 50, parsedContent: '多少钱' },
    { localType: 1, isSend: 1, createTime: lastSeen + 200, parsedContent: '报价单发你了' }
  ], lastSeen)
  ok('c2 窗口内客户回复仍触发', r2.shouldTrigger === true)

  // c3: 全部旧消息 → 不触发不采集
  const r3 = scanMessagesForTrigger([
    { localType: 1, isSend: 0, createTime: lastSeen - 10, parsedContent: '嗯' },
    { localType: 1, isSend: 1, createTime: lastSeen - 5, parsedContent: '好的' }
  ], lastSeen)
  ok('c3 旧消息不触发', r3.shouldTrigger === false && r3.ownTexts.length === 0 && r3.latestTs === lastSeen)

  // c4: 新系统消息 → 不触发，但 lastSeen 推进（消费时间戳）
  const r4 = scanMessagesForTrigger([
    { localType: 10000, isSend: 0, createTime: lastSeen + 300, parsedContent: '你已添加了对方,现在可以开始聊天了' }
  ], lastSeen)
  ok('c4 系统消息不触发', r4.shouldTrigger === false)
  ok('c4b 系统消息推进 lastSeen', r4.latestTs === lastSeen + 300)

  // c5: lastSeen=0（画像/上下文采集点用法）→ own 全采集
  const r5 = scanMessagesForTrigger([
    { localType: 1, isSend: 1, createTime: 1000, parsedContent: '你好' },
    { localType: 1, isSend: 0, createTime: 2000, parsedContent: '你好' },
    { localType: 1, isSend: 1, createTime: 3000, parsedContent: 'x' }
  ], 0)
  ok('c5 lastSeen=0 时 own 全采集（短文本 x 除外）', r5.ownTexts.length === 1 && r5.ownTexts[0].content === '你好')
}

// ─── d. 静态护栏（源码接线断言，仿仓库静态契约测试风格） ────────────────────
{
  const svc = readFileSync(join(__dirname, '../electron/services/insightService.ts'), 'utf-8')
  const rec = readFileSync(join(__dirname, '../electron/services/insightRecordService.ts'), 'utf-8')

  // d1/d3 原断言绑在「沉默扫描 / 活跃会话分析」两条自动链路上；该链路已按 PRD §5.4（R）删除，
  // 断言改为护栏的**当前**契约：采集点仍接线（被动采集不丢），且不得重新引入自动分派。
  ok('d1 群发检测器的被动采集点仍接线（≥1，随自动链路删除后只剩上下文采集这一处）',
    (svc.match(/scanMessagesForTrigger\(/g) || []).length >= 1)
  ok('d2 触发扫描窗口常量=10', svc.includes('TRIGGER_SCAN_WINDOW = 10'))
  ok('d3 不再把新消息事件自动分派给阶段分类器（PRD §5.4：无人触发不得调模型）',
    !svc.includes('actionStageClassifier'))
  ok('d4 上下文标注含系统归因', svc.includes("[系统消息] ${content}") && svc.includes("senderName = '系统'"))
  ok('d5 群发标注接线', svc.includes('【疑似群发·批量触达】'))
  ok('d6 prompt 护栏接线且条件化', svc.includes('noiseGuardrail') && svc.includes('禁止将两者解读为对方的行为、意向或回复'))
  ok('d7 上下文构建返回 hasNoise', svc.includes('{ text: string; hasNoise: boolean }'))
  ok('d8 记录落盘换原子写', rec.includes('atomicWriteFileSync(filePath') && !rec.includes('fs.writeFileSync(filePath'))
  ok('d9 去重日志文案与 24h 常量一致', svc.includes('24h 内已生成过见解') && !svc.includes('12h 内已生成过见解'))

  // d10-d12 复核修复（2026-09-12）：onNewMessage「拆线没拆弹」——
  // 调用方已删净但函数体仍在（含 classifyStage → simpleCompletion），重新接线即复活白天自动 AI 链路。
  // 现函数体、函数级 prompt/解析、salesStageClassifier 的 AI 调用一并移除；以下断言锁死不得复活。
  const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  const engine = strip(readFileSync(join(__dirname, '../electron/services/salesActionEngine.ts'), 'utf-8'))
  ok('d10 salesActionEngine 无「新消息增量」入口（onNewMessage 已删除）', !/onNewMessage/.test(engine))
  ok('d11 salesActionEngine 不再自动调用 AI 阶段分类（无人触发不得调模型）', !/classifyStage/.test(engine))
  const classifier = strip(readFileSync(join(__dirname, '../electron/services/salesStageClassifier.ts'), 'utf-8'))
  ok('d12 阶段分类器已无 AI 调用（classifyStage 与其 prompt/解析一并移除）',
    !/simpleCompletion|callChatCompletion|isAiConfigured/.test(classifier))

  // d13-d16 屏蔽名单重定义（2026-09-13）：原「AI 自动判定非客户」的自动写入链路已随 AI 简报改造
  // 删除，名单重定义为纯手动管理的「AI 见解屏蔽名单」。以下断言锁死：不得重新引入自动写入，
  // 且闸门必须按「触发方式」裁决（显式单客户触发放行），否则手动入口会被历史误判条目挡死。
  ok('d13 不得重新引入 AI 自动写入屏蔽名单（blacklistNonCustomer 零残留）',
    !/blacklistNonCustomer/.test(strip(svc)))
  ok('d14 屏蔽名单闸门按触发方式裁决（显式手动触发白名单常量）',
    svc.includes('EXPLICIT_MANUAL_TRIGGER_REASONS') &&
    svc.includes("new Set<string>(['manual', 'test', 'message_analysis'])"))
  ok('d15 名单读写经共享归一化 SSOT（shared/insightBlacklist）',
    svc.includes("from '../../shared/insightBlacklist'") && svc.includes('isInsightBlacklisted('))
  ok('d16 屏蔽判定只在闸门一处消费（声明 + generateInsightForSession 各 1 次，isSessionAllowed 不得加回）',
    (strip(svc).match(/isNonCustomerBlacklisted/g) || []).length === 2)
}

console.log(`\n结果: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
