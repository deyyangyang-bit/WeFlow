/**
 * 设置页「自动化程度」档位映射（纯函数、零 IO、无 React）——供设置页与单测共用。
 *
 * 设计稿《设置页人话化》：原先三个数字滑杆加起来表达的是同一件事——「系统替你做多少决定、
 * 多少留给你确认」。对一线销售而言 0.85 / 0.70 / 0.80 这组数字没有可解释性，故合并为一个
 * 三档选择器，数字收进「高级 · 微调」。
 *
 * ⛔ 本模块**只是展示层映射**：档位选中后写入的仍是既有三个配置键
 *   （`crmEnrichAutoApply` / `crmEnrichThreshold` / `crmAutoConfirmThreshold`），
 *   键名、默认值、读写时机一律未变。
 *
 * ⚠️ 映射值来源 = **现状默认值**：落库默认即 `crmEnrichAutoApply=0.85`、
 *    `crmEnrichThreshold=0.70`、`crmAutoConfirmThreshold=0.80`（见 SettingsPage 的 useState 初值），
 *    故「标准」档必须与这三个默认值逐字相等——否则升级用户会在未做任何操作的情况下被静默改掉阈值。
 */

/** 自动化程度档位 */
export type AutoTier = 'conservative' | 'standard' | 'aggressive'

/** 档位映射到的三个既有配置键的值 */
export interface TierValues {
  /** 直接写入阈值（键 `crmEnrichAutoApply`）：置信度 ≥ 该值自动写入档案 */
  autoApply: number
  /** 待确认下限（键 `crmEnrichThreshold`）：低于该值直接丢弃，介于两者之间进跟单中心 */
  enrichThreshold: number
  /** 置信阈值（键 `crmAutoConfirmThreshold`）：跟单中心自动确认的门槛 */
  confirmThreshold: number
}

/** 档位定义。`values` 为可调常量——调整即改变三个档位写入的数字，不影响键名与时机。 */
export interface AutoTierDef {
  value: AutoTier
  label: string
  /** 一句话人话解释（口径对齐总开关注释：高置信直接写、中置信进待办） */
  desc: string
  values: TierValues
}

/**
 * 三档定义（顺序即分段选择器的展示顺序，从「少自动」到「多自动」）。
 * 三个档位内部均满足 `enrichThreshold ≤ autoApply`（交叉校验不变量）。
 */
export const AUTO_TIERS: readonly AutoTierDef[] = [
  {
    value: 'conservative',
    label: '保守',
    desc: '大部分信息只做建议，基本都要你确认后才写入',
    values: { autoApply: 0.9, enrichThreshold: 0.8, confirmThreshold: 0.85 }
  },
  {
    value: 'standard',
    label: '标准',
    desc: '高置信直接写入档案，中置信进跟单中心待你打勾',
    values: { autoApply: 0.85, enrichThreshold: 0.7, confirmThreshold: 0.8 }
  },
  {
    value: 'aggressive',
    label: '积极',
    desc: '系统尽量自己处理，只有拿不准的才来打扰你',
    values: { autoApply: 0.75, enrichThreshold: 0.6, confirmThreshold: 0.7 }
  }
]

/** 浮点比较容差：阈值步进 0.05，累加误差远小于该值 */
const EPS = 1e-6

/**
 * 由三个既有值反推当前档位。
 * 返回 `''` 表示当前值不落在任何一个档位上（例如用户此前用高级滑杆微调过、或旧版本写过别的值）——
 * 与 `SegmentedControl` 的「未选择态」语义一致：不假装属于某一档，三个真实数字在「高级 · 微调」里如实展示。
 */
export function tierOf(values: TierValues): AutoTier | '' {
  const hit = AUTO_TIERS.find((t) =>
    Math.abs(t.values.autoApply - values.autoApply) < EPS &&
    Math.abs(t.values.enrichThreshold - values.enrichThreshold) < EPS &&
    Math.abs(t.values.confirmThreshold - values.confirmThreshold) < EPS)
  return hit ? hit.value : ''
}

/** 按档位取值；未知档位返回 `null`（调用方应据此跳过写入，不猜） */
export function valuesOfTier(tier: string): TierValues | null {
  const hit = AUTO_TIERS.find((t) => t.value === tier)
  return hit ? { ...hit.values } : null
}

/**
 * 交叉校验：待确认下限不得高于直接写入阈值。
 * 高于时 clamp 到直接写入阈值——即「待确认区间」宽度为 0，全部要么自动写入要么丢弃，
 * 不会出现「低于下限丢弃」与「高于阈值写入」两条规则互相矛盾的空隙。
 */
export function clampEnrichThreshold(enrichThreshold: number, autoApply: number): number {
  return enrichThreshold > autoApply ? autoApply : enrichThreshold
}

/** 两个值是否相等（用于判断是否需要提示「已自动调整」） */
export function isClamped(enrichThreshold: number, autoApply: number): boolean {
  return enrichThreshold > autoApply + EPS
}
