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
| `crm:customer:delete` | `id: number` | `{ ok, removed? }` | N。**单事务完整级联**（合同链复用既有合同删除语义 + 商机（事件先于商机删）/crm_risk/payment_promise/quote_signal/contact/shipping_info/alias_map/账户级 logistics/账户级 allocation），`payment_record` 原始到款事实按宪法 §3 保留，customer/customer_identity/lead（独立事实源）不误删（lead 仅解除 account_id 挂接）；任一步失败整体回滚；删前备份 `crm-backups/`；`removed` = 级联删除行数（子资源及其 activity_log 行，**不含 account 行自身**） |
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
| `crm:lead:dupCheck` | `{ phone?, wechat? }` | `{ duplicate, detail }`（kind=lead/customer/conflict + 当前归属 + assignment 历史 1:N） | R。输入即查只读无审计；口径同 importLeads 库内查重（2026-09-19） |
| `crm:lead:create` | `{ source, phone?, wechat?, wxNickname?, qrPath?, note? }` | `{ ok, data.leadId }` / `{ ok:false, code:'E101'\|'E201', message, duplicate? }` | U。单条录入（宪法 §1.4 通道增补）：命中硬拒收 E201（三选一面板导航，全部不建新线索）；手机号必带 wx_nickname（2026-09-19 拍板）；入池 deadline=2100 哨兵 |
| `crm:lead:qrSave` | `fileName: string, srcPath: string` | `{ ok, path? }` | U。二维码复制进 userData/lead-qr/，存图不解析（宪法 §3 lead.qr_path） |
| `crm:lead:historyImport` | `fileName: string, rows: Array<{ contactType, contactValue, sales, assignedAt, endState?, source? }>` | `{ total, leadsCreated, leadsReused, assignmentsCreated, recycled, skipped[] }` | U。历史分配回填（宪法 §3 assignment 第 4 写者）：**sla1_deadline 强制 2100 哨兵**；幂等（已归属同销售/回收行已存在跳过） |
| `crm:dupGroup:list` | — | `{ groupCount, leadMatches, customerMatches }`（命中键 → `{ mask, others[] }`，others = 对方归属人姓名） | R。撞客一期：中央下行 `duplicate_group` 投影（下行投影白名单）落 `crmDb.dup_group` 后的徽标匹配；**只回对方归属人姓名，不回对方任何资料** |

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

### 1.7 到款认领（allocation / payment，7 通道）

| 通道 | 请求参数 | 响应 | 幂等/备注 |
|---|---|---|---|
| `crm:allocation:confirm` | `id: number, patch: object` | 认领确认结果 | S |
| `crm:allocation:reject` | `id: number` | `boolean` | S |
| `crm:payment:approve` | `id: number` | `boolean` | S |
| `crm:payment:claim` | `id: number, patch: object` | 认领结果 | S。认领销售默认 `crm:currentSalesName` |
| `crm:payments:byDay` | `days?: number` | 每日到款列表 | R |
| `crm:allocation:reconcile` | `id: number` | `{ ok, reason? }` | S。财务显式核销；销售认领不会自动核销 |
| `crm:allocation:invoiceRequirement` | `id: number, requirement: 'unknown' \| 'required' \| 'not_required' \| 'info_pending'` | `{ ok, reason? }` | S。订单/认领级开票需求，人工选择优先于客户默认偏好 |

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
| `crm:file:readImage` | `filePath: string` | data URL \| '' | R。**只允许读 userData/crm-images 内的常规文件**；MIME 由 magic bytes 判定（JPEG/PNG/WebP，不信任扩展名）；拒绝（目录外/非常规文件/非图片内容/../、前缀碰撞、symlink 逃逸）一律返回 ''，不泄露目标是否存在 |
| `crm:file:saveImage` | `dataUrl, fileName: string` | 落盘路径 \| '' | N。文件名清洗后不得为空（空回退 img.jpg），最终目标严格位于 crm-images 内（同上路径闸门） |
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
| `crm:assignment:roundRobinNext` | — | `{ next: string }` | — | R（2026-09-20）。round_robin 跨批次公平游标只读查询：返回「下一位销售姓名」（空串 = 名单第一位）。最小只读信息，**无写路径**；游标持久化在主进程内部配置键 `crmRoundRobinCursor`（不进渲染层 config 白名单），批量分配成功后按批末真实指针推进（成功驱动的逐条状态机：失败/跳过不移动销售指针）。名单增删/重排/游标指向不存在成员时由 `shared/leadRoundRobin.roundRobinStartIndex` 安全重置到第一位，脏配置不致分配失败。前端预览与后端 `assignBatchLeads` 共用该起点与 `shared/leadRoundRobin` 同一纯函数：全部成功时屏 3 预览 = 实际执行逐条一致；出现失败/跳过时预览为「假设全部成功」的理想分布，实际 assigned/perSales/skipped 如实反映真实结果 |

**`crm:assignment:invalidated`（主进程 → 渲染层只读事件，非 invoke 端点；2026-09-20 增补）**：
SLA 定时回收、LAN/中央下行 assign/transfer/recycle、历史导入、纠正迁移等**非本窗口**来源改变
assignment 归属后，主进程广播给全部存活窗口；页面订阅后自行重拉所需数据。纪律：

- **只在写事务成功提交后通知**；失败/回滚不发。事件由主进程轻量总线
  （`assignmentInvalidationBus`，零 Electron 依赖）发往 IPC 注册层桥接 BrowserWindow；
- **最小载荷** `{ action: 'assign' \| 'claim' \| 'recycle' \| 'transfer'（合并多动作时按
  assign,claim,recycle,transfer 固定顺序逗号连接）, leadIds: number[]（去重升序）, at: number }`，
  **不含联系方式、聊天内容或任何客户敏感字段**；页面收到后重拉，不回传行内容；
- **固定窗口合并（有界延迟，2026-09-20 修订）**：总线**首个**事件启动 150ms 窗口；窗口内后续
  事件只合并 action/leadIds、**不重置计时**；窗口到期必然发出一条合并事件。持续写入（批量分配
  逐条、连续同步轮巡）下最大通知延迟 = 首个事件起 150ms，不会像尾随 debounce（每次 clearTimeout
  重计）那样被间隔小于窗口的连续事件无限推迟；preload `onAssignmentInvalidated` 返回清理函数，
  组件卸载必须调用；
- 页面自己发起的操作本就主动 fetchAll；页面收到主进程已合并的事件后再经固定窗口合并调度
  （300ms，`src/utils/coalescedScheduler.ts`，同语义：首事件启动窗口、窗口内合并不重置、到期
  必然刷新，最大额外延迟 300ms）吸收紧邻事件，不形成循环（fetchAll 为纯读，不产生新事件）。

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

### 1.16 配置白名单与秘密专用端点（2026-09-20 H2/H3 收口；注册于 main.ts）

> 通用 `config:get` / `config:set` 建立白名单边界（真源 = `electron/services/rendererConfigPolicy.ts`）：
> **秘密键**（`decryptKey` / `imageAesKey` / `imageXorKey` / `wxidConfigs` / `authPassword` / `authHelloSecret` /
> `httpApiToken` / `aiModelApiKey` / `aiInsightApiKey`（旧）/ `centralSyncDeviceToken` / `aiInsightWeiboCookie`）
> 在读写两个方向都**一律拒绝**——它们不进白名单，只经本节专用端点读写；**主进程托管状态键**
> （`centralSyncWorkspaceId/EmployeeId/DeviceId/Role/DisplayName/LastError/LastErrorAt`）可读不可写；
> 未知键读写都拒绝（读返回 undefined，写抛错）。秘密读取只回 `hasValue` / `maskedValue` 状态，
> **已保存的完整秘密永不回传渲染层**；设置页编辑语义 =「留空表示不修改 + 显式清除」，掩码串不落库。

| 通道 | 请求参数 | 响应 | 幂等/备注 |
|---|---|---|---|
| `secret:status` | — | `{ dbKey, imageXorKey, imageAesKey, httpApiToken, aiModelApiKey, weiboCookie }`（各 `{ hasValue, masked }`）+ `wxidConfigs: Record<wxid, { hasDecryptKey, hasImageXorKey, hasImageAesKey, updatedAt }>` | R。wxidConfigs 只以状态露出，**密钥面不出主进程** |
| `secret:setDbKey` | `value: string` | `{ hasValue, masked }` | U。`''` = 清除 |
| `secret:setImageKeys` | `{ xorKey?: number\|null, aesKey?: string\|null }` | `{ imageXorKey, imageAesKey }`（各 `{ hasValue, masked }`） | U。`undefined` = 不修改；`null/0/''` = 清除 |
| `secret:setHttpApiToken` | `value: string` | `{ hasValue, masked }` | U。`''` = 清除 |
| `secret:setAiModelApiKey` | `value: string` | `{ hasValue, masked }` | U。`''` = 清除 |
| `secret:setWxidConfig` | `wxid: string, patch: { decryptKey?, imageAesKey?, imageXorKey? }` | `{ hasDecryptKey, hasImageXorKey, hasImageAesKey, updatedAt }` | U。补丁语义：`undefined` = 不修改、`null/''` = 清除；主进程合并后整包加密落库 |
| `secret:removeWxidConfig` | `wxid: string` | `{ ok, removed, undoToken? }` | U。删除该 wxid 全部配置（精确 + 归一化匹配）；撤销快照只在主进程内存（30min TTL，上限 20） |
| `secret:undoRemoveWxidConfig` | `token: string` | `{ ok, restored }` | U。按 token 恢复主进程内存快照（密钥不经渲染层往返）；token 一次性 |
| `account:switchTo` | `wxid: string` | `{ ok, reason? }` | U。**账号切换在主进程执行**：读该 wxid 已保存密钥 → 写全局密钥位 → 切业务库（enqueueSalesTask 串行）→ 失效 Hermes 能力；无配置拒绝；密钥不经过渲染层 |
| `account:applySavedKey` | — | `{ hasDbPath, hasKey, myWxid, onboardingDone, appliedSavedKey }` | R。**自动连接前置判断**：wxidConfigs 中该账号的已保存密钥由主进程应用到全局密钥位，渲染层只拿非秘密状态 |
| `secret:setTelegramToken` | `value: string` | `{ hasValue, masked }` | U（2026-09-20 P1a）。`''` = 清除；原值经 safeStorage 加密，读取只走 `secret:status.telegramToken` |
| `secret:setWecomWebhook` | `value: string` | `{ hasValue, masked }` | U（P1a）。`''` = 清除；webhook 内含 key= 密钥，同上状态化读取 |
| `serviceaddr:setAiModelBaseUrl` | `url: string` | `{ changed, url, credentialsCleared, apiKey }` | U（P0）。仅 http/https；生产远端强制 HTTPS（localhost/127.0.0.1/::1 开发例外，与中央客户端规则一致）；**地址变化原子清除 aiModelApiKey + 旧 aiInsightApiKey**，要求重新录入 Key；地址不变零副作用 |
| `serviceaddr:setAiInsightBaseUrl` | `url: string` | `{ changed, url, credentialsCleared }` | U（P0）。地址变化原子清除 aiInsightApiKey |
| `serviceaddr:setCentralSyncBaseUrl` | `url: string` | `{ changed, url, credentialsCleared }` | U（P0）。**地址变化原子清除 centralSyncDeviceToken 与全部绑定身份状态**（workspace/employee/device/role/displayName/lastError/**centralSyncEnabled**），要求重新绑定；含「baseUrl 为空但绑定字段残留」的历史脏数据场景；旧设备令牌永不发往新 origin（`centralsync:claim` 携带新 baseUrl 时同样先清旧凭据） |
| `dbpath:setFromDialog` | `path: string` | `{ ok, path? }` / `{ ok:false, reason }` | U（P0）。路径必须在本会话经原生目录对话框批准（exportPathAuthorizer 会话授权），否则拒绝——dbPath 任意重定向口子关闭；`dbpath:autoDetect` 改为主进程检测成功后直接落库 |
| `export:chooseRoot` | — | `{ canceled, ok?, path? }` | U（2026-09-20 P1b）。主进程弹目录对话框 → 会话授权 + **持久化授权根**（主进程托管 config 键 `exportAuthorizedRoots`，渲染层白名单外）+ 更新 exportPath 偏好；`sns:selectExportDir` 同语义 |
| （边界声明） | — | — | 导出授权根恢复：重启后主进程从托管存储恢复并**重新验证**（存在 + 真实目录 + 非符号链接 + realpath 与批准时一致），失效根剔除并要求用户重新选择；**系统 Downloads 为内置授权根**（首次默认导出可用）；自动化导出只能落在持久授权根 / 内置根（或本会话新批准目录），未授权 outputDir 由 assertAllowed 在写入前明确拒绝；通用 config 里的 exportPath 仅是 UI 偏好展示，**不构成授权**。通用 `config:set` 对 `aiModelApiBaseUrl` / `aiInsightApiBaseUrl` / `centralSyncBaseUrl` / `dbPath` / `exportPath` 一律拒绝（rendererConfigPolicy.RESTRICTED_WRITE_CONFIG_KEYS） |

> 应用锁密码/Hello 走既有 `auth:*` 通道并新增 `auth:setPasswordHash`（64hex 校验 + authEnabled 同写）与
> `auth:setUseHello`；微博 Cookie 写入走既有 `social:saveWeiboCookie`（状态化读取经 `secret:status.weiboCookie`）。
>
> **导出 IPC 的用户批准路径闸门**（2026-09-20 H3 收口；真源 = `electron/services/exportPathAuthorizer.ts`）：
> `chat:exportMyFootprint`、`groupAnalytics:exportGroupMembers`、`groupAnalytics:exportGroupMemberMessages`、
> `export:exportSessions`、`export:exportContacts`、`sns:exportTimeline` 六个通道的输出目标必须是
> **本次应用会话中由 Electron 原生 open/save dialog 返回并登记**的路径（`dialog:openFile` /
> `dialog:openDirectory` / `dialog:saveFile` / `sns:selectExportDir` 在用户确认后登记；目录授权允许其内
> 创建导出文件，文件授权只允许对应文件本身）。校验在真正写入前的主进程入口执行：`../`、路径前缀碰撞、
> 已有符号链接、最近存在祖先 realpath 逃出授权真径一律抛错。授权保存在进程内存（24h TTL，上限 200，
> 重启即清空），不做全局永久白名单。HTTP API（独立鉴权信任面）不套用本闸门。

### 1.15 年度经营复盘（S3 · 2026-09-20；AI 分析接线 S7.2；实现 = electron/services/annualReviewService.ts + annualReviewWorker.ts + annualReviewAiCoordinator.ts）

> 确定性统计报告（规格 docs/设计-年度经营复盘-规格.md §7.2）；AI 诊断与下一年度行动计划
> （规格 §8，S7.1 纯模块/服务层 + S7.2 接线）。独立 `annualReview:*` 命名空间；
> 旧 `annualReport:*` / `dualReport:*` 通道保持原样、互不混用。preload 命名空间 `annualReview`。
> 通道命名与本域其余 `域:动作` 二段式略异（三段式对齐规格草案），以本节为准。

**报告结构**（`AnnualReviewReport`，完整类型见 `src/types/electron.d.ts`）：
`{ reportSchemaVersion, year, scopeKind: 'current_year'|'historical_year'|'all_time', periodStart,
periodEndExclusive, asOf, generatedAt, timezoneNote: 'local', dataRange, completeness, coverage,
warnings, summary(A1–A9), funnel(B1/B2/B3/B6/B7), customers(C1–C8), monthly, communication,
salesAssignment, sourceSummary }`。每区块的 value/state/warnings/coverage
原样来自统计层（主进程/Worker/UI 不做第二次口径计算）；`monthly`（V2 结构化三序列：
`contractSign` 签约金额——与 A4/A5 同一 sign_date 集合、`credited` 核销回款——与 A6 同一
计入时间、`messageVolume` 客户消息量——**复用 D5 单一结果**；月份轴 historical=完整 12 个月、
current=1 月至生成月、all_time=三序列数据月并集升序；轴内缺月为真实零 0；金额不做中间舍入；
unavailable（消息序列）不伪装空数组/0）为正式区块；`communication`（D 组：D1 消息量/D2 有沟通客户/D3 主动联系率/D5
月度趋势单序列/D7 长期未联系名单，S5 已实现）与 `salesAssignment`（E 组：E1 分项分配事实
+ sync 缺口检测/E3 有效跟进/E4 合同贡献/E5 核销贡献；E2/E6/E7 移出 V1，初始分配与移交
**分项展示不相加**；sync 缺口 → partial + exactCoverage=false + coverageRatio=null，禁止
覆盖率百分比）为真实区块。补全字段（规格 §7.2）：`dataRange = { from, to }` = **各指标实际采用事实时间的并集**
（唯一来源：A 组由 stats 的 selectSummaryAdoptedFactTimes 与指标同源选择；B/C 组由各纯统计
结果返回的 adoptedFactTimes——排除名单/总体/代表画像/事件合法性/首次事件规则均在统计层裁决；
unavailable 指标结果未产出，其事实不进入范围）。存量类无下界（A1 早于 periodStart 的建档仍参与）；
区间类 [periodStart, asOf)；重放类 < asOf；仅 current/all_time 参与的画像 last_contact 按
代表画像计。WCDB 消息聚合（A3 主口径/D1/D5）为 aggregate-only，无真实事件时间可采——不进入
dataRange、不伪造，其覆盖边界由 coverage 与文档声明。account.importedAt 仅参与导入布尔判定。
毫秒级合理值（≥2000-01-01），非法/秒/毫秒脏值不进入；空数据 → `{from:null,to:null}`；
validator 校验 from/to 同 null 或同为有限且 from ≤ to ≤ asOf。`completeness = { overall, blocks }`（四态聚合，优先级
确定性：unavailable > partial > snapshot_only > complete，由主进程聚合、UI 不计算；
未实现的 D/E/monthly 恒 unavailable，不得把 A/B/C 数字伪装为 complete）；`coverage` =
稳定 metricKey（35 键全集：`summary.*`×10 / `funnel.*`×5 / `customers.*`×8 /
`monthly.contractSign|credited|messageVolume` /
`communication.volume|contacted|outboundRate|monthlyTrend|longSilent` /
`salesAssignment.assignedFacts|effectiveFollowup|contractContribution|creditedContribution`）
→ `Coverage` 映射（键集合固定，缺一/多一/未知键被运行时校验拒绝；B/C 组原样复用统计层
coverage；A/D/E 组由组装层单一
映射 source/status/reasonCodes，reasonCodes 与统计结果 warnings 一致）；`warnings` =
全指标聚合数组 `{ code, message, metricKeys[], counts? }`（同 code 合并；metricKeys 与
counts 键稳定排序；**count 按指标拆分、不相加**；输出与输入顺序无关）；`sourceSummary`
= `[{ source, tables[], rows, note? }]`（真实输入事实行数与消息统计会话数，确定、无敏感
内容）。输出可结构化克隆；**不含 sessionId/session_id、wxid 原文**（C5–C8 客户条目映射为
`accountId` 优先、其次 `customer_profile.customer_id`，无法映射的行保留但身份字段为
null，计数口径不变）、不含数据库路径、SQL、Token、原始聊天内容、堆栈。

**时间契约**：`current_year` 区间 `[periodStart, generatedAt)`；`historical_year` asOf=periodEndExclusive、
区间 `[periodStart, periodEndExclusive)`；`all_time`（year=0）无下界、右开 generatedAt。UI/渲染层不自行推导年份边界。

| 通道 | 幂等 | 请求 → 响应 | 说明 |
|---|---|---|---|
| `annualReview:getAvailableYears` | R | `()` → `{ success, data?: { years: Array<{ year, coverage: { source, status:'complete', coverageFrom?, coverageTo?, rows, reasonCodes } }>, currentYear, supportsAllTime, defaultYear, generatedAt }, error?: { code, message } }` | 主进程全量扫描本地事实（account.created_at / contract.sign_date（sign_date 有效值）/ A6 核销计入时间 / intent_tag_log.created_at / opportunity.created_at，全部右开 generatedAt）推导年份；**自然年份升序排列，特殊项 year=0（历史以来）固定放在最后**；含 0=历史以来（有数据时）；2000 年前与未来年份的秒/毫秒混存脏值不生成候选；`coverage.rows` 仅陈述「该年度存在 N 条事实」，**不代表该年度各指标完整性**（完整性以 `getReport` 各区块 coverage 为准）。空库 → `years: []`、`supportsAllTime: false`。按 accountScopeId 隔离缓存（TTL 10 分钟）；加载期间发生失效（`invalidateAll`/`handleDataChanged`/账号切换）→ 旧结果不缓存不返回，收敛 `error.code='invalidated'`，新请求重新加载事实。 |
| `annualReview:generate` | N | `{ year: number }` → `{ success, taskId?, reused?, error?: { code, message } }` | year 只接受合法整数年份或 `0`（运行时校验，拒绝未来/小数/字符串/NaN）。**非阻塞启动**：立即返回 `taskId`（不等待完成）；同一 {accountScopeId, year} 已有运行中任务 → 合并（`reused: true`，不重复启动 Worker）；不同账号作用域独立运行。**完成与失败经 `annualReview:progress` 终态事件（done=true, phase=completed/failed）推送**，渲染层收到 completed 后再 getReport；取消用 `cancel({taskId})`。任务失败只体现在 progress 终态事件（error.code ∈ worker_error/worker_exit/invalid_worker_result/fact_load_failed/cancelled/invalidated/internal），不在本通道返回。启动参数非法 → `{ success: false, error: { code: invalid_year/future_year, message } }`。generate 强制重算并覆盖同键缓存。**schemaVersion V2**：monthly 升级为结构化区块后 `reportSchemaVersion=2`，缓存键随版本隔离，V1 报告不可命中。 |
| `annualReview:getReport` | R | `{ year: number }` → `{ success, cache: 'hit'\|'miss'\|'stale', report?, taskId?, error?: { code, message } }` | 只读当前账号作用域内存缓存；`hit` 携带 report（TTL 10 分钟内）与**产生该报告的 `taskId`**（报告身份，供 `annualReview:aiAnalysis` 使用）；`miss` 无缓存；`stale` 有缓存但已过期（**明确区分，绝不回退其他账号/其他作用域缓存**）。历史年度同样受 TTL 约束——迟到同步/补录/迁移/删除都可能改变结果。 |
| `annualReview:cancel` | N | `{ taskId: string }` → `{ success, error?: { code, message } }` | 终止运行中任务，**对 loading 与 computing 都有效**：loading 阶段取消后不再启动 Worker；computing 阶段真实 terminate Worker。任务收敛为 failed，`error.code='cancelled'`，done=true；被取消任务不写报告/年份缓存。已完成/已失败任务幂等成功（终态不可变，重复 cancel 不抛错、不产生冲突终态）；未知 taskId → `{ success: false, error: { code:'task_not_found', message } }`（终态快照被有界清理淘汰的旧 taskId 同样按未找到返回，见 `getTaskStatus` 保留策略）；非法载荷 → `invalid_task_id`。 |
| `annualReview:getTaskStatus` | R | `{ taskId: string }` → `{ success: true, found: true, task: { taskId, year, phase: 'loading'\|'computing'\|'completed'\|'failed', progress: 0–100, statusText?, done, error?: { code, message } } }` \| `{ success: true, found: false }` \| `{ success: false, error: { code, message } }` | **只读任务状态查询 = 任务状态的权威来源**（`getReport` 只是报告缓存，绝不用它代替任务状态）。按 taskId 在服务内部任务记录中查找（不按 year、不按缓存、不猜终态）；running（loading/computing）→ `done:false`，completed/failed → `done:true`（cancelled 仍是 failed + `error.code='cancelled'`，渲染层映射为 cancelled）；未找到 → `found:false`；非法/空/超长 taskId → `invalid_task_id`。**账号隔离 fail closed**：记录属于其他账号作用域时按 `found:false` 返回（不泄漏任务存在性）。返回快照副本（内部可变引用不外泄），不含报告正文/scopeId/wxid/数据库路径/Token/SQL/堆栈；查询不创建、取消、重启或修改任务。用途：渲染层在「generate 响应前终态事件因暂存容量被淘汰」时按 taskId 对账恢复真实终态。终态快照按 {accountScopeId, year} 保留（同键新任务覆盖旧任务），**全局**（跨账号作用域）非运行中快照最多保留 64 条——当前账号不豁免（否则同一账号连续生成 65 个以上年份即可突破上限）；超限时按 `updatedAt` 升序淘汰最旧快照（同值以 taskId 字典序稳定决胜），本次刚收敛的任务在本次清理中保留；运行中任务永不淘汰。被淘汰的旧 taskId 查询返回 `found:false`（`cancel` 亦返回 `task_not_found`），渲染层按可恢复错误处理。 |
| `annualReview:aiAnalysis` | N | `{ taskId: string, force?: boolean }` → `{ success: true, analysis: { executiveSummary, diagnoses[], actions[], risks[] }, model, promptVersion, generatedAt, cached: boolean }` \| `{ success: false, error: { code, message } }` | **年度经营复盘 AI 分析（S7.2）。载荷是严格对象，只允许 `{ taskId, force? }`**——多出任何字段（例如报告正文、prompt、模型参数）或非对象载荷一律 `invalid_request`；`force` 只接受 boolean（`'yes'`/`1`/`null`/`{}` 都不做 truthy 转换，直接拒绝）。渲染层不上传报告内容，因此伪造报告/改口径/注入文本都没有入口。主进程按 taskId 在**当前账号作用域**内定位「已完成、且报告仍有效」的结果（`AnnualReviewService.getTaskReport`：任务存在 → 属于当前作用域 → `completed` → 报告未过 TTL 且由该任务产出），再调 `generateAnnualReviewAiAnalysis`（S7.1 唯一模型出口；不复制第二套 prompt/校验/客户端，日调用上限闸门与用量账本自动生效，`purpose='annual_review_ai'`、`promptVersion='annual_review_ai_v1'`）。**`force` 语义**：默认 `false`（首次生成、失败重试、页面重新打开均允许命中结果缓存）；`true` 用于页面成功态「重新生成 AI 诊断」——跳过「结果缓存命中」这一步并**真实调用模型**，成功后覆盖同键缓存；失败时**保留旧缓存条目**。force 不绕过任何校验：报告定位/账号归属、同键 single-flight（在途 force 同样返回 `analysis_in_progress`）、日调用额度、输入与输出契约、取消与失效防护全部照旧。**失败码**（全部保留，逐字）：`invalid_report` / `unsupported_report_contract` / `not_configured` / `budget_blocked` / `call_failed`（含超时与取消，文案区分）/ `empty_output` / `invalid_json` / `invalid_shape` / `numeric_claim`；另有定位/并发/失效层稳定码：`invalid_task_id` / `invalid_request` / `task_not_found`（不存在、被有界清理淘汰，或属于其他账号作用域——按不存在返回，不泄漏存在性）/ `task_not_completed`（loading/computing/failed，含 cancelled/invalidated）/ `report_not_available`（报告过期或被新报告取代）/ `analysis_in_progress`（同一 {作用域, taskId, promptVersion} 已有分析在跑，不重复计费）/ `invalidated`（分析期间账号或业务库变更，结果作废）/ `internal`。失败文案全部是编译期常量（只做分类判断，不透传异常正文、模型原文、URL、路径、Token）。**取消是权威终态**：`annualReview:aiAnalysisCancel({ taskId })` 中止该 taskId 的在途调用（HTTP 层真实 abort），无在途调用 → `{ success: false, error: { code: 'analysis_not_found' } }`（调用方据此不把界面切到「已取消」）；请求来源窗口销毁 → 主进程自动中止在途调用。**不假设底层模型遵守 AbortSignal**：`await` 返回后与写缓存前重新复核——期间发生数据/账号失效优先返回 `invalidated`，用户取消或窗口销毁则一律按取消收敛（`call_failed` + 取消固定文案），**绝不返回成功、绝不写缓存**。**结果缓存**：仅主进程内存，键 = `accountScopeId + taskId + promptVersion`，TTL 与报告缓存一致（10 分钟）；不跨账号、不跨报告身份、不跨 promptVersion 复用；任何已接入的确定性数据写入（见下）都会与报告缓存**同时**失效。**不持久化**（未新建数据库表；prompt、模型原始输出、客户明细与密钥一律不入缓存）。**AI 失败不影响确定性报告**：该接口只读报告，不写报告缓存、不改任务状态、不触发重新统计。 |
| `annualReview:aiAnalysisCancel` | N | `{ taskId: string }` → `{ success: boolean, error?: { code, message } }` | 取消在途 AI 分析（与 `annualReview:aiAnalysis` 同一命名空间，载荷同样要求严格对象）。只中止该 taskId **正在运行**的调用；没有在途调用 → `{ success: false, error: { code: 'analysis_not_found' } }`；非法 taskId → `invalid_task_id`；非对象/多字段载荷 → `invalid_request`。**取消是权威终态**：被取消的调用即使底层模型忽略 AbortSignal 并正常返回，也不会返回成功、不会写 AI 结果缓存（`cacheSize` 不增加）；取消是否成功不影响确定性报告、任务状态与导出。 |
| `annualReview:progress`（广播） | — | 主进程 → 渲染层：`{ taskId, year, phase: 'loading'\|'computing'\|'completed'\|'failed', progress: 0–100, statusText?, done, error?: { code, message } }` | 单调不回退；completed/failed 为终态（done=true）且进度锁定；taskId 标记使旧任务迟到消息不覆盖新任务。preload `annualReview.onProgress(cb)` 返回清理函数（`removeListener` 只移除本次订阅的 wrapper——多订阅者独立清理，互不影响）。 |

**缓存与失效**：键 `{accountScopeId, year, reportSchemaVersion}`；`accountScopeId` = 主进程内部
**完整复合键**（`JSON.stringify([规范化 wxid, 实际 salesDb 库身份, 实际 crmDb 库身份])`，长度
自描述、字符转义无歧义，任意输入组合两两可区分——不使用短哈希折叠，无碰撞面）。实际业务库
身份 = `salesDbService.currentDbPath()` / `crmDbService.currentDbPath()`（当前真正打开的库文件，
未打开时回退按 wxid 推导的规范文件名）。该复合键仅作主进程内部 Map 键：**不写日志、不返回
渲染层、不进 Worker 载荷**；路径只参与内部键派生。仅主进程内存缓存，TTL 10 分钟，不持久化、
不写 config。**报告缓存条目同时记录产出它的 `taskId`（报告身份）**：`getReport` 命中时把它
一并返回，`annualReview:aiAnalysis` 据此复核「这份报告确实是该任务产出的」（同 year 被新任务
覆盖后旧 taskId 不再命中）。

**失效总线（annualReviewInvalidation，零 Electron 依赖的纯模块）**：确定性报告缓存与 AI 结果
缓存**订阅同一条失效事实**，主进程只有**一个**订阅点（`installAnnualReviewInvalidation`，见
`electron/main.ts`），不在每个 handler 里并列复制两行失效调用。

**失效范围 = 显式白名单（默认不影响年度复盘）**。只有年报复盘**真实读取**的数据源才触发失效；
其余写入（含高频后台写）不触发。白名单是唯一事实源（`ANNUAL_REVIEW_*_SOURCE_TABLES` /
`ANNUAL_REVIEW_AUDIT_ACTIONS`），声明方式为**类型化调用点声明**（`create/update` 的 entity 参数、
`runTx(fn, { affectsAnnualReview })` 选项、`announceAnnualReview*Write` 辅助函数），**不做 SQL
字符串匹配**：

| 数据源 | 触发方式 | 说明 |
|---|---|---|
| crmDb `account` / `contract` / `allocation` / `contract_status_history` / `assignment` / `lead` / `opportunity` / `opportunity_event` | `create()` / `update()` 按 entity 自动声明；原始 SQL 事务在调用点显式声明 `affectsAnnualReview` | A/C 组客户与合同指标、B1/B2 漏斗、B7 归因、E 组分配事实 |
| crmDb `audit_event` 仅 `lead_assign` / `lead_transfer` / `sync_apply` | `auditAppend()` / `create('audit_event')` 按 **action** 条件声明 | E1 分配事实与 sync 缺口检测 |
| salesDb `customer_profile` / `intent_tag_log` | `customerUpsert` / `setCustomerProfileCustomerId` / `updateStageChangeTime` / `intentCreate` 显式声明 | B1/B3 阶段分布与流转 |
| Assignment 归属变化（含 LAN/中央下行应用成功） | `assignmentInvalidationBus`（提交后 emit，`applied` 才发）经 `bridgeAssignmentInvalidationToAnnualReview` 汇入同一事实 | 比静态声明更精确：conflict/nolead/脏类型不发 |
| WCDB 切号 / 重连 | `wcdbService.open()` 返回 true 的**稳定成功点** | 只覆盖「连接建立成功」 |
| 手动排除名单 / 内部人员名单 | `main.ts` 的 `config:set` 写成功后**立即**上报（`config_exclusions`） | 无合并窗口 |
| 账号切换 / salesDb·crmDb reopen / 归档逃生舱 | 三处**立即**上报（`account_switch`） | 无合并窗口，同时终止运行中任务 |

**明确不触发失效的写入**（写入频繁但与年报复盘无关）：`scan_state`、`processed_msg`、
`migration_report`、`migration_dismissal`、`activity_log`、`auto_confirm_log`、无关 `audit_event`
action、`knowledge_base`、`report_snapshot`、`opportunity_eval_case`、`alert_eval_case`、
`follow_up_task`、`outbox_event`、`notify_inbox`、`dup_group`、`ownership_history`、
`customer` / `customer_identity`、`payment_record` / `payment_promise` / `logistics` / `invoice`、
`quotation` 版本链等。**通知时机**：只在写成功后（事务 COMMIT 返回后 / 单语句执行与 persist 均未
抛错 / 连接建立成功）；失败、ROLLBACK 与纯读路径一律不通知（读走 `all()/get()`，不经过声明点）。

**窗口语义 = leading-edge（首条立即）**：窗口空闲时的**第一条**相关事件**立即派发**——报告缓存与
AI 缓存马上失效、运行中的报告生成任务与在途 AI 分析马上进入失效/取消路径，**不存在「首次失效
还要等 150 ms」**，也不依赖测试专用 flush。其后 150 ms 内的重复事件被**抑制**（去重计数），窗口
结束时若确有被抑制的事件则**补一次**合并派发（每窗口至多一次，覆盖「窗口内又有写入、而期间缓存
可能已重建」的窄窗口，因此窗口内的第二批写入最多延迟一个窗口，≤150 ms）。窗口**从首条事件起算
固定长度、不随新事件顺延**，持续写入不会造成无限延迟。关键失效（账号切换 / 名单变化）走
`announceAnnualReviewDataChangedNow`，即使正处于窗口内也立即派发。派发只携带**原因与计数**（含
`coalesced` 标记），不含任何业务数据。

**仍未实时覆盖（如实列出，勿宣称已全覆盖）**：① 微信库（WCDB）在**连接保持期间**的增量新增/
变更消息不触发失效——消息类指标每次生成都实时读取，但已缓存的报告不会因此立即作废，仍由
10 分钟 TTL 兜底；② 数据库文件被外部进程直接改写（绕过本进程服务层）无法感知，同样只有 TTL
兜底；③ 归属/合同等领域的任何**未声明**的原始 SQL 事务不会触发失效（默认不影响），新增此类写入
时必须显式声明。**10 分钟 TTL 只是兜底**，不替代白名单内的明确成功点通知。

**在途任务**：报告生成任务与 AI 分析在开始时捕获失效纪元，任一 await 完成后、Worker 启动前、
缓存写入前复核——纪元或账号上下文已变化的旧任务收敛 `failed` + `error.code='invalidated'`，
在途 AI 调用收敛 `invalidated` 且**既不返回也不缓存**；失效后新请求重新加载事实。**不保证
实时一致**（合并窗口内仍可能读到旧结果，且上表未覆盖的领域只有 TTL 兜底）。

**Worker 边界**：Worker（`dist-electron/annualReviewWorker.js`，vite 独立 entry）只接收可序列化
`{ taskId, reportSchemaVersion, period, facts, sales, crm, messageStats, exclusions }`——不打开任何数据库、
不接触路径/密钥；内部只调用 S1/S2 已验收纯统计。Worker 返回结果在主进程经
`validateAnnualReviewReport` 运行时结构校验（schemaVersion/year/scopeKind/时间契约/区块形状/
unavailable↔null 一致/无 NaN/可 structuredClone+JSON 序列化），**非法结果不写缓存**、任务收敛
`failed`。Worker throw/exit/非法消息/超时进度消息一律收敛为
`failed`（error.code ∈ worker_error/worker_exit/invalid_worker_result/fact_load_failed/cancelled/invalidated/internal），
不留下永久 loading，错误不携带堆栈。

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
- **`entityId` 必须是具体引用（2026-09-15 增补）**：「有类别」不等于「指向具体一行」。服务端
  `validateCentralEntityId` 分三步拒收，判定全部复用 `shared/centralSync.ts#isConcreteRef`
  （**不新造第二个解析器**）：
  1. 必须含设备命名空间且 `localRef` 带 `kind:` —— 裸 `customer:1` 拒收 `entity_id_not_scoped`；
  2. 冒号后必须有**非空白**的本地行号 —— `device/customer:` 与 `device/customer:   ` 拒收
     `entity_id_not_concrete`（只有类别级别的引用无法跨表关联到任何一行）；
  3. `localRef` 的 kind 必须与 `entityType` 相符（`assignment` → `assignment:<id>`），
     不符拒收 `entity_id_kind_mismatch:<kind>≠<expected>`。

  既有合法 scoped 引用不受影响；`/sync/push` 仍**逐事件**处理，一条坏事件不会污染同批合法事件。

### 3.2 角色 → 能力矩阵（`central/src/permissions.ts` 表驱动）

| 能力 | sales | supervisor | allocator | admin | service |
|---|---|---|---|---|---|
| `sync.push` 上行推送 | ✅ | ✅ | ✅ | ✅ | ❌ |
| `sync.pull` 下行拉取 | ✅ | ✅ | ✅ | ✅ | ✅（只读） |
| `sync.ack` 回执 | ✅ | ✅ | ✅ | ✅ | ❌ |
| `command.assign` 分配/回收指令（assign/recycle） | ❌ | ✅ | ✅ | ✅ | ❌ |
| `command.transfer` 移交/主管修正指令（transfer/supervisor_correction） | ❌ | ✅ | ❌ | ✅ | ❌ |
| `command.permission` 权限变更指令（permission_change） | ❌ | ❌ | ❌ | ✅ | ❌ |
| `command.notify` SLA 升级通知（sla1_escalate_supervisor） | ✅ | ✅ | ✅ | ✅ | ❌ |
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
| 11 | POST | `/api/v1/sync/commands` | Bearer | 按 eventType 细分（§3.2 指令域） | 下发中央指令：assign/recycle→`command.assign`；transfer/supervisor_correction→`command.transfer`；permission_change→`command.permission`；sla1_escalate_supervisor→`command.notify` |

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
**SMB 入口已真正接入**（2026-09-15）：`lanSyncService.validateDownEventFile()` 在 SMB 专属检查
（投递键 / eventSeq / deliveryRole / 文件名绑定 / 主管通知分流）通过后、进入任何业务事务之前，
调用 `validateDownCommand(subject, 'smb')`——payload 白名单 / 必填 / 类型 / lead 建档契约与中央 HTTP
同一份规则，仅 lead 字段集按 `smb` 档放宽。SMB 没有中央 UUID 目标字段，「目标存在」由
**已通过比对的本机投递键**（`localDeliveryKey`）证明，不伪造业务 UUID。

| eventType | entityType | deliveryRole | 必填载荷（节选） | 目标 |
|---|---|---|---|---|
| `assign` | `assignment` | `apply` | `leadId` / `assignmentId` / `salesName` / **`lead`**（`mode` **可选**） | 目标员工或设备 |
| `transfer` | `assignment` | `apply` / `remove` | `leadId` / `assignmentId` / `toSales` / **`lead`** / **`mode`** / **`sla1Deadline`** | 同上（**两个目标**，见下） |
| `recycle` | `assignment` | `apply` | `leadId` / `assignmentId` / `salesName`（**不含 `lead`**） | 同上 |
| `sla1_escalate_supervisor` | `assignment` | `notify` | `leadId` / `assignmentId` / `salesName` / `remindCount` / `recycledAt` | **主管**（按稳定工号解析） |
| `supervisor_correction` | `assignment` | `apply` | `leadId` / `assignmentId` / `title` / `summary`（`detail` 可选） | 同上 |
| `permission_change` | `permission` | `apply` | `employeeRef` / `declaredRole` | 同上 |

- **`type` 与 `deliveryRole` 绑定**：每个 payload 都必须带原始字符串 `type`，且必须严格等于信封
  `eventType`；缺失/空值返回 `missing_field:type`，对象、数组、数字、布尔等返回 `invalid_type:type`，
  字符串但与信封不一致返回 `payload_type_mismatch`。角色同样按原始类型校验，禁止用 `String()` 洗白；
  中央 HTTP 从 payload 读取 `deliveryRole`，SMB 以文件外层 `deliveryRole` 作为来源，若 payload 也带角色则
  两层必须是同一个字符串，否则拒收。角色缺失/空值返回 `missing_field:deliveryRole`，非法形态返回
  `invalid_type:deliveryRole`（SMB 文件外层非法角色在本体校验阶段隔离）。

- **顶层字段的严格运行时契约（2026-09-15 增补）**：必填判定与**形态判定**是两件事。缺失、显式
  `undefined` 或空字符串才按未提供处理；显式 `null` 不默认等同省略，而是按字段的共享规则拒收。
  随后对出现的值按 `DOWN_COMMAND_SPECS[eventType].fields` 的**共享字段规则**判——
  两条通道（中央 HTTP / SMB）共用同一份规则，**不各写一套**。规则集中登记在
  `shared/centralDownCommand.ts`，与 eventType 同处一个注册表。

  | 字段 | kind | 值域 | 出现即必须 | 违反时稳定码 |
  |---|---|---|---|---|
  | `type` | `string` | 必须等于信封 `eventType` | 原始非空 `string` | 缺失/空值 `missing_field:type`／形态 `invalid_type:type`／不一致 `payload_type_mismatch` |
  | `leadId` | `positive_int` | ≥ 1，安全整数 | 原始 `number`，非字符串 / 对象 / 数组 / 布尔 | 缺失 `missing_field`／形态 `invalid_type`／越界或小数 `invalid_integer` |
  | `assignmentId` | `positive_int` | ≥ 1，安全整数 | 同上 | 同上 |
  | `oldAssignmentId` | `positive_int`（**可选**） | ≥ 1，安全整数 | 同上；`null` / 省略 = 未提供（合法） | 同上 |
  | `remindCount` | `non_negative_int` | **0 – 3** | 原始 `number` 整数 | 越界 `invalid_integer:remindCount` |
  | `slaHours` | `positive_int` | **1 – 72** | 原始 `number` 整数 | 越界 `invalid_integer:slaHours` |
  | `sla1Deadline` / `recycledAt` | `timestamp` | ≥ 1，安全正整数毫秒 | 原始 `number` | 缺失 `missing_field:<字段>`／任何非法形态或越界 `invalid_timestamp:<字段>` |
  | `salesName` / `toSales` / `fromSales` / `reason` / `actor` / `title` / `summary` / `employeeRef` / `declaredRole` / `authoritySource` / `displayName` / `contactMasked` | `string` | 非空（另有 `maxLength` 上限） | 原始 `string` 字面量 | `invalid_type:<字段>`／过长 `too_long:<字段>` |

  **纪律**：
  - **禁止在校验之前 `Number(value)` / `String(value)`**——那会把 `{}`（→ `[object Object]`）、
    `"41"`、`true`、`[]`「洗白」成看起来合法的值。所有形态判定都基于**原始类型**。
  - **`kind` 自带自然下界**：`positive_int` ≥ 1、`non_negative_int` ≥ 0。显式 `min` / `max` 只用于**收窄**
    （`remindCount` 收窄到 3、`slaHours` 收窄到 72），**绝不因为没登记 `min` 就让 `0` / 负数溜过去**。
  - **`remindCount` 值域 0–3 的业务依据**：`assignment.sla1_remind_count` 的语义是「已提醒次数」
    （0 = 从未提醒），三次提醒制下**生产者 `crmAssignmentService` 恒发 `remindCount: 3`**，
    接收端 `crmNotifyService` 按 `N/3` 渲染。越界值会让主管收到的「N/3 次」变成假话，故拒收。
  - **`slaHours` 值域 1–72 的业务依据**：口径 = `crmLeadSlaHours` 配置的可接受区间
    （`crmAssignmentService.sla1Hours()` 与 `lanSyncService.slaHoursNow()` 同口径，缺省 24）。
  - **顶层 `leadId` 与 `lead.leadId` 按原始值直接比较**：两侧都通过正整数校验后，`payload.leadId !== subId`
    即 `lead_id_mismatch`。**禁止 `Number()` 后再比**——`Number("41") === Number(41)` 会让
    `leadId: "41"` + `lead.leadId: 41` 这种「上层是字符串、下层是数字」的自相矛盾载荷通过。
    注意跨类型本身已先被 `invalid_type:leadId` 拦下，不会走到一致性判定。
  - **注册表自相矛盾即拒收**：`required` 里的顶层标量字段若既无 `fields` 规则、又不由专门校验器接管
    （`lead` 子对象走 `validateLeadObject`；出现在 `spec.enums` 里的字段走枚举分支），
    直接返回 `unregistered_field_rule:<字段>`——**不给「只判非空就放行」留后门**。

- **可选字段的 `null` / 省略语义（2026-09-15 P2）**：顶层可选字段在 payload 中缺失或为
  `undefined` 才是省略；默认显式 `null` 是非法值，不得被发送适配器、中央服务或 SMB 消费端静默
  转成缺省。典型稳定码为：`actor:null` → `invalid_type:actor`、`sla1Deadline:null` →
  `invalid_timestamp:sla1Deadline`、`reason:null` → `invalid_type:reason`、`mode:null` →
  `invalid_enum:mode`。唯一登记的历史兼容例外是 `transfer.oldAssignmentId:null`，按未提供处理；该例外
  由字段规则显式登记，不扩散为通用 `null` 旁路。

- **`supervisor_correction.detail` 结构（2026-09-15 P2）**：`detail` 可省略；缺失或 `undefined` 合法。
  一旦出现，必须是非 `null`、非数组的普通 JSON 对象（对象字面量或 null-prototype 对象）；字符串、数字、
  布尔值、数组均返回统一 `invalid_type:detail`。对象内部继续执行递归下行禁字段扫描，命中例如
  `detail.nested.messageBody` 即拒收。接收端仅把真正省略的 `detail` 映射为既有 `{}` 缺省；合法对象按原值
  JSON 存入 `notify_inbox.detail`，不静默丢弃内容。本轮只收口普通对象形态与既有递归禁字段扫描；仓库没有
  可复用的通用 JSON 复杂度限制，因此未新增独立的字节数 / 深度 / 键数限制，也未引入新依赖。

- **只有 `assign` / `transfer` 携带 `lead` 子对象**（`allowsLead`）。回收与通知/声明类指令**不带**线索档案，
  携带即整事件拒收——`recycle` 的下行语义是「归属已回收」，接收端按 `assignmentId` 落既有状态机，
  不需要线索资料；「所有指令必带 6 字段」是旧口径，已作废。
  （SMB 例外：Phase 1 历史信封在 `recycle` 上也附带 lead 资料与 `slaHours`，仅 `smb` 档放行，
  中央 HTTP 不放开。）

- **`lead` 子对象建档契约（2026-09-15 增补）**：只带 `leadId` 的指令会让接收端以空身份建档
  （`contact_normalized` 为空串，破坏身份定位并可能撞 `UNIQUE(contact_type, contact_normalized)`），
  因此两条通道都强制**最小身份**：`leadId` 正整数 + `contactType ∈ {phone, wechat, both}` +
  `contactNormalized` 非空字符串。中央 HTTP 口径是**固定 6 字段**——6 项必须**全部存在**，
  `name` / `source` / `note` 允许空串但必须是字符串类型；SMB 档兼容历史生产文件，
  `name` / `source` / `note` / `contactRaw` / `wechat` 存在即校验、不强制存在，但同样不许空身份。
  **顶层 `leadId` 与 `lead.leadId` 必须一致**，不一致即 `lead_id_mismatch` 拒收，禁止按其中一个猜。

- **`mode` 是四值枚举（2026-09-15 增补）**：唯一枚举源 = `shared/centralDownCommand.ts#ASSIGNMENT_MODES`
  （`manual` / `weight` / `round_robin` / `load`，口径 = `assignment.mode` 的真实写入语义）。
  `assign` 与 `transfer` 共用这份枚举：**字段出现时必须是枚举内的字符串字面量**——
  对象 / 数组 / 数字 / 布尔 / 空串 / 未知字符串一律 `invalid_enum:mode`。**禁止先 `String(value)` 再比对**
  （`{}` 会被拍成 `[object Object]` 从而「看起来合法」）。`transfer` 保持 `mode` 必填
  （缺失 → `missing_field:mode`）；`assign` 上 `mode` 可选，**发送方应省略而不是发空串或显式 `null`**。
  中央 HTTP 发送前自检、SMB 消费入口、中央服务端建指令**三处共用同一份约束**；错误码只带字段名，不带值。

  同一份枚举也是**本机生产端**的唯一来源（2026-09-15 增补）：`crmAssignmentService.assignLeads()` 与
  `assignBatchLeads()` 一律经 `ASSIGNMENT_MODES` 校验，**不得自建第二套枚举**。`assignLeads` 缺省
  `manual`；**显式非法值（对象 / 数组 / 数字 / 布尔 / 未知字符串）在开事务前返回
  `{ok:false, code:'E101'}`，零 `assignment` / `ownership_history` / `audit_event` / `outbox_event` 写入**
  ——「本机成功、中央失败」的脏行（如 `assignment.mode = 'teleport'`）由此杜绝。`assignBatchLeads`
  只接受 `weight` / `round_robin` / `load`；**显式非法值返回 `E101`，不再静默回退 `weight`**（缺省仅在
  `undefined` / `null` 时生效）。IPC `crm:assignment:assign` / `crm:assignment:assignBatch` **不得先
  `String()` 收窄再传**（`{}` 会被拍成 `[object Object]` 从而「看起来合法」），原值以 `unknown` 交给
  服务层做运行时校验。

- **升级前 pending 移交的兼容（2026-09-15 增补）**：`mode` / `sla1Deadline` 成为 transfer 必填之后，
  **升级前**就已写入 `outbox_event` 的 pending 行携带的是旧格式载荷。发送侧在投递前调用
  `electron/services/crmDownPayloadCompat.ts#healLegacyDownPayload(type, payload)` **惰性补齐**
  （中央 HTTP 发送前自检与 SMB 发送共用此一处，**不做全表 UPDATE**）：`mode` 与 `sla1Deadline`
  从**本机 assignment 行**（`payload.assignmentId`）读回 `assignment.mode` / `assignment.sla1_deadline`，
  即**移交事实产生时就写死的绝对值**。**严禁按当前时间、当前 `crmLeadSlaHours` 或接收端配置重算**。
  补齐**不动 `event_seq` / `idempotency_key` / `assignmentId` / `oldAssignmentId`**（否则中央会当成新事件）。

- **字符串 SLA 不是合法绝对时间戳（2026-09-15 增补）**：`payload.sla1Deadline` 只有在**原始类型就是
  `number`** 且是**安全正整数**时才算「已合法」。**字符串数字（如 `"1735689600000"`）不算合法**——
  两条通道都保留原始值并由共享 `timestamp` 规则拒收，因此一律**用 assignment 行读回的 `number` 覆盖**，
  **绝不把字符串时间戳原样透传**。小数 / `NaN` / `Infinity` / `0` / 负数 / 对象 / 数组 / 布尔 / 空串
  一律按「未合法」处理（**不是**「看起来能转数字就放过」）。

- **富化前必须核对一致性（2026-09-15 增补）**：`payload.assignmentId` 指向的 assignment 行**存在时**
  一律先核对三项——`assignment.lead_id === payload.leadId`、`assignment.sales_name === payload.toSales`
  （两者都要求为正整数 / 非空字符串，形态不符同样拒收）；任一不符即拒收，
  稳定码 `legacy_transfer_lead_mismatch` / `legacy_transfer_target_mismatch`。
  **理由**：只按 `assignmentId` 取行、不核对线索与目标销售，会把**别的线索**的 `mode` / SLA 富化到
  这条指令上（跨线索串档），接收端据此建出的移交事实是错的。核对**在读到该行时总是执行**——
  包括「两个字段都已合法、本不需要补齐」的载荷（已合法也要拦串档）。
  行**读不到即为终态失败**（见下一条），不存在「读不到行就按是否需要补齐决定放行」的分支。
  ⚠️ `assignment.sales_name` 是**本次移交写下的新行**的归属（= `payload.toSales`），
  由 `crmAssignmentService.transferAssignment()` 在同一事务内如此写入；旧行归原持有者，不参与核对。

- **不可恢复即显式失败、不猜不发（2026-09-15 增补）**：`assignmentId` 形态非法（**无条件拒，与
  `mode` / `sla1Deadline` 是否已完整无关**）/ assignment 行不存在（**同样无条件拒：载荷自足不构成放行理由**）/
  需要补齐而 `mode` 不在枚举内 / 需要补齐而 `sla1_deadline` 不是有限正整数时间戳 → 该行 outbox 显式置
  `failed` + 脱敏审计（`detail` 只有 `{type, reason}`）。稳定码：`legacy_transfer_bad_assignment_id` /
  `legacy_transfer_assignment_missing` / `legacy_transfer_mode_unrecoverable` /
  `legacy_transfer_sla_unrecoverable` / `legacy_transfer_lead_mismatch` / `legacy_transfer_target_mismatch`。

  **「行不存在即无条件拒」的依据（2026-09-15）**：本机 `assignment` 的生命周期是**只软删、只改 status**
  （见 `docs/DATA-CONSTITUTION.md` §1.3：分配事实 append-only，转派 = 旧行 `transferred` + 新行 `assigned`，
  重派 = 旧行 `recycled`；全仓无任何硬删路径，`DELETE FROM assignment` 只出现在测试夹具）。因此一条
  **正常产生**的 outbox 行永远能定位到自己的来源行；定位不到只可能是库被外部改动（换库 / 手工清理 /
  恢复错备份）。此时「载荷是否自足」不构成放行理由——transfer 的每个身份字段都必须可核对
  （`leadId` 对线索、`toSales` 对目录），`assignmentId` 对来源行是同一组核对里的一项，缺一项就不能
  声称这条指令描述的移交事实在本机成立。
  **错误码只带稳定码，不携带客户值、销售姓名或联系方式**（审计 `detail` 亦同）。
  已落盘的旧 SMB 文件走既有 `.failed/` 隔离语义，隔离释放路径后下一轮会在**同一路径**写入补齐后的
  合法文件（最多两轮收敛）。

- **`transfer` 的 SLA 纪律（2026-09-15 增补）**：`sla1Deadline` 与 `mode` 是移交事实**产生时**就确定的
  绝对值，由发起端在同一事务写入 outbox 并随指令传递；`sla1Deadline` 必须是有限正整数时间戳
  （`invalid_timestamp:sla1Deadline` 拒收，字符串数字同样拒收）。接收端落地**精确等于指令值**
  （新行 `assignment.sla1_deadline` 与 `lead.first_contact_deadline` 同值），**绝不在接收端按当前
  配置小时数重算**（设备时钟 / 配置不同会漂移）；`remove` 分支只移除权属，不建行也不动 SLA；
  同一指令重放命中幂等标记，零业务写、SLA 不重启不漂移。

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
  本机 outbox 行**只在两个目标都被中央受理后才结算 `sent`**；任一目标 4xx 则整行 `failed` 并留
  **人工修复审计**（`sync_outbox_failed`：`failedRole` + `failedTarget`（稳定员工标识）+ `delivered`
  已送达目标数，**不含客户数据**）——已送达的目标不回滚也不隐瞒，由人工按审计修复；
  网络类失败原样上抛、行保持 `pending` 等重放（已受理的目标靠幂等判重，不产生第二条指令）。
- **目标解析绝不按显示姓名猜人**：`sla1_escalate_supervisor` 的目标由本机配置项
  `centralSyncSupervisorCode`（**稳定工号**）解析；姓名重名或解析不到一律**显式报错并保持 pending**。
- **中央投递目标与落地**：`sla1_escalate_supervisor` 投递给主管员工/设备，
  本机落 `notify_inbox`（`notify_type` 为 SLA 升级类）；`supervisor_correction` 落 `notify_inbox`
  待人工确认，**不静默覆盖**本机事实行。

### 3.5.1 失败同步项的正式重投入口（2026-09-15 增补）

上行 `outbox_event` 行被中央永久拒绝（4xx）后置 `failed`。此前**生产侧没有恢复入口**，
只能靠人工改库。现提供受限的正式能力，**不允许任意 SQL、不允许任意状态迁移**：

| 层 | 位置 | 语义 |
|---|---|---|
| 服务层 | `centralSyncService.retryFailedOutbox(rowId)` | 事务内判定 → 只接受 `status='failed'` 的行 → 类型必须已注册 → 原子条件更新 `failed → pending`（`WHERE id=? AND status='failed'`，**重复点击第二次匹配 0 行，天然幂等**）→ 追加 `audit_event(action='sync_outbox_retry')` |
| 服务层 | `centralSyncService.listFailedOutbox(limit=50)` | **只读**列表，返回裁剪字段（行号 / 类型 / 稳定原因码 / 时间），**不回传 payload 原文**；原因码经 `SAFE_FAILURE_CODE`（`/^[A-Za-z0-9_:.\-]{1,80}$/`）过滤，形态不符降级为通用码 |
| IPC | `centralsync:failed` / `centralsync:retryFailed` | preload 与 `src/types/electron.d.ts` 同名桥接 |
| 设置页 | 同步状态区「失败同步项」 | 逐项**重试**按钮 + `backlogFailed` 计数 |

- **不变式**：重投**不改 payload、不改 `event_seq`、不改 `idempotency_key`**——中央侧 `eventId`
  只由 `deviceId + idempotency_key` 决定，重投后身份不变，已受理的目标由中央判 duplicate。
- **稳定返回码**：`ok` / `invalid_row_id`（非正整数或 ≤0）/ `not_found` / `not_failed`（行存在但非 failed）/
  `unsupported_type`（类型未注册）。不存在的行、`pending` / `sent` 行一律**不改动**。
- **审计脱敏**：`sync_outbox_retry` 只记 actor / 行号 / 类型，**不记客户联系方式、聊天正文、
  完整线索资料与令牌**。
- **双目标部分成功**：已受理的 `apply` 目标重投被判 duplicate，原先 4xx 的 `remove` 目标重新投递，
  **两个目标都被受理才结算 `sent`**（与网络类失败靠重放收敛同一条路径）。

- **重投结果是「该行自己的最终状态」，不是整轮计数（2026-09-15 增补）**：`centralsync:retryFailed`
  在 `runCentralSyncOnce()` 返回后**回读该 `rowId` 的库内状态**，回包带
  `retryOutcome ∈ {sent, pending, failed, unconfigured, unknown}`、`deliveryStatus`
  （`pending` / `failed` / `sent` / `unknown`）与 `syncConfigured`。**判定绝不看整轮的 `pushed` / `rejected`**
  ——那是**所有行**的合计：别的行成功会把它顶上去，网络故障时全都没发出去也证明不了这一行没成功。
  设置页按此分支：`sent` → 绿色「已完成同步」；`unconfigured` → 警告「已重新排队，但中央同步未配置」；
  `failed` → 红色「重投后仍被拒绝，请查看审计」；`pending` → 警告「已重新排队，等待网络/下一轮同步」。
  **「重新排队」≠「同步成功」**：`failed → pending` 只说明该行回到可投递队列，与中央是否受理无关；
  `pending` 一律**不得**呈现为成功。回传的 `syncError` 经**既有脱敏**（`maskAuditText` 手机号打码 +
  设备令牌隐藏，截断 300 字）后才出机，**不含令牌、payload 原文或联系方式**；服务侧原始 `error`
  不得绕过脱敏直出。读取行状态是**只读**的，不因读取而改写任何行。

### 3.6 Phase 3a 尚未落地的部分

- **HTTPS / 反向代理 / 证书**：服务侧仅支持「由反向代理终结 TLS」（`CENTRAL_TLS_TERMINATED`，
  影响 `trustProxy`）；证书签发与续期属部署验收，不在代码内。
- **真实 PostgreSQL 端到端 / `docker build` / 双机演练 / Windows 打包 / 上行延迟实测**：均未执行。
- **冲突裁决**：当前为「服务端版本闸门 + **跨设备改写拒绝** + 唯一身份冲突记录 + 客户端 `conflict` 回执」，
  多写者合并策略留待 3a 演练后细化。
- **WeKnora / 中央 MCP**：属 Phase 3b，见 §4.2，仍为占位规范。
- **PRD 2.10 / 2.11**：≥100 条商机评测集与官方微信单向推送**均未完成**，与中央节点无关；Phase 4 为未启动 Backlog。
- **验收输出的脱敏边界（2026-09-15 增补）**：会读**真实客户库**的收口门禁
  （`scripts/p0-3-closed-gate.ts`）终端只输出**聚合计数 / 通过失败 / 结构性结论**，
  **不打印 `session_id`、客户姓名、联系方式、判断正文与摘要、`evidence_text`、`message_key` 原文
  与库绝对路径**（断言失败细节同样不含）。该红线由 `scripts/p0-3-closed-gate-test.ts` 的静态守卫 +
  合成库输出捕获守卫强制。**中央侧全部测试跑在 `MemoryCentralStore` 上，不能替代真实 PostgreSQL 验证。**

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
