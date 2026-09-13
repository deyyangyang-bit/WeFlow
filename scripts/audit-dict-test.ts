/**
 * audit-dict-test.ts —— 审计动作词典守卫 + 人话渲染单测（人话化设计稿 §03/§04）
 *
 * 覆盖：
 *  a. **词典覆盖守卫**：扫 electron/ 源码里的 audit_event 写点（auditAppend / INSERT INTO
 *     audit_event / create('audit_event')），断言「代码里出现的每个 action 都在词典中」；
 *     并对照已观测的生产 action 集（OBSERVED_ACTIONS）二次校验。
 *  b. **无 [object Object] 静态 + 动态断言**：对词典每个条目喂嵌套对象 detail 跑一遍 describe。
 *  c. 词表/格式化单测：maskContact、redactPii（数值时间戳不受影响）、fmtClock/fmtDateTime、
 *     权重 diff（两种历史形态）、actorDisplay(system:*)、迁移模块名/原因人话。
 *  d. 渲染层规则：批量合并键、chips ⊆ 后端类别键、未收录动作降级为「未翻译」。
 * 运行：npx tsx scripts/audit-dict-test.ts
 */
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import {
  AUDIT_DICT, AUDIT_FILTER_CHIPS, actorDisplay, auditDictActions, batchHeadline, batchKeyOf,
  entryTone, fmtClock, fmtDateTime, fmtVal, maskContact, migrationIssueKeyLabel,
  migrationIssueReason, migrationModuleLabel, parseDetail, redactPii, resolveAuditAction,
  type DetailPart
} from '../shared/auditDict'
import { AUDIT_ACTION_CATEGORY } from '../electron/services/crmAssignmentService'

let pass = 0, fail = 0
function ok(name: string, cond: boolean): void {
  if (cond) { pass++ } else { fail++; console.error('FAIL:', name) }
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 已观测的生产 action 集 —— 2026-09-13 对本机 weflow-crm-*.db 的
 * `SELECT DISTINCT action FROM audit_event`（全表去重，共 15 个）。
 * 与源码枚举互为补充：源码枚举防「新写点漏收录」，本表防「老数据漏收录」。
 * 该库是测试数据（见记忆 weflow-lead-table-is-test-data），但 action 口径与生产同源。
 */
const OBSERVED_ACTIONS = [
  'absurd_amount_sweep', 'assignment_sla1_backfill', 'assignment_weight_change', 'auto_backup',
  'contract_entry_create', 'lead_assign', 'lead_assign_batch', 'lead_recycle',
  'lead_sla_stock_reset', 'lead_tag_owner_cleanup', 'migration_02_account_to_customer',
  'migration_03_lead_to_identity', 'quote_version_create', 'sla1_misrecycle_correction',
  'sla1_remind'
]

/**
 * 静态反查不到的 action：由 `crmDeliveryService.writeAudit()` 包装器写出，
 * 且 `trade_in_proposal_*` 是模板字符串拼的（`writeAudit(\`trade_in_proposal_${decision}\`)`），
 * 无法从源码枚举 —— 只能人工对照 crmDeliveryService 的三个调用点登记。
 * 新增 writeAudit 字面量调用会被守卫 ④ 自动捕获；改模板拼接则要回来补这里。
 */
const HELPER_WRAPPED_ACTIONS = [
  'diff_task_autoclose', 'warranty_reminder_autoclose',
  'trade_in_proposal_accept', 'trade_in_proposal_reject'
]

// ─── 源码 action 枚举 ────────────────────────────────────────────────────────

/** 从 from 起取第一个 `[ … ]` 平衡段（跳过字符串内的括号）；返回段内文本 */
function sliceBracket(src: string, from: number): string | null {
  const start = src.indexOf('[', from)
  if (start < 0) return null
  let depth = 0, quote = ''
  for (let i = start; i < src.length; i++) {
    const c = src[i]
    if (quote) {
      if (c === '\\') { i++; continue }
      if (c === quote) quote = ''
      continue
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue }
    if (c === '[') depth++
    else if (c === ']') { depth--; if (depth === 0) return src.slice(start + 1, i) }
  }
  return null
}

/** 按顶层分隔符切分表达式（跳过括号与字符串内部） */
function splitTopLevel(s: string, sep = ','): string[] {
  const out: string[] = []
  let depth = 0, cur = '', quote = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quote) {
      cur += c
      if (c === '\\') { cur += s[++i] ?? ''; continue }
      if (c === quote) quote = ''
      continue
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; cur += c; continue }
    if ('([{'.includes(c)) depth++
    else if (')]}'.includes(c)) depth--
    if (c === sep && depth === 0) { out.push(cur); cur = ''; continue }
    cur += c
  }
  out.push(cur)
  return out.map((x) => x.trim()).filter(Boolean)
}

/** 从 `(` 之后取到配对 `)` 的实参文本（跳过字符串与嵌套括号） */
function sliceCallArgs(src: string, from: number): string {
  let depth = 1, i = from, quote = ''
  for (; i < src.length && depth > 0; i++) {
    const c = src[i]
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = ''; continue }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue }
    if (c === '(') depth++
    else if (c === ')') depth--
  }
  return src.slice(from, Math.max(from, i - 1))
}

/** 取字符串字面量内容；非字面量（变量/拼接）返回 null */
function literalOf(expr: string | undefined): string | null {
  const m = /^'([^']*)'$/.exec(String(expr ?? '').trim())
  return m ? m[1] : null
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) { walk(p, out); continue }
    if (name.endsWith('.ts') && !name.endsWith('.d.ts')) out.push(p)
  }
  return out
}

/** 扫全部 electron 源码，收集 audit_event 写点里的 action 字面量 */
function collectActions(): { literal: Set<string>; dynamic: string[] } {
  const literal = new Set<string>()
  const dynamic: string[] = []
  for (const file of walk(join(ROOT, 'electron'))) {
    const src = readFileSync(file, 'utf-8')
    const rel = file.slice(ROOT.length + 1)

    // ① auditAppend(actor, 'action', …) —— 参数是普通括号列表，从 ( 起找配对的 )
    for (const m of src.matchAll(/auditAppend\(/g)) {
      const open = m.index + m[0].length
      let depth = 1, i = open, quote = ''
      for (; i < src.length && depth > 0; i++) {
        const c = src[i]
        if (quote) { if (c === '\\') i++; else if (c === quote) quote = ''; continue }
        if (c === "'" || c === '"' || c === '`') { quote = c; continue }
        if (c === '(') depth++
        else if (c === ')') depth--
      }
      const args = splitTopLevel(src.slice(open, i - 1))
      const act = literalOf(args[1])
      if (act) literal.add(act)
      else dynamic.push(`${rel}: auditAppend(…, ${args[1] ?? '?'})`)
    }

    // ② INSERT INTO audit_event (…) VALUES (…), [actor, 'action', …]
    for (const m of src.matchAll(/INSERT INTO audit_event/g)) {
      const body = sliceBracket(src, m.index + m[0].length)
      if (!body) continue
      // 参数数组里第 2 个元素即 action（第 1 个是 actor）
      const items = splitTopLevel(body)
      const act = literalOf(items[1])
      if (act) literal.add(act)
      else dynamic.push(`${rel}: INSERT audit_event [${items.slice(0, 3).join(', ')}]`)
    }

    // ③ create('audit_event', { action: 'action', … })
    for (const m of src.matchAll(/create\('audit_event'/g)) {
      const tail = src.slice(m.index, m.index + 600)
      const act = literalOf(/action:\s*('[^']*')/.exec(tail)?.[1])
      if (act) literal.add(act)
      else dynamic.push(`${rel}: create('audit_event', { action: <动态> })`)
    }

    // ④ 包装器调用点 writeAudit('action', …)：包装器内部是动态的，这里补上真实取值
    for (const m of src.matchAll(/writeAudit\(/g)) {
      if (/function\s+$/.test(src.slice(Math.max(0, m.index - 12), m.index))) continue // 跳过函数定义
      const args = splitTopLevel(sliceCallArgs(src, m.index + m[0].length))
      const first = String(args[0] ?? '').trim()
      const act = literalOf(first)
      if (act) literal.add(act)
      else dynamic.push(`${rel}: writeAudit(${first})`)
    }
  }
  return { literal, dynamic }
}

// ─── a. 词典覆盖守卫 ─────────────────────────────────────────────────────────

const { literal, dynamic } = collectActions()

ok('a1 源码枚举到足量 action（≥40，防解析器失效导致的假绿）', literal.size >= 40)
for (const act of [...literal].sort()) {
  ok(`a2 词典覆盖源码 action：${act}`, Object.prototype.hasOwnProperty.call(AUDIT_DICT, act))
}
for (const act of OBSERVED_ACTIONS) {
  ok(`a3 词典覆盖生产 action：${act}`, Object.prototype.hasOwnProperty.call(AUDIT_DICT, act))
}
// 模板字符串拼出的 action（静态枚举不到，只能人工枚举）——漏收录会让用户看到 raw key
for (const act of HELPER_WRAPPED_ACTIONS) {
  ok(`a5 词典覆盖模板拼接 action：${act}`, Object.prototype.hasOwnProperty.call(AUDIT_DICT, act))
}
if (dynamic.length) {
  console.log(`\nℹ️ 动态 action 写点（无法静态枚举，需人工确认词典覆盖）：\n  ${dynamic.join('\n  ')}\n`)
}
ok('a4 词典无空 label / 空 tone', auditDictActions().every((k) => {
  const e = AUDIT_DICT[k]
  return !!e.label && !!e.tone && typeof e.describe === 'function'
}))

// ─── b. [object Object] 根治 ────────────────────────────────────────────────

/** 恶意 detail：嵌套对象 / 数组 / 深对象 —— 任何条目渲染出来都不得含 [object Object] */
const NASTY_DETAIL = {
  diff: [{ key: '杨青', from: 55, to: 60 }],
  weights: { 杨青: 60, 李林辉: 50 },
  summary: { total: 10, applied: 3, alreadyDone: 6, failed: 1, conflicts: 0 },
  perSales: { 杨青: 17 },
  old: { shipped_qty: 1, delivery_date: 1789954204656 },
  new: { shipped_qty: 5, delivery_date: 1789954204656 },
  rows: [{ a: 1 }],
  deliveries: [{ x: 1 }, { y: 2 }],
  nested: { deep: { deeper: { v: 1 } } },
  arr: [[1, 2], [3]]
}

const textOf = (parts: DetailPart[]): string =>
  parts.map((p) => (p.kind === 'entity' ? `${p.entityType} #${p.id}` : p.text)).join('')

for (const act of auditDictActions()) {
  const entry = resolveAuditAction(act)
  const parts = entry.describe(NASTY_DETAIL, { entityType: 'lead', entityId: 1 })
  ok(`b1 ${act} 渲染结果无 [object Object]`, !textOf(parts).includes('[object Object]'))
  ok(`b2 ${act} 渲染结果非空`, textOf(parts).trim().length > 0)
}
ok('b3 fmtVal：对象/数组 → JSON.stringify（不是 [object Object]）',
  fmtVal({ a: 1 }) === '{"a":1}' && fmtVal([1, 2]) === '[1,2]' && !fmtVal({}).includes('[object'))
ok('b4 未收录 action 降级：原文 + untranslated + 通用渲染',
  resolveAuditAction('brand_new_action').untranslated === true &&
  resolveAuditAction('brand_new_action').label === 'brand_new_action' &&
  textOf(resolveAuditAction('brand_new_action').describe({ k: { o: 1 } }, { entityType: 'lead', entityId: 1 }))
    .includes('{"o":1}'))

// 静态断言：人话视图必须「过词典 + 过 fmtVal」，不得回到旧的 detail 拍平口径
const sectionSrc = readFileSync(join(ROOT, 'src/components/settings/AuditTrailSection.tsx'), 'utf-8')
ok('b5 审计区块：detail 走词典渲染（旧 detailSummary 拍平已移除）',
  !sectionSrc.includes('detailSummary') && sectionSrc.includes('resolveAuditAction') &&
  sectionSrc.includes('fmtVal(') && sectionSrc.includes('redactPii'))
ok('b6 审计区块不对 parseDetail 结果直接 String()（[object Object] 的复现路径）',
  !/String\(\s*parseDetail\(/.test(sectionSrc))

// ─── c. 词表 / 格式化单测 ───────────────────────────────────────────────────

ok('c1 maskContact 手机号打码（152****5273 形态）',
  maskContact('联系电话 15212345273 请勿外传') === '联系电话 152****5273 请勿外传')
ok('c2 maskContact 微信号打码 + 幂等（二次调用不变）',
  maskContact('wxid_8f3abc12de') === maskContact(maskContact('wxid_8f3abc12de')))
ok('c3 maskContact 不影响普通文本与销售名', maskContact('杨青') === '杨青' && maskContact('临沂诺力机械') === '临沂诺力机械')

const raw = { phone: '15212345273', deadline: 1789954204656, salesName: '杨青', deep: { wx: 'wxid_8f3abc12de' } }
const red = redactPii(raw) as Record<string, unknown>
ok('c4 redactPii 打码字符串叶子', String(red.phone).includes('****') && String((red.deep as Record<string, unknown>).wx).includes('****'))
ok('c5 redactPii 不动数值（时间戳原样，旧版 178****899431 的成因已消除）', red.deadline === 1789954204656)
ok('c6 redactPii 不动普通字符串', red.salesName === '杨青')

const MS = new Date(2026, 8, 15, 18, 0, 0).getTime() // 2026-09-15 18:00 本地
ok('c7 fmtDateTime → M月D日 HH:mm（毫秒口径）', fmtDateTime(MS) === '9月15日 18:00')
ok('c8 fmtClock → MM-DD HH:mm；0/非法 → "-"', fmtClock(MS) === '09-15 18:00' && fmtClock(0) === '-' && fmtClock(undefined) === '-')
ok('c9 fmtDateTime 0 → 空串（不渲染 1970）', fmtDateTime(0) === '' && fmtDateTime(null) === '')

const wParts = textOf(resolveAuditAction('assignment_weight_change')
  .describe({ diff: [{ key: '杨青', from: 55, to: 60 }, { key: '李林辉', from: 50, to: 50 }] }, { entityType: 'config', entityId: null }))
ok('c10 权重变更渲染逐字段变化 + 不变项标注', wParts.includes('杨青 55→60') && wParts.includes('李林辉 不变（50）'))
const wPartsB = textOf(resolveAuditAction('assignment_weight_change')
  .describe({ diff: { recycle: [40, 50] } }, { entityType: 'config', entityId: null }))
ok('c11 权重变更兼容旧形态 { key: [from,to] }', wPartsB.includes('recycle 40→50'))

const slack = textOf(resolveAuditAction('sla1_remind')
  .describe({ salesName: '李林辉', remindNo: 1, total: 3, deadline: MS }, { entityType: 'lead', entityId: 5542 }))
ok('c12 sla1_remind 渲染人话整句（含第 N 次 / 共 M 次 / 可读截止）',
  slack.includes('李林辉') && slack.includes('第 1 次') && slack.includes('共 3 次') && slack.includes('9月15日 18:00'))
ok('c13 sla1_remind 不再出现被打码的时间戳', !slack.includes('****') && !slack.includes('178'))

ok('c14 actorDisplay：system:* → 系统自动',
  actorDisplay('system:sla').text === '系统自动' && actorDisplay('system:migration').system === true &&
  actorDisplay('system:auto-backup').text === '系统自动')
ok('c15 actorDisplay：真人操作人原样', actorDisplay('杨青（主管）').text === '杨青（主管）' && actorDisplay('杨青').system === false)
ok('c16 actorDisplay：空值不空白', actorDisplay('').text === '系统自动')

ok('c17 migrationModuleLabel 人话化（去「模块② account → customer」行话）',
  migrationModuleLabel('02-account-to-customer') === '客户资料合并' &&
  migrationModuleLabel('03-lead-to-identity') === '线索身份建档' &&
  !migrationModuleLabel('02-account-to-customer').includes('→'))
ok('c18 migrationModuleLabel 未登记模块回落原 key（不留空）',
  migrationModuleLabel('99-unknown') === '99-unknown' && migrationModuleLabel('') === '未知模块')
ok('c19 migrationIssueReason 英文码翻译成人话整句',
  migrationIssueReason('no_identity_anchor').includes('缺少手机号和微信会话') &&
  migrationIssueReason('no_identity_anchor').includes('人工'))
ok('c20 migrationIssueReason 已是中文的原样透传 + 空值给占位',
  migrationIssueReason('同一组内客户名不一致，需人工确认') === '同一组内客户名不一致，需人工确认' &&
  migrationIssueReason('') === '未说明原因，需人工核查')
ok('c21 migrationIssueKeyLabel 对象 key 人话化',
  migrationIssueKeyLabel('account:218') === '客户 #218' && migrationIssueKeyLabel('customer_profile:4') === '客户档案 #4')

// ─── d. 渲染层规则 ─────────────────────────────────────────────────────────

const t0 = new Date(2026, 8, 13, 10, 19, 30).getTime()
const t1 = new Date(2026, 8, 13, 10, 19, 55).getTime() // 同一分钟
const t2 = new Date(2026, 8, 13, 10, 20, 5).getTime()  // 下一分钟
ok('d1 合并键：同 action + 同 actor + 同一分钟 → 同键',
  batchKeyOf({ action: 'lead_assign', actor: '分配员', created_at: t0 }) ===
  batchKeyOf({ action: 'lead_assign', actor: '分配员', created_at: t1 }))
ok('d2 合并键：跨分钟 / 换人 / 换动作 → 不同键',
  batchKeyOf({ action: 'lead_assign', actor: '分配员', created_at: t0 }) !==
  batchKeyOf({ action: 'lead_assign', actor: '分配员', created_at: t2 }) &&
  batchKeyOf({ action: 'lead_assign', actor: '分配员', created_at: t0 }) !==
  batchKeyOf({ action: 'lead_assign', actor: '杨青', created_at: t0 }) &&
  batchKeyOf({ action: 'lead_assign', actor: '分配员', created_at: t0 }) !==
  batchKeyOf({ action: 'lead_recycle', actor: '分配员', created_at: t0 }))

ok('d3 批量标题人话化（含条数）',
  batchHeadline('lead_assign', { salesName: '许丽娟' }, 23) === '批量分配 23 条线索给 许丽娟' &&
  batchHeadline('lead_recycle', {}, 9).includes('9 条'))
ok('d4 批量标题：无 batch 模板的 action 走通用模板（不空白）',
  batchHeadline('identity_bind', {}, 4).includes('4 条'))

ok('d5 chips 每项（除「全部」）在后端类别表里有对应 key',
  AUDIT_FILTER_CHIPS.every((c) => c.id === '' || Object.prototype.hasOwnProperty.call(AUDIT_ACTION_CATEGORY, c.id)))
ok('d6 chips 顺序与设计稿 §01 一致（全部/分配/绑定/回收/提醒/配置变更）',
  AUDIT_FILTER_CHIPS.map((c) => c.label).join('/') === '全部/分配/绑定/回收/提醒/配置变更')
ok('d7 「提醒」「配置变更」两类确实有 action（不是空筛选）',
  AUDIT_ACTION_CATEGORY.remind.length > 0 && AUDIT_ACTION_CATEGORY.config.length > 0)

ok('d8 entryTone：备份失败转红（toneOf 生效），成功为中性',
  entryTone(resolveAuditAction('auto_backup'), { ok: false }) === 'recycle' &&
  entryTone(resolveAuditAction('auto_backup'), { ok: true }) === 'neutral' &&
  entryTone(resolveAuditAction('auto_backup'), '') === 'neutral')

ok('d9 parseDetail：对象/JSON 串/非法值都不抛',
  Object.keys(parseDetail('{"a":1}')).length === 1 && Object.keys(parseDetail({ a: 1 })).length === 1 &&
  Object.keys(parseDetail('not json')).length === 0 && Object.keys(parseDetail(null)).length === 0)

ok('d10 detail 非 JSON 字符串不影响渲染（不炸、不空白）',
  textOf(resolveAuditAction('lead_assign').describe(parseDetail('手机号 15200000007 命中'), { entityType: 'lead', entityId: 3 })).length > 0)

console.log(`\naudit-dict-test: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
