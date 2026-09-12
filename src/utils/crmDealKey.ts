/**
 * src/utils/crmDealKey.ts —— 复购归并/等级前端入口（re-export 收敛到 shared/crmRepeat 单一真源）
 *
 * 单一后端原语 = shared/crmRepeat.ts：前端展示 / R10 回访 / 报表全部复用同一口径，
 * 禁止前端本地再写一套 wonCount→等级 的阈值推导。
 */

export {
  crmCustomerKey,
  crmCustomerKeyForOpportunity,
  crmRepeatLevel,
  computeRepeatLevel,
  REPEAT_LEVEL_FIRST,
  REPEAT_LEVEL_REPEAT,
  REPEAT_LEVEL_HIGH
} from '../../shared/crmRepeat'
