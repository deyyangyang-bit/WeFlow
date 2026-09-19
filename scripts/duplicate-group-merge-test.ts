/**
 * duplicate-group-merge-test.ts —— H7 回归测试：重复组成员合并与内容摘要纯函数
 *
 * central/src/duplicateGroup.ts 是 PostgreSQL 与 memory 两套存储的**唯一**合并/摘要实现。
 * 验证：
 *   ① 成员永久累积（第三成员不覆盖第二成员）+ 按 customerRef 去重 + 稳定排序；
 *   ② ownerSales 用最新可得值更新，查不到（''）不清空已有非空值；
 *   ③ 摘要：成员集合或 ownerSales 变化 → 摘要变化；内容不变 → 摘要稳定；
 *   ④ 事件标识：幂等键/eventId 含摘要（同成员数不同内容 → 不同键）；aggregateVersion 单调。
 * 运行：npx tsx scripts/duplicate-group-merge-test.ts
 */
import {
  mergeDuplicateGroupMembers, duplicateGroupDigest, duplicateGroupEventIdentity, duplicateGroupGroupId
} from '../central/src/duplicateGroup'

let pass = 0, fail = 0
function ok(name: string, cond: boolean): void {
  if (cond) { pass++ } else { fail++; console.error('FAIL:', name) }
}

const A = { customerRef: 'dev-a/customer:1', ownerSales: '张三' }
const B = { customerRef: 'dev-b/customer:2', ownerSales: '' }
const B2 = { customerRef: 'dev-b/customer:2', ownerSales: '李四' }
const C = { customerRef: 'dev-c/customer:3', ownerSales: '' }

// ── ① 成员累积合并 ──
const two = mergeDuplicateGroupMembers([], [A, B])
ok('1a 首次登记两成员', two.length === 2)
const three = mergeDuplicateGroupMembers(two, [C, A])
ok('1b 第三成员累积（不覆盖第二成员）', three.length === 3 &&
  three.some((m) => m.customerRef === A.customerRef) &&
  three.some((m) => m.customerRef === B.customerRef) &&
  three.some((m) => m.customerRef === C.customerRef))
ok('1c 稳定排序（customerRef 字典序）', three[0].customerRef === A.customerRef &&
  three[1].customerRef === B.customerRef && three[2].customerRef === C.customerRef)
ok('1d 重复登记同一成员去重', mergeDuplicateGroupMembers(three, [A, B, C]).length === 3)
ok('1e 非法成员（空 ref）被忽略', mergeDuplicateGroupMembers([], [{ customerRef: '', ownerSales: 'x' } as never]).length === 0)

// ── ② ownerSales 更新语义 ──
const refreshed = mergeDuplicateGroupMembers([A, B], [A, B2])
ok('2a 最新值更新（B 空 → 李四）', refreshed.find((m) => m.customerRef === B.customerRef)?.ownerSales === '李四')
const kept = mergeDuplicateGroupMembers([A, B2], [A, B])
ok('2b 查不到 owner（空）不清空已有非空值', kept.find((m) => m.customerRef === B.customerRef)?.ownerSales === '李四')
const sameOwner = mergeDuplicateGroupMembers([A, B2], [A, B2])
ok('2c 同值幂等', duplicateGroupDigest(sameOwner) === duplicateGroupDigest([A, B2]))

// ── ③ 摘要 ──
ok('3a 内容不变摘要稳定', duplicateGroupDigest([A, B]) === duplicateGroupDigest([A, B]))
ok('3b 成员集合变化 → 摘要变化', duplicateGroupDigest([A, B]) !== duplicateGroupDigest([A, B, C]))
ok('3c 成员数相同但 ownerSales 变化 → 摘要变化',
  duplicateGroupDigest([A, B]) !== duplicateGroupDigest([A, B2]))
ok('3d 摘要为 16 hex', /^[0-9a-f]{16}$/.test(duplicateGroupDigest([A, B])))
ok('3e 输入顺序不影响摘要（canonical 排序）', duplicateGroupDigest([B, A]) === duplicateGroupDigest([A, B]))

// ── ④ 事件标识 ──
const id1 = duplicateGroupEventIdentity('phone', 'h'.repeat(64), duplicateGroupDigest([A, B]), 2)
const id2 = duplicateGroupEventIdentity('phone', 'h'.repeat(64), duplicateGroupDigest([A, B, C]), id1.aggregateVersion)
const id3 = duplicateGroupEventIdentity('phone', 'h'.repeat(64), duplicateGroupDigest([A, B2]), id1.aggregateVersion)
ok('4a 幂等键含摘要（成员集合变化 → 新键）', id1.idempotencyKey !== id2.idempotencyKey && id1.idempotencyKey.includes(id1 === id2 ? '~' : duplicateGroupDigest([A, B])))
ok('4b 成员数相同但内容变化 → 新键', id1.idempotencyKey !== id3.idempotencyKey)
ok('4c eventId 含摘要且与幂等键同族', id1.eventId !== id2.eventId && id1.eventId.startsWith('dupgroup-'))
ok('4d aggregateVersion 单调递增且 ≥2', id2.aggregateVersion === id1.aggregateVersion + 1 && id1.aggregateVersion >= 2)
ok('4e 组实体键形态', duplicateGroupGroupId('phone', 'h'.repeat(64)) === `dupgroup:phone:${'h'.repeat(64)}`)

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)
