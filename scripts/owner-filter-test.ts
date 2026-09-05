/**
 * owner-filter-test.ts —— 页面过滤档单测（2026-09-05 拍板，客户/商机/合同三页统一）
 * 覆盖：
 *  a. filterByOwner 纯函数：本人可见/他人不可见/空归属可见/管理视角全见/空姓名=管理视角
 *  b. 合同 owner 推导：crmDbService.workbench 带 owner_sales（contract 无 owner 列，经 account JOIN，宪法设计）
 *  c. 三页面静态接线断言：import 过滤函数 + 身份已加载 + 提示行 + 合同 SQL 带 owner 字段
 * 运行：npx tsx scripts/owner-filter-test.ts（/tmp 隔离库）
 */
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; console.log(`  ✅ ${name}`) } else { fail++; console.log(`  ❌ ${name} ${detail}`) }
}

const dbDir = mkdtempSync(join(tmpdir(), 'owner-filter-'))
import { crmDbService } from '../electron/services/crmDbService'
import { filterByOwner, isSalesView } from '../src/utils/leadAssignmentView'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

async function main(): Promise<void> {
  await crmDbService.initialize(dbDir)

  // ─── a. filterByOwner 纯函数 ───────────────────────────────────────────────
  const rows = [
    { id: 1, owner_sales: '张三' },
    { id: 2, owner_sales: '李四' },
    { id: 3, owner_sales: '' },
    { id: 4, owner_sales: null },
    { id: 5 }
  ]
  const sales = { name: '张三', role: '销售' }
  const mgr = { name: '王主管', role: '主管' }
  const empty = { name: '', role: '' }

  const vis = filterByOwner(rows, sales)
  ok('a1 本人可见', vis.some((r) => r.id === 1))
  ok('a2 他人不可见', !vis.some((r) => r.id === 2))
  ok("a3 空归属可见（空串/null/无字段 三态都算公共资源）", vis.some((r) => r.id === 3) && vis.some((r) => r.id === 4) && vis.some((r) => r.id === 5))
  ok('a4 销售视角只留 4 行（本人 1 + 空归属 3）', vis.length === 4, JSON.stringify(vis.map((r) => r.id)))
  ok('a5 主管视角全见', filterByOwner(rows, mgr).length === 5)
  ok('a6 分配员视角全见', filterByOwner(rows, { name: '赵分配', role: '分配员' }).length === 5)
  ok('a7 空身份=管理视角全见', filterByOwner(rows, empty).length === 5)
  ok('a8 销售但姓名空 = 管理视角全见（isSalesView 口径）', filterByOwner(rows, { name: '', role: '销售' }).length === 5 && !isSalesView({ name: '', role: '销售' }))
  ok('a9 姓名两侧空白归一（trim）', filterByOwner([{ id: 9, owner_sales: ' 张三 ' }], sales).length === 1)

  // ─── b. 合同 owner 推导（contract 无 owner_sales 列，JOIN account 带出）────
  const accId = crmDbService.create('account', { name: '合同测试客户', owner_sales: '张三', created_at: Date.now(), imported_at: Date.now() })
  const accId2 = crmDbService.create('account', { name: '未归属客户', owner_sales: '', created_at: Date.now(), imported_at: Date.now() })
  const c1 = crmDbService.create('contract', { account_id: accId, name: '合同一', amount: 1000, status: 'signed', created_at: Date.now(), updated_at: Date.now() })
  crmDbService.create('contract', { account_id: accId2, name: '合同二', amount: 2000, status: 'pending_sign', created_at: Date.now(), updated_at: Date.now() })
  void c1
  const wb = crmDbService.workbench()
  const wb1 = wb.find((r) => String(r.name) === '合同一')
  const wb2 = wb.find((r) => String(r.name) === '合同二')
  ok('b1 workbench 合同行带 owner_sales（经 account JOIN）', !!wb1 && String(wb1.owner_sales) === '张三')
  ok('b2 未归属合同 owner_sales 为空串', !!wb2 && String(wb2.owner_sales || '') === '')
  const wbVis = filterByOwner(wb as any, sales)
  ok('b3 合同页过滤口径：本人合同+未归属合同可见', wbVis.some((r) => String(r.name) === '合同一') && wbVis.some((r) => String(r.name) === '合同二') && wbVis.length === 2 && wb.length === 2)
  // 归属改到别人后不可见（owner 三列 SSOT 驱动，过滤随之）
  crmDbService.update('account', Number(accId), { owner_sales: '李四' })
  ok('b4 owner 改派后过滤即时生效（SSOT=account.owner_sales）', filterByOwner(crmDbService.workbench() as any, sales).length === 1)

  // ─── c. 三页面静态接线断言 ─────────────────────────────────────────────────
  for (const [file, tag] of [['src/pages/CustomerWorkspacePage.tsx', '客户页'], ['src/pages/OpportunityPage.tsx', '商机页'], ['src/pages/CrmWorkbenchPage.tsx', '合同工作台']] as const) {
    const src = readFileSync(join(ROOT, file), 'utf-8')
    ok(`c1 ${tag} import filterByOwner`, src.includes('filterByOwner'))
    ok(`c2 ${tag} 身份已加载（identity.get）`, src.includes('identity.get'))
    ok(`c3 ${tag} 销售视角提示行`, src.includes('仅显示我名下及未归属的数据') && src.includes('isSalesView'))
  }
  const dbSrc = readFileSync(join(ROOT, 'electron/services/crmDbService.ts'), 'utf-8')
  ok('c4 合同 SQL 带 owner 字段（LEFT JOIN account.owner_sales）', dbSrc.includes('a.owner_sales AS owner_sales FROM contract c LEFT JOIN account a'))
  const scssSrc = readFileSync(join(ROOT, 'src/styles/main.scss'), 'utf-8')
  ok('c5 提示行样式零硬编码 hex（--color-* 族）', scssSrc.includes('.owner-filter-hint') && !/\.owner-filter-hint\s*\{[^}]*#[0-9a-fA-F]{3,8}/.test(scssSrc))
  // 写路径零改动：filterByOwner 只读过滤（静态：filterByOwner 函数体无 set/update/create 调用）
  const viewSrc = readFileSync(join(ROOT, 'src/utils/leadAssignmentView.ts'), 'utf-8')
  const fnBody = viewSrc.slice(viewSrc.indexOf('export function filterByOwner'))
  ok('c6 filterByOwner 零写路径（纯过滤）', !/[.](set|update|create)\(/.test(fnBody))

  console.log(`\nowner-filter-test: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

void main()
