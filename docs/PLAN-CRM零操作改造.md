# CRM 零操作改造方案（AI 自动填充 + 见解联动 + 客户 360）

> 状态：**待评审**（2026-08-17）。评审通过后按 §9 提交计划实施。
> 对齐：PRD-v2 核心原则「用户不录入、不标记、不操作——所有数据从微信聊天自动提取，用户只做看清单和打勾」。
> 调研依据：客户 360 单屏（Twenty / CordysCRM issue#84 / 纷享销客同构）；AI 对话提取字段→预览→写入+来源标注（Relaticle / Comp AI CRM / WorkBuddy-Cordys 同款）。只借设计不借代码（GPL 红线 + 单机 Electron 场景，与 v6 方案结论一致）。

## 1. 问题（代码级证据）

1. **自动导入只写 3 个字段**：`crmImportService.importCustomerFromProfile` 仅传 `{name, sessionId, stage, reason}`；account 表的 `industry/province/city/phone/custom_fields` 全部空置，AI 画像（finalProfile，2000 字）用完即丢。
2. **灵感信箱与 CRM 零联动**：InsightInboxPage 卡片只有「打开聊天/复制见解」，无 CRM 状态；CRM 客户页看不到该客户的见解历史。
3. **页面简陋**：客户 tab = 裸 `<table>` + 裸 `<input>`；新建合同需手填 8 个输入框，直接违反零操作原则。

## 2. 设计原则

- **零操作**：字段由 AI 扫描自动填，用户只做确认/修正；手改即锁定（AI 不再覆盖）。
- **来源可溯**：每个自动填充字段带 `source/confidence/at/evidence`，页面显示「🤖AI提取」角标。
- **不建第二套架构**：复用 `enqueueSalesTask` 串行队列、`ensureColumn` 迁移模式、确认中心 evaluate 模式、`crm:customer:profile` IPC、`--wf-*` 设计体系。
- **合规铁律不变**：无发送、无删除端点、数据本地、日志脱敏。

## 3. 总体架构

```
微信聊天 ──► AI 见解扫描(insightService，已有) ──┐
微信聊天 ──► 关系画像(insightProfileService，已有) ─┤
                                                    ▼
                          crmEnrichService（新）：AI 结构化提取
                                                    │
                ┌───────────────────────────────────┼────────────────────┐
                ▼ 高置信(≥阈值)自动写入               ▼ 低置信              ▼ 冲突/异常
        account 正式列 + custom_fields        确认中心「信息待确认」队列      enrich_log 审计
        （field_meta 记录来源/置信度）          （复用 evaluate/审核模式）
                │
                ▼
        客户 360 单屏视图（重建）◄──► 灵感信箱（徽章 + 深链 + 见解时间线）
```

## 4. P0 · 信息自动填充引擎（核心，≈3 人天）

### 4.1 数据层（crmDbService.ts，走现有 ensureColumn 迁移模式）

- account 新增正式列：`company TEXT`、`position TEXT`（高频、需列表展示/排序）。
- 业务扩展字段放 `custom_fields`（固定 key，不动 schema）：
  `needs`（需求描述）、`budget`（预算）、`intent_model`（意向型号）、`purchase_timeframe`（采购时间）、`competitor`（竞品）、`price_sensitive`（价格敏感度 high/mid/low）。
  与现有 `buyer_addr/buyer_bank/buyer_account/tax_no/buyer_phone`（甲方开票信息）共存，key 命名空间不冲突。
- account 新增列 `field_meta TEXT DEFAULT '{}'`：字段级元数据
  `{ "<field>": { "source": "ai"|"manual", "confidence": 0.87, "at": 1739000000000, "evidence": "聊天原话摘录≤40字", "locked": false } }`
  `pending` 子键存低置信待确认值：`{ "pending": { "<field>": {value, confidence, evidence, at} } }`。
- 合并规则（`mergeEnrichFields` 纯函数，可单测）：
  1. 目标字段为空 → 直接写入；
  2. `locked=true` 或 `source=manual` → 永不覆盖（手改优先）；
  3. 已有 ai 值且新值 confidence ≥ 旧值 → 覆盖（新证据赢），否则保留；
  4. 新旧值不同且都非空、置信度都高 → 进 pending 由人裁决（不静默覆盖）。

### 4.2 新服务 electron/services/crmEnrichService.ts

- `extractCustomerFields(sessionId, displayName, config)`：
  - 材料 = 近 N 条聊天上下文（wcdbService，截断复用 insightProfileService 的 clampText 模式，预算 3000 字）+ 该客户 insightRecords（若有）+ finalProfile（若有）。
  - AI 输出固定 JSON schema（沿用 INTENT_JUDGE_PROMPT 的 `simpleCompletion + responseFormatJson + temperature 0.2` 模式）：
    `{ company, position, phone, province, city, industry, needs, budget, intent_model, purchase_timeframe, competitor, price_sensitive, confidence: {...}, evidence: {...} }`
    prompt 铁律：只从材料提取、不推测不编造、拿不准的字段输出 null。
  - 电话/省市能正则校验的先本地校验（复用 crmParseRules 风格），校验过的 confidence 加成。
- `enrichCustomer(sessionId, opts)`：取/建 account（复用 importCustomerFromProfile 幂等逻辑）→ 提取 → mergeEnrichFields → 写库 + logActivity（沿用现有 activity 审计）。
- `backfillEnrich(limit)`：扫 `account` 中核心字段为空的存量客户，按 imported_at 倒序，限额串行（enqueueSalesTask），每客户间隔防抖；完成写 salesLog 汇总。
- 所有执行入口一律 `enqueueSalesTask`（铁律），服务内部绝不 enqueue。

### 4.3 触发点（全部挂现有管道）

| 触发 | 位置 | 说明 |
|---|---|---|
| AI 见解命中意向 | `insightService.ts:1909` `importIntentCustomerToCrm` 成功后 | 追加 `void enrichCustomer(sessionId)`（enqueue） |
| 画像完成导入 | `main.ts:2101` `judgeAndImportCrmCustomer` imported=true 后 | 同上 |
| 手动补全 | 客户 360 页「AI 补全」按钮 | IPC `crm:enrich:run` |
| 存量回填 | 设置页/客户页「批量 AI 补全」按钮 | IPC `crm:enrich:backfill`，限额配置 |

### 4.4 确认中心「信息待确认」队列

- `crmDbService.reviewQueues()` 增加 `infoPending` 队列（从 account.field_meta.pending 派生，同现有四队列的派生模式，不建新表）。
- 纯判定函数 `evaluateInfoField()` 加进 crmAutoConfirmService 风格：confidence ≥ `crmEnrichAutoApply`(默认 0.85) 自动转正；0.7~0.85 留人工；<0.7 丢弃记日志。
- CrmReviewPage 新增第 5 个 tab「信息待确认」：每行 = 客户 + 字段 + AI 值 + 证据摘录，操作「采纳/放弃」；采纳写入并 locked=false（后续 AI 可再更新），放弃清 pending。
- 审计复用 `auto_confirm_log`（type 区分 `info_auto`/`info_manual`）。

### 4.5 配置项（SettingsPage + config 默认值）

- `crmEnrichEnabled`（true）：自动填充总开关
- `crmEnrichThreshold`（0.7）：进 pending 的下限
- `crmEnrichAutoApply`（0.85）：自动转正阈值
- `crmEnrichBackfillLimit`（20）：单次回填客户数上限（控 token 成本）

### 4.6 IPC / preload

- 新增：`crm:enrich:run(sessionId)`、`crm:enrich:backfill()`、`crm:enrich:pending()`；preload `crm.enrich.*` 暴露。注册进 crmIpcHandlers.ts 现有列表。

## 5. P1 · 灵感信箱联动（≈1.5 人天）

1. **信箱卡片 CRM 状态**：新增 IPC `crm:accounts:bySessions(sessionIds[])`（批量查，避免 N+1）；InsightInboxPage 卡片显示「已入 CRM」徽章 + 「查看档案」按钮 → `navigate('/crm?tab=customer&id=' + accountId)`。
2. **客户档案见解时间线**：扩展 `crm:customer:profile` 返回（该 IPC 已聚合 salesDb 数据，追加 insightRecordService 按 session 查出的见解列表，倒序取 20 条）。
3. 顺带打通前期审计的深链断点：行动卡/仪表盘 → 客户档案（同 1 的路由协议）。

## 6. P2 · 客户 360 页面重建（≈2.5 人天）

- **路由协议**：`/crm` 解析 `?tab=customer&id=<accountId>`（CrmWorkbenchPage 现有 tab state 扩展）。
- **客户 360 视图**（替换客户 tab 的裸表格，参考 Twenty/Cordys 布局，复用 --wf-* 变量）：
  - 头部：名称/公司/阶段徽章/负责人/最近联系；
  - 左栏「客户信息」字段卡：每字段 = 值 + 来源角标（🤖AI提取·置信度 / ✍️手动）+ 证据悬浮；点击编辑 → 保存即 locked；空字段显示「AI 未提取到」灰态 + 「AI 补全」按钮；
  - 右栏「动态时间线」：见解/活动日志(logActivity 已有)/合同/到款混排；
  - 底部：AI 建议区（深度分析入口，已有 `crm:customer:profile` 深度分析）。
- **新建合同零操作化**：「新建合同」改为先选客户（下拉=account 列表）→ 甲方开票信息从该客户 custom_fields 自动带出 → 用户只补金额/行项 → 创建。
- 客户列表保留但升级：列 = 名称/公司/阶段/电话/最近联系/AI 填充度（已填字段数/总字段数，空字段多的排前面提示补全）。

## 7. 文件改动清单

| 文件 | 类型 | 内容 |
|---|---|---|
| `electron/services/crmEnrichService.ts` | 新增 | 提取+合并+回填引擎 |
| `electron/services/crmDbService.ts` | 修改 | account 新列迁移、field_meta、mergeEnrichFields、reviewQueues+infoPending、accountsBySessions |
| `electron/services/crmAutoConfirmService.ts` | 修改 | evaluateInfoField + info 队列编排 |
| `electron/services/crmIpcHandlers.ts` | 修改 | 新 IPC 注册、customer:profile 扩展 |
| `electron/preload.ts` | 修改 | crm.enrich.* / accountsBySessions 暴露 |
| `electron/services/insightService.ts` | 修改 | :1909 导入后触发 enrich（约 3 行） |
| `electron/main.ts` | 修改 | :2101 导入后触发 enrich（约 3 行） |
| `electron/services/config.ts` + `src/pages/SettingsPage.tsx` | 修改 | 4 个新配置项 |
| `src/pages/InsightInboxPage.tsx` | 修改 | CRM 徽章 + 查看档案深链 |
| `src/pages/CrmWorkbenchPage.tsx` | 重构 | 客户 360 视图 + 新建合同选客户流程 |
| `src/pages/CrmReviewPage.tsx` | 修改 | 第 5 tab「信息待确认」 |
| `src/stores/`（如涉及） | 修改 | 跟随现有 store 模式 |
| `scripts/crm-enrich-test.ts` | 新增 | 纯规则单测 |

## 8. 测试

- `scripts/crm-enrich-test.ts`（纯规则、mock AI 输出，同现有测试模式）：
  - mergeEnrichFields 四规则正反例（空写入/手动锁定不覆盖/ai 覆盖/冲突进 pending）
  - field_meta 读写与 pending 生命周期
  - evaluateInfoField 三档阈值
  - backfill 幂等（重复执行不重复写）+ 限额
  - 提取 JSON 解析容错（缺字段/null/幻觉字段丢弃）
- 手动 golden：挑 3 个真实客户（1 大单在谈 / 1 已成交 / 1 纯熟人），验证提取准确性与熟人不过度填充。
- 回归：`tsc --noEmit` + 现有 5 个测试套件全过（enrich 改动不得破坏 autoconfirm/workbench 基线）。

## 9. 提交计划（3 个增量）

1. `feat: CRM 信息自动填充引擎（crmEnrichService + field_meta + 双触发点 + 回填 + 单测）`
2. `feat: 确认中心「信息待确认」队列 + 灵感信箱 CRM 联动（徽章/深链/见解时间线）`
3. `feat: 客户 360 单屏视图 + 新建合同零操作化 + 客户列表填充度`

每个提交前：tsc 零错误 + 相关测试过 + HANDOVER/AGENTS 同步（规范第四节）。

## 10. 风险与非目标

**风险**：
- token 成本：材料截断 3000 字 + 回填限额 + 仅意向客户触发（非全量联系人）；
- AI 幻觉：prompt 铁律「不推测」+ evidence 必填 + 低置信进人工队列 + 手改锁定；
- 过度填充熟人：沿用 isInternal 排除 + 仅对已导入 CRM 的客户 enrich。

**非目标（不做）**：不动现有四队列与合同/到款/物流/发票流程；不新建数据库；不加发送能力；不做多账号协同。

## 11. 工作量

P0 ≈ 3 人天，P1 ≈ 1.5 人天，P2 ≈ 2.5 人天，合计 **≈7 人天**。
