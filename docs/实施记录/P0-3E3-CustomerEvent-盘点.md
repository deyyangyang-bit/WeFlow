# P0-3 E3 CustomerEvent：第一刀只读盘点（零编码）

> **状态：盘点完成（2026-08-23），等待拍板边界**
>
> 用户拍板（2026-08-23）：P0-3 CLOSED 后下一阶段 = **P0-3 E3 CustomerEvent**，
> 不是 P0-4（action 需先定义为事件一等公民，避免再造多套真源），也不是判断覆盖提升（18 条只是观察窗口短）。
>
> 本刀约束：**只读盘点，零编码**。回答 4 个问题：
> ① `intent_tag_log` 现在承担哪些事件？ ② 哪些地方已存在「事件」散落别的表？
> ③ 哪些消费者真的需要 CustomerEvent？ ④ CustomerEvent 与 `customer_judgment` / State 的边界？
>
> 真实库统计：sql.js 字节进内存纯只读（`~/Library/Application Support/weflow/weflow-sales.db` + `weflow-crm.db`），未写任何表。

---

## ① intent_tag_log 承担的事件（Q1）

**Schema**（salesDbService.ts:131）：`id / session_id / stage / confidence / source / reason / message_key / evidence_text / created_at`

**语义：Intent/Stage 判定事件**——append-only 的「某时刻系统认为客户处于某阶段」流水，自带证据锚点（message_key + evidence_text），不可覆盖。

**5 个写入者**：

| 写入者 | 触发 | source | 事件含义 |
|---|---|---|---|
| persistClassification（salesStageClassifier.ts:167） | 消息扫描后阶段分类 | ai（auto_message_trigger） | 自动分类判定 |
| salesIntentService.ts:184 | 意图识别服务 | ai | 意图判定 |
| legalStageWriters.ts:47 | 手动改阶段（UI/IPC） | **manual** | 人工覆盖判定 |
| legalStageWriters.ts:63 | deal_rule 命中（won） | **deal_rule** | 规则判定 |
| salesInsightWrite.ts:26 | applyParsedStageSignal（只写 signal 不覆盖 stage） | ai / confidence=0.7 | 信号级判定 |

**消费者**：
- `getCanonicalState`（salesDbService.ts:849）：recentIntents（20 条）→ computeCanonicalState 归一匹配 + stateMeta（最近归一 == 当前 stage 记录的 source/confidence/created_at/reason/evidence）
- `intentHistory` / `intentGetLatest` / `intentBefore`（main.ts:4783-4839 / salesReportService.ts:411-412）：UI 意向历史 + 周报时间点快照

**结论：intent_tag_log 已经是 Intent Event 的一等实现**（append-only + 锚点 + 时间），且 State 投影层（canonicalState）已经建立在它之上。它不缺事件能力，缺的是「类型化事件」——它只描述 stage 判定，无法承载 customer_replied / script_copied / quote_sent 等其他事件类型。

## ② 散落的事件（Q2）

全仓事件语义表全景（两库）：

| 库 | 表 | 事件语义 | 写入者 | 消费者 | 真实库行数 |
|---|---|---|---|---|---|
| sales | intent_tag_log | Intent/Stage 判定事件 | 5 个（见上） | canonicalState / 意向历史 / 周报 | **1131**（07-24→08-23） |
| sales | follow_up_task | 任务生命周期（创建/完成/跳过） | todoCreate 等 | getUnifiedSignals | **2671**（07-24→08-23） |
| sales | customer_judgment | 判断（P0-2C，非事件） | 预热 / suggest | getCustomerCurrentView | 18（08-23） |
| crm | quote_signal | **报价事实 + 回复回流**（session_id + msg_key + quoted_at + **customer_replied_at**） | recordQuoteSignal（crmParseService.ts:170）/ markQuoteReplied（:174） | R7 报价跟进规则（salesActionEngine.ts:423）/ CRM 统计 | **22**（08-18→08-23） |
| crm | activity_log | CRM 业务动作时间线（account/contract/logistics/quotation/allocation/payment_record 五实体） | logActivity（crmDbService.ts:1034） | crmAccountTimeline 聚合（L1044-1055） | **192**（08-05→08-20） |
| crm | lead_activity | 线索动作（IMPORTED / CONTACTED / WX_ADDED） | crmLeadService.ts:54/152/155 | 线索时间线（:126） | **880**（08-19→08-20） |
| crm | auto_confirm_log | 自动确认审计（enrich_auto 等） | crmDbService.ts:1341 | 回看/撤销（:1348） | **1315**（08-13→08-20） |
| crm | opportunity_event | 商机事件（signal/created/stage_change/won/lost） | opportunityEventAdd（:768） | OpportunityPage 时间线 | 3（08-20） |
| crm | contract_status_history | 合同状态流转 | crmDbService.ts:1030 | :1037 | 0 |
| crm | lead（表） | 线索状态 | crmLeadService | CRM 工作台 | 875 |

**关键观察**：
1. **事件模型在系统里已经普遍存在且活跃**（以上合计 ~4600 行），但**没有统一层**——每张表的事件都有自己的 schema、自己的消费者、自己的查询方式。
2. **quote_signal 是「事实事件」原型**：session_id + message_key 锚点 + quoted_at + customer_replied_at（客户回复回流字段）——用户设想的 customer_replied 事件**已经以字段形式存在于报价场景**，但没有通用化。
3. **机会窗口**：session（微信会话）维度的事件流目前只有 intent_tag_log（判定）+ quote_signal（报价/回复）+ follow_up_task（任务）。缺的是**行动事件**（script_copied / chat_opened / follow_up_done）和**客户行为事件**（customer_replied 的通用化）。
4. CRM 侧 6 张表是 **account/contract 实体轴**，与 sales 侧 **session 轴**正交——CustomerEvent 若建，应挂在 session 轴（customer_profile 的扩展），不要与 CRM 实体时间线合并。

## ③ 消费者真实需求（Q3）

| 消费者 | 现在读什么 | 事件需求 |
|---|---|---|
| 漏斗（funnelStats，salesDbService.ts:738） | customer_profile.stage → stageToFunnel 归一 | **只消费 State**。历史累计漏斗以「客户当前 stage 首次进入」为口径，不读事件。→ **不需要 CustomerEvent** |
| 意向评分（getCanonicalState，salesDbService.ts:849） | customer_profile + intent_tag_log recentIntents（归一匹配 + stateMeta） | **消费 Intent Event + State**。intent_tag_log 已是 Intent Event 一等实现。→ 保留现状，不迁 |
| 周报（salesReportService.ts:411-412） | intentBefore（intent_tag_log 时间点快照）+ stage 分布 + quote_signal / auto_confirm_log 统计 | **消费 Event（时间序列）**：需要「某时间点之前发生了什么」。intentBefore 已满足 Intent 部分；报价/确认统计各自读表。→ 部分需要，已有满足 |
| 今日行动（getUnifiedSignals，salesActionEngine.ts） | customer_profile（沉默/阶段）+ follow_up_task + insight_record + **quote_signal（R7）** | **消费 State + 事实 Event**：R7 已是纯事实规则（「我方报过价 + 客户没回」）。行动引擎是唯一把事件当事件用的消费者。→ 保持，R7 已是正确范式 |

**结论：四个消费者没有一个是「缺一张 CustomerEvent 表才能干活」的**。真正的缺口不是消费端，而是**生产端**：P0-4 的 action 埋点（script_copied / chat_opened / customer_replied）需要先定义成事件，否则会再造第 N 套真源。

## ④ 边界草案（Q4）

**Event ≠ Judgment ≠ State**（用户拍板框架 + 全仓验证）：

| 维度 | Event（事件） | Judgment（判断，P0-2C） | State（状态） |
|---|---|---|---|
| 时态 | **过去时**：「发生了什么」 | **现在时**：「AI 怎么看当前」 | **现在时**：「现在在哪一阶段」 |
| 生命周期 | append-only，不可覆盖 | append-only，但消费取**最新**（judgmentCurrent） | 折叠/投影（可被新事件改写） |
| 锚点 | message_key（P0-2B getEvidenceByKey 统一回查） | message_key | 无（由 intent_tag_log 回溯） |
| 真源表 | intent_tag_log（判定）/ quote_signal（报价+回复）/ follow_up_task（任务） | customer_judgment | customer_profile + intent_tag_log 归一 |
| 例子 | customer_replied → Event | AI 判断「价格敏感」→ Judgment | 进入 quoted → State |
| 覆盖语义 | 无（历史流水） | 取最新即「当前判断」 | 唯一当前值 |

**判定口诀：有过去时态（发生在某时刻的事实）→ Event；有现在时态（当前为真、被覆盖/取最新）→ Judgment 或 State。**

**CustomerEvent 的定义空间**（待拍板）：session 轴、append-only、message_key 锚点的事件流，统一承载：
- 客户行为事件：customer_replied（现散落于 quote_signal.customer_replied_at 字段）、quote_asked、silence_breaked
- 用户行动事件：script_copied、chat_opened、follow_up_done（现散落于 follow_up_task 状态）
- 判定事件：intent_tag_log 已是，**不迁**

## 关键发现（3 条）

1. **不需要新建「判断事件」**——intent_tag_log 已是 Intent Event 一等实现，canonicalState 已建立在它之上。
2. **customer_replied 已存在**（quote_signal.customer_replied_at），但只是报价场景的字段，不是通用事件。
3. **CustomerEvent 的增量价值 = 统一的 session 轴行动/客户行为事件流**，服务 P0-4 北极星「有效销售行动」六段漏斗，同时让 R7 式的事实规则可泛化（R7 已证明「事实事件驱动行动」范式成立）。

## 下一刀建议（待拍板）

用户节奏：盘点 → **拍板边界** → 设计文档 → 一刀一提交 → 独立测试 → 真实库只读验收 → 收口。

边界拍板点：
1. **CustomerEvent 表建不建**？建 = 新 schema + 迁移 + 写入者 + 消费者；不建 = 在 quote_signal 泛化（改名为事实事件）或先只做 P0-4 埋点表。
2. **建的话 scope**：只承载「行动事件」（script_copied / chat_opened / follow_up_done）+「客户行为事件」（customer_replied 通用化）？判定事件明确不迁（intent_tag_log 保留）？
3. **与 quote_signal 关系**：quote_signal 保留（报价业务表）但 customer_replied 回流改为写 CustomerEvent？还是保留现状双写？
4. **漏斗/意向评分/周报**：确认**不迁**（Q3 结论）？
