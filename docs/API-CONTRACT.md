# API-CONTRACT — WeFlow 接口契约（Phase 0 D5 · 2026-09-02 拍板收缩版）

> 状态：D5 骨架定稿（2026-09-02）；§3 中央主机内网 API 于 2026-09-14 随 Phase 3a 实现补齐。
> 冲突裁决顺序：PRD v3.4 ≥ DATA-CONSTITUTION ≥ 启动细化 ≥ 本文档。
>
> **分层深度（9/2 拍板，不得超纲）**：
>
> | 层 | 深度 | 说明 |
> |---|---|---|
> | IPC 层（主进程 ↔ 渲染层） | **端点级完整** | 现有 113 通道（crm:71 + sales:42）从实际代码梳理 + Phase 0/1 新增端点规范 |
> | 本机 HTTP 只读层 | 端点级 | 延续 `docs/HTTP-API.md` 现状梳理，本篇做契约摘要与差距标注 |
> | 中央主机内网 API | **端点级已实现** | Phase 3a 已落地 11 个端点（§3），含认证/能力矩阵/幂等/禁字段/显式投影表 |
> | 本机 Hermes Tool Gateway | **端点级已实现** | Electron/Utility 内部 9 个只读白名单工具，见 §4.1 |
> | 中央 MCP 工具面 | **只写规范** | Phase 3b 对外服务的命名/输入输出/错误/审计规范，见 §4.2 |
>
> ✅ **中央主机内网 API（§3）已按 Phase 3a 实现**，端点级契约与代码一致（`central/src/app.ts`）。
> ⚠️ **中央 MCP（§4.2）仍是占位规范**，Phase 3b 落地时补齐；本机 Hermes Tool Gateway 已随 Phase 2
> 实现，不能与未来对外 MCP 混称。本篇中 Phase 0/1 新增 IPC 端点为规范级（参数/响应/错误码/
> 幂等完整，实现属 Phase 1）。

---

## 0. 总则

- **通道命名**：`域:资源:动作`，小驼峰（`crm:lead:list` / `sales:kb:create`）。域前缀与库对齐：
  `crm:*` → crmDbService（weflow-crm 库），`sales:*` → salesDbService（weflow-sales 库）。
- **桥接**：渲染层经 `electron/preload.ts` 的 `crm` / `sales` 命名空间调用（通道 ↔ preload 方法
  一一对应，71+42 全对齐；本契约以**通道名**为锚点，preload 方法名见 preload.ts）。
- **错误模型（现状盘点，如实记录）**：
  - 多数 handler 为薄包装（service 直返/直抛）：抛错 → IPC reject → 渲染层 `catch (e)` 拿
    `e.message` 字符串，**无结构化错误码**；
  - 部分 handler 返回信封：`{ success: boolean, error?: string }` 或 `{ ok: boolean, reason?: string }`。
  - **新增端点（§1.14 起生效）统一信封 + 错误码**；既有端点不回改（避免无收益大改）。
- **幂等等级标注**（每端点标一级）：
  - `R` 纯只读，天然幂等；`U` 唯一约束幂等（重复执行不产生第二份数据）；
  - `S` 状态机守卫（非法前置状态被拒，如「仅待签约可签」）；`N` 非幂等（前端需防抖/确认）。
- **写入纪律（宪法）**：AI 三档（A=auto / B=proposed→confirm / C=request→审批）；归属变更类
  动作须同事务写 `ownership_history` + `audit_event`（§1.14 新端点为强制项）。

---

## 1. IPC 层（端点级完整）

### 1.1 通用实体网关（crm:entity:* 等，10 通道）

| 通道 | 请求参数 | 响应 | 幂等/备注 |
|---|---|---|---|
| `crm:entity:list` | `entity: string, opts?: { filter?, page?, pageSize?, … }` | `CrmRow[]` | R。entity 须在 ENTITIES 白名单（crmDbService） |
| `crm:entity:get` | `entity: string, id: number` | `CrmRow \| null` | R |
| `crm:entity:create` | `entity: string, payload: object` | `number`（新 id） | U（唯一约束兜底）。白名单外 entity 抛错；`entity === 'opportunity'` 抛错（商机禁止通用散写） |
| `crm:entity:update` | `entity: string, id: number, patch: object` | `boolean` | N（局部字段覆写）。`entity === 'opportunity'` 仅允许 `shipped_qty` / `delivery_date`，其余字段抛错 |
| `crm:form:get` | `entity: string` | 表单定义（含 crm_field_meta 自定义字段） | R |
| `crm:fieldmeta:save` | `meta: object` | `boolean` | N。自定义字段元数据落库 |
| `crm:review:queues` | — | 跟单四队列聚合 | R |
| `crm:workbench` | — | 工作台聚合（统计卡/列表） | R |
| `crm:stats:overview` | — | 统计总览 | R |
| `crm:stats:aiAccuracy` | `days?: number`（默认 7） | AI 准确率统计 | R |

### 1.2 客户（account + 画像，10 通道）

| 通道 | 请求参数 | 响应 | 幂等/备注 |
|---|---|---|---|
| `crm:customers` | — | `account[]` + `profile_stage` / `profile_display_name`（salesDb 联查） | R。副作用：首次调用回填「微信号格式名 → 微信备注」（幂等，WCDB 未连则重试） |
| `crm:customer:profile` | `sessionId: string` | `{ success, data: { profile, aiProfile, todos, intentHistory, insights, account, contracts, credited, currentView, activities } }` | R。sessionId 空 → `{ success:false, error }` |
| `crm:customer:deepAnalysis` | `sessionId, displayName: string` | AI 七板块分析报告 | N（现场调 LLM，贵） |
| `crm:customer:delete` | `id: number` | `boolean` | N。级联删 + 删前备份 `crm-backups/` |
| `crm:account:ensure` | `name: string` | account（不存在则建） | U（按名 ensure） |
| `crm:accounts:bySessions` | `sessionIds: string[]` | 会话 → account 映射 | R |
| `crm:enrich:manualSet` | `accountId: number, field: string, value: string` | `boolean` | N。手动编辑并**锁定字段**（AI 不再覆盖，enrich_meta.locked） |
| `crm:enrich:run` | `sessionId, displayName?: string` | enqueue 句柄 | U（salesQueue 串行；AI 填充走置信分级） |
| `crm:enrich:backfill` | — | enqueue 句柄 | U（限额存量回填） |
| `crm:infoQueue:apply` | `accountId: number, field: string, action: 'accept' \| 'reject'` | `boolean` | S。信息待确认队列人工裁决 |

### 1.3 商机（opportunity，8 通道）

| 通道 | 请求参数 | 响应 | 幂等/备注 |
|---|---|---|---|
| `crm:opportunity:list` | `opts?`（筛选/分页） | 商机列表 | R |
| `crm:opportunity:get` | `id: number` | 商机详情 \| null | R |
| `crm:opportunity:events` | `id: number` | `opportunity_event[]` | R |
| `crm:opportunity:stats` | — | 商机统计 | R |
| `crm:opportunity:analysis` | — | `OpportunityAnalysisResult`（管道总览 + 仅 active 的阶段分段 + 各段优先处理名单，含最大卡点双指标） | R。只读跨库装配（crmDb + salesDb），零模型调用、零落库；事实源 `shared/opportunitySignals.ts`（§2.101） |
| `crm:opportunity:stage` | `id: number, stage: string` | `boolean` | S。写者='manual'（宪法 §1.9 四写者） |
| `crm:opportunity:close` | `id: number, status: 'lost', reason: string` | `boolean` | S。仅丢单；status≠lost 或 reason 空 → false；已关闭（won/lost）商机再次关单 → false |
| `crm:opportunity:registerDeal` | `id: number, payload: OpportunityDealPayload` | `{ ok: boolean, reason?: string }` | S。正式成交单点：成交字段 + status='won' + opportunity_event + audit_event 同事务，校验失败整体回滚 |
| `crm:opportunity:intentScore` | `accountId: number` | 意向分 0-100 \| null | R。跨库装配（salesDb 意向事件 + crmDb 商机），无 session → null |

### 1.4 风险（crm_risk，2 通道）

| 通道 | 请求参数 | 响应 | 幂等/备注 |
|---|---|---|---|
| `crm:risk:list` | `opts?` | 风险列表 | R |
| `crm:risk:resolve` | `id: number` | `boolean` | S。active → resolved |

### 1.5 线索（lead，10 通道；状态机 NEW→CONTACTED→WX_ADDED→ACCOUNT + DEAD/REOPEN）

| 通道 | 请求参数 | 响应 | 幂等/备注 |
|---|---|---|---|
| `crm:lead:import` | `source: string, fileName: string, rows: Array<Record<string, unknown>>` | 导入结果（成功/去重计数） | U。走 `importLeads` 唯一写路径（UNIQUE 去重 + SLA + lead_activity + import_batch）；⚠️ 群扫通道已下线（宪法 §4.2），source='群资源扫描' 不再有产生方 |
| `crm:lead:list` | `opts?`（筛选/分页/tag） | 线索列表 | R |
| `crm:lead:detail` | `id: number` | 详情 + 流水 \| null | R |
| `crm:lead:overview` | — | 状态统计 | R |
| `crm:lead:status` | `id: number, action: string, opts?` | 状态机流转结果 | S。动作合法性由 crmLeadService 守卫；DEAD 死因必填 |
| `crm:lead:toAccount` | `id: number` | 转客户结果（account_id 硬链接 + status=ACCOUNT） | S。重复转被状态机拒 |
| `crm:lead:scanSla` | — | 处理数 | U。SLA 卡 partial unique index 幂等；挂 runFullScan / getUnifiedSignals 两周期 + 启动兜底 |
| `crm:lead:slaComplete` | `taskId: number` | 完成（卡 done + lead→CONTACTED + 流水） | S |
| `crm:lead:slaSkip` | `taskId: number` | 跳过 | S |
| `crm:lead:deadReasons` | — | `DEFAULT_DEAD_REASONS` | R |

### 1.6 合同 / 报价 / 文档（10 通道）

| 通道 | 请求参数 | 响应 | 幂等/备注 |
|---|---|---|---|
| `crm:contract:sign` | `id: number` | `{ ok, reason? }` | S。仅 `pending_sign` 可签（已签/已发货被拒）；写 contract_status_history + activity |
| `crm:contract:ship` | `id: number` | `{ ok, reason? }` | S。仅 `signed` 可发货 |
| `crm:contract:delete` | `id: number` | `boolean` | N。级联 + 备份 |
| `crm:quotation:create` | `data: object` | 新报价 id | N。⚠️ Phase 1 版本链上线起改走 `crm:quote:createVersion`（§1.14），本通道保留兼容 |
| `crm:quotation:ai` | `sessionId, displayName: string` | AI 报价草稿 | N（现场调 LLM） |
| `crm:doc:generate` | `type: string, recordId: number, options?: { reuseExisting?: boolean, scope?: { accountKey, generation } }` | `{ ok, path?, reason? }` | N。模板 docxtemplater / exceljs；`reuseExisting=true` 且合同已有产物、文件仍在 → 直接返回该路径不重复生成 |
| `crm:contract:entryScope` | — | `{ accountKey: string, generation: number }` | R。录入链作用域指纹：下列三个通道必须回传同一 `scope`，账号切换后旧 scope 被 `assertContractEntryScope` 拒绝 |
| `crm:contract:beginEntry` | `input: { requestId, accountId?, name, amount, header, updateHeaderKeys? }, scope` | 合同行 | S。**按 `requestId` 幂等**（落 `contract.custom_fields.creation_request_id`）：同标识重复调用返回同一合同，不重复建客户/合同；`accountId=0` 建新客户，档案抬头五项全空直接写入，已有非空档案只写 `updateHeaderKeys` 勾选项 |
| `crm:contract:entryQuotation` | `data: { contract_id, items, creation_request_id }, scope` | `{ ok, id?, reason? }` | S。同合同同标识已存在报价版本则跳过创建；成功后 `persistNowStrict` 立即落盘 |
| `crm:contract:byCreationRequest` | `requestId: string, scope` | 合同 \| null | R。标识格式非法（非 `^[a-zA-Z0-9-]{16,80}$`）直接返回 null；页面刷新后按库恢复未完成流程，**防重复的权威防线是这次查询而非本地草稿** |

### 1.7 到款认领（allocation / payment，5 通道）

| 通道 | 请求参数 | 响应 | 幂等/备注 |
|---|---|---|---|
| `crm:allocation:confirm` | `id: number, patch: object` | 认领确认结果 | S |
| `crm:allocation:reject` | `id: number` | `boolean` | S |
| `crm:payment:approve` | `id: number` | `boolean` | S |
| `crm:payment:claim` | `id: number, patch: object` | 认领结果 | S。认领销售默认 `crm:currentSalesName` |
| `crm:payments:byDay` | `days?: number` | 每日到款列表 | R |

### 1.8 物流（logistics，4 通道）

| 通道 | 请求参数 | 响应 | 幂等/备注 |
|---|---|---|---|
| `crm:logistics:list` | `opts?: { filter?: 'unlinked' \| 'pending' \| 'signed' }` | 物流列表 | R |
| `crm:logistics:candidates` | `receiver, city: string` | 候选客户/合同匹配 | R |
| `crm:logistics:link` | `id: number, opts?: { accountId?, contractId?, ownerSales? }` | `boolean` | S。认领挂接 |
| `crm:logistics:signed` | `id: number` | `boolean` | S。签收（signed_at） |

### 1.9 团队与销售名（4 通道）

| 通道 | 请求参数 | 响应 | 幂等/备注 |
|---|---|---|---|
| `crm:currentSalesName` | — | 当前登录账户显示名 \| ''（wxid → 微信备注，取不到回退空） | R |
| `crm:sales:team` | — | `{ team: [{ name, orderCount, amount }], removed: string[] }` | R。历史认领非 wxid 人名 ∪ 当前账户；added/removed 名单持久化覆盖推断 |
| `crm:sales:team:add` | `name: string` | `{ ok, reason? }` | U。空名拒；重加 = 撤销离职 |
| `crm:sales:team:remove` | `name: string` | `{ ok, reason? }` | U |

### 1.10 群配置 / 解析 / 自动确认（6 通道）

| 通道 | 请求参数 | 响应 | 幂等/备注 |
|---|---|---|---|
| `crm:groups:list` | — | 群配置列表 | R |
| `crm:groups:save` | `g: object` | 保存结果 | U |
| `crm:groups:update` | `id: number, patch: object` | `boolean` | N |
| `crm:parse:scanNow` | — | 扫描结果 | U。processed_msg 幂等键；信号扫描游标 `priv:*` |
| `crm:autoConfirm:run` | — | enqueue 句柄 | U。批前快照 + 总开关；⚠️ 2026-08-24 起无前端入口（保留通道） |
| `crm:autoConfirm:history` | `limit?: number`（默认 50） | 自动确认历史 | R |
| `crm:autoConfirm:undo` | `entity: string, id: number` | 撤销结果 | S。仅自动处理条目可撤 |

### 1.11 产品 / 文件 / AI 杂项（7 通道）

| 通道 | 请求参数 | 响应 | 幂等/备注 |
|---|---|---|---|
| `crm:product:import` | `rows: Array<Record<string, unknown>>` | `{ imported: number }` | N |
| `crm:product:aiDesc` | `payload: object` | 产品描述文本 | N（LLM） |
| `crm:product:aiExtract` | `template: string[], dataUrl: string` | 提取参数 JSON | N（LLM 视觉） |
| `crm:alias:learn` | `alias: string, accountId: number` | `boolean` | U。别名学习 |
| `crm:file:readImage` | `filePath: string` | data URL \| '' | R |
| `crm:file:saveImage` | `dataUrl, fileName: string` | 落盘路径 | N |
| `crm:quotation:ai` | （见 §1.6） | | |

### 1.12 sales 域（47 通道，注册于 main.ts）

> 通道数 = 本节各分组之和（41 + 本刀新增 6）；旧记「42」与分组相加不符，此处按可核对口径重算。

**知识库 kb（10）**

| 通道 | 请求参数 | 响应 | 幂等 |
|---|---|---|---|
| `sales:kb:list` | `filters?` | 条目列表 | R |
| `sales:kb:get` | `id: number` | 条目 \| null | R |
| `sales:kb:create` | `payload: object` | 新条目 | N |
| `sales:kb:update` | `id: number, payload: object` | 更新结果 | N |
| `sales:kb:delete` | `id: number` | 删除结果 | N |
| `sales:kb:search` | `payload: object` | 检索结果 | R |
| `sales:kb:importCsv` | `csvContent: string` | 导入计数 | U |
| `sales:kb:extractScripts` | `sessionId: string, opts?: { beginDate?, endDate? }` | 提炼结果 | N（LLM） |
| `sales:kb:extractScriptsAll` | `contacts?: Array<{ sessionId, nickname }>, opts?` | 批量提炼结果 | N（LLM） |
| `sales:kb:scanExtractCandidates` | `options?: { minMessages?, maxDaysAgo?, beginDate?, endDate? }` | 候选列表（纯本地） | R |

**报表/复盘（5）**

| 通道 | 请求参数 | 响应 | 幂等 |
|---|---|---|---|
| `sales:report:generate` | `payload: object` | 生成的报表 | N |
| `sales:report:list` | `limit?: number`（默认 20） | `{ success, reports }` | R |
| `sales:report:get` | `id: number` | `{ success, report \| error }` | R |
| `sales:report:delete` | `id: number` | `{ success }` | N |
| `sales:review:generate` | — | 周复盘 | N |

**客户画像（6）**

| 通道 | 请求参数 | 响应 | 幂等 |
|---|---|---|---|
| `sales:customer:get` | `sessionId: string` | `{ success, profile \| null }` | R |
| `sales:customer:currentView` | `sessionId: string` | `{ success, data }`（当前视图只读投影，不现场推理） | R |
| `sales:customer:upsert` | `data: object` | `{ success, profile }` | U。⚠️ stage 字段运行时剥离（P0-2A.5：stage 只由四写者写） |
| `sales:customer:list` | `filters?` | `{ success, customers }` | R |
| `sales:customer:export` | — | Excel 导出（弹保存框） | R |
| `sales:customer:detail` | `sessionId: string` | 画像详情（无则自动建档） | S |

**统计/漏斗（3）**

| 通道 | 请求参数 | 响应 | 幂等 |
|---|---|---|---|
| `sales:dashboard:stats` | — | `{ success, stats }` | R |
| `sales:actionFunnel:get` | `days?: number \| null`（null=全量） | `{ success, data }` | R |
| `sales:actionFunnel:breakdown` | `days?: number \| null` | `{ success, data }`（下钻） | R |

> `sales:funnel:stats` 已于 2026-09-13 随销售漏斗页退役**删除**（HANDOVER §2.101）；销售漏斗能力并入商机「阶段分析」视图，其只读数据源见下方 CRM 段 `crm:opportunity:analysis`。

**意向/证据/话术（5）**

| 通道 | 请求参数 | 响应 | 幂等 |
|---|---|---|---|
| `sales:intent:analyze` | `sessionId: string` | 意向分析结果 | N（LLM） |
| `sales:intent:correct` | `{ session_id, stage, reason? }` | 人工纠偏结果 | S。manual 写者：拒绝非枚举值 + dormant；写 last_stage_change_at |
| `sales:intent:history` | `sessionId: string, limit?: number`（默认 20） | `{ success, tags }` | R |
| `sales:evidence:getByKey` | `{ session_id, message_key, evidence_text? }` | 证据解析结果；找不到 `status:'unavailable'` 不伪造 | R |
| `sales:reply:suggest` | `{ session_id, context_messages? }` | 话术建议 | N（LLM） |

**待办（3）**

| 通道 | 请求参数 | 响应 | 幂等 |
|---|---|---|---|
| `sales:todo:list` | `filters?` | `{ success, tasks }` | R |
| `sales:todo:create` | `payload: object` | `{ success, task }` | N |
| `sales:todo:update` | `id: number, updates: object` | `{ success, task \| error }` | N |

> `sales:todo:scan` 已于 2026-09-12 删除：桥接、类型签名与主进程 handler 一并移除。它原样转调 `morningDigestService.regenerateToday()`，与 `sales:morningDigest:regenerate`（简报「重新生成」按钮）重复，且**全仓无调用方**（旧返回形状 `{newTasks, verifiedTasks}` 早已与实现不符）。

**画像批量（2）**

| 通道 | 请求参数 | 响应 | 幂等 |
|---|---|---|---|
| `sales:profile:batch` | `limit?: number`（默认 50）, `monthsBack?: number`（默认 6） | 批量进度/结果 | U |
| `sales:profile:progress` | — | 进度 | R |

**今日行动（6）**

| 通道 | 请求参数 | 响应 | 幂等 |
|---|---|---|---|
| `sales:action:getToday` | — | 今日行动列表 | R |
| `sales:action:complete` | `taskId: number, action: 'done' \| 'skipped'` | `{ success }` | S。before 状态检查 + follow_up_done 幂等写 |
| `sales:action:getUnified` | — | 统一信号流 | R |
| `sales:action:completeUnified` | `sessionId: string, action: 'done' \| 'skipped'` | `{ ok }` | S |
| `sales:action:recordEvent` | `{ sessionId?, eventType?, messageKey?, taskId? }` | `{ ok }` | U。白名单事件类型；follow_up_done 不经此通道（completeAction 自动触发） |
| `sales:action:suggest` | `item: object` | AI 三判断建议 | N（LLM；判断落 customer_judgment，source=manual） |

**AI 简报与按需识别（6）**

| 通道 | 请求参数 | 响应 | 幂等 |
|---|---|---|---|
| `sales:morningDigest:get` | — | `{ ok: true, data: MorningDigestPayload \| null, notReady?: true }` | R。**未就绪是可区分响应而非错误**：业务库尚未打开时返 `notReady: true` 且 `data: null`——调用方须展示加载态，**不得当作「没有简报」的空态**（六态纪律） |
| `sales:morningDigest:generate` | — | `{ ok: true }` | S。即发即返（不等待生成结果）；同日已有快照时服务层幂等返回、不重复调模型 |
| `sales:morningDigest:regenerate` | — | `{ ok: true, data: MorningDigest }` | S。显式覆盖同日快照（唯一会重写当天简报的入口） |
| `sales:identify:customer` | `params?: { sessionId: string, displayName?: string }` | `{ success: true, noNewContent?, newTasks? }` \| `{ success: false, error?, busy? }` | N。无新内容即 `noNewContent: true` 且**零模型调用**；全局单飞，被占用时返 `busy: true` + 明确提示，**无静默路径**。前端把 `error` 文案命中「额度/上限/预算」时渲染为提额入口（quota 态由文案判定，不是返回字段） |
| `sales:identify:state` | — | `{ busy, kind, label, startedAt }` | R。单飞状态，两个入口按钮共用同一把锁 |
| `sales:identify:activity` | （主进程 → 渲染广播） | 同上单飞状态 | R |

### 1.13 已下线通道（防复活清单）

- `crm:lead:scanGroup` / `crm:lead:reassign` — **决策 B 下线（宪法 §4.2，2026-09-02）**，preload/d.ts/服务整链路已删。
  后续归属调整统一走 §1.14 分配端点（assignment 状态流转 + 留痕），**禁止复活** tag 归属语义。

### 1.14 Phase 0/1 新增端点（规范级；实现 = Phase 1）

> 统一响应信封：`{ ok: true, data }` / `{ ok: false, code, message }`。
> 错误码：**E1xx 参数** / **E2xx 状态冲突** / **E3xx 数据不存在** / **E4xx 权限** / **E5xx 系统**。
> 写入纪律：归属/分配类动作同事务写 `assignment`（或 identity 改挂）+ `ownership_history` + `audit_event`。

| 通道 | 请求参数 | 响应 data | 错误码 | 幂等 |
|---|---|---|---|---|
| `crm:assignment:assign` | `{ leadIds: number[], salesName: string, mode?: 'weight' \| 'round_robin' \| 'load', actor: string }` | `{ assignments: Array<{ leadId, assignmentId }> }` | E101 参数缺失；E201 lead 已有有效分配；E301 lead 不存在 | U：同 lead 当前有效行存在则拒绝（lead↔assignment 1:N，当前分配=最新有效行） |
| `crm:assignment:claim` | `{ leadId: number, actor: string }` | `{ assignmentId }` | E201 非本人/非 assigned 态；E301 无分配行 | S：assigned → claimed；重复 claim 被状态机拒 |
| `crm:assignment:recycle` | `{ assignmentId: number, reason: string, actor: string }` | `{ assignmentId }` | E202 已回收 | S：SLA 回收器/人工回收 → status=recycled，lead 回资源池 |
| `crm:assignment:transfer` | `{ assignmentId: number, toSales: string, reason: string, actor: string }` | `{ assignmentId }` | E301；E203 目标销售不存在 | S：→ transferred + 新分配行；**离职移交批量走本端点循环，不复活旧 reassign** |
| `crm:assignment:list` | `{ leadId?: number, salesName?: string, status?, page?, pageSize? }` | `{ rows, total }` | — | R |
| `crm:identity:bind` | `{ leadId?: number, identityId?: number, wxid: string, actor: string }` | `{ identityId, customerId? }` | E101 wxid 空；E301 目标不存在；E204 wxid 已挂他 customer | S：手动绑定写 `source='manual', confidence=1.0`（宪法 §1.2/§2.4），全程审计；命中冲突 → 返回合并提案所需信息，**不自动改挂** |
| `crm:customer:mergeProposal` | `{ identityType: 'phone' \| 'wxid', identityValue: string, fromCustomerId, toCustomerId, actor: string }` | `{ proposalId }` | E204 无冲突；E301 | U：合并提案 B/C 档（AI 或人工提案）→ **审批后执行**（改挂 + ownership_history + audit_event 同事务；AI 永不执行合并） |
| `crm:audit:query` | `{ entityType?: string, entityId?: number, actor?: string, action?: string, beginAt?, endAt?, page?, pageSize? }` | `{ rows, total, labels }` | — | R。audit_event 只读；activity_log / auto_confirm_log 封存只读同口径（宪法 §1.12）。`labels` = 行内实体显示名（key 为 `` `${entity_type}:${entity_id}` ``，仅 `lead`/`account`/`customer` 三类，供渲染层把 `lead #id` 换成人话名；解析不到则该 key 缺席，由渲染层回落原名，**不留空白**）。纯展示层附加字段，只读、无写入路径 |
| `crm:ownership:history` | `{ entityType: string, entityId: number, page?, pageSize? }` | `{ rows, total }` | — | R。ownership_history 只读 |

> 已有端点不重复建：归属回写 `owner_sales` 由专用 `crmOwnershipService` 走直连 SQL（account/opportunity/logistics
> 三处同口径，宪法术语表），不经 `crm:entity:update`——后者对 opportunity 已限为 `shipped_qty`/`delivery_date`；
> 报价版本链 Phase 1 落地时增补 `crm:quote:createVersion`（版本行
> append-only：旧行置 effective_to，新行 version+1，同事务双写 contract.quote_version_id）。

### 1.15 交付售后（crm:delivery:*，8 通道；专用后端 = crmDeliveryService）

> 统一响应信封同 §1.14。交付售后六区（交付登记/数量差异任务/设备档案/改装质保/以旧换新/复购等级）
> 全部落在后端事实（opportunity/customer/audit_event + follow_up_task + proposal_event），页面只读后端事实与任务，
> **禁止前端本地计算提醒/任务**，也**不再经 `crm:entity:update` 散写 shipped_qty/delivery_date**（后者对 opportunity 的
> 白名单保留为只读兼容，写入单点 = 本组端点）。

| 通道 | 请求参数 | 响应 data | 错误码 | 幂等 |
|---|---|---|---|---|
| `crm:delivery:register` | `oppId: number, payload: { shipped_qty?, delivery_date?, over_ship_reason?, actor? }` | `{ oppId, shipped_qty, delivery_date, diffTaskCreated, diffTaskClosed }` | E101 oppId 空；E301 商机不存在/非 won；E102 实发量非负整数；E103 超发缺原因；E104 日期非法 | S：仅成交单可登记；同事务写 opportunity + audit_event（记新旧值+操作者+来源） |
| `crm:delivery:saveEquipment` | `customerId: number, fields: object` | `{ customerId, changedFields: string[] }` | E101 customerId 空；E301 客户不存在；E102 车龄/期限非负整数；E104 日期非法 | U：仅变更字段写（未变更零写入）+ audit_event（customer_equipment_set） |
| `crm:delivery:proposeTradeIn` | `customerId: number, basis: { kind, evidenceKey, reason, at? }` | `{ taskId }` | E101 缺 evidenceKey/reason；E301 客户不存在 | U：同客户只留一张 pending；`code='DUP'` 幂等返回 |
| `crm:delivery:decideTradeIn` | `customerId: number, decision: 'accept' \| 'reject'` | `{ taskId? }` | E101 裁决非法 | S：写 proposal_event(accepted/rejected) + audit_event + 关闭提案卡；**不改客户事实** |
| `crm:delivery:scan` | — | `{ diffCreated, diffClosed, warrantyNear, warrantyExpired, tradeIn }` | — | U：幂等同步四类 follow_up_task（pending 去重） |
| `crm:delivery:tasks` | — | `{ diff, warrantyNear, warrantyExpired, tradeIn }`（各为 FollowUpTask[]） | — | R：页面提醒唯一来源（读后端事实，非前端推导） |
| `crm:delivery:suggestDate` | `oppId: number` | `{ date, source } \| null` | — | R：签收日期建议（只读 Suggestion；真实写入必须经 register 人工确认） |
| `crm:delivery:recomputeRepeat` | — | `number`（等级变化客户数） | — | U：全量重算复购等级，等级变化写 audit_event（customer_repeat_level_change） |

---

## 2. 本机 HTTP 只读层（端点级；详情 = docs/HTTP-API.md）

- **启停**：IPC `http:start(port?, host?)` / `http:stop()` / `http:status()`（main.ts）。
- **鉴权**：`Authorization` Token Header（HTTP-API.md §鉴权规范）。
- **性质**：聊天数据只读 + SSE 主动推送；**不承载 CRM 写操作**（写操作只在 IPC 层）。

| 端点 | 方法 | 说明 |
|---|---|---|
| `/health`、`/api/v1/health` | GET/POST | 健康检查 |
| `/api/v1/push/messages` | GET | SSE 主动推送（新消息） |
| `/api/v1/messages` | GET/POST | 获取消息（分页/过滤） |
| `/api/v1/sessions` | GET/POST | 会话列表（`?format=chatlab` 出 ChatLab 格式） |
| `/api/v1/sessions/:id/messages` | GET | ChatLab Pull（拉取会话消息 + sync 块） |
| `/api/v1/contacts` | GET/POST | 联系人列表 |
| `/api/v1/group-members` | GET/POST | 群成员列表 |
| `/api/v1/sns/timeline` | GET | 朋友圈时间线 |
| `/api/v1/sns/usernames` | GET | 朋友圈发布者 |
| `/api/v1/sns/export/stats` | GET | 导出统计 |
| `/api/v1/sns/media/proxy` | GET | 媒体代理 |
| `/api/v1/sns/export` | POST | 导出朋友圈 |
| `/api/v1/sns/block-delete/install` / `uninstall` | POST | 防删开关 |
| `/api/v1/sns/posts/delete` | POST | 删除单条朋友圈 |
| `/api/v1/media/*` | GET | 访问导出媒体 |

**Phase 0/1 影响**：无新增、无变更（宪法对象全部走 IPC；HTTP 层不扩写权限）。

---

## 3. 中央主机内网 API（Phase 3a · 端点级已实现）

> 承载节点当前形态为独立主机（PRD §13.1）；未来升级 NAS 时本节契约不变，只换部署形态。
> 实现位置：`central/src/app.ts`（路由）、`central/src/permissions.ts`（角色矩阵）、
> `central/src/projections.ts`（显式投影注册表）、`shared/centralSync.ts`（事件信封、禁字段、引用命名空间）、
> `shared/centralDownCommand.ts`（**下行指令业务校验唯一真源**）。
> 自动化验证：`central/test/app-test.ts`（102 项）、`central/test/projection-test.ts`（36 项）、
> `central/test/migration-test.ts`（23 项）、`central/test/context-test.ts`（6 项）；
> 端到端契约闭环另有 `scripts/central-sync-e2e-test.ts`（44 项，无 Docker 依赖）。

### 3.1 通用约定

- **认证**：`Authorization: Bearer <token>`。两种主体——
  - **bootstrap-admin**：`CENTRAL_ADMIN_TOKEN` 环境变量注入的引导令牌，仅用于首次签发邀请码与管理设备；
    `workspaceId` 为空，跨工作区操作必须显式带 `workspaceId`（否则 400 E101）。
  - **设备凭证**：认领邀请码后下发的一次性明文令牌，服务端**只存 sha256 哈希**
    （`central/src/crypto.ts`）；轮换后旧令牌立即失效。凭证存本机 `safeStorage`，不落明文。
- **免认证端点**：`GET /health`、`GET /ready`、`POST /api/v1/bindings/claim`（认领凭邀请码本身鉴权）。
  其余 `/api/v1/*` 一律 401 E401。
- **版本策略**：URL 路径版本 `/api/v1/*` 起步；不兼容变更升 v2 并保留 v1 只读窗口 ≥1 个 Phase。
- **幂等约定**：`POST /api/v1/sync/push` 必带 `Idempotency-Key`（缺则 400 E101）；服务端按
  `(workspace_id, idempotency_key)` 去重，重放返回 `duplicate: true` 且不新建业务记录。
  下行指令按 `eventId` / `idempotencyKey` 去重；`ack` 对不存在的 `centralSeq` 静默跳过（返回 0）。
- **错误码结构**：`{ ok: false, code, message, requestId }`。已使用：
  `E101` 参数/请求不合法 · `E102` 下行事件不合法（含 `eventType`/`entityType` 不匹配）·
  `E103` 下行命令载荷不合法（必填缺失 / 枚举越界 / 长度超限）·
  `E400` 请求无法处理（请求侧 4xx，如缺 `content-type` 的 415 **按原状态码回，不记成中央服务内部错误**）·
  `E401` 未认证/凭证失效 · `E403` 角色无权或越工作区 · `E409` 邀请码无效/已用/过期 **或 `idempotency_key_conflict`** ·
  `E500` 内部错误 · `E503` 数据库未就绪。
- **日志红线**：Fastify logger 的 `redact` 已排除 `authorization` 与 `idempotency-key` 请求头；
  错误处理只记 `message/stack/code`，不整体打印 pg 异常（其 `parameters` 可能含业务值）。
- **上行字段脱敏（PIPL / PRD §10-R4）**：`shared/centralSync.ts#findForbiddenCentralField` 递归扫描载荷，
  命中 `chat*` / `message*` / `conversation` / `session_id` / `wcdb_path`、以及原始身份字段
  （`wxid` / `contactRaw` / `contactNormalized` / `phone` / `identityValue` …）即整条事件拒收
  （`code: forbidden_field`）并写中央审计 `sync_forbidden_field`（**只记字段路径与稳定错误码，不记值**）。
  客户身份值只上行 sha256 哈希 + 展示掩码（`identity_hash` / `identity_masked`），哈希**复用既有身份归一规则**。
  字段名谓词由本模块导出（`isForbiddenChatFieldName` / `isForbiddenIdentityFieldName`），
  客户端审计擦洗与中央校验**共用同一份清单**，并保证不误伤 `evidenceKey` / `messageKey` 锚点。
- **逐事件最小字段白名单**：每个上行 `eventType` 只投递声明过的最小字段集，**不允许整包投递 outbox 原始载荷**。
- **引用命名空间**：`entityId` 与一切本机投影引用由 `shared/centralSync.ts#scopedRef(deviceId, localRef)` 统一生成；
  服务端按 `isRefOwnedByDevice` 校验**上行 `entityId` 必须属 `principal.deviceId` 命名空间**，
  否则拒收 `entity_id_not_owned`。**既有投影只允许原 `source_device_id` 更新**（跨设备改写显式冲突，
  更高 `aggregateVersion` 也不能覆盖）。

### 3.2 角色 → 能力矩阵（`central/src/permissions.ts` 表驱动）

| 能力 | sales | supervisor | allocator | admin | service |
|---|---|---|---|---|---|
| `sync.push` 上行推送 | ✅ | ✅ | ✅ | ✅ | ❌ |
| `sync.pull` 下行拉取 | ✅ | ✅ | ✅ | ✅ | ✅（只读） |
| `sync.ack` 回执 | ✅ | ✅ | ✅ | ✅ | ❌ |
| `command.issue` 下发指令 | ❌ | ✅ | ✅ | ✅ | ❌ |
| `invite.create` 签发邀请码 | ❌ | ❌ | ❌ | ✅ | ❌ |
| `device.rotate` 轮换本机令牌 | ✅ | ✅ | ✅ | ✅ | ❌ |
| `device.revokeSelf` 自助解绑 | ✅ | ✅ | ✅ | ✅ | ❌ |
| `device.revoke` 吊销工作区设备 | ❌ | ❌ | ❌ | ✅ | ❌ |

> 权限唯一依据是服务端 `employee.role` + 设备绑定。本机自报角色（`permission` 投影的
> `declaredRole`）**仅作署名与展示**，永不参与鉴权。无权限返回 403 E403。
>
> **角色 × 上行实体类别**（2026-09-15 增补）：`sales` 只能上传销售设备可合法产出的投影类别
> （`customer` / `customer_identity` / `assignment` / `opportunity` / `quote` / `audit_event` /
> `customer_judgment` / `knowledge_proposal`）；分配侧类别（如 `ownership`）对销售拒收
> （`role_not_allowed_entity:<类型>`）。**销售本机自报为「主管」也不会获得任何服务端能力。**
>
> **bootstrap-admin 例外**：引导令牌 `workspaceId` 为空，**不得调用常规 push / pull / ack**
> （400 E101）——空 workspaceId 不能成为绕过工作区隔离的入口；签发邀请码与吊销设备必须显式带 `workspaceId`。

### 3.3 端点清单

| # | 方法 | 路径 | 认证 | 能力 | 说明 |
|---|---|---|---|---|---|
| 1 | GET | `/health` | 免 | — | 存活探针：`{service, protocolVersion}` |
| 2 | GET | `/ready` | 免 | — | 就绪探针：`store.ping()` 失败返 503 E503 |
| 3 | POST | `/api/v1/bindings/invitations` | Bearer | `invite.create` | 签发一次性绑定邀请码（默认 30 分钟有效） |
| 4 | POST | `/api/v1/bindings/claim` | 免（凭邀请码） | — | 设备认领，返回设备凭证 + principal |
| 5 | POST | `/api/v1/devices/rotate` | Bearer | `device.rotate` | 轮换本设备令牌（旧令牌立即失效） |
| 6 | POST | `/api/v1/devices/revoke-self` | Bearer | `device.revokeSelf` | 自助解绑（客户端先调此接口再清本地） |
| 7 | POST | `/api/v1/devices/:deviceId/revoke` | Bearer | `device.revoke` | 管理员吊销指定设备 |
| 8 | POST | `/api/v1/sync/push` | Bearer | `sync.push` | 上行事件批推（≤100 条/批） |
| 9 | GET | `/api/v1/sync/pull` | Bearer | `sync.pull` | 按游标拉取本设备下行事件 |
| 10 | POST | `/api/v1/sync/ack` | Bearer | `sync.ack` | 下行事件回执（applied/conflict/invalid/retry） |
| 11 | POST | `/api/v1/sync/commands` | Bearer | `command.issue` | 下发中央指令（归属/移交/回收/主管修正/权限变更） |

#### 3 邀请码签发

请求：`{ workspaceId, employeeCode, displayName, role, expiresInMinutes? }`（`role` ∈ 五角色枚举，
`expiresInMinutes` 5–1440，默认 30）。响应 201：`{ ...record, inviteCode, expiresAt }`。
**`inviteCode` 只在这一次响应体里出现**，服务端只存哈希；非 bootstrap-admin 只能签发本工作区
邀请码，跨工作区 403 E403。字段级 schema 见 `central/src/app.ts`。

#### 4 设备认领

请求：`{ inviteCode, deviceName }`。响应 201：`{ deviceToken, principal }`。
邀请码**一次性**：已用、过期、不存在一律 409 E409（不区分原因，避免探测）。
`deviceToken` 明文只在此响应出现一次，服务端只存 `secretHash(deviceToken)`。

#### 5–7 令牌轮换 / 自助解绑 / 管理员吊销

- `rotate`：无 body；响应 `{ deviceToken }`；旧令牌在轮换提交后立即 401。
- `revoke-self`：无 body；响应 `{ revoked, deviceId }`；只作用于调用者自身设备。
  客户端约定：**先调本接口，成功后才清本地凭证**；网络失败时保持凭证与绑定，如实报「解绑未完成」。
- `revoke`：body `{ workspaceId? }`（bootstrap-admin 必须显式指定，否则 400 E101）；
  路径上的 `deviceId` 与 body 里的 `workspaceId` 都必须是合法 UUID，**非法格式返 400 E101 且绝不访问数据库**
  （不得让 PostgreSQL 的 `22P02` 冒成 500）；合法但不存在/跨工作区的设备返 `revoked: false`（可重入）；
  响应 `{ revoked: boolean }`；跨工作区一律 `revoked: false`（不泄漏他区设备是否存在）。
  自助解绑与管理员吊销都写中央审计（`device_revoke_self` / `device_revoke`）。

#### 8 上行推送

请求头：`Idempotency-Key`（**必填**）。请求体：`{ events: CentralSyncEvent[] }`，1–100 条。
逐条判定，**不做整批拒绝**：单条失败只进 `rejected`，同批有效事件照常落库并返回
`accepted: [{ eventId, centralSeq, duplicate }]`。拒收原因码：`wrong_direction`（非 up）、
协议校验错误码、`entity_id_not_owned`（**上行 entityId 不属于本设备命名空间**）、
`role_not_allowed_entity:<类型>`、`entity_id_kind_mismatch:<类型>≠<类型>`（**引用类别与 entityType 语义不符**）、
`forbidden_field`、`unknown_field:<字段>`（**严格白名单，多字段即拒**）、
`missing_required:<字段>`、`unregistered_entity_type:<类型>`。
命中禁字段额外写中央审计 `sync_forbidden_field`（只记字段路径）。
**单条事件的判定顺序**：方向 → 协议校验 → 设备命名空间（`isRefOwnedByDevice`）→ 角色 → 实体引用类别
（`entity_id_kind_mismatch`）→ **载荷引用字段闸门** → 禁字段 → 记录违规。

**载荷引用字段闸门（2026-09-15 增补）**：`payload` 里登记过的 `*Ref` 字段（`customerRef` / `leadRef` /
`opportunityRef` / `employeeRef`）在服务端按语义校验，错误码只带字段名、不带值：

| 码 | 含义 |
|---|---|
| `ref_invalid_type:<字段>` | 引用不是字符串 |
| `ref_not_scoped:<字段>` | 不是 `<deviceId>/<localRef>` 形态（裸引用无法跨表关联） |
| `ref_not_concrete:<字段>` | 缺具体行号（`<deviceId>/customer:`） |
| `ref_kind_mismatch:<字段>` | 引用类别与字段语义不符（如 `customerRef` 指向 `lead:`） |
| `ref_not_owned:<字段>` | 引用借用他机命名空间（**同工作区内也不行**） |

`employeeRef` 是**身份声明**（显示名/工号）而非本机行号，裸值照常放行；仅当它写成 `<a>/<b>` 形态时才按
scoped 规则校验。被拒事件不留 `sync_event`、不留投影、**不消耗幂等键**。
**投影归属闸门**：`(workspace_id, entity_id)` 已存在时只允许**原 `source_device_id`** 更新，
跨设备一律 `conflict`（更高 `aggregateVersion` 亦不覆盖）；`customer_identity` 唯一身份冲突落冲突记录。

#### 9 下行拉取

查询参数：`cursor`（默认 0）、`limit`（1–200，默认 100）。响应
`{ events: CentralSyncEvent[], nextCursor }`。只返回 `direction=down` 且**指向本设备或本员工**
的事件；`retry` 状态事件可被重拉，`applied`/`conflict`/`invalid` 终态不再返回。

#### 10 回执

请求体：`{ acknowledgements: [{ centralSeq, eventId, outcome, localVersion?, detail? }] }`（1–200 条）；
`outcome` ∈ `applied | conflict | invalid | retry`。响应 `{ acknowledged: n }`。
`retry` 累计重试次数 +1 且事件保持可重拉；`centralSeq` 不存在或工作区不符时静默跳过（幂等）。
客户端约定：同一事件连续 `retry` 达 `MAX_DOWN_ATTEMPTS`（5）后必须改判 `invalid` 并前移游标，
**不得无限 retry**。

#### 11 下发指令

请求体：单个 `CentralSyncEvent`（`direction` 由服务端强制为 `down`；`payload` 过同一套禁字段扫描）。
必须指定 `targetEmployeeId` 或 `targetDeviceId`（否则 400 E101）；目标不在本工作区 403 E403。
响应 201：落库后的下行事件（含 `centralSeq`）。

**命令体校验（2026-09-15 增补，见 §3.6）**：`eventType` 必须与 `entityType` 匹配（否则 400 E102），
必填载荷缺失、枚举越界、长度超限一律 400 E103；员工与设备双指定时必须**同属一名员工**；
畸形目标标识返 **400**（不得落成数据库 500）；同一 `idempotency_key` 重复下发返 409
`idempotency_key_conflict`。校验不通过的请求**不写**任何业务行与幂等标记。

**线索子对象白名单**：`lead` 只在 `assign` / `transfer` 上被接受，按传输上下文取字段集——
中央 HTTP 只接受 6 个字段（`contactRaw` / `wechat` 一律 400 `unknown_lead_field:<字段>`），
不带 `lead` 的指令类型携带它即整事件拒收；校验失败同样**不写**任何业务行与审计。

**中央操作审计**：中央自身的运维动作写 `central_audit_event`（与本机 `audit_event` 的只读上行投影
`central_audit_projection` 严格分离，互不写入）。当前在册动作：`invite_create`（邀请码签发，与签发
**同一事务**，只记 `inviteId` / `employeeId` / `role`，**不记邀请码明文与哈希**）、`down_command`
（下行指令**首次**受理，只记 `eventId` / `eventType` / 投递目标，**不记载荷**）、`sync_forbidden_field`、
`device_revoke` / `device_revoke_self`、跨设备与身份锚点冲突记录。纪律：同幂等键重放（`duplicate`）
**不追加**审计，被拒请求**不留**审计——审计条数不随重放或探测增长。

### 3.4 显式投影表（禁止数据桶）

上行事件按 `entityType` 落到**明确的表 + 明确的列**（`central/src/projections.ts` 注册表，
DDL 见 `central/migrations/002_central_projections.sql`）。缺注册项直接拒收，不落任何自由 JSONB 桶：

| entityType | 中央表 | 关键列（节选） | 必填字段 |
|---|---|---|---|
| `customer` | `central_customer` | `display_name` / `stage` / `owner_sales` / `deleted` | `displayName` |
| `customer_identity` | `central_customer_identity` | `identity_type` / `identity_hash` / `identity_masked` | `customerRef, identityType, identityHash` |
| `assignment` | `central_assignment` | `sales_name` / `status` / `mode` / `sla1_deadline` | `customerRef, salesName, status` |
| `ownership` | `central_ownership` | `owner_sales` / `reason` / `effective_from` | `customerRef, ownerSales` |
| `opportunity` | `central_opportunity` | `stage` / `amount_cny` / `order_qty` / `expected_ship_*` | `customerRef, stage` |
| `quote` | `central_quote` | `opportunity_ref` / `version_no` / `doc_hash` / `effective_to` | `opportunityRef, versionNo` |
| `audit_event` | `central_audit_projection` | `source_audit_id` / `actor` / `action` / `detail_masked` | `actor, action` |
| `customer_judgment` | `central_customer_judgment` | `judgment_type` / `value` / `evidence_key` | `customerRef, judgmentType, value` |
| `knowledge_proposal` | `central_knowledge_proposal` | `logical_id` / `title` / `authority` / `status` | `logicalId, title, status` |
| `permission` | `central_permission` | `declared_role` / `authority_source` | `employeeRef, declaredRole` |

- 全部 SQL 参数化（`projections.ts` 只产出 `$n` 占位符，值一律走参数数组）。
- **严格白名单**：`payload` 出现注册表未声明的字段即整条拒收（`unknown_field:<字段>`），
  **不静默裁剪**——宁可拒收，不留自由 JSONB 数据桶的口子。
- 版本闸门：`(workspace_id, entity_id)` 主键 upsert，仅当 `aggregate_version` 严格变大才覆盖；
  同时受**投影归属闸门**约束——既有行只允许原 `source_device_id` 更新（`source_device_id` 落库为投影列）。
- **增量水位（客户端侧）**：可变表按 **(updated_at, id)** 复合水位推进，append-only 表仍用 id；
  幂等键带本机修订号，同一实体新版本 → 幂等键变化、`entityId` 稳定、`aggregateVersion` 严格递增。
- `central_audit_projection` 是本机 `audit_event` 的**只读上行投影**；中央自身操作审计另存
  `central_audit_event`，两者不互相写入。
- 中央侧数据宪法对象登记见 `docs/DATA-CONSTITUTION.md`「中央投影对象」一节。

### 3.5 下行指令契约（`shared/centralDownCommand.ts`）

**唯一真源 = `shared/centralDownCommand.ts`**：SMB 与 HTTP 两条传输共用同一份纯校验器，
本机 `applyDownEventDirect` 不得绕过业务校验（禁止各写一套）。

| eventType | entityType | deliveryRole | 必填载荷（节选） | 目标 |
|---|---|---|---|---|
| `assign` | `assignment` | `apply` | `leadId` / `assignmentId` / `salesName` / **`lead`** | 目标员工或设备 |
| `transfer` | `assignment` | `apply` / `remove` | `leadId` / `assignmentId` / `toSales` / **`lead`** | 同上（**两个目标**，见下） |
| `recycle` | `assignment` | `apply` | `leadId` / `assignmentId` / `salesName`（**不含 `lead`**） | 同上 |
| `sla1_escalate_supervisor` | `assignment` | `notify` | `leadId` / `assignmentId` / `salesName` / `remindCount` / `recycledAt` | **主管**（按稳定工号解析） |
| `supervisor_correction` | `assignment` | `apply` | `leadId` / `assignmentId` / `title` / `summary` | 同上 |
| `permission_change` | `permission` | `apply` | `employeeRef` / `declaredRole` | 同上 |

- **只有 `assign` / `transfer` 携带 `lead` 子对象**（`allowsLead`）。回收与通知/声明类指令**不带**线索档案，
  携带即整事件拒收——`recycle` 的下行语义是「归属已回收」，接收端按 `assignmentId` 落既有状态机，
  不需要线索资料；「所有指令必带 6 字段」是旧口径，已作废。

- **指令载荷的线索面（已披露残留）**：`assign` / `transfer` 的 `lead` 子对象按**传输上下文**分档白名单——
  - 中央 HTTP（`central-http`）：只接受 6 个字段（`CENTRAL_LEAD_FIELDS`：`leadId` / `name` / `contactType` /
    `contactNormalized` / `source` / `note`）；`contactRaw` / `wechat` 一律 400（`unknown_lead_field:<字段>`），
    且不在中央留下任何 `sync_event` / 投影 / 审计；
  - SMB 内网文件通道（`smb`）：保留 Phase 1 历史口径的 8 字段（含 `contactRaw` / `wechat`），
    该通道是已互信局域网设备之间的文件投递，**不在中央收口范围内，未被收窄**。
  - 逐字段还有类型/长度/枚举约束（如 `contactType ∈ {phone, wechat, both}`、`name ≤ 120`），
    违反时返回 `invalid_lead_field:<字段>` / `too_long_lead_field:<字段>`；错误信息只带**字段名 + 稳定短码**，不带值。
  - 接收端 Phase 1 状态机按 `(contact_type, contact_normalized)` 定位或创建线索，故 `contactNormalized`
    **必然过网**——如实登记为已披露残留。**聊天正文两个方向都拦**；本契约**不声称「下行零身份值」**。
- **`transfer` 是双目标指令**：新归属设备收 `deliveryRole=apply`、原归属设备收 `deliveryRole=remove`，
  每条目标各自的幂等键带投递角色（`…#apply#<员工>` / `…#remove#<员工>`），互不顶替、可分别判重。
  本机 outbox 行**只在两个目标都被中央受理后才结算 `sent`**；任一目标 4xx 则整行 `failed`，
  网络类失败原样上抛、行保持 `pending` 等重放（已受理的目标靠幂等判重，不产生第二条指令）。
- **目标解析绝不按显示姓名猜人**：`sla1_escalate_supervisor` 的目标由本机配置项
  `centralSyncSupervisorCode`（**稳定工号**）解析；姓名重名或解析不到一律**显式报错并保持 pending**。
- **中央投递目标与落地**：`sla1_escalate_supervisor` 投递给主管员工/设备，
  本机落 `notify_inbox`（`notify_type` 为 SLA 升级类）；`supervisor_correction` 落 `notify_inbox`
  待人工确认，**不静默覆盖**本机事实行。

### 3.6 Phase 3a 尚未落地的部分

- **HTTPS / 反向代理 / 证书**：服务侧仅支持「由反向代理终结 TLS」（`CENTRAL_TLS_TERMINATED`，
  影响 `trustProxy`）；证书签发与续期属部署验收，不在代码内。
- **真实 PostgreSQL 端到端 / `docker build` / 双机演练 / Windows 打包 / 上行延迟实测**：均未执行。
- **冲突裁决**：当前为「服务端版本闸门 + **跨设备改写拒绝** + 唯一身份冲突记录 + 客户端 `conflict` 回执」，
  多写者合并策略留待 3a 演练后细化。
- **WeKnora / 中央 MCP**：属 Phase 3b，见 §4.2，仍为占位规范。
- **PRD 2.10 / 2.11**：≥100 条商机评测集与官方微信单向推送**均未完成**，与中央节点无关；Phase 4 为未启动 Backlog。

---

## 4. Hermes Tool Gateway 与中央 MCP

### 4.1 本机 Hermes Tool Gateway（Phase 2 已实现）

本机工具运行在 Electron/Utility 信任边界内，注册唯一真源为 `electron/services/hermesToolRegistry.ts`。当前全部为只读工具，执行前经过白名单、宿主上下文与 owner 过滤；不存在/不可见使用相同结果，避免泄露他人客户是否存在。工具名沿用内部 `domain.action` 形式，不等同于未来中央 MCP 的公开命名。

| 工具名 | 输入 | 输出摘要 | 权限/数据边界 |
|---|---|---|---|
| `customer.search` | `query`，可选 `limit` 1～10 | 客户 id、名称、阶段、公司 | 先取完整候选，再按 owner 过滤后截断 |
| `customer.by_session` | 无；会话由宿主上下文提供 | 当前会话对应客户 | 不接受模型提供 sessionId；非聊天上下文拒绝 |
| `customer.current_view` | `accountId` | canonical stage + 四类当前判断 | 复用 `getCustomerCurrentView()`，不展开证据正文 |
| `chat.recent` | `accountId`，可选 `limit` 1～20 | 脱敏消息、方向、时间、messageKey | owner 校验后读取；手机号/wxid/身份证脱敏并截断 |
| `crm.customer_business` | `accountId` | 客户商机与合同 | 先校验客户归属，再组合既有只读口 |
| `opportunity.my_list` | 可选 `limit` 1～30 | 当前可见活跃商机 | owner 过滤，按沉默时长排序 |
| `payment.month_paid` | 无 | 本月确认到款金额、笔数、分组 | 销售只看本人；管理视角可看分组 |
| `action.pending` | 可选 `limit` 1～20 | 待办行动卡 | 全量候选先按 owner 过滤再截断 |
| `knowledge.search` | `query` | 已发布知识的标题、版本、摘句与引用 | 只经 `kbValidEntries`，排除 staging/过期/历史版本 |

统一内部返回为 `{ ok, data?, publicSummary, evidence?, errorCode? }`；白名单外工具 fail closed。当前没有写工具，AI 无 publish、归属变更或对外发送能力。

### 4.2 中央 MCP（Phase 3b 占位规范）

- **工具命名**：`weflow_<对象>_<动作>`，snake_case（MCP 惯例），对象名对齐宪法术语表
  （assignment / customer / quote / …）。
- **输入输出**：JSON Schema 必填声明；输出复用统一信封 `{ ok, data }` / `{ ok:false, code, message }`。
- **权限边界**：只读工具直接放行；写工具一律映射 AI 三档（宪法：A=auto / B=proposed→confirm /
  C=request→审批），**AI 无 publish 权限**——合并/归属变更/发布永不自动执行。
- **审计**：每个工具调用写 `audit_event`（actor 含工具名标识，宪法 §1.12）。
- **证据**：AI 产出带 evidence_key 才可进 B/A 档（宪法 §1.10）。

**Phase 3b 中央 MCP 端点占位清单**：

| 工具名 | 输入 | 输出 |
|---|---|---|
|  |  |  |

---

## 5. 变更纪律

- 本文档与代码同步：新增/下线 IPC 通道须同步本篇（收尾检查项，DEVELOPMENT.md）。
- 端点级契约变更（参数/响应/错误码破坏性变化）→ 先答 Feature Gate 七问（宪法 §2.3）。
- 中央主机内网 API（§3）改端点时须同步 `central/test/app-test.ts` 与客户端 `scripts/central-sync-client-test.ts`；
  中央 MCP（§4.2）在 Phase 3b 开工前不得猜写端点细节；本机 Hermes Tool Gateway 已按实际代码登记在 §4.1。
