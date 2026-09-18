# DATA-CONSTITUTION — WeFlow 数据宪法（D1 定案）

> 状态：**D1 + D2 定稿**（2026-09-02）。依据：`docs/规划/weflow-hermes-PRD-v3.4.md` §5（11 对象）/ §11（ADR-001）。
> 本文档优先级高于各模块设计文档；凡冲突，以本文档为准，修订须经评审。
> 范围说明：§1 对象契约（D1）+ §2 四项 Policy（D2：SSOT / Soft Delete / Feature Gate 七问 / Identity Resolution / Stage Transition）已定稿；§2.5 Stage 矩阵 🔶 格待 D8 主管签字生效；**§2.7 知识治理 Policy（2026-09-09 增补，PRD 2.3/2.7/2.8/2.9 收口：AI 有效读取唯一原语 / logical_id 版本链 / TTL 巡检 / 价格对账 / 删除纪律 / 引用回流）已定稿**。
> **§3.1 中央投影对象（2026-09-14 增补，PRD 7.1 / §3.1 收口；2026-09-15 补阻断项条款）已定稿**：Phase 3a 上行投影 10 表 + 中央自产审计表 + 自报角色「仅署名不作鉴权」跨机约束，以及 2026-09-15 增补的**出机字段白名单 / 设备命名空间与归属闸门 / 版本化水位与幂等键 / 下行指令面披露**四条。

---

## 0. 术语表（优先级最高，撞名以本节裁决为准）

| 术语 | 裁决含义 | 反义/边界 |
|---|---|---|
| **assignment** | **资源分配**：lead → 销售的分配行为与生命周期（表 `assignment`） | ≠ allocation（到款归属，现有表 `allocation`，不动） |
| **customer** | **人/公司锚点**：跨微信号、跨会话的客户主体（新表 `customer`） | ≠ account（单微信号会话维度的客户档案，现有表原样保留）；≠ customer_profile（salesDb 会话维度视图） |
| **quote** | 宪法对象名，报价单及其版本模型 | = quotation（物理表名就是 `quotation`，不建新表、不改名） |
| **account** | 单微信号维度的客户档案（现有表），28 项现有能力照旧 | 通过可空列 `customer_id` 挂接到 customer；不重建、不改主键 |
| **customer_profile** | salesDb 会话（session）维度的客户视图 | 其既有列 `customer_id` 裁决为**指向新 `customer` 表的逻辑外键**，Phase 1 迁移回填对齐（见 §2.2） |
| **owner_sales** | 归属销售姓名（自由文本语义化） | 同名列有三处：`account.owner_sales`（转正为 ownership，见 §1.7）、`opportunity.owner_sales`、`logistics.owner_sales`——三列同口径，一并语义化，不允许第四处出现 |
| **lead.tag** | **需求标签**（Excel 导入线索的来源/需求标记） | ⚠️ 归属语义**已退役**（见 §4.2 决策 B）：历史「tag=销售归属」写法作废，任何人不得再把 tag 当归属读 |
| **lead 死列** | `owner_id` / `pool_id` / `assigned_at` / `private_deadline` 四列为历史预留死列（全仓零读写） | **永久禁用**，禁止任何新代码启用；分配事实一律走 `assignment` 表 |

---

## 1. 11+1 对象契约

> 每对象五要素：一句话定义 / 字段级规格 / 合法写入者 / AI 三档标注 / 实现映射。
> **通用五列**（所有新表必备）：`source` / `updated_by` / `updated_at` / `version` / 删除标记（soft delete，见 §2.2）。
> AI 三档：**A** = auto_committed（证据质量+规则校验达标即自动写）；**B** = proposed → 人工 confirm；**C** = request → 审批。
> 状态机统一约定：存量表维持现状（如 lead.status 无 CHECK，service 层守卫）；**CHECK 范围已定（9/2）**：新表有穷枚举一律加 CHECK 硬门禁（assignment.status / customer_identity.identity_type / outbox_event.status，沿用 customer_event 先例）。

### 1.1 customer（新建）
- **定义**：人/公司锚点，跨微信号的客户主体。
- **字段**：主键 id；`name`；`type`（dealer / end_user，PRD 1.5）；客户设备档案（品牌 / 型号 / 车龄 / 购置日期 / 是否已改装 / 改装日期 / 电池类型 / 最近保养日期 / 质保起算日 / 质保期限 / 复购等级——见 §3 登记行）+ 通用五列。
- **写入者**：迁移回填（Phase 1）、确认后的 AI 提案、人工建档。
- **AI 档位**：type 与设备档案 = **B**（proposed→confirm）；建档本身 = **C**。
- **映射**：新建表（crmDb）。`account.customer_id` 可空列挂接（Phase 1 迁移回填）；`customer_profile.customer_id`（salesDb 既有列）为逻辑外键同步对齐。

### 1.2 customer_identity（新建）
- **定义**：customer 的可联系身份（手机号/微信号）归一化登记。
- **字段**：`(identity_type, identity_value)` 唯一约束，identity_type ∈ {phone, wxid}，identity_value 归一化后入库；`customer_id` **可空**（资源池线索未建档时）；`source`（auto/manual）+ `confidence` + 通用五列。
- **写入者**：1.4a 加好友双路判定（手动绑定写 `source=manual, confidence=1.0`）、迁移查重归并。
- **AI 档位**：自动匹配 = **B**；手动绑定 = 人工行为（记 manual/1.0，全程审计）。
- **映射**：新建表。跨库引用 customer 仅逻辑外键（见 §2.1 跨库规则）。

### 1.3 assignment（新建）
- **定义**：资源分配——lead 到销售的一次分配及其生命周期；**lead 归属的唯一事实源**。
- **字段**：主键 id；`lead_id`（逻辑外键 → lead）；`sales_name`（过渡期用姓名，来自 1.2a 本机身份档案字段；Phase 3a 平滑升级 `employee_id`）；`mode`（比例权重 / 轮询 / 负载）；两段 SLA 计时字段（第一段「加了没有」机械计时；第二段「聊了没有」挂 LLM 扫描结果引用，不内嵌计时器——PRD 1.4）；`status` ∈ {assigned, claimed, recycled, transferred} + 通用五列。
- **写入者**：分配服务（三模式引擎）、分配员手工改派、SLA 回收器。
- **AI 档位**：分配引擎执行 = **A**（规则驱动，非 LLM）；回收改派 = **A**；引擎参数（比例权重）调整 = **C**。
- **映射**：lead ↔ assignment **1:N**；当前分配 = 该 lead 最新有效行。**lead 状态机不动，分配状态永不入 lead 表**；lead 四死列永久禁用（术语表）。
- **修订（2026-09-05，三次提醒制，UI设计稿屏 4/屏 6）**：补列 `sla1_remind_count INTEGER DEFAULT 0`（0=未提醒过）——第一段 SLA 从「超时一次即回收」升级为三次提醒制：超时未停表（`sla1_met_at IS NULL`）第 1/2 次只提醒（计数 +1 + audit_event action='sla1_remind'，状态与归属零变更），满第 3 次才自动回收（reason='SLA三次超时回收'）+ outbox_event type='sla1_escalate_supervisor' 主管通知（2026-09-08 闭环：经内网同步定向投递落地 crmDb **notify_inbox**，写者唯一=lanSyncService.consumeSupervisorNotifications）。**扫描范围含 claimed**（已认领未加好友同样在 24h 计时内；认领不重置 sla1_deadline，沿用分配时起点）；已停表行回收器自然跳过。提醒间隔护栏：已提醒行距上次动作（updated_at）≥20h 才允许下一次提醒，防短轮巡一轮刷满 3 次（§2.54 事故教训的时间纪律延伸：回收器绝不凭「行存在即过期」直接处置，须尊重计数与间隔状态）。append-only 不受影响：提醒只 UPDATE 本行计数列 + 追加 audit，ownership_history 零写入。
- **修订（2026-09-10，PRD 2.4「认领满 24h AI 首次分类」触发轴）**：补列 `claimed_at INTEGER`（认领时刻，毫秒；0/NULL=未认领）——认领计时的唯一基准，**禁止用 `updated_at` 反推认领时间**（updated_at 会被提醒计数/回收等任意动作刷新）。**写入者**：`claimLead` 是本机业务写入口（assigned→claimed 同事务写入），`lanSyncService.applyUpEventTx` 是中枢复制落点（上行 claim 回放，取事件携带的 claimedAt，非新的人工业务入口）；转派新建的 assigned 行 `claimed_at=NULL`（新归属重新计时）；回收/提醒不改写（历史行留档）。**存量 = NULL**（上线前已认领行不回填、不触发首次分类扫描——§2.54 时间纪律：不拿过去时刻当触发基点）。

### 1.4 lead（现有表转正）
- **定义**：线索池条目；状态机 NEW→CONTACTED→WX_ADDED→ACCOUNT + DEAD/REOPEN（`crmLeadService.ts:157`，健康不动）。
- **字段**：现有列全保留；四死列标注禁用（不删列，防旧库迁移路径再生变数）。2026-09-06 补列 `import_batch_id`（导入批次回溯，语义/写者/删除规则见 §3 登记行；存量 NULL）。
- **写入者**：分配员录入通道（Excel/粘贴导入，走现有 `importLeads` 写路径）；⚠️ 群资源扫描通道**已下线**（§4.2 决策 B）。
- **AI 档位**：录入查重 = **A**；转客户（toAccount）= 人工触发。
- **映射**：现有表（crmDb）转正，零 DDL。

### 1.5 opportunity（现有表转正 + 补列）
- **定义**：商机。
- **补列**（幂等 ALTER）：`source`（AI 发现 vs 手动——HANDOVER 已列为前置项）、`type`（整车/改装）、`amount_cny` / `original_currency` / `original_amount` / `rate_note`、`main_model`、`order_qty` / `shipped_qty`、`expected_ship_start` / `expected_ship_end`、`delivery_date`、`quote_version_id`、`customer_id`（与既有 `account_id` 并存，逻辑外键）、`over_ship_reason`（超发原因，见 §3 登记行）。
- **写入者**：信号扫描（parseBuySignal 链路）、人工、迁移回填。
- **AI 档位**：信号建/推商机 = **B**；金额/币种字段 = **B**（真实库曾出现手机号落金额的前科，规则校验必备）。
- **映射**：现有表补列；`owner_sales` 列语义化口径与 account 一致（术语表）。
- **修订（2026-09-09，正式成交登记收口）**：人工正式成交走单点 `crmDbService.registerOpportunityDeal`（IPC `crm:opportunity:registerDeal`）——成交字段（amount_cny / original_currency / original_amount / rate_note / main_model / model_extra（落 custom_fields.supplementary_models）/ order_qty / expected_ship_start / expected_ship_end / delivery_date / type / quote_version_id）+ `status='won'` + opportunity_event + audit_event(action='opportunity_deal_register') **同一事务**，任一步失败整体回滚。硬校验（事务内执行）：amount_cny > 0；order_qty 正整数；expected_ship_end 不早于 expected_ship_start；非 CNY 必填 original_amount + rate_note；main_model 必填且必须命中 product（model/name）；type 只能是「整车」或「改装」（空值/任意字符串一律拒绝）；quote_version_id 必须属于该商机客户的合同且为**现行有效版本**（effective_to=0——历史版本只读，不可绑定，见 §1.6）。**lost 保持轻量**：`opportunityClose('lost')` 只写丢单状态和原因（opportunity_event.detail 留痕），不写任何成交字段；客户阶段自动联动到「成交」**不直接置 won**（`syncOpportunityStageByAccount` 只生成待人工成交登记提醒，opportunity_event 事件 type=`deal_pending`，幂等：同商机只保留一条），人工正式登记一律走 registerOpportunityDeal。

### 1.6 quote（quotation 转正 + 版本模型）
- **定义**：报价单；**append-only 版本链**，历史版本只读。
- **补列**：`version`、`effective_from` / `effective_to`、`pdf_hash`、`artifact_hash`（2026-09-09 本刀补列：DOCX 产物 SHA-256 存证）；合同绑定走 `contract.quote_version_id`（contract 侧补列）。
- **裁决（既有反向链）**：现状 `quotation.contract_id → contract`。新权威方向 = `contract.quote_version_id → quote 版本`；`quotation.contract_id` 过渡期保留双写只读兼容，后续 Phase 退役，D3 写清双写起止。
- **写入者**：docgen 链路、人工新建版本。
- **AI 档位**：AI 起草报价 = **B**；版本生效（effective）= 人工动作。
- **映射**：现有 `quotation` 表补列；版本行 append-only（同主键组新版本行，旧行置 effective_to）。
- **修订（2026-09-09，版本链写路径上线）**：
  1. **写入单点** = `crmDbService.createQuotation` → `createQuotationVersionTx`：同事务完成 ① INSERT 新版本行（version 按合同递增 = MAX(version)+1；effective_from=now；quotation.contract_id 过渡期双写）② 关闭上一有效版本（effective_to=切换时刻）③ contract.quote_version_id ← 新版本 ④ audit_event(action='quote_version_create')。任一步失败整体回滚，旧行永不覆盖。
  2. **散写禁令**：`create('quotation')` 直接 INSERT 抛错；`update('quotation')` 守卫——历史版本（effective_to>0）只读一律拒绝；现行版本仅允许 `attachment_path` / `artifact_hash` / `pdf_hash` / `custom_fields` / `valid_until` 回写，价格与行项变更必须新建版本。行项必须来自 product（createQuotation 内校验）。
  3. **产物存证哈希**：报价文件生成完成后对最终产物算 SHA-256（crmDocGenCore.sha256Hex）；**DOCX（及一切真实生成的非 PDF 产物）写 `artifact_hash`，只有真实 PDF（转换链路产出）才写 `pdf_hash`**。历史版本（含只读守卫）不写哈希。
  4. **读口**：`currentQuotationForContract`（当前有效报价，contract.quote_version_id 指针优先，缺省回退 effective_to=0 最新行）/ `quotationHistoryForContract`（版本链全量，历史只读）；IPC `crm:quotation:current` / `crm:quotation:history`。
  5. **模块 04 迁移复用同一版本链逻辑**：存量行规范化走 `normalizeQuotationVersionChain` 单点（version 重排 1..N / effective_from 缺省回填 ← created_at / 旧行 effective_to ← 后继生效点 / 指针接管 / 同事务 audit_event(action='quote_version_backfill')），幂等跳过已归一化合同（`quotationChainNormalized`），不复制 SQL。

### 1.7 ownership（不建表，列语义化）
- **定义**：「当前谁在跟进」= `account.owner_sales` 语义化转正。
- **裁决**：不建独立 ownership 表；现状该列无自动化写入路径（P0-2 盘点确认），转正后写入者收敛为：分配/移交/回收动作（写 `ownership_history` 同事务回写本列）+ 人工编辑。
- **口径覆盖**：`account` / `opportunity` / `logistics` 三处 owner_sales 同语义（术语表）。
- **AI 档位**：**C**（归属变更一律留痕，禁止 AI 直写）。

### 1.8 ownership_history（新建）
- **定义**：归属变更流水（分配/移交/回收/离职）。
- **字段**：`entity_type` / `entity_id` / `old_owner` / `new_owner` / `reason`（分配/移交/回收/离职）/ `actor`（1.2a 姓名+角色）+ 通用五列；append-only。
- **写入者**：分配服务、移交/回收动作；与 owner_sales 回写同事务。
- **AI 档位**：**C**。

### 1.9 stage_history（不建表，收口）
- **定义**：阶段历史 = 事件流 + 当前态投影，不建独立表。
- **实现**：`intent_tag_log`（append-only 事件流，自带 message_key 证据）+ `customer_profile.stage`（当前态投影）。
- **写入者**：继承 P0-2A 定案——classifier / intent / manual / deal 四写者，其余禁写（insightService 降 signal、generic upsert 已剥离）。
- **AI 档位**：classifier/intent = **A**（既有资格）；manual/deal = 人工/规则。

### 1.10 evidence（不建表，定规范）
- **定义**：证据 = key 引用，不复制正文。
- **规范**：`evidence_key` 格式 = P0-2B messageKey 体系（`shared/messageKey.ts` 单一真源，`shared/evidenceKey.ts` 5 格式分类）升格为宪法规范；`evidence_text` = 客户原话 ≤200 字（非 AI 结论）；**只存 key 不复制正文**（evidence_text 仅作展示快照）。
- **消费**：D7 评测集直接引用本规范。
- **AI 档位**：所有 AI 产出必须带 evidence 才可进 B/A 档。

### 1.11 outbox_event（新建，+1）
- **定义**：外发事件暂存（2.11 Hermes 微信推送 / Phase 3a 上行）。
- **字段**：`event_seq` / `idempotency_key` / `payload` / `status`（pending/sent/failed）+ 通用五列。
- **写入者**：业务动作埋点；**1.10 阶段只记录不发送**（无发送器）。
- **AI 档位**：AI 永不直写；由业务代码写入。
- **映射**：新建表。**崩溃语义已定（9/2）**：sql.js 内存库 500ms 防抖落盘，崩溃丢失的 pending 行 = 事件未发生（1.10 只记录阶段无业务后果）；Phase 3a 上行阶段升级为同步落盘；idempotency_key 保证业务侧可重放。
- **写入不变式（2026-09-15 澄清）**：`append-only` 指**行集合只增不删**，且 `payload` / `event_seq` /
  `idempotency_key` 一经写入**永不改写**（改写会把既有事件变成另一个事件，中央据此判重会失效）。
  **唯一可按状态机迁移的列是 `status`**（`pending → sent` / `pending → failed`）与随之推进的 `updated_at`。
- **失败重投是正式能力，不是改库（2026-09-15 增补）**：被中央永久拒绝（4xx）的行置 `failed` 后，
  由 `centralSyncService.retryFailedOutbox(rowId)` 走**受限入口**恢复：只接受 `failed` 行、类型必须已注册、
  事务内原子条件更新 `failed → pending`（重复调用第二次匹配 0 行，天然幂等），
  **不改 payload / `event_seq` / `idempotency_key`**，并追加 `audit_event(action='sync_outbox_retry')`
  （只记 actor / 行号 / 类型，不含客户数据）。设置页经 `centralsync:failed`（只读，字段裁剪，
  **不回传 payload 原文**）与 `centralsync:retryFailed` 消费。**测试与任何调用方都不得再直接
  `UPDATE outbox_event SET status=...`** —— 那会绕过权限、审计与状态机。
- **「重新排队」≠「同步成功」（2026-09-15 澄清）**：`failed → pending` 只表示该行**回到可投递队列**，
  与中央是否受理无关。任何向用户汇报同步结果的入口都必须**回读该行自己的最终 `status`**，
  **不得用整轮的 `pushed` / `rejected` 计数反推单行结果**；`pending` 一律按「等待下一轮」呈现，
  不得呈现为成功。回传的错误文本必须经既有脱敏（手机号打码、设备令牌隐藏）后才可出机。
- **隔离测试的布置口径（2026-09-15 澄清）**：上一条同样约束测试。测试需要「终态行」时应当
  **新建一条合法 fixture 行**（`INSERT`，行本身即为终态），**不得对既有行直接
  `UPDATE ... SET status=...`**；`status` 的每一次迁移都只能由状态机自己完成
  （`settleOutboxRow` / `retryFailedOutbox` 的条件更新）。

### 1.12 audit_event（新建）
- **定义**：统一审计流水；append-only，无删除、无更新。
- **字段**：`actor`（1.2a 姓名+角色）/ `action` / `entity_type` / `entity_id` / `detail` + 通用五列中的时间列（审计行本身不需要 version/删除标记，写死规则见 §2.2 例外）。
- **⚠️ 身份与权限分离**：actor 的角色字段**仅署名用途，不作访问控制依据**（PRD 1.2a 明文）。Phase 1 本机功能入口的门禁靠机器部署形态 + 现有应用锁；Phase 3a 起以中央主机服务端绑定认证为准。
- **写入者**：一切新审计写点一律走 audit_event；`activity_log` / `auto_confirm_log` **封存只读留档**（历史可查，新写禁止）。
- **AI 档位**：**C**（AI 行为被审计，不产生审计写权限）。

---

## 2. Policies

### 2.1 SSOT 规则（D2 细化，已定裁决先行）
- 每对象唯一事实源见 §1 各「映射」行；投影/缓存必须可溯源、可重建。
- **跨库规则（新裁决）**：crmDb 与 salesDb 为两个独立 SQLite 库（按微信号分库），**跨库引用一律只做逻辑外键，不建 FK 约束**；跨库一致性由 service 层「先 crmDb 后 salesDb」铁律 + 启动兜底自愈保证（现有 SLA 卡先例）。
- **阶段 SSOT**：`customer_profile.stage` 唯一真源（P0-2A/漏斗改造定案），本宪法继承不翻案。
- **归属 SSOT**：`assignment` 表（lead 维度）、`owner_sales` 三列（客户/商机/物流维度）。

### 2.2 Soft Delete 规则（D2 细化，已定裁决先行）
- 通用五列含删除标记；删除 = 置标记，不物理删。
- **例外**：`audit_event` / `ownership_history` / `intent_tag_log` / `outbox_event` 为 append-only，**连删除标记都没有**，永不删改。
- **PIPL 删除权通道（2026-09-03 D8 补）**：客户依法要求删除 → 先逻辑删（置标记，界面即刻不可见）+ 定期物理清除（含派生快照/证据文本），全过程写 `audit_event` 留痕。
- **迁移铁律（现状继承）**：本项目无版本表，迁移全靠「CREATE IF NOT EXISTS + 逐列 ALTER 吞错」双路径（`crmDbService.ts:337` 模式）；**列一经发布不得改名/改语义**，只能加列。lead 式 DROP 重建为历史特例，新表不得再触发。

### 2.3 Feature Gate 七问（D2 定稿）

任何不在当前 Phase 清单里的新需求/新字段/新表，入宪前先答七问（原文收录自开发流程计划纪律 #11）：

1. 属哪个 Phase？
2. 为什么现在必须做？
3. 会不会引入未来架构？
4. 会不会改变数据宪法？
5. 会不会新增事实源？
6. 会不会新增权限边界？
7. 挤掉什么？

**裁决流程**：七问全过 → 写入本宪法（对象契约 / Policy / §3 扩展占位）；任何一问答不过 → 进 Backlog，不做。AI 不得自行扩大需求范围；答七问的责任在提案者。

### 2.4 Identity Resolution Policy（D2 定稿）

- **身份优先级**：手机号 > wxid > 昵称。昵称仅显示用途，**永不作匹配依据**（改名不失效的前提 = 内部绑 wxid，见 §1.2）。
- **归一化**：identity_value 入库前归一化（手机号去非数字字符、wxid 去首尾空白），归一化后才参与 `(identity_type, identity_value)` 唯一约束。
- **归并规则**：同手机号 → 同 customer；一人多 wxid → 多 identity 行挂同一 customer_id。
- **后补关联**：资源池线索的 identity 行 `customer_id = NULL` 是合法态（未建档）；在绑定微信（1.4a）/ 认领 / 转客户时后补关联。
- **冲突处理**：同一 identity 挂到不同 customer → 系统不自动处置，只产**合并提案** → 人工审批后执行（合并动作 = 改挂 identity 行 + 写 ownership_history + 写 audit_event，三者同事务）。
- **AI 边界**：AI 只产关联/合并提案（B 档 proposed→confirm），**永不执行合并**。手动绑定（source=manual, confidence=1.0）是人工行为，不受此限但全程审计。

### 2.5 Stage Transition Policy（D2 定稿，继承 P0-2A 不翻案）

- **状态模型**：canonical stage 6 值 `new / contacted / quoted / negotiating / won / lost` + `activityState`（active/dormant）独立维度 + `unknown` 异常位（数据缺失合法态）。事实源 = `customer_profile.stage`；历史 = `intent_tag_log` 事件流（§1.9）。
- **转移矩阵**（✅ 直接合法 / 🔶 需人工确认 / ⛔ 禁止）：

| from \ to | new | contacted | quoted | negotiating | won | lost |
|---|---|---|---|---|---|---|
| **new** | — | ✅ | ✅ 跳级 | ✅ 跳级 | ⛔ 禁直连 | ✅ |
| **contacted** | 🔶 | — | ✅ | ✅ 跳级 | ⛔ 禁直连 | ✅ |
| **quoted** | 🔶 | 🔶 | — | ✅ | ✅ | ✅ |
| **negotiating** | 🔶 | 🔶 | 🔶 | — | ✅ | ✅ |
| **won** | ⛔ | ⛔ | ⛔ | ⛔ | — | 🔶 |
| **lost** | 🔶 复活 | 🔶 复活 | 🔶 复活 | 🔶 复活 | ⛔ | — |

- **PRD 四规则落实**：允许跳级 = 前进任意格 ✅；回退受限 = 后退一律 🔶；成交禁直连 = won 仅 quoted/negotiating 可达；流失复活需确认 = lost → 任何阶段 🔶。
- **activityState 不占矩阵**：dormant 由沉默规则写（P0-2A），与 stage 正交。
- **unknown**：→ unknown 仅限初始化/数据缺失置位（系统行为）；unknown → 任何 stage 一律 🔶；业务流转不得把已知阶段改回 unknown。
- **写入资格**（P0-2A 四写者原样收编）：classifier / intent = A 档，**仅可落 ✅ 格**；deal rule 同；manual = 人工，可落 ✅ + 🔶 格；其余写者禁写（insightService 降 signal、generic upsert 已剥离——P0-2A 六刀不翻案）。
- **流失判定证据规则（2026-09-03 D8 裁决）**：`new/contacted → lost` 保持 ✅，但 A 档写 lost **必须携带「客户明确拒绝」的原话证据（messageKey，§1.10）**，无证据不得落 lost；「流失判定准确率」纳入 D7 评测集（与商机判定同门槛，先评测再放量）。
- ⚠️ 本矩阵为 D2 提案：🔶 格已列入 D8 评审包请主管签字；签字前实现以本表为准。

### 2.6 AI Read Boundary（2026-09-03 D8 裁决 8）

写有边界（§2.4/§2.5 + AI 三档），读也必须有边界：

- **默认本账号 scope**：AI 读数据默认限本微信号账号的数据范围（accountScope 隔离升格为正式裁决）。
- **跨账号最小化**：仅允许查重 / 合并提案所需的**最小身份字段**（手机号 / wxid），**不得读取他账号的聊天原文与商机金额**。
- **云推理脱敏（同日拍板）**：聊天扫描等云 API 推理保留，但发送前自动脱敏——手机号 / 微信号 / 身份证号等私密字段打码为 `***`；**聊天原文不出本机**指未脱敏原文，脱敏片段可出。

### 2.7 知识治理 Policy（2026-09-09 本刀入宪，PRD 2.3/2.7/2.8/2.9 收口）

- **AI 有效知识读取唯一原语**：`salesDbService.kbValidEntries`（SQL 级三重过滤，唯一合法出口）——① `status = 'published'`；② `ttl_date` 为空 / `'0'` / 未过期（本地时区当日比较）；③ 每个 `logical_id` 只出当前有效版本（version/updated_at/id 三级稳定排序）。Hermes 工具（knowledge.search）、问一问（hermesAskService）、聊天回复建议（salesReplyService）、话术建议与行动建议（salesActionEngine.generateActionAnalysis）**全部只经该原语取数**；`kbList`/`kbSearch` 为人工管理界面读口，**AI 消费路径禁止直连**（knowledge-governance-test m 节全仓静态绕过检查看门）。
- **版本链（logical_id）**：稳定逻辑 ID，同一条知识的全部版本行（跨 staging/published/closed）共享，与标题改名解耦。新建条目自成一链（`kb-<rowid>`），**即使标题与已有知识完全相同也独立成链**（2026-09-10 修订：标题相同 ≠ 同一条知识，PRD 明确不得仅靠标题识别同一知识）。**TRIM(title) 分组归链仅限旧库首次升级回填**（`kb-<组内最小 id>`，幂等可重入，回填后为持久值），**运行时禁止按标题归并/识别版本链**：staging 发布使用自身已有的 logical_id（不搜索同标题 published 并链），同链新版本仅能经「基于已发布版本创建新版本」的 fork 入口（kbUpdate published 分支）继承 logical_id。
- **版本状态机**：staging → published（kbReview 唯一写点）；新版本发布成功后，链内其余 published 行自动置 **closed**（被接替关闭的历史版本，只读沉底留档，不删、不伪造 rejected）。closed / rejected 一律拒绝编辑。
- **编辑语义**：staging 原地编辑；**编辑 published = fork 同链 version+1 的 staging 新版本**（继承 logical_id/source/evidence_key，published 原行零改动），发布后接替闭环；零变更不 fork。
- **TTL 巡检（2.9）**：到期 published 条目**不删除、不下架**，由巡检（挂今日行动全量/懒扫描与卡流刷新）生成待处理提醒卡（`follow_up_task`，trigger_type=`knowledge_ttl`，source_id=条目 id，幂等：pending 查重 + partial unique 兜底）；负责人经 `kbRenewTtl` 就地顺延（published 唯一允许的就地更新，仅 ttl_date 治理元数据）；到期知识即从 AI 原语消失。
- **价格对账（2.7）**：价格类条目发布前与 crmDb `product` 主数据核对（万/¥/元三口径归一为元，±1% 容差）；**冲突禁止 official 发布**并返回具体冲突字段（product_id/model/product_price/knowledge_prices）；**产品主数据价格为最终权威**；community 发布不作硬门但回带冲突提示；无主数据可对（未提及产品/无权威价/crmDb 不可用）诚实放行，人工审核兜底。
- **删除纪律**：物理删除仅限**从未审核的 staging**，且**先写 audit_event**（crmDb，action=`knowledge_delete`，跨库铁律「先 crmDb 后 salesDb」，审计失败删除中止）；published / rejected / closed 一律禁止物理删除（published 修正走 fork 接替，rejected 拒因留档反哺，closed 历史留档）。
- **引用回流（2.9）**：AI 消费知识逐条落 `knowledge_usage` 台账（§3 登记行）；统计口径 = 引用次数 / 最近引用时间 / 引用会话关联客户当前阶段分布（customer_profile.stage 归一化投影）；小库全量注入无法归因到单条，不计引用。

---

## 3. 扩展对象占位（防过度设计）

- **action**：Phase 2 入宪。当前事实载体 = `follow_up_task` + `customer_event`（P0-3 E3 已 CLOSED），入宪时再裁决是否独立成表。
- **ticket**：Phase 4 入宪。当前无对应物，不预设字段。
- **opportunity_eval_case**（特许扩展，非业务事实表）：PRD 2.10 商机评测集，D7 落库 salesDb（与 intent_tag_log 同库，证据引用同库闭环），salesDb 无 ENTITIES 白名单（该机制仅 crmDbService 有）故无需注册，带通用五列。除本行特许外，任何新表须先过 §2.3 Feature Gate 七问入宪。
- **alert_eval_case**（特许扩展，非业务事实表）：设计-AI见解重定位 §4.3 告警评测集（2026-09-05 本刀入宪落库），落 salesDb（同 opportunity_eval_case 库位与理由，无需注册白名单），带通用五列。结构仿 opportunity_eval_case 但不复用其表：label 三档语义不同（correct/wrong/uncertain = 告警是否成立，非商机有无）、UNIQUE 键多一维 alert_type（每类型独立评测，evalStats 全表聚合不被单一告警类型污染）。字段：session_id / anchor_key（证据锚点 messageKey）/ alert_type / label CHECK('','correct','wrong','uncertain') / evidence_message_keys / evidence_text（≤200 字快照，PIPL）/ ai_label 人机分存 / status CHECK('pending','prelabeled','confirmed') / annotated_by / source。幂等键 UNIQUE(session_id, anchor_key, alert_type)。
- **payment_promise**（2026-09-05 本刀入宪，告警 D「承诺打款日过期」/ alert type=`payment_overdue` 配套，设计-AI见解重定位 §4.2 D）：客户明确承诺付款时间的登记表，落 **crmDb**（须注册 ENTITIES 白名单——历史坑：漏注册曾静默失败）。字段：`account_id`（客户档案，NOT NULL）/ `session_id`（承诺原话所在会话——createAlert 四道闸证据回查契约必填，故与 evidence_key 同为必登记项）/ `lead_id` 可空 / `promise_text`（客户原话快照 ≤200 字，§1.10：只存快照不复制全文）/ `due_date`（解析出的承诺日，存当日 0 点毫秒）/ `evidence_key`（承诺依据的客户原话 messageKey，§1.10 锚点强制：验不出原话整条丢弃）/ `status` CHECK('pending','kept','overdue','cancelled') / `source`（识别来源，默认 'llm'）/ 通用五列。幂等：**UNIQUE(account_id, evidence_key)**——同一条客户原话只登记一次。**写入者**：① 识别链（crmParseService 私聊扫描 → 窄口径候选正则命中才调 LLM，置信 <0.6 或日期解不出不登记，宁缺毋滥；我方消息 isSend=1 不识别；actor=`system:payment-promise`）② 到期扫描器（status 流转 pending→kept（登记后该账户有到款）/ pending→overdue（到期无到款），actor=`system:payment-scan`，流转写 audit_event 留痕）③ 人工 cancelled（预留，须留 audit_event）。**删除规则**：软删（通用五列 deleted 标记），不物理删；PIPL 删除权通道沿用 §2.2。告警出口：到期无款经 `alertService.createAlert({type:'payment_overdue'})` 四道闸，`ALERT_PUSH_APPROVED.payment_overdue` 默认 false——评测 ≥85% 前只置 overdue 状态不推送。
- **lead.import_batch_id**（2026-09-06 本刀入宪，§2.72 遗留「入池方式精确化」）：lead 表加列，**列语义 = 导入批次回溯**——该线索由哪一次分配员导入产生（逻辑外键 → import_batch.id，不建 FK 约束，跨表铁律）。**写入者**：`importLeads` 单点（同事务先建 import_batch 行拿 id，逐行回填；组内 UPDATE 计数）。**存量 = NULL**（该列上线前的历史导入线索不回填，展示层 NULL 回退「时间近似判定」，不炸存量）；**删除规则**：随 lead 行生命周期（级联删线索时同删，无独立删除路径）；禁止改语义（非分配归属、非审计——审计走 audit_event.lead_import）。
- **assignment_weight_change 审计动作**（2026-09-06 本刀入宪，§2.72 遗留「权重调整独立审计」）：`crmAssignWeights` 配置被修改时写一条 audit_event（action=`assignment_weight_change`，entity_type=`config`，detail=前后权重 JSON diff + actor=当前身份档案姓名）。**写点单点 = main.ts `config:set` IPC 拦截**（前端 config set 原无审计；不新增端点、前端零改动），写库失败不阻塞配置保存（审计尽力而为，配置写入是主语义）。屏 7 审计流水「权重调整」段从 `LIKE '%weight%'` 预留改为精确匹配本 action。
- **knowledge_base 治理列**（2026-09-06 本刀入宪，设计-Hermes-MVP 刀 1；**2026-09-09 修订：PRD 2.3 版本链收口**）：现有表加列（幂等 ALTER，迁移铁律「只能加列」），**不建新表**。`status`（**staging/published/rejected/closed**，默认 staging——一切新增条目（人工/CSV/话术提炼/知识提案）一律先落 staging，AI 永不发布；closed = 同链新版本发布后被接替关闭的历史版本，§2.7）/ `authority`（official/community，默认 community——official=主管审定权威口径，价格冲突时发布被禁，§2.7）/ `version`（INT 默认 1；同链新版本 = 链内最大 version + 1，引用展示 `（vN）`）/ **`logical_id`（2026-09-09 增列：稳定知识逻辑 ID，PRD 2.3 版本链锚点——同链所有版本共享、与标题解耦；存量按 TRIM(title) 分组回填，见 §2.7）** / `ttl_date`（到期日，可空；2026-09-09 起**到期不出 AI 原语并生成待处理提醒，不删除知识**，废除「Phase 3b 前不做自动过期处置」的旧口径）/ `reviewed_by`、`reviewed_at`（审核署名+时间）/ `reject_reason`（拒因，拒绝必填）。**写入者**：status/reviewed_*/reject_reason/logical_id/version 接替唯一点 = `kbReview` 状态机（staging→published｜staging→rejected，跨态拒绝；发布成功自动关闭链内其余 published 行），actor=当前身份档案姓名；authority 仅发布动作可置（official 受价格对账门约束）；ttl_date 就地更新唯一点 = `kbRenewTtl`（仅 published 当前版本）。**编辑规则**：staging 原地编辑（kbUpdate）；published 编辑 = fork 同链 version+1 staging 新版本；rejected/closed 只读。**删除规则**：物理删除仅限从未审核的 staging 且**先写 audit_event（crmDb，action=knowledge_delete，审计失败删除中止）**；published/rejected/closed 禁止物理删除（2026-09-09 收紧：原「物理删除仅保留既有 kbDelete 人工通道」口径作废）。存量迁移一次性置 `status=staging, authority=community`（幂等可重入，只补 NULL/空，已审定行不动）——治理版上线后存量默认不可被问答引用。
- **knowledge_base 提案列**（2026-09-06 本刀入宪，设计-Hermes-MVP 刀 4）：现有表再加两列（幂等 ALTER，迁移铁律「只能加列」），不建新表。`source`（TEXT NOT NULL DEFAULT 'manual'：manual=人工新增/CSV/话术提炼及存量背填；proposal=知识提案——问答无命中「生成知识提案」/ 知识页「补充知识」两入口共用唯一写点 `salesKnowledgeService.propose`）/ `evidence_key`（TEXT 可空：提案来源锚点——问答路径 = 问题摘要哈希 askKey（可回查 proposal_event knowledge_ask 台账行），手动路径 = 客户原话 messageKey 或出处摘要；**硬门：source=proposal 的行 evidence_key 必填，服务层拦截，空锚提案不进审核队列**，§1.10 沿用；非提案行 NULL 合法）。**写入者**：source/evidence_key 仅创建时落（kbCreate 透传），kbReview 状态机不动这两列；存量行 ALTER DEFAULT 背填 'manual'。**删除规则**：随条目生命周期（rejected 沉底留档同款）。**证据回查契约（2026-09-09 收口）**：evidence_key 的回查一律经 `sales:evidence:getByKey` 统一入口（evidenceResolver，P0-2B），解析不了或查不到**返回 unavailable（reason 明示）**，绝不伪造回查成功（KnowledgeBasePage「查看依据」＝依据不可用话术）。
- **knowledge_usage**（2026-09-09 本刀入宪，PRD 2.9 效果回流「知识使用 × 阶段结果归因」配套）：知识引用台账，落 **salesDb**（与 knowledge_base 同库闭环，无需注册白名单，同 opportunity_eval_case 理由）。字段：`knowledge_id`（NOT NULL）/ `logical_id` + `version` + `title`（引用时点的版本链快照）/ `session_id` 可空（引用所在会话，ask 全局问不携带）/ `ask_key` 可空（ask 轨道的问题哈希）/ `source`（ask=问答引用 / reply=聊天回复建议检索命中 / action=行动建议检索命中）/ `cited_at` + id 主键（时间列单列，§1.12 同例）。**append-only**（§2.2 例外同款：无删除标记、无 UPDATE/DELETE 方法，永不删改）。**写入者**：① hermesAskService 出答案时逐引用条目落账（ask 轨道，同 (knowledge_id, ask_key) 幂等去重）；② salesReplyService / salesActionEngine 检索路径选中条目落账（reply/action 轨道，每次注入各记一行）；**小库全量注入无法归因到单条，不计引用**。**消费**：只读聚合 `knowledgeUsageStats`（引用次数 / 最近引用时间 / 引用会话关联客户当前阶段分布——customer_profile.stage 归一化投影，无会话/无档案不计入）；AI 永不直写（由 AI 链路代码落账，非模型输出）。
- **proposal_event**（2026-09-06 本刀入宪，设计-Hermes-MVP 刀 2 采用率埋点）：「AI 提案 → 人处理」全程埋点，落 **salesDb**（与 knowledge_base 同库：三写点中知识审核/行动卡完成在 salesDb，聚合读在复盘页；crmDb 侧事件经服务层跨库写入，跨库逻辑外键铁律）。字段：`event_type` CHECK(proposal/knowledge/action 三类)/ `stage` CHECK(generated/viewed/accepted/modified/rejected/expired 六态)/ `entity_type` + `entity_id`（指向提案对象：account_info=`<accountId>:<field>`、knowledge=`<id>`、follow_up_task=`<id>`；刀 3 增补 `knowledge_ask`=`<问题摘要哈希>`——问答埋点 generated（出答案）/viewed（展开），非提案对象归属，同一 append-only 台账复用）/ `actor` / `created_at` + id 主键，通用五列即此六列（时间列 created_at 单列，§1.12 同例）。**append-only**（§2.2 例外同款：无删除标记、无 UPDATE/DELETE 方法，永不删改）。**写入者**：① applyInfo accept/reject → proposal/accepted|rejected；② 知识审核发布/拒绝 → knowledge/accepted|rejected；③ completeSignal → action/accepted；④ generated/viewed 挂既有提案生成点（enrich pending 生成、任务创建 todoCreate）与卡流渲染点（今日行动卡流，viewed 每实体只记一次防刷屏）；⑤ 刀 3 问答（设计-Hermes-MVP 刀 3.5）：hermes-ask 出答案 → knowledge/generated（entity=knowledge_ask），用户展开答案 → knowledge/viewed（同 askKey 只记一次）；无命中/未配置模型不记 generated（漏斗诚实，不出答案不入账）；⑥ 刀 4 知识提案（设计-Hermes-MVP 刀 4）：问答无命中/手动补充知识生成提案 → proposal/generated（entity_type=knowledge，entity_id=knowledge_base.id，actor=身份档案）；提案裁决沿用写点② knowledge/accepted|rejected（**不双记 proposal/accepted**——采纳率聚合按 stage 跨 proposal+knowledge 求和，双记会让分母 processed 虚增）；⑦ 刀 5 问数据（设计-Hermes-MVP 刀 5）：问一问数据类出答案 → knowledge/generated（entity=`data_ask`=`<问题摘要哈希>`，event_type 沿用 knowledge——event_type 三类 CHECK 不动，问一问属问答族），用户展开答案 → knowledge/viewed（同 askKey 只记一次）；模板不覆盖（unsupported）/缺客户名不记 generated。AI 永不直写裁决态（accepted/rejected/modified 只能由人工动作触发写入）。**消费**：只读聚合（复盘页「近 7 天提案 N 条 · 采纳率 X%」，采纳率 = (accepted+modified)/已处理总数，分母 0 显示「—」不伪造），PRD DoD 只看这两个数。

- **notify_inbox**（2026-09-08 本刀入宪，SLA1 三次超时主管通知闭环配套）：主管/分配员升级提醒收件箱，落 **crmDb**（ENTITIES 白名单已注册）。字段：`notify_type`（TEXT NOT NULL DEFAULT 'sla1_escalate'）/ `idempotency_key`（TEXT NOT NULL，**UNIQUE 幂等**：同一通知事件只落地一次）/ `title` / `body`（脱敏摘要：联系方式过 maskContact，不出原文）/ `lead_id` 可空 / `detail`（JSON：原归属销售/remindCount/recycledAt/reason/contactMasked）/ `status` CHECK('unread','read')（UI 已读两态，只允许 unread→read 单向）/ 通用五列。**写入者唯一**：lanSyncService.consumeSupervisorNotifications（中枢本机消费 sla1_escalate_supervisor 下行通知，同事务写 notify_inbox + audit_event(action='sla1_supervisor_notify') + outbox 标 sent）；UI（crmIpcHandlers crm:notify:list / crm:notify:markRead）只读与已读，不产生、不删除。**删除规则**：不提供删除（append 精神），软删列保留仅作未来通道。

- **first_classification**（2026-09-10 本刀入宪，PRD 2.4「认领满 24h AI 首次分类」配套）：认领轮次级的首次分类提案事实表，落 **crmDb**（须注册 ENTITIES 白名单；与 assignment 同库——触发轴与轮次幂等键都在 assignment）。字段：`assignment_id`（NOT NULL + **UNIQUE** = 认领轮次幂等键，同一认领只执行一次；转派新建 assignment 行即新轮次，旧轮次行永不改写）/ `lead_id`（NOT NULL）/ `status` CHECK('pending','proposed','confirmed','rejected','failed')（pending=已触发待模型；proposed=B 档提案待人工；confirmed/rejected=人工裁决终态；failed=模型失败可重试，**不写假结果**）/ `result_json`（分类结果：stage / customer_type / intent_score + 画像字段；证据不足字段 = `'unknown'` 合法态，§2.5）/ `evidence_json`（逐字段证据：source ∈ chat/nickname/remark/moments/address/profile + evidence_key（messageKey）或结构化来源 id；**无证据字段不得出现在 result**（§1.10 锚点强制），昵称/模糊关键词等间接信号只形成疑似提案）/ `gaps_json`（信息缺口六字段检测快照）/ `error`（失败原因）/ `trigger_source`（scan=24h 扫描 / manual=立即分析按钮）/ `model` / `decided_by`、`decided_at`（人工裁决署名+时刻）/ 通用五列 + created_at。**写入者唯一 = crmFirstClassifyService**：扫描器（status=claimed 且 claimed_at 满 24h 且无轮次行才创建）与手动「立即分析」双触发同走同一执行函数；proposed/confirmed/rejected 行存在时不重复调模型；confirm/reject 只从 proposed 流转，裁决写 audit_event + proposal_event（proposal/accepted|rejected，entity_type=`first_classification`，entity_id=轮次行 id）。**confirmed 落正式事实的边界**：customer_type → `customer.type`（仅已关联 customer 时，经 setCustomerType 人工写入口径与审计）；stage → `customer_profile.stage` **仅当前 unknown/空才落**（不覆盖新消息阶段分类 A 档的更新结果，intent_tag_log source='first_classification_confirmed'）；intent_score 无正式字段登记，只留在本表 confirmed 行（不伪造落点）；画像字段 → account enrich 字段集（不覆盖 manual/locked 字段）。**删除规则**：软删 deleted 列；confirmed/rejected/failed 历史行保留（轮次复盘与采纳率分母）。
- **follow_up_task 反问卡触发枚举 `info_gap_ask`**（2026-09-10 本刀入宪，PRD 2.4 信息缺口反问卡配套）：行动卡新 trigger_type（稳定枚举，沿用 follow_up_task 载体不建新表）。**source_id 编码 = `assignment_id * 10 + gapIndex`**（gapIndex 1-6 = 客户类型/公司行业/需求型号/数量/预算/采购时间）——同一客户同一认领轮次同一缺口天然幂等，配合 `idx_ft_sla_once` partial unique（(trigger_type, source_id) WHERE status='pending'）双保险。**创建者 = crmFirstClassifyService**（首次分类完成后按六字段缺口检测出卡；卡片内容 = 建议销售下次聊天自然提问的静态话术模板，**不自动给客户发消息**；analysis 记缺口判定依据供「查看触发依据」）。**关闭者 = 字段确认钩子**（applyInfoField accept / setAccountFieldManual / setCustomerType / registerOpportunityDeal / 首次分类 confirm → `reevaluateInfoGapCards` 重评：已满足字段的 pending 卡置 done + analysis 记关闭依据 + audit_event action='info_gap_autoclose'）；done/rejected 历史保留，新认领轮次按新 source_id 重新出卡，不覆盖历史。
- **customer 设备档案 7 字段补列**（2026-09-10 本刀入宪，交付售后配套）：customer 表加列（幂等 ALTER，迁移铁律「只能加列」）。`model`（设备型号 TEXT）/ `purchase_date`（购置日期，epoch ms；与 `vehicle_age` 二选一，二者同时有则 `vehicle_age` 为真值）/ `modified_date`（改装日期 epoch ms）/ `battery_type`（电池类型 TEXT）/ `last_maintenance_date`（最近保养日期 epoch ms）/ `warranty_start_date`（质保起算日 epoch ms）/ `warranty_days`（质保期限天 INTEGER）/ `repeat_level`（复购等级 TEXT：首购/复购老客/高频复购·升A，服务端 recompute 单点写）。**写入者**：人工经 `crmDeliveryService.saveEquipment`（B 档，proposed→人工确认后写）；AI 提取只出提案（enrich 待确认链路），不直接落；日期列 0/NULL = 未登记合法态，**不得拿缺失日期猜周期**。**审计**：字段变化经 audit_event(action=`customer_equipment_set`)，detail 记新旧值；`repeat_level` 变化经 audit_event(action=`customer_repeat_level_change`)。
- **assignment 补列 `owner_employee_id`**（2026-09-17 本刀入宪，销售视图可见性修复配套）：assignment 表加列（幂等 ALTER，迁移铁律「只能加列」，**不改写任何存量归属**）。`owner_employee_id`（TEXT 可空）：**写入者两处**——① 中央下行 assign/transfer 落地时写入指令声明的中央归属员工 id（信封 `targetEmployeeId`，服务端按它路由到本设备）；② **本机写路径**（`crmAssignmentService.assignLeads` / `transferAssignment`，2026-09-17 补）按 `resolveLocalOwnerEmployeeId` 解析后写入：目标 = 本机绑定身份（署名或绑定期间别名）→ 用 `getBoundEmployeeId()` 的权威 id；否则查设置页 `centralSyncEmployeeAlias` 显式别名表（显示名→employeeCode）；**两者都不命中则写空串**——本机同步写路径拿不到中央目录（目录拉取是异步的），宁可降级到姓名回退分支也不猜，写错的 ID 会让「同名不同人」直接串线。`assignBatchLeads` 经 `assignLeads` 继承同一口径。审计 detail 带 `ownerEmployeeId`（null = 未解析，可事后区分「没解析」与「解析成空」）。**消费口径**：归属行带该列时，销售视角可见性/认领的「本人」判定以本机绑定 employeeId 为**权威**（显示名不参与判定——同名员工各持不同 employeeId 不串线；未绑定本机一律不可见）；行未带（历史行 / 未绑定时的本地行 / SMB 行 / 解析不出目标的本地行）保持既有姓名集合口径（署名 ∪ 绑定别名）。**迁移方向**：本地生产端补列后，姓名回退分支的适用面随存量行自然收窄——这是该分支最终退役的路径，但它**现在还不能删**（存量历史行永远只带姓名，宪法 §1.3）。`centralSync:hubLead:<sourceDeviceId>:<hubLeadId>` 的 hub→本地 id 映射落 scan_state（**带来源设备命名空间**，SMB 通道不写），仅作下行 recycle/remove 的兜底身份解析，不是归属事实源（归属 SSOT 仍 = assignment 最新有效行）。
- **opportunity 补列 `over_ship_reason`**（2026-09-10 本刀入宪，交付售后配套）：opportunity 表加列（幂等 ALTER）。超发（shipped_qty > order_qty）时必须填写的超发原因快照（≤200 字）。**写入者**：`crmDeliveryService.registerDelivery`（人工交付登记，同事务写 opportunity + audit_event）；`shipped_qty` 硬校验 = 非负整数、> order_qty 必须带 over_ship_reason。
- **follow_up_task 触发枚举 `diff_shipped_shortage` / `warranty_mod_near` / `warranty_mod_expired` / `trade_in_proposal`**（2026-09-10 本刀入宪，交付售后配套）：行动卡新 trigger_type（稳定枚举，沿用 follow_up_task 载体不建新表）。`diff_shipped_shortage` source_id=opportunity.id，**同一商机只保留一张 pending**（idx_ft_sla_once 双保险），实发量补齐时自动关闭（todoUpdate done + analysis.closedReason + audit_event action=`diff_task_autoclose`），差异再现按规则重新出卡不覆盖历史 done；`warranty_mod_near`（临期）与 `warranty_mod_expired`（已到期）source_id=customer.id，同一质保周期幂等（pending 去重 + 一次性出卡），无真实起算日（warranty_start_date 且 warranty_days 缺一）不出假提醒；`trade_in_proposal` source_id=customer.id，提案必须携带 evidence_key（真实设备日期或聊天证据）+ reason + 时间，confirm/reject 写 proposal_event + audit_event，**不自动改客户事实**。**创建者 = crmDeliveryService**；页面提醒一律读后端 follow_up_task 事实，禁止前端本地计算。
- **migration_dismissal**（2026-09-14 本刀入宪，存量迁移失败项人工闭环配套）：迁移报告失败/冲突项的「确认忽略」登记表，落 **crmDb**（ENTITIES 白名单已注册）。字段：`module`（迁移模块 key，如 `02-account-to-customer`）/ `entity_key`（失败项 key，如 `account:218`）/ `dismissed_by`（操作人）/ `dismissed_at`（epoch ms），`PRIMARY KEY (module, entity_key)`（幂等：重复忽略 upsert）。**语义边界**：忽略是操作态不是业务事实——只影响迁移报告的失败计数与展示，不触碰 account/customer 任何业务行；被忽略项仍留在原表，锚点补齐后自动归位。**写入者**：设置页「存量迁移报告」→ `crm:migration:failure:dismiss` / `:restore` IPC（crmIpcHandlers），忽略写 `migration_dismissal` + audit_event(action=`migration_failure_dismiss`)，恢复 = 删行 + audit_event(action=`migration_failure_restore`)。**消费**：① `crmMigrationService.migrate02AccountToCustomer`（启动扫描时被忽略项计入 `dismissed` 不进 failures）；② 设置页迁移报告（即时隐藏 + 「已确认忽略」分组可恢复）。

### 3.1 中央投影对象（Phase 3a 本刀入宪，PRD 7.1 / §3.1）

> 位置说明：这些对象**不落本机库**，落中央主机 PostgreSQL；登记于此是为了让「上行什么、以什么真源为准」
> 有唯一裁决处，防止本机与中央各写一套语义。代码真源 = `shared/centralSync.ts`（信封与实体枚举）+
> `central/src/projections.ts`（列级注册表）+ `central/migrations/002_central_projections.sql`（DDL）。

**总约束（三条硬门，越界即拒收）**

1. **显式列，禁止数据桶**：每个 `entityType` 对应一张明确表 + 明确列。中央侧**不存在**通用 JSONB
   业务桶；`payload` 只是传输形态，落库时按注册表拆到列上。缺注册项 = 拒收（`unregistered_entity_type`），
   不允许"先塞进去以后再说"。
2. **不新建第二套业务语义**：中央表只做本机既有对象的**只读副本 / 投影**，列语义必须能在 §1 找到对应
   对象。中央不是新的写入真源——本机仍是事实生产者，中央只承接 + 裁决下行。
3. **禁字段白名单前置**：`findForbiddenCentralField` 递归扫描，命中 `chat*` / `message*` / `conversation` /
   `session_id` / `wcdb_path` 即整条拒收并写中央审计。**聊天正文与原始聊天数据永不离开本机。**
   禁字段清单唯一真源在 `shared/centralSync.ts`，并导出字段名谓词（`isForbiddenChatFieldName` /
   `isForbiddenIdentityFieldName`）供**本机审计擦洗**复用——两端不各写一套。擦洗与拦截**只记字段路径与稳定错误码，
   不记被拦字段的值**。
4. **逐事件显式字段白名单（2026-09-15 增补）**：每个上行 `eventType` 只投递**声明过的最小字段集**，
   不得把 outbox 原始载荷整包出机；`bind_wx` 原始 wxid 不出机，只出身份类型 / 哈希 / 掩码 / 客户引用 / 来源，
   且哈希**复用既有身份归一规则**；`first_touch` 不出手机号 / 微信号 / `contactNormalized` / `contactRaw`；
   `claim` 从 canonical 分配行构造合法安全投影。**服务端对投影载荷走严格白名单：出现未声明字段即整条拒收**
   （`unknown_field:<名>`），**不静默裁剪**——宁可拒收，不留「先塞进去以后再说」的口子。

**10 张投影表**

| entityType | 中央表 | 承接的本机真源（§1 对应） | 上行边界 |
|---|---|---|---|
| `customer` | `central_customer` | §1.1 customer | 客户名/阶段/类型/归属销售；无聊天正文 |
| `customer_identity` | `central_customer_identity` | §1.2 customer_identity | **只上行 `identity_hash`（sha256）+ `identity_masked`**，手机号/微信号原文不出本机 |
| `assignment` | `central_assignment` | §1.3 assignment | 分配轮次与 SLA；本机 `assignment` 为唯一写入者 |
| `ownership` | `central_ownership` | §1.7 ownership（`account.owner_sales` 列语义） | 归属销售快照，不建中央归属真源 |
| `opportunity` | `central_opportunity` | §1.5 opportunity | 成交/商机字段；金额为本位币口径 |
| `quote` | `central_quote` | §1.6 quote（物理表 `quotation`） | 版本链快照：`opportunity_ref` + `version_no` + `doc_hash`（PDF 哈希），append-only 版本不覆盖 |
| `audit_event` | `central_audit_projection` | §1.12 audit_event | **只读上行投影**：本机审计的镜像，中央**不写**此表 |
| `customer_judgment` | `central_customer_judgment` | AI 判断双存档（PRD 7.1） | 判断类型/值/置信/模型 + `evidence_key`；**`evidence_text`（客户原话）不上行** |
| `knowledge_proposal` | `central_knowledge_proposal` | §2.7 知识提案 | 提案元数据与治理字段；不替代本机 kbReview 状态机 |
| `permission` | `central_permission` | 1.2a 本地身份档案 | 见下方「自报角色」裁决 |

**另有一张非投影表**：`central_audit_event` = 中央自身操作审计（邀请码签发、设备吊销、禁字段违规、
下行指令等），append-only。与 `central_audit_projection` **方向相反、互不写入**——本机审计上行、中央审计
自产，两者不合并成一张表（合并会让"谁写的"这条最关键的信息消失）。

**自报角色裁决（重复 §1.12 的边界并升级为跨机约束）**

`permission.declared_role` 来自本机身份档案（1.2a），**仅作署名与展示**，`authority_source='local_declaration'`。
中央侧权限一律由服务端 `employee.role` + 设备绑定决定（`central/src/permissions.ts` 表驱动）。
**本机自报角色永不升级为服务端权限依据**——这是 §1.12「身份与权限分离」在跨机形态下的同一条规则。

**下行边界（防止中央成为绕过状态机的万能写入者）**

- `assign` / `transfer` / `recycle`：映射为**本机既有 assignment 状态机**的输入，不直改 `account.owner_sales`。
- `supervisor_correction`：**不静默覆盖**——落 `notify_inbox`（`notify_type='supervisor_correction'`）
  由本机人工确认；确认前的本机事实行保持字节不变。
- `permission_change`：只记声明与审计，**不当作访问控制**（真权限在服务端）。
- 无法在本机执行的指令必须如实回 `invalid` 或 `retry`，连续 `retry` 达上限（5）后改判 `invalid`，
  **不得无限重试**。

**下行指令契约（2026-09-15 增补）**

- **唯一真源** = `shared/centralDownCommand.ts`：逐类型（`assign` / `transfer` / `recycle` /
  `supervisor_correction` / `permission_change` / `sla1_escalate_supervisor`）声明合法 `entityType`、
  必填载荷、`deliveryRole`、目标、枚举与长度上限、版本前置。**SMB 与 HTTP 两条传输共用同一份纯校验器**，
  本机 `applyDownEventDirect` 不得绕过校验。**SMB 入口已真正接入**（2026-09-15 收口）：
  `validateDownEventFile()` 在投递键 / eventSeq / deliveryRole / 文件名绑定等 SMB 专属检查通过后、
  进入任何业务事务前调用 `validateDownCommand(subject, 'smb')`；SMB 无中央 UUID 目标字段，
  「目标存在」由已验证的本机投递键（`localDeliveryKey`）证明，不伪造业务 UUID。
- **顶层字段的严格运行时契约（2026-09-15 增补）**：缺失、显式 `undefined`、空字符串与**形态**是两件事；
  显式 `null` 不默认视为省略，而按字段规则拒收。`DOWN_COMMAND_SPECS[eventType].fields` 与 eventType
  同处一个注册表，两条通道共用，**不各写一套**：
  - `payload.type`：必须是原始非空字符串，且严格等于信封 `eventType`；缺失/空值、非法形态、不一致分别返回
    `missing_field:type`、`invalid_type:type`、`payload_type_mismatch`。`deliveryRole` 也必须按原始类型校验；
    SMB 外层角色是来源，若 payload 同时带角色必须与外层严格一致，禁止 `String()` 洗白或覆盖。
  - `leadId` / `assignmentId` / `oldAssignmentId`：`positive_int`（≥ 1，原始 `number` 安全整数）；
  - `remindCount`：`non_negative_int` **0–3**（依据：`assignment.sla1_remind_count` 是「已提醒次数」，
    三次提醒制下生产者恒发 3、接收端按 `N/3` 渲染；越界会让主管看到假次数）；
  - `slaHours`：`positive_int` **1–72**（口径 = `crmLeadSlaHours` 可接受区间，缺省 24）；
  - `sla1Deadline` / `recycledAt`：`timestamp`（≥ 1 的安全正整数毫秒时间戳）；缺失统一 `missing_field:<字段>`，
    任何非法类型、越界或超出安全整数范围统一 `invalid_timestamp:<字段>`；不再与 `invalid_type:` /
    `invalid_integer:` 并列竞速；
  - 其余登记字段为**非空字符串字面量**（另有长度上限）。
  **`kind` 自带自然下界**（`positive_int` ≥ 1、`non_negative_int` ≥ 0），显式 `min` / `max` 只用于收窄——
  绝不因为没登记 `min` 就让 `0` / 负数溜过去。**禁止在校验之前 `Number()` / `String()`**（会把 `{}`→
  `[object Object]`、`"41"`、`true`、`[]` 洗白）。**顶层 `leadId` 与 `lead.leadId` 按原始值直接比较**，
  禁止 `Number()` 后再比（`Number("41") === Number(41)` 会让跨类型的自相矛盾载荷通过）。
  `required` 里的顶层标量字段若无 `fields` 规则、又不归 `lead` 子对象或 `spec.enums` 的专门校验器管，
  返回 `unregistered_field_rule:<字段>` —— **不给「只判非空就放行」留后门**。
- **可选字段的 `null` / 省略语义（2026-09-15 P2）**：缺失或 `undefined` 才表示省略；显式 `null`
  默认非法，不能由任一传输适配器静默改成缺省。`actor:null`、`reason:null` 分别返回
  `invalid_type:actor` / `invalid_type:reason`；`sla1Deadline:null` 返回
  `invalid_timestamp:sla1Deadline`；`mode:null` 返回 `invalid_enum:mode`。唯一历史兼容例外是
  `transfer.oldAssignmentId:null`，由该字段规则明确声明为未提供；不形成全局 `null` 旁路。
- **`supervisor_correction.detail` 结构（2026-09-15 P2）**：字段可省略或为 `undefined`；出现时必须是
  非 `null`、非数组的普通 JSON 对象，字符串 / 数字 / 布尔 / 数组统一返回 `invalid_type:detail`。
  对象仍接受递归下行禁字段扫描（例如 `detail.nested.messageBody` 拒收）。接收端仅对真正省略的 detail
  使用 `{}` 缺省；合法对象原样 JSON 存入 `notify_inbox.detail`，不得静默丢失。
- `eventType` 与 `entityType` 不匹配 → 服务端拒收；员工与设备双指定时必须**同属一名员工**；
  畸形目标标识返 **400**，不得落成数据库 500。畸形指令**不写**任何业务行（lead / assignment /
  `notify_inbox` / audit / 幂等标记），**不消耗幂等键**（修正后同 key 可重新受理）。
- **只有 `assign` / `transfer` 携带线索档案子对象**（`allowsLead`）；`recycle` 与通知/声明类指令
  不带 `lead`，携带即整事件拒收。回收的下行语义是「归属已回收」，接收端按 `assignmentId` 落既有状态机。
  （SMB 例外：Phase 1 历史信封在 `recycle` 上也附带 lead 资料与 `slaHours`，仅 `smb` 档放行。）
- **`lead` 建档契约（2026-09-15 增补）**：两条通道都强制最小身份——`leadId` 正整数 +
  `contactType ∈ {phone, wechat, both}` + `contactNormalized` 非空；缺了会以空 `contact_normalized`
  建档并可能撞 `UNIQUE(contact_type, contact_normalized)`。中央 HTTP 为**固定 6 字段全部存在**
  （`name` / `source` / `note` 允许空串但必须是字符串）；SMB 档兼容历史文件，其余字段存在即校验、
  不强制存在。**顶层 `leadId` 与 `lead.leadId` 必须一致**（`lead_id_mismatch` 拒收，禁止猜）。
- **`mode` 是四值枚举（2026-09-15 增补）**：唯一枚举源 = `shared/centralDownCommand.ts#ASSIGNMENT_MODES`
  （`manual` / `weight` / `round_robin` / `load`，口径 = `assignment.mode` 的真实写入语义），
  `assign` 与 `transfer` 共用。字段**出现时必须是枚举内的字符串字面量**——对象 / 数组 / 数字 / 布尔 /
  空串 / 未知字符串一律 `invalid_enum:mode`；**禁止先 `String(value)` 再比对**（`{}` 会被拍成
  `[object Object]` 从而「看起来合法」）。`transfer` 必须携带 `mode`（缺失 → `missing_field:mode`），
  `assign` 上可选且**应省略而不是发空串**。中央 HTTP 发送前自检、SMB 消费入口、中央服务端建指令三处同源。
- **`entityId` 必须是具体引用（2026-09-15 增补）**：`validateCentralEntityId` 经
  `shared/centralSync.ts#isConcreteRef`（**不新造第二个解析器**）要求「含设备命名空间 + 类别与
  `entityType` 相符 + 冒号后为非空白行号」——`device/customer:`、`device/customer:   ` 与裸 `customer:1`
  一并拒收（`entity_id_not_concrete` / `entity_id_not_scoped` / `entity_id_kind_mismatch`）。
  只到类别级别的引用无法跨表关联到任何一行。
- **升级前 pending 移交的兼容（2026-09-15 增补）**：`mode` / `sla1Deadline` 成为 transfer 必填之前写入的
  pending 行由发送侧惰性补齐（`electron/services/crmDownPayloadCompat.ts#healLegacyDownPayload`，
  两条通道共用一处，**不做全表 UPDATE**）：两字段从**本机 assignment 行**读回
  `assignment.mode` / `assignment.sla1_deadline`，即**移交事实产生时写死的绝对值**；
  **严禁按当前时间、当前 `crmLeadSlaHours` 或接收端配置重算**（重算即 SLA 漂移，正是本契约要禁止的事）。
  补齐**不动 `event_seq` / `idempotency_key` / `assignmentId` / `oldAssignmentId`**。
  不可恢复时**不猜不发**：该行显式置 `failed` + 脱敏审计（`detail` 只有 `{type, reason}`）。
- **`transfer` 是双目标指令**：新归属设备收 `apply`、原归属设备收 `remove`，两条指令各自带投递角色进幂等键，
  可分别判重；outbox 行只在**两个目标都被中央受理**后结算 `sent`，任一目标 4xx 整行 `failed` 并留
  人工修复审计（`sync_outbox_failed`：`failedRole` / `failedTarget` / `delivered`，不含客户数据），
  网络类失败保持 `pending` 交由重放（已受理目标按幂等去重，不产生第二条指令）。
- **`transfer` 的 SLA 纪律（2026-09-15 增补）**：`sla1Deadline`（有限正整数，字符串数字也拒收）与
  `mode` 是移交事实产生时确定的值，必填并随指令传递；接收端**精确按指令值落地**
  （`assignment.sla1_deadline` = `lead.first_contact_deadline` = 指令值），不按接收端配置/时钟重算；
  `remove` 分支不建行、不动 SLA；重放命中幂等标记零业务写、SLA 不漂移。
- **目标解析绝不按显示姓名猜人**：`sla1_escalate_supervisor` 按 `centralSyncSupervisorCode`（稳定工号）
  解析；姓名重名或解析不到一律显式报错并保持 pending。
- **⚠️ 已披露残留（不声称「下行零身份值」）**：`assign` / `transfer` 的 `lead` 子对象在中央 HTTP 通道
  固定为 6 个字段（`CENTRAL_LEAD_FIELDS`：`leadId` / `name` / `contactType` / `contactNormalized` /
  `source` / `note`）——接收端 Phase 1 状态机按 `(contact_type, contact_normalized)` 定位或创建线索，
  收窄该字段会破坏既有 P0/P1 语义。**`contactRaw` / `wechat` 不在中央通道内**（携带即 400），
  只有 SMB 内网文件通道保留 Phase 1 的 8 字段历史口径（已互信局域网，不在中央收口范围内）。
  **聊天正文两个方向都拦**；该线索档案面属已披露的有限例外。
- **载荷引用字段闸门（2026-09-15 增补）**：上行 `payload` 里登记过的 `*Ref` 字段在服务端按语义校验
  （类别匹配、必须是 `<deviceId>/<kind>:<id>` 完整形态、**不得借用他机命名空间**），
  错误码 `ref_invalid_type` / `ref_not_scoped` / `ref_not_concrete` / `ref_kind_mismatch` / `ref_not_owned`
  只带字段名不带值；`employeeRef` 是身份声明（显示名/工号），裸值放行。光拦 `entityId` 不够——
  `entityType=customer` 配 `payload.leadRef` 同样能把线索引用写进客户表。
- **中央自身操作审计（`central_audit_event`）**：`invite_create`（与签发同事务，不记邀请码明文/哈希）、
  `down_command`（指令首次受理，只记定位元数据不记载荷）、`sync_forbidden_field`、`device_revoke(_self)`、
  跨设备/身份锚点冲突。同幂等键重放不追加、被拒请求不留痕。

**版本与幂等（2026-09-15 增补复合水位与归属闸门）**

- 中央表主键 `(workspace_id, entity_id)`，仅当 `aggregate_version` 严格变大才覆盖（版本闸门）。
- **引用命名空间唯一规则**：`entityId` 及一切本机投影引用一律经 `scopedRef(deviceId, localRef)` 生成
  （`<deviceId>/<localRef>`），避免各机自增 id 相撞；中央侧另有 `isRefOwnedByDevice` 校验
  **上行 `entityId` 必须落在 `principal.deviceId` 命名空间内**。
- **投影归属闸门**：既有投影行**只允许原 `source_device_id` 更新**；跨设备改写一律显式冲突
  （**更高的 `aggregate_version` 也不能覆盖**）。`customer_identity` 唯一身份冲突落冲突记录，不静默覆盖。
- **增量水位**：可变表按 **(updated_at, id) 复合水位**推进，append-only 表仍用 id——
  只按 id 会漏掉「已同步行的后续更新」；同毫秒多行更新不得遗漏。
- **幂等键带版本**：同一实体新版本 → 幂等键不同（含本机修订号），`entityId` 保持稳定，
  `aggregateVersion` 严格递增。删除 / 状态 / 归属 / 金额 / 阶段变化均产生新版本；**不做全表周期重传**。
- **被过滤行不得卡游标**：投影读返回 `{drafts, watermark, scanned, skipped, full}` 与跳过原因；
  暂不可投影的行不阻塞后续合法行，补齐后经台账重新入扫；永久拒收与临时失败分离
  （前者可推水位并留审计，**后者水位不得前进**）。
- 上行幂等键 `(workspace_id, idempotency_key)`；下行按 `eventId` 去重；`ack` 对未知 `centralSeq` 静默跳过。
- 全部 SQL 参数化（`projections.ts` 只产出 `$n` 占位符）。

**当前边界（不夸大）**：以上为**代码实现 + 自动化验证**的范围。HTTPS/反向代理/证书、真实 PostgreSQL
端到端、真实多机演练、Windows 打包、SSE 与真实消息推送验收、冲突裁决细化（仍为「服务端版本闸门 +
跨设备改写拒绝 + 唯一身份冲突记录 + 客户端 `conflict` 回执」，多写者合并策略未定）、WeKnora（Phase 3b）
属**部署与后续阶段**，未验收前不得描述为已完成。**Phase 3a 代码侧仍未收口**——本轮只关闭了
2026-09-15 审计报告列出的八类阻断项（见 `docs/audit/中央同步-阻断项修复-审计报告-claude-20260915.md`）。

---

## 4. D3 实施范围与存量处置

### 4.1 D3 建表/改列清单
- **新建 6 表**（全走幂等双路径）：`customer` / `customer_identity` / `assignment` / `ownership_history` / `outbox_event` / `audit_event`。
- **幂等 ALTER 2 组**：① `account.customer_id`（可空）；② `opportunity` / `contract` 补列（§1.5 / §1.6 清单）。
- 新表注册进 `ENTITIES` 白名单（`crmDbService.ts:194`）——历史坑：`crm_risk`/`opportunity_event` 漏注册曾静默失败。

### 4.2 决策 B：群资源扫描整功能下线（2026-09-02 拍板）
> 背景：PRD 1.3 定分配员录入 + 三模式分配，群扫线索「进资源池、不直接落归属」；群扫描的「昵称=销售名」自动归属与新模型直接冲突，且已产生「秒变/静候」昵称误配前科。拍板：**整功能下线**，录入只走分配员 Excel/粘贴导入。

- **下线清单**：`crmLeadScanService.ts` / `crmLeadScanCore.ts` 停用删除；线索页「扫描群资源」按钮与模态移除；设置项 `crmLeadScanGroup` / `crmLeadScanWhitelist` 移除；`scan_state` 键 `leadScan:*` 游标清理（进 1.2 迁移报告）。
- **`lead.tag` 归属语义退役**：tag 仅保留 Excel 导入「需求标签」语义。
- **`leadReassignOwner` 整链路删除（2026-09-02 拍板，不改道）**：函数 + `crm:lead:reassign` IPC + preload/d.ts 桥接 + 线索页「⚙ 管理归属」弹窗一并移除。理由：批量修误配的场景随群扫描下线消失；批量 UPDATE 改归属会绕过 assignment 状态流转与留痕；新模型的归属调整统一走分配服务改派（assignment transferred/recycled + ownership_history + audit_event）。
- **存量处置**：已入库群扫线索（约 4,680 条，含历史 tag 归属）**tag 归属不迁 assignment**，统一回资源池由分配员按 1.3 重新分配（先 200 条小批量验证）；历史归属留在 `note`（现有「曾归属:X（日期）」格式）备查。
- **1.2 迁移清单同步**：现有线索（含群扫描）→ lead → customer_identity 查重归并（PRD §11 表），本条不变。

### 4.3 迁移既有列裁决汇总
| 既有物 | 裁决 |
|---|---|
| `account.customer_id`（新列） | 可空挂接，Phase 1 回填；account 本体 28 项能力照旧 |
| `customer_profile.customer_id`（既有列） | 语义 = 指向新 customer 表；Phase 1 回填对齐 |
| `lead.owner_id/pool_id/assigned_at/private_deadline` | 永久禁用死列，不删不启用 |
| `lead.tag` | 归属语义退役，仅需求标签 |
| `quotation.contract_id` | 过渡期双写只读兼容，权威方向为 `contract.quote_version_id` |
| `quotation.artifact_hash`（新列，2026-09-09） | DOCX 产物 SHA-256 存证；`pdf_hash` 仅真实 PDF 才写（§1.6 修订） |
| `quotation 历史版本` | append-only 只读（effective_to>0 一律拒绝 UPDATE），价格/行项变更必须新建版本（§1.6 修订 2026-09-09） |
| `activity_log` / `auto_confirm_log` | 封存只读；新审计一律 `audit_event` |

### 2026-09-12 开工简报与录入运行数据登记

- `contract.custom_fields.creation_request_id`：人工录入流程稳定标识，随合同长期保留；同账号按标识查库恢复，完成/取消只删除浏览器最小草稿。客户与合同起始创建在同一事务；报价、文档各自重试，非跨文件全局事务。客户抬头五项复用既有键，更新须合并，已有非空档案仅写用户勾选项。
- `quote_version_create.detail.price_overrides`：可选改价明细，产品/目录价/报价价由后端读取并按分比较，和版本同事务。没有改价不写此键。
- `report_snapshot(period_type=morning_digest).stats`：派生快照增加事项键、taskId、期限、分组及覆盖状态；现行完成状态从 follow_up_task 投影，不把历史快照当当前事实。仅当前微信账号。
- `userData/ai-usage/<account-hash>.json`：独立运行用量账本（非客户事实），原子写；记录调用 ID、目的、模型、提示词版本、时间、耗时、结束原因及 token 用量，缺失为 null。禁止保存密钥、完整 prompt、聊天正文；按请求开始时账号写入原账号账本，切号不重定向。**硬预算已启用（2026-09-12 本刀）**：请求发出前按当日调用次数判定上限（配置 `aiDailyCallLimitEnabled` / `aiDailyCallLimit`），达限则写一条 `status='blocked'` 行（tokens 记 null）并抛 `AiBudgetBlockedError`，阻断事件计入简报 coverage 缺口。**按次数而非按金额拦截**：官方刊例价静态表（`aiBudget.PRICE_TABLE`）对未收录模型返回 null，按金额拦截会把「算不出钱」误判为「没花钱」。
- **ai_scan_cursor（2026-09-12 本刀入宪）**：按需识别与早间简报的**持久化扫描游标**，落 **salesDb**（无需注册 ENTITIES 白名单，与 knowledge_usage 同库位同理由；按账号分库天然隔离，故无 account 列），`PRIMARY KEY(scope, session_id)`，字段 `scope` CHECK 语义（`digest`=早间简报批量扫描 / `manual`=单客户按需识别）/ `session_id` / `last_processed_at`（INTEGER 秒，**WCDB 时间戳是秒**）/ `updated_at`。**写入者唯一** = `salesDbService.cursorSet`（**单调**：`ts <= 当前值` 一律忽略，防乱序回退导致重扫或漏扫）；调用点仅 `salesFollowUpService.extractForSession`（**处理成功才推进**，抛错不推进——下次重扫，宁重不漏）。**消费** = `salesDbService.cursorGet` / `cursorMap`。**删除规则**：随账号库生命周期，无独立删除路径；不提供清空入口（真要重扫清库）。**语义边界**：游标只记「已处理到的消息时间」，不是「已无风险」的证据——简报覆盖状态仍由六态 coverage 独立表达。
- **follow_up_task.trigger_type 默认值中立化（2026-09-12 本刀入宪）**：DDL 默认由 `'ai_detected'` 改为 `'unknown'`，`todoCreate` 落库时 `trigger_type` 空值一律归一为 `'unknown'`。理由：默认值即事实声明，未经识别的待办不得被默认记成「AI 识别产出」。`'ai_detected'` 自此只由真实抽取路径显式写入（附 `created_by` = 当前销售姓名），`'manual'` / `'unknown'` / 其余枚举语义不变。
- **`ai_daily_limit_change` 审计动作（2026-09-13 本刀入宪，AI 简报 PRD §4.4 / §7.4-3 遗留项）**：`aiDailyCallLimit` 配置被修改时写一条 audit_event（action=`ai_daily_limit_change`，entity_type=`config`，entity_id=null，detail=`{ configKey, old_limit, new_limit, direction }`，actor=当前身份档案姓名，created_at=审计单点落 `Date.now()`）。**写点单点 = main.ts `config:set` IPC 拦截**（与 `assignment_weight_change` 同一拦截点、同一「尽力而为」口径：写库失败不阻塞配置保存；引导期 crmDb 未就绪静默跳过，判定用 `crmDbService.currentDbPath()`）。**判定与归一化收在纯函数** `electron/services/ai/aiDailyLimitAudit.ts`（口径与设置页读取侧一致：≥1、≤100000、取整，未设置按默认 60）。**提额与降额同记**（`direction` 区分）——上限是当天 AI 花费的硬门禁，放宽与收紧都是敏感操作；**值未变不留痕**（含 `'60'` 与 `60` 这类归一化后等价的写法）。**不覆盖**：开关 `aiDailyCallLimitEnabled` 的启用/停用不写审计（PRD 只要求上限变更留痕；如需一并留痕须另立口径）。屏 7 审计流水登记动作标签「AI 调用上限」，语义档 `warning`（与权重调整同档）。
- **抬头粘贴解析语义（2026-09-13 本刀入宪，合同与报价录入加速 PRD §7.2）**：`shared/buyerHeader.ts` 是**纯确定性规则**（不调 AI、不做模糊推断、不猜组合标签归属），产出直接决定落进 `contract.custom_fields` 的五项抬头值。**标签**整行精确匹配冻结别名表（样本分布文档 §4.1 评审冻结），`名称` 命中 `buyerName`、`产品名称` 不命中；**值内空白按字段区分**——`taxNo`/`account`/`phone` 去除全部空白（含 Tab、全角空格，内部分段不携带语义），`addr`/`bank` 保留内部空白（地址与行名中的空格有意义）；**组合标签**（`开户行及账号` 等）只登记 `comboHits` 并提示手工拆分，四个字段一律不写入；**失败判定与两种失败提示**由 `buyerHeaderOutcome` 给出（`unrecognized` 完全未识别 / `combo_only` 仅命中组合标签），调用方不得自行约定私有口径。**落库边界**：档案抬头五项全空时直接写入；档案已有非空值时只写用户逐项勾选的键（未勾选键保持原值，全部取消勾选 = 不更新），且差异确认在提交创建时弹出、不在粘贴瞬间弹出。
