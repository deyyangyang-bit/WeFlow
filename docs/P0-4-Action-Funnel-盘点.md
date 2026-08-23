# P0-4 Action Funnel 盘点（只读，零编码）

> 盘点日期：2026-08-24 · 方法：代码只读 + 真实库 sql.js 字节进内存只读（绝不写真实库）
> 问题来源：用户拍板「P0-4 第一刀先钉死『客户事实/用户行动 → customer_event → Action Funnel → 有效销售行动 → 后续客户反馈 → 转化』这条链」
> 核心问题：**销售今天做了什么？做完有没有产生客户响应？最终有没有推动商机？**

---

## 〇、盘点方法

- **代码只读**：salesActionEngine（规则/任务/统一信号流）、salesDbService（schema/原语）、crmParseService（E3.2 双写点）、salesActionEngine（E3.3 行动事件）、salesReportService（周报）、salesFollowUpService（AI 承诺跟进）
- **真实库只读**：`weflow-sales.db` + `weflow-crm.db`（sql.js 字节进内存，副本不落盘）
- **E3 基线**：customer_event 表 0 基线（app 尚未以 E3.1+ 代码重启）——事件类统计为**可写路径分析**，非存量数据

---

## 一、问题 1：现有 Action 来源（全景）

### 1.1 follow_up_task（2818 行真实数据）

| 来源 | trigger_type | 真实量 | 产生方 |
|---|---|---|---|
| 报价跟进 | `rule_r1_quoted_followup` | 1210 (42.9%) | runFullScan 规则引擎 |
| SLA 首触 | `sla_lead` | 872 (30.9%) | scanLeadSla（source_id=lead.id 幂等） |
| 谈判停滞 | `rule_r2_negotiating_stall` | 383 (13.6%) | 规则引擎 |
| AI 催客 | `urge_customer` | 171 (6.1%) | 智能催客（自动回复链） |
| 已沟通沉默 | `rule_r4_contacted_silent` | 156 (5.5%) | 规则引擎 |
| 新客未回复 | `rule_r3_new_no_reply` | 少量 | 规则引擎 |
| 未知新客 | `rule_r0_unknown_followup` | 15 | 规则引擎 |
| AI 承诺跟进 | `ai_detected` | 5 | salesFollowUpService（唯一带 source_message_id 的路径） |
| 手动待办 | `manual` | 3 | 前端 todoCreate |
| 未答复报价 / 承诺联系 | `unanswered_quote` / `promise_contact` | 3 | 历史遗留 trigger |

**status 分布**：`superseded` 1601 (56.8%) / `pending` 1131 (40.1%) / `done` 73 (2.6%) / `ignored` 6 / `manual_done` 4 / `dismissed` 3。

**关键事实**：
- 规则引擎任务**从未被「完成」**——done 73 全部分布在 urge_customer (72) + ai_detected (1)。r0-r8 规则任务靠 `superseded`（新一轮扫描产生新任务取代旧任务）演进，而非销售点「完成」。
- `completed_at` 覆盖率 = 73（与 done 数一致，todoUpdate 强制写）。
- **source_message_id 覆盖率 = 1/2818**（0.04%）——P0-1 messageKey 锚点只在 ai_detected 路径写入（followUpService L344 `candidates2[0]?.messageKey`），规则引擎 todoCreate 全部不传。P0-1 透传在真实运行中基本未生效（app 以旧代码运行 + 规则路径无写入点）。

### 1.2 AIActionCard 动作（前端执行面）

| 动作 | handler | 事件（E3.3） | task 关联现状 |
|---|---|---|---|
| 打开聊天 | handleOpenChat → navigate | `chat_opened` | 只带 sessionId |
| 复制话术 | handleCopyScript → clipboard | `script_copied` | 只带 sessionId |
| 完成 | completeItem → actionCompleteUnified | `follow_up_done`（主进程） | completeAction 知道 taskId（before.id）但未写入事件 |
| 跳过 | completeItem(skipped) | 无事件 | — |
| AI 深度分析 | handleSuggest → suggest | 无事件（写 customer_judgment, source=manual） | — |

### 1.3 行动产生到执行的完整链路

```
runFullScan / lazyScan / onNewMessage / scanLeadSla / 前端手动
   ↓ todoCreate
follow_up_task (pending)
   ↓ getUnifiedSignals（今日行动卡流，自动触发扫描）
UnifiedSignal 卡（task 卡带 sources[].rawTaskId = task.id）
   ↓ 用户动作
chat_opened / script_copied / follow_up_done / completeItem
   ↓
customer_event（E3.3，source=manual）
```

---

## 二、问题 2：六段漏斗的真实定义（从代码与数据反推）

用户建议六段 vs 数据可行性对照：

| 段 | 用户建议 | 代码/数据反推后的真实形态 | 可行性 |
|---|---|---|---|
| ① | AI 推荐/待办产生 | `follow_up_task.created_at`（trigger_type 区分来源） | ✅ 完整 |
| ② | 销售看到/打开 | **今日行动卡无 read/seen 事件**（getUnifiedSignals 加载不落任何记录） | ❌ 不可测 |
| ③ | 话术复制/执行动作 | `script_copied` / `chat_opened` / `follow_up_done` | ✅ E3.3 已钉 |
| ④ | 打开客户聊天 | `chat_opened`（用户建议把「打开聊天」单独成段，与复制并列） | ✅ 同 ③ |
| ⑤ | 客户回复 | `customer_replied` / `quote_asked`（+ quote_signal 回流） | ✅ E3.2 已钉 |
| ⑥ | 有效推进/商机转化 | `customer_profile.stage` 前进（intent_tag_log 历史 / last_stage_change_at）→ `won` | ⚠️ 部分 |

**修正结论**：用户建议的六段中「打开客户聊天」与「话术复制/执行动作」在事件模型上同属 ③「销售执行」（同一卡上两个按钮，E3.3 已覆盖）。真实的六段应为：

```
① 行动产生（follow_up_task）
② 行动曝光（今日行动卡加载——无事件，见缺口 G1）
③ 销售执行（script_copied / chat_opened / follow_up_done）
④ 客户响应（customer_replied / quote_asked）
⑤ 有效推进（customer_profile.stage 前进）
⑥ 商机转化（stage = won）
```

---

## 三、问题 3：每段可靠事件（现状矩阵）

| 段 | 事实来源 | 可靠性 | 备注 |
|---|---|---|---|
| ① 产生 | follow_up_task.created_at + trigger_type | ✅ 高 | superseded 需按「最新任务」口径去重 |
| ② 曝光 | **无** | ❌ | 缺口 G1：卡流加载无事件；suggest 生成（customer_judgment source=manual）可近似「用户主动分析」 |
| ③ 执行 | customer_event: script_copied / chat_opened / follow_up_done | ✅ 高（写路径已通，0 基线待重启） | source=manual；无 messageKey 不伪造 |
| ④ 响应 | customer_event: customer_replied / quote_asked + quote_signal（crm 库） | ✅ 高 | quote_signal 22/22 已回复（真实运行证明回复真实发生）；messageKey 锚点可靠 |
| ⑤ 推进 | customer_profile.stage 历史（intent_tag_log changedAt 序列）+ last_stage_change_at | ⚠️ 中 | last_stage_change_at 写者已就位（legalStageWriters P0-2A.6）但真实库 0 非空——**app 未重启（部署时序），激活后可靠** |
| ⑥ 转化 | customer_profile.stage = won（中文「成交」26 行存量） | ✅ 高（存量） | 无 stage 变更时间锚点（同 ⑤ 部署时序） |

---

## 四、问题 4：correlation key（P0-4 最关键问题）

### 4.1 现状

| 实体 | 可用 key | 覆盖率/现状 |
|---|---|---|
| customer_event | session_id（必填）+ message_key（E3.2 有 / E3.3 为 null） | message_key 仅 customer_replied/quote_asked |
| follow_up_task | id（task_id）+ session_id + source_message_id + source_id | source_message_id 1/2818；source_id 872（全 sla_lead） |
| customer_profile | session_id（唯一） | 200 客户 |
| quote_signal | msg_key + session_id | 22 行全有 |

**结论：当前 correlation 只能到 session 轴。** 同 session 内的多条行动/多个任务无法区分「哪条 AI 建议 → 哪次复制 → 哪次客户回复」。

### 4.2 关键发现：可补路径存在

1. **follow_up_done**：completeAction 持有 `before.id`（taskId），但 recordUserActionEvent 未传——**一行改动即可把 task_id 写入事件**。
2. **script_copied / chat_opened**：前端 AIActionCard 的 `item.sources[].rawTaskId = task.id` **已存在**（task 卡 source 组装 L754/L784），上报时可直接带 taskId——**无需新增组装逻辑**。
3. **insight 卡**（insight_record 来源）无 task_id：带 insightRecordId（insight_record.id）可串「AI 见解 → 执行」。

### 4.3 不能做的（硬边界）

- 不能简单 `customer_replied + script_copied = 转化`（用户明确禁止的伪相关）——必须走「同一 task/session 上下文」串链。
- 不新增 action_id 体系（不造 action_log/sales_action_event/conversion_event 第二套日志真源）。

### 4.4 推荐 correlation 模型（P0-4.2 待拍板）

```
事件/任务统一关联三元组：
  session_id   —— 客户轴（已有，必填）
  task_id      —— 行动轴（E3.3 事件补可选列 task_id INTEGER NULL：follow_up_done 由 completeAction 直写；
                  script_copied/chat_opened 由前端 rawTaskId 上报）
  message_key  —— 证据轴（E3.2 已有；规则任务 source_message_id 覆盖率 1/2818 → 缺口 G2）
```

---

## 五、问题 5：「有效销售行动」定义

用户建议（Action Started → Executed → Customer Responded → Sales Progressed）在现有数据上的落地：

| 阶段 | 数据定义 | 真实库可行性 |
|---|---|---|
| Action Started | follow_up_task 产生（pending，非 superseded） | ✅ 1131 pending |
| Action Executed | 同 session 的 customer_event（script_copied/chat_opened/follow_up_done） | ✅ 写路径已通 |
| Customer Responded | 同 session 的 customer_replied / quote_asked（E3.2） | ✅ quote_signal 22/22 已回复 |
| Sales Progressed | stage 前进（intent_tag_log changedAt 序列）或 won | ⚠️ last_stage_change_at 待部署激活 |

**北极星指标候选**：`Executed → Responded 的转化率`（销售做了动作后客户真实反馈的比例）——不是点击次数。与用户「北极星来自客户真实反馈/推进」一致。

**当前不可计算的短板**：② 曝光无事件 → 「Recommendation → Seen → Executed」首段不可测（缺口 G1）。

---

## 六、问题 6：现有消费者与报表（统计真源盘点）

| 消费者 | 消费什么 | 是否行动统计 |
|---|---|---|
| 今日行动（getUnifiedSignals） | follow_up_task + insight_record + currentView | 行动**列表**，非统计 |
| 周报/月报（computeWeeklyReviewStats） | customer_profile State（stage 分布/活跃/变冷/热点，intentBefore 作上周基线） | ❌ 无跟进次数/回复率 |
| CRM 漏斗（funnelStats，§2.24） | customer_profile State 流转（历史累计 + 相邻转化率） | ❌ State 漏斗，非行动漏斗 |
| dashboardStats | customer_profile 统计 | ❌ |
| 消息统计（chatService summary 私聊回复率） | WCDB 消息层面 | ❌ 消息统计，非行动统计（MyFootprintPage 展示） |

**结论：行动级统计（跟进次数/执行率/回复率/转化率）全仓不存在**——P0-4 是真实缺口。且现有统计全部消费 State（customer_profile），**无一个消费 customer_event**（E3 收口已证零消费者）。

---

## 七、硬边界确认

**P0-4 不新增第二套 Action Log。** 现有四表 + State 足以支撑 Funnel View：

```
事实/判断 ──┬─ intent_tag_log（意向判定）
            ├─ customer_event（客观事实：客户行为 + 用户行动）← Action Funnel 主数据源
            ├─ follow_up_task（行动任务状态机）
            └─ customer_judgment（AI 当前判断）
                     │
                     ▼
              Action Funnel（只读组装，无新表）
                     │
                     ▼
              Funnel / KPI / Report（消费层，无新写）
```

Funnel 是 **read model**（同 customerCurrentView 先例）：不做判断、不产生新事实，只聚合。

---

## 八、真实库数据表（2026-08-24 只读）

| 实体 | 数值 |
|---|---|
| follow_up_task | 2818（superseded 1601 / pending 1131 / done 73 / 其他 13） |
| follow_up_task.source_message_id 覆盖率 | **1/2818**（缺口 G2） |
| follow_up_task.done 分布 | urge_customer 72 + ai_detected 1（规则任务零完成） |
| customer_profile | 200（了解76/比价67/成交26/流失21/决策9/unknown1） |
| last_stage_change_at 非空 | **0**（写者已就位，部署时序未激活） |
| quote_signal（crm 库） | 22（22/22 已回复） |
| customer_event 表 | 不存在（E3 0 基线，app 未重启） |

---

## 九、三钉结论

### 钉 1：真实六段漏斗

```
① 行动产生   follow_up_task（created_at + trigger_type）
② 行动曝光   （缺口 G1：今日行动卡加载无事件）
③ 销售执行   customer_event：script_copied / chat_opened / follow_up_done
④ 客户响应   customer_event：customer_replied / quote_asked
⑤ 有效推进   customer_profile.stage 前进（intent_tag_log changedAt / last_stage_change_at）
⑥ 商机转化   customer_profile.stage = won（成交）
```

用户建议的「打开客户聊天」独立成段不成立——它与「话术复制」同属 ③ 销售执行（同一卡片两个按钮，E3.3 已统一为行动事件）。

### 钉 2：每段唯一事实来源

| 段 | 唯一来源 | 约束 |
|---|---|---|
| ① | follow_up_task.created_at | 按 trigger_type 分组，superseded 不重复计 |
| ② | 无（缺口 G1） | 待拍板：补事件 or 用 suggest 生成近似 |
| ③ | customer_event（source=manual） | E3.3 写路径已通 |
| ④ | customer_event（source=system）+ quote_signal 回流 | E3.2 双写 + crm 库兼容字段 |
| ⑤ | intent_tag_log changedAt 序列（历史）+ last_stage_change_at（部署激活后） | 无第二 stage 真源 |
| ⑥ | customer_profile.stage=won | 与 CRM 漏斗同源，不重复统计 |

### 钉 3：correlation key 现状与缺口

**现状**：只有 session_id 可靠串链（必填列）；message_key 仅覆盖 E3.2 事件；**task_id 完全没有**。

**结论：Action correlation 目前不存在，但补丁成本极低**：
- `task_id` 补丁：customer_event 加可选列 `task_id INTEGER NULL`（E3.3 未动 event_type CHECK，加列合法）——follow_up_done 由 completeAction 直写 before.id；script_copied/chat_opened 由前端 `sources[].rawTaskId` 上报（已存在，无需新组装）
- `message_key` 缺口 G2（规则任务 1/2818）：P0-1 透传在规则引擎 todoCreate 无写入点——**P0-4 不做历史回填**（E3 先例），只保证新链路

**最小编译单元**：`session_id + task_id + message_key` 三元组可把「哪条建议 → 哪次执行 → 哪次客户回复 → 阶段推进」串成完整链路。

---

## 十、P0-4 拆刀建议（待用户拍板）

| 刀 | 内容 | 关键决策 |
|---|---|---|
| **P0-4.1 盘点**（本刀） | 只读盘点 + Scope Lock | ✅ 已交付 |
| **P0-4.2 Funnel 原语/read model** | ① customer_event 加 `task_id` 列（nullable）+ E3.3 写点补 task_id（follow_up_done 直写 before.id；前端 rawTaskId 上报 script_copied/chat_opened）② `getActionFunnel(days?)` 只读组装层：六段计数 + 段间转化率 + 每段事实来源 ③ 护栏测试 | 需拍板：② 曝光段如何处理（缺口 G1）——建议本期承认不可测，标记「无事件段」 |
| **P0-4.3 UI/KPI 消费** | Funnel 视图（今日行动页/销售工作台新增） + KPI 卡（执行率/回复率/转化率） | 需拍板：入口与展示范围 |
| **P0-4 CLOSED** | 收口护栏 + 真实库运行态验收 | 同 E3 先例 |

**Scope Lock 草案**（供 P0-4.2 前拍板）：
- 只做 Funnel read model + 消费，不新增任何表（除 customer_event 加列）
- 不迁移不改造：follow_up_task 状态机 / R7 / 周报 / CRM 漏斗（各自保留）
- 不做：历史回填 / G1 曝光事件补全（本期承认 ② 不可测）/ 第二套日志
- 北极星 = **Executed → Responded 转化率**（销售动作的真实客户反馈），非点击量

---

## 十一、文档同步

- HANDOVER §2.35 尾部 + §10 待办更新（P0-4 启动，本盘点）
- AGENTS.md 进度行更新
- 本盘点零编码：唯一交付 = 本文档
