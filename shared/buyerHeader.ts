/**
 * 甲方抬头粘贴解析（《合同与报价录入加速 PRD v1.4》§7.2）。
 *
 * 纯确定性规则：不调用 AI、不做模糊推断、不猜测组合标签的字段归属。
 * 输入是销售粘贴进来的一段文本，不是客户原始文件（§7.2.6）。
 */

export interface BuyerHeader {
  buyerName?: string
  addr?: string
  bank?: string
  account?: string
  taxNo?: string
  phone?: string
}

/** 命中的组合标签原文及其覆盖字段（§7.2.3） */
export interface ComboHit {
  raw: string
  covers: Array<keyof BuyerHeader>
}

export interface BuyerHeaderParseResult {
  fields: BuyerHeader
  comboHits: ComboHit[]
}

/** 展示用字段名，供成功提示与测试共用（§7.2.5） */
export const BUYER_HEADER_FIELD_LABELS: Record<keyof BuyerHeader, string> = {
  buyerName: '单位名称',
  taxNo: '税号',
  addr: '地址',
  phone: '电话',
  bank: '开户银行',
  account: '账号',
}

/** §7.2.2 别名表：整行精确匹配，支持“名称”，不支持“产品名称”等非别名标签 */
const FIELD_ALIASES: Record<keyof BuyerHeader, readonly string[]> = {
  buyerName: ['名称', '单位名称', '公司名称', '客户名称', '甲方'],
  taxNo: ['税号', '纳税人识别号', '纳税人识别码', '统一社会信用代码'],
  addr: ['地址', '单位地址', '注册地址'],
  phone: ['电话', '电话号码', '联系电话'],
  bank: ['开户银行', '开户行', '开户行名称', '银行'],
  account: ['账号', '帐号', '银行账号', '银行帐号', '开户账号'],
}

/** §7.2.3 组合标签：只识别不拆分，命中后不写入任何字段值，不计入已识别字段数 */
const COMBO_ALIASES: ReadonlyArray<{
  labels: readonly string[]
  covers: Array<keyof BuyerHeader>
}> = [
  { labels: ['地址、电话', '地址及电话', '地址电话'], covers: ['addr', 'phone'] },
  { labels: ['开户行及账号', '开户银行及账号', '开户行账号'], covers: ['bank', 'account'] },
]

/** §7.2.4 第 8 条：这三类值的内部分段不携带语义，去除全部空白 */
const STRIP_INNER_WHITESPACE: ReadonlySet<keyof BuyerHeader> = new Set(['taxNo', 'account', 'phone'])

/** JS 的 \s 覆盖普通空格、Tab、全角空格（U+3000）与换行，与 §7.2.4 第 5、8 条口径一致 */
const WHITESPACE = /\s/g

/** §7.2.4 第 4 条：标签长度上限 */
const MAX_LABEL_LENGTH = 12

const LABEL_TO_FIELD = new Map<string, keyof BuyerHeader>()
for (const key of Object.keys(FIELD_ALIASES) as Array<keyof BuyerHeader>) {
  for (const label of FIELD_ALIASES[key]) LABEL_TO_FIELD.set(label, key)
}

const LABEL_TO_COVERS = new Map<string, Array<keyof BuyerHeader>>()
for (const combo of COMBO_ALIASES) {
  for (const label of combo.labels) LABEL_TO_COVERS.set(label, combo.covers)
}

/** 标签归一化：去全部空白后精确匹配（§7.2.4 第 5 条） */
function normalizeLabel(rawLabel: string): string | null {
  if (rawLabel.length > MAX_LABEL_LENGTH) return null
  return rawLabel.replace(WHITESPACE, '')
}

/** 值归一化：去首尾空白与 \r；内部空白按字段区分（§7.2.4 第 8 条） */
function normalizeValue(field: keyof BuyerHeader, rawValue: string): string {
  const trimmed = rawValue.replace(/\r/g, '').trim()
  return STRIP_INNER_WHITESPACE.has(field) ? trimmed.replace(WHITESPACE, '') : trimmed
}

type LabelHit =
  | { kind: 'field'; field: keyof BuyerHeader }
  | { kind: 'combo'; covers: Array<keyof BuyerHeader> }
  | { kind: 'none' }

/** 判定一段文本是否是已知标签（字段标签或组合标签） */
function classifyLabel(rawLabel: string): LabelHit {
  const label = normalizeLabel(rawLabel)
  if (!label) return { kind: 'none' }
  const covers = LABEL_TO_COVERS.get(label)
  if (covers) return { kind: 'combo', covers }
  const field = LABEL_TO_FIELD.get(label)
  return field ? { kind: 'field', field } : { kind: 'none' }
}

/** 取本行的标签部分：有冒号取冒号前，无冒号取整行（§7.2.4 第 2、9 条） */
function labelOf(line: string): { hit: LabelHit; colon: number } {
  const colon = line.search(/[:：]/)
  return { hit: classifyLabel(colon >= 0 ? line.slice(0, colon) : line), colon }
}

/** 每个字段只接受第一个非空值（§7.2.4 第 12 条） */
function assign(fields: BuyerHeader, field: keyof BuyerHeader, value: string): void {
  if (!value || fields[field] != null) return
  fields[field] = value
}

/**
 * 解析粘贴的甲方抬头文本。识别到的字段数可能为 0：此时 `fields` 为空对象，
 * 调用方按 `comboHits` 是否为空区分「完全未识别」与「仅命中组合标签」（§7.2.4 第 14 条）。
 */
export function parseBuyerHeader(text: string): BuyerHeaderParseResult {
  const fields: BuyerHeader = {}
  const comboHits: ComboHit[] = []
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
  let pending: keyof BuyerHeader | null = null

  for (const line of lines) {
    const { hit, colon } = labelOf(line)

    if (pending) {
      // 第 11 条：下一行自身是已知标签时放弃当前空值，且不消费该行
      if (hit.kind !== 'none') {
        pending = null
      } else {
        assign(fields, pending, normalizeValue(pending, line))
        pending = null
        continue
      }
    }

    if (hit.kind === 'combo') {
      // 第 7 条：记录原文与覆盖字段，不写入任何值，继续处理下一行
      comboHits.push({ raw: line, covers: hit.covers })
      continue
    }
    if (hit.kind === 'none') continue // 第 13 条：未识别行跳过，不报错
    if (colon < 0) {
      pending = hit.field // 第 9 条：无冒号且整行匹配标签，等待下一行值
      continue
    }
    const value = normalizeValue(hit.field, line.slice(colon + 1))
    if (!value) {
      pending = hit.field // 第 10 条：冒号后为空，允许读取下一行作为值
      continue
    }
    assign(fields, hit.field, value)
  }

  return { fields, comboHits }
}

/** 已识别字段数（§7.2.4 第 14 条：为 0 即失败） */
export function recognizedFieldCount(result: BuyerHeaderParseResult): number {
  return (Object.keys(result.fields) as Array<keyof BuyerHeader>).filter(
    (key) => result.fields[key] != null && result.fields[key] !== ''
  ).length
}

/**
 * 解析结论（§7.2.4 第 14 条 / §10.1）：把「是否失败、失败属哪一种」连同提示文案一起
 * 收在共享层，调用方不再自行判定——两处粘贴入口（新建合同 / 合同详情）各写一套私有
 * 约定与各抄一份文案，正是 §7.2.1 警告过的后果。
 */
export interface BuyerHeaderOutcome {
  ok: boolean
  /** 失败种类：unrecognized=完全未识别；combo_only=仅命中组合标签（须提示手工拆分） */
  failure?: 'unrecognized' | 'combo_only'
  /** 可直接展示的提示；ok 时为空串（成功提示由调用方按实际回填字段生成） */
  message: string
}

/** §7.2.5 两条失败提示原文；仅命中组合标签时一条同时说明未识别与待拆分 */
const FAILURE_MESSAGES: Record<'unrecognized' | 'combo_only', string> = {
  unrecognized: '没识别到抬头信息，请手动填写。',
  combo_only: '没识别到可用的抬头字段，且检测到合并字段，请手工拆分后填写。',
}

export function buyerHeaderOutcome(result: BuyerHeaderParseResult): BuyerHeaderOutcome {
  if (recognizedFieldCount(result) > 0) return { ok: true, message: '' }
  const failure = result.comboHits.length > 0 ? 'combo_only' : 'unrecognized'
  return { ok: false, failure, message: FAILURE_MESSAGES[failure] }
}
