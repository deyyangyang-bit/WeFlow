import { createHash, randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { atomicWriteFileSync } from '../atomicPersist'
export interface UsageContext { purpose?: string; trigger?: string; promptVersion?: string }
export interface UsageRow {
  id: string; at: number; model: string; purpose: string; trigger: string; promptVersion: string
  durationMs: number; finishReason: string; status: string
  inputTokens: number | null; cachedInputTokens: number | null; outputTokens: number | null; reasoningTokens: number | null
}
let directory = ''
let scopeProvider: () => string = () => ''
export function configureAiUsageLedger(root: string, provider: () => string): void { directory = join(root, 'ai-usage'); scopeProvider = provider }
const token = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
export function normalizeUsage(usage: any): Pick<UsageRow, 'inputTokens' | 'cachedInputTokens' | 'outputTokens' | 'reasoningTokens'> {
  return { inputTokens: token(usage?.prompt_tokens ?? usage?.input_tokens), cachedInputTokens: token(usage?.prompt_tokens_details?.cached_tokens ?? usage?.prompt_cache_hit_tokens ?? usage?.input_tokens_details?.cached_tokens), outputTokens: token(usage?.completion_tokens ?? usage?.output_tokens), reasoningTokens: token(usage?.completion_tokens_details?.reasoning_tokens ?? usage?.output_tokens_details?.reasoning_tokens) }
}
function fileFor(scope: string): string { return join(directory, `${createHash('sha256').update(scope).digest('hex')}.json`) }
export function readAiUsage(): UsageRow[] {
  const scope = scopeProvider()
  if (!directory || !scope) return []
  const file = fileFor(scope)
  if (!existsSync(file)) return []
  const data = JSON.parse(readFileSync(file, 'utf8'))
  if (!Array.isArray(data)) throw new Error('用量账本格式无效')
  return data
}
/**
 * 记录一条「被额度阻断、未发出请求」的账本行。
 * tokens 一律 null（不是 0）——本次没有消耗，但也不能被读成「零成本调用」。
 * 该行会出现在 coverage 的缺口统计里（PRD §5.5「被阻断的事件计入覆盖缺口展示」）。
 */
export function recordBlockedCall(model: string, context: UsageContext = {}, error: string = ''): void {
  const scope = scopeProvider(), root = directory
  if (!root || !scope) return
  const file = join(root, `${createHash('sha256').update(scope).digest('hex')}.json`)
  const row: UsageRow = {
    id: randomUUID(), at: Date.now(), model, purpose: context.purpose || 'unclassified',
    trigger: context.trigger || 'unspecified', promptVersion: context.promptVersion || 'legacy',
    durationMs: 0, finishReason: error || 'budget_blocked', status: 'blocked',
    inputTokens: null, cachedInputTokens: null, outputTokens: null, reasoningTokens: null
  }
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 })
    const previous = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : []
    if (!Array.isArray(previous)) throw new Error('用量账本格式无效')
    atomicWriteFileSync(file, Buffer.from(JSON.stringify([...previous, row])))
  } catch { console.warn('[AiUsage] 阻断记录写入失败；额度拦截已生效，但缺口统计会少一行') }
}

/** Closure binds original account before HTTP starts; no customer data is logged. */
export function startUsage(model: string, context: UsageContext = {}): (usage: unknown, finish: string, status: string) => void {
  const scope = scopeProvider(), root = directory, at = Date.now(), id = randomUUID()
  let settled = false
  return (usage, finishReason, status) => {
    if (settled) return
    settled = true
    if (!root || !scope) return
    const file = join(root, `${createHash('sha256').update(scope).digest('hex')}.json`)
    const row: UsageRow = { id, at, model, purpose: context.purpose || 'unclassified', trigger: context.trigger || 'unspecified', promptVersion: context.promptVersion || 'legacy', durationMs: Date.now() - at, finishReason, status, ...normalizeUsage(usage) }
    try {
      mkdirSync(root, { recursive: true, mode: 0o700 })
      const previous = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : []
      if (!Array.isArray(previous)) throw new Error('用量账本格式无效')
      atomicWriteFileSync(file, Buffer.from(JSON.stringify([...previous, row])))
    } catch { console.warn('[AiUsage] 用量记账失败；本次不可计为零用量') }
  }
}
