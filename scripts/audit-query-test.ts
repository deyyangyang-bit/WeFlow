/**
 * audit-query-test.ts —— 审计流水 + 归属留痕查询单测（设计稿屏 7/屏 6 右，API-CONTRACT §1.14 契约端点）
 * 覆盖：
 *  a. crm:audit:query：action 类别过滤（assign/bind/recycle/weight）/ keyword 一把搜（actor/detail/entity）/ 分页
 *  b. crm:ownership:history：按实体过滤 + 排序 + 分页 + 非法参数
 *  c. 统一信封 { ok, data: { rows, total } } / 只读（append-only 表写后数据可查）
 *  d. 接线静态检查：IPC 端点注册 + preload + electron.d.ts 三处同步
 * 运行：npx tsx scripts/audit-query-test.ts
 */
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

let pass = 0, fail = 0
function ok(name: string, cond: boolean): void {
  if (cond) { pass++ } else { fail++; console.error('FAIL:', name) }
}

const dbDir = mkdtempSync(join(tmpdir(), 'audit-query-'))
import { crmDbService } from '../electron/services/crmDbService'
import { queryAuditEvents, listOwnershipHistory } from '../electron/services/crmAssignmentService'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

async function main(): Promise<void> {
  await crmDbService.initialize(dbDir)

  // 造数：审计流水四类动作 + 归属留痕两实体（直写表，append-only 语义不变）
  const now = Date.now()
  const audit = (actor: string, action: string, entityType: string, entityId: number | null, detail: string, at: number) =>
    crmDbService.run('INSERT INTO audit_event (actor, action, entity_type, entity_id, detail, created_at) VALUES (?,?,?,?,?,?)',
      [actor, action, entityType, entityId, detail, at])
  audit('杨青（分配员）', 'lead_assign', 'lead', 1, JSON.stringify({ salesName: '李林辉', mode: 'manual' }), now - 1000)
  audit('杨青（销售）', 'identity_bind', 'lead', 2, JSON.stringify({ wxid: 'wxid_8f3abc12de', manual: true }), now - 2000)
  audit('system:sla', 'lead_recycle', 'lead', 1, JSON.stringify({ reason: '3次超时未加' }), now - 3000)
  audit('主管', 'lead_transfer', 'lead', 1, JSON.stringify({ fromSales: '李林辉', toSales: '许丽娟' }), now - 4000)
  audit('主管', 'lead_assign', 'lead', 3, '手机号 15200000007 命中', now - 5000)
  audit('李林辉（销售）', 'assignment_weight_change', 'config', null,
    JSON.stringify({ configKey: 'crmAssignWeights', diff: [{ key: '王五', from: 1, to: 3 }] }), now - 6000)
  const hist = (entityType: string, entityId: number, oldOwner: string, newOwner: string, reason: string, actor: string, at: number) =>
    crmDbService.run('INSERT INTO ownership_history (entity_type, entity_id, old_owner, new_owner, reason, actor, created_at) VALUES (?,?,?,?,?,?,?)',
      [entityType, entityId, oldOwner, newOwner, reason, actor, at])
  hist('lead', 1, '', '李林辉', '批次 #A0001', '杨青（分配员）', now - 10000)
  hist('lead', 1, '李林辉', '', '3 次超时未加', 'system:sla', now - 9000)
  hist('lead', 1, '李林辉', '许丽娟', '回收改派', '主管', now - 8000)
  hist('account', 9, '李林辉', '许丽娟', '离职', '主管', now - 7000)

  // ─── a. audit:query ────────────────────────────────────────────────────────
  const all = queryAuditEvents()
  ok('a1 统一信封 {ok,data:{rows,total}}', all.ok === true && Array.isArray(all.data.rows) && all.data.total === 6)

  const catAssign = queryAuditEvents({ action: 'assign' })
  ok('a2 类别=分配（lead_assign/lead_transfer/departure_handoff）',
    catAssign.data.total === 3 && catAssign.data.rows.every((r) => ['lead_assign', 'lead_transfer'].includes(String(r.action))))
  const catBind = queryAuditEvents({ action: 'bind' })
  ok('a3 类别=绑定（identity_bind）', catBind.data.total === 1 && String(catBind.data.rows[0].action) === 'identity_bind')
  const catRecycle = queryAuditEvents({ action: 'recycle' })
  ok('a4 类别=回收（lead_recycle）', catRecycle.data.total === 1)
  const catWeight = queryAuditEvents({ action: 'weight' })
  ok('a5 类别=权重调整（精确匹配 assignment_weight_change，§2.75 遗留补齐）',
    catWeight.ok === true && catWeight.data.total === 1 && String(catWeight.data.rows[0]?.action) === 'assignment_weight_change')

  const kwActor = queryAuditEvents({ keyword: '杨青' })
  ok('a6 keyword 搜操作人', kwActor.data.total === 2)
  const kwDetail = queryAuditEvents({ keyword: '许丽娟' })
  ok('a7 keyword 搜细节（JSON 内文名）', kwDetail.data.total === 1)
  const kwEntity = queryAuditEvents({ keyword: '15200000007' })
  ok('a8 keyword 搜对象（detail 里手机号可检索）', kwEntity.data.total === 1)

  const paged = queryAuditEvents({ page: 2, pageSize: 2 })
  ok('a9 分页：page2/pageSize2 → 2 行，total 6', paged.data.rows.length === 2 && paged.data.total === 6)
  ok('a10 排序新→旧（created_at DESC）', Number(paged.data.rows[0].created_at) <= Number(queryAuditEvents({ page: 1, pageSize: 1 }).data.rows[0].created_at))

  const byEntity = queryAuditEvents({ entityType: 'lead', entityId: 1 })
  ok('a11 按实体过滤', byEntity.data.total === 3)
  const byTime = queryAuditEvents({ beginAt: now - 2500, endAt: now - 1500 })
  ok('a12 时间窗过滤', byTime.data.total === 1)

  // a13-a15 实体显示名（人话化设计稿 §04「对象解析」）：labels 随行返回，供渲染层把
  // `lead #id` 换成人话名字；解析不到由渲染层回落原名（契约：不留空白）
  crmDbService.run('INSERT INTO lead (contact_type, contact_normalized, name, first_contact_deadline, created_at) VALUES (?,?,?,?,?)',
    ['phone', '15212345678', '临沂诺力机械', now, now])
  const leadId = Number(crmDbService.all('SELECT id FROM lead ORDER BY id DESC LIMIT 1')[0]?.id || 0)
  audit('系统', 'lead_assign', 'lead', leadId, JSON.stringify({ salesName: '杨青' }), now - 500)
  const withLabel = queryAuditEvents({ action: 'assign', pageSize: 100 })
  ok('a13 labels 随响应返回（对象 key = `<entity_type>:<entity_id>`）',
    typeof withLabel.data.labels === 'object' && withLabel.data.labels !== null)
  ok('a14 lead 名解析为实体名（供渲染层替换 `lead #id`）',
    withLabel.data.labels[`lead:${leadId}`] === '临沂诺力机械')
  ok('a15 解析不到的实体不进 labels（渲染层回落原名，不留空白）',
    withLabel.data.labels['lead:999999'] === undefined)
  ok('a16 只读回归：labels 查询零写（lead 行数不变）',
    Number(crmDbService.all('SELECT COUNT(*) AS c FROM lead')[0]?.c) === 1)

  // ─── b. ownership:history ─────────────────────────────────────────────────
  const h1 = listOwnershipHistory({ entityType: 'lead', entityId: 1 })
  ok('b1 统一信封 + lead#1 时间线 3 条', h1.ok === true && h1.data.total === 3 && h1.data.rows.length === 3)
  ok('b2 排序新→旧（最新=改派）', String(h1.data.rows[0].new_owner) === '许丽娟' && String(h1.data.rows[0].actor) === '主管')
  ok('b3 回收行 new_owner 为空（回资源池）', String(h1.data.rows[1].new_owner) === '' && String(h1.data.rows[1].old_owner) === '李林辉')
  const hAcc = listOwnershipHistory({ entityType: 'account', entityId: 9 })
  ok('b4 实体隔离（account#9 只有离职 1 条）', hAcc.data.total === 1 && String(hAcc.data.rows[0].reason) === '离职')
  const hBad = listOwnershipHistory({ entityType: '', entityId: 0 })
  ok('b5 非法参数 → ok:false 空集（不炸）', hBad.ok === false && hBad.data.rows.length === 0)
  const hPaged = listOwnershipHistory({ entityType: 'lead', entityId: 1, page: 2, pageSize: 2 })
  ok('b6 分页：page2 → 剩 1 行，total 3', hPaged.data.rows.length === 1 && hPaged.data.total === 3)

  // ─── c. 只读回归：查询后行数不变 ────────────────────────────────────────────
  const c1 = crmDbService.all('SELECT COUNT(*) AS c FROM audit_event')[0]
  void queryAuditEvents(); void listOwnershipHistory({ entityType: 'lead', entityId: 1 })
  const c2 = crmDbService.all('SELECT COUNT(*) AS c FROM audit_event')[0]
  ok('c1 查询零写（audit_event 行数不变）', Number(c1.c) === Number(c2.c))

  // ─── d. 三处同步静态检查 ───────────────────────────────────────────────────
  const ipcSrc = readFileSync(join(ROOT, 'electron/services/crmIpcHandlers.ts'), 'utf-8')
  ok('d1 IPC 注册 crm:audit:query / crm:ownership:history', ipcSrc.includes("crm:audit:query") && ipcSrc.includes("crm:ownership:history"))
  const preloadSrc = readFileSync(join(ROOT, 'electron/preload.ts'), 'utf-8')
  ok('d2 preload 桥接 auditQuery / ownershipHistory', preloadSrc.includes('auditQuery') && preloadSrc.includes('ownershipHistory'))
  const mainSrc = readFileSync(join(ROOT, 'electron/main.ts'), 'utf-8')
  ok('d5 权重审计写点 = config:set 拦截（crmAssignWeights，零新端点）',
    mainSrc.includes("key === 'crmAssignWeights'") && mainSrc.includes("'assignment_weight_change'"))
  const asgSrc = readFileSync(join(ROOT, 'electron/services/crmAssignmentService.ts'), 'utf-8')
  ok('d6 屏 7 权重段精确匹配（不再 %weight% LIKE 预留）',
    asgSrc.includes("weight: ['assignment_weight_change']") && !asgSrc.includes("'%weight%'"))
  const dtsSrc = readFileSync(join(ROOT, 'src/types/electron.d.ts'), 'utf-8')
  ok('d3 electron.d.ts 类型同步', dtsSrc.includes('auditQuery') && dtsSrc.includes('ownershipHistory'))
  const settingsSrc = readFileSync(join(ROOT, 'src/pages/SettingsPage.tsx'), 'utf-8')
  ok('d4 SettingsPage 挂载审计流水区块', settingsSrc.includes('AuditTrailSection'))
  // 2026-09-13 人话化：脱敏实现从组件内联迁到共享词典（渲染层调用），源码定位标记随形态更新，
  // **断言口径不变**（审计展示层必须对联系方式打码，且零硬编码 hex）。
  const auditDictSrc = readFileSync(join(ROOT, 'shared/auditDict.ts'), 'utf-8')
  const auditSectionSrc = readFileSync(join(ROOT, 'src/components/settings/AuditTrailSection.tsx'), 'utf-8')
  ok('d5 审计展示层脱敏（152****5273 形态，实现=shared/auditDict）+ 无硬编码 hex',
    auditDictSrc.includes('****') && auditSectionSrc.includes('maskContact') &&
    !/#[0-9a-fA-F]{6}\b/.test(auditSectionSrc.replace(/wxid_/g, '')))
  const auditSectionScss = readFileSync(join(ROOT, 'src/components/settings/AuditTrailSection.scss'), 'utf-8')
  ok('d6 颜色只消费 --color-* 族（tsx+scss 零硬编码 hex）',
    auditSectionScss.includes('var(--color-') && !/#[0-9a-fA-F]{3,8}\b/.test(auditSectionScss) && !/#[0-9a-fA-F]{6}\b/.test(auditSectionSrc))
  const leadSrc = readFileSync(join(ROOT, 'src/pages/CrmLeadPage.tsx'), 'utf-8')
  ok('d7 线索详情弹窗归属留痕时间线', leadSrc.includes('ownershipHistory') && leadSrc.includes('归属留痕'))

  console.log(`\naudit-query-test: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

void main()
