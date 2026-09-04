/**
 * crmOwnershipService.ts —— owner 归属维护（宪法 §1.7/§1.8，PRD §1.9 离职移交）
 *
 * 归属 SSOT：lead 维度 = assignment 表；客户/商机/物流维度 = owner_sales 三列
 * （account / opportunity / logistics，术语表：同口径，不允许第四处出现）。
 * 归属变更 = C 档人工动作，一律留痕：owner_sales 回写 + ownership_history + audit_event 同事务。
 *
 * 离职移交（PRD §1.9「本地直改 + 批量移交（复用线索移交逻辑）」）：
 *   ① lead 维度：该销售全部有效分配**循环调 transferAssignment**（API 契约原文
 *      「离职移交批量走本端点循环，不复活旧 reassign」），reason='离职'，逐条独立事务，
 *      单条失败不阻塞其余（与 SLA 回收器同模式）；每条自带 ownership_history + audit + outbox。
 *   ② owner 三列：account/opportunity/logistics 的 owner_sales 从离职人直改接手人，
 *      **同一事务**内逐行写 ownership_history(reason='离职') + audit_event。
 *   ③ 汇总审计 action='departure_handoff_summary'（entity_type='sales'）。
 */
import { crmDbService } from './crmDbService'
import { getActorLabel } from './identityService'
import { ConfigService } from './config'
import { transferAssignment } from './crmAssignmentService'

export interface DepartureData {
  fromSales: string
  toSales: string
  /** lead 维度：成功移交的分配行数 + 逐条失败清单（不阻塞） */
  leadsTransferred: number
  leadFailed: Array<{ assignmentId: number; code: string; message: string }>
  /** owner 三列各表改写行数 */
  accounts: number
  opportunities: number
  logistics: number
}
export interface DepartureResult { ok: boolean; data?: DepartureData; code?: string; message?: string }

/** owner_sales 三列的物理表清单（术语表钦定三处）；logistics 无 updated_at 列只改归属 */
const OWNER_TABLES = [
  { table: 'account', entityType: 'account', touch: true },
  { table: 'opportunity', entityType: 'opportunity', touch: true },
  { table: 'logistics', entityType: 'logistics', touch: false }
] as const

/**
 * 离职移交：fromSales 的全部归属（lead 分配 + owner 三列）批量移交给 toSales。
 * E101 参数缺失/同人；E203 接手人不在 config crmSalesList（与 transferAssignment 同口径）。
 * actor 兜底链：显式 > 身份档案 getActorLabel() > 「分配员」（仅署名，宪法 §1.12）。
 */
export function departureHandoff(fromSales: string, toSales: string, actor?: string): DepartureResult {
  const from = String(fromSales || '').trim()
  const target = String(toSales || '').trim()
  if (!from || !target) return { ok: false, code: 'E101', message: 'fromSales 与 toSales 必填' }
  if (from === target) return { ok: false, code: 'E101', message: '离职人与接手人不能是同一人' }
  const salesList = ConfigService.getInstance().get('crmSalesList')
  if (!Array.isArray(salesList) || !salesList.map((s) => String(s).trim()).includes(target)) {
    return { ok: false, code: 'E203', message: `接手销售不存在（${target} 不在销售名单）` }
  }
  const by = String(actor || '').trim() || getActorLabel() || '分配员'
  const now = Date.now()

  const data: DepartureData = {
    fromSales: from, toSales: target,
    leadsTransferred: 0, leadFailed: [], accounts: 0, opportunities: 0, logistics: 0
  }

  // ① lead 维度：循环 transferAssignment（契约原文），reason='离职'。
  //    逐条独立事务：单条失败（如刚被回收）计入 leadFailed 不阻塞其余。
  const actives = crmDbService.all(
    "SELECT id FROM assignment WHERE deleted = 0 AND sales_name = ? AND status IN ('assigned','claimed') ORDER BY id",
    [from]
  )
  for (const row of actives) {
    const res = transferAssignment(Number(row.id), target, '离职', by)
    if (res.ok) data.leadsTransferred++
    else data.leadFailed.push({ assignmentId: Number(row.id), code: String(res.code || ''), message: String(res.message || '') })
  }

  // ② owner 三列：同一事务直改 + 逐行 ownership_history(reason='离职') + audit_event
  crmDbService.runTx((tx) => {
    for (const { table, entityType, touch } of OWNER_TABLES) {
      const rows = tx.all(`SELECT id FROM ${table} WHERE owner_sales = ?`, [from])
      for (const r of rows) {
        if (touch) tx.run(`UPDATE ${table} SET owner_sales = ?, updated_at = ? WHERE id = ?`, [target, now, Number(r.id)])
        else tx.run(`UPDATE ${table} SET owner_sales = ? WHERE id = ?`, [target, Number(r.id)])
        tx.run('INSERT INTO ownership_history (entity_type, entity_id, old_owner, new_owner, reason, actor, created_at) VALUES (?,?,?,?,?,?,?)',
          [entityType, Number(r.id), from, target, '离职', by, now])
        tx.run('INSERT INTO audit_event (actor, action, entity_type, entity_id, detail, created_at) VALUES (?,?,?,?,?,?)',
          [by, 'departure_handoff', entityType, Number(r.id), JSON.stringify({ fromSales: from, toSales: target, reason: '离职' }), now])
      }
      if (entityType === 'account') data.accounts = rows.length
      else if (entityType === 'opportunity') data.opportunities = rows.length
      else data.logistics = rows.length
    }
    // ③ 汇总审计（同事务）
    tx.run('INSERT INTO audit_event (actor, action, entity_type, entity_id, detail, created_at) VALUES (?,?,?,?,?,?)',
      [by, 'departure_handoff_summary', 'sales', null, JSON.stringify({
        fromSales: from, toSales: target,
        leadsTransferred: data.leadsTransferred, leadFailed: data.leadFailed.length,
        accounts: data.accounts, opportunities: data.opportunities, logistics: data.logistics
      }), now])
  })
  return { ok: true, data }
}
