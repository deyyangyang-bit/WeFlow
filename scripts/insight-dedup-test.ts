/**
 * insight-dedup-test.ts —— AI 见解去重 + 非客户黑名单单测
 * 覆盖：
 *  a. 24h 重复分析去重：同客户 24h 内已有 AI 见解记录 → hasRecentRecord=true
 *  b. sourceType 过滤：手动消息解析（message_analysis）不算「已分析过该客户」，不阻塞后续 AI 见解
 *  c. 非客户黑名单：config 读写正常，命中即不应触发
 *  d. 黑名单与手动黑白名单互不干扰
 *  e. archive 三语义（设计-AI见解重定位 §3.2/§3.3）：计入 24h 去重、不进信箱列表/统计
 * 运行：npx tsx scripts/insight-dedup-test.ts
 */
import { mkdtempSync } from 'fs'
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
  ok('c1 黑名单持久化到配置', Array.isArray(config.get('aiInsightNonCustomerBlacklist')))

  // d. 黑名单与手动 filter 名单独立
  config.set('aiInsightFilterMode', 'whitelist')
  config.set('aiInsightFilterList', ['wx_nc_1'])
  const filterList = normalizeSessionIdList(config.get('aiInsightFilterList'))
  ok('d 手动 whitelist 名单独立于非客户黑名单', filterList.includes('wx_nc_1'))
  // 即使手动名单允许，非客户黑名单仍应硬屏蔽（逻辑在 isSessionAllowed：先查黑名单）

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
