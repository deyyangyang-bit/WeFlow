import { filterByOwner, isSalesView, type IdentityLike } from './leadAssignmentView'

export interface DeliveryAccountOwner {
  customer_id?: number
  owner_sales?: string | null
}

export function buildCustomerOwners(accounts: DeliveryAccountOwner[]): Map<number, Set<string>> {
  const out = new Map<number, Set<string>>()
  for (const account of accounts) {
    const customerId = Number(account.customer_id || 0)
    if (customerId <= 0) continue
    const owners = out.get(customerId) || new Set<string>()
    owners.add(String(account.owner_sales || '').trim())
    out.set(customerId, owners)
  }
  return out
}

export function customerVisibleForOwner(customerOwners: Map<number, Set<string>>, customerId: number, identity: IdentityLike): boolean {
  if (!isSalesView(identity)) return true
  const owners = customerOwners.get(Number(customerId))
  if (!owners || owners.size === 0) return true
  const me = identity.name.trim()
  return [...owners].some((owner) => !owner || owner === me)
}

export function countWonByCustomerKey<T>(deals: T[], keyOf: (deal: T) => string): Map<string, number> {
  const counts = new Map<string, number>()
  for (const deal of deals) {
    const key = keyOf(deal)
    counts.set(key, (counts.get(key) || 0) + 1)
  }
  return counts
}

export function filterCustomerTasks<T extends { source_id: number }>(
  tasks: T[],
  customerOwners: Map<number, Set<string>>,
  identity: IdentityLike
): T[] {
  if (!isSalesView(identity)) return tasks
  return tasks.filter((task) => customerVisibleForOwner(customerOwners, Number(task.source_id), identity))
}

export { filterByOwner }
