/**
 * customer-event-test.ts —— P0-3 E3.1 验收：CustomerEvent 基础设施（建表/类型/原语/幂等/证据）
 *
 * 验收（Scope Lock 2026-08-23，只做 Event Production，不接业务生产者）：
 *   A 静态护栏：
 *     1  shared/customerEvent.ts 五类型完整，无越界（stage/judgment 类零出现）
 *     2  salesDbService 建表含 CHECK 五类约束（DB 层万能日志表门禁）
 *     3  幂等 partial unique index（message_key）
 *     4  原语命名（customerEventAdd / bySession / byType）
 *     5  类型守卫 isCustomerEventType 被 salesDbService 引用（TS 第一道拦截）
 *     6  customerEventAdd 的 INSERT 只写 customer_event 一张表（四者不互相冒充）
 *     7  设计文档含 Scope Lock（文档同步护栏）
 *   B 行为（temp DB，真实生产函数）：
 *     8  append 后可读（字段完整、created_at 落库）
 *     9  同 message_key 幂等拒绝（返回 null、行数不变）
 *     10 无 key 的手动事件允许重复写
 *     11 非法类型抛错（TS 层守卫）
 *     12 bySession 倒序返回
 *     13 byType + sinceMs 过滤
 *     14 metadata JSON 往返
 *     15 与 intent_tag_log / customer_judgment 互不干扰（事件不产生判断，三表独立 append）
 *
 * 运行：npx tsx scripts/customer-event-test.ts
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { salesDbService } from '../electron/services/salesDbService'

let pass = 0, fail = 0
function ok(name: string, cond: boolean): void {
  if (cond) { pass++ } else { fail++; console.error('FAIL:', name) }
}

const ROOT = join(__dirname, '..')
const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

async function main(): Promise<void> {
  // ── A. 静态护栏 ────────────────────────────────────────────────────────────
  const sharedSrc = readFileSync(join(ROOT, 'shared/customerEvent.ts'), 'utf8')
  const dbSrc = readFileSync(join(ROOT, 'electron/services/salesDbService.ts'), 'utf8')
  const dbCode = strip(dbSrc)
  const sharedCode = strip(sharedSrc)
  const types = ['customer_replied', 'quote_asked', 'script_copied', 'chat_opened', 'follow_up_done']

  ok('A1 五类型枚举完整', types.every((t) => new RegExp(`'${t}'`).test(sharedCode)))
  ok('A2 shared 层无越界类型（stage/judgment 类零出现，防万能日志表）',
    !/'(stage_changed|ai_summary_generated|opportunity_detected|risk_detected|quote_created|contract_signed)'/.test(sharedCode))
  ok('A3 建表含 CHECK 五类约束（DB 层门禁）', /event_type TEXT NOT NULL CHECK \(event_type IN \('customer_replied', 'quote_asked', 'script_copied', 'chat_opened', 'follow_up_done'\)\)/.test(dbCode))
  ok('A4 幂等 partial unique index（message_key）', /CREATE UNIQUE INDEX IF NOT EXISTS idx_event_msgkey ON customer_event\(message_key\) WHERE message_key IS NOT NULL/.test(dbCode))
  ok('A5 原语命名齐备', /customerEventAdd/.test(dbCode) && /customerEventsBySession/.test(dbCode) && /customerEventsByType/.test(dbCode))
  ok('A6 类型守卫被 salesDbService 引用（TS 第一道拦截）', /isCustomerEventType/.test(dbCode) && /from '\.\.\/\.\.\/shared\/customerEvent'/.test(dbCode))
  // 只检查 customerEventAdd 方法体（从方法名到下一个方法名之间）——前面的 judgmentCreate 等原语天然写各自表
  const addBody = dbCode.slice(dbCode.indexOf('customerEventAdd'), dbCode.indexOf('customerEventsBySession'))
  ok('A7 customerEventAdd 只写 customer_event 一张表（四者不互相冒充）',
    !/INSERT INTO (intent_tag_log|customer_judgment|customer_profile|follow_up_task)/.test(addBody))
  ok('A8 设计文档含 Scope Lock（文档同步护栏）',
    /Scope Lock/.test(readFileSync(join(ROOT, 'docs/P0-3E3-CustomerEvent.md'), 'utf8')))

  // ── B. 行为（temp DB）─────────────────────────────────────────────────────
  const dir = mkdtempSync(join(tmpdir(), 'cev-'))
  await salesDbService.initialize(dir)
  const NOW = Date.now()

  // B8: 有判断/意向/事件的同一客户，验证三表独立 append
  salesDbService.customerUpsert({ session_id: 'wx_cev_1', display_name: '事件客户', stage: 'quoted', last_contact_at: (NOW - 2 * 86400_000) / 1000 })
  salesDbService.judgmentCreate({
    session_id: 'wx_cev_1', judgment_type: 'opportunity', value: '有追加机会', source: 'ai',
    generated_at: NOW - 3600_000, message_key: 'k:cev:opp:1', createdAt: NOW - 3600_000
  })

  const ev = salesDbService.customerEventAdd({
    session_id: 'wx_cev_1', event_type: 'customer_replied', source: 'system',
    message_key: 'k:cev:reply:1', evidence_text: '客户回复：可以安排下周来看设备',
    metadata: JSON.stringify({ via: 'quote_signal' }), createdAt: NOW
  })
  ok('B1 append 后可读（字段完整、created_at 落库）',
    !!ev && ev.event_type === 'customer_replied' && ev.session_id === 'wx_cev_1' &&
    ev.message_key === 'k:cev:reply:1' && ev.created_at === NOW)

  // B2: 幂等拒绝
  const dup = salesDbService.customerEventAdd({
    session_id: 'wx_cev_1', event_type: 'customer_replied', source: 'system',
    message_key: 'k:cev:reply:1', createdAt: NOW + 1000
  })
  ok('B2 同 message_key 幂等拒绝（返回 null、行数不变）', dup === null && salesDbService.customerEventsBySession('wx_cev_1').length === 1)

  // B3: 无 key 手动事件可重复
  const m1 = salesDbService.customerEventAdd({ session_id: 'wx_cev_1', event_type: 'follow_up_done', source: 'manual', createdAt: NOW + 2000 })
  const m2 = salesDbService.customerEventAdd({ session_id: 'wx_cev_1', event_type: 'follow_up_done', source: 'manual', createdAt: NOW + 3000 })
  ok('B3 无 key 的手动事件允许重复写', !!m1 && !!m2 && m1.id !== m2.id)

  // B4: 非法类型抛错
  let threw = false
  try {
    salesDbService.customerEventAdd({ session_id: 'wx_cev_1', event_type: 'stage_changed' as any, source: 'rule' })
  } catch { threw = true }
  ok('B4 非法类型（stage_changed）抛错（TS 层守卫）', threw)

  // B5: bySession 倒序（最新在前）
  const bySession = salesDbService.customerEventsBySession('wx_cev_1')
  ok('B5 bySession 倒序（最新在前）', bySession.length === 3 && bySession[0].event_type === 'follow_up_done' && bySession[0].created_at === NOW + 3000)

  // B6: byType + sinceMs
  const byTypeAll = salesDbService.customerEventsByType('customer_replied')
  const byTypeSince = salesDbService.customerEventsByType('customer_replied', NOW + 500)
  ok('B6 byType 查询 + sinceMs 过滤', byTypeAll.length === 1 && byTypeSince.length === 0)

  // B7: metadata 往返
  ok('B7 metadata JSON 往返', !!ev && String(ev.metadata) === JSON.stringify({ via: 'quote_signal' }))

  // B8: 三表独立（事件不产生判断/意向，intent_tag_log 不被事件触碰）
  const judgmentStill = salesDbService.judgmentHistory('wx_cev_1')
  ok('B8 事件与判断/意向互不干扰（同 session 三表独立 append，事件不产生判断）',
    judgmentStill.length === 1 && judgmentStill[0].judgment_type === 'opportunity' &&
    salesDbService.intentHistory('wx_cev_1').length === 0)

  console.log(`customer-event-test: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main()
