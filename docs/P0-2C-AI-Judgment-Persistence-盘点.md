# P0-2C — AI 判断持久化（盘点与设计）

> 状态：**盘点 + 设计稿**（只读调研，未改任何代码）
> 范围：客户级 AI 判断四字段 `summary / opportunity / risk / nextAction` 的持久化缺口与最小契约
> 关联：P0-2A Canonical State（`customer_profile.stage` 当前值）、P0-2B Evidence Resolver（messageKey → 原话回查）
> 铁律：**P0-2C 不另造 evidence 机制，证据统一走 P0-2B**

---

## 0. 结论先行

1. 四字段里，**没有一个是"带证据、可追溯、有当前投影"的 AI 判断记录**。
2. 与它们最接近的持久化载体分别是：
   - `summary` → `insight_record`（AI 见解历史）+ `insight_profile_record.finalProfile`（关系画像）；
   - `opportunity` → `opportunity` 表（**规则信号驱动**，不是 AI 判断）；
   - `risk` → `crm_risk` 表（**规则信号驱动**，`source_msg` 列存在但从未写入）；
   - `nextAction` → `follow_up_task.analysis`（仅预热路径落一次）+ `sales:action:suggest` / 客户 360 的**现场生成、不落库**。
3. AI 判断目前只有**两类**有证据锚点（可 P0-2B 回查）：`intent_tag_log`（stage 判断，message_key + evidence_text）与 `account.enrich_meta`（字段提取，每字段 evidence + sourceId=messageKey）。`follow_up_task.source_message_id` 是触发证据，不是判断证据。
4. 生成链路全部**无状态、无输入快照**：同一客户重复生成会得到不同结果（唯一节流是 AI 见解 12h 去重）。**无统一失效/更新模型**。
5. 最小契约（设计倾向，未定稿）：**append-only 判断历史 + 当前投影**，建议复用/泛化 `intent_tag_log` 的证据模式（judgment_type × message_key × evidence_text × confidence × model），而非复制 `enrich_meta` 的覆盖式 JSON。

---

## 1. 现状：四字段从哪来、落到哪

### 1.1 summary（客户 AI 摘要/见解）

| 来源 | 输入 | 输出 | 落点 | 触发 |
|---|---|---|---|---|
| `insightService.generateInsightForSession`（insightService.ts:1749） | 最近 40 条消息 + 画像 + 朋友圈/社交 + 可选销售阶段 | 纯文本 ≤80 字 + `【阶段：X】` | `insight_record`（JSON 文件，append-only，含 rawOutput/prompt 全量日志） | 活跃/沉默扫描 / 手动 / 批量；**非手动 12h 去重**（insightService.ts:1759-1767） |
| `insightProfileService`（关系画像） | 按月窗口消息 | `finalProfile` + `monthlySummaries[]` | `insight_profile_record`（JSON 文件，含 rangeStart/rangeEnd/model） | 手动生成 |
| `salesReportService.generateReport`（salesReportService.ts:362） | 统计（消息量/活跃数/TOP 客户/每日趋势），**无聊天内容** | 2-3 句摘要 | `report_snapshot.ai_summary` | 周/月报告生成 |

### 1.2 opportunity（机会）

| 来源 | 输入 | 输出 | 落点 | 触发 |
|---|---|---|---|---|
| `crmParseService`（crmParseService.ts:180-195）`parseBuySignal` | 单条消息文本（**正则**） | 采购信号 {product, quantity, amount, detail} | `opportunity`（opportunityUpsertBySignal，crmDbService.ts:806 起） | 消息入库时 |
| `insightService`（insightService.ts:1738）`syncOpportunityStageByAccount` | AI 见解解析出的阶段 | 顺推 了解→比价→决策 / 成交→待登记提醒（deal_pending）/ 流失→lost | `opportunity.stage` + `opportunity_event` | 见解生成后 |
| `generateActionAnalysis`（salesActionEngine.ts:1084）`opportunity` 字段 | actionItem + 知识库 + 聊天摘要 | AI 判断的机会描述（1-2 句） | **预热路径** → `follow_up_task.analysis` JSON；客户 360 / `sales:action:suggest` → **不落库** | 全量扫描预热 / on-demand |

### 1.3 risk（风险）

| 来源 | 输入 | 输出 | 落点 | 触发 |
|---|---|---|---|---|
| `crmParseService`（crmParseService.ts:196-209）`parseRiskSignal` | 单条消息文本（**正则**：竞品/价格/服务） | 风险信号 {riskType, severity, detail} | `crm_risk`（upsertRisk，同类型 active 幂等累积，crmDbService.ts:854 起）。**`source_msg` 列存在但从未写入** | 消息入库时 |
| `generateActionAnalysis` `riskSignal` 字段 | 同上 opportunity | AI 判断的风险（1-2 句） | 同 opportunity：预热 → analysis JSON；on-demand → 不落库 | 同上 |

### 1.4 nextAction（下一步）

| 来源 | 输入 | 输出 | 落点 | 触发 |
|---|---|---|---|---|
| `generateActionAnalysis` `nextMove` 字段（+ `script`/`whyNow`） | actionItem + 知识库 + 聊天摘要 | AI 判断的下一步动作（一句话） | 预热 → `follow_up_task.analysis`；客户 360（crmIpcHandlers.ts:188）/ `sales:action:suggest`（main.ts:4909）→ **现场生成不落库** | 全量扫描预热 / on-demand |
| `follow_up_task.title` + `promise_summary` | 规则触发 / `salesFollowUpService` 承诺提取 | 待办标题 + 承诺摘要 | `follow_up_task`（P0-1 证据 `source_message_id`） | 扫描/消息入库 |

---

## 2. 数据来源（喂给 LLM 的输入材料）

| 生成器 | 材料构成 | 是否有输入快照 |
|---|---|---|
| 阶段分类 `salesStageClassifier` | `toMessageSnippets`（最近 10 条消息文本） | 无（实时读） |
| 意向 `salesIntentService` | 最近消息格式化文本 | 无 |
| AI 见解 `generateInsightForSession` | 40 条消息 + 画像 + 朋友圈 + 社交 | 无（但 `insight_record.log` 保存了完整 userPrompt → **事后可重建输入**，这是全系统唯一接近快照的载体） |
| 字段提取 `crmEnrichService` | `gatherMaterials`（80 条消息 + 10 条见解 + 画像，截断 3000 字符） | 无（`enrich_meta` 记录了依据的 `sourceId`=最近一条消息 messageKey） |
| 深度分析 `crmDeepAnalysisService` | 最近 100 条消息 | 无（不落库） |
| 动作分析 `generateActionAnalysis` | actionItem + 知识库命中 + 最近聊天摘要（`degradationNote`） | 无 |

**关键事实**：所有链路都实时读消息，不冻结输入。同一个客户，消息变化后重新生成 → 结果变化。`insight_record.log.userPrompt` 是唯一可重建输入的证据，但它记录的是"生成了什么"，不是"基于哪条消息判断的"。

---

## 3. 生成链路（15 个 LLM 调用点中，与四字段相关的 6 条）

```
消息入库 → crmParseService（正则，非 LLM）→ opportunity / crm_risk          ← 规则信号，无 LLM
消息入库 → onNewMessage → classifyStage → intent_tag_log（stage + message_key + evidence_text）  ← P0-1 证据
                └→ R3 规则 → follow_up_task（source_message_id）
扫描/手动 → generateInsightForSession → insight_record（见解 + 阶段 signal）
                └→ applyParsedStageSignal → intent_tag_log（source='ai'，无 message_key/evidence_text）  ← 缺口
                └→ importIntentCustomerToCrm → enrichCustomer → account（enrich_meta 每字段证据）
on-demand → deepAnalyzeSession → 七板块 markdown（不落库）
全量扫描预热 / on-demand → generateActionAnalysis → {whyNow, opportunity, riskSignal, script, nextMove}
                ├→ 预热（salesActionEngine.ts:518）→ follow_up_task.analysis（JSON 字符串）
                └→ on-demand（main.ts:4909 / crmIpcHandlers.ts:188）→ 现场返回，不落库
```

### 同一客户重复生成是否会得到不同结果？

**会，且无历史可查**。唯一例外是 AI 见解的 12h 去重（非手动触发）。阶段分类只在阶段变化时写（prevStage === result.stage 跳过）。字段提取每次重跑都重新合并。其余 on-demand 链路（deepAnalyze / action suggest / 客户 360 advice）每次生成新结果，**无记录表明上一次判断是什么、基于什么**。

---

## 4. 证据：每个结论能否回查原话（P0-2B）

| 结论 | 证据载体 | 可 P0-2B 回查？ |
|---|---|---|
| AI 阶段判断（intent_tag_log） | `message_key`（canonical/server:/裸ID 兼容）+ `evidence_text`（原话依据句） | ✅ `getEvidenceByKey` |
| 待办触发（follow_up_task） | `source_message_id`（P0-1 证据） | ✅ |
| 字段提取（enrich_meta） | 每字段 `evidence`（原话摘录）+ `sourceId`（messageKey） | ✅ |
| 消息解析（messageInsight） | `targetMessageKey` / targetLocalId / targetCreateTime | ✅ |
| AI 见解（insight_record） | **无 messageKey 锚点**（只有 rawOutput/prompt 日志） | ❌ |
| AI 阶段 signal（insight → intent_tag_log source='ai'） | **未带 message_key/evidence_text**（salesInsightWrite.ts:26） | ❌ |
| 商机/风险（opportunity/crm_risk） | 规则信号；`crm_risk.source_msg` 存在但**从未写入** | ❌ |
| 动作分析（generateActionAnalysis） | 五字段无证据字段；`follow_up_task.analysis` 只是 JSON 串 | ❌ |

**结论**：系统里已经存在三种证据写法（intent_tag_log 的 message_key+evidence_text、enrich_meta 的 evidence+sourceId、insight_record 的完整 prompt 日志），但四字段中 opportunity/risk/nextAction 的 AI 判断、以及 AI 见解的阶段 signal，都**缺证据锚点**。

---

## 5. 持久化缺口

1. **机会/风险/下一步 的 AI 判断主体不持久化**。`generateActionAnalysis` 的五个字段只有预热路径落进 `follow_up_task.analysis`（一条任务一份），客户 360 与 `sales:action:suggest` 每次现场生成。同一客户的"当前机会/风险/下一步"没有稳定读数。
2. **`crm_risk.source_msg` 是空列**。规则信号产生风险时连"哪条消息触发的"都没记，遑论 AI 判断。
3. **无统一 judgment 契约**。阶段判断有 `intent_tag_log`，字段提取有 `enrich_meta`，但四字段无对应载体；`analysis` JSON 是非结构化字符串，无法按类型查询/投影。
4. **无当前投影（current projection）**。`summary/opportunity/risk/nextAction` 的"当前值"是各调用点动态拼的（unified signal、客户 360 advice 现场生成），没有稳定、可缓存、可失效的投影层。
5. **无失效/更新模型**。除了见解 12h 去重和阶段变化才写，没有任何"新消息 → 旧判断 stale"的统一语义。
6. **无输入快照**。判断"基于哪个时间范围的哪批消息"未记录（仅 insight_record 有完整 prompt 日志可事后重建，但不含时间范围）。

---

## 6. 更新 / 失效模型（现状盘点 + 设计倾向）

### 6.1 现状（各写者自行决定）

| 写者 | 更新语义 | 失效语义 |
|---|---|---|
| 阶段分类 | 新消息到达即分类，阶段变化才写 | 覆盖式（customer_profile.stage）+ append-only（intent_tag_log 历史） |
| AI 见解 | 非手动 12h 去重；手动可覆盖重析 | 见解记录 append-only；无"旧见解失效"标记 |
| 字段提取 | 每次重跑合并，置信分级 + 手动/locked 保护 | 无失效，只增证据 |
| 动作分析 | 预热一次 / on-demand 现场生成 | 无失效，任务完成即弃 |

### 6.2 设计倾向（复用现有模式，不新发明）

- **采用 阶段分类 的模式**：判断是 append-only 历史（`intent_tag_log` 已是此形态），当前值由投影层取最新一条。
- **失效触发**：新消息到达（已有 `onNewMessage` / DB monitor 信号）→ 将相关判断标记 stale，或由投影层按时间/消息序号决定是否重算。**不预设具体规则**——本项目已存在三种节奏（变化才写 / 12h 去重 / 现场生成），最小契约应只规定"判断记录带 generatedAt + basis（消息范围）"，失效判定留给投影层。
- **教训锚点**：12h 去重的根因是"冷却标记在内存、重启即清零导致反复分析"（insightService.ts 注释）——任何新去重/失效逻辑必须落库，不能只靠内存。

---

## 7. 最小契约（设计稿，未定稿）

### 7.1 统一 judgment 记录（倾向：新表，仿 intent_tag_log 泛化）

```
customer_judgment (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT NOT NULL,
  judgment_type TEXT NOT NULL,        -- 'stage' | 'summary' | 'opportunity' | 'risk' | 'next_action'
  value         TEXT NOT NULL,        -- 判断值（文本/JSON）
  confidence    REAL,
  source        TEXT NOT NULL,        -- 'ai' | 'auto_message_trigger' | 'manual' | 'deal_rule' ...
  model         TEXT,                 -- 生成该判断的模型（PRD§23 可追溯）
  reason        TEXT,                 -- 判断依据句
  message_key   TEXT,                 -- P0-2B 证据锚点（回查原话）
  evidence_text TEXT,                 -- 原话依据句
  basis         TEXT,                 -- 输入快照/消息时间范围（JSON），可选
  generated_at  INTEGER NOT NULL,
  created_at    INTEGER NOT NULL
)
```

- 每类型 **append-only 历史**；当前投影 = 该 session 该类型最新一条（或按 source 加权）。
- `message_key`/`evidence_text` 完全复用 intent_tag_log 的既有模式，回查统一走 P0-2B `getEvidenceByKey`。
- `stage` 类型与现有 `intent_tag_log` 的关系（合并 vs 迁移 vs 保留双写）——**待定，列入拆刀讨论**，不在本期实现。

### 7.2 写入契约（每类判断落一条记录，带证据）

| 判断类型 | 落库时点 | 证据锚点 |
|---|---|---|
| stage | 复用现有 intent_tag_log 写点（改动最小） | 已有 message_key/evidence_text |
| summary | `generateInsightForSession` 输出后 | 触发消息 messageKey（需从 trigger 上下文补） |
| opportunity / risk / next_action | `generateActionAnalysis` 输出的三个调用点（预热 / suggest / 客户 360）统一落一条 | actionItem 关联的 source_message_id 或最近消息 key |

### 7.3 不做的边界（用户已明确）

不改 schema / 不改 LLM prompt / 不改 UI / 不把 `generateActionAnalysis()` 直接落库为现有 analysis / 不删除现有现场生成 / 不做历史数据迁移 / 不做事件模型实现。

---

## 8. 实施拆刀（建议：3 把独立刀）

每刀独立可回滚、独立提交、独立验证（本地 commit，不 push origin）。

| 刀 | 内容 | 验证 | 是否触碰边界 |
|---|---|---|---|
| **刀 1：数据契约 + 读写层** | 新建 `customer_judgment` 表（schema + migration）+ `customerJudgmentDbService`（append 判断 / 按类型取最新投影 / 按 session 列历史）+ 纯函数测试 | `npx tsc --noEmit` 0 错误 + `scripts/judgment-db-test.ts` | 只加表，不改任何现有调用 |
| **刀 2：stage/summary 落 judgment** | insightService 阶段 signal 与见解补 message_key/evidence_text 后落 judgment（summary/stage）；复用 P0-2B 回查 | judgment-db-test + 回归 insight-stage-ban-test / insight 相关 | 不删 intent_tag_log，不迁移历史 |
| **刀 3：opportunity/risk/next_action 落 judgment** | `generateActionAnalysis` 三个调用点统一落 judgment（机会/风险/下一步），替代"预热写 analysis JSON + on-demand 丢弃" | judgment-db-test + action-engine 相关回归 | 不删 `follow_up_task.analysis` 现有写入，新链路与旧链路并存一段 |

**备选合并**：若想最小化（单刀），刀 2+3 可合并为一刀"把现有 AI 判断输出点统一接到 judgment 记录"，但会一次触碰 insight + actionEngine 两条链路，验证面变大。**推荐 3 刀**。

**暂缓项（设计里明确，本期不做）**：失效/更新模型的具体规则（投影层如何判定 stale）、intent_tag_log 与 customer_judgment 的合并/迁移、UI 展示层。

---

## 附：盘点过程中确认的关键代码位

- `generateActionAnalysis`：salesActionEngine.ts:1084（定义）、:518（预热落库）、main.ts:4909（suggest）、crmIpcHandlers.ts:188（客户 360）
- `follow_up_task.analysis` 列：salesDbService.ts:220（ALTER）、:604（todoUpdate）
- `intent_tag_log` 写点：salesStageClassifier.ts:167 / salesIntentService.ts:184 / salesInsightWrite.ts:26 / legalStageWriters.ts:47,63
- `enrich_meta` 契约：crmDbService.ts:212（EnrichFieldMetaEntry：source/confidence/at/evidence/model/sourceId）
- AI 见解去重根因：insightService.ts:1759-1767 注释（内存冷却、重启清零）
- `opportunity`/`crm_risk` 均为正则信号：crmParseService.ts:180-209；`crm_risk.source_msg` 空列：crmDbService.ts:80
