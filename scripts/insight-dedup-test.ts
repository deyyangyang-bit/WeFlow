/**
 * insight-dedup-test.ts —— AI 见解去重 + 屏蔽名单单测
 * 覆盖：
 *  a. 24h 重复分析去重：同客户 24h 内已有 AI 见解记录 → hasRecentRecord=true
 *  b. sourceType 过滤：手动消息解析（message_analysis）不算「已分析过该客户」，不阻塞后续 AI 见解
 *  c. AI 见解屏蔽名单：config 读写正常；旧 string[] 兼容归一为 legacy_auto（不伪造日期）；
 *     闸门按触发方式裁决——显式单客户触发绕过，批量/自动仍受挡（2026-09-13 重定义）
 *  d. 屏蔽名单与手动黑白名单互不干扰
 *  e. archive 三语义（设计-AI见解重定位 §3.2/§3.3）：计入 24h 去重、不进信箱列表/统计
 * 运行：npx tsx scripts/insight-dedup-test.ts
 */
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// 隔离 insightRecordService 与 config 的落盘路径（必须在 import 前设置）
const isoDir = mkdtempSync(join(tmpdir(), 'insight-dedup-'))
process.env.WEFLOW_USER_DATA_PATH = isoDir
process.env.WEFLOW_CONFIG_CWD = isoDir

let pass = 0, fail = 0
function ok(name: string, cond: boolean): void {
  if (cond) { pass++ } else { fail++; console.error('FAIL:', name) }
}

import { insightRecordService } from '../electron/services/insightRecordService'
import { ConfigService } from '../electron/services/config'
import { normalizeSessionIdList } from '../electron/services/insightService'
import {
  addInsightBlacklistEntry,
  normalizeInsightBlacklist,
  removeInsightBlacklistEntry
} from '../shared/insightBlacklist'

function addInsight(sessionId: string, sourceType: 'insight' | 'message_analysis' | 'archive' = 'insight'): void {
  insightRecordService.addRecord({
    sessionId,
    displayName: '测试客户',
    sourceType,
    triggerReason: 'activity',
    insight: '测试见解内容',
    log: {
      endpoint: 'http://localhost',
      model: 'test',
      maxTokens: 100,
      temperature: 0.7,
      triggerReason: 'activity',
      allowContext: false,
      contextCount: 10,
      systemPrompt: 's',
      userPrompt: 'u',
      rawOutput: 'o',
      finalInsight: '测试见解内容',
      durationMs: 1,
      createdAt: Date.now()
    }
  })
}

function main(): void {
  const config = ConfigService.getInstance()

  // a. 24h 去重：刚写入的 AI 见解记录应在 24h 窗口内
  const sidA = 'wx_dedup_a'
  addInsight(sidA, 'insight')
  ok('a 24h 内已有 AI 见解 → hasRecentRecord=true', insightRecordService.hasRecentRecord(sidA, 24 * 3600 * 1000))

  // b. message_analysis 不算「已分析过该客户」
  const sidB = 'wx_dedup_b'
  addInsight(sidB, 'message_analysis')
  ok('b 仅 message_analysis 记录 → 不阻塞 AI 见解', !insightRecordService.hasRecentRecord(sidB, 24 * 3600 * 1000))

  // b2. message_analysis + insight 混存 → 命中
  addInsight(sidB, 'insight')
  ok('b2 有 insight 记录 → 命中 24h 去重', insightRecordService.hasRecentRecord(sidB, 24 * 3600 * 1000))

  // c. 非客户黑名单读写
  config.set('aiInsightNonCustomerBlacklist', ['wx_nc_1', ' wx_nc_2 '])
  const list = normalizeSessionIdList(config.get('aiInsightNonCustomerBlacklist'))
  ok('c 黑名单写入读回（含去空格）', list.includes('wx_nc_1') && list.includes('wx_nc_2'))
  // c1 锁死「旧 string[] 存量数据升级后仍可读」，格式变更不得让老用户名单凭空消失
  ok('c1 黑名单持久化到配置', Array.isArray(config.get('aiInsightNonCustomerBlacklist')))

  // c2-c6 屏蔽名单重定义（2026-09-13）：旧 string[] 兼容归一 + 条目来源/时间标注
  const normalized = normalizeInsightBlacklist(config.get('aiInsightNonCustomerBlacklist'))
  ok('c2 旧 string[] 归一为对象数组（trim 后逐项落地）',
    normalized.length === 2 && normalized[0].sessionId === 'wx_nc_1' && normalized[1].sessionId === 'wx_nc_2')
  ok('c3 旧格式条目标注 legacy_auto 且 addedAt=null（时间无记录，不伪造日期）',
    normalized.every((e) => e.source === 'legacy_auto' && e.addedAt === null))
  const withManual = addInsightBlacklistEntry(normalized, 'wx_nc_3', 'manual', 1700000000000)
  ok('c4 手动加入标注 manual 并记录毫秒时间戳',
    withManual.some((e) => e.sessionId === 'wx_nc_3' && e.source === 'manual' && e.addedAt === 1700000000000))
  ok('c5 重复加入不覆盖既有来源（legacy 不被洗成 manual）',
    addInsightBlacklistEntry(normalized, 'wx_nc_1', 'manual', 1700000000000)
      .find((e) => e.sessionId === 'wx_nc_1')?.source === 'legacy_auto')
  ok('c6 解除屏蔽按 sessionId 移除',
    !removeInsightBlacklistEntry(withManual, 'wx_nc_3').some((e) => e.sessionId === 'wx_nc_3'))

  // c7-c9 闸门行为（源码接线断言）：判定依据是「触发方式」而非调用点——
  // 显式单客户触发放行（历史误判条目不该挡死用户主动操作），批量/自动仍受挡。
  const insightSrc = readFileSync(join(__dirname, '../electron/services/insightService.ts'), 'utf-8')
  ok('c7 显式单客户触发白名单 = manual / test / message_analysis',
    insightSrc.includes("new Set<string>(['manual', 'test', 'message_analysis'])"))
  ok('c8 闸门仅在非显式触发时跳过（批量/自动仍受挡）',
    insightSrc.includes('blacklisted && !explicitlyTriggered'))
  ok('c9 绕过时不静默（结果文案带屏蔽轻提示）', insightSrc.includes('blacklistBypassNote'))

  // d. 屏蔽名单与手动 filter 名单独立
  config.set('aiInsightFilterMode', 'whitelist')
  config.set('aiInsightFilterList', ['wx_nc_1'])
  const filterList = normalizeSessionIdList(config.get('aiInsightFilterList'))
  ok('d 手动 whitelist 名单独立于 AI 见解屏蔽名单', filterList.includes('wx_nc_1'))
  // 注意：屏蔽名单闸门**不在** isSessionAllowed 内（2026-09-13 重定义时移除），
  // 统一在 generateInsightForSession 按 triggerReason 裁决；勿加回本方法，否则手动触发会被挡死。

  // e. archive 三语义（设计-AI见解重定位 §3.2/§3.3）：记录=分析事实 SSOT，信箱=告警视图
  const beforeDefault = insightRecordService.listRecords()
  const beforeArchiveView = insightRecordService.listRecords({ sourceType: 'archive' })
  const sidC = 'wx_dedup_c'
  addInsight(sidC, 'archive')
  const afterDefault = insightRecordService.listRecords()
  const afterArchiveView = insightRecordService.listRecords({ sourceType: 'archive' })
  ok('e1 archive 计入 24h 去重（防每条客户消息重触发 LLM）', insightRecordService.hasRecentRecord(sidC, 24 * 3600 * 1000))
  ok('e2 信箱默认列表 total 不含 archive（写入前后不变）', afterDefault.total === beforeDefault.total && !afterDefault.records.some(r => r.sessionId === sidC))
  ok('e3 信箱默认 unreadCount/todayCount 不含 archive', afterDefault.unreadCount === beforeDefault.unreadCount && afterDefault.todayCount === beforeDefault.todayCount)
  ok('e4 显式 sourceType=archive 可查到归档记录', afterArchiveView.total === beforeArchiveView.total + 1 && afterArchiveView.records.some(r => r.sessionId === sidC))
  ok('e5 信箱联系人面板不含 archive 会话', !afterDefault.contacts.some(c => c.sessionId === sidC))

  console.log(`结果：${pass} 通过 / ${fail} 失败`)
  process.exit(fail > 0 ? 1 : 0)
}

main()
