/**
 * crm-delivery-view-test.ts —— 交付售后展示投影行为回归
 *
 * 不挂载 React/DOM；直接使用页面实际复用的 deliveryAftersalesView 纯函数，
 * 并用受控 Promise 模拟 fetchAll 的请求序号门禁。测试的是数据投影和异步
 * 提交行为，不是源码正则。
 *
 * 运行：npx tsx scripts/crm-delivery-view-test.ts
 */
import {
  buildCustomerOwners,
  countWonByCustomerKey,
  customerVisibleForOwner,
  filterByOwner,
  filterCustomerTasks
} from '../src/utils/deliveryAftersalesView'
import type { IdentityLike } from '../shared/ownerFilter'

type Deal = { id: number; account_id: number; owner_sales: string; key: string }
type Task = { id: number; source_id: number; title: string }

let pass = 0
let fail = 0
function ok(name: string, condition: boolean): void {
  if (condition) pass++
  else { fail++; console.error(`FAIL: ${name}`) }
}

const salesA: IdentityLike = { name: '销售甲', role: '销售' }
const salesB: IdentityLike = { name: '销售乙', role: '销售' }
const manager: IdentityLike = { name: '主管', role: '主管' }

async function main(): Promise<void> {
  console.log('═══ A. 全量成交计数与销售视角展示解耦 ═══')
  const deals: Deal[] = [
    { id: 1, account_id: 101, owner_sales: '销售甲', key: 'c:7' },
    { id: 2, account_id: 102, owner_sales: '销售乙', key: 'c:7' },
    { id: 3, account_id: 103, owner_sales: '', key: 'c:7' },
    { id: 4, account_id: 104, owner_sales: '销售甲', key: 'a:104' }
  ]
  const allCounts = countWonByCustomerKey(deals, (d) => d.key)
  const visibleA = filterByOwner(deals, salesA)
  const visibleB = filterByOwner(deals, salesB)
  ok('A1 销售甲只看本人/未归属成交', visibleA.map((d) => d.id).join(',') === '1,3,4')
  ok('A2 销售乙只看本人/未归属成交', visibleB.map((d) => d.id).join(',') === '2,3')
  ok('A3 复购计数使用全量成交而非过滤后的展示行', allCounts.get('c:7') === 3)
  ok('A4 过滤后仍可投影全量客户复购等级输入', allCounts.get('c:7') === 3 && visibleA.filter((d) => d.key === 'c:7').length === 2)

  console.log('\n═══ B. 多 account 同 customer 的任务归属顺序不变量 ═══')
  const accountsForward = [
    { customer_id: 7, owner_sales: '销售乙' },
    { customer_id: 7, owner_sales: '销售甲' },
    { customer_id: 8, owner_sales: '销售乙' },
    { customer_id: 9, owner_sales: '' }
  ]
  const accountsReverse = [...accountsForward].reverse()
  const ownersForward = buildCustomerOwners(accountsForward)
  const ownersReverse = buildCustomerOwners(accountsReverse)
  const customerTasks: Task[] = [
    { id: 11, source_id: 7, title: '同 customer 任务' },
    { id: 12, source_id: 8, title: '乙任务' },
    { id: 13, source_id: 9, title: '未归属任务' },
    { id: 14, source_id: 99, title: '未知 customer 任务' }
  ]
  ok('B1 同 customer 多 account 合并为 owner 集合', ownersForward.get(7)?.size === 2)
  ok('B2 account 输入顺序不改变销售甲任务可见性',
    JSON.stringify(filterCustomerTasks(customerTasks, ownersForward, salesA)) ===
    JSON.stringify(filterCustomerTasks(customerTasks, ownersReverse, salesA)))
  ok('B3 销售甲可见同 customer/未归属/未知 customer，不可见乙独占',
    filterCustomerTasks(customerTasks, ownersForward, salesA).map((t) => t.id).join(',') === '11,13,14')
  ok('B4 销售乙可见同 customer/乙/未归属/未知 customer',
    filterCustomerTasks(customerTasks, ownersForward, salesB).map((t) => t.id).join(',') === '11,12,13,14')
  ok('B5 主管视角保留全部任务', filterCustomerTasks(customerTasks, ownersForward, manager).length === 4)
  ok('B6 customer owner 集合不会被后出现的 account 覆盖',
    customerVisibleForOwner(ownersForward, 7, salesA) && customerVisibleForOwner(ownersForward, 7, salesB))

  console.log('\n═══ C. 无身份时不发查询，旧请求不能覆盖新请求 ═══')
  let queryCalls = 0
  const queried: string[] = []
  const query = async (label: string, value: string, delayMs: number): Promise<string> => {
    queryCalls++
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs))
    queried.push(label)
    return value
  }

  // 这是 fetchAll 的最小受控 seam：身份缺失直接返回；每次请求提交前检查序号。
  let requestSeq = 0
  let committed = ''
  const load = async (identity: IdentityLike | null, label: string, delayMs: number): Promise<void> => {
    if (!identity) return
    const seq = ++requestSeq
    const value = await query(label, label, delayMs)
    if (seq !== requestSeq) return
    committed = value
  }
  await load(null, 'no-identity', 0)
  ok('C1 初始无身份不发任何查询', queryCalls === 0 && queried.length === 0)
  const old = load(salesA, 'old', 30)
  await new Promise<void>((resolve) => setTimeout(resolve, 1))
  const fresh = load(salesB, 'fresh', 1)
  await Promise.all([old, fresh])
  ok('C2 新请求先完成后，旧请求结果不覆盖新数据', committed === 'fresh')
  ok('C3 受控竞态确实执行了旧/新两个真实异步查询', queryCalls === 2 && queried.includes('old') && queried.includes('fresh'))

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  process.exit(fail ? 1 : 0)
}

void main()
