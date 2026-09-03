/**
 * leadSla.ts —— 线索首触 SLA 共享常量（electron 与 renderer 共用）
 *
 * LEAD_SLA_UNASSIGNED_SENTINEL（2100-01-01）：决策 B 存量处置哨兵值。
 * 群资源扫描存量线索的 first_contact_deadline 在扫描导入日即被起计时，从未分配也无人
 * 该首触 → 全部超时、SLA 卡刷屏。2026-09-03 拍板「存量重置」：deadline 置本哨兵值 =
 * 「待分配、不起计时」（first_contact_deadline 为 NOT NULL 列，不能置 NULL；列语义不
 * 变，只是时间被推到未来）。Phase 1 分配上线后 SLA 从 assignment 起算（宪法 §1.3），
 * 分配动作应把本列覆盖为真实期限。
 */
export const LEAD_SLA_UNASSIGNED_SENTINEL = 4102444800000 // 2100-01-01T00:00:00.000Z
