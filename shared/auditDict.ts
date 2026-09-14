/**
 * auditDict.ts —— 审计动作词典：audit_event.action（库值）→ 人话（**唯一事实源**）
 *
 * 纯函数，零 IO、零依赖、零 React（electron 主进程与 renderer 共用）。
 * 设计依据：`weflow-审计与迁移报告人话化-设计稿-20260913.html` §03（动作词典）/§04（交互规则）。
 *
 * 三条纪律（违反即为回归）：
 *   1. **词典必须覆盖现存全部 action**：写点全量枚举见
 *      `docs/实施记录/审计与迁移报告人话化-实施记录-claude-20260913.md`；
 *      `scripts/audit-dict-test.ts` 从源码反查并守卫（漏收录 → 测试红）。
 *   2. **任何 detail 值进界面前必须过 `fmtVal`**：对象/数组一律 JSON.stringify，
 *      禁止 `String(对象)` 产生 `[object Object]`（静态断言防回归）。
 *   3. **未收录的 action 降级展示原文 + 「未翻译」标记**，不允许静默乱码。
 *
 * 时间口径：`audit_event.created_at` 与 `detail.deadline` 均为**毫秒**
 * （写入处一律 `Date.now()` 或数值列，见 crmAssignmentService.sla1_remind 写点）。
 */

/** pill 色调（沿用设置页五语义 + 中性） */
export type AuditTone = 'remind' | 'assign' | 'recycle' | 'config' | 'bind' | 'neutral'

/** 可解析为可点击对象的实体类型（仅这几类有稳定深链，见 AuditTrailSection.entityHref） */
export type AuditEntityKind = 'lead' | 'account' | 'customer'

/** 人话整句的一片段：纯文本 / 加粗 / 可点击实体 / 灰色后缀 */
export type DetailPart =
  | { kind: 'text'; text: string }
  | { kind: 'strong'; text: string }
  | { kind: 'entity'; entityType: AuditEntityKind; id: number }
  | { kind: 'muted'; text: string }

/** 渲染上下文：行级实体（对象名需从 entity_id 反解时用） */
export interface DescribeCtx {
  entityType: string
  entityId: number | null
}

export type DetailRecord = Record<string, unknown>

export interface AuditDictEntry {
  /** pill 文案 */
  label: string
  /** pill 色调；需要随 detail 变化时用 `toneOf` 覆盖 */
  tone: AuditTone
  /** 动态色调（如备份成功/失败），未提供时用 `tone` */
  toneOf?: (d: DetailRecord) => AuditTone
  /** detail（已解析对象）→ 人话整句片段 */
  describe: (d: DetailRecord, ctx: DescribeCtx) => DetailPart[]
  /** 批量合并行的标题（缺省用通用模板） */
  batch?: (d: DetailRecord, n: number) => string
}

// ─── 取值助手（detail 来自库，按不可信输入处理）─────────────────────────────

/** 解析 detail：对象原样；JSON 字符串解析；其余 → {}（非对象 detail 由调用方按原文兜底） */
export function parseDetail(detail: unknown): DetailRecord {
  if (detail && typeof detail === 'object' && !Array.isArray(detail)) return detail as DetailRecord
  const s = String(detail ?? '').trim()
  if (!s || (s[0] !== '{' && s[0] !== '[')) return {}
  try {
    const o = JSON.parse(s)
    return o && typeof o === 'object' && !Array.isArray(o) ? (o as DetailRecord) : {}
  } catch { return {} }
}

function str(v: unknown, fallback = ''): string {
  const s = String(v ?? '').trim()
  return s || fallback
}

function num(v: unknown, fallback = 0): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function rec(v: unknown): DetailRecord {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as DetailRecord) : {}
}

/** 任意值 → 单行可读文本。**对象/数组一律 JSON.stringify**，杜绝 `[object Object]` */
export function fmtVal(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  try { return JSON.stringify(v) } catch { return String(v) }
}

const p2 = (n: number): string => String(n).padStart(2, '0')

/** 时间戳（毫秒）→ 「M月D日 HH:mm」；0/非法 → 空串 */
export function fmtDateTime(ms: unknown): string {
  const t = num(ms, 0)
  if (t <= 0) return ''
  const d = new Date(t)
  return `${d.getMonth() + 1}月${d.getDate()}日 ${p2(d.getHours())}:${p2(d.getMinutes())}`
}

/** 时间戳（毫秒）→ 「MM-DD HH:mm」（列表时间列） */
export function fmtClock(ms: unknown): string {
  const t = num(ms, 0)
  if (t <= 0) return '-'
  const d = new Date(t)
  return `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`
}

// ─── PII 脱敏（只作用于**字符串叶子**，数值时间戳永不改写）──────────────────
//
// 旧实现把整行 detail 先拍平成字符串再跑手机号正则，长整型时间戳被局部吞掉
// （`1789954204656` → `178****899431`，既不可读也无保护意义）。
// 现口径：只在**字符串值**上打码，时间戳始终以数值渲染，两者互不干扰。

/** 联系方式脱敏：手机号 152****5273；微信号 wxid_ 保留前 7 后 2；其余原样（幂等） */
export function maskContact(v: string): string {
  const phone = v.replace(/1[3-9]\d{9}/g, (m) => `${m.slice(0, 3)}****${m.slice(-4)}`)
  return phone.replace(/wxid_[A-Za-z0-9_-]{4,}/g, (m) => `${m.slice(0, 7)}****${m.slice(-2)}`)
}

/** 递归打码所有字符串叶子（结构保持，数值原样）——detail 进界面前必须过这一步 */
export function redactPii(value: unknown): unknown {
  if (typeof value === 'string') return maskContact(value)
  if (Array.isArray(value)) return value.map(redactPii)
  if (value && typeof value === 'object') {
    const out: DetailRecord = {}
    for (const [k, v] of Object.entries(value as DetailRecord)) out[k] = redactPii(v)
    return out
  }
  return value
}

// ─── 片段构造器 ────────────────────────────────────────────────────────────

const T = (text: string): DetailPart => ({ kind: 'text', text })
const B = (text: string): DetailPart => ({ kind: 'strong', text })
const M = (text: string): DetailPart => ({ kind: 'muted', text })
const E = (entityType: AuditEntityKind, id: number): DetailPart => ({ kind: 'entity', entityType, id })

/** 具备稳定深链的实体类型（其余只展示 `#id`，绝不误链到别的实体） */
const LINKABLE: ReadonlySet<string> = new Set(['lead', 'account', 'customer'])

/**
 * 行级实体引用：可链接对象 → 实体片段（渲染层解析为「线索名」，解析不到回落 `lead #id` 原名）；
 * 不可链接类型 → 灰色 ` #id`；无 id → 空片段。**绝不把非 lead 的 id 当成 lead 链接**。
 */
function rowRef(ctx: DescribeCtx): DetailPart[] {
  const id = num(ctx.entityId, 0)
  const t = str(ctx.entityType)
  if (id > 0 && LINKABLE.has(t)) return [E(t as AuditEntityKind, id)]
  if (id > 0) return [M(` #${id}`)]
  return []
}

/** 通用 detail 渲染：`k: v · k2: v2`（对象值走 fmtVal，绝不 [object Object]） */
function genericParts(d: DetailRecord): DetailPart[] {
  const entries = Object.entries(d)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}: ${fmtVal(v)}`)
  return entries.length ? [T(entries.join(' · '))] : []
}

// ─── 枚举词表（口径来自写入处实况，非设计稿示意）───────────────────────────

/** 分配模式 → 人话（assignment.mode，见 crmAssignmentService） */
const ASSIGN_MODE: Record<string, string> = {
  weight: '按权重', round_robin: '轮询', load: '负载均衡', manual: '手动'
}

/** 回收原因里的机器码 → 人话 */
const RECYCLE_REASON: Record<string, string> = {
  converted_skip: '该线索已转客户，跳过回收'
}

/** SLA2 第二段结论（crmSla2Service.SLA2_VERDICTS） */
const SLA2_VERDICT: Record<string, string> = {
  contacted: '已聊上（客户有回复）',
  need_intervention: '需要人工介入',
  uncertain: '结论不确定，转人工'
}

/** 客户类型（customer.type） */
const CUSTOMER_TYPE: Record<string, string> = { dealer: '经销商', end_user: '终端用户' }

/** 同步事件类型（lanSyncService outbox type） */
const SYNC_TYPE: Record<string, string> = {
  assign: '分配', claim: '认领', recycle: '回收', transfer: '改派',
  transfer_remove: '改派移除', transfer_remove_noop: '改派移除（本机无此线索）',
  recycle_noop: '回收（本机无此线索）'
}

/** 备份触发源（autoBackupService trigger） */
const BACKUP_TRIGGER: Record<string, string> = {
  scheduled: '定时', manual: '手动', startup: '启动', 'pre-restore': '恢复前'
}

/** 备份层状态（manifest.layers.*.status，全量见 autoBackupCore 的 AutoBackupLayerStatus） */
const BACKUP_LAYER: Record<string, string> = {
  ok: '完成',
  skipped_not_configured: '未配置，已跳过',
  skipped_unreachable: '共享目录连不上，已跳过',
  failed: '失败',
  pending: '进行中'
}

/** 词表查值：命中 → 人话；未命中 → 原值（不编造、不留空） */
const lookup = (table: Record<string, string>, raw: unknown, fallback = ''): string => {
  const k = str(raw)
  if (!k) return fallback
  return table[k] || k
}

/** 权重 diff → 「杨青 55→60、李林辉 不变（50）」。兼容两种历史形态 */
function diffText(raw: unknown): string {
  if (!raw) return ''
  // 形态 A（现行写点 main.ts：assignment_weight_change）：[{ key, from, to }]
  if (Array.isArray(raw)) {
    return raw
      .map((it) => {
        const o = rec(it)
        const key = str(o.key)
        if (!key) return ''
        if (o.from === undefined && o.to === undefined) return key
        return fmtVal(o.from) === fmtVal(o.to)
          ? `${key} 不变（${fmtVal(o.to)}）`
          : `${key} ${fmtVal(o.from)}→${fmtVal(o.to)}`
      })
      .filter(Boolean)
      .join('、')
  }
  // 形态 B（旧版/设计稿示意）：{ key: [from, to] | { from, to } | 标量 }
  return Object.entries(rec(raw))
    .map(([k, v]) => {
      if (Array.isArray(v)) return `${k} ${fmtVal(v[0])}→${fmtVal(v[1])}`
      const pair = rec(v)
      if (pair.from !== undefined || pair.to !== undefined) {
        return fmtVal(pair.from) === fmtVal(pair.to)
          ? `${k} 不变（${fmtVal(pair.to)}）`
          : `${k} ${fmtVal(pair.from)}→${fmtVal(pair.to)}`
      }
      return `${k} ${fmtVal(v)}`
    })
    .join('、')
}

/** old/new 两组字段 → 「字段 a→b、字段2 c→d」（只列真正变化的键） */
function changedText(oldV: unknown, newV: unknown): string {
  const o = rec(oldV), n = rec(newV)
  return Object.keys(n)
    .filter((k) => fmtVal(o[k]) !== fmtVal(n[k]))
    .map((k) => `${k} ${fmtVal(o[k]) || '空'}→${fmtVal(n[k]) || '空'}`)
    .join('、')
}

// ─── 迁移报告摘要（migration_0x_* 复用）────────────────────────────────────

/** 迁移概览人话：从 summary 渲染一句可读结论 */
function migrationParts(d: DetailRecord, label: string): DetailPart[] {
  const s = rec(d.summary)
  const total = num(s.total, 0)
  if (!total) return [T(`${label}：本次无待处理数据`)]
  const applied = num(s.applied, 0)
  const already = num(s.alreadyDone, 0)
  const failed = num(s.failed, 0)
  const conflicts = num(s.conflicts, 0)
  return [
    T(`${label}：共 `), B(`${total} 条`), T('，本次处理 '), B(`${applied} 条`),
    T(`、此前已完成 ${already} 条`),
    failed > 0 ? T(`、失败 ${failed} 条`) : T(''),
    conflicts > 0 ? T(`、冲突 ${conflicts} 条`) : T('')
  ]
}

// ─── 词典本体 ──────────────────────────────────────────────────────────────

export const AUDIT_DICT: Record<string, AuditDictEntry> = {
  // ── 分配 / 认领 / 改派 / 回收（宪法 §1.3 归属唯一事实源）──
  lead_assign: {
    label: '分配', tone: 'assign',
    batch: (d, n) => `批量分配 ${n} 条线索${str(d.salesName) ? `给 ${str(d.salesName)}` : ''}`,
    describe: (d, ctx) => {
      const out: DetailPart[] = []
      if (str(d.correction)) out.push(T('纠正误回收：'))
      out.push(T('把线索'), ...rowRef(ctx), T(' 分给 '), B(str(d.salesName, '销售')))
      const mode = lookup(ASSIGN_MODE, d.mode)
      if (mode) out.push(T(`（${mode}）`))
      const dl = fmtDateTime(d.sla1Deadline)
      if (dl) out.push(T(`，首触截止 ${dl}`))
      return out
    }
  },
  lead_claim: {
    label: '认领', tone: 'assign',
    describe: (d, ctx) => [
      B(str(d.salesName, '销售')), T(' 认领了线索'), ...rowRef(ctx),
      ...(str(d.via) === 'sync:up' ? [M('（由终端同步上报）')] : [])
    ]
  },
  lead_transfer: {
    label: '改派', tone: 'assign',
    batch: (d, n) => `批量改派 ${n} 条线索${str(d.toSales) ? `给 ${str(d.toSales)}` : ''}`,
    describe: (d, ctx) => [
      T('把线索'), ...rowRef(ctx), T(' 从 '), B(str(d.fromSales, '原销售')),
      T(' 改派给 '), B(str(d.toSales, '新销售')),
      ...(str(d.reason) ? [T(`（${str(d.reason)}）`)] : [])
    ]
  },
  lead_recycle: {
    label: '回收', tone: 'recycle',
    batch: (d, n) => `批量回收 ${n} 条线索${str(d.salesName) ? `（原属 ${str(d.salesName)}）` : ''}`,
    describe: (d, ctx) => {
      const reason = RECYCLE_REASON[str(d.reason)] || str(d.reason)
      return [
        T('线索'), ...rowRef(ctx),
        str(d.salesName) ? T(` 从 ${str(d.salesName)} 名下回收`) : T(' 被回收'),
        ...(reason ? [T(`：${reason}`)] : [])
      ]
    }
  },
  lead_assign_batch: {
    label: '批量分配', tone: 'assign',
    describe: (d) => {
      const per = Object.entries(rec(d.perSales))
        .map(([k, v]) => `${k} ${fmtVal(v)} 条`)
        .join('、')
      const skipped = num(d.skipped, 0)
      return [
        T('一次性分配 '), B(`${num(d.assigned, 0)} 条`), T('线索（'),
        T(lookup(ASSIGN_MODE, d.mode, '按权重')), T(`），候选共 ${num(d.count, 0)} 条`),
        ...(per ? [T(`；${per}`)] : []),
        ...(skipped > 0 ? [T(`；跳过 ${skipped} 条`)] : [])
      ]
    }
  },

  // ── SLA 第一段：提醒 → 上报主管 → 回收 ──
  sla1_remind: {
    label: '超时提醒', tone: 'remind',
    batch: (d, n) => `批量超时提醒 ${n} 条线索${str(d.salesName) ? `（负责人 ${str(d.salesName)}）` : ''}`,
    describe: (d, ctx) => {
      const dl = fmtDateTime(d.deadline)
      return [
        T('提醒 '), B(str(d.salesName, '销售')), T('：线索'), ...rowRef(ctx),
        T(` 第 ${num(d.remindNo, 1)} 次超时未跟进（共 ${num(d.total, 3)} 次`),
        T(dl ? `，${dl} 截止）` : '）')
      ]
    }
  },
  sla1_supervisor_notify: {
    label: '上报主管', tone: 'remind',
    describe: (d, ctx) => [
      T('线索'), ...rowRef(ctx), T(' 已 '), B(`${num(d.remindCount, 3)} 次`),
      T('提醒未响应，已通知主管'),
      ...(str(d.salesName) ? [T(`（负责人 ${str(d.salesName)}）`)] : [])
    ]
  },
  sla1_misrecycle_correction: {
    label: '误回收纠正', tone: 'config',
    describe: (d) => [
      T('扫描 '), B(`${num(d.total, 0)} 条`), T('被误回收的分配：已纠正 '),
      B(`${num(d.corrected, 0)} 条`),
      T(`，${num(d.alreadyAssigned, 0)} 条本就有归属（SLA ${num(d.slaHours, 24)} 小时）`)
    ]
  },
  assignment_sla1_backfill: {
    label: 'SLA 期限回填', tone: 'config',
    describe: (d) => [
      T('为 '), B(`${num(d.count, 0)} 条`),
      T(`历史分配回填首触期限（SLA ${num(d.slaHours, 24)} 小时）`)
    ]
  },

  // ── SLA 第二段：聊了没有 ──
  sla2_scan_result: {
    label: '第二段结论', tone: 'neutral',
    describe: (d, ctx) => [
      T('线索'), ...rowRef(ctx), T(' 第二段判定：'),
      B(lookup(SLA2_VERDICT, d.verdict, '待人工确认')),
      ...(d.overridden === true ? [M('·覆盖了上一轮结论')] : [])
    ]
  },
  lead_first_touch: {
    label: '首次触达', tone: 'assign',
    describe: (d, ctx) => [
      T('线索'), ...rowRef(ctx), T(' 完成首次触达'),
      ...(str(d.channel) ? [T(`（渠道 ${str(d.channel)}）`)] : []),
      ...(str(d.via) === 'sync:up' ? [M('·由终端同步上报')] : [])
    ]
  },

  // ── 绑定微信 / 信息缺口 ──
  identity_bind: {
    label: '绑定微信', tone: 'bind',
    describe: (d, ctx) => [
      T('把线索'), ...rowRef(ctx), T(' 绑定到微信 '),
      B(str(d.displayName) || str(d.wxid, '未知联系人')),
      ...(num(d.slaStopped, 0) > 0 || d.slaStopped === true ? [T('，同时停止首触计时')] : [])
    ]
  },
  info_gap_autoclose: {
    label: '信息缺口关闭', tone: 'neutral',
    describe: (d, ctx) => [
      T('线索'), ...rowRef(ctx), T(' 的信息缺口 '),
      B(str(d.label) || str(d.gap, '未知项')), T(' 已自动关闭')
    ]
  },

  // ── 线索导入 ──
  lead_import: {
    label: '线索导入', tone: 'neutral',
    describe: (d) => [
      T('导入 '), B(`${num(d.total, 0)} 条`), T('线索'),
      ...(str(d.fileName) ? [T(`（${str(d.fileName)}）`)] : []),
      T(`，有效 ${num(d.valid, 0)} 条、重复 ${num(d.duplicate, 0)} 条`)
    ]
  },
  lead_import_dedupe: {
    label: '导入查重明细', tone: 'neutral',
    describe: (d) => [
      T('批次 #'), B(str(d.batchId, '?')),
      T(` 的查重明细 ${Array.isArray(d.rows) ? d.rows.length : 0} 行`)
    ]
  },
  lead_sla_stock_reset: {
    label: 'SLA 存量清零', tone: 'config',
    describe: (d) => [
      T('存量线索 '), B(`${num(d.leads, 0)} 条`),
      T(`首触期限清零，同时关闭 ${num(d.cardsClosed, 0)} 张待办卡`)
    ]
  },
  lead_tag_owner_cleanup: {
    label: '归属残留清理', tone: 'config',
    describe: (d) => [
      T('清理群扫遗留归属 '), B(`${num(d.cleared, 0)} 条`),
      T(`，${num(d.noted, 0)} 条已备注留痕`)
    ]
  },

  // ── 配置变更 ──
  assignment_weight_change: {
    label: '配置变更', tone: 'config',
    describe: (d) => {
      const change = diffText(d.diff)
      return [
        T('调整了线索分配权重'),
        ...(change ? [T('：'), B(change)] : [])
      ]
    }
  },
  ai_daily_limit_change: {
    label: '配置变更', tone: 'config',
    describe: (d) => [
      str(d.direction) === 'increase' ? T('提高') : T('降低'),
      T('每日 AI 调用上限：'),
      B(`${fmtVal(d.old_limit)}→${fmtVal(d.new_limit)}`)
    ]
  },
  migration_02_account_to_customer: {
    label: '存量迁移', tone: 'config',
    describe: (d) => migrationParts(d, '客户资料合并')
  },
  migration_03_lead_to_identity: {
    label: '存量迁移', tone: 'config',
    describe: (d) => migrationParts(d, '线索身份建档')
  },
  // 迁移失败/冲突项的人工闭环（设置页「存量迁移报告」的确认忽略/恢复，2026-09-14）
  migration_failure_dismiss: {
    label: '忽略迁移项', tone: 'config',
    describe: (d, ctx) => [
      ...rowRef(ctx), T(' 已确认忽略：'), T(str(d.reason, '（无原因）')),
      T('（不再计入迁移失败）')
    ]
  },
  migration_failure_restore: {
    label: '恢复迁移项', tone: 'config',
    describe: (d, ctx) => [
      ...rowRef(ctx), T(' 已恢复：重新计入迁移失败清单')
    ]
  },

  // ── 归属移交 ──
  departure_handoff: {
    label: '离职移交', tone: 'assign',
    describe: (d, ctx) => [
      T('把'), ...rowRef(ctx), T(' 从 '), B(str(d.fromSales, '离职销售')),
      T(' 移交给 '), B(str(d.toSales, '接手销售'))
    ]
  },
  departure_handoff_summary: {
    label: '离职移交汇总', tone: 'config',
    describe: (d) => [
      T('把 '), B(str(d.fromSales, '离职销售')), T(' 名下资源移交给 '),
      B(str(d.toSales, '接手销售')), T('：线索 '), B(`${num(d.leadsTransferred, 0)} 条`),
      T(`、客户 ${num(d.accounts, 0)} 个、商机 ${num(d.opportunities, 0)} 个`)
    ]
  },

  // ── 客户档案 / 交付售后 ──
  customer_type_set: {
    label: '客户类型', tone: 'config',
    describe: (d, ctx) => [
      T('把客户'), ...rowRef(ctx), T(' 的类型从 '),
      B(lookup(CUSTOMER_TYPE, d.oldType, '未设置')), T(' 改为 '),
      B(lookup(CUSTOMER_TYPE, d.newType, '未设置'))
    ]
  },
  customer_equipment_set: {
    label: '设备档案', tone: 'config',
    describe: (d, ctx) => {
      const change = changedText(d.old, d.new)
      return [
        T('更新客户'), ...rowRef(ctx), T(' 的设备档案'),
        ...(change ? [T('：'), B(change)] : [])
      ]
    }
  },
  customer_repeat_level_change: {
    label: '复购等级', tone: 'config',
    describe: (d, ctx) => [
      T('客户'), ...rowRef(ctx), T(' 的复购等级 '),
      B(`${fmtVal(d.oldLevel) || '未设置'}→${fmtVal(d.newLevel) || '未设置'}`),
      T(`（累计成交 ${num(d.wonCount, 0)} 单）`)
    ]
  },
  // 交付/质保/以旧换新的系统自动收尾（写点 = crmDeliveryService.writeAudit 包装，
  // 其中 trade_in_proposal_* 由模板字符串拼出，静态反查不到 —— 由 scripts/audit-dict-test.ts
  // 的「动态写点」清单暴露后补齐）
  diff_task_autoclose: {
    label: '发货差异关闭', tone: 'neutral',
    describe: (d, ctx) => [
      T('商机'), ...rowRef(ctx), T(' 的发货差异待办已自动关闭：实发 '),
      B(`${num(d.shippedQty, 0)} 台`), T(` 已达订单量 ${num(d.orderQty, 0)} 台`)
    ]
  },
  warranty_reminder_autoclose: {
    label: '质保提醒关闭', tone: 'neutral',
    describe: (d, ctx) => [
      T('客户'), ...rowRef(ctx), T(' 的质保提醒待办已关闭'),
      ...(str(d.reason) ? [T(`：${str(d.reason)}`)] : [])
    ]
  },
  trade_in_proposal_accept: {
    label: '以旧换新采纳', tone: 'assign',
    describe: (d, ctx) => [
      T('采纳了客户'), ...rowRef(ctx), T(' 的以旧换新提案（不自动改客户事实，需人工另行建档）')
    ]
  },
  trade_in_proposal_reject: {
    label: '以旧换新驳回', tone: 'recycle',
    describe: (d, ctx) => [
      T('驳回了客户'), ...rowRef(ctx), T(' 的以旧换新提案')
    ]
  },
  delivery_register: {
    label: '交付登记', tone: 'config',
    describe: (d, ctx) => {
      const o = rec(d.old), n = rec(d.new)
      const date = fmtDateTime(n.delivery_date)
      return [
        T('登记商机'), ...rowRef(ctx), T(' 的发货：'),
        B(`${num(o.shipped_qty, 0)}→${num(n.shipped_qty, 0)} 台`),
        ...(date ? [T(`，交付日期 ${date}`)] : [])
      ]
    }
  },

  // ── 合同 / 报价 / 成交 ──
  contract_entry_create: {
    label: '合同创建', tone: 'neutral',
    describe: () => [T('创建了一份新合同（录入请求已幂等登记）')]
  },
  opportunity_deal_register: {
    label: '成交登记', tone: 'assign',
    describe: (d, ctx) => [
      T('把商机'), ...rowRef(ctx), T(' 登记为成交，金额 '),
      B(`${num(d.amount_cny, 0)} 元`)
    ]
  },
  opportunity_deal_migrate: {
    label: '存量成交迁移', tone: 'config',
    describe: (d, ctx) => [
      T('存量合同 #'), B(str(d.contract_id, '?')), T(' 迁为成交商机'),
      ...rowRef(ctx),
      T(`，金额 ${num(d.amount_cny, 0)} 元`)
    ]
  },
  quote_version_create: {
    label: '报价版本', tone: 'neutral',
    describe: (d, ctx) => [
      T('为合同 #'), B(str(d.contract_id, '?')), T(' 生成报价版本'),
      ...rowRef(ctx),
      ...(Array.isArray(d.superseded_ids) && d.superseded_ids.length > 0
        ? [T('，旧版本已被取代')] : [])
    ]
  },
  quote_version_backfill: {
    label: '报价版本回填', tone: 'config',
    describe: (d) => [
      T('为存量合同 #'), B(str(d.contract_id, '?')),
      T(` 回填 ${num(d.versions, 0)} 个报价版本`)
    ]
  },

  // ── 回款承诺 ──
  payment_promise_register: {
    label: '回款承诺', tone: 'neutral',
    describe: (d) => {
      const due = fmtDateTime(d.dueDate)
      return [
        T('登记了一笔回款承诺'),
        ...(due ? [T(`，承诺 ${due} 前回款`)] : [])
      ]
    }
  },
  payment_promise_mark: {
    label: '回款承诺状态', tone: 'neutral',
    describe: (d) => [
      T('回款承诺状态更新为 '), B(str(d.status, '未知'))
    ]
  },

  // ── AI 首次分类（B 档 proposed → 人工裁决）──
  first_classify_proposed: {
    label: 'AI 分类建议', tone: 'neutral',
    describe: (d, ctx) => [
      T('AI 为线索'), ...rowRef(ctx), T(' 给出分类建议：'),
      B(str(d.stage, '未定阶段')),
      ...(str(d.customerType) ? [T(`、类型 ${lookup(CUSTOMER_TYPE, d.customerType)}`)] : []),
      T('（待人工裁决）')
    ]
  },
  first_classify_confirmed: {
    label: 'AI 分类采纳', tone: 'assign',
    describe: (d, ctx) => [
      T('采纳 AI 对线索'), ...rowRef(ctx), T(' 的分类：'),
      B(str(d.stage, '未定阶段')),
      d.applied === true ? T('（已写入）') : T('（未写入）')
    ]
  },
  first_classify_rejected: {
    label: 'AI 分类驳回', tone: 'recycle',
    describe: (d, ctx) => [
      T('驳回了 AI 对线索'), ...rowRef(ctx), T(' 的分类建议'),
      ...(str(d.reason) ? [T(`：${str(d.reason)}`)] : [])
    ]
  },
  first_classify_failed: {
    label: 'AI 分类失败', tone: 'recycle',
    describe: (d, ctx) => [
      T('AI 分类线索'), ...rowRef(ctx), T(' 失败，可重试'),
      ...(str(d.error) ? [T(`：${str(d.error)}`)] : [])
    ]
  },

  // ── 知识库 ──
  knowledge_delete: {
    label: '知识删除', tone: 'recycle',
    describe: (d) => [
      T('删除知识条目 '), B(str(d.title, '未命名')), T(`（${str(d.category, '未分类')}）`)
    ]
  },

  // ── 局域同步（system:sync）──
  sync_apply: {
    label: '同步落地', tone: 'neutral',
    describe: (d, ctx) => {
      const who = str(d.salesName) || str(d.toSales)
      return [
        T('接收中枢同步的「'), B(lookup(SYNC_TYPE, d.type, str(d.type, '未知事件'))), T('」事件'),
        ...(who ? [T(`（${who}）`)] : []),
        T('，已应用到本机'),
        ...rowRef(ctx),
        ...(d.leadUnknown === true ? [M('·本机无此线索，已跳过')] : [])
      ]
    }
  },
  sync_down_fail: {
    label: '同步下发失败', tone: 'recycle',
    describe: (d) => {
      const list = Array.isArray(d.deliveries) ? d.deliveries.length : 0
      return [
        T('「'), B(lookup(SYNC_TYPE, d.type, str(d.type, '未知事件'))), T('」事件下发失败'),
        ...(list ? [T(`（${list} 个接收端未确认）`)] : [])
      ]
    }
  },
  sync_down_unroutable: {
    label: '同步无法投递', tone: 'recycle',
    describe: (d) => [
      T('「'), B(lookup(SYNC_TYPE, d.type, str(d.type, '未知事件'))), T('」事件没有接收者'),
      ...(str(d.reason) ? [T(`：${str(d.reason)}`)] : [])
    ]
  },
  sync_down_delivery_key_conflict: {
    label: '同步键冲突', tone: 'recycle',
    describe: (d) => [
      T('「'), B(lookup(SYNC_TYPE, d.type, str(d.type, '未知事件'))),
      T('」事件的幂等键冲突，已隔离待人工核对'),
      ...(str(d.reason) ? [T(`：${str(d.reason)}`)] : [])
    ]
  },

  // ── 企业同步（Phase 3a 中央节点）──
  central_unbind: {
    label: '解除企业绑定', tone: 'recycle',
    describe: (d) => [
      T('解除本机与中央工作区的绑定'),
      ...(d.serverRevoked === true ? [T('，服务端凭证已同步吊销')] : [M('·服务端未确认吊销，需管理员在中央控制台吊销该设备')])
    ]
  },
  sync_push_rejected: {
    label: '上行被拒', tone: 'recycle',
    describe: (d) => [
      T('一条上行事件被中央拒绝'),
      ...(str(d.code) ? [T('（'), B(str(d.code)), T('）')] : []),
      T('，已置终态不再重推')
    ]
  },
  sync_forbidden_field_blocked: {
    label: '拦截禁传字段', tone: 'recycle',
    describe: (d) => [
      T('一条上行事件含禁上传字段（聊天正文/会话标识等），已在本机拦截'),
      ...(str(d.entityType) ? [T('：'), B(str(d.entityType))] : []),
      M('·未发送到中央')
    ]
  },
  central_supervisor_correction_pending: {
    label: '主管修正待确认', tone: 'neutral',
    describe: (d) => [
      T('收到中央下发的'),
      ...(str(d.action) === 'supervisor_correction' ? [T('主管修正')] : []),
      T('提案，已入待确认收件箱'),
      M('·本地事实未被改写')
    ]
  },
  central_permission_change_recorded: {
    label: '权限声明登记', tone: 'neutral',
    describe: (d) => [
      T('登记中央下发的权限声明'),
      ...(str(d.declaredRole) ? [T('（'), B(str(d.declaredRole)), T('）')] : []),
      M('·仅作展示与审计，不构成本机访问控制依据')
    ]
  },

  // ── 系统自愈 / 备份 / 脏数据 ──
  auto_backup: {
    label: '自动备份', tone: 'neutral',
    toneOf: (d) => (d.ok === false ? 'recycle' : 'neutral'),
    describe: (d) => {
      const ok = d.ok !== false
      return [
        T(`${lookup(BACKUP_TRIGGER, d.trigger, '自动')}备份`), B(ok ? '成功' : '失败'),
        ...(str(d.dir) ? [T(`，目录 ${str(d.dir)}`)] : []),
        ...(str(d.local) ? [T(`（本机 ${lookup(BACKUP_LAYER, d.local)}）`)] : [])
      ]
    }
  },
  db_recover: {
    label: '数据库自愈', tone: 'recycle',
    describe: (d) => [
      T(`${str(d.kind, '数据')}库损坏，已`),
      B(str(d.restoredFrom) ? '从备份自动恢复' : '重建空库'),
      ...(str(d.corruptPath) ? [M(`（损坏文件 ${str(d.corruptPath)}）`)] : [])
    ]
  },
  absurd_amount_sweep: {
    label: '脏金额清理', tone: 'config',
    describe: (d) => [
      T('清理异常金额（≥'), B(fmtVal(d.threshold)), T(' 视为误识别）：商机 '),
      B(`${num(d.opportunity, 0)} 行`), T(`、报价信号 ${num(d.quote_signal, 0)} 行`)
    ]
  }
}

// ─── 迁移报告人话（migration_report 只读投影）───────────────────────────────

/** 模块 key → 人话名（去「模块② account → customer」式行话） */
export const MIGRATION_MODULES: Record<string, string> = {
  '02-account-to-customer': '客户资料合并',
  '03-lead-to-identity': '线索身份建档',
  '04-history-deal-opportunity': '历史成交转商机',
  '05-customer-profile-align': '客户档案对齐'
}

/** 模块人话名（未登记模块回落原 key，不留空） */
export function migrationModuleLabel(module: unknown): string {
  const k = str(module)
  return MIGRATION_MODULES[k] || k || '未知模块'
}

/**
 * 失败/冲突原因人话化。
 * 现行写点（crmMigrationService）已直接落中文整句 → 原样透传；
 * 词表覆盖早期版本可能落库的英文码（老 DB 的 migration_report 仍可能读到）。
 */
const MIGRATION_REASON: Record<string, string> = {
  no_identity_anchor: '缺少手机号和微信会话，系统无法自动核对身份，需要人工处理',
  no_customer_match: '没有匹配到已有客户档案，系统不猜测归属，需要人工处理',
  missing_account_id: '合同缺少客户关联，无法自动建商机，需要人工处理',
  name_mismatch: '同一组内客户名不一致，以哪个为准需要人工确认'
}

/** 原因 → 人话（未登记内容原样返回；空值给明确占位，不留白） */
export function migrationIssueReason(reason: unknown): string {
  const raw = str(reason)
  if (!raw) return '未说明原因，需人工核查'
  return MIGRATION_REASON[raw] || raw
}

/** 对象 key（如 `account:218` / `customer_profile:4`）→ 人话前缀 */
export function migrationIssueKeyLabel(key: unknown): string {
  const raw = str(key)
  const [prefix, id] = raw.split(':')
  const noun: Record<string, string> = { account: '客户', customer_profile: '客户档案', contract: '合同' }
  if (id && noun[prefix]) return `${noun[prefix]} #${id}`
  return raw || '未命名对象'
}

// ─── 对外接口 ──────────────────────────────────────────────────────────────

/** 词典命中结果；`untranslated=true` 时 UI 需展示原文并打「未翻译」灰标 */
export interface ResolvedAuditEntry extends AuditDictEntry {
  untranslated: boolean
}

/** action → 词典条目（未命中降级：原文动作名 + 通用 detail 渲染 + untranslated） */
export function resolveAuditAction(action: unknown): ResolvedAuditEntry {
  const key = str(action)
  const hit = AUDIT_DICT[key]
  if (hit) return { ...hit, untranslated: false }
  return {
    label: key || '未知操作',
    tone: 'neutral',
    untranslated: true,
    describe: (d) => genericParts(d)
  }
}

/** 条目最终色调（`toneOf` 优先，用于备份成功/失败这类随 detail 变化的情形） */
export function entryTone(entry: ResolvedAuditEntry, detail: unknown): AuditTone {
  if (!entry.toneOf) return entry.tone
  try { return entry.toneOf(parseDetail(detail)) } catch { return entry.tone }
}

/** 操作人 → 显示名。`system:*` 一律「系统自动」（sla / migration / backup / sync 统一） */
export function actorDisplay(actor: unknown): { text: string; system: boolean } {
  const raw = str(actor)
  if (!raw || raw.startsWith('system:')) return { text: '系统自动', system: true }
  return { text: raw, system: false }
}

/** 筛选 chips（顺序即设计稿 §01；`id` 必须与后端 AUDIT_ACTION_CATEGORY 键对齐，有守卫测试） */
export const AUDIT_FILTER_CHIPS: ReadonlyArray<{ id: string; label: string }> = [
  { id: '', label: '全部' },
  { id: 'assign', label: '分配' },
  { id: 'bind', label: '绑定' },
  { id: 'recycle', label: '回收' },
  { id: 'remind', label: '提醒' },
  { id: 'config', label: '配置变更' }
]

/** 批量合并行标题（按 action 生成人话；同 action 同人同分钟才会走到这里） */
export function batchHeadline(action: unknown, detail: unknown, n: number): string {
  const entry = AUDIT_DICT[str(action)]
  if (entry?.batch) return entry.batch(parseDetail(detail), n)
  return `批量${entry?.label || str(action, '操作')} ${n} 条`
}

/** 同 action + 同操作人 + 同一分钟 → 批量合并键（仅渲染层使用，不丢行） */
export function batchKeyOf(row: { action: string; actor: string; created_at: number }): string {
  const minute = Math.floor(num(row.created_at, 0) / 60000)
  return `${str(row.action)}|${str(row.actor)}|${minute}`
}

/** 词典收录的 action 全量（守卫测试 + 文档枚举复用） */
export function auditDictActions(): string[] {
  return Object.keys(AUDIT_DICT).sort()
}
